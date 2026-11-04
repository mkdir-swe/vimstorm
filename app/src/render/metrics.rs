//! Cell geometry: JetBrains Mono 13 px, 22 px rows (WebStorm's line height 1.2 at 13), cell
//! width = the font's advance.

use gpui_kit::{App, Bounds, Global, Pixels, Point, Size, Window, point, px, size};

use super::fonts::editor_font;

pub const FONT_SIZE: f32 = 13.0;
pub const ROW_HEIGHT: f32 = 22.0;
/// Font size limits for View > Increase / Decrease Font Size.
pub const MIN_FONT_SIZE: f32 = 8.0;
pub const MAX_FONT_SIZE: f32 = 36.0;
/// JetBrains Mono's advance width in em.
const NOMINAL_ADVANCE: f32 = 0.6;

/// The editor font size of this app run (`crate::app`: Ctrl+Cmd+= / -, Cmd+0, as Ghostty
/// did): nvim's grids and the terminal. Not saved (Ghostty didn't). Unset: [`FONT_SIZE`].
#[derive(Clone, Copy, Debug)]
struct EditorFontSize(f32);

impl Global for EditorFontSize {}

/// The current editor font size.
pub fn editor_font_size(cx: &App) -> f32 {
    cx.try_global::<EditorFontSize>().map_or(FONT_SIZE, |s| s.0)
}

/// Sets the editor font size (clamped, whole points). Returns whether it changed; the editor and
/// the terminal re-measure their cells on their next render.
pub fn set_editor_font_size(size: f32, cx: &mut App) -> bool {
    let size = size.round().clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
    if size == editor_font_size(cx) {
        return false;
    }
    cx.set_global(EditorFontSize(size));
    true
}

/// A row height (or other vertical metric) measured at [`FONT_SIZE`], at `font_size`: the line
/// spacing stays WebStorm's 1.2 x the font + the same gap, in whole px.
pub fn scaled(base: f32, font_size: f32) -> f32 {
    (base * font_size / FONT_SIZE).round()
}

/// JetBrains Mono's line (hhea ascent 1020 + descent 300 per 1000 units) per px of font size.
pub const EDITOR_FONT_LINE: f32 = 1.32;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CellMetrics {
    pub font_size: Pixels,
    pub cell_width: Pixels,
    pub row_height: Pixels,
    /// The editor font's [`super::fonts::generation`] it was measured at.
    pub fonts: u32,
}

impl CellMetrics {
    /// Measures the editor font at `size` ([`editor_font_size`]; needs the bundled fonts loaded).
    pub fn measure(window: &Window, size: f32) -> Self {
        let ts = window.text_system();
        let id = ts.resolve_font(&editor_font(false, false));
        let cell_width = ts.advance(id, px(size), 'm').map(|s| s.width);
        CellMetrics {
            cell_width: cell_width.unwrap_or(px(size * NOMINAL_ADVANCE)),
            ..Self::nominal(size)
        }
    }

    /// The metrics before GPUI runs (startup attaches nvim right after spawning it): JetBrains
    /// Mono's advance is 600 / 1000 em, what [`Self::measure`] gets from the font.
    pub fn nominal(size: f32) -> Self {
        CellMetrics {
            font_size: px(size),
            cell_width: px(size * NOMINAL_ADVANCE),
            row_height: px(scaled(ROW_HEIGHT, size)),
            fonts: super::fonts::generation(),
        }
    }

    /// Whether these are the cells of the editor font at `size` as it is now (a look may have
    /// changed its family or ligatures since: measure again).
    pub fn is_current(&self, size: f32) -> bool {
        self.font_size == px(size) && self.fonts == super::fonts::generation()
    }

    /// Whole cells fitting in `area` (at least 1x1).
    pub fn cols_rows(&self, area: Size<Pixels>) -> (usize, usize) {
        let cols = (area.width / self.cell_width).floor().max(1.0) as usize;
        let rows = (area.height / self.row_height).floor().max(1.0) as usize;
        (cols, rows)
    }

    /// Top-left of screen cell (row, col) for a grid drawn at `origin`.
    pub fn cell_origin(&self, origin: Point<Pixels>, row: i64, col: i64) -> Point<Pixels> {
        point(
            origin.x + self.cell_width * col as f32,
            origin.y + self.row_height * row as f32,
        )
    }

    /// Bounds of `cols` cells starting at screen cell (row, col).
    pub fn cell_bounds(
        &self,
        origin: Point<Pixels>,
        row: i64,
        col: i64,
        cols: usize,
    ) -> Bounds<Pixels> {
        Bounds::new(
            self.cell_origin(origin, row, col),
            size(self.cell_width * cols as f32, self.row_height),
        )
    }

    /// The editor caret's height (block and bar): the font's line (ascent + descent), centred in
    /// the row on whole px, like WebStorm's (30.png: 18.4 incl. antialiasing in the 22 px row).
    pub fn caret_height(&self) -> Pixels {
        let row = self.row_height.as_f32();
        let line = self.font_size.as_f32() * EDITOR_FONT_LINE;
        let margin = ((row - line) / 2.).round().max(0.);
        px(row - 2. * margin)
    }

    /// Screen cell (row, col) under a window position (may be outside the grid).
    pub fn cell_at(&self, origin: Point<Pixels>, pos: Point<Pixels>) -> (i64, i64) {
        let row = ((pos.y - origin.y) / self.row_height).floor() as i64;
        let col = ((pos.x - origin.x) / self.cell_width).floor() as i64;
        (row, col)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> CellMetrics {
        CellMetrics {
            font_size: px(13.0),
            cell_width: px(7.8),
            row_height: px(22.0),
            ..Default::default()
        }
    }

    #[test]
    fn cells_fit_whole_and_map_back() {
        let m = m();
        assert_eq!(m.cols_rows(size(px(800.0), px(600.0))), (102, 27));
        let o = point(px(10.0), px(5.0));
        let p = m.cell_origin(o, 3, 4);
        assert_eq!(m.cell_at(o, p + point(px(1.0), px(1.0))), (3, 4));
        assert_eq!(m.cell_at(o, point(px(9.0), px(4.0))), (-1, -1));
    }

    #[test]
    fn caret_is_the_font_line_centred_in_the_row() {
        assert_eq!(m().caret_height(), px(18.0));
        let big = CellMetrics {
            font_size: px(20.0),
            cell_width: px(12.0),
            row_height: px(scaled(ROW_HEIGHT, 20.0)),
            ..Default::default()
        };
        // 26.4 in a 34 px row: 4 px above and below
        assert_eq!(big.caret_height(), px(26.0));
    }

    #[test]
    fn rows_scale_with_the_font_in_whole_px() {
        assert_eq!(scaled(ROW_HEIGHT, FONT_SIZE), ROW_HEIGHT);
        assert_eq!(scaled(ROW_HEIGHT, 14.0), 24.0);
        assert_eq!(scaled(ROW_HEIGHT, 12.0), 20.0);
        assert_eq!(scaled(18.0, 14.0), 19.0);
    }
}
