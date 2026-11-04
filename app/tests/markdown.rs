//! The markdown preview on the real nvim + config: modes per file (Editor Only, Editor and
//! Preview, Preview Only), the mode toolbar, `,m`, the right-click menus, a read-only preview that
//! follows typing, scroll sync both ways, keyboard scrolling, links, selection and copy, narrow
//! editors.

use crate::common;

use std::path::Path;

use common::view::View;
use gpui_kit::{
    Bounds, Modifiers, MouseButton, MouseUpEvent, Pixels, Point, ScrollDelta, TouchPhase, point, px,
};
use rmpv::Value;
use vimstorm::editor::markdown::PaneInfo;
use vimstorm::shell::{GapKind, Role};

/// The Lua test's files.
fn project() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-md-")
        .tempdir()
        .unwrap();
    let mut doc: Vec<String> = [
        "# Title",
        "",
        "Some **bold** text, `code` and [a link](https://example.com).",
        "",
        "## List",
        "",
        "- one",
        "- two",
        "- [ ] todo",
        "- [x] done",
        "",
        "| Col A | Col B |",
        "|-------|-------|",
        "| 1     | 2     |",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "> a quote",
        "",
        "---",
        "",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // (separate paragraphs: the Lua fixture's 120 lines are one paragraph, which renders as a
    // few wrapped lines natively; `tall.md` has a paragraph taller than the window)
    for i in 1..=120 {
        doc.push(format!("line {i}"));
        doc.push(String::new());
    }
    write(dir.path(), "doc.md", &doc.join("\n"));
    write(dir.path(), "other.md", "# Other\n\ntext\n");
    write(dir.path(), "x.ts", "export const x = 1;\n");
    let mut long = String::new();
    for i in 1..=30 {
        long.push_str(&format!("Paragraph {i} {}\n\n", "word ".repeat(120)));
    }
    write(dir.path(), "long.md", &long);
    let mut links = String::from(
        "# Links\n\n[web](https://example.com/page) and [other file](other.md) and [jump](#far-heading)\n\n",
    );
    for i in 1..=80 {
        links.push_str(&format!("filler {i}\n\n"));
    }
    links.push_str("## Far heading\n\nthe end\n");
    write(dir.path(), "links.md", &links);
    // one paragraph of 120 long lines: far taller than the window
    let mut tall = String::from("# Tall\n\n");
    for i in 1..=120 {
        tall.push_str(&format!("line {i} {}\n", "word ".repeat(30)));
    }
    tall.push_str("\nafter\n");
    write(dir.path(), "tall.md", &tall);
    // README badges (linked images) and images separated by blanks; a table whose cells mix
    // bold, inline code and links
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons/general/editorOnly_dark.svg"),
        dir.path().join("icon.svg"),
    )
    .unwrap();
    write(
        dir.path(),
        "badges.md",
        "# Badges\n\n[![CI](https://x.test/ci.svg)](https://x.test/ci)\n[![npm](https://x.test/n.svg)](https://x.test/npm)\n\n\
         ![a](icon.svg) ![b](icon.svg)\n\n| Option | Default |\n|---|---|\n| `--save-dev` **bold** [docs](https://x.test/d) | `false` |\n\n\
         see https://github.com/foo/bar for more\n",
    );
    dir
}

fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

fn start(dir: &tempfile::TempDir, file: &str) -> View {
    let mut v = View::start(dir.path().to_str().unwrap(), &[file]);
    v.ws.update(&mut v.cx, |ws, cx| {
        ws.markdown().update(cx, |m, _| m.record_links_only())
    });
    v
}

fn lua_i64(v: &View, code: &str) -> i64 {
    v.lua(code).as_i64().unwrap_or(-1)
}

/// The current tab's (first) markdown editor, as Lua sees it: `config.markdown.state()[1].<key>`.
fn state(v: &View, key: &str) -> Value {
    v.lua(&format!(
        "local s = require('config.markdown').state()[1] or {{}} return s.{key}"
    ))
}

fn mode(v: &View) -> String {
    state(v, "mode").as_str().unwrap_or("").to_owned()
}

fn cur_win(v: &View) -> i64 {
    lua_i64(v, "return vim.api.nvim_get_current_win()")
}

fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// 0-based topline of window `win`.
fn top(v: &View, win: i64) -> i64 {
    lua_i64(v, &format!("return vim.fn.line('w0', {win})")) - 1
}

fn panes(v: &mut View) -> Vec<PaneInfo> {
    v.read_ws(|ws, cx| ws.markdown().read(cx).panes())
}

fn pane(v: &mut View) -> Option<PaneInfo> {
    panes(v).into_iter().next()
}

fn drawn(v: &mut View, win: i64) -> Vec<String> {
    v.read_ws(|ws, cx| ws.markdown().read(cx).drawn_texts(win))
}

fn shows(v: &mut View, win: i64, text: &str) -> bool {
    drawn(v, win).iter().any(|t| t.contains(text))
}

fn text_at(v: &mut View, win: i64, text: &str) -> Option<Bounds<Pixels>> {
    v.read_ws(|ws, cx| ws.markdown().read(cx).text_bounds(win, text))
}

fn button(v: &mut View, win: i64, mode: &str) -> Option<Bounds<Pixels>> {
    v.read_ws(|ws, cx| ws.markdown().read(cx).toolbar_button(win, mode))
}

fn center(b: Bounds<Pixels>) -> Point<Pixels> {
    b.center()
}

/// Waits until the preview over window `win` has drawn `text`.
fn wait_drawn(v: &mut View, win: i64, text: &str) {
    v.wait_until(&format!("preview shows {text:?}"), |v| shows(v, win, text));
}

fn wait_mode(v: &mut View, want: &str) {
    v.wait_until(&format!("mode {want}"), |v| mode(v) == want);
}

/// Opens doc.md and waits for its preview's first frame.
fn open_doc(dir: &tempfile::TempDir) -> (View, i64) {
    let mut v = start(dir, "doc.md");
    v.wait_until("Editor and Preview with the preview drawn", |v| {
        pane(v).is_some_and(|p| p.rows > 0) && state(v, "preview").as_i64().is_some()
    });
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "Title");
    (v, win)
}

fn left_up(v: &mut View, at: Point<Pixels>) {
    v.cx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
}

#[test]
fn default_is_editor_and_preview_beside_the_editor() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    assert_eq!(mode(&v), "split");
    let preview = state(&v, "preview").as_i64().unwrap();
    let p = pane(&mut v).unwrap();
    assert_eq!((p.win, p.preview_win), (win, preview));
    // its window has role "markdown" (grid not drawn), right of the editor's grid, same top,
    // about half the editor area
    let (e, pr) = v.read(|ed| {
        let g = ed.geometry();
        (*g.win_rect(win).unwrap(), *g.win_rect(preview).unwrap())
    });
    assert_eq!(pr.role, Some(Role::Markdown));
    assert!(
        v.read(|ed| ed.geometry().place(pr.grid).is_none()),
        "grid not drawn"
    );
    assert!(p.bounds.left() > e.grid_area.right(), "{p:?} {e:?}");
    assert_eq!(p.bounds.top(), e.grid_area.top());
    let (ew, pw) = (e.grid_area.size.width, p.bounds.size.width);
    assert!((ew - pw).abs() < px(30.), "editor {ew:?} preview {pw:?}");
    // one island and one tab row over both (WS's editor with preview)
    assert_eq!(e.island.right(), pr.island.right());
    // raw markdown in the editor, rendered in the preview
    v.wait_screen("# Title");
    assert!(!drawn(&mut v, win).iter().any(|t| t.contains("# Title")));
    assert!(shows(&mut v, win, "one"));
    let rows = v
        .read_ws(|ws, cx| ws.markdown().read(cx).rows(win))
        .unwrap();
    assert!(
        rows.iter()
            .any(|r| matches!(&r.kind, vimstorm::editor::markdown::RowKind::Item { .. }))
    );
    // the preview is no editor tab
    assert_eq!(
        lua_i64(&v, "return #require('config.editor_tabs').splits()"),
        1
    );
    assert_eq!(
        lua_i64(
            &v,
            &format!("return #require('config.editor_tabs').tabs({win})")
        ),
        1
    );
    // focus stays in the editor
    assert_eq!(target(&v), "split");
    assert_eq!(cur_win(&v), win);
}

#[test]
fn toolbar_at_the_tab_rows_right_end() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let p = pane(&mut v).unwrap();
    let tab_bar = v.read(|ed| ed.geometry().win_rect(win).unwrap().tab_bar.unwrap());
    let split = button(&mut v, win, "split").unwrap();
    let preview = button(&mut v, win, "preview").unwrap();
    let editor = button(&mut v, win, "editor").unwrap();
    // left to right: Editor Only, Editor and Preview, Preview Only; in the tab row, at the
    // preview's right edge
    assert!(editor.left() < split.left() && split.left() < preview.left());
    assert!(tab_bar.top() <= split.top() && split.bottom() <= tab_bar.bottom());
    assert!(preview.right() <= p.bounds.right() && preview.right() > p.bounds.right() - px(20.));
}

#[test]
fn preview_is_read_only_and_follows_typing() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let preview = state(&v, "preview").as_i64().unwrap();
    let buf = state(&v, "buf").as_i64().unwrap();
    // a click into the preview makes its window current; edit keys do nothing there
    let at = center(text_at(&mut v, win, "Title").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_until("preview window current", |v| cur_win(v) == preview);
    v.ime_commit("ihello");
    v.keystrokes("escape");
    v.ime_commit("xdd");
    v.settle();
    assert!(!shows(&mut v, win, "hello"));
    assert_eq!(
        v.lua(&format!("return vim.bo[{buf}].modified")).as_bool(),
        Some(false)
    );
    assert!(shows(&mut v, win, "Title"));
    // back to the editor by a click on its text
    let at = v.cell_pos(2, 20);
    v.click(MouseButton::Left, at);
    v.wait_until("editor current", |v| cur_win(v) == win);
    // live update while typing
    v.ime_commit("3GA appended_live");
    wait_drawn(&mut v, win, "appended_live");
    v.keystrokes("escape");
    v.ime_commit("u");
    v.wait_until("undo shows in the preview", |v| {
        !shows(v, win, "appended_live")
    });
}

#[test]
fn scroll_sync_both_ways() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    // the editor scrolls: the preview's top is the editor's top line, in the same frame
    v.ime_commit("80G");
    v.wait_until("editor scrolled, preview follows", |v| {
        let t = top(v, win);
        t > 0 && pane(v).is_some_and(|p| (p.top_line - t as f64).abs() < 0.05)
    });
    for _ in 0..3 {
        v.keystrokes("ctrl-d");
        v.settle();
        let t = top(&v, win);
        let p = pane(&mut v).unwrap();
        assert!(
            (p.top_line - t as f64).abs() < 0.05,
            "{} vs {t}",
            p.top_line
        );
    }
    // the wheel over the preview: the editor's topline follows the preview's top line
    let before = top(&v, win);
    let p = pane(&mut v).unwrap();
    let at = point(p.bounds.center().x, p.bounds.center().y);
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(-240.))),
        TouchPhase::Moved,
    );
    v.wait_until("preview scrolled down, editor follows", |v| {
        let p = pane(v).unwrap();
        let t = top(v, win);
        p.top_line > before as f64 + 0.5 && t == p.top_line.floor() as i64
    });
    // the echo of that doesn't move the preview back
    let line = pane(&mut v).unwrap().top_line;
    v.settle();
    assert!((pane(&mut v).unwrap().top_line - line).abs() < 1e-6);
    // gg: both at the very top
    v.ime_commit("gg");
    v.wait_until("both at the top", |v| {
        top(v, win) == 0 && pane(v).is_some_and(|p| p.top_line.abs() < 1e-6)
    });
}

#[test]
fn toolbar_clicks_switch_modes() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let at = center(button(&mut v, win, "editor").unwrap());
    v.click(MouseButton::Left, at);
    wait_mode(&mut v, "editor");
    v.wait_until("preview closed", |v| {
        state(v, "preview").is_nil() && panes(v).is_empty()
    });
    assert_eq!(target(&v), "split");
    assert_eq!(cur_win(&v), win);
    // the toolbar moved to the editor's own tab row end
    let island = v.read(|ed| ed.geometry().win_rect(win).unwrap().island);
    v.wait_until("toolbar at the editor's right end", |v| {
        button(v, win, "preview")
            .is_some_and(|b| b.right() <= island.right() && b.right() > island.right() - px(20.))
    });
    // Preview Only: the file's own window rendered, its grid not drawn
    let at = center(button(&mut v, win, "preview").unwrap());
    v.click(MouseButton::Left, at);
    wait_mode(&mut v, "preview");
    v.wait_until("rendered in place", |v| {
        pane(v).is_some_and(|p| p.preview_win == win) && shows(v, win, "one")
    });
    assert!(!drawn(&mut v, win).iter().any(|t| t.contains("# Title")));
    let (grid, rect) = v.read(|ed| {
        let r = *ed.geometry().win_rect(win).unwrap();
        (ed.geometry().place(r.grid).is_none(), r)
    });
    assert!(grid, "the file's grid isn't drawn");
    assert_eq!(rect.role, Some(Role::Markdown));
    let p = pane(&mut v).unwrap();
    assert!(p.bounds.left() <= rect.surface_rect().left() + px(1.));
    // back to Editor and Preview by its button
    let at = center(button(&mut v, win, "split").unwrap());
    v.click(MouseButton::Left, at);
    wait_mode(&mut v, "split");
    v.wait_until("preview again", |v| state(v, "preview").as_i64().is_some());
}

#[test]
fn preview_only_is_read_only_and_scrolls_by_keys() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let buf = state(&v, "buf").as_i64().unwrap();
    v.lua("require('config.markdown').set('preview') return true");
    wait_mode(&mut v, "preview");
    v.wait_until("rendered in place", |v| {
        pane(v).is_some_and(|p| p.preview_win == win)
    });
    v.ime_commit("ihello");
    v.keystrokes("escape");
    v.ime_commit("xdd");
    v.settle();
    let lines = v.lua(&format!(
        "return table.concat(vim.api.nvim_buf_get_lines({buf}, 0, 3, false), '|')"
    ));
    assert_eq!(
        lines.as_str(),
        Some("# Title||Some **bold** text, `code` and [a link](https://example.com).")
    );
    assert_eq!(
        v.lua(&format!("return vim.bo[{buf}].modified")).as_bool(),
        Some(false)
    );
    // ö / Ctrl+D / G / gg scroll the preview (40 px steps, half pages, the ends) and the
    // window's topline follows
    let t0 = pane(&mut v).unwrap().top_line;
    for _ in 0..3 {
        v.key("ö");
    }
    v.wait_until("ö scrolled down", |v| pane(v).unwrap().top_line > t0);
    let t1 = pane(&mut v).unwrap().top_line;
    v.keystrokes("ctrl-d");
    v.wait_until("Ctrl+D scrolled further", |v| {
        pane(v).unwrap().top_line > t1 + 1.
    });
    v.ime_commit("G");
    v.wait_until("G: the end, the window's topline follows", |v| {
        let p = pane(v).unwrap();
        p.top_line > 150. && top(v, win) == p.top_line.floor() as i64
    });
    v.ime_commit("gg");
    v.wait_until("gg: the top", |v| pane(v).unwrap().top_line < 0.01);
    // counts: 5G / 3gg put that line at the top (line 5 = "## List", a row's start)
    v.ime_commit("5G");
    v.wait_until("5G", |v| (pane(v).unwrap().top_line - 4.).abs() < 0.01);
    v.ime_commit("3gg");
    v.wait_until("3gg", |v| (pane(v).unwrap().top_line - 2.).abs() < 0.01);
}

#[test]
fn leader_m_cycles_the_modes() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    v.lua("require('config.markdown').set('preview') return true");
    wait_mode(&mut v, "preview");
    v.keystrokes(", m");
    wait_mode(&mut v, "editor");
    // raw text with line numbers again: the grid is drawn
    v.wait_until("grid drawn with line numbers", |v| {
        let drawn = v.read(|ed| {
            let g = ed.geometry();
            g.win_rect(win)
                .is_some_and(|r| r.role.is_none() && g.place(r.grid).is_some())
        });
        drawn
            && v.screen()
                .iter()
                .any(|l| l.contains("1") && l.contains("# Title"))
    });
    assert!(panes(&mut v).is_empty());
    v.keystrokes(", m");
    wait_mode(&mut v, "split");
    v.wait_until("preview drawn", |v| pane(v).is_some_and(|p| p.rows > 0));
}

#[test]
fn menus_and_modes_per_file() {
    let dir = project();
    let (mut v, _win) = open_doc(&dir);
    // editor right-click: the three layouts, the current one checked, ,m on the next one
    let at = v.cell_pos(6, 20);
    v.click(MouseButton::Right, at);
    v.wait_lua(
        "menu with the layouts",
        "local s = require('config.menu').shown() or {} local t = table.concat(s, '|') \
         return t:find('Editor Only', 1, true) ~= nil and t:find('Editor and Preview  ✓', 1, true) ~= nil \
         and t:find('Preview Only', 1, true) ~= nil",
    );
    // speed search (`/` is Shift+7 on the Swedish layout), then Enter
    v.wait_until("native menu open", |v| {
        v.read_ws(|ws, cx| ws.popups().read(cx).menu_rows().is_some())
    });
    v.key("shift+7");
    for c in "preview only".chars() {
        let k = if c == ' ' {
            "space".to_string()
        } else {
            c.to_string()
        };
        v.key(&k);
    }
    v.wait_until("filtered to Preview Only", |v| {
        v.read_ws(|ws, cx| ws.popups().read(cx).menu_rows().unwrap_or_default())
            .iter()
            .filter(|r| !r.trim().is_empty())
            .all(|r| r.contains("Preview Only"))
    });
    v.keystrokes("enter");
    wait_mode(&mut v, "preview");
    // another file in the same split: no toolbar, no preview
    v.lua("vim.cmd.edit('x.ts') return true");
    v.wait_until("x.ts: no markdown editor", |v| {
        v.read_ws(|ws, cx| ws.markdown().read(cx).wins().is_empty()) && panes(v).is_empty()
    });
    v.wait_screen("export const x");
    // and its line numbers back, drawn in the number column
    v.wait_lua("x.ts: line numbers", "return vim.wo.number == true");
    v.wait_until("x.ts drawn with its line number", |v| {
        v.screen().iter().any(|l| {
            l.trim_start().strip_prefix('1').is_some_and(|rest| {
                rest.starts_with(' ') && rest.trim_start().starts_with("export const x")
            })
        })
    });
    // its menu has no layout items
    let at = v.cell_of("export const x");
    let at = v.cell_pos(at.0, at.1 + 2);
    v.click(MouseButton::Right, at);
    v.wait_lua(
        "ts menu",
        "local s = require('config.menu').shown() or {} return #s > 0",
    );
    assert_eq!(
        v.lua(
            "return table.concat(require('config.menu').shown() or {}, '|'):find('Preview Only', 1, true) == nil"
        )
        .as_bool(),
        Some(true)
    );
    v.keystrokes("escape");
    // back to doc.md: Preview Only remembered
    v.lua("vim.cmd.edit('doc.md') return true");
    wait_mode(&mut v, "preview");
    // another markdown file: the default
    v.lua("vim.cmd.edit('other.md') return true");
    v.wait_until("other.md in Editor and Preview", |v| {
        mode(v) == "split" && state(v, "preview").as_i64().is_some()
    });
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "Other");
}

#[test]
fn preview_scroll_keys_on_long_paragraphs() {
    let dir = project();
    let mut v = start(&dir, "long.md");
    v.wait_until("preview of long.md", |v| {
        pane(v).is_some_and(|p| p.rows > 0)
    });
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "Paragraph 1");
    // the preview window current: Ctrl+Shift+Ö scrolls it (3 steps of 40 px a press)
    let preview = state(&v, "preview").as_i64().unwrap();
    v.lua(&format!(
        "vim.api.nvim_set_current_win({preview}) return true"
    ));
    v.wait_until("preview current", |v| cur_win(v) == preview);
    let mut last = pane(&mut v).unwrap().top_line;
    for step in 0..8 {
        v.key("ctrl+shift+ö");
        v.wait_until(&format!("step {step} scrolled"), |v| {
            pane(v).unwrap().top_line > last
        });
        last = pane(&mut v).unwrap().top_line;
        assert!(shows(&mut v, win, "Paragraph"));
    }
    // the editor followed
    v.wait_until("editor follows", |v| top(v, win) == last.floor() as i64);
}

#[test]
fn links_open_the_browser_files_and_anchors() {
    let dir = project();
    let mut v = start(&dir, "links.md");
    v.wait_until("preview of links.md", |v| {
        pane(v).is_some_and(|p| p.rows > 0)
    });
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "web");
    // http(s): the browser
    let at = center(text_at(&mut v, win, "web").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_until("web link opened", |v| {
        v.read_ws(|ws, cx| ws.markdown().read(cx).opened().to_vec())
            == vec!["https://example.com/page".to_string()]
    });
    // #anchor: the preview scrolls to the heading (as far as the page goes: it's near the end)
    let at = center(text_at(&mut v, win, "jump").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_until("scrolled to the heading", |v| {
        let p = pane(v).unwrap();
        p.top_line > 100.
            && text_at(v, win, "Far heading").is_some_and(|b| p.bounds.contains(&b.center()))
    });
    // the editor follows as far as nvim scrolls (its last line stays at the window's bottom)
    v.wait_until("editor follows", |v| top(v, win) > 100);
    // a relative file: opened in the editor split
    v.ime_commit("gg");
    v.wait_until("back at the top", |v| pane(v).unwrap().top_line < 0.01);
    wait_drawn(&mut v, win, "other file");
    let at = center(text_at(&mut v, win, "other file").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_lua(
        "other.md opened in the editor",
        &format!(
            "return vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf({win})):match('other%.md$') ~= nil \
             and vim.api.nvim_get_current_win() == {win}"
        ),
    );
}

#[test]
fn selection_copy_and_the_preview_menu() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let preview = state(&v, "preview").as_i64().unwrap();
    // drag from "Some" to the end of "bold"
    let a = text_at(&mut v, win, "Some").unwrap();
    let b = text_at(&mut v, win, " text,").unwrap();
    let from = point(a.left() + px(1.), a.center().y);
    let to = point(b.left(), b.center().y);
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    left_up(&mut v, to);
    v.wait_until("selection", |v| {
        pane(v).and_then(|p| p.selection) == Some("Some bold".to_string())
    });
    v.wait_until("preview window current", |v| cur_win(v) == preview);
    // Cmd+C copies it (pads around inline code never copied)
    v.keystrokes("cmd-c");
    v.wait_lua("copied", "return vim.fn.getreg('+') == 'Some bold'");
    // Cmd+A + Cmd+C: everything
    v.keystrokes("cmd-a");
    v.keystrokes("cmd-c");
    v.wait_lua(
        "copied all",
        "local r = vim.fn.getreg('+') return r:find('^Title\\nSome bold text, code and a link') ~= nil and r:find('line 120', 1, true) ~= nil",
    );
    // right-click in the preview: Copy + the layouts (current checked)
    let at = center(text_at(&mut v, win, "Title").unwrap());
    v.click(MouseButton::Right, at);
    v.wait_lua(
        "preview menu",
        "local t = table.concat(require('config.menu').shown() or {}, '|') \
         return t:find('Copy', 1, true) ~= nil and t:find('Editor and Preview  ✓', 1, true) ~= nil",
    );
    v.keystrokes("escape");
}

#[test]
fn closing_the_preview_by_hand_is_editor_only() {
    let dir = project();
    let (mut v, _win) = open_doc(&dir);
    let preview = state(&v, "preview").as_i64().unwrap();
    v.lua(&format!(
        "vim.api.nvim_win_close({preview}, false) return true"
    ));
    wait_mode(&mut v, "editor");
    v.wait_until("no preview drawn", |v| panes(v).is_empty());
}

/// The editor and preview's widths (columns).
fn pair_widths(v: &View) -> (i64, i64) {
    let w = v.lua(
        "local s = require('config.markdown').state()[1] or {} \
         if not s.preview then return { -1, -1 } end \
         return { vim.api.nvim_win_get_width(s.win), vim.api.nvim_win_get_width(s.preview) }",
    );
    let w = w.as_array().unwrap();
    (w[0].as_i64().unwrap(), w[1].as_i64().unwrap())
}

/// The gap right of editor window `win` (its preview's left edge) dragged `cells` columns.
fn drag_pair_gap(v: &mut View, win: i64, cells: f32) {
    let g = v.read(|ed| ed.geometry().clone());
    let (_, c, w, _) = g.win_rect(win).expect("the editor laid out").logical;
    let gap = *g
        .layout
        .gaps
        .iter()
        .find(|gap| matches!(gap.kind, GapKind::Vertical { col, .. } if col == c + w))
        .expect("the gap between the editor and its preview");
    let from = gap.bounds.center();
    let to = point(from.x + px(g.layout.x_editor.scale * cells), from.y);
    v.drag(
        from,
        to,
        &format!("return vim.fn.getmousepos().screencol == {}", c + w + 1),
    );
}

/// The preview's share is within a column of `share`.
fn at_share(v: &View, share: f64) -> bool {
    let (e, p) = pair_widths(v);
    p > 0 && (p as f64 - share * (e + p) as f64).abs() <= 1.
}

/// The divider between the editor and its preview drags (the preview down to ~20 columns, well
/// under 40%); the share is kept when the window resizes, another file's preview opens at it, and
/// so does this file's again.
#[test]
fn dragging_the_preview_divider_keeps_its_share() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let (e, p) = pair_widths(&v);
    let total = e + p;
    // the preview to a quarter (at least its 20 columns)
    let want = (total / 4).max(21);
    assert!((want as f64) < 0.4 * total as f64, "a quarter of {total}");
    drag_pair_gap(&mut v, win, (p - want) as f32);
    v.wait_until("the preview a quarter wide", |v| pair_widths(v).1 == want);
    let share = want as f64 / total as f64;
    // dragged further right: it stops at its least, 20 columns
    drag_pair_gap(&mut v, win, 15.);
    v.wait_until("the preview at its least", |v| pair_widths(v).1 == 20);
    let least = 20. / total as f64;
    // back to a quarter by :vertical resize in the editor
    v.lua(&format!(
        "vim.api.nvim_win_call({win}, function() vim.cmd('vertical resize {}') end) return true",
        total - want
    ));
    v.wait_until("a quarter again", |v| pair_widths(v).1 == want);
    assert!(least < share);
    // the window wider: the share kept
    v.cx.simulate_resize(gpui_kit::size(px(1300.), px(880.)));
    v.settle();
    v.wait_until("the share kept in a wider window", |v| at_share(v, share));
    // another file: its preview opens at that share; this one's again too
    v.lua("vim.cmd.edit('other.md') return true");
    v.wait_until("other.md's preview at the share", |v| {
        state(v, "buf").as_i64().is_some()
            && v.lua("return vim.fn.expand('%:t')").as_str() == Some("other.md")
            && at_share(v, share)
    });
    v.lua("vim.cmd.edit('doc.md') return true");
    v.wait_until("doc.md's preview at the share again", |v| {
        v.lua("return vim.fn.expand('%:t')").as_str() == Some("doc.md") && at_share(v, share)
    });
}

#[test]
fn narrow_editors_get_no_toolbar_or_preview() {
    let dir = project();
    let (mut v, _win) = open_doc(&dir);
    // four side-by-side splits (each under 30 columns), then Editor and Preview again
    v.lua("require('config.markdown').set('editor') return true");
    wait_mode(&mut v, "editor");
    v.lua("vim.cmd('vsplit | vsplit | vsplit | wincmd =') require('config.markdown').set('split') return true");
    v.wait_until("narrow: no preview, no toolbar", |v| {
        let wins = v.read_ws(|ws, cx| ws.markdown().read(cx).wins().to_vec());
        !wins.is_empty() && wins.iter().all(|w| w.preview.is_none() && !w.bar)
    });
    assert!(panes(&mut v).is_empty());
    let w = cur_win(&v);
    assert!(button(&mut v, w, "split").is_none());
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Perf on a 2000-line README (`cargo test --test app markdown::perf -- --nocapture`): parse time (off
/// the UI thread), a frame with the preview vs without, key -> flush while typing with the preview
/// open vs Editor Only. Only the parse has a (loose) budget: the rest depends on the machine.
#[test]
fn perf_big_readme() {
    let dir = project();
    // a README-like page: headings, paragraphs, lists, tasks, quotes, code, tables (2040 lines)
    let chunk = "# Section\n\nA paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com).\n\
        This line is long so that it wraps across several lines in the preview pane, like a README's.\n\n\
        ## Lists\n\n- First bullet\n- Second bullet\n  - Nested bullet\n    - Third level\n- Back\n\n\
        1. Step one\n2. Step two\n   1. Nested step\n3. Step three\n\n- [x] Done task\n- [ ] Open task\n\n\
        ### Quote and code\n\n> A blockquote with **bold** text.\n> It continues.\n\n```ts\n\
        // Fetch a user by id\ninterface User { id: number; name: string }\n\n\
        export async function getUser(id: number): Promise<User> {\n  const res = await fetch('/api/' + id);\n\
          if (!res.ok) throw new Error('not found');\n  return res.json();\n}\n```\n\n\
        | Name | Kind | Size |\n|:-----|:----:|-----:|\n| alpha | file | 12 |\n| beta | folder | 345 |\n\n---\n\n";
    let sample = chunk.repeat(2040 / chunk.lines().count() + 1);
    write(dir.path(), "README.md", &sample);
    let lines = sample.lines().count();
    let mut v = start(&dir, "README.md");
    v.wait_until("big preview", |v| pane(v).is_some_and(|p| p.rows > 100));
    let parse = v
        .read_ws(|ws, cx| ws.markdown().read(cx).last_parse())
        .unwrap();
    let frame = |v: &mut View| {
        let mut t = Vec::new();
        for _ in 0..20 {
            let s = std::time::Instant::now();
            v.ws.update(&mut v.cx, |_, cx| cx.notify());
            v.pump();
            t.push(s.elapsed().as_secs_f64() * 1000.);
        }
        median(t)
    };
    let typing = |v: &mut View| {
        v.ime_commit("Go");
        v.settle();
        let mut times = Vec::new();
        for i in 0..40 {
            let key = ["a", "b", "c", "d", "e"][i % 5];
            let before = v.ui(|ui| ui.flushes);
            let t = std::time::Instant::now();
            v.keystrokes(key);
            v.wait_until("typed", |v| {
                v.ui(|ui| ui.flushes) > before && v.current_line().len() > i
            });
            times.push(t.elapsed().as_secs_f64() * 1000.);
        }
        v.keystrokes("escape");
        v.ime_commit("u");
        v.settle();
        median(times)
    };
    let f_split = frame(&mut v);
    // a new width (divider drag, window resize): every row laid out again
    let mut relayout = Vec::new();
    for w in [900., 936.] {
        let s = std::time::Instant::now();
        v.cx.simulate_resize(gpui_kit::size(px(w), px(880.)));
        v.pump();
        relayout.push(s.elapsed().as_secs_f64() * 1000.);
    }
    let t_split = typing(&mut v);
    // the typed line reaches the preview (40 ms coalescing + parse + layout)
    v.ime_commit("ggOlive_marker_xyz");
    let s = std::time::Instant::now();
    let win = state(&v, "win").as_i64().unwrap();
    v.wait_until("live update", |v| shows(v, win, "live_marker_xyz"));
    let live = s.elapsed().as_secs_f64() * 1000.;
    v.keystrokes("escape");
    v.ime_commit("u");
    v.lua("require('config.markdown').set('editor') return true");
    wait_mode(&mut v, "editor");
    v.settle();
    let f_editor = frame(&mut v);
    let t_editor = typing(&mut v);
    eprintln!(
        "[perf] {lines} lines: parse {parse:?} (background); frame with preview {f_split:.2} ms vs \
         editor only {f_editor:.2} ms; new width (all rows re-laid out) {relayout:.1?} ms; key -> flush median {t_split:.2} ms (preview) vs \
         {t_editor:.2} ms (editor only); typed text in the preview after {live:.0} ms (40 ms coalescing)"
    );
    assert!(parse.as_millis() < 1000, "parse {parse:?}");
}

#[test]
fn scrollbar_drag_scrolls_the_preview() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let p = pane(&mut v).unwrap();
    let x = p.bounds.right() - px(7.);
    let from = point(x, p.bounds.top() + px(10.));
    let to = point(x, p.bounds.top() + px(200.));
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    left_up(&mut v, to);
    v.wait_until("scrolled by the thumb, the editor follows", |v| {
        let p = pane(v).unwrap();
        p.top_line > 20. && top(v, win) == p.top_line.floor() as i64
    });
    // no selection or window change from a scrollbar drag
    assert!(pane(&mut v).unwrap().selection.is_none());
}

#[test]
// (debug selectors exist in debug builds only)
#[cfg_attr(not(debug_assertions), ignore = "needs debug_bounds (debug builds)")]
fn badges_and_blank_separated_images_render_and_click() {
    // (P1: an all-blank text piece between images crashed the parser and the app)
    let dir = project();
    let mut v = start(&dir, "badges.md");
    v.wait_until("badges preview", |v| pane(v).is_some_and(|p| p.rows >= 4));
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "Badges");
    // the app is alive and the rows are there: heading, badges, images, table, autolinked URL
    let rows = v
        .read_ws(|ws, cx| ws.markdown().read(cx).rows(win))
        .unwrap();
    assert_eq!(rows.len(), 5, "{rows:#?}");
    // a remote badge shows its alt text; a click opens its link
    v.wait_until("badge drawn", |v| {
        v.cx.debug_bounds("md-badge-https://x.test/ci").is_some()
    });
    let at =
        v.cx.debug_bounds("md-badge-https://x.test/ci")
            .unwrap()
            .center();
    v.click(MouseButton::Left, at);
    v.wait_until("badge link opened", |v| {
        v.read_ws(|ws, cx| ws.markdown().read(cx).opened().to_vec())
            .contains(&"https://x.test/ci".to_string())
    });
    // a bare URL is a link
    let at = center(text_at(&mut v, win, "github.com").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_until("autolink opened", |v| {
        v.read_ws(|ws, cx| ws.markdown().read(cx).opened().to_vec())
            .contains(&"https://github.com/foo/bar".to_string())
    });
}

#[test]
fn table_cells_with_bold_code_and_links_dont_wrap() {
    let dir = project();
    let mut v = start(&dir, "badges.md");
    v.wait_until("badges preview", |v| pane(v).is_some_and(|p| p.rows >= 4));
    let win = state(&v, "win").as_i64().unwrap();
    // (Preview Only: the whole editor width, room for the table)
    v.lua("require('config.markdown').set('preview') return true");
    wait_mode(&mut v, "preview");
    v.wait_until("in place", |v| {
        pane(v).is_some_and(|p| p.preview_win == win)
    });
    wait_drawn(&mut v, win, "docs");
    // the columns are measured with the cells' real runs: one line each (waits: the first
    // frames after the mode switch can still be laid out at the split's narrower width)
    for cell in ["docs", "false"] {
        v.wait_until("cell on one line", |v| {
            v.read_ws(|ws, cx| ws.markdown().read(cx).text_lines(win, cell)) == Some(1)
        });
    }
}

#[test]
fn a_click_in_the_preview_takes_the_keyboard_from_the_tree() {
    let dir = project();
    let (mut v, win) = open_doc(&dir);
    let preview = state(&v, "preview").as_i64().unwrap();
    // the native tree has the keyboard
    v.lua("require('config.app').focus('tree') return true");
    v.wait_until("tree focused", |v| {
        v.read_ws(|ws, _| ws.native_focus() == Some("tree"))
    });
    let at = center(text_at(&mut v, win, "Title").unwrap());
    v.click(MouseButton::Left, at);
    v.wait_until("keyboard back in nvim, the preview current", |v| {
        v.read_ws(|ws, _| ws.native_focus().is_none()) && cur_win(v) == preview
    });
    // its keys reach nvim: ö scrolls the preview
    let t0 = pane(&mut v).unwrap().top_line;
    for _ in 0..3 {
        v.key("ö");
    }
    v.wait_until("ö scrolled the preview", |v| {
        pane(v).unwrap().top_line > t0
    });
}

#[test]
fn sync_inside_a_paragraph_taller_than_the_window() {
    let dir = project();
    let mut v = start(&dir, "tall.md");
    v.wait_until("tall preview", |v| pane(v).is_some_and(|p| p.rows == 3));
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "line 1 ");
    // the editor's top line inside the paragraph: the preview's top is that line of it
    v.ime_commit("60Gzt");
    v.wait_until("preview follows inside the row", |v| {
        let t = top(v, win);
        t > 40 && pane(v).is_some_and(|p| (p.top_line - t as f64).abs() < 0.05)
    });
    // the wheel inside the row: the editor's topline follows by line
    let before = top(&v, win);
    let p = pane(&mut v).unwrap();
    v.scroll(
        p.bounds.center(),
        ScrollDelta::Pixels(point(px(0.), px(-200.))),
        TouchPhase::Moved,
    );
    v.wait_until("editor follows inside the row", |v| {
        let p = pane(v).unwrap();
        let t = top(v, win);
        t > before && t == p.top_line.floor() as i64
    });
}

#[test]
fn remote_images_are_fetched_and_laid_out_at_their_size() {
    // a local HTTP server with a 40 x 60 PNG (its header is all the layout reads)
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend(40u32.to_be_bytes());
    png.extend(60u32.to_be_bytes());
    png.extend([8, 6, 0, 0, 0]);
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server.local_addr().unwrap().port();
    let body = png.clone();
    std::thread::spawn(move || {
        use std::io::{Read as _, Write as _};
        for mut s in server.incoming().flatten() {
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        }
    });
    let cache = common::fresh_image_cache();
    let dir = project();
    // a served image, then one whose server refuses (port 1): its alt text stays
    write(
        dir.path(),
        "remote.md",
        &format!(
            "# Remote\n\n![pic](http://127.0.0.1:{port}/a.png)\n\nbetween\n\n![gone](http://127.0.0.1:1/b.png)\n\nthe end\n"
        ),
    );
    let mut v = start(&dir, "remote.md");
    v.wait_until("preview", |v| pane(v).is_some_and(|p| p.rows >= 5));
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "the end");
    // fetched (off the UI thread) into the cache, its row re-laid out 60 px tall
    let gap = |v: &mut View, a: &str, b: &str| {
        let (a, b) = (text_at(v, win, a), text_at(v, win, b));
        a.zip(b).map(|(a, b)| (b.top() - a.bottom()).as_f32())
    };
    v.wait_until("image laid out", |v| {
        gap(v, "Remote", "between").is_some_and(|g| g >= 60. + 2. * 16. - 2.)
    });
    let alt = gap(&mut v, "between", "the end").unwrap();
    assert!(alt < 60., "the failed one stays a line of alt text: {alt}");
    assert!(
        std::fs::read_dir(&cache)
            .unwrap()
            .any(|e| { e.unwrap().path().extension().is_some_and(|x| x == "png") })
    );
}

#[test]
#[cfg_attr(not(debug_assertions), ignore = "needs debug_bounds (debug builds)")]
fn kbd_outlined_and_fence_copy_button() {
    let dir = project();
    write(
        dir.path(),
        "code.md",
        "# Code\n\nsee `abcdefghij` and <kbd>Cmd</kbd> here\n\n```ts\nconst y = 2;\n```\n",
    );
    let mut v = start(&dir, "code.md");
    v.wait_until("preview", |v| pane(v).is_some_and(|p| p.rows >= 3));
    let win = state(&v, "win").as_i64().unwrap();
    wait_drawn(&mut v, win, "const y");
    // (inline code's 90 % font: the test text system has fixed advances; see the shot)
    assert!(text_at(&mut v, win, "abcdefghij").is_some());
    // <kbd>: a 1 px #323438 outline around its tint
    let kbd = text_at(&mut v, win, "Cmd").unwrap();
    let border = vimstorm::look::hsla(vimstorm::editor::markdown::KBD_BORDER.rgba());
    let outlined = v.cx.update(|window, _| {
        let s = window.scale_factor();
        window.painted_quads().into_iter().any(|q| {
            q.border_color == border
                && q.bounds.origin.y.0 / s <= kbd.top().as_f32() + 1.
                && (q.bounds.origin.x.0 + q.bounds.size.width.0) / s > kbd.right().as_f32()
                && q.bounds.origin.x.0 / s < kbd.left().as_f32()
        })
    });
    assert!(outlined, "kbd outline");
    // the fence's copy button shows while it's hovered; a click copies the code
    let code = text_at(&mut v, win, "const y").unwrap();
    v.cx.simulate_mouse_move(code.center(), None, Modifiers::default());
    v.pump();
    let b =
        v.cx.debug_bounds("button-md-copy")
            .expect("copy button drawn");
    v.click(MouseButton::Left, b.center());
    v.wait_until("copied", |v| {
        v.cx.read_from_clipboard()
            .and_then(|c| c.text())
            .is_some_and(|t| t.trim_end() == "const y = 2;")
    });
}
