//! The Log's commit actions and menus (Lua `git/actions.lua` + the Log part of `git/init.lua`'s
//! menu provider), native: Alt+Enter = the cursor commit's actions (title "<hash8> <subject>"),
//! right-click / Cmd+Enter = those + selection, filters, checkout, refresh, hide. Reword /
//! Uncommit / Drop only for unpushed commits on the current branch (`ops::is_unpushed_blocking`,
//! asked off the UI thread before the menu opens), like Lua and WS. WebStorm's log menu adds
//! Checkout Revision, New Branch… and New Tag…. The git side (confirmations, inputs, running git
//! off the UI thread, balloons, `changed()`) lives in `actions_run.rs`.

#[path = "actions_run.rs"]
mod run;

use gpui_kit::{App, Context, Window};

use super::LogTab;
use super::filters::FilterKind;
use crate::factory::Verdict;
use crate::git::log::Commit;
use crate::git::ops;
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::popups::{self, Menu, MenuEntry, MenuItem};

#[derive(Default)]
pub struct ActionsUi {
    /// Bumped per menu request: an unpushed check that comes back after a newer request is
    /// dropped.
    menu_gen: u64,
}

/// The commit a menu was opened on (the log may reload before the choice).
#[derive(Clone, Debug, PartialEq, Eq)]
struct CommitRef {
    hash: String,
    subject: String,
}

impl CommitRef {
    fn of(c: &Commit) -> Self {
        CommitRef {
            hash: c.hash.clone(),
            subject: c.subject.clone(),
        }
    }

    fn short(&self) -> &str {
        &self.hash[..self.hash.len().min(8)]
    }
}

/// A menu row's action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    // the commit's (M4 Lua git/actions.lua `items` + WS)
    CopyHash,
    CherryPick,
    CheckoutRevision,
    Revert,
    Reset,
    Reword,
    Uncommit,
    Drop,
    NewBranch,
    NewTag,
    // the log's (M4 Lua git/init.lua menu provider)
    ToggleSelect,
    ClearSelection,
    ShowChangedFiles,
    CopyMessage,
    FilterText,
    ToggleRegex,
    ToggleCase,
    Filter(FilterKind),
    ClearFilters,
    CheckoutBranch,
    Refresh,
    Hide,
    /// The Branches pane (expanded, keyboard in it).
    ShowBranches,
    // PR review (1.0, G-12: the strip's actions as menu rows)
    /// Approve… / Request Changes… / Comment… / Submit Review: the Submit review dialog.
    PrSubmit(Option<Verdict>),
    PrBrowser,
    /// A lifecycle row of the review core's, by its place (Mark ready, Merge…, Close…).
    PrLifecycle(usize),
    /// Filter by Pull Request…: the PR pick.
    PrPick,
    /// The PR chip's ×.
    PrClear,
}

/// Menu rows and their actions, side by side (separators have none).
#[derive(Default)]
struct Items {
    entries: Vec<MenuEntry>,
    actions: Vec<Option<Action>>,
}

impl Items {
    fn add(&mut self, item: MenuItem, action: Action) {
        self.entries.push(item.into());
        self.actions.push(Some(action));
    }

    fn sep(&mut self) {
        if !self.entries.is_empty() {
            self.entries.push(MenuEntry::Separator);
            self.actions.push(None);
        }
    }

    /// Lua `git/actions.lua` `items` (Lua's order) + WS's Checkout Revision, New Branch…, New
    /// Tag…. Labels in WS's title case like the rest of the menu (Lua: "Cherry-pick", "Revert
    /// commit").
    fn commit(&mut self, unpushed: bool) {
        self.add(
            MenuItem::new("Copy Hash").icon(IconName::Copy),
            Action::CopyHash,
        );
        self.add(
            MenuItem::new("Cherry-Pick").icon(IconName::CherryPick),
            Action::CherryPick,
        );
        self.add(MenuItem::new("Checkout Revision"), Action::CheckoutRevision);
        self.add(
            MenuItem::new("Revert Commit").icon(IconName::Revert),
            Action::Revert,
        );
        self.add(
            MenuItem::new("Reset Current Branch to Here…"),
            Action::Reset,
        );
        if unpushed {
            self.add(MenuItem::new("Reword…"), Action::Reword);
            self.add(MenuItem::new("Uncommit (keep changes)"), Action::Uncommit);
            self.add(MenuItem::new("Drop Commit"), Action::Drop);
        }
        self.sep();
        self.add(
            MenuItem::new("New Branch…").icon(IconName::Add),
            Action::NewBranch,
        );
        self.add(
            MenuItem::new("New Tag…").icon(IconName::Tag),
            Action::NewTag,
        );
    }

    /// The Log part of Lua `git/init.lua`'s menu provider after the commit's items: selection
    /// (when there is a cursor commit), filters, checkout, refresh, hide. Lua's labels and key
    /// hints.
    fn log(&mut self, t: &LogTab, has_commit: bool) {
        if has_commit {
            self.sep();
            let selected = t.model.cursor().is_some_and(|ix| t.model.is_selected(ix));
            let label = if selected {
                "Unselect Commit"
            } else {
                "Select Commit"
            };
            self.add(MenuItem::new(label).shortcut("Space"), Action::ToggleSelect);
            self.add(
                MenuItem::new("Clear Selection")
                    .shortcut("Esc")
                    .enabled(t.model.has_selection()),
                Action::ClearSelection,
            );
            self.add(
                MenuItem::new("Show Changed Files").shortcut("⏎"),
                Action::ShowChangedFiles,
            );
            self.add(
                MenuItem::new("Copy Commit Message").shortcut("⌘C"),
                Action::CopyMessage,
            );
        }
        self.sep();
        self.add(
            MenuItem::new("Filter by Text or Hash…")
                .shortcut("/")
                .icon(IconName::Search),
            Action::FilterText,
        );
        let regex = if t.filters.regex {
            "Text Filter: Plain Text"
        } else {
            "Text Filter: Regex"
        };
        self.add(MenuItem::new(regex), Action::ToggleRegex);
        let case = if t.filters.match_case {
            "Text Filter: Ignore Case"
        } else {
            "Text Filter: Match Case"
        };
        self.add(MenuItem::new(case), Action::ToggleCase);
        for (label, key, kind) in [
            ("Filter by Branch…", "b", FilterKind::Branch),
            ("Filter by User…", "u", FilterKind::User),
            ("Filter by Date…", "d", FilterKind::Date),
            ("Filter by Paths…", "p", FilterKind::Paths),
        ] {
            self.add(MenuItem::new(label).shortcut(key), Action::Filter(kind));
        }
        self.add(
            MenuItem::new("Clear Filters").shortcut("⌫"),
            Action::ClearFilters,
        );
        self.sep();
        self.add(
            MenuItem::new("Checkout Branch…").shortcut("c"),
            Action::CheckoutBranch,
        );
        self.add(MenuItem::new("Show Branches"), Action::ShowBranches);
        self.sep();
        self.add(
            MenuItem::new("Refresh")
                .shortcut("R")
                .icon(IconName::Refresh),
            Action::Refresh,
        );
        self.add(MenuItem::new("Hide").shortcut("⌘J"), Action::Hide);
    }
}

impl Items {
    /// PR review's rows first while a PR is under review (the strip's actions, G-12, then the
    /// PR's lifecycle: Mark ready, Merge…, Close…, grey with why); else Filter by Pull Request….
    fn pr(&mut self, t: &LogTab, cx: &App) {
        let Some(review) = t.review.as_ref().map(|r| r.read(cx)) else {
            return;
        };
        let Some(strip) = review.strip(cx) else {
            self.add(MenuItem::new("Filter by Pull Request…"), Action::PrPick);
            self.sep();
            return;
        };
        let open = strip.can_submit || strip.outdated > 0;
        for (label, verdict) in [
            ("Approve…", Verdict::Approve),
            ("Request Changes…", Verdict::RequestChanges),
            ("Comment…", Verdict::Comment),
        ] {
            self.add(
                MenuItem::new(label).enabled(open),
                Action::PrSubmit(Some(verdict)),
            );
        }
        self.add(
            MenuItem::new(format!("Submit Review ({})…", strip.drafts))
                .enabled(strip.drafts > 0 && strip.can_submit),
            Action::PrSubmit(None),
        );
        self.add(
            MenuItem::new("Open Pull Request in Browser").icon(IconName::ExternalLink),
            Action::PrBrowser,
        );
        self.sep();
        for (ix, row) in review.lifecycle_rows(cx).iter().enumerate() {
            let label = match &row.reason {
                None => row.title.clone(),
                Some(why) => format!("{} · {why}", row.title),
            };
            self.add(
                MenuItem::new(label).enabled(row.reason.is_none()),
                Action::PrLifecycle(ix),
            );
        }
        self.add(MenuItem::new("Clear PR Filter"), Action::PrClear);
        self.sep();
    }
}

/// Lua `strcharpart(hash8 .. " " .. subject, 0, 50)`.
fn menu_title(c: &CommitRef) -> String {
    format!("{} {}", c.short(), c.subject)
        .chars()
        .take(50)
        .collect()
}

impl LogTab {
    /// Alt+Enter: the cursor commit's actions (Lua `git/actions.lua` `menu`).
    pub fn commit_menu(&mut self, anchor: Anchor, w: &mut Window, cx: &mut Context<Self>) {
        self.with_unpushed(w, cx, move |t, c, unpushed, w, cx| {
            let Some(c) = c else {
                return;
            };
            let mut items = Items::default();
            items.commit(unpushed);
            let title = menu_title(&c);
            t.open_items(items, Some(title), anchor, Some(c), w, cx);
        });
    }

    /// Right-click / Cmd+Enter: commit actions + selection + filters + checkout + refresh / hide.
    pub fn context_menu(&mut self, anchor: Anchor, w: &mut Window, cx: &mut Context<Self>) {
        self.with_unpushed(w, cx, move |t, c, unpushed, w, cx| {
            let mut items = Items::default();
            items.pr(t, cx);
            if c.is_some() && !t.pr_all() {
                items.commit(unpushed);
            }
            items.log(t, c.is_some());
            t.open_items(items, None, anchor, c, w, cx);
        });
    }

    /// The cursor commit and whether it's unpushed on the current branch (git off the UI
    /// thread), then `f` on the tab; dropped when another menu was asked for meanwhile.
    fn with_unpushed(
        &mut self,
        w: &mut Window,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut Self, Option<CommitRef>, bool, &mut Window, &mut Context<Self>) + 'static,
    ) {
        self.actions.menu_gen += 1;
        let generation = self.actions.menu_gen;
        let c = self.model.current().map(CommitRef::of);
        let (Some(commit), Some(root)) = (c.clone(), self.gcx.root()) else {
            f(self, c, false, w, cx);
            return;
        };
        let hash = commit.hash.clone();
        let task = crate::git::job::spawn(cx, move || ops::is_unpushed_blocking(&root, &hash));
        cx.spawn_in(w, async move |this, cx| {
            let unpushed = task.await;
            let _ = this.update_in(cx, |t, w, cx| {
                if t.actions.menu_gen == generation {
                    f(t, Some(commit), unpushed, w, cx);
                }
            });
        })
        .detach();
    }

    fn open_items(
        &mut self,
        items: Items,
        title: Option<String>,
        anchor: Anchor,
        c: Option<CommitRef>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut menu = Menu::new(items.entries, anchor);
        if let Some(title) = title {
            menu = menu.title(title);
        }
        let actions = items.actions;
        let this = cx.entity().downgrade();
        popups::open_menu(menu, w, cx, move |choice, w, cx| {
            let Some(action) = choice.and_then(|ix| actions.get(ix).copied().flatten()) else {
                return;
            };
            let _ = this.update(cx, |t, cx| t.run_action(action, c, anchor, w, cx));
        });
    }

    fn run_action(
        &mut self,
        action: Action,
        c: Option<CommitRef>,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            Action::ToggleSelect => {
                if self.model.toggle_current() {
                    self.cursor_moved(cx);
                }
            }
            Action::ClearSelection => {
                if self.model.clear_selection() {
                    self.cursor_moved(cx);
                }
            }
            Action::ShowChangedFiles => self.enter(w, cx),
            Action::CopyMessage => self.copy_messages(w, cx),
            Action::FilterText => self.focus_text_filter(w, cx),
            Action::ToggleRegex => self.update_filters(|f| f.regex = !f.regex, cx),
            Action::ToggleCase => self.update_filters(|f| f.match_case = !f.match_case, cx),
            Action::Filter(kind) => self.open_filter(kind, None, w, cx),
            Action::ClearFilters => self.clear_filters(cx),
            Action::CheckoutBranch => self.checkout_popup(w, cx),
            Action::ShowBranches => self.set_branches_open(true, true, w, cx),
            Action::Refresh => self.refresh_now(cx),
            Action::Hide => self.gcx.scx.call("config.app.git", "hide", vec![]),
            Action::PrSubmit(verdict) => {
                if let Some(review) = self.review.clone() {
                    review.update(cx, |r, cx| r.open_submit(verdict, w, cx));
                }
            }
            Action::PrBrowser => {
                if let Some(url) = self
                    .review
                    .as_ref()
                    .and_then(|r| r.read(cx).strip(cx))
                    .map(|s| s.url)
                {
                    cx.open_url(&url);
                }
            }
            Action::PrLifecycle(ix) => {
                if let Some(review) = self.review.clone() {
                    let id = review
                        .read(cx)
                        .lifecycle_rows(cx)
                        .get(ix)
                        .map(|r| r.id.clone());
                    if let Some(id) = id {
                        review.update(cx, |r, cx| r.run_lifecycle(&id, cx));
                    }
                }
            }
            Action::PrPick => self.open_pr_pick(anchor, w, cx),
            Action::PrClear => self.clear_pr(cx),
            // the menu's commit (its title), as Lua `actions.items(c)`: with Lua's cursor
            // independent of the selection, the selected commits may not include it (the
            // toolbar's Cherry-Pick takes the selection)
            Action::CherryPick => {
                if let Some(c) = c {
                    let hash = c.hash.clone();
                    self.act(move |root| run::cherry_pick_all(root, &[hash]), w, cx);
                }
            }
            Action::CopyHash
            | Action::CheckoutRevision
            | Action::Revert
            | Action::Reset
            | Action::Reword
            | Action::Uncommit
            | Action::Drop
            | Action::NewBranch
            | Action::NewTag => {
                if let Some(c) = c {
                    self.commit_action(action, c, anchor, w, cx);
                }
            }
        }
    }

    fn commit_action(
        &mut self,
        action: Action,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            Action::CopyHash => copy_hash(&c, w, cx),
            Action::CheckoutRevision => {
                let hash = c.hash;
                self.act(
                    move |root| ops::checkout_revision_blocking(root, &hash),
                    w,
                    cx,
                );
            }
            Action::Revert => {
                let hash = c.hash;
                self.act(move |root| ops::revert_blocking(root, &hash), w, cx);
            }
            Action::Reset => self.reset_popup(c, anchor, w, cx),
            Action::Reword => self.reword_popup(c, anchor, w, cx),
            Action::Uncommit => self.uncommit(c, anchor, w, cx),
            Action::Drop => self.drop_commit(c, anchor, w, cx),
            Action::NewBranch => self.new_ref_popup(run::NewRef::Branch, c, anchor, w, cx),
            Action::NewTag => self.new_ref_popup(run::NewRef::Tag, c, anchor, w, cx),
            _ => {}
        }
    }

    /// `yy`: Copy Hash of the cursor commit.
    pub(super) fn copy_hash_key(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(c) = self.model.current().map(CommitRef::of) {
            copy_hash(&c, w, cx);
        }
    }

    /// `rr` / `dd`: Reword… / Drop Commit on the cursor commit, with the menus' rule (unpushed
    /// commits on the current branch only, asked off the UI thread); a pushed one says why not.
    pub(super) fn unpushed_key(&mut self, reword: bool, w: &mut Window, cx: &mut Context<Self>) {
        let anchor = self.cursor_anchor(w);
        self.with_unpushed(w, cx, move |t, c, unpushed, w, cx| {
            let Some(c) = c else {
                return;
            };
            if !unpushed {
                let what = if reword { "reworded" } else { "dropped" };
                let msg = format!("Only unpushed commits of the current branch can be {what}");
                popups::notify(popups::Balloon::info("Git", msg), w, cx);
                return;
            }
            let action = if reword { Action::Reword } else { Action::Drop };
            t.commit_action(action, c, anchor, w, cx);
        });
    }

    /// c: checkout a branch (picker, confirm).
    pub fn checkout_popup(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let anchor = self.cursor_anchor(w);
        self.checkout_menu(anchor, w, cx);
    }

    /// The toolbar's Cherry-Pick: the selected commits (else the cursor's), oldest first.
    pub fn cherry_pick_selected(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        // the selection is in log order (newest first)
        let hashes: Vec<String> = self
            .model
            .selection_or_current()
            .iter()
            .rev()
            .map(|c| c.hash.clone())
            .collect();
        if hashes.is_empty() {
            return;
        }
        self.act(move |root| run::cherry_pick_all(root, &hashes), w, cx);
    }

    /// The toolbar's search icon (WS Go to Hash / Branch / Tag): a ref or hash, selected in the
    /// log (`show_commit`'s rules).
    pub fn go_to_ref_popup(&mut self, anchor: Anchor, w: &mut Window, cx: &mut Context<Self>) {
        self.go_to_ref(anchor, w, cx);
    }
}

/// Copy Hash: the full hash on the clipboard, "Copied <hash8>" (Lua).
fn copy_hash(c: &CommitRef, w: &mut Window, cx: &mut App) {
    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(c.hash.clone()));
    popups::notify(
        popups::Balloon::info("Git", crate::git::show::copied_text(&c.hash)),
        w,
        cx,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &Items) -> Vec<String> {
        items
            .entries
            .iter()
            .map(|e| match e {
                MenuEntry::Item(i) => i.label.to_string(),
                MenuEntry::Separator => "-".into(),
                MenuEntry::Info(t) => t.to_string(),
            })
            .collect()
    }

    #[test]
    fn unpushed_commits_get_reword_uncommit_drop() {
        let mut pushed = Items::default();
        pushed.commit(false);
        assert_eq!(
            labels(&pushed),
            [
                "Copy Hash",
                "Cherry-Pick",
                "Checkout Revision",
                "Revert Commit",
                "Reset Current Branch to Here…",
                "-",
                "New Branch…",
                "New Tag…"
            ]
        );
        assert_eq!(pushed.entries.len(), pushed.actions.len());
        let mut unpushed = Items::default();
        unpushed.commit(true);
        let l = labels(&unpushed);
        for want in ["Reword…", "Uncommit (keep changes)", "Drop Commit"] {
            assert!(l.iter().any(|x| x == want), "{want} in {l:?}");
        }
    }

    #[test]
    fn title_is_the_short_hash_and_subject_cut_at_50_chars() {
        let c = CommitRef {
            hash: "0123456789abcdef".into(),
            subject: "ä".repeat(60),
        };
        let t = menu_title(&c);
        assert!(t.starts_with("01234567 ää"));
        assert_eq!(t.chars().count(), 50);
    }
}
