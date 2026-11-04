//! The editor's tab bars and the empty editor on the real nvim + config: each split's tabs as Lua
//! keeps them, VCS colors, the selected tab's box (blue with the keyboard, gray without), the error
//! underline, the mouse and the tab menu, splits, the hidden tabs button, and an empty editor that
//! takes no text.

use crate::common;

use common::gitui::{menu_rows, pick_menu, wait_target};
use common::tree::{double_click_row, wait_tree};
use common::view::{View, WINDOW};
use gpui_kit::{ClipboardItem, Modifiers, MouseButton, Pixels, Point, px, size};
use vimstorm::editor::tabs::{Bar, CloseMark, LineSpan, StoryLines, TabRects, TabsView};

fn tabs<R>(v: &mut View, f: impl FnOnce(&TabsView) -> R) -> R {
    v.read_ws(|ws, cx| f(ws.tabs().read(cx)))
}

/// The splits' tab bars as drawn, left to right / top to bottom: "tab,tab[active]", "*" after the
/// bar of the split with the keyboard, " | " between bars.
fn bars(v: &mut View) -> String {
    tabs(v, |t| {
        let mut slots = t.slots();
        slots.sort_by(|a, b| {
            (a.tab_bar.origin.y, a.tab_bar.origin.x)
                .partial_cmp(&(b.tab_bar.origin.y, b.tab_bar.origin.x))
                .unwrap()
        });
        slots
            .iter()
            .map(|s| {
                let bar = t.bars().get(&s.win).cloned().unwrap_or(Bar {
                    win: s.win,
                    ..Default::default()
                });
                let names: Vec<&str> = bar.tabs.iter().map(|t| t.name.as_str()).collect();
                let active = bar
                    .tabs
                    .iter()
                    .find(|t| Some(t.buf) == bar.active)
                    .map_or("", |t| t.name.as_str());
                let star = if bar.focused { "*" } else { "" };
                format!("{}[{active}]{star}", names.join(","))
            })
            .collect::<Vec<_>>()
            .join(" | ")
    })
}

fn expect_bars(v: &mut View, label: &str, want: &str) {
    let mut last = String::new();
    v.wait_until(&format!("{label}: bars {want:?}"), |v| {
        let now = bars(v);
        if now != last {
            eprintln!("bars: {now:?}"); // (shown when the wait times out)
            last = now;
        }
        last == want
    });
}

/// The tab named `name` as Lua sent it, in any bar.
fn tab_data(v: &mut View, name: &str) -> Option<vimstorm::editor::tabs::Tab> {
    tabs(v, |t| {
        t.bars()
            .values()
            .flat_map(|b| b.tabs.iter())
            .find(|x| x.name == name)
            .cloned()
    })
}

/// The drawn tab named `name` (the nth from the left or top, from 0). Waits for it: after a layout
/// change the editor holds its frame until nvim's resized grids arrive, so the bars Lua sent (and
/// the new slots) can be ahead of the last drawn frame.
fn tab(v: &mut View, name: &str, nth: usize) -> TabRects {
    let mut found = None;
    v.wait_until(&format!("drawn tab {name:?} (#{nth})"), |v| {
        found = drawn_tab(v, name, nth);
        found.is_some()
    });
    found.unwrap()
}

fn drawn_tab(v: &mut View, name: &str, nth: usize) -> Option<TabRects> {
    tabs(v, |t| {
        let mut found: Vec<TabRects> = t
            .drawn()
            .iter()
            .filter(|d| {
                t.bars()
                    .get(&d.win)
                    .and_then(|b| b.tabs.iter().find(|x| x.buf == d.buf))
                    .is_some_and(|x| x.name == name)
            })
            .copied()
            .collect();
        found.sort_by(|a, b| {
            (a.tab.origin.y, a.tab.origin.x)
                .partial_cmp(&(b.tab.origin.y, b.tab.origin.x))
                .unwrap()
        });
        found.get(nth).copied()
    })
}

fn edit(v: &View, file: &str) {
    v.lua(&format!("vim.cmd.edit('{file}') return true"));
}

fn empty_slot(v: &mut View) -> bool {
    tabs(v, |t| t.slots().first().is_some_and(|s| s.empty))
}

/// Right-clicks the nth drawn tab `name` and picks `item` of its tab menu.
fn tab_menu(v: &mut View, name: &str, nth: usize, item: &str) {
    let t = tab(v, name, nth);
    v.click(MouseButton::Right, t.tab.center());
    pick_menu(v, item);
    v.wait_until("tab menu closed", |v| menu_rows(v).is_none());
}

fn hover(v: &mut View, at: Point<Pixels>) {
    v.cx.simulate_mouse_move(at, None, Modifiers::default());
    v.pump();
}

/// The native menu (the popups surface) shows `item`.
fn menu_shows(v: &mut View, item: &str) -> bool {
    v.read_ws(|ws, cx| ws.popups().read(cx).menu_rows())
        .is_some_and(|rows| rows.iter().any(|r| r == item))
}

/// The open menu's frame.
fn menu_bounds(v: &mut View) -> Option<gpui_kit::Bounds<Pixels>> {
    v.read_ws(|ws, cx| ws.popups().read(cx).menu_bounds())
}

#[test]
fn tab_bar_shows_each_files_tab_vcs_colors_errors_and_focus() {
    let mut v = View::start("grepo", &["blame.ts"]);
    expect_bars(&mut v, "one split, one tab", "blame.ts[blame.ts]*");
    let t = tab(&mut v, "blame.ts", 0);
    let slot = tabs(&mut v, |t| t.slots()[0]);
    assert!(
        slot.tab_bar.contains(&t.tab.center()),
        "drawn in the split's tab bar slot"
    );
    assert_eq!(tab_data(&mut v, "blame.ts").unwrap().status, "");

    // a modified file's tab is blue, an untracked one red (git/status.lua, like the tree)
    v.lua("vim.cmd('normal! O// changed') vim.cmd('silent write') return true");
    v.wait_until("blame.ts Modified", |v| {
        tab_data(v, "blame.ts").is_some_and(|t| t.status == "Modified")
    });
    edit(&v, "new.ts");
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'export {}' }) vim.cmd('silent write') return true");
    expect_bars(
        &mut v,
        "new tab right of the active one",
        "blame.ts,new.ts[new.ts]*",
    );
    v.wait_until("new.ts Unversioned", |v| {
        tab_data(v, "new.ts").is_some_and(|t| t.status == "Unversioned")
    });
    assert_eq!(
        vimstorm::editor::tabs::status_color("Modified"),
        vimstorm::look::GIT_MODIFIED.rgba()
    );
    assert_eq!(
        vimstorm::editor::tabs::status_color("Unversioned"),
        vimstorm::look::GIT_UNTRACKED.rgba()
    );

    // errors in the file: the label gets the wavy underline
    assert!(!tab_data(&mut v, "new.ts").unwrap().error);
    v.lua(
        "vim.diagnostic.set(vim.api.nvim_create_namespace('t'), 0, \
         { { lnum = 0, col = 0, message = 'x', severity = vim.diagnostic.severity.ERROR } }) return true",
    );
    v.wait_until("new.ts has errors", |v| {
        tab_data(v, "new.ts").is_some_and(|t| t.error)
    });

    // the selected tab's box: blue while the split has the keyboard, gray while the tree has it
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    expect_bars(
        &mut v,
        "tree focused: no bar has focus",
        "blame.ts,new.ts[new.ts]",
    );
    v.focus_code();
    wait_target(&mut v, "split");
    expect_bars(&mut v, "back in the editor", "blame.ts,new.ts[new.ts]*");

    // two tabs with the same name: "parent/name"
    edit(&v, "src/a.ts");
    edit(&v, "a.ts");
    v.wait_until("labels disambiguated", |v| {
        tab_data(v, "src/a.ts").is_some() && tab_data(v, "grepo/a.ts").is_some()
    });
}

#[test]
fn mouse_click_activates_x_and_middle_click_close_right_click_menu() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&v, "b.ts");
    expect_bars(&mut v, "two tabs", "a.ts,b.ts[b.ts]*");

    let a = tab(&mut v, "a.ts", 0);
    v.click(MouseButton::Left, a.tab.center());
    expect_bars(&mut v, "click on a tab switches to it", "a.ts,b.ts[a.ts]*");
    assert_eq!(v.lua("return vim.fn.expand('%:t')").as_str(), Some("a.ts"));
    // the keyboard stays nvim's: typing edits the file
    v.keystrokes("i z escape");
    v.wait_lua(
        "typed into a.ts",
        "return vim.api.nvim_get_current_line():sub(1, 1) == 'z'",
    );
    v.keystrokes("u");
    // a click on the status bar doesn't take it either
    let status = v.read(|e| e.geometry().layout.frame.status);
    v.click(MouseButton::Left, status.center());
    v.keystrokes("i y escape");
    v.wait_lua(
        "typed after a status bar click",
        "return vim.api.nvim_get_current_line():sub(1, 1) == 'y'",
    );
    v.keystrokes("u");

    // hover an unselected tab: its × shows; a click there closes it
    let b = tab(&mut v, "b.ts", 0);
    hover(&mut v, b.tab.center());
    v.wait_until("b.ts hovered", |v| {
        tabs(v, |t| t.hovered()) == Some((b.win, b.buf))
    });
    hover(&mut v, b.close.center());
    v.click(MouseButton::Left, b.close.center());
    expect_bars(&mut v, "click on × closes that tab", "a.ts[a.ts]*");

    // middle-click closes
    edit(&v, "c.ts");
    expect_bars(&mut v, "c.ts opened", "a.ts,c.ts[c.ts]*");
    let a = tab(&mut v, "a.ts", 0);
    v.click(MouseButton::Middle, a.tab.center());
    expect_bars(&mut v, "middle-click closes the tab", "c.ts[c.ts]*");

    // right-click: the tab menu
    edit(&v, "a.ts");
    expect_bars(&mut v, "a.ts back", "c.ts,a.ts[a.ts]*");
    let c = tab(&mut v, "c.ts", 0);
    v.click(MouseButton::Right, c.tab.center());
    v.wait_until("right-click on a tab opens the tab menu", |v| {
        menu_shows(v, "Close Tabs to the Left")
    });
    let at = menu_bounds(&mut v).unwrap();
    let click = c.tab.center();
    assert!(
        (at.origin.x - click.x).abs() < px(2.) && (at.origin.y - click.y).abs() < px(2.),
        "the tab menu's top-left at the mouse: {at:?} vs {click:?}"
    );
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| !menu_shows(v, "Close Tabs to the Left"));

    // a click on a tab gives the keyboard back to the editor
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    let c = tab(&mut v, "c.ts", 0);
    v.click(MouseButton::Left, c.tab.center());
    wait_target(&mut v, "split");
    expect_bars(&mut v, "tab clicked from the tree", "c.ts,a.ts[c.ts]*");

    // × on the selected tab, until the empty editor: Abe's face, centred in the island
    let c = tab(&mut v, "c.ts", 0);
    v.click(MouseButton::Left, c.close.center());
    expect_bars(&mut v, "× on the selected tab", "a.ts[a.ts]*");
    let a = tab(&mut v, "a.ts", 0);
    v.click(MouseButton::Left, a.close.center());
    expect_bars(&mut v, "last tab closed: the empty editor", "[]*");
    v.wait_until("empty editor slot", |v| tabs(v, |t| t.slots()[0].empty));
    let island = tabs(&mut v, |t| t.slots()[0].island);
    let face = common::gitui::bounds(&mut v, "empty-editor-face").expect("Abe's face drawn");
    assert_eq!(face.size, size(px(128.), px(128.)), "the head is 128 px");
    let (fx, ix) = (face.center().x, island.center().x);
    assert!(
        (fx - ix).abs() < px(1.),
        "centred in the island: {fx:?} vs {ix:?}"
    );
    // the main checkout, no story: it says so under the face, and the key tips are gone
    let main = common::gitui::bounds(&mut v, "empty-editor-caption").expect("a caption");
    assert!(main.top() >= face.bottom());
    let said = v
        .read_ws(|ws, cx| ws.tabs().read(cx).face_caption(cx))
        .unwrap();
    assert_eq!(
        said.iter().map(|s| s.text.as_str()).collect::<String>(),
        "Main checkout"
    );
    for tip in ["Search Everywhere", "Go to File", "Drop files here"] {
        assert!(
            !v.screen().iter().any(|l| l.contains(tip)),
            "no key tip {tip:?}"
        );
    }
    // a story's workspace: one dim line under the face saying where the story stands
    let root = v.read_ws(|ws, _| ws.project().clone());
    let dot = gpui_kit::rgba(0xd9a343ff);
    v.cx.update(|window, cx| {
        let span = |text: &str, hue| LineSpan {
            text: text.to_owned(),
            hue,
        };
        let line = vec![
            span("cart total ignores quantity · Build ", None),
            span("●", Some(dot)),
            span(" Running", None),
        ];
        cx.set_global(StoryLines([(root, line)].into_iter().collect()));
        window.refresh();
    });
    let caption = common::gitui::bounds(&mut v, "empty-editor-caption").expect("the story line");
    let face = common::gitui::bounds(&mut v, "empty-editor-face").unwrap();
    assert!(
        caption.top() >= face.bottom() + px(12.),
        "12 px under the face"
    );
    assert!((caption.center().x - ix).abs() < px(1.), "centred under it");
}

#[test]
fn splits_have_their_own_bars_keys_stay_lua() {
    let mut v = View::start("proj", &["a.ts"]);
    expect_bars(&mut v, "one split", "a.ts[a.ts]*");
    v.key(",");
    v.key("v");
    expect_bars(
        &mut v,
        ",v: the new split has the current file",
        "a.ts[a.ts] | a.ts[a.ts]*",
    );
    edit(&v, "b.ts");
    expect_bars(
        &mut v,
        "file opened in the focused split",
        "a.ts[a.ts] | a.ts,b.ts[b.ts]*",
    );
    v.keystrokes("alt-cmd-right");
    expect_bars(
        &mut v,
        "Alt+Cmd+Right: next tab (wraps)",
        "a.ts[a.ts] | a.ts,b.ts[a.ts]*",
    );
    v.keystrokes("alt-cmd-left");
    expect_bars(
        &mut v,
        "Alt+Cmd+Left: previous tab",
        "a.ts[a.ts] | a.ts,b.ts[b.ts]*",
    );

    // each bar in its own split's slot
    let slots = tabs(&mut v, |t| t.slots());
    assert_eq!(slots.len(), 2);
    let left = tab(&mut v, "a.ts", 0);
    let right = tab(&mut v, "a.ts", 1);
    assert!(slots.iter().any(|s| s.tab_bar.contains(&left.tab.center())));
    assert!(left.tab.center().x < right.tab.center().x);
    assert_ne!(left.win, right.win);

    // a click on the other split's tab focuses that split
    v.click(MouseButton::Left, left.tab.center());
    expect_bars(
        &mut v,
        "the other split focused",
        "a.ts[a.ts]* | a.ts,b.ts[b.ts]",
    );
    let b = tab(&mut v, "b.ts", 0);
    v.click(MouseButton::Middle, b.tab.center());
    expect_bars(
        &mut v,
        "middle-click closes in its split only",
        "a.ts[a.ts]* | a.ts[a.ts]",
    );
    v.lua("vim.cmd('wincmd l') return true");
    expect_bars(&mut v, "focus moved right", "a.ts[a.ts] | a.ts[a.ts]*");
    v.key(",");
    v.key("w");
    expect_bars(
        &mut v,
        ",w on a split's only tab closes the split",
        "a.ts[a.ts]*",
    );
}

#[test]
fn too_many_tabs_for_the_bar_the_hidden_tabs_button_lists_them() {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-tabs-")
        .tempdir()
        .unwrap();
    for i in 1..=10 {
        std::fs::write(
            dir.path().join(format!("file_number_{i}.ts")),
            format!("export const f{i} = {i};\n"),
        )
        .unwrap();
    }
    let path = dir.path().to_str().unwrap().to_owned();
    let mut v = View::start(&path, &["file_number_1.ts"]);
    for i in 2..=10 {
        edit(&v, &format!("file_number_{i}.ts"));
    }
    v.wait_until("10 tabs", |v| {
        tabs(v, |t| t.bars().values().any(|b| b.tabs.len() == 10))
    });
    v.cx.simulate_resize(size(px(WINDOW.0 * 0.7), px(WINDOW.1)));
    v.wait_until("some tabs hidden", |v| {
        tabs(v, |t| {
            let win = t.slots()[0].win;
            !t.hidden(win).is_empty() && t.more_button(win).is_some()
        })
    });
    let (win, hidden, more, active) = tabs(&mut v, |t| {
        let win = t.slots()[0].win;
        (
            win,
            t.hidden(win),
            t.more_button(win).unwrap(),
            t.bars()[&win].active,
        )
    });
    // the active tab is always shown; the button is inside the bar
    assert!(!hidden.contains(&active.unwrap()));
    let slot = tabs(&mut v, |t| t.slots()[0]);
    assert!(slot.tab_bar.contains(&more.center()));
    let names: Vec<String> = tabs(&mut v, |t| {
        hidden
            .iter()
            .map(|b| {
                t.bars()[&win]
                    .tabs
                    .iter()
                    .find(|x| x.buf == *b)
                    .unwrap()
                    .name
                    .clone()
            })
            .collect()
    });
    v.click(MouseButton::Left, more.center());
    let first = names[0].clone();
    v.wait_until("the button lists the hidden tabs", |v| {
        v.read_ws(|ws, cx| ws.popups().read(cx).menu_rows())
            .is_some_and(|rows| rows.len() == names.len() && rows.contains(&first))
    });
    let at = menu_bounds(&mut v).unwrap();
    assert!(at.origin.y >= more.bottom(), "the list under the button");
    // picking one shows it (the menu has the keyboard: Enter on the first)
    v.keystrokes("enter");
    expect_active(&mut v, &first);
}

fn expect_active(v: &mut View, name: &str) {
    v.wait_until(&format!("{name} active"), |v| {
        tabs(v, |t| {
            t.bars().values().any(|b| {
                b.tabs
                    .iter()
                    .any(|x| x.name == name && Some(x.buf) == b.active)
            })
        })
    });
}

#[test]
fn empty_strip_click_focuses_its_split_hints_go_once_the_buffer_has_text() {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-tabs-empty-")
        .tempdir()
        .unwrap();
    std::fs::write(dir.path().join("a.ts"), "export const a = 1;\n").unwrap();
    let path = dir.path().to_str().unwrap().to_owned();
    let mut v = View::start(&path, &[]);
    v.wait_until("the empty editor", |v| {
        tabs(v, |t| t.slots().first().is_some_and(|s| s.empty))
    });
    // a script writes into the empty editor's buffer while it isn't current (the terminal is):
    // the native hints go right away
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.lua(
        "local w = require('config.focus').split_win() local b = vim.api.nvim_win_get_buf(w) \
         vim.bo[b].modifiable = true vim.api.nvim_buf_set_lines(b, 0, -1, false, { 'scripted' }) return true",
    );
    v.wait_until("hints gone", |v| {
        tabs(v, |t| t.slots().first().is_some_and(|s| !s.empty))
    });
    v.focus_code();
    wait_target(&mut v, "split");

    // a click on a bar's empty part focuses that split
    edit(&v, "a.ts");
    v.key(",");
    v.key("v");
    v.wait_until("two bars", |v| tabs(v, |t| t.slots().len() == 2));
    v.wait_until("right split focused", |v| bars(v).ends_with('*'));
    let left = tabs(&mut v, |t| {
        let mut s = t.slots();
        s.sort_by(|a, b| a.tab_bar.origin.x.partial_cmp(&b.tab_bar.origin.x).unwrap());
        s[0]
    });
    let empty_part = gpui_kit::point(
        left.tab_bar.right() - px(12.),
        left.tab_bar.origin.y + px(12.),
    );
    v.click(MouseButton::Left, empty_part);
    v.wait_until("the left split focused", |v| {
        let b = bars(v);
        b.split(" | ").next().is_some_and(|l| l.ends_with('*'))
    });
}

// The Feel's switches -----------------------------------------------------------------------

fn mark(v: &mut View, name: &str) -> Option<CloseMark> {
    let d = tab(v, name, 0);
    v.read_ws(|ws, cx| ws.tabs().read(cx).close_mark_of(d.win, d.buf, cx))
}

#[test]
fn feel_dirty_dot_in_the_close_buttons_place() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&v, "b.ts");
    expect_bars(&mut v, "two tabs", "a.ts,b.ts[b.ts]*");
    v.keystrokes("i z escape");
    v.wait_until("b.ts sent modified", |v| {
        tab_data(v, "b.ts").is_some_and(|t| t.modified)
    });
    // VimStorm: the active tab's ×, nothing on the other
    assert_eq!(mark(&mut v, "b.ts"), Some(CloseMark::Close));
    assert_eq!(mark(&mut v, "a.ts"), Some(CloseMark::None));
    // VS Code: ● on the modified tab; × again under the mouse
    v.set_feel(|f| f.tabs.dirty_dot = true);
    assert_eq!(mark(&mut v, "b.ts"), Some(CloseMark::Dirty));
    assert_eq!(mark(&mut v, "a.ts"), Some(CloseMark::None));
    let b = tab(&mut v, "b.ts", 0);
    hover(&mut v, b.tab.center());
    v.wait_until("b.ts hovered", |v| {
        tabs(v, |t| t.hovered()) == Some((b.win, b.buf))
    });
    assert_eq!(mark(&mut v, "b.ts"), Some(CloseMark::Close));
    // saved: no dot
    v.lua("vim.cmd('silent write') return true");
    v.wait_until("b.ts saved", |v| {
        tab_data(v, "b.ts").is_some_and(|t| !t.modified)
    });
}

#[test]
fn feel_preview_tab_is_replaced_by_the_next_single_click_open() {
    let mut v = View::start("proj", &["a.ts"]);
    expect_bars(&mut v, "one tab", "a.ts[a.ts]*");
    // (the Projects root sends nvim the Feel: tests/projects.rs; this view is a Workspace's)
    v.lua("require('config.feel').set({ tabs = { preview = true }, tree = { singleClick = true } }) return true");
    let open = |v: &View, file: &str| {
        v.lua(&format!(
            "require('config.app.tree').open_files({{ vim.fn.fnamemodify('{file}', ':p') }}, {{ preview = true }}) return true"
        ));
    };
    open(&v, "b.ts");
    expect_bars(&mut v, "b.ts previewed", "a.ts,b.ts[b.ts]*");
    assert!(tab_data(&mut v, "b.ts").is_some_and(|t| t.preview));
    assert!(tab_data(&mut v, "a.ts").is_some_and(|t| !t.preview));
    open(&v, "c.ts");
    expect_bars(&mut v, "c.ts in b.ts's place", "a.ts,c.ts[c.ts]*");
    // editing pins it: the next preview opens beside it
    v.keystrokes("i z escape");
    v.wait_until("c.ts pinned", |v| {
        tab_data(v, "c.ts").is_some_and(|t| !t.preview)
    });
    open(&v, "b.ts");
    expect_bars(&mut v, "b.ts beside", "a.ts,c.ts,b.ts[b.ts]*");
}

/// Feel vscode: the file's folders, its name and the symbol at the caret are breadcrumbs
/// in a 22 px strip under the split's tab bar (the code starts under it), no longer on the status
/// bar; any other Feel puts them back there.
#[test]
fn feel_vscode_breadcrumbs_under_the_tabs_not_on_the_status_bar() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src/deep")).unwrap();
    std::fs::write(
        dir.path().join("src/deep/x.ts"),
        "export function outer() {\n  return 1;\n}\n",
    )
    .unwrap();
    let mut v = View::start(dir.path().to_str().unwrap(), &["src/deep/x.ts"]);
    expect_bars(&mut v, "x.ts open", "x.ts[x.ts]*");
    let status = |v: &mut View| v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().crumbs.clone());
    v.wait_until("VimStorm: the path on the status bar", |v| {
        status(v).ends_with(&["src".to_owned(), "deep".to_owned()])
    });
    assert!(v.cx.debug_bounds("editor-crumbs").is_none());
    let win = tabs(&mut v, |t| t.slots()[0].win);
    v.set_feel(|f| f.feel = vimstorm::factory::FeelName::Vscode);
    v.lua("require('config.feel').set({ feel = 'vscode' }) return true");
    let want: Vec<String> = ["src", "deep", "x.ts", "outer"].map(String::from).to_vec();
    v.wait_until("src › deep › x.ts › outer under the tabs", |v| {
        tabs(v, |t| t.crumbs_of(win)).as_ref() == Some(&want)
    });
    let strip = v.cx.debug_bounds("editor-crumbs").expect("the strip drawn");
    let slot = tabs(&mut v, |t| t.slots()[0]);
    assert_eq!(strip.top(), slot.tab_bar.bottom());
    assert_eq!(strip.size.height, px(22.));
    v.pump();
    let grid = v.read(|e| e.geometry().win_rect(win).map(|w| w.grid_area));
    assert_eq!(
        grid.map(|g| g.top()),
        Some(strip.bottom()),
        "the code under the strip"
    );
    assert!(status(&mut v).is_empty(), "no path on the status bar");
    // back to VimStorm: no strip, the path on the status bar again
    v.set_feel(|_| {});
    v.lua("require('config.feel').set({}) return true");
    v.wait_until("no strip", |v| tabs(v, |t| t.crumbs_of(win)).is_none());
    assert!(!status(&mut v).is_empty());
}

/// `focus.close` (,w and ,q) closes the active tab, and the last one leaves the empty editor. Cmd+Q
/// there is the app's Close Project.
#[test]
fn closing_the_last_tab_leaves_the_empty_editor() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&v, "b.ts");
    expect_bars(&mut v, "two tabs", "a.ts,b.ts[b.ts]*");
    v.lua("require('config.focus').close() return true");
    expect_bars(&mut v, "close: the active tab", "a.ts[a.ts]*");
    v.lua("require('config.focus').close() return true");
    expect_bars(&mut v, "close on the last tab: the empty editor", "[]*");
    v.wait_until("empty editor slot", empty_slot);
}

/// A double-click in the Project tree opens the file in the empty editor (line numbers back, hints
/// gone), and Enter there opens it in the last focused split.
#[test]
fn files_from_the_tree_open_in_the_empty_editor_and_last_focused_split() {
    let mut v = View::start("proj", &[]);
    v.wait_until("the empty editor", empty_slot);
    assert_eq!(v.lua("return vim.wo.number").as_bool(), Some(false));
    double_click_row(&mut v, "b.ts");
    expect_bars(
        &mut v,
        "double-click in the tree opens the file in the empty editor",
        "b.ts[b.ts]*",
    );
    v.wait_until("hints gone", |v| !empty_slot(v));
    v.wait_lua("line numbers back", "return vim.wo.number == true");

    // Enter in the tree: the last focused split (not the last created one)
    v.focus_code();
    wait_target(&mut v, "split");
    v.key(",");
    v.key("v");
    expect_bars(&mut v, ",v", "b.ts[b.ts] | b.ts[b.ts]*");
    edit(&v, "c.ts");
    expect_bars(
        &mut v,
        "c.ts in the right split",
        "b.ts[b.ts] | b.ts,c.ts[c.ts]*",
    );
    v.key(",");
    v.key("arrow_left");
    expect_bars(
        &mut v,
        ",← focuses the left split",
        "b.ts[b.ts]* | b.ts,c.ts[c.ts]",
    );
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.key("shift+digit_7");
    for k in ["a", ".", "t", "s"] {
        v.key(k);
    }
    wait_tree(&mut v, "results for a.ts", |t| {
        t.results_query() == Some("a.ts")
    });
    wait_tree(&mut v, "a.ts selected", |t| {
        t.cursor().as_deref() == Some("a.ts")
    });
    v.key("enter");
    expect_bars(
        &mut v,
        "Enter in the tree opens the file in the last focused split",
        "b.ts,a.ts[a.ts]* | b.ts,c.ts[c.ts]",
    );
}

/// The tab menu's items act on the clicked tab's split only.
#[test]
fn tab_menu_items_act_on_their_split() {
    let mut v = View::start("proj", &["a.ts"]);
    edit(&v, "b.ts");
    expect_bars(&mut v, "two tabs", "a.ts,b.ts[b.ts]*");
    tab_menu(&mut v, "b.ts", 0, "Split and Move Right");
    expect_bars(
        &mut v,
        "Split and Move Right: the file moves to a new split",
        "a.ts[a.ts] | b.ts[b.ts]*",
    );
    tab_menu(&mut v, "b.ts", 0, "Move to Opposite Group");
    expect_bars(
        &mut v,
        "Move to Opposite Group: the tab moves, the emptied split closes",
        "a.ts,b.ts[b.ts]*",
    );

    // Close ... Tabs: only the clicked tab's split
    v.key(",");
    v.key("v");
    expect_bars(&mut v, ",v", "a.ts,b.ts[b.ts] | b.ts[b.ts]*");
    edit(&v, "c.ts");
    edit(&v, "a.ts");
    expect_bars(
        &mut v,
        "three tabs on the right",
        "a.ts,b.ts[b.ts] | b.ts,c.ts,a.ts[a.ts]*",
    );
    tab_menu(&mut v, "a.ts", 1, "Close Tabs to the Left");
    expect_bars(
        &mut v,
        "Close Tabs to the Left: this split only",
        "a.ts,b.ts[b.ts] | a.ts[a.ts]*",
    );
    edit(&v, "c.ts");
    expect_bars(&mut v, "c.ts", "a.ts,b.ts[b.ts] | a.ts,c.ts[c.ts]*");
    tab_menu(&mut v, "c.ts", 0, "Close Other Tabs");
    expect_bars(
        &mut v,
        "Close Other Tabs: this split only",
        "a.ts,b.ts[b.ts] | c.ts[c.ts]*",
    );
    tab_menu(&mut v, "c.ts", 0, "Close All Tabs");
    expect_bars(
        &mut v,
        "Close All Tabs closes the split",
        "a.ts,b.ts[b.ts]*",
    );
}

/// The empty editor's buffer is untouched: one empty line, unmodified, the hints shown, no tab.
fn untouched(v: &mut View) -> bool {
    let lines = v.lua(
        "local l = vim.api.nvim_buf_get_lines(0, 0, -1, false) \
         return #l == 1 and l[1] == '' and not vim.bo.modified",
    );
    lines.as_bool() == Some(true) && empty_slot(v) && bars(v) == "[]*"
}

/// Typing, Cmd+V and p in the empty editor change nothing (no hidden untitled buffer, no Vim prompt
/// on ,w), and a file opened there edits as usual.
#[test]
fn empty_editor_takes_no_typing_or_paste() {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-ptabs-empty-")
        .tempdir()
        .unwrap();
    std::fs::write(tmp.path().join("a.txt"), "export const a = 1;\n").unwrap();
    let mut v = View::start(tmp.path().to_str().unwrap(), &[]);
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until("the empty editor", empty_slot);

    v.lua("vim.fn.setreg('+', 'pasted') return true");
    v.cx.write_to_clipboard(ClipboardItem::new_string("pasted".into()));
    v.keystrokes("cmd-v");
    v.keystrokes("i a escape o a escape p A a escape");
    v.settle();
    assert!(
        untouched(&mut v),
        "typing / Cmd+V / p in the empty editor: nothing changes ({:?}, {})",
        v.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)"),
        bars(&mut v)
    );
    v.key(",");
    v.key("w");
    v.settle();
    assert_eq!(v.mode(), "n", ",w in the empty editor: no prompt");
    assert!(untouched(&mut v), ",w in the empty editor: still empty");

    double_click_row(&mut v, "a.txt");
    expect_bars(&mut v, "a file opened in the empty editor", "a.txt[a.txt]*");
    wait_target(&mut v, "split");
    v.keystrokes("i x escape");
    v.wait_lua(
        "the file opened there can be edited",
        "return vim.fn.getline(1) == 'xexport const a = 1;'",
    );
    v.key(",");
    v.key("w");
    expect_bars(&mut v, ",w: back to the empty editor", "[]*");
    v.wait_until("empty editor slot", empty_slot);
    v.keystrokes("i a escape");
    v.settle();
    assert!(
        untouched(&mut v),
        "typing in the empty editor again: nothing changes ({:?})",
        v.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)")
    );
}

/// ,w on unsaved text with no file asks Discard or Cancel in the popup, never Vim's prompt. Cancel
/// keeps the text and Discard drops it.
#[test]
fn closing_untitled_text_asks_discard_or_cancel() {
    let mut v = View::start("proj", &["a.ts"]);
    expect_bars(&mut v, "a.ts", "a.ts[a.ts]*");
    v.lua(
        "vim.cmd.enew() vim.bo.modifiable = true \
         vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'scratch text' }) return true",
    );
    v.wait_screen("scratch text");
    let asks = |v: &mut View| {
        menu_rows(v).is_some_and(|r| {
            r.iter().any(|l| l.contains("Discard")) && r.iter().any(|l| l.contains("Cancel"))
        })
    };
    v.key(",");
    v.key("w");
    v.wait_until(",w on untitled text: the popup asks Discard / Cancel", asks);
    assert!(
        !v.screen().iter().any(|l| l.contains("Save changes")),
        "no Vim prompt"
    );
    v.keystrokes("escape");
    v.wait_until("Cancel: the popup closed", |v| menu_rows(v).is_none());
    v.wait_lua(
        "Cancel: the text is back in its tab",
        "return vim.fn.getline(1) == 'scratch text'",
    );
    v.key(",");
    v.key("w");
    v.wait_until("asks again", asks);
    pick_menu(&mut v, "Discard");
    v.wait_until("Discard: the popup closed", |v| menu_rows(v).is_none());
    v.wait_lua(
        "Discard: the tab and its text are gone",
        "return #vim.tbl_filter(function(b) \
           return vim.api.nvim_buf_get_lines(b, 0, 1, false)[1] == 'scratch text' \
         end, vim.api.nvim_list_bufs()) == 0",
    );
}

/// A move to another file from Neovim's command line (`/`, `:`), with an operator pending (`d`) or
/// at a hit-enter prompt: the file is shown and Neovim is in Normal mode (the search cancelled as Esc does: the caret back,
/// no pattern kept), whichever way it came: a tab click, the tree, the switcher, Go to File, ⌥⌘←.
#[test]
fn a_move_from_the_command_line_or_a_pending_operator_lands_in_normal_mode() {
    use common::pickers::{closed, is, type_text, wait_picker};
    type Move = fn(&mut View);
    let moves: [(&str, Move); 5] = [
        ("a tab click", |v| {
            let a = tab(v, "a.ts", 0);
            v.click(MouseButton::Left, a.tab.center());
        }),
        ("a double-click in the tree", |v| {
            double_click_row(v, "a.ts")
        }),
        ("⌃Tab, released", |v| {
            v.modifiers(Modifiers::control());
            v.key("ctrl+tab");
            v.modifiers(Modifiers::default());
        }),
        ("⌘O's pick", |v| {
            v.key("super+o");
            wait_picker(v, "Go to File", is("files"));
            type_text(v, "a.ts");
            wait_picker(v, "a.ts first", |s| {
                s.as_ref()
                    .is_some_and(|s| s.settled && s.rows.first().is_some_and(|r| r == "a.ts"))
            });
            v.key("enter");
            wait_picker(v, "picked", closed);
        }),
        ("⌥⌘←", |v| v.key("super+alt+arrow_left")),
    ];
    let mut v = View::start("proj", &["a.ts"]);
    v.lua("vim.fn.setreg('/', 'kept') return true");
    for (how, go) in moves {
        // (the last: lines that end in a hit-enter prompt, where nvim runs no Lua until a key)
        for pending in ["/expo", ":ech", "d", ":ec(1)|ec(2)|ec(3)|ec(4) enter"] {
            let row = format!("{how} from {pending:?}");
            edit(&v, "b.ts");
            expect_bars(&mut v, &format!("{row}: on b.ts"), "a.ts,b.ts[b.ts]*");
            v.wait_screen("export const b = 2;");
            v.keystrokes(pending);
            let want = match pending {
                "d" => "no",
                p if p.ends_with("enter") => "r",
                _ => "c",
            };
            v.wait_until(&format!("{row}: pending"), |v| v.mode() == want);
            go(&mut v);
            v.wait_until(&format!("{row}: a.ts shown in Normal mode"), |v| {
                // (mode first: no Lua runs at a prompt)
                v.mode() == "n"
                    && v.lua("return vim.fn.expand('%:t')").as_str() == Some("a.ts")
                    && v.screen().iter().any(|l| l.contains("export const a = 1;"))
            });
            assert_eq!(
                v.lua("return vim.fn.getcmdtype()").as_str(),
                Some(""),
                "{row}: the command line closed"
            );
            assert!(v.nvim_errors().is_empty(), "{row}: {:?}", v.nvim_errors());
        }
    }
    // the searches were cancelled: the pattern from before kept
    assert_eq!(v.lua("return vim.fn.getreg('/')").as_str(), Some("kept"));
}
