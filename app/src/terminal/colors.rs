//! The terminal's colors: WebStorm's terminal palette (the 16 ANSI colors, default fore- /
//! background, selection; Darcula Contrast's `BLOCK_TERMINAL_*`), the xterm 256-color
//! cube / gray ramp, and how a cell's attributes (bold, dim, inverse, hidden) resolve to the colors
//! it's drawn in. Colors an app changed with OSC 4 / 10 / 11 (`Term::colors`) win. The consts are
//! Islands Dark's; a look (`crate::look`) puts its own [`Palette`] in force.

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

/// WebStorm's (reworked) terminal ANSI colors: `BLOCK_TERMINAL_*` of Darcula Contrast (the app's
/// own terminal draws them; nvim has no `:terminal`).
pub const ANSI: [u32; 16] = [
    0x000000, 0xf27481, 0x6bcc62, 0xe0ce70, 0x5594fa, 0xc092fa, 0x47ccbd, 0xced0d6, 0x4e5157,
    0xff6b7a, 0x67ff59, 0xffec1a, 0x3399ff, 0xd970ff, 0x40ffe9, 0xffffff,
];

/// Console background (the editor's, `CONSOLE_BACKGROUND_KEY` = editor bg in Darcula Contrast).
pub const BACKGROUND: u32 = 0x1e1f22;
/// Console foreground (`CONSOLE_NORMAL_OUTPUT`, Darcula: M4_WS_LOOK).
pub const FOREGROUND: u32 = 0xbbbbbb;
/// Text selection (`SELECTION_BACKGROUND`).
pub const SELECTION_BG: u32 = 0x214283;
/// Find: every match (`BLOCK_TERMINAL_SEARCH_ENTRY`: bg #FFEA00, black text).
pub const MATCH_BG: u32 = 0xffea00;
pub const MATCH_FG: u32 = 0x000000;
/// Find: the current match (`BLOCK_TERMINAL_CURRENT_SEARCH_ENTRY`: bg #FF941A, black text).
pub const MATCH_CURRENT_BG: u32 = 0xff941a;
pub const MATCH_CURRENT_FG: u32 = 0x000000;
/// WS's terminal enforces this WCAG contrast of text against its background
/// (`enforceMinContrastRatio`, `TerminalUiUtils.ensureContrastRatio`).
pub const MIN_CONTRAST: f32 = 4.5;

/// The terminal's colours a look gives (the DS `term-*` tokens, the editor's background and
/// selection).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub ansi: [u32; 16],
    pub foreground: u32,
    pub background: u32,
    pub selection_bg: u32,
    pub match_bg: u32,
    pub match_current_bg: u32,
    /// The scrim behind the `,G` lazygit float (0xRRGGBBAA).
    pub backdrop: u32,
}

/// Islands Dark's: the consts above.
pub const BUILT_IN: Palette = Palette {
    ansi: ANSI,
    foreground: FOREGROUND,
    background: BACKGROUND,
    selection_bg: SELECTION_BG,
    match_bg: MATCH_BG,
    match_current_bg: MATCH_CURRENT_BG,
    backdrop: BACKDROP,
};

/// The scrim behind the `,G` lazygit float (`term-float-backdrop`): snacks' backdrop 60, the
/// window behind at 60 % (black at 40 %).
pub const BACKDROP: u32 = 0x00000066;

static PALETTE: std::sync::RwLock<Palette> = std::sync::RwLock::new(BUILT_IN);

/// The palette in force.
pub fn palette() -> Palette {
    *PALETTE.read().unwrap_or_else(|e| e.into_inner())
}

/// Puts a look's palette in force; terminals draw with it from their next frame.
pub fn set(p: Palette) {
    *PALETTE.write().unwrap_or_else(|e| e.into_inner()) = p;
}

/// An xterm 256-color index (and the special indices `Colors` uses) in the palette in force.
pub fn indexed(i: usize) -> u32 {
    let p = palette();
    let (fg, bg) = (p.foreground, p.background);
    match i {
        0..=15 => p.ansi[i],
        16..=231 => {
            let i = i - 16;
            let level = |v: usize| if v == 0 { 0 } else { 55 + v as u32 * 40 };
            (level(i / 36) << 16) | (level((i / 6) % 6) << 8) | level(i % 6)
        }
        232..=255 => {
            let v = 8 + (i as u32 - 232) * 10;
            (v << 16) | (v << 8) | v
        }
        // the cursor is the foreground's (CURSOR)
        256 | 258 | 267 => fg,
        257 => bg,
        // dim ANSI colors / dim foreground: halfway to the background (WS's DIM)
        259..=266 => dim(p.ansi[i - 259], bg),
        268 => dim(fg, bg),
        _ => fg,
    }
}

fn to_u32(c: Rgb) -> u32 {
    ((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32
}

pub fn to_rgb(c: u32) -> Rgb {
    Rgb {
        r: (c >> 16) as u8,
        g: (c >> 8) as u8,
        b: c as u8,
    }
}

/// WS's DIM: the average of the text and its background.
pub fn dim(c: u32, bg: u32) -> u32 {
    let f = |s: u32| (((c >> s) & 0xff) + ((bg >> s) & 0xff)) / 2;
    (f(16) << 16) | (f(8) << 8) | f(0)
}

fn luminance(c: u32) -> f32 {
    let lin = |v: u32| {
        let v = v as f32 / 255.;
        if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin((c >> 16) & 0xff) + 0.7152 * lin((c >> 8) & 0xff) + 0.0722 * lin(c & 0xff)
}

fn contrast(a: u32, b: u32) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// WS's `ensureContrastRatio`: text too close to its background steps away from it (darker text
/// toward black, lighter toward white) by a tenth of the remaining distance per channel until the
/// ratio holds; if that end can't reach it, the other direction, whichever contrasts more.
pub fn ensure_contrast(fg: u32, bg: u32) -> u32 {
    if contrast(fg, bg) >= MIN_CONTRAST {
        return fg;
    }
    let walk = |up: bool| {
        let mut c = fg;
        while contrast(c, bg) < MIN_CONTRAST && if up { c != 0xffffff } else { c != 0 } {
            let f = |s: u32| {
                let v = (c >> s) & 0xff;
                if up {
                    v + (255 - v).div_ceil(10)
                } else {
                    v - v.div_ceil(10)
                }
            };
            c = (f(16) << 16) | (f(8) << 8) | f(0);
        }
        c
    };
    let down_first = luminance(fg) < luminance(bg);
    let first = walk(!down_first);
    if contrast(first, bg) >= MIN_CONTRAST {
        return first;
    }
    let other = walk(down_first);
    if contrast(first, bg) > contrast(other, bg) {
        first
    } else {
        other
    }
}

/// Index `i` with the app's OSC overrides.
fn slot(colors: &Colors, i: usize) -> u32 {
    colors[i].map(to_u32).unwrap_or_else(|| indexed(i))
}

/// A cell color as RGB.
pub fn resolve(colors: &Colors, c: Color) -> u32 {
    match c {
        Color::Spec(rgb) => to_u32(rgb),
        Color::Indexed(i) => slot(colors, i as usize),
        Color::Named(n) => slot(colors, n as usize),
    }
}

/// The colors a cell is drawn in: (fg, bg), after dim / inverse / hidden.
pub fn cell_colors(colors: &Colors, fg: Color, bg: Color, flags: Flags) -> (u32, u32) {
    let mut f = resolve(colors, fg);
    if flags.contains(Flags::DIM) {
        f = match fg {
            Color::Named(n) if (n as usize) < 8 => slot(colors, n as usize + 259),
            Color::Named(NamedColor::Foreground) => {
                slot(colors, NamedColor::DimForeground as usize)
            }
            _ => dim(f, resolve(colors, bg)),
        };
    }
    let mut b = resolve(colors, bg);
    if flags.contains(Flags::INVERSE) {
        std::mem::swap(&mut f, &mut b);
    }
    if flags.contains(Flags::HIDDEN) {
        f = b;
    }
    (f, b)
}

/// The default background (an app may have changed it with OSC 11).
pub fn background(colors: &Colors) -> u32 {
    slot(colors, NamedColor::Background as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xterm_cube_and_grays() {
        assert_eq!(indexed(16), 0x000000);
        assert_eq!(indexed(21), 0x0000ff);
        assert_eq!(indexed(196), 0xff0000);
        assert_eq!(indexed(231), 0xffffff);
        assert_eq!(indexed(232), 0x080808);
        assert_eq!(indexed(255), 0xeeeeee);
        assert_eq!(indexed(1), 0xf27481);
    }

    #[test]
    fn attributes_resolve() {
        let c = Colors::default();
        let fg = Color::Named(NamedColor::Red);
        let bg = Color::Named(NamedColor::Background);
        assert_eq!(
            cell_colors(&c, fg, bg, Flags::empty()),
            (ANSI[1], BACKGROUND)
        );
        assert_eq!(
            cell_colors(&c, fg, bg, Flags::INVERSE),
            (BACKGROUND, ANSI[1])
        );
        assert_eq!(
            cell_colors(&c, fg, bg, Flags::DIM).0,
            dim(ANSI[1], BACKGROUND)
        );
        assert_eq!(cell_colors(&c, fg, bg, Flags::HIDDEN).0, BACKGROUND);
        let spec = Color::Spec(Rgb { r: 1, g: 2, b: 3 });
        assert_eq!(cell_colors(&c, spec, bg, Flags::empty()).0, 0x010203);
        // OSC 4 overrides
        let mut c = Colors::default();
        c[1] = Some(Rgb {
            r: 0,
            g: 0xff,
            b: 0,
        });
        assert_eq!(resolve(&c, fg), 0x00ff00);
    }

    #[test]
    fn min_contrast_matches_ws() {
        // M4_WS_LOOK: black and bright black as WS draws them on the console background
        assert_eq!(ensure_contrast(ANSI[0], BACKGROUND), 0x878787);
        assert_eq!(ensure_contrast(ANSI[8], BACKGROUND), 0x8c8e93);
        assert_eq!(ensure_contrast(ANSI[1], BACKGROUND), ANSI[1]);
        assert_eq!(ensure_contrast(FOREGROUND, BACKGROUND), FOREGROUND);
    }
}
