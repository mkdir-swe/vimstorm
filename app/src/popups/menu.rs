//! The context menu (also `vim.ui.select`): WebStorm's popup menu rows (icon column, label,
//! dimmed shortcut right-aligned, 9 px separators, rounded selection), `config/menu.lua`'s keys
//! through the shared list model (`ui::list::ListState`: arrows, wrap, typing filters at once).
//!
//! Two looks, like WebStorm: [`MenuStyle::Context`] is the right-click JPopupMenu (24 px row
//! pitch, an 18 px check-icon column, shortcuts 13 px from the edge; IdeaPopupMenuUI /
//! BegMenuItemUI) and [`MenuStyle::List`] the titled ListPopup (`vim.ui.select`, confirmations;
//! PopupListElementRenderer: 22 px rows, the list popup insets, group captions).

use std::ops::Range;

use gpui_kit::{
    AnyElement, Context, FontWeight, HighlightStyle, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Rgba,
    ScrollHandle, ScrollWheelEvent, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledText, Window, deferred, div, point, prelude::FluentBuilder as _, px, size,
};
use serde::Deserialize;

use super::{Done, MenuOutcome, PopupsView, file_icon, label_icon, named_icon, text_width};
use crate::kit::{self, Anchor};
use crate::kit::{Icon, IconName};
use crate::kit::{ListOptions, ListOutcome, ListSource, ListState, char_ranges};
use crate::look;

/// One clickable row.
#[derive(Clone, Debug, Default)]
pub struct MenuItem {
    pub label: SharedString,
    /// Shown dimmed on the right ("⌘C", ",v"); "›" draws a submenu chevron.
    pub shortcut: Option<SharedString>,
    pub icon: Option<IconName>,
    /// false: greyed out, can't be selected.
    pub enabled: bool,
    /// Colored / bold byte ranges of the label (usages: syntax, the usage bold).
    pub highlights: Vec<Highlight>,
    /// A state dot before the label in its colour; `true`: it pulses (Starting; W-05).
    pub dot: Option<(Rgba, bool)>,
    /// A column between the label and the right one, aligned across rows: a state word in its
    /// colour (All workspaces, W-05).
    pub state: Option<(SharedString, Rgba)>,
    /// Shown in a tooltip beside the popup while this row is selected (W-05: `name · state ·
    /// env · ⏎ shows it`).
    pub tooltip: Option<SharedString>,
}

#[derive(Clone, Debug, Default)]
pub struct Highlight {
    pub range: Range<usize>,
    pub color: Option<Rgba>,
    pub bold: bool,
}

impl MenuItem {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            enabled: true,
            ..Self::default()
        }
    }

    pub fn shortcut(mut self, s: impl Into<SharedString>) -> Self {
        self.shortcut = Some(s.into());
        self
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
}

#[derive(Clone, Debug)]
pub enum MenuEntry {
    Item(MenuItem),
    Separator,
    /// Text the menu only says (P-12: "No recent searches", what a choice will copy): dim lines
    /// that wrap, never a grey item; not selectable, not searched.
    Info(SharedString),
}

/// Which WebStorm popup a menu looks like (see the module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuStyle {
    Context,
    List,
}

impl From<MenuItem> for MenuEntry {
    fn from(item: MenuItem) -> Self {
        MenuEntry::Item(item)
    }
}

/// A menu to open ([`super::open_menu`]).
#[derive(Clone, Debug)]
pub struct Menu {
    pub entries: Vec<MenuEntry>,
    pub anchor: Anchor,
    /// Header row (vim.ui.select's prompt, "Usages of x").
    pub title: Option<SharedString>,
    /// Colored / bold ranges of the title (usages: the name).
    pub title_highlights: Vec<Highlight>,
    /// The header's right part ("3 usages").
    pub header_right: Option<SharedString>,
    pub header_right_highlights: Vec<Highlight>,
    /// Rows shown at most; more scroll.
    pub max_rows: Option<usize>,
    /// Longer labels are cut with "…".
    pub max_width: Option<Pixels>,
    /// The speed search matches the shortcut column too (usages: the file name).
    pub search_shortcuts: bool,
    /// None: [`MenuStyle::List`] with a title, else [`MenuStyle::Context`].
    pub style: Option<MenuStyle>,
    /// Group captions over separators (entry index -> caption; List popups'
    /// GroupHeaderSeparator).
    pub captions: Vec<(usize, SharedString)>,
}

impl Menu {
    pub fn new(entries: Vec<MenuEntry>, anchor: Anchor) -> Self {
        Self {
            entries,
            anchor,
            title: None,
            title_highlights: Vec::new(),
            header_right: None,
            header_right_highlights: Vec::new(),
            max_rows: None,
            max_width: None,
            search_shortcuts: false,
            style: None,
            captions: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn effective_style(&self) -> MenuStyle {
        self.style.unwrap_or(if self.title.is_some() {
            MenuStyle::List
        } else {
            MenuStyle::Context
        })
    }

    fn caption(&self, ix: usize) -> Option<&SharedString> {
        self.captions.iter().find(|(i, _)| *i == ix).map(|(_, c)| c)
    }

    fn item(&self, ix: usize) -> Option<&MenuItem> {
        match self.entries.get(ix)? {
            MenuEntry::Item(i) => Some(i),
            MenuEntry::Separator | MenuEntry::Info(_) => None,
        }
    }

    fn info(&self, ix: usize) -> Option<&SharedString> {
        match self.entries.get(ix)? {
            MenuEntry::Info(t) => Some(t),
            _ => None,
        }
    }
}

impl ListSource for Menu {
    fn len(&self) -> usize {
        self.entries.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        match self.item(ix) {
            Some(i) => match (&i.shortcut, self.search_shortcuts) {
                (Some(s), true) => format!("{} {s}", i.label).into(),
                _ => i.label.clone(),
            },
            None => SharedString::default(),
        }
    }

    fn selectable(&self, ix: usize) -> bool {
        self.item(ix).is_some_and(|i| i.enabled)
    }
}

/// A menu row from Lua (`config/app/menu.lua`).
#[derive(Debug, Default, Deserialize)]
pub(super) struct LuaItem {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    sep: bool,
    /// An info line (`{ info = "text" }`): said, never chosen.
    #[serde(default)]
    info: Option<String>,
    /// A file's icon (usages rows).
    #[serde(default)]
    file: Option<String>,
    /// The item's own icon, by name (config/app/menu.lua maps its glyph: "ts", "editor_only"...).
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    hl: Vec<LuaHl>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct LuaHl {
    s: usize,
    e: usize,
    #[serde(default)]
    fg: Option<u32>,
    #[serde(default)]
    bold: bool,
}

impl LuaItem {
    /// A separator's group caption (`{ sep = true, label = "Recent" }`).
    pub(super) fn caption(&self) -> Option<SharedString> {
        self.sep
            .then(|| self.label.clone().filter(|l| !l.is_empty()))
            .flatten()
            .map(Into::into)
    }

    /// `label_icons`: WebStorm's icon by label (menu.lua's ICONS; off for vim.ui.select).
    pub(super) fn into_entry(self, label_icons: bool) -> MenuEntry {
        if self.sep {
            return MenuEntry::Separator;
        }
        if let Some(text) = self.info {
            return MenuEntry::Info(text.into());
        }
        let mut label = self.label.unwrap_or_default();
        let shortcut = self.key.filter(|k| !k.is_empty());
        // "Bookmarks ›" with the submenu shortcut "›": the drawn chevron is enough
        if shortcut.as_deref() == Some("›") && label.ends_with('›') {
            label = label.trim_end_matches('›').trim_end().to_string();
        }
        let icon = self
            .file
            .as_deref()
            .map(file_icon)
            .or_else(|| label_icons.then(|| label_icon(&label)).flatten())
            .or_else(|| self.icon.as_deref().and_then(named_icon));
        MenuEntry::Item(MenuItem {
            icon,
            shortcut: shortcut.map(Into::into),
            enabled: self.enabled.unwrap_or(true),
            highlights: highlights(self.hl),
            label: label.into(),
            ..Default::default()
        })
    }
}

/// Lua's `{ s, e, fg, bold }` byte ranges.
pub(super) fn highlights(hl: Vec<LuaHl>) -> Vec<Highlight> {
    hl.into_iter()
        .map(|h| Highlight {
            range: h.s..h.e,
            color: h.fg.map(look::hex),
            bold: h.bold,
        })
        .collect()
}

/// The open menu.
pub(super) struct MenuPopup {
    menu: Menu,
    state: ListState,
    opts: ListOptions,
    pub(super) done: Done<MenuOutcome>,
    /// Lua's menu id (None: a Rust caller's).
    pub(super) lua_id: Option<u64>,
    /// A press landed inside: a release on a row runs it (not the release of the click that
    /// opened it).
    pub(super) pressed: bool,
    /// Top-left, fixed once placed: filtering shrinks the menu in place.
    origin: Point<Pixels>,
    width: Pixels,
    /// Some row has an icon: they all get the icon column.
    icons: bool,
    style: MenuStyle,
    /// The title's lines: more than one when the question is wider than the popup (P-12).
    title_lines: Vec<SharedString>,
    /// Each info entry's lines as wrapped to the popup's width (empty for other entries).
    info_lines: Vec<Vec<SharedString>>,
    scroll: ScrollHandle,
    /// The list's scroll offset as last drawn: the wheel moves the selection, not the list.
    last_offset: Point<Pixels>,
    /// Trackpad pixels not yet a whole row.
    wheel: Pixels,
    /// The rows' state column width (none: no row has a state word).
    state_w: Pixels,
}

/// A style's row geometry (px; x from the frame's inner edge, i.e. inside the 1 px border).
struct Geo {
    /// An item row's height (the selection is `pitch - 2 * sel_y`).
    pitch: f32,
    sel_x: f32,
    sel_y: f32,
    /// Content start with an icon column / without one, content end from the right.
    left: f32,
    left_no_icon: f32,
    right: f32,
    /// The icon column (icon centred) before the label's gap.
    icon_col: f32,
    shortcut_gap: f32,
    /// Label -> submenu chevron.
    arrow_gap: f32,
    sep_inset: f32,
}

const CONTEXT: Geo = Geo {
    pitch: look::MENU_CONTEXT_ROW_PITCH,
    sel_x: look::MENU_CONTEXT_SELECTION_X,
    sel_y: look::MENU_CONTEXT_SELECTION_Y,
    left: look::MENU_CONTEXT_CONTENT_X,
    left_no_icon: look::MENU_CONTEXT_NO_ICON_X,
    right: look::MENU_CONTEXT_CONTENT_X,
    icon_col: look::MENU_CONTEXT_ICON_COL,
    shortcut_gap: look::MENU_CONTEXT_SHORTCUT_GAP,
    arrow_gap: look::MENU_CONTEXT_SHORTCUT_GAP,
    sep_inset: look::MENU_CONTEXT_SEPARATOR_INSET_X,
};

const LIST: Geo = Geo {
    pitch: look::density::COMPACT[look::LIST_ROW_HEIGHT.0 as usize],
    sel_x: look::LIST_ROW_INSET_X,
    sel_y: 0.,
    left: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    left_no_icon: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    right: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    icon_col: look::ICON_SIZE,
    shortcut_gap: look::MENU_SHORTCUT_GAP,
    arrow_gap: look::MENU_LIST_ARROW_GAP,
    sep_inset: look::POPUP_SEPARATOR_INSET_X,
};
/// [`LIST`] at WebStorm's default density.
const LIST_ROOMY: Geo = Geo {
    pitch: look::density::DEFAULT[look::LIST_ROW_HEIGHT.0 as usize],
    sel_x: look::LIST_ROW_INSET_X,
    sel_y: 0.,
    left: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    left_no_icon: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    right: look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X,
    icon_col: look::ICON_SIZE,
    shortcut_gap: look::MENU_SHORTCUT_GAP,
    arrow_gap: look::MENU_LIST_ARROW_GAP,
    sep_inset: look::POPUP_SEPARATOR_INSET_X,
};

fn geo(style: MenuStyle) -> &'static Geo {
    match style {
        MenuStyle::Context => &CONTEXT,
        MenuStyle::List if look::density::is_default() => &LIST_ROOMY,
        MenuStyle::List => &LIST,
    }
}

impl MenuPopup {
    pub(super) fn new(
        menu: Menu,
        done: Done<MenuOutcome>,
        lua_id: Option<u64>,
        window: &mut Window,
    ) -> Self {
        let mut state = ListState::new();
        state.refresh(&menu);
        let first = (0..menu.len()).find(|&i| menu.selectable(i));
        state.set_cursor(first);
        let icons = menu
            .entries
            .iter()
            .any(|e| matches!(e, MenuEntry::Item(i) if i.icon.is_some()));
        let viewport = window.viewport_size();
        let style = menu.effective_style();
        let width = Self::measure(&menu, icons, window)
            .min(viewport.width - px(2. * look::POPUP_WINDOW_MARGIN));
        let state_w = Self::state_width(&menu, window);
        let mut popup = Self {
            style,
            menu,
            state,
            opts: ListOptions::menu(),
            done,
            lua_id,
            pressed: false,
            origin: point(px(0.), px(0.)),
            width,
            icons,
            scroll: ScrollHandle::new(),
            last_offset: point(px(0.), px(0.)),
            wheel: px(0.),
            title_lines: Vec::new(),
            info_lines: Vec::new(),
            state_w,
        };
        popup.wrap(window);
        let full = size(width, popup.height(viewport));
        popup.origin = kit::place(popup.menu.anchor, full, viewport);
        popup
    }

    /// Breaks a List popup's long title and its info entries into lines that fit the width.
    fn wrap(&mut self, window: &Window) {
        let measure = |weight| move |s: &str| text_width(window, s, weight);
        let border = 2. * look::POPUP_BORDER_WIDTH + 2.;
        self.title_lines = match &self.menu.title {
            Some(t) if self.menu.header_right.is_none() && self.style == MenuStyle::List => {
                let room = self.width - px(2. * look::POPUP_TITLE_PAD_X + border);
                crate::kit::wrap_with(t, room, measure(FontWeight::BOLD))
                    .into_iter()
                    .map(SharedString::from)
                    .collect()
            }
            Some(t) => vec![t.clone()],
            None => Vec::new(),
        };
        let g = self.geo();
        let room = self.width - px(g.left_no_icon + g.right + border);
        let small = |s: &str| {
            let mut f = gpui_kit::font(crate::render::UI_FONT);
            f.weight = FontWeight::NORMAL;
            crate::kit::width(window, s, f, px(look::UI_SMALL_FONT_SIZE))
        };
        self.info_lines = self
            .menu
            .entries
            .iter()
            .map(|e| match e {
                MenuEntry::Info(t) => crate::kit::wrap_with(t, room, small)
                    .into_iter()
                    .map(SharedString::from)
                    .collect(),
                _ => Vec::new(),
            })
            .collect();
    }

    /// The menu's width: its widest row (label + shortcut) or header.
    fn measure(menu: &Menu, icons: bool, window: &Window) -> Pixels {
        let g = geo(menu.effective_style());
        let left = if icons {
            g.left + g.icon_col + look::MENU_ICON_GAP
        } else {
            g.left_no_icon
        };
        let mut widest = px(0.);
        let state_w = Self::state_width(menu, window);
        for (ix, e) in menu.entries.iter().enumerate() {
            match e {
                MenuEntry::Item(i) => {
                    let mut w = text_width(window, &i.label, FontWeight::NORMAL) + state_w;
                    if i.dot.is_some() {
                        w += px(look::MENU_DOT_WIDTH);
                    }
                    if let Some(s) = &i.shortcut {
                        let gap = if s == "›" {
                            g.arrow_gap
                        } else {
                            g.shortcut_gap
                        };
                        w += px(gap) + Self::shortcut_width(s, window);
                    }
                    widest = widest.max(w + px(left));
                }
                // a long one wraps rather than widening the popup past a pick's width
                MenuEntry::Info(t) => {
                    let w = text_width(window, t, FontWeight::NORMAL)
                        .min(px(look::LIST_POPUP_WRAP_WIDTH));
                    widest = widest.max(w + px(g.left_no_icon));
                }
                MenuEntry::Separator => {
                    if let Some(c) = menu.caption(ix) {
                        let w = text_width(window, c, FontWeight::NORMAL)
                            + px(look::POPUP_CAPTION_PADDING_X);
                        widest = widest.max(w);
                    }
                }
            }
        }
        // + the frame's border lines and a pixel of rounding slack (measured vs. laid-out text)
        let mut width = widest + px(g.right + 2. * look::POPUP_BORDER_WIDTH + 2.);
        if let Some(t) = &menu.title {
            let right = menu.header_right.as_ref().map_or(px(0.), |r| {
                text_width(window, r, FontWeight::NORMAL) + px(8.)
            });
            let mut title = text_width(window, t, FontWeight::BOLD);
            // a question longer than a pick's width wraps (P-12); usages' headers stay one line
            if menu.header_right.is_none() && menu.effective_style() == MenuStyle::List {
                title = title.min(px(look::LIST_POPUP_WRAP_WIDTH));
            }
            let header = title
                + right
                + px(2. * look::POPUP_TITLE_PAD_X + 2. * look::POPUP_BORDER_WIDTH + 2.);
            width = width.max(header);
        }
        if let Some(max) = menu.max_width {
            width = width.min(max);
        }
        width.max(px(look::MENU_MIN_WIDTH)).ceil()
    }

    /// The state column's width: its widest word and the gap before it (none without one).
    fn state_width(menu: &Menu, window: &Window) -> Pixels {
        menu.entries
            .iter()
            .filter_map(|e| match e {
                MenuEntry::Item(i) => i.state.as_ref(),
                MenuEntry::Separator | MenuEntry::Info(_) => None,
            })
            .map(|(w, _)| text_width(window, w, FontWeight::NORMAL) + px(look::MENU_SHORTCUT_GAP))
            .fold(px(0.), Pixels::max)
    }

    fn shortcut_width(s: &str, window: &Window) -> Pixels {
        if s == "›" {
            px(look::ICON_SIZE)
        } else {
            text_width(window, s, FontWeight::NORMAL)
        }
    }

    fn geo(&self) -> &'static Geo {
        geo(self.style)
    }

    /// A List popup's separator with a caption is a caption row.
    fn caption(&self, ix: usize) -> Option<&SharedString> {
        (self.style == MenuStyle::List)
            .then(|| self.menu.caption(ix))
            .flatten()
    }

    fn row_height(&self, ix: usize) -> f32 {
        match self.menu.entries[ix] {
            MenuEntry::Separator if self.caption(ix).is_some() => look::LIST_ROW_HEIGHT.get(),
            MenuEntry::Separator => look::MENU_SEPARATOR_HEIGHT,
            MenuEntry::Item(_) => self.geo().pitch,
            MenuEntry::Info(_) => {
                let lines = self.info_lines.get(ix).map_or(1, |l| l.len().max(1));
                lines as f32 * look::MENU_INFO_LINE_HEIGHT + 2. * look::MENU_INFO_PADDING_Y
            }
        }
    }

    /// The whole frame's height for the rows shown now (capped: the list scrolls).
    fn height(&self, viewport: gpui_kit::Size<Pixels>) -> Pixels {
        let rows: f32 = match self.state.row_count() {
            0 => self.geo().pitch, // "Nothing to show"
            n => (0..n)
                .filter_map(|r| self.state.item_at(r))
                .map(|ix| self.row_height(ix))
                .sum(),
        };
        let cap = self
            .menu
            .max_rows
            .map_or(f32::MAX, |n| n as f32 * self.geo().pitch);
        let chrome = self.chrome_height();
        let room = viewport.height.as_f32() - 2. * look::POPUP_WINDOW_MARGIN - chrome;
        px(rows.min(cap).min(room.max(self.geo().pitch)) + chrome)
    }

    /// The body's top / bottom padding: "PopupMenu.borderInsets" 6 for context menus; list
    /// popups 8 (none on top under a title; PopupUtil.getListInsets).
    fn padding_y(&self) -> (f32, f32) {
        match self.style {
            MenuStyle::Context => (look::MENU_PADDING_Y, look::MENU_PADDING_Y),
            MenuStyle::List if self.menu.title.is_some() => (0., look::POPUP_PADDING_Y),
            MenuStyle::List => (look::POPUP_PADDING_Y, look::POPUP_PADDING_Y),
        }
    }

    /// Header, search field, paddings and the 1 px border lines.
    fn chrome_height(&self) -> f32 {
        let header = if self.menu.title.is_some() {
            look::POPUP_TITLE_HEIGHT
                + self.title_lines.len().saturating_sub(1) as f32 * look::POPUP_TITLE_LINE_HEIGHT
        } else {
            0.
        };
        let search = if self.state.searching() {
            look::MENU_SEARCH_HEIGHT
        } else {
            0.
        };
        let (top, bottom) = self.padding_y();
        header + search + top + bottom + 2. * look::POPUP_BORDER_WIDTH
    }

    pub(super) fn style(&self) -> MenuStyle {
        self.style
    }

    pub(super) fn bounds(&self) -> gpui_kit::Bounds<Pixels> {
        // the height only shrinks after placing (filtering): the last viewport doesn't matter
        let h = self.height(size(px(f32::MAX / 4.), px(f32::MAX / 4.)));
        gpui_kit::Bounds::new(self.origin, size(self.width, h))
    }

    /// The header's title (tests).
    pub(super) fn title_text(&self) -> Option<String> {
        self.menu.title.as_ref().map(|t| t.to_string())
    }

    pub(super) fn rows(&self) -> Vec<String> {
        (0..self.state.row_count())
            .filter_map(|r| self.state.item_at(r))
            .map(|ix| match (self.menu.item(ix), self.menu.info(ix)) {
                (Some(i), _) => i.label.to_string(),
                (None, Some(t)) => t.to_string(),
                (None, None) => "-".into(),
            })
            .collect()
    }

    /// The title's lines as drawn (tests: a long question wraps).
    pub(super) fn title_lines(&self) -> Vec<String> {
        self.title_lines.iter().map(|l| l.to_string()).collect()
    }

    pub(super) fn selected_label(&self) -> Option<String> {
        let ix = self.state.cursor()?;
        Some(self.menu.item(ix)?.label.to_string())
    }

    pub(super) fn item_by_label(&self, label: &str) -> Option<MenuItem> {
        self.menu.entries.iter().find_map(|e| match e {
            MenuEntry::Item(i) if i.label == label => Some(i.clone()),
            _ => None,
        })
    }

    pub(super) fn query(&self) -> Option<String> {
        self.state.query().map(str::to_owned)
    }

    pub(super) fn selectable(&self, ix: usize) -> bool {
        self.menu.selectable(ix)
    }

    /// A key (nvim notation); keeps the selected row in view. Letter navigation applies until
    /// speed search opens; its field then owns all text, with arrows navigating matches.
    pub(super) fn key(&mut self, key: &str, typed: Option<&str>) -> ListOutcome {
        let out = self.state.key(key, typed, &self.menu, &self.opts);
        if out == ListOutcome::Changed {
            self.reveal();
        }
        out
    }

    fn reveal(&self) {
        if let Some(row) = self.state.cursor().and_then(|c| self.state.row_of(c)) {
            self.scroll.scroll_to_item(row);
        }
    }

    /// The wheel over the menu moves the selection a row per step (menu.lua's ScrollWheel
    /// mappings); the list itself scrolls only to keep it in view. True when it moved.
    pub(super) fn wheel(&mut self, delta: gpui_kit::ScrollDelta) -> bool {
        // undo the list's own scrolling of this event
        self.scroll.set_offset(self.last_offset);
        let rows = match delta {
            gpui_kit::ScrollDelta::Lines(l) => -l.y.round() as isize,
            gpui_kit::ScrollDelta::Pixels(p) => {
                self.wheel += p.y;
                let row = px(self.geo().pitch);
                let n = (self.wheel / row).trunc();
                self.wheel -= row * n;
                -(n as isize)
            }
        };
        if rows == 0 {
            return false;
        }
        let step = if rows > 0 { "<Down>" } else { "<Up>" };
        for _ in 0..rows.unsigned_abs() {
            self.state.key(step, None, &self.menu, &self.opts);
        }
        self.reveal();
        true
    }

    /// The mouse over a row: it gets selected (WebStorm menus). True when that changed.
    pub(super) fn hover(&mut self, ix: usize, hovered: bool) -> bool {
        if !hovered || !self.menu.selectable(ix) || self.state.cursor() == Some(ix) {
            return false;
        }
        self.state.set_cursor(Some(ix));
        true
    }

    pub(super) fn render(
        &mut self,
        viewport: gpui_kit::Size<Pixels>,
        _window: &mut Window,
        cx: &mut Context<PopupsView>,
    ) -> AnyElement {
        self.last_offset = self.scroll.offset();
        let height = self.height(viewport);
        let wrapped = (self.title_lines.len() > 1).then(|| {
            kit::wrapped_header(self.title_lines.clone()).debug_selector(|| "menu-header".into())
        });
        let header = self
            .menu
            .title
            .clone()
            .filter(|_| wrapped.is_none())
            .map(|t| {
                let title = StyledText::new(t.clone()).with_highlights(label_runs(
                    &t,
                    &self.menu.title_highlights,
                    &[],
                ));
                let right = self.menu.header_right.clone().map(|r| {
                    let text = StyledText::new(r.clone()).with_highlights(label_runs(
                        &r,
                        &self.menu.header_right_highlights,
                        &[],
                    ));
                    div()
                        .flex_none()
                        .text_color(look::TEXT_DIM)
                        .child(text)
                        .into_any_element()
                });
                // kit::header's look (TitlePanel), with the chunks' own colors (the name, a count)
                kit::header(title, right).debug_selector(|| "menu-header".into())
            });
        let search = self.state.query().map(|q| self.search_row(q));
        let mut list = div()
            .id("menu-rows")
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .track_scroll(&self.scroll);
        let rows = self.state.row_count();
        if rows == 0 {
            list = list.child(
                div()
                    .h(px(self.geo().pitch))
                    .flex_none()
                    .px(px(self.geo().left_no_icon))
                    .flex()
                    .items_center()
                    .text_color(look::MENU_DISABLED_FG)
                    .child("Nothing to show"),
            );
        }
        for row in 0..rows {
            let Some(ix) = self.state.item_at(row) else {
                continue;
            };
            list = list.child(self.render_row(ix, row == 0, cx));
        }
        let (pad_top, pad_bottom) = self.padding_y();
        let frame = kit::popup_frame()
            .id("menu")
            .debug_selector(|| "menu".into())
            .w(self.width)
            .h(height)
            .occlude()
            .cursor_default()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, _, cx| this.menu_press(cx)),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _: &MouseDownEvent, _, cx| this.menu_press(cx)),
            )
            // middle-click anywhere cancels (menu.lua's <MiddleMouse>), inside or out
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.menu_middle(window, cx)
                }),
            )
            .on_mouse_down_out(cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                if ev.button == MouseButton::Middle {
                    cx.stop_propagation();
                    this.menu_middle(window, cx)
                } else {
                    this.dismiss(window, cx)
                }
            }))
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _, cx| {
                cx.stop_propagation();
                this.menu_wheel(ev.delta, cx)
            }))
            .children(header)
            .children(wrapped)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .pt(px(pad_top))
                    .pb(px(pad_bottom))
                    .flex()
                    .flex_col()
                    .children(search)
                    .child(list),
            );
        // the selected row's tooltip beside the popup, level with the row (W-05)
        let side = self.side_tooltip(pad_top);
        let placed = div().relative().child(frame).children(side);
        deferred(kit::placed(Anchor::Point(self.origin), placed))
            .with_priority(super::PRIORITY)
            .into_any_element()
    }

    /// The selected row's [`MenuItem::tooltip`], right of the frame at the row's height.
    fn side_tooltip(&self, pad_top: f32) -> Option<AnyElement> {
        let cursor = self.state.cursor()?;
        let text = self.menu.item(cursor)?.tooltip.clone()?;
        let header = if self.menu.title.is_some() {
            look::POPUP_TITLE_HEIGHT
                + self.title_lines.len().saturating_sub(1) as f32 * look::POPUP_TITLE_LINE_HEIGHT
        } else {
            0.
        };
        let search = if self.state.searching() {
            look::MENU_SEARCH_HEIGHT
        } else {
            0.
        };
        let above: f32 = (0..self.state.row_count())
            .filter_map(|r| self.state.item_at(r))
            .take_while(|&ix| ix != cursor)
            .map(|ix| self.row_height(ix))
            .sum();
        let top = look::POPUP_BORDER_WIDTH
            + header
            + search
            + pad_top
            + above
            + self.last_offset.y.as_f32();
        Some(
            crate::kit::tooltip_frame()
                .debug_selector(|| "menu-side-tooltip".into())
                .absolute()
                .left(self.width + px(look::MENU_SIDE_TOOLTIP_GAP))
                .top(px(top))
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .child(text)
                .into_any_element(),
        )
    }

    /// The selected row's side tooltip (tests).
    pub(super) fn side_tooltip_text(&self) -> Option<String> {
        let cursor = self.state.cursor()?;
        self.menu
            .item(cursor)?
            .tooltip
            .as_ref()
            .map(|t| t.to_string())
    }

    /// The speed search row over the rows (once typing starts): WebStorm's ListPopup search field, a
    /// borderless magnifier + text ("Popup.SearchField.borderInsets" 4,12), a line under it.
    fn search_row(&self, query: &str) -> AnyElement {
        let none = self.state.match_count() == Some(0) && !query.is_empty();
        div()
            .debug_selector(|| "menu-search".into())
            .h(px(look::MENU_SEARCH_HEIGHT))
            .flex_none()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap(px(look::FIELD_ICON_GAP))
                    .px(px(12.))
                    .child(Icon::new(IconName::Search))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(if none {
                                look::SPEED_SEARCH_ERROR_FG
                            } else {
                                look::SPEED_SEARCH_FG
                            })
                            .child(SharedString::from(query.to_string())),
                    ),
            )
            .child(div().flex_none().h(px(1.)).bg(look::SEPARATOR))
            .into_any_element()
    }

    fn render_row(&self, ix: usize, first: bool, cx: &mut Context<PopupsView>) -> AnyElement {
        let g = self.geo();
        if self.menu.info(ix).is_some() {
            let lines = self.info_lines.get(ix).cloned().unwrap_or_default();
            return div()
                .debug_selector(move || format!("menu-info-{ix}"))
                .flex_none()
                .py(px(look::MENU_INFO_PADDING_Y))
                .pl(px(g.left_no_icon))
                .pr(px(g.right))
                .flex()
                .flex_col()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .children(lines.into_iter().map(|l| {
                    div()
                        .h(px(look::MENU_INFO_LINE_HEIGHT))
                        .flex()
                        .items_center()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(l)
                }))
                .into_any_element();
        }
        let Some(item) = self.menu.item(ix) else {
            if let Some(caption) = self.caption(ix) {
                // GroupHeaderSeparator: dim caption, the line above it unless it's first
                return div()
                    .debug_selector(move || format!("menu-caption-{ix}"))
                    .relative()
                    .h(px(look::LIST_ROW_HEIGHT.get()))
                    .flex_none()
                    .pl(px(look::POPUP_CAPTION_PADDING_X))
                    .flex()
                    .items_center()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::POPUP_CAPTION_FG)
                    .when(!first, |d| {
                        d.child(
                            div()
                                .absolute()
                                .top_0()
                                .left(px(g.sep_inset))
                                .right(px(g.sep_inset))
                                .h(px(1.))
                                .bg(look::SEPARATOR),
                        )
                    })
                    .child(caption.clone())
                    .into_any_element();
            }
            return div()
                .h(px(look::MENU_SEPARATOR_HEIGHT))
                .flex_none()
                .px(px(g.sep_inset))
                .flex()
                .items_center()
                .child(div().h(px(1.)).w_full().bg(look::SEPARATOR))
                .into_any_element();
        };
        let selected = self.state.cursor() == Some(ix) && item.enabled;
        let fg = match (item.enabled, selected) {
            (false, _) => look::MENU_DISABLED_FG,
            (true, true) => look::SELECTION_TEXT,
            (true, false) => look::TEXT,
        };
        let key_fg = match (item.enabled, selected, self.style) {
            (false, _, _) => look::MENU_DISABLED_FG,
            (true, true, MenuStyle::Context) => look::MENU_SHORTCUT_SELECTED_FG,
            (true, true, MenuStyle::List) => look::SELECTION_TEXT,
            (true, false, _) => look::MENU_SHORTCUT_FG,
        };
        let label_chars = item.label.chars().count();
        let matches = self.state.matches(ix);
        let (in_label, in_key): (Vec<u32>, Vec<u32>) =
            matches.iter().partition(|&&m| (m as usize) < label_chars);
        let label = crate::kit::highlighted(
            item.label.clone(),
            label_runs(&item.label, &item.highlights, &in_label),
        );
        let shortcut = item.shortcut.clone().map(|s| {
            if s == "›" {
                return (
                    g.arrow_gap,
                    Icon::new(IconName::ChevronRight).into_any_element(),
                );
            }
            // search matches in the right column (search_shortcuts): chars after "label "
            let key_matches: Vec<u32> = in_key
                .iter()
                .filter_map(|&m| (m as usize).checked_sub(label_chars + 1).map(|k| k as u32))
                .collect();
            let text = crate::kit::highlighted(s.clone(), label_runs(&s, &[], &key_matches));
            let el = div()
                .flex_none()
                .debug_selector(move || format!("menu-key-{ix}"))
                .text_color(key_fg)
                .child(text)
                .into_any_element();
            (g.shortcut_gap, el)
        });
        let icon_col = self.icons.then(|| {
            div()
                .w(px(g.icon_col))
                .h(px(look::ICON_SIZE))
                .flex_none()
                .flex()
                .justify_center()
                .mr(px(look::MENU_ICON_GAP))
                .when(!item.enabled, |d| d.opacity(look::ICON_DISABLED_ALPHA))
                .children(item.icon.map(Icon::new))
        });
        let left = if self.icons { g.left } else { g.left_no_icon };
        let enabled = item.enabled;
        div()
            .id(("menu-row", ix))
            .debug_selector(move || format!("menu-row-{ix}"))
            .h(px(g.pitch))
            .flex_none()
            .w_full()
            .px(px(g.sel_x))
            .py(px(g.sel_y))
            .when(enabled, |d| d.cursor_pointer())
            .on_hover(
                cx.listener(move |this, hovered: &bool, _, cx| {
                    this.menu_row_hover(ix, *hovered, cx)
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, ev: &MouseUpEvent, window, cx| {
                    this.menu_row_up(ix, ev.position, window, cx)
                }),
            )
            .on_mouse_up(
                MouseButton::Right,
                cx.listener(move |this, ev: &MouseUpEvent, window, cx| {
                    this.menu_row_up(ix, ev.position, window, cx)
                }),
            )
            .child(
                div()
                    .debug_selector(move || format!("menu-sel-{ix}"))
                    .size_full()
                    .pl(px(left - g.sel_x))
                    .pr(px(g.right - g.sel_x))
                    .rounded(px(look::LIST_SELECTION_ARC))
                    .when(selected, |d| d.bg(look::SELECTION_BG))
                    .flex()
                    .items_center()
                    .text_color(fg)
                    .children(icon_col)
                    .children(item.dot.map(|(hue, pulse)| {
                        let dot = div()
                            .debug_selector(move || format!("menu-dot-{ix}"))
                            .flex_none()
                            .w(px(look::MENU_DOT_WIDTH))
                            .text_color(hue)
                            .child("●");
                        if pulse {
                            crate::kit::pulsing(("menu-dot", ix), dot)
                        } else {
                            dot.into_any_element()
                        }
                    }))
                    .child(
                        div()
                            .debug_selector(move || format!("menu-label-{ix}"))
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(label),
                    )
                    .children(item.state.clone().map(|(word, hue)| {
                        div()
                            .debug_selector(move || format!("menu-state-{ix}"))
                            .flex_none()
                            .w(self.state_w)
                            .pl(px(look::MENU_SHORTCUT_GAP))
                            .whitespace_nowrap()
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(hue)
                            .child(word)
                    }))
                    .children(shortcut.map(|(gap, s)| {
                        div().flex_none().pl(px(gap)).flex().items_center().child(s)
                    })),
            )
            .into_any_element()
    }
}

/// A label's styled ranges: the speed search's matches when it has some, else the item's own
/// highlights (later ones on top, like menu.lua's extmark priorities), as sorted, non-overlapping
/// byte ranges.
fn label_runs(
    text: &str,
    highlights: &[Highlight],
    matches: &[u32],
) -> Vec<(Range<usize>, HighlightStyle)> {
    if !matches.is_empty() {
        let style = HighlightStyle {
            color: Some(look::hsla(look::SEARCH_MATCH_FG.rgba())),
            background_color: Some(look::hsla(look::SEARCH_MATCH_BG.rgba())),
            ..Default::default()
        };
        return char_ranges(text, matches)
            .into_iter()
            .map(|r| (r, style))
            .collect();
    }
    let clamp = |mut b: usize| {
        b = b.min(text.len());
        while !text.is_char_boundary(b) {
            b -= 1;
        }
        b
    };
    let mut cuts: Vec<usize> = vec![0, text.len()];
    for h in highlights {
        cuts.push(clamp(h.range.start));
        cuts.push(clamp(h.range.end));
    }
    cuts.sort_unstable();
    cuts.dedup();
    let mut out: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let mut style = HighlightStyle::default();
        let mut any = false;
        for h in highlights {
            if clamp(h.range.start) <= a && clamp(h.range.end) >= b {
                if let Some(c) = h.color {
                    style.color = Some(look::hsla(c));
                }
                if h.bold {
                    style.font_weight = Some(FontWeight::BOLD);
                }
                any = true;
            }
        }
        if any && a < b {
            out.push((a..b, style));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_runs_layer_and_stay_sorted() {
        let red = look::hex(0xff0000);
        let hl = vec![
            Highlight {
                range: 0..5,
                color: Some(red),
                bold: false,
            },
            Highlight {
                range: 3..8,
                color: None,
                bold: true,
            },
        ];
        let runs = label_runs("const foo = 1", &hl, &[]);
        let ranges: Vec<_> = runs.iter().map(|(r, _)| r.clone()).collect();
        assert_eq!(ranges, vec![0..3, 3..5, 5..8]);
        assert_eq!(runs[1].1.font_weight, Some(FontWeight::BOLD));
        assert!(runs[1].1.color.is_some());
        // out of range / mid-char ends are clamped
        let runs = label_runs(
            "åäö",
            &[Highlight {
                range: 1..99,
                color: Some(red),
                bold: false,
            }],
            &[],
        );
        assert_eq!(runs[0].0, 0..6);
        // search matches win
        let runs = label_runs("Split Right", &hl, &[0, 6]);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1].0, 6..7);
    }

    #[test]
    fn lua_items_become_entries() {
        let sep = LuaItem {
            sep: true,
            ..Default::default()
        };
        assert!(matches!(sep.into_entry(true), MenuEntry::Separator));
        let copy = LuaItem {
            label: Some("Copy".into()),
            key: Some("⌘C".into()),
            ..Default::default()
        };
        let MenuEntry::Item(i) = copy.into_entry(true) else {
            panic!()
        };
        assert_eq!(i.icon, Some(IconName::Copy));
        assert!(i.enabled);
        let usage = LuaItem {
            label: Some("x".into()),
            file: Some("/a/b.ts".into()),
            enabled: Some(false),
            ..Default::default()
        };
        let MenuEntry::Item(i) = usage.into_entry(false) else {
            panic!()
        };
        assert_eq!(i.icon, Some(IconName::TypeScript));
        assert!(!i.enabled);
    }
}
