//! The Git tool window's Log tab, WebStorm's Git Log: a collapsed "Branches" strip
//! (expands into the branches pane), the filter bar (text or hash field with `.*` / `Cc`, Branch /
//! User / Date / Paths chips, the right-side icon toolbar), the commit table (graph lanes drawn
//! natively from [`crate::git::graph`], subject, ref labels, author, date) and the changed files +
//! commit details pane on the right (splitter). Behaviour of the M4 Lua log (`git/log.lua`,
//! `git/details.lua`, `git/branches.lua`, `git/actions.lua`, the log parts of `git/init.lua`).
//!
//! Files:
//! - `model.rs`: listed commits, cursor, selected commits (pure, unit-tested).
//! - `table.rs` + `graph_paint.rs`: the commit table and its graph.
//! - `filters.rs` (+ `filter_popup.rs`): the filter bar, its popups and the toolbar.
//! - `details.rs`: the details pane ([`details::DetailsPane`]).
//! - `branches.rs`: the Branches strip / pane.
//! - `actions.rs`: commit actions, context menus, checkout, cherry-pick, go to ref.
//! - `history.rs`: file history (`,H`), Show History for Selection (`git log -L`), show commit.
//!
//! Loading: [`crate::git::log::stream`] off the UI thread; each cumulative snapshot replaces
//! the rows (the first screen arrives while git still walks history). A newer load drops the
//! older one (its stream is dropped: git is killed). Rows stay on screen until the new listing's
//! first snapshot arrives.
//!
//! Keys while the table has the keyboard: l / ö / arrows move (a count first: `22ö`, `3Ö` = 15
//! rows), PageUp / PageDown, Ctrl+D / U / F / B, Home / End, `gg` / `G`, Space selects (hold +
//! move: the commits passed), v / V + moves, Shift+move a range, Esc clears the selection (then
//! closes the history for a selection, then back to the editor), Enter / ä / → the changed files,
//! Tab / Shift+Tab the other pane, `/` the text filter field, b u d p the filter popups (a lone
//! `d` after nvim's timeoutlen: `dd` is Drop Commit), Backspace clears the filters, c checkout,
//! Alt+Enter commit actions, `yy` Copy Hash, `rr` Reword… / `dd` Drop Commit (unpushed only),
//! Cmd+Enter the menu with everything, Cmd+C the commit messages, R refresh, `g?` help
//! ([`crate::kit`] parses counts / prefixes).
//!
//! Session (Lua `config/app/git.lua` `log_state`): filters and the details pane's width, given
//! back in the `open` event after a restart.

mod actions;
mod branches;
mod details;
mod filter_popup;
mod filters;
mod graph_paint;
mod history;
mod model;
mod pr;
mod table;

use std::time::Instant;

use futures::StreamExt as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Task,
    UniformListScrollHandle, Window, div, px,
};
use rmpv::Value;

use crate::app;
use crate::git::graph::GraphOptions;
use crate::git::log::{BranchFilter, DateFilter, LogFilters, LogOptions, LogSnapshot, Person};
use crate::git::window::{GitCommand, GitCx, GitTab, RepoChange, TabId};
use crate::kit::Anchor;
use crate::kit::{self, Step, Vim};
use crate::kit::{Fixed, SplitAxis, SplitEvent, SplitState};
use crate::look;
use crate::popups;
use crate::render::ui_font;
use model::LogModel;

/// How a load treats the rows shown now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reload {
    /// The filters changed: the selection goes, the cursor goes to the first row.
    Filters,
    /// The repo changed: cursor and selection stay on their commits.
    Refresh,
    /// Like `Filters`, and the old rows go at once ("Loading history…": Show History for
    /// Selection).
    Forget,
}

/// The details pane's default width: Lua's 30 % of the log, clamped (24..60 cells).
const DETAILS_MIN: f32 = 120.;
const DETAILS_DEFAULT: f32 = 300.;
/// The log keeps at least this much when the window gets narrow (Lua: 40 cells).
const LOG_MIN: f32 = 280.;

/// The tab label's branch name at most (was Lua `git/init.lua` `tab_label`).
const LABEL_MAX: usize = 24;

/// nvim's `timeoutlen` (`config/options.lua`): how long a lone `d` waits for a second one.
const D_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

pub const HELP: &str = "\
Log
  / b u d p           filter: text or hash, branch, user, date, paths
                      (popup: All clears it · field: Backspace, Enter clears it)
  Backspace           clear filters
  Space               select commit (hold + move: the ones you pass)
  Shift+ö / Shift+l   five rows down / up · a count first: 3ö 3 rows, 3Ö 15
  Shift+arrows        extend the selection · mouse drag
  Esc                 clear selection, else back to code
  Enter / ä           changed files · file: diff in the editor (focus stays here)
  Cmd+Ö / Cmd+L       in the diff: next / previous change, on into the next / previous file
  Tab / Shift+Tab     log <-> changed files
  F4                  open the file in the editor
  ,H (code)           history for the selected lines (Esc closes)
  Cmd+C               copy the commit messages · files: their paths
  v / V + move        select the commits passed · gg / G first / last
  yy                  copy the full hash
  rr / dd             reword / drop the commit (unpushed only; dd asks)
                      (d alone: the date filter, after a moment)
  Alt+Enter           commit actions (cherry-pick, revert, reset, reword, uncommit, drop)
  c                   checkout a branch
  Cmd+Enter           menu with everything (also right-click)
  R                   refresh
  Cmd+K / Cmd+Shift+K commit / push
  Alt+Cmd+←/→         other tabs (Commit <hash>: the changed files) · Cmd+J hide";

pub struct LogTab {
    pub(super) gcx: GitCx,
    pub model: LogModel,
    pub filters: LogFilters,
    /// `git config user.name / email` (bold author, the User popup's "me").
    pub me: Option<Person>,
    /// A load is running (an empty list says "Loading history…").
    pub loading: bool,
    /// git's error for the last load (bad regex ...).
    pub error: Option<String>,
    /// The running load (dropping it kills git).
    load_task: Option<Task<()>>,
    load_gen: u64,
    /// After the next snapshot: cursor to the first row / to this commit (show commit).
    pending_cursor: PendingCursor,
    /// Graph options (view menu: Show Long Edges).
    pub graph_opts: GraphOptions,
    /// The IntelliSort toggle (`--topo-order`; kept in the session).
    pub intellisort: bool,
    pub(super) scroll: UniformListScrollHandle,
    pub(super) split: Entity<SplitState>,
    /// The details pane is shown (view menu).
    pub details_shown: bool,
    /// Focus the changed files once drawn ([`Self::focus_files_when_drawn`]).
    focus_files_soon: bool,
    pub details: Entity<details::DetailsPane>,
    pub(super) filter_ui: filters::FilterUi,
    pub(super) branches: branches::BranchesUi,
    pub(super) actions: actions::ActionsUi,
    pub(super) history: history::HistoryUi,
    pub(super) table: table::TableUi,
    /// The table's Vim keys: a count, `gg` / `G`, `yy` / `dd` / `rr`, `g?`.
    vim: Vim,
    /// A lone `d` opens the Date filter after nvim's `timeoutlen` (a second `d` drops instead).
    d_wait: Option<Task<()>>,
    /// `v` / `V`: moves select from this row (Lua's Visual over the log buffer).
    visual: Option<usize>,
    /// Reloads asked for (tests: the repo-changed hook reached the tab).
    pub refreshes: Vec<RepoChange>,
    /// Reloads for new filters (tests; repo-change refreshes not counted).
    pub filter_reloads: u64,
    /// Lua entry points received (tests).
    pub commands: Vec<GitCommand>,
    pub shown: bool,
    /// Timing: Cmd+3 opened the tool window on this tab; marked when the first rows paint.
    pub(super) time_rows: Option<Instant>,
    /// The tool window opened once: session state is not restored anymore.
    opened_once: bool,
    /// The repo changed while the tab was hidden: reload when shown.
    stale: bool,
    /// A refresh of rows on screen: only its final snapshot replaces them (partial ones would
    /// shorten the list and lose the scroll position).
    refreshing: bool,
    /// When the first rows of the current load were painted (tests, perf).
    pub rows_painted_at: Option<Instant>,
    /// When the current load started / its first snapshot arrived (perf).
    pub load_started_at: Option<Instant>,
    pub first_snapshot_at: Option<Instant>,
    _subs: Vec<gpui_kit::Subscription>,
    /// The Git window's PR review ([`pr`]): its strip, scope and files while a PR is reviewed.
    pub(super) review: Option<Entity<crate::git::window::review::PrReview>>,
    /// The All changes row has the cursor (the scope is the whole PR).
    pub(super) pr_all: bool,
    /// The scope last handed to the review (its commits; none: all changes).
    pub(super) pr_scope: Vec<String>,
    pub(super) pr_subs: Vec<gpui_kit::Subscription>,
    /// The PR pick's rows as last shown (tests).
    pub pr_pick_rows: Vec<crate::factory::PickRow>,
    /// Where the `PR ⌄` chip was when its pick was asked: the pick opens under it.
    pub(super) pr_anchor: Option<crate::kit::Anchor>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PendingCursor {
    None,
    First,
    Hash(String),
}

impl LogTab {
    // ---- loading ---------------------------------------------------------------------------

    /// Loads the log for the current filters (see [`Reload`]).
    pub fn reload(&mut self, how: Reload, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        if how != Reload::Refresh {
            self.model.reset_listing(how == Reload::Forget);
            if self.pending_cursor == PendingCursor::None {
                self.pending_cursor = PendingCursor::First;
            }
        }
        self.load_gen += 1;
        self.refreshing = how == Reload::Refresh && !self.model.is_empty();
        let generation = self.load_gen;
        self.loading = true;
        self.rows_painted_at = None;
        self.load_started_at = Some(Instant::now());
        self.first_snapshot_at = None;
        let opts = LogOptions {
            limit: None,
            graph: self.graph_opts.clone(),
            intellisort: self.intellisort,
        };
        let mut stream = crate::git::log::stream(root.clone(), self.filters.clone(), opts);
        if self.me.is_none() {
            let root = root.clone();
            cx.spawn(async move |this, cx| {
                let me = cx
                    .update(|cx| {
                        crate::git::job::spawn(cx, move || crate::git::log::me_blocking(&root))
                    })
                    .await;
                let _ = this.update(cx, |t, cx| {
                    t.me = Some(me);
                    t.table.measured_for = None;
                    cx.notify();
                });
            })
            .detach();
        }
        self.load_task = Some(cx.spawn(async move |this, cx| {
            while let Some(snap) = stream.next().await {
                let done = snap.done;
                let ok = this
                    .update(cx, |t, cx| {
                        if t.load_gen == generation {
                            t.apply_snapshot(snap, cx);
                        }
                    })
                    .is_ok();
                if done || !ok {
                    break;
                }
            }
        }));
        cx.notify();
    }

    fn apply_snapshot(&mut self, snap: LogSnapshot, cx: &mut Context<Self>) {
        if self.first_snapshot_at.is_none() {
            self.first_snapshot_at = Some(Instant::now());
        }
        if self.refreshing && !snap.done {
            return;
        }
        self.refreshing = false;
        self.loading = !snap.done;
        self.error = snap.error.clone();
        let before = self.model.details_target();
        self.model.set_snapshot(&snap);
        let pending = std::mem::replace(&mut self.pending_cursor, PendingCursor::None);
        match pending {
            PendingCursor::First => {
                self.model.move_to(0);
                self.scroll.scroll_to_item(0, gpui_kit::ScrollStrategy::Top);
            }
            PendingCursor::Hash(h) => match self.model.index_of(&h) {
                Some(ix) => {
                    self.model.move_to(ix);
                    self.reveal_cursor();
                }
                // not listed yet: wait for the next snapshot (or show it by its hash)
                None if !snap.done => self.pending_cursor = PendingCursor::Hash(h),
                None => self.show_commit_by_hash(h, cx),
            },
            PendingCursor::None => {}
        }
        self.table.measured_for = None;
        if self.model.details_target() != before || snap.done {
            self.details_follow(snap.done, cx);
        }
        if self.filters.lines.is_some() {
            self.show_change_soon(cx);
        }
        cx.notify();
    }

    /// The details pane shows the selection / cursor commit. `refresh`: the same commit may
    /// have moved branches.
    pub(super) fn details_follow(&mut self, refresh: bool, cx: &mut Context<Self>) {
        let target = self.model.details_target();
        let commits = match &target {
            DetailsTarget::Many(_) => self.model.selection().into_iter().cloned().collect(),
            // its refs (the details' branch / tag labels)
            DetailsTarget::One(h) => self
                .model
                .commits
                .iter()
                .find(|c| c.hash == *h)
                .cloned()
                .into_iter()
                .collect(),
            DetailsTarget::None => Vec::new(),
        };
        self.details
            .update(cx, |d, cx| d.show(target, commits, refresh, cx));
    }

    // ---- filters ---------------------------------------------------------------------------

    /// Replaces the filters: the log reloads (cursor on the first row), the tab's label follows,
    /// Lua keeps them for the session.
    pub fn set_filters(&mut self, filters: LogFilters, cx: &mut Context<Self>) {
        let forget = filters.lines.is_some() && self.filters.lines != filters.lines;
        self.filters = filters;
        self.filter_reloads += 1;
        self.reload(
            if forget {
                Reload::Forget
            } else {
                Reload::Filters
            },
            cx,
        );
        self.save_state(cx);
        cx.notify();
    }

    /// Changes the filters (no-op when nothing changed).
    pub fn update_filters(&mut self, f: impl FnOnce(&mut LogFilters), cx: &mut Context<Self>) {
        let mut filters = self.filters.clone();
        f(&mut filters);
        if filters != self.filters {
            self.set_filters(filters, cx);
        }
    }

    /// Backspace: every filter off, the branch HEAD (was Lua `git/init.lua` `clear_filters`).
    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        if self.filters.lines.is_some() {
            return;
        }
        // Lua `clear_filters`: `set_filters({})`, the field's toggles too
        self.update_filters(|f| *f = LogFilters::default(), cx);
    }

    /// The filters (during Show History for Selection: the ones it goes back to) and the details
    /// width for the session (`config/app/git.lua` `log_state`).
    pub(super) fn save_state(&self, cx: &App) {
        let f = self.history.saved_filters().unwrap_or(&self.filters);
        let width = self.split.read(cx).size().as_f32();
        self.gcx.scx.call(
            "config.app.git",
            "log_state",
            vec![Value::Map(vec![
                ("filters".into(), filters_to_lua(f)),
                ("details_width".into(), (width.round() as i64).into()),
                ("intellisort".into(), self.intellisort.into()),
                (
                    "text_history".into(),
                    Value::Array(
                        self.filter_ui
                            .text_history
                            .iter()
                            .map(|t| Value::from(t.as_str()))
                            .collect(),
                    ),
                ),
            ])],
        );
    }

    /// Session restore (`open` event): filters, details width, IntelliSort, text history.
    pub fn restore(&mut self, state: Value, cx: &mut Context<Self>) {
        // only before the first open: later opens bring back what this tab sent itself, older
        // than its live state (a history for a selection, a custom date range)
        if self.opened_once {
            return;
        }
        // (a bad payload is logged once and restores nothing)
        let state: LogState = crate::nvim::lua::decode("git", state).unwrap_or_default();
        if let Some(f) = &state.filters {
            let mut filters = filters_from_lua(f);
            // the PR under review is this tab's, never the session's (it may be set already)
            filters.pr = self.filters.pr.clone();
            if filters != self.filters {
                self.filters = filters;
                self.model.reset_listing(false);
                self.pending_cursor = PendingCursor::First;
            }
        }
        if let Some(w) = state.details_width {
            self.split.update(cx, |s, cx| s.set_size(px(w as f32), cx));
        }
        if let Some(on) = state.intellisort {
            self.intellisort = on;
        }
        if let Some(mut h) = state.text_history {
            h.truncate(filters::TEXT_HISTORY_MAX);
            self.filter_ui.text_history = h;
        }
        cx.notify();
    }

    // ---- cursor & selection ----------------------------------------------------------------

    pub(super) fn reveal_cursor(&self) {
        if let Some(c) = self.model.cursor() {
            self.scroll
                .scroll_to_item(c, gpui_kit::ScrollStrategy::Nearest);
        }
    }

    /// The cursor / selection moved: scroll it into view, the details follow.
    pub(super) fn cursor_moved(&mut self, cx: &mut Context<Self>) {
        self.table.restore_scroll.set(None);
        if self.model.cursor().is_some() && !self.pr_all {
            self.reveal_cursor();
        }
        self.details_follow(false, cx);
        self.pr_follow_scope(cx);
        if self.filters.lines.is_some() {
            self.show_change_soon(cx);
        }
        cx.notify();
    }

    /// Rows a page holds (PageUp / PageDown).
    fn page_rows(&self) -> isize {
        let h = self.scroll.0.borrow().base_handle.bounds().size.height;
        ((h / px(look::VCS_LOG_ROW_HEIGHT.get())).floor() as isize - 1).max(1)
    }

    /// The table has the keyboard (not the text field, a popup or the details tree).
    pub fn table_focused(&self, window: &Window) -> bool {
        self.gcx.view_focus().is_focused(window)
    }

    pub(super) fn focus_table(&self, window: &mut Window, cx: &mut App) {
        self.gcx.focus_view(window, cx);
    }

    /// The header's tab for the changed files pane ("Commit 1a2b3c4d", "3 Commits"; Alt+Cmd+arrows
    /// stop there): None while the pane isn't shown or has no commit.
    pub fn files_label(&self) -> Option<SharedString> {
        if !self.details_shown || self.filters.lines.is_some() || self.filters.pr.is_some() {
            return None;
        }
        let sel = self.model.selection();
        if sel.len() > 1 {
            return Some(format!("{} Commits", sel.len()).into());
        }
        let c = self.model.current()?;
        Some(format!("Commit {}", c.short()).into())
    }

    /// The changed files pane has the keyboard.
    pub fn files_focused(&self, window: &Window, cx: &App) -> bool {
        self.details.read(cx).is_focused(window, cx) || self.pr_files_focused(window, cx)
    }

    /// Alt+Cmd+arrows / a click on the files tab: the changed files take the keyboard.
    pub(super) fn focus_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.filters.pr.is_some() && self.reviewing(cx) {
            self.focus_pr_files(window, cx);
        } else if self.details_shown {
            self.details.update(cx, |d, cx| d.focus(window, cx));
        }
    }

    /// [`Self::focus_files`] after the next render (the tab was hidden: the pane isn't drawn).
    pub(super) fn focus_files_when_drawn(&mut self, cx: &mut Context<Self>) {
        self.focus_files_soon = true;
        cx.notify();
    }

    /// Enter / ä: into the changed files (Show History for Selection: into the lines' diff).
    fn enter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.filters.lines.is_some() {
            self.show_change(true, cx);
            return;
        }
        if !self.details_shown {
            return;
        }
        self.details.update(cx, |d, cx| d.focus(window, cx));
    }

    /// Cmd+C: the full messages of the selected commits (newest first), else the cursor's.
    pub fn copy_messages(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let commits: Vec<(String, String)> = self
            .model
            .selection_or_current()
            .into_iter()
            .map(|c| (c.hash.clone(), c.subject.clone()))
            .collect();
        if commits.is_empty() {
            return;
        }
        let n = commits.len();
        let task = crate::git::job::spawn(cx, move || {
            let refs: Vec<(&str, &str)> = commits
                .iter()
                .map(|(h, s)| (h.as_str(), s.as_str()))
                .collect();
            crate::git::log::messages_blocking(&root, &refs)
        });
        let scx = self.gcx.scx.clone();
        cx.spawn_in(window, async move |_, cx| {
            let text = task.await;
            cx.update(|window, cx| {
                cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
                let msg = if n == 1 {
                    "Copied commit message".to_string()
                } else {
                    format!("Copied {n} commit messages")
                };
                scx.notify(popups::Balloon::info("Git", msg), window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Where keyboard menus open: below the cursor's row (window coordinates).
    pub(super) fn cursor_anchor(&self, window: &Window) -> Anchor {
        match self.table.row_bounds(self.model.cursor()) {
            Some(b) => Anchor::Below(b),
            None => Anchor::Point(window.mouse_position()),
        }
    }

    // ---- keys ------------------------------------------------------------------------------

    fn table_key(
        &mut self,
        key: &str,
        ev: &KeyDownEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.vim.prefix().is_none() && self.pr_table_key(key, w, cx) {
            return true;
        }
        let (key, n) = match self.vim.feed(key, "ydr") {
            Step::Pending => {
                if self.vim.prefix() == Some('d') {
                    self.wait_for_dd(w, cx);
                }
                return true;
            }
            Step::Cmd(c) => {
                self.vim_cmd(c, w, cx);
                return true;
            }
            Step::First => ("<Home>", 1),
            Step::Last => ("<End>", 1),
            // `d` then another key: the `d` was the Date filter (nvim runs a map whose longer
            // twin didn't come); the other key is dropped
            Step::Key {
                cancelled: Some('d'),
                ..
            } => {
                self.d_wait = None;
                self.open_filter(filters::FilterKind::Date, None, w, cx);
                return true;
            }
            Step::Key { key, count, .. } => (key, count as isize),
        };
        let page = self.page_rows();
        let moved = match key {
            "<C-d>" => self.model.move_by(page / 2),
            "<C-u>" => self.model.move_by(-page / 2),
            "<C-f>" => self.model.move_by(page),
            "<C-b>" => self.model.move_by(-page),
            "l" | "<Up>" => self.model.move_by(-n),
            "ö" | "<Down>" => self.model.move_by(n),
            "<PageUp>" => self.model.move_by(-page),
            "<PageDown>" => self.model.move_by(page),
            "<Home>" => self.model.move_to(0),
            "<End>" => self.model.move_to(usize::MAX),
            // his nvim L / Ö: five rows (held Space selects the ones passed)
            "L" => self.model.move_by(-5 * n),
            "Ö" => self.model.move_by(5 * n),
            "<S-Up>" => self.model.extend(-1),
            "<S-Down>" => self.model.extend(1),
            "<S-PageUp>" => {
                let to = self.model.cursor().unwrap_or(0) as isize - page;
                self.model.extend_to(to.max(0) as usize)
            }
            "<S-PageDown>" => {
                let to = self.model.cursor().unwrap_or(0) as isize + page;
                self.model.extend_to(to as usize)
            }
            "<Space>" | "<S-Space>" => self.model.space_down(ev.is_held),
            _ => {
                return match key {
                    // Lua: v / V + move select the commits passed (the Log was a buffer)
                    "v" | "V" => {
                        self.visual = match self.visual {
                            Some(_) => None,
                            None => self.model.cursor(),
                        };
                        if let Some(a) = self.visual {
                            self.model.select_drag(a, a);
                            self.cursor_moved(cx);
                        }
                        true
                    }
                    "<Esc>" if self.visual.is_some() => {
                        self.visual = None;
                        true
                    }
                    "<Esc>" => {
                        if self.model.clear_selection() {
                            self.cursor_moved(cx);
                            true
                        } else if self.filters.lines.is_some() {
                            self.close_selection_history(w, cx);
                            true
                        } else {
                            false
                        }
                    }
                    "<CR>" | "ä" | "<Right>" => {
                        self.enter(w, cx);
                        true
                    }
                    "<Tab>" | "<S-Tab>" => {
                        if self.details_shown {
                            self.details.update(cx, |d, cx| d.focus(w, cx));
                        }
                        true
                    }
                    "<D-c>" => {
                        self.copy_messages(w, cx);
                        true
                    }
                    "<M-CR>" => {
                        let anchor = self.cursor_anchor(w);
                        self.commit_menu(anchor, w, cx);
                        true
                    }
                    "<D-CR>" => {
                        let anchor = self.cursor_anchor(w);
                        self.context_menu(anchor, w, cx);
                        true
                    }
                    _ => self.common_key(key, w, cx),
                };
            }
        };
        if moved {
            if let (Some(a), Some(c)) = (self.visual, self.model.cursor()) {
                self.model.select_drag(a, c);
            }
            self.cursor_moved(cx);
        }
        true
    }

    /// A lone `d`: the Date filter after [`D_TIMEOUT`] unless a key came meanwhile (nvim's
    /// `timeoutlen` for a map with a longer twin: `d` filter, `dd` drop).
    fn wait_for_dd(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.d_wait = Some(cx.spawn_in(w, async move |this, cx| {
            cx.background_executor().timer(D_TIMEOUT).await;
            let _ = this.update_in(cx, |t, w, cx| {
                t.d_wait = None;
                if t.vim.prefix() == Some('d') {
                    t.vim.reset();
                    t.open_filter(filters::FilterKind::Date, None, w, cx);
                }
            });
        }));
    }

    /// The table's doubled keys: `yy` Copy Hash, `rr` Reword… / `dd` Drop Commit (unpushed
    /// only, like the menus), `g?` help.
    fn vim_cmd(&mut self, cmd: kit::Cmd, w: &mut Window, cx: &mut Context<Self>) {
        self.d_wait = None;
        match cmd {
            kit::Cmd::Yank => self.copy_hash_key(w, cx),
            kit::Cmd::Rename => self.unpushed_key(true, w, cx),
            kit::Cmd::Delete => self.unpushed_key(false, w, cx),
            kit::Cmd::Help => help(w, cx),
        }
    }

    /// Keys of the table and the details tree (Lua `log_keys` + `common_keys`).
    pub(super) fn common_key(&mut self, key: &str, w: &mut Window, cx: &mut Context<Self>) -> bool {
        match key {
            "c" => self.checkout_popup(w, cx),
            "/" => self.focus_text_filter(w, cx),
            "b" => self.open_filter(filters::FilterKind::Branch, None, w, cx),
            "u" => self.open_filter(filters::FilterKind::User, None, w, cx),
            "d" => self.open_filter(filters::FilterKind::Date, None, w, cx),
            "p" => self.open_filter(filters::FilterKind::Paths, None, w, cx),
            "<BS>" => self.clear_filters(cx),
            "R" => self.refresh_now(cx),
            _ => return false,
        }
        true
    }

    /// R / the toolbar's Refresh: the log, branches and details reload.
    pub fn refresh_now(&mut self, cx: &mut Context<Self>) {
        self.reload(Reload::Refresh, cx);
        self.reload_branches(cx);
    }

    fn on_details_event(
        &mut self,
        ev: &details::DetailsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            details::DetailsEvent::Back => self.focus_table(window, cx),
            // Esc in the files: closes a history for a selection first (Lua common_keys)
            details::DetailsEvent::Leave => {
                if self.filters.lines.is_some() {
                    self.close_selection_history(window, cx);
                } else {
                    self.gcx.scx.call("config.app.git", "leave", vec![]);
                }
            }
            details::DetailsEvent::FileHistory(path) => self.file_history(path.clone(), window, cx),
            details::DetailsEvent::Help => help(window, cx),
        }
    }

    /// The table painted rows of the current load (timing, tests).
    pub(super) fn rows_painted(&mut self) {
        if self.rows_painted_at.is_none() && !self.model.is_empty() {
            self.rows_painted_at = Some(Instant::now());
            if let Some(at) = self.time_rows.take() {
                let ms = at.elapsed().as_secs_f64() * 1000.;
                app::mark(&format!("git: Cmd+3 -> log rows painted {ms:.1} ms"));
            }
        }
    }
}

impl GitTab for LogTab {
    const ID: TabId = TabId::Log;

    fn new(gcx: GitCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let split = cx.new(|_| {
            SplitState::new(SplitAxis::Horizontal, Fixed::Second, px(DETAILS_DEFAULT))
                .with_min(px(LOG_MIN), px(DETAILS_MIN))
        });
        let details = cx.new(|cx| details::DetailsPane::new(gcx.clone(), window, cx));
        let subs = vec![
            // the splitter measures itself after layout: draw again with its length
            cx.observe(&split, |_, _, cx| cx.notify()),
            cx.subscribe(&split, |t: &mut LogTab, _, _: &SplitEvent, cx| {
                t.save_state(cx);
            }),
            cx.subscribe_in(
                &details,
                window,
                |t: &mut LogTab, _, ev: &details::DetailsEvent, window, cx| {
                    t.on_details_event(ev, window, cx)
                },
            ),
        ];
        let filter_ui = filters::FilterUi::new(window, cx);
        let branches = branches::BranchesUi::new(window, cx);
        LogTab {
            gcx,
            model: LogModel::default(),
            filters: LogFilters::default(),
            me: None,
            loading: false,
            error: None,
            load_task: None,
            load_gen: 0,
            pending_cursor: PendingCursor::First,
            graph_opts: GraphOptions::default(),
            intellisort: false,
            scroll: UniformListScrollHandle::new(),
            split,
            details_shown: true,
            focus_files_soon: false,
            details,
            filter_ui,
            branches,
            actions: actions::ActionsUi::default(),
            history: history::HistoryUi::default(),
            table: table::TableUi::default(),
            vim: Vim::default(),
            d_wait: None,
            visual: None,
            refreshes: Vec::new(),
            filter_reloads: 0,
            commands: Vec::new(),
            shown: false,
            time_rows: None,
            rows_painted_at: None,
            opened_once: false,
            stale: false,
            refreshing: false,
            load_started_at: None,
            first_snapshot_at: None,
            _subs: subs,
            review: None,
            pr_all: false,
            pr_scope: Vec::new(),
            pr_subs: Vec::new(),
            pr_pick_rows: Vec::new(),
            pr_anchor: None,
        }
    }

    fn label(&self, cx: &App) -> SharedString {
        if let Some(n) = self.pr_number(cx) {
            return format!("Log: PR #{n}").into();
        }
        // a long branch name is cut like Lua's (24 cells + "…"): the other tabs stay visible
        let label = self.filters.branch.tab_label();
        if label.chars().count() > LABEL_MAX + 5 {
            let cut: String = label.chars().take(LABEL_MAX + 5 - 1).collect();
            format!("{cut}…").into()
        } else {
            label.into()
        }
    }

    fn on_key(
        &mut self,
        key: &str,
        ev: &KeyDownEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        // ,q / ,w close the history for a selection (else nvim's)
        if (key == ",q" || key == ",w") && self.filters.lines.is_some() {
            self.close_selection_history(w, cx);
            return true;
        }
        if self.table_focused(w) {
            return self.table_key(key, ev, w, cx);
        }
        if self.details.read(cx).is_focused(w, cx) {
            return match key {
                "<Tab>" | "<S-Tab>" => {
                    self.focus_table(w, cx);
                    true
                }
                // (`g?` is the files tree's: DetailsEvent::Help)
                _ => self.common_key(key, w, cx),
            };
        }
        // the text field / a popup: their typed keys bubble here; never act on them
        false
    }

    fn text_input_focused(&self, w: &Window, cx: &App) -> bool {
        self.pr_typing(w, cx)
            || self
                .filter_ui
                .search
                .read(cx)
                .field()
                .read(cx)
                .focus_handle(cx)
                .contains_focused(w, cx)
    }

    fn on_key_up(&mut self, key: &str, _w: &mut Window, cx: &mut Context<Self>) {
        if key == "<Space>" && self.model.holding() {
            self.model.space_up();
            cx.notify();
        }
    }

    fn on_lua(&mut self, payload: Value, _w: &mut Window, cx: &mut Context<Self>) {
        // vimstorm.git_log {event = "change_shown"}: Lua opened the lines' diff
        if map_get(&payload, "event").and_then(Value::as_str) == Some("change_shown") {
            self.history.diff_opened = true;
            cx.notify();
        }
    }

    fn refresh(&mut self, why: RepoChange, _w: &mut Window, cx: &mut Context<Self>) {
        self.refreshes.push(why);
        if why == RepoChange::Opened {
            self.opened_once = true;
        }
        if !self.shown {
            // reloaded when shown again (Lua refreshed the shown tab only)
            self.stale = true;
            return;
        }
        self.stale = false;
        let how = if why == RepoChange::Opened && self.model.is_empty() {
            Reload::Filters
        } else {
            Reload::Refresh
        };
        self.reload(how, cx);
        self.reload_branches(cx);
        cx.notify();
    }

    fn command(&mut self, cmd: &GitCommand, w: &mut Window, cx: &mut Context<Self>) {
        self.commands.push(cmd.clone());
        match cmd {
            GitCommand::FileHistory { path } => self.file_history(path.clone(), w, cx),
            GitCommand::ShowCommit { hash } => self.show_commit(hash.clone(), w, cx),
            GitCommand::ShowRange { rev } => {
                let branch = BranchFilter::Ref(rev.clone());
                self.update_filters(|f| f.branch = branch, cx)
            }
            GitCommand::SelectionHistory(lines) => self.selection_history(lines.clone(), w, cx),
            _ => {}
        }
        cx.notify();
    }

    fn shown(&mut self, shown: bool, _w: &mut Window, cx: &mut Context<Self>) {
        self.shown = shown;
        if shown && std::mem::take(&mut self.stale) {
            let how = if self.model.is_empty() {
                Reload::Filters
            } else {
                Reload::Refresh
            };
            self.reload(how, cx);
            self.reload_branches(cx);
        }
        if !shown {
            // an open filter popup goes with the tab
            self.filter_ui.popup = None;
            let base = self.scroll.0.borrow().base_handle.clone();
            let h = base.bounds().size.height;
            if h > px(0.) {
                self.table.restore_scroll.set(Some((base.offset().y, h)));
            }
        }
        if shown && let Some(at) = take_open_key() {
            self.time_rows = Some(at);
        }
        cx.notify();
    }
}

impl Render for LogTab {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.focus_files_soon) {
            let this = cx.entity().downgrade();
            window.defer(cx, move |window, cx| {
                let _ = this.update(cx, |l, cx| l.focus_files(window, cx));
            });
        }
        let bar = self.render_filter_bar(window, cx);
        let table = self.render_table(window, cx);
        let focused = self.table_focused(window) && crate::editor::window_active(window);
        let all_row = self.render_pr_all_row(focused, cx);
        let log: AnyElement = div()
            .size_full()
            .flex()
            .flex_col()
            .child(bar)
            .children(all_row)
            .child(div().flex_1().min_h(px(0.)).child(table))
            .into_any_element();
        let pr_files = self
            .review
            .clone()
            .filter(|r| self.filters.pr.is_some() || r.read(cx).attached());
        let body = match pr_files {
            Some(files) => crate::kit::split("git-log-split", &self.split, log, files, cx),
            None if self.details_shown => {
                crate::kit::split("git-log-split", &self.split, log, self.details.clone(), cx)
            }
            None => log,
        };
        let strip = self.render_pr_strip(cx);
        let branches = self.render_branches(window, cx);
        div()
            .id("git-log-tab")
            .size_full()
            .flex()
            .flex_col()
            .font(ui_font())
            .text_size(px(look::VCS_LOG_FONT_SIZE))
            .text_color(look::TEXT)
            .children(strip)
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .w_full()
                    .flex()
                    .flex_row()
                    .child(branches)
                    .child(div().flex_1().min_w(px(0.)).h_full().child(body)),
            )
    }
}

// ---- timing ----------------------------------------------------------------------------------

/// Cmd+3 -> the Log's first rows (`VIMSTORM_TIMING`): set by [`crate::git::window::key_pressed`].
static OPEN_KEY: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// `g?`: the Log's keys.
fn help(w: &mut Window, cx: &mut App) {
    popups::notify(popups::Balloon::info("Git", HELP), w, cx);
}

pub(crate) fn set_open_key(at: Instant) {
    *OPEN_KEY.lock().unwrap_or_else(|e| e.into_inner()) = Some(at);
}

fn take_open_key() -> Option<Instant> {
    OPEN_KEY.lock().unwrap_or_else(|e| e.into_inner()).take()
}

// ---- session values --------------------------------------------------------------------------

pub(super) use crate::nvim::get as map_get;

pub use details::DetailsPane;
pub use model::DetailsTarget;
pub use table::{GRAPH_LEFT, SUBJECT_GAP, ref_icons};

/// The Log tab's saved state (`config/app/git.lua` keeps it in the session; the `open` event).
#[derive(Debug, Default, serde::Deserialize)]
struct LogState {
    /// [`filters_from_lua`]'s shape (read leniently: one bad field doesn't drop the rest).
    #[serde(default)]
    filters: Option<Value>,
    #[serde(default)]
    details_width: Option<f64>,
    #[serde(default)]
    intellisort: Option<bool>,
    #[serde(default)]
    text_history: Option<Vec<String>>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The Lua `GitFilters` table (`git/log.lua`): text, regex, case, branch, authors, paths, date.
pub fn filters_to_lua(f: &LogFilters) -> Value {
    let mut m: Vec<(Value, Value)> = vec![
        ("branch".into(), f.branch.arg().into()),
        (
            "authors".into(),
            Value::Array(f.authors.iter().map(|a| a.as_str().into()).collect()),
        ),
        (
            "paths".into(),
            Value::Array(f.paths.iter().map(|a| a.as_str().into()).collect()),
        ),
    ];
    if let Some(t) = &f.text {
        m.push(("text".into(), t.as_str().into()));
    }
    if f.regex {
        m.push(("regex".into(), true.into()));
    }
    if f.match_case {
        m.push(("case".into(), true.into()));
    }
    match &f.date {
        Some(DateFilter::Range { since, until }) => {
            if let Some(v) = since {
                m.push(("date_since".into(), v.as_str().into()));
            }
            if let Some(v) = until {
                m.push(("date_until".into(), v.as_str().into()));
            }
        }
        Some(d) => {
            if let Some(id) = d.id() {
                m.push(("date".into(), id.into()));
            }
        }
        None => {}
    }
    if f.follow {
        m.push(("follow".into(), true.into()));
    }
    Value::Map(m)
}

pub fn filters_from_lua(v: &Value) -> LogFilters {
    let s = |k| map_get(v, k).and_then(Value::as_str).map(str::to_owned);
    let b = |k| map_get(v, k).and_then(Value::as_bool).unwrap_or(false);
    LogFilters {
        text: s("text").filter(|t| !t.is_empty()),
        regex: b("regex"),
        match_case: b("case"),
        branch: s("branch")
            .map(|b| BranchFilter::from_lua(&b))
            .unwrap_or_default(),
        authors: strings(map_get(v, "authors")),
        paths: strings(map_get(v, "paths")),
        date: s("date").and_then(|d| DateFilter::from_id(&d)).or_else(|| {
            let (since, until) = (s("date_since"), s("date_until"));
            (since.is_some() || until.is_some()).then_some(DateFilter::Range { since, until })
        }),
        follow: b("follow"),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_round_trip_through_lua_values() {
        let f = LogFilters {
            text: Some("100%".into()),
            regex: true,
            branch: BranchFilter::Ref("factory/1".into()),
            authors: vec!["Ada Example".into(), "Max".into()],
            date: Some(DateFilter::Last7Days),
            paths: vec!["blame.ts".into()],
            ..Default::default()
        };
        assert_eq!(filters_from_lua(&filters_to_lua(&f)), f);
        let custom = LogFilters {
            date: Some(DateFilter::Range {
                since: Some("2026-01-31".into()),
                until: None,
            }),
            ..LogFilters::file_history("a/b.ts")
        };
        assert_eq!(filters_from_lua(&filters_to_lua(&custom)), custom);
        let all = LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        };
        assert_eq!(filters_from_lua(&filters_to_lua(&all)), all);
    }
}
