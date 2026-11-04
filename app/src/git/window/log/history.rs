//! File history (`,H` / Show History for File), Show History for Selection (WS
//! Vcs.ShowHistoryForBlock: `git log -L`, the list + each commit's diff of the lines following the
//! cursor) and show commit (from annotate). Lua `git/init.lua`'s `file_history`,
//! `selection_history`, `show_change(_soon)`, `close_selection_history`, `show_commit` (today's
//! Lua side: `config/app/git_log.lua`).
//!
//! The lines' diff is Lua's (`config/app/git_log.lua` `show_change` -> `git.diff`); it tells the
//! tab back (`vimstorm.git_log {event = "change_shown"}`) so closing the history closes it.

use std::time::Duration;

use gpui_kit::{Context, Task, Window};
use rmpv::Value;

use super::{LogTab, PendingCursor, Reload};
use crate::git::log::{LineRange, LogFilters};
use crate::git::window::LinesRequest;

/// Moving through the history list: the lines' diff follows once the cursor rests (held keys
/// don't run git per row), as Lua's 80 ms timer.
const CHANGE_DELAY: Duration = Duration::from_millis(80);

#[derive(Default)]
pub struct HistoryUi {
    /// Show History for Selection is on: what to go back to.
    saved: Option<Saved>,
    /// The Lines chip's text ("blame.ts:3-4").
    label: Option<String>,
    /// Lua opened the lines' diff (closing the history closes it).
    pub diff_opened: bool,
    change_timer: Option<Task<()>>,
    /// The commit whose change the diff shows now.
    shown_change: Option<String>,
}

struct Saved {
    filters: LogFilters,
    /// The tab shown before (None: the tool window was hidden).
    tab: Option<String>,
}

impl HistoryUi {
    /// During Show History for Selection: the filters it goes back to (the session keeps those).
    pub fn saved_filters(&self) -> Option<&LogFilters> {
        self.saved.as_ref().map(|s| &s.filters)
    }

    /// The Lines chip's text while Show History for Selection is on.
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }
}

impl LogTab {
    /// The log filtered to one file through renames (WS Show History; Lua `file_history`).
    pub fn file_history(&mut self, path: String, _w: &mut Window, cx: &mut Context<Self>) {
        self.history = HistoryUi::default();
        self.pending_cursor = PendingCursor::First;
        self.set_filters(LogFilters::file_history(path), cx);
    }

    /// The log (no filters) with a commit selected; not listed: filtered by its hash.
    pub fn show_commit(&mut self, hash: String, _w: &mut Window, cx: &mut Context<Self>) {
        self.history = HistoryUi::default();
        self.pending_cursor = PendingCursor::Hash(hash);
        if self.filters != LogFilters::default() {
            self.set_filters(LogFilters::default(), cx);
        } else {
            self.reload(Reload::Filters, cx);
        }
    }

    /// The last snapshot didn't list the commit: filter by its hash (once).
    pub(super) fn show_commit_by_hash(&mut self, hash: String, cx: &mut Context<Self>) {
        if self.filters.text.as_deref() == Some(hash.as_str()) {
            return;
        }
        let filters = LogFilters {
            text: Some(hash.clone()),
            ..Default::default()
        };
        self.pending_cursor = PendingCursor::Hash(hash);
        self.set_filters(filters, cx);
    }

    /// `,H`: the commits that touched the lines (at HEAD), newest first; the newest one's diff of
    /// the lines opens in the editor.
    pub fn selection_history(
        &mut self,
        req: LinesRequest,
        _w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.history.saved.is_none() {
            self.history.saved = Some(Saved {
                filters: self.filters.clone(),
                tab: req.tab.clone(),
            });
        }
        self.history.label = Some(req.label.clone());
        self.history.shown_change = None;
        self.pending_cursor = PendingCursor::First;
        self.set_filters(
            LogFilters {
                lines: Some(LineRange {
                    path: req.path,
                    from: req.from,
                    to: req.to,
                }),
                ..Default::default()
            },
            cx,
        );
    }

    /// The cursor commit's change to the lines in the editor's diff (`enter`: and focus it).
    pub(super) fn show_change(&mut self, enter: bool, cx: &mut Context<Self>) {
        let Some(c) = self.model.current() else {
            return;
        };
        let Some(change) = c.change.as_ref().filter(|ch| !ch.path.is_empty()) else {
            return;
        };
        if !enter && self.history.shown_change.as_deref() == Some(c.hash.as_str()) {
            return;
        }
        self.history.shown_change = Some(c.hash.clone());
        let mut m: Vec<(Value, Value)> = vec![
            ("hash".into(), c.hash.as_str().into()),
            ("path".into(), change.path.as_str().into()),
            ("added".into(), change.added.into()),
            ("line".into(), (change.line as i64).into()),
        ];
        if let Some(old) = &change.old_path {
            m.push(("old_path".into(), old.as_str().into()));
        }
        self.gcx.scx.navigate(
            "config.app.git_log",
            "show_change",
            vec![Value::Map(m), enter.into()],
        );
        cx.notify();
    }

    /// Moving through the history: the diff follows once the cursor rests.
    pub(super) fn show_change_soon(&mut self, cx: &mut Context<Self>) {
        if self.filters.lines.is_none() || !self.shown {
            return;
        }
        let timer = cx.background_executor().timer(CHANGE_DELAY);
        self.history.change_timer = Some(cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |t, cx| {
                if t.filters.lines.is_some() {
                    t.show_change(false, cx);
                }
            });
        }));
    }

    /// Esc / `,q` / the Lines chip's ×: the log as it was (the tool window hidden again if it
    /// was), the lines' diff closed, back in the editor.
    pub fn close_selection_history(&mut self, _w: &mut Window, cx: &mut Context<Self>) {
        if self.filters.lines.is_none() {
            return;
        }
        let saved = self.history.saved.take();
        let diff = std::mem::take(&mut self.history.diff_opened);
        self.history = HistoryUi::default();
        let (filters, tab) = match saved {
            Some(s) => (s.filters, s.tab),
            None => (LogFilters::default(), Some("log".to_string())),
        };
        self.set_filters(filters, cx);
        self.gcx.scx.call(
            "config.app.git_log",
            "close_history",
            vec![tab.map_or(Value::Nil, |t| t.into()), diff.into()],
        );
    }
}
