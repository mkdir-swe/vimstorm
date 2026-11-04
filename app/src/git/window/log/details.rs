//! The Log's details pane (right of the commit table), WebStorm's commit details: a toolbar row
//! (Show Diff, View Options, Show History; "N files"), the changed files tree
//! ([`ChangesTree`], no checkboxes) and, below a splitter, the commit details text
//! ([`text`]). Behaviour of Lua `git/details.lua`:
//!
//! - One commit: its files (`git show --name-status -M --diff-merges=first-parent`) and details,
//!   then the branches containing it (`git branch -a --contains`, slow in big repos: drawn with
//!   the rest when it comes within 80 ms, else joins later). Several selected commits: every
//!   file any of them changed, diffed from before the oldest to the newest, and the commit list.
//! - Off the UI thread, one load at a time, the newest wish wins (moving fast through the log,
//!   holding Space: the loads in between are skipped); commits never change, so details and
//!   combined files are cached per hash / selection. What's shown stays until the new content is
//!   in (the pane never blanks while moving through the log); no commit: empty.
//! - `refresh` (the repo changed, same commit): only the branches are asked again; the tree's
//!   cursor and folds stay.
//!
//! Keys (the tree has the keyboard): the tree's own (l / ö / arrows with a count, `gg` / `G`,
//! k / ä fold, Enter, Cmd+C / `yy`, `/` speed search, `g?` the Log's help), Enter / double-click on a file: its diff in the editor (Lua
//! `config.app.git_log.open_diff`, the keyboard stays here), F4: the file in the editor, k / ←
//! on a top-level row or Tab: back to the table ([`DetailsEvent::Back`]), Esc: back to the
//! editor, Cmd+Enter / right-click: the menu with everything. The Log's own keys (R, b u d p,
//! Backspace) reach [`super::LogTab`].

#[path = "details_text.rs"]
pub mod text;

use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, EventEmitter, Focusable as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Render, StatefulInteractiveElement as _, Styled as _, Window,
    canvas, div, point, px,
};
use rmpv::Value;

use super::model::DetailsTarget;
use crate::git::job;
use crate::git::log::Commit;
use crate::git::show::{self, ChangedFile, CombinedChanges, CommitDetails, DetailsCache};
use crate::git::window::GitCx;
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::ListView;
use crate::kit::notation;
use crate::kit::{Axis, IconButton, toolbar};
use crate::kit::{
    ChangeFile, ChangeGroup, ChangeStatus, ChangesTree, ChangesTreeEvent, RowKind, count,
};
use crate::kit::{Fixed, SplitAxis, SplitState, split};
use crate::look;
use crate::popups::{self, Menu, MenuEntry, MenuItem};
use crate::render::ui_font;
use text::Info;

/// What the pane asks the Log for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailsEvent {
    /// Left / k with nowhere to go in the tree, Tab: back to the commit table.
    Back,
    /// Show History for File on a file (repo-relative).
    FileHistory(String),
    /// Esc: back to the editor (or closes a history for a selection).
    Leave,
    /// `g?` in the files: the Log's key help.
    Help,
}

/// Lua glue for buffers / windows (`nvim/lua/config/app/git_log.lua`).
const LUA: &str = "config.app.git_log";
/// Lua `details.lua`: the branches join the rest when they come within this.
const BRANCHES_WAIT: Duration = Duration::from_millis(80);
/// Combined selections kept (like Lua `details.lua`'s caches: cleared past this).
const COMBINED_CACHE: usize = 500;

/// A load the pane wants (the newest wins).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Want {
    One(String),
    /// Hashes newest first; (hash, subject) for the list.
    Many(Vec<(String, String)>),
}

impl Want {
    fn key(&self) -> String {
        match self {
            Want::One(h) => h.clone(),
            Want::Many(c) => many_key(c.iter().map(|(h, _)| h.as_str())),
        }
    }
}

fn many_key<'a>(hashes: impl Iterator<Item = &'a str>) -> String {
    format!("multi:{}", hashes.collect::<Vec<_>>().join(","))
}

enum Loaded {
    One(Arc<CommitDetails>),
    Many(Arc<CombinedChanges>),
}

pub struct DetailsPane {
    gcx: GitCx,
    pub target: DetailsTarget,
    tree: Entity<ListView<ChangesTree>>,
    split: Entity<SplitState>,
    /// The repo the caches belong to.
    root: Option<PathBuf>,
    cache: DetailsCache,
    combined: HashMap<String, Arc<CombinedChanges>>,
    /// Branches containing a commit (until the next refresh: refs move).
    contains: HashMap<String, Vec<String>>,
    /// The shown content's key (a hash, `multi:<hashes>`); None: empty.
    shown: Option<String>,
    info: Info,
    /// The shown commit's refs as the log lists them (branch / tag labels under the metadata).
    refs: Option<(String, Vec<(gpui_kit::SharedString, crate::kit::RefKind)>)>,
    /// What a file's diff compares (old rev, new rev).
    revs: Option<(String, String)>,
    /// The newest content wished for, and whether a load runs.
    want: Option<Want>,
    loading: bool,
    /// Files in the tree (the toolbar's "N files": counted once, not per frame).
    file_count: usize,
    /// Branches to ask for next / being asked for.
    want_branches: Option<String>,
    branches_running: Option<String>,
    /// Details in, waiting (≤ [`BRANCHES_WAIT`]) for their branches.
    hold: Option<String>,
    /// Where the tree / the View Options button were drawn (menus anchor there).
    tree_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    eye_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl EventEmitter<DetailsEvent> for DetailsPane {}

impl DetailsPane {
    pub fn new(gcx: GitCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tree = cx.new(|cx| ListView::new(ChangesTree::new().with_empty_text(""), cx));
        let split = cx.new(|_| {
            SplitState::new(
                SplitAxis::Vertical,
                Fixed::Second,
                px(look::VCS_DETAILS_TEXT_HEIGHT),
            )
            .with_min(px(44.), px(44.))
        });
        let subs = vec![
            cx.subscribe_in(&tree, window, Self::on_tree_event),
            cx.observe(&split, |_, _, cx| cx.notify()),
        ];
        DetailsPane {
            gcx,
            target: DetailsTarget::None,
            tree,
            split,
            root: None,
            cache: DetailsCache::default(),
            combined: HashMap::new(),
            contains: HashMap::new(),
            shown: None,
            info: Info::None,
            refs: None,
            revs: None,
            want: None,
            loading: false,
            file_count: 0,
            want_branches: None,
            branches_running: None,
            hold: None,
            tree_bounds: Rc::default(),
            eye_bounds: Rc::default(),
            _subs: subs,
        }
    }

    // ---- what's shown ------------------------------------------------------------------------

    /// Show `target` (`commits`: the selected ones for `Many`). `refresh`: same target, the repo
    /// changed (its branches may have moved).
    pub fn show(
        &mut self,
        target: DetailsTarget,
        commits: Vec<Commit>,
        refresh: bool,
        cx: &mut Context<Self>,
    ) {
        self.target = target.clone();
        self.check_root(cx);
        if let DetailsTarget::One(h) = &target {
            let refs = commits
                .iter()
                .find(|c| c.hash == *h)
                .map(|c| super::table::ref_icons(c).0)
                .unwrap_or_default();
            if self
                .refs
                .as_ref()
                .is_none_or(|(hash, r)| hash != h || *r != refs)
            {
                self.refs = Some((h.clone(), refs));
                cx.notify();
            }
        }
        if refresh {
            self.contains.clear();
        }
        match target {
            DetailsTarget::None => {
                self.want = None;
                self.hold = None;
                self.clear(cx);
            }
            DetailsTarget::One(hash) => {
                if self.shown.as_deref() == Some(hash.as_str()) {
                    self.want = None;
                    self.hold = None;
                    if refresh {
                        self.ask_branches(hash, cx);
                    }
                    return;
                }
                if let Some(d) = self.cache.get(&hash)
                    && self.contains.contains_key(&hash)
                {
                    self.want = None;
                    self.hold = None;
                    self.apply_one(d, cx);
                    return;
                }
                self.request(Want::One(hash.clone()), cx);
                if !self.contains.contains_key(&hash) {
                    self.ask_branches(hash, cx);
                }
            }
            DetailsTarget::Many(hashes) => {
                let key = many_key(hashes.iter().map(String::as_str));
                if self.shown.as_deref() == Some(key.as_str()) {
                    self.want = None;
                    self.hold = None;
                    return;
                }
                let subject = |h: &str| {
                    commits
                        .iter()
                        .find(|c| c.hash == h)
                        .map(|c| c.subject.clone())
                        .unwrap_or_default()
                };
                let list: Vec<(String, String)> =
                    hashes.iter().map(|h| (h.clone(), subject(h))).collect();
                if let Some(c) = self.combined.get(&key).cloned() {
                    self.want = None;
                    self.hold = None;
                    self.apply_many(key, list, c, cx);
                    return;
                }
                self.request(Want::Many(list), cx);
            }
        }
    }

    /// Caches belong to one repo.
    fn check_root(&mut self, cx: &mut Context<Self>) {
        let root = self.gcx.root();
        if root != self.root {
            self.root = root.clone();
            self.cache = DetailsCache::default();
            self.combined.clear();
            self.contains.clear();
            self.shown = None;
            if let Some(r) = root {
                self.tree.update(cx, |v, _| v.delegate.set_root(r));
            }
        }
    }

    /// The shown commit's refs (none while another commit's text shows).
    fn info_refs(&self) -> &[(gpui_kit::SharedString, crate::kit::RefKind)] {
        match (&self.info, &self.refs) {
            (Info::One { details, .. }, Some((h, r))) if *h == details.hash => r.as_slice(),
            _ => &[],
        }
    }

    /// The branch / tag labels under the metadata (tests).
    pub fn ref_labels(&self) -> Vec<String> {
        text::shown_refs(self.info_refs())
            .into_iter()
            .map(|(n, _)| n.to_string())
            .collect()
    }

    fn clear(&mut self, cx: &mut Context<Self>) {
        self.shown = None;
        self.info = Info::None;
        self.revs = None;
        self.set_files(Vec::new(), "", cx);
    }

    fn apply_one(&mut self, d: Arc<CommitDetails>, cx: &mut Context<Self>) {
        self.shown = Some(d.hash.clone());
        self.revs = Some(d.revs());
        let files = d.files.iter().map(change_file).collect();
        self.info = Info::One {
            branches: self.contains.get(&d.hash).cloned(),
            details: d,
        };
        self.set_files(files, "No changes", cx);
    }

    fn apply_many(
        &mut self,
        key: String,
        list: Vec<(String, String)>,
        c: Arc<CombinedChanges>,
        cx: &mut Context<Self>,
    ) {
        self.shown = Some(key);
        self.revs = Some((c.old_rev.clone(), c.new_rev.clone()));
        self.info = Info::Many(list);
        self.set_files(c.files.iter().map(change_file).collect(), "No changes", cx);
    }

    /// A new commit's files: every folder open, no selection, scrolled to the top.
    fn set_files(&mut self, files: Vec<ChangeFile>, empty: &str, cx: &mut Context<Self>) {
        let empty = empty.to_owned();
        self.file_count = files.len();
        self.tree.update(cx, |v, cx| {
            let ListView {
                delegate, state, ..
            } = v;
            delegate.set_empty_text(empty);
            delegate.set_all_open(true, state);
            let groups = if files.is_empty() {
                Vec::new()
            } else {
                vec![ChangeGroup::plain(files)]
            };
            delegate.set_groups(groups, state);
            // nothing selected until the files get the keyboard (WS: the toolbar's actions
            // stay disabled; `focus` puts the cursor on the first row)
            state.set_selection(None, []);
            state
                .scroll_handle()
                .scroll_to_item(0, gpui_kit::ScrollStrategy::Top);
            cx.notify();
        });
        cx.notify();
    }

    // ---- loading -----------------------------------------------------------------------------

    fn request(&mut self, want: Want, cx: &mut Context<Self>) {
        if self.want.as_ref() == Some(&want) {
            return;
        }
        self.hold = None;
        self.want = Some(want);
        self.run(cx);
    }

    /// Starts the wished load unless one runs (that one picks the newest wish up when done).
    fn run(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.hold.is_some() {
            return;
        }
        let (Some(want), Some(root)) = (self.want.clone(), self.root.clone()) else {
            return;
        };
        self.loading = true;
        let cache = self.cache.clone();
        let w = want.clone();
        let task = job::spawn(cx, move || match &w {
            Want::One(h) => cache.load_blocking(&root, h).map(Loaded::One),
            Want::Many(list) => {
                let hashes: Vec<&str> = list.iter().map(|(h, _)| h.as_str()).collect();
                cache
                    .combined_blocking(&root, &hashes)
                    .map(|c| Loaded::Many(Arc::new(c)))
            }
        });
        cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |p, cx| {
                p.loading = false;
                p.loaded(want, res, cx);
                p.run(cx);
            });
        })
        .detach();
    }

    fn loaded(&mut self, want: Want, res: anyhow::Result<Loaded>, cx: &mut Context<Self>) {
        let current = self.want.as_ref() == Some(&want);
        let loaded = match res {
            Ok(l) => l,
            Err(_) => {
                // a commit git can't show (gone after a rewrite): keep what's shown
                if current {
                    self.want = None;
                }
                return;
            }
        };
        if let Loaded::Many(c) = &loaded {
            if self.combined.len() > COMBINED_CACHE {
                self.combined.clear();
            }
            self.combined.insert(want.key(), c.clone());
        }
        if !current {
            return;
        }
        match (loaded, want) {
            (Loaded::One(d), Want::One(hash)) => {
                let asking = self.branches_running.as_deref() == Some(hash.as_str())
                    || self.want_branches.as_deref() == Some(hash.as_str());
                if asking && !self.contains.contains_key(&hash) {
                    // drawn together with the branches when they come soon
                    self.hold = Some(hash.clone());
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(BRANCHES_WAIT).await;
                        let _ = this.update(cx, |p, cx| p.release(&hash, cx));
                    })
                    .detach();
                    return;
                }
                self.want = None;
                self.apply_one(d, cx);
            }
            (Loaded::Many(c), Want::Many(list)) => {
                self.want = None;
                let key = many_key(list.iter().map(|(h, _)| h.as_str()));
                self.apply_many(key, list, c, cx);
            }
            _ => {}
        }
    }

    /// The held details of `hash` go on screen (their branches came, or waiting took too long).
    fn release(&mut self, hash: &str, cx: &mut Context<Self>) {
        if self.hold.as_deref() != Some(hash) {
            return;
        }
        self.hold = None;
        self.want = None;
        if let Some(d) = self.cache.get(hash) {
            self.apply_one(d, cx);
        }
        self.run(cx);
    }

    fn ask_branches(&mut self, hash: String, cx: &mut Context<Self>) {
        self.want_branches = Some(hash);
        self.run_branches(cx);
    }

    fn run_branches(&mut self, cx: &mut Context<Self>) {
        if self.branches_running.is_some() {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(hash) = self.want_branches.take() else {
            return;
        };
        self.branches_running = Some(hash.clone());
        let h = hash.clone();
        let task = job::spawn(cx, move || show::containing_branches_blocking(&root, &h));
        cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |p, cx| {
                p.branches_running = None;
                // no answer: shown without them (Lua: try(true))
                let branches = res.unwrap_or_default();
                p.contains.insert(hash.clone(), branches.clone());
                if p.hold.as_deref() == Some(hash.as_str()) {
                    p.release(&hash, cx);
                } else if p.shown.as_deref() == Some(hash.as_str())
                    && let Info::One { branches: b, .. } = &mut p.info
                    && b.as_ref() != Some(&branches)
                {
                    *b = Some(branches);
                    cx.notify();
                }
                p.run_branches(cx);
            });
        })
        .detach();
    }

    // ---- focus -------------------------------------------------------------------------------

    /// ä / Enter / Tab from the table: the files tree takes the keyboard.
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            if v.state.cursor().is_none()
                && v.delegate
                    .rows()
                    .first()
                    .is_some_and(|r| r.kind != RowKind::Empty)
            {
                v.state.set_cursor(Some(0));
                cx.notify();
            }
        });
        let handle = self.tree.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.tree
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
    }

    // ---- reading (tests, the Log) --------------------------------------------------------------

    /// The changed files tree.
    pub fn tree(&self) -> &Entity<ListView<ChangesTree>> {
        &self.tree
    }

    /// The details text, one string per line ("" = a blank line).
    pub fn text_lines(&self) -> Vec<String> {
        text::plain(&self.info)
    }

    /// A load or branches query is running / wished (tests wait for quiet).
    pub fn busy(&self) -> bool {
        self.loading
            || self.want.is_some()
            || self.hold.is_some()
            || self.branches_running.is_some()
            || self.want_branches.is_some()
    }

    // ---- actions -----------------------------------------------------------------------------

    /// The file under the tree's cursor.
    fn cursor_file(&self, cx: &App) -> Option<ChangeFile> {
        let v = self.tree.read(cx);
        let c = v.state.cursor()?;
        match &v.delegate.rows().get(c)?.kind {
            RowKind::File(fr) => Some(v.delegate.file(*fr).clone()),
            _ => None,
        }
    }

    /// The selected file rows' files (tree order).
    fn selected_files(&self, cx: &App) -> Vec<ChangeFile> {
        let v = self.tree.read(cx);
        let rows: Vec<usize> = v
            .state
            .selection()
            .into_iter()
            .filter(|&r| {
                matches!(
                    v.delegate.rows().get(r).map(|r| &r.kind),
                    Some(RowKind::File(_))
                )
            })
            .collect();
        v.delegate.files_of(&rows)
    }

    /// Enter / double-click / Show Diff: the first of `files` in the diff viewer, the others
    /// reachable with next / previous file (tree order), the keyboard stays here.
    fn open_diff(&mut self, files: &[ChangeFile], cx: &mut Context<Self>) {
        let (Some(first), Some((old, new))) = (files.first(), self.revs.clone()) else {
            return;
        };
        let ordered = self.tree.read(cx).delegate.ordered_files();
        let index = ordered
            .iter()
            .position(|f| f.path == first.path)
            .map_or(1, |i| i + 1);
        self.gcx.scx.navigate(
            LUA,
            "open_diff",
            vec![
                lua_files(&ordered),
                (index as i64).into(),
                old.into(),
                new.into(),
                false.into(),
            ],
        );
    }

    fn show_diff(&mut self, cx: &mut Context<Self>) {
        let files = self.selected_files(cx);
        self.open_diff(&files, cx);
    }

    /// F4: the cursor's file in the editor (Lua says when it doesn't exist anymore).
    fn jump_to_source(&mut self, cx: &mut Context<Self>) {
        if let Some(f) = self.cursor_file(cx) {
            self.gcx
                .scx
                .navigate(LUA, "jump_to_source", vec![f.path.into()]);
        }
    }

    fn file_history(&mut self, cx: &mut Context<Self>) {
        if let Some(f) = self.cursor_file(cx) {
            cx.emit(DetailsEvent::FileHistory(f.path));
        }
    }

    /// Copy Path (absolute) / Copy Relative Path of the selected rows, with a balloon.
    fn copy_paths(&mut self, relative: bool, window: &mut Window, cx: &mut Context<Self>) {
        let v = self.tree.read(cx);
        let mut paths = v.delegate.paths(&v.state.selection());
        if relative && let Some(root) = &self.root {
            let prefix = format!("{}/", root.to_string_lossy());
            for p in &mut paths {
                if let Some(rel) = p.strip_prefix(&prefix) {
                    *p = rel.to_owned();
                }
            }
        }
        crate::kit::copy_paths(paths, window, cx);
    }

    /// A click on the hash: the full hash to the clipboard (Lua `details.lua`: "Copied
    /// 1a2b3c4d").
    fn copy_hash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Info::One { details, .. } = &self.info else {
            return;
        };
        let hash = details.hash.clone();
        cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(hash.clone()));
        popups::notify(
            popups::Balloon::info("Git", show::copied_text(&hash)),
            window,
            cx,
        );
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

    fn toggle_group_by_dir(&mut self, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            let ListView {
                delegate, state, ..
            } = v;
            let on = !delegate.group_by_directory();
            delegate.set_group_by_directory(on, state);
            cx.notify();
        });
    }

    fn fold(&mut self, row: usize, open: bool, cx: &mut Context<Self>) {
        self.tree.update(cx, |v, cx| {
            let ListView {
                delegate, state, ..
            } = v;
            delegate.toggle(row, Some(open), state);
            cx.notify();
        });
    }

    // ---- menus -------------------------------------------------------------------------------

    /// Right-click / Cmd+Enter (Lua `git/init.lua`'s details menu): Show Diff, Jump to Source,
    /// Show History for File, Copy Path, fold items, Refresh, Hide.
    fn context_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let file = self.cursor_file(cx);
        let has_files = !self.selected_files(cx).is_empty();
        let (folder, any_rows) = {
            let v = self.tree.read(cx);
            let folder = v
                .state
                .cursor()
                .and_then(|c| v.delegate.rows().get(c).map(|r| (c, r)))
                .filter(|(_, r)| r.is_folder())
                .map(|(c, r)| (c, r.open));
            let any = v
                .delegate
                .rows()
                .first()
                .is_some_and(|r| r.kind != RowKind::Empty);
            (folder, any)
        };
        let mut b = MenuBuilder::default();
        b.item(
            MenuItem::new("Show Diff")
                .shortcut("⏎")
                .icon(IconName::Diff)
                .enabled(has_files),
            |p, _, cx| p.show_diff(cx),
        );
        b.item(
            MenuItem::new("Jump to Source")
                .shortcut("F4")
                .enabled(file.is_some()),
            |p, _, cx| p.jump_to_source(cx),
        );
        b.item(
            MenuItem::new("Show History for File")
                .icon(IconName::History)
                .enabled(file.is_some()),
            |p, _, cx| p.file_history(cx),
        );
        b.sep();
        b.item(
            MenuItem::new("Copy Path")
                .shortcut("⌘C")
                .icon(IconName::Copy)
                .enabled(any_rows),
            |p, w, cx| p.copy_paths(false, w, cx),
        );
        b.item(
            MenuItem::new("Copy Relative Path").enabled(any_rows),
            |p, w, cx| p.copy_paths(true, w, cx),
        );
        b.sep();
        if let Some((row, open)) = folder {
            if open {
                b.item(
                    MenuItem::new("Collapse").shortcut("←"),
                    move |p, _, cx| p.fold(row, false, cx),
                );
            } else {
                b.item(MenuItem::new("Expand").shortcut("→"), move |p, _, cx| {
                    p.fold(row, true, cx)
                });
            }
        }
        b.item(
            MenuItem::new("Expand All").icon(IconName::ExpandAll),
            |p, _, cx| p.set_all_open(true, cx),
        );
        b.item(
            MenuItem::new("Collapse All").icon(IconName::CollapseAll),
            |p, _, cx| p.set_all_open(false, cx),
        );
        b.sep();
        b.item(
            MenuItem::new("Refresh")
                .shortcut("R")
                .icon(IconName::Refresh),
            |p, _, _| p.refresh_repo(),
        );
        b.item(MenuItem::new("Hide").shortcut("⌘J"), |p, _, _| {
            p.gcx.scx.call("config.app.git", "hide", vec![])
        });
        b.open(anchor, window, cx);
    }

    /// The toolbar's eye (WS View Options): Group by Directory, Expand All, Collapse All.
    fn view_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let on = self.tree.read(cx).delegate.group_by_directory();
        let mut b = MenuBuilder::default();
        let mut group = MenuItem::new("Group by Directory");
        if on {
            group = group.icon(IconName::Checked);
        }
        b.item(group, |p, _, cx| p.toggle_group_by_dir(cx));
        b.sep();
        b.item(
            MenuItem::new("Expand All").icon(IconName::ExpandAll),
            |p, _, cx| p.set_all_open(true, cx),
        );
        b.item(
            MenuItem::new("Collapse All").icon(IconName::CollapseAll),
            |p, _, cx| p.set_all_open(false, cx),
        );
        let anchor = match self.eye_bounds.get() {
            Some(bounds) => Anchor::Below(bounds),
            None => Anchor::Point(window.mouse_position()),
        };
        b.open(anchor, window, cx);
    }

    /// R / Refresh: the repo-changed path (GitView reloads every tab; the Log asks this pane
    /// again with `refresh`).
    fn refresh_repo(&self) {
        self.gcx.scx.call("git.cli", "changed", vec![]);
    }

    /// Where a keyboard menu opens: below the tree's cursor row.
    fn cursor_anchor(&self, window: &Window, cx: &App) -> Anchor {
        let v = self.tree.read(cx);
        let (Some(b), Some(row)) = (
            self.tree_bounds.get(),
            v.state.cursor().and_then(|c| v.state.row_of(c)),
        ) else {
            return Anchor::Point(window.mouse_position());
        };
        let offset = v.state.scroll_handle().0.borrow().base_handle.offset().y;
        let y = b.top() + offset + px((row + 1) as f32 * look::TREE_ROW_HEIGHT);
        Anchor::Point(point(b.left() + px(look::TREE_INDENT * 2.), y))
    }

    // ---- events ------------------------------------------------------------------------------

    fn on_tree_event(
        &mut self,
        _: &Entity<ListView<ChangesTree>>,
        ev: &ChangesTreeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            ChangesTreeEvent::Open(files) => self.open_diff(files, cx),
            ChangesTreeEvent::ContextMenu(at) => self.context_menu(Anchor::Point(*at), window, cx),
            // Esc with nothing to clear: back to the editor (GitView's Esc)
            ChangesTreeEvent::Cancel => cx.emit(DetailsEvent::Leave),
            ChangesTreeEvent::Help => cx.emit(DetailsEvent::Help),
            // (no `dd` in a commit's files)
            ChangesTreeEvent::Delete => {}
            ChangesTreeEvent::SelectionChanged | ChangesTreeEvent::IncludedChanged => cx.notify(),
        }
    }

    /// k / ← with nowhere to go: no cursor, or a top-level row that isn't an open folder.
    fn at_left_edge(&self, cx: &App) -> bool {
        let v = self.tree.read(cx);
        let Some(c) = v.state.cursor() else {
            return true;
        };
        v.delegate
            .rows()
            .get(c)
            .is_none_or(|r| r.parent.is_none() && !(r.is_folder() && r.open))
    }

    /// Keys before the tree sees them: Tab / k-at-the-edge back to the table, F4, Cmd+Enter.
    fn on_key_capture(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_focused(window, cx) || self.tree.read(cx).state.searching() {
            return;
        }
        let Some(key) = notation(ev) else {
            return;
        };
        let handled = match key.as_str() {
            "<Tab>" | "<S-Tab>" => {
                cx.emit(DetailsEvent::Back);
                true
            }
            "k" | "<Left>" if self.at_left_edge(cx) => {
                cx.emit(DetailsEvent::Back);
                true
            }
            "<F4>" => {
                self.jump_to_source(cx);
                true
            }
            "<D-CR>" => {
                let anchor = self.cursor_anchor(window, cx);
                self.context_menu(anchor, window, cx);
                true
            }
            _ => false,
        };
        if handled {
            cx.stop_propagation();
        }
    }

    // ---- render ------------------------------------------------------------------------------

    fn render_toolbar(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let has_files = !self.selected_files(cx).is_empty();
        let file = self.cursor_file(cx).is_some();
        let n = self.shown.as_ref().map(|_| count(self.file_count));
        let me = cx.entity().downgrade();
        let diff = {
            let me = me.clone();
            IconButton::new("details-diff", IconName::Diff)
                .tooltip("Show Diff", Some("⏎"))
                .disabled(!has_files)
                .on_click(move |_, _, cx| {
                    let _ = me.update(cx, |p, cx| p.show_diff(cx));
                })
        };
        let view = {
            let me = me.clone();
            IconButton::new("details-view", IconName::Show)
                .tooltip("View Options", None)
                .dropdown(true)
                .on_click(move |_, window, cx| {
                    let _ = me.update(cx, |p, cx| p.view_menu(window, cx));
                })
        };
        let history = IconButton::new("details-history", IconName::History)
            .tooltip("Show History for File", None)
            .disabled(!file)
            .on_click(move |_, _, cx| {
                let _ = me.update(cx, |p, cx| p.file_history(cx));
            });
        div()
            .flex_none()
            .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
            .w_full()
            .flex()
            .items_center()
            .pl(px(look::ACTION_TOOLBAR_PAD_X + 2.))
            .pr(px(look::ACTION_TOOLBAR_PAD_X + 8.))
            .child(
                toolbar(Axis::Horizontal)
                    .child(diff)
                    .child(
                        div()
                            .relative()
                            .child(view)
                            .child(bounds_probe(self.eye_bounds.clone())),
                    )
                    .child(history),
            )
            .child(div().flex_1())
            .children(n.map(|n| {
                div()
                    .debug_selector(|| "details-count".into())
                    .flex_none()
                    .whitespace_nowrap()
                    .text_color(look::CHANGES_COUNT_FG)
                    .child(n)
            }))
            .into_any_element()
    }
}

/// Records where its parent was drawn.
fn bounds_probe(cell: Rc<Cell<Option<Bounds<Pixels>>>>) -> impl IntoElement {
    canvas(move |b, _, _| cell.set(Some(b)), |_, _, _, _| {})
        .absolute()
        .size_full()
}

type Act = Box<dyn FnOnce(&mut DetailsPane, &mut Window, &mut Context<DetailsPane>)>;

/// Menu entries + what each does.
#[derive(Default)]
struct MenuBuilder {
    entries: Vec<MenuEntry>,
    acts: Vec<Option<Act>>,
}

impl MenuBuilder {
    fn item(
        &mut self,
        it: MenuItem,
        act: impl FnOnce(&mut DetailsPane, &mut Window, &mut Context<DetailsPane>) + 'static,
    ) {
        self.entries.push(it.into());
        self.acts.push(Some(Box::new(act)));
    }

    fn sep(&mut self) {
        self.entries.push(MenuEntry::Separator);
        self.acts.push(None);
    }

    fn open(self, anchor: Anchor, window: &mut Window, cx: &mut Context<DetailsPane>) {
        let me = cx.entity().downgrade();
        let mut acts = self.acts;
        popups::open_menu(
            Menu::new(self.entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let Some(act) = choice
                    .and_then(|ix| acts.get_mut(ix))
                    .and_then(Option::take)
                else {
                    return;
                };
                let _ = me.update(cx, |p, cx| act(p, window, cx));
            },
        );
    }
}

fn change_file(f: &ChangedFile) -> ChangeFile {
    let status = ChangeStatus::from_letter(f.change.letter()).unwrap_or(ChangeStatus::Modified);
    let c = ChangeFile::new(f.path.clone(), status);
    match &f.old_path {
        Some(o) => c.renamed_from(o.clone()),
        None => c,
    }
}

/// The status letter of Lua `git/filetree.lua`'s `GitFile`.
fn letter(s: ChangeStatus) -> char {
    match s {
        ChangeStatus::Modified | ChangeStatus::TypeChanged => 'M',
        ChangeStatus::Added => 'A',
        ChangeStatus::Deleted => 'D',
        ChangeStatus::Renamed => 'R',
        ChangeStatus::Copied => 'C',
        ChangeStatus::Unversioned => '?',
        ChangeStatus::Ignored => '!',
        ChangeStatus::Conflict => 'U',
    }
}

/// Files as Lua `GitFile`s (`{ status, path, old_path }`).
fn lua_files(files: &[ChangeFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|f| {
                let mut m = vec![
                    (
                        Value::from("status"),
                        Value::from(letter(f.status).to_string()),
                    ),
                    (Value::from("path"), Value::from(f.path.as_str())),
                ];
                if let Some(o) = &f.old_path {
                    m.push((Value::from("old_path"), Value::from(o.as_str())));
                }
                Value::Map(m)
            })
            .collect(),
    )
}

impl Render for DetailsPane {
    fn render(&mut self, _w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let bar = self.render_toolbar(cx);
        let tree = div()
            .relative()
            .size_full()
            .child(self.tree.clone())
            .child(bounds_probe(self.tree_bounds.clone()));
        let me = cx.entity().downgrade();
        let body = text::render(&self.info, self.info_refs(), move |_, window, cx| {
            let _ = me.update(cx, |p, cx| p.copy_hash(window, cx));
        });
        // a click on the text: the keyboard to the files (the caret never leaves them, Lua)
        let text = div()
            .id("git-log-details-text")
            .debug_selector(|| "git-log-details-text".into())
            .size_full()
            .overflow_y_scroll()
            .line_height(px(look::VCS_DETAILS_LINE_HEIGHT))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|p, _: &MouseDownEvent, window, cx| p.focus(window, cx)),
            )
            .child(body);
        div()
            .id("git-log-details")
            .key_context("GitLogDetails")
            .size_full()
            .flex()
            .flex_col()
            .font(ui_font())
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .capture_key_down(cx.listener(Self::on_key_capture))
            // a click in the pane makes the Git host nvim's current window (GitView's own
            // mouse-down doesn't see presses the tree stops)
            .capture_any_mouse_down(cx.listener(|p, _: &MouseDownEvent, _, _| {
                p.gcx.scx.navigate("config.app.git", "enter", vec![]);
            }))
            .child(bar)
            .child(div().flex_1().min_h(px(0.)).child(split(
                "git-log-details-split",
                &self.split,
                tree,
                text,
                cx,
            )))
    }
}
