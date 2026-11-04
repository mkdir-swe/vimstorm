//! The window root: main toolbar, body (tree panel, nvim's islands, bottom tool window), status
//! bar; native surfaces; the Lua bridge's routing; which surface has the keyboard.
//!
//! # Surface contract (phase-2 agents: edit only your own `src/<surface>/`)
//!
//! - A surface is an entity implementing [`Surface`]: `NAME` (bridge name: Lua's
//!   `require("config.app.bridge").notify(NAME, payload)` arrives as RPC method `vimstorm.<NAME>`),
//!   `new(scx: SurfaceCx, window, cx)`, `on_lua(payload: rmpv::Value, window, cx)` (decode with
//!   [`crate::nvim::lua::decode`] into your `#[serde(tag = "event", rename_all = "snake_case")]` enum),
//!   `Render` and `Focusable`. The workspace creates it once and mounts it: toolbar / status bar
//!   in their strips, the tree in its island (`Geometry::layout.tree`), tabs / popups / pickers /
//!   floats in full-window layers (position yourself in window coordinates; overlays render
//!   through GPUI `deferred(anchored()...)`; render an empty `div()` when there's nothing).
//! - [`SurfaceCx`]: `rpc` (nvim, notifications only), `project` (the project dir), `workspace`
//!   ([`WeakEntity<Workspace>`]: `set_tree_open`, `focus_editor`, `editor`), `geometry()` (the
//!   current [`Geometry`] snapshot, window coordinates: `cell_to_px(grid, row, col)`,
//!   `cell_bounds`, `win_rect(win)`, `slots()` = editor splits' tab bar slots + islands, `caret()`,
//!   `layout.tree` / `layout.editor` / `layout.bottom` / `layout.frame`), `call(module, fn, args)`
//!   (Rust -> Lua, [`crate::nvim::lua::call`]), `focus_editor(window, cx)`.
//! - Keyboard: a surface takes it with `window.focus(&its_focus_handle)` (on a click, or when Lua
//!   asks through its bridge event); the workspace notices (focus-in) and tells Lua
//!   `require("config.app").native_focus(NAME)` so `config/focus.lua` `target()` answers "tree"
//!   (NAME "tree") or "popup" (any other surface). Give it back with `scx.focus_editor(..)`.
//!   While a surface has focus its key listeners run first: handle and `cx.stop_propagation()`
//!   what's yours; Cmd / Ctrl combos you don't stop go to nvim (global shortcuts); other keys you
//!   don't handle are swallowed. Modifier changes are watched natively (double Shift).
//!   Lua's `require("config.app").focus(NAME)` sends your surface `{ event = "focus" }`: open if
//!   needed and take the keyboard.
//! - Mouse: your elements get events first (stop propagation for what you handle); set
//!   `.cursor(CursorStyle::PointingHand)` on clickables. Gaps, grids and the toolbar's empty area
//!   (window drag) are the workspace's.
//! - Lua -> a surface: `config/app/<surface>.lua` (your module) calls the bridge; Lua actions that
//!   open your surface in the terminal config get an app-mode branch (`vim.g.vimstorm_app`).
//! - Keyboard home: while a surface drawn over an nvim window has nvim's current window (the
//!   Git tool window, [`crate::git::window`]), giving the keyboard "back to nvim" (`focus_editor`, a
//!   popup closing, Lua's `focus(nil)`) gives it to that surface ([`KeyboardHome`]); it hands it to
//!   the editor itself when nvim's current window leaves it.
//! - Surfaces over nvim windows: Lua's layout gives a window a `role` ([`layout::Role`]): its
//!   grid isn't drawn (no island, no mouse, no caret) and the role's surface is mounted over its
//!   island (`Geometry::role_rect`). `role = "git"` -> [`crate::git::window::GitView`], whose tabs get
//!   their own bridge names (`git_log`, `git_changes`).
//! - Full-window layers, bottom to top: tabs, the minimap ([`crate::editor::minimap`]), markdown ([`crate::editor::markdown`]), annotate
//!   ([`crate::git::annotate`]), diff ([`crate::git::diff`]),
//!   the ⌘R replace bar ([`crate::editor::replace`], E-16),
//!   floats, popups, pickers. Overlays painting over grid
//!   cells read [`SurfaceCx::drawn`] in their element's prepaint / paint (each window grid's
//!   origin, smooth scroll offset, rows drawn, held picture; set by the editor's grid element
//!   earlier in the same frame), so they never drift from the text.
//! - Sync groups (diff / merge panes): Lua's layout gives windows a `sync` group id
//!   (`git/scrollsync.lua`) and `vimstorm.sync` `synced {tops}` markers; the editor presents a
//!   group's grids together ([`crate::nvim`]) and sends wheel scrolls over a pane to
//!   `require("git.scrollsync").scroll(win, lines)` (all panes in one nvim call).
//! - Viewer panes: Lua's layout gives diff / merge panes a `viewer` place
//!   ([`layout::ViewerPane`]); the layout joins them into one island and reserves the chrome
//!   ([`layout::ViewerRect`]: toolbar, titles, gutters, dividers, merge buttons) that
//!   [`crate::git::diff`] draws.
//! - Roles: Lua modules add roles without editing `config/app/layout.lua`:
//!   `require("config.app.layout").role_provider(name, function(win) return "terminal" |
//!   "markdown" | nil end)` (asked after Git's host; first answer wins; `sync()` when an answer
//!   changes outside its autocmds). Role windows are never `empty`.
//! - The Chat column ([`column`]): a right island the layout reserves
//!   ([`layout::Frame::chat`], full height, its width off nvim's screen), drawn by the
//!   workspace's [`column::ChatColumn`]: the bridge's `chat` slot, rendered (Chat mode) or the
//!  session's Claude Code TUI (Terminal mode); the AI chat only, no shells.
//!   Its state is the window's ([`column::ColumnState`]); ⌘4, ⌃⌘← ⌃⌘→ and ⌘⇧D are the window's
//!   keys (the projects window's capture; a bare workspace's own).
//! - Maximize ([`maximize`]): ⌥⌘⏎ gives the body to the island with the keyboard (a
//!   split, the tree, the Chat column, the bottom pane); the editor's layout leaves the rest out
//!   ([`layout::Layout::maximize`]), the label goes over it.
//! - Terminal ([`layout::Role::Terminal`], ONE host in the bottom tool window):
//!   [`crate::terminal::TerminalView`] is mounted like the GitView (island slot; unseen while
//!   `is_open()` / focused but not laid out), its keyboard a [`HostedFocus`]. The way in:
//!   [`crate::terminal::open`] (the stripe, ⌘T).
//! - The bottom pane ([`layout::Role::Pane`], ONE host in the bottom tool window):
//!   [`pane::PaneHost`] (Sessions, Boxes, Pipelines; Git is the GitView's own host) is mounted like
//!   the terminal, in a plain slot (it draws its own island). What its tabs draw comes from the
//!   projects window ([`WorkspaceEvent::PaneWanted`]).
//! - Markdown ([`layout::Role::Markdown`], MANY windows: `Geometry::role_rects`): grids not
//!   drawn, no grid mouse / caret; a split keeps its tab bar slot (tabs layer) and its island
//!   (painted by the editor, [`layout::WinRect::draws_island`]); [`crate::editor::markdown::MarkdownView`]
//!   (full-window layer) paints each preview over [`layout::WinRect::surface_rect`] and gets the
//!   mouse there (nvim's grid isn't under it; leave the outer [`layout::GRAB`] px to gap drags).
//! - Hosted keyboard: a surface over a host window (the terminal) uses [`HostedFocus`]
//!   (`open {enter}` / `hide` / `focus` / `blur` from its Lua module's WinEnter / WinLeave,
//!   `clicked` + Lua `enter()` on any click into it); [`KeyboardHome::release`] clears the home
//!   only if it's that surface's, so two hosts (Git, the pane) hand over in any event order.

mod activity;
mod column;
pub mod effects;
mod hosted;
mod layout;
mod lifecycle;
mod pane;
mod pane_key;
mod panel;
mod problems;
pub mod projects;
mod recent;
pub mod remote;
pub mod toolbar;
pub mod tree;

pub use column::{
    CHAT, ColumnMode, ColumnState, load_width, set_state as set_column_state,
    state as column_state, torn_title,
};
pub use hosted::HostedFocus;
pub(crate) use layout::{
    Axis, EditorSlot, GridPlace, ISLAND_RADIUS, NvimWin, Panels, SyncGroup, ViewerPane, ViewerRect,
    WinRect, col_at,
};
pub use layout::{
    CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, CHAT_WIDTH, EDITOR_MIN_WIDTH, FRAME_BG, Frame, GAP, Gap,
    GapKind, Geometry, ISLAND_BORDER, Island, MARGIN, PlaceKind, Role, TOOLBAR_HEIGHT,
    TREE_MIN_WIDTH, WinKind, layout,
};
pub use pane::{PaneTab, name as workspace_name};
pub use pane_key::{PaneAct, PaneKey, PaneState};
pub use panel::{PanelMemo, PanelTab};
pub(crate) use panel::{
    actions as panel_actions, lead as panel_lead, maximize as panel_maximize,
    picked as panel_picked,
};
pub(crate) use recent::{RecentProject, not_a_project_root, real_path, recent_open_first};
pub use recent::{display_path, home, recent, state_dir};

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::UnboundedReceiver;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, EventEmitter, ExternalPaths, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, ModifiersChangedEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point,
    Render, ScrollWheelEvent, Styled as _, Task, WeakEntity, Window, div, point, px, size,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::floats::FloatsView;
use crate::editor::markdown::MarkdownView;
use crate::editor::minimap::MinimapView;
use crate::editor::replace::ReplaceView;
use crate::editor::statusbar::StatusbarView;
use crate::editor::tabs::TabsView;
use crate::editor::{EditorView, WinInfo};
use crate::git::annotate::AnnotateView;
use crate::git::diff::DiffView;
use crate::git::window::{GitView, TabId};
use crate::nvim::GridId;
use crate::nvim::lua;
use crate::nvim::{Nvim, NvimEvent, Rpc};
use crate::popups::PopupsView;
use crate::render::CellMetrics;
use crate::search::PickersView;
use crate::shell::toolbar::ToolbarView;
use crate::shell::tree::TreeView;
use crate::terminal::TerminalView;
use layout::TOOL_BG;

/// The geometry snapshot shared with the surfaces (replaced on every relayout).
#[derive(Clone, Default)]
pub struct GeometryHandle(Rc<RefCell<Rc<Geometry>>>);

impl GeometryHandle {
    pub fn get(&self) -> Rc<Geometry> {
        self.0.borrow().clone()
    }

    pub(crate) fn set(&self, geometry: Rc<Geometry>) {
        *self.0.borrow_mut() = geometry;
    }
}

/// One window grid as the current frame draws it (window coordinates), for overlays painting
/// over its cells ([`SurfaceCx::drawn`]).
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnGrid {
    pub grid: GridId,
    /// Window handle.
    pub win: i64,
    /// Cell (0, 0) without the smooth-scroll offset (rows outside the text area: the winbar).
    pub origin: Point<Pixels>,
    /// The text area's smooth-scroll offset (+ = drawn lower).
    pub offset: Pixels,
    /// Grid rows of the text area.
    pub text_rows: std::ops::Range<usize>,
    /// The text area's clip.
    pub text_clip: Bounds<Pixels>,
    /// Text-area rows on screen: `text_rows` plus the rows kept from the last scroll shown in the
    /// edge the offset reveals (may start below 0 / end past the grid).
    pub drawn_rows: std::ops::Range<i64>,
    /// First buffer line shown (0-based), as presented.
    pub topline: Option<i64>,
    /// A sync group's previous picture is drawn (its partners haven't caught up).
    pub held: bool,
    /// Grid size (cols, rows) as drawn.
    pub cells: (usize, usize),
    pub metrics: CellMetrics,
}

impl DrawnGrid {
    /// Top-left of grid cell (row, col) as drawn now: text-area rows with the offset, including
    /// the kept rows above / below the grid (`drawn_rows`, which win over winbar rows they cover).
    pub fn cell_origin(&self, row: i64, col: i64) -> Point<Pixels> {
        let off = if row >= self.text_rows.start as i64 || row >= self.drawn_rows.start {
            self.offset
        } else {
            Pixels::ZERO
        };
        self.metrics
            .cell_origin(point(self.origin.x, self.origin.y + off), row, col)
    }
}

/// What the last frame drew of each window grid (set by the editor's grid element in prepaint).
#[derive(Clone, Default)]
pub struct DrawnGrids(Rc<RefCell<Rc<HashMap<GridId, DrawnGrid>>>>);

impl DrawnGrids {
    pub fn get(&self, grid: GridId) -> Option<DrawnGrid> {
        self.0.borrow().get(&grid).cloned()
    }

    /// All window grids drawn.
    pub fn all(&self) -> Rc<HashMap<GridId, DrawnGrid>> {
        self.0.borrow().clone()
    }

    pub(crate) fn set(&self, grids: HashMap<GridId, DrawnGrid>) {
        *self.0.borrow_mut() = Rc::new(grids);
    }
}

/// Where "back to nvim" sends the keyboard: the editor, or the surface drawn over nvim's current
/// window (see the module doc).
#[derive(Clone, Default)]
pub struct KeyboardHome(Rc<RefCell<Option<FocusHandle>>>);

impl KeyboardHome {
    pub fn set(&self, handle: Option<FocusHandle>) {
        *self.0.borrow_mut() = handle;
    }

    pub fn get(&self) -> Option<FocusHandle> {
        self.0.borrow().clone()
    }

    /// Clears the home if it's `handle` (a host stopped being current; another one may already
    /// have taken over).
    pub fn release(&self, handle: &FocusHandle) {
        let mut home = self.0.borrow_mut();
        if home.as_ref() == Some(handle) {
            *home = None;
        }
    }
}

/// Whether a workspace's project is the one shown (several open projects share the window,
/// [`projects`]). Hidden projects pause their polls and don't take the keyboard.
#[derive(Clone)]
pub struct ProjectActive(Rc<Cell<bool>>);

impl Default for ProjectActive {
    fn default() -> Self {
        ProjectActive(Rc::new(Cell::new(true)))
    }
}

impl ProjectActive {
    pub fn get(&self) -> bool {
        self.0.get()
    }
}

/// Where the keyboard was in a hidden project (restored when it's shown).
type SavedFocus = Rc<RefCell<Option<FocusHandle>>>;

/// What every surface gets (see the module doc).
#[derive(Clone)]
pub struct SurfaceCx {
    pub rpc: Rpc,
    pub project: PathBuf,
    pub workspace: WeakEntity<Workspace>,
    pub geometry: GeometryHandle,
    pub editor_focus: FocusHandle,
    /// Per-frame drawn grids (overlays).
    pub drawn: DrawnGrids,
    /// Where `focus_editor` sends the keyboard.
    pub home: KeyboardHome,
    /// The project is shown (not hidden behind another open project).
    pub active: ProjectActive,
    /// This project's popups surface (set once it's created).
    pub popups: Rc<RefCell<Option<WeakEntity<PopupsView>>>>,
}

impl SurfaceCx {
    /// The current geometry snapshot (window coordinates).
    pub fn geometry(&self) -> Rc<Geometry> {
        self.geometry.get()
    }

    /// What the current frame draws of each window grid (read it in prepaint / paint).
    pub fn drawn(&self) -> &DrawnGrids {
        &self.drawn
    }

    /// Whether the project is the one shown: hidden ones pause polls / refreshes (resumed with one
    /// refresh when shown again).
    pub fn active(&self) -> bool {
        self.active.get()
    }

    /// A balloon in this project (a hidden project's waits until it's shown). Surfaces use it
    /// for results that may arrive after a switch (git runs).
    pub fn notify(&self, balloon: crate::popups::Balloon, window: &mut Window, cx: &mut App) {
        match self.popups.borrow().clone() {
            Some(p) => crate::popups::notify_in(p, balloon, window, cx),
            None => crate::popups::notify(balloon, window, cx),
        }
    }

    /// Rust -> Lua: `require(module).func(args...)` (a notification).
    pub fn call(&self, module: &str, func: &str, args: Vec<Value>) {
        lua::call(&self.rpc, module, func, args);
    }

    /// Rust -> Lua for a move (a file opened, a tab, a split): [`lua::navigate`], in Normal mode
    /// after what nvim was in (an open `/`, a pending `d`).
    pub fn navigate(&self, module: &str, func: &str, args: Vec<Value>) {
        lua::navigate(&self.rpc, module, func, args);
    }

    /// Gives the keyboard back to nvim: the editor, or the surface over nvim's current window.
    pub fn focus_editor(&self, window: &mut Window, cx: &mut App) {
        let home = self.home.get().unwrap_or_else(|| self.editor_focus.clone());
        window.focus(&home, cx);
    }
}

/// A native surface (see the module doc).
pub trait Surface: Render + Focusable + Sized {
    /// Bridge name: Lua's `notify(NAME, ..)` arrives as `vimstorm.<NAME>`.
    const NAME: &'static str;
    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self;
    /// A Lua -> Rust bridge payload (one table with an `event` field).
    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>);
}

/// Delivers a bridge payload to a surface (outside the workspace's own update).
type Route = Rc<dyn Fn(Value, &mut Window, &mut App)>;

fn route<S: Surface>(entity: &Entity<S>) -> Route {
    let entity = entity.clone();
    Rc::new(move |payload, window, cx| {
        entity.update(cx, |s, cx| s.on_lua(payload, window, cx));
    })
}

/// `vimstorm.layout` (config/app/layout.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum LayoutEvent {
    /// nvim's split windows and what they are, whenever that changes.
    Windows { wins: Vec<LuaWin> },
}

#[derive(Debug, Deserialize)]
struct LuaWin {
    win: i64,
    kind: String,
    #[serde(default)]
    empty: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    sync: Option<i64>,
    /// A diff / merge pane (config/app/diff.lua).
    #[serde(default)]
    viewer: Option<layout::ViewerPane>,
    /// A code split with the WebStorm gutter: its first text column.
    #[serde(default)]
    textoff: Option<u16>,
    /// Feel vscode's breadcrumbs strip under the split's tab bar.
    #[serde(default)]
    crumbs: bool,
}

/// `vimstorm.sync` (git/scrollsync.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum SyncEvent {
    /// A group's panes line up at these toplines (0-based) now.
    Synced { tops: Vec<SyncTop> },
}

#[derive(Debug, Deserialize)]
struct SyncTop {
    win: i64,
    top: i64,
}

/// `vimstorm.focus` (config/app.lua `focus(name|nil)` / `expect(name)`); `asked`: Lua's number
/// for the request.
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum FocusEvent {
    /// The keyboard back to nvim.
    Editor {
        #[serde(default)]
        asked: u64,
    },
    /// A native surface takes the keyboard.
    Surface {
        name: String,
        #[serde(default)]
        asked: u64,
    },
    /// Something Lua sent before this (a hosted surface's `focus` / `blur`, the tree's `focus`)
    /// moves the keyboard; Lua assumed it already.
    Expect { asked: u64 },
}

/// A Chat column key's or a pane key's barrier: nvim answers once the keys typed before it are
/// handled (a focus change nvim still has moves the keyboard first).
const COLUMN_BARRIER: &str = "local ok, bridge = pcall(require, 'config.app.bridge') \
    vim.rpcnotify(ok and bridge.channel() or 0, 'vimstorm.column_key', ...)";

/// A column key waits at most this for its barrier (nvim in a blocking prompt never answers).
const COLUMN_WAIT: Duration = Duration::from_millis(300);

/// How long a `native_focus` may go unacked before the app asks whether nvim is in a blocking
/// prompt (then the held keys go: nvim can't run the notification before a key).
const GATE_CHECK: Duration = Duration::from_millis(300);

/// What a workspace tells the [`projects::Projects`] root holding it.
pub enum WorkspaceEvent {
    /// Its nvim exited on its own (`:qa`): the project closes.
    Exited,
    /// Its bottom pane opened on a tab: the root hands it what the tab draws
    /// ([`pane::PaneHost::set_content`]).
    PaneWanted(pane::PaneTab),
    /// A cloud workspace that couldn't connect: Retry ⏎ starts its Neovim again.
    Retry,
    /// A cloud workspace's attach ended before Neovim answered, with tries left: it starts
    /// again, going on from these.
    Reattach(remote::Tried),
    /// Its Download locally ⌘⏎: this click goes to the bridge.
    Download(String),
}

impl EventEmitter<WorkspaceEvent> for Workspace {}

/// Dragging the tree / editor gap, or the Chat column's.
#[derive(Clone, Copy)]
struct TreeDrag {
    start_x: Pixels,
    start_width: f32,
    /// The Chat column's gap (its width grows to the left).
    chat: bool,
}

pub struct Workspace {
    editor: Entity<EditorView>,
    geometry: GeometryHandle,
    rpc: Rpc,
    toolbar: Entity<ToolbarView>,
    tree: Entity<TreeView>,
    tabs: Entity<TabsView>,
    statusbar: Entity<StatusbarView>,
    popups: Entity<PopupsView>,
    pickers: Entity<PickersView>,
    floats: Entity<FloatsView>,
    git: Entity<GitView>,
    diff: Entity<DiffView>,
    annotate: Entity<AnnotateView>,
    minimap: Entity<MinimapView>,
    terminal: Entity<TerminalView>,
    column: Entity<column::ChatColumn>,
    pane: Entity<pane::PaneHost>,
    markdown: Entity<MarkdownView>,
    replace: Entity<ReplaceView>,
    home: KeyboardHome,
    routes: HashMap<&'static str, Route>,
    /// Surfaces' focus handles, by name.
    focusables: Vec<(&'static str, FocusHandle)>,
    /// Which surface Lua was last told has the keyboard.
    native: Option<&'static str>,
    /// The last focus request from Lua handled (config/app.lua `asked`): sent with every
    /// `native_focus`, so Lua can tell an answer from a report older than its request.
    asked: u64,
    /// Lua asked for a focus change: the next sync answers even when nothing changed.
    answer_due: bool,
    /// Gives up on Lua's ack of the last `native_focus` when nvim waits for input in a blocking
    /// prompt (it can't run the notification before a key comes).
    gate_check: Option<Task<()>>,
    drag: Option<TreeDrag>,
    /// Chat column keys and pane keys waiting for their barrier ([`COLUMN_BARRIER`]), oldest
    /// first.
    column_keys: std::collections::VecDeque<(u64, pane_key::Queued)>,
    column_seq: u64,
    /// Code's bottom panel's last tab with the keys (⌘J shows it again).
    panel_last: panel::PanelTab,
    project: PathBuf,
    active: ProjectActive,
    /// Held by a [`projects::Projects`] root: nvim exiting closes the project (an event), not the
    /// app.
    managed: bool,
    /// Where the keyboard was when the project was hidden (restored when it's shown again).
    saved_focus: SavedFocus,
    /// A cloud workspace's link to its box ([`remote`]); None for a local project.
    remote: Option<remote::RemoteLink>,
    /// Its clock (the seconds RemoteState counts, the connect wait, the round trip, the wait
    /// before the next try).
    remote_task: Option<Task<()>>,
    /// How its Neovim's process ended (a cloud workspace's: the attach's exit code and stderr).
    nvim_exit: crate::nvim::ExitSlot,
    _tasks: Vec<Task<()>>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl Workspace {
    /// The window root around `nvim`, whose events come in on `events`.
    pub fn new(
        nvim: Nvim,
        events: UnboundedReceiver<NvimEvent>,
        project: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let rpc = nvim.rpc.clone();
        let nvim_exit = nvim.exit();
        let geometry = GeometryHandle::default();
        let drawn = DrawnGrids::default();
        let home = KeyboardHome::default();
        let active = ProjectActive::default();
        let shared = geometry.clone();
        let drawn2 = drawn.clone();
        let editor = cx.new(|cx| EditorView::new(nvim, shared, drawn2, window, cx));
        let scx = SurfaceCx {
            rpc: rpc.clone(),
            project: project.clone(),
            workspace: cx.entity().downgrade(),
            geometry: geometry.clone(),
            editor_focus: editor.read(cx).focus_handle(cx),
            drawn,
            home: home.clone(),
            active: active.clone(),
            popups: Rc::default(),
        };
        let toolbar = cx.new(|cx| ToolbarView::new(scx.clone(), window, cx));
        let tree = cx.new(|cx| TreeView::new(scx.clone(), window, cx));
        let tabs = cx.new(|cx| TabsView::new(scx.clone(), window, cx));
        let statusbar = cx.new(|cx| StatusbarView::new(scx.clone(), window, cx));
        let popups = cx.new(|cx| PopupsView::new(scx.clone(), window, cx));
        *scx.popups.borrow_mut() = Some(popups.downgrade());
        let pickers = cx.new(|cx| PickersView::new(scx.clone(), window, cx));
        let floats = cx.new(|cx| FloatsView::new(scx.clone(), window, cx));
        let git = cx.new(|cx| GitView::new(scx.clone(), window, cx));
        let diff = cx.new(|cx| DiffView::new(scx.clone(), window, cx));
        let annotate = cx.new(|cx| AnnotateView::new(scx.clone(), window, cx));
        let minimap = cx.new(|cx| MinimapView::new(scx.clone(), window, cx));
        let terminal = cx.new(|cx| TerminalView::new(scx.clone(), window, cx));
        let column = cx.new(|cx| column::ChatColumn::new(scx.clone(), window, cx));
        let pane = cx.new(|cx| pane::PaneHost::new(scx.clone(), window, cx));
        statusbar.update(cx, |s, cx| s.follow_popups(&popups, cx));
        let markdown = cx.new(|cx| MarkdownView::new(scx.clone(), window, cx));
        let replace = cx.new(|cx| ReplaceView::new(scx.clone(), window, cx));

        let mut routes = HashMap::new();
        routes.insert(ToolbarView::NAME, route(&toolbar));
        routes.insert(TreeView::NAME, route(&tree));
        routes.insert(TabsView::NAME, route(&tabs));
        routes.insert(StatusbarView::NAME, route(&statusbar));
        routes.insert(PopupsView::NAME, route(&popups));
        routes.insert(PickersView::NAME, route(&pickers));
        routes.insert(FloatsView::NAME, route(&floats));
        routes.insert(GitView::NAME, route(&git));
        routes.insert(DiffView::NAME, route(&diff));
        routes.insert(AnnotateView::NAME, route(&annotate));
        routes.insert(MinimapView::NAME, route(&minimap));
        routes.insert(TerminalView::NAME, route(&terminal));
        routes.insert(pane::PaneHost::NAME, route(&pane));
        routes.insert(MarkdownView::NAME, route(&markdown));
        routes.insert(ReplaceView::NAME, route(&replace));
        // the Git tool window's tabs: their own bridge names, through the view
        for tab in TabId::ALL {
            let git = git.clone();
            let deliver: Route = Rc::new(move |payload, window, cx| {
                git.update(cx, |g, cx| g.tab_bridge(tab, payload, window, cx));
            });
            routes.insert(tab.bridge(), deliver);
        }
        // PR review in the Log: the PR diff's `,i` keys (config/app/review.lua)
        {
            let git = git.clone();
            let deliver: Route = Rc::new(move |payload, window, cx| {
                git.update(cx, |g, cx| g.review_bridge(payload, window, cx));
            });
            routes.insert(crate::git::window::BRIDGE, deliver);
        }
        let focusables = vec![
            (ToolbarView::NAME, toolbar.focus_handle(cx)),
            (TreeView::NAME, tree.focus_handle(cx)),
            (TabsView::NAME, tabs.focus_handle(cx)),
            (StatusbarView::NAME, statusbar.focus_handle(cx)),
            (PopupsView::NAME, popups.focus_handle(cx)),
            (PickersView::NAME, pickers.focus_handle(cx)),
            (FloatsView::NAME, floats.focus_handle(cx)),
            (GitView::NAME, git.focus_handle(cx)),
            (DiffView::NAME, diff.focus_handle(cx)),
            (AnnotateView::NAME, annotate.focus_handle(cx)),
            (MinimapView::NAME, minimap.focus_handle(cx)),
            (TerminalView::NAME, terminal.focus_handle(cx)),
            (pane::PaneHost::NAME, pane.focus_handle(cx)),
            (MarkdownView::NAME, markdown.focus_handle(cx)),
            (ReplaceView::NAME, replace.focus_handle(cx)),
            // the Chat column (both modes)
            (column::CHAT, column.focus_handle(cx)),
        ];

        let mut subs = Vec::new();
        let editor_focus = scx.editor_focus.clone();
        for handle in focusables
            .iter()
            .map(|(_, h)| h.clone())
            .chain([editor_focus.clone()])
        {
            subs.push(cx.on_focus_in(&handle, window, Self::sync_native_focus));
        }
        // focus went nowhere (a surface closed): back to nvim (or the surface over its current
        // window); only the shown project's (every workspace in the window hears it)
        let lost_home = home.clone();
        subs.push(cx.on_focus_lost(window, move |ws, window, cx| {
            if !ws.active.get() {
                return;
            }
            let to = lost_home.get().unwrap_or_else(|| editor_focus.clone());
            window.focus(&to, cx);
            ws.sync_native_focus(window, cx);
        }));

        // the window's Chat column: its width off nvim's screen while it is docked and shown
        subs.push(cx.observe_global::<column::ColumnState>(|ws, cx| ws.sync_column(cx)));
        // Feel vscode's Activity bar comes and goes with the Feel
        subs.push(cx.observe_global::<crate::factory::Feel>(|_, cx| cx.notify()));
        let pump = cx.spawn_in(window, async move |this, cx| {
            let mut events = events;
            while let Some(ev) = events.next().await {
                let alive = match ev {
                    NvimEvent::Redraw(batch) => this.update_in(cx, |ws, window, cx| {
                        ws.editor.update(cx, |e, cx| e.apply(batch, window, cx));
                        ws.remote_drew(cx);
                    }),
                    NvimEvent::Notification(method, params) => {
                        let payload = lua::payload(params);
                        let Some(surface) = lua::surface_of(&method).map(str::to_owned) else {
                            continue;
                        };
                        let found = this.update(cx, |ws, _| {
                            let route = ws.routes.get(surface.as_str()).cloned();
                            (route, ws.active.clone(), ws.saved_focus.clone())
                        });
                        match found {
                            Ok((Some(deliver), active, saved)) => cx.update(|window, cx| {
                                let (before, was) = (window.focused(cx), active.get());
                                deliver(payload, window, cx);
                                Self::keep_shown_focus(&active, &saved, before, was, window, cx);
                            }),
                            Ok((None, active, saved)) => this.update_in(cx, |ws, window, cx| {
                                let (before, was) = (window.focused(cx), active.get());
                                ws.on_lua(&surface, payload, window, cx);
                                Self::keep_shown_focus(&active, &saved, before, was, window, cx);
                            }),
                            Err(e) => Err(e),
                        }
                    }
                    NvimEvent::Exited => {
                        let _ = this.update(cx, |ws, cx| {
                            // a cloud workspace that never connected tries again, then stays,
                            // for Retry
                            if ws.remote.as_ref().is_some_and(|r| !r.attached()) {
                                ws.remote_ended(cx);
                            } else if ws.managed {
                                cx.emit(WorkspaceEvent::Exited);
                            } else {
                                crate::app::quitting("nvim exited");
                                cx.quit();
                            }
                        });
                        break;
                    }
                };
                if alive.is_err() {
                    break;
                }
            }
        });

        let chat = column::state(cx).docked_width();
        editor.update(cx, |e, cx| {
            let p = e.panels();
            e.set_panels(Panels { chat, ..p }, cx);
        });
        Workspace {
            editor,
            geometry,
            rpc,
            toolbar,
            tree,
            tabs,
            statusbar,
            popups,
            pickers,
            floats,
            git,
            diff,
            annotate,
            minimap,
            terminal,
            column,
            pane,
            markdown,
            replace,
            home,
            routes,
            focusables,
            native: None,
            asked: 0,
            answer_due: false,
            gate_check: None,
            drag: None,
            column_keys: Default::default(),
            column_seq: 0,
            panel_last: panel::PanelTab::default(),
            project,
            active,
            managed: false,
            saved_focus: SavedFocus::default(),
            remote: None,
            remote_task: None,
            nvim_exit,
            _tasks: vec![pump],
            _subs: subs,
        }
    }

    pub fn editor(&self) -> &Entity<EditorView> {
        &self.editor
    }

    /// The project dir.
    pub fn project(&self) -> &PathBuf {
        &self.project
    }

    /// Whether its project is the one shown.
    pub fn is_active(&self) -> bool {
        self.active.get()
    }

    /// A cloud workspace: its Neovim runs on `attach`'s box; RemoteState shows until it
    /// draws, and the status bar says `☁ <its box>`.
    pub fn set_remote(
        &mut self,
        attach: Arc<crate::shell::remote::Attach>,
        cx: &mut Context<Self>,
    ) {
        self.remote = Some(remote::RemoteLink::new(attach));
        self.remote_building(cx);
        // the waking seconds, and the connect's deadline (none while its workspace is being built)
        self.remote_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let go_on = this.update(cx, |ws, cx| {
                    ws.remote_building(cx);
                    let Some(link) = &ws.remote else {
                        return false;
                    };
                    if link.attached() || link.failed() {
                        return false;
                    }
                    if !link.waits_on_build() && link.since.elapsed() >= link.wait() {
                        let secs = link.wait().as_secs();
                        ws.remote_failed(&format!("No answer for {secs} s"), cx);
                        return false;
                    }
                    ws.remote_changed(cx);
                    true
                });
                if !matches!(go_on, Ok(true)) {
                    return;
                }
            }
        }));
        self.remote_changed(cx);
    }

    /// A try before this one ended: its count, clock and end go on here.
    pub fn carry_remote(&mut self, tried: remote::Tried, cx: &mut Context<Self>) {
        if let Some(link) = &mut self.remote {
            link.carry(tried);
        }
        self.remote_building(cx);
        self.remote_changed(cx);
    }

    /// What the header's feed says now of its workspace being built on its box. The feed
    /// down (no look for it meanwhile) changes nothing: only a look without `building` says the
    /// build is over.
    fn remote_building(&mut self, cx: &mut Context<Self>) {
        let Some(look) = crate::factory::look_of(&self.project, cx) else {
            return;
        };
        let building = look.building.clone();
        if let Some(link) = &mut self.remote {
            link.set_building(building, std::time::Instant::now());
        }
    }

    /// Its Neovim ended before it answered: the attach starts again after its back-off
    /// while tries are left, else it failed, naming the step that ended.
    fn remote_ended(&mut self, cx: &mut Context<Self>) {
        let exit = self.nvim_exit.get().unwrap_or_default();
        let ended = remote::Ended::of(exit.code, &exit.stderr);
        self.remote_building(cx);
        let Some(link) = &mut self.remote else {
            return;
        };
        crate::app::line(&format!(
            "attach to {} ended (try {}, exit {:?}) at {}: {}",
            link.attach.box_.name,
            link.tries,
            exit.code,
            ended.step.name(),
            ended.detail()
        ));
        // Its workspace is being built (no container yet): a docker exec end is not
        // counted, the next try starts once the feed no longer says so (a feed that drops
        // `building` in the same tick as the end counts it: one try)
        if link.holds(&ended) {
            self.remote_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let built = this.update(cx, |ws, cx| {
                        ws.remote_building(cx);
                        ws.remote_changed(cx);
                        ws.remote
                            .as_ref()
                            .filter(|l| !l.waits_on_build())
                            .map(remote::RemoteLink::uncounted)
                    });
                    match built {
                        Ok(Some(tried)) => {
                            let _ =
                                this.update(cx, |_, cx| cx.emit(WorkspaceEvent::Reattach(tried)));
                            return;
                        }
                        Ok(None) => {}
                        Err(_) => return,
                    }
                }
            }));
            self.remote_changed(cx);
            return;
        }
        match link.next_try(ended.clone(), std::time::Instant::now()) {
            Some((after, tried)) => {
                link.ended = Some(ended);
                // RemoteState's seconds go on counting while it waits
                self.remote_task = Some(cx.spawn(async move |this, cx| {
                    let mut left = after;
                    while !left.is_zero() {
                        let tick = left.min(Duration::from_secs(1));
                        cx.background_executor().timer(tick).await;
                        left -= tick;
                        if this.update(cx, |ws, cx| ws.remote_changed(cx)).is_err() {
                            return;
                        }
                    }
                    let _ = this.update(cx, |_, cx| cx.emit(WorkspaceEvent::Reattach(tried)));
                }));
                self.remote_changed(cx);
            }
            None => {
                let why = ended.why();
                link.ended = Some(ended);
                self.remote_failed(&why, cx);
            }
        }
    }

    /// Its link to the box, when it is a cloud workspace.
    pub fn remote(&self) -> Option<&remote::RemoteLink> {
        self.remote.as_ref()
    }

    /// Neovim drew: attached; the round trip measured from now on.
    fn remote_drew(&mut self, cx: &mut Context<Self>) {
        let Some(link) = &mut self.remote else {
            return;
        };
        if link.attached() {
            return;
        }
        link.state = remote::LinkState::Attached;
        let rpc = self.rpc.clone();
        self.remote_task = Some(cx.spawn(async move |this, cx| {
            loop {
                // a hidden project's polls pause
                if this.update(cx, |ws, _| ws.active.get()).unwrap_or(false) {
                    let start = std::time::Instant::now();
                    if rpc.request("nvim_get_mode", Vec::new()).await.is_err() {
                        return;
                    }
                    let took = start.elapsed();
                    let alive = this.update(cx, |ws, cx| {
                        if let Some(link) = &mut ws.remote {
                            link.round_trip = Some(took);
                        }
                        ws.remote_changed(cx);
                    });
                    if alive.is_err() {
                        return;
                    }
                } else if this.update(cx, |_, _| ()).is_err() {
                    return;
                }
                cx.background_executor()
                    .timer(remote::ROUND_TRIP_EVERY)
                    .await;
            }
        }));
        self.remote_changed(cx);
    }

    /// RemoteState's Retry: its Neovim started again, once connecting failed.
    fn remote_retry(&mut self, cx: &mut Context<Self>) {
        if self.remote.as_ref().is_some_and(|l| l.failed()) {
            cx.emit(WorkspaceEvent::Retry);
        }
    }

    /// RemoteState's Download locally: the attach's click, once connecting failed.
    fn remote_download(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .remote
            .as_ref()
            .filter(|l| l.failed())
            .and_then(|l| l.attach.download.clone())
        else {
            return;
        };
        cx.emit(WorkspaceEvent::Download(id));
    }

    pub(crate) fn remote_failed(&mut self, why: &str, cx: &mut Context<Self>) {
        self.remote_task = None;
        let look = crate::factory::look_of(&self.project, cx);
        let (cloud, building) = look.map_or((None, false), |l| (l.cloud, l.building.is_some()));
        let Some(link) = &mut self.remote else {
            return;
        };
        link.fail(why, cloud, building);
        // Kept in the error history; the card goes by itself once the feed says its box
        // came up (a try with no click), else it stays with Retry
        let said = format!("{}: {why}", link.title(std::time::Instant::now()));
        crate::popups::record_error("Cloud workspace", &said, cx);
        self.remote_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let up = this.update(cx, |ws, cx| {
                    // a hidden project's polls pause
                    if !ws.active.get() {
                        return Some(false);
                    }
                    let look = crate::factory::look_of(&ws.project, cx);
                    let (cloud, building) =
                        look.map_or((None, false), |l| (l.cloud, l.building.is_some()));
                    ws.remote.as_ref().map(|l| l.came_up(cloud, building))
                });
                match up {
                    Ok(Some(true)) => {
                        let tried = remote::Tried {
                            tries: 0,
                            since: std::time::Instant::now(),
                            ended: None,
                            ran: true,
                        };
                        let _ = this.update(cx, |_, cx| cx.emit(WorkspaceEvent::Reattach(tried)));
                        return;
                    }
                    Ok(Some(false)) => {}
                    _ => return,
                }
            }
        }));
        self.remote_changed(cx);
    }

    /// The editor slot and the status bar draw it again.
    fn remote_changed(&mut self, cx: &mut Context<Self>) {
        self.statusbar.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    /// A [`projects::Projects`] root holds it: nvim exiting emits [`WorkspaceEvent::Exited`]
    /// instead of quitting the app.
    pub fn set_managed(&mut self) {
        self.managed = true;
    }

    /// Shows (true) / hides (false) its project in the window (the [`projects::Projects`] root
    /// draws only the shown one). Hiding remembers where the keyboard was and pauses the polls
    /// a hidden project doesn't need; showing resumes them with one refresh and gives the
    /// keyboard back where it was. nvim gets FocusLost / FocusGained.
    pub fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        if active == self.active.get() {
            return;
        }
        if !active {
            *self.saved_focus.borrow_mut() = window.focused(cx);
        }
        self.active.0.set(active);
        self.editor
            .update(cx, |e, _| e.set_project_active(active, window));
        // a project whose nvim hasn't titled the window yet (just started): its folder's name,
        // not the previous project's title
        if active && self.editor.read(cx).title().is_empty() {
            let name = self.project.file_name().unwrap_or(self.project.as_os_str());
            window.set_window_title(&name.to_string_lossy());
        }
        // (after this update: they read the workspace)
        let (tree, git) = (self.tree.clone(), self.git.clone());
        window.defer(cx, move |window, cx| {
            tree.update(cx, |t, cx| t.set_active(active, cx));
            git.update(cx, |g, cx| g.set_active(active, window, cx));
        });
        if active {
            crate::popups::make_current(&self.popups, cx);
            let saved = self.saved_focus.borrow_mut().take();
            match saved {
                // the column is the window's: the mode it had the keys in may not show now
                Some(f) if self.column_hides(&f, cx) => self.focus_editor(window, cx),
                Some(f) => window.focus(&f, cx),
                None => self.focus_editor(window, cx),
            }
        }
        cx.notify();
    }

    /// `f` is a column mode's keyboard and the window's column shows no mode it is the keyboard
    /// of (the Factory view's two modes share one).
    fn column_hides(&self, f: &FocusHandle, cx: &App) -> bool {
        let c = self.column.read(cx);
        let modes: Vec<_> = [column::ColumnMode::Chat, column::ColumnMode::Terminal]
            .into_iter()
            .filter(|m| c.target(*m, cx) == *f)
            .collect();
        !modes.is_empty() && modes.iter().all(|m| !column::state(cx).shows(*m))
    }

    /// Drops the remembered keyboard place (a new project: its editor gets the keyboard).
    pub fn forget_focus(&mut self) {
        *self.saved_focus.borrow_mut() = None;
    }

    /// After a hidden project handled a bridge message: if one of its surfaces took the keyboard
    /// (Lua asked, in the background), the shown project keeps it and the hidden one gets it
    /// when it's shown. Checked now and after the deliveries' deferred work, before any frame (a
    /// frame would see an unrendered focus and hand the keyboard to the shown project's editor).
    /// `was_active`: the project was shown before the delivery (one that itself switched away
    /// from it, the toolbar's open of another project, moved the keyboard with the switch: not
    /// a background grab).
    fn keep_shown_focus(
        active: &ProjectActive,
        saved: &SavedFocus,
        before: Option<FocusHandle>,
        was_active: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        let check = {
            let (active, saved) = (active.clone(), saved.clone());
            move |window: &mut Window, cx: &mut App| {
                let now = window.focused(cx);
                if active.get() || was_active || now == before {
                    return;
                }
                *saved.borrow_mut() = now;
                match &before {
                    Some(f) => window.focus(f, cx),
                    None => window.blur(cx),
                }
            }
        };
        let later = check.clone();
        check(window, cx);
        window.defer(cx, move |window, cx| later(window, cx));
    }

    pub fn toolbar(&self) -> &Entity<ToolbarView> {
        &self.toolbar
    }

    pub fn tree(&self) -> &Entity<TreeView> {
        &self.tree
    }

    pub fn tabs(&self) -> &Entity<TabsView> {
        &self.tabs
    }

    pub fn pickers(&self) -> &Entity<PickersView> {
        &self.pickers
    }

    pub fn popups(&self) -> &Entity<PopupsView> {
        &self.popups
    }

    pub fn floats(&self) -> &Entity<FloatsView> {
        &self.floats
    }

    pub fn statusbar(&self) -> &Entity<StatusbarView> {
        &self.statusbar
    }

    pub fn git(&self) -> &Entity<GitView> {
        &self.git
    }

    pub fn diff(&self) -> &Entity<DiffView> {
        &self.diff
    }

    pub fn annotate(&self) -> &Entity<AnnotateView> {
        &self.annotate
    }

    pub fn minimap(&self) -> &Entity<MinimapView> {
        &self.minimap
    }

    pub fn terminal(&self) -> &Entity<TerminalView> {
        &self.terminal
    }

    /// The bottom pane's host (Sessions, Boxes, Pipelines).
    pub fn pane(&self) -> &Entity<pane::PaneHost> {
        &self.pane
    }

    /// The main area a stripe place covers (Run): the islands' area above a bottom tool
    /// window shown, the Chat column beside it.
    pub fn main_area(&self) -> Bounds<Pixels> {
        let geo = self.geometry.get();
        let inner = geo.layout.frame.inner;
        let bottom = [Role::Pane, Role::Git]
            .into_iter()
            .filter_map(|r| geo.role_rect(r))
            .map(|w| w.island.top() - px(layout::GAP.get()))
            .fold(inner.bottom(), |a, b| if b < a { b } else { a });
        Bounds::new(
            inner.origin,
            size(inner.size.width, (bottom - inner.top()).max(px(0.))),
        )
    }

    /// Its Chat column (the window's state, this workspace's Chat).
    pub fn column(&self) -> &Entity<column::ChatColumn> {
        &self.column
    }

    /// ⌘4 / ⌃⌘← ⌃⌘→ / ⌘⇧D / ⌘§ (the window's keys, before nvim): run once nvim handled the keys
    /// typed before (a ⌘1 it still has moves the keyboard first, as when these were nvim's). On
    /// Code ⌃⌘← ⌃⌘→ are then the tabs of the pane with the keys, but Chat's ([`ColumnKey::Arrow`]).
    ///
    /// [`ColumnKey::Arrow`]: column::ColumnKey::Arrow
    pub fn column_key(
        &mut self,
        key: column::ColumnKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.queue_key(pane_key::Queued::Column(key), window, cx);
    }

    /// `key` runs once nvim handled the keys typed before ([`Self::column_answered`]).
    fn queue_key(&mut self, key: pane_key::Queued, window: &mut Window, cx: &mut Context<Self>) {
        self.column_seq += 1;
        let id = self.column_seq;
        self.column_keys.push_back((id, key));
        self.barrier(id, window, cx);
    }

    /// Barrier `id` asked of nvim (its answer, or its wait running out, runs the keys up to it).
    fn barrier(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.rpc
            .exec_lua_after_input(COLUMN_BARRIER, vec![Value::from(id)]);
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(COLUMN_WAIT).await;
            let _ = this.update_in(cx, |ws, window, cx| ws.column_answered(id, window, cx));
        })
        .detach();
    }

    /// Barrier `id` is back (or its wait ran out): the keys up to it run, in order.
    fn column_answered(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        // hidden meanwhile: the column is the shown workspace's now, its keys dropped
        if !self.active.get() {
            self.column_keys.retain(|(k, _)| *k > id);
            return;
        }
        // a column key run before in this batch gave the column the keys (it may not be drawn yet)
        let mut chat_keys = self.focused_surface(window, cx) == Some(column::CHAT);
        while self.column_keys.front().is_some_and(|(k, _)| *k <= id) {
            let Some((_, queued)) = self.column_keys.pop_front() else {
                break;
            };
            let key = match queued {
                pane_key::Queued::Column(key) => key,
                // a pane key's act goes to nvim: the keys after it wait for what it moved
                pane_key::Queued::Pane(pane) => {
                    self.pane_act(pane, window, cx);
                    if !self.column_keys.is_empty() {
                        self.column_seq += 1;
                        let next = self.column_seq;
                        self.column_keys.iter_mut().for_each(|(k, _)| *k = next);
                        self.barrier(next, window, cx);
                    }
                    return;
                }
            };
            // ⌃⌘← ⌃⌘→ on Code, the keys in another pane (the editor, the tree, the Terminal,
            // Git, a diff): its previous / next tab, as ⌥⌘← ⌥⌘→ (and before 3.5)
            if let Some(dir) = key.tabs()
                && !chat_keys
                && !column::state(cx).factory_shown
            {
                lua::navigate(&self.rpc, "config.focus", "cycle_tabs", vec![dir.into()]);
                continue;
            }
            self.column.update(cx, |c, cx| key.run(c, window, cx));
            chat_keys = match key {
                column::ColumnKey::Tear => false,
                // ⌘4 with the keys hid it
                column::ColumnKey::Chat => column::state(cx).shown(),
                _ => true,
            };
        }
    }

    /// View › Chat Mode / Claude Code: the column in `mode` with the keys, wherever they are
    /// (typed, ⌃⌘← ⌃⌘→ on Code are the tabs of the pane with them).
    pub fn column_mode(&mut self, mode: ColumnMode, window: &mut Window, cx: &mut Context<Self>) {
        self.column_key(column::ColumnKey::Mode(mode), window, cx);
    }

    /// The editor's panels follow the window's column: its width off nvim's screen while docked
    /// and shown.
    pub(in crate::shell) fn sync_column(&mut self, cx: &mut Context<Self>) {
        let chat = column::state(cx).docked_width();
        self.editor.update(cx, |e, cx| {
            let p = e.panels();
            if p.chat != chat {
                e.set_panels(Panels { chat, ..p }, cx);
            }
        });
        cx.notify();
    }

    pub fn markdown(&self) -> &Entity<MarkdownView> {
        &self.markdown
    }

    pub fn replace(&self) -> &Entity<ReplaceView> {
        &self.replace
    }

    pub fn geometry(&self) -> Rc<Geometry> {
        self.geometry.get()
    }

    /// Files dropped from Finder (WebStorm): files open in the last focused split, a folder opens
    /// as a project (the first one; it's shown).
    /// Which are folders is read off the UI thread.
    pub fn drop_external(&mut self, paths: &[std::path::PathBuf], cx: &mut Context<Self>) {
        let paths = paths.to_vec();
        let rpc = self.rpc.clone();
        let classify = cx.background_spawn(async move {
            let (dirs, files): (Vec<_>, Vec<_>) = paths.into_iter().partition(|p| p.is_dir());
            (
                dirs.first().map(|d| crate::shell::recent::real_path(d)),
                files,
            )
        });
        cx.spawn(async move |_, cx| {
            let (dir, files) = classify.await;
            let items: Vec<Value> = files
                .iter()
                .map(|f| {
                    Value::Map(vec![(
                        "path".into(),
                        f.to_string_lossy().into_owned().into(),
                    )])
                })
                .collect();
            if !items.is_empty() {
                lua::navigate(
                    &rpc,
                    "config.app.pickers",
                    "open_files",
                    vec![Value::Array(items)],
                );
            }
            if let Some(dir) = dir {
                // outside any entity update: opening a project updates the projects root
                cx.update(|cx| {
                    if let Err(e) =
                        projects::open_path(projects::OpenRequest { dir, file: None }, cx)
                    {
                        eprintln!("[vimstorm] drop: {e:#}");
                    }
                });
            }
        })
        .detach();
    }

    pub fn rpc(&self) -> &Rpc {
        &self.rpc
    }

    /// The surface with the keyboard (what Lua was told).
    pub fn native_focus(&self) -> Option<&'static str> {
        self.native
    }

    /// The native focus read again: a surface that took the keyboard while it was not yet drawn
    /// heard no focus-in (its host then says so once it is drawn).
    pub fn resync_native_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_native_focus(window, cx);
    }

    /// The focus-in a shown window hears, for a driven offscreen one: it is never the key
    /// window, and GPUI sends focus events to the key window only, so the keyboard moving into a
    /// surface (⌘4's Chat) or back to nvim (Chat hidden) went untold and Lua kept the old focus
    /// (⌘1 then read the tree as focused: nothing). The drive's pace calls this each frame.
    pub fn hear_focus_offscreen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.active.get() {
            return;
        }
        let now = self.focused_surface(window, cx);
        let in_nvim = || {
            self.editor
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        };
        if now != self.native && (now.is_some() || in_nvim()) {
            self.sync_native_focus(window, cx);
        }
    }

    pub fn tree_open(&self, cx: &App) -> bool {
        self.editor.read(cx).panels().tree_open
    }

    /// Shows / hides the tree panel (the tree surface decides; Lua asks it).
    pub fn set_tree_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let p = Panels {
                tree_open: open,
                ..e.panels()
            };
            e.set_panels(p, cx);
        });
        cx.notify();
    }

    /// Gives the keyboard back to nvim (the surface over nvim's current window, if one is: the
    /// keyboard follows nvim's current window).
    pub fn focus_editor(&self, window: &mut Window, cx: &mut App) {
        let handle = self
            .home
            .get()
            .unwrap_or_else(|| self.editor.read(cx).focus_handle(cx));
        window.focus(&handle, cx);
    }

    /// The keyboard to the page shown: the code, where nvim's current window is (a split, or
    /// the bottom panel's tool window) (Esc in Chat).
    pub fn focus_page(&self, window: &mut Window, cx: &mut App) {
        self.focus_editor(window, cx);
    }

    /// The surface whose element has the keyboard now (None: nvim, or nothing).
    pub fn focused_surface(&self, window: &Window, cx: &App) -> Option<&'static str> {
        self.focusables
            .iter()
            .find(|(_, h)| h.contains_focused(window, cx))
            .map(|(name, _)| *name)
    }

    /// Tells Lua (and the editor's caret) which surface has the keyboard, when that changed or
    /// Lua asked for a change. Keys / mouse input for nvim wait until Lua has it
    /// ([`Rpc::hold_input`]): nvim reads typed keys before queued notifications, so a Cmd key
    /// typed right after a click into the tree would otherwise act on the old focus.
    fn sync_native_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = self.focused_surface(window, cx);
        if now == self.native && !self.answer_due {
            return;
        }
        self.answer_due = false;
        // the status bar's mode label says where the keys go
        if now != self.native {
            self.statusbar.update(cx, |_, cx| cx.notify());
        }
        if now != self.native {
            self.sync_maximized(now, window, cx);
            if let Some(tab) = now.and_then(panel::PanelTab::of_surface) {
                self.panel_last = tab;
            }
        }
        self.native = now;
        self.editor
            .update(cx, |e, cx| e.set_native_focus(now.is_some(), cx));
        let seq = self.rpc.hold_input();
        lua::call(
            &self.rpc,
            "config.app",
            "native_focus",
            vec![
                now.map_or(Value::Nil, Value::from),
                Value::from(seq),
                Value::from(self.asked),
            ],
        );
        self.gate_check = Some(Self::check_gate(self.rpc.clone(), seq, cx));
    }

    /// While `seq` is unacked: every [`GATE_CHECK`], release the held input if nvim waits for
    /// input in a blocking prompt (hit-enter, getchar()); while it's busy, keep holding.
    fn check_gate(rpc: Rpc, seq: u64, cx: &mut Context<Self>) -> Task<()> {
        let exec = cx.background_executor().clone();
        cx.background_executor().spawn(async move {
            loop {
                exec.timer(GATE_CHECK).await;
                if !rpc.input_held() {
                    return;
                }
                let blocking = match rpc.request("nvim_get_mode", vec![]).await {
                    Ok(mode) => mode.as_map().is_some_and(|m| {
                        m.iter().any(|(k, v)| {
                            k.as_str() == Some("blocking") && v.as_bool() == Some(true)
                        })
                    }),
                    Err(_) => true, // nvim gone: nothing to wait for
                };
                if blocking {
                    rpc.release_input(seq);
                    return;
                }
            }
        })
    }

    /// Lua asked for a focus change (number `asked`): answer it once its effects are drawn (also
    /// when nothing changed, so Lua's assumption is corrected).
    fn focus_asked(&mut self, asked: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.asked = self.asked.max(asked);
        self.answer_due = true;
        let this = cx.entity().downgrade();
        window.on_next_frame(move |window, cx| {
            let _ = this.update(cx, |ws, cx| {
                if ws.answer_due && ws.active.get() {
                    ws.sync_native_focus(window, cx);
                }
            });
        });
    }

    /// The workspace's own bridge messages (`vimstorm.layout`, `vimstorm.focus`).
    fn on_lua(
        &mut self,
        surface: &str,
        payload: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match surface {
            // nvim's normal-mode Esc had nothing to do: a maximized split restores
            "maximize" => self.esc_idle(window, cx),
            // local echo's barrier back (editor.rs `ECHO_BARRIER`)
            "echo" => {
                if let Some(id) = payload.as_u64() {
                    self.editor.update(cx, |e, cx| e.echo_answered(id, cx));
                }
            }
            // a key of yours for a pane key's action (config/keys.lua): as the key
            "pane_key" => {
                if let Some(pane) = payload.as_str().and_then(PaneKey::named) {
                    let this = cx.entity().downgrade();
                    window.defer(cx, move |window, cx| {
                        let _ = this.update(cx, |ws, cx| ws.pane_key(pane, window, cx));
                    });
                }
            }
            // a Chat column key's barrier (after the focus changes nvim sent before it)
            "column_key" => {
                if let Some(id) = payload.as_u64() {
                    let this = cx.entity().downgrade();
                    window.defer(cx, move |window, cx| {
                        let _ = this.update(cx, |ws, cx| ws.column_answered(id, window, cx));
                    });
                }
            }
            "layout" => {
                let Some(LayoutEvent::Windows { wins }) = lua::decode("layout", payload) else {
                    return;
                };
                let kinds = wins
                    .into_iter()
                    .map(|w| {
                        let kind = match w.kind.as_str() {
                            "split" => WinKind::Split,
                            "viewer" => WinKind::Viewer,
                            "tool" => WinKind::Tool,
                            _ => WinKind::Other,
                        };
                        let role = w.role.as_deref().and_then(Role::parse);
                        (
                            w.win,
                            WinInfo {
                                kind,
                                empty: w.empty,
                                role,
                                sync: w.sync,
                                viewer: w.viewer,
                                textoff: w.textoff,
                                crumbs: w.crumbs,
                            },
                        )
                    })
                    .collect();
                self.editor.update(cx, |e, cx| e.set_windows(kinds, cx));
                cx.notify();
            }
            // the other carets of several (config/app/carets.lua): drawn like the caret
            "carets" => {
                #[derive(serde::Deserialize)]
                struct Carets {
                    win: i64,
                    #[serde(default)]
                    cells: Vec<(usize, usize)>,
                }
                if let Some(c) = lua::decode::<Carets>("carets", payload) {
                    self.editor
                        .update(cx, |e, cx| e.set_carets(c.win, c.cells, cx));
                }
            }
            "sync" => {
                if let Some(SyncEvent::Synced { tops }) = lua::decode("sync", payload) {
                    let tops: Vec<(i64, i64)> = tops.iter().map(|t| (t.win, t.top)).collect();
                    self.editor.update(cx, |e, cx| e.sync_marked(&tops, cx));
                }
            }
            "focus" => match lua::decode("focus", payload) {
                Some(FocusEvent::Editor { asked }) => {
                    self.focus_editor(window, cx);
                    self.focus_asked(asked, window, cx);
                }
                Some(FocusEvent::Expect { asked }) => self.focus_asked(asked, window, cx),
                Some(FocusEvent::Surface { name, asked }) => {
                    self.focus_asked(asked, window, cx);
                    // the surface opens itself if needed (the tree's panel) and takes the keyboard
                    if let Some(deliver) = self.routes.get(name.as_str()).cloned() {
                        let payload = Value::Map(vec![("event".into(), "focus".into())]);
                        let (active, saved) = (self.active.clone(), self.saved_focus.clone());
                        window.defer(cx, move |window, cx| {
                            let (before, was) = (window.focused(cx), active.get());
                            deliver(payload, window, cx);
                            Self::keep_shown_focus(&active, &saved, before, was, window, cx);
                        });
                    }
                }
                None => {}
            },
            _ => lua::log_once(surface, &payload, "no such surface"),
        }
    }

    // Input --------------------------------------------------------------------------------------

    /// Keys reach here after the focused surface's listeners (bubble). nvim's keys while it has
    /// the keyboard; while a surface has it, the global shortcuts it let through
    /// (`input::forward_from_surface`). Other keys a surface didn't handle are swallowed: Cmd
    /// keys stopped (an editor action like Cmd+Z / Cmd+Alt+Z must not reach the hidden buffer,
    /// nor AppKit's menu, which would replay it), the rest not stopped, so a text field's IME
    /// still gets its text.
    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(surface) = self.focused_surface(window, cx) {
            // typing in a tool window's field (tree search, commit message, Log filter): Ctrl
            // keys edit the text there, as in any field
            let typing = match surface {
                TreeView::NAME => self.tree.read(cx).search_input(),
                GitView::NAME => self.git.read(cx).typing(window, cx),
                _ => false,
            };
            let surface = if typing { "field" } else { surface };
            if crate::editor::input::forward_from_surface(surface, &ev.keystroke, cx) {
                self.editor.update(cx, |e, cx| e.on_key_down(ev, cx));
                cx.stop_propagation();
            } else if ev.keystroke.modifiers.platform {
                cx.stop_propagation();
            }
            return;
        }
        if self.editor.update(cx, |e, cx| e.on_key_down(ev, cx)) {
            cx.stop_propagation();
        }
    }

    fn on_modifiers_changed(
        &mut self,
        ev: &ModifiersChangedEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editor
            .update(cx, |e, cx| e.on_modifiers_changed(ev.modifiers, cx));
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let geo = self.geometry.get();
        if ev.button == MouseButton::Left && geo.layout.frame.toolbar.contains(&ev.position) {
            // the toolbar's empty area moves the window (its widgets stop the event)
            if ev.click_count == 2 {
                window.titlebar_double_click();
            } else {
                window.start_window_move();
            }
            return;
        }
        if let Some(gap) = geo.gap_at(ev.position)
            && matches!(gap.kind, layout::GapKind::Tree | layout::GapKind::Chat)
        {
            if ev.button == MouseButton::Left {
                let chat = gap.kind == layout::GapKind::Chat;
                self.drag = Some(TreeDrag {
                    start_x: ev.position.x,
                    // the width on screen: a narrow window shows less than the dragged
                    // width kept in the state
                    start_width: if chat {
                        geo.layout
                            .frame
                            .chat
                            .map_or(column::state(cx).width, |c| c.size.width.as_f32())
                    } else {
                        self.editor.read(cx).panels().tree_width
                    },
                    chat,
                });
            }
            return;
        }
        self.editor
            .update(cx, |e, cx| e.on_mouse_down(ev, window, cx));
    }

    /// A press on a gap's hit zone (capture: before the surfaces) is a drag, whoever draws there:
    /// the zone reaches [`layout::GRAB`] px into the islands beside it, where the bottom pane's
    /// header, the Git tool window or the tree would take the press for their own. Not while
    /// a picker is open: it is drawn over the islands and closes on a press outside it. Not a
    /// viewer's divider: its chrome takes the press first (» arrows) and lets a drag through.
    fn on_capture_mouse_down(
        &mut self,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ev.button != MouseButton::Left || self.pickers.read(cx).is_open() {
            return;
        }
        let geo = self.geometry.get();
        if geo.layout.frame.toolbar.contains(&ev.position)
            || geo
                .gap_at(ev.position)
                .is_none_or(|g| matches!(g.kind, layout::GapKind::Divider { .. }))
        {
            return;
        }
        cx.stop_propagation();
        self.on_mouse_down(ev, window, cx);
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(drag) = self.drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                // (released outside the window: no mouse up came, the width is kept here)
                self.drag = None;
                if drag.chat && self.managed {
                    column::save_width(column::state(cx).width, projects::state_home(cx), cx);
                }
                return;
            }
            let frame = self.geometry.get().layout.frame;
            let inner = frame.inner.size.width.as_f32();
            if drag.chat {
                let shown = frame
                    .chat
                    .map_or(0., |c| c.size.width.as_f32() + layout::GAP);
                let want = drag.start_width - (ev.position.x - drag.start_x).as_f32();
                let width = Frame::chat_width_for(want, inner + shown);
                column::set_state(cx, |s| s.width = width);
                return;
            }
            let want = drag.start_width + (ev.position.x - drag.start_x).as_f32();
            let width = Frame::tree_width_for(want, inner);
            self.editor.update(cx, |e, cx| {
                let p = Panels {
                    tree_width: width,
                    ..e.panels()
                };
                e.set_panels(p, cx);
            });
            cx.notify();
            return;
        }
        self.editor.update(cx, |e, cx| {
            if !e.on_drag(ev, cx) {
                e.on_hover(ev, cx);
            }
        });
    }

    fn on_mouse_up(&mut self, ev: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(drag) = self.drag.take() {
            // the column's width for the next launch
            if drag.chat && self.managed {
                let width = column::state(cx).width;
                column::save_width(width, projects::state_home(cx), cx);
            }
            return;
        }
        self.editor.update(cx, |e, cx| e.on_mouse_up(ev, cx));
    }

    fn on_scroll(&mut self, ev: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| e.on_scroll(ev, cx));
    }
}

/// An absolutely placed slot at window coordinates.
fn slot(b: gpui_kit::Bounds<Pixels>) -> gpui_kit::Div {
    div()
        .absolute()
        .left(b.origin.x)
        .top(b.origin.y)
        .w(b.size.width)
        .h(b.size.height)
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        self.editor.update(cx, |e, _| {
            e.set_workspace_strip(self.managed);
            e.set_viewport(viewport);
        });
        // Feel vscode's Activity bar: its column at the left
        let activity = crate::factory::vscode(cx);
        self.editor.update(cx, |e, cx| {
            if e.panels().activity != activity {
                let p = Panels {
                    activity,
                    ..e.panels()
                };
                e.set_panels(p, cx);
            }
        });
        // the rail: its column at the left edge, maximized too (the projects window draws it).
        // A projects window's workspace only
        let rail = self.managed;
        self.editor.update(cx, |e, cx| {
            if e.panels().rail != rail {
                let p = Panels { rail, ..e.panels() };
                e.set_panels(p, cx);
            }
        });
        let geo = self.geometry.get();
        let frame = geo.layout.frame;
        let mut root = div()
            .id("workspace")
            .relative()
            .size_full()
            .bg(FRAME_BG)
            // every key press, whoever takes it, breaks a Shift Shift (typed capitals in a field)
            .capture_key_down(cx.listener(|ws, _: &KeyDownEvent, _, cx| {
                ws.editor.update(cx, |e, _| e.interrupt_shift());
            }))
            // a bare workspace's own Chat column keys (a projects window takes them first)
            .when(!self.managed, |d| {
                d.capture_key_down(cx.listener(|ws, ev: &KeyDownEvent, window, cx| {
                    if ws.maximize_key(ev, window, cx) {
                        cx.stop_propagation();
                        return;
                    }
                    // the pane keys ⌘1 ⌘3 ⌘4 ⌘T ⌃`, the column's, ⌘J the panel shown / hidden
                    // (a projects window takes them first)
                    let k = &ev.keystroke;
                    if let Some(pane) = PaneKey::of(k, cx) {
                        cx.stop_propagation();
                        ws.pane_key(pane, window, cx);
                        return;
                    }
                    if let Some(key) = column::ColumnKey::of(k, cx) {
                        cx.stop_propagation();
                        ws.column_key(key, window, cx);
                        return;
                    }
                    if crate::editor::input::window_cmd(k, cx) && !k.modifiers.shift && k.key == "j"
                    {
                        ws.panel_toggle(window, cx);
                        cx.stop_propagation();
                    }
                }))
            })
            .on_key_down(cx.listener(Self::on_key_down))
            .on_modifiers_changed(cx.listener(Self::on_modifiers_changed))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            // Finder drops (the tree's rows take theirs first: a copy into that folder)
            .on_drop(
                cx.listener(|ws, paths: &ExternalPaths, _, cx| ws.drop_external(paths.paths(), cx)),
            );
        root = root.capture_any_mouse_down(cx.listener(Self::on_capture_mouse_down));
        for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
            root = root
                .on_mouse_down(button, cx.listener(Self::on_mouse_down))
                .on_mouse_up(button, cx.listener(Self::on_mouse_up))
                .on_mouse_up_out(button, cx.listener(Self::on_mouse_up));
        }
        // full-window layer for surfaces that place themselves
        let layer = || div().absolute().top_0().left_0().size_full();
        root = root
            .child(self.editor.clone())
            .child(slot(frame.toolbar).child(self.toolbar.clone()))
            .child(slot(frame.status).child(self.statusbar.clone()));
        // the Git tool window over its host window's island
        let git_open = self.git.read(cx).is_open();
        if let Some(el) = hosted_in(&geo, Role::Git, git_open, &self.git, island, window, cx) {
            root = root.child(el);
        }
        // the Terminal over its host window's island in the bottom pane (unseen while its float
        // is up or it has the keyboard but isn't laid out)
        let term_open = self.terminal.read(cx).is_open();
        if let Some(el) = hosted_in(
            &geo,
            Role::Terminal,
            term_open,
            &self.terminal,
            island,
            window,
            cx,
        ) {
            root = root.child(el);
        }
        // the Chat column; the Factory view shown with its column: the column is drawn there,
        // beside the Board, not under it
        let col = column::state(cx);
        let lent = col.factory_shown && col.factory_docked_width().is_some();
        if let Some(chat) = frame.chat.filter(|_| !lent) {
            root = root.child(island(chat).child(self.column.clone()));
        }
        // the bottom pane over its host window (it draws its own island)
        let pane_open = self.pane.read(cx).is_open();
        if let Some(el) = hosted_in(&geo, Role::Pane, pane_open, &self.pane, slot, window, cx) {
            root = root.child(el);
        }
        if let Some(tree) = geo.layout.tree {
            root = root.child(island(tree).child(self.tree.clone()));
        }
        if let Some(bar) = frame.activity.filter(|_| geo.layout.maximized.is_none()) {
            let (tree_open, git_open) = (geo.layout.tree.is_some(), git_open);
            let rpc = self.rpc.clone();
            root = root.child(activity::render(
                bar,
                move |item| match item {
                    activity::Item::Explorer => tree_open,
                    activity::Item::Search => false,
                    activity::Item::SourceControl => git_open,
                },
                move |item, _| {
                    lua::call(
                        &rpc,
                        "config.keymap_vscode",
                        "activity",
                        vec![Value::from(item.slug())],
                    )
                },
            ));
        }
        root = root
            .child(layer().child(self.tabs.clone()))
            .child(layer().child(self.minimap.clone()))
            .child(layer().child(self.markdown.clone()))
            .child(layer().child(self.annotate.clone()))
            .child(layer().child(self.diff.clone()))
            .child(layer().child(self.replace.clone()));
        // a cloud workspace waking, connecting or failed: RemoteState in the editor slot
        if let Some(link) = self.remote.as_ref().filter(|l| !l.attached()) {
            let area = if geo.layout.editor.size.width > px(0.) {
                geo.layout.editor
            } else {
                frame.inner
            };
            let retry = cx.listener(|ws, _: &gpui_kit::ClickEvent, _, cx| ws.remote_retry(cx));
            let download =
                cx.listener(|ws, _: &gpui_kit::ClickEvent, _, cx| ws.remote_download(cx));
            root = root.child(remote::remote_state(
                link,
                area,
                std::time::Instant::now(),
                Box::new(retry),
                Box::new(download),
            ));
            if link.failed() {
                // ⏎ and ⌘⏎ in the editor slot (not in the tree, a terminal or a popup)
                root = root.capture_key_down(cx.listener(|ws, e: &KeyDownEvent, window, cx| {
                    if !ws.editor.focus_handle(cx).is_focused(window) {
                        return;
                    }
                    let k = &e.keystroke;
                    if k.key != "enter" || !ws.remote.as_ref().is_some_and(|l| l.failed()) {
                        return;
                    }
                    cx.stop_propagation();
                    if k.modifiers.platform {
                        ws.remote_download(cx);
                    } else {
                        ws.remote_retry(cx);
                    }
                }));
            }
        }
        // a maximized island's label
        if let Some(label) = self.maximized_label() {
            root = root.child(label);
        }
        // nvim's message grid spans the islands' width: above the tree / tool windows it reaches
        // under (as in nvim, where it's on top of every window)
        root.child(layer().child(crate::render::GridElement::messages(self.editor.clone())))
            .child(layer().child(self.floats.clone()))
            // Managed windows mount native popups above shared workspace navigation/Board.
            .when(!self.managed, |root| {
                root.child(layer().child(self.popups.clone()))
                    .child(layer().child(self.pickers.clone()))
            })
    }
}

/// A tool-window island (panel bg, outline, rounded) at window coordinates.
fn island(b: Bounds<Pixels>) -> gpui_kit::Div {
    slot(b)
        .rounded(px(ISLAND_RADIUS.get()))
        .bg(TOOL_BG)
        .border(px(layout::ISLAND_BORDER))
        .border_color(crate::look::ISLAND_BORDER)
        .overflow_hidden()
}

/// A surface hosted over a `role` window (Git, the pane), in `place`'s slot over its host's island
/// (an island, or a plain slot for a surface drawing its own); while open / focused but its host
/// window isn't laid out yet (the layout comes a moment later), kept in the tree unseen, so its
/// keyboard focus is real and keys aren't lost; else not mounted.
fn hosted_in<V: Render + Focusable>(
    geo: &Geometry,
    role: Role,
    open: bool,
    view: &Entity<V>,
    place: impl Fn(Bounds<Pixels>) -> gpui_kit::Div,
    window: &Window,
    cx: &App,
) -> Option<gpui_kit::Div> {
    if let Some(host) = geo.role_rect(role) {
        return Some(place(host.island).child(view.clone()));
    }
    (open || view.focus_handle(cx).contains_focused(window, cx)).then(|| {
        div()
            .absolute()
            .size_0()
            .overflow_hidden()
            .child(view.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawn_cells_move_with_the_offset_kept_rows_too() {
        let d = DrawnGrid {
            grid: 2,
            win: 1000,
            origin: point(px(10.), px(100.)),
            offset: px(7.),
            text_rows: 1..20,
            text_clip: Bounds::default(),
            drawn_rows: -1..20,
            topline: None,
            held: false,
            cells: (80, 20),
            metrics: CellMetrics {
                font_size: px(13.),
                cell_width: px(8.),
                row_height: px(20.),
                ..Default::default()
            },
        };
        assert_eq!(d.cell_origin(3, 2), point(px(26.), px(167.)));
        // kept rows above the text area (here over the winbar row 0) are drawn with the offset
        assert_eq!(d.cell_origin(-1, 0).y, px(87.));
        assert_eq!(d.cell_origin(0, 0).y, px(107.));
        // no kept rows: the winbar stays put
        let d = DrawnGrid {
            drawn_rows: 1..20,
            ..d
        };
        assert_eq!(d.cell_origin(0, 0).y, px(100.));
    }
}
