//! The Log tab's details pane (M3 LOG/DETAILS) on the real nvim + config, driven by real keys and
//! mouse: the changed files of one / several selected commits, the commit details text (author,
//! date, branches, the hash link), keys in the files tree (folding, Back to the table, Enter =
//! diff, F4, Esc), the menus, Show History for File.
//!
//! Port of the details scenarios of `tests/git_log_test.lua` (and the Log details ones
//! `tests/git_changes_test.lua` has; CHANGES' `tests/git_changes.rs` maps them to this pane):
//!
//! -- lua: changed files of 2 selected commits: combined files + commit list -> rust: two_selected_commits_combined_files_and_commit_list
//! -- lua: ä goes to the changed files -> rust: enter_on_a_file_of_three_commits_diffs_from_before_the_oldest
//! -- lua: Enter on a file of 3 selected commits: diff from before the oldest to the newest -> rust: enter_on_a_file_of_three_commits_diffs_from_before_the_oldest
//! -- lua: .* off: plain text again, nothing matches: log and changed files empty -> rust: no_commit_empties_the_changed_files_and_details
//! -- lua (git_changes_test): changed files: a folder with its file count / compressed chains / folders before files / chevron on folders -> rust: tree_keys_fold_and_go_back_to_the_log
//! -- lua (git_changes_test): commit details: subject, body, hash, author, date -> rust: details_text_author_date_branches_and_hash_click_copies
//! -- lua (git_changes_test): commit details: the branches containing the commit -> rust: details_text_author_date_branches_and_hash_click_copies
//! -- lua (git_changes_test): a click on the commit message keeps the caret on the files -> rust: details_text_author_date_branches_and_hash_click_copies
//! -- lua (git_changes_test): Left collapses a folder, Right expands it / Left on a file goes to its folder / Enter on a folder folds it -> rust: tree_keys_fold_and_go_back_to_the_log
//! -- lua (git_changes_test): context menu Collapse All: only the top folders stay -> rust: tree_keys_fold_and_go_back_to_the_log
//! -- lua (git_changes_test): refresh keeps the caret in the changed files -> rust: tree_keys_fold_and_go_back_to_the_log
//! -- lua (git_changes_test): Enter on a changed file opens its diff, focus stays in the tool window -> rust: enter_on_a_file_of_three_commits_diffs_from_before_the_oldest
//! -- lua (git_changes_test): F4 on a changed file opens it in the editor -> rust: f4_opens_the_file_and_show_history_filters_the_log
//! -- own: Show History for File (menu + toolbar) -> rust: f4_opens_the_file_and_show_history_filters_the_log
//! -- own: Esc in the files: back to the editor -> rust: tree_keys_fold_and_go_back_to_the_log

use super::common;
use super::{log, read_log, selected, space, table_focused};

use std::path::PathBuf;

use common::gitui::*;
use common::view::View;
use gpui_kit::{Entity, MouseButton, point, px};
use vimstorm::git::LogKind;
use vimstorm::git::window::TabId;
use vimstorm::git::window::log::DetailsPane;
use vimstorm::kit::{RowKind, count};

fn grepo() -> PathBuf {
    common::fixtures().join("grepo")
}

fn pane(v: &mut View) -> Entity<DetailsPane> {
    let l = log(v);
    v.cx.read(|cx| l.read(cx).details.clone())
}

/// The files tree's rows: "src/services 1 file", "bee.ts" ("<empty>" for the empty row).
fn rows(v: &mut View) -> Vec<String> {
    let p = pane(v);
    v.pump();
    v.cx.read(|cx| {
        let t = p.read(cx).tree().read(cx);
        let d = &t.delegate;
        d.rows()
            .iter()
            .map(|r| match &r.kind {
                RowKind::Group(_) => "<group>".into(),
                RowKind::Dir { name, .. } => format!("{name} {}", count(r.files.len())),
                RowKind::File(fr) => d.file(*fr).name().to_owned(),
                RowKind::Empty => "<empty>".into(),
            })
            .collect()
    })
}

fn has_row(v: &mut View, text: &str) -> bool {
    rows(v)
        .iter()
        .any(|r| r == text || r.starts_with(&format!("{text} ")))
}

/// The tree cursor's row text.
fn cursor_row(v: &mut View) -> Option<String> {
    let p = pane(v);
    let c = v.cx.read(|cx| p.read(cx).tree().read(cx).state.cursor())?;
    rows(v).get(c).cloned()
}

fn text(v: &mut View) -> Vec<String> {
    let p = pane(v);
    v.pump();
    v.cx.read(|cx| p.read(cx).text_lines())
}

fn text_has(v: &mut View, s: &str) -> bool {
    text(v).iter().any(|l| l.contains(s))
}

fn busy(v: &mut View) -> bool {
    let p = pane(v);
    v.cx.read(|cx| p.read(cx).busy())
}

fn details_focused(v: &mut View) -> bool {
    let p = pane(v);
    v.pump();
    v.cx.update(|window, cx| p.read(cx).is_focused(window, cx))
}

/// Git opened, then Alt+Cmd+Left/Right to the Log tab; waits for the cursor commit's details.
fn open_log(v: &mut View) {
    open_git(v);
    for _ in 0..3 {
        if active(v) == TabId::Log {
            break;
        }
        v.keystrokes("alt-cmd-left");
        v.pump();
    }
    assert_eq!(active(v), TabId::Log);
    v.wait_until("log rows + HEAD's details", |v| {
        text(v).first().map(String::as_str) == Some("AB#1235 Renamed b") && !busy(v)
    });
    v.wait_until("the table has the keyboard", table_focused);
}

/// Moves the tree's cursor to the row `text` with l / ö.
fn goto_row(v: &mut View, text: &str) {
    for _ in 0..40 {
        let r = rows(v);
        let Some(want) = r
            .iter()
            .position(|x| x == text || x.starts_with(&format!("{text} ")))
        else {
            panic!("no row {text:?} in {r:?}");
        };
        let p = pane(v);
        let c =
            v.cx.read(|cx| p.read(cx).tree().read(cx).state.cursor())
                .unwrap_or(0);
        if c == want {
            return;
        }
        v.key(if c < want { "ö" } else { "l" });
    }
    panic!("cursor never reached {text:?}");
}

fn start() -> View {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v
}

#[test]
fn two_selected_commits_combined_files_and_commit_list() {
    let mut v = start();
    open_log(&mut v);
    // HEAD (the rename): one file, its folder chain compacted
    assert_eq!(rows(&mut v), ["src/services 1 file", "bee.ts"]);
    space(&mut v);
    v.key("ö");
    space(&mut v);
    assert_eq!(
        selected(&mut v),
        ["AB#1235 Renamed b", "AB#1236 Recent blame line"]
    );
    v.wait_until("2 commits selected + their files", |v| {
        text_has(v, "2 commits selected") && has_row(v, "bee.ts") && has_row(v, "blame.ts")
    });
    let t = text(&mut v);
    let short = |rev: &str| git(&grepo(), &["rev-parse", "--short=8", rev]);
    assert_eq!(t[0], "2 commits selected");
    assert_eq!(t[2], format!("{} AB#1235 Renamed b", short("HEAD")));
    assert_eq!(
        t[3],
        format!("{} AB#1236 Recent blame line", short("HEAD~1"))
    );
    // the toolbar counts the files
    assert!(bounds(&mut v, "details-count").is_some());
    // Space again: one commit again, its own files
    space(&mut v);
    v.wait_until("back to one commit", |v| {
        !text_has(v, "commits selected") && !has_row(v, "bee.ts") && has_row(v, "blame.ts")
    });
}

#[test]
fn enter_on_a_file_of_three_commits_diffs_from_before_the_oldest() {
    let mut v = start();
    open_log(&mut v);
    v.keystrokes("shift-down");
    v.keystrokes("shift-down");
    v.wait_until("3 commits selected", |v| selected(v).len() == 3);
    v.wait_until("their combined files", |v| {
        text_has(v, "3 commits selected") && has_row(v, "blame.ts") && !busy(v)
    });
    v.key("ä");
    v.wait_until("ä: the changed files have the keyboard", details_focused);
    goto_row(&mut v, "blame.ts");
    v.key("enter");
    v.wait_lua(
        "the diff opened",
        "local s = require('git.diff').state() return s ~= nil and s.revs ~= nil",
    );
    let old = v
        .lua("return require('git.diff').state().revs.old")
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let new = v
        .lua("return require('git.diff').state().revs.new")
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let rev = |r: &str| git(&grepo(), &["rev-parse", r]);
    assert_eq!(rev(&old), rev("HEAD~2^"), "from before the oldest");
    assert_eq!(rev(&new), rev("HEAD"), "to the newest");
    let file = v
        .lua("local s = require('git.diff').state() return s.files[s.index].path")
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(file, "blame.ts");
    // the keyboard stays in the Git tool window, on the files
    wait_target(&mut v, "git");
    assert!(details_focused(&mut v));
    v.lua("require('git.diff').close() return true");
}

#[test]
fn no_commit_empties_the_changed_files_and_details() {
    let mut v = start();
    open_log(&mut v);
    let l = log(&mut v);
    l.update(&mut v.cx, |t, cx| {
        t.update_filters(|f| f.text = Some("ren.med b".into()), cx)
    });
    v.wait_until("nothing matches: empty log", |v| {
        let l = log(v);
        v.cx.read(|cx| {
            let t = l.read(cx);
            !t.loading && t.model.is_empty()
        })
    });
    v.wait_until("empty files and details", |v| {
        text(v).is_empty() && rows(v) == ["<empty>"]
    });
    assert!(bounds(&mut v, "details-count").is_none());
    // matches again: the details come back
    l.update(&mut v.cx, |t, cx| {
        t.update_filters(|f| f.text = Some("Renamed b".into()), cx)
    });
    v.wait_until("details again", |v| {
        text(v).first().map(String::as_str) == Some("AB#1235 Renamed b")
    });
}

#[test]
fn details_text_author_date_branches_and_hash_click_copies() {
    let mut v = start();
    open_log(&mut v);
    // "In 1 branch: master" joins the rest (asked separately)
    v.wait_until("branches line", |v| text_has(v, "In 1 branch: master"));
    let t = text(&mut v);
    let hash = git(&grepo(), &["rev-parse", "HEAD"]);
    let when = git(
        &grepo(),
        &[
            "show",
            "-s",
            "--format=%ad",
            "--date=format-local:%Y-%m-%d at %H:%M",
            "HEAD",
        ],
    );
    assert_eq!(t[0], "AB#1235 Renamed b");
    assert_eq!(
        t[2],
        format!("{} Ada Example <ada@x.se> on {when}", &hash[..8]),
        "{t:?}"
    );
    // same person, same time: no committer line
    assert_eq!(t[3], "");
    assert_eq!(t[4], "In 1 branch: master");
    // its ref labels between the metadata and the branches line (CommitDetailsPanel)
    v.wait_until("ref labels", |v| {
        let p = pane(v);
        v.cx.read(|cx| p.read(cx).ref_labels()) == ["master"]
    });
    let (meta, refs, branches) = (
        bounds(&mut v, "details-hash").unwrap(),
        bounds(&mut v, "details-refs").unwrap(),
        bounds(&mut v, "details-branches").unwrap(),
    );
    assert!(meta.bottom() <= refs.top() && refs.bottom() <= branches.top());
    // a merged commit is in two branches
    v.key("ö");
    v.key("ö");
    v.key("ö");
    v.key("ö");
    v.wait_until("factory commit's branches", |v| {
        text(v).first().map(String::as_str) == Some("fixed label typo")
            && text_has(
                v,
                "In 3 branches: factory/1237, master, origin/factory/1237",
            )
    });
    assert_eq!(
        {
            let p = pane(&mut v);
            v.cx.read(|cx| p.read(cx).ref_labels())
        },
        ["factory/1237", "origin/factory/1237"]
    );
    v.key("l");
    v.key("l");
    v.key("l");
    v.key("l");
    v.wait_until("HEAD again (cached)", |v| {
        text(v).first().map(String::as_str) == Some("AB#1235 Renamed b")
            && text_has(v, "In 1 branch: master")
    });
    // a click on the hash copies it
    let at = bounds(&mut v, "details-hash").expect("hash drawn");
    left(&mut v, point(at.left() + px(6.), at.center().y));
    v.wait_until("hash copied + balloon", |v| {
        clipboard(v) == hash && has_balloon(v, &format!("Copied {}", &hash[..8]))
    });
    // a click on the text: the keyboard goes to the files
    let text_at = bounds(&mut v, "git-log-details-text").expect("text drawn");
    left(&mut v, point(text_at.center().x, text_at.bottom() - px(4.)));
    v.wait_until("click on the text: files focused", details_focused);
    assert_eq!(cursor_row(&mut v).as_deref(), Some("src/services 1 file"));
}

#[test]
fn tree_keys_fold_and_go_back_to_the_log() {
    let mut v = start();
    open_log(&mut v);
    // "AB#1234 Added checkout page texts": src/a.ts + blame.ts
    for _ in 0..3 {
        v.key("ö");
    }
    v.wait_until("checkout page commit", |v| {
        text(v).first().map(String::as_str) == Some("AB#1234 Added checkout page texts") && !busy(v)
    });
    // folders first, chevron (folder rows), then files
    assert_eq!(rows(&mut v), ["src 1 file", "a.ts", "blame.ts"]);
    v.key("arrow_right");
    v.wait_until("→ in the table: the files", details_focused);
    assert_eq!(cursor_row(&mut v).as_deref(), Some("src 1 file"));
    // ← on an open folder folds it, → unfolds it
    v.key("arrow_left");
    v.wait_until("folded", |v| !has_row(v, "a.ts"));
    v.key("ä");
    v.wait_until("unfolded", |v| has_row(v, "a.ts"));
    // k on a file: its folder
    goto_row(&mut v, "a.ts");
    v.key("k");
    v.wait_until("k: to the folder", |v| {
        cursor_row(v).as_deref() == Some("src 1 file")
    });
    // Enter on a folder folds it, again unfolds
    v.key("enter");
    v.wait_until("Enter folds", |v| !has_row(v, "a.ts"));
    v.key("enter");
    v.wait_until("Enter unfolds", |v| has_row(v, "a.ts"));
    // Cmd+Enter: the menu; Collapse All
    v.key("super+enter");
    v.wait_until("menu", |v| {
        menu_rows(v).is_some_and(|r| {
            [
                "Show Diff",
                "Jump to Source",
                "Show History for File",
                "Copy Path",
                "Collapse All",
                "Refresh",
                "Hide",
            ]
            .iter()
            .all(|w| r.iter().any(|l| l.contains(w)))
        })
    });
    pick_menu(&mut v, "Collapse All");
    v.wait_until("only the top folder", |v| {
        rows(v) == ["src 1 file", "blame.ts"]
    });
    // the eye: Expand All
    click_button(&mut v, "details-view");
    pick_menu(&mut v, "Expand All");
    v.wait_until("expanded", |v| has_row(v, "a.ts"));
    // refresh (R) keeps the cursor in the files
    goto_row(&mut v, "blame.ts");
    v.key("shift+r");
    v.wait_until("refresh reached the log", |v| {
        let l = log(v);
        v.cx.read(|cx| !l.read(cx).refreshes.is_empty() || !l.read(cx).loading)
    });
    v.settle();
    v.wait_until("quiet", |v| !busy(v));
    assert!(details_focused(&mut v));
    assert_eq!(cursor_row(&mut v).as_deref(), Some("blame.ts"));
    // k on a top-level file: back to the table
    v.key("k");
    v.wait_until("k at the edge: the table", table_focused);
    // Tab back and forth
    v.key("tab");
    v.wait_until("Tab: the files", details_focused);
    v.key("tab");
    v.wait_until("Tab: the table", table_focused);
    // Esc in the files: back to the editor
    v.key("ä");
    v.wait_until("files", details_focused);
    v.key("escape");
    wait_target(&mut v, "split");
}

#[test]
fn f4_opens_the_file_and_show_history_filters_the_log() {
    let mut v = start();
    open_log(&mut v);
    v.key("ä");
    v.wait_until("files", details_focused);
    goto_row(&mut v, "bee.ts");
    // the toolbar: History for the cursor's file
    click_button(&mut v, "details-history");
    v.wait_until("file history of bee.ts", |v| {
        let l = log(v);
        v.cx.read(|cx| l.read(cx).filters.paths == ["src/services/bee.ts"])
    });
    // back to the plain log, the menu's Show History for File on blame.ts (HEAD~1)
    let l = log(&mut v);
    l.update(&mut v.cx, |t, cx| t.clear_filters(cx));
    v.wait_until("plain log", |v| {
        let l = log(v);
        v.cx.read(|cx| l.read(cx).filters.paths.is_empty() && !l.read(cx).loading)
    });
    v.wait_until("HEAD's details", |v| {
        text(v).first().map(String::as_str) == Some("AB#1235 Renamed b") && !busy(v)
    });
    // right-click on the file row: the menu
    let row = bounds(&mut v, "changes-chevron-1").expect("tree row drawn");
    press(
        &mut v,
        point(row.right() + px(40.), row.center().y),
        MouseButton::Right,
        Default::default(),
        1,
    );
    pick_menu(&mut v, "Show History for File");
    v.wait_until("file history from the menu", |v| {
        let l = log(v);
        v.cx.read(|cx| l.read(cx).filters.paths == ["src/services/bee.ts"])
    });
    l.update(&mut v.cx, |t, cx| t.clear_filters(cx));
    v.wait_until("HEAD's details again", |v| {
        text(v).first().map(String::as_str) == Some("AB#1235 Renamed b") && !busy(v)
    });
    // F4: the file in the editor
    let p = pane(&mut v);
    v.cx.update(|window, cx| p.update(cx, |d, cx| d.focus(window, cx)));
    goto_row(&mut v, "bee.ts");
    v.key("f4");
    wait_target(&mut v, "split");
    v.wait_lua(
        "bee.ts in the editor",
        "return vim.fn.expand('%:t') == 'bee.ts'",
    );
}

#[test]
fn esc_and_c_in_the_files_tree_and_its_cmd_c_balloon() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    v.lua(
        "require('config.app.git').selection_history({ path = 'blame.ts', from = 2, to = 3, \
         label = 'blame.ts:2-3' }) return true",
    );
    v.wait_until("lines listed", |v| {
        read_log(v, |t| t.model.kind == LogKind::Lines && !t.loading)
    });
    v.wait_until("table", table_focused);
    v.keystrokes("tab");
    v.wait_until("files", |v| {
        let l = log(v);
        v.pump();
        v.cx.update(|w, cx| {
            let d = l.read(cx).details.clone();
            d.read(cx).is_focused(w, cx)
        })
    });
    // c: checkout a branch (Lua log_keys on the details buffer)
    v.keystrokes("c");
    v.wait_until("checkout menu", |v| {
        menu_title(v).is_some_and(|t| t.contains("Checkout"))
    });
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    // Cmd+C on a file: copied with a balloon
    v.keystrokes("cmd-c");
    v.wait_until("balloon", |v| has_balloon(v, "Copied"));
    // Esc: closes the history first (Lua common_keys)
    v.keystrokes("escape");
    v.wait_until("history closed", |v| {
        read_log(v, |t| t.filters.lines.is_none())
    });
    wait_target(&mut v, "split");
}
