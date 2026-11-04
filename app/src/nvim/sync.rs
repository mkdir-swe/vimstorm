//! Sync groups: windows whose grids must be presented together (the diff viewer's / merge window's
//! panes, `git/scrollsync.lua`). Pure state, no GPUI: the editor feeds it redraw batches, Lua's
//! "synced" markers and the clock, and asks which grids to draw from a snapshot.
//!
//! When nvim scrolls one pane, `scrollsync.lua` scrolls its partners from `WinScrolled`. In normal /
//! insert mode nvim runs `WinScrolled` before `update_screen` (normal.c `normal_check`: the
//! `normal_check_window_scrolled` call comes before `normal_redraw`), so both panes usually change
//! in the same flush, and Lua's marker (an RPC notification sent from the autocmd) arrives before
//! that flush's redraw batch. A flush can still land between a scroll and its `WinScrolled`
//! (`ui_flush` before a queued RPC event, `nvim__redraw`, `vim.wait`, a scroll without autocmds):
//! then the moved grid keeps showing its previous picture ([`Held`]) until the partner's follow-up
//! flush lines up with Lua's marker, or [`HOLD_SYNC`] passed, so nothing sticks.
//!
//! "Lined up" = every grid's topline equals the topline Lua last reported for its window. A group
//! without a marker yet counts as lined up (Lua sends one when the group is created).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use super::redraw::{GridId, RedrawEvent};
use super::ui::{Grid, Margins, UiState, Viewport};

/// A sync group's id (`git/scrollsync.lua`).
pub type SyncGroup = i64;

/// Longest a moved pane waits for its partners (about two frames).
pub const HOLD_SYNC: Duration = Duration::from_millis(25);

/// The picture of a grid kept on screen while its partners catch up.
#[derive(Clone, Debug)]
pub struct Held {
    pub grid: Grid,
    pub viewport: Option<Viewport>,
    pub margins: Margins,
}

/// What a group shows: (grid, topline as presented, held or live), in grid order (tests).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Presented {
    pub group: SyncGroup,
    pub panes: Vec<(GridId, i64, bool)>,
}

#[derive(Default)]
pub struct SyncState {
    /// Grid -> its group (from Lua's layout, resolved to grids by the editor).
    groups: HashMap<GridId, SyncGroup>,
    /// Lua's last marker: window handle -> topline (0-based).
    marks: HashMap<i64, i64>,
    /// Topline on screen per grid of a group.
    shown: HashMap<GridId, i64>,
    held: HashMap<GridId, Held>,
    /// Since when grids are held.
    since: Option<Instant>,
    /// Pictures of the group grids before the batches of the coming flush.
    pre: Option<HashMap<GridId, Held>>,
    /// Record of what was presented after each change (tests), when on.
    log: Option<Vec<Presented>>,
}

fn snapshot(ui: &UiState, grid: GridId) -> Option<Held> {
    let w = ui.windows.get(&grid);
    Some(Held {
        grid: ui.grids.get(&grid)?.clone(),
        viewport: w.and_then(|w| w.viewport),
        margins: w.map(|w| w.margins).unwrap_or_default(),
    })
}

fn topline(ui: &UiState, grid: GridId) -> Option<i64> {
    Some(ui.windows.get(&grid)?.viewport?.topline)
}

/// Whether a redraw event touches a grid's picture.
fn touches(ev: &RedrawEvent, grids: &HashMap<GridId, SyncGroup>) -> bool {
    use RedrawEvent as E;
    let g = match ev {
        E::GridLine { grid, .. }
        | E::GridScroll { grid, .. }
        | E::GridClear { grid }
        | E::GridResize { grid, .. }
        | E::WinViewport { grid, .. } => grid,
        _ => return false,
    };
    grids.contains_key(g)
}

impl SyncState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The groups from Lua's layout (grid -> group). Grids leaving a group are released.
    pub fn set_groups(&mut self, groups: HashMap<GridId, SyncGroup>) {
        if groups == self.groups {
            return;
        }
        self.held.retain(|g, _| groups.contains_key(g));
        self.shown.retain(|g, _| groups.contains_key(g));
        if self.held.is_empty() {
            self.since = None;
        }
        self.groups = groups;
    }

    pub fn group_of(&self, grid: GridId) -> Option<SyncGroup> {
        self.groups.get(&grid).copied()
    }

    /// The other grids of `grid`'s group.
    pub fn partners(&self, grid: GridId) -> Vec<GridId> {
        let Some(group) = self.group_of(grid) else {
            return Vec::new();
        };
        let mut out: Vec<GridId> = self
            .groups
            .iter()
            .filter(|(g, gr)| **gr == group && **g != grid)
            .map(|(g, _)| *g)
            .collect();
        out.sort_unstable();
        out
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    /// The held picture of a grid (drawn instead of nvim's current one).
    pub fn held(&self, grid: GridId) -> Option<&Held> {
        self.held.get(&grid)
    }

    pub fn holding(&self) -> bool {
        !self.held.is_empty()
    }

    /// Before applying a redraw batch: keep the group grids' pictures it is about to change (once
    /// per flush; held grids keep their older picture).
    pub fn before_batch(&mut self, ui: &UiState, batch: &[RedrawEvent]) {
        if self.groups.is_empty() || self.pre.is_some() {
            return;
        }
        if !batch.iter().any(|e| touches(e, &self.groups)) {
            return;
        }
        let pre = self
            .groups
            .keys()
            .filter(|g| !self.held.contains_key(g))
            .filter_map(|g| Some((*g, snapshot(ui, *g)?)))
            .collect();
        self.pre = Some(pre);
    }

    /// Lua's marker: the toplines a group's windows line up at.
    pub fn mark(&mut self, tops: &[(i64, i64)]) {
        for (win, top) in tops {
            self.marks.insert(*win, *top);
        }
    }

    /// Whether `group`'s grids show what Lua lined up (no marker for a window: yes).
    fn lined_up(&self, ui: &UiState, group: SyncGroup) -> bool {
        self.groups
            .iter()
            .filter(|(_, gr)| **gr == group)
            .all(|(g, _)| {
                let Some(w) = ui.windows.get(g) else {
                    return true;
                };
                match (self.marks.get(&w.win), topline(ui, *g)) {
                    (Some(want), Some(top)) => *want == top,
                    _ => true,
                }
            })
    }

    fn groups(&self) -> HashSet<SyncGroup> {
        self.groups.values().copied().collect()
    }

    fn grids_of(&self, group: SyncGroup) -> Vec<GridId> {
        let mut out: Vec<GridId> = self
            .groups
            .iter()
            .filter(|(_, gr)| **gr == group)
            .map(|(g, _)| *g)
            .collect();
        out.sort_unstable();
        out
    }

    fn release(&mut self, ui: &UiState, group: SyncGroup) {
        for g in self.grids_of(group) {
            self.held.remove(&g);
            if let Some(top) = topline(ui, g) {
                self.shown.insert(g, top);
            }
        }
        if self.held.is_empty() {
            self.since = None;
        }
    }

    /// After a flush was applied: decides per group what to present. Returns whether a hold
    /// started (the caller re-checks after [`HOLD_SYNC`]).
    pub fn flushed(&mut self, ui: &UiState, now: Instant) -> bool {
        let pre = self.pre.take().unwrap_or_default();
        self.held.retain(|g, _| ui.grids.contains_key(g));
        let mut started = false;
        for group in self.groups() {
            let grids = self.grids_of(group);
            let moved: Vec<GridId> = grids
                .iter()
                .copied()
                .filter(|g| {
                    let now = topline(ui, *g);
                    now.is_some() && self.shown.get(g).is_some_and(|s| Some(*s) != now)
                })
                .collect();
            if moved.is_empty() || self.lined_up(ui, group) {
                self.release(ui, group);
                continue;
            }
            for g in moved {
                if self.held.contains_key(&g) {
                    continue;
                }
                if let Some(h) = pre.get(&g) {
                    self.held.insert(g, h.clone());
                }
            }
            if self.since.is_none() && self.holding() {
                self.since = Some(now);
                started = true;
            }
        }
        self.record(ui);
        started
    }

    /// After a marker: groups that line up now are released. Returns whether anything changed.
    pub fn marked(&mut self, ui: &UiState) -> bool {
        if !self.holding() {
            return false;
        }
        let mut changed = false;
        for group in self.groups() {
            let held = self
                .grids_of(group)
                .iter()
                .any(|g| self.held.contains_key(g));
            if held && self.lined_up(ui, group) {
                self.release(ui, group);
                changed = true;
            }
        }
        if changed {
            self.record(ui);
        }
        changed
    }

    /// The hold timed out (at `now`): everything is presented as it is. Returns whether anything
    /// changed.
    pub fn expire(&mut self, ui: &UiState, now: Instant) -> bool {
        let Some(since) = self.since else {
            return false;
        };
        if now.saturating_duration_since(since) < HOLD_SYNC {
            return false;
        }
        for group in self.groups() {
            self.release(ui, group);
        }
        self.held.clear();
        self.since = None;
        self.record(ui);
        true
    }

    /// Topline as presented (held picture or nvim's).
    pub fn presented_top(&self, ui: &UiState, grid: GridId) -> Option<i64> {
        match self.held.get(&grid) {
            Some(h) => h.viewport.map(|v| v.topline),
            None => topline(ui, grid),
        }
    }

    /// Starts / stops recording what's presented (tests).
    pub fn record_presented(&mut self, on: bool) {
        self.log = on.then(Vec::new);
    }

    /// What was presented after each change since recording started.
    pub fn presented_log(&self) -> &[Presented] {
        self.log.as_deref().unwrap_or(&[])
    }

    fn record(&mut self, ui: &UiState) {
        if self.log.is_none() {
            return;
        }
        let mut groups: Vec<SyncGroup> = self.groups().into_iter().collect();
        groups.sort_unstable();
        let entries: Vec<Presented> = groups
            .into_iter()
            .map(|group| Presented {
                group,
                panes: self
                    .grids_of(group)
                    .into_iter()
                    .filter_map(|g| {
                        Some((g, self.presented_top(ui, g)?, self.held.contains_key(&g)))
                    })
                    .collect(),
            })
            .collect();
        if let Some(log) = &mut self.log {
            log.extend(entries);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nvim::redraw::RedrawEvent as E;

    /// Two windows (grids 2 and 3, handles 1000 / 1001) of 10 x 5 in group 7.
    fn ui() -> UiState {
        let mut ui = UiState::new();
        ui.apply(vec![
            E::GridResize {
                grid: 2,
                width: 10,
                height: 5,
            },
            E::GridResize {
                grid: 3,
                width: 10,
                height: 5,
            },
            E::WinPos {
                grid: 2,
                win: 1000,
                start_row: 0,
                start_col: 0,
                width: 10,
                height: 5,
            },
            E::WinPos {
                grid: 3,
                win: 1001,
                start_row: 0,
                start_col: 11,
                width: 10,
                height: 5,
            },
            vp(2, 0),
            vp(3, 0),
            E::Flush,
        ]);
        ui
    }

    fn vp(grid: GridId, topline: i64) -> RedrawEvent {
        E::WinViewport {
            grid,
            win: 1000 + grid as i64 - 2,
            topline,
            botline: topline + 5,
            curline: topline,
            curcol: 0,
            line_count: 100,
            scroll_delta: 0,
        }
    }

    fn state(ui: &UiState) -> SyncState {
        let mut s = SyncState::new();
        s.set_groups(HashMap::from([(2, 7), (3, 7)]));
        s.mark(&[(1000, 0), (1001, 0)]);
        s.flushed(ui, Instant::now());
        s
    }

    fn apply(s: &mut SyncState, ui: &mut UiState, batch: Vec<RedrawEvent>, now: Instant) -> bool {
        s.before_batch(ui, &batch);
        ui.apply(batch);
        s.flushed(ui, now)
    }

    #[test]
    fn both_panes_in_one_flush_with_the_marker_first_present_at_once() {
        let mut ui = ui();
        let mut s = state(&ui);
        s.mark(&[(1000, 3), (1001, 5)]);
        let started = apply(
            &mut s,
            &mut ui,
            vec![vp(2, 3), vp(3, 5), E::Flush],
            Instant::now(),
        );
        assert!(!started && !s.holding());
        assert_eq!(s.presented_top(&ui, 2), Some(3));
        assert_eq!(s.presented_top(&ui, 3), Some(5));
    }

    #[test]
    fn a_pane_moved_alone_holds_its_old_picture_until_the_partner_follows() {
        let mut ui = ui();
        let mut s = state(&ui);
        s.record_presented(true);
        let t0 = Instant::now();
        // grid 2 scrolled, WinScrolled hasn't run: no marker for it
        let started = apply(&mut s, &mut ui, vec![vp(2, 3), E::Flush], t0);
        assert!(started);
        assert!(s.held(2).is_some() && s.held(3).is_none());
        assert_eq!(s.presented_top(&ui, 2), Some(0), "old picture");
        // Lua's sync: marker, then the partner's follow-up flush
        s.mark(&[(1000, 3), (1001, 4)]);
        assert!(!s.marked(&ui), "partner not drawn yet: still held");
        apply(&mut s, &mut ui, vec![vp(3, 4), E::Flush], t0);
        assert!(!s.holding());
        assert_eq!(s.presented_top(&ui, 2), Some(3));
        assert_eq!(s.presented_top(&ui, 3), Some(4));
        let log: Vec<_> = s.presented_log().iter().map(|p| p.panes.clone()).collect();
        assert_eq!(
            log,
            vec![
                vec![(2, 0, true), (3, 0, false)],
                vec![(2, 3, false), (3, 4, false)]
            ]
        );
    }

    #[test]
    fn a_marker_saying_nothing_moves_releases_the_hold() {
        let mut ui = ui();
        let mut s = state(&ui);
        apply(&mut s, &mut ui, vec![vp(2, 3), E::Flush], Instant::now());
        assert!(s.holding());
        // the partner stays (an insertion on one side): Lua says 3 / 0
        s.mark(&[(1000, 3), (1001, 0)]);
        assert!(s.marked(&ui));
        assert!(!s.holding());
    }

    #[test]
    fn holds_time_out() {
        let mut ui = ui();
        let mut s = state(&ui);
        let t0 = Instant::now();
        apply(&mut s, &mut ui, vec![vp(2, 3), E::Flush], t0);
        assert!(!s.expire(&ui, t0 + HOLD_SYNC / 2));
        assert!(s.holding());
        assert!(s.expire(&ui, t0 + HOLD_SYNC));
        assert!(!s.holding());
        assert_eq!(s.presented_top(&ui, 2), Some(3));
    }

    #[test]
    fn grids_outside_groups_and_other_changes_never_hold() {
        let mut ui = ui();
        let mut s = SyncState::new();
        apply(&mut s, &mut ui, vec![vp(2, 3), E::Flush], Instant::now());
        assert!(!s.holding());
        let mut s = state(&ui);
        // text changes without a scroll: no hold
        let line = E::GridLine {
            grid: 2,
            row: 0,
            col_start: 0,
            cells: vec![],
        };
        apply(&mut s, &mut ui, vec![line, E::Flush], Instant::now());
        assert!(!s.holding());
        assert_eq!(s.partners(2), vec![3]);
    }
}
