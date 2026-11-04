//! WebStorm's markdown preview look: its preview CSS (markdown.jar `baseStyles/default.css` +
//! the generated `colors.css` for Islands Dark / Darcula Contrast; resolved in
//! `.scratch/M4_WS_LOOK.md`, the concatenated sheet in `.scratch/m4ref/md/ws-preview.css`).
//! Sizes are CSS px at the 13 px base (`--default-font-size` = the editor font size).

use gpui_kit::Rgba;

use crate::look::{self, hex};

/// `body { font-family: Helvetica, Arial, freesans, sans-serif }` (macOS has Helvetica).
pub const BODY_FONT: &str = "Helvetica";
/// `code, pre, kbd { font: … "JetBrains Mono" }`.
pub const CODE_FONT: &str = "JetBrains Mono";
/// `--default-font-size: 13px` (the editor font size).
pub const BODY_SIZE: f32 = 13.0;
/// `body { line-height: 1.6 }`.
pub const BODY_LINE: f32 = 1.6;
/// `body { margin: 0 2em }`.
pub const BODY_MARGIN_X: f32 = 26.0;
/// Darcula Contrast TEXT fg / bg.
pub const FG: crate::look::Tok = look::EDITOR_FG;
pub const BG: crate::look::Tok = look::EDITOR_BG;
/// `a { color: Link.activeForeground }`.
pub const LINK: crate::look::Tok = look::LINK;
/// `h6 { color: Component.infoForeground }`.
pub const H6_FG: crate::look::Tok = look::TEXT_DIM;
/// `p, blockquote, ul, ol, dl, table, pre { margin: 16px 0 }`.
pub const BLOCK_MARGIN: f32 = 16.0;
/// `hr { height: 1px; margin: 20px 0; background: Group.separatorColor }`.
pub const HR_MARGIN: f32 = 20.0;
pub const SEPARATOR: crate::look::Tok = look::SEPARATOR;
/// `blockquote, code, pre { background-color: rgba(212, 222, 231, 0.098) }`.
pub const CODE_BG: crate::look::Tok = look::MD_CODE_BG;
/// `<ins>`: a spec edit's new words (D-26, `.vs-spec__ins`: the diff's inserted colour).
pub const INS_BG: crate::look::Tok = look::DIFF_INSERTED_BG;
/// `code { font-size: 0.9em; padding: 0.2em 0.4em; margin: 2px; border-radius: 3px }`: GPUI text
/// runs share one size, so inline code uses JetBrains Mono with its glyphs scaled to 90 %
/// (assets/fonts/JetBrainsMonoInline-*.ttf, same line metrics).
pub const INLINE_CODE_FONT: &str = "JetBrains Mono Inline";
/// `pre { font-size: 0.85em; line-height: 1.45; padding: 16px; border-radius: 3px }`.
pub const PRE_SIZE: f32 = 11.05;
pub const PRE_LINE: f32 = 1.45;
pub const PRE_PAD: f32 = 16.0;
pub const RADIUS: f32 = 3.0;
/// The fence's hover copy button: inset from its top-left corner (approx copy-button.css).
pub const COPY_INSET: f32 = 4.0;
/// `kbd { border: 1px solid Group.separatorColor }` (the rest like inline code).
pub const KBD_BORDER: crate::look::Tok = look::SEPARATOR;
/// `blockquote { padding: 10px 10px 10px 16px; border-left: 2px solid rgba(107,155,250,.4) }`.
pub const QUOTE_PAD: (f32, f32, f32, f32) = (10.0, 10.0, 10.0, 16.0);
pub const QUOTE_BORDER: f32 = 2.0;
pub const QUOTE_BORDER_COLOR: crate::look::Tok = look::MD_QUOTE_BORDER;
/// `ul, ol { padding-left: 2em }`.
pub const LIST_INDENT: f32 = 26.0;
/// `.task-list-item + .task-list-item { margin-top: 3px }`.
pub const TASK_GAP: f32 = 3.0;
/// `table th, table td { padding: 6px 13px; border: 1px solid Group.separatorColor }`.
pub const CELL_PAD_X: f32 = 13.0;
pub const CELL_PAD_Y: f32 = 6.0;
/// Chromium's `::selection` on a dark page: the editor's selection colour (DCS SELECTION_BACKGROUND).
pub const SELECTION_BG: crate::look::Tok = look::EDITOR_SELECTION_BG;
/// Chromium's disabled checkbox (`<input type=checkbox disabled>`, light controls: no
/// `color-scheme` in the page): light grey box, grey check, 13 px.
pub const CHECKBOX_SIZE: f32 = 12.5;
pub const CHECKBOX_BG: Rgba = hex(0x9F9F9F);
pub const CHECKBOX_MARK: Rgba = hex(0xD8D8D8);
/// Unchecked: a lighter box in the checked one's grey border (sampled, m4-ws-md-reference.png).
pub const CHECKBOX_OPEN_BG: Rgba = hex(0xB0B0B1);
/// `vertical-align: middle` + `margin-bottom: 0.25em`: below the line box's centre.
pub const CHECKBOX_DROP: f32 = 0.0;
/// `.task-list-item input { margin: 0 0.35em 0.25em -0.6em }`.
pub const CHECKBOX_MARGIN_LEFT: f32 = -7.8;
pub const CHECKBOX_MARGIN_RIGHT: f32 = 4.55;
/// Scroll step of the arrow keys / ö / l (Chromium: 40 px).
pub const KEY_STEP: f32 = 40.0;
/// WebKit scrollbar (JBCefScrollbarsHelper, mac): 14 px track, thumb inset 3 px (8 px), radius
/// 7, `rgba(128,128,128,0.349)` (hover 0.549).
pub const SCROLLBAR_TRACK: f32 = 14.0;
pub const SCROLLBAR_INSET: f32 = 3.0;
pub const SCROLLBAR_THUMB: crate::look::Tok = look::SCROLLBAR_THUMB;
pub const SCROLLBAR_THUMB_HOVER: crate::look::Tok = look::SCROLLBAR_THUMB_HOVER;
/// OnePixelSplitter between editor and preview: `PREVIEW_BORDER_COLOR` -> Panel.background.
pub const DIVIDER: crate::look::Tok = look::PANEL_BG;

/// Heading look: (font size, line height factor, margin-top, padding-top); margin-bottom is 16.
pub fn heading(level: u8) -> (f32, f32, f32, f32) {
    match level {
        1 => (28.6, 1.4, 28.6, 17.16),
        2 => (23.4, 1.2, 23.4, 14.04),
        3 => (16.9, 1.0, 16.9, 10.14),
        _ => (13.0, 1.4, 13.0, 0.0),
    }
}

/// Abe object details use the native UI hierarchy without changing editor previews.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Profile {
    #[default]
    Preview,
    AbeDetail,
}

impl Profile {
    pub fn margin_x(self) -> f32 {
        match self {
            Self::Preview => BODY_MARGIN_X,
            Self::AbeDetail => 0.,
        }
    }

    pub fn heading(self, level: u8) -> (f32, f32, f32, f32) {
        match self {
            Self::Preview => heading(level),
            Self::AbeDetail => (if level <= 2 { 14. } else { 13. }, 1.4, 8., 0.),
        }
    }

    pub fn block_margin(self) -> f32 {
        match self {
            Self::Preview => BLOCK_MARGIN,
            Self::AbeDetail => 8.,
        }
    }
}
