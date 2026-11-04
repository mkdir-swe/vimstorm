//! Paints one row of the commit graph like WebStorm (IntelliJ vcs-log `SimpleGraphCellPainter` +
//! `HeadNodePainter`, Apache-2.0, see app/NOTICE): each [`EdgePart`] is a line from the element's
//! lane center at the row's middle to the row's top / bottom edge, halfway to the lane it reaches
//! in the neighbouring row (so the two halves meet at the boundary); arrows on cut long edges;
//! the commit node a filled circle, HEAD's a ring with a dot (filled circle, row background,
//! smaller filled circle).

use gpui_kit::{Bounds, PathBuilder, Pixels, Point, Rgba, Window, fill, point, px, size};

use crate::git::graph::{EdgePart, GraphRow};
use crate::look;

/// IntelliJ `SimpleGraphCellPainter`: arrow wings at cos² 0.7 of the line, 0.3 row heights long.
const ARROW_ANGLE_COS2: f32 = 0.7;
const ARROW_LENGTH: f32 = 0.3;

fn rgb(c: u32) -> Rgba {
    look::hex(c)
}

/// The x of a (possibly fractional) lane's center.
fn lane_x(origin: Point<Pixels>, lane: f32) -> Pixels {
    origin.x + px(lane * look::VCS_LOG_LANE_WIDTH + look::VCS_LOG_LANE_CENTER)
}

/// The width the row's graph takes (its lanes).
pub fn width(row: &GraphRow) -> f32 {
    row.width.max(1) as f32 * look::VCS_LOG_LANE_WIDTH
}

fn line(window: &mut Window, a: Point<Pixels>, b: Point<Pixels>, color: Rgba, w: f32) {
    let mut p = PathBuilder::stroke(px(w));
    p.move_to(a);
    p.line_to(b);
    if let Ok(path) = p.build() {
        window.paint_path(path, color);
    }
}

/// Arrow head at `tip`, pointing away from `from`.
fn arrow(
    window: &mut Window,
    from: Point<Pixels>,
    tip: Point<Pixels>,
    color: Rgba,
    h: f32,
    w: f32,
) {
    let (dx, dy) = ((tip.x - from.x).as_f32(), (tip.y - from.y).as_f32());
    let len = (dx * dx + dy * dy).sqrt();
    if len == 0. {
        return;
    }
    // unit vector back from the tip, rotated by ±angle
    let (ux, uy) = (-dx / len, -dy / len);
    let cos = ARROW_ANGLE_COS2.sqrt();
    let sin = (1. - ARROW_ANGLE_COS2).sqrt();
    let l = ARROW_LENGTH * h;
    for s in [1., -1.] {
        let rx = ux * cos - s * uy * sin;
        let ry = s * ux * sin + uy * cos;
        line(
            window,
            tip,
            point(tip.x + px(rx * l), tip.y + px(ry * l)),
            color,
            w,
        );
    }
}

fn circle(window: &mut Window, c: Point<Pixels>, d: f32, color: Rgba) {
    let r = px(d / 2.);
    window.paint_quad(
        fill(
            Bounds::new(point(c.x - r, c.y - r), size(px(d), px(d))),
            color,
        )
        .corner_radii(r),
    );
}

fn edge(window: &mut Window, origin: Point<Pixels>, h: f32, e: &EdgePart) {
    let color = rgb(e.color);
    let w = look::VCS_LOG_LINE_WIDTH;
    let mid_y = origin.y + px(h / 2.);
    let start = point(lane_x(origin, e.from as f32), mid_y);
    let end_y = if e.up { origin.y } else { origin.y + px(h) };
    let end = point(lane_x(origin, (e.from as f32 + e.to as f32) / 2.), end_y);
    line(window, start, end, color, w);
    if e.arrow || e.terminal {
        arrow(window, start, end, color, h, w);
    }
}

/// Paints `row` with its top-left at `origin`, `h` high. `head`: the HEAD commit (ring node);
/// `bg`: the row's background (the ring's hole).
pub fn paint_row(
    window: &mut Window,
    origin: Point<Pixels>,
    h: f32,
    row: &GraphRow,
    head: bool,
    bg: Rgba,
) {
    for e in &row.edges {
        edge(window, origin, h, e);
    }
    let c = point(lane_x(origin, row.node as f32), origin.y + px(h / 2.));
    let color = rgb(row.color);
    if head {
        circle(window, c, look::VCS_LOG_HEAD_OUTER, color);
        circle(window, c, look::VCS_LOG_HEAD_RING, bg);
        circle(window, c, look::VCS_LOG_HEAD_DOT, color);
    } else {
        circle(window, c, look::VCS_LOG_NODE_DIAMETER, color);
    }
}
