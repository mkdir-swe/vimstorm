//! The Log tab's commit actions and menus (M3 LOG/ACTIONS) on the real nvim + config, driven by
//! real keys: Cmd+Enter (everything) / Alt+Enter (the commit's actions), Copy Hash, Reword…,
//! Revert Commit, Reset Current Branch to Here…, checkout with `c`, the toolbar's Cherry-Pick and
//! Go to Hash/Branch/Tag. Each repo-changing test runs on its own copy of the grepo fixture.
//!
//! -- lua: Cmd+Enter on a commit: commit actions and log filters -> rust: cmd_enter_on_a_commit_shows_commit_actions_and_log_filters
//!
//! (Lua's label "Cherry-pick" is WS's "Cherry-Pick" here: DECISIONS.md LOG/ACTIONS.)

use super::common;
use super::{cursor, loaded, log, open_log, row_bounds, space, start_copy, subjects, update_log};

use std::path::Path;

use common::gitfix::{self, GitFixture};
use common::gitui::*;
use common::view::View;
use gpui_kit::{Modifiers, MouseButton};
use vimstorm::git::BranchFilter;
use vimstorm::kit::Anchor;

/// The cursor commit's subject.
fn current(v: &mut View) -> Option<String> {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, _| t.model.current().map(|c| c.subject.clone()))
}

fn selected(v: &mut View) -> usize {
    let l = log(v);
    l.read_with(&v.cx, |t, _| t.model.selection().len())
}

/// Moves the cursor down (real keys) to the row with `subject`.
fn cursor_to(v: &mut View, subject: &str) {
    for _ in 0..30 {
        if current(v).as_deref() == Some(subject) {
            return;
        }
        v.keystrokes("down");
    }
    panic!("no row {subject:?}, at {:?}", current(v));
}

fn menu_has(v: &mut View, label: &str) -> bool {
    menu_rows(v).is_some_and(|r| r.iter().any(|l| l == label))
}

fn wait_menu_with(v: &mut View, label: &str) {
    v.wait_until(&format!("menu with {label:?}"), |v| menu_has(v, label));
}

fn wait_closed(v: &mut View) {
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
}

fn head_subject(dir: &Path) -> String {
    git(dir, &["log", "-1", "--format=%s"])
}

fn start_in(fx: &GitFixture) -> View {
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    v
}

#[test]
fn cmd_enter_on_a_commit_shows_commit_actions_and_log_filters() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    assert_eq!(current(&mut v).as_deref(), Some("AB#1235 Renamed b"));
    v.keystrokes("cmd-enter");
    wait_menu_with(&mut v, "Cherry-Pick");
    let rows = menu_rows(&mut v).unwrap();
    for want in [
        "Copy Hash",
        "Revert Commit",
        "Reset Current Branch to Here…",
        "Select Commit",
        "Clear Selection",
        "Show Changed Files",
        "Copy Commit Message",
        "Filter by Text or Hash…",
        "Text Filter: Regex",
        "Text Filter: Match Case",
        "Filter by Branch…",
        "Filter by User…",
        "Filter by Date…",
        "Filter by Paths…",
        "Clear Filters",
        "Checkout Branch…",
        "Refresh",
        "Hide",
    ] {
        assert!(rows.iter().any(|r| r == want), "{want:?} in {rows:?}");
    }
    let p = popups(&mut v);
    let clear = p
        .read_with(&v.cx, |p, _| p.menu_item("Clear Selection"))
        .unwrap();
    assert!(!clear.enabled, "nothing selected: Clear Selection off");
    let filter = p
        .read_with(&v.cx, |p, _| p.menu_item("Filter by Branch…"))
        .unwrap();
    assert_eq!(filter.shortcut.as_deref(), Some("b"));
    // Select Commit from the menu selects the cursor's commit; the next menu offers Unselect
    pick_menu(&mut v, "Select Commit");
    wait_closed(&mut v);
    v.wait_until("selected", |v| selected(v) == 1);
    v.keystrokes("cmd-enter");
    wait_menu_with(&mut v, "Unselect Commit");
    let clear = p
        .read_with(&v.cx, |p, _| p.menu_item("Clear Selection"))
        .unwrap();
    assert!(clear.enabled);
    pick_menu(&mut v, "Clear Selection");
    v.wait_until("selection cleared", |v| selected(v) == 0);
    // the toggles follow the filters
    v.keystrokes("cmd-enter");
    wait_menu_with(&mut v, "Text Filter: Regex");
    pick_menu(&mut v, "Text Filter: Regex");
    v.wait_until("regex on", |v| {
        let l = log(v);
        l.read_with(&v.cx, |t, _| t.filters.regex)
    });
    v.keystrokes("cmd-enter");
    wait_menu_with(&mut v, "Text Filter: Plain Text");
    v.keystrokes("escape");
    wait_closed(&mut v);
    // Hide closes the tool window
    v.keystrokes("cmd-enter");
    pick_menu(&mut v, "Hide");
    v.wait_until("hidden", |v| !git_open(v));
}

#[test]
fn alt_enter_offers_reword_uncommit_drop_only_for_unpushed_commits() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    let head = git(&common::fixtures().join("grepo"), &["rev-parse", "HEAD"]);
    v.keystrokes("alt-enter");
    wait_menu_with(&mut v, "Reword…");
    assert_eq!(
        menu_title(&mut v).as_deref(),
        Some(format!("{} AB#1235 Renamed b", &head[..8]).as_str())
    );
    let rows = menu_rows(&mut v).unwrap();
    for want in [
        "Copy Hash",
        "Cherry-Pick",
        "Checkout Revision",
        "Revert Commit",
        "Reset Current Branch to Here…",
        "Reword…",
        "Uncommit (keep changes)",
        "Drop Commit",
        "New Branch…",
        "New Tag…",
    ] {
        assert!(rows.iter().any(|r| r == want), "{want:?} in {rows:?}");
    }
    assert!(
        !rows.iter().any(|r| r == "Filter by Branch…"),
        "Alt+Enter: the commit's actions only"
    );
    v.keystrokes("escape");
    wait_closed(&mut v);
    // a pushed commit (on origin/master): no rewriting
    cursor_to(&mut v, "AB#101 Added service b");
    v.keystrokes("alt-enter");
    wait_menu_with(&mut v, "Cherry-Pick");
    let rows = menu_rows(&mut v).unwrap();
    assert!(rows.iter().any(|r| r == "Reset Current Branch to Here…"));
    for gone in ["Reword…", "Uncommit (keep changes)", "Drop Commit"] {
        assert!(!rows.iter().any(|r| r == gone), "{gone:?} not in {rows:?}");
    }
    v.keystrokes("escape");
}

#[test]
fn copy_hash_puts_the_full_hash_on_the_clipboard() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    let head = git(&common::fixtures().join("grepo"), &["rev-parse", "HEAD"]);
    v.keystrokes("alt-enter");
    pick_menu(&mut v, "Copy Hash");
    v.wait_until("hash copied", |v| clipboard(v) == head);
    let short = format!("Copied {}", &head[..8]);
    v.wait_until("balloon", |v| has_balloon(v, &short));
}

#[test]
fn vim_keys_count_moves_yy_hash_rr_reword_and_dd_only_unpushed() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    let subs = subjects(&mut v);
    v.keystrokes("3 ö");
    assert_eq!(current(&mut v).as_ref(), Some(&subs[3]));
    v.keystrokes("g g");
    assert_eq!(current(&mut v).as_ref(), Some(&subs[0]));
    // yy: the full hash
    let head = git(&common::fixtures().join("grepo"), &["rev-parse", "HEAD"]);
    v.keystrokes("y y");
    v.wait_until("hash copied", |v| clipboard(v) == head);
    // rr on the unpushed HEAD: Reword's input
    v.keystrokes("r r");
    let p = popups(&mut v);
    v.wait_until("the reword input", |v| {
        p.read_with(&v.cx, |p, cx| p.input_state(cx))
            .is_some_and(|(_, text, _)| text == "AB#1235 Renamed b")
    });
    v.keystrokes("escape");
    // dd on a pushed commit: nothing dropped, a balloon says why
    cursor_to(&mut v, "AB#101 Added service b");
    v.keystrokes("d d");
    v.wait_until("not dropped", |v| has_balloon(v, "can be dropped"));
    assert!(menu_title(&mut v).is_none());
}

#[test]
fn reword_of_head_changes_its_subject_and_the_log_reloads() {
    let (fx, mut v) = start_copy();
    open_log(&mut v);
    v.keystrokes("alt-enter");
    pick_menu(&mut v, "Reword…");
    let p = popups(&mut v);
    v.wait_until("the input with the subject", |v| {
        p.read_with(&v.cx, |p, cx| p.input_state(cx))
            .is_some_and(|(_, text, _)| text == "AB#1235 Renamed b")
    });
    // the subject starts selected: typing replaces it
    v.cx.simulate_input("AB#1235 Renamed b to bee");
    v.keystrokes("enter");
    v.wait_until("reworded", |v| {
        head_subject(&fx.repo) == "AB#1235 Renamed b to bee"
            && current(v).as_deref() == Some("AB#1235 Renamed b to bee")
    });
    v.wait_until("balloon", |v| has_balloon(v, "Reworded"));
    // the parent is untouched
    assert_eq!(
        git(&fx.repo, &["log", "-1", "--format=%s", "HEAD~1"]),
        "AB#1236 Recent blame line"
    );
}

#[test]
fn revert_creates_a_commit() {
    let (fx, mut v) = start_copy();
    open_log(&mut v);
    let head = git(&fx.repo, &["rev-parse", "HEAD"]);
    v.keystrokes("alt-enter");
    pick_menu(&mut v, "Revert Commit");
    v.wait_until("a revert commit on top", |v| {
        head_subject(&fx.repo) == "Revert \"AB#1235 Renamed b\""
            && subjects(v).first().map(String::as_str) == Some("Revert \"AB#1235 Renamed b\"")
    });
    // a refresh keeps the cursor on its commit
    assert_eq!(current(&mut v).as_deref(), Some("AB#1235 Renamed b"));
    let short = format!("Reverted {}", &head[..8]);
    v.wait_until("balloon", |v| has_balloon(v, &short));
}

#[test]
fn reset_soft_moves_head_and_keeps_the_changes_staged() {
    let (fx, mut v) = start_copy();
    open_log(&mut v);
    cursor_to(&mut v, "AB#1236 Recent blame line");
    let target = git(&fx.repo, &["rev-parse", "HEAD~1"]);
    v.keystrokes("alt-enter");
    pick_menu(&mut v, "Reset Current Branch to Here…");
    v.wait_until("mode menu", |v| {
        menu_title(v).is_some_and(|t| t == format!("Reset to {}", &target[..8]))
    });
    let rows = menu_rows(&mut v).unwrap();
    assert_eq!(
        rows,
        [
            "Soft (keep changes staged)",
            "Mixed (keep changes)",
            "Hard (discard changes)"
        ]
    );
    pick_menu(&mut v, "Soft (keep changes staged)");
    v.wait_until("HEAD moved, the log reloaded", |v| {
        git(&fx.repo, &["rev-parse", "HEAD"]) == target
            && subjects(v).first().map(String::as_str) == Some("AB#1236 Recent blame line")
    });
    // the rename is staged
    let staged = git(&fx.repo, &["diff", "--cached", "--name-only"]);
    assert!(staged.contains("src/services/bee.ts"), "{staged}");
}

#[test]
fn c_checks_out_a_branch_after_confirming() {
    let fx = gitfix::fixture("grepo");
    gitfix::git(&fx.repo, &["branch", "side"]);
    let mut v = start_in(&fx);
    open_log(&mut v);
    v.keystrokes("c");
    v.wait_until("the branches", |v| {
        menu_title(v).as_deref() == Some("Checkout branch")
    });
    let rows = menu_rows(&mut v).unwrap();
    for want in [
        "master",
        "side",
        "origin/master",
        "origin/factory/1237",
        "v1.0",
    ] {
        assert!(rows.iter().any(|r| r == want), "{want:?} in {rows:?}");
    }
    // local first, then remote, then tags (Lua branches.list)
    let pos = |s: &str| rows.iter().position(|r| r == s).unwrap();
    assert!(pos("side") < pos("origin/master") && pos("origin/master") < pos("v1.0"));
    pick_menu(&mut v, "side");
    v.wait_until("confirmation", |v| {
        menu_title(v).as_deref() == Some("Checkout side?")
    });
    assert_eq!(menu_rows(&mut v).unwrap(), ["Checkout", "Cancel"]);
    // Cancel: nothing
    pick_menu(&mut v, "Cancel");
    wait_closed(&mut v);
    assert_eq!(git(&fx.repo, &["branch", "--show-current"]), "master");
    // again, Checkout
    v.keystrokes("c");
    pick_menu(&mut v, "side");
    v.wait_until("confirmation", |v| {
        menu_title(v).as_deref() == Some("Checkout side?")
    });
    pick_menu(&mut v, "Checkout");
    v.wait_until("on side", |v| {
        git(&fx.repo, &["branch", "--show-current"]) == "side" && has_balloon(v, "Switched to side")
    });
    // the tool window heard it (git.cli.changed -> the tab reloads)
    v.wait_until("the log refreshed", |v| {
        let l = log(v);
        l.read_with(&v.cx, |t, _| !t.refreshes.is_empty())
    });
}

#[test]
fn toolbar_cherry_pick_picks_the_selected_commits_oldest_first() {
    let fx = gitfix::fixture("grepo");
    // two commits on a side branch, the work tree's local changes kept around it
    sh(&format!(
        "cd {} && git stash -q -u && git switch -q -c side && echo 1 > one.txt && git add one.txt \
         && git commit -qm 'Side one' && echo 2 > two.txt && git add two.txt \
         && git commit -qm 'Side two' && git switch -q master && git stash pop -q",
        fx.repo.display()
    ));
    let mut v = start_in(&fx);
    open_log(&mut v);
    // all branches listed (the Branch filter is FILTERS'; set it on the tab)
    let l = log(&mut v);
    v.cx.update(|_, cx| {
        l.update(cx, |t, cx| {
            t.update_filters(|f| f.branch = BranchFilter::All, cx)
        })
    });
    v.wait_until("side commits listed", |v| {
        subjects(v).iter().any(|s| s == "Side one")
    });
    cursor_to(&mut v, "Side two");
    v.keystrokes("space");
    v.keystrokes("down");
    assert_eq!(current(&mut v).as_deref(), Some("Side one"));
    v.keystrokes("space");
    v.wait_until("two selected", |v| selected(v) == 2);
    // the toolbar's Cherry-Pick button calls this
    v.cx.update(|w, cx| l.update(cx, |t, cx| t.cherry_pick_selected(w, cx)));
    v.wait_until("both picked, oldest first", |v| {
        head_subject(&fx.repo) == "Side two"
            && git(&fx.repo, &["log", "-1", "--format=%s", "HEAD~1"]) == "Side one"
            && has_balloon(v, "Cherry-picked 2 commits")
    });
    assert_eq!(git(&fx.repo, &["branch", "--show-current"]), "master");
}

#[test]
fn go_to_ref_selects_the_commit_or_says_not_found() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    let l = log(&mut v);
    let anchor = Anchor::Point(gpui_kit::point(gpui_kit::px(100.), gpui_kit::px(100.)));
    let p = popups(&mut v);
    // the toolbar's search icon calls this
    v.cx.update(|w, cx| l.update(cx, |t, cx| t.go_to_ref_popup(anchor, w, cx)));
    v.wait_until("input", |v| {
        p.read_with(&v.cx, |p, cx| p.input_state(cx))
            .is_some_and(|(title, _, _)| title == "Go to Hash/Branch/Tag")
    });
    v.cx.simulate_input("v1.0");
    v.keystrokes("enter");
    v.wait_until("tag's commit selected", |v| {
        current(v).as_deref() == Some("AB#1234 Added checkout page texts")
    });
    v.cx.update(|w, cx| l.update(cx, |t, cx| t.go_to_ref_popup(anchor, w, cx)));
    v.wait_until("input", |v| {
        p.read_with(&v.cx, |p, cx| p.input_state(cx)).is_some()
    });
    v.cx.simulate_input("nope/nothing");
    v.keystrokes("enter");
    v.wait_until("not found", |v| {
        has_balloon(v, "Commit or reference 'nope/nothing' not found")
    });
    assert_eq!(
        current(&mut v).as_deref(),
        Some("AB#1234 Added checkout page texts")
    );
}

#[test]
fn right_click_on_a_selected_row_makes_it_the_menus_commit() {
    let (fx, mut v) = start_copy();
    open_log(&mut v);
    // Space on row 0, ö ö, Space: rows 0 and 2 selected, the cursor on 2
    space(&mut v);
    v.keystrokes("ö ö");
    space(&mut v);
    assert_eq!(cursor(&mut v), Some(2));
    assert_eq!(selected(&mut v), 2);
    let r0 = row_bounds(&mut v, 0);
    press(
        &mut v,
        r0.center(),
        MouseButton::Right,
        Modifiers::default(),
        1,
    );
    v.wait_until("menu", |v| menu_rows(v).is_some());
    assert_eq!(cursor(&mut v), Some(0), "the clicked row is the menu's");
    assert_eq!(selected(&mut v), 2, "the selection stays");
    pick_menu(&mut v, "Copy Hash");
    let head = git(&fx.repo, &["rev-parse", "HEAD"]);
    v.wait_until("row 0's hash copied", |v| clipboard(v) == head);
}

#[test]
fn alt_enter_cherry_pick_takes_the_menus_commit() {
    let (fx, mut v) = start_copy();
    let r = &fx.repo;
    git(r, &["checkout", "-q", "-b", "side"]);
    std::fs::write(r.join("one.txt"), "one\n").unwrap();
    git(r, &["add", "one.txt"]);
    git(r, &["commit", "-q", "-m", "Side one"]);
    std::fs::write(r.join("two.txt"), "two\n").unwrap();
    git(r, &["add", "two.txt"]);
    git(r, &["commit", "-q", "-m", "Side two"]);
    git(r, &["checkout", "-q", "master"]);
    open_log(&mut v);
    update_log(&mut v, |t, cx| {
        t.update_filters(|f| f.branch = BranchFilter::All, cx)
    });
    v.wait_until("all branches", |v| {
        loaded(v) && subjects(v).iter().any(|s| s == "Side one")
    });
    // Space on "Side one", the cursor on "Side two"
    let one = subjects(&mut v)
        .iter()
        .position(|s| s == "Side one")
        .unwrap();
    let two = subjects(&mut v)
        .iter()
        .position(|s| s == "Side two")
        .unwrap();
    for _ in 0..one {
        v.keystrokes("ö");
    }
    v.keystrokes("space");
    for _ in 0..one.abs_diff(two) {
        v.keystrokes("l");
    }
    assert_eq!(cursor(&mut v), Some(two));
    v.keystrokes("alt-enter");
    v.wait_until("menu titled Side two", |v| {
        menu_title(v).is_some_and(|t| t.contains("Side two"))
    });
    pick_menu(&mut v, "Cherry-Pick");
    v.wait_until("Side two picked onto master", |v| {
        let _ = v;
        git(r, &["log", "-1", "--format=%s", "master"]) == "Side two"
    });
    assert!(r.join("two.txt").exists() && !r.join("one.txt").exists());
}
