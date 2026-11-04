//! Local Changes tab of the native Git tool window on the real nvim + config, driven
//! by real keys and mouse: sections and checkboxes, folding, paths, menus, diffs, the narrow
//! header, autosave, commit (Cmd+K, the message area, hooks, unversioned files), rollback, merge
//! conflicts, push / pull / fetch, Amend, keys.
//!
//! Port of `tests/git_changes_test.lua` (the editor's annotate / change marker scenarios are
//! ANNOTATE's `tests/annotate.rs`; the Log tab's changed files / commit details scenarios run
//! against the Log tab's details pane, LOG's `tests/git_log.rs` owns that pane):
//!
//! -- lua: opening the Git tool window on Local Changes when there are changes -> rust: git_opens_on_local_changes_with_sections
//! -- lua: first open: Local Changes never drawn empty ("0 files") while git status runs -> rust: git_opens_on_local_changes_with_sections
//! -- lua: Local Changes: Changes / Unversioned Files sections with counts -> rust: git_opens_on_local_changes_with_sections
//! -- lua: Local Changes: unversioned folder chain compressed -> rust: git_opens_on_local_changes_with_sections
//! -- lua: Local Changes: no status letter column -> rust: git_opens_on_local_changes_with_sections (names only, status = color)
//! -- lua: Local Changes: two spaces between icon and name (file, folder) -> rust: git_opens_on_local_changes_with_sections (icon drawn, WS 2 px gap to the name)
//! -- lua: click on a section's checkbox includes its files -> rust: checkboxes_include_files_and_the_header_counts_them
//! -- lua: click on a file's checkbox includes it, again leaves it out -> rust: checkboxes_include_files_and_the_header_counts_them
//! -- lua: click on a chevron collapses the section, again expands it -> rust: chevron_click_folds_a_section
//! -- lua: Cmd+C on a changed file copies its path -> rust: cmd_c_copies_paths
//! -- lua: drag over a folder + its file, Cmd+C: their paths, the selection ended -> rust: cmd_c_copies_paths (click + Shift+click range: the native trees have no drag selection)
//! -- lua: right-click on a changed file: Show Diff, Rollback… -> rust: right_click_menu_enter_and_double_click_open_the_diff
//! -- lua: Enter on a file in Local Changes opens its diff, focus stays in the tool window -> rust: right_click_menu_enter_and_double_click_open_the_diff
//! -- lua: double-click on a file opens its diff -> rust: right_click_menu_enter_and_double_click_open_the_diff
//! -- lua: narrow Local Changes header: shortcut hints go first, all buttons stay -> rust: narrow_window_keeps_every_toolbar_button
//! -- lua: narrower: buttons become icons, all still shown -> rust: narrow_window_keeps_every_toolbar_button
//! -- lua: edit, Git again: the autosaved file shows up in Local Changes -> rust: autosave_and_undo_show_in_local_changes
//! -- lua: undo, Git again: autosaved again, gone from Local Changes -> rust: autosave_and_undo_show_in_local_changes
//! -- lua: changed files: a folder with its file count -> rust: log_changed_files_and_details (LOG's details pane)
//! -- lua: changed files: compressed single-child folder chains -> rust: log_changed_files_and_details
//! -- lua: changed files: folders before files -> rust: log_changed_files_and_details
//! -- lua: changed files: chevron on folders -> rust: log_changed_files_and_details
//! -- lua: commit details: subject, body, hash, author, date -> rust: log_changed_files_and_details
//! -- lua: commit details: the branches containing the commit -> rust: log_changed_files_and_details
//! -- lua: a click on the commit message keeps the caret on the files -> rust: log_changed_files_and_details
//! -- lua: changed files: ö / Down stop at the last file, Up at the first row -> rust: log_changed_files_and_details
//! -- lua: Left collapses a folder, Right expands it -> rust: log_changed_files_and_details
//! -- lua: Left on a file goes to its folder -> rust: log_changed_files_and_details
//! -- lua: Enter on a folder folds it -> rust: log_changed_files_and_details
//! -- lua: context menu Collapse All: only the top folders stay -> rust: log_changed_files_and_details
//! -- lua: refresh keeps the caret in the changed files -> rust: log_changed_files_and_details (window deactivated / activated)
//! -- lua: Enter on a changed file opens its diff, focus stays in the tool window -> rust: log_changed_files_and_details
//! -- lua: F4 on a changed file opens it in the editor -> rust: log_changed_files_and_details
//! -- lua: no caret in the Git tool window, the caret back in the editor -> rust: log_changed_files_and_details
//! -- lua: click on the change marker / Esc closes the change popup / annotate ... -> ANNOTATE (tests/annotate.rs)
//! -- lua: failed commit (hook): its output shown, nothing committed or staged -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out
//! -- lua: failed commit: the file stays marked -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out
//! -- lua: failed commit: the next Cmd+K starts with its message -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out
//! -- lua: Cmd+K in the editor: commit prompt counting changed files only (not unversioned) -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out (the drawn hint)
//! -- lua: commit leaves unversioned files out -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out
//! -- lua: click on the Local Changes tab: the header counts '1 file' -> rust: failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out
//! -- lua: Cmd+R (now Cmd+Z): rollback of an added file keeps it, unversioned -> rust: rollback_of_an_added_file_keeps_it_unversioned
//! -- lua: Local Changes: a Merge Conflicts section with the conflicted file -> rust: merge_conflicts_section_and_prepared_merge_message
//! -- lua: merge resolved: Cmd+K prefills git's merge message -> rust: merge_conflicts_section_and_prepared_merge_message
//! -- lua: detached HEAD: the status bar shows the 8-char hash, not HEAD -> rust: detached_head_status_bar_shows_the_hash
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::path::{Path, PathBuf};

use common::changes::*;
use common::gitui::*;
use common::view::View;
use gpui_kit::{Entity, Modifiers, MouseButton, point, px, size};
use vimstorm::git::window::TabId;
use vimstorm::git::window::changes::Pane;
use vimstorm::kit::{RowKind, count};
use vimstorm::look;

/// `git_changes_test.lua`'s repo: the last commit touches nested folders (modified / added /
/// deleted); a local edit (notes.txt) + an unversioned file (frontend/apps/admin/src/new.ts).
fn treerepo() -> PathBuf {
    let dir = temp_dir("vimstorm-treerepo-").join("treerepo");
    sh(&format!(
        r#"mkdir -p {d} && cd {d} && git init -q -b master
git config user.name 'Ada Example' && git config user.email ada@example.com
mkdir -p frontend/apps/admin/src frontend/packages/lib
echo one > frontend/apps/admin/src/one.ts && echo old > frontend/packages/lib/old.ts && echo hi > notes.txt
git add -A && GIT_AUTHOR_NAME='Aaron Sample' GIT_AUTHOR_DATE='2025-01-10T10:00:00' GIT_COMMITTER_DATE='2025-01-10T10:00:00' git commit -qm 'AB#1 Initial'
echo changed >> frontend/apps/admin/src/one.ts && echo two > frontend/apps/admin/src/two.ts
git rm -q frontend/packages/lib/old.ts && echo more >> notes.txt
D=$(date -v-8d +%Y-%m-%dT14:27:00)
git add -A && GIT_AUTHOR_DATE=$D GIT_COMMITTER_DATE=$D git commit -qm 'AB#2 Added two

Body line.'
echo local >> notes.txt && echo n > frontend/apps/admin/src/new.ts"#,
        d = dir.display()
    ));
    dir
}

/// The toolbar's count ("2 files, 1 marked") as drawn (None: not shown).
fn count_shown(v: &mut View) -> Option<String> {
    bounds(v, "lc-count")?;
    let t = tab(v);
    Some(v.cx.read(|cx| t.read(cx).count_text(cx)))
}

/// The commit hint as drawn under the message (None: not drawn).
fn hint_shown(v: &mut View) -> Option<String> {
    bounds(v, "lc-hint")?;
    let t = tab(v);
    Some(v.cx.read(|cx| t.read(cx).commit_hint(cx)))
}

fn message(v: &mut View) -> String {
    let t = tab(v);
    v.cx.read(|cx| t.read(cx).message().read(cx).text().to_owned())
}

/// The GitView has the keyboard.
fn git_focused(v: &mut View) -> bool {
    v.read_ws(|ws, _| ws.native_focus() == Some("git"))
}

/// A point on the row containing `text`, `dx` px right of its checkbox's center.
fn row_pos(v: &mut View, text: &str, dx: f32) -> gpui_kit::Point<gpui_kit::Pixels> {
    let ix = row_of(v, text).unwrap_or_else(|| panic!("no row {text:?}"));
    let b = bounds(v, &format!("changes-check-{ix}")).expect("row drawn");
    point(b.center().x + px(dx), b.center().y)
}

fn diff_open(v: &View) -> bool {
    v.lua("return require('git.diff').is_active()").as_bool() == Some(true)
}

fn close_diff(v: &mut View) {
    v.lua("require('git.diff').close() return true");
    v.wait_until("diff closed", |v| !diff_open(v));
}

/// Starts in `dir` on notes.txt, opens Git on Local Changes, waits for the first read.
fn start(dir: &Path) -> View {
    let mut v = View::start(dir.to_str().unwrap(), &["notes.txt"]);
    v.wait_screen("hi");
    open_git(&mut v);
    v.wait_until("Local Changes read", |v| {
        active(v) == TabId::Changes && loaded(v)
    });
    v
}

// Local Changes ----------------------------------------------------------------------------------

#[test]
fn git_opens_on_local_changes_with_sections() {
    let dir = treerepo();
    let mut v = View::start(dir.to_str().unwrap(), &["notes.txt"]);
    v.wait_screen("hi");
    v.lua("require('config.app.git').open() return true");
    // every frame until the first read: no tree (no "0 files" / "No local changes")
    let mut frames = 0;
    v.wait_until("Local Changes read", |v| {
        frames += 1;
        if !loaded(v) {
            assert!(bounds(v, "lc-count").is_none(), "count before the read");
            assert!(
                bounds(v, "changes-check-0").is_none(),
                "tree before the read"
            );
        }
        git_open(v) && loaded(v)
    });
    assert!(frames > 0);
    assert_eq!(active(&mut v), TabId::Changes);
    wait_target(&mut v, "git");
    v.wait_until("tree has the keyboard", |v| {
        git_focused(v) && pane(v) == Pane::Tree
    });
    let r = rows(&mut v);
    assert!(r.contains(&"Changes 1 file".to_owned()), "{r:?}");
    assert!(r.contains(&"Unversioned Files 1 file".to_owned()), "{r:?}");
    // the unversioned file's folder chain compressed
    assert!(
        r.contains(&"frontend/apps/admin/src 1 file".to_owned()),
        "{r:?}"
    );
    // names only (the status is the color), each file row with its icon
    assert!(r.contains(&"notes.txt".to_owned()) && r.contains(&"new.ts".to_owned()));
    assert_eq!(count_shown(&mut v).as_deref(), Some("2 files"));
    // file and folder rows: an icon, then the name WS's 2 px (myIconTextGap) after it
    for name in ["notes.txt", "frontend/apps/admin/src"] {
        let ix = row_of(&mut v, name).unwrap();
        let icon = bounds(&mut v, &format!("changes-icon-{ix}")).expect("icon drawn");
        let label = bounds(&mut v, &format!("changes-label-{ix}")).expect("name drawn");
        let gap = f32::from(label.left() - icon.right());
        assert!(
            (gap - vimstorm::look::TREE_ICON_GAP).abs() < 0.5,
            "{name}: gap {gap}"
        );
        assert_eq!(icon.size.width, px(16.), "{name}: 16 px icon");
    }
    // what a commit takes, drawn under the message at the default width
    let hint = bounds(&mut v, "lc-hint").expect("commit hint drawn");
    let msg = bounds(&mut v, "lc-message").unwrap();
    assert!(hint.top() >= msg.bottom() && hint.size.width > px(200.));
    let t = tab(&mut v);
    assert_eq!(
        v.cx.read(|cx| t.read(cx).commit_hint(cx)),
        "Commit all 1 changed file(s)"
    );
}

#[test]
fn checkboxes_include_files_and_the_header_counts_them() {
    let dir = treerepo();
    let mut v = start(&dir);
    // a section's checkbox includes its files
    let at = row_pos(&mut v, "Unversioned Files", 0.);
    left(&mut v, at);
    v.wait_until("section included", |v| {
        included(v) == ["frontend/apps/admin/src/new.ts"]
            && count_shown(v).as_deref() == Some("2 files, 1 marked")
    });
    left(&mut v, at);
    v.wait_until("section left out", |v| included(v).is_empty());
    // a file's checkbox: itself; again: out
    let at = row_pos(&mut v, "notes.txt", 0.);
    left(&mut v, at);
    v.wait_until("file included", |v| {
        included(v) == ["notes.txt"] && count_shown(v).as_deref() == Some("2 files, 1 marked")
    });
    left(&mut v, at);
    v.wait_until("file left out", |v| {
        included(v).is_empty() && count_shown(v).as_deref() == Some("2 files")
    });
    // Space on the cursor's file
    goto_row(&mut v, "notes.txt");
    v.keystrokes("space");
    v.wait_until("Space includes", |v| included(v) == ["notes.txt"]);
    v.keystrokes("space");
    v.wait_until("Space again leaves out", |v| included(v).is_empty());
}

#[test]
fn chevron_click_folds_a_section() {
    let dir = treerepo();
    let mut v = start(&dir);
    let ix = row_of(&mut v, "Unversioned Files").unwrap();
    let b = bounds(&mut v, &format!("changes-chevron-{ix}")).unwrap();
    left(&mut v, b.center());
    v.wait_until("folded", |v| !has_row(v, "new.ts"));
    left(&mut v, b.center());
    v.wait_until("unfolded", |v| has_row(v, "new.ts"));
    // keys: k folds the section from its row, ä unfolds
    goto_row(&mut v, "Unversioned Files");
    v.keystrokes("k");
    v.wait_until("k folds", |v| !has_row(v, "new.ts"));
    v.key("ä");
    v.wait_until("ä unfolds", |v| has_row(v, "new.ts"));
}

#[test]
fn cmd_c_copies_paths() {
    let dir = treerepo();
    let mut v = start(&dir);
    goto_row(&mut v, "notes.txt");
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), format!("{}/notes.txt", dir.display()));
    v.wait_until("Copied balloon", |v| {
        has_balloon(v, &format!("Copied {}/notes.txt", dir.display()))
    });
    // the folder + its file (click, Shift+click: the range), Cmd+C: their paths
    let a = row_pos(&mut v, "frontend/apps/admin/src", 60.);
    left(&mut v, a);
    let b = row_pos(&mut v, "new.ts", 60.);
    press(&mut v, b, MouseButton::Left, SHIFT, 1);
    v.keystrokes("cmd-c");
    assert_eq!(
        clipboard(&mut v),
        format!(
            "{d}/frontend/apps/admin/src\n{d}/frontend/apps/admin/src/new.ts",
            d = dir.display()
        )
    );
    v.wait_until("Copied 2 paths", |v| has_balloon(v, "Copied 2 paths"));
    // yy: the same as Cmd+C
    goto_row(&mut v, "notes.txt");
    v.keystrokes("y y");
    assert_eq!(clipboard(&mut v), format!("{}/notes.txt", dir.display()));
}

#[test]
fn right_click_menu_enter_and_double_click_open_the_diff() {
    let dir = treerepo();
    let mut v = start(&dir);
    let at = row_pos(&mut v, "notes.txt", 60.);
    press(&mut v, at, MouseButton::Right, Modifiers::default(), 1);
    v.wait_until("file menu", |v| {
        menu_rows(v).is_some_and(|r| {
            [
                "Show Diff",
                "Rollback…",
                "Jump to Source",
                "Commit…",
                "Push…",
            ]
            .iter()
            .all(|l| r.iter().any(|x| x.contains(l)))
        })
    });
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    // Enter: the diff, the keyboard stays here
    goto_row(&mut v, "notes.txt");
    v.keystrokes("enter");
    v.wait_until("diff open", |v| diff_open(v));
    v.wait_lua(
        "the diff shows notes.txt",
        "return vim.api.nvim_buf_get_name(require('git.diff').wins and \
         vim.api.nvim_win_get_buf(require('git.diff').wins()[1]) or 0):find('notes.txt') ~= nil",
    );
    wait_target(&mut v, "git");
    assert!(git_focused(&mut v));
    close_diff(&mut v);
    // double-click
    let at = row_pos(&mut v, "notes.txt", 60.);
    press(&mut v, at, MouseButton::Left, Modifiers::default(), 1);
    press(&mut v, at, MouseButton::Left, Modifiers::default(), 2);
    v.wait_until("double-click: diff", |v| diff_open(v));
    close_diff(&mut v);
    // Show Diff from the menu (Cmd+Enter at the cursor)
    goto_row(&mut v, "notes.txt");
    v.keystrokes("cmd-enter");
    pick_menu(&mut v, "Show Diff");
    v.wait_until("menu Show Diff", |v| diff_open(v));
    close_diff(&mut v);
}

/// The editor's `/` or `:` line open, or a `d` pending, and a double-click on a changed file: its
/// diff, Neovim in Normal mode (the click into Git left the line first, as Esc would).
#[test]
fn a_double_click_from_the_command_line_or_a_pending_operator_opens_the_diff() {
    let dir = treerepo();
    let mut v = start(&dir);
    for pending in ["/hi", ":ech", "d"] {
        v.lua("require('config.focus').editor() return true");
        wait_target(&mut v, "split");
        v.keystrokes(pending);
        let want = if pending == "d" { "no" } else { "c" };
        v.wait_until(&format!("{pending:?} pending"), |v| v.mode() == want);
        let at = row_pos(&mut v, "notes.txt", 60.);
        press(&mut v, at, MouseButton::Left, Modifiers::default(), 1);
        press(&mut v, at, MouseButton::Left, Modifiers::default(), 2);
        v.wait_until(&format!("{pending:?}: the diff, in Normal mode"), |v| {
            diff_open(v) && v.mode() == "n"
        });
        assert_eq!(
            v.lua("return vim.fn.getcmdtype()").as_str(),
            Some(""),
            "{pending:?}: the command line closed"
        );
        close_diff(&mut v);
    }
}

#[test]
fn narrow_window_keeps_every_toolbar_button() {
    let dir = treerepo();
    let mut v = start(&dir);
    const BUTTONS: [&str; 6] = [
        "lc-refresh",
        "lc-rollback",
        "lc-diff",
        "lc-view",
        "lc-expand",
        "lc-collapse",
    ];
    let all_shown = |v: &mut View| {
        let tree = bounds(v, "lc-tree");
        let Some(tree) = tree else { return false };
        BUTTONS.iter().all(|b| {
            bounds(v, &format!("button-{b}"))
                .is_some_and(|r| r.left() >= tree.left() && r.right() <= tree.right())
        })
    };
    assert!(all_shown(&mut v));
    assert!(count_shown(&mut v).is_some(), "wide: the count");
    // narrow (Lua's 92 columns): the commit panel beside the tree squeezes it: the count goes,
    // the buttons stay
    v.cx.simulate_resize(size(px(660.), px(880.)));
    v.wait_until("narrow: count gone, buttons stay", |v| {
        count_shown(v).is_none() && all_shown(v)
    });
    // narrower (60 columns): the commit panel goes below the tree; every button still there
    v.cx.simulate_resize(size(px(470.), px(880.)));
    v.wait_until("narrower: stacked, buttons stay", |v| {
        let (Some(t), Some(m)) = (bounds(v, "lc-tree"), bounds(v, "lc-message")) else {
            return false;
        };
        m.top() >= t.bottom() && all_shown(v)
    });
    v.cx.simulate_resize(size(px(1400.), px(880.)));
    v.wait_until("wide again: side by side", |v| {
        let (Some(t), Some(m)) = (bounds(v, "lc-tree"), bounds(v, "lc-message")) else {
            return false;
        };
        m.left() >= t.right() && count_shown(v).is_some()
    });
}

#[test]
fn autosave_and_undo_show_in_local_changes() {
    let dir = treerepo();
    let mut v = start(&dir);
    let one = "frontend/apps/admin/src/one.ts";
    v.focus_code();
    wait_target(&mut v, "split");
    v.lua(&format!("vim.cmd.edit('{one}') return true"));
    v.wait_screen("changed");
    v.keystrokes("shift-a");
    v.cx.simulate_input(" more");
    v.keystrokes("escape");
    open_git(&mut v);
    v.wait_until("autosaved file in Local Changes", |v| {
        has_row(v, "one.ts") && git(&dir, &["status", "--porcelain", one]) == format!("M {one}")
    });
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("u");
    open_git(&mut v);
    v.wait_until("undo: gone again", |v| {
        !has_row(v, "one.ts") && git(&dir, &["status", "--porcelain", one]).is_empty()
    });
}

// Commit / rollback / merge ----------------------------------------------------------------------

#[test]
fn failed_commit_keeps_message_and_marks_then_commit_leaves_unversioned_out() {
    let dir = treerepo();
    let hook = dir.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
    sh(&format!("chmod 755 {}", hook.display()));
    let mut v = start(&dir);
    goto_row(&mut v, "new.ts");
    v.keystrokes("space");
    v.wait_until("1 marked", |v| {
        count_shown(v).as_deref() == Some("2 files, 1 marked")
    });
    // Cmd+K: the message area; it says what a commit takes
    v.keystrokes("cmd-k");
    v.wait_until("message focused", |v| pane(v) == Pane::Message);
    assert_eq!(
        hint_shown(&mut v).as_deref(),
        Some("Commit 1 marked file(s)")
    );
    v.cx.simulate_input("Fix readme");
    v.keystrokes("cmd-k");
    v.wait_until("hook's output shown", |v| has_balloon(v, "hook says no"));
    v.wait_until("commit done", |v| {
        let t = tab(v);
        !v.cx.read(|cx| t.read(cx).committing())
    });
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "AB#2 Added two");
    assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), "");
    assert_eq!(
        git(&dir, &["status", "--porcelain", "frontend"]),
        "?? frontend/apps/admin/src/new.ts"
    );
    // the file stays marked, the message stays
    assert_eq!(included(&mut v), ["frontend/apps/admin/src/new.ts"]);
    assert_eq!(message(&mut v), "Fix readme");
    std::fs::remove_file(&hook).unwrap();
    // unmark; from the editor, Cmd+K: Local Changes' message, counting changed files only
    v.keystrokes("escape");
    v.wait_until("tree", |v| pane(v) == Pane::Tree);
    goto_row(&mut v, "new.ts");
    v.keystrokes("space");
    v.wait_until("unmarked", |v| included(v).is_empty());
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("cmd-k");
    wait_target(&mut v, "git");
    v.wait_until("message focused from the editor", |v| {
        pane(v) == Pane::Message && message(v) == "Fix readme"
    });
    assert_eq!(
        hint_shown(&mut v).as_deref(),
        Some("Commit all 1 changed file(s)")
    );
    // Cmd+Enter commits (the failed commit's message is still there)
    v.keystrokes("cmd-enter");
    v.wait_until("committed", |_| {
        git(&dir, &["log", "-1", "--format=%s"]) == "Fix readme"
    });
    assert_eq!(
        git(&dir, &["show", "--name-only", "--format=", "HEAD"]),
        "notes.txt"
    );
    assert_eq!(
        git(&dir, &["status", "--porcelain"]),
        "?? frontend/apps/admin/src/new.ts"
    );
    v.wait_until("message cleared, list reloaded", |v| {
        message(v).is_empty() && has_balloon(v, "Committed all 1 changed file(s)")
    });
    // to another tab and back by a click: the header counts "1 file"
    v.keystrokes("alt-cmd-right");
    v.wait_until("Log", |v| active(v) == TabId::Log);
    let b = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Changes, cx))
        .unwrap();
    left(&mut v, b.center());
    v.wait_until("Local Changes: 1 file", |v| {
        active(v) == TabId::Changes
            && count_shown(v).as_deref() == Some("1 file")
            && has_row(v, "new.ts")
    });
}

#[test]
fn rollback_of_an_added_file_keeps_it_unversioned() {
    let dir = treerepo();
    git(&dir, &["add", "frontend/apps/admin/src/new.ts"]);
    let mut v = start(&dir);
    v.wait_until("Changes 2 files", |v| has_row(v, "Changes 2 files"));
    goto_row(&mut v, "new.ts");
    v.keystrokes("cmd-z");
    v.wait_until("confirmation", |v| {
        menu_title(v).is_some_and(|t| t.starts_with("Rollback 1 file(s)?"))
    });
    v.keystrokes("enter");
    v.wait_until("rolled back: unversioned, kept", |v| {
        git(&dir, &["status", "--porcelain", "frontend"]) == "?? frontend/apps/admin/src/new.ts"
            && has_row(v, "Unversioned Files 1 file")
    });
    assert!(dir.join("frontend/apps/admin/src/new.ts").exists());
    // Cancel leaves it all
    goto_row(&mut v, "notes.txt");
    v.keystrokes("cmd-alt-z");
    v.wait_until("confirmation", |v| menu_title(v).is_some());
    v.keystrokes("escape");
    v.wait_until("closed", |v| menu_title(v).is_none());
    // dd: Cmd+Z's confirmation too
    v.keystrokes("d d");
    v.wait_until("dd confirmation", |v| {
        menu_title(v).is_some_and(|t| t.starts_with("Rollback 1 file(s)?"))
    });
    v.keystrokes("escape");
    v.wait_until("closed", |v| menu_title(v).is_none());
    assert_eq!(
        git(&dir, &["status", "--porcelain", "notes.txt"]),
        "M notes.txt"
    );
    // unversioned only: nothing to roll back
    goto_row(&mut v, "new.ts");
    v.keystrokes("cmd-z");
    v.wait_until("nothing to roll back", |v| {
        has_balloon(v, "Nothing to roll back")
    });
}

#[test]
fn merge_conflicts_section_and_prepared_merge_message() {
    let dir = treerepo();
    let mut v = start(&dir);
    sh(&format!(
        "cd {} && git stash -q -u && git checkout -q -b feature && echo theirs > conflict.ts && git add conflict.ts \
         && git commit -qm feature && git checkout -q master && echo yours > conflict.ts && git add conflict.ts \
         && git commit -qm mine && (git merge -q feature >/dev/null 2>&1; true)",
        dir.display()
    ));
    goto_row(&mut v, "notes.txt");
    v.key("shift+r");
    v.wait_until("Merge Conflicts section", |v| {
        has_row(v, "Merge Conflicts 1 file") && has_row(v, "conflict.ts")
    });
    // Enter on the conflict: the merge window
    goto_row(&mut v, "conflict.ts");
    v.keystrokes("enter");
    v.wait_lua("merge window", "return require('git.merge').is_active()");
    v.lua("require('git.merge').close(true) return true");
    v.wait_lua(
        "merge closed",
        "return not require('git.merge').is_active()",
    );
    // committing is refused while conflicts remain
    let t = tab(&mut v);
    assert_eq!(
        v.cx.read(|cx| t.read(cx).commit_hint(cx)),
        "Resolve the merge conflicts first"
    );
    git(&dir, &["checkout", "--theirs", "conflict.ts"]);
    git(&dir, &["add", "conflict.ts"]);
    v.lua("require('git.cli').changed() return true");
    v.wait_until("resolved: git's message prefilled", |v| {
        !has_row(v, "Merge Conflicts") && message(v) == "Merge branch 'feature'"
    });
    assert_eq!(hint_shown(&mut v).as_deref(), Some("Commit merge"));
    // marks don't apply to a merge commit: the hint says so
    goto_row(&mut v, "conflict.ts");
    v.keystrokes("space");
    v.wait_until("marks-ignored hint", |v| {
        hint_shown(v).as_deref() == Some("Commit merge: all changes, marks don't apply")
    });
    v.keystrokes("space");
    v.keystrokes("cmd-k");
    v.wait_until("message focused", |v| pane(v) == Pane::Message);
    v.keystrokes("cmd-enter");
    v.wait_until("merge committed", |_| {
        git(&dir, &["log", "-1", "--format=%s"]) == "Merge branch 'feature'"
            && git(&dir, &["rev-list", "--parents", "-n1", "HEAD"])
                .split(' ')
                .count()
                == 3
    });
}

#[test]
fn detached_head_status_bar_shows_the_hash() {
    let dir = treerepo();
    let mut v = start(&dir);
    sh(&format!(
        "cd {} && git stash -q -u && git checkout -q --detach HEAD~1",
        dir.display()
    ));
    let hash = git(&dir, &["rev-parse", "--short=8", "HEAD"]);
    v.lua("vim.api.nvim_exec_autocmds('FocusGained', {}) return true");
    v.wait_until("status bar: the hash", |v| {
        let b = v.read_ws(|ws, cx| ws.statusbar().read(cx).status().branch.clone());
        b.contains(&hash) && !b.contains("HEAD")
    });
}

// Beyond the Lua file: push / pull / fetch, Amend, keys, menu actions ----------------------------

/// A private grepo copy (its remote next to it); the View on it.
fn grepo() -> (common::gitfix::GitFixture, View) {
    let fx = common::gitfix::fixture("grepo");
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    v.wait_until("Local Changes read", |v| {
        active(v) == TabId::Changes && loaded(v)
    });
    (fx, v)
}

fn remote_head(fx: &common::gitfix::GitFixture) -> String {
    git(&fx.tmp.path().join("gremote.git"), &["rev-parse", "master"])
}

#[test]
fn push_and_commit_and_push_reach_the_remote() {
    let (fx, mut v) = grepo();
    let dir = fx.repo.clone();
    assert_ne!(remote_head(&fx), git(&dir, &["rev-parse", "HEAD"]));
    // Cmd+Shift+K in the tree: "Pushing…", then "Pushed"
    goto_row(&mut v, "a.ts");
    v.keystrokes("cmd-shift-k");
    v.wait_until("pushed", |v| {
        has_balloon(v, "Pushing…") && has_balloon(v, "Pushed")
    });
    assert_eq!(remote_head(&fx), git(&dir, &["rev-parse", "HEAD"]));
    // Mark a.ts and prepare a message; the global shortcut preserves the native commit continuation.
    v.keystrokes("space");
    v.wait_until("marked", |v| included(v) == ["src/a.ts"]);
    v.keystrokes("cmd-k");
    v.wait_until("message", |v| pane(v) == Pane::Message);
    v.cx.simulate_input("AB#1 Local change");
    v.focus_code();
    v.key("super+alt+k");
    v.wait_until("committed and pushed", |_| {
        git(&dir, &["log", "-1", "--format=%s"]) == "AB#1 Local change"
            && remote_head(&fx) == git(&dir, &["rev-parse", "HEAD"])
    });
    assert_eq!(
        git(&dir, &["show", "--name-only", "--format=", "HEAD"]),
        "src/a.ts"
    );
    v.wait_until("a.ts gone from the list", |v| {
        !has_row(v, "a.ts") && message(v).is_empty()
    });
    // (Commit and Push opens Local Changes: where the keyboard ends up raced the keys typed
    // before it.) Click Git before cycling its tabs.
    let b = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Changes, cx))
        .unwrap();
    left(&mut v, b.center());
    v.wait_until("Git has the keyboard after the tab click", |v| {
        v.read_ws(|ws, _| ws.native_focus()) == Some("git")
    });
    v.keystrokes("alt-cmd-right");
    v.wait_until("Log", |v| active(v) == TabId::Log);
    // Cmd+Shift+K from the editor: pushes without switching tabs.
    v.focus_code();
    wait_target(&mut v, "split");
    let before = balloons(&mut v)
        .iter()
        .filter(|(_, b)| b == "Pushed")
        .count();
    v.keystrokes("cmd-shift-k");
    v.wait_until("pushed again", |v| {
        balloons(v).iter().filter(|(_, b)| b == "Pushed").count() > before
    });
    assert_eq!(active(&mut v), TabId::Log, "the shown tab stays");
}

/// Someone else pushes to master (`theirs`, run in their clone), then the menu's Pull (Fetch first
/// when `fetch`) and what the window shows after it.
struct Pull {
    name: &'static str,
    theirs: &'static str,
    fetch: bool,
    after: fn(&mut View, &Path),
}

const PULLS: &[Pull] = &[
    Pull {
        name: "a new file: Fetch, then Pull keeps the local changes (autostash)",
        theirs: "echo theirs > theirs.ts && git add theirs.ts && git commit -qm 'AB#2 Theirs'",
        fetch: true,
        after: |v, dir| {
            v.wait_until("pulled", |v| {
                has_balloon(v, "Pulled") && dir.join("theirs.ts").exists()
            });
            assert!(git(dir, &["status", "--porcelain"]).contains("src/a.ts"));
        },
    },
    Pull {
        name: "a change where the local change is: a warning, the conflict listed",
        theirs: "echo 'their change' >> src/a.ts && git commit -qam 'AB#3 Theirs'",
        fetch: false,
        after: |v, _| {
            v.wait_until("conflict warning", |v| {
                has_balloon(v, "your local changes conflict")
            });
            assert!(!balloons(v).iter().any(|(_, b)| b == "Pulled"));
            v.wait_until("the conflict in Local Changes", |v| {
                has_row(v, "Merge Conflicts 1 file")
            });
        },
    },
];

#[test]
fn pull_and_fetch_from_the_menu() {
    for pull in PULLS {
        let (fx, mut v) = grepo();
        let dir = fx.repo.clone();
        git(&dir, &["push", "-q", "origin", "master"]);
        let other = fx.tmp.path().join("other");
        sh(&format!(
            "git clone -q -b master {r} {o} && cd {o} && git config user.name Other && git config user.email o@x.se \
             && {theirs} && git push -q origin master",
            r = fx.tmp.path().join("gremote.git").display(),
            o = other.display(),
            theirs = pull.theirs,
        ));
        goto_row(&mut v, "a.ts");
        if pull.fetch {
            v.keystrokes("cmd-enter");
            pick_menu(&mut v, "Fetch");
            v.wait_until(&format!("{}: fetched", pull.name), |v| {
                has_balloon(v, "Fetched")
            });
            assert_eq!(
                git(&dir, &["rev-parse", "origin/master"]),
                git(&other, &["rev-parse", "HEAD"]),
                "{}",
                pull.name
            );
        }
        v.keystrokes("cmd-enter");
        pick_menu(&mut v, "Pull");
        (pull.after)(&mut v, &dir);
    }
}

#[test]
fn amend_takes_the_last_message_and_amends_the_last_commit() {
    let dir = treerepo();
    let mut v = start(&dir);
    let parent = git(&dir, &["rev-parse", "HEAD~1"]);
    let b = bounds(&mut v, "lc-amend").unwrap();
    left(&mut v, point(b.left() + px(8.), b.center().y));
    v.wait_until("Amend: the last message", |v| {
        message(v) == "AB#2 Added two\n\nBody line."
    });
    let t = tab(&mut v);
    assert!(v.cx.read(|cx| t.read(cx).amend()));
    goto_row(&mut v, "notes.txt");
    v.keystrokes("space");
    v.keystrokes("cmd-k");
    v.keystrokes("cmd-enter");
    v.wait_until("amended", |v| {
        git(&dir, &["rev-parse", "HEAD~1"]) == parent
            && git(&dir, &["show", "--name-only", "--format=", "HEAD"]).contains("notes.txt")
            && !has_row(v, "notes.txt")
    });
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "AB#2 Added two");
    v.wait_until("Amend off, message cleared", |v| {
        let t = tab(v);
        !v.cx.read(|cx| t.read(cx).amend()) && message(v).is_empty()
    });
    // Amend off again: the text it put there goes
    hide_balloons(&mut v);
    let b = bounds(&mut v, "lc-amend").unwrap();
    left(&mut v, point(b.left() + px(8.), b.center().y));
    v.wait_until("on", |v| !message(v).is_empty());
    hide_balloons(&mut v);
    let b = bounds(&mut v, "lc-amend").unwrap();
    left(&mut v, point(b.left() + px(8.), b.center().y));
    v.wait_until("off: cleared", |v| message(v).is_empty());
}

#[test]
fn keys_tab_help_group_by_directory_jump_add_and_esc() {
    let dir = treerepo();
    let mut v = start(&dir);
    goto_row(&mut v, "notes.txt");
    // Tab: the message; Esc there: the tree
    v.keystrokes("tab");
    v.wait_until("message", |v| pane(v) == Pane::Message);
    v.keystrokes("escape");
    v.wait_until("tree", |v| pane(v) == Pane::Tree);
    // g?: the help
    v.keystrokes("g");
    v.key("shift++");
    v.wait_until("help", |v| has_balloon(v, "Local Changes\n"));
    // Group by Directory off: a flat list (no folder rows), on again: folders
    // (the View Options eye ▾, WS ChangesView.ViewOptions)
    click_button(&mut v, "lc-view");
    pick_menu(&mut v, "Group by Directory");
    v.wait_until("flat", |v| !has_row(v, "frontend/apps/admin/src"));
    click_button(&mut v, "lc-view");
    pick_menu(&mut v, "Group by Directory");
    v.wait_until("folders", |v| has_row(v, "frontend/apps/admin/src"));
    // Collapse All / Expand All buttons
    click_button(&mut v, "lc-collapse");
    v.wait_until("collapsed", |v| !has_row(v, "notes.txt"));
    click_button(&mut v, "lc-expand");
    v.wait_until("expanded", |v| has_row(v, "notes.txt"));
    // Add to VCS from the menu
    let at = row_pos(&mut v, "new.ts", 60.);
    press(&mut v, at, MouseButton::Right, Modifiers::default(), 1);
    pick_menu(&mut v, "Add to VCS");
    v.wait_until("added", |v| {
        git(&dir, &["status", "--porcelain", "frontend"]) == "A  frontend/apps/admin/src/new.ts"
            && has_row(v, "Changes 2 files")
    });
    // F4: the file in the editor
    goto_row(&mut v, "notes.txt");
    v.keystrokes("f4");
    wait_target(&mut v, "split");
    v.wait_lua(
        "notes.txt in the editor",
        "return vim.fn.expand('%:t') == 'notes.txt'",
    );
    // Esc in the tree: back to code
    open_git(&mut v);
    v.wait_until("tree", |v| pane(v) == Pane::Tree && git_focused(v));
    v.keystrokes("escape");
    wait_target(&mut v, "split");
}

// The Log's changed files + commit details (LOG's details pane; git_changes_test.lua's part) -----

fn details(v: &mut View) -> Entity<vimstorm::git::window::log::DetailsPane> {
    v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).details.clone())
}

fn details_rows(v: &mut View) -> Vec<String> {
    let d = details(v);
    v.pump();
    v.cx.read(|cx| {
        let t = d.read(cx).tree().read(cx);
        let dl = &t.delegate;
        dl.rows()
            .iter()
            .map(|r| match &r.kind {
                RowKind::Group(g) => dl.groups()[*g]
                    .title
                    .clone()
                    .unwrap_or_default()
                    .to_string(),
                RowKind::Dir { name, .. } => format!("{name} {}", count(r.files.len())),
                RowKind::File(fr) => dl.file(*fr).name().to_owned(),
                RowKind::Empty => "<empty>".into(),
            })
            .collect()
    })
}

fn details_row(v: &mut View, text: &str) -> Option<usize> {
    details_rows(v).iter().position(|r| r.contains(text))
}

fn details_cursor(v: &mut View) -> Option<usize> {
    let d = details(v);
    v.cx.read(|cx| d.read(cx).tree().read(cx).state.cursor())
}

fn details_focused(v: &mut View) -> bool {
    let d = details(v);
    v.pump();
    v.cx.update(|window, cx| d.read(cx).is_focused(window, cx))
}

fn details_goto(v: &mut View, text: &str) {
    let ix = details_row(v, text).unwrap_or_else(|| panic!("no row {text:?}"));
    let d = details(v);
    let t = v.cx.read(|cx| d.read(cx).tree().clone());
    v.cx.update(|window, cx| {
        t.update(cx, |l, cx| {
            l.state.set_selection(Some(ix), []);
            cx.notify();
        });
        let h = gpui_kit::Focusable::focus_handle(t.read(cx), cx);
        window.focus(&h, cx);
    });
    v.pump();
}

#[test]
fn log_changed_files_and_details() {
    let dir = treerepo();
    let mut v = start(&dir);
    v.wait_until("strip", |v| {
        v.read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Log, cx).is_some())
    });
    let b = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Log, cx))
        .unwrap();
    left(&mut v, b.center());
    v.wait_until("changed files: a folder with its file count", |v| {
        active(v) == TabId::Log && details_rows(v).contains(&"frontend 3 files".to_owned())
    });
    let r = details_rows(&mut v);
    assert!(r.contains(&"apps/admin/src 2 files".to_owned()), "{r:?}");
    assert!(r.contains(&"packages/lib 1 file".to_owned()), "{r:?}");
    assert!(
        details_row(&mut v, "frontend").unwrap() < details_row(&mut v, "notes.txt").unwrap(),
        "folders before files"
    );
    let d = details(&mut v);
    assert!(
        v.cx.read(|cx| d.read(cx).tree().read(cx).delegate.rows()[0].is_folder()),
        "chevron on folders"
    );
    let hash = git(&dir, &["rev-parse", "--short=8", "HEAD"]);
    let when = git(
        &dir,
        &[
            "show",
            "-s",
            "--format=%ad",
            "--date=format:%Y-%m-%d at %H:%M",
            "HEAD",
        ],
    );
    v.wait_until(
        "commit details: subject, body, hash, author, date, branches",
        |v| {
            let d = details(v);
            let text = v.cx.read(|cx| d.read(cx).text_lines().join("\n"));
            text.contains("AB#2 Added two")
                && text.contains("Body line.")
                && text.contains(&hash)
                && text.contains("Ada Example <ada@example.com>")
                && text.contains(&when)
                && text.contains("In 1 branch: master")
        },
    );
    // ä: into the files; ö stops at the last, l / Up at the first
    v.key("ä");
    v.wait_until("files focused", details_focused);
    let n = details_rows(&mut v).len();
    for _ in 0..n + 3 {
        v.key("ö");
    }
    v.wait_until("last row", |v| details_cursor(v) == Some(n - 1));
    v.keystrokes("down down");
    assert_eq!(details_cursor(&mut v), Some(n - 1));
    // a click on the commit message keeps the caret on the files
    if let Some(t) = bounds(&mut v, "git-log-details-text") {
        left(&mut v, point(t.left() + px(30.), t.top() + px(12.)));
        assert!(details_focused(&mut v), "the files keep the keyboard");
        assert_eq!(details_cursor(&mut v), Some(n - 1));
    }
    for _ in 0..n + 2 {
        v.keystrokes("up");
    }
    v.wait_until("first row", |v| details_cursor(v) == Some(0));
    // folding: Left / Right, Left on a file goes to its folder, Enter on a folder folds
    details_goto(&mut v, "apps/admin/src");
    v.keystrokes("left");
    v.wait_until("folded", |v| details_row(v, "two.ts").is_none());
    v.keystrokes("right");
    v.wait_until("unfolded", |v| details_row(v, "two.ts").is_some());
    v.keystrokes("down left");
    let folder = details_row(&mut v, "apps/admin/src");
    v.wait_until("Left on a file: its folder", |v| {
        details_cursor(v) == folder
    });
    v.keystrokes("enter");
    v.wait_until("Enter folds", |v| details_row(v, "two.ts").is_none());
    v.keystrokes("enter");
    v.wait_until("Enter unfolds", |v| details_row(v, "two.ts").is_some());
    // the menu: Collapse All / Expand All
    v.keystrokes("cmd-enter");
    pick_menu(&mut v, "Collapse All");
    v.wait_until("only the top folders", |v| {
        details_row(v, "frontend 3 files").is_some() && details_row(v, "apps/admin").is_none()
    });
    v.keystrokes("cmd-enter");
    pick_menu(&mut v, "Expand All");
    v.wait_until("expanded", |v| details_row(v, "two.ts").is_some());
    // a refresh (the app window active again) keeps the caret in the files
    details_goto(&mut v, "one.ts");
    let at = details_cursor(&mut v);
    // (the app window deactivated and active again: FocusGained's refresh)
    let before = v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).refreshes.len());
    v.cx.deactivate_window();
    v.cx.update(|window, _| window.activate_window());
    v.wait_until("activation refresh", |v| {
        v.read_ws(|ws, cx| {
            let r = &ws.git().read(cx).log().read(cx).refreshes;
            r.len() > before && r.last() == Some(&vimstorm::git::window::RepoChange::Focus)
        })
    });
    v.settle();
    assert!(details_focused(&mut v) && details_cursor(&mut v) == at);
    // Enter: the diff, the keyboard stays; F4: the file in the editor
    v.keystrokes("enter");
    v.wait_until("diff", |v| diff_open(v));
    wait_target(&mut v, "git");
    assert!(details_focused(&mut v));
    close_diff(&mut v);
    details_goto(&mut v, "two.ts");
    v.keystrokes("f4");
    wait_target(&mut v, "split");
    v.wait_lua(
        "two.ts in the editor",
        "return vim.fn.expand('%:t') == 'two.ts'",
    );
    assert!(!git_focused(&mut v), "no keyboard in the Git tool window");
}

// Fix round ---------------------------------------------------------------------------------------

#[test]
fn cmd_shift_k_pushes_before_the_git_tool_window_ever_opened() {
    let fx = common::gitfix::fixture("grepo");
    let dir = fx.repo.clone();
    let mut v = View::start(dir.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    assert!(!git_open(&mut v));
    assert_ne!(remote_head(&fx), git(&dir, &["rev-parse", "HEAD"]));
    v.keystrokes("cmd-shift-k");
    v.wait_until("pushed from the editor", |v| {
        has_balloon(v, "Pushing…")
            && has_balloon(v, "Pushed")
            && remote_head(&fx) == git(&dir, &["rev-parse", "HEAD"])
    });
    assert!(!git_open(&mut v), "the tool window stays closed");
}

#[test]
fn a_commit_whose_marked_files_lost_their_changes_commits_nothing() {
    let dir = treerepo();
    let mut v = start(&dir);
    goto_row(&mut v, "notes.txt");
    v.keystrokes("space");
    v.wait_until("marked", |v| included(v) == ["notes.txt"]);
    // elsewhere: the marked change goes, another tracked file changes (the tab doesn't know yet)
    sh(&format!(
        "cd {} && git checkout -q -- notes.txt && echo more >> frontend/apps/admin/src/one.ts",
        dir.display()
    ));
    v.keystrokes("cmd-k");
    v.cx.simulate_input("Only notes");
    v.keystrokes("cmd-enter");
    v.wait_until("refused", |v| {
        has_balloon(v, "The marked files have no changes anymore")
    });
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "AB#2 Added two");
    assert_eq!(message(&mut v), "Only notes", "the message stays");
}

#[test]
fn window_activation_reloads_local_changes() {
    let dir = treerepo();
    let mut v = start(&dir);
    sh(&format!("cd {} && echo x > fresh.ts", dir.display()));
    assert!(!has_row(&mut v, "fresh.ts"));
    v.cx.deactivate_window();
    v.cx.update(|window, _| window.activate_window());
    v.wait_until("reloaded on activation", |v| {
        has_row(v, "fresh.ts") && has_row(v, "Unversioned Files 2 files")
    });
}

#[test]
fn commit_panel_amend_row_options_gear_and_default_button_on_focus() {
    let dir = treerepo();
    let mut v = start(&dir);
    // WS ChangesView.CommitToolbar: Amend in a row above the message
    let amend = bounds(&mut v, "lc-amend").unwrap();
    let msg = bounds(&mut v, "lc-message").unwrap();
    assert!(amend.bottom() <= msg.top(), "Amend above the message");
    // the ⚙ right of the buttons (CommitActionsPanel), its menu toggles Amend
    let push = bounds(&mut v, "button-lc-commit-push").unwrap();
    let gear = bounds(&mut v, "button-lc-options").unwrap();
    assert!(gear.left() > push.right() && (gear.center().y - push.center().y).abs() < px(2.));
    click_button(&mut v, "lc-options");
    pick_menu(&mut v, "Amend");
    v.wait_until("Amend on", |v| {
        let t = tab(v);
        v.cx.read(|cx| t.read(cx).amend())
    });
    // the default (blue) button only while the commit view has the keyboard
    let primary = |v: &mut View| {
        let b = bounds(v, "button-lc-commit").unwrap();
        let blue = look::hsla(look::BUTTON_PRIMARY_BG.rgba());
        v.cx.update(|window, _| {
            let s = window.scale_factor();
            window.painted_quads().into_iter().any(|q| {
                q.background.as_solid() == Some(blue)
                    && (q.bounds.origin.x.0 / s - b.left().as_f32()).abs() < 2.
                    && (q.bounds.origin.y.0 / s - b.top().as_f32()).abs() < 2.
            })
        })
    };
    v.wait_until("blue while focused", |v| git_focused(v) && primary(v));
    v.keystrokes("escape");
    v.wait_until("back in the editor: outlined", |v| {
        !git_focused(v) && !primary(v)
    });
}
