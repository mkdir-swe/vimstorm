//! The Git tool window: [`GitView`], a native surface drawn over ONE placeholder nvim window
//! in the bottom tool window, with the tabs Local Changes and Log as child entities.
//!
//! # Host window (Lua `config/app/git.lua`)
//!
//! In the app, `git/init.lua`'s entry points (Cmd+3 toggle, open, hide, `file_history`,
//! `show_commit`, Cmd+K commit, Cmd+Shift+K push, session `layout` / `restore`) go to
//! `config/app/git.lua`. It opens one window in the bottom tool window through `config/bottom.lua`
//! (shares it with the terminal: opening one hides the other; same height rules, session, `,w` /
//! `,q`, Alt+Cmd+Left/Right) showing an empty scratch buffer (`b:ws_tool`, filetype
//! `wsgit`). `config/app/layout.lua` reports it with `role = "git"`: the workspace doesn't draw its
//! grid and mounts this view over its island ([`crate::shell::Role::Git`]); no island,
//! no view.
//!
//! # Keyboard
//!
//! The keyboard follows nvim's current window: when the host window becomes current (Cmd+3,
//! Alt+Cmd+arrows, session restore, a click into the view) Lua sends `focus` and the view takes
//! the keyboard (`config/focus.lua` `target()` == "git" while it has it); when it stops being
//! current (Esc, a click on an editor split, Cmd+3 hiding it) Lua sends `blur` / `hide`
//! and the keyboard goes back to nvim. While the host is current the view is the keyboard's
//! "home": a popup / picker closing ([`crate::shell::SurfaceCx::focus_editor`]) comes back
//! here. Keys: the active tab first (its own elements' listeners when focus is inside it, else
//! [`GitTab::on_key`]), then the view: Esc -> back to the split (Lua `leave()`), Alt+Cmd+Left/Right
//! -> previous / next [`Stop`], `,` + key -> nvim's leader maps (`,w` / `,q`). Cmd combos the tab and
//! view leave alone reach nvim (global shortcuts: Cmd+J hides, Cmd+K, ...); other keys are
//! swallowed (workspace rule).
//!
//! # Tabs (phase 2: LOG `log/`, CHANGES `changes/`)
//!
//! A tab is an entity implementing [`GitTab`]: `ID` ([`TabId`]), `new(GitCx, window, cx)`,
//! `label` (the strip's text: "Log: HEAD" etc.), `Render` (the content below the header, the full
//! width; render `div()` placeholders until data comes), and optional hooks: `on_key`, `on_lua`
//! (its own bridge name: Lua's `bridge.notify("git_log" | "git_changes", {event=..})`
//! is routed to it), `refresh(RepoChange)` (the repo changed; reload, dropping stale results by
//! generation), `command(GitCommand)` (Lua entry points: file history, show commit, commit, push;
//! the view switches to the right tab first) and `shown(bool)` (became the visible tab / hidden).
//! The view creates every tab once and keeps them alive while hidden.
//!
//! [`GitCx`] (clone it): `scx` (the [`crate::shell::SurfaceCx`]: rpc, geometry, `call` Lua),
//! `root()` (the repo root Lua found; `None` before the first open), `generation()` (bumped on
//! every repo change), `git(args, cx)` (`git -C <root> ...` off the UI thread), `focus_view` (gives
//! the keyboard to the view: call it from your click handlers when your tab has no focus handle of
//! its own).
//!
//! Repo changes ([`RepoChange`]) come from Lua's `git.cli.changed()` (commit, checkout, push, ...
//! run by Lua), the window becoming active (FocusGained) and a light poll (`watch`: `.git/HEAD`,
//! `index`, refs, reflogs, every [`watch::POLL`] while the tool window is shown).
//!
//! Bridge: `vimstorm.git` events `open {tab, enter, root}`, `hide`, `focus`, `blur`,
//! `cycle_tab {dir}`, `changed`, `file_history {path}`, `show_commit {hash}`, `show_range {rev}`,
//! `commit`, `push`.
//! Rust -> Lua: `config.app.git` `tab_changed(tab)` (saved per project in `git-panel-tabs.json`),
//! `enter()`, `leave()`.
//!
//! Timing (`VIMSTORM_TIMING`): "git: Cmd+3 -> first frame" when a Cmd+3 opened the view.

pub mod changes;
mod conversation;
mod flow;
pub mod log;
mod publication;
mod review;
mod submit;
mod watch;
mod writing;

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Mutex;
use std::time::Instant;

use gpui_kit::{
    AnyView, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Render, SharedString, Styled as _, Task, Window, div, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::app;
use crate::kit::IconName;
use crate::kit::notation;
use crate::kit::{ToolAction, ToolActionEvent, ToolTab, ToolTabs, ToolTabsEvent};
use crate::look;
use crate::nvim::lua;
use crate::shell::{Surface, SurfaceCx};

pub use publication::open;
pub use review::ReviewOpen;
pub(crate) use review::{BRIDGE, PrReview, ReviewBridge, sha8};
pub use writing::How;
pub(crate) use writing::Writing;

/// The tabs, in the strip's order (WebStorm's Git tool window minus Stash, which the user doesn't
/// use: Local Changes, Log). PR review is the Log filtered to the PR ([`review`], `log/pr.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabId {
    Changes,
    Log,
}

impl TabId {
    pub const ALL: [TabId; 2] = [TabId::Changes, TabId::Log];

    /// Lua's name (`config/app/git.lua`, `git-panel-tabs.json`).
    pub fn as_str(self) -> &'static str {
        match self {
            TabId::Changes => "changes",
            TabId::Log => "log",
        }
    }

    /// `None` for an unknown name (e.g. "stash" from an older `git-panel-tabs.json`): the shown tab
    /// stays.
    pub fn parse(s: &str) -> Option<TabId> {
        TabId::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// The tab's own bridge name: Lua `bridge.notify(<this>, {event = ..})`.
    pub fn bridge(self) -> &'static str {
        match self {
            TabId::Changes => "git_changes",
            TabId::Log => "git_log",
        }
    }

    /// The tab `dir` steps away, wrapping.
    pub fn step(self, dir: i64) -> TabId {
        let n = TabId::ALL.len() as i64;
        let i = TabId::ALL.iter().position(|t| *t == self).unwrap_or(0) as i64;
        TabId::ALL[(i + dir).rem_euclid(n) as usize]
    }
}

/// Where Alt+Cmd+arrows go, in the header's order: the tabs, then the Log's changed files pane
/// while it shows a commit (its own header tab, "Commit 1a2b3c4d" / "3 Commits": the view doesn't
/// change, only the keyboard moves).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    Tab(TabId),
    CommitFiles,
}

/// Why the tabs should reload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepoChange {
    /// The tool window opened (or the repo root changed).
    Opened,
    /// Lua ran a repo-changing command (`git.cli.changed()`).
    Lua,
    /// The app window became active again (another app may have changed the repo).
    Focus,
    /// `.git` changed on disk (the poll).
    Files,
}

/// Lua entry points the tabs handle (the view picks the tab first).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitCommand {
    /// The Log filtered to one file (`,H`, Show History): repo-relative path.
    FileHistory { path: String },
    /// The Log with a commit selected (from annotate).
    ShowCommit { hash: String },
    /// The Log filtered to a revision range (Branches… › Compare with Current: `main..feat`).
    ShowRange { rev: String },
    /// Cmd+K: Local Changes' commit message.
    Commit,
    /// Cmd+Alt+K: native commit continuation followed by Push only on success.
    CommitPush,
    /// Create or open the current branch's draft PR after reviewing its publication target.
    CreateDraftPr,
    /// Cmd+Shift+K: push.
    Push,
    /// Show History for Selection (`,H`): the commits that touched lines of a file.
    SelectionHistory(LinesRequest),
}

/// Show History for Selection's request (Lua `git/init.lua` `selection_history`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LinesRequest {
    /// Repo-relative, at HEAD.
    pub path: String,
    /// The lines at HEAD (1-based, inclusive).
    pub from: u32,
    pub to: u32,
    /// The chip's text ("blame.ts:3-4", the editor's line numbers).
    pub label: String,
    /// The tab shown before (None: the tool window was hidden); closing goes back to it.
    #[serde(default)]
    pub tab: Option<String>,
}

impl GitCommand {
    /// The tab that handles it.
    pub fn tab(&self) -> TabId {
        match self {
            GitCommand::FileHistory { .. }
            | GitCommand::ShowCommit { .. }
            | GitCommand::ShowRange { .. }
            | GitCommand::SelectionHistory(_) => TabId::Log,
            GitCommand::Commit
            | GitCommand::CommitPush
            | GitCommand::Push
            | GitCommand::CreateDraftPr => TabId::Changes,
        }
    }
}

/// What every tab gets (see the module doc).
#[derive(Clone)]
pub struct GitCx {
    pub scx: SurfaceCx,
    root: Rc<RefCell<Option<PathBuf>>>,
    generation: Rc<Cell<u64>>,
    view_focus: FocusHandle,
}

impl GitCx {
    /// The repo root (Lua's `git.cli.root`); `None` before the tool window first opened.
    pub fn root(&self) -> Option<PathBuf> {
        self.root.borrow().clone()
    }

    /// Bumped on every repo change: results of git runs started before it are stale.
    pub fn generation(&self) -> u64 {
        self.generation.get()
    }

    /// Gives the keyboard to the Git tool window (a click into a tab without its own focus).
    pub fn focus_view(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.view_focus, cx);
    }

    /// The view's focus handle (`contains_focused` = the tool window has the keyboard).
    pub fn view_focus(&self) -> &FocusHandle {
        &self.view_focus
    }
}

/// A tab of the Git tool window (see the module doc).
pub trait GitTab: Render + Sized + 'static {
    const ID: TabId;
    fn new(gcx: GitCx, window: &mut Window, cx: &mut Context<Self>) -> Self;
    /// The strip's text.
    fn label(&self, cx: &App) -> SharedString;
    /// A key while the tool window has the keyboard and this tab is shown (nvim notation, as
    /// [`crate::kit::notation`] gives it). True: handled.
    fn on_key(
        &mut self,
        _key: &str,
        _ev: &KeyDownEvent,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> bool {
        false
    }
    /// A text input of the tab has the keyboard: the view leaves `,` / Esc to it (they're text
    /// or the field's own cancel there).
    fn text_input_focused(&self, _w: &Window, _cx: &App) -> bool {
        false
    }
    /// A key released while the tool window has the keyboard (the Log's held Space).
    fn on_key_up(&mut self, _key: &str, _w: &mut Window, _cx: &mut Context<Self>) {}
    /// Lua -> this tab (`bridge.notify(TabId::bridge(), payload)`).
    fn on_lua(&mut self, payload: Value, _w: &mut Window, _cx: &mut Context<Self>) {
        lua::log_once(Self::ID.bridge(), &payload, "not handled yet");
    }
    /// The repo changed: reload what's shown.
    fn refresh(&mut self, _why: RepoChange, _w: &mut Window, _cx: &mut Context<Self>) {}
    /// A Lua entry point for this tab (it was just made the shown tab).
    fn command(&mut self, _cmd: &GitCommand, _w: &mut Window, _cx: &mut Context<Self>) {}
    /// Became the shown tab (true) / stopped being it or the tool window hid (false).
    fn shown(&mut self, _shown: bool, _w: &mut Window, _cx: &mut Context<Self>) {}
}

type KeyFn = Rc<dyn Fn(&str, &KeyDownEvent, &mut Window, &mut App) -> bool>;
type KeyUpFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type InputFn = Rc<dyn Fn(&Window, &App) -> bool>;
type ValueFn = Rc<dyn Fn(Value, &mut Window, &mut App)>;
type RefreshFn = Rc<dyn Fn(RepoChange, &mut Window, &mut App)>;
type CommandFn = Rc<dyn Fn(&GitCommand, &mut Window, &mut App)>;
type ShownFn = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type LabelFn = Rc<dyn Fn(&App) -> SharedString>;

/// A tab entity behind uniform calls.
#[derive(Clone)]
struct Slot {
    id: TabId,
    view: AnyView,
    label: LabelFn,
    key: KeyFn,
    key_up: KeyUpFn,
    text_input: InputFn,
    bridge: ValueFn,
    refresh: RefreshFn,
    command: CommandFn,
    shown: ShownFn,
}

fn slot<T: GitTab>(entity: &Entity<T>) -> Slot {
    let e = entity.clone();
    let label: LabelFn = {
        let e = e.clone();
        Rc::new(move |cx| e.read(cx).label(cx))
    };
    let key: KeyFn = {
        let e = e.clone();
        Rc::new(move |k, ev, w, cx| e.update(cx, |t, cx| t.on_key(k, ev, w, cx)))
    };
    let key_up: KeyUpFn = {
        let e = e.clone();
        Rc::new(move |k, w, cx| e.update(cx, |t, cx| t.on_key_up(k, w, cx)))
    };
    let text_input: InputFn = {
        let e = e.clone();
        Rc::new(move |w, cx| e.read(cx).text_input_focused(w, cx))
    };
    let bridge: ValueFn = {
        let e = e.clone();
        Rc::new(move |p, w, cx| e.update(cx, |t, cx| t.on_lua(p, w, cx)))
    };
    let refresh: RefreshFn = {
        let e = e.clone();
        Rc::new(move |why, w, cx| e.update(cx, |t, cx| t.refresh(why, w, cx)))
    };
    let command: CommandFn = {
        let e = e.clone();
        Rc::new(move |c, w, cx| e.update(cx, |t, cx| t.command(c, w, cx)))
    };
    let shown: ShownFn = {
        let e = e.clone();
        Rc::new(move |s, w, cx| e.update(cx, |t, cx| t.shown(s, w, cx)))
    };
    Slot {
        id: T::ID,
        view: e.into(),
        label,
        key,
        key_up,
        text_input,
        bridge,
        refresh,
        command,
        shown,
    }
}

/// `vimstorm.git` (config/app/git.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum GitEvent {
    /// The host window opened / was asked for again: show `tab`, take the keyboard if `enter`.
    Open {
        #[serde(default)]
        tab: Option<String>,
        #[serde(default = "yes")]
        enter: bool,
        #[serde(default)]
        root: Option<String>,
        /// The Log's session state (`config/app/git.lua` `log_state`): filters, details width.
        #[serde(default)]
        log: Option<Value>,
    },
    Hide,
    /// The host window became nvim's current window.
    Focus,
    /// It stopped being it.
    Blur,
    CycleTab {
        #[serde(default = "one")]
        dir: i64,
    },
    /// `git.cli.changed()`.
    Changed,
    FileHistory {
        path: String,
    },
    ShowCommit {
        hash: String,
    },
    ShowRange {
        rev: String,
    },
    SelectionHistory(LinesRequest),
    Commit,
    CommitPush,
    CreateDraftPr,
    Push,
}

fn yes() -> bool {
    true
}

fn one() -> i64 {
    1
}

/// When the last Cmd+3 reached nvim (`VIMSTORM_TIMING`: Cmd+3 -> first painted frame).
static OPEN_KEY: Mutex<Option<Instant>> = Mutex::new(None);

/// The editor saw a key: Cmd+3 starts the "open Git" timing.
pub fn key_pressed(keystroke: &gpui_kit::Keystroke) {
    if app::timing_enabled() && keystroke.modifiers.platform && keystroke.key == "3" {
        let now = Instant::now();
        *OPEN_KEY.lock().unwrap_or_else(|e| e.into_inner()) = Some(now);
        log::set_open_key(now);
    }
}

/// A `,` typed: the next key within nvim's `timeoutlen` is a leader key (`config/options.lua`).
const LEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

pub struct GitView {
    scx: SurfaceCx,
    gcx: GitCx,
    focus: FocusHandle,
    changes: Entity<changes::ChangesTab>,
    log: Entity<log::LogTab>,
    review: Entity<review::PrReview>,
    /// A PR review opened before nvim was up: the open waits for its first layout.
    review_open_sub: Option<gpui_kit::Subscription>,
    /// The Create Draft PR dialog, while open (G20), and who had the keyboard before it.
    draft_pr: Option<Entity<publication::DraftPrDialog>>,
    draft_from: Option<FocusHandle>,
    /// Commits `Push N` would push (None until read; G-02's header).
    outgoing: Option<usize>,
    /// The PR under review in this worktree: `Draft PR…` is grey with it.
    open_pr: Option<u64>,
    open_pr_task: Option<Task<()>>,
    outgoing_task: Option<Task<()>>,
    slots: Vec<Slot>,
    active: TabId,
    /// Lua says the host window is open.
    open: bool,
    /// The host window is nvim's current window: the keyboard's home.
    current: bool,
    /// The header: "Git" + the tabs (`ui::tool_tabs`).
    header: Entity<ToolTabs>,
    /// The labels the header shows (synced when a tab's label changes).
    header_labels: Vec<SharedString>,
    leader: Option<Instant>,
    /// A click made the host window current: its `focus` event leaves the keyboard alone.
    click_enter: bool,
    watch: watch::Watch,
    /// A frame should be timed (`VIMSTORM_TIMING`): opened by a Cmd+3.
    time_paint: bool,
    _subs: Vec<gpui_kit::Subscription>,
}

impl GitView {
    pub fn active(&self) -> TabId {
        self.active
    }

    /// A text field of the shown tab has the keys (commit message, Log filter).
    pub fn typing(&self, window: &Window, cx: &App) -> bool {
        (self.slot(self.active).text_input)(window, cx)
    }

    /// The header: "Git" + the tabs (tests read its active state).
    pub fn header(&self) -> &Entity<ToolTabs> {
        &self.header
    }

    /// Lua said the host window is open.
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn gcx(&self) -> &GitCx {
        &self.gcx
    }

    pub fn log(&self) -> &Entity<log::LogTab> {
        &self.log
    }

    pub fn changes(&self) -> &Entity<changes::ChangesTab> {
        &self.changes
    }

    /// The PR review (the Log's PR filter, its strip and files).
    pub fn review(&self) -> &Entity<review::PrReview> {
        &self.review
    }

    /// The tabs in the strip.
    fn tabs(&self, _cx: &App) -> Vec<TabId> {
        TabId::ALL.to_vec()
    }

    /// A PR to review in this worktree project (the Log's PR pick, `changes`): the tool window
    /// opens on the Log filtered to the PR, with the keyboard. A project just opened has no layout
    /// yet (its nvim is starting): the open waits for Lua's first layout, else startup would move
    /// the keyboard off the tool window again.
    pub fn start_review(
        &mut self,
        open: review::ReviewOpen,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.review.update(cx, |r, cx| r.start(open, cx));
        if self.nvim_up(cx) {
            self.open_review_tab();
        } else if let Some(ws) = self.scx.workspace.upgrade() {
            let editor = ws.read(cx).editor().clone();
            self.review_open_sub = Some(cx.observe(&editor, |v, _, cx| {
                if v.nvim_up(cx) {
                    v.review_open_sub = None;
                    v.open_review_tab();
                }
            }));
        }
        cx.notify();
    }

    /// Lua laid the windows out and nvim drew once: its config (the Git host's hooks) is up.
    fn nvim_up(&self, cx: &App) -> bool {
        let flushed = self
            .scx
            .workspace
            .upgrade()
            .is_some_and(|ws| ws.read(cx).editor().read(cx).ui().flushes > 0);
        flushed && !self.scx.geometry().layout.wins.is_empty()
    }

    fn open_review_tab(&self) {
        self.scx.call(
            "config.app.git",
            "open",
            vec![TabId::Log.as_str().into(), true.into()],
        );
    }

    /// The Create Draft PR dialog (G20), over the window; the Git window shows it.
    pub fn show_draft_pr(
        &mut self,
        dialog: Entity<publication::DraftPrDialog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let me = cx.entity().downgrade();
        dialog.update(cx, |d, _| d.set_host(me));
        self.draft_from = window.focused(cx);
        self.draft_pr = Some(dialog);
        if !self.open {
            self.scx.call(
                "config.app.git",
                "open",
                vec![self.active.as_str().into(), false.into()],
            );
        }
        cx.notify();
    }

    /// The Create Draft PR dialog, while open (tests).
    pub fn draft_pr(&self) -> Option<&Entity<publication::DraftPrDialog>> {
        self.draft_pr.as_ref()
    }

    /// The dialog closed (made, reused or cancelled): the keyboard back where it was.
    pub fn close_draft_pr(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.draft_pr = None;
        match self.draft_from.take() {
            Some(from) => window.focus(&from, cx),
            None => self.take_focus(window, cx),
        }
        cx.notify();
    }

    /// Lua -> the PR review (`vimstorm.git_review`: the PR diff's `,i` keys).
    pub fn review_bridge(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        self.review
            .update(cx, |r, cx| r.on_lua(payload, window, cx));
    }

    /// Where the header drew a tab (window coordinates; tests click it). `None` while hidden.
    pub fn tab_bounds(&self, tab: TabId, cx: &App) -> Option<Bounds<Pixels>> {
        if !self.open {
            return None;
        }
        let ix = self.tabs(cx).iter().position(|t| *t == tab)?;
        self.header.read(cx).tab_bounds(ix)
    }

    /// The strip's labels in order (tests): the tabs, then the commit files tab while it's there.
    pub fn labels(&self, cx: &App) -> Vec<SharedString> {
        let tabs = self.tabs(cx);
        let mut labels: Vec<SharedString> = self
            .slots
            .iter()
            .filter(|s| tabs.contains(&s.id))
            .map(|s| (s.label)(cx))
            .collect();
        labels.extend(self.log.read(cx).files_label());
        labels
    }

    /// The stops in the header's order.
    fn stops(&self, cx: &App) -> Vec<Stop> {
        let mut stops: Vec<Stop> = self.tabs(cx).into_iter().map(Stop::Tab).collect();
        if self.log.read(cx).files_label().is_some() {
            stops.push(Stop::CommitFiles);
        }
        stops
    }

    /// The stop the header marks: the Log's files pane while it has the keyboard, else the tab.
    pub fn stop(&self, window: &Window, cx: &App) -> Stop {
        if self.active == TabId::Log && self.log.read(cx).files_focused(window, cx) {
            Stop::CommitFiles
        } else {
            Stop::Tab(self.active)
        }
    }

    /// Alt+Cmd+Left/Right: the stop `dir` away, wrapping.
    fn cycle(&mut self, dir: i64, window: &mut Window, cx: &mut Context<Self>) {
        let stops = self.stops(cx);
        let here = self.stop(window, cx);
        let i = stops.iter().position(|s| *s == here).unwrap_or(0) as i64;
        let to = stops[(i + dir).rem_euclid(stops.len() as i64) as usize];
        self.go_to(to, window, cx);
    }

    /// Shows a stop: its tab, and the keyboard into the Log's table / files pane.
    fn go_to(&mut self, stop: Stop, window: &mut Window, cx: &mut Context<Self>) {
        match stop {
            Stop::Tab(TabId::Log) if self.active == TabId::Log => {
                self.gcx.focus_view(window, cx);
            }
            Stop::Tab(tab) => self.select(tab, window, cx),
            Stop::CommitFiles if self.active == TabId::Log => {
                self.log.update(cx, |l, cx| l.focus_files(window, cx));
            }
            Stop::CommitFiles => {
                self.select(TabId::Log, window, cx);
                // the pane isn't drawn yet: the Log focuses it once it is
                self.log.update(cx, |l, cx| l.focus_files_when_drawn(cx));
            }
        }
        cx.notify();
    }

    fn slot(&self, tab: TabId) -> Slot {
        self.slots
            .iter()
            .find(|s| s.id == tab)
            .cloned()
            .expect("every TabId has a slot")
    }

    /// Shows `tab` (tells Lua, which saves it per project).
    pub fn select(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if tab == self.active {
            return;
        }
        let old = self.slot(self.active);
        self.active = tab;
        (old.key_up)("<Space>", window, cx);
        (old.shown)(false, window, cx);
        if self.open {
            (self.slot(tab).shown)(true, window, cx);
        }
        self.scx
            .call("config.app.git", "tab_changed", vec![tab.as_str().into()]);
        cx.notify();
    }

    /// Takes the keyboard (the host window is current, or a click into the view).
    fn take_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.contains_focused(window, cx) {
            window.focus(&self.focus, cx);
        }
    }

    fn set_current(&mut self, current: bool) {
        self.current = current;
        // only clear a home that's ours: the terminal's host may have become current first
        if current {
            self.scx.home.set(Some(self.focus.clone()));
        } else {
            self.scx.home.release(&self.focus);
        }
    }

    pub(crate) fn refresh(&mut self, why: RepoChange, window: &mut Window, cx: &mut Context<Self>) {
        self.gcx.generation.set(self.gcx.generation.get() + 1);
        for s in self.slots.clone() {
            (s.refresh)(why, window, cx);
        }
        self.read_outgoing(cx);
    }

    /// The header's `Push N`: the commits a push would send, read off the UI thread.
    fn read_outgoing(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let task = crate::git::job::spawn(cx, move || {
            crate::git::ops::push_info_blocking(&root).ok().map(|i| {
                if i.branch.is_some() {
                    i.outgoing.len()
                } else {
                    0
                }
            })
        });
        self.outgoing_task = Some(cx.spawn(async move |this, cx| {
            let n = task.await;
            let _ = this.update(cx, |v, cx| {
                v.outgoing = n;
                let actions = v.header_actions();
                v.header
                    .update(cx, |h, cx| h.set_right_actions(actions, cx));
            });
        }));
    }

    /// The header's right end (G-02): `Commit`, `Push N` (disabled: nothing to push),
    /// `Draft PR…`, Options, Hide.
    fn header_actions(&self) -> Vec<ToolAction> {
        let n = self.outgoing.unwrap_or(0);
        vec![
            ToolAction::new("commit", IconName::Commit, "Commit")
                .shortcut("⌘K")
                .label("Commit"),
            ToolAction::new(
                "push",
                IconName::Push,
                if self.outgoing == Some(0) {
                    "Nothing to push"
                } else {
                    "Push"
                },
            )
            .shortcut("⇧⌘K")
            .label("Push")
            .count((n > 0).then(|| n.to_string()))
            .disabled(self.outgoing == Some(0)),
            ToolAction::new(
                "create-draft-pr",
                IconName::PullRequests,
                match self.open_pr {
                    Some(n) => {
                        format!("Create Draft PR… · PR #{n} is already open for this branch")
                    }
                    None => "Create Draft PR…".to_owned(),
                },
            )
            .label("Draft PR…")
            .disabled(self.open_pr.is_some()),
            ToolAction::new("options", IconName::MoreVertical, "Options"),
        ]
        .into_iter()
        .chain(crate::shell::panel_actions())
        .collect()
    }

    /// The PR open for this workspace's branch: the one reviewed in this worktree, followed every
    /// second while the window shows: `Draft PR…` goes grey with it.
    fn follow_open_pr(&mut self, cx: &mut Context<Self>) {
        self.open_pr_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let shown = this.read_with(cx, |v, _| v.open).unwrap_or(false);
                if shown {
                    let pr = this
                        .read_with(cx, |v, cx| v.review.read(cx).number())
                        .ok()
                        .flatten();
                    let gone = this
                        .update(cx, |v, cx| {
                            if v.open_pr != pr {
                                v.open_pr = pr;
                                let actions = v.header_actions();
                                v.header
                                    .update(cx, |h, cx| h.set_right_actions(actions, cx));
                            }
                        })
                        .is_err();
                    if gone {
                        return;
                    }
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
            }
        }));
    }

    fn open(
        &mut self,
        tab: Option<TabId>,
        enter: bool,
        root: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let new_root = root.is_some() && root != self.gcx.root();
        if let Some(root) = root {
            *self.gcx.root.borrow_mut() = Some(root.clone());
            self.watch.set_root(root);
        }
        let was_open = std::mem::replace(&mut self.open, true);
        if let Some(tab) = tab
            && tab != self.active
        {
            let old = self.slot(self.active);
            self.active = tab;
            if was_open {
                (old.shown)(false, window, cx);
            }
        }
        if !was_open || new_root {
            if !was_open && let Some(at) = *OPEN_KEY.lock().unwrap_or_else(|e| e.into_inner()) {
                self.time_paint = true;
                let ms = at.elapsed().as_secs_f64() * 1000.;
                app::mark(&format!("git: Cmd+3 -> open event {ms:.1} ms"));
            }
            (self.slot(self.active).shown)(true, window, cx);
            self.refresh(RepoChange::Opened, window, cx);
            self.watch.start(window, cx);
        } else if tab.is_some() {
            (self.slot(self.active).shown)(true, window, cx);
        }
        if enter {
            self.set_current(true);
            self.take_focus(window, cx);
        }
        cx.notify();
    }

    /// Its project is shown / hidden (behind another open project): a hidden Git tool window
    /// doesn't poll the repo; shown again, it refreshes once.
    pub fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !active {
            self.watch.stop();
        } else if self.open {
            self.refresh(RepoChange::Focus, window, cx);
            self.watch.start(window, cx);
        }
    }

    fn hide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.watch.stop();
        self.release_keys(window, cx);
        (self.slot(self.active).shown)(false, window, cx);
        let had = self.focus.contains_focused(window, cx);
        self.set_current(false);
        if had {
            self.scx.focus_editor(window, cx);
        }
        cx.notify();
    }

    /// A Lua entry point: its tab shown, then the command.
    fn command(&mut self, cmd: GitCommand, window: &mut Window, cx: &mut Context<Self>) {
        if cmd == GitCommand::CreateDraftPr {
            let me = cx.entity().downgrade();
            publication::open_current(me, self.scx.project.clone(), window, cx);
            return;
        }
        // a push from anywhere (Cmd+Shift+K) leaves the shown tab alone (WS pushes in a dialog)
        if cmd != GitCommand::Push {
            self.select(cmd.tab(), window, cx);
        }
        (self.slot(cmd.tab()).command)(&cmd, window, cx);
    }

    /// Lua -> a tab (`vimstorm.git_log` ...).
    pub fn tab_bridge(
        &mut self,
        tab: TabId,
        payload: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        (self.slot(tab).bridge)(payload, window, cx);
    }

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = notation(ev) else {
            return;
        };
        // a dialog's field has the keys (Create Draft PR): typed there, never the window's
        if self
            .draft_pr
            .as_ref()
            .is_some_and(|d| d.read(cx).typing(window, cx))
        {
            return;
        }
        let typing = (self.slot(self.active).text_input)(window, cx);
        if typing {
            self.leader = None;
        }
        if let Some(at) = self.leader.take()
            && at.elapsed() < LEADER_TIMEOUT
        {
            // ,w / ,q and the other leader keys: the tab's first (the Log's history for a
            // selection), else nvim's (global maps; the host window is current)
            if !(self.slot(self.active).key)(&format!(",{key}"), ev, window, cx)
                && !crate::factory::stock_keys(cx)
            {
                self.scx.rpc.input(&format!(",{key}"));
            }
            cx.stop_propagation();
            return;
        }
        if (self.slot(self.active).key)(&key, ev, window, cx) {
            cx.stop_propagation();
            return;
        }
        let m = ev.keystroke.modifiers;
        let handled = match key.as_str() {
            "<Esc>" | "," if typing => false,
            "<Esc>" => {
                self.scx.call("config.app.git", "leave", vec![]);
                true
            }
            "<M-D-Left>" => {
                self.cycle(-1, window, cx);
                true
            }
            "<M-D-Right>" => {
                self.cycle(1, window, cx);
                true
            }
            "," if !m.platform && !m.control => {
                self.leader = Some(Instant::now());
                true
            }
            _ => false,
        };
        if handled {
            cx.stop_propagation();
        }
    }

    fn on_key_up(&mut self, ev: &KeyUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = if ev.keystroke.key == "space" {
            "<Space>".to_string()
        } else {
            ev.keystroke.key.clone()
        };
        (self.slot(self.active).key_up)(&key, window, cx);
    }

    fn on_mouse_down(&mut self, _: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // a click into the tool window that nothing inside took: the view takes the keyboard
        self.take_focus(window, cx);
        cx.stop_propagation();
    }

    /// Any click into the tool window (capture phase, before the rows / trees inside stop it):
    /// its host window becomes nvim's current window.
    fn on_any_mouse_down(&mut self, _: &MouseDownEvent, _w: &mut Window, _cx: &mut Context<Self>) {
        if !self.current {
            self.set_current(true);
            // the click decides where the keyboard goes (a row, a menu it opens): Lua's `focus`
            // answer to this `enter` mustn't take it back to the view
            self.click_enter = true;
        }
        self.scx.navigate("config.app.git", "enter", vec![]);
    }

    /// Keys can't come up while the keyboard is elsewhere: tell the tab they did (the Log's
    /// held Space).
    fn release_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        (self.slot(self.active).key_up)("<Space>", window, cx);
    }

    /// The header's ⋮: the tabs (the shown one checked) and Hide.
    fn options_menu(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::popups::{Menu, MenuEntry, MenuItem};
        let tabs = self.tabs(cx);
        let mut entries: Vec<MenuEntry> = tabs
            .iter()
            .map(|t| {
                let item = MenuItem::new((self.slot(*t).label)(cx));
                if *t == self.active {
                    item.icon(IconName::Checked)
                } else {
                    item
                }
                .into()
            })
            .collect();
        entries.push(MenuEntry::Separator);
        entries.push(MenuItem::new("Create Draft PR…").into());
        entries.push(MenuItem::new("Hide").shortcut("⌘J").into());
        let count = tabs.len();
        let menu = Menu::new(entries, crate::kit::Anchor::Below(bounds));
        let view = cx.entity().downgrade();
        crate::popups::open_menu(menu, window, cx, move |choice, window, cx| {
            let _ = view.update(cx, |v, cx| match choice {
                Some(i) if i < count => v.clicked_tab(tabs[i], window, cx),
                Some(i) if i == count + 1 => v.command(GitCommand::CreateDraftPr, window, cx),
                Some(i) if i == count + 2 => v.scx.call("config.app.git", "hide", Vec::new()),
                _ => {}
            });
        });
    }

    /// Where the header drew a title action ("options", "hide"; tests click them).
    pub fn action_bounds(&self, id: &str, cx: &App) -> Option<Bounds<Pixels>> {
        self.header.read(cx).action_bounds(id)
    }

    /// The repo poll runs (tests: paused while the app is in the background).
    pub fn watching(&self) -> bool {
        self.watch.running()
    }

    /// The header's "▾ N": the hidden tabs in a menu below it.
    fn show_hidden_tabs(
        &mut self,
        hidden: &[usize],
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let labels = self.labels(cx);
        let stops = self.stops(cx);
        let (stops, entries): (Vec<Stop>, Vec<_>) = hidden
            .iter()
            .filter_map(|i| Some((*stops.get(*i)?, labels.get(*i)?.clone())))
            .map(|(stop, label)| (stop, crate::popups::MenuItem::new(label).into()))
            .unzip();
        let menu = crate::popups::Menu::new(entries, crate::kit::Anchor::Below(bounds));
        let view = cx.entity().downgrade();
        crate::popups::open_menu(menu, window, cx, move |choice, window, cx| {
            if let Some(stop) = choice.and_then(|i| stops.get(i).copied()) {
                let _ = view.update(cx, |v, cx| v.clicked_stop(stop, window, cx));
            }
        });
    }

    /// Timing: the first frame after a Cmd+3 opened the view (built now, on screen at the next
    /// frame).
    fn paint_timing(&mut self, window: &mut Window) {
        if !std::mem::take(&mut self.time_paint) {
            return;
        }
        if let Some(at) = OPEN_KEY.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let ms = at.elapsed().as_secs_f64() * 1000.;
            app::mark(&format!("git: Cmd+3 -> first frame built {ms:.1} ms"));
            window.on_next_frame(move |_, _| {
                let ms = at.elapsed().as_secs_f64() * 1000.;
                app::mark(&format!("git: Cmd+3 -> first frame presented {ms:.1} ms"));
            });
        }
    }
}

impl Surface for GitView {
    const NAME: &'static str = "git";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let gcx = GitCx {
            scx: scx.clone(),
            root: Rc::default(),
            generation: Rc::default(),
            view_focus: focus.clone(),
        };
        let changes = cx.new(|cx| changes::ChangesTab::new(gcx.clone(), window, cx));
        let log = cx.new(|cx| log::LogTab::new(gcx.clone(), window, cx));
        let review = cx.new(|cx| review::PrReview::new(gcx.clone(), cx));
        log.update(cx, |l, cx| l.set_review(review.clone(), window, cx));
        let slots = vec![slot(&changes), slot(&log)];
        let header_labels: Vec<SharedString> = slots.iter().map(|s| (s.label)(cx)).collect();
        let header = cx.new(|_| {
            // WS ToolWindowHeader: ⋮ Options and − Hide at the right end; the bottom pane's
            // tabs before its own, Git boxed
            ToolTabs::new(
                "Git",
                header_labels.iter().cloned().map(ToolTab::new).collect(),
            )
            .with_lead(crate::shell::panel_lead(crate::shell::PanelTab::Git))
            .with_actions(
                Vec::new(),
                vec![
                    ToolAction::new("commit", IconName::Commit, "Commit")
                        .shortcut("⌘K")
                        .label("Commit"),
                    ToolAction::new("push", IconName::Push, "Push")
                        .shortcut("⇧⌘K")
                        .label("Push"),
                    ToolAction::new(
                        "create-draft-pr",
                        IconName::PullRequests,
                        "Create Draft PR…",
                    )
                    .label("Draft PR…"),
                    ToolAction::new("options", IconName::MoreVertical, "Options"),
                ]
                .into_iter()
                .chain(crate::shell::panel_actions())
                .collect(),
            )
        });
        let mut subs = Vec::new();
        subs.push(cx.subscribe_in(
            &header,
            window,
            |v, _, ev: &ToolTabsEvent, window, cx| match ev {
                ToolTabsEvent::Select(ix) => {
                    if let Some(stop) = v.stops(cx).get(*ix) {
                        v.clicked_stop(*stop, window, cx);
                    }
                }
                ToolTabsEvent::ShowHidden(hidden, bounds) => {
                    v.show_hidden_tabs(hidden, *bounds, window, cx)
                }
                ToolTabsEvent::Close(_) => {}
            },
        ));
        subs.push(
            cx.subscribe_in(
                &header,
                window,
                |v, _, ev: &ToolActionEvent, window, cx| match ev.0 {
                    "commit" => v.command(GitCommand::Commit, window, cx),
                    "push" => v.command(GitCommand::Push, window, cx),
                    "create-draft-pr" => v.command(GitCommand::CreateDraftPr, window, cx),
                    "options" => v.options_menu(ev.1, window, cx),
                    "maximize" => crate::shell::panel_maximize(&v.scx, cx),
                    "hide" => v.scx.call("config.app.git", "hide", Vec::new()),
                    _ => {}
                },
            ),
        );
        // Code's panel's tabs, leading the header
        subs.push(cx.subscribe(
            &header,
            |v: &mut Self, _, ev: &crate::kit::PaneLeadEvent, _| {
                crate::shell::panel_picked(&v.scx, ev.0)
            },
        ));
        // FocusGained: another app may have changed the repo
        // (the repo poll pauses while the app is in the background: WS syncs on frame activation)
        subs.push(cx.observe_window_activation(window, |v, window, cx| {
            if v.open && window.is_window_active() && v.scx.active() {
                v.refresh(RepoChange::Focus, window, cx);
                v.watch.start(window, cx);
            } else if !window.is_window_active() {
                v.watch.stop();
                v.release_keys(window, cx);
            }
        }));
        // a tab's label changes with its state ("Log: HEAD"): the strip redraws
        subs.push(cx.observe(&changes, |_, _, cx| cx.notify()));
        subs.push(cx.observe(&log, |_, _, cx| cx.notify()));
        subs.push(cx.observe(&review, |_, _, cx| cx.notify()));
        GitView {
            scx,
            gcx,
            focus,
            changes,
            log,
            review,
            review_open_sub: None,
            draft_pr: None,
            draft_from: None,
            outgoing: None,
            open_pr: None,
            open_pr_task: None,
            outgoing_task: None,
            slots,
            active: TabId::Changes,
            open: false,
            current: false,
            header,
            header_labels,
            leader: None,
            click_enter: false,
            watch: watch::Watch::new(),
            time_paint: false,
            _subs: subs,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<GitEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            GitEvent::Open {
                tab,
                enter,
                root,
                log,
            } => {
                if let Some(state) = log {
                    self.log.update(cx, |l, cx| l.restore(state, cx));
                }
                let tab = tab.as_deref().and_then(TabId::parse);
                self.open(tab, enter, root.map(PathBuf::from), window, cx);
            }
            GitEvent::Hide => self.hide(window, cx),
            GitEvent::Focus => {
                self.set_current(true);
                if std::mem::take(&mut self.click_enter) {
                    return;
                }
                if self.open {
                    self.take_focus(window, cx);
                }
            }
            GitEvent::Blur => {
                self.click_enter = false;
                self.release_keys(window, cx);
                let had = self.focus.contains_focused(window, cx);
                self.set_current(false);
                if had {
                    self.scx.focus_editor(window, cx);
                }
            }
            GitEvent::CycleTab { dir } => self.cycle(dir, window, cx),
            GitEvent::Changed => self.refresh(RepoChange::Lua, window, cx),
            GitEvent::FileHistory { path } => {
                self.command(GitCommand::FileHistory { path }, window, cx)
            }
            GitEvent::ShowCommit { hash } => {
                self.command(GitCommand::ShowCommit { hash }, window, cx)
            }
            GitEvent::ShowRange { rev } => self.command(GitCommand::ShowRange { rev }, window, cx),
            GitEvent::SelectionHistory(req) => {
                self.command(GitCommand::SelectionHistory(req), window, cx)
            }
            GitEvent::Commit => self.command(GitCommand::Commit, window, cx),
            GitEvent::CommitPush => self.command(GitCommand::CommitPush, window, cx),
            GitEvent::CreateDraftPr => self.command(GitCommand::CreateDraftPr, window, cx),
            GitEvent::Push => self.command(GitCommand::Push, window, cx),
        }
    }
}

impl Focusable for GitView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for GitView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.paint_timing(window);
        // an inactive app window has no active tool window (WebStorm dims it with the frame)
        let focused =
            self.focus.contains_focused(window, cx) && crate::editor::window_active(window);
        self.sync_header(focused, window, cx);
        let content = self.slot(self.active).view;
        let on_key = cx.listener(Self::on_key_down);
        let on_key_up = cx.listener(Self::on_key_up);
        let on_left = cx.listener(Self::on_mouse_down);
        let on_right = cx.listener(Self::on_mouse_down);
        div()
            .id("git-tool-window")
            .key_context("GitToolWindow")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(look::PANEL_BG)
            .text_color(look::TEXT)
            .on_key_down(on_key)
            .on_key_up(on_key_up)
            .capture_any_mouse_down(cx.listener(Self::on_any_mouse_down))
            .on_mouse_down(MouseButton::Left, on_left)
            .on_mouse_down(MouseButton::Right, on_right)
            .child(self.header.clone())
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_hidden()
                    .child(content),
            )
            .children(self.draft_pr.clone())
    }
}

impl GitView {
    /// The header follows the tabs' labels ("Log: HEAD" -> "Log"), the shown tab and the focus.
    fn sync_header(&mut self, focused: bool, window: &Window, cx: &mut Context<Self>) {
        let labels = self.labels(cx);
        let here = self.stop(window, cx);
        let stops = self.stops(cx);
        // the files pane with no tab of its own (a PR's files under review): its tab, Log
        let selected = stops
            .iter()
            .position(|s| *s == here)
            .or_else(|| stops.iter().position(|s| *s == Stop::Tab(self.active)))
            .unwrap_or(0);
        let changed = labels != self.header_labels;
        if changed {
            self.header_labels = labels.clone();
        }
        if self.open_pr_task.is_none() {
            self.follow_open_pr(cx);
        }
        self.header.update(cx, |h, cx| {
            if changed {
                h.set_tabs(labels.into_iter().map(ToolTab::new).collect(), cx);
            }
            if h.selected() != selected {
                h.select(selected, cx);
            }
            h.set_active(focused, cx);
            // Code's panel's tabs before Git's own
            h.set_lead(
                Some(crate::shell::panel_lead(crate::shell::PanelTab::Git)),
                cx,
            );
        });
    }

    /// Picks a tab from the header (mouse).
    pub(crate) fn clicked_tab(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        self.take_focus(window, cx);
        self.set_current(true);
        self.scx.call("config.app.git", "enter", vec![]);
        self.select(tab, window, cx);
    }

    /// Picks a stop from the header (mouse): a tab, or the commit files tab.
    fn clicked_stop(&mut self, stop: Stop, window: &mut Window, cx: &mut Context<Self>) {
        match stop {
            Stop::Tab(tab) => self.clicked_tab(tab, window, cx),
            Stop::CommitFiles => {
                self.take_focus(window, cx);
                self.set_current(true);
                self.scx.call("config.app.git", "enter", vec![]);
                self.go_to(stop, window, cx);
            }
        }
    }
}
