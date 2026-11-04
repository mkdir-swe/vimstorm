//! A real `Workspace` (the window root, with its `EditorView`) in a GPUI test window on the real nvim (config, fixtures and own state as
//! [`super::Session`]). Tests drive it with GPUI key / modifier / mouse / scroll / IME events: the
//! view's own listeners, its `crate::editor::input` wiring and `editor::forward` send them to nvim, as in
//! the app. Waits on conditions (nvim events wake the waiter), never fixed sleeps.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::channel::mpsc;
use gpui_kit::{
    Entity, InputHandler as _, Modifiers, MouseButton, MouseUpEvent, Pixels, Point, ScrollDelta,
    ScrollWheelEvent, TestAppContext, TestDispatcher, TouchPhase, VisualTestContext, px, size,
};
use parking_lot::{Condvar, Mutex};
use rmpv::Value;
use vimstorm::editor::EditorView;
use vimstorm::editor::input;
use vimstorm::nvim::{Nvim, NvimEvent, RedrawEvent, Rpc, UiState};
use vimstorm::shell::Workspace;
use vimstorm::shell::projects::{Projects, SavedSet};
use vimstorm::shell::toolbar::{Launcher, OpenNvims};

use super::{STARTED, TIMEOUT, map_get, nvim_config};

/// The test window: with the toolbar, status bar and the tree panel, the editor split gets ~80 x 33
/// cells of the test text system's 7.8 px cells.
pub const WINDOW: (f32, f32) = (936., 880.);

/// [`View::start_timed`]'s milestones, from spawning nvim.
#[derive(Clone, Copy, Debug)]
pub struct StartTimes {
    /// nvim's first redraw flush applied (nvim up, the UI attached).
    pub first_flush: Duration,
    /// The predicate held, its frame drawn.
    pub shown: Duration,
}

pub struct View {
    pub cx: VisualTestContext,
    pub view: Entity<EditorView>,
    pub ws: Entity<Workspace>,
    /// The window root when started with [`View::start_projects`] (`ws` / `view` = the first
    /// project's).
    pub projects: Option<Entity<Projects>>,
    rpc: Rpc,
    /// Count of nvim events, bumped by the reader thread.
    events: Arc<(Mutex<u64>, Condvar)>,
    /// Flushed redraw batches as the reader thread handed them over ([`View::start`] /
    /// [`View::start_timed`]).
    redraws: Redraws,
    _state: tempfile::TempDir,
}

/// Flushed redraw batches as read: when, and the top lines of the windows they scrolled.
type Redraws = Arc<Mutex<Vec<(Instant, Vec<i64>)>>>;

/// Reader thread: notes a flushed batch (the last 256).
fn read(redraws: &Redraws, batch: &[RedrawEvent]) {
    let tops = batch
        .iter()
        .filter_map(|e| match e {
            RedrawEvent::WinViewport { topline, .. } => Some(*topline),
            _ => None,
        })
        .collect();
    let mut r = redraws.lock();
    if r.len() == 256 {
        r.remove(0);
    }
    r.push((Instant::now(), tops));
}

/// What runs on the app before a projects window opens ([`View::start_projects_restored_with`]).
type Setup = Box<dyn FnOnce(&mut gpui_kit::App, &std::path::Path)>;

/// How the projects window opens: on one project, reopening a saved set, or a launch's path.
enum Opening {
    New,
    Restore(SavedSet),
    Launched,
}

impl View {
    /// Opens the view on nvim in `project` with `files`; returns once the config is up and the
    /// screen is quiet.
    pub fn start(project: &str, files: &[&str]) -> View {
        Self::start_with(project, files, |_| {})
    }

    /// [`View::start`] with nvim's config changed by `tweak` first (a cloud workspace's
    /// `launch`, a wrapper around nvim).
    pub fn start_with(
        project: &str,
        files: &[&str],
        tweak: impl FnOnce(&mut vimstorm::nvim::NvimConfig),
    ) -> View {
        let (mut cfg, state) = nvim_config(project, files);
        tweak(&mut cfg);
        let events: Arc<(Mutex<u64>, Condvar)> = Arc::default();
        let (tx, rx) = mpsc::unbounded();
        let ev2 = events.clone();
        let redraws: Redraws = Arc::default();
        let at2 = redraws.clone();
        let nvim = Nvim::start(&cfg, move |ev: NvimEvent| {
            if let NvimEvent::Redraw(batch) = &ev {
                read(&at2, batch);
            }
            let _ = tx.unbounded_send(ev);
            let (n, cv) = &*ev2;
            *n.lock() += 1;
            cv.notify_all();
        })
        .unwrap();
        let rpc = nvim.rpc.clone();
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        let dir = cfg.project.clone();
        let window = app.open_window(size(px(WINDOW.0), px(WINDOW.1)), move |window, cx| {
            Workspace::new(nvim, rx, dir, window, cx)
        });
        let ws = window.root(&mut app).unwrap();
        let view = ws.read_with(&app, |ws, _| ws.editor().clone());
        let mut cx = VisualTestContext::from_window(window.into(), &app);
        // a window in front, as the app's: GPUI only reports focus moves in an active window
        cx.update(|window, _| window.activate_window());
        let mut v = View {
            cx,
            view,
            ws,
            projects: None,
            rpc,
            events,
            redraws,
            _state: state,
        };
        v.wait_started();
        v
    }

    /// [`View::start`], timed from spawning nvim (perf tests): until the first redraw flush is
    /// applied, and until `shown` first holds on the view with a frame drawn (checked after every
    /// nvim event), e.g. the first frame showing the file's text. Returns once started as
    /// [`View::start`] does.
    pub fn start_timed(
        project: &str,
        files: &[&str],
        shown: impl Fn(&EditorView) -> bool,
    ) -> (View, StartTimes) {
        let (cfg, state) = nvim_config(project, files);
        let events: Arc<(Mutex<u64>, Condvar)> = Arc::default();
        let (tx, rx) = mpsc::unbounded();
        let ev2 = events.clone();
        let redraws: Redraws = Arc::default();
        let at2 = redraws.clone();
        let t0 = Instant::now();
        let mut nvim = Nvim::start(&cfg, move |ev: NvimEvent| {
            if let NvimEvent::Redraw(batch) = &ev {
                read(&at2, batch);
            }
            let _ = tx.unbounded_send(ev);
            let (n, cv) = &*ev2;
            *n.lock() += 1;
            cv.notify_all();
        })
        .unwrap();
        // the app's order (main.rs): the UI attaches right after the spawn, the window opens
        // while nvim sources its config
        vimstorm::editor::attach_early(&mut nvim, size(px(WINDOW.0), px(WINDOW.1)));
        let rpc = nvim.rpc.clone();
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        let dir = cfg.project.clone();
        let window = app.open_window(size(px(WINDOW.0), px(WINDOW.1)), move |window, cx| {
            Workspace::new(nvim, rx, dir, window, cx)
        });
        let ws = window.root(&mut app).unwrap();
        let view = ws.read_with(&app, |ws, _| ws.editor().clone());
        let mut cx = VisualTestContext::from_window(window.into(), &app);
        cx.update(|window, _| window.activate_window());
        let mut v = View {
            cx,
            view,
            ws,
            projects: None,
            rpc,
            events,
            redraws,
            _state: state,
        };
        let deadline = t0 + TIMEOUT;
        let mut first_flush = None;
        let shown_at = loop {
            let seen = *v.events.0.lock();
            v.pump();
            let (flushed, ok) = v
                .view
                .read_with(&v.cx, |e, _| (e.ui().flushes > 0, shown(e)));
            if flushed && first_flush.is_none() {
                first_flush = Some(t0.elapsed());
            }
            if ok {
                // the frame showing it
                v.cx.update(|window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                });
                break t0.elapsed();
            }
            assert!(Instant::now() < deadline, "startup never showed it");
            v.wait_event(seen);
        };
        v.wait_started();
        let times = StartTimes {
            first_flush: first_flush.unwrap_or(shown_at),
            shown: shown_at,
        };
        (v, times)
    }

    /// Like [`View::start`] with the app's window root: [`Projects`] (open projects, one nvim
    /// each), and the app's [`Launcher`]: projects opened later start their nvim like the first
    /// (same state dir: sessions, recent projects), their events wake the waits too.
    pub fn start_projects(project: &str, files: &[&str]) -> View {
        Self::start_projects_with(project, files, Opening::New, false, None)
    }

    /// [`View::start_projects`] with the Chat column as the app starts it (shown in a window 900 px
    /// or wider); the other projects windows start with it hidden, as 1.0's, so tests of the
    /// rest keep their room.
    pub fn start_projects_app_column(project: &str, files: &[&str]) -> View {
        Self::start_projects_with(project, files, Opening::New, true, None)
    }

    /// [`View::start_projects`] reopening `set` (a launch without a path): the first nvim runs
    /// `set.active`, the others start when first shown.
    pub fn start_projects_restored(set: SavedSet) -> View {
        let active = set.active.clone().unwrap();
        Self::start_projects_with(
            active.to_str().unwrap(),
            &[],
            Opening::Restore(set),
            false,
            None,
        )
    }

    /// [`View::start_projects_restored`] with `setup` run on the app before the window opens,
    /// given the state home the app's nvims get (`XDG_STATE_HOME`): files the restore reads
    /// (`hidden-workspaces.json`), globals it reads (an `abe` bridge).
    pub fn start_projects_restored_with(
        set: SavedSet,
        setup: impl FnOnce(&mut gpui_kit::App, &std::path::Path) + 'static,
    ) -> View {
        let active = set.active.clone().unwrap();
        Self::start_projects_with(
            active.to_str().unwrap(),
            &[],
            Opening::Restore(set),
            false,
            Some(Box::new(setup)),
        )
    }

    /// [`View::start_projects`] as a launch with the path `project` (beside the saved set, if
    /// any), with `setup` as [`View::start_projects_restored_with`]'s.
    pub fn start_projects_launched_with(
        project: &str,
        setup: impl FnOnce(&mut gpui_kit::App, &std::path::Path) + 'static,
    ) -> View {
        Self::start_projects_with(
            project,
            &[],
            Opening::Launched,
            false,
            Some(Box::new(setup)),
        )
    }

    fn start_projects_with(
        project: &str,
        files: &[&str],
        opening: Opening,
        app_column: bool,
        setup: Option<Setup>,
    ) -> View {
        let (cfg, state) = nvim_config(project, files);
        let events: Arc<(Mutex<u64>, Condvar)> = Arc::default();
        let bump = {
            let events = events.clone();
            move || {
                let (n, cv) = &*events;
                *n.lock() += 1;
                cv.notify_all();
            }
        };
        let (tx, rx) = mpsc::unbounded();
        let b2 = bump.clone();
        let nvim = Nvim::start(&cfg, move |ev: NvimEvent| {
            let _ = tx.unbounded_send(ev);
            b2();
        })
        .unwrap();
        let rpc = nvim.rpc.clone();
        let mut template = cfg.clone();
        template.args.retain(|a| !files.contains(&a.as_str()));
        let nvims = OpenNvims::default();
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        app.update(|cx| {
            cx.set_global(Launcher {
                template,
                nvims,
                on_event: Some(Arc::new(move |_| bump())),
                on_open: None,
            })
        });
        if !app_column {
            app.update(|cx| cx.set_global(vimstorm::shell::ColumnState::default()));
        }
        if let Some(setup) = setup {
            let home = state.path().join("state");
            app.update(|cx| setup(cx, &home));
        }
        let dir = cfg.project.clone();
        let window =
            app.open_window(
                size(px(WINDOW.0), px(WINDOW.1)),
                move |window, cx| match opening {
                    Opening::Restore(set) => Projects::restore(nvim, rx, set, window, cx),
                    Opening::New => Projects::new(nvim, rx, dir, window, cx),
                    Opening::Launched => Projects::launched(nvim, rx, dir, window, cx),
                },
            );
        let projects = window.root(&mut app).unwrap();
        let ws = projects.read_with(&app, |p, _| {
            p.active().cloned().expect("the shown project runs")
        });
        let view = ws.read_with(&app, |ws, _| ws.editor().clone());
        let mut cx = VisualTestContext::from_window(window.into(), &app);
        cx.update(|window, _| window.activate_window());
        let mut v = View {
            cx,
            view,
            ws,
            projects: Some(projects),
            rpc,
            events,
            redraws: Arc::default(),
            _state: state,
        };
        v.wait_started();
        v
    }

    /// Points the view's helpers (`ws`, `view`, `lua` ...) at another open project's workspace
    /// ([`View::start_projects`]).
    pub fn use_project(&mut self, ws: &Entity<Workspace>) {
        self.ws = ws.clone();
        self.view = ws.read_with(&self.cx, |ws, _| ws.editor().clone());
        self.rpc = ws.read_with(&self.cx, |ws, _| ws.rpc().clone());
    }

    /// The shown project's workspace ([`View::start_projects`]).
    pub fn active_project(&mut self) -> Entity<Workspace> {
        self.pump();
        let p = self.projects.clone().expect("started with start_projects");
        p.read_with(&self.cx, |p, _| {
            p.active().cloned().expect("the shown project runs")
        })
    }

    /// The state dir the view's nvims use (sessions, the open projects set).
    pub fn state_home(&self) -> std::path::PathBuf {
        self._state.path().join("state")
    }

    /// Waits until the first project's config is up and the screen is quiet.
    fn wait_started(&mut self) {
        let v = self;
        v.wait_lua("nvim started (VimEnter + VeryLazy)", STARTED);
        v.wait_for("first frame", |v| v.ui().flushes > 0);
        v.wait_for("Lua told the window kinds", |v| !v.kinds().is_empty());
        v.settle();
    }

    /// Sets the Feel as the bridge would: VimStorm's with `f`'s changes.
    pub fn set_feel(&mut self, f: impl FnOnce(&mut vimstorm::factory::Feel)) {
        let mut feel = vimstorm::factory::Feel::default();
        f(&mut feel);
        self.cx.update(|_, cx| cx.set_global(feel));
        self.pump();
    }

    /// Runs what's ready on the UI thread (applies nvim's redraws, draws).
    pub fn pump(&mut self) {
        self.cx.run_until_parked();
    }

    pub fn read<R>(&mut self, f: impl FnOnce(&EditorView) -> R) -> R {
        self.pump();
        self.view.read_with(&self.cx, |v, _| f(v))
    }

    pub fn read_ws<R>(&mut self, f: impl FnOnce(&Workspace, &gpui_kit::App) -> R) -> R {
        self.pump();
        self.ws.read_with(&self.cx, f)
    }

    pub fn ui<R>(&mut self, f: impl FnOnce(&UiState) -> R) -> R {
        self.read(|v| f(v.ui()))
    }

    pub fn screen(&mut self) -> Vec<String> {
        self.ui(|ui| ui.screen_lines())
    }

    /// When the reader thread handed over (before the UI thread got it) the first flushed batch
    /// since `after` that moved a window's top line to `topline`. [`View::start`] /
    /// [`View::start_timed`] only.
    pub fn redraw_read(&self, after: Instant, topline: i64) -> Option<Instant> {
        self.redraws
            .lock()
            .iter()
            .find(|(at, tops)| *at >= after && tops.contains(&topline))
            .map(|(at, _)| *at)
    }

    /// Blocks until nvim sent something after `seen` (or 50 ms passed).
    fn wait_event(&self, seen: u64) {
        let (n, cv) = &*self.events;
        let mut n = n.lock();
        if *n == seen {
            let _ = cv.wait_for(&mut n, Duration::from_millis(50));
        }
    }

    /// Waits until `pred` holds on the view (checked after every nvim event).
    pub fn wait_for(&mut self, label: &str, pred: impl Fn(&EditorView) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let seen = *self.events.0.lock();
            if self.read(&pred) {
                return;
            }
            if Instant::now() > deadline {
                let screen = self.screen().join("\n");
                panic!("timed out waiting for: {label}\n--- screen ---\n{screen}");
            }
            self.wait_event(seen);
        }
    }

    /// Waits until `pred` holds (anything reachable from the view: the workspace's surfaces),
    /// checked after every nvim event.
    pub fn wait_until(&mut self, label: &str, mut pred: impl FnMut(&mut View) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let seen = *self.events.0.lock();
            self.pump();
            if pred(self) {
                return;
            }
            if Instant::now() > deadline {
                let screen = self.screen().join("\n");
                panic!("timed out waiting for: {label}\n--- screen ---\n{screen}");
            }
            self.wait_event(seen);
        }
    }

    pub fn wait_screen(&mut self, text: &str) {
        self.wait_for(&format!("screen shows {text:?}"), |v| {
            v.ui().screen_lines().iter().any(|l| l.contains(text))
        });
    }

    /// Waits until nvim has been quiet for 100 ms (at most 2 s).
    pub fn settle(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut last = (*self.events.0.lock(), Instant::now());
        while Instant::now() < deadline {
            self.pump();
            let n = *self.events.0.lock();
            if n != last.0 {
                last = (n, Instant::now());
            } else if last.1.elapsed() >= Duration::from_millis(100) {
                return;
            }
            self.wait_event(n);
        }
    }

    pub fn request(&self, method: &str, args: Vec<Value>) -> Value {
        self.rpc.request_blocking(method, args, TIMEOUT).unwrap()
    }

    /// nvim's `nvim_error_event`s so far (notifications it rejected, e.g. a grid resize for a
    /// closed window), after a round trip: the ones for everything sent until now are in.
    pub fn nvim_errors(&self) -> Vec<String> {
        self.lua("return true");
        self.view.read_with(&self.cx, |v, _| v.rpc().error_events())
    }

    /// `nvim_exec_lua` (the code must `return` its result).
    pub fn lua(&self, code: &str) -> Value {
        self.request("nvim_exec_lua", vec![code.into(), Value::Array(vec![])])
    }

    /// Polls a Lua condition, re-checked after every nvim event (or 50 ms). Returns with what nvim
    /// sent before its answer applied too: Lua's state is ahead of the surfaces until its bridge
    /// messages are (`focus.target()` says "diff" before the editor has the keyboard back; keys
    /// sent then went to the surface still focused).
    pub fn wait_lua(&mut self, label: &str, code: &str) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let seen = *self.events.0.lock();
            self.pump();
            if self.lua(code).as_bool() == Some(true) {
                self.pump();
                return;
            }
            if Instant::now() > deadline {
                let screen = self.screen().join("\n");
                panic!("timed out waiting for: {label}\n--- screen ---\n{screen}");
            }
            self.wait_event(seen);
        }
    }

    /// `nvim_get_mode().mode`.
    pub fn mode(&self) -> String {
        let m = self.request("nvim_get_mode", vec![]);
        map_get(&m, "mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    }

    pub fn current_line(&self) -> String {
        self.lua("return vim.api.nvim_get_current_line()")
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    /// Where the element with this debug selector is drawn, if it is.
    pub fn found(&mut self, selector: &str) -> Option<gpui_kit::Bounds<Pixels>> {
        self.cx.run_until_parked();
        self.cx.debug_bounds(selector.to_owned().leak())
    }

    /// Where the element with this debug selector is drawn; fails when it is not.
    pub fn bounds(&mut self, selector: &str) -> gpui_kit::Bounds<Pixels> {
        self.found(selector)
            .unwrap_or_else(|| panic!("{selector} not drawn"))
    }

    /// Whether an element with this debug selector is drawn.
    pub fn drawn(&mut self, selector: &str) -> bool {
        self.found(selector).is_some()
    }

    /// The keyboard back to the code, as Esc in a tool window (1.0's ⌘2 Focus editor; ⌘2 is now
    /// the Chat column's).
    pub fn focus_code(&mut self) {
        let ws = match self.projects.clone() {
            Some(p) => p.read_with(&self.cx, |p, _| p.active().cloned()),
            None => Some(self.ws.clone()),
        };
        if let Some(ws) = ws {
            let rpc = ws.read_with(&self.cx, |ws, _| ws.rpc().clone());
            vimstorm::nvim::lua::call(&rpc, "config.focus", "editor", Vec::new());
            // (Lua knows the editor has the keyboard: keys typed next act there)
            let code = "return require('config.app').native() == nil";
            self.wait_until("the keyboard back to the code", |v| {
                v.pump();
                rpc.request_blocking(
                    "nvim_exec_lua",
                    vec![code.into(), Value::Array(vec![])],
                    TIMEOUT,
                )
                .ok()
                .and_then(|r| r.as_bool())
                    == Some(true)
            });
            // (the focus moves nvim's current window too: its blur / focus answers settle)
            self.settle();
        }
        self.pump();
    }

    /// GPUI keystrokes ("cmd-s escape"), dispatched as the window does: a key the view lets
    /// propagate is typed through its IME handler.
    pub fn keystrokes(&mut self, keys: &str) {
        self.cx.simulate_keystrokes(keys);
    }

    /// A key as GPUI's macOS backend reports it on the Swedish layout, e.g. `shift+digit_1`,
    /// `å`, `super+shift+z` (see `vimstorm::editor::input`).
    pub fn key(&mut self, trigger: &str) {
        let ks = input::keystroke(trigger).unwrap_or_else(|| panic!("no key {trigger}"));
        self.cx
            .update(|window, cx| window.dispatch_keystroke(ks, cx));
        self.pump();
    }

    pub fn modifiers(&mut self, m: Modifiers) {
        self.cx.simulate_modifiers_change(m);
    }

    /// AppKit's input context committing text (insertText).
    pub fn ime_commit(&mut self, text: &str) {
        let mut h = self.read(|v| v.ime_handler());
        self.cx
            .update(|window, cx| h.replace_text_in_range(None, text, window, cx));
        self.pump();
    }

    /// AppKit's input context setting marked text (setMarkedText: a dead key, a composition).
    pub fn ime_mark(&mut self, text: &str) {
        let mut h = self.read(|v| v.ime_handler());
        let end = text.encode_utf16().count();
        self.cx.update(|window, cx| {
            h.replace_and_mark_text_in_range(None, text, Some(end..end), window, cx)
        });
        self.pump();
    }

    /// Center of cell (row, col) of nvim's composed (logical) screen, where its grid is drawn
    /// (window coordinates).
    pub fn cell_pos(&mut self, row: usize, col: usize) -> Point<Pixels> {
        self.read(|v| v.screen_cell_center(row, col))
            .unwrap_or_else(|| panic!("screen cell ({row}, {col}) isn't on a grid"))
    }

    /// Center of cell (row, col) of a grid (window coordinates).
    pub fn grid_pos(&mut self, grid: u64, row: usize, col: usize) -> Point<Pixels> {
        self.read(|v| {
            v.geometry()
                .cell_to_px(grid, row as f64 + 0.5, col as f64 + 0.5)
                .unwrap_or_else(|| panic!("grid {grid} isn't placed"))
        })
    }

    pub fn click(&mut self, button: MouseButton, at: Point<Pixels>) {
        self.cx
            .simulate_mouse_down(at, button, Modifiers::default());
        self.cx.simulate_event(MouseUpEvent {
            position: at,
            modifiers: Modifiers::default(),
            button,
            click_count: 1,
        });
    }

    /// The left button pressed on `from`, dragged to `to` once nvim took the press (`pressed`:
    /// a Lua condition, e.g. `vim.fn.getmousepos()` on a separator), let go there.
    pub fn drag(&mut self, from: Point<Pixels>, to: Point<Pixels>, pressed: &str) {
        self.cx
            .simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
        self.wait_lua("nvim took the press", pressed);
        self.cx
            .simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
        self.cx
            .simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    }

    /// A click on the rail's `place` tile (`board`, `boxes`, `pipelines`): the way to Boxes and
    /// Pipelines, never on ⌘↑ / ⌘↓'s.
    pub fn click_place(&mut self, place: &str) {
        let at = self.bounds(&format!("rail-{place}")).center();
        self.click(MouseButton::Left, at);
    }

    pub fn scroll(&mut self, at: Point<Pixels>, delta: ScrollDelta, phase: TouchPhase) {
        self.cx.simulate_event(ScrollWheelEvent {
            position: at,
            delta,
            modifiers: Modifiers::default(),
            touch_phase: phase,
        });
    }

    /// Advances GPUI's test clock (timers: the scroll settle animation).
    pub fn advance(&mut self, by: Duration) {
        self.cx.executor().advance_clock(by);
        self.pump();
    }

    /// Screen cell (row, col) where `text` first starts.
    pub fn cell_of(&mut self, text: &str) -> (usize, usize) {
        let screen = self.screen();
        screen
            .iter()
            .enumerate()
            .find_map(|(row, l)| Some((row, l[..l.find(text)?].chars().count())))
            .unwrap_or_else(|| panic!("{text:?} not on screen\n{}", screen.join("\n")))
    }
}

impl Drop for View {
    fn drop(&mut self) {
        self.view.update(&mut self.cx, |v, _| v.nvim_mut().kill());
        // every open project's nvim
        if let Some(p) = &self.projects {
            for ws in p.read_with(&self.cx, |p, _| p.workspaces()) {
                ws.update(&mut self.cx, |ws, cx| {
                    ws.editor().update(cx, |e, _| e.nvim_mut().kill())
                });
            }
        }
    }
}
