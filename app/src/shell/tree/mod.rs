//! Project tree (the Project tool window), drawn natively in its island; replaces the snacks
//! explorer of `config/tree.lua` in the app with the same behaviour:
//!
//! - ← / → (his k / ä) collapse / go to the parent, expand / go to the first child; l / ö and
//!   ↑ / ↓ move (L / Ö five rows; a count first: `22ö`, `3Ö` = 15 rows), PageUp / PageDown /
//!   Home / End, `gg` / `G` ([`crate::kit`]). Other letters do nothing.
//! - Enter / double-click: a folder opens / closes, a file opens in the editor (only then: moving
//!   never changes the editor, also in the search results). Esc clears a multi-selection, then
//!   the search, then goes back to the editor.
//! - `/` speed search over the whole project ([`search`]): results under their folders, fold
//!   like the tree; Esc / focus leaving closes it with the result selected in the full tree.
//! - Multi-selection ([`select`]): Shift+↑/↓, Shift+click, Cmd / Alt+click.
//! - File actions: `,n` new, Shift+F6 rename, F5 copy, F6 move, Backspace / Delete / Cmd+⌫
//!   delete (asks), Cmd+C / Cmd+X / Cmd+V copy / cut / paste files, drag and drop moves,
//!   Cmd+Shift+C Copy Path, Ctrl+Cmd+Shift+O Reveal in Finder, `,g` Select Opened File,
//!   right-click / Cmd+Enter the menu (built by `config/app/tree.lua`, drawn by the popups).
//!   Vim twins: `yy` copy, `x` cut, `P` paste, `dd` delete (asks), `rr` rename, `o` new.
//!   Rust does new / copy / paste / delete ([`ops`]); renames and moves go through Lua so the LSP
//!   servers update imports (Snacks.rename, today's mechanism); Lua closes deleted files' tabs.
//! - Look: WebStorm's metrics (`ui::theme` `TREE_*`), git status colors computed here
//!   (`git::status`), excluded / library-root rows tinted full width, error underlines from
//!   Lua's diagnostics (`config/problems.lua`), root row `name [module] ~/path`.
//! - Folders are re-listed when they change (polled), git status after file actions, window
//!   activation, saves (Lua) and index / HEAD changes. Open state, width and expanded folders
//!   go to Lua for the session (`config/session.lua`).

mod model;
mod ops;
mod search;
mod select;
mod view;

pub use model::{FsTree, Row};
pub use ops::USE_TRASH;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, KeyDownEvent, Pixels,
    Point, ScrollStrategy, Subscription, Task, UniformListScrollHandle, Window, point, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::EditorView;
use crate::factory::{Feel, TreeFeel};
use crate::git::{self, GitStatus};
use crate::kit::Anchor;
use crate::kit::{self, Step, Vim};
use crate::look;
use crate::nvim::lua;
use crate::popups::{self, Menu, MenuItem};
use crate::shell::layout::{Frame, Panels};
use crate::shell::{Surface, SurfaceCx};
use search::{Index, Results};
use select::Selection;

/// The Lua module on the other side.
const LUA: &str = "config.app.tree";
/// The tool window header ("Project ⌄") above the rows.
const HEADER: crate::look::Met = look::TOOL_WINDOW_HEADER_HEIGHT;
/// Space between the header and the first row: 30.png's first row starts 34.6 below the island
/// top (border 1 + header 31 + 2.6); half px is fine at 2x.
const TOP_PAD: f32 = 2.5;
/// How often folders are checked for changes.
const POLL: Duration = Duration::from_millis(500);
/// A leader key must follow `,` within nvim's `timeoutlen` (`config/options.lua`: 400 ms).
const LEADER_TIMEOUT: Duration = Duration::from_millis(400);
/// Expand All stops after this many folders.
const EXPAND_ALL_LIMIT: usize = 2000;
/// A cloud workspace's folders the box did not answer for are asked again after this.
const REMOTE_RETRY: Duration = Duration::from_secs(5);

/// What a cloud workspace's box answered a relist ([`TreeView::relist_remote`]).
struct Relisted {
    /// The tree's first walk was asked for.
    walk: bool,
    /// The walk's folders and their entries; None: not asked, or no answer.
    walked: Option<Vec<(PathBuf, Vec<model::Entry>)>>,
    /// The other folders asked for (None: no folder there).
    listed: Vec<(PathBuf, Option<Vec<model::Entry>>)>,
    /// The folders the box gave no answer for (asked again after [`REMOTE_RETRY`]).
    unanswered: Vec<PathBuf>,
}

/// A file's problems as `config/app/tree.lua` sends them.
#[derive(Debug, Deserialize, PartialEq)]
pub struct ProblemCount {
    pub path: String,
    #[serde(default)]
    pub errors: u32,
    #[serde(default)]
    pub warnings: u32,
}

/// `vimstorm.tree` payloads (`config/tree.lua`, `config/app/tree.lua`, `config/session.lua`).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TreeEvent {
    /// Show the panel; `focus`: and take the keyboard.
    Open {
        #[serde(default)]
        focus: bool,
    },
    /// Hide the panel (the keyboard goes back to the editor if the tree had it).
    Close,
    /// Shown: hide; hidden: show focused.
    Toggle,
    /// Show and take the keyboard.
    Focus,
    /// Show `file` selected (the current file when absent); `focus`: take the keyboard.
    Reveal {
        #[serde(default)]
        file: Option<String>,
        #[serde(default = "yes")]
        focus: bool,
        /// A folder: expand it too (`:e <dir>`, like snacks' netrw replacement).
        #[serde(default)]
        expand: bool,
    },
    /// `tree.autoReveal` (VS Code): the file the editor shows now; selected and scrolled to,
    /// its folders opened, the tree neither shown nor focused.
    Follow {
        file: String,
    },
    /// The session's tree: open or not, width, expanded folders (relative), focused.
    Restore {
        #[serde(default = "yes")]
        open: bool,
        #[serde(default)]
        width: Option<f64>,
        #[serde(default)]
        dirs: Vec<String>,
        #[serde(default)]
        focus: bool,
    },
    /// Git status may have changed (a save, a shell command).
    Git,
    /// Files with errors and their folders (absolute); each file's error and warning counts
    /// (every source: `tree.decorations = letters` shows them, VS Code's problem badge).
    Problems {
        #[serde(default)]
        paths: Vec<String>,
        #[serde(default, deserialize_with = "crate::editor::tabs::seq")]
        counts: Vec<ProblemCount>,
    },
    /// The working directory changed: the tree's root.
    Root {
        dir: String,
    },
    /// A menu item (`config/app/tree.lua` `menu`) on the current selection.
    Action {
        name: String,
    },
    /// Speed search for `text` (focused), as if typed after `/`.
    Search {
        text: String,
    },
    /// "New file or directory" was answered.
    Create {
        dir: String,
        name: String,
    },
    /// Lua renamed / moved files (LSP-aware): show the new place.
    Renamed {
        from: String,
        to: String,
    },
    Moved {
        dir: String,
    },
    /// Copy one path to a new name (F5 on one row).
    Copy {
        from: String,
        to: String,
    },
    /// Copy paths into a folder (paste, F5 on several rows).
    CopyInto {
        paths: Vec<String>,
        dir: String,
    },
    /// Delete was confirmed.
    Delete {
        paths: Vec<String>,
    },
    /// The repo's Abe folder (`abe workflow tree`, ADR 0033): `dir` shown first with Abe's head (none
    /// outside a main checkout), each workflow file's dim tag after its name.
    Abe {
        #[serde(default)]
        dir: Option<String>,
        #[serde(default, deserialize_with = "crate::editor::tabs::seq")]
        tags: Vec<AbeTag>,
    },
}

/// A workflow file's tag in the tree: whose it is and what it takes; `bad`: it fails the load check.
#[derive(Debug, Deserialize, PartialEq)]
pub struct AbeTag {
    pub path: String,
    pub tag: String,
    #[serde(default)]
    pub bad: bool,
}

fn yes() -> bool {
    true
}

/// The speed search (`/`) while it's open.
struct SearchState {
    query: String,
    /// The field has the keys (else the results list: after a click on a result).
    input: bool,
    index: Option<Arc<Index>>,
    /// Results of the current (non-empty) query.
    results: Option<Results>,
    folded: HashSet<Arc<Path>>,
    /// The text the shown results are for (matching runs in the background).
    results_for: Option<String>,
    /// The match running now; a newer one replaces it (stale results are dropped).
    matching: Option<Task<()>>,
    seq: u64,
    /// The pending match is for typed text: select its first match.
    typed: bool,
    walking: Option<Task<()>>,
    /// Files changed while walking: walk again after.
    rewalk: bool,
}

/// Rows being dragged (drag and drop moves them).
#[derive(Clone, Debug)]
pub struct DraggedPaths(pub Vec<Arc<Path>>);

pub struct TreeView {
    scx: SurfaceCx,
    focus: FocusHandle,
    tree: FsTree,
    rows: Vec<Row>,
    row_of: HashMap<Arc<Path>, usize>,
    sel: Selection,
    scroll: UniformListScrollHandle,
    search: Option<SearchState>,
    git: GitStatus,
    git_busy: bool,
    git_again: bool,
    problems: HashSet<PathBuf>,
    /// Each file's (errors, warnings) by absolute path (`config/problems.lua` counts).
    problem_counts: HashMap<PathBuf, (u32, u32)>,
    /// Folders not listed yet: has it anything to show (chevron)? Asked in the background when
    /// first drawn ([`TreeView::want_kids`]); render never touches the disk.
    kids: HashMap<Arc<Path>, bool>,
    /// Answers from before the last change, drawn until the new ones come in (no flicker).
    kids_stale: HashMap<Arc<Path>, bool>,
    /// Folders drawn with no answer yet, and the job asking for them.
    kids_pending: Vec<Arc<Path>>,
    kids_task: Option<Task<()>>,
    /// A cloud workspace's first walk asked for: its folders listed in one call.
    walked: bool,
    /// The header's "Project ⌄" and ⋮ as last painted (the menus open below them).
    header_title: Rc<Cell<Bounds<Pixels>>>,
    header_more: Rc<Cell<Bounds<Pixels>>>,
    /// `,` typed (when): the next key within `timeoutlen` is a leader key.
    leader: Option<Instant>,
    /// Pending Vim count / prefix (`22ö`, `gg`, `yy` / `dd` / `rr`).
    vim: Vim,
    /// The mouse is over the tree (the scrollbar shows).
    hovered: bool,
    /// Dragging the scrollbar thumb: (mouse y, scroll top) at the press.
    thumb_drag: Option<(f32, f32)>,
    /// A drag that started off the selection selects rows (from this anchor) as it goes.
    drag_select: Option<Arc<Path>>,
    /// A plain press on a row of a multi-selection: it becomes the only one on release, unless
    /// the press turned into a drag and drop.
    press_single: Option<Arc<Path>>,
    /// Drag-select past the list's edge: scrolling up (-1) / down (1), 0 = not.
    scroll_dir: i8,
    scroll_task: Option<Task<()>>,
    /// Folder mtimes seen by the last poll.
    mtimes: HashMap<PathBuf, Option<SystemTime>>,
    polling: bool,
    /// What Lua was last told (open, width, the open folders' generation).
    told: Option<(bool, i64, u64)>,
    editor: Option<Entity<EditorView>>,
    /// The folder poll (None while its project is hidden or the app is in the background).
    poller: Option<Task<()>>,
    /// Its project is the shown one / the app window is active: both, or no poll.
    project_active: bool,
    window_active: bool,
    /// The story of its workspace: the root row's name in its folder's place.
    story: Option<String>,
    /// Workflow files' tags (`abe workflow tree`): (words, fails the load check).
    tags: HashMap<PathBuf, (String, bool)>,
    /// The Feel's tree switches (VimStorm's until the bridge says).
    feel: TreeFeel,
    /// A plain press on a file row with `tree.singleClick`: opened on release unless it became a
    /// drag (move or drag-select).
    click_open: Option<Arc<Path>>,
    _subs: Vec<Subscription>,
}

impl TreeView {
    // Queries (tests) -----------------------------------------------------------------------

    /// The rows shown, as paths relative to the root ("" = the root row).
    pub fn row_paths(&self) -> Vec<String> {
        self.rows.iter().map(|r| self.rel(&r.path)).collect()
    }

    /// The rows shown.
    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    /// The selected row, relative ("" = root).
    pub fn cursor(&self) -> Option<String> {
        self.sel.cursor.as_ref().map(|p| self.rel(p))
    }

    /// The multi-selection, relative, sorted.
    pub fn selected(&self) -> Vec<String> {
        let mut v: Vec<String> = self.sel.multi().iter().map(|p| self.rel(p)).collect();
        v.sort();
        v
    }

    /// The search text while `/` is open.
    pub fn query(&self) -> Option<&str> {
        self.search.as_ref().map(|s| s.query.as_str())
    }

    /// The search text the shown results are for (matching runs in the background).
    pub fn results_query(&self) -> Option<&str> {
        self.search.as_ref().and_then(|s| s.results_for.as_deref())
    }

    /// Search open and the field has the keys.
    pub fn search_input(&self) -> bool {
        self.search.as_ref().is_some_and(|s| s.input)
    }

    /// Matches of the search text (None: no text / results not in yet).
    pub fn match_count(&self) -> Option<usize> {
        self.search
            .as_ref()
            .and_then(|s| s.results.as_ref())
            .map(|r| r.count)
    }

    /// The git status the colors come from.
    pub fn git(&self) -> &GitStatus {
        &self.git
    }

    pub fn root(&self) -> &Path {
        &self.tree.root
    }

    /// Row index of a relative path.
    pub fn row_index(&self, rel: &str) -> Option<usize> {
        let p = if rel.is_empty() {
            self.tree.root.clone()
        } else {
            self.tree.root.join(rel)
        };
        self.row_of.get(p.as_path()).copied()
    }

    /// First row on screen and the scroll offset (px from the top).
    pub fn scroll_top(&self) -> (usize, f32) {
        let y = -self.scroll.0.borrow().base_handle.offset().y.as_f32();
        ((y / look::TREE_ROW_HEIGHT).floor() as usize, y)
    }

    /// Window position of a row's text (the name's start + `x_in_name`), from the island.
    pub fn row_point(&self, ix: usize, x_in_name: f32) -> Option<Point<Pixels>> {
        let island = self.scx.geometry().layout.tree?;
        let row = self.rows.get(ix)?;
        let (_, top) = self.scroll_top();
        let search = if self.search.is_some() {
            look::TREE_ROW_HEIGHT.get()
        } else {
            0.
        };
        let y = island.origin.y.as_f32()
            + look::ISLAND_BORDER_WIDTH
            + HEADER
            + search
            + TOP_PAD
            + ix as f32 * look::TREE_ROW_HEIGHT
            - top
            + look::TREE_ROW_HEIGHT / 2.;
        let x = island.origin.x.as_f32()
            + look::ISLAND_BORDER_WIDTH
            + view::name_x(row.depth)
            + x_in_name;
        Some(point(px(x), px(y)))
    }

    /// Window position of a row's chevron (its center).
    pub fn chevron_point(&self, ix: usize) -> Option<Point<Pixels>> {
        let p = self.row_point(ix, 0.)?;
        let d = self.rows[ix].depth;
        Some(point(
            p.x - px(view::name_x(d) - view::chevron_x(d) - look::TREE_CHEVRON_SIZE / 2.),
            p.y,
        ))
    }

    /// Does row `ix` show a chevron (a folder with something in it)?
    pub fn has_chevron(&self, ix: usize) -> bool {
        self.rows.get(ix).is_some_and(|r| {
            r.dir
                && (r.is_root()
                    || match r.kids {
                        model::Kids::Yes => true,
                        model::Kids::No => false,
                        model::Kids::Unknown => self.kids_drawn(&r.path),
                    })
        })
    }

    /// The chevron drawn for a folder not listed yet: the background answer, else the one from
    /// before the last change, else yes (most folders have something in them).
    fn kids_drawn(&self, path: &Path) -> bool {
        self.kids
            .get(path)
            .or_else(|| self.kids_stale.get(path))
            .copied()
            .unwrap_or(true)
    }

    /// Asks (in the background, batched per frame) whether a drawn folder has anything to show.
    fn want_kids(&mut self, path: &Arc<Path>, cx: &mut Context<Self>) {
        if self.kids.contains_key(path) || self.kids_pending.contains(path) {
            return;
        }
        self.kids_pending.push(path.clone());
        if self.kids_task.is_some() {
            return;
        }
        // spawned now, runs after this frame's rows: one job for everything they asked (a cloud
        // workspace's: one call to its box, off the UI thread)
        let root = self.tree.root.clone();
        self.kids_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let Ok(batch) = this.update(cx, |t, _| std::mem::take(&mut t.kids_pending)) else {
                    return;
                };
                if batch.is_empty() {
                    let _ = this.update(cx, |t, _| t.kids_task = None);
                    return;
                }
                let job = cx.update(|cx| {
                    crate::shell::remote::background(&root, cx, move || {
                        model::has_children_all(batch)
                    })
                });
                let answers = job.await.unwrap_or_default();
                let _ = this.update(cx, |t, cx| {
                    for (p, k) in answers {
                        t.kids_stale.remove(&p);
                        t.kids.insert(p, k);
                    }
                    cx.notify();
                });
            }
        }));
    }

    /// The folders changed: ask again, drawing the old answers meanwhile.
    fn forget_kids(&mut self) {
        let old = std::mem::take(&mut self.kids);
        self.kids_stale.extend(old);
    }

    /// The `.idea` module name shown on the root row (when it differs from the folder's).
    pub fn module(&self) -> Option<String> {
        self.tree.excl.module.clone()
    }

    /// Does the path get the error underline?
    pub fn has_problem(&self, path: &Path) -> bool {
        self.problems.contains(path)
    }

    /// Test setup: selects a path (revealing it when it's not shown).
    pub fn test_select(&mut self, path: &Path, _window: &mut Window, cx: &mut Context<Self>) {
        match self
            .row_of
            .get_key_value(path)
            .map(|(k, &i)| (k.clone(), i))
        {
            Some((k, ix)) => {
                self.sel.set(Some(k));
                self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
                cx.notify();
            }
            None => self.select_path(path, cx),
        }
    }

    /// A path from Lua in the tree's spelling of the root (nvim may resolve symlinks the tree's
    /// root keeps, e.g. /var -> /private/var).
    fn local_path(&self, p: &Path) -> PathBuf {
        if p.starts_with(&self.tree.root) {
            return p.to_path_buf();
        }
        let (Ok(real), Ok(root)) = (p.canonicalize(), self.tree.root.canonicalize()) else {
            return p.to_path_buf();
        };
        match real.strip_prefix(&root) {
            Ok(rel) => self.tree.root.join(rel),
            Err(_) => p.to_path_buf(),
        }
    }

    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.tree.root)
            .map(|r| r.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string_lossy().into_owned())
    }

    // Panel -----------------------------------------------------------------------------------

    fn is_open(&self, cx: &App) -> bool {
        self.scx
            .workspace
            .upgrade()
            .is_some_and(|ws| ws.read(cx).tree_open(cx))
    }

    fn set_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self
            .scx
            .workspace
            .update(cx, |ws, cx| ws.set_tree_open(open, cx));
        if open {
            self.poll(cx);
        } else {
            if self.search.is_some() {
                self.close_search(true, cx);
            }
            if self.focus.contains_focused(window, cx) {
                self.scx.focus_editor(window, cx);
            }
        }
        self.tell_state(cx);
    }

    fn take_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_open(true, window, cx);
        window.focus(&self.focus, cx);
        if self.sel.cursor.is_none() {
            self.sel.set(self.rows.first().map(|r| r.path.clone()));
        }
        cx.notify();
    }

    /// Lua's copy of what the session saves (open, width, expanded folders), when it changed.
    fn tell_state(&mut self, cx: &mut Context<Self>) {
        let open = self.is_open(cx);
        let width = self
            .editor
            .as_ref()
            .map_or(0, |e| e.read(cx).panels().tree_width.round() as i64);
        // (called on every editor redraw: compare cheaply)
        let now = (open, width, self.tree.generation);
        if self.told == Some(now) {
            return;
        }
        let dirs = self.tree.open_rel();
        let v = map(vec![
            ("open", open.into()),
            ("width", width.into()),
            (
                "dirs",
                Value::Array(dirs.iter().map(|d| d.as_str().into()).collect()),
            ),
        ]);
        self.told = Some(now);
        self.scx.call(LUA, "state", vec![v]);
    }

    fn set_width(&mut self, width: f32, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.clone() else {
            return;
        };
        let inner = self.scx.geometry().layout.frame.inner.size.width.as_f32();
        editor.update(cx, |e, cx| {
            let w = if inner > 0. {
                Frame::tree_width_for(width, inner)
            } else {
                width
            };
            let p = Panels {
                tree_width: w,
                ..e.panels()
            };
            e.set_panels(p, cx);
        });
    }

    // Rows --------------------------------------------------------------------------------------

    /// Builds the rows again (tree or search results); `keep`: the selected row stays on its
    /// screen row (else where it is in the list).
    /// A cloud workspace's tree: its listings are the box's.
    fn remote(&self) -> bool {
        crate::shell::remote::attach_for(&self.tree.root).is_some()
    }

    /// Lists a cloud workspace's folders opened unlisted (`dirs`) on its box, off the UI thread,
    /// then draws them. The first time, the tree's walk: every folder up to the walk's limit in
    /// one call, so opening one of them or drawing its chevron asks the box nothing more.
    fn relist_remote(&mut self, dirs: Vec<PathBuf>, cx: &mut Context<Self>) {
        let root = self.tree.root.clone();
        let walk = !std::mem::replace(&mut self.walked, true);
        let task = crate::shell::remote::background(&root.clone(), cx, move || {
            let walked = if walk {
                model::walk_remote(&root, EXPAND_ALL_LIMIT)
            } else {
                None
            };
            if walk && walked.is_none() {
                // no answer from the box: the folders it would have listed can't be either
                return Relisted {
                    walk,
                    walked: None,
                    listed: Vec::new(),
                    unanswered: dirs,
                };
            }
            let rest: Vec<PathBuf> = dirs
                .into_iter()
                .filter(|d| !walked.iter().flatten().any(|(w, _)| w == d))
                .collect();
            let listed = if rest.is_empty() {
                Vec::new()
            } else {
                model::relist(rest.clone())
            };
            // the folders the box gave no answer for (the call failed)
            let unanswered = rest
                .into_iter()
                .filter(|d| !listed.iter().any(|(l, _)| l == d))
                .collect();
            Relisted {
                walk,
                walked,
                listed,
                unanswered,
            }
        });
        cx.spawn(async move |this, cx| {
            let Some(Relisted {
                walk,
                walked,
                listed,
                unanswered,
            }) = task.await
            else {
                return;
            };
            let again = this
                .update(cx, |t, cx| {
                    match walked {
                        Some(w) => t.tree.add_listed(w),
                        None if walk => t.walked = false,
                        None => {}
                    }
                    t.tree.apply_relist(listed);
                    t.forget_kids();
                    t.rebuild(true, cx);
                    // a speed search open: its index is these listings
                    if t.search.is_some() {
                        t.walk(cx);
                    }
                    cx.notify();
                    // unanswered ones are asked again a little later (the box may be waking)
                    (!unanswered.is_empty()).then_some(unanswered)
                })
                .ok()
                .flatten();
            if let Some(dirs) = again {
                cx.background_executor().timer(REMOTE_RETRY).await;
                let _ = this.update(cx, |t, cx| {
                    t.tree.unlisted_again(dirs);
                    t.rebuild(true, cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn rebuild(&mut self, keep: bool, cx: &mut Context<Self>) {
        let unlisted = self.tree.take_unlisted();
        if !unlisted.is_empty() {
            self.relist_remote(unlisted, cx);
        }
        let screen = if keep { self.cursor_screen_y() } else { None };
        if self.search.is_none() {
            self.tree.list_chains();
        }
        self.rows = match self
            .search
            .as_ref()
            .and_then(|s| Some((s, s.index.as_ref()?, s.results.as_ref()?)))
        {
            Some((s, index, res)) => search::rows(index, res, &s.folded, &self.tree.excl),
            None => self.tree.rows(),
        };
        self.row_of = self
            .rows
            .iter()
            .enumerate()
            .map(|(i, r)| (r.path.clone(), i))
            .collect();
        // a selected row that's gone: its closest folder still shown
        if let Some(c) = self.sel.cursor.clone()
            && !self.row_of.contains_key(&c)
        {
            let up = c
                .ancestors()
                .skip(1)
                .find_map(|a| self.row_of.get_key_value(a).map(|(k, _)| k.clone()));
            self.sel
                .set(up.or_else(|| self.rows.first().map(|r| r.path.clone())));
        }
        self.sel.retain(&self.rows);
        if let Some(y) = screen {
            self.put_cursor_at(y);
        }
        cx.notify();
    }

    fn cursor_ix(&self) -> Option<usize> {
        self.sel
            .cursor
            .as_ref()
            .and_then(|c| self.row_of.get(c).copied())
    }

    fn cursor_row(&self) -> Option<&Row> {
        self.cursor_ix().map(|i| &self.rows[i])
    }

    /// The selected row's top, px from the list's top edge.
    fn cursor_screen_y(&self) -> Option<f32> {
        let ix = self.cursor_ix()?;
        let (_, top) = self.scroll_top();
        Some(ix as f32 * look::TREE_ROW_HEIGHT - top)
    }

    /// Scrolls so the selected row's top is `y` px from the list's top (as far as scrolling
    /// allows).
    fn put_cursor_at(&self, y: f32) {
        let Some(ix) = self.cursor_ix() else { return };
        let h = look::TREE_ROW_HEIGHT;
        let view = self
            .scroll
            .0
            .borrow()
            .base_handle
            .bounds()
            .size
            .height
            .as_f32();
        let max = if view > 0. {
            (self.rows.len() as f32 * h - view).max(0.)
        } else {
            f32::MAX
        };
        let top = (ix as f32 * h - y).clamp(0., max);
        self.scroll
            .0
            .borrow()
            .base_handle
            .set_offset(point(px(0.), px(-top)));
        if view > 0. && (y < 0. || y + h > view) {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    fn reveal_cursor(&self) {
        if let Some(ix) = self.cursor_ix() {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    fn select_ix(&mut self, ix: usize) {
        self.sel.set(self.rows.get(ix).map(|r| r.path.clone()));
        self.reveal_cursor();
    }

    /// Selects `path` (shown or not: its folders open; the search closes first).
    fn select_path(&mut self, path: &Path, cx: &mut Context<Self>) {
        if self.search.is_some() {
            self.close_search(false, cx);
        }
        self.tree.reveal(path);
        self.rebuild(false, cx);
        // a folder inside a compacted chain: the chain's row (the first row below it)
        let ix = self.row_of.get(path).copied().or_else(|| {
            self.rows
                .iter()
                .position(|r| r.dir && r.path.starts_with(path))
        });
        if let Some(ix) = ix {
            self.sel.set(Some(self.rows[ix].path.clone()));
            self.scroll.scroll_to_item(ix, ScrollStrategy::Center);
        }
        self.tell_state(cx);
    }

    fn page_rows(&self) -> isize {
        let view = self
            .scroll
            .0
            .borrow()
            .base_handle
            .bounds()
            .size
            .height
            .as_f32();
        ((view / look::TREE_ROW_HEIGHT).floor() as isize - 1).max(1)
    }

    fn move_by(&mut self, by: isize) {
        self.sel.clear_multi();
        if self.rows.is_empty() {
            return;
        }
        let n = self.rows.len() as isize;
        let to = match self.cursor_ix() {
            Some(c) => (c as isize).saturating_add(by).clamp(0, n - 1),
            None if by < 0 => n - 1,
            None => 0,
        };
        self.select_ix(to as usize);
    }

    fn extend_by(&mut self, by: isize) {
        let Some(c) = self.cursor_ix() else { return };
        let to = (c as isize + by).clamp(0, self.rows.len() as isize - 1) as usize;
        self.sel.extend_to(&self.rows, to);
        self.reveal_cursor();
    }

    fn results_shown(&self) -> bool {
        self.search.as_ref().is_some_and(|s| s.results.is_some())
    }

    fn is_folded(&self, path: &Path) -> bool {
        self.search
            .as_ref()
            .is_some_and(|s| s.folded.contains(path))
    }

    fn set_folded(&mut self, path: &Arc<Path>, fold: bool, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.search {
            if fold {
                s.folded.insert(path.clone());
            } else {
                s.folded.remove(path);
            }
        }
        self.rebuild(true, cx);
    }

    /// Opens / closes a folder row (in the results: unfolds / folds it).
    fn toggle_row(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(ix).cloned() else {
            return;
        };
        if !row.dir {
            return;
        }
        if self.results_shown() {
            let folded = self.is_folded(&row.path);
            return self.set_folded(&row.path, !folded, cx);
        }
        if row.open {
            self.tree.close(&row.path);
        } else {
            self.tree.open(&row.path);
        }
        self.rebuild(true, cx);
        self.tell_state(cx);
    }

    /// ← / k: collapse an open folder (in the results: fold it), else select the parent.
    fn left(&mut self, cx: &mut Context<Self>) {
        self.sel.clear_multi();
        let Some(ix) = self.cursor_ix() else { return };
        let row = &self.rows[ix];
        if row.dir && row.open {
            return self.toggle_row(ix, cx);
        }
        // (a compacted row's parent row is above its chain)
        let up = row
            .path
            .ancestors()
            .skip(1)
            .find_map(|p| self.row_of.get(p));
        if let Some(&p) = up {
            self.select_ix(p);
        }
    }

    /// → / ä: expand a closed folder (in the results: unfold it), else select its first child.
    fn right(&mut self, cx: &mut Context<Self>) {
        self.sel.clear_multi();
        let Some(ix) = self.cursor_ix() else { return };
        let row = self.rows[ix].clone();
        if !row.dir {
            return;
        }
        let closed = if self.results_shown() {
            self.is_folded(&row.path)
        } else {
            !row.open
        };
        if closed {
            return self.toggle_row(ix, cx);
        }
        if self
            .rows
            .get(ix + 1)
            .is_some_and(|c| c.path.parent() == Some(&*row.path))
        {
            self.select_ix(ix + 1);
        }
    }

    /// Enter / double-click: folders open / close (fold in the results), files open; a
    /// multi-selection opens all its files.
    fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sel.is_multi() {
            let files: Vec<Arc<Path>> = self
                .sel
                .multi()
                .iter()
                .filter(|p| self.row_of.get(*p).is_some_and(|&i| !self.rows[i].dir))
                .cloned()
                .collect();
            self.sel.clear_multi();
            if self.search.is_some() {
                self.close_search(false, cx);
            }
            if !files.is_empty() {
                self.open_files(&files, window, cx);
            }
            return;
        }
        let Some(ix) = self.cursor_ix() else { return };
        let row = self.rows[ix].clone();
        if row.dir {
            return self.toggle_row(ix, cx);
        }
        if self.search.is_some() {
            self.close_search(false, cx);
        }
        self.open_files(&[row.path], window, cx);
    }

    fn open_files(&mut self, files: &[Arc<Path>], window: &mut Window, cx: &mut Context<Self>) {
        self.scx.focus_editor(window, cx);
        self.scx
            .navigate(LUA, "open_files", vec![paths_value(files)]);
    }

    /// `tree.singleClick` (VS Code): a single click opens the file, as a preview tab where
    /// `tabs.preview`; the tree keeps the keyboard.
    fn open_single(&mut self, file: &Arc<Path>) {
        let opts = Value::Map(vec![("preview".into(), true.into())]);
        self.scx.navigate(
            LUA,
            "open_files",
            vec![paths_value(std::slice::from_ref(file)), opts],
        );
    }

    /// The Feel changed: its switches the tree reads, the rows again when compact folders flip.
    fn feel_changed(&mut self, cx: &mut Context<Self>) {
        let feel = cx.try_global::<Feel>().map(|f| f.tree).unwrap_or_default();
        if feel == self.feel {
            return;
        }
        let compact = feel.compact_folders != self.feel.compact_folders;
        self.feel = feel;
        self.tree.compact = feel.compact_folders;
        if compact {
            self.rebuild(true, cx);
        }
        cx.notify();
    }

    fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sel.has_multi() {
            self.sel.clear_multi();
        } else if self.search.is_some() {
            self.close_search(false, cx);
        } else {
            // WebStorm: Esc in a tool window goes back to the editor (the viewer when open)
            self.scx.focus_editor(window, cx);
            self.scx.call("config.focus", "editor", vec![]);
        }
    }

    // Search --------------------------------------------------------------------------------------

    fn start_search(&mut self, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.search {
            s.input = true;
            return;
        }
        self.search = Some(SearchState {
            query: String::new(),
            input: true,
            index: None,
            results: None,
            folded: HashSet::new(),
            results_for: None,
            matching: None,
            seq: 0,
            typed: false,
            walking: None,
            rewalk: false,
        });
        self.walk(cx);
        cx.notify();
    }

    /// (Re)builds the search index in the background.
    fn walk(&mut self, cx: &mut Context<Self>) {
        let Some(s) = &mut self.search else { return };
        if s.walking.is_some() {
            s.rewalk = true;
            return;
        }
        let root = self.tree.root.clone();
        let job = if self.tree.is_remote() {
            // a cloud workspace's: the rows its walk listed, no call to the box
            let (listings, git) = (self.tree.listings(), self.git.clone());
            cx.background_spawn(async move {
                let skip = |p: &Path| p.strip_prefix(&root).is_ok_and(|r| git.is_ignored(r));
                Index::from_rel(&root, listings.entries(&skip))
            })
        } else {
            let excl = self.tree.excl.clone();
            cx.background_spawn(async move { Index::build(&root, &excl) })
        };
        s.walking = Some(cx.spawn(async move |this, cx| {
            let index = job.await;
            let _ = this.update(cx, |t, cx| {
                let Some(s) = &mut t.search else { return };
                s.walking = None;
                let first = s.index.is_none();
                s.index = Some(Arc::new(index));
                let again = std::mem::take(&mut s.rewalk);
                // the first results: as if just typed; a refresh keeps the selection
                t.run_query(first, cx);
                if again {
                    t.walk(cx);
                }
            });
        }));
    }

    fn type_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(s) = &mut self.search else { return };
        s.query.push_str(text);
        s.input = true;
        self.run_query(true, cx);
    }

    fn set_query(&mut self, q: String, cx: &mut Context<Self>) {
        let Some(s) = &mut self.search else { return };
        if s.query == q {
            return;
        }
        s.query = q;
        self.run_query(true, cx);
    }

    /// Matches the search text in the background; `typed`: new text, the first match gets
    /// selected (else the selected row stays on its screen row). Results of text that changed
    /// meanwhile are dropped.
    fn run_query(&mut self, typed: bool, cx: &mut Context<Self>) {
        let Some(s) = &mut self.search else { return };
        s.seq += 1;
        s.typed |= typed;
        if s.query.is_empty() {
            // no text: the full tree, the selected result still selected
            s.matching = None;
            s.typed = false;
            s.results_for = None;
            let had = s.results.take().is_some();
            if had && let Some(c) = self.sel.cursor.clone() {
                self.tree.reveal(&c);
            }
            self.rebuild(true, cx);
            return;
        }
        let Some(index) = s.index.clone() else {
            cx.notify();
            return;
        };
        let (seq, query) = (s.seq, s.query.clone());
        let job = cx.background_spawn(async move {
            let mut m = search::matcher();
            search::run(&index, &query, &mut m)
        });
        s.matching = Some(cx.spawn(async move |this, cx| {
            let res = job.await;
            let _ = this.update(cx, |t, cx| t.apply_results(seq, res, cx));
        }));
    }

    fn apply_results(&mut self, seq: u64, res: Results, cx: &mut Context<Self>) {
        let Some(s) = &mut self.search else { return };
        if s.seq != seq {
            return;
        }
        s.matching = None;
        s.results = Some(res);
        s.results_for = Some(s.query.clone());
        let typed = std::mem::take(&mut s.typed);
        if !typed {
            self.rebuild(true, cx);
            return;
        }
        self.rebuild(false, cx);
        self.sel.clear_multi();
        if let Some(ix) = self.rows.iter().position(|r| r.matches.is_some()) {
            self.sel.set(Some(self.rows[ix].path.clone()));
            self.scroll
                .0
                .borrow()
                .base_handle
                .set_offset(point(px(0.), px(0.)));
            self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    /// Closes the search: the full tree with the selected result revealed and selected on the
    /// same screen row (WebStorm).
    fn close_search(&mut self, _leaving: bool, cx: &mut Context<Self>) {
        let screen = self.cursor_screen_y();
        self.search = None;
        self.sel.clear_multi();
        if let Some(c) = self.sel.cursor.clone()
            && *c != *self.tree.root
        {
            self.tree.reveal(&c);
        }
        self.rebuild(false, cx);
        if let Some(y) = screen {
            self.put_cursor_at(y);
        }
        self.tell_state(cx);
    }

    // Keys ----------------------------------------------------------------------------------------

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        let typed = kit::typed_text(ev);
        let m = ev.keystroke.modifiers;
        let k = ev.keystroke.key.as_str();
        // modifier combos by their keys (however the notation orders the modifiers)
        let combo = if m.platform && m.control && m.shift && !m.alt && k == "o" {
            Some("reveal")
        } else if m.platform && m.shift && !m.control && k == "c" {
            Some(if m.alt { "copy_reference" } else { "copy_path" })
        } else if m.platform && !m.control && (k == "_" || (m.shift && k == "-")) {
            Some("collapse_all")
        } else if m.platform && !m.control && (k == "?" || (m.shift && (k == "+" || k == "="))) {
            Some("expand_all")
        } else {
            None
        };
        let handled = if let Some(name) = combo {
            self.action(name, window, cx);
            true
        } else {
            self.key(&key, typed.as_deref(), window, cx)
        };
        if handled {
            cx.stop_propagation();
            cx.notify();
        }
    }

    /// One key (nvim notation); true = handled. Cmd / Ctrl combos not handled go to nvim.
    fn key(
        &mut self,
        key: &str,
        typed: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if let Some(at) = self.leader.take()
            && at.elapsed() < LEADER_TIMEOUT
        {
            match key {
                "n" => self.action("new", window, cx),
                "g" => self.action("select_opened", window, cx),
                // the other leader keys: nvim's (global maps; none under stock Vim keys)
                _ if crate::factory::stock_keys(cx) => {}
                _ => self.scx.rpc.input(&format!(",{key}")),
            }
            return true;
        }
        if let Some(s) = &self.search {
            let input = s.input;
            match key {
                "<BS>" if input => {
                    let mut q = s.query.clone();
                    q.pop();
                    self.set_query(q, cx);
                    return true;
                }
                "<D-BS>" | "<M-BS>" | "<C-u>" if input => {
                    self.set_query(String::new(), cx);
                    return true;
                }
                "/" if !input => {
                    self.start_search(cx);
                    return true;
                }
                // Cmd+V in the field pastes text (the clipboard's first line)
                "<D-v>" if input => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                        let line = text.lines().next().unwrap_or_default().to_owned();
                        self.type_text(&line, cx);
                    }
                    return true;
                }
                // the results list has the keys: his moves move; letters, digits and . - _ type
                // (`config/tree.lua` quiet_chars), other keys are the list's (`,` leader, `?`)
                "l" | "ö" | "k" | "ä" | "L" | "Ö" if !input => {}
                _ => {
                    if let Some(t) = typed
                        && (input || t.chars().all(types_in_results))
                    {
                        self.type_text(t, cx);
                        return true;
                    }
                }
            }
        }
        let (key, n) = match self.vim.feed(key, "ydr") {
            Step::Pending => return true,
            Step::First => ("<Home>", 1),
            Step::Last => ("<End>", 1),
            Step::Cmd(c) => {
                match c {
                    kit::Cmd::Yank => self.action("copy", window, cx),
                    kit::Cmd::Delete => self.action("delete", window, cx),
                    kit::Cmd::Rename => self.action("rename", window, cx),
                    kit::Cmd::Help => self.scx.call(LUA, "keys_help", vec![]),
                }
                return true;
            }
            Step::Key { key, count, .. } => (key, count as isize),
        };
        match key {
            "<Up>" | "l" => self.move_by(-n),
            "<Down>" | "ö" => self.move_by(n),
            "L" => self.move_by(-5 * n),
            "Ö" => self.move_by(5 * n),
            "<PageUp>" => self.move_by(-self.page_rows()),
            "<PageDown>" => self.move_by(self.page_rows()),
            "<Home>" => self.move_by(isize::MIN / 2),
            "<End>" => self.move_by(isize::MAX / 2),
            "<S-Up>" => self.extend_by(-n),
            "<S-Down>" => self.extend_by(n),
            "<Left>" | "k" => self.left(cx),
            "<Right>" | "ä" => self.right(cx),
            "<CR>" => self.confirm(window, cx),
            "<Esc>" => self.escape(window, cx),
            "/" => self.start_search(cx),
            "," => self.leader = Some(Instant::now()),
            "?" => self.scx.call(LUA, "keys_help", vec![]),
            "<S-F6>" | "<F18>" => self.action("rename", window, cx),
            "<BS>" | "<Del>" | "<D-BS>" => self.action("delete", window, cx),
            "<F5>" => self.action("copy_to", window, cx),
            "<F6>" => self.action("move", window, cx),
            "<D-c>" => self.action("copy", window, cx),
            "<D-x>" => self.action("cut", window, cx),
            "<D-v>" => self.action("paste", window, cx),
            // vim's single keys (yy / dd / rr above): x cut, P paste, o new file here
            "x" => self.action("cut", window, cx),
            "P" => self.action("paste", window, cx),
            "o" => self.action("new", window, cx),
            "<D-CR>" => self.menu_at_cursor(cx),
            // Cmd+- / Cmd+= (WebStorm: collapse / expand), with Shift: all
            "<D-->" => self.left(cx),
            "<D-=>" | "<D-+>" => self.right(cx),
            // a plain key the tree doesn't use does nothing (other letters, Space)
            _ => return typed.is_some(),
        }
        true
    }

    // Actions (keys, menu items) ------------------------------------------------------------

    /// The folder new files / pastes go to: the selected folder, a file's folder, the root.
    fn target_dir(&self) -> PathBuf {
        match self.cursor_row() {
            Some(r) if r.dir => r.path.to_path_buf(),
            Some(r) => r
                .path
                .parent()
                .map_or_else(|| self.tree.root.clone(), Path::to_path_buf),
            None => self.tree.root.clone(),
        }
    }

    /// The selection without the project root.
    fn selection_no_root(&self) -> Vec<Arc<Path>> {
        self.sel
            .paths()
            .into_iter()
            .filter(|p| **p != *self.tree.root)
            .collect()
    }

    fn action(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let dir = self.target_dir();
        let dir_v = || Value::from(dir.to_string_lossy().into_owned());
        match name {
            "new" => self.scx.call(LUA, "new_entry", vec![dir_v()]),
            "confirm" => self.confirm(window, cx),
            // F6 on one row renames it (snacks: "Renaming instead")
            "rename" | "move" if !self.sel.is_multi() => {
                if let Some(p) = self.selection_no_root().first() {
                    self.sel.clear_multi();
                    self.scx.call(LUA, "rename", vec![path_value(p)]);
                }
            }
            "move" => {
                let paths = self.selection_no_root();
                self.scx.call(
                    LUA,
                    "to_folder",
                    vec!["Move".into(), paths_value(&paths), dir_v()],
                );
            }
            "copy_to" => {
                let paths = self.selection_no_root();
                if self.sel.is_multi() {
                    self.scx.call(
                        LUA,
                        "to_folder",
                        vec!["Copy".into(), paths_value(&paths), dir_v()],
                    );
                } else if let Some(p) = paths.first() {
                    self.sel.clear_multi();
                    self.scx.call(LUA, "copy_one", vec![path_value(p)]);
                }
            }
            "delete" => {
                let paths = self.selection_no_root();
                if !paths.is_empty() {
                    self.scx
                        .call(LUA, "confirm_delete", vec![paths_value(&paths)]);
                }
            }
            "copy" => {
                let paths = self.sel.paths();
                self.scx
                    .call(LUA, "clip", vec![paths_value(&paths), false.into()]);
            }
            "cut" => {
                let paths = self.selection_no_root();
                self.scx
                    .call(LUA, "clip", vec![paths_value(&paths), true.into()]);
            }
            "paste" => {
                self.sel.clear_multi();
                self.scx.call(LUA, "paste", vec![dir_v()]);
            }
            "copy_path" | "copy_reference" => {
                let rel = name == "copy_reference";
                let text: Vec<String> = self
                    .sel
                    .paths()
                    .iter()
                    .map(|p| {
                        if rel {
                            self.rel(p)
                        } else {
                            p.to_string_lossy().into_owned()
                        }
                    })
                    .collect();
                self.scx
                    .call(LUA, "copy_text", vec![text.join("\n").into()]);
            }
            "reveal" => {
                let paths = self.sel.paths();
                self.scx
                    .call("config.tree", "reveal", vec![paths_value(&paths)]);
            }
            "search" => {
                window.focus(&self.focus, cx);
                self.start_search(cx);
            }
            "select_opened" => self.scx.call(LUA, "select_opened", vec![]),
            "collapse_all" => {
                if self.search.is_some() {
                    self.close_search(false, cx);
                }
                self.tree.collapse_all();
                self.rebuild(false, cx);
                self.reveal_cursor();
                self.tell_state(cx);
            }
            "expand_all" => {
                if self.search.is_some() {
                    self.close_search(false, cx);
                }
                // up to EXPAND_ALL_LIMIT folders listed in the background
                let root = self.tree.root.clone();
                let git = self.git.clone();
                let excl = self.tree.excl.clone();
                // (a cloud workspace's: one walk on its box, off the UI thread)
                let job = crate::shell::remote::background(&root.clone(), cx, move || {
                    let skip = |p: &Path| p.strip_prefix(&root).is_ok_and(|r| git.is_ignored(r));
                    model::list_below(&root, &excl, &skip, EXPAND_ALL_LIMIT)
                });
                cx.spawn(async move |this, cx| {
                    let listings = job.await.unwrap_or_default();
                    let _ = this.update(cx, |t, cx| {
                        t.tree.open_listed(listings);
                        t.rebuild(true, cx);
                        t.tell_state(cx);
                    });
                })
                .detach();
            }
            "clear_selection" => self.sel.clear_multi(),
            "menu" => self.menu_at_cursor(cx),
            _ => lua::log_once(Self::NAME, &Value::from(name), "unknown tree action"),
        }
        cx.notify();
    }

    /// Cmd+Enter: the menu under the selected row.
    fn menu_at_cursor(&mut self, cx: &mut Context<Self>) {
        let at = self
            .cursor_ix()
            .and_then(|ix| self.row_point(ix, 0.))
            .map(|p| point(p.x, p.y + px(look::TREE_ROW_HEIGHT / 2.)))
            .unwrap_or_default();
        self.open_menu(at, cx);
    }

    /// The context menu for the selection at window point `at` (`config/app/tree.lua` builds
    /// the items: they come back as [`TreeEvent::Action`]s or run in Lua).
    fn open_menu(&mut self, at: Point<Pixels>, _cx: &mut Context<Self>) {
        let paths = self.sel.paths();
        let files = paths
            .iter()
            .filter(|p| self.row_of.get(*p).is_some_and(|&i| !self.rows[i].dir))
            .count();
        let row = self.cursor_row();
        let multi = if self.sel.is_multi() { paths.len() } else { 0 };
        let ctx = map(vec![
            ("paths", paths_value(&paths)),
            ("multi", multi.into()),
            ("files", files.into()),
            ("dir", row.is_some_and(|r| r.dir).into()),
            ("open", row.is_some_and(|r| r.open).into()),
            ("root", row.is_some_and(Row::is_root).into()),
            ("x", f64::from(at.x.as_f32()).into()),
            ("y", f64::from(at.y.as_f32()).into()),
        ]);
        self.scx.call(LUA, "menu", vec![ctx]);
    }

    /// Files / folders dropped from Finder on row `ix` (None: below the rows = the root): copied
    /// into that folder (a file row: its folder) after WebStorm's Copy dialog (`to_folder`).
    pub fn drop_external(&mut self, ix: Option<usize>, paths: &[PathBuf], cx: &mut Context<Self>) {
        self.click_open = None;
        let dir = match ix.and_then(|i| self.rows.get(i)) {
            Some(r) if r.dir => r.path.to_path_buf(),
            Some(r) => match r.path.parent() {
                Some(p) => p.to_path_buf(),
                None => return,
            },
            None => self.tree.root.clone(),
        };
        let paths: Vec<Arc<Path>> = paths.iter().map(|p| Arc::from(p.as_path())).collect();
        if paths.is_empty() {
            return;
        }
        self.scx.call(
            LUA,
            "to_folder",
            vec!["Copy".into(), paths_value(&paths), path_value(&dir)],
        );
        cx.notify();
    }

    /// Drag and drop: the dragged rows move into the folder (a file row: its folder), after
    /// asking (WebStorm's Move dialog).
    fn drop_on(
        &mut self,
        ix: usize,
        dragged: &DraggedPaths,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.press_single = None;
        self.click_open = None; // (the drop stops the mouse up that would take it)
        let Some(row) = self.rows.get(ix) else { return };
        let dir: PathBuf = if row.dir {
            row.path.to_path_buf()
        } else {
            match row.path.parent() {
                Some(p) => p.to_path_buf(),
                None => return,
            }
        };
        let paths: Vec<Arc<Path>> = dragged
            .0
            .iter()
            .filter(|p| {
                ***p != *self.tree.root
                    && p.parent() != Some(dir.as_path())
                    && !dir.starts_with(p.as_ref())
            })
            .cloned()
            .collect();
        if paths.is_empty() {
            return;
        }
        let what = match paths.as_slice() {
            [one] => format!(
                "\"{}\"",
                one.file_name().unwrap_or_default().to_string_lossy()
            ),
            more => format!("{} items", more.len()),
        };
        let to = if dir == self.tree.root {
            dir.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            self.rel(&dir)
        };
        let menu = Menu::new(
            vec![MenuItem::new("Move").into(), MenuItem::new("Cancel").into()],
            Anchor::Point(window.mouse_position()),
        )
        .title(format!("Move {what} to {to}?"));
        let this = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, _, cx| {
            if choice != Some(0) {
                return;
            }
            let _ = this.update(cx, |t, cx| {
                t.sel.clear_multi();
                t.scx.call(
                    LUA,
                    "move_into",
                    vec![
                        paths_value(&paths),
                        dir.to_string_lossy().into_owned().into(),
                    ],
                );
                cx.notify();
            });
        });
        cx.notify();
    }

    // Files changed -------------------------------------------------------------------------------

    /// Runs a file job in the background, then lists every listed folder again (also in the
    /// background) and calls `after` with the job's result: the UI never waits on the disk.
    fn fs_job<R: Send + 'static>(
        &mut self,
        job: impl FnOnce() -> R + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
        after: impl FnOnce(&mut Self, R, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let dirs = self.tree.dirs_to_relist();
        let root = self.tree.root.clone();
        // (a cloud workspace's listings: one call to its box, off the UI thread)
        let task = crate::shell::remote::background(&root.clone(), cx, move || {
            let r = job();
            (r, model::relist(dirs), model::Exclusions::read(&root))
        });
        cx.spawn_in(window, async move |this, cx| {
            let Some((r, listings, excl)) = task.await else {
                return;
            };
            let _ = this.update_in(cx, |t, window, cx| {
                t.tree.apply_relist(listings);
                t.tree.excl = excl;
                t.forget_kids();
                t.rebuild(true, cx);
                t.refresh_git(cx);
                if t.search.is_some() {
                    t.walk(cx);
                }
                after(t, r, window, cx);
            });
        })
        .detach();
    }

    fn refresh_git(&mut self, cx: &mut Context<Self>) {
        if self.git_busy {
            self.git_again = true;
            return;
        }
        self.git_busy = true;
        let job = git::read_status(self.tree.root.clone(), cx);
        cx.spawn(async move |this, cx| {
            let st = job.await;
            let _ = this.update(cx, |t, cx| {
                t.git = st.unwrap_or_default();
                t.git_busy = false;
                cx.notify();
                if std::mem::take(&mut t.git_again) {
                    t.refresh_git(cx);
                }
            });
        })
        .detach();
    }

    /// Polls the listed folders every [`POLL`] (while its project is shown).
    fn poller(cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                if this.update(cx, |t, cx| t.poll(cx)).is_err() {
                    break;
                }
            }
        })
    }

    /// The mouse is over the tool window (its header actions and scrollbar show).
    pub fn is_hovered(&self) -> bool {
        self.hovered
    }

    /// Whether a `,` still waits for its leader key (tests).
    pub fn leader_pending(&self) -> bool {
        self.leader.is_some_and(|at| at.elapsed() < LEADER_TIMEOUT)
    }

    /// Whether the folder poll runs (paused while its project is hidden).
    pub fn is_polling(&self) -> bool {
        self.poller.is_some()
    }

    /// Its project is shown / hidden (behind another open project): a hidden tree doesn't poll;
    /// shown again, it catches up at once.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.project_active = active;
        self.update_poller(cx);
    }

    /// The poll runs while the project is shown and the app window is active (WebStorm syncs
    /// the file system on frame activation): a background app does no disk work. Restarting
    /// catches up at once.
    fn update_poller(&mut self, cx: &mut Context<Self>) {
        if !(self.project_active && self.window_active) {
            self.poller = None;
        } else if self.poller.is_none() {
            self.poller = Some(Self::poller(cx));
            self.refresh_git(cx);
            self.poll(cx);
        }
    }

    /// Checks the listed folders (and git's index / HEAD, `.idea`) for changes.
    fn poll(&mut self, cx: &mut Context<Self>) {
        // no tree on screen, no work (opening it polls right away)
        if self.polling || !self.is_open(cx) {
            return;
        }
        self.polling = true;
        let mut paths = self.tree.listed_dirs();
        let root = self.tree.root.clone();
        paths.extend([
            root.join(".git/index"),
            root.join(".git/HEAD"),
            root.join(".idea"),
        ]);
        // the `.iml`s too: an in-place edit doesn't touch `.idea`'s own mtime
        paths.extend(self.tree.excl.sources().iter().cloned());
        let job = cx.background_spawn(async move {
            paths
                .into_iter()
                .map(|p| {
                    let m = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
                    (p, m)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let seen = job.await;
            let _ = this.update(cx, |t, cx| {
                t.polling = false;
                t.apply_poll(seen, cx)
            });
        })
        .detach();
    }

    fn apply_poll(&mut self, seen: Vec<(PathBuf, Option<SystemTime>)>, cx: &mut Context<Self>) {
        let root = self.tree.root.clone();
        let (mut dirs, mut git, mut idea) = (Vec::new(), false, false);
        for (p, m) in seen {
            match self.mtimes.insert(p.clone(), m) {
                Some(old) if old != m => {
                    if p.starts_with(root.join(".git")) {
                        git = true;
                    } else {
                        if p.starts_with(root.join(".idea")) {
                            idea = true;
                        }
                        // `.idea` can be a listed folder too; the `.iml`s are files
                        if !self.tree.excl.sources().contains(&p) {
                            dirs.push(p);
                        }
                    }
                }
                _ => {}
            }
        }
        if dirs.is_empty() && !git && !idea {
            return;
        }
        for d in &dirs {
            self.tree.refresh(d);
        }
        if idea {
            // the excludes changed: read them off the UI thread, then tint / search again
            let job = cx.background_spawn(async move { model::Exclusions::read(&root) });
            cx.spawn(async move |this, cx| {
                let excl = job.await;
                let _ = this.update(cx, |t, cx| t.set_exclusions(excl, cx));
            })
            .detach();
        }
        if !dirs.is_empty() {
            self.forget_kids();
            self.rebuild(true, cx);
            if self.search.is_some() {
                self.walk(cx);
            }
        }
        self.refresh_git(cx);
    }

    /// New `.idea` excludes (the project scope): the tint and the search's index follow.
    fn set_exclusions(&mut self, excl: model::Exclusions, cx: &mut Context<Self>) {
        if self.tree.excl == excl {
            return;
        }
        self.tree.excl = excl;
        self.forget_kids();
        self.rebuild(true, cx);
        if self.search.is_some() {
            self.walk(cx);
        }
    }

    /// Hooks that need the workspace built (it isn't while surfaces are created).
    fn init(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ws) = self.scx.workspace.upgrade() {
            let editor = ws.read(cx).editor().clone();
            // the tree's width is the workspace's (dragged there): the session wants it
            self._subs
                .push(cx.observe(&editor, |t: &mut TreeView, _, cx| t.tell_state(cx)));
            self.editor = Some(editor);
        }
        self._subs
            .push(cx.observe_window_activation(window, |t, window, cx| {
                t.window_active = crate::editor::window_active(window);
                t.update_poller(cx);
            }));
        // (activation can come before this observer: tests activate the window asynchronously)
        self.window_active = crate::editor::window_active(window);
        self.update_poller(cx);
        // speed search closes when the keyboard goes to the editor (not to a popup over it)
        let editor_focus = self.scx.editor_focus.clone();
        self._subs.push(
            cx.on_focus_out(&self.focus, window, move |t, _, window, cx| {
                if t.search.is_some() && editor_focus.contains_focused(window, cx) {
                    t.close_search(true, cx);
                }
                cx.notify();
            }),
        );
        self.tell_state(cx);
    }
}

/// Chars that type into the search from the results list (`config/tree.lua` quiet_chars).
fn types_in_results(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '.' | '-' | '_')
}

fn map(pairs: Vec<(&str, Value)>) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn path_value(p: &Path) -> Value {
    p.to_string_lossy().into_owned().into()
}

fn paths_value(paths: &[Arc<Path>]) -> Value {
    Value::Array(paths.iter().map(|p| path_value(p)).collect())
}

impl Surface for TreeView {
    const NAME: &'static str = "tree";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let feel = cx.try_global::<Feel>().map(|f| f.tree).unwrap_or_default();
        let mut tree = FsTree::new(&scx.project);
        tree.compact = feel.compact_folders;
        tree.list_chains();
        let rows = tree.rows();
        let row_of = rows
            .iter()
            .enumerate()
            .map(|(i, r)| (r.path.clone(), i))
            .collect();
        let mut sel = Selection::default();
        sel.set(rows.first().map(|r| r.path.clone()));
        let window_active = crate::editor::window_active(window);
        let poller = window_active.then(|| Self::poller(cx));
        cx.defer_in(window, |t, window, cx| t.init(window, cx));
        let story = crate::factory::look_of(&scx.project, cx).map(|l| l.story.short.clone());
        let mut t = TreeView {
            scx,
            focus: cx.focus_handle(),
            tree,
            rows,
            row_of,
            sel,
            scroll: UniformListScrollHandle::new(),
            search: None,
            git: GitStatus::default(),
            git_busy: false,
            git_again: false,
            problems: HashSet::new(),
            problem_counts: HashMap::new(),
            kids: HashMap::new(),
            kids_stale: HashMap::new(),
            kids_pending: Vec::new(),
            kids_task: None,
            walked: false,
            header_title: Rc::default(),
            header_more: Rc::default(),
            leader: None,
            vim: Vim::default(),
            hovered: false,
            thumb_drag: None,
            drag_select: None,
            press_single: None,
            scroll_dir: 0,
            scroll_task: None,
            mtimes: HashMap::new(),
            polling: false,
            told: None,
            editor: None,
            poller,
            project_active: true,
            window_active,
            story,
            tags: HashMap::new(),
            feel,
            click_open: None,
            // the header's feed: a story workspace's root row says its story
            _subs: vec![
                cx.observe_global::<crate::factory::ShownWorkspaces>(|t: &mut TreeView, cx| {
                    let story =
                        crate::factory::look_of(&t.scx.project, cx).map(|l| l.story.short.clone());
                    if story != t.story {
                        t.story = story;
                        cx.notify();
                    }
                }),
                cx.observe_global::<Feel>(|t: &mut TreeView, cx| t.feel_changed(cx)),
            ],
        };
        t.refresh_git(cx);
        t
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<TreeEvent>(Self::NAME, payload) else {
            return;
        };
        let open = self.is_open(cx);
        match ev {
            TreeEvent::Open { focus: true } | TreeEvent::Focus => self.take_focus(window, cx),
            TreeEvent::Open { focus: false } => self.set_open(true, window, cx),
            TreeEvent::Close => self.set_open(false, window, cx),
            TreeEvent::Toggle if open => self.set_open(false, window, cx),
            TreeEvent::Toggle => self.take_focus(window, cx),
            TreeEvent::Reveal {
                file,
                focus,
                expand,
            } => {
                if let Some(f) = file {
                    let local = self.local_path(Path::new(&f));
                    let p = local.as_path();
                    // (a cloud workspace's folder: listed in the background, gone if it is none)
                    if expand && (self.remote() || p.is_dir()) {
                        self.tree.open(p);
                    }
                    self.select_path(p, cx);
                }
                if focus {
                    self.take_focus(window, cx)
                } else {
                    self.set_open(true, window, cx)
                }
            }
            TreeEvent::Follow { file } => {
                let local = self.local_path(Path::new(&file));
                // (the speed search keeps its results; a file outside the project or in an
                // excluded folder, node_modules after a go-to-definition: nothing, as VS Code's
                // explorer.autoRevealExclude)
                if self.feel.auto_reveal
                    && self.search.is_none()
                    && local.starts_with(&self.tree.root)
                    && !self.tree.excl.excluded(&local, false)
                {
                    if self.sel.cursor.as_deref() == Some(local.as_path()) {
                        self.reveal_cursor();
                    } else {
                        self.select_path(&local, cx);
                    }
                }
            }
            TreeEvent::Restore {
                open,
                width,
                dirs,
                focus,
            } => {
                if let Some(w) = width.filter(|w| *w > 0.) {
                    self.set_width(w as f32, cx);
                }
                for d in dirs {
                    let p = self.tree.root.join(d);
                    if self.remote() || p.is_dir() {
                        self.tree.open(&p);
                    }
                }
                self.rebuild(true, cx);
                if focus && open {
                    self.take_focus(window, cx);
                } else {
                    self.set_open(open, window, cx);
                }
            }
            TreeEvent::Git => self.refresh_git(cx),
            TreeEvent::Abe { dir, tags } => {
                self.tree.first = dir.map(PathBuf::from);
                self.tags = tags
                    .into_iter()
                    .map(|t| (PathBuf::from(t.path), (t.tag, t.bad)))
                    .collect();
                self.rebuild(true, cx);
            }
            TreeEvent::Problems { paths, counts } => {
                self.problems = paths.into_iter().map(PathBuf::from).collect();
                self.problem_counts = counts
                    .into_iter()
                    .filter(|c| c.errors + c.warnings > 0)
                    .map(|c| (PathBuf::from(c.path), (c.errors, c.warnings)))
                    .collect();
                cx.notify();
            }
            TreeEvent::Root { dir } => {
                let dir = PathBuf::from(dir);
                // a cloud workspace's tree stays on its box's folder
                if dir != self.tree.root && !self.remote() && dir.is_dir() {
                    self.search = None;
                    self.tree = FsTree::new(&dir);
                    self.tree.compact = self.feel.compact_folders;
                    self.told = None;
                    self.mtimes.clear();
                    self.forget_kids();
                    self.sel = Selection::default();
                    self.rebuild(false, cx);
                    self.sel.set(self.rows.first().map(|r| r.path.clone()));
                    self.refresh_git(cx);
                    self.tell_state(cx);
                }
            }
            TreeEvent::Action { name } => {
                if open {
                    window.focus(&self.focus, cx);
                }
                self.action(&name, window, cx);
            }
            TreeEvent::Search { text } => {
                self.take_focus(window, cx);
                self.start_search(cx);
                self.set_query(text, cx);
            }
            TreeEvent::Create { dir, name } => {
                let Some((path, is_file)) = ops::new_path(Path::new(&dir), &name) else {
                    return;
                };
                let p2 = path.clone();
                self.fs_job(
                    move || ops::create(&p2, is_file).map_err(|e| e.to_string()),
                    window,
                    cx,
                    move |t, res, window, cx| {
                        if let Err(e) = res {
                            return t.scx.call(LUA, "warn", vec![e.into()]);
                        }
                        if !is_file {
                            t.tree.reveal(&path);
                            t.tree.open(&path);
                        }
                        t.select_path(&path, cx);
                        if is_file {
                            let p: Arc<Path> = Arc::from(path.as_path());
                            t.open_files(&[p], window, cx);
                        }
                    },
                );
            }
            TreeEvent::Renamed { to, .. } => {
                let to = self.local_path(Path::new(&to));
                self.fs_job(
                    || (),
                    window,
                    cx,
                    move |t, (), _, cx| t.select_path(&to, cx),
                );
            }
            TreeEvent::Moved { dir } => {
                let dir = self.local_path(Path::new(&dir));
                self.fs_job(
                    || (),
                    window,
                    cx,
                    move |t, (), _, cx| {
                        t.tree.open(&dir);
                        t.select_path(&dir, cx);
                    },
                );
            }
            TreeEvent::Copy { from, to } => {
                let to = self.local_path(Path::new(&to));
                let to2 = to.clone();
                self.fs_job(
                    move || ops::copy_path(Path::new(&from), &to2).map_err(|e| e.to_string()),
                    window,
                    cx,
                    move |t, res, _, cx| {
                        if let Err(e) = res {
                            t.scx.call(LUA, "warn", vec![e.into()]);
                        }
                        t.select_path(&to, cx);
                    },
                );
            }
            TreeEvent::CopyInto { paths, dir } => {
                let dir = self.local_path(Path::new(&dir));
                let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
                let d2 = dir.clone();
                self.fs_job(
                    move || ops::copy_into(&paths, &d2),
                    window,
                    cx,
                    move |t, errors, _, cx| {
                        if !errors.is_empty() {
                            t.scx.call(LUA, "warn", vec![errors.join("\n").into()]);
                        }
                        t.tree.open(&dir);
                        t.select_path(&dir, cx);
                    },
                );
            }
            TreeEvent::Delete { paths } => {
                // after it the row that took the (first) deleted row's place is selected, like
                // the Lua tree (snacks keeps the list's cursor index)
                let first = paths
                    .iter()
                    .filter_map(|p| self.row_of.get(Path::new(p)).copied())
                    .min();
                self.fs_job(
                    move || {
                        let mut errors = Vec::new();
                        let mut done = Vec::new();
                        for p in paths {
                            match ops::trash(Path::new(&p)) {
                                Ok(()) => done.push(p),
                                Err(e) => errors.push(format!("Failed to delete `{p}`:\n{e}")),
                            }
                        }
                        (done, errors)
                    },
                    window,
                    cx,
                    move |t, (done, errors), _, cx| {
                        t.sel.clear_multi();
                        if let Some(ix) = first.filter(|_| !t.rows.is_empty()) {
                            t.select_ix(ix.min(t.rows.len() - 1));
                        }
                        let done: Vec<Value> = done.into_iter().map(Value::from).collect();
                        t.scx.call(LUA, "deleted", vec![Value::Array(done)]);
                        if !errors.is_empty() {
                            t.scx.call(LUA, "warn", vec![errors.join("\n").into()]);
                        }
                        cx.notify();
                    },
                );
            }
        }
        cx.notify();
    }
}

impl Focusable for TreeView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_decode() {
        assert_eq!(
            lua::decode::<TreeEvent>("tree", map(vec![("event", "open".into())])),
            Some(TreeEvent::Open { focus: false })
        );
        assert_eq!(
            lua::decode::<TreeEvent>(
                "tree",
                map(vec![("event", "reveal".into()), ("file", "/a/b.ts".into())])
            ),
            Some(TreeEvent::Reveal {
                file: Some("/a/b.ts".into()),
                focus: true,
                expand: false
            })
        );
        assert_eq!(
            lua::decode::<TreeEvent>(
                "tree",
                map(vec![
                    ("event", "restore".into()),
                    ("open", false.into()),
                    ("width", 320.into()),
                    ("dirs", Value::Array(vec!["src".into()])),
                ])
            ),
            Some(TreeEvent::Restore {
                open: false,
                width: Some(320.),
                dirs: vec!["src".into()],
                focus: false
            })
        );
        assert_eq!(
            lua::decode::<TreeEvent>(
                "tree",
                map(vec![
                    ("event", "problems".into()),
                    ("paths", Value::Array(vec![]))
                ])
            ),
            Some(TreeEvent::Problems {
                paths: vec![],
                counts: vec![]
            })
        );
    }
}
