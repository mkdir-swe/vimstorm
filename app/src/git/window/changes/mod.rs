//! Local Changes tab of the Git tool window: WebStorm's non-modal commit (ChangesViewPanel +
//! NonModalCommitPanel) with the M4 Lua behaviour (`git/changes.lua`, `filetree.lua`, the Local
//! Changes parts of `git/init.lua`; deleted in M5, see git history).
//!
//! - Left: a toolbar (Refresh, Rollback, Show Diff | Group by Directory, Expand / Collapse
//!   All; "N files, M marked" at its right while it fits) over the changes tree with
//!   checkboxes ([`ChangesTree`]): "Merge Conflicts", the "Changes" changelist, "Unversioned
//!   Files". Right (below, when the tool window is narrow): the commit message ("Commit Message"
//!   placeholder), Commit / Commit and Push… / Amend and what a commit takes.
//! - Commit rules (Lua `changes.lua`, [`crate::git::commit`]): the included (checked) files,
//!   else every tracked change; unversioned files only when included; a merge takes everything; the
//!   message git prepared (MERGE_MSG) prefills the area; a failed commit (hook) keeps the message,
//!   the included files and the index as they were. Buffers are saved first (Lua `silent! wall`).
//! - Keys (tree): Space includes, Enter / double-click diff (a conflict: the merge window),
//!   Cmd+D diff, F4 the file in the editor, Cmd+Z / Cmd+Alt+Z / `dd` rollback (confirmed), Cmd+K
//!   the message, Cmd+Alt+K commit and push, Cmd+Shift+K push, Cmd+Enter / right-click the menu,
//!   R refresh, `g?` help, Tab the message, k / ä fold, `/` search, Cmd+C / `yy` paths, a count
//!   before the moves (`3ö`), `gg` / `G`. Message: Cmd+Enter
//!   / Cmd+K commit, Cmd+Alt+K commit and push, Esc / Tab back to the tree.
//! - Diffs open through Lua (`config/app/git_changes.lua` -> `git/diff.lua`, `git/merge.lua`):
//!   Alt+Cmd+arrows in the diff step through the tree's files.

mod run;

use std::cell::Cell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Pixels, Point, Render, SharedString,
    Styled as _, Window, canvas, div, point, prelude::FluentBuilder as _, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::git::changes::{self as data, ChangeKind, LocalChanges, Section};
use crate::git::cli::Cancel;
use crate::git::ops::{self, Level, Outcome};
use crate::git::window::{GitCommand, GitCx, GitTab, RepoChange, TabId};
use crate::git::{commit, job};
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::ListView;
use crate::kit::{Axis, IconButton, TextButton, toolbar, toolbar_separator};
use crate::kit::{
    ChangeFile, ChangeGroup, ChangeStatus, ChangesTree, ChangesTreeEvent, RowKind, count,
};
use crate::kit::{CheckState, Checkbox};
use crate::kit::{Fixed, SplitAxis, SplitState, split};
use crate::kit::{TextArea, TextAreaEvent, TextAreaStyle};
use crate::look;
use crate::nvim::lua;
use crate::popups::{self, Menu, MenuEntry, MenuItem};
use crate::render::ui_font;

pub(crate) use run::lua_changed;
use run::{Busy, LUA};

/// The toolbar row over the tree: 22 px buttons + the compact toolbar insets (2 + 2) + the row's
/// own margin (approx WS ChangesViewPanel's toolbar row).
const TOOLBAR_HEIGHT: f32 = 30.0;
/// Narrower than this, the commit panel goes below the tree (IntelliJ's commit panel goes beside
/// the changes in a wide tool window, under them in a tall one).
pub const SIDE_BY_SIDE_MIN_WIDTH: f32 = 560.0;
/// The commit panel's default width beside the tree / height below it.
const COMMIT_PANEL_WIDTH: f32 = 440.0;
const COMMIT_PANEL_HEIGHT: f32 = 170.0;
/// The commit hint's line under the message.
const HINT_HEIGHT: f32 = 20.0;
/// Approximate Inter 13 average char width (fit checks for the header texts).
const CHAR_W: f32 = 7.0;

/// `vimstorm.git_changes` (config/app/git_changes.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum LuaEvent {
    /// A buffer was written (autosave): reload.
    Saved,
    /// `save_all` done: the commit can run.
    SavedAll { token: u64 },
}

/// A commit waiting for Lua to save the buffers.
struct PendingCommit {
    token: u64,
    message: String,
    amend: bool,
    push: bool,
}

/// Which pane has (or last had) the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Tree,
    Message,
}

/// A menu action (index-aligned with the menu's entries).
type Act = fn(&mut ChangesTab, Point<Pixels>, &mut Window, &mut Context<ChangesTab>);

pub struct ChangesTab {
    gcx: GitCx,
    tree: Entity<ListView<ChangesTree>>,
    message: Entity<TextArea>,
    side: Entity<SplitState>,
    stacked: Entity<SplitState>,
    data: Option<LocalChanges>,
    loads: job::Latest,
    loading: bool,
    reload: bool,
    /// A refresh came while hidden: reload when shown.
    stale: bool,
    /// Amend the last commit.
    amend: bool,
    /// The text Amend / the merge put in the message (cleared again when they go).
    prefilled: Option<String>,
    committing: bool,
    pending: Option<PendingCommit>,
    token: u64,
    pane: Pane,
    /// `g` typed (`g?` help).
    g: bool,
    /// A deferred focus of the pane is pending (the view had the keyboard at a render).
    refocus: bool,
    /// A key the view got is being dispatched again to the pane (once).
    redispatched: bool,
    /// The tab's width at the last layout (side by side or stacked).
    width: Rc<Cell<Pixels>>,
    /// The tree pane's bounds at the last paint (window coordinates; keyboard menus).
    tree_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The View Options eye / commit options gear as last painted (their menus open below them).
    eye_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    gear_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// Reloads asked for (tests: the repo-changed hook reached the tab).
    pub refreshes: Vec<RepoChange>,
    /// Lua entry points received (tests).
    pub commands: Vec<GitCommand>,
    pub shown: bool,
    _subs: Vec<gpui_kit::Subscription>,
}

/// Lua's `GitFile.status` letter of a tree file.
fn letter(s: ChangeStatus) -> char {
    match s {
        ChangeStatus::Modified | ChangeStatus::TypeChanged => 'M',
        ChangeStatus::Added => 'A',
        ChangeStatus::Copied => 'C',
        ChangeStatus::Deleted => 'D',
        ChangeStatus::Renamed => 'R',
        ChangeStatus::Unversioned => '?',
        ChangeStatus::Ignored => '!',
        ChangeStatus::Conflict => 'U',
    }
}

/// Files as Lua `GitFile`s (`{ path, old_path, status }`).
pub(crate) fn git_files(files: &[ChangeFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|f| {
                let mut m = vec![
                    (Value::from("path"), Value::from(f.path.as_str())),
                    (
                        Value::from("status"),
                        Value::from(letter(f.status).to_string()),
                    ),
                ];
                if let Some(o) = &f.old_path {
                    m.push((Value::from("old_path"), Value::from(o.as_str())));
                }
                Value::Map(m)
            })
            .collect(),
    )
}

fn tree_file(c: &data::Change) -> ChangeFile {
    let status = ChangeStatus::from_letter(c.kind.letter()).unwrap_or(ChangeStatus::Modified);
    let f = ChangeFile::new(c.path.clone(), status);
    match &c.old_path {
        Some(o) => f.renamed_from(o.clone()),
        None => f,
    }
}

/// Local Changes' groups (Lua `changes.lua` `render`: conflicts, the changelist, unversioned).
fn groups(lc: &LocalChanges) -> Vec<ChangeGroup> {
    lc.sections()
        .into_iter()
        .map(|(s, files)| {
            let files: Vec<ChangeFile> = files.into_iter().map(tree_file).collect();
            match s {
                Section::Conflicts => ChangeGroup::conflicts(files),
                Section::Changes => ChangeGroup::changelist("changes", "Changes", files),
                Section::Unversioned => ChangeGroup::unversioned(files),
            }
        })
        .collect()
}

/// `g?` (Lua `git/init.lua`'s HELP, the Local Changes part).
pub const HELP: &str = "Local Changes\n\
  Space             mark file for commit (or click its checkbox)\n\
  Enter / ⌘D        diff (a conflict: the merge window), focus stays here\n\
  ⌘Ö / ⌘L           in the diff: next / previous change, on into the next file\n\
  F4                open the file in the editor\n\
  ⌘K                commit message (⌘K / ⌘Enter there: commit)\n\
  ⌥⌘K / ⇧⌘K         commit and push / push\n\
  ⌘Z / ⌥⌘Z / dd     rollback\n\
  ⌘C / yy           copy paths\n\
  3ö / 3Ö           a count moves 3 rows / 15 · gg / G first / last\n\
  ← → / k ä         fold / unfold, parent / child\n\
  /                 search\n\
  ⌘Enter            menu with everything (also right-click)\n\
  Tab               message <-> files\n\
  R                 refresh\n\
  Ctrl+⌘← / →       Local Changes / Log\n\
  Esc               back to code · ⌘J hide";

impl ChangesTab {
    /// The changes tree (tests).
    pub fn tree(&self) -> &Entity<ListView<ChangesTree>> {
        &self.tree
    }

    /// The commit message area (tests).
    pub fn message(&self) -> &Entity<TextArea> {
        &self.message
    }

    /// The last read (None before the first).
    pub fn data(&self) -> Option<&LocalChanges> {
        self.data.as_ref()
    }

    pub fn amend(&self) -> bool {
        self.amend
    }

    pub fn committing(&self) -> bool {
        self.committing || self.pending.is_some()
    }

    /// The pane with the keyboard last.
    pub fn pane(&self) -> Pane {
        self.pane
    }

    fn root(&self) -> Option<PathBuf> {
        self.gcx.root()
    }

    /// "3 files" / "3 files, 1 marked" (the Lua header's count).
    pub fn count_text(&self, cx: &App) -> String {
        let n = self.data.as_ref().map_or(0, |d| d.files.len());
        let marked = self.included(cx).len();
        if marked > 0 {
            format!("{}, {marked} marked", count(n))
        } else {
            count(n)
        }
    }

    /// What a commit would take now ("Commit all 2 changed file(s)", "Commit 1 marked
    /// file(s)", "Commit merge"), or why there's nothing to commit.
    pub fn commit_hint(&self, cx: &App) -> String {
        let Some(d) = &self.data else {
            return String::new();
        };
        let included = self.included(cx);
        match commit::plan(&d.files, &included, d.merging, self.amend) {
            // a merge commit takes every tracked change, marked or not (git refuses partial
            // merge commits): say so when files are marked
            Ok(p) if d.merging && !included.is_empty() => {
                format!("Commit {}: all changes, marks don't apply", p.what)
            }
            Ok(p) => format!("Commit {}", p.what),
            Err(o) => o.message,
        }
    }

    /// The included (checked) paths.
    pub fn included(&self, cx: &App) -> HashSet<String> {
        self.tree
            .read(cx)
            .delegate
            .included()
            .cloned()
            .unwrap_or_default()
    }

    // Loading -------------------------------------------------------------------------------------

    /// Reads Local Changes in the background (one at a time; a request meanwhile reads again).
    pub fn load(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        if self.loading {
            self.reload = true;
            return;
        }
        self.loading = true;
        let ticket = self.loads.next();
        let task = job::spawn(cx, move || data::read_blocking(&root));
        cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |t, cx| {
                t.loading = false;
                if ticket.is_current()
                    && let Ok(lc) = res
                {
                    t.apply(lc, cx);
                }
                if std::mem::take(&mut t.reload) {
                    t.load(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply(&mut self, lc: LocalChanges, cx: &mut Context<Self>) {
        if self.data.as_ref() != Some(&lc) {
            let groups = groups(&lc);
            self.tree.update(cx, |v, cx| {
                let ListView {
                    delegate, state, ..
                } = v;
                delegate.set_groups(groups, state);
                if state.cursor().is_none() {
                    let first = (0..delegate.rows().len())
                        .find(|&i| !matches!(delegate.rows()[i].kind, RowKind::Empty));
                    state.set_cursor(first);
                }
                cx.notify();
            });
        }
        // git's prepared message (a merge / revert / cherry-pick) fills an empty message area,
        // and goes again with the operation
        let text = self.message.read(cx).text().to_owned();
        match &lc.prepared_message {
            Some(m) if text.is_empty() => {
                self.prefilled = Some(m.clone());
                let m = m.clone();
                self.message.update(cx, |a, cx| a.set_text(m, cx));
            }
            None if !self.amend
                && !text.is_empty()
                && self.prefilled.as_deref() == Some(text.as_str()) =>
            {
                self.prefilled = None;
                self.message.update(cx, |a, cx| a.set_text("", cx));
            }
            _ => {}
        }
        self.data = Some(lc);
    }

    // Focus ---------------------------------------------------------------------------------------

    fn focus_pane(&mut self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        self.pane = pane;
        match pane {
            Pane::Tree => {
                let h = self.tree.read(cx).focus_handle(cx);
                window.focus(&h, cx);
            }
            Pane::Message => {
                let h = self.message.read(cx).focus_handle(cx);
                window.focus(&h, cx);
            }
        }
        cx.notify();
    }

    // Actions -------------------------------------------------------------------------------------

    /// The selected rows' files (a folder / group: every file below).
    fn selected_files(&self, cx: &App) -> Vec<ChangeFile> {
        let v = self.tree.read(cx);
        v.delegate.files_of(&v.state.selection())
    }

    /// The cursor row's file.
    fn cursor_file(&self, cx: &App) -> Option<ChangeFile> {
        let v = self.tree.read(cx);
        match v.delegate.rows().get(v.state.cursor()?)?.kind {
            RowKind::File(fr) => Some(v.delegate.file(fr).clone()),
            _ => None,
        }
    }

    fn change(&self, path: &str) -> Option<&data::Change> {
        self.data.as_ref()?.file(path)
    }

    /// Included files, else the selected ones (Lua `changes.lua` `targets`).
    fn targets(&self, cx: &App) -> Vec<data::Change> {
        let inc = self.included(cx);
        let Some(d) = &self.data else {
            return Vec::new();
        };
        let included: Vec<data::Change> = d
            .files
            .iter()
            .filter(|f| inc.contains(&f.path))
            .cloned()
            .collect();
        if !included.is_empty() {
            return included;
        }
        self.selected_files(cx)
            .iter()
            .filter_map(|f| self.change(&f.path).cloned())
            .collect()
    }

    /// Enter / double-click / Show Diff: the diff of the first file (Alt+Cmd+arrows step through
    /// the others), a conflict's merge window.
    fn open_files(&mut self, files: Vec<ChangeFile>, cx: &mut Context<Self>) {
        let Some(first) = files.into_iter().next() else {
            return;
        };
        let Some(root) = self.root() else {
            return;
        };
        let root = root.to_string_lossy().into_owned();
        if first.status == ChangeStatus::Conflict {
            self.gcx
                .scx
                .call(LUA, "merge", vec![root.into(), first.path.into()]);
            return;
        }
        let ordered: Vec<ChangeFile> = self
            .tree
            .read(cx)
            .delegate
            .ordered_files()
            .into_iter()
            .filter(|f| f.status != ChangeStatus::Conflict)
            .collect();
        let index = ordered
            .iter()
            .position(|f| f.path == first.path)
            .unwrap_or(0);
        self.gcx.scx.navigate(
            LUA,
            "diff",
            vec![
                root.into(),
                git_files(&ordered),
                (index as i64 + 1).into(),
                "HEAD".into(),
                Value::Nil,
            ],
        );
    }

    /// Show Diff (Cmd+D, the toolbar): the selected files (else the selected folders' files).
    fn show_diff(&mut self, cx: &mut Context<Self>) {
        let files: Vec<ChangeFile> = {
            let v = self.tree.read(cx);
            let rows: Vec<usize> = v
                .state
                .selection()
                .into_iter()
                .filter(|&r| matches!(v.delegate.rows()[r].kind, RowKind::File(_)))
                .collect();
            let files = v.delegate.files_of(&rows);
            if files.is_empty() {
                v.delegate.files_of(&v.state.selection())
            } else {
                files
            }
        };
        self.open_files(files, cx);
    }

    /// F4: the cursor's file in the editor (not a deleted one).
    fn jump_to_source(&mut self, cx: &mut Context<Self>) {
        let Some(f) = self.cursor_file(cx) else {
            return;
        };
        if f.status == ChangeStatus::Deleted {
            return;
        }
        if let Some(root) = self.root() {
            let path = root.join(&f.path).to_string_lossy().into_owned();
            self.gcx.scx.navigate(LUA, "jump", vec![path.into()]);
        }
    }

    /// Mark / Unmark for Commit on the given files.
    fn toggle_included(&mut self, files: &[ChangeFile], cx: &mut Context<Self>) {
        let paths: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
        self.tree.update(cx, |v, cx| {
            let mut refs = Vec::new();
            for (g, group) in v.delegate.groups().iter().enumerate() {
                for (f, file) in group.files.iter().enumerate() {
                    if paths.contains(file.path.as_str()) {
                        refs.push((g, f));
                    }
                }
            }
            v.delegate.toggle_included(&refs);
            cx.notify();
        });
        cx.notify();
    }

    fn refresh_now(&mut self, cx: &mut Context<Self>) {
        self.load(cx);
    }

    fn set_group_by_directory(&mut self, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            let on = !v.delegate.group_by_directory();
            let ListView {
                delegate, state, ..
            } = v;
            delegate.set_group_by_directory(on, state);
            cx.notify();
        });
    }

    fn set_all_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            let ListView {
                delegate, state, ..
            } = v;
            delegate.set_all_open(open, state);
            cx.notify();
        });
    }

    fn fold_cursor(&mut self, open: bool, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            if let Some(c) = v.state.cursor() {
                let ListView {
                    delegate, state, ..
                } = v;
                delegate.toggle(c, Some(open), state);
            }
            cx.notify();
        });
    }

    /// Where keyboard-opened popups go: under the tree's cursor row (approx: the list's scroll
    /// isn't known here; clamped into the tree).
    fn popup_point(&self, cx: &App) -> Point<Pixels> {
        let b = self.tree_bounds.get().unwrap_or_default();
        let row = self.tree.read(cx).state.cursor().unwrap_or(0) as f32;
        let y = (b.top() + px((row + 1.) * look::TREE_ROW_HEIGHT))
            .min(b.bottom() - px(look::TREE_ROW_HEIGHT.get()));
        point(b.left() + px(40.), y.max(b.top()))
    }

    /// Cmd+Z: rollback of the included files, else the selected ones, after a confirmation
    /// (Lua `changes.lua` `rollback`: unversioned files are left alone).
    fn rollback(&mut self, at: Option<Point<Pixels>>, window: &mut Window, cx: &mut Context<Self>) {
        let files: Vec<data::Change> = self
            .targets(cx)
            .into_iter()
            .filter(|f| f.kind != ChangeKind::Unversioned)
            .collect();
        if files.is_empty() {
            run::info("Nothing to roll back", window, cx);
            return;
        }
        let Some(root) = self.root() else {
            return;
        };
        let refs: Vec<&data::Change> = files.iter().collect();
        let menu = Menu::new(
            vec![
                MenuItem::new("Rollback").into(),
                MenuItem::new("Cancel").into(),
            ],
            Anchor::Point(at.unwrap_or_else(|| self.popup_point(cx))),
        )
        .title(commit::rollback_prompt(&refs));
        let this = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, window, cx| {
            if choice != Some(0) {
                return;
            }
            let _ = this.update(cx, |t, cx| {
                let scx = t.gcx.scx.clone();
                let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
                run::act(
                    &scx,
                    Busy::None,
                    move || {
                        let refs: Vec<&data::Change> = files.iter().collect();
                        (
                            commit::rollback_blocking(&root, &refs, Default::default()),
                            (),
                        )
                    },
                    window,
                    cx,
                    move |t, _, _, _, cx| {
                        let keep: Vec<String> = t
                            .included(cx)
                            .into_iter()
                            .filter(|p| !paths.contains(p))
                            .collect();
                        t.tree.update(cx, |v, _| v.delegate.set_included(keep));
                        t.load(cx);
                    },
                );
            });
        });
    }

    /// Add to VCS (the selected unversioned files).
    fn add_to_vcs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        let paths: Vec<String> = self
            .selected_files(cx)
            .into_iter()
            .filter(|f| f.status == ChangeStatus::Unversioned)
            .map(|f| f.path)
            .collect();
        let scx = self.gcx.scx.clone();
        run::act(
            &scx,
            Busy::None,
            move || {
                let p: Vec<&str> = paths.iter().map(String::as_str).collect();
                (commit::add_blocking(&root, &p), ())
            },
            window,
            cx,
            |t, _, _, _, cx| t.load(cx),
        );
    }

    /// Commit (Cmd+Enter / Cmd+K in the message, the button); `push`: Commit and Push.
    pub fn commit(&mut self, push: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.committing() {
            return;
        }
        let Some(d) = &self.data else {
            return;
        };
        if let Err(o) = commit::plan(&d.files, &self.included(cx), d.merging, self.amend) {
            popups::notify(run::balloon(&o), window, cx);
            return;
        }
        let message = self.message.read(cx).text().to_owned();
        if message.trim().is_empty() {
            popups::notify(
                run::balloon(&Outcome::refused(Level::Info, "Commit message is empty")),
                window,
                cx,
            );
            self.focus_pane(Pane::Message, window, cx);
            return;
        }
        // Lua saves the buffers first (`silent! wall`) and answers `saved_all`
        self.token += 1;
        self.pending = Some(PendingCommit {
            token: self.token,
            message,
            amend: self.amend,
            push,
        });
        self.gcx
            .scx
            .call(LUA, "save_all", vec![(self.token as i64).into()]);
        cx.notify();
    }

    /// The buffers are saved: commit (the status read again: the save may have changed it).
    fn run_commit(&mut self, token: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.pending.take_if(|p| p.token == token) else {
            return;
        };
        let Some(root) = self.root() else {
            return;
        };
        self.committing = true;
        let included = self.included(cx);
        let scx = self.gcx.scx.clone();
        let (message, amend, push) = (p.message, p.amend, p.push);
        run::act(
            &scx,
            Busy::After("Committing…".into()),
            move || match data::read_blocking(&root) {
                // the marked files have no changes anymore (undone since): never fall back to
                // committing every tracked change (Lua fixed the paths when it prompted)
                Ok(lc)
                    if !lc.merging
                        && !included.is_empty()
                        && !lc.files.iter().any(|f| included.contains(&f.path)) =>
                {
                    (
                        Outcome::refused(
                            Level::Warn,
                            "The marked files have no changes anymore: nothing committed",
                        ),
                        Vec::new(),
                    )
                }
                Ok(lc) => {
                    let r = commit::commit_blocking(
                        &root, &message, &lc.files, &included, lc.merging, amend,
                    );
                    (r.outcome, r.committed)
                }
                Err(e) => (Outcome::failed("status", e.to_string()), Vec::new()),
            },
            window,
            cx,
            move |t, outcome, committed, window, cx| {
                t.committing = false;
                if outcome.ok {
                    t.message.update(cx, |a, cx| a.set_text("", cx));
                    t.prefilled = None;
                    t.amend = false;
                    let keep: Vec<String> = t
                        .included(cx)
                        .into_iter()
                        .filter(|p| !committed.contains(p))
                        .collect();
                    t.tree.update(cx, |v, _| v.delegate.set_included(keep));
                    if push {
                        t.push(window, cx);
                    }
                }
                t.load(cx);
            },
        );
    }

    /// Cmd+Shift+K (Lua `changes.lua` `push`: "Pushing…", then "Pushed" / "Pushed (upstream
    /// set)").
    pub fn push(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // the tool window may never have opened (no root yet): the project's repo (Lua pushed
        // from anywhere)
        let root = self.root();
        let project = self.gcx.scx.project.clone();
        let scx = self.gcx.scx.clone();
        run::act(
            &scx,
            Busy::Now("Pushing…".into()),
            move || {
                let root = root.or_else(|| crate::git::cli::repo_root_blocking(&project));
                let outcome = match root {
                    Some(root) => ops::push_blocking(&root, &Cancel::new(), |_| {}),
                    None => Outcome::refused(Level::Warn, "Not a git repository"),
                };
                (outcome, ())
            },
            window,
            cx,
            |_, _, _, _, _| {},
        );
    }

    /// Pull (WS Update Project / Pull: merge, local changes stashed around it).
    pub fn pull(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        let scx = self.gcx.scx.clone();
        run::act(
            &scx,
            Busy::After("Pulling…".into()),
            move || (ops::pull_blocking(&root, &Cancel::new(), |_| {}), ()),
            window,
            cx,
            |t, _, _, _, cx| t.load(cx),
        );
    }

    /// Fetch all remotes.
    pub fn fetch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        let scx = self.gcx.scx.clone();
        run::act(
            &scx,
            Busy::After("Fetching…".into()),
            move || (ops::fetch_blocking(&root, &Cancel::new(), |_| {}), ()),
            window,
            cx,
            |_, _, _, _, _| {},
        );
    }

    /// Amend on: an empty message gets the last commit's (WS); off: that text goes again.
    pub fn set_amend(&mut self, on: bool, cx: &mut Context<Self>) {
        self.amend = on;
        let text = self.message.read(cx).text().to_owned();
        if !on {
            if !text.is_empty() && self.prefilled.as_deref() == Some(text.as_str()) {
                self.prefilled = None;
                self.message.update(cx, |a, cx| a.set_text("", cx));
            }
            cx.notify();
            return;
        }
        let Some(root) = self.root().filter(|_| text.is_empty()) else {
            cx.notify();
            return;
        };
        let task = job::spawn(cx, move || commit::last_message_blocking(&root));
        cx.spawn(async move |this, cx| {
            let msg = task.await;
            let _ = this.update(cx, |t, cx| {
                if let Some(m) = msg
                    && t.amend
                    && t.message.read(cx).text().is_empty()
                {
                    t.prefilled = Some(m.clone());
                    t.message.update(cx, |a, cx| a.set_text(m, cx));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn help(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut b = popups::Balloon::info("Git", HELP);
        b.timeout = Some(std::time::Duration::from_secs(10));
        popups::notify(b, window, cx);
    }

    /// Copy Path / Copy Relative Path (`config/context.lua` `path_items`) of the selected rows.
    fn copy_paths(&mut self, relative: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        let rel: Vec<String> = {
            let v = self.tree.read(cx);
            v.state
                .selection()
                .iter()
                .filter_map(|&r| match &v.delegate.rows().get(r)?.kind {
                    RowKind::File(fr) => Some(v.delegate.file(*fr).path.clone()),
                    RowKind::Dir { path, .. } => Some(path.clone()),
                    RowKind::Group(_) | RowKind::Empty => None,
                })
                .collect()
        };
        if rel.is_empty() {
            return;
        }
        let project = self.gcx.scx.project.clone();
        let paths: Vec<String> = rel
            .iter()
            .map(|p| {
                let abs = root.join(p);
                match abs.strip_prefix(&project) {
                    Ok(r) if relative => r.to_string_lossy().into_owned(),
                    _ if relative => p.clone(),
                    _ => abs.to_string_lossy().into_owned(),
                }
            })
            .collect();
        crate::kit::copy_paths(paths, window, cx);
    }

    /// Show History for File: the Log filtered to the cursor's file.
    fn file_history(&mut self, cx: &mut Context<Self>) {
        if let (Some(f), Some(root)) = (self.cursor_file(cx), self.root()) {
            let abs = root.join(f.path).to_string_lossy().into_owned();
            self.gcx.scx.call(LUA, "file_history", vec![abs.into()]);
        }
    }

    // Menu ----------------------------------------------------------------------------------------

    /// The context menu's entries and their actions (right-click / Cmd+Enter): M4 Lua
    /// `git/init.lua`'s Local Changes items, the toolbar's and the commit panel's actions, the tree's fold items.
    pub fn menu_entries(&self, cx: &App) -> (Vec<MenuEntry>, Vec<Option<Act>>) {
        let files = self.selected_files(cx);
        let cursor_file = self.cursor_file(cx);
        let cursor_folder = {
            let v = self.tree.read(cx);
            v.state
                .cursor()
                .and_then(|c| v.delegate.rows().get(c))
                .filter(|r| r.is_folder())
                .map(|r| r.open)
        };
        let inc = self.included(cx);
        let unversioned = files
            .iter()
            .filter(|f| f.status == ChangeStatus::Unversioned)
            .count();
        let included = !files.is_empty() && files.iter().all(|f| inc.contains(&f.path));
        let conflict = cursor_file
            .as_ref()
            .is_some_and(|f| f.status == ChangeStatus::Conflict);
        let group_by_dir = self.tree.read(cx).delegate.group_by_directory();
        let has = !files.is_empty();
        let mut entries: Vec<MenuEntry> = Vec::new();
        let mut acts: Vec<Option<Act>> = Vec::new();
        let mut item = |it: MenuItem, a: Option<Act>| {
            match a {
                Some(_) => entries.push(it.into()),
                None => entries.push(MenuEntry::Separator),
            }
            acts.push(a);
        };
        let sep = || (MenuItem::new(""), None::<Act>);
        item(
            MenuItem::new(if conflict {
                "Resolve Conflicts…"
            } else {
                "Show Diff"
            })
            .shortcut("⏎")
            .icon(IconName::Diff)
            .enabled(has),
            Some(|t, _, _, cx| t.show_diff(cx)),
        );
        item(
            MenuItem::new("Jump to Source").shortcut("F4").enabled(
                cursor_file
                    .as_ref()
                    .is_some_and(|f| f.status != ChangeStatus::Deleted),
            ),
            Some(|t, _, _, cx| t.jump_to_source(cx)),
        );
        item(
            MenuItem::new(if included {
                "Unmark for Commit"
            } else {
                "Mark for Commit"
            })
            .shortcut("Space")
            .enabled(has),
            Some(|t, _, _, cx| {
                let files = t.selected_files(cx);
                t.toggle_included(&files, cx);
            }),
        );
        let (s, a) = sep();
        item(s, a);
        item(
            MenuItem::new("Commit…")
                .shortcut("⌘K")
                .icon(IconName::Commit),
            Some(|t, _, w, cx| t.focus_pane(Pane::Message, w, cx)),
        );
        item(
            MenuItem::new("Commit and Push…").shortcut("⌥⌘K"),
            Some(|t, _, w, cx| t.commit(true, w, cx)),
        );
        item(
            MenuItem::new("Push…").shortcut("⇧⌘K").icon(IconName::Push),
            Some(|t, _, w, cx| t.push(w, cx)),
        );
        item(
            MenuItem::new("Pull").icon(IconName::Update),
            Some(|t, _, w, cx| t.pull(w, cx)),
        );
        item(
            MenuItem::new("Fetch").icon(IconName::Fetch),
            Some(|t, _, w, cx| t.fetch(w, cx)),
        );
        item(
            MenuItem::new("Rollback…")
                .shortcut("⌘Z")
                .icon(IconName::Revert)
                .enabled(unversioned < files.len() || !inc.is_empty()),
            Some(|t, at, w, cx| t.rollback(Some(at), w, cx)),
        );
        item(
            MenuItem::new("Add to VCS").enabled(unversioned > 0),
            Some(|t, _, w, cx| t.add_to_vcs(w, cx)),
        );
        if cursor_file.is_some() || cursor_folder.is_some() {
            let (s, a) = sep();
            item(s, a);
            if cursor_file.is_some() {
                item(
                    MenuItem::new("Show History for File"),
                    Some(|t, _, _, cx| t.file_history(cx)),
                );
            }
            item(
                MenuItem::new("Copy Path").shortcut("⌘C"),
                Some(|t, _, w, cx| t.copy_paths(false, w, cx)),
            );
            item(
                MenuItem::new("Copy Relative Path"),
                Some(|t, _, w, cx| t.copy_paths(true, w, cx)),
            );
        }
        let (s, a) = sep();
        item(s, a);
        match cursor_folder {
            Some(true) => item(
                MenuItem::new("Collapse").shortcut("←"),
                Some(|t, _, _, cx| t.fold_cursor(false, cx)),
            ),
            Some(false) => item(
                MenuItem::new("Expand").shortcut("→"),
                Some(|t, _, _, cx| t.fold_cursor(true, cx)),
            ),
            None => {}
        }
        item(
            MenuItem::new("Expand All").icon(IconName::ExpandAll),
            Some(|t, _, _, cx| t.set_all_open(true, cx)),
        );
        item(
            MenuItem::new("Collapse All").icon(IconName::CollapseAll),
            Some(|t, _, _, cx| t.set_all_open(false, cx)),
        );
        item(
            MenuItem::new(if group_by_dir {
                "Group by Directory: Off"
            } else {
                "Group by Directory: On"
            })
            .icon(IconName::GroupByDirectory),
            Some(|t, _, _, cx| t.set_group_by_directory(cx)),
        );
        let (s, a) = sep();
        item(s, a);
        item(
            MenuItem::new("Refresh")
                .shortcut("R")
                .icon(IconName::Refresh),
            Some(|t, _, _, cx| t.refresh_now(cx)),
        );
        item(
            MenuItem::new("Help").shortcut("g?"),
            Some(|t, _, w, cx| t.help(w, cx)),
        );
        item(
            MenuItem::new("Hide").shortcut("⌘J"),
            Some(|t, _, _, _| t.gcx.scx.call("config.app.git", "hide", vec![])),
        );
        (entries, acts)
    }

    fn open_menu(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let (entries, acts) = self.menu_entries(cx);
        self.show_menu(entries, acts, Anchor::Point(at), at, window, cx);
    }

    /// The View Options eye ▾ (WS ChangesViewToolbar `ChangesView.ViewOptions`: Group By ▸
    /// Directory, here flat as the Log details' eye).
    fn view_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let on = self.tree.read(cx).delegate.group_by_directory();
        let mut group = MenuItem::new("Group by Directory");
        if on {
            group = group.icon(IconName::Checked);
        }
        let entries = vec![group.into()];
        let acts: Vec<Option<Act>> = vec![Some(|t, _, _, cx| t.set_group_by_directory(cx))];
        let anchor = self.bounds_anchor(&self.eye_bounds, window);
        self.show_menu(entries, acts, anchor, window.mouse_position(), window, cx);
    }

    /// The ⚙ commit options (WS ShowCommitOptionsAction): the options we have, Amend.
    fn options_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut amend = MenuItem::new("Amend");
        if self.amend {
            amend = amend.icon(IconName::Checked);
        }
        let entries = vec![amend.into()];
        let acts: Vec<Option<Act>> = vec![Some(|t, _, _, cx| t.set_amend(!t.amend, cx))];
        let anchor = self.bounds_anchor(&self.gear_bounds, window);
        self.show_menu(entries, acts, anchor, window.mouse_position(), window, cx);
    }

    fn bounds_anchor(&self, cell: &Rc<Cell<Option<Bounds<Pixels>>>>, window: &Window) -> Anchor {
        match cell.get() {
            Some(b) => Anchor::Below(b),
            None => Anchor::Point(window.mouse_position()),
        }
    }

    fn show_menu(
        &mut self,
        entries: Vec<MenuEntry>,
        acts: Vec<Option<Act>>,
        anchor: Anchor,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let menu = Menu::new(entries, anchor);
        let this = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, window, cx| {
            let Some(act) = choice.and_then(|i| acts.get(i).copied().flatten()) else {
                return;
            };
            let _ = this.update(cx, |t, cx| act(t, at, window, cx));
        });
    }

    // Keys ----------------------------------------------------------------------------------------

    /// Keys the tree didn't use.
    fn tree_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let g = std::mem::take(&mut self.g);
        match key {
            "?" if g => self.help(window, cx),
            "g" => self.g = true,
            "<F4>" => self.jump_to_source(cx),
            "<D-z>" | "<M-D-z>" => self.rollback(None, window, cx),
            "<D-d>" => self.show_diff(cx),
            "R" => self.refresh_now(cx),
            "<D-k>" | "<Tab>" | "<S-Tab>" => self.focus_pane(Pane::Message, window, cx),
            "<M-D-k>" => self.commit(true, window, cx),
            "<D-S-k>" => self.push(window, cx),
            "<D-CR>" => {
                let at = self.popup_point(cx);
                self.open_menu(at, window, cx);
            }
            _ => return false,
        }
        true
    }

    /// Keys the message area didn't use.
    fn message_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        match key {
            "<D-CR>" | "<D-k>" => self.commit(false, window, cx),
            "<M-D-k>" => self.commit(true, window, cx),
            "<D-S-k>" => self.push(window, cx),
            "<Esc>" | "<Tab>" | "<S-Tab>" => self.focus_pane(Pane::Tree, window, cx),
            _ => return false,
        }
        true
    }

    fn on_tree_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        if self.tree_key(&key, window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_message_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        if self.message_key(&key, window, cx) {
            cx.stop_propagation();
        }
    }

    fn on_tree_event(
        &mut self,
        _: &Entity<ListView<ChangesTree>>,
        ev: &ChangesTreeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            ChangesTreeEvent::Open(files) => self.open_files(files.clone(), cx),
            ChangesTreeEvent::ContextMenu(at) => {
                self.pane = Pane::Tree;
                self.open_menu(*at, window, cx);
            }
            ChangesTreeEvent::Cancel => self.gcx.scx.call("config.app.git", "leave", vec![]),
            // dd: Cmd+Z's rollback (confirmed)
            ChangesTreeEvent::Delete => self.rollback(None, window, cx),
            ChangesTreeEvent::Help => self.help(window, cx),
            ChangesTreeEvent::IncludedChanged | ChangesTreeEvent::SelectionChanged => {}
        }
        cx.notify();
    }

    // Render --------------------------------------------------------------------------------------

    fn button(
        &self,
        id: &'static str,
        icon: IconName,
        tip: &'static str,
        key: Option<&'static str>,
        cx: &mut Context<Self>,
        f: fn(&mut ChangesTab, &mut Window, &mut Context<ChangesTab>),
    ) -> IconButton {
        let this = cx.entity().downgrade();
        IconButton::new(id, icon)
            .tooltip(tip, key)
            .on_click(move |_, window, cx| {
                let _ = this.update(cx, |t, cx| f(t, window, cx));
            })
    }

    fn render_toolbar(&self, pane_w: Pixels, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let bar = toolbar(Axis::Horizontal)
            .child(self.button(
                "lc-refresh",
                IconName::Refresh,
                "Refresh",
                Some("R"),
                cx,
                |t, _, cx| t.refresh_now(cx),
            ))
            .child(self.button(
                "lc-rollback",
                IconName::Revert,
                "Rollback…",
                Some("⌘Z"),
                cx,
                |t, w, cx| t.rollback(None, w, cx),
            ))
            .child(self.button(
                "lc-diff",
                IconName::Diff,
                "Show Diff",
                Some("⌘D"),
                cx,
                |t, _, cx| t.show_diff(cx),
            ))
            .child(toolbar_separator(Axis::Horizontal))
            .child(
                div()
                    .relative()
                    .child(
                        self.button(
                            "lc-view",
                            IconName::Show,
                            "View Options",
                            None,
                            cx,
                            |t, w, cx| t.view_menu(w, cx),
                        )
                        .dropdown(true),
                    )
                    .child(bounds_probe(self.eye_bounds.clone())),
            )
            .child(self.button(
                "lc-expand",
                IconName::ExpandAll,
                "Expand All",
                None,
                cx,
                |t, _, cx| t.set_all_open(true, cx),
            ))
            .child(self.button(
                "lc-collapse",
                IconName::CollapseAll,
                "Collapse All",
                None,
                cx,
                |t, _, cx| t.set_all_open(false, cx),
            ));
        // the count goes when the pane gets narrow (the Lua header's rule: the buttons stay)
        let bar_w = 7. * (look::ACTION_BUTTON_SIZE + look::ACTION_BUTTON_GAP)
            + 2. * look::TOOLBAR_SEPARATOR_MARGIN
            + 2. * look::ACTION_TOOLBAR_PAD_X;
        let text = self.count_text(cx);
        let fits = self.data.is_some()
            && f32::from(pane_w) >= bar_w + 24. + text.chars().count() as f32 * CHAR_W;
        div()
            .id("lc-toolbar")
            .flex_none()
            .h(px(TOOLBAR_HEIGHT))
            .flex()
            .items_center()
            .px(px(look::ACTION_TOOLBAR_PAD_X.get()))
            .child(bar)
            .child(div().flex_1())
            .when(fits, |d| {
                d.child(
                    div()
                        .debug_selector(|| "lc-count".into())
                        .flex_none()
                        .pr(px(8.))
                        .text_color(look::TEXT_DIM)
                        .child(text),
                )
            })
    }

    fn render_commit_panel(
        &self,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let this = cx.entity().downgrade();
        let busy = self.committing();
        let commit_btn = {
            let this = this.clone();
            TextButton::new(
                "lc-commit",
                if self.amend { "Amend Commit" } else { "Commit" },
            )
            // WS: the default (blue) button only while the commit view has the keyboard
            // (ChangesViewCommitPanel isCommitButtonDefault = isFocusAncestor)
            .primary(focused)
            .disabled(busy)
            .on_click(move |_, window, cx| {
                let _ = this.update(cx, |t, cx| t.commit(false, window, cx));
            })
        };
        let push_btn = {
            let this = this.clone();
            TextButton::new(
                "lc-commit-push",
                if self.amend {
                    "Amend Commit and Push…"
                } else {
                    "Commit and Push…"
                },
            )
            .disabled(busy)
            .on_click(move |_, window, cx| {
                let _ = this.update(cx, |t, cx| t.commit(true, window, cx));
            })
        };
        let amend = Checkbox::new(
            "lc-amend",
            if self.amend {
                CheckState::Checked
            } else {
                CheckState::Unchecked
            },
        )
        .label("Amend")
        .on_toggle({
            let this = this.clone();
            move |state, _, cx| {
                let _ = this.update(cx, |t, cx| t.set_amend(state == CheckState::Checked, cx));
            }
        });
        let gear = div()
            .relative()
            .child(
                IconButton::new("lc-options", IconName::Settings)
                    .tooltip("Show Commit Options", None)
                    .on_click(move |_, window, cx| {
                        let _ = this.update(cx, |t, cx| t.options_menu(window, cx));
                    }),
            )
            .child(bounds_probe(self.gear_bounds.clone()));
        // what a commit takes (Lua's prompt text): its own line under the message, cut with an
        // ellipsis when the panel is narrow (beside the buttons it never fit the default width)
        let hint = self.commit_hint(cx);
        let on_key = cx.listener(Self::on_message_key);
        div()
            .size_full()
            .flex()
            .flex_col()
            .min_w_0()
            // WS ChangesView.CommitToolbar: Amend in a row above the message, level with the
            // changes toolbar beside it (statusPanelBorder compact: left 0, right 6)
            .child(
                div()
                    .flex_none()
                    .h(px(TOOLBAR_HEIGHT))
                    .flex()
                    .items_center()
                    .pl(px(look::COMMIT_PANEL_PAD_X.get()))
                    .pr(px(look::COMMIT_PANEL_PAD_X.get()))
                    .child(div().debug_selector(|| "lc-amend".into()).child(amend)),
            )
            .child(
                div()
                    .id("lc-message")
                    .debug_selector(|| "lc-message".into())
                    .flex_1()
                    .min_h(px(0.))
                    .mx(px(
                        look::COMMIT_MESSAGE_MARGIN_X + look::COMMIT_MESSAGE_OUTLINE_GAP
                    ))
                    .mt(px(
                        look::COMMIT_MESSAGE_MARGIN_Y + look::COMMIT_MESSAGE_OUTLINE_GAP
                    ))
                    .mb(px(look::COMMIT_MESSAGE_OUTLINE_GAP))
                    .on_key_down(on_key)
                    .child(self.message.clone()),
            )
            .when(!hint.is_empty(), |d| {
                d.child(
                    div()
                        .debug_selector(|| "lc-hint".into())
                        .flex_none()
                        .h(px(HINT_HEIGHT))
                        .px(px(look::COMMIT_PANEL_PAD_X + 3.))
                        .pt(px(3.))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_color(look::TEXT_DIM)
                        .child(hint),
                )
            })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    // WS actionPanelBorder (3, 3, 3, 6) + DarculaButton's 3 px invisible insets:
                    // 6 visible on the left; the gear's toolbar button insets 2 on the right
                    .pl(px(look::COMMIT_PANEL_PAD_X.get()))
                    .pr(px(look::COMMIT_PANEL_PAD_X + 2.))
                    .py(px(look::COMMIT_ACTIONS_PAD_Y + 3.))
                    .child(commit_btn)
                    .child(push_btn)
                    .child(div().flex_1())
                    .child(gear),
            )
    }
}

impl GitTab for ChangesTab {
    const ID: TabId = TabId::Changes;

    fn new(gcx: GitCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tree = cx.new(|cx| {
            ListView::new(
                ChangesTree::new()
                    .with_checkboxes()
                    .with_delete_key()
                    .with_empty_text("No local changes"),
                cx,
            )
        });
        let message = cx.new(|cx| {
            TextArea::new(cx)
                .style(TextAreaStyle::commit_message())
                .placeholder("Commit Message")
        });
        let side = cx.new(|_| {
            SplitState::new(SplitAxis::Horizontal, Fixed::Second, px(COMMIT_PANEL_WIDTH))
                .with_min(px(200.), px(260.))
        });
        let stacked = cx.new(|_| {
            SplitState::new(SplitAxis::Vertical, Fixed::Second, px(COMMIT_PANEL_HEIGHT))
                .with_min(px(60.), px(look::COMMIT_PANEL_MIN_HEIGHT))
        });
        let subs = vec![
            cx.subscribe_in(&tree, window, Self::on_tree_event),
            cx.subscribe(&message, |_, _, _: &TextAreaEvent, cx| cx.notify()),
            cx.observe(&tree, |_, _, cx| cx.notify()),
        ];
        ChangesTab {
            gcx,
            tree,
            message,
            side,
            stacked,
            data: None,
            loads: job::Latest::new(),
            loading: false,
            reload: false,
            stale: false,
            amend: false,
            prefilled: None,
            committing: false,
            pending: None,
            token: 0,
            pane: Pane::Tree,
            g: false,
            refocus: false,
            redispatched: false,
            width: Rc::new(Cell::new(px(0.))),
            tree_bounds: Rc::default(),
            eye_bounds: Rc::default(),
            gear_bounds: Rc::default(),
            refreshes: Vec::new(),
            commands: Vec::new(),
            shown: false,
            _subs: subs,
        }
    }

    fn label(&self, _cx: &App) -> SharedString {
        "Local Changes".into()
    }

    /// A key while the view itself has the keyboard: the pane that had it takes it and gets the
    /// key.
    fn on_key(
        &mut self,
        key: &str,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if std::mem::take(&mut self.redispatched) {
            return false;
        }
        // bubbled up from a pane that didn't use it: the view's (Esc, the `,` leader keys: `,w`
        // here was redispatched alone and lost its `,`)
        let in_pane = self
            .tree
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
            || self
                .message
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx);
        if in_pane {
            return false;
        }
        let drawn = self.pane == Pane::Message || self.data.is_some();
        if !drawn {
            return self.pane == Pane::Tree && self.tree_key(key, window, cx);
        }
        // once: if the pane can't take the keyboard yet, the key comes back here and is the view's
        self.focus_pane(self.pane, window, cx);
        self.redispatched = true;
        let ks = ev.keystroke.clone();
        let this = cx.entity().downgrade();
        window.defer(cx, move |window, cx| {
            window.dispatch_keystroke(ks, cx);
            let _ = this.update(cx, |t, _| t.redispatched = false);
        });
        true
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<LuaEvent>(TabId::Changes.bridge(), payload) else {
            return;
        };
        match ev {
            LuaEvent::Saved if self.shown => self.load(cx),
            LuaEvent::Saved => self.stale = true,
            LuaEvent::SavedAll { token } => self.run_commit(token, window, cx),
        }
    }

    fn refresh(&mut self, why: RepoChange, _w: &mut Window, cx: &mut Context<Self>) {
        self.refreshes.push(why);
        if let Some(root) = self.root() {
            self.tree.update(cx, |v, _| v.delegate.set_root(root));
        }
        if self.shown || why == RepoChange::Opened {
            self.load(cx);
        } else {
            self.stale = true;
        }
        cx.notify();
    }

    fn command(&mut self, cmd: &GitCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.commands.push(cmd.clone());
        match cmd {
            // Cmd+K: the message (Cmd+K there commits: the message area's own key)
            GitCommand::Commit => self.focus_pane(Pane::Message, window, cx),
            GitCommand::CommitPush => self.commit(true, window, cx),
            GitCommand::Push => self.push(window, cx),
            _ => {}
        }
        cx.notify();
    }

    fn shown(&mut self, shown: bool, _w: &mut Window, cx: &mut Context<Self>) {
        self.shown = shown;
        if shown && std::mem::take(&mut self.stale) {
            self.load(cx);
        }
        cx.notify();
    }
}

impl Render for ChangesTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // the tool window took the keyboard (Cmd+3, a click): the pane that had it gets it
        // (once per focus change; the tree only once it's drawn)
        let drawn = self.pane == Pane::Message || self.data.is_some();
        if self.shown && drawn && !self.refocus && self.gcx.view_focus().is_focused(window) {
            self.refocus = true;
            let this = cx.entity().downgrade();
            window.defer(cx, move |window, cx| {
                let _ = this.update(cx, |t, cx| {
                    t.refocus = false;
                    if t.shown && t.gcx.view_focus().is_focused(window) {
                        t.focus_pane(t.pane, window, cx);
                    }
                });
            });
        }
        if self.message.read(cx).focus_handle(cx).is_focused(window) {
            self.pane = Pane::Message;
        } else if self
            .tree
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
        {
            self.pane = Pane::Tree;
        }
        let width = self.width.get();
        let side_by_side = width == px(0.) || f32::from(width) >= SIDE_BY_SIDE_MIN_WIDTH;
        let tree_w = if side_by_side {
            self.side.read(cx).first_len(width)
        } else {
            width
        };
        let tree_bounds = self.tree_bounds.clone();
        let on_tree_key = cx.listener(Self::on_tree_key);
        let tree_pane = div()
            .size_full()
            .flex()
            .flex_col()
            .min_w_0()
            .child(self.render_toolbar(tree_w, cx))
            .child(
                div()
                    .id("lc-tree")
                    .debug_selector(|| "lc-tree".into())
                    .flex_1()
                    .min_h(px(0.))
                    .relative()
                    .on_key_down(on_tree_key)
                    // Tab: the message (the list would take it as Down); Cmd+C: the paths with
                    // Lua's "Copied" balloon
                    .capture_key_down(cx.listener(|t, ev: &KeyDownEvent, window, cx| {
                        match crate::kit::notation(ev).as_deref() {
                            Some("<Tab>" | "<S-Tab>") => t.focus_pane(Pane::Message, window, cx),
                            Some("<D-c>") if run::copy_tree_paths(&t.tree, window, cx) => {}
                            _ => return,
                        }
                        cx.stop_propagation();
                    }))
                    .child(
                        canvas(move |b, _, _| tree_bounds.set(Some(b)), |_, _, _, _| {})
                            .absolute()
                            .size_full(),
                    )
                    // nothing until the first read: never an empty "No local changes" frame
                    .when(self.data.is_some(), |d| d.child(self.tree.clone())),
            );
        let focused = self.gcx.view_focus().contains_focused(window, cx);
        let panel = self.render_commit_panel(focused, cx);
        let body = if side_by_side {
            split("lc-split", &self.side, tree_pane, panel, cx)
        } else {
            split("lc-split-v", &self.stacked, tree_pane, panel, cx)
        };
        let width_cell = self.width.clone();
        let entity = cx.entity().downgrade();
        let measure = canvas(
            move |b, window, cx| {
                let w = b.size.width;
                if width_cell.get() != w {
                    width_cell.set(w);
                    let _ = entity.update(cx, |_, cx| cx.notify());
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        div()
            .id("local-changes")
            .relative()
            .size_full()
            .font(ui_font())
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .child(measure)
            .child(body)
    }
}

/// Records where its parent was drawn (menus open below a button).
fn bounds_probe(cell: Rc<Cell<Option<Bounds<Pixels>>>>) -> impl IntoElement {
    canvas(move |b, _, _| cell.set(Some(b)), |_, _, _, _| {})
        .absolute()
        .size_full()
}
