//! The bottom pane (boards F-Sessions / X-Boxes): lists only, four tabs in a 31 px
//! tool-window header, Options and Hide at its right end: Sessions · Boxes · Pipelines · Git.
//! Hidden by default. With the rail, Boxes and Pipelines are tiles (the Factory view's pane
//! filling the middle), Git and the Terminal a workspace's pages and Sessions the Board's tab; under
//! the code only Problems (⇧⌘M) opens it. Esc gives the keys back and the pane stays.
//!
//! Editor view: two hosts share the bottom slot (`config/bottom.lua`: opening one hides the other,
//! one height, a third of the body by default and never under 8 rows, dragged at its top
//! gap, kept per project in the session): [`PaneHost`] over the
//! `pane` window (`config/app/pane.lua`, role `pane`) for Sessions, Boxes and Pipelines, and the
//! Git tool window ([`crate::git::window::GitView`], role `git`) for Git, which draws the same four tabs
//! before its own (Local Changes · Log). Factory view: [`FactoryPane`] under the Board, drawn by
//! the projects window with its own height.
//!
//! Feel vscode: VS Code's Problems first ([`super::problems`], ⌘⇧M), drawn by the Editor's
//! pane host over the same window; the Factory view's pane keeps the four.
//!
//! What a tab draws: Sessions, Boxes and Pipelines are TS screens in the bridge's `pane` slot (one
//! [`SlotView`] for the window, handed over by the projects window; `open {screen, slot: pane}`
//! is sent when the tab is picked). Esc gives the keys back unless the screen has something to
//! step back from first: a Table's `/` filter, Pipelines' one workflow or run
//! ([`crate::factory::steps_back`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    Global, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use rmpv::Value;
use serde::Deserialize;

use super::{HostedFocus, Surface, SurfaceCx, WorkspaceEvent};
use crate::factory::Slot;
use crate::factory::{FactoryView, SlotView};
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::{
    LeadItem, LeadMenuEvent, PaneLead, PaneLeadEvent, ToolAction, ToolActionEvent, ToolTabs,
};
use crate::look;
use crate::nvim::lua;
use crate::popups::{self, Menu, MenuItem};
use crate::shell::layout::{ISLAND_BORDER, ISLAND_RADIUS, TOOL_BG};

/// A tab of the bottom pane, in the header's order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PaneTab {
    /// Feel vscode's Problems: the workspace's diagnostics.
    Problems,
    #[default]
    Sessions,
    Boxes,
    Pipelines,
    Git,
}

impl PaneTab {
    pub const ALL: [PaneTab; 4] = [
        PaneTab::Sessions,
        PaneTab::Boxes,
        PaneTab::Pipelines,
        PaneTab::Git,
    ];

    /// The Editor's pane's tabs under the Feel in force: Problems first under vscode (VS Code's
    /// panel), else [`Self::ALL`].
    pub fn tabs(cx: &App) -> Vec<PaneTab> {
        crate::factory::vscode(cx)
            .then_some(PaneTab::Problems)
            .into_iter()
            .chain(PaneTab::ALL)
            .collect()
    }

    pub fn label(self) -> &'static str {
        match self {
            PaneTab::Problems => "Problems",
            PaneTab::Sessions => "Sessions",
            PaneTab::Boxes => "Boxes",
            PaneTab::Pipelines => "Pipelines",
            PaneTab::Git => "Git",
        }
    }

    /// Lua's name (`config/app/pane.lua`).
    pub fn slug(self) -> &'static str {
        match self {
            PaneTab::Problems => "problems",
            PaneTab::Sessions => "sessions",
            PaneTab::Boxes => "boxes",
            PaneTab::Pipelines => "pipelines",
            PaneTab::Git => "git",
        }
    }

    pub fn parse(slug: &str) -> Option<PaneTab> {
        std::iter::once(PaneTab::Problems)
            .chain(PaneTab::ALL)
            .find(|t| t.slug() == slug)
    }

    /// The key that shows it: Problems' (the others are the rail's tiles and pages).
    pub fn shortcut(self) -> Option<&'static str> {
        match self {
            PaneTab::Problems => Some("⇧⌘M"),
            PaneTab::Sessions | PaneTab::Boxes | PaneTab::Pipelines | PaneTab::Git => None,
        }
    }

    /// The bridge screen it draws in the `pane` slot (Problems and Git are native).
    pub fn screen(self) -> Option<&'static str> {
        match self {
            PaneTab::Sessions => Some("sessions"),
            PaneTab::Boxes => Some("boxes"),
            PaneTab::Pipelines => Some("pipelines"),
            PaneTab::Problems | PaneTab::Git => None,
        }
    }
}

impl PaneTab {
    /// Its icon (the stripe's).
    pub fn icon(self) -> IconName {
        match self {
            PaneTab::Problems => IconName::ToolWindowProblems,
            PaneTab::Sessions => IconName::History,
            PaneTab::Boxes => IconName::Archive,
            PaneTab::Pipelines => IconName::ToolWindowRun,
            PaneTab::Git => IconName::ToolWindowVcs,
        }
    }
}

/// Pane tab `tab` as its header names it (WebStorm's: the tool window's name).
fn tab_item(tab: PaneTab) -> LeadItem {
    LeadItem {
        icon: Some(tab.icon()),
        tooltip: Some(
            match tab.shortcut() {
                Some(k) => format!("{} · {k}", tab.label()),
                None => tab.label().to_string(),
            }
            .into(),
        ),
        ..LeadItem::new(tab.slug(), tab.label())
    }
}

/// The header's lead (WebStorm's tool window header): the shown tab's name alone (none:
/// nothing). The rail picks the place (Boxes, Pipelines), a workspace's header its page.
pub fn lead(shown: Option<PaneTab>, _cx: &App) -> PaneLead {
    PaneLead {
        selected: shown.map(|_| 0),
        tabs: shown.map(tab_item).into_iter().collect(),
    }
}

/// [`lead`] for a header of `tabs` (the Editor's, the Git tool window's): the shown one's name.
pub fn lead_of(tabs: &[PaneTab], shown: Option<PaneTab>, cx: &App) -> PaneLead {
    lead(shown.filter(|s| tabs.contains(s)), cx)
}

/// A bottom tool window shown by a click (a rail tile, the pane's menu), which the shell opens
/// itself: the bridge hears it too (`widget:stripe:<tab>`: a click on Boxes keeps a box about to sleep
/// awake).
pub fn tab_clicked(tab: PaneTab, window: &mut Window, cx: &mut App) {
    crate::shell::projects::factory_click(format!("widget:stripe:{}", tab.slug()), window, cx);
}

/// The pane's header with no tabs of its own: the four tabs, Options, Hide.
fn header(shown: Option<PaneTab>, cx: &App) -> ToolTabs {
    ToolTabs::new("", Vec::new())
        .with_actions(
            Vec::new(),
            vec![
                ToolAction::new("options", IconName::MoreVertical, "Options"),
                ToolAction::new("hide", IconName::Hide, "Hide"),
            ],
        )
        .with_lead(lead(shown, cx))
}

/// What the Options menu (and a right-click on the header) chose.
#[derive(Clone, Debug, PartialEq)]
pub enum MenuPick {
    Tab(PaneTab),
    Hide,
}

/// The Options menu (also a right-click on the header): the tabs with their keys, then Hide (the
/// shown tab's key) while a tab is shown.
fn options_menu(
    tabs: Vec<PaneTab>,
    shown: Option<PaneTab>,
    anchor: Anchor,
    window: &mut Window,
    cx: &mut App,
    on: impl Fn(MenuPick, &mut Window, &mut App) + 'static,
) {
    // aligned with the entries (a separator picks nothing)
    let mut picks: Vec<Option<MenuPick>> = Vec::new();
    let mut entries: Vec<crate::popups::MenuEntry> = Vec::new();
    for t in &tabs {
        let item = MenuItem::new(t.label()).enabled(Some(*t) != shown);
        entries.push(match t.shortcut() {
            Some(k) => item.shortcut(k).into(),
            None => item.into(),
        });
        picks.push(Some(MenuPick::Tab(*t)));
    }
    if let Some(shown) = shown {
        entries.push(crate::popups::MenuEntry::Separator);
        picks.push(None);
        let hide = MenuItem::new("Hide");
        entries.push(match shown.shortcut() {
            Some(k) => hide.shortcut(k).into(),
            None => hide.into(),
        });
        picks.push(Some(MenuPick::Hide));
    }
    popups::open_menu(
        Menu::new(entries, anchor),
        window,
        cx,
        move |choice, window, cx| {
            if let Some(Some(pick)) = choice.and_then(|ix| picks.get(ix)) {
                on(pick.clone(), window, cx);
            }
        },
    );
}

/// What the tabs draw, handed over by the projects window: the bridge's `pane` slot (one for the
/// window).
#[derive(Clone, Default)]
pub struct PaneContent {
    pub factory: Option<Entity<FactoryView>>,
    pub slot: Option<Entity<SlotView>>,
}

impl PaneContent {
    /// The body of tab `tab` (not Git: the Git tool window draws its own).
    fn body(&self, tab: PaneTab) -> AnyElement {
        match tab {
            PaneTab::Sessions | PaneTab::Boxes | PaneTab::Pipelines => match &self.slot {
                Some(slot) => div()
                    .debug_selector(|| "pane-slot".into())
                    .flex_1()
                    .min_h_0()
                    .child(slot.clone())
                    .into_any_element(),
                None => note("Abe's lists show once abe ui bridge answers."),
            },
            PaneTab::Problems | PaneTab::Git => note(""),
        }
    }

    /// The keyboard where tab `tab` wants it while the pane has it: the slot's view (it puts it
    /// on its terminal).
    fn place_focus(&self, tab: PaneTab, focus: &FocusHandle, window: &mut Window, cx: &mut App) {
        if !focus.is_focused(window) {
            return;
        }
        if let (Some(slot), Some(_)) = (&self.slot, tab.screen()) {
            let h = slot.focus_handle(cx);
            window.focus(&h, cx);
        }
    }

    /// Esc (seen first, capture): true when it gives the keys back. A slot's screen gets it too
    /// (it closes what it has open); a layer up keeps it; so does a Table's `/` filter (Esc
    /// clears it and the keys stay in the list) and Pipelines' one workflow or run (Esc steps
    /// back there).
    fn esc_leaves(&self, tab: PaneTab, cx: &App) -> bool {
        let Some(f) = &self.factory else {
            return true;
        };
        let f = f.read(cx);
        if f.layer_up() {
            return false;
        }
        match f.slot_tree(Slot::Pane).filter(|_| tab.screen().is_some()) {
            Some(tree) => !crate::factory::filtering(tree) && !crate::factory::steps_back(tree),
            None => true,
        }
    }
}

fn plain_esc(ev: &KeyDownEvent) -> bool {
    let m = ev.keystroke.modifiers;
    ev.keystroke.key == "escape" && !(m.platform || m.control || m.alt || m.shift)
}

fn note(text: &'static str) -> AnyElement {
    div()
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(text))
        .into_any_element()
}

/// The pane's island: its header over the body.
fn island(header: &Entity<ToolTabs>, body: AnyElement) -> gpui_kit::Div {
    div()
        .size_full()
        .rounded(px(ISLAND_RADIUS.get()))
        .bg(TOOL_BG)
        .border(px(ISLAND_BORDER))
        .border_color(look::ISLAND_BORDER)
        .overflow_hidden()
        .flex()
        .flex_col()
        .text_color(look::TEXT)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(div().flex_none().child(header.clone()))
        .child(div().flex_1().min_h_0().flex().flex_col().child(body))
}

const LUA: &str = "config.app.pane";

/// `vimstorm.pane` (config/app/pane.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum HostEvent {
    Open {
        tab: String,
        #[serde(default = "yes")]
        enter: bool,
    },
    Hide,
    Focus,
    Blur,
    /// Feel vscode's Problems tab's rows.
    Problems {
        #[serde(default, deserialize_with = "crate::editor::tabs::seq")]
        files: Vec<super::problems::ProblemFile>,
    },
}

fn yes() -> bool {
    true
}

/// The Editor's pane host over the `pane` window: Sessions, Boxes, Pipelines (and feel vscode's
/// Problems).
pub struct PaneHost {
    scx: SurfaceCx,
    hosted: HostedFocus,
    tab: PaneTab,
    header: Entity<ToolTabs>,
    content: PaneContent,
    /// Feel vscode's Problems tab.
    problems: Entity<crate::kit::ListView<super::problems::ProblemsList>>,
    _subs: Vec<Subscription>,
}

impl PaneHost {
    pub fn is_open(&self) -> bool {
        self.hosted.is_open()
    }

    /// The tab it shows (Sessions, Boxes or Pipelines).
    pub fn tab(&self) -> PaneTab {
        self.tab
    }

    pub fn header(&self) -> &Entity<ToolTabs> {
        &self.header
    }

    /// What its tabs draw (the projects window's, on each open).
    pub fn set_content(&mut self, content: PaneContent, cx: &mut Context<Self>) {
        self.content = content;
        cx.notify();
    }

    pub fn content(&self) -> &PaneContent {
        &self.content
    }

    /// Feel vscode's Problems list (tests).
    pub fn problems(&self) -> &Entity<crate::kit::ListView<super::problems::ProblemsList>> {
        &self.problems
    }

    /// Esc while maximized: restores unless its tab has something to close first.
    pub fn esc_restores(&self, cx: &App) -> bool {
        self.content.esc_leaves(self.tab, cx)
    }

    /// The keyboard is in it (⌃⌥← / → step through the bottom tool windows then).
    pub fn has_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.hosted.has_keyboard(window, cx)
    }

    /// The Options menu (or a right-click on its header) at `anchor`.
    fn menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let scx = self.scx.clone();
        let shown = self.hosted.is_open().then_some(self.tab);
        options_menu(
            PaneTab::tabs(cx),
            shown,
            anchor,
            window,
            cx,
            move |pick, window, cx| match pick {
                MenuPick::Tab(t) => {
                    tab_clicked(t, window, cx);
                    scx.call(LUA, "show", vec![Value::from(t.slug())]);
                }
                MenuPick::Hide => scx.call(LUA, "hide", vec![]),
            },
        );
    }

    fn on_action(&mut self, ev: &ToolActionEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ToolActionEvent(id, bounds) = ev;
        match *id {
            "options" => self.menu(Anchor::Below(*bounds), window, cx),
            "maximize" => super::panel::maximize(&self.scx, cx),
            "hide" => self.scx.call(LUA, "hide", vec![]),
            _ => {}
        }
    }

    /// The window asks nvim to show it with the keys ([`HostedFocus::asked`]).
    pub fn keys_asked(&mut self, cx: &App) {
        self.hosted.asked(cx);
    }

    /// The header's lead as it stands: Code's panel's tabs, Problems boxed (another list: its
    /// name alone).
    pub fn sync_lead(&mut self, cx: &mut Context<Self>) {
        let lead = match self.tab {
            PaneTab::Problems => super::panel::lead(super::PanelTab::Problems),
            tab => lead_of(&PaneTab::tabs(cx), self.hosted.is_open().then_some(tab), cx),
        };
        self.header.update(cx, |h, cx| h.set_lead(Some(lead), cx));
    }

    fn on_capture_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        // Esc: the keys back to the code, the pane stays (the screen still gets it)
        if plain_esc(ev) && self.content.esc_leaves(self.tab, cx) {
            self.scx.call(LUA, "leave", vec![]);
        }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if plain_esc(ev) && self.content.esc_leaves(self.tab, cx) {
            cx.stop_propagation();
        }
    }

    /// Any press inside (capture): the host becomes nvim's current window.
    fn on_any_mouse_down(&mut self, _: &MouseDownEvent, _: &mut Window, _: &mut Context<Self>) {
        if !self.hosted.is_current() {
            self.hosted.clicked();
            self.scx.navigate(LUA, "enter", vec![]);
        }
    }

    /// A press nothing inside took: the host takes the keyboard.
    fn on_mouse_down(&mut self, _: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.hosted.take(window, cx);
        cx.stop_propagation();
    }
}

impl Surface for PaneHost {
    const NAME: &'static str = "pane";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let hosted = HostedFocus::new(&scx, cx.focus_handle());
        // Code's bottom panel's header: its tabs (Problems boxed), Options, ⤢, Hide
        let header = cx.new(|_| {
            let mut right = vec![ToolAction::new(
                "options",
                IconName::MoreVertical,
                "Options",
            )];
            right.extend(super::panel::actions());
            ToolTabs::new("", Vec::new())
                .with_actions(Vec::new(), right)
                .with_lead(super::panel::lead(super::PanelTab::Problems))
        });
        let list = super::problems::ProblemsList::new(scx.clone());
        let problems = cx.new(|cx| crate::kit::ListView::new(list, cx));
        let subs = vec![
            cx.subscribe_in(&header, window, |h, _, ev: &ToolActionEvent, window, cx| {
                h.on_action(ev, window, cx)
            }),
            cx.subscribe_in(&header, window, |h, _, ev: &LeadMenuEvent, window, cx| {
                h.menu(Anchor::Point(ev.0), window, cx)
            }),
            cx.subscribe(&header, |h: &mut Self, _, ev: &PaneLeadEvent, _| {
                super::panel::picked(&h.scx, ev.0)
            }),
        ];
        PaneHost {
            scx,
            hosted,
            tab: PaneTab::Problems,
            header,
            content: PaneContent::default(),
            problems,
            _subs: subs,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<HostEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            HostEvent::Open { tab, enter } => {
                if let Some(t) = PaneTab::parse(&tab).filter(|t| *t != PaneTab::Git) {
                    self.tab = t;
                }
                self.hosted.open(enter, window, cx);
                // the projects window hands over what the tab draws (and opens its screen)
                let tab = self.tab;
                if let Some(ws) = self.scx.workspace.upgrade() {
                    ws.update(cx, |_, cx| cx.emit(WorkspaceEvent::PaneWanted(tab)));
                }
            }
            HostEvent::Hide => {
                self.hosted.hide(window, cx);
            }
            HostEvent::Focus => self.hosted.focus_event(window, cx),
            HostEvent::Blur => self.hosted.blur_event(window, cx),
            HostEvent::Problems { files } => {
                self.problems.update(cx, |l, cx| {
                    if l.delegate.set(files) {
                        l.refresh(cx);
                    }
                });
            }
        }
        cx.notify();
    }
}

impl Focusable for PaneHost {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.hosted.handle().clone()
    }
}

impl Render for PaneHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focus = self.hosted.handle().clone();
        // the Factory view over the Editor draws the window's one slot view itself
        let covered = cx
            .try_global::<crate::factory::FactoryShell>()
            .is_some_and(|s| s.shown);
        if self.hosted.is_open() && !covered {
            if self.tab == PaneTab::Problems {
                // the list takes the keys while the pane has them (drawn only with problems to list)
                let list = self.problems.focus_handle(cx);
                let empty = self.problems.read(cx).delegate.files().is_empty();
                if focus.is_focused(window) && !empty {
                    window.focus(&list, cx);
                } else if empty && list.is_focused(window) {
                    // the last problem went: the keys back to the pane (the list isn't drawn)
                    window.focus(&focus, cx);
                }
            } else {
                self.content.place_focus(self.tab, &focus, window, cx);
            }
        }
        let active = self.hosted.has_keyboard(window, cx) && crate::editor::window_active(window);
        self.sync_lead(cx);
        self.header.update(cx, |h, cx| h.set_active(active, cx));
        // it has the keyboard but the workspace's native focus says otherwise: read again
        if self.hosted.has_keyboard(window, cx)
            && let Some(ws) = self.scx.workspace.upgrade()
            && ws.read(cx).native_focus() != Some(Self::NAME)
        {
            window.defer(cx, move |window, cx| {
                ws.update(cx, |ws, cx| ws.resync_native_focus(window, cx));
            });
        }
        let body = match (self.hosted.is_open(), covered) {
            (true, false) if self.tab == PaneTab::Problems => {
                let empty = self.problems.read(cx).delegate.files().is_empty();
                let list = if empty {
                    note(super::problems::NONE)
                } else {
                    div()
                        .debug_selector(|| "pane-problems".into())
                        .flex_1()
                        .min_h_0()
                        .child(self.problems.clone())
                        .into_any_element()
                };
                Some(island(&self.header, list))
            }
            (true, false) => Some(island(&self.header, self.content.body(self.tab))),
            (true, true) => Some(island(&self.header, note(""))),
            (false, _) => None,
        };
        div()
            .id("pane-host")
            .debug_selector(|| "pane-host".into())
            .track_focus(&focus)
            .key_context("BottomPane")
            .relative()
            .size_full()
            .capture_key_down(cx.listener(Self::on_capture_key))
            .on_key_down(cx.listener(Self::on_key))
            .capture_any_mouse_down(cx.listener(Self::on_any_mouse_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .when_some(body, |d, b| d.child(b))
    }
}

/// What the Factory view's pane tells the projects window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactoryPaneEvent {
    /// A tab was picked in its header (Git: the Editor's, the main checkout's).
    Show(PaneTab),
    Hide,
    /// Esc: the keyboard back to the Board.
    Leave,
}

/// The Factory view's bottom pane (under the Board, the projects window's): Sessions, Boxes,
/// Pipelines of the main checkout; its height its own, a third of the body by default.
pub struct FactoryPane {
    focus: FocusHandle,
    /// The tab shown; none: hidden.
    tab: Option<PaneTab>,
    /// Its height as a share of the body (kept while hidden).
    pub share: f32,
    header: Entity<ToolTabs>,
    content: PaneContent,
    _subs: Vec<Subscription>,
}

impl EventEmitter<FactoryPaneEvent> for FactoryPane {}

/// A third of the body (F-Sessions: 280 of the 900 px window's ~846 px body).
pub const DEFAULT_SHARE: f32 = 1. / 3.;
/// The share a drag keeps it in.
pub const MIN_SHARE: f32 = 0.1;
pub const MAX_SHARE: f32 = 0.8;

impl FactoryPane {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let header = cx.new(|cx| header(None, cx));
        let subs = vec![
            cx.subscribe_in(&header, window, |p, _, ev: &ToolActionEvent, window, cx| {
                let ToolActionEvent(id, bounds) = ev;
                match *id {
                    "options" => p.menu(Anchor::Below(*bounds), window, cx),
                    "hide" => cx.emit(FactoryPaneEvent::Hide),
                    _ => {}
                }
            }),
            cx.subscribe_in(&header, window, |p, _, ev: &LeadMenuEvent, window, cx| {
                p.menu(Anchor::Point(ev.0), window, cx)
            }),
        ];
        FactoryPane {
            focus: cx.focus_handle(),
            tab: None,
            share: DEFAULT_SHARE,
            header,
            content: PaneContent::default(),
            _subs: subs,
        }
    }

    /// The tab shown (none: hidden).
    pub fn tab(&self) -> Option<PaneTab> {
        self.tab
    }

    /// The Options menu (or a right-click on its header) at `anchor`.
    fn menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let me = cx.entity().downgrade();
        options_menu(
            PaneTab::ALL.to_vec(),
            self.tab,
            anchor,
            window,
            cx,
            move |pick, window, cx| match pick {
                MenuPick::Tab(t) => {
                    tab_clicked(t, window, cx);
                    let _ = me.update(cx, |_, cx| cx.emit(FactoryPaneEvent::Show(t)));
                }
                MenuPick::Hide => {
                    let _ = me.update(cx, |_, cx| cx.emit(FactoryPaneEvent::Hide));
                }
            },
        );
    }

    /// Its header.
    pub fn header(&self) -> &Entity<ToolTabs> {
        &self.header
    }

    pub fn set_tab(&mut self, tab: Option<PaneTab>, cx: &mut Context<Self>) {
        self.tab = tab.filter(|t| *t != PaneTab::Git);
        cx.notify();
    }

    pub fn set_content(&mut self, content: PaneContent, cx: &mut Context<Self>) {
        self.content = content;
        cx.notify();
    }

    pub fn content(&self) -> &PaneContent {
        &self.content
    }

    /// The pane (or what is inside it) has the keyboard.
    pub fn has_keyboard(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }

    /// Esc while maximized: restores unless its tab has something to close first.
    pub fn esc_restores(&self, cx: &App) -> bool {
        self.tab.is_some_and(|tab| self.content.esc_leaves(tab, cx))
    }
}

impl Focusable for FactoryPane {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FactoryPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = self.tab.unwrap_or_default();
        self.content.place_focus(tab, &self.focus, window, cx);
        let active = self.has_keyboard(window, cx) && crate::editor::window_active(window);
        let lead = lead(self.tab, cx);
        self.header.update(cx, |h, cx| {
            h.set_lead(Some(lead), cx);
            h.set_active(active, cx);
        });
        // hidden: nothing (the projects window draws no island)
        let body = match self.tab {
            Some(tab) => self.content.body(tab),
            None => div().into_any_element(),
        };
        div()
            .id("factory-pane")
            .debug_selector(|| "factory-pane".into())
            .track_focus(&self.focus)
            .key_context("BottomPane")
            .size_full()
            .capture_key_down(cx.listener(|p, ev: &KeyDownEvent, _, cx| {
                let tab = p.tab.unwrap_or_default();
                if plain_esc(ev) && p.content.esc_leaves(tab, cx) {
                    cx.emit(FactoryPaneEvent::Leave);
                }
            }))
            .on_key_down(cx.listener(|p, ev: &KeyDownEvent, _, cx| {
                let tab = p.tab.unwrap_or_default();
                if plain_esc(ev) && p.content.esc_leaves(tab, cx) {
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|p, _: &MouseDownEvent, window, cx| {
                    // hidden, it never takes the keyboard
                    if p.tab.is_some() && !p.focus.contains_focused(window, cx) {
                        window.focus(&p.focus, cx);
                    }
                    cx.stop_propagation();
                }),
            )
            .child(island(&self.header, body))
    }
}

/// Each open workspace's display name (its story title or folder; the rail's hovers), kept by
/// the projects window for the pane's scope.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkspaceNames(pub HashMap<PathBuf, String>);

impl Global for WorkspaceNames {}

/// The workspace's name (its tile's hover).
pub fn name(project: &Path, cx: &App) -> String {
    cx.try_global::<WorkspaceNames>()
        .and_then(|n| n.0.get(project).cloned())
        .unwrap_or_else(|| {
            project
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}
