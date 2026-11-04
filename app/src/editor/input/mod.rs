//! Input translation: GPUI key / text / mouse / scroll events -> what nvim gets ([`Action`]).
//!
//! No view or nvim types here: the view (`crate::editor::EditorView`) owns a [`Keys`], an
//! `Rc<RefCell<`[`Ime`]`>>`, a [`ScrollAccumulator`] and a [`SmoothScroll`], feeds them GPUI
//! events and forwards the returned [`Action`]s to nvim (`crate::editor::forward`).
//!
//! # Wiring (GPUI 0.3.9, macOS)
//!
//! 1. Root element of the editor view: `.track_focus(&focus)` plus
//!    - `.on_key_down(|ev, window, cx| ..)`: `let out = keys.key_down(ev);` forward `out.actions`;
//!      unless `out.to_ime`, call `cx.stop_propagation()`. A `to_ime` key (plain / Shift / Option
//!      text, dead keys) must propagate: GPUI then hands it to AppKit's input context, which calls
//!      the [`ImeHandler`] (`insertText` / `setMarkedText`). So a char is sent exactly once:
//!      either as notation by `key_down` or as committed text by the IME, never both.
//!    - `.on_modifiers_changed(..)`: forward `keys.modifiers_changed(ev.modifiers, Instant::now())`
//!      (double Shift).
//!    - `.on_mouse_down(..)`: call `keys.mouse_down()` (a click between Shift taps is no double
//!      Shift), then forward [`Action::mouse`]. Drag: send [`MouseAction::Drag`] only when the
//!      grid cell changes. Hover: [`Action::mouse_move`] (needs `'mousemoveevent'`).
//!    - `.on_scroll_wheel(..)`: trackpad pixels over a window grid go to [`SmoothScroll`] (steps
//!      + a drawn sub-row offset); mouse-wheel lines and the rest to [`ScrollAccumulator`]
//!      (`steps.actions(ev.modifiers, grid, row, col)`). One step = one row / column: nvim runs
//!      with `mousescroll=ver:1,hor:1` (config/app.lua).
//! 2. Every frame, in paint (custom `Element::paint` or a `canvas` paint closure):
//!    `window.handle_input(&focus, ImeHandler::new(ime.clone(), sink.clone()), cx)`. GPUI drops
//!    the handler each frame and only registers it while `focus` is focused. `sink` ([`Sink`])
//!    forwards to nvim (e.g. through a `WeakEntity` of the view) and re-renders: it is also called
//!    with no actions when only the preedit changed. After layout,
//!    `ime.borrow_mut().set_caret_bounds(..)` (window coordinates) places the IME candidate
//!    window; draw [`Ime::marked_text`] at the caret (dead key `¨` `´` `^` `~` .. until the next
//!    key composes or commits it).
//! 3. Focus lost / window deactivated (`cx.observe_window_activation`, `on_focus_out`): forward
//!    `keys.focus_lost()` (cancels a Shift tap) and call
//!    `ime.borrow_mut().clear()`.
//! 4. App-owned shortcuts (fullscreen Ctrl+Cmd+F, font size Ctrl+Cmd+- / =, Cmd+0, hide,
//!    minimize) are GPUI key bindings + menu items (`crate::app`): bindings run before key
//!    listeners, so those keys never reach `key_down`. Every other Cmd key goes to nvim as `<D-…>`.
//!    [`keymap`] lists every shortcut and its owner; [`forward_from_surface`] says which keys a
//!    focused native surface lets through to nvim.
//!
//! Order on macOS (gpui-pre-macos `handle_key_event`): keys without text and without Ctrl/Cmd
//! (arrows, Esc, BS, Del, F-keys) and every key while a preedit exists go to the IME first; it
//! commits pending text and then routes the key to `on_key_down` (doCommandBySelector), so text
//! is forwarded before the key. Other keys reach `on_key_down` first; Cmd / Ctrl ones (via
//! performKeyEquivalent too) are always handled there. Held text keys repeat because
//! [`ImeHandler`] disables press-and-hold.
//!
//! # Forwarding an [`Action`]
//! - `Input(keys)`: `nvim_input(keys)`.
//! - `Lua { code, args }`: `nvim_exec_lua(code, args)` as a notification.
//! - `Mouse { .. }`: `nvim_input_mouse(button, action, modifier, grid, row, col)`.
//!
//! Cmd+V is `<D-v>` like every Cmd key: config/app.lua pastes it through `vim.paste`.

mod ime;
mod keymap;
mod keys;
mod mouse;
mod moves;
mod scroll;
/// Test model of the Swedish layout's GPUI keystrokes (unit and view tests).
#[doc(hidden)]
mod swedish;

pub use ime::{Ime, ImeHandler, Sink};
pub use keymap::{KEYMAP, Owner, VSCODE, feel, forward_from_surface, vscode_took};
pub(crate) use keymap::{feel_ctrl_key, forward_from_surface_in, global_cmd, jump_of, window_cmd};
pub use keys::{KeyOutcome, Keys};
pub use mouse::{MouseAction, ScrollAccumulator, WheelSteps, mouse_modifier};
pub use moves::{MoveGuard, MoveStep};
pub use scroll::SmoothScroll;
#[cfg(any(test, feature = "shots"))]
pub use swedish::typed;
pub use swedish::{down, keystroke, named_keys};

/// Something to send to nvim. See the module doc for the RPC each one maps to.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// `nvim_input(keys)`: nvim key notation, `<` already escaped as `<lt>`.
    Input(String),
    /// `nvim_exec_lua(code, args)`, as a notification.
    Lua {
        code: &'static str,
        args: Vec<rmpv::Value>,
    },
    /// `nvim_input_mouse(button, action, modifier, grid, row, col)`.
    Mouse {
        button: &'static str,
        action: &'static str,
        modifier: String,
        grid: u64,
        row: u64,
        col: u64,
    },
}

/// Contract 2: Shift tapped twice.
const LUA_DOUBLE_SHIFT: &str = "require('config.app').double_shift()";

impl Action {
    fn double_shift() -> Self {
        Action::Lua {
            code: LUA_DOUBLE_SHIFT,
            args: Vec::new(),
        }
    }
}
