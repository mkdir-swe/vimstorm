//! The Terminal tool window on the real nvim + config and real login shells, with real keys and
//! mouse through the GPUI test window and text typed through the view's IME handler as AppKit
//! commits it: the find bar, the scroll view, mouse and copy, tabs, the header's buttons and menu,
//! the bottom pane shared with Git, resize and maximize, the session, TUI mouse reporting, the
//! lazygit float, IME and perf.

use crate::common;

use std::time::{Duration, Instant};

use common::gitui::{clipboard, menu_rows, pick_menu};
use common::terminal::*;
use common::view::View;
use gpui_kit::{
    ElementInputHandler, InputHandler as _, MouseButton, ScrollDelta, ScrollWheelEvent, TouchPhase,
    point, px, size,
};

fn wait_target(v: &mut View, want: &str) {
    v.wait_lua(
        &format!("focus.target() == {want}"),
        &format!("return require('config.focus').target() == '{want}'"),
    );
}

fn menu_open(v: &mut View) -> bool {
    menu_rows(v).is_some()
}

fn dialog_open(v: &mut View) -> bool {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| p.dialog().is_some())
}

fn picker_kind(v: &mut View) -> Option<String> {
    v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| s.kind))
}

/// The scrollback: 3 x "needle" (one upper case) far apart; the command line itself has none.
fn needles(v: &mut View) {
    run(
        v,
        "n=nee; echo ${n}dle one; for i in $(seq 1 80); do echo row$i; done; echo NEE''DLE two; seq 1 5; echo x ${n}dle three",
    );
    wait_screen(v, "x needle three");
    settle(v);
}

#[test]
fn cmd_t_login_shell_cmd_o_and_esc() {
    let mut v = View::start("proj", &["a.ts"]);
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    wait_typing(&mut v);
    // the native view over its host window in the bottom pane
    v.wait_until("the host laid out", |v| term_rect(v).is_some());
    wait_prompt(&mut v);
    let pid = read(&mut v, |t, _| t.pids()[0]);
    let out = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let cmd = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        cmd.contains("-l") || cmd.trim_start().starts_with('-'),
        "login shell: {cmd}"
    );
    // plain keys through the IME path as typed letters
    v.keystrokes("e c h o space");
    type_text(&mut v, "nvt''mark");
    v.keystrokes("enter");
    wait_line(&mut v, "nvtmark");
    // output at column 0, inset like WS's gutter: x = grid origin = island + 8 px
    let at = cell_of(&mut v, "nvtmark", 0);
    let layout = read(&mut v, |t, _| t.grid_layout().unwrap());
    assert!((at.x - layout.cell_origin(0, 0).x - layout.metrics.cell_width * 0.5).abs() < px(0.5));
    assert!((layout.cell_origin(0, 0).x - layout.bounds.left() - px(8.)).abs() < px(0.5));
    // the shell's env
    run(
        &mut v,
        "echo \"[$TERM][$COLORTERM][$SHELL_SESSIONS_DISABLE][$NVIM_APPNAME]\"",
    );
    wait_screen(&mut v, "[xterm-256color][truecolor][1][nvim]");
    let cwd = v.lua("return vim.fn.getcwd()").as_str().unwrap().to_owned();
    run(&mut v, "echo \"[$PWD]\"");
    wait_screen(&mut v, &format!("[{cwd}]"));
    // Cmd+O: Go to File, Esc back to typing
    v.keystrokes("cmd-o");
    v.wait_until("Go to File", |v| picker_kind(v).as_deref() == Some("files"));
    v.keystrokes("escape");
    v.wait_until("picker closed", |v| picker_kind(v).is_none());
    wait_typing(&mut v);
}

#[test]
fn find_bar() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    needles(&mut v);
    v.keystrokes("cmd-f");
    v.wait_until("find bar with the keyboard", |v| {
        find_label(v).is_some() && target(v) == "terminal" && !typing(v)
    });
    // typing in the field (letters l / ö too)
    let field = read(&mut v, |t, cx| t.find_field(cx)).unwrap();
    assert_eq!(field.0, "");
    v.keystrokes("n e e d l e");
    wait_label(&mut v, "3/3");
    let hidden = !shows(&mut v, "needle one");
    // WS: Enter = Next Occurrence (down), wrapping from the newest to the oldest
    v.keystrokes("enter");
    wait_label(&mut v, "1/3");
    assert!(
        hidden && shows(&mut v, "needle one"),
        "wrapped to the oldest"
    );
    v.keystrokes("enter");
    wait_label(&mut v, "2/3");
    v.keystrokes("enter");
    wait_label(&mut v, "3/3");
    assert!(shows(&mut v, "x needle three"), "down to the newest");
    for (key, want) in [
        ("up", "2/3"),
        ("down", "3/3"),
        ("ctrl-l", "2/3"),
        ("ctrl-ö", "3/3"),
        ("cmd-g", "1/3"),
        ("shift-enter", "3/3"),
        ("cmd-shift-g", "2/3"),
        ("up", "1/3"),
    ] {
        v.keystrokes(key);
        wait_label(&mut v, want);
    }
    v.keystrokes("x y z");
    wait_label(&mut v, "No matches");
    // "No matches" in red: the count's color
    let c = read(&mut v, |t, _| t.find_label_color()).unwrap();
    assert!(c.r > 0.6 && c.r > c.g + 0.18, "red: {c:?}");
    for _ in 0..9 {
        v.keystrokes("backspace");
    }
    wait_label(&mut v, "");
    set_clipboard(&mut v, "row77");
    v.keystrokes("cmd-v");
    wait_label(&mut v, "1/1");
    for _ in 0..5 {
        v.keystrokes("backspace");
    }
    v.keystrokes("r o w 1");
    wait_label(&mut v, "11/11");
    let scrolled = read(&mut v, |t, _| t.display_offset()) > 0;
    v.keystrokes("escape");
    wait_typing(&mut v);
    assert!(scrolled && find_label(&mut v).is_none());
    assert_eq!(
        read(&mut v, |t, _| t.display_offset()),
        0,
        "back at the prompt"
    );
    assert!(shows(&mut v, "x needle three"));
    run(&mut v, "echo after''find");
    wait_line(&mut v, "afterfind");
    // Cmd+F again: the last text, selected; typing replaces it
    v.keystrokes("cmd-f");
    wait_label(&mut v, "11/11");
    let (text, sel) = read(&mut v, |t, cx| t.find_field(cx)).unwrap();
    assert_eq!((text.as_str(), sel), ("row1", 0..4));
    v.keystrokes("r o w 4 2");
    wait_label(&mut v, "1/1");
    // the ×
    let x = read(&mut v, |t, _| t.find_button("terminal-find-close")).expect("× drawn");
    mouse(&mut v, x.center(), MouseButton::Left, 1);
    v.wait_until("closed by ×", |v| find_label(v).is_none() && typing(v));
    // Cmd+2 leaves the field: closed
    v.keystrokes("cmd-f");
    v.wait_until("open", |v| find_label(v).is_some());
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until("closed by leaving", |v| find_label(v).is_none());
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    // right-click: the menu; Find… opens the bar
    let at = cell_of(&mut v, "afterfind", 2);
    mouse(&mut v, at, MouseButton::Right, 1);
    v.wait_until("menu", |v| {
        menu_rows(v).is_some_and(|r| {
            r.iter().any(|l| l.contains("New Tab")) && r.iter().any(|l| l.contains("Find…"))
        })
    });
    pick_menu(&mut v, "Find…");
    v.wait_until("menu Find… opened it", |v| find_label(v).is_some());
    v.keystrokes("escape");
    wait_typing(&mut v);
    // new output re-searches while it's open (coalesced)
    v.keystrokes("cmd-f");
    v.wait_until("open", |v| find_label(v).is_some());
    for _ in 0..6 {
        v.keystrokes("backspace");
    }
    v.keystrokes("a f t e r f i n d");
    wait_label(&mut v, "1/1");
    // the command runs in the shell; the bar stays open meanwhile (output while searching)
    read(&mut v, |t, _| t.pids());
    v.lua("require('config.app.terminal').send('echo after\\'\\'find\\r') return true");
    wait_screen(&mut v, "echo after''find");
    v.wait_until("output re-searched", |v| {
        v.advance(Duration::from_millis(200));
        find_label(v).as_deref() == Some("1/2") || find_label(v).as_deref() == Some("2/2")
    });
}

#[test]
fn scroll_view_keys() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(&mut v, "seq 1 200; echo seq''done");
    wait_line(&mut v, "seqdone");
    settle(&mut v);
    let rows = read(&mut v, |t, _| t.grid_layout().unwrap().rows);
    let half = rows / 2;
    let off = |v: &mut View| read(v, |t, _| t.display_offset());
    let sv = |v: &mut View| read(v, |t, _| t.in_scroll_view());
    // the keyboard way into the scroll view: Shift+PageUp (a page), Shift+PageDown back down
    v.keystrokes("shift-pageup");
    v.wait_until("scrolled a page", |v| off(v) == rows && sv(v));
    v.keystrokes("shift-pagedown");
    v.wait_until("back down", |v| off(v) == 0);
    assert!(sv(&mut v), "still the scroll view");
    v.keystrokes("down");
    assert_eq!(off(&mut v), 0, "↓ at the bottom stays");
    assert!(sv(&mut v));
    v.keystrokes("up");
    assert_eq!(off(&mut v), 1, "↑ a line");
    v.keystrokes("shift-up");
    assert_eq!(off(&mut v), 1 + half, "Shift+↑ half a page");
    v.keystrokes("shift-down");
    assert_eq!(off(&mut v), 1);
    v.keystrokes("down");
    assert_eq!(off(&mut v), 0);
    v.keystrokes("shift-down");
    assert_eq!(off(&mut v), 0);
    assert!(sv(&mut v), "Shift+↓ at the bottom: still the scroll view");
    // a wheel scroll (3 lines per notch), then ↑ a line
    let at = cell_of(&mut v, "seqdone", 0);
    v.cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Lines(point(0., 2.)),
        modifiers: NONE,
        touch_phase: TouchPhase::Moved,
    });
    let w = off(&mut v);
    assert_eq!(w, 6, "two wheel notches: 6 rows");
    v.keystrokes("up");
    assert_eq!(off(&mut v), w + 1);
    // typing goes back to the prompt; ↑ is the shell's history again
    type_text(&mut v, "echo hist''ory");
    v.keystrokes("enter");
    assert_eq!(off(&mut v), 0);
    wait_typing(&mut v);
    wait_line(&mut v, "history");
    v.keystrokes("up enter");
    v.wait_until("ran again", |v| {
        screen(v).iter().filter(|l| l.trim() == "history").count() == 2
    });
    // trackpad: sub-row offsets, back at the bottom leaves the scroll view
    v.cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Pixels(point(px(0.), px(45.))),
        modifiers: NONE,
        touch_phase: TouchPhase::Moved,
    });
    assert_eq!(off(&mut v), 2, "45 px = 2 rows of 18");
    assert!(sv(&mut v));
    v.cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Pixels(point(px(0.), px(-100.))),
        modifiers: NONE,
        touch_phase: TouchPhase::Ended,
    });
    assert_eq!(off(&mut v), 0);
    assert!(!sv(&mut v), "scrolled back to the bottom: typing");
}

#[test]
fn mouse_and_copy() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // scrollback to page through, whatever the column's height
    run(&mut v, "seq 1 120");
    wait_line(&mut v, "120");
    // a long line the terminal wraps onto 2+ rows, then END
    run(
        &mut v,
        "echo wo''rd-one wo''rd-two; printf 'W%.0s' $(seq 1 300); echo; echo E''ND",
    );
    wait_line(&mut v, "END");
    settle(&mut v);
    let at = cell_of(&mut v, "word-two", 2);
    mouse(&mut v, at, MouseButton::Left, 1);
    assert!(
        typing(&mut v) && selection(&mut v).is_none(),
        "a click: still typing"
    );
    let at = cell_of(&mut v, "word-one", 5);
    mouse(&mut v, at, MouseButton::Left, 1);
    mouse(&mut v, at, MouseButton::Left, 2);
    assert_eq!(selection(&mut v).as_deref(), Some("word-one"));
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), "word-one");
    assert!(typing(&mut v) && selection(&mut v).is_none());
    // triple-click: the line
    let at = cell_of(&mut v, "END", 1);
    mouse(&mut v, at, MouseButton::Left, 3);
    assert_eq!(selection(&mut v).as_deref(), Some("END"));
    v.keystrokes("escape");
    assert!(selection(&mut v).is_none() && typing(&mut v), "Esc clears");
    // drag from the wrapped line past END's end: one line, no trailing line break
    let from = cell_of(&mut v, "WWWW", 0);
    let end = cell_of(&mut v, "END", 0);
    let to = point(end.x + px(600.), end.y);
    drag(&mut v, from, to);
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), format!("{}\nEND", "W".repeat(300)));
    assert!(typing(&mut v));
    // Cmd+V after the copy: into the shell (bracketed by zsh)
    set_clipboard(&mut v, "echo pa''sted");
    v.keystrokes("cmd-v");
    v.keystrokes("enter");
    wait_line(&mut v, "pasted");
    assert!(typing(&mut v));
    run(&mut v, "echo to''k-one to''k-two");
    wait_line(&mut v, "tok-one tok-two");
    settle(&mut v);
    let drag_tok = |v: &mut View| {
        let a = cell_of(v, "tok-two", 0);
        let b = cell_of(v, "tok-two", 6);
        drag(v, a, b);
        assert_eq!(selection(v).as_deref(), Some("tok-two"));
    };
    // selected, not copied: Cmd+V goes to the shell
    drag_tok(&mut v);
    set_clipboard(&mut v, "echo vpa''ste");
    v.keystrokes("cmd-v");
    v.keystrokes("enter");
    wait_line(&mut v, "vpaste");
    assert!(typing(&mut v) && selection(&mut v).is_none());
    drag_tok(&mut v);
    v.keystrokes("escape");
    assert!(typing(&mut v) && selection(&mut v).is_none());
    // right-click on the selection, Copy
    set_clipboard(&mut v, "old");
    drag_tok(&mut v);
    let at = cell_of(&mut v, "tok-two", 2);
    mouse(&mut v, at, MouseButton::Right, 1);
    v.wait_until("menu", menu_open);
    pick_menu(&mut v, "Copy");
    v.wait_until("copied", |v| clipboard(v) == "tok-two");
    assert!(typing(&mut v));
    // the scroll view stays the scroll view on a click / copy; a page up and back down, so
    // tok-two stays on screen whatever scrollback the login shell's startup output left
    v.keystrokes("shift-pageup");
    v.keystrokes("shift-pagedown");
    v.wait_until("scroll view", |v| {
        read(v, |t, _| t.in_scroll_view() && t.display_offset() == 0)
    });
    let at = cell_of(&mut v, "tok-two", 2);
    mouse(&mut v, at, MouseButton::Left, 1);
    assert!(read(&mut v, |t, _| t.in_scroll_view()), "a click keeps it");
    set_clipboard(&mut v, "old");
    drag_tok(&mut v);
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), "tok-two");
    assert!(
        read(&mut v, |t, _| t.in_scroll_view()),
        "still the scroll view"
    );
    // middle click pastes (WS)
    set_clipboard(&mut v, "echo mi''ddle");
    let at = cell_of(&mut v, "tok-two", 2);
    mouse(&mut v, at, MouseButton::Middle, 1);
    v.keystrokes("enter");
    wait_line(&mut v, "middle");
    assert!(
        !read(&mut v, |t, _| t.in_scroll_view()),
        "pasting goes back to the prompt"
    );
}

#[test]
fn drags_from_elsewhere() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(&mut v, "echo to''k-one to''k-two");
    wait_line(&mut v, "tok-one tok-two");
    settle(&mut v);
    let drag_tok = |v: &mut View| {
        let a = cell_of(v, "tok-two", 0);
        let b = cell_of(v, "tok-two", 6);
        drag(v, a, b);
    };
    // from the editor
    v.focus_code();
    wait_target(&mut v, "split");
    drag_tok(&mut v);
    wait_target(&mut v, "terminal");
    assert_eq!(selection(&mut v).as_deref(), Some("tok-two"));
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), "tok-two");
    wait_typing(&mut v);
    // from its find field
    v.keystrokes("cmd-f");
    v.wait_until("find", |v| find_label(v).is_some());
    v.keystrokes("t o k");
    drag_tok(&mut v);
    assert_eq!(selection(&mut v).as_deref(), Some("tok-two"));
    assert!(find_label(&mut v).is_none(), "the find bar closed");
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), "tok-two");
    wait_typing(&mut v);
    // a click from the find field: typing in the shell
    v.keystrokes("cmd-f");
    v.wait_until("find", |v| find_label(v).is_some());
    let at = cell_of(&mut v, "tok-one", 1);
    mouse(&mut v, at, MouseButton::Left, 1);
    v.wait_until("typing", |v| typing(v) && find_label(v).is_none());
    // from the editor in Insert mode: the file isn't touched
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("i");
    v.wait_lua("insert", "return vim.api.nvim_get_mode().mode == 'i'");
    drag_tok(&mut v);
    wait_target(&mut v, "terminal");
    v.keystrokes("cmd-c");
    assert_eq!(clipboard(&mut v), "tok-two");
    wait_typing(&mut v);
    assert_eq!(
        v.lua("return vim.fn.getbufvar(vim.fn.bufnr('a.ts'), '&modified')")
            .as_i64(),
        Some(0)
    );
}

#[test]
fn tabs() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    needles(&mut v);
    // find searches the tab on screen
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| {
        tab_names(v) == "Local,Local (2)" && typing(v)
    });
    wait_prompt(&mut v);
    v.keystrokes("cmd-f");
    v.keystrokes("n e e d l e");
    wait_label(&mut v, "No matches");
    v.keystrokes("escape");
    wait_typing(&mut v);
    v.keystrokes("alt-cmd-left");
    v.wait_until("first tab", |v| selected(v) == "Local");
    v.keystrokes("cmd-f");
    wait_label(&mut v, "3/3");
    v.keystrokes("escape");
    wait_typing(&mut v);
    v.keystrokes("cmd-shift-t");
    v.wait_until("three", |v| {
        tab_names(v) == "Local,Local (2),Local (3)" && selected(v) == "Local (3)"
    });
    // the header: one selected box (WS)
    let sel = read(&mut v, |t, cx| t.header().read(cx).selected());
    assert_eq!(sel, 2);
    v.keystrokes("alt-cmd-right");
    v.wait_until("wrapped to the first", |v| {
        selected(v) == "Local" && typing(v)
    });
    v.keystrokes("alt-cmd-left");
    v.wait_until("wrapped to the last", |v| {
        selected(v) == "Local (3)" && typing(v)
    });
    let x = tab_pos(&mut v, 1, true);
    mouse(&mut v, x, MouseButton::Left, 1);
    v.wait_until("× closed Local (2)", |v| tab_names(v) == "Local,Local (3)");
    wait_typing(&mut v);
    v.keystrokes("cmd-shift-t");
    v.wait_until("lowest free name", |v| {
        tab_names(v) == "Local,Local (3),Local (2)"
    });
    let t = tab_pos(&mut v, 1, false);
    mouse(&mut v, t, MouseButton::Left, 1);
    v.wait_until("click switches", |v| {
        selected(v) == "Local (3)" && typing(v)
    });
    let t = tab_pos(&mut v, 0, false);
    mouse(&mut v, t, MouseButton::Middle, 1);
    v.wait_until("middle-click closed Local", |v| {
        tab_names(v) == "Local (3),Local (2)" && selected(v) == "Local (3)" && typing(v)
    });
    let plus = action_pos(&mut v, "new");
    mouse(&mut v, plus, MouseButton::Left, 1);
    v.wait_until("+ added Local", |v| {
        tab_names(v) == "Local (3),Local (2),Local" && selected(v) == "Local"
    });
    wait_prompt(&mut v);
    run(&mut v, "exit");
    v.wait_until("exit closed the tab", |v| {
        tab_names(v) == "Local (3),Local (2)" && typing(v)
    });
    wait_prompt(&mut v);
    v.keystrokes("ctrl-d");
    v.wait_until("Ctrl+D closed the tab", |v| {
        read(v, |t, _| t.tab_names().len()) == 1 && typing(v)
    });
    // Lua sees the tabs (session, busy count)
    let pids = read(&mut v, |t, _| t.pids());
    v.wait_lua(
        "Lua knows the tab",
        &format!("return vim.deep_equal(require('config.app.terminal').layout().tabs ~= nil, true) and {} > 0", pids[0]),
    );
    // the last tab's exit closes the tool window, the split gets the keyboard
    wait_prompt(&mut v);
    v.keystrokes("ctrl-d");
    v.wait_until("tool window gone", |v| !open_tool(v));
    wait_target(&mut v, "split");
}

#[test]
fn header_buttons_and_menu() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // (no ⌄ Terminal menu: ⋮ is the menu)
    let opts = action_pos(&mut v, "options");
    mouse(&mut v, opts, MouseButton::Left, 1);
    v.wait_until("⋮ menu", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains("New Tab")))
    });
    v.keystrokes("escape");
    v.wait_until("closed, typing", |v| !menu_open(v) && typing(v));
    // the header's empty space
    let blank = point(opts.x - px(200.), opts.y);
    mouse(&mut v, blank, MouseButton::Right, 1);
    v.wait_until("blank right-click menu", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains("New Tab")))
    });
    v.keystrokes("escape");
    v.wait_until("closed, typing", |v| !menu_open(v) && typing(v));
    mouse(&mut v, blank, MouseButton::Left, 1);
    assert!(typing(&mut v), "a click on the bar: still typing");
    // menu New Tab / Next Tab / Close Tab
    let shell = |v: &mut View| {
        let l = read(v, |t, _| t.grid_layout().unwrap());
        l.cell_origin(0, 12) + point(px(2.), px(4.))
    };
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    pick_menu(&mut v, "New Tab");
    v.wait_until("two tabs", |v| {
        read(v, |t, _| t.tab_names().len()) == 2 && typing(v)
    });
    let last = selected(&mut v);
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    pick_menu(&mut v, "Next Tab");
    v.wait_until("next tab", |v| selected(v) != last && typing(v));
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    pick_menu(&mut v, "Close Tab");
    v.wait_until("one tab", |v| {
        read(v, |t, _| t.tab_names().len()) == 1 && typing(v)
    });
    // a fresh tab: right-click below the shell's last line, again on the same cell after Esc,
    // two quick right-clicks: the menu each time, never a selection
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| {
        read(v, |t, _| t.tab_names().len()) == 2 && typing(v)
    });
    // its prompt first: a key typed while the login shell starts goes to whatever reads the tty
    // then (a ~/.zprofile tool's terminal query swallows the Ctrl+D below)
    wait_prompt(&mut v);
    let low = {
        let l = read(&mut v, |t, _| t.grid_layout().unwrap());
        l.cell_origin(l.rows - 1, 30) + point(px(2.), px(4.))
    };
    mouse(&mut v, low, MouseButton::Right, 1);
    v.wait_until("menu", menu_open);
    v.keystrokes("escape");
    v.wait_until("closed", |v| !menu_open(v));
    mouse(&mut v, low, MouseButton::Right, 2);
    v.wait_until("menu again", menu_open);
    v.keystrokes("escape");
    wait_typing(&mut v);
    mouse(&mut v, low, MouseButton::Right, 1);
    mouse(&mut v, low, MouseButton::Right, 2);
    v.wait_until("menu", menu_open);
    assert!(
        selection(&mut v).is_none(),
        "no selection from right-clicks"
    );
    v.keystrokes("escape");
    wait_typing(&mut v);
    v.keystrokes("ctrl-d");
    v.wait_until("one tab", |v| {
        read(v, |t, _| t.tab_names().len()) == 1 && typing(v)
    });
    // menu Hide
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    pick_menu(&mut v, "Hide");
    v.wait_until("hidden", |v| !open_tool(v));
    wait_target(&mut v, "split");
    // the header's Hide
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    let hide = action_pos(&mut v, "hide");
    mouse(&mut v, hide, MouseButton::Left, 1);
    v.wait_until("Hide hid it", |v| !open_tool(v));
    wait_target(&mut v, "split");
    // the shells stayed: Cmd+T shows the same tab again
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    assert_eq!(read(&mut v, |t, _| t.tab_names().len()), 1);
}

#[test]
fn the_terminal_and_git_share_the_bottom_pane_one_at_a_time() {
    let mut v = View::start("grepo", &["blame.ts"]);
    open(&mut v);
    let at = term_rect(&mut v).expect("the Terminal in the bottom pane");
    assert!(
        v.read(|e| e
            .geometry()
            .layout
            .frame
            .chat
            .is_none_or(|c| at.right() < c.left())),
        "never in the Chat column"
    );
    // Git takes the bottom at the Terminal's height, the shells keep running
    let pids = read(&mut v, |t, _| t.pids());
    crate::common::gitui::open_git(&mut v);
    v.wait_until("Git in the bottom pane, the Terminal hidden", |v| {
        !open_tool(v) && term_rect(v).is_none() && v.read(|e| e.geometry().layout.bottom.is_some())
    });
    let git = v.read(|e| e.geometry().layout.bottom.unwrap());
    assert!(
        (git.size.height - at.size.height).abs() < px(30.),
        "{git:?} vs {at:?}"
    );
    // ⌘T: the Terminal back in Git's place, the same shells
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    assert!(!v.read_ws(|ws, cx| ws.git().read(cx).is_open()));
    assert_eq!(read(&mut v, |t, _| t.pids()), pids);
}

#[test]
fn never_squeezed_resize_reflows() {
    let mut v = View::start("grepo", &["blame.ts"]);
    open(&mut v);
    // its island's full width (the tree opening / closing doesn't squeeze it)
    let full = |v: &mut View| {
        let Some(column) = term_rect(v) else {
            return false;
        };
        read(v, |t, _| t.view_bounds()).is_some_and(|b| {
            (b.left() - column.left()).abs() < px(2.) && (b.right() - column.right()).abs() < px(2.)
        })
    };
    v.wait_until("the island's width", full);
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.lua("require('config.tree').close() return true");
    v.wait_until("tree closed", |v| !v.read_ws(|ws, cx| ws.tree_open(cx)));
    v.wait_until("the keyboard left the tree", |v| target(v) != "tree");
    assert!(full(&mut v));
    v.keystrokes("cmd-1");
    v.wait_until("tree open", |v| v.read_ws(|ws, cx| ws.tree_open(cx)));
    assert!(full(&mut v), "tree open: the terminal keeps its island");
    // Lua knows the tree has the keyboard (else Cmd+T reads "the terminal is focused": hides it)
    wait_target(&mut v, "tree");
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    // a line longer than the narrow terminal: reflowed back to one row
    run(&mut v, "printf 'R%050d-RE''ND\\n' 0");
    wait_row(&mut v, "R...-REND", |l| {
        l.trim().starts_with('R') && l.trim().ends_with("-REND")
    });
    let (w0, h0) = (common::view::WINDOW.0, common::view::WINDOW.1);
    let wide = read(&mut v, |t, _| t.grid_size()).unwrap().0;
    v.cx.simulate_resize(size(px(w0 * 0.6), px(h0 * 0.8)));
    v.wait_until("narrower grid", |v| {
        read(v, |t, _| t.grid_size()).is_some_and(|(c, _)| c < wide)
    });
    wait_typing(&mut v);
    v.wait_until("resized: still the island's width", full);
    v.cx.simulate_resize(size(px(w0), px(h0)));
    v.wait_until("wide again", |v| {
        read(v, |t, _| t.grid_size()).is_some_and(|(c, _)| c == wide)
    });
    run(&mut v, "stty size");
    let (cols, rows) = read(&mut v, |t, _| t.grid_size()).unwrap();
    wait_line(&mut v, &format!("{rows} {cols}"));
    assert!(
        screen(&mut v)
            .iter()
            .any(|l| l.trim().starts_with('R') && l.trim().ends_with("-REND")),
        "reflowed to one row"
    );
}

#[test]
fn maximize() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua("vim.cmd('rightbelow vsplit') return true");
    open(&mut v);
    let before = splits(&v);
    let shell = |v: &mut View| {
        let l = read(v, |t, _| t.grid_layout().unwrap());
        l.cell_origin(0, 12) + point(px(2.), px(4.))
    };
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    pick_menu(&mut v, "Maximize Island");
    v.wait_until("maximized over the body", |v| covers(v) && typing(v));
    v.keystrokes("alt-cmd-enter");
    v.wait_until("restored", |v| !maximized(v) && typing(v));
    assert_eq!(splits(&v), before, "same splits, sizes, files");
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", |v| covers(v) && typing(v));
    // the status bar stays (the body only)
    let status = v.read(|e| e.geometry().layout.frame.status);
    let drawn = read(&mut v, |t, _| t.view_bounds()).unwrap();
    assert!(drawn.bottom() <= status.top());
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| read(v, |t, _| t.tab_names().len()) == 2);
    let new = selected(&mut v);
    v.keystrokes("alt-cmd-left");
    v.wait_until("still maximized", |v| {
        selected(v) != new && covers(v) && typing(v)
    });
    let at = shell(&mut v);
    mouse(&mut v, at, MouseButton::Right, 1);
    v.wait_until("menu offers Restore", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains("Restore")))
    });
    v.keystrokes("escape");
    v.wait_until("Esc: still maximized", |v| {
        !menu_open(v) && maximized(v) && covers(v)
    });
    v.cx.simulate_resize(size(px(800.), px(700.)));
    v.wait_until("resized: still covers", covers);
    v.cx.simulate_resize(size(px(common::view::WINDOW.0), px(common::view::WINDOW.1)));
    v.wait_until("covers", covers);
    // Find in Files over it: still maximized under the popup, typing again after Esc
    v.keystrokes("cmd-shift-f");
    v.wait_until("Find in Files", |v| {
        picker_kind(v).as_deref() == Some("grep")
    });
    assert!(maximized(&mut v));
    v.keystrokes("escape");
    v.wait_until("back typing, maximized", |v| covers(v) && typing(v));
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.wait_until("Cmd+1 restored", |v| !maximized(v));
    assert_eq!(splits(&v), before);
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", covers);
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until("Cmd+2 restored", |v| !maximized(v));
    assert_eq!(splits(&v), before);
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", covers);
    let hide = action_pos(&mut v, "hide");
    mouse(&mut v, hide, MouseButton::Left, 1);
    v.wait_until("Hide: restored and hidden", |v| {
        !open_tool(v) && !maximized(v)
    });
    wait_target(&mut v, "split");
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", covers);
    crate::common::gitui::open_git(&mut v);
    v.wait_until(
        "Git: restored, Git in the bottom in the Terminal's place",
        |v| !maximized(v) && !open_tool(v),
    );
    v.focus_code();
    wait_target(&mut v, "split");
    let ed = splits(&v);
    // ⌃⌘⏎ does nothing
    v.keystrokes("ctrl-cmd-enter");
    v.settle();
    assert!(!maximized(&mut v));
    assert_eq!(v.read_ws(|ws, cx| ws.maximized(cx)), None);
    assert_eq!(splits(&v), ed);
    assert_eq!(v.lua("return vim.bo.modified").as_bool(), Some(false));
    assert_eq!(target(&v), "split");
}

#[test]
fn session_layout_and_restore() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| read(v, |t, _| t.tab_names().len()) == 2);
    wait_prompt(&mut v);
    let src = v
        .lua("return vim.fn.getcwd() .. '/src'")
        .as_str()
        .unwrap()
        .to_owned();
    run(&mut v, "cd src && echo in''src");
    wait_line(&mut v, "insrc");
    v.wait_lua(
        "layout has both tabs in their folders, the second current",
        &format!(
            "local l = require('config.app.terminal').layout() return l ~= nil and #l.tabs == 2 \
             and l.tabs[1] == vim.fn.getcwd() and l.tabs[2] == '{src}' and l.cur == 2"
        ),
    );
    let l = v.lua("return require('config.app.terminal').layout()");
    // hide, close the tabs, restore from the saved layout: tabs reopen in their folders
    v.keystrokes("ctrl-d");
    v.wait_until("one tab", |v| read(v, |t, _| t.tab_names().len()) == 1);
    wait_prompt(&mut v);
    v.keystrokes("ctrl-d");
    v.wait_until("closed", |v| !open_tool(v));
    v.request(
        "nvim_exec_lua",
        vec![
            "require('config.app.terminal').restore(...)".into(),
            rmpv::Value::Array(vec![l]),
        ],
    );
    // (restored without the keyboard: the shells start, the pane stays hidden until asked for)
    v.wait_until("restored two tabs", |v| {
        read(v, |t, _| t.tab_names().len()) == 2
    });
    assert!(!open_tool(&mut v), "restored hidden");
    assert_eq!(selected(&mut v), "Local (2)");
    assert_eq!(target(&v), "split", "restored without the keyboard");
    v.lua("require('config.app.terminal').focus() return true");
    wait_typing(&mut v);
    wait_prompt(&mut v);
    run(&mut v, "echo \"[$PWD]\"");
    wait_screen(&mut v, &format!("[{src}]"));
    // the toolbar's switch check counts busy shells
    run(&mut v, "sleep 30");
    v.wait_lua(
        "a busy shell counts as a job",
        "return require('config.app.toolbar').switch_check().jobs == 1",
    );
    v.keystrokes("ctrl-c");
}

#[test]
fn tui_mouse_reporting_and_alt_screen() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // an app asking for SGR mouse reports (1000 + 1006) that echoes what it gets
    run(&mut v, "printf '\\e[?1000h\\e[?1006h'; cat -v");
    settle(&mut v);
    let rows = read(&mut v, |t, _| t.grid_layout().unwrap().rows);
    let l = read(&mut v, |t, _| t.grid_layout().unwrap());
    let at = l.cell_origin(rows - 2, 4) + point(px(2.), px(4.));
    mouse(&mut v, at, MouseButton::Left, 1);
    let want = format!("^[[<0;5;{}M^[[<0;5;{}m", rows - 1, rows - 1);
    v.keystrokes("enter");
    wait_screen(&mut v, &want);
    assert!(selection(&mut v).is_none(), "reported, not selected");
    // the wheel goes to the app too
    v.cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Lines(point(0., 1.)),
        modifiers: NONE,
        touch_phase: TouchPhase::Moved,
    });
    v.keystrokes("enter");
    wait_screen(&mut v, "^[[<64;5;");
    assert_eq!(read(&mut v, |t, _| t.display_offset()), 0);
    // Shift bypasses: a selection
    let a = l.cell_origin(0, 0) + point(px(1.), px(4.));
    let b = l.cell_origin(0, 6) + point(px(1.), px(4.));
    v.cx.simulate_mouse_down(a, MouseButton::Left, common::gitui::SHIFT);
    v.cx.simulate_mouse_move(b, MouseButton::Left, common::gitui::SHIFT);
    v.cx.simulate_event(gpui_kit::MouseUpEvent {
        position: b,
        modifiers: common::gitui::SHIFT,
        button: MouseButton::Left,
        click_count: 1,
    });
    assert!(selection(&mut v).is_some());
    v.keystrokes("ctrl-c");
    run(&mut v, "printf '\\e[?1000l\\e[?1006l'; clear");
    // the alternate screen: the wheel is arrow keys for the app (less)
    run(&mut v, "seq 1 500 | less");
    v.wait_until("less in the alt screen", |v| read(v, |t, _| t.alt_screen()));
    wait_line(&mut v, "1");
    v.cx.simulate_event(ScrollWheelEvent {
        position: at,
        delta: ScrollDelta::Lines(point(0., -2.)),
        modifiers: NONE,
        touch_phase: TouchPhase::Moved,
    });
    v.wait_until("less scrolled 6 lines", |v| {
        screen(v).first().is_some_and(|l| l.trim() == "7")
    });
    v.keystrokes("q");
    v.wait_until("back from less", |v| !read(v, |t, _| t.alt_screen()));
}

#[test]
fn keys_reach_the_shell_and_globals_reach_nvim() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // the bytes keys send: od shows them
    run(&mut v, "od -c");
    settle(&mut v);
    v.keystrokes("ctrl-a ctrl-e alt-left alt-right up shift-right f5 tab");
    v.keystrokes("enter ctrl-d");
    // od's rows: offset, then the bytes
    let want = "001 005 033 b 033 f 033 [ A 033 [ 1 ; 2 C 033 [ 1 5 ~ \\t \\n";
    v.wait_until("od shows the bytes", |v| {
        let bytes: Vec<String> = screen(v)
            .iter()
            .filter(|l| l.starts_with("00000"))
            .flat_map(|l| {
                l.split_whitespace()
                    .skip(1)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .collect();
        bytes.join(" ").contains(want)
    });
    // Cmd+Left / Cmd+Right / Cmd+Backspace: the macOS text keys (Ghostty's bytes)
    type_text(&mut v, "echo abc");
    v.keystrokes("cmd-left");
    type_text(&mut v, "X");
    v.keystrokes("cmd-right cmd-backspace");
    type_text(&mut v, "echo ki''lled");
    v.keystrokes("enter");
    wait_line(&mut v, "killed");
    // Ctrl+C interrupts
    run(&mut v, "sleep 30");
    // once sleep runs: a ^C while the shell is still starting it goes to the shell (ignored)
    let shell = read(&mut v, |t, _| t.pids()[t.current()]);
    v.wait_until("sleep running", |_| {
        std::process::Command::new("pgrep")
            .args(["-P", &shell.to_string(), "-x", "sleep"])
            .output()
            .is_ok_and(|o| o.status.success())
    });
    v.keystrokes("ctrl-c");
    run(&mut v, "echo after''sleep");
    wait_line(&mut v, "aftersleep");
    // global Cmd keys still reach nvim: Cmd+1 (tree) / Cmd+T
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    // ⌘T with the keyboard: hidden, the keys back to the editor; again: the same shells
    let n = read(&mut v, |t, _| t.tab_names().len());
    v.keystrokes("cmd-t");
    v.wait_until("Cmd+T hid it", |v| !open_tool(v));
    wait_target(&mut v, "split");
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    assert_eq!(read(&mut v, |t, _| t.tab_names().len()), n);
    let hide = action_pos(&mut v, "hide");
    mouse(&mut v, hide, MouseButton::Left, 1);
    v.wait_until("Hide hid it", |v| !open_tool(v));
    wait_target(&mut v, "split");
    // editor-only Cmd keys type nothing into the shell (and don't touch nvim)
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    v.keystrokes("cmd-z cmd-d cmd-b");
    type_text(&mut v, "echo still''here");
    v.keystrokes("enter");
    wait_line(&mut v, "stillhere");
    // a click on the editor's text gives the keyboard back to the split
    let (row, col) = v.cell_of("export");
    let at = v.cell_pos(row, col + 1);
    v.click(MouseButton::Left, at);
    wait_target(&mut v, "split");
}

#[test]
fn ime_dead_keys_and_option_chars() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    let t = term(&mut v);
    let bounds = read(&mut v, |t, _| t.grid_layout().unwrap().bounds);
    type_text(&mut v, "echo ü");
    v.keystrokes("backspace");
    // a dead key: marked ¨, then the composed ü committed
    v.cx.update(|window, cx| {
        let mut h = ElementInputHandler::new(bounds, t.clone());
        h.replace_and_mark_text_in_range(None, "¨", Some(1..1), window, cx);
    });
    v.pump();
    assert!(!shows(&mut v, "¨"), "the preedit isn't sent to the shell");
    v.cx.update(|window, cx| {
        let mut h = ElementInputHandler::new(bounds, t.clone());
        h.replace_text_in_range(None, "ü", window, cx);
    });
    // Option chars (Swedish @ | { }) are text
    type_text(&mut v, "'@|{}'");
    v.keystrokes("enter");
    wait_line(&mut v, "ü@|{}");
}

#[test]
fn lazygit_float() {
    if std::process::Command::new("which")
        .arg("lazygit")
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true)
    {
        eprintln!("lazygit not installed: skipped");
        return;
    }
    let mut v = View::start("grepo", &["blame.ts"]);
    v.keystrokes(", shift-g");
    v.wait_until("the float is up", |v| read(v, |t, _| t.float_open()));
    wait_target(&mut v, "popup");
    v.wait_until("lazygit drew", |v| {
        read(v, |t, _| t.float_screen())
            .iter()
            .any(|l| l.contains("Status") || l.contains("Files"))
    });
    // its frame: 90 % of the body, centered
    let body = v.read(|e| e.geometry().maximized_rect());
    let t = term(&mut v);
    let drawn = v.cx.update(|window, cx| t.read(cx).float_bounds(window));
    assert!((drawn.size.width - body.size.width * 0.9).abs() < px(2.));
    assert!((drawn.center().x - body.center().x).abs() < px(2.));
    // keys go to lazygit (Esc too); q quits it and the float closes
    v.keystrokes("escape");
    assert!(read(&mut v, |t, _| t.float_open()));
    // (a key right after Esc would be Alt+key to lazygit)
    let at = Instant::now();
    v.wait_until("a moment after Esc", |_| {
        at.elapsed() > Duration::from_millis(100)
    });
    v.keystrokes("q");
    v.wait_until("lazygit exited: float closed", |v| {
        !read(v, |t, _| t.float_open())
    });
    wait_target(&mut v, "split");
}

/// Runs `cmd` and drives the UI like the app's frame loop until `done` shows: each turn runs
/// the UI tasks that are ready (PTY batches) and draws a frame. The worst turn must stay well
/// under what a user notices (no freeze); prints frames and timings.
fn flood(v: &mut View, cmd: &str, done: &str, label: &str) {
    let t = term(v);
    let bounds = t.read_with(&v.cx, |t, _| t.grid_layout().unwrap().bounds);
    let enter = gpui_kit::Keystroke::parse("enter").unwrap();
    v.cx.update(|window, cx| {
        let mut h = ElementInputHandler::new(bounds, t.clone());
        h.replace_text_in_range(None, cmd, window, cx);
        window.dispatch_keystroke(enter, cx);
    });
    let t0 = Instant::now();
    let (mut frames, mut worst) = (0, Duration::ZERO);
    loop {
        let f0 = Instant::now();
        // the tasks ready within a frame's time (the PTY batches keep coming: macOS interleaves
        // the frame callback with them the same way)
        while f0.elapsed() < Duration::from_millis(8) && v.cx.executor().tick() {}
        v.cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        worst = worst.max(f0.elapsed());
        frames += 1;
        if t.read_with(&v.cx, |t, _| t.screen())
            .iter()
            .any(|l| l.trim() == done)
        {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "{label} never finished"
        );
    }
    let total = t0.elapsed();
    eprintln!(
        "[perf] {label}: {total:?}, {frames} UI frames ({:.0}/s), worst UI turn {worst:?}",
        frames as f64 / total.as_secs_f64()
    );
    assert!(frames > 10, "frames kept coming: {frames}");
    assert!(
        worst < Duration::from_millis(150),
        "the UI never froze: worst {worst:?}"
    );
    v.pump();
}

#[test]
fn perf_key_to_echo_and_floods() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // key -> echo in the grid: dispatch to the PTY, the tty echoes (cat: the kernel's echo, no
    // shell line editor in between), parsed off the UI thread, drawn
    run(&mut v, "cat");
    settle(&mut v);
    let t = term(&mut v);
    let mut parsed = Vec::new();
    let mut total = Vec::new();
    for ch in ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] {
        let before = t.read_with(&v.cx, |t, _| t.screen());
        let bounds = t.read_with(&v.cx, |t, _| t.grid_layout().unwrap().bounds);
        let t0 = Instant::now();
        // the IME's commit, as type_text, without running the UI loop
        v.cx.update(|window, cx| {
            let mut h = ElementInputHandler::new(bounds, t.clone());
            h.replace_text_in_range(None, ch, window, cx);
        });
        // parsed off the UI thread into the Term (no UI frame in between)
        while t.read_with(&v.cx, |t, _| t.screen()) == before {
            assert!(t0.elapsed() < Duration::from_secs(2), "no echo");
            std::thread::yield_now();
        }
        parsed.push(t0.elapsed());
        // the UI takes the wakeup and draws the frame showing it
        v.cx.update(|window, _| window.refresh());
        v.pump();
        total.push(t0.elapsed());
    }
    parsed.sort();
    total.sort();
    let (p, d) = (parsed[parsed.len() / 2], total[total.len() / 2]);
    eprintln!(
        "[perf] key -> echo parsed: median {p:?}; -> frame drawn: median {d:?} (test window, whole workspace)"
    );
    // (debug test windows draw the whole workspace in an update; the release run is the measure)
    assert!(p < Duration::from_millis(50), "echo parsed: {p:?}");
    #[cfg(not(debug_assertions))]
    assert!(
        d < Duration::from_micros(8333),
        "under a 120 Hz frame: {d:?}"
    );
    v.keystrokes("ctrl-c");
    settle(&mut v);
    // a flood: the UI keeps drawing frames while 2 M lines stream in (one UI turn = the PTY
    // batches that are ready + a frame; never all of it at once)
    flood(
        &mut v,
        "yes | head -2000000; echo flo''od done",
        "flood done",
        "yes | head -2000000",
    );
    // a 50 MB file through cat
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("big.txt");
    {
        use std::io::Write as _;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&file).unwrap());
        let line = "0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 \x1b[32mgreen\x1b[0m\n";
        let mut n = 0;
        while n < 50 * 1024 * 1024 {
            f.write_all(line.as_bytes()).unwrap();
            n += line.len();
        }
    }
    flood(
        &mut v,
        &format!("cat {}; echo c''at done", file.display()),
        "cat done",
        "cat 50 MB",
    );
    // a full screen's build cost (prepaint: snapshot + color runs + shaping), maximized in a big
    // window: about 200 x 60 cells, every row in another color
    v.cx.simulate_resize(size(px(1700.), px(1320.)));
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", maximized);
    v.wait_until("big grid", |v| {
        read(v, |t, _| t.grid_size()).is_some_and(|(c, r)| c >= 200 && r >= 60)
    });
    run(
        &mut v,
        "clear; for i in $(seq 1 70); do printf '\\e[3%dm%s\\e[1m%s\\e[0m\\n' $((i % 8)) \"$(printf 'x%.0s' $(seq 1 100))\" \"$(printf 'y%.0s' $(seq 1 100))\"; done",
    );
    settle(&mut v);
    let mut builds = Vec::new();
    for _ in 0..20 {
        v.cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        if let Some(b) = read(&mut v, |t, _| t.last_build()) {
            builds.push(b);
        }
    }
    builds.sort();
    let (cols, rows) = read(&mut v, |t, _| t.grid_size()).unwrap();
    eprintln!(
        "[perf] full-screen grid build ({cols}x{rows}): median {:?}, max {:?}",
        builds[builds.len() / 2],
        builds.last().unwrap()
    );
}

#[test]
fn lua_new_tabs_in_a_row() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    v.lua("local T = require('config.app.terminal') T.new() T.new() return true");
    v.wait_until("three tabs", |v| read(v, |t, _| t.tab_names().len()) == 3);
}

// Fix round (M4_GAPS_TERMINAL) ---------------------------------------------------------------

/// The process exists (a zombie counts: it wasn't reaped).
fn alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Processes whose command line matches `pattern` (pgrep -f).
fn pgrep(pattern: &str) -> Vec<String> {
    std::process::Command::new("pgrep")
        .args(["-f", pattern])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// PTY masters this test process holds.
fn ptmx_fds() -> usize {
    std::process::Command::new("lsof")
        .args(["-p", &std::process::id().to_string()])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.contains("ptmx"))
                .count()
        })
        .unwrap_or(0)
}

fn wait_gone(v: &mut View, label: &str, pred: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !pred() {
        assert!(Instant::now() < deadline, "timed out: {label}");
        v.wait_until("a moment", |_| true);
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn closing_busy_tabs_reaps_the_shell_and_its_job() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    let fds = ptmx_fds();
    // a foreground job: closing the tab (,w / the tab's ×; Cmd+Q is the app's Close Project) ends
    // the shell and the job, reaped
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| read(v, |t, _| t.tab_names().len()) == 2);
    wait_prompt(&mut v);
    let pid = read(&mut v, |t, _| t.pids()[1]);
    run(&mut v, "sleep 301");
    wait_gone(&mut v, "sleep 301 runs", || !pgrep("sleep 301").is_empty());
    v.lua("require('config.focus').close() return true");
    v.wait_until("one tab", |v| read(v, |t, _| t.tab_names().len()) == 1);
    wait_gone(&mut v, "the shell reaped", || !alive(pid));
    wait_gone(&mut v, "the job gone", || pgrep("sleep 301").is_empty());
    // a background job (zsh writes its history and hangs up its jobs on the way out)
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| read(v, |t, _| t.tab_names().len()) == 2);
    wait_prompt(&mut v);
    let pid = read(&mut v, |t, _| t.pids()[1]);
    run(&mut v, "sleep 302 &");
    wait_gone(&mut v, "sleep 302 runs", || !pgrep("sleep 302").is_empty());
    let x = tab_pos(&mut v, 1, true);
    mouse(&mut v, x, MouseButton::Left, 1);
    v.wait_until("one tab", |v| read(v, |t, _| t.tab_names().len()) == 1);
    wait_gone(&mut v, "the shell reaped", || !alive(pid));
    wait_gone(&mut v, "the job gone", || pgrep("sleep 302").is_empty());
    wait_gone(&mut v, "no PTY master left", || ptmx_fds() <= fds);
    // the remaining tab still works
    run(&mut v, "echo st''ill");
    wait_line(&mut v, "still");
}

#[test]
fn shells_dont_inherit_the_apps_files() {
    // a file the app holds without close-on-exec (like Metal's shader cache)
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app-private.cache");
    let file = std::fs::File::create(&path).unwrap();
    {
        use std::os::fd::AsRawFd as _;
        let fd = file.as_raw_fd();
        // SAFETY: flags of a descriptor this test owns
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
        }
    }
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    let pid = read(&mut v, |t, _| t.pids()[0]);
    let out = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string()])
        .output()
        .unwrap();
    let files = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(!files.contains("app-private.cache"), "inherited:\n{files}");
    drop(file);
}

#[test]
fn kitty_keyboard_protocol_for_tuis_that_ask() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // an app pushes "disambiguate" (CSI > 1 u): Shift+Enter is CSI 13;2u, Enter stays CR
    run(
        &mut v,
        "printf '\\e[>1u'; head -c 8 | od -c; printf '\\e[<u'",
    );
    settle(&mut v);
    v.keystrokes("shift-enter enter");
    wait_term(&mut v, "od shows CSI 13;2u", |screen| {
        let bytes: Vec<String> = screen
            .iter()
            .filter(|l| l.starts_with("00000"))
            .flat_map(|l| {
                l.split_whitespace()
                    .skip(1)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .collect();
        bytes.join(" ").contains("033 [ 1 3 ; 2 u \\n")
    });
    // popped: Shift+Enter is a plain CR again (the prompt runs nothing)
    settle(&mut v);
    type_text(&mut v, "echo pl''ain");
    v.keystrokes("shift-enter");
    wait_line(&mut v, "plain");
}

#[test]
fn drag_selection_scrolls_past_the_edges_and_releases_outside_reach_tuis() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(&mut v, "seq 1 300; echo seq''done");
    wait_line(&mut v, "seqdone");
    settle(&mut v);
    let l = read(&mut v, |t, _| t.grid_layout().unwrap());
    let from = cell_of(&mut v, "seqdone", 3);
    let above = point(from.x, l.bounds.top() - px(30.));
    v.cx.simulate_mouse_down(from, MouseButton::Left, NONE);
    v.cx.simulate_mouse_move(point(from.x, from.y - px(20.)), MouseButton::Left, NONE);
    for _ in 0..10 {
        // past the top edge (over the header / editor): the view scrolls back
        v.cx.simulate_mouse_move(above, MouseButton::Left, NONE);
    }
    v.cx.simulate_event(gpui_kit::MouseUpEvent {
        position: above,
        modifiers: NONE,
        button: MouseButton::Left,
        click_count: 1,
    });
    let off = read(&mut v, |t, _| t.display_offset());
    assert!(off >= 10, "auto-scrolled into the scrollback: {off}");
    let sel = selection(&mut v).unwrap_or_default();
    assert!(
        sel.lines().count() > l.rows + 5,
        "selection grew past the edge: {sel:?}"
    );
    v.keystrokes("escape");
    v.keystrokes("i");
    wait_typing(&mut v);
    // a TUI: the right button's release outside the body is reported too
    run(&mut v, "printf '\\e[?1000h\\e[?1006h'; cat -v");
    settle(&mut v);
    let at = l.cell_origin(l.rows - 2, 4) + point(px(2.), px(4.));
    v.cx.simulate_mouse_down(at, MouseButton::Right, NONE);
    v.cx.simulate_event(gpui_kit::MouseUpEvent {
        position: above,
        modifiers: NONE,
        button: MouseButton::Right,
        click_count: 1,
    });
    v.keystrokes("enter");
    wait_screen(&mut v, &format!("^[[<2;5;{}M^[[<2;", l.rows - 1));
    assert!(
        screen(&mut v)
            .iter()
            .any(|r| r.contains("^[[<2;") && r.ends_with('m')),
        "release reported"
    );
    v.keystrokes("ctrl-c");
}

#[test]
fn trackpad_wheel_adds_up_in_tuis() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(&mut v, "seq 1 500 | less");
    v.wait_until("less", |v| read(v, |t, _| t.alt_screen()));
    wait_line(&mut v, "1");
    let at = cell_of(&mut v, "1", 0);
    // slow trackpad events of 6 px: three make an 18 px row = one arrow for less
    for _ in 0..6 {
        v.cx.simulate_event(ScrollWheelEvent {
            position: at,
            delta: ScrollDelta::Pixels(point(px(0.), px(-6.))),
            modifiers: NONE,
            touch_phase: TouchPhase::Moved,
        });
    }
    v.wait_until("less scrolled 2 lines", |v| {
        screen(v).first().is_some_and(|l| l.trim() == "3")
    });
    v.keystrokes("q");
}

#[test]
fn scroll_view_ctrl_bslash_ctrl_n_and_i_esc() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(&mut v, "seq 1 100");
    wait_line(&mut v, "100");
    settle(&mut v);
    let last = |v: &mut View| {
        screen(v)
            .into_iter()
            .rfind(|l| !l.trim().is_empty())
            .unwrap()
    };
    let prompt = last(&mut v);
    // Ctrl+\ Ctrl+N: the scroll view (nvim's terminal escape); ↑ scrolls
    v.keystrokes("ctrl-\\ ctrl-n");
    assert!(read(&mut v, |t, _| t.in_scroll_view()));
    v.keystrokes("up");
    assert_eq!(read(&mut v, |t, _| t.display_offset()), 1);
    // `i`: back to typing, nothing typed
    v.keystrokes("i");
    wait_typing(&mut v);
    assert_eq!(read(&mut v, |t, _| t.display_offset()), 0);
    settle(&mut v);
    assert_eq!(last(&mut v), prompt, "`i` typed nothing");
    // Esc: the same
    v.keystrokes("shift-pageup");
    v.wait_until("scroll view", |v| read(v, |t, _| t.in_scroll_view()));
    v.keystrokes("escape");
    wait_typing(&mut v);
    // a lone Ctrl+\ still reaches the shell (after the wait for a Ctrl+N)
    run(&mut v, "stty -isig -icanon; head -c 1 | od -c; stty sane");
    settle(&mut v);
    v.keystrokes("ctrl-\\");
    v.advance(Duration::from_millis(1100));
    wait_term(&mut v, "od got 034", |screen| {
        screen.iter().any(|l| l.contains("0000000  034"))
    });
}

#[test]
fn lazygit_edit_quits_it_and_opens_the_file() {
    if std::process::Command::new("which")
        .arg("lazygit")
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true)
    {
        eprintln!("lazygit not installed: skipped");
        return;
    }
    let mut v = View::start("grepo", &["blame.ts"]);
    v.keystrokes(", shift-g");
    v.wait_until("the float is up", |v| read(v, |t, _| t.float_open()));
    v.wait_until("lazygit drew", |v| {
        read(v, |t, _| t.float_screen())
            .iter()
            .any(|l| l.contains("Status"))
    });
    // what lazygit's nvim-remote edit runs (snacks' preset): q to the editor, then the file
    let server = v
        .lua("return vim.v.servername")
        .as_str()
        .unwrap()
        .to_owned();
    let file = v
        .lua("return vim.fn.getcwd() .. '/diff.ts'")
        .as_str()
        .unwrap()
        .to_owned();
    let st = std::process::Command::new("nvim")
        .args(["--server", &server, "--remote-send", "q"])
        .status()
        .unwrap();
    assert!(st.success());
    v.wait_until("lazygit quit: float closed", |v| {
        !read(v, |t, _| t.float_open())
    });
    assert_eq!(
        v.lua("return vim.fn.reg_recording()").as_str(),
        Some(""),
        "no macro recording"
    );
    assert_eq!(v.mode(), "n");
    let st = std::process::Command::new("nvim")
        .args(["--server", &server, "--remote-tab", &file])
        .status()
        .unwrap();
    assert!(st.success());
    v.wait_lua(
        "the file opened",
        "return vim.fn.expand('%:t') == 'diff.ts'",
    );
    // q is nvim's again
    v.keystrokes("q a");
    v.wait_lua(
        "q records a macro again",
        "return vim.fn.reg_recording() == 'a'",
    );
    v.keystrokes("q");
}

#[test]
fn closing_a_project_closes_its_shells_after_the_session_is_saved() {
    let proj = common::fixtures().join("proj");
    let other = common::fixtures().join("grepo");
    let mut v = View::start_projects(proj.to_str().unwrap(), &["a.ts"]);
    let ws_proj = v.active_project();
    open(&mut v);
    v.keystrokes("cmd-shift-t");
    v.wait_until("two tabs", |v| read(v, |t, _| t.tab_names().len()) == 2);
    wait_prompt(&mut v);
    run(&mut v, "cd src && echo in''src");
    wait_line(&mut v, "insrc");
    let pids = read(&mut v, |t, _| t.pids());
    // (nvim's own path: the fixtures may sit behind a symlink)
    let cwd = v.lua("return vim.fn.getcwd()").as_str().unwrap().to_owned();
    let state = v.lua("return vim.fn.stdpath('state')");
    let state = std::path::PathBuf::from(state.as_str().unwrap());
    // another project shown: the shells keep running (switching never asks)
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        other.display()
    ));
    v.wait_until("other shown", |v| v.active_project() != ws_proj);
    v.settle();
    assert!(!menu_open(&mut v), "switching asked");
    assert!(pids.iter().all(|p| alive(*p)), "shells kept");
    // back, then Close Project: the session saved with the tabs' folders, then the shells go
    let back = proj.clone();
    v.cx.update(|window, cx| vimstorm::shell::projects::switch_to(back, window, cx));
    v.wait_until("proj shown", |v| v.active_project() == ws_proj);
    v.use_project(&ws_proj);
    v.lua("require('config.app.toolbar').close_project() return true");
    // (a prompt's async helpers count as running jobs: the question, answered yes)
    v.wait_until("closed or asked", |v| {
        v.active_project() != ws_proj || dialog_open(v)
    });
    if v.active_project() == ws_proj {
        // the Close project dialog (P-17): ⏎ cancels, `y` closes
        v.keystrokes("y");
    }
    v.wait_until("closed", |v| v.active_project() != ws_proj);
    let session = state
        .join("open-files")
        .join(format!("{cwd}.json").replace('/', "%"));
    wait_gone(&mut v, "old shells closed", || {
        pids.iter().all(|p| !alive(*p))
    });
    let saved = std::fs::read_to_string(&session).unwrap();
    assert!(
        saved.contains(&format!("{cwd}/src")),
        "the second tab's folder saved: {saved}"
    );
}

#[test]
fn osc_titles_name_tabs_bells_beep_and_hidden_output_doesnt_redraw() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    // OSC 2 names the tab (WS updateTabNameOnTitleChange); `read` keeps the prompt from
    // setting another title meanwhile
    run(&mut v, "printf '\\033]2;hello\\007'; read x");
    v.wait_until("titled", |v| tab_names(v) == "hello");
    v.keystrokes("enter");
    wait_prompt(&mut v);
    // long titles cut in the middle; an empty one gives the default name back
    run(
        &mut v,
        "printf '\\033]0;%s\\007' $(printf 'a%.0s' {1..40})b; read x",
    );
    v.wait_until("trimmed", |v| {
        let n = tab_names(v);
        n.chars().count() == 30 && n.contains('…') && n.ends_with('b')
    });
    v.keystrokes("enter");
    wait_prompt(&mut v);
    run(&mut v, "printf '\\033]2;\\007'");
    v.wait_until("default name", |v| tab_names(v) == "Local");
    // BEL: one beep per burst
    run(&mut v, "printf '\\007\\007\\007'; echo rang");
    wait_line(&mut v, "rang");
    v.wait_until("one beep", |v| read(v, |t, _| t.bells()) == 1);
    // hidden: output doesn't redraw anything; shown again it's there
    let hide = action_pos(&mut v, "hide");
    mouse(&mut v, hide, MouseButton::Left, 1);
    v.wait_until("hidden", |v| !open_tool(v));
    let before = read(&mut v, |t, _| t.output_redraws());
    v.lua("require('config.app.terminal').send(\"echo hidden''out\\r\") return true");
    v.wait_until("output while hidden", |v| {
        read(v, |t, _| t.screen())
            .iter()
            .any(|l| l.trim() == "hiddenout")
    });
    assert_eq!(read(&mut v, |t, _| t.output_redraws()), before);
    // shown again: output redraws
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    wait_prompt(&mut v);
    run(&mut v, "echo shown''again");
    wait_line(&mut v, "shownagain");
    assert!(read(&mut v, |t, _| t.output_redraws()) > before);
}

/// The shell, its output and scrollback survive every way the view is unmounted and mounted again
/// (WS / the Lua :terminal): Hide + Cmd+T show, Git taking the bottom and back,
/// maximize + restore, a session restore reopening the host window. (A project switch away and
/// back: projects.rs switching_away_and_back_keeps_the_project_running.)
#[test]
fn output_and_scrollback_survive_hide_show_git_maximize_and_restore() {
    let mut v = View::start("proj", &["a.ts"]);
    open(&mut v);
    run(
        &mut v,
        "for i in $(seq 1 40); do echo back''$i; done; echo mark''one",
    );
    wait_line(&mut v, "markone");
    let pid = read(&mut v, |t, _| t.pids());
    let kept = |v: &mut View, how: &str| {
        let lines = all_lines(v);
        assert!(
            lines.iter().any(|l| l.trim() == "markone")
                && lines.iter().any(|l| l.trim() == "back1"),
            "{how}: output + scrollback kept: {lines:?}"
        );
        assert_eq!(read(v, |t, _| t.pids()), pid, "{how}: same shell");
    };
    // Hide, then Cmd+T shows it
    v.lua("require('config.app.terminal').hide() return true");
    v.wait_until("hidden", |v| !open_tool(v));
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    settle(&mut v);
    kept(&mut v, "hide / Cmd+T show");
    // Git takes the bottom pane, and back
    v.lua("require('config.app.git').open() return true");
    v.wait_until("Git in the bottom", |v| {
        !open_tool(v) && v.read(|e| e.geometry().layout.bottom.is_some())
    });
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    settle(&mut v);
    kept(&mut v, "Git and back");
    // maximize + restore
    v.keystrokes("alt-cmd-enter");
    v.wait_until("maximized", maximized);
    settle(&mut v);
    kept(&mut v, "maximized");
    v.keystrokes("alt-cmd-enter");
    v.wait_until("restored", |v| !maximized(v));
    settle(&mut v);
    kept(&mut v, "restored");
    // hidden, then a session restore while its shells run: no new tab, the same shells
    v.lua("require('config.app.terminal').hide() return true");
    v.wait_until("hidden", |v| !open_tool(v));
    v.lua("require('config.app.terminal').restore({ tabs = { vim.fn.getcwd() }, cur = 1 }) return true");
    v.settle();
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    settle(&mut v);
    kept(&mut v, "session restore");
    assert_eq!(read(&mut v, |t, _| t.tab_names().len()), 1);
}

/// nvim busy for a while from now (a scheduled sleep): keys typed meanwhile sit in its typeahead,
/// which it reads before the app's queued notifications.
fn busy(v: &mut View, ms: u32) {
    v.lua(&format!(
        "vim.schedule(function() vim.uv.sleep({ms}) end) return true"
    ));
}

fn terminal_open(v: &mut View) -> bool {
    v.lua("return require('config.app.terminal').is_open()")
        .as_bool()
        == Some(true)
}

/// A focus change and the Cmd key right after it while nvim is busy: the key waits until Lua has
/// the new focus, so Cmd+T acts on the tree (focus the terminal), not on the terminal it left
/// (hide). The focus changes: one Lua makes (Cmd+1) and one the app makes (a click on a tree row).
#[test]
#[cfg_attr(not(debug_assertions), ignore)] // tree rows found by debug selector
fn a_cmd_key_right_after_a_focus_change_while_nvim_is_busy_acts_where_the_focus_went() {
    type Step = fn(&mut View);
    const ROWS: &[(&str, Step)] = &[
        ("Cmd+1", |v| {
            busy(v, 400);
            v.key("super+digit_1");
        }),
        ("a click on a tree row", |v| {
            v.key("super+digit_1");
            wait_target(v, "tree");
            v.key("super+t");
            wait_target(v, "terminal");
            v.pump();
            let row = v.cx.debug_bounds("tree-row-0").expect("tree row drawn");
            busy(v, 400);
            v.click(MouseButton::Left, row.center());
            v.pump();
            assert_eq!(v.read_ws(|ws, _| ws.native_focus()), Some("tree"));
        }),
    ];
    for (name, focus_tree) in ROWS {
        let mut v = View::start("proj", &["a.ts"]);
        open(&mut v);
        wait_target(&mut v, "terminal");
        focus_tree(&mut v);
        v.key("super+t");
        wait_target(&mut v, "terminal");
        assert!(
            terminal_open(&mut v),
            "{name}: Cmd+T from the tree focuses the terminal"
        );
        v.wait_until(&format!("{name}: the terminal has the keyboard"), |v| {
            v.read_ws(|ws, _| ws.native_focus()) == Some("terminal")
        });
    }
}
