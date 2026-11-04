//! Replace in file (⌘R, design E-16): WebStorm's find / replace bar drawn natively over the top
//! right of the file's split, in the terminal Find bar's look (WS's floating search component).
//! Row 1: the search field with Match Case / Regex (`Cc` `.*`), the count (`3/12`, `0 results` /
//! `Bad pattern` in red), previous / next, ×; row 2: the replacement field, Replace, Replace All.
//!
//! Lua keeps the engine (`config/replace.lua`: the matches highlighted in the file, the current one
//! selected and scrolled into view, replacing as one undo step, `n` / `N` after closing);
//! `config/app/replace.lua` sends the bar's state (`show` with a new id opens it, `state`, `focus`
//! on ⌘R again, `hide`) and this side owns the fields and the keys: Tab / ⇧Tab switch fields; in
//! the search field ⏎ / ↓ / ⌘G the next match, ⇧⏎ / ↑ / ⌘⇧G the previous one; ⏎ in the
//! replacement field replaces the current match and goes on; ⌘⏎ Replace All; Esc closes, the caret
//! on the current match; ⌘F leaves it for Neovim's `/`. The keyboard leaving the bar (a click
//! elsewhere) closes it. Keys typed right after ⌘R, before the bar had the keyboard, come back from
//! `config/app/typeahead.lua` and are typed into it first. Right-click: the same actions.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, CursorStyle, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, Keystroke, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Point, Render, SharedString, Styled as _, Subscription, Task,
    Window, canvas, div, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::input::global_cmd;
use crate::kit;
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::{FieldEvent, TextField};
use crate::kit::{IconButton, TextButton};
use crate::kit::{SearchField, SearchFieldEvent};
use crate::look;
use crate::nvim::lua;
use crate::popups::{self, Menu, MenuEntry, MenuItem};
use crate::render::UI_FONT;
use crate::shell::{Surface, SurfaceCx};

const LUA: &str = "config.app.replace";

/// Longest wait for nvim's typeahead answer before keys typed into the bar go to it anyway.
const AWAIT_MAX: Duration = Duration::from_secs(1);

/// The bar's state as Lua sends it (`show` / `state`).
#[derive(Clone, Debug, Deserialize)]
struct StateIn {
    id: u64,
    /// The file's window.
    win: i64,
    #[serde(default)]
    find: String,
    #[serde(default)]
    replace: String,
    #[serde(default)]
    case: bool,
    #[serde(default)]
    regex: bool,
    /// `3/12`, `0 results`, `Bad pattern`, empty.
    #[serde(default)]
    count: String,
    /// Nothing found / a bad pattern: the count in red.
    #[serde(default)]
    none: bool,
    /// There is a current match (Replace has something to replace).
    #[serde(default)]
    current: bool,
    /// How many matches (Replace All has something to replace).
    #[serde(default)]
    total: u64,
}

/// `vimstorm.replace` (config/app/replace.lua, config/app/typeahead.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ReplaceEvent {
    /// `require("config.app").focus("replace")`.
    Focus {
        #[serde(default)]
        id: Option<u64>,
    },
    /// A new id opens the bar (its fields set from it), else like `state`.
    Show(StateIn),
    State(StateIn),
    Hide {
        id: u64,
    },
    /// Keys typed right after ⌘R, before the bar had the keyboard.
    Typeahead {
        #[serde(default)]
        keys: Vec<String>,
        #[serde(default)]
        token: Option<u64>,
    },
}

struct Bar {
    id: u64,
    win: i64,
    case: bool,
    regex: bool,
    count: SharedString,
    none: bool,
    current: bool,
    total: u64,
}

/// A bar action (keys, buttons, the right-click menu).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Act {
    Next,
    Previous,
    Replace,
    ReplaceAll,
    Case,
    Regex,
    Close,
}

/// What the bar shows (tests).
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub id: u64,
    pub find: String,
    pub replace: String,
    /// The search field's selection (bytes): the opening text comes selected.
    pub selection: std::ops::Range<usize>,
    pub count: String,
    /// The count in red.
    pub none: bool,
    pub case: bool,
    pub regex: bool,
    /// The bar has the keyboard; `in_replace`: the replacement field has it.
    pub focused: bool,
    pub in_replace: bool,
}

pub struct ReplaceView {
    scx: SurfaceCx,
    focus: FocusHandle,
    search: Entity<SearchField>,
    field: Entity<TextField>,
    bar: Option<Bar>,
    /// The replacement field has (or last had) the keyboard.
    in_replace: bool,
    /// The popups' focus (a menu opened from the bar doesn't close it).
    popups_focus: Option<FocusHandle>,
    /// The bar whose typeahead answer hasn't come yet: keys typed into it meanwhile wait in
    /// `queued`, so they come after the keys nvim still holds.
    awaiting: Option<u64>,
    queued: Vec<Keystroke>,
    await_task: Option<Task<()>>,
    /// The bar as last placed (window coordinates).
    placed: Rc<Cell<Option<Bounds<Pixels>>>>,
    _subs: Vec<Subscription>,
}

impl Surface for ReplaceView {
    const NAME: &'static str = "replace";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let search = cx.new(|cx| {
            // WS Editor.SearchField.borderInsets.compact 3,10,3,8; Cc before .*
            SearchField::new("", cx).frameless().case_first().padding(
                look::REPLACE_BAR_FIELD_PAD_LEFT,
                look::REPLACE_BAR_FIELD_PAD_RIGHT,
            )
        });
        let field = cx.new(|cx| TextField::new(cx).borderless().placeholder("Replace"));
        let search_focus = search.read(cx).focus_handle(cx);
        let field_focus = field.read(cx).focus_handle(cx);
        let subs = vec![
            cx.subscribe(&search, |this, _, ev: &SearchFieldEvent, cx| match ev {
                SearchFieldEvent::Changed => this.send_fields(cx),
                SearchFieldEvent::OptionsChanged => this.options_changed(cx),
                _ => {}
            }),
            cx.subscribe(&field, |this, _, ev: &FieldEvent, cx| {
                if *ev == FieldEvent::Changed {
                    this.send_fields(cx);
                }
            }),
            cx.on_focus(&search_focus, window, |this, _, _| this.in_replace = false),
            cx.on_focus(&field_focus, window, |this, _, _| this.in_replace = true),
            // the keyboard left the bar (a click elsewhere): it closes, focus stays there
            cx.on_focus_out(&focus, window, |this, _, window, cx| {
                this.focus_moved(window, cx)
            }),
            // the bar itself got the keyboard (a click on it, a menu closed): into its field
            cx.on_focus(&focus, window, |this, window, cx| {
                if this.bar.is_some() {
                    this.focus_field(window, cx);
                }
            }),
        ];
        ReplaceView {
            scx,
            focus,
            search,
            field,
            bar: None,
            in_replace: false,
            popups_focus: None,
            awaiting: None,
            queued: Vec::new(),
            await_task: None,
            placed: Rc::default(),
            _subs: subs,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        self.observe(window, cx);
        let Some(ev) = lua::decode::<ReplaceEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            ReplaceEvent::Focus { id } => {
                if self
                    .bar
                    .as_ref()
                    .is_some_and(|b| id.is_none_or(|id| id == b.id))
                {
                    self.in_replace = false;
                    self.focus_field(window, cx);
                } else if id.is_none() {
                    self.scx.focus_editor(window, cx);
                }
            }
            ReplaceEvent::Show(s) => self.show(s, window, cx),
            ReplaceEvent::State(s) => self.set_state(s, cx),
            ReplaceEvent::Hide { id } => {
                if self.bar.as_ref().is_some_and(|b| b.id == id) {
                    let had = self.focus.contains_focused(window, cx);
                    self.drop_bar(cx);
                    if had {
                        self.scx.focus_editor(window, cx);
                    }
                }
            }
            ReplaceEvent::Typeahead { keys, token } => self.typeahead(keys, token, window, cx),
        }
        cx.notify();
    }
}

impl Focusable for ReplaceView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ReplaceView {
    /// Follows the popups' focus (a menu from the bar keeps it open), once the workspace is up.
    fn observe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.popups_focus.is_some() {
            return;
        }
        let Some(ws) = self.scx.workspace.upgrade() else {
            return;
        };
        let popups = ws.read(cx).popups().focus_handle(cx);
        self._subs
            .push(cx.on_focus_out(&popups, window, |this, _, window, cx| {
                this.focus_moved(window, cx)
            }));
        self.popups_focus = Some(popups);
    }

    fn show(&mut self, s: StateIn, window: &mut Window, cx: &mut Context<Self>) {
        if self.bar.as_ref().is_some_and(|b| b.id == s.id) {
            return self.set_state(s, cx);
        }
        let id = s.id;
        self.search.update(cx, |f, cx| {
            f.set_text(s.find.clone(), cx);
            f.set_match_case(s.case, cx);
            f.set_regex(s.regex, cx);
            // the opening text selected: typing replaces it
            f.field().update(cx, |f, cx| f.select_all(cx));
        });
        self.field
            .update(cx, |f, cx| f.set_text(s.replace.clone(), cx));
        self.bar = Some(Bar {
            id,
            win: s.win,
            case: s.case,
            regex: s.regex,
            count: s.count.into(),
            none: s.none,
            current: s.current,
            total: s.total,
        });
        self.in_replace = false;
        self.focus_field(window, cx);
        // the keys held since ⌘R come first: keys typed now wait for them
        self.awaiting = Some(id);
        self.queued.clear();
        self.scx.call(LUA, "focused", vec![Value::from(id)]);
        self.await_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(AWAIT_MAX).await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.awaiting == Some(id) {
                    this.release_keys(window, cx);
                }
            });
        }));
    }

    fn set_state(&mut self, s: StateIn, cx: &mut Context<Self>) {
        let Some(bar) = self.bar.as_mut().filter(|b| b.id == s.id) else {
            return;
        };
        bar.win = s.win;
        bar.case = s.case;
        bar.regex = s.regex;
        bar.count = s.count.into();
        bar.none = s.none;
        bar.current = s.current;
        bar.total = s.total;
        self.search.update(cx, |f, cx| {
            f.set_match_case(s.case, cx);
            f.set_regex(s.regex, cx);
        });
        cx.notify();
    }

    fn popups_focused(&self, window: &Window, cx: &App) -> bool {
        self.popups_focus
            .as_ref()
            .is_some_and(|h| h.contains_focused(window, cx))
    }

    /// The field last used takes the keyboard.
    fn focus_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.in_replace {
            let h = self.field.focus_handle(cx);
            window.focus(&h, cx);
        } else {
            let h = self.search.focus_handle(cx);
            window.focus(&h, cx);
        }
    }

    /// Tab / ⇧Tab: the other field.
    fn switch_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.in_replace = !self.in_replace;
        self.focus_field(window, cx);
        cx.notify();
    }

    /// Focus moved: if it left the bar (and its menu), the bar closes where the keyboard went.
    fn focus_moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.bar.as_ref().map(|b| b.id) else {
            return;
        };
        if self.focus.contains_focused(window, cx) || self.popups_focused(window, cx) {
            return;
        }
        self.drop_bar(cx);
        self.scx
            .call(LUA, "close", vec![Value::from(id), Value::from(false)]);
    }

    fn drop_bar(&mut self, cx: &mut Context<Self>) {
        self.bar = None;
        self.awaiting = None;
        self.await_task = None;
        self.queued.clear();
        cx.notify();
    }

    /// The fields' texts to Lua (it searches again when the search text changed).
    fn send_fields(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.bar.as_ref().map(|b| b.id) else {
            return;
        };
        let find = self.search.read(cx).text(cx).to_owned();
        let rep = self.field.read(cx).text().to_owned();
        self.scx.call(
            LUA,
            "fields",
            vec![Value::from(id), Value::from(find), Value::from(rep)],
        );
    }

    /// A toggle in the search field flipped (a click, ⌥C / ⌥X): Lua's state is the truth.
    fn options_changed(&mut self, cx: &mut Context<Self>) {
        let Some(bar) = &self.bar else { return };
        let (case, regex) = {
            let s = self.search.read(cx);
            (s.match_case(), s.regex())
        };
        let (case_flipped, regex_flipped) = (case != bar.case, regex != bar.regex);
        if case_flipped {
            self.act(Act::Case, None, cx);
        }
        if regex_flipped {
            self.act(Act::Regex, None, cx);
        }
    }

    /// Runs `act`; Close also gives the keyboard back to the file (`window`).
    fn act(&mut self, act: Act, window: Option<&mut Window>, cx: &mut Context<Self>) {
        let Some(bar) = self.bar.as_mut() else { return };
        let id = Value::from(bar.id);
        match act {
            Act::Next => self.scx.call(LUA, "step", vec![id, Value::from(1)]),
            Act::Previous => self.scx.call(LUA, "step", vec![id, Value::from(-1)]),
            Act::Replace => self.scx.call(LUA, "replace", vec![id]),
            Act::ReplaceAll => self.scx.call(LUA, "replace_all", vec![id]),
            Act::Case | Act::Regex => {
                // shown at once; Lua answers with the state it searched with
                let name = if act == Act::Case { "case" } else { "regex" };
                if act == Act::Case {
                    bar.case = !bar.case;
                } else {
                    bar.regex = !bar.regex;
                }
                let (case, regex) = (bar.case, bar.regex);
                self.search.update(cx, |f, cx| {
                    f.set_match_case(case, cx);
                    f.set_regex(regex, cx);
                });
                self.scx.call(LUA, "toggle", vec![id, Value::from(name)]);
            }
            Act::Close => {
                self.drop_bar(cx);
                if let Some(window) = window {
                    self.scx.focus_editor(window, cx);
                }
                self.scx.call(LUA, "close", vec![id, Value::from(true)]);
            }
        }
        cx.notify();
    }

    /// ⏎: the next match in the search field, Replace in the replacement field.
    fn enter(&mut self, cx: &mut Context<Self>) {
        let act = if self.in_replace {
            Act::Replace
        } else {
            Act::Next
        };
        self.act(act, None, cx);
    }

    // Typeahead ---------------------------------------------------------------------------------

    /// Before a field sees a key: nvim may still hold keys typed before it, so it waits for them.
    fn on_capture_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.awaiting.is_some() && self.bar.is_some() {
            self.queued.push(ev.keystroke.clone());
            cx.stop_propagation();
        }
    }

    /// nvim answered (or took too long): the keys typed into the bar meanwhile go to it now.
    fn release_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.awaiting = None;
        self.await_task = None;
        let keys = std::mem::take(&mut self.queued);
        if !keys.is_empty() {
            window.defer(cx, move |window, cx| {
                for k in keys {
                    window.dispatch_keystroke(k, cx);
                }
            });
        }
    }

    /// Keys typed right after ⌘R: typed into the bar before anything typed there since (over the
    /// selected search text, as typing would); Tab, ⏎ and Esc among them act.
    fn typeahead(
        &mut self,
        keys: Vec<String>,
        token: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.bar.is_some() {
            for k in keys.iter().flat_map(|k| crate::search::split_keys(k)) {
                if self.bar.is_none() {
                    break;
                }
                let field = if self.in_replace {
                    self.field.clone()
                } else {
                    self.search.read(cx).field().clone()
                };
                match k.as_str() {
                    "<Tab>" | "<S-Tab>" => self.switch_field(window, cx),
                    "<CR>" => self.enter(cx),
                    "<S-CR>" => self.act(Act::Previous, None, cx),
                    "<Esc>" => self.act(Act::Close, Some(window), cx),
                    "<Space>" => field.update(cx, |f, cx| f.insert(" ", cx)),
                    "<lt>" => field.update(cx, |f, cx| f.insert("<", cx)),
                    "<BS>" => {
                        field.update(cx, |f, cx| f.key("<BS>", window, cx));
                    }
                    _ if k.chars().count() == 1 => field.update(cx, |f, cx| f.insert(&k, cx)),
                    _ => {}
                }
            }
        }
        if token.is_some() && token == self.awaiting {
            self.release_keys(window, cx);
        }
        cx.notify();
    }

    // Keys --------------------------------------------------------------------------------------

    /// Keys in the bar (the fields' keys bubble here: they let ⏎ / Esc / Tab / ↑ / ↓ through and
    /// handle their own ⌘A / C / V / X / Z). nvim's current window is still the file: the other
    /// Cmd keys would edit it behind the bar, so only the global ones get through.
    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        match key.as_str() {
            "<Esc>" => self.act(Act::Close, Some(window), cx),
            "<CR>" => self.enter(cx),
            "<Down>" | "<D-g>" => self.act(Act::Next, None, cx),
            "<S-CR>" | "<Up>" | "<D-S-g>" | "<D-G>" | "<S-D-g>" | "<S-D-G>" => {
                self.act(Act::Previous, None, cx)
            }
            "<D-CR>" => self.act(Act::ReplaceAll, None, cx),
            "<Tab>" | "<S-Tab>" => self.switch_field(window, cx),
            // ⌘R again: the search field
            "<D-r>" => {
                self.in_replace = false;
                self.focus_field(window, cx);
            }
            // ⌘F: Neovim's own search instead
            "<D-f>" => {
                if let Some(id) = self.bar.as_ref().map(|b| b.id) {
                    self.drop_bar(cx);
                    self.scx.focus_editor(window, cx);
                    self.scx.call(LUA, "find", vec![Value::from(id)]);
                }
            }
            _ if ev.keystroke.modifiers.platform && !global_cmd(&ev.keystroke, cx) => {}
            // Ctrl keys would reach the file behind
            _ if ev.keystroke.modifiers.control && !ev.keystroke.modifiers.platform => {}
            _ => return,
        }
        cx.stop_propagation();
    }

    fn open_menu(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bar) = &self.bar else { return };
        let mut acts: Vec<Option<Act>> = Vec::new();
        let mut entries: Vec<MenuEntry> = Vec::new();
        let mut item = |label: &str, key: &str, act: Option<Act>, enabled: bool| {
            match act {
                None => entries.push(MenuEntry::Separator),
                Some(_) => {
                    let mut it = MenuItem::new(label.to_owned()).enabled(enabled);
                    if !key.is_empty() {
                        it = it.shortcut(key.to_owned());
                    }
                    entries.push(it.into());
                }
            }
            acts.push(act);
        };
        item("Replace", "⏎", Some(Act::Replace), bar.current);
        item("Replace All", "⌘⏎", Some(Act::ReplaceAll), bar.total > 0);
        item("", "", None, true);
        item("Next Occurrence", "⌘G", Some(Act::Next), true);
        item("Previous Occurrence", "⌘⇧G", Some(Act::Previous), true);
        item("", "", None, true);
        let check = |on: bool, label: &str| format!("{}{label}", if on { "✓ " } else { "" });
        item(&check(bar.case, "Match Case"), "⌥C", Some(Act::Case), true);
        item(&check(bar.regex, "Regex"), "⌥X", Some(Act::Regex), true);
        item("", "", None, true);
        item("Close", "⎋", Some(Act::Close), true);
        let weak = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, Anchor::Point(at)),
            window,
            cx,
            move |choice, window, cx| {
                let Some(act) = choice.and_then(|ix| acts.get(ix).copied().flatten()) else {
                    return;
                };
                let _ = weak.update(cx, |this, cx| {
                    if act == Act::Close {
                        this.act(act, Some(window), cx);
                    } else {
                        this.act(act, None, cx);
                        this.focus_field(window, cx);
                    }
                });
            },
        );
    }

    // Introspection (tests) ---------------------------------------------------------------------

    /// What the bar shows, if it's open.
    pub fn shown(&self, window: &Window, cx: &App) -> Option<Shown> {
        let b = self.bar.as_ref()?;
        let search = self.search.read(cx).field().read(cx);
        Some(Shown {
            id: b.id,
            find: search.text().to_owned(),
            replace: self.field.read(cx).text().to_owned(),
            selection: search.selection(),
            count: b.count.to_string(),
            none: b.none,
            case: b.case,
            regex: b.regex,
            focused: self.focus.contains_focused(window, cx),
            in_replace: self.in_replace,
        })
    }

    // Rendering ---------------------------------------------------------------------------------

    fn render_bar(&self, bar: &Bar, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.entity().downgrade();
        // the field keeps the keyboard when a button is pressed
        let keep_focus = |d: gpui_kit::Div| {
            d.on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
        };
        let icon_button = |id: &'static str, icon: IconName, tip: &'static str, key, act: Act| {
            let view = view.clone();
            keep_focus(div().debug_selector(move || id.into())).child(
                IconButton::new(id, icon)
                    .tooltip(tip, Some(key))
                    .on_click(move |_, window, cx| {
                        let _ = view.update(cx, |v, cx| {
                            if act == Act::Close {
                                v.act(act, Some(window), cx);
                            } else {
                                v.act(act, None, cx);
                            }
                        });
                    }),
            )
        };
        let text_button = |id: &'static str, label: &'static str, enabled: bool, act: Act| {
            let view = view.clone();
            keep_focus(div()).child(
                TextButton::new(id, label)
                    .small(look::REPLACE_BAR_BUTTON_HEIGHT)
                    .disabled(!enabled)
                    .on_click(move |_, _, cx| {
                        let _ = view.update(cx, |v, cx| v.act(act, None, cx));
                    }),
            )
        };
        let row = || {
            div()
                .flex_none()
                .h(px(look::SEARCH_FIELD_HEIGHT))
                .flex()
                .items_center()
                .gap(px(look::REPLACE_BAR_GAP))
        };
        let count = div()
            .debug_selector(|| "replace-count".into())
            .flex_none()
            .min_w(px(look::REPLACE_BAR_COUNT_MIN_WIDTH))
            .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
            .text_color(if bar.none {
                look::TEXT_ERROR
            } else {
                look::TEXT_DIM
            })
            .child(bar.count.clone());
        let find_row = row()
            .child(
                div()
                    .flex_none()
                    .w(px(look::REPLACE_BAR_FIELD_WIDTH))
                    .child(self.search.clone()),
            )
            .child(count)
            .child(icon_button(
                "replace-previous",
                IconName::PreviousDifference,
                "Previous Occurrence",
                "⇧⏎",
                Act::Previous,
            ))
            .child(icon_button(
                "replace-next",
                IconName::NextDifference,
                "Next Occurrence",
                "⏎",
                Act::Next,
            ))
            .child(icon_button(
                "replace-close",
                IconName::CloseSmall,
                "Close",
                "⎋",
                Act::Close,
            ));
        // the replacement's text starts where the search text does (after the magnifier)
        let replace_row = row()
            .child(
                div()
                    .debug_selector(|| "replace-field".into())
                    .flex_none()
                    .w(px(look::REPLACE_BAR_FIELD_WIDTH))
                    .pl(px(look::REPLACE_BAR_FIELD_PAD_LEFT
                        + look::ICON_SIZE
                        + look::SEARCH_FIELD_ICON_GAP
                        - look::FIELD_PADDING_X))
                    .child(self.field.clone()),
            )
            .child(text_button(
                "replace-one",
                "Replace",
                bar.current,
                Act::Replace,
            ))
            .child(text_button(
                "replace-all",
                "Replace All",
                bar.total > 0,
                Act::ReplaceAll,
            ));
        let record = self.placed.clone();
        div()
            .id("replace-bar")
            .debug_selector(|| "replace-bar".into())
            .track_focus(&self.focus)
            .key_context("ReplaceBar")
            .capture_key_down(cx.listener(Self::on_capture_key))
            .on_key_down(cx.listener(Self::on_key_down))
            .relative()
            .flex()
            .flex_col()
            .pl(px(0.))
            .pr(px(look::REPLACE_BAR_PAD_RIGHT))
            .py(px(look::REPLACE_BAR_PAD_Y))
            .bg(look::REPLACE_BAR_BG)
            .border_l_1()
            .border_b_1()
            .border_color(look::REPLACE_BAR_BORDER)
            .font_family(UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .cursor(CursorStyle::Arrow)
            .occlude()
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    this.focus_field(window, cx);
                    cx.stop_propagation();
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                    this.open_menu(ev.position, window, cx);
                    cx.stop_propagation();
                }),
            )
            .child(
                canvas(move |b, _, _| record.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .child(find_row)
            .child(replace_row)
            .into_any_element()
    }
}

impl Render for ReplaceView {
    /// Full-window layer: the bar at the top right of the file's split.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(bar) = self.bar.as_ref() else {
            self.placed.set(None);
            return div().into_any_element();
        };
        let geo = self.scx.geometry();
        // not laid out (yet): mounted unseen, so the field has the keyboard and keys typed
        // meanwhile aren't lost
        let (right, top) = geo
            .win_rect(bar.win)
            .map(|w| (w.grid_area.right(), w.grid_area.top()))
            .unwrap_or((px(-10_000.), px(-10_000.)));
        let inset = window.viewport_size().width - right;
        let el = self.render_bar(bar, cx);
        div()
            .absolute()
            .top(top)
            .right(inset)
            .child(el)
            .into_any_element()
    }
}
