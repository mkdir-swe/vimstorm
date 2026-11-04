//! Keyboard: GPUI keystrokes -> nvim notation (contract 3) and native double Shift (contract 2).

use std::time::{Duration, Instant};

use gpui_kit::{KeyDownEvent, Keystroke, Modifiers};

use super::Action;

/// Longest Shift press that still counts as a tap (holding Shift is no tap).
const TAP_MAX: Duration = Duration::from_millis(400);
/// Longest pause between the first tap's release and the second tap's press (WebStorm-like).
const DOUBLE_TAP_GAP: Duration = Duration::from_millis(400);

/// Keyboard state of the focused editor: the double-Shift detector.
#[derive(Debug, Default)]
pub struct Keys {
    shift: ShiftTaps,
}

/// What `on_key_down` does with a key.
#[derive(Debug, Default, PartialEq)]
pub struct KeyOutcome {
    /// Forward these to nvim (may be empty).
    pub actions: Vec<Action>,
    /// The key types text: let it propagate (no `stop_propagation`) so AppKit's IME commits it
    /// through the `ImeHandler`. False: call `cx.stop_propagation()`.
    pub to_ime: bool,
}

impl Keys {
    pub fn new() -> Self {
        Self::default()
    }

    /// A GPUI `KeyDownEvent` (also repeats, `is_held`).
    pub fn key_down(&mut self, event: &KeyDownEvent) -> KeyOutcome {
        let keystroke = &event.keystroke;
        // Shift+key or a key between two taps: no double Shift
        self.shift.interrupt();
        match translate(keystroke) {
            Translation::Keys(keys) => KeyOutcome {
                actions: vec![Action::Input(keys)],
                to_ime: false,
            },
            Translation::Ignore => KeyOutcome::default(),
            Translation::Text => KeyOutcome {
                actions: Vec::new(),
                to_ime: true,
            },
        }
    }

    /// A GPUI `ModifiersChangedEvent` (macOS flagsChanged): double Shift.
    pub fn modifiers_changed(&mut self, modifiers: Modifiers, now: Instant) -> Vec<Action> {
        if self.shift.update(modifiers, now) {
            vec![Action::double_shift()]
        } else {
            Vec::new()
        }
    }

    /// Any mouse button press: Shift+click is no Shift tap.
    pub fn mouse_down(&mut self) {
        self.shift.interrupt();
    }

    /// Window / editor lost focus: a Shift tap before it doesn't count.
    pub fn focus_lost(&mut self) {
        self.shift = ShiftTaps::default();
    }
}

/// Native double-Shift: two Shift taps (press + release alone, short) with nothing in between.
#[derive(Debug, Default)]
struct ShiftTaps {
    down: bool,
    /// When Shift went down alone; None once anything else happened while it was down.
    pressed: Option<Instant>,
    /// Release time of a clean first tap.
    first_tap: Option<Instant>,
}

impl ShiftTaps {
    /// Returns true on the release of the second tap.
    fn update(&mut self, m: Modifiers, now: Instant) -> bool {
        let others = m.control || m.alt || m.platform || m.function;
        match (self.down, m.shift) {
            (false, true) => {
                self.down = true;
                self.pressed = (!others).then_some(now);
                if others
                    || self
                        .first_tap
                        .is_some_and(|t| now.duration_since(t) > DOUBLE_TAP_GAP)
                {
                    self.first_tap = None;
                }
                false
            }
            (true, false) => {
                self.down = false;
                let tap = self
                    .pressed
                    .take()
                    .is_some_and(|p| now.duration_since(p) <= TAP_MAX);
                if !tap || others {
                    self.first_tap = None;
                    false
                } else if self.first_tap.take().is_some() {
                    true
                } else {
                    self.first_tap = Some(now);
                    false
                }
            }
            // another modifier changed while Shift is held, or one was pressed between taps
            _ => {
                if others {
                    self.interrupt();
                }
                false
            }
        }
    }

    fn interrupt(&mut self) {
        self.pressed = None;
        self.first_tap = None;
    }
}

#[derive(Debug, PartialEq)]
enum Translation {
    /// Send this notation with `nvim_input`.
    Keys(String),
    /// Text: AppKit's IME commits it.
    Text,
    /// Swallowed (Ghostty `ignore`).
    Ignore,
}

/// Contract 3. Named keys always go as notation (with every modifier, Alt as `M-`); char keys only
/// with Ctrl or Cmd, everything else is text for the IME (Option chars, Swedish letters, dead keys).
fn translate(keystroke: &Keystroke) -> Translation {
    let m = keystroke.modifiers;
    if let Some(name) = named_key(&keystroke.key) {
        return Translation::Keys(notation(m.control, m.alt, m.platform, m.shift, &name));
    }
    if !m.control && !m.platform {
        return Translation::Text;
    }
    let mut chars = keystroke.key.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        // no single char (layout oddity): leave it to AppKit (menus, IME)
        return Translation::Text;
    };
    // GPUI names a shifted non-ASCII-letter key by the char it types and drops Shift
    // (Cmd+Shift+7 -> "/", Ctrl+Shift+ö -> "Ö"). With Ctrl / Cmd nvim gets the physical key's
    // unshifted char plus S, as Ghostty's kitty encoding did (<C-S-1>, <D-S-7>, <C-S-ö>).
    let (ch, shift) = match unshift(ch) {
        Some(base) => (base, true),
        None => (ch, m.shift),
    };
    // Ghostty's `super+e=ignore`. Cmd+V goes to Lua as <D-v> (config/app.lua pastes through
    // vim.paste, like Ghostty's paste). Ghostty's by-char remaps (super+shift+7 -> <D-/>, super++ ->
    // <D-=>) are gone: nvim gets the physical key; config/app.lua maps <D-S-7> to <D-/> and
    // <D-S-+> to <S-D-=>, webstorm.lua maps <D-+> itself.
    if m.platform && !m.control && !m.alt && !shift && ch == 'e' {
        return Translation::Ignore;
    }
    let name = match ch {
        '<' => "lt".to_string(),
        '\\' => "Bslash".to_string(),
        _ => ch.to_string(),
    };
    Translation::Keys(notation(m.control, m.alt, m.platform, shift, &name))
}

/// `<C-M-D-S-name>`; modifiers in contract 3 order.
fn notation(ctrl: bool, alt: bool, cmd: bool, shift: bool, name: &str) -> String {
    let mut s = String::from("<");
    for (on, prefix) in [(ctrl, "C-"), (alt, "M-"), (cmd, "D-"), (shift, "S-")] {
        if on {
            s.push_str(prefix);
        }
    }
    s.push_str(name);
    s.push('>');
    s
}

/// GPUI's names for non-text keys (gpui-pre-macos `parse_keystroke`) -> nvim key names.
fn named_key(key: &str) -> Option<String> {
    let name = match key {
        "enter" => "CR",
        "escape" => "Esc",
        "tab" => "Tab",
        "backspace" => "BS",
        "delete" => "Del",
        "insert" => "Insert",
        "space" => "Space",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        _ => {
            let n: u8 = key.strip_prefix('f')?.parse().ok()?;
            return (1..=35).contains(&n).then(|| format!("F{n}"));
        }
    };
    Some(name.to_string())
}

/// The unshifted key for a char GPUI reports instead of Shift + key. Uppercase letters for any
/// layout; punctuation for the Swedish layout (GPUI gives no key code to look it up).
fn unshift(ch: char) -> Option<char> {
    if ch.is_uppercase() {
        let mut lower = ch.to_lowercase();
        return match (lower.next(), lower.next()) {
            (Some(l), None) if l != ch => Some(l),
            _ => None,
        };
    }
    let base = match ch {
        '!' => '1',
        '"' => '2',
        '#' => '3',
        '¤' => '4',
        '%' => '5',
        '&' => '6',
        '/' => '7',
        '(' => '8',
        ')' => '9',
        '=' => '0',
        '?' => '+',
        '_' => '-',
        '*' => '\'',
        '>' => '<',
        ';' => ',',
        ':' => '.',
        '°' => '§',
        '^' => '¨',
        '`' => '´',
        _ => return None,
    };
    Some(base)
}

#[cfg(test)]
mod tests {
    use super::super::swedish::down;
    use super::*;

    /// What a key down does.
    #[derive(Debug, Clone, Copy)]
    enum Does {
        /// Goes to the IME as text, sends nothing.
        Text,
        /// Sends this notation to nvim and stops there.
        Sends(&'static str),
        /// Swallowed: no action, no text.
        Nothing,
    }
    use Does::*;

    /// Swedish layout triggers. The `<D-..>` rows from `super+digit_1` to `super+ö` with Ctrl
    /// digits and Cmd+Alt+Z / Cmd+Alt+L are the keys the old Ghostty setup sent nvim, which
    /// Lua's keymap was written for. `super+/` and `super+=` need Shift on this layout, so
    /// `super+shift+7` stands in for them.
    const KEYS: &[(&str, Does)] = &[
        // plain and shifted text, Swedish letters, digits
        ("a", Text),
        ("shift+a", Text),
        ("å", Text),
        ("ä", Text),
        ("ö", Text),
        ("shift+ö", Text),
        ("shift+å", Text),
        ("<", Text),
        ("shift+<", Text),
        ("digit_1", Text),
        ("-", Text),
        ("+", Text),
        ("'", Text),
        ("¨", Text),
        ("´", Text),
        ("shift+¨", Text),
        ("shift+digit_0", Text),
        ("shift+digit_1", Text),
        ("shift+digit_2", Text),
        ("shift+digit_3", Text),
        ("shift+digit_4", Text),
        ("shift+digit_5", Text),
        ("shift+digit_6", Text),
        ("shift+digit_7", Text),
        ("shift+digit_8", Text),
        ("shift+digit_9", Text),
        // Option (+ Shift) types @ £ $ | [ ] { } \ ~ on the Swedish layout
        ("alt+digit_2", Text),
        ("alt+digit_3", Text),
        ("alt+digit_4", Text),
        ("alt+digit_7", Text),
        ("alt+digit_8", Text),
        ("alt+digit_9", Text),
        ("alt+shift+digit_7", Text),
        ("alt+shift+digit_8", Text),
        ("alt+¨", Text),
        ("alt+e", Text),
        // named keys
        ("enter", Sends("<CR>")),
        ("escape", Sends("<Esc>")),
        ("tab", Sends("<Tab>")),
        ("shift+tab", Sends("<S-Tab>")),
        ("backspace", Sends("<BS>")),
        ("delete", Sends("<Del>")),
        ("space", Sends("<Space>")),
        ("shift+space", Sends("<S-Space>")),
        ("arrow_up", Sends("<Up>")),
        ("shift+arrow_up", Sends("<S-Up>")),
        ("shift+arrow_down", Sends("<S-Down>")),
        ("arrow_left", Sends("<Left>")),
        ("arrow_right", Sends("<Right>")),
        ("home", Sends("<Home>")),
        ("end", Sends("<End>")),
        ("page_up", Sends("<PageUp>")),
        ("page_down", Sends("<PageDown>")),
        ("f1", Sends("<F1>")),
        ("f12", Sends("<F12>")),
        ("f20", Sends("<F20>")),
        ("shift+enter", Sends("<S-CR>")),
        // Alt sends only on named keys
        ("alt+enter", Sends("<M-CR>")),
        ("alt+arrow_left", Sends("<M-Left>")),
        ("alt+arrow_right", Sends("<M-Right>")),
        ("alt+backspace", Sends("<M-BS>")),
        ("alt+delete", Sends("<M-Del>")),
        ("alt+tab", Sends("<M-Tab>")),
        ("alt+space", Sends("<M-Space>")),
        ("alt+shift+arrow_up", Sends("<M-S-Up>")),
        // Cmd
        ("super+a", Sends("<D-a>")),
        ("super+b", Sends("<D-b>")),
        ("super+c", Sends("<D-c>")),
        ("super+d", Sends("<D-d>")),
        ("super+f", Sends("<D-f>")),
        ("super+shift+f", Sends("<D-S-f>")),
        ("super+g", Sends("<D-g>")),
        ("super+shift+g", Sends("<D-S-g>")),
        ("super+k", Sends("<D-k>")),
        ("super+shift+k", Sends("<D-S-k>")),
        ("super+l", Sends("<D-l>")),
        ("super+o", Sends("<D-o>")),
        ("super+shift+o", Sends("<D-S-o>")),
        ("super+q", Sends("<D-q>")),
        ("super+r", Sends("<D-r>")),
        ("super+s", Sends("<D-s>")),
        ("super+t", Sends("<D-t>")),
        ("super+shift+t", Sends("<D-S-t>")),
        ("super+v", Sends("<D-v>")),
        ("super+shift+v", Sends("<D-S-v>")),
        ("super+w", Sends("<D-w>")),
        ("super+shift+w", Sends("<D-S-w>")),
        ("super+x", Sends("<D-x>")),
        ("super+z", Sends("<D-z>")),
        ("super+shift+z", Sends("<D-S-z>")),
        ("super+ö", Sends("<D-ö>")),
        ("super+shift+ö", Sends("<D-S-ö>")),
        ("super+ä", Sends("<D-ä>")),
        ("super+digit_1", Sends("<D-1>")),
        ("super+digit_2", Sends("<D-2>")),
        ("super+digit_3", Sends("<D-3>")),
        ("super+shift+digit_7", Sends("<D-S-7>")),
        ("super+shift+7", Sends("<D-S-7>")),
        ("super+-", Sends("<D-->")),
        ("super+shift+-", Sends("<D-S-->")),
        ("super++", Sends("<D-+>")),
        ("super+shift++", Sends("<D-S-+>")),
        ("super+<", Sends("<D-lt>")),
        ("super+shift+<", Sends("<D-S-lt>")),
        ("super+enter", Sends("<D-CR>")),
        ("super+backspace", Sends("<D-BS>")),
        ("super+arrow_left", Sends("<D-Left>")),
        ("super+alt+z", Sends("<M-D-z>")),
        ("super+alt+l", Sends("<M-D-l>")),
        ("super+ctrl+arrow_left", Sends("<C-D-Left>")),
        ("super+ctrl+arrow_right", Sends("<C-D-Right>")),
        ("super+ctrl+enter", Sends("<C-D-CR>")),
        ("super+ctrl+shift+o", Sends("<C-D-S-o>")),
        ("super+e", Nothing),
        // Ctrl
        ("ctrl+a", Sends("<C-a>")),
        ("ctrl+shift+a", Sends("<C-S-a>")),
        ("ctrl+ö", Sends("<C-ö>")),
        ("ctrl+shift+ö", Sends("<C-S-ö>")),
        ("ctrl+shift+l", Sends("<C-S-l>")),
        ("ctrl+tab", Sends("<C-Tab>")),
        ("ctrl+shift+tab", Sends("<C-S-Tab>")),
        ("ctrl+space", Sends("<C-Space>")),
        ("ctrl+digit_1", Sends("<C-1>")),
        ("ctrl+digit_2", Sends("<C-2>")),
        ("ctrl+digit_3", Sends("<C-3>")),
        ("ctrl+digit_4", Sends("<C-4>")),
        ("ctrl+digit_5", Sends("<C-5>")),
        ("ctrl+digit_6", Sends("<C-6>")),
        ("ctrl+digit_7", Sends("<C-7>")),
        ("ctrl+digit_8", Sends("<C-8>")),
        ("ctrl+digit_9", Sends("<C-9>")),
        ("ctrl+shift+digit_1", Sends("<C-S-1>")),
        ("ctrl+shift+digit_2", Sends("<C-S-2>")),
        ("ctrl+shift+digit_3", Sends("<C-S-3>")),
        ("ctrl+shift+digit_4", Sends("<C-S-4>")),
        ("ctrl+shift+digit_5", Sends("<C-S-5>")),
        ("ctrl+shift+digit_6", Sends("<C-S-6>")),
        ("ctrl+shift+digit_7", Sends("<C-S-7>")),
        ("ctrl+shift+digit_8", Sends("<C-S-8>")),
        ("ctrl+shift+digit_9", Sends("<C-S-9>")),
        ("ctrl+arrow_left", Sends("<C-Left>")),
        ("ctrl+<", Sends("<C-lt>")),
        ("ctrl+alt+x", Sends("<C-M-x>")),
        ("ctrl+'", Sends("<C-'>")),
    ];

    #[test]
    fn a_key_types_text_sends_its_notation_or_nothing() {
        for &(trigger, does) in KEYS {
            let event = down(trigger).unwrap_or_else(|| panic!("no key {trigger}"));
            let out = Keys::new().key_down(&event);
            match does {
                Text => {
                    assert!(out.to_ime, "{trigger} should type text: {out:?}");
                    assert!(out.actions.is_empty(), "{trigger}: {out:?}");
                }
                Sends(want) => {
                    assert!(!out.to_ime, "{trigger} went to the IME");
                    // Lua key-state actions may ride along: only the input counts here
                    let sent: Vec<_> = out
                        .actions
                        .iter()
                        .filter(|a| matches!(a, Action::Input(_)))
                        .collect();
                    assert_eq!(sent, [&Action::Input(want.into())], "{trigger}");
                }
                Nothing => assert_eq!(out, KeyOutcome::default(), "{trigger}"),
            }
        }
    }

    /// One input to the double Shift detector, at a time in ms where it has one.
    #[derive(Clone, Copy)]
    enum Step {
        Mods(u64, Modifiers),
        Key(&'static str),
        Click,
        FocusLost,
    }
    use Step::*;

    const NONE: Modifiers = Modifiers {
        shift: false,
        control: false,
        alt: false,
        platform: false,
        function: false,
    };
    const SHIFT: Modifiers = Modifiers {
        shift: true,
        ..NONE
    };
    const CTRL: Modifiers = Modifiers {
        control: true,
        ..NONE
    };
    const CMD: Modifiers = Modifiers {
        platform: true,
        ..NONE
    };
    const CMD_SHIFT: Modifiers = Modifiers {
        platform: true,
        ..SHIFT
    };
    const CTRL_SHIFT: Modifiers = Modifiers {
        control: true,
        ..SHIFT
    };

    /// (name, steps, how often double Shift fires)
    const SHIFT_TAPS: &[(&str, &[Step], usize)] = &[
        (
            "two quick taps",
            &[
                Mods(0, SHIFT),
                Mods(80, NONE),
                Mods(250, SHIFT),
                Mods(330, NONE),
            ],
            1,
        ),
        (
            "a gap at the limit",
            &[
                Mods(0, SHIFT),
                Mods(80, NONE),
                Mods(480, SHIFT),
                Mods(560, NONE),
            ],
            1,
        ),
        (
            "three taps fire once",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Mods(150, SHIFT),
                Mods(200, NONE),
                Mods(300, SHIFT),
                Mods(350, NONE),
            ],
            1,
        ),
        (
            "four taps fire twice",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Mods(150, SHIFT),
                Mods(200, NONE),
                Mods(300, SHIFT),
                Mods(350, NONE),
                Mods(450, SHIFT),
                Mods(500, NONE),
            ],
            2,
        ),
        (
            "slow taps",
            &[
                Mods(0, SHIFT),
                Mods(80, NONE),
                Mods(600, SHIFT),
                Mods(680, NONE),
            ],
            0,
        ),
        (
            "the first press held",
            &[
                Mods(0, SHIFT),
                Mods(700, NONE),
                Mods(800, SHIFT),
                Mods(850, NONE),
            ],
            0,
        ),
        (
            "the second press held",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Mods(150, SHIFT),
                Mods(900, NONE),
            ],
            0,
        ),
        (
            "Shift with a key",
            &[
                Mods(0, SHIFT),
                Key("shift+a"),
                Mods(60, NONE),
                Mods(150, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "a key between taps",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Key("a"),
                Mods(150, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "a click between taps",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Click,
                Mods(150, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "focus lost between taps",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                FocusLost,
                Mods(150, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "Cmd+Shift then Shift",
            &[
                Mods(0, CMD),
                Mods(10, CMD_SHIFT),
                Mods(50, CMD),
                Mods(60, NONE),
                Mods(150, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "Ctrl pressed in the second tap",
            &[
                Mods(0, SHIFT),
                Mods(50, NONE),
                Mods(150, SHIFT),
                Mods(170, CTRL_SHIFT),
                Mods(190, SHIFT),
                Mods(200, NONE),
            ],
            0,
        ),
        (
            "Ctrl alone",
            &[
                Mods(0, CTRL),
                Mods(50, NONE),
                Mods(150, CTRL),
                Mods(200, NONE),
            ],
            0,
        ),
    ];

    /// A modifier change sends nothing but double Shift.
    #[test]
    fn double_shift_fires_on_two_quick_bare_shift_taps() {
        for &(name, steps, fires) in SHIFT_TAPS {
            let mut k = Keys::new();
            let t0 = Instant::now();
            let mut actions = Vec::new();
            for &step in steps {
                match step {
                    Mods(ms, m) => {
                        actions.extend(k.modifiers_changed(m, t0 + Duration::from_millis(ms)))
                    }
                    Key(t) => {
                        k.key_down(&down(t).unwrap());
                    }
                    Click => k.mouse_down(),
                    FocusLost => k.focus_lost(),
                }
            }
            assert!(
                actions.iter().all(|a| *a == Action::double_shift()),
                "{name}: {actions:?}"
            );
            assert_eq!(actions.len(), fires, "{name}");
        }
    }
}
