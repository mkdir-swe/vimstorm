//! The Git tool window host on the real nvim + config: `config.app.git` opens / focuses / hides
//! the native GitView over its placeholder nvim window in the bottom tool window, Esc gives the
//! keyboard back to the split, the terminal and Git share the bottom, tabs switch by mouse and
//! Alt+Cmd+Left/Right, the open tab goes to the session, Lua entry points reach the tabs, and the
//! diff's panes are presented together in every frame (sync groups) while scrolling by keys, wheel
//! and trackpad, and Create Draft PR's dialog.

use crate::common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::bridge::{fake_on, log};
use common::gitfix;
use common::gitui::{active, git_open, target, wait_target};
use common::view::View;
use gpui_kit::{MouseButton, ScrollDelta, TouchPhase, point, px};
use serde_json::json;
use vimstorm::git::window::{self, GitCommand, RepoChange, Stop, TabId};
use vimstorm::nvim::GridId;
use vimstorm::render::GridHost as _;
use vimstorm::shell::{Role, WinKind};

/// Where the keyboard is in the strip (a tab, or the Log's commit files).
fn stop(v: &mut View) -> Stop {
    let g = v.read_ws(|ws, _| ws.git().clone());
    v.pump();
    v.cx.update(|w, cx| g.read(cx).stop(w, cx))
}

fn labels(v: &mut View) -> Vec<String> {
    v.read_ws(|ws, cx| {
        ws.git()
            .read(cx)
            .labels(cx)
            .iter()
            .map(|l| l.to_string())
            .collect()
    })
}

/// The GitView has the keyboard (and the workspace told Lua).
fn git_focused(v: &mut View) -> bool {
    v.read_ws(|ws, _| ws.native_focus() == Some("git"))
}

/// The host window is laid out with its role, the GitView mounted over it, its grid not drawn.
fn host_shown(v: &mut View) -> bool {
    v.read(|e| {
        let g = e.geometry();
        let Some(host) = g.role_rect(Role::Git) else {
            return false;
        };
        host.bottom && host.kind == WinKind::Tool && g.place(host.grid).is_none()
    })
}

fn open_git(v: &mut View) {
    v.lua("require('config.app.git').open() return true");
    wait_target(v, "git");
    v.wait_until("GitView open with the keyboard", |v| {
        git_open(v) && git_focused(v) && host_shown(v)
    });
}

#[test]
fn git_opens_focuses_and_hides_esc_goes_back_to_the_split() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    let split = v
        .lua("return vim.api.nvim_get_current_win()")
        .as_i64()
        .unwrap();
    open_git(&mut v);
    // nvim's current window is the host window
    assert_eq!(
        v.lua("return vim.api.nvim_get_current_win() == require('config.app.git').win()")
            .as_bool(),
        Some(true)
    );
    // typed keys don't reach the scratch buffer behind it
    v.keystrokes("i x escape");
    wait_target(&mut v, "split");
    v.wait_until("keyboard back in nvim", |v| !git_focused(v));
    assert_eq!(
        v.lua("return vim.api.nvim_get_current_win()").as_i64(),
        Some(split),
        "back in the split it came from"
    );
    assert!(git_open(&mut v), "Esc keeps it open");
    assert_eq!(v.mode(), "n");
    // opened again it has the keys, hidden from it the split has them (and the height back)
    open_git(&mut v);
    v.lua("require('config.app.git').hide() return true");
    wait_target(&mut v, "split");
    v.wait_until("hidden", |v| {
        !git_open(v) && !git_focused(v) && v.read(|e| e.geometry().layout.bottom.is_none())
    });
    // Cmd+2 from the tool window: the split, view stays open
    open_git(&mut v);
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until("Cmd+2: keyboard in nvim", |v| {
        !git_focused(v) && git_open(v)
    });
    // its close (,w / ,q / the old Cmd+Q, now the app's Close Project) hides it
    open_git(&mut v);
    v.lua("require('config.focus').close() return true");
    v.wait_until("close hid it", |v| !git_open(v));
    wait_target(&mut v, "split");
    // no grid resize reached nvim after its window closed ("Invalid window handle")
    assert_eq!(v.nvim_errors(), Vec::<String>::new(), "nvim error events");
}

#[test]
fn clicks_move_the_keyboard_and_nvims_current_window_together() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    // click the editor's text: keyboard and current window to the split
    let (row, col) = v.cell_of("line one");
    let at = v.cell_pos(row, col + 2);
    v.click(MouseButton::Left, at);
    wait_target(&mut v, "split");
    v.wait_until("editor has the keyboard", |v| !git_focused(v));
    // click into the tool window: back
    let host = v.read(|e| e.geometry().role_rect(Role::Git).unwrap().island);
    v.click(
        MouseButton::Left,
        point(host.center().x, host.bottom() - px(20.)),
    );
    wait_target(&mut v, "git");
    v.wait_until("GitView has the keyboard", git_focused);
    assert_eq!(
        v.lua("return vim.api.nvim_get_current_win() == require('config.app.git').win()")
            .as_bool(),
        Some(true)
    );
    // ,w / ,q (nvim's leader maps, through the GitView) in the tool window: hide it
    // (focus.close_file), the keyboard back in the split
    let wins = v.lua("return #vim.api.nvim_tabpage_list_wins(0)").as_i64();
    v.keystrokes(", q");
    v.wait_until(",q hid it", |v| !git_open(v));
    wait_target(&mut v, "split");
    open_git(&mut v);
    // Ctrl keys don't edit the buffer behind
    v.keystrokes("ctrl-w ctrl-a");
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("v escape");
    v.wait_lua("normal mode", "return vim.fn.mode() == 'n'");
    assert_eq!(
        v.lua("return #vim.api.nvim_tabpage_list_wins(0)").as_i64(),
        wins
    );
}

#[test]
fn git_and_the_terminal_take_the_bottom_in_turn() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    open_git(&mut v);
    // one tool window in the bottom, Git's; the Terminal hidden (its shells keep running)
    v.wait_until("only the host in the bottom", |v| {
        v.read(|e| {
            let g = e.geometry();
            let tools: Vec<_> = g.layout.wins.iter().filter(|w| w.bottom).collect();
            tools.len() == 1 && tools[0].role == Some(Role::Git)
        })
    });
    let island = v.read(|e| e.geometry().role_rect(Role::Git).unwrap().island);
    let inner = v.read(|e| e.geometry().layout.frame.inner);
    assert_eq!(island.origin.x, inner.origin.x, "full width under the tree");
    assert_eq!(island.right(), inner.right());
    // the Terminal takes the bottom back, Git hides
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.wait_until("Git hidden", |v| !git_open(v));
}

#[test]
fn tabs_switch_by_mouse_and_alt_cmd_arrows_and_go_to_the_session() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    assert_eq!(labels(&mut v)[..2], ["Local Changes", "Log: HEAD"]);
    // the strip: click the tab that isn't shown
    let first = active(&mut v);
    let other = first.step(1);
    v.wait_until("strip drawn", |v| {
        v.read_ws(|ws, cx| ws.git().read(cx).tab_bounds(other, cx).is_some())
    });
    let at = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(other, cx))
        .unwrap();
    v.click(MouseButton::Left, at.center());
    v.wait_until("clicked tab shown", |v| active(v) == other);
    let name = other.as_str();
    v.wait_lua(
        "Lua saved it",
        &format!("return require('config.app.git').tab() == '{name}'"),
    );
    // Alt+Cmd+Right / Left walk the strip, wrapping: the tabs, then the Log's changed files
    // ("Commit <hash>": the view stays, the keyboard moves into the files)
    let changes = v
        .read_ws(|ws, cx| ws.git().read(cx).tab_bounds(TabId::Changes, cx))
        .unwrap();
    v.click(MouseButton::Left, changes.center());
    v.wait_until("Local Changes", |v| stop(v) == Stop::Tab(TabId::Changes));
    v.keystrokes("alt-cmd-right");
    v.wait_until("Log", |v| stop(v) == Stop::Tab(TabId::Log));
    v.wait_until("the commit's tab", |v| labels(v).len() == 3);
    assert!(
        labels(&mut v)[2].starts_with("Commit "),
        "{:?}",
        labels(&mut v)
    );
    for (key, want) in [
        ("alt-cmd-right", Stop::CommitFiles),
        ("alt-cmd-right", Stop::Tab(TabId::Changes)),
        ("alt-cmd-left", Stop::CommitFiles),
        ("alt-cmd-left", Stop::Tab(TabId::Log)),
        ("alt-cmd-left", Stop::Tab(TabId::Changes)),
        ("alt-cmd-left", Stop::CommitFiles),
    ] {
        v.keystrokes(key);
        v.wait_until(&format!("{key} -> {want:?}"), |v| stop(v) == want);
        if want == Stop::CommitFiles {
            assert_eq!(active(&mut v), TabId::Log, "the Log stays shown");
            let marked = v.read_ws(|ws, cx| ws.git().read(cx).header().read(cx).selected());
            assert_eq!(marked, 2, "the header marks the commit's tab");
        }
    }
    // Lua's focus.cycle_tabs (the key reached nvim first) does the same
    v.lua("require('config.focus').cycle_tabs(1) return true");
    v.wait_until("cycled via Lua", |v| stop(v) == Stop::Tab(TabId::Changes));
    let name = TabId::Changes.as_str();
    v.wait_lua(
        "per-project file has it",
        &format!(
            "local f = vim.fn.stdpath('state') .. '/git-panel-tabs.json' \
             local d = vim.json.decode(table.concat(vim.fn.readfile(f), '')) \
             return d[require('git.cli').root] == '{name}'"
        ),
    );
    // the session: open tab saved; restored, Git stays as the app's panel has it (hidden here)
    v.lua("vim.api.nvim_exec_autocmds('VimLeavePre', {}) return true");
    let tab = v.lua(
        "local f = vim.fn.stdpath('state') .. '/open-files/' .. vim.fn.getcwd():gsub('[/\\\\:]', '%%') .. '.json' \
         return vim.json.decode(table.concat(vim.fn.readfile(f), '')).layout.git.tab",
    );
    assert_eq!(tab.as_str(), Some(name));
    v.lua("require('config.app.git').hide() return true");
    v.wait_until("hidden", |v| !git_open(v));
    wait_target(&mut v, "split");
    v.lua("require('git').restore({ tab = 'log' }) return true");
    v.settle();
    assert!(
        !git_open(&mut v),
        "the session opens no Git: the panel is the app's"
    );
    assert_eq!(target(&v), "split");
    // a new open picks the saved tab
    v.lua("require('config.app.git').tab_changed('changes') return true");
    v.lua("require('config.app.git').open() return true");
    v.wait_until("saved tab on open", |v| {
        git_open(v) && active(v) == TabId::Changes
    });
    // "stash" saved before the Stash tab went (git-panel-tabs.json, a session): the default tab
    v.lua("require('config.app.git').hide() return true");
    v.wait_until("hidden", |v| !git_open(v));
    v.lua(
        "local f = vim.fn.stdpath('state') .. '/git-panel-tabs.json' \
         vim.fn.writefile({ vim.json.encode({ [require('git.cli').root] = 'stash' }) }, f) return true",
    );
    v.lua("require('config.app.git').open() return true");
    v.wait_until("old saved tab: the default", |v| {
        git_open(v) && active(v) == first
    });
    v.lua("require('git').restore({ tab = 'stash' }) return true");
    v.wait_until("a restore leaves an open Git as it is", |v| {
        git_open(v) && host_shown(v) && active(v) == first
    });
    let errs = v.lua("return vim.api.nvim_exec2('messages', { output = true }).output");
    assert!(
        !errs.as_str().unwrap_or("").contains("E5108"),
        "no Lua error: {errs}"
    );
}

#[test]
fn lua_entry_points_and_repo_changes_reach_the_tabs() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    // ,H: file history -> the Log tab, its command
    v.lua("require('git').file_history(vim.api.nvim_buf_get_name(0)) return true");
    v.wait_until("Log with the file's history", |v| {
        active(v) == TabId::Log
            && v.read_ws(|ws, cx| {
                ws.git().read(cx).log().read(cx).commands
                    == vec![GitCommand::FileHistory {
                        path: "blame.ts".into(),
                    }]
            })
    });
    assert!(v.read_ws(|ws, cx| ws.git().read(cx).gcx().root().is_some()));
    v.lua("require('git').show_commit('abc123') return true");
    v.wait_until("show commit", |v| {
        v.read_ws(|ws, cx| {
            ws.git().read(cx).log().read(cx).commands.last()
                == Some(&GitCommand::ShowCommit {
                    hash: "abc123".into(),
                })
        })
    });
    // Cmd+K from the editor: Local Changes, commit
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("cmd-k");
    v.wait_until("commit", |v| {
        active(v) == TabId::Changes
            && v.read_ws(|ws, cx| {
                ws.git().read(cx).changes().read(cx).commands == vec![GitCommand::Commit]
            })
    });
    wait_target(&mut v, "git");
    // the repo changed in Lua (git.cli.changed) / on disk (the poll)
    let gen0 = v.read_ws(|ws, cx| ws.git().read(cx).gcx().generation());
    v.lua("require('git.cli').changed() return true");
    v.wait_until("tabs refreshed (Lua)", |v| {
        v.read_ws(|ws, cx| {
            ws.git()
                .read(cx)
                .changes()
                .read(cx)
                .refreshes
                .contains(&RepoChange::Lua)
        })
    });
    assert!(v.read_ws(|ws, cx| ws.git().read(cx).gcx().generation()) > gen0);
    v.lua("vim.fn.system({ 'git', 'commit', '--allow-empty', '-m', 'poll me' }) return true");
    v.wait_until("tabs refreshed (files)", |v| {
        v.advance(Duration::from_millis(1100));
        v.read_ws(|ws, cx| {
            ws.git()
                .read(cx)
                .log()
                .read(cx)
                .refreshes
                .contains(&RepoChange::Files)
        })
    });
}

// Scroll sync ------------------------------------------------------------------------------------

/// The diff's panes (new, old) once both are in a sync group.
fn diff_panes(v: &mut View) -> (GridId, GridId) {
    v.lua(
        "local f = { path = 'long.ts', status = 'M' } \
         require('git.diff').open({ f }, f, { old = 'HEAD' }) \
         vim.api.nvim_set_current_win(require('git.diff').wins()[1]) return true",
    );
    let wins = v.lua("return require('git.diff').wins()");
    let wins: Vec<i64> = wins
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_i64().unwrap())
        .collect();
    let grid_of = |e: &vimstorm::editor::EditorView, win: i64| {
        e.ui()
            .windows
            .iter()
            .find(|(_, w)| w.win == win)
            .map(|(g, _)| *g)
    };
    v.wait_for("both panes in one sync group", |e| {
        let (Some(a), Some(b)) = (grid_of(e, wins[0]), grid_of(e, wins[1])) else {
            return false;
        };
        e.sync().group_of(a).is_some() && e.sync().group_of(a) == e.sync().group_of(b)
    });
    let panes = v.read(|e| (grid_of(e, wins[0]).unwrap(), grid_of(e, wins[1]).unwrap()));
    v.wait_lua(
        "diff drawn",
        "local w = require('git.diff').wins() \
         return vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(w[2])) == 200 \
           and vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(w[1])) == 210",
    );
    v.settle();
    panes
}

/// Old line next to the current version's line in long.ts (lines "new 1..10" inserted at 50):
/// `git/scrollsync.lua`'s mapping new -> old, 1-based.
fn long_old(l: i64) -> i64 {
    if l < 50 {
        l
    } else if l < 60 {
        50
    } else {
        l - 10
    }
}

/// Every presented frame shows both panes aligned; returns how many frames were checked.
fn check_aligned(v: &mut View, (new, old): (GridId, GridId)) -> usize {
    let log = v.read(|e| e.presented_log().to_vec());
    let mut n = 0;
    for p in &log {
        let top = |g: GridId| p.panes.iter().find(|x| x.0 == g).map(|x| x.1 + 1);
        let (Some(a), Some(b)) = (top(new), top(old)) else {
            continue;
        };
        assert_eq!(
            b,
            long_old(a),
            "frame {n}: new pane at {a}, old pane at {b} ({p:?})\nall: {log:?}"
        );
        n += 1;
    }
    n
}

fn tops(v: &View) -> (i64, i64) {
    let t = v.lua(
        "local w = require('git.diff').wins() return { vim.fn.line('w0', w[1]), vim.fn.line('w0', w[2]) }",
    );
    let t = t.as_array().unwrap();
    (t[0].as_i64().unwrap(), t[1].as_i64().unwrap())
}

#[test]
fn diff_panes_are_presented_together_scrolling_by_keys() {
    let mut v = View::start("grepo", &["long.ts"]);
    v.wait_screen("line 1");
    let panes = diff_panes(&mut v);
    v.view
        .update(&mut v.cx, |e, _| e.sync_mut().record_presented(true));
    // Ctrl+D through the insertion and back, a frame each
    v.lua("vim.cmd('normal! gg') return true");
    v.settle();
    for _ in 0..6 {
        v.keystrokes("ctrl-d");
        v.settle();
    }
    v.wait_lua(
        "scrolled past the insertion",
        "return vim.fn.line('w0') > 70",
    );
    for _ in 0..3 {
        v.keystrokes("ctrl-u");
        v.settle();
    }
    // ö held: key repeat (nvim redraws between some of them, not all)
    for i in 0..60 {
        v.key("ö");
        if i % 3 == 0 {
            v.pump();
        }
    }
    v.settle();
    let (a, b) = tops(&v);
    assert_eq!(b, long_old(a), "nvim's panes line up");
    let n = check_aligned(&mut v, panes);
    assert!(n >= 10, "only {n} frames presented");
    assert!(!v.read(|e| e.sync().holding()), "nothing left held");
}

#[test]
fn diff_panes_scroll_together_by_wheel_and_trackpad_in_one_frame() {
    let mut v = View::start("grepo", &["long.ts"]);
    v.wait_screen("line 1");
    let (new, old) = diff_panes(&mut v);
    v.lua("vim.cmd('normal! gg') return true");
    v.wait_lua(
        "both at the top",
        "local w = require('git.diff').wins() return vim.fn.line('w0', w[1]) == 1 and vim.fn.line('w0', w[2]) == 1",
    );
    v.settle();
    v.view
        .update(&mut v.cx, |e, _| e.sync_mut().record_presented(true));
    let at = v.grid_pos(new, 5, 10);
    // mouse wheel: 3 lines per notch, both panes in one nvim call
    for _ in 0..8 {
        v.scroll(at, ScrollDelta::Lines(point(0., -1.)), TouchPhase::Moved);
        v.pump();
    }
    v.wait_lua(
        "wheel scrolled 24 lines",
        "return vim.fn.line('w0', require('git.diff').wins()[1]) == 25",
    );
    v.settle();
    let (a, b) = tops(&v);
    assert_eq!((a, b), (25, 25));
    // over the old pane too
    let at_old = v.grid_pos(old, 5, 10);
    for _ in 0..10 {
        v.scroll(
            at_old,
            ScrollDelta::Lines(point(0., -1.)),
            TouchPhase::Moved,
        );
        v.pump();
    }
    v.wait_lua(
        "old pane past the insertion",
        "return vim.fn.line('w0', require('git.diff').wins()[2]) == 55",
    );
    v.settle();
    let (a, b) = tops(&v);
    assert_eq!(b, 55);
    assert_eq!(long_old(a), 55, "new pane follows through the diff ({a})");
    v.lua("vim.api.nvim_set_current_win(require('git.diff').wins()[1]) vim.cmd('normal! gg') return true");
    v.settle();
    // trackpad: pixel deltas, sub-row offset on both panes while they move together
    let row = v.read(|e| e.metrics().row_height);
    let mut offset_steps = 0;
    for i in 0..12 {
        let phase = if i == 0 {
            TouchPhase::Started
        } else {
            TouchPhase::Moved
        };
        v.scroll(at, ScrollDelta::Pixels(point(px(0.), -row * 0.7)), phase);
        v.pump();
        v.settle();
        let (on_new, on_old) = v.read(|e| (e.scroll_offset_of(new), e.scroll_offset_of(old)));
        let (a, b) = tops(&v);
        if a < 45 && a == b {
            // in step outside the insertion: drawn at the same offset
            assert_eq!(on_new, on_old, "step {i}: offsets {on_new:?} / {on_old:?}");
            offset_steps += on_new.is_some() as usize;
        }
    }
    assert!(
        offset_steps >= 3,
        "sub-row offsets drawn on both: {offset_steps}"
    );
    // the gesture ends: settles on a row
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(0.))),
        TouchPhase::Ended,
    );
    for _ in 0..40 {
        v.advance(Duration::from_millis(16));
    }
    v.settle();
    let (a, b) = tops(&v);
    assert_eq!(b, long_old(a));
    let n = check_aligned(&mut v, (new, old));
    assert!(n >= 10, "only {n} frames presented");
}

#[test]
fn a_pane_scrolled_without_its_partner_is_held_until_lua_lines_them_up() {
    let mut v = View::start("grepo", &["long.ts"]);
    v.wait_screen("line 1");
    let (new, old) = diff_panes(&mut v);
    let t0 = v.read(|e| e.presented_top(new)).unwrap();
    // scroll the new pane without WinScrolled (Lua doesn't follow) and flush
    v.lua(
        "vim.o.eventignore = 'WinScrolled' \
         local w = require('git.diff').wins()[1] \
         vim.api.nvim_win_call(w, function() vim.cmd('normal! 20\\5') end) \
         vim.cmd('redraw') return true",
    );
    v.wait_until("the moved pane is held", |v| {
        v.read(|e| e.sync().held(new).is_some() && e.presented_top(new) == Some(t0))
    });
    // Lua lines them up: the partner follows, the hold ends with both at their new lines
    v.lua("require('git.scrollsync').sync(require('git.diff').wins()[1]) return true");
    v.wait_until("released together", |v| {
        v.read(|e| {
            !e.sync().holding()
                && e.presented_top(new) == Some(t0 + 20)
                && e.presented_top(old) == Some(long_old(t0 + 21) - 1)
        })
    });
    // without Lua: the timeout presents it anyway
    v.lua(
        "local w = require('git.diff').wins()[1] \
         vim.api.nvim_win_call(w, function() vim.cmd('normal! 5\\5') end) \
         vim.cmd('redraw') return true",
    );
    v.wait_until("held again", |v| v.read(|e| e.sync().holding()));
    v.advance(Duration::from_millis(30));
    v.wait_until("timed out: presented", |v| {
        v.read(|e| !e.sync().holding() && e.presented_top(new) == Some(t0 + 25))
    });
    v.lua("vim.o.eventignore = '' return true");
}

#[test]
fn header_options_and_hide_and_the_repo_poll_pauses_in_the_background() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_git(&mut v);
    let action = |v: &mut View, id: &str| {
        v.pump();
        let b = v
            .read_ws(|ws, cx| ws.git().read(cx).action_bounds(id, cx))
            .unwrap_or_else(|| panic!("no {id}"));
        common::gitui::left(v, b.center());
    };
    // ⋮: the tabs (shown one checked) + Hide; picking a tab shows it
    action(&mut v, "options");
    common::gitui::pick_menu(&mut v, "Log: HEAD");
    v.wait_until("Log tab", |v| active(v) == TabId::Log);
    // −: hides (Lua's hide, the split gets the keyboard)
    action(&mut v, "hide");
    v.wait_until("hidden", |v| !git_open(v));
    wait_target(&mut v, "split");
    // the repo poll stops while the app is in the background, resumes on activation
    open_git(&mut v);
    let watching = |v: &mut View| v.read_ws(|ws, cx| ws.git().read(cx).watching());
    v.wait_until("polling", |v| watching(v));
    v.cx.deactivate_window();
    v.wait_until("paused", |v| !watching(v));
    v.cx.update(|window, _| window.activate_window());
    v.wait_until("resumed", |v| watching(v));
}

// ---- Create Draft PR ---------------------------------------------------------------------------

/// The dialog's (title, base, description) and primary button, while it is open.
fn draft_pr(v: &mut View) -> Option<((String, String, String), String)> {
    v.pump();
    v.read_ws(|ws, cx| {
        let d = ws.git().read(cx).draft_pr()?.read(cx);
        Some((d.texts(cx), d.action()))
    })
}

fn open_draft_pr(v: &mut View, root: &Path) {
    let root = root.to_owned();
    let host = v.read_ws(|ws, _| ws.git().downgrade());
    v.cx.update(|window, cx| window::open(host, root, window, cx));
    v.wait_until("the Create Draft PR dialog", |v| draft_pr(v).is_some());
    let ws = v.ws.clone();
    v.wait_until("its title has the keyboard", |v| {
        v.cx.update(|window, cx| {
            ws.read(cx)
                .git()
                .read(cx)
                .draft_pr()
                .is_some_and(|d| d.read(cx).typing(window, cx))
        })
    });
}

/// The bridge's answer to the app's `run` `id`, written to `dir`.
fn answer(dir: &Path, id: &str, data: serde_json::Value) -> PathBuf {
    let path = dir.join(format!("answer-{}.json", id.replace(':', "-")));
    let frame = json!({"v": 2, "type": "answer", "id": id, "reply": {"ok": true, "data": data}});
    std::fs::write(&path, frame.to_string()).unwrap();
    path
}

/// The `run` frames the app sent, their argv.
fn runs(dir: &Path) -> Vec<Vec<String>> {
    log(dir)
        .into_iter()
        .filter(|l| l.contains(r#""type":"run""#))
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(&l).unwrap();
            serde_json::from_value(v["argv"].clone()).unwrap()
        })
        .collect()
}

/// Create Draft PR over the bridge (a fake one, its answers recorded shapes): the dialog shows the
/// repository, `base ← branch`, the title, the description from the commits and what stays local;
/// Esc runs nothing; ⏎ asks `draft-create` once with the base, the push and the reviewers picked.
// (its debug selectors exist only with debug assertions)
#[cfg(debug_assertions)]
#[test]
fn create_draft_pr_shows_its_target_and_pushes_only_on_enter() {
    // a real checkout: the Git tool window hosts the dialog
    let fixture = gitfix::fixture("grepo");
    let root = fixture.repo.clone();
    let dir = fixture.tmp.path().join("bridge");
    std::fs::create_dir_all(&dir).unwrap();
    let root_s = root.to_string_lossy().into_owned();
    let plan = json!({
        "root": root_s,
        "repo": "o/r",
        "branch": "feature/native-pr",
        "head": "c0ffee1234",
        "base": "master",
        "origin": "origin",
        "title": "Export summary",
        "body": "## What\n- Export summary",
        "commits": 1,
        "files": 1,
        "uncommitted": ["local-note.txt"],
        "published": false,
        "existing": null,
        "branches": ["master", "release"],
        "reviewers": [{"login": "bob", "name": "Bob B"}, {"login": "cyd", "name": ""}],
    });
    let made = json!({"number": 23, "url": "https://github.com/o/r/pull/23", "asked": null});
    let rules = [
        (
            r#""id":"pr-draft-plan:1""#,
            vec![answer(&dir, "pr-draft-plan:1", plan.clone())],
        ),
        (
            r#""id":"pr-draft-plan:2""#,
            vec![answer(&dir, "pr-draft-plan:2", plan.clone())],
        ),
        (
            r#""id":"pr-draft-create:3""#,
            vec![answer(&dir, "pr-draft-create:3", made)],
        ),
    ];
    let mut v = View::start_projects(&root_s, &[]);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| {
        cx.set_global(fake_on(&dir, &["frames/bridge-tree.json"], &rules));
        projects.update(cx, |p, cx| p.follow_factory(window, cx));
    });
    v.wait_until("the bridge started", |_| {
        log(&dir).iter().any(|l| l.starts_with("start "))
    });

    open_draft_pr(&mut v, &root);
    assert_eq!(
        runs(&dir),
        [vec![
            "pr".to_owned(),
            "draft-plan".to_owned(),
            format!("--path={root_s}")
        ]],
        "the plan read, nothing written"
    );
    let ((title, base, body), action) = draft_pr(&mut v).unwrap();
    assert_eq!(
        (title.as_str(), base.as_str(), action.as_str()),
        ("Export summary", "master", "Create draft ⏎")
    );
    assert!(body.contains("- Export summary"), "{body}");
    assert!(
        v.cx.debug_bounds("create-draft-pr-dialog").is_some(),
        "drawn"
    );
    let shown = v.read_ws(|ws, cx| ws.git().read(cx).draft_pr().unwrap().read(cx).plan.clone());
    assert_eq!(shown.repo, "o/r");
    assert_eq!(shown.branch, "feature/native-pr");
    assert_eq!(
        shown.uncommitted,
        ["local-note.txt"],
        "what stays local is named"
    );
    v.key("escape");
    v.wait_until("the dialog gone", |v| draft_pr(v).is_none());
    assert_eq!(runs(&dir).len(), 1, "Esc runs nothing");

    open_draft_pr(&mut v, &root);
    let rows = |v: &mut View| {
        v.pump();
        v.read_ws(|ws, cx| ws.popups().read(cx).menu_rows())
    };
    // Tab: the base, a pick of origin's branches (the default first); Esc keeps it
    v.key("tab");
    v.key("space");
    v.wait_until("the base's pick", |v| rows(v).is_some());
    let bases = rows(&mut v).unwrap();
    assert!(bases[0].starts_with("master"), "{bases:?}");
    assert!(
        !bases.iter().any(|b| b.starts_with("feature/native-pr")),
        "never the branch itself: {bases:?}"
    );
    v.key("escape");
    v.wait_until("the pick closed", |v| rows(v).is_none());
    // Tab Tab: Reviewers; Space: the repo's people by name; ⏎ asks Bob
    v.key("tab");
    v.key("tab");
    v.key("space");
    v.wait_until("the reviewers' pick", |v| rows(v).is_some());
    let people = rows(&mut v).unwrap();
    assert!(people[0].starts_with("Bob B"), "{people:?}");
    assert!(people.iter().any(|p| p.starts_with("cyd")), "{people:?}");
    v.key("enter");
    v.wait_until("Bob's chip", |v| {
        v.cx.debug_bounds("draft-pr-reviewer-bob").is_some()
    });
    v.key("enter");
    v.wait_until("draft PR created", |v| {
        v.read_ws(|ws, cx| ws.popups().read(cx).balloons())
            .iter()
            .any(|(title, text)| title == "Draft PR" && text.contains("PR #23"))
    });
    let all = runs(&dir);
    assert_eq!(all.len(), 3, "{all:?}");
    let create = &all[2];
    assert_eq!(&create[..2], ["pr", "draft-create"]);
    // each value inline: a text that starts with a dash stays a text
    let after = |flag: &str| {
        let lead = format!("{flag}=");
        create
            .iter()
            .find_map(|a| a.strip_prefix(&lead))
            .unwrap_or_else(|| panic!("{flag}"))
            .to_owned()
    };
    assert_eq!(after("--path"), root_s);
    assert_eq!(after("--repo"), "o/r", "the repository the dialog showed");
    assert_eq!(after("--head"), "c0ffee1234", "the head shown is pushed");
    assert_eq!(after("--base"), "master");
    assert_eq!(after("--title"), "Export summary");
    assert_eq!(after("--reviewer"), "bob");
    assert_eq!(after("--body"), "## What\n- Export summary");
    assert!(
        create.iter().any(|a| a == "--push"),
        "not on GitHub yet: pushed first"
    );
}
