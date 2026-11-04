//! The filter chips' popups (b / u / d / p, a chip click): a titled list under the chip, the M4
//! Lua `pick` rules (`git/init.lua`): "All" first (choosing it clears the filter), the caret starts on
//! the filter's value (else on "All"), arrows / Ctrl-n / Ctrl-p move, typing starts a search
//! at once (filter mode; `/` too), Enter picks (right after typing a search: the first match,
//! never "All"), Esc clears the search, then cancels, a click on a row picks it. User and Paths:
//! Tab marks several (WS: checkmarks; "All" among them = clear).
//!
//! The popup is drawn by the Log over everything (`deferred` + [`crate::kit::placed`]) and
//! opens at once, in the key's handler, so keys typed right after `u` reach its list; choices
//! that load from git ("Loading…") are filled in when they come, and an Enter typed before that
//! picks once they're in.

use std::collections::BTreeSet;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, CursorStyle, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseUpEvent,
    ParentElement as _, Pixels, SharedString, Styled as _, Window, deferred, div,
    prelude::FluentBuilder as _, px,
};

use super::filters::FilterKind;
use crate::kit::{self, Anchor};
use crate::kit::{Icon, IconName};
use crate::kit::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, SearchMode, match_text,
};
use crate::look;

/// The popup's answer: the chosen items' texts (list order), None when cancelled.
pub type Done = Rc<dyn Fn(Option<Vec<String>>, &mut Window, &mut App)>;

/// The "All" row (clears the filter).
pub const ALL: &str = "All";
/// Rows shown at most; more scroll.
const MAX_ROWS: usize = 15;
/// Width of the checkmark column of the multi-select lists.
const CHECK_COLUMN: f32 = 20.;
const MIN_WIDTH: f32 = 180.;
const MAX_WIDTH: f32 = 480.;

/// The list's rows and what Enter / Esc / Tab / a click do.
pub struct PickList {
    pub items: Vec<SharedString>,
    /// Tab marks several (User, Paths).
    multi: bool,
    /// Items marked with Tab.
    pub marked: BTreeSet<usize>,
    /// The choices are still loading (only "All" listed).
    pub loading: bool,
    /// Enter came while loading: pick once the choices are in.
    confirm_on_load: bool,
    on_done: Done,
}

impl PickList {
    /// Picks the marked items, else `ix`.
    fn pick(&mut self, ix: usize, window: &mut Window, cx: &mut App) {
        let chosen: Vec<String> = if self.marked.is_empty() {
            self.items
                .get(ix)
                .map(|s| s.to_string())
                .into_iter()
                .collect()
        } else {
            self.marked
                .iter()
                .filter_map(|&i| self.items.get(i).map(|s| s.to_string()))
                .collect()
        };
        if chosen.is_empty() {
            return;
        }
        (self.on_done)(Some(chosen), window, cx);
    }

    /// Tab / Shift+Tab: marks (or unmarks) the caret's item and moves on (snacks'
    /// select_and_next).
    fn toggle_mark(&mut self, state: &mut ListState, down: bool) {
        if let Some(ix) = state.cursor()
            && !self.marked.remove(&ix)
        {
            self.marked.insert(ix);
        }
        let opts = self.options();
        state.key(if down { "<Down>" } else { "<Up>" }, None, self, &opts);
    }
}

impl ListSource for PickList {
    fn len(&self) -> usize {
        self.items.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        self.items.get(ix).cloned().unwrap_or_default()
    }
}

impl ListDelegate for PickList {
    fn options(&self) -> ListOptions {
        ListOptions {
            wrap: false,
            hover_selects: true,
            search: SearchMode::Filter,
            type_to_search: true,
            ..ListOptions::default()
        }
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let label = self.items.get(ix).cloned().unwrap_or_default();
        let marked = self.marked.contains(&ix);
        div()
            .size_full()
            .flex()
            .items_center()
            .when(self.multi, |d| {
                d.child(
                    div()
                        .flex_none()
                        .w(px(CHECK_COLUMN))
                        .children(marked.then(|| Icon::new(IconName::Checked))),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(match_text(label, row.matches)),
            )
            // a click picks (the row's mouse down selected it)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, ev: &MouseUpEvent, window, cx| {
                    if ev.modifiers.platform || ev.modifiers.shift {
                        return;
                    }
                    this.delegate.pick(ix, window, cx);
                }),
            )
            .into_any_element()
    }

    fn on_key(
        &mut self,
        key: &str,
        state: &mut ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) -> bool {
        // Enter while the choices load (`u/marcus<Enter>` right after the app started: the
        // search has nothing to match yet, so the list wouldn't confirm): pick once they're in
        if self.loading && key == "<CR>" {
            self.confirm_on_load = true;
            return true;
        }
        if !self.multi || !(key == "<Tab>" || key == "<S-Tab>") {
            return false;
        }
        self.toggle_mark(state, key == "<Tab>");
        true
    }

    fn confirm(
        &mut self,
        ix: usize,
        _state: &ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        if self.loading {
            self.confirm_on_load = true;
            return;
        }
        self.pick(ix, window, cx);
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<ListView<Self>>) {
        (self.on_done)(None, window, cx);
    }
}

/// An open filter popup.
pub struct OpenPopup {
    pub kind: FilterKind,
    pub title: SharedString,
    pub anchor: Anchor,
    pub list: Entity<ListView<PickList>>,
    width: Pixels,
}

/// What [`OpenPopup::new`] lists.
pub struct Choices {
    /// After "All".
    pub items: Vec<String>,
    /// The filter's value: the caret starts there (else on "All").
    pub current: Option<String>,
    /// Still loading: just "All" until [`OpenPopup::set_items`].
    pub loading: bool,
}

fn is_multi(kind: FilterKind) -> bool {
    matches!(kind, FilterKind::User | FilterKind::Paths)
}

impl OpenPopup {
    /// The popup, its list focused.
    pub fn new(
        kind: FilterKind,
        title: impl Into<SharedString>,
        choices: Choices,
        anchor: Anchor,
        on_done: Done,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let multi = is_multi(kind);
        let items = with_all(choices.items);
        let width = list_width(&items, multi, window);
        let at = caret_of(&items, choices.current.as_deref());
        let list = cx.new(|cx| {
            let mut l = ListView::new(
                PickList {
                    items,
                    multi,
                    marked: BTreeSet::new(),
                    loading: choices.loading,
                    confirm_on_load: false,
                    on_done,
                },
                cx,
            );
            l.state.set_cursor(Some(at));
            l
        });
        let handle = list.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        OpenPopup {
            kind,
            title: title.into(),
            anchor,
            list,
            width,
        }
    }

    /// The loaded choices: listed (the caret on the filter's value unless it moved or a search
    /// is on); an Enter typed while loading picks now.
    pub fn set_items(
        &mut self,
        items: Vec<String>,
        current: Option<&str>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let items = with_all(items);
        self.width = list_width(&items, is_multi(self.kind), window);
        let at = caret_of(&items, current);
        let pick = self.list.update(cx, |l, cx| {
            let untouched = l.state.cursor() == Some(0) && !l.state.searching();
            l.delegate.items = items;
            l.delegate.loading = false;
            l.delegate.marked.clear();
            l.refresh(cx);
            if l.state.query().is_some_and(|q| !q.is_empty()) {
                // the first match, as typing the search would have picked
                let first = l.state.item_at(0);
                l.state.set_cursor(first);
            } else if untouched {
                l.state.set_cursor(Some(at));
            }
            if std::mem::take(&mut l.delegate.confirm_on_load) {
                l.state.cursor()
            } else {
                None
            }
        });
        // an Enter typed while loading: pick now, outside the Log's update that brought the
        // items (picking updates the Log)
        if let Some(ix) = pick {
            let list = self.list.clone();
            window.defer(cx, move |window, cx| {
                list.update(cx, |l, cx| l.delegate.pick(ix, window, cx));
            });
        }
    }

    /// The popup (over everything, under its anchor). `on_cancel`: a click outside.
    pub fn render(&self, on_cancel: Done, cx: &App) -> AnyElement {
        let l = self.list.read(cx);
        let row_h = l.delegate.options().row_height;
        let rows = l.state.row_count().clamp(1, MAX_ROWS) as f32;
        let search = if l.state.searching() { 1. } else { 0. };
        let loading = l.delegate.loading;
        let body = kit::popup_frame()
            .id("git-log-filter-popup")
            .debug_selector(|| "git-log-filter-popup".into())
            .w(self.width)
            .cursor(CursorStyle::Arrow)
            .on_mouse_down_out(move |_, window, cx| on_cancel(None, window, cx))
            // keys the list leaves alone stop here (the Git tool window's Esc / leader / letters
            // must not act while the popup has the keyboard); Cmd shortcuts go on
            .on_key_down(|ev: &KeyDownEvent, _, cx| {
                if !ev.keystroke.modifiers.platform && kit::notation(ev).is_some() {
                    cx.stop_propagation();
                }
            })
            .child(kit::header(self.title.clone(), None))
            .child(
                div()
                    .flex_none()
                    .py(px(look::POPUP_PADDING_Y / 2.))
                    .child(div().h(row_h * (rows + search)).child(self.list.clone())),
            )
            .when(loading, |d| d.child(kit::ad_text("Loading…")));
        deferred(kit::placed(self.anchor, body))
            .with_priority(2)
            .into_any_element()
    }

    // ---- state (tests) -------------------------------------------------------------------------

    /// The rows shown (search filtered), top to bottom.
    pub fn rows(&self, cx: &App) -> Vec<String> {
        let l = self.list.read(cx);
        (0..l.state.row_count())
            .filter_map(|r| l.state.item_at(r))
            .map(|i| l.delegate.items[i].to_string())
            .collect()
    }

    /// The item under the caret.
    pub fn caret(&self, cx: &App) -> Option<String> {
        let l = self.list.read(cx);
        l.state
            .cursor()
            .and_then(|i| l.delegate.items.get(i))
            .map(|s| s.to_string())
    }

    /// Items marked with Tab.
    pub fn marked(&self, cx: &App) -> Vec<String> {
        let l = self.list.read(cx);
        l.delegate
            .marked
            .iter()
            .map(|&i| l.delegate.items[i].to_string())
            .collect()
    }

    pub fn loading(&self, cx: &App) -> bool {
        self.list.read(cx).delegate.loading
    }
}

fn with_all(items: Vec<String>) -> Vec<SharedString> {
    std::iter::once(ALL.to_string())
        .chain(items)
        .map(SharedString::from)
        .collect()
}

/// The caret's item: the filter's value, else "All".
fn caret_of(items: &[SharedString], current: Option<&str>) -> usize {
    current
        .and_then(|c| items.iter().position(|i| i.as_ref() == c))
        .unwrap_or(0)
}

/// The widest label (first 500 rows) + the row insets, within WS-like bounds.
fn list_width(items: &[SharedString], multi: bool, window: &Window) -> Pixels {
    let widest = items
        .iter()
        .take(500)
        .map(|s| super::filters::text_width(window, s))
        .fold(0., f32::max);
    let insets = 2. * (look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X) + 2.;
    let check = if multi { CHECK_COLUMN } else { 0. };
    px((widest + insets + check).clamp(MIN_WIDTH, MAX_WIDTH))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_starts_on_the_value_else_all() {
        let items = with_all(vec!["HEAD".into(), "main".into()]);
        assert_eq!(items[0].as_ref(), ALL);
        assert_eq!(caret_of(&items, Some("main")), 2);
        assert_eq!(caret_of(&items, Some("gone")), 0);
        assert_eq!(caret_of(&items, None), 0);
    }

    #[test]
    fn tab_marks_and_moves_on() {
        let done: Done = Rc::new(|_, _, _| {});
        let mut d = PickList {
            items: with_all(vec!["a".into(), "b".into(), "c".into()]),
            multi: true,
            marked: BTreeSet::new(),
            loading: false,
            confirm_on_load: false,
            on_done: done,
        };
        let mut s = ListState::new();
        s.refresh(&d);
        s.set_cursor(Some(1));
        d.toggle_mark(&mut s, true);
        d.toggle_mark(&mut s, true);
        assert_eq!(d.marked.iter().copied().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(s.cursor(), Some(3));
        // Shift+Tab marks 3, then unmarks 2 (already marked)
        d.toggle_mark(&mut s, false);
        d.toggle_mark(&mut s, false);
        assert_eq!(d.marked.iter().copied().collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(s.cursor(), Some(1));
    }
}
