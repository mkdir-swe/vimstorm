//! The widget kit of the native chrome (tree, tabs, status bar, toolbar, menus,
//! pickers, switcher, balloons, floats, the Git tool window): WebStorm New UI, Islands Dark.

/// Abe's head and glyph, in their own palette.
mod abe_mark;
/// Toolbar icon buttons (ActionButton), toolbars, separators.
mod button;
/// Changes tree (Local Changes, commit details): folders, checkboxes, status colors.
mod changes_tree;
/// Checkbox (WS SVGs, tri-state).
mod checkbox;
/// VCS log filter chips ("Branch: HEAD ×", "User ⌄").
mod chip;
/// Single-line text field (IME, selection, clipboard, word moves).
mod field;
/// An element built once its width is known: a row that keeps whole words (`fit_line`).
mod fit;
/// WebStorm's SVG icons in their own colors + the file -> icon mapping.
mod icons;
/// Field / list keys: GPUI key events -> nvim notation.
mod keys;
/// Virtual list: WS rows and selection, his keys, multi-select, search after `/`.
mod list;
/// Popup frame and placement.
mod popup;
/// The pulse (a Starting dot, a running mark).
mod pulse;
/// VCS log ref labels (branch / tag icons + names).
mod ref_label;
/// Search field with `.*` / `Cc` toggles.
mod search_field;
/// Draggable split between two panes.
mod splitter;
/// Collapsed vertical side strip ("Branches").
mod stripe;
/// Text widths and wording ("2 files").
mod text;
/// Multi-line text area (commit message).
mod text_area;
/// Tool window header: title + content tabs.
mod tool_tabs;
/// Help tooltip ("Show Diff ⌘D").
mod tooltip;
/// Vim key layer of lists (counts, gg / G, yy / dd / rr).
mod vim;

pub use abe_mark::{Head, head};
pub use button::{Axis, IconButton, TextButton, separator as toolbar_separator, toolbar};
pub use changes_tree::{
    ChangeFile, ChangeGroup, ChangeStatus, ChangesTree, ChangesTreeEvent, RowKind, count,
};
pub(crate) use changes_tree::{chevron_x, copy_paths};
pub use checkbox::{CheckState, Checkbox, check_box, checkbox_icon};
pub use chip::FilterChip;
pub use field::{FieldEvent, TextField};
pub use fit::fit;
pub(crate) use fit::fit_line;
pub use icons::{Icon, IconName, for_file, for_filetype, image};
pub(crate) use keys::typed_text;
pub use keys::{label, notation, notation_of};
pub use list::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, SearchMode, highlighted,
    match_text,
};
pub(crate) use list::{ListOutcome, MatchedText, char_ranges, selection_corners};
pub(crate) use popup::{
    ANCHOR_GAP, complex_header, placed, separator as popup_separator, wrapped_header,
};
pub use popup::{Anchor, ad_text, centered, frame as popup_frame, header, place, shadow};
pub(crate) use pulse::pulsing;
pub use ref_label::{RefKind, RefLabel};
pub use search_field::{SearchField, SearchFieldEvent};
pub use splitter::{Fixed, SplitAxis, SplitEvent, SplitState, split};
pub use stripe::{CollapsedStripe, VerticalLabel};
pub use text::width;
pub(crate) use text::{plural, width_in, wrap_with};
pub(crate) use text_area::TextAreaEvent;
pub use text_area::{TextArea, TextAreaStyle};
pub(crate) use tool_tabs::{
    LeadItem, LeadMenuEvent, PaneLead, PaneLeadEvent, ToolAction, ToolActionEvent,
};
pub use tool_tabs::{ToolTab, ToolTabs, ToolTabsEvent};
pub(crate) use tooltip::frame as tooltip_frame;
pub use tooltip::tooltip;
pub(crate) use vim::Step;
pub use vim::{Cmd, Vim};
