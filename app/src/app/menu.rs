//! The macOS menu bar (WebStorm's main menu, trimmed to what VimStorm has) and the window-level
//! shortcuts Ghostty / macOS gave the old setup: Hide (Cmd+H), Hide Others (Cmd+Alt+H), Minimize
//! (Cmd+M), Toggle Full Screen (Ctrl+Cmd+F), editor font size (Ctrl+Cmd+= / + / -, Cmd+0).
//!
//! Those are GPUI bindings: they run before any key listener, so nvim never sees them
//! (`crate::editor::input`, [`Owner::App`](crate::editor::input::Owner::App)).
//!
//! New Workspace…, Close Project, Quit VimStorm, Down / Up the Rail and Git › Branches… /
//! New Branch… (the toolbar's popups) are direct actions too. Every
//! other item does what its shortcut does, by sending that shortcut to the window as if it
//! was typed ([`Replay`]): the focused surface or nvim acts on it, exactly as for the key. Their
//! shortcuts are shown through bindings in a key context no element has ([`HINT`]), so the menu
//! lists the key but the binding never takes it from nvim (GPUI's macOS menu shows a binding even
//! when its context doesn't match; the window handles the key first, so AppKit never runs the
//! menu item for a typed key).

use gpui_kit::{
    Action, AnyWindowHandle, App, Global, KeyBinding, Keystroke, Menu, MenuItem, Window, actions,
};

use crate::factory::{Feel, FeelName};
use crate::render::{FONT_SIZE, editor_font_size, set_editor_font_size};
use crate::shell::{ColumnMode, projects};

actions!(
    vimstorm,
    [
        Hide,
        HideOthers,
        ShowAll,
        Quit,
        Minimize,
        Zoom,
        ToggleFullScreen,
        IncreaseFontSize,
        DecreaseFontSize,
        ResetFontSize,
        NextProjectWindow,
        PreviousProjectWindow,
        CloseProject,
        Workspaces,
        Branches,
        NewBranch,
    ]
);

/// A menu item that types its shortcut (GPUI keystroke syntax, e.g. `"cmd-shift-o"`) into the
/// window: VimStorm's (WebStorm's) key for the item, whatever the Feel.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = vimstorm, no_json)]
pub struct Replay(pub &'static str);

/// A menu item under the Feel vscode that types VS Code's key for it: the Feel's own map
/// does the item, so the key goes in as typed.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = vimstorm, no_json)]
pub struct FeelKey(pub &'static str);

/// A menu item under the Feel vscode that shows no key (VS Code's for it is none the Feel binds or
/// the menu shows): does what [`Replay`] of VimStorm's key does, with no binding to show.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = vimstorm, no_json)]
pub struct Unkeyed(pub &'static str);

/// Key context of the menu's shortcut hints: no element sets it, so these bindings never match a
/// typed key.
pub const HINT: &str = "VimStormMenuHint";

/// An item's key under the Feel vscode: VS Code's macOS key for the action, never one of
/// WebStorm's VS Code does otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vscode {
    /// The same key: VS Code's too, or a VimStorm action VS Code has none for (the Chat column,
    /// the Factory, the bottom pane's tabs, the jumps).
    Same,
    /// VS Code's key, which the Feel vscode binds to the item's action
    /// (`config/keymap_vscode.lua`, `crate::editor::input::VSCODE`).
    Key(&'static str),
    /// VS Code's key for it is one the menu doesn't show (an F-key, an ⌥ key, a two-key chord) or
    /// the Feel doesn't bind: no key shown, the item still does it.
    NoKey,
}

use Vscode::{Key, NoKey, Same};

/// Menu items that replay their shortcut: (menu, title, keystroke, its key under the Feel vscode).
/// The keystrokes are the ones macOS reports on the Swedish layout too (letters, digits, named
/// keys; `cmd-/` is what GPUI reports for Cmd+Shift+7, `cmd-shift--` / `cmd-shift-+` for Cmd+Shift+-
/// / +).
const REPLAYS: &[(&str, &str, &str, Vscode)] = &[
    // VS Code: ⌃R Open Recent (Vim's redo; ⌘⇧O is Go to Symbol in File there)
    ("File", "Recent Projects…", "cmd-shift-o", NoKey),
    ("File", "Save All", "cmd-s", Key("alt-cmd-s")),
    (
        "File",
        "Reveal in Finder",
        "ctrl-cmd-shift-o",
        Key("alt-cmd-r"),
    ),
    ("Edit", "Undo", "cmd-z", Same),
    ("Edit", "Redo", "cmd-shift-z", Same),
    ("Edit", "-", "", Same),
    ("Edit", "Cut", "cmd-x", Same),
    ("Edit", "Copy", "cmd-c", Same),
    ("Edit", "Paste", "cmd-v", Same),
    ("Edit", "Select All", "cmd-a", Same),
    ("Edit", "-", "", Same),
    ("Edit", "Find…", "cmd-f", Same),
    ("Edit", "Find Previous", "cmd-shift-g", Same),
    ("Edit", "Replace…", "cmd-r", Key("alt-cmd-f")),
    ("Edit", "Find in Files…", "cmd-shift-f", Same),
    ("Edit", "-", "", Same),
    (
        "Edit",
        "Extend Selection",
        "cmd-w",
        Key("ctrl-shift-cmd-right"),
    ),
    (
        "Edit",
        "Shrink Selection",
        "cmd-shift-w",
        Key("ctrl-shift-cmd-left"),
    ),
    // VS Code: ⌥⇧↓ Copy Line Down
    ("Edit", "Duplicate Line or Selection", "cmd-d", NoKey),
    ("Edit", "Comment with Line Comment", "cmd-/", Same),
    // the pane keys (`crate::shell::PaneKey`: shown with the keys, the keys, hidden): the
    // page's left one, Git (Code's bottom panel's tab), Chat; its main one only takes the keys
    ("View", "Project", "cmd-1", Key("cmd-shift-e")),
    ("View", "Editor", "cmd-2", Same),
    ("View", "Git", "cmd-3", Same),
    ("View", "Show / Hide Bottom Panel", "cmd-j", Same),
    ("View", "Chat", "cmd-4", Same),
    // the items: the column's modes, wherever the keys are; typed, ⌃⌘← ⌃⌘→ are those while Chat
    // has the keys or no Code shows, else the previous / next tab of the pane with them
    // ([`column_mode_of`]; the menu bar carries one key per item)
    ("View", "Chat Mode", "ctrl-cmd-left", Same),
    ("View", "Claude Code", "ctrl-cmd-right", Same),
    ("View", "Maximize Chat", "cmd-shift-2", Same),
    ("View", "Hide Chat", "alt-cmd-2", Same),
    ("View", "Drag Chat Out", "cmd-shift-d", Same),
    ("View", "-", "", Same),
    // a workspace's pages
    ("View", "Code", "ctrl-1", Same),
    ("View", "Run", "ctrl-2", Same),
    ("View", "Card", "ctrl-3", Same),
    // Code's bottom panel's Terminal (VS Code: ⌃`)
    ("View", "Terminal", "cmd-t", Key("ctrl-`")),
    // VS Code: ⌃⇧` New Terminal
    ("View", "New Terminal Tab", "cmd-shift-t", NoKey),
    ("View", "-", "", Same),
    // the rail: ⌘↑ ⌘↓ its workspaces, round again; ⌘← the Board
    ("View", "Up the Rail", "cmd-up", Same),
    ("View", "Down the Rail", "cmd-down", Same),
    ("View", "Board", "cmd-left", Same),
    ("View", "Into the Card", "cmd-right", Same),
    ("View", "Abe", "cmd-§", Same),
    ("View", "Maximize Island", "alt-cmd-enter", Same),
    ("View", "-", "", Same),
    // VS Code: ⌥F12 Peek Definition
    ("View", "Quick Definition", "cmd-l", NoKey),
    ("Navigate", "Go to File…", "cmd-o", Key("cmd-p")),
    // VS Code: F12 Go to Definition
    ("Navigate", "Declaration or Usages", "cmd-b", NoKey),
    ("Navigate", "-", "", Same),
    ("Navigate", "Previous Tab", "ctrl-left", Key("alt-cmd-left")),
    ("Navigate", "Next Tab", "ctrl-right", Key("alt-cmd-right")),
    // the jump: its ⌃⌥ form, which jumps from anywhere
    ("Navigate", "-", "", Same),
    ("Navigate", "Linked…", "ctrl-alt-l", Same),
    ("Code", "Show Context Actions", "alt-enter", Key("cmd-.")),
    // VS Code: ⇧F10
    ("Code", "Context Menu", "cmd-enter", NoKey),
    // VS Code: ⌥⇧F Format Document
    ("Code", "Reformat Code", "alt-cmd-l", NoKey),
    ("Code", "-", "", Same),
    // VS Code: ⌥⌘[ / ⌥⌘] (⌥8 / ⌥9 on the Swedish layout), ⌘K ⌘0 / ⌘K ⌘J
    ("Code", "Collapse", "cmd--", NoKey),
    ("Code", "Expand", "cmd-+", NoKey),
    ("Code", "Collapse All", "cmd-shift--", NoKey),
    ("Code", "Expand All", "cmd-shift-+", NoKey),
    // VS Code: F2
    ("Refactor", "Rename…", "shift-f6", NoKey),
    // VS Code: none (⌘⏎ in the Source Control box; ⌘K, ⌘⇧K are a chord and Delete Line there)
    ("Git", "Commit…", "cmd-k", NoKey),
    ("Git", "Push…", "cmd-shift-k", NoKey),
    ("Git", "Rollback Lines", "alt-cmd-z", NoKey),
];

/// Hints only for Cmd / Ctrl keys: the window gets those first (performKeyEquivalent) and handles
/// them, so AppKit never runs the menu item for a typed key; for plain / Alt / Shift keys (Alt+Enter,
/// Shift+F6, F12) AppKit could match the menu before the window sees the key.
fn hinted(keys: &str) -> bool {
    keys.contains("cmd-") || keys.contains("ctrl-")
}

/// An item's action under `feel`, and the key its menu shows (`None`: none).
fn item(
    feel: FeelName,
    keys: &'static str,
    vscode: Vscode,
) -> (Box<dyn Action>, Option<&'static str>) {
    let shown = |k: &'static str| hinted(k).then_some(k);
    match (feel, vscode) {
        (FeelName::Vscode, Key(k)) if hinted(k) => (Box::new(FeelKey(k)), Some(k)),
        (FeelName::Vscode, Key(_) | NoKey) => (Box::new(Unkeyed(keys)), None),
        _ => (Box::new(Replay(keys)), shown(keys)),
    }
}

/// The key each menu item shows under `feel`, by title (`None`: none).
pub fn shown_keys(feel: FeelName) -> Vec<(&'static str, Option<&'static str>)> {
    REPLAYS
        .iter()
        .filter(|(_, title, ..)| *title != "-")
        .map(|&(_, title, keys, vscode)| (title, item(feel, keys, vscode).1))
        .collect()
}

/// The menus' top-level order (WebStorm's main menu).
const MENUS: &[&str] = &[
    "File", "Edit", "View", "Navigate", "Code", "Refactor", "Git",
];

/// Registers the actions, their bindings and the menu bar. Call once, before the first window.
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        // Swedish: = is Shift+0 (GPUI reports "=" without Shift), + has its own key
        KeyBinding::new("ctrl-cmd-=", IncreaseFontSize, None),
        KeyBinding::new("ctrl-cmd-+", IncreaseFontSize, None),
        KeyBinding::new("ctrl-cmd--", DecreaseFontSize, None),
        KeyBinding::new("cmd-0", ResetFontSize, None),
        // the projects window takes Cmd+Down / Cmd+Up / Cmd+Q itself (shell::projects)
        KeyBinding::new("cmd-down", NextProjectWindow, Some(HINT)),
        KeyBinding::new("cmd-up", PreviousProjectWindow, Some(HINT)),
        KeyBinding::new("cmd-q", CloseProject, Some(HINT)),
    ]);
    // hints only for Cmd / Ctrl keys: the window gets those first (performKeyEquivalent) and
    // handles them, so AppKit never runs the menu item for a typed key; for plain / Alt / Shift
    // keys (Alt+Enter, Shift+F6) AppKit could match the menu before the window sees the key
    // (each Feel's: the menu bar's items point at one Feel's actions at a time)
    cx.bind_keys(
        REPLAYS
            .iter()
            .filter(|(_, _, keys, _)| hinted(keys))
            .map(|&(_, _, keys, _)| KeyBinding::new(keys, Replay(keys), Some(HINT))),
    );
    cx.bind_keys(
        REPLAYS
            .iter()
            .filter_map(|&(_, _, _, vscode)| match vscode {
                Key(k) if hinted(k) => Some(KeyBinding::new(k, FeelKey(k), Some(HINT))),
                _ => None,
            }),
    );

    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    // asks when any project would lose work; the quit saves every project and quits their
    // nvims first (main.rs `on_app_quit`)
    cx.on_action(|_: &Quit, cx| match target_window(cx) {
        Some(_) => with_window(cx, projects::quit),
        None => {
            super::log::quitting("Quit VimStorm (no window)");
            cx.quit()
        }
    });
    cx.on_action(|_: &Minimize, cx| with_window(cx, |w, _| w.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_window(cx, |w, _| w.zoom_window()));
    cx.on_action(|_: &ToggleFullScreen, cx| with_window(cx, |w, _| w.toggle_fullscreen()));
    cx.on_action(|_: &IncreaseFontSize, cx| font_size(editor_font_size(cx) + 1., cx));
    cx.on_action(|_: &DecreaseFontSize, cx| font_size(editor_font_size(cx) - 1., cx));
    cx.on_action(|_: &ResetFontSize, cx| font_size(FONT_SIZE, cx));
    cx.on_action(|_: &NextProjectWindow, cx| with_window(cx, |w, cx| projects::cycle(1, w, cx)));
    cx.on_action(|_: &PreviousProjectWindow, cx| {
        with_window(cx, |w, cx| projects::cycle(-1, w, cx))
    });
    cx.on_action(|_: &Workspaces, cx| with_window(cx, projects::show_workspaces));
    cx.on_action(|_: &Branches, cx| with_window(cx, |w, cx| toolbar_popup(false, w, cx)));
    cx.on_action(|_: &NewBranch, cx| with_window(cx, |w, cx| toolbar_popup(true, w, cx)));
    cx.on_action(|_: &CloseProject, cx| {
        with_window(cx, |w, cx| projects::close_active(None, w, cx))
    });
    cx.on_action(|r: &Replay, cx| replay(r.0, cx));
    cx.on_action(|r: &Unkeyed, cx| replay(r.0, cx));
    cx.on_action(|r: &FeelKey, cx| {
        let Ok(keystroke) = Keystroke::parse(r.0) else {
            return;
        };
        with_window(cx, move |w, cx| {
            w.dispatch_keystroke(keystroke, cx);
        });
    });

    // the menu bar (~10 ms of AppKit) once the window is open: startup's window (and nvim's first
    // flush) don't wait for it; again with each Feel's keys when the Feel changes
    cx.spawn(async |cx| {
        cx.update(|cx| {
            let feel = crate::editor::input::feel(cx);
            cx.set_global(MenuFeel(feel));
            cx.set_menus(menus(feel));
        })
    })
    .detach();
    cx.observe_global::<Feel>(|cx| {
        let feel = crate::editor::input::feel(cx);
        if cx.try_global::<MenuFeel>().is_some_and(|m| m.0 != feel) {
            cx.set_global(MenuFeel(feel));
            cx.set_menus(menus(feel));
        }
    })
    .detach();
}

/// The Feel the menu bar's keys are drawn for.
struct MenuFeel(FeelName);

impl Global for MenuFeel {}

/// Types VimStorm's key for an action into the window (Command mode's Recent projects).
pub fn replay_key(keys: &'static str, cx: &mut App) {
    replay(keys, cx);
}

/// Types VimStorm's key for a menu item into the window.
fn replay(keys: &'static str, cx: &mut App) {
    let Ok(keystroke) = Keystroke::parse(keys) else {
        return;
    };
    // the Feel vscode took the key over (Cmd+D, Cmd+Shift+K …): the item's WebStorm action
    if crate::editor::input::vscode_took(&keystroke, cx) {
        with_window(cx, move |w, cx| webstorm_action(&keystroke, w, cx));
        return;
    }
    // View › Chat Mode / Claude Code: the column's modes wherever the keys are (typed, ⌃⌘← ⌃⌘→
    // on Code are the tabs of the pane with them)
    if let Some(mode) = column_mode_of(keys) {
        with_window(cx, move |w, cx| column_mode(mode, w, cx));
        return;
    }
    with_window(cx, move |w, cx| {
        w.dispatch_keystroke(keystroke, cx);
    });
}

/// The column mode a View › Chat Mode / Claude Code item's key names.
fn column_mode_of(keys: &str) -> Option<ColumnMode> {
    match keys {
        "ctrl-cmd-left" => Some(ColumnMode::Chat),
        "ctrl-cmd-right" => Some(ColumnMode::Terminal),
        _ => None,
    }
}

/// The shown workspace's column in `mode` with the keys (a bare test window's own).
fn column_mode(mode: ColumnMode, window: &mut Window, cx: &mut App) {
    if projects::window(cx).is_some() {
        return projects::column_mode(mode, window, cx);
    }
    if let Some(ws) = window.root::<crate::shell::Workspace>().flatten() {
        ws.update(cx, |ws, cx| ws.column_mode(mode, window, cx));
    }
}

/// The menu bar, with `feel`'s keys.
pub fn menus(feel: FeelName) -> Vec<Menu> {
    let mut out = vec![Menu::new("VimStorm").items([
        MenuItem::action("Hide VimStorm", Hide),
        MenuItem::action("Hide Others", HideOthers),
        MenuItem::action("Show All", ShowAll),
        MenuItem::separator(),
        // no shortcut: Cmd+Q is Close Project (the last one quits); WebStorm's keymap here has
        // none for Exit either. Quits with every open project, saved (asks when work would be lost)
        MenuItem::action("Quit VimStorm", Quit),
    ])];
    for &name in MENUS {
        let mut items = Vec::new();
        if name == "File" {
            items.push(MenuItem::action("New Workspace…", Workspaces));
            items.push(MenuItem::action("Close Project", CloseProject));
            items.push(MenuItem::separator());
        }
        items.extend(REPLAYS.iter().filter(|(menu, ..)| *menu == name).map(
            |&(_, title, keys, vscode)| {
                if title == "-" {
                    MenuItem::separator()
                } else {
                    MenuItem::Action {
                        name: title.into(),
                        action: item(feel, keys, vscode).0,
                        os_action: None,
                        checked: false,
                        disabled: false,
                    }
                }
            },
        ));
        if name == "Git" {
            // no shortcut of their own: they open the toolbar's popups (P-19)
            items.extend([
                MenuItem::separator(),
                MenuItem::action("Branches…", Branches),
                MenuItem::action("New Branch…", NewBranch),
            ]);
        }
        if name == "View" {
            items.extend([
                MenuItem::separator(),
                MenuItem::action("Increase Font Size", IncreaseFontSize),
                MenuItem::action("Decrease Font Size", DecreaseFontSize),
                MenuItem::action("Reset Font Size", ResetFontSize),
            ]);
        }
        out.push(Menu::new(name).items(items));
    }
    out.push(Menu::new("Window").items([
        MenuItem::action("Minimize", Minimize),
        MenuItem::action("Zoom", Zoom),
        MenuItem::action("Toggle Full Screen", ToggleFullScreen),
        MenuItem::separator(),
        MenuItem::action("Down the Rail", NextProjectWindow),
        MenuItem::action("Up the Rail", PreviousProjectWindow),
    ]));
    out
}

/// The window menu items and app keys act on: the projects window (one per app), else the active
/// window (tests open a bare workspace). Deferred: a binding's action runs while its window is
/// being updated (dispatching the key), and a window can't be updated from inside itself.
fn with_window(cx: &mut App, f: impl FnOnce(&mut Window, &mut App) + 'static) {
    let Some(handle) = target_window(cx) else {
        return;
    };
    cx.defer(move |cx| {
        let _ = handle.update(cx, |_, window, cx| f(window, cx));
    });
}

fn target_window(cx: &App) -> Option<AnyWindowHandle> {
    projects::window(cx).or_else(|| cx.active_window())
}

/// A menu item whose shortcut the Feel vscode took over: what the key does under WebStorm, in the
/// shown workspace's nvim (`config.keymap_vscode.webstorm`).
fn webstorm_action(keystroke: &Keystroke, window: &mut Window, cx: &mut App) {
    let ws = projects::active_workspace(cx)
        .or_else(|| window.root::<crate::shell::Workspace>().flatten());
    let (Some(ws), Some(lhs)) = (ws, crate::kit::notation_of(keystroke)) else {
        return;
    };
    // a native surface has the keyboard: what the typed WebStorm key would do there (an editor
    // key is swallowed rather than acting on the buffer behind it)
    if let Some(surface) = ws.read(cx).focused_surface(window, cx)
        && !crate::editor::input::forward_from_surface_in(FeelName::Vimstorm, surface, keystroke)
    {
        return;
    }
    crate::nvim::lua::call(
        ws.read(cx).rpc(),
        "config.keymap_vscode",
        "webstorm",
        vec![lhs.into()],
    );
}

/// Git › Branches… / New Branch…: the shown workspace's toolbar popup (a bare test window's own).
fn toolbar_popup(new: bool, window: &mut Window, cx: &mut App) {
    let ws = projects::active_workspace(cx)
        .or_else(|| window.root::<crate::shell::Workspace>().flatten());
    let Some(ws) = ws else { return };
    let toolbar = ws.read(cx).toolbar().clone();
    toolbar.update(cx, |t, cx| {
        if new {
            t.open_new_branch(window, cx)
        } else {
            t.open_branches(window, cx)
        }
    });
}

/// Sets the editor font size; the editor and the terminal re-measure their cells on the redraw.
fn font_size(size: f32, cx: &mut App) {
    if set_editor_font_size(size, cx) {
        cx.refresh_windows();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keys taken out of the product stay gone from the menu bar: ⌘G (the Copilot inline chat),
    /// ⌘9, ⌃⌘⏎, ⌃⌘K.
    #[test]
    fn every_replay_sits_in_a_menu_parses_and_types_no_retired_key() {
        for (menu, title, keys, vscode) in REPLAYS {
            assert!(MENUS.contains(menu), "{title} in {menu}");
            if *title != "-" {
                assert!(Keystroke::parse(keys).is_ok(), "{title}: {keys}");
            }
            if let Key(k) = vscode {
                assert!(Keystroke::parse(k).is_ok(), "{title}: {k}");
            }
            assert!(
                !["cmd-g", "cmd-9", "ctrl-cmd-enter", "ctrl-cmd-k"].contains(keys),
                "{title} types the retired {keys}"
            );
            assert!(!title.contains("Inline Chat"), "{title}");
        }
    }

    #[test]
    fn the_view_menu_has_the_chat_the_pages_and_the_rail() {
        let view: Vec<_> = REPLAYS
            .iter()
            .filter(|(menu, ..)| *menu == "View")
            .map(|&(_, title, keys, _)| (title, keys))
            .filter(|(t, _)| *t != "-")
            .collect();
        for item in [
            ("Project", "cmd-1"),
            ("Editor", "cmd-2"),
            ("Git", "cmd-3"),
            ("Show / Hide Bottom Panel", "cmd-j"),
            ("Chat", "cmd-4"),
            ("Chat Mode", "ctrl-cmd-left"),
            ("Claude Code", "ctrl-cmd-right"),
            ("Maximize Chat", "cmd-shift-2"),
            ("Hide Chat", "alt-cmd-2"),
            ("Code", "ctrl-1"),
            ("Run", "ctrl-2"),
            ("Card", "ctrl-3"),
            ("Terminal", "cmd-t"),
            ("Up the Rail", "cmd-up"),
            ("Down the Rail", "cmd-down"),
            ("Board", "cmd-left"),
            ("Abe", "cmd-§"),
        ] {
            assert!(view.contains(&item), "{item:?}");
        }
        // the two modes are the column's from the menu, wherever the keys are (typed on Code, the
        // pane's tabs)
        assert_eq!(column_mode_of("ctrl-cmd-left"), Some(ColumnMode::Chat));
        assert_eq!(column_mode_of("ctrl-cmd-right"), Some(ColumnMode::Terminal));
        assert_eq!(column_mode_of("alt-cmd-right"), None);
        // the bottom drawer's keys and the pages past ⌃3 are gone
        for gone in ["cmd-5", "cmd-6", "cmd-7", "ctrl-4", "ctrl-5"] {
            assert!(view.iter().all(|(_, k)| *k != gone), "{gone}");
        }
    }

    #[test]
    fn the_git_menu_opens_branches_and_new_branch() {
        let git = menus(FeelName::Vimstorm)
            .into_iter()
            .find(|m| m.name == "Git")
            .unwrap();
        let names: Vec<String> = git
            .items
            .iter()
            .filter_map(|i| match i {
                MenuItem::Action { name, .. } => Some(name.to_string()),
                _ => None,
            })
            .collect();
        assert!(
            names.ends_with(&["Branches…".to_owned(), "New Branch…".to_owned()]),
            "{names:?}"
        );
    }

    /// A VS Code key the table names is one the menu shows (else it would be `NoKey`), and
    /// every other Feel shows VimStorm's keys exactly as before.
    #[test]
    fn each_feel_shows_its_own_keys() {
        for (_, title, _, vscode) in REPLAYS {
            if let Key(k) = vscode {
                assert!(hinted(k), "{title}: {k} would not show");
            }
        }
        // (the Feel vim keeps WebStorm's keys for the app's chrome)
        for feel in [FeelName::Vimstorm, FeelName::Webstorm, FeelName::Vim] {
            for ((title, shown), (_, t, keys, _)) in shown_keys(feel)
                .into_iter()
                .zip(REPLAYS.iter().filter(|(_, t, ..)| *t != "-"))
            {
                assert_eq!(title, *t);
                assert_eq!(shown, hinted(keys).then_some(*keys), "{title}");
            }
        }
        let vscode = shown_keys(FeelName::Vscode);
        let key = |t: &str| vscode.iter().find(|(title, _)| *title == t).unwrap().1;
        assert_eq!(key("Go to File…"), Some("cmd-p"));
        assert_eq!(key("Show Context Actions"), Some("cmd-."));
        assert_eq!(key("Declaration or Usages"), None);
        assert_eq!(key("Chat"), Some("cmd-4"));
        assert_eq!(key("Terminal"), Some("ctrl-`"));
    }
}
