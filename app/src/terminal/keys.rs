//! Keys and mouse events as the bytes a shell / TUI expects (xterm encoding): Ctrl+letters as
//! control codes, named keys with xterm modifier parameters (`CSI 1;5A`), application cursor
//! mode (`SS3 A`), F-keys, macOS text keys the Lua terminal mapped (Cmd+Left/Right = line start /
//! end, Cmd+Backspace = kill line, Option+Left/Right = word left / right), and mouse reports
//! (X10 / normal / SGR 1006, buttons, wheel, motion, modifiers).
//!
//! Printable characters (also Option + key: Swedish @ £ $ | [ ] { } \ ~ are Option chars) are not
//! encoded here: they go through the IME (dead keys compose) as text.

use alacritty_terminal::term::TermMode;
use gpui_kit::{Keystroke, Modifiers};

/// The xterm modifier parameter (1 + Shift 1 + Alt 2 + Ctrl 4), None without modifiers.
fn modifier_param(m: Modifiers) -> Option<u8> {
    let p = 1 + m.shift as u8 + 2 * m.alt as u8 + 4 * m.control as u8;
    (p > 1).then_some(p)
}

/// `CSI 1;<m><final>` / `CSI <final>` / `SS3 <final>` for cursor-style keys.
fn cursor_key(final_char: char, m: Modifiers, app_cursor: bool) -> Vec<u8> {
    match modifier_param(m) {
        Some(p) => format!("\x1b[1;{p}{final_char}").into_bytes(),
        None if app_cursor => format!("\x1bO{final_char}").into_bytes(),
        None => format!("\x1b[{final_char}").into_bytes(),
    }
}

/// `CSI <n>~` / `CSI <n>;<m>~`.
fn tilde_key(n: u8, m: Modifiers) -> Vec<u8> {
    match modifier_param(m) {
        Some(p) => format!("\x1b[{n};{p}~").into_bytes(),
        None => format!("\x1b[{n}~").into_bytes(),
    }
}

/// The control code for Ctrl + `ch`.
fn control_code(ch: char) -> Option<u8> {
    Some(match ch {
        'a'..='z' => ch as u8 - b'a' + 1,
        '@' | ' ' | '2' => 0,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '-' | '7' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

/// The bytes for a key press in the terminal's current modes: the kitty keyboard protocol's
/// CSI-u forms when the app pushed it (`CSI > flags u`, as nvim's :terminal supports), else the
/// legacy xterm encoding ([`encode`]).
pub fn encode_in(k: &Keystroke, mode: TermMode) -> Option<Vec<u8>> {
    if mode.intersects(TermMode::KITTY_KEYBOARD_PROTOCOL)
        && !k.modifiers.platform
        && let Some(bytes) = kitty(k, mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC))
    {
        return Some(bytes);
    }
    encode(k, mode.contains(TermMode::APP_CURSOR))
}

/// Kitty's "disambiguate escape codes": Esc always, Enter / Tab / Backspace with modifiers,
/// Ctrl + a text key, as `CSI <code>[;<mods>] u` (Shift+Enter = `CSI 13;2u`, Ctrl+I apart from
/// Tab). `all`: "report all keys as escape codes" (Enter / Tab / Backspace / Space plain too).
/// Arrows, Home/End, F-keys keep their legacy CSI forms (the protocol's own). Option + key stays
/// text (the IME's Option chars), as without the protocol.
fn kitty(k: &Keystroke, all: bool) -> Option<Vec<u8>> {
    let m = k.modifiers;
    let mods = 1 + m.shift as u32 + 2 * m.alt as u32 + 4 * m.control as u32;
    let (code, send) = match k.key.as_str() {
        "escape" => (27, true),
        "enter" => (13, mods > 1 || all),
        "tab" => (9, mods > 1 || all),
        "backspace" => (127, mods > 1 || all),
        "space" => (32, m.control || all),
        key => {
            let mut chars = key.chars();
            let (Some(ch), None) = (chars.next(), chars.next()) else {
                return None;
            };
            if !m.control || !ch.is_ascii_graphic() {
                return None;
            }
            (ch.to_ascii_lowercase() as u32, true)
        }
    };
    if !send {
        return None;
    }
    Some(if mods > 1 {
        format!("\x1b[{code};{mods}u").into_bytes()
    } else {
        format!("\x1b[{code}u").into_bytes()
    })
}

/// The bytes for a key press, None when it isn't a terminal key (text for the IME, a Cmd
/// shortcut for nvim / the view).
pub fn encode(k: &Keystroke, app_cursor: bool) -> Option<Vec<u8>> {
    let m = k.modifiers;
    // macOS text keys: Cmd+arrows / Cmd+Backspace as the line-editing bytes Ghostty sent
    if m.platform {
        if m.control || m.alt || m.shift {
            return None;
        }
        return match k.key.as_str() {
            "left" => Some(vec![0x01]),
            "right" => Some(vec![0x05]),
            "backspace" => Some(vec![0x15]),
            _ => None,
        };
    }
    let named = match k.key.as_str() {
        "enter" => Some(if m.alt {
            b"\x1b\r".to_vec()
        } else {
            b"\r".to_vec()
        }),
        "escape" => Some(if m.alt {
            b"\x1b\x1b".to_vec()
        } else {
            b"\x1b".to_vec()
        }),
        "tab" if m.shift => Some(b"\x1b[Z".to_vec()),
        "tab" => Some(b"\t".to_vec()),
        "backspace" if m.control => Some(vec![0x08]),
        "backspace" if m.alt => Some(b"\x1b\x7f".to_vec()),
        "backspace" => Some(vec![0x7f]),
        "space" if m.control => Some(vec![0]),
        // Option+Left / Right: word moves (macOS terminals' ESC b / ESC f)
        "left" if m.alt && !m.shift && !m.control => Some(b"\x1bb".to_vec()),
        "right" if m.alt && !m.shift && !m.control => Some(b"\x1bf".to_vec()),
        "up" => Some(cursor_key('A', m, app_cursor)),
        "down" => Some(cursor_key('B', m, app_cursor)),
        "right" => Some(cursor_key('C', m, app_cursor)),
        "left" => Some(cursor_key('D', m, app_cursor)),
        "home" => Some(cursor_key('H', m, app_cursor)),
        "end" => Some(cursor_key('F', m, app_cursor)),
        "pageup" => Some(tilde_key(5, m)),
        "pagedown" => Some(tilde_key(6, m)),
        "insert" => Some(tilde_key(2, m)),
        "delete" => Some(tilde_key(3, m)),
        "f1" => Some(cursor_key('P', m, true)),
        "f2" => Some(cursor_key('Q', m, true)),
        "f3" => Some(cursor_key('R', m, true)),
        "f4" => Some(cursor_key('S', m, true)),
        key => key
            .strip_prefix('f')
            .and_then(|n| n.parse::<u8>().ok())
            .and_then(|n| {
                let code = match n {
                    5 => 15,
                    6 => 17,
                    7 => 18,
                    8 => 19,
                    9 => 20,
                    10 => 21,
                    11 => 23,
                    12 => 24,
                    13 => 25,
                    14 => 26,
                    15 => 28,
                    16 => 29,
                    17 => 31,
                    18 => 32,
                    19 => 33,
                    20 => 34,
                    _ => return None,
                };
                Some(tilde_key(code, m))
            }),
    };
    if named.is_some() {
        return named;
    }
    if !m.control {
        // printable: the IME types it (Option chars too)
        return None;
    }
    let mut chars = k.key.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return None;
    };
    let code = control_code(ch.to_ascii_lowercase())?;
    Some(if m.alt { vec![0x1b, code] } else { vec![code] })
}

/// A mouse button as the report codes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    /// Motion with no button held (mode 1003).
    None,
    WheelUp,
    WheelDown,
}

/// What happened with the button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind {
    Press,
    Release,
    Motion,
}

/// The report for a mouse event at cell (col, row) (0-based), `sgr`: SGR 1006 encoding, else the
/// normal encoding (`utf8`: mode 1005's UTF-8 coordinates). None when the normal encoding can't
/// carry the position.
pub fn mouse_report(
    button: MouseButton,
    kind: MouseKind,
    col: usize,
    row: usize,
    m: Modifiers,
    sgr: bool,
    utf8: bool,
) -> Option<Vec<u8>> {
    let mut code: u32 = match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::None => 3,
        MouseButton::WheelUp => 64,
        MouseButton::WheelDown => 65,
    };
    if kind == MouseKind::Motion {
        code += 32;
    }
    if m.shift {
        code += 4;
    }
    if m.alt {
        code += 8;
    }
    if m.control {
        code += 16;
    }
    let (x, y) = (col + 1, row + 1);
    if sgr {
        let end = if kind == MouseKind::Release { 'm' } else { 'M' };
        return Some(format!("\x1b[<{code};{x};{y}{end}").into_bytes());
    }
    if kind == MouseKind::Release {
        // the normal encoding has no button for releases: 3
        code = (code & !3) | 3;
    }
    let mut out = b"\x1b[M".to_vec();
    out.push((32 + code) as u8);
    for v in [x, y] {
        let v = 32 + v;
        if utf8 {
            let ch = char::from_u32(v as u32)?;
            let mut buf = [0; 4];
            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        } else {
            if v > 255 {
                return None;
            }
            out.push(v as u8);
        }
    }
    Some(out)
}

/// Text for the shell as a paste: bracketed (`ESC[200~ … ESC[201~`, the end marker stripped from
/// the text) when the app asked for it, line breaks as CR either way.
pub fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if bracketed {
        let clean = text.replace("\x1b[201~", "");
        format!("\x1b[200~{clean}\x1b[201~").into_bytes()
    } else {
        text.replace('\x1b', "").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: TermMode = TermMode::empty();
    const APP_CURSOR: TermMode = TermMode::APP_CURSOR;
    const KITTY: TermMode = TermMode::DISAMBIGUATE_ESC_CODES;
    const KITTY_ALL: TermMode =
        TermMode::DISAMBIGUATE_ESC_CODES.union(TermMode::REPORT_ALL_KEYS_AS_ESC);

    /// (GPUI keystroke, the terminal's mode, the bytes the shell gets; None: text for the IME
    /// or a key the window keeps)
    const KEYS: &[(&str, TermMode, Option<&[u8]>)] = &[
        // control letters and named keys
        ("ctrl-c", LEGACY, Some(&[3])),
        ("ctrl-d", LEGACY, Some(&[4])),
        ("ctrl-shift-a", LEGACY, Some(&[1])),
        ("ctrl-alt-x", LEGACY, Some(&[0x1b, 0x18])),
        ("ctrl-space", LEGACY, Some(&[0])),
        ("enter", LEGACY, Some(b"\r")),
        ("backspace", LEGACY, Some(&[0x7f])),
        ("shift-tab", LEGACY, Some(b"\x1b[Z")),
        ("escape", LEGACY, Some(&[0x1b])),
        ("a", LEGACY, None),
        // Option chars are text
        ("alt-2", LEGACY, None),
        // cursor keys, their modes and modifiers
        ("up", LEGACY, Some(b"\x1b[A")),
        ("up", APP_CURSOR, Some(b"\x1bOA")),
        ("shift-up", LEGACY, Some(b"\x1b[1;2A")),
        ("ctrl-right", LEGACY, Some(b"\x1b[1;5C")),
        ("alt-left", LEGACY, Some(b"\x1bb")),
        ("alt-right", LEGACY, Some(b"\x1bf")),
        ("home", LEGACY, Some(b"\x1b[H")),
        ("pageup", LEGACY, Some(b"\x1b[5~")),
        ("shift-delete", LEGACY, Some(b"\x1b[3;2~")),
        ("f1", LEGACY, Some(b"\x1bOP")),
        ("f5", LEGACY, Some(b"\x1b[15~")),
        ("ctrl-f12", LEGACY, Some(b"\x1b[24;5~")),
        // Mac text keys as line editing bytes; Cmd shortcuts stay the window's
        ("cmd-left", LEGACY, Some(&[1])),
        ("cmd-right", LEGACY, Some(&[5])),
        ("cmd-backspace", LEGACY, Some(&[0x15])),
        ("cmd-t", LEGACY, None),
        ("cmd-shift-t", LEGACY, None),
        // the kitty protocol disambiguates only when the shell asks for it
        ("shift-enter", KITTY, Some(b"\x1b[13;2u")),
        ("enter", KITTY, Some(b"\r")),
        ("escape", KITTY, Some(b"\x1b[27u")),
        ("ctrl-i", KITTY, Some(b"\x1b[105;5u")),
        ("tab", KITTY, Some(b"\t")),
        ("ctrl-c", KITTY, Some(b"\x1b[99;5u")),
        ("up", KITTY, Some(b"\x1b[A")),
        ("a", KITTY, None),
        ("enter", KITTY_ALL, Some(b"\x1b[13u")),
        ("shift-enter", LEGACY, Some(b"\r")),
    ];

    #[test]
    fn a_key_sends_its_bytes_in_the_terminal_s_mode() {
        for &(key, mode, want) in KEYS {
            let k = Keystroke::parse(key).unwrap();
            assert_eq!(encode_in(&k, mode).as_deref(), want, "{key} in {mode:?}");
        }
    }

    /// (button, kind, col, row, SGR, the report)
    type Report = (
        MouseButton,
        MouseKind,
        usize,
        usize,
        bool,
        Option<&'static [u8]>,
    );

    const MOUSE: &[Report] = &[
        (
            MouseButton::Left,
            MouseKind::Press,
            4,
            2,
            true,
            Some(b"\x1b[<0;5;3M"),
        ),
        (
            MouseButton::Left,
            MouseKind::Release,
            4,
            2,
            true,
            Some(b"\x1b[<0;5;3m"),
        ),
        (
            MouseButton::Left,
            MouseKind::Motion,
            0,
            0,
            true,
            Some(b"\x1b[<32;1;1M"),
        ),
        (
            MouseButton::WheelDown,
            MouseKind::Press,
            0,
            0,
            true,
            Some(b"\x1b[<65;1;1M"),
        ),
        (
            MouseButton::Left,
            MouseKind::Press,
            0,
            0,
            false,
            Some(&[0x1b, b'[', b'M', 32, 33, 33]),
        ),
        (
            MouseButton::Right,
            MouseKind::Release,
            0,
            0,
            false,
            Some(&[0x1b, b'[', b'M', 35, 33, 33]),
        ),
        // past the legacy encoding's reach
        (MouseButton::Left, MouseKind::Press, 300, 0, false, None),
    ];

    #[test]
    fn mouse_reports_in_sgr_and_legacy() {
        for &(button, kind, col, row, sgr, want) in MOUSE {
            let got = mouse_report(button, kind, col, row, Modifiers::default(), sgr, false);
            assert_eq!(
                got.as_deref(),
                want,
                "{button:?} {kind:?} at {col},{row} sgr {sgr}"
            );
        }
    }

    #[test]
    fn pastes() {
        for (text, bracketed, want) in [
            ("a\nb", false, &b"a\rb"[..]),
            ("a\nb", true, b"\x1b[200~a\rb\x1b[201~"),
            ("x\x1b[201~y", true, b"\x1b[200~xy\x1b[201~"),
        ] {
            assert_eq!(
                paste(text, bracketed),
                want,
                "{text:?} bracketed {bracketed}"
            );
        }
    }
}
