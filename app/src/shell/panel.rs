//! Code's bottom panel (README "Layout"): Terminal · Git · Problems in the bottom tool window
//! (`config/bottom.lua`: one of them shows at a time, one height, dragged at its top gap). Each
//! host draws the panel's tabs first in its header ([`lead`]), then its own (the Terminal's
//! shells, Git's Local Changes · Log), and ⤢ ([`ToolAction`] `maximize`: fills the middle, as
//! ⌥⌘⏎) and Hide at its right end. It shows on Code only (Run and Card are the Factory view's).
//!
//! Keys (the window's pane keys, [`super::PaneKey`]): ⌘3 shows it on Git with the keys (on another
//! tab: switches to Git), gives it the keys, again (it has them) hides it; ⌘T and ⌃` the same on
//! its Terminal. ⌘J shows it on its last tab (with the keys) or hides it. A hide keeps its tab and height. The keyboard-move guard
//! holds: the host nvim is asked to show with the keys takes them only if nothing moved them
//! meanwhile ([`super::hosted::keys_moved`]).
//!
//! Each workspace keeps it ([`PanelMemo`]: shown or not, its tab, its height as a share of the
//! rows), with its page in `workspace-pages.json`; a new one starts hidden.

use gpui_kit::{App, Context, Window};
use rmpv::Value;
use serde::{Deserialize, Serialize};

use super::layout::{Island, Role};
use super::{Surface as _, SurfaceCx, Workspace, pane::PaneHost};
use crate::git::window::GitView;
use crate::kit::{IconName, LeadItem, PaneLead, ToolAction};
use crate::nvim::lua;
use crate::terminal::TerminalView;

const LUA: &str = "config.app.pane";

/// A tab of Code's bottom panel, in its header's order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelTab {
    /// The workspace's shells ([`TerminalView`]).
    #[default]
    Terminal,
    /// The Git tool window ([`GitView`]: Local Changes · Log).
    Git,
    /// The workspace's diagnostics ([`PaneHost`]'s Problems).
    Problems,
}

impl PanelTab {
    pub const ALL: [PanelTab; 3] = [PanelTab::Terminal, PanelTab::Git, PanelTab::Problems];

    /// Lua's name (`config/app/pane.lua` `show`).
    pub fn slug(self) -> &'static str {
        match self {
            PanelTab::Terminal => "terminal",
            PanelTab::Git => "git",
            PanelTab::Problems => "problems",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PanelTab::Terminal => "Terminal",
            PanelTab::Git => "Git",
            PanelTab::Problems => "Problems",
        }
    }

    fn icon(self) -> IconName {
        match self {
            PanelTab::Terminal => IconName::ToolWindowTerminal,
            PanelTab::Git => IconName::ToolWindowVcs,
            PanelTab::Problems => IconName::ToolWindowProblems,
        }
    }

    /// Its host window's role in the layout.
    pub fn role(self) -> Role {
        match self {
            PanelTab::Terminal => Role::Terminal,
            PanelTab::Git => Role::Git,
            PanelTab::Problems => Role::Pane,
        }
    }

    /// The tab whose surface `name` is (the keyboard there).
    pub fn of_surface(name: &str) -> Option<PanelTab> {
        match name {
            TerminalView::NAME => Some(PanelTab::Terminal),
            GitView::NAME => Some(PanelTab::Git),
            PaneHost::NAME => Some(PanelTab::Problems),
            _ => None,
        }
    }
}

/// What a workspace keeps of its panel: shown or not, its tab, its height (a share of the rows;
/// none: never sized, a third).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PanelMemo {
    pub shown: bool,
    #[serde(default)]
    pub tab: PanelTab,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<f32>,
}

/// The panel's tabs as each host's header leads with them, `shown` boxed.
pub fn lead(shown: PanelTab) -> PaneLead {
    PaneLead {
        selected: PanelTab::ALL.iter().position(|t| *t == shown),
        tabs: PanelTab::ALL
            .into_iter()
            .map(|t| LeadItem {
                icon: Some(t.icon()),
                tooltip: Some(
                    match t {
                        PanelTab::Terminal => "Terminal · ⌘T",
                        PanelTab::Git => "Git · ⌘3",
                        PanelTab::Problems => "Problems",
                    }
                    .into(),
                ),
                ..LeadItem::new(t.slug(), t.label())
            })
            .collect(),
    }
}

/// A host's header's lead tab `ix` pressed: that tab with the keys.
pub fn picked(scx: &SurfaceCx, ix: usize) {
    if let Some(tab) = PanelTab::ALL.get(ix) {
        scx.navigate(LUA, "show", vec![Value::from(tab.slug())]);
    }
}

/// The header's ⤢ (fills the middle; again restores) and Hide (⌘J), each host's last actions.
pub fn actions() -> [ToolAction; 2] {
    [
        ToolAction::new("maximize", IconName::Maximize, "Maximize").shortcut("⌥⌘⏎"),
        ToolAction::new("hide", IconName::Hide, "Hide").shortcut("⌘J"),
    ]
}

/// ⤢ in a host's header: the panel fills the middle, or back.
pub fn maximize(scx: &SurfaceCx, cx: &mut App) {
    let ws = scx.workspace.clone();
    cx.defer(move |cx| {
        let _ = ws.update(cx, |w, cx| w.maximize_panel(cx));
    });
}

impl Workspace {
    /// The panel's tab shown, none while it is hidden.
    pub fn panel_shown(&self, cx: &App) -> Option<PanelTab> {
        if self.terminal.read(cx).shown() {
            Some(PanelTab::Terminal)
        } else if self.git.read(cx).is_open() {
            Some(PanelTab::Git)
        } else if self.pane.read(cx).is_open() {
            Some(PanelTab::Problems)
        } else {
            None
        }
    }

    /// The panel has the keys.
    pub fn panel_has_keys(&self, window: &Window, cx: &App) -> bool {
        self.focused_surface(window, cx)
            .and_then(PanelTab::of_surface)
            .is_some()
    }

    /// The panel as it is now (its height while shown; none while hidden).
    pub fn panel_memo(&self, cx: &App) -> PanelMemo {
        let shown = self.panel_shown(cx);
        let geo = self.geometry.get();
        let rows = geo.layout.screen.1.max(1) as f32;
        let share = shown
            .and_then(|t| geo.role_rect(t.role()))
            .map(|r| r.logical.3 as f32 / rows)
            .filter(|s| *s > 0. && *s < 1.);
        PanelMemo {
            shown: shown.is_some(),
            tab: shown.unwrap_or(self.panel_last),
            share,
        }
    }

    /// The panel as `memo` keeps it (the workspace first shown after a launch): shown on its tab
    /// without the keys at its height, or hidden.
    pub fn apply_panel(&mut self, memo: PanelMemo, _cx: &mut Context<Self>) {
        self.panel_last = memo.tab;
        let tab = if memo.shown {
            Value::from(memo.tab.slug())
        } else {
            Value::Nil
        };
        let share = memo.share.map_or(Value::Nil, |s| Value::from(f64::from(s)));
        lua::call(&self.rpc, LUA, "restore_panel", vec![tab, share]);
    }

    /// The panel on `tab` (none: the one shown, else its last) with the keys, never hidden.
    pub fn panel_show(
        &mut self,
        tab: Option<PanelTab>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tab = tab
            .or_else(|| self.panel_shown(cx))
            .unwrap_or(self.panel_last);
        self.panel_last = tab;
        // asked with the keys: they stay where a later move puts them before nvim answers
        super::hosted::keys_moved(cx);
        match tab {
            PanelTab::Terminal => self.terminal.update(cx, |t, cx| t.keys_asked(cx)),
            PanelTab::Problems => self.pane.update(cx, |p, cx| p.keys_asked(cx)),
            PanelTab::Git => {}
        }
        lua::navigate(&self.rpc, LUA, "panel", vec![Value::from(tab.slug())]);
        cx.notify();
    }

    /// ⌘J: the panel hidden, else shown with the keys.
    pub fn panel_toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.panel_shown(cx).is_none() {
            return self.panel_show(None, window, cx);
        }
        self.panel_hide(cx);
    }

    /// The panel hidden (a maximized one restored first), its height and tab kept; the keys back
    /// to the code when it had them (⌘J, a pane key with the keys there).
    pub fn panel_hide(&mut self, cx: &mut Context<Self>) {
        if matches!(self.maximized(cx), Some(Island::Bottom(_))) {
            self.restore_maximized(cx);
        }
        super::hosted::keys_moved(cx);
        lua::call(&self.rpc, LUA, "hide_panel", vec![]);
        cx.notify();
    }

    /// ⤢: the shown panel fills the middle (as ⌥⌘⏎ with its keys), or back.
    pub fn maximize_panel(&mut self, cx: &mut Context<Self>) {
        if matches!(self.maximized(cx), Some(Island::Bottom(_))) {
            self.restore_maximized(cx);
            return;
        }
        let Some(win) = self
            .panel_shown(cx)
            .and_then(|t| self.geometry.get().role_rect(t.role()).map(|r| r.win))
        else {
            return;
        };
        self.editor
            .update(cx, |e, cx| e.set_maximized(Some(Island::Bottom(win)), cx));
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tabs_are_terminal_git_problems() {
        let lead = lead(PanelTab::Git);
        assert_eq!(lead.selected, Some(1));
        let names: Vec<&str> = lead.tabs.iter().map(|t| t.label.as_ref()).collect();
        assert_eq!(names, ["Terminal", "Git", "Problems"]);
    }
}
