//! WebStorm New UI "Islands Dark" chrome: colors + metrics.
//!
//! Values replicate the user's real setup (WebStorm 2025.3, Islands Dark LaF,
//! `UI_DENSITY=COMPACT` in `options/ui.lnf.xml`, editor scheme "Darcula Contrast").
//! Metrics are LOGICAL px (GPUI px; 1 logical = 2 device px on Retina). Where compact
//! differs from default density, the default is noted as `default N`.
//!
//! Source abbreviations used in comments:
//! - `MID`  = `themes/islands/ManyIslandsDark.theme.json` (WebStorm `lib/app.jar`); palette
//!   refs resolved via its `colors` block, then parent `EXP`'s palette.
//! - `EXP`  = `themes/expUI/expUI_dark.theme.json` (parentTheme of MID, `ExperimentalDark`).
//! - `DAR`  = `themes/darcula.theme.json` (parentTheme of EXP; source of `*.compact` keys).
//! - `EXPS` = `themes/expUI/expUI_darkScheme.xml`; `DCS` = `expUI_darculaContrastScheme.xml`.
//! - `JBUI` = intellij-community `platform/util/ui/.../JBUI.java` (`CurrentTheme.*` defaults);
//!   other `*.kt`/`*.java` names are intellij-community master files.
//! - `30.png` = user screenshot, Display-P3, scale 1.4405 img px per logical px
//!   (tree row 31.69px / 22, git-log row 34.6px / 24). It shows Distraction-Free mode.
//!
//! Arc notes: Swing `arc` values are diameters; consts named `*_ARC` here are RADII.
//!
//! Some consts have no user yet: measured WS reference values (with their source) kept next to
//! the ones in use for the surfaces / states that will need them, not dead code to prune.

use gpui_kit::{Hsla, Rgba};

pub use density::Met;
pub use palette::Tok;

/// 0xRRGGBB -> Rgba (const).
pub const fn hex(rgb: u32) -> Rgba {
    Rgba {
        r: ((rgb >> 16) & 0xff) as f32 / 255.0,
        g: ((rgb >> 8) & 0xff) as f32 / 255.0,
        b: (rgb & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

/// 0xRRGGBBAA -> Rgba (const).
pub const fn hexa(rgba: u32) -> Rgba {
    Rgba {
        r: ((rgba >> 24) & 0xff) as f32 / 255.0,
        g: ((rgba >> 16) & 0xff) as f32 / 255.0,
        b: ((rgba >> 8) & 0xff) as f32 / 255.0,
        a: (rgba & 0xff) as f32 / 255.0,
    }
}

/// Rgba -> Hsla (non-const convenience).
pub fn hsla(c: Rgba) -> Hsla {
    c.into()
}

// ---------------------------------------------------------------- frame / islands

/// Window bg + gaps between islands + title bar.
pub const FRAME_BG: Tok = Tok(0); // MID "MainWindow.background"=BackgroundLight=Gray1.5; 30.png exact
/// Island bg (project tree, tool windows).
pub const PANEL_BG: Tok = Tok(1); // MID "ToolWindow.background"=Gray0.75; 30.png exact
/// Editor text area bg.
pub const EDITOR_BG: Tok = Tok(2); // DCS TEXT bg (user scheme); 30.png exact. (Islands scheme: 0x191A1C)
pub const EDITOR_FG: Tok = Tok(3); // DCS TEXT fg (plain text); nvim/lua/darcula.lua fg
pub const EDITOR_SELECTION_BG: Tok = Tok(4); // DCS SELECTION_BACKGROUND
pub const EDITOR_CARET_ROW_BG: Tok = Tok(5); // DCS CARET_ROW_COLOR; 30.png exact
pub const EDITOR_LINE_NUMBER: Tok = Tok(6); // DCS LINE_NUMBERS_COLOR; 30.png ~0x505257
pub const EDITOR_LINE_NUMBER_CURRENT: Tok = Tok(7); // DCS LINE_NUMBER_ON_CARET_ROW_COLOR
/// Code splits draw their text columns this much left of nvim's cells: the statuscolumn (number,
/// bookmark cell, 2 sign cells) is whole cells, WebStorm's number -> code gap is 21 px, not 25.
pub const GUTTER_TRIM: f32 = 3.8; // measured 30.png: island edge -> code 44.5 (ours 48.3), number ink end 23.5 (ours 23.0)
/// Island corner radius.
pub const ISLAND_ARC: Met = Met(0); // MID "Island.arc.compact" 16 -> r=arc/2 (IslandsUICustomization.paintIslandAreaRaw); default 10; 30.png corner ~8
/// Visible frame-colored gap between two islands.
pub const ISLAND_GAP: Met = Met(1); // MID "Island.borderWidth.compact" 4 -> 2/side minus 1px outline; 30.png 4.3px/1.4405=3.0; default 5
/// Gap between islands and window edges (0 in Distraction-Free mode, as in 30.png).
pub const ISLAND_EDGE_GAP: f32 = 4.0; // IslandsUICustomization "Islands.emptyGap" default 4
/// The Editor's right Chat column (2.1 design tokens: "Chat column 420 px", board W-Editor).
pub const CHAT_COLUMN_WIDTH: f32 = 420.0;
/// 1px outline drawn just inside each island edge (only visible on the editor island).
pub const ISLAND_BORDER: Tok = Tok(8); // MID "Island.borderColor"=ToolWindowBackground; 30.png x707 on editor
pub const ISLAND_BORDER_WIDTH: f32 = 1.0; // paintIslandAreaRaw drawLine/drawArc (1px)
/// Island visible edge -> content (tree/header) inset.
pub const ISLAND_CONTENT_INSET: Met = Met(2); // "Island.ToolWindow.insets" 3 - borderWidth.compact/2 2; default 0
/// Generic 1px component borders.
pub const BORDER: Tok = Tok(9); // MID "Borders.color"=BorderDark; 30.png git-log splitter ~0x272A2D
pub const SEPARATOR: Tok = Tok(10); // MID "*.separatorColor"/"OnePixelDivider.background"=BorderLight=Gray2.5
pub const SEPARATOR_WIDTH: f32 = 1.0; // OnePixelDivider

// ---------------------------------------------------------------- text

pub const TEXT: Tok = Tok(11); // MID "*.foreground"=ForegroundDefault; 30.png mode ~0xD8 (+overshoot) fits
/// Secondary text: "library root", "~/path" after root name, ref labels.
pub const TEXT_DIM: Tok = Tok(12); // EXP "*.infoForeground"=Gray7; 30.png p90 0x777B82 (gitref calib 0x6F737A->0x777A80)
pub const TEXT_DISABLED: Tok = Tok(13); // EXP "*.disabledForeground"=Gray6
pub const TEXT_ERROR: Tok = Tok(14); // EXP "Label.errorForeground"=Red7
pub const TEXT_WARNING: Tok = Tok(15); // EXP "Label.warningForeground"=Yellow5
/// Done / installed (Abe Settings' ✓): the Plugins page's "installed" green.
pub const TEXT_SUCCESS: Tok = Tok(16); // EXP "Plugins.Button.installForeground"=Green7
pub const LINK: Tok = Tok(17); // EXP "Link.activeForeground"=Blue9

// ---------------------------------------------------------------- list / tree selection

/// Focused list/tree selection.
pub const SELECTION_BG: Tok = Tok(18); // MID "*.selectionBackground"=SelectionActive=Blue2
/// Unfocused list/tree selection.
pub const SELECTION_BG_INACTIVE: Tok = Tok(19); // MID "*.selectionInactiveBackground"=Gray3; 30.png "assets" exact
pub const SELECTION_TEXT: Tok = Tok(20); // EXP "*.selectionForeground"=Gray12 (file-status colors keep their fg)
/// Row hover (painted for trees/lists unless disabled; RenderingUtil.getHoverBackground).
pub const HOVER_BG: Tok = Tok(21); // MID "*.hoverBackground"=HoverBackgroundMid=Gray3
pub const SELECTION_ARC: f32 = 4.0; // JBUI Tree.ARC "Tree.Selection.arc" 8 (diameter)
/// Selection rect inset from tree component edge (each side).
pub const SELECTION_INSET_X: f32 = 12.0; // DefaultTreeUI.HORIZONTAL_SELECTION_OFFSET; 30.png 13.5 from island edge (=1+12)

// ---------------------------------------------------------------- speed search

/// Speed-search match highlight behind matched chars (lists/trees).
pub const SEARCH_MATCH_BG: Tok = Tok(22); // EXP "SearchMatch.startBackground"/endBackground=Yellow5
pub const SEARCH_MATCH_FG: Tok = Tok(23); // SimpleColoredComponent: JBColor(Gray._50, Gray._0) dark=black
pub const SEARCH_MATCH_ARC: f32 = 2.5; // UIUtil.drawSearchMatch RoundRectangle arc 5 (diameter)
pub const SEARCH_MATCH_INSET_Y: f32 = 2.0; // UIUtil.drawSearchMatch y=2, h=height-4
/// Small speed-search popup ("Search for: ...").
pub const SPEED_SEARCH_BG: Tok = Tok(24); // MID "SpeedSearch.background"=BackgroundDark
pub const SPEED_SEARCH_BORDER: Tok = Tok(25); // MID "SpeedSearch.borderColor"=BorderLight
pub const SPEED_SEARCH_FG: Tok = Tok(26); // MID "*.foreground" (SpeedSearch.foreground)
pub const SPEED_SEARCH_ERROR_FG: Tok = Tok(27); // EXP "SpeedSearch.errorForeground"=Red7

// ---------------------------------------------------------------- file colors (tree row tints)

/// Excluded dirs + library roots (node_modules, .turbo, .claude): "Non-Project Files" scope = Yellow.
pub const EXCLUDED_ROW_BG: Tok = Tok(28); // MID "FileColor.Yellow"; 30.png 0x271F1C = P3 of 0x291F1C
// File-color rows span full tree width (not inset, not rounded): 30.png x4..700.

// ---------------------------------------------------------------- tree metrics

pub const TREE_ROW_HEIGHT: Met = Met(3); // DAR "Tree.rowHeight.compact" 22; default 24 (EXP); 30.png 31.69/1.4405
/// Chevron control (icon) width.
pub const TREE_CHEVRON_SIZE: f32 = 16.0; // EXP Tree.collapsedIcon expui/general/chevronRight.svg 16x16
pub const TREE_LEFT_CHILD_INDENT: f32 = 8.0; // ClassicPainter max(chevron/2=8, DAR "Tree.leftChildIndent" 7)
pub const TREE_RIGHT_CHILD_INDENT: f32 = 11.0; // DAR "Tree.rightChildIndent"
/// Per depth level.
pub const TREE_INDENT: f32 = TREE_LEFT_CHILD_INDENT + TREE_RIGHT_CHILD_INDENT; // 19; 30.png chevrons 27.5px/1.4405=19.09
/// Chevron left -> renderer left (child rows).
pub const TREE_CHEVRON_TO_RENDERER: f32 = 19.0; // ClassicPainter max(16+GAP 2, left+right 19); 30.png icon x matches
/// Renderer left -> icon left.
pub const TREE_RENDERER_PAD_X: f32 = 2.0; // SimpleColoredComponent ipad (1,2)
/// Tree content inset (root chevron x from tree edge).
pub const TREE_PAD_X: Met = Met(4); // MID "Tree.border.compact" 2,8,2,8; default 12 (EXP "Tree.border" 4,12,4,12)
pub const TREE_PAD_Y: Met = Met(5); // MID "Tree.border.compact" top/bottom; default 4
/// Icon right -> text origin.
pub const TREE_ICON_GAP: f32 = 2.0; // SimpleColoredComponent.myIconTextGap 2; gallery vs 30.png: text x matches at 2 (3 was 1.4px right)
pub const ICON_SIZE: f32 = 16.0; // expui icons 16x16; 30.png folder glyph 21px/1.4405=14.6 in 16 box

// ---------------------------------------------------------------- tool window header

pub const TOOL_WINDOW_HEADER_HEIGHT: Met = Met(6); // DAR "ToolWindow.Header.height.compact"; default 41 (JBUI defaultHeaderHeight); 30.png ~32
pub const TOOL_WINDOW_HEADER_PAD_X: f32 = 12.0; // JBUI ToolWindow.headerLabelLeftRightInsets (0,12,0,16); 30.png "Project" at 12

// ---------------------------------------------------------------- lists / popups

pub const LIST_ROW_HEIGHT: Met = Met(7); // DAR "List.rowHeight.compact" 22; default 24 (EXP "List.rowHeight")
/// Popup list selection rect inset from popup edge.
pub const LIST_ROW_INSET_X: f32 = 8.0; // JBUI Popup.Selection.LEFT_RIGHT_INSET "Popup.Selection.leftRightInset" 8
/// Text/icon inset inside the selection rect.
pub const LIST_ROW_PADDING_X: f32 = 8.0; // JBUI Popup.Selection.innerInsets (0,8)
pub const LIST_SELECTION_ARC: f32 = 4.0; // JBUI "Popup.Selection.arc" 8 (diameter)
pub const POPUP_BG: Tok = Tok(29); // MID "Popup.background"=PopupBackground=Gray1.5
pub const POPUP_BORDER: Tok = Tok(30); // MID "Popup.borderColor"=PopupBorder=Gray2.5
pub const POPUP_BORDER_WIDTH: f32 = 1.0; // JBUI Popup.borderWidth "Popup.borderWidth" 1
pub const POPUP_ARC: f32 = 8.0; // IdeaPopupMenuUI.CORNER_RADIUS "PopupMenu.borderCornerRadius" 8 (mac window radius)
pub const POPUP_SHADOW: Tok = Tok(31); // EXP "Ide.Shadow.*1Color" (mac popups use native shadow)
pub const POPUP_HEADER_BG: Tok = Tok(32); // MID "Popup.Header.activeBackground"=PopupBackground
pub const POPUP_PADDING_Y: f32 = 8.0; // JBUI Popup.bodyTopInsetNoHeader / bodyBottomInsetNoAd 8
pub const POPUP_AD_FG: Tok = Tok(33); // MID "Popup.Advertiser.foreground"
pub const POPUP_AD_BG: Tok = Tok(34); // MID "Popup.Advertiser.background"=PopupBackgroundLight
pub const POPUP_AD_PADDING_X: f32 = 20.0; // DAR "Popup.Advertiser.borderInsets.compact" 4,20,5,20; default JBUI (6,20)
pub const POPUP_AD_PADDING_TOP: Met = Met(8); // ditto; default 6
pub const POPUP_AD_PADDING_BOTTOM: Met = Met(9); // ditto; default 6
pub const POPUP_AD_FONT_SIZE: f32 = 12.0; // EXP "Popup.Advertiser.fontSizeOffset" -1
pub const POPUP_AD_HEIGHT: f32 = 24.0; // derived: 4+5 insets + ~15 line (12px font)
pub const POPUP_HEADER_TEXT: Tok = TEXT; // MID "Popup.Header.activeForeground" unset -> *.foreground
pub const POPUP_HEADER_PADDING_X: f32 = 12.0; // approx: header label aligned with LIST_ROW_INSET_X + LIST_ROW_PADDING_X - 4
/// Titled popups (vim.ui.select prompt, input, key help): New UI TitlePanel, bold, centred.
pub const POPUP_TITLE_HEIGHT: f32 = 32.0; // TitlePanel.setPopupTitle: "Popup.Header.insets.compact" 8,10,8,10 + 16 label
pub const POPUP_TITLE_PAD_X: f32 = 10.0; // ditto
/// A longer title (a question) wraps: each line of a TitlePanel label, the 8 px insets kept.
pub const POPUP_TITLE_LINE_HEIGHT: f32 = 16.0; // TitlePanel: 16 px label line (13 px font)
/// List popups grow to fit their rows; a question or an info line wider than this wraps.
pub const LIST_POPUP_WRAP_WIDTH: f32 = 480.0; // design --popup-width-pick (PickLayer / InputDialog width)
/// A list popup's info line (P-12): dim text the menu only says, never a grey item.
pub const MENU_INFO_LINE_HEIGHT: f32 = 16.0; // own: 12 px text on a 16 px line (ad text's size)
pub const MENU_INFO_PADDING_Y: f32 = 3.0; // own: a single info line is 22 high, a list row's height
/// Complex popups (Search Everywhere style: Find, Usages, Switcher, Recent): title row.
pub const COMPLEX_HEADER_HEIGHT: f32 = 34.0; // "ComplexPopup.Header.insets.compact" 10,20,8,15 + 16 label
pub const COMPLEX_HEADER_PAD_L: f32 = 20.0; // ditto
pub const COMPLEX_HEADER_PAD_R: f32 = 15.0; // ditto
/// List popup separator: 1px line with vertical room, inset from the popup sides.
pub const POPUP_SEPARATOR_HEIGHT: f32 = 9.0; // JBUI Popup.separatorInsets default (4,8) + 1px line
pub const POPUP_SEPARATOR_INSET_X: f32 = 8.0; // ditto (not themed)
/// Drop shadow (macOS paints a native one; this approximates it).
pub const POPUP_SHADOW_BLUR: f32 = 12.0; // approx, within EXP "Ide.Shadow.borderInsets" 16
pub const POPUP_SHADOW_OFFSET_Y: f32 = 4.0; // approx (mac window shadow falls down)
/// Popups keep this far from the window edges when placed.
pub const POPUP_WINDOW_MARGIN: f32 = 8.0; // own choice (AWT screen-fit has none inside one window)

// ---------------------------------------------------------------- editor tabs (Islands painter)

/// Tab strip bg.
pub const TAB_STRIP_BG: Tok = Tok(35); // MID "EditorTabs.background"=BackgroundDark; 30.png exact
/// 1px line under the tab strip.
pub const TAB_STRIP_BORDER: Tok = Tok(36); // MID "EditorTabs.underTabsBorderColor"=BackgroundLight; 30.png exact
/// Tab strip height incl. bottom border line.
pub const TAB_HEIGHT: f32 = 32.0; // measured 30.png: 46.4px / 1.4405 = 32.2 (compact)
/// Rounded box drawn behind selected/hovered tab.
pub const TAB_BOX_HEIGHT: Met = Met(10); // IslandsTabPainter fullHeight compact 24 (default 28); 30.png 34px=23.6
pub const TAB_BOX_INSET_X: Met = Met(11); // IslandsTabPainter hOffset compact 2 (default 4) -> 4 between boxes
pub const TAB_ARC: Met = Met(12); // MID "MainToolbar.Button.arc.compact" 8 (IslandsTabPainter hoverArc); default 6
pub const TAB_SELECTED_BG: Tok = Tok(37); // MID "EditorTabs.underlinedTabBackground"=Blue1; 30.png 0x28324B = P3
pub const TAB_SELECTED_BORDER: Tok = Tok(38); // MID "EditorTabs.underlinedBorderColor"=Blue3
pub const TAB_SELECTED_INACTIVE_BG: Tok = Tok(39); // MID "EditorTabs.inactiveUnderlinedTabBackground"=Gray2
pub const TAB_SELECTED_INACTIVE_BORDER: Tok = Tok(40); // MID "EditorTabs.inactiveUnderlinedTabBorderColor"=Gray4
pub const TAB_HOVER_BG: Tok = Tok(41); // MID "EditorTabs.hoverBackground"=Gray2 (no border)
pub const TAB_BORDER_WIDTH: f32 = 1.0; // RectanglePainter2D.DRAW
/// Label left inset (box edge -> icon = 5 - TAB_BOX_INSET_X = 3).
pub const TAB_PADDING_LEFT: f32 = 5.0; // measured 30.png: box edge -> icon ink ~4.5 (icon ink 1 px in its box); theme tabInsets.compact 6
/// Label right inset (close icon right -> outer tab edge; the box edge is 2 further in, so the
/// close box touches it: its × ink sits 4.5 inside).
pub const TAB_PADDING_RIGHT: f32 = 2.0; // measured 30.png: label ink end -> next tab's icon ink 27.7 (with LEFT 5); theme 4
pub const TAB_ICON_GAP: f32 = 4.0; // EditorTabbedContainer UiDecoration iconTextGap 4
pub const TAB_CLOSE_SIZE: f32 = 16.0; // closeSmall icon 16; 30.png glyph 10px=7 in 16 box
pub const TAB_FIRST_OFFSET: f32 = 3.0; // IslandsTabPainter.firstTabOffset
pub const TAB_TEXT: Tok = Tok(42); // selected/hovered: plain fg (MID "*.foreground")
/// Unselected tab text = ColorUtil.blendColorsInRgb(bg, fg, 0.7) (quadratic: sqrt(bg²·.3+fg²·.7)).
pub const TAB_TEXT_INACTIVE: Tok = Tok(43); // EXP "EditorTabs.unselectedBlend" 0.7 over 0x191A1C; 30.png ~0xAFB1B6
pub const TAB_ICON_ALPHA_INACTIVE: f32 = 0.75; // EXP "EditorTabs.unselectedAlpha"
pub const TAB_FONT_SIZE: Met = Met(13); // DAR "EditorTabs.fontSizeOffset.compact" -1; default 13
/// Label right -> close button (all tabs keep the close button's room: tabs never jump).
pub const TAB_CLOSE_GAP: f32 = 2.0; // measured 30.png: "report.get.ts" ink end 1939 -> close box 1942 (3px/1.44)
/// Error underline under a tab's label (file with compiler errors; WS: wavy like the tree's, but
/// in the label error color).
pub const TAB_ERROR_UNDERLINE: Tok = Tok(44); // EXP "Label.errorForeground"=Red7 (TEXT_ERROR)
/// Wavy underline under Project tree files with errors and their folders.
pub const TREE_PROBLEM_UNDERLINE: Tok = Tok(45); // ISL ERRORS_ATTRIBUTES EFFECT_COLOR (ProjectViewNode)
/// Empty editor (no file open) hints: action name / shortcut.
pub const EMPTY_HINT_TEXT: Tok = Tok(46); // EXP Gray8 (EditorEmptyTextPainter: label foreground, dimmed)
pub const EMPTY_FACE_SIZE: f32 = 128.0; // canvas W-Empty / W-Faces: the head 128 px (8 px per pixel)
pub const EMPTY_FACE_ALPHA: f32 = 0.12; // W-Faces: "128 px at 12%", never tinted
pub const EMPTY_FACE_GAP: f32 = 12.0; // DS .vs-abeface: gap 12 px
pub const EMPTY_FACE_CAPTION_SIZE: f32 = 12.0; // DS .vs-abeface__caption: 12 px, --text-dim
pub const EMPTY_FACE_ROOM: f32 = 200.0; // an island under 200×200 draws the caption only
pub const EMPTY_FACE_MIN_HEIGHT: f32 = 80.0; // under 80 px tall, nothing
/// Status bar text while the window is in the background.
pub const STATUS_BAR_TEXT_INACTIVE: Tok = Tok(47); // MID "Island.inactiveAlphaInStatusBar" 0.2 -> Gray9 at 80% on the frame
/// Status bar widget insets (left / right of each widget's text).
pub const STATUS_BAR_WIDGET_PAD_X: f32 = 8.0; // DAR "StatusBar.Widget.widgetInsets.compact" 4,8,3,8

// ---------------------------------------------------------------- main toolbar / status bar

pub const TOOLBAR_HEIGHT: Met = Met(14); // EXP "TitlePane.Button.preferredSize.compact" 40,30; default 40
pub const TOOLBAR_BG: Tok = Tok(48); // MID "MainToolbar.background"=BackgroundLight
pub const TOOLBAR_BUTTON_SIZE: Met = Met(15); // DAR "MainToolbar.Button.size.compact" 26; default 30 (JBUI)
pub const TOOLBAR_BUTTON_HOVER_BG: Tok = Tok(49); // EXP "ActionButton.hoverBackground"
pub const TOOLBAR_BUTTON_PRESSED_BG: Tok = Tok(50); // EXP "ActionButton.pressedBackground"
pub const TOOLBAR_BUTTON_ARC: Met = Met(16); // MID "MainToolbar.Button.arc.compact" 8; default 6 (JBUI 12)
/// The right group's inset from the window's right edge (Search Everywhere).
pub const TOOLBAR_RIGHT_PAD: f32 = 8.0; // approx: MainToolbar right inset (no Run widgets / gear here)
/// Toolbar content starts right of the traffic lights (13 + 52 buttons + 13).
pub const TOOLBAR_LEFT_INSET: f32 = 78.0; // MacToolbarFrameHeader GAP_FOR_BUTTONS = 26 + 52
pub const TOOLBAR_FONT_SIZE: Met = Met(17); // DAR "MainToolbar.fontSizeOffset.compact" -1; default 13
pub const TOOLBAR_FG: Tok = TEXT; // "MainToolbar.foreground" unset in EXP / MID -> Label.foreground
pub const TOOLBAR_WIDGET_CHEVRON_GAP: f32 = 2.0; // ToolbarComboButtonUI BEFORE_CHEVRON_GAP
/// Gap between the left widgets and the centered title.
pub const TOOLBAR_LAYOUT_GAP: f32 = 10.0; // MainToolbar.kt layoutGap
/// Window title ("project – file") in the toolbar's middle.
pub const TOOLBAR_TITLE_FG: Tok = Tok(51); // Gray12; 30.png native title p90 0xDEE0E6
pub const PROJECT_ICON_SIZE_POPUP: f32 = 20.0; // RecentProjectIconHelper "ide.project.icon.size" 20
pub const PROJECT_ICON_ARC_RATIO: f32 = 0.4; // RecentProjectIconHelper AvatarIcon(arcRatio = 0.4), diameter = 0.4 * size
/// Initials font size per icon px (JetBrains Mono semibold, white).
pub const PROJECT_ICON_FONT_RATIO: f32 = 13.0 / 20.0; // AvatarUtils.getFont: 13 * size / 20
/// Gradient (start = top right, end = bottom left) per palette index.
pub const PROJECT_ICON_COLORS: [(Rgba, Rgba); 9] = [
    (hex(0xE08855), hex(0xE9806F)), // EXP "RecentProject.Color1.Avatar.Start" / "End"
    (hex(0xB08B14), hex(0xBB7F19)), // Color2
    (hex(0xA1A359), hex(0x87AA59)), // Color3
    (hex(0x3B92B8), hex(0x6183EC)), // Color4
    (hex(0x3574F0), hex(0x7A64F0)), // Color5
    (hex(0xC84D8F), hex(0xA956CF)), // Color6
    (hex(0x955AE0), hex(0xA84DE0)), // Color7
    (hex(0x24A394), hex(0x279CCD)), // Color8
    (hex(0x5FAD65), hex(0x3D968B)), // Color9
];
/// Popup group captions ("Recent", "Local", ...).
pub const POPUP_CAPTION_FG: Tok = Tok(52); // EXP "Popup.separatorForeground"=Gray7
pub const POPUP_CAPTION_PADDING_X: f32 = 16.0; // JBUI Popup.separatorLabelInsets (3,16)
pub const STATUS_BAR_HEIGHT: Met = Met(18); // derived: DAR "StatusBar.Widget.widgetInsets.compact" 4,8,3,8 + 16 icon; default 28 (6+16+6)
pub const STATUS_BAR_BG: Tok = Tok(53); // MID "StatusBar.background"=BackgroundLight
pub const STATUS_BAR_TEXT: Tok = Tok(54); // MID "StatusBar.Widget.foreground"
pub const STATUS_BAR_HOVER_BG: Tok = Tok(55); // MID "StatusBar.Widget.hoverBackground"

// ---------------------------------------------------------------- tooltip / balloon

pub const TOOLTIP_BG: Tok = Tok(56); // MID "ToolTip.background"=TooltipBackground=Gray2.5
pub const TOOLTIP_FG: Tok = Tok(57); // MID "ToolTip.foreground"
pub const TOOLTIP_BORDER: Tok = Tok(58); // MID "ToolTip.borderColor"=TooltipBorder
pub const TOOLTIP_SHORTCUT_FG: Tok = Tok(59); // EXP "ToolTip.shortcutForeground"=Gray9
pub const TOOLTIP_PADDING_X: f32 = 12.0; // JBUI HelpTooltip.smallTextBorderInsets newUI (8,12,9,12)
pub const TOOLTIP_PADDING_TOP: f32 = 8.0; // ditto
pub const TOOLTIP_PADDING_BOTTOM: f32 = 9.0; // ditto
pub const TOOLTIP_ARC: f32 = 4.0; // JBUI Tooltip.CORNER_RADIUS "ToolTip.borderCornerRadius" 4 (mac window radius)
/// Notification balloon.
pub const BALLOON_BG: Tok = Tok(60); // MID "Notification.background"=TooltipBackground
pub const BALLOON_FG: Tok = Tok(61); // MID "Notification.foreground"
pub const BALLOON_BORDER: Tok = Tok(62); // MID "Notification.borderColor"=TooltipBorder
pub const BALLOON_ARC: f32 = 6.0; // NotificationBalloonRoundShadowBorderProvider "Notification.arc" 12 (RoundRectangle2D diameter)
/// Short balloons (title only, or content within 1 line under a title / 2 without one):
/// BalloonLayoutConfiguration.twoLines(); longer ones treeLines() (BALLOON_LONG_*).
pub const BALLOON_PADDING_TOP: f32 = 15.0; // NotificationsManagerImpl "Notification.borderInsets" 4 + twoLines top 11
pub const BALLOON_PADDING_BOTTOM: f32 = 20.0; // borderInsets 6 + twoLines bottom 14
pub const BALLOON_TITLE_GAP: f32 = 5.0; // twoLines titleContentSpaceHeight 5
pub const BALLOON_LONG_PADDING_TOP: f32 = 11.0; // borderInsets 4 + treeLines top 7
pub const BALLOON_LONG_PADDING_BOTTOM: f32 = 14.0; // borderInsets 6 + treeLines bottom 8
pub const BALLOON_LONG_TITLE_GAP: f32 = 3.0; // treeLines titleContentSpaceHeight 3
pub const BALLOON_PADDING_LEFT: f32 = 4.0; // borderInsets (4,4,6,0) left
pub const BALLOON_ICON_X: f32 = 10.0; // BalloonLayoutConfiguration iconOffset.width 10 (after the border inset)
pub const BALLOON_TEXT_X: f32 = 38.0; // borderInsets 4 + iconPanelWidth 32 + BorderLayout hgap 2 (new UI, NotificationsManagerImpl)
pub const BALLOON_LINE_HEIGHT: f32 = 16.0; // JEditorPane HTML at Inter 13: font height ~15.7
/// Close button (shown on hover): "rightActionsOffset" from the top right corner.
pub const BALLOON_CLOSE_OFFSET: f32 = 9.0; // BalloonLayoutConfiguration new UI rightActionsOffset (9,9)
pub const BALLOON_SHADOW: Tok = Tok(63); // EXP "Notification.Shadow.*1Color"
pub const BALLOON_SHADOW_SIZE: f32 = 5.0; // "Notification.Shadow.borderInsets" 5,5,5,5

// ---------------------------------------------------------------- text fields

pub const FIELD_BG: Tok = Tok(64); // MID "TextField.background"=InputBackground; 30.png git filter exact
pub const FIELD_BORDER: Tok = Tok(65); // MID "Component.borderColor"=ComponentBorder=Gray4; 30.png ~0x484A4F
/// Focus ring around focused fields/buttons.
pub const FOCUS_BORDER: Tok = Tok(66); // EXP "*.focusColor"=Blue6 (JBUI Focus.focusColor)
pub const FIELD_ARC: f32 = 4.0; // EXP "Component.arc" 8 (diameter)
pub const FIELD_HEIGHT: f32 = 28.0; // EXP "TextField.minimumSize" 49,28; 30.png git filter box 42px=29
pub const FIELD_PADDING_LEFT: f32 = 9.0; // DarculaTextFieldUI.getDefaultMargins newUI (2,9,2,6)
pub const FIELD_PADDING_X: f32 = FIELD_PADDING_LEFT;
pub const CARET: Tok = Tok(67); // DAR "*.caretForeground" (not overridden by EXP/MID)
pub const FIELD_SELECTION_BG: Tok = Tok(68); // MID "*.selectionBackground"=Blue2
pub const CARET_WIDTH: f32 = 1.0; // Swing DefaultCaret width 1 (text fields; the editor's caret is separate)
/// Magnifier -> text in search fields.
pub const FIELD_ICON_GAP: f32 = 6.0; // approx: SearchTextField icon inset; 30.png git filter (magnifier 16 + ~6)
pub const PLACEHOLDER: Tok = Tok(69); // Gray7; measured 30.png "Text or hash" p90 0x787B82 (calib -> 0x6F737A)

// ---------------------------------------------------------------- popup menu / balloons (MENUS)

/// Context menu body top / bottom inset (no header: list rows start here).
pub const MENU_PADDING_Y: f32 = 6.0; // DAR "PopupMenu.borderInsets" 6,1,6,1 (IdeaPopupMenuUI)
/// Menu separator row: the 1px stripe centred in it.
pub const MENU_SEPARATOR_HEIGHT: f32 = 9.0; // DAR "PopupMenuSeparator.height" 9, stripeWidth 1, stripeIndent 4
/// Icon column -> label (both styles).
pub const MENU_ICON_GAP: f32 = 4.0; // Context: BegMenuItemUI defaultTextIconGap 4; List: "ActionsList.icon.gap" 6 - 2 (PopupListElementRenderer)
/// Context menu (JPopupMenu: editor / tree right-click): rows of 22 in a 24 px pitch.
pub const MENU_CONTEXT_ROW_PITCH: f32 = 24.0; // "List.rowHeight.compact" 22 + "PopupMenu.Selection.outerInsets" 1,7 (IdeaMenuUI.patchPreferredSize)
pub const MENU_CONTEXT_SELECTION_X: f32 = 7.0; // ditto outer 7, inside the 1 px border
pub const MENU_CONTEXT_SELECTION_Y: f32 = 1.0; // ditto outer 1
/// Content (icon column / text / shortcut) inset from the item edge.
pub const MENU_CONTEXT_CONTENT_X: f32 = 13.0; // "PopupMenu.Selection.innerInsets" 0,6 + outer 7
/// Icons are centred in a check-icon column.
pub const MENU_CONTEXT_ICON_COL: f32 = 18.0; // IdeaMenuUI check icon gutter
/// Text inset when no item has an icon.
pub const MENU_CONTEXT_NO_ICON_X: f32 = 17.0; // IdeaPopupMenuUI.hideEmptyIcon: content 13 + gap 4
pub const MENU_CONTEXT_SHORTCUT_GAP: f32 = 40.0; // BegMenuItemUI.getPreferredSize: 7 gaps + gutter on the widest row
pub const MENU_CONTEXT_SEPARATOR_INSET_X: f32 = 10.0; // "PopupMenuSeparator.withToEdge" 10
/// Shortest space between a label and its shortcut (List popups).
pub const MENU_SHORTCUT_GAP: f32 = 24.0; // approx: PopupListElementRenderer shortcut label gap
/// List popup submenu arrow -> label.
pub const MENU_LIST_ARROW_GAP: f32 = 20.0; // PopupListElementRenderer myNextStepLabel emptyLeft(20)
pub const MENU_MIN_WIDTH: f32 = 140.0; // own: menu.lua's 18 cells
/// Shortcut text (right column).
pub const MENU_SHORTCUT_FG: Tok = Tok(70); // EXP "*.acceleratorForeground"=Gray7 (MenuItem.acceleratorForeground)
pub const MENU_SHORTCUT_SELECTED_FG: Tok = Tok(71); // DAR "MenuItem.acceleratorSelectionForeground" (Context; List: SELECTION_TEXT)
pub const MENU_DISABLED_FG: Tok = Tok(72); // EXP "*.disabledForeground"=Gray6
/// Speed search row over the menu rows.
pub const MENU_SEARCH_HEIGHT: f32 = 28.0; // "Popup.SearchField.borderInsets" 4,12 + input 4,8,8,2 compact around a 16 px line (approx)
/// Notification balloon: fixed width, stacked bottom right.
pub const BALLOON_WIDTH: f32 = 360.0; // BalloonLayoutConfiguration MaxWidth 360 (JBUI)
pub const BALLOON_GAP: f32 = 10.0; // BalloonLayoutImpl stacks with no gap; each shadow border 5 -> 10 visible
/// Space between the balloons and the window's right edge / the status bar.
pub const BALLOON_MARGIN: f32 = 5.0; // the shadow border (5) is the only margin
/// Right of the text column: the close button's room.
pub const BALLOON_PADDING_RIGHT: f32 = 30.0; // BalloonLayoutConfiguration closeOffset 5 + 16 icon + 9 (borderInsets right 0)
/// Text field popup (vim.ui.input): WebStorm's "New File" popup (NewItemSimplePopupPanel), a
/// borderless field on the popup background under the title.
pub const INPUT_POPUP_WIDTH: f32 = 344.0; // approx: WS Rename popup field width (~44 cells today) + the old 2*12 padding
pub const INPUT_FIELD_HEIGHT: f32 = 32.0; // NewItemPopupUtil ExtendableTextField preferred height 32
pub const INPUT_FIELD_INSET: f32 = 13.0; // NewItemSimplePopupPanel text field emptyLeft(13)
pub const INPUT_POPUP_PADDING: f32 = 8.0; // JBUI Popup.bodyBottomInsetNoAd 8 (under the field; above it without a title)

// ---------------------------------------------------------------- scrollbar

pub const SCROLLBAR_THUMB: Tok = Tok(73); // MID "ScrollBar.Transparent.thumbColor"
pub const SCROLLBAR_THUMB_HOVER: Tok = Tok(74); // MID "ScrollBar.Transparent.hoverThumbColor"
pub const SCROLLBAR_WIDTH: f32 = 14.0; // MacScrollBarUI thickness 14 (min 11 when idle)

// ---------------------------------------------------------------- fonts

pub const UI_FONT_SIZE: f32 = 13.0; // macOS default UI font size (tree/list text)
pub const UI_SMALL_FONT_SIZE: f32 = 12.0; // DAR "*.fontSizeOffset.compact" -1 (tabs, status bar, TW header); EXP Popup.Advertiser -1

// ---------------------------------------------------------------- git file status (tree / tabs text)

pub const GIT_MODIFIED: Tok = Tok(75); // ISL (=EXPS) FILESTATUS_MODIFIED
pub const GIT_ADDED: Tok = Tok(76); // ISL (=EXPS) FILESTATUS_ADDED
pub const GIT_UNTRACKED: Tok = Tok(77); // ISL (=EXPS) FILESTATUS_UNKNOWN
pub const GIT_IGNORED: Tok = Tok(78); // ISL (=EXPS) FILESTATUS_IDEA_FILESTATUS_IGNORED; 30.png 0xCD9D72 = P3 of 0xD69A6B
pub const GIT_DELETED: Tok = Tok(79); // ISL (=EXPS) FILESTATUS_DELETED
pub const GIT_CONFLICT: Tok = Tok(80); // ISL (=EXPS) FILESTATUS_IDEA_FILESTATUS_MERGED_WITH_CONFLICTS
pub const GIT_RENAMED: Tok = Tok(81); // ISL (=EXPS) FILESTATUS_RENAMED
pub const GIT_MERGED: Tok = Tok(82); // ISL (=EXPS) FILESTATUS_MERGED

// ================================================================ Git tool window kit (GKIT)
// More source abbreviations: `ISL` = themes/islands/IslandSchemeDark.xml (the UI-theme scheme
// FileStatusImpl.getColor reads; same values as EXPS); `DCM` = the bundled Darcula scheme in
// DefaultColorSchemesManager.xml (DCS's parent: DIFF_* come from it). "approx" = measured / chosen.

pub const ICON_DISABLED_ALPHA: f32 = 0.45; // approx: DAR "grayFilter" -70,-70,100 (gray); 30.png cherry-pick 5F..65 vs CED0D6

// ---------------------------------------------------------------- tool window header tabs

/// 1 px line under a tool window header.
pub const TOOLWINDOW_HEADER_BORDER: Tok = Tok(83); // MID "ToolWindow.Header.borderColor"=BorderDark (UIUtil.drawHeader); 30.png #25272A
pub const TOOLWINDOW_TITLE_FG: Tok = TEXT; // MID *.foreground
pub const TOOLWINDOW_TITLE_FONT_SIZE: f32 = 12.0; // TabContentLayout idLabel BaseLabel bold, header font (compact -1); 30.png "Git" 33px
/// Title -> first tab label (the label's box sits TOOLWINDOW_TAB_BOX_INSET_X further in).
pub const TOOLWINDOW_TITLE_GAP: f32 = 16.0; // JBUI ToolWindow.headerLabelLeftRightInsets (0,12,0,16)
pub const TOOLWINDOW_TAB_FONT_SIZE: f32 = 12.0; // BaseLabel.getLabelFont header font (compact -1); 30.png "Local Changes" 118px
pub const TOOLWINDOW_TAB_HEIGHT: f32 = 24.0; // IslandsTabPainter fullHeight compact 24; 30.png 35px
/// Title + tab labels sit this much below the header / tab box centre (boxes unchanged).
pub const TOOLWINDOW_TEXT_DY: f32 = 1.5; // measured: 30.png "Git" / "Local Changes" cap tops 12.1 / 12.8 below the island, centred labels 10.5 / 11.0
/// Labels abut; the painted box is inset this much each side (so 4 between boxes).
pub const TOOLWINDOW_TAB_BOX_INSET_X: f32 = 2.0; // IslandsTabPainter.getHOffsetUnscaled compact
/// Box edge -> text (label inset 12 minus the box inset).
pub const TOOLWINDOW_TAB_PAD_X: f32 = 12.0 - TOOLWINDOW_TAB_BOX_INSET_X; // JBUI ToolWindow.headerTabLeftRightInsets newUI (0,12)
/// Close icon right -> box edge.
pub const TOOLWINDOW_TAB_PAD_RIGHT_CLOSE: f32 = 7.0 - TOOLWINDOW_TAB_BOX_INSET_X; // ContentLabel ICONS_GAP 3 + 4; 30.png glyph->box 9.7 (glyph 4.5 in its box)
pub const TOOLWINDOW_TAB_CLOSE_GAP: f32 = 8.0; // ContentLabel icon x = prefWidth - 4 (right inset 12) -> text end + 8
pub const TOOLWINDOW_TAB_CLOSE_SIZE: f32 = 16.0; // AllIcons.Actions.Close -> expui/general/closeSmall
pub const TOOLWINDOW_TAB_GAP: f32 = 2. * TOOLWINDOW_TAB_BOX_INSET_X; // labels abut, boxes inset 2 each
pub const TOOLWINDOW_TAB_ARC: f32 = 4.0; // IslandsTabPainter hoverArc = MID "MainToolbar.Button.arc.compact" 8
pub const TOOLWINDOW_TAB_FG: Tok = TEXT; // Label.foreground = MID *.foreground
pub const TOOLWINDOW_TAB_SELECTED_FG: Tok = TEXT; // "ToolWindow.HeaderTab.underlinedTabForeground" -> label fg
pub const TOOLWINDOW_TAB_SELECTED_BG: Tok = Tok(84); // tool window active: MID "EditorTabs.underlinedTabBackground"=Blue1
pub const TOOLWINDOW_TAB_SELECTED_BORDER: Tok = Tok(85); // MID "EditorTabs.underlinedBorderColor"=Blue3
pub const TOOLWINDOW_TAB_SELECTED_INACTIVE_BG: Tok = Tok(86); // MID "EditorTabs.inactiveUnderlinedTabBackground"=Gray2; 30.png exact
pub const TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER: Tok = Tok(87); // MID "EditorTabs.inactiveUnderlinedTabBorderColor"=Gray4; 30.png #3E4045
pub const TOOLWINDOW_TAB_HOVER_BG: Tok = Tok(88); // MID "EditorTabs.hoverBackground" (Islands painter; "ToolWindow.HeaderTab.hoverBackground" unused), no border
pub const TOOLWINDOW_TAB_MAX_WIDTH: f32 = 400.0; // ContentTabLabel.MAX_WIDTH
pub const TOOLWINDOW_OVERFLOW_WIDTH: f32 = 40.0; // own: the "▾ N" button
pub const TOOLWINDOW_ACTIONS_PAD_RIGHT: f32 = 6.0; // approx: title actions' right inset (JBUI ToolWindow.headerToolbarLeftRightInsets), calibrated on 30.png

// ---------------------------------------------------------------- action buttons / toolbars

pub const ACTION_BUTTON_SIZE: f32 = 22.0; // ActionToolbar.DEFAULT_MINIMUM_BUTTON_SIZE (bg inside the border)
/// Between buttons: ActionToolbarImpl.getActionButtonBorder insets (1,2,1,2) on each -> pitch 26.
pub const ACTION_BUTTON_GAP: f32 = 4.0; // 2 + 2; 30.png pitch 37px = 25.7
pub const ACTION_BUTTON_ARC: f32 = 4.0; // IdeaActionButtonLook: DarculaUIUtil.BUTTON_ARC = EXP "Button.arc" 8
pub const ACTION_BUTTON_HOVER_BG: Tok = Tok(89); // MID "*.hoverBackground"=HoverBackgroundMid beats EXP "ActionButton.hoverBackground" #FFFFFF16 (theme.py)
pub const ACTION_BUTTON_PRESSED_BG: Tok = TOOLBAR_BUTTON_PRESSED_BG; // EXP "ActionButton.pressedBackground"
pub const ACTION_BUTTON_TOGGLED_BG: Tok = Tok(90); // toggled = ActionButton PUSHED state -> EXP "ActionButton.pressedBackground"
/// The popup triangle (general/dropdown, 16 px, in its corner) inset from the button box.
pub const ACTION_BUTTON_DROPDOWN_INSET: f32 = 2.0; // approx 30.png eye ◢
/// Toolbar insets (left / right, top / bottom).
pub const ACTION_TOOLBAR_PAD_X: Met = Met(19); // DAR "ToolBar.horizontalToolbarInsets.compact" 2,4,2,4 (default 5,7)
pub const TOOLBAR_SEPARATOR: Tok = Tok(91); // MID "*.separatorColor"=BorderLight overrides EXP "ToolBar.separatorColor" Gray4 (unverified on screen)
/// Separator: a 1 px line in a 7 px slot, 2 px from the top, 3 from the bottom of a 24 px row.
pub const TOOLBAR_SEPARATOR_MARGIN: f32 = 3.0; // ActionToolbarImpl.MySeparator gap 2*2 + 3, line at x 3
pub const TOOLBAR_SEPARATOR_LENGTH: f32 = 19.0; // line y 2 .. maxButtonHeight(24) - 3
pub const TOOLTIP_OFFSET_Y: f32 = 0.0; // own
pub const TOOLTIP_SHORTCUT_GAP: f32 = 8.0; // approx: HelpTooltip shortcut gap

// ---------------------------------------------------------------- search field / filter chips

/// The VCS log's text filter (SearchFieldWithExtension): a 28 px field + 1 px panel border.
pub const SEARCH_FIELD_HEIGHT: f32 = 30.0; // 30.png 43px
pub const SEARCH_FIELD_MIN_WIDTH: f32 = 150.0; // VcsLogClassicFilterUi.TextFilterField.getMinimumSize
pub const SEARCH_FIELD_PAD_LEFT: f32 = 6.5; // approx 30.png outer edge -> icon 11px (incl. the 1 px border)
pub const SEARCH_FIELD_PAD_RIGHT: f32 = 3.0; // approx 30.png
pub const SEARCH_FIELD_ICON_GAP: f32 = 9.0; // approx 30.png icon box end -> "T"
pub const SEARCH_FIELD_TOGGLE_SIZE: f32 = 22.0; // MyActionButton DEFAULT_MINIMUM_BUTTON_SIZE
pub const SEARCH_FIELD_TOGGLE_GAP: f32 = 4.0; // border (1,2,1,2) each; 30.png icon boxes 10 apart
pub const SEARCH_FIELD_TOGGLE_ARC: f32 = 4.0; // FieldInplaceActionButtonLook (Button.arc 8)
pub const SEARCH_FIELD_TOGGLE_ON_BG: Tok = Tok(92); // EXP "SearchOption.selectedBackground"=Blue3
pub const SEARCH_FIELD_TOGGLE_ON_HOVER_BG: Tok = Tok(93); // EXP "SearchOption.selectedHoveredBackground"=Blue4
pub const VCS_LOG_FILTER_ROW_HEIGHT: f32 = 37.0; // approx 30.png header line -> first row top

// ---------------------------------------------------------------- replace bar (⌘R, E-16)

/// WS's floating editor search component (the terminal Find bar's look): field background
/// `Editor.SearchField.background`, left / bottom border `Editor.Toolbar.borderColor`.
pub const REPLACE_BAR_BG: Tok = Tok(94); // Editor.SearchField.background (terminal/find.rs BAR_BG)
pub const REPLACE_BAR_BORDER: Tok = Tok(95); // Editor.Toolbar.borderColor (terminal/find.rs BAR_BORDER)
pub const REPLACE_BAR_FIELD_WIDTH: f32 = 260.0; // own: WS SearchTextArea's 14 columns + Cc .* toggles, a little wider than the terminal's 190
pub const REPLACE_BAR_FIELD_PAD_LEFT: f32 = 10.0; // Editor.SearchField.borderInsets.compact (3, 10, 3, 8)
pub const REPLACE_BAR_FIELD_PAD_RIGHT: f32 = 8.0; // Editor.SearchField.borderInsets.compact (3, 10, 3, 8)
pub const REPLACE_BAR_GAP: f32 = 4.0; // terminal Find bar: field · count · ↑ ↓ × 4 apart
pub const REPLACE_BAR_PAD_RIGHT: f32 = 4.0; // terminal Find bar's right inset
pub const REPLACE_BAR_PAD_Y: f32 = 3.0; // terminal Find bar's vertical inset
pub const REPLACE_BAR_COUNT_MIN_WIDTH: f32 = 64.0; // own: "12/120" and "0 results" without the arrows moving
pub const REPLACE_BAR_BUTTON_HEIGHT: f32 = 24.0; // own: Replace / Replace All, the small button in a 30 px row
pub const VCS_LOG_FILTER_BAR_PAD_X: f32 = 4.0; // toolbar compact inset; 30.png field at 6px
/// Search field -> first filter chip.
pub const VCS_LOG_FILTER_FIELD_GAP: f32 = 7.0; // approx 30.png field edge -> "Branch:" 11.5 (chip pad 4)
/// Filter chips (vcs-log FilterComponent): plain labels, no hover background; hovering turns the
/// name to the value color.
pub const FILTER_CHIP_HEIGHT: f32 = 24.0; // 16 + 2 * 4
pub const FILTER_CHIP_PAD: f32 = 4.0; // BORDER_SIZE 2 + wrapBorder empty(2), all sides
pub const FILTER_CHIP_ICON_GAP: f32 = 3.0; // GAP_BEFORE_ARROW
pub const FILTER_CHIP_GAP: f32 = 0.0; // chips abut; 30.png ×box -> "User" 8.7
pub const FILTER_CHIP_NAME_FG: Tok = Tok(96); // UIUtil.getLabelInfoForeground = EXP *.infoForeground Gray7; 30.png #7E8187
pub const FILTER_CHIP_VALUE_FG: Tok = TEXT; // Label.foreground
pub const FILTER_CHIP_FOCUS_ARC: f32 = 5.0; // FilledRoundedBorder ARC_SIZE 10

// ---------------------------------------------------------------- checkbox / splitter / stripe

/// Layout box of a checkbox (the WS SVG's 24 px canvas overhangs it; its 15 px box + 1 px stroke
/// fills it).
pub const CHECKBOX_SIZE: f32 = 16.0; // checkBox.svg rect 4.5..19.5, stroke 1 -> 4..20
pub const CHECKBOX_CANVAS: f32 = 24.0; // EXP "CheckBox.iconSize"; themes/expUI/icons/dark/checkBox*.svg
pub const CHECKBOX_LABEL_GAP: f32 = 4.0; // EXP "CheckBox.textIconGap"
/// A tree row's checkbox column: the whole 24 px icon (ChangesTreeCellRenderer WEST, no insets).
pub const CHECKBOX_TREE_WIDTH: f32 = 24.0; // ThreeStateCheckBox in the renderer
pub const SPLITTER_LINE: Tok = Tok(97); // OnePixelDivider.BACKGROUND = JBColor.border() = MID "Borders.color"; 30.png x1823 #272A2D
/// Mouse zone around the 1 px divider (both sides together).
pub const SPLITTER_GRAB: f32 = 12.0; // registry ide.splitter.mouseZone=6 (|d| < 6 each side)
pub const SPLITTER_MIN_PANE: f32 = 60.0; // own
/// Collapsed Branches strip (git4idea ExpandStripeButton): incl. its 1 px right border.
pub const STRIPE_WIDTH: f32 = 32.0; // expanded vertical toolbar width 4+1+22+1+4; 30.png 46px
pub const STRIPE_HOVER_BG: Tok = Tok(98); // "ToolWindow.Button.hoverBackground" unset -> Gray.x0F alpha 40
/// Chevron button top (the icon's top is 3 px lower, at 2 * iconTextGap = 8).
pub const STRIPE_PAD_TOP: f32 = 5.0; // 30.png icon top 7.6
/// Chevron button bottom -> the label's end (its top: 2 * 16 + 2 = 34 from the strip top).
pub const STRIPE_TEXT_GAP: f32 = 7.0; // 34 - (5 + 22); 30.png 34.4
pub const STRIPE_FONT_SIZE: f32 = 11.0; // UIUtil FontSize.SMALL = max(13 - 2, 11); text/branchesVertical.svg

// ---------------------------------------------------------------- changes tree

/// Name -> " 3 files" (SimpleColoredComponent: space + thin space).
pub const CHANGES_COUNT_GAP: f32 = 5.0; // approx: appendCount spaceAndThinSpace at 13 px
pub const CHANGES_COUNT_FG: Tok = Tok(99); // appendCount GRAYED_ATTRIBUTES = EXP *.infoForeground Gray7

// ---------------------------------------------------------------- push buttons (commit panel)

pub const BUTTON_HEIGHT: f32 = 28.0; // EXP "Button.minimumSize" 72,28 (visible; +3 invisible border insets)
pub const BUTTON_MIN_WIDTH: f32 = 72.0; // ditto
pub const BUTTON_PAD_X: f32 = 11.0; // DarculaButtonUI HORIZONTAL_PADDING 14 - 3 border inset
pub const BUTTON_ARC: f32 = 4.0; // EXP "Button.arc" 8
pub const BUTTON_BG: Tok = Tok(100); // MID "Button.startBackground"/"endBackground" transparent
pub const BUTTON_BORDER: Tok = Tok(101); // EXP "Button.startBorderColor"=Gray5
pub const BUTTON_FG: Tok = TEXT; // Button.foreground
pub const BUTTON_PRIMARY_BG: Tok = Tok(102); // EXP "Button.default.startBackground"=Blue6
pub const BUTTON_PRIMARY_BORDER: Tok = Tok(103); // EXP "Button.default.startBorderColor"
pub const BUTTON_PRIMARY_FG: Tok = Tok(104); // MID "Button.default.foreground"
pub const BUTTON_DISABLED_BG: Tok = Tok(105); // transparent like the plain button
pub const BUTTON_DISABLED_BORDER: Tok = Tok(106); // approx: EXP "Button.disabledBorderColor" Gray3
// A danger confirm's Yes (abe's red confirm, prod deploys): WS has no danger button, so its red on
// the default button's shape.
pub const BUTTON_DANGER_BG: Tok = Tok(107); // EXP palette Red6
pub const BUTTON_DANGER_FG: Tok = Tok(108); // as MID "Button.default.foreground"
pub const BUTTON_DANGER_TEXT: Tok = Tok(109); // EXP "Label.errorForeground"=Red7 (not in focus)
pub const BUTTON_DANGER_BORDER: Tok = Tok(110); // EXP "Component.errorFocusColor"=Red5

// ---------------------------------------------------------------- commit message (CommitMessage editor)

pub const COMMIT_MESSAGE_BG: Tok = EDITOR_BG; // UISpec.COMMIT_EDITOR_COLOR = scheme bg (DCS TEXT)
pub const COMMIT_MESSAGE_FG: Tok = EDITOR_FG; // DCS TEXT fg (plain text)
pub const COMMIT_MESSAGE_PLACEHOLDER: Tok = Tok(111); // EditorPainter placeholder: "Component.infoForeground"
pub const COMMIT_MESSAGE_BORDER: Tok = Tok(112); // CommitInputBorder: Component.borderColor 1 px, arc 4; focused 2 px Blue6
pub const COMMIT_MESSAGE_MARGIN_X: f32 = 5.0; // compact 6 + 2 - 3 (default 11)
pub const COMMIT_MESSAGE_MARGIN_Y: f32 = 1.0; // compact 4 - 3 (default 3)
pub const COMMIT_PANEL_PAD_X: Met = Met(20); // NonModalCommitPanel BASE_LEFT_RIGHT_INSET compact (default 12)
pub const COMMIT_ACTIONS_PAD_Y: f32 = 3.0; // actionPanelBorder (3, 6-3, 3, 6)
pub const COMMIT_PANEL_MIN_HEIGHT: f32 = 120.0; // NonModalCommitPanel
/// The text area's line pitch (13 px Inter * 1.2, rounded).
pub const TEXT_AREA_LINE_HEIGHT: f32 = 16.0; // brief: line height 1.2 (plain UI text areas)
pub const TEXT_AREA_PAD_X: f32 = 6.0; // = the commit message's left pad: editor emptyLeft(6)
pub const TEXT_AREA_PAD_Y: f32 = 4.0; // approx: plain UI text areas
/// The commit message is an editor: the scheme's line spacing 1.2 -> the main editor's 22 px rows.
pub const COMMIT_MESSAGE_LINE_HEIGHT: f32 = 22.0; // 30.png editor pitch 31.7 / 1.4405
/// CommitInputBorder: insets 3 = 1 (DarculaUIUtil.paddings, outside the painted border) + 1 px
/// border + 1 inside; the editor itself has no top inset, emptyLeft(6) on the left.
pub const COMMIT_MESSAGE_OUTLINE_GAP: f32 = 1.0; // DarculaUIUtil.paddings()
pub const COMMIT_MESSAGE_PAD_Y: f32 = 1.0; // inside the 1 px border
pub const COMMIT_MESSAGE_PAD_X: f32 = 7.0; // 1 inside the border + emptyLeft(6)

// ---------------------------------------------------------------- VCS log rows / ref labels

pub const VCS_LOG_ROW_HEIGHT: Met = Met(21); // DAR "VersionControl.Log.Commit.rowHeight.compact" (default 26); 30.png 34.6px
pub const VCS_LOG_FONT_SIZE: f32 = 13.0; // Table.font
pub const VCS_LOG_SUBJECT_FG: Tok = TEXT; // all columns Table.foreground; 30.png p90 = tabs'
pub const VCS_LOG_AUTHOR_FG: Tok = TEXT; // ditto ("*" = author != committer; own commits bold)
pub const VCS_LOG_DATE_FG: Tok = TEXT; // ditto
pub const VCS_LOG_HOVER_BG: Tok = Tok(113); // EXP "VersionControl.Log.Commit.hoveredBackground" #FFFFFFED over the panel
pub const VCS_LOG_CURRENT_BRANCH_BG: Tok = Tok(114); // EXP "VersionControl.Log.Commit.currentBranchBackground"
pub const VCS_LOG_UNMATCHED_FG: Tok = Tok(115); // VcsLogGraphTable.getStyle: JBColor.GRAY
/// The Log's commit details (CommitDetailsPanel: label font, HtmlPanel).
pub const VCS_DETAILS_COMMITTER_FG: Tok = Tok(116); // CommitPresentationUtil.getCommitterHtml: JBColor.GRAY
pub const VCS_DETAILS_LINE_HEIGHT: f32 = 17.0; // approx: HtmlPanel body at Label.font 13 (JEditorPane line ~16-17)
pub const VCS_DETAILS_TEXT_HEIGHT: f32 = 150.0; // own: the details text under the changed files (Lua: rows below the tree)
pub const VCS_LOG_SELECTION_ARC: f32 = 4.0; // VcsLogNewUiCellWrapper ARC = Popup.Selection.arc 8
pub const VCS_LOG_SELECTION_INSET_X: f32 = 4.0; // VcsLogNewUiCellWrapper INSETS (first / last column only)
pub const VCS_LOG_LANE_WIDTH: f32 = 16.5; // 16 * 24 / 22, odd at 2x
pub const VCS_LOG_LANE_CENTER: f32 = 8.5;
pub const VCS_LOG_LINE_WIDTH: f32 = 1.5; // 1.5 * 24 / 22; selected 2.5
pub const VCS_LOG_NODE_DIAMETER: f32 = 8.5; // 30.png ~8
pub const VCS_LOG_HEAD_OUTER: f32 = 12.5; // HeadNodePainter: fill d12.5, bg d8.5, fill d4.5; 30.png 18px
pub const VCS_LOG_HEAD_RING: f32 = 8.5;
pub const VCS_LOG_HEAD_DOT: f32 = 4.5;
/// Ref label (LabelPainter / LabelIcon / TagPainter).
pub const VCS_REF_HEAD: Tok = Tok(117); // EXP "VersionControl.GitLog.headIconColor"=Yellow8; 30.png #FCDE87
pub const VCS_REF_LOCAL: Tok = Tok(118); // EXP "...localBranchIconColor"=Green7
pub const VCS_REF_REMOTE: Tok = Tok(119); // EXP "...remoteBranchIconColor"=Purple9; 30.png #B691F0
pub const VCS_REF_TAG: Tok = Tok(120); // EXP "...tagIconColor"=Gray8; 30.png #8D9096
pub const VCS_REF_OTHER: Tok = Tok(121); // EXP "...otherIconColor"=Gray8
pub const VCS_REF_TEXT_FG: Tok = Tok(122); // MID "VersionControl.Log.Commit.Reference.foreground"; 30.png #7F8288
pub const VCS_REF_FONT_SIZE: f32 = 12.0; // getReferenceFont = table font - 1
/// Tag height = the reference font's line height (12 px Inter).
pub const VCS_REF_ICON_SIZE: f32 = 15.0; // LabelPainter: icon height = font metrics height
pub const VCS_REF_PAD_X: f32 = 4.0; // LabelPainter LEFT_PADDING / RIGHT_PADDING
pub const VCS_REF_ICON_TEXT_GAP: f32 = 1.0; // ICON_TEXT_PADDING (new UI)
pub const VCS_REF_GAP_AFTER: f32 = 4.0; // approx 30.png ref text end -> author column (+ PAD_X)

// ---------------------------------------------------------------- diff / merge (DCM Darcula; DCS sets none)

pub const DIFF_INSERTED_BG: Tok = Tok(123); // DCM DIFF_INSERTED
pub const DIFF_DELETED_BG: Tok = Tok(124); // DCM DIFF_DELETED
pub const DIFF_MODIFIED_BG: Tok = Tok(125); // DCM DIFF_MODIFIED
pub const DIFF_CONFLICT_BG: Tok = Tok(126); // DCM DIFF_CONFLICT (Lua sampled 0x5C3A3A)
/// Error stripe (scrollbar marks).
pub const DIFF_INSERTED_STRIPE: Tok = Tok(127); // DCM DIFF_INSERTED error stripe
pub const DIFF_DELETED_STRIPE: Tok = Tok(128); // DCM
pub const DIFF_MODIFIED_STRIPE: Tok = Tok(129); // DCM
pub const DIFF_CONFLICT_STRIPE: Tok = Tok(130); // DCM
// viewer chrome geometry (DIFF, M3)
/// Toolbar row over the panes (it takes the split's tab bar place: same height).
pub const DIFF_TOOLBAR_HEIGHT: f32 = 32.0; // approx: ActionToolbar 22 px buttons + insets, = TAB_HEIGHT
/// A pane's title row (lock, hash, path / "Current version").
pub const DIFF_TITLE_HEIGHT: f32 = 28.0; // approx: DiffUtil title panel (label + empty(4) insets + 1 px border)
/// Between two panes: the change connectors.
pub const DIFF_DIVIDER_WIDTH: f32 = 30.0; // DiffSplitter / ThreeDiffSplitter divider JBUI.scale(30)
/// Merge window's button row (Accept Left / Accept Right ... Apply / Cancel).
pub const DIFF_BUTTONS_HEIGHT: f32 = 44.0; // approx: DialogWrapper south panel, 28 px buttons + 8 insets
/// Scrollbar marks strip at a pane's outer edge.
pub const DIFF_MARKS_WIDTH: f32 = SCROLLBAR_WIDTH; // the editor's vertical scrollbar (error stripe)
/// One error-stripe mark: thickness inside the strip, minimum height.
pub const DIFF_MARK_WIDTH: f32 = 6.0; // approx: EditorMarkupModel error stripe marker width (new UI thin)
pub const DIFF_MARK_MIN_HEIGHT: f32 = 3.0; // ErrorStripeMarkersModel min mark height
/// Gutter icons (» « × wand) and their column.
pub const DIFF_GUTTER_ICON: f32 = 14.0; // expui/diff/*@14x14
/// A pane title's insets left / right (DiffUtil.createTitle: empty(0, 4)).
pub const DIFF_TITLE_PAD_X: f32 = 4.0;
/// Merge done: "No changes. No conflicts." (MergeThreesideViewer: green + greenCheckmark).
pub const MERGE_DONE_FG: Tok = Tok(131); // JBColor "#5D9B47"/"#57965C" (dark) = greenCheckmark's stroke
/// Pane title text.
pub const DIFF_TITLE_FG: Tok = TEXT; // Label.foreground
pub const DIFF_TITLE_DIM_FG: Tok = TEXT_DIM; // the path after the hash (approx: infoForeground)
/// A thin line where one side has lines the other doesn't (DiffDrawUtil border line).
pub const DIFF_GAP_LINE: f32 = 1.0;

// ---------------------------------------------------------------- editor change gutter / annotate

pub const GUTTER_ADDED: Tok = Tok(132); // DCS ADDED_LINES_COLOR
pub const GUTTER_MODIFIED: Tok = Tok(133); // DCS MODIFIED_LINES_COLOR
pub const GUTTER_DELETED: Tok = Tok(134); // DCS DELETED_LINES_COLOR
pub const GUTTER_BAR_WIDTH: f32 = 4.0; // registry gutter.vcs.changes.width=4
pub const GUTTER_BAR_X: f32 = 3.0; // LineStatusMarkerDrawUtil: +1 brace + 2 (IDEA-286352)
pub const GUTTER_BAR_INSET_Y: f32 = 1.0; // y + 1, h - 2; arc = width (round ends)
pub const GUTTER_HOVER_EXTRA_WIDTH: f32 = 3.0; // the bar grows left on hover
pub const ANNOTATION_FG: Tok = Tok(135); // DCS ANNOTATIONS_COLOR
pub const ANNOTATION_LAST_COMMIT_FG: Tok = Tok(136); // DCS ANNOTATIONS_LAST_COMMIT_COLOR (new UI: regular weight)
pub const ANNOTATION_FONT_SIZE: f32 = 13.0; // EditorGutterComponentImpl.getFontForText new UI: JBFont.regular() (UI font)
pub const ANNOTATION_COLUMN_GAP: f32 = 5.0; // GAP_BETWEEN_ANNOTATIONS

// ---- Abe mode's GitHub views: abe's colours mapped onto Islands Dark's palette ----
// (EXP = expUI_dark.theme.json colour names)
pub const ABE_GOOD: Tok = Tok(137); // EXP Green8 (= GIT_ADDED): passed, approved
pub const ABE_BAD: Tok = Tok(138); // EXP Red7 (= TEXT_ERROR): failed, changes asked, blocked
pub const ABE_WARN: Tok = Tok(139); // EXP Yellow6: running, waiting, your review asked, group headings
/// Needs you (a workspace waiting on the user): its own hue, never red or `ABE_WARN` (1.0 design, 5-states.md).
pub const ABE_NEEDS_YOU: Tok = Tok(140); // teal (design token abe-needs-you)
/// The bottom pane's header: the divider between the pane's tabs and the Git tool
/// window's own: 1 × 16, 8 each side.
pub const PANE_GROUP_SEP_GAP: f32 = 8.0; // design .nv-group-sep mx 8
pub const PANE_GROUP_SEP_HEIGHT: f32 = 16.0; // design .nv-group-sep 1 × 16
/// A menu row's state dot column (All workspaces, W-05): the dot then 4 px.
pub const MENU_DOT_WIDTH: f32 = 14.0; // design .vs-ws-tab__dot + mr 4 at 12 px
/// The selected row's tooltip beside a popup (W-05).
pub const MENU_SIDE_TOOLTIP_GAP: f32 = 8.0; // design W-05 .side-tip left offset
/// The Starting dot's pulse: 1.2 s, opacity 1 → 0.35 → 1.
pub const STARTING_PULSE_SECS: f32 = 1.2; // design @keyframes vs-pulse
pub const STARTING_PULSE_MIN: f32 = 0.35; // design @keyframes vs-pulse 50%
/// A dialog button's key after its label (`.vs-button__key`): 6 px after it, dimmed.
pub const BUTTON_KEY_GAP: f32 = 6.0; // design .vs-button__key ml 6
pub const BUTTON_KEY_OPACITY: f32 = 0.7; // design .vs-button__key opacity .7
/// The flow dialog (`.vs-flow`, card-dialog look): sections 14 / 24 / 16, rows 28, footer 48.
pub const FLOW_HEAD_PAD_R: f32 = 8.0; // design .vs-flow__head padding-right 8
pub const FLOW_ROW_HEIGHT: f32 = 28.0; // design .vs-flow-row (WebStorm dialog list row 28)
pub const FLOW_FOOT_PAD_R: f32 = 16.0; // design .vs-flow__foot padding 0 16 0 24
pub const FLOW_FIELD_HEIGHT: f32 = 64.0; // W-31's New instruction area (3 lines)
pub const FLOW_WIDTH_CONFIRM: f32 = 560.0; // W-37 Stop agent
pub const FLOW_WIDTH_ARCHIVE: f32 = 520.0; // W-36 Archive workspace
pub const FLOW_WIDTH_DELETE: f32 = 640.0; // W-35 Delete working files
pub const FLOW_WIDTH_INSTRUCTIONS: f32 = 680.0; // W-31 Instructions
pub const FLOW_WIDTH_LAUNCHER: f32 = 700.0; // W-09 New workspace
pub const ABE_ACCENT: Tok = Tok(141); // EXP Blue9 (= LINK): ids, cards, keys
pub const ABE_PERSON: Tok = Tok(142); // EXP Purple (= GIT_MERGED): who said it (abe: magenta)
pub const ABE_PATH: Tok = Tok(143); // EXP Blue (= GIT_MODIFIED): files, branches (abe: cyan)
/// A badge's / mark's background alpha: its colour, faint.
pub const ABE_BADGE_ALPHA: f32 = 0.16; // own: abe faint badge wash (the colour at 16%)
/// A badge's / mark's background: its colour at `ABE_BADGE_ALPHA`.
pub const fn abe_badge_bg(c: Rgba) -> Rgba {
    Rgba {
        a: ABE_BADGE_ALPHA,
        ..c
    }
}
pub const ABE_COLUMN_CHAR_W: f32 = 7.0; // own: Inter 13px's average advance, for abe's column widths in characters

// ---------------------------------------------------------------- Abe board (kanban columns)
// Abe's colours keep their meaning (spec: Look), on Darcula Contrast / Islands values.

/// A column's background on the Board: the popups' and inactive tabs' Gray2.
pub const ABE_LANE_BG: Tok = Tok(144); // MID "EditorTabs.inactiveUnderlinedTabBackground"=Gray2 (darcula.lua bg_alt)
pub const ABE_LANE_ARC: f32 = 6.0; // approx: a little under an island's radius (ISLAND_ARC 8)
/// A card's title: abe's bright text.
pub const ABE_CARD_TITLE: Tok = Tok(145); // darcula.lua fg_bright = "*.selectionForeground" Gray12
/// A bug's type badge: abe's rose.
pub const ABE_BUG: Tok = Tok(146); // ISL FILESTATUS_UNKNOWN (rose)
/// A story's (and every other type's) badge: abe's slate.
pub const ABE_STORY: Tok = Tok(147); // darcula.lua text_ui_dim (Gray9)
/// Done: green.
pub const ABE_DONE: Tok = ABE_GOOD;
/// Story points: abe's cyan, Darcula's number blue.
pub const ABE_POINTS: Tok = Tok(148); // DCS DEFAULT_NUMBER
/// Tags: abe's yellow, Darcula's tag yellow.
pub const ABE_TAGS: Tok = Tok(149); // DCS HTML_TAG_NAME (darcula.lua tag)
/// A card in a swimlane (`ext`): abe's magenta, Darcula's field purple.
pub const ABE_LANE_MARK: Tok = Tok(150); // DCS DEFAULT_INSTANCE_FIELD
/// A boxed card (BoardCard, decided 21 Oct 2026): a step under its column, 1 px border in every
/// state so nothing shifts; 6 px apart and in from the column's edges.
pub const ABE_CARD_BG: Tok = FRAME_BG; // design --frame-bg #26282B
pub const ABE_CARD_BORDER: Tok = FIELD_BORDER; // design --field-border #43454A
pub const ABE_CARD_ARC: f32 = 4.0; // design --radius-4
pub const ABE_CARD_GAP: f32 = 6.0; // design BoardCard gap / BoardLane padding 0 6 6
pub const ABE_LANE_HEADER_PAD_X: f32 = 9.0; // design BoardLane header: 6 + 1 + 8 lines up with the card text
/// The card reading dialog (StoryTab, D-14): 840 × 700 centred, the Work column 296.
pub const ABE_DIALOG_WIDTH: f32 = 840.0; // design StoryTab frame
pub const ABE_DIALOG_HEIGHT: f32 = 700.0; // design StoryTab frame
pub const ABE_DIALOG_SIDE_WIDTH: f32 = 296.0; // design StoryTab Work column
pub const ABE_DIALOG_FOOTER_HEIGHT: f32 = 48.0; // design StoryTab footer
pub const ABE_DIALOG_TITLE_SIZE: f32 = 17.0; // design StoryTab head title 17 / 22, 600
pub const ABE_DIALOG_TITLE_LINE: f32 = 22.0; // ditto
pub const ABE_DIALOG_PAD_X: f32 = 24.0; // design StoryTab head padding 16 24 12

// A read-only file's lock on its tab (K-19; bundle.css .vs-ro-icon)
pub const TAB_LOCK_SIZE: f32 = 11.0; // literal: WebStorm's locked overlay, bottom-left at 11 px
pub const TAB_LOCK_OFFSET: f32 = 4.0; // literal: the overlay hangs 4 px off the icon's corner
pub const ACTIVITY_BAR_WIDTH: f32 = 48.; // VS Code's activity bar (ActivitybarPart.ACTION_HEIGHT 48), Feel vscode
pub const CRUMBS_HEIGHT: f32 = 22.; // VS Code's breadcrumbs bar (BreadcrumbsControl.HEIGHT), Feel vscode
pub const CRUMBS_PAD_X: f32 = 12.; // VS Code: .monaco-breadcrumbs padding-left 8 + the editor's gutter inset
pub const CLOUD_NOTICE_BG: Tok = Tok(151); // literal: ABE_ACCENT 10 % over EDITOR_BG (slim EditorNotificationPanel)

// ---- PR review in the Git Log (1.0 design, components/css/4-git.css) ----
pub const PR_STRIP_HEIGHT: f32 = 36.0; // .vs-pr-head (literal: proposed)
pub const PR_STRIP_PAD_LEFT: f32 = 10.0; // .vs-pr-head padding 0 8 0 10
pub const PR_STRIP_PAD_RIGHT: f32 = 8.0; // ditto
pub const PR_STRIP_GAP: f32 = 8.0; // .vs-pr-head gap
pub const PR_CHIP_HEIGHT: f32 = 20.0; // .vs-pr-chip
pub const PR_CHIP_PAD_X: f32 = 6.0; // ditto
pub const PR_CHIP_GAP: f32 = 6.0; // .vs-pr-head__chips gap
pub const PR_SMALL_FONT_SIZE: f32 = 12.0; // .vs-pr-chip / .vs-seg / marks font-size
pub const PR_HEAT_WIDTH: f32 = 12.0; // .vs-pr-file__heat
pub const PR_SCOPE_SEP_MARGIN_X: f32 = 12.0; // .vs-gitlog__scope-sep margin 2 12
pub const PR_SCOPE_SUM_WIDTH: f32 = 410.0; // .vs-gitlog-row__sum (author 205 + date 125 + hash 80)
pub const PR_DETAILS_TEXT_HEIGHT: f32 = 150.0; // GitLog details text h 150
pub const COMPACT_BUTTON_HEIGHT: f32 = 24.0; // .vs-button--compact (literal: proposed)
pub const COMPACT_BUTTON_PAD_X: f32 = 10.0; // ditto
pub const SEG_HEIGHT: f32 = 22.0; // .vs-seg (= ACTION_BUTTON_SIZE)
pub const SEG_ITEM_PAD_X: f32 = 8.0; // .vs-seg__item
pub const SEG_ITEM_ARC: f32 = 2.0; // --radius-2
// The flow dialog (.vs-flow, N03 card-dialog look): Submit review (G19), Create Draft PR (G20).
pub const FLOW_WIDTH: f32 = 600.0; // G19 flow width
pub const FLOW_WIDTH_WIDE: f32 = 640.0; // G20 Create Draft PR (LocalChanges README: 640, as N03)
pub const FLOW_TOP: f32 = 96.0; // approx: G19 dialog top under the toolbar
pub const FLOW_TITLE_HEIGHT: f32 = 34.0; // .vs-input-area__title h 34
pub const FLOW_SECTION_PAD_X: f32 = 24.0; // .vs-flow__section 14 / 24 / 16
pub const FLOW_SECTION_PAD_TOP: f32 = 14.0; // ditto
pub const FLOW_SECTION_PAD_BOTTOM: f32 = 16.0; // ditto
pub const FLOW_FOOT_HEIGHT: f32 = 48.0; // .vs-input-area__footer h 48
pub const FLOW_LABEL_WIDTH: f32 = 96.0; // .vs-flow__grid label column
pub const FLOW_CHOICE_HEIGHT: f32 = 66.0; // approx: G19 .vs-choice boxes
pub const FLOW_AREA_MIN_HEIGHT: f32 = 70.0; // approx: G19 summary area
pub const FLOW_AREA_TALL_HEIGHT: f32 = 162.0; // approx: G20 description area

// ---- Design-system tokens drawn by other modules (DS 2.0 `tokens.json`): their consts live here so a
// theme reaches them (`floats/style.rs`, `markdown/style.rs`, the status
// bar's mode badge) ----
pub const FLOAT_MENU_BG: Tok = Tok(152); // DCS LOOKUP_COLOR (LookupCellRenderer.BACKGROUND_COLOR beats the theme)
pub const FLOAT_MENU_FG: Tok = Tok(153); // MID "CompletionPopup.foreground"
pub const FLOAT_MENU_MATCH_FG: Tok = Tok(154); // EXP "CompletionPopup.matchForeground" / matchSelectionForeground
pub const FLOAT_DOC_BG: Tok = Tok(155); // DCS DOCUMENTATION_COLOR
pub const FLOAT_DOC_DIM_FG: Tok = Tok(156); // DocumentationHtmlUtil section labels
pub const FLOAT_INLINE_CODE_BG: Tok = Tok(157); // Gray10 15% over the doc bg
pub const FLOAT_SIGNATURE_BORDER: Tok = Tok(158); // editor bg blended 10% to gray
pub const FLOAT_SIGNATURE_ACTIVE_BG: Tok = Tok(159); // the active overload's row
pub const MD_CODE_BG: Tok = Tok(160); // preview CSS code bg rgba(212,222,231,.098)
pub const MD_QUOTE_BORDER: Tok = Tok(161); // preview CSS blockquote bar
pub const CHAT_CARD_BG: Tok = Tok(162); // 1.0's Copilot inline chat card (retired in 2.1; the slot stays for themes)
pub const CHAT_CARD_BORDER: Tok = Tok(163); // its border
pub const CHAT_ACCEPT_HOVER_BG: Tok = Tok(164); // InlineChatControlPanel hover
pub const CHAT_INLINE_CODE_BG: Tok = Tok(165); // inline code tint on the lighter card
pub const MODE_NORMAL_BG: Tok = Tok(166); // mode badge NORMAL (design)
pub const MODE_NORMAL_FG: Tok = Tok(167);
pub const MODE_INSERT_BG: Tok = Tok(168); // INSERT
pub const MODE_INSERT_FG: Tok = Tok(169);
pub const MODE_VISUAL_BG: Tok = Tok(170); // VISUAL
pub const MODE_VISUAL_FG: Tok = Tok(171);
pub const MODE_REPLACE_BG: Tok = Tok(172); // REPLACE
pub const MODE_REPLACE_FG: Tok = Tok(173);
pub const MODE_COMMAND_BG: Tok = Tok(174); // COMMAND
pub const MODE_COMMAND_FG: Tok = Tok(175);

// ---- Syntax (DS `--syntax-*`, Darcula Contrast's scheme): code drawn outside nvim, the rendered
// Chat's diff cards (factory/diff_card.rs) ----
pub const SYNTAX_KEYWORD: Tok = Tok(176); // DCS DEFAULT_KEYWORD (darcula.lua keyword)
pub const SYNTAX_STRING: Tok = Tok(177); // DCS DEFAULT_STRING
pub const SYNTAX_NUMBER: Tok = Tok(178); // DCS DEFAULT_NUMBER (= ABE_POINTS)
pub const SYNTAX_COMMENT: Tok = Tok(179); // DCS DEFAULT_LINE_COMMENT
pub const SYNTAX_FUNC: Tok = Tok(180); // DCS DEFAULT_FUNCTION_DECLARATION
pub const SYNTAX_FIELD: Tok = Tok(181); // DCS DEFAULT_INSTANCE_FIELD (= ABE_LANE_MARK)

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    /// (written as, the colour, its r g b a)
    const HEXES: &[(&str, Rgba, [f32; 4])] = &[
        (
            "0x26282B",
            hex(0x26282B),
            [
                0x26 as f32 / 255.0,
                0x28 as f32 / 255.0,
                0x2B as f32 / 255.0,
                1.0,
            ],
        ),
        ("0xFFFFFF", hex(0xFFFFFF), [1.0, 1.0, 1.0, 1.0]),
        (
            "0xFFFFFF16",
            hexa(0xFFFFFF16),
            [1.0, 1.0, 1.0, 0x16 as f32 / 255.0],
        ),
        (
            "0x00000020",
            hexa(0x00000020),
            [0.0, 0.0, 0.0, 0x20 as f32 / 255.0],
        ),
        (
            "0x191A1CFF, as opaque as hex",
            hexa(0x191A1CFF),
            [
                hex(0x191A1C).r,
                hex(0x191A1C).g,
                hex(0x191A1C).b,
                hex(0x191A1C).a,
            ],
        ),
    ];

    #[test]
    fn hex_and_hexa_unpack_their_channels() {
        for (name, c, [r, g, b, a]) in HEXES {
            assert!(
                close(c.r, *r) && close(c.g, *g) && close(c.b, *b) && close(c.a, *a),
                "{name}: {c:?}"
            );
        }
    }

    #[test]
    fn hsla_roundtrip_gray() {
        let h = hsla(PANEL_BG.rgba());
        assert!(close(h.s, 0.0) || h.s < 0.1);
        assert!(close(h.a, 1.0));
    }
}

// ---------------------------------------------------------------- the runtime palette

/// The palette as a runtime table: every colour const above is a [`Tok`] (an index), read through
/// the table in force, so a theme swaps colours live without touching a call site.
pub mod palette {
    use super::*;
    use std::sync::atomic::{AtomicPtr, Ordering};

    pub const COUNT: usize = 182;

    /// The consts' names, by index.
    pub const NAMES: [&str; COUNT] = [
        "FRAME_BG",
        "PANEL_BG",
        "EDITOR_BG",
        "EDITOR_FG",
        "EDITOR_SELECTION_BG",
        "EDITOR_CARET_ROW_BG",
        "EDITOR_LINE_NUMBER",
        "EDITOR_LINE_NUMBER_CURRENT",
        "ISLAND_BORDER",
        "BORDER",
        "SEPARATOR",
        "TEXT",
        "TEXT_DIM",
        "TEXT_DISABLED",
        "TEXT_ERROR",
        "TEXT_WARNING",
        "TEXT_SUCCESS",
        "LINK",
        "SELECTION_BG",
        "SELECTION_BG_INACTIVE",
        "SELECTION_TEXT",
        "HOVER_BG",
        "SEARCH_MATCH_BG",
        "SEARCH_MATCH_FG",
        "SPEED_SEARCH_BG",
        "SPEED_SEARCH_BORDER",
        "SPEED_SEARCH_FG",
        "SPEED_SEARCH_ERROR_FG",
        "EXCLUDED_ROW_BG",
        "POPUP_BG",
        "POPUP_BORDER",
        "POPUP_SHADOW",
        "POPUP_HEADER_BG",
        "POPUP_AD_FG",
        "POPUP_AD_BG",
        "TAB_STRIP_BG",
        "TAB_STRIP_BORDER",
        "TAB_SELECTED_BG",
        "TAB_SELECTED_BORDER",
        "TAB_SELECTED_INACTIVE_BG",
        "TAB_SELECTED_INACTIVE_BORDER",
        "TAB_HOVER_BG",
        "TAB_TEXT",
        "TAB_TEXT_INACTIVE",
        "TAB_ERROR_UNDERLINE",
        "TREE_PROBLEM_UNDERLINE",
        "EMPTY_HINT_TEXT",
        "STATUS_BAR_TEXT_INACTIVE",
        "TOOLBAR_BG",
        "TOOLBAR_BUTTON_HOVER_BG",
        "TOOLBAR_BUTTON_PRESSED_BG",
        "TOOLBAR_TITLE_FG",
        "POPUP_CAPTION_FG",
        "STATUS_BAR_BG",
        "STATUS_BAR_TEXT",
        "STATUS_BAR_HOVER_BG",
        "TOOLTIP_BG",
        "TOOLTIP_FG",
        "TOOLTIP_BORDER",
        "TOOLTIP_SHORTCUT_FG",
        "BALLOON_BG",
        "BALLOON_FG",
        "BALLOON_BORDER",
        "BALLOON_SHADOW",
        "FIELD_BG",
        "FIELD_BORDER",
        "FOCUS_BORDER",
        "CARET",
        "FIELD_SELECTION_BG",
        "PLACEHOLDER",
        "MENU_SHORTCUT_FG",
        "MENU_SHORTCUT_SELECTED_FG",
        "MENU_DISABLED_FG",
        "SCROLLBAR_THUMB",
        "SCROLLBAR_THUMB_HOVER",
        "GIT_MODIFIED",
        "GIT_ADDED",
        "GIT_UNTRACKED",
        "GIT_IGNORED",
        "GIT_DELETED",
        "GIT_CONFLICT",
        "GIT_RENAMED",
        "GIT_MERGED",
        "TOOLWINDOW_HEADER_BORDER",
        "TOOLWINDOW_TAB_SELECTED_BG",
        "TOOLWINDOW_TAB_SELECTED_BORDER",
        "TOOLWINDOW_TAB_SELECTED_INACTIVE_BG",
        "TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER",
        "TOOLWINDOW_TAB_HOVER_BG",
        "ACTION_BUTTON_HOVER_BG",
        "ACTION_BUTTON_TOGGLED_BG",
        "TOOLBAR_SEPARATOR",
        "SEARCH_FIELD_TOGGLE_ON_BG",
        "SEARCH_FIELD_TOGGLE_ON_HOVER_BG",
        "REPLACE_BAR_BG",
        "REPLACE_BAR_BORDER",
        "FILTER_CHIP_NAME_FG",
        "SPLITTER_LINE",
        "STRIPE_HOVER_BG",
        "CHANGES_COUNT_FG",
        "BUTTON_BG",
        "BUTTON_BORDER",
        "BUTTON_PRIMARY_BG",
        "BUTTON_PRIMARY_BORDER",
        "BUTTON_PRIMARY_FG",
        "BUTTON_DISABLED_BG",
        "BUTTON_DISABLED_BORDER",
        "BUTTON_DANGER_BG",
        "BUTTON_DANGER_FG",
        "BUTTON_DANGER_TEXT",
        "BUTTON_DANGER_BORDER",
        "COMMIT_MESSAGE_PLACEHOLDER",
        "COMMIT_MESSAGE_BORDER",
        "VCS_LOG_HOVER_BG",
        "VCS_LOG_CURRENT_BRANCH_BG",
        "VCS_LOG_UNMATCHED_FG",
        "VCS_DETAILS_COMMITTER_FG",
        "VCS_REF_HEAD",
        "VCS_REF_LOCAL",
        "VCS_REF_REMOTE",
        "VCS_REF_TAG",
        "VCS_REF_OTHER",
        "VCS_REF_TEXT_FG",
        "DIFF_INSERTED_BG",
        "DIFF_DELETED_BG",
        "DIFF_MODIFIED_BG",
        "DIFF_CONFLICT_BG",
        "DIFF_INSERTED_STRIPE",
        "DIFF_DELETED_STRIPE",
        "DIFF_MODIFIED_STRIPE",
        "DIFF_CONFLICT_STRIPE",
        "MERGE_DONE_FG",
        "GUTTER_ADDED",
        "GUTTER_MODIFIED",
        "GUTTER_DELETED",
        "ANNOTATION_FG",
        "ANNOTATION_LAST_COMMIT_FG",
        "ABE_GOOD",
        "ABE_BAD",
        "ABE_WARN",
        "ABE_NEEDS_YOU",
        "ABE_ACCENT",
        "ABE_PERSON",
        "ABE_PATH",
        "ABE_LANE_BG",
        "ABE_CARD_TITLE",
        "ABE_BUG",
        "ABE_STORY",
        "ABE_POINTS",
        "ABE_TAGS",
        "ABE_LANE_MARK",
        "CLOUD_NOTICE_BG",
        "FLOAT_MENU_BG",
        "FLOAT_MENU_FG",
        "FLOAT_MENU_MATCH_FG",
        "FLOAT_DOC_BG",
        "FLOAT_DOC_DIM_FG",
        "FLOAT_INLINE_CODE_BG",
        "FLOAT_SIGNATURE_BORDER",
        "FLOAT_SIGNATURE_ACTIVE_BG",
        "MD_CODE_BG",
        "MD_QUOTE_BORDER",
        "CHAT_CARD_BG",
        "CHAT_CARD_BORDER",
        "CHAT_ACCEPT_HOVER_BG",
        "CHAT_INLINE_CODE_BG",
        "MODE_NORMAL_BG",
        "MODE_NORMAL_FG",
        "MODE_INSERT_BG",
        "MODE_INSERT_FG",
        "MODE_VISUAL_BG",
        "MODE_VISUAL_FG",
        "MODE_REPLACE_BG",
        "MODE_REPLACE_FG",
        "MODE_COMMAND_BG",
        "MODE_COMMAND_FG",
        "SYNTAX_KEYWORD",
        "SYNTAX_STRING",
        "SYNTAX_NUMBER",
        "SYNTAX_COMMENT",
        "SYNTAX_FUNC",
        "SYNTAX_FIELD",
    ];

    /// The built-in values (Islands Dark).
    pub const BUILT_IN: [Rgba; COUNT] = [
        hex(0x26282B),
        hex(0x191A1C),
        hex(0x1E1F22),
        hex(0xA9B7C6),
        hex(0x214283),
        hex(0x2B2D30),
        hex(0x4E5157),
        hex(0x9DA0A8),
        hex(0x191A1C),
        hex(0x26282B),
        hex(0x323438),
        hex(0xD1D3D9),
        hex(0x6F737A),
        hex(0x5A5D63),
        hex(0xDB5C5C),
        hex(0xBA9752),
        hex(0x5FAD65),
        hex(0x6B9BFA),
        hex(0x2E436E),
        hex(0x393B40),
        hex(0xDFE1E5),
        hex(0x393B40),
        hex(0xBA9752),
        hex(0x000000),
        hex(0x191A1C),
        hex(0x323438),
        hex(0xD1D3D9),
        hex(0xDB5C5C),
        hex(0x291F1C),
        hex(0x26282B),
        hex(0x323438),
        hexa(0x00000020),
        hex(0x26282B),
        hex(0x868A91),
        hex(0x26282B),
        hex(0x191A1C),
        hex(0x26282B),
        hex(0x25324D),
        hex(0x35538F),
        hex(0x2B2D30),
        hex(0x43454A),
        hex(0x2B2D30),
        hex(0xD1D3D9),
        hex(0xAFB1B6),
        hex(0xDB5C5C),
        hex(0xFA6675),
        hex(0x868A91),
        hex(0x85888F),
        hex(0x26282B),
        hexa(0xFFFFFF16),
        hexa(0xFFFFFF26),
        hex(0xDFE1E5),
        hex(0x6F737A),
        hex(0x26282B),
        hex(0x9DA0A8),
        hexa(0xFFFFFF18),
        hex(0x323438),
        hex(0xF0F1F2),
        hex(0x323438),
        hex(0x9DA0A8),
        hex(0x323438),
        hex(0xF0F1F2),
        hex(0x323438),
        hexa(0x00000010),
        hex(0x191A1C),
        hex(0x43454A),
        hex(0x3574F0),
        hex(0xBBBBBB),
        hex(0x2E436E),
        hex(0x6F737A),
        hex(0x6F737A),
        hex(0xBBBBBB),
        hex(0x5A5D63),
        hexa(0x80808059),
        hexa(0x8080808C),
        hex(0x70AEFF),
        hex(0x73BD79),
        hex(0xE88F89),
        hex(0xD69A6B),
        hex(0x6F737A),
        hex(0xDE6A66),
        hex(0x70AEFF),
        hex(0xCF84CF),
        hex(0x26282B),
        hex(0x25324D),
        hex(0x35538F),
        hex(0x2B2D30),
        hex(0x43454A),
        hex(0x2B2D30),
        hex(0x393B40),
        hexa(0xFFFFFF26),
        hex(0x323438),
        hex(0x35538F),
        hex(0x375FAD),
        hex(0x212224),
        hex(0x26282B),
        hex(0x6F737A),
        hex(0x26282B),
        hexa(0x0F0F0F28),
        hex(0x6F737A),
        hexa(0x00000000),
        hex(0x4E5157),
        hex(0x3574F0),
        hex(0x3574F0),
        hex(0xFFFFFF),
        hexa(0x00000000),
        hex(0x393B40),
        hex(0xBD5757),
        hex(0xFFFFFF),
        hex(0xDB5C5C),
        hex(0x9C4E4E),
        hex(0x6F737A),
        hex(0x43454A),
        hex(0x292A2C),
        hex(0x283044),
        hex(0x808080),
        hex(0x808080),
        hex(0xF5D273),
        hex(0x5FAD65),
        hex(0xB589EC),
        hex(0x868A91),
        hex(0x868A91),
        hex(0x6F737A),
        hex(0x294436),
        hex(0x484A4A),
        hex(0x385570),
        hex(0x45302B),
        hex(0x447152),
        hex(0x656E76),
        hex(0x43698D),
        hex(0x8F5247),
        hex(0x57965C),
        hex(0x549159),
        hex(0x375FAD),
        hex(0x868A91),
        hex(0x8D9199),
        hex(0xCED0D6),
        hex(0x73BD79),
        hex(0xDB5C5C),
        hex(0xD6AE58),
        hex(0x5EC8C0),
        hex(0x6B9BFA),
        hex(0xCF84CF),
        hex(0x70AEFF),
        hex(0x2B2D30),
        hex(0xDFE1E5),
        hex(0xE88F89),
        hex(0x9DA0A8),
        hex(0x6897BB),
        hex(0xE8BF6A),
        hex(0x9876AA),
        hex(0x262B38),
        hex(0x2B2D30),
        hex(0xB4B8BF),
        hex(0x548AF7),
        hex(0x2B2D30),
        hex(0x868A91),
        hex(0x3F4145),
        hex(0x313234),
        hex(0x252D26),
        hexa(0xD4DEE719),
        hexa(0x6B9BFA66),
        hex(0x43454A),
        hex(0x4D4D4D),
        hex(0x366ACF),
        hex(0x55575C),
        hex(0x393B40),
        hex(0xCED0D6),
        hex(0x2E436E),
        hex(0xDFE1E5),
        hex(0x433358),
        hex(0xDFE1E5),
        hex(0x5E3838),
        hex(0xDFE1E5),
        hex(0x43454A),
        hex(0xDFE1E5),
        hex(0xCC7832),
        hex(0x6A8759),
        hex(0x6897BB),
        hex(0x808080),
        hex(0xFFC66D),
        hex(0x9876AA),
    ];

    static BUILT_IN_TABLE: [Rgba; COUNT] = BUILT_IN;
    static TABLE: AtomicPtr<[Rgba; COUNT]> = AtomicPtr::new(std::ptr::null_mut());

    fn table() -> &'static [Rgba; COUNT] {
        let p = TABLE.load(Ordering::Acquire);
        if p.is_null() {
            &BUILT_IN_TABLE
        } else {
            unsafe { &*p }
        }
    }

    /// Puts a whole table in force (leaked: a theme change is rare and a table is 4 KB).
    pub fn set(values: [Rgba; COUNT]) {
        TABLE.store(Box::into_raw(Box::new(values)), Ordering::Release);
    }

    static DARK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

    /// Whether the theme in force is a dark one (its `dark` flag; Islands Dark until a look says
    /// otherwise): which of WebStorm's icon sets draws (`ui::icons`).
    pub fn dark() -> bool {
        DARK.load(Ordering::Relaxed)
    }

    /// Puts a theme's dark / light kind in force.
    pub fn set_dark(dark: bool) {
        DARK.store(dark, Ordering::Relaxed);
    }

    /// A colour of the palette: copy it like the `Rgba` it stands for.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct Tok(pub u16);

    impl Tok {
        pub fn rgba(self) -> Rgba {
            table()[self.0 as usize]
        }
        pub fn name(self) -> &'static str {
            NAMES[self.0 as usize]
        }
    }
    impl std::ops::Deref for Tok {
        type Target = Rgba;
        fn deref(&self) -> &Rgba {
            &table()[self.0 as usize]
        }
    }
    impl From<Tok> for Rgba {
        fn from(t: Tok) -> Rgba {
            t.rgba()
        }
    }
    impl From<Tok> for Hsla {
        fn from(t: Tok) -> Hsla {
            t.rgba().into()
        }
    }
    impl From<Tok> for gpui_kit::Fill {
        fn from(t: Tok) -> gpui_kit::Fill {
            t.rgba().into()
        }
    }
    impl From<Tok> for gpui_kit::Background {
        fn from(t: Tok) -> gpui_kit::Background {
            t.rgba().into()
        }
    }
}

// ---------------------------------------------------------------- density

/// The metrics WebStorm's compact and default densities differ in: each const above is a [`Met`]
/// (an index), read in the density in force, so `ui.density` switches them live.
pub mod density {
    use std::sync::atomic::{AtomicBool, Ordering};

    pub const COUNT: usize = 22;

    /// The consts' names, by index.
    pub const NAMES: [&str; COUNT] = [
        "ISLAND_ARC",
        "ISLAND_GAP",
        "ISLAND_CONTENT_INSET",
        "TREE_ROW_HEIGHT",
        "TREE_PAD_X",
        "TREE_PAD_Y",
        "TOOL_WINDOW_HEADER_HEIGHT",
        "LIST_ROW_HEIGHT",
        "POPUP_AD_PADDING_TOP",
        "POPUP_AD_PADDING_BOTTOM",
        "TAB_BOX_HEIGHT",
        "TAB_BOX_INSET_X",
        "TAB_ARC",
        "TAB_FONT_SIZE",
        "TOOLBAR_HEIGHT",
        "TOOLBAR_BUTTON_SIZE",
        "TOOLBAR_BUTTON_ARC",
        "TOOLBAR_FONT_SIZE",
        "STATUS_BAR_HEIGHT",
        "ACTION_TOOLBAR_PAD_X",
        "COMMIT_PANEL_PAD_X",
        "VCS_LOG_ROW_HEIGHT",
    ];

    /// Compact (the user's `UI_DENSITY=COMPACT`): the values above.
    pub const COMPACT: [f32; COUNT] = [
        8.0, 3.0, 1.0, 22.0, 8.0, 2.0, 31.0, 22.0, 4.0, 5.0, 24.0, 2.0, 4.0, 12.0, 30.0, 26.0, 4.0,
        12.0, 23.0, 4.0, 6.0, 24.0,
    ];

    /// Default density: the `default N` of each const's source note.
    pub const DEFAULT: [f32; COUNT] = [
        10.0, 5.0, 0.0, 24.0, 12.0, 4.0, 41.0, 24.0, 6.0, 6.0, 28.0, 4.0, 6.0, 13.0, 40.0, 30.0,
        6.0, 13.0, 28.0, 7.0, 12.0, 26.0,
    ];

    static ROOMY: AtomicBool = AtomicBool::new(false);

    /// Whether WebStorm's default density is in force (else compact).
    pub fn is_default() -> bool {
        ROOMY.load(Ordering::Relaxed)
    }

    /// Puts default density (true) or compact (false) in force.
    pub fn set_default(on: bool) {
        ROOMY.store(on, Ordering::Relaxed);
    }

    /// A density metric: copy it like the `f32` it stands for ([`Met::get`]); arithmetic with
    /// `f32` gives an `f32`.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct Met(pub u8);

    impl Met {
        pub fn get(self) -> f32 {
            if is_default() {
                DEFAULT[self.0 as usize]
            } else {
                COMPACT[self.0 as usize]
            }
        }
        pub fn name(self) -> &'static str {
            NAMES[self.0 as usize]
        }
    }
    impl From<Met> for f32 {
        fn from(m: Met) -> f32 {
            m.get()
        }
    }
    macro_rules! ops {
        ($($tr:ident $f:ident),*) => {$(
            impl std::ops::$tr<f32> for Met {
                type Output = f32;
                fn $f(self, o: f32) -> f32 { std::ops::$tr::$f(self.get(), o) }
            }
            impl std::ops::$tr<Met> for f32 {
                type Output = f32;
                fn $f(self, o: Met) -> f32 { std::ops::$tr::$f(self, o.get()) }
            }
            impl std::ops::$tr<Met> for Met {
                type Output = f32;
                fn $f(self, o: Met) -> f32 { std::ops::$tr::$f(self.get(), o.get()) }
            }
        )*};
    }
    ops!(Add add, Sub sub, Mul mul, Div div);
    impl std::ops::Neg for Met {
        type Output = f32;
        fn neg(self) -> f32 {
            -self.get()
        }
    }
    impl PartialEq<f32> for Met {
        fn eq(&self, o: &f32) -> bool {
            self.get() == *o
        }
    }
    impl PartialOrd<f32> for Met {
        fn partial_cmp(&self, o: &f32) -> Option<std::cmp::Ordering> {
            self.get().partial_cmp(o)
        }
    }
    impl PartialEq<Met> for f32 {
        fn eq(&self, o: &Met) -> bool {
            *self == o.get()
        }
    }
    impl PartialOrd<Met> for f32 {
        fn partial_cmp(&self, o: &Met) -> Option<std::cmp::Ordering> {
            self.partial_cmp(&o.get())
        }
    }
}
