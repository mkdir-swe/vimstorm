//! The native pickers on the real nvim + config: Search Everywhere (Shift Shift, its tabs keeping
//! the text, Go to File's recent-first order), Find in Files (ripgrep, preview, Enter before the
//! first result), typeahead after a picker shortcut, popups on a small window, a click outside
//! closing them, the Ctrl+Tab switcher (Ctrl release opens) and the usages popup.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::time::{Duration, Instant};

use common::TIMEOUT;
use common::gitui::{bounds, target, wait_target};
use common::pickers::{
    CTRL, NONE, SHIFT, closed, edit, file, is, picker, query, shift_shift, type_text, wait_file,
    wait_picker,
};
use common::terminal::{open as open_terminal, prompt, settle as term_settle, typing, wait_typing};
use common::tree::row_point;
use common::view::View;
use gpui_kit::{Modifiers, MouseButton};

fn open_switcher(v: &mut View) {
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(v, "switcher open", is("switcher"));
}

/// Presses `keys` one by one; after each the popup (`selector`) has the same bounds as before
/// and the selection moved at least once.
fn stays_put(v: &mut View, name: &str, selector: &str, keys: &[&str]) {
    v.settle();
    let frame = bounds(v, selector).unwrap_or_else(|| panic!("{name}: {selector} drawn"));
    let mut seen = vec![picker(v).and_then(|s| s.cursor.map(|c| (s.title.clone(), c)))];
    for k in keys {
        v.key(k);
        v.settle();
        assert_eq!(
            bounds(v, selector),
            Some(frame),
            "{name}: the popup doesn't move or resize after {k}"
        );
        seen.push(picker(v).and_then(|s| s.cursor.map(|c| (s.title.clone(), c))));
    }
    seen.dedup();
    assert!(seen.len() > 1, "{name}: the selection moved: {seen:?}");
}

#[test]
fn search_everywhere_tabs_keep_the_text_and_esc_returns_to_the_code() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua("vim.cmd.startinsert() return true");
    v.wait_lua("insert mode", "return vim.api.nvim_get_mode().mode == 'i'");

    // Shift Shift while typing: Search Everywhere on its All tab
    shift_shift(&mut v);
    wait_picker(
        &mut v,
        "Shift Shift opens Search Everywhere (All)",
        is("all"),
    );
    let st = picker(&mut v).unwrap();
    assert_eq!(st.title, "Search Everywhere");
    assert!(!st.preview, "Search Everywhere has no preview: {st:#?}");
    for tab in ["se-tab-All", "se-tab-Files", "se-tab-Symbols"] {
        assert!(bounds(&mut v, tab).is_some(), "{tab} drawn");
    }
    v.wait_lua(
        "focus.target() is popup",
        "return require('config.focus').target() == 'popup'",
    );
    v.key("escape");
    wait_picker(&mut v, "Esc closes it", closed);
    v.wait_lua(
        "back in the code, normal mode",
        "return require('config.focus').target() == 'split' and vim.api.nvim_get_mode().mode == 'n'",
    );

    // Cmd+O: the Files tab; Shift Shift there: All, text kept; again: stays
    v.key("super+o");
    wait_picker(&mut v, "Cmd+O opens Go to File (Files tab)", is("files"));
    type_text(&mut v, "abc");
    wait_picker(&mut v, "typed into the field", |s| query(s) == "abc");
    shift_shift(&mut v);
    wait_picker(&mut v, "Shift Shift on Files: All, text kept", |s| {
        is("all")(s) && query(s) == "abc"
    });
    shift_shift(&mut v);
    v.settle();
    let st = picker(&mut v).unwrap();
    assert_eq!(
        (st.kind.as_str(), st.query.as_str()),
        ("all", "abc"),
        "Shift Shift on All: stays"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // Tab / Shift+Tab: tabs switch in the same popup, text kept
    v.lua("Snacks.picker.smart() return true");
    wait_picker(
        &mut v,
        "Snacks.picker.smart() opens the native All tab",
        is("all"),
    );
    type_text(&mut v, "add");
    wait_picker(&mut v, "add typed", |s| query(s) == "add");
    v.key("shift+tab");
    wait_picker(&mut v, "Shift+Tab: Symbols, text kept", |s| {
        is("symbols")(s) && query(s) == "add"
    });
    v.key("tab");
    wait_picker(&mut v, "Tab: back to All", |s| {
        is("all")(s) && query(s) == "add"
    });
    v.key("tab");
    v.key("tab");
    wait_picker(&mut v, "Tab Tab: Symbols", |s| {
        is("symbols")(s) && query(s) == "add"
    });
    v.key("tab");
    v.key("shift+tab");
    wait_picker(&mut v, "Tab Shift+Tab: still Symbols", is("symbols"));
    // a click on a tab
    let files_tab = v.cx.debug_bounds("se-tab-Files").expect("Files tab drawn");
    v.click(MouseButton::Left, files_tab.center());
    wait_picker(&mut v, "a click on Files", |s| {
        is("files")(s) && query(s) == "add"
    });
    v.key("escape");
    wait_picker(&mut v, "Esc after tab switches closes it", closed);
    v.wait_lua(
        "back in the code, normal mode",
        "return require('config.focus').target() == 'split' and vim.api.nvim_get_mode().mode == 'n'",
    );
    // typing capitals (Shift + letter, twice) in the field is no Shift Shift
    v.key("super+o");
    wait_picker(&mut v, "Go to File", is("files"));
    for k in ["A", "B"] {
        v.modifiers(SHIFT);
        v.key(&format!("shift+{}", k.to_lowercase()));
        v.modifiers(NONE);
    }
    wait_picker(&mut v, "AB typed", |s| query(s) == "AB");
    v.settle();
    assert!(is("files")(&picker(&mut v)), "capitals don't switch to All");
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

#[test]
fn go_to_file_lists_recent_files_first_and_opens_the_match() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");
    v.key("super+o");
    wait_picker(&mut v, "Go to File settled", |s| {
        is("files")(s) && s.as_ref().unwrap().settled
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(
        &st.rows[..2],
        ["c.ts", "b.ts"],
        "recently opened files first, the current one not: {st:#?}"
    );
    // the project's files by snacks' rules: gitignored / hidden left out, symlinks in
    assert!(st.rows.iter().any(|r| r == "link.ts"), "{st:#?}");
    assert!(
        !st.rows
            .iter()
            .any(|r| r == "ignored.log" || r == "index.js"),
        "{st:#?}"
    );
    assert!(
        !st.rows.iter().any(|r| r == ".gitignore"),
        "hidden files left out: {st:#?}"
    );

    type_text(&mut v, "men");
    wait_picker(&mut v, "men matched", |s| {
        query(s) == "men" && s.as_ref().unwrap().settled
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(
        st.rows.first().map(String::as_str),
        Some("menu.txt"),
        "{st:#?}"
    );
    assert_eq!(st.cursor, Some(0));
    // settled results never reshuffle: nothing to wait for, so 300 ms on nvim's clock
    v.lua("_G.settled_at = vim.uv.hrtime() return true");
    v.wait_lua(
        "300 ms on nvim's clock",
        "return (vim.uv.hrtime() - _G.settled_at) / 1e6 >= 300",
    );
    assert_eq!(
        picker(&mut v).unwrap().rows,
        st.rows,
        "results stay put once found"
    );

    // Cmd+C with nothing selected: the field's text; Cmd+A Cmd+C too
    let clip = |v: &mut View| {
        v.cx.update(|_, cx| cx.read_from_clipboard())
            .and_then(|c| c.text())
            .unwrap_or_default()
    };
    v.key("super+c");
    assert_eq!(clip(&mut v), "men");
    assert!(is("files")(&picker(&mut v)), "Cmd+C keeps the popup");
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("x".into()));
    v.key("super+a");
    v.key("super+c");
    assert_eq!(clip(&mut v), "men");

    // Down / Ctrl+P move; Enter opens the selected file in the editor
    v.key("arrow_down");
    v.key("ctrl+p");
    wait_picker(&mut v, "back on the first row", |s| {
        s.as_ref().unwrap().cursor == Some(0)
    });
    v.key("enter");
    wait_picker(&mut v, "Enter closes it", closed);
    wait_file(&mut v, "menu.txt");
    assert_eq!(target(&v), "split");

    // Recent Files opens even with no history
    v.lua("vim.v.oldfiles = {} Snacks.picker.recent({ filter = { cwd = true } }) return true");
    // the switcher in its recent mode
    wait_picker(&mut v, "Recent Files opens", is("recent"));
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // double-click a row opens it
    v.key("super+o");
    wait_picker(&mut v, "Go to File", |s| {
        is("files")(s) && s.as_ref().unwrap().settled
    });
    let row = v.cx.debug_bounds("search-row-1").expect("second row drawn");
    let name = picker(&mut v).unwrap().rows[1].clone();
    v.click(MouseButton::Left, row.center());
    wait_picker(&mut v, "a click selects", |s| {
        s.as_ref().unwrap().cursor == Some(1)
    });
    v.cx.simulate_event(gpui_kit::MouseDownEvent {
        position: row.center(),
        button: MouseButton::Left,
        modifiers: NONE,
        click_count: 2,
        first_mouse: false,
    });
    wait_picker(&mut v, "a double-click opens it", closed);
    wait_file(&mut v, &name);
}

#[test]
fn keys_typed_right_after_the_shortcut_land_in_the_field() {
    let mut v = View::start("proj", &["a.ts"]);
    // no waiting between the shortcut and the text: nvim holds them, the picker gets them
    v.key("super+o");
    type_text(&mut v, "menu");
    wait_picker(&mut v, "typeahead in the field", |s| {
        is("files")(s) && query(s) == "menu" && s.as_ref().unwrap().settled
    });
    assert_eq!(picker(&mut v).unwrap().rows[0], "menu.txt");
    assert_eq!(
        v.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]")
            .as_str(),
        Some("export const a = 1;"),
        "nothing typed into the file"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    // one burst (keys queued in nvim's input buffer together with the shortcut)
    v.lua("_G.dbg_keys = {} return true");
    v.lua("vim.cmd('messages clear') return true");
    v.request("nvim_input", vec!["<D-o>mudd".into()]);
    wait_picker(&mut v, "a burst lands in the field", |s| {
        is("files")(s) && query(s) == "mudd"
    });
    // `d` is mapped (`"zd`): what the mapping expands to is held too, nothing runs in the editor
    assert_eq!(
        v.lua("return vim.api.nvim_exec2('messages', { output = true }).output")
            .as_str(),
        Some("")
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // Find in Files: text and Enter before the first result (all still held by nvim, so no result
    // can be in yet; typed into the field, rg may answer before the Enter): the popup stays,
    // results come
    v.request("nvim_input", vec!["<D-S-f>const b<CR>".into()]);
    wait_picker(&mut v, "results for const b", |s| {
        is("grep")(s) && query(s) == "const b" && s.as_ref().unwrap().settled
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(
        st.details.first().map(String::as_str),
        Some("b.ts 1"),
        "{st:#?}"
    );
    assert_eq!(file(&v), "a.ts", "nothing opened by the early Enter");
    v.key("enter");
    wait_picker(&mut v, "Enter opens the result", closed);
    wait_file(&mut v, "b.ts");

    // nvim slow to read the keys queued before the picker had the keyboard (its answer to
    // focused() parked here): keys typed into the picker meanwhile wait behind them, so an
    // early Enter never acts on half the text
    v.lua(
        "local P = require('config.app.pickers') _G.real_focused, _G.parked = P.focused, {} \
         P.focused = function(t) table.insert(_G.parked, t) end return true",
    );
    v.request("nvim_input", vec!["<D-S-f>const".into()]);
    wait_picker(&mut v, "Find in Files", is("grep"));
    v.wait_lua(
        "the app told Lua it has the keyboard",
        "return #_G.parked > 0",
    );
    type_text(&mut v, " b");
    let st = picker(&mut v);
    assert!(
        is("grep")(&st) && !query(&st).contains('b'),
        "typed keys wait for nvim: {st:#?}"
    );
    v.lua(
        "local P = require('config.app.pickers') P.focused = _G.real_focused \
         for _, t in ipairs(_G.parked) do P.focused(t) end return true",
    );
    wait_picker(&mut v, "held text first, then what was typed", |s| {
        query(s) == "const b"
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // a shortcut queued right behind nvim's end of the hold reaches its mapping (it was read
    // before the hold ended and swallowed)
    v.lua(
        "local P = require('config.app.pickers') _G.parked = {} \
         P.focused = function(t) table.insert(_G.parked, t) end return true",
    );
    v.request("nvim_input", vec!["<D-o>".into()]);
    wait_picker(&mut v, "Go to File", is("files"));
    v.wait_lua("parked", "return #_G.parked > 0");
    v.lua(
        "local P = require('config.app.pickers') P.focused = _G.real_focused \
         for _, t in ipairs(_G.parked) do P.focused(t) end vim.api.nvim_input('<D-S-f>') \
         return true",
    );
    wait_picker(
        &mut v,
        "Cmd+Shift+F behind it opens Find in Files",
        is("grep"),
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // from the terminal: the terminal holds keys typed right after a shortcut that went to nvim
    // until nvim answered
    open_terminal(&mut v);
    let shell = prompt(&mut v);
    v.key("super+o");
    v.key("a");
    v.key("b");
    wait_picker(&mut v, "a burst from the terminal", |s| {
        is("files")(s) && query(s).contains('b')
    });
    term_settle(&mut v);
    assert_eq!(
        (query(&picker(&mut v)), prompt(&mut v)),
        ("ab", shell.clone()),
        "ab in Go to File's field, nothing in the shell"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    wait_typing(&mut v);
    term_settle(&mut v);
    assert_eq!(prompt(&mut v), shell, "nothing typed into the shell");
}

#[test]
fn find_in_files_streams_ripgrep_results_over_a_preview() {
    let mut v = View::start("proj", &["a.ts"]);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files opens", is("grep"));
    assert_eq!(picker(&mut v).unwrap().title, "Find in Files");
    type_text(&mut v, "export");
    wait_picker(&mut v, "results", |s| {
        query(s) == "export" && s.as_ref().unwrap().settled && !s.as_ref().unwrap().rows.is_empty()
    });
    let st = picker(&mut v).unwrap();
    assert!(st.preview);
    assert!(
        st.rows.iter().all(|r| r.starts_with("export")),
        "rows start with the code: {st:#?}"
    );
    assert!(st.details.contains(&"a.ts 1".to_string()), "{st:#?}");
    // gitignored files aren't searched
    assert!(
        !st.details.iter().any(|d| d.starts_with("index.js")),
        "{st:#?}"
    );
    assert!(v.cx.debug_bounds("find-in-files").is_some());
    // the selected match moves; Enter opens it at the match
    v.key("ctrl+n");
    wait_picker(&mut v, "second row", |s| {
        s.as_ref().unwrap().cursor == Some(1)
    });
    let second = picker(&mut v).unwrap().details[1].clone();
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    let (name, line) = second.rsplit_once(' ').unwrap();
    wait_file(&mut v, name);
    assert_eq!(
        v.lua("return vim.api.nvim_win_get_cursor(0)[1]").as_i64(),
        Some(line.parse().unwrap())
    );
    // a bad regex says so (regex is off by default, WS: Alt+X turns it on)
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    v.key("alt+x");
    wait_picker(&mut v, "regex on", |s| {
        s.as_ref().is_some_and(|s| s.right.contains("regex"))
    });
    type_text(&mut v, "(");
    wait_picker(&mut v, "done", |s| {
        query(s) == "(" && s.as_ref().unwrap().settled
    });
    assert!(picker(&mut v).unwrap().rows.is_empty());
    v.key("escape");
    wait_picker(&mut v, "Esc closes it", closed);
}

#[test]
fn popups_fit_a_small_window_and_a_click_outside_closes_them() {
    let mut v = View::start("proj", &["a.ts"]);
    v.cx.simulate_resize(gpui_kit::size(gpui_kit::px(520.), gpui_kit::px(380.)));
    v.settle();
    let viewport = v.cx.update(|window, _| window.viewport_size());
    for (keys, kind, sel) in [
        ("super+o", "files", "search-everywhere"),
        ("super+shift+f", "grep", "find-in-files"),
    ] {
        v.key(keys);
        wait_picker(&mut v, kind, is(kind));
        v.pump();
        let b = v.cx.debug_bounds(sel).expect("popup drawn");
        assert!(
            b.origin.x >= gpui_kit::px(0.)
                && b.origin.y >= gpui_kit::px(0.)
                && b.right() <= viewport.width
                && b.bottom() <= viewport.height,
            "{sel} fits the window: {b:?} in {viewport:?}"
        );
        // a click outside (the status bar) closes it, the keyboard back in nvim
        let outside = gpui_kit::point(
            viewport.width - gpui_kit::px(3.),
            viewport.height - gpui_kit::px(3.),
        );
        assert!(!b.contains(&outside));
        v.click(MouseButton::Left, outside);
        wait_picker(&mut v, "a click outside closes it", closed);
        v.settle();
        assert_ne!(
            v.read_ws(|ws, _| ws.native_focus()),
            Some("pickers"),
            "the closed picker gave the keyboard away"
        );
        v.focus_code();
        v.wait_lua(
            "nvim has the keyboard",
            "return require('config.focus').target() == 'split'",
        );
    }
}

/// Workspace symbols stubbed in Lua (no language server start): `lineTotal` and `multiply` in
/// a.ts for queries that fuzzy-match them, nothing else.
const SYMBOLS_STUB: &str = r#"
  local root = vim.fn.getcwd()
  local all = {
    { name = 'lineTotal', kind = 'Function', container = '', file = root .. '/a.ts', rel = 'a.ts', line = 3, col = 17, enc = 'utf-16' },
    { name = 'multiply', kind = 'Function', container = 'math', file = root .. '/a.ts', rel = 'a.ts', line = 1, col = 14, enc = 'utf-16' },
  }
  require('config.app.pickers').symbols = function(id, query)
    local items = {}
    for _, s in ipairs(all) do
      if query ~= '' and s.name:lower():find(query:lower(), 1, true) then items[#items + 1] = s end
    end
    require('config.app.bridge').notify('pickers', { event = 'symbols', id = id, items = items, done = true })
  end
  return true
"#;

#[test]
fn search_everywhere_all_lists_files_then_symbols() {
    let mut v = View::start("proj", &["b.ts"]);
    v.lua(SYMBOLS_STUB);
    // a symbol name: All finds the symbol, Enter opens it at its line
    shift_shift(&mut v);
    wait_picker(&mut v, "Search Everywhere (All)", is("all"));
    type_text(&mut v, "linetotal");
    wait_picker(&mut v, "All lists the symbol", |s| {
        s.as_ref()
            .is_some_and(|s| s.query == "linetotal" && s.rows == ["lineTotal"])
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(st.details, ["a.ts"], "the symbol's file");
    assert_eq!(st.cursor, Some(0));
    // the Files tab: files only
    v.key("tab");
    wait_picker(&mut v, "Files: nothing", |s| {
        s.as_ref()
            .is_some_and(|s| s.kind == "files" && s.settled && s.rows.is_empty())
    });
    v.key("shift+tab");
    wait_picker(&mut v, "back on All: the symbol again", |s| {
        s.as_ref()
            .is_some_and(|s| s.kind == "all" && s.rows == ["lineTotal"])
    });
    v.key("enter");
    wait_picker(&mut v, "Enter opens it", closed);
    v.wait_lua(
        "a.ts at lineTotal's line",
        "return vim.fn.expand('%:t') == 'a.ts' and vim.fn.line('.') == 3",
    );

    // files and symbols both: the files' group first, each under its title; the titles take
    // no cursor
    shift_shift(&mut v);
    wait_picker(&mut v, "All again", is("all"));
    type_text(&mut v, "multi");
    wait_picker(&mut v, "files, then symbols", |s| {
        s.as_ref().is_some_and(|s| {
            s.query == "multi"
                && s.rows.first().map(String::as_str) == Some("Files")
                && s.rows.contains(&"multi.txt".to_string())
                && s.rows
                    .ends_with(&["Symbols".to_string(), "multiply".to_string()])
        })
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(st.cursor, Some(1), "the first file, not its title: {st:?}");
    // rows: Files, the files, Symbols, multiply: Down past the last file lands on multiply
    let last = st.rows.len() - 1;
    for _ in 1..last - 1 {
        v.key("arrow_down");
    }
    wait_picker(&mut v, "Down steps over the Symbols title", |s| {
        s.as_ref().unwrap().cursor == Some(last)
    });
    // the query cleared: the symbols go at once, no row points at them
    for _ in 0.."multi".len() {
        v.key("backspace");
    }
    wait_picker(&mut v, "nothing typed: no symbols", |s| {
        s.as_ref().is_some_and(|s| {
            s.query.is_empty() && !s.rows.iter().any(|r| r == "Symbols" || r == "multiply")
        })
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

#[test]
fn switcher_opens_the_selection_when_ctrl_is_released() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");
    v.lua("vim.cmd('badd src/components') return true");

    // Ctrl+Tab released at once: the previous file
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    wait_picker(&mut v, "switcher open", is("switcher"));
    v.modifiers(NONE);
    wait_picker(&mut v, "Ctrl released: closed", closed);
    wait_file(&mut v, "c.ts");

    // held Ctrl: Tab moves down; the release opens it
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    wait_picker(&mut v, "switcher open", is("switcher"));
    let st = picker(&mut v).unwrap();
    assert_eq!(
        st.rows,
        ["c.ts", "a.ts", "b.ts"],
        "open files, most recent first, no folders"
    );
    assert_eq!(
        st.details,
        ["Project", "Chat", "Terminal", "Git"],
        "tool windows: ⌘1 ⌘2, the pages ⌃3 ⌃4"
    );
    assert_eq!(
        (st.title.as_str(), st.cursor),
        ("files", Some(1)),
        "the previous file selected"
    );
    v.key("ctrl+tab");
    wait_picker(&mut v, "Ctrl+Tab again moves down", |s| {
        s.as_ref().unwrap().cursor == Some(2)
    });
    v.key("ctrl+shift+tab");
    wait_picker(&mut v, "Ctrl+Shift+Tab moves up", |s| {
        s.as_ref().unwrap().cursor == Some(1)
    });
    v.key("ctrl+tab");
    v.modifiers(NONE);
    wait_picker(&mut v, "released: closed", closed);
    wait_file(&mut v, "b.ts");

    // opened without waiting for Ctrl (tests / screenshots): keys, Enter, Esc
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(&mut v, "open", is("switcher"));
    v.key("tab");
    wait_picker(&mut v, "Tab moves down", |s| {
        s.as_ref().unwrap().cursor == Some(2)
    });
    v.key("arrow_left");
    wait_picker(&mut v, "← the tool windows", |s| {
        s.as_ref().unwrap().title == "tools"
    });
    v.key("arrow_right");
    v.key("arrow_up");
    wait_picker(&mut v, "files, up", |s| {
        let s = s.as_ref().unwrap();
        s.title == "files" && s.cursor == Some(1)
    });
    v.key("enter");
    wait_picker(&mut v, "Enter opens it", closed);
    wait_file(&mut v, "c.ts");
    v.lua("require('config.switcher').open({ wait = false, back = true }) return true");
    wait_picker(&mut v, "Ctrl+Shift+Tab starts at the last file", |s| {
        s.as_ref().is_some_and(|s| s.cursor == Some(2))
    });
    v.key("escape");
    wait_picker(&mut v, "Esc closes it", closed);
    assert_eq!(file(&v), "c.ts");
    // a tool window: Project focuses the tree
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(&mut v, "open", is("switcher"));
    v.key("k");
    v.key("l");
    wait_picker(&mut v, "Project selected", |s| {
        let s = s.as_ref().unwrap();
        s.title == "tools" && s.cursor == Some(0)
    });
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    v.wait_lua(
        "the tree has focus",
        "return require('config.focus').target() == 'tree'",
    );
    // Chat (⌘2): the Chat column shown with the keyboard
    v.focus_code();
    assert!(
        v.read(|e| e.geometry().layout.frame.chat.is_none()),
        "a bare workspace starts without the Chat column"
    );
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(&mut v, "open", is("switcher"));
    v.key("k");
    wait_picker(&mut v, "the tool windows", |s| {
        s.as_ref().unwrap().title == "tools"
    });
    // (the column keeps the row; moves wrap)
    let at = picker(&mut v).unwrap().cursor.unwrap();
    for _ in 0..(1 + 7 - at) % 7 {
        v.key("ö");
    }
    wait_picker(&mut v, "Chat selected", |s| {
        let s = s.as_ref().unwrap();
        s.title == "tools" && s.cursor == Some(1)
    });
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    v.wait_for("the Chat column shown", |e| {
        e.geometry().layout.frame.chat.is_some()
    });
    v.wait_until("the Chat column has the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus()) == Some("chat")
    });
    // a click on a file opens it
    v.focus_code();
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(&mut v, "open", is("switcher"));
    let row =
        v.cx.debug_bounds("switcher-file-2")
            .expect("third file drawn");
    let name = picker(&mut v).unwrap().rows[2].clone();
    v.click(MouseButton::Left, row.center());
    wait_picker(&mut v, "click opens", closed);
    wait_file(&mut v, &name);
}

/// LSP answers stubbed in Lua (deterministic, no language server start): usages.lua's logic and
/// the native popup are real.
const LSP_STUB: &str = r#"
  local root = vim.fn.getcwd()
  local function loc(f, l, c, e) return { uri = vim.uri_from_fname(root .. '/' .. f), range = { start = { line = l, character = c }, ['end'] = { line = l, character = e } } } end
  local answers = {
    ['textDocument/definition'] = { loc('a.ts', 2, 16, 19) },
    ['textDocument/references'] = { loc('a.ts', 2, 16, 19), loc('b.ts', 0, 13, 14), loc('c.ts', 0, 13, 14), loc('menu.txt', 1, 0, 4) },
  }
  local fake = { id = 4242, name = 'stub', offset_encoding = 'utf-16' }
  local get_clients, by_id = vim.lsp.get_clients, vim.lsp.get_client_by_id
  vim.lsp.get_clients = function(o)
    if o and answers[o.method] then return { fake } end
    return get_clients(o)
  end
  vim.lsp.get_client_by_id = function(id) if id == 4242 then return fake end return by_id(id) end
  vim.lsp.buf_request_all = function(_, method, _, cb)
    local r = vim.deepcopy(answers[method] or {})
    if method == 'textDocument/references' then table.remove(r, 1) end
    vim.schedule(function() cb({ [4242] = { result = r } }) end)
  end
  return true
"#;

#[test]
fn usages_popup_at_the_caret_jumps_to_the_pick() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua(LSP_STUB);
    v.lua("vim.api.nvim_win_set_cursor(0, { 3, 17 }) return true"); // on `add`
    v.key("super+b");
    wait_picker(
        &mut v,
        "Cmd+B on the declaration: Show Usages",
        is("usages"),
    );
    let st = picker(&mut v).unwrap();
    assert_eq!(st.title, "Usages of add");
    assert_eq!(st.right, "3 usages in Project Files", "the header's count");
    assert_eq!(st.details, ["b.ts 1", "c.ts 1", "menu.txt 2"], "{st:#?}");
    assert_eq!(st.rows[0], "export const b = 2;");
    // under the caret
    let b = v.cx.debug_bounds("usages").expect("drawn");
    let caret = v.read(|e| e.geometry().caret).expect("caret");
    assert!(
        b.origin.y >= caret.bottom() && b.origin.y < caret.bottom() + gpui_kit::px(8.),
        "{b:?} {caret:?}"
    );
    // typing searches at once (no `/`), also the file column; every letter types, k / ä too
    v.key("k");
    v.key("ä");
    wait_picker(&mut v, "k ä type", |s| s.as_ref().unwrap().query == "kä");
    v.key("backspace");
    v.key("backspace");
    type_text(&mut v, "menx");
    wait_picker(&mut v, "speed search", |s| {
        s.as_ref().unwrap().query == "menx"
    });
    v.key("backspace");
    v.key("u");
    wait_picker(&mut v, "speed search", |s| {
        let s = s.as_ref().unwrap();
        s.query == "menu" && s.details == ["menu.txt 2"]
    });
    v.key("escape");
    wait_picker(&mut v, "Esc clears the search, keeps the row", |s| {
        let s = s.as_ref().unwrap();
        s.rows.len() == 3 && s.cursor == Some(2)
    });
    v.key("arrow_up");
    v.key("enter");
    wait_picker(&mut v, "Enter jumps", closed);
    wait_file(&mut v, "c.ts");
    assert_eq!(
        v.lua("local c = vim.api.nvim_win_get_cursor(0) return c[1] * 100 + c[2]")
            .as_i64(),
        Some(113)
    );
    // grr: the same popup; Esc closes it, the caret stays
    edit(&mut v, "a.ts");
    v.lua("vim.api.nvim_win_set_cursor(0, { 3, 17 }) return true");
    v.key("g");
    v.key("r");
    v.key("r");
    wait_picker(&mut v, "grr", is("usages"));
    v.key("escape");
    wait_picker(&mut v, "Esc closes it", closed);
    assert_eq!(file(&v), "a.ts");
    v.wait_lua(
        "keyboard back in nvim",
        "return require('config.focus').target() == 'split'",
    );
    // Cmd+B while typing: Esc gives back typing at the same spot
    v.key("i");
    v.wait_lua("insert mode", "return vim.api.nvim_get_mode().mode == 'i'");
    v.key("super+b");
    wait_picker(&mut v, "Cmd+B while typing", is("usages"));
    v.key("escape");
    wait_picker(&mut v, "Esc closes it", closed);
    v.wait_lua(
        "typing again at the same spot",
        "local c = vim.api.nvim_win_get_cursor(0) \
         return vim.api.nvim_get_mode().mode == 'i' and c[1] == 3 and c[2] == 17 \
         and require('config.focus').target() == 'split'",
    );
    assert_eq!(file(&v), "a.ts");
}

/// Perf: Go to File on a 10k-file project once the index is in (numbers on stderr; run with
/// `--release` for real ones).
#[test]
fn go_to_file_first_results_on_ten_thousand_files() {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-10k-")
        .tempdir()
        .unwrap();
    for d in 0..100 {
        let sub = dir.path().join(format!("src/module{d}/parts"));
        std::fs::create_dir_all(&sub).unwrap();
        for f in 0..100 {
            std::fs::write(sub.join(format!("file{f}_{d}.ts")), "x").unwrap();
        }
    }
    std::fs::write(dir.path().join("a.ts"), "export const a = 1;\n").unwrap();
    let root = dir.path().canonicalize().unwrap().display().to_string();
    let mut v = View::start(&root, &["a.ts"]);
    let deadline = Instant::now() + TIMEOUT;
    while v
        .read_ws(|ws, cx| ws.pickers().read(cx).index())
        .is_none_or(|i| i.len() < 10_000)
    {
        assert!(Instant::now() < deadline, "index never came");
        v.wait_lua("idle", "return true");
    }
    v.key("super+o");
    wait_picker(&mut v, "open", |s| {
        is("files")(s) && s.as_ref().unwrap().settled
    });
    let mut times = Vec::new();
    for q in [
        "f", "fi", "fil", "file", "file4", "file42", "file42_", "file42_7",
    ] {
        let t = Instant::now();
        let last = q.chars().last().unwrap().to_string();
        type_text(&mut v, &last);
        wait_picker(&mut v, q, |s| query(s) == q && s.as_ref().unwrap().settled);
        times.push(t.elapsed());
    }
    let st = picker(&mut v).unwrap();
    assert_eq!(
        st.rows.first().map(String::as_str),
        Some("file42_7.ts"),
        "{st:#?}"
    );
    let ms: Vec<f64> = times.iter().map(|d| d.as_secs_f64() * 1000.).collect();
    eprintln!("[perf] Go to File, 10k files, key -> results (ms): {ms:.1?}");
    let worst = times.iter().max().copied().unwrap_or_default();
    // debug build, test dispatcher (key dispatch + nvim round trip of the key included)
    assert!(worst < Duration::from_millis(1000), "{worst:?}");
}

/// A project dir of its own (`git init`, so .gitignore applies).
fn temp_project(files: &[(&str, &str)]) -> (tempfile::TempDir, String) {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-pickers-")
        .tempdir()
        .unwrap();
    for (name, text) in files {
        let p = dir.path().join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    let root = dir.path().canonicalize().unwrap().display().to_string();
    (dir, root)
}

fn cursor(v: &View) -> (i64, i64) {
    let c = v.lua("return vim.api.nvim_win_get_cursor(0)");
    let a = c.as_array().unwrap();
    (a[0].as_i64().unwrap(), a[1].as_i64().unwrap())
}

#[test]
fn quick_ctrl_tab_sequences_always_open_the_selection() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");
    // order now: a (current), c, b. Ctrl+Tab Tab released at once: two down = b.ts, even when the
    // second Ctrl+Tab reaches nvim before the switcher has the keyboard
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    v.key("ctrl+tab");
    v.modifiers(NONE);
    wait_picker(&mut v, "closed", closed);
    wait_file(&mut v, "b.ts");
    // order: b, a, c. Three quick Ctrl+Tabs wrap: b -> a -> c -> b
    v.modifiers(CTRL);
    for _ in 0..3 {
        v.key("ctrl+tab");
    }
    v.modifiers(NONE);
    wait_picker(&mut v, "closed", closed);
    wait_file(&mut v, "b.ts");
    // again, now slower: the picks keep working (the Lua token follows the Rust one)
    for _ in 0..3 {
        v.modifiers(CTRL);
        v.key("ctrl+tab");
        wait_picker(&mut v, "open", is("switcher"));
        v.modifiers(NONE);
        wait_picker(&mut v, "closed", closed);
    }
    wait_file(&mut v, "a.ts");
}

#[test]
fn ctrl_tab_right_after_a_pick_while_nvim_is_busy_opens_a_new_switcher() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");
    // nvim busy right after it answers the Ctrl release: the app's pick and close queue up as
    // notifications, and the next Ctrl+Tab (a key: nvim reads typeahead before queued
    // notifications) reaches Lua while it still has the old switcher open
    v.lua(
        "local b = require('config.app.bridge') \
         local orig = b.notify \
         _G.__busy_orig = orig \
         b.notify = function(surface, p) \
           orig(surface, p) \
           if surface == 'pickers' and p.event == 'switcher_sync' then \
             vim.schedule(function() vim.uv.sleep(400) end) \
           end \
         end \
         return true",
    );
    // order a, c, b: Ctrl+Tab picks c
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    wait_picker(&mut v, "open", is("switcher"));
    v.modifiers(NONE);
    // (no request to nvim while waiting: it would come after the queued pick)
    v.wait_until("closed", |v| picker(v).is_none());
    // at once, nvim still asleep: Ctrl+Tab again must open a switcher (c on top, a selected)
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    wait_picker(&mut v, "open again", is("switcher"));
    v.lua("require('config.app.bridge').notify = _G.__busy_orig return true");
    v.modifiers(NONE);
    wait_picker(&mut v, "closed again", closed);
    wait_file(&mut v, "a.ts");
}

#[test]
fn search_everywhere_lists_a_chunk_then_a_more_row() {
    let files: Vec<(String, String)> = (0..40)
        .map(|i| (format!("m{i:02}.ts"), String::new()))
        .collect();
    let mut all: Vec<(&str, &str)> = files
        .iter()
        .map(|(n, t)| (n.as_str(), t.as_str()))
        .collect();
    all.push(("u.ts", ""));
    let (_dir, root) = temp_project(&all);
    let mut v = View::start(&root, &["u.ts"]);
    // WS: 30 results on a tab, then "… more"
    v.key("super+o");
    wait_picker(&mut v, "Go to File", is("files"));
    type_text(&mut v, "m");
    wait_picker(&mut v, "30 of 40 and a more row", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && s.rows.len() == 30 && s.more)
    });
    for _ in 0..30 {
        v.key("arrow_down");
    }
    wait_picker(&mut v, "on the more row", |s| {
        s.as_ref().is_some_and(|s| s.cursor == Some(30))
    });
    v.pump();
    assert!(
        v.cx.debug_bounds("search-row-more").is_some(),
        "the \u{2026} more row is drawn (scrolled into view)"
    );
    // Enter on it: the rest listed, the selection on the first new one, the popup stays
    v.key("enter");
    wait_picker(&mut v, "all 40, no more row", |s| {
        s.as_ref()
            .is_some_and(|s| s.rows.len() == 40 && !s.more && s.cursor == Some(30))
    });
    // the All tab (several contributors in WS): 15
    shift_shift(&mut v);
    wait_picker(&mut v, "All: 15 and a more row", |s| {
        is("all")(s)
            && s.as_ref()
                .is_some_and(|s| s.settled && s.rows.len() == 15 && s.more)
    });
    // a new query starts from the first chunk again; Enter on a file still opens it
    type_text(&mut v, "0");
    wait_picker(&mut v, "m0x: 10 files, no more row", |s| {
        query(s) == "m0" && s.as_ref().is_some_and(|s| s.settled && !s.more)
    });
    v.key("enter");
    wait_picker(&mut v, "opened", closed);
}

#[test]
fn find_in_files_puts_the_caret_on_the_match_byte() {
    let long = format!("{}needle", "x".repeat(600));
    let (_dir, root) = temp_project(&[
        ("u.ts", "const åäö = 'ä'; // needle\n"),
        ("long.txt", &long),
        ("sub/in.ts", "needle in sub\n"),
        (".hidden.ts", "needle hidden\n"),
    ]);
    let mut v = View::start(&root, &["u.ts"]);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    type_text(&mut v, "needle");
    wait_picker(&mut v, "results", |s| {
        s.as_ref().is_some_and(|s| s.settled && s.rows.len() == 3)
    });
    let st = picker(&mut v).unwrap();
    let row = |name: &str| st.details.iter().position(|d| d.starts_with(name)).unwrap();
    // å / ä / ö before the match: the caret still lands on it (a byte column)
    for _ in 0..row("u.ts") {
        v.key("arrow_down");
    }
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    wait_file(&mut v, "u.ts");
    let want = "const åäö = 'ä'; // ".len() as i64;
    assert_eq!(cursor(&v), (1, want));
    // a line over 500 chars (cut in the list): the caret on the match
    v.key("super+shift+f");
    type_text(&mut v, "needle");
    wait_picker(&mut v, "results", |s| {
        s.as_ref().is_some_and(|s| s.settled && s.rows.len() == 3)
    });
    let st = picker(&mut v).unwrap();
    let long_row = st
        .details
        .iter()
        .position(|d| d.starts_with("long.txt"))
        .unwrap();
    for _ in 0..long_row {
        v.key("arrow_down");
    }
    v.key("enter");
    wait_file(&mut v, "long.txt");
    assert_eq!(cursor(&v), (1, 600));
    // snacks' Alt+H: hidden files too
    v.key("super+shift+f");
    type_text(&mut v, "needle");
    wait_picker(&mut v, "results", |s| s.as_ref().is_some_and(|s| s.settled));
    v.key("alt+h");
    wait_picker(&mut v, "hidden files searched", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && s.details.iter().any(|d| d.starts_with(".hidden.ts")))
    });
    assert_eq!(
        picker(&mut v).unwrap().query,
        "needle",
        "Alt+H typed nothing"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // Find in Folder: only that dir
    v.lua(&format!(
        "Snacks.picker.grep({{ dirs = {{ '{root}/sub' }} }}) return true"
    ));
    wait_picker(&mut v, "Find in Folder", is("grep"));
    type_text(&mut v, "needle");
    wait_picker(&mut v, "results in sub/ only", |s| {
        s.as_ref().is_some_and(|s| s.settled && !s.rows.is_empty())
    });
    assert_eq!(picker(&mut v).unwrap().details, ["in.ts 1"]);
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // LSP positions (UTF-16) become byte columns
    v.lua(&format!(
        "require('config.app.pickers').open_file('{root}/u.ts', 1, 14, 'edit', 'utf-16') return true"
    ));
    v.wait_lua(
        "caret on 'ä' after the UTF-16 conversion",
        "return vim.api.nvim_win_get_cursor(0)[2] == #\"const åäö = '\"",
    );
}

#[test]
fn find_preview_scrolls_and_follows_file_changes() {
    let text: String = (1..=80).map(|i| format!("line {i}\n")).collect();
    let (dir, root) = temp_project(&[("a.txt", &text)]);
    let mut v = View::start(&root, &["a.txt"]);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    type_text(&mut v, "line 40");
    wait_picker(&mut v, "preview shown", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && !s.preview_lines.is_empty())
    });
    let first = picker(&mut v).unwrap().preview_lines;
    assert!(first.contains(&"line 40".to_string()), "{first:?}");
    v.key("ctrl+f");
    wait_picker(&mut v, "Ctrl+F scrolls the preview down", |s| {
        s.as_ref()
            .is_some_and(|s| s.preview_lines.first() != first.first())
    });
    let down = picker(&mut v).unwrap().preview_lines;
    assert!(
        down[0] > first[0] || down[0].len() > first[0].len(),
        "{down:?}"
    );
    v.key("ctrl+b");
    wait_picker(&mut v, "Ctrl+B back", |s| {
        s.as_ref()
            .is_some_and(|s| s.preview_lines.first() == first.first())
    });
    // the file changes on disk: the preview shows the new text
    let changed = text.replace("line 41\n", "line 41 changed\n");
    std::fs::write(dir.path().join("a.txt"), changed).unwrap();
    // (a later mtime even on fast file systems)
    let later = std::time::SystemTime::now() + Duration::from_secs(2);
    let f = std::fs::File::options()
        .write(true)
        .open(dir.path().join("a.txt"))
        .unwrap();
    f.set_modified(later).unwrap();
    v.key("ctrl+n");
    v.key("ctrl+p");
    wait_picker(&mut v, "the preview reread the file", |s| {
        s.as_ref()
            .is_some_and(|s| s.preview_lines.contains(&"line 41 changed".to_string()))
    });
}

#[test]
fn snacks_list_keys_multi_select_quickfix_history_and_buffers() {
    let mut v = View::start("proj", &["a.ts"]);
    // Find in Files: Tab selects two, Enter opens both
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    type_text(&mut v, "export const");
    wait_picker(&mut v, "results", |s| {
        s.as_ref().is_some_and(|s| s.settled && s.rows.len() >= 3)
    });
    let st = picker(&mut v).unwrap();
    v.key("tab");
    v.key("tab");
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    let second = st.details[1].rsplit_once(' ').unwrap().0.to_string();
    let first = st.details[0].rsplit_once(' ').unwrap().0.to_string();
    wait_file(&mut v, &second);
    assert_eq!(
        v.lua(&format!(
            "return vim.fn.buflisted(vim.fn.bufnr('{first}')) == 1"
        ))
        .as_bool(),
        Some(true),
        "both opened"
    );
    // Ctrl+Up: the last confirmed query back; Ctrl+Q: every result into the quickfix list
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    v.key("ctrl+arrow_up");
    wait_picker(&mut v, "history", |s| query(s) == "export const");
    wait_picker(&mut v, "results", |s| s.as_ref().is_some_and(|s| s.settled));
    let n = picker(&mut v).unwrap().rows.len() as i64;
    v.key("ctrl+q");
    wait_picker(&mut v, "closed", closed);
    v.wait_lua(
        "quickfix list filled",
        &format!("return #vim.fn.getqflist() == {n}"),
    );
    v.lua("vim.cmd('cclose') return true");
    v.focus_code();

    // Open Files: Ctrl+X closes the buffer, its row goes
    edit(&mut v, "b.ts");
    edit(&mut v, "a.ts");
    v.lua("Snacks.picker.buffers() return true");
    wait_picker(&mut v, "Open Files", |s| {
        is("buffers")(s) && s.as_ref().unwrap().settled && !s.as_ref().unwrap().rows.is_empty()
    });
    let rows = picker(&mut v).unwrap().rows;
    let gone = rows[0].clone();
    v.key("ctrl+x");
    wait_picker(&mut v, "row removed", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && !s.rows.contains(&gone))
    });
    v.wait_lua(
        "buffer deleted",
        &format!("return vim.fn.buflisted(vim.fn.bufnr('{gone}')) == 0"),
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // Shift+Enter with one split: opens it there (snacks' window picker picks the only one)
    v.key("super+o");
    type_text(&mut v, "menu");
    wait_picker(&mut v, "menu", |s| {
        query(s) == "menu" && s.as_ref().unwrap().settled
    });
    v.key("shift+enter");
    wait_picker(&mut v, "closed", closed);
    wait_file(&mut v, "menu.txt");

    // the shortcut again closes its picker
    v.key("super+o");
    wait_picker(&mut v, "open", is("files"));
    v.key("super+o");
    wait_picker(&mut v, "Cmd+O again closes it", closed);
    v.key("super+shift+f");
    wait_picker(&mut v, "open", is("grep"));
    v.key("super+shift+f");
    wait_picker(&mut v, "Cmd+Shift+F again closes it", closed);
}

#[test]
fn switcher_scrolls_and_esc_goes_back_where_it_came_from() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua("for i = 1, 40 do vim.cmd('badd many' .. i .. '.ts') end return true");
    v.lua("require('config.switcher').open({ wait = false }) return true");
    wait_picker(&mut v, "open", is("switcher"));
    for _ in 0..30 {
        v.key("ö");
    }
    wait_picker(&mut v, "moved past row 25", |s| {
        s.as_ref().is_some_and(|s| s.cursor.unwrap_or(0) > 25)
    });
    let sel = picker(&mut v).unwrap().cursor.unwrap();
    v.pump();
    assert!(
        v.cx.debug_bounds(Box::leak(format!("switcher-file-{sel}").into_boxed_str()))
            .is_some(),
        "the selection scrolled into view"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    v.lua("require('config.switcher').open({ wait = false, back = true }) return true");
    wait_picker(&mut v, "back: the last file", |s| {
        s.as_ref()
            .is_some_and(|s| s.cursor == Some(s.rows.len() - 1))
    });
    let sel = picker(&mut v).unwrap().cursor.unwrap();
    v.pump();
    assert!(
        v.cx.debug_bounds(Box::leak(format!("switcher-file-{sel}").into_boxed_str()))
            .is_some()
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // from the tree: Esc gives the keyboard back to the tree
    v.key("super+1");
    v.wait_lua(
        "tree focused",
        "return require('config.focus').target() == 'tree'",
    );
    v.key("super+o");
    wait_picker(&mut v, "Go to File from the tree", is("files"));
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    v.wait_lua(
        "back in the tree",
        "return require('config.focus').target() == 'tree'",
    );
    v.focus_code();
    v.wait_lua(
        "editor",
        "return require('config.focus').target() == 'split'",
    );

    // `,fr`: every recent file, also outside the project (snacks' recent without filter.cwd)
    let outside = tempfile::NamedTempFile::new().unwrap();
    let path = outside.path().canonicalize().unwrap().display().to_string();
    v.lua(&format!(
        "vim.v.oldfiles = {{ '{path}' }} Snacks.picker.recent() return true"
    ));
    wait_picker(&mut v, "Recent Files lists it", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && s.rows.iter().any(|r| path.ends_with(r.as_str())))
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

#[test]
fn go_to_file_lists_folders_and_enter_reveals_them_in_the_tree() {
    let (_dir, root) = temp_project(&[
        ("a.ts", "export const a = 1;\n"),
        ("store.ts", "x\n"),
        ("src/store/index.ts", "x\n"),
        ("src/app/store.ts", "x\n"),
        ("node_modules/store/index.js", "x\n"),
        (".gitignore", "node_modules\n"),
    ]);
    let mut v = View::start(&root, &["a.ts"]);
    // a folder is a row (name, its parent dimmed); files of the same name first; ignored
    // folders left out like their files
    v.key("super+o");
    type_text(&mut v, "store");
    wait_picker(&mut v, "store matched", |s| {
        query(s) == "store" && s.as_ref().unwrap().settled
    });
    let st = picker(&mut v).unwrap();
    let folder = st
        .rows
        .iter()
        .zip(&st.details)
        .position(|(r, d)| r == "store" && d == "src")
        .unwrap_or_else(|| panic!("src/store listed: {st:#?}"));
    assert_eq!(st.rows[0], "store.ts", "{st:#?}");
    assert!(folder > 0, "{st:#?}");
    assert!(
        !st.details.iter().any(|d| d.starts_with("node_modules")),
        "{st:#?}"
    );
    // `name/`: the folder first
    type_text(&mut v, "/");
    wait_picker(&mut v, "store/ matched", |s| {
        query(s) == "store/" && s.as_ref().unwrap().settled
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(
        (st.rows[0].as_str(), st.details[0].as_str()),
        ("store", "src"),
        "{st:#?}"
    );
    // Enter: the folder selected in the Project tree, which has the keyboard
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    v.wait_until("src/store selected in the tree", |v| {
        v.read_ws(|ws, cx| ws.tree().read(cx).cursor()).as_deref() == Some("src/store")
    });
    v.wait_lua(
        "the tree has the keyboard",
        "return require('config.focus').target() == 'tree'",
    );
    assert_eq!(file(&v), "a.ts", "nothing opened");
}

// WebStorm's New UI metrics ---------------------------------------------------------------------

fn px(n: f32) -> gpui_kit::Pixels {
    gpui_kit::px(n)
}

#[test]
fn search_everywhere_new_ui_header_field_toolbar_and_status_colors() {
    let mut v = View::start("proj", &["a.ts"]);
    // the tree's git status is read (proj has no commit: every file untracked)
    v.wait_until("tree git status read", |v| {
        v.read_ws(|ws, cx| ws.tree().read(cx).git() != &vimstorm::git::GitStatus::default())
    });
    v.key("super+o");
    wait_picker(&mut v, "Go to File settled", |s| {
        is("files")(s) && s.as_ref().unwrap().settled && !s.as_ref().unwrap().rows.is_empty()
    });
    // header: 2 top inset + 36 tabs (the line under it apart); field row 28, magnifier at 12+2
    let header = bounds(&mut v, "se-header").expect("header");
    assert_eq!(header.size.height, px(38.), "{header:?}");
    let row = bounds(&mut v, "se-field-row").expect("field row");
    assert_eq!(row.size.height, px(28.));
    assert_eq!(
        row.top(),
        header.bottom() + px(1.),
        "the line under the header"
    );
    let field = bounds(&mut v, "text-field").expect("field");
    assert_eq!(
        field.left() - row.left(),
        px(12.),
        "field border insets 0,12"
    );
    // the list starts right under the field's line (no top pad)
    let first = bounds(&mut v, "search-row-0").expect("first row");
    assert_eq!(first.top(), row.bottom() + px(1.));
    // file names in their git status color
    let st = picker(&mut v).unwrap();
    let a = st
        .rows
        .iter()
        .position(|r| r == "a.ts")
        .expect("a.ts listed");
    assert_eq!(st.statuses[a], "Unversioned", "{st:#?}");
    assert!(!st.checked && !st.preview);

    // "Include non-project items": ignored files too
    type_text(&mut v, "index.js");
    wait_picker(&mut v, "index.js typed", |s| {
        query(s) == "index.js" && s.as_ref().unwrap().settled
    });
    assert!(
        !picker(&mut v)
            .unwrap()
            .details
            .iter()
            .any(|d| d.contains("node_modules")),
        "ignored files left out"
    );
    let check = bounds(&mut v, "se-non-project").expect("checkbox");
    v.click(MouseButton::Left, check.center());
    wait_picker(&mut v, "node_modules listed", |s| {
        s.as_ref().is_some_and(|s| {
            s.checked && s.settled && s.details.iter().any(|d| d.contains("node_modules"))
        })
    });
    // the preview toggle: the list a third, the preview the rest (at least 10 lines)
    let toggle = bounds(&mut v, "se-preview-toggle").expect("preview toggle");
    v.click(MouseButton::Left, toggle.center());
    wait_picker(&mut v, "preview shown", |s| {
        s.as_ref()
            .is_some_and(|s| s.preview && !s.preview_lines.is_empty())
    });
    let list = bounds(&mut v, "se-list").expect("list");
    let preview = bounds(&mut v, "se-preview").expect("preview");
    assert!(
        preview.size.height > list.size.height * 1.5,
        "{list:?} {preview:?}"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);

    // Symbols, nothing typed, nothing found (no language server for .txt): header + field only
    // (WS ViewType.SHORT)
    drop(v);
    let (_dir, root) = temp_project(&[("notes.txt", "notes\n")]);
    let mut v = View::start(&root, &["notes.txt"]);
    shift_shift(&mut v);
    wait_picker(&mut v, "All", is("all"));
    v.key("shift+tab");
    wait_picker(&mut v, "Symbols", |s| {
        is("symbols")(s) && s.as_ref().unwrap().settled
    });
    v.pump();
    let st = picker(&mut v);
    assert!(bounds(&mut v, "se-list").is_none(), "no list area: {st:#?}");
    let frame = bounds(&mut v, "search-everywhere").unwrap();
    assert!(
        frame.size.height <= px(38. + 1. + 28. + 1. + 2.),
        "header + field: {frame:?}"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

#[test]
fn find_in_files_new_ui_scopes_mask_remembered_toggles_and_preview_marks() {
    let (_dir, root) = temp_project(&[
        (
            "three.ts",
            "let needle = 1;\nneedle();\nconst x = needle + needle;\n",
        ),
        ("sub/n.txt", "needle in sub\n"),
    ]);
    let mut v = View::start(&root, &["three.ts"]);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    // WS FindModel: regex off; In Project; the Directory scope offers the current file's folder
    let st = picker(&mut v).unwrap();
    assert_eq!(st.right, "In Project", "{st:#?}");
    let header = bounds(&mut v, "find-header").expect("header");
    assert_eq!(header.size.height, px(34.));
    let row = bounds(&mut v, "find-field-row").expect("field row");
    assert_eq!(row.size.height, px(28.));
    assert!(bounds(&mut v, "find-scope-Directory").is_some());
    type_text(&mut v, "needle");
    wait_picker(&mut v, "results", |s| {
        s.as_ref().is_some_and(|s| s.settled && s.rows.len() == 4)
    });
    // the preview marks every match in view: three.ts has 4 on 3 lines
    let st = picker(&mut v).unwrap();
    let three = st
        .details
        .iter()
        .position(|d| d.starts_with("three.ts"))
        .unwrap();
    for _ in 0..three {
        v.key("arrow_down");
    }
    wait_picker(&mut v, "all of three.ts's matches marked", |s| {
        s.as_ref().is_some_and(|s| s.preview_marks == 4)
    });
    // the file mask: only *.txt
    let check = bounds(&mut v, "find-mask-check").expect("mask checkbox");
    v.click(MouseButton::Left, check.center());
    type_text(&mut v, "n.txt");
    wait_picker(&mut v, "only the txt match", |s| {
        s.as_ref()
            .is_some_and(|s| s.settled && s.right.contains("mask") && s.details == ["n.txt 1"])
    });
    v.click(MouseButton::Left, check.center());
    wait_picker(&mut v, "mask off: all four", |s| {
        s.as_ref().is_some_and(|s| s.settled && s.rows.len() == 4)
    });
    // Alt+X: regex on; it stays for the next Find in Files of the session
    v.key("alt+x");
    wait_picker(&mut v, "regex", |s| {
        s.as_ref().is_some_and(|s| s.right.contains("regex"))
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    v.key("super+shift+f");
    wait_picker(&mut v, "reopened with regex on", |s| {
        is("grep")(s) && s.as_ref().unwrap().right.contains("regex")
    });
    // Directory scope: the current file's folder (the project root here)
    let dir = bounds(&mut v, "find-scope-Directory").unwrap();
    v.click(MouseButton::Left, dir.center());
    wait_picker(&mut v, "Directory", |s| {
        s.as_ref().is_some_and(|s| s.right.starts_with("Directory"))
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    // Find in Folder opens on the Directory scope
    v.lua(&format!(
        "Snacks.picker.grep({{ dirs = {{ '{root}/sub' }} }}) return true"
    ));
    wait_picker(&mut v, "Find in Folder: Directory sub", |s| {
        s.as_ref()
            .is_some_and(|s| s.right.starts_with("Directory sub"))
    });
    let project = bounds(&mut v, "find-scope-In Project").unwrap();
    v.click(MouseButton::Left, project.center());
    wait_picker(&mut v, "In Project", |s| {
        s.as_ref()
            .is_some_and(|s| s.right.starts_with("In Project"))
    });
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

#[test]
fn picker_history_is_kept_on_disk() {
    let mut v = View::start("proj", &["a.ts"]);
    // an earlier session's query (any project's nvim writes the same file)
    v.lua(
        "local f = vim.fn.stdpath('state') .. '/picker-history.json' \
         vim.fn.mkdir(vim.fs.dirname(f), 'p') \
         vim.fn.writefile({ vim.json.encode({ grep = { 'from disk' } }) }, f) return true",
    );
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", is("grep"));
    v.key("ctrl+arrow_up");
    wait_picker(&mut v, "the query from disk", |s| query(s) == "from disk");
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
    // a confirmed query is written back
    v.key("super+o");
    type_text(&mut v, "menu");
    wait_picker(&mut v, "menu", |s| {
        query(s) == "menu" && s.as_ref().unwrap().settled && !s.as_ref().unwrap().rows.is_empty()
    });
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    v.wait_lua(
        "written to disk",
        "local f = vim.fn.stdpath('state') .. '/picker-history.json' \
         local ok, h = pcall(vim.json.decode, table.concat(vim.fn.readfile(f), '')) \
         return ok and h.files and h.files[#h.files] == 'menu' and h.grep[1] == 'from disk'",
    );
}

#[test]
fn recent_files_is_the_switcher_with_show_edited_only() {
    // its own project: b.ts gets edited (and saved)
    let (_dir, root) = temp_project(&[
        ("a.ts", "a\n"),
        ("b.ts", "b\n"),
        ("c.ts", "c\n"),
        ("menu.txt", "m\n"),
    ]);
    let mut v = View::start(&root, &["a.ts"]);
    edit(&mut v, "b.ts");
    v.lua("vim.api.nvim_buf_set_lines(0, 0, 0, false, { '// x' }) return true");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");
    v.lua("vim.v.oldfiles = { vim.fn.getcwd() .. '/menu.txt' } Snacks.picker.recent() return true");
    wait_picker(&mut v, "Recent Files", is("recent"));
    let st = picker(&mut v).unwrap();
    assert_eq!(st.rows, ["a.ts", "c.ts", "b.ts", "menu.txt"], "{st:#?}");
    assert_eq!(
        (st.title.as_str(), st.cursor, st.checked),
        ("files", Some(1), false),
        "the previous file selected"
    );
    // WS's Switcher size: at least 500 x 350
    let frame = bounds(&mut v, "switcher").expect("drawn");
    assert!(
        frame.size.width >= px(500.) && frame.size.height >= px(350.),
        "{frame:?}"
    );
    assert!(bounds(&mut v, "switcher-edited-only").is_some());
    // ⌘E: "Show edited only"
    v.key("super+e");
    wait_picker(&mut v, "edited only", |s| {
        s.as_ref().is_some_and(|s| s.checked && s.rows == ["b.ts"])
    });
    let check = bounds(&mut v, "switcher-edited-only").unwrap();
    v.click(MouseButton::Left, check.center());
    wait_picker(&mut v, "all again", |s| {
        s.as_ref().is_some_and(|s| !s.checked && s.rows.len() == 4)
    });
    // `/` searches: typing filters the files
    type_text(&mut v, "/me");
    wait_picker(&mut v, "filtered", |s| {
        s.as_ref()
            .is_some_and(|s| s.query == "me" && s.rows == ["menu.txt"])
    });
    v.key("enter");
    wait_picker(&mut v, "opened", closed);
    wait_file(&mut v, "menu.txt");
}

#[test]
fn switcher_is_centred_at_least_500_by_350_and_draws_at_most_25_rows() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua("for i = 1, 40 do vim.cmd('badd many' .. i .. '.ts') end return true");
    open_switcher(&mut v);
    let frame = bounds(&mut v, "switcher").unwrap();
    let viewport = v.cx.update(|window, _| window.viewport_size());
    // centred (showCenteredInCurrentWindow), at least 500 x 350
    let mid = frame.top() + frame.size.height / 2.;
    assert!((mid - viewport.height / 2.).abs() <= px(1.), "{frame:?}");
    assert!(frame.size.width >= px(500.) && frame.size.height >= px(350.));
    // 40 files listed, 25 rows drawn and the popup 25 rows high
    let st = picker(&mut v).unwrap();
    assert!(st.rows.len() > 25, "{} files listed", st.rows.len());
    for i in 0..25 {
        assert!(
            bounds(&mut v, &format!("switcher-file-{i}")).is_some(),
            "row {i} drawn"
        );
    }
    assert!(
        bounds(&mut v, "switcher-file-25").is_none(),
        "the 26th file isn't drawn (scrolls)"
    );
    let first = bounds(&mut v, "switcher-file-0").unwrap();
    let last = bounds(&mut v, "switcher-file-24").unwrap();
    assert!(
        last.bottom() <= frame.bottom(),
        "row 25 inside the popup: {last:?} in {frame:?}"
    );
    assert_eq!(
        last.bottom() - first.top(),
        first.size.height * 25.,
        "25 rows high"
    );
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

/// References that include the caret's usage: it gets the "Current" tag.
const LSP_STUB_CURRENT: &str = r#"
  local root = vim.fn.getcwd()
  local function loc(f, l, c, e) return { uri = vim.uri_from_fname(root .. '/' .. f), range = { start = { line = l, character = c }, ['end'] = { line = l, character = e } } } end
  local refs = { loc('a.ts', 2, 16, 19), loc('b.ts', 0, 13, 14) }
  local fake = { id = 4243, name = 'stub', offset_encoding = 'utf-16' }
  local get_clients, by_id = vim.lsp.get_clients, vim.lsp.get_client_by_id
  vim.lsp.get_clients = function(o)
    if o and o.method == 'textDocument/references' then return { fake } end
    return get_clients(o)
  end
  vim.lsp.get_client_by_id = function(id) if id == 4243 then return fake end return by_id(id) end
  vim.lsp.buf_request_all = function(_, method, _, cb)
    vim.schedule(function() cb({ [4243] = { result = vim.deepcopy(refs) } }) end)
  end
  return true
"#;

#[test]
fn usages_complex_header_and_current_tag() {
    let mut v = View::start("proj", &["a.ts"]);
    v.lua(LSP_STUB_CURRENT);
    v.lua(
        "vim.api.nvim_win_set_cursor(0, { 3, 17 }) require('config.usages').usages() return true",
    );
    wait_picker(&mut v, "Show Usages", is("usages"));
    let st = picker(&mut v).unwrap();
    assert!(st.rows[0].ends_with(" Current"), "{st:#?}");
    assert!(!st.rows[1].ends_with(" Current"));
    let header = bounds(&mut v, "usages-header").expect("header");
    assert_eq!(header.size.height, px(34.));
    v.key("escape");
    wait_picker(&mut v, "closed", closed);
}

/// The switcher and the pickers keep their frame while the selection moves.
#[test]
fn popups_stay_put_while_the_selection_moves() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "c.ts");
    edit(&mut v, "a.ts");

    // the switcher: Tab, Tab, Shift+Tab, ←, ↓, →
    open_switcher(&mut v);
    stays_put(
        &mut v,
        "switcher",
        "switcher",
        &[
            "tab",
            "tab",
            "shift+tab",
            "arrow_left",
            "arrow_down",
            "arrow_right",
        ],
    );
    v.key("escape");
    wait_picker(&mut v, "switcher closed", closed);

    // the pickers: ↓ ↓ ↑ once their results are in
    v.lua(
        "vim.v.oldfiles = vim.tbl_map(function(f) return vim.fn.getcwd() .. '/' .. f end, \
         { 'multi.txt', 'menu.txt', 'b.ts' }) return true",
    );
    for (name, open, kind, selector) in [
        (
            "Search Everywhere",
            "Snacks.picker.smart()",
            "all",
            "search-everywhere",
        ),
        (
            "Go to File",
            "Snacks.picker.files()",
            "files",
            "search-everywhere",
        ),
        (
            "Find in Files",
            "Snacks.picker.grep({ search = 'export' })",
            "grep",
            "find-in-files",
        ),
        (
            "Recent Projects",
            "Snacks.picker.projects()",
            "projects",
            "search-everywhere",
        ),
    ] {
        v.lua(&format!("{open} return true"));
        wait_picker(&mut v, &format!("{name} with results"), |s| {
            is(kind)(s) && s.as_ref().is_some_and(|s| s.settled && !s.rows.is_empty())
        });
        let rows = picker(&mut v).unwrap().rows.len();
        if rows > 1 {
            stays_put(
                &mut v,
                name,
                selector,
                &["arrow_down", "arrow_down", "arrow_up"],
            );
        } else {
            // one row (Recent Projects: only this project): nothing to move, the frame still
            // mustn't change on the keys
            v.settle();
            let frame = bounds(&mut v, selector).expect("drawn");
            for k in ["arrow_down", "arrow_down", "arrow_up"] {
                v.key(k);
                v.settle();
                assert_eq!(bounds(&mut v, selector), Some(frame), "{name} after {k}");
            }
        }
        v.key("escape");
        wait_picker(&mut v, &format!("{name} closed"), closed);
    }
}

/// From the terminal the switcher selects the last file; picking Terminal (its page) keeps typing
/// in it, Git (its page) opens in normal mode, and Ctrl+Tab there switches to a file.
#[test]
fn switcher_with_the_terminal_and_git() {
    let mut v = View::start_projects("proj", &["a.ts"]);
    edit(&mut v, "b.ts");
    edit(&mut v, "a.ts");
    open_terminal(&mut v);
    assert_eq!(target(&v), "terminal");

    // from the terminal the last file is selected (the first files row: no file is current)
    open_switcher(&mut v);
    let st = picker(&mut v).unwrap();
    assert_eq!(
        (st.title.as_str(), st.cursor),
        ("files", Some(0)),
        "switcher from the terminal: the last file selected: {st:#?}"
    );
    assert_eq!(st.rows.first().map(String::as_str), Some("a.ts"));

    // ← ↓ ↓ Enter: Terminal (⌃3, after Project · Chat); typing goes on in it
    v.key("arrow_left");
    for _ in 0..2 {
        v.key("arrow_down");
    }
    wait_picker(&mut v, "Terminal selected", |s| {
        s.as_ref()
            .is_some_and(|s| s.title == "tools" && s.cursor == Some(2))
    });
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    wait_typing(&mut v);
    v.wait_lua(
        "picking Terminal keeps typing in it",
        "return require('config.focus').target() == 'terminal'",
    );

    // ← ↓ ↓ ↓ Enter: Git (⌃4), in normal mode
    open_switcher(&mut v);
    v.key("arrow_left");
    for _ in 0..3 {
        v.key("arrow_down");
    }
    wait_picker(&mut v, "Git selected", |s| {
        s.as_ref()
            .is_some_and(|s| s.title == "tools" && s.cursor == Some(3))
    });
    v.key("enter");
    wait_picker(&mut v, "closed", closed);
    v.wait_until("Git opens with the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus()) == Some("git")
    });
    v.wait_lua(
        "focus.target() is git",
        "return require('config.focus').target() == 'git'",
    );
    assert_eq!(v.mode(), "n", "Git opens in normal mode");
    assert!(!typing(&mut v), "not typing in the terminal");

    // Cmd+T back to the terminal, Ctrl+Tab there: a file
    v.keystrokes("cmd-t");
    wait_typing(&mut v);
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    v.modifiers(NONE);
    wait_picker(&mut v, "Ctrl released: closed", closed);
    v.wait_lua(
        "Ctrl+Tab in the terminal switches to a file",
        "return require('config.focus').target() == 'split' and vim.fn.expand('%:t') ~= ''",
    );
}

/// A click on a Project tree row closes Go to File and Search Everywhere and gives the tree the
/// keyboard.
#[test]
fn a_tree_click_closes_pickers_and_focuses_the_tree() {
    let mut v = View::start("proj", &["a.ts"]);
    v.focus_code();
    wait_target(&mut v, "split");
    for (open, kind) in [("super+o", "files"), ("Snacks.picker.smart()", "all")] {
        if open.starts_with("super") {
            v.key(open);
        } else {
            v.lua(&format!("{open} return true"));
        }
        wait_picker(&mut v, kind, is(kind));
        v.pump();
        // a folder: never a row of the popup
        let at = row_point(&mut v, "emptydir", 4.);
        let popup = v.cx.debug_bounds("search-everywhere").expect("popup drawn");
        assert!(!popup.contains(&at), "the tree row is beside the popup");
        v.click(MouseButton::Left, at);
        wait_picker(&mut v, &format!("{kind}: a tree click closes it"), closed);
        wait_target(&mut v, "tree");
        v.focus_code();
        wait_target(&mut v, "split");
    }
}

/// The switcher's keys work with Ctrl still held from Ctrl+Tab.
#[test]
fn switcher_keys_work_with_ctrl_still_held() {
    let mut v = View::start("proj", &["a.ts"]);
    for f in ["b.ts", "c.ts", "a.ts"] {
        v.lua(&format!("vim.cmd.edit('{f}') return true"));
        v.wait_lua(
            &format!("{f} open"),
            &format!("return vim.fn.expand('%:t') == '{f}'"),
        );
    }
    let state = |v: &mut View| {
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| (s.title, s.cursor)))
    };
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    wait_picker(&mut v, "switcher open", is("switcher"));
    assert_eq!(state(&mut v), Some(("files".into(), Some(1))));
    let rows = v
        .read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| s.rows))
        .unwrap();
    assert!(rows.len() >= 3, "{rows:?}");
    // Ctrl+← / Ctrl+→: the tool windows / files column (Ctrl still down from Ctrl+Tab)
    v.key("ctrl+arrow_left");
    v.wait_until("tool windows column", |v| {
        state(v).is_some_and(|(col, _)| col == "tools")
    });
    v.key("ctrl+arrow_right");
    v.wait_until("files column", |v| {
        state(v).is_some_and(|(col, _)| col == "files")
    });
    // Ctrl+↓ moves, Ctrl+Enter opens the selection (Ctrl still held)
    v.key("ctrl+arrow_down");
    v.wait_until("moved down", |v| {
        state(v).is_some_and(|(_, cur)| cur == Some(2))
    });
    v.key("ctrl+enter");
    wait_picker(&mut v, "switcher closed", closed);
    v.wait_lua(
        &format!("{} opened", rows[2]),
        &format!("return vim.fn.expand('%:t') == '{}'", rows[2]),
    );
    v.modifiers(Modifiers::default());
}

/// The project scope (`src/search/scope.rs`) on the real app: a folder excluded in WebStorm's `.iml`
/// but not gitignored (`dist/`) and `node_modules` are left out of Go to File (files and the
/// folder itself), Find in Files and the tree's speed search, still shown (tinted) in the tree,
/// and back with Alt+I (include ignored); an edit of the `.iml` is picked up by all of them.
mod scope {
    use super::common;

    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use common::TIMEOUT;
    use common::view::View;
    use vimstorm::search::PickerState;

    const IML_DIST: &str = "<module type=\"WEB_MODULE\" version=\"4\">\n  <component name=\"NewModuleRootManager\">\n    <content url=\"file://$MODULE_DIR$\">\n      <excludeFolder url=\"file://$MODULE_DIR$/dist\" />\n    </content>\n  </component>\n</module>\n";

    /// A git project: `dist/` excluded in the `.iml` only, `out/` not excluded (yet), a gitignored
    /// log and an un-ignored `node_modules`.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::Builder::new()
            .prefix("vimstorm-scope-")
            .tempdir()
            .unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        for (f, t) in [
            (".gitignore", "*.log\n"),
            ("src/app.ts", "export const needle = 1;\n"),
            ("dist/bundle.js", "needle\n"),
            ("out/gen.js", "needle\n"),
            ("node_modules/pkg/dep.js", "needle\n"),
            ("debug.log", "needle\n"),
            (".idea/web.iml", IML_DIST),
        ] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, t).unwrap();
        }
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        (tmp, dir)
    }

    fn picker(v: &mut View) -> Option<PickerState> {
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
    }

    fn wait_picker(v: &mut View, label: &str, pred: impl Fn(&PickerState) -> bool) -> PickerState {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let st = picker(v);
            if let Some(s) = &st
                && pred(s)
            {
                return s.clone();
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for: {label}\n--- picker ---\n{st:#?}");
            }
            v.wait_lua("nvim idle", "return true");
        }
    }

    fn close(v: &mut View) {
        v.key("escape");
        v.wait_until("picker closed", |v| picker(v).is_none());
    }

    fn type_text(v: &mut View, text: &str) {
        for c in text.chars() {
            // Swedish layout: `/` is Shift+7
            let t = if c == '/' {
                "shift+digit_7".to_string()
            } else {
                c.to_string()
            };
            v.key(&t);
        }
    }

    /// Go to File rows as `parent/name` (folders: just their name here, the fixture has no files
    /// without an extension).
    fn files(s: &PickerState) -> Vec<String> {
        s.rows
            .iter()
            .zip(&s.details)
            .map(|(r, d)| {
                if d.is_empty() {
                    r.clone()
                } else {
                    format!("{d}/{r}")
                }
            })
            .collect()
    }

    fn has(rows: &[String], name: &str) -> bool {
        rows.iter()
            .any(|r| r == name || r.ends_with(&format!("/{name}")))
    }

    /// Go to File (Cmd+O) on an empty query, once the walk is in and `pred` holds on its rows.
    fn go_to_file(v: &mut View, label: &str, pred: impl Fn(&[String]) -> bool) -> Vec<String> {
        v.key("super+o");
        let st = wait_picker(v, label, |s| {
            s.kind == "files" && s.settled && pred(&files(s))
        });
        files(&st)
    }

    /// Find in Files (Cmd+Shift+F) for `needle`: the matched files' names, once `pred` holds.
    fn find(v: &mut View, label: &str, pred: impl Fn(&[String]) -> bool) -> Vec<String> {
        v.key("super+shift+f");
        wait_picker(v, "Find in Files", |s| s.kind == "grep");
        type_text(v, "needle");
        find_wait(v, label, pred)
    }

    fn find_wait(v: &mut View, label: &str, pred: impl Fn(&[String]) -> bool) -> Vec<String> {
        let names = |s: &PickerState| -> Vec<String> {
            s.details
                .iter()
                .map(|d| d.rsplit_once(' ').map_or(d.as_str(), |x| x.0).to_owned())
                .collect()
        };
        let st = wait_picker(v, label, |s| {
            s.query == "needle" && s.settled && !s.rows.is_empty() && pred(&names(s))
        });
        names(&st)
    }

    fn tree_row(v: &mut View, rel: &str) -> Option<vimstorm::shell::tree::Row> {
        let t = v.read_ws(|ws, _| ws.tree().clone());
        v.pump();
        t.read_with(&v.cx, |t, _| {
            t.row_index(rel).map(|ix| t.rows()[ix].clone())
        })
    }

    /// Advances the clock past the tree's poll until `pred` holds.
    fn wait_poll(v: &mut View, label: &str, mut pred: impl FnMut(&mut View) -> bool) {
        for _ in 0..60 {
            v.advance(Duration::from_millis(600));
            if pred(v) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for: {label}");
    }

    fn start(dir: &Path) -> View {
        let mut v = View::start(dir.to_str().unwrap(), &[]);
        v.wait_until("tree lists dist", |v| tree_row(v, "dist").is_some());
        v
    }

    #[test]
    fn iml_excluded_folder_is_out_of_every_search_but_shown_in_the_tree() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);

        // the tree shows it, tinted (excluded) like node_modules
        assert!(tree_row(&mut v, "dist").unwrap().excluded);
        assert!(tree_row(&mut v, "node_modules").unwrap().excluded);
        assert!(!tree_row(&mut v, "out").unwrap().excluded);

        // Go to File: neither its files nor the folder itself
        let rows = go_to_file(&mut v, "Go to File", |r| has(r, "gen.js"));
        assert!(has(&rows, "app.ts"), "{rows:?}");
        for gone in ["bundle.js", "dep.js", "debug.log"] {
            assert!(!has(&rows, gone), "{gone} left out: {rows:?}");
        }
        let index = v.read_ws(|ws, cx| ws.pickers().read(cx).index()).unwrap();
        assert!(index.iter().any(|p| p == "out/"), "{index:?}");
        assert!(
            !index
                .iter()
                .any(|p| p.starts_with("dist/") || p.starts_with("node_modules/")),
            "{index:?}"
        );
        // a folder query (`name/`, folders first) finds no dist folder row
        type_text(&mut v, "dist/");
        let st = wait_picker(&mut v, "dist/ matched", |s| s.query == "dist/" && s.settled);
        assert!(!has(&files(&st), "dist"), "{st:#?}");
        // Alt+I: ignored and excluded entries too
        v.key("alt+i");
        let st = wait_picker(&mut v, "Alt+I lists the dist folder", |s| {
            s.query == "dist/" && has(&files(s), "dist")
        });
        assert!(has(&files(&st), "bundle.js"), "{st:#?}");
        close(&mut v);
        v.key("super+o");
        wait_picker(&mut v, "Go to File", |s| s.kind == "files" && s.settled);
        v.key("alt+i");
        let st = wait_picker(&mut v, "Alt+I lists dist", |s| has(&files(s), "bundle.js"));
        let rows = files(&st);
        for back in ["dep.js", "debug.log"] {
            assert!(has(&rows, back), "{back} with Alt+I: {rows:?}");
        }
        close(&mut v);

        // Find in Files: not searched
        let names = find(&mut v, "Find in Files results", |n| {
            n.iter().any(|f| f == "gen.js")
        });
        assert!(names.iter().any(|f| f == "app.ts"), "{names:?}");
        for gone in ["bundle.js", "dep.js", "debug.log"] {
            assert!(!names.iter().any(|f| f == gone), "{gone}: {names:?}");
        }
        v.key("alt+i");
        let names = find_wait(&mut v, "Alt+I searches dist", |n| {
            n.iter().any(|f| f == "bundle.js")
        });
        assert!(
            names.iter().any(|f| f == "dep.js") && names.iter().any(|f| f == "debug.log"),
            "{names:?}"
        );
        close(&mut v);

        // the tree's speed search leaves it out too
        v.key("super+digit_1");
        v.wait_lua(
            "the tree has the keyboard",
            "return require('config.focus').target() == 'tree'",
        );
        v.key("shift+digit_7");
        type_text(&mut v, "js");
        let t = v.read_ws(|ws, _| ws.tree().clone());
        v.wait_until("tree results", |v| {
            t.read_with(&v.cx, |t, _| {
                t.results_query() == Some("js") && t.row_index("out/gen.js").is_some()
            })
        });
        let rows = t.read_with(&v.cx, |t, _| t.row_paths());
        assert!(
            !rows
                .iter()
                .any(|r| r.starts_with("dist") || r.starts_with("node_modules")),
            "{rows:?}"
        );
    }

    #[test]
    fn an_iml_edit_is_picked_up() {
        let (_tmp, dir) = project();
        let mut v = start(&dir);
        let rows = go_to_file(&mut v, "Go to File", |r| has(r, "gen.js"));
        assert!(!has(&rows, "bundle.js"), "{rows:?}");
        close(&mut v);
        let names = find(&mut v, "Find in Files", |n| n.iter().any(|f| f == "gen.js"));
        assert!(!names.iter().any(|f| f == "bundle.js"), "{names:?}");
        close(&mut v);
        // the tree has polled once: its next poll sees the edit
        v.advance(Duration::from_millis(600));
        v.pump();

        // WebStorm excludes out/ too (an in-place edit: `.idea`'s own mtime stays)
        std::fs::write(
            dir.join(".idea/web.iml"),
            IML_DIST.replace(
                "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />",
                "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />\n      <excludeFolder url=\"file://$MODULE_DIR$/out\" />",
            ),
        )
        .unwrap();
        wait_poll(&mut v, "the tree tints out/", |v| {
            tree_row(v, "out").is_some_and(|r| r.excluded)
        });
        let rows = go_to_file(&mut v, "Go to File without out/", |r| {
            !has(r, "gen.js") && has(r, "app.ts")
        });
        assert!(!has(&rows, "out"), "{rows:?}");
        close(&mut v);
        let names = find(&mut v, "Find in Files without out/", |n| {
            !n.iter().any(|f| f == "gen.js")
        });
        assert_eq!(names, ["app.ts"]);
    }
}
