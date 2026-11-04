//! The floats' look: WebStorm 2025.3 New UI, Islands Dark, compact density, Darcula Contrast.
//! Sources as in `crate::look` (DCS = the editor scheme, MID / EXP / DAR = theme JSONs,
//! IntelliJ class names = intellij-community sources). Logical px.

use gpui_kit::Rgba;

use crate::look::{self, hex};

// ---------------------------------------------------------------- editor text in popups

/// Code text without a syntax color (Darcula Contrast TEXT fg, nvim `Normal`).
pub const CODE_FG: crate::look::Tok = look::EDITOR_FG; // DCS TEXT fg; nvim/lua/darcula.lua fg
pub const EDITOR_FONT_SIZE: f32 = 13.0; // the editor's (JetBrains Mono 13)

// ---------------------------------------------------------------- completion (lookup)

pub const MENU_BG: crate::look::Tok = look::FLOAT_MENU_BG; // DCS LOOKUP_COLOR (LookupCellRenderer.BACKGROUND_COLOR beats the theme)
pub const MENU_BORDER: crate::look::Tok = look::POPUP_BORDER; // AbstractPopup border, MID Popup.borderColor
pub const MENU_FG: crate::look::Tok = look::FLOAT_MENU_FG; // MID "CompletionPopup.foreground"
/// Typed letters: color only, same weight.
pub const MENU_MATCH_FG: crate::look::Tok = look::FLOAT_MENU_MATCH_FG; // EXP "CompletionPopup.matchForeground"
pub const MENU_MATCH_SELECTED_FG: crate::look::Tok = look::FLOAT_MENU_MATCH_FG; // EXP "CompletionPopup.matchSelectionForeground"
/// Grayed tail (`(a, b)`) and the type text on the right.
pub const MENU_DIM_FG: crate::look::Tok = look::TEXT_DIM; // LookupCellRenderer grayed: "Label.infoForeground"
pub const MENU_SELECTION_BG: crate::look::Tok = look::SELECTION_BG; // MID "*.selectionBackground" (text keeps its color)
/// The auto-popup's selection until the user moves it (LookupFocusDegree.SEMI_FOCUSED).
pub const MENU_SELECTION_SEMI_BG: crate::look::Tok = look::SELECTION_BG_INACTIVE; // MID "CompletionPopup.selectionInactiveBackground" #393B40
/// Row height: max(font height ~18, List.rowHeight.compact 22).
pub const MENU_ROW_HEIGHT: crate::look::Met = look::LIST_ROW_HEIGHT; // UIUtil.updateListRowHeight; DAR "List.rowHeight.compact"; default 24
/// List edge -> selection rect.
pub const MENU_INSET_X: f32 = 4.0; // JBUI Popup.Selection.LEFT_RIGHT_INSET (completion: 4)
/// Selection rect edge -> icon (row content at 6, icon ipad 6 -> icon at 12 from the list edge).
pub const MENU_PAD_X: f32 = 8.0; // LookupCellRenderer: content 6 + SimpleColoredComponent ipad; icon at 12
/// Text after the icon: text at 32 (`textIndent`, the popup shifts left by it).
pub const MENU_ICON: f32 = 16.0;
pub const MENU_ICON_GAP: f32 = 4.0; // LookupCellRenderer icon-text gap (text at 32)
/// Type text right edge -> selection rect edge (type padding 10 + row content 6 - inset 4).
pub const MENU_PAD_RIGHT: f32 = 12.0;
/// Label / tail -> type text (a leading space + the tail's 10 right padding).
pub const MENU_TYPE_GAP: f32 = 18.0;
/// List padding top / bottom.
pub const MENU_PAD_Y: f32 = 4.0; // DAR "CompletionPopup.Body.insets" 4
/// List bottom padding above the advertiser strip.
pub const MENU_PAD_BOTTOM_AD: f32 = 3.0; // DAR "CompletionPopup.BodyWithAdvertiser.insets" 4,4,3,4
/// The advertiser strip under the rows (LookupUi default bottom panel): hint text + ⋮.
pub const MENU_AD_BG: crate::look::Tok = look::POPUP_AD_BG; // EXP "CompletionPopup.Advertiser.background"
pub const MENU_AD_FG: crate::look::Tok = look::TEXT_DIM; // EXP "CompletionPopup.Advertiser.foreground"
pub const MENU_AD_FONT_SIZE: f32 = 12.0; // "Popup.Advertiser.fontSizeOffset" -1
/// Height: max(text ~16, the 20 px button) + insets 2 + 2.
pub const MENU_AD_HEIGHT: f32 = 24.0;
pub const MENU_AD_PAD_L: f32 = 12.0; // DAR "CompletionPopup.Advertiser.borderInsets.compact" 2,12,2,8
pub const MENU_AD_PAD_R: f32 = 8.0;
/// The ⋮ button (and the hidden hint button's reserved width before it).
pub const MENU_AD_BUTTON: f32 = 20.0; // ActionToolbar.NAVBAR_MINIMUM_BUTTON_SIZE
pub const MENU_SELECTION_ARC: f32 = look::LIST_SELECTION_ARC; // "Popup.Selection.arc" 8 (diameter)
/// Visible rows.
pub const MENU_MAX_ROWS: usize = 11; // UISettings.maxLookupListHeight 11
/// Max width (the user's maxLookupWidth; default 500).
pub const MENU_MAX_WIDTH: f32 = 1179.0; // options/ui.lnf.xml maxLookupWidth

// ---------------------------------------------------------------- documentation popup

pub const DOC_BG: crate::look::Tok = look::FLOAT_DOC_BG; // DCS DOCUMENTATION_COLOR
pub const DOC_BORDER: crate::look::Tok = look::POPUP_BORDER;
pub const DOC_FG: crate::look::Tok = look::TEXT;
pub const DOC_DIM_FG: crate::look::Tok = look::FLOAT_DOC_DIM_FG; // DocumentationHtmlUtil section labels
pub const DOC_LINK: crate::look::Tok = look::LINK; // EXP "Link.activeForeground" (not underlined)
/// Text inset: 14 + 2 inner.
pub const DOC_PAD_X: f32 = 16.0; // DocumentationHtmlUtil contentOuterPadding 14 + contentInnerPadding 2
pub const DOC_PAD_TOP: f32 = 14.0; // top 10 + the definition's own 4
pub const DOC_PAD_BOTTOM: f32 = 10.0;
/// Paragraph spacing (CSS p padding 4 top + 4 bottom).
pub const DOC_BLOCK_GAP: f32 = 8.0;
pub const DOC_LINE_HEIGHT: f32 = 1.25; // CSS p line-height 125%
pub const DOC_MIN_WIDTH: f32 = 300.0; // DocumentationHtmlUtil: 300..500 by text length
pub const DOC_MAX_WIDTH: f32 = 500.0;
/// Wider code blocks widen the popup up to this.
pub const DOC_WIDE_MAX_WIDTH: f32 = 900.0; // DocumentationHtmlUtil.docPopupMaxWidth
/// Next to the completion list.
pub const DOC_LOOKUP_WIDTH: f32 = 450.0; // DocumentationHtmlUtil lookup docs width
pub const DOC_LOOKUP_MIN_HEIGHT: f32 = 300.0; // DocumentationHtmlUtil.lookupDocPopupMinHeight
/// Bottom-right corner toolbar (Edit Source ✏ + ⋮): 22 px buttons, 11 from the bottom, 4 from the
/// right (DocumentationPopupUI: empty(0, 0, contentOuterPadding - 3, settingsButtonPadding - 5)).
pub const DOC_CORNER_BUTTON: f32 = look::ACTION_BUTTON_SIZE;
pub const DOC_CORNER_BOTTOM: f32 = 11.0;
pub const DOC_CORNER_RIGHT: f32 = 4.0;
/// Location label under the docs (icon + file): DocumentationPopupUI.updatePaddings
/// empty(2 + spaceBeforeParagraph 4, CONTENT_PADDING 20, 2 + contentOuterPadding 14, 2 + toolbar).
pub const DOC_LOCATION_PAD_TOP: f32 = 6.0;
pub const DOC_LOCATION_PAD_L: f32 = 20.0;
pub const DOC_LOCATION_PAD_BOTTOM: f32 = 16.0;
pub const DOC_LOCATION_GAP: f32 = 6.0; // iconTextGap
pub const DOC_MAX_HEIGHT: f32 = 500.0;
pub const DOC_RULE: crate::look::Tok = look::POPUP_BORDER; // 1px separators #323438
/// Headings h1..h6.
pub const DOC_HEADING_SIZES: [f32; 6] = [21., 19., 17., 16., 15., 14.];
/// List indent: bullet / numbered.
pub const DOC_UL_INDENT: f32 = 10.0;
pub const DOC_OL_INDENT: f32 = 20.0;
pub const DOC_LIST_MARKER: f32 = 14.0;
/// Inline code: editor font 96%, a tinted background.
pub const DOC_INLINE_CODE_BG: crate::look::Tok = look::FLOAT_INLINE_CODE_BG; // Gray10 15% over the doc bg
/// Code blocks (not the definition on top): editor bg, 1px border, rounded.
pub const DOC_CODE_BG: crate::look::Tok = look::EDITOR_BG;
pub const DOC_CODE_BORDER: crate::look::Tok = look::POPUP_BORDER;
pub const DOC_CODE_ARC: f32 = 5.0; // CSS radius 10 (Swing's HTML draws it about half)
pub const DOC_CODE_PAD_Y: f32 = 10.0;
pub const DOC_CODE_PAD_X: f32 = 13.0;
pub const DOC_CODE_LINE_HEIGHT: f32 = 1.2;
/// The problem part on top of the hover (code problems): its own band.
pub const DOC_PROBLEM_BG: crate::look::Tok = look::POPUP_BG; // MID "Popup.background" (Info style, every severity)
pub const DOC_PROBLEM_FG: crate::look::Tok = look::SELECTION_TEXT;
/// LineTooltipRenderer pane border: empty(10, CONTENT_PADDING 20, bottom, 12); bottom 10 without
/// the actions row, 3 above it (no separators).
pub const DOC_PROBLEM_PAD_L: f32 = 20.0;
pub const DOC_PROBLEM_PAD_R: f32 = 12.0;
pub const DOC_PROBLEM_PAD_TOP: f32 = 10.0;
pub const DOC_PROBLEM_PAD_BOTTOM: f32 = 10.0;
pub const DOC_PROBLEM_PAD_BOTTOM_ACTIONS: f32 = 3.0;
/// The ⋮ (Show Quick Fixes) right of the problems: 20 px, insets(9, 7, 0, 9)
/// (DaemonTooltipWithActionRenderer settingsButtonPadding).
pub const DOC_PROBLEM_MORE: f32 = 20.0;
pub const DOC_PROBLEM_MORE_TOP: f32 = 9.0;
pub const DOC_PROBLEM_MORE_L: f32 = 7.0;
pub const DOC_PROBLEM_MORE_R: f32 = 9.0;
/// Actions row: "<fix>" ⌥⇧⏎  "More actions…" ⌥⏎ (addActionsRow): tooltip font - 1, insets top 5,
/// bottom 10, fix at CONTENT_PADDING 20, gaps 4 / 12 / 4.
pub const DOC_ACTIONS_FONT_SIZE: f32 = 12.0;
pub const DOC_ACTIONS_PAD_TOP: f32 = 5.0;
pub const DOC_ACTIONS_PAD_BOTTOM: f32 = 10.0;
pub const DOC_ACTIONS_PAD_L: f32 = 20.0;
pub const DOC_ACTIONS_KEY_GAP: f32 = 4.0;
pub const DOC_ACTIONS_GAP: f32 = 12.0;
pub const DOC_ACTIONS_LINK: crate::look::Tok = look::LINK; // EXP "Link.activeForeground"
pub const DOC_ACTIONS_KEY_FG: crate::look::Tok = look::TEXT_DIM; // EXP "ToolTip.Actions.infoForeground"
pub const DOC_SELECTION_BG: crate::look::Tok = look::EDITOR_SELECTION_BG; // DCS SELECTION_BACKGROUND (text selection in docs)

// ---------------------------------------------------------------- parameter info

pub const SIGNATURE_BG: crate::look::Tok = look::EDITOR_BG; // ParameterInfoComponent: editor bg
pub const SIGNATURE_BORDER: crate::look::Tok = look::FLOAT_SIGNATURE_BORDER; // editor bg blended 10% to gray
pub const SIGNATURE_FG: crate::look::Tok = CODE_FG; // editor fg; current parameter bold
pub const SIGNATURE_ARC: f32 = 4.0; // tooltip radius
pub const SIGNATURE_PAD_X: f32 = 12.0; // ParameterInfoComponent border 6,12,6,12
pub const SIGNATURE_PAD_Y: f32 = 6.0;
/// Per signature row: 3 vertical (compact), 8 horizontal.
pub const SIGNATURE_ROW_PAD_Y: f32 = 3.0;
pub const SIGNATURE_ROW_PAD_X: f32 = 8.0;
/// The current overload among several (WS blends the editor bg with a base color not fetched:
/// kept as measured earlier).
pub const SIGNATURE_ACTIVE_BG: crate::look::Tok = look::FLOAT_SIGNATURE_ACTIVE_BG;
/// "Switch with ⌃↑ or ⌃↓" under several overloads: emptyTop(10), "ParameterInfo.infoForeground".
pub const SIGNATURE_HINT_FG: Rgba = hex(0xCED0D6);
pub const SIGNATURE_HINT_GAP: f32 = 10.0;

// ---------------------------------------------------------------- quick definition

/// Header band (file icon + path, "line N", ◀ ▶ ⋮): toolbarPanel empty(3) around the single entry
/// panel empty(4, 3) with a 16 px label (or 22 px toolbar buttons): 30.
pub const PEEK_HEADER_BG: crate::look::Tok = look::PANEL_BG; // ImplementationViewComponent header: panel bg
pub const PEEK_HEADER_FG: crate::look::Tok = look::TEXT; // unchanged files (else the VCS status color)
pub const PEEK_HEADER_DIM: crate::look::Tok = look::TEXT_DIM;
pub const PEEK_HEADER_HEIGHT: f32 = 30.0;
pub const PEEK_HEADER_PAD_X: f32 = 6.0; // 3 + 3
pub const PEEK_HEADER_GAP: f32 = 4.0; // JLabel iconTextGap
pub const PEEK_BUTTON: f32 = look::ACTION_BUTTON_SIZE; // switcher ◀ ▶ + ⋮
pub const PEEK_HEADER_PAD_R: f32 = 3.0; // toolbarPanel empty(3)
/// Frame around the code grid (the body's padding, in the body color).
pub const PEEK_PAD: f32 = 6.0; // ImplementationViewComponent editor empty(12, 6): sides
pub const PEEK_PAD_Y: f32 = 12.0; // ditto: top / bottom (the grid starts at least this below the header)
