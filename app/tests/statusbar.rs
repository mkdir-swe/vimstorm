//! The status bar on the real nvim + config: mode badge, navigation path, line:col (characters, selection size),
//! line ending, encoding, indent, branch; always about the last focused split; nvim's own status
//! line and the tab bar winbars are off in the app.

use crate::common;

use common::view::View;
use vimstorm::editor::statusbar::{Status, StatusbarView};

fn status(v: &mut View) -> Status {
    v.read_ws(|ws, cx| ws.statusbar().read(cx).status().clone())
}

fn expect(v: &mut View, label: &str, pred: impl Fn(&Status) -> bool) {
    let mut last = Status::default();
    v.wait_until(label, |v| {
        let now = status(v);
        if now != last {
            eprintln!("status: {now:?}"); // (shown when the wait times out)
            last = now;
        }
        pred(&last)
    });
}

fn position(s: &Status) -> &str {
    s.right.first().map_or("", String::as_str)
}

#[test]
fn status_bar_shows_mode_path_position_file_info_and_branch() {
    let mut v = View::start("proj", &["src/components/Button.tsx"]);
    expect(&mut v, "path, file, position, branch", |s| {
        s.crumbs == ["proj", "src", "components"]
            && s.file == "Button.tsx"
            && position(s) == "1:1"
            && s.branch == "main"
    });
    let s = status(&mut v);
    assert_eq!(s.mode, "N");
    assert_eq!(&s.right[1..], ["LF", "UTF-8", "2 spaces"]);

    // the caret moves: line:col follows (characters, not bytes)
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'const åäö = 1;', 'x' }) return true");
    v.key("ä"); // (his keys: ä = right)
    v.key("ä");
    expect(&mut v, "1:3", |s| position(s) == "1:3");
    v.lua("vim.api.nvim_win_set_cursor(0, { 1, 12 }) return true"); // byte 12 = 'ö' + ' '
    v.key("ä");
    expect(&mut v, "characters, not bytes", |s| position(s) == "1:11");
    v.key("ö"); // down
    expect(&mut v, "2:1", |s| position(s) == "2:1");

    // modes: the badge
    v.key("i");
    expect(&mut v, "insert badge", |s| {
        s.mode == "I" && s.mode_kind == "Insert"
    });
    v.key("escape");
    expect(&mut v, "normal badge", |s| {
        s.mode == "N" && s.mode_kind == "Normal"
    });
    v.key("l"); // up
    v.key("0");
    v.key("v");
    v.key("ä");
    v.key("ä");
    expect(&mut v, "visual: the selection's size", |s| {
        s.mode == "V" && position(s) == "1:3 (3 chars)"
    });
    v.key("escape");

    // recording a macro
    v.key("q");
    v.key("q");
    expect(&mut v, "recording @q", |s| s.recording == "q");
    v.key("q");
    expect(&mut v, "recording stopped", |s| s.recording.is_empty());

    // read-only: the lock
    v.lua("vim.bo.readonly = true return true");
    expect(&mut v, "read-only", |s| s.readonly);
}

#[test]
fn status_bar_follows_the_last_focused_split_not_tool_windows() {
    let mut v = View::start("proj", &["a.ts"]);
    expect(&mut v, "a.ts", |s| s.file == "a.ts" && s.crumbs == ["proj"]);
    // the terminal takes the keyboard: still about the split
    v.keystrokes("cmd-t");
    v.wait_lua(
        "terminal focused",
        "return require('config.focus').target() == 'terminal'",
    );
    v.focus_code();
    v.wait_lua(
        "split focused",
        "return require('config.focus').target() == 'split'",
    );
    expect(&mut v, "still a.ts", |s| s.file == "a.ts");
    v.lua("vim.cmd('vsplit multi.txt') return true");
    expect(&mut v, "the other split's file", |s| {
        s.file == "multi.txt"
            && s.right
                .get(3)
                .is_some_and(|i| i.ends_with("spaces") || i == "Tab")
    });
    // the tree has the keyboard: the last focused split's
    v.keystrokes("cmd-1");
    v.wait_lua(
        "tree focused",
        "return require('config.focus').target() == 'tree'",
    );
    let s = status(&mut v);
    assert_eq!(s.file, "multi.txt");
    v.focus_code();

    // nvim's own status line row and the splits' winbars draw nothing in the app
    assert_eq!(v.lua("return vim.o.statusline").as_str(), Some(" "));
    let winbars = v.lua(
        "local n = 0 for _, w in ipairs(vim.api.nvim_list_wins()) do \
         if require('config.focus').is_split(w) and vim.wo[w].winbar ~= '' then n = n + 1 end end return n",
    );
    assert_eq!(winbars.as_i64(), Some(0));
    // the window title stays nvim's ("project – file")
    v.wait_lua("title", "return vim.o.titlestring == 'proj – multi.txt'");
}

#[test]
fn folded_path_keeps_the_project_and_the_last_folders() {
    // (pure rule; the bar measures parts with the UI font)
    let parts: Vec<String> = ["proj", "a", "b", "c"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out = vimstorm::editor::statusbar::fold(&parts, 0., 1., 9., |p| p.chars().count() as f32);
    assert_eq!(out, ["proj", "…", "c"]);
    let _ = std::any::type_name::<StatusbarView>();
}

#[test]
fn status_bar_follows_the_split_while_a_tool_window_is_current() {
    use gpui_kit::{MouseButton, ScrollDelta, TouchPhase, point};
    let mut v = View::start("proj", &["a.ts"]);
    v.lua(
        "vim.fn.writefile(vim.tbl_map(function(i) return 'line ' .. i end, vim.fn.range(1, 300)), 'long.txt') \
         vim.cmd.edit('long.txt') return true",
    );
    expect(&mut v, "long.txt", |s| {
        s.file == "long.txt" && position(s) == "1:1"
    });
    v.keystrokes("cmd-t");
    v.wait_lua(
        "terminal focused",
        "return require('config.focus').target() == 'terminal'",
    );
    // scrolling the split under the mouse moves its caret: the position follows
    let center = v.read(|e| {
        let g = e.geometry();
        g.layout
            .wins
            .iter()
            .find(|w| w.kind == vimstorm::shell::WinKind::Split)
            .unwrap()
            .grid_area
            .center()
    });
    for _ in 0..10 {
        v.scroll(
            center,
            ScrollDelta::Lines(point(0., -6.)),
            TouchPhase::Moved,
        );
    }
    expect(&mut v, "caret scrolled along", |s| {
        s.file == "long.txt" && position(s) != "1:1"
    });
    // the split's tab closed by mouse: the next file
    let tab = v.read_ws(|ws, cx| {
        let t = ws.tabs().read(cx);
        t.drawn()
            .iter()
            .find(|d| {
                t.bars()[&d.win]
                    .tabs
                    .iter()
                    .any(|x| x.buf == d.buf && x.name == "long.txt")
            })
            .copied()
            .unwrap()
    });
    v.click(MouseButton::Middle, tab.tab.center());
    expect(&mut v, "a.ts after closing long.txt", |s| s.file == "a.ts");
    assert_eq!(
        v.lua("return require('config.focus').target()").as_str(),
        Some("terminal")
    );
}

#[test]
fn navigation_path_ends_with_the_declarations_around_the_caret() {
    let mut v = View::start("proj", &["a.ts"]);
    expect(&mut v, "a.ts in the path", |s| s.file == "a.ts");
    let names = |s: &Status| {
        s.symbols
            .iter()
            .map(|m| (m.name.clone(), m.kind.clone()))
            .collect::<Vec<_>>()
    };
    // in add()'s body: "proj › a.ts › add" (WebStorm shows the members after the file)
    v.lua("vim.api.nvim_win_set_cursor(0, {4, 4}) return true");
    expect(&mut v, "inside add()", |s| {
        names(s) == [("add".to_owned(), "Function".to_owned())]
    });
    // on `export const a = 1;` (the caret on `export`): the constant
    v.lua("vim.api.nvim_win_set_cursor(0, {1, 0}) return true");
    expect(&mut v, "on a top-level const", |s| {
        names(s) == [("a".to_owned(), "Constant".to_owned())]
    });
    // between declarations: none
    v.lua("vim.api.nvim_win_set_cursor(0, {2, 0}) return true");
    expect(&mut v, "between declarations", |s| s.symbols.is_empty());
}

/// The contract's `workspaces` feed with card 2's look on `dir`.
fn feed_on(
    dir: &std::path::Path,
) -> (
    vimstorm::factory::WorkspaceFeed,
    vimstorm::factory::WorkspaceLook,
) {
    use vimstorm::factory::{BridgeFrame, ShellEffect};
    let line = std::fs::read_to_string(crate::common::bridge::fixture(
        "frames/bridge-shell-workspaces.json",
    ))
    .unwrap();
    let Some(BridgeFrame::Shell {
        effect:
            ShellEffect::Workspaces {
                workspaces,
                factory,
                answering,
                ..
            },
        ..
    }) = vimstorm::factory::read_line(&line.replace('\n', ""))
    else {
        panic!("the contract's workspaces frame");
    };
    let mut two = workspaces.iter().find(|w| w.story.id == 2).unwrap().clone();
    two.root = dir.to_string_lossy().into_owned();
    let feed = vimstorm::factory::WorkspaceFeed {
        workspaces,
        factory,
        answering,
        abe_needs_you: Vec::new(),
        prototypes: Vec::new(),
        bridge_down: false,
    };
    (feed, two)
}

#[test]
fn the_bar_per_view_the_editors_story_and_branch_the_factorys_crumb_and_widgets_only() {
    use vimstorm::factory::ShownWorkspaces;
    use vimstorm::factory::{Hue, ViewName, Widget, WidgetPlace};
    let mut v = View::start("proj", &["src/components/Button.tsx"]);
    let dir = v.read_ws(|ws, _| ws.project().clone());
    let (feed, two) = feed_on(&dir);
    v.cx.update(|_, cx| {
        cx.set_global(feed);
        cx.set_global(ShownWorkspaces([(dir.clone(), two)].into_iter().collect()));
    });
    let drawn = |v: &mut View| {
        v.pump();
        v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().clone())
    };
    // the Editor: the story in the folder's place, then the editor's own, then the branch
    v.wait_until("the story crumb and the branch", |v| {
        let d = drawn(v);
        d.crumbs == ["#2 cart total ignores quantity", "src", "components"]
            && d.right.last().is_some_and(|b| b == "main")
    });
    // the feed's card 1 needs you: not counted here (the rail's tiles say it); the caret's and
    // the editor's own
    let right = drawn(&mut v).right;
    assert!(!right.iter().any(|w| w.contains("need you")), "{right:?}");
    assert_eq!(&right[1..], ["LF", "UTF-8", "2 spaces", "main"]);

    // the Factory view: ABE · BOARD, `demo-shop · Sprint 1`, only its widgets: no branch
    let widget = |id: &str, text: &str, hue| Widget {
        id: id.into(),
        text: text.into(),
        hue: Some(hue),
        cloud: None,
        tooltip: None,
        view: Some(ViewName::Factory),
        place: WidgetPlace::End,
    };
    v.cx.update(|_, cx| {
        cx.set_global(vimstorm::factory::FactoryShell {
            shown: true,
            widgets: vec![
                widget("needs-you", "◆ 1 needs you", Hue::NeedsYou),
                widget("running", "● 2 running", Hue::Warn),
            ],
            ..Default::default()
        })
    });
    v.wait_until("the Factory's bar", |v| {
        drawn(v).crumbs == ["demo-shop · Sprint 1"]
    });
    assert_eq!(drawn(&mut v).right, ["◆ 1 needs you", "● 2 running"]);
    assert_eq!(
        v.read_ws(|ws, cx| ws.statusbar().read(cx).segment_text(cx)),
        "ABE · BOARD"
    );
    assert!(
        v.cx.debug_bounds("status-branch").is_none(),
        "never a workspace's branch"
    );
}
