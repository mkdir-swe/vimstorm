//! The tree's selection, kept by path so it survives rows coming and going (expanding, the file
//! watcher, search results): the selected row (cursor), the anchor of a range and the
//! multi-selection (WebStorm / `config/tree.lua`: Shift+↑/↓ and Shift+click extend from the
//! anchor, Cmd/Alt+click toggles a row, plain moves / clicks / Esc clear it; the project root row
//! is never part of a multi-selection).

use std::path::Path;
use std::sync::Arc;

use super::model::Row;

#[derive(Clone, Debug, Default)]
pub struct Selection {
    pub cursor: Option<Arc<Path>>,
    anchor: Option<Arc<Path>>,
    /// In row order when set; empty = just the cursor.
    multi: Vec<Arc<Path>>,
}

impl Selection {
    /// Selects one row (clears a multi-selection).
    pub fn set(&mut self, path: Option<Arc<Path>>) {
        self.anchor = path.clone();
        self.cursor = path;
        self.multi.clear();
    }

    pub fn clear_multi(&mut self) {
        self.multi.clear();
        self.anchor = self.cursor.clone();
    }

    pub fn multi(&self) -> &[Arc<Path>] {
        &self.multi
    }

    pub fn has_multi(&self) -> bool {
        !self.multi.is_empty()
    }

    /// More than one row selected (the menu's / Enter's multi-row actions).
    pub fn is_multi(&self) -> bool {
        self.multi.len() > 1
    }

    pub fn is_selected(&self, path: &Path) -> bool {
        if self.multi.is_empty() {
            self.cursor.as_deref() == Some(path)
        } else {
            self.multi.iter().any(|p| **p == *path)
        }
    }

    /// What the actions act on: the multi-selection, else the cursor row.
    pub fn paths(&self) -> Vec<Arc<Path>> {
        if self.multi.is_empty() {
            self.cursor.iter().cloned().collect()
        } else {
            self.multi.clone()
        }
    }

    /// Selects the rows from the anchor (the cursor when there's no multi-selection yet) to row
    /// `to`, cursor on `to` (Shift+↑/↓, Shift+click).
    pub fn extend_to(&mut self, rows: &[Row], to: usize) {
        let row_of = |p: &Path| rows.iter().position(|r| *r.path == *p);
        let anchor = if self.multi.is_empty() {
            self.cursor.clone()
        } else {
            self.anchor.clone().or_else(|| self.cursor.clone())
        };
        let from = anchor.as_deref().and_then(row_of).unwrap_or(to);
        let (a, b) = (from.min(to), from.max(to));
        self.multi = rows[a..=b.min(rows.len().saturating_sub(1))]
            .iter()
            .filter(|r| !r.is_root())
            .map(|r| r.path.clone())
            .collect();
        self.anchor = Some(rows[from].path.clone());
        self.cursor = Some(rows[to].path.clone());
    }

    /// Cmd / Alt+click: the row in or out of the selection (the first toggle keeps the selected
    /// row selected), the row becomes the anchor and the cursor.
    pub fn toggle(&mut self, rows: &[Row], at: usize) {
        let row = &rows[at];
        if self.multi.is_empty()
            && let Some(c) = &self.cursor
            && rows.iter().any(|r| r.path == *c && !r.is_root())
        {
            self.multi.push(c.clone());
        }
        if let Some(i) = self.multi.iter().position(|p| *p == row.path) {
            self.multi.remove(i);
        } else if !row.is_root() {
            self.multi.push(row.path.clone());
            self.sort(rows);
        }
        self.anchor = Some(row.path.clone());
        self.cursor = Some(row.path.clone());
    }

    /// Rows that are gone leave the multi-selection; the rest goes in row order.
    pub fn retain(&mut self, rows: &[Row]) {
        self.multi.retain(|p| rows.iter().any(|r| r.path == *p));
        self.sort(rows);
    }

    fn sort(&mut self, rows: &[Row]) {
        let pos = |p: &Arc<Path>| rows.iter().position(|r| r.path == *p).unwrap_or(usize::MAX);
        self.multi.sort_by_key(pos);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::tree::model::Kids;

    fn rows(names: &[&str]) -> Vec<Row> {
        names
            .iter()
            .enumerate()
            .map(|(i, n)| Row {
                path: Arc::from(Path::new(&format!("/r/{n}"))),
                name: n.to_string(),
                depth: if i == 0 { 0 } else { 1 },
                dir: false,
                link: false,
                open: false,
                kids: Kids::No,
                excluded: false,
                matches: None,
            })
            .collect()
    }

    fn names(s: &Selection) -> Vec<String> {
        s.paths()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn shift_extends_from_the_anchor_and_toggles() {
        let r = rows(&["root", "a", "b", "c", "d", "e"]);
        let mut s = Selection::default();
        s.set(Some(r[1].path.clone()));
        s.extend_to(&r, 2);
        s.extend_to(&r, 3);
        assert_eq!(names(&s), ["a", "b", "c"]);
        s.extend_to(&r, 2);
        assert_eq!(names(&s), ["a", "b"]);
        // range up past the root: the root isn't selected
        s.extend_to(&r, 0);
        assert_eq!(names(&s), ["a"]);
        s.set(Some(r[1].path.clone()));
        s.extend_to(&r, 4);
        assert_eq!(names(&s), ["a", "b", "c", "d"]);
        s.toggle(&r, 2);
        assert_eq!(names(&s), ["a", "c", "d"]);
        s.toggle(&r, 5);
        assert_eq!(names(&s), ["a", "c", "d", "e"]);
        assert!(s.is_selected(&r[5].path) && !s.is_selected(&r[2].path));
        s.clear_multi();
        assert_eq!(names(&s), ["e"]);
        // the first toggle keeps the selected row
        s.toggle(&r, 1);
        assert_eq!(names(&s), ["a", "e"]);
        s.retain(&r[..3]);
        assert_eq!(names(&s), ["a"]);
    }
}
