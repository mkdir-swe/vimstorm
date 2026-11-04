//! The ⌘R replace bar (`src/editor/replace`, its engine `config/replace.lua`) on the real nvim and
//! config, driven with GPUI keys and mouse: the bar at the split's top right with the word at the
//! caret selected, typing (k / l / ö / ä too) into its fields, ⏎ next match or Replace, Tab between
//! the fields, ⌘⏎ Replace All, Esc back to the file, one undo per replace; the toggles, buttons and
//! right-click menu; a click elsewhere closing it; keys typed right after ⌘R landing in the bar.
//! The engine's own checks are in the Lua suite.
// GPUI records debug selectors (`debug_bounds`) only with debug assertions.
#![cfg(debug_assertions)]

use crate::common;

use std::time::Instant;

use common::TIMEOUT;
use common::gitui;
use common::view::View;
use gpui_kit::{Modifiers, MouseButton};
use vimstorm::editor::replace::Shown;

fn start() -> View {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_lua(
        "the split has focus",
        "return require('config.focus').target() == 'split'",
    );
    v
}

fn bar(v: &mut View) -> Option<Shown> {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|window, cx| ws.read(cx).replace().read(cx).shown(window, cx))
}

fn wait_bar(v: &mut View, label: &str, pred: impl Fn(&Option<Shown>) -> bool) -> Option<Shown> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let s = bar(v);
        if pred(&s) {
            return s;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for: {label}\n{s:#?}"
        );
        v.settle();
    }
}

fn wait_closed(v: &mut View, label: &str) {
    wait_bar(v, label, Option::is_none);
    v.wait_lua(label, "return require('config.replace').is_open() == false");
}

fn line(v: &View, n: usize) -> String {
    v.lua(&format!(
        "return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(require('config.focus').split_win()), {}, {n}, false)[1]",
        n - 1
    ))
    .as_str()
    .unwrap_or_default()
    .to_owned()
}

fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn at(v: &View, l: usize, c: usize) {
    v.lua(&format!(
        "vim.api.nvim_win_set_cursor(0, {{ {l}, {c} }}) return true"
    ));
}

/// Types text with real keys on his Swedish layout.
fn typ(v: &mut View, text: &str) {
    for c in text.chars() {
        let trigger = match c {
            ' ' => "space".to_owned(),
            c if c.is_ascii_uppercase() => format!("shift+{}", c.to_ascii_lowercase()),
            c => c.to_string(),
        };
        v.key(&trigger);
    }
}

fn center(v: &mut View, selector: &str) -> gpui_kit::Point<gpui_kit::Pixels> {
    gitui::bounds(v, selector)
        .unwrap_or_else(|| panic!("{selector} not drawn"))
        .center()
}

const L3: &str = "export function add(x: number, y: number) {";

#[test]
fn cmd_r_replaces_with_real_keys_and_esc_gives_the_file_back() {
    let mut v = start();
    // on the first "number"
    at(&v, 3, 24);
    v.key("super+r");
    let s = wait_bar(&mut v, "⌘R opens the bar", |s| {
        s.as_ref().is_some_and(|s| s.focused && s.count == "1/2")
    })
    .unwrap();
    assert_eq!(s.find, "number", "the word at the caret");
    assert_eq!(s.selection, 0..6, "selected: typing replaces it");
    assert!(!s.in_replace && !s.none);
    assert_eq!(target(&v), "popup", "the bar has the keyboard");
    assert!(
        v.lua("for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' then return false end end return true")
            .as_bool()
            == Some(true),
        "no nvim float"
    );
    // at the top right of the split's text area
    let b = gitui::bounds(&mut v, "replace-bar").expect("drawn");
    let win = v
        .lua("return require('config.focus').split_win()")
        .as_i64()
        .unwrap();
    let area = v
        .read_ws(|ws, _| ws.geometry().win_rect(win).map(|w| w.grid_area))
        .unwrap();
    assert!(
        (b.right() - area.right()).abs() < gpui_kit::px(1.),
        "{b:?} {area:?}"
    );
    assert!(
        (b.top() - area.top()).abs() < gpui_kit::px(1.),
        "{b:?} {area:?}"
    );

    // typing replaces the selection, his movement keys are text here
    typ(&mut v, "lö");
    wait_bar(&mut v, "k l ö ä type", |s| {
        s.as_ref()
            .is_some_and(|s| s.find == "lö" && s.count == "0 results" && s.none)
    });
    v.key("backspace");
    v.key("backspace");
    typ(&mut v, "y");
    wait_bar(&mut v, "live count", |s| {
        s.as_ref()
            .is_some_and(|s| s.find == "y" && s.count == "1/2")
    });
    v.key("enter");
    wait_bar(&mut v, "⏎ the next match", |s| {
        s.as_ref().is_some_and(|s| s.count == "2/2")
    });
    v.key("shift+enter");
    wait_bar(&mut v, "⇧⏎ the previous one", |s| {
        s.as_ref().is_some_and(|s| s.count == "1/2")
    });
    assert_eq!(line(&v, 3), L3, "the file untouched while searching");

    v.key("tab");
    wait_bar(&mut v, "Tab: the replacement field", |s| {
        s.as_ref().is_some_and(|s| s.in_replace && s.focused)
    });
    typ(&mut v, "zz");
    v.key("enter");
    v.wait_until("⏎ replaces the current match", |v| {
        line(v, 3) == "export function add(x: number, zz: number) {"
    });
    wait_bar(&mut v, "the next one current", |s| {
        s.as_ref()
            .is_some_and(|s| s.count == "1/1" && s.replace == "zz")
    });
    v.key("super+enter");
    v.wait_until("⌘⏎ replaces all", |v| line(v, 4) == "  return x + zz;");
    wait_bar(&mut v, "nothing left", |s| {
        s.as_ref().is_some_and(|s| s.count == "0 results" && s.none)
    });
    v.key("escape");
    wait_closed(&mut v, "Esc closes the bar");
    assert_eq!(target(&v), "split", "back in the file");
    v.wait_lua("normal mode", "return vim.api.nvim_get_mode().mode == 'n'");
    typ(&mut v, "u");
    v.wait_until("one undo reverts Replace All", |v| {
        line(v, 4) == "  return x + y;"
    });
    typ(&mut v, "u");
    v.wait_until("the next undo the single replace", |v| line(v, 3) == L3);
}

#[test]
fn toggles_buttons_menu_and_a_click_elsewhere() {
    let mut v = start();
    at(&v, 3, 24);
    v.key("super+r");
    wait_bar(&mut v, "open", |s| {
        s.as_ref().is_some_and(|s| s.focused && s.count == "1/2")
    });
    typ(&mut v, "Number");
    wait_bar(&mut v, "ignoring case", |s| {
        s.as_ref().is_some_and(|s| s.count == "1/2")
    });
    let cc = center(&mut v, "search-field-case");
    gitui::left(&mut v, cc);
    wait_bar(&mut v, "Cc matches case: nothing", |s| {
        s.as_ref()
            .is_some_and(|s| s.case && s.count == "0 results" && s.focused)
    });
    gitui::left(&mut v, cc);
    wait_bar(&mut v, "Cc off again", |s| {
        s.as_ref().is_some_and(|s| !s.case && s.count == "1/2")
    });
    let next = center(&mut v, "replace-next");
    gitui::left(&mut v, next);
    wait_bar(&mut v, "the next button", |s| {
        s.as_ref()
            .is_some_and(|s| s.count == "2/2" && s.focused && !s.in_replace)
    });
    // the replacement typed, then the Replace button
    v.key("tab");
    typ(&mut v, "int");
    let one = center(&mut v, "button-replace-one");
    gitui::left(&mut v, one);
    v.wait_until("Replace replaced the current match", |v| {
        line(v, 3) == "export function add(x: number, y: int) {"
    });
    // right-click: the same actions
    let b = center(&mut v, "replace-bar");
    gitui::press(&mut v, b, MouseButton::Right, Modifiers::default(), 1);
    v.wait_until("the bar's menu", |v| {
        gitui::menu_rows(v).is_some_and(|r| {
            r.iter().any(|l| l.contains("Replace All"))
                && r.iter().any(|l| l.contains("Match Case"))
        })
    });
    gitui::pick_menu(&mut v, "Replace All");
    v.wait_until("Replace All from the menu", |v| {
        line(v, 3) == "export function add(x: int, y: int) {"
    });
    wait_bar(&mut v, "the bar stays, its field has the keyboard", |s| {
        s.as_ref()
            .is_some_and(|s| s.focused && s.count == "0 results")
    });
    // a click in the tree: closed, the keyboard stays there
    v.key("super+1");
    v.wait_until("tree focused", |v| target(v) == "tree");
    wait_closed(&mut v, "the keyboard leaving the bar closes it");
}

#[test]
fn keys_typed_right_after_cmd_r_go_to_the_bar() {
    let mut v = start();
    at(&v, 4, 3);
    v.request("nvim_input", vec!["<D-r>ret<Tab>RET".into()]);
    let s = wait_bar(&mut v, "the keys went into the bar", |s| {
        s.as_ref()
            .is_some_and(|s| s.find == "ret" && s.replace == "RET")
    })
    .unwrap();
    assert!(s.in_replace && s.focused, "{s:?}");
    assert_eq!(line(&v, 4), "  return x + y;", "not into the file");
    assert_eq!(
        v.lua("return vim.fn.undotree().seq_last").as_i64(),
        Some(0),
        "no edits"
    );
    // ⌘R again: the search field
    v.key("super+r");
    wait_bar(&mut v, "⌘R in the bar: its search field", |s| {
        s.as_ref().is_some_and(|s| !s.in_replace && s.focused)
    });
    // Cmd keys that edit the code do nothing here
    for k in ["super+d", "super+shift+digit_7", "super+b"] {
        v.key(k);
        v.settle();
        assert!(bar(&mut v).is_some_and(|s| s.focused), "{k}: the bar stays");
        assert_eq!(line(&v, 4), "  return x + y;", "{k}: the file untouched");
    }
    v.key("escape");
    wait_closed(&mut v, "Esc");
}
