//! WebStorm's changes tree (ChangesTree / ChangesBrowser): the files of Local Changes and of
//! a commit (the Log's details pane), on [`ListView`]. Same model as Lua `git/filetree.lua`:
//!
//! - Optional group rows (changelists: "Changes 3 files", "Unversioned Files 1 file"), then
//!   folders first (single-child folder chains compacted: "src/services"), then files, each level
//!   sorted case-insensitively; "N files" in gray after groups and folders.
//! - File icons ([`icons::for_file`]), names in the WS file-status colors ([`ChangeStatus`]),
//!   renames with "← old name" in gray. Optional "group by directory" off: a flat list with the
//!   parent path in gray (WS Group By > Directory).
//! - Optional checkboxes ([`ChangesTree::with_checkboxes`]): tri-state on groups / folders,
//!   Space or a click on a box includes / leaves out the row's files (all selected rows' files).
//! - Keys (on top of the list's l / ö / arrows / L / Ö / pages / multi-select / `/` search):
//!   k / ← fold an open folder, else go to the parent; ä / → unfold, else go to the first child;
//!   Enter / double-click: a folder folds / unfolds, files emit [`ChangesTreeEvent::Open`];
//!   Cmd+C / `yy` copies the selected rows' paths (one per line, absolute when a root is set);
//!   with [`ChangesTree::with_delete_key`] `dd` emits [`ChangesTreeEvent::Delete`]; `g?` emits
//!   [`ChangesTreeEvent::Help`] (the list's Vim layer also gives counts and `gg` / `G`).
//! - Mouse: a chevron click folds without selecting, a checkbox click toggles without selecting,
//!   right-click emits [`ChangesTreeEvent::ContextMenu`].
//!
//! The view is `ListView<ChangesTree>`; subscribe to its [`ChangesTreeEvent`]s.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use gpui_kit::{
    AnyElement, ClipboardItem, Context, EventEmitter, FontWeight, InteractiveElement as _,
    IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Point, Rgba,
    SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use super::checkbox::{CheckState, checkbox_icon};
use super::icons::{self, Icon, IconName};
use super::list::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, SearchMode,
};
use super::{list, vim};
use crate::look;

/// A file's change, for its name color (WebStorm FileStatus).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    /// Copied (git `C`): shown like an added file.
    Copied,
    /// Type change (git `T`): shown like a modified file.
    TypeChanged,
    Unversioned,
    Ignored,
    /// Merge conflict (git `U`, `AA`, `DD`).
    Conflict,
}

impl ChangeStatus {
    /// From an Lua `filetree.lua` status letter (M A D R C T ? ! U).
    pub fn from_letter(c: char) -> Option<Self> {
        Some(match c {
            'M' => Self::Modified,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'T' => Self::TypeChanged,
            '?' => Self::Unversioned,
            '!' => Self::Ignored,
            'U' => Self::Conflict,
            _ => return None,
        })
    }

    /// The name color (Lua `filetree.lua` `status_hl` -> WebStorm FILESTATUS_* colors).
    pub fn color(self) -> Rgba {
        use crate::git::FileStatus as F;
        let file = match self {
            Self::Renamed => return look::GIT_RENAMED.rgba(),
            Self::Modified | Self::TypeChanged => F::Modified,
            Self::Added | Self::Copied => F::Added,
            Self::Deleted => F::Deleted,
            Self::Unversioned => F::Unversioned,
            Self::Ignored => F::Ignored,
            Self::Conflict => F::Conflict,
        };
        file.color()
    }
}

/// One changed file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeFile {
    /// Repo-relative, `/`-separated.
    pub path: String,
    /// The path before a rename / copy.
    pub old_path: Option<String>,
    pub status: ChangeStatus,
}

impl ChangeFile {
    pub fn new(path: impl Into<String>, status: ChangeStatus) -> Self {
        Self {
            path: path.into(),
            old_path: None,
            status,
        }
    }

    pub fn renamed_from(mut self, old: impl Into<String>) -> Self {
        self.old_path = Some(old.into());
        self
    }

    /// The file name (after the last `/`).
    pub fn name(&self) -> &str {
        basename(&self.path)
    }
}

/// A top-level group: a changelist ("Changes"), "Unversioned Files", "Merge Conflicts"; or no
/// header row ([`ChangeGroup::plain`]: a commit's files).
#[derive(Clone, Debug, PartialEq)]
pub struct ChangeGroup {
    /// Fold-state key (stable across refreshes).
    pub key: SharedString,
    /// None: no header row, the files are at the top level.
    pub title: Option<SharedString>,
    /// Title color (None: the text color).
    pub color: Option<Rgba>,
    /// Bold title (WS: the default changelist).
    pub bold: bool,
    pub files: Vec<ChangeFile>,
}

impl ChangeGroup {
    /// Files without a group row (a commit's changes).
    pub fn plain(files: Vec<ChangeFile>) -> Self {
        Self {
            key: "files".into(),
            title: None,
            color: None,
            bold: false,
            files,
        }
    }

    /// A changelist row ("Changes"): WS draws the default changelist bold.
    pub fn changelist(
        key: &'static str,
        title: impl Into<SharedString>,
        files: Vec<ChangeFile>,
    ) -> Self {
        Self {
            key: key.into(),
            title: Some(title.into()),
            color: None,
            bold: true,
            files,
        }
    }

    /// "Unversioned Files" (WS ChangesBrowserUnversionedFilesNode: FileStatus.UNKNOWN's color).
    pub fn unversioned(files: Vec<ChangeFile>) -> Self {
        Self {
            key: "unversioned".into(),
            title: Some("Unversioned Files".into()),
            color: Some(look::GIT_UNTRACKED.rgba()),
            bold: false,
            files,
        }
    }

    /// "Merge Conflicts" (WS ChangesBrowserConflictsNode: the conflict color).
    pub fn conflicts(files: Vec<ChangeFile>) -> Self {
        Self {
            key: "conflicts".into(),
            title: Some("Merge Conflicts".into()),
            color: Some(look::GIT_CONFLICT.rgba()),
            bold: false,
            files,
        }
    }
}

/// Lua `filetree.lua` `count`: "1 file", "3 files".
pub fn count(n: usize) -> String {
    super::text::plural(n, "file")
}

/// Copies `paths` (one per line) with a "Copied <path>" / "Copied N paths" balloon (M4 Lua
/// filetree's). False: nothing to copy.
pub fn copy_paths(paths: Vec<String>, window: &mut Window, cx: &mut gpui_kit::App) -> bool {
    let msg = match paths.as_slice() {
        [] => return false,
        [one] => format!("Copied {one}"),
        more => format!("Copied {} paths", more.len()),
    };
    cx.write_to_clipboard(ClipboardItem::new_string(paths.join("\n")));
    crate::popups::notify(crate::popups::Balloon::info("Git", msg), window, cx);
    true
}

/// A file in the tree: (group, index in the group's files).
pub type FileRef = (usize, usize);

/// What a row shows.
#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Group(usize),
    /// A folder; `name` is the compacted chain ("src/services"), `path` the full repo path.
    Dir {
        name: String,
        path: String,
    },
    File(FileRef),
    /// The empty tree's text ("No local changes"): not selectable.
    Empty,
}

/// One visible row.
#[derive(Clone, Debug, PartialEq)]
pub struct TreeRow {
    pub kind: RowKind,
    pub depth: usize,
    /// Row index of the parent group / folder.
    pub parent: Option<usize>,
    /// Fold key (groups / folders).
    key: Option<String>,
    pub open: bool,
    /// Every file below (a file row: itself).
    pub files: Vec<FileRef>,
}

impl TreeRow {
    pub fn is_folder(&self) -> bool {
        self.key.is_some()
    }

    /// Identity across rebuilds (keeps the selection on the same node).
    fn identity(&self, groups: &[ChangeGroup]) -> String {
        match &self.kind {
            RowKind::Group(g) => format!("g:{}", groups[*g].key),
            RowKind::Dir { path, .. } => format!("d:{}", self.key.as_deref().unwrap_or(path)),
            RowKind::File((g, f)) => format!("f:{}:{}", groups[*g].key, groups[*g].files[*f].path),
            RowKind::Empty => "empty".into(),
        }
    }
}

/// What the tree tells its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum ChangesTreeEvent {
    /// Enter / double-click on file rows: the selected files (a folder only folds).
    Open(Vec<ChangeFile>),
    /// The cursor / selection moved.
    SelectionChanged,
    /// Checkboxes changed (Space / click): read [`ChangesTree::included`].
    IncludedChanged,
    /// Right-click (window coordinates), after the row got selected.
    ContextMenu(Point<Pixels>),
    /// Esc with nothing left to clear.
    Cancel,
    /// `dd` ([`ChangesTree::with_delete_key`]): the owner's delete (Local Changes: rollback).
    Delete,
    /// `g?`: the owner's key help.
    Help,
}

impl EventEmitter<ChangesTreeEvent> for ListView<ChangesTree> {}

/// The tree's data, fold state and checkboxes; the delegate of `ListView<ChangesTree>`.
pub struct ChangesTree {
    groups: Vec<ChangeGroup>,
    rows: Vec<TreeRow>,
    /// The rows' identities (kept from the last build: the data may have changed since).
    ids: Vec<String>,
    /// Fold key -> open; missing = `default_open`.
    folds: HashMap<String, bool>,
    default_open: bool,
    /// Some: checkboxes shown; paths included.
    included: Option<HashSet<String>>,
    group_by_dir: bool,
    /// Absolute paths for Cmd+C (repo root).
    root: Option<PathBuf>,
    empty_text: SharedString,
    /// The Vim layer's doubled keys: `yy`, and `dd` with [`Self::with_delete_key`].
    vim_doubles: &'static str,
}

impl Default for ChangesTree {
    fn default() -> Self {
        Self::new()
    }
}

impl ChangesTree {
    pub fn new() -> Self {
        Self {
            groups: Vec::new(),
            rows: Vec::new(),
            ids: Vec::new(),
            folds: HashMap::new(),
            default_open: true,
            included: None,
            group_by_dir: true,
            root: None,
            empty_text: "No changes".into(),
            vim_doubles: "y",
        }
    }

    /// `dd` emits [`ChangesTreeEvent::Delete`] (Local Changes' rollback).
    pub fn with_delete_key(mut self) -> Self {
        self.vim_doubles = "yd";
        self
    }

    /// Shows checkboxes (Local Changes).
    pub fn with_checkboxes(mut self) -> Self {
        self.included = Some(HashSet::new());
        self
    }

    /// Repo root: Cmd+C copies absolute paths.
    pub fn with_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.root = Some(root.into());
        self
    }

    /// Sets the repo root later (the owner learns it after creating the tree).
    pub fn set_root(&mut self, root: impl Into<PathBuf>) {
        self.root = Some(root.into());
    }

    /// Text of the empty tree ("No local changes").
    pub fn with_empty_text(mut self, text: impl Into<SharedString>) -> Self {
        self.empty_text = text.into();
        self
    }

    /// Changes the empty tree's text later (the Log's details: no commit vs a commit without
    /// changes).
    pub fn set_empty_text(&mut self, text: impl Into<SharedString>) {
        self.empty_text = text.into();
    }

    pub fn groups(&self) -> &[ChangeGroup] {
        &self.groups
    }

    pub fn rows(&self) -> &[TreeRow] {
        &self.rows
    }

    pub fn file(&self, (g, f): FileRef) -> &ChangeFile {
        &self.groups[g].files[f]
    }

    /// Files of rows (deduplicated, tree order).
    pub fn files_of(&self, rows: &[usize]) -> Vec<ChangeFile> {
        let mut seen = HashSet::new();
        rows.iter()
            .filter_map(|&r| self.rows.get(r))
            .flat_map(|r| r.files.iter().copied())
            .filter(|fr| seen.insert(*fr))
            .map(|fr| self.file(fr).clone())
            .collect()
    }

    /// Every file in tree order, folded or not (next / previous file in a diff).
    pub fn ordered_files(&self) -> Vec<ChangeFile> {
        let mut out = Vec::new();
        for g in &self.groups {
            let root = build(&g.files);
            ordered(&root, &g.files, &mut out);
        }
        out
    }

    /// Checkboxes shown and the included paths (None: no checkboxes).
    pub fn included(&self) -> Option<&HashSet<String>> {
        self.included.as_ref()
    }

    /// The included files (tree order).
    pub fn included_files(&self) -> Vec<ChangeFile> {
        let Some(inc) = &self.included else {
            return Vec::new();
        };
        self.groups
            .iter()
            .flat_map(|g| g.files.iter())
            .filter(|f| inc.contains(&f.path))
            .cloned()
            .collect()
    }

    /// Checkbox state of a row's files.
    pub fn check_state(&self, row: usize) -> CheckState {
        let Some(inc) = &self.included else {
            return CheckState::Unchecked;
        };
        let files = &self.rows[row].files;
        let n = files
            .iter()
            .filter(|&&fr| inc.contains(&self.file(fr).path))
            .count();
        if n == 0 {
            CheckState::Unchecked
        } else if n == files.len() {
            CheckState::Checked
        } else {
            CheckState::Mixed
        }
    }

    /// Includes all of `files` unless they all are, then leaves them all out (Lua `changes.lua`
    /// `toggle_included`). False when there are no checkboxes / files.
    pub fn toggle_included(&mut self, files: &[FileRef]) -> bool {
        let paths: Vec<String> = files.iter().map(|&fr| self.file(fr).path.clone()).collect();
        let Some(inc) = &mut self.included else {
            return false;
        };
        if paths.is_empty() {
            return false;
        }
        let on = !paths.iter().all(|p| inc.contains(p));
        for p in paths {
            if on {
                inc.insert(p);
            } else {
                inc.remove(&p);
            }
        }
        true
    }

    /// Sets the included paths (paths not in the tree are dropped).
    pub fn set_included(&mut self, paths: impl IntoIterator<Item = String>) {
        if self.included.is_some() {
            let present: HashSet<&str> = self
                .groups
                .iter()
                .flat_map(|g| g.files.iter().map(|f| f.path.as_str()))
                .collect();
            self.included = Some(
                paths
                    .into_iter()
                    .filter(|p| present.contains(p.as_str()))
                    .collect(),
            );
        }
    }

    pub fn group_by_directory(&self) -> bool {
        self.group_by_dir
    }

    /// New data; folds, included paths (still present) and the selection (same nodes) are kept.
    pub fn set_groups(&mut self, groups: Vec<ChangeGroup>, state: &mut ListState) {
        self.groups = groups;
        if let Some(inc) = &mut self.included {
            let present: HashSet<&str> = self
                .groups
                .iter()
                .flat_map(|g| g.files.iter().map(|f| f.path.as_str()))
                .collect();
            inc.retain(|p| present.contains(p.as_str()));
        }
        self.rebuild(state);
    }

    /// WS Group By > Directory (on: folders; off: a flat list with gray parent paths).
    pub fn set_group_by_directory(&mut self, on: bool, state: &mut ListState) {
        self.group_by_dir = on;
        self.rebuild(state);
    }

    /// Folds / unfolds a group or folder row (`open` None toggles); false for other rows.
    pub fn toggle(&mut self, row: usize, open: Option<bool>, state: &mut ListState) -> bool {
        let Some(r) = self.rows.get(row) else {
            return false;
        };
        let Some(key) = r.key.clone() else {
            return false;
        };
        let open = open.unwrap_or(!r.open);
        self.folds.insert(key, open);
        self.rebuild(state);
        true
    }

    /// Expand All / Collapse All.
    pub fn set_all_open(&mut self, open: bool, state: &mut ListState) {
        self.folds.clear();
        self.default_open = open;
        self.rebuild(state);
    }

    fn is_open(&self, key: &str) -> bool {
        self.folds.get(key).copied().unwrap_or(self.default_open)
    }

    /// Recomputes the rows, keeping the cursor / multi-selection on the same nodes (a folded
    /// node's hidden selection moves to the fold).
    pub fn rebuild(&mut self, state: &mut ListState) {
        let old_ids = std::mem::take(&mut self.ids);
        let cursor_id = state.cursor().and_then(|c| old_ids.get(c).cloned());
        let sel_ids: Vec<String> = if state.has_multi_selection() {
            state
                .selection()
                .into_iter()
                .filter_map(|i| old_ids.get(i).cloned())
                .collect()
        } else {
            Vec::new()
        };
        self.rows = self.flatten();
        state.refresh(self);
        self.ids = self.rows.iter().map(|r| r.identity(&self.groups)).collect();
        let ids = &self.ids;
        let find = |id: &String| ids.iter().position(|x| x == id);
        let cursor = cursor_id.as_ref().and_then(find).or_else(|| {
            // the cursor's node got folded away / removed: its nearest still-shown ancestor
            let id = cursor_id.as_ref()?;
            ids.iter()
                .enumerate()
                .filter(|(_, x)| is_ancestor_id(x, id))
                .map(|(i, _)| i)
                .next_back()
        });
        let cursor = cursor.or_else(|| {
            state
                .cursor()
                .map(|c| c.min(self.rows.len().saturating_sub(1)))
                .filter(|&c| self.selectable(c))
        });
        let sel: Vec<usize> = sel_ids.iter().filter_map(find).collect();
        state.set_selection(cursor, sel);
    }

    fn flatten(&self) -> Vec<TreeRow> {
        let mut rows = Vec::new();
        for (gi, g) in self.groups.iter().enumerate() {
            if g.files.is_empty() && g.title.is_some() {
                continue;
            }
            let all: Vec<FileRef> = (0..g.files.len()).map(|f| (gi, f)).collect();
            let (depth, parent) = match &g.title {
                Some(_) => {
                    let key = format!("g:{}", g.key);
                    let open = self.is_open(&key);
                    rows.push(TreeRow {
                        kind: RowKind::Group(gi),
                        depth: 0,
                        parent: None,
                        key: Some(key),
                        open,
                        files: all.clone(),
                    });
                    if !open {
                        continue;
                    }
                    (1, Some(rows.len() - 1))
                }
                None => (0, None),
            };
            if self.group_by_dir {
                let root = build(&g.files);
                self.push_children(&root, gi, depth, parent, &mut rows);
            } else {
                let mut files = all;
                files.sort_by(|&a, &b| file_order(&g.files[a.1], &g.files[b.1]));
                for fr in files {
                    rows.push(TreeRow {
                        kind: RowKind::File(fr),
                        depth,
                        parent,
                        key: None,
                        open: false,
                        files: vec![fr],
                    });
                }
            }
        }
        if rows.is_empty() {
            rows.push(TreeRow {
                kind: RowKind::Empty,
                depth: 0,
                parent: None,
                key: None,
                open: false,
                files: Vec::new(),
            });
        }
        rows
    }

    fn push_children(
        &self,
        node: &DirNode,
        gi: usize,
        depth: usize,
        parent: Option<usize>,
        rows: &mut Vec<TreeRow>,
    ) {
        let gkey = &self.groups[gi].key;
        for d in &node.dirs {
            let key = format!("{gkey}:{}", d.path);
            let open = self.is_open(&key);
            rows.push(TreeRow {
                kind: RowKind::Dir {
                    name: d.name.clone(),
                    path: d.path.clone(),
                },
                depth,
                parent,
                key: Some(key),
                open,
                files: d.all.iter().map(|&f| (gi, f)).collect(),
            });
            if open {
                let me = rows.len() - 1;
                self.push_children(d, gi, depth + 1, Some(me), rows);
            }
        }
        for &f in &node.files {
            rows.push(TreeRow {
                kind: RowKind::File((gi, f)),
                depth,
                parent,
                key: None,
                open: false,
                files: vec![(gi, f)],
            });
        }
    }

    /// Paths of rows for Cmd+C (Lua `filetree.lua` `paths`): a file's, a folder's; a group gives
    /// its files. Absolute when the root is known.
    pub fn paths(&self, rows: &[usize]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut add = |p: &str| {
            let p = match &self.root {
                Some(root) => root.join(p).to_string_lossy().into_owned(),
                None => p.to_string(),
            };
            if !out.contains(&p) {
                out.push(p);
            }
        };
        for &r in rows {
            let Some(row) = self.rows.get(r) else {
                continue;
            };
            match &row.kind {
                RowKind::File(fr) => add(&self.file(*fr).path),
                RowKind::Dir { path, .. } => add(path),
                RowKind::Group(_) => {
                    for &fr in &row.files {
                        add(&self.file(fr).path);
                    }
                }
                RowKind::Empty => {}
            }
        }
        out
    }

    /// k / ←: fold an open folder, else the parent; false when there's nowhere to go.
    pub fn left(&mut self, state: &mut ListState) -> bool {
        let Some(c) = state.cursor() else {
            return false;
        };
        let row = &self.rows[c];
        if row.is_folder() && row.open {
            return self.toggle(c, Some(false), state);
        }
        match row.parent {
            Some(p) => {
                state.set_cursor(Some(p));
                true
            }
            None => false,
        }
    }

    /// ä / →: unfold a folded folder, else step to its first child.
    pub fn right(&mut self, state: &mut ListState) -> bool {
        let Some(c) = state.cursor() else {
            return false;
        };
        let row = &self.rows[c];
        if !row.is_folder() {
            return false;
        }
        if !row.open {
            return self.toggle(c, Some(true), state);
        }
        if self.rows.get(c + 1).is_some_and(|r| r.parent == Some(c)) {
            state.set_cursor(Some(c + 1));
        }
        true
    }

    /// Space: toggles the selected rows' files.
    fn toggle_selection(&mut self, state: &ListState) -> bool {
        let mut seen = HashSet::new();
        let files: Vec<FileRef> = state
            .selection()
            .into_iter()
            .filter_map(|r| self.rows.get(r))
            .flat_map(|r| r.files.iter().copied())
            .filter(|fr| seen.insert(*fr))
            .collect();
        self.toggle_included(&files)
    }

    /// Enter / double-click.
    fn activate(&mut self, ix: usize, state: &mut ListState, cx: &mut Context<ListView<Self>>) {
        if self.rows.get(ix).is_some_and(TreeRow::is_folder) {
            self.toggle(ix, None, state);
            return;
        }
        let rows: Vec<usize> = state
            .selection()
            .into_iter()
            .filter(|&r| matches!(self.rows.get(r).map(|r| &r.kind), Some(RowKind::File(_))))
            .collect();
        let files = self.files_of(&rows);
        if !files.is_empty() {
            cx.emit(ChangesTreeEvent::Open(files));
        }
    }

    /// The color row `ix`'s name is drawn in (tests: git status colors).
    pub fn label_color(&self, ix: usize) -> Option<Rgba> {
        self.rows.get(ix).map(|r| self.label_parts(r).1)
    }

    /// A row's name, its color, bold, the grayed text after it.
    fn label_parts(&self, row: &TreeRow) -> (SharedString, Rgba, bool, Option<String>) {
        match &row.kind {
            RowKind::Group(g) => {
                let g = &self.groups[*g];
                (
                    g.title.clone().unwrap_or_default(),
                    g.color.unwrap_or(look::TEXT.rgba()),
                    g.bold,
                    Some(count(row.files.len())),
                )
            }
            RowKind::Dir { name, .. } => (
                name.clone().into(),
                look::TEXT.rgba(),
                false,
                Some(count(row.files.len())),
            ),
            RowKind::File(fr) => {
                let f = self.file(*fr);
                let gray = match (&f.old_path, self.group_by_dir) {
                    (Some(old), _) => {
                        let same_dir = parent_dir(old) == parent_dir(&f.path);
                        Some(format!("← {}", if same_dir { basename(old) } else { old }))
                    }
                    (None, false) => {
                        Some(parent_dir(&f.path).to_string()).filter(|d| !d.is_empty())
                    }
                    (None, true) => None,
                };
                (f.name().to_string().into(), f.status.color(), false, gray)
            }
            RowKind::Empty => (self.empty_text.clone(), look::TEXT_DIM.rgba(), false, None),
        }
    }

    fn label(&self, row: &TreeRow, matches: &[u32]) -> AnyElement {
        let (name, color, bold, gray) = self.label_parts(row);
        div()
            .flex()
            .items_center()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .child(
                div()
                    .flex_none()
                    .text_color(color)
                    // REGULAR_BOLD_ATTRIBUTES (the default changelist "Changes")
                    .when(bold, |d| d.font_weight(FontWeight::BOLD))
                    .child(list::match_text(name, matches)),
            )
            .children(gray.map(|g| {
                div()
                    .flex_none()
                    .pl(px(look::CHANGES_COUNT_GAP))
                    .text_color(look::CHANGES_COUNT_FG)
                    .child(g)
            }))
            .into_any_element()
    }
}

impl ListSource for ChangesTree {
    fn len(&self) -> usize {
        self.rows.len()
    }

    /// Speed search matches the shown name.
    fn text(&self, ix: usize) -> SharedString {
        match &self.rows[ix].kind {
            RowKind::Group(g) => self.groups[*g].title.clone().unwrap_or_default(),
            RowKind::Dir { name, .. } => name.clone().into(),
            RowKind::File(fr) => self.file(*fr).name().to_string().into(),
            RowKind::Empty => SharedString::default(),
        }
    }

    fn selectable(&self, ix: usize) -> bool {
        !matches!(self.rows[ix].kind, RowKind::Empty)
    }
}

impl ListDelegate for ChangesTree {
    fn options(&self) -> ListOptions {
        ListOptions {
            search: SearchMode::Highlight,
            drag_select: true,
            vim: Some(self.vim_doubles),
            ..ListOptions::tree()
        }
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let r = self.rows[ix].clone();
        if r.kind == RowKind::Empty {
            return div()
                .pl(px(look::TREE_PAD_X + look::TREE_CHEVRON_TO_RENDERER))
                .child(self.label(&r, &[]))
                .into_any_element();
        }
        let chevron = r.is_folder().then_some(if r.open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        });
        let icon = match &r.kind {
            RowKind::Group(_) => None,
            RowKind::Dir { .. } => Some(IconName::Folder),
            RowKind::File(fr) => Some(icons::for_file(self.file(*fr).name())),
            RowKind::Empty => None,
        };
        let check = self.included.is_some().then(|| self.check_state(ix));
        let label = self.label(&r, row.matches);
        div()
            .flex()
            .items_center()
            .w_full()
            .min_w_0()
            // chevron at the tree's padding + one indent per level (WS ClassicPainter)
            .child(div().flex_none().w(px(chevron_x(r.depth))))
            .child(
                div()
                    .id(("changes-chevron", ix))
                    .debug_selector(move || format!("changes-chevron-{ix}"))
                    .flex_none()
                    .size(px(look::TREE_CHEVRON_SIZE))
                    .when_some(chevron, |d, c| {
                        d.child(Icon::new(c)).on_mouse_down(
                            MouseButton::Left,
                            cx.listener(
                                move |v: &mut ListView<Self>, _: &MouseDownEvent, window, cx| {
                                    let before = v.state.selection();
                                    v.delegate.toggle(ix, None, &mut v.state);
                                    if v.state.selection() != before {
                                        v.delegate.selection_changed(&v.state, window, cx);
                                    }
                                    cx.stop_propagation();
                                    cx.notify();
                                },
                            ),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(look::TREE_CHEVRON_TO_RENDERER - look::TREE_CHEVRON_SIZE)),
            )
            // ChangesTreeCellRenderer: the checkbox's whole 24 px icon WEST of the label
            .when_some(check, |d, state| {
                d.child(
                    div()
                        .id(("changes-check", ix))
                        .debug_selector(move || format!("changes-check-{ix}"))
                        .flex_none()
                        .size(px(look::CHECKBOX_TREE_WIDTH))
                        .child(
                            Icon::new(checkbox_icon(state, false)).size(px(look::CHECKBOX_CANVAS)),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(
                                move |v: &mut ListView<Self>, _: &MouseDownEvent, _, cx| {
                                    let files = v.delegate.rows[ix].files.clone();
                                    if v.delegate.toggle_included(&files) {
                                        cx.emit(ChangesTreeEvent::IncludedChanged);
                                    }
                                    cx.stop_propagation();
                                    cx.notify();
                                },
                            ),
                        ),
                )
            })
            .child(div().flex_none().w(px(look::TREE_RENDERER_PAD_X)))
            .when_some(icon, |d, icon| {
                d.child(
                    div()
                        .flex_none()
                        .debug_selector(move || format!("changes-icon-{ix}"))
                        .child(Icon::new(icon)),
                )
                .child(div().flex_none().w(px(look::TREE_ICON_GAP)))
            })
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .overflow_hidden()
                    .debug_selector(move || format!("changes-label-{ix}"))
                    .child(label),
            )
            .into_any_element()
    }

    fn on_key(
        &mut self,
        key: &str,
        state: &mut ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> bool {
        if state.searching() && !matches!(key, "<Left>" | "<Right>" | "<CR>") {
            return false;
        }
        match key {
            "<CR>" => {
                if let Some(c) = state.cursor() {
                    self.activate(c, state, cx);
                }
                true
            }
            "k" | "<Left>" => {
                self.left(state);
                true
            }
            "ä" | "<Right>" => {
                self.right(state);
                true
            }
            "<Space>" if self.included.is_some() => {
                if self.toggle_selection(state) {
                    cx.emit(ChangesTreeEvent::IncludedChanged);
                }
                true
            }
            "<D-c>" => {
                copy_paths(self.paths(&state.selection()), window, cx);
                true
            }
            _ => false,
        }
    }

    /// Double-click (Enter is [`Self::on_key`]'s).
    fn confirm(
        &mut self,
        ix: usize,
        _: &ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        // the view's state is borrowed by the caller: fold through the entity next
        let view = cx.entity().downgrade();
        cx.defer(move |cx| {
            let _ = view.update(cx, |v, cx| {
                let ListView {
                    delegate, state, ..
                } = v;
                delegate.activate(ix, state, cx);
                cx.notify();
            });
        });
    }

    fn cancel(&mut self, _: &mut Window, cx: &mut Context<ListView<Self>>) {
        cx.emit(ChangesTreeEvent::Cancel);
    }

    fn vim_cmd(
        &mut self,
        cmd: vim::Cmd,
        state: &mut ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        match cmd {
            // yy: Cmd+C's copy
            vim::Cmd::Yank => {
                copy_paths(self.paths(&state.selection()), window, cx);
            }
            vim::Cmd::Delete => cx.emit(ChangesTreeEvent::Delete),
            vim::Cmd::Help => cx.emit(ChangesTreeEvent::Help),
            vim::Cmd::Rename => {}
        }
    }

    fn selection_changed(
        &mut self,
        _: &ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        cx.emit(ChangesTreeEvent::SelectionChanged);
    }

    fn secondary_click(
        &mut self,
        _: usize,
        position: Point<Pixels>,
        _: &ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        cx.emit(ChangesTreeEvent::ContextMenu(position));
    }
}

/// Chevron x of a row at `depth` (from the list's left edge).
pub fn chevron_x(depth: usize) -> f32 {
    look::TREE_PAD_X + depth as f32 * look::TREE_INDENT
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent_dir(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// `d:g:src/a` is an ancestor id of `f:g:src/a/x.ts` / `d:g:src/a/b`; `g:g` of everything in g.
fn is_ancestor_id(anc: &str, id: &str) -> bool {
    let body = |s: &str| {
        s.split_once(':')
            .map_or(String::new(), |(_, b)| b.to_string())
    };
    let (a, i) = (body(anc), body(id));
    if let Some(g) = anc.strip_prefix("g:") {
        return i.starts_with(&format!("{g}:"));
    }
    anc.starts_with("d:") && i.starts_with(&format!("{a}/"))
}

/// Folder node of Lua `filetree.lua` `build`: folders first, compacted chains, sorted.
#[derive(Debug, Default)]
struct DirNode {
    name: String,
    path: String,
    dirs: Vec<DirNode>,
    /// File indices directly inside.
    files: Vec<usize>,
    /// Every file below.
    all: Vec<usize>,
}

fn file_order(a: &ChangeFile, b: &ChangeFile) -> std::cmp::Ordering {
    a.name()
        .to_lowercase()
        .cmp(&b.name().to_lowercase())
        .then_with(|| a.path.cmp(&b.path))
}

fn build(files: &[ChangeFile]) -> DirNode {
    let mut root = DirNode::default();
    for (i, f) in files.iter().enumerate() {
        root.all.push(i);
        let parts: Vec<&str> = f.path.split('/').collect();
        let mut node = &mut root;
        for (depth, part) in parts[..parts.len() - 1].iter().enumerate() {
            let pos = match node.dirs.iter().position(|d| d.name == *part) {
                Some(p) => p,
                None => {
                    node.dirs.push(DirNode {
                        name: part.to_string(),
                        path: parts[..=depth].join("/"),
                        ..Default::default()
                    });
                    node.dirs.len() - 1
                }
            };
            node = &mut node.dirs[pos];
            node.all.push(i);
        }
        node.files.push(i);
    }
    finish(&mut root, files);
    root
}

fn finish(node: &mut DirNode, files: &[ChangeFile]) {
    for d in &mut node.dirs {
        // a folder whose only content is one folder merges with it
        while d.dirs.len() == 1 && d.files.is_empty() {
            let mut c = d.dirs.pop().expect("one child");
            c.name = format!("{}/{}", d.name, c.name);
            *d = c;
        }
        finish(d, files);
    }
    node.dirs.sort_by_key(|d| d.name.to_lowercase());
    node.files
        .sort_by(|&a, &b| file_order(&files[a], &files[b]));
}

fn ordered(node: &DirNode, files: &[ChangeFile], out: &mut Vec<ChangeFile>) {
    for d in &node.dirs {
        ordered(d, files, out);
    }
    out.extend(node.files.iter().map(|&i| files[i].clone()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use ChangeStatus::*;

    fn f(path: &str, s: ChangeStatus) -> ChangeFile {
        ChangeFile::new(path, s)
    }

    fn labels(t: &ChangesTree) -> Vec<String> {
        t.rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let pad = "  ".repeat(r.depth);
                let mark = if r.is_folder() {
                    if r.open { "v " } else { "> " }
                } else {
                    ""
                };
                let check = match t.included.is_some() && r.kind != RowKind::Empty {
                    true => match t.check_state(i) {
                        CheckState::Checked => "[x] ",
                        CheckState::Mixed => "[-] ",
                        CheckState::Unchecked => "[ ] ",
                    },
                    false => "",
                };
                format!("{pad}{mark}{check}{}", t.text(i))
            })
            .collect()
    }

    fn tree(groups: Vec<ChangeGroup>) -> (ChangesTree, ListState) {
        let mut t = ChangesTree::new();
        let mut s = ListState::new();
        t.set_groups(groups, &mut s);
        (t, s)
    }

    fn sample() -> Vec<ChangeGroup> {
        vec![
            ChangeGroup::changelist(
                "changes",
                "Changes",
                vec![
                    f("src/services/api/client.ts", Modified),
                    f("src/services/api/Auth.ts", Added),
                    f("README.md", Modified),
                    f("src/app.ts", Deleted),
                    f("apps/web/src/main.tsx", Modified),
                ],
            ),
            ChangeGroup::unversioned(vec![f("notes.txt", Unversioned)]),
        ]
    }

    #[test]
    fn folders_first_compacted_sorted() {
        let (t, _) = tree(sample());
        assert_eq!(
            labels(&t),
            [
                "v Changes",
                "  v apps/web/src",
                "    main.tsx",
                "  v src",
                "    v services/api",
                "      Auth.ts",
                "      client.ts",
                "    app.ts",
                "  README.md",
                "v Unversioned Files",
                "  notes.txt",
            ]
        );
        // counts: every file below
        assert_eq!(t.rows[0].files.len(), 5);
        assert_eq!(t.rows[3].files.len(), 3);
        assert_eq!(count(1), "1 file");
        assert_eq!(count(3), "3 files");
        // tree order of all files
        let order: Vec<_> = t.ordered_files().into_iter().map(|f| f.path).collect();
        assert_eq!(
            order,
            [
                "apps/web/src/main.tsx",
                "src/services/api/Auth.ts",
                "src/services/api/client.ts",
                "src/app.ts",
                "README.md",
                "notes.txt"
            ]
        );
    }

    #[test]
    fn plain_group_has_no_header_and_flat_mode_shows_dirs() {
        let (mut t, mut s) = tree(vec![ChangeGroup::plain(vec![
            f("b/x.ts", Modified),
            f("a.ts", Added),
        ])]);
        assert_eq!(labels(&t), ["v b", "  x.ts", "a.ts"]);
        t.set_group_by_directory(false, &mut s);
        assert_eq!(labels(&t), ["a.ts", "x.ts"]);
        // empty
        let (t, _) = tree(vec![ChangeGroup::unversioned(vec![])]);
        assert_eq!(t.rows.len(), 1);
        assert!(!t.selectable(0));
    }

    #[test]
    fn folding_keeps_the_cursor_on_its_node() {
        let (mut t, mut s) = tree(sample());
        s.set_cursor(Some(6)); // client.ts
        // k on a file: to its folder; k again folds it; again: up to src
        assert!(t.left(&mut s));
        assert_eq!(s.cursor(), Some(4));
        assert!(t.left(&mut s));
        assert!(!t.rows[4].open);
        assert_eq!(s.cursor(), Some(4));
        assert!(t.left(&mut s));
        assert_eq!(s.cursor(), Some(3));
        // ä unfolds, then steps in
        s.set_cursor(Some(4));
        assert!(t.right(&mut s));
        assert!(t.rows[4].open);
        assert!(t.right(&mut s));
        assert_eq!(s.cursor(), Some(5));
        // folding a group with the cursor inside moves it to the group
        s.set_cursor(Some(6));
        t.toggle(0, Some(false), &mut s);
        assert_eq!(s.cursor(), Some(0));
        assert_eq!(
            labels(&t),
            ["> Changes", "v Unversioned Files", "  notes.txt"]
        );
        // collapse all / expand all
        t.set_all_open(true, &mut s);
        assert_eq!(t.rows.len(), 11);
        t.set_all_open(false, &mut s);
        assert_eq!(labels(&t), ["> Changes", "> Unversioned Files"]);
    }

    #[test]
    fn checkboxes_are_tri_state() {
        let mut t = ChangesTree::new().with_checkboxes();
        let mut s = ListState::new();
        t.set_groups(sample(), &mut s);
        // Auth.ts included: its folders mixed, group mixed
        assert!(t.toggle_included(&t.rows[5].files.clone()));
        assert_eq!(
            labels(&t)[..6],
            [
                "v [-] Changes",
                "  v [ ] apps/web/src",
                "    [ ] main.tsx",
                "  v [-] src",
                "    v [-] services/api",
                "      [x] Auth.ts",
            ]
        );
        // a folder: all its files; again: none
        t.toggle_included(&t.rows[4].files.clone());
        assert_eq!(t.check_state(4), CheckState::Checked);
        t.toggle_included(&t.rows[4].files.clone());
        assert_eq!(t.check_state(4), CheckState::Unchecked);
        t.toggle_included(&t.rows[0].files.clone());
        assert_eq!(t.check_state(0), CheckState::Checked);
        assert_eq!(t.included_files().len(), 5);
        // refresh: paths that went away are dropped
        let mut groups = sample();
        groups[0].files.remove(0);
        t.set_groups(groups, &mut s);
        assert_eq!(t.included().unwrap().len(), 4);
        // multi-selection Space: union of the rows' files
        s.set_selection(Some(8), [8, 9]);
        assert!(t.toggle_selection(&s));
        assert!(t.included().unwrap().contains("notes.txt"));
    }

    #[test]
    fn copy_paths_and_renames() {
        let mut t = ChangesTree::new().with_root("/repo");
        let mut s = ListState::new();
        t.set_groups(
            vec![ChangeGroup::plain(vec![
                f("src/new.ts", Renamed).renamed_from("src/old.ts"),
                f("lib/moved.ts", Renamed).renamed_from("src/moved.ts"),
            ])],
            &mut s,
        );
        assert_eq!(labels(&t), ["v lib", "  moved.ts", "v src", "  new.ts"]);
        assert_eq!(t.paths(&[0, 3]), ["/repo/lib", "/repo/src/new.ts"]);
        assert_eq!(ChangeStatus::from_letter('R'), Some(Renamed));
        assert_eq!(ChangeStatus::from_letter('x'), None);
        assert_eq!(Renamed.color(), look::GIT_RENAMED.rgba());
        assert_eq!(Unversioned.color(), look::GIT_UNTRACKED.rgba());
    }

    /// An ancestor, a row id, and whether it is one: a folder only at a path boundary.
    const ANCESTORS: &[(&str, &str, bool)] = &[
        ("g:changes", "f:changes:src/a.ts", true),
        ("g:changes", "f:unversioned:a.ts", false),
        ("d:changes:src", "f:changes:src/a.ts", true),
        ("d:changes:src", "f:changes:srcx/a.ts", false),
    ];

    #[test]
    fn a_row_id_is_below_its_group_and_its_folders_only() {
        for (anc, id, want) in ANCESTORS {
            assert_eq!(is_ancestor_id(anc, id), *want, "{anc} {id}");
        }
    }
}
