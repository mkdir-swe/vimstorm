//! The app's LSP floats on the real nvim + config + vtsls, none of them drawn by nvim: the
//! completion menu follows typing (lined up under the typed word, selection moves without
//! inserting, Tab or a click accepts), signature help, the hover popup (gh shows the declaration
//! and docs as colored markdown, gh twice focuses it, Esc or a caret move closes it, drag and
//! Cmd+C copy what's shown), the error popup (,e), the mouse tooltip and Quick Definition (Cmd+L).

use crate::common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::gitui::wait_target;
use common::tree::row_point;
use common::view::View;
use gpui_kit::{Bounds, Modifiers, MouseButton, Pixels, Point, point, px};
use vimstorm::editor::floats::{DocKind, Shown};

/// Generous: vtsls loads the project on first use.
const LSP_TIMEOUT: Duration = Duration::from_secs(60);

fn project() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-floats-")
        .tempdir()
        .unwrap();
    let files: &[(&str, &str)] = &[
        (
            "tsconfig.json",
            r#"{ "compilerOptions": { "strict": true }, "include": ["**/*.ts"] }"#,
        ),
        (
            "err.ts",
            "export function period(start: Date) {\n  const range = {\n    from: quux(start, 'YYYY'),\n  };\n  return range;\n}\n",
        ),
        (
            "a.ts",
            "export const a = 1;\n\nexport function add(x: number, y: number) {\n  return x + y;\n}\n",
        ),
        (
            "hints.ts",
            "import { add } from \"./a\";\n\nexport const n = add(1, 2)\n",
        ),
        (
            "over.ts",
            "export function over(a: string): string;\nexport function over(a: number, b: number): number;\nexport function over(a: unknown, b?: unknown) { return a; }\nexport const o = 1;\n",
        ),
        (
            "doc.ts",
            "/** Adds two numbers. */\nexport function sum(a: number, b: number): number { return a + b; }\nconst isTimeout = sum(1, 2) > 3;\nexport const total = isTimeout;\n",
        ),
    ];
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    dir
}

fn start(dir: &Path, file: &str) -> View {
    let v = View::start(dir.to_str().unwrap(), &[file]);
    v.lua(&format!("vim.cmd.edit('{file}') return true"));
    v
}

fn shown(v: &mut View) -> Shown {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|window, cx| ws.read(cx).floats().read(cx).shown(window))
}

/// Waits (nvim events wake it) until `pred` holds on what the floats show.
fn wait_shown(
    v: &mut View,
    label: &str,
    timeout: Duration,
    pred: impl Fn(&Shown) -> bool,
) -> Shown {
    let deadline = Instant::now() + timeout;
    loop {
        let s = shown(v);
        if pred(&s) {
            return s;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for: {label}\n{s:#?}\n--- screen ---\n{}",
            v.screen().join("\n")
        );
        v.settle();
    }
}

/// Waits for a Lua condition with a long timeout (the language server).
fn wait_lsp(v: &mut View, label: &str, code: &str) {
    let deadline = Instant::now() + LSP_TIMEOUT;
    while v.lua(code).as_bool() != Some(true) {
        assert!(Instant::now() < deadline, "timed out waiting for: {label}");
        v.settle();
    }
}

/// Keys until the floats show what `pred` wants (the server may still be loading).
fn until_shown(v: &mut View, keys: &str, label: &str, pred: impl Fn(&Shown) -> bool) -> Shown {
    until_shown_from(v, None, keys, label, pred)
}

/// [`until_shown`], `reset` (Lua) run before each try (a retry starts from the same text).
fn until_shown_from(
    v: &mut View,
    reset: Option<&str>,
    keys: &str,
    label: &str,
    pred: impl Fn(&Shown) -> bool,
) -> Shown {
    let deadline = Instant::now() + LSP_TIMEOUT;
    loop {
        if let Some(code) = reset {
            v.wait_lua("normal mode", "return vim.api.nvim_get_mode().mode == 'n'");
            v.lua(code);
        }
        input(v, keys);
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            let s = shown(v);
            if pred(&s) {
                return s;
            }
            v.settle();
        }
        assert!(
            Instant::now() < deadline,
            "timed out: {label}\n{:#?}",
            shown(v)
        );
        input(v, "<Esc>");
    }
}

/// Keys in nvim notation straight to nvim (`nvim_input`).
fn input(v: &View, keys: &str) {
    v.request("nvim_input", vec![keys.into()]);
}

fn at(v: &View, line: usize, col: usize) {
    v.lua(&format!(
        "vim.api.nvim_win_set_cursor(0, {{ {line}, {col} }}) return true"
    ));
}

fn screen_has(v: &mut View, text: &str) -> bool {
    v.screen().iter().any(|l| l.contains(text))
}

fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn cursor(v: &View) -> (i64, i64) {
    let c = v.lua("return vim.api.nvim_win_get_cursor(0)");
    let a = c.as_array().unwrap();
    (a[0].as_i64().unwrap(), a[1].as_i64().unwrap())
}

const ERR: &str = "TS2304: Cannot find name 'quux'.";

#[test]
fn error_popup_and_tooltip_are_native() {
    let dir = project();
    let mut v = start(dir.path(), "err.ts");
    wait_lsp(
        &mut v,
        "vtsls reports the error",
        "return #vim.diagnostic.get(0, { lnum = 2 }) > 0",
    );

    // ,e: the error, code once, in the native popup (nvim draws nothing)
    at(&v, 3, 10);
    input(&v, ",e");
    let s = wait_shown(&mut v, ",e shows the error", Duration::from_secs(5), |s| {
        s.hover.as_ref().is_some_and(|(_, t)| t.contains(ERR))
    });
    assert!(!s.hover.unwrap().1.contains("(2304)"), "no code suffix");
    assert!(
        !screen_has(&mut v, "Cannot find name"),
        "nvim draws no float"
    );
    v.keystrokes("escape");
    wait_shown(&mut v, "Esc closes it", Duration::from_secs(5), |s| {
        s.hover.is_none()
    });

    // gh: the same popup; a caret move closes it
    input(&v, "gh");
    wait_shown(&mut v, "gh shows the error", Duration::from_secs(10), |s| {
        s.hover
            .as_ref()
            .is_some_and(|(k, t)| *k == DocKind::Hover && t.contains(ERR))
    });
    v.key("ä");
    wait_shown(
        &mut v,
        "the caret moving closes it",
        Duration::from_secs(5),
        |s| s.hover.is_none(),
    );

    // gh twice: into the popup (WebStorm's Ctrl+Q twice); Esc closes it, the caret where it was
    at(&v, 3, 10);
    input(&v, "gh");
    wait_shown(&mut v, "gh again", Duration::from_secs(10), |s| {
        s.hover.is_some()
    });
    input(&v, "gh");
    wait_shown(&mut v, "gh twice focuses it", Duration::from_secs(5), |s| {
        s.hover_focused
    });
    v.wait_lua(
        "focus target: popup",
        "return require('config.focus').target() == 'popup'",
    );
    v.key("ö"); // scrolls it, doesn't move the caret
    v.keystrokes("escape");
    let s = wait_shown(
        &mut v,
        "Esc closes the focused popup",
        Duration::from_secs(5),
        |s| s.hover.is_none() && !s.hover_focused,
    );
    assert!(!s.hover_focused);
    v.wait_lua(
        "back in the code",
        "return require('config.focus').target() == 'split'",
    );
    assert_eq!(cursor(&v), (3, 10));
    assert_eq!(v.mode(), "n");
    // ,e twice too
    input(&v, ",e");
    wait_shown(&mut v, ",e", Duration::from_secs(5), |s| s.hover.is_some());
    input(&v, ",e");
    wait_shown(&mut v, ",e twice focuses it", Duration::from_secs(5), |s| {
        s.hover_focused
    });
    v.keystrokes("escape");
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.hover.is_none()
    });
    assert_eq!(target(&v), "split");

    // gh, then the caret moves before the answer: no popup for the old spot
    input(&v, "gh");
    v.key("ö");
    v.settle();
    std::thread::yield_now();
    let s = shown(&mut v);
    assert!(s.hover.is_none(), "{s:?}");

    // the mouse resting on the error: the tooltip (after WebStorm's delay); leaving closes it
    let (row, col) = v.cell_of("quux(");
    let on = v.cell_pos(row, col + 2);
    v.cx.simulate_mouse_move(on, None, Modifiers::default());
    wait_shown(
        &mut v,
        "tooltip under the mouse",
        Duration::from_secs(10),
        |s| {
            s.hover
                .as_ref()
                .is_some_and(|(k, t)| *k == DocKind::Tooltip && t.contains(ERR))
        },
    );
    let off = v.cell_pos(row - 1, col + 60);
    v.cx.simulate_mouse_move(off, None, Modifiers::default());
    wait_shown(
        &mut v,
        "tooltip closes when the mouse leaves",
        Duration::from_secs(5),
        |s| s.hover.is_none(),
    );

    // leaving the code for the app's own chrome (the tree): no grid cell, still closes it; a
    // pending tooltip doesn't open there either
    v.cx.simulate_mouse_move(on, None, Modifiers::default());
    wait_shown(&mut v, "tooltip again", Duration::from_secs(10), |s| {
        s.hover
            .as_ref()
            .is_some_and(|(k, _)| *k == DocKind::Tooltip)
    });
    let tree = v.read(|e| e.geometry().layout.tree).expect("tree panel");
    v.cx.simulate_mouse_move(tree.center(), None, Modifiers::default());
    wait_shown(
        &mut v,
        "tooltip closes over the tree",
        Duration::from_secs(5),
        |s| s.hover.is_none(),
    );
    v.cx.simulate_mouse_move(on, None, Modifiers::default());
    v.pump();
    v.cx.simulate_mouse_move(tree.center(), None, Modifiers::default());
    v.wait_lua(
        "the tooltip delay ran out",
        "local t = vim.uv.now() + 0 _G.__ft = _G.__ft or t return vim.uv.now() - _G.__ft > 900",
    );
    v.settle();
    assert!(
        shown(&mut v).hover.is_none(),
        "no tooltip after the mouse left"
    );

    // after all that, a click in the code: nvim has the keyboard (the floats layer takes none)
    let p = v.cell_pos(row, col);
    v.click(MouseButton::Left, p);
    v.wait_lua(
        "caret at the click",
        &format!("return vim.fn.col('.') == {}", col_of(&v, "quux")),
    );
    let before = cursor(&v);
    v.key("ä");
    v.wait_lua(
        "a GPUI key reaches nvim",
        &format!("return vim.fn.col('.') == {}", before.1 + 2),
    );
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), None);
}

/// 1-based byte column of `text` on the caret's line.
fn col_of(v: &View, text: &str) -> i64 {
    v.lua(&format!(
        "return (vim.api.nvim_get_current_line():find('{text}', 1, true))"
    ))
    .as_i64()
    .unwrap()
}

/// Mouse drag in the focused-or-not popup from `from` to `to`.
fn drag(v: &mut View, from: Point<Pixels>, to: Point<Pixels>) {
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.pump();
    let mid = point((from.x + to.x) / 2., (from.y + to.y) / 2.);
    v.cx.simulate_mouse_move(mid, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    v.pump();
}

fn hover_pos(v: &mut View, block: usize, byte: usize) -> Point<Pixels> {
    v.pump();
    let ws = v.ws.clone();
    let p = v.cx.update(|_, cx| {
        ws.read(cx)
            .floats()
            .read(cx)
            .hover_text_position(block, byte)
    });
    p.unwrap_or_else(|| panic!("hover block {block} byte {byte} not painted"))
}

#[test]
fn quick_doc_markdown_selection_and_copy() {
    let dir = project();
    let mut v = start(dir.path(), "doc.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/hover' }) > 0",
    );
    let s = until_shown(&mut v, "3G7|gh", "quick doc of isTimeout", |s| {
        s.hover
            .as_ref()
            .is_some_and(|(_, t)| t.contains("const isTimeout: boolean"))
    });
    assert!(
        !s.hover.unwrap().1.contains("```"),
        "fences are markdown, not text"
    );
    input(&v, "<Esc>");
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.hover.is_none()
    });

    let s = until_shown(&mut v, "2G17|gh", "quick doc of sum", |s| {
        s.hover
            .as_ref()
            .is_some_and(|(_, t)| t.contains("Adds two numbers."))
    });
    let text = s.hover.unwrap().1;
    assert!(
        text.starts_with("function sum(a: number, b: number): number\nAdds two numbers."),
        "{text:?}"
    );
    // drag from the declaration's start to the docs' end, Cmd+C: the text as shown
    let code = "function sum(a: number, b: number): number";
    let from = hover_pos(&mut v, 0, 0);
    let doc_block = 1;
    let to = hover_pos(&mut v, doc_block, "Adds two numbers.".len());
    let from = point(from.x + px(1.), from.y + px(4.));
    let to = point(to.x + px(1.), to.y + px(4.));
    v.lua("vim.fn.setreg('+', 'KEEP') return true");
    drag(&mut v, from, to);
    let s = shown(&mut v);
    assert!(
        s.hover_focused,
        "a click in the popup gives it the keyboard"
    );
    v.keystrokes("cmd-c");
    v.wait_lua(
        "Cmd+C copied the selection as shown",
        &format!("return vim.fn.getreg('+') == '{code}\\nAdds two numbers.'"),
    );
    v.keystrokes("escape");
    wait_shown(&mut v, "Esc closes it", Duration::from_secs(5), |s| {
        s.hover.is_none()
    });
    v.wait_lua(
        "back in the code",
        "return require('config.focus').target() == 'split'",
    );
}

/// Where a debug selector was drawn (None in release builds: GPUI records them with debug
/// assertions only).
fn bounds(v: &mut View, selector: &'static str) -> Option<Bounds<Pixels>> {
    v.pump();
    let b = v.cx.debug_bounds(selector);
    if cfg!(debug_assertions) {
        assert!(b.is_some(), "{selector} not drawn");
    }
    b
}

fn menu_label_x(v: &mut View) -> Option<(Bounds<Pixels>, Pixels)> {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|_, cx| ws.read(cx).floats().read(cx).menu_label_x(cx))
}

fn menu_row(v: &mut View, ix: usize) -> gpui_kit::Bounds<Pixels> {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|_, cx| ws.read(cx).floats().read(cx).menu_row_bounds(ix, cx))
        .expect("row in view")
}

#[test]
fn completion_menu_follows_typing() {
    let dir = project();
    let mut v = start(dir.path(), "hints.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, name = 'vtsls' }) > 0",
    );
    // each try starts from the same line (a retry typing ".to" again would ask after ".to.to")
    let reset =
        "vim.api.nvim_buf_set_lines(0, 2, 3, false, { 'export const n = add(1, 2)' }) return true";
    let s = until_shown_from(&mut v, Some(reset), "3GA.to", "completion after .to", |s| {
        s.menu
            .as_ref()
            .is_some_and(|m| m.iter().any(|l| l == "toFixed"))
    });
    assert!(s.menu_selected >= 1, "the first item preselected");
    assert!(
        !s.menu_focused,
        "auto-popup: gray (semi-focused) selection until the user moves it"
    );
    assert!(
        s.menu_ad
            .as_deref()
            .is_some_and(|a| a.starts_with("Press ")),
        "{s:?}"
    );
    assert!(!screen_has(&mut v, "toFixed"), "blink draws no window");
    // the advertiser strip under the rows: the frame's bottom, 24 high, its ⋮ at the right
    if let (Some(menu), Some(ad), Some(more)) = (
        bounds(&mut v, "floats-menu"),
        bounds(&mut v, "floats-menu-ad"),
        bounds(&mut v, "floats-menu-ad-more"),
    ) {
        assert_eq!(ad.size.height, px(24.));
        assert_eq!(ad.bottom(), menu.bottom() - px(1.));
        assert_eq!(more.right(), menu.right() - px(1. + 8.));
        let last = menu_row(&mut v, s.menu.as_ref().unwrap().len().min(11) - 1);
        assert_eq!(
            ad.top() - last.bottom(),
            px(3.),
            "body bottom inset 3 above the strip"
        );
    }
    // lined up: the labels start where the typed word starts
    let (row, col) = v.cell_of(".to");
    let word = v.cell_pos(row, col + 1);
    let cw = v.read(|e| e.geometry().metrics.cell_width);
    let (frame, x) = menu_label_x(&mut v).unwrap();
    let vp = v.read(|e| e.geometry().layout.frame.viewport);
    // (unless the window's right edge pushes it left)
    if frame.right() < vp.width - px(20.) {
        assert!(
            ((word.x - cw / 2.) - x).abs() < px(1.),
            "label x {x:?} vs word x {:?}",
            word.x - cw / 2.
        );
    } else {
        assert!(x <= word.x, "{x:?} {word:?}");
    }
    // typing more filters, the menu follows
    input(&v, "F");
    let s = wait_shown(
        &mut v,
        "filtered to toFixed",
        Duration::from_secs(10),
        |s| {
            s.menu
                .as_ref()
                .is_some_and(|m| m.first().is_some_and(|l| l == "toFixed"))
        },
    );
    let first = s.menu_selected;
    // the docs panel next to it (auto-shown after a moment)
    wait_shown(
        &mut v,
        "documentation panel",
        Duration::from_secs(10),
        |s| s.menu_doc.as_ref().is_some_and(|d| !d.is_empty()),
    );
    if let Some(doc) = bounds(&mut v, "floats-menu-doc") {
        assert!(
            doc.size.height >= px(300.),
            "lookup doc min height: {doc:?}"
        );
    }
    input(&v, "<BS>");
    wait_shown(&mut v, "back to .to", Duration::from_secs(10), |s| {
        s.menu.as_ref().is_some_and(|m| m.len() > 1)
    });
    // moving the selection doesn't insert (WebStorm lookup); the selection turns blue
    input(&v, "<C-n>");
    let s = wait_shown(&mut v, "selection moved", Duration::from_secs(5), |s| {
        s.menu_selected == first + 1
    });
    assert!(s.menu_focused, "navigated: focused (blue)");
    assert_eq!(v.current_line(), "export const n = add(1, 2).to");
    let picked = s.menu.unwrap()[s.menu_selected - 1].clone();
    // Tab accepts the selected item
    input(&v, "<Tab>");
    wait_shown(
        &mut v,
        "menu closed after accepting",
        Duration::from_secs(5),
        |s| s.menu.is_none(),
    );
    // (methods get their parentheses, blink's auto brackets)
    let line = v.current_line();
    assert!(
        line.starts_with(&format!("export const n = add(1, 2).{picked}")),
        "{line}"
    );

    // a click on an item accepts it
    input(&v, "<Esc>");
    let s = until_shown_from(&mut v, Some(reset), "3GA.to", "completion again", |s| {
        s.menu.as_ref().is_some_and(|m| m.len() > 2)
    });
    let third = s.menu.unwrap()[2].clone();
    let r = menu_row(&mut v, 2);
    v.click(MouseButton::Left, r.center());
    v.wait_lua(
        "the clicked item inserted",
        &format!("return vim.startswith(vim.api.nvim_get_current_line(), 'export const n = add(1, 2).{third}')"),
    );
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.menu.is_none()
    });
    input(&v, "<Esc>");
}

#[test]
fn signature_help_and_quick_definition() {
    let dir = project();
    let mut v = start(dir.path(), "hints.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/definition' }) > 0",
    );
    // parameter info while typing a call
    let s = until_shown(&mut v, "Goadd(", "signature help", |s| {
        s.signature.is_some()
    });
    // WS JS/TS parameter info: the parameter list only, the current one bold
    assert_eq!(
        s.signature.as_deref(),
        Some("x: number, y: number"),
        "{s:?}"
    );
    assert_eq!(s.signature_param.as_deref(), Some("x: number"), "{s:?}");
    input(&v, "<Esc>");
    wait_shown(
        &mut v,
        "closes when typing stops",
        Duration::from_secs(5),
        |s| s.signature.is_none(),
    );
    v.lua("vim.cmd('silent! e!') return true");

    // Cmd+L: the declaration in the popup's grid, a.ts and the line in the native header
    at(&v, 3, 17);
    let mut s = shown(&mut v);
    let deadline = Instant::now() + LSP_TIMEOUT;
    while s.peek.is_none() {
        assert!(Instant::now() < deadline, "no Quick Definition");
        v.keystrokes("cmd-l");
        let until = Instant::now() + Duration::from_secs(3);
        while s.peek.is_none() && Instant::now() < until {
            v.settle();
            s = shown(&mut v);
        }
    }
    let (path, right) = s.peek.clone().unwrap();
    assert_eq!(path, "a.ts");
    assert_eq!(right, "line 3");
    v.wait_screen("export function add(x: number, y: number) {");
    // WebStorm's 30 px header (◀ ▶ only for several definitions), above the code's top padding,
    // below the caret line
    if let Some(head) = bounds(&mut v, "floats-peek-header") {
        assert_eq!(head.size.height, px(30.));
        let (row, col) = v.cell_of("export function add(x: number");
        let code = v.cell_pos(row, col);
        let (crow, ccol) = v.cell_of("export const n = add(");
        let caret = v.cell_pos(crow, ccol);
        assert!(head.bottom() < code.y, "{head:?} vs code at {code:?}");
        assert!(
            head.top() >= caret.y + px(10.),
            "{head:?} vs caret line at {caret:?}"
        );
        assert!(v.cx.debug_bounds("floats-peek-prev").is_none());
        bounds(&mut v, "floats-peek-more");
    }
    assert!(
        !screen_has(&mut v, "line 3"),
        "the header isn't nvim's winbar"
    );
    v.keystrokes("escape");
    wait_shown(&mut v, "Esc closes it", Duration::from_secs(5), |s| {
        s.peek.is_none()
    });
    v.wait_lua(
        "caret back in hints.ts",
        "return vim.fn.expand('%:t') == 'hints.ts' and require('config.focus').target() == 'split'",
    );
    // Enter jumps to the declaration
    v.keystrokes("cmd-l");
    wait_shown(&mut v, "open again", Duration::from_secs(10), |s| {
        s.peek.is_some()
    });
    v.keystrokes("enter");
    v.wait_lua(
        "Enter: a.ts at the declaration",
        "return vim.fn.expand('%:t') == 'a.ts' and vim.fn.line('.') == 3",
    );
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.peek.is_none()
    });
}

#[test]
fn command_line_completion_above_the_command_line() {
    let dir = project();
    let mut v = start(dir.path(), "a.ts");
    // wait for the command line before typing on
    input(&v, ":");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !v.read(|e| {
        e.geometry()
            .places
            .iter()
            .any(|p| p.kind == vimstorm::shell::PlaceKind::Message)
    }) {
        assert!(Instant::now() < deadline, "the command line never showed");
        v.settle();
    }
    input(&v, "echo<Tab>");
    let s = wait_shown(&mut v, "command completion", Duration::from_secs(10), |s| {
        s.menu
            .as_ref()
            .is_some_and(|m| m.iter().any(|l| l.starts_with("echo")))
    });
    assert!(s.menu_selected <= s.menu.as_ref().unwrap().len());
    let r = menu_row(&mut v, 0);
    let msg = v.read(|e| {
        e.geometry()
            .places
            .iter()
            .find(|p| p.kind == vimstorm::shell::PlaceKind::Message)
            .map(|p| p.origin.y)
    });
    let msg = msg.expect("the command line shows");
    assert!(
        r.bottom() <= msg,
        "menu above the command line: {r:?} vs {msg:?}"
    );
    input(&v, "<C-c>");
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.menu.is_none()
    });
}

/// A long markdown hover from Lua (`config/app/floats.lua` as gutter.lua sends it).
fn show_long_hover(v: &View, buf: &str) {
    v.lua(&format!(
        "local lines = {{}} for i = 1, 80 do lines[i] = 'line ' .. i end \
         local f = require('config.app.floats') \
         f.show_hover('hover', {{ f.markdown(table.concat(lines, '\\n\\n')) }}, f.caret(), {buf}) return true"
    ));
}

fn hover_scroll(v: &mut View) -> (Pixels, Pixels) {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|_, cx| ws.read(cx).floats().read(cx).hover_scroll())
        .expect("hover open")
}

#[test]
fn focused_hover_keys_and_focus_rules() {
    let dir = project();
    let mut v = start(dir.path(), "a.ts");
    // the focused popup scrolls and copies like its Neovim window did
    show_long_hover(&v, "vim.api.nvim_get_current_buf()");
    wait_shown(&mut v, "long hover", Duration::from_secs(5), |s| {
        s.hover.is_some()
    });
    input(&v, "gh"); // gh again: into it
    wait_shown(&mut v, "focused", Duration::from_secs(5), |s| {
        s.hover_focused
    });
    assert_eq!(hover_scroll(&mut v).0, px(0.));
    v.keystrokes("ctrl-d");
    let (half, max) = hover_scroll(&mut v);
    assert!(
        half > px(0.) && half < max,
        "Ctrl+D: half a page ({half:?} of {max:?})"
    );
    v.keystrokes("shift-g");
    // (against the max now: rows measured on the way down can end up shorter than estimated)
    let (end, max) = hover_scroll(&mut v);
    assert_eq!(end, max, "G: the end");
    v.keystrokes("ctrl-u");
    assert!(hover_scroll(&mut v).0 < max, "Ctrl+U: up");
    v.keystrokes("g g");
    assert_eq!(hover_scroll(&mut v).0, px(0.), "gg: the top");
    v.lua("vim.fn.setreg('+', 'KEEP') return true");
    v.keystrokes("y");
    v.wait_lua(
        "y without a selection copies all of it",
        "return vim.startswith(vim.fn.getreg('+'), 'line 1\\nline 2\\n') and vim.endswith(vim.fn.getreg('+'), 'line 80')",
    );

    // a new popup while the focused one is open (the mouse tooltip, gh elsewhere): it stays
    show_long_hover(&v, "vim.api.nvim_get_current_buf()");
    v.settle();
    let s = shown(&mut v);
    assert!(s.hover.is_some() && !s.hover_focused, "{s:?}");
    v.settle();
    assert!(
        shown(&mut v).hover.is_some(),
        "the new popup isn't closed by the old one's blur"
    );
    v.wait_lua(
        "keyboard back in the code",
        "return require('config.focus').target() == 'split'",
    );

    // another native surface takes the keyboard (the tree): the popup closes
    v.keystrokes("cmd-1");
    v.wait_lua(
        "tree focused",
        "return require('config.focus').target() == 'tree'",
    );
    wait_shown(
        &mut v,
        "hover closed by the tree's focus",
        Duration::from_secs(5),
        |s| s.hover.is_none(),
    );
    v.keystrokes("escape");
    v.wait_lua(
        "back in the code",
        "return require('config.focus').target() == 'split'",
    );

    // gh twice must not go into another buffer's popup
    v.lua("vim.cmd('vsplit doc.ts') return true");
    v.wait_lua("doc.ts", "return vim.fn.expand('%:t') == 'doc.ts'");
    show_long_hover(&v, "vim.fn.bufnr('a.ts')");
    assert_eq!(
        v.lua("return require('config.app.floats').enter_hover()")
            .as_bool(),
        Some(false)
    );
}

#[test]
fn ctrl_s_and_peek_close_when_the_tree_takes_the_keys_or_a_click() {
    let dir = project();
    let mut v = start(dir.path(), "hints.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/definition' }) > 0",
    );
    // insert-mode Ctrl+S: the native parameter info, no Neovim float
    let floats = "local n = 0 for _, w in ipairs(vim.api.nvim_list_wins()) do \
        if vim.api.nvim_win_get_config(w).relative ~= '' then n = n + 1 end end return n";
    let s = until_shown(&mut v, "3G$i<C-s>", "Ctrl+S signature help", |s| {
        s.signature.is_some()
    });
    assert!(s.signature.unwrap().contains("x: number"));
    assert_eq!(v.lua(floats).as_i64(), Some(0), "no Neovim float");
    input(&v, "<Esc>");
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.signature.is_none()
    });

    // Quick Definition, then the tree takes the keyboard: it closes (no WinLeave in nvim)
    at(&v, 3, 17);
    let mut s = shown(&mut v);
    let deadline = Instant::now() + LSP_TIMEOUT;
    while s.peek.is_none() {
        assert!(Instant::now() < deadline, "no Quick Definition");
        v.keystrokes("cmd-l");
        let until = Instant::now() + Duration::from_secs(3);
        while s.peek.is_none() && Instant::now() < until {
            v.settle();
            s = shown(&mut v);
        }
    }
    v.keystrokes("cmd-1");
    wait_shown(
        &mut v,
        "peek closed by the tree's focus",
        Duration::from_secs(5),
        |s| s.peek.is_none(),
    );
    v.wait_lua(
        "its window gone",
        &format!("return (function() {floats} end)() == 0"),
    );

    // a click on a tree row closes it too, and the tree has the keyboard
    v.focus_code();
    let mut s = shown(&mut v);
    while s.peek.is_none() {
        assert!(Instant::now() < deadline, "no Quick Definition");
        v.keystrokes("cmd-l");
        let until = Instant::now() + Duration::from_secs(3);
        while s.peek.is_none() && Instant::now() < until {
            v.settle();
            s = shown(&mut v);
        }
    }
    let row = row_point(&mut v, "tsconfig.json", 4.);
    v.click(MouseButton::Left, row);
    wait_shown(
        &mut v,
        "peek closed by a click on the tree",
        Duration::from_secs(5),
        |s| s.peek.is_none(),
    );
    v.wait_lua(
        "its window gone",
        &format!("return (function() {floats} end)() == 0"),
    );
    wait_target(&mut v, "tree");
}

fn popups_menu(v: &mut View) -> Option<Vec<String>> {
    v.pump();
    let ws = v.ws.clone();
    v.cx.update(|_, cx| ws.read(cx).popups().read(cx).menu_rows())
}

#[test]
fn error_popup_quick_fix_row_and_settings() {
    let dir = project();
    let mut v = start(dir.path(), "err.ts");
    wait_lsp(
        &mut v,
        "vtsls reports the error",
        "return #vim.diagnostic.get(0, { lnum = 2 }) > 0",
    );
    // ,e: the problem, then its first quick fix as a link ("Add missing function declaration")
    at(&v, 3, 10);
    let s = until_shown(&mut v, ",e", "the quick fix row", |s| s.hover_fix.is_some());
    assert!(s.hover_fix.as_deref().unwrap().contains("quux"), "{s:?}");
    if let (Some(pop), Some(fix), Some(more)) = (
        bounds(&mut v, "floats-hover"),
        bounds(&mut v, "floats-fix"),
        bounds(&mut v, "floats-problem-more"),
    ) {
        assert_eq!(
            fix.left(),
            pop.left() + px(1. + 20.),
            "fix at CONTENT_PADDING"
        );
        assert_eq!(more.size.width, px(20.));
        assert_eq!(more.right(), pop.right() - px(1. + 9.));
        bounds(&mut v, "floats-more-actions");
        // no docs part: no corner toolbar
        assert!(v.cx.debug_bounds("floats-doc-edit").is_none());
    }

    // ⋮: "Show Quick Fixes" off hides the row; the popup stays open meanwhile
    if let Some(more) = bounds(&mut v, "floats-problem-more") {
        v.click(MouseButton::Left, more.center());
        v.wait_until("the ⋮ menu", |v| {
            popups_menu(v).is_some_and(|m| m == ["Show Quick Fixes"])
        });
        assert!(
            shown(&mut v).hover.is_some(),
            "the popup stays while its menu is open"
        );
        v.keystrokes("enter");
        let s = wait_shown(&mut v, "fixes hidden", Duration::from_secs(5), |s| {
            s.hover_fix.is_none()
        });
        assert!(s.hover.is_some(), "{s:?}");
        // (narrower without the fix row: its ⋮ moved)
        let more = bounds(&mut v, "floats-problem-more").unwrap();
        v.click(MouseButton::Left, more.center());
        v.wait_until("the ⋮ menu again", |v| popups_menu(v).is_some());
        v.keystrokes("enter");
        wait_shown(&mut v, "fixes shown again", Duration::from_secs(5), |s| {
            s.hover_fix.is_some()
        });
    }

    // "More actions…": the context actions at the problem
    if let Some(link) = bounds(&mut v, "floats-more-actions") {
        v.lua("local c = require('config.context') _G.__orig = c.code_actions \
               c.code_actions = function() _G.__more = vim.api.nvim_win_get_cursor(0) end return true");
        v.click(MouseButton::Left, link.center());
        v.wait_lua("More actions… ran", "return _G.__more ~= nil");
        wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
            s.hover.is_none()
        });
        v.lua("require('config.context').code_actions = _G.__orig return true");
    }

    // the fix link applies the fix
    at(&v, 3, 10);
    until_shown(&mut v, ",e", "the quick fix row again", |s| {
        s.hover_fix.is_some()
    });
    if let Some(fix) = bounds(&mut v, "floats-fix") {
        v.click(MouseButton::Left, fix.center());
        v.wait_lua(
            "the fix applied",
            "return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n'):find('function quux', 1, true) ~= nil",
        );
        wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
            s.hover.is_none()
        });
    }
}

#[test]
fn doc_popup_location_corner_toolbar_and_width() {
    let dir = project();
    let mut v = start(dir.path(), "doc.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/hover' }) > 0",
    );
    // gh on the call: the docs, then the definition's file under them
    let s = until_shown(
        &mut v,
        "3G20|gh",
        "quick doc of sum with its location",
        |s| {
            s.hover
                .as_ref()
                .is_some_and(|(_, t)| t.contains("Adds two numbers."))
                && s.hover_location.is_some()
        },
    );
    assert_eq!(s.hover_location.as_deref(), Some("doc.ts"));
    if let (Some(pop), Some(edit), Some(more), Some(loc)) = (
        bounds(&mut v, "floats-hover"),
        bounds(&mut v, "floats-doc-edit"),
        bounds(&mut v, "floats-doc-more"),
        bounds(&mut v, "floats-doc-location"),
    ) {
        // WebStorm's corner toolbar: 22 px buttons, 4 from the right, 11 from the bottom
        assert_eq!(more.size.width, px(22.));
        assert_eq!(more.right(), pop.right() - px(1. + 4.));
        assert_eq!(more.bottom(), pop.bottom() - px(1. + 11.));
        assert_eq!(edit.right(), more.left());
        assert_eq!(loc.bottom(), pop.bottom() - px(1.));
        assert!(pop.size.width <= px(500.), "{pop:?}");
    }
    // ✏ (Edit Source): to the definition
    if let Some(edit) = bounds(&mut v, "floats-doc-edit") {
        v.click(MouseButton::Left, edit.center());
        v.wait_lua("at sum's declaration", "return vim.fn.line('.') == 2");
        wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
            s.hover.is_none()
        });
    }

    // a wide code block widens the popup past 500 (up to WebStorm's 900)
    let long = "x".repeat(110);
    v.lua(&format!(
        "local f = require('config.app.floats') \
         f.show_hover('hover', {{ f.markdown('Wide:\\n\\n```ts\\nconst {long} = 1;\\n```') }}, f.caret(), 0) return true"
    ));
    wait_shown(&mut v, "wide hover", Duration::from_secs(5), |s| {
        s.hover.as_ref().is_some_and(|(_, t)| t.contains("Wide:"))
    });
    if let Some(pop) = bounds(&mut v, "floats-hover") {
        assert!(
            pop.size.width > px(500.) && pop.size.width <= px(900.),
            "{pop:?}"
        );
    }
}

/// "No usages found in Project Files": WebStorm's information hint at the caret (the hover popup,
/// just the text: no ⋮, no actions).
#[test]
fn information_hint_at_the_caret() {
    let dir = project();
    let mut v = start(dir.path(), "a.ts");
    v.lua(
        "local f = require('config.app.floats') \
         f.show_hover('hover', { { kind = 'hint', text = 'No usages found in Project Files' } }, f.caret(), 0) \
         return true",
    );
    wait_shown(&mut v, "the hint", Duration::from_secs(5), |s| {
        s.hover
            .as_ref()
            .is_some_and(|(_, t)| t.contains("No usages found in Project Files"))
    });
    if bounds(&mut v, "floats-hover").is_some() {
        assert!(v.cx.debug_bounds("floats-problem-more").is_none(), "no ⋮");
        assert!(v.cx.debug_bounds("floats-fix").is_none());
    }
}

#[test]
fn signature_overloads_switch() {
    let dir = project();
    let mut v = start(dir.path(), "over.ts");
    wait_lsp(
        &mut v,
        "vtsls attached",
        "return #vim.lsp.get_clients({ bufnr = 0, name = 'vtsls' }) > 0",
    );
    let s = until_shown(&mut v, "Goover(", "two overloads", |s| {
        s.signature.is_some() && s.signature_hint.is_some()
    });
    assert_eq!(s.signature_hint.as_deref(), Some("Switch with ⌃↑ or ⌃↓"));
    let first = s.signature.clone().unwrap();
    bounds(&mut v, "floats-signature-hint");
    input(&v, "<C-Down>");
    let s = wait_shown(&mut v, "the next overload", Duration::from_secs(5), |s| {
        s.signature.as_ref().is_some_and(|l| *l != first)
    });
    input(&v, "<C-Up>");
    wait_shown(&mut v, "back", Duration::from_secs(5), |s| {
        s.signature.as_deref() == Some(first.as_str())
    });
    assert!(s.signature.is_some());
    let line = v.current_line();
    assert!(
        line == "over(" || line == "over()",
        "no text from ⌃↑ / ⌃↓: {line:?}"
    );
    input(&v, "<Esc>");
}

#[test]
fn quick_definition_waits_for_the_language_server() {
    let dir = project();
    let mut v = start(dir.path(), "hints.ts");
    // Cmd+L at once (vtsls still starting): it opens once the server attaches, no "no language
    // server" balloon
    at(&v, 3, 17);
    v.keystrokes("cmd-l");
    let s = wait_shown(&mut v, "Quick Definition after attach", LSP_TIMEOUT, |s| {
        s.peek.is_some()
    });
    // (right after attaching vtsls may answer with the import binding)
    let path = s.peek.unwrap().0;
    assert!(path == "a.ts" || path == "hints.ts", "{path}");
    v.keystrokes("escape");
    wait_shown(&mut v, "closed", Duration::from_secs(5), |s| {
        s.peek.is_none()
    });
}
