//! What each rail tile remembers (README "Layout"), by [`Tile`]: its Chat as it was left
//! ([`ChatMemory`]: docked, maximized or hidden, Chat or Claude Code, the docked width, where the
//! keys were on each of its pages), a card tile's colour, and a workspace's page, Code's bottom
//! panel and the session Chat was on there. [`TileMemory`] is the module: [`super::Projects`]
//! tells it what a tile was left as and asks what to give back; it owns the files that keep it
//! for the next launch.
//!
//! A tile never left shows Chat docked in Chat mode (hidden in a narrow window) at the width it
//! has now, the keys in it; a kept Chat not given back since the launch is never taken over
//! (where the keys were is). A workspace first shown after a launch gets its panel as it was and
//! its Chat on the session it was on (once each: the unshown ones). A closed workspace's page,
//! panel, session and colour are forgotten (a quit keeps them); a cloud one's page and session are
//! never kept, nor a folder gone since.
//!
//! Kept in `<state>/vimstorm/`: `rail-memory.json` (the Chats, by [`Tile::key`]),
//! `rail-hues.json` (the colours, by the same key), `workspace-pages.json` (each workspace's page
//! and panel, by its real folder; a slug that is no page reads as Code) and
//! `workspace-chats.json` (the sessions, by the real folder). A broken file keeps nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::pages::Page;
use super::rail::Tile;
use crate::shell::PanelMemo;
use crate::shell::column::{self, ColumnMode};

/// The Chats' file in the app's state folder.
const MEMORY_FILE: &str = "rail-memory.json";
/// The card tiles' colours' file.
const HUES_FILE: &str = "rail-hues.json";
/// Each workspace's page and panel, by its real folder.
const PAGES_FILE: &str = "workspace-pages.json";
/// The session each workspace's Chat was on, by its real folder.
const CHATS_FILE: &str = "workspace-chats.json";

/// How a tile's Chat shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatSize {
    Docked,
    Maximized,
    Hidden,
}

/// Where the keys were as a page was left.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Keys {
    /// Chat's composer, or Claude Code's terminal in that mode.
    Chat,
    /// The page: the Board's, Boxes' or Pipelines' list, Run, the Card page, the code where
    /// nvim's current window is (a split, the tree, the bottom panel's tool window).
    Page,
}

/// Where the keys were as each of a tile's pages was left (a place is one page); none: Chat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeysLeft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<Keys>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run: Option<Keys>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    card: Option<Keys>,
    /// The Board's, Boxes' or Pipelines'.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    place: Option<Keys>,
}

impl KeysLeft {
    /// `page`'s (a place: none).
    fn of(&mut self, page: Option<Page>) -> &mut Option<Keys> {
        match page {
            Some(Page::Code) => &mut self.code,
            Some(Page::Run) => &mut self.run,
            Some(Page::Card) => &mut self.card,
            None => &mut self.place,
        }
    }

    /// Where they were on `page` (a place: none).
    pub fn at(mut self, page: Option<Page>) -> Option<Keys> {
        *self.of(page)
    }

    fn is_none(&self) -> bool {
        *self == KeysLeft::default()
    }
}

/// A tile's Chat as it was left.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatMemory {
    pub size: ChatSize,
    /// Claude Code (the column's Terminal mode), else Chat.
    #[serde(default, rename = "claudeCode")]
    pub claude_code: bool,
    pub width: f32,
    /// Hidden from maximized: ⌘⌥2 shows it maximized again.
    #[serde(default, rename = "hiddenMaximized", skip_serializing_if = "is_false")]
    pub hidden_maximized: bool,
    /// Where the keys were on its pages.
    #[serde(default, skip_serializing_if = "KeysLeft::is_none")]
    pub keys: KeysLeft,
}

fn is_false(b: &bool) -> bool {
    !b
}

impl ChatMemory {
    /// A tile never left: docked in Chat mode (hidden in a narrow window), at `width`.
    pub fn first(window_width: f32, width: f32) -> ChatMemory {
        ChatMemory {
            size: if column::open_by_default(window_width) {
                ChatSize::Docked
            } else {
                ChatSize::Hidden
            },
            claude_code: false,
            width,
            hidden_maximized: false,
            keys: KeysLeft::default(),
        }
    }

    pub(super) fn mode(self) -> ColumnMode {
        if self.claude_code {
            ColumnMode::Terminal
        } else {
            ColumnMode::Chat
        }
    }
}

/// ⌘⇧2 / ⌘⌥2 from `now`: docked ↔ maximized (hidden: maximized), or hidden ↔ shown at the size
/// it was hidden at (`hidden_maximized`: maximized, else docked).
pub fn toggled(now: ChatSize, hidden_maximized: bool, maximize: bool) -> ChatSize {
    match (now, maximize) {
        (ChatSize::Maximized, true) => ChatSize::Docked,
        (_, true) => ChatSize::Maximized,
        (ChatSize::Hidden, false) if hidden_maximized => ChatSize::Maximized,
        (ChatSize::Hidden, false) => ChatSize::Docked,
        (_, false) => ChatSize::Hidden,
    }
}

/// What one tile remembers.
#[derive(Clone, Debug, Default)]
struct Kept {
    chat: Option<ChatMemory>,
    /// Its kept Chat was given back since the launch (or sized by its keys): only then is it
    /// taken again as the tile is left.
    chat_given: bool,
    /// A card tile's colour ([`super::tiles::HUES`]).
    hue: Option<usize>,
    /// A workspace's page.
    page: Option<Page>,
    /// A workspace's Code bottom panel.
    panel: Option<PanelMemo>,
    /// The panel is the last launch's, not given to the workspace yet.
    panel_unshown: bool,
    /// The session Chat was on in a workspace, as Chat said it.
    session: Option<String>,
    /// The last launch's session, Chat not opened on it yet.
    session_unshown: Option<String>,
}

/// What every rail tile remembers, by [`Tile`], and its files (the module doc).
#[derive(Clone, Debug, Default)]
pub struct TileMemory {
    tiles: HashMap<Tile, Kept>,
}

impl TileMemory {
    /// As kept in the state folder `state` (none there: nothing kept).
    pub fn load(state: &Path) -> TileMemory {
        let file = |name| std::fs::read(state.join(name)).unwrap_or_default();
        TileMemory::read(
            &file(MEMORY_FILE),
            &file(HUES_FILE),
            &file(PAGES_FILE),
            &file(CHATS_FILE),
        )
    }

    /// The four files' text read (a broken or missing one: none of it kept); the last launch's
    /// panels and sessions not given back yet.
    fn read(memory: &[u8], hues: &[u8], pages: &[u8], chats: &[u8]) -> TileMemory {
        let mut m = TileMemory::default();
        let kept: HashMap<String, ChatMemory> = serde_json::from_slice(memory).unwrap_or_default();
        for (key, chat) in kept {
            m.at(Tile::from_key(&key)).chat = Some(chat);
        }
        let kept: HashMap<String, usize> = serde_json::from_slice(hues).unwrap_or_default();
        for (key, hue) in kept {
            m.at(Tile::from_key(&key)).hue = Some(hue);
        }
        let kept: HashMap<PathBuf, KeptPage> = serde_json::from_slice(pages).unwrap_or_default();
        for (dir, entry) in kept {
            let (page, panel) = entry.read();
            let k = m.at(Tile::Workspace(dir));
            k.page = Some(page);
            k.panel_unshown = panel.is_some();
            k.panel = panel;
        }
        let kept: HashMap<PathBuf, String> = serde_json::from_slice(chats).unwrap_or_default();
        for (dir, session) in kept {
            let k = m.at(Tile::Workspace(dir));
            k.session_unshown = Some(session.clone());
            k.session = Some(session);
        }
        m
    }

    /// Written to the state folder `state` now (off the UI thread: [`Self::saved`]).
    pub fn save(&self, state: &Path) {
        self.saved(|_| false).write(state);
    }

    /// What the next launch keeps: every page and session known but a cloud workspace's
    /// (`cloud`); a launch with a path keeps the others' for when they open again.
    pub(super) fn saved(&self, cloud: impl Fn(&Path) -> bool) -> Saved {
        let mut s = Saved::default();
        for (tile, k) in &self.tiles {
            if let Some(chat) = k.chat {
                s.memory.insert(tile.key(), chat);
            }
            if let Some(hue) = k.hue {
                s.hues.insert(tile.key(), hue);
            }
            let Tile::Workspace(dir) = tile else {
                continue;
            };
            if cloud(dir) {
                continue;
            }
            if let Some(page) = k.page {
                s.pages.insert(dir.clone(), KeptPage::of(page, k.panel));
            }
            if let Some(session) = &k.session {
                s.chats.insert(dir.clone(), session.clone());
            }
        }
        s
    }

    fn at(&mut self, tile: Tile) -> &mut Kept {
        self.tiles.entry(tile).or_default()
    }

    fn get(&self, tile: &Tile) -> Option<&Kept> {
        self.tiles.get(tile)
    }

    /// `tile`'s Chat as it was left.
    pub fn chat(&self, tile: &Tile) -> Option<ChatMemory> {
        self.get(tile)?.chat
    }

    /// Where the keys were on `page` (a place: none) as `tile` was left.
    pub fn keys_left(&self, tile: &Tile, page: Option<Page>) -> Option<Keys> {
        self.chat(tile)?.keys.at(page)
    }

    /// `tile`'s Chat kept as `chat`, as given back since the launch.
    pub fn keep_chat(&mut self, tile: &Tile, chat: ChatMemory) {
        let k = self.at(tile.clone());
        k.chat = Some(chat);
        k.chat_given = true;
    }

    /// `tile` is left on `page` (a place: none), its Chat `now`, the keys at `keys`: kept (a
    /// kept Chat not given back since the launch stays as it was, only where the keys were
    /// changes). True when that changed what is kept.
    pub fn left(&mut self, tile: &Tile, now: ChatMemory, page: Option<Page>, keys: Keys) -> bool {
        let k = self.at(tile.clone());
        let mut chat = match k.chat {
            Some(kept) if !k.chat_given => kept,
            _ => now,
        };
        chat.keys = k.chat.map(|c| c.keys).unwrap_or_default();
        *chat.keys.of(page) = Some(keys);
        let changed = k.chat != Some(chat);
        k.chat = Some(chat);
        changed
    }

    /// `tile` shows: its Chat as it was left (never left: `first`), given back.
    pub fn give_chat(&mut self, tile: &Tile, first: ChatMemory) -> ChatMemory {
        let k = self.at(tile.clone());
        k.chat_given = true;
        k.chat.unwrap_or(first)
    }

    /// `tile`'s Chat was sized by its keys (⌘⇧2, ⌘⌥2): taken as it is when left.
    pub fn chat_sized(&mut self, tile: &Tile) {
        self.at(tile.clone()).chat_given = true;
    }

    /// The colours of the card tiles `tiles` (in order): each keeps its own while open, a new
    /// one takes the first free ([`super::tiles::hues`]), kept. True when one changed.
    pub fn give_hues(&mut self, tiles: &[&Tile]) -> (Vec<usize>, bool) {
        let given = super::tiles::hues(tiles, |t| self.hue(t));
        let mut changed = false;
        for (t, h) in tiles.iter().zip(&given) {
            let k = self.at((*t).clone());
            if k.hue != Some(*h) {
                k.hue = Some(*h);
                changed = true;
            }
        }
        (given, changed)
    }

    /// `tile`'s colour as kept.
    pub fn hue(&self, tile: &Tile) -> Option<usize> {
        self.get(tile)?.hue
    }

    /// A workspace's page as last left.
    pub fn page(&self, tile: &Tile) -> Option<Page> {
        self.get(tile)?.page
    }

    /// A workspace's page set to `page` (shown next).
    pub fn set_page(&mut self, tile: &Tile, page: Page) {
        self.at(tile.clone()).page = Some(page);
    }

    /// A workspace's Code bottom panel as kept.
    pub fn panel(&self, tile: &Tile) -> Option<PanelMemo> {
        self.get(tile)?.panel
    }

    /// A workspace shows `page`, its panel `now` (one not given back since the launch: as it was
    /// kept, until it is); a panel never shown is not kept until it is. True when that changed
    /// what is kept.
    pub fn page_left(&mut self, tile: &Tile, page: Page, now: impl FnOnce() -> PanelMemo) -> bool {
        let k = self.at(tile.clone());
        let panel = match k.panel.filter(|_| k.panel_unshown) {
            Some(kept) => kept,
            None => now(),
        };
        let keep_panel = panel.shown || k.panel.is_some();
        let changed = k.page != Some(page) || (keep_panel && k.panel != Some(panel));
        k.page = Some(page);
        if keep_panel {
            k.panel = Some(panel);
        }
        changed
    }

    /// A workspace first shown since the launch: its panel as the last launch kept it (once).
    pub fn take_unshown_panel(&mut self, tile: &Tile) -> Option<PanelMemo> {
        let k = self.tiles.get_mut(tile)?;
        if std::mem::take(&mut k.panel_unshown) {
            k.panel
        } else {
            None
        }
    }

    /// The session Chat was on in a workspace.
    pub fn session(&self, tile: &Tile) -> Option<&str> {
        self.get(tile)?.session.as_deref()
    }

    /// Chat said a workspace's is on `session` (none: no session). True when that changed it.
    pub fn chat_said(&mut self, tile: &Tile, session: Option<&str>) -> bool {
        let k = self.at(tile.clone());
        if k.session.as_deref() == session {
            return false;
        }
        k.session = session.map(str::to_owned);
        true
    }

    /// A workspace first shown since the launch: the session its Chat was on at the last quit
    /// (once).
    pub fn take_restore(&mut self, tile: &Tile) -> Option<String> {
        self.tiles.get_mut(tile)?.session_unshown.take()
    }

    /// A workspace closed (not a quit): its page, panel, session and colour forgotten (opened
    /// again, it shows the code); its Chat stays kept.
    pub fn closed(&mut self, tile: &Tile) {
        if let Some(k) = self.tiles.get_mut(tile) {
            *k = Kept {
                chat: k.chat,
                chat_given: k.chat_given,
                ..Kept::default()
            };
        }
    }
}

/// What [`TileMemory::saved`] writes, made on the UI thread, written off it.
#[derive(Default)]
pub(super) struct Saved {
    memory: HashMap<String, ChatMemory>,
    hues: HashMap<String, usize>,
    pages: HashMap<PathBuf, KeptPage>,
    chats: HashMap<PathBuf, String>,
}

impl Saved {
    /// The files written into `state` (a workspace's folder gone since: its page and session
    /// not), each whole or not at all.
    pub(super) fn write(mut self, state: &Path) {
        self.pages.retain(|dir, _| dir.is_dir());
        self.chats.retain(|dir, _| dir.is_dir());
        for (name, text) in [
            (MEMORY_FILE, serde_json::to_vec(&self.memory)),
            (HUES_FILE, serde_json::to_vec(&self.hues)),
            (PAGES_FILE, serde_json::to_vec(&self.pages)),
            (CHATS_FILE, serde_json::to_vec(&self.chats)),
        ] {
            let path = state.join(name);
            if let Ok(text) = text {
                let tmp = path.with_extension("json.tmp");
                if std::fs::write(&tmp, text).is_ok() {
                    let _ = std::fs::rename(tmp, path);
                }
            }
        }
    }
}

/// A workspace's entry in `workspace-pages.json`: its page's slug, or the page with Code's panel.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum KeptPage {
    Slug(String),
    Full {
        page: String,
        #[serde(default)]
        panel: Option<PanelMemo>,
    },
}

impl KeptPage {
    fn of(page: Page, panel: Option<PanelMemo>) -> KeptPage {
        match panel {
            Some(panel) => KeptPage::Full {
                page: page.slug().to_owned(),
                panel: Some(panel),
            },
            None => KeptPage::Slug(page.slug().to_owned()),
        }
    }

    /// Its page and panel (a slug that is no page: the code).
    fn read(self) -> (Page, Option<PanelMemo>) {
        let (slug, panel) = match self {
            KeptPage::Slug(s) => (s, None),
            KeptPage::Full { page, panel } => (page, panel),
        };
        (Page::parse(&slug).unwrap_or_default(), panel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::PanelTab;

    #[test]
    fn cmd_shift_2_docks_and_maximizes_cmd_alt_2_hides_and_shows_as_it_was() {
        use ChatSize::*;
        for (now, hidden_maximized, maximize, to) in [
            (Docked, false, true, Maximized),
            (Maximized, false, true, Docked),
            (Hidden, false, true, Maximized),
            (Hidden, true, true, Maximized),
            (Docked, false, false, Hidden),
            (Maximized, false, false, Hidden),
            (Hidden, false, false, Docked),
            // hidden from maximized: maximized again, the size it had
            (Hidden, true, false, Maximized),
        ] {
            assert_eq!(
                toggled(now, hidden_maximized, maximize),
                to,
                "{now:?} {hidden_maximized} {maximize}"
            );
        }
    }

    /// A tell to the memory.
    enum Tell {
        /// The four files' text as the last launch left them (memory, hues, pages, chats).
        Files(&'static str, &'static str, &'static str, &'static str),
        /// Saved and read back, as a quit and a launch.
        Relaunch,
        /// Saved with this workspace a cloud one, read back.
        RelaunchCloud(Tile),
        Left(Tile, ChatMemory, Option<Page>, Keys),
        Give(Tile),
        Sized(Tile),
        PageLeft(Tile, Page, PanelMemo),
        SetPage(Tile, Page),
        Said(Tile, Option<&'static str>),
        Hues(Vec<Tile>),
        Closed(Tile),
    }

    /// An ask, with what it answers.
    #[derive(Debug)]
    enum Ask {
        Chat(Tile, Option<ChatSize>),
        Keys(Tile, Option<Page>, Option<Keys>),
        Given(Tile, ChatMemory),
        Page(Tile, Option<Page>),
        Panel(Tile, Option<PanelMemo>),
        Unshown(Tile, Option<PanelMemo>),
        Session(Tile, Option<&'static str>),
        Restore(Tile, Option<&'static str>),
        Hue(Tile, Option<usize>),
        /// What the last tell said changed.
        Changed(bool),
    }

    fn ws(dir: &str) -> Tile {
        Tile::Workspace(PathBuf::from(dir))
    }

    fn chat(size: ChatSize) -> ChatMemory {
        ChatMemory {
            size,
            claude_code: false,
            width: 420.,
            hidden_maximized: false,
            keys: KeysLeft::default(),
        }
    }

    fn panel(shown: bool, tab: PanelTab) -> PanelMemo {
        PanelMemo {
            shown,
            tab,
            share: None,
        }
    }

    #[test]
    fn each_tile_gets_back_what_it_was_left_with_across_a_launch() {
        use Ask as A;
        use ChatSize::*;
        use Tell as T;
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let real = dir.path().join("wt");
        std::fs::create_dir_all(&real).unwrap();
        let w = Tile::Workspace(real);
        let first = chat(Docked);
        let maxed = chat(Maximized);
        let rows: Vec<(&str, Vec<Tell>, Vec<Ask>)> = vec![
            (
                "a tile never left: the first Chat, nothing else",
                vec![],
                vec![
                    A::Chat(w.clone(), None),
                    A::Given(w.clone(), first),
                    A::Page(w.clone(), None),
                    A::Session(w.clone(), None),
                    A::Restore(w.clone(), None),
                ],
            ),
            (
                "left: its Chat and where the keys were on that page",
                vec![T::Left(w.clone(), maxed, Some(Page::Run), Keys::Page)],
                vec![
                    A::Changed(true),
                    A::Chat(w.clone(), Some(Maximized)),
                    A::Keys(w.clone(), Some(Page::Run), Some(Keys::Page)),
                    A::Keys(w.clone(), Some(Page::Code), None),
                ],
            ),
            (
                "left again as it was: nothing changed",
                vec![
                    T::Left(w.clone(), maxed, Some(Page::Run), Keys::Page),
                    T::Give(w.clone()),
                    T::Left(w.clone(), maxed, Some(Page::Run), Keys::Page),
                ],
                vec![A::Changed(false)],
            ),
            (
                "a kept Chat not given back since the launch is not taken over, the keys are",
                vec![
                    T::Left(Tile::Board, maxed, None, Keys::Page),
                    T::Relaunch,
                    T::Left(Tile::Board, first, None, Keys::Chat),
                ],
                vec![
                    A::Changed(true),
                    A::Chat(Tile::Board, Some(Maximized)),
                    A::Keys(Tile::Board, None, Some(Keys::Chat)),
                ],
            ),
            (
                "given back (or sized by its keys), it is taken as it is",
                vec![
                    T::Left(Tile::Board, maxed, None, Keys::Page),
                    T::Relaunch,
                    T::Sized(Tile::Board),
                    T::Left(Tile::Board, first, None, Keys::Page),
                ],
                vec![
                    A::Chat(Tile::Board, Some(Docked)),
                    A::Keys(Tile::Board, None, Some(Keys::Page)),
                ],
            ),
            (
                "a launch gives each tile its Chat, keys, page, panel, session and colour",
                vec![
                    T::Left(w.clone(), maxed, Some(Page::Code), Keys::Page),
                    T::PageLeft(w.clone(), Page::Run, panel(true, PanelTab::Git)),
                    T::Said(w.clone(), Some("s7")),
                    T::Hues(vec![ws("/other"), w.clone()]),
                    T::Left(Tile::Board, chat(Hidden), None, Keys::Page),
                    T::Relaunch,
                ],
                vec![
                    A::Chat(w.clone(), Some(Maximized)),
                    A::Keys(w.clone(), Some(Page::Code), Some(Keys::Page)),
                    A::Page(w.clone(), Some(Page::Run)),
                    A::Panel(w.clone(), Some(panel(true, PanelTab::Git))),
                    A::Session(w.clone(), Some("s7")),
                    A::Hue(w.clone(), Some(1)),
                    A::Chat(Tile::Board, Some(Hidden)),
                    A::Keys(Tile::Board, None, Some(Keys::Page)),
                    // first shown: its panel and session once
                    A::Unshown(w.clone(), Some(panel(true, PanelTab::Git))),
                    A::Unshown(w.clone(), None),
                    A::Restore(w.clone(), Some("s7")),
                    A::Restore(w.clone(), None),
                    A::Session(w.clone(), Some("s7")),
                ],
            ),
            (
                "an unshown panel is kept as it was until given back",
                vec![
                    T::PageLeft(w.clone(), Page::Code, panel(true, PanelTab::Git)),
                    T::Relaunch,
                    T::PageLeft(w.clone(), Page::Run, panel(false, PanelTab::Terminal)),
                ],
                vec![
                    A::Page(w.clone(), Some(Page::Run)),
                    A::Panel(w.clone(), Some(panel(true, PanelTab::Git))),
                ],
            ),
            (
                "a panel never shown is not kept, one shown once is",
                vec![
                    T::PageLeft(w.clone(), Page::Code, panel(false, PanelTab::Terminal)),
                    T::PageLeft(w.clone(), Page::Code, panel(true, PanelTab::Problems)),
                    T::PageLeft(w.clone(), Page::Code, panel(false, PanelTab::Problems)),
                ],
                vec![
                    A::Changed(true),
                    A::Panel(w.clone(), Some(panel(false, PanelTab::Problems))),
                ],
            ),
            (
                "the same page and panel: nothing changed",
                vec![
                    T::PageLeft(w.clone(), Page::Code, panel(false, PanelTab::Terminal)),
                    T::PageLeft(w.clone(), Page::Code, panel(false, PanelTab::Terminal)),
                ],
                vec![A::Changed(false), A::Panel(w.clone(), None)],
            ),
            (
                "Chat said the same session: nothing changed",
                vec![
                    T::Said(w.clone(), Some("s7")),
                    T::Said(w.clone(), Some("s7")),
                ],
                vec![A::Changed(false), A::Session(w.clone(), Some("s7"))],
            ),
            (
                "Chat on no session: none kept",
                vec![T::Said(w.clone(), Some("s7")), T::Said(w.clone(), None)],
                vec![A::Changed(true), A::Session(w.clone(), None)],
            ),
            (
                "a closed workspace forgets its page, panel, session and colour, not its Chat",
                vec![
                    T::Left(w.clone(), maxed, Some(Page::Run), Keys::Page),
                    T::SetPage(w.clone(), Page::Card),
                    T::Said(w.clone(), Some("s7")),
                    T::Hues(vec![w.clone()]),
                    T::Closed(w.clone()),
                    T::Relaunch,
                ],
                vec![
                    A::Chat(w.clone(), Some(Maximized)),
                    A::Page(w.clone(), None),
                    A::Session(w.clone(), None),
                    A::Hue(w.clone(), None),
                ],
            ),
            (
                "a cloud workspace's page and session are never kept, its Chat is",
                vec![
                    T::Left(w.clone(), maxed, Some(Page::Code), Keys::Page),
                    T::SetPage(w.clone(), Page::Run),
                    T::Said(w.clone(), Some("s7")),
                    T::RelaunchCloud(w.clone()),
                ],
                vec![
                    A::Chat(w.clone(), Some(Maximized)),
                    A::Page(w.clone(), None),
                    A::Session(w.clone(), None),
                ],
            ),
            (
                "a folder gone since: its page and session not kept",
                vec![
                    T::SetPage(ws("/gone/wt"), Page::Run),
                    T::Said(ws("/gone/wt"), Some("s7")),
                    T::Relaunch,
                ],
                vec![
                    A::Page(ws("/gone/wt"), None),
                    A::Session(ws("/gone/wt"), None),
                ],
            ),
            (
                "a card keeps its colour, a new one takes the first free",
                vec![
                    T::Hues(vec![ws("/b"), w.clone()]),
                    T::Relaunch,
                    T::Hues(vec![ws("/a"), w.clone()]),
                ],
                vec![
                    A::Changed(true),
                    A::Hue(w.clone(), Some(1)),
                    A::Hue(ws("/a"), Some(0)),
                ],
            ),
            (
                "the files as kept: a Chat by its tile's key, a slug that is no page the code",
                vec![T::Files(
                    r#"{"/wt/5":{"size":"maximized","claudeCode":true,"width":500,"keys":{"run":"page","code":"chat"}},"board":{"size":"hidden","width":420,"keys":{"place":"page"}},"proto:p1":{"size":"docked","width":420}}"#,
                    r#"{"/wt/5":3}"#,
                    r#"{"/a":"run","/b":"skills","/d":"card","/k":{"page":"run","panel":{"shown":false,"tab":"git","share":0.4}}}"#,
                    r#"{"/a":"s7"}"#,
                )],
                vec![
                    A::Chat(ws("/wt/5"), Some(Maximized)),
                    A::Keys(ws("/wt/5"), Some(Page::Run), Some(Keys::Page)),
                    A::Keys(ws("/wt/5"), Some(Page::Code), Some(Keys::Chat)),
                    A::Keys(ws("/wt/5"), Some(Page::Card), None),
                    A::Chat(Tile::Board, Some(Hidden)),
                    A::Keys(Tile::Board, None, Some(Keys::Page)),
                    A::Chat(Tile::Prototype("p1".into()), Some(Docked)),
                    A::Hue(ws("/wt/5"), Some(3)),
                    A::Page(ws("/a"), Some(Page::Run)),
                    A::Page(ws("/b"), Some(Page::Code)),
                    A::Page(ws("/d"), Some(Page::Card)),
                    A::Panel(ws("/a"), None),
                    A::Page(ws("/k"), Some(Page::Run)),
                    A::Panel(
                        ws("/k"),
                        Some(PanelMemo {
                            shown: false,
                            tab: PanelTab::Git,
                            share: Some(0.4),
                        }),
                    ),
                    A::Restore(ws("/a"), Some("s7")),
                ],
            ),
            (
                "broken files keep nothing",
                vec![T::Files("[", "{", "{", "{")],
                vec![
                    A::Chat(Tile::Board, None),
                    A::Page(ws("/a"), None),
                    A::Session(ws("/a"), None),
                ],
            ),
        ];
        for (name, tells, asks) in rows {
            let _ = std::fs::remove_dir_all(&state);
            std::fs::create_dir_all(&state).unwrap();
            let mut m = TileMemory::default();
            let mut changed = None;
            for tell in tells {
                changed = match tell {
                    T::Files(memory, hues, pages, chats) => {
                        m = TileMemory::read(
                            memory.as_bytes(),
                            hues.as_bytes(),
                            pages.as_bytes(),
                            chats.as_bytes(),
                        );
                        None
                    }
                    T::Relaunch => {
                        m.save(&state);
                        m = TileMemory::load(&state);
                        None
                    }
                    T::RelaunchCloud(t) => {
                        m.saved(|d| Tile::Workspace(d.to_path_buf()) == t)
                            .write(&state);
                        m = TileMemory::load(&state);
                        None
                    }
                    T::Left(t, now, page, keys) => Some(m.left(&t, now, page, keys)),
                    T::Give(t) => {
                        m.give_chat(&t, first);
                        None
                    }
                    T::Sized(t) => {
                        m.chat_sized(&t);
                        None
                    }
                    T::PageLeft(t, page, now) => Some(m.page_left(&t, page, || now)),
                    T::SetPage(t, page) => {
                        m.set_page(&t, page);
                        None
                    }
                    T::Said(t, s) => Some(m.chat_said(&t, s)),
                    T::Hues(tiles) => {
                        let tiles: Vec<&Tile> = tiles.iter().collect();
                        Some(m.give_hues(&tiles).1)
                    }
                    T::Closed(t) => {
                        m.closed(&t);
                        None
                    }
                };
            }
            for ask in asks {
                let ok = match &ask {
                    A::Chat(t, size) => m.chat(t).map(|c| c.size) == *size,
                    A::Keys(t, page, keys) => m.keys_left(t, *page) == *keys,
                    A::Given(t, chat) => m.clone().give_chat(t, first) == *chat,
                    A::Page(t, page) => m.page(t) == *page,
                    A::Panel(t, panel) => m.panel(t) == *panel,
                    A::Unshown(t, panel) => m.take_unshown_panel(t) == *panel,
                    A::Session(t, s) => m.session(t) == *s,
                    A::Restore(t, s) => m.take_restore(t).as_deref() == *s,
                    A::Hue(t, hue) => m.hue(t) == *hue,
                    A::Changed(c) => changed == Some(*c),
                };
                assert!(ok, "{name}: {ask:?}");
            }
        }
        // none kept: not written
        let none = serde_json::to_string(&ChatMemory::first(1400., 420.)).unwrap();
        assert!(!none.contains("keys"), "{none}");
        // a first visit: docked, hidden in a narrow window
        assert_eq!(ChatMemory::first(1400., 420.).size, ChatSize::Docked);
        assert_eq!(ChatMemory::first(800., 420.).size, ChatSize::Hidden);
    }
}
