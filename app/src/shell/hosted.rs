//! Keyboard bookkeeping of a surface drawn over a host nvim window ([`super::layout::Role`]: the
//! bottom panel's Problems and Terminal; the Git tool window does the same by hand in
//! [`crate::git::window`]). The keyboard follows
//! nvim's current window: while the host is current the surface is the keyboard's home
//! ([`super::KeyboardHome`]), so "back to nvim" (a popup / picker closing, `focus_editor`, Lua's
//! `focus(nil)`) comes back to it; when the host stops being current the keyboard goes to the
//! editor.
//!
//! Steps for a hosted surface (see the workspace's module doc):
//! 1. `HostedFocus::new(&scx, cx.focus_handle())` in `Surface::new`; `Focusable` returns
//!    [`HostedFocus::handle`]; `Render` puts `.track_focus(hosted.handle())` on its root.
//! 2. Its Lua module sends `open {enter}` / `hide` / `focus` (WinEnter on the host) / `blur`
//!    (WinLeave on the host): call [`HostedFocus::open`], [`HostedFocus::hide`],
//!    [`HostedFocus::focus_event`], [`HostedFocus::blur_event`].
//! 3. `.capture_any_mouse_down(..)` on its root: [`HostedFocus::clicked`] then tell Lua to make
//!    the host current (`config.app.<surface>` `enter()`, as `config/app/git.lua`); a bubbling
//!    mouse down nothing inside took: [`HostedFocus::take`] + `cx.stop_propagation()`.
//! 4. Esc etc.: ask Lua to leave the host (Lua's WinLeave then sends `blur`).

use gpui_kit::{App, FocusHandle, Global, Window};

use super::{KeyboardHome, SurfaceCx};

/// How many times the window moved the keys itself (a rail move, Chat, a page): a surface nvim
/// was asked to show with them takes them only if none moved them since ([`HostedFocus::asked`]).
#[derive(Clone, Copy, Default)]
struct KeysMoved(u64);

impl Global for KeysMoved {}

fn keys_moved_now(cx: &App) -> u64 {
    cx.try_global::<KeysMoved>().map_or(0, |k| k.0)
}

/// The window moved the keys itself: an `open {enter}` nvim answers for an older ask leaves them.
pub fn keys_moved(cx: &mut App) {
    let n = keys_moved_now(cx);
    cx.set_global(KeysMoved(n + 1));
}

pub struct HostedFocus {
    focus: FocusHandle,
    home: KeyboardHome,
    editor_focus: FocusHandle,
    open: bool,
    current: bool,
    /// A click made the host current: Lua's `focus` answer leaves the keyboard where the click put
    /// it (a row, a menu it opened). Also set when an `open {enter}` came after the keys moved.
    click_enter: bool,
    /// The window asked nvim to show it with the keys ([`keys_moved`]'s count then).
    asked: Option<u64>,
}

impl HostedFocus {
    pub fn new(scx: &SurfaceCx, focus: FocusHandle) -> Self {
        HostedFocus {
            focus,
            home: scx.home.clone(),
            editor_focus: scx.editor_focus.clone(),
            open: false,
            current: false,
            click_enter: false,
            asked: None,
        }
    }

    /// The window asks nvim to show it with the keys (⌘3, ⌘T): its `open {enter}` takes them only if
    /// the window did not move them meanwhile (⌘⇧2 before nvim answered: Chat keeps them).
    pub fn asked(&mut self, cx: &App) {
        self.asked = Some(keys_moved_now(cx));
    }

    pub fn handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// Lua said the host window is open.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// The host window is nvim's current window (the surface is the keyboard's home).
    pub fn is_current(&self) -> bool {
        self.current
    }

    /// The surface (or an element inside it) has the keyboard.
    pub fn has_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }

    /// Takes the keyboard unless something inside already has it.
    pub fn take(&self, window: &mut Window, cx: &mut App) {
        if !self.has_keyboard(window, cx) {
            window.focus(&self.focus, cx);
        }
    }

    /// The host is (not) nvim's current window: the keyboard's home is (no longer) here. Only
    /// clears a home that's this surface's (another host may have become current first).
    pub fn set_current(&mut self, current: bool) {
        self.current = current;
        if current {
            self.home.set(Some(self.focus.clone()));
        } else {
            self.home.release(&self.focus);
        }
    }

    /// Lua `open {enter}`: shown; `enter`: the host is current and the surface takes the keyboard.
    pub fn open(&mut self, enter: bool, window: &mut Window, cx: &mut App) {
        self.open = true;
        if enter {
            self.set_current(true);
            // the keys moved since the window asked: they stay there, nvim's `focus` answer too
            if self.asked.take().is_some_and(|at| at != keys_moved_now(cx)) {
                self.click_enter = true;
                return;
            }
            self.take(window, cx);
        }
    }

    /// Lua `hide`: not shown, not home; the keyboard back to nvim if it was here. False when it
    /// wasn't open.
    pub fn hide(&mut self, window: &mut Window, cx: &mut App) -> bool {
        if !std::mem::take(&mut self.open) {
            return false;
        }
        self.click_enter = false;
        let had = self.has_keyboard(window, cx);
        self.set_current(false);
        if had {
            self.give_back(window, cx);
        }
        true
    }

    /// Lua `focus` (the host became nvim's current window): home, and the keyboard unless a click
    /// into the surface caused it.
    pub fn focus_event(&mut self, window: &mut Window, cx: &mut App) {
        self.set_current(true);
        if std::mem::take(&mut self.click_enter) {
            return;
        }
        if self.open {
            self.take(window, cx);
        }
    }

    /// Lua `blur` (the host stopped being current): the keyboard back to nvim if it was here.
    pub fn blur_event(&mut self, window: &mut Window, cx: &mut App) {
        self.click_enter = false;
        let had = self.has_keyboard(window, cx);
        self.set_current(false);
        if had {
            self.give_back(window, cx);
        }
    }

    /// Any click into the surface (capture phase): its host becomes current now; the caller tells
    /// Lua (`enter()`), whose `focus` answer then leaves the keyboard alone.
    pub fn clicked(&mut self) {
        if !self.current {
            self.set_current(true);
            self.click_enter = true;
        }
    }

    /// "Back to nvim": the current home (another host's surface) or the editor.
    fn give_back(&self, window: &mut Window, cx: &mut App) {
        let to = self.home.get().unwrap_or_else(|| self.editor_focus.clone());
        window.focus(&to, cx);
    }
}
