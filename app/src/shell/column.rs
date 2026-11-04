//! The Chat column (boards W-Editor, W-NoSession, F-Terminal, C-DragOut, Keys): the
//! agent's right island, 420 px by default (320–640 by dragging its left gap, one width for the
//! window, kept across launches), full height from the header's row to the status bar; the tree, the
//! editor and the bottom pane sit left of it. nvim's screen loses its width
//! ([`super::layout::Panels::chat`]): it is layout, not an nvim window.
//!
//! Its tool header: the `Chat | Terminal` toggle (the tool tabs' look), Options `⋯` (Drag out
//! ⌘⇧D, Hide) and Hide `×`. Both modes draw [`ChatContent`] (the bridge's `chat` slot, t119a's
//! `SlotView`: [`ChatColumn::set_chat`] is the one seam, fed by `Projects::chat_content`; a dim
//! placeholder without an `abe` 2.0): Chat mode the rendered chat, Terminal mode the same
//! session's Claude Code TUI attached (`abe session attach`, a box's `abe box attach --session`,
//! the `chat` screen opened with `mode: terminal`). The column is the AI chat only:
//! shells live in the bottom pane's Terminal ([`crate::terminal`]).
//!
//! Open / mode / width / torn out are the window's ([`ColumnState`], a global: hidden per view,
//! the same for every workspace); each [`super::Workspace`] has its own [`ChatColumn`] for its
//! Chat. The Factory view's column has its own mode ([`ColumnState::factory_mode`]), its
//! Terminal mode the selected card's session. Keys (the window's, before nvim and any surface):
//! ⌘4 shows it in its mode with the keyboard, again (it has them) hides it ([`super::PaneKey`]);
//! ⌃⌘← / ⌃⌘→ in Chat / Terminal mode (never hiding it: × or ⌘⌥2 does; on Code, with the keys in
//! another pane, they are that pane's previous / next tab: [`ColumnKey::Arrow`]), ⌘⇧D
//! tears the column out into a window of its own ([`TornChat`]) and docks it again (so does
//! closing that window). Esc in Chat gives the keyboard back without hiding.

use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, Global,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, TitlebarOptions, WeakEntity, Window, WindowBounds, WindowOptions, div, point,
    prelude::FluentBuilder as _, px, size,
};

use super::SurfaceCx;
use super::layout::{CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, CHAT_WIDTH};
use crate::factory::ChatFeel;
use crate::kit::Anchor;
use crate::kit::IconButton;
use crate::kit::IconName;
use crate::look;
use crate::popups::{self, Menu, MenuItem};

/// The column as a native surface (Lua's `native_focus` name: `focus.target()` says "popup" for
/// it), both modes.
pub const CHAT: &str = "chat";

/// Below this window width the column starts hidden.
pub const NARROW_WINDOW: f32 = 900.0;

/// The torn window's footer.
const FOOTER_HEIGHT: f32 = 24.0;

/// Whether the column shows when a window starts, before the settings are read: not in a narrow
/// window. `chat.openByDefault` (Settings › Appearance › Chat) then closes it
/// ([`ColumnState::with_settings`]).
pub fn open_by_default(window_width: f32) -> bool {
    window_width >= NARROW_WINDOW
}

/// What the column shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ColumnMode {
    /// The agent's Chat, rendered (the bridge's `chat` slot).
    #[default]
    Chat,
    /// The same session's Claude Code TUI (the `chat` slot's attach).
    Terminal,
}

impl ColumnMode {
    /// The toggle's word: Terminal mode is Claude Code's own TUI (3.0), so it says that.
    fn word(self) -> &'static str {
        match self {
            ColumnMode::Chat => "Chat",
            ColumnMode::Terminal => "Claude Code",
        }
    }

    /// Its element id and debug selector (`column-mode-Terminal`), apart from its word.
    fn id(self) -> &'static str {
        match self {
            ColumnMode::Chat => "Chat",
            ColumnMode::Terminal => "Terminal",
        }
    }

    fn key(self) -> &'static str {
        match self {
            ColumnMode::Chat => "⌃⌘←",
            ColumnMode::Terminal => "⌃⌘→",
        }
    }
}

/// The window's column: shown or hidden (the Editor's; the Factory view's own later), its mode,
/// its width and its torn-out window.
#[derive(Clone, Debug, PartialEq)]
pub struct ColumnState {
    /// Shown in the Editor view.
    pub open: bool,
    /// Shown in the Factory view (beside the Board, full height).
    pub factory_open: bool,
    /// The Factory view is the shown view: the column's shown / hidden is its `factory_open`
    /// (hidden per view), the Editor's `open` stays as it was.
    pub factory_shown: bool,
    /// The Editor's mode (Terminal mode: the shown workspace's session attached).
    pub mode: ColumnMode,
    /// The Factory view's mode: Terminal mode there is the selected card's session
    /// attached, drawn by the bridge's `chat` screen in the same slot as Chat.
    pub factory_mode: ColumnMode,
    pub width: f32,
    /// Torn out (⌘⇧D) into this window; never kept across launches.
    pub torn: Option<AnyWindowHandle>,
    /// The torn window's last bounds (its size and place remembered while the app runs).
    pub torn_bounds: Option<Bounds<Pixels>>,
    /// Made at the window's start: `chat.openByDefault` / `chat.width` not applied yet (they come
    /// with the bridge's first `feel`). A state set otherwise (a test's) has none to apply.
    pub settings_pending: bool,
}

impl Default for ColumnState {
    /// A bare workspace's (tests): hidden until ⌘4 / ⌃⌘← ⌃⌘→; the app's window starts with
    /// [`ColumnState::at_start`].
    fn default() -> Self {
        ColumnState {
            open: false,
            factory_open: false,
            factory_shown: false,
            mode: ColumnMode::Chat,
            factory_mode: ColumnMode::Chat,
            width: CHAT_WIDTH,
            torn: None,
            torn_bounds: None,
            settings_pending: false,
        }
    }
}

impl Global for ColumnState {}

/// The Factory view's keyboard (the Board's), where the Factory view's column gives the keys back.
pub struct BoardFocus(pub FocusHandle);

impl Global for BoardFocus {}

impl ColumnState {
    /// A window starting `window_width` wide: open by default, the width kept from the last
    /// launch (`state_home`'s), docked.
    pub fn at_start(window_width: f32, state_home: Option<&Path>) -> ColumnState {
        let open = open_by_default(window_width);
        ColumnState {
            open,
            factory_open: open,
            width: load_width(state_home).unwrap_or(CHAT_WIDTH),
            settings_pending: true,
            ..ColumnState::default()
        }
    }

    /// The settings over the start, once (the first `feel`): `chat.openByDefault` off hides it;
    /// `chat.width` is the width unless one was dragged last launch (`saved`).
    pub fn with_settings(&self, chat: ChatFeel, saved: Option<f32>) -> ColumnState {
        if !self.settings_pending {
            return self.clone();
        }
        let width = saved.unwrap_or((chat.width as f32).clamp(CHAT_MIN_WIDTH, CHAT_MAX_WIDTH));
        ColumnState {
            open: self.open && chat.open_by_default,
            factory_open: self.factory_open && chat.open_by_default,
            width: if self.torn.is_some() {
                self.width
            } else {
                width
            },
            settings_pending: false,
            ..self.clone()
        }
    }

    /// The width it takes off nvim's screen in the Editor (None: hidden or torn out).
    pub fn docked_width(&self) -> Option<f32> {
        (self.open && self.torn.is_none()).then_some(self.width)
    }

    /// The width it takes off the Board in the Factory view (None: hidden or torn out).
    pub fn factory_docked_width(&self) -> Option<f32> {
        (self.factory_open && self.torn.is_none()).then_some(self.width)
    }

    /// Shown in the view that is shown (the Editor's `open`, the Factory view's `factory_open`).
    pub fn shown(&self) -> bool {
        if self.factory_shown {
            self.factory_open
        } else {
            self.open
        }
    }

    /// Shows or hides it in the view that is shown.
    pub fn set_shown(&mut self, shown: bool) {
        if self.factory_shown {
            self.factory_open = shown;
        } else {
            self.open = shown;
        }
    }

    /// The mode the shown view's column draws: the Factory view's own, else the Editor's.
    pub fn mode_now(&self) -> ColumnMode {
        if self.factory_shown {
            self.factory_mode
        } else {
            self.mode
        }
    }

    /// The column shows `mode` in the shown view (docked or torn out).
    pub fn shows(&self, mode: ColumnMode) -> bool {
        self.shown() && self.mode_now() == mode
    }
}

/// The window's column state (a bare workspace's default when nobody set it).
pub fn state(cx: &App) -> ColumnState {
    cx.try_global::<ColumnState>().cloned().unwrap_or_default()
}

/// Changes the window's column state (observers hear it only when it changed).
pub fn set_state(cx: &mut App, f: impl FnOnce(&mut ColumnState)) {
    let mut s = state(cx);
    f(&mut s);
    if cx.try_global::<ColumnState>() != Some(&s) {
        cx.set_global(s);
    }
}

/// Where the width is kept across launches: the app's state dir's `chat-column.json`
/// ([`crate::shell::recent::state_dir`]).
fn width_file(state_home: Option<&Path>) -> PathBuf {
    crate::shell::recent::state_dir(state_home).join("chat-column.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Saved {
    width: f32,
}

/// The width kept from the last launch.
pub fn load_width(state_home: Option<&Path>) -> Option<f32> {
    let bytes = std::fs::read(width_file(state_home)).ok()?;
    let saved: Saved = serde_json::from_slice(&bytes).ok()?;
    Some(saved.width.clamp(CHAT_MIN_WIDTH, CHAT_MAX_WIDTH))
}

/// Keeps the width for the next launch (off the UI thread).
pub fn save_width(width: f32, state_home: Option<PathBuf>, cx: &App) {
    // the newest width, written one save at a time: two saves close together never leave the
    // older one on disk
    static LATEST: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LATEST.store(width.to_bits(), std::sync::atomic::Ordering::SeqCst);
    cx.background_spawn(async move {
        let _one = WRITING.lock();
        let width = f32::from_bits(LATEST.load(std::sync::atomic::Ordering::SeqCst));
        let path = width_file(state_home.as_deref());
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // (a temp file renamed over it: never half written)
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&Saved { width })
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &path);
        }
    })
    .detach();
}

/// Chat mode's content: an entity drawing the bridge's `chat` slot filling its bounds, and its
/// keyboard (t119a's `SlotView`).
#[derive(Clone)]
pub struct ChatContent {
    pub view: Entity<crate::factory::SlotView>,
    pub focus: FocusHandle,
    /// The bridge has a layer up (a pick, a confirm): Esc is its, not the column's.
    pub layer_up: std::rc::Rc<dyn Fn(&App) -> bool>,
    /// The bridge runs and has drawn the Chat's screen: before that, Esc is the column's at once.
    pub mounted: std::rc::Rc<dyn Fn(&App) -> bool>,
    /// ⌘§ told the Chat's screen (the repo's Abe chat, again: back where it was).
    pub abe: std::rc::Rc<dyn Fn(&mut App)>,
}

/// ⌘§ as the Chat's screen hears it.
pub const ABE_KEY: &str = "<D-§>";

/// One workspace's column: its Chat, the header (see the module doc).
pub struct ChatColumn {
    scx: SurfaceCx,
    chat: Option<ChatContent>,
    /// Chat mode's keyboard (around the content; the placeholder's own).
    focus: FocusHandle,
    /// `show` with the keyboard before the column drew (a workspace just started, hidden then
    /// shown): the frame blurs a focus it did not draw, so the content takes it as it first draws.
    keys_wanted: bool,
    /// The workspace's window (the torn one is [`ColumnState::torn`]).
    main: AnyWindowHandle,
    _subs: Vec<Subscription>,
}

impl ChatColumn {
    pub fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let subs = vec![
            cx.observe_global::<ColumnState>(|_, cx| cx.notify()),
            // the hidden Chat's ◆ follows the session
            cx.observe_global::<crate::factory::ShownWorkspaces>(|_, cx| cx.notify()),
        ];
        ChatColumn {
            scx,
            chat: None,
            focus: cx.focus_handle(),
            keys_wanted: false,
            main: window.window_handle(),
            _subs: subs,
        }
    }

    /// Chat mode's content (t119a's `SlotView`; None: the placeholder).
    pub fn set_chat(&mut self, chat: Option<ChatContent>, cx: &mut Context<Self>) {
        let same = match (&self.chat, &chat) {
            (Some(a), Some(b)) => a.view.entity_id() == b.view.entity_id(),
            (None, None) => true,
            _ => false,
        };
        if !same {
            self.chat = chat;
            cx.notify();
        }
    }

    /// The handle the column's content takes the keyboard with (both modes are the `chat`
    /// slot's).
    pub(crate) fn target(&self, _mode: ColumnMode, _cx: &App) -> FocusHandle {
        self.chat
            .as_ref()
            .map_or_else(|| self.focus.clone(), |c| c.focus.clone())
    }

    /// `mode`'s content has the keyboard in `window`.
    pub fn has_keyboard(&self, mode: ColumnMode, window: &Window, cx: &App) -> bool {
        state(cx).shows(mode) && self.focus.contains_focused(window, cx)
    }

    /// Anything in the column has the keyboard in `window`.
    pub fn any_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.has_keyboard(ColumnMode::Chat, window, cx)
            || self.has_keyboard(ColumnMode::Terminal, window, cx)
    }

    /// The column shows `mode`; `keyboard`: its content takes the keyboard. Terminal mode is the
    /// `chat` screen opened again with `mode: terminal` (it attaches the session), the shown
    /// view's own mode.
    pub fn show(
        &mut self,
        mode: ColumnMode,
        keyboard: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        set_state(cx, |s| {
            s.set_shown(true);
            if s.factory_shown {
                s.factory_mode = mode;
            } else {
                s.mode = mode;
            }
        });
        // a workspace started in this same step (⌃W's) has not heard the state (its observer
        // came with it): its panels follow now, so the column draws in the next frame
        let ws = self.scx.workspace.clone();
        cx.defer(move |cx| {
            let _ = ws.update(cx, |ws, cx| ws.sync_column(cx));
        });
        if keyboard {
            self.keys_wanted = true;
            self.focus_in_column(mode, window, cx);
        }
        cx.notify();
    }

    /// `mode`'s content takes the keyboard where the column is drawn (the torn window, brought
    /// to the front, while torn out).
    fn focus_in_column(&self, mode: ColumnMode, window: &mut Window, cx: &mut App) {
        let target = self.target(mode, cx);
        match state(cx).torn {
            Some(torn) if torn != window.window_handle() => cx.defer(move |cx| {
                let _ = torn.update(cx, |_, w, cx| {
                    w.activate_window();
                    w.focus(&target, cx);
                });
            }),
            _ => window.focus(&target, cx),
        }
    }

    /// ⌘§: Chat shown with the keyboard, its screen told (it pins the repo's Abe chat, or goes back).
    pub fn abe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show(ColumnMode::Chat, true, window, cx);
        if let Some(chat) = &self.chat {
            (chat.abe)(cx);
        }
    }

    /// `×`, ⌘⌥2: hidden (the hidden side keeps running); the keyboard back
    /// to the code when it was here. Torn out: the torn window closes too.
    pub fn hide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let had = self.any_keyboard(window, cx);
        let torn = state(cx).torn;
        self.keys_wanted = false;
        set_state(cx, |s| {
            s.set_shown(false);
            s.torn = None;
        });
        if let Some(torn) = torn {
            self.close_torn(torn, window, cx);
        }
        if had || torn.is_some() {
            self.back_to_code(window, cx);
        }
        cx.notify();
    }

    /// The Chat's screen did not take an Esc (the bridge's `unhandled`): the keyboard back to the
    /// code, unless it moved on meanwhile (a bridge layer up, or the keys elsewhere).
    pub fn esc_not_taken(&self, window: &mut Window, cx: &mut App) {
        let Some(chat) = &self.chat else { return };
        if (chat.layer_up)(cx) {
            return;
        }
        let docked_here = window.window_handle() == self.main && state(cx).torn.is_none();
        if docked_here
            && !self.focus.contains_focused(window, cx)
            && !chat.focus.contains_focused(window, cx)
        {
            return;
        }
        // maximized: this Esc restores, the keyboard stays in Chat
        if docked_here
            && let Some(ws) = self.scx.workspace.upgrade()
            && ws.read(cx).maximized(cx) == Some(super::layout::Island::Chat)
        {
            ws.update(cx, |ws, cx| ws.restore_maximized(cx));
            return;
        }
        self.back_to_code(window, cx);
    }

    /// Esc in Chat: the keyboard back to the code (the column stays); in the Factory view back
    /// to the Board ([`BoardFocus`]).
    pub fn back_to_code(&self, window: &mut Window, cx: &mut App) {
        if window.window_handle() == self.main
            && state(cx).factory_shown
            && let Some(board) = cx.try_global::<BoardFocus>().map(|b| b.0.clone())
        {
            window.focus(&board, cx);
            return;
        }
        // torn out, the main window comes to the front even when this runs in it (the bridge's)
        if window.window_handle() == self.main && state(cx).torn.is_none() {
            // (deferred: a key the workspace queued runs inside its own update)
            let (ws, scx) = (self.scx.workspace.clone(), self.scx.clone());
            window.defer(cx, move |window, cx| match ws.upgrade() {
                Some(ws) => ws.update(cx, |w, cx| w.focus_page(window, cx)),
                None => scx.focus_editor(window, cx),
            });
            return;
        }
        let scx = self.scx.clone();
        let main = self.main;
        cx.defer(move |cx| {
            let _ = main.update(cx, |_, w, cx| {
                w.activate_window();
                scx.focus_editor(w, cx);
            });
        });
    }

    /// ⌘⇧D: the column torn out into a window of its own, or docked again.
    pub fn toggle_torn(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match state(cx).torn {
            Some(torn) => self.dock(torn, window, cx),
            None => self.tear_out(window, cx),
        }
    }

    fn tear_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let s = state(cx);
        let mode = s.mode_now();
        let main = window.bounds();
        // (the spec's 420 the first time, whatever the docked column's width)
        let width = px(CHAT_WIDTH);
        let bounds = s.torn_bounds.unwrap_or_else(|| {
            // beside the main window's right edge where the column was, as tall as it
            Bounds::new(
                point(main.right() - width, main.origin.y),
                size(width, main.size.height),
            )
        });
        let title = torn_title(&self.scx.project, cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(title.into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let had = self.any_keyboard(window, cx);
        if had {
            // the main window's keyboard leaves the column it no longer draws
            self.scx.focus_editor(window, cx);
        }
        let target = self.target(mode, cx);
        let me = cx.entity();
        // (outside this update: the new window draws the column at once)
        cx.defer(move |cx| {
            let opened = cx.open_window(options, move |w, cx| {
                cx.new(|cx| TornChat::new(me.downgrade(), w, cx))
            });
            match opened {
                Ok(handle) => {
                    let handle: AnyWindowHandle = handle.into();
                    set_state(cx, |s| {
                        s.set_shown(true);
                        s.torn = Some(handle);
                    });
                    let _ = handle.update(cx, |_, w, cx| {
                        w.activate_window();
                        w.focus(&target, cx);
                    });
                }
                Err(e) => eprintln!("[vimstorm] Chat window: {e:#}"),
            }
        });
        cx.notify();
    }

    /// Docked on the right again: ⌘⇧D in either window (closing the torn window: [`TornChat`]).
    fn dock(&mut self, torn: AnyWindowHandle, window: &mut Window, cx: &mut Context<Self>) {
        set_state(cx, |s| s.torn = None);
        self.close_torn(torn, window, cx);
        let mode = state(cx).mode_now();
        let target = self.target(mode, cx);
        let main = self.main;
        if window.window_handle() == main {
            window.focus(&target, cx);
        } else {
            cx.defer(move |cx| {
                let _ = main.update(cx, |_, w, cx| {
                    w.activate_window();
                    w.focus(&target, cx);
                });
            });
        }
        cx.notify();
    }

    /// Closes the torn window (its bounds kept for the next tear-out).
    fn close_torn(&self, torn: AnyWindowHandle, window: &mut Window, cx: &mut App) {
        if torn == window.window_handle() {
            let b = window.bounds();
            set_state(cx, |s| s.torn_bounds = Some(b));
            window.remove_window();
            return;
        }
        cx.defer(move |cx| {
            let _ = torn.update(cx, |_, w, cx| {
                let b = w.bounds();
                set_state(cx, |s| s.torn_bounds = Some(b));
                w.remove_window();
            });
        });
    }

    /// Options `⋯`: Drag out (or Dock) ⌘⇧D, Hide.
    fn options(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let torn = state(cx).torn.is_some();
        let entries = vec![
            MenuItem::new(if torn { "Dock" } else { "Drag Out" })
                .shortcut("⇧⌘D")
                .into(),
            MenuItem::new("Hide").into(),
        ];
        let me = cx.entity().downgrade();
        let at = Anchor::Point(window.mouse_position());
        popups::open_menu(
            Menu::new(entries, at),
            window,
            cx,
            move |choice, window, cx| {
                let _ = me.update(cx, |c, cx| match choice {
                    Some(0) => c.toggle_torn(window, cx),
                    Some(1) => c.hide(window, cx),
                    _ => {}
                });
            },
        );
    }

    /// One `Chat | Terminal` segment (the tool tabs' look: the selected one is the box).
    fn segment(
        &self,
        mode: ColumnMode,
        selected: bool,
        active: bool,
        badge: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let (sel_bg, sel_border) = if active {
            (
                look::TOOLWINDOW_TAB_SELECTED_BG,
                look::TOOLWINDOW_TAB_SELECTED_BORDER,
            )
        } else {
            (
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG,
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER,
            )
        };
        let word = mode.word();
        let id = mode.id();
        let tip = if badge {
            format!("{word} · needs you")
        } else {
            word.to_owned()
        };
        div()
            .id(SharedString::from(format!("column-mode-{id}")))
            .debug_selector(move || {
                if selected {
                    format!("column-mode-{id}-selected")
                } else {
                    format!("column-mode-{id}")
                }
            })
            .flex_none()
            .h(px(look::TOOLWINDOW_TAB_HEIGHT))
            .px(px(look::TOOLWINDOW_TAB_PAD_X - look::TAB_BORDER_WIDTH))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .border_1()
            .text_color(look::TOOLWINDOW_TAB_FG)
            .map(|d| {
                if selected {
                    d.bg(sel_bg).border_color(sel_border)
                } else {
                    d.border_color(gpui_kit::transparent_black())
                        .cursor_pointer()
                        .hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
                }
            })
            .tooltip(crate::kit::tooltip(tip, Some(mode.key())))
            .child(
                div()
                    .relative()
                    .top(px(look::TOOLWINDOW_TEXT_DY))
                    .child(word),
            )
            // the hidden Chat keeps its ◆ while its session needs you (F-Terminal)
            .when(badge, |d| {
                d.child(
                    div()
                        .debug_selector(|| "column-chat-needs-you".into())
                        .text_size(px(9.))
                        .text_color(look::ABE_NEEDS_YOU)
                        .child("◆"),
                )
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |c, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    c.show(mode, true, window, cx);
                }),
            )
    }

    /// Its header draws active (the selected segment's blue box): the column has the keyboard in
    /// an active window (one thing has the keys, docs/agents/native-architecture.md). A
    /// layer takes the keyboard to the Factory view (`Projects::factory_layer`), so none is up.
    pub fn header_active(&self, window: &Window, cx: &App) -> bool {
        self.any_keyboard(window, cx) && crate::editor::window_active(window)
    }

    fn render_header(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let s = state(cx);
        let active = self.header_active(window, cx);
        let needs_you = crate::factory::look_of(&self.scx.project, cx)
            .is_some_and(|l| l.state == crate::factory::WorkspaceState::NeedsYou);
        let chat = self.segment(
            ColumnMode::Chat,
            s.mode_now() == ColumnMode::Chat,
            active,
            needs_you && s.mode_now() != ColumnMode::Chat,
            cx,
        );
        let terminal = self.segment(
            ColumnMode::Terminal,
            s.mode_now() == ColumnMode::Terminal,
            active,
            false,
            cx,
        );
        let me = cx.entity().downgrade();
        let options = IconButton::new("column-options", IconName::MoreVertical)
            .tooltip("Options", None)
            .on_click(move |_, window, cx| {
                let _ = me.update(cx, |c, cx| c.options(window, cx));
            });
        let me = cx.entity().downgrade();
        let hide = IconButton::new("column-hide", IconName::Close)
            .tooltip("Hide", None)
            .on_click(move |_, window, cx| {
                let _ = me.update(cx, |c, cx| c.hide(window, cx));
            });
        div()
            .debug_selector(|| "column-header".into())
            .flex_none()
            .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
            .w_full()
            .border_b_1()
            .border_color(look::TOOLWINDOW_HEADER_BORDER)
            .flex()
            .items_center()
            .gap(px(look::TOOLWINDOW_TAB_GAP))
            .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
            .pr(px(look::TOOLWINDOW_ACTIONS_PAD_RIGHT))
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
            .child(chat)
            .child(terminal)
            .child(div().flex_1())
            .child(
                div()
                    .debug_selector(|| "column-options".into())
                    .child(options),
            )
            .child(div().debug_selector(|| "column-hide".into()).child(hide))
    }

    /// Chat mode: the bridge's `chat` slot (or the placeholder) inside the column's keyboard.
    fn render_chat(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let content = match &self.chat {
            // cached: drawn again only when the slot's view says so (never for the Board's frames
            // or the status line's clock)
            Some(c) => crate::factory::SlotView::hosted(&c.view, cx),
            None => placeholder().into_any_element(),
        };
        div()
            .id("column-chat")
            .debug_selector(|| "column-chat".into())
            .track_focus(&self.focus)
            .flex_1()
            .min_h(px(0.))
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|c, _: &MouseDownEvent, window, cx| {
                    if !c.focus.contains_focused(window, cx) {
                        let target = c.target(ColumnMode::Chat, cx);
                        window.focus(&target, cx);
                    }
                }),
            )
            // before the bridge's slot (it takes every key it is given): the window's global ⌘ keys
            // go to nvim as from any surface. Esc is the slot's screen's first (its menu, card or
            // pick closes); the screen answers `unhandled` when it had nothing open, and only then
            // does the keyboard go back to the code ([`ChatColumn::esc_not_taken`]). With no
            // bridge (the placeholder) or before its screen is drawn, Esc goes back at once.
            .capture_key_down(cx.listener(|c, ev: &KeyDownEvent, window, cx| {
                let k = &ev.keystroke;
                let m = k.modifiers;
                if c.chat.is_some()
                    && (crate::editor::input::forward_from_surface(CHAT, k, cx) || window_key(k))
                {
                    cx.stop_propagation();
                    if let Some(ws) = c.scx.workspace.upgrade() {
                        let editor = ws.read(cx).editor().clone();
                        editor.update(cx, |e, cx| e.on_key_down(ev, cx));
                    }
                    return;
                }
                if k.key == "escape"
                    && !(m.platform || m.control || m.alt || m.shift)
                    && c.chat.as_ref().is_none_or(|chat| !(chat.mounted)(cx))
                {
                    cx.stop_propagation();
                    c.back_to_code(window, cx);
                }
            }))
            .child(content)
    }
}

/// Chat mode until the bridge's `chat` slot is mounted (t119a).
fn placeholder() -> impl IntoElement {
    div()
        .debug_selector(|| "column-chat-placeholder".into())
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .px(px(24.))
        .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child("This workspace's Chat shows here")
        .child("The agent's Claude Code is under Terminal")
}

/// The torn window's title: `Chat · #2 The cart total ignores quantity` (the workspace's story,
/// else its name).
pub fn torn_title(project: &Path, cx: &App) -> String {
    let name = crate::factory::look_of(project, cx)
        .map(|l| l.tab.clone())
        .unwrap_or_else(|| super::pane::name(project, cx));
    format!("Chat · {name}")
}

impl Focusable for ChatColumn {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ChatColumn {
    /// Chat mode draws the bridge's `chat` slot (else the placeholder).
    pub fn has_chat(&self) -> bool {
        self.chat.is_some()
    }
}

impl Render for ChatColumn {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // the keyboard asked for before this draw (`keys_wanted`), or given to the column
        // before its content came: the content's, so its screen hears it has the keys
        if std::mem::take(&mut self.keys_wanted)
            || (self.chat.is_some() && self.focus.is_focused(window))
        {
            let target = self.target(ColumnMode::Chat, cx);
            window.focus(&target, cx);
        }
        let header = self.render_header(window, cx);
        // both modes are the `chat` slot's (Terminal mode: its attached session)
        let body = self.render_chat(cx);
        div()
            .id("chat-column")
            .debug_selector(|| "chat-column".into())
            .size_full()
            .flex()
            .flex_col()
            .bg(look::PANEL_BG)
            .text_color(look::TEXT)
            .child(header)
            .child(body)
    }
}

/// The window's keys the column keeps from the bridge's `chat` besides the global ⌘ keys: ⌘1–⌘7 and
/// ⌥⌘⏎ (maximize); they go on as from any surface.
fn window_key(k: &gpui_kit::Keystroke) -> bool {
    let m = k.modifiers;
    if !m.platform || m.control || m.shift {
        return false;
    }
    if m.alt {
        return k.key == "enter";
    }
    matches!(k.key.as_str(), "1" | "2" | "3" | "4" | "5" | "6" | "7")
}

/// The torn-out Chat (⌘⇧D, C-DragOut): the shown workspace's column filling a window of its own,
/// a dim `Dock ⌘⇧D puts it back` under it. Its keys: ⌘⇧D docks, ⌘4 and ⌃⌘← ⌃⌘→ the modes;
/// closing it docks the column.
pub struct TornChat {
    /// The column that tore out (a bare workspace's; with a projects window, the shown one's).
    /// Weak: a closed project's column (its terminals' PTYs) is not kept alive by this window.
    origin: WeakEntity<ChatColumn>,
    /// The column drawn at the last frame (a project switch: the keyboard follows to the new one).
    drawn: Option<gpui_kit::EntityId>,
    title: String,
}

impl TornChat {
    fn new(origin: WeakEntity<ChatColumn>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // closing it docks the column (its bounds kept)
        window.on_window_should_close(cx, |w, cx| {
            let b = w.bounds();
            set_state(cx, |s| {
                s.torn = None;
                s.torn_bounds = Some(b);
            });
            true
        });
        cx.observe_global::<ColumnState>(|_, cx| cx.notify())
            .detach();
        TornChat {
            origin,
            drawn: None,
            title: String::new(),
        }
    }

    /// The column it draws: the shown workspace's (it follows a switch), else the one that tore.
    pub fn column(&self, cx: &App) -> Option<Entity<ChatColumn>> {
        super::projects::active_workspace(cx)
            .map(|ws| ws.read(cx).column().clone())
            .or_else(|| self.origin.upgrade())
    }

    fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        if let Some(key) = ColumnKey::of(k, cx) {
            cx.stop_propagation();
            if let Some(column) = self.column(cx) {
                column.update(cx, |c, cx| key.run(c, window, cx));
            }
            return;
        }
        // ⌥⌘⏎ maximizes an island of the main window: nothing here
        if super::projects::is_key(k) {
            cx.stop_propagation();
            return;
        }
        // ⌃⌥L jumps from here, as from the docked Chat
        if let Some(true) = crate::editor::input::jump_of(k)
            && super::projects::jump_from_torn(cx)
        {
            cx.stop_propagation();
            return;
        }
        // the main window's own keys (⌘1, ⌘⌥A, ⌘,, ⌘Q, the rail's ⌘ arrows …): there, which comes to the front
        if crate::editor::input::window_cmd(k, cx)
            || crate::editor::input::global_cmd(k, cx)
            || (k.modifiers.platform && k.modifiers.alt && k.key.eq_ignore_ascii_case("a"))
            || crate::kit::notation_of(k).as_deref() == Some("<D-,>")
        {
            cx.stop_propagation();
            let Some(column) = self.column(cx) else {
                return;
            };
            let main = column.read(cx).main;
            let k = k.clone();
            cx.defer(move |cx| {
                let _ = main.update(cx, |_, w, cx| {
                    w.activate_window();
                    w.dispatch_keystroke(k, cx);
                });
            });
        }
    }
}

impl Render for TornChat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(column) = self.column(cx) else {
            // the column it drew is gone (its project closed): docked, this window closes
            set_state(cx, |s| s.torn = None);
            window.remove_window();
            return div().into_any_element();
        };
        // another project shown: the keyboard here moves to its column
        let id = column.entity_id();
        if self.drawn.is_some_and(|d| d != id) && window.focused(cx).is_some() {
            let target = column.read(cx).target(state(cx).mode_now(), cx);
            window.focus(&target, cx);
        }
        self.drawn = Some(id);
        let project = column.read(cx).scx.project.clone();
        let title = torn_title(&project, cx);
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }
        div()
            .id("torn-chat")
            .debug_selector(|| "torn-chat".into())
            .size_full()
            .flex()
            .flex_col()
            .bg(look::PANEL_BG)
            .font_family(crate::render::UI_FONT)
            .capture_key_down(cx.listener(Self::on_key))
            .child(div().flex_1().min_h(px(0.)).child(column))
            .child(
                div()
                    .debug_selector(|| "torn-chat-footer".into())
                    .flex_none()
                    .h(px(FOOTER_HEIGHT))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_t_1()
                    .border_color(look::TOOLWINDOW_HEADER_BORDER)
                    .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child("Dock ⌘⇧D puts it back"),
            )
            .into_any_element()
    }
}

/// The column's window keys: ⌘4, ⌃⌘← ⌃⌘→, ⌘⇧D, ⌘§ (`input::keymap`'s [`Owner::Window`] rows; ⌘T
/// is Code's panel's Terminal, [`crate::terminal::open`]). ⌘4 with the keys hides it, as every
/// pane key ([`super::PaneKey`]); the modes' keys never do.
///
/// [`Owner::Window`]: crate::editor::input::Owner::Window
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnKey {
    /// ⌘4: the column shown in the mode it is in, its content with the keys; with them, hidden
    /// ([`super::PaneKey::Chat`]).
    Chat,
    /// View › Chat Mode / Claude Code: that mode shown, with the keys, wherever they were.
    Mode(ColumnMode),
    /// ⌃⌘← / ⌃⌘→ typed: [`ColumnKey::Mode`] (Chat / Claude Code) while the column has the keys
    /// or no Code shows (the Board, Run, Card, Boxes, Pipelines: pages without tabs); on Code
    /// with the keys elsewhere, that pane's previous / next tab (`config.focus.cycle_tabs`, as
    /// ⌥⌘← ⌥⌘→: the Terminal's shells, Git's tabs, a diff's files, else the open files, the
    /// tree's too) ([`super::Workspace::column_key`]).
    Arrow(ColumnMode),
    Tear,
    /// ⌘§ (the key left of 1 on an ISO keyboard): Chat on the repo's Abe chat, again back.
    Abe,
}

impl ColumnKey {
    pub fn of(k: &gpui_kit::Keystroke, cx: &App) -> Option<ColumnKey> {
        Self::of_in(crate::editor::input::feel(cx), k)
    }

    /// [`ColumnKey::of`] under `feel` (none of them differ by Feel now).
    pub fn of_in(feel: crate::factory::FeelName, k: &gpui_kit::Keystroke) -> Option<ColumnKey> {
        if super::PaneKey::of_in(feel, k) == Some(super::PaneKey::Chat) {
            return Some(ColumnKey::Chat);
        }
        let m = k.modifiers;
        if !m.platform || m.alt || m.function {
            return None;
        }
        if m.control {
            return match (k.key.as_str(), m.shift) {
                ("left", false) => Some(ColumnKey::Arrow(ColumnMode::Chat)),
                ("right", false) => Some(ColumnKey::Arrow(ColumnMode::Terminal)),
                _ => None,
            };
        }
        match (k.key.to_lowercase().as_str(), m.shift) {
            ("d", true) => Some(ColumnKey::Tear),
            // the ISO key left of 1, as the layout names it (§ on Swedish and US ISO keyboards)
            ("§", false) => Some(ColumnKey::Abe),
            _ => None,
        }
    }

    /// ⌃⌘← / ⌃⌘→'s step through the tabs of the pane with the keys, when it has them (-1 / 1).
    pub fn tabs(self) -> Option<i64> {
        match self {
            ColumnKey::Arrow(ColumnMode::Chat) => Some(-1),
            ColumnKey::Arrow(ColumnMode::Terminal) => Some(1),
            _ => None,
        }
    }

    pub fn run(self, c: &mut ChatColumn, window: &mut Window, cx: &mut Context<ChatColumn>) {
        match self {
            ColumnKey::Chat => {
                let keys = c.any_keyboard(window, cx);
                match super::PaneState::of(state(cx).shown(), keys).act() {
                    super::PaneAct::Hide => c.hide(window, cx),
                    _ => c.show(state(cx).mode_now(), true, window, cx),
                }
            }
            ColumnKey::Mode(mode) | ColumnKey::Arrow(mode) => c.show(mode, true, window, cx),
            ColumnKey::Tear => c.toggle_torn(window, cx),
            ColumnKey::Abe => c.abe(window, cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_column_starts_shown_except_in_a_narrow_window_and_keeps_its_width() {
        assert!(open_by_default(1440.));
        assert!(open_by_default(900.));
        assert!(!open_by_default(899.));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_width(Some(dir.path())), None);
        let s = ColumnState::at_start(1440., Some(dir.path()));
        assert_eq!((s.open, s.width, s.torn), (true, CHAT_WIDTH, None));
        let path = width_file(Some(dir.path()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"{"width":512}"#).unwrap();
        assert_eq!(ColumnState::at_start(800., Some(dir.path())).width, 512.);
        assert!(!ColumnState::at_start(800., Some(dir.path())).open);
        std::fs::write(&path, br#"{"width":9000}"#).unwrap();
        assert_eq!(load_width(Some(dir.path())), Some(CHAT_MAX_WIDTH));
    }

    #[test]
    fn the_settings_apply_once_over_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let start = ColumnState::at_start(1440., Some(dir.path()));
        let off = ChatFeel {
            open_by_default: false,
            width: 500,
        };
        let s = start.with_settings(off, None);
        assert_eq!((s.open, s.factory_open, s.width), (false, false, 500.));
        assert!(!s.settings_pending);
        // applied once: a later Feel (or ⌘4 meanwhile) is the person's
        let opened = ColumnState { open: true, ..s };
        assert_eq!(opened.with_settings(off, None), opened);
        // a width dragged last launch wins; on keeps the window's rule
        let on = ChatFeel::default();
        assert_eq!(start.with_settings(on, Some(512.)).width, 512.);
        assert!(start.with_settings(on, None).open);
        let narrow = ColumnState::at_start(800., Some(dir.path()));
        assert!(!narrow.with_settings(on, None).open);
        // a state set before the window (a test's) is kept
        let preset = ColumnState::default();
        assert_eq!(preset.with_settings(off, None), preset);
    }

    #[test]
    fn docked_width_is_none_hidden_or_torn_out() {
        let mut s = ColumnState {
            open: true,
            ..ColumnState::default()
        };
        assert_eq!(s.docked_width(), Some(CHAT_WIDTH));
        s.open = false;
        assert_eq!(s.docked_width(), None);
    }

    #[test]
    fn the_window_keys_are_cmd_4_ctrl_cmd_arrows_cmd_shift_d_and_cmd_section() {
        use crate::factory::FeelName;
        let k =
            |s: &str| ColumnKey::of_in(FeelName::Vimstorm, &gpui_kit::Keystroke::parse(s).unwrap());
        // ⌘2 is the open file now (nvim's), ⌘4 Chat in its mode, ⌃⌘← / ⌃⌘→ the modes (on Code
        // with the keys in another pane: its tabs, decided once nvim has the keys typed before)
        assert_eq!(k("cmd-2"), None);
        assert_eq!(k("cmd-4"), Some(ColumnKey::Chat));
        assert_eq!(k("ctrl-cmd-left"), Some(ColumnKey::Arrow(ColumnMode::Chat)));
        assert_eq!(
            k("ctrl-cmd-right"),
            Some(ColumnKey::Arrow(ColumnMode::Terminal))
        );
        assert_eq!(ColumnKey::Arrow(ColumnMode::Chat).tabs(), Some(-1));
        assert_eq!(ColumnKey::Arrow(ColumnMode::Terminal).tabs(), Some(1));
        // the menu's Chat Mode / Claude Code, ⌘4, ⌘§: the column's, wherever the keys are
        assert_eq!(ColumnKey::Mode(ColumnMode::Terminal).tabs(), None);
        assert_eq!(ColumnKey::Chat.tabs(), None);
        // ⌥⌘← / ⌥⌘→ are the focused pane's tabs
        assert_eq!(k("alt-cmd-left"), None);
        assert_eq!(k("ctrl-shift-cmd-left"), None);
        // ⌘T is Code's panel's Terminal (crate::terminal::open), not the column's
        assert_eq!(k("cmd-t"), None);
        assert_eq!(k("cmd-shift-d"), Some(ColumnKey::Tear));
        assert_eq!(k("cmd-shift-t"), None);
        assert_eq!(k("cmd-d"), None);
        assert_eq!(k("ctrl-cmd-2"), None);
        assert_eq!(k("cmd-§"), Some(ColumnKey::Abe));
        // the Feel vscode: the same
        let vscode =
            |s: &str| ColumnKey::of_in(FeelName::Vscode, &gpui_kit::Keystroke::parse(s).unwrap());
        assert_eq!(vscode("cmd-t"), None);
        assert_eq!(vscode("cmd-4"), Some(ColumnKey::Chat));
    }
}
