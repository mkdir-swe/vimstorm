//! The diff viewer and merge window with their native chrome, on the real nvim + config:
//! opened as Local Changes opens them (`config/app/git_changes.lua` `diff` / `merge`, what the
//! native tab's Enter / double-click calls), driven by real keys and mouse. The chrome (toolbar,
//! titles, gutters, connectors, icons, buttons) is `vimstorm::git::diff`: clicks land on its elements
//! / gutter icons, checks read its description and the frame it lays out; the panes are nvim's.
//! Every scenario of `tests/diff_merge_test.lua` (terminal Lua) is ported; the Lua cell clicks on
//! the toolbar / gutter text are clicks on the native chrome here.
//!
//! Scenario map (`lua: <check label> -> rust: <test fn>`):
//! - lua: Enter in Local Changes: the diff shows in one frame with toolbar count, file index and headers -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: headers: old side lock + 8-char hash + path, current side Current version -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: toolbar: arrows, viewer / ignore / highlight dropdowns, count and ✕ at the right edge -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: toolbar sits above and spans both panes -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: line numbers next to the middle, » on changes -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: no filler rows: deleted 'four' sits next to 'five' -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: line numbers on colored backgrounds by change: changed (both sides) / deleted / inserted, unchanged plain -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: changed line: the unchanged word plain, the added word highlighted -> rust: diff_opens_in_one_frame_with_its_chrome
//! - lua: Cmd+R on a change puts the old text back -> rust: revert_by_cmd_r_and_the_gutter_icon
//! - lua: the toolbar count follows (2 differences) -> rust: revert_by_cmd_r_and_the_gutter_icon
//! - lua: click on » reverts the change -> rust: revert_by_cmd_r_and_the_gutter_icon
//! - lua: toolbar ↓ jumps to the next change -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: highlight dropdown lists the modes, the current one checked -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: picking Highlight characters shows it in the toolbar -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: a whitespace-only change shows as changed -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: Ignore whitespaces: a whitespace-only change no longer counts, the toolbar shows the mode -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: opening a toolbar dropdown: the file isn't reformatted under it -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: right-click in the diff: Next / Previous Difference with ⌘Ö / ⌘L -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: ✕ closes the diff viewer: toolbar and headers gone, the split shows its file again -> rust: toolbar_buttons_dropdowns_menu_and_close
//! - lua: double-click on an untracked file: its diff, 1 difference -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: unversioned file's diff: no » to revert with -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: Cmd+R in an unversioned file's diff: nothing reverted, says why -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: unversioned file kept on disk -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: ,w in the Git tool window closes the diff viewer, focus stays there -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: commit diff: the right header is lock + 8-char hash, not Current version -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: Cmd+2 goes into a commit diff -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: ,q in the diff viewer closes it -> rust: untracked_file_commit_diff_and_close_keys
//! - lua: Cmd+Ö walks the changes down, toolbar keeps file and count -> rust: next_and_previous_change_across_files
//! - lua: Cmd+Ö past the last change: the next file's first change, focus stays in the diff -> rust: next_and_previous_change_across_files
//! - lua: next file: no frame mixing the two files -> rust: next_and_previous_change_across_files
//! - lua: Cmd+Ö at the last file's last change: stays -> rust: next_and_previous_change_across_files
//! - lua: Cmd+L before the first change: the previous file's last change -> rust: next_and_previous_change_across_files
//! - lua: Cmd+L: previous change -> rust: next_and_previous_change_across_files
//! - lua: Cmd+L in visual mode: previous change, selection ends -> rust: next_and_previous_change_across_files
//! - lua: Cmd+Ö from the old pane: next change -> rust: next_and_previous_change_across_files
//! - lua: after closing, Cmd+L in the file is Quick Definition again, not the diff's previous change -> rust: next_and_previous_change_across_files
//! - lua: whole file shown, nothing folded -> rust: long_file_folding_and_scroll_sync
//! - lua: zM folds unchanged code to a wavy line -> rust: long_file_folding_and_scroll_sync
//! - lua: click on the wavy line unfolds -> rust: long_file_folding_and_scroll_sync
//! - lua: wheel over the unfocused pane scrolls both, mapped through the diff -> rust: long_file_folding_and_scroll_sync
//! - lua: wheel over the focused pane scrolls both -> rust: long_file_folding_and_scroll_sync
//! - lua: old pane line numbers drawn after scrolling -> rust: long_file_folding_and_scroll_sync
//! - lua: keys in the focused pane scroll both -> rust: long_file_folding_and_scroll_sync
//! - lua: Cmd+Ö to a far change: panes in sync -> rust: long_file_folding_and_scroll_sync
//! - lua: Cmd+L back: the caret on the change, panes in sync -> rust: long_file_folding_and_scroll_sync
//! - lua: toolbar ↓ with the Git tool window focused: the far change, old pane follows, focus stays -> rust: long_file_folding_and_scroll_sync
//! - lua: V in a diff pane: selected rows full width -> rust: selection_rows_full_width
//! - lua: Esc clears the selection rows -> rust: selection_rows_full_width
//! - lua: narrow diff toolbar keeps count + ✕ -> rust: narrow_window_keeps_count_close_hash_and_equal_panes
//! - lua: diff panes equally wide after a resize -> rust: narrow_window_keeps_count_close_hash_and_equal_panes
//! - lua: narrow diff header keeps the hash -> rust: narrow_window_keeps_count_close_hash_and_equal_panes
//! - lua: no separator junction under the toolbar -> rust: narrow_window_keeps_count_close_hash_and_equal_panes
//! - lua: F4 in the old pane: the file at the matching current line -> rust: open_in_editor_by_f4_and_the_toolbar
//! - lua: toolbar ✎ with the Git tool window focused: the file at the diff caret's line -> rust: open_in_editor_by_f4_and_the_toolbar
//! - lua: diff in one split: headers in place of its tab bar, the other split keeps its tabs -> rust: the_diff_takes_over_one_split
//! - lua: after the diff: both splits show their tabs as before -> rust: the_diff_takes_over_one_split
//! - lua: rollback in Local Changes of the diff's file: the diff shows 0 differences -> rust: the_diff_follows_repo_changes
//! - lua: commit of the diff's file: the diff follows the new HEAD (header hash, 0 differences) -> rust: the_diff_follows_repo_changes
//! - lua: merge window headers: Changes from main / Result / Changes from feature -> rust: merge_window_look
//! - lua: merge toolbar: Accept Left / Accept Right / count / Apply -> rust: merge_window_look
//! - lua: result: base text in the conflict, non-conflicting changes merged -> rust: merge_window_look
//! - lua: caret on the conflict in the result -> rust: merge_window_look
//! - lua: conflict lines red over the whole line in all three panes, other changes keep their color -> rust: merge_window_look
//! - lua: merge sides equally wide after a resize -> rust: merge_window_look
//! - lua: narrow merge toolbar keeps count + Apply -> rust: merge_window_look
//! - lua: ✕ with unsaved work asks: Discard / Cancel -> rust: merge_unsaved_work_accept_and_save
//! - lua: Discard closes the merge window, no second prompt -> rust: merge_unsaved_work_accept_and_save
//! - lua: reopened: the result starts over -> rust: merge_unsaved_work_accept_and_save
//! - lua: Cmd+Z in an unedited result: nothing to undo, the text stays -> rust: merge_unsaved_work_accept_and_save
//! - lua: merge: Cmd+Ö next change, Cmd+L back -> rust: merge_unsaved_work_accept_and_save
//! - lua: merge menu: Next / Previous Change with ⌘Ö / ⌘L -> rust: merge_unsaved_work_accept_and_save
//! - lua: click on « accepts theirs: all conflicts resolved -> rust: merge_unsaved_work_accept_and_save
//! - lua: Save and finish writes the result to the file -> rust: merge_unsaved_work_accept_and_save
//! - lua: the file is marked resolved, the merge window closed -> rust: merge_unsaved_work_accept_and_save
//! - lua: Accept Left writes yours -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: Accept Left marks it resolved and closes the merge window -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: Cmd+Z after « : the base text, the conflict is back (1 conflict) -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: Apply with a conflict left: refused, nothing written or marked resolved -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: file still conflicted on disk -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: redo: resolved again -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: Mark as Resolved on the last conflict: Save and finish / Keep editing -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: Cmd+S after Mark as Resolved writes the result and marks the file resolved -> rust: merge_accept_left_undo_apply_and_mark_resolved
//! - lua: no errors in :messages (grepo / mrepo) -> rust: every test's `no_errors` at its end
//!
//! New in the app: merge_ignore_and_magic_resolve (× / magic wand icons, Resolve Simple
//! Conflicts), merge_panes_are_presented_together (3-pane scroll sync: keys, wheel, trackpad,
//! Cmd+Ö / Cmd+L, folds), diff_panes_stay_together_jumping_and_folded, chrome_follows_the_text.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::time::Duration;

use common::changes::{self, loaded};
use common::gitfix::{self, GitFixture, git};
use common::gitui::{active, menu_title, open_git};
use common::view::View;
use gpui_kit::{
    Bounds, CursorStyle, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Pixels, Point,
    ScrollDelta, TouchPhase, point, px, size,
};
use vimstorm::git::diff::Frame;
use vimstorm::git::diff::{ChangeKind, GutterIcon, Viewer, ViewerKind};
use vimstorm::git::window::TabId;
use vimstorm::git::window::changes::Pane;
use vimstorm::nvim::GridId;
use vimstorm::shell::{Gap, GapKind};

// Helpers --------------------------------------------------------------------------------------

/// A private copy of a fixture repo and the app on it with `files` open.
fn start(repo: &str, files: &[&str]) -> (View, GitFixture) {
    let fx = gitfix::fixture(repo);
    let v = View::start(fx.repo.to_str().unwrap(), files);
    (v, fx)
}

/// WebStorm's window size (1388 x 1081 = 30.png): the toolbar has room for every dropdown.
fn wide(v: &mut View) {
    v.cx.simulate_resize(size(px(1388.), px(1081.)));
    v.settle();
}

fn viewer(v: &mut View) -> Option<Viewer> {
    v.read_ws(|ws, cx| ws.diff().read(cx).viewer().cloned())
}

fn frame(v: &mut View) -> Frame {
    v.read_ws(|ws, cx| ws.diff().read(cx).frame(cx))
        .expect("a viewer is open")
}

fn wait_viewer(v: &mut View, label: &str, pred: impl Fn(&Viewer) -> bool) {
    v.wait_until(label, |v| viewer(v).as_ref().is_some_and(&pred));
}

fn differences(v: &mut View) -> Option<i64> {
    viewer(v).and_then(|x| x.toolbar.differences)
}

fn lua_str(v: &View, code: &str) -> String {
    v.lua(code).as_str().unwrap_or_default().to_owned()
}

fn lua_i64(v: &View, code: &str) -> i64 {
    v.lua(code).as_i64().unwrap_or(-1)
}

fn target(v: &View) -> String {
    lua_str(v, "return require('config.focus').target()")
}

fn wait_target(v: &mut View, want: &str) {
    v.wait_lua(
        &format!("focus.target() == {want}"),
        &format!("return require('config.focus').target() == '{want}'"),
    );
}

/// Diff windows: (current version, old version).
fn wins(v: &View) -> (i64, i64) {
    let w = v.lua("return require('git.diff').wins()");
    let w = w.as_array().expect("diff open");
    (w[0].as_i64().unwrap(), w[1].as_i64().unwrap())
}

/// Merge windows: (yours, result, theirs).
fn merge_wins(v: &View) -> (i64, i64, i64) {
    let w = v.lua("local w = require('git.merge').wins() return { w[2], w[1], w[3] }");
    let w = w.as_array().expect("merge open");
    (
        w[0].as_i64().unwrap(),
        w[1].as_i64().unwrap(),
        w[2].as_i64().unwrap(),
    )
}

fn caret(v: &View, win: i64) -> i64 {
    lua_i64(v, &format!("return vim.api.nvim_win_get_cursor({win})[1]"))
}

fn top(v: &View, win: i64) -> i64 {
    lua_i64(v, &format!("return vim.fn.line('w0', {win})"))
}

fn buf_name(v: &View, win: i64) -> String {
    lua_str(
        v,
        &format!(
            "return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf({win})), ':t')"
        ),
    )
}

fn grid_of(v: &mut View, win: i64) -> GridId {
    v.read(|e| {
        e.ui()
            .windows
            .iter()
            .find(|(_, w)| w.win == win)
            .map(|(g, _)| *g)
    })
    .unwrap_or_else(|| panic!("window {win} has no grid"))
}

/// Local Changes in grepo: src/a.ts, diff.ts, long.ts, src/new.ts.
const CHANGES: &str = "{ { path = 'src/a.ts', status = 'M' }, { path = 'diff.ts', status = 'M' }, \
     { path = 'long.ts', status = 'M' }, { path = 'src/new.ts', status = '?' } }";

/// Opens `file`'s diff the way the Local Changes tab does (Enter / double-click).
fn open_from_changes(v: &mut View, file: &str) {
    let index = ["src/a.ts", "diff.ts", "long.ts", "src/new.ts"]
        .iter()
        .position(|f| *f == file)
        .unwrap()
        + 1;
    v.lua(&format!(
        "require('config.app.git_changes').diff(require('git.cli').root, {CHANGES}, {index}, 'HEAD') return true"
    ));
}

fn open_merge(v: &mut View) {
    v.lua("require('config.app.git_changes').merge(require('git.cli').root, 'conflict.ts') return true");
    wait_viewer(v, "merge chrome", |x| x.viewer == ViewerKind::Merge);
}

fn bounds(v: &mut View, selector: &'static str) -> Bounds<Pixels> {
    v.pump();
    v.cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} not drawn"))
}

fn press(v: &mut View, at: Point<Pixels>, button: MouseButton, count: usize) {
    v.cx.simulate_event(MouseDownEvent {
        position: at,
        modifiers: Modifiers::default(),
        button,
        click_count: count,
        first_mouse: false,
    });
    v.cx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: Modifiers::default(),
        button,
        click_count: count,
    });
    v.pump();
}

fn click(v: &mut View, selector: &'static str) {
    let at = bounds(v, selector).center();
    press(v, at, MouseButton::Left, 1);
}

/// Center of the screen cell where `text` starts + `dx` cells (window coordinates).
fn text_pos(v: &mut View, text: &str, dx: usize) -> Point<Pixels> {
    let (r, c) = v.cell_of(text);
    v.cell_pos(r, c + dx)
}

fn menu_rows(v: &mut View) -> Vec<String> {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| p.menu_rows().unwrap_or_default())
}

fn menu_shortcut(v: &mut View, label: &str) -> Option<String> {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    p.read_with(&v.cx, |p, _| {
        p.menu_item(label)
            .and_then(|i| i.shortcut.map(|s| s.to_string()))
    })
}

fn wait_menu(v: &mut View, label: &str, pred: impl Fn(&[String]) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let last = menu_rows(v);
        if pred(&last) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {label}: menu rows {last:?}"
        );
        v.wait_until("an nvim event", |_| true);
        v.settle();
    }
}

/// Clicks a row of the open menu (its label, trimmed of a check mark).
fn click_menu(v: &mut View, label: &str) {
    let rows = menu_rows(v);
    let ix = rows
        .iter()
        .position(|r| r.trim_start_matches(['✓', ' ']) == label)
        .unwrap_or_else(|| panic!("{label:?} not in the menu: {rows:?}"));
    let sel: &'static str = Box::leak(format!("menu-row-{ix}").into_boxed_str());
    click(v, sel);
}

fn balloons(v: &mut View) -> String {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| {
        p.balloons()
            .iter()
            .map(|(t, b)| format!("{t}: {b}"))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn shown(v: &mut View, text: &str) -> bool {
    v.screen().iter().any(|l| l.contains(text)) || balloons(v).contains(text)
}

/// The rows of pane `pane` (1-based) with their lines, as the chrome lays them out now.
fn pane_lines(v: &mut View, pane: usize) -> Vec<i64> {
    frame(v).panes[pane - 1]
        .rows
        .rows
        .iter()
        .map(|r| r.line)
        .collect()
}

/// Somewhere on the first text row of pane `pane` (1-based): a click there puts the caret in it.
fn pane_point(v: &mut View, pane: usize) -> Point<Pixels> {
    let f = frame(v);
    let p = &f.panes[pane - 1];
    let r = p.rows.rows.first().expect("rows drawn").y;
    point(px(p.grid_x.0 + 40.), px(r + 5.))
}

/// Background color of grid cell (row, col) of window `win`.
fn cell_bg(v: &mut View, win: i64, row: usize, col: usize) -> u32 {
    let g = grid_of(v, win);
    v.read(|e| {
        let ui = e.ui();
        let cell = ui.grids[&g].cell(row, col).expect("cell").hl;
        ui.colors(cell).1
    })
}

/// (row, col) in window `win`'s grid where `text` starts.
fn grid_find(v: &mut View, win: i64, text: &str) -> (usize, usize) {
    let g = grid_of(v, win);
    v.read(|e| {
        let grid = &e.ui().grids[&g];
        (0..grid.height).find_map(|r| {
            let row = grid.row_text(r);
            let i = row.find(text)?;
            Some((r, row[..i].chars().count()))
        })
    })
    .unwrap_or_else(|| panic!("{text:?} not in window {win}"))
}

fn no_errors(v: &View) {
    let msgs = lua_str(v, "return vim.fn.execute('messages')");
    assert!(
        !msgs.contains("E5108") && !msgs.contains("stack traceback"),
        "errors in :messages:\n{msgs}"
    );
    assert_eq!(v.nvim_errors(), Vec::<String>::new(), "nvim error events");
}

fn file_line(v: &View, n: usize) -> String {
    lua_str(
        v,
        &format!("return vim.fn.getbufline(vim.fn.bufnr('diff.ts'), {n})[1]"),
    )
}

// Diff -----------------------------------------------------------------------------------------

#[test]
fn diff_opens_in_one_frame_with_its_chrome() {
    let (mut v, fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    wide(&mut v);
    open_from_changes(&mut v, "diff.ts");
    // every pump (frame) that shows the diff's text shows its chrome with it
    let mut frames = 0;
    v.wait_until("diff drawn with its chrome", |v| {
        let screen = v.screen().join("\n");
        if !screen.contains("seven") {
            return false;
        }
        let x = viewer(v).expect("the diff's text without its chrome");
        assert_eq!(x.toolbar.differences, Some(3), "count in that frame");
        assert_eq!(x.toolbar.files, Some((2, 4)), "file index in that frame");
        assert_eq!(x.panes[1].title.text.as_deref(), Some("Current version"));
        assert!(
            v.read_ws(|ws, cx| ws.diff().read(cx).frame(cx).unwrap().panes.len()) == 2,
            "both panes laid out with chrome"
        );
        frames += 1;
        frames >= 3
    });

    // headers
    let x = viewer(&mut v).unwrap();
    let head = git(&fx.repo, &["rev-parse", "--short=8", "HEAD"]);
    let old = &x.panes[0].title;
    assert!(old.lock);
    assert_eq!(old.hash.as_deref(), Some(head.trim()));
    assert_eq!(old.path.as_deref(), Some("diff.ts"));
    let t1 = bounds(&mut v, "diff-title-1");
    let t2 = bounds(&mut v, "diff-title-2");
    assert!(t1.right() <= t2.left(), "titles side by side");

    // toolbar: arrows, dropdowns, count + ✕ at the right edge, above and spanning both panes
    let tb = v.read(|e| {
        e.geometry()
            .layout
            .wins
            .iter()
            .find_map(|w| w.viewer)
            .unwrap()
            .toolbar
    });
    for sel in [
        "button-diff-prev",
        "button-diff-next",
        "button-diff-edit",
        "diff-dropdown-viewer",
        "diff-dropdown-ignore",
        "diff-dropdown-highlight",
        "diff-count",
    ] {
        let b = bounds(&mut v, sel);
        assert!(tb.contains(&b.center()), "{sel} in the toolbar");
    }
    // WS order: ↑ ↓ ✎ | ← → viewer ▾ | ignore ▾ highlight ▾ collapse sync
    let order: Vec<f32> = [
        "button-diff-next-file",
        "diff-dropdown-viewer",
        "diff-dropdown-ignore",
        "diff-dropdown-highlight",
        "button-diff-collapse",
        "button-diff-sync",
    ]
    .iter()
    .map(|s| bounds(&mut v, s).left().as_f32())
    .collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
    let viewer_end = bounds(&mut v, "diff-dropdown-viewer").right();
    let ignore = bounds(&mut v, "diff-dropdown-ignore").left();
    let highlight = bounds(&mut v, "diff-dropdown-highlight").left();
    let ignore_end = bounds(&mut v, "diff-dropdown-ignore").right();
    assert!(
        ignore - viewer_end > highlight - ignore_end + px(4.),
        "the separator between the viewer combo and ignore"
    );
    let close = bounds(&mut v, "button-diff-close");
    assert!(tb.right() - close.right() < px(12.), "✕ at the right edge");
    assert!(bounds(&mut v, "diff-count").right() <= close.left());
    assert!(tb.bottom() <= t1.top() && tb.left() <= t1.left() && tb.right() >= t2.right());
    assert_eq!(
        lua_i64(
            &v,
            "return #vim.tbl_filter(function(w) return vim.bo[vim.api.nvim_win_get_buf(w)].filetype == 'gittoolbar' end, vim.api.nvim_tabpage_list_wins(0))"
        ),
        0,
        "no toolbar window in nvim"
    );

    // line numbers by the middle, » on the changes
    v.focus_code();
    wait_target(&mut v, "diff");
    let f = frame(&mut v);
    let (p1, p2) = (&f.panes[0], &f.panes[1]);
    let div = p1.rect.divider.expect("divider");
    assert_eq!(
        p1.rect.gutter.right(),
        div.left(),
        "old pane's numbers next to the divider"
    );
    assert_eq!(
        p2.rect.gutter.left(),
        div.right(),
        "new pane's numbers next to the divider"
    );
    assert!(
        p1.rect.gutter.left() >= px(p1.grid_x.1),
        "old pane gutter right of its text"
    );
    let revert_lines: Vec<i64> = f
        .icons
        .iter()
        .filter(|i| i.icon == GutterIcon::Revert)
        .map(|i| {
            p1.rows
                .rows
                .iter()
                .find(|r| {
                    i.bounds.center().y.as_f32() >= r.y
                        && i.bounds.center().y.as_f32() < r.y + p1.rows.row_height
                })
                .map_or(0, |r| r.line)
        })
        .collect();
    assert!(
        revert_lines.contains(&2) && revert_lines.contains(&4),
        "» on changes: {revert_lines:?}"
    );
    for i in &f.icons {
        assert!(
            div.left() - i.bounds.right() < px(8.),
            "icon next to the divider"
        );
    }
    // no filler rows: old 'four' (4) on the row of new 'five' (4)
    let y = |p: &vimstorm::git::diff::PaneFrame, l: i64| p.rows.row_of(l).map(|r| r.y);
    assert_eq!(y(p1, 4), y(p2, 4));
    // change kinds: modified two/TWO, deleted four, inserted seven; unchanged lines plain
    let changes: Vec<_> = x.dividers[0]
        .iter()
        .map(|c| ((c.a.s, c.a.e), (c.b.s, c.b.e), c.kind))
        .collect();
    assert_eq!(
        changes,
        vec![
            ((2, 3), (2, 3), ChangeKind::Modified),
            ((4, 5), (4, 4), ChangeKind::Deleted),
            ((7, 7), (6, 7), ChangeKind::Inserted),
        ]
    );
    let colors: Vec<_> = [
        ChangeKind::Modified,
        ChangeKind::Deleted,
        ChangeKind::Inserted,
    ]
    .iter()
    .map(|k| vimstorm::git::diff::kind_bg(*k))
    .collect();
    assert!(colors[0] != colors[1] && colors[1] != colors[2] && colors[0] != colors[2]);

    // changed words inside a changed line
    v.keystrokes("3 shift-g shift-a space p l u s escape");
    v.wait_screen("three plus");
    let (new, _) = wins(&v);
    let (r, c) = grid_find(&mut v, new, "three plus");
    let word = cell_bg(&mut v, new, r, c);
    let added = cell_bg(&mut v, new, r, c + 6);
    assert_ne!(
        word, added,
        "the added word highlighted, the unchanged one plain"
    );
    v.keystrokes("cmd-z");
    v.wait_until("undone", |v| {
        !v.screen().iter().any(|l| l.contains("three plus"))
    });
    no_errors(&v);
}

#[test]
fn revert_by_cmd_r_and_the_gutter_icon() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    v.focus_code();
    wait_target(&mut v, "diff");
    v.keystrokes("2 shift-g cmd-r");
    v.wait_until("Cmd+R put the old text back", |v| file_line(v, 2) == "two");
    v.wait_until("the toolbar count follows", |v| differences(v) == Some(2));
    v.keystrokes("cmd-z");
    v.wait_until("undone", |v| {
        differences(v) == Some(3) && file_line(v, 2) == "TWO"
    });
    // click » on line 2's change
    v.wait_until("» drawn", |v| !frame(v).icons.is_empty());
    let icon = frame(&mut v)
        .icons
        .into_iter()
        .find(|i| i.action == "revert" && i.args.first().and_then(|a| a.as_i64()) == Some(1))
        .expect("» of the first change");
    press(&mut v, icon.bounds.center(), MouseButton::Left, 1);
    v.wait_until("» reverted the change", |v| file_line(v, 2) == "two");
    assert_eq!(target(&v), "diff", "the click doesn't move the keyboard");
    // the insertion's » (no filler row to put a caret on): seven goes
    v.wait_until("2 differences", |v| differences(v) == Some(2));
    let icon = frame(&mut v)
        .icons
        .into_iter()
        .find(|i| i.action == "revert" && i.args.first().and_then(|a| a.as_i64()) == Some(2))
        .expect("» of the insertion");
    press(&mut v, icon.bounds.center(), MouseButton::Left, 1);
    v.wait_until("the inserted line reverted", |v| {
        lua_i64(
            v,
            "return vim.api.nvim_buf_line_count(vim.fn.bufnr('diff.ts'))",
        ) == 5
            && differences(v) == Some(1)
    });
    no_errors(&v);
}

#[test]
fn toolbar_buttons_dropdowns_menu_and_close() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    wide(&mut v);
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    let at = text_pos(&mut v, "seven", 1);
    press(&mut v, at, MouseButton::Left, 1);
    wait_target(&mut v, "diff");
    v.keystrokes("g g");
    let (new, _) = wins(&v);
    v.wait_until("caret at the top", |v| caret(v, new) == 1);
    click(&mut v, "button-diff-next");
    v.wait_until("toolbar ↓: next change", |v| caret(v, new) == 2);

    // highlight dropdown: the modes, the current one checked; pick Highlight characters
    click(&mut v, "diff-dropdown-highlight");
    wait_menu(&mut v, "highlight modes", |r| {
        r.iter()
            .any(|l| l.contains("✓") && l.contains("Highlight words"))
            && r.iter().any(|l| l.contains("Highlight characters"))
    });
    click_menu(&mut v, "Highlight characters");
    wait_viewer(&mut v, "Highlight characters in the toolbar", |x| {
        x.toolbar.highlight == "Highlight characters"
    });
    // a whitespace-only change, then Ignore whitespaces
    let line1_changed = |v: &View| {
        v.lua(&format!(
            "return vim.api.nvim_win_call({new}, function() return vim.fn.diff_hlID(1, 1) ~= 0 end)"
        ))
        .as_bool()
            == Some(true)
    };
    v.keystrokes("1 shift-g shift-a space space escape");
    v.wait_until("a whitespace-only change shows as changed", |v| {
        line1_changed(v)
    });
    click(&mut v, "diff-dropdown-ignore");
    wait_menu(&mut v, "ignore modes", |r| {
        r.iter()
            .any(|l| l.contains("Ignore whitespaces and empty lines"))
    });
    click_menu(&mut v, "Ignore whitespaces");
    wait_viewer(&mut v, "Ignore whitespaces in the toolbar", |x| {
        x.toolbar.ignore == "Ignore whitespaces" && x.toolbar.differences == Some(3)
    });
    v.wait_until("whitespace change no longer counts", |v| !line1_changed(v));
    v.settle();
    assert_eq!(
        (file_line(&v, 1), file_line(&v, 2)),
        ("one  ".to_owned(), "TWO".to_owned()),
        "not reformatted under the dropdown"
    );
    v.keystrokes("cmd-z");

    // Collapse Unchanged Fragments (zM in every pane) and back; Synchronize Scrolling off and on
    wait_viewer(&mut v, "toggles: whole file, synced", |x| {
        !x.toolbar.collapsed && x.toolbar.synced
    });
    click(&mut v, "button-diff-collapse");
    wait_viewer(&mut v, "collapsed", |x| x.toolbar.collapsed);
    assert_eq!(
        lua_i64(&v, &format!("return vim.wo[{new}].foldenable and 1 or 0")),
        1
    );
    click(&mut v, "button-diff-collapse");
    wait_viewer(&mut v, "whole file", |x| !x.toolbar.collapsed);
    click(&mut v, "button-diff-sync");
    wait_viewer(&mut v, "not synced", |x| !x.toolbar.synced);
    click(&mut v, "button-diff-sync");
    wait_viewer(&mut v, "synced again", |x| x.toolbar.synced);

    // right-click in the pane: the diff's menu
    let at = text_pos(&mut v, "seven", 1);
    press(&mut v, at, MouseButton::Right, 1);
    wait_menu(&mut v, "diff menu", |r| {
        r.iter().any(|l| l == "Next Difference")
    });
    assert_eq!(
        menu_shortcut(&mut v, "Next Difference").as_deref(),
        Some("⌘Ö")
    );
    assert_eq!(
        menu_shortcut(&mut v, "Previous Difference").as_deref(),
        Some("⌘L")
    );
    v.keystrokes("escape");
    wait_menu(&mut v, "menu closed", |r| r.is_empty());
    // right-click on the native gutter: the same menu, caret on that line
    let f = frame(&mut v);
    let row = f.panes[0].rows.row_of(5).unwrap().y;
    let g = f.panes[0].rect.gutter;
    press(
        &mut v,
        point(g.center().x, px(row + 2.)),
        MouseButton::Right,
        1,
    );
    wait_menu(&mut v, "gutter menu", |r| {
        r.iter().any(|l| l == "Next Difference")
    });
    let (_, old) = wins(&v);
    assert_eq!(caret(&v, old), 5);
    v.keystrokes("escape");
    wait_menu(&mut v, "menu closed", |r| r.is_empty());

    // ✕ closes: chrome gone, the split shows its file again
    click(&mut v, "button-diff-close");
    v.wait_until("closed", |v| viewer(v).is_none());
    v.wait_screen("line one");
    assert_eq!(
        lua_i64(&v, "return #vim.api.nvim_tabpage_list_wins(0)"),
        lua_i64(
            &v,
            "return #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative ~= '' end, vim.api.nvim_tabpage_list_wins(0))"
        ) + 1,
        "one split again"
    );
    no_errors(&v);
}

#[test]
fn untracked_file_commit_diff_and_close_keys() {
    let (mut v, fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "src/new.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    assert!(
        frame(&mut v).icons.is_empty(),
        "no » on an untracked file's diff"
    );
    v.focus_code();
    wait_target(&mut v, "diff");
    v.keystrokes("cmd-r");
    v.wait_until("says why", |v| shown(v, "Nothing to revert"));
    assert_eq!(
        lua_str(
            &v,
            "return table.concat(vim.fn.getbufline(vim.fn.bufnr('new.ts'), 1, '$'), ',')"
        ),
        "new"
    );
    assert_eq!(
        std::fs::read_to_string(fx.repo.join("src/new.ts"))
            .unwrap()
            .trim(),
        "new"
    );
    // ,w in the Git tool window closes the viewer, the keyboard stays there
    open_git(&mut v);
    v.keystrokes(", w");
    v.wait_until(",w closed the diff", |v| viewer(v).is_none());
    assert_eq!(target(&v), "git");

    // a commit diff: both sides revisions
    v.lua("local f = { path = 'diff.ts', status = 'M' } require('git.diff').open({ f }, f, { old = 'HEAD~1', new = 'HEAD' }) return true");
    wait_viewer(&mut v, "commit diff", |x| x.panes[1].title.hash.is_some());
    let x = viewer(&mut v).unwrap();
    let head = git(&fx.repo, &["rev-parse", "--short=8", "HEAD"]);
    assert_eq!(x.panes[1].title.hash.as_deref(), Some(head.trim()));
    assert!(x.panes[1].title.lock && x.panes[1].title.text.is_none());
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.focus_code();
    wait_target(&mut v, "diff");
    v.keystrokes(", q");
    v.wait_until(",q closed it", |v| viewer(v).is_none());
    no_errors(&v);
}

#[test]
fn next_and_previous_change_across_files() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    v.focus_code();
    wait_target(&mut v, "diff");
    let (new, old) = wins(&v);
    v.keystrokes("g g");
    v.wait_until("top", |v| caret(v, new) == 1);
    let mut seen = Vec::new();
    for _ in 0..3 {
        let before = caret(&v, new);
        v.key("super+ö");
        v.wait_until("next change", |v| caret(v, new) != before);
        seen.push(caret(&v, new));
    }
    assert!(
        seen[0] > 1 && seen[1] > seen[0] && seen[2] > seen[1],
        "{seen:?}"
    );
    assert_eq!(buf_name(&v, new), "diff.ts");
    let x = viewer(&mut v).unwrap();
    assert_eq!(
        (x.toolbar.files, x.toolbar.differences),
        (Some((2, 4)), Some(3))
    );
    // past the last: the next file's first change, no frame mixing the files
    // every frame drawn while it switches: the chrome's file index with the panes' presented text
    v.read_ws(|ws, cx| ws.diff().read(cx).record_frames(true));
    v.key("super+ö");
    v.wait_until("long.ts", |v| {
        let x = viewer(v).unwrap();
        buf_name(v, new) == "long.ts" && caret(v, new) == 50 && x.toolbar.files == Some((3, 4))
    });
    v.settle();
    let frames = v.read_ws(|ws, cx| {
        let d = ws.diff().read(cx);
        let f = d.recorded_frames();
        d.record_frames(false);
        f
    });
    assert!(frames.len() >= 2, "frames recorded: {}", frames.len());
    for (i, (files, texts)) in frames.iter().enumerate() {
        let text = texts.join("\n");
        assert!(
            !(text.contains("new 1") && *files != Some((3, 4)))
                && !(text.contains("TWO") && *files == Some((3, 4)))
                && !(text.contains("TWO") && text.contains("new 1")),
            "frame {i} mixes the two files: {files:?}\n{text}"
        );
    }
    assert_eq!(differences(&mut v), Some(1));
    assert_eq!(target(&v), "diff");
    v.key("super+ö");
    wait_viewer(&mut v, "4/4", |x| x.toolbar.files == Some((4, 4)));
    v.key("super+ö");
    v.settle();
    assert_eq!((buf_name(&v, new).as_str(), caret(&v, new)), ("new.ts", 1));
    assert_eq!(viewer(&mut v).unwrap().toolbar.files, Some((4, 4)));
    v.key("super+l");
    wait_viewer(&mut v, "3/4", |x| x.toolbar.files == Some((3, 4)));
    v.key("super+l");
    v.wait_until("previous file's last change", |v| {
        buf_name(v, new) == "diff.ts" && caret(v, new) == seen[2]
    });
    assert_eq!(viewer(&mut v).unwrap().toolbar.files, Some((2, 4)));
    v.key("super+l");
    v.wait_until("previous change", |v| caret(v, new) == seen[1]);
    v.keystrokes("shift-v");
    v.wait_lua("visual", "return vim.fn.mode() == 'V'");
    v.key("super+l");
    v.wait_until("visual: previous change, selection ends", |v| {
        caret(v, new) == seen[0] && v.mode() == "n"
    });
    // from the old pane
    let at = pane_point(&mut v, 1);
    press(&mut v, at, MouseButton::Left, 1);
    v.wait_lua(
        "old pane current",
        &format!("return vim.api.nvim_get_current_win() == {old}"),
    );
    v.key("super+ö");
    v.wait_until("next change from the old pane", |v| {
        caret(v, new) == seen[1]
    });
    v.keystrokes(", q");
    v.wait_until("closed", |v| viewer(v).is_none());
    // Cmd+L is the editor's again
    v.lua("vim.cmd.edit('diff.ts') return true");
    v.key("super+l");
    v.wait_until("Quick Definition", |v| shown(v, "No definition"));
    no_errors(&v);
}

#[test]
fn long_file_folding_and_scroll_sync() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    v.focus_code();
    wait_target(&mut v, "diff");
    let (new, old) = wins(&v);
    v.keystrokes("g g");
    v.wait_until("whole file shown", |v| pane_lines(v, 2).contains(&20));
    v.keystrokes("z shift-m");
    v.wait_until("zM folds unchanged code", |v| {
        !pane_lines(v, 2).contains(&20)
    });
    // the fold's row: click its text (nvim's wavy line)
    let f = frame(&mut v);
    let fold = f.panes[1]
        .rows
        .rows
        .iter()
        .find(|r| r.folded)
        .expect("fold row")
        .y;
    press(
        &mut v,
        point(px(f.panes[1].grid_x.0 + 160.), px(fold + 4.)),
        MouseButton::Left,
        1,
    );
    v.wait_until("click on the wavy line unfolds", |v| {
        pane_lines(v, 2).contains(&20)
    });
    // the old pane's fold row in its native gutter unfolds too
    let at = pane_point(&mut v, 1);
    press(&mut v, at, MouseButton::Left, 1);
    v.wait_lua(
        "old pane current",
        &format!("return vim.api.nvim_get_current_win() == {old}"),
    );
    v.keystrokes("z shift-m");
    v.wait_until("folded again", |v| {
        frame(v).panes[0].rows.rows.iter().any(|r| r.folded)
    });
    let f = frame(&mut v);
    let fold = f.panes[0].rows.rows.iter().find(|r| r.folded).unwrap().y;
    press(
        &mut v,
        point(f.panes[0].rect.gutter.left() + px(4.), px(fold + 4.)),
        MouseButton::Left,
        1,
    );
    v.wait_until("gutter click unfolds", |v| {
        !frame(v).panes[0].rows.rows.iter().any(|r| r.folded)
    });
    v.keystrokes("z shift-r");
    v.lua(&format!("vim.api.nvim_set_current_win({new}) return true"));
    v.keystrokes("z shift-r");
    v.settle();

    let synced = |v: &View| long_old(top(v, new)) == top(v, old);
    // wheel over the unfocused pane
    let f = frame(&mut v);
    let over_old = point(
        px(f.panes[0].grid_x.0 + 80.),
        f.panes[0].clip.top() + px(100.),
    );
    let over_new = point(
        px(f.panes[1].grid_x.0 + 80.),
        f.panes[1].clip.top() + px(100.),
    );
    for _ in 0..25 {
        v.scroll(
            over_old,
            ScrollDelta::Lines(point(0., -1.)),
            TouchPhase::Moved,
        );
        v.pump();
    }
    v.wait_until("wheel over the old pane scrolls both", |v| {
        top(v, old) > 50 && synced(v)
    });
    let before = top(&v, new);
    for _ in 0..5 {
        v.scroll(
            over_new,
            ScrollDelta::Lines(point(0., -1.)),
            TouchPhase::Moved,
        );
        v.pump();
    }
    v.wait_until("wheel over the focused pane scrolls both", |v| {
        top(v, new) > before && synced(v)
    });
    // the old pane's numbers follow
    v.wait_until("old pane numbers drawn", |v| {
        pane_lines(v, 1).first().copied() == Some(top(v, old))
    });
    // the wheel over the divider scrolls the panes too
    let div = frame(&mut v).panes[0].rect.divider.unwrap();
    let before = top(&v, new);
    for _ in 0..3 {
        v.scroll(
            div.center(),
            ScrollDelta::Lines(point(0., 1.)),
            TouchPhase::Moved,
        );
        v.pump();
    }
    v.wait_until("wheel over the divider", |v| {
        top(v, new) < before && synced(v)
    });
    // keys
    v.keystrokes("1 2 0 shift-g z t");
    v.wait_until("keys scroll both", |v| top(v, new) > 100 && synced(v));
    // a far change: Cmd+Ö there and back
    v.keystrokes("1 9 5 shift-g shift-a space x escape g g");
    v.wait_until("two changes", |v| differences(v) == Some(2));
    v.key("super+ö");
    v.wait_until("first change", |v| caret(v, new) == 50);
    v.key("super+ö");
    v.wait_until("Cmd+Ö to a far change: in sync", |v| {
        caret(v, new) == 195 && synced(v)
    });
    v.key("super+l");
    v.wait_until("Cmd+L back: in sync", |v| caret(v, new) == 50 && synced(v));
    // toolbar ↓ from the Git tool window
    open_git(&mut v);
    click(&mut v, "button-diff-next");
    v.wait_until(
        "toolbar ↓: far change, old pane follows, focus stays",
        |v| caret(v, new) == 195 && top(v, new) > 150 && synced(v),
    );
    assert_eq!(target(&v), "git");
    no_errors(&v);
}

/// Old line shown next to the current version's line in long.ts (lines "new 1..10" inserted at 50).
fn long_old(l: i64) -> i64 {
    if l < 50 {
        l
    } else if l < 60 {
        50
    } else {
        l - 10
    }
}

#[test]
fn selection_rows_full_width() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    let (_, old) = wins(&v);
    let at = pane_point(&mut v, 1);
    press(&mut v, at, MouseButton::Left, 1);
    v.wait_lua(
        "old pane current",
        &format!("return vim.api.nvim_get_current_win() == {old}"),
    );
    v.keystrokes("g g 1 shift-g shift-v 3 shift-g");
    v.wait_lua("visual", "return vim.fn.mode() == 'V'");
    v.settle();
    let width = lua_i64(&v, &format!("return vim.api.nvim_win_get_width({old})")) as usize;
    let (r2, c2) = grid_find(&mut v, old, "line 2");
    let (r5, _) = grid_find(&mut v, old, "line 5");
    let edge = (width / 2).max(c2 + 10);
    let (text, end, plain) = (
        cell_bg(&mut v, old, r2, c2),
        cell_bg(&mut v, old, r2, edge),
        cell_bg(&mut v, old, r5, edge),
    );
    assert!(
        text == end && end != plain,
        "selected rows full width: {text:x} {end:x} {plain:x}"
    );
    v.keystrokes("escape");
    v.wait_until("selection cleared", |v| {
        cell_bg(v, old, r2, edge) == cell_bg(v, old, r5, edge)
    });
    no_errors(&v);
}

#[test]
fn narrow_window_keeps_count_close_hash_and_equal_panes() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    v.cx.simulate_resize(size(px(700.), px(700.)));
    v.settle();
    let tb = v.read(|e| {
        e.geometry()
            .layout
            .wins
            .iter()
            .find_map(|w| w.viewer)
            .unwrap()
            .toolbar
    });
    let count = bounds(&mut v, "diff-count");
    let close = bounds(&mut v, "button-diff-close");
    assert!(
        tb.contains(&count.center()) && tb.contains(&close.center()),
        "count + ✕ kept"
    );
    assert!(count.right() <= close.left());
    let (new, old) = wins(&v);
    let w = |win| lua_i64(&v, &format!("return vim.api.nvim_win_get_width({win})"));
    assert!(
        (w(new) - w(old)).abs() <= 1,
        "equal panes {} / {}",
        w(new),
        w(old)
    );
    let t1 = bounds(&mut v, "diff-title-1");
    assert!(t1.size.width > px(100.), "title room for lock + hash");
    // the hash label is laid out whole inside the title (the path gives way)
    let hash = bounds(&mut v, "diff-title-hash-1");
    assert!(
        hash.left() >= t1.left() && hash.right() <= t1.right(),
        "{hash:?} in {t1:?}"
    );
    assert!(hash.size.width > px(40.), "8 hex digits: {hash:?}");
    assert!(viewer(&mut v).unwrap().panes[0].title.hash.is_some());
    // no nvim separator row under the toolbar: the chrome is native, the panes start under it
    let f = frame(&mut v);
    assert!(f.panes.iter().all(|p| p.clip.top() >= t1.bottom()));
    no_errors(&v);
}

/// Divider `n` (left to right) of the open viewer: its gap and a point on its band clear of
/// the » icons.
fn divider(v: &mut View, n: usize) -> (Gap, Point<Pixels>) {
    v.settle();
    let mut gaps: Vec<Gap> = v.read(|e| {
        e.geometry()
            .layout
            .gaps
            .iter()
            .filter(|g| matches!(g.kind, GapKind::Divider { .. }))
            .copied()
            .collect()
    });
    gaps.sort_by(|a, b| {
        a.bounds
            .left()
            .as_f32()
            .total_cmp(&b.bounds.left().as_f32())
    });
    let gap = *gaps
        .get(n)
        .unwrap_or_else(|| panic!("divider {n} of {gaps:?}"));
    let f = frame(v);
    let at = (1..60)
        .map(|k| {
            point(
                gap.bounds.center().x,
                gap.bounds.bottom() - px(6. * k as f32),
            )
        })
        .find(|p| f.icon_at(*p).is_none())
        .expect("a place on the band without an icon");
    (gap, at)
}

fn width(v: &View, win: i64) -> i64 {
    lua_i64(v, &format!("return vim.api.nvim_win_get_width({win})"))
}

/// Divider `n`'s band dragged `cells` columns (negative: left) at a place without an icon.
fn drag_divider(v: &mut View, n: usize, cells: f32) {
    let (gap, at) = divider(v, n);
    let GapKind::Divider { col, .. } = gap.kind else {
        unreachable!()
    };
    let scale = v.read(|e| e.geometry().layout.x_editor.scale);
    let to = point(at.x + px(scale * cells), at.y);
    v.drag(
        at,
        to,
        &format!("return vim.fn.getmousepos().screencol == {}", col + 1),
    );
}

/// Each window's width is its `shares` of their total now (a column of rounding).
fn at_shares(v: &View, wins: &[i64], shares: &[f64]) -> bool {
    let ws: Vec<i64> = wins.iter().map(|w| width(v, *w)).collect();
    let total: i64 = ws.iter().sum();
    ws.iter()
        .zip(shares)
        .all(|(w, s)| (*w as f64 - s * total as f64).abs() <= 1.)
}

fn shares_of(v: &View, wins: &[i64]) -> Vec<f64> {
    let ws: Vec<i64> = wins.iter().map(|w| width(v, *w)).collect();
    let total: i64 = ws.iter().sum();
    ws.iter().map(|w| *w as f64 / total as f64).collect()
}

/// The divider between the diff's panes drags (resize cursor, its » icons still click: see
/// revert_by_cmd_r_and_the_gutter_icon); the panes keep their shares when the window resizes;
/// `:vertical resize` / <C-w>< set new ones; a double click on the divider makes them equal.
#[test]
fn dragging_the_diff_divider_and_the_panes_keep_their_shares() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    wide(&mut v);
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    let (new, old) = wins(&v);
    let (_, at) = divider(&mut v, 0);
    assert_eq!(
        v.read(|e| e.geometry().cursor_at(at)),
        CursorStyle::ResizeColumn
    );
    let before = width(&v, old);
    drag_divider(&mut v, 0, -10.);
    v.wait_lua(
        "the old pane 10 columns narrower",
        &format!(
            "return vim.api.nvim_win_get_width({old}) == {}",
            before - 10
        ),
    );
    let shares = shares_of(&v, &[old, new]);
    // the window narrower: the panes keep the dragged shares
    v.cx.simulate_resize(size(px(1100.), px(1081.)));
    v.settle();
    v.wait_until("the shares kept in a narrower window", |v| {
        at_shares(v, &[old, new], &shares)
    });
    // :vertical resize in the old pane: new shares, kept on the next resize
    let w = width(&v, old);
    v.lua(&format!(
        "vim.api.nvim_win_call({old}, function() vim.cmd('vertical resize -4') end) return true"
    ));
    v.wait_lua(
        ":vertical resize -4",
        &format!("return vim.api.nvim_win_get_width({old}) == {}", w - 4),
    );
    let shares = shares_of(&v, &[old, new]);
    wide(&mut v);
    v.wait_until("its shares kept in a wider window", |v| {
        at_shares(v, &[old, new], &shares)
    });
    // a double click on the divider: equal again
    let (_, at) = divider(&mut v, 0);
    press(&mut v, at, MouseButton::Left, 1);
    press(&mut v, at, MouseButton::Left, 2);
    v.wait_until("equal panes after the double click", |v| {
        (width(v, old) - width(v, new)).abs() <= 1
    });
    no_errors(&v);
}

#[test]
fn open_in_editor_by_f4_and_the_toolbar() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    let (_, old) = wins(&v);
    let at = pane_point(&mut v, 1);
    press(&mut v, at, MouseButton::Left, 1);
    v.wait_lua(
        "old pane current",
        &format!("return vim.api.nvim_get_current_win() == {old}"),
    );
    v.keystrokes("1 0 0 shift-g f4");
    v.wait_until("F4: the file at the matching line", |v| {
        viewer(v).is_none()
            && lua_str(v, "return vim.fn.expand('%:t')") == "long.ts"
            && lua_i64(v, "return vim.fn.line('.')") == 110
    });
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    v.focus_code();
    wait_target(&mut v, "diff");
    v.keystrokes("1 2 0 shift-g");
    let (new, _) = wins(&v);
    v.wait_until("caret 120", |v| caret(v, new) == 120);
    open_git(&mut v);
    click(&mut v, "button-diff-edit");
    v.wait_until("✎: the file at the caret's line", |v| {
        viewer(v).is_none()
            && lua_str(v, "return vim.fn.expand('%:t')") == "long.ts"
            && lua_i64(v, "return vim.fn.line('.')") == 120
    });
    no_errors(&v);
}

#[test]
fn the_diff_takes_over_one_split() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.keystrokes(", v");
    v.wait_until("two splits", |v| {
        v.read(|e| e.geometry().slots().len()) == 2
    });
    let before = v.read(|e| e.geometry().slots());
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    v.settle();
    let during = v.read(|e| e.geometry().slots());
    assert_eq!(
        during.len(),
        1,
        "the diff's split has titles instead of its tab bar"
    );
    assert!(
        before
            .iter()
            .any(|s| s.win == during[0].win && s.tab_bar == during[0].tab_bar),
        "the other split keeps its tab bar"
    );
    v.focus_code();
    wait_target(&mut v, "diff");
    v.keystrokes(", w");
    v.wait_until("closed, both tab bars back", |v| {
        viewer(v).is_none() && v.read(|e| e.geometry().slots()) == before
    });
    no_errors(&v);
}

/// Local Changes' own rollback and commit of the open diff's file: the diff follows (0
/// differences; after the commit its old side is the new HEAD).
#[test]
fn the_diff_follows_repo_changes() {
    let (mut v, fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    for _ in 0..3 {
        if active(&mut v) == TabId::Changes {
            break;
        }
        v.keystrokes("alt-cmd-left");
    }
    v.wait_until("Local Changes read", |v| {
        active(v) == TabId::Changes && loaded(v) && changes::has_row(v, "long.ts")
    });

    changes::goto_row(&mut v, "long.ts");
    v.keystrokes("enter");
    wait_viewer(&mut v, "long.ts diff: 1 difference", |x| {
        x.toolbar.differences == Some(1)
    });
    changes::goto_row(&mut v, "long.ts");
    v.keystrokes("cmd-z");
    v.wait_until("rollback confirmation", |v| {
        menu_title(v).is_some_and(|t| t.starts_with("Rollback 1 file(s)?"))
    });
    v.keystrokes("enter");
    wait_viewer(&mut v, "rollback: 0 differences", |x| {
        x.toolbar.differences == Some(0)
    });
    assert_eq!(
        git(&fx.repo, &["status", "--porcelain", "long.ts"]).trim(),
        ""
    );

    v.wait_until("diff.ts listed", |v| changes::has_row(v, "diff.ts"));
    changes::goto_row(&mut v, "diff.ts");
    v.keystrokes("enter");
    wait_viewer(&mut v, "diff.ts diff: 3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    changes::goto_row(&mut v, "diff.ts");
    v.keystrokes("space");
    v.wait_until("diff.ts marked", |v| changes::included(v) == ["diff.ts"]);
    v.keystrokes("cmd-k");
    v.wait_until("commit message focused", |v| {
        changes::pane(v) == Pane::Message && changes::hint(v) == "Commit 1 marked file(s)"
    });
    v.cx.simulate_input("Commit diff");
    v.keystrokes("cmd-enter");
    v.wait_until("committed", |_| {
        git(&fx.repo, &["log", "-1", "--format=%s"]).trim() == "Commit diff"
    });
    let head = git(&fx.repo, &["rev-parse", "--short=8", "HEAD"])
        .trim()
        .to_owned();
    wait_viewer(&mut v, "follows the new HEAD", |x| {
        x.toolbar.differences == Some(0) && x.panes[0].title.hash.as_deref() == Some(head.as_str())
    });
    no_errors(&v);
}

#[test]
fn chrome_follows_the_text() {
    // trackpad scrolling: the gutter's rows are the grid's rows as drawn (offset included)
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    let (new, _) = wins(&v);
    let grid = grid_of(&mut v, new);
    let f = frame(&mut v);
    let at = point(
        px(f.panes[1].grid_x.0 + 80.),
        f.panes[1].clip.top() + px(100.),
    );
    let row = v.read(|e| e.metrics().row_height);
    for i in 0..6 {
        let phase = if i == 0 {
            TouchPhase::Started
        } else {
            TouchPhase::Moved
        };
        v.scroll(at, ScrollDelta::Pixels(point(px(0.), -row * 0.4)), phase);
        v.pump();
        let (drawn, f) = v.read_ws(|ws, cx| {
            (
                ws.diff().read(cx).scx().drawn().get(grid),
                ws.diff().read(cx).frame(cx).unwrap(),
            )
        });
        let Some(drawn) = drawn else { continue };
        let top = drawn.topline.unwrap() + 1;
        let first_text_row = f.panes[1].rows.row_of(top).expect("topline's row drawn").y;
        let want = drawn
            .cell_origin(drawn.text_rows.start as i64, 0)
            .y
            .as_f32();
        assert!(
            (first_text_row - want).abs() < 0.01,
            "step {i}: gutter row {first_text_row} vs text {want}"
        );
    }
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(0.))),
        TouchPhase::Ended,
    );
    for _ in 0..30 {
        v.advance(Duration::from_millis(16));
    }
    no_errors(&v);
}

// Merge ----------------------------------------------------------------------------------------

fn result_text(v: &View) -> String {
    lua_str(
        v,
        "return table.concat(vim.api.nvim_buf_get_lines(vim.fn.bufnr('gitmerge://result/conflict.ts'), 0, -1, false), ',')",
    )
}

fn conflicts(v: &mut View) -> Option<i64> {
    viewer(v).and_then(|x| x.toolbar.conflicts)
}

fn merge_open(v: &mut View) -> bool {
    viewer(v).is_some_and(|x| x.viewer == ViewerKind::Merge)
}

fn file_text(fx: &GitFixture, name: &str) -> String {
    std::fs::read_to_string(fx.repo.join(name))
        .unwrap()
        .trim_end()
        .replace('\n', ",")
}

/// Clicks the first gutter icon `icon` drawn in pane `pane` (1-based).
fn click_icon(v: &mut View, pane: usize, icon: GutterIcon) {
    let find = |v: &mut View| {
        let f = frame(v);
        f.icons
            .iter()
            .find(|i| {
                i.icon == icon && f.pane_at(i.bounds.center()).is_some_and(|p| p.pane == pane)
            })
            .map(|i| i.bounds.center())
    };
    v.wait_until("icon drawn", |v| find(v).is_some());
    let at = find(v).unwrap();
    press(v, at, MouseButton::Left, 1);
}

/// Background of buffer line `line`'s cell `dx` after the gutter in pane `pane`'s grid (the
/// pane shows the file from its top).
fn line_bg(v: &mut View, win: i64, line: usize, dx: usize) -> u32 {
    let off = lua_i64(v, &format!("return vim.fn.getwininfo({win})[1].textoff")) as usize;
    let top = top(v, win) as usize;
    cell_bg(v, win, line - top, off + dx)
}

#[test]
fn merge_window_look() {
    let (mut v, _fx) = start("mrepo", &[]);
    wide(&mut v);
    open_merge(&mut v);
    let x = viewer(&mut v).unwrap();
    let titles: Vec<_> = x
        .panes
        .iter()
        .map(|p| (p.title.lock, p.title.text.clone().unwrap_or_default()))
        .collect();
    assert_eq!(
        titles,
        vec![
            (true, "Changes from main".to_owned()),
            (false, "Result".to_owned()),
            (true, "Changes from feature".to_owned()),
        ]
    );
    // toolbar: count; button row: Accept Left / Accept Right ... Cancel / Apply
    assert_eq!((x.toolbar.conflicts, x.toolbar.total), (Some(1), Some(1)));
    let rect = v.read(|e| {
        e.geometry()
            .layout
            .wins
            .iter()
            .find_map(|w| w.viewer)
            .unwrap()
    });
    let buttons = rect.buttons.expect("merge button row");
    for sel in [
        "button-merge-accept-left",
        "button-merge-accept-right",
        "button-merge-cancel",
        "button-merge-apply",
    ] {
        assert!(buttons.contains(&bounds(&mut v, sel).center()), "{sel}");
    }
    assert!(
        bounds(&mut v, "button-merge-accept-left").right()
            < bounds(&mut v, "button-merge-apply").left()
    );
    assert!(
        rect.toolbar
            .contains(&bounds(&mut v, "diff-count").center())
    );
    // MergeThreesideViewer: "Apply non-conflicting changes:" before the apply icons, the view
    // toggles after the dropdowns
    let label = bounds(&mut v, "merge-apply-label");
    assert!(bounds(&mut v, "button-diff-next").right() < label.left());
    assert!(label.right() < bounds(&mut v, "button-merge-apply-left").left());
    assert!(
        bounds(&mut v, "diff-dropdown-highlight").right()
            < bounds(&mut v, "button-diff-collapse").left()
    );
    assert!(x.toolbar.synced && !x.toolbar.collapsed);
    assert_eq!(result_text(&v), "a,b,c,d,E main,f,feature end");
    wait_target(&mut v, "merge");
    assert_eq!(
        lua_i64(&v, "return vim.fn.line('.')"),
        2,
        "caret on the conflict"
    );
    // conflict lines red over the whole line in all three panes, other changes their color
    let (yours, result, theirs) = merge_wins(&v);
    v.settle();
    let conflict = line_bg(&mut v, yours, 2, 0);
    let conflict_eol = line_bg(&mut v, yours, 2, 20);
    let merged = line_bg(&mut v, yours, 5, 20);
    let plain = line_bg(&mut v, yours, 1, 20);
    assert!(
        conflict == conflict_eol && conflict_eol != plain && merged != conflict && merged != plain
    );
    assert_eq!(line_bg(&mut v, result, 2, 20), conflict);
    assert_eq!(line_bg(&mut v, theirs, 2, 20), conflict);
    // the native chrome: a conflict connector on both dividers, accept / ignore icons on the sides
    let x = viewer(&mut v).unwrap();
    assert!(
        x.dividers
            .iter()
            .all(|d| d.iter().any(|c| c.kind == ChangeKind::Conflict))
    );
    let icons: Vec<_> = frame(&mut v).icons.iter().map(|i| i.icon).collect();
    for i in [
        GutterIcon::AcceptLeft,
        GutterIcon::AcceptRight,
        GutterIcon::Ignore,
    ] {
        assert!(icons.contains(&i), "{i:?} in {icons:?}");
    }
    // narrow: sides equally wide, count + Apply kept
    v.cx.simulate_resize(size(px(800.), px(700.)));
    v.settle();
    let w = |win| lua_i64(&v, &format!("return vim.api.nvim_win_get_width({win})"));
    assert_eq!(w(yours), w(theirs));
    let rect = v.read(|e| {
        e.geometry()
            .layout
            .wins
            .iter()
            .find_map(|w| w.viewer)
            .unwrap()
    });
    assert!(
        rect.toolbar
            .contains(&bounds(&mut v, "diff-count").center())
    );
    assert!(
        rect.buttons
            .unwrap()
            .contains(&bounds(&mut v, "button-merge-apply").center())
    );
    no_errors(&v);
}

/// The merge window's two dividers drag their sides; the sides keep their shares when the window
/// resizes; a double click on a divider makes all three equal.
#[test]
fn dragging_the_merge_dividers_and_the_sides_keep_their_shares() {
    let (mut v, _fx) = start("mrepo", &[]);
    wide(&mut v);
    open_merge(&mut v);
    let (yours, result, theirs) = merge_wins(&v);
    let all = [yours, result, theirs];
    let (y0, t0) = (width(&v, yours), width(&v, theirs));
    drag_divider(&mut v, 0, -8.);
    v.wait_lua(
        "yours 8 columns narrower",
        &format!("return vim.api.nvim_win_get_width({yours}) == {}", y0 - 8),
    );
    drag_divider(&mut v, 1, 6.);
    v.wait_lua(
        "theirs 6 columns narrower",
        &format!("return vim.api.nvim_win_get_width({theirs}) == {}", t0 - 6),
    );
    let shares = shares_of(&v, &all);
    v.cx.simulate_resize(size(px(1150.), px(1081.)));
    v.settle();
    v.wait_until("the shares kept in a narrower window", |v| {
        at_shares(v, &all, &shares)
    });
    let (_, at) = divider(&mut v, 1);
    press(&mut v, at, MouseButton::Left, 1);
    press(&mut v, at, MouseButton::Left, 2);
    v.wait_until("three equal sides after the double click", |v| {
        let w: Vec<i64> = all.iter().map(|w| width(v, *w)).collect();
        w.iter().max().unwrap() - w.iter().min().unwrap() <= 1
    });
    no_errors(&v);
}

#[test]
fn merge_unsaved_work_accept_and_save() {
    let (mut v, fx) = start("mrepo", &[]);
    wide(&mut v);
    open_merge(&mut v);
    wait_target(&mut v, "merge");
    v.keystrokes("1 shift-g shift-a space e d i t e d escape");
    v.wait_until("edited", |v| result_text(v).starts_with("a edited"));
    click(&mut v, "button-diff-close");
    wait_menu(&mut v, "Discard / Cancel", |r| {
        r.iter().any(|l| l == "Discard") && r.iter().any(|l| l == "Cancel")
    });
    v.keystrokes("enter");
    v.wait_until("Discard closed it, no second prompt", |v| {
        !merge_open(v) && menu_rows(v).is_empty()
    });
    assert_eq!(v.mode(), "n");
    open_merge(&mut v);
    assert_eq!(
        result_text(&v),
        "a,b,c,d,E main,f,feature end",
        "starts over"
    );
    wait_target(&mut v, "merge");
    v.keystrokes("cmd-z");
    v.settle();
    assert_eq!(
        result_text(&v),
        "a,b,c,d,E main,f,feature end",
        "nothing to undo"
    );
    // Cmd+Ö / Cmd+L
    v.key("super+ö");
    v.wait_until("next change", |v| {
        lua_i64(v, "return vim.fn.line('.')") != 2
    });
    let l1 = lua_i64(&v, "return vim.fn.line('.')");
    v.key("super+l");
    v.wait_until("back", |v| lua_i64(v, "return vim.fn.line('.')") == 2);
    assert!(l1 > 2);
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "merge menu", |r| {
        r.iter().any(|l| l == "Next Change")
    });
    assert_eq!(menu_shortcut(&mut v, "Next Change").as_deref(), Some("⌘Ö"));
    assert_eq!(
        menu_shortcut(&mut v, "Previous Change").as_deref(),
        Some("⌘L")
    );
    v.keystrokes("escape");
    wait_menu(&mut v, "closed", |r| r.is_empty());
    // « on their side accepts theirs: resolved, Save and finish
    click_icon(&mut v, 3, GutterIcon::AcceptRight);
    v.wait_until("theirs accepted", |v| {
        result_text(v).starts_with("a,B feature,") && conflicts(v) == Some(0)
    });
    wait_menu(&mut v, "Save and finish", |r| {
        r.iter().any(|l| l == "Save and finish")
    });
    v.keystrokes("enter");
    v.wait_until("written", |_| {
        file_text(&fx, "conflict.ts") == "a,B feature,c,d,E main,f,feature end"
    });
    v.wait_until("resolved and closed", |v| {
        git(&fx.repo, &["status", "--porcelain"]).trim() == "M  conflict.ts" && !merge_open(v)
    });
    no_errors(&v);
}

/// mrepo's conflict again (after a resolution).
fn conflict_again(fx: &GitFixture) {
    let _ = std::process::Command::new("git")
        .args(["-C", fx.repo.to_str().unwrap(), "merge", "--abort"])
        .output();
    let _ = std::process::Command::new("git")
        .args(["-C", fx.repo.to_str().unwrap(), "merge", "feature"])
        .output();
}

#[test]
fn merge_accept_left_undo_apply_and_mark_resolved() {
    let (mut v, fx) = start("mrepo", &[]);
    wide(&mut v);
    open_merge(&mut v);
    click(&mut v, "button-merge-accept-left");
    v.wait_until("Accept Left wrote yours", |_| {
        file_text(&fx, "conflict.ts") == "a,B main,c,d,E main,f"
    });
    v.wait_until("resolved, closed", |v| {
        git(&fx.repo, &["ls-files", "-u"]).is_empty() && !merge_open(v)
    });
    conflict_again(&fx);
    open_merge(&mut v);
    click_icon(&mut v, 3, GutterIcon::AcceptRight);
    wait_menu(&mut v, "Save and finish", |r| {
        r.iter().any(|l| l == "Keep editing")
    });
    click_menu(&mut v, "Keep editing");
    wait_menu(&mut v, "closed", |r| r.is_empty());
    let at = pane_point(&mut v, 2);
    press(&mut v, at, MouseButton::Left, 1);
    v.keystrokes("cmd-z");
    v.wait_until("undo brings the conflict back", |v| {
        result_text(v) == "a,b,c,d,E main,f,feature end" && conflicts(v) == Some(1)
    });
    // the "Resolved conflict.ts" balloon of the Accept Left above sits over Apply until it expires
    let ids = |v: &mut View| {
        let p = v.read_ws(|ws, _| ws.popups().clone());
        p.read_with(&v.cx, |p, _| p.balloon_ids())
    };
    for _ in 0..20 {
        if ids(&mut v).is_empty() {
            break;
        }
        v.advance(Duration::from_secs(2));
    }
    click(&mut v, "button-merge-apply");
    v.wait_until("Apply refused", |v| shown(v, "1 conflict(s) left"));
    assert!(merge_open(&mut v));
    assert!(!git(&fx.repo, &["ls-files", "-u"]).is_empty());
    assert!(
        std::fs::read_to_string(fx.repo.join("conflict.ts"))
            .unwrap()
            .contains("<<<<<<<")
    );
    v.keystrokes("cmd-shift-z");
    v.wait_until("redo: resolved again", |v| {
        result_text(v).starts_with("a,B feature,") && conflicts(v) == Some(0)
    });
    v.keystrokes("cmd-z");
    v.wait_until("1 conflict", |v| conflicts(v) == Some(1));
    // Mark as Resolved (Alt+Enter on the conflict), keep editing, Cmd+S saves
    v.keystrokes("2 shift-g alt-enter");
    wait_menu(&mut v, "conflict menu", |r| {
        r.iter().any(|l| l.starts_with("Mark as Resolved"))
    });
    click_menu(&mut v, "Mark as Resolved (keep Result)");
    wait_menu(&mut v, "Save and finish / Keep editing", |r| {
        r.iter().any(|l| l == "Save and finish") && r.iter().any(|l| l == "Keep editing")
    });
    click_menu(&mut v, "Keep editing");
    wait_menu(&mut v, "closed", |r| r.is_empty());
    v.keystrokes("cmd-s");
    v.wait_until("Cmd+S wrote the result and resolved it", |_| {
        file_text(&fx, "conflict.ts") == "a,b,c,d,E main,f,feature end"
            && git(&fx.repo, &["ls-files", "-u"]).is_empty()
    });
    no_errors(&v);
}

/// A repo in the middle of a merge of `feature` into `main` with the given file texts.
fn conflict_repo(base: &str, ours: &str, theirs: &str) -> tempfile::TempDir {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-merge-")
        .tempdir()
        .unwrap();
    let dir = tmp.path();
    let run = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        out.status.success()
    };
    let write = |text: &str| std::fs::write(dir.join("conflict.ts"), text).unwrap();
    assert!(run(&["init", "-q", "-b", "main"]));
    run(&["config", "user.name", "T"]);
    run(&["config", "user.email", "t@x.se"]);
    write(base);
    run(&["add", "-A"]);
    run(&["commit", "-q", "-m", "base"]);
    run(&["checkout", "-q", "-b", "feature"]);
    write(theirs);
    run(&["commit", "-q", "-am", "theirs"]);
    run(&["checkout", "-q", "main"]);
    write(ours);
    run(&["commit", "-q", "-am", "ours"]);
    assert!(!run(&["merge", "-q", "feature"]), "a conflict");
    tmp
}

fn start_dir(dir: &std::path::Path) -> View {
    View::start(dir.canonicalize().unwrap().to_str().unwrap(), &[])
}

#[test]
fn merge_ignore_and_magic_resolve() {
    // conflict 1: both sides changed different words of one line (resolvable word by word);
    // conflict 2: both changed the same word
    let base = "let a = 1, b = 2;\nx\ny\nz\nconst name = 'base';\n";
    let ours = "let A = 1, b = 2;\nx\ny\nz\nconst name = 'ours';\n";
    let theirs = "let a = 1, b = 3;\nx\ny\nz\nconst name = 'theirs';\n";
    let tmp = conflict_repo(base, ours, theirs);
    let mut v = start_dir(tmp.path());
    wide(&mut v);
    open_merge(&mut v);
    let result = |v: &View| {
        lua_str(
            v,
            "return table.concat(vim.api.nvim_buf_get_lines(vim.fn.bufnr('gitmerge://result/conflict.ts'), 0, -1, false), '|')",
        )
    };
    let x = viewer(&mut v).unwrap();
    assert_eq!((x.toolbar.conflicts, x.toolbar.simple), (Some(2), Some(1)));
    // the wand on the simple one (result gutter) resolves it word by word
    click_icon(&mut v, 2, GutterIcon::Magic);
    v.wait_until("magic resolved conflict 1", |v| {
        result(v).starts_with("let A = 1, b = 3;|") && conflicts(v) == Some(1)
    });
    assert_eq!(viewer(&mut v).unwrap().toolbar.simple, Some(0));
    // × ignores both sides of the other: resolved, the result keeps the base text
    click_icon(&mut v, 3, GutterIcon::Ignore);
    v.wait_until("ignored", |v| conflicts(v) == Some(0));
    assert!(
        result(&v).ends_with("const name = 'base';"),
        "{}",
        result(&v)
    );
    wait_menu(&mut v, "Save and finish", |r| {
        r.iter().any(|l| l == "Keep editing")
    });
    click_menu(&mut v, "Keep editing");
    // undo both, then the toolbar's Resolve Simple Conflicts
    v.keystrokes("cmd-z cmd-z");
    v.wait_until("both back", |v| conflicts(v) == Some(2));
    click(&mut v, "button-merge-magic");
    v.wait_until("toolbar wand", |v| {
        result(v).starts_with("let A = 1, b = 3;|") && conflicts(v) == Some(1)
    });
    // the conflict menu offers it too
    v.lua("require('git.merge').close(true) return true");
    v.wait_until("closed", |v| !merge_open(v));
    open_merge(&mut v);
    wait_target(&mut v, "merge");
    v.keystrokes("1 shift-g alt-enter");
    wait_menu(&mut v, "conflict menu", |r| {
        r.iter().any(|l| l == "Resolve Automatically")
    });
    click_menu(&mut v, "Resolve Automatically");
    v.wait_until("menu resolved it", |v| {
        result(v).starts_with("let A = 1, b = 3;|")
    });
    no_errors(&v);
}

// Scroll sync ----------------------------------------------------------------------------------

/// Every topline combination the panes `wins` may line up at: each pane at each line, the others
/// where `git/scrollsync.lua` maps it (what Lua's "synced" marker allows).
fn valid_tops(v: &View, wins: &[i64]) -> std::collections::HashSet<Vec<i64>> {
    let list = wins
        .iter()
        .map(|w| w.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let out = v.lua(&format!(
        "local ss = require('git.scrollsync') local w = {{ {list} }} local out = {{}} \
         local function n(win) return vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win)) end \
         for _, src in ipairs(w) do for t = 1, n(src) do local tops = {{}} \
           for j, o in ipairs(w) do tops[j] = o == src and t or math.min(ss.map(t, ss.win_changes(src, o)), n(o)) end \
           out[#out + 1] = table.concat(tops, ',') end end return out"
    ));
    out.as_array()
        .unwrap()
        .iter()
        .map(|s| {
            s.as_str()
                .unwrap()
                .split(',')
                .map(|n| n.parse().unwrap())
                .collect()
        })
        .collect()
}

/// Checks every frame presented since recording started: the panes line up (1-based tops in
/// `wins` order). Returns how many frames were checked.
fn check_presented(v: &mut View, wins: &[i64], what: &str) -> usize {
    let valid = valid_tops(v, wins);
    let grids: Vec<GridId> = wins.iter().map(|w| grid_of(v, *w)).collect();
    let log = v.read(|e| e.presented_log().to_vec());
    let mut n = 0;
    for (i, p) in log.iter().enumerate() {
        let tops: Option<Vec<i64>> = grids
            .iter()
            .map(|g| p.panes.iter().find(|x| x.0 == *g).map(|x| x.1 + 1))
            .collect();
        let Some(tops) = tops else { continue };
        if !valid.contains(&tops) {
            let mut sample: Vec<_> = valid
                .iter()
                .filter(|t| (t[0] - tops[0]).abs() < 3)
                .cloned()
                .collect();
            sample.sort();
            eprintln!("VALID near: {sample:?} (of {})", valid.len());
        }
        assert!(
            valid.contains(&tops),
            "{what}: frame {i} shows the panes apart: {tops:?} ({p:?})"
        );
        n += 1;
    }
    v.view
        .update(&mut v.cx, |e, _| e.sync_mut().record_presented(true));
    n
}

fn record(v: &mut View) {
    v.settle();
    v.view
        .update(&mut v.cx, |e, _| e.sync_mut().record_presented(true));
}

/// 400 lines with ours inserting 10 lines at 50, both changing line 150 (a conflict), theirs
/// deleting 200..=209 and changing line 300 alone.
fn long_conflict_repo() -> tempfile::TempDir {
    let lines = |f: &dyn Fn(usize) -> Vec<String>| -> String {
        (1..=400).flat_map(f).map(|l| l + "\n").collect()
    };
    let base = lines(&|i| vec![format!("line {i}")]);
    let ours = lines(&|i| match i {
        50 => std::iter::once(format!("line {i}"))
            .chain((1..=10).map(|k| format!("ours {k}")))
            .collect(),
        150 => vec!["OURS 150".into()],
        _ => vec![format!("line {i}")],
    });
    let theirs = lines(&|i| match i {
        150 => vec!["THEIRS 150".into()],
        200..=209 => vec![],
        300 => vec!["THEIRS 300".into()],
        _ => vec![format!("line {i}")],
    });
    conflict_repo(&base, &ours, &theirs)
}

/// Wheel `notches` (+ = down the file) at `at`, a frame each.
fn wheel(v: &mut View, at: Point<Pixels>, notches: i32) {
    for _ in 0..notches.abs() {
        let dy = if notches > 0 { -1. } else { 1. };
        v.scroll(at, ScrollDelta::Lines(point(0., dy)), TouchPhase::Moved);
        v.pump();
    }
    v.settle();
}

/// A trackpad gesture of `steps` moves of `rows` rows each (+ = down), then its end and settle.
fn trackpad(v: &mut View, at: Point<Pixels>, steps: usize, rows: f32) {
    let row = v.read(|e| e.metrics().row_height);
    for i in 0..steps {
        let phase = if i == 0 {
            TouchPhase::Started
        } else {
            TouchPhase::Moved
        };
        v.scroll(at, ScrollDelta::Pixels(point(px(0.), -row * rows)), phase);
        v.pump();
    }
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(0.))),
        TouchPhase::Ended,
    );
    for _ in 0..30 {
        v.advance(Duration::from_millis(16));
    }
    v.settle();
}

fn over(v: &mut View, pane: usize) -> Point<Pixels> {
    let f = frame(v);
    let p = &f.panes[pane - 1];
    point(px((p.grid_x.0 + p.grid_x.1) / 2.), p.clip.top() + px(120.))
}

#[test]
fn merge_panes_are_presented_together() {
    let tmp = long_conflict_repo();
    let mut v = start_dir(tmp.path());
    record(&mut v);
    open_merge(&mut v);
    wait_target(&mut v, "merge");
    let (yours, result, theirs) = merge_wins(&v);
    let wins = [yours, result, theirs];
    v.wait_until("drawn", |v| {
        frame(v).panes.iter().all(|p| !p.rows.rows.is_empty())
    });
    let mut frames = check_presented(&mut v, &wins, "opening");
    // keys in the result: Ctrl+D / Ctrl+U, j held
    v.keystrokes("g g");
    v.settle();
    for _ in 0..6 {
        v.keystrokes("ctrl-d");
        v.pump();
    }
    v.settle();
    for _ in 0..2 {
        v.keystrokes("ctrl-u");
        v.pump();
    }
    for i in 0..40 {
        v.key("ö");
        if i % 4 == 0 {
            v.pump();
        }
    }
    v.settle();
    frames += check_presented(&mut v, &wins, "keys");
    // the mouse wheel over each pane (also the unfocused ones) and the divider
    let (a, b, c) = (over(&mut v, 1), over(&mut v, 2), over(&mut v, 3));
    wheel(&mut v, a, 12);
    wheel(&mut v, c, 15);
    wheel(&mut v, b, -10);
    let div = frame(&mut v).panes[1].rect.divider.unwrap().center();
    wheel(&mut v, div, 6);
    frames += check_presented(&mut v, &wins, "wheel");
    // trackpad: sub-row offsets, momentum, settle
    trackpad(&mut v, b, 14, 0.6);
    trackpad(&mut v, a, 10, -0.7);
    trackpad(&mut v, c, 10, 0.9);
    frames += check_presented(&mut v, &wins, "trackpad");
    // Cmd+Ö / Cmd+L jumps (the conflict, theirs' change at 300, back)
    v.keystrokes("g g");
    for _ in 0..4 {
        v.key("super+ö");
        v.settle();
    }
    for _ in 0..3 {
        v.key("super+l");
        v.settle();
    }
    frames += check_presented(&mut v, &wins, "Cmd+Ö / Cmd+L");
    // folded unchanged code in all three
    v.lua(&format!(
        "for _, w in ipairs({{ {yours}, {result}, {theirs} }}) do vim.wo[w].foldenable = true vim.wo[w].foldlevel = 0 end return true"
    ));
    v.keystrokes("g g");
    v.settle();
    for _ in 0..3 {
        v.key("super+ö");
        v.settle();
    }
    wheel(&mut v, a, -8);
    wheel(&mut v, c, 8);
    trackpad(&mut v, b, 8, -0.8);
    v.keystrokes("ctrl-d ctrl-u");
    v.settle();
    frames += check_presented(&mut v, &wins, "folded");
    assert!(frames >= 40, "only {frames} frames presented");
    assert!(!v.read(|e| e.sync().holding()), "nothing left held");
    // nvim's own panes line up at the end
    let tops: Vec<i64> = wins.iter().map(|w| top(&v, *w)).collect();
    assert!(valid_tops(&v, &wins).contains(&tops), "{tops:?}");
    no_errors(&v);
}

#[test]
fn diff_panes_stay_together_jumping_and_folded() {
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "long.ts");
    wait_viewer(&mut v, "1 difference", |x| x.toolbar.differences == Some(1));
    v.focus_code();
    wait_target(&mut v, "diff");
    let (new, old) = wins(&v);
    let wins = [new, old];
    // a second change far down
    v.keystrokes("1 9 5 shift-g shift-a space x escape g g");
    v.wait_until("two changes", |v| differences(v) == Some(2));
    record(&mut v);
    // to the far change and back (not past the last: that's the next file)
    for k in ["super+ö", "super+ö", "super+l", "super+ö", "super+l"] {
        v.key(k);
        v.settle();
    }
    assert_eq!(buf_name(&v, new), "long.ts");
    let mut frames = check_presented(&mut v, &wins, "Cmd+Ö / Cmd+L");
    // folds in both panes
    v.lua(&format!(
        "for _, w in ipairs({{ {new}, {old} }}) do vim.wo[w].foldenable = true vim.wo[w].foldlevel = 0 end return true"
    ));
    v.keystrokes("g g");
    v.settle();
    for k in ["super+ö", "super+ö", "super+l"] {
        v.key(k);
        v.settle();
    }
    let (a, b) = (over(&mut v, 1), over(&mut v, 2));
    wheel(&mut v, a, -5);
    wheel(&mut v, b, 5);
    trackpad(&mut v, a, 8, 0.7);
    frames += check_presented(&mut v, &wins, "folded");
    assert!(frames >= 10, "only {frames} frames presented");
    no_errors(&v);
}

// Fix round ------------------------------------------------------------------------------------

/// Center of the last text column of window `win`'s grid on buffer line `line` (pane from its top).
fn right_edge(v: &mut View, win: i64, line: i64) -> Point<Pixels> {
    let g = grid_of(v, win);
    let width = v.read(|e| e.ui().grids[&g].width);
    let row = (line - top(v, win)) as usize;
    v.grid_pos(g, row, width - 1)
}

#[test]
fn clicks_on_the_text_never_revert_or_accept() {
    // the old Lua » / « click zones sat at a pane's right edge; in the app that's text
    let (mut v, _fx) = start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_from_changes(&mut v, "diff.ts");
    wait_viewer(&mut v, "3 differences", |x| {
        x.toolbar.differences == Some(3)
    });
    let (_, old) = wins(&v);
    for dx in [0., -8.] {
        let at = right_edge(&mut v, old, 2);
        press(&mut v, point(at.x + px(dx), at.y), MouseButton::Left, 1);
        v.settle();
        assert_eq!(
            file_line(&v, 2),
            "TWO",
            "a click on the old pane's text reverted the change"
        );
    }
    assert_eq!(differences(&mut v), Some(3));
    v.wait_lua(
        "the click put the caret there",
        &format!("return vim.api.nvim_get_current_win() == {old} and vim.fn.line('.') == 2"),
    );
    no_errors(&v);

    let (mut v, _fx) = start("mrepo", &[]);
    open_merge(&mut v);
    let (yours, _, theirs) = merge_wins(&v);
    for win in [yours, theirs] {
        let at = right_edge(&mut v, win, 2);
        press(&mut v, at, MouseButton::Left, 1);
        v.settle();
        assert_eq!(
            conflicts(&mut v),
            Some(1),
            "a click on a side's text accepted it"
        );
        let at = text_pos(&mut v, if win == yours { "B main" } else { "B feature" }, 0);
        press(&mut v, at, MouseButton::Left, 1);
        v.settle();
        assert_eq!(conflicts(&mut v), Some(1));
    }
    assert_eq!(result_text(&v), "a,b,c,d,E main,f,feature end");
    no_errors(&v);
}

#[test]
fn narrow_merge_window_keeps_apply_in_view() {
    let (mut v, _fx) = start("mrepo", &[]);
    open_merge(&mut v);
    // (window width, Accept Left shown, Accept Right shown)
    for (w, left, right) in [
        (1100., true, true),
        (700., true, false),
        (560., false, false),
    ] {
        v.cx.simulate_resize(size(px(w), px(700.)));
        v.settle();
        let rect = v.read(|e| {
            e.geometry()
                .layout
                .wins
                .iter()
                .find_map(|r| r.viewer)
                .unwrap()
        });
        let row = rect.buttons.unwrap();
        let apply = bounds(&mut v, "button-merge-apply");
        assert!(
            apply.left() >= row.left() && apply.right() <= row.right(),
            "{w}: Apply {apply:?} outside the viewer {row:?}"
        );
        v.pump();
        assert_eq!(
            v.cx.debug_bounds("button-merge-accept-left").is_some(),
            left,
            "{w}: Accept Left"
        );
        assert_eq!(
            v.cx.debug_bounds("button-merge-accept-right").is_some(),
            right,
            "{w}: Accept Right"
        );
        if let Some(c) = v.cx.debug_bounds("button-merge-cancel") {
            assert!(c.right() <= apply.left(), "{w}: Cancel before Apply");
        }
    }
    no_errors(&v);
}

#[test]
fn merge_chrome_shows_each_side_against_the_base() {
    let (mut v, _fx) = start("mrepo", &[]);
    wide(&mut v);
    open_merge(&mut v);
    let x = viewer(&mut v).unwrap();
    let d = |i: usize| -> Vec<_> {
        x.dividers[i]
            .iter()
            .map(|c| ((c.a.s, c.a.e), (c.b.s, c.b.e), c.kind))
            .collect()
    };
    // yours: B main (conflict), E main (its own change, merged into the result at 5)
    assert_eq!(
        d(0),
        vec![
            ((2, 3), (2, 3), ChangeKind::Conflict),
            ((5, 6), (5, 6), ChangeKind::Modified),
        ]
    );
    // theirs: B feature (conflict), feature end (inserted, merged into the result at 7); its
    // unchanged "e" isn't a change
    assert_eq!(
        d(1),
        vec![
            ((2, 3), (2, 3), ChangeKind::Conflict),
            ((7, 8), (7, 8), ChangeKind::Inserted),
        ]
    );
    no_errors(&v);
}

#[test]
fn merge_chrome_follows_the_whitespace_mode() {
    // a conflict on line 2 keeps the repo mid-merge; theirs also adds blanks at the end of line 5
    let tmp = conflict_repo("a\nb\nc\nd\ne\n", "a\nB1\nc\nd\ne\n", "a\nB2\nc\nd\ne  \n");
    let mut v = start_dir(tmp.path());
    wide(&mut v);
    open_merge(&mut v);
    let theirs_changes = |v: &mut View| -> Vec<(i64, i64)> {
        viewer(v).unwrap().dividers[1]
            .iter()
            .map(|c| (c.b.s, c.b.e))
            .collect()
    };
    assert!(
        theirs_changes(&mut v).contains(&(5, 6)),
        "{:?}",
        theirs_changes(&mut v)
    );
    click(&mut v, "diff-dropdown-ignore");
    wait_menu(&mut v, "ignore modes", |r| {
        r.iter().any(|l| l.contains("Ignore whitespaces"))
    });
    click_menu(&mut v, "Ignore whitespaces");
    wait_viewer(&mut v, "mode shown", |x| {
        x.toolbar.ignore == "Ignore whitespaces"
    });
    v.wait_until("the whitespace-only change is gone from the chrome", |v| {
        !theirs_changes(v).contains(&(5, 6))
    });
    no_errors(&v);
}
