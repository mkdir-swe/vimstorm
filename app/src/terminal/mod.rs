//! The native terminal tool window: [`TerminalView`], the workspace's shells
//! in tabs, drawn over ONE placeholder nvim window in the bottom tool window
//! (`config/app/terminal.lua`, role `"terminal"`, [`crate::shell::Role::Terminal`]):
//! the bottom pane's Terminal, sharing the bottom with the pane's lists and Git (one height,
//! opening one hides the others). Keyboard: [`HostedFocus`] (the bottom pane's host pattern: the
//! view has the keyboard while its host is nvim's current window). The Chat column is the AI
//! chat only; shells never open there.
//!
//! Entry: [`open`] (the stripe's Terminal, ⌘T, the bridge's `terminal-tab`).
//!
//! # Lua (`config/app/terminal.lua`, the whole Lua side)
//!
//! Lua keeps what other Lua asks synchronously: the host window (opened / sized / hidden through
//! `config/bottom.lua`), focus (`focus.lua` register: is_focused / owns / close / cycle) and the
//! session (`layout()`: the tabs' folders from the shell pids Rust reports, read by Lua's
//! `shell_cwds`). Rust owns the PTYs ([`pty`]: alacritty_terminal, parsing off the UI thread),
//! tabs, drawing ([`element`]), keys ([`keys`]), selection / copy, find, scrollback, mouse
//! reporting and the lazygit float.
//!
//! Bridge `vimstorm.terminal`: `open {enter, show, root, cwd, env, tabs, cur}` (the host window
//! opened or asked for again: a first tab in `cwd` when there's none, or the session's tabs;
//! `show: false` starts the session's shells with the pane hidden), `new {cwd}`, `hide` (the host
//! window closed), `focus` / `blur` (the host became / stopped being nvim's current window),
//! `close` (the current tab), `cycle {dir}` (⌥⌘← ⌥⌘→), `find`, `send`, `lazygit {cmd, cwd, env}`. Rust -> Lua
//! (`config.app.terminal`): `tabs(pids, cur, has_tabs)` on every change (session, busy count),
//! `enter()` (a click into the view), `hide()` (the last tab went, the header's Hide, menu Hide),
//! `float(open)` (the lazygit float is up: `focus.target()` says "popup" while it has the
//! keyboard), `toggle()` / `show()` / `activate()` / `open_quietly()` ([`open`]).
//!
//! # Behaviour (the M4 Lua terminal (git history), WebStorm's reworked terminal)
//!
//! Header "Terminal Git Problems │ Local ×  Local (2) ×  +  ⌄ … ⋮ ⤢ −" (Code's panel's tabs first) (`ui::tool_tabs`): names "Local", "Local
//! (N)" with the lowest free number, kept when others close; × / middle-click close; + new; ⌄ / ⋮
//! / right-click: the terminal menu; − hides. A shell's exit (`exit`, Ctrl+D) closes its tab, the
//! last one the tool window. Typing goes to the shell (every key it needs; Cmd combos it doesn't
//! use reach nvim's global shortcuts). Mouse: a click types on, a drag selects from the press
//! point, double-click a word (WS word chars), triple-click a line; Cmd+C copies (wrapped rows
//! joined, no trailing newline), Esc clears, Cmd+V pastes (bracketed) also over a selection.
//! Wheel / trackpad scroll the scrollback smoothly into the scroll view (↑ / ↓ a line, Shift+↑ /
//! Shift+↓ half a page; typing goes back to the prompt); TUIs that ask get mouse reports (SGR /
//! normal) and the wheel (alternate screen: arrow keys). Cmd+F: the find bar ([`find`]).

mod element;
mod find;
mod float;
mod input;

mod colors;
mod keys;
mod pty;
mod text;

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use alacritty_terminal::grid::Scroll;
use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui_kit::{
    App, AppContext as _, Bounds, ClipboardItem, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    Point, Render, Styled as _, Task, Window, div, prelude::FluentBuilder as _, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::{ToolAction, ToolActionEvent, ToolTab, ToolTabs, ToolTabsEvent};
use crate::look;
use crate::nvim::lua;
use crate::popups::{self, Menu, MenuEntry, MenuItem};
use crate::render::CellMetrics;
use crate::render::{editor_font_size, scaled};
use crate::shell::{HostedFocus, Surface, SurfaceCx};

pub use colors::{BUILT_IN, Palette, palette, set as set_palette};
pub use element::{GridLayout, PAD_BOTTOM, PAD_LEFT, PAD_TOP, Shared, TermElement, TermHost};
pub(crate) use keys::encode_in;
pub use keys::paste;
pub(crate) use pty::{Pty, PtyEvent, Spawn};
pub use text::{live_lines, screen_lines};

/// Terminal rows: JetBrains Mono 13 at WS's terminal line spacing 1.0 (ascent 14 + descent 4 px,
/// IntelliJ rounds each up; the editor's 22 px is that × 1.2).
pub const ROW_HEIGHT: f32 = 18.;

/// Its Lua module (`config/app/terminal.lua`).
const LUA: &str = "config.app.terminal";

/// One tab: a shell and its tab number ("Local (N)").
struct Tab {
    pty: Arc<Pty>,
    num: u32,
    /// The shell's OSC 0 / 2 title (WS `updateTabNameOnTitleChange`, on by default).
    title: Option<String>,
}

impl Tab {
    fn pty_id(&self) -> u64 {
        self.pty.id
    }

    fn name(&self) -> String {
        match &self.title {
            Some(t) => trim_middle(t, TITLE_MAX_CHARS),
            None => tab_name(self.num),
        }
    }
}

/// A shell title longer than this is cut in the middle (WS: StringUtil.trimMiddle, ~30).
const TITLE_MAX_CHARS: usize = 30;
/// At most one system beep per this (a flood of BELs is one beep).
const BELL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// `text` cut to `max` chars with "…" in the middle.
fn trim_middle(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_owned();
    }
    let head = (max - 1).div_ceil(2);
    let tail = max - 1 - head;
    let mut out: String = text.chars().take(head).collect();
    out.push('…');
    out.extend(text.chars().skip(n - tail));
    out
}

/// The system beep (WS "Audible bell", default on).
fn beep() {
    // AppKit's `void NSBeep(void)`; the app links AppKit already (GPUI's mac platform).
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        fn NSBeep();
    }
    // SAFETY: NSBeep takes no arguments, has no preconditions and is safe from the main thread.
    unsafe { NSBeep() }
}

/// WS's tab names: "Local", "Local (2)", ...
/// A tab's environment: `env` with the terminal's own variables over it.
fn tab_env(mut env: HashMap<String, String>) -> HashMap<String, String> {
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    // no macOS "Restored session" line; `nvim` typed here is the user's own
    env.insert("SHELL_SESSIONS_DISABLE".into(), "1".into());
    env.insert("NVIM_APPNAME".into(), "nvim".into());
    env
}

pub fn tab_name(num: u32) -> String {
    if num == 1 {
        "Local".into()
    } else {
        format!("Local ({num})")
    }
}

/// How [`open`] brings the Terminal up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Open {
    /// The stripe's Terminal: shown with the keyboard; again while it has the keyboard hides it.
    Toggle,
    /// Shown with the keyboard, never hidden (the bridge's `terminal-tab`, the switcher).
    Focus,
    /// Shown, the keyboard where it is.
    Quiet,
}

/// The one way in to the bottom pane's Terminal (the stripe's Terminal item, the
/// bridge's `terminal-tab`): through its Lua module, which opens the host window in the bottom
/// tool window (the shells' env and folder are nvim's).
pub fn open(rpc: &crate::nvim::Rpc, how: Open) {
    let f = match how {
        Open::Toggle => "toggle",
        Open::Focus => "show",
        Open::Quiet => "open_quietly",
    };
    lua::call(rpc, LUA, f, vec![]);
}

/// `vimstorm.terminal` (config/app/terminal.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum TermEvent {
    /// Opened / asked for again: a first tab (in `cwd`) when there's none, or the session's
    /// `tabs` (folders; `cur` 1-based).
    Open {
        #[serde(default = "yes")]
        enter: bool,
        /// The host window is open (false: the session's shells start, the pane stays hidden).
        #[serde(default = "yes")]
        show: bool,
        /// nvim's cwd: new tabs start there.
        #[serde(default)]
        root: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        tabs: Option<Vec<String>>,
        #[serde(default)]
        cur: Option<usize>,
    },
    /// Cmd+Shift+T / + / Open in Terminal.
    New {
        #[serde(default)]
        cwd: Option<String>,
    },
    Hide,
    Focus,
    Blur,
    /// Close Tab (its menu, the Lua menu items): the current tab.
    Close,
    Cycle {
        #[serde(default = "one")]
        dir: i64,
    },
    /// Find from Lua (`query`: typed into the field; scripts, screenshots).
    Find {
        #[serde(default)]
        query: Option<String>,
    },
    /// Text typed into the shown tab's shell (Lua `send`: scripts, screenshots).
    Send {
        text: String,
    },
    /// Text for the lazygit float's program (its nvim-remote edit's `q`).
    FloatSend {
        text: String,
    },
    /// `,G`: lazygit in the float.
    Lazygit {
        cmd: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Option<HashMap<String, String>>,
        /// Escape sequences for the float's terminal first (snacks' OSC 4 palette entry).
        #[serde(default)]
        osc: Option<String>,
    },
}

fn yes() -> bool {
    true
}

fn one() -> i64 {
    1
}

/// A press in the grid that may become a drag selection.
#[derive(Clone, Copy, Debug)]
struct Press {
    point: alacritty_terminal::index::Point,
    side: alacritty_terminal::index::Side,
    /// It moved to another cell: a selection is being dragged.
    dragged: bool,
}

pub struct TerminalView {
    scx: SurfaceCx,
    /// The view's keyboard ([`HostedFocus::handle`]).
    focus: FocusHandle,
    /// The host window's keyboard bookkeeping (open / current / focus / blur).
    hosted: HostedFocus,
    tabs: Vec<Tab>,
    cur: usize,
    next_id: u64,
    tx: UnboundedSender<PtyEvent>,
    header: Entity<ToolTabs>,
    shared: Rc<Shared>,
    metrics: Option<CellMetrics>,
    /// Scrolled back by the wheel / keys: ↑ / ↓ scroll instead of going to the shell.
    scroll_view: bool,
    /// Smooth scrolling's sub-row offset (px, content drawn lower).
    scroll_px: f32,
    press: Option<Press>,
    /// A Ctrl+\\ waiting for a Ctrl+N (its timer sends it to the shell otherwise).
    ctrl_bslash: Option<Task<()>>,
    /// Trackpad pixels toward the next wheel step for a TUI (mouse reports / arrows).
    wheel_px: f32,
    /// `VIMSTORM_TIMING`: when the last typed key went to the shell (key -> echo -> frame).
    key_at: Option<std::time::Instant>,
    /// A button pressed in a TUI that gets mouse reports (its release goes there too).
    reported: Option<keys::MouseButton>,
    find: Option<find::Find>,
    last_find: find::LastFind,
    preedit: Option<String>,
    float: Option<float::Float>,
    /// The view's bounds as last painted (tests: the maximized column covers the body).
    view_bounds: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    /// Env for new shells (Lua: the user's XDG_CONFIG_HOME, NVIM).
    env: HashMap<String, String>,
    /// Project root (nvim's cwd) for new tabs.
    cwd: PathBuf,
    bells: u64,
    last_bell: Option<std::time::Instant>,
    output_redraws: u64,
    /// Keys typed right after a global shortcut, waiting for nvim's answer.
    hold: Option<input::Hold>,
    _tasks: Vec<Task<()>>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl TerminalView {
    /// The window asks nvim to show it with the keys ([`HostedFocus::asked`]).
    pub fn keys_asked(&mut self, cx: &App) {
        self.hosted.asked(cx);
    }

    /// The host window is open (or the lazygit float is up: mounted for it).
    pub fn is_open(&self) -> bool {
        self.hosted.is_open() || self.float.is_some()
    }

    /// The bottom pane shows it (its host window is open).
    pub fn shown(&self) -> bool {
        self.hosted.is_open()
    }

    /// The keyboard bookkeeping of the host window (open / current / focus / blur).
    pub fn hosted(&self) -> &HostedFocus {
        &self.hosted
    }

    /// The view's keyboard (the find field is inside it).
    pub fn keyboard(&self) -> &FocusHandle {
        &self.focus
    }

    /// The tabs are drawn: the host window is open and the project shown.
    fn on_screen(&self) -> bool {
        self.hosted.is_open() && self.scx.active()
    }

    /// Closes every shell (the window switched to another project and the old nvim saved its
    /// session): the tabs' and the float's PTYs hang up.
    pub fn shut_down(&mut self, cx: &mut Context<Self>) {
        self.tabs.clear();
        self.float = None;
        self.find = None;
        cx.notify();
    }

    /// Tab names in order.
    pub fn tab_names(&self) -> Vec<String> {
        self.tabs.iter().map(Tab::name).collect()
    }

    /// BELs that beeped (tests; the beep itself is skipped in test contexts).
    pub fn bells(&self) -> u64 {
        self.bells
    }

    /// Output wakeups that redrew the view (tests: a hidden terminal doesn't).
    pub fn output_redraws(&self) -> u64 {
        self.output_redraws
    }

    /// The shown tab (index).
    pub fn current(&self) -> usize {
        self.cur
    }

    /// Shell pids of the tabs in order.
    pub fn pids(&self) -> Vec<u32> {
        self.tabs.iter().map(|t| t.pty.pid).collect()
    }

    /// The shown tab's rows on screen (tests), trailing blanks trimmed.
    pub fn screen(&self) -> Vec<String> {
        self.pty()
            .map(|p| text::screen_lines(&*p.term.lock()))
            .unwrap_or_default()
    }

    /// Every row of the shown tab, scrollback first (tests).
    pub fn all_lines(&self) -> Vec<String> {
        self.pty()
            .map(|p| text::all_lines(&*p.term.lock()))
            .unwrap_or_default()
    }

    /// Rows scrolled back from the bottom.
    pub fn display_offset(&self) -> usize {
        self.pty()
            .map(|p| p.term.lock().grid().display_offset())
            .unwrap_or(0)
    }

    /// The scroll view is on (↑ / ↓ scroll the output).
    pub fn in_scroll_view(&self) -> bool {
        self.scroll_view
    }

    /// The shown tab's grid size (cols, rows).
    pub fn grid_size(&self) -> Option<(u16, u16)> {
        self.pty().map(|p| p.size())
    }

    /// The selection's text, if something is selected.
    pub fn selection(&self) -> Option<String> {
        self.pty()
            .and_then(|p| text::selection_text(&*p.term.lock()))
    }

    /// Where the view itself (header + body) was last drawn (window coordinates).
    pub fn view_bounds(&self) -> Option<Bounds<Pixels>> {
        self.view_bounds.get()
    }

    /// Where the grid was last drawn (window coordinates).
    pub fn grid_layout(&self) -> Option<GridLayout> {
        self.shared.layout.get()
    }

    /// Prepaint time of the last frame's grid (perf).
    pub fn last_build(&self) -> Option<std::time::Duration> {
        self.shared.last_build.get()
    }

    /// The header (tests click its tabs / actions).
    pub fn header(&self) -> &Entity<ToolTabs> {
        &self.header
    }

    /// The shown tab's shell is in the alternate screen (a TUI).
    pub fn alt_screen(&self) -> bool {
        self.pty().is_some_and(|p| {
            p.term
                .lock()
                .mode()
                .contains(alacritty_terminal::term::TermMode::ALT_SCREEN)
        })
    }

    /// Window position (cell center) of the first cell showing `needle` on screen (tests).
    pub fn cell_of(&self, needle: &str) -> Option<Point<Pixels>> {
        let layout = self.grid_layout()?;
        let screen = self.screen();
        let (row, col) = screen.iter().enumerate().find_map(|(r, l)| {
            let i = l.find(needle)?;
            Some((r, l[..i].chars().count()))
        })?;
        Some(cell_center(&layout, row, col))
    }

    /// The PTY on screen: the shown tab's shell.
    fn pty(&self) -> Option<&Arc<Pty>> {
        self.tabs.get(self.cur).map(|t| &t.pty)
    }

    /// The PTY keys / pastes go to: the lazygit float's while it has the keyboard, else the tab's.
    fn active_pty(&self, window: &Window, cx: &App) -> Option<Arc<Pty>> {
        if let Some(f) = &self.float
            && f.focus.contains_focused(window, cx)
        {
            return Some(f.pty.clone());
        }
        self.pty().cloned()
    }

    /// The terminal's cells at the editor font size (`app_menu` font size keys zoom the terminal
    /// too, as they zoomed Ghostty); measured again when that size changed.
    fn metrics(&mut self, window: &Window, cx: &App) -> CellMetrics {
        let size = editor_font_size(cx);
        match self.metrics {
            Some(m) if m.is_current(size) => m,
            _ => *self.metrics.insert(CellMetrics {
                row_height: px(scaled(ROW_HEIGHT, size)),
                ..CellMetrics::measure(window, size)
            }),
        }
    }

    fn spawn_spec(
        &self,
        program: Option<(String, Vec<String>)>,
        cwd: Option<String>,
        env: &HashMap<String, String>,
        size: (u16, u16),
        metrics: CellMetrics,
    ) -> Spawn {
        let env = tab_env(env.clone());
        // a cloud workspace's: its shell, a program through its exec prefix in its folder;
        // the attach runs here from the home folder (the box's folder is no folder here)
        if let Some((root, a)) = crate::shell::remote::attach_for(&self.scx.project) {
            let mut argv = match program {
                Some((program, args)) => {
                    let mut argv = a.exec.clone();
                    argv.extend(["env".into(), "-C".into(), root.display().to_string()]);
                    argv.push(program);
                    argv.extend(args);
                    argv
                }
                None => a.shell.clone(),
            };
            let program = if argv.is_empty() {
                "/bin/sh".to_owned()
            } else {
                argv.remove(0)
            };
            return Spawn {
                program,
                args: argv,
                cwd: crate::shell::home(),
                env,
                cols: size.0,
                rows: size.1,
                cell_width: metrics.cell_width.as_f32().round() as u16,
                cell_height: metrics.row_height.as_f32().round() as u16,
            };
        }
        let cwd = cwd
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| self.cwd.clone());
        // a login shell like Ghostty's / the Lua terminal's, so ~/.zprofile loads
        let (program, args) = program.unwrap_or_else(|| {
            (
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()),
                vec!["-l".into()],
            )
        });
        Spawn {
            program,
            args,
            cwd,
            env,
            cols: size.0,
            rows: size.1,
            cell_width: metrics.cell_width.as_f32().round() as u16,
            cell_height: metrics.row_height.as_f32().round() as u16,
        }
    }

    /// The lowest tab number no tab uses.
    fn free_num(&self) -> u32 {
        let mut n = 1;
        while self.tabs.iter().any(|t| t.num == n) {
            n += 1;
        }
        n
    }

    /// A new tab in the workspace's folder, shown, with the keyboard
    /// (⌘T in a terminal with the keyboard; the header's `+`).
    pub fn add_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.new_tab(None, window, cx);
        self.take_keyboard(window, cx);
    }

    /// A new tab, shown.
    fn new_tab(&mut self, cwd: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.spawn_tab(None, cwd, None, window, cx);
    }

    /// A tab of its own running `program` (the spec's drafting agent's transcript followed), named
    /// `title`, shown.
    pub fn run_tab(
        &mut self,
        program: String,
        args: Vec<String>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.spawn_tab(Some((program, args)), None, Some(title), window, cx);
        cx.notify();
    }

    /// A tab of its own running `argv` on this Mac (never through a cloud workspace's attach),
    /// through the login shell so its `PATH` is the user's, with `env` added, named `title`,
    /// shown (the bridge's `terminal-tab`: `abe box attach <box>`, `aws sso login`).
    pub fn run_local_tab(
        &mut self,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (cols, rows) = self.grid_cells();
        let metrics = self.metrics(window, cx);
        let mut vars = self.env.clone();
        vars.extend(env);
        let vars = tab_env(vars);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut args = vec!["-l".into(), "-c".into(), "exec \"$0\" \"$@\"".into()];
        args.extend(argv);
        let spec = Spawn {
            program: shell,
            args,
            cwd: crate::shell::home(),
            env: vars,
            cols,
            rows,
            cell_width: metrics.cell_width.as_f32().round() as u16,
            cell_height: metrics.row_height.as_f32().round() as u16,
        };
        self.push_tab(spec, Some(title), window, cx);
        cx.notify();
    }

    /// The grid's columns and rows as last laid out (80 × 24 before).
    fn grid_cells(&self) -> (u16, u16) {
        self.shared
            .layout
            .get()
            .map(|l| (l.cols as u16, l.rows as u16))
            .unwrap_or((80, 24))
    }

    fn spawn_tab(
        &mut self,
        program: Option<(String, Vec<String>)>,
        cwd: Option<String>,
        title: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let metrics = self.metrics(window, cx);
        let size = self.grid_cells();
        let spec = self.spawn_spec(program, cwd, &self.env, size, metrics);
        self.push_tab(spec, title, window, cx);
    }

    /// `spec` started as a new tab, shown.
    fn push_tab(
        &mut self,
        spec: Spawn,
        title: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        match Pty::spawn(id, spec, self.tx.clone()) {
            Ok(pty) => {
                let num = self.free_num();
                self.tabs.push(Tab {
                    pty: Arc::new(pty),
                    num,
                    title,
                });
                self.show(self.tabs.len() - 1, cx);
            }
            Err(e) => popups::notify(
                popups::Balloon::error("Terminal", format!("Can't start the shell: {e}")),
                window,
                cx,
            ),
        }
    }

    /// Shows tab `ix` (a click on it in the pane header).
    pub fn select_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.show(ix, cx);
    }

    /// Shows tab `ix`.
    fn show(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.tabs.len() {
            return;
        }
        if ix != self.cur {
            self.reset_view_state();
        }
        self.cur = ix;
        self.find_tab_changed(cx);
        self.report(cx);
        cx.notify();
    }

    /// Scroll / selection state belongs to the shown tab.
    fn reset_view_state(&mut self) {
        self.scroll_view = false;
        self.scroll_px = 0.;
        self.press = None;
        self.reported = None;
    }

    /// Reports the shells' pids (the session, the busy count), the current tab and whether
    /// there is a tab.
    fn report(&self, cx: &mut Context<Self>) {
        let pids: Vec<Value> = self.tabs.iter().map(|t| Value::from(t.pty.pid)).collect();
        self.scx.call(
            LUA,
            "tabs",
            vec![
                Value::Array(pids),
                Value::from((self.cur + 1) as u64),
                Value::Boolean(!self.tabs.is_empty()),
            ],
        );
        self.sync_header(cx);
    }

    /// Its tabs as the header shows them (closable).
    pub fn header_tabs(&self) -> Vec<ToolTab> {
        self.tabs
            .iter()
            .map(|t| ToolTab::new(t.name()).closable(true))
            .collect()
    }

    fn sync_header(&self, cx: &mut Context<Self>) {
        let tabs = self.header_tabs();
        let cur = self.cur;
        self.header.update(cx, |h, cx| {
            if h.tabs() != tabs.as_slice() {
                h.set_tabs(tabs, cx);
            }
            if h.selected() != cur {
                h.select(cur, cx);
            }
        });
    }

    /// Closes tab `ix` (its shell gets SIGHUP); the last one hides the tool window.
    fn close_tab(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.tabs.len() {
            return;
        }
        self.tabs.remove(ix);
        self.after_removed(ix, window, cx);
    }

    /// A tab went (closed / its shell exited): Lua's TermClose rules.
    fn after_removed(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.is_empty() {
            self.cur = 0;
            self.reset_view_state();
            self.close_find(false, window, cx);
            self.report(cx);
            // the last tab went: the tool window goes (WebStorm's)
            self.scx.call(LUA, "hide", vec![]);
            cx.notify();
            return;
        }
        if ix == self.cur {
            self.reset_view_state();
            self.cur = ix.min(self.tabs.len() - 1);
            self.find_tab_changed(cx);
        } else if ix < self.cur {
            self.cur -= 1;
        }
        self.report(cx);
        cx.notify();
    }

    /// Alt+Cmd+Left/Right: the tab `dir` away, wrapping.
    fn cycle(&mut self, dir: i64, cx: &mut Context<Self>) {
        let n = self.tabs.len() as i64;
        if n < 2 {
            return;
        }
        let ix = (self.cur as i64 + dir).rem_euclid(n) as usize;
        self.show(ix, cx);
    }

    /// A shell said something.
    fn on_pty(&mut self, ev: PtyEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            PtyEvent::Wakeup(id) => {
                if let Some(p) = self.tabs.iter().map(|t| &t.pty).find(|p| p.id == id) {
                    p.take_dirty();
                    // off screen (tool window hidden, project hidden) nothing redraws: the
                    // next frame that shows it paints the terminal's current state
                    if self.tabs[self.cur].pty_id() == id && self.on_screen() {
                        self.output_redraws += 1;
                        self.output_changed(window, cx);
                        if let Some(at) = self.key_at.take() {
                            let ms = at.elapsed().as_secs_f64() * 1000.;
                            crate::app::mark(&format!("terminal: key -> echo received {ms:.2} ms"));
                            window.on_next_frame(move |_, _| {
                                let ms = at.elapsed().as_secs_f64() * 1000.;
                                crate::app::mark(&format!(
                                    "terminal: key -> echo frame {ms:.2} ms"
                                ));
                            });
                        }
                        cx.notify();
                    }
                } else if let Some(f) = &self.float
                    && f.pty.id == id
                {
                    f.pty.take_dirty();
                    cx.notify();
                }
            }
            PtyEvent::Exit(id) => {
                if let Some(ix) = self.tabs.iter().position(|t| t.pty_id() == id) {
                    self.tabs.remove(ix);
                    self.after_removed(ix, window, cx);
                } else if self.float.as_ref().is_some_and(|f| f.pty.id == id) {
                    self.close_float(window, cx);
                }
            }
            PtyEvent::Clipboard(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            PtyEvent::Title(id, title) => {
                if let Some(t) = self.tabs.iter_mut().find(|t| t.pty_id() == id) {
                    let title = (!title.trim().is_empty()).then_some(title);
                    if t.title != title {
                        t.title = title;
                        self.sync_header(cx);
                        cx.notify();
                    }
                }
            }
            PtyEvent::Bell(_) => {
                let now = std::time::Instant::now();
                if self.last_bell.is_none_or(|t| now - t >= BELL_INTERVAL) {
                    self.last_bell = Some(now);
                    self.bells += 1;
                    if !cx.is_test() {
                        beep();
                    }
                }
            }
        }
    }

    /// The menu (right-click, ⌄, ⋮, Cmd+Enter): Lua's `items()`.
    fn open_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.menu_entries(cx);
        let view = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let Some(ix) = choice else { return };
                let _ = view.update(cx, |v, cx| v.menu_action(ix, window, cx));
            },
        );
    }

    /// The menu's row `label` as it would open now: enabled, and its right column (tests).
    pub fn menu_row(&self, label: &str, cx: &App) -> Option<(bool, Option<String>)> {
        self.menu_entries(cx).into_iter().find_map(|e| match e {
            MenuEntry::Item(i) if i.label.as_ref() == label => {
                Some((i.enabled, i.shortcut.map(|s| s.to_string())))
            }
            _ => None,
        })
    }

    fn menu_entries(&self, cx: &App) -> Vec<MenuEntry> {
        let has_sel = self.selection().is_some();
        let many = self.tabs.len() > 1;
        vec![
            MenuItem::new("Copy").shortcut("⌘C").enabled(has_sel).into(),
            MenuItem::new("Paste").shortcut("⌘V").into(),
            MenuItem::new("Find…").shortcut("⌘F").into(),
            MenuItem::new("Clear").into(),
            MenuEntry::Separator,
            MenuItem::new("New Tab").shortcut("⇧⌘T").into(),
            MenuItem::new("Close Tab").into(),
            MenuItem::new("Next Tab")
                .shortcut("⌥⌘→")
                .enabled(many)
                .into(),
            MenuItem::new("Previous Tab")
                .shortcut("⌥⌘←")
                .enabled(many)
                .into(),
            MenuEntry::Separator,
            MenuItem::new(crate::shell::projects::menu_title(&self.scx, cx))
                .shortcut("⌥⌘↩")
                .into(),
            MenuItem::new("Hide").into(),
        ]
    }

    fn menu_action(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        match ix {
            0 => self.copy(cx),
            1 => self.paste_clipboard(window, cx),
            2 => self.open_find(window, cx),
            3 => self.clear(cx),
            5 => self.new_tab(None, window, cx),
            6 => self.close_tab(self.cur, window, cx),
            7 => self.cycle(1, cx),
            8 => self.cycle(-1, cx),
            10 => crate::shell::projects::dispatch(window, cx),
            11 => self.scx.call(LUA, "hide", vec![]),
            _ => {}
        }
    }

    /// Menu Clear: WS empties the output (scrollback too); the shell redraws its prompt (Ctrl+L,
    /// what the Lua menu sent).
    fn clear(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = self.pty() {
            {
                let mut term = p.term.lock();
                term.grid_mut().clear_history();
                term.selection = None;
                term.scroll_display(Scroll::Bottom);
            }
            p.write(&b"\x0c"[..]);
        }
        self.reset_view_state();
        cx.notify();
    }

    /// Header: right-click on a tab shows it and opens the menu; on the blank, the menu.
    fn header_mouse_down(
        &mut self,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev.button {
            MouseButton::Right => {
                let hit = (0..self.tabs.len()).find(|ix| {
                    self.header
                        .read(cx)
                        .tab_bounds(*ix)
                        .is_some_and(|b| b.contains(&ev.position))
                });
                if let Some(ix) = hit {
                    self.show(ix, cx);
                }
                self.take_keyboard(window, cx);
                self.open_menu(Anchor::Point(ev.position), window, cx);
                cx.stop_propagation();
            }
            MouseButton::Left => {
                // a click on the bar keeps typing in the terminal
                self.take_keyboard(window, cx);
            }
            _ => {}
        }
    }

    /// The view (not the find field) takes the keyboard.
    fn take_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    fn on_tool_tabs(&mut self, ev: &ToolTabsEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            ToolTabsEvent::Select(ix) => {
                self.take_keyboard(window, cx);
                self.show(*ix, cx);
            }
            ToolTabsEvent::Close(ix) => {
                self.close_tab(*ix, window, cx);
                if !self.tabs.is_empty() {
                    self.take_keyboard(window, cx);
                }
            }
            ToolTabsEvent::ShowHidden(hidden, bounds) => {
                let entries = hidden
                    .iter()
                    .filter_map(|i| self.header.read(cx).tabs().get(*i))
                    .map(|t| MenuItem::new(t.label.clone()).into())
                    .collect();
                let hidden = hidden.clone();
                let view = cx.entity().downgrade();
                popups::open_menu(
                    Menu::new(entries, Anchor::Below(*bounds)),
                    window,
                    cx,
                    move |choice, _, cx| {
                        if let Some(ix) = choice.and_then(|c| hidden.get(c).copied()) {
                            let _ = view.update(cx, |v, cx| v.show(ix, cx));
                        }
                    },
                );
            }
        }
    }

    fn on_action(&mut self, ev: &ToolActionEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ToolActionEvent(id, bounds) = ev;
        match *id {
            "new" => self.add_tab(window, cx),
            "more" | "options" => {
                self.take_keyboard(window, cx);
                self.open_menu(Anchor::Below(*bounds), window, cx);
            }
            "maximize" => crate::shell::panel_maximize(&self.scx, cx),
            "hide" => self.scx.call(LUA, "hide", vec![]),
            _ => {}
        }
    }

    /// Where the header drew tab `ix` (window coordinates; tests click it).
    pub fn tab_bounds(&self, ix: usize, cx: &App) -> Option<Bounds<Pixels>> {
        self.header.read(cx).tab_bounds(ix)
    }

    /// Where the header drew an action ("new", "more", "options", "hide").
    pub fn action_bounds(&self, id: &str, cx: &App) -> Option<Bounds<Pixels>> {
        self.header.read(cx).action_bounds(id)
    }
}

/// Gives the executor back once (the next poll continues).
fn yield_now() -> impl std::future::Future<Output = ()> {
    let mut yielded = false;
    std::future::poll_fn(move |cx| {
        if yielded {
            std::task::Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            std::task::Poll::Pending
        }
    })
}

fn cell_center(layout: &GridLayout, row: usize, col: usize) -> Point<Pixels> {
    let o = layout.cell_origin(row, col);
    gpui_kit::point(
        o.x + layout.metrics.cell_width * 0.5,
        o.y + layout.metrics.row_height * 0.5,
    )
}

impl Surface for TerminalView {
    const NAME: &'static str = "terminal";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        let (tx, mut rx) = unbounded::<PtyEvent>();
        // every shell's events, drained in batches: one update per batch (frames coalesce)
        let pump = cx.spawn_in(window, async move |this, cx| {
            while let Some(first) = rx.next().await {
                let mut batch = vec![first];
                while let Ok(ev) = rx.try_recv() {
                    batch.push(ev);
                }
                let alive = this.update_in(cx, |v, window, cx| {
                    for ev in batch {
                        v.on_pty(ev, window, cx);
                    }
                });
                if alive.is_err() {
                    break;
                }
                // let frames and other work run between batches: a flood would otherwise keep
                // this task busy (each batch's notify re-arms the next wakeup)
                yield_now().await;
            }
        });
        // The header: Code's panel's tabs (Terminal boxed), the shells' tabs, +, then Options, ⤢
        // and Hide
        let header = cx.new(|_| {
            let mut right = vec![ToolAction::new(
                "options",
                IconName::MoreVertical,
                "Options",
            )];
            right.extend(crate::shell::panel_actions());
            ToolTabs::new("Terminal", Vec::new())
                .with_actions(
                    vec![ToolAction::new("new", IconName::Add, "New Tab").shortcut("⇧⌘T")],
                    right,
                )
                .with_lead(crate::shell::panel_lead(crate::shell::PanelTab::Terminal))
        });
        let subs = vec![
            cx.subscribe_in(&header, window, |v, _, ev: &ToolTabsEvent, window, cx| {
                v.on_tool_tabs(ev, window, cx)
            }),
            cx.subscribe_in(&header, window, |v, _, ev: &ToolActionEvent, window, cx| {
                v.on_action(ev, window, cx)
            }),
            cx.subscribe(
                &header,
                |v: &mut Self, _, ev: &crate::kit::PaneLeadEvent, _| {
                    crate::shell::panel_picked(&v.scx, ev.0)
                },
            ),
        ];
        let cwd = scx.project.clone();
        let hosted = HostedFocus::new(&scx, focus.clone());
        TerminalView {
            scx,
            focus,
            hosted,
            tabs: Vec::new(),
            cur: 0,
            next_id: 1,
            tx,
            header,
            shared: Rc::default(),
            metrics: None,
            scroll_view: false,
            scroll_px: 0.,
            press: None,
            key_at: None,
            ctrl_bslash: None,
            wheel_px: 0.,
            reported: None,
            find: None,
            last_find: find::LastFind::default(),
            preedit: None,
            float: None,
            view_bounds: Rc::default(),
            env: HashMap::new(),
            cwd,
            bells: 0,
            last_bell: None,
            output_redraws: 0,
            hold: None,
            _tasks: vec![pump],
            _subs: subs,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<TermEvent>(Self::NAME, payload) else {
            return;
        };
        // Lua answered a shortcut: keys typed after it go on
        self.release_hold_soon(window, cx);
        match ev {
            TermEvent::Open {
                enter,
                show,
                root,
                cwd,
                env,
                tabs,
                cur,
            } => {
                if let Some(env) = env {
                    self.env = env;
                }
                if let Some(root) = root {
                    self.cwd = PathBuf::from(root);
                }
                // the session's shells (or a first one) when none is open
                match tabs.filter(|t| !t.is_empty() && self.tabs.is_empty()) {
                    Some(tabs) => {
                        for cwd in tabs {
                            self.new_tab(Some(cwd), window, cx);
                        }
                        let ix = cur.unwrap_or(1).max(1) - 1;
                        self.show(ix.min(self.tabs.len().saturating_sub(1)), cx);
                    }
                    None if self.tabs.is_empty() => self.new_tab(cwd, window, cx),
                    None => {}
                }
                if show {
                    self.hosted.open(enter, window, cx);
                }
                if enter {
                    // going into the terminal types into it (Lua: startinsert)
                    self.back_to_prompt(cx);
                }
                self.report(cx);
                cx.notify();
            }
            TermEvent::New { cwd } => {
                self.new_tab(cwd, window, cx);
                self.take_keyboard(window, cx);
                cx.notify();
            }
            TermEvent::Hide => {
                self.close_find(false, window, cx);
                self.hosted.hide(window, cx);
                cx.notify();
            }
            // the host became nvim's current window: typing at the prompt, unless a click put the
            // keyboard somewhere inside (the find field, a selection)
            TermEvent::Focus => {
                if !self.hosted.has_keyboard(window, cx) {
                    self.back_to_prompt(cx);
                }
                self.hosted.focus_event(window, cx);
                cx.notify();
            }
            TermEvent::Blur => {
                self.close_find(false, window, cx);
                self.hosted.blur_event(window, cx);
                cx.notify();
            }
            TermEvent::Close => self.close_tab(self.cur, window, cx),
            TermEvent::Cycle { dir } => self.cycle(dir, cx),
            TermEvent::Find { query } => {
                self.open_find(window, cx);
                if let Some(q) = query {
                    self.find_type(&q, cx);
                }
            }
            TermEvent::FloatSend { text } => self.float_send(text),
            TermEvent::Send { text } => {
                if let Some(p) = self.pty() {
                    p.write(text.into_bytes());
                }
            }
            TermEvent::Lazygit { cmd, cwd, env, osc } => {
                self.open_float(cmd, cwd, env, osc, window, cx)
            }
        }
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let metrics = self.metrics(window, cx);
        let in_float = self
            .float
            .as_ref()
            .is_some_and(|f| f.focus.contains_focused(window, cx));
        // (an inactive app window has no active tool window: WebStorm dims it with the frame)
        let active = self.focus.contains_focused(window, cx)
            && !in_float
            && crate::editor::window_active(window);
        self.header.update(cx, |h, cx| h.set_active(active, cx));
        let focused = self.focus.is_focused(window);
        let grid = self.pty().cloned().map(|pty| TermElement {
            pty,
            view: Some(cx.entity()),
            input_focus: self.focus.clone(),
            focused,
            metrics,
            scroll_px: self.scroll_px,
            matches: self
                .find
                .as_ref()
                .map(|f| f.matches.clone())
                .unwrap_or_default(),
            current: self.find.as_ref().and_then(|f| f.current()),
            preedit: if focused { self.preedit.clone() } else { None },
            shared: self.shared.clone(),
            float: false,
        });
        let find_bar = self.render_find(cx);
        let float = self.render_float(window, cx);
        let header = div()
            .relative()
            .flex_none()
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Right, cx.listener(Self::header_mouse_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::header_mouse_down))
            .child(self.header.clone());
        let body = div()
            .id("terminal-body")
            .debug_selector(|| "terminal-body".into())
            .relative()
            .flex_1()
            .min_h(px(0.))
            .overflow_hidden()
            .bg(gpui_kit::rgb(colors::palette().background))
            .cursor(gpui_kit::CursorStyle::IBeam)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::body_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::body_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::body_mouse_down))
            .on_scroll_wheel(cx.listener(Self::body_scroll))
            .children(grid)
            .children(find_bar);
        div()
            .id("terminal-tool-window")
            .key_context("TerminalToolWindow")
            .debug_selector(|| "terminal-view".into())
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(look::PANEL_BG)
            .text_color(look::TEXT)
            .on_key_down(cx.listener(Self::on_key_down))
            .capture_any_mouse_down(cx.listener(Self::on_any_mouse_down))
            .child({
                let record = self.view_bounds.clone();
                gpui_kit::canvas(move |b, _, _| record.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
            })
            .when(self.hosted.is_open(), |d| d.child(header).child(body))
            .children(float)
    }
}
