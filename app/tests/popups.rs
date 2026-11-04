//! Popups (`src/popups`) on the real nvim + config with GPUI keys and mouse: the context menu
//! (Cmd+Enter or right-click, arrows / Ctrl-n / Ctrl-p move, typing filters at once (every letter),
//! Enter or a click runs, Esc clears then closes, steady while moving or filtering),
//! `vim.ui.select` and `vim.ui.input`, a native surface's menu through the Rust API, balloons, the
//! `,?` key help, and flow dialogs, where Esc closes the top one first.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::time::{Duration, Instant};

use common::TIMEOUT;
use common::gitui::wait_target;
use common::pickers::picker;
use common::tree::{row_point, tv, wait_tree};
use common::view::View;
use gpui_kit::{
    App, Bounds, Entity, Focusable as _, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent,
    Pixels, Point, point, px,
};
use std::sync::Arc;
use vimstorm::kit::Anchor;
use vimstorm::popups::{self, Menu, MenuEntry, MenuItem, PopupsView};

fn popups_entity(v: &mut View) -> Entity<PopupsView> {
    v.read_ws(|ws, _| ws.popups().clone())
}

fn pop<R>(v: &mut View, f: impl FnOnce(&PopupsView, &App) -> R) -> R {
    let p = popups_entity(v);
    v.pump();
    p.read_with(&v.cx, f)
}

/// Polls `f` (pumping the UI between checks) until it holds.
fn wait(v: &mut View, label: &str, mut f: impl FnMut(&mut View) -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        v.pump();
        if f(v) {
            return;
        }
        if Instant::now() > deadline {
            let screen = v.screen().join("\n");
            panic!("timed out waiting for: {label}\n--- screen ---\n{screen}");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn menu_open(v: &mut View) -> bool {
    pop(v, |p, _| p.menu_rows().is_some())
}

fn rows(v: &mut View) -> Vec<String> {
    pop(v, |p, _| p.menu_rows().unwrap_or_default())
}

fn selected(v: &mut View) -> Option<String> {
    pop(v, |p, _| p.menu_selected())
}

fn menu_bounds(v: &mut View) -> Bounds<Pixels> {
    pop(v, |p, _| p.menu_bounds()).expect("a menu is open")
}

fn wait_menu(v: &mut View, label: &str) {
    wait(v, label, menu_open);
}

fn wait_closed(v: &mut View, label: &str) {
    wait(v, label, |v| !pop(v, |p, _| p.is_open()));
}

fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// nvim's non-float windows.
fn wins(v: &View) -> i64 {
    v.lua("return #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative == '' end, vim.api.nvim_tabpage_list_wins(0))")
        .as_i64()
        .unwrap()
}

fn lua_str(v: &View, code: &str) -> String {
    v.lua(code).as_str().unwrap_or_default().to_owned()
}

/// Types keys one by one (`/` is Shift+7 on his Swedish layout).
fn typ(v: &mut View, keys: &str) {
    for c in keys.chars() {
        match c {
            '/' => v.key("shift+7"),
            ' ' => v.key("space"),
            c => v.key(&c.to_string()),
        }
    }
}

/// Center of a drawn menu row (by its item index).
fn row_center(v: &mut View, ix: usize) -> Point<Pixels> {
    v.pump();
    v.cx.debug_bounds(Box::leak(format!("menu-row-{ix}").into_boxed_str()))
        .unwrap_or_else(|| panic!("menu row {ix} not drawn"))
        .center()
}

fn row_of(v: &mut View, label: &str) -> usize {
    rows(v)
        .iter()
        .position(|r| r == label)
        .unwrap_or_else(|| panic!("{label:?} not in the menu: {:?}", rows(v)))
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
}

fn start() -> View {
    let mut v = View::start("proj", &["menu.txt"]);
    v.wait_lua(
        "the split has focus",
        "return require('config.focus').target() == 'split'",
    );
    v
}

#[test]
fn context_menu_keys_and_speed_search() {
    let mut v = start();
    let before = wins(&v);

    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "Cmd+Enter opens the editor's context menu");
    let all = rows(&mut v);
    assert!(all.iter().any(|r| r == "Copy Path"), "{all:?}");
    assert!(all.iter().any(|r| r == "-"), "separators: {all:?}");
    assert_eq!(target(&v), "popup", "the menu has the keyboard");
    let split = pop(&mut v, |p, _| p.menu_item("Split Right")).unwrap();
    assert_eq!(
        split.shortcut.as_deref(),
        Some(",v"),
        "shortcut right of the item"
    );
    let copy = pop(&mut v, |p, _| p.menu_item("Copy")).unwrap();
    assert!(copy.icon.is_some(), "Copy has its icon");

    let s0 = selected(&mut v);
    let frame = menu_bounds(&mut v);
    v.key("arrow_down");
    let s1 = selected(&mut v);
    v.key("arrow_up");
    assert!(
        s1.is_some() && s1 != s0 && selected(&mut v) == s0,
        "↓ down, ↑ up"
    );
    for k in ["arrow_down", "ctrl+n", "ctrl+p", "arrow_down", "arrow_up"] {
        v.key(k);
        assert_eq!(
            menu_bounds(&mut v),
            frame,
            "moving doesn't move / resize the menu"
        );
    }

    // typing filters at once (no `/`): selects the first match; Esc clears it keeping the
    // selected item
    typ(&mut v, "co");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("co".into()));
    let filtered = rows(&mut v);
    assert!(filtered.len() < all.len() && !filtered.contains(&"-".into()));
    assert_eq!(selected(&mut v).as_ref(), filtered.first());
    let b = menu_bounds(&mut v);
    assert_eq!(
        b.origin, frame.origin,
        "filtering keeps the menu's top-left"
    );
    assert!(b.size.height < frame.size.height, "... and shrinks it");
    v.key("arrow_down");
    let picked = selected(&mut v);
    // The visible filter owns text; arrows navigate its results and Backspace edits.
    v.key("arrow_down");
    v.key("arrow_up");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("co".into()));
    assert_eq!(selected(&mut v), picked);
    v.key("backspace");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("c".into()));
    v.key("o");
    assert_eq!(selected(&mut v).as_ref(), filtered.first());
    v.key("arrow_down");
    v.key("escape");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), None);
    assert_eq!(rows(&mut v).len(), all.len());
    assert_eq!(
        selected(&mut v),
        picked,
        "Esc clears the search, keeps the item"
    );
    // his moves are letters: they type into the filter too
    for k in ["k", "l", "ö", "ä"] {
        v.key(k);
    }
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("klöä".into()));
    v.key("escape");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), None);
    assert!(menu_open(&mut v));

    // `/` also starts search; Enter runs Split Right.
    typ(&mut v, "/sprig");
    let r = rows(&mut v);
    assert!(r.len() <= 2 && r[0] == "Split Right", "{r:?}");
    v.key("enter");
    wait_closed(&mut v, "Enter closes the menu");
    v.wait_lua(
        "Enter runs Split Right",
        &format!("return #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative == '' end, vim.api.nvim_tabpage_list_wins(0)) == {}", before + 1),
    );
    assert_eq!(
        v.read_ws(|ws, _| ws.native_focus()),
        None,
        "keyboard back to nvim"
    );
    v.lua("vim.cmd('close') return true");

    // Esc closes it; Cmd+Enter again too: focus back in the split
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "menu again");
    v.key("escape");
    wait_closed(&mut v, "Esc closes it");
    v.wait_lua(
        "focus back in the split",
        "return require('config.focus').target() == 'split' and vim.bo.filetype ~= 'wsmenu'",
    );
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "menu again");
    v.keystrokes("cmd-enter");
    wait_closed(&mut v, "Cmd+Enter in the menu closes it");
    assert_eq!(v.mode(), "n");

    // after a menu, a click anywhere (the status bar) never hands the keyboard to the popups
    let status = v.read(|e| e.geometry().layout.frame.status);
    press(&mut v, status.center(), MouseButton::Left, 1);
    v.pump();
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), None);
    v.keystrokes("i z escape");
    v.wait_lua(
        "nvim got the keys",
        "return vim.api.nvim_get_current_line():find('z') ~= nil",
    );
}

#[test]
fn right_click_menu_mouse() {
    let mut v = start();
    let before = wins(&v);
    // room for the whole menu (24 px rows): every row hit-testable without scrolling
    v.cx.simulate_resize(gpui_kit::size(px(1200.), px(1100.)));
    v.wait_for("relaid out", |e| {
        e.geometry().layout.frame.viewport.height == px(1100.)
    });
    v.settle();

    // right-click: caret to the word, menu with its top-left at the mouse
    let (row, col) = v.cell_of("gamma three");
    let at = v.cell_pos(row, col + 2);
    press(&mut v, at, MouseButton::Right, 1);
    wait_menu(&mut v, "right-click opens the menu");
    assert_eq!(
        v.lua("return vim.fn.line('.')").as_i64(),
        Some(3),
        "the caret moved to the click"
    );
    let b = menu_bounds(&mut v);
    let room = v.cx.update(|w, _| w.viewport_size()).height - px(8.);
    assert!(
        (b.origin.x - at.x).abs() < px(1.)
            && ((b.origin.y - at.y).abs() < px(1.) || at.y + b.size.height > room),
        "menu at the mouse (pulled up only when it doesn't fit): {b:?} vs {at:?}"
    );

    // hover selects; clicking an item runs it
    let ix = row_of(&mut v, "Split Down");
    let p = row_center(&mut v, ix);
    v.cx.simulate_mouse_move(p, None, Modifiers::default());
    assert_eq!(
        selected(&mut v).as_deref(),
        Some("Split Down"),
        "hover selects"
    );
    press(&mut v, p, MouseButton::Left, 1);
    wait_closed(&mut v, "a click on an item closes the menu");
    v.wait_lua(
        "clicking Split Down runs it",
        &format!("return #vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative == '' end, vim.api.nvim_tabpage_list_wins(0)) == {}", before + 1),
    );
    v.lua("vim.cmd('close') return true");

    // a click outside closes it, and lands there (the caret moves to the clicked line)
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "menu again");
    let (row, col) = v.cell_of("epsilon five");
    let at = v.cell_pos(row, col + 1);
    assert!(
        !menu_bounds(&mut v).contains(&at),
        "the click is outside the menu"
    );
    press(&mut v, at, MouseButton::Left, 1);
    wait_closed(&mut v, "a click outside closes it");
    v.wait_lua("the click landed", "return vim.fn.line('.') == 5");

    // a right-click outside: this menu goes, a new one opens there (caret moved there)
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "menu again");
    let first = menu_bounds(&mut v);
    let (row, col) = v.cell_of("beta two");
    let on_line = v.cell_pos(row, col + 1);
    // right of the (tall) menu, on line 2 past its text
    let at = point(first.right() + px(40.), on_line.y);
    assert!(!first.contains(&at));
    press(&mut v, at, MouseButton::Right, 1);
    wait(&mut v, "a new menu at the right-click", |v| {
        // left of the click when there's no room right of it
        pop(v, |p, _| p.menu_bounds()).is_some_and(|b| b.origin.x == at.x || b.right() == at.x)
    });
    v.wait_lua(
        "caret on the right-clicked line",
        "return vim.fn.line('.') == 2",
    );
    v.key("escape");
    wait_closed(&mut v, "Esc");

    // near the bottom of a tall window: flipped above the click; filtering shrinks it in place
    v.cx.simulate_resize(gpui_kit::size(px(1200.), px(1500.)));
    v.wait_for("relaid out", |e| {
        e.geometry().layout.frame.viewport.height == px(1500.)
    });
    v.settle();
    let island = v.read(|e| e.geometry().layout.wins[0].grid_area);
    let low = point(at.x, island.bottom() - px(60.));
    press(&mut v, low, MouseButton::Right, 1);
    wait_menu(&mut v, "right-click menu near the bottom");
    assert!(
        menu_bounds(&mut v).bottom() <= low.y + px(1.),
        "flipped above the click"
    );
    let before_f = menu_bounds(&mut v);
    typ(&mut v, "co");
    let after = menu_bounds(&mut v);
    assert_eq!(
        before_f.origin, after.origin,
        "the menu doesn't jump while filtering"
    );
    assert!(after.size.height < before_f.size.height);
    v.key("escape");
    v.key("escape");
    wait_closed(&mut v, "two Esc close it");

    // a click on a tree row while the menu is open: the menu goes, the tree gets the keys and the row
    wait_tree(&mut v, "b.ts listed", |t| t.row_index("b.ts").is_some());
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "menu open");
    let at = row_point(&mut v, "b.ts", 4.);
    assert!(
        !menu_bounds(&mut v).contains(&at),
        "the tree row is outside the menu"
    );
    press(&mut v, at, MouseButton::Left, 1);
    wait(&mut v, "the menu closes", |v| !pop(v, |p, _| p.is_open()));
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), Some("tree"));
    assert_eq!(tv(&mut v, |t| t.cursor()).as_deref(), Some("b.ts"));
    v.wait_lua(
        "focus.target() is the tree",
        "return require('config.focus').target() == 'tree'",
    );
}

#[test]
fn ui_select_from_lua() {
    let mut v = start();
    v.lua("vim.ui.select({ 'One', 'Two' }, { prompt = 'Pick:' }, function(c) vim.g.picked = c end) return true");
    wait_menu(&mut v, "vim.ui.select opens the menu");
    assert_eq!(rows(&mut v), vec!["One", "Two"]);
    // Typing filters at once; arrow navigation preserves the query in the active field.
    v.key("w");
    assert_eq!(rows(&mut v), vec!["Two"]);
    v.key("arrow_down");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("w".into()));
    v.key("backspace");
    v.key("backspace");
    assert_eq!(rows(&mut v), vec!["One", "Two"]);
    v.key("enter");
    v.wait_lua("Enter picks Two (kept)", "return vim.g.picked == 'Two'");

    // opened on a selection: Esc gives the selection back
    v.wait_lua(
        "split",
        "return require('config.focus').target() == 'split'",
    );
    v.lua("vim.cmd('normal! gg0vll') return true");
    v.lua("vim.ui.select({ 'One', 'Two' }, {}, function() end) return true");
    wait_menu(&mut v, "menu on a selection");
    v.key("escape");
    wait_closed(&mut v, "Esc closes");
    v.wait_lua(
        "the selection is back",
        "local m = vim.api.nvim_get_mode().mode return m == 'v' and vim.fn.getpos('v')[3] == 1 and vim.fn.col('.') == 3",
    );
    v.key("escape");

    // a double-click on a row: it runs once, its second press never reaches the editor
    v.lua("vim.g.runs = 0 vim.ui.select({ 'One', 'Two' }, {}, function(c) if c then vim.g.runs = vim.g.runs + 1 end end) return true");
    wait_menu(&mut v, "menu");
    let p = row_center(&mut v, 1);
    press(&mut v, p, MouseButton::Left, 1);
    press(&mut v, p, MouseButton::Left, 2);
    wait_closed(&mut v, "closed");
    v.settle();
    assert_eq!(v.lua("return vim.g.runs").as_i64(), Some(1), "ran once");
    assert_eq!(v.mode(), "n", "no Visual selection from the second press");

    // code actions: the title only
    v.lua("vim.ui.select({ { action = { title = 'Add import' }, ctx = { client_id = 1 } } }, { kind = 'codeaction', format_item = function(it) return it.action.title .. ' [vtsls]' end }, function() end) return true");
    wait_menu(&mut v, "code actions");
    assert_eq!(rows(&mut v), vec!["Add import"]);
    v.key("escape");
    wait_closed(&mut v, "Esc");
    v.wait_lua(
        "vim.ui.select's cancel answers nil",
        "return not require('config.menu').is_open()",
    );
}

#[test]
fn input_field_rename_flow() {
    let mut v = start();
    let open = "vim.ui.input({ prompt = 'Rename', default = 'oldName' }, function(t) vim.g.got = t == nil and 'cancel' or t end) return true";
    let input = |v: &mut View| pop(v, |p, cx| p.input_state(cx));

    v.lua(open);
    wait(&mut v, "the input field opens", |v| input(v).is_some());
    let (title, text, sel) = input(&mut v).unwrap();
    assert_eq!((title.as_str(), text.as_str()), ("Rename", "oldName"));
    assert_eq!(sel, 0..7, "the text starts selected");
    assert_eq!(target(&v), "popup");
    // below the caret
    let caret = v.read(|e| e.geometry().caret()).expect("caret");
    let b = pop(&mut v, |p, _| p.input_bounds()).unwrap();
    assert!(b.origin.y >= caret.bottom(), "{b:?} below {caret:?}");
    v.key("escape");
    v.wait_lua("Esc cancels", "return vim.g.got == 'cancel'");
    assert!(input(&mut v).is_none());
    assert_eq!(
        v.read_ws(|ws, _| ws.native_focus()),
        None,
        "keyboard back to nvim"
    );

    v.lua(open);
    wait(&mut v, "open", |v| input(v).is_some());
    v.key("arrow_right");
    v.keystrokes("2");
    v.key("enter");
    v.wait_lua(
        "→ keeps the text, types at its end",
        "return vim.g.got == 'oldName2'",
    );

    // Cmd+C copies the selected text, which stays selected; Cmd+X cuts it, typing goes on
    v.lua(open);
    wait(&mut v, "open", |v| input(v).is_some());
    v.keystrokes("cmd-c");
    let clip = v.cx.read_from_clipboard().and_then(|c| c.text());
    assert_eq!(clip.as_deref(), Some("oldName"));
    assert_eq!(input(&mut v).unwrap().2, 0..7, "still selected");
    v.keystrokes("cmd-x");
    assert_eq!(input(&mut v).unwrap().1, "");
    v.keystrokes("x");
    v.key("enter");
    v.wait_lua("Enter gives the typed text", "return vim.g.got == 'x'");

    // typing replaces the selected text and never touches the clipboard or nvim's `+`
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("KEEP".into()));
    v.lua("vim.fn.setreg('+', 'KEEP') return true");
    v.lua(open);
    wait(&mut v, "open", |v| input(v).is_some());
    v.keystrokes("n e w");
    v.key("enter");
    v.wait_lua("typing over its text", "return vim.g.got == 'new'");
    let clip = v.cx.read_from_clipboard().and_then(|c| c.text());
    assert_eq!(clip.as_deref(), Some("KEEP"), "the clipboard is kept");
    assert_eq!(
        v.lua("return vim.fn.getreg('+')").as_str(),
        Some("KEEP"),
        "nvim's + register too"
    );

    // a click outside cancels
    v.lua(open);
    wait(&mut v, "open", |v| input(v).is_some());
    let island = v.read(|e| e.geometry().layout.wins[0].grid_area);
    let at = point(island.center().x, island.bottom() - px(40.));
    assert!(!pop(&mut v, |p, _| p.input_bounds()).unwrap().contains(&at));
    press(&mut v, at, MouseButton::Left, 1);
    v.wait_lua("a click outside cancels", "return vim.g.got == 'cancel'");
}

#[test]
fn rust_menu_from_a_native_surface() {
    let mut v = start();
    // a surface (the tree) has the keyboard and opens its menu at a point
    let tree_focus = v.read_ws(|ws, cx| ws.tree().focus_handle(cx));
    v.cx.update(|w, cx| w.focus(&tree_focus, cx));
    v.pump();
    let chosen = std::rc::Rc::new(std::cell::Cell::new(None::<Option<usize>>));
    let open = |v: &mut View, chosen: std::rc::Rc<std::cell::Cell<Option<Option<usize>>>>| {
        let menu = Menu::new(
            vec![
                MenuItem::new("New File").shortcut("⌘N").into(),
                MenuEntry::Separator,
                MenuItem::new("Disabled").enabled(false).into(),
                MenuItem::new("Delete…").shortcut("⌫").into(),
            ],
            Anchor::Point(point(px(60.), px(120.))),
        );
        v.cx.update(|w, cx| {
            popups::open_menu(menu, w, cx, move |c, _, _| chosen.set(Some(c)));
        });
        v.pump();
    };
    open(&mut v, chosen.clone());
    assert!(menu_open(&mut v));
    assert_eq!(rows(&mut v), vec!["New File", "-", "Disabled", "Delete…"]);
    assert_eq!(menu_bounds(&mut v).origin, point(px(60.), px(120.)));
    assert_eq!(selected(&mut v).as_deref(), Some("New File"));
    v.key("arrow_down");
    assert_eq!(
        selected(&mut v).as_deref(),
        Some("Delete…"),
        "separators and disabled items are skipped"
    );
    v.key("arrow_down");
    assert_eq!(selected(&mut v).as_deref(), Some("New File"), "wraps");
    v.key("arrow_up");
    v.key("enter");
    assert_eq!(chosen.get(), Some(Some(3)));
    assert_eq!(
        v.read_ws(|ws, _| ws.native_focus()),
        Some("tree"),
        "the keyboard goes back to the surface"
    );
    // Esc: None, focus back too
    open(&mut v, chosen.clone());
    v.key("escape");
    assert_eq!(chosen.get(), Some(None));
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), Some("tree"));
    // a disabled row doesn't run on click
    open(&mut v, chosen.clone());
    chosen.set(None);
    let p = row_center(&mut v, 2);
    press(&mut v, p, MouseButton::Left, 1);
    assert!(menu_open(&mut v) && chosen.get().is_none());
    v.key("escape");
}

#[test]
fn balloons_appear_expire_and_close() {
    let mut v = start();
    v.lua("vim.notify('Pushed 12 commits to origin/feature/very-long-branch-name-here and updated tracking information for all of them', vim.log.levels.INFO, { title = 'Push successful' }) return true");
    wait(&mut v, "the balloon shows", |v| {
        pop(v, |p, _| p.balloons())
            .iter()
            .any(|b| b.0 == "Push successful")
    });
    v.pump();
    let b =
        v.cx.debug_bounds("balloon-1")
            .or_else(|| {
                // snacks' ids are numbers: the first one
                let id = lua_str(
                    &v,
                    "local h = Snacks.notifier.get_history() return tostring(h[#h].id)",
                );
                v.cx.debug_bounds(Box::leak(format!("balloon-{id}").into_boxed_str()))
            })
            .expect("balloon drawn");
    let size = v.cx.update(|w, _| w.viewport_size());
    assert!(
        b.right() > size.width * 0.8 && b.bottom() > size.height * 0.7,
        "bottom right: {b:?}"
    );
    assert_eq!(b.size.width, px(vimstorm::look::BALLOON_WIDTH));
    assert!(
        b.size.height > px(60.),
        "title + the wrapped message: {b:?}"
    );
    assert_eq!(
        v.read_ws(|ws, _| ws.native_focus()),
        None,
        "never takes the keyboard"
    );

    // a click closes it; focus stays where it was
    press(&mut v, b.center(), MouseButton::Left, 1);
    assert!(pop(&mut v, |p, _| p.balloons()).is_empty());
    assert_eq!(target(&v), "split");
    assert_eq!(v.mode(), "n");

    // gone after the notifier's timeout; an error too; Snacks.notifier.hide hides it
    v.lua("vim.notify('Copied /tmp/x', vim.log.levels.INFO) return true");
    wait(&mut v, "info balloon", |v| {
        !pop(v, |p, _| p.balloons()).is_empty()
    });
    v.advance(Duration::from_millis(4100));
    assert!(pop(&mut v, |p, _| p.balloons()).is_empty(), "expired");
    v.lua("vim.notify('Boom', vim.log.levels.ERROR, { title = 'Error' }) vim.notify('Searching…', vim.log.levels.INFO, { id = 'ws_usages', timeout = 0 }) return true");
    wait(&mut v, "two balloons", |v| {
        pop(v, |p, _| p.balloons()).len() == 2
    });
    v.lua("Snacks.notifier.hide('ws_usages') return true");
    wait(&mut v, "hidden by id", |v| {
        pop(v, |p, _| p.balloons()) == vec![("Error".to_string(), "Boom".to_string())]
    });
    // Rust callers
    v.cx.update(|w, cx| popups::notify(popups::Balloon::info("Copied", "/a/b"), w, cx));
    v.pump();
    assert_eq!(pop(&mut v, |p, _| p.balloons()).len(), 2);

    // a Lua balloon's action (vim.notify's opts.action): its link under the text runs it in Lua
    v.lua("Snacks.notifier.hide() return true");
    wait(&mut v, "none left", |v| {
        pop(v, |p, _| p.balloons()).is_empty()
    });
    v.lua(
        "vim.notify('a.ts changed on disk', vim.log.levels.WARN, { id = 'act', timeout = 0, \
           action = { label = 'Resolve…', run = function() vim.g.acted = true end } }) return true",
    );
    v.pump();
    wait(&mut v, "its link", |v| {
        v.cx.debug_bounds("balloon-action-act").is_some()
    });
    let link = v.cx.debug_bounds("balloon-action-act").unwrap();
    press(&mut v, link.center(), MouseButton::Left, 1);
    wait(&mut v, "the action ran in Lua", |v| {
        v.lua("return vim.g.acted == true").as_bool() == Some(true)
    });
}

#[test]
fn key_help_lists_the_leader_keys() {
    let mut v = start();
    v.key(",");
    v.settle();
    assert!(
        pop(&mut v, |p, _| p.key_help()).is_none(),
        ", alone shows no key list"
    );
    v.key("escape");
    v.settle();
    v.key(",");
    v.key("shift++"); // ? on the Swedish layout
    wait(&mut v, ",? opens the key help", |v| {
        pop(v, |p, _| p.key_help()).is_some()
    });
    let (title, rows) = pop(&mut v, |p, _| p.key_help()).unwrap();
    assert_eq!(title, ",");
    assert!(rows.contains(&("r".into(), "+refactor".into())), "{rows:?}");
    assert!(rows.contains(&("w".into(), "Close tab".into())), "{rows:?}");
    assert_eq!(target(&v), "popup");
    // a group opens its keys, Backspace goes back, Esc closes
    v.key("f");
    let (title, rows) = pop(&mut v, |p, _| p.key_help()).unwrap();
    assert_eq!(title, ",f");
    assert!(rows.iter().any(|r| r.1 == "Recent files"), "{rows:?}");
    v.key("backspace");
    assert_eq!(pop(&mut v, |p, _| p.key_help()).unwrap().0, ",");
    v.key("escape");
    assert!(pop(&mut v, |p, _| p.key_help()).is_none());
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), None);
    // a mapping runs: ,o (Close other tabs) keeps one tab; ,w closes the file
    v.key(",");
    v.key("shift++");
    wait(&mut v, "key help again", |v| {
        pop(v, |p, _| p.key_help()).is_some()
    });
    v.lua("vim.g.ws_test_ran = nil vim.keymap.set('n', '<leader>Z', function() vim.g.ws_test_ran = 1 end, { desc = 'Test map' }) return true");
    // (the list was sent before the map existed: reopen)
    v.key("escape");
    v.key(",");
    v.key("shift++");
    wait(&mut v, "key help again", |v| {
        pop(v, |p, _| p.key_help()).is_some()
    });
    let rows = pop(&mut v, |p, _| p.key_help()).unwrap().1;
    assert!(rows.contains(&("Z".into(), "Test map".into())), "{rows:?}");
    v.key("shift+z");
    v.wait_lua("the picked mapping runs", "return vim.g.ws_test_ran == 1");
    assert!(pop(&mut v, |p, _| p.key_help()).is_none());
}

#[test]
fn a_popup_replaced_by_another_kind_answers_lua() {
    let mut v = start();
    v.lua("vim.g.sel = 'none' vim.ui.select({ 'One', 'Two' }, {}, function(c) vim.g.sel = c == nil and 'nil' or c end) return true");
    wait_menu(&mut v, "select open");
    // an input field replaces the menu: vim.ui.select hears nil, the menu is gone in Lua too
    v.lua("vim.g.got = 'none' vim.ui.input({ prompt = 'Name', default = 'x' }, function(t) vim.g.got = t == nil and 'nil' or t end) return true");
    wait(&mut v, "the input field replaced the menu", |v| {
        pop(v, |p, cx| p.input_state(cx)).is_some()
    });
    v.wait_lua(
        "on_choice(nil), menu.is_open() false",
        "return vim.g.sel == 'nil' and not require('config.menu').is_open()",
    );
    // and a menu replacing the field: on_confirm(nil)
    v.lua("vim.ui.select({ 'A' }, {}, function() end) return true");
    wait_menu(&mut v, "menu replaced the field");
    v.wait_lua(
        "on_confirm(nil), no field open",
        "return vim.g.got == 'nil' and not require('config.app.input').is_open()",
    );
    // the key help replacing a menu: the menu's owner hears nil too
    v.lua("vim.g.sel = 'none' vim.ui.select({ 'One' }, {}, function(c) vim.g.sel = c == nil and 'nil' or c end) return true");
    wait(&mut v, "select open", |v| rows(v) == vec!["One"]);
    v.lua("require('config.app.keyhelp').show() return true");
    wait(&mut v, "key help", |v| {
        pop(v, |p, _| p.key_help()).is_some()
    });
    v.wait_lua(
        "on_choice(nil)",
        "return vim.g.sel == 'nil' and not require('config.menu').is_open()",
    );
    v.key("escape");
}

#[test]
fn balloons_fit_the_window_like_snacks() {
    let mut v = start();
    let size = v.cx.update(|w, _| w.viewport_size());
    // a long message: at most 0.6 of the window high, the rest cut
    v.lua("local l = {} for i = 1, 200 do l[i] = 'line ' .. i .. ' of a very long build log that goes on' end vim.notify(table.concat(l, '\\n'), vim.log.levels.ERROR, { title = 'Build failed' }) return true");
    wait(&mut v, "the long balloon", |v| {
        pop(v, |p, _| p.balloon_ids()).len() == 1
    });
    let id = pop(&mut v, |p, _| p.balloon_ids())[0].clone();
    v.pump();
    let b =
        v.cx.debug_bounds(Box::leak(format!("balloon-{id}").into_boxed_str()))
            .expect("drawn");
    assert!(
        b.size.height <= size.height * 0.6 + px(1.),
        "capped at 0.6 of the window: {b:?}"
    );
    assert!(
        b.size.height > size.height * 0.4,
        "but uses the room: {b:?}"
    );
    v.lua("Snacks.notifier.hide() return true");
    wait(&mut v, "hidden", |v| {
        pop(v, |p, _| p.balloon_ids()).is_empty()
    });

    // many: only as many as fit are shown, the rest wait and come once room frees
    v.lua("for i = 1, 20 do vim.notify('Message ' .. i, vim.log.levels.INFO, { title = 'Note ' .. i }) end return true");
    wait(&mut v, "a stack", |v| {
        !pop(v, |p, _| p.balloon_ids()).is_empty()
    });
    let shown = pop(&mut v, |p, _| p.balloon_ids());
    let waiting = pop(&mut v, |p, _| p.balloons_waiting());
    assert!(
        shown.len() < 20 && waiting == 20 - shown.len(),
        "{shown:?} + {waiting}"
    );
    let top = shown
        .iter()
        .map(|id| {
            v.cx.debug_bounds(Box::leak(format!("balloon-{id}").into_boxed_str()))
                .unwrap()
                .top()
        })
        .fold(px(f32::MAX), |a, b| a.min(b));
    let toolbar = v.read(|e| e.geometry().layout.frame.toolbar);
    assert!(
        top >= toolbar.bottom(),
        "the stack stays below the toolbar: {top:?}"
    );
    let first = pop(&mut v, |p, _| p.balloons())[0].0.clone();
    assert_eq!(first, "Note 1", "the oldest shows first (at the bottom)");
    // shown ones time out, the waiting ones come on screen with their own full timeout
    v.advance(Duration::from_millis(4100));
    let next = pop(&mut v, |p, _| p.balloons());
    assert!(
        !next.is_empty() && next[0].0 != "Note 1",
        "waiting ones show once the first went: {next:?}"
    );

    // debug / trace levels show too (their own icon)
    v.lua("Snacks.notifier.hide() vim.notify('dbg', vim.log.levels.DEBUG) return true");
    wait(&mut v, "debug balloon", |v| {
        pop(v, |p, _| p.balloons()).iter().any(|b| b.1 == "dbg")
    });
}

#[test]
fn menu_mouse_extras_icons_and_input_completion() {
    let mut v = start();
    // middle-click in the menu cancels it (menu.lua's <MiddleMouse>): on_cancel runs
    v.lua("vim.g.sel = 'none' vim.ui.select({ 'One', 'Two', 'Three' }, {}, function(c) vim.g.sel = c == nil and 'nil' or c end) return true");
    wait_menu(&mut v, "select");
    let p = row_center(&mut v, 1);
    press(&mut v, p, MouseButton::Middle, 1);
    wait_closed(&mut v, "middle-click closes");
    v.wait_lua("cancelled", "return vim.g.sel == 'nil'");

    // the wheel over the menu moves the selection a row per step
    v.lua(
        "vim.ui.select({ 'One', 'Two', 'Three' }, {}, function(c) vim.g.sel = c end) return true",
    );
    wait_menu(&mut v, "select");
    let at = row_center(&mut v, 0);
    let wheel = |v: &mut View, lines: f32| {
        v.cx.simulate_event(gpui_kit::ScrollWheelEvent {
            position: at,
            delta: gpui_kit::ScrollDelta::Lines(point(0., lines)),
            modifiers: Modifiers::default(),
            touch_phase: gpui_kit::TouchPhase::Moved,
        });
        v.pump();
    };
    // (the pointer rests on the first row: hovering selects it)
    v.cx.simulate_mouse_move(at, None, Modifiers::default());
    assert_eq!(selected(&mut v).as_deref(), Some("One"));
    wheel(&mut v, -1.);
    assert_eq!(
        selected(&mut v).as_deref(),
        Some("Two"),
        "wheel down: next row"
    );
    wheel(&mut v, 1.);
    assert_eq!(
        selected(&mut v).as_deref(),
        Some("One"),
        "wheel up: previous"
    );
    // L / Ö type (upper case filters); Esc resets the search, the menu stays
    v.key("shift+ö");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), Some("Ö".into()));
    v.key("escape");
    assert_eq!(pop(&mut v, |p, _| p.menu_query()), None);
    assert!(menu_open(&mut v));
    assert_eq!(selected(&mut v).as_deref(), Some("One"));
    // a mouse pick: the next vim.ui.select (no mouse key in nvim since) opens at the mouse
    let two = row_center(&mut v, 1);
    press(&mut v, two, MouseButton::Left, 1);
    v.wait_lua("picked Two", "return vim.g.sel == 'Two'");
    v.lua("vim.ui.select({ 'Again' }, {}, function() end) return true");
    wait_menu(&mut v, "follow-up select");
    let b = menu_bounds(&mut v);
    assert_eq!(b.origin.x, two.x, "at the mouse after a mouse pick: {b:?}");
    // ... and after a keyboard pick, at the caret again
    v.key("enter");
    wait_closed(&mut v, "closed");
    v.lua("vim.ui.select({ 'Again' }, {}, function() end) return true");
    wait_menu(&mut v, "follow-up select");
    let caret = v.read(|e| e.geometry().caret()).expect("caret");
    assert!(
        menu_bounds(&mut v).origin.y >= caret.bottom(),
        "below the caret after a keyboard pick"
    );
    v.key("escape");
    wait_closed(&mut v, "closed");

    // icons: WebStorm's by label (Cut, Paste, Split...) and the items' own (file kinds); a
    // "›" in a label with the submenu chevron isn't doubled
    v.lua("require('config.menu').open({ { 'Cut', function() end }, { 'Split Right', function() end }, { 'a.ts', function() end, icon = { require('config.icons').I.ts.glyph, 'WsIconBlue' } }, { 'Bookmarks ›', function() end, key = '›' } }) return true");
    wait_menu(&mut v, "menu with icons");
    let item = |v: &mut View, l: &str| pop(v, |p, _| p.menu_item(l)).unwrap();
    use vimstorm::kit::IconName;
    assert_eq!(item(&mut v, "Cut").icon, Some(IconName::Cut));
    assert_eq!(
        item(&mut v, "Split Right").icon,
        Some(IconName::SplitVertically)
    );
    assert_eq!(item(&mut v, "a.ts").icon, Some(IconName::TypeScript));
    assert!(
        rows(&mut v).contains(&"Bookmarks".to_string()),
        "{:?}",
        rows(&mut v)
    );
    v.key("escape");
    wait_closed(&mut v, "closed");

    // vim.ui.input with completion: Tab completes like input(), again cycles
    v.lua("vim.ui.input({ prompt = 'File', default = 'mu', completion = 'file' }, function(t) vim.g.got = t end) return true");
    wait(&mut v, "field", |v| {
        pop(v, |p, cx| p.input_state(cx)).is_some()
    });
    v.key("arrow_right");
    v.key("tab");
    wait(&mut v, "completed", |v| {
        pop(v, |p, cx| p.input_state(cx)).is_some_and(|s| s.1 == "multi.txt")
    });
    v.key("enter");
    v.wait_lua("the completed name", "return vim.g.got == 'multi.txt'");
}

fn drawn(v: &mut View, name: &str) -> Bounds<Pixels> {
    v.pump();
    v.cx.debug_bounds(Box::leak(name.to_string().into_boxed_str()))
        .unwrap_or_else(|| panic!("{name} not drawn"))
}

fn near(a: Pixels, b: f32, what: &str) {
    assert!((a - px(b)).abs() <= px(1.), "{what}: {a:?} vs {b}");
}

/// WebStorm's two menu looks: the right-click JPopupMenu (24 px pitch, 22 px selection 8 from
/// the edge, text after an 18 px icon column, shortcuts 14 from the right) and the titled
/// ListPopup (32 px bold title, 22 px rows, list insets, group captions).
#[test]
fn menu_metrics_context_and_list() {
    use vimstorm::popups::MenuStyle;
    let mut v = start();
    v.keystrokes("cmd-enter");
    wait_menu(&mut v, "context menu");
    assert_eq!(pop(&mut v, |p, _| p.menu_style()), Some(MenuStyle::Context));
    let frame = menu_bounds(&mut v);
    let labels = rows(&mut v);
    let pair = (0..labels.len() - 1)
        .find(|&i| labels[i] != "-" && labels[i + 1] != "-")
        .expect("two items in a row");
    let (a, b) = (
        drawn(&mut v, &format!("menu-row-{pair}")),
        drawn(&mut v, &format!("menu-row-{}", pair + 1)),
    );
    near(b.top() - a.top(), 24., "context row pitch");
    let sel = drawn(&mut v, &format!("menu-sel-{pair}"));
    near(sel.size.height, 22., "selection height");
    near(sel.left() - frame.left(), 8., "selection x");
    let label = drawn(&mut v, &format!("menu-label-{pair}"));
    near(
        label.left() - frame.left(),
        36.,
        "label x after the icon column",
    );
    let keyed = (0..labels.len())
        .find(|&i| {
            let l = labels[i].clone();
            labels[i] != "-"
                && pop(&mut v, |p, _| p.menu_item(&l))
                    .and_then(|m| m.shortcut)
                    .is_some_and(|s| s != "›")
        })
        .expect("an item with a shortcut");
    let key = drawn(&mut v, &format!("menu-key-{keyed}"));
    near(frame.right() - key.right(), 14., "shortcut right edge");
    v.key("escape");
    wait_closed(&mut v, "Esc");

    // vim.ui.select with a prompt: the list popup under a 32 px title
    v.lua("vim.ui.select({ 'One', 'Two' }, { prompt = 'Pick:' }, function() end) return true");
    wait_menu(&mut v, "select");
    assert_eq!(pop(&mut v, |p, _| p.menu_style()), Some(MenuStyle::List));
    let frame = menu_bounds(&mut v);
    let header = drawn(&mut v, "menu-header");
    near(header.size.height, 32., "title height");
    let r0 = drawn(&mut v, "menu-row-0");
    let r1 = drawn(&mut v, "menu-row-1");
    near(r0.top() - frame.top(), 33., "rows right under the title");
    near(r1.top() - r0.top(), 22., "list row pitch");
    near(
        drawn(&mut v, "menu-label-0").left() - frame.left(),
        17.,
        "list text x",
    );
    near(frame.bottom() - r1.bottom(), 9., "bottom inset 8 + border");
    v.key("escape");
    wait_closed(&mut v, "Esc");

    // no title: 8 above the rows; a separator's caption is a group header
    v.lua("require('config.app.bridge').notify('popups', { event = 'menu', id = 9999, icons = false, items = { { sep = true, label = 'Group' }, { label = 'A' }, { sep = true, label = 'More' }, { label = 'B' } }, anchor = { at = 'mouse' } }) return true");
    wait_menu(&mut v, "menu with captions");
    let frame = menu_bounds(&mut v);
    let c0 = drawn(&mut v, "menu-caption-0");
    near(c0.top() - frame.top(), 9., "top inset 8 + border");
    near(c0.size.height, 22., "caption row");
    drawn(&mut v, "menu-caption-2");
    v.key("escape");
    wait_closed(&mut v, "Esc");
}

/// P-12: a list popup's question wraps over lines under the 8 px insets instead of widening the
/// popup or being cut, and what a menu only says is an info line (dim, wrapped, never chosen),
/// not a grey item.
#[test]
fn list_popup_questions_wrap_and_info_lines_are_said() {
    let mut v = start();
    let question = "Create a workspace from the committed HEAD of this repository and copy none of the local changes?";
    let info = "No files are marked in Git, so the workspace starts from the committed HEAD only and nothing else is copied into it";
    v.lua(&format!(
        "vim.g.made = 0 require('config.menu').open({{ {{ info = '{info}' }}, {{ 'Create', function() vim.g.made = 1 end }}, {{ 'Cancel' }} }}, {{ title = '{question}' }}) return true"
    ));
    wait_menu(&mut v, "the list popup");
    let lines = pop(&mut v, |p, _| p.menu_title_lines()).unwrap();
    assert!(lines.len() >= 2, "the question wraps: {lines:?}");
    assert_eq!(lines.join(" "), question, "every word kept");
    let frame = menu_bounds(&mut v);
    assert!(
        frame.size.width <= px(vimstorm::look::LIST_POPUP_WRAP_WIDTH + 40.),
        "the question doesn't widen the popup: {frame:?}"
    );
    let header = drawn(&mut v, "menu-header");
    near(
        header.size.height,
        32. + 16. * (lines.len() - 1) as f32,
        "title grows a line at a time",
    );
    // the info line: its text, dim lines, not selectable; the first item has the cursor
    assert_eq!(rows(&mut v)[0], info);
    assert_eq!(pop(&mut v, |p, _| p.menu_row_selectable(0)), Some(false));
    assert_eq!(selected(&mut v).as_deref(), Some("Create"));
    let said = drawn(&mut v, "menu-info-0");
    assert!(
        said.size.height > px(22.),
        "a long info line wraps: {said:?}"
    );
    assert!(said.top() >= header.bottom(), "under the title");
    // up from the first item wraps to the last item, never onto the info line
    v.key("arrow_up");
    assert_eq!(selected(&mut v).as_deref(), Some("Cancel"));
    v.key("arrow_down");
    v.key("enter");
    wait_closed(&mut v, "Create ran");
    v.wait_lua("the item after the info line ran", "return vim.g.made == 1");
}

/// The input popup is WebStorm's "New File" popup; key help has a title + advertiser; balloons
/// stack 10 apart, 5 from the edge, in WebStorm's two vertical layouts.
#[test]
fn input_keyhelp_and_balloon_metrics() {
    let mut v = start();
    v.lua("vim.ui.input({ prompt = 'Rename', default = 'x' }, function() end) return true");
    wait(&mut v, "input", |v| {
        pop(v, |p, cx| p.input_state(cx)).is_some()
    });
    let b = pop(&mut v, |p, _| p.input_bounds()).unwrap();
    near(
        drawn(&mut v, "input-header").size.height,
        32.,
        "input title",
    );
    let field = drawn(&mut v, "input-field");
    near(field.size.height, 32., "field row");
    near(field.top() - b.top(), 33., "field under the title");
    near(b.size.height, 74., "title + field + 8 + borders");
    v.key("escape");
    wait(&mut v, "closed", |v| !pop(v, |p, _| p.is_open()));

    v.key(",");
    v.key("shift++");
    wait(&mut v, "key help", |v| {
        pop(v, |p, _| p.key_help()).is_some()
    });
    near(
        drawn(&mut v, "key-help-header").size.height,
        32.,
        "key help title",
    );
    drawn(&mut v, "key-help-ad");
    v.key("escape");

    // title only, title + a line, title + a long message
    let show = |v: &mut View, title: &str, body: &str| {
        let (t, b) = (title.to_string(), body.to_string());
        v.cx.update(|w, cx| popups::notify(popups::Balloon::info(t, b), w, cx));
        v.pump();
    };
    show(&mut v, "Saved", "");
    show(&mut v, "Copied", "/a/b");
    show(
        &mut v,
        "Pushed",
        "Pushed 12 commits to origin/feature/a-very-long-branch-name and updated the tracking information of every one of them",
    );
    let ids = pop(&mut v, |p, _| p.balloon_ids());
    assert_eq!(ids.len(), 3);
    let bs: Vec<_> = ids
        .iter()
        .map(|id| drawn(&mut v, &format!("balloon-{id}")))
        .collect();
    near(
        bs[0].size.height,
        15. + 16. + 20. + 2.,
        "title only: twoLines",
    );
    near(
        bs[1].size.height,
        15. + 16. + 5. + 16. + 20. + 2.,
        "title + one line: twoLines",
    );
    let lines = ((bs[2].size.height - px(11. + 16. + 3. + 14. + 2.)) / px(16.)).round();
    assert!(lines >= 2., "long message wraps: {:?}", bs[2]);
    near(
        bs[2].size.height,
        11. + 16. + 3. + 14. + 2. + 16. * lines,
        "long message: treeLines",
    );
    // newest on top, 10 apart
    near(bs[0].top() - bs[1].bottom(), 10., "stack gap");
    let size = v.cx.update(|w, _| w.viewport_size());
    near(size.width - bs[0].right(), 5., "right margin");
}

#[test]
fn keys_typed_right_after_a_field_s_shortcut_land_in_it_in_order() {
    let mut v = start();
    let input = |v: &mut View| pop(v, |p, cx| p.input_state(cx));
    v.lua(
        "vim.keymap.set('n', ',zz', function() vim.ui.input({ prompt = 'Rename', default = 'old' }, function(t) vim.g.got = t == nil and 'cancel' or t end) end) return true",
    );
    let before = v.lua("return vim.b.changedtick");
    // one burst: the shortcut, the text and Enter queued in nvim together. nvim holds the text
    // (`x` `d` `u` never run in the file), the field gets it over its selected default, Enter
    // answers with all of it
    v.request("nvim_input", vec![",zzxdu<CR>".into()]);
    v.wait_lua("the burst answered the field", "return vim.g.got == 'xdu'");
    assert!(input(&mut v).is_none());
    assert_eq!(
        v.lua("return vim.b.changedtick"),
        before,
        "nothing ran in the file"
    );
    // typed key by key without waiting: the first keys held, the rest typed into the field after
    v.lua("vim.g.got = nil return true");
    typ(&mut v, ",zznew");
    wait(&mut v, "the field", |v| input(v).is_some());
    v.key("enter");
    v.wait_lua("the keys in the order typed", "return vim.g.got == 'new'");
    assert_eq!(v.lua("return vim.b.changedtick"), before);
    assert_eq!(target(&v), "split", "the keyboard back in the editor");
}

/// The editor menu (a code file) has Search Everywhere; picking it opens the native popup.
#[test]
fn editor_menu_search_everywhere_opens_the_native_picker() {
    let mut v = View::start("proj", &["a.ts"]);
    wait_target(&mut v, "split");
    v.keystrokes("cmd-enter");
    wait(&mut v, "Cmd+Enter opens the editor menu", menu_open);
    let item = pop(&mut v, |p, _| p.menu_item("Search Everywhere"));
    assert!(item.is_some(), "the editor menu has Search Everywhere");
    typ(&mut v, "/search everywhere");
    wait(&mut v, "speed search selects it", |v| {
        pop(v, |p, _| p.menu_selected()).as_deref() == Some("Search Everywhere")
    });
    v.key("enter");
    wait(&mut v, "menu Search Everywhere opens it", |v| {
        picker(v).is_some_and(|s| s.title == "Search Everywhere" && s.kind == "all")
    });
    assert!(!menu_open(&mut v), "the menu closed");
    v.key("escape");
    wait(&mut v, "Esc closes it", |v| picker(v).is_none());
    v.wait_lua(
        "back in the code",
        "return require('config.focus').target() == 'split'",
    );
}

// Dialogs over the projects window -----------------------------------------------------------------

/// A project window with nvim's editor focused.
fn start_projects() -> View {
    let mut v = View::start_projects("proj", &["a.ts"]);
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    v
}

fn open_flow_dialog(v: &mut View, text: &str) -> Arc<std::sync::Mutex<Option<bool>>> {
    use vimstorm::popups::{Button, Dialog, Field, Look};
    let answered = Arc::new(std::sync::Mutex::new(None));
    let a = answered.clone();
    let text = text.to_owned();
    v.cx.update(move |window, cx| {
        let d = Dialog {
            id: "esc",
            title: "Instructions".into(),
            width: 480.,
            field: Some(Field {
                heading: "New instruction".into(),
                text,
                placeholder: "".into(),
                hint: None,
            }),
            buttons: vec![Button::new("save", "Save", Look::Primary).key("⏎")],
            ..Dialog::default()
        };
        vimstorm::popups::open_dialog(d, window, cx, move |answer, _, _| {
            *a.lock().unwrap() = Some(answer.is_some());
        });
    });
    v.wait_until("the dialog drawn", |v| v.drawn("dialog-esc"));
    answered
}

/// A flow dialog that lost the keyboard to a click outside still closes on Esc, cancelled.
#[test]
fn esc_closes_a_dialog_that_lost_the_keyboard_to_a_click_outside() {
    let mut v = start_projects();
    v.focus_code();
    wait_target(&mut v, "split");
    let answered = open_flow_dialog(&mut v, "keep tests green");
    // a click on the code: the dialog holding text stays, the keyboard goes there
    let editor = v.read(|e| e.geometry().layout.editor);
    v.click(gpui_kit::MouseButton::Left, editor.center());
    v.settle();
    assert!(v.drawn("dialog-esc"), "kept: its text area holds text");
    // Esc still closes it, cancelled
    v.key("escape");
    v.wait_until("the dialog closed", |v| !v.drawn("dialog-esc"));
    assert_eq!(*answered.lock().unwrap(), Some(false));
}

/// Over Settings the window's own ⌘ keys go on, a flow dialog draws on top and takes clicks, and
/// Esc closes the top one first.
#[test]
fn over_settings_the_window_keys_go_on_and_esc_closes_the_top_dialog_first() {
    let mut v = start_projects();
    v.focus_code();
    wait_target(&mut v, "split");
    v.key("super+,");
    v.wait_until("the Settings dialog", |v| v.drawn("factory-settings"));
    // ⌘2 is the window's, not Settings': the Chat column shows under the dialog
    v.key("super+digit_4");
    v.wait_until("the Chat column shown", |v| v.drawn("chat-column"));
    assert!(v.drawn("factory-settings"), "Settings stays on top");
    // on top: a click on its button reaches it (under the Settings scrim, it never would)
    let answered = open_flow_dialog(&mut v, "");
    let save = v.bounds("button-dialog-esc-save");
    v.click(gpui_kit::MouseButton::Left, save.center());
    v.wait_until("the dialog answered", |v| !v.drawn("dialog-esc"));
    assert_eq!(*answered.lock().unwrap(), Some(true));
    // Esc closes the top one first: the dialog, then Settings
    let answered = open_flow_dialog(&mut v, "");
    v.key("escape");
    v.wait_until("the dialog closed", |v| !v.drawn("dialog-esc"));
    assert_eq!(*answered.lock().unwrap(), Some(false));
    assert!(
        v.drawn("factory-settings"),
        "Settings stays: one Esc, one box"
    );
    v.key("escape");
    v.wait_until("Settings closed", |v| !v.drawn("factory-settings"));
}
