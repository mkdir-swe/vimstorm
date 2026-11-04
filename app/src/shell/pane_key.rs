//! The View pane keys, as WebStorm's tool-window keys: ⌘1 the Project tree (the Feel vscode's
//! ⌘⇧E too), ⌘3 Git (Code's bottom panel's Git tab), ⌘4 Chat, ⌘T Code's bottom panel's Terminal
//! (⌃`, Swedish ⌃⇧´, too; the Feel vscode's ⌘T is Go to Symbol). Each one: the pane hidden, shown
//! with the keys; shown without them, the keys; with them, hidden, the keys back to the code (in
//! the Factory view: its main pane). ⌘3 and ⌘T find their tab: the panel on another one is their
//! pane hidden (⌘3 over the Terminal switches to Git, ⌘T over Git to the Terminal). ⌘2 (the open
//! file, the page's main pane) has no hide: not a pane key; ⌘J shows / hides the panel.
//!
//! The window takes them before nvim and any surface: [`super::projects::Projects`] (and a bare
//! workspace) asks [`PaneKey::of`], reads the pane's [`PaneState`] and does its [`PaneAct`]. Off
//! the code (Run, Card, the Board, Boxes, Pipelines) ⌘1 gives the page's left pane the keys (it
//! never hides), ⌘3 and ⌘T show Code with its panel on Git / the Terminal.

use gpui_kit::{App, Context, Keystroke, Window};

use super::panel::PanelTab;
use super::tree::TreeView;
use super::{Surface as _, Workspace, column};
use crate::factory::FeelName;
use crate::nvim::lua;

/// A pane key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneKey {
    /// ⌘1 (Feel vscode: ⌘⇧E too): the Project tree; off the code, the page's left pane.
    Project,
    /// ⌘3: Code's bottom panel on its Git (outside a git repository Git is passed over: its
    /// Problems).
    Git,
    /// ⌘4: the Chat column in its mode.
    Chat,
    /// ⌘T, ⌃`: Code's bottom panel on its Terminal.
    Terminal,
}

/// A pane as its key finds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneState {
    /// Hidden (Git, the Terminal: the panel hidden or on another tab).
    Closed,
    /// Shown, the keys elsewhere.
    Open,
    /// Shown with the keys.
    Focused,
}

/// What a pane key does to its pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneAct {
    /// Shown (at its kept size, on its kept tab) with the keys.
    Open,
    /// The keys to it.
    Focus,
    /// Hidden, the keys back to the code (the Factory view's main pane).
    Hide,
}

impl PaneState {
    /// `open`, with the keys when `keys`.
    pub fn of(open: bool, keys: bool) -> PaneState {
        match (open, keys) {
            (false, _) => PaneState::Closed,
            (true, false) => PaneState::Open,
            (true, true) => PaneState::Focused,
        }
    }

    /// Its key's act (every pane key's alike).
    pub fn act(self) -> PaneAct {
        match self {
            PaneState::Closed => PaneAct::Open,
            PaneState::Open => PaneAct::Focus,
            PaneState::Focused => PaneAct::Hide,
        }
    }
}

impl PaneKey {
    /// The pane key Lua names (`config/keys.lua`: a key of yours for its action).
    pub fn named(name: &str) -> Option<PaneKey> {
        match name {
            "project" => Some(PaneKey::Project),
            // "panel": ⌘3's name before it was Git's
            "git" | "panel" => Some(PaneKey::Git),
            "chat" => Some(PaneKey::Chat),
            "terminal" => Some(PaneKey::Terminal),
            _ => None,
        }
    }

    /// The bottom panel's tab the key is for (none: not a panel key).
    pub fn tab(self) -> Option<PanelTab> {
        match self {
            PaneKey::Git => Some(PanelTab::Git),
            PaneKey::Terminal => Some(PanelTab::Terminal),
            PaneKey::Project | PaneKey::Chat => None,
        }
    }

    /// A panel key's pane as Code's bottom panel shows (none: not a panel key): `shown` its tab
    /// (none: hidden), `keys` it has them, `repo` the workspace is in a git repository (outside one
    /// Git is passed over, so ⌘3 finds its pane on Problems). On another tab: hidden.
    pub fn in_panel(self, shown: Option<PanelTab>, keys: bool, repo: bool) -> Option<PaneState> {
        let tab = match self.tab()? {
            PanelTab::Git if !repo => PanelTab::Problems,
            tab => tab,
        };
        Some(PaneState::of(shown == Some(tab), keys))
    }

    /// The pane key `k` is under the Feel in force.
    pub fn of(k: &Keystroke, cx: &App) -> Option<PaneKey> {
        Self::of_in(crate::editor::input::feel(cx), k)
    }

    /// [`PaneKey::of`] under `feel`.
    pub fn of_in(feel: FeelName, k: &Keystroke) -> Option<PaneKey> {
        let m = k.modifiers;
        if m.alt || m.function {
            return None;
        }
        // ⌃` (Swedish ⌃⇧´)
        if m.control && !m.platform {
            return (k.key == "`" || m.shift && k.key == "´").then_some(PaneKey::Terminal);
        }
        if !m.platform || m.control {
            return None;
        }
        match (k.key.to_lowercase().as_str(), m.shift) {
            ("1", false) => Some(PaneKey::Project),
            ("e", true) if feel == FeelName::Vscode => Some(PaneKey::Project),
            ("3", false) => Some(PaneKey::Git),
            ("4", false) => Some(PaneKey::Chat),
            ("t", false) if feel != FeelName::Vscode => Some(PaneKey::Terminal),
            _ => None,
        }
    }
}

/// A window key waiting for nvim to handle the keys typed before ([`Workspace::column_key`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Queued {
    Column(column::ColumnKey),
    /// A pane key but Chat's (that is [`column::ColumnKey::Chat`]).
    Pane(PaneKey),
}

impl Workspace {
    /// `pane`'s key on Code (a projects window's for its shown workspace, a bare window's own):
    /// its [`PaneAct`], read once nvim handled the keys typed before (a focus change they make
    /// comes first), as when ⌘1 was nvim's.
    pub fn pane_key(&mut self, pane: PaneKey, window: &mut Window, cx: &mut Context<Self>) {
        let key = match pane {
            PaneKey::Chat => Queued::Column(column::ColumnKey::Chat),
            _ => Queued::Pane(pane),
        };
        self.queue_key(key, window, cx);
    }

    /// `pane`'s act now (Chat's is the column's: [`column::ColumnKey::run`]).
    pub(super) fn pane_act(&mut self, pane: PaneKey, window: &mut Window, cx: &mut Context<Self>) {
        let state = match pane {
            PaneKey::Chat => return,
            PaneKey::Project => PaneState::of(
                self.tree_open(cx),
                self.focused_surface(window, cx) == Some(TreeView::NAME),
            ),
            PaneKey::Git | PaneKey::Terminal => {
                let repo = pane == PaneKey::Git && self.in_git_repo();
                let (shown, keys) = (self.panel_shown(cx), self.panel_has_keys(window, cx));
                pane.in_panel(shown, keys, repo)
                    .unwrap_or(PaneState::Closed)
            }
        };
        match (pane, state.act()) {
            (PaneKey::Project, PaneAct::Hide) => {
                lua::call(&self.rpc, "config.tree", "close", vec![])
            }
            (PaneKey::Project, _) => lua::navigate(&self.rpc, "config.focus", "tree", vec![]),
            (_, PaneAct::Hide) => self.panel_hide(cx),
            // (Lua passes Git over outside a git repository)
            _ => self.panel_show(pane.tab(), window, cx),
        }
    }

    /// The project is in a git repository (as `git.cli`'s root finds one; a few stats, on ⌘3).
    fn in_git_repo(&self) -> bool {
        self.project().ancestors().any(|d| d.join(".git").exists())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use FeelName::{Vimstorm, Vscode, Webstorm};
    use PaneKey::{Chat, Git, Project, Terminal};
    use PaneState::{Closed, Focused, Open};

    /// (feel, key, the pane as the key finds it, the pane key and its act)
    type Row = (
        FeelName,
        &'static str,
        PaneState,
        Option<(PaneKey, PaneAct)>,
    );

    const ROWS: &[Row] = &[
        (Vimstorm, "cmd-1", Closed, Some((Project, PaneAct::Open))),
        (Vimstorm, "cmd-1", Open, Some((Project, PaneAct::Focus))),
        (Vimstorm, "cmd-1", Focused, Some((Project, PaneAct::Hide))),
        (Vimstorm, "cmd-3", Closed, Some((Git, PaneAct::Open))),
        (Vimstorm, "cmd-3", Open, Some((Git, PaneAct::Focus))),
        (Vimstorm, "cmd-3", Focused, Some((Git, PaneAct::Hide))),
        (Webstorm, "cmd-3", Focused, Some((Git, PaneAct::Hide))),
        (Vscode, "cmd-3", Focused, Some((Git, PaneAct::Hide))),
        (Vimstorm, "cmd-4", Closed, Some((Chat, PaneAct::Open))),
        (Vimstorm, "cmd-4", Open, Some((Chat, PaneAct::Focus))),
        (Vimstorm, "cmd-4", Focused, Some((Chat, PaneAct::Hide))),
        (Vimstorm, "cmd-t", Closed, Some((Terminal, PaneAct::Open))),
        (Vimstorm, "cmd-t", Open, Some((Terminal, PaneAct::Focus))),
        (Vimstorm, "cmd-t", Focused, Some((Terminal, PaneAct::Hide))),
        // ⌃` (Swedish ⌃⇧´) as ⌘T, under every Feel
        (Vimstorm, "ctrl-`", Closed, Some((Terminal, PaneAct::Open))),
        (Vimstorm, "ctrl-`", Open, Some((Terminal, PaneAct::Focus))),
        (Vimstorm, "ctrl-`", Focused, Some((Terminal, PaneAct::Hide))),
        (
            Vimstorm,
            "ctrl-shift-´",
            Focused,
            Some((Terminal, PaneAct::Hide)),
        ),
        (Vscode, "ctrl-`", Focused, Some((Terminal, PaneAct::Hide))),
        // the Feel vscode: ⌘⇧E as ⌘1; its ⌘T is Go to Symbol
        (
            Vscode,
            "cmd-shift-e",
            Closed,
            Some((Project, PaneAct::Open)),
        ),
        (Vscode, "cmd-shift-e", Open, Some((Project, PaneAct::Focus))),
        (
            Vscode,
            "cmd-shift-e",
            Focused,
            Some((Project, PaneAct::Hide)),
        ),
        (Vscode, "cmd-1", Focused, Some((Project, PaneAct::Hide))),
        (Vscode, "cmd-4", Focused, Some((Chat, PaneAct::Hide))),
        (Vscode, "cmd-t", Focused, None),
        (Webstorm, "cmd-t", Focused, Some((Terminal, PaneAct::Hide))),
        (Vimstorm, "cmd-shift-e", Focused, None),
        // ⌘2 has no hide; ⌘J shows / hides the panel; ⌘⇧T a new shell; the others' own
        (Vimstorm, "cmd-2", Focused, None),
        (Vimstorm, "cmd-j", Focused, None),
        (Vimstorm, "cmd-shift-t", Focused, None),
        (Vimstorm, "cmd-shift-3", Focused, None),
        (Vimstorm, "alt-cmd-4", Focused, None),
        (Vimstorm, "ctrl-cmd-1", Focused, None),
        (Vimstorm, "ctrl-1", Focused, None),
        (Vimstorm, "`", Focused, None),
    ];

    #[test]
    fn a_pane_key_opens_its_pane_then_focuses_it_then_hides_it() {
        for &(feel, key, state, want) in ROWS {
            let k = Keystroke::parse(key).unwrap();
            let got = PaneKey::of_in(feel, &k).map(|p| (p, state.act()));
            assert_eq!(got, want, "{key} in {feel:?}, {state:?}");
        }
        // Lua's names (a key of yours for its action); "panel" was ⌘3's before Git
        for pane in [Project, Git, Chat, Terminal] {
            let name = format!("{pane:?}").to_lowercase();
            assert_eq!(PaneKey::named(&name), Some(pane), "{name}");
        }
        assert_eq!(PaneKey::named("panel"), Some(Git));
        assert_eq!(PaneKey::named("editor"), None);
        // in the bottom panel: its tab shown (none: hidden), the panel has the keys, in a git
        // repository; the pane as the key finds it and its act
        let (git, term, problems) = (
            Some(PanelTab::Git),
            Some(PanelTab::Terminal),
            Some(PanelTab::Problems),
        );
        let panel: &[(PaneKey, Option<PanelTab>, bool, bool, PaneAct)] = &[
            (Git, None, false, true, PaneAct::Open),
            (Git, git, false, true, PaneAct::Focus),
            (Git, git, true, true, PaneAct::Hide),
            // ⌘3 over the Terminal or Problems: Git, not hidden
            (Git, term, true, true, PaneAct::Open),
            (Git, term, false, true, PaneAct::Open),
            (Git, problems, true, true, PaneAct::Open),
            // outside a git repository Git is passed over: Problems is ⌘3's
            (Git, None, false, false, PaneAct::Open),
            (Git, problems, false, false, PaneAct::Focus),
            (Git, problems, true, false, PaneAct::Hide),
            (Git, term, true, false, PaneAct::Open),
            (Terminal, None, false, true, PaneAct::Open),
            (Terminal, term, false, true, PaneAct::Focus),
            (Terminal, term, true, true, PaneAct::Hide),
            // ⌘T over Git or Problems: the Terminal, not hidden
            (Terminal, git, true, true, PaneAct::Open),
            (Terminal, git, false, true, PaneAct::Open),
            (Terminal, problems, true, false, PaneAct::Open),
        ];
        for &(pane, shown, keys, repo, want) in panel {
            let got = pane.in_panel(shown, keys, repo).map(PaneState::act);
            assert_eq!(got, Some(want), "{pane:?} on {shown:?}, {keys} {repo}");
        }
        assert_eq!(Project.in_panel(None, false, true), None);
        assert_eq!(Chat.in_panel(None, false, true), None);
        // as the pane reads: hidden, shown, shown with the keys (hidden with them: none to hide)
        for (open, keys, state) in [
            (false, false, Closed),
            (false, true, Closed),
            (true, false, Open),
            (true, true, Focused),
        ] {
            assert_eq!(PaneState::of(open, keys), state, "{open} {keys}");
        }
    }
}
