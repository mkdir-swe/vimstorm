//! The editor: nvim's grids drawn in their islands, and nvim's input.
//!
//! [`EditorView`] owns the nvim process, the UI state built from redraw batches (applied on the UI
//! thread per `flush` by the workspace's event pump, [`EditorView::apply`]), the pixel layout of
//! nvim's windows ([`crate::shell`]; re-done after every batch and when the window or
//! the panels change, [`EditorView::relayout`]) and the input state (keys, IME, mouse, scrolling).
//! Nothing here waits on nvim: every call is a notification.
//!
//! Sync groups (diff / merge panes, [`crate::nvim`]): a flush that moves one pane before its
//! partners keeps drawing that pane's previous picture until Lua's "synced" marker / the
//! partner's flush lines them up (or [`HOLD_SYNC`]); wheel / trackpad steps over a pane go to
//! `git/scrollsync.lua` `scroll` (all panes in one nvim call) and partners that moved with the
//! smooth-scrolled pane get its sub-row offset. Windows a native surface covers (`role`, the Git
//! tool window's host) get no grid place. Each frame publishes what it drew of every window grid
//! ([`DrawnGrids`]) for overlays.
//!
//! The workspace (window root) owns the event listeners and calls the `on_*` methods here while
//! nvim has the keyboard / is under the pointer; keys etc. go through [`crate::editor::input`] and reach
//! nvim through [`forward`].
//!
//! A cloud workspace's Neovim ([`Nvim::remote`]) echoes typed text locally
//! ([`crate::nvim`]): what [`EditorView::send`] sends is classified (a char or Backspace
//! drawn ahead of nvim, anything else drops the echo and sends a barrier after it, `vimstorm.echo`
//! back), every flush reconciles, and the grid element draws echo's grid and caret
//! ([`GridHost::held_grid`], [`GridHost::cursor`]). `VIMSTORM_LOCAL_ECHO=0` turns it off.

/// LSP floats: completion, hover, signature help, diagnostics, peek.
pub mod floats;
/// GPUI key/mouse events -> nvim input notation; native double-Shift, IME.
pub mod input;
/// Markdown preview over its windows' islands.
pub mod markdown;
/// VS Code's minimap at each code split's right (`editor.minimap`).
pub mod minimap;
/// The ⌘R replace bar over the file's split (Lua keeps the engine: config/replace.lua).
pub mod replace;
/// Status bar.
pub mod statusbar;
/// Editor tab bars + empty editor hints.
pub mod tabs;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyDownEvent, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Point, Render, ScrollDelta, ScrollWheelEvent, Size, Styled, Task,
    Window, div, point, px,
};

use crate::app;
use crate::editor::input::{
    Action, Ime, ImeHandler, Keys, MouseAction, MoveGuard, MoveStep, ScrollAccumulator, Sink,
    SmoothScroll, WheelSteps,
};
use crate::nvim::{self, CONFIRM_WITHIN, Echo, Echoed, Shown, Spot};
use crate::nvim::{CellText, CursorPos, Grid, Placement};
use crate::nvim::{GridId, Nvim, RedrawEvent, Rpc, UiState};
use crate::nvim::{HOLD_SYNC, Presented, SyncState};
use crate::render::editor_font_size;
use crate::render::{CellMetrics, GridElement, GridHost};
use crate::shell::{
    self, Frame, Geometry, GridPlace, Island, NvimWin, Panels, PlaceKind, Role, SyncGroup, WinKind,
};
use crate::shell::{DrawnGrid, DrawnGrids, GeometryHandle};

/// No scroll event for this long: the trackpad gesture and its momentum are over.
const SETTLE_AFTER: Duration = Duration::from_millis(120);
/// Settle animation frame.
const SETTLE_FRAME: Duration = Duration::from_millis(8);
/// A message (the command line's text after a command, an error) shows this long.
const MESSAGE_SHOWN: Duration = Duration::from_secs(4);
/// A layout change waits this long at most for nvim's resized grids before it's drawn anyway.
const HOLD_MAX: Duration = Duration::from_millis(60);
/// Grid sizes for a Lua window report wait this long for nvim's flush at most (see
/// `EditorView::resize_deferred`).
const DEFER_MAX: Duration = Duration::from_millis(8);
/// A held mouse move asks nvim again this often while a key sequence is pending.
const MOVE_RETRY: Duration = Duration::from_millis(100);
/// Local echo's barrier ([`crate::nvim`]): nvim runs it once it read the keys before it, and
/// says so on the `echo` bridge (`vimstorm.echo`, its id), its screen flushed first (the redraw
/// for those keys comes before the answer). To the app's UI channel (`config.app.bridge`), else
/// to every channel.
const ECHO_BARRIER: &str = "pcall(vim.api.nvim__redraw, { flush = true }) \
    local ok, bridge = pcall(require, 'config.app.bridge') \
    vim.rpcnotify(ok and bridge.channel() or 0, 'vimstorm.echo', ...)";

/// Whether a cloud workspace's editor echoes typed text locally (`VIMSTORM_LOCAL_ECHO=0`: no).
fn local_echo_wanted() -> bool {
    std::env::var("VIMSTORM_LOCAL_ECHO").map_or(true, |v| v != "0")
}

/// The keys of an `nvim_input` echo can predict: text (`<lt>` is `<`) or one `<BS>`. None: any
/// other key.
fn echo_keys(keys: &str) -> Option<Vec<nvim::Key>> {
    match keys {
        "<BS>" => return Some(vec![nvim::Key::Backspace]),
        // the space bar (`input/keys.rs` names it)
        "<Space>" => return Some(vec![nvim::Key::Char(' ')]),
        _ => {}
    }
    let mut out = Vec::new();
    let mut rest = keys;
    while let Some(c) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix("<lt>") {
            out.push(nvim::Key::Char('<'));
            rest = after;
        } else if c == '<' {
            return None;
        } else {
            out.push(nvim::Key::Char(c));
            rest = &rest[c.len_utf8()..];
        }
    }
    (!out.is_empty()).then_some(out)
}

/// What [`EditorView::send`] did to the local echo.
#[derive(Clone, Copy, Debug, Default)]
struct Echoing {
    /// What's drawn changed.
    changed: bool,
    /// A key was drawn ahead of nvim: it expires if nvim doesn't draw it.
    predicted: bool,
}

/// Sends one input action to nvim (the RPC each maps to: [`crate::editor::input`]'s module doc).
pub fn forward(rpc: &Rpc, action: Action) {
    match action {
        Action::Input(keys) => rpc.input(&keys),
        Action::Lua { code, args } => rpc.exec_lua(code, args),
        Action::Mouse {
            button,
            action,
            modifier,
            grid,
            row,
            col,
        } => rpc.input_mouse(button, action, &modifier, grid, row as usize, col as usize),
    }
}

/// What a held mouse button went down on.
#[derive(Clone, Copy, Debug)]
enum PressOn {
    /// A grid: drags / release go to it, cells relative to its origin then.
    Grid { grid: GridId, origin: Point<Pixels> },
    /// A gap between nvim windows: nvim's separator on grid 1, dragged along one axis.
    Separator {
        vertical: bool,
        row: usize,
        col: usize,
        axis: shell::Axis,
        /// The pressed cell along the axis minus the separator's: the separator follows the
        /// pointer by as many cells as it moved, wherever in the gap's hit zone it was grabbed.
        grab: i64,
    },
}

#[derive(Clone, Copy, Debug)]
struct Press {
    button: MouseButton,
    on: PressOn,
}

/// What `config/app/layout.lua` says about a window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WinInfo {
    pub kind: WinKind,
    pub empty: bool,
    /// A native surface is drawn over it (its grid isn't).
    pub role: Option<Role>,
    /// Presented together with the other windows of this group ([`crate::nvim`]).
    pub sync: Option<SyncGroup>,
    /// A diff / merge pane ([`crate::git::diff`] draws its chrome).
    pub viewer: Option<shell::ViewerPane>,
    /// A code split with the WebStorm gutter: its first text column (nvim's `textoff`), drawn
    /// trimmed ([`shell::GridPlace::trim_col`]).
    pub textoff: Option<u16>,
    /// Feel vscode's breadcrumbs strip under its tab bar ([`shell::NvimWin::crumbs`]).
    pub crumbs: bool,
}

/// `VIMSTORM_TIMING` startup milestones logged once each.
#[derive(Default)]
struct StartupMarks {
    first_painted: bool,
    /// A flush showed the editor (see [`EditorView::shows_editor`]).
    content_flushed: bool,
    content_painted: bool,
}

pub struct EditorView {
    nvim: Nvim,
    ui: UiState,
    metrics: CellMetrics,
    focus: FocusHandle,
    /// Screen size last sent to nvim (cols, rows).
    size: (usize, usize),
    viewport: Size<Pixels>,
    workspace_strip: bool,
    panels: Panels,
    /// The island ⌥⌘⏎ gave the body ([`shell::Layout::maximize`]).
    maximized: Option<Island>,
    /// The density the geometry was laid out in (`theme::density::is_default`): a look switching
    /// it moves the toolbar and the status bar.
    roomy: bool,
    /// Window kinds from Lua, by window handle.
    kinds: HashMap<i64, WinInfo>,
    /// Grid sizes requested with `nvim_ui_try_resize_grid` (text area).
    requested: HashMap<GridId, (usize, usize)>,
    /// Lua's window report arrives mid-way through nvim's work (WinNew / WinClosed, a module's
    /// sync), ahead of the flush that ends it: a window it lists may close before that flush, and
    /// a resize reaching nvim after the close is an "Invalid window handle" error. So grid sizes
    /// go out with the next flush (nvim's state then matches ours), or after [`DEFER_MAX`] when
    /// the report needed no redraw.
    resize_deferred: bool,
    geometry: Rc<Geometry>,
    shared: GeometryHandle,
    /// What the last frame drew of each window grid (overlays read it in their paint).
    drawn: DrawnGrids,
    /// Sync groups: grids presented together, held pictures.
    sync: SyncState,
    /// Partners of the smooth-scrolled grid that moved with it in the last batch it moved in:
    /// drawn with its sub-row offset too.
    follows: HashSet<GridId>,
    /// A layout change waits for nvim's resized grids (no half-built frame): since when.
    hold: Option<Instant>,
    /// A native surface has the keyboard: no caret in the editor.
    native_focus: bool,
    /// The other carets of several (multi-cursor, `config/app/carets.lua`): their window handle and
    /// cells (row, col) in its grid, drawn like the caret.
    carets: Option<(i64, Vec<(usize, usize)>)>,
    /// Message grid text, when it changed, whether it's still shown.
    message: Option<(String, Instant, bool)>,
    window_active: bool,
    /// Its project is the one shown (several open projects share the window; see
    /// [`crate::shell::projects`]): FocusGained / the window title only then.
    project_active: bool,
    /// What nvim was last told about focus (`nvim_ui_set_focus`): window active and project shown.
    ui_focused: bool,
    keys: Keys,
    ime: Rc<RefCell<Ime>>,
    /// IME output -> nvim (registered with `window.handle_input` every frame).
    sink: Sink,
    press: Option<Press>,
    /// Last drag cell sent.
    last_drag: Option<(i64, i64)>,
    /// Last hover cell sent as `<MouseMove>`.
    last_move: Option<(GridId, usize, usize)>,
    /// Holds hover moves while a key sequence is pending (`,v`, `ciw`).
    moves: MoveGuard,
    /// Mouse-wheel lines, horizontal and non-window scrolling: whole steps.
    wheel: ScrollAccumulator,
    /// Trackpad scrolling of the window grid under the pointer.
    smooth: SmoothScroll,
    /// Where the last smooth scroll event went (grid, row, col): the settle step goes there too.
    smooth_at: (GridId, usize, usize),
    settle: Option<Task<()>>,
    /// When the last smooth scroll event came (GPUI's clock).
    last_scroll: Instant,
    title: String,
    startup: StartupMarks,
    latency: app::Latency,
    /// Local echo (a cloud workspace's editor; off for a local one).
    echo: Echo,
    /// What echo draws in place of nvim's cursor grid (refreshed when echo or nvim's grid change).
    echo_shown: Option<Shown>,
    /// blink.cmp's completion menu is open (the floats surface says so): no echo.
    completion_menu: bool,
    /// The Feel's `editor.minimap`: code splits leave its room at their right.
    minimap: bool,
    _subs: Vec<gpui_kit::Subscription>,
}

/// Attaches the first project's UI right after spawning it, before GPUI runs, at the screen size
/// its window will give it (`viewport`: the window's content size; nominal cell metrics at the
/// default font size): nvim sources the config only once a UI attached, so this overlaps nvim's
/// startup with GPUI's and the window's (~80 ms). [`EditorView::new`] then skips the attach (its
/// relayout resizes when the window came out another size).
pub fn attach_early(nvim: &mut Nvim, viewport: Size<Pixels>) {
    let metrics = CellMetrics::nominal(crate::render::FONT_SIZE);
    let size = Frame::new(viewport, Panels::default()).screen_size(&metrics);
    nvim.attach(size.0, size.1);
    app::mark("UI attached");
}

/// Is the app window active (key)? Offscreen shots (`--features shots`, `VIMSTORM_SHOT`) count as
/// active: their window is never shown, and nvim / the surfaces would otherwise draw (and act) as
/// in the background (hovers closed on FocusLost, gray selections).
pub fn window_active(window: &Window) -> bool {
    window.is_window_active()
        || (cfg!(feature = "shots") && std::env::var_os("VIMSTORM_SHOT").is_some())
}

impl EditorView {
    /// Attaches the UI at the screen size the window gives nvim (unless startup did:
    /// [`attach_early`]). Redraw batches come in through [`EditorView::apply`].
    pub fn new(
        mut nvim: Nvim,
        shared: GeometryHandle,
        drawn: DrawnGrids,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        app::mark("window opened");
        let metrics = CellMetrics::measure(window, editor_font_size(cx));
        let viewport = window.viewport_size();
        let panels = Panels::default();
        // attached already at startup ([`attach_early`]): the relayout below resizes if the
        // window came out another size
        let screen = Frame::new(viewport, panels).screen_size(&metrics);
        let size = match nvim.attached() {
            Some(early) => {
                if early != screen {
                    app::mark("window size differs from the early attach");
                }
                early
            }
            None => {
                nvim.attach(screen.0, screen.1);
                app::mark("UI attached");
                screen
            }
        };

        let focus = cx.focus_handle();
        window.focus(&focus, cx);

        let activation = cx.observe_window_activation(window, |v, window, _| {
            let active = window_active(window);
            if active != v.window_active {
                v.window_active = active;
                v.sync_ui_focus();
                if !active {
                    v.focus_lost();
                }
            }
        });
        let blur = cx.on_blur(&focus, window, |v, _, cx| {
            v.focus_lost();
            cx.notify();
        });

        // Closing the window saves all and quits nvim (session saved on VimLeavePre; no swap files
        // left); the app quits when nvim exits. The wait (kill after 1 s) runs off the UI thread.
        let quitter = nvim.quitter();
        window.on_window_should_close(cx, move |_, _| {
            let q = quitter.clone();
            std::thread::spawn(move || q.quit(crate::nvim::QUIT_TIMEOUT));
            false
        });

        let weak = cx.entity().downgrade();
        let sink: Sink = Rc::new(move |actions, _, cx| {
            let _ = weak.update(cx, |v, cx| {
                v.input_happened(cx);
                if !actions.is_empty() {
                    v.latency.sent();
                }
                v.send_now(actions, cx);
            });
        });

        // the Feel's minimap: the splits' grids narrow or widen as it turns on / off
        let feel = cx.observe_global::<crate::factory::Feel>(|v: &mut Self, cx| {
            let on = crate::editor::minimap::wanted(cx);
            if on != v.minimap {
                v.minimap = on;
                if v.relayout() {
                    v.hold(cx);
                }
                cx.notify();
            }
        });

        let echo = Echo::new(nvim.remote() && local_echo_wanted());
        let mut view = EditorView {
            nvim,
            ui: UiState::new(),
            metrics,
            focus,
            size,
            viewport,
            workspace_strip: false,
            panels,
            maximized: None,
            roomy: crate::look::density::is_default(),
            kinds: HashMap::new(),
            requested: HashMap::new(),
            resize_deferred: false,
            geometry: Rc::default(),
            shared,
            drawn,
            sync: SyncState::new(),
            follows: HashSet::new(),
            hold: None,
            native_focus: false,
            carets: None,
            message: None,
            window_active: window_active(window),
            project_active: true,
            ui_focused: window_active(window),
            keys: Keys::new(),
            ime: Rc::new(RefCell::new(Ime::new())),
            sink,
            press: None,
            last_drag: None,
            last_move: None,
            moves: MoveGuard::default(),
            wheel: ScrollAccumulator::new(),
            smooth: SmoothScroll::new(),
            smooth_at: (1, 0, 0),
            settle: None,
            last_scroll: cx.background_executor().now(),
            title: String::new(),
            startup: StartupMarks::default(),
            latency: app::Latency::default(),
            echo,
            echo_shown: None,
            completion_menu: false,
            minimap: crate::editor::minimap::wanted(cx),
            _subs: vec![activation, blur, feel],
        };
        view.relayout();
        crate::devtools::schedule_bench(window, cx);
        #[cfg(feature = "shots")]
        crate::devtools::schedule_shot(window, cx);
        view
    }

    pub fn rpc(&self) -> &Rpc {
        &self.nvim.rpc
    }

    /// The nvim process (tests kill it when done).
    pub fn nvim_mut(&mut self) -> &mut Nvim {
        &mut self.nvim
    }

    pub fn ui(&self) -> &UiState {
        &self.ui
    }

    pub fn metrics(&self) -> CellMetrics {
        self.metrics
    }

    /// The current geometry snapshot.
    pub fn geometry(&self) -> &Rc<Geometry> {
        &self.geometry
    }

    pub fn panels(&self) -> Panels {
        self.panels
    }

    /// Lua's window kinds by window handle.
    pub fn kinds(&self) -> &HashMap<i64, WinInfo> {
        &self.kinds
    }

    /// Key latency probes (`VIMSTORM_TIMING`; [`crate::devtools`] reads them).
    pub fn latency(&mut self) -> &mut app::Latency {
        &mut self.latency
    }

    /// The IME state (preedit) shared with the per-frame [`ImeHandler`].
    pub fn ime(&self) -> &Rc<RefCell<Ime>> {
        &self.ime
    }

    /// The handler AppKit's input context talks to (registered every frame in paint).
    pub fn ime_handler(&self) -> ImeHandler {
        ImeHandler::new(self.ime.clone(), self.sink.clone())
    }

    /// Smooth scroll state (tests).
    pub fn smooth_scroll(&self) -> &SmoothScroll {
        &self.smooth
    }

    /// Sync groups: what's held, what was presented (tests: [`SyncState::record_presented`]).
    pub fn sync(&self) -> &SyncState {
        &self.sync
    }

    pub fn sync_mut(&mut self) -> &mut SyncState {
        &mut self.sync
    }

    /// What's presented of each sync group since recording started (tests).
    pub fn presented_log(&self) -> &[Presented] {
        self.sync.presented_log()
    }

    /// The topline a window grid shows on screen (a held picture's, else nvim's).
    pub fn presented_top(&self, grid: GridId) -> Option<i64> {
        self.sync.presented_top(&self.ui, grid)
    }

    /// Lua's other carets (`vimstorm.carets`): window handle and its cells; none = one caret.
    pub fn set_carets(&mut self, win: i64, cells: Vec<(usize, usize)>, cx: &mut Context<Self>) {
        let carets = (!cells.is_empty()).then_some((win, cells));
        if carets != self.carets {
            self.carets = carets;
            cx.notify();
        }
    }

    /// Where the other carets are drawn: in their window's grid, while it is shown.
    pub fn extra_carets(&self) -> Vec<CursorPos> {
        let Some((win, cells)) = &self.carets else {
            return Vec::new();
        };
        let Some(grid) = self
            .ui
            .windows
            .iter()
            .find(|(_, w)| w.win == *win && !w.hidden)
            .map(|(g, _)| *g)
        else {
            return Vec::new();
        };
        cells
            .iter()
            .map(|&(row, col)| CursorPos { grid, row, col })
            .collect()
    }

    /// Lua's "synced" marker (`git/scrollsync.lua`): (window, topline) of a group lined up.
    pub fn sync_marked(&mut self, tops: &[(i64, i64)], cx: &mut Context<Self>) {
        self.sync.mark(tops);
        if self.sync.marked(&self.ui) {
            cx.notify();
        }
    }

    /// Grid -> sync group, from Lua's window infos.
    fn sync_groups(&self) -> HashMap<GridId, SyncGroup> {
        self.ui
            .windows
            .iter()
            .filter(|(_, w)| !w.hidden && matches!(w.placement, Placement::Split { .. }))
            .filter_map(|(g, w)| Some((*g, self.kinds.get(&w.win)?.sync?)))
            .collect()
    }

    /// A hold started: present whatever nvim has after [`HOLD_SYNC`] at the latest.
    fn schedule_sync_expiry(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HOLD_SYNC).await;
            let _ = this.update(cx, |v, cx| {
                let now = cx.background_executor().now();
                if v.sync.expire(&v.ui, now) {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Startup measure of "the editor is up": an editor split (Lua said so) with text. nvim's
    /// first flushes show the intro screen.
    fn shows_editor(&self) -> bool {
        let with_text = |grid| {
            self.ui.grids.get(&grid).is_some_and(|g| {
                g.cells
                    .iter()
                    .any(|c| !matches!(c.text, CellText::Space | CellText::Empty))
            })
        };
        self.ui.windows.iter().any(|(grid, w)| {
            matches!(w.placement, Placement::Split { .. })
                && !w.hidden
                && self
                    .kinds
                    .get(&w.win)
                    .is_some_and(|k| k.kind == WinKind::Split)
                && with_text(*grid)
        })
    }

    /// In paint: startup frame milestones, and the key latency probe's paint / next vsync.
    fn paint_timing(view: &Entity<Self>, window: &mut Window, cx: &mut App) {
        let (first, content, key) = view.update(cx, |v, _| {
            let flushed = v.ui.flushes > 0;
            let first = flushed && !std::mem::replace(&mut v.startup.first_painted, flushed);
            let content = v.startup.content_flushed
                && !std::mem::replace(&mut v.startup.content_painted, true);
            (first, content, v.latency.painted())
        });
        if first {
            app::mark("first frame painted");
        }
        if content {
            app::mark("editor frame painted");
            window.on_next_frame(|_, _| app::mark("editor frame: next vsync"));
        }
        if key {
            // weak: a window macOS doesn't draw (occluded) never runs next-frame callbacks, and
            // a closed project's view must still drop
            let view = view.downgrade();
            window.on_next_frame(move |_, cx| {
                let _ = view.update(cx, |v, _| v.latency.presented());
            });
        }
    }

    // Layout ------------------------------------------------------------------------------------

    /// The window's size (from the workspace's render).
    pub fn set_viewport(&mut self, viewport: Size<Pixels>) {
        if viewport != self.viewport {
            self.viewport = viewport;
            self.relayout();
        }
    }

    pub fn set_workspace_strip(&mut self, shown: bool) {
        if self.workspace_strip != shown {
            self.workspace_strip = shown;
            self.relayout();
        }
    }

    /// The maximized island: None while nothing is, or once it is no longer laid out
    /// (its split closed, the tree hidden).
    pub fn maximized(&self) -> Option<Island> {
        self.maximized
    }

    /// Maximizes `island` over the body, or restores (None). Returns whether it changed.
    pub fn set_maximized(&mut self, island: Option<Island>, cx: &mut Context<Self>) -> bool {
        if self.maximized == island {
            return false;
        }
        self.maximized = island;
        self.relayout();
        cx.notify();
        true
    }

    pub fn set_panels(&mut self, panels: Panels, cx: &mut Context<Self>) {
        if panels != self.panels {
            self.panels = panels;
            self.relayout();
            cx.notify();
        }
    }

    /// Lua's window kinds (`vimstorm.layout` `windows`): replaces the known ones.
    pub fn set_windows(&mut self, kinds: HashMap<i64, WinInfo>, cx: &mut Context<Self>) {
        if kinds != self.kinds {
            self.kinds = kinds;
            self.resize_deferred = true;
            if self.relayout() {
                self.hold(cx);
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(DEFER_MAX).await;
                    let _ = this.update(cx, |v, cx| {
                        // no flush came: nothing closed; send them now (still holding)
                        if std::mem::take(&mut v.resize_deferred) && !v.relayout() {
                            v.hold = None;
                            cx.notify();
                        }
                    });
                })
                .detach();
            } else {
                self.resize_deferred = false;
                cx.notify();
            }
        }
    }

    /// Its project is shown (true) / hidden behind another open project (false): nvim gets
    /// FocusGained / FocusLost (autosave, checktime), the shown one sets the window title.
    pub fn set_project_active(&mut self, active: bool, window: &mut Window) {
        if active == self.project_active {
            return;
        }
        self.project_active = active;
        self.sync_ui_focus();
        if active {
            if !self.title.is_empty() {
                window.set_window_title(&self.title);
            }
        } else {
            self.focus_lost();
        }
    }

    /// nvim's title for the window (`set_title`).
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Tells nvim whether it has focus: the window is active and its project shown.
    fn sync_ui_focus(&mut self) {
        let focused = self.window_active && self.project_active;
        if focused != self.ui_focused {
            self.ui_focused = focused;
            self.nvim.rpc.ui_set_focus(focused);
        }
    }

    /// nvim's screen size (cells) it asked for, and whether nvim's screen has that size now.
    pub fn screen_matches(&self) -> bool {
        let (c, r) = self.ui.screen_size();
        (c, r) == self.size
    }

    /// A native surface has (true) / gave back (false) the keyboard.
    pub fn set_native_focus(&mut self, native: bool, cx: &mut Context<Self>) {
        if native != self.native_focus {
            self.native_focus = native;
            if native {
                self.focus_lost();
            }
            cx.notify();
        }
    }

    /// nvim's split windows (logical rects) with Lua's kinds, in draw order.
    fn nvim_wins(&self) -> Vec<NvimWin> {
        self.ui
            .layers()
            .iter()
            .filter(|l| l.grid != 1 && !l.floating)
            .filter_map(|l| {
                let w = self.ui.windows.get(&l.grid)?;
                let Placement::Split { row, col } = w.placement else {
                    return None;
                };
                let info = self.kinds.get(&w.win).copied().unwrap_or_default();
                Some(NvimWin {
                    role: info.role,
                    viewer: info.viewer,
                    grid: l.grid,
                    win: w.win,
                    row,
                    col,
                    width: w.width,
                    height: w.height,
                    winbar: w.margins.top,
                    kind: info.kind,
                    empty: info.empty,
                    // a code split (the WebStorm gutter: a file, numbers on), as Lua's reporter
                    minimap: self.minimap && info.textoff.is_some(),
                    crumbs: info.crumbs,
                })
            })
            .collect()
    }

    /// Rows of the message grid on screen: from its row to the screen's bottom (nvim allocates
    /// it full height and moves it up as messages scroll).
    fn message_rows(&self, grid: GridId) -> usize {
        let Some(Placement::Message { row, .. }) = self.ui.windows.get(&grid).map(|w| &w.placement)
        else {
            return 0;
        };
        let height = self.ui.grids.get(&grid).map_or(0, |g| g.height);
        self.ui.screen_size().1.saturating_sub(*row).min(height)
    }

    /// The message grid's text on screen ("" when blank).
    fn message_text(&self, grid: GridId) -> String {
        let Some(g) = self.ui.grids.get(&grid) else {
            return String::new();
        };
        let text: String = (0..self.message_rows(grid))
            .map(|r| g.row_text(r))
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            String::new()
        } else {
            text
        }
    }

    /// Whether the message grid is drawn: while typing a command, while messages scrolled up
    /// (more than one row / hit-enter), and for [`MESSAGE_SHOWN`] after a message changed (no
    /// command line row in the layout; the last command doesn't linger over the islands).
    fn message_visible(&self, grid: GridId) -> bool {
        let scrolled = matches!(
            self.ui.windows.get(&grid).map(|w| &w.placement),
            Some(Placement::Message { scrolled: true, .. })
        );
        self.ui.mode.starts_with("cmdline")
            || scrolled
            || self.message_rows(grid) > 1
            || self
                .message
                .as_ref()
                .is_some_and(|(text, _, shown)| *shown && !text.is_empty())
    }

    /// Notes when the message grid's text changes; hides it again [`MESSAGE_SHOWN`] later.
    fn track_message(&mut self, cx: &mut Context<Self>) {
        let Some(grid) = self
            .ui
            .windows
            .iter()
            .find_map(|(g, w)| matches!(w.placement, Placement::Message { .. }).then_some(*g))
        else {
            return;
        };
        let text = self.message_text(grid);
        if self.message.as_ref().is_some_and(|(t, ..)| *t == text) {
            return;
        }
        // a message while typing a command is the command line itself: not shown after it
        let shown = !text.is_empty() && !self.ui.mode.starts_with("cmdline");
        let at = cx.background_executor().now();
        self.message = Some((text, at, shown));
        if shown {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(MESSAGE_SHOWN).await;
                let _ = this.update(cx, |v, cx| {
                    if let Some((_, t, shown)) = &mut v.message
                        && *t == at
                    {
                        *shown = false;
                        v.relayout();
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }

    /// Recomputes the geometry; sends nvim its screen size and the grid sizes that changed.
    /// Returns whether grid sizes were requested (nvim redraws those grids next).
    pub fn relayout(&mut self) -> bool {
        let m = self.metrics;
        let frame = Frame::with_workspace_strip(self.viewport, self.panels, self.workspace_strip);
        let size = frame.screen_size(&m);
        if size != self.size {
            self.size = size;
            self.nvim.rpc.ui_try_resize(size.0, size.1);
        }
        let screen = match self.ui.screen_size() {
            (0, _) | (_, 0) => size,
            s => s,
        };
        let wins = self.nvim_wins();
        let mut geo = Geometry {
            layout: shell::layout(&frame, &m, screen, &wins),
            metrics: m,
            places: Vec::new(),
            caret: None,
        };
        // a maximized island alone over the body; one gone (its split closed, the tree
        // hidden) restores, so does nvim's cursor in another split (⌃W w, :split: the keys would
        // go to a window not drawn). Lua lists windows ahead of a redraw: a split it still lists
        // stays.
        if let Some(Island::Split(max)) = self.maximized
            && wins
                .iter()
                .any(|w| w.grid == self.ui.cursor.grid && w.kind == WinKind::Split && w.win != max)
        {
            self.maximized = None;
        }
        if let Some(island) = self.maximized
            && !geo.layout.maximize(
                island,
                Frame::maximized(self.viewport, self.workspace_strip),
                &m,
            )
        {
            let pending = matches!(island, Island::Split(w) | Island::Bottom(w) if self.kinds.contains_key(&w));
            if !pending {
                self.maximized = None;
            }
        }
        let viewport = Bounds::new(point(px(0.), px(0.)), self.viewport);
        for l in self.ui.layers() {
            if l.grid == 1 {
                continue;
            }
            let (Some(w), Some(g)) = (self.ui.windows.get(&l.grid), self.ui.grids.get(&l.grid))
            else {
                continue;
            };
            let place = match &w.placement {
                Placement::Split { .. } => {
                    let Some(r) = geo.layout.wins.iter().find(|r| r.grid == l.grid) else {
                        continue;
                    };
                    // a native surface is drawn there instead (no grid, no mouse, no caret)
                    if r.role.is_some() {
                        continue;
                    }
                    GridPlace {
                        grid: l.grid,
                        origin: r.grid_area.origin,
                        clip: r.grid_area,
                        cells: (g.width, g.height),
                        kind: PlaceKind::Window,
                        mouse: true,
                        text: r.kind != WinKind::Tool,
                        trim_col: self
                            .kinds
                            .get(&r.win)
                            .and_then(|k| k.textoff)
                            .map(usize::from),
                    }
                }
                Placement::Float {
                    anchor,
                    anchor_grid,
                    anchor_row,
                    anchor_col,
                    screen_pos,
                    mouse_enabled,
                    ..
                } => {
                    let origin = geo
                        .float_origin(
                            *anchor,
                            *anchor_grid,
                            *anchor_row,
                            *anchor_col,
                            g.width,
                            g.height,
                        )
                        .or_else(|| {
                            // anchor grid not placed: nvim's own screen position
                            let (r, c) = (*screen_pos)?;
                            geo.cell_to_px(1, r, c)
                        });
                    let Some(origin) = origin else { continue };
                    GridPlace {
                        grid: l.grid,
                        origin,
                        clip: viewport,
                        cells: (g.width, g.height),
                        kind: PlaceKind::Float,
                        mouse: *mouse_enabled,
                        text: false,
                        trim_col: None,
                    }
                }
                Placement::Message { .. } => {
                    if !self.message_visible(l.grid) {
                        continue;
                    }
                    geo.message_place(l.grid, g.width, self.message_rows(l.grid))
                }
            };
            geo.places.push(place);
        }
        let c = self.ui.cursor;
        if let Some(grid) = self.ui.grids.get(&c.grid) {
            let wide = grid
                .cell(c.row, c.col + 1)
                .is_some_and(|n| n.text.is_empty());
            geo.caret = geo.cell_bounds(c.grid, c.row, c.col, if wide { 2 } else { 1 });
        }

        // grid sizes: what fits each island (a request nvim already has isn't sent again)
        let mut sent = false;
        for r in &geo.layout.wins {
            if self.requested.get(&r.grid) == Some(&r.request) {
                continue;
            }
            // Lua lists every split window on each layout change, ahead of the redraw that closes
            // one: a window it no longer lists is closing and its grid may be gone in nvim already
            // (a resize would come back as an "Invalid window handle" error event)
            if !self.kinds.is_empty() && !self.kinds.contains_key(&r.win) {
                continue;
            }
            let current = self.ui.grids.get(&r.grid).map(|g| (g.width, g.height));
            sent |= current != Some(r.cells);
            if self.resize_deferred {
                continue;
            }
            self.requested.insert(r.grid, r.request);
            self.nvim
                .rpc
                .ui_try_resize_grid(r.grid, r.request.0, r.request.1);
        }
        self.requested.retain(|g, _| self.ui.grids.contains_key(g));
        let groups = self.sync_groups();
        self.sync.set_groups(groups);
        let geo = Rc::new(geo);
        self.shared.set(geo.clone());
        self.geometry = geo;
        sent
    }

    /// The editor font size changed (View > Increase / Decrease / Reset Font Size, `app_menu`), or
    /// a look changed its family, ligatures or the density (`crate::look`): new cells, so new grid
    /// sizes for nvim; the old picture isn't drawn at the new scale.
    fn sync_font_size(&mut self, window: &Window, cx: &mut Context<Self>) {
        let size = editor_font_size(cx);
        let roomy = crate::look::density::is_default();
        if self.metrics.is_current(size) && self.roomy == roomy {
            return;
        }
        self.roomy = roomy;
        self.metrics = CellMetrics::measure(window, size);
        if self.relayout() {
            self.hold(cx);
        }
        cx.notify();
    }

    /// Don't draw until nvim answers the grid size requests (or [`HOLD_MAX`] passed).
    fn hold(&mut self, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        self.hold = Some(now);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HOLD_MAX).await;
            let _ = this.update(cx, |v, cx| {
                if v.hold == Some(now) {
                    v.hold = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    // nvim events ----------------------------------------------------------------------------------

    /// Applies one redraw batch (the workspace's event pump).
    pub fn apply(&mut self, batch: Vec<RedrawEvent>, window: &mut Window, cx: &mut Context<Self>) {
        let first = self.ui.flushes == 0;
        if let Some(title) = batch.iter().rev().find_map(|e| match e {
            RedrawEvent::SetTitle(t) => Some(t.clone()),
            _ => None,
        }) && title != self.title
        {
            if self.project_active {
                window.set_window_title(&title);
            }
            self.title = title;
        }
        self.sync.before_batch(&self.ui, &batch);
        let flushed = self.ui.apply(batch);
        if flushed {
            self.echo.flushed(&self.ui);
            // the menu is insert mode's: a close the floats never heard of doesn't stick
            if self.ui.mode != "insert" {
                self.completion_menu = false;
            }
        }
        self.refresh_echo();
        self.track_smooth_scroll();
        if !flushed {
            return;
        }
        if first {
            app::mark("first flush");
        }
        self.latency.flushed();
        // a held mouse move: the keys nvim just drew may have ended the sequence
        let step = self.moves.retry();
        self.step_moves(step, cx);
        self.track_message(cx);
        if !self.startup.content_flushed && app::timing_enabled() && self.shows_editor() {
            self.startup.content_flushed = true;
            app::mark("editor flush (a split with text)");
        }
        let was_holding = self.hold.take().is_some();
        let deferred = std::mem::take(&mut self.resize_deferred);
        let resized = self.relayout();
        let now = cx.background_executor().now();
        if self.sync.flushed(&self.ui, now) {
            self.schedule_sync_expiry(cx);
        }
        // a Lua report's grid sizes went out just now: hold for them as if sent with it
        if resized && (!was_holding || deferred) {
            // windows moved: their grids get resized next; draw then
            self.hold(cx);
            return;
        }
        cx.notify();
    }

    /// After a batch: steps nvim applied keep the content where it's drawn.
    fn track_smooth_scroll(&mut self) {
        let Some(grid) = self.smooth.grid() else {
            return;
        };
        let Some(vp) = self.ui.windows.get(&grid).and_then(|w| w.viewport) else {
            // window closed / hidden
            self.smooth.reset();
            self.settle = None;
            return;
        };
        let row = self.metrics.row_height.as_f32();
        let rows = self.ui.text_scroll(grid);
        self.smooth.scrolled(grid, rows, row);
        self.smooth.viewport(grid, vp.topline, vp.line_count);
        if rows != 0 {
            // partners that moved as many rows (Lua scrolled them with it): drawn with its offset;
            // one that didn't (an insertion on the other side) stays where nvim has it
            self.follows = self
                .sync
                .partners(grid)
                .into_iter()
                .filter(|p| self.ui.text_scroll(*p) == rows)
                .collect();
        }
    }

    // Geometry queries ----------------------------------------------------------------------------

    /// Window-coordinate bounds of the caret's cell (IME candidate window placement).
    pub fn caret_bounds(&self) -> Option<Bounds<Pixels>> {
        let mut b = self.geometry.caret?;
        if let Some(off) = self.scroll_offset_of(self.ui.cursor.grid) {
            b.origin.y += off;
        }
        Some(b)
    }

    /// Topmost mouse-enabled grid under a window position: (grid, row, col) in that grid. In a
    /// smooth-scrolled text area, the row drawn there.
    pub fn hit_test(&self, pos: Point<Pixels>) -> Option<(GridId, usize, usize)> {
        let (grid, r, c) = self.geometry.grid_at(pos)?;
        if let Some(off) = self.scroll_offset_of(grid)
            && let Some(rows) = self.text_rows(grid)
            && rows.contains(&r)
            && let Some(p) = self.geometry.place(grid)
        {
            let (srow, _) = self.geometry.cell_in(p, point(pos.x, pos.y - off));
            let r = srow.clamp(rows.start as i64, rows.end as i64 - 1) as usize;
            return Some((grid, r, c));
        }
        Some((grid, r, c))
    }

    /// Window position of the center of a cell of the composed (logical) screen: the grid nvim's
    /// composition shows there, mapped to where that grid is drawn (tests).
    pub fn screen_cell_center(&self, row: usize, col: usize) -> Option<Point<Pixels>> {
        let (grid, r, c) = self.ui.hit_test(row as i64, col as i64)?;
        self.geometry
            .cell_to_px(grid, r as f64 + 0.5, c as f64 + 0.5)
    }

    /// What this frame draws of each window grid, for overlays painting over grid cells
    /// ([`DrawnGrids`]): set while the grid element prepaints, before the layers above paint.
    fn publish_drawn(&self) {
        let m = self.metrics;
        let mut out = HashMap::new();
        for p in self.geometry.places.iter() {
            if p.kind != PlaceKind::Window {
                continue;
            }
            let held = self.sync.held(p.grid);
            let (grid, margins) = match held {
                Some(h) => (&h.grid, h.margins),
                None => match (self.ui.grids.get(&p.grid), self.ui.windows.get(&p.grid)) {
                    (Some(g), Some(w)) => (g, w.margins),
                    _ => continue,
                },
            };
            let top = margins.top.min(grid.height);
            let text_rows = top..grid.height.saturating_sub(margins.bottom).max(top);
            let offset = self.scroll_offset_of(p.grid).unwrap_or_default();
            let (above, below) = grid.kept_rows();
            let (start, end) = (text_rows.start as i64, text_rows.end as i64);
            let drawn_rows = if offset > px(0.) {
                start - above as i64..end
            } else if offset < px(0.) {
                start..end + below as i64
            } else {
                start..end
            };
            let area = Bounds::new(
                m.cell_origin(p.origin, start, 0),
                gpui_kit::size(
                    m.cell_width * grid.width as f32,
                    m.row_height * text_rows.len() as f32,
                ),
            );
            let win = self.ui.windows.get(&p.grid).map_or(0, |w| w.win);
            out.insert(
                p.grid,
                DrawnGrid {
                    grid: p.grid,
                    win,
                    origin: p.origin,
                    offset,
                    text_rows,
                    text_clip: area.intersect(&p.clip),
                    drawn_rows,
                    topline: match held {
                        Some(h) => h.viewport.map(|v| v.topline),
                        None => self
                            .ui
                            .windows
                            .get(&p.grid)
                            .and_then(|w| w.viewport)
                            .map(|v| v.topline),
                    },
                    held: held.is_some(),
                    cells: (grid.width, grid.height),
                    metrics: m,
                },
            );
        }
        self.drawn.set(out);
    }

    fn text_rows(&self, grid: GridId) -> Option<std::ops::Range<usize>> {
        let g = self.ui.grids.get(&grid)?;
        Some(self.ui.windows.get(&grid)?.text_rows(g.height))
    }

    // Input ----------------------------------------------------------------------------------------

    /// Keys, text and clicks (not hover moves: [`Self::on_hover`]), each sent once as it is; local
    /// echo draws what it predicts of them (`now`: when they were typed).
    fn send(&mut self, actions: Vec<Action>, now: Instant) -> Echoing {
        let mut echoing = Echoing::default();
        for a in actions {
            if matches!(a, Action::Input(_) | Action::Mouse { .. }) {
                self.moves.key_sent();
            }
            let barrier = self.echo_action(&a, now, &mut echoing);
            forward(self.rpc(), a);
            if let Some(id) = barrier {
                self.rpc()
                    .exec_lua_after_input(ECHO_BARRIER, vec![id.into()]);
            }
        }
        if echoing.changed {
            self.refresh_echo();
        }
        echoing
    }

    /// [`Self::send`], then a frame for what echo drew and its expiry.
    fn send_now(&mut self, actions: Vec<Action>, cx: &mut Context<Self>) {
        let echoing = self.send(actions, cx.background_executor().now());
        if echoing.predicted {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CONFIRM_WITHIN).await;
                let _ = this.update(cx, |v, cx| {
                    if v.echo.expire(cx.background_executor().now()) {
                        v.refresh_echo();
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        if echoing.changed {
            cx.notify();
        }
    }

    /// Local echo's part in sending `a`: predicted, or the echo dropped. Returns the barrier to
    /// send after it.
    fn echo_action(&mut self, a: &Action, now: Instant, echoing: &mut Echoing) -> Option<u64> {
        if !self.echo.on() {
            return None;
        }
        let before = self.echo.pending();
        let keys = match a {
            Action::Input(keys) => echo_keys(keys),
            _ => None,
        };
        let barrier = match keys {
            Some(keys) => {
                let spot = self.echo_spot();
                let mut barrier = None;
                for k in keys {
                    match self.echo.key(k, &self.ui, spot, now) {
                        Echoed::Predicted => echoing.predicted = true,
                        Echoed::Unpredicted { barrier: b } => barrier = b.or(barrier),
                    }
                }
                barrier
            }
            None => self.echo.other(),
        };
        echoing.changed |= echoing.predicted || self.echo.pending() != before;
        barrier
    }

    /// Where the caret is, when echo may predict there: a code split's text area, nothing else with
    /// the keyboard (a native surface, the completion menu, an IME composition).
    fn echo_spot(&self) -> Option<Spot> {
        if self.native_focus || self.completion_menu || self.ime.borrow().marked_text().is_some() {
            return None;
        }
        let c = self.ui.cursor;
        let w = self.ui.windows.get(&c.grid)?;
        if w.hidden
            || !matches!(w.placement, Placement::Split { .. })
            || self.sync.held(c.grid).is_some()
        {
            return None;
        }
        let info = self.kinds.get(&w.win)?;
        if info.kind != WinKind::Split
            || info.role.is_some()
            || info.sync.is_some()
            || info.viewer.is_some()
        {
            return None;
        }
        let g = self.ui.grids.get(&c.grid)?;
        w.text_rows(g.height).contains(&c.row).then(|| Spot {
            text_col: info.textoff.map_or(0, usize::from),
        })
    }

    /// Echo's grid again, from its keys over nvim's grid now.
    fn refresh_echo(&mut self) {
        self.echo_shown = self.echo.shown(&self.ui);
    }

    /// Local echo's barrier `id` is back ([`ECHO_BARRIER`], the workspace's `echo` bridge).
    pub fn echo_answered(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.echo.answered(id) {
            self.refresh_echo();
            cx.notify();
        }
    }

    /// blink.cmp's completion menu opened / closed (the floats surface).
    pub fn set_completion_menu(&mut self, open: bool) {
        self.completion_menu = open;
    }

    /// Whether typed text echoes locally here (a cloud workspace's editor).
    pub fn local_echo(&self) -> bool {
        self.echo.on()
    }

    /// Keys drawn ahead of nvim (tests).
    pub fn echo_pending(&self) -> usize {
        self.echo.pending()
    }

    /// Echo waits for its barrier: nvim hasn't read every unpredicted key yet (tests).
    pub fn echo_waits(&self) -> bool {
        self.echo.holding()
    }

    /// The screen as drawn, echo's keys included ([`UiState::screen_lines`] is nvim's).
    pub fn shown_screen_lines(&self) -> Vec<String> {
        self.ui
            .screen_lines_with(self.echo_shown.as_ref().map(|s| (s.grid, &s.cells)))
    }

    /// Where the caret is drawn (echo's ahead of nvim's).
    pub fn shown_cursor(&self) -> CursorPos {
        self.echo_shown
            .as_ref()
            .map_or(self.ui.cursor, |s| s.cursor)
    }

    /// The move guard's next step (see [`crate::editor::input::MoveGuard`]).
    fn step_moves(&mut self, step: MoveStep, cx: &mut Context<Self>) {
        match step {
            MoveStep::Send(a) => forward(self.rpc(), a),
            MoveStep::Probe(id) => {
                let mode = self.rpc().request("nvim_get_mode", Vec::new());
                cx.spawn(async move |this, cx| {
                    let blocking = mode.await.ok().map(|m| crate::nvim::mode_blocking(&m));
                    let _ = this.update(cx, |v, cx| {
                        let step = v.moves.answer(id, blocking);
                        v.step_moves(step, cx);
                    });
                })
                .detach();
            }
            MoveStep::RetryLater => {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(MOVE_RETRY).await;
                    let _ = this.update(cx, |v, cx| {
                        let step = v.moves.retry();
                        v.step_moves(step, cx);
                    });
                })
                .detach();
            }
            MoveStep::Wait => {}
        }
    }

    /// A key or IME text: a smooth scroll in progress jumps to nvim's rows.
    fn input_happened(&mut self, cx: &mut Context<Self>) {
        if self.smooth.grid().is_some() {
            self.smooth.reset();
            self.settle = None;
            cx.notify();
        }
    }

    /// Window / editor lost focus: no Shift tap pending, drop the preedit.
    fn focus_lost(&mut self) {
        self.keys.focus_lost();
        self.ime.borrow_mut().clear();
    }

    /// A key for nvim. Returns whether the key is done (false: it goes on to the IME, text keys).
    pub fn on_key_down(&mut self, ev: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        self.latency.key(&ev.keystroke.unparse());
        crate::git::window::key_pressed(&ev.keystroke);
        let out = self.keys.key_down(ev);
        self.input_happened(cx);
        if !out.actions.is_empty() {
            self.latency.sent();
        }
        self.send_now(out.actions, cx);
        !out.to_ime
    }

    /// Any key press, also one a native surface takes (Shift+letter typed into a picker's field):
    /// no Shift tap, so no double Shift.
    pub fn interrupt_shift(&mut self) {
        self.keys.mouse_down();
    }

    pub fn on_modifiers_changed(&mut self, modifiers: Modifiers, cx: &mut Context<Self>) {
        let now = cx.background_executor().now();
        let actions = self.keys.modifiers_changed(modifiers, now);
        self.send(actions, now);
    }

    /// A press on the grids: a grid (focuses the editor) or a gap between nvim's windows (drags
    /// nvim's separator). Returns whether it was nvim's.
    pub fn on_mouse_down(
        &mut self,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.keys.mouse_down();
        if let Some(gap) = self.geometry.gap_at(ev.position).copied() {
            let l = &self.geometry.layout;
            let (vertical, row, col, axis) = match gap.kind {
                shell::GapKind::Vertical { row, col, bottom } => {
                    (true, row, col, if bottom { l.x_bottom } else { l.x_editor })
                }
                shell::GapKind::Divider { row, col } => (true, row, col, l.x_editor),
                shell::GapKind::Horizontal { row, col } => (false, row, col, l.y),
                shell::GapKind::Tree | shell::GapKind::Chat => return false,
            };
            if ev.button != MouseButton::Left {
                return true;
            }
            let grab = if vertical {
                axis.cell(ev.position.x.as_f32()) - col as i64
            } else {
                axis.cell(ev.position.y.as_f32()) - row as i64
            };
            self.press = Some(Press {
                button: ev.button,
                on: PressOn::Separator {
                    vertical,
                    row,
                    col,
                    axis,
                    grab,
                },
            });
            self.last_drag = Some((row as i64, col as i64));
            self.send_now(
                vec![Action::mouse(
                    ev.button,
                    MouseAction::Press,
                    ev.modifiers,
                    1,
                    row as u64,
                    col as u64,
                )],
                cx,
            );
            return true;
        }
        let Some((grid, r, c)) = self.hit_test(ev.position) else {
            return false;
        };
        window.focus(&self.focus, cx);
        let origin = self
            .geometry
            .place(grid)
            .map_or(Point::default(), |p| p.origin);
        self.press = Some(Press {
            button: ev.button,
            on: PressOn::Grid { grid, origin },
        });
        self.last_drag = Some((r as i64, c as i64));
        self.send_now(
            vec![Action::mouse(
                ev.button,
                MouseAction::Press,
                ev.modifiers,
                grid,
                r as u64,
                c as u64,
            )],
            cx,
        );
        true
    }

    /// (grid, row, col) of `pos` for the held button.
    fn press_cell(&self, press: &Press, pos: Point<Pixels>) -> (GridId, i64, i64) {
        match press.on {
            PressOn::Grid { grid, origin } => {
                let m = self.metrics;
                let row = ((pos.y - origin.y) / m.row_height).floor() as i64;
                let trim = self.geometry.place(grid).and_then(|p| p.trim_col);
                let col = shell::col_at(pos.x - origin.x, m.cell_width, trim);
                (grid, row.max(0), col.max(0))
            }
            PressOn::Separator {
                vertical,
                row,
                col,
                axis,
                grab,
            } => {
                if vertical {
                    (1, row as i64, (axis.cell(pos.x.as_f32()) - grab).max(0))
                } else {
                    (1, (axis.cell(pos.y.as_f32()) - grab).max(0), col as i64)
                }
            }
        }
    }

    /// The pointer moved with nvim's button held: the cell when it changes. Returns whether
    /// nvim holds a button.
    pub fn on_drag(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        let Some(press) = self.press else {
            return false;
        };
        if ev.pressed_button != Some(press.button) {
            return false;
        }
        let (grid, r, c) = self.press_cell(&press, ev.position);
        if self.last_drag != Some((r, c)) {
            self.last_drag = Some((r, c));
            self.send(
                vec![Action::mouse(
                    press.button,
                    MouseAction::Drag,
                    ev.modifiers,
                    grid,
                    r as u64,
                    c as u64,
                )],
                cx.background_executor().now(),
            );
        }
        true
    }

    /// Hover (`<MouseMove>`: gutter tooltips, menu highlight), only with 'mousemoveevent'.
    pub fn on_hover(&mut self, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        if ev.pressed_button.is_some() || !self.mouse_move_enabled() {
            return;
        }
        let Some(hit) = self.hit_test(ev.position) else {
            return;
        };
        if self.last_move != Some(hit) {
            self.last_move = Some(hit);
            let step = self.moves.hover(Action::mouse_move(
                ev.modifiers,
                hit.0,
                hit.1 as u64,
                hit.2 as u64,
            ));
            self.step_moves(step, cx);
        }
    }

    fn mouse_move_enabled(&self) -> bool {
        self.ui
            .options
            .get("mousemoveevent")
            .and_then(rmpv::Value::as_bool)
            .unwrap_or(false)
    }

    pub fn on_mouse_up(&mut self, ev: &MouseUpEvent, cx: &mut Context<Self>) {
        let Some(press) = self.press.filter(|p| p.button == ev.button) else {
            return;
        };
        self.press = None;
        let last = self.last_drag.take();
        let (grid, r, c) = self.press_cell(&press, ev.position);
        let mut actions = Vec::with_capacity(2);
        // a separator released on another cell than the last drag said (no move reached it: a
        // fast flick, a synthetic drag): nvim moves separators on drags only
        if matches!(press.on, PressOn::Separator { .. }) && last != Some((r, c)) {
            actions.push(Action::mouse(
                press.button,
                MouseAction::Drag,
                ev.modifiers,
                grid,
                r as u64,
                c as u64,
            ));
        }
        actions.push(Action::mouse(
            press.button,
            MouseAction::Release,
            ev.modifiers,
            grid,
            r as u64,
            c as u64,
        ));
        self.send(actions, cx.background_executor().now());
    }

    /// Trackpad pixels over a window: smooth (content follows the fingers); mouse-wheel lines,
    /// modified scrolls and grids without a window (messages): whole rows, no animation.
    pub fn on_scroll(&mut self, ev: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let Some((grid, r, c)) = self.hit_test(ev.position) else {
            return;
        };
        let (row, cell) = (self.metrics.row_height, self.metrics.cell_width);
        let viewport = self.ui.windows.get(&grid).and_then(|w| w.viewport);
        let steps = match (ev.delta, viewport) {
            (ScrollDelta::Pixels(p), Some(vp)) if ev.modifiers == Modifiers::default() => {
                let horizontal = ScrollDelta::Pixels(point(p.x, px(0.)));
                let left = self.wheel.scroll(&horizontal, row, cell).left;
                let up =
                    self.smooth
                        .scroll(grid, p.y.as_f32(), row.as_f32(), vp.topline, vp.line_count);
                self.smooth_at = (grid, r, c);
                self.schedule_settle(cx);
                WheelSteps {
                    up: up as i32,
                    left,
                }
            }
            _ => {
                self.smooth.reset();
                self.settle = None;
                self.wheel.scroll(&ev.delta, row, cell)
            }
        };
        self.send_wheel(
            steps,
            ev.modifiers,
            (grid, r, c),
            cx.background_executor().now(),
        );
        cx.notify();
    }

    /// Wheel steps over cell `at` of a grid. A pane of a sync group scrolls with its partners in
    /// one Lua call (`git/scrollsync.lua` `scroll`: mapped through the diff), so nvim redraws them
    /// in one flush; separate wheel events would scroll the partners a `WinScrolled` later.
    /// `now`: the executor's clock, as every send's.
    fn send_wheel(
        &mut self,
        mut steps: WheelSteps,
        modifiers: Modifiers,
        at: (GridId, usize, usize),
        now: Instant,
    ) {
        let (grid, r, c) = at;
        if steps.up != 0
            && modifiers == Modifiers::default()
            && self.sync.group_of(grid).is_some()
            && let Some(win) = self.ui.windows.get(&grid).map(|w| w.win)
        {
            let lines = -(steps.up as i64);
            crate::nvim::lua::call(
                self.rpc(),
                "git.scrollsync",
                "scroll",
                vec![win.into(), lines.into()],
            );
            steps.up = 0;
        }
        self.send(steps.actions(modifiers, grid, r as u64, c as u64), now);
    }

    /// Once scroll events stop: finish on a whole row, easing the rest of the offset out. One
    /// task per gesture (not per event): it waits until `last_scroll` is old enough.
    fn schedule_settle(&mut self, cx: &mut Context<Self>) {
        self.last_scroll = cx.background_executor().now();
        if self.settle.is_some() {
            return;
        }
        self.settle = Some(cx.spawn(async move |this, cx| {
            let exec = cx.background_executor().clone();
            let row = |v: &EditorView| v.metrics.row_height.as_f32();
            let dt = SETTLE_FRAME.as_secs_f32() * 1000.;
            'gesture: loop {
                // quiet for SETTLE_AFTER: the fingers and the momentum are done
                loop {
                    let Ok(last) = this.update(cx, |v, _| v.last_scroll) else {
                        return;
                    };
                    let wait = (last + SETTLE_AFTER).saturating_duration_since(exec.now());
                    if wait.is_zero() {
                        break;
                    }
                    exec.timer(wait).await;
                }
                let Ok(started) = this.update(cx, |v, _| {
                    let up = v.smooth.settle_start(row(v));
                    if up != 0 {
                        let steps = WheelSteps {
                            up: up as i32,
                            left: 0,
                        };
                        v.send_wheel(steps, Modifiers::default(), v.smooth_at, exec.now());
                    }
                    v.last_scroll
                }) else {
                    return;
                };
                loop {
                    exec.timer(SETTLE_FRAME).await;
                    let Ok(done) = this.update(cx, |v, cx| {
                        // scrolling again: follow the fingers, settle later
                        if v.last_scroll != started {
                            return None;
                        }
                        cx.notify();
                        let done = v.smooth.settle_tick(dt, row(v));
                        if done {
                            v.settle = None;
                        }
                        Some(done)
                    }) else {
                        return;
                    };
                    match done {
                        None => continue 'gesture,
                        Some(true) => return,
                        Some(false) => {}
                    }
                }
            }
        }));
    }
}

impl Focusable for EditorView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl GridHost for EditorView {
    fn ui(&self) -> &UiState {
        &self.ui
    }

    fn metrics(&self) -> CellMetrics {
        self.metrics
    }

    fn geometry(&self) -> &Geometry {
        &self.geometry
    }

    fn caret_visible(&self) -> bool {
        !self.ui.busy && !self.native_focus
    }

    fn prepaint(&mut self, _cx: &mut Context<Self>) {
        self.latency.drawing();
        self.publish_drawn();
    }

    /// The smooth offset, limited to the rows nvim's grid kept for the edge it reveals (until nvim
    /// has scrolled, the grid has none on that side: it's drawn where nvim has it).
    fn scroll_offset(&self) -> Option<(GridId, Pixels)> {
        let (grid, _) = self.smooth.offset()?;
        Some((grid, self.scroll_offset_of(grid)?))
    }

    /// The smooth-scrolled grid's offset, and its sync partners' that moved with it (same rule).
    /// A held picture is drawn where it was.
    fn scroll_offset_of(&self, grid: GridId) -> Option<Pixels> {
        let (sgrid, off) = self.smooth.offset()?;
        if (grid != sgrid && !self.follows.contains(&grid)) || self.sync.held(grid).is_some() {
            return None;
        }
        let (above, below) = self.ui.grids.get(&grid)?.kept_rows();
        let row = self.metrics.row_height.as_f32();
        let off = off.clamp(-(below as f32) * row, above as f32 * row);
        (off != 0.).then_some(px(off))
    }

    /// A sync group's held picture, else local echo's grid.
    fn held_grid(&self, grid: GridId) -> Option<(&Grid, crate::nvim::Margins)> {
        if let Some(h) = self.sync.held(grid) {
            return Some((&h.grid, h.margins));
        }
        let shown = self.echo_shown.as_ref().filter(|s| s.grid == grid)?;
        let margins = self.ui.windows.get(&grid).map(|w| w.margins)?;
        Some((&shown.cells, margins))
    }

    fn cursor(&self) -> CursorPos {
        self.shown_cursor()
    }

    fn extra_carets(&self) -> Vec<CursorPos> {
        EditorView::extra_carets(self)
    }

    fn preedit(&self) -> Option<String> {
        self.ime.borrow().marked_text().map(str::to_owned)
    }

    fn paint_input(
        view: &Entity<Self>,
        _bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if app::timing_enabled() {
            Self::paint_timing(view, window, cx);
        }
        let v = view.read(cx);
        if let Some(caret) = v.caret_bounds() {
            v.ime.borrow_mut().set_caret_bounds(caret);
        }
        let (focus, handler) = (v.focus.clone(), v.ime_handler());
        window.handle_input(&focus, handler, cx);
    }
}

impl Render for EditorView {
    /// The grids over the whole window (they paint in window coordinates); the body is where the
    /// editor takes the keyboard.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_font_size(window, cx);
        let body = self.geometry.layout.frame.body;
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(GridElement::new(cx.entity()))
            .child(
                div()
                    .absolute()
                    .left(body.origin.x)
                    .top(body.origin.y)
                    .w(body.size.width)
                    .h(body.size.height)
                    .track_focus(&self.focus),
            )
    }
}
