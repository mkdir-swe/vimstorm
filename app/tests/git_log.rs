//! The Git tool window's Log tab on the real nvim + config, driven by real keys and the mouse
//! through the GPUI test window: the tab and its layout, the graph, ref labels and columns,
//! selected commits (Space, held Space, Shift+arrows, Esc; Shift+ö five rows), the details width
//! across tab switches and a session restore, narrow widths, the Project tool window opening
//! beside it, Show History for Selection, hide / show, Cmd+C and the branch colors. Filters,
//! details, branches and actions live in `git_log/<area>.rs`. Repo-changing tests use a private
//! repo copy.
//!
//! Colors: WS's (GDATA: IntelliJ GraphColorManager), not Lua's gold main / blue current branch.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

// the areas of the Log tab (one test binary)
#[path = "git_log/actions.rs"]
mod actions;
#[path = "git_log/branches.rs"]
mod branches;
#[path = "git_log/details.rs"]
mod details;
#[path = "git_log/filters.rs"]
mod filters;

use std::path::Path;
use std::time::Duration;

use common::gitfix::{self, GitFixture};
use common::gitui::*;
use common::view::View;
use gpui_kit::{
    Bounds, Entity, KeyDownEvent, KeyUpEvent, Keystroke, Modifiers, MouseButton, MouseUpEvent,
    Pixels, SharedString, TextRun, point, px, size,
};
use vimstorm::git::Graph;
use vimstorm::git::window::log::DetailsTarget;
use vimstorm::git::window::log::LogTab;
use vimstorm::git::window::log::{GRAPH_LEFT, SUBJECT_GAP, ref_icons};
use vimstorm::git::window::{RepoChange, TabId};
use vimstorm::git::{BranchFilter, DateFilter, LogKind};
use vimstorm::look;
use vimstorm::render::ui_font;
use vimstorm::shell::Role;

// ---- helpers ---------------------------------------------------------------------------------

fn log(v: &mut View) -> Entity<LogTab> {
    v.read_ws(|ws, cx| ws.git().read(cx).log().clone())
}

fn read_log<R>(v: &mut View, f: impl FnOnce(&LogTab) -> R) -> R {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, _| f(t))
}

fn subjects(v: &mut View) -> Vec<String> {
    read_log(v, |t| {
        t.model.commits.iter().map(|c| c.subject.clone()).collect()
    })
}

fn selected(v: &mut View) -> Vec<String> {
    read_log(v, |t| {
        t.model
            .selection()
            .iter()
            .map(|c| c.subject.clone())
            .collect()
    })
}

fn cursor(v: &mut View) -> Option<usize> {
    read_log(v, |t| t.model.cursor())
}

fn loaded(v: &mut View) -> bool {
    read_log(v, |t| {
        !t.loading && !t.model.is_empty() && t.rows_painted_at.is_some()
    })
}

fn table_focused(v: &mut View) -> bool {
    let l = log(v);
    v.pump();
    v.cx.update(|w, cx| l.read(cx).table_focused(w))
}

fn details_target(v: &mut View) -> DetailsTarget {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, |t, cx| t.details.read(cx).target.clone())
}

fn log_label(v: &mut View) -> String {
    v.read_ws(|ws, cx| ws.git().read(cx).labels(cx)[1].to_string())
}

fn row_of(v: &mut View, subject: &str) -> usize {
    subjects(v)
        .iter()
        .position(|s| s == subject)
        .unwrap_or_else(|| panic!("no row {subject:?}"))
}

fn sel_bounds(v: &mut View, what: &str, ix: usize) -> Option<Bounds<Pixels>> {
    bounds(v, &format!("git-log-{what}-{ix}"))
}

fn must(v: &mut View, selector: &str) -> Bounds<Pixels> {
    bounds(v, selector).unwrap_or_else(|| panic!("{selector} not drawn"))
}

/// Opens the Git tool window and switches to the Log with Alt+Cmd+→, rows loaded, the
/// table with the keyboard.
fn open_log(v: &mut View) {
    open_git(v);
    for _ in 0..3 {
        if active(v) == TabId::Log {
            break;
        }
        v.keystrokes("alt-cmd-right");
    }
    v.wait_until("Log rows with the keyboard", |v| {
        active(v) == TabId::Log && loaded(v) && table_focused(v)
    });
}

/// A taller Git tool window: every row of the grepo log in view.
fn tall(v: &mut View) {
    v.lua("vim.api.nvim_win_set_height(require('config.app.git').win(), 24) return true");
    v.wait_until("tall Git tool window", |v| {
        v.read(|e| {
            e.geometry()
                .role_rect(Role::Git)
                .map(|r| r.island.size.height)
        })
        .is_some_and(|h| h > px(330.))
    });
}

/// A grepo copy, nvim started in it with blame.ts open.
fn start_copy() -> (GitFixture, View) {
    let fx = gitfix::fixture("grepo");
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    v.wait_screen("line one");
    (fx, v)
}

fn space_ks(shift: bool) -> Keystroke {
    Keystroke::parse(if shift { "shift-space" } else { "space" }).unwrap()
}

/// A key repeat of a held Space.
fn space_repeat(v: &mut View, shift: bool) {
    v.cx.simulate_event(KeyDownEvent {
        keystroke: space_ks(shift),
        is_held: true,
        prefer_character_input: false,
    });
    v.pump();
}

fn space_up(v: &mut View, shift: bool) {
    v.cx.simulate_event(KeyUpEvent {
        keystroke: space_ks(shift),
    });
    v.pump();
}

/// Space pressed and released.
fn space(v: &mut View) {
    v.keystrokes("space");
    space_up(v, false);
}

fn down(v: &mut View) {
    v.keystrokes("ö");
}

/// A lone `d`: the Date filter once nvim's timeoutlen passed (`dd` drops a commit).
fn date_key(v: &mut View) {
    v.keystrokes("d");
    v.advance(Duration::from_millis(450));
}

/// The Lua state the session keeps (`config/app/git.lua` `layout().log.details_width`).
fn lua_details_width(v: &View) -> Option<i64> {
    v.lua("local l = require('config.app.git').layout() return l and l.log and l.log.details_width")
        .as_i64()
}

fn text_width(v: &mut View, text: &str) -> f32 {
    let text = text.to_owned();
    v.cx.update(|w, _| {
        let run = TextRun {
            len: text.len(),
            font: ui_font(),
            color: look::TEXT.into(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        w.text_system()
            .shape_line(
                SharedString::from(text),
                px(look::VCS_LOG_FONT_SIZE),
                &[run],
                None,
            )
            .width
            .as_f32()
    })
}

fn near(a: Pixels, b: Pixels) -> bool {
    (a - b).abs() <= px(0.5)
}

fn graph(v: &mut View) -> std::sync::Arc<Graph> {
    read_log(v, |t| t.model.graph.clone())
}

fn update_log(v: &mut View, f: impl FnOnce(&mut LogTab, &mut gpui_kit::Context<LogTab>)) {
    let l = log(v);
    v.cx.update(|_, cx| l.update(cx, f));
    v.pump();
}

fn row_bounds(v: &mut View, ix: usize) -> Bounds<Pixels> {
    bounds(v, &format!("git-log-subject-{ix}")).unwrap_or_else(|| panic!("row {ix} not drawn"))
}

fn hide_and_show(v: &mut View) {
    hide_git(v);
    v.lua("require('config.app.git').open() return true");
    v.wait_until("shown", |v| git_open(v) && loaded(v));
}

/// The Git host window is nvim's current window (whatever has the keyboard: a menu the click
/// opened takes it, `is_focused` then says no).
fn host_current(v: &View) -> bool {
    v.lua("local g = require('config.app.git') return g.win() ~= nil and vim.api.nvim_get_current_win() == g.win()")
        .as_bool()
        .unwrap_or(false)
}

// ---- tab + layout ----------------------------------------------------------------------------

#[test]
fn alt_cmd_right_opens_the_log_tab_laid_out_like_ws() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    v.wait_until("Local Changes first", |v| active(v) == TabId::Changes);
    // Local Changes -> Log
    v.keystrokes("alt-cmd-right");
    v.wait_until("Log rows", |v| active(v) == TabId::Log && loaded(v));
    assert_eq!(log_label(&mut v), "Log: HEAD");
    assert!(
        subjects(&mut v).iter().any(|s| s == "AB#1235 Renamed b"),
        "{:?}",
        subjects(&mut v)
    );
    // layout: the collapsed Branches strip, the log, the splitter, the details on the right
    let island = v.read(|e| e.geometry().role_rect(Role::Git).unwrap().island);
    let strip = must(&mut v, "stripe-git-log-branches");
    let subject = must(&mut v, "git-log-subject-0");
    let divider = must(&mut v, "git-log-split-divider");
    assert!(
        near(strip.size.width, px(look::STRIPE_WIDTH)),
        "strip collapsed: {strip:?}"
    );
    assert!(strip.left() >= island.left() && strip.left() - island.left() < px(4.));
    assert!(subject.left() > strip.right() && subject.right() < divider.left());
    let details_w = island.right() - divider.center().x;
    assert!(
        details_w > px(100.) && divider.center().x > island.center().x,
        "details on the right: divider at {:?} in {island:?}",
        divider.center().x
    );
    // click the tabs: Local Changes, then the Log again
    let changes = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Changes, cx))
        .unwrap();
    v.click(MouseButton::Left, changes.center());
    v.wait_until("Local Changes", |v| active(v) == TabId::Changes);
    let tab = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Log, cx))
        .unwrap();
    v.click(MouseButton::Left, tab.center());
    v.wait_until("Log again, rows drawn", |v| {
        active(v) == TabId::Log && sel_bounds(v, "subject", 0).is_some()
    });
}

// ---- graph, refs, columns --------------------------------------------------------------------

#[test]
fn graph_refs_and_columns() {
    let (fx, mut v) = start_copy();
    // a wide window: every column shown
    v.cx.simulate_resize(size(px(1800.), px(900.)));
    open_log(&mut v);
    tall(&mut v);
    v.wait_until("date column shown", |v| {
        read_log(v, |t| t.shown_columns().1 > 0.) && sel_bounds(v, "date", 0).is_some()
    });
    let subs = subjects(&mut v);
    assert_eq!(subs[0], "AB#1235 Renamed b", "{subs:?}");
    // HEAD's row: the head node (ring), master
    let (head, head_node) = read_log(&mut v, |t| {
        (
            t.model.commits[0].refs.is_head(),
            t.model.graph.rows[0].node,
        )
    });
    assert!(
        head && head_node == 0,
        "HEAD row with the head node in lane 0"
    );
    // lanes continuous: each edge leaving a row through its bottom continues in the next row
    // (and the other way round), every listed parent gets an edge from the node
    let g = graph(&mut v);
    let parents: Vec<(usize, Vec<String>)> = read_log(&mut v, |t| {
        t.model
            .commits
            .iter()
            .enumerate()
            .map(|(i, c)| (i, c.parents.clone()))
            .collect()
    });
    let hashes: Vec<String> = read_log(&mut v, |t| {
        t.model.commits.iter().map(|c| c.hash.clone()).collect()
    });
    for (i, ps) in &parents {
        let row = &g.rows[*i];
        if ps.iter().any(|p| hashes.contains(p)) {
            assert!(
                row.edges.iter().any(|e| !e.up && e.from == row.node),
                "row {i} has an edge down from its node: {row:?}"
            );
        }
        if let Some(next) = g.rows.get(i + 1) {
            for e in row.edges.iter().filter(|e| !e.up && !e.terminal) {
                assert!(
                    next.edges
                        .iter()
                        .any(|n| n.up && n.from == e.to && n.to == e.from),
                    "edge {e:?} of row {i} continues in row {}: {next:?}",
                    i + 1
                );
            }
            for n in next.edges.iter().filter(|n| n.up && !n.terminal) {
                assert!(
                    row.edges
                        .iter()
                        .any(|e| !e.up && e.from == n.to && e.to == n.from),
                    "edge {n:?} of row {} comes from row {i}: {row:?}",
                    i + 1
                );
            }
        }
    }
    // refs: master on HEAD, the remote + local branch merged on "fixed label typo"
    let fixed = row_of(&mut v, "fixed label typo");
    let tagged = row_of(&mut v, "AB#1234 Added checkout page texts");
    let (head_refs, fixed_refs, tag_refs) = read_log(&mut v, |t| {
        (
            ref_icons(&t.model.commits[0]),
            ref_icons(&t.model.commits[fixed]),
            ref_icons(&t.model.commits[tagged]),
        )
    });
    assert_eq!(head_refs.1, "master");
    assert_eq!(fixed_refs.1, "origin & factory/1237");
    // two tags: icons only, no name
    assert_eq!(tag_refs.0.len(), 2, "{:?}", tag_refs.0);
    assert!(tag_refs.1.is_empty(), "tags show no name: {:?}", tag_refs.1);
    // the labels end at the same x, right before the author column
    let r0 = must(&mut v, "git-log-refs-0");
    let rf = sel_bounds(&mut v, "refs", fixed).unwrap();
    let a0 = must(&mut v, "git-log-author-0");
    let af = sel_bounds(&mut v, "author", fixed).unwrap();
    assert!(near(r0.right(), rf.right()), "{r0:?} vs {rf:?}");
    assert!(
        r0.right() <= a0.left() && a0.left() - r0.right() < px(8.),
        "labels end right before the author: {r0:?} {a0:?}"
    );
    // author and date columns line up across rows
    let n = subs.len();
    v.wait_until("every row's author + date drawn", |v| {
        (0..n)
            .all(|ix| sel_bounds(v, "author", ix).is_some() && sel_bounds(v, "date", ix).is_some())
    });
    for ix in 0..n {
        let a = sel_bounds(&mut v, "author", ix).unwrap();
        let d = sel_bounds(&mut v, "date", ix).unwrap();
        assert!(near(a.left(), a0.left()), "author {ix}: {a:?} vs {a0:?}");
        assert!(near(d.left(), must(&mut v, "git-log-date-0").left()));
    }
    assert!(near(af.left(), a0.left()));
    // the subject right after a one-lane graph (row 0: one lane)
    assert_eq!(g.rows[0].width, 1, "{:?}", g.rows[0]);
    let strip = must(&mut v, "stripe-git-log-branches");
    let s0 = must(&mut v, "git-log-subject-0");
    let want = strip.right() + px(GRAPH_LEFT + look::VCS_LOG_LANE_WIDTH + SUBJECT_GAP);
    assert!(
        near(s0.left(), want),
        "subject at {:?}, want {want:?}",
        s0.left()
    );
    // your own name bold, the other authors' not
    let bold: Vec<(String, bool)> = read_log(&mut v, |t| {
        (0..t.model.len())
            .map(|i| (t.model.commits[i].author.name.clone(), t.author_bold(i)))
            .collect()
    });
    for (name, b) in &bold {
        assert_eq!(*b, name == "Ada Example", "{name}: bold {b}");
    }
    // a second branch on a commit: R -> one more icon, still not its name
    gitfix::git(&fx.repo, &["branch", "zz-extra", "factory/1237"]);
    v.keystrokes("shift-r");
    v.wait_until("one more icon", |v| {
        read_log(v, |t| {
            t.model
                .commits
                .iter()
                .find(|c| c.subject == "fixed label typo")
                .map(|c| ref_icons(c).0.len())
        }) == Some(fixed_refs.0.len() + 1)
    });
    let (icons, name) = read_log(&mut v, |t| {
        ref_icons(
            t.model
                .commits
                .iter()
                .find(|c| c.subject == "fixed label typo")
                .unwrap(),
        )
    });
    assert_eq!(name, "origin & factory/1237", "{icons:?}");
    assert!(!name.contains("zz-extra"));
}

// ---- selected commits ------------------------------------------------------------------------

#[test]
fn space_selects_esc_clears_shift_extends() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    assert_eq!(cursor(&mut v), Some(0));
    space(&mut v);
    down(&mut v);
    space(&mut v);
    assert_eq!(
        selected(&mut v),
        ["AB#1235 Renamed b", "AB#1236 Recent blame line"]
    );
    v.wait_until(
        "details: the 2 commits",
        |v| matches!(details_target(v), DetailsTarget::Many(h) if h.len() == 2),
    );
    // Space again unselects (the cursor's commit)
    space(&mut v);
    assert_eq!(selected(&mut v), ["AB#1235 Renamed b"]);
    // Esc clears, the keyboard stays in the table
    v.keystrokes("escape");
    assert!(selected(&mut v).is_empty());
    v.settle();
    assert!(table_focused(&mut v), "keyboard still in the table");
    assert_eq!(target(&v), "git");
    // Shift+ö / Shift+l: five rows (his nvim Ö / L), nothing selected
    let n = subjects(&mut v).len();
    v.keystrokes("home");
    v.key("shift+ö");
    assert_eq!(cursor(&mut v), Some(5.min(n - 1)));
    v.key("shift+l");
    assert_eq!(cursor(&mut v), Some(0));
    assert!(selected(&mut v).is_empty());
    // Shift+Down twice: a range of 3
    v.keystrokes("shift-down");
    v.keystrokes("shift-down");
    assert_eq!(selected(&mut v).len(), 3, "{:?}", selected(&mut v));
    // Esc with nothing selected: back to the editor
    v.keystrokes("escape");
    assert!(selected(&mut v).is_empty());
    v.keystrokes("escape");
    wait_target(&mut v, "split");
}

/// One step of a held Space row: `bool` is Shift held with it.
#[derive(Clone, Copy, Debug)]
enum Hold {
    /// The key goes down (no key up yet).
    Press(bool),
    /// A key repeat of the held key.
    Repeat(bool),
    Release(bool),
    /// Pressed and released.
    Toggle(bool),
    /// ö: one row down.
    Move,
    /// The keyboard leaves the Log before the key comes up, then Git is opened again.
    Leave,
    /// This many commits selected now.
    Want(usize),
}

const HOLDS: &[(&str, &[Hold])] = {
    use Hold::*;
    &[
        (
            "held Space selects the commits passed, repeats ignored; after the key up moves don't",
            &[
                Press(false),
                Repeat(false),
                Repeat(false),
                Move,
                Move,
                Want(3),
                Release(false),
                Move,
                Want(3),
            ],
        ),
        (
            "held Space on a selected commit unselects it, moving then selects",
            &[
                Toggle(false),
                Want(1),
                Press(false),
                Repeat(false),
                Repeat(false),
                Repeat(false),
                Want(0),
                Move,
                Want(2),
                Release(false),
            ],
        ),
        (
            "Shift+Space is like Space, held and pressed",
            &[
                Press(true),
                Repeat(true),
                Repeat(true),
                Move,
                Release(true),
                Move,
                Want(2),
                Toggle(true),
                Want(3),
            ],
        ),
        (
            "a Space released elsewhere ends the hold",
            &[
                Press(false),
                Leave,
                Move,
                Move,
                Want(1),
                Toggle(false),
                Want(2),
            ],
        ),
    ]
};

#[test]
fn held_space_selects_the_commits_the_cursor_passes() {
    for (name, steps) in HOLDS {
        let mut v = View::start("grepo", &["blame.ts"]);
        v.wait_screen("line one");
        open_log(&mut v);
        for (i, step) in steps.iter().enumerate() {
            match *step {
                Hold::Press(shift) => {
                    v.keystrokes(if shift { "shift-space" } else { "space" });
                }
                Hold::Repeat(shift) => space_repeat(&mut v, shift),
                Hold::Release(shift) => space_up(&mut v, shift),
                Hold::Toggle(shift) => {
                    v.keystrokes(if shift { "shift-space" } else { "space" });
                    space_up(&mut v, shift);
                }
                Hold::Move => down(&mut v),
                Hold::Leave => {
                    v.focus_code();
                    wait_target(&mut v, "split");
                    v.wait_until("hold ended", |v| read_log(v, |t| !t.model.holding()));
                    open_git(&mut v);
                    v.wait_until("table", table_focused);
                }
                Hold::Want(n) => assert_eq!(
                    selected(&mut v).len(),
                    n,
                    "{name}: step {i}: {:?}",
                    selected(&mut v)
                ),
            }
        }
    }
}

// ---- details width ---------------------------------------------------------------------------

fn drag(v: &mut View, from: gpui_kit::Point<Pixels>, to: gpui_kit::Point<Pixels>) {
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.pump();
    for i in 1..=4 {
        let t = i as f32 / 4.;
        let p = point(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        v.cx.simulate_mouse_move(p, MouseButton::Left, Modifiers::default());
        v.pump();
    }
    v.cx.simulate_event(MouseUpEvent {
        position: to,
        button: MouseButton::Left,
        modifiers: Modifiers::default(),
        click_count: 1,
    });
    v.pump();
}

fn has_chip(v: &mut View, text: &str) -> bool {
    read_log(v, |t| t.filter_bar_text().iter().any(|s| s == text))
}

/// The details pane's width: the Git island's right edge minus the splitter's center.
fn details_width(v: &mut View) -> f32 {
    let divider = must(v, "git-log-split-divider");
    let island = v.read(|e| e.geometry().role_rect(Role::Git).unwrap().island);
    (island.right() - divider.center().x).as_f32()
}

/// The details pane dragged wider and a branch filter: both kept across a tab switch, saved in
/// the session, and a fresh nvim restoring it reopens the Log filtered, the details as wide,
/// without the keyboard.
#[test]
fn the_details_width_and_branch_filter_survive_a_tab_switch_and_a_session_restore() {
    let fx = gitfix::fixture("grepo");
    let repo = fx.repo.to_str().unwrap().to_owned();
    let (saved, width) = {
        let mut v = View::start(&repo, &["blame.ts"]);
        v.wait_screen("line one");
        open_log(&mut v);
        v.keystrokes("b");
        v.wait_until("branch popup", |v| {
            read_log(v, |t| t.filter_popup().map(|p| p.title.to_string()))
                .is_some_and(|t| t.starts_with("Branch"))
        });
        v.keystrokes("/ f a c t o r y enter");
        v.wait_until("branch filter", |v| {
            log_label(v) == "Log: factory/1237" && has_chip(v, "Branch: factory/1237 ×")
        });
        let before = must(&mut v, "git-log-split-divider");
        let to = point(before.center().x - px(80.), before.center().y);
        drag(&mut v, before.center(), to);
        v.wait_until("divider moved", |v| {
            bounds(v, "git-log-split-divider")
                .is_some_and(|b| (b.center().x - before.center().x).abs() > px(60.))
        });
        let dragged = must(&mut v, "git-log-split-divider");
        let width = details_width(&mut v);
        v.wait_until("the session has the width", |v| {
            lua_details_width(v).is_some_and(|w| (w as f32 - width).abs() < 4.)
        });
        // another tab and back: the same width
        v.keystrokes("alt-cmd-left");
        v.wait_until("Local Changes", |v| active(v) == TabId::Changes);
        v.keystrokes("alt-cmd-right");
        v.wait_until("Log again", |v| {
            active(v) == TabId::Log && bounds(v, "git-log-split-divider").is_some()
        });
        let after = must(&mut v, "git-log-split-divider");
        assert!(
            near(after.left(), dragged.left()),
            "{after:?} vs {dragged:?}"
        );
        v.focus_code();
        wait_target(&mut v, "split");
        v.lua("vim.api.nvim_exec_autocmds('VimLeavePre', {}) return true");
        let saved = v.lua(
            "local f = vim.fn.stdpath('state') .. '/open-files/' .. vim.fn.getcwd():gsub('[/\\\\:]', '%%') .. '.json' \
             return vim.json.encode(vim.json.decode(table.concat(vim.fn.readfile(f), '')).layout.git)",
        );
        (saved.as_str().unwrap().to_owned(), width)
    };
    assert!(
        saved.contains("factory/1237"),
        "session layout.git: {saved}"
    );

    // a fresh nvim on the same repo restores it as `config/session.lua` does
    let mut v = View::start(&repo, &["blame.ts"]);
    v.wait_screen("line one");
    assert!(!git_open(&mut v));
    let quoted = saved.replace('\\', "\\\\").replace('\'', "\\'");
    // (the session keeps the Log's state; shown or not is the app's panel: opened here)
    v.lua(&format!(
        "require('git').restore(vim.json.decode('{quoted}')) \
         require('config.app.git').open('log', false) return true"
    ));
    v.wait_until("Git reopened on the Log with its branch filter", |v| {
        git_open(v)
            && active(v) == TabId::Log
            && log_label(v) == "Log: factory/1237"
            && read_log(v, |t| t.filters.branch.arg().to_string()) == "factory/1237"
            // (the narrower Log cuts the chip's value: "Branch: factory/112… ×")
            && read_log(v, |t| {
                t.filter_bar_text()
                    .iter()
                    .any(|c| c.starts_with("Branch: factory/") && c.ends_with('×'))
            })
            && loaded(v)
    });
    let listed = subjects(&mut v);
    assert!(
        listed.iter().any(|s| s.contains("fixed label"))
            && !listed.iter().any(|s| s.contains("Renamed b")),
        "only the branch's commits: {listed:?}"
    );
    v.wait_until("the details pane keeps its width", |v| {
        bounds(v, "git-log-split-divider").is_some() && (details_width(v) - width).abs() < 4.
    });
    assert_eq!(target(&v), "split", "restored without the keyboard");
}
// ---- widths ----------------------------------------------------------------------------------

/// Every drawn cell of the listed rows ends left of the details splitter.
fn rows_fit(v: &mut View) -> Result<(), String> {
    let divider = must(v, "git-log-split-divider");
    let n = subjects(v).len();
    for ix in 0..n {
        for what in ["subject", "refs", "author", "date"] {
            if let Some(b) = sel_bounds(v, what, ix)
                && b.right() > divider.left() + px(0.5)
            {
                return Err(format!("{what} {ix}: {b:?} past {divider:?}"));
            }
        }
    }
    Ok(())
}

#[test]
fn narrow_log_drops_the_date_then_the_author_then_cuts_subjects() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.cx.simulate_resize(size(px(1800.), px(900.)));
    open_log(&mut v);
    tall(&mut v);
    v.wait_until("wide: author + date", |v| {
        read_log(v, |t| {
            let c = t.shown_columns();
            c.0 > 0. && c.1 > 0.
        })
    });
    rows_fit(&mut v).unwrap();
    // the window shrinks: rows still fit
    v.cx.simulate_resize(size(px(1100.), px(900.)));
    v.wait_until("Git island follows the window", |v| {
        v.read(|e| e.geometry().role_rect(Role::Git).map(|r| r.island.right()))
            .is_some_and(|r| r < px(1100.))
    });
    v.pump();
    rows_fit(&mut v).unwrap();
    // the splitter dragged left step by step: the date goes first, then the author
    let mut seen_date_only_gone = false;
    let mut last = (1., 1.);
    for _ in 0..40 {
        let d = must(&mut v, "git-log-split-divider");
        drag(
            &mut v,
            d.center(),
            point(d.center().x - px(40.), d.center().y),
        );
        let (a, dt, _) = read_log(&mut v, |t| t.shown_columns());
        assert!(!(a == 0. && dt > 0.), "the author went before the date");
        if a > 0. && dt == 0. {
            seen_date_only_gone = true;
        }
        rows_fit(&mut v).unwrap_or_else(|e| panic!("rows fit: {e}"));
        last = (a, dt);
        if a == 0. {
            break;
        }
    }
    assert!(seen_date_only_gone, "a width with the author but no date");
    assert_eq!(last, (0., 0.), "very narrow: no author, no date");
    assert!(sel_bounds(&mut v, "date", 0).is_none() && sel_bounds(&mut v, "author", 0).is_none());
    // very narrow (the log at its minimum width): long subjects cut (ellipsis: the text is
    // wider than its box)
    for _ in 0..20 {
        let d = must(&mut v, "git-log-split-divider");
        drag(
            &mut v,
            d.center(),
            point(d.center().x - px(40.), d.center().y),
        );
        if near(must(&mut v, "git-log-split-divider").left(), d.left()) {
            break;
        }
    }
    rows_fit(&mut v).unwrap();
    let subs = subjects(&mut v);
    let mut cut = Vec::new();
    for (ix, s) in subs.iter().enumerate() {
        let b = sel_bounds(&mut v, "subject", ix).unwrap();
        if text_width(&mut v, s) > b.size.width.as_f32() + 1. {
            cut.push(s.clone());
        }
    }
    assert!(!cut.is_empty(), "some subject is cut: {subs:?}");
}

// ---- Project tool window beside the Log ------------------------------------------------------

#[test]
fn project_tool_window_opening_keeps_the_git_island_full_width() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    // the tree closed first
    if v.read(|e| e.geometry().layout.tree.is_some()) {
        v.lua("require('config.tree').close() return true");
        v.wait_for("tree closed", |e| e.geometry().layout.tree.is_none());
    }
    let full = |v: &mut View| {
        v.read(|e| {
            let g = e.geometry();
            let island = g.role_rect(Role::Git).map(|r| r.island);
            let inner = g.layout.frame.inner;
            island.map(|i| (i.left() == inner.left() && i.right() == inner.right(), i))
        })
    };
    assert!(full(&mut v).is_some_and(|(f, _)| f));
    v.keystrokes("cmd-1");
    // every frame until the tree is open, and a few after: the Git island full width
    let mut frames = 0;
    v.wait_until("tree open", |v| {
        frames += 1;
        let (ok, island) = full(v).expect("Git island laid out");
        assert!(ok, "frame {frames}: Git island squeezed: {island:?}");
        v.read(|e| e.geometry().layout.tree.is_some())
    });
    for _ in 0..5 {
        v.settle();
        let (ok, island) = full(&mut v).unwrap();
        assert!(ok, "after: {island:?}");
    }
    assert!(frames > 0);
}

// ---- Show History for Selection --------------------------------------------------------------

fn focus_split(v: &mut View) {
    v.focus_code();
    wait_target(v, "split");
    v.wait_until("the editor has the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus()).is_none()
    });
}

fn diff_cursor(v: &View) -> i64 {
    v.lua(
        "local w = require('git.diff').wins()[1] return w and vim.api.nvim_win_get_cursor(w)[1] or 0",
    )
    .as_i64()
    .unwrap_or(0)
}

fn diff_new_rev(v: &View) -> String {
    v.lua("local s = require('git.diff').state() return s and s.revs and s.revs.new or ''")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn diff_new_file(v: &View) -> bool {
    v.lua(
        "local s = require('git.diff').state() local f = s and s.files and s.files[s.index] \
         return f ~= nil and f.status == 'A'",
    )
    .as_bool()
        == Some(true)
}

fn diff_open(v: &View) -> bool {
    v.lua("return require('git.diff').is_active()").as_bool() == Some(true)
}

/// Waits for `pred`, advancing the test clock (the history's diff follows the cursor after an
/// 80 ms timer).
fn wait_clock(v: &mut View, label: &str, mut pred: impl FnMut(&mut View) -> bool) {
    v.wait_until(label, |v| {
        v.advance(Duration::from_millis(100));
        pred(v)
    });
}

#[test]
fn editor_context_menu_offers_history_for_selection_or_file() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.lua("vim.api.nvim_win_set_cursor(0, { 2, 0 }) return true");
    v.keystrokes("shift-v");
    v.key("ö");
    v.keystrokes("cmd-enter");
    v.wait_until("menu with Show History for Selection", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l == "Show History for Selection"))
    });
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    v.keystrokes("escape");
    v.wait_lua("normal mode", "return vim.fn.mode() == 'n'");
    v.keystrokes("cmd-enter");
    v.wait_until("menu with Show History for File", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l == "Show History for File"))
    });
    let rows = menu_rows(&mut v).unwrap();
    assert!(
        !rows.iter().any(|l| l == "Show History for Selection"),
        "{rows:?}"
    );
    v.keystrokes("escape");
}

#[test]
fn history_for_selection_lists_the_lines_commits_and_follows_with_the_diff() {
    // a private copy: the edited buffer gets saved (autosave on focus changes)
    let (fx, mut v) = start_copy();
    let repo = fx.repo.clone();
    let rev = |r: &str| git(&repo, &["rev-parse", r]);
    // the Log open on its own first (Esc gives the full log back later)
    open_log(&mut v);
    let all = subjects(&mut v).len();
    focus_split(&mut v);
    // an unsaved line on top: buffer lines 3-4 are HEAD's 2-3
    v.lua(
        "vim.api.nvim_buf_set_lines(0, 0, 0, false, { '// unsaved' }) \
         vim.api.nvim_win_set_cursor(0, { 3, 0 }) return true",
    );
    v.keystrokes("shift-v");
    v.key("ö");
    v.wait_lua(
        "Visual lines 3-4",
        "return vim.fn.mode() == 'V' and vim.fn.line('v') == 3 and vim.fn.line('.') == 4",
    );
    v.keystrokes(", shift-h");
    let want = [
        "AB#1236 Recent blame line",
        "AB#1234 Added checkout page texts",
        "AB#100 Initial setup",
    ];
    let mut seen = Vec::new();
    v.wait_until("the lines' commits listed", |v| {
        let st = read_log(v, |t| (t.model.kind, t.loading, t.filters.lines.clone()));
        let now = vec![
            format!("{st:?}"),
            format!("{:?}", subjects(v)),
            format!("{:?}", balloons(v)),
            v.mode(),
            target(v),
        ];
        if now != seen {
            eprintln!("history listing: {now:?}");
            seen = now;
        }
        st.0 == LogKind::Lines && !st.1 && subjects(v) == want
    });
    // subject, author, hash columns; the keyboard in the table
    v.wait_until("hash column drawn", |v| sel_bounds(v, "hash", 0).is_some());
    v.wait_until("author column + Lines chip", |v| {
        sel_bounds(v, "author", 0).is_some()
            && read_log(v, |t| {
                t.filter_bar_text()
                    .iter()
                    // (its label dropped at this width: the field keeps "Text or hash" whole)
                    .any(|s| s.contains("blame.ts:3-4 ×"))
            })
    });
    assert!(read_log(&mut v, |t| t.shown_columns().2 > 0.));
    let authors: Vec<String> = read_log(&mut v, |t| {
        t.model
            .commits
            .iter()
            .map(|c| c.author.name.clone())
            .collect()
    });
    assert_eq!(authors, ["Max", "Ada Example", "Aaron Sample"]);
    wait_target(&mut v, "git");
    v.wait_until("table focused", table_focused);
    // the newest commit's diff of the lines, at line 2 of the current version
    wait_clock(&mut v, "diff of HEAD~1 at line 2", |v| {
        diff_open(v) && diff_new_rev(v) == rev("HEAD~1") && diff_cursor(v) == 2
    });
    // ö: the next commit's diff follows
    down(&mut v);
    wait_clock(&mut v, "diff of HEAD~2^", |v| {
        diff_new_rev(v) == rev("HEAD~2^")
    });
    down(&mut v);
    // (the root commit: Initial setup = HEAD~2^^^)
    wait_clock(&mut v, "root commit: new file", |v| {
        diff_new_rev(v) == rev("HEAD~2^^^") && diff_new_file(v)
    });
    // Enter: into the diff
    v.keystrokes("enter");
    wait_target(&mut v, "diff");
    assert!(diff_new_file(&v));
    // Git opened again: back to the list, Esc closes the history
    open_git(&mut v);
    v.wait_until("table focused", table_focused);
    v.keystrokes("escape");
    wait_target(&mut v, "split");
    v.wait_until("all commits back, diff closed", |v| {
        read_log(v, |t| {
            t.model.kind == LogKind::Graph && t.filters.lines.is_none()
        }) && loaded(v)
            && subjects(v).len() == all
            && !diff_open(v)
            && read_log(v, |t| {
                !t.filter_bar_text().iter().any(|s| s.contains("Lines"))
            })
    });
    assert!(
        git_open(&mut v),
        "the tool window was open before: stays open"
    );
}

#[test]
fn history_for_selection_from_a_hidden_tool_window_and_balloons() {
    let (_fx, mut v) = start_copy();
    assert!(!git_open(&mut v));
    v.lua(
        "vim.api.nvim_buf_set_lines(0, 0, 0, false, { '// unsaved' }) \
         vim.api.nvim_win_set_cursor(0, { 2, 0 }) return true",
    );
    // one line unchanged since the first commit: one commit
    v.keystrokes("shift-v , shift-h");
    v.wait_until("one commit", |v| {
        git_open(v)
            && read_log(v, |t| t.model.kind == LogKind::Lines && !t.loading)
            && subjects(v) == ["AB#100 Initial setup"]
    });
    wait_target(&mut v, "git");
    // ,q: the history closes, the tool window hides again
    v.keystrokes(", q");
    v.wait_until("hidden again", |v| !git_open(v));
    wait_target(&mut v, "split");
    v.wait_until("the editor has the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus()).is_none()
    });
    assert!(read_log(&mut v, |t| t.filters.lines.is_none()));
    // the unsaved line: a balloon, no history
    v.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 }) return true");
    v.keystrokes("shift-v , shift-h");
    v.wait_until("balloon", |v| has_balloon(v, "aren't committed yet"));
    assert!(!git_open(&mut v));
    // a buffer without a file
    v.lua("vim.cmd('silent! undo') vim.cmd('enew') return true");
    v.keystrokes(", shift-h");
    v.wait_until("balloon", |v| has_balloon(v, "No file to show history for"));
    assert!(!git_open(&mut v));
}

// ---- hide / show -----------------------------------------------------------------------------

/// What the Log shows around its cursor: the drawn rows (index, top, subject), the cursor, the row
/// count.
#[derive(Debug, PartialEq)]
struct Shown {
    rows: Vec<(usize, Pixels, String)>,
    cursor: Option<usize>,
    len: usize,
}

fn shown(v: &mut View) -> Shown {
    v.pump();
    let (subjects, cursor, len) = read_log(v, |t| {
        let at = t.model.cursor().unwrap_or(0);
        let s: Vec<(usize, String)> = t
            .model
            .commits
            .iter()
            .enumerate()
            .skip(at.saturating_sub(60))
            .take(120)
            .map(|(ix, c)| (ix, c.subject.to_string()))
            .collect();
        (s, t.model.cursor(), t.model.len())
    });
    let rows = subjects
        .into_iter()
        .filter_map(|(ix, s)| sel_bounds(v, "subject", ix).map(|b| (ix, b.top(), s)))
        .collect();
    Shown { rows, cursor, len }
}

/// What may change on screen while a [`Keep`] runs.
#[derive(Clone, Copy, Debug)]
enum Frames {
    /// The Log is hidden in between: only the end counts.
    Hidden,
    /// The cursor's row stays where it was in every frame.
    CursorRow,
    /// Every frame shows exactly what was there.
    Same,
}

/// Something that hides or reloads the Log: `act` starts it, `done` says it ended (given the
/// refresh count before it).
struct Keep {
    name: &'static str,
    act: fn(&mut View),
    done: fn(&mut View, usize) -> bool,
    frames: Frames,
}

const KEEPS: &[Keep] = &[
    Keep {
        name: "hidden, shown again",
        act: |v| {
            hide_git(v);
            v.lua("require('config.app.git').open() return true");
        },
        done: |v, _| git_open(v) && loaded(v) && table_focused(v),
        frames: Frames::Hidden,
    },
    Keep {
        name: "R reloads it",
        act: |v| {
            v.keystrokes("shift-r");
            v.wait_until("reload started", |v| read_log(v, |t| t.loading));
        },
        done: |v, _| read_log(v, |t| !t.loading),
        frames: Frames::CursorRow,
    },
    Keep {
        name: "the app back in focus with nothing new",
        act: |v| {
            v.cx.deactivate_window();
            v.cx.update(|window, _| window.activate_window());
        },
        done: |v, before| {
            read_log(v, |t| {
                t.refreshes.len() > before
                    && t.refreshes.last() == Some(&RepoChange::Focus)
                    && !t.loading
            })
        },
        frames: Frames::Same,
    },
];

/// A deep cursor on a long log: each [`Keep`] leaves the cursor and the rows in view where they
/// were, and the table keeps the keyboard.
#[test]
fn the_log_keeps_its_rows_across_hide_show_and_refreshes() {
    let fx = gitfix::big_repo(2_000);
    let mut v = View::start(fx.repo.to_str().unwrap(), &[]);
    v.settle();
    open_log(&mut v);
    v.wait_until("all listed", |v| {
        read_log(v, |t| !t.loading && t.model.len() > 1000)
    });
    for _ in 0..60 {
        v.keystrokes("pagedown");
    }
    let c = cursor(&mut v).unwrap();
    assert!(c > 150, "deep in the log: {c}");
    v.wait_until("cursor row drawn", |v| {
        sel_bounds(v, "subject", c).is_some()
    });
    v.settle();
    for keep in KEEPS {
        let before = shown(&mut v);
        assert!(
            before.rows.iter().any(|r| r.0 == c) && before.rows[0].0 > 0,
            "{}: rows around the cursor, scrolled: {before:?}",
            keep.name
        );
        let at = row_bounds(&mut v, c).top();
        let (refreshes, started) = read_log(&mut v, |t| (t.refreshes.len(), t.load_started_at));
        (keep.act)(&mut v);
        let deadline = std::time::Instant::now() + common::TIMEOUT;
        loop {
            match keep.frames {
                Frames::Hidden => {}
                Frames::CursorRow => {
                    let b = sel_bounds(&mut v, "subject", c);
                    assert!(
                        b.is_some_and(|b| (b.top() - at).abs() < px(1.)),
                        "{}: the cursor row moved: {b:?} vs {at:?}",
                        keep.name
                    );
                }
                Frames::Same => assert_eq!(shown(&mut v), before, "{}: a frame changed", keep.name),
            }
            if (keep.done)(&mut v, refreshes) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{}: never ended",
                keep.name
            );
            v.wait_lua("idle", "return true");
        }
        v.advance(Duration::from_millis(1500));
        v.settle();
        v.wait_until(&format!("{}: the same rows in view", keep.name), |v| {
            shown(v) == before
        });
        assert!(
            table_focused(&mut v),
            "{}: the table keeps the keyboard",
            keep.name
        );
        if let Frames::Same = keep.frames {
            assert!(
                read_log(&mut v, |t| t.load_started_at) > started,
                "{}: git ran again",
                keep.name
            );
        }
    }
}

// ---- Cmd+C -----------------------------------------------------------------------------------

const BODY: &str = "AB#3 With body\n\nBody line.";

#[test]
fn cmd_c_copies_the_full_messages() {
    let (fx, mut v) = start_copy();
    open_log(&mut v);
    gitfix::git(
        &fx.repo,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "AB#3 With body",
            "-m",
            "Body line.",
        ],
    );
    v.keystrokes("shift-r");
    v.wait_until("new commit on top", |v| {
        subjects(v).first().map(String::as_str) == Some("AB#3 With body")
    });
    // (a refresh keeps the cursor on its commit: Home to the new one)
    v.keystrokes("home");
    v.wait_until("cursor on it", |v| cursor(v) == Some(0));
    v.keystrokes("cmd-c");
    v.wait_until("full message copied", |v| clipboard(v) == BODY);
    // 2 selected: both, newest first, a blank line between
    space(&mut v);
    down(&mut v);
    space(&mut v);
    let both = format!("{BODY}\n\nAB#1235 Renamed b");
    v.keystrokes("cmd-c");
    v.wait_until("both copied", |v| clipboard(v) == both);
    // a mouse drag over two rows selects them
    v.keystrokes("escape");
    assert!(selected(&mut v).is_empty());
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("S".into()));
    let a = must(&mut v, "git-log-subject-0").center();
    let b = must(&mut v, "git-log-subject-1").center();
    drag(&mut v, a, b);
    assert_eq!(selected(&mut v), ["AB#3 With body", "AB#1235 Renamed b"]);
    assert!(table_focused(&mut v));
    v.keystrokes("cmd-c");
    v.wait_until("both copied after the drag", |v| clipboard(v) == both);
    // Shift+Down (Lua's V + move): the rows' messages
    v.keystrokes("escape");
    v.keystrokes("home");
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("S".into()));
    v.keystrokes("shift-down");
    v.keystrokes("cmd-c");
    v.wait_until("both copied after Shift+Down", |v| clipboard(v) == both);
    assert_eq!(v.mode(), "n");
}

// ---- branch colors ---------------------------------------------------------------------------

fn cgit(dir: &Path, args: &[&str]) {
    let mut all = vec!["-c", "user.name=T", "-c", "user.email=t@x"];
    all.extend_from_slice(args);
    gitfix::git(dir, &all);
}

/// The node color of each listed subject.
fn node_colors(v: &mut View, subs: &[&str]) -> Vec<u32> {
    read_log(v, |t| {
        subs.iter()
            .map(|s| {
                let ix = t
                    .model
                    .commits
                    .iter()
                    .position(|c| c.subject == *s)
                    .unwrap_or_else(|| panic!("no row {s}"));
                t.model.graph.rows[ix].color
            })
            .collect()
    })
}

fn all_same(c: &[u32]) -> bool {
    c.windows(2).all(|w| w[0] == w[1])
}

/// A repo with main (init, m2, m3) and feature (f1, f2) checked out.
fn color_repo() -> std::path::PathBuf {
    let dir = temp_dir("vimstorm-gcolors-");
    gitfix::git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    cgit(&dir, &["add", "-A"]);
    cgit(&dir, &["commit", "-q", "-m", "init"]);
    for m in ["m2", "m3"] {
        cgit(&dir, &["commit", "-q", "--allow-empty", "-m", m]);
    }
    cgit(&dir, &["checkout", "-q", "-b", "feature"]);
    for m in ["f1", "f2"] {
        cgit(&dir, &["commit", "-q", "--allow-empty", "-m", m]);
    }
    dir
}

/// Starts in the color repo on its Log: (feature colors, main colors).
fn start_colors(dir: &Path) -> (View, Vec<u32>, Vec<u32>) {
    let mut v = View::start(dir.to_str().unwrap(), &["a.txt"]);
    v.wait_screen("a");
    open_log(&mut v);
    v.wait_until("all listed", |v| {
        subjects(v) == ["f2", "f1", "m3", "m2", "init"]
    });
    let feature = node_colors(&mut v, &["f2", "f1"]);
    let main = node_colors(&mut v, &["m3", "m2", "init"]);
    (v, feature, main)
}

#[test]
fn branch_colors_follow_ws() {
    let dir = color_repo();
    let (mut v, feature, main) = start_colors(&dir);
    // feature's commits one color, main's another
    assert!(
        all_same(&feature) && all_same(&main) && feature[0] != main[0],
        "feature {feature:06x?} vs main {main:06x?}"
    );
    // main with a merged side branch, its ref deleted
    cgit(&dir, &["checkout", "-q", "main"]);
    cgit(&dir, &["checkout", "-q", "-b", "side"]);
    for m in ["s1", "s2"] {
        cgit(&dir, &["commit", "-q", "--allow-empty", "-m", m]);
    }
    cgit(&dir, &["checkout", "-q", "main"]);
    cgit(&dir, &["commit", "-q", "--allow-empty", "-m", "m4"]);
    cgit(
        &dir,
        &[
            "merge",
            "-q",
            "--no-ff",
            "--no-edit",
            "-m",
            "Merge side",
            "side",
        ],
    );
    cgit(&dir, &["branch", "-q", "-D", "side"]);
    v.keystrokes("shift-r");
    v.wait_until("main's log", |v| {
        loaded(v) && {
            let s = subjects(v);
            s.iter().any(|x| x == "s2")
                && s.iter().any(|x| x == "Merge side")
                && !s.iter().any(|x| x == "f2")
        }
    });
    let side = node_colors(&mut v, &["s2", "s1"]);
    let main = node_colors(&mut v, &["Merge side", "m4", "m3"]);
    assert!(
        all_same(&side) && all_same(&main),
        "side {side:06x?} main {main:06x?}"
    );
    assert_ne!(side[0], main[0], "the side branch has its own color");
    // the row below the merge: main's lane keeps main's color, the diagonal into the side
    // branch has the side's
    let merge = row_of(&mut v, "Merge side");
    let g = graph(&mut v);
    let below = &g.rows[merge + 1];
    let main_lane = g.rows[merge].node;
    let diag = below
        .edges
        .iter()
        .find(|e| e.up && e.to == main_lane && e.from != main_lane)
        .unwrap_or_else(|| panic!("diagonal edge below the merge: {below:?}"));
    assert_eq!(diag.color, side[0], "{below:?}");
    let straight = below
        .edges
        .iter()
        .find(|e| e.up && e.from == main_lane && e.to == main_lane)
        .unwrap_or_else(|| panic!("main's lane below the merge: {below:?}"));
    assert_eq!(straight.color, main[0], "{below:?}");
}

/// WS colors from the graph of all refs (IntelliJ's permanent graph; the branch filter only hides
/// rows), so main's ref past the fork still colors the fork point and below. GDATA lays out the
/// listed commits only: m3..init take feature's color once main's ref leaves the HEAD log.
#[test]
fn branch_colors_stay_when_main_moves_past_the_fork() {
    let dir = color_repo();
    let (mut v, feature, main) = start_colors(&dir);
    cgit(&dir, &["checkout", "-q", "main"]);
    cgit(&dir, &["commit", "-q", "--allow-empty", "-m", "m-ahead"]);
    cgit(&dir, &["checkout", "-q", "feature"]);
    v.keystrokes("shift-r");
    v.wait_until("reloaded", |v| loaded(v) && subjects(v).len() == 5);
    assert_eq!(node_colors(&mut v, &["f2", "f1"]), feature);
    assert_eq!(node_colors(&mut v, &["m3", "m2", "init"]), main);
}

#[test]
fn history_for_selection_and_custom_filters_survive_hide_show() {
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
    let rows = subjects(&mut v);
    hide_and_show(&mut v);
    assert!(
        read_log(&mut v, |t| t.filters.lines.is_some()
            && t.model.kind == LogKind::Lines),
        "the history is still on"
    );
    assert_eq!(subjects(&mut v), rows);
    v.wait_until("Lines chip", |v| {
        read_log(v, |t| {
            t.filter_bar_text()
                .iter()
                .any(|s| s.contains("blame.ts:2-3"))
        })
    });
    // closed: the plain log; a custom date range and file history (follow) survive hide / show
    v.keystrokes("escape");
    v.wait_until("history closed", |v| {
        read_log(v, |t| t.filters.lines.is_none()) && loaded(v)
    });
    open_log(&mut v);
    update_log(&mut v, |t, cx| {
        t.update_filters(
            |f| {
                f.date = Some(DateFilter::Range {
                    since: Some("2000-01-01".into()),
                    until: None,
                })
            },
            cx,
        )
    });
    v.wait_until("range listed", loaded);
    hide_and_show(&mut v);
    assert!(read_log(&mut v, |t| matches!(
        t.filters.date,
        Some(DateFilter::Range { .. })
    )));
    // the session keeps it too
    assert_eq!(
        v.lua("return require('config.app.git').log_filters().date_since")
            .as_str(),
        Some("2000-01-01")
    );
    v.lua("require('config.app.git').file_history('blame.ts') return true");
    v.wait_until("file history", |v| {
        read_log(v, |t| t.filters.follow && !t.loading)
    });
    hide_and_show(&mut v);
    assert!(read_log(&mut v, |t| t.filters.follow), "--follow kept");
    // a user filter set after all that is what the next open shows (no stale session state)
    update_log(&mut v, |t, cx| {
        t.update_filters(|f| f.authors = vec!["Max".into()], cx)
    });
    v.wait_until("user filter", loaded);
    hide_and_show(&mut v);
    assert_eq!(read_log(&mut v, |t| t.filters.authors.clone()), ["Max"]);
}

#[test]
fn clicks_from_the_editor_make_the_host_window_current() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    v.keystrokes("escape");
    wait_target(&mut v, "split");
    // a right-click on a row (the row handler stops the click)
    let r1 = row_bounds(&mut v, 1);
    press(
        &mut v,
        r1.center(),
        MouseButton::Right,
        Modifiers::default(),
        1,
    );
    v.wait_until("menu", |v| menu_rows(v).is_some());
    v.wait_until("host current", |v| host_current(v));
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    wait_target(&mut v, "git");
    // Esc goes back to the editor again
    v.keystrokes("escape");
    wait_target(&mut v, "split");
    let r0 = row_bounds(&mut v, 0);
    left(&mut v, r0.center());
    v.wait_until("host current (left click)", |v| host_current(v));
}

#[test]
fn gg_ctrl_d_and_v_move() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    v.keystrokes("shift-g");
    let last = subjects(&mut v).len() - 1;
    assert_eq!(cursor(&mut v), Some(last));
    v.keystrokes("g g");
    assert_eq!(cursor(&mut v), Some(0));
    v.keystrokes("ctrl-d");
    assert!(cursor(&mut v).is_some_and(|c| c > 0), "Ctrl+D moves down");
    v.keystrokes("ctrl-u");
    assert_eq!(cursor(&mut v), Some(0));
    // Lua "V + move, Cmd+C: the rows' messages": v / V + move select the commits passed
    v.keystrokes("shift-v ö");
    assert_eq!(selected(&mut v).len(), 2);
    v.keystrokes("escape");
    assert_eq!(selected(&mut v).len(), 2, "Esc ends v, the selection stays");
    v.keystrokes("cmd-c");
    v.wait_until("both messages", |v| {
        clipboard(v) == "AB#1235 Renamed b\n\nAB#1236 Recent blame line"
    });
    v.keystrokes("escape");
    assert!(selected(&mut v).is_empty());
}

#[test]
fn the_tab_overflow_lists_the_hidden_tabs() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    update_log(&mut v, |t, cx| {
        t.update_filters(
            |f| f.branch = BranchFilter::Ref("a/very/long/branch/name/that/goes/on".into()),
            cx,
        )
    });
    // narrow enough that "Local Changes" doesn't fit next to the long Log label (the tool
    // window's name leads the header; Commit / Push / Draft PR… / ⋮ / − at the right; the
    // selected Log tab gives way so the overflow button stays reachable)
    v.cx.simulate_resize(size(px(480.), px(880.)));
    v.wait_until("overflow button", |v| {
        bounds(v, "tool-tabs-overflow").is_some()
    });
    let b = bounds(&mut v, "tool-tabs-overflow").unwrap();
    left(&mut v, b.center());
    v.wait_until("hidden tabs listed", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains("Local Changes")))
    });
    pick_menu(&mut v, "Local Changes");
    v.wait_until("Local Changes shown", |v| active(v) == TabId::Changes);
}

#[test]
fn an_empty_repo_shows_an_empty_log_not_gits_error() {
    let dir = temp_dir("vimstorm-empty");
    git(&dir, &["init", "-q", "-b", "master"]);
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    let mut v = View::start(dir.to_str().unwrap(), &["a.txt"]);
    v.wait_screen("a");
    v.lua("require('config.app.git').open('log') return true");
    v.wait_until("loaded", |v| {
        git_open(v) && read_log(v, |t| !t.loading && t.error.is_some())
    });
    assert_eq!(
        read_log(&mut v, |t| t.empty_text()),
        "No commits matching filters",
        "not git's fatal: line"
    );
    assert!(bounds(&mut v, "git-log-subject-0").is_none());
}
