//! ⌥⌘⏎ maximizes the island with the keyboard (boards W-Maximize, F-Maximize, Keys):
//! an editor split (with its own tab bar), the Project tree, the Chat column (either mode) or the
//! bottom pane (whatever tab) fills the body between the toolbar and the status bar; the
//! rail and the header's row stay; the rest keep running, not drawn ([`crate::shell::layout::Layout::maximize`]).
//! A dim [`LABEL`] at the island's top right. ⌥⌘⏎ again restores, so does Esc where it has nothing else
//! to do ([`Workspace::esc_restores`]: the tree, Chat and the pane once their search, layer or
//! filter is closed; never in a PTY; an nvim split's Esc is always nvim's, whose normal-mode map
//! says when it had nothing to do: no popup, search highlight, count or extra caret, no operator
//! pending, [`Workspace::esc_idle`]). A popup, picker or dialog with the keyboard maximizes nothing. Another island
//! taking the keyboard, an island key (⌘1–⌘7, ⌘T, ⌘⇧D), a jump, a view or workspace switch
//! restores first ([`restores_first`], [`Workspace::sync_maximized`]).
//!
//! The state is the editor's ([`crate::editor::EditorView::maximized`]: its layout applies it);
//! the window's keys reach it before nvim and any surface (the projects window's capture, a bare
//! workspace's own).
//!
//! In the Factory view (board F-Maximize): the island with the keyboard
//! (the Board, the view's Chat column, its bottom pane) fills the body between the toolbar and the
//! status bar; the others are not drawn (they keep running) and the dim [`LABEL`] sits
//! at its top right. ⌥⌘⏎ again restores, so does Esc where it has nothing else to do: the Board's
//! and Chat's Esc are their screen's first (a card, menu, pick or filter closes), the screen's
//! `unhandled` restores ([`Projects::factory_esc_unhandled`]); the pane's once its tab has nothing
//! open; a PTY's never. A layer, popup or picker up maximizes nothing. An island key (⌘1–⌘7, ⌘T,
//! ⌘⇧D), a jump, Chat taking the keyboard, ⌘⌥A and a workspace switch restore first. The Editor's
//! islands are the workspace's (above).

use gpui_kit::{
    AnyElement, App, Context, Focusable as _, InteractiveElement as _, IntoElement, KeyDownEvent,
    Keystroke, ParentElement as _, Styled as _, Window, div, px,
};

use super::Projects;
use crate::factory::Slot;
use crate::git::window::GitView;
use crate::look;
use crate::shell::column::ColumnMode;
use crate::shell::layout::{Island, Role, WinKind};
use crate::shell::tree::TreeView;
use crate::shell::{Surface as _, Workspace, column, pane};
use crate::terminal::TerminalView;

/// The dim label at a maximized island's top right.
pub const LABEL: &str = "Maximized · ⌥⌘⏎ or Esc restores";
/// Chat's, maximized with ⌘⇧2 (or ⌥⌘⏎): it is kept as the tile's.
pub const CHAT_LABEL: &str = "Maximized · ⌘⇧2 docks it";

/// ⌥⌘⏎.
pub fn is_key(k: &Keystroke) -> bool {
    let m = k.modifiers;
    m.platform && m.alt && !m.control && !m.shift && k.key == "enter"
}

/// A plain Esc.
pub fn is_esc(k: &Keystroke) -> bool {
    let m = k.modifiers;
    k.key == "escape" && !(m.platform || m.control || m.alt || m.shift || m.function)
}

/// The keys that open another island (⌘1 Project, ⌘2 the open file, ⌘3 the bottom panel's Git, ⌘4
/// Chat, ⌘T the Terminal, ⌘⇧D Chat out):
/// a maximized island restores before they run.
pub fn restores_first(k: &Keystroke) -> bool {
    let m = k.modifiers;
    if !m.platform || m.control || m.alt {
        return false;
    }
    if m.shift {
        return k.key.eq_ignore_ascii_case("d");
    }
    matches!(
        k.key.as_str(),
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "t"
    )
}

impl Workspace {
    /// The maximized island (None: the usual layout).
    pub fn maximized(&self, cx: &App) -> Option<Island> {
        self.editor.read(cx).maximized()
    }

    /// The island with the keyboard: None while a popup, a picker or a surface that is no island
    /// has it (⌥⌘⏎ is ignored then).
    pub fn island_with_keyboard(&self, window: &Window, cx: &App) -> Option<Island> {
        if self.popups.read(cx).is_open() || self.pickers.read(cx).state(cx).is_some() {
            return None;
        }
        let geo = self.geometry.get();
        let host = |role| geo.role_rect(role).map(|r| Island::Bottom(r.win));
        match self.focused_surface(window, cx) {
            Some(TreeView::NAME) => geo.layout.tree.map(|_| Island::Tree),
            Some(column::CHAT) => geo.layout.frame.chat.map(|_| Island::Chat),
            Some(TerminalView::NAME) => host(Role::Terminal),
            Some(pane::PaneHost::NAME) => host(Role::Pane),
            Some(GitView::NAME) => host(Role::Git),
            Some(_) => None,
            None => {
                if !self.editor.focus_handle(cx).is_focused(window) {
                    return None;
                }
                let grid = self.editor.read(cx).shown_cursor().grid;
                geo.layout
                    .wins
                    .iter()
                    .find(|w| {
                        w.grid == grid && w.kind == WinKind::Split && !w.bottom && w.role.is_none()
                    })
                    .map(|w| Island::Split(w.win))
            }
        }
    }

    /// ⌥⌘⏎: maximizes the island with the keyboard, or restores. Nothing while a popup, picker
    /// or other layer has the keyboard. Returns whether something changed.
    pub fn toggle_maximize(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.popups.read(cx).is_open() || self.pickers.read(cx).state(cx).is_some() {
            return false;
        }
        if self.maximized(cx).is_some() {
            return self.restore_maximized(cx);
        }
        let Some(island) = self.island_with_keyboard(window, cx) else {
            return false;
        };
        let changed = self
            .editor
            .update(cx, |e, cx| e.set_maximized(Some(island), cx));
        cx.notify();
        changed
    }

    /// The Chat column maximized over the middle (`on`), or back if it was (a tile's Chat as it
    /// was left, ⌘⇧2). Returns whether it changed.
    pub fn set_chat_maximized(&mut self, on: bool, cx: &mut Context<Self>) -> bool {
        let now = self.maximized(cx);
        let island = match (on, now) {
            (true, _) => Some(Island::Chat),
            (false, Some(Island::Chat)) => None,
            (false, _) => return false,
        };
        let changed = self.editor.update(cx, |e, cx| e.set_maximized(island, cx));
        cx.notify();
        changed
    }

    /// Back to the usual layout (true when something was maximized).
    pub fn restore_maximized(&mut self, cx: &mut Context<Self>) -> bool {
        let changed = self.editor.update(cx, |e, cx| e.set_maximized(None, cx));
        if changed {
            cx.notify();
        }
        changed
    }

    /// A plain Esc while maximized, seen before any surface and nvim: true when it restores here.
    /// The tree's search, the pane's layer, the Git tool window's field keep it; Chat's bridge and
    /// nvim get it first and say when they had nothing open; a PTY's Esc is the program's.
    pub fn esc_restores(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(island) = self.maximized(cx) else {
            return false;
        };
        let surface = self.focused_surface(window, cx);
        let restores = match (island, surface) {
            (Island::Tree, Some(TreeView::NAME)) => !self.tree.read(cx).search_input(),
            // the bridge's Chat takes Esc first and answers `unhandled` when it had nothing
            // open ([`column::ChatColumn::esc_not_taken`] restores then); the placeholder at once
            (Island::Chat, Some(column::CHAT)) => !self.column.read(cx).has_chat(),
            (Island::Bottom(_), Some(pane::PaneHost::NAME)) => self.pane.read(cx).esc_restores(cx),
            (Island::Bottom(_), Some(GitView::NAME)) => !self.git.read(cx).typing(window, cx),
            _ => false,
        };
        if restores {
            self.restore_maximized(cx);
        }
        restores
    }

    /// nvim's normal-mode Esc had nothing to do (`config.editing.esc`: no popup, no search
    /// highlight, no count, one caret; an operator pending or Insert mode never get there): a
    /// maximized split with the keyboard restores.
    pub(in crate::shell) fn esc_idle(&mut self, window: &Window, cx: &mut Context<Self>) {
        if matches!(self.maximized(cx), Some(Island::Split(_)))
            && self.focused_surface(window, cx).is_none()
        {
            self.restore_maximized(cx);
        }
    }

    /// The keyboard went to another island (a file opened from the maximized tree, ⌘1 from the
    /// code, a click): restore first. A popup or picker over the island keeps it.
    pub(in crate::shell) fn sync_maximized(
        &mut self,
        now: Option<&'static str>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let Some(island) = self.maximized(cx) else {
            return;
        };
        let elsewhere = match now {
            Some(TreeView::NAME) => island != Island::Tree,
            Some(column::CHAT) => island != Island::Chat,
            // the same host laid out (Git, the pane and the Terminal are three)
            Some(pane::PaneHost::NAME) | Some(GitView::NAME) | Some(TerminalView::NAME) => {
                let role = match now {
                    Some(GitView::NAME) => Role::Git,
                    Some(TerminalView::NAME) => Role::Terminal,
                    _ => Role::Pane,
                };
                let host = self.geometry.get().role_rect(role).map(|r| r.win);
                !matches!(island, Island::Bottom(w) if host == Some(w))
            }
            None => {
                !matches!(island, Island::Split(_))
                    && self.editor.focus_handle(cx).is_focused(window)
            }
            Some(_) => false,
        };
        if elsewhere {
            self.restore_maximized(cx);
        }
    }

    /// The label over the maximized island's top right (W-Maximize `nv-maxhint`: 12 px in, 8 px
    /// down; past the tool header's buttons of Chat and the pane).
    pub(in crate::shell) fn maximized_label(&self) -> Option<gpui_kit::AnyElement> {
        let geo = self.geometry.get();
        let (island, area) = geo.layout.maximized?;
        let buttons = match island {
            // the Git tool window's header: Commit, Push, Draft PR…, ⋮, ⤢ and hide
            Island::Bottom(w) if geo.role_rect(Role::Git).map(|r| r.win) == Some(w) => {
                GIT_HEADER_ACTIONS
            }
            Island::Chat | Island::Bottom(_) => 64.,
            Island::Split(_) | Island::Tree => 0.,
        };
        let right = area.right() - px(12. + buttons);
        // Chat maximized is the tile's (⌘⇧2 docks it again)
        let label = if island == Island::Chat {
            CHAT_LABEL
        } else {
            LABEL
        };
        Some(
            div()
                .absolute()
                .top(area.origin.y + px(8.))
                .right(window_right(&geo) - right)
                .debug_selector(|| "maximized-label".into())
                .font_family(crate::render::UI_FONT)
                .text_size(px(12.))
                .line_height(px(16.))
                .whitespace_nowrap()
                .text_color(look::TEXT_DIM)
                .child(label)
                .into_any_element(),
        )
    }
}

/// What the Git tool window's header actions take at its right (with `Push 99`): the label
/// stays left of them.
const GIT_HEADER_ACTIONS: f32 = 340.;

/// The window's right edge (the frame's viewport).
fn window_right(geo: &crate::shell::layout::Geometry) -> gpui_kit::Pixels {
    geo.layout.frame.viewport.width
}

impl Workspace {
    /// The window's maximize keys (its capture, before nvim and any surface): ⌥⌘⏎, Esc while
    /// maximized, an island key restoring first. True when the key is taken here.
    pub fn maximize_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let k = &ev.keystroke;
        if is_key(k) {
            self.toggle_maximize(window, cx);
            return true;
        }
        if self.maximized(cx).is_none() {
            return false;
        }
        if is_esc(k) {
            return self.esc_restores(window, cx);
        }
        if restores_first(k) {
            self.restore_maximized(cx);
        }
        false
    }
}

/// A surface menu's maximize row: its words now (`Restore` while maximized).
pub fn menu_title(scx: &crate::shell::SurfaceCx, cx: &App) -> &'static str {
    let maximized = scx
        .workspace
        .upgrade()
        .is_some_and(|ws| ws.read(cx).maximized(cx).is_some());
    if maximized {
        "Restore"
    } else {
        "Maximize Island"
    }
}

/// A menu row's ⌥⌘⏎: typed once the menu gave the keyboard back, so it maximizes the island the
/// keys are in (the View menu's row does the same, `app_menu`).
pub fn dispatch(window: &mut Window, cx: &mut App) {
    let Ok(key) = Keystroke::parse("alt-cmd-enter") else {
        return;
    };
    window.defer(cx, move |window, cx| {
        window.dispatch_keystroke(key, cx);
    });
}

/// A Factory view island ⌥⌘⏎ gives the body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactoryIsland {
    Board,
    Chat,
    Pane,
}

impl Projects {
    /// The Factory view's maximized island (None: the usual layout, or the Editor shown).
    pub fn factory_maximized(&self, cx: &App) -> Option<FactoryIsland> {
        let pane_shown = || {
            self.factory_pane_view()
                .is_some_and(|p| p.read(cx).tab().is_some())
        };
        self.factory_max
            .filter(|i| self.factory_shown && (*i != FactoryIsland::Pane || pane_shown()))
    }

    /// The Factory view's island with the keyboard: None while a layer, popup or picker has it.
    fn factory_island_with_keyboard(&self, window: &Window, cx: &App) -> Option<FactoryIsland> {
        let view = self.factory.as_ref().map(|(v, _)| v)?;
        if view.read(cx).layer_up() || crate::factory::settings_up(cx) {
            return None;
        }
        let ws = self.active()?.read(cx);
        if ws.popups().read(cx).is_open() || ws.pickers().read(cx).state(cx).is_some() {
            return None;
        }
        if view.focus_handle(cx).contains_focused(window, cx) {
            return Some(FactoryIsland::Board);
        }
        let column = ws.column().read(cx);
        if [ColumnMode::Chat, ColumnMode::Terminal]
            .into_iter()
            .any(|m| column.has_keyboard(m, window, cx))
            && self.factory_column_room(window, cx) > 0.
        {
            return Some(FactoryIsland::Chat);
        }
        self.factory_pane_view()
            .filter(|p| p.read(cx).tab().is_some() && p.read(cx).has_keyboard(window, cx))
            .map(|_| FactoryIsland::Pane)
    }

    /// The Run bar's expand: the main area maximized as ⌥⌘⏎ on it does, or back.
    pub(in crate::shell) fn factory_expand(&mut self, cx: &mut Context<Self>) {
        if self.factory_maximized(cx).is_some() {
            self.restore_factory_maximized(cx);
        } else if self.factory_shown {
            self.factory_max = Some(FactoryIsland::Board);
            cx.notify();
        }
    }

    /// Back to the Factory view's usual layout (true when something was maximized).
    pub(in crate::shell) fn restore_factory_maximized(&mut self, cx: &mut Context<Self>) -> bool {
        let was = self.factory_max.take().is_some();
        if was {
            cx.notify();
        }
        was
    }

    /// The window's maximize keys in the Factory view (its capture, before any surface): ⌥⌘⏎,
    /// the pane's Esc while maximized, an island key restoring first. True when taken here.
    pub(super) fn factory_maximize_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let k = &ev.keystroke;
        if is_key(k) {
            if self.factory_maximized(cx).is_some() {
                self.restore_factory_maximized(cx);
            } else if let Some(island) = self.factory_island_with_keyboard(window, cx) {
                self.factory_max = Some(island);
                cx.notify();
            }
            return true;
        }
        let Some(island) = self.factory_maximized(cx) else {
            return false;
        };
        if is_esc(k) {
            // the Board's and Chat's Esc are their screen's (`unhandled` restores); Chat's
            // placeholder has no screen: at once
            let restores = match island {
                FactoryIsland::Pane => self
                    .factory_pane_view()
                    .is_some_and(|p| p.read(cx).esc_restores(cx)),
                FactoryIsland::Chat => self
                    .active()
                    .is_some_and(|ws| !ws.read(cx).column().read(cx).has_chat()),
                FactoryIsland::Board => false,
            };
            if restores {
                self.restore_factory_maximized(cx);
            }
            return restores;
        }
        if restores_first(k) {
            self.restore_factory_maximized(cx);
        }
        false
    }

    /// An Esc `slot`'s screen did not take: the island it maximized restores (true), the keyboard
    /// staying there. A layer come up meanwhile keeps it.
    pub(in crate::shell) fn factory_esc_unhandled(
        &mut self,
        slot: Slot,
        cx: &mut Context<Self>,
    ) -> bool {
        let island = match slot {
            Slot::Main => FactoryIsland::Board,
            Slot::Chat => FactoryIsland::Chat,
            _ => return false,
        };
        let layer = self
            .factory
            .as_ref()
            .is_some_and(|(v, _)| v.read(cx).layer_up());
        if self.factory_maximized(cx) != Some(island) || layer {
            return false;
        }
        self.restore_factory_maximized(cx)
    }

    /// The label at the maximized island's top right (W-Maximize `nv-maxhint`: 12 px in, 8 px
    /// down; past the tool header's buttons of Chat and the pane).
    pub(super) fn factory_maximized_label(&self, cx: &App) -> Option<AnyElement> {
        let buttons = match self.factory_maximized(cx)? {
            FactoryIsland::Board => 0.,
            FactoryIsland::Chat | FactoryIsland::Pane => 64.,
        };
        let margin = crate::shell::layout::MARGIN;
        Some(
            div()
                .absolute()
                .top(px(look::TOOLBAR_HEIGHT.get() + 8.))
                .right(px(margin + 12. + buttons))
                .debug_selector(|| "maximized-label".into())
                .font_family(crate::render::UI_FONT)
                .text_size(px(12.))
                .line_height(px(16.))
                .whitespace_nowrap()
                .text_color(look::TEXT_DIM)
                .child(LABEL)
                .into_any_element(),
        )
    }
}
