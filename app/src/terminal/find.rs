//! Find in the terminal (Cmd+F), the Lua find's behaviour with WebStorm's floating search bar look:
//! a bar over the top-right corner of the output (search field with Match Case / Regex toggles,
//! "3/12" or "No matches" in red, ↑ ↓ ×). Matches in the whole scrollback are highlighted (plain
//! text, ignoring case unless Match Case), the current one in the current-match color; it starts at
//! the newest (bottom) one. Like WS (RwTerminalSearchSession): Enter / Cmd+G = Next Occurrence
//! (down, newer), Shift+Enter / Cmd+Shift+G = Previous (up, older); ↑ / Ctrl+L up, ↓ / Ctrl+Ö
//! down; wrapping. Esc closes back to typing at the prompt; leaving the field
//! closes it. New output re-searches (coalesced, 150 ms like Lua), keeping the current match where
//! it was. The last text comes back selected next time (typing replaces it).

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use alacritty_terminal::grid::{Dimensions as _, Scroll};
use gpui_kit::{
    AnyElement, AppContext as _, Bounds, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Point,
    Styled as _, Task, Window, canvas, div, px,
};

use super::TerminalView;
use super::text::{self, Match};
use crate::kit::IconButton;
use crate::kit::IconName;
use crate::kit::notation;
use crate::kit::{SearchField, SearchFieldEvent};
use crate::look;

/// Re-search after output at most this often.
const RESEARCH_DELAY: Duration = Duration::from_millis(150);
/// The field's width (WS SearchTextArea: 14 columns + the toggles); the bar = field + count +
/// ↑ ↓ ×, its preferred width.
const FIELD_WIDTH: f32 = 190.;
/// The field's insets: WS `Editor.SearchField.borderInsets.compact` (3, 10, 3, 8).
const FIELD_PAD_LEFT: f32 = 10.;
const FIELD_PAD_RIGHT: f32 = 8.;
/// WS's floating search component: field background (`Editor.SearchField.background`) and its
/// left / bottom border (`Editor.Toolbar.borderColor`).
const BAR_BG: u32 = 0x212224;
const BAR_BORDER: u32 = 0x26282b;

/// What the next Cmd+F starts with.
#[derive(Clone, Debug, Default)]
pub struct LastFind {
    pub query: String,
    pub match_case: bool,
    pub regex: bool,
}

/// Buttons' ids and painted bounds.
type Painted = Rc<std::cell::RefCell<Vec<(&'static str, Bounds<Pixels>)>>>;

pub struct Find {
    field: Entity<SearchField>,
    pub matches: Rc<Vec<Match>>,
    /// Current match, 1-based (0: none).
    cur: usize,
    query: String,
    /// The tab searched.
    tab: u64,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    /// The ↑ ↓ × buttons as last painted (tests click them).
    buttons: Painted,
    pending: Option<Task<()>>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl Find {
    /// Index of the current match.
    pub fn current(&self) -> Option<usize> {
        self.cur.checked_sub(1)
    }
}

impl TerminalView {
    /// The find field's text and selection (tests: "the last text comes back selected").
    pub fn find_field(&self, cx: &gpui_kit::App) -> Option<(String, std::ops::Range<usize>)> {
        let f = self.find.as_ref()?;
        let field = f.field.read(cx).field().read(cx);
        Some((field.text().to_owned(), field.selection()))
    }

    /// Where a find button ("terminal-find-up" / "-down" / "-close") was last painted.
    pub fn find_button(&self, id: &str) -> Option<Bounds<Pixels>> {
        let f = self.find.as_ref()?;
        f.buttons
            .borrow()
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, b)| *b)
    }

    /// The count label as drawn ("3/12", "No matches", "").
    pub fn find_label(&self) -> Option<String> {
        let f = self.find.as_ref()?;
        Some(if f.query.is_empty() {
            String::new()
        } else if f.matches.is_empty() {
            "No matches".into()
        } else {
            format!("{}/{}", f.cur, f.matches.len())
        })
    }

    /// The count label's color (red for "No matches").
    pub fn find_label_color(&self) -> Option<gpui_kit::Rgba> {
        let none = self.find_label()? == "No matches";
        Some(if none {
            look::TEXT_ERROR.rgba()
        } else {
            look::TEXT_DIM.rgba()
        })
    }

    pub(super) fn find_focused(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        self.find
            .as_ref()
            .is_some_and(|f| f.field.focus_handle(cx).contains_focused(window, cx))
    }

    pub(super) fn find_contains(&self, pos: Point<Pixels>) -> bool {
        self.find
            .as_ref()
            .is_some_and(|f| f.bounds.get().contains(&pos))
    }

    /// Cmd+F: opens the bar (or focuses it), the last text selected.
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.is_empty() {
            return;
        }
        if let Some(f) = &self.find {
            let field = f.field.clone();
            field.update(cx, |s, cx| s.focus(window, cx));
            return;
        }
        let last = self.last_find.clone();
        let field = cx.new(|cx| {
            // WS Editor.SearchField.borderInsets.compact 3,10,3,8; Cc before .*
            let mut s = SearchField::new("", cx)
                .frameless()
                .case_first()
                .padding(FIELD_PAD_LEFT, FIELD_PAD_RIGHT);
            s.set_match_case(last.match_case, cx);
            s.set_regex(last.regex, cx);
            s
        });
        let mut subs = vec![cx.subscribe_in(
            &field,
            window,
            |v, _, ev: &SearchFieldEvent, window, cx| match ev {
                SearchFieldEvent::Changed | SearchFieldEvent::OptionsChanged => {
                    v.find_update(true, window, cx)
                }
                _ => {}
            },
        )];
        // leaving the field (a click elsewhere, Esc in a tool window ...) closes it, like WS's search popup
        let handle = field.read(cx).focus_handle(cx);
        subs.push(cx.on_blur(&handle, window, |v, window, cx| {
            if !v.find_focused(window, cx) {
                v.close_find(false, window, cx);
            }
        }));
        let tab = self.pty().map_or(0, |p| p.id);
        self.find = Some(Find {
            field: field.clone(),
            matches: Rc::default(),
            cur: 0,
            query: String::new(),
            tab,
            bounds: Rc::default(),
            buttons: Rc::default(),
            pending: None,
            _subs: subs,
        });
        field.update(cx, |s, cx| {
            s.set_text(last.query.clone(), cx);
            s.field().update(cx, |f, cx| f.select_all(cx));
            s.focus(window, cx);
        });
        if !last.query.is_empty() {
            self.find_update(true, window, cx);
        }
        cx.notify();
    }

    /// Types `text` over the field's selection (scripts, screenshots).
    pub(super) fn find_type(&mut self, text: &str, cx: &mut Context<Self>) {
        if let Some(f) = &self.find {
            let field = f.field.clone();
            field.update(cx, |s, cx| s.field().update(cx, |f, cx| f.insert(text, cx)));
        }
    }

    /// Closes the bar; `back`: typing at the prompt again (scrolled to the bottom).
    pub(super) fn close_find(&mut self, back: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.find.take() else {
            return;
        };
        self.last_find = LastFind {
            query: f.query.clone(),
            match_case: f.field.read(cx).match_case(),
            regex: f.field.read(cx).regex(),
        };
        if back {
            if let Some(p) = self.pty() {
                p.term.lock().scroll_display(Scroll::Bottom);
            }
            self.scroll_view = false;
            self.scroll_px = 0.;
            self.take_keyboard(window, cx);
        }
        cx.notify();
    }

    /// Searches again: the current match stays where it was when it's still there, else the
    /// newest one at or above it, else the newest. `reveal`: scroll to it.
    fn find_update(&mut self, reveal: bool, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_mut() else {
            return;
        };
        let Some(pty) = self
            .tabs
            .iter()
            .find(|t| t.pty_id() == f.tab)
            .map(|t| t.pty.clone())
        else {
            return;
        };
        let field = f.field.read(cx);
        let (query, case, regex) = (field.text(cx).to_owned(), field.match_case(), field.regex());
        let old = f.current().and_then(|i| f.matches.get(i).copied());
        let matches = {
            let term = pty.term.lock();
            if regex {
                text::find_regex(&*term, &query, case)
            } else {
                text::find(&*term, &query, case)
            }
        };
        let mut cur = matches.len();
        if let Some(old) = old
            && let Some(i) = matches
                .iter()
                .rposition(|m| (m.line, m.col) <= (old.line, old.col))
        {
            cur = i + 1;
        }
        f.query = query;
        f.matches = Rc::new(matches);
        f.cur = cur;
        if reveal {
            self.find_reveal(cx);
        }
        cx.notify();
    }

    /// Scrolls the current match into view (centered unless it's already below the bar's rows).
    fn find_reveal(&mut self, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_ref() else {
            return;
        };
        let Some(m) = f.current().and_then(|i| f.matches.get(i).copied()) else {
            return;
        };
        let Some(pty) = self
            .tabs
            .iter()
            .find(|t| t.pty_id() == f.tab)
            .map(|t| t.pty.clone())
        else {
            return;
        };
        let mut term = pty.term.lock();
        let rows = term.screen_lines() as i32;
        let offset = term.grid().display_offset() as i32;
        let row = m.line + offset;
        // the bar covers the top rows on the right: keep the match below it, else center it
        if row < 3 || row >= rows {
            let want = (rows / 2 - m.line).clamp(0, term.history_size() as i32);
            term.scroll_display(Scroll::Delta(want - offset));
        }
        let scrolled = term.grid().display_offset() > 0;
        drop(term);
        if scrolled {
            self.scroll_view = true;
        }
        self.scroll_px = 0.;
        cx.notify();
    }

    /// The next match: -1 older (up), 1 newer (down), wrapping.
    pub(super) fn find_next(&mut self, dir: i64, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_mut() else {
            return;
        };
        let n = f.matches.len() as i64;
        if n == 0 {
            return;
        }
        f.cur = ((f.cur as i64 - 1 + dir).rem_euclid(n) + 1) as usize;
        self.find_reveal(cx);
    }

    /// Keys while the field has the keyboard (those it didn't use); true: handled.
    pub(super) fn find_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let note = notation(ev).unwrap_or_default();
        match note.as_str() {
            "<Esc>" => self.close_find(true, window, cx),
            "<CR>" | "<Down>" | "<C-ö>" | "<D-g>" => self.find_next(1, cx),
            "<S-CR>" | "<Up>" | "<C-l>" | "<D-S-g>" => self.find_next(-1, cx),
            "<D-f>" => {}
            // the terminal's own Alt+Cmd keys work from its find bar too (the bar follows the tab)
            "<M-D-Left>" => self.cycle(-1, cx),
            "<M-D-Right>" => self.cycle(1, cx),
            _ => {
                let m = ev.keystroke.modifiers;
                // Ctrl keys would reach the editor behind; Cmd combos go on to the workspace,
                // which passes the global ones only (input::forward_from_surface)
                return m.control && !m.platform && !(ev.keystroke.key == "tab");
            }
        }
        true
    }

    /// The shown tab changed: the bar searches it.
    pub(super) fn find_tab_changed(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(self.cur).map(|t| t.pty_id()) else {
            return;
        };
        let Some(f) = self.find.as_mut() else {
            return;
        };
        if f.tab != tab {
            f.tab = tab;
            f.cur = 0;
            f.matches = Rc::default();
            self.find_research(cx);
        }
    }

    /// Re-search without a window (deferred callers).
    fn find_research(&mut self, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_mut() else {
            return;
        };
        let Some(pty) = self
            .tabs
            .iter()
            .find(|t| t.pty_id() == f.tab)
            .map(|t| t.pty.clone())
        else {
            return;
        };
        let field = f.field.read(cx);
        let (query, case, regex) = (field.text(cx).to_owned(), field.match_case(), field.regex());
        let matches = {
            let term = pty.term.lock();
            if regex {
                text::find_regex(&*term, &query, case)
            } else {
                text::find(&*term, &query, case)
            }
        };
        f.cur = matches.len();
        f.query = query;
        f.matches = Rc::new(matches);
        self.find_reveal(cx);
        cx.notify();
    }

    /// New output in the searched tab: search again soon (the view doesn't scroll).
    pub(super) fn find_output_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_mut() else {
            return;
        };
        if f.pending.is_some() {
            return;
        }
        let _ = window;
        f.pending = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RESEARCH_DELAY).await;
            let _ = this.update(cx, |v, cx| {
                if let Some(f) = v.find.as_mut() {
                    f.pending = None;
                }
                v.find_refresh(cx);
            });
        }));
    }

    /// Re-search keeping the current match (output came).
    fn find_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(f) = self.find.as_mut() else {
            return;
        };
        let Some(pty) = self
            .tabs
            .iter()
            .find(|t| t.pty_id() == f.tab)
            .map(|t| t.pty.clone())
        else {
            return;
        };
        let field = f.field.read(cx);
        let (case, regex) = (field.match_case(), field.regex());
        let query = f.query.clone();
        let old = f.current().and_then(|i| f.matches.get(i).copied());
        let matches = {
            let term = pty.term.lock();
            if regex {
                text::find_regex(&*term, &query, case)
            } else {
                text::find(&*term, &query, case)
            }
        };
        let mut cur = matches.len();
        if let Some(old) = old
            && let Some(i) = matches
                .iter()
                .rposition(|m| (m.line, m.col) <= (old.line, old.col))
        {
            cur = i + 1;
        }
        f.matches = Rc::new(matches);
        f.cur = cur;
        cx.notify();
    }

    /// The bar over the output's top-right corner.
    pub(super) fn render_find(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.find.as_ref()?;
        let label = self.find_label().unwrap_or_default();
        let record = f.bounds.clone();
        // the field keeps the keyboard when a button is pressed
        let keep_focus = |d: gpui_kit::Div| {
            d.on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
        };
        let view = cx.entity().downgrade();
        let painted = f.buttons.clone();
        painted.borrow_mut().clear();
        let button =
            |id: &'static str, icon: IconName, tip: &'static str, key: &'static str, dir: i64| {
                let view = view.clone();
                let record = painted.clone();
                keep_focus(div().relative().debug_selector(move || id.into()))
                    .child(
                        canvas(
                            move |b, _, _| record.borrow_mut().push((id, b)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(IconButton::new(id, icon).tooltip(tip, Some(key)).on_click(
                        move |_, window, cx| {
                            let _ = view.update(cx, |v, cx| {
                                if dir == 0 {
                                    v.close_find(true, window, cx);
                                } else {
                                    v.find_next(dir, cx);
                                }
                            });
                        },
                    ))
            };
        Some(
            div()
                .id("terminal-find")
                .debug_selector(|| "terminal-find".into())
                .absolute()
                .top_0()
                .right_0()
                .flex()
                .items_center()
                .gap(px(4.))
                .pr(px(4.))
                .py(px(3.))
                .bg(gpui_kit::rgb(BAR_BG))
                .border_l_1()
                .border_b_1()
                .border_color(gpui_kit::rgb(BAR_BORDER))
                .cursor(gpui_kit::CursorStyle::Arrow)
                .child(
                    canvas(move |b, _, _| record.set(b), |_, _, _, _| {})
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                )
                .on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, _, cx| {
                    cx.stop_propagation()
                })
                .child(div().flex_none().w(px(FIELD_WIDTH)).child(f.field.clone()))
                .child(
                    div()
                        .debug_selector(|| "terminal-find-count".into())
                        .flex_none()
                        .min_w(px(48.))
                        .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
                        .font_family(crate::render::UI_FONT)
                        .text_color(self.find_label_color().unwrap_or(look::TEXT_DIM.rgba()))
                        .child(label),
                )
                .child(button(
                    "terminal-find-up",
                    IconName::PreviousDifference,
                    "Previous Occurrence",
                    "⇧⏎",
                    -1,
                ))
                .child(button(
                    "terminal-find-down",
                    IconName::NextDifference,
                    "Next Occurrence",
                    "⏎",
                    1,
                ))
                .child(button(
                    "terminal-find-close",
                    IconName::CloseSmall,
                    "Close",
                    "⎋",
                    0,
                ))
                .into_any_element(),
        )
    }
}
