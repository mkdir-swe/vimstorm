//! GPUI key events -> nvim key notation, for native views (lists, popups, fields) that match keys
//! the way the Lua config does (`"ö"`, `"/"`, `"<CR>"`, `"<D-BS>"`, `"<C-D-Left>"`).
//!
//! The translation is the editor's own ([`crate::editor::input::Keys`], Swedish layout included), so a
//! key means the same in a native view as in nvim. `Keys::key_down` leaves text keys to the IME;
//! here they become their typed char instead.

use gpui_kit::{KeyDownEvent, Keystroke};

use crate::editor::input::{Action, Keys};

/// A key in nvim notation as WebStorm shows shortcuts: macOS symbols for named keys and
/// modifiers, in the macOS order ⌃⌥⇧⌘ ("<D-S-x>" -> "⇧⌘x"); other tokens as they are.
pub fn label(token: &str) -> String {
    let Some(inner) = token.strip_prefix('<').and_then(|t| t.strip_suffix('>')) else {
        return token.to_string();
    };
    let parts: Vec<&str> = inner.split('-').collect();
    let (mods, key) = parts.split_at(parts.len() - 1);
    let mut out = String::new();
    for (names, glyph) in [
        (&["C"][..], "⌃"),
        (&["M", "A"], "⌥"),
        (&["S"], "⇧"),
        (&["D"], "⌘"),
    ] {
        if mods.iter().any(|m| names.contains(m)) {
            out.push_str(glyph);
        }
    }
    let known = |m: &&str| ["C", "M", "A", "S", "D"].contains(m);
    if !mods.iter().all(known) {
        return token.to_string();
    }
    out.push_str(match key[0] {
        "LEFT" => "←",
        "RIGHT" => "→",
        "UP" => "↑",
        "DOWN" => "↓",
        "CR" | "ENTER" | "RETURN" => "⏎",
        "SPACE" => "␣",
        "TAB" => "⇥",
        "BS" => "⌫",
        "ESC" => "⎋",
        "DEL" => "⌦",
        k => return format!("{out}{}", if mods.is_empty() { token } else { k }),
    });
    out
}

/// The nvim notation of a key press: named keys and Ctrl / Cmd combos as `<…>`, text keys as the
/// char they type (`"ö"`, `"Ö"`, `"/"` (Shift+7), `"|"` (Option+7); `<` as `"<lt>"`). None for
/// keys that type nothing and have no name (a bare dead key without text).
pub fn notation(event: &KeyDownEvent) -> Option<String> {
    notation_of(&event.keystroke)
}

/// [`notation`] for a keystroke.
pub fn notation_of(keystroke: &Keystroke) -> Option<String> {
    let out = Keys::new().key_down(&KeyDownEvent {
        keystroke: keystroke.clone(),
        is_held: false,
        prefer_character_input: false,
    });
    if let Some(keys) = out.actions.into_iter().find_map(|a| match a {
        Action::Input(keys) => Some(keys),
        _ => None,
    }) {
        return Some(keys);
    }
    let m = keystroke.modifiers;
    if out.to_ime {
        let text = keystroke.key_char.as_deref()?;
        return Some(match text {
            "<" => "<lt>".into(),
            _ => text.into(),
        });
    }
    // Keys swallows Cmd+E (Ghostty's `super+e=ignore`, an editor rule); a view still sees it
    (m.platform && keystroke.key == "e").then(|| "<D-e>".into())
}

/// The text a key types into a search / field (no Ctrl / Cmd, not a named key except Space).
/// Option chars count (`|` `@` `{` on the Swedish layout).
pub fn typed_text(event: &KeyDownEvent) -> Option<String> {
    let k = &event.keystroke;
    if k.modifiers.control || k.modifiers.platform {
        return None;
    }
    if k.key == "space" {
        return Some(" ".into());
    }
    let text = k.key_char.as_deref()?;
    // enter / tab carry "\n" / "\t" as key_char
    (!text.chars().any(char::is_control)).then(|| text.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::input::down;

    const LABELS: &[(&str, &str)] = &[
        ("<LEFT>", "←"),
        ("<D-S-x>", "⇧⌘x"),
        ("<S-D-x>", "⇧⌘x"),
        ("<C-M-S-D-CR>", "⌃⌥⇧⌘⏎"),
        ("<F5>", "<F5>"),
        ("q", "q"),
    ];

    #[test]
    fn labels_put_modifiers_in_mac_order() {
        for (key, want) in LABELS {
            assert_eq!(label(key), *want, "{key}");
        }
    }

    /// GPUI trigger, then its Neovim notation: text keys are their char, the rest named.
    const NOTATIONS: &[(&str, &str)] = &[
        ("ö", "ö"),
        ("shift+ö", "Ö"),
        ("l", "l"),
        ("shift+l", "L"),
        ("shift+digit_7", "/"),
        ("digit_1", "1"),
        ("<", "<lt>"),
        ("shift+<", ">"),
        ("-", "-"),
        ("enter", "<CR>"),
        ("escape", "<Esc>"),
        ("space", "<Space>"),
        ("arrow_up", "<Up>"),
        ("shift+arrow_down", "<S-Down>"),
        ("page_down", "<PageDown>"),
        ("home", "<Home>"),
        ("super+backspace", "<D-BS>"),
        ("super+ctrl+arrow_left", "<C-D-Left>"),
        ("alt+arrow_left", "<M-Left>"),
        ("super+a", "<D-a>"),
        ("super+shift+t", "<D-S-t>"),
        ("super+e", "<D-e>"),
        ("super+enter", "<D-CR>"),
        ("ctrl+n", "<C-n>"),
        ("shift+tab", "<S-Tab>"),
    ];

    #[test]
    fn keys_map_to_their_nvim_notation() {
        for (trigger, want) in NOTATIONS {
            let ev = down(trigger).unwrap_or_else(|| panic!("no key {trigger}"));
            assert_eq!(notation(&ev).as_deref(), Some(*want), "{trigger}");
        }
    }

    /// GPUI trigger, then the text it types into a search (None: a key, not text).
    const TYPED: &[(&str, Option<&str>)] = &[
        ("ö", Some("ö")),
        ("shift+digit_7", Some("/")),
        ("space", Some(" ")),
        ("enter", None),
        ("tab", None),
        ("escape", None),
        ("super+a", None),
        ("ctrl+a", None),
    ];

    #[test]
    fn only_text_keys_type_into_a_search() {
        for (trigger, want) in TYPED {
            assert_eq!(
                typed_text(&down(trigger).unwrap()).as_deref(),
                *want,
                "{trigger}"
            );
        }
    }
}
