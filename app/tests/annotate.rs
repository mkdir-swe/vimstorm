//! Annotate (git blame) and the editor's change gutter, painted natively over the cells Lua
//! reserves in the statuscolumn, on the real nvim + config: `,å` toggles the
//! WebStorm annotation column (Inter "date author", ORDER-mode backgrounds, uncommitted lines
//! blank, unsaved text blamed), hover shows the commit's tooltip, click / Enter show
//! the commit in the Git log, right-click opens the annotation menu; gitsigns' hunks become WS's
//! thin bars / deleted markers, a click on one opens the change popup; folds, wrapped lines and
//! smooth scrolling map rows to the right lines.

use crate::common;

use common::gitfix::{self, GitFixture};
use common::gitui;
use common::view::View;
use gpui_kit::{Bounds, Hsla, Modifiers, MouseButton, Pixels, ScrollDelta, TouchPhase, point, px};
use vimstorm::look;

/// grepo's blame.ts: "line one" (2025-01-10 Aaron Sample), "line TWO" (2026-09-01 Ada
/// Example), "line 3 recent" (3 days ago, Max), "line four" (2026-09-01 Ada Example).
fn start() -> (View, GitFixture) {
    let fx = gitfix::fixture("grepo");
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    (v, fx)
}

fn buf(v: &View) -> i64 {
    v.lua("return vim.api.nvim_get_current_buf()")
        .as_i64()
        .unwrap()
}

fn annotate(v: &mut View) {
    v.keystrokes(",");
    v.key("å");
    let b = buf(v);
    v.wait_until("annotation loaded and painted", |v| {
        v.read_ws(|ws, cx| {
            let a = ws.annotate().read(cx);
            a.annotated().contains(&b) && a.painted_lines().iter().any(|l| l.0 == b)
        })
    });
}

fn painted(v: &mut View) -> Vec<(i64, u32, Bounds<Pixels>, bool)> {
    v.read_ws(|ws, cx| ws.annotate().read(cx).painted_lines())
}

fn markers(v: &mut View) -> Vec<(Hsla, Bounds<Pixels>)> {
    v.read_ws(|ws, cx| ws.annotate().read(cx).painted_markers())
}

fn text_of(v: &mut View, b: i64, lnum: u32) -> Option<String> {
    v.read_ws(|ws, cx| ws.annotate().read(cx).line_text(b, lnum))
}

fn color_of(v: &mut View, b: i64, lnum: u32) -> Option<u32> {
    v.read_ws(|ws, cx| ws.annotate().read(cx).line_color(b, lnum))
}

#[test]
fn annotate_shows_date_and_author_per_line() {
    let (mut v, _fx) = start();
    let b = buf(&v);
    annotate(&mut v);
    assert_eq!(text_of(&mut v, b, 1).as_deref(), Some("2025-01-10 Sample"));
    assert_eq!(text_of(&mut v, b, 2).as_deref(), Some("2026-09-01 Example"));
    let recent = text_of(&mut v, b, 3).unwrap();
    assert!(recent.ends_with(" Max"), "{recent}");
    // WS ORDER colors: the newest revision brightest, older ones darker, same commit same color
    let (c1, c2, c3, c4) = (
        color_of(&mut v, b, 1),
        color_of(&mut v, b, 2),
        color_of(&mut v, b, 3),
        color_of(&mut v, b, 4),
    );
    assert_eq!(c3, Some(vimstorm::git::ANNOTATION_COLORS[0]));
    assert!(c1.is_some() && c1 != c2 && c2 != c3, "{c1:?} {c2:?} {c3:?}");
    assert_eq!(c2, c4);
    // ... and that's what's painted behind the text
    let bgs = v.read_ws(|ws, cx| ws.annotate().read(cx).painted_backgrounds());
    let bg = |n: u32| bgs.iter().find(|b| b.0 == n).and_then(|b| b.1);
    for (n, c) in [(1, c1), (2, c2), (3, c3)] {
        assert_eq!(bg(n), c.map(|c| look::hex(c).into()), "line {n} painted bg");
    }
    // each line painted once, with its text, in the reserved cells left of the line numbers
    let lines = painted(&mut v);
    for lnum in 1..=4 {
        assert!(
            lines.iter().any(|l| l.0 == b && l.1 == lnum && l.3),
            "line {lnum} painted: {lines:?}"
        );
    }
    let screen = v.screen();
    let row = screen.iter().find(|l| l.contains("line one")).unwrap();
    let cells = v.read_ws(|ws, cx| ws.annotate().read(cx).cells(b)).unwrap();
    assert!(
        row.starts_with(&" ".repeat(cells)),
        "blank reserved cells (Rust paints over them): {row:?}"
    );
    assert!(
        row[cells..].trim_start().starts_with("1 "),
        "then the line number: {row:?}"
    );
    // the column lies over those cells, left of the number
    let one = lines.iter().find(|l| l.1 == 1).unwrap().2;
    let (r, c) = v.cell_of("line one");
    let number_x = v.cell_pos(r, cells).x;
    assert!(one.right() < number_x && one.top() < v.cell_pos(r, c).y);
    // after the author: its 5 px gap + WS's ExtraFieldGutter (" " + 5 px) in the row's color
    let (author_x, author_w, width) = v
        .read_ws(|ws, cx| ws.annotate().read(cx).column(b))
        .unwrap();
    let extra = width - author_x - author_w - px(look::ANNOTATION_COLUMN_GAP);
    assert!(
        extra > px(look::ANNOTATION_COLUMN_GAP + 2.)
            && extra < px(look::ANNOTATION_COLUMN_GAP + 9.),
        "extra field {extra:?}"
    );
    assert_eq!(one.size.width, width);
}

#[test]
fn closing_annotate_restores_the_gutter() {
    let (mut v, _fx) = start();
    let b = buf(&v);
    v.lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, { 'line two changed' })");
    v.wait_until("change marker", |v| !markers(v).is_empty());
    annotate(&mut v);
    v.keystrokes(",");
    v.key("å");
    v.wait_until("annotations gone", |v| {
        painted(v).is_empty()
            && !v.read_ws(|ws, cx| ws.annotate().read(cx).annotated().contains(&b))
    });
    v.wait_until(
        "line numbers back at the left edge, change marker kept",
        |v| {
            let screen = v.screen();
            screen
                .iter()
                .any(|l| l.find("1 ").is_some_and(|i| i < 4) && l.contains("line one"))
                && !markers(v).is_empty()
        },
    );
    assert_eq!(
        v.lua("return vim.wo.statuscolumn").as_str(),
        Some("%=%l%{%v:lua.require'config.bookmarks'.cell()%}%s"),
    );
}

#[test]
fn change_markers_are_ws_bars() {
    let (mut v, _fx) = start();
    // changed line 2, a line added at the end
    v.lua(
        "vim.api.nvim_buf_set_lines(0, 1, 2, false, { 'line two changed' }) \
         vim.api.nvim_buf_set_lines(0, 4, 4, false, { 'added' })",
    );
    v.wait_until("bars painted", |v| markers(v).len() >= 2);
    let ms = markers(&mut v);
    let row_h = v.read(|e| e.metrics().row_height);
    let bar = |c: gpui_kit::Rgba| {
        let c: Hsla = c.into();
        ms.iter().find(|m| m.0 == c).map(|m| m.1)
    };
    let modified = bar(look::GUTTER_MODIFIED.rgba()).expect("modified bar");
    let added = bar(look::GUTTER_ADDED.rgba()).expect("added bar");
    // one row each, inset 1 px, 4 px wide (WS new UI)
    assert_eq!(modified.size.width, gpui_kit::px(look::GUTTER_BAR_WIDTH));
    assert_eq!(modified.size.height, row_h - gpui_kit::px(2.));
    // right of the line number, left of the code (no glyph in the cells: blank signs)
    let (r2, c2) = v.cell_of("line two changed");
    let code_x = v.cell_pos(r2, c2).x - v.read(|e| e.metrics().cell_width) / 2.;
    let screen = v.screen();
    assert!(
        screen[r2].trim_start().starts_with("2   line two changed"),
        "{:?}",
        screen[r2]
    );
    let num_x = v.cell_pos(r2, screen[r2].find('2').unwrap()).x;
    assert!(
        modified.left() > num_x && modified.right() < code_x,
        "{modified:?}"
    );
    assert!((modified.center().y - v.cell_pos(r2, c2).y).abs() < gpui_kit::px(1.));
    let (r4, c4) = v.cell_of("added");
    assert!((added.center().y - v.cell_pos(r4, c4).y).abs() < gpui_kit::px(1.));
    // a deleted line: WS's marker on the boundary under the line before it
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'line one', 'line TWO', 'line four' })");
    v.wait_until("deleted marker", |v| {
        let d: Hsla = look::GUTTER_DELETED.into();
        markers(v).iter().any(|m| m.0 == d)
    });
    let d: Hsla = look::GUTTER_DELETED.into();
    let del = markers(&mut v).into_iter().find(|m| m.0 == d).unwrap().1;
    let (r2, c2) = v.cell_of("line TWO");
    let boundary = v.cell_pos(r2, c2).y + row_h / 2.;
    assert!(
        (del.center().y - boundary).abs() < gpui_kit::px(1.),
        "{del:?}"
    );
    assert_eq!(del.size.height, gpui_kit::px(8.));
}

fn hash_of(fx: &GitFixture, rev: &str) -> String {
    gitfix::git(&fx.repo, &["rev-parse", rev]).trim().to_owned()
}

#[test]
fn unsaved_lines_are_blank_and_follow_edits_save_and_commit() {
    let (mut v, fx) = start();
    let b = buf(&v);
    annotate(&mut v);
    // a typed line on top: not committed (blank, no background), the others move down with it
    v.keystrokes("O t o p escape");
    v.wait_until("re-blamed with the unsaved text", |v| {
        text_of(v, b, 1).as_deref() == Some("")
            && text_of(v, b, 2).as_deref() == Some("2025-01-10 Sample")
    });
    assert_eq!(color_of(&mut v, b, 1), None);
    let lines = painted(&mut v);
    assert!(
        lines.iter().any(|l| l.1 == 1),
        "the blank line is in the column too"
    );
    // saved: still uncommitted
    v.lua("vim.cmd('silent write')");
    v.settle();
    assert_eq!(text_of(&mut v, b, 1).as_deref(), Some(""));
    // committed outside (a terminal): the line gets its commit
    gitfix::git(&fx.repo, &["commit", "-qam", "AB#1 top"]);
    v.lua("vim.api.nvim_exec_autocmds('FocusGained', {})");
    v.wait_until("annotation of the new commit", |v| {
        text_of(v, b, 1).is_some_and(|t| t.ends_with("Example") && t.starts_with("Today"))
    });
    assert_eq!(
        color_of(&mut v, b, 1),
        Some(vimstorm::git::ANNOTATION_COLORS[0])
    );
}

#[test]
fn hover_shows_the_commits_tooltip_without_a_hover_background() {
    let (mut v, fx) = start();
    let b = buf(&v);
    annotate(&mut v);
    let two = painted(&mut v).into_iter().find(|l| l.1 == 2).unwrap().2;
    v.cx.simulate_mouse_move(two.center(), None, Modifiers::default());
    v.wait_until("line 2 hovered", |v| {
        v.read_ws(|ws, cx| ws.annotate().read(cx).hovered()) == Some((b, 2))
    });
    // WS paints no hover background: the lines keep their age colors
    let before = v.read_ws(|ws, cx| ws.annotate().read(cx).painted_backgrounds());
    v.pump();
    assert_eq!(
        v.read_ws(|ws, cx| ws.annotate().read(cx).painted_backgrounds()),
        before
    );
    v.advance(std::time::Duration::from_millis(600));
    let hash = hash_of(&fx, "HEAD~3");
    v.wait_until("tooltip with the full message", |v| {
        v.read_ws(|ws, cx| ws.annotate().read(cx).tooltip_text())
            .is_some_and(|t| !t.contains("\n..."))
    });
    let tip = v
        .read_ws(|ws, cx| ws.annotate().read(cx).tooltip_text())
        .unwrap();
    assert!(
        tip.starts_with(&format!(
            "Commit {hash}\nAuthor: Ada Example <ada@x.se>\nDate: 2026-09-01, "
        )),
        "{tip}"
    );
    assert!(
        tip.ends_with("\n\nAB#1234 Added checkout page texts"),
        "{tip}"
    );
    // off the column: no tooltip
    let (r, c) = v.cell_of("line one");
    let code = v.cell_pos(r, c + 3);
    v.cx.simulate_mouse_move(code, None, Modifiers::default());
    v.wait_until("hover gone", |v| {
        v.read_ws(|ws, cx| {
            let a = ws.annotate().read(cx);
            a.hovered().is_none() && a.tooltip_text().is_none()
        })
    });
}

/// Records `require("git").show_commit` calls (the Git log's entry point).
fn spy_show_commit(v: &View) {
    v.lua(
        "local g = require('git') local o = g.show_commit _G.shown = nil \
         g.show_commit = function(h) _G.shown = h return o(h) end",
    );
}

fn shown(v: &View) -> Option<String> {
    v.lua("return _G.shown").as_str().map(str::to_owned)
}

#[test]
fn click_and_enter_show_the_commit_in_the_git_log() {
    let (mut v, fx) = start();
    annotate(&mut v);
    spy_show_commit(&v);
    let three = painted(&mut v).into_iter().find(|l| l.1 == 3).unwrap().2;
    v.click(MouseButton::Left, three.center());
    v.wait_until("Git log open on the commit", |v| {
        gitui::git_open(v)
            && gitui::active(v) == vimstorm::git::window::TabId::Log
            && shown(v).is_some()
    });
    assert_eq!(shown(&v), Some(hash_of(&fx, "HEAD~1")));
    // Enter on a line in the editor: same
    v.focus_code();
    gitui::wait_target(&mut v, "split");
    v.lua("_G.shown = nil vim.api.nvim_win_set_cursor(0, { 1, 0 })");
    v.keystrokes("enter");
    v.wait_until("Enter showed line 1's commit", |v| shown(v).is_some());
    assert_eq!(shown(&v), Some(hash_of(&fx, "HEAD~5")));
    // an uncommitted line: a balloon, no log
    v.focus_code();
    gitui::wait_target(&mut v, "split");
    v.lua("_G.shown = nil vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'new' }) vim.api.nvim_win_set_cursor(0, { 1, 0 })");
    let b = buf(&v);
    v.wait_until("re-blamed", |v| text_of(v, b, 1).as_deref() == Some(""));
    // Lua has it too (Rust's blame reaches it as a notification; a key can overtake that)
    v.wait_lua(
        "Lua's line 1 uncommitted",
        &format!("local l = require('git.blame').line({b}, 1) return l ~= nil and l.sha:match('^0+$') ~= nil"),
    );
    v.keystrokes("enter");
    v.wait_until("Not committed yet", |v| {
        gitui::has_balloon(v, "Not committed yet")
    });
    assert_eq!(shown(&v), None);
}

#[test]
fn right_click_menu_copies_the_revision_and_closes_annotations() {
    let (mut v, fx) = start();
    let b = buf(&v);
    annotate(&mut v);
    let one = painted(&mut v).into_iter().find(|l| l.1 == 1).unwrap().2;
    v.click(MouseButton::Right, one.center());
    v.wait_until("annotation menu", |v| {
        gitui::menu_rows(v).is_some_and(|r| {
            let all = r.join("|");
            [
                "Show Diff",
                "Copy Revision Number",
                "Select in Git Log",
                "Close Annotations",
            ]
            .iter()
            .all(|i| all.contains(i))
        })
    });
    gitui::pick_menu(&mut v, "Copy Revision Number");
    let hash = hash_of(&fx, "HEAD~5");
    v.wait_lua("copied", &format!("return vim.fn.getreg('+') == '{hash}'"));
    // Show Diff: the commit's change of the file in the diff viewer
    v.click(MouseButton::Right, one.center());
    gitui::pick_menu(&mut v, "Show Diff");
    v.wait_lua("diff open", "return require('git.diff').is_active()");
    v.lua("require('git.diff').close()");
    v.wait_lua("diff closed", "return not require('git.diff').is_active()");
    v.wait_until("annotations back", |v| painted(v).iter().any(|l| l.1 == 1));
    let one = painted(&mut v).into_iter().find(|l| l.1 == 1).unwrap().2;
    v.click(MouseButton::Right, one.center());
    gitui::pick_menu(&mut v, "Close Annotations");
    v.wait_until("closed", |v| painted(v).is_empty());
    assert_eq!(
        v.lua(&format!("return require('git.blame').is_enabled({b})"))
            .as_bool(),
        Some(false)
    );
}

#[test]
fn wrapped_and_folded_lines_map_to_their_buffer_lines() {
    let (mut v, _fx) = start();
    v.lua(
        "vim.wo.wrap = true vim.api.nvim_buf_set_lines(0, 0, 1, false, { string.rep('line one ', 40) }) \
         vim.cmd('silent write')",
    );
    annotate(&mut v);
    let b = buf(&v);
    v.wait_until("blamed", |v| text_of(v, b, 1).as_deref() == Some(""));
    let row_h = v.read(|e| e.metrics().row_height);
    let lines = painted(&mut v);
    let one = lines.iter().find(|l| l.1 == 1).unwrap().2;
    assert!(
        one.size.height >= row_h * 2.,
        "wrapped: all its rows {one:?}"
    );
    let two = lines.iter().find(|l| l.1 == 2).unwrap();
    assert_eq!(
        two.2.top(),
        one.bottom(),
        "line 2 right under line 1's rows"
    );
    assert!(two.3, "text on line 2's row");
    // a closed fold: one row, the fold's first line
    v.lua("vim.wo.foldmethod = 'manual' vim.cmd('2,3fold')");
    v.wait_until("fold", |v| {
        let ls = painted(v);
        ls.iter().any(|l| l.1 == 2) && !ls.iter().any(|l| l.1 == 3) && ls.iter().any(|l| l.1 == 4)
    });
    let ls = painted(&mut v);
    let (two, four) = (
        ls.iter().find(|l| l.1 == 2).unwrap().2,
        ls.iter().find(|l| l.1 == 4).unwrap().2,
    );
    assert_eq!(four.top(), two.bottom());
    assert_eq!(two.size.height, row_h);
}

#[test]
fn painted_gutter_follows_the_smooth_scroll() {
    let fx = gitfix::fixture("grepo");
    let mut v = View::start(fx.repo.to_str().unwrap(), &["long.ts"]);
    v.wait_screen("line 1");
    annotate(&mut v);
    let b = buf(&v);
    let (r, c) = v.cell_of("line 10");
    let at = v.cell_pos(r, c);
    // a trackpad scroll in small steps: rows drawn with a sub-row offset between nvim's scrolls
    let mut offsets = Vec::new();
    for _ in 0..12 {
        v.scroll(
            at,
            ScrollDelta::Pixels(point(px(0.), px(-7.))),
            TouchPhase::Moved,
        );
        v.pump();
        offsets.push(check_aligned(&mut v, b));
    }
    assert!(
        offsets.iter().any(|o| *o != px(0.)),
        "mid-row frames seen: {offsets:?}"
    );
    assert!(
        v.lua("return vim.fn.line('w0')").as_i64() > Some(1),
        "it scrolled"
    );
}

/// Every painted annotation sits on the grid row that shows its line number, offset included.
/// Returns the offset.
fn check_aligned(v: &mut View, b: i64) -> Pixels {
    let win = v
        .lua("return vim.api.nvim_get_current_win()")
        .as_i64()
        .unwrap();
    // one read: the painted gutter, the drawn grids and the grid text of the same frame (a pump
    // in between would apply nvim's next scroll to the text only)
    // (a flush applied after the paint: the gutter of that grid is drawn next frame)
    let mut same = None;
    for _ in 0..50 {
        same = v.read_ws(|ws, cx| {
            let a = ws.annotate().read(cx);
            let drawn = a.scx().drawn().all();
            let d = drawn.values().find(|d| d.win == win).unwrap().clone();
            let ui = ws.editor().read(cx).ui();
            let g = &ui.grids[&d.grid];
            let screen: Vec<String> = (0..g.height).map(|r| g.row_text(r)).collect();
            (a.painted_flushes() == ui.flushes).then(|| (a.painted_lines(), d, screen))
        });
        if same.is_some() {
            break;
        }
        v.pump();
    }
    let (lines, d, screen) = same.expect("a frame painted from the current flush");
    let lines: Vec<_> = lines.into_iter().filter(|l| l.0 == b).collect();
    assert!(!lines.is_empty());
    for (_, lnum, bounds, _) in lines {
        let row = (bounds.top() - d.origin.y - d.offset) / d.metrics.row_height;
        assert!(
            (row - row.round()).abs() < 0.01,
            "on a row: {row} offset {:?}",
            d.offset
        );
        let row = row.round() as i64;
        if row < 0 || row as usize >= screen.len() {
            continue; // a kept row
        }
        let text = &screen[row as usize];
        assert!(
            text.split_whitespace().next() == Some(&lnum.to_string()),
            "row {row} shows line {lnum}: {text:?}"
        );
    }
    d.offset
}

fn popup_open(v: &mut View) -> bool {
    gitui::menu_rows(v).is_some()
}

#[test]
fn menus_over_the_column_take_the_hover() {
    let (mut v, _fx) = start();
    annotate(&mut v);
    let one = painted(&mut v).into_iter().find(|l| l.1 == 1).unwrap().2;
    v.click(MouseButton::Right, one.center());
    v.wait_until("menu", popup_open);
    let menu = gitui::popups(&mut v)
        .read_with(&v.cx, |p, _| p.menu_bounds())
        .unwrap();
    // a point of the menu over an annotated line
    let lines = painted(&mut v);
    let under = lines
        .iter()
        .find_map(|l| {
            let b = l.2.intersect(&menu);
            (b.size.width > px(2.) && b.size.height > px(2.)).then(|| b.center())
        })
        .expect("the menu lies over the column");
    v.cx.simulate_mouse_move(under, None, Modifiers::default());
    v.advance(std::time::Duration::from_millis(700));
    v.pump();
    let (hovered, tip) = v.read_ws(|ws, cx| {
        let a = ws.annotate().read(cx);
        (a.hovered(), a.tooltip_text())
    });
    assert_eq!((hovered, tip), (None, None));
    assert!(popup_open(&mut v), "menu still open");
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| !popup_open(v));
    // the column hovers again once nothing covers it
    v.cx.simulate_mouse_move(one.center(), None, Modifiers::default());
    v.wait_until("hovered", |v| {
        v.read_ws(|ws, cx| ws.annotate().read(cx).hovered())
            .is_some()
    });
}

fn popup_shows(v: &mut View, text: &str) -> bool {
    v.screen().iter().any(|l| l.contains(text))
}

fn close_popup(v: &mut View, text: &str) {
    v.keystrokes("escape");
    let t = text.to_owned();
    v.wait_until("popup closed", move |v| !popup_shows(v, &t));
}

#[test]
fn every_marker_opens_its_change_popup() {
    let (mut v, _fx) = start();
    let d: Hsla = look::GUTTER_DELETED.into();
    let deleted = |v: &mut View| markers(v).into_iter().find(|m| m.0 == d).map(|m| m.1);
    // a click on a changed line's bar: the popup with the change; Esc closes it
    v.lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, { 'line two changed' })");
    v.wait_until("bar", |v| !markers(v).is_empty());
    let bar = markers(&mut v)[0].1;
    v.click(MouseButton::Left, bar.center());
    v.wait_until("the change popup", |v| popup_shows(v, "+line two changed"));
    v.keystrokes("escape");
    v.wait_until("Esc closes it", |v| !popup_shows(v, "+line two changed"));
    // annotations on: a click on the bar still opens the change
    annotate(&mut v);
    v.wait_until("bar", |v| !markers(v).is_empty());
    let bar = markers(&mut v)[0].1;
    v.click(MouseButton::Left, bar.center());
    v.wait_until("popup with annotations on", |v| {
        popup_shows(v, "+line two changed")
    });
    close_popup(&mut v, "+line two changed");
    v.keystrokes(",");
    v.key("å");
    v.wait_until("annotations off", |v| painted(v).is_empty());
    // deleted lines: both halves of the marker (it straddles the boundary)
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'line one', 'line TWO', 'line four' })");
    v.wait_until("deleted marker", |v| deleted(v).is_some());
    let m = deleted(&mut v).unwrap();
    for dy in [-2., 2.] {
        v.click(
            MouseButton::Left,
            point(m.center().x, m.center().y + px(dy)),
        );
        v.wait_until("popup of the deleted line", |v| {
            popup_shows(v, "-line 3 recent")
        });
        close_popup(&mut v, "-line 3 recent");
    }
    // lines deleted above line 1
    v.lua(
        "vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'line TWO', 'line 3 recent', 'line four' })",
    );
    v.wait_until("top-deleted marker on line 1's top edge", move |v| {
        let ok = v
            .screen()
            .iter()
            .any(|l| l.trim_start().starts_with("1   line TWO"));
        let (r1, c1) = v.cell_of("line TWO");
        let top = v.cell_pos(r1, c1).y - v.read(|e| e.metrics().row_height) / 2.;
        ok && markers(v).len() == 1 && deleted(v).is_some_and(|m| (m.top() - top).abs() <= px(2.))
    });
    let m = deleted(&mut v).unwrap();
    v.click(MouseButton::Left, m.center());
    v.wait_until("popup of the top deletion", |v| popup_shows(v, "-line one"));
    close_popup(&mut v, "-line one");
}

#[test]
fn a_failed_blame_shows_gits_message() {
    let (mut v, fx) = start();
    std::fs::write(fx.repo.join("brandnew.ts"), "x\n").unwrap();
    v.lua("vim.cmd('edit brandnew.ts')");
    v.wait_screen("x");
    v.keystrokes(",");
    v.key("å");
    v.wait_until("warning balloon", |v| gitui::has_balloon(v, "no such path"));
    let b = gitui::balloons(&mut v);
    let (_, body) = b
        .iter()
        .find(|(t, b)| t.contains("no such path") || b.contains("no such path"))
        .unwrap();
    assert!(!body.contains("git exited"), "{b:?}");
    assert!(
        body.starts_with("fatal: no such path 'brandnew.ts'")
            || b.iter().any(|(t, _)| t.starts_with("fatal: no such path")),
        "{b:?}"
    );
    assert_eq!(
        v.lua("return require('git.blame').is_enabled(0)").as_bool(),
        Some(false)
    );
}

#[test]
fn caret_row_band_runs_through_the_gutter() {
    let (mut v, _fx) = start();
    v.lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, { 'line two changed' }) vim.api.nvim_win_set_cursor(0, { 2, 0 })");
    v.wait_until("bar", |v| !markers(v).is_empty());
    let (r2, c2) = v.cell_of("line two changed");
    let (r3, _) = v.cell_of("line 3 recent");
    let win_grid = v
        .read(|e| e.ui().hit_test(r2 as i64, 0).map(|h| h.0))
        .unwrap();
    let bgs = |v: &mut View, row: usize| {
        v.ui(|ui| {
            let (_, grow, _) = ui.hit_test(row as i64, 2).unwrap();
            let g = &ui.grids[&win_grid];
            (0..c2.min(g.width))
                .map(|c| ui.colors(g.cell(grow, c).unwrap().hl).1)
                .collect::<Vec<_>>()
        })
    };
    let caret = bgs(&mut v, r2);
    assert!(
        caret.iter().all(|&b| b == 0x2b2d30),
        "caret row band: {caret:x?}"
    );
    let other = bgs(&mut v, r3);
    assert!(
        other.iter().all(|&b| b == 0x1e1f22),
        "other rows plain: {other:x?}"
    );
    // the bar is painted on the caret row
    let m = markers(&mut v)[0].1;
    assert!((m.center().y - v.cell_pos(r2, c2).y).abs() < px(1.));
}
