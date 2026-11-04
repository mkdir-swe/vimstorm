//! A prototype's tile (README "Layout", design B · Tiles): every prototype not done with gets a
//! tile in the rail's workspace group, after the cards' (the `workspaces` feed's `prototypes`,
//! in the order they were first seen: a state change never moves one). Its pages, picked in the
//! header (⌃1–⌃3, a click) and kept per prototype: Preview (the app in the in-app WebKit
//! preview), Code (what it changed, its screenshots) and Logs (the start script's output, what
//! the proxy refused), all the bridge's `prototype` screen in the Factory view's main slot. Chat
//! beside it is the prototype's own session. Its menu (right-click, ⌘⏎ over it) and the header's
//! buttons hand the screen a click (`proto:make-card`, `proto:open`, `proto:restart`,
//! `proto:stop`, `proto:discard`), which does them.

use std::collections::{BTreeMap, HashMap};

use gpui_kit::{App, Context, Keystroke, Window};

use super::Projects;
use super::rail::Tile;
use crate::factory::{PrototypeLook, Slot};
use crate::kit::Anchor;
use crate::popups::{self, Menu, MenuEntry, MenuItem};

/// The bridge's prototype page in the main slot.
pub const PROTOTYPE_SCREEN: &str = "prototype";

/// A prototype's page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProtoPage {
    #[default]
    Preview,
    Code,
    Logs,
}

impl ProtoPage {
    /// In the header's order (⌃1–⌃3).
    pub const ALL: [ProtoPage; 3] = [ProtoPage::Preview, ProtoPage::Code, ProtoPage::Logs];

    /// Its `page` param.
    pub fn slug(self) -> &'static str {
        match self {
            ProtoPage::Preview => "preview",
            ProtoPage::Code => "code",
            ProtoPage::Logs => "logs",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ProtoPage::Preview => "Preview",
            ProtoPage::Code => "Code",
            ProtoPage::Logs => "Logs",
        }
    }

    /// The status bar's word: `ABE · PREVIEW`.
    pub fn word(self) -> &'static str {
        match self {
            ProtoPage::Preview => "PREVIEW",
            ProtoPage::Code => "CODE",
            ProtoPage::Logs => "LOGS",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            ProtoPage::Preview => "⌃1",
            ProtoPage::Code => "⌃2",
            ProtoPage::Logs => "⌃3",
        }
    }

    /// ⌃1–⌃3.
    pub fn of_key(k: &Keystroke) -> Option<ProtoPage> {
        let page = super::pages::Page::of_key(k)?;
        let ix = super::pages::Page::ALL.iter().position(|p| *p == page)?;
        Self::ALL.get(ix).copied()
    }
}

/// The tile menu's rows and the click each hands the screen (a separator: none).
pub const MENU: [(&str, Option<&str>, &str); 6] = [
    ("Make card…", Some("make-card"), "m"),
    ("Open in browser", Some("open"), "o"),
    ("Restart app", Some("restart"), "R"),
    ("Stop app", Some("stop"), "s"),
    ("", None, ""),
    ("Discard…", Some("discard"), "d"),
];

/// The header's buttons: their words and the click each hands the screen.
pub const BUTTONS: [(&str, &str); 4] = [
    ("Make card…", "make-card"),
    ("Open in browser", "open"),
    ("Restart app", "restart"),
    ("Discard…", "discard"),
];

/// `order` (the ids as first seen) brought up to `feed`: new ones after the others, gone ones
/// dropped; a state change never moves one.
pub fn ordered(order: &mut Vec<String>, feed: &[PrototypeLook]) {
    order.retain(|id| feed.iter().any(|p| &p.id == id));
    for p in feed {
        if !order.contains(&p.id) {
            order.push(p.id.clone());
        }
    }
}

/// What the projects window keeps of the prototype tiles.
#[derive(Debug, Default)]
pub struct ProtoTiles {
    /// The ids in the order first seen: the tiles' order.
    pub order: Vec<String>,
    /// The prototype the main slot's `prototype` screen is on.
    pub at: Option<String>,
    /// Each prototype's page as last left.
    pub pages: HashMap<String, ProtoPage>,
    /// `open-prototype` named one the feed has not yet: gone to once it comes.
    pub pending: Option<String>,
    /// The feed has named a prototype since the launch (one missing since is gone).
    pub seen: bool,
}

impl Projects {
    /// The prototypes as the rail draws them, in their tiles' order.
    pub fn prototypes(&self, cx: &App) -> Vec<PrototypeLook> {
        let Some(feed) = cx.try_global::<crate::factory::WorkspaceFeed>() else {
            return Vec::new();
        };
        self.protos
            .order
            .iter()
            .filter_map(|id| feed.prototypes.iter().find(|p| &p.id == id).cloned())
            .collect()
    }

    /// One prototype as the feed last said it.
    pub(super) fn prototype(&self, id: &str, cx: &App) -> Option<PrototypeLook> {
        cx.try_global::<crate::factory::WorkspaceFeed>()?
            .prototypes
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// The prototype tile shown, if one is.
    pub(super) fn prototype_shown(&self, cx: &App) -> Option<String> {
        let on = self.factory_shown
            && self.pane_place.is_none()
            && self
                .factory()
                .is_some_and(|f| f.read(cx).main_screen() == PROTOTYPE_SCREEN);
        on.then(|| self.protos.at.clone()).flatten()
    }

    /// The shown prototype's page.
    pub(super) fn proto_page_now(&self) -> ProtoPage {
        self.protos
            .at
            .as_ref()
            .and_then(|id| self.protos.pages.get(id).copied())
            .unwrap_or_default()
    }

    /// The feed moved: the tiles' order kept, a prototype `open-prototype` waited on gone to, and
    /// the shown one gone (discarded): the Board.
    pub(super) fn prototypes_seen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(feed) = cx.try_global::<crate::factory::WorkspaceFeed>() else {
            return;
        };
        let looks = feed.prototypes.clone();
        let before = self.protos.order.clone();
        ordered(&mut self.protos.order, &looks);
        if !looks.is_empty() {
            self.protos.seen = true;
        }
        if let Some(id) = self.protos.pending.clone()
            && looks.iter().any(|p| p.id == id)
        {
            self.protos.pending = None;
            self.go(Tile::Prototype(id), window, cx);
        } else if let Some(id) = self.prototype_shown(cx)
            && self.protos.seen
            && !feed.down()
            && !looks.iter().any(|p| p.id == id)
        {
            self.go(Tile::Board, window, cx);
        }
        if before != self.protos.order {
            cx.notify();
        }
    }

    /// `open-prototype`: its tile on Preview, once the feed has it.
    pub(in crate::shell) fn open_prototype(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.protos.pages.insert(id.clone(), ProtoPage::Preview);
        if self.prototype(&id, cx).is_some() {
            self.protos.pending = None;
            self.go(Tile::Prototype(id), window, cx);
        } else {
            self.protos.pending = Some(id);
        }
    }

    /// The Factory view's main slot on prototype `id`'s page (its own as last left), Chat beside
    /// it on its session (none yet: the repo's Abe chat). The keyboard is the caller's.
    pub(super) fn show_prototype(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| {
            v.start(window, cx);
            v.close_popup(cx);
        });
        self.leave_pane_place(cx);
        self.card_page = false;
        if !self.factory_shown {
            self.set_factory_shown_as(true, false, window, cx);
        }
        let session = self.prototype(id, cx).and_then(|p| p.session);
        let abe = self
            .open
            .iter()
            .find(|o| o.is_main())
            .map(|o| o.real.to_string_lossy().into_owned());
        view.update(cx, |v, cx| match (session, abe) {
            (Some(s), _) => v.set_chat_on_session(s, cx),
            (None, Some(root)) => v.set_chat_on_abe(root, cx),
            (None, None) => v.set_chat_on_card(true, cx),
        });
        self.protos.at = Some(id.to_owned());
        let page = self.protos.pages.get(id).copied().unwrap_or_default();
        let params = BTreeMap::from([
            ("id".to_owned(), id.to_owned()),
            ("page".to_owned(), page.slug().to_owned()),
        ]);
        view.update(cx, |v, cx| {
            v.open_in(Slot::Main, PROTOTYPE_SCREEN, params, cx)
        });
        cx.notify();
    }

    /// ⌃1–⌃3 (a header click) on a prototype's tile: `page` with the keys.
    pub(super) fn proto_page_key(
        &mut self,
        page: ProtoPage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.prototype_shown(cx) else {
            return;
        };
        if self.protos.pages.get(&id).copied().unwrap_or_default() != page {
            self.protos.pages.insert(id.clone(), page);
            self.show_prototype(&id, window, cx);
        }
        self.page_keys(window, cx);
    }

    /// One of a prototype's actions (its menu's, the header's): its tile shown, then the click
    /// handed to its screen.
    pub(super) fn proto_action(
        &mut self,
        id: &str,
        verb: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.prototype_shown(cx).as_deref() != Some(id) {
            self.go(Tile::Prototype(id.to_owned()), window, cx);
        }
        super::factory_click(format!("proto:{verb}"), window, cx);
    }

    /// A prototype tile's menu (a right-click, ⌘⏎ over it).
    pub(super) fn proto_menu(
        &mut self,
        id: String,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entries: Vec<MenuEntry> = MENU
            .iter()
            .map(|(label, verb, key)| match verb {
                None => MenuEntry::Separator,
                Some(_) => MenuItem::new(*label).shortcut(*key).into(),
            })
            .collect();
        let root = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let Some(verb) = choice.and_then(|ix| MENU.get(ix)).and_then(|m| m.1) else {
                    return;
                };
                let _ = root.update(cx, |p, cx| p.proto_action(&id, verb, window, cx));
            },
        );
    }

    /// `+` on the rail: New card (the Board on its New card dialog) or New prototype… (the Board
    /// asks its words); without an `abe` 2.x, the line that says so (the keys stay).
    pub(super) fn new_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::factory::BridgeCommand::available(cx) {
            popups::notify(popups::Balloon::info("", super::NO_ABE), window, cx);
            return;
        }
        let entries: Vec<MenuEntry> = vec![
            MenuItem::new("New card…").into(),
            MenuItem::new("New prototype…").into(),
        ];
        let root = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let _ = root.update(cx, |p, cx| match choice {
                    Some(0) => p.new_workspace(window, cx),
                    Some(1) => p.new_prototype(window, cx),
                    _ => {}
                });
            },
        );
    }

    /// New prototype…: the Board, which asks its words and starts it (`widget:new-prototype`).
    pub(super) fn new_prototype(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::factory::BridgeCommand::available(cx) {
            popups::notify(popups::Balloon::info("", super::NO_ABE), window, cx);
            return;
        }
        self.go(Tile::Board, window, cx);
        super::factory_click("widget:new-prototype".into(), window, cx);
    }
}
