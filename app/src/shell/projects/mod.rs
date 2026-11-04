//! Open projects: the window root ([`Projects`]) holds one [`Workspace`] per open project, each
//! with its own nvim and surfaces (terminal shells, Git tool window, tabs, LSP inside nvim), and
//! draws only the shown one. Switching shows another open project at once (its nvim kept running)
//! or starts one for a new dir; nothing is lost, so it never asks. Closing a project (menu item,
//! the window's close button, its nvim quitting on its own) asks first when work would be lost
//! ([`Losses`]), quits its nvim (the session is saved by VimLeavePre), closes its shells once
//! the session read their folders, and shows the next one in Cmd+< order; closing the
//! last one quits the app.
//!
//! Hidden projects cost nothing: their entities aren't drawn (a `cx.notify` there redraws
//! nothing), their polls pause ([`Workspace::set_active`]), their nvim gets FocusLost; PTY
//! output keeps being read.
//!
//! Single instance ([`open_path`]): a path handed to the app opens / shows its project.
//!
//! The rail ([`rail`]): one tile per open workspace, Abe (the repo's main checkout) first, then
//! the repo's places (Board, Boxes, Pipelines); the header's row right of it names the tile and a
//! workspace's pages ([`pages`]). Each tile keeps its page, its Chat and where the keys were
//! ([`memory`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::FutureExt as _;
use futures::channel::{mpsc, oneshot};
use futures::future::{Either, select};
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, Focusable as _, Global,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, Styled as _,
    Subscription, Task, WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};
use rmpv::Value;

mod chat;
mod jumps;
mod maximize;
mod memory;
mod pages;
mod protos;
pub mod rail;
mod tiles;

use super::{Workspace, WorkspaceEvent};

mod bottom;
mod stripe;
mod welcome;
use crate::factory::Feel;
use crate::factory::{FactoryEvent, FactoryShell, FactoryView};
use crate::kit::Anchor;
use crate::look;
use crate::nvim::lua;
use crate::nvim::{Nvim, NvimConfig, NvimEvent, Quitter};
use crate::popups::{self, Balloon};
use crate::shell::recent::real_path;
use crate::shell::toolbar::{CLOSE_QUIT_TIMEOUT, Launcher, Losses, Quitting};

pub(crate) use jumps::jump_from_torn;
pub use maximize::{FactoryIsland, menu_title};
pub(crate) use maximize::{dispatch, is_key};
pub use memory::{ChatMemory, ChatSize, Keys, TileMemory};
pub use pages::{CARD_SCREEN, Page};
pub use protos::{PROTOTYPE_SCREEN, ProtoPage};
pub use rail::{RAIL_WIDTH, Tile};
pub(crate) use stripe::dot_color;
pub use stripe::{Place, Row, STRIPE_WIDTH, Shown, menu_rows, shown};
pub use welcome::{
    ClonesDir, Frame as WindowFrame, centred as centred_frame, clone_target,
    frame_path as welcome_frame_path, welcome_frame, welcome_shown,
};

/// How long Lua may take to say what closing a project would lose (it saves first).
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a switch waits for the shown project's nvim to redraw at a window size that changed
/// while it was hidden.
const RESIZE_WAIT: Duration = Duration::from_millis(100);

/// A path handed to the app (`vimstorm <path>`, Finder, the dock): a project dir, maybe a file in
/// it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenRequest {
    /// The project dir (absolute, canonical).
    pub dir: PathBuf,
    /// A file to open in that project (absolute; inside `dir` or not).
    pub file: Option<PathBuf>,
}

/// Opens `req.dir` in the app's window: shows it if it's open, else starts its nvim; then opens
/// `req.file` in it. Errors when there's no projects window or the nvim can't start.
pub fn open_path(req: OpenRequest, cx: &mut App) -> anyhow::Result<()> {
    let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
        anyhow::bail!("no projects window");
    };
    if !req.dir.is_dir() {
        anyhow::bail!("not a folder: {}", req.dir.display());
    }
    h.window.update(cx, |_, window, cx| {
        h.root
            .update(cx, |p, cx| p.open(req.dir, req.file, window, cx))
            .and_then(|r| r)
    })?
}

/// The open projects' dirs, in open order.
pub fn open_dirs(cx: &App) -> Vec<PathBuf> {
    root(cx).map_or_else(Vec::new, |p| {
        p.read(cx).open.iter().map(|o| o.dir.clone()).collect()
    })
}

/// The open projects' dirs, the shown one first, then most recently used first (popups).
pub fn open_dirs_by_use(cx: &App) -> Vec<PathBuf> {
    root(cx).map_or_else(Vec::new, |p| {
        let p = p.read(cx);
        // real folders, as the sessions' are: one row per folder (`/tmp` → `/private/tmp`)
        p.mru.iter().map(|&ix| p.open[ix].real.clone()).collect()
    })
}

/// The window holding the projects (to bring it to the front).
pub fn window(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<ProjectsWindow>().map(|h| h.window)
}

/// The shown project's workspace (the menu bar's Git › Branches… opens its toolbar popup).
pub fn active_workspace(cx: &App) -> Option<Entity<Workspace>> {
    root(cx)?.read(cx).active().cloned()
}

/// Shows `dir` (opening it if needed). Never asks: nothing is lost. Safe inside any update (runs
/// on the next effect cycle).
pub fn switch_to(dir: PathBuf, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        p.open_or_tell(dir, window, cx)
    });
}

/// The toolbar's gear clicked (Settings stays there): Settings, as ⌘,. Safe inside any
/// update.
pub fn settings_from_toolbar(window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        p.open_settings(None, window, cx)
    });
}

/// The toolbar's context line clicked: Linked on the shown workspace's story. Safe inside
/// any update.
pub fn linked_from_toolbar(window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        p.jump(
            crate::factory::JumpTo::Linked,
            crate::factory::JumpPlace::Toolbar,
            window,
            cx,
        );
    });
}

/// A click on something of the Factory's drawn outside its view (the toolbar's Chat button, a
/// status bar widget `widget:<id>`): the bridge told, which decides. Safe inside any update.
pub fn factory_click(id: String, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, _, cx| {
        if let Some(view) = p.factory().cloned() {
            view.update(cx, |v, cx| {
                v.send_input(crate::factory::UserInput::Click { id }, cx);
            });
        }
    });
}

/// View › Chat Mode / Claude Code: the shown column in `mode` with the keys, wherever they are
/// (typed, ⌃⌘← ⌃⌘→ on Code are the tabs of the pane with them). Safe inside any update.
pub fn column_mode(mode: crate::shell::ColumnMode, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        p.command_mode_gives_way(cx);
        if let Some(ws) = p.active().cloned() {
            ws.update(cx, |ws, cx| ws.column_mode(mode, window, cx));
        }
    });
}

/// File › New Workspace… (the rail's `+`): the Board on its New card dialog.
pub fn show_workspaces(window: &mut Window, cx: &mut App) {
    with_root(window, cx, |p, window, cx| p.new_workspace(window, cx));
}

/// Shows `dir` in VimStorm mode (opening it if needed) with `file` open in an editor tab: a card's
/// edit file from Abe mode (B4). Safe inside any update.
pub fn open_file(dir: PathBuf, file: PathBuf, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        if let Err(e) = p.open(dir.clone(), Some(file), window, cx) {
            let msg = format!("Couldn't open {}: {e:#}", dir.display());
            popups::notify(Balloon::error("Open Project", msg), window, cx);
        }
    });
}

/// Shows workspace `dir` (opening it if needed) with `file` open in its editor at `line` (the
/// bridge's `open-file`: a test failure's Open file in the Pipelines tab). Safe inside any update.
pub fn open_file_at(dir: PathBuf, file: PathBuf, line: u64, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        let running = p
            .index_of(&dir)
            .and_then(|ix| p.open[ix].ws().cloned())
            .filter(|_| p.index_of(&dir).is_some_and(|ix| p.open[ix].run.is_some()));
        let Some(ws) = running else {
            // not running yet: the file opens as the workspace starts (at its top)
            if let Err(e) = p.open(dir.clone(), Some(file), window, cx) {
                let msg = format!("Couldn't open {}: {e:#}", dir.display());
                popups::notify(Balloon::error("Open File", msg), window, cx);
            }
            return;
        };
        if let Some(ix) = p.index_of(&dir) {
            p.editor_next(&dir);
            p.activate(ix, window, cx);
        }
        let rpc = ws.read(cx).rpc().clone();
        lua::navigate(&rpc, "config.focus", "editor", Vec::new());
        lua::navigate(
            &rpc,
            "config.app.pickers",
            "open_file",
            vec![file.display().to_string().into(), line.into()],
        );
        ws.update(cx, |ws, cx| ws.focus_editor(window, cx));
    });
}

/// Opens `dir` in place of the shown project (Recent Projects' Enter / click; WS: open in this
/// window): the shown one closes like Close Project (asking first when work would be lost; its
/// session saved, its nvim quit) and the new one takes its place in the Cmd+< order; the other
/// open projects stay. An open `dir` is just shown. `anchor`: where the question opens (None:
/// the window's top middle). Safe inside any update.
pub fn open_in_place(dir: PathBuf, anchor: Option<Anchor>, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        if p.open.is_empty() || p.index_of(&dir).is_some() {
            return p.open_or_tell(dir, window, cx);
        }
        let ix = p.active;
        p.close_then(ix, anchor, window, cx, move |p, ix, window, cx| {
            p.replace(ix, dir, window, cx)
        });
    });
}

/// Closes the shown project (asking first when work would be lost). `anchor`: where the
/// question opens (None: the window's top middle). A repo's main checkout stays while a worktree
/// of it is open (the status line says how to quit); the last one open closes, the app quits.
pub fn close_active(anchor: Option<Anchor>, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| {
        p.close_shown(anchor, window, cx)
    });
}

/// ⌘Q on a main checkout while a worktree of it is open.
pub const MAIN_STAYS: &str =
    "The main checkout stays open · VimStorm › Quit VimStorm quits the app";

/// Quit VimStorm with every open project (asks first when work would be lost; see
/// [`Projects::quit_app`]). Without a projects window: quits.
pub fn quit(window: &mut Window, cx: &mut App) {
    if root(cx).is_none() {
        crate::app::quitting("Quit VimStorm");
        cx.quit();
        return;
    }
    with_root(window, cx, |p, window, cx| p.quit_app(window, cx));
}

/// The workspace below (`by` 1) / above (-1) on the rail, round again (Window › Next / Previous).
pub fn cycle(by: isize, window: &mut Window, cx: &mut App) {
    with_root(window, cx, move |p, window, cx| p.walk(by, window, cx));
}

pub fn show_git_for_source_selection(window: &mut Window, cx: &mut App) {
    with_root(window, cx, |p, _, cx| {
        if let Some(ws) = p.active() {
            lua::navigate(
                ws.read(cx).rpc(),
                "config.app.git",
                "open",
                vec!["changes".into()],
            );
        }
    });
}

/// Two Shift taps on an Abe surface: the shown project's Search Everywhere (its All tab).
pub fn search_everywhere_later(cx: &mut App) {
    cx.defer(move |cx| {
        let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
            return;
        };
        let _ = h.window.update(cx, |_, window, cx| {
            let Some(root) = h.root.upgrade() else {
                return;
            };
            let Some(pickers) = root
                .read(cx)
                .active()
                .map(|ws| ws.read(cx).pickers().clone())
            else {
                return;
            };
            pickers.update(cx, |p, cx| p.open_search(None, window, cx));
        });
    });
}

/// Keys typed after the editor's `:` before Command mode had the keyboard: typed into it.
pub fn command_typeahead(keys: Vec<String>, cx: &mut App) {
    cx.defer(move |cx| {
        let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
            return;
        };
        let _ = h.window.update(cx, |_, window, cx| {
            let Some(root) = h.root.upgrade() else {
                return;
            };
            // Command mode took the `:`: the keys typed after it are its
            let factory = root
                .read(cx)
                .factory
                .as_ref()
                .filter(|(v, _)| {
                    v.read(cx).layer_up() || v.read(cx).focus_handle(cx).is_focused(window)
                })
                .map(|(v, _)| v.clone());
            if let Some(f) = factory {
                f.update(cx, |f, cx| f.type_keys(keys, cx));
            }
        });
    });
}

/// What `:` says with no `abe` to answer it (2.2's install always puts one in the bundle).
pub const NO_ABE: &str = "abe isn't installed: run ./install.sh in your VimStorm checkout";
/// What `:` says when the `abe` there doesn't answer (its bridge didn't start, or stopped).
pub const ABE_DOWN: &str =
    "abe isn't answering, so Command mode can't open (⌘, Settings has Retry)";

/// Where `:` came from ([`colon_at`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColonFrom {
    /// The editor's `:` key (`config/app/colon.lua`): Neovim holds the keys typed after it.
    EditorKey,
    /// ⌘⇧A / ⌘⇧P in the editor (any mode): Neovim holds the keys typed after it.
    EditorAction,
    /// The tree's, Git's, Pipelines', a command's: nothing held.
    Surface,
}

/// `:`: Abe's Command mode with the keyboard; with no `abe`, or one that doesn't answer, one
/// line says so (and the editor's `:` key is Neovim's command line). False without the projects
/// window (a bare workspace): nothing opened.
pub fn colon_at(from: ColonFrom, here: Option<crate::factory::EditorHere>, cx: &mut App) -> bool {
    let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
        return false;
    };
    cx.defer(move |cx| {
        let _ = h.window.update(cx, |_, window, cx| {
            if let Some(root) = h.root.upgrade() {
                root.update(cx, |p, cx| p.colon(from, here, window, cx));
            }
        });
    });
    true
}

/// The keyboard on the shown project's editor (`^Q` in a chat: back to the code). Safe inside
/// any update.
pub fn focus_editor(cx: &mut App) {
    cx.defer(move |cx| {
        let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
            return;
        };
        let _ = h.window.update(cx, |_, _, cx| {
            if let Some(ws) = h.root.upgrade().and_then(|r| r.read(cx).active().cloned()) {
                lua::call(ws.read(cx).rpc(), "config.focus", "editor", Vec::new());
            }
        });
    });
}

/// A worktree opened as a project of its own, shown. Worktree projects open on demand and at
/// most [`MAX_WORKTREES`] stay open (decision 18): opening one more closes the least recently shown clean one (nothing unsaved,
/// no terminal job, no uncommitted file; a dirty one is never closed). Safe inside any update
/// (runs once the effects settle).
pub fn open_worktree(dir: PathBuf, cx: &mut App) {
    cx.defer(move |cx| {
        let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
            return;
        };
        let _ = h.window.update(cx, |_, window, cx| {
            if let Some(root) = h.root.upgrade() {
                root.update(cx, |p, cx| p.open_worktree(dir, window, cx));
            }
        });
    });
}

/// A PR's worktree opened as [`open_worktree`] does, then its Git tool window shows the PR
/// Changes pane on the PR (`C` in Abe mode). Safe inside any update.
pub fn open_review(dir: PathBuf, open: crate::git::window::ReviewOpen, cx: &mut App) {
    cx.defer(move |cx| {
        let Some(h) = cx.try_global::<ProjectsWindow>().cloned() else {
            return;
        };
        let _ = h.window.update(cx, |_, window, cx| {
            if let Some(root) = h.root.upgrade() {
                root.update(cx, |p, cx| {
                    // the review is the Git window's: the code shows
                    p.editor_next(&dir);
                    p.open_worktree(dir.clone(), window, cx);
                    let Some(ws) = p.index_of(&dir).and_then(|ix| p.open[ix].ws().cloned()) else {
                        return;
                    };
                    let git = ws.read(cx).git().clone();
                    git.update(cx, |g, cx| g.start_review(open, window, cx));
                });
            }
        });
    });
}

/// How many worktree projects stay open at most (decision 18: one nvim each costs memory).
pub const MAX_WORKTREES: usize = 5;

/// The worktree projects the LRU may close to keep at most `max` open: the least recently shown
/// first, never the shown one; none while at most `max` are open. `worktree[i]`: open project `i`
/// is a worktree project; `mru`: open projects, most recently shown first.
pub fn lru_candidates(worktree: &[bool], mru: &[usize], active: usize, max: usize) -> Vec<usize> {
    let open = worktree.iter().filter(|w| **w).count();
    if open <= max {
        return Vec::new();
    }
    mru.iter()
        .rev()
        .copied()
        .filter(|&i| i != active && worktree.get(i).copied().unwrap_or(false))
        .collect()
}

/// The open projects to show after closing the shown one, `ix` of `n`, in turn (the first that
/// runs): its main checkout `main` if a worktree's and open, then the next ones in Cmd+< order
/// (open order, wrapping).
fn shown_after_close(n: usize, ix: usize, main: Option<usize>) -> impl Iterator<Item = usize> {
    let main = main.filter(|&m| m != ix && m < n);
    main.into_iter().chain(
        (1..n)
            .map(move |step| (ix + step) % n)
            .filter(move |&i| Some(i) != main),
    )
}

fn root(cx: &App) -> Option<Entity<Projects>> {
    cx.try_global::<ProjectsWindow>()?.root.upgrade()
}

fn with_root(
    window: &mut Window,
    cx: &mut App,
    f: impl FnOnce(&mut Projects, &mut Window, &mut Context<Projects>) + 'static,
) {
    let Some(root) = root(cx) else {
        return;
    };
    window.defer(cx, move |window, cx| {
        root.update(cx, |p, cx| f(p, window, cx))
    });
}

/// The projects window (one per app).
#[derive(Clone)]
struct ProjectsWindow {
    root: WeakEntity<Projects>,
    window: AnyWindowHandle,
}

impl Global for ProjectsWindow {}

/// An open project: running (its nvim + workspace), or restored at launch and not shown yet
/// (started on its first show).
struct OpenProject {
    dir: PathBuf,
    /// `dir` with symlinks resolved: a project opened by another path to the same folder
    /// (`~/projects/<link>`, `/var` vs `/private/var`) is the same project (one nvim per folder).
    real: PathBuf,
    run: Option<Running>,
    /// Opened from Abe mode as a story's worktree ([`open_worktree`]): the LRU may close it.
    worktree: bool,
    /// A cloud session's workspace ([`crate::shell::remote`]): `dir` is its box's folder, its
    /// Neovim, terminals, tree and git run through this. Never saved for the next launch.
    remote: Option<std::sync::Arc<crate::shell::remote::Attach>>,
    /// A repo's main checkout (its `.git` a folder, a worktree's is a file): first in the
    /// strip, never hidden ([`Self::is_main`]).
    main: bool,
    /// A worktree's main checkout (by its real folder, from its `.git` file): while one is open,
    /// its main checkout stays ([`Projects::close_shown`]).
    of_main: Option<PathBuf>,
}

struct Running {
    ws: Entity<Workspace>,
    quitter: Quitter,
    _sub: Subscription,
    /// Its popups and pickers watched: the Factory's native page hides under them.
    _covers: [Subscription; 2],
}

impl OpenProject {
    /// Resolves `dir` once (a stat per path component): lookups compare the cached `real`.
    fn new(dir: PathBuf, run: Option<Running>) -> Self {
        let real = real_path(&dir);
        Self::with_real(dir, real, run)
    }

    fn with_real(dir: PathBuf, real: PathBuf, run: Option<Running>) -> Self {
        let main = real.join(".git").is_dir();
        let of_main = (!main).then(|| main_of_worktree(&real)).flatten();
        OpenProject {
            dir,
            real,
            run,
            worktree: false,
            remote: None,
            main,
            of_main,
        }
    }

    /// The repo's main checkout (where its Abe chat lives), not a cloud workspace.
    fn is_main(&self) -> bool {
        self.main && self.remote.is_none()
    }

    fn ws(&self) -> Option<&Entity<Workspace>> {
        self.run.as_ref().map(|r| &r.ws)
    }

    fn is(&self, ws: &Entity<Workspace>) -> bool {
        self.ws() == Some(ws)
    }
}

/// The main checkout of the worktree at `real` (its `.git` file's `gitdir: <main>/.git/worktrees/
/// <name>`), by its real folder; None for anything else.
fn main_of_worktree(real: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(real.join(".git")).ok()?;
    let git_dir = real.join(text.trim().strip_prefix("gitdir:")?.trim());
    let worktrees = git_dir.parent()?;
    let dot_git = worktrees.parent()?;
    let main = dot_git.parent()?;
    (worktrees.file_name()? == "worktrees" && dot_git.file_name()? == ".git")
        .then(|| real_path(main))
}

/// The open projects at the last quit (`<state>/vimstorm/open-projects.json`), reopened by a
/// launch without a path (WebStorm's "reopen projects on startup").
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SavedSet {
    /// Open order.
    pub open: Vec<PathBuf>,
    /// The shown one.
    pub active: Option<PathBuf>,
}

impl SavedSet {
    /// The file, under nvim's state dir (`state_home`: its `XDG_STATE_HOME`, None: this process's
    /// or `~/.local/state`).
    pub fn path(state_home: Option<&Path>) -> PathBuf {
        crate::shell::recent::state_dir(state_home).join("open-projects.json")
    }

    /// The saved set, without dirs that are gone; None when there's nothing to reopen.
    pub fn load(state_home: Option<&Path>) -> Option<SavedSet> {
        let text = std::fs::read_to_string(Self::path(state_home)).ok()?;
        let mut set: SavedSet = serde_json::from_str(&text).ok()?;
        set.open.retain(|d| d.is_dir());
        if set.active.as_ref().is_none_or(|a| !set.open.contains(a)) {
            set.active = set.open.first().cloned();
        }
        (!set.open.is_empty()).then_some(set)
    }

    /// The set a launch with path `dir` opens: this one with `dir` shown (its real folder), in
    /// its place when it was open (any path to its folder), else last. The next launch without a
    /// path reopens them all, never just `dir`.
    pub fn with_launched(mut self, dir: &Path) -> SavedSet {
        let real = real_path(dir);
        match self.open.iter().position(|d| real_path(d) == real) {
            Some(ix) => self.open[ix] = real.clone(),
            None => self.open.push(real.clone()),
        }
        self.active = Some(real);
        self
    }

    fn save(&self, state_home: Option<&Path>) {
        let path = Self::path(state_home);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(self) {
            // whole file or nothing (a quit while writing)
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

/// What the app starts with.
#[derive(Debug, PartialEq, Eq)]
pub enum Start {
    /// A project (and a file to open in it).
    One(PathBuf, Option<PathBuf>),
    /// The projects open at the last quit.
    Restore(SavedSet),
    /// Nothing to reopen: Welcome.
    Welcome,
}

/// What a launch without a path from LaunchServices (Dock, Finder, `open -a VimStorm`) starts
/// with: the first path AppKit handed over (`open -a VimStorm <dir>`: just that), else the
/// projects open at the last quit, else Welcome when `welcome` (an `abe` 2.x draws it),
/// else the most recent project (else home). Reads the disk and runs git: off the UI thread.
pub fn launch_start(first: Option<PathBuf>, state_home: Option<&Path>, welcome: bool) -> Start {
    if let Some(first) = first {
        match crate::app::startup_project(Some(&first)) {
            Ok((project, file)) => return Start::One(project, file),
            Err(e) => eprintln!("[vimstorm] open {}: {e}", first.display()),
        }
    }
    if let Some(set) = SavedSet::load(state_home) {
        return Start::Restore(set);
    }
    if welcome {
        return Start::Welcome;
    }
    let (project, _) = crate::app::startup_project(None).unwrap_or_default();
    Start::One(project, None)
}

/// Serializes [`SavedSet`] writes: (latest generation, write lock).
#[derive(Clone, Default)]
struct SetSaver(
    std::sync::Arc<std::sync::atomic::AtomicU64>,
    std::sync::Arc<parking_lot::Mutex<()>>,
);

impl Global for SetSaver {}

/// The `XDG_STATE_HOME` the app's nvims get (tests give theirs one; None: this process's):
/// sessions and [`SavedSet`].
pub fn state_home(cx: &App) -> Option<PathBuf> {
    cx.try_global::<Launcher>()
        .and_then(|l| l.template.env.get("XDG_STATE_HOME").map(PathBuf::from))
}

/// The window root (see the module doc).
pub struct Projects {
    /// Open order (the rail's, after the main checkout).
    open: Vec<OpenProject>,
    /// Index into `open` of the shown project.
    active: usize,
    /// Indexes into `open`, most recently shown first (`mru[0] == active`).
    mru: Vec<usize>,
    /// The last project closed: the app is quitting.
    quitting: bool,
    /// When the shown project last changed (`VIMSTORM_TIMING`: switch -> frame).
    switched: Option<std::time::Instant>,
    /// Switch -> first frame of the shown project, last measured (tests, timing).
    last_switch: Option<Duration>,
    /// A switch waiting for the next project's nvim to redraw at the window's size.
    pending: Option<(Subscription, Task<()>)>,
    /// Close Project is asking Lua what closing would lose (see [`Self::close`]).
    checking: bool,
    /// Abe 2.0's Factory view, made when first shown and kept (its bridge keeps running).
    factory: Option<(Entity<FactoryView>, Subscription)>,
    /// The Chat column's Chat mode: the bridge's `chat` slot (one per window, pinned to the
    /// shown workspace), made the first time a column draws Chat with an `abe` 2.0 there.
    chat_slot: Option<Entity<crate::factory::SlotView>>,
    /// The Factory view is shown in place of the shown project's body.
    factory_shown: bool,
    /// What had the keyboard when the Factory view was shown: it gets it back.
    factory_return: Option<FocusHandle>,
    /// In the Factory view, the slot of its own a layer took the keyboard from (Chat's column, a
    /// pane): it gets it back once the layer closes.
    layer_return: Option<FocusHandle>,
    /// The Factory view's island ⌥⌘⏎ gave the body ([`maximize`]).
    factory_max: Option<maximize::FactoryIsland>,
    /// The header's feed matched to the open projects.
    header: crate::factory::Resolver,
    /// The name each running project's nvim was told for the window title, by its workspace
    /// ([`Self::name_titles`]).
    titled: HashMap<gpui_kit::EntityId, String>,
    /// The rail's tiles as last drawn, top to bottom (tests).
    drawn_rail: Vec<rail::Tile>,
    /// The prototypes' tiles: their order, the one shown, each one's page ([`protos`]).
    protos: protos::ProtoTiles,
    /// Boxes or Pipelines shown in the middle (the Factory view's pane filling it), none on the
    /// Board or a workspace's page.
    pane_place: Option<crate::shell::pane::PaneTab>,
    /// The main slot's Card screen is the shown workspace's Card page (else the Board opened it
    /// for a card with no workspace: the Board's tile).
    card_page: bool,
    /// Where ⌘§ on Abe goes back to.
    abe_back: Option<rail::Tile>,
    /// A move to a workspace whose show waits (a resize): it lands once shown.
    arrive: Option<rail::Tile>,
    /// The tile under the pointer (⌘⏎ opens its menu).
    rail_hover: Option<rail::Tile>,
    /// What each tile remembers: its Chat, colour, page, panel and session ([`memory`]), kept
    /// for the next launch.
    memory: TileMemory,
    /// The shown tile's Chat was maximized when ⌘⌥2 hid it (until it shows again).
    chat_hidden_maximized: bool,
    /// The launches seen starting while the app runs (by their worktree's real folder): each
    /// put its workspace on the rail once ([`Self::launches_seen`]), never again once closed.
    launched: HashSet<PathBuf>,
    /// The bottom pane's window part: the slot view, the Factory view's pane.
    bottom: bottom::Bottom,
    /// The workspace about to show (by its real folder) shows the Editor, whatever its page:
    /// a file opens in it.
    editor_next: Option<PathBuf>,
    /// The workspace switch waiting on its resize ([`Self::pending`]) gives Chat the keys once
    /// it shows ([`Self::chat_keys`]): showing restores that workspace's own keyboard.
    chat_keys_next: bool,
    /// The status line's words the window put there (gone with the next move).
    browse_note: Option<String>,
    /// No project open: Welcome is shown, `open` is empty.
    welcome: Option<welcome::Welcome>,
    /// The card the project opened from Welcome lands on once it shows, by its real folder.
    landing: Option<(PathBuf, u64)>,
}

impl Projects {
    /// The window root with its first project: `nvim` on `dir`, whose events come in on `events`.
    pub fn new(
        nvim: Nvim,
        events: mpsc::UnboundedReceiver<NvimEvent>,
        dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut p = Self::bare(window, cx);
        let run = p.start(nvim, events, dir.clone(), window, cx);
        p.open.push(OpenProject::new(dir, Some(run)));
        p.mru = vec![0];
        p.save_set(cx);
        p.ensure_chat_slot(window, cx);
        p
    }

    /// The window root with no project open: Welcome (a launch with nothing to reopen).
    pub fn welcome(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let p = Self::bare(window, cx);
        cx.defer_in(window, |p: &mut Projects, window, cx| {
            p.enter_welcome(window, cx)
        });
        // a driven launch with nothing to reopen: no editor comes to start the socket from
        #[cfg(feature = "shots")]
        crate::devtools::schedule_drive(window, cx, None, |_| true);
        p.save_set(cx);
        p
    }

    /// The window root's state and its observers, no project yet.
    fn bare(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let root = cx.entity().downgrade();
        cx.set_global(ProjectsWindow {
            root,
            window: window.window_handle(),
        });
        // the Chat column: shown unless the window starts narrow, last launch's width, docked (a
        // state set before the window, a test's, is kept)
        if !cx.has_global::<crate::shell::column::ColumnState>() {
            let width = f32::from(window.viewport_size().width);
            let column =
                crate::shell::column::ColumnState::at_start(width, state_home(cx).as_deref());
            cx.set_global(column);
        }
        // the Chat column's content follows its state and an `abe` 2.0 turning up: its slot made
        // there (never in render), once a column is shown
        cx.observe_global_in::<crate::shell::column::ColumnState>(window, |p, window, cx| {
            p.ensure_chat_slot(window, cx);
            // shown again (any way): a later hide is not from maximized unless it says so
            if crate::shell::column::state(cx).shown() {
                p.chat_hidden_maximized = false;
            }
            cx.notify();
        })
        .detach();
        // a session starting (a launch): its workspace on the rail at once
        cx.observe_global::<crate::factory::WorkspaceFeed>(|p, cx| p.launches_seen(cx))
            .detach();
        // the prototypes' tiles: their order, one asked for, the shown one gone
        cx.observe_global_in::<crate::factory::WorkspaceFeed>(window, |p, window, cx| {
            p.prototypes_seen(window, cx)
        })
        .detach();
        cx.observe_global_in::<crate::factory::BridgeCommand>(window, |p, window, cx| {
            p.ensure_chat_slot(window, cx);
            cx.notify();
        })
        .detach();
        let mut p = Projects {
            open: Vec::new(),
            active: 0,
            mru: Vec::new(),
            quitting: false,
            switched: None,
            last_switch: None,
            pending: None,
            checking: false,
            factory: None,
            chat_slot: None,
            factory_shown: false,
            factory_return: None,
            layer_return: None,
            factory_max: None,
            header: Default::default(),
            titled: HashMap::new(),
            drawn_rail: Vec::new(),
            protos: protos::ProtoTiles::default(),
            pane_place: None,
            card_page: false,
            abe_back: None,
            arrive: None,
            rail_hover: None,
            memory: Default::default(),
            chat_hidden_maximized: false,
            launched: HashSet::new(),
            bottom: Default::default(),
            editor_next: None,
            chat_keys_next: false,
            browse_note: None,
            welcome: None,
            landing: None,
        };
        let state = crate::shell::recent::state_dir(state_home(cx).as_deref());
        p.memory = TileMemory::load(&state);
        // the Feel's switches go to every project's nvim whenever they change
        cx.observe_global::<Feel>(|p: &mut Projects, cx| {
            for o in &p.open {
                if let Some(ws) = o.ws() {
                    send_feel(ws.read(cx).rpc(), cx);
                }
            }
            // the Chat column's settings over the window's start, once
            let chat = cx.global::<Feel>().chat;
            if crate::shell::column::state(cx).settings_pending {
                let saved = crate::shell::column::load_width(state_home(cx).as_deref());
                crate::shell::column::set_state(cx, |s| *s = s.with_settings(chat, saved));
            }
        })
        .detach();
        // Abe 2.0's bridge from the start: the status bar's `Factory ◆ N` while you work
        if cx.has_global::<crate::factory::FollowAtLaunch>()
            && crate::factory::BridgeCommand::available(cx)
        {
            cx.defer_in(window, |p: &mut Projects, window, cx| {
                p.follow_factory(window, cx)
            });
        }
        p
    }

    /// The window root of a launch with a path: `nvim` on `dir`, shown in the Editor, beside the
    /// projects open at the last quit (they start when first shown), which stay saved for the
    /// next launch.
    pub fn launched(
        nvim: Nvim,
        events: mpsc::UnboundedReceiver<NvimEvent>,
        dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        match SavedSet::load(state_home(cx).as_deref()) {
            Some(set) => {
                let set = set.with_launched(&dir);
                Self::reopen(nvim, events, set, true, window, cx)
            }
            None => {
                let p = Self::new(nvim, events, dir, window, cx);
                // its Chat as it was left there
                let tile = rail::Tile::Workspace(p.open[0].real.clone());
                cx.defer_in(window, move |p, window, cx| p.apply_chat(&tile, window, cx));
                p
            }
        }
    }

    /// The window root reopening `set` (a launch without a path): `nvim` runs the shown one
    /// (`set.active`), the others start when first shown.
    pub fn restore(
        nvim: Nvim,
        events: mpsc::UnboundedReceiver<NvimEvent>,
        set: SavedSet,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::reopen(nvim, events, set, false, window, cx)
    }

    /// [`Self::restore`]; `launched`: the shown one is a launch's path, shown (never hidden) in
    /// the Editor.
    fn reopen(
        nvim: Nvim,
        events: mpsc::UnboundedReceiver<NvimEvent>,
        set: SavedSet,
        launched: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let first = set.active.clone().unwrap_or_else(|| set.open[0].clone());
        let mut p = Self::new(nvim, events, first.clone(), window, cx);
        let first = p.open[0].real.clone();
        let mut open: Vec<OpenProject> = Vec::new();
        for dir in set.open {
            let real = real_path(&dir);
            if open.iter().any(|o| o.real == real) {
                continue;
            }
            if real == first {
                open.push(p.open.remove(0));
            } else {
                open.push(OpenProject::with_real(dir, real, None));
            }
        }
        // (the shown one when the set didn't list it)
        open.append(&mut p.open);
        p.active = open.iter().position(|o| o.real == first).unwrap_or(0);
        p.open = open;
        p.mru = std::iter::once(p.active)
            .chain((0..p.open.len()).filter(|&i| i != p.active))
            .collect();
        // the page it had at the last quit (the Factory view once the root is made; a launch's
        // path: the Editor), its Chat as it was left there either way
        let page = (!launched).then(|| p.page_of(p.active, cx));
        let tile = rail::Tile::Workspace(p.open[p.active].real.clone());
        cx.defer_in(window, move |p, window, cx| {
            if let Some(page) = page.filter(|&page| page != Page::Code) {
                p.show_page(page, window, cx);
            }
            p.apply_chat(&tile, window, cx);
        });
        p.save_set(cx);
        p
    }

    /// The shown project's workspace (None only in a moment between closing it and showing the
    /// next one).
    pub fn active(&self) -> Option<&Entity<Workspace>> {
        self.open.get(self.active).and_then(OpenProject::ws)
    }

    /// Command mode has the keyboard after the editor's `:`: what Neovim held since then comes
    /// to it (an empty answer when nothing was held). Only the editor's `:` holds keys there: from
    /// any other surface Neovim gets nothing, not even the marker.
    fn command_took_keyboard(&self, cx: &App) {
        if let Some(ws) = self.active() {
            lua::call(
                ws.read(cx).rpc(),
                "config.app.typeahead",
                "focused",
                vec!["toolbar".into()],
            );
        }
    }

    /// `:` ([`colon_at`]): Abe's Command mode, which gets the keys Neovim held after the
    /// editor's; else the line saying why it can't open, and the editor's `:` key is Neovim's
    /// command line with those keys (⌘⇧A's are dropped).
    fn colon(
        &mut self,
        from: ColonFrom,
        here: Option<crate::factory::EditorHere>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let available = crate::factory::BridgeCommand::available(cx);
        if !(available && self.open_command_mode(here, window, cx)) {
            let text = if available { ABE_DOWN } else { NO_ABE };
            popups::notify(Balloon::info("", text), window, cx);
            if from == ColonFrom::EditorKey
                && let Some(ws) = self.active()
            {
                lua::call(ws.read(cx).rpc(), "config.app.colon", "cmdline", vec![]);
                return;
            }
        }
        if from != ColonFrom::Surface {
            self.command_took_keyboard(cx);
        }
    }

    /// `:` with the Project tree or a Git list in focus (no search or field typing): Command mode.
    /// The editor's `:` is its Lua map (`config/app/colon.lua`), Abe's surfaces their own.
    fn colon_key(&self, k: &gpui_kit::Keystroke, window: &Window, cx: &App) -> bool {
        if k.modifiers.platform
            || k.modifiers.control
            || k.key_char.as_deref().unwrap_or(k.key.as_str()) != ":"
            || crate::factory::settings_up(cx)
        {
            return false;
        }
        let Some(ws) = self.active() else {
            return false;
        };
        let ws = ws.read(cx);
        if ws.popups().read(cx).is_open() || ws.pickers().read(cx).state(cx).is_some() {
            return false;
        }
        match ws.native_focus() {
            Some("tree") => !ws.tree().read(cx).searching(),
            Some("git") => !ws.git().read(cx).typing(window, cx),
            _ => false,
        }
    }

    /// Settings: the bridge's dialog layer, centred over the whole window from any view,
    /// on page `at` when given; the keyboard goes back where it was once it closes.
    fn open_settings(
        &mut self,
        at: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = self.ensure_factory(window, cx);
        let focus = view.focus_handle(cx);
        if !self.factory_shown && !focus.contains_focused(window, cx) {
            self.factory_return = window.focused(cx);
        }
        view.update(cx, |v, cx| v.open_settings(at, window, cx));
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Opens (or shows) worktree project `dir` in VimStorm mode, then closes the least recently
    /// shown clean worktree project while more than the worktree limit are open.
    fn open_worktree(&mut self, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let was_open = self.index_of(&dir).is_some();
        if let Err(e) = self.open(dir.clone(), None, window, cx) {
            eprintln!("[vimstorm] opening the worktree: {e:#}");
            let msg = format!("Couldn't open {}: {e:#}", dir.display());
            popups::notify(Balloon::error("Open Worktree", msg), window, cx);
            return;
        }
        if !was_open && let Some(ix) = self.index_of(&dir) {
            self.open[ix].worktree = true;
        }
        self.trim_worktrees(window, cx);
    }

    /// Whether open project `dir` was opened as a worktree project.
    pub fn is_worktree(&self, dir: &Path) -> bool {
        self.index_of(dir).is_some_and(|ix| self.open[ix].worktree)
    }

    /// Closes the least recently shown clean worktree project while more than the worktree limit
    /// are open: each candidate in turn is asked (Lua: unsaved buffers, terminal jobs; git:
    /// uncommitted files); the first clean one goes. None clean: all stay.
    fn trim_worktrees(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let flags: Vec<bool> = self.open.iter().map(|o| o.worktree).collect();
        let candidates = lru_candidates(&flags, &self.mru, self.active, MAX_WORKTREES);
        if candidates.is_empty() {
            return;
        }
        let asked: Vec<(PathBuf, Option<crate::nvim::Rpc>)> = candidates
            .iter()
            .map(|&i| {
                let o = &self.open[i];
                (o.real.clone(), o.ws().map(|ws| ws.read(cx).rpc().clone()))
            })
            .collect();
        cx.spawn_in(window, async move |this, cx| {
            for (real, rpc) in asked {
                if is_clean(&real, rpc, cx).await {
                    let _ = this.update_in(cx, |p, window, cx| {
                        if let Some(ix) = p.open.iter().position(|o| o.real == real)
                            && ix != p.active
                        {
                            p.remove(ix, window, cx);
                        }
                    });
                    return;
                }
            }
        })
        .detach();
    }

    /// Whether closing the last project quit the app (tests: GPUI's test platform doesn't quit).
    pub fn quitting(&self) -> bool {
        self.quitting
    }

    /// Every running open project's workspace, in open order.
    pub fn workspaces(&self) -> Vec<Entity<Workspace>> {
        self.open.iter().filter_map(|o| o.ws().cloned()).collect()
    }

    /// Whether open project `dir` runs (restored ones start when first shown).
    pub fn is_running(&self, dir: &Path) -> bool {
        self.index_of(dir)
            .is_some_and(|ix| self.open[ix].run.is_some())
    }

    /// Remembers the open set for the next launch without a path (off the UI thread). Not while
    /// the app quits: projects closing one by one as their nvims exit would shrink it.
    fn save_set(&self, cx: &mut App) {
        let quitting = self.quitting
            || cx
                .try_global::<Launcher>()
                .is_some_and(|l| l.nvims.is_quitting());
        if quitting {
            return;
        }
        // a cloud workspace is the box's: the next launch opens it from the Factory again; a
        // folder by its real path, whatever path opened it (one folder, one key)
        let set = SavedSet {
            open: self
                .open
                .iter()
                .filter(|o| o.remote.is_none())
                .map(|o| o.real.clone())
                .collect(),
            active: self
                .open
                .get(self.active)
                .filter(|o| o.remote.is_none())
                .map(|o| o.real.clone()),
        };
        let home = state_home(cx);
        let memory = self.memory.saved(|real| {
            self.open
                .iter()
                .any(|o| o.remote.is_some() && o.real == real)
        });
        // the latest wins: writes run in order, stale ones are skipped
        let saver = cx.default_global::<SetSaver>().clone();
        let generation = saver.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        cx.background_spawn(async move {
            let _one = saver.1.lock();
            if saver.0.load(std::sync::atomic::Ordering::SeqCst) == generation {
                set.save(home.as_deref());
                memory.write(&crate::shell::recent::state_dir(home.as_deref()));
            }
        })
        .detach();
    }

    /// The feed's local sessions starting (a launch, from the Board or the Abe chat): each one's
    /// workspace on the rail at once, its tile pulsing while it launches; started when first
    /// shown (its worktree there by then).
    fn launches_seen(&mut self, cx: &mut Context<Self>) {
        if self.welcome.is_some() || self.open.is_empty() {
            return;
        }
        let Some(feed) = cx.try_global::<crate::factory::WorkspaceFeed>() else {
            return;
        };
        let starting: Vec<PathBuf> = feed
            .workspaces
            .iter()
            .filter(|l| {
                l.state == crate::factory::WorkspaceState::Starting
                    && l.box_.is_none()
                    && !l.root.is_empty()
            })
            .map(|l| PathBuf::from(&l.root))
            .collect();
        let mut added = false;
        for dir in starting {
            let real = real_path(&dir);
            if self.index_of(&dir).is_some() || !self.launched.insert(real.clone()) {
                continue;
            }
            self.open.push(OpenProject::with_real(dir, real, None));
            self.mru.push(self.open.len() - 1);
            added = true;
        }
        if added {
            self.save_set(cx);
            cx.notify();
        }
    }

    /// The open projects' dirs, in open order.
    pub fn dirs(&self) -> Vec<PathBuf> {
        self.open.iter().map(|o| o.dir.clone()).collect()
    }

    /// The shown workspace's dir, if any.
    pub fn shown_dir(&self) -> Option<PathBuf> {
        self.open.get(self.active).map(|o| o.dir.clone())
    }

    /// The open project at `dir` (any path to its folder). Paths as opened / canonical ones match
    /// without touching the disk.
    fn index_of(&self, dir: &Path) -> Option<usize> {
        let same = |o: &OpenProject| o.dir == dir || o.real == dir;
        if let Some(ix) = self.open.iter().position(same) {
            return Some(ix);
        }
        let real = real_path(dir);
        self.open.iter().position(|o| o.real == real)
    }

    /// Starts a project's workspace around `nvim` (hidden unless it's the first).
    fn start(
        &mut self,
        nvim: Nvim,
        events: mpsc::UnboundedReceiver<NvimEvent>,
        dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Running {
        let quitter = nvim.quitter();
        if let Some(l) = cx.try_global::<Launcher>() {
            l.nvims.insert(dir.clone(), quitter.clone());
        }
        // a new editor takes the keyboard: the shown project keeps it until the switch (which
        // remembers it there)
        let shown_focus = window.focused(cx).filter(|_| !self.open.is_empty());
        let ws = cx.new(|cx| {
            let mut ws = Workspace::new(nvim, events, dir.clone(), window, cx);
            ws.set_managed();
            ws
        });
        {
            let rpc = ws.read(cx).rpc().clone();
            send_feel(&rpc, cx);
            // a look the bridge sent before this project opened
            crate::look::tell_nvim(&rpc, cx);
        }
        if let Some(f) = shown_focus {
            window.focus(&f, cx);
        }
        let covers = {
            let (popups, pickers) = (ws.read(cx).popups().clone(), ws.read(cx).pickers().clone());
            [
                cx.observe(&popups, |p, _, cx| p.cover_factory(cx)),
                cx.observe(&pickers, |p, _, cx| p.cover_factory(cx)),
            ]
        };
        let sub = cx.subscribe_in(&ws, window, |p, ws, ev, window, cx| match ev {
            WorkspaceEvent::Exited => {
                if let Some(ix) = p.open.iter().position(|o| o.is(ws)) {
                    // (not a Close Project: that takes it out before its nvim quits; nor the
                    // app's quit, which said why)
                    if crate::app::reason().is_none() {
                        let dir = p.open[ix].dir.display();
                        if p.open.len() == 1 && !Self::can_welcome(cx) {
                            // the last one: that's why the app goes
                            crate::app::quitting(format!("nvim of {dir} exited"));
                        } else {
                            crate::app::line(&format!("nvim of {dir} exited: its project closes"));
                        }
                    }
                    p.remove(ix, window, cx);
                }
            }
            WorkspaceEvent::PaneWanted(tab) => p.hand_pane(ws.clone(), *tab, true, window, cx),
            WorkspaceEvent::Retry => p.retry_remote(ws, None, window, cx),
            WorkspaceEvent::Reattach(tried) => p.retry_remote(ws, Some(tried.clone()), window, cx),
            // The bridge runs `abe session download` and opens the copy here
            WorkspaceEvent::Download(id) => {
                let factory = p.ensure_factory(window, cx);
                factory.update(cx, |v, cx| {
                    v.send_input(crate::factory::UserInput::Click { id: id.clone() }, cx);
                });
            }
        });
        // the window's close button closes the shown project (WebStorm: closing a project
        // window); each new editor registers its own handler, so this one goes after it
        window.on_window_should_close(cx, |window, cx| {
            crate::app::line("the window's close button: Close Project");
            close_active(None, window, cx);
            false
        });
        let first = self.open.is_empty();
        if !first {
            // hidden until shown
            ws.update(cx, |ws, cx| {
                ws.set_active(false, window, cx);
                ws.forget_focus();
            });
        }
        if let Some(f) = cx.try_global::<Launcher>().and_then(|l| l.on_open.clone())
            && !first
        {
            let ws = ws.clone();
            cx.defer(move |cx| f(ws, cx));
        }
        Running {
            ws,
            quitter,
            _sub: sub,
            _covers: covers,
        }
    }

    /// Starts restored project `ix` (not running yet), opening `file` in it.
    fn start_at(
        &mut self,
        ix: usize,
        file: Option<&Path>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<()> {
        let dir = self.open[ix].dir.clone();
        let remote = self.open[ix].remote.clone();
        let launch = remote.as_ref().map(|a| a.nvim.clone());
        let (nvim, events) = start_nvim(&dir, file, launch, cx)?;
        let run = self.start(nvim, events, dir, window, cx);
        if let Some(a) = remote {
            // Download locally clicks in the bridge; with none to run it, the button is grey
            let a = if !crate::factory::BridgeCommand::available(cx) && a.download.is_some() {
                std::sync::Arc::new(crate::shell::remote::Attach {
                    download: None,
                    ..(*a).clone()
                })
            } else {
                a
            };
            run.ws.update(cx, |ws, cx| ws.set_remote(a, cx));
        }
        self.open[ix].run = Some(run);
        Ok(())
    }

    /// ⌃W on a cloud session: its workspace opened on its box's folder `dir`, everything
    /// run through `attach`; an open one is shown. Another box's at the same folder is refused
    /// (one at a time: the folder names the project).
    fn open_attached(
        &mut self,
        dir: PathBuf,
        attach: crate::shell::remote::Attach,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(ix) = self.index_of(&dir) {
            match &self.open[ix].remote {
                Some(a) if a.box_ == attach.box_ => self.activate(ix, window, cx),
                _ => {
                    let msg = format!(
                        "{} is open already: close it (⌘Q) to open {}'s workspace",
                        dir.display(),
                        attach.box_.name
                    );
                    popups::notify(Balloon::error("Open Workspace", msg), window, cx);
                }
            }
            return;
        }
        let attach = std::sync::Arc::new(attach);
        crate::shell::remote::register(&dir, attach.clone());
        let mut open = OpenProject::with_real(dir.clone(), dir.clone(), None);
        open.remote = Some(attach);
        self.open.push(open);
        let ix = self.open.len() - 1;
        if let Err(e) = self.start_at(ix, None, window, cx) {
            self.open.pop();
            crate::shell::remote::unregister(&dir);
            let msg = format!("Couldn't open {}: {e:#}", dir.display());
            popups::notify(Balloon::error("Open Workspace", msg), window, cx);
            return;
        }
        self.pending = None;
        self.show(ix, window, cx);
    }

    /// Retry ⏎ on a cloud workspace that couldn't connect, or its next try (`tried`): its
    /// Neovim started again in place.
    fn retry_remote(
        &mut self,
        ws: &Entity<Workspace>,
        tried: Option<crate::shell::remote::Tried>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(ix) = self.open.iter().position(|o| o.is(ws)) else {
            return;
        };
        let old = self.open[ix].run.take();
        if let Err(e) = self.start_at(ix, None, window, cx) {
            self.open[ix].run = old;
            // a try that could not start: RemoteState fails (Retry again)
            if tried.is_some() {
                ws.update(cx, |ws, cx| ws.remote_failed(&format!("{e:#}"), cx));
            }
            let msg = format!("Couldn't open {}: {e:#}", self.open[ix].dir.display());
            popups::notify(Balloon::error("Open Workspace", msg), window, cx);
            return;
        }
        // An automatic try goes on from the ones before; it takes the keyboard only from
        // its own RemoteState (not from the Factory view shown over it meanwhile)
        let take_keys = tried.is_none() || !self.factory_shown();
        if let (Some(tried), Some(new)) = (tried, self.open[ix].ws().cloned()) {
            new.update(cx, |ws, cx| ws.carry_remote(tried, cx));
        }
        if ix == self.active
            && let Some(new) = self.open[ix].ws().cloned()
        {
            new.update(cx, |ws, cx| {
                ws.set_active(true, window, cx);
                if take_keys {
                    ws.focus_editor(window, cx);
                }
            });
        }
        // the one that never answered: gone for good
        if let Some(old) = old {
            let quitter = old.quitter.clone();
            cx.background_spawn(async move { quitter.quit(CLOSE_QUIT_TIMEOUT) })
                .detach();
        }
        window.refresh();
        cx.notify();
    }

    fn open_or_tell(&mut self, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        if let Err(e) = self.open(dir.clone(), None, window, cx) {
            eprintln!("[vimstorm] opening the project: {e:#}");
            let msg = format!("Couldn't open {}: {e:#}", dir.display());
            popups::notify(Balloon::error("Open Project", msg), window, cx);
        }
    }

    /// Open project `ix` (closing, the question answered) makes room for `dir`: `dir` starts and
    /// is shown, then `ix` goes ([`Self::remove`]) and `dir` takes its place in the order. When
    /// `dir` can't start, `ix` stays (the error in a balloon).
    fn replace(&mut self, ix: usize, dir: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let fail = |e: anyhow::Error, window: &mut Window, cx: &mut Context<Self>| {
            eprintln!("[vimstorm] opening the project: {e:#}");
            let msg = format!("Couldn't open {}: {e:#}", dir.display());
            popups::notify(Balloon::error("Open Project", msg), window, cx);
        };
        if !dir.is_dir() {
            return fail(anyhow::anyhow!("not a folder"), window, cx);
        }
        let real = real_path(&dir);
        // a project closed a moment ago: its session must be saved before it's read again
        let pending = cx
            .try_global::<Quitting>()
            .and_then(|q| q.0.lock().get(&real).cloned());
        if let Some(done) = pending {
            let old = self.open[ix].ws().map(|w| w.entity_id());
            cx.spawn_in(window, async move |this, cx| {
                let _ = done.await;
                let _ = this.update_in(cx, |p, window, cx| {
                    let at = p
                        .open
                        .iter()
                        .position(|o| o.ws().map(|w| w.entity_id()) == old);
                    match at {
                        Some(ix) => p.replace(ix, dir, window, cx),
                        None => p.open_or_tell(dir, window, cx),
                    }
                });
            })
            .detach();
            return;
        }
        self.open
            .push(OpenProject::with_real(dir.clone(), real, None));
        let new = self.open.len() - 1;
        if let Err(e) = self.start_at(new, None, window, cx) {
            self.open.pop();
            return fail(e, window, cx);
        }
        self.pending = None;
        self.show(new, window, cx);
        self.remove(ix, window, cx);
        self.move_entry(self.open.len() - 1, ix);
        self.save_set(cx);
    }

    /// Moves open project `from` to position `to` (the Cmd+< order), keeping `active` / `mru` on
    /// the same projects.
    fn move_entry(&mut self, from: usize, to: usize) {
        if from == to || from >= self.open.len() || to >= self.open.len() {
            return;
        }
        let p = self.open.remove(from);
        self.open.insert(to, p);
        let map = |i: usize| {
            if i == from {
                to
            } else if from > to && (to..from).contains(&i) {
                i + 1
            } else if from < to && (from + 1..=to).contains(&i) {
                i - 1
            } else {
                i
            }
        };
        self.mru = self.mru.iter().map(|&i| map(i)).collect();
        self.active = map(self.active);
    }

    /// Shows `dir` (starting its nvim if it isn't open) and opens `file` in it.
    fn open(
        &mut self,
        dir: PathBuf,
        file: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<()> {
        // a file shows in the code, whatever page the workspace had
        if file.is_some() {
            self.editor_next(&dir);
        }
        if let Some(ix) = self.index_of(&dir) {
            if self.open[ix].run.is_none() {
                self.start_at(ix, file.as_deref(), window, cx)?;
                self.pending = None;
                self.show(ix, window, cx);
                return Ok(());
            }
            self.activate(ix, window, cx);
            // a file shows in the code, whatever page the shown workspace had
            if file.is_some() && ix == self.active && self.page_now(cx) != Page::Code {
                self.show_page(Page::Code, window, cx);
            }
            if let Some(file) = file
                && let Some(ws) = self.open[ix].ws().cloned()
            {
                // from the bottom pane (the Board's host is nvim's current window): a split first
                lua::navigate(ws.read(cx).rpc(), "config.focus", "editor", Vec::new());
                lua::navigate(
                    ws.read(cx).rpc(),
                    "config.app.tree",
                    "open_files",
                    vec![Value::Array(vec![file.display().to_string().into()])],
                );
                ws.update(cx, |ws, cx| ws.focus_editor(window, cx));
            }
            return Ok(());
        }
        if !dir.is_dir() {
            anyhow::bail!("not a folder");
        }
        let real = real_path(&dir);
        // a project closed a moment ago: its session must be saved before it's read again
        let pending = cx
            .try_global::<Quitting>()
            .and_then(|q| q.0.lock().get(&real).cloned());
        if let Some(done) = pending {
            cx.spawn_in(window, async move |this, cx| {
                let _ = done.await;
                let _ = this.update_in(cx, |p, window, cx| {
                    if let Err(e) = p.open(dir.clone(), file, window, cx) {
                        let msg = format!("Couldn't open {}: {e:#}", dir.display());
                        popups::notify(Balloon::error("Open Project", msg), window, cx);
                    }
                });
            })
            .detach();
            return Ok(());
        }
        self.open.push(OpenProject::with_real(dir, real, None));
        let ix = self.open.len() - 1;
        if let Err(e) = self.start_at(ix, file.as_deref(), window, cx) {
            self.open.pop();
            return Err(e);
        }
        // (its editor laid out at the window's size already)
        self.pending = None;
        self.show(ix, window, cx);
        Ok(())
    }

    /// Shows open project `ix`: the shown one is hidden (keyboard place remembered, polls paused,
    /// FocusLost), `ix` gets the window size, its keyboard place back, FocusGained, the title.
    ///
    /// When the window was resized while `ix` was hidden, its nvim gets the new size first and
    /// the shown project stays until nvim drew at that size (at most [`RESIZE_WAIT`]): no frame
    /// with the old grids in the new layout.
    fn activate(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.open.len() {
            return;
        }
        self.pending = None;
        self.chat_keys_next = false;
        if ix == self.active || ix >= self.open.len() {
            return;
        }
        // restored, not started yet: starts now (laid out at the window's size)
        if self.open[ix].run.is_none() {
            match self.start_at(ix, None, window, cx) {
                Ok(()) => self.show(ix, window, cx),
                Err(e) => {
                    let msg = format!("Couldn't open {}: {e:#}", self.open[ix].dir.display());
                    popups::notify(Balloon::error("Open Project", msg), window, cx);
                }
            }
            return;
        }
        let viewport = window.viewport_size();
        let Some(new) = self.open[ix].ws().cloned() else {
            return;
        };
        let editor = new.read(cx).editor().clone();
        let resized = editor.update(cx, |e, _| {
            e.set_viewport(viewport);
            !e.screen_matches()
        });
        if !resized {
            self.show(ix, window, cx);
            return;
        }
        let target = new.downgrade();
        let done = move |p: &mut Projects, window: &mut Window, cx: &mut Context<Projects>| {
            if let Some(ix) = p
                .open
                .iter()
                .position(|o| o.ws().is_some_and(|w| w.downgrade() == target))
            {
                p.pending = None;
                p.show(ix, window, cx);
            }
        };
        let done2 = done.clone();
        let sub = cx.observe_in(&editor, window, move |p, e, window, cx| {
            if e.read(cx).screen_matches() {
                done(p, window, cx);
            }
        });
        let timeout = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(RESIZE_WAIT).await;
            let _ = this.update_in(cx, |p, window, cx| {
                if p.pending.is_some() {
                    done2(p, window, cx);
                }
            });
        });
        self.pending = Some((sub, timeout));
    }

    /// Shows open project `ix` now (see [`Self::activate`]).
    fn show(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        // from Welcome: the first project shown, nothing to hide
        let from_welcome = self.welcome.is_some();
        // (a project handed over before Welcome took the window at launch: the first one shown)
        let first = self.mru.is_empty();
        if (ix == self.active && !from_welcome && !first) || ix >= self.open.len() {
            return;
        }
        let Some(new) = self.open[ix].ws().cloned() else {
            return;
        };
        if from_welcome {
            self.leave_welcome(window, cx);
        } else if !first {
            // the page the one shown now had, for when it shows again
            self.note_page(cx);
        }
        // another project shown: its page comes back; the code at once (its keyboard is that
        // project's), the others once it is the shown one
        let page = self.page_of(ix, cx);
        if page == Page::Code {
            self.leave_factory(window, cx);
        }
        if let Some(old) = self
            .open
            .get(self.active)
            .filter(|_| !from_welcome && !first)
            .and_then(|o| o.ws().cloned())
        {
            // a workspace switch restores a maximized island
            old.update(cx, |ws, cx| {
                ws.restore_maximized(cx);
                ws.set_active(false, window, cx);
            });
        }
        self.active = ix;
        self.mru.retain(|&i| i != ix);
        self.mru.insert(0, ix);
        // a note about another workspace (none open for a row, ⌘Q's) goes with it
        self.say_browsed(None, cx);
        new.update(cx, |ws, cx| ws.set_active(true, window, cx));
        self.rehand_pane(window, cx);
        // a torn-out Chat follows the shown workspace
        if let Some(torn) = crate::shell::column::state(cx).torn {
            cx.defer(move |cx| {
                let _ = torn.update(cx, |_, w, _| w.refresh());
            });
        }
        self.switched = Some(std::time::Instant::now());
        self.save_set(cx);
        self.tell_factory_root(cx);
        // the bridge's `review` slot holds the shown project's PR review
        let review = new.read(cx).git().read(cx).review().clone();
        review.update(cx, |r, cx| r.reattach(cx));
        self.apply_kept_panel(cx);
        self.show_page(page, window, cx);
        // where Welcome's open said to land
        if let Some((dir, card)) = self.landing.take()
            && dir == self.open[ix].real
        {
            self.land(card, window, cx);
        }
        // the Factory view stays in a hidden Editor's place, with the keyboard
        if self.factory_shown
            && let Some((view, _)) = &self.factory
        {
            window.focus(&view.focus_handle(cx), cx);
        }
        // a rail move lands here: its Chat, the keys where they were
        let tile = rail::Tile::Workspace(self.open[ix].real.clone());
        if self.arrive.take().is_some_and(|t| t == tile) {
            self.chat_keys_next = false;
            self.arrived(&tile, window, cx);
        } else if first {
            // the launch's first workspace lands as a move does: the keys in Chat's composer
            self.rail_chat_keys(window, cx);
        }
        if std::mem::take(&mut self.chat_keys_next) {
            self.chat_keys(window, cx);
        }
        // (nothing reads the root while drawing, so its notify alone doesn't redraw the window)
        window.refresh();
    }

    /// A project opened from Welcome lands: the Factory view, on the card.
    fn land(&mut self, card: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.set_factory_shown(true, window, cx);
        if let Some(view) = self.factory().cloned() {
            view.update(cx, |v, cx| {
                v.open_in(
                    crate::factory::Slot::Main,
                    crate::factory::FIRST_SCREEN,
                    std::collections::BTreeMap::from([("card".to_owned(), card.to_string())]),
                    cx,
                );
            });
        }
    }

    /// Open project `ix`'s tab words and marks: the feed's look, else the folder's (or its branch's
    /// story).
    fn tab_parts(&self, ix: usize, cx: &App) -> crate::factory::TabParts {
        let o = &self.open[ix];
        let look = crate::factory::look_of(&o.dir, cx);
        // the branch as its status line last said it (a local one's HEAD before that)
        let branch = o
            .ws()
            .map(|ws| ws.read(cx).statusbar().read(cx).status().branch.clone())
            .filter(|b| !b.is_empty())
            .or_else(|| {
                o.remote
                    .is_none()
                    .then(|| crate::shell::recent::branch_of(&o.dir))
                    .flatten()
            })
            .unwrap_or_default();
        // a worktree's or a box's story from its branch; the main checkout its folder's
        let story = (o.remote.is_some() || o.dir.join(".git").is_file())
            .then(|| crate::factory::story_of_branch(&branch))
            .flatten();
        let fallback = story.unwrap_or_else(|| self.workspace_label(&o.dir));
        crate::factory::TabParts::of(look, fallback)
    }

    fn workspace_label(&self, path: &Path) -> String {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }

    /// Delete Working Files… (W-35): what would be lost (uncommitted files, commits no remote
    /// has) read off the UI thread, then the dialog; on `d` the project closed (asking first about
    /// unsaved buffers) and the worktree's files deleted (its branch too only with Also delete
    /// branch). The main checkout never is.
    fn delete_workspace_files(
        &mut self,
        path: PathBuf,
        _anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = self.workspace_label(&path);
        // its session while it runs (the feed's word: serve's, stopped from its Chat)
        let session = crate::factory::look_of(&path, cx).and_then(|l| {
            use crate::factory::WorkspaceState as S;
            match l.state {
                S::Running => Some("Running"),
                S::NeedsYou => Some("Needs you"),
                S::Starting => Some("Starting"),
                S::Idle | S::Done | S::Failed => None,
            }
        });
        let source = path.clone();
        let task = cx.background_executor().spawn(async move {
            let main = workspace_delete_refusal(&source)?;
            let loss = crate::git::worktree_loss(&source)?;
            Ok::<_, String>((main, loss))
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |_, window, cx| {
                let (main, loss) = match result {
                    Ok(found) => found,
                    Err(error) => {
                        popups::notify(Balloon::error("Keep workspace files", error), window, cx);
                        return;
                    }
                };
                let dialog = crate::shell::lifecycle::delete_dialog(&name, &loss, session);
                let root = this.clone();
                popups::open_dialog(dialog, window, cx, move |answer, window, cx| {
                    let Some(answer) = answer.filter(|a| a.id == "delete") else {
                        return;
                    };
                    let branch = answer.checked;
                    let _ = root.update(cx, |p, cx| {
                        let Some(ix) = p.index_of(&path) else { return };
                        // Close Project's native save/loss check runs before any editor goes away.
                        p.close_then(ix, None, window, cx, move |p, ix, window, cx| {
                            // the app stays on the main checkout when this was the last workspace
                            if p.open.len() < 2 && p.open(main.clone(), None, window, cx).is_err() {
                                return;
                            }
                            let Some(ix) =
                                p.index_of(&path).or(Some(ix)
                                    .filter(|&i| p.open.get(i).is_some_and(|o| o.dir == path)))
                            else {
                                return;
                            };
                            let real = p.open[ix].real.clone();
                            p.remove(ix, window, cx);
                            let closed = cx
                                .try_global::<Quitting>()
                                .and_then(|q| q.0.lock().get(&real).cloned());
                            cx.spawn_in(window, async move |_, cx| {
                                if let Some(closed) = closed {
                                    let _ = closed.await;
                                }
                                let result = cx
                                    .background_executor()
                                    .spawn(async move {
                                        crate::git::delete_worktree(&main, &path, branch)
                                    })
                                    .await;
                                let _ = cx.update(|window, cx| {
                                    if let Err(error) = result {
                                        popups::notify(
                                            Balloon::error("Working files retained", error),
                                            window,
                                            cx,
                                        );
                                    }
                                });
                            })
                            .detach();
                        });
                    });
                });
            });
        })
        .detach();
    }

    /// Closes open project `ix`, asking first when work would be lost.
    /// Close Project on the shown one ([`close_active`]): a repo's main checkout stays while a
    /// worktree of it is open, the status line saying how to quit.
    fn close_shown(&mut self, anchor: Option<Anchor>, window: &mut Window, cx: &mut Context<Self>) {
        let ix = self.active;
        let stays = self
            .open
            .get(ix)
            .filter(|o| o.is_main())
            .is_some_and(|main| {
                self.open
                    .iter()
                    .any(|o| o.remote.is_none() && o.of_main.as_ref() == Some(&main.real))
            });
        if stays {
            self.say_browsed(Some(MAIN_STAYS.to_owned()), cx);
            return;
        }
        self.close(ix, anchor, window, cx);
    }

    fn close(
        &mut self,
        ix: usize,
        anchor: Option<Anchor>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_then(ix, anchor, window, cx, |p, ix, window, cx| {
            p.remove(ix, window, cx)
        });
    }

    /// Asks first when closing open project `ix` would lose work (Lua saves what it can and
    /// counts the rest), then runs `then` with its index then (usually [`Self::remove`]).
    fn close_then(
        &mut self,
        ix: usize,
        anchor: Option<Anchor>,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Projects, usize, &mut Window, &mut Context<Projects>) + 'static,
    ) {
        let Some(p) = self.open.get(ix) else {
            return;
        };
        // restored, never shown: nothing to lose
        let Some(ws) = p.ws().cloned() else {
            then(self, ix, window, cx);
            return;
        };
        // a second Cmd+Q while Lua is still counting: one close (once the question shows, a
        // second Cmd+Q asks again in its place)
        if self.checking {
            return;
        }
        self.checking = true;
        let rpc = ws.read(cx).rpc().clone();
        let ws = ws.downgrade();
        // (the question is a centred dialog now, P-17: where it was asked from no longer places it)
        let _ = anchor;
        cx.spawn_in(window, async move |this, cx| {
            // Lua saves what it can and counts what would be lost; no answer: ask anyway
            let check = rpc.request(
                "nvim_exec_lua",
                vec![
                    "return require('config.app.toolbar').switch_check()".into(),
                    Value::Array(vec![]),
                ],
            );
            let timer = cx.background_executor().timer(CHECK_TIMEOUT);
            // what would be lost (none: nothing; Neovim silent: maybe something)
            let losses = match select(Box::pin(check), timer).await {
                Either::Left((Ok(v), _)) => {
                    let l = Losses::from_lua(&v);
                    l.question().map(|_| Some(l))
                }
                _ => Some(None),
            };
            let name = this
                .update(cx, |p, _| {
                    p.checking = false;
                    p.open
                        .iter()
                        .find(|o| o.ws().is_some_and(|w| w.entity_id() == ws.entity_id()))
                        .map(|o| p.workspace_label(&o.dir))
                })
                .ok()
                .flatten()
                .unwrap_or_default();
            if let Some(losses) = losses {
                let (tx, rx) = oneshot::channel();
                let asked = cx.update(|window, cx| {
                    // File > Close Project on a minimized window: the question must show
                    if std::env::var_os("VIMSTORM_BACKGROUND").is_none() {
                        window.activate_window();
                    }
                    // P-17: the one dialog, Cancel the default
                    let dialog = crate::shell::toolbar::close_dialog(losses, false, &name);
                    popups::open_dialog(dialog, window, cx, move |answer, _, _| {
                        let _ = tx.send(answer.is_some_and(|a| a.id == "close"));
                    });
                });
                if asked.is_err() || !rx.await.unwrap_or(false) {
                    return;
                }
            }
            let _ = this.update_in(cx, |p, window, cx| {
                if let Some(ix) = p
                    .open
                    .iter()
                    .position(|o| o.ws().is_some_and(|w| w.entity_id() == ws.entity_id()))
                {
                    then(p, ix, window, cx);
                }
            });
        })
        .detach();
    }

    /// Takes open project `ix` out: the next most recently used one is shown, its nvim saves and
    /// quits in the background (a no-op when it exited on its own), its shells close after that
    /// (the session reads their folders by pid), its entities go. The last one quits the app
    /// (whose quit saves and quits its nvim).
    fn remove(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        // the app quits (a signal, app menu Quit): the nvims exit one by one; the others are busy
        // quitting too, so nothing is shown / started in them (Lua calls into a quitting nvim)
        let app_quitting = self.quitting
            || cx
                .try_global::<Launcher>()
                .is_some_and(|l| l.nvims.is_quitting());
        let others_running = self
            .open
            .iter()
            .enumerate()
            .any(|(i, o)| i != ix && o.run.is_some());
        // the last one closing shows Welcome; the app's own quit still quits
        let mut to_welcome = !app_quitting && self.open.len() == 1 && Self::can_welcome(cx);
        if !to_welcome && (self.open.len() == 1 || (app_quitting && !others_running)) {
            crate::app::quitting(format!(
                "the last open project closed ({})",
                self.open[ix].dir.display()
            ));
            self.quitting = true;
            cx.quit();
            return;
        }
        self.pending = None;
        if ix == self.active && !app_quitting && !to_welcome {
            // a worktree's main checkout, else the next one in Cmd+< order (open order,
            // wrapping); a restored one starts now. One whose nvim can't start is passed over (it
            // stays restored, the error in a balloon): the shown project must run.
            let main = self.open[ix]
                .of_main
                .as_ref()
                .and_then(|m| self.open.iter().position(|o| o.is_main() && &o.real == m));
            let mut failed = Vec::new();
            let next = shown_after_close(self.open.len(), ix, main).find(|&next| {
                if self.open[next].run.is_some() {
                    return true;
                }
                match self.start_at(next, None, window, cx) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!("[vimstorm] opening the project: {e:#}");
                        failed.push(format!(
                            "Couldn't open {}: {e:#}",
                            self.open[next].dir.display()
                        ));
                        false
                    }
                }
            });
            match next {
                Some(next) => {
                    self.show(next, window, cx);
                    // the tile landed on: its Chat as it was left there
                    let tile = self.tile_now(cx);
                    self.apply_chat(&tile, window, cx);
                    for msg in failed {
                        popups::notify(Balloon::error("Open Project", msg), window, cx);
                    }
                }
                // nothing else can run: as if this was the last one
                None if Self::can_welcome(cx) => {
                    for msg in failed {
                        eprintln!("[vimstorm] {msg}");
                    }
                    to_welcome = true;
                }
                None => {
                    crate::app::quitting(format!(
                        "{} closed and no other open project could start",
                        self.open[ix].dir.display()
                    ));
                    self.quitting = true;
                    cx.quit();
                    return;
                }
            }
        }

        let p = self.open.remove(ix);
        // a closed workspace's page, session and colour are forgotten (a quit keeps them for the
        // next launch): opened again, it shows the code
        if !app_quitting {
            self.memory.closed(&rail::Tile::Workspace(p.real.clone()));
        }
        if to_welcome {
            // the others (restored, none could start) go too: Welcome is no project open
            self.open.clear();
        }
        if p.remote.is_some() {
            crate::shell::remote::unregister(&p.dir);
        }
        let shift = |i: usize| if i > ix { i - 1 } else { i };
        self.mru = self
            .mru
            .iter()
            .filter(|&&i| i != ix)
            .map(|&i| shift(i))
            .collect();
        self.active = shift(self.active).min(self.open.len().saturating_sub(1));
        if to_welcome {
            self.mru.clear();
            self.active = 0;
        }
        self.save_set(cx);
        if to_welcome {
            self.enter_welcome(window, cx);
        }
        let Some(run) = p.run else {
            cx.notify();
            return;
        };

        let terminal = run.ws.read(cx).terminal().clone();
        let nvims = cx.try_global::<Launcher>().map(|l| l.nvims.clone());
        let quitting = cx.default_global::<Quitting>().clone();
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_rx = done_rx.shared();
        quitting.0.lock().insert(p.real.clone(), done_rx.clone());
        let (dir, real, quitter) = (p.dir.clone(), p.real.clone(), run.quitter.clone());
        cx.background_spawn(async move {
            quitter.quit(CLOSE_QUIT_TIMEOUT);
            if let Some(n) = nvims {
                n.remove(&dir);
            }
            quitting.0.lock().remove(&real);
            let _ = done_tx.send(());
        })
        .detach();
        cx.spawn(async move |_, cx| {
            let _ = done_rx.await;
            terminal.update(cx, |t, cx| t.shut_down(cx));
        })
        .detach();
        drop(run);
        cx.notify();
    }

    /// Window shortcuts, including Ctrl+Cmd+O's workspace launcher, run before any surface
    /// or nvim sees the key.
    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let m = k.modifiers;
        // Welcome: its own window keys, every other one the screen's
        if self.open.is_empty() {
            if crate::kit::notation_of(k).as_deref() == Some("<D-,>") {
                self.open_settings(None, window, cx);
                cx.stop_propagation();
            } else if self.welcome_key(ev, window, cx) {
                cx.stop_propagation();
            }
            return;
        }
        // ⌘, from anywhere: Settings, the centred dialog
        if crate::kit::notation_of(k).as_deref() == Some("<D-,>") {
            self.open_settings(None, window, cx);
            cx.stop_propagation();
            return;
        }
        // Esc while a popup is open but lost the keyboard (a click outside kept a dialog with
        // text, a ⌘ key moved the focus): it closes, as when it has the keys
        let popups = self.active().map(|ws| ws.read(cx).popups().clone());
        let popup_open = popups.as_ref().is_some_and(|p| p.read(cx).is_open());
        if popup_open
            && k.key == "escape"
            && !(m.platform || m.control || m.alt || m.shift)
            && let Some(p) = popups
            && !p.read(cx).focus_handle(cx).contains_focused(window, cx)
        {
            p.update(cx, |p, cx| p.escape_unfocused(window, cx));
            cx.stop_propagation();
            return;
        }
        // the Settings dialog is modal: every key is its own while it is up, wherever the
        // keyboard went (a window key showed a surface under it; ⌘S is its OK, not nvim's save),
        // but the window's own Cmd keys and a popup's opened over it
        if !popup_open
            && crate::factory::settings_up(cx)
            && !crate::editor::input::window_cmd(k, cx)
            && let Some(view) = self.factory.as_ref().map(|(v, _)| v.clone())
            && !view.focus_handle(cx).contains_focused(window, cx)
        {
            window.focus(&view.focus_handle(cx), cx);
            view.update(cx, |v, cx| v.key_down(ev, window, cx));
            cx.stop_propagation();
            return;
        }
        // Command mode up without the keyboard (it went elsewhere without leaving the layer's
        // view): the layer closes, so no key stays with a layer that lost them
        if !popup_open
            && self
                .factory()
                .is_some_and(|v| v.read(cx).layer_up() && !v.read(cx).layer_has_keys(window, cx))
        {
            self.command_mode_gives_way(cx);
        }
        // the rail's keys: ⌘↑ ⌘↓ ⌘← ⌘→ ⌘§, ⌃1–⌃3, ⌘⇧2 ⌘⌥2 (not under a popup or a layer, or in
        // the Settings dialog above)
        if !popup_open && !self.command_mode_up(cx) && self.rail_key(k, window, cx) {
            cx.stop_propagation();
            return;
        }
        // ⌘⏎ over a tile: its menu (the rail never has the keys)
        if m.platform
            && !m.shift
            && !m.alt
            && !m.control
            && k.key == "enter"
            && self.rail_hover.is_some()
            && self.tile_menu_key(window, cx)
        {
            cx.stop_propagation();
            return;
        }
        // ⌥⌘⏎ maximizes the island with the keyboard and restores, Esc restores where it has
        // nothing else to do, an island key restores first; the Factory view's own keys
        if !self.factory_shown
            && let Some(ws) = self.active().cloned()
            && ws.update(cx, |ws, cx| ws.maximize_key(ev, window, cx))
        {
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if self.factory_shown && self.factory_maximize_key(ev, window, cx) {
            cx.stop_propagation();
            return;
        }
        // ⌃L (and ⌃⌥L) jumps along the story, but in an nvim split or a PTY (⌃W's workspace
        // jump is the rail's ⌘→ now)
        if let Some(everywhere) = crate::editor::input::jump_of(k)
            && self.jump_key(everywhere, window, cx)
        {
            cx.stop_propagation();
            return;
        }
        if self.colon_key(k, window, cx) {
            self.colon(ColonFrom::Surface, None, window, cx);
            cx.stop_propagation();
            return;
        }
        // ⌘⌥A: the Board, again back
        if m.platform && m.alt && !m.control && !m.shift && k.key.eq_ignore_ascii_case("a") {
            self.board_toggle(window, cx);
            cx.stop_propagation();
            return;
        }
        // the pane keys, WebStorm's tool-window keys: ⌘1 the tree (off the code the page's left
        // pane), ⌘3 Code's bottom panel's Git, ⌘4 Chat, ⌘T ⌃` the panel's Terminal; closed (the
        // panel on another tab too): shown with the keys, shown: the keys, with them: hidden
        if let Some(pane) = crate::shell::PaneKey::of(k, cx) {
            self.command_mode_gives_way(cx);
            self.pane_key(pane, window, cx);
            cx.stop_propagation();
            return;
        }
        // ⌃⌘← / ⌃⌘→ Chat / Claude Code (on Code with the keys in another pane: its tabs), ⌘⇧D
        // drag out: the Editor's Chat column; in the Factory view ⌃⌘← ⌃⌘→ its own column (Claude
        // Code the selected card's session attached), ⌘⇧D the view's own key
        if let Some(key) = crate::shell::column::ColumnKey::of(k, cx)
            .filter(|key| !self.factory_shown || *key != crate::shell::column::ColumnKey::Tear)
        {
            self.command_mode_gives_way(cx);
            if let Some(ws) = self.active().cloned() {
                ws.update(cx, |ws, cx| ws.column_key(key, window, cx));
            }
            cx.stop_propagation();
            return;
        }
        if !m.platform || m.control || m.alt {
            return;
        }
        match k.key.as_str() {
            // ⌘J: Code's bottom panel shown / hidden
            "j" if !m.shift => {
                self.command_mode_gives_way(cx);
                self.panel_toggle(window, cx);
            }
            // ⌘9 opened Git before 2.1, ⌘5 ⌘6 ⌘7 the drawer's tabs, ⌘< ⌘⇧< cycled the strip:
            // nothing now (the panel, the rail)
            "9" | "5" | "6" | "7" | "<" if !m.shift => {}
            ">" => {}
            // ⌘2 off the code: the page's main pane (on the code it is nvim's: the open file)
            "2" if !m.shift && self.factory_shown => {
                self.command_mode_gives_way(cx);
                self.page_keys(window, cx);
            }
            // (a held Cmd+Q repeats: it would close project after project)
            "q" if !m.shift && !ev.is_held => self.close_shown(None, window, cx),
            "q" if !m.shift => {}
            _ => return,
        }
        cx.stop_propagation();
    }

    /// The shown project's balloons, popups or pickers are up: the Factory's native page (a
    /// Sheet) hides meanwhile, as it would be drawn over them.
    fn cover_factory(&mut self, cx: &mut Context<Self>) {
        let (Some((view, _)), Some(ws)) = (&self.factory, self.active()) else {
            return;
        };
        let ws = ws.read(cx);
        let popups = ws.popups().read(cx);
        let covered = popups.is_open()
            || !popups.balloons().is_empty()
            || ws.pickers().read(cx).state(cx).is_some();
        view.clone().update(cx, |v, cx| v.set_covered(covered, cx));
    }

    /// The bridge's `chat` slot made (and its chat screen opened) once a column is shown (either
    /// mode: Terminal mode's Claude Code tab is Chat's session attached), with an `abe`
    /// 2.0; at the start and when the column's state or the bridge command changes, never in
    /// render. Kept from then on.
    fn ensure_chat_slot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.chat_slot.is_some()
            || !crate::factory::BridgeCommand::available(cx)
            || !crate::shell::column::state(cx).shown()
        {
            return;
        }
        let factory = self.ensure_factory(window, cx);
        let slot = factory.update(cx, |f, cx| {
            f.slot_view(crate::factory::Slot::Chat, window, cx)
        });
        self.chat_slot = Some(slot);
        cx.notify();
    }

    /// What the Chat column's Chat mode draws: the bridge's `chat` slot, a
    /// [`crate::factory::SlotView`] from the Factory view (filling its bounds, keys to the
    /// bridge), with its keyboard. None without an `abe` 2.0: the column's dim placeholder.
    fn chat_content(&self, cx: &App) -> Option<crate::shell::column::ChatContent> {
        if !crate::factory::BridgeCommand::available(cx) {
            return None;
        }
        let slot = self.chat_slot.clone()?;
        let focus = slot.focus_handle(cx);
        let factory = self.factory.as_ref().map(|(f, _)| f.downgrade());
        let mounted = factory.clone();
        let abe = factory.clone();
        Some(crate::shell::column::ChatContent {
            view: slot,
            focus,
            layer_up: std::rc::Rc::new(move |cx| {
                factory
                    .as_ref()
                    .and_then(|f| f.upgrade())
                    .is_some_and(|f| f.read(cx).layer_up())
            }),
            mounted: std::rc::Rc::new(move |cx| {
                mounted
                    .as_ref()
                    .and_then(|f| f.upgrade())
                    .is_some_and(|f| f.read(cx).slot_up(crate::factory::Slot::Chat))
            }),
            abe: std::rc::Rc::new(move |cx| {
                if let Some(f) = abe.as_ref().and_then(|f| f.upgrade()) {
                    f.update(cx, |f, cx| {
                        f.send_slot_input(
                            crate::factory::Slot::Chat,
                            crate::factory::UserInput::Key {
                                key: crate::shell::column::ABE_KEY.into(),
                            },
                            cx,
                        )
                    });
                }
            }),
        })
    }

    /// Whether the Factory view is the shown view (tests, the status bar).
    pub fn factory_shown(&self) -> bool {
        self.factory_shown
    }

    /// The Factory view, once it was first shown.
    pub fn factory(&self) -> Option<&Entity<FactoryView>> {
        self.factory.as_ref().map(|(v, _)| v)
    }

    /// ⌘⌥A: the Factory view shown in place of the project's body, or the Editor back.
    pub fn toggle_factory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_factory_shown(!self.factory_shown, window, cx);
    }

    /// The Run place: the shown workspace's card's run in the main area (the bridge's
    /// `run` screen, which takes the card from the workspace's branch). The stripe's `run` item
    /// routes here; the Board's item opens [`crate::factory::FIRST_SCREEN`] again.
    pub fn show_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_factory_shown(true, window, cx);
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| {
            v.open_in(
                crate::factory::Slot::Main,
                crate::factory::RUN_SCREEN,
                std::collections::BTreeMap::new(),
                cx,
            );
        });
    }

    /// Shows the Factory view (its bridge started the first time) or the Editor again; the
    /// editor's state is untouched and whatever had the keyboard gets it back.
    pub fn set_factory_shown(&mut self, show: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.set_factory_shown_as(show, true, window, cx);
    }

    /// [`Self::set_factory_shown`]; `land`: shown from the Editor, the screen lands
    /// (`ui/src/board/landing.ts`), as ⌘⌥A does (not a workspace's page shown again).
    fn set_factory_shown_as(
        &mut self,
        show: bool,
        land: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if show == self.factory_shown {
            return;
        }
        // a view switch restores a maximized island
        if let Some(ws) = self.active().cloned() {
            ws.update(cx, |ws, cx| ws.restore_maximized(cx));
        }
        self.restore_factory_maximized(cx);
        self.factory_shown = show;
        let mut shell = cx.try_global::<FactoryShell>().cloned().unwrap_or_default();
        shell.shown = show;
        cx.set_global(shell);
        // the column's shown / hidden is the view's own; Chat follows the selected card
        // in the Factory view, the shown workspace in the Editor
        crate::shell::column::set_state(cx, |s| s.factory_shown = show);
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| {
            v.set_shown(show, cx);
            v.set_chat_on_card(show, cx);
        });
        if show {
            // over the Editor, Command mode's layer already had the keyboard: keep where it came from
            if !view.read(cx).layer_up() || self.factory_return.is_none() {
                self.factory_return = window.focused(cx);
            }
            // the screen told it was shown from the Editor: it lands (`ui/src/board/landing.ts`)
            if land {
                view.update(cx, |v, cx| v.shown_from_editor(window, cx));
            }
            window.focus(&view.focus_handle(cx), cx);
        } else {
            self.rehand_pane(window, cx);
            match self.factory_return.take() {
                Some(f) => window.focus(&f, cx),
                None => {
                    if let Some(ws) = self.active().cloned() {
                        ws.update(cx, |w, cx| w.focus_editor(window, cx));
                    }
                }
            }
        }
        cx.notify();
    }

    /// The px the Factory view's Chat column takes off the Board's right (its width and the gap
    /// left of it): shown in the Factory view and docked, else 0.
    fn factory_column_room(&self, window: &Window, cx: &App) -> f32 {
        if !self.factory_shown {
            return 0.;
        }
        self.factory_column_room_shown(window, cx)
    }

    /// [`Self::factory_column_room`] as it is, or would be once the Factory view is shown
    /// (the width the bridge lays the Board out for while the Editor is shown).
    fn factory_column_room_shown(&self, window: &Window, cx: &App) -> f32 {
        if self.active().is_none() {
            return 0.;
        }
        // Prototype mode has no Chat of its own: the column, pinned on its chat
        let Some(want) = crate::shell::column::state(cx).factory_docked_width() else {
            return 0.;
        };
        let full = f32::from(window.viewport_size().width) - 2. * crate::shell::layout::MARGIN;
        let width = crate::shell::layout::Frame::chat_width_for(want, full);
        width + crate::shell::layout::GAP.get()
    }

    /// The Factory view made and its bridge started, not shown: its widgets reach the Editor's
    /// status bar (`Factory ◆ N`). Once at launch when an `abe` 2.0 is there; tests call it.
    pub fn follow_factory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| v.start(window, cx));
    }

    /// The Factory view (made the first time, its bridge not started yet) and its subscription.
    fn ensure_factory(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<FactoryView> {
        if let Some((v, _)) = &self.factory {
            return v.clone();
        }
        let board_room = self.factory_column_room_shown(window, cx) + RAIL_WIDTH;
        let view = cx.new(|cx| {
            let mut v = FactoryView::new(window, cx);
            v.chrome_height = look::TOOLBAR_HEIGHT + look::STATUS_BAR_HEIGHT + look::TAB_HEIGHT;
            // the bridge's `hello` has the Board's width beside the Chat column
            v.board_room = board_room;
            v.shown = false;
            v
        });
        let sub = cx.subscribe_in(
            &view,
            window,
            |p, view, ev: &FactoryEvent, window, cx| match ev {
                FactoryEvent::Shell(effect) => {
                    crate::shell::effects::run(p, view, effect.clone(), window, cx)
                }
                FactoryEvent::Layer(up) => p.factory_layer(*up, window, cx),
            },
        );
        self.factory = Some((view.clone(), sub));
        // the Git Log's PR review talks to its `review` slot
        cx.set_global(crate::git::window::ReviewBridge(view.downgrade()));
        // Esc in the Factory view's Chat column gives the keys back to the Board
        let board = view.focus_handle(cx);
        cx.set_global(crate::shell::column::BoardFocus(board));
        self.tell_factory_root(cx);
        view
    }

    /// The Factory's bridge runs its commands in the shown project's folder; its Chat slot
    /// follows the shown workspace (its folder, a cloud one's box).
    fn tell_factory_root(&mut self, cx: &mut Context<Self>) {
        let Some((view, _)) = &self.factory else {
            return;
        };
        // first shown since the launch: Chat on the session it was on there at the last quit
        let restore = self
            .open
            .get(self.active)
            .filter(|o| o.remote.is_none())
            .map(|o| rail::Tile::Workspace(o.real.clone()))
            .and_then(|t| self.memory.take_restore(&t));
        let shown = self.open.get(self.active).map(|o| {
            let box_ = o.remote.as_ref().map(|a| a.box_.name.clone());
            crate::factory::ShownProject {
                dir: o.dir.clone(),
                // a cloud workspace's folder is the box's: commands stay in the last local
                // one's
                root: box_
                    .is_none()
                    .then(|| o.real.to_string_lossy().into_owned()),
                box_,
            }
        });
        view.update(cx, |v, cx| {
            if let Some(session) = restore {
                v.restore_chat(session);
            }
            v.set_shown_project(shown, cx)
        });
    }

    /// `:` from the Editor: Abe 2.0's Command mode, over the Editor, with the keyboard
    /// until its layer closes. False (nothing changed) when no bridge runs.
    pub fn open_command_mode(
        &mut self,
        here: Option<crate::factory::EditorHere>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| v.start(window, cx));
        if !view.update(cx, |v, cx| v.open_command_mode(here, cx)) {
            return false;
        }
        if !self.factory_shown {
            self.factory_return = window.focused(cx);
            window.focus(&view.focus_handle(cx), cx);
        }
        cx.notify();
        true
    }

    /// Command mode's layer came up or closed: over the Editor, or from a slot of the Factory
    /// view's own (Chat's column), the keyboard goes back to where `:` was pressed once it closes.
    fn factory_layer(&mut self, up: bool, window: &mut Window, cx: &mut Context<Self>) {
        if up {
            // a layer is drawn over the Board: a maximized Chat or pane restores for it
            if matches!(
                self.factory_maximized(cx),
                Some(maximize::FactoryIsland::Chat | maximize::FactoryIsland::Pane)
            ) {
                self.restore_factory_maximized(cx);
            }
            self.layer_takes_keyboard(window, cx);
        }
        // (closed because the keyboard went elsewhere: it stays there)
        let held = self
            .factory
            .as_ref()
            .is_some_and(|(v, _)| v.focus_handle(cx).is_focused(window));
        let back = if up { None } else { self.layer_return.take() };
        if let Some(f) = back.filter(|_| self.factory_shown && held) {
            window.focus(&f, cx);
        } else if !up && !self.factory_shown && held {
            match self.factory_return.take() {
                Some(f) => window.focus(&f, cx),
                None => {
                    if let Some(ws) = self.active().cloned() {
                        ws.update(cx, |w, cx| w.focus_editor(window, cx));
                    }
                }
            }
        }
        cx.notify();
    }

    /// Command mode closes (the bridge told, as when the keyboard leaves it): a window key took
    /// the keys, or they left it already.
    fn command_mode_gives_way(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.factory().cloned() {
            view.update(cx, |v, cx| v.blur_layer(cx));
        }
    }

    /// Whether Abe 2.0's Command mode is up over the Editor or the Factory view.
    pub fn command_mode_up(&self, cx: &App) -> bool {
        self.factory
            .as_ref()
            .is_some_and(|(v, _)| v.read(cx).layer_up())
    }

    /// The Editor shown again because something of the Editor is being shown (another project,
    /// the Board): the keyboard goes to what that shows, never back under the Factory view.
    fn leave_factory(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.factory_shown {
            self.factory_return = None;
            self.set_factory_shown(false, window, cx);
        }
    }

    /// A look from the bridge in force in every window and every project's nvim.
    pub fn apply_look(&mut self, look: crate::look::Look, cx: &mut Context<Self>) {
        if !crate::look::apply(look, cx) {
            return;
        }
        for ws in self.workspaces() {
            crate::look::tell_nvim(ws.read(cx).rpc(), cx);
        }
        cx.refresh_windows();
    }

    /// The open workspace whose project is `root` (a review's checkout), the same folder however
    /// it was reached (`/tmp` and `/private/tmp`).
    pub(in crate::shell) fn workspace_at(&self, root: &str, cx: &App) -> Option<Entity<Workspace>> {
        let want = std::path::Path::new(root);
        let real = want.canonicalize().unwrap_or_else(|_| want.to_owned());
        self.workspaces().into_iter().find(|ws| {
            let dir = ws.read(cx).project().clone();
            dir == want || dir.canonicalize().is_ok_and(|d| d == real)
        })
    }

    /// No project open: Welcome is shown.
    pub(in crate::shell) fn on_welcome(&self) -> bool {
        self.open.is_empty()
    }

    /// A project the bridge opens (`open-project`): shown, attached to its box when it says so;
    /// from Welcome's card the Factory view lands on that card once the project shows (now, or
    /// once a closed nvim of it is done saving), and with a hidden Editor on the Board. Another
    /// open workspace shows its own page ([`pages`]); the shown one, or a new one, the Editor.
    pub(in crate::shell) fn open_from_bridge(
        &mut self,
        path: PathBuf,
        attach: Option<crate::shell::remote::Attach>,
        chat: bool,
        card: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.index_of(&path).is_none_or(|ix| ix == self.active) {
            self.set_factory_shown(false, window, cx);
        }
        self.landing = card.map(|c| (real_path(&path), c));
        match attach {
            Some(attach) => self.open_attached(path, attach, window, cx),
            None => self.open_or_tell(path, window, cx),
        }
        if chat {
            self.land_with_chat(window, cx);
        }
    }

    /// A file the bridge opens in the shown project (`open-file` with no line).
    pub(in crate::shell) fn open_in_shown(
        &mut self,
        file: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_factory_shown(false, window, cx);
        if let Some(dir) = self.open.get(self.active).map(|o| o.dir.clone())
            && let Err(e) = self.open(dir, Some(file), window, cx)
        {
            popups::notify(Balloon::error("Open File", format!("{e:#}")), window, cx);
        }
    }

    /// The Editor shown for something the bridge sends there; the keyboard never goes back
    /// under the Factory view.
    pub(in crate::shell) fn editor_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.factory_return = None;
        self.set_factory_shown(false, window, cx);
        if self.page_now(cx) != Page::Code {
            self.show_page(Page::Code, window, cx);
        }
    }

    /// A Terminal tab running `argv` (the bridge's `terminal-tab`: a box attached): the shown
    /// workspace's Terminal (Code's panel) on the new tab with the keyboard. `abe` is the
    /// bridge's own, with its environment; the tab runs on this Mac even in a cloud workspace.
    pub(in crate::shell) fn terminal_tab(
        &mut self,
        mut argv: Vec<String>,
        title: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if argv.is_empty() {
            return;
        }
        let mut env = Vec::new();
        if argv[0] == "abe" {
            let abe = cx
                .try_global::<crate::factory::BridgeCommand>()
                .cloned()
                .unwrap_or_else(crate::factory::BridgeCommand::from_env);
            argv[0] = abe.program.to_string_lossy().into_owned();
            env = abe.env;
        }
        self.leave_factory(window, cx);
        let Some(ws) = self.active().cloned() else {
            return;
        };
        let terminal = ws.read(cx).terminal().clone();
        terminal.update(cx, |t, cx| t.run_local_tab(argv, env, title, window, cx));
        // the Terminal is Code's panel's
        self.panel_on(crate::shell::PanelTab::Terminal, window, cx);
    }

    /// Quit VimStorm (the app menu): asks first when any open project would lose work (each
    /// project's Lua saves what it can and counts the rest), then quits; the app's quit saves
    /// every project's session and quits its nvim.
    fn quit_app(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rpcs: Vec<_> = self
            .workspaces()
            .iter()
            .map(|ws| ws.read(cx).rpc().clone())
            .collect();
        cx.spawn_in(window, async move |this, cx| {
            let checks = rpcs.into_iter().map(|rpc| {
                let timer = cx.background_executor().timer(CHECK_TIMEOUT);
                async move {
                    let check = rpc.request(
                        "nvim_exec_lua",
                        vec![
                            "return require('config.app.toolbar').switch_check()".into(),
                            Value::Array(vec![]),
                        ],
                    );
                    match select(Box::pin(check), timer).await {
                        Either::Left((Ok(v), _)) => Some(Losses::from_lua(&v)),
                        _ => None,
                    }
                }
            });
            let all = futures::future::join_all(checks).await;
            let projects = all.len();
            let losses = if all.iter().any(Option::is_none) {
                Some(None)
            } else {
                let sum = all.iter().flatten().fold(Losses::default(), |a, l| Losses {
                    jobs: a.jobs + l.jobs,
                    unsaved: a.unsaved + l.unsaved,
                });
                sum.question().map(|_| Some(sum))
            };
            if let Some(losses) = losses {
                let (tx, rx) = oneshot::channel();
                let asked = cx.update(|window, cx| {
                    // P-17: the one dialog, Cancel the default
                    let name = crate::kit::plural(projects, "open project");
                    let dialog = crate::shell::toolbar::close_dialog(losses, true, &name);
                    popups::open_dialog(dialog, window, cx, move |answer, _, _| {
                        let _ = tx.send(answer.is_some_and(|a| a.id == "close"));
                    });
                });
                if asked.is_err() || !rx.await.unwrap_or(false) {
                    return;
                }
            }
            let _ = this.update(cx, |p, cx| {
                crate::app::quitting(format!(
                    "Quit VimStorm ({})",
                    crate::kit::plural(projects, "open project")
                ));
                p.quitting = true;
                cx.quit();
            });
        })
        .detach();
    }
}

impl Render for Projects {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.open.is_empty() {
            return self.render_welcome(window, cx);
        }
        // the shown workspace's page as drawn: what it shows again ([`pages`])
        self.note_page(cx);
        if let Some(at) = self.switched.take() {
            crate::app::mark(&format!(
                "project switch -> render {:.1} ms",
                at.elapsed().as_secs_f64() * 1000.
            ));
            let me = cx.entity().downgrade();
            window.on_next_frame(move |_, cx| {
                let took = at.elapsed();
                crate::app::mark(&format!(
                    "project switch -> frame {:.1} ms",
                    took.as_secs_f64() * 1000.
                ));
                let _ = me.update(cx, |p, _| p.last_switch = Some(took));
            });
        }
        let names = crate::shell::pane::WorkspaceNames(
            (0..self.open.len())
                .map(|ix| (self.open[ix].dir.clone(), self.tab_parts(ix, cx).name))
                .collect(),
        );
        if cx.try_global::<crate::shell::pane::WorkspaceNames>() != Some(&names) {
            cx.set_global(names);
        }
        self.header.sync(
            self.open
                .iter()
                .map(|o| {
                    (
                        o.dir.clone(),
                        o.remote.as_ref().map(|a| a.box_.name.clone()),
                    )
                })
                .collect(),
            cx,
        );
        self.name_titles(cx);
        // the rail at the left edge, the header's row right of it
        let rail_el = self.rail_element(window, cx);
        let header_el = self.header_element(cx);
        // the Factory view under the header's row, right of the rail: the Board (or a page of
        // the bridge's, Run, Card), Boxes or Pipelines filling it; its Chat column at the right.
        // A maximized island alone in the middle: the Board without the column, Chat the whole
        // middle
        use maximize::FactoryIsland as Max;
        let max = self.factory_maximized(cx);
        let usual_room = self.factory_column_room(window, cx);
        let margin = crate::shell::layout::MARGIN;
        let gap = crate::shell::layout::GAP.get();
        let top = look::TOOLBAR_HEIGHT.get() + look::TAB_HEIGHT;
        let column_room = match max {
            None | Some(Max::Pane) => usual_room,
            Some(Max::Chat) => f32::from(window.viewport_size().width) - RAIL_WIDTH - margin + gap,
            Some(Max::Board) => 0.,
        };
        // Boxes or Pipelines: the Factory view's pane filling the middle
        let factory_pane =
            (self.factory_shown && self.pane_place.is_some() && max != Some(Max::Chat))
                .then(|| self.factory_pane_element(column_room, window, cx))
                .flatten();
        let board_right = if max == Some(Max::Board) {
            0.
        } else {
            usual_room
        };
        if let Some((view, _)) = &self.factory {
            let chrome = look::TOOLBAR_HEIGHT + look::STATUS_BAR_HEIGHT + look::TAB_HEIGHT;
            // hidden, the Board's room as it will be shown (not maximized: that only lasts while
            // it is shown), so the bridge's column count never depends on the view shown
            let board_room = if self.factory_shown {
                board_right
            } else {
                self.factory_column_room_shown(window, cx)
            } + RAIL_WIDTH;
            view.update(cx, |v, _| {
                v.chrome_height = chrome;
                v.chrome_width = board_right + RAIL_WIDTH;
                v.board_room = board_room;
            });
        }
        let factory_column = (column_room > 0.
            && matches!(max, None | Some(Max::Chat | Max::Pane)))
        .then(|| self.active().map(|ws| ws.read(cx).column().clone()))
        .flatten()
        .map(|column| {
            let width = column_room - gap;
            div()
                .debug_selector(|| "factory-chat-column".into())
                .absolute()
                .top(px(top))
                .bottom(px(look::STATUS_BAR_HEIGHT.get() + margin))
                .right(px(margin))
                .w(px(width))
                .rounded(px(crate::shell::layout::ISLAND_RADIUS.get()))
                .border(px(crate::shell::layout::ISLAND_BORDER))
                .border_color(look::ISLAND_BORDER)
                .overflow_hidden()
                .occlude()
                .child(column)
        });
        // its left gap drags its width (not while an island is maximized)
        let column_gap = (max.is_none() && factory_column.is_some())
            .then(|| self.factory_column_gap(usual_room - gap, cx));
        // Chat mode's content for the shown workspace's column (the one seam, `chat_content`)
        if let Some(ws) = self.active().cloned() {
            let chat = self.chat_content(cx);
            let column = ws.read(cx).column().clone();
            column.update(cx, |c, cx| c.set_chat(chat, cx));
        }
        div()
            .id("projects")
            .relative()
            .size_full()
            .capture_key_down(cx.listener(Self::on_key_down))
            .children(self.open[self.active].ws().cloned())
            // the Factory view covers the Editor whole: the gaps and margins between its
            // islands (the Board, the bottom pane, the Chat column) show the window's frame
            .when(self.factory_shown, |d| {
                d.child(
                    div()
                        .debug_selector(|| "factory-backdrop".into())
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(px(look::TOOLBAR_HEIGHT.get()))
                        .bottom(px(look::STATUS_BAR_HEIGHT.get()))
                        .bg(crate::shell::layout::FRAME_BG)
                        .occlude(),
                )
            })
            // the Factory view in place of the body: the toolbar and the status bar stay; over
            // the Editor only its layer (Command mode), the Editor drawn under it
            .children(
                self.factory
                    .as_ref()
                    .filter(|(v, _)| self.factory_shown || v.read(cx).layer_up())
                    .map(|(view, _)| {
                        div()
                            .absolute()
                            .left(px(if self.factory_shown { RAIL_WIDTH } else { 0. }))
                            .right(px(if self.factory_shown { board_right } else { 0. }))
                            .top(px(if self.factory_shown {
                                top
                            } else {
                                look::TOOLBAR_HEIGHT.get()
                            }))
                            .bottom(px(look::STATUS_BAR_HEIGHT.get()))
                            .when(self.factory_shown, |d| d.occlude())
                            .child(view.clone())
                    }),
            )
            .children(factory_pane)
            .children(factory_column)
            .children(column_gap)
            .children(self.factory_maximized_label(cx))
            // the rail at the window's left edge and the header's row, on every view
            .child(rail_el)
            .child(header_el)
            .children(self.active().map(|ws| {
                div()
                    .absolute()
                    .inset_0()
                    .child(ws.read(cx).popups().clone())
            }))
            .children(self.active().map(|ws| {
                div()
                    .absolute()
                    .inset_0()
                    .child(ws.read(cx).pickers().clone())
            }))
            .into_any_element()
    }
}

/// Why a workspace's files can't be deleted at all: the main checkout. Else the main checkout the
/// worktree belongs to.
fn workspace_delete_refusal(path: &Path) -> Result<PathBuf, String> {
    let checkout = crate::git::checkout_of(path);
    if !checkout.git || real_path(&checkout.main) == real_path(path) {
        return Err("The main checkout stays; only an isolated worktree can be deleted".into());
    }
    Ok(checkout.main)
}

/// Starts nvim for a project the way the app starts them ([`Launcher`]; `file` opened in it).
/// Whether closing the project at `dir` loses nothing: its nvim (when it runs) has no unsaved
/// buffer or terminal job (Lua saves what it can first), and git has no uncommitted file there.
async fn is_clean(
    dir: &Path,
    rpc: Option<crate::nvim::Rpc>,
    cx: &mut gpui_kit::AsyncWindowContext,
) -> bool {
    if let Some(rpc) = rpc {
        let check = rpc.request(
            "nvim_exec_lua",
            vec![
                "return require('config.app.toolbar').switch_check()".into(),
                Value::Array(vec![]),
            ],
        );
        let timer = cx.background_executor().timer(CHECK_TIMEOUT);
        match select(Box::pin(check), timer).await {
            Either::Left((Ok(v), _)) if Losses::from_lua(&v).question().is_none() => {}
            _ => return false,
        }
    }
    let dir = dir.to_path_buf();
    cx.background_executor()
        .spawn(async move {
            std::process::Command::new("git")
                .args([
                    "--no-optional-locks",
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                ])
                .current_dir(&dir)
                .output()
                .is_ok_and(|o| o.status.success() && o.stdout.is_empty())
        })
        .await
}

fn start_nvim(
    dir: &Path,
    file: Option<&Path>,
    launch: Option<Vec<String>>,
    cx: &App,
) -> anyhow::Result<(Nvim, mpsc::UnboundedReceiver<NvimEvent>)> {
    let launcher = cx.try_global::<Launcher>().cloned();
    let mut cfg = match &launcher {
        Some(l) => l.template.clone(),
        None => NvimConfig::new(dir)?,
    };
    cfg.project = dir.to_path_buf();
    cfg.launch = launch;
    // the Feel known now: nvim loads only the configs of yours it has before `send_feel` arrives
    if let Some(feel) = cx.try_global::<Feel>() {
        cfg.env.extend(feel.spawn_env());
    }
    // `--listen <addr>` (VIMSTORM_LISTEN, debugging): the first nvim holds the address
    if let Some(i) = cfg.args.iter().position(|a| a == "--listen") {
        cfg.args.drain(i..(i + 2).min(cfg.args.len()));
    }
    if let Some(f) = file {
        cfg.args.push(f.display().to_string());
    }
    let (tx, rx) = mpsc::unbounded();
    let on_event = launcher.and_then(|l| l.on_event);
    let nvim = Nvim::start(&cfg, move |ev| {
        if let Some(f) = &on_event {
            f(&ev);
        }
        let _ = tx.unbounded_send(ev);
    })?;
    Ok((nvim, rx))
}

/// The Feel's switches into a project's nvim (`config/feel.lua`; VimStorm's until the bridge
/// says otherwise).
fn send_feel(rpc: &crate::nvim::Rpc, cx: &App) {
    let feel = cx.try_global::<Feel>().cloned().unwrap_or_default();
    // (through JSON: rmpv writes a struct as an array, Lua wants the keys)
    match serde_json::to_value(feel).map(rmpv::ext::to_value) {
        Ok(Ok(v)) => lua::call(rpc, "config.feel", "set", vec![v]),
        Ok(Err(e)) => eprintln!("[vimstorm] feel: {e}"),
        Err(e) => eprintln!("[vimstorm] feel: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_worktree_shows_its_main_checkout_else_the_next() {
        let order = |n, ix, main| shown_after_close(n, ix, main).collect::<Vec<_>>();
        // open: other, main, x, worktree (3, of main 1): its main first, then on from it
        assert_eq!(order(4, 3, Some(1)), [1, 0, 2]);
        // no main open: Cmd+< order
        assert_eq!(order(4, 3, None), [0, 1, 2]);
        assert_eq!(order(4, 1, None), [2, 3, 0]);
        assert_eq!(order(1, 0, None), Vec::<usize>::new());
    }

    #[test]
    fn saved_set_round_trips_without_dirs_that_are_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let state = root.join("state");
        assert_eq!(SavedSet::load(Some(&state)), None);
        let set = SavedSet {
            open: vec![a.clone(), root.join("gone"), b.clone()],
            active: Some(root.join("gone")),
        };
        set.save(Some(&state));
        assert_eq!(
            SavedSet::load(Some(&state)),
            Some(SavedSet {
                open: vec![a.clone(), b.clone()],
                active: Some(a.clone()),
            })
        );
    }

    #[test]
    fn a_launch_path_shows_beside_the_saved_set() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let state = root.join("state");
        let set = SavedSet {
            open: vec![a.clone(), b.clone()],
            active: Some(b.clone()),
        };
        set.save(Some(&state));
        // `open -a VimStorm <a>`: a, shown
        assert_eq!(
            launch_start(Some(a.clone()), Some(&state), true),
            Start::One(a.clone(), None)
        );
        // no path: the saved set
        assert_eq!(
            launch_start(None, Some(&state), true),
            Start::Restore(set.clone())
        );
        // the window keeps the saved set beside it: a in its place (by any path to it, kept as its
        // real folder), a new one last; the next launch without a path reopens them all
        let via = root.join("via");
        std::os::unix::fs::symlink(&a, &via).unwrap();
        assert_eq!(
            set.clone().with_launched(&via),
            SavedSet {
                open: vec![a.clone(), b.clone()],
                active: Some(a.clone()),
            }
        );
        let c = root.join("c");
        std::fs::create_dir_all(&c).unwrap();
        assert_eq!(
            set.clone().with_launched(&c),
            SavedSet {
                open: vec![a.clone(), b.clone(), c.clone()],
                active: Some(c.clone()),
            }
        );
        // nothing to reopen: Welcome with an `abe` 2.x, else a project
        std::fs::remove_file(SavedSet::path(Some(&state))).unwrap();
        assert_eq!(launch_start(None, Some(&state), true), Start::Welcome);
        assert!(matches!(
            launch_start(None, Some(&state), false),
            Start::One(..)
        ));
    }
}
