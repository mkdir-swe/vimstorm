//! Annotate (blame) and the editor's git change gutter in the WebStorm look: Lua keeps
//! reserving the statuscolumn cells; this layer paints over them.
//!
//! - Annotate (`,å`, `git/blame.lua`): Lua sends `load {buf, path, text?}` (the unsaved text when
//!   the buffer is modified: `git blame --contents -`) on open / edits / save / repo changes,
//!   `close {buf}`. Rust blames off the UI thread, lays the texts out in Inter (WS
//!   `EditorGutterComponentImpl.paintAnnotations`: 8 px filler, date + author columns each with a
//!   5 px gap, WS ORDER-mode backgrounds, the latest revision's text brighter), and answers
//!   `config.app.annotate.loaded(buf, cells, hashes, line_commits)`: Lua reserves that many blank
//!   cells (`WsAnnotate<buf>` hl) in front of the line number and keeps the line -> commit table
//!   for Enter / menus. Hover: the hand cursor + the commit tooltip (WS paints no hover
//!   background); click: the commit in the Git log; right-click: Lua's annotate menu.
//! - Change gutter: gitsigns keeps computing the hunks (its sign text is blank in the app); the
//!   sign cells' hl groups say added / modified / deleted, painted as WS's thin rounded bars and
//!   deleted-lines markers (`LineStatusMarkerDrawUtil`, new UI). Clicks go through to nvim (Lua's
//!   change popup), the marker widens on hover like WS's.
//!
//! Which buffer line a row shows comes from the grid itself ([`rows`]: `%l` cells, blank on wrapped
//! continuation rows, folds show their first line), read in the canvas's prepaint from
//! [`crate::shell::SurfaceCx::drawn`] (origin, smooth-scroll offset, kept rows), so the
//! painted gutter never drifts from the text.

mod model;
mod rows;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{
    App, Bounds, Context, CursorStyle, DispatchPhase, FocusHandle, Focusable, Hitbox,
    HitboxBehavior, Hsla, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement as _, Pixels, Point, Render, ScrollWheelEvent, ShapedLine, SharedString,
    Styled as _, Task, TextAlign, TextRun, WeakEntity, Window, anchored, canvas, deferred, div,
    fill, point, px, size,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::EditorView;
use crate::git::cli::{self, Cancel};
use crate::git::job::{self, Latest};
use crate::git::show::DetailsCache;
use crate::git::{blame, dates};
use crate::look;
use crate::nvim::GridId;
use crate::nvim::lua;
use crate::render::GridHost as _;
use crate::shell::WinKind;
use crate::shell::{DrawnGrid, Surface, SurfaceCx};

pub use model::Annotation;
pub(crate) use rows::is_number;
use rows::{ChangeKind, LineRows};

/// Mouse rest before the commit tooltip (Lua's tooltip delay, `config/gutter.lua`).
const TOOLTIP_DELAY: Duration = Duration::from_millis(500);
/// WS `FillerColumn` (new UI): 8 px of background before the first text column.
const FILLER: f32 = 8.0;
/// Slack between the annotations' background and the line numbers (WS: a gap between areas).
const NUMBER_GAP: f32 = 4.0;
/// The bar's left edge in the first sign cell (WS: 1 px for brace highlighters + 2 px).
const BAR_X: f32 = look::GUTTER_BAR_X;
/// WS `getTriangleHeight` new UI (the deleted marker is 2 * 5 - 2 px tall around the boundary).
const DELETED_HALF: f32 = 5.0;
/// Below the pointer, like WS's IdeTooltip.
const TIP_GAP: f32 = 16.0;
/// Long commit messages wrap.
const TIP_MAX_WIDTH: f32 = 600.0;

/// Lua -> Rust (`config.app.annotate` / `git/blame.lua`).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event {
    Load {
        buf: i64,
        path: String,
        #[serde(default)]
        text: Option<String>,
    },
    Close {
        buf: i64,
    },
}

/// A loaded annotation and its layout.
struct Loaded {
    model: Annotation,
    layout: Layout,
}

/// The annotation column in px (from its left edge) and its shaped texts.
struct Layout {
    author_x: Pixels,
    /// The widest author text.
    author_w: Pixels,
    width: Pixels,
    /// Cells Lua reserves.
    cells: usize,
    /// Per commit: (date, author), None for uncommitted lines.
    texts: Vec<Option<(ShapedLine, ShapedLine)>>,
}

impl Layout {
    fn new(m: &Annotation, cell_width: Pixels, window: &Window) -> Layout {
        let shape = |text: &str, color: Hsla| {
            let run = TextRun {
                len: text.len(),
                font: crate::render::ui_font(),
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            window.text_system().shape_line(
                SharedString::from(text.to_owned()),
                px(look::ANNOTATION_FONT_SIZE),
                &[run],
                None,
            )
        };
        let texts: Vec<_> = m
            .texts
            .iter()
            .enumerate()
            .map(|(i, (date, author))| {
                if m.blame.commits[i].uncommitted {
                    return None;
                }
                let color: Hsla = if m.last == Some(i) {
                    look::ANNOTATION_LAST_COMMIT_FG.into()
                } else {
                    look::ANNOTATION_FG.into()
                };
                Some((shape(date, color), shape(author, color)))
            })
            .collect();
        let max = |f: fn(&(ShapedLine, ShapedLine)) -> Pixels| {
            texts.iter().flatten().map(f).fold(px(0.), Pixels::max)
        };
        let (date_w, author_w) = (max(|t| t.0.width), max(|t| t.1.width));
        let gap = px(look::ANNOTATION_COLUMN_GAP);
        let author_x = px(FILLER) + date_w + gap;
        // WS AnnotateToggleAction adds an ExtraFieldGutter after the author: " " + its gap, in
        // the row's background
        // (a lone space shapes as a fallback glyph's width: measure it between letters)
        let fg: Hsla = look::ANNOTATION_FG.into();
        let space = shape("x x", fg).width - shape("xx", fg).width;
        let extra = space + gap;
        let width = if texts.iter().flatten().next().is_some() {
            author_x + author_w + gap + extra
        } else {
            px(FILLER)
        };
        let cells = ((width + px(NUMBER_GAP)) / cell_width).ceil() as usize;
        Layout {
            author_x,
            author_w,
            width,
            cells,
            texts,
        }
    }
}

#[derive(Default)]
struct Loading {
    latest: Latest,
    cancel: Option<Cancel>,
    task: Option<Task<()>>,
}

/// The annotation line under the mouse.
#[derive(Clone, Debug, PartialEq)]
struct Hover {
    buf: i64,
    lnum: u32,
    commit: Option<usize>,
}

/// The commit tooltip on screen.
struct Tip {
    text: SharedString,
    at: Point<Pixels>,
    hash: String,
}

/// One annotated line as painted (window coordinates).
#[derive(Clone, Debug)]
struct AnnLine {
    buf: i64,
    lnum: u32,
    commit: Option<usize>,
    /// All its rows, the column's width.
    bounds: Bounds<Pixels>,
    /// Top of the row its text goes on (None: no text, e.g. its first row is off screen).
    text_y: Option<Pixels>,
    /// What's painted: background, (date, author, author x).
    bg: Option<Hsla>,
    texts: Option<(ShapedLine, ShapedLine, Pixels)>,
}

/// A change marker as painted.
#[derive(Clone, Debug)]
struct Marker {
    color: Hsla,
    /// The bar / deleted marker, not hovered.
    bounds: Bounds<Pixels>,
    /// Where the mouse hovers it (the sign cells, deleted markers + a third of a row).
    hit: Bounds<Pixels>,
    key: (GridId, i64),
    hovered: bool,
    /// The window and the line whose hunk a click shows (a deleted marker: the line above the
    /// boundary, line 1 for lines deleted above it).
    win: i64,
    lnum: u32,
}

/// What one window grid shows of annotate / changes this frame.
#[derive(Clone, Debug, Default)]
struct WinFrame {
    clip: Bounds<Pixels>,
    row_height: Pixels,
    lines: Vec<AnnLine>,
    markers: Vec<Marker>,
}

#[derive(Clone, Debug, Default)]
struct Frame {
    wins: Vec<WinFrame>,
    /// nvim flushes applied when it was built (tests compare it with the grid of the same flush).
    flushes: u64,
}

impl Frame {
    fn line_at(&self, pos: Point<Pixels>) -> Option<&AnnLine> {
        self.wins
            .iter()
            .filter(|w| w.clip.contains(&pos))
            .flat_map(|w| &w.lines)
            .find(|l| l.bounds.contains(&pos))
    }

    fn marker_at(&self, pos: Point<Pixels>) -> Option<&Marker> {
        self.wins
            .iter()
            .filter(|w| w.clip.contains(&pos))
            .flat_map(|w| &w.markers)
            .find(|m| m.hit.contains(&pos))
    }
}

pub struct AnnotateView {
    scx: SurfaceCx,
    focus: FocusHandle,
    anns: HashMap<i64, Loaded>,
    loading: HashMap<i64, Loading>,
    /// The last painted frame (mouse hit tests).
    frame: Rc<RefCell<Frame>>,
    hover: Option<Hover>,
    marker_hover: Option<(GridId, i64)>,
    tip: Option<Tip>,
    tip_task: Option<Task<()>>,
    details: DetailsCache,
}

impl AnnotateView {
    pub fn scx(&self) -> &SurfaceCx {
        &self.scx
    }

    /// Buffers with a loaded annotation (tests).
    pub fn annotated(&self) -> Vec<i64> {
        self.anns.keys().copied().collect()
    }

    /// A buffer line's text as drawn ("2025-01-10 Sample"), "" for uncommitted lines (tests).
    pub fn line_text(&self, buf: i64, lnum: u32) -> Option<String> {
        let a = &self.anns.get(&buf)?.model;
        let (date, author) = &a.texts[a.commit_of(lnum)?];
        Some(if date.is_empty() {
            String::new()
        } else {
            format!("{date} {author}")
        })
    }

    /// A buffer line's annotation background (tests).
    pub fn line_color(&self, buf: i64, lnum: u32) -> Option<u32> {
        let a = &self.anns.get(&buf)?.model;
        a.colors[a.commit_of(lnum)?]
    }

    /// Cells Lua reserves for a buffer's annotations (tests).
    pub fn cells(&self, buf: i64) -> Option<usize> {
        Some(self.anns.get(&buf)?.layout.cells)
    }

    /// The column's (author x, widest author, width) in px from its left edge (tests).
    pub fn column(&self, buf: i64) -> Option<(Pixels, Pixels, Pixels)> {
        let l = &self.anns.get(&buf)?.layout;
        Some((l.author_x, l.author_w, l.width))
    }

    /// Backgrounds painted in the last frame per line: (lnum, bg) (tests).
    pub fn painted_backgrounds(&self) -> Vec<(u32, Option<Hsla>)> {
        let f = self.frame.borrow();
        f.wins
            .iter()
            .flat_map(|w| &w.lines)
            .map(|l| (l.lnum, l.bg))
            .collect()
    }

    /// Lines of the last frame: (buf, lnum, bounds, text drawn) (tests).
    pub fn painted_lines(&self) -> Vec<(i64, u32, Bounds<Pixels>, bool)> {
        let f = self.frame.borrow();
        f.wins
            .iter()
            .flat_map(|w| &w.lines)
            .map(|l| (l.buf, l.lnum, l.bounds, l.text_y.is_some()))
            .collect()
    }

    /// nvim flushes applied when the last frame was built (tests only: [`Self::painted_lines`]
    /// belong to the grids of that flush).
    #[doc(hidden)]
    pub fn painted_flushes(&self) -> u64 {
        self.frame.borrow().flushes
    }

    /// Change markers of the last frame: (color, bounds) (tests).
    pub fn painted_markers(&self) -> Vec<(Hsla, Bounds<Pixels>)> {
        let f = self.frame.borrow();
        f.wins
            .iter()
            .flat_map(|w| &w.markers)
            .map(|m| (m.color, m.bounds))
            .collect()
    }

    /// The annotation line under the mouse: (buf, lnum) (tests).
    pub fn hovered(&self) -> Option<(i64, u32)> {
        self.hover.as_ref().map(|h| (h.buf, h.lnum))
    }

    pub fn tooltip_text(&self) -> Option<String> {
        self.tip.as_ref().map(|t| t.text.to_string())
    }

    fn load(
        &mut self,
        buf: i64,
        path: String,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let l = self.loading.entry(buf).or_default();
        if let Some(c) = l.cancel.take() {
            c.cancel();
        }
        let cancel = Cancel::new();
        l.cancel = Some(cancel.clone());
        let ticket = l.latest.next();
        let file = PathBuf::from(&path);
        let dir = model::dir_of(&file);
        let task = job::spawn(cx, {
            let dir = dir.clone();
            move || {
                let root = cli::repo_root_blocking(&dir);
                let r = blame::blame_blocking(&dir, &path, text.as_deref(), &cancel);
                (root, r, cancel.is_cancelled())
            }
        });
        l.task = Some(cx.spawn_in(window, async move |this, cx| {
            let (root, r, cancelled) = task.await;
            let _ = this.update_in(cx, |v, window, cx| {
                if !ticket.is_current() || cancelled {
                    return;
                }
                match r {
                    Ok(b) => {
                        let m = Annotation::new(
                            buf,
                            dir,
                            file,
                            root.as_deref(),
                            b,
                            dates::now(),
                            dates::Zone::system(),
                        );
                        v.loaded(m, window, cx);
                    }
                    Err(e) => {
                        // git's own message, as the Lua showed it (not cli's "git exited with ...")
                        let msg = e.to_string();
                        let msg = match msg.strip_prefix("git exited with ") {
                            Some(rest) => rest.split_once(": ").map_or(rest, |(_, m)| m).to_owned(),
                            None => msg,
                        };
                        v.scx.call(
                            "config.app.annotate",
                            "failed",
                            vec![buf.into(), msg.into()],
                        );
                    }
                }
            });
        }));
    }

    fn loaded(&mut self, m: Annotation, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cw) = self.editor(cx).map(|e| e.read(cx).metrics().cell_width) else {
            return;
        };
        let layout = Layout::new(&m, cw, window);
        let (commits, lines) = m.line_table();
        let commits = commits
            .into_iter()
            .map(|(hash, file, prev)| {
                let mut kv: Vec<(Value, Value)> =
                    vec![("hash".into(), hash.into()), ("file".into(), file.into())];
                if let Some(p) = prev {
                    kv.push(("prev".into(), p.into()));
                }
                Value::Map(kv)
            })
            .collect();
        let buf = m.buf;
        self.scx.call(
            "config.app.annotate",
            "loaded",
            vec![
                buf.into(),
                (layout.cells as u64).into(),
                Value::Array(commits),
                Value::Array(lines.into_iter().map(Value::from).collect()),
            ],
        );
        self.anns.insert(buf, Loaded { model: m, layout });
        cx.notify();
    }

    fn close(&mut self, buf: i64, cx: &mut Context<Self>) {
        if let Some(l) = self.loading.remove(&buf) {
            l.latest.invalidate();
            if let Some(c) = l.cancel {
                c.cancel();
            }
        }
        self.anns.remove(&buf);
        if self.hover.as_ref().is_some_and(|h| h.buf == buf) {
            self.set_hover(None, None, cx);
        }
        cx.notify();
    }

    fn editor(&self, cx: &App) -> Option<gpui_kit::Entity<EditorView>> {
        Some(self.scx.workspace.upgrade()?.read(cx).editor().clone())
    }

    // Frame ------------------------------------------------------------------------------------

    /// What this frame paints, from the grids as the editor draws them now.
    fn build_frame(&self, cx: &App) -> Frame {
        let Some(editor) = self.editor(cx) else {
            return Frame::default();
        };
        let e = editor.read(cx);
        let drawn = self.scx.drawn().all();
        let mut wins = Vec::new();
        for d in drawn.values() {
            if e.kinds().get(&d.win).map(|k| k.kind) != Some(WinKind::Split) {
                continue;
            }
            let grid = match e.held_grid(d.grid) {
                Some((g, _)) => g,
                None => match e.ui().grids.get(&d.grid) {
                    Some(g) => g,
                    None => continue,
                },
            };
            let ui = e.ui();
            let name = |hl: u32| ui.hl.get(hl as usize).and_then(|a| a.name.as_deref());
            let scanned: Vec<_> = d
                .drawn_rows
                .clone()
                .filter_map(|r| {
                    Some((r, rows::scan(rows::drawn_row(grid, &d.text_rows, r)?, name)))
                })
                .collect();
            let lines = lines_with_leading(&scanned);
            if lines.is_empty() {
                continue;
            }
            wins.push(self.win_frame(d, &lines));
        }
        Frame {
            wins,
            flushes: e.ui().flushes,
        }
    }

    fn win_frame(&self, d: &DrawnGrid, lines: &[LineRows]) -> WinFrame {
        let row_h = d.metrics.row_height;
        let top = |r: i64| d.cell_origin(r, 0).y;
        let mut w = WinFrame {
            clip: d.text_clip,
            row_height: row_h,
            ..Default::default()
        };
        // annotations
        for l in lines {
            let Some((buf, cols)) = &l.annotate else {
                continue;
            };
            let Some(a) = self.anns.get(buf) else {
                continue;
            };
            let x = d.cell_origin(0, cols.start as i64).x;
            let width = a.layout.width.min(d.metrics.cell_width * cols.len() as f32);
            let (y0, y1) = (top(l.rows.start), top(l.rows.end));
            // a wrapped line whose first row scrolled out keeps its text at the top (WS "sticky")
            let text_y = if l.starts_here && y0 >= d.text_clip.top() - row_h / 2. {
                Some(y0)
            } else if y1 - d.text_clip.top() >= row_h {
                Some(y0.max(d.text_clip.top()))
            } else {
                None
            };
            let commit = a.model.commit_of(l.lnum);
            let texts = commit.and_then(|c| a.layout.texts[c].clone());
            w.lines.push(AnnLine {
                buf: *buf,
                lnum: l.lnum,
                commit,
                bounds: Bounds::new(point(x, y0), size(width, y1 - y0)),
                text_y,
                bg: commit
                    .and_then(|c| a.model.colors[c])
                    .map(|c| look::hex(c).into()),
                texts: texts.map(|(d, a2)| (d, a2, a.layout.author_x)),
            });
        }
        // change markers: one bar per run of lines of the same kind (WS paints a range at once)
        let mut i = 0;
        while i < lines.len() {
            let l = &lines[i];
            let (Some(kind), Some(col)) = (l.change, l.sign_col) else {
                i += 1;
                continue;
            };
            let cell_x = d.cell_origin(0, col as i64).x;
            let x = cell_x + px(BAR_X);
            let hit_w = d.metrics.cell_width * 2.;
            let bar_w = px(look::GUTTER_BAR_WIDTH);
            let key = (d.grid, l.rows.start);
            match kind {
                ChangeKind::Added | ChangeKind::Modified => {
                    let mut end = i + 1;
                    while end < lines.len()
                        && lines[end].change == Some(kind)
                        && lines[end].rows.start == lines[end - 1].rows.end
                    {
                        end += 1;
                    }
                    let (y0, y1) = (top(l.rows.start), top(lines[end - 1].rows.end));
                    let color = if kind == ChangeKind::Added {
                        look::GUTTER_ADDED
                    } else {
                        look::GUTTER_MODIFIED
                    };
                    // y + 1, h - 2 (LineStatusMarkerDrawUtil.paintRect new UI)
                    let inset = px(look::GUTTER_BAR_INSET_Y);
                    w.markers.push(Marker {
                        color: color.into(),
                        bounds: Bounds::new(
                            point(x, y0 + inset),
                            size(bar_w, (y1 - y0 - inset * 2.).max(px(1.))),
                        ),
                        hit: Bounds::new(point(cell_x, y0), size(hit_w, y1 - y0)),
                        key,
                        hovered: self.marker_hover == Some(key),
                        win: d.win,
                        lnum: l.lnum,
                    });
                    i = end;
                    continue;
                }
                ChangeKind::Deleted | ChangeKind::TopDeleted => {
                    let mut y = if kind == ChangeKind::Deleted {
                        top(l.rows.end)
                    } else {
                        top(l.rows.start)
                    };
                    let half = px(DELETED_HALF);
                    // WS: `if (y < size) y = size` (the marker stays whole at the top)
                    if kind == ChangeKind::TopDeleted {
                        y = y.max(d.text_clip.top() + half);
                    }
                    let gap = row_h / 3.;
                    w.markers.push(Marker {
                        color: look::GUTTER_DELETED.into(),
                        bounds: Bounds::new(
                            point(x, y - half + px(1.)),
                            size(bar_w, half * 2. - px(2.)),
                        ),
                        hit: Bounds::new(point(cell_x, y - gap), size(hit_w, gap * 2.)),
                        key,
                        hovered: self.marker_hover == Some(key),
                        win: d.win,
                        lnum: l.lnum,
                    });
                }
            }
            i += 1;
        }
        w
    }

    // Mouse ------------------------------------------------------------------------------------

    /// `reachable`: one of this layer's hitboxes is under the pointer (not a popup / menu over it).
    fn mouse_moved(&mut self, pos: Point<Pixels>, reachable: bool, cx: &mut Context<Self>) {
        let (line, marker) = if reachable {
            let f = self.frame.borrow();
            (f.line_at(pos).cloned(), f.marker_at(pos).map(|m| m.key))
        } else {
            (None, None)
        };
        if marker != self.marker_hover {
            self.marker_hover = marker;
            cx.notify();
        }
        let hover = line.map(|l| Hover {
            buf: l.buf,
            lnum: l.lnum,
            commit: l.commit,
        });
        self.set_hover(hover, Some(pos), cx);
    }

    fn set_hover(
        &mut self,
        hover: Option<Hover>,
        pos: Option<Point<Pixels>>,
        cx: &mut Context<Self>,
    ) {
        if hover == self.hover {
            return;
        }
        let same_commit = match (&hover, &self.hover) {
            (Some(a), Some(b)) => a.buf == b.buf && a.commit == b.commit,
            _ => false,
        };
        if !same_commit {
            cx.notify();
        }
        self.hover = hover.clone();
        if self.tip.take().is_some() {
            cx.notify();
        }
        self.tip_task = None;
        let (Some(h), Some(pos)) = (hover, pos) else {
            return;
        };
        let Some(commit) = h.commit else { return };
        let Some(a) = self.anns.get(&h.buf) else {
            return;
        };
        let c = a.model.commit(commit);
        if c.uncommitted {
            return;
        }
        let (hash, dir) = (c.hash.clone(), a.model.dir.clone());
        // the full message (blame only has the subject), while the tooltip waits
        let details = self.details.clone();
        let fetch = details.get(&hash).is_none().then(|| {
            let hash = hash.clone();
            job::spawn(cx, move || {
                let _ = details.load_blocking(&dir, &hash);
            })
        });
        let exec = cx.background_executor().clone();
        self.tip_task = Some(cx.spawn(async move |this, cx| {
            exec.timer(TOOLTIP_DELAY).await;
            let _ = this.update(cx, |v, cx| v.show_tip(&h, &hash, pos, cx));
            if let Some(f) = fetch {
                f.await;
                let _ = this.update(cx, |v, cx| {
                    if v.tip.as_ref().is_some_and(|t| t.hash == hash) {
                        v.show_tip(&h, &hash, pos, cx);
                    }
                });
            }
        }));
    }

    fn show_tip(&mut self, h: &Hover, hash: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.hover.as_ref() != Some(h) {
            return;
        }
        let Some(a) = self.anns.get(&h.buf) else {
            return;
        };
        let Some(commit) = h.commit else { return };
        let message = self.details.get(hash).map(|d| d.message.clone());
        let text = model::tooltip(
            a.model.commit(commit),
            a.model.rel.as_deref(),
            message.as_deref(),
            dates::Zone::system(),
        );
        self.tip = Some(Tip {
            text: text.into(),
            at,
            hash: hash.to_owned(),
        });
        cx.notify();
    }

    fn mouse_down(&mut self, ev: &MouseDownEvent, reachable: bool, cx: &mut Context<Self>) -> bool {
        if !reachable {
            return false;
        }
        let (line, marker) = {
            let f = self.frame.borrow();
            (
                f.line_at(ev.position).cloned(),
                f.marker_at(ev.position).cloned(),
            )
        };
        let Some(line) = line else {
            // a change marker: its hunk's popup (Lua's, as a click on the terminal's sign), with
            // annotations on too and anywhere on a deleted marker
            let Some(m) = marker.filter(|_| ev.button == MouseButton::Left) else {
                return false;
            };
            self.scx.call(
                "config.app.annotate",
                "marker_click",
                vec![m.win.into(), (m.lnum as u64).into()],
            );
            return true;
        };
        self.tip = None;
        self.tip_task = None;
        cx.notify();
        let args = vec![line.buf.into(), (line.lnum as u64).into()];
        match ev.button {
            MouseButton::Left => self.scx.call("config.app.annotate", "click", args),
            MouseButton::Right => {
                let mut args = args;
                args.extend([
                    f64::from(ev.position.x.as_f32()).into(),
                    f64::from(ev.position.y.as_f32()).into(),
                ]);
                self.scx.call("config.app.annotate", "menu", args);
            }
            _ => {}
        }
        true
    }

    // Paint ------------------------------------------------------------------------------------

    fn render_tip(&self) -> Option<gpui_kit::Deferred> {
        let tip = self.tip.as_ref()?;
        let lines: Vec<SharedString> = tip
            .text
            .split('\n')
            .map(|l| SharedString::from(if l.is_empty() { " " } else { l }.to_owned()))
            .collect();
        Some(
            deferred(
                anchored()
                    .position(point(tip.at.x, tip.at.y + px(TIP_GAP)))
                    .snap_to_window()
                    .child(
                        // (the commit's details: the regular UI size, not a help tooltip's)
                        crate::kit::tooltip_frame()
                            .text_size(px(look::UI_FONT_SIZE))
                            .max_w(px(TIP_MAX_WIDTH))
                            .flex()
                            .flex_col()
                            .children(lines.into_iter().map(|l| div().child(l))),
                    ),
            )
            .with_priority(1),
        )
    }
}

fn paint(frame: &Frame, window: &mut Window, cx: &mut App) {
    for w in &frame.wins {
        window.with_content_mask(Some(gpui_kit::ContentMask { bounds: w.clip }), |window| {
            for l in &w.lines {
                paint_line(l, w.row_height, window, cx);
            }
            for m in &w.markers {
                let mut b = m.bounds;
                if m.hovered {
                    // WS widens a hovered marker to the left
                    let extra = px(look::GUTTER_HOVER_EXTRA_WIDTH);
                    b.origin.x -= extra;
                    b.size.width += extra;
                }
                // arc = width (LineStatusMarkerDrawUtil: round ends)
                let radius = b.size.width.min(b.size.height) / 2.;
                window.paint_quad(fill(b, m.color).corner_radii(radius));
            }
        });
    }
}

fn paint_line(l: &AnnLine, row_height: Pixels, window: &mut Window, cx: &mut App) {
    if let Some(bg) = l.bg {
        window.paint_quad(fill(l.bounds, bg));
    }
    let (Some(y), Some((date, author, author_x))) = (l.text_y, &l.texts) else {
        return; // not committed yet: blank
    };
    let x = l.bounds.left();
    let _ = date.paint(
        point(x + px(FILLER), y),
        row_height,
        TextAlign::Left,
        None,
        window,
        cx,
    );
    let _ = author.paint(
        point(x + *author_x, y),
        row_height,
        TextAlign::Left,
        None,
        window,
        cx,
    );
}

/// [`rows::lines`] plus wrapped rows at the top whose line starts above the screen: they're the
/// line before the first numbered one (a closed fold is never wrapped).
fn lines_with_leading(scanned: &[(i64, rows::GutterRow)]) -> Vec<LineRows> {
    let mut lines = rows::lines(scanned);
    let leading: Vec<&(i64, rows::GutterRow)> = scanned
        .iter()
        .take_while(|(_, g)| g.numbered && g.lnum.is_none())
        .collect();
    if let (Some(first), Some(last), Some(next)) = (leading.first(), leading.last(), lines.first())
        && next.lnum > 1
        && next.rows.start == last.0 + 1
    {
        let g = &first.1;
        lines.insert(
            0,
            LineRows {
                lnum: next.lnum - 1,
                rows: first.0..last.0 + 1,
                starts_here: false,
                annotate: g.annotate.clone(),
                sign_col: g.sign_col,
                change: None,
            },
        );
    }
    lines
}

impl Surface for AnnotateView {
    const NAME: &'static str = "annotate";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        AnnotateView {
            scx,
            focus: cx.focus_handle(),
            anns: HashMap::new(),
            loading: HashMap::new(),
            frame: Rc::default(),
            hover: None,
            marker_hover: None,
            tip: None,
            tip_task: None,
            details: DetailsCache::default(),
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<Event>(Self::NAME, payload) else {
            return;
        };
        match ev {
            Event::Load { buf, path, text } => self.load(buf, path, text, window, cx),
            Event::Close { buf } => self.close(buf, cx),
        }
    }
}

impl Focusable for AnnotateView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// Hitboxes of one frame: annotation lines and markers (pointer cursor).
struct Hits(Vec<Hitbox>);

impl Render for AnnotateView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let weak: WeakEntity<Self> = cx.entity().downgrade();
        let (w1, w2) = (weak.clone(), weak);
        let layer = canvas(
            move |_, window, cx| {
                let Some(this) = w1.upgrade() else {
                    return Hits(Vec::new());
                };
                let frame = this.read(cx).build_frame(cx);
                let mut hits = Vec::new();
                for w in &frame.wins {
                    let rects = w
                        .lines
                        .iter()
                        .map(|l| l.bounds)
                        .chain(w.markers.iter().map(|m| m.hit));
                    for b in rects {
                        let b = b.intersect(&w.clip);
                        if b.size.width > px(0.) && b.size.height > px(0.) {
                            hits.push(window.insert_hitbox(b, HitboxBehavior::Normal));
                        }
                    }
                }
                *this.read(cx).frame.borrow_mut() = frame;
                Hits(hits)
            },
            move |_, hits, window, cx| {
                let Some(this) = w2.upgrade() else { return };
                for h in &hits.0 {
                    window.set_cursor_style(CursorStyle::PointingHand, h);
                }
                let frame = this.read(cx).frame.borrow().clone();
                paint(&frame, window, cx);
                let weak = this.downgrade();
                // popups / menus / floats above occlude: what's under them isn't hovered or clicked
                let hits = Rc::new(hits.0.clone());
                let reachable = {
                    let hits = hits.clone();
                    move |pos: Point<Pixels>, window: &Window| {
                        hits.iter().any(|h| h.is_hovered_at(pos, window))
                    }
                };
                window.on_mouse_event({
                    let (weak, reachable) = (weak.clone(), reachable.clone());
                    move |ev: &MouseMoveEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble {
                            let r = reachable(ev.position, window);
                            let _ = weak.update(cx, |v, cx| v.mouse_moved(ev.position, r, cx));
                        }
                    }
                });
                window.on_mouse_event({
                    let weak = weak.clone();
                    move |ev: &MouseDownEvent, phase, window, cx| {
                        let r = reachable(ev.position, window);
                        if phase == DispatchPhase::Bubble
                            && weak
                                .update(cx, |v, cx| v.mouse_down(ev, r, cx))
                                .unwrap_or(false)
                        {
                            cx.stop_propagation();
                        }
                    }
                });
                window.on_mouse_event(move |_: &ScrollWheelEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        let _ = weak.update(cx, |v, cx| v.set_hover(None, None, cx));
                    }
                });
            },
        )
        .absolute()
        .size_full();
        div()
            .absolute()
            .size_full()
            .child(layer)
            .children(self.render_tip())
    }
}
