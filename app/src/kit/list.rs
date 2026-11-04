//! The list every native surface shares (tree, menus, pickers, switcher): a virtual list
//! (`uniform_list`, 10k+ rows) with WebStorm's row look and the Lua UI's keys.
//!
//! - Selection: an inset rounded rect (focused / unfocused colors), multi-select with Shift+arrows,
//!   Shift+click (range) and Cmd/Alt+click (toggle), like `config/tree.lua`; with
//!   [`ListOptions::drag_select`] a press dragged over rows selects them (scrolling past an edge).
//! - Keys: l / ö (his up / down) and arrows move, L / Ö five rows, PageUp / PageDown, Home / End;
//!   Enter confirms, Esc clears a multi-selection, then the search, then cancels. Lists with
//!   [`ListOptions::vim`] (not dropdowns) add [`super::vim`]: a count (`22ö`, `3Ö`), `gg` / `G`
//!   and doubled keys (`yy` / `dd` / `rr` / `g?`) for the delegate ([`ListDelegate::vim_cmd`]).
//! - Speed search: lists (tree, Git panel lists) search only after `/`, so letters navigate;
//!   dropdowns / popups ([`ListOptions::type_to_search`], [`ListOptions::menu`]) search as soon
//!   as text is typed (WS ListPopup): every letter types, arrows and Ctrl-n / Ctrl-p move.
//!   Typed text goes to a search row over the list, the rows filter fuzzily (order kept, matched
//!   chars highlighted), the first match gets selected; arrows move through the results,
//!   Backspace on an empty search or Esc closes it and keeps the selected item (WS
//!   WizardPopup.goBack: Esc resets a held filter first, the next one closes).
//!
//! [`ListState`] is the model (pure, unit-tested); [`ListView`] the GPUI view around a
//! [`ListDelegate`] that renders rows and gets the confirm / cancel / selection callbacks.

use std::collections::BTreeSet;
use std::ops::Range;

use gpui_kit::{
    AnyElement, App, Context, DispatchPhase, FocusHandle, Focusable, FontWeight, HighlightStyle,
    HitboxBehavior, InteractiveElement, IntoElement, KeyDownEvent, Modifiers, MouseButton,
    MouseDownEvent, ParentElement, Pixels, Point, Render, Rgba, ScrollDelta, ScrollStrategy,
    ScrollWheelEvent, SharedString, StatefulInteractiveElement, Styled, StyledText, Task,
    UniformListScrollHandle, Window, canvas, div, prelude::FluentBuilder as _, px, uniform_list,
};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use super::icons::{Icon, IconName};
use super::keys;
use super::vim::{self, Step, Vim};
use crate::look;

/// What the speed search does with the rows (after `/`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchMode {
    /// Only matching rows stay (menus, the tree today).
    Filter,
    /// Every row stays; matches are highlighted and moving jumps between them (WS speed search).
    Highlight,
    /// No search: `/` is an ordinary key.
    Off,
}

/// Per-list behaviour; the delegate's [`ListDelegate::options`].
#[derive(Clone, Copy, Debug)]
pub struct ListOptions {
    pub row_height: Pixels,
    /// Space between the panel edge and the selection rect.
    pub inset_x: Pixels,
    /// Space between the panel edge and the row content (the tree's content positions itself
    /// from the edge: 0).
    pub content_inset_x: Pixels,
    pub multi_select: bool,
    /// Moving past the last row goes to the first (menus).
    pub wrap: bool,
    pub search: SearchMode,
    /// The mouse selects the row it's over (menus / popups).
    pub hover_selects: bool,
    /// The mouse wheel moves the selection a row per step instead of scrolling (menu.lua maps
    /// <ScrollWheelUp/Down> to its up / down).
    pub wheel_selects: bool,
    /// Multi-select lists: a left press dragged over rows selects the range (past the top /
    /// bottom edge the list scrolls a row at a time), like WebStorm's trees.
    pub drag_select: bool,
    /// Typing starts the search at once, no `/` needed (dropdowns / popups, WS ListPopup): every
    /// letter types there (k / l / ö / ä too); arrows and Ctrl-n / Ctrl-p move. Off: the search
    /// starts only with `/` and letters navigate (tree, Git panel lists).
    pub type_to_search: bool,
    /// The Vim layer (counts, `gg` / `G`) with these doubled keys (`y` `d` `r`): lists, never
    /// dropdowns. None: off.
    pub vim: Option<&'static str>,
}

impl Default for ListOptions {
    fn default() -> Self {
        Self {
            row_height: px(look::LIST_ROW_HEIGHT.get()),
            inset_x: px(look::LIST_ROW_INSET_X),
            content_inset_x: px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X),
            multi_select: false,
            wrap: false,
            search: SearchMode::Filter,
            hover_selects: false,
            wheel_selects: false,
            drag_select: false,
            type_to_search: false,
            vim: None,
        }
    }
}

impl ListOptions {
    /// Tree-like: tree row height, multi-select, no wrap.
    pub fn tree() -> Self {
        Self {
            row_height: px(look::TREE_ROW_HEIGHT.get()),
            inset_x: px(look::SELECTION_INSET_X),
            content_inset_x: px(0.),
            multi_select: true,
            vim: Some(""),
            ..Self::default()
        }
    }

    /// Menu / popup list: wraps, the mouse selects, typing searches.
    pub fn menu() -> Self {
        Self {
            wrap: true,
            hover_selects: true,
            wheel_selects: true,
            type_to_search: true,
            ..Self::default()
        }
    }
}

/// The items the model needs to know about.
pub trait ListSource {
    fn len(&self) -> usize;
    /// Text the speed search matches (usually the row's label).
    fn text(&self, ix: usize) -> SharedString;
    /// Separators / disabled rows can't be selected.
    fn selectable(&self, _ix: usize) -> bool {
        true
    }
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What a key / click did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListOutcome {
    /// Not a list key: let it propagate.
    Ignored,
    /// Handled (selection, search, ...): re-render.
    Changed,
    /// Enter / double-click on this item.
    Confirm(usize),
    /// Esc with nothing left to clear.
    Cancel,
    /// A doubled Vim key ([`ListOptions::vim`]) for the delegate.
    Vim(vim::Cmd),
}

/// List model: rows shown, cursor, multi-selection, speed search, hover. Item indices are the
/// source's; a row is a position among the shown items.
pub struct ListState {
    len: usize,
    /// Shown items while a filtering search has a query; None = all items.
    shown: Option<Vec<usize>>,
    /// Matched items (ascending) and their matched char indices, while the search has a query.
    matched: Vec<(usize, Vec<u32>)>,
    cursor: Option<usize>,
    /// Range start for Shift moves / clicks.
    anchor: Option<usize>,
    /// Multi-selection (items); empty = just the cursor.
    selected: BTreeSet<usize>,
    /// Some while the search row is open (after `/`).
    query: Option<String>,
    /// The cursor when the search opened: back when the query is cleared (a query without
    /// matches leaves no cursor).
    before_search: Option<usize>,
    hovered: Option<usize>,
    scroll: UniformListScrollHandle,
    /// Rows a PageUp / PageDown moves (from the last layout).
    page_rows: usize,
    /// A search query hides non-matching rows ([`SearchMode::Filter`]).
    filtering: bool,
    matcher: Matcher,
    /// Pending count / prefix ([`ListOptions::vim`]).
    vim: Vim,
}

impl Default for ListState {
    fn default() -> Self {
        Self::new()
    }
}

impl ListState {
    pub fn new() -> Self {
        Self {
            len: 0,
            shown: None,
            matched: Vec::new(),
            cursor: None,
            anchor: None,
            selected: BTreeSet::new(),
            query: None,
            before_search: None,
            hovered: None,
            scroll: UniformListScrollHandle::new(),
            page_rows: 10,
            filtering: true,
            matcher: Matcher::new(Config::DEFAULT),
            vim: Vim::default(),
        }
    }

    /// Items changed (count / order / text): re-runs the search, keeps the cursor item if it's
    /// still there (index-based: an owner whose items move sets the cursor itself).
    pub fn refresh(&mut self, src: &impl ListSource) {
        self.len = src.len();
        self.selected.retain(|&i| i < self.len);
        if self.cursor.is_some_and(|c| c >= self.len) {
            self.cursor = None;
        }
        if self.anchor.is_some_and(|c| c >= self.len) {
            self.anchor = None;
        }
        if self.hovered.is_some_and(|c| c >= self.len) {
            self.hovered = None;
        }
        self.run_search(src, false);
    }

    /// Selected item (the cursor).
    pub fn cursor(&self) -> Option<usize> {
        self.cursor
    }

    /// Moves the cursor to `ix`, clears a multi-selection and scrolls it into view.
    pub fn set_cursor(&mut self, ix: Option<usize>) {
        self.cursor = ix.filter(|&i| i < self.len);
        self.anchor = self.cursor;
        self.selected.clear();
        self.reveal();
    }

    /// Restores a selection (after the owner rebuilt its rows): the cursor and, when `items` has
    /// more than one, a multi-selection (items past the end are dropped). Scrolls the cursor
    /// into view.
    pub fn set_selection(&mut self, cursor: Option<usize>, items: impl IntoIterator<Item = usize>) {
        self.cursor = cursor.filter(|&i| i < self.len);
        self.anchor = self.cursor;
        self.selected = items.into_iter().filter(|&i| i < self.len).collect();
        if self.selected.len() < 2 {
            self.selected.clear();
        }
        self.reveal();
    }

    /// The selected items in order: the multi-selection, else the cursor.
    pub fn selection(&self) -> Vec<usize> {
        if self.selected.is_empty() {
            self.cursor.into_iter().collect()
        } else {
            self.selected.iter().copied().collect()
        }
    }

    pub fn is_selected(&self, ix: usize) -> bool {
        if self.selected.is_empty() {
            self.cursor == Some(ix)
        } else {
            self.selected.contains(&ix)
        }
    }

    /// More than one row selected (Shift / Cmd).
    pub fn has_multi_selection(&self) -> bool {
        !self.selected.is_empty()
    }

    pub fn hovered(&self) -> Option<usize> {
        self.hovered
    }

    /// Sets the hovered item; true when it changed.
    pub fn set_hovered(&mut self, ix: Option<usize>) -> bool {
        std::mem::replace(&mut self.hovered, ix) != ix
    }

    /// The search row is open (after `/`).
    pub fn searching(&self) -> bool {
        self.query.is_some()
    }

    pub fn query(&self) -> Option<&str> {
        self.query.as_deref()
    }

    /// Opens (Some) / closes (None) the search or sets its text, as typing would.
    pub fn set_query(&mut self, query: Option<String>, src: &impl ListSource) {
        let typed = query.as_deref().is_some_and(|q| !q.is_empty())
            && query.as_deref() != self.query.as_deref();
        if self.query.is_none() && query.is_some() {
            self.before_search = self.cursor;
        }
        self.query = query;
        self.run_search(src, typed);
    }

    /// Matches while the search has a query (None: no query).
    pub fn match_count(&self) -> Option<usize> {
        self.has_query().then_some(self.matched.len())
    }

    /// Matched char indices of an item's text (empty: no match / no query).
    pub fn matches(&self, ix: usize) -> &[u32] {
        match self.matched.binary_search_by_key(&ix, |(i, _)| *i) {
            Ok(pos) => &self.matched[pos].1,
            Err(_) => &[],
        }
    }

    /// Rows shown.
    pub fn row_count(&self) -> usize {
        self.shown.as_ref().map_or(self.len, Vec::len)
    }

    /// The item on a row.
    pub fn item_at(&self, row: usize) -> Option<usize> {
        match &self.shown {
            Some(shown) => shown.get(row).copied(),
            None => (row < self.len).then_some(row),
        }
    }

    /// The row an item is on (None: filtered out).
    pub fn row_of(&self, ix: usize) -> Option<usize> {
        match &self.shown {
            Some(shown) => shown.binary_search(&ix).ok(),
            None => (ix < self.len).then_some(ix),
        }
    }

    pub fn scroll_handle(&self) -> &UniformListScrollHandle {
        &self.scroll
    }

    /// Forgets a pending Vim count / prefix (a delegate took the key).
    pub fn vim_reset(&mut self) {
        self.vim.reset();
    }

    /// Rows a page key moves (the view sets it from the list's height).
    pub fn set_page_rows(&mut self, rows: usize) {
        self.page_rows = rows.max(1);
    }

    /// A key in nvim notation ([`keys::notation`]) and the text it types ([`keys::typed_text`]).
    pub fn key(
        &mut self,
        key: &str,
        typed: Option<&str>,
        src: &impl ListSource,
        opts: &ListOptions,
    ) -> ListOutcome {
        // A dropdown types every letter into its search; arrows and Ctrl-n/p navigate.
        let typed = typed.filter(|t| !t.is_empty());
        let mut count = 1;
        if self.searching() {
            self.vim.reset();
            if let Some(out) = self.search_key(key, typed, src) {
                return out;
            }
        } else if let Some(doubles) = opts.vim.filter(|_| !opts.type_to_search) {
            match self.vim.feed(key, doubles) {
                Step::Pending => return ListOutcome::Changed,
                Step::Cmd(c) => return ListOutcome::Vim(c),
                step @ (Step::First | Step::Last) => {
                    let to = if step == Step::First {
                        isize::MIN / 2
                    } else {
                        isize::MAX / 2
                    };
                    self.move_by(to, false, src);
                    return ListOutcome::Changed;
                }
                Step::Key { count: n, .. } => count = n as isize,
            }
        }
        if !self.searching() && opts.search != SearchMode::Off {
            if key == "/" {
                self.set_query(Some(String::new()), src);
                return ListOutcome::Changed;
            }
            if let Some(text) = typed.filter(|_| opts.type_to_search) {
                self.set_query(Some(text.to_owned()), src);
                return ListOutcome::Changed;
            }
        }
        let page = self.page_rows as isize;
        let plain = |s: &mut Self, by: isize, wrap: bool| {
            s.move_by(by, wrap, src);
            ListOutcome::Changed
        };
        match key {
            "<Up>" | "l" => plain(self, -count, opts.wrap),
            "<Down>" | "ö" => plain(self, count, opts.wrap),
            "<C-p>" | "<S-Tab>" => plain(self, -1, opts.wrap),
            "<C-n>" | "<Tab>" => plain(self, 1, opts.wrap),
            // five single moves, wrapping in menus like menu.lua's
            "L" => plain(self, -5 * count, opts.wrap),
            "Ö" => plain(self, 5 * count, opts.wrap),
            "<PageUp>" => plain(self, -page, false),
            "<PageDown>" => plain(self, page, false),
            "<Home>" => plain(self, isize::MIN / 2, false),
            "<End>" => plain(self, isize::MAX / 2, false),
            "<S-Up>" | "<S-Down>" if opts.multi_select => {
                self.extend_by(if key == "<S-Up>" { -1 } else { 1 }, src);
                ListOutcome::Changed
            }
            "<CR>" => match self.cursor {
                Some(ix) => ListOutcome::Confirm(ix),
                None => ListOutcome::Changed,
            },
            "<Esc>" => {
                if !self.selected.is_empty() {
                    self.selected.clear();
                    self.anchor = self.cursor;
                    ListOutcome::Changed
                } else {
                    ListOutcome::Cancel
                }
            }
            _ => ListOutcome::Ignored,
        }
    }

    /// Keys while the search row is open; None = not a search key (moves etc.).
    fn search_key(
        &mut self,
        key: &str,
        typed: Option<&str>,
        src: &impl ListSource,
    ) -> Option<ListOutcome> {
        let query = self.query.clone().unwrap_or_default();
        match key {
            "<Esc>" if !self.selected.is_empty() => None,
            "<Esc>" => {
                self.set_query(None, src);
                Some(ListOutcome::Changed)
            }
            "<BS>" => {
                if query.is_empty() {
                    self.set_query(None, src);
                } else {
                    let mut q = query;
                    q.pop();
                    self.set_query(Some(q), src);
                }
                Some(ListOutcome::Changed)
            }
            // Cmd+Backspace / Alt+Backspace: the whole search text
            "<D-BS>" | "<M-BS>" => {
                self.set_query(Some(String::new()), src);
                Some(ListOutcome::Changed)
            }
            _ => {
                let text = typed?;
                self.set_query(Some(query + text), src);
                Some(ListOutcome::Changed)
            }
        }
    }

    /// Mouse wheel steps over a [`ListOptions::wheel_selects`] list (+ = down): the selection
    /// moves a row per step, wrapping like the keys.
    pub fn wheel(
        &mut self,
        steps: isize,
        src: &impl ListSource,
        opts: &ListOptions,
    ) -> ListOutcome {
        if steps == 0 {
            return ListOutcome::Ignored;
        }
        for _ in 0..steps.unsigned_abs() {
            self.move_by(steps.signum(), opts.wrap, src);
        }
        ListOutcome::Changed
    }

    /// A press on an item: plain selects, Shift extends from the anchor, Cmd / Alt toggles; the
    /// second click of a double-click confirms.
    pub fn click(
        &mut self,
        ix: usize,
        modifiers: Modifiers,
        click_count: usize,
        src: &impl ListSource,
        opts: &ListOptions,
    ) -> ListOutcome {
        if ix >= self.len || !src.selectable(ix) {
            return ListOutcome::Ignored;
        }
        if opts.multi_select && modifiers.shift {
            let anchor = self.anchor.or(self.cursor).unwrap_or(ix);
            self.cursor = Some(ix);
            self.select_range(anchor, ix, src);
            self.anchor = Some(anchor);
            return ListOutcome::Changed;
        }
        if opts.multi_select && (modifiers.platform || modifiers.alt) {
            // the first toggle keeps the selected row selected (WebStorm)
            if self.selected.is_empty()
                && let Some(c) = self.cursor
            {
                self.selected.insert(c);
            }
            if !self.selected.remove(&ix) {
                self.selected.insert(ix);
            }
            self.cursor = Some(ix);
            self.anchor = Some(ix);
            return ListOutcome::Changed;
        }
        if click_count >= 2 && self.cursor == Some(ix) {
            return ListOutcome::Confirm(ix);
        }
        self.set_cursor(Some(ix));
        ListOutcome::Changed
    }

    /// Right-click: selects the item unless it's already part of the selection (WebStorm).
    pub fn secondary_click(&mut self, ix: usize, src: &impl ListSource) -> ListOutcome {
        if ix >= self.len || !src.selectable(ix) {
            return ListOutcome::Ignored;
        }
        if !self.is_selected(ix) {
            self.set_cursor(Some(ix));
        }
        ListOutcome::Changed
    }

    fn has_query(&self) -> bool {
        self.query.as_deref().is_some_and(|q| !q.is_empty())
    }

    /// Re-filters for the current query; `typed`: the query just changed by typing, so the
    /// first match gets selected.
    fn run_search(&mut self, src: &impl ListSource, typed: bool) {
        self.matched.clear();
        self.shown = None;
        let Some(query) = self.query.as_deref().filter(|q| !q.is_empty()) else {
            // no query (cleared / closed) after one without matches: the cursor comes back
            if self.cursor.is_none() {
                self.cursor = self.before_search.filter(|&c| c < self.len);
                self.anchor = self.cursor;
            }
            self.reveal();
            return;
        };
        let pattern = Pattern::new(
            query,
            CaseMatching::Smart,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        let mut buf = Vec::new();
        for ix in 0..self.len {
            if !src.selectable(ix) {
                continue;
            }
            let text = src.text(ix);
            let mut indices = Vec::new();
            if pattern
                .indices(
                    Utf32Str::new(&text, &mut buf),
                    &mut self.matcher,
                    &mut indices,
                )
                .is_some()
            {
                indices.sort_unstable();
                indices.dedup();
                self.matched.push((ix, indices));
            }
        }
        if self.filtering {
            self.shown = Some(self.matched.iter().map(|(i, _)| *i).collect());
        }
        if typed {
            self.selected.clear();
            self.cursor = self.matched.first().map(|(i, _)| *i);
            self.anchor = self.cursor;
        }
        self.reveal();
    }

    /// Moves the cursor `by` rows over selectable ones (Highlight search: over matches), clears
    /// a multi-selection. Huge `by` = first / last.
    fn move_by(&mut self, by: isize, wrap: bool, src: &impl ListSource) {
        self.selected.clear();
        if let Some(target) = self.target_row(by, wrap, src) {
            self.cursor = self.item_at(target);
        }
        self.anchor = self.cursor;
        self.reveal();
    }

    /// Shift+move: extends the range from the anchor.
    fn extend_by(&mut self, by: isize, src: &impl ListSource) {
        let anchor = self.anchor.or(self.cursor);
        if let Some(target) = self.target_row(by, false, src) {
            self.cursor = self.item_at(target);
        }
        if let (Some(a), Some(c)) = (anchor, self.cursor) {
            self.select_range(a, c, src);
        }
        self.anchor = anchor;
        self.reveal();
    }

    fn select_range(&mut self, a: usize, b: usize, src: &impl ListSource) {
        self.selected.clear();
        let (Some(ra), Some(rb)) = (self.row_of(a), self.row_of(b)) else {
            return;
        };
        for row in ra.min(rb)..=ra.max(rb) {
            if let Some(ix) = self.item_at(row).filter(|&i| src.selectable(i)) {
                self.selected.insert(ix);
            }
        }
    }

    /// Drag-select: the cursor to `row` (clamped), the range from `anchor` to it selected; the
    /// anchor stays. True when the selection changed.
    pub fn drag_to(&mut self, anchor: usize, row: usize, src: &impl ListSource) -> bool {
        let n = self.row_count();
        if n == 0 {
            return false;
        }
        let Some(ix) = self.item_at(row.min(n - 1)).filter(|&i| src.selectable(i)) else {
            return false;
        };
        let before = (self.cursor, self.selected.clone());
        self.cursor = Some(ix);
        if ix == anchor {
            self.selected.clear();
        } else {
            self.select_range(anchor, ix, src);
        }
        self.anchor = Some(anchor);
        self.reveal();
        before != (self.cursor, self.selected.clone())
    }

    /// Row `by` rows from the cursor's that can take the cursor.
    fn target_row(&self, by: isize, wrap: bool, src: &impl ListSource) -> Option<usize> {
        let n = self.row_count();
        if n == 0 {
            return None;
        }
        let ok = |row: usize| {
            self.item_at(row).is_some_and(|i| {
                src.selectable(i)
                    && (self.filtering || !self.has_query() || !self.matches(i).is_empty())
            })
        };
        let start = self.cursor.and_then(|c| self.row_of(c));
        let step: isize = if by < 0 { -1 } else { 1 };
        // no cursor: start just outside the list, so Down / End reach the first / last row
        let mut row = start.map_or(if by < 0 { n as isize } else { -1 }, |s| s as isize);
        let mut best = None;
        let mut left = by.unsigned_abs();
        let mut steps = 0;
        // wrapping: every step can go round (5 moves in a 3-row menu); else one pass at most
        let limit = if wrap {
            n.saturating_mul(left.max(1))
        } else {
            n
        };
        while left > 0 && steps < limit {
            let mut next = row + step;
            if next < 0 || next >= n as isize {
                if !wrap {
                    break;
                }
                next = next.rem_euclid(n as isize);
            }
            row = next;
            steps += 1;
            if ok(row as usize) {
                best = Some(row as usize);
                left -= 1;
            }
        }
        best.or(start)
    }

    /// Scrolls the cursor's row into view (applied at the next layout).
    fn reveal(&self) {
        if let Some(row) = self.cursor.and_then(|c| self.row_of(c)) {
            self.scroll.scroll_to_item(row, ScrollStrategy::Nearest);
        }
    }
}

/// How a row is drawn right now.
#[derive(Clone, Copy, Debug, Default)]
pub struct RowState<'a> {
    /// Part of the selection (cursor or multi-selection).
    pub selected: bool,
    /// The cursor row.
    pub cursor: bool,
    /// The list has focus (selection drawn in the focused color).
    pub focused: bool,
    pub hovered: bool,
    /// Matched char indices of [`ListSource::text`] (speed search).
    pub matches: &'a [u32],
}

/// A list's rows and what happens on confirm / cancel. Rendering gets the view's context, so a
/// row can add its own listeners (chevron clicks, drags).
pub trait ListDelegate: ListSource + Sized + 'static {
    fn options(&self) -> ListOptions {
        ListOptions::default()
    }

    /// The row's content (icon, text, ...); the view adds height, insets, selection and hover.
    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement;

    /// A full-width row tint under the selection (the tree's excluded / library-root rows).
    fn row_background(&self, _ix: usize) -> Option<Rgba> {
        None
    }

    /// First look at a key (nvim notation); true = handled (the tree's k / ä).
    fn on_key(
        &mut self,
        _key: &str,
        _state: &mut ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) -> bool {
        false
    }

    /// Enter / double-click (`state.selection()` for the multi-selection).
    fn confirm(
        &mut self,
        _ix: usize,
        _state: &ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) {
    }

    /// Esc with nothing left to clear.
    fn cancel(&mut self, _window: &mut Window, _cx: &mut Context<ListView<Self>>) {}

    /// A doubled Vim key (`yy` / `dd` / `rr` / `g?`, [`ListOptions::vim`]).
    fn vim_cmd(
        &mut self,
        _cmd: vim::Cmd,
        _state: &mut ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) {
    }

    /// The cursor or the multi-selection changed.
    fn selection_changed(
        &mut self,
        _state: &ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) {
    }

    /// Right-click on an item (already selected); `position` in window coordinates.
    fn secondary_click(
        &mut self,
        _ix: usize,
        _position: Point<Pixels>,
        _state: &ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) {
    }
}

/// A focusable list view around a delegate.
pub struct ListView<D: ListDelegate> {
    pub delegate: D,
    pub state: ListState,
    focus: FocusHandle,
    /// Wheel rows not applied yet ([`ListOptions::wheel_selects`]; + = down).
    wheel_rows: f32,
    /// Drag-select in progress: the item it started from.
    drag_anchor: Option<usize>,
    /// Auto-scroll direction while the drag is past an edge (-1 up, 1 down).
    drag_dir: i8,
    drag_task: Option<Task<()>>,
}

/// Drag-select auto-scroll: a row per tick (the tree's pace).
const DRAG_SCROLL_MS: u64 = 40;

impl<D: ListDelegate> Focusable for ListView<D> {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl<D: ListDelegate> ListView<D> {
    pub fn new(delegate: D, cx: &mut Context<Self>) -> Self {
        let mut state = ListState::new();
        state.filtering = delegate.options().search == SearchMode::Filter;
        state.refresh(&delegate);
        Self {
            delegate,
            state,
            focus: cx.focus_handle(),
            wheel_rows: 0.,
            drag_anchor: None,
            drag_dir: 0,
            drag_task: None,
        }
    }

    /// The delegate's items changed: re-filter and re-render.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.state.filtering = self.delegate.options().search == SearchMode::Filter;
        self.state.refresh(&self.delegate);
        cx.notify();
    }

    fn apply(
        &mut self,
        out: ListOutcome,
        before: Selection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match out {
            ListOutcome::Ignored => return,
            ListOutcome::Changed => {}
            ListOutcome::Confirm(ix) => self.delegate.confirm(ix, &self.state, window, cx),
            ListOutcome::Cancel => self.delegate.cancel(window, cx),
            ListOutcome::Vim(c) => self.delegate.vim_cmd(c, &mut self.state, window, cx),
        }
        if Selection::of(&self.state) != before {
            self.delegate.selection_changed(&self.state, window, cx);
        }
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = keys::notation(event) else {
            return;
        };
        let before = Selection::of(&self.state);
        if self.delegate.on_key(&key, &mut self.state, window, cx) {
            self.state.vim_reset();
            cx.stop_propagation();
            if Selection::of(&self.state) != before {
                self.delegate.selection_changed(&self.state, window, cx);
            }
            cx.notify();
            return;
        }
        let typed = keys::typed_text(event);
        let opts = self.delegate.options();
        let out = self
            .state
            .key(&key, typed.as_deref(), &self.delegate, &opts);
        if out != ListOutcome::Ignored {
            cx.stop_propagation();
        }
        self.apply(out, before, window, cx);
    }

    /// A wheel / trackpad scroll over a [`ListOptions::wheel_selects`] list: whole rows move the
    /// selection.
    fn on_wheel(&mut self, event: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        let opts = self.delegate.options();
        let rows = match event.delta {
            ScrollDelta::Lines(l) => -l.y,
            ScrollDelta::Pixels(p) => -(p.y / opts.row_height),
        };
        self.wheel_rows += rows;
        let steps = self.wheel_rows.trunc();
        self.wheel_rows -= steps;
        let before = Selection::of(&self.state);
        let out = self.state.wheel(steps as isize, &self.delegate, &opts);
        self.apply(out, before, window, cx);
    }

    fn on_row_down(
        &mut self,
        ix: usize,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let before = Selection::of(&self.state);
        let opts = self.delegate.options();
        let out = if event.button == MouseButton::Right {
            let out = self.state.secondary_click(ix, &self.delegate);
            self.apply(out, before, window, cx);
            self.delegate
                .secondary_click(ix, event.position, &self.state, window, cx);
            return;
        } else {
            self.state.click(
                ix,
                event.modifiers,
                event.click_count,
                &self.delegate,
                &opts,
            )
        };
        cx.stop_propagation();
        self.apply(out, before, window, cx);
        // a press can start a drag-select (not a toggle / the confirming second click)
        if opts.drag_select
            && opts.multi_select
            && !(event.modifiers.platform || event.modifiers.alt)
            && event.click_count < 2
        {
            self.drag_anchor = self.state.anchor.or(self.state.cursor);
        }
    }

    /// The list's rows area (window coordinates) and its scroll offset (y, >= 0).
    fn rows_area(&self) -> (gpui_kit::Bounds<Pixels>, Pixels) {
        let handle = self.state.scroll.0.borrow();
        (handle.base_handle.bounds(), -handle.base_handle.offset().y)
    }

    /// A mouse move during a drag-select: select up to the row under it; past an edge, scroll.
    fn on_drag_move(
        &mut self,
        ev: &gpui_kit::MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(anchor) = self.drag_anchor else {
            return;
        };
        if ev.pressed_button != Some(MouseButton::Left) {
            self.end_drag();
            return;
        }
        let (area, scrolled) = self.rows_area();
        let y = ev.position.y;
        let dir = if y < area.top() {
            -1
        } else if y > area.bottom() {
            1
        } else {
            0
        };
        if dir == 0 {
            let row_h = self.delegate.options().row_height;
            let row = ((y - area.top() + scrolled) / row_h).floor().max(0.) as usize;
            let before = Selection::of(&self.state);
            if self.state.drag_to(anchor, row, &self.delegate) {
                self.apply(ListOutcome::Changed, before, window, cx);
            }
        }
        self.drag_scroll(dir, window, cx);
    }

    /// Past the top / bottom edge: move the cursor (and the range) a row per tick while the
    /// mouse stays there.
    fn drag_scroll(&mut self, dir: i8, window: &mut Window, cx: &mut Context<Self>) {
        let was = std::mem::replace(&mut self.drag_dir, dir);
        if dir == 0 || was != 0 {
            return;
        }
        self.drag_task = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let go_on = this.update_in(cx, |v, window, cx| {
                    let (Some(anchor), dir) = (v.drag_anchor, v.drag_dir) else {
                        return false;
                    };
                    if dir == 0 {
                        return false;
                    }
                    let row = v.state.cursor.and_then(|c| v.state.row_of(c)).unwrap_or(0);
                    let to = (row as isize + dir as isize).max(0) as usize;
                    let before = Selection::of(&v.state);
                    if v.state.drag_to(anchor, to, &v.delegate) {
                        v.apply(ListOutcome::Changed, before, window, cx);
                    }
                    true
                });
                if !matches!(go_on, Ok(true)) {
                    break;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(DRAG_SCROLL_MS))
                    .await;
            }
        }));
    }

    fn end_drag(&mut self) {
        self.drag_anchor = None;
        self.drag_dir = 0;
        self.drag_task = None;
    }

    fn on_row_hover(
        &mut self,
        ix: usize,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let now = if hovered {
            Some(ix)
        } else if self.state.hovered == Some(ix) {
            None
        } else {
            return;
        };
        if !self.state.set_hovered(now) {
            return;
        }
        if hovered
            && self.delegate.options().hover_selects
            && self.delegate.selectable(ix)
            && self.state.cursor != Some(ix)
        {
            let before = Selection::of(&self.state);
            self.state.cursor = Some(ix);
            self.state.anchor = Some(ix);
            self.state.selected.clear();
            self.apply(ListOutcome::Changed, before, window, cx);
            return;
        }
        cx.notify();
    }

    fn render_rows(
        &mut self,
        rows: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let opts = self.delegate.options();
        let focused = self.focus.contains_focused(window, cx);
        rows.filter_map(|row| {
            let ix = self.state.item_at(row)?;
            let state = RowState {
                selected: self.state.is_selected(ix),
                cursor: self.state.cursor == Some(ix),
                focused,
                hovered: self.state.hovered == Some(ix),
                matches: self.state.matches(ix),
            };
            let selected_at = |r: Option<usize>| {
                r.and_then(|r| self.state.item_at(r))
                    .is_some_and(|i| self.state.is_selected(i))
            };
            let joins = (selected_at(row.checked_sub(1)), selected_at(Some(row + 1)));
            let tint = self.delegate.row_background(ix);
            let content = self.delegate.render_row(ix, state, window, cx);
            Some(row_frame(ix, state, joins, &opts, tint, content, cx))
        })
        .collect()
    }

    fn render_search(&self) -> Option<AnyElement> {
        let query = self.state.query()?;
        let count = self.state.match_count();
        Some(search_row(query, count, self.delegate.options().inset_x).into_any_element())
    }
}

/// Cursor + multi-selection, to tell the delegate when they changed.
#[derive(PartialEq)]
struct Selection(Option<usize>, Vec<usize>);

impl Selection {
    fn of(s: &ListState) -> Self {
        Self(s.cursor, s.selected.iter().copied().collect())
    }
}

/// A selection rect's corners: selected rows next to each other melt into one block, rounded only
/// at its top and bottom (WebStorm's multi-selection).
pub fn selection_corners<E: Styled>(el: E, arc: f32, joins_above: bool, joins_below: bool) -> E {
    let arc = px(arc);
    let el = if joins_above { el } else { el.rounded_t(arc) };
    if joins_below { el } else { el.rounded_b(arc) }
}

/// One row: full width, the row height, the selection / hover rect inset from the edges.
/// `joins`: the rows above / below are selected too.
fn row_frame<D: ListDelegate>(
    ix: usize,
    row: RowState<'_>,
    joins: (bool, bool),
    opts: &ListOptions,
    tint: Option<Rgba>,
    content: AnyElement,
    cx: &mut Context<ListView<D>>,
) -> AnyElement {
    let joins = if row.selected { joins } else { (false, false) };
    let bg = if row.selected {
        Some(if row.focused {
            look::SELECTION_BG
        } else {
            look::SELECTION_BG_INACTIVE
        })
    } else if row.hovered && !opts.hover_selects {
        Some(look::HOVER_BG)
    } else {
        None
    };
    div()
        .id(("list-row", ix))
        .debug_selector(|| format!("list-row-{ix}"))
        .h(opts.row_height)
        .w_full()
        .relative()
        .when_some(tint, |d, tint| d.bg(tint))
        .cursor_pointer()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                this.on_row_down(ix, ev, window, cx)
            }),
        )
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                this.on_row_down(ix, ev, window, cx)
            }),
        )
        .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
            this.on_row_hover(ix, *hovered, window, cx)
        }))
        // the selection / hover rect, inset from the edges, under the content
        .when_some(bg, |d, bg| {
            d.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(opts.inset_x)
                    .right(opts.inset_x)
                    .map(|d| selection_corners(d, look::SELECTION_ARC, joins.0, joins.1))
                    .bg(bg),
            )
        })
        .child(
            div()
                .relative()
                .size_full()
                .px(opts.content_inset_x)
                .flex()
                .items_center()
                .child(content),
        )
        .into_any_element()
}

/// The speed search row over the list: magnifier, the typed text, the match count.
fn search_row(query: &str, count: Option<usize>, inset_x: Pixels) -> impl IntoElement {
    let (count_text, none) = match count {
        None => (SharedString::default(), false),
        Some(0) => ("No matches".into(), true),
        Some(1) => ("1 match".into(), false),
        Some(n) => (SharedString::from(format!("{n} matches")), false),
    };
    div()
        .debug_selector(|| "list-search".into())
        .h(px(look::LIST_ROW_HEIGHT.get()))
        .flex_none()
        .px(inset_x)
        .flex()
        .items_center()
        .child(
            div()
                .size_full()
                .flex()
                .items_center()
                .gap(px(look::TREE_ICON_GAP))
                .px(px(6.))
                .rounded(px(look::SELECTION_ARC))
                .bg(look::SPEED_SEARCH_BG)
                .border_1()
                .border_color(look::SPEED_SEARCH_BORDER)
                .child(Icon::new(IconName::Search))
                .child(
                    div()
                        .flex_1()
                        .text_color(look::TEXT)
                        .child(SharedString::from(query.to_string())),
                )
                .child(
                    div()
                        .text_color(if none {
                            look::SPEED_SEARCH_ERROR_FG
                        } else {
                            look::TEXT_DIM
                        })
                        .child(count_text),
                ),
        )
}

impl<D: ListDelegate> Render for ListView<D> {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // page size from the last layout (the list's viewport / row height)
        let row_h = self.delegate.options().row_height;
        let viewport = self
            .state
            .scroll
            .0
            .borrow()
            .base_handle
            .bounds()
            .size
            .height;
        if viewport > px(0.) {
            self.state
                .set_page_rows(((viewport / row_h).floor() as usize).saturating_sub(1));
        }
        let count = self.state.row_count();
        let search = self.render_search();
        let _ = window;
        // menus: the wheel moves the selection; taken in the capture phase, before the list
        // scrolls itself
        let wheel = self.delegate.options().wheel_selects.then(|| {
            let view = cx.entity().downgrade();
            canvas(
                |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                move |_, hitbox, window, _| {
                    window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
                        if phase == DispatchPhase::Capture && hitbox.is_hovered(window) {
                            let _ = view.update(cx, |v, cx| v.on_wheel(ev, window, cx));
                            cx.stop_propagation();
                        }
                    });
                },
            )
            .absolute()
            .size_full()
        });
        // during a drag-select, moves anywhere in the window count
        let tracker = self.drag_anchor.is_some().then(|| {
            let view = cx.entity().downgrade();
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    window.on_mouse_event(
                        move |ev: &gpui_kit::MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble {
                                let _ = view.update(cx, |v, cx| v.on_drag_move(ev, window, cx));
                            }
                        },
                    );
                },
            )
            .absolute()
            .size_0()
        });
        div()
            .relative()
            .key_context("VimStormList")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &gpui_kit::MouseUpEvent, _, _| this.end_drag()),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _: &gpui_kit::MouseUpEvent, _, _| this.end_drag()),
            )
            .children(tracker)
            .size_full()
            .flex()
            .flex_col()
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .children(search)
            .child(
                uniform_list(
                    "vimstorm-list",
                    count,
                    cx.processor(|this, rows: Range<usize>, window, cx| {
                        this.render_rows(rows, window, cx)
                    }),
                )
                .track_scroll(&self.state.scroll)
                .flex_1(),
            )
            .children(wheel)
    }
}

/// The speed search's match style: the text color only; the match background is a rounded box
/// [`MatchedText`] paints behind it.
pub fn match_style() -> HighlightStyle {
    HighlightStyle {
        color: Some(look::hsla(look::SEARCH_MATCH_FG.rgba())),
        font_weight: None::<FontWeight>,
        ..Default::default()
    }
}

/// A label with the speed search's matched chars highlighted (WebStorm: a rounded match-colored
/// box behind the chars).
pub fn match_text(text: impl Into<SharedString>, matches: &[u32]) -> MatchedText {
    let text = text.into();
    let ranges = char_ranges(&text, matches);
    let style = match_style();
    MatchedText {
        text: StyledText::new(text).with_highlights(ranges.iter().map(|r| (r.clone(), style))),
        boxes: ranges,
    }
}

/// Text with styled byte ranges (sorted, non-overlapping, as `StyledText::with_highlights`);
/// ranges whose style has the search-match background get WebStorm's rounded inset box instead
/// of GPUI's flat full-height background.
pub fn highlighted(
    text: impl Into<SharedString>,
    runs: impl IntoIterator<Item = (Range<usize>, HighlightStyle)>,
) -> MatchedText {
    let match_bg = look::hsla(look::SEARCH_MATCH_BG.rgba());
    let mut boxes: Vec<Range<usize>> = Vec::new();
    let runs: Vec<_> = runs
        .into_iter()
        .map(|(r, mut style)| {
            if style.background_color == Some(match_bg) {
                style.background_color = None;
                match boxes.last_mut() {
                    Some(last) if last.end == r.start => last.end = r.end,
                    _ => boxes.push(r.clone()),
                }
            }
            (r, style)
        })
        .collect();
    MatchedText {
        text: StyledText::new(text).with_highlights(runs),
        boxes,
    }
}

/// Styled text with search-match boxes behind byte ranges: UIUtil.drawSearchMatch's look
/// ([`look::SEARCH_MATCH_INSET_Y`] from the line's top / bottom, [`look::SEARCH_MATCH_ARC`]).
pub struct MatchedText {
    text: StyledText,
    boxes: Vec<Range<usize>>,
}

impl MatchedText {
    /// The byte ranges that get a box.
    pub fn boxes(&self) -> &[Range<usize>] {
        &self.boxes
    }
}

impl IntoElement for MatchedText {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl gpui_kit::Element for MatchedText {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui_kit::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&gpui_kit::GlobalElementId>,
        inspector_id: Option<&gpui_kit::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (gpui_kit::LayoutId, ()) {
        self.text.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&gpui_kit::GlobalElementId>,
        inspector_id: Option<&gpui_kit::InspectorElementId>,
        bounds: gpui_kit::Bounds<Pixels>,
        state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.text
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&gpui_kit::GlobalElementId>,
        inspector_id: Option<&gpui_kit::InspectorElementId>,
        bounds: gpui_kit::Bounds<Pixels>,
        state: &mut (),
        prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let layout = self.text.layout();
        let line_h = layout.line_height();
        let inset = px(look::SEARCH_MATCH_INSET_Y);
        let rects: Vec<_> = self
            .boxes
            .iter()
            .filter_map(|r| {
                let a = layout.position_for_index(r.start)?;
                // past a truncation: to the text's end
                let x1 = layout
                    .position_for_index(r.end)
                    .filter(|b| b.y == a.y)
                    .map_or(bounds.right(), |b| b.x);
                (x1 > a.x).then(|| {
                    gpui_kit::Bounds::from_corners(
                        gpui_kit::point(a.x, a.y + inset),
                        gpui_kit::point(x1, a.y + line_h - inset),
                    )
                })
            })
            .collect();
        for r in rects {
            window.paint_quad(
                gpui_kit::fill(r, look::SEARCH_MATCH_BG).corner_radii(px(look::SEARCH_MATCH_ARC)),
            );
        }
        self.text
            .paint(id, inspector_id, bounds, state, prepaint, window, cx)
    }
}

/// Byte ranges of the chars at `matches` (sorted char indices), adjacent ones merged.
pub fn char_ranges(text: &str, matches: &[u32]) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut want = matches.iter().copied().peekable();
    for (ci, (bi, ch)) in text.char_indices().enumerate() {
        let Some(&m) = want.peek() else { break };
        if m as usize != ci {
            continue;
        }
        want.next();
        let r = bi..bi + ch.len_utf8();
        match out.last_mut() {
            Some(last) if last.end == r.start => last.end = r.end,
            _ => out.push(r),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Items(Vec<&'static str>);

    impl ListSource for Items {
        fn len(&self) -> usize {
            self.0.len()
        }
        fn text(&self, ix: usize) -> SharedString {
            self.0[ix].into()
        }
        fn selectable(&self, ix: usize) -> bool {
            self.0[ix] != "-"
        }
    }

    fn state(items: &Items, filtering: bool) -> ListState {
        let mut s = ListState::new();
        s.filtering = filtering;
        s.refresh(items);
        s
    }

    fn keys(s: &mut ListState, items: &Items, opts: &ListOptions, ks: &[&str]) -> ListOutcome {
        let mut last = ListOutcome::Ignored;
        for k in ks {
            // a single char types itself
            let typed = (k.chars().count() == 1).then_some(*k);
            last = s.key(k, typed, items, opts);
        }
        last
    }

    struct Move {
        name: &'static str,
        items: &'static [&'static str],
        opts: fn() -> ListOptions,
        from: Option<usize>,
        page_rows: Option<usize>,
        keys: &'static [&'static str],
        cursor: usize,
    }

    /// Eight rows with a separator (`-`) at 2.
    const EIGHT: &[&str] = &["a", "b", "-", "c", "d", "e", "f", "g"];
    const THREE: &[&str] = &["a", "b", "c"];

    /// A wrapping list that doesn't type `L` / `Ö` into a search (a dropdown does).
    fn wrapping() -> ListOptions {
        ListOptions {
            type_to_search: false,
            ..ListOptions::menu()
        }
    }

    const MOVES: &[Move] = &[
        Move {
            name: "the first move down selects the first row",
            items: EIGHT,
            opts: ListOptions::default,
            from: None,
            page_rows: None,
            keys: &["ö"],
            cursor: 0,
        },
        Move {
            name: "Down skips a separator",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(1),
            page_rows: None,
            keys: &["<Down>"],
            cursor: 3,
        },
        Move {
            name: "l moves up over a separator",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(3),
            page_rows: None,
            keys: &["l"],
            cursor: 1,
        },
        Move {
            name: "End goes to the last row",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(0),
            page_rows: None,
            keys: &["<End>"],
            cursor: 7,
        },
        Move {
            name: "Down on the last row of a list that doesn't wrap stays",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(7),
            page_rows: None,
            keys: &["<Down>"],
            cursor: 7,
        },
        Move {
            name: "Home goes to the first row",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(5),
            page_rows: None,
            keys: &["<Home>"],
            cursor: 0,
        },
        Move {
            name: "Ö moves five rows down",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(0),
            page_rows: None,
            keys: &["Ö"],
            cursor: 6,
        },
        Move {
            name: "PageUp moves a page",
            items: EIGHT,
            opts: ListOptions::default,
            from: Some(6),
            page_rows: Some(3),
            keys: &["<PageUp>"],
            cursor: 3,
        },
        Move {
            name: "Ö stops at the end of a list that doesn't wrap",
            items: THREE,
            opts: ListOptions::default,
            from: Some(0),
            page_rows: None,
            keys: &["Ö"],
            cursor: 2,
        },
        Move {
            name: "Ö wraps round a wrapping list",
            items: THREE,
            opts: wrapping,
            from: Some(0),
            page_rows: None,
            keys: &["Ö"],
            cursor: 2,
        },
        Move {
            name: "L wraps round a wrapping list",
            items: THREE,
            opts: wrapping,
            from: Some(2),
            page_rows: None,
            keys: &["L"],
            cursor: 0,
        },
        Move {
            name: "Up in a menu with no selection goes to the last row",
            items: THREE,
            opts: ListOptions::menu,
            from: None,
            page_rows: None,
            keys: &["<Up>"],
            cursor: 2,
        },
        Move {
            name: "Down on a menu's last row wraps to the first",
            items: THREE,
            opts: ListOptions::menu,
            from: Some(2),
            page_rows: None,
            keys: &["<Down>"],
            cursor: 0,
        },
        Move {
            name: "Shift+Tab on a menu's first row wraps to the last",
            items: THREE,
            opts: ListOptions::menu,
            from: Some(0),
            page_rows: None,
            keys: &["<S-Tab>"],
            cursor: 2,
        },
    ];

    #[test]
    fn moves_with_his_keys_and_arrows() {
        for m in MOVES {
            let items = Items(m.items.to_vec());
            let opts = (m.opts)();
            let mut s = state(&items, true);
            s.set_cursor(m.from);
            if let Some(rows) = m.page_rows {
                s.set_page_rows(rows);
            }
            keys(&mut s, &items, &opts, m.keys);
            assert_eq!(s.cursor(), Some(m.cursor), "{}", m.name);
        }
        // letters other than his moves do nothing
        let items = Items(EIGHT.to_vec());
        let opts = ListOptions::default();
        let mut s = state(&items, true);
        for k in ["x", "k"] {
            assert_eq!(
                s.key(k, Some(k), &items, &opts),
                ListOutcome::Ignored,
                "{k}"
            );
        }
    }

    #[test]
    fn vim_counts_first_last_and_doubled_keys_in_lists_only() {
        let items = Items((0..40).map(|_| "row").collect());
        let opts = ListOptions {
            vim: Some("y"),
            ..ListOptions::tree()
        };
        let mut s = state(&items, true);
        s.set_cursor(Some(0));
        keys(&mut s, &items, &opts, &["2", "2", "ö"]);
        assert_eq!(s.cursor(), Some(22));
        keys(&mut s, &items, &opts, &["3", "L"]);
        assert_eq!(s.cursor(), Some(7));
        keys(&mut s, &items, &opts, &["G"]);
        assert_eq!(s.cursor(), Some(39));
        keys(&mut s, &items, &opts, &["g", "g"]);
        assert_eq!(s.cursor(), Some(0));
        assert_eq!(
            keys(&mut s, &items, &opts, &["y", "y"]),
            ListOutcome::Vim(vim::Cmd::Yank)
        );
        // `d` isn't this list's: an ordinary (unused) key
        assert_eq!(keys(&mut s, &items, &opts, &["d"]), ListOutcome::Ignored);
        // a dropdown types digits and g into its search
        let menu = ListOptions {
            vim: Some("y"),
            ..ListOptions::menu()
        };
        keys(&mut s, &items, &menu, &["2", "g"]);
        assert_eq!(s.query(), Some("2g"));
    }

    #[test]
    fn a_search_without_matches_then_cleared_gives_the_cursor_back() {
        let items = Items(vec!["alpha", "beta", "gamma"]);
        let opts = ListOptions::menu();
        let mut s = state(&items, true);
        keys(&mut s, &items, &opts, &["<Down>", "<Down>"]);
        assert_eq!(s.cursor(), Some(1));
        keys(&mut s, &items, &opts, &["/", "z", "z"]);
        assert_eq!(s.match_count(), Some(0));
        assert_eq!(s.cursor(), None);
        // erased: back on beta, Enter opens it
        keys(&mut s, &items, &opts, &["<BS>", "<BS>"]);
        assert_eq!(s.cursor(), Some(1));
        assert_eq!(
            keys(&mut s, &items, &opts, &["<CR>"]),
            ListOutcome::Confirm(1)
        );
        // closed with Esc after no match: back too
        keys(&mut s, &items, &opts, &["/", "q", "<Esc>"]);
        assert_eq!(s.cursor(), Some(1));
        // a match moves the cursor and keeps it when the search closes
        keys(&mut s, &items, &opts, &["/", "g", "<Esc>"]);
        assert_eq!(s.cursor(), Some(2));
    }

    #[test]
    fn wheel_steps_move_the_selection() {
        let items = Items(vec!["a", "b", "-", "c"]);
        let menu = ListOptions::menu();
        let mut s = state(&items, true);
        assert_eq!(s.wheel(0, &items, &menu), ListOutcome::Ignored);
        s.wheel(2, &items, &menu);
        assert_eq!(s.cursor(), Some(1));
        s.wheel(1, &items, &menu);
        assert_eq!(s.cursor(), Some(3), "over the separator");
        s.wheel(1, &items, &menu);
        assert_eq!(s.cursor(), Some(0), "wraps like the keys");
    }

    #[test]
    fn match_boxes_replace_the_flat_match_background() {
        let m = match_text("filetree.lua", &[4, 5, 6, 7, 9]);
        assert_eq!(m.boxes(), &[4..8, 9..10]);
        let syntax = HighlightStyle {
            color: Some(look::hsla(look::TEXT_DIM.rgba())),
            ..Default::default()
        };
        let mut matched = match_style();
        matched.background_color = Some(look::hsla(look::SEARCH_MATCH_BG.rgba()));
        let m = highlighted("abcdef", [(0..2, syntax), (2..3, matched), (3..4, matched)]);
        assert_eq!(m.boxes(), std::slice::from_ref(&(2..4)));
    }

    /// The wheel over a menu list moves its selection (real scroll events through the view).
    #[test]
    fn wheel_over_a_menu_view_moves_the_selection() {
        use gpui_kit::{
            Modifiers, TestAppContext, TestDispatcher, TouchPhase, VisualTestContext, point, size,
        };
        struct Menu(Items);
        impl ListSource for Menu {
            fn len(&self) -> usize {
                self.0.len()
            }
            fn text(&self, ix: usize) -> SharedString {
                self.0.text(ix)
            }
        }
        impl ListDelegate for Menu {
            fn options(&self) -> ListOptions {
                // (no hover selection: the pointer stays over one row)
                ListOptions {
                    hover_selects: false,
                    ..ListOptions::menu()
                }
            }
            fn render_row(
                &mut self,
                ix: usize,
                _: RowState<'_>,
                _: &mut Window,
                _: &mut Context<ListView<Self>>,
            ) -> AnyElement {
                self.0.text(ix).into_any_element()
            }
        }
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        let window = app.open_window(size(px(300.), px(200.)), |_, cx| {
            ListView::new(Menu(Items(vec!["a", "b", "c", "d"])), cx)
        });
        let list = window.root(&mut app).unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), &app);
        cx.run_until_parked();
        let at = point(px(100.), px(30.));
        for _ in 0..2 {
            cx.simulate_event(ScrollWheelEvent {
                position: at,
                delta: ScrollDelta::Lines(point(0., -1.)),
                modifiers: Modifiers::default(),
                touch_phase: TouchPhase::Moved,
            });
        }
        assert_eq!(list.read_with(&cx, |l, _| l.state.cursor()), Some(1));
        // trackpad pixels: a row's worth up
        let row = ListOptions::menu().row_height;
        cx.simulate_event(ScrollWheelEvent {
            position: at,
            delta: ScrollDelta::Pixels(point(px(0.), row)),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        });
        assert_eq!(list.read_with(&cx, |l, _| l.state.cursor()), Some(0));
    }

    #[test]
    fn search_only_after_slash() {
        let items = Items(vec!["alpha", "beta", "gamma", "delta", "lambda"]);
        let opts = ListOptions::default();
        let mut s = state(&items, true);
        keys(&mut s, &items, &opts, &["ö", "ö"]);
        assert_eq!(s.cursor(), Some(1));
        // typing letters doesn't search
        keys(&mut s, &items, &opts, &["d", "e"]);
        assert!(!s.searching());
        assert_eq!(s.row_count(), 5);
        keys(&mut s, &items, &opts, &["/", "l", "t"]);
        assert_eq!(s.query(), Some("lt"));
        // fuzzy filter, order kept, first match selected
        let shown: Vec<_> = (0..s.row_count()).map(|r| s.item_at(r).unwrap()).collect();
        assert_eq!(shown, [3]);
        assert_eq!(s.cursor(), Some(3));
        assert_eq!(s.matches(3), &[2, 3]);
        assert_eq!(s.match_count(), Some(1));
        // l / ö type while searching
        keys(&mut s, &items, &opts, &["<BS>", "<BS>", "a"]);
        assert_eq!(s.query(), Some("a"));
        assert_eq!(s.row_count(), 5);
        keys(&mut s, &items, &opts, &["<Down>", "<Down>"]);
        assert_eq!(s.cursor(), Some(2));
        // Esc closes the search, keeps the item
        assert_eq!(
            keys(&mut s, &items, &opts, &["<Esc>"]),
            ListOutcome::Changed
        );
        assert!(!s.searching());
        assert_eq!(s.cursor(), Some(2));
        assert!(s.matches(2).is_empty());
        // then Esc cancels
        assert_eq!(keys(&mut s, &items, &opts, &["<Esc>"]), ListOutcome::Cancel);
    }

    #[test]
    fn dropdowns_filter_on_every_letter() {
        let items = Items(vec!["alpha", "beta", "gamma", "delta", "Kappa 2"]);
        let opts = ListOptions::menu();
        let mut s = state(&items, true);
        s.set_cursor(Some(0));
        // arrows and Ctrl-n / Ctrl-p move
        keys(&mut s, &items, &opts, &["<Down>", "<C-n>", "<C-p>"]);
        assert_eq!(s.cursor(), Some(1));
        assert!(!s.searching());
        // any text starts the search at once: the first match selected
        keys(&mut s, &items, &opts, &["t"]);
        assert_eq!(s.query(), Some("t"));
        assert_eq!(s.row_count(), 2);
        assert_eq!(s.cursor(), Some(1));
        // Arrow keys keep navigating while search owns letter input.
        keys(&mut s, &items, &opts, &["a"]);
        assert_eq!(s.query(), Some("ta"));
        keys(&mut s, &items, &opts, &["<Down>"]);
        assert_eq!((s.query(), s.cursor()), (Some("ta"), Some(3)));
        keys(&mut s, &items, &opts, &["<Up>"]);
        assert_eq!((s.query(), s.cursor()), (Some("ta"), Some(1)));
        keys(&mut s, &items, &opts, &["ö", "l", "k", "ä"]);
        assert_eq!(s.query(), Some("taölkä"));
        // upper case, digits, space and punctuation type (L / Ö too)
        keys(&mut s, &items, &opts, &["<D-BS>", "K", " ", "2"]);
        assert_eq!(s.query(), Some("K 2"));
        assert_eq!(s.cursor(), Some(4));
        keys(&mut s, &items, &opts, &["<D-BS>", "L", "Ö", "."]);
        assert_eq!(s.query(), Some("LÖ."));
        // Backspace edits; Esc resets the search (WS goBack), keeping the item, then cancels
        keys(&mut s, &items, &opts, &["<D-BS>", "g", "m", "<BS>"]);
        assert_eq!((s.query(), s.cursor()), (Some("g"), Some(2)));
        assert_eq!(
            keys(&mut s, &items, &opts, &["<Esc>"]),
            ListOutcome::Changed
        );
        assert!(!s.searching());
        assert_eq!((s.row_count(), s.cursor()), (5, Some(2)));
        assert_eq!(keys(&mut s, &items, &opts, &["<Esc>"]), ListOutcome::Cancel);
        // `/` still opens it (empty)
        keys(&mut s, &items, &opts, &["/"]);
        assert_eq!(s.query(), Some(""));
        keys(&mut s, &items, &opts, &["k", "l", "ö", "ä"]);
        assert_eq!(s.query(), Some("klöä"));
        // k / l / ö / ä start the search too: no letter moves a dropdown
        for letter in ["k", "l", "ö", "ä"] {
            let mut s = state(&items, true);
            s.set_cursor(Some(0));
            assert_eq!(
                s.key(letter, Some(letter), &items, &opts),
                ListOutcome::Changed
            );
            assert_eq!(s.query(), Some(letter));
        }
        // lists that search after `/` keep letters for navigation
        let mut s = state(&items, true);
        let tree = ListOptions::tree();
        assert_eq!(s.key("t", Some("t"), &items, &tree), ListOutcome::Ignored);
        assert!(!s.searching());
    }

    #[test]
    fn backspace_on_empty_search_closes_it() {
        let items = Items(vec!["a", "b"]);
        let opts = ListOptions::default();
        let mut s = state(&items, true);
        keys(&mut s, &items, &opts, &["/", "x"]);
        assert_eq!(s.match_count(), Some(0));
        assert_eq!(s.row_count(), 0);
        keys(&mut s, &items, &opts, &["<BS>"]);
        assert_eq!(s.query(), Some(""));
        assert_eq!(s.row_count(), 2);
        keys(&mut s, &items, &opts, &["<BS>"]);
        assert!(!s.searching());
    }

    #[test]
    fn highlight_search_jumps_between_matches() {
        let items = Items(vec!["one", "two", "three", "four", "twelve"]);
        let opts = ListOptions {
            search: SearchMode::Highlight,
            ..ListOptions::default()
        };
        let mut s = state(&items, false);
        keys(&mut s, &items, &opts, &["/", "t", "w"]);
        assert_eq!(s.row_count(), 5);
        assert_eq!(s.cursor(), Some(1));
        keys(&mut s, &items, &opts, &["<Down>"]);
        assert_eq!(s.cursor(), Some(4));
        keys(&mut s, &items, &opts, &["<Up>"]);
        assert_eq!(s.cursor(), Some(1));
    }

    #[test]
    fn multi_select_with_shift_and_toggle() {
        let items = Items(vec!["a", "b", "c", "d", "e"]);
        let opts = ListOptions::tree();
        let mut s = state(&items, true);
        s.set_cursor(Some(1));
        keys(&mut s, &items, &opts, &["<S-Down>", "<S-Down>"]);
        assert_eq!(s.selection(), [1, 2, 3]);
        keys(&mut s, &items, &opts, &["<S-Up>"]);
        assert_eq!(s.selection(), [1, 2]);
        // plain move clears it
        keys(&mut s, &items, &opts, &["<Down>"]);
        assert_eq!(s.selection(), [3]);
        // Shift+click: range from the anchor
        let shift = Modifiers {
            shift: true,
            ..Default::default()
        };
        s.click(0, shift, 1, &items, &opts);
        assert_eq!(s.selection(), [0, 1, 2, 3]);
        // Cmd+click toggles
        let cmd = Modifiers {
            platform: true,
            ..Default::default()
        };
        s.click(2, cmd, 1, &items, &opts);
        assert_eq!(s.selection(), [0, 1, 3]);
        s.click(4, cmd, 1, &items, &opts);
        assert_eq!(s.selection(), [0, 1, 3, 4]);
        // Esc clears the multi-selection first
        assert_eq!(
            keys(&mut s, &items, &opts, &["<Esc>"]),
            ListOutcome::Changed
        );
        assert_eq!(s.selection(), [4]);
        // first toggle keeps the selected row
        s.click(1, cmd, 1, &items, &opts);
        assert_eq!(s.selection(), [1, 4]);
        // plain click selects one; double-click confirms
        s.click(2, Modifiers::default(), 1, &items, &opts);
        assert_eq!(s.selection(), [2]);
        assert_eq!(
            s.click(2, Modifiers::default(), 2, &items, &opts),
            ListOutcome::Confirm(2)
        );
        assert_eq!(
            keys(&mut s, &items, &opts, &["<CR>"]),
            ListOutcome::Confirm(2)
        );
    }

    #[test]
    fn secondary_click_keeps_a_selection_it_hits() {
        let items = Items(vec!["a", "b", "c"]);
        let opts = ListOptions::tree();
        let mut s = state(&items, true);
        s.set_cursor(Some(0));
        keys(&mut s, &items, &opts, &["<S-Down>"]);
        s.secondary_click(1, &items);
        assert_eq!(s.selection(), [0, 1]);
        s.secondary_click(2, &items);
        assert_eq!(s.selection(), [2]);
    }

    #[test]
    fn ten_thousand_rows_filter_fast() {
        let names: Vec<&'static str> = (0..20_000)
            .map(|i| &*Box::leak(format!("src/dir{}/file{i}.ts", i % 97).into_boxed_str()))
            .collect();
        let items = Items(names);
        let opts = ListOptions::default();
        let mut s = state(&items, true);
        let t = std::time::Instant::now();
        keys(&mut s, &items, &opts, &["/", "f", "1", "2", "3", "4"]);
        assert!(s.match_count().unwrap() > 0);
        // debug build budget; release is ~10x faster
        assert!(t.elapsed().as_millis() < 1500, "{:?}", t.elapsed());
    }

    #[test]
    fn char_ranges_merge_and_handle_utf8() {
        assert_eq!(char_ranges("abcd", &[0, 1, 3]), [0..2, 3..4]);
        assert_eq!(char_ranges("åäö.ts", &[1, 2]).first(), Some(&(2..6)));
        assert!(char_ranges("ab", &[]).is_empty());
    }
}
