//! The chrome that moves with the text: gutters (line numbers, change bands, action icons), the
//! connectors in the dividers, lines where one side has lines the other doesn't, and the
//! scrollbar change marks. Painted by a canvas in the diff layer: its prepaint runs after the
//! editor's grid element published this frame's [`DrawnGrid`]s, and each pane's rows are read
//! from the very cells drawn ([`super::rows`]), so nothing drifts while the panes smooth-scroll,
//! are held for their sync partners or fold.
//!
//! Geometry after IntelliJ's diff: `DiffDividerDrawUtil` (polygons between the panes, curved
//! edges = cubic Béziers with horizontal tangents), `DiffDrawUtil` (line markers, border lines
//! for empty sides, error stripe marks), `DiffGutterRenderer` (14 px icons next to the divider).

use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{
    App, Bounds, ContentMask, Corners, CursorStyle, DispatchPhase, Hitbox, HitboxBehavior, Hsla,
    IntoElement, MouseButton, MouseDownEvent, PathBuilder, Pixels, Point, RenderImage,
    ScrollWheelEvent, SharedString, Styled as _, TextAlign, TextRun, Window, canvas, fill, point,
    px, size,
};
use rmpv::Value;

use super::model::{ChangeKind, GutterIcon, Lines, Viewer};
use super::rows::{RowLine, RowMap, decode, row_cells};
use crate::kit::{self, IconName};
use crate::look;
use crate::render::editor_font;
use crate::shell::ViewerRect;
use crate::shell::{DrawnGrid, SurfaceCx};

/// Gap between an icon slot and the next.
const ICON_SLOT: f32 = look::DIFF_GUTTER_ICON + 2.0;
/// Gutter padding next to the divider, and between the numbers and the text.
const PAD: f32 = 3.0;
const NUMBER_GAP: f32 = 6.0;

/// Band / connector color of a change kind (full color; text lines may use the lighter
/// "ignored" color, nvim's highlights).
pub fn kind_bg(kind: ChangeKind) -> Hsla {
    match kind {
        ChangeKind::Inserted => look::DIFF_INSERTED_BG,
        ChangeKind::Deleted => look::DIFF_DELETED_BG,
        ChangeKind::Modified => look::DIFF_MODIFIED_BG,
        ChangeKind::Conflict => look::DIFF_CONFLICT_BG,
    }
    .into()
}

/// Error stripe / border line color of a change kind.
pub fn kind_stripe(kind: ChangeKind) -> Hsla {
    match kind {
        ChangeKind::Inserted => look::DIFF_INSERTED_STRIPE,
        ChangeKind::Deleted => look::DIFF_DELETED_STRIPE,
        ChangeKind::Modified => look::DIFF_MODIFIED_STRIPE,
        ChangeKind::Conflict => look::DIFF_CONFLICT_STRIPE,
    }
    .into()
}

pub fn icon_name(icon: GutterIcon) -> IconName {
    match icon {
        GutterIcon::Revert | GutterIcon::AcceptLeft => IconName::AcceptLeftGutter,
        GutterIcon::AcceptRight => IconName::AcceptRightGutter,
        GutterIcon::Ignore => IconName::IgnoreGutter,
        GutterIcon::Magic => IconName::MagicResolveGutter,
        GutterIcon::Comment => IconName::ReviewComment,
    }
}

/// One pane as this frame draws it.
#[derive(Clone, Debug)]
pub struct PaneFrame {
    pub win: i64,
    /// 1-based.
    pub pane: usize,
    pub rect: ViewerRect,
    /// Where text rows are drawn (y), the pane's x extent (gutter + grid).
    pub clip: Bounds<Pixels>,
    /// The grid's x range (gap lines span it).
    pub grid_x: (f32, f32),
    pub rows: RowMap,
    /// The gutter is outside the grid (the first, mirrored pane): clicks there are ours.
    pub outside_gutter: bool,
    /// The editor font's size (line numbers).
    pub font_size: Pixels,
}

/// A gutter icon placed this frame.
#[derive(Clone, Debug)]
pub struct IconHit {
    pub bounds: Bounds<Pixels>,
    pub icon: GutterIcon,
    pub action: String,
    pub args: Vec<Value>,
    pub tip: String,
}

/// Everything computed in prepaint, painted and hit-tested.
#[derive(Default)]
pub struct Frame {
    pub panes: Vec<PaneFrame>,
    pub icons: Vec<IconHit>,
}

impl Frame {
    pub fn pane_at(&self, pos: Point<Pixels>) -> Option<&PaneFrame> {
        self.panes.iter().find(|p| {
            let gutter = p.rect.gutter;
            pos.x >= gutter.left()
                && pos.x < gutter.right()
                && pos.y >= p.clip.top()
                && pos.y < p.clip.bottom()
        })
    }

    pub fn icon_at(&self, pos: Point<Pixels>) -> Option<&IconHit> {
        self.icons.iter().find(|i| i.bounds.contains(&pos))
    }
}

/// The rows a pane draws now, with their lines (from the presented grid: held or nvim's).
fn row_map(scx: &SurfaceCx, dg: &DrawnGrid, cx: &App) -> RowMap {
    let rh = dg.metrics.row_height.as_f32();
    let Some(ws) = scx.workspace.upgrade() else {
        return RowMap::default();
    };
    let editor = ws.read(cx).editor().read(cx);
    let grid = match editor.sync().held(dg.grid) {
        Some(h) => &h.grid,
        None => match editor.ui().grids.get(&dg.grid) {
            Some(g) => g,
            None => return RowMap::default(),
        },
    };
    let base = dg.origin.y.as_f32() + dg.offset.as_f32();
    let rows = dg
        .drawn_rows
        .clone()
        .filter_map(|r| {
            let cells = row_cells(grid, &dg.text_rows, r)?;
            let (line, folded) = decode(cells)?;
            Some(RowLine {
                line,
                folded,
                y: base + r as f32 * rh,
            })
        })
        .collect();
    RowMap::new(rows, rh)
}

/// What a frame showed (tests: [`super::DiffView::record_frames`]): the toolbar's file index and
/// the text of each pane's presented grid.
pub type FrameRecord = (Option<(i64, i64)>, Vec<String>);
pub type Recorder = Rc<std::cell::RefCell<Option<Vec<FrameRecord>>>>;

/// The text of a pane's grid as presented (held picture or nvim's).
fn presented_text(scx: &SurfaceCx, grid: crate::nvim::GridId, cx: &App) -> String {
    let Some(ws) = scx.workspace.upgrade() else {
        return String::new();
    };
    let editor = ws.read(cx).editor().read(cx);
    let g = match editor.sync().held(grid) {
        Some(h) => &h.grid,
        None => match editor.ui().grids.get(&grid) {
            Some(g) => g,
            None => return String::new(),
        },
    };
    (0..g.height)
        .map(|r| g.row_text(r))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The panes as drawn this frame (those laid out with their chrome).
pub fn panes(scx: &SurfaceCx, viewer: &Viewer, cx: &App) -> Vec<PaneFrame> {
    let geo = scx.geometry();
    let drawn = scx.drawn().all();
    let mut out = Vec::new();
    for (i, p) in viewer.panes.iter().enumerate() {
        let Some(wr) = geo.win_rect(p.win) else {
            continue;
        };
        let (Some(rect), Some(dg)) = (wr.viewer, drawn.get(&wr.grid)) else {
            continue;
        };
        let outside_gutter = rect.gutter.left() >= wr.grid_area.right();
        let x0 = rect.gutter.left().min(wr.grid_area.left());
        let x1 = rect.gutter.right().max(wr.grid_area.right());
        let clip = Bounds::from_corners(
            point(x0, dg.text_clip.top()),
            point(x1, dg.text_clip.bottom()),
        );
        out.push(PaneFrame {
            win: p.win,
            pane: i + 1,
            rect,
            clip,
            grid_x: (wr.grid_area.left().as_f32(), wr.grid_area.right().as_f32()),
            rows: row_map(scx, dg, cx),
            outside_gutter,
            font_size: dg.metrics.font_size,
        });
    }
    out
}

/// x of icon slot `k` in a pane's gutter (next to the divider).
fn icon_x(p: &PaneFrame, k: usize) -> f32 {
    let g = p.rect.gutter;
    if p.pane == 1 {
        g.right().as_f32() - PAD - (k + 1) as f32 * ICON_SLOT + 2.
    } else {
        g.left().as_f32() + PAD + k as f32 * ICON_SLOT
    }
}

/// Icon slots a pane's gutter keeps free of numbers.
fn icon_slots(viewer: &Viewer, pane: usize) -> usize {
    let mut n = 0;
    for d in &viewer.dividers {
        for c in d {
            let mut k = 0;
            for a in &c.actions {
                if a.pane == pane {
                    k += 1;
                }
            }
            n = n.max(k);
        }
    }
    n.max(1)
}

/// The lines of change side `pane` of divider `d` (pane d+1 is side a, d+2 side b, 1-based).
fn side(c: &super::model::Change, d: usize, pane: usize) -> Option<Lines> {
    if pane == d + 1 {
        Some(c.a)
    } else if pane == d + 2 {
        Some(c.b)
    } else {
        None
    }
}

/// Icons of this frame (only on rows drawn).
pub fn icons(viewer: &Viewer, panes: &[PaneFrame]) -> Vec<IconHit> {
    let mut out = Vec::new();
    let s = px(look::DIFF_GUTTER_ICON);
    for (d, list) in viewer.dividers.iter().enumerate() {
        for c in list {
            let mut slot = std::collections::HashMap::<usize, usize>::new();
            for a in &c.actions {
                let Some(p) = panes.iter().find(|p| p.pane == a.pane) else {
                    continue;
                };
                let Some(lines) = side(c, d, a.pane) else {
                    continue;
                };
                let Some((top, bottom)) = p.rows.span(lines.s, lines.e) else {
                    continue;
                };
                let rh = p.rows.row_height;
                // first row of the change; an empty side: on its boundary
                let cy = if lines.is_empty() {
                    top
                } else {
                    top + rh.min(bottom - top) / 2.
                };
                if cy < p.clip.top().as_f32() || cy > p.clip.bottom().as_f32() {
                    continue;
                }
                let k = slot.entry(a.pane).or_default();
                let x = icon_x(p, *k);
                *k += 1;
                out.push(IconHit {
                    bounds: Bounds::new(point(px(x), px(cy) - s / 2.), size(s, s)),
                    icon: a.icon,
                    action: a.action.clone(),
                    args: a.args.clone(),
                    tip: a.tip.clone(),
                });
            }
        }
    }
    // a PR diff's drafted comments: the comment mark in the slot nearest the divider, on the
    // line's row; a click puts the caret there, the tooltip is the comment
    for p in panes {
        let Some(pane) = viewer.panes.get(p.pane - 1) else {
            continue;
        };
        for d in &pane.drafts {
            let Some(r) = p.rows.rows.iter().find(|r| r.line == d.line && !r.folded) else {
                continue;
            };
            let cy = r.y + p.rows.row_height / 2.;
            if cy < p.clip.top().as_f32() || cy > p.clip.bottom().as_f32() {
                continue;
            }
            out.push(IconHit {
                bounds: Bounds::new(point(px(icon_x(p, 0)), px(cy) - s / 2.), size(s, s)),
                icon: GutterIcon::Comment,
                action: "line".into(),
                args: vec![Value::from(p.win), Value::from(d.line)],
                tip: d.body.clone(),
            });
        }
    }
    out
}

/// A connector between the left pane's lines (ya) and the right pane's (yb) across the divider
/// (x0..x1): IntelliJ's curved polygon.
fn connector(x0: f32, x1: f32, ya: (f32, f32), yb: (f32, f32)) -> Option<gpui_kit::Path<Pixels>> {
    let w = x1 - x0;
    let (c0, c1) = (x0 + w * 0.5, x1 - w * 0.5);
    let mut b = PathBuilder::fill();
    // an edge whose ends are level is a straight line (a flat Bézier doesn't tessellate)
    let edge_to = |b: &mut PathBuilder, from: (f32, f32), to: (f32, f32)| {
        if (from.1 - to.1).abs() < 0.5 {
            b.line_to(point(px(to.0), px(to.1)));
        } else {
            let (ca, cb) = if from.0 < to.0 { (c0, c1) } else { (c1, c0) };
            b.cubic_bezier_to(
                point(px(to.0), px(to.1)),
                point(px(ca), px(from.1)),
                point(px(cb), px(to.1)),
            );
        }
    };
    b.move_to(point(px(x0), px(ya.0)));
    edge_to(&mut b, (x0, ya.0), (x1, yb.0));
    b.line_to(point(px(x1), px(yb.1)));
    edge_to(&mut b, (x1, yb.1), (x0, ya.1));
    b.close();
    b.build().ok()
}

/// One edge of a connector (an empty side's border line, drawn on top so it shows).
fn edge(x0: f32, x1: f32, ya: f32, yb: f32) -> Option<gpui_kit::Path<Pixels>> {
    let w = x1 - x0;
    let mut b = PathBuilder::stroke(px(1.));
    b.move_to(point(px(x0), px(ya)));
    if (ya - yb).abs() < 0.5 {
        b.line_to(point(px(x1), px(yb)));
        return b.build().ok();
    }
    b.cubic_bezier_to(
        point(px(x1), px(yb)),
        point(px(x0 + w * 0.5), px(ya)),
        point(px(x1 - w * 0.5), px(yb)),
    );
    b.build().ok()
}

fn hline(x0: f32, x1: f32, y: f32, color: Hsla) -> gpui_kit::PaintQuad {
    fill(
        Bounds::new(
            point(px(x0), px(y.round())),
            size(px(x1 - x0), px(look::DIFF_GAP_LINE)),
        ),
        color,
    )
}

/// Paints one frame of the chrome.
fn paint(
    frame: &Frame,
    viewer: &Viewer,
    images: &[(GutterIcon, Arc<RenderImage>)],
    window: &mut Window,
    cx: &mut App,
) {
    let rh = frame.panes.first().map_or(20., |p| p.rows.row_height);
    // connectors
    for (d, list) in viewer.dividers.iter().enumerate() {
        let (Some(a), Some(b)) = (
            frame.panes.iter().find(|p| p.pane == d + 1),
            frame.panes.iter().find(|p| p.pane == d + 2),
        ) else {
            continue;
        };
        let Some(div) = a.rect.divider else {
            continue;
        };
        let clip = Bounds::from_corners(
            point(div.left(), a.clip.top().max(b.clip.top())),
            point(div.right(), a.clip.bottom().min(b.clip.bottom())),
        );
        let (x0, x1) = (div.left().as_f32(), div.right().as_f32());
        window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
            for c in list {
                let (Some(ya), Some(yb)) = (a.rows.span(c.a.s, c.a.e), b.rows.span(c.b.s, c.b.e))
                else {
                    continue;
                };
                let (top, bottom) = (clip.top().as_f32(), clip.bottom().as_f32());
                if (ya.1 < top && yb.1 < top) || (ya.0 > bottom && yb.0 > bottom) {
                    continue;
                }
                let level = |a: f32, b: f32| (a - b).abs() < 0.5;
                if level(ya.0, yb.0) && level(ya.1, yb.1) {
                    // both sides at the same height: a plain band
                    window.paint_quad(fill(
                        Bounds::from_corners(point(px(x0), px(ya.0)), point(px(x1), px(ya.1))),
                        kind_bg(c.kind),
                    ));
                } else if let Some(path) = connector(x0, x1, ya, yb) {
                    window.paint_path(path, kind_bg(c.kind));
                }
                let stripe = kind_stripe(c.kind);
                if c.a.is_empty() || c.b.is_empty() {
                    for (ea, eb) in [(ya.0, yb.0), (ya.1, yb.1)] {
                        if let Some(path) = edge(x0, x1, ea, eb) {
                            window.paint_path(path, stripe);
                        }
                    }
                }
            }
        });
    }
    // per pane: bands, gap lines, numbers
    for p in &frame.panes {
        let mut bands: Vec<(f32, f32, ChangeKind)> = Vec::new();
        let mut gaps: Vec<(f32, ChangeKind)> = Vec::new();
        for (d, list) in viewer.dividers.iter().enumerate() {
            for c in list {
                let Some(lines) = side(c, d, p.pane) else {
                    continue;
                };
                let Some((top, bottom)) = p.rows.span(lines.s, lines.e) else {
                    continue;
                };
                if lines.is_empty() {
                    gaps.push((top, c.kind));
                } else {
                    bands.push((top, bottom, c.kind));
                }
            }
        }
        let g = p.rect.gutter;
        let (gx0, gx1) = (g.left().as_f32(), g.right().as_f32());
        let numbers_right = if p.pane == 1 {
            gx1 - PAD - icon_slots(viewer, 1) as f32 * ICON_SLOT - NUMBER_GAP / 2.
        } else {
            gx1 - NUMBER_GAP
        };
        window.with_content_mask(Some(ContentMask { bounds: p.clip }), |window| {
            for (t, b, kind) in &bands {
                window.paint_quad(fill(
                    Bounds::new(point(g.left(), px(*t)), size(g.size.width, px(b - t))),
                    kind_bg(*kind),
                ));
            }
            let font_size = p.font_size;
            for r in &p.rows.rows {
                if r.folded {
                    continue;
                }
                let on_band = bands
                    .iter()
                    .any(|(t, b, _)| r.y + rh / 2. > *t && r.y + rh / 2. < *b);
                let color: Hsla = if on_band {
                    look::EDITOR_LINE_NUMBER_CURRENT
                } else {
                    look::EDITOR_LINE_NUMBER
                }
                .into();
                let text = SharedString::from(r.line.to_string());
                let run = TextRun {
                    len: text.len(),
                    font: editor_font(false, false),
                    color,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let line = window
                    .text_system()
                    .shape_line(text, font_size, &[run], None);
                let x = numbers_right - line.width.as_f32();
                let _ = line.paint(
                    point(px(x), px(r.y)),
                    px(rh),
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
            }
            // a 1 px line where the other side has lines this one doesn't (pane + gutter)
            let (lx0, lx1) = (gx0.min(p.grid_x.0), gx1.max(p.grid_x.1));
            for (y, kind) in &gaps {
                window.paint_quad(hline(lx0, lx1, *y, kind_stripe(*kind)));
            }
        });
    }
    // gutter icons
    for i in &frame.icons {
        if let Some((_, img)) = images.iter().find(|(k, _)| *k == i.icon) {
            let _ = window.paint_image(
                i.bounds,
                i.bounds,
                Corners::default(),
                img.clone(),
                0,
                false,
            );
        }
    }
    // scrollbar change marks: the whole file scaled to the strip
    for p in &frame.panes {
        let m = p.rect.marks;
        let w = look::DIFF_MARK_WIDTH;
        // at the strip's outer edge (the first pane's marks are on its left)
        let x = if p.pane == 1 {
            m.left().as_f32() + 2.
        } else {
            m.right().as_f32() - 2. - w
        };
        for (d, list) in viewer.dividers.iter().enumerate() {
            for c in list {
                let Some(l) = side(c, d, p.pane) else {
                    continue;
                };
                let (y0, y1) = mark_span(viewer, p, rh, l);
                window.paint_quad(fill(
                    Bounds::new(point(px(x), px(y0)), size(px(w), px(y1 - y0))),
                    kind_stripe(c.kind),
                ));
            }
        }
    }
}

/// The y extent of pane `p`'s scrollbar mark for lines `l`: the whole file over the marks strip,
/// but never stretched (a short file's marks sit at its lines).
fn mark_span(viewer: &Viewer, p: &PaneFrame, rh: f32, l: Lines) -> (f32, f32) {
    let m = p.rect.marks;
    let (top, h) = (m.top().as_f32(), m.size.height.as_f32());
    let lines = viewer.panes.get(p.pane - 1).map_or(1, |x| x.lines.max(1)) as f32;
    let lines = lines.max(h / rh);
    let y0 = top + (l.s - 1) as f32 / lines * h;
    let y1 = (top + (l.e - 1) as f32 / lines * h).max(y0 + look::DIFF_MARK_MIN_HEIGHT);
    (y0, y1)
}

/// The change mark under `pos` in a pane's own marks strip (right of its grid: the first pane's
/// is over its grid, nvim's click): that pane and the change's first line.
fn mark_at(frame: &Frame, viewer: &Viewer, pos: Point<Pixels>) -> Option<(i64, i64)> {
    let p = frame
        .panes
        .iter()
        .find(|p| p.pane > 1 && p.rect.marks.contains(&pos))?;
    let y = pos.y.as_f32();
    viewer.dividers.iter().enumerate().find_map(|(d, list)| {
        list.iter().find_map(|c| {
            let l = side(c, d, p.pane)?;
            let (y0, y1) = mark_span(viewer, p, p.rows.row_height, l);
            (y >= y0 && y <= y1).then_some((p.win, l.s.max(1)))
        })
    })
}

/// Rust -> Lua: an action of the viewer (`config/app/diff.lua` `action`).
pub fn act(scx: &SurfaceCx, generation: i64, name: &str, args: Vec<Value>) {
    let mut all = vec![Value::from(generation), Value::from(name)];
    all.extend(args);
    scx.call("config.app.diff", "action", all);
}

struct Prepainted {
    frame: Rc<Frame>,
    images: Vec<(GutterIcon, Arc<RenderImage>)>,
    icon_hits: Vec<Hitbox>,
    regions: Vec<Hitbox>,
    /// The dividers' bands (the workspace drags them: [`crate::shell::GapKind::Divider`]).
    dividers: Vec<Hitbox>,
}

/// The chrome canvas over the whole window (it paints only in the viewer's island).
pub fn layer(scx: SurfaceCx, viewer: Rc<Viewer>, recorder: Recorder) -> impl IntoElement {
    let scx2 = scx.clone();
    let v2 = viewer.clone();
    canvas(
        move |_bounds, window, cx| {
            let panes = panes(&scx, &viewer, cx);
            if let Some(log) = recorder.borrow_mut().as_mut() {
                let geo = scx.geometry();
                let texts = viewer
                    .panes
                    .iter()
                    .filter_map(|p| Some(presented_text(&scx, geo.win_rect(p.win)?.grid, cx)))
                    .collect();
                log.push((viewer.toolbar.files, texts));
            }
            let icons = icons(&viewer, &panes);
            let mut images = Vec::new();
            for i in &icons {
                if !images.iter().any(|(k, _)| *k == i.icon)
                    && let Some(img) = kit::image(icon_name(i.icon), cx)
                {
                    images.push((i.icon, img));
                }
            }
            let icon_hits = icons
                .iter()
                .map(|i| window.insert_hitbox(i.bounds, HitboxBehavior::Normal))
                .collect();
            // gutters, dividers, outside marks strips: ours (arrow cursor, wheel forwarded; a
            // divider's resize cursor: it drags)
            let mut regions = Vec::new();
            let mut dividers = Vec::new();
            for p in &panes {
                let g = Bounds::from_corners(
                    point(p.rect.gutter.left(), p.clip.top()),
                    point(p.rect.gutter.right(), p.clip.bottom()),
                );
                regions.push(window.insert_hitbox(g, HitboxBehavior::Normal));
                if let Some(d) = p.rect.divider {
                    dividers.push(window.insert_hitbox(d, HitboxBehavior::Normal));
                }
                if p.pane > 1 {
                    regions.push(window.insert_hitbox(p.rect.marks, HitboxBehavior::Normal));
                }
            }
            Prepainted {
                frame: Rc::new(Frame { panes, icons }),
                images,
                icon_hits,
                regions,
                dividers,
            }
        },
        move |_bounds, pre, window, cx| {
            for h in &pre.regions {
                window.set_cursor_style(CursorStyle::Arrow, h);
            }
            for h in &pre.dividers {
                window.set_cursor_style(CursorStyle::ResizeColumn, h);
            }
            for h in &pre.icon_hits {
                window.set_cursor_style(CursorStyle::PointingHand, h);
            }
            paint(&pre.frame, &v2, &pre.images, window, cx);
            listen(&scx2, &v2, &pre, window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// Mouse on the chrome: icons act, the outside gutter moves the caret / unfolds, right-click
/// opens the pane's menu, the wheel over gutters / dividers / marks scrolls the panes. A press
/// on a divider elsewhere goes on to the workspace, which drags it (nvim's separator); a double
/// click there makes the panes equally wide.
fn listen(scx: &SurfaceCx, viewer: &Rc<Viewer>, pre: &Prepainted, window: &mut Window) {
    let hovered = |hits: &[Hitbox], window: &Window| hits.iter().any(|h| h.is_hovered(window));
    let regions: Vec<Hitbox> = pre
        .regions
        .iter()
        .cloned()
        .chain(pre.icon_hits.iter().cloned())
        .chain(pre.dividers.iter().cloned())
        .collect();
    let dividers = pre.dividers.clone();
    let frame = pre.frame.clone();
    let scx1 = scx.clone();
    let viewer1 = viewer.clone();
    let generation = viewer.generation;
    let regions1 = regions.clone();
    window.on_mouse_event(move |ev: &MouseDownEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble || !hovered(&regions1, window) {
            return;
        }
        let pos = ev.position;
        if let Some(icon) = frame.icon_at(pos) {
            cx.stop_propagation();
            if ev.button == MouseButton::Left {
                act(&scx1, generation, &icon.action, icon.args.clone());
            }
            return;
        }
        // a change mark in a pane's scrollbar strip: the caret to that change, that pane current
        // (WebStorm's error stripe click)
        if ev.button == MouseButton::Left
            && let Some((win, line)) = mark_at(&frame, &viewer1, pos)
        {
            cx.stop_propagation();
            act(&scx1, generation, "line", vec![win.into(), line.into()]);
            return;
        }
        if ev.button == MouseButton::Left && hovered(&dividers, window) {
            if ev.click_count == 2 {
                cx.stop_propagation();
                act(&scx1, generation, "equal", Vec::new());
            }
            return;
        }
        let Some(p) = frame.pane_at(pos) else {
            // divider / marks elsewhere: nothing to click
            cx.stop_propagation();
            return;
        };
        let line = p.rows.at(pos.y.as_f32()).map(|r| (r.line, r.folded));
        match ev.button {
            MouseButton::Right => {
                cx.stop_propagation();
                scx1.call(
                    "config.app.diff",
                    "menu",
                    vec![
                        p.win.into(),
                        line.map_or(0, |l| l.0).into(),
                        pos.x.as_f32().into(),
                        pos.y.as_f32().into(),
                    ],
                );
            }
            MouseButton::Left if p.outside_gutter => {
                cx.stop_propagation();
                if let Some((l, folded)) = line {
                    let name = if folded { "unfold" } else { "line" };
                    act(&scx1, generation, name, vec![p.win.into(), l.into()]);
                }
            }
            // the in-grid gutter: nvim's click (caret, wavy-line unfold)
            _ => {}
        }
    });
    let scx2 = scx.clone();
    let frame2 = pre.frame.clone();
    window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
        // a scroll needn't follow a mouse move: the event's own position (floats above: theirs)
        let over = regions
            .iter()
            .any(|h| h.bounds.contains(&ev.position) && h.is_hovered_at(ev.position, window));
        if phase != DispatchPhase::Bubble || !over {
            return;
        }
        // in-grid gutters: the grid scrolls as usual
        if let Some(p) = frame2.pane_at(ev.position)
            && !p.outside_gutter
        {
            return;
        }
        // the nearest pane's grid scrolls (the sync group takes the others along)
        let Some(p) = frame2.panes.iter().min_by(|a, b| {
            let d = |p: &PaneFrame| {
                let (x0, x1) = p.grid_x;
                let x = ev.position.x.as_f32();
                if x < x0 {
                    x0 - x
                } else if x > x1 {
                    x - x1
                } else {
                    0.
                }
            };
            d(a).total_cmp(&d(b))
        }) else {
            return;
        };
        cx.stop_propagation();
        let mut e = ev.clone();
        e.position.x = px((p.grid_x.0 + p.grid_x.1) / 2.);
        if let Some(ws) = scx2.workspace.upgrade() {
            let editor = ws.read(cx).editor().clone();
            editor.update(cx, |ed, cx| ed.on_scroll(&e, cx));
        }
        let _ = window;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectors_tessellate_level_and_curved() {
        let level = connector(0., 30., (10., 30.), (10., 30.)).unwrap();
        let curved = connector(0., 30., (10., 30.), (50., 90.)).unwrap();
        let wedge = connector(0., 30., (10., 10.), (50., 90.)).unwrap();
        for p in [&level, &curved, &wedge] {
            assert!(p.bounds.size.height > px(0.));
        }
    }
}
