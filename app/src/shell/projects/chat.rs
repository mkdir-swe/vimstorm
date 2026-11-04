//! The shown tile's Chat (README "Layout"): taken as a tile is left ([`Projects::remember_chat`])
//! and given back as it shows again ([`Projects::apply_chat`], [`Projects::land_keys`]), from
//! what the tile remembers ([`super::memory::TileMemory`]). A Chat torn out (⌘⇧D) is the
//! window's, not a tile's: nothing is taken or given then.

use gpui_kit::{Context, Window};

use super::memory::{ChatMemory, ChatSize, Keys, KeysLeft, toggled};
use super::pages::Page;
use super::rail::Tile;
use super::{FactoryIsland, Projects};
use crate::shell::column::{self, ColumnMode};

impl Projects {
    /// The Chat as the shown tile has it now.
    pub fn chat_now(&self, cx: &gpui_kit::App) -> ChatMemory {
        let s = column::state(cx);
        let max = if self.factory_shown {
            self.factory_maximized(cx) == Some(FactoryIsland::Chat)
        } else {
            self.active()
                .is_some_and(|ws| ws.read(cx).maximized(cx) == Some(crate::shell::Island::Chat))
        };
        ChatMemory {
            size: match (s.shown(), max) {
                (false, _) => ChatSize::Hidden,
                (true, true) => ChatSize::Maximized,
                (true, false) => ChatSize::Docked,
            },
            claude_code: s.mode_now() == ColumnMode::Terminal,
            width: s.width,
            hidden_maximized: !s.shown() && self.chat_hidden_maximized,
            keys: KeysLeft::default(),
        }
    }

    /// The shown tile's page `tile` is (a place: none).
    fn page_of_tile(&self, tile: &Tile, cx: &gpui_kit::App) -> Option<Page> {
        (!tile.is_place()).then(|| self.page_now(cx))
    }

    /// Where the keys are now: Chat (either mode), else the page.
    fn keys_now(&self, window: &Window, cx: &gpui_kit::App) -> Keys {
        let in_chat = self.active().is_some_and(|ws| {
            let c = ws.read(cx).column().read(cx);
            c.has_keyboard(ColumnMode::Chat, window, cx)
                || c.has_keyboard(ColumnMode::Terminal, window, cx)
        });
        if in_chat { Keys::Chat } else { Keys::Page }
    }

    /// `tile` (the shown one) is left: its Chat as it is now and where the keys are on its page,
    /// kept (and saved when it changed).
    pub(super) fn remember_chat(
        &mut self,
        tile: &Tile,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if column::state(cx).torn.is_some() || self.welcome.is_some() {
            return;
        }
        let now = self.chat_now(cx);
        let page = self.page_of_tile(tile, cx);
        let keys = self.keys_now(window, cx);
        if self.memory.left(tile, now, page, keys) {
            self.save_set(cx);
        }
    }

    /// A move landed on `tile`: the keys where they were as it (a workspace: the page it shows)
    /// was left, Chat's composer in the mode its Chat is in (a first visit's; a maximized Chat
    /// hides the page) or the page.
    pub(super) fn land_keys(&mut self, tile: &Tile, window: &mut Window, cx: &mut Context<Self>) {
        let page = self.page_of_tile(tile, cx);
        let left = self.memory.keys_left(tile, page);
        if left == Some(Keys::Page) && self.chat_now(cx).size != ChatSize::Maximized {
            self.page_keys(window, cx);
        } else {
            self.rail_chat_keys(window, cx);
        }
    }

    /// `tile` shows: its Chat as it was left there (a first visit's: [`ChatMemory::first`]).
    pub(super) fn apply_chat(&mut self, tile: &Tile, window: &mut Window, cx: &mut Context<Self>) {
        if column::state(cx).torn.is_some() {
            return;
        }
        let width = f32::from(window.viewport_size().width);
        let first = ChatMemory::first(width, column::state(cx).width);
        let mem = self.memory.give_chat(tile, first);
        self.set_chat(mem, cx);
    }

    /// The shown tile's Chat set to `mem`: shown or hidden in both views (a tile's pages share
    /// it), its mode, its width, maximized or not.
    pub(super) fn set_chat(&mut self, mem: ChatMemory, cx: &mut Context<Self>) {
        let shown = mem.size != ChatSize::Hidden;
        self.chat_hidden_maximized = !shown && mem.hidden_maximized;
        column::set_state(cx, |s| {
            s.open = shown;
            s.factory_open = shown;
            s.mode = mem.mode();
            s.factory_mode = mem.mode();
            s.width = mem
                .width
                .clamp(crate::shell::CHAT_MIN_WIDTH, crate::shell::CHAT_MAX_WIDTH);
        });
        let max = mem.size == ChatSize::Maximized;
        let in_editor = !self.factory_shown;
        if let Some(ws) = self.active().cloned() {
            ws.update(cx, |w, cx| {
                w.sync_column(cx);
                w.set_chat_maximized(max && in_editor, cx);
            });
        }
        if self.factory_shown {
            if max {
                self.factory_max = Some(FactoryIsland::Chat);
            } else if self.factory_max == Some(FactoryIsland::Chat) {
                self.factory_max = None;
            }
        }
        cx.notify();
    }

    /// `f` changes the shown tile's page (its view may change with it): the tile's Chat kept as
    /// it was across.
    pub(super) fn keep_chat_across_views(
        &mut self,
        f: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let torn = column::state(cx).torn.is_some();
        let before = self.chat_now(cx);
        f(self, window, cx);
        if !torn {
            self.set_chat(before, cx);
        }
    }

    /// ⌘⇧2 (`maximize`): the shown tile's Chat docked ↔ maximized; ⌘⌥2: hidden ↔ shown. Shown, it
    /// takes the keys; hidden, the page does.
    pub(super) fn chat_size_key(
        &mut self,
        maximize: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if column::state(cx).torn.is_some() {
            return;
        }
        let mut mem = self.chat_now(cx);
        // ⌘⌥2 on a maximized Chat: shown maximized again
        let to = toggled(mem.size, mem.hidden_maximized, maximize);
        mem.hidden_maximized = to == ChatSize::Hidden && mem.size == ChatSize::Maximized;
        mem.size = to;
        self.set_chat(mem, cx);
        let tile = self.tile_now(cx);
        self.memory.chat_sized(&tile);
        self.remember_chat(&tile, window, cx);
        if mem.size == ChatSize::Hidden {
            self.page_keys(window, cx);
        } else {
            self.rail_chat_keys(window, cx);
        }
    }
}
