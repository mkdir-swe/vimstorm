//! The look: what the window draws with, as `abe ui bridge`'s `look` shell effect sends
//! it (`core/src/theme/theme.ts` `Look`: the theme's every DS colour token, the density, the fonts).
//! [`apply`] puts it in force everywhere at once: `theme.rs`'s palette and density, the editor and
//! UI font families, the editor font size and ligatures, the terminal's colours; [`tell_nvim`]
//! hands the tokens to each project's nvim (`config/app/look.lua`: highlight groups from
//! `darcula.lua`'s palette). The caller repaints (`cx.refresh_windows()`).
//!
//! A `theme.rs` colour const takes the token of its own name (`FRAME_BG` ↔ `frame-bg`); the few the
//! DS names no token for follow one ([`FOLLOWS`]), so Islands Dark's look is exactly the built-in
//! palette.
//!
//! The palette and the chrome's metrics (`theme.rs`, WebStorm Islands Dark) are this folder's
//! interface as well: `look::BG`, `look::hsla`, `look::density`.

mod theme;

use std::collections::BTreeMap;

use gpui_kit::{App, Global, Rgba};
use rmpv::Value;
use serde::Deserialize;

use crate::nvim::Rpc;
use crate::render;
use crate::terminal as term;

pub use theme::*;

/// The look in force, as the bridge sent it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Look {
    pub theme: LookTheme,
    /// The editor scheme: nvim's `background` and syntax mapping are its; its editor, git,
    /// diff and terminal tokens are in `tokens` already. A bridge older than it sends none (the
    /// theme's own).
    #[serde(default)]
    pub scheme: Option<LookScheme>,
    /// Every DS colour token (kebab name → `#rrggbb` / `#rrggbbaa`), aliases resolved.
    pub tokens: BTreeMap<String, String>,
    pub density: Density,
    pub font: LookFont,
    /// A Settings screen's staged change is in force (OK writes it, Cancel puts the look back).
    pub staged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LookTheme {
    pub slug: String,
    pub name: String,
    pub dark: bool,
    /// Whose capture mapping the syntax colours follow: WebStorm's Darcula or VS Code's
    /// (Dark Modern's); a bridge older than it sends none (Darcula's).
    #[serde(default)]
    pub syntax: Syntax,
}

/// `editor.scheme` as the look names it: the theme's own (`follows`) or a theme named for the
/// editor alone.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LookScheme {
    pub slug: String,
    pub name: String,
    pub dark: bool,
    #[serde(default)]
    pub syntax: Syntax,
    pub follows: bool,
}

impl Look {
    /// The editor's background and capture mapping: the scheme's, else the theme's.
    pub fn editor_colours(&self) -> (bool, Syntax) {
        self.scheme
            .as_ref()
            .map_or((self.theme.dark, self.theme.syntax), |s| (s.dark, s.syntax))
    }
}

/// The editor's capture mapping (`nvim/colors/darcula-contrast.lua`): which groups take the
/// function and type colours.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Syntax {
    /// WebStorm's: function calls plain, primitive types as keywords, type names plain.
    #[default]
    Darcula,
    /// VS Code's: every function name in the function colour, type names and primitives in the
    /// type colour.
    Vscode,
}

impl Syntax {
    fn word(self) -> &'static str {
        match self {
            Syntax::Darcula => "darcula",
            Syntax::Vscode => "vscode",
        }
    }
}

/// `ui.density`: Compact is `theme.rs`'s own metrics, Default WebStorm's default-density ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    Default,
}

/// `ui.font.*`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookFont {
    pub family: String,
    pub size: f32,
    pub editor_family: String,
    pub editor_size: f32,
    pub ligatures: bool,
}

/// How a `theme.rs` colour const the DS has no token for gets a theme's colour.
#[derive(Clone, Copy, Debug)]
pub enum Follow {
    /// The token's colour: in Islands Dark the const's own.
    Same(&'static str),
    /// Its own colour while the token keeps Islands Dark's, else the token's (no token is close
    /// enough to take as it is).
    Near(&'static str),
    /// `token` at `alpha` over `ground`.
    Over {
        token: &'static str,
        alpha: f32,
        ground: &'static str,
    },
    /// Its own in every theme (transparent, white on a filled button).
    Kept,
}

/// The `theme.rs` colour consts no DS token names, and what each follows (the DS usage notes and
/// the consts' own source notes say which).
pub const FOLLOWS: &[(&str, Follow)] = &[
    ("SPEED_SEARCH_BORDER", Follow::Same("popup-border")),
    ("SPEED_SEARCH_FG", Follow::Same("text")),
    ("SPEED_SEARCH_ERROR_FG", Follow::Same("text-error")),
    ("POPUP_SHADOW", Follow::Same("popup-shadow-color")),
    ("TAB_ERROR_UNDERLINE", Follow::Same("text-error")),
    ("TOOLTIP_BORDER", Follow::Same("separator")),
    ("BALLOON_BORDER", Follow::Same("separator")),
    ("BALLOON_SHADOW", Follow::Same("balloon-shadow-color")),
    ("GIT_RENAMED", Follow::Same("git-modified")),
    (
        "TOOLWINDOW_TAB_SELECTED_BG",
        Follow::Same("tab-selected-bg"),
    ),
    (
        "TOOLWINDOW_TAB_SELECTED_BORDER",
        Follow::Same("tab-selected-border"),
    ),
    (
        "TOOLWINDOW_TAB_SELECTED_INACTIVE_BG",
        Follow::Same("tab-selected-inactive-bg"),
    ),
    (
        "TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER",
        Follow::Same("tab-selected-inactive-border"),
    ),
    ("TOOLWINDOW_TAB_HOVER_BG", Follow::Same("tab-hover-bg")),
    ("ACTION_BUTTON_HOVER_BG", Follow::Same("hover-bg")),
    (
        "ACTION_BUTTON_TOGGLED_BG",
        Follow::Same("toolbar-button-pressed-bg"),
    ),
    ("TOOLBAR_SEPARATOR", Follow::Same("separator")),
    ("REPLACE_BAR_BG", Follow::Near("editor-bg")),
    ("REPLACE_BAR_BORDER", Follow::Same("border")),
    ("SPLITTER_LINE", Follow::Same("border")),
    ("BUTTON_BG", Follow::Kept),
    ("BUTTON_PRIMARY_BORDER", Follow::Same("button-primary-bg")),
    ("BUTTON_DISABLED_BG", Follow::Kept),
    ("BUTTON_DANGER_FG", Follow::Kept),
    ("COMMIT_MESSAGE_PLACEHOLDER", Follow::Same("placeholder")),
    ("VCS_REF_OTHER", Follow::Same("vcs-ref-tag")),
    (
        "CLOUD_NOTICE_BG",
        Follow::Over {
            token: "abe-accent",
            alpha: 0.1,
            ground: "editor-bg",
        },
    ),
];

/// A `theme.rs` const's DS token name: `FRAME_BG` → `frame-bg`.
pub fn token_name(rust: &str) -> String {
    rust.to_ascii_lowercase().replace('_', "-")
}

/// `#rrggbb` or `#rrggbbaa`.
pub fn parse_hex(s: &str) -> Option<Rgba> {
    hex_digits(s).map(|(v, len)| {
        if len == 8 {
            theme::hexa(v)
        } else {
            theme::hex(v)
        }
    })
}

/// The `theme.rs` palette a look gives: each const its token's colour, or what [`FOLLOWS`] says;
/// a token the look lacks (or can't read) keeps the built-in colour.
pub fn palette_of(look: &Look) -> [Rgba; palette::COUNT] {
    let token = |name: &str| look.tokens.get(name).and_then(|v| parse_hex(v));
    // Islands Dark's colour of a token that is a const of its own
    let built_in = |name: &str| {
        palette::NAMES
            .iter()
            .position(|n| token_name(n) == name)
            .map(|i| palette::BUILT_IN[i])
    };
    let mut out = palette::BUILT_IN;
    for (i, name) in palette::NAMES.iter().enumerate() {
        if let Some(c) = token(&token_name(name)) {
            out[i] = c;
            continue;
        }
        let follow = FOLLOWS.iter().find(|(n, _)| n == name).map(|(_, f)| *f);
        let theirs = match follow {
            Some(Follow::Same(t)) => token(t),
            Some(Follow::Near(t)) => token(t).filter(|c| Some(*c) != built_in(t)),
            Some(Follow::Over {
                token: t,
                alpha,
                ground,
            }) => token(t).zip(token(ground)).map(|(c, g)| over(c, alpha, g)),
            Some(Follow::Kept) | None => None,
        };
        if let Some(c) = theirs {
            out[i] = c;
        }
    }
    out
}

/// `c` at `alpha` over the opaque `ground`, in whole 8-bit channels (as the source notes'
/// literals were worked out).
fn over(c: Rgba, alpha: f32, ground: Rgba) -> Rgba {
    let mix = |a: f32, b: f32| ((a * alpha + b * (1. - alpha)) * 255.).round() / 255.;
    Rgba {
        r: mix(c.r, ground.r),
        g: mix(c.g, ground.g),
        b: mix(c.b, ground.b),
        a: 1.,
    }
}

/// The terminal's colours a look gives (the `term-*` tokens, the editor's background and
/// selection); a token the look lacks keeps the built-in colour.
pub fn terminal_of(look: &Look) -> term::Palette {
    // `#rrggbb` (the alpha of `#rrggbbaa` dropped)
    let rgb = |name: &str, had: u32| {
        look.tokens
            .get(name)
            .and_then(|v| hex_digits(v))
            .map_or(had, |(v, len)| if len == 8 { v >> 8 } else { v })
    };
    let mut p = term::BUILT_IN;
    for (i, name) in TERMINAL_ANSI.iter().enumerate() {
        p.ansi[i] = rgb(name, p.ansi[i]);
    }
    p.foreground = rgb("term-fg", p.foreground);
    p.background = rgb("editor-bg", p.background);
    p.selection_bg = rgb("editor-selection-bg", p.selection_bg);
    p.match_bg = rgb("term-find-bg", p.match_bg);
    p.match_current_bg = rgb("term-find-current-bg", p.match_current_bg);
    // a scrim: `#rrggbbaa` only
    p.backdrop = look
        .tokens
        .get("term-float-backdrop")
        .and_then(|v| hex_digits(v))
        .and_then(|(v, len)| (len == 8).then_some(v))
        .unwrap_or(p.backdrop);
    p
}

/// `#rrggbb` / `#rrggbbaa` as its number and its digit count.
fn hex_digits(s: &str) -> Option<(u32, usize)> {
    let h = s.strip_prefix('#')?;
    let v = u32::from_str_radix(h, 16).ok()?;
    matches!(h.len(), 6 | 8).then_some((v, h.len()))
}

/// The ANSI colours' tokens, by index.
pub const TERMINAL_ANSI: [&str; 16] = [
    "term-black",
    "term-red",
    "term-green",
    "term-yellow",
    "term-blue",
    "term-magenta",
    "term-cyan",
    "term-white",
    "term-bright-black",
    "term-bright-red",
    "term-bright-green",
    "term-bright-yellow",
    "term-bright-blue",
    "term-bright-magenta",
    "term-bright-cyan",
    "term-bright-white",
];

/// The look applied last (none: the built-in one).
struct Applied(Look);

impl Global for Applied {}

/// The look in force, once the bridge sent one.
pub fn current(cx: &App) -> Option<&Look> {
    cx.try_global::<Applied>().map(|a| &a.0)
}

/// Puts `look` in force: the palette, the density, the font families and ligatures, the terminal's
/// colours, and the editor font size when the look's changed from the last look's (the default
/// size before the first: the session's ⌃⌘= / ⌃⌘- keep theirs until the look's moves). Returns whether anything changed; the caller tells nvim and repaints.
pub fn apply(look: Look, cx: &mut App) -> bool {
    let had = current(cx);
    if had == Some(&look) {
        return false;
    }
    let size_moved = had.map_or(render::FONT_SIZE, |h| h.font.editor_size) != look.font.editor_size;
    palette::set(palette_of(&look));
    palette::set_dark(look.theme.dark);
    density::set_default(look.density == Density::Default);
    render::set_families(&look.font.editor_family, &look.font.family);
    render::set_ligatures(look.font.ligatures);
    term::set_palette(terminal_of(&look));
    if size_moved {
        render::set_editor_font_size(look.font.editor_size, cx);
    }
    cx.set_global(Applied(look));
    true
}

/// Hands the look in force to one project's nvim (`config.app.look.apply`); nothing before the
/// bridge sent one (nvim keeps `darcula.lua`'s own palette).
pub fn tell_nvim(rpc: &Rpc, cx: &App) {
    let Some(look) = current(cx) else {
        return;
    };
    let tokens = look
        .tokens
        .iter()
        .map(|(k, v)| (Value::from(k.as_str()), Value::from(v.as_str())))
        .collect();
    // the editor scheme's: Darcula on a light UI keeps nvim dark
    let (dark, syntax) = look.editor_colours();
    let payload = Value::Map(vec![
        ("dark".into(), dark.into()),
        ("syntax".into(), syntax.word().into()),
        ("tokens".into(), Value::Map(tokens)),
    ]);
    crate::nvim::lua::call(rpc, "config.app.look", "apply", vec![payload]);
}
