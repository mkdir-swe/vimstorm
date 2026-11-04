//! Each workspace's page (README "Layout"): Code, Run or Card, picked in its header (⌃1–⌃3, a
//! click) and shown again whenever the workspace is (the rail, ⌘↑ ⌘↓, ⌘→ from the Board). A
//! workspace never shown before lands on Run while its card runs, else on Code; one a file opens
//! in shows Code. Kept for the next launch with Code's bottom panel ([`crate::shell::PanelMemo`]:
//! shown or not, its tab, its height) and the session Chat was on in each, by what the tile
//! remembers ([`super::memory::TileMemory`]): first shown after a launch, a workspace's Chat opens
//! on that session again (one gone since: as without it), its panel as it was.
//!
//! Code is the editor (the tree and the splits) over its bottom panel (Terminal · Git · Problems,
//! [`crate::shell::panel`]). Run and Card are the Factory view's main slot on the bridge's `run` /
//! `card` screen. Abe (the repo's main checkout) has no card: no Run, no Card.
//!
//! The pane keys ([`PaneKey`], WebStorm's tool-window keys: hidden, shown with the keys; shown, the
//! keys; with them, hidden): ⌘1 the page's left pane (the tree; off the code Run's steps, the
//! story, the Board's, Boxes' or Pipelines' list, never hidden), ⌘3 Code's bottom panel's Git and ⌘T
//! its Terminal (from Run or Card: Code with it), ⌘4 Chat. ⌘2 its main one (the open file, Run's step,
//! the story) only takes the keys; ⌘J the panel shown / hidden; ⌃⌘← ⌃⌘→ are Chat's modes
//! ([`crate::shell::ColumnKey`]).

use std::collections::BTreeMap;
use std::path::Path;

use gpui_kit::{App, Context, Focusable as _, Keystroke, Window};

use super::Projects;
use crate::factory::{BridgeCommand, FIRST_SCREEN, RUN_SCREEN, Slot, WorkspaceState};
use crate::shell::{PaneKey, PanelTab};

/// The bridge's Card page (the story as a page) in the main slot.
pub const CARD_SCREEN: &str = "card";

/// A workspace's page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Code,
    Run,
    Card,
}

impl Page {
    /// In the header's order (⌃1–⌃3).
    pub const ALL: [Page; 3] = [Page::Code, Page::Run, Page::Card];

    /// Its name in `workspace-pages.json`.
    pub fn slug(self) -> &'static str {
        match self {
            Page::Code => "code",
            Page::Run => "run",
            Page::Card => "card",
        }
    }

    /// A kept slug; one from before the rail (`project`, `board`, `skills`) is none, so is one
    /// from before the panel (`terminal`, `git`: [`super::memory`] reads those as the code with
    /// it).
    pub fn parse(slug: &str) -> Option<Page> {
        Self::ALL.into_iter().find(|p| p.slug() == slug)
    }

    /// Its word in the header.
    pub fn name(self) -> &'static str {
        match self {
            Page::Code => "Code",
            Page::Run => "Run",
            Page::Card => "Card",
        }
    }

    /// Its key, as the header shows it.
    pub fn key(self) -> &'static str {
        match self {
            Page::Code => "⌃1",
            Page::Run => "⌃2",
            Page::Card => "⌃3",
        }
    }

    /// ⌃1–⌃3.
    pub fn of_key(k: &Keystroke) -> Option<Page> {
        let m = k.modifiers;
        if !m.control || m.platform || m.alt || m.shift || m.function {
            return None;
        }
        let n: usize = k.key.parse().ok()?;
        Self::ALL.get(n.checked_sub(1)?).copied()
    }

    /// A page Abe (the main checkout, no card) has.
    pub fn on_main(self) -> bool {
        self == Page::Code
    }
}

/// The page a workspace first shows: Run while its card's run works or waits on you, else the
/// code.
pub fn first_page(state: Option<WorkspaceState>) -> Page {
    match state {
        Some(WorkspaceState::Running | WorkspaceState::Starting | WorkspaceState::NeedsYou) => {
            Page::Run
        }
        _ => Page::Code,
    }
}

impl Projects {
    /// The shown workspace's page as it is now remembered (and saved when it changed). Not while
    /// a switch waits, on Welcome, or on a repo place (Board, Boxes, Pipelines).
    pub(super) fn note_page(&mut self, cx: &mut Context<Self>) {
        if self.welcome.is_some()
            || self.pending.is_some()
            || !matches!(self.tile_now(cx), super::rail::Tile::Workspace(_))
        {
            return;
        }
        let Some((real, ws)) = self
            .open
            .get(self.active)
            .filter(|o| o.run.is_some())
            .and_then(|o| Some((o.real.clone(), o.ws()?.clone())))
        else {
            return;
        };
        let page = self.page_now(cx);
        let tile = super::rail::Tile::Workspace(real);
        if self
            .memory
            .page_left(&tile, page, || ws.read(cx).panel_memo(cx))
        {
            self.save_set(cx);
        }
    }

    /// Chat says it is on `session` (`chat-session`): remembered for the shown workspace (and
    /// saved when it changed). Not while a switch waits, on Welcome, in a cloud workspace, or on a
    /// repo place (Board, Boxes, Pipelines: Chat is the selected card's there).
    pub(in crate::shell) fn chat_said(&mut self, session: Option<&str>, cx: &mut Context<Self>) {
        if self.welcome.is_some()
            || self.pending.is_some()
            || !matches!(self.tile_now(cx), super::rail::Tile::Workspace(_))
        {
            return;
        }
        let Some(real) = self
            .open
            .get(self.active)
            .filter(|o| o.remote.is_none())
            .map(|o| o.real.clone())
        else {
            return;
        };
        if self
            .memory
            .chat_said(&super::rail::Tile::Workspace(real), session)
        {
            self.save_set(cx);
        }
    }

    /// The page open project `ix` shows once shown: the code when a file opens in it, its own,
    /// else its first ([`first_page`]); never one only the bridge draws without an `abe` 2.x, nor
    /// Run or Card on the main checkout.
    pub(super) fn page_of(&mut self, ix: usize, cx: &App) -> Page {
        let Some(o) = self.open.get(ix) else {
            return Page::Code;
        };
        let real = o.real.clone();
        if self.editor_next.take().is_some_and(|r| r == real) {
            return Page::Code;
        }
        let kept = self.memory.page(&super::rail::Tile::Workspace(real));
        let page = kept.unwrap_or_else(|| {
            let box_ = o.remote.as_ref().map(|a| a.box_.name.as_str());
            first_page(crate::factory::feed_state_of(&o.dir, box_, cx))
        });
        let drawn = BridgeCommand::available(cx) || page == Page::Code;
        if (o.is_main() && !page.on_main()) || !drawn {
            return Page::Code;
        }
        page
    }

    /// The next show of `dir` shows the code (a file opens in it).
    pub(super) fn editor_next(&mut self, dir: &Path) {
        self.editor_next = Some(crate::shell::recent::real_path(dir));
    }

    /// The shown workspace's page as drawn (the code under a repo place).
    pub fn page_now(&self, cx: &App) -> Page {
        if !self.factory_shown {
            return Page::Code;
        }
        match self.factory().map(|f| f.read(cx).main_screen()) {
            Some(RUN_SCREEN) => Page::Run,
            Some(CARD_SCREEN) if self.card_page => Page::Card,
            _ => Page::Code,
        }
    }

    /// `page` shown in the shown workspace (the keyboard is the caller's): Run and Card the
    /// Factory view on the bridge's screen (Run opened anew, it is the workspace's; Card on its
    /// card), Code the Editor with its bottom panel as it was left.
    pub(super) fn show_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        let Some(o) = self.open.get(self.active) else {
            return;
        };
        let page = if o.is_main() && !page.on_main() {
            Page::Code
        } else {
            page
        };
        if o.ws().is_none() {
            return;
        }
        self.leave_pane_place(cx);
        let screen = match page {
            Page::Run => RUN_SCREEN,
            Page::Card => CARD_SCREEN,
            Page::Code => {
                self.card_page = false;
                self.leave_factory(window, cx);
                cx.notify();
                return;
            }
        };
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| v.start(window, cx));
        if !self.factory_shown {
            self.set_factory_shown_as(true, false, window, cx);
        }
        // Chat stays on the workspace's session on its pages (it follows the Board's card there)
        view.update(cx, |v, cx| v.set_chat_on_card(false, cx));
        self.card_page = page == Page::Card;
        let params = match (page, self.card_of(self.active, cx)) {
            (Page::Card, Some(card)) => BTreeMap::from([("card".to_owned(), card.to_string())]),
            _ => BTreeMap::new(),
        };
        view.update(cx, |v, cx| v.open_in(Slot::Main, screen, params, cx));
        cx.notify();
    }

    /// Boxes or Pipelines left: Esc in Chat gives the keys to the Factory view again.
    pub(super) fn leave_pane_place(&mut self, cx: &mut Context<Self>) {
        if self.pane_place.take().is_some()
            && let Some(view) = self.factory().cloned()
        {
            let board = view.focus_handle(cx);
            cx.set_global(crate::shell::column::BoardFocus(board));
        }
    }

    /// The keyboard to the shown page: the code (where nvim's current window is: a split, or
    /// the panel's tool window), the list of Boxes or Pipelines (the Factory view's pane), or the
    /// Factory view (Board, Run, Card).
    pub(super) fn page_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ws) = self.active().cloned() else {
            return;
        };
        crate::shell::hosted::keys_moved(cx);
        if self.factory_shown {
            let pane = self.pane_place.and(self.factory_pane_view().cloned());
            if let Some(pane) = pane {
                window.focus(&pane.focus_handle(cx), cx);
            } else if let Some(view) = self.factory().cloned() {
                window.focus(&view.focus_handle(cx), cx);
            }
            return;
        }
        ws.update(cx, |w, cx| w.focus_editor(window, cx));
    }

    /// ⌃1–⌃3 (a header click): `page` in the shown workspace with the keyboard; from a repo
    /// place, in the workspace you were in. Abe has no Run or Card: nothing.
    pub(super) fn page_key(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        if !self.go_to_page(page, window, cx) {
            return;
        }
        self.page_keys(window, cx);
        self.note_page(cx);
    }

    /// `page` shown in the shown workspace (from a repo place, in the workspace you were in), its
    /// Chat as the workspace left it; the keyboard stays the caller's. False when Abe has no such
    /// page (said on the status line).
    fn go_to_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(o) = self.open.get(self.active) else {
            return false;
        };
        if o.is_main() && !page.on_main() {
            self.say_browsed(Some(format!("Abe has no {} page", page.name())), cx);
            return false;
        }
        let tile = super::rail::Tile::Workspace(o.real.clone());
        // the page left keeps where the keys were (a place its Chat too)
        let from = self.tile_now(cx);
        self.remember_chat(&from, window, cx);
        self.memory.set_page(&tile, page);
        self.keep_chat_across_views(|p, window, cx| p.show_page(page, window, cx), window, cx);
        if !matches!(from, super::rail::Tile::Workspace(_)) {
            self.apply_chat(&tile, window, cx);
        }
        true
    }

    /// A pane key ([`PaneKey`]): on the code the shown workspace's (shown with the keys, the keys,
    /// hidden: [`crate::shell::Workspace::pane_key`]). Off it (Run, Card, a repo place) ⌘1 gives
    /// the page's left pane the keys, never hiding it (Run's steps, the Card page's story, the
    /// Board's, Boxes' or Pipelines' list: all the Factory view's keys there; the page stays); ⌘3 /
    /// ⌘T show Code with its panel on Git / the Terminal, with the keys; ⌘4 the view's Chat as on
    /// the code.
    pub(super) fn pane_key(&mut self, pane: PaneKey, window: &mut Window, cx: &mut Context<Self>) {
        let off_code = self.factory_shown && pane != PaneKey::Chat;
        if off_code && pane == PaneKey::Project {
            return self.page_keys(window, cx);
        }
        if off_code && !self.go_to_page(Page::Code, window, cx) {
            return;
        }
        let Some(ws) = self.active().cloned() else {
            return;
        };
        ws.update(cx, |w, cx| match (off_code, pane) {
            (true, _) => w.panel_show(pane.tab(), window, cx),
            (false, _) => w.pane_key(pane, window, cx),
        });
        if pane != PaneKey::Chat {
            self.note_page(cx);
        }
    }

    /// ⌘J: Code's bottom panel shown (with the keys) or hidden; from Run, Card or a repo place:
    /// Code with it.
    pub(super) fn panel_toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.factory_shown {
            if !self.go_to_page(Page::Code, window, cx) {
                return;
            }
            if let Some(ws) = self.active().cloned() {
                ws.update(cx, |w, cx| w.panel_show(None, window, cx));
            }
        } else if let Some(ws) = self.active().cloned() {
            ws.update(cx, |w, cx| w.panel_toggle(window, cx));
        }
        self.note_page(cx);
    }

    /// `tab` in Code's bottom panel with the keys (⌘T and ⌃` the Terminal, Linked's Git, a box's
    /// terminal tab); from Run, Card or a repo place: Code with it.
    pub(super) fn panel_on(&mut self, tab: PanelTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.factory_shown && !self.go_to_page(Page::Code, window, cx) {
            return;
        }
        if let Some(ws) = self.active().cloned() {
            ws.update(cx, |w, cx| w.panel_show(Some(tab), window, cx));
        }
        self.note_page(cx);
    }

    /// The workspace shown now was first shown since the launch: its bottom panel as it was kept.
    pub(super) fn apply_kept_panel(&mut self, cx: &mut Context<Self>) {
        let Some((real, ws)) = self
            .open
            .get(self.active)
            .and_then(|o| Some((o.real.clone(), o.ws()?.clone())))
        else {
            return;
        };
        let tile = super::rail::Tile::Workspace(real);
        if let Some(panel) = self.memory.take_unshown_panel(&tile) {
            ws.update(cx, |w, cx| w.apply_panel(panel, cx));
        }
    }

    /// The Board's ⏎ on a card (`workspace-page`): its workspace at `path` (opened when it isn't)
    /// on `page` (the one it last had when none is said), the keys where they were on that page
    /// as after a rail move. A folder that is not there: the Board on `card`.
    pub(in crate::shell) fn workspace_page(
        &mut self,
        path: &Path,
        card: u64,
        page: Option<Page>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tile = super::rail::Tile::Workspace(crate::shell::recent::real_path(path));
        if let Some(page) = page {
            self.memory.set_page(&tile, page);
        }
        let from = self.tile_now(cx);
        self.remember_chat(&from, window, cx);
        match self.index_of(path) {
            Some(ix) if ix == self.active => {
                let page = self.page_of(ix, cx);
                self.show_page(page, window, cx);
            }
            // (its show may wait on a resize: it lands there, as a rail move)
            Some(ix) => {
                self.arrive = Some(tile);
                self.activate(ix, window, cx);
                return;
            }
            None if path.is_dir() => {
                if let Err(e) = self.open(path.to_path_buf(), None, window, cx) {
                    let msg = format!("Couldn't open {}: {e:#}", path.display());
                    crate::popups::notify(
                        crate::popups::Balloon::error("Open workspace", msg),
                        window,
                        cx,
                    );
                }
            }
            None => return self.board_on(Some(card), window, cx),
        }
        // its Chat as it was left, the keys where they were, as after a rail move
        self.arrived(&tile, window, cx);
    }

    /// The Board in the Factory view's main slot, `card` selected there (none: as it was).
    pub(super) fn board_on(
        &mut self,
        card: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| v.start(window, cx));
        self.leave_pane_place(cx);
        self.card_page = false;
        if !self.factory_shown {
            self.set_factory_shown_as(true, false, window, cx);
        }
        view.update(cx, |v, cx| v.set_chat_on_card(true, cx));
        let params = card
            .map(|c| BTreeMap::from([("card".to_owned(), c.to_string())]))
            .unwrap_or_default();
        if view.read(cx).main_screen() != FIRST_SCREEN || !params.is_empty() {
            view.update(cx, |v, cx| v.open_in(Slot::Main, FIRST_SCREEN, params, cx));
        }
        cx.notify();
    }

    /// The status line's note (⌘Q's on the main checkout, a page Abe lacks): `words`, or none
    /// (only the note goes, never the bridge's own line).
    pub(super) fn say_browsed(&mut self, words: Option<String>, cx: &mut Context<Self>) {
        let mut shell = cx
            .try_global::<crate::factory::FactoryShell>()
            .cloned()
            .unwrap_or_default();
        let was = self.browse_note.take();
        let next = match words {
            Some(w) => Some(w),
            None if shell.status.is_some() && shell.status == was => None,
            None => return,
        };
        self.browse_note.clone_from(&next);
        shell.status = next;
        cx.set_global(shell);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_1_to_3_are_the_pages_in_the_headers_order() {
        let k = |s: &str| Keystroke::parse(s).unwrap();
        for (key, page) in [
            ("ctrl-1", Some(Page::Code)),
            ("ctrl-2", Some(Page::Run)),
            ("ctrl-3", Some(Page::Card)),
            ("ctrl-4", None),
            ("ctrl-5", None),
            ("ctrl-0", None),
            ("cmd-1", None),
            ("ctrl-shift-1", None),
        ] {
            assert_eq!(Page::of_key(&k(key)), page, "{key}");
        }
    }

    #[test]
    fn a_card_lands_on_run_while_it_runs_or_needs_you_else_on_the_code() {
        use WorkspaceState as W;
        for (state, page) in [
            (None, Page::Code),
            (Some(W::Running), Page::Run),
            (Some(W::Starting), Page::Run),
            (Some(W::NeedsYou), Page::Run),
            (Some(W::Idle), Page::Code),
            (Some(W::Done), Page::Code),
            (Some(W::Failed), Page::Code),
        ] {
            assert_eq!(first_page(state), page, "{state:?}");
        }
    }
}
