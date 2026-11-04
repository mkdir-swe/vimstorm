//! Test model: the `Keystroke` gpui-pre-macos 0.3.9 (`parse_keystroke`) builds for a key press on
//! the Swedish (Mac) layout, from a Ghostty-style trigger like `ctrl+shift+digit_1` or `super+ö`.

use gpui_kit::{KeyDownEvent, Keystroke, Modifiers};

/// (physical name, unshifted, shifted) for the char keys used in tests.
const KEYS: &[(&str, &str, &str)] = &[
    ("digit_1", "1", "!"),
    ("digit_2", "2", "\""),
    ("digit_3", "3", "#"),
    ("digit_4", "4", "¤"),
    ("digit_5", "5", "%"),
    ("digit_6", "6", "&"),
    ("digit_7", "7", "/"),
    ("digit_8", "8", "("),
    ("digit_9", "9", ")"),
    ("digit_0", "0", "="),
    ("+", "+", "?"),
    ("-", "-", "_"),
    ("å", "å", "Å"),
    ("ä", "ä", "Ä"),
    ("ö", "ö", "Ö"),
    ("<", "<", ">"),
    (",", ",", ";"),
    (".", ".", ":"),
    ("'", "'", "*"),
    ("§", "§", "°"),
    // dead keys: UCKeyTranslate gives the accent itself
    ("´", "´", "`"),
    ("¨", "¨", "^"),
];

/// GPUI key names for non-char keys, with the key_char GPUI sets for them.
const NAMED: &[(&str, &str, Option<&str>)] = &[
    ("enter", "enter", Some("\n")),
    ("tab", "tab", Some("\t")),
    ("space", "space", Some(" ")),
    ("escape", "escape", None),
    ("backspace", "backspace", None),
    ("delete", "delete", None),
    ("arrow_up", "up", None),
    ("arrow_down", "down", None),
    ("arrow_left", "left", None),
    ("arrow_right", "right", None),
    ("home", "home", None),
    ("end", "end", None),
    ("page_up", "pageup", None),
    ("page_down", "pagedown", None),
];

/// The names of the non-char keys a trigger can use (`arrow_down`, `page_down`, `enter` …).
pub fn named_keys() -> Vec<&'static str> {
    NAMED.iter().map(|(n, ..)| *n).collect()
}

pub fn down(trigger: &str) -> Option<KeyDownEvent> {
    Some(KeyDownEvent {
        keystroke: keystroke(trigger)?,
        is_held: false,
        prefer_character_input: false,
    })
}

/// None when the trigger's key is no unshifted char or key name on this layout (`super+/`: `/` is
/// Shift+7 here; Ghostty doesn't match such a trigger on Swedish either, hence its `super+shift+7`).
pub fn keystroke(trigger: &str) -> Option<Keystroke> {
    let (mods, key) = match trigger.strip_suffix("++") {
        Some(mods) => (mods, "+"),
        None if trigger == "+" => ("", "+"),
        None => trigger.rsplit_once('+').unwrap_or(("", trigger)),
    };
    let mut m = Modifiers::default();
    for token in mods.split('+').filter(|t| !t.is_empty()) {
        match token {
            "super" => m.platform = true,
            "ctrl" => m.control = true,
            "alt" => m.alt = true,
            "shift" => m.shift = true,
            _ => panic!("modifier {token}"),
        }
    }
    if let Some(&(_, name, key_char)) = NAMED.iter().find(|(n, ..)| *n == key) {
        return Some(Keystroke {
            modifiers: m,
            key: name.into(),
            key_char: key_char.map(Into::into),
        });
    }
    if let Some(n) = key.strip_prefix('f').filter(|n| n.parse::<u8>().is_ok()) {
        return Some(Keystroke {
            modifiers: m,
            key: format!("f{n}"),
            key_char: None,
        });
    }
    let (base, shifted) = physical(key)?;
    // parse_keystroke: Shift stays only for ASCII letters, else the shifted char replaces it
    let typed = if m.shift { &shifted } else { &base };
    let key_char = (!m.control && !m.platform).then(|| typed.clone());
    let key = if m.shift && !base.chars().all(|c| c.is_ascii_lowercase()) {
        m.shift = false;
        shifted
    } else {
        base
    };
    Some(Keystroke {
        modifiers: m,
        key,
        key_char,
    })
}

/// (unshifted, shifted) of the key named `key` or typing it unshifted.
/// The trigger that types `c` on this layout (`:` is `shift+.`, `?` is `shift++`, `A` is
/// `shift+a`), for offscreen shots' typed text and plain-char keys.
#[cfg(any(test, feature = "shots"))]
pub fn typed(c: char) -> Option<String> {
    match c {
        ' ' => return Some("space".into()),
        '\n' => return Some("enter".into()),
        '\t' => return Some("tab".into()),
        c if c.is_ascii_lowercase() || c.is_ascii_digit() => return Some(c.to_string()),
        c if c.is_ascii_uppercase() => return Some(format!("shift+{}", c.to_ascii_lowercase())),
        _ => {}
    }
    let s = c.to_string();
    KEYS.iter().find_map(|&(_, base, shifted)| {
        if base == s {
            Some(base.to_string())
        } else if shifted == s {
            Some(format!("shift+{base}"))
        } else {
            None
        }
    })
}

fn physical(key: &str) -> Option<(String, String)> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && c.is_ascii_lowercase()
    {
        return Some((key.into(), key.to_ascii_uppercase()));
    }
    let &(_, base, shifted) = KEYS.iter().find(|(n, b, _)| *n == key || *b == key)?;
    Some((base.into(), shifted.into()))
}

#[cfg(test)]
#[test]
fn typed_chars_find_their_keys() {
    let t = |c| typed(c).unwrap();
    assert_eq!(
        [
            t('k'),
            t('K'),
            t(':'),
            t('?'),
            t('ö'),
            t('Ö'),
            t('/'),
            t(' '),
            t('7')
        ],
        [
            "k", "shift+k", "shift+.", "shift++", "ö", "shift+ö", "shift+7", "space", "7"
        ]
        .map(String::from)
    );
    assert_eq!(keystroke(&t(':')).unwrap().key_char.as_deref(), Some(":"));
    assert_eq!(typed('€'), None);
}

#[cfg(test)]
#[test]
fn model_matches_gpui_examples() {
    // values from gpui-pre-macos parse_keystroke's logic
    let k = keystroke("super+shift+digit_7").unwrap();
    assert_eq!(
        (k.key.as_str(), k.modifiers.shift, k.key_char),
        ("/", false, None)
    );
    let k = keystroke("super+shift+t").unwrap();
    assert_eq!((k.key.as_str(), k.modifiers.shift), ("t", true));
    let k = keystroke("shift+ö").unwrap();
    assert_eq!((k.key.as_str(), k.key_char.as_deref()), ("Ö", Some("Ö")));
    assert!(keystroke("super+/").is_none());
}
