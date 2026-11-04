//! The jump from the projects window (board Keys): ⌃L Linked, taken before every surface (⌃W's
//! workspace jump is the rail's ⌘→ now, ⌃I's Card page ⏎ on a card). Two exceptions keep the
//! plain key: an nvim split with the keyboard (add caret above) and a PTY with it (Terminal
//! mode's tabs, a Chat Terminal: clear), whether or not its program reads keys; there ⌃⌥L
//! jumps, and it works everywhere else too. The bridge says what is linked
//! (`ui/src/board/jumps.ts`): this side names what had the keyboard ([`JumpFrom`]). Without an `abe` 2.0
//! nothing is taken (1.0's keys stay). What a jump opens comes back from the bridge: a layer
//! (which takes the keyboard over the Editor too, [`Projects::layer_takes_keyboard`]), an
//! `open-project {chat}` ([`Projects::land_with_chat`]) or a `show` ([`Projects::show_place`]).

use gpui_kit::{App, Context, Focusable as _, Window};

use super::Projects;
use crate::factory::{BridgeCommand, Slot};
use crate::factory::{JumpFrom, JumpPlace, JumpTo, ShowPlace, ViewName};
use crate::git::annotate::AnnotateView;
use crate::git::diff::DiffView;
use crate::git::window::GitView;
use crate::shell::Surface as _;
use crate::shell::column::{self, ColumnMode};
use crate::shell::pane::PaneTab;
use crate::shell::toolbar::ToolbarView;
use crate::shell::tree::TreeView;
use crate::terminal::TerminalView;

/// What had the keyboard, as a jump key reads it.
enum Keyboard {
    /// An nvim split, or a PTY: the plain key is theirs.
    Theirs(JumpPlace),
    /// Anything else: the jump is taken.
    Ours(JumpPlace),
}

/// ⌃⌥L in the torn-out Chat: the jump from Chat, as in the main window, which comes to the
/// front. False without an `abe` 2.0. Safe inside any update.
pub fn jump_from_torn(cx: &mut App) -> bool {
    if !BridgeCommand::available(cx) {
        return false;
    }
    let Some(main) = super::window(cx) else {
        return false;
    };
    cx.defer(move |cx| {
        let _ = main.update(cx, |_, window, cx| {
            window.activate_window();
            super::with_root(window, cx, move |p, window, cx| {
                // a jump restores a maximized island first
                if let Some(ws) = p.active().cloned() {
                    ws.update(cx, |ws, cx| ws.restore_maximized(cx));
                }
                p.restore_factory_maximized(cx);
                p.jump(JumpTo::Linked, JumpPlace::Chat, window, cx);
            });
        });
    });
    true
}

impl Projects {
    /// The jump key (`keymap::jump_of`): `everywhere` for its ⌃⌥ form. True when it was taken.
    pub(super) fn jump_key(
        &mut self,
        everywhere: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !BridgeCommand::available(cx) {
            return false;
        }
        let place = match self.keyboard(window, cx) {
            Keyboard::Theirs(_) if !everywhere => return false,
            Keyboard::Theirs(place) | Keyboard::Ours(place) => place,
        };
        // a jump restores a maximized island first
        if let Some(ws) = self.active().cloned() {
            ws.update(cx, |ws, cx| ws.restore_maximized(cx));
        }
        self.restore_factory_maximized(cx);
        self.jump(JumpTo::Linked, place, window, cx);
        true
    }

    /// A jump from `place` told the bridge (the Factory view made and started when it isn't).
    pub(crate) fn jump(
        &mut self,
        to: JumpTo,
        place: JumpPlace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = if self.factory_shown {
            ViewName::Factory
        } else {
            ViewName::Editor
        };
        let factory = self.ensure_factory(window, cx);
        factory.update(cx, |v, cx| {
            v.start(window, cx);
            v.jump(to, JumpFrom { place, view });
        });
    }

    /// Where the keyboard is: the Factory view's slots (a PTY in their trees is the program's),
    /// the Editor's nvim, its terminal tabs, the Chat column, the tree, Git, the toolbar.
    fn keyboard(&self, window: &Window, cx: &gpui_kit::App) -> Keyboard {
        if let Some((factory, _)) = &self.factory {
            let f = factory.read(cx);
            if let Some(slot) = f.keyboard_slot(window, cx) {
                // over the Editor the view only hosts a layer (`:`'s, a menu): the shown
                // workspace's story, not the Board's selected card
                let place = match slot {
                    Slot::Main if !self.factory_shown => JumpPlace::Editor,
                    slot => JumpPlace::from(slot),
                };
                return if f.pty_focused(window, cx) {
                    Keyboard::Theirs(place)
                } else {
                    Keyboard::Ours(place)
                };
            }
        }
        if self.factory_shown {
            // a popup over the Board: the Board's story
            return Keyboard::Ours(JumpPlace::Other);
        }
        let Some(ws) = self.active() else {
            return Keyboard::Ours(JumpPlace::Other);
        };
        let ws = ws.read(cx);
        let Some(surface) = ws.focused_surface(window, cx) else {
            let nvim = ws.editor().read(cx).focus_handle(cx);
            return if nvim.contains_focused(window, cx) {
                Keyboard::Theirs(JumpPlace::Editor)
            } else {
                Keyboard::Ours(JumpPlace::Editor)
            };
        };
        let is = |name: &str| surface == name;
        if is(TerminalView::NAME) {
            // a shell (the bottom pane's Terminal): its own keys, as in an nvim split
            Keyboard::Theirs(JumpPlace::Editor)
        } else if is(DiffView::NAME) || is(AnnotateView::NAME) {
            // nvim's own windows under their native chrome
            Keyboard::Theirs(JumpPlace::Editor)
        } else if is(TreeView::NAME) {
            Keyboard::Ours(JumpPlace::Tree)
        } else if is(GitView::NAME) {
            Keyboard::Ours(JumpPlace::Git)
        } else if is(ToolbarView::NAME) {
            Keyboard::Ours(JumpPlace::Toolbar)
        } else if is(column::CHAT) {
            Keyboard::Ours(JumpPlace::Chat)
        } else {
            Keyboard::Ours(JumpPlace::Other)
        }
    }

    /// A layer came up over the Editor (⌃L's Linked, a menu), or in the Factory view while a slot
    /// of its own had the keyboard (`:` or ⏎ in Chat's column): it takes the keyboard, which goes
    /// back where it was once the layer closes (`factory_layer`). Else the next key, finding the
    /// layer without them, would close it (`blur`) and go on to the slot.
    pub(super) fn layer_takes_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((view, _)) = &self.factory else {
            return;
        };
        let view = view.clone();
        let focus = view.focus_handle(cx);
        if self.factory_shown {
            if view.read(cx).layer_has_keys(window, cx) {
                return;
            }
            self.layer_return = window.focused(cx);
        } else if focus.contains_focused(window, cx) {
            return;
        } else {
            self.factory_return = window.focused(cx);
        }
        window.focus(&focus, cx);
    }

    /// An `open-project {chat}` landing (a card menu's Open workspace): the workspace just shown gets the Chat column on Chat (its slot follows the
    /// shown workspace onto its session) with the keys, as a Sessions row's ⏎ does.
    pub(in crate::shell) fn land_with_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.factory_return = None;
        self.chat_keys(window, cx);
    }

    /// Chat takes the keys (`focus {slot: chat}`, a workspace opened from the Board): the shown workspace's
    /// column on Chat with the keyboard, so Chat's screen gives them to its composer. A column
    /// left in Terminal mode shows Chat, so keys meant for the app (Esc, `:`) never reach a
    /// session's Claude Code unless ⌘4 or a click put them there. A switch still waiting on its
    /// resize gives them once its workspace shows, since showing restores its own keyboard.
    pub(in crate::shell) fn chat_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            self.chat_keys_next = true;
            return;
        }
        crate::shell::hosted::keys_moved(cx);
        // another island taking the keyboard restores first
        if self.factory_maximized(cx) != Some(super::FactoryIsland::Chat) {
            self.restore_factory_maximized(cx);
        }
        if let Some(ws) = self.active().cloned() {
            let column = ws.read(cx).column().clone();
            column.update(cx, |c, cx| c.show(ColumnMode::Chat, true, window, cx));
        }
    }

    /// Linked's rows, the boxes widget: the Chat column on the session
    /// the bridge opened in its slot (in the view shown: each has its column), the
    /// keyboard staying where it is; or the bottom pane on a tab, which takes the keyboard.
    pub(in crate::shell) fn show_place(
        &mut self,
        place: ShowPlace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match place {
            ShowPlace::Chat => {
                // the Factory view has its own column beside the Board
                if !self.factory_shown {
                    self.leave_factory(window, cx);
                }
                if let Some(ws) = self.active().cloned() {
                    let column = ws.read(cx).column().clone();
                    column.update(cx, |c, cx| c.show(ColumnMode::Chat, false, window, cx));
                }
            }
            ShowPlace::Sessions | ShowPlace::Boxes | ShowPlace::Pipelines | ShowPlace::Git => {
                self.show_pane_place(place, window, cx)
            }
        }
    }

    /// Linked's Sessions, Boxes, Pipelines and Git rows: the Board (Sessions is its tab), the
    /// Boxes or Pipelines tile (its screen opened in the `pane` slot first: that box or run), the
    /// Git in Code's bottom panel.
    fn show_pane_place(&mut self, place: ShowPlace, window: &mut Window, cx: &mut Context<Self>) {
        let tab = match place {
            ShowPlace::Sessions => PaneTab::Sessions,
            ShowPlace::Boxes => PaneTab::Boxes,
            ShowPlace::Pipelines => PaneTab::Pipelines,
            ShowPlace::Git => PaneTab::Git,
            ShowPlace::Chat => return,
        };
        match tab {
            PaneTab::Boxes => self.go(super::Tile::Boxes, window, cx),
            PaneTab::Pipelines => self.go(super::Tile::Pipelines, window, cx),
            PaneTab::Git => self.panel_on(crate::shell::PanelTab::Git, window, cx),
            _ => self.go(super::Tile::Board, window, cx),
        }
    }
}
