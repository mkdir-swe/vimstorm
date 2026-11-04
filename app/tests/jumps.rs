//! The jumps on the real window with real keys and a fake bridge: ⌃L goes to the bridge as
//! `jump {to, from}` from the Board, its Card page, the Chat column's Chat and the toolbar's line;
//! an nvim split keeps the plain keys (⌃W s splits, ⌃W and ⌃I are no jumps) and a terminal tab
//! too (⌃W deletes a word), where ⌃⌥L jumps; a layer the jump opens over the Editor (Linked, 48 px
//! from the window's top) takes the keyboard and Esc gives it back to the split.
#![cfg(debug_assertions)]

use std::path::{Path, PathBuf};

use gpui_kit::{Focusable as _, px};
use serde_json::{Value, json};
use vimstorm::factory::FactoryView;
use vimstorm::shell;

use crate::common::bridge::{fake_on, fixture, log};
use crate::common::terminal::{self, wait_prompt};
use crate::common::view::View;

/// A frame file in `dir` for the fake bridge to print.
pub(crate) fn frame(dir: &Path, name: &str, doc: Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, doc.to_string()).unwrap();
    path
}

/// A `layer` frame of a contract tree.
fn layer(dir: &Path, name: &str, tree: &str) -> PathBuf {
    let tree: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture(tree)).unwrap()).unwrap();
    frame(
        dir,
        name,
        json!({"v": 2, "type": "layer", "rev": 1, "tree": tree}),
    )
}

/// The projects window on `proj` with the fake bridge answering `on`, started as at launch.
pub(crate) fn window(dir: &Path, on: &[(&str, Vec<PathBuf>)]) -> View {
    let mut v = View::start_projects("proj", &["a.ts"]);
    // the header's feed too: the toolbar draws its context line
    let command = fake_on(
        dir,
        &[
            "frames/bridge-tree.json",
            "frames/bridge-shell-workspaces.json",
        ],
        on,
    );
    v.cx.update(|_, cx| cx.set_global(command));
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    v.wait_until("the bridge started", |_| {
        log(dir).iter().any(|l| l.contains(r#""type":"hello""#))
    });
    v.wait_lua("nvim started", crate::common::STARTED);
    v.focus_code();
    v
}

/// The jump frames the bridge got, as `to from.place from.view`.
pub(crate) fn jumps(dir: &Path) -> Vec<String> {
    log(dir)
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|f| f["type"] == "jump")
        .map(|f| {
            format!(
                "{} {} {}",
                f["to"].as_str().unwrap_or(""),
                f["from"]["place"].as_str().unwrap_or(""),
                f["from"]["view"].as_str().unwrap_or("")
            )
        })
        .collect()
}

pub(crate) fn wait_jumps(v: &mut View, dir: &Path, want: &[&str]) {
    v.wait_until(&format!("the jumps {want:?}"), |_| jumps(dir) == want);
}

pub(crate) fn factory(v: &View) -> gpui_kit::Entity<FactoryView> {
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap())
}

pub(crate) fn factory_has_keyboard(v: &mut View) -> bool {
    let f = factory(v);
    v.pump();
    v.cx.update(|window, cx| f.focus_handle(cx).is_focused(window))
}

pub(crate) fn nvim_has_keyboard(v: &mut View) -> bool {
    let editor = v.read_ws(|ws, _| ws.editor().clone());
    v.pump();
    v.cx.update(|window, cx| editor.focus_handle(cx).contains_focused(window, cx))
}

pub(crate) fn wins(v: &View) -> i64 {
    v.lua("return #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative == '' end, vim.api.nvim_tabpage_list_wins(0))")
        .as_i64()
        .unwrap_or(0)
}

#[test]
fn an_nvim_split_keeps_ctrl_w_i_l_and_ctrl_alt_l_jumps_from_it() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let mut v = window(dir, &[]);
    assert!(nvim_has_keyboard(&mut v));
    let before = wins(&v);
    // ⌃W s is Vim's split
    v.key("ctrl+w");
    v.key("s");
    v.wait_until("a split", |v| wins(v) == before + 1);
    // ⌃I jumps forward, ⌃L adds a caret above: nvim's, nothing to the bridge
    v.key("ctrl+i");
    v.key("ctrl+l");
    v.key("escape");
    v.settle();
    assert_eq!(jumps(dir), Vec::<String>::new());
    // ⌃⌥L jumps from the split, and nvim never sees it
    v.key("ctrl+alt+l");
    wait_jumps(&mut v, dir, &["linked editor editor"]);
    assert_eq!(wins(&v), before + 1, "no window command ran");
    // Navigate › Linked… types ⌃⌥L: the mouse's way to it
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    v.cx.update(|w, cx| w.dispatch_action(Box::new(vimstorm::app::Replay("ctrl-alt-l")), cx));
    wait_jumps(
        &mut v,
        dir,
        &["linked editor editor", "linked editor editor"],
    );
}

#[test]
fn a_terminal_tab_keeps_ctrl_w_and_ctrl_alt_l_jumps_from_it() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let mut v = window(dir, &[]);
    // ⌘T: the bottom pane's Terminal, typing into the workspace's shell
    v.key("super+t");
    wait_prompt(&mut v);
    terminal::type_text(&mut v, "echo abc def");
    terminal::wait_screen(&mut v, "echo abc def");
    // ⌃W deletes a word in the shell
    v.key("ctrl+w");
    terminal::wait_term(&mut v, "def deleted", |rows| {
        rows.iter()
            .any(|r| r.trim_end().ends_with("echo abc") && !r.contains("def"))
    });
    assert_eq!(jumps(dir), Vec::<String>::new());
    // ⌃⌥L: the shown workspace's story's Linked (from a shell, as from an nvim split)
    v.key("ctrl+alt+l");
    wait_jumps(&mut v, dir, &["linked editor editor"]);
}

#[test]
fn the_factory_view_the_chat_column_and_the_toolbar_line_jump_with_the_plain_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let mut v = window(dir, &[]);
    let projects = v.projects.clone().unwrap();
    // the Board with its Chat hidden: ⌃L from the Factory view
    crate::common::chat::board_without_chat(&mut v);
    v.key("ctrl+l");
    wait_jumps(&mut v, dir, &["linked main factory"]);
    assert!(
        !log(dir).iter().any(|l| l.contains(r#""key":"<C-l>""#)),
        "never a key on the Board"
    );
    v.key("super+alt+a");
    v.wait_until("the Editor", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
    });

    // the rendered Chat: not a PTY, ⌃L jumps from it
    v.key("super+digit_4");
    v.wait_until("Chat has the keyboard", |v| {
        v.pump();
        v.read_ws(|ws, _| ws.native_focus()) == Some(shell::CHAT)
    });
    v.key("ctrl+l");
    let mut want = vec!["linked main factory", "linked chat editor"];
    wait_jumps(&mut v, dir, &want);

    // a click on the toolbar's context line: Linked, from the toolbar
    v.wait_until("the line drawn", |v| {
        v.cx.debug_bounds("toolbar-context").is_some()
    });
    let ctx = v.cx.debug_bounds("toolbar-context").unwrap();
    crate::common::gitui::left(&mut v, ctx.center());
    want.push("linked toolbar editor");
    wait_jumps(&mut v, dir, &want);
}

#[test]
fn a_layer_a_jump_opens_over_the_editor_takes_the_keyboard_and_esc_gives_it_back() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let linked = layer(dir, "linked.json", "trees/linked.json");
    let none = frame(
        dir,
        "none.json",
        json!({"v": 2, "type": "layer", "rev": 1, "tree": null}),
    );
    let mut v = window(
        dir,
        &[
            (r#""to":"linked""#, vec![linked]),
            (r#""key":"<Esc>""#, vec![none]),
        ],
    );
    let projects = v.projects.clone().unwrap();
    // ⌃⌥L from the split: Linked over the Editor, which stays shown, 670 wide and 48 px from the
    // window's top
    v.key("ctrl+alt+l");
    v.wait_until("Linked has the keyboard", factory_has_keyboard);
    assert!(!projects.read_with(&v.cx, |p, _| p.factory_shown()));
    v.wait_until("Linked drawn", |v| {
        v.cx.debug_bounds("factory-linked").is_some()
    });
    let popup = v.cx.debug_bounds("factory-linked").unwrap();
    assert_eq!(popup.size.width, px(670.));
    assert_eq!(popup.top(), px(48.));
    let width = v.cx.update(|window, _| window.viewport_size().width);
    assert_eq!(popup.left(), (width - px(670.)) / 2.);
    // its keys are the layer's: they go to the bridge
    v.key("ö");
    v.wait_until("ö to the bridge", |_| {
        log(dir)
            .iter()
            .any(|l| l.contains(r#""input":{"kind":"key","key":"ö"}"#))
    });
    // a jump from the layer over the Editor names the Editor (the layer's story, never the
    // Board's card under it)
    v.key("ctrl+l");
    wait_jumps(
        &mut v,
        dir,
        &["linked editor editor", "linked editor editor"],
    );
    v.key("escape");
    v.wait_until("the keyboard back in the split", nvim_has_keyboard);
}

/// The Board's ⏎ on a card shows its Card page (the `card` screen in the popup over the Board).
fn card_page(dir: &Path) -> PathBuf {
    let tree: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("trees/card-page.json")).unwrap())
            .unwrap();
    frame(
        dir,
        "card-page.json",
        json!({"v": 2, "type": "tree", "screen": "card", "rev": 2, "tree": tree, "slot": "popup"}),
    )
}

#[test]
fn ctrl_l_on_the_boards_card_and_on_its_card_page_opens_linked() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let linked = layer(dir, "linked.json", "trees/linked.json");
    let none = frame(
        dir,
        "none.json",
        json!({"v": 2, "type": "layer", "rev": 1, "tree": null}),
    );
    let page = card_page(dir);
    let mut v = window(
        dir,
        &[
            (r#""key":"<CR>""#, vec![page]),
            (r#""to":"linked""#, vec![linked]),
            (r#""key":"<Esc>""#, vec![none]),
        ],
    );
    crate::common::chat::board_without_chat(&mut v);
    // on the Board's card: Linked over the Board
    v.key("ctrl+l");
    wait_jumps(&mut v, dir, &["linked main factory"]);
    v.wait_until("Linked drawn", |v| {
        v.cx.debug_bounds("factory-linked").is_some()
    });
    v.key("escape");
    v.wait_until("Linked closed", |v| {
        v.cx.debug_bounds("factory-linked").is_none()
    });
    // ⏎ on the card: its Card page over the Board, which says ⌃L opens Linked; ⌃L from it does
    v.key("enter");
    let f = factory(&v);
    v.wait_until("the Card page", |v| {
        v.pump();
        f.read_with(&v.cx, |f, _| f.popup_open())
    });
    assert!(factory_has_keyboard(&mut v));
    // the Board's tile still, the Board under it
    assert_eq!(
        f.read_with(&v.cx, |f, _| f.main_screen().to_owned()),
        "factory"
    );
    v.key("ctrl+l");
    wait_jumps(&mut v, dir, &["linked main factory", "linked main factory"]);
    assert!(
        !log(dir).iter().any(|l| l.contains(r#""key":"<C-l>""#)),
        "never a key to the page"
    );
}
