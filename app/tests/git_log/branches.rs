//! The Log tab's Branches pane (M3 LOG/BRANCHES) on the real nvim + config, driven by real mouse
//! clicks and keys: the collapsed "Branches" strip, the expanded tree (HEAD, Local, Remote →
//! origin, Tags, names grouped by directory), a click / Enter filtering the log by a branch, the
//! keys (l / ö / k / ä, `/` speed search, Esc), Expand / Collapse All, the splitter, checkout from
//! the menu with its confirmation, the refs reloading after a repo change. Repo-changing tests
//! run on their own copy of the grepo fixture.
//!
//! -- lua: branch filter: only the branch's commits, tab 'Log: factory/1237' -> rust: strip_expands_and_a_branch_click_filters_the_log
//! -- lua: R refreshes the log; compact refs: an extra branch adds an icon, not its name -> rust: refs_reload_after_a_new_branch_and_r
//! -- lua: (branches.lua) checkout after confirming: remote -> tracking branch, tag -> detached -> rust: checkout_from_the_menu_after_confirming

use super::common;
use super::{loaded, log, log_label, open_log, subjects, table_focused};

use common::gitfix::{self, GitFixture};
use common::gitui::*;
use common::view::View;
use gpui_kit::{Modifiers, MouseButton, ScrollDelta, TouchPhase, point, px};
use vimstorm::git::BranchFilter;
use vimstorm::git::window::TabId;

fn rows(v: &mut View) -> Vec<String> {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, cx| t.branch_rows(cx))
}

fn is_open(v: &mut View) -> bool {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, _| t.branches_open())
}

fn tree_focused(v: &mut View) -> bool {
    let l = log(v);
    v.pump();
    v.cx.update(|w, cx| l.read(cx).branches_focused(w, cx))
}

fn branch(v: &mut View) -> BranchFilter {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, _| t.filters.branch.clone())
}

/// Clicks the collapsed strip; the tree lists the refs.
fn expand(v: &mut View) {
    let strip = bounds(v, "stripe-git-log-branches").expect("the collapsed strip");
    left(v, strip.center());
    v.wait_until("pane open with refs", |v| {
        is_open(v) && rows(v).iter().any(|r| r == "Local")
    });
}

/// The row index of the `nth` (0-based) row reading `text` (indent included).
fn row_ix(v: &mut View, text: &str, nth: usize) -> usize {
    let r = rows(v);
    r.iter()
        .enumerate()
        .filter(|(_, l)| *l == text)
        .nth(nth)
        .map(|(i, _)| i)
        .unwrap_or_else(|| panic!("no row {text:?} #{nth} in {r:#?}"))
}

/// Row `ix` fully on screen (the wheel over the tree scrolls it into view: the tool window is
/// short).
fn row_bounds(v: &mut View, ix: usize) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    let pane = bounds(v, "git-log-branches-pane").expect("pane drawn");
    for step in 0..40 {
        if let Some(b) = bounds(v, &format!("branches-row-{ix}"))
            && b.top() >= pane.top()
            && b.bottom() <= pane.bottom()
        {
            return b;
        }
        // down first, then back up
        let lines = if step < 20 { -1. } else { 1. };
        v.scroll(
            pane.center(),
            ScrollDelta::Lines(point(0., lines)),
            TouchPhase::Moved,
        );
        v.pump();
    }
    panic!("row {ix} not drawn")
}

fn click_row(v: &mut View, ix: usize) {
    let b = row_bounds(v, ix);
    left(v, point(b.right() - px(10.), b.center().y));
}

fn right_click_row(v: &mut View, ix: usize) {
    let b = row_bounds(v, ix);
    press(
        v,
        point(b.right() - px(10.), b.center().y),
        MouseButton::Right,
        Modifiers::default(),
        1,
    );
}

fn wait_log_of(v: &mut View, want: &str) {
    let want = want.to_owned();
    v.wait_until(&format!("tab label {want:?}"), |v| log_label(v) == want);
    v.wait_until("log reloaded", loaded);
}

#[test]
fn strip_expands_and_a_branch_click_filters_the_log() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    // collapsed by default: the strip on the Log's left edge, full height, WS's width
    assert!(!is_open(&mut v));
    let strip = bounds(&mut v, "stripe-git-log-branches").expect("strip drawn");
    let table = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Log, cx))
        .unwrap();
    assert!(strip.top() > table.bottom(), "under the tool window header");
    assert_eq!(strip.size.width, px(vimstorm::look::STRIPE_WIDTH));
    assert!(strip.size.height > px(100.));
    // a click expands it: the tree lists grepo's refs, the tree has the keyboard
    expand(&mut v);
    assert_eq!(
        rows(&mut v),
        [
            "HEAD (Current Branch)",
            "Local",
            "  master",
            "  factory",
            "    1237",
            "Remote",
            "  origin",
            "    master",
            "    factory",
            "      1237",
            "Tags",
            "  backup",
            "    old-1",
            "  v1.0",
        ]
    );
    assert!(tree_focused(&mut v));
    assert!(bounds(&mut v, "stripe-git-log-branches").is_none());
    let pane = bounds(&mut v, "git-log-branches-pane").unwrap();
    assert_eq!(pane.size.width, px(240.), "default width");
    assert!(bounds(&mut v, "button-git-log-branches-hide").is_some());
    let refs = log(&mut v)
        .read_with(&v.cx, |t, _| t.branch_refs())
        .unwrap();
    assert_eq!(refs.current.as_deref(), Some("master"));
    // a click on the local factory/1237: the log shows only that branch
    let ix = row_ix(&mut v, "    1237", 0);
    click_row(&mut v, ix);
    wait_log_of(&mut v, "Log: factory/1237");
    assert_eq!(branch(&mut v), BranchFilter::Ref("factory/1237".into()));
    let s = subjects(&mut v);
    assert!(s.iter().any(|s| s == "fixed label typo"), "{s:?}");
    assert!(!s.iter().any(|s| s.contains("Renamed b")), "{s:?}");
    // the remote one: origin/factory/1237
    let ix = row_ix(&mut v, "      1237", 0);
    click_row(&mut v, ix);
    wait_log_of(&mut v, "Log: origin/factory/1237");
    // a tag, then HEAD
    let ix = row_ix(&mut v, "  v1.0", 0);
    click_row(&mut v, ix);
    wait_log_of(&mut v, "Log: v1.0");
    assert!(!subjects(&mut v).iter().any(|s| s.contains("Recent blame")));
    click_row(&mut v, 0);
    wait_log_of(&mut v, "Log: HEAD");
    assert!(subjects(&mut v).iter().any(|s| s.contains("Renamed b")));
    // a group row doesn't filter; its chevron folds it
    let local = row_ix(&mut v, "Local", 0);
    let chevron = bounds(&mut v, &format!("branches-chevron-{local}")).unwrap();
    left(&mut v, chevron.center());
    v.wait_until("Local folded", |v| !rows(v).iter().any(|r| r == "  master"));
    assert_eq!(log_label(&mut v), "Log: HEAD");
    left(&mut v, chevron.center());
    v.wait_until("Local unfolded", |v| {
        rows(v).iter().any(|r| r == "  master")
    });
    // Hide Branches: back to the strip, the table gets the keyboard
    click_button(&mut v, "git-log-branches-hide");
    v.wait_until("collapsed", |v| !is_open(v));
    assert!(bounds(&mut v, "stripe-git-log-branches").is_some());
    assert!(table_focused(&mut v));
}

#[test]
fn keys_fold_move_search_and_esc_goes_back_to_the_table() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    expand(&mut v);
    let cursor = |v: &mut View| {
        let l = log(v);
        v.pump();
        l.read_with(&v.cx, |t, cx| t.branch_cursor(cx))
    };
    // ö from no cursor: the first row; ö again: Local; k folds it, ä opens it, ä goes in
    v.key("ö");
    v.key("ö");
    assert_eq!(cursor(&mut v), Some(1));
    v.keystrokes("k");
    v.wait_until("Local folded", |v| !rows(v).iter().any(|r| r == "  master"));
    v.key("ä");
    v.wait_until("Local open", |v| rows(v).iter().any(|r| r == "  master"));
    v.key("ä");
    assert_eq!(cursor(&mut v), Some(2));
    // k on a branch: to its group; l up
    v.keystrokes("k");
    assert_eq!(cursor(&mut v), Some(1));
    v.keystrokes("l");
    assert_eq!(cursor(&mut v), Some(0));
    // Enter on HEAD keeps "Log: HEAD"; typing letters doesn't search
    v.keystrokes("enter");
    assert_eq!(log_label(&mut v), "Log: HEAD");
    // Collapse All, then `/` opens every group and finds a folded ref; Enter shows it
    click_button(&mut v, "git-log-branches-collapse-all");
    v.wait_until("all folded", |v| rows(v).len() == 4);
    v.keystrokes("/ o l d");
    v.wait_until("search found backup/old-1", |v| {
        let r = rows(v);
        cursor(v).is_some_and(|c| r[c] == "    old-1")
    });
    v.keystrokes("enter");
    wait_log_of(&mut v, "Log: backup/old-1");
    // Esc closes the search, then gives the keyboard back to the table
    v.keystrokes("escape");
    assert!(tree_focused(&mut v));
    v.keystrokes("escape");
    v.wait_until("table focused", table_focused);
    assert!(is_open(&mut v), "the pane stays open");
    // Expand All button
    click_button(&mut v, "git-log-branches-collapse-all");
    v.wait_until("all folded", |v| rows(v).len() == 4);
    click_button(&mut v, "git-log-branches-expand-all");
    v.wait_until("all open", |v| rows(v).len() == 14);
    // Backspace in the tree clears the log's filters
    let ix = row_ix(&mut v, "  master", 0);
    click_row(&mut v, ix);
    wait_log_of(&mut v, "Log: master");
    v.keystrokes("backspace");
    wait_log_of(&mut v, "Log: HEAD");
}

#[test]
fn the_splitter_resizes_the_pane() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    expand(&mut v);
    let pane = bounds(&mut v, "git-log-branches-pane").unwrap();
    let divider = bounds(&mut v, "git-log-branches-divider").unwrap();
    let from = divider.center();
    let to = point(from.x + px(60.), from.y);
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    v.pump();
    let wider = bounds(&mut v, "git-log-branches-pane").unwrap();
    assert_eq!(wider.size.width, pane.size.width + px(60.));
    // kept while the tab lives: collapse, expand
    click_button(&mut v, "git-log-branches-hide");
    v.wait_until("collapsed", |v| !is_open(v));
    expand(&mut v);
    let again = bounds(&mut v, "git-log-branches-pane").unwrap();
    assert_eq!(again.size.width, wider.size.width);
}

/// A private grepo copy with a clean work tree (switching branches would hit the local changes).
fn clean_repo() -> GitFixture {
    let fx = gitfix::fixture("grepo");
    gitfix::git(&fx.repo, &["reset", "-q", "--hard"]);
    gitfix::git(&fx.repo, &["clean", "-qfd"]);
    fx
}

#[test]
fn checkout_from_the_menu_after_confirming() {
    let fx = clean_repo();
    // no local factory/1237: its remote branch checks out as a new tracking branch
    gitfix::git(&fx.repo, &["branch", "-q", "-D", "factory/1237"]);
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    expand(&mut v);
    let ix = row_ix(&mut v, "      1237", 0);
    right_click_row(&mut v, ix);
    v.wait_until("menu", |v| menu_rows(v).is_some());
    let menu = menu_rows(&mut v).unwrap();
    for item in [
        "Checkout",
        "Show in Log",
        "Expand All",
        "Collapse All",
        "Hide Branches",
    ] {
        assert!(menu.iter().any(|r| r == item), "{item} in {menu:?}");
    }
    pick_menu(&mut v, "Checkout");
    v.wait_until("confirmation", |v| {
        menu_title(v).as_deref() == Some("Checkout origin/factory/1237?")
    });
    // Cancel changes nothing
    pick_menu(&mut v, "Cancel");
    v.wait_until("closed", |v| menu_rows(v).is_none());
    assert_eq!(
        gitfix::git(&fx.repo, &["branch", "--show-current"]).trim(),
        "master"
    );
    // c: the same confirmation; Checkout runs it
    v.keystrokes("c");
    v.wait_until("confirmation", |v| {
        menu_title(v).as_deref() == Some("Checkout origin/factory/1237?")
    });
    pick_menu(&mut v, "Checkout");
    v.wait_until("balloon", |v| {
        has_balloon(v, "Checked out origin/factory/1237 as factory/1237")
    });
    assert_eq!(
        gitfix::git(&fx.repo, &["branch", "--show-current"]).trim(),
        "factory/1237"
    );
    // the refs reload: the new local branch is the current one
    v.wait_until("refs reloaded", |v| {
        let l = log(v);
        l.read_with(&v.cx, |t, _| t.branch_refs())
            .is_some_and(|r| r.current.as_deref() == Some("factory/1237"))
    });
    // (a current branch in a folder doesn't lift the folder: master, the favorite, first)
    assert_eq!(rows(&mut v)[2..5], ["  master", "  factory", "    1237"]);
    // the current branch: Checkout is disabled, c does nothing
    let ix = row_ix(&mut v, "    1237", 0);
    right_click_row(&mut v, ix);
    v.wait_until("menu", |v| menu_rows(v).is_some());
    let p = popups(&mut v);
    let item = p.read_with(&v.cx, |p, _| p.menu_item("Checkout")).unwrap();
    assert!(!item.enabled);
    v.keystrokes("escape");
    v.wait_until("closed", |v| menu_rows(v).is_none());
    // a tag: detached
    let ix = row_ix(&mut v, "  v1.0", 0);
    click_row(&mut v, ix);
    v.keystrokes("c");
    v.wait_until("confirmation", |v| {
        menu_title(v).as_deref() == Some("Checkout v1.0?")
    });
    pick_menu(&mut v, "Checkout");
    v.wait_until("balloon", |v| has_balloon(v, "Checked out tag v1.0"));
    assert_eq!(
        gitfix::git(&fx.repo, &["branch", "--show-current"]).trim(),
        ""
    );
    v.wait_until("refs reloaded: detached", |v| {
        let l = log(v);
        l.read_with(&v.cx, |t, _| t.branch_refs())
            .is_some_and(|r| r.current.is_none())
    });
}

#[test]
fn refs_reload_after_a_new_branch_and_r() {
    let fx = clean_repo();
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    expand(&mut v);
    assert!(!rows(&mut v).iter().any(|r| r == "  zz-extra"));
    gitfix::git(&fx.repo, &["branch", "zz-extra", "factory/1237"]);
    // R in the tree refreshes (the log and the refs)
    v.keystrokes("shift-r");
    v.wait_until("zz-extra listed", |v| {
        rows(v).iter().any(|r| r == "  zz-extra")
    });
    let refs = log(&mut v)
        .read_with(&v.cx, |t, _| t.branch_refs())
        .unwrap();
    assert!(refs.local.iter().any(|b| b == "zz-extra"));
    // and from the table too: a deleted branch goes
    v.keystrokes("escape");
    v.wait_until("table focused", table_focused);
    gitfix::git(&fx.repo, &["branch", "-q", "-D", "zz-extra"]);
    v.keystrokes("shift-r");
    v.wait_until("zz-extra gone", |v| {
        !rows(v).iter().any(|r| r == "  zz-extra")
    });
}
