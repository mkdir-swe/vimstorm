//! Drawing nvim's grids in GPUI: fonts, cell metrics, the grid element, sprite glyphs.

mod fonts;
mod grid;
mod metrics;
mod sprites;

pub(crate) use fonts::{
    EDITOR_FONT, FontName, cell_font, editor_features, editor_font, set_families, set_ligatures,
};
pub use fonts::{UI_FONT, load_fonts, ui_font, warm_up};
pub use grid::GridHost;
pub(crate) use grid::{GridElement, paint_sprite};
pub use metrics::editor_font_size;
pub(crate) use metrics::{CellMetrics, FONT_SIZE, scaled, set_editor_font_size};
pub(crate) use sprites::{Shape, sprite};
