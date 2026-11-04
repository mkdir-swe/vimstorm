//! The native pickers' test helpers: their state, waits on it, typing into a field, Shift Shift.

use std::time::Instant;

use gpui_kit::Modifiers;
use vimstorm::search::PickerState;

use super::TIMEOUT;
use super::view::View;

pub const SHIFT: Modifiers = Modifiers {
    shift: true,
    control: false,
    alt: false,
    platform: false,
    function: false,
};
pub const CTRL: Modifiers = Modifiers {
    shift: false,
    control: true,
    alt: false,
    platform: false,
    function: false,
};
pub const NONE: Modifiers = Modifiers {
    shift: false,
    control: false,
    alt: false,
    platform: false,
    function: false,
};

pub fn picker(v: &mut View) -> Option<PickerState> {
    v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
}

/// Waits (pumping the UI: matching and ripgrep run off the UI thread) until `pred` holds.
pub fn wait_picker(v: &mut View, label: &str, pred: impl Fn(&Option<PickerState>) -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let st = picker(v);
        if pred(&st) {
            return;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for: {label}\n--- picker ---\n{st:#?}");
        }
        // nvim's answers and rg's output arrive on other threads and wake the UI
        v.wait_lua("nvim idle", "return true");
    }
}

pub fn is(kind: &'static str) -> impl Fn(&Option<PickerState>) -> bool {
    move |s| s.as_ref().is_some_and(|s| s.kind == kind)
}

pub fn closed(s: &Option<PickerState>) -> bool {
    s.is_none()
}

pub fn query(s: &Option<PickerState>) -> &str {
    s.as_ref().map_or("", |s| s.query.as_str())
}

/// Types text into whatever has the keyboard, one key at a time (Swedish layout triggers).
pub fn type_text(v: &mut View, text: &str) {
    for c in text.chars() {
        let t = match c {
            ' ' => "space".to_string(),
            '/' => "shift+digit_7".to_string(),
            '(' => "shift+digit_8".to_string(),
            '_' => "shift+-".to_string(),
            c if c.is_uppercase() => format!("shift+{}", c.to_lowercase()),
            c => c.to_string(),
        };
        v.key(&t);
    }
}

pub fn shift_shift(v: &mut View) {
    for _ in 0..2 {
        v.modifiers(SHIFT);
        v.modifiers(NONE);
    }
}

/// The current buffer's file name.
pub fn file(v: &View) -> String {
    v.lua("return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':t')")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

pub fn wait_file(v: &mut View, name: &str) {
    v.wait_lua(
        &format!("{name} open in the editor"),
        &format!("return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':t') == '{name}'"),
    );
}

/// Opens `name` in the editor and waits for it.
pub fn edit(v: &mut View, name: &str) {
    v.lua(&format!("vim.cmd.edit('{name}') return true"));
    wait_file(v, name);
}
