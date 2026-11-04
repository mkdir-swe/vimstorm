//! The custom element drawing nvim's grids in their islands.
//!
//! Where each grid goes comes from the workspace's [`Geometry`] (window coordinates): every nvim
//! window's island (a rounded panel), its grid clipped to it, then floats / the message grid in
//! nvim's compindex order; grid 1 (separators, global status line) isn't drawn. Per row:
//! background runs merged by color, ASCII text shaped in one line per span (styles as text runs,
//! `force_width` = cell width so glyphs stay on the cell grid), other cells (wide chars, icons,
//! combining text) shaped one by one at their cell's x, and block / box / mosaic chars drawn as
//! shapes ([`super::sprites`]). The caret (or the IME preedit) goes on top. A smooth-scrolled
//! window's text area is drawn shifted and clipped ([`GridHost::scroll_offset_of`]); a grid of a sync
//! group whose partners haven't caught up is drawn from its held picture
//! ([`GridHost::held_grid`], [`crate::nvim`]). Windows a native surface covers (`role`) get
//! no grid, and no island unless they keep a tab bar
//! ([`crate::shell::WinRect::draws_island`]). The geometry's cursor regions set the
//! mouse cursor (resize arrows on gaps, I-beam over editor text).

use std::ops::Range;

use gpui_kit::{
    App, Bounds, ContentMask, Context, CursorStyle, Element, ElementId, Entity, GlobalElementId,
    Hitbox, HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, PaintQuad, Path,
    PathBuilder, Pixels, Point, ShapedLine, SharedString, StrikethroughStyle, Style, TextAlign,
    TextRun, UnderlineStyle, Window, fill, point, px, relative, rgb, size,
};

use super::fonts::{cell_font, editor_font};
use super::metrics::CellMetrics;
use super::sprites::{Corner, Edge, Shape, sprite};
use crate::look;
use crate::nvim::{Cell, CellText, CursorPos, Grid, Margins, UiState};
use crate::nvim::{CursorShape, GridId, HlAttr};
use crate::shell::{FRAME_BG, Geometry, GridPlace, ISLAND_BORDER, ISLAND_RADIUS, PlaceKind};

/// What the element needs from the view that owns the nvim state.
pub trait GridHost: 'static + Sized {
    fn ui(&self) -> &UiState;
    fn metrics(&self) -> CellMetrics;
    /// Caret drawn this frame (not while busy). Steady: no blink (user request).
    fn caret_visible(&self) -> bool;
    /// Where every grid goes this frame (window coordinates).
    fn geometry(&self) -> &Geometry;
    /// Called in prepaint, before drawing.
    fn prepaint(&mut self, _cx: &mut Context<Self>) {}
    /// Smooth scrolling: draw this window grid's text area shifted (+ = down) by at most the rows
    /// the grid kept (`Grid::above` / `below`), which fill the edge it reveals.
    fn scroll_offset(&self) -> Option<(GridId, Pixels)> {
        None
    }
    /// The offset of one window grid's text area (default: [`GridHost::scroll_offset`]'s grid);
    /// sync partners moving with the scrolled grid get it too.
    fn scroll_offset_of(&self, grid: GridId) -> Option<Pixels> {
        self.scroll_offset()
            .filter(|(g, _)| *g == grid)
            .map(|(_, off)| off)
    }
    /// A held picture to draw instead of nvim's current grid (sync groups), with its margins.
    fn held_grid(&self, _grid: GridId) -> Option<(&Grid, Margins)> {
        None
    }
    /// IME marked text to draw at the caret.
    fn preedit(&self) -> Option<String> {
        None
    }
    /// Where the caret is drawn (default nvim's cursor; local echo's ahead of it, with its grid
    /// from [`GridHost::held_grid`]).
    fn cursor(&self) -> CursorPos {
        self.ui().cursor
    }
    /// The other carets of several (multi-cursor), drawn like [`GridHost::cursor`]'s.
    fn extra_carets(&self) -> Vec<CursorPos> {
        Vec::new()
    }
    /// Called in paint: register the IME input handler here (`window.handle_input`).
    fn paint_input(
        _view: &Entity<Self>,
        _bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
}

pub struct GridElement<V: GridHost> {
    view: Entity<V>,
    /// Only the message grid (and the caret when it's there): its own layer, painted above the
    /// native tree / tool windows its full-width rows reach under.
    messages: bool,
}

impl<V: GridHost> GridElement<V> {
    /// Everything but the message grid.
    pub fn new(view: Entity<V>) -> Self {
        GridElement {
            view,
            messages: false,
        }
    }

    /// The message grid's layer (mount it above the native surfaces, below floats / popups).
    pub fn messages(view: Entity<V>) -> Self {
        GridElement {
            view,
            messages: true,
        }
    }
}

impl<V: GridHost> IntoElement for GridElement<V> {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

enum Op {
    Quad(PaintQuad),
    Path(Path<Pixels>, Hsla),
    Text(Box<ShapedLine>, Point<Pixels>),
    /// Ops drawn clipped to a rectangle (a smooth-scrolled text area).
    Clip(Bounds<Pixels>, Vec<Op>),
}

fn paint_ops(ops: Vec<Op>, row_height: Pixels, window: &mut Window, cx: &mut App) {
    for op in ops {
        match op {
            Op::Quad(q) => window.paint_quad(q),
            Op::Path(p, c) => window.paint_path(p, c),
            Op::Text(line, origin) => {
                let _ = line.paint(origin, row_height, TextAlign::Left, None, window, cx);
            }
            Op::Clip(bounds, ops) => {
                window.with_content_mask(Some(ContentMask { bounds }), |window| {
                    paint_ops(ops, row_height, window, cx)
                });
            }
        }
    }
}

pub struct Prepainted {
    ops: Vec<Op>,
    /// Mouse cursor regions (resize arrows on gaps, I-beam over editor text).
    cursors: Vec<(Hitbox, CursorStyle)>,
}

fn color(c: u32) -> Hsla {
    rgb(c).into()
}

/// Resolved style of an hl id.
struct CellStyle<'a> {
    fg: u32,
    bg: u32,
    sp: u32,
    attr: &'a HlAttr,
}

fn style(ui: &UiState, hl: u32) -> CellStyle<'_> {
    let (fg, bg, sp) = ui.colors(hl);
    CellStyle {
        fg,
        bg,
        sp,
        attr: ui.hl_attr(hl),
    }
}

fn text_run(s: &CellStyle, len: usize, fg_override: Option<u32>) -> TextRun {
    let a = s.attr;
    let underline = if a.undercurl {
        Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(color(s.sp)),
            wavy: true,
        })
    } else if a.underline || a.underdouble || a.underdotted || a.underdashed {
        Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(color(a.sp.unwrap_or(s.fg))),
            wavy: false,
        })
    } else {
        None
    };
    TextRun {
        len,
        font: editor_font(a.bold, a.italic),
        color: color(fg_override.unwrap_or(s.fg)),
        background_color: None,
        underline,
        strikethrough: a.strikethrough.then(|| StrikethroughStyle {
            thickness: px(1.0),
            color: Some(color(s.fg)),
        }),
    }
}

fn has_decoration(a: &HlAttr) -> bool {
    a.underline || a.undercurl || a.underdouble || a.underdotted || a.underdashed || a.strikethrough
}

fn shapes(ops: &mut Vec<Op>, shapes: &[Shape], cell: Bounds<Pixels>, fg: Hsla) {
    let (x, y, w, h) = (
        cell.origin.x,
        cell.origin.y,
        cell.size.width,
        cell.size.height,
    );
    let at = |fx: f32, fy: f32| point(x + w * fx, y + h * fy);
    for s in shapes {
        match s {
            Shape::Rect {
                x0,
                y0,
                x1,
                y1,
                alpha,
            } => ops.push(Op::Quad(fill(
                Bounds::from_corners(at(*x0, *y0), at(*x1, *y1)),
                fg.opacity(*alpha),
            ))),
            Shape::HLine { from, to, heavy } => {
                let t = px(if *heavy { 2.0 } else { 1.0 });
                let cy = (y + h * 0.5 - t * 0.5).round();
                ops.push(Op::Quad(fill(
                    Bounds::new(point(x + w * *from, cy), size(w * (*to - *from), t)),
                    fg,
                )));
            }
            Shape::VLine { from, to, heavy } => {
                let t = px(if *heavy { 2.0 } else { 1.0 });
                let cx = (x + w * 0.5 - t * 0.5).round();
                ops.push(Op::Quad(fill(
                    Bounds::new(point(cx, y + h * *from), size(t, h * (*to - *from))),
                    fg,
                )));
            }
            Shape::Poly(points) => {
                let Some(first) = points.first() else {
                    continue;
                };
                let mut path = Path::new(at(first.0, first.1));
                for p in &points[1..] {
                    path.line_to(at(p.0, p.1));
                }
                ops.push(Op::Path(path, fg));
            }
            Shape::Arc(corner) => arc(ops, *corner, cell, fg),
            Shape::Fade(to) => fade(ops, *to, cell, fg),
            Shape::Node { arms, filled } => node(ops, *arms, *filled, cell, fg),
            Shape::Diag { down } => diag(ops, *down, cell, fg),
        }
    }
}

/// Paints a cell's sprite shapes (block / box / mosaic chars) at once: the native terminal's grid
/// ([`crate::terminal`]) draws them like nvim's grids.
pub(crate) fn paint_sprite(
    sprite_shapes: &[Shape],
    cell: Bounds<Pixels>,
    fg: Hsla,
    window: &mut Window,
    cx: &mut App,
) {
    let mut ops = Vec::new();
    shapes(&mut ops, sprite_shapes, cell, fg);
    paint_ops(ops, cell.size.height, window, cx);
}

/// Highlight group of LSP inlay hints (`value:`), drawn as rounded boxes like WebStorm's.
const INLAY_HINT: &str = "LspInlayHint";
/// Inlay hint text: the editor font this much smaller (WebStorm's inlay font = editor size - 1).
pub const INLAY_FONT_DELTA: f32 = 1.0;
/// Least room between the inlay box's left edge and its text.
const INLAY_PAD_X: f32 = 3.0;

/// Is the cell part of an LSP inlay hint?
fn is_inlay(ui: &UiState, cell: &Cell) -> bool {
    ui.hl_attr(cell.hl).name.as_deref() == Some(INLAY_HINT)
}

/// Gutter line numbers: the editor font this much smaller (WebStorm
/// `EditorGutterComponentImpl.getFontForLineNumbers`: `editor.gutter.linenumber.font.size.delta`
/// = -1).
pub const LINE_NUMBER_FONT_DELTA: f32 = 1.0;

/// How far down text shaped [`LINE_NUMBER_FONT_DELTA`] smaller (its `ascent` / `descent` at
/// `size`) has to move to sit on the grid font's baseline: GPUI paints the baseline at
/// `(row - ascent - descent) / 2 + ascent`, which the smaller size moves up by half of the
/// ascent - descent it loses.
fn baseline_shift(ascent: Pixels, descent: Pixels, size: Pixels) -> Pixels {
    (ascent - descent) / size.as_f32() * (LINE_NUMBER_FONT_DELTA / 2.)
}

/// Is the cell a line number in a code split's gutter (left of its first text column)?
fn is_gutter_number(ui: &UiState, cell: &Cell, span: &Span, col: i64) -> bool {
    span.trim.is_some_and(|t| col < t as i64)
        && ui
            .hl_attr(cell.hl)
            .name
            .as_deref()
            .is_some_and(crate::git::annotate::is_number)
}

/// Light line thickness (box drawing, branch glyphs).
const LIGHT: f32 = 1.0;

/// Center of the light lines through `cell`: on the same px as [`Shape::HLine`] /
/// [`Shape::VLine`], so arcs and nodes meet them without a step.
fn line_center(cell: Bounds<Pixels>) -> (f32, f32) {
    let t = LIGHT;
    let (x, y) = (cell.origin.x.as_f32(), cell.origin.y.as_f32());
    let (w, h) = (cell.size.width.as_f32(), cell.size.height.as_f32());
    (
        (x + w * 0.5 - t * 0.5).round() + t * 0.5,
        (y + h * 0.5 - t * 0.5).round() + t * 0.5,
    )
}

fn stroked(build: impl FnOnce(&mut PathBuilder)) -> Option<Path<Pixels>> {
    let mut b = PathBuilder::stroke(px(LIGHT));
    build(&mut b);
    b.build().ok()
}

/// Ghostty's `box.zig` `arc`: straight from the two edge centers to radius min(w, h) / 2 from
/// the center, joined by a cubic with control points a quarter radius from the center.
fn arc(ops: &mut Vec<Op>, corner: Corner, cell: Bounds<Pixels>, fg: Hsla) {
    let (cx, cy) = line_center(cell);
    let (x, y) = (cell.origin.x.as_f32(), cell.origin.y.as_f32());
    let (w, h) = (cell.size.width.as_f32(), cell.size.height.as_f32());
    let r = w.min(h) / 2.0;
    let s = 0.25;
    // vertical side (+1 down), horizontal side (+1 right)
    let (dy, dx) = match corner {
        Corner::TopLeft => (-1.0, -1.0),
        Corner::TopRight => (-1.0, 1.0),
        Corner::BottomLeft => (1.0, -1.0),
        Corner::BottomRight => (1.0, 1.0),
    };
    let edge_y = if dy < 0.0 { y } else { y + h };
    let edge_x = if dx < 0.0 { x } else { x + w };
    if let Some(path) = stroked(|b| {
        b.move_to(point(px(cx), px(edge_y)));
        b.line_to(point(px(cx), px(cy + dy * r)));
        b.cubic_bezier_to(
            point(px(cx + dx * r), px(cy)),
            point(px(cx), px(cy + dy * s * r)),
            point(px(cx + dx * s * r), px(cy)),
        );
        b.line_to(point(px(edge_x), px(cy)));
    }) {
        ops.push(Op::Path(path, fg));
    }
}

/// ╲ / ╱ from a neighbour column's line center at one row edge to the other neighbour's at the
/// other edge: half a cell into each side, where git's graph has the lanes it joins. Stroked past
/// the row edges and clipped to the row, so the ends are cut flat at the edges (no gap, no poke
/// into the rows above / below).
fn diag(ops: &mut Vec<Op>, down: bool, cell: Bounds<Pixels>, fg: Hsla) {
    let (cx, _) = line_center(cell);
    let (w, h) = (cell.size.width.as_f32(), cell.size.height.as_f32());
    let top = cell.origin.y.as_f32();
    let (x0, x1) = if down {
        (cx - w, cx + w)
    } else {
        (cx + w, cx - w)
    };
    let (ext, slope) = (h * 0.1, (x1 - x0) / h);
    if let Some(path) = stroked(|b| {
        b.move_to(point(px(x0 - slope * ext), px(top - ext)));
        b.line_to(point(px(x1 + slope * ext), px(top + h + ext)));
    }) {
        let clip = Bounds::new(
            point(cell.origin.x - cell.size.width, cell.origin.y),
            size(cell.size.width * 3.0, cell.size.height),
        );
        ops.push(Op::Clip(clip, vec![Op::Path(path, fg)]));
    }
}

/// Ghostty's `fadingLine`: a light line from opaque to clear at `to`, in 1 px steps.
fn fade(ops: &mut Vec<Op>, to: Edge, cell: Bounds<Pixels>, fg: Hsla) {
    let (cx, cy) = line_center(cell);
    let (x, y) = (cell.origin.x.as_f32(), cell.origin.y.as_f32());
    let (w, h) = (cell.size.width.as_f32(), cell.size.height.as_f32());
    let t = LIGHT;
    let vertical = matches!(to, Edge::Top | Edge::Bottom);
    let len = if vertical { h } else { w };
    let steps = len.ceil().max(1.0) as usize;
    let step = len / steps as f32;
    for i in 0..steps {
        let mid = (i as f32 + 0.5) / steps as f32;
        let alpha = match to {
            Edge::Right | Edge::Bottom => 1.0 - mid,
            Edge::Left | Edge::Top => mid,
        };
        let at = i as f32 * step;
        let b = if vertical {
            Bounds::new(point(px(cx - t / 2.0), px(y + at)), size(px(t), px(step)))
        } else {
            Bounds::new(point(px(x + at), px(cy - t / 2.0)), size(px(step), px(t)))
        };
        ops.push(Op::Quad(fill(b, fg.opacity(alpha))));
    }
}

/// Ghostty's `branchNode`: a circle as wide as the cell allows around the line center, arms
/// from its edge to the cell edges.
fn node(ops: &mut Vec<Op>, arms: [bool; 4], filled: bool, cell: Bounds<Pixels>, fg: Hsla) {
    let (cx, cy) = line_center(cell);
    let (x, y) = (cell.origin.x.as_f32(), cell.origin.y.as_f32());
    let (w, h) = (cell.size.width.as_f32(), cell.size.height.as_f32());
    let t = LIGHT;
    let r = (cx - x).min(cy - y).min(x + w - cx).min(y + h - cy);
    let [up, right, down, left] = arms;
    let rect = |x0: f32, y0: f32, x1: f32, y1: f32| {
        Op::Quad(fill(
            Bounds::from_corners(point(px(x0), px(y0)), point(px(x1), px(y1))),
            fg,
        ))
    };
    if up {
        ops.push(rect(cx - t / 2.0, y, cx + t / 2.0, cy - r + t / 2.0));
    }
    if right {
        ops.push(rect(cx + r - t / 2.0, cy - t / 2.0, x + w, cy + t / 2.0));
    }
    if down {
        ops.push(rect(cx - t / 2.0, cy + r - t / 2.0, cx + t / 2.0, y + h));
    }
    if left {
        ops.push(rect(x, cy - t / 2.0, cx - r + t / 2.0, cy + t / 2.0));
    }
    let circle = |b: &mut PathBuilder, r: f32| {
        let radii = point(px(r), px(r));
        b.move_to(point(px(cx + r), px(cy)));
        b.arc_to(radii, px(0.), false, true, point(px(cx - r), px(cy)));
        b.arc_to(radii, px(0.), false, true, point(px(cx + r), px(cy)));
        b.close();
    };
    let path = if filled {
        let mut b = PathBuilder::fill();
        circle(&mut b, r);
        b.build().ok()
    } else {
        stroked(|b| circle(b, r - t / 2.0))
    };
    if let Some(path) = path {
        ops.push(Op::Path(path, fg));
    }
}

/// Draws one non-ASCII cell (sprite or a single shaped glyph).
fn single_cell(
    ops: &mut Vec<Op>,
    window: &Window,
    m: &CellMetrics,
    text: &str,
    s: &CellStyle,
    fg: Option<u32>,
    cell: Bounds<Pixels>,
) {
    let mut chars = text.chars();
    let first = chars.next().unwrap_or(' ');
    if chars.next().is_none()
        && let Some(sh) = sprite(first)
    {
        shapes(ops, &sh, cell, color(fg.unwrap_or(s.fg)));
        return;
    }
    let mut run = text_run(s, text.len(), fg);
    run.font = cell_font(first, s.attr.bold, s.attr.italic);
    let line = window.text_system().shape_line(
        SharedString::from(text.to_owned()),
        m.font_size,
        &[run],
        None,
    );
    ops.push(Op::Text(Box::new(line), cell.origin));
}

/// The visible columns of a layer.
struct Span {
    col: i64,
    floating: bool,
    base: bool,
    c_start: usize,
    c_end: usize,
    /// A code split's first text column: drawn [`look::GUTTER_TRIM`] left from there on.
    trim: Option<usize>,
}

impl Span {
    /// The x shift of column `col` (the gutter trim).
    fn dx(&self, col: i64) -> Pixels {
        if self.trim.is_some_and(|t| col >= t as i64) {
            px(-look::GUTTER_TRIM)
        } else {
            px(0.)
        }
    }

    /// Does a run of cells have to end before column `col` (the trim starts there)?
    fn splits_at(&self, col: i64) -> bool {
        self.trim.is_some_and(|t| col == t as i64)
    }
}

/// Backgrounds and text of one grid row at screen row `srow`, for a grid drawn at `origin`.
#[allow(
    clippy::too_many_arguments,
    reason = "hot per-row draw: plain borrows, no per-row struct"
)]
fn draw_row(
    ops: &mut Vec<Op>,
    ui: &UiState,
    m: &CellMetrics,
    window: &Window,
    cells: &[Cell],
    origin: Point<Pixels>,
    srow: i64,
    span: &Span,
) {
    let (c_start, c_end) = (span.c_start, span.c_end.min(cells.len()));
    let at = |b: Bounds<Pixels>, col: i64| {
        Bounds::new(point(b.origin.x + span.dx(col), b.origin.y), b.size)
    };
    // backgrounds, merged in runs; grid 1 skips the default bg (painted under everything)
    let mut c = c_start;
    while c < c_end {
        let s = style(ui, cells[c].hl);
        let alpha = if span.floating {
            1.0 - s.attr.blend as f32 / 100.0
        } else {
            1.0
        };
        let mut e = c + 1;
        while e < c_end {
            let s2 = style(ui, cells[e].hl);
            if s2.bg != s.bg || s2.attr.blend != s.attr.blend || span.splits_at(span.col + e as i64)
            {
                break;
            }
            e += 1;
        }
        let mut run = at(
            m.cell_bounds(origin, srow, span.col + c as i64, e - c),
            span.col + c as i64,
        );
        if e == cells.len() && span.trim.is_some() {
            // the trimmed row still reaches the grid's right edge
            run.size.width += px(look::GUTTER_TRIM);
        }
        if s.attr.name.as_deref() == Some(INLAY_HINT) {
            // WebStorm's inlay hints: a rounded box on the line's own background
            let under = c
                .checked_sub(1)
                .map_or(ui.default_bg, |p| style(ui, cells[p].hl).bg);
            ops.push(Op::Quad(fill(run, color(under).opacity(alpha))));
            let inset = Bounds::new(
                point(run.origin.x + px(1.), run.origin.y + px(3.)),
                size(run.size.width - px(2.), run.size.height - px(6.)),
            );
            ops.push(Op::Quad(
                fill(inset, color(s.bg).opacity(alpha)).corner_radii(px(4.)),
            ));
        } else if !span.base || s.bg != ui.default_bg {
            ops.push(Op::Quad(fill(run, color(s.bg).opacity(alpha))));
        }
        c = e;
    }

    // text
    let mut c = c_start;
    while c < c_end {
        let ascii = |t: &CellText| match t {
            CellText::Space => true,
            CellText::Char(ch) => ch.is_ascii(),
            _ => false,
        };
        if ascii(&cells[c].text) {
            let mut e = c;
            let mut text = String::new();
            let mut runs: Vec<TextRun> = Vec::new();
            let mut visible = false;
            let mut last_hl = None;
            // an inlay hint is its own run (smaller font), so are the cells around it
            let inlay = is_inlay(ui, &cells[c]);
            // gutter line numbers too (smaller font, right-aligned)
            let number = is_gutter_number(ui, &cells[c], span, span.col + c as i64);
            while e < c_end
                && ascii(&cells[e].text)
                && is_inlay(ui, &cells[e]) == inlay
                && is_gutter_number(ui, &cells[e], span, span.col + e as i64) == number
                && (e == c || !span.splits_at(span.col + e as i64))
            {
                let cell = &cells[e];
                let before = text.len();
                cell.text.push_to(&mut text);
                let s = style(ui, cell.hl);
                if cell.text != CellText::Space || has_decoration(s.attr) {
                    visible = true;
                }
                if last_hl == Some(cell.hl)
                    && let Some(run) = runs.last_mut()
                {
                    run.len += text.len() - before;
                } else {
                    runs.push(text_run(&s, text.len() - before, None));
                    last_hl = Some(cell.hl);
                }
                e += 1;
            }
            if visible && inlay {
                // WebStorm: the editor font 1 px smaller in the box, its own advances; centred
                // in the cells' box (the narrower glyphs leave room)
                let line = window.text_system().shape_line(
                    text.into(),
                    m.font_size - px(INLAY_FONT_DELTA),
                    &runs,
                    None,
                );
                let o = m.cell_origin(origin, srow, span.col + c as i64);
                let room = m.cell_width * (e - c) as f32;
                let x = o.x
                    + span.dx(span.col + c as i64)
                    + ((room - line.width) / 2.).max(px(INLAY_PAD_X));
                ops.push(Op::Text(Box::new(line), point(x, o.y)));
            } else if visible && number {
                // the digits end where the grid font's would (WS: right edge matches), on the
                // code's baseline (paint centres ascent + descent in the row: move down by the
                // half of their difference the smaller size loses)
                let end = text.trim_end().len();
                let last = c + text[..end].chars().count();
                let line = window.text_system().shape_line(
                    text.into(),
                    m.font_size - px(LINE_NUMBER_FONT_DELTA),
                    &runs,
                    None,
                );
                let right = m.cell_origin(origin, srow, span.col + last as i64);
                let dy = baseline_shift(line.ascent, line.descent, line.font_size);
                let x = right.x - line.x_for_index(end);
                ops.push(Op::Text(Box::new(line), point(x, right.y + dy)));
            } else if visible {
                let line = window.text_system().shape_line(
                    text.into(),
                    m.font_size,
                    &runs,
                    Some(m.cell_width),
                );
                let o = m.cell_origin(origin, srow, span.col + c as i64);
                ops.push(Op::Text(
                    Box::new(line),
                    point(o.x + span.dx(span.col + c as i64), o.y),
                ));
            }
            c = e;
        } else {
            let cell = &cells[c];
            let wide = cells.get(c + 1).is_some_and(|n| n.text.is_empty());
            if !cell.text.is_empty() {
                let mut t = String::new();
                cell.text.push_to(&mut t);
                let s = style(ui, cell.hl);
                let bounds = at(
                    m.cell_bounds(origin, srow, span.col + c as i64, if wide { 2 } else { 1 }),
                    span.col + c as i64,
                );
                single_cell(ops, window, m, &t, &s, None, bounds);
            }
            c += 1;
        }
    }
}

/// What a place draws: nvim's grid (and its window's margins), or a held picture.
fn source<V: GridHost>(v: &V, grid: GridId) -> Option<(&Grid, Margins)> {
    if let Some(held) = v.held_grid(grid) {
        return Some(held);
    }
    let ui = v.ui();
    let margins = ui.windows.get(&grid).map(|w| w.margins).unwrap_or_default();
    Some((ui.grids.get(&grid)?, margins))
}

/// A smooth-scrolled window's text area: its grid rows and its rectangle (the clip).
fn text_area(
    src: (&Grid, Margins),
    m: &CellMetrics,
    place: &GridPlace,
) -> Option<(Range<usize>, Bounds<Pixels>)> {
    let (g, margins) = src;
    let top = margins.top.min(g.height);
    let rows = top..g.height.saturating_sub(margins.bottom).max(top);
    if rows.is_empty() {
        return None;
    }
    let top_left = m.cell_origin(place.origin, rows.start as i64, 0);
    let area = Bounds::new(
        top_left,
        size(
            m.cell_width * g.width as f32,
            m.row_height * rows.len() as f32,
        ),
    );
    Some((rows, area.intersect(&place.clip)))
}

/// Islands under the grids: each nvim window's rounded panel in its grid's background.
fn islands(ops: &mut Vec<Op>, ui: &UiState, geo: &Geometry) {
    for w in geo.layout.wins.iter().filter(|w| w.draws_island()) {
        // the grid's last cell: plain text area (Normal / NormalNC of that window)
        let bg = ui
            .grids
            .get(&w.grid)
            .and_then(|g| g.cells.last())
            .map_or(ui.default_bg, |c| ui.colors(c.hl).1);
        ops.push(Op::Quad(
            fill(w.island, color(bg)).corner_radii(px(ISLAND_RADIUS.get())),
        ));
    }
}

/// Frame-colored corners over the islands' grid content, so the islands stay rounded: a ring
/// around each island (outer radius 2r, border r: its inner edge is the island's rounded rect),
/// clipped to the island, leaves only the four corners outside the rounding. Quads, no paths.
fn island_corners(ops: &mut Vec<Op>, geo: &Geometry) {
    let r = px(ISLAND_RADIUS.get());
    for w in geo.layout.wins.iter().filter(|w| w.draws_island()) {
        let ring = fill(w.island.dilate(r), gpui_kit::transparent_black())
            .corner_radii(r * 2.)
            .border_widths(r)
            .border_color(FRAME_BG);
        ops.push(Op::Clip(w.island, vec![Op::Quad(ring)]));
    }
}

/// The islands' 1 px outline, over grid content that reaches it.
fn island_outlines(ops: &mut Vec<Op>, geo: &Geometry) {
    for w in geo.layout.wins.iter().filter(|w| w.draws_island()) {
        ops.push(Op::Quad(
            fill(w.island, gpui_kit::transparent_black())
                .corner_radii(px(ISLAND_RADIUS.get()))
                .border_widths(px(ISLAND_BORDER))
                .border_color(look::ISLAND_BORDER),
        ));
    }
}

/// Draw ops for one grid (`src`: nvim's or a held picture) at its place. `scroll`: a
/// smooth-scrolled window grid, drawn shifted (+ = down) with the rows it kept in the edge that
/// reveals.
fn grid_ops(
    ops: &mut Vec<Op>,
    ui: &UiState,
    m: &CellMetrics,
    window: &Window,
    place: &GridPlace,
    src: Option<(&Grid, Margins)>,
    scroll: Option<Pixels>,
) {
    let Some((grid, margins)) = src else {
        return;
    };
    let span = Span {
        col: 0,
        floating: place.kind != PlaceKind::Window,
        base: false,
        c_start: 0,
        c_end: grid.width,
        trim: place.trim_col,
    };
    let shifted = scroll.and_then(|off| Some((off, text_area((grid, margins), m, place)?)));
    let mut inner = Vec::new();
    for r in 0..grid.height {
        if shifted
            .as_ref()
            .is_some_and(|(_, (rows, _))| rows.contains(&r))
        {
            continue;
        }
        draw_row(
            &mut inner,
            ui,
            m,
            window,
            grid.row(r),
            place.origin,
            r as i64,
            &span,
        );
    }
    ops.push(Op::Clip(place.clip, inner));
    if let Some((off, (rows, clip))) = shifted {
        let mut inner = Vec::new();
        let o = point(place.origin.x, place.origin.y + off);
        for r in rows.clone() {
            draw_row(&mut inner, ui, m, window, grid.row(r), o, r as i64, &span);
        }
        let (above, below) = grid.kept_rows();
        let w = grid.width;
        if off > px(0.) {
            // revealed at the top: the rows that left there, the last one next to the text
            for i in 0..above {
                let r = rows.start as i64 - (above - i) as i64;
                let cells = &grid.above[i * w..(i + 1) * w];
                draw_row(&mut inner, ui, m, window, cells, o, r, &span);
            }
        } else {
            for i in 0..below {
                let r = rows.end as i64 + i as i64;
                let cells = &grid.below[i * w..(i + 1) * w];
                draw_row(&mut inner, ui, m, window, cells, o, r, &span);
            }
        }
        ops.push(Op::Clip(clip, inner));
    }
}

/// Draw ops for the frame: islands, window grids (each clipped to its island), rounded corners,
/// floats in nvim's order, then the caret (or the IME preedit). `messages`: only the message
/// grid (and the caret when it's in there).
fn build<V: GridHost>(v: &V, window: &Window, preedit: Option<&str>, messages: bool) -> Vec<Op> {
    let ui = v.ui();
    let m = &v.metrics();
    let geo = v.geometry();
    let caret_on = v.caret_visible();
    let mut ops = Vec::new();
    let offset = |grid| v.scroll_offset_of(grid);
    if !messages {
        islands(&mut ops, ui, geo);
        let windows = geo.places.iter().filter(|p| p.kind == PlaceKind::Window);
        for place in windows {
            let src = source(v, place.grid);
            grid_ops(&mut ops, ui, m, window, place, src, offset(place.grid));
        }
        island_corners(&mut ops, geo);
        island_outlines(&mut ops, geo);
    }
    let layer = |p: &&GridPlace| match p.kind {
        PlaceKind::Window => false,
        PlaceKind::Message => messages,
        _ => !messages,
    };
    for place in geo.places.iter().filter(layer) {
        if place.kind == PlaceKind::Message {
            message_separator(&mut ops, ui, m, window, place);
            // the command line spans the islands' width, whatever nvim's columns
            let bg = style(ui, 0).bg;
            ops.push(Op::Quad(fill(place.clip, color(bg))));
        }
        grid_ops(&mut ops, ui, m, window, place, source(v, place.grid), None);
    }

    if caret_on && !messages {
        let main = v.cursor();
        for cursor in v.extra_carets().into_iter().filter(|c| *c != main) {
            caret_op(&mut ops, v, window, cursor, None, messages);
        }
    }
    if caret_on || preedit.is_some() {
        caret_op(&mut ops, v, window, v.cursor(), preedit, messages);
    }
    ops
}

/// One caret (or the IME preedit) at `cursor`, in its grid's place: grid-relative, so it moves
/// with a smooth-scrolled text area.
fn caret_op<V: GridHost>(
    ops: &mut Vec<Op>,
    v: &V,
    window: &Window,
    cursor: CursorPos,
    preedit: Option<&str>,
    messages: bool,
) {
    let ui = v.ui();
    let m = &v.metrics();
    let geo = v.geometry();
    let offset = |grid| v.scroll_offset_of(grid);
    if let Some((cursor_grid, _)) = source(v, cursor.grid)
        && let Some(mut caret) = ui.caret_at(cursor, cursor_grid)
        && let Some(place) = geo.place(cursor.grid)
        && (place.kind == PlaceKind::Message) == messages
    {
        // grid-relative: drawn at the cursor grid's place, moving with a smooth-scrolled text area
        caret.row = cursor.row as i64;
        caret.col = cursor.col as i64;
        let shift = offset(cursor.grid).and_then(|off| {
            let (rows, clip) = text_area(source(v, cursor.grid)?, m, place)?;
            rows.contains(&cursor.row).then_some((off, clip))
        });
        let cell = cursor_grid
            .cell(cursor.row, cursor.col)
            .cloned()
            .unwrap_or_default();
        let mut inner = Vec::new();
        let o = match shift {
            Some((off, _)) => point(place.origin.x, place.origin.y + off),
            None => place.origin,
        };
        // in a code split's text columns: with the gutter trim
        let trimmed = place.trim_col.is_some_and(|t| caret.col >= t as i64);
        let o = point(
            o.x - if trimmed {
                px(look::GUTTER_TRIM)
            } else {
                px(0.)
            },
            o.y,
        );
        match preedit {
            Some(text) => {
                let (fg, bg, _) = ui.colors(cell.hl);
                preedit_ops(&mut inner, m, o, window, caret, (fg, bg), text)
            }
            None => caret_ops(&mut inner, ui, m, o, window, caret, cell),
        }
        let clip = shift.map_or(place.clip, |(_, clip)| clip);
        ops.push(Op::Clip(clip, inner));
    }
}

/// The separator row above a message grid that scrolled over the windows, full width.
fn message_separator(
    ops: &mut Vec<Op>,
    ui: &UiState,
    m: &CellMetrics,
    window: &Window,
    place: &GridPlace,
) {
    let Some((_, sep, hl)) = ui.msg_separator() else {
        return;
    };
    let s = style(ui, hl);
    let bounds = Bounds::new(
        point(place.clip.origin.x, place.origin.y - m.row_height),
        size(place.clip.size.width, m.row_height),
    );
    ops.push(Op::Quad(fill(bounds, color(s.bg))));
    if sep != " " {
        let n = (bounds.size.width / m.cell_width).floor() as usize;
        let text = sep.repeat(n);
        let run = text_run(&s, text.len(), None);
        let line =
            window
                .text_system()
                .shape_line(text.into(), m.font_size, &[run], Some(m.cell_width));
        ops.push(Op::Text(Box::new(line), bounds.origin));
    }
}

/// IME marked text (a dead key's accent, a composition) at the caret: underlined, in the editor
/// font, with a bar caret after it, in `colors` (fg, bg: the caret cell's).
fn preedit_ops(
    ops: &mut Vec<Op>,
    m: &CellMetrics,
    origin: Point<Pixels>,
    window: &Window,
    caret: crate::nvim::Caret,
    colors: (u32, u32),
    text: &str,
) {
    let (fg, bg) = colors;
    let fg = color(fg);
    let run = TextRun {
        len: text.len(),
        font: editor_font(false, false),
        color: fg,
        background_color: None,
        underline: Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(fg),
            wavy: false,
        }),
        strikethrough: None,
    };
    let line = window.text_system().shape_line(
        SharedString::from(text.to_owned()),
        m.font_size,
        &[run],
        None,
    );
    let at = m.cell_origin(origin, caret.row, caret.col);
    // whole cells, so the bar after it sits where nvim's insert caret would
    let width = m.cell_width * (line.width / m.cell_width).round().max(1.0);
    ops.push(Op::Quad(fill(
        Bounds::new(at, size(width, m.row_height)),
        color(bg),
    )));
    ops.push(Op::Text(Box::new(line), at));
    let after = Bounds::new(point(at.x + width, at.y), size(m.cell_width, m.row_height));
    ops.push(Op::Quad(fill(
        caret_rect(m, after, CursorShape::Vertical, 1.),
        fg,
    )));
}

fn caret_ops(
    ops: &mut Vec<Op>,
    ui: &UiState,
    m: &CellMetrics,
    origin: Point<Pixels>,
    window: &Window,
    caret: crate::nvim::Caret,
    cell: Cell,
) {
    let cs = style(ui, cell.hl);
    // 'guicursor' hiding the caret (blend=100, e.g. GitHiddenCursor) draws nothing
    if caret.attr_id != 0 && ui.hl_attr(caret.attr_id).blend >= 100 {
        return;
    }
    let (caret_bg, caret_fg) = ui.caret_colors(caret.attr_id);
    let cols = if caret.wide { 2 } else { 1 };
    let full = m.cell_bounds(origin, caret.row, caret.col, cols);
    let pct = caret.percentage as f32 / 100.0;
    let rect = caret_rect(m, full, caret.shape, pct);
    match caret.shape {
        CursorShape::Block => {
            ops.push(Op::Quad(fill(rect, color(caret_bg))));
            let mut t = String::new();
            cell.text.push_to(&mut t);
            if !t.trim().is_empty() {
                if t.is_ascii() {
                    let run = text_run(&cs, t.len(), Some(caret_fg));
                    let line = window.text_system().shape_line(
                        t.into(),
                        m.font_size,
                        &[run],
                        Some(m.cell_width),
                    );
                    ops.push(Op::Text(Box::new(line), full.origin));
                } else {
                    single_cell(ops, window, m, &t, &cs, Some(caret_fg), full);
                }
            }
        }
        CursorShape::Vertical | CursorShape::Horizontal => {
            ops.push(Op::Quad(fill(rect, color(caret_bg))));
        }
    }
}

/// WebStorm's insert caret width (EditorImpl caret: `JBUIScale.scale(2)`, Settings "Caret width"
/// default); nvim's `ver25` percentage only says "a bar".
pub const BAR_CARET_WIDTH: f32 = 2.0;

/// Where the caret is drawn in its cell(s) `full`: block and bar span the font's line centred in
/// the row ([`CellMetrics::caret_height`], WS), the bar [`BAR_CARET_WIDTH`] wide; the underline
/// (`hor` in 'guicursor': replace mode) keeps nvim's percentage at the row's bottom.
pub fn caret_rect(
    m: &CellMetrics,
    full: Bounds<Pixels>,
    shape: CursorShape,
    pct: f32,
) -> Bounds<Pixels> {
    let h = m.caret_height().min(full.size.height);
    let top = full.origin.y + (full.size.height - h) / 2.;
    match shape {
        CursorShape::Block => Bounds::new(point(full.origin.x, top), size(full.size.width, h)),
        CursorShape::Vertical => {
            Bounds::new(point(full.origin.x, top), size(px(BAR_CARET_WIDTH), h))
        }
        CursorShape::Horizontal => {
            let h = (m.row_height * pct).max(px(1.0));
            Bounds::new(
                point(full.origin.x, full.origin.y + full.size.height - h),
                size(full.size.width, h),
            )
        }
    }
}

impl<V: GridHost> Element for GridElement<V> {
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
        if self.messages {
            // the main element (painted earlier this frame) already ran the view's prepaint
            let v = self.view.read(cx);
            let ops = build(v, window, v.preedit().as_deref(), true);
            return Prepainted {
                ops,
                cursors: Vec::new(),
            };
        }
        self.view.update(cx, |v, cx| v.prepaint(cx));
        let v = self.view.read(cx);
        let geo = v.geometry();
        let preedit = v.preedit();
        let ops = build(v, window, preedit.as_deref(), false);
        let cursors = geo
            .cursor_regions()
            .into_iter()
            .filter(|(b, _)| b.intersects(&bounds))
            .map(|(b, style)| (window.insert_hitbox(b, HitboxBehavior::Normal), style))
            .collect();
        Prepainted { ops, cursors }
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
        if !self.messages {
            V::paint_input(&self.view, bounds, window, cx);
        }
        for (hitbox, style) in &prepaint.cursors {
            window.set_cursor_style(*style, hitbox);
        }
        let row_height = self.view.read(cx).metrics().row_height;
        let ops = std::mem::take(&mut prepaint.ops);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            paint_ops(ops, row_height, window, cx)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagonals_span_the_full_row_into_both_neighbours() {
        let cell = Bounds::new(point(px(16.), px(44.)), size(px(8.), px(22.)));
        for down in [true, false] {
            let mut ops = Vec::new();
            diag(&mut ops, down, cell, rgb(0xffffff).into());
            let [Op::Clip(clip, inner)] = &ops[..] else {
                panic!("one clipped path");
            };
            // the whole row height (line-height padding included), a neighbour column each side
            assert_eq!(clip.origin, point(px(8.), px(44.)));
            assert_eq!(clip.size, size(px(24.), px(22.)));
            assert!(matches!(&inner[..], [Op::Path(..)]));
        }
    }

    #[test]
    fn smaller_gutter_numbers_sit_on_the_code_baseline() {
        // GPUI's baseline in a 22 px row for JetBrains Mono (ascent 1.02 em, descent 0.3 em)
        let baseline = |size: f32| {
            let (a, d) = (px(1.02 * size), px(0.3 * size));
            (px(22.) - a - d) / 2. + a
        };
        let small = 13. - LINE_NUMBER_FONT_DELTA;
        let dy = baseline_shift(px(1.02 * small), px(0.3 * small), px(small));
        assert!((baseline(small) + dy - baseline(13.)).abs() < px(0.001));
    }

    #[test]
    fn carets_span_the_font_line_centred_and_the_bar_is_2px() {
        let m = CellMetrics {
            font_size: px(13.),
            cell_width: px(7.8),
            row_height: px(22.),
            ..Default::default()
        };
        let full = m.cell_bounds(point(px(10.), px(100.)), 2, 3, 1);
        let block = caret_rect(&m, full, CursorShape::Block, 1.);
        // 30.png: 18.4 tall (AA included), 1.7 above / 1.9 below in the 22 px row
        assert_eq!(block.size, size(px(7.8), px(18.)));
        assert_eq!(block.origin.y, full.origin.y + px(2.));
        let bar = caret_rect(&m, full, CursorShape::Vertical, 0.25);
        assert_eq!(bar.size, size(px(2.), px(18.)));
        assert_eq!(bar.origin, block.origin);
        let under = caret_rect(&m, full, CursorShape::Horizontal, 0.2);
        assert_eq!(under.origin.y + under.size.height, full.origin.y + px(22.));
    }
}
