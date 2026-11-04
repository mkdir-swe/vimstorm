//! The look: the bridge's `look` shell effect (`abe/packages/ui/contract/frames/
//! bridge-shell-look*.json`, written by `lookOf` in `core/src/theme/theme.ts`) puts a theme in force in
//! the whole window at once: `theme.rs`'s palette (every const a DS token or one it follows,
//! Islands Dark exactly the built-in palette), the density's metrics, the editor font, the
//! terminal's colours and nvim's highlight groups. Its own test binary: the palette, the density
//! and the fonts are process-global.
#![cfg(debug_assertions)]

mod common;

use gpui_kit::{Rgba, px};
use serde_json::Value;
use vimstorm::look::{
    self, FOLLOWS, Follow, Look, Syntax, palette, palette_of, terminal_of, token_name,
};
use vimstorm::render::editor_font_size;
use vimstorm::terminal as term;

use common::bridge::{fake, fixture};
use common::view::View;

fn frame_look(name: &str) -> Look {
    let text = std::fs::read_to_string(fixture(&format!("frames/{name}"))).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    serde_json::from_value(v["effect"]["look"].clone()).unwrap()
}

fn index(name: &str) -> usize {
    palette::NAMES.iter().position(|n| *n == name).unwrap()
}

#[test]
fn islands_dark_is_the_built_in_palette_and_every_const_has_a_token() {
    let dark = frame_look("bridge-shell-look-dark.json");
    assert_eq!(dark.theme.slug, "islands-dark");
    let got = palette_of(&dark);
    for (i, name) in palette::NAMES.iter().enumerate() {
        assert_eq!(got[i], palette::BUILT_IN[i], "{name}");
    }
    assert_eq!(terminal_of(&dark), term::BUILT_IN);

    // a const either is a token of its own name or follows one the DS has
    for name in palette::NAMES {
        let own = dark.tokens.contains_key(&token_name(name));
        let follow = FOLLOWS.iter().find(|(n, _)| *n == name).map(|(_, f)| *f);
        assert!(
            own != follow.is_some(),
            "{name}: a token or a follow, not both"
        );
        match follow {
            Some(Follow::Same(t) | Follow::Near(t)) => assert!(dark.tokens.contains_key(t), "{t}"),
            Some(Follow::Over { token, ground, .. }) => {
                assert!(dark.tokens.contains_key(token) && dark.tokens.contains_key(ground))
            }
            Some(Follow::Kept) | None => {}
        }
    }
    assert!(FOLLOWS.iter().all(|(n, _)| palette::NAMES.contains(n)));
}

#[test]
fn a_staged_colour_changes_its_const_alone() {
    let staged = frame_look("bridge-shell-look-staged.json");
    assert!(staged.staged);
    let got = palette_of(&staged);
    let needs = index("ABE_NEEDS_YOU");
    assert_eq!(got[needs], look::hex(0xa979f7));
    for (i, name) in palette::NAMES.iter().enumerate() {
        if i != needs {
            assert_eq!(got[i], palette::BUILT_IN[i], "{name}");
        }
    }
}

#[test]
fn islands_light_reaches_the_chrome_the_followers_and_the_terminal() {
    let light = frame_look("bridge-shell-look.json");
    let got = palette_of(&light);
    let at = |name: &str| got[index(name)];
    assert_eq!(at("FRAME_BG"), look::hex(0xebecf0));
    assert_eq!(at("PANEL_BG"), look::hex(0xffffff));
    assert_eq!(at("EDITOR_BG"), look::hex(0xffffff));
    // followers: the same token's colour, a near one's once it moved, a wash over the light editor
    assert_eq!(at("TOOLTIP_BORDER"), at("SEPARATOR"));
    assert_eq!(at("GIT_RENAMED"), at("GIT_MODIFIED"));
    assert_eq!(at("REPLACE_BAR_BG"), at("EDITOR_BG"));
    let wash = at("CLOUD_NOTICE_BG");
    assert!(wash.r > 0.9 && wash.b > wash.r, "{wash:?}");
    // the kept ones are their own in every theme
    assert_eq!(at("BUTTON_BG"), palette::BUILT_IN[index("BUTTON_BG")]);

    let t = terminal_of(&light);
    assert_eq!(t.background, 0xffffff);
    assert_ne!(t.ansi, term::BUILT_IN.ansi);
}

/// Islands Light's chrome with Islands Dark as the editor scheme: the editor, the terminal
/// and nvim stay Islands Dark's, the chrome is light.
#[test]
fn a_named_editor_scheme_keeps_the_editor_s_colours_under_another_theme() {
    let mixed = frame_look("bridge-shell-look-light-scheme-dark.json");
    let light = frame_look("bridge-shell-look.json");
    let dark = frame_look("bridge-shell-look-dark.json");
    assert_eq!(mixed.theme.slug, "islands-light");
    assert_eq!(mixed.editor_colours(), (true, Syntax::Darcula));
    assert_eq!(light.editor_colours(), (false, Syntax::Darcula));
    let got = palette_of(&mixed);
    let at = |name: &str| got[index(name)];
    assert_eq!(at("FRAME_BG"), palette_of(&light)[index("FRAME_BG")]);
    assert_eq!(at("EDITOR_BG"), palette::BUILT_IN[index("EDITOR_BG")]);
    assert_eq!(terminal_of(&mixed), terminal_of(&dark));
    // a bridge older than the scheme: the theme's own
    let text = std::fs::read_to_string(fixture("frames/bridge-shell-look.json")).unwrap();
    let mut older: Value = serde_json::from_str(&text).unwrap();
    older["effect"]["look"]
        .as_object_mut()
        .unwrap()
        .remove("scheme");
    let older: Look = serde_json::from_value(older["effect"]["look"].clone()).unwrap();
    assert_eq!(older.editor_colours(), (false, Syntax::Darcula));
}

/// Quads painted in `color` (the chrome's grounds, nvim's cells).
fn painted(v: &mut View, color: Rgba) -> usize {
    let want = look::hsla(color);
    v.cx.update(|window, _| {
        window
            .painted_quads()
            .into_iter()
            .filter(|q| q.background.as_solid() == Some(want))
            .count()
    })
}

#[test]
fn a_look_from_the_bridge_repaints_the_window_and_cancel_puts_it_back() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.ts"]);
    let projects = v.projects.clone().unwrap();
    let dark_frame = look::FRAME_BG.rgba();
    let compact = v.cx.debug_bounds("status-bar").unwrap().size.height;
    assert_eq!(
        compact,
        px(look::density::COMPACT[look::STATUS_BAR_HEIGHT.0 as usize])
    );
    assert!(painted(&mut v, dark_frame) > 0);

    // Islands Light at WebStorm's default density, as `abe ui bridge` sends it
    let command = fake(tmp.path(), &["frames/bridge-shell-look.json"], None);
    v.cx.update(|_, cx| cx.set_global(command));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    v.wait_until("the light look", |v| {
        v.cx.update(|_, cx| look::current(cx).is_some_and(|l| l.theme.slug == "islands-light"))
    });
    let light = frame_look("bridge-shell-look.json");
    let light_frame = palette_of(&light)[index("FRAME_BG")];
    assert_eq!(look::FRAME_BG.rgba(), light_frame);
    assert_eq!(look::TOOLBAR_HEIGHT.get(), 40.);
    assert_eq!(term::palette().background, 0xffffff);
    v.wait_lua(
        "nvim's editor light",
        "return vim.o.background == 'light' and vim.api.nvim_get_hl(0, { name = 'Normal' }).bg == 0xffffff",
    );
    v.wait_until("the chrome repainted light", |v| {
        painted(v, light_frame) > 0 && painted(v, dark_frame) == 0
    });
    // the editor lays the window out again on its next frame
    v.wait_until("default density's status bar", |v| {
        v.cx.debug_bounds("status-bar").unwrap().size.height == px(28.)
    });

    // a named scheme survives the theme: Islands Light's chrome, nvim Islands Dark's
    let mixed = frame_look("bridge-shell-look-light-scheme-dark.json");
    v.cx.update(|_, cx| projects.update(cx, |p, cx| p.apply_look(mixed, cx)));
    v.cx.run_until_parked();
    assert_eq!(look::FRAME_BG.rgba(), light_frame);
    assert_eq!(term::palette(), term::BUILT_IN);
    v.wait_lua(
        "nvim's editor dark under the light theme",
        "return vim.o.background == 'dark' and vim.api.nvim_get_hl(0, { name = 'Normal' }).bg == 0x1e1f22",
    );

    // a staged change over Islands Dark (the Colours editor's), then Cancel's look: Islands Dark
    let staged = frame_look("bridge-shell-look-staged.json");
    v.cx.update(|_, cx| projects.update(cx, |p, cx| p.apply_look(staged, cx)));
    v.cx.run_until_parked();
    assert_eq!(look::ABE_NEEDS_YOU.rgba(), look::hex(0xa979f7));
    assert_eq!(look::FRAME_BG.rgba(), dark_frame);
    assert_eq!(v.cx.update(|_, cx| editor_font_size(cx)), 15.);
    v.wait_lua("nvim dark again", "return vim.o.background == 'dark'");
    v.wait_until("compact again", |v| {
        v.cx.debug_bounds("status-bar").unwrap().size.height == compact
    });

    let dark = frame_look("bridge-shell-look-dark.json");
    v.cx.update(|_, cx| projects.update(cx, |p, cx| p.apply_look(dark, cx)));
    v.cx.run_until_parked();
    for (i, name) in palette::NAMES.iter().enumerate() {
        assert_eq!(
            palette::Tok(i as u16).rgba(),
            palette::BUILT_IN[i],
            "{name}"
        );
    }
    assert_eq!(term::palette(), term::BUILT_IN);
    assert_eq!(v.cx.update(|_, cx| editor_font_size(cx)), 13.);

    // Dark Modern: nvim colours with VS Code's capture mapping (a function call in the
    // function colour, a primitive type in the type colour); Islands Dark puts Darcula's back
    let fg =
        "local function fg(n) return vim.api.nvim_get_hl(0, { name = n, link = false }).fg end ";
    let modern = frame_look("bridge-shell-look-dark-modern.json");
    v.cx.update(|_, cx| projects.update(cx, |p, cx| p.apply_look(modern, cx)));
    v.wait_lua(
        "VS Code's mapping in nvim",
        &format!(
            "{fg} return fg('@function.call') == 0xdcdcaa and fg('@type.builtin') == 0x4ec9b0"
        ),
    );
    let dark = frame_look("bridge-shell-look-dark.json");
    v.cx.update(|_, cx| projects.update(cx, |p, cx| p.apply_look(dark, cx)));
    v.wait_lua(
        "Darcula's mapping back",
        &format!(
            "{fg} return fg('@function.call') == 0xa9b7c6 and fg('@type.builtin') == 0xcc7832"
        ),
    );
}

/// Dark Modern names VS Code's capture mapping, Islands Dark Darcula's; a look from a bridge
/// older than `syntax` is Darcula's.
#[test]
fn dark_modern_names_vs_code_s_capture_mapping() {
    assert_eq!(
        frame_look("bridge-shell-look-dark-modern.json")
            .theme
            .syntax,
        Syntax::Vscode
    );
    assert_eq!(
        frame_look("bridge-shell-look-dark.json").theme.syntax,
        Syntax::Darcula
    );
    let text =
        std::fs::read_to_string(fixture("frames/bridge-shell-look-dark-modern.json")).unwrap();
    let mut older: Value = serde_json::from_str(&text).unwrap();
    older["effect"]["look"]["theme"]
        .as_object_mut()
        .unwrap()
        .remove("syntax");
    let older: Look = serde_json::from_value(older["effect"]["look"].clone()).unwrap();
    assert_eq!(older.theme.syntax, Syntax::Darcula);
}

/// Chat's box cloud and the icons follow the look. The cloud is rasterized once per look: its image is kept by its SVG, which names
/// the accent in force, so another look's accent never draws the last look's image.
#[test]
fn chat_clouds_are_kept_by_the_colour_they_are_drawn_in() {
    use vimstorm::factory::{BoxState, cloud_svg};
    use vimstorm::kit::IconName;
    let app = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
    let dark = cloud_svg(BoxState::Running);
    assert!(dark.contains(&hex_of(look::ABE_ACCENT.rgba())), "{dark}");
    app.update(|cx| look::apply(frame_look("bridge-shell-look.json"), cx));
    let light = cloud_svg(BoxState::Running);
    assert!(light.contains(&hex_of(look::ABE_ACCENT.rgba())), "{light}");
    assert_ne!(dark, light);
    // the light look draws WebStorm's light icons (the unchecked box white, not Islands
    // Dark's #2B2D30; one look sequence with the clouds', the palette being global)
    assert!(!look::palette::dark());
    let light_box = std::str::from_utf8(IconName::CheckBox.svg()).unwrap();
    assert!(light_box.contains(r##"fill="#FFFFFF""##), "{light_box}");
    app.update(|cx| look::apply(frame_look("bridge-shell-look-dark.json"), cx));
    assert_eq!(cloud_svg(BoxState::Running), dark);
    assert!(look::palette::dark());
    let dark_box = std::str::from_utf8(IconName::CheckBox.svg()).unwrap();
    assert!(dark_box.contains(r##"fill="#2B2D30""##), "{dark_box}");
}

fn hex_of(c: Rgba) -> String {
    let b = |v: f32| (v * 255.).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c.r), b(c.g), b(c.b))
}
