//! Bundled fonts (install-independent) and the editor font with its fallbacks.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use gpui_kit::{App, Font, FontFallbacks, FontFeatures, FontStyle, FontWeight, font, px};

/// Editor font (WebStorm: JetBrains Mono 13).
pub const EDITOR_FONT: FontName = FontName::Editor;
/// UI font for later milestones (WebStorm New UI: Inter 13).
pub const UI_FONT: FontName = FontName::Ui;
/// WebStorm's file icons at U+10F000.. (`assets/fonts/WebStormIcons.otf`; its build script is in git
/// history before the M5 switch).
pub const ICON_FONT: &str = "WebStorm Icons";
/// Nerd Font glyphs (PUA): the status bar's lock, plugin glyphs in nvim's grids, shell prompts.
/// Not bundled:
/// `~/Library/Fonts`; CoreText's cascade covers a missing one with whatever it finds.
pub const NERD_FONT: &str = "JetBrainsMono Nerd Font Mono";

static BUNDLED: &[&[u8]] = &[
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Bold.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-Italic.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMono-BoldItalic.ttf"),
    // JetBrains Mono at 90 %: the markdown preview's inline code (POLISH-C)
    include_bytes!("../../assets/fonts/JetBrainsMonoInline-Regular.ttf"),
    include_bytes!("../../assets/fonts/JetBrainsMonoInline-Bold.ttf"),
    include_bytes!("../../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../../assets/fonts/Inter-Italic.ttf"),
    // the icon font, so icons don't depend on what's installed
    include_bytes!("../../assets/fonts/WebStormIcons.otf"),
];

/// Registers the bundled fonts with GPUI's text system.
pub fn load_fonts(cx: &App) -> anyhow::Result<()> {
    cx.text_system()
        .add_fonts(BUNDLED.iter().map(|b| Cow::Borrowed(*b)).collect())
}

/// Resolves the fonts the first frame uses on a background thread, while the window opens: the
/// first lookup (CoreText matching, the editor font's fallbacks) took ~11 ms on the UI thread at
/// startup, between the window and nvim's first flush.
pub fn warm_up(cx: &App) {
    let ts = cx.text_system().clone();
    cx.background_executor()
        .spawn(async move {
            for font in [editor_font(false, false), ui_font()] {
                let id = ts.resolve_font(&font);
                let _ = ts.advance(id, px(13.), 'm');
            }
        })
        .detach();
}

/// The editor font in a weight / style, ligatures as the look says ([`editor_features`]: off,
/// WebStorm's default) and fallbacks for glyphs JetBrains Mono lacks.
pub fn editor_font(bold: bool, italic: bool) -> Font {
    Font {
        family: EDITOR_FONT.into(),
        features: editor_features(),
        fallbacks: Some(FontFallbacks::from_fonts(vec![
            ICON_FONT.into(),
            NERD_FONT.into(),
        ])),
        weight: if bold {
            FontWeight::BOLD
        } else {
            FontWeight::NORMAL
        },
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    }
}

/// Font for one non-ASCII cell: icon / Nerd Font code points go straight to their font (the
/// in-memory icon font isn't in CoreText's cascade), everything else to the editor font.
pub fn cell_font(ch: char, bold: bool, italic: bool) -> Font {
    let base = editor_font(bold, italic);
    match ch as u32 {
        0x10F000..=0x10FFFD => Font {
            family: ICON_FONT.into(),
            fallbacks: None,
            ..base
        },
        0xE000..=0xF8FF | 0xF0000..=0xFFFFD => Font {
            family: NERD_FONT.into(),
            ..base
        },
        _ => base,
    }
}

/// Inter, for the chrome in later milestones.
pub fn ui_font() -> Font {
    font(UI_FONT)
}

/// The bundled editor and UI fonts' families: what [`EDITOR_FONT`] and [`UI_FONT`] name until a
/// look names others.
pub const BUNDLED_EDITOR_FAMILY: &str = "JetBrains Mono";
pub const BUNDLED_UI_FAMILY: &str = "Inter";

/// One of the two fonts a look names (`ui.font.editorFamily`, `ui.font.family`): its family is
/// read when drawn, so a look switches it live.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FontName {
    Editor,
    Ui,
}

static FAMILIES: std::sync::RwLock<(&str, &str)> =
    std::sync::RwLock::new((BUNDLED_EDITOR_FAMILY, BUNDLED_UI_FAMILY));

impl FontName {
    /// The family in force.
    pub fn name(self) -> &'static str {
        let f = FAMILIES.read().unwrap_or_else(|e| e.into_inner());
        match self {
            FontName::Editor => f.0,
            FontName::Ui => f.1,
        }
    }
}

impl From<FontName> for gpui_kit::SharedString {
    fn from(f: FontName) -> Self {
        f.name().into()
    }
}

impl std::fmt::Display for FontName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// Puts these families in force (a family other than the bundled ones is leaked: a font change
/// is rare). Returns whether they changed.
pub fn set_families(editor: &str, ui: &str) -> bool {
    let mut f = FAMILIES.write().unwrap_or_else(|e| e.into_inner());
    if f.0 == editor && f.1 == ui {
        return false;
    }
    let keep = |s: &str, had: &'static str| -> &'static str {
        match s {
            _ if s == had => had,
            BUNDLED_EDITOR_FAMILY => BUNDLED_EDITOR_FAMILY,
            BUNDLED_UI_FAMILY => BUNDLED_UI_FAMILY,
            _ => Box::leak(s.to_owned().into_boxed_str()),
        }
    };
    if f.0 != editor {
        GENERATION.fetch_add(1, Ordering::Relaxed);
    }
    *f = (keep(editor, f.0), keep(ui, f.1));
    true
}

static LIGATURES: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU32 = AtomicU32::new(0);

/// Puts the editor font's ligatures on or off (`ui.font.ligatures`). Returns whether it changed.
pub fn set_ligatures(on: bool) -> bool {
    let changed = LIGATURES.swap(on, Ordering::Relaxed) != on;
    if changed {
        GENERATION.fetch_add(1, Ordering::Relaxed);
    }
    changed
}

/// The editor font's features: ligatures off unless the look turned them on. The editor's mono
/// text everywhere (docs, diffs, transcripts) draws with these.
pub fn editor_features() -> FontFeatures {
    if LIGATURES.load(Ordering::Relaxed) {
        FontFeatures::default()
    } else {
        FontFeatures::disable_ligatures()
    }
}

/// Counts the editor font's changes (family, ligatures): cell metrics measured at an older one
/// are measured again ([`crate::render::CellMetrics::is_current`]).
pub fn generation() -> u32 {
    GENERATION.load(Ordering::Relaxed)
}
