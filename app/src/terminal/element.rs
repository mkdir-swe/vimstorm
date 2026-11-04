//! The terminal grid element: takes a snapshot of the visible rows under the `Term` lock (cells
//! with resolved colors, selection, cursor; the lock is held only for the copy). The UI thread
//! never waits for it: the PTY reader holds it through a whole read while output floods in, and
//! then the last snapshot is drawn again while a new one is taken off the UI thread, the view
//! drawn again once it is ([`Shared`]). Then it lays the
//! frame out like the editor's grid ([`crate::render`]): one background quad per run of
//! equal color, ASCII text shaped one line per run of cells (styles as text runs, `force_width` =
//! cell width so glyphs stay on the grid; GPUI caches shaped lines between frames), other chars
//! one by one at their cell, block / box chars as sprite shapes. Find matches, the selection and
//! the steady caret (block in the cell's foreground with the glyph in its background, hollow when
//! unfocused, 2 px bar / underline per DECSCUSR) go into the same pass. The grid is sized to the
//! element (padding inside) and the PTY resized when that changes. Paint registers the IME input
//! handler (Swedish dead keys compose into the shell).

use std::cell::{Cell as StdCell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line, Point as GridPoint};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::CursorShape;
use gpui_kit::{
    App, Bounds, ContentMask, Context, DispatchPhase, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, FocusHandle, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ShapedLine,
    SharedString, StrikethroughStyle, Style, TextAlign, TextRun, UnderlineStyle, Window, fill,
    outline, point, px, relative, rgb, size,
};

use super::TerminalView;
use super::colors;
use super::pty::Pty;
use super::text::Match;
use crate::render::CellMetrics;
use crate::render::{Shape, sprite};
use crate::render::{cell_font, editor_font};

/// Inside the island: WS's block insets top / bottom (`TerminalUi.blockTopInset` 6) and its empty
/// gutter on the left (≈ 8 px; the Lua terminal had one blank fold column).
pub const PAD_TOP: f32 = 6.;
pub const PAD_BOTTOM: f32 = 6.;
pub const PAD_LEFT: f32 = 8.;

/// Where the grid was laid out (window coordinates), for mouse hit tests.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GridLayout {
    pub bounds: Bounds<Pixels>,
    /// Top-left of viewport cell (0, 0), smooth-scroll offset included.
    pub origin: Point<Pixels>,
    pub cols: usize,
    pub rows: usize,
    pub metrics: CellMetrics,
}

impl GridLayout {
    /// Viewport cell (row, col) under a window position, clamped into the grid; and where in the
    /// cell it is horizontally (0..1; 1 past the last column).
    pub fn cell_at(&self, pos: Point<Pixels>) -> (usize, usize, f32) {
        let x = (pos.x - self.origin.x) / self.metrics.cell_width;
        let y = (pos.y - self.origin.y) / self.metrics.row_height;
        let col = x.floor().clamp(0., self.cols.saturating_sub(1) as f32) as usize;
        let row = y.floor().clamp(0., self.rows.saturating_sub(1) as f32) as usize;
        let frac = if x >= self.cols as f32 {
            1.
        } else if x < 0. {
            0.
        } else {
            x - x.floor()
        };
        (row, col, frac)
    }

    /// Top-left of viewport cell (row, col).
    pub fn cell_origin(&self, row: usize, col: usize) -> Point<Pixels> {
        point(
            self.origin.x + self.metrics.cell_width * col as f32,
            self.origin.y + self.metrics.row_height * row as f32,
        )
    }
}

/// Shared between the view and its element.
#[derive(Default)]
pub struct Shared {
    pub layout: StdCell<Option<GridLayout>>,
    /// Text color after WS's minimum contrast, per (fg, bg).
    contrast: RefCell<HashMap<(u32, u32), u32>>,
    /// Prepaint time of the last frame (perf: render cost).
    pub last_build: StdCell<Option<std::time::Duration>>,
    /// The last frame's snapshot, drawn again while the Term is busy.
    last: RefCell<Option<(SnapKey, Snap)>>,
    /// One taken off the UI thread since, and whether one is being taken.
    taken: RefCell<Option<(SnapKey, Snap)>>,
    taking: StdCell<bool>,
}

impl Shared {
    /// A snapshot taken off the UI thread since the last frame.
    fn fresh(&self, key: SnapKey) -> Option<Snap> {
        let taken = self.taken.borrow_mut().take();
        taken.filter(|(k, _)| *k == key).map(|(_, s)| s)
    }

    /// The last frame's snapshot, to draw again while the Term is busy.
    fn last(&self, key: SnapKey) -> Option<Snap> {
        let last = self.last.borrow();
        last.as_ref()
            .filter(|(k, _)| *k == key)
            .map(|(_, s)| s.clone())
    }

    fn kept(&self, key: SnapKey, snap: &Snap) {
        *self.last.borrow_mut() = Some((key, snap.clone()));
    }

    /// A snapshot taken off the UI thread (waiting its turn at the Term), the view `view` drawn
    /// again with it; one at a time.
    fn take_later(
        self: &Rc<Self>,
        pty: &Arc<Pty>,
        key: SnapKey,
        view: gpui_kit::EntityId,
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.taking.replace(true) {
            return;
        }
        let term = pty.term.clone();
        let taking =
            gpui_kit::AppContext::background_spawn(cx, async move { snapshot(&term.lock(), key) });
        let shared = self.clone();
        window
            .spawn(cx, async move |cx| {
                let snap = taking.await;
                shared.taking.set(false);
                *shared.taken.borrow_mut() = Some((key, snap));
                let _ = cx.update(|_, cx| cx.notify(view));
            })
            .detach();
    }

    fn readable(&self, fg: u32, bg: u32) -> u32 {
        if fg == bg {
            return fg;
        }
        let mut cache = self.contrast.borrow_mut();
        if cache.len() > 4096 {
            cache.clear();
        }
        *cache
            .entry((fg, bg))
            .or_insert_with(|| colors::ensure_contrast(fg, bg))
    }
}

/// The view a grid belongs to: it takes the grid's IME text, and the window's mouse moves and
/// releases while the grid is drawn (a drag that leaves the grid goes on).
pub trait TermHost: EntityInputHandler + 'static {
    fn host_mouse_move(
        &mut self,
        ev: &MouseMoveEvent,
        inside: bool,
        float: bool,
        cx: &mut Context<Self>,
    );
    fn host_mouse_up(&mut self, ev: &MouseUpEvent, float: bool, cx: &mut Context<Self>);
}

impl TermHost for TerminalView {
    fn host_mouse_move(
        &mut self,
        ev: &MouseMoveEvent,
        inside: bool,
        float: bool,
        cx: &mut Context<Self>,
    ) {
        if float {
            self.float_mouse_move(ev, inside, cx)
        } else {
            self.grid_mouse_move(ev, inside, cx)
        }
    }

    fn host_mouse_up(&mut self, ev: &MouseUpEvent, float: bool, cx: &mut Context<Self>) {
        if float {
            self.float_mouse_up(ev, cx)
        } else {
            self.grid_mouse_up(ev, cx)
        }
    }
}

pub struct TermElement<V: TermHost = TerminalView> {
    pub pty: Arc<Pty>,
    /// The view it is drawn for (its IME input, mouse); none for a terminal drawn where its view
    /// takes its keys itself (Abe Settings' terminal below).
    pub view: Option<Entity<V>>,
    /// The handle the IME input goes through (the view's while it has the keyboard).
    pub input_focus: FocusHandle,
    pub focused: bool,
    pub metrics: CellMetrics,
    /// Smooth scrolling: rows drawn this many px lower, the row above shown in the gap.
    pub scroll_px: f32,
    pub matches: Rc<Vec<Match>>,
    /// Index of the current find match.
    pub current: Option<usize>,
    pub preedit: Option<String>,
    pub shared: Rc<Shared>,
    /// The lazygit float's grid (its own mouse handling).
    pub float: bool,
}

impl<V: TermHost> IntoElement for TermElement<V> {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

/// One cell of the snapshot.
#[derive(Clone)]
struct SnapCell {
    text: Option<SharedString>,
    c: char,
    fg: u32,
    bg: u32,
    flags: Flags,
}

/// What a snapshot is taken for: the grid's columns, and a row above while smooth-scrolled.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SnapKey {
    cols: usize,
    smooth: bool,
}

/// The rows a frame shows, copied under the Term lock (colors as the Term says them), the first
/// one's line (-1: the row above, smooth-scrolled), the caret, the default background and the
/// display offset.
#[derive(Clone)]
struct Snap {
    rows: Vec<Vec<SnapCell>>,
    first: i32,
    cursor: Option<(usize, usize, CursorShape)>,
    default_bg: u32,
    offset: i32,
}

/// The snapshot `key` asks of `term` (on any thread: the lock is the caller's).
fn snapshot(term: &Term<super::pty::Listener>, key: SnapKey) -> Snap {
    let colors = term.colors();
    let default_bg = colors::background(colors);
    let offset = term.grid().display_offset() as i32;
    let history = term.history_size() as i32;
    let tcols = term.columns().min(key.cols);
    let trows = term.screen_lines() as i32;
    // the row above the view while smooth-scrolled
    let first: i32 = if key.smooth && offset < history {
        -1
    } else {
        0
    };
    let selection = term.selection.as_ref().and_then(|s| s.to_range(term));
    let selection_bg = colors::palette().selection_bg;
    let mut rows: Vec<Vec<SnapCell>> = Vec::with_capacity((trows - first) as usize);
    for vr in first..trows {
        let line = Line(vr - offset);
        let row = &term.grid()[line];
        let mut cells = Vec::with_capacity(tcols);
        for c in 0..tcols {
            let cell = &row[Column(c)];
            let (fg, mut bg) = colors::cell_colors(colors, cell.fg, cell.bg, cell.flags);
            if selection
                .as_ref()
                .is_some_and(|s| s.contains(GridPoint::new(line, Column(c))))
            {
                bg = selection_bg;
            }
            let text = cell.zerowidth().filter(|z| !z.is_empty()).map(|z| {
                let mut s = String::new();
                s.push(cell.c);
                s.extend(z.iter());
                SharedString::from(s)
            });
            cells.push(SnapCell {
                text,
                c: cell.c,
                fg,
                bg,
                flags: cell.flags,
            });
        }
        rows.push(cells);
    }
    let rc = term.renderable_content();
    let cur = rc.cursor;
    let vrow = cur.point.line.0 + offset;
    let cursor = (vrow >= 0 && vrow < trows && cur.shape != CursorShape::Hidden).then_some((
        vrow as usize,
        cur.point.column.0,
        cur.shape,
    ));
    Snap {
        rows,
        first,
        cursor,
        default_bg,
        offset,
    }
}

enum Op {
    Quad(PaintQuad),
    Text(Box<ShapedLine>, Point<Pixels>),
    Sprite(Vec<Shape>, Bounds<Pixels>, Hsla),
}

pub struct Prepainted {
    ops: Vec<Op>,
    clip: Bounds<Pixels>,
}

fn color(c: u32) -> Hsla {
    rgb(c).into()
}

fn run(len: usize, fg: u32, flags: Flags, ch: char) -> TextRun {
    let bold = flags.contains(Flags::BOLD);
    let italic = flags.contains(Flags::ITALIC);
    let underline = if flags.intersects(Flags::ALL_UNDERLINES) {
        Some(UnderlineStyle {
            thickness: px(1.),
            color: Some(color(fg)),
            wavy: flags.contains(Flags::UNDERCURL),
        })
    } else {
        None
    };
    TextRun {
        len,
        font: if ch.is_ascii() {
            editor_font(bold, italic)
        } else {
            cell_font(ch, bold, italic)
        },
        color: color(fg),
        background_color: None,
        underline,
        strikethrough: flags
            .contains(Flags::STRIKEOUT)
            .then(|| StrikethroughStyle {
                thickness: px(1.),
                color: Some(color(fg)),
            }),
    }
}

/// Smaller than this the view isn't really laid out yet: the shell keeps its size.
const MIN_COLS: usize = 8;
const MIN_ROWS: usize = 2;

impl<V: TermHost> Element for TermElement<V> {
    type RequestLayoutState = ();
    type PrepaintState = Prepainted;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepainted {
        let started = Instant::now();
        let m = self.metrics;
        let inner_w = (bounds.size.width - px(PAD_LEFT)).max(px(0.));
        let inner_h = (bounds.size.height - px(PAD_TOP + PAD_BOTTOM)).max(px(0.));
        let fit_cols = (inner_w / m.cell_width).floor() as usize;
        let fit_rows = (inner_h / m.row_height).floor() as usize;
        // a frame laid out before the host's island is known (the view just mounted again:
        // shown, Git swapped out, maximize / restore, a project shown) never shrinks the shell:
        // a reflow to 2 x 1 lost the output and scrollback (the shell redraws over it)
        let (cols, rows) = if fit_cols < MIN_COLS || fit_rows < MIN_ROWS {
            let (c, r) = self.pty.size();
            (c as usize, r as usize)
        } else {
            self.pty.resize(
                fit_cols as u16,
                fit_rows as u16,
                m.cell_width.as_f32().round() as u16,
                m.row_height.as_f32().round() as u16,
            );
            (fit_cols, fit_rows)
        };
        let origin = point(
            bounds.origin.x + px(PAD_LEFT),
            bounds.origin.y + px(PAD_TOP + self.scroll_px),
        );
        let layout = GridLayout {
            bounds,
            origin,
            cols,
            rows,
            metrics: m,
        };
        self.shared.layout.set(Some(layout));

        // the snapshot: never waiting on the shell's output being parsed (the reader holds the
        // Term through a whole read); while it does, the last one is drawn again and a new one
        // is taken off the UI thread, the view drawn again once it is
        let key = SnapKey {
            cols,
            smooth: self.scroll_px > 0.,
        };
        let snap = match (self.shared.fresh(key), self.pty.term.try_lock_unfair()) {
            (Some(snap), _) => snap,
            (None, Some(term)) => snapshot(&term, key),
            (None, None) => match self.shared.last(key) {
                Some(snap) => {
                    self.shared
                        .take_later(&self.pty, key, window.current_view(), window, cx);
                    snap
                }
                None => snapshot(&self.pty.term.lock(), key),
            },
        };
        self.shared.kept(key, &snap);
        let Snap {
            mut rows,
            first: first_row,
            cursor,
            default_bg,
            offset: display_offset,
        } = snap;
        // the minimum contrast: the UI's (its cache)
        for cell in rows.iter_mut().flatten() {
            if !cell.flags.contains(Flags::HIDDEN) {
                cell.fg = self.shared.readable(cell.fg, cell.bg);
            }
        }
        let snap = rows;

        // find matches on screen: their cells' colors
        let mut snap = snap;
        for (i, mtc) in self.matches.iter().enumerate() {
            let vr = mtc.line + display_offset - first_row;
            if vr < 0 || vr as usize >= snap.len() {
                continue;
            }
            let (fg, bg) = if Some(i) == self.current {
                (colors::MATCH_CURRENT_FG, colors::palette().match_current_bg)
            } else {
                (colors::MATCH_FG, colors::palette().match_bg)
            };
            let row = &mut snap[vr as usize];
            for c in mtc.col..(mtc.col + mtc.cols).min(row.len()) {
                row[c].fg = fg;
                row[c].bg = bg;
            }
        }
        // the block caret: the cell in its foreground, the glyph in its background (WS)
        let mut caret_quads = Vec::new();
        if self.preedit.is_none()
            && let Some((r, c, shape)) = cursor
            && let Some(cell) = snap
                .get_mut((r as i32 - first_row) as usize)
                .and_then(|row| row.get_mut(c))
        {
            let wide = cell.flags.contains(Flags::WIDE_CHAR);
            let cb = Bounds::new(
                point(
                    origin.x + m.cell_width * c as f32,
                    origin.y + m.row_height * r as f32,
                ),
                size(m.cell_width * if wide { 2. } else { 1. }, m.row_height),
            );
            let caret = if cell.fg == cell.bg {
                colors::palette().foreground
            } else {
                cell.fg
            };
            match shape {
                CursorShape::Block if self.focused => {
                    let fg = cell.bg;
                    cell.bg = caret;
                    cell.fg = fg;
                }
                CursorShape::Block | CursorShape::HollowBlock => {
                    caret_quads.push(outline(cb, color(caret), gpui_kit::BorderStyle::Solid))
                }
                CursorShape::Beam => caret_quads.push(fill(
                    Bounds::new(cb.origin, size(px(2.), cb.size.height)),
                    color(caret),
                )),
                CursorShape::Underline => caret_quads.push(fill(
                    Bounds::new(
                        point(cb.origin.x, cb.origin.y + cb.size.height - px(2.)),
                        size(cb.size.width, px(2.)),
                    ),
                    color(caret),
                )),
                CursorShape::Hidden => {}
            }
        }

        let mut ops = Vec::new();
        ops.push(Op::Quad(fill(bounds, color(default_bg))));
        let ts = window.text_system().clone();
        for (i, row) in snap.iter().enumerate() {
            let vr = i as i32 + first_row;
            let y = origin.y + m.row_height * vr as f32;
            // backgrounds in runs
            let mut c = 0;
            while c < row.len() {
                let bg = row[c].bg;
                let mut e = c + 1;
                while e < row.len() && row[e].bg == bg {
                    e += 1;
                }
                if bg != default_bg {
                    ops.push(Op::Quad(fill(
                        Bounds::new(
                            point(origin.x + m.cell_width * c as f32, y),
                            size(m.cell_width * (e - c) as f32, m.row_height),
                        ),
                        color(bg),
                    )));
                }
                c = e;
            }
            // text
            let mut c = 0;
            while c < row.len() {
                let cell = &row[c];
                if cell.flags.contains(Flags::WIDE_CHAR_SPACER)
                    || cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    c += 1;
                    continue;
                }
                let simple = cell.text.is_none() && cell.c.is_ascii();
                if simple {
                    let start = c;
                    let mut text = String::new();
                    let mut runs: Vec<TextRun> = Vec::new();
                    let mut visible = false;
                    let mut last: Option<(u32, Flags)> = None;
                    while c < row.len() && row[c].text.is_none() && row[c].c.is_ascii() {
                        let cl = &row[c];
                        let ch = if cl.c == '\t' || cl.c < ' ' {
                            ' '
                        } else {
                            cl.c
                        };
                        text.push(ch);
                        if ch != ' '
                            || cl
                                .flags
                                .intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
                        {
                            visible = true;
                        }
                        let style_flags = cl.flags
                            & (Flags::BOLD
                                | Flags::ITALIC
                                | Flags::ALL_UNDERLINES
                                | Flags::STRIKEOUT);
                        if last == Some((cl.fg, style_flags))
                            && let Some(r) = runs.last_mut()
                        {
                            r.len += 1;
                        } else {
                            runs.push(run(1, cl.fg, style_flags, 'a'));
                            last = Some((cl.fg, style_flags));
                        }
                        c += 1;
                    }
                    if visible {
                        let line =
                            ts.shape_line(text.into(), m.font_size, &runs, Some(m.cell_width));
                        ops.push(Op::Text(
                            Box::new(line),
                            point(origin.x + m.cell_width * start as f32, y),
                        ));
                    }
                    continue;
                }
                let wide = cell.flags.contains(Flags::WIDE_CHAR);
                let cb = Bounds::new(
                    point(origin.x + m.cell_width * c as f32, y),
                    size(m.cell_width * if wide { 2. } else { 1. }, m.row_height),
                );
                if cell.text.is_none()
                    && let Some(shapes) = sprite(cell.c)
                {
                    ops.push(Op::Sprite(shapes, cb, color(cell.fg)));
                } else {
                    let t: SharedString = cell
                        .text
                        .clone()
                        .unwrap_or_else(|| SharedString::from(cell.c.to_string()));
                    let r = run(t.len(), cell.fg, cell.flags, cell.c);
                    let line = ts.shape_line(t, m.font_size, &[r], None);
                    ops.push(Op::Text(Box::new(line), cb.origin));
                }
                c += 1;
            }
        }
        ops.extend(caret_quads.into_iter().map(Op::Quad));
        // IME marked text at the caret: underlined, with a bar after it
        if let (Some(text), Some((r, c, _))) = (self.preedit.as_ref(), cursor) {
            let at = point(
                origin.x + m.cell_width * c as f32,
                origin.y + m.row_height * r as f32,
            );
            let r = TextRun {
                len: text.len(),
                font: editor_font(false, false),
                color: color(colors::palette().foreground),
                background_color: None,
                underline: Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(color(colors::palette().foreground)),
                    wavy: false,
                }),
                strikethrough: None,
            };
            let line = ts.shape_line(SharedString::from(text.clone()), m.font_size, &[r], None);
            let w = m.cell_width * (line.width / m.cell_width).round().max(1.);
            ops.push(Op::Quad(fill(
                Bounds::new(at, size(w, m.row_height)),
                color(default_bg),
            )));
            ops.push(Op::Text(Box::new(line), at));
            ops.push(Op::Quad(fill(
                Bounds::new(point(at.x + w, at.y), size(px(2.), m.row_height)),
                color(colors::palette().foreground),
            )));
        }
        self.shared.last_build.set(Some(started.elapsed()));
        Prepainted { ops, clip: bounds }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        prepaint: &mut Prepainted,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(view) = self.view.clone() {
            window.handle_input(
                &self.input_focus,
                ElementInputHandler::new(bounds, view.clone()),
                cx,
            );
            // moves and releases anywhere in the window: a drag that leaves the grid goes on
            // (selection auto-scroll, TUI drag reports), a release outside still reaches the TUI
            let float = self.float;
            let moved = view.clone();
            window.on_mouse_event(move |ev: &MouseMoveEvent, phase, _, cx| {
                if phase == DispatchPhase::Bubble {
                    let inside = bounds.contains(&ev.position);
                    moved.update(cx, |v, cx| v.host_mouse_move(ev, inside, float, cx));
                }
            });
            window.on_mouse_event(move |ev: &MouseUpEvent, phase, _, cx| {
                if phase == DispatchPhase::Bubble {
                    view.update(cx, |v, cx| v.host_mouse_up(ev, float, cx));
                }
            });
        }
        let row_height = self.metrics.row_height;
        let ops = std::mem::take(&mut prepaint.ops);
        window.with_content_mask(
            Some(ContentMask {
                bounds: prepaint.clip,
            }),
            |window| {
                for op in ops {
                    match op {
                        Op::Quad(q) => window.paint_quad(q),
                        Op::Text(line, at) => {
                            let _ = line.paint(at, row_height, TextAlign::Left, None, window, cx);
                        }
                        Op::Sprite(shapes, cell, fg) => {
                            crate::render::paint_sprite(&shapes, cell, fg, window, cx)
                        }
                    }
                }
            },
        );
    }
}
