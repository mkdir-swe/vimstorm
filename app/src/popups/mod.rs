//! Popups: context menu / `vim.ui.select`, the `vim.ui.input` field, notification balloons, the
//! `,?` key help. WebStorm New UI look (`crate::kit` frame, `crate::look` metrics), the
//! Lua UI's behaviour (`config/menu.lua`, `config/popup.lua`, `config/app/balloon.lua`, which-key).
//!
//! # API for other surfaces (TREE, TABS, PICKERS, TOOLBAR, ...)
//!
//! Every call is safe from inside another entity's update (the popup opens on the next effect
//! cycle, `window.defer`), and every callback runs outside the popups' own update, so it may open
//! the next popup.
//!
//! ```ignore
//! use crate::popups::{self, Menu, MenuEntry, MenuItem};
//! use crate::kit::{kit::IconName, popup::Anchor};
//!
//! let menu = Menu::new(
//!     vec![
//!         MenuItem::new("Copy Path").shortcut("⇧⌘C").into(),
//!         MenuEntry::Separator,
//!         MenuItem::new("Delete…").shortcut("⌫").icon(IconName::Delete).enabled(ok).into(),
//!     ],
//!     Anchor::Point(event.position), // right-click: top-left at the mouse
//! );                                  // keyboard (Cmd+Enter): Anchor::Below(selected_row_bounds)
//! popups::open_menu(menu, window, cx, move |choice, window, cx| {
//!     // choice: Some(index into `entries`) or None (Esc / click outside / replaced)
//! });
//! popups::open_input(popups::Input::new("Rename", "old.ts", Anchor::Below(row)), window, cx,
//!     move |text: Option<String>, window, cx| { /* None = cancelled */ });
//! popups::notify(popups::Balloon::info("Copied", "/path/to/file"), window, cx);
//! ```
//!
//! - The menu takes the keyboard (arrows / Ctrl-n / Ctrl-p / Tab move, Enter, Esc; typing filters
//!   at once, every letter (speed search; `/` too)) and gives it back on close to
//!   whatever had it before (your surface). Mouse: hover selects, release on a row runs it, a click outside closes it and lands
//!   where it was made. `Menu::title` adds a header row (`vim.ui.select` prompts),
//!   `header_right` its right part, `max_rows` caps the height (scrolls), `search_shortcuts`
//!   lets the search match the right column too. A shortcut "›" draws a submenu chevron.
//! - Lua menus (`config/menu.lua` providers, `vim.ui.select`) arrive through the bridge
//!   (`config/app/menu.lua`). Lua callers can pass `opts.pos = { x =, y = }` (window px, the
//!   popup's top-left) to `menu.open` / `vim.ui.select` / `vim.ui.input` to anchor it to a native
//!   surface instead of the mouse / nvim's caret. Items may carry `file = path` (a file icon).

mod balloon;
mod dialog;
mod errors;
mod flow;
mod input;
mod keyhelp;
mod menu;

use std::time::{Duration, Instant};

use gpui_kit::{
    App, Bounds, Context, FocusHandle, Focusable, Global, InteractiveElement as _, IntoElement,
    KeyDownEvent, Keystroke, MouseDownEvent, ParentElement as _, Pixels, Point, Render,
    Styled as _, Task, WeakEntity, Window, div, point, px, size,
};
use rmpv::Value;
use serde::Deserialize;

pub use balloon::{
    Balloon, BalloonAction, BalloonHost, Balloons, Level, reading_time,
    start_timers as start_balloon_timers,
};
pub(crate) use dialog::Check;
pub use dialog::{Button, Dialog, Field, Look, Row, Section};
pub(crate) use errors::record_error;
pub use errors::widget;
pub use flow::{Flow, FlowAnswer};
pub use input::Input;
pub use menu::{Highlight, Menu, MenuEntry, MenuItem, MenuStyle};

use crate::kit::Anchor;
use crate::kit::ListOutcome;
use crate::kit::{self, IconName};
use crate::nvim::lua;
use crate::shell::{Surface, SurfaceCx};

/// A popup's answer, run once (outside the popups' update).
type Done<T> = Box<dyn FnOnce(T, &mut Window, &mut App)>;

/// The popups' deferred priority: over everything else drawn deferred (the card dialog 1, Abe's
/// layers 2, the flow dialogs 3, the Settings dialog 10), so a menu, a field or a dialog opened
/// last is always on top and Esc closes what is seen.
pub const PRIORITY: usize = 20;

/// How a menu ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuOutcome {
    /// An item (index into the entries) ran; true: picked with the mouse.
    Chosen(usize, bool),
    /// Esc / Cmd+Enter / replaced: back where it was opened (Lua restores mode / selection).
    Cancelled,
    /// A click outside: focus goes where the click lands.
    Dismissed,
}

/// The popups entity, reachable from anywhere in the app.
struct PopupsHandle(WeakEntity<PopupsView>);

impl Global for PopupsHandle {}

/// Makes `popups` the one [`open_menu`] / [`notify`] ... reach: the shown project's (several open
/// projects share the window, [`crate::shell::projects`]).
pub fn make_current(popups: &gpui_kit::Entity<PopupsView>, cx: &mut App) {
    cx.set_global(PopupsHandle(popups.downgrade()));
}

/// The balloons up in the shown project, `(title, body)` each (the drive socket's `see`).
pub fn shown_balloons(cx: &App) -> Vec<(String, String)> {
    cx.try_global::<PopupsHandle>()
        .and_then(|h| h.0.upgrade())
        .map(|p| p.read(cx).balloons())
        .unwrap_or_default()
}

/// Runs `f` on the popups view on the next effect cycle (callers may be inside an update).
fn with_popups(
    window: &mut Window,
    cx: &mut App,
    f: impl FnOnce(&mut PopupsView, &mut Window, &mut Context<PopupsView>) + 'static,
) {
    let Some(handle) = cx.try_global::<PopupsHandle>().map(|h| h.0.clone()) else {
        return;
    };
    window.defer(cx, move |window, cx| {
        let _ = handle.update(cx, |p, cx| f(p, window, cx));
    });
}

/// Opens a context menu (replacing any open popup); `on_choose` gets the chosen entry's index or
/// None.
pub fn open_menu(
    menu: Menu,
    window: &mut Window,
    cx: &mut App,
    on_choose: impl FnOnce(Option<usize>, &mut Window, &mut App) + 'static,
) {
    let done: Done<MenuOutcome> = Box::new(move |out, window, cx| {
        let choice = match out {
            MenuOutcome::Chosen(ix, _) => Some(ix),
            _ => None,
        };
        on_choose(choice, window, cx)
    });
    with_popups(window, cx, move |p, window, cx| {
        let popup = menu::MenuPopup::new(menu, done, None, window);
        p.open_modal(Modal::Menu(Box::new(popup)), window, cx);
    });
}

/// Opens a flow dialog (replacing any open popup); `on_done` gets the answer, None on Esc, ×, or a
/// click outside while its text area is empty.
pub fn open_dialog(
    dialog: dialog::Dialog,
    window: &mut Window,
    cx: &mut App,
    on_done: impl FnOnce(Option<dialog::Answer>, &mut Window, &mut App) + 'static,
) {
    with_popups(window, cx, move |p, window, cx| {
        let popup = dialog::DialogPopup::new(dialog, Box::new(on_done), window, cx);
        p.open_modal(Modal::Dialog(Box::new(popup)), window, cx);
    });
}

/// Opens the text field popup (its text starts selected); `on_done` gets the text, None on Esc /
/// a click outside.
pub fn open_input(
    input: Input,
    window: &mut Window,
    cx: &mut App,
    on_done: impl FnOnce(Option<String>, &mut Window, &mut App) + 'static,
) {
    with_popups(window, cx, move |p, window, cx| {
        let popup = input::InputPopup::new(input, Box::new(on_done), None, window, cx);
        p.open_modal(Modal::Input(popup), window, cx);
    });
}

/// Opens a flow dialog (LocalCloudPopups: Hand back to cloud, Start from this workspace);
/// `on_done` gets the button, a link or Cancel.
pub fn open_flow(
    flow: Flow,
    window: &mut Window,
    cx: &mut App,
    on_done: impl FnOnce(FlowAnswer, &mut Window, &mut App) + 'static,
) {
    // one flow dialog primitive: the flow is built as a dialog
    let field = flow.field.is_some();
    open_dialog(flow.into_dialog(), window, cx, move |a, window, cx| {
        on_done(flow::answer_of(a, field), window, cx)
    });
}

/// A popup opened while `owner` (or something inside it) had the keyboard is open: the owner
/// still draws as active (WebStorm keeps a list's selection blue under its context menu).
pub fn opened_from(owner: &FocusHandle, window: &Window, cx: &App) -> bool {
    let Some(p) = cx.try_global::<PopupsHandle>().and_then(|h| h.0.upgrade()) else {
        return false;
    };
    let p = p.read(cx);
    p.modal.is_some()
        && p.prev_focus
            .as_ref()
            .is_some_and(|f| f == owner || owner.contains(f, window))
}

/// Shows a balloon in `popups`' project (a surface's own: [`crate::shell::SurfaceCx::notify`]).
/// A hidden project's balloons wait unseen (their timeouts start when they're drawn) and show
/// when it's shown, like WebStorm shows a project's notifications in its own frame.
pub fn notify_in(
    popups: WeakEntity<PopupsView>,
    balloon: Balloon,
    window: &mut Window,
    cx: &mut App,
) {
    window.defer(cx, move |_, cx| {
        let _ = popups.update(cx, |p, cx| p.show_balloon(balloon, cx));
    });
}

/// Shows a notification balloon (bottom right) in the shown project.
pub fn notify(balloon: Balloon, window: &mut Window, cx: &mut App) {
    with_popups(window, cx, move |p, _, cx| p.show_balloon(balloon, cx));
}

/// The popup with the keyboard (one at a time).
enum Modal {
    Menu(Box<menu::MenuPopup>),
    Input(input::InputPopup),
    KeyHelp(keyhelp::KeyHelp),
    Dialog(Box<dialog::DialogPopup>),
}

/// A double-click's second press after a menu row ran on the first: swallowed (it would select a
/// word under the closed menu; menu.lua's `last_run`).
const DOUBLE_CLICK_GUARD: Duration = Duration::from_millis(600);

/// Longest wait for nvim's typeahead answer before keys typed into a field go to it anyway.
const AWAIT_MAX: Duration = Duration::from_secs(1);

pub struct PopupsView {
    /// The keystroke observer that takes the errors that fade.
    _keys: gpui_kit::Subscription,
    scx: SurfaceCx,
    focus: FocusHandle,
    modal: Option<Modal>,
    /// Who had the keyboard before the modal took it (it goes back there).
    prev_focus: Option<FocusHandle>,
    balloons: Balloons,
    guard: Option<(Point<Pixels>, Instant)>,
    /// The Lua field whose typeahead answer hasn't come yet (config/app/typeahead.lua): keys typed
    /// into it meanwhile wait in `queued`, so they come after the keys nvim still holds.
    awaiting: Option<u64>,
    queued: Vec<Keystroke>,
    /// Releases `queued` if nvim never answers.
    await_task: Option<Task<()>>,
}

/// `vimstorm.popups` (config/app/{menu,input,balloon,keyhelp}.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum PopupsEvent {
    /// `require("config.app").focus("popups")`
    Focus,
    Menu(LuaMenu),
    /// Lua let its menu go (closed from code): no answer back.
    MenuClose {
        id: u64,
    },
    Input(LuaInput),
    /// Completions for the field's text (`opts.completion`), answering `complete(id, text)`.
    InputComplete {
        id: u64,
        text: String,
        #[serde(default)]
        items: Vec<String>,
    },
    Balloon(balloon::LuaBalloon),
    /// `Snacks.notifier.hide(id)`; no id: all.
    BalloonHide {
        #[serde(default)]
        id: Option<String>,
    },
    KeyHelp(keyhelp::LuaKeyHelp),
    /// Keys typed before field `token` had the keyboard, held by nvim (answering `focused`).
    Typeahead {
        keys: Vec<String>,
        #[serde(default)]
        token: Option<u64>,
    },
}

/// Where a Lua popup goes: `pos` (window px, from a native surface), the mouse, else below cell
/// (row, col) of window `win` (nvim's caret), else below the caret.
#[derive(Debug, Default, Deserialize)]
struct LuaAnchor {
    #[serde(default)]
    at: Option<String>,
    #[serde(default)]
    pos: Option<LuaPos>,
    #[serde(default)]
    win: Option<i64>,
    #[serde(default)]
    row: Option<i64>,
    #[serde(default)]
    col: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct LuaPos {
    x: f32,
    y: f32,
}

#[derive(Debug, Deserialize)]
struct LuaMenu {
    id: u64,
    items: Vec<menu::LuaItem>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    title_hl: Vec<menu::LuaHl>,
    #[serde(default)]
    header_right: Option<String>,
    #[serde(default)]
    header_right_hl: Vec<menu::LuaHl>,
    /// false: no icons from labels (vim.ui.select: code actions...)
    #[serde(default)]
    icons: Option<bool>,
    #[serde(default)]
    match_key: bool,
    /// nvim cells, like menu.lua's.
    #[serde(default)]
    max_width: Option<usize>,
    #[serde(default)]
    max_height: Option<usize>,
    #[serde(default)]
    anchor: LuaAnchor,
}

#[derive(Debug, Deserialize)]
struct LuaInput {
    id: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    text: Option<String>,
    /// `vim.ui.input`'s `completion` ("file", "dir"...): Tab completes like `input()`.
    #[serde(default)]
    completion: Option<String>,
    #[serde(default)]
    anchor: LuaAnchor,
    /// Drawn as Abe's prompt.
    #[serde(default)]
    dialog: Option<input::Dialog>,
    /// The empty field's hint (none: the default, "Name").
    #[serde(default)]
    placeholder: Option<String>,
}

impl Surface for PopupsView {
    const NAME: &'static str = "popups";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let me = cx.entity().downgrade();
        cx.set_global(PopupsHandle(me));
        // The next key that does something else takes the errors that fade
        let keys = cx.observe_keystrokes(|p: &mut Self, _, _, cx| p.dismiss_on_input(cx));
        PopupsView {
            _keys: keys,
            scx,
            focus: cx.focus_handle(),
            modal: None,
            prev_focus: None,
            balloons: Balloons::default(),
            guard: None,
            awaiting: None,
            queued: Vec::new(),
            await_task: None,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<PopupsEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            PopupsEvent::Focus => self.focus_modal(window, cx),
            PopupsEvent::Menu(m) => self.lua_menu(m, window, cx),
            PopupsEvent::MenuClose { id } => {
                if matches!(&self.modal, Some(Modal::Menu(m)) if m.lua_id == Some(id)) {
                    self.close(window, cx);
                }
            }
            PopupsEvent::Input(i) => self.lua_input(i, window, cx),
            PopupsEvent::Typeahead { keys, token } => self.typeahead(keys, token, window, cx),
            PopupsEvent::InputComplete { id, text, items } => {
                if let Some(Modal::Input(i)) = &mut self.modal
                    && i.lua_id == Some(id)
                {
                    i.completed(&text, items, cx);
                }
            }
            PopupsEvent::Balloon(b) => {
                let rpc = self.scx.rpc.clone();
                let balloon = b.into_balloon(move |id| {
                    std::rc::Rc::new(move |_: &mut Window, _: &mut App| {
                        // (an action opens a file, a diff: Changed outside's Resolve)
                        lua::navigate(&rpc, "config.app.balloon", "act", vec![id.clone().into()]);
                    })
                });
                self.show_balloon(balloon, cx)
            }
            PopupsEvent::BalloonHide { id } => {
                self.balloons.hide(id.as_deref());
                cx.notify();
            }
            PopupsEvent::KeyHelp(k) => {
                let help = keyhelp::KeyHelp::new(k);
                self.open_modal(Modal::KeyHelp(help), window, cx);
            }
        }
    }
}

impl PopupsView {
    // Test / inspection hooks --------------------------------------------------------------------

    /// A menu, input field or key help is open.
    pub fn is_open(&self) -> bool {
        self.modal.is_some()
    }

    /// The open menu's look (context menu vs. list popup).
    pub fn menu_style(&self) -> Option<MenuStyle> {
        match &self.modal {
            Some(Modal::Menu(m)) => Some(m.style()),
            _ => None,
        }
    }

    /// The open menu's header title (`vim.ui.select` prompts, the tree's Move question).
    pub fn menu_title(&self) -> Option<String> {
        match &self.modal {
            Some(Modal::Menu(m)) => m.title_text(),
            _ => None,
        }
    }

    /// The open menu's rows ("-" for separators, an info line's text).
    pub fn menu_rows(&self) -> Option<Vec<String>> {
        match &self.modal {
            Some(Modal::Menu(m)) => Some(m.rows()),
            _ => None,
        }
    }

    /// The open menu's title as drawn, a line each (a long question wraps).
    pub fn menu_title_lines(&self) -> Option<Vec<String>> {
        match &self.modal {
            Some(Modal::Menu(m)) => Some(m.title_lines()),
            _ => None,
        }
    }

    /// Whether the open menu's row `ix` can be chosen (an info line can't).
    pub fn menu_row_selectable(&self, ix: usize) -> Option<bool> {
        match &self.modal {
            Some(Modal::Menu(m)) => Some(m.selectable(ix)),
            _ => None,
        }
    }

    /// The open menu's selected item label.
    pub fn menu_selected(&self) -> Option<String> {
        match &self.modal {
            Some(Modal::Menu(m)) => m.selected_label(),
            _ => None,
        }
    }

    /// The open menu's selected row's tooltip beside it (tests).
    pub fn menu_side_tooltip(&self) -> Option<String> {
        match &self.modal {
            Some(Modal::Menu(m)) => m.side_tooltip_text(),
            _ => None,
        }
    }

    /// The open menu's item with this label.
    pub fn menu_item(&self, label: &str) -> Option<MenuItem> {
        match &self.modal {
            Some(Modal::Menu(m)) => m.item_by_label(label),
            _ => None,
        }
    }

    /// The open menu's speed search (Some while open, after `/`).
    pub fn menu_query(&self) -> Option<String> {
        match &self.modal {
            Some(Modal::Menu(m)) => m.query(),
            _ => None,
        }
    }

    /// The open menu's frame (window coordinates).
    pub fn menu_bounds(&self) -> Option<Bounds<Pixels>> {
        match &self.modal {
            Some(Modal::Menu(m)) => Some(m.bounds()),
            _ => None,
        }
    }

    /// The open input field: (title, text, selected byte range).
    pub fn input_state(&self, cx: &App) -> Option<(String, String, std::ops::Range<usize>)> {
        match &self.modal {
            Some(Modal::Input(i)) => Some(i.state(cx)),
            _ => None,
        }
    }

    /// The input popup's frame (window coordinates, from the last layout).
    pub fn input_bounds(&self) -> Option<Bounds<Pixels>> {
        match &self.modal {
            Some(Modal::Input(i)) => i.bounds(),
            _ => None,
        }
    }

    /// Balloons on screen, oldest first: (title, body).
    pub fn balloons(&self) -> Vec<(String, String)> {
        self.balloons.list()
    }

    /// The key help's title and rows (key, description) while it's open.
    pub fn key_help(&self) -> Option<(String, Vec<(String, String)>)> {
        match &self.modal {
            Some(Modal::KeyHelp(k)) => Some((k.title(), k.rows_text())),
            _ => None,
        }
    }

    /// The open flow dialog as text, when its builder gave it ([`flow::Flow::lines`]; tests).
    pub fn flow_lines(&self) -> Option<Vec<String>> {
        match &self.modal {
            Some(Modal::Dialog(d)) => d.dialog.lines.clone(),
            _ => None,
        }
    }

    /// The open flow dialog: its id and title (tests).
    pub fn dialog(&self) -> Option<(&'static str, String)> {
        match &self.modal {
            Some(Modal::Dialog(d)) => Some((d.dialog.id, d.dialog.title.to_string())),
            _ => None,
        }
    }

    /// The open dialog's rows as text, section by section: `heading: name · meta · end` (tests).
    pub fn dialog_rows(&self) -> Vec<String> {
        let Some(Modal::Dialog(d)) = &self.modal else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for s in &d.dialog.sections {
            for r in &s.rows {
                let mut line = format!("{}: {}", s.heading, r.name);
                if let Some(m) = &r.meta {
                    line.push_str(&format!(" · {m}"));
                }
                if let Some((e, _)) = &r.end {
                    line.push_str(&format!(" · {e}"));
                }
                out.push(line);
            }
        }
        out
    }

    /// Text typed into the open dialog's text area (tests).
    pub fn dialog_type(&self, text: &str, cx: &mut App) {
        if let Some(Modal::Dialog(d)) = &self.modal {
            d.type_text(text, cx);
        }
    }

    /// The open dialog's text area has the keyboard (tests).
    pub fn dialog_typing(&self, window: &Window, cx: &App) -> bool {
        match &self.modal {
            Some(Modal::Dialog(d)) => d.area_focused(window, cx),
            _ => false,
        }
    }

    /// The open dialog's labelled values and the lines its chosen cards show, then its footer
    /// note as `note: …` (tests).
    pub fn dialog_values(&self) -> Vec<String> {
        match &self.modal {
            Some(Modal::Dialog(d)) => {
                let mut out = d.value_lines();
                out.extend(d.note().map(|n| format!("note: {n}")));
                out
            }
            _ => Vec::new(),
        }
    }

    /// The open dialog's chosen cards, group by group (tests).
    pub fn dialog_choices(&self) -> Vec<usize> {
        match &self.modal {
            Some(Modal::Dialog(d)) => d.chosen().to_vec(),
            _ => Vec::new(),
        }
    }

    // Opening / closing --------------------------------------------------------------------------

    /// Replaces the open modal (its owner hears "cancelled") and takes the keyboard.
    fn open_modal(&mut self, modal: Modal, window: &mut Window, cx: &mut Context<Self>) {
        // a hidden project's menu / field (Lua asked in the background): cancelled, never shown
        // over the shown project
        if !self.scx.active() {
            Self::answer_cancel(modal, window, cx);
            return;
        }
        if let Some(old) = self.modal.take() {
            Self::answer_cancel(old, window, cx);
        } else {
            // the keyboard goes back there on close
            let ours = self.focus.clone();
            self.prev_focus = window
                .focused(cx)
                .filter(|f| f != &ours && !ours.contains(f, window));
        }
        self.modal = Some(modal);
        self.focus_modal(window, cx);
        cx.notify();
    }

    fn focus_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.modal {
            Some(Modal::Input(i)) => i.focus(window, cx),
            Some(Modal::Dialog(d)) => d.focus(&self.focus, window, cx),
            Some(_) => window.focus(&self.focus, cx),
            None => {}
        }
    }

    /// Closes the modal without answering; the keyboard goes back.
    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Modal> {
        let modal = self.modal.take()?;
        let ours = window
            .focused(cx)
            .is_none_or(|f| f == self.focus || self.focus.contains(&f, window));
        match self.prev_focus.take() {
            // focus already went elsewhere (a click's target): it stays there
            _ if !ours => {}
            Some(prev) => window.focus(&prev, cx),
            None => self.scx.focus_editor(window, cx),
        }
        cx.notify();
        Some(modal)
    }

    /// Tells a replaced modal's owner it was cancelled, like menu.lua's WinLeave close: no
    /// restore, `on_cancel` / `on_confirm(nil)` run. (A Lua popup replaced by its own next one
    /// already let it go there: the answer for the old id is ignored.)
    fn answer_cancel(modal: Modal, window: &mut Window, cx: &mut App) {
        match modal {
            Modal::Menu(m) => {
                let done = m.done;
                window.defer(cx, move |w, cx| done(MenuOutcome::Dismissed, w, cx));
            }
            Modal::Input(i) => {
                let done = i.done;
                window.defer(cx, move |w, cx| done(None, w, cx));
            }
            Modal::KeyHelp(_) => {}
            Modal::Dialog(d) => {
                let done = d.done;
                window.defer(cx, move |w, cx| done(None, w, cx));
            }
        }
    }

    /// Ends the dialog: focus back, then the owner's answer.
    fn finish_dialog(
        &mut self,
        answer: Option<dialog::Answer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Modal::Dialog(d)) = self.close(window, cx) else {
            return;
        };
        let done = d.done;
        window.defer(cx, move |w, cx| done(answer, w, cx));
    }

    /// The dialog's keys before its text area sees them: ⏎ presses the default button (⇧⏎ stays
    /// a new line), ⌘⏎ its button, Esc cancels.
    fn dialog_capture_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        let Some(Modal::Dialog(d)) = &mut self.modal else {
            return;
        };
        // ⏎ on the rows to pick from answers the row
        if key == "<CR>"
            && let dialog::Nav::Answer(a) = d.nav(&key, cx)
        {
            cx.stop_propagation();
            return self.finish_dialog(Some(a), window, cx);
        }
        let Some(Modal::Dialog(d)) = &self.modal else {
            return;
        };
        if key == "<Esc>" {
            cx.stop_propagation();
            return self.finish_dialog(None, window, cx);
        }
        if (key == "<CR>" || key == "<D-CR>")
            && let Some(id) = d.button_for(&key, true)
        {
            cx.stop_propagation();
            let a = d.answer(id, None, cx);
            self.finish_dialog(Some(a), window, cx);
        }
    }

    /// Ends the menu: focus back, then the owner's answer.
    fn finish_menu(&mut self, out: MenuOutcome, window: &mut Window, cx: &mut Context<Self>) {
        if out == MenuOutcome::Dismissed {
            // the click lands where it was made: focus follows it, not back
            self.prev_focus = None;
        }
        let Some(Modal::Menu(m)) = self.close(window, cx) else {
            return;
        };
        let done = m.done;
        window.defer(cx, move |w, cx| done(out, w, cx));
    }

    fn finish_input(&mut self, text: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Modal::Input(i)) = self.close(window, cx) else {
            return;
        };
        let done = i.done;
        window.defer(cx, move |w, cx| done(text, w, cx));
    }

    /// Esc while the open modal lost the keyboard (a click outside kept a dialog holding text, a ⌘
    /// key moved the focus): it closes as Esc would, the keyboard staying where it went.
    pub fn escape_unfocused(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.prev_focus = None;
        match &self.modal {
            Some(Modal::Menu(_)) => self.finish_menu(MenuOutcome::Dismissed, window, cx),
            Some(Modal::Input(_)) => self.finish_input(None, window, cx),
            Some(Modal::KeyHelp(_)) => {
                self.close(window, cx);
            }
            Some(Modal::Dialog(_)) => self.finish_dialog(None, window, cx),
            None => {}
        }
    }

    /// A click outside the modal: it goes, the click lands where it was made.
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.modal {
            Some(Modal::Menu(_)) => self.finish_menu(MenuOutcome::Dismissed, window, cx),
            Some(Modal::Input(_)) => {
                self.prev_focus = None;
                self.finish_input(None, window, cx)
            }
            Some(Modal::KeyHelp(_)) => {
                self.prev_focus = None;
                self.close(window, cx);
            }
            // a click outside keeps a dialog whose text area holds text
            Some(Modal::Dialog(d)) if d.has_text(cx) => {}
            Some(Modal::Dialog(_)) => {
                self.prev_focus = None;
                self.finish_dialog(None, window, cx);
            }
            None => {}
        }
    }

    /// Where a Lua popup goes (see [`LuaAnchor`]).
    fn lua_anchor(&self, a: &LuaAnchor, window: &Window) -> Anchor {
        if let Some(p) = &a.pos {
            return Anchor::Point(point(px(p.x), px(p.y)));
        }
        if a.at.as_deref() == Some("mouse") {
            return Anchor::Point(window.mouse_position());
        }
        let geo = self.scx.geometry();
        let cell = a.win.and_then(|win| {
            let rect = geo.win_rect(win)?;
            let (row, col) = (a.row?.max(0) as usize, a.col?.max(0) as usize);
            geo.cell_bounds(rect.grid, row, col, 1)
        });
        match cell.or_else(|| geo.caret()) {
            Some(rect) => Anchor::Below(rect),
            None => {
                let v = window.viewport_size();
                Anchor::Point(point(v.width / 3., v.height / 3.))
            }
        }
    }

    fn lua_menu(&mut self, m: LuaMenu, window: &mut Window, cx: &mut Context<Self>) {
        let anchor = self.lua_anchor(&m.anchor, window);
        let cell_w = self.scx.geometry().metrics.cell_width;
        let id = m.id;
        let icons = m.icons != Some(false);
        let captions = (m.items.iter().enumerate())
            .filter_map(|(ix, i)| Some((ix, i.caption()?)))
            .collect();
        let menu = Menu {
            // vim.ui.select (no label icons) is WebStorm's ListPopup, the providers' menus its
            // right-click JPopupMenu
            style: Some(if icons && m.title.as_deref().is_none_or(str::is_empty) {
                MenuStyle::Context
            } else {
                MenuStyle::List
            }),
            captions,
            entries: m.items.into_iter().map(|i| i.into_entry(icons)).collect(),
            anchor,
            title: m.title.filter(|t| !t.is_empty()).map(Into::into),
            title_highlights: menu::highlights(m.title_hl),
            header_right: m.header_right.filter(|t| !t.is_empty()).map(Into::into),
            header_right_highlights: menu::highlights(m.header_right_hl),
            max_rows: m.max_height,
            max_width: m.max_width.map(|c| cell_w * c as f32),
            search_shortcuts: m.match_key,
        };
        let rpc = self.scx.rpc.clone();
        let done: Done<MenuOutcome> = Box::new(move |out, _, _| {
            let (func, args): (&str, Vec<Value>) = match out {
                MenuOutcome::Chosen(ix, mouse) => (
                    "choose",
                    vec![id.into(), (ix as u64 + 1).into(), mouse.into()],
                ),
                MenuOutcome::Cancelled => ("cancel", vec![id.into(), true.into()]),
                MenuOutcome::Dismissed => ("cancel", vec![id.into(), false.into()]),
            };
            lua::call(&rpc, "config.app.menu", func, args);
        });
        let popup = menu::MenuPopup::new(menu, done, Some(id), window);
        self.open_modal(Modal::Menu(Box::new(popup)), window, cx);
    }

    fn lua_input(&mut self, i: LuaInput, window: &mut Window, cx: &mut Context<Self>) {
        let anchor = self.lua_anchor(&i.anchor, window);
        let id = i.id;
        let rpc = self.scx.rpc.clone();
        let done: Done<Option<String>> = Box::new(move |text, _, _| {
            let text = text.map_or(Value::Nil, Value::from);
            lua::call(&rpc, "config.app.input", "done", vec![id.into(), text]);
        });
        let input = Input {
            dialog: i.dialog,
            placeholder: i.placeholder.filter(|p| !p.is_empty()),
            ..Input::new(
                i.title.unwrap_or_default(),
                i.text.unwrap_or_default(),
                anchor,
            )
        };
        let mut popup = input::InputPopup::new(input, done, Some(id), window, cx);
        popup.completion = i.completion.filter(|c| !c.is_empty());
        self.open_modal(Modal::Input(popup), window, cx);
        if matches!(&self.modal, Some(Modal::Input(i)) if i.lua_id == Some(id)) {
            self.focused(id, window, cx);
        }
    }

    /// The field has the keyboard: nvim hands over the keys it held since `vim.ui.input`. Until it
    /// answers, keys typed into the field wait ([`Self::on_capture_key`]).
    fn focused(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.awaiting = Some(id);
        self.scx
            .call("config.app.input", "focused", vec![Value::from(id)]);
        // nvim busy or gone: don't keep the keyboard waiting
        self.await_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(AWAIT_MAX).await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.awaiting == Some(id) {
                    this.release_keys(window, cx);
                }
            });
        }));
    }

    /// nvim answered (or took too long): the keys typed into the field meanwhile go to it now.
    fn release_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.awaiting = None;
        self.await_task = None;
        let keys = std::mem::take(&mut self.queued);
        if !keys.is_empty() {
            // dispatched again as typed, after this update
            window.defer(cx, move |window, cx| {
                for k in keys {
                    window.dispatch_keystroke(k, cx);
                }
            });
        }
    }

    /// Keys typed before field `token` had the keyboard: typed into it before anything typed
    /// there since (over the selected default, as typing would); Enter / Esc among them answer it.
    fn typeahead(
        &mut self,
        keys: Vec<String>,
        token: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = match &self.modal {
            Some(Modal::Input(i)) if token.is_none() || i.lua_id == token => Some(i.field()),
            _ => None,
        };
        if let Some(field) = field {
            for k in keys.iter().flat_map(|k| crate::search::split_keys(k)) {
                match k.as_str() {
                    "<CR>" => {
                        let text = field.read(cx).text().to_string();
                        self.finish_input(Some(text), window, cx);
                        break;
                    }
                    "<Esc>" => {
                        self.finish_input(None, window, cx);
                        break;
                    }
                    "<Space>" => field.update(cx, |f, cx| f.insert(" ", cx)),
                    "<lt>" => field.update(cx, |f, cx| f.insert("<", cx)),
                    "<BS>" => {
                        field.update(cx, |f, cx| f.key("<BS>", window, cx));
                    }
                    _ if k.chars().count() == 1 => field.update(cx, |f, cx| f.insert(&k, cx)),
                    _ => {}
                }
            }
            cx.notify();
        }
        if token.is_some() && token == self.awaiting {
            self.release_keys(window, cx);
        }
    }

    // Balloons -----------------------------------------------------------------------------------

    fn show_balloon(&mut self, b: Balloon, cx: &mut Context<Self>) {
        errors::record(&b, cx);
        self.balloons.show(b);
        cx.notify();
    }

    /// The balloon with this id closes (its cause is gone).
    pub fn hide_balloon(&mut self, id: &str, cx: &mut Context<Self>) {
        self.balloons.hide(Some(id));
        cx.notify();
    }

    /// A key or a click that does something else: the errors that fade go.
    pub fn dismiss_on_input(&mut self, cx: &mut Context<Self>) {
        if self
            .balloons
            .dismiss_on_input(cx.background_executor().now())
        {
            cx.notify();
        }
    }

    /// Ids of the balloons on screen, oldest first (elements `balloon-<id>`; test hook).
    pub fn balloon_ids(&self) -> Vec<String> {
        self.balloons.visible_ids()
    }

    /// Balloons waiting for room on screen (test hook).
    pub fn balloons_waiting(&self) -> usize {
        self.balloons.waiting()
    }

    // Keys ---------------------------------------------------------------------------------------

    /// Before the field sees a key: nvim may still hold keys typed before it, so it waits for them.
    fn on_capture_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.awaiting.is_some() && matches!(self.modal, Some(Modal::Input(_))) {
            self.queued.push(ev.keystroke.clone());
            cx.stop_propagation();
        }
    }

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        match &mut self.modal {
            Some(Modal::Menu(m)) => {
                if key == "<D-CR>" {
                    cx.stop_propagation();
                    return self.finish_menu(MenuOutcome::Cancelled, window, cx);
                }
                let typed = kit::typed_text(ev);
                let out = m.key(&key, typed.as_deref());
                if out != ListOutcome::Ignored {
                    cx.stop_propagation();
                }
                match out {
                    ListOutcome::Confirm(ix) => {
                        self.finish_menu(MenuOutcome::Chosen(ix, false), window, cx)
                    }
                    ListOutcome::Cancel => self.finish_menu(MenuOutcome::Cancelled, window, cx),
                    ListOutcome::Changed => cx.notify(),
                    // menus have no Vim layer
                    ListOutcome::Ignored | ListOutcome::Vim(_) => {}
                }
            }
            Some(Modal::Input(i)) => match key.as_str() {
                "<CR>" => {
                    cx.stop_propagation();
                    let text = i.state(cx).1;
                    self.finish_input(Some(text), window, cx);
                }
                "<Esc>" => {
                    cx.stop_propagation();
                    self.finish_input(None, window, cx);
                }
                "<Tab>" | "<S-Tab>" if i.completion.is_some() => {
                    cx.stop_propagation();
                    let back = key == "<S-Tab>";
                    if let (Some(text), Some(id)) = (i.complete(back, cx), i.lua_id) {
                        // ask Lua; the answer comes back as `input_complete`
                        self.scx
                            .call("config.app.input", "complete", vec![id.into(), text.into()]);
                    }
                }
                _ => {}
            },
            Some(Modal::Dialog(d)) => {
                if ev.keystroke.modifiers.platform && key != "<D-CR>" {
                    return; // global shortcuts go on to nvim
                }
                cx.stop_propagation();
                match d.nav(&key, cx) {
                    dialog::Nav::Moved => return cx.notify(),
                    dialog::Nav::Answer(a) => return self.finish_dialog(Some(a), window, cx),
                    dialog::Nav::None => {}
                }
                if key == "<Space>" {
                    if d.toggle() {
                        cx.notify();
                    }
                } else if let Some(id) = d.button_for(&key, false) {
                    let a = d.answer(id, None, cx);
                    self.finish_dialog(Some(a), window, cx);
                } else if key == "<Esc>" {
                    self.finish_dialog(None, window, cx);
                }
            }
            Some(Modal::KeyHelp(k)) => {
                let m = ev.keystroke.modifiers;
                if m.platform {
                    return; // global shortcuts go on to nvim
                }
                cx.stop_propagation();
                match k.key(&key) {
                    keyhelp::Step::Stay => cx.notify(),
                    keyhelp::Step::Close => {
                        self.close(window, cx);
                    }
                    keyhelp::Step::Run(keys) => {
                        self.close(window, cx);
                        self.scx
                            .call("config.app.keyhelp", "run", vec![keys.into()]);
                    }
                }
            }
            None => {}
        }
    }

    // Mouse --------------------------------------------------------------------------------------

    /// Every press (capture): the guarded second press of a double-click on a menu row is
    /// swallowed.
    fn on_capture_down(&mut self, ev: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some((at, when)) = self.guard.take() else {
            return;
        };
        let near = (ev.position.x - at.x).abs() < px(4.) && (ev.position.y - at.y).abs() < px(4.);
        if ev.click_count >= 2 && near && when.elapsed() < DOUBLE_CLICK_GUARD {
            cx.stop_propagation();
        }
    }

    fn menu_row_hover(&mut self, ix: usize, hovered: bool, cx: &mut Context<Self>) {
        if let Some(Modal::Menu(m)) = &mut self.modal
            && m.hover(ix, hovered)
        {
            cx.notify();
        }
    }

    fn menu_press(&mut self, cx: &mut Context<Self>) {
        if let Some(Modal::Menu(m)) = &mut self.modal {
            m.pressed = true;
        }
        cx.stop_propagation();
    }

    fn menu_row_up(
        &mut self,
        ix: usize,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Modal::Menu(m)) = &self.modal else {
            return;
        };
        if !m.pressed || !m.selectable(ix) {
            return;
        }
        cx.stop_propagation();
        self.guard = Some((position, Instant::now()));
        self.finish_menu(MenuOutcome::Chosen(ix, true), window, cx);
    }

    /// Middle-click (anywhere while the menu is open): cancelled, like Esc.
    fn menu_middle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.modal, Some(Modal::Menu(_))) {
            self.finish_menu(MenuOutcome::Cancelled, window, cx);
        }
    }

    fn menu_wheel(&mut self, delta: gpui_kit::ScrollDelta, cx: &mut Context<Self>) {
        if let Some(Modal::Menu(m)) = &mut self.modal
            && m.wheel(delta)
        {
            cx.notify();
        }
    }
}

/// The icon WebStorm shows for a menu label (menu.lua's ICONS, as WebStorm SVGs).
fn label_icon(label: &str) -> Option<IconName> {
    Some(match label {
        "Cut" => IconName::Cut,
        "Copy" => IconName::Copy,
        "Paste" => IconName::Paste,
        "Show Context Actions" => IconName::IntentionBulb,
        "Split Right" => IconName::SplitVertically,
        "Split Down" => IconName::SplitHorizontally,
        "Show History" | "Show History for File" | "Show History for Selection" => {
            IconName::History
        }
        "Commit…" => IconName::Commit,
        "Push…" => IconName::Push,
        "Rollback…" | "Rollback Lines" => IconName::Revert,
        "Show Diff" | "Show Diff for Lines" => IconName::Diff,
        "Select in Project View" => IconName::Locate,
        "Open in Terminal" => IconName::ToolWindowTerminal,
        "Collapse All" => IconName::CollapseAll,
        "Expand All" => IconName::ExpandAll,
        _ => return None,
    })
}

/// An icon by the name config/app/menu.lua gives an item's own glyph: config/icons.lua's file
/// kinds ("ts", "folder"...) or a menu action ("editor_only"...).
fn named_icon(name: &str) -> Option<IconName> {
    Some(match name {
        "folder" | "folder_link" => IconName::Folder,
        "file" => IconName::AnyType,
        "text" => IconName::Text,
        "image" => IconName::Image,
        "font" => IconName::Font,
        "ignored" => IconName::Ignored,
        "shell" => IconName::Shell,
        "archive" => IconName::Archive,
        "gear" => IconName::EditorConfig,
        "sourcemap" => IconName::SourceMap,
        "eslint" => IconName::Eslint,
        "prettier" => IconName::Prettier,
        "editor_only" => IconName::EditorOnly,
        "preview_only" => IconName::PreviewOnly,
        "split_right" | "editor_preview" => IconName::SplitVertically,
        "split_down" => IconName::SplitHorizontally,
        "cut" => IconName::Cut,
        "copy" => IconName::Copy,
        "paste" => IconName::Paste,
        "intention" => IconName::IntentionBulb,
        "history" => IconName::History,
        "terminal" => IconName::ToolWindowTerminal,
        // the rest are file extensions (ts, js, json, md, css, html, xml, yaml, sql, tsx, sass...)
        ext if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) => {
            match kit::for_file(&format!("x.{ext}")) {
                IconName::Text if ext != "txt" && ext != "text" => return None,
                icon => icon,
            }
        }
        _ => return None,
    })
}

/// Width of `text` in the UI font.
pub(super) fn text_width(window: &Window, text: &str, weight: gpui_kit::FontWeight) -> Pixels {
    let mut f = gpui_kit::font(crate::render::UI_FONT);
    f.weight = weight;
    crate::kit::width(window, text, f, px(crate::look::UI_FONT_SIZE))
}

/// A file's icon for a menu row (usages).
fn file_icon(path: &str) -> IconName {
    kit::for_file(path.rsplit('/').next().unwrap_or(path))
}

impl Focusable for PopupsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl BalloonHost for PopupsView {
    fn balloons_mut(&mut self) -> &mut Balloons {
        &mut self.balloons
    }
}

impl Render for PopupsView {
    /// The open modal and the balloons, drawn over everything (`deferred`, window coordinates).
    /// The root has no size: a focus-tracking element takes the keyboard on any click inside it,
    /// so only the popups' own elements are hit.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let mut root = div()
            .id("popups")
            .key_context("VimStormPopups")
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::on_capture_key))
            .on_key_down(cx.listener(Self::on_key_down))
            .absolute()
            .top_0()
            .left_0();
        if self.guard.is_some() {
            // a window-sized capture layer while a double-click's second press may come
            root = root.child(
                div()
                    .id("popups-guard")
                    .absolute()
                    .top_0()
                    .left_0()
                    .w(viewport.width)
                    .h(viewport.height)
                    .capture_any_mouse_down(cx.listener(Self::on_capture_down)),
            );
        }
        match &mut self.modal {
            Some(Modal::Menu(m)) => root = root.child(m.render(viewport, window, cx)),
            Some(Modal::Input(i)) => root = root.child(i.render(cx)),
            Some(Modal::Dialog(d)) => root = root.child(d.render(cx)),
            Some(Modal::KeyHelp(k)) => {
                let editor = self.scx.geometry().layout.editor;
                let area = if editor.size.width > px(0.) {
                    editor
                } else {
                    Bounds::new(point(px(0.), px(0.)), size(viewport.width, viewport.height))
                };
                root = root.child(k.render(area, viewport.width, cx));
            }
            None => {}
        }
        if !self.balloons.is_empty() {
            let frame = self.scx.geometry().layout.frame;
            let above = if frame.status.size.height > px(0.) {
                viewport.height - frame.status.top()
            } else {
                px(0.)
            };
            // up to the toolbar, like snacks' notifier keeps to the editor's rows
            let room = viewport.height
                - above
                - frame.toolbar.bottom()
                - px(2. * crate::look::BALLOON_MARGIN);
            let (stack, timers) = self.balloons.render(viewport, above, room, window, cx);
            balloon::start_timers(timers, cx);
            // The next click anywhere in the window takes the errors that fade (a key:
            // `new`'s keystroke observer)
            let clicks = cx.entity().downgrade();
            let input = gpui_kit::canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    window.on_mouse_event(move |_: &MouseDownEvent, phase, _, cx| {
                        if phase == gpui_kit::DispatchPhase::Capture {
                            let _ = clicks.update(cx, |p, cx| p.dismiss_on_input(cx));
                        }
                    });
                },
            );
            root = root.child(stack).child(input);
        }
        root
    }
}
