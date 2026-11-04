//! The WebStorm keymap the app owns (ADR 0001): every shortcut of the old Ghostty setup, who
//! handles it in the app, and which keys stay global while a native surface has the keyboard.
//!
//! Rust owns detecting keys (notation, Swedish layout, double Shift, releases: [`super::Keys`]),
//! routing them ([`forward_from_surface`]) and the window-level shortcuts (`crate::app`:
//! GPUI bindings, so nvim never sees them). Actions that depend on nvim's state (mode, focus
//! target, buffer-local views) stay Lua maps reached through the `<D-…>` notation Rust sends.
//!
//! `tests/input.rs` checks the table: every [`Owner::Nvim`] / [`Owner::Global`] key has a mapping
//! in the app's config, every [`Owner::App`] key a GPUI binding. Under the Feel `vscode`
//! [`VSCODE`]'s chords take the place of the rows with the same key ([`shortcuts`]).

use gpui_kit::{App, Keystroke};

use crate::factory::{Feel, FeelName};

/// Who acts on a shortcut in the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// A GPUI binding (`crate::app`): runs before any key listener, never reaches nvim.
    App,
    /// The projects window's own key listener (the rail, Close Project).
    Window,
    /// A Lua map, also reached while a tool window (tree, Git) has the keyboard.
    Global,
    /// A global Lua map (from any native surface too, for Cmd keys).
    Nvim,
    /// A Lua map acting on the focused editor buffer (WebStorm: an editor action applies to the
    /// focused component only). nvim's current window stays the editor split while a native
    /// surface has the keyboard, so these are never forwarded from one ([`forward_from_surface`]).
    Editor,
    /// A Lua map that exists only in some view (named); elsewhere the key does nothing.
    NvimIn(&'static str),
    /// A native page's own key while it has the keyboard (named); elsewhere the surface's.
    Page(&'static str),
    /// Swallowed on purpose (Ghostty's `ignore`).
    Ignored,
}

/// One shortcut. `trigger` uses Ghostty's names on the Swedish layout (`super+shift+digit_7`), as
/// `crate::editor::input::swedish::keystroke` reads them.
#[derive(Clone, Copy, Debug)]
pub struct Shortcut {
    pub trigger: &'static str,
    pub action: &'static str,
    pub owner: Owner,
}

const fn s(trigger: &'static str, action: &'static str, owner: Owner) -> Shortcut {
    Shortcut {
        trigger,
        action,
        owner,
    }
}

use Owner::*;

/// Every Cmd / Ctrl / Alt / F-key shortcut (README key tables, old ghostty/config, Lua maps).
/// Plain Vim keys and list keys (k l ö ä, `,` leader keys, the tree's and Git's letters) are text
/// keys the Lua config / the surfaces read directly: not listed.
pub const KEYMAP: &[Shortcut] = &[
    // the pane keys (`crate::shell::PaneKey`, WebStorm's tool-window keys: hidden, shown with the
    // keys; shown, the keys; with them, hidden): ⌘1 the page's left pane (on Code the tree), ⌘3
    // the bottom panel's Git, ⌘4 Chat, ⌘T and ⌃` the panel's Terminal (below); ⌘2 the page's main
    // one only takes the keys (on Code the open file, nvim's; elsewhere the projects window's)
    s(
        "super+digit_1",
        "Project tool window (again: hidden)",
        Window,
    ),
    s(
        "super+digit_2",
        "The open file (the page's main pane)",
        Nvim,
    ),
    s(
        "super+digit_3",
        "Git tool window, the bottom panel's (again: hidden)",
        Window,
    ),
    s("super+j", "Bottom panel: show / hide", Window),
    s(
        "super+digit_4",
        "Chat column, in its mode (again: hidden)",
        Window,
    ),
    // ⌃⌘← / ⌃⌘→: Chat / Claude Code in the right column, the keys there; on Code with the keys in
    // another pane (the editor, the tree, the Terminal, Git, a diff) its previous / next tab, as
    // ⌥⌘← ⌥⌘→ (Lua's `focus.cycle_tabs`, once nvim has the keys typed before)
    s(
        "super+ctrl+arrow_left",
        "Chat column: Chat (on Code, another pane's: previous tab)",
        Window,
    ),
    s(
        "super+ctrl+arrow_right",
        "Chat column: Claude Code (on Code, another pane's: next tab)",
        Window,
    ),
    s("super+shift+d", "Drag Chat out / dock it", Window),
    // ⌘⇧2 / ⌘⌥2: the shown tile's Chat docked ↔ maximized, hidden ↔ shown (kept per tile)
    s("super+shift+digit_2", "Chat: docked / maximized", Window),
    s("super+alt+digit_2", "Chat: hide / show", Window),
    // the rail (the window takes them before any surface; every move gives Chat the keys):
    // ⌘↑ ⌘↓ round its workspaces and prototypes, ⌘← the Board, ⌘→ from the Board into the card's workspace
    // (elsewhere the line's end), the key left of 1 Abe and again back. ⌘5 ⌘6 ⌘7 and ⌘< ⌘⇧< are
    // gone
    s(
        "super+arrow_up",
        "Rail: the tile above in its group",
        Window,
    ),
    s(
        "super+arrow_down",
        "Rail: the tile below in its group",
        Window,
    ),
    s("super+arrow_left", "Rail: down to the Board", Window),
    s("super+arrow_right", "Rail: up to the workspaces", Window),
    s("super+§", "Rail: Abe, again back", Window),
    // a workspace's pages; on a prototype's tile its own: Preview (⏎ the app takes the keys, Esc
    // gives them back; r reload, R restart the app, v the next viewport, o open in the browser,
    // m Make card…, s stop the app, d Discard…, ⌘⏎ its menu), Code, Logs
    s(
        "ctrl+digit_1",
        "Page: Code (a prototype's: Preview)",
        Window,
    ),
    s("ctrl+digit_2", "Page: Run (a prototype's: Code)", Window),
    s("ctrl+digit_3", "Page: Card (a prototype's: Logs)", Window),
    // the Run page scrolls the step shown (as PgDn / PgUp, Space / ⇧Space a pane, Home / End its
    // top and foot); its step keys `l ö` ↑ ↓ `gg` `G` stay
    s("ctrl+e", "Run: the step shown a line down", Page("Run")),
    s("ctrl+y", "Run: the step shown a line up", Page("Run")),
    s(
        "ctrl+d",
        "Run: the step shown half a pane down",
        Page("Run"),
    ),
    s("ctrl+u", "Run: the step shown half a pane up", Page("Run")),
    // ⌃` (Swedish ⌃⇧´)
    s(
        "ctrl+shift+´",
        "Bottom panel: the Terminal (again: hidden)",
        Window,
    ),
    s("super+alt+a", "The Board (again back)", Window),
    s("super+,", "Settings", Window),
    s("super+t", "Bottom panel's Terminal (again: hidden)", Window),
    s("super+shift+t", "New terminal tab", Nvim),
    s("super+q", "Close Project (the last one quits)", Window),
    s("super+alt+arrow_left", "Previous tab (focused pane)", Nvim),
    s("super+alt+arrow_right", "Next tab (focused pane)", Nvim),
    s(
        "super+alt+enter",
        "Maximize the island with the keyboard (again restores)",
        Window,
    ),
    s("ctrl+arrow_left", "Previous editor tab", Global),
    s("ctrl+arrow_right", "Next editor tab", Global),
    s("ctrl+tab", "Switcher", Global),
    s("ctrl+shift+tab", "Switcher (backwards)", Global),
    // the jump: taken before every surface, but in an nvim split and a PTY, where the plain key
    // stays theirs (add caret above; the shell's clear); the ⌃⌥ form jumps from there too
    // ([`jump_of`]). ⌃W's workspace jump is the rail's ⌘→; ⌃I's Card page is ⏎ on a card
    s("ctrl+l", "Jump: Linked (nvim: add caret above)", Window),
    s("ctrl+alt+l", "Jump: Linked, from anywhere", Window),
    // editing
    s("super+c", "Copy", Editor),
    s("super+x", "Cut", Editor),
    s("super+v", "Paste", Editor),
    s("super+z", "Undo / Rollback (Local Changes)", Editor),
    s("super+shift+z", "Redo", Editor),
    s("super+a", "Select all", Editor),
    s("super+s", "Save all", Nvim),
    s("super+w", "Extend selection", Editor),
    s("super+shift+w", "Shrink selection", Editor),
    s("super+d", "Duplicate line or selection", Editor),
    s(
        "super+shift+digit_7",
        "Comment with line comment (Cmd+/)",
        Editor,
    ),
    s("super+-", "Collapse region", Editor),
    s("super++", "Expand region", Editor),
    s("super+shift+digit_0", "Expand region (Cmd+=)", Editor),
    s("super+shift+-", "Collapse all regions", Editor),
    s("super+shift++", "Expand all regions", Editor),
    s("ctrl+ö", "Add caret below", Editor),
    s("ctrl+n", "Add next occurrence", Editor),
    s("ctrl+x", "Skip occurrence", Editor),
    s("ctrl+p", "Drop caret", NvimIn("several carets")),
    s("ctrl+shift+l", "Scroll up", Editor),
    s("ctrl+shift+ö", "Scroll down", Editor),
    s(
        "ctrl+space",
        "Completion",
        NvimIn("Insert mode (blink.cmp)"),
    ),
    s(
        "super+backspace",
        "Delete to line start (typing, fields)",
        Editor,
    ),
    s("alt+arrow_left", "Word left", Editor),
    s("alt+arrow_right", "Word right", Editor),
    s("super+e", "Nothing (Ghostty's ignore)", Ignored),
    // search / navigation
    s("super+o", "Go to File", Nvim),
    s("super+shift+f", "Find in Files", Nvim),
    s("super+shift+o", "Recent Projects", Nvim),
    s("super+f", "Find", Editor),
    s("super+shift+g", "Previous match", Editor),
    s("super+ctrl+shift+o", "Reveal in Finder", Editor),
    s("super+b", "Go to declaration / usages", Editor),
    s("super+l", "Quick Definition", Editor),
    s(
        "alt+space",
        "Quick Definition (WebStorm's default key)",
        Editor,
    ),
    s("super+ö", "Next difference", NvimIn("diff / merge")),
    // code
    s("super+enter", "Context menu", Editor),
    s("alt+enter", "Context actions", Editor),
    s("super+alt+l", "Reformat code", Editor),
    s("shift+f6", "Rename", Editor),
    s(
        "super+r",
        "Replace in file / rollback change (diff)",
        Editor,
    ),
    s("super+alt+z", "Rollback lines", Editor),
    s("super+k", "Commit", Nvim),
    s("super+alt+k", "Commit and Push", Nvim),
    s("super+shift+k", "Push", Nvim),
    s("f4", "Open in editor (diff, merge)", Editor),
    // bookmarks 6–9 (⌃1–⌃3 are the pages)
    s("ctrl+digit_6", "Go to bookmark 6", Global),
    s("ctrl+digit_9", "Go to bookmark 9", Global),
    s("ctrl+shift+digit_1", "Toggle bookmark 1", Editor),
    s("ctrl+shift+digit_9", "Toggle bookmark 9", Editor),
    // window level (Ghostty / macOS gave these)
    s("super+h", "Hide VimStorm", App),
    s("super+alt+h", "Hide Others", App),
    s("super+m", "Minimize", App),
    s("super+ctrl+f", "Toggle Full Screen", App),
    s(
        "super+ctrl+shift+digit_0",
        "Increase font size (Ctrl+Cmd+=)",
        App,
    ),
    s("super+ctrl++", "Increase font size", App),
    s("super+ctrl+-", "Decrease font size", App),
    s("super+digit_0", "Reset font size", App),
];

/// Feel `vscode`'s chords (`nvim/lua/config/keymap_vscode.lua`): VS Code's macOS keys for
/// the VimStorm action that does it, over [`KEYMAP`]'s row with the same key while the Feel is
/// vscode. ⌘⇧F (Find in Files) and ⌘/ (comment) are the same in both.
pub const VSCODE: &[Shortcut] = &[
    s("super+p", "Go to File", Nvim),
    s("super+shift+p", "Command palette (Command mode)", Nvim),
    s("super+b", "Toggle Project tree", Nvim),
    s("super+shift+m", "Problems (bottom pane)", Nvim),
    s(
        "super+shift+e",
        "Project tool window (again: hidden)",
        Window,
    ),
    // VS Code's ⌃⇧G: ⌘⇧G stays Find Previous, VS Code's too
    s("ctrl+shift+g", "Source Control (Git tool window)", Global),
    s("super+t", "Go to Symbol in Workspace", Nvim),
    // ⌘K ⌘S (key help): ⌘K is only a chord's first key, nvim waits for the second
    s("super+k", "Chord prefix (⌘K ⌘S key help, ⌘K ⌘D skip)", Nvim),
    // (Ctrl+`, VS Code's terminal, is the window's own under every Feel: [`KEYMAP`]'s row)
    s("super+alt+shift+digit_7", "Split right (Cmd+\\)", Editor),
    s("super+w", "Close tab", Editor),
    s("alt+arrow_up", "Move line up", Editor),
    s("alt+arrow_down", "Move line down", Editor),
    s("alt+shift+arrow_up", "Copy line up", Editor),
    s("alt+shift+arrow_down", "Copy line down", Editor),
    s("super+shift+k", "Delete line", Editor),
    s(
        "super+d",
        "Select the word, then add its next occurrence (multi-cursor)",
        Editor,
    ),
    s("super+shift+o", "Go to Symbol in File", Editor),
    s("ctrl+-", "Back", Editor),
    s("ctrl+shift+-", "Forward", Editor),
    s("f12", "Go to definition", Editor),
    s("shift+f12", "Find usages", Editor),
    s("f2", "Rename", Editor),
    s("super+.", "Quick fix", Editor),
    // VS Code's keys for what VimStorm does on a WebStorm key (the menu bar shows them)
    s("super+alt+s", "Save all", Nvim),
    s("super+alt+r", "Reveal in Finder", Editor),
    s("super+alt+f", "Replace", Editor),
    s("super+ctrl+shift+arrow_right", "Expand selection", Editor),
    s("super+ctrl+shift+arrow_left", "Shrink selection", Editor),
];

/// The Feel in force (VimStorm's until the bridge says).
pub fn feel(cx: &App) -> FeelName {
    cx.try_global::<Feel>()
        .map_or(FeelName::default(), |f| f.feel)
}

/// The shortcuts in force under `feel`: [`KEYMAP`], with [`VSCODE`]'s rows over the same keys
/// under the Feel vscode.
pub fn shortcuts(feel: FeelName) -> Vec<Shortcut> {
    let over: &[Shortcut] = if feel == FeelName::Vscode {
        VSCODE
    } else {
        &[]
    };
    KEYMAP
        .iter()
        .filter(|s| over.iter().all(|o| o.trigger != s.trigger))
        .chain(over)
        .copied()
        .collect()
}

/// A key the Feel in force took over from [`KEYMAP`] (the menu bar's items still mean
/// WebStorm's action: `crate::app`).
pub fn vscode_took(k: &Keystroke, cx: &App) -> bool {
    static TOOK: std::sync::LazyLock<Vec<Keystroke>> = std::sync::LazyLock::new(|| {
        VSCODE
            .iter()
            .filter(|v| KEYMAP.iter().any(|s| s.trigger == v.trigger))
            .filter_map(|v| super::swedish::keystroke(v.trigger))
            .collect()
    });
    feel(cx) == FeelName::Vscode && TOOK.iter().any(|g| same(g, k))
}

/// The keys of `feel`'s shortcuts `owner` acts on.
fn keys_of(feel: FeelName, owner: Owner) -> Vec<Keystroke> {
    shortcuts(feel)
        .iter()
        .filter(|s| s.owner == owner)
        .filter_map(|s| super::swedish::keystroke(s.trigger))
        .collect()
}

/// The same key (arrow keys carry the Fn flag on macOS: not compared).
fn same(g: &Keystroke, k: &Keystroke) -> bool {
    let (gm, m) = (g.modifiers, k.modifiers);
    (gm.platform, gm.control, gm.alt, gm.shift) == (m.platform, m.control, m.alt, m.shift)
        && g.key.eq_ignore_ascii_case(&k.key)
}

/// Per Feel: `[VimStorm / WebStorm, VS Code]`.
fn by_feel(feel: FeelName) -> usize {
    usize::from(feel == FeelName::Vscode)
}

/// Tool windows: Ctrl keys there move nothing of their own, so the editor's global Ctrl shortcuts
/// (tabs, bookmark jumps) still work, as they did from the Lua tree. In popups, pickers and text
/// fields Ctrl keys edit text or the list: not forwarded.
const TOOL_WINDOWS: &[&str] = &["tree", "git"];

/// Whether a key the focused native `surface` didn't handle goes on to nvim: the global Cmd
/// shortcuts ([`global_cmd`]), Ctrl+Tab / Ctrl+Shift+Tab (the switcher) and, from a tool window,
/// Ctrl+← / → and Ctrl+1..9 ([`Owner::Global`]). The rest would act on the editor buffer behind
/// the surface (Cmd+Z, Cmd+Alt+Z, Cmd+D, Ctrl+W ...): swallowed.
pub fn forward_from_surface(surface: &str, k: &Keystroke, cx: &App) -> bool {
    forward_from_surface_in(feel(cx), surface, k)
}

/// [`forward_from_surface`] under `feel`.
pub fn forward_from_surface_in(feel: FeelName, surface: &str, k: &Keystroke) -> bool {
    let m = k.modifiers;
    if m.platform {
        return global_cmd_in(feel, k);
    }
    if !m.control || m.alt {
        return false;
    }
    let tool = TOOL_WINDOWS.contains(&surface);
    match k.key.as_str() {
        "tab" => true,
        "left" | "right" => tool && !m.shift,
        d if !m.shift && d.len() == 1 && d.as_bytes()[0].is_ascii_digit() && d != "0" => tool,
        // the Feel's own Ctrl keys (vscode's Ctrl+Shift+G): from the terminal and the Chat
        // column too
        _ => (tool || matches!(surface, "terminal" | "chat")) && feel_ctrl_key_in(feel, k),
    }
}

/// A Ctrl key of the Feel's own that is nvim's from a native surface too (vscode's Ctrl+Shift+G).
pub fn feel_ctrl_key(k: &Keystroke, cx: &App) -> bool {
    feel_ctrl_key_in(feel(cx), k)
}

fn feel_ctrl_key_in(feel: FeelName, k: &Keystroke) -> bool {
    VSCODE_GLOBAL[by_feel(feel)].iter().any(|g| same(g, k))
}

/// The Feel vscode's [`Owner::Global`] rows ([`KEYMAP`]'s are the cases above).
static VSCODE_GLOBAL: std::sync::LazyLock<[Vec<Keystroke>; 2]> = std::sync::LazyLock::new(|| {
    let vscode = VSCODE
        .iter()
        .filter(|s| s.owner == Global)
        .filter_map(|s| super::swedish::keystroke(s.trigger))
        .collect();
    [Vec::new(), vscode]
});

/// A Cmd key that does the same from anywhere: an [`Owner::Nvim`] entry (tool windows, pickers,
/// save all, commit / push, the focused pane's tabs). [`Owner::Editor`] keys and Cmd keys no
/// shortcut uses aren't (nvim's current window is the editor split behind the surface).
pub fn global_cmd(k: &Keystroke, cx: &App) -> bool {
    global_cmd_in(feel(cx), k)
}

/// [`global_cmd`] under `feel`.
pub fn global_cmd_in(feel: FeelName, k: &Keystroke) -> bool {
    static GLOBAL: std::sync::LazyLock<[Vec<Keystroke>; 2]> = std::sync::LazyLock::new(|| {
        [FeelName::Vimstorm, FeelName::Vscode].map(|f| {
            keys_of(f, Nvim)
                .into_iter()
                .filter(|g| g.modifiers.platform)
                .collect()
        })
    });
    k.modifiers.platform && GLOBAL[by_feel(feel)].iter().any(|g| same(g, k))
}

/// The jump key ⌃L (Linked): whether it is its ⌃⌥ form (taken in an nvim split and a PTY too).
pub fn jump_of(k: &Keystroke) -> Option<bool> {
    let m = k.modifiers;
    if !m.control || m.platform || m.shift || m.function || k.key != "l" {
        return None;
    }
    Some(m.alt)
}

/// A Cmd key the window itself owns ([`Owner::Window`]: ⌘4, ⌘Q, ⌘, …), handled before any
/// surface.
pub fn window_cmd(k: &Keystroke, cx: &App) -> bool {
    window_cmd_in(feel(cx), k)
}

/// [`window_cmd`] under `feel` (vscode's ⌘T is Go to Symbol, not the bottom pane's Terminal).
pub fn window_cmd_in(feel: FeelName, k: &Keystroke) -> bool {
    static WINDOW: std::sync::LazyLock<[Vec<Keystroke>; 2]> = std::sync::LazyLock::new(|| {
        [FeelName::Vimstorm, FeelName::Vscode].map(|f| {
            keys_of(f, Window)
                .into_iter()
                .filter(|g| g.modifiers.platform)
                .collect()
        })
    });
    k.modifiers.platform && WINDOW[by_feel(feel)].iter().any(|g| same(g, k))
}

#[cfg(test)]
mod tests {
    use super::super::swedish::keystroke;
    use super::*;
    use FeelName::{Vimstorm, Vscode, Webstorm};

    fn key(trigger: &str) -> Keystroke {
        keystroke(trigger).expect(trigger)
    }

    fn rows(feel: FeelName, trigger: &str) -> Vec<(&'static str, Owner)> {
        shortcuts(feel)
            .into_iter()
            .filter(|s| s.trigger == trigger)
            .map(|s| (s.action, s.owner))
            .collect()
    }

    #[test]
    fn every_trigger_is_a_key_on_the_swedish_layout() {
        for sc in KEYMAP.iter().chain(VSCODE) {
            assert!(keystroke(sc.trigger).is_some(), "{}", sc.trigger);
        }
    }

    /// (feel, trigger, its row: a word of the action and its owner; None: no row)
    type Row = (FeelName, &'static str, Option<(&'static str, Owner)>);

    const ROWS: &[Row] = &[
        // ⌘1 the tree, ⌘2 the open file (nvim's), ⌘3 Git, ⌘J the bottom panel, ⌘4 Chat; ⌘5 ⌘6 ⌘7
        // are gone (the rail)
        (
            Vimstorm,
            "super+digit_1",
            Some(("Project tool window", Window)),
        ),
        (Vimstorm, "super+digit_2", Some(("open file", Nvim))),
        (Vimstorm, "super+digit_3", Some(("Git tool window", Window))),
        (Webstorm, "super+digit_3", Some(("Git tool window", Window))),
        (Vscode, "super+digit_3", Some(("Git tool window", Window))),
        (Vimstorm, "super+j", Some(("Bottom panel", Window))),
        (Vscode, "super+j", Some(("Bottom panel", Window))),
        (Vimstorm, "super+digit_7", None),
        (Vimstorm, "super+ctrl+arrow_left", Some(("Chat", Window))),
        (
            Vimstorm,
            "super+ctrl+arrow_right",
            Some(("Claude Code", Window)),
        ),
        (Vimstorm, "super+alt+arrow_right", Some(("Next tab", Nvim))),
        // the rail and the pages are the window's
        (Vimstorm, "super+arrow_up", Some(("Rail", Window))),
        (Vimstorm, "super+arrow_left", Some(("the Board", Window))),
        (Vimstorm, "super+§", Some(("Abe", Window))),
        (Vimstorm, "ctrl+digit_1", Some(("Page: Code", Window))),
        (Vimstorm, "ctrl+digit_3", Some(("Page: Card", Window))),
        (Vimstorm, "ctrl+digit_5", None),
        (Vimstorm, "super+shift+digit_2", Some(("maximized", Window))),
        (Vimstorm, "super+digit_4", Some(("Chat", Window))),
        (Vimstorm, "super+t", Some(("", Window))),
        (Vimstorm, "super+shift+d", Some(("", Window))),
        (Vimstorm, "super+alt+a", Some(("The Board", Window))),
        (Vimstorm, "super+alt+enter", Some(("", Window))),
        (Vimstorm, "ctrl+w", None),
        (Vimstorm, "ctrl+i", None),
        (Vimstorm, "ctrl+l", Some(("", Window))),
        (Vimstorm, "ctrl+alt+w", None),
        (Vimstorm, "ctrl+alt+i", None),
        (Vimstorm, "ctrl+alt+l", Some(("", Window))),
        // VS Code's chords go over the WebStorm rows with their key
        (Vscode, "super+shift+k", Some(("Delete line", Editor))),
        (Webstorm, "super+shift+k", Some(("Push", Nvim))),
        (Vscode, "super+t", Some(("Go to Symbol in Workspace", Nvim))),
        // retired: ⌘9 Git (the bottom panel's Git now), ⌘G Copilot inline chat, ⌃⌘⏎ maximize (⌥⌘⏎ now)
        (Vimstorm, "super+digit_9", None),
        (Vimstorm, "super+g", None),
        (Vimstorm, "ctrl+super+enter", None),
        (Vimstorm, "super+ctrl+enter", None),
        (Webstorm, "super+digit_9", None),
        (Webstorm, "super+g", None),
        (Webstorm, "ctrl+super+enter", None),
        (Webstorm, "super+ctrl+enter", None),
        (Vscode, "super+digit_9", None),
        (Vscode, "super+g", None),
        (Vscode, "ctrl+super+enter", None),
        (Vscode, "super+ctrl+enter", None),
    ];

    #[test]
    fn a_key_has_one_owner_per_feel_or_none() {
        for &(feel, trigger, want) in ROWS {
            let got = rows(feel, trigger);
            match want {
                Some((action, owner)) => {
                    assert_eq!(got.len(), 1, "{trigger} in {feel:?}: {got:?}");
                    assert!(got[0].0.contains(action), "{trigger} in {feel:?}: {got:?}");
                    assert_eq!(got[0].1, owner, "{trigger} in {feel:?}");
                }
                None => assert_eq!(got, [], "{trigger} in {feel:?}"),
            }
        }
    }

    #[test]
    fn feel_vscode_keeps_every_webstorm_row_it_does_not_override() {
        assert_eq!(shortcuts(Webstorm).len(), KEYMAP.len());
        assert!(shortcuts(Vscode).len() > KEYMAP.len());
        for sc in KEYMAP {
            if VSCODE.iter().all(|v| v.trigger != sc.trigger) {
                assert_eq!(rows(Vscode, sc.trigger), [(sc.action, sc.owner)]);
            }
        }
    }

    /// (feel, trigger, the window handles it)
    const WINDOW_CMDS: &[(FeelName, &str, bool)] = &[
        (Vimstorm, "super+digit_1", true),
        (Vimstorm, "super+digit_2", false),
        (Vimstorm, "super+digit_3", true),
        (Vimstorm, "super+j", true),
        (Vimstorm, "super+ctrl+arrow_left", true),
        (Vimstorm, "super+digit_4", true),
        (Vimstorm, "super+§", true),
        (Vimstorm, "super+t", true),
        (Vimstorm, "super+shift+d", true),
        (Webstorm, "super+t", true),
        (Vscode, "super+t", false),
        (Vscode, "super+digit_4", true),
        (Vscode, "super+digit_1", true),
        (Vscode, "super+shift+e", true),
    ];

    #[test]
    fn the_window_handles_its_own_cmd_keys_per_feel() {
        for &(feel, trigger, want) in WINDOW_CMDS {
            assert_eq!(
                window_cmd_in(feel, &key(trigger)),
                want,
                "{trigger} in {feel:?}"
            );
        }
    }

    const ANY_SURFACE: &[&str] = &[
        "tree", "git", "popups", "pickers", "floats", "terminal", "pane",
    ];
    const TEXT_SURFACES: &[&str] = &["tree", "git", "popups"];
    const NOT_TOOL_WINDOWS: &[&str] = &["popups", "pickers", "floats"];

    /// (feel, surfaces, triggers, nvim gets them from those surfaces)
    const FORWARDS: &[(FeelName, &[&str], &[&str], bool)] = &[
        // global Cmd keys and the switcher reach nvim from any surface
        (
            Vimstorm,
            ANY_SURFACE,
            &[
                "super+o",
                "super+shift+f",
                "super+shift+o",
                "super+digit_2",
                "super+shift+t",
                "super+s",
                "super+k",
                "super+shift+k",
                "super+alt+arrow_left",
                "ctrl+tab",
                "ctrl+shift+tab",
            ],
            true,
        ),
        // global Ctrl keys reach nvim from the tool windows only
        (
            Vimstorm,
            NOT_TOOL_WINDOWS,
            &["ctrl+arrow_left", "ctrl+arrow_right", "ctrl+digit_6"],
            false,
        ),
        // the window's keys stay in the terminal
        (
            Vimstorm,
            &["terminal"],
            &[
                "super+digit_1",
                "super+digit_3",
                "super+j",
                "super+digit_4",
                "super+ctrl+arrow_left",
                "super+t",
                "super+shift+d",
            ],
            false,
        ),
        // unused Cmd keys do nothing in nvim either; ⌘B and ⌘P stay the editor's
        (
            Vimstorm,
            &["tree"],
            &[
                "super+n",
                "super+digit_8",
                "super+e",
                "super+b",
                "super+p",
                "ctrl+shift+´",
            ],
            false,
        ),
        // ⌘⇧K is Push from anywhere
        (Vimstorm, &["tree"], &["super+shift+k"], true),
        // text editing keys stay with the surface
        (
            Vimstorm,
            TEXT_SURFACES,
            &[
                "ctrl+w",
                "ctrl+a",
                "ctrl+u",
                "ctrl+shift+arrow_left",
                "ctrl+digit_0",
                "ctrl+shift+digit_1",
                "ctrl+alt+arrow_left",
                "alt+arrow_left",
                "arrow_left",
                "ctrl+alt+tab",
                "a",
                "escape",
                "tab",
            ],
            false,
        ),
        // VS Code's global keys reach nvim from any surface, its editor keys never
        (
            Vscode,
            &["tree", "git", "popups", "pickers", "terminal"],
            &[
                "super+p",
                "super+shift+p",
                "super+b",
                "super+t",
                "super+k",
                "super+s",
                "super+alt+s",
                "super+alt+arrow_left",
                "super+shift+f",
            ],
            true,
        ),
        (
            Vscode,
            &["tree", "git", "popups", "pickers", "terminal"],
            &[
                "super+shift+k",
                "super+shift+o",
                "super+d",
                "super+w",
                "super+.",
                "super+alt+shift+digit_7",
                // Find Previous, VS Code's too (Source Control is ⌃⇧G)
                "super+shift+g",
                "super+alt+f",
            ],
            false,
        ),
        // VS Code's Ctrl+Shift+G from a tool window, as Ctrl+→ is (its Ctrl+` is the window's,
        // taken before any surface)
        (
            Vscode,
            &["tree", "git", "terminal", "chat"],
            &["ctrl+shift+g"],
            true,
        ),
        (
            Vscode,
            &["popups"],
            &["ctrl+shift+´", "ctrl+shift+g"],
            false,
        ),
    ];

    #[test]
    fn a_key_reaches_nvim_from_a_surface_or_stays_there() {
        for &(feel, surfaces, triggers, want) in FORWARDS {
            for &surface in surfaces {
                for &t in triggers {
                    assert_eq!(
                        forward_from_surface_in(feel, surface, &key(t)),
                        want,
                        "{t} from {surface} in {feel:?}"
                    );
                }
            }
        }
        for sc in KEYMAP.iter().filter(|s| s.owner == Global) {
            for tool in TOOL_WINDOWS {
                assert!(
                    forward_from_surface_in(Vimstorm, tool, &key(sc.trigger)),
                    "global {} from {tool}",
                    sc.trigger
                );
            }
        }
        for sc in KEYMAP
            .iter()
            .filter(|s| s.owner == Editor && s.trigger.contains("super+"))
        {
            for surface in ["tree", "git", "popups", "pickers", "floats", "terminal"] {
                assert!(
                    !forward_from_surface_in(Vimstorm, surface, &key(sc.trigger)),
                    "editor {} from {surface}",
                    sc.trigger
                );
            }
        }
    }

    #[test]
    fn the_two_jump_keys_and_nothing_near_them() {
        for (t, want) in [
            // ⌃W's workspace jump is the rail's ⌘→ now; ⌃I's Card page is ⏎ on a card
            ("ctrl+w", None),
            ("ctrl+i", None),
            ("ctrl+l", Some(false)),
            ("ctrl+alt+w", None),
            ("ctrl+alt+i", None),
            ("ctrl+alt+l", Some(true)),
            ("ctrl+shift+l", None),
            ("super+w", None),
            ("super+alt+w", None),
            ("ctrl+ö", None),
            ("w", None),
            ("tab", None),
            ("ctrl+tab", None),
        ] {
            assert_eq!(jump_of(&key(t)), want, "{t}");
        }
    }
}
