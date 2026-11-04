//! The Log tab's pure state: the listed commits (+ graph), the cursor row and the selected
//! commits, with Lua `git/log.lua`'s selection rules:
//!
//! - Space toggles the commit under the cursor; while Space is held (until its key-up), moving
//!   selects every commit passed; Space key repeats are ignored.
//! - Shift+arrows extends a range from where it started, on top of what was selected before the
//!   range began.
//! - Plain moves keep the selection (like Local Changes' included files); Esc clears it.
//! - A mouse drag selects the rows it covers (replacing the selection), like WS / the Lua Visual
//!   drag.
//!
//! The changed files follow [`LogModel::details_target`]: the selected commits when 2+ are
//! selected, else the cursor's commit.

use std::collections::HashSet;
use std::sync::Arc;

use crate::git::graph::Graph;
use crate::git::log::{Commit, LogKind, LogSnapshot};

/// What the details pane shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailsTarget {
    None,
    /// The cursor's commit (or the only selected one).
    One(String),
    /// 2+ selected commits, newest first (log order).
    Many(Vec<String>),
}

/// A Shift range: its anchor row, the selection before it began, and where it is now.
#[derive(Clone, Debug)]
struct Range {
    anchor: usize,
    base: HashSet<String>,
    line: usize,
}

#[derive(Clone, Debug)]
pub struct LogModel {
    pub commits: Arc<Vec<Commit>>,
    pub graph: Arc<Graph>,
    pub kind: LogKind,
    /// The cursor row (None: no rows).
    cursor: Option<usize>,
    /// Selected commits by hash (read-only outside; see the module doc).
    selected: HashSet<String>,
    range: Option<Range>,
    /// Space is held (between its key-down and key-up).
    hold: bool,
    /// The cursor row at the last move (rows passed while Space is held).
    last_line: Option<usize>,
    /// The cursor's commit wasn't in a partial snapshot yet: the next ones look for it.
    want: Option<String>,
}

impl Default for LogModel {
    fn default() -> Self {
        LogModel {
            commits: Arc::default(),
            graph: Arc::default(),
            kind: LogKind::Graph,
            cursor: None,
            selected: HashSet::new(),
            range: None,
            hold: false,
            last_line: None,
            want: None,
        }
    }
}

impl LogModel {
    pub fn len(&self) -> usize {
        self.commits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
    }

    pub fn cursor(&self) -> Option<usize> {
        self.cursor
    }

    /// The commit under the cursor.
    pub fn current(&self) -> Option<&Commit> {
        self.cursor.and_then(|i| self.commits.get(i))
    }

    pub fn is_selected(&self, ix: usize) -> bool {
        self.commits
            .get(ix)
            .is_some_and(|c| self.selected.contains(&c.hash))
    }

    pub fn has_selection(&self) -> bool {
        !self.selected.is_empty()
    }

    pub fn holding(&self) -> bool {
        self.hold
    }

    /// The selected commits in log order (newest first).
    pub fn selection(&self) -> Vec<&Commit> {
        if self.selected.is_empty() {
            return Vec::new();
        }
        self.commits
            .iter()
            .filter(|c| self.selected.contains(&c.hash))
            .collect()
    }

    /// The selected commits, else the cursor's (Cmd+C, cherry-pick).
    pub fn selection_or_current(&self) -> Vec<&Commit> {
        let sel = self.selection();
        if sel.is_empty() {
            self.current().into_iter().collect()
        } else {
            sel
        }
    }

    pub fn details_target(&self) -> DetailsTarget {
        let sel = self.selection();
        if sel.len() > 1 {
            return DetailsTarget::Many(sel.iter().map(|c| c.hash.clone()).collect());
        }
        match self.current() {
            Some(c) => DetailsTarget::One(c.hash.clone()),
            None => DetailsTarget::None,
        }
    }

    pub fn index_of(&self, hash_prefix: &str) -> Option<usize> {
        if hash_prefix.is_empty() {
            return None;
        }
        self.commits
            .iter()
            .position(|c| c.hash.starts_with(hash_prefix))
    }

    /// A new snapshot of the same listing (streaming / refresh): the cursor stays on its commit
    /// (else row 0), selected commits that are still listed stay selected.
    pub fn set_snapshot(&mut self, snap: &LogSnapshot) {
        let keep = self
            .want
            .take()
            .or_else(|| self.current().map(|c| c.hash.clone()));
        self.commits = snap.commits.clone();
        self.graph = snap.graph.clone();
        self.kind = snap.kind;
        let at = keep
            .as_ref()
            .and_then(|h| self.commits.iter().position(|c| &c.hash == h));
        if at.is_none() && !snap.done {
            // a partial snapshot (git still walking): the commit may come with the next one
            self.want = keep;
        }
        self.cursor = if self.commits.is_empty() {
            None
        } else {
            Some(at.or(self.cursor).unwrap_or(0).min(self.commits.len() - 1))
        };
        if !self.selected.is_empty() && snap.done {
            let listed: HashSet<&str> = self.commits.iter().map(|c| c.hash.as_str()).collect();
            self.selected.retain(|h| listed.contains(h.as_str()));
        }
        self.range = None;
        self.last_line = self.cursor;
    }

    /// Another listing (filters changed): the selection goes, the cursor will be on row 0.
    pub fn reset_listing(&mut self, forget_rows: bool) {
        self.want = None;
        self.selected.clear();
        self.range = None;
        self.cursor = None;
        self.last_line = None;
        if forget_rows {
            self.commits = Arc::default();
            self.graph = Arc::default();
        }
    }

    /// Moves the cursor (clamped). While Space is held, the rows passed get selected. True when
    /// it moved.
    pub fn move_to(&mut self, ix: usize) -> bool {
        if self.commits.is_empty() {
            return false;
        }
        self.want = None;
        let ix = ix.min(self.commits.len() - 1);
        let moved = self.cursor != Some(ix);
        self.cursor = Some(ix);
        if self.hold
            && let Some(last) = self.last_line
            && last != ix
        {
            self.set_rows(last, ix, true);
        }
        self.last_line = Some(ix);
        moved
    }

    pub fn move_by(&mut self, by: isize) -> bool {
        let Some(cur) = self.cursor else {
            return self.move_to(0);
        };
        let ix = (cur as isize + by).clamp(0, self.commits.len() as isize - 1);
        self.move_to(ix as usize)
    }

    fn set_rows(&mut self, a: usize, b: usize, on: bool) {
        for i in a.min(b)..=a.max(b) {
            if let Some(c) = self.commits.get(i) {
                if on {
                    self.selected.insert(c.hash.clone());
                } else {
                    self.selected.remove(&c.hash);
                }
            }
        }
    }

    /// Space down (`repeat`: a key repeat). Toggles the cursor's commit and starts a hold; repeats
    /// and presses while held are ignored. True when the selection changed.
    pub fn space_down(&mut self, repeat: bool) -> bool {
        if repeat || self.hold {
            return false;
        }
        let Some(cur) = self.cursor else {
            return false;
        };
        let hash = self.commits[cur].hash.clone();
        if !self.selected.remove(&hash) {
            self.selected.insert(hash);
        }
        self.range = None;
        self.last_line = Some(cur);
        self.hold = true;
        true
    }

    /// Space up: the hold ends.
    pub fn space_up(&mut self) {
        self.hold = false;
    }

    /// Toggles the cursor's commit without a hold (menu "Select Commit").
    pub fn toggle_current(&mut self) -> bool {
        let Some(cur) = self.cursor else {
            return false;
        };
        let hash = self.commits[cur].hash.clone();
        if !self.selected.remove(&hash) {
            self.selected.insert(hash);
        }
        self.range = None;
        true
    }

    /// Cmd+click: toggles one row.
    pub fn toggle_row(&mut self, ix: usize) -> bool {
        self.move_to(ix);
        self.toggle_current()
    }

    /// Shift+move: extends the range one row in `dir` (1 down, -1 up). True when it moved.
    pub fn extend(&mut self, dir: isize) -> bool {
        let Some(cur) = self.cursor else {
            return false;
        };
        let target = cur as isize + dir;
        if target < 0 || target >= self.commits.len() as isize {
            return false;
        }
        self.extend_to(target as usize)
    }

    /// Shift+click / Shift+PageDown: the range from its anchor to `ix`.
    pub fn extend_to(&mut self, ix: usize) -> bool {
        let Some(cur) = self.cursor else {
            return false;
        };
        let ix = ix.min(self.commits.len().saturating_sub(1));
        if self.range.as_ref().is_none_or(|r| r.line != cur) {
            self.range = Some(Range {
                anchor: cur,
                base: self.selected.clone(),
                line: cur,
            });
        }
        let r = self.range.as_mut().expect("set above");
        let anchor = r.anchor;
        r.line = ix;
        self.selected = r.base.clone();
        self.set_rows(anchor, ix, true);
        self.cursor = Some(ix);
        self.last_line = Some(ix);
        true
    }

    /// A drag from row `a` to `b`: exactly those rows are selected (Shift+move goes on from it).
    pub fn select_drag(&mut self, a: usize, b: usize) {
        if self.commits.is_empty() {
            return;
        }
        let (a, b) = (a.min(self.commits.len() - 1), b.min(self.commits.len() - 1));
        self.selected.clear();
        self.set_rows(a, b, true);
        self.cursor = Some(b);
        self.range = Some(Range {
            anchor: a,
            base: HashSet::new(),
            line: b,
        });
        self.last_line = Some(b);
    }

    /// Esc: false when nothing was selected.
    pub fn clear_selection(&mut self) -> bool {
        if self.selected.is_empty() {
            return false;
        }
        self.selected.clear();
        self.range = None;
        true
    }

    /// Commits reachable from HEAD among the listed ones (WS CurrentBranchHighlighter, used when
    /// the log shows more than the current branch). Indexed like `commits`.
    pub fn head_reachable(&self) -> Vec<bool> {
        let mut out = vec![false; self.commits.len()];
        let Some(head) = self.commits.iter().position(|c| c.refs.is_head()) else {
            return out;
        };
        let index: std::collections::HashMap<&str, usize> = self
            .commits
            .iter()
            .enumerate()
            .map(|(i, c)| (c.hash.as_str(), i))
            .collect();
        let mut stack = vec![head];
        while let Some(i) = stack.pop() {
            if std::mem::replace(&mut out[i], true) {
                continue;
            }
            for p in &self.commits[i].parents {
                if let Some(&j) = index.get(p.as_str()) {
                    stack.push(j);
                }
            }
        }
        out
    }
}

/// Which of the log's columns fit (Lua `git/log.lua` `M.columns`, in pixels): the subject
/// matters most, so the date goes first, then the author; Show History for Selection's hash column
/// last.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Columns {
    pub author: f32,
    pub date: f32,
    pub hash: f32,
}

/// Lua's cell thresholds (subject < 40 cells: no date; < 24: no author; < 16: no hash) at the
/// UI font's average cell (~7 px at Inter 13).
pub const SUBJECT_MIN_WITH_DATE: f32 = 280.;
pub const SUBJECT_MIN_WITH_AUTHOR: f32 = 168.;
pub const SUBJECT_MIN_WITH_HASH: f32 = 112.;

/// `width`: the table's width; `graph`: the widest graph + gaps (the subject's start); `author`,
/// `date`, `hash`: the columns' natural widths (hash 0 = no hash column).
pub fn columns(width: f32, graph: f32, author: f32, date: f32, hash: f32) -> Columns {
    let mut c = Columns { author, date, hash };
    let subject = |c: &Columns| width - graph - c.author - c.date - c.hash;
    if subject(&c) < SUBJECT_MIN_WITH_DATE {
        c.date = 0.;
    }
    if subject(&c) < SUBJECT_MIN_WITH_AUTHOR {
        c.author = 0.;
    }
    if subject(&c) < SUBJECT_MIN_WITH_HASH {
        c.hash = 0.;
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::log::{Person, Refs, Time};

    fn commit(i: usize) -> Commit {
        Commit {
            hash: format!("{i:040x}"),
            parents: vec![format!("{:040x}", i + 1)],
            author: Person::default(),
            committer: Person::default(),
            author_time: Time::default(),
            commit_time: Time::default(),
            refs: Refs::default(),
            subject: format!("c{i}"),
            change: None,
        }
    }

    fn model(n: usize) -> LogModel {
        let mut m = LogModel::default();
        m.set_snapshot(&LogSnapshot {
            commits: Arc::new((0..n).map(commit).collect()),
            graph: Arc::default(),
            kind: LogKind::Graph,
            done: true,
            truncated: false,
            error: None,
        });
        m
    }

    fn subjects(m: &LogModel) -> Vec<String> {
        m.selection().iter().map(|c| c.subject.clone()).collect()
    }

    #[test]
    fn space_toggles_and_held_space_selects_rows_passed() {
        let mut m = model(6);
        assert_eq!(m.cursor(), Some(0));
        assert!(m.space_down(false));
        m.space_up();
        m.move_by(1);
        assert!(m.space_down(false));
        m.space_up();
        assert_eq!(subjects(&m), ["c0", "c1"]);
        assert_eq!(
            m.details_target(),
            DetailsTarget::Many(vec![commit(0).hash, commit(1).hash])
        );
        // Space again unselects
        m.space_down(false);
        m.space_up();
        assert_eq!(subjects(&m), ["c0"]);
        assert_eq!(m.details_target(), DetailsTarget::One(commit(1).hash));
        assert!(m.clear_selection());
        assert!(!m.clear_selection());
        // hold: repeats ignored, moves select
        m.move_to(0);
        m.space_down(false);
        assert!(!m.space_down(true));
        m.move_by(1);
        m.move_by(1);
        m.space_up();
        m.move_by(1);
        assert_eq!(subjects(&m), ["c0", "c1", "c2"]);
        // hold on a selected commit unselects it; moving then selects
        m.clear_selection();
        m.move_to(0);
        m.toggle_current();
        m.space_down(false);
        assert!(subjects(&m).is_empty());
        m.move_by(1);
        assert_eq!(subjects(&m), ["c0", "c1"]);
    }

    #[test]
    fn shift_extends_a_range_on_top_of_the_earlier_selection() {
        let mut m = model(8);
        m.move_to(5);
        m.toggle_current();
        m.move_to(0);
        m.extend(1);
        m.extend(1);
        assert_eq!(subjects(&m), ["c0", "c1", "c2", "c5"]);
        m.extend(-1);
        assert_eq!(subjects(&m), ["c0", "c1", "c5"]);
        // a plain move ends the range: the next Shift starts a new one there
        m.move_to(6);
        m.extend(1);
        assert_eq!(subjects(&m), ["c0", "c1", "c5", "c6", "c7"]);
        m.select_drag(2, 3);
        assert_eq!(subjects(&m), ["c2", "c3"]);
        m.extend(1);
        assert_eq!(subjects(&m), ["c2", "c3", "c4"]);
    }

    #[test]
    fn snapshots_keep_the_cursor_commit() {
        let mut m = model(5);
        m.move_to(3);
        let mut commits: Vec<Commit> = (0..5).map(commit).collect();
        commits.insert(0, commit(99));
        m.set_snapshot(&LogSnapshot {
            commits: Arc::new(commits),
            graph: Arc::default(),
            kind: LogKind::Graph,
            done: true,
            truncated: false,
            error: None,
        });
        assert_eq!(m.cursor(), Some(4));
        assert_eq!(m.current().unwrap().subject, "c3");
        // a partial snapshot without it (git still walking): the full one finds it again
        let snap = |commits: Vec<Commit>, done| LogSnapshot {
            commits: Arc::new(commits),
            graph: Arc::default(),
            kind: LogKind::Graph,
            done,
            truncated: false,
            error: None,
        };
        m.set_snapshot(&snap(vec![commit(98)], false));
        let mut all: Vec<Commit> = (0..5).map(commit).collect();
        all.insert(0, commit(98));
        m.set_snapshot(&snap(all, true));
        assert_eq!(m.current().unwrap().subject, "c3");
    }
}
