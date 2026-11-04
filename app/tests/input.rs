//! Keys, IME, mouse and scrolling through the real `EditorView` (GPUI test window) into the real
//! nvim + config: GPUI events -> `crate::editor::input` -> `editor::forward` -> nvim, as in the app.
//! Also which surface a key reaches: editor-only Cmd keys never reach the buffer from another
//! surface.

use crate::common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::view::View;
use gpui_kit::{Modifiers, MouseButton, ScrollDelta, TouchPhase, point, px};
use vimstorm::editor::input::{self, Action, KEYMAP, Keys, Owner};

/// A project dir of its own (tests that write files or need many lines).
fn project(files: &[(&str, String)]) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-proj-")
        .tempdir()
        .unwrap();
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    dir
}

/// The fixture's multi.txt in a project of its own: tests that edit it (an edited buffer is saved
/// when the window loses focus) must not change the shared fixture other tests open.
fn own_multi() -> tempfile::TempDir {
    let text = std::fs::read_to_string(common::fixtures().join("proj/multi.txt")).unwrap();
    project(&[("multi.txt", text)])
}

fn long_file() -> String {
    (1..=200).map(|n| format!("line {n}\n")).collect()
}

fn path(dir: &tempfile::TempDir) -> &str {
    dir.path().to_str().unwrap()
}

const SHIFT: Modifiers = Modifiers {
    shift: true,
    control: false,
    alt: false,
    platform: false,
    function: false,
};
const CTRL: Modifiers = Modifiers {
    control: true,
    shift: false,
    alt: false,
    platform: false,
    function: false,
};

#[test]
fn typing_swedish_text_shifted_digits_and_lt() {
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    v.key("i");
    v.wait_for("insert mode", |v| v.ui().mode == "insert");
    for k in [
        "å",
        "ä",
        "ö",
        "shift+å",
        "shift+digit_1",
        "shift+digit_7",
        "<",
        "shift+<",
    ] {
        v.key(k);
    }
    v.wait_lua(
        "text typed once",
        "return vim.api.nvim_get_current_line() == 'åäöÅ!/<>alpha one'",
    );
    v.key("escape");
    v.wait_for("normal mode", |v| v.ui().mode == "normal");
    assert_eq!(v.mode(), "n");
}

#[test]
fn cmd_s_saves_cmd_z_undoes_cmd_shift_z_redoes() {
    let dir = project(&[("save.txt", "first line\n".into())]);
    let mut v = View::start(path(&dir), &["save.txt"]);
    v.wait_screen("first line");
    v.keystrokes("i z z escape");
    v.wait_lua(
        "typed",
        "return vim.api.nvim_get_current_line() == 'zzfirst line' and vim.fn.mode() == 'n'",
    );
    v.keystrokes("cmd-s");
    let file = dir.path().join("save.txt");
    v.wait_lua("saved", "return not vim.bo.modified");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "zzfirst line\n");

    v.keystrokes("cmd-z");
    v.wait_lua(
        "undone",
        "return vim.api.nvim_get_current_line() == 'first line'",
    );
    // Cmd+Shift+Z as macOS reports it: key "z" with Shift (ASCII letters keep Shift)
    v.key("super+shift+z");
    v.wait_lua(
        "redone",
        "return vim.api.nvim_get_current_line() == 'zzfirst line'",
    );
    assert!(Path::new(&file).exists());
}

#[test]
fn cmd_c_cmd_v_copy_and_paste_the_line() {
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    v.keystrokes("cmd-c");
    v.wait_lua(
        "copied",
        "return vim.fn.getreg('+'):find('alpha one', 1, true) ~= nil",
    );
    v.keystrokes("cmd-v");
    v.wait_lua(
        "pasted",
        "local l = vim.api.nvim_buf_get_lines(0, 0, 3, false) \
         return #vim.tbl_filter(function(s) return s == 'alpha one' end, l) == 2",
    );
}

/// The native picker open now ("all", "switcher", ...), from the workspace's pickers surface.
fn picker_kind(v: &mut View) -> Option<String> {
    v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| s.kind))
}

/// Waits until the open picker is `kind` (None: closed).
fn wait_picker(v: &mut View, label: &str, kind: Option<&str>) {
    let deadline = std::time::Instant::now() + common::TIMEOUT;
    while picker_kind(v).as_deref() != kind {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for: {label}"
        );
        v.wait_lua("nvim idle", "return true");
    }
}

#[test]
fn ctrl_tab_press_and_release_switches_file() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1;");
    v.lua("vim.cmd.edit('multi.txt') return true");
    v.wait_screen("alpha one");
    v.modifiers(CTRL);
    v.keystrokes("ctrl-tab");
    // the (native) switcher waits for Ctrl's release
    wait_picker(&mut v, "switcher open", Some("switcher"));
    v.modifiers(Modifiers::default());
    wait_picker(&mut v, "switcher closed", None);
    v.wait_lua("back in a.ts", "return vim.fn.expand('%:t') == 'a.ts'");
}

#[test]
fn left_click_moves_the_caret() {
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("gamma three");
    let (row, col) = v.cell_of("gamma three");
    let col = col + 2;
    let at = v.cell_pos(row, col);
    v.click(MouseButton::Left, at);
    v.wait_lua(
        "cursor on the clicked char",
        "local c = vim.api.nvim_win_get_cursor(0) return c[1] == 3 and c[2] == 2",
    );
    v.wait_for("caret drawn there", |v| {
        v.ui()
            .caret()
            .is_some_and(|c| c.row == row as i64 && c.col == col as i64)
    });
}

#[test]
fn right_click_opens_the_context_menu() {
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("beta two");
    let (row, col) = v.cell_of("beta two");
    let at = v.cell_pos(row, col + 1);
    v.click(MouseButton::Right, at);
    // the menu is native (src/popups): open, with its top-left at the click (x: it may be pulled
    // up when taller than the room below)
    let popups = v.read_ws(|ws, _| ws.popups().clone());
    v.wait_lua("the menu opened", "return require('config.menu').is_open()");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let bounds = loop {
        v.pump();
        let rows = popups.read_with(&v.cx, |p, _| p.menu_rows());
        if rows.is_some_and(|r| r.iter().any(|l| l == "Paste")) {
            break popups.read_with(&v.cx, |p, _| p.menu_bounds()).unwrap();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no native menu with Paste"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    assert_eq!(bounds.origin.x, at.x, "the menu opens at the click");
    v.wait_lua(
        "caret moved to the click",
        "for _, w in ipairs(vim.api.nvim_list_wins()) do \
           if vim.fn.bufname(vim.api.nvim_win_get_buf(w)) == 'multi.txt' \
             and vim.api.nvim_win_get_cursor(w)[1] == 2 then return true end \
         end return false",
    );
}

#[test]
fn drag_selects_and_hover_reaches_nvim() {
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("alpha one");
    let (r1, c1) = v.cell_of("alpha one");
    let (r3, c3) = v.cell_of("gamma three");
    let (from, to) = (v.cell_pos(r1, c1 + 1), v.cell_pos(r3, c3 + 3));
    // a hand's press and drag are frames apart: config/menu.lua's <LeftMouse> expr mapping
    // re-feeds <LeftMouse>, which takes the pointer position nvim has when it runs; press, drag
    // and release queued together all left it at the release (the click landed there)
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.wait_lua(
        "caret at the press",
        "local c = vim.api.nvim_win_get_cursor(0) return c[1] == 1 and c[2] == 1",
    );
    v.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    v.wait_lua("dragging selects", "return vim.fn.mode() == 'v'");
    v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    v.wait_lua(
        "lines 1-3 selected",
        "return vim.fn.mode() == 'v' and vim.fn.line('v') == 1 and vim.fn.line('.') == 3",
    );
    v.keystrokes("escape");
    // 'mousemoveevent' (gutter tooltips): the pointer's cell reaches nvim without a button
    let (r4, c4) = v.cell_of("delta four");
    let at = v.cell_pos(r4, c4 + 2);
    v.cx.simulate_mouse_move(at, None, Modifiers::default());
    v.wait_lua(
        "nvim saw the pointer on line 4",
        "local p = vim.fn.getmousepos() return p.line == 4 and p.column == 3",
    );
}

#[test]
fn mouse_wheel_scrolls_three_lines_per_line() {
    let dir = project(&[("long.txt", long_file())]);
    let mut v = View::start(path(&dir), &["long.txt"]);
    v.wait_screen("line 1");
    let (row, col) = v.cell_of("line 5");
    let at = v.cell_pos(row, col + 2);
    v.scroll(at, ScrollDelta::Lines(point(0., -2.)), TouchPhase::Moved);
    v.wait_lua("scrolled 6 lines", "return vim.fn.line('w0') == 7");
    v.scroll(at, ScrollDelta::Lines(point(0., 1.)), TouchPhase::Moved);
    v.wait_lua("scrolled back 3", "return vim.fn.line('w0') == 4");
    // no smooth offset for wheel lines
    assert_eq!(v.read(|v| v.smooth_scroll().offset()), None);
}

#[test]
fn trackpad_scrolls_by_pixels_and_settles_on_a_row() {
    let dir = project(&[("long.txt", long_file())]);
    let mut v = View::start(path(&dir), &["long.txt"]);
    v.wait_screen("line 1");
    let (row, col) = v.cell_of("line 5");
    let at = v.cell_pos(row, col + 2);
    let grid = v.read(|v| v.hit_test(at).unwrap().0);
    let rows_drawn = |v: &mut View| {
        v.read(|v| {
            use vimstorm::render::GridHost as _;
            v.scroll_offset()
        })
    };
    // fingers up 30 px: nvim goes 2 rows down (ahead), the content is drawn 14 px lower than
    // nvim's rows, the row that left at the top fills the edge
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(-30.))),
        TouchPhase::Started,
    );
    v.wait_lua("nvim 2 rows down", "return vim.fn.line('w0') == 3");
    v.wait_for("offset drawn", |v| {
        use vimstorm::render::GridHost as _;
        v.scroll_offset() == Some((grid, px(14.)))
    });
    let kept = v.ui(|ui| ui.grids[&grid].kept_rows().0);
    assert!(kept >= 1, "a kept row fills the revealed edge");
    // the pointer's cell is the row drawn under it: 30 px (1.4 rows) below line 5's middle
    let hit_row = v.read(|v| v.hit_test(at).unwrap().1);
    let line_at = v.ui(|ui| ui.grids[&grid].row_text(hit_row));
    assert!(line_at.contains("line 6 "), "{line_at}");

    // momentum keeps coming, then stops: settles on the nearest row (30 px ~ 1.4 rows -> 1)
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(0.))),
        TouchPhase::Ended,
    );
    for _ in 0..40 {
        v.advance(Duration::from_millis(20));
    }
    v.wait_lua("settled on line 2", "return vim.fn.line('w0') == 2");
    v.wait_for("no offset", |v| v.smooth_scroll().offset().is_none());
    assert_eq!(rows_drawn(&mut v), None);

    // pulled past the first line: nothing moves above it
    v.scroll(
        at,
        ScrollDelta::Pixels(point(px(0.), px(200.))),
        TouchPhase::Started,
    );
    v.wait_lua("at the top", "return vim.fn.line('w0') == 1");
    v.settle();
    assert_eq!(rows_drawn(&mut v), None);
}

#[test]
fn ime_commit_inserts_once_and_preedit_sends_nothing() {
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    v.key("i");
    v.wait_for("insert mode", |v| v.ui().mode == "insert");
    v.ime_commit("日本");
    v.wait_lua(
        "committed once",
        "return vim.api.nvim_get_current_line() == '日本alpha one'",
    );

    // dead key ¨ (AppKit marks it): a preedit, drawn by the view, nvim gets nothing
    v.ime_mark("¨");
    assert_eq!(
        v.read(|v| v.ime().borrow().marked_text().map(str::to_owned)),
        Some("¨".into())
    );
    v.settle();
    assert_eq!(v.current_line(), "日本alpha one");
    // the next key composes: ü once
    v.ime_commit("ü");
    v.wait_lua(
        "composed",
        "return vim.api.nvim_get_current_line() == '日本üalpha one'",
    );
    assert!(v.read(|v| v.ime().borrow().marked_text().is_none()));
    // focus lost drops a preedit
    v.cx.update(|window, _| window.activate_window());
    v.pump();
    v.ime_mark("´");
    assert!(v.read(|v| v.ime().borrow().marked_text().is_some()));
    v.cx.deactivate_window();
    assert!(v.read(|v| v.ime().borrow().marked_text().is_none()));
}

// Keymap ownership (src/editor/input/keymap.rs, src/app/menu.rs) ---------------------------------------

/// The lhs of `lhss` that have no mapping in any mode, globally or in a loaded buffer.
const UNMAPPED: &str = r#"
  local bufs = vim.tbl_filter(vim.api.nvim_buf_is_loaded, vim.api.nvim_list_bufs())
  local function mapped(lhs)
    local key = vim.api.nvim_replace_termcodes(lhs, true, true, true)
    for _, mode in ipairs({ 'n', 'i', 'x', 's', 'o', 't', 'c' }) do
      if next(vim.fn.maparg(lhs, mode, false, true)) then return true end
      for _, b in ipairs(bufs) do
        for _, m in ipairs(vim.api.nvim_buf_get_keymap(b, mode)) do
          if vim.api.nvim_replace_termcodes(m.lhs, true, true, true) == key then return true end
        end
      end
    end
  end
  local out = {}
  for _, lhs in ipairs(...) do
    if not mapped(lhs) then out[#out + 1] = lhs end
  end
  return out
"#;

fn init_app_menu(v: &mut View) {
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    v.pump();
}

#[test]
fn every_keymap_key_reaches_a_lua_map_or_an_app_binding() {
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("alpha one");
    init_app_menu(&mut v);
    let mut lhss = Vec::new();
    let mut names = Vec::new();
    for sc in KEYMAP {
        let ks = input::keystroke(sc.trigger).unwrap_or_else(|| panic!("{}", sc.trigger));
        match sc.owner {
            Owner::Nvim | Owner::Global | Owner::Editor => {
                let lhs = vimstorm::kit::notation_of(&ks)
                    .unwrap_or_else(|| panic!("{} sends nothing", sc.trigger));
                lhss.push(rmpv::Value::from(lhs.clone()));
                names.push((lhs, sc.trigger));
            }
            Owner::App => {
                let bound = v.cx.update(|_, cx| {
                    cx.key_bindings()
                        .borrow()
                        .all_bindings_for_input(std::slice::from_ref(&ks))
                        .iter()
                        .any(|b| b.predicate().is_none())
                });
                assert!(bound, "{} ({}): no app binding", sc.trigger, sc.action);
            }
            _ => {}
        }
    }
    let unmapped = v.request(
        "nvim_exec_lua",
        vec![
            UNMAPPED.into(),
            rmpv::Value::Array(vec![rmpv::Value::Array(lhss)]),
        ],
    );
    let unmapped: Vec<String> = unmapped
        .as_array()
        .expect("list")
        .iter()
        .filter_map(|l| l.as_str())
        .map(|l| {
            let trigger = names.iter().find(|(n, _)| n == l).map_or("?", |(_, t)| *t);
            format!("{trigger} {l}")
        })
        .collect();
    assert!(unmapped.is_empty(), "no Lua map: {unmapped:?}");
}

/// Feel vscode: as the bridge's `feel` effect does it, the global for Rust's key routing
/// and `config.feel` in the project's nvim (a projects window sends it; this bare workspace not).
fn feel_vscode(v: &mut View) {
    v.set_feel(|f| f.feel = vimstorm::factory::FeelName::Vscode);
    v.lua("require('config.feel').set({ feel = 'vscode' }) return true");
}

#[test]
fn feel_vscode_chords_reach_their_lua_maps() {
    use vimstorm::factory::FeelName;
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("alpha one");
    feel_vscode(&mut v);
    let mut lhss = Vec::new();
    // (the window's own, ⌘⇧E the Project pane key, never reach nvim)
    for sc in vimstorm::editor::input::VSCODE
        .iter()
        .filter(|sc| sc.owner != Owner::Window)
    {
        let ks = input::keystroke(sc.trigger).unwrap_or_else(|| panic!("{}", sc.trigger));
        let lhs = vimstorm::kit::notation_of(&ks)
            .unwrap_or_else(|| panic!("{} sends nothing", sc.trigger));
        lhss.push(rmpv::Value::from(lhs));
    }
    // mapcheck: ⌘K is a chord's first key (⌘K ⌘S)
    let unmapped = v.request(
        "nvim_exec_lua",
        vec![
            "local out = {} for _, lhs in ipairs(...) do \
               local ok = false \
               for _, m in ipairs({ 'n', 'i', 'x' }) do ok = ok or vim.fn.mapcheck(lhs, m) ~= '' end \
               if not ok then out[#out + 1] = lhs end \
             end return out"
                .into(),
            rmpv::Value::Array(vec![rmpv::Value::Array(lhss)]),
        ],
    );
    assert_eq!(
        unmapped.as_array().map(Vec::len),
        Some(0),
        "no Lua map: {unmapped:?}"
    );
    assert_eq!(
        v.cx.update(|_, cx| vimstorm::editor::input::feel(cx)),
        FeelName::Vscode
    );
}

#[test]
fn feel_vscode_alt_arrows_move_lines_cmd_shift_k_deletes_and_cmd_t_is_symbols() {
    let dir = project(&[("m.txt", "one\ntwo\nthree\n".into())]);
    let mut v = View::start(path(&dir), &["m.txt"]);
    v.wait_screen("three");
    feel_vscode(&mut v);
    v.key("alt+arrow_down");
    v.wait_lua(
        "⌥↓ moved line 1 down",
        "local l = vim.api.nvim_buf_get_lines(0, 0, -1, false) \
         return l[1] == 'two' and l[2] == 'one' and vim.fn.line('.') == 2",
    );
    v.key("alt+shift+arrow_up");
    v.wait_lua(
        "⌥⇧↑ copied it",
        "return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), ',') == 'two,one,one,three'",
    );
    v.key("super+shift+k");
    v.wait_lua(
        "⌘⇧K deleted it",
        "return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), ',') == 'two,one,three'",
    );
    // ⌘T: not the Chat column's Terminal, nvim's Go to Symbol in Workspace
    v.key("super+t");
    wait_picker(&mut v, "⌘T opens the symbols", Some("symbols"));
}

#[test]
fn swedish_cmd_shift_keys_comment_and_fold_all() {
    let dir = project(&[(
        "f.lua",
        "local function f()\n  return 1\nend\nreturn f\n".into(),
    )]);
    let mut v = View::start(path(&dir), &["f.lua"]);
    v.wait_screen("local function f()");
    // Cmd+/ is Cmd+Shift+7 here (GPUI: "/" without Shift -> <D-S-7> -> config/app.lua -> <D-/>)
    v.key("super+shift+digit_7");
    v.wait_lua(
        "commented",
        "return vim.api.nvim_get_current_line() == '-- local function f()'",
    );
    v.key("super+shift+digit_7");
    v.wait_lua(
        "uncommented",
        "return vim.api.nvim_get_current_line() == 'local function f()'",
    );
    // Cmd+Shift+- / Cmd+Shift++ (GPUI: "_" / "?" -> <D-S--> / <D-S-+>): collapse / expand all
    v.key("super+shift+-");
    v.wait_lua("collapsed all", "return vim.fn.foldclosed(1) == 1");
    v.key("super+shift++");
    v.wait_lua("expanded all", "return vim.fn.foldclosed(1) == -1");
    // Cmd+- / Cmd++ : the region at the caret
    v.key("super+-");
    v.wait_lua("collapsed", "return vim.fn.foldclosed(1) == 1");
    v.key("super++");
    v.wait_lua("expanded", "return vim.fn.foldclosed(1) == -1");
}

#[test]
fn cmd_w_extends_cmd_shift_w_shrinks_and_cmd_d_duplicates() {
    let dir = project(&[("w.txt", "alpha beta\n".into())]);
    let mut v = View::start(path(&dir), &["w.txt"]);
    v.wait_screen("alpha beta");
    v.key("super+w");
    v.wait_lua(
        "word selected",
        "return vim.fn.mode() == 'v' and vim.fn.getregion(vim.fn.getpos('v'), vim.fn.getpos('.'))[1] == 'alpha'",
    );
    v.key("super+shift+w");
    v.wait_lua("back to the caret", "return vim.fn.mode() == 'n'");
    v.key("super+d");
    v.wait_lua(
        "line duplicated",
        "local l = vim.api.nvim_buf_get_lines(0, 0, -1, false) \
         return l[1] == 'alpha beta' and l[2] == 'alpha beta'",
    );
}

#[test]
fn ctrl_l_and_ctrl_oe_add_carets_and_esc_drops_them() {
    let dir = project(&[("c.txt", "one\ntwo\nthree\n".into())]);
    let mut v = View::start(path(&dir), &["c.txt"]);
    v.wait_screen("three");
    v.lua("vim.api.nvim_win_set_cursor(0, { 2, 0 }) return true");
    let carets = |n: usize| format!("return require('multicursor-nvim').numCursors() == {n}");
    v.key("ctrl+ö");
    v.wait_lua("caret below", &carets(2));
    // going back the other way removes it again, then adds above
    v.key("ctrl+l");
    v.wait_lua("caret below removed", &carets(1));
    v.key("ctrl+l");
    v.wait_lua("caret above", &carets(2));
    v.key("escape");
    v.wait_lua("one caret", &carets(1));
}

/// Typing with several carets changes every caret's row on screen as it's typed (WebStorm), not when
/// Insert mode ends.
#[test]
fn typing_with_several_carets_shows_on_every_row_before_esc() {
    let dir = project(&[("c.txt", "one\ntwo\nthree\n".into())]);
    let mut v = View::start(path(&dir), &["c.txt"]);
    v.wait_screen("three");
    v.key("ctrl+ö");
    v.key("ctrl+ö");
    v.wait_lua(
        "three carets",
        "return require('multicursor-nvim').numCursors() == 3",
    );
    v.key("i");
    v.key("x");
    v.key("y");
    v.wait_for("every row typed on screen", |e| {
        let lines = e.ui().screen_lines();
        ["xyone", "xytwo", "xythree"]
            .iter()
            .all(|t| lines.iter().any(|l| l.contains(t)))
    });
    assert_eq!(v.mode(), "i", "still typing when every row shows it");
    v.key("escape");
    v.wait_lua("Normal mode", "return vim.fn.mode() == 'n'");
}

/// The other carets as they're drawn: screen (row, col) and shape, via the shared caret code
/// (`UiState::caret_at`, what `render/grid.rs` paints for the caret too).
fn drawn_carets(e: &vimstorm::editor::EditorView) -> Vec<(i64, i64, vimstorm::nvim::CursorShape)> {
    let ui = e.ui();
    let mut out: Vec<_> = e
        .extra_carets()
        .into_iter()
        .filter_map(|c| ui.caret_at(c, ui.grids.get(&c.grid)?))
        .map(|c| (c.row, c.col, c.shape))
        .collect();
    out.sort_by_key(|c| (c.0, c.1));
    out
}

/// Feel vscode's multi-cursor: ⌘D selects the word, ⌘D again adds its next occurrence, ⌥click
/// adds a caret; the app draws the other carets like the caret (block in Normal / Visual mode, a bar
/// while typing) from Lua's `vimstorm.carets`, nvim's grid none of them (no caret-coloured cell).
#[test]
fn feel_vscode_cmd_d_and_alt_click_carets_are_drawn_like_the_caret() {
    use vimstorm::nvim::CursorShape;
    let dir = project(&[("w.txt", "foo bar foo\nbaz\n".into())]);
    let mut v = View::start(path(&dir), &["w.txt"]);
    v.wait_screen("baz");
    feel_vscode(&mut v);
    let (row, col) = v.cell_of("foo bar");
    let (row, col) = (row as i64, col as i64);
    v.key("super+d");
    v.wait_lua("the word selected", "return vim.fn.mode() == 'v'");
    v.key("super+d");
    v.wait_lua(
        "its next occurrence added",
        "return require('multicursor-nvim').numCursors() == 2",
    );
    // the first foo's caret (the newest selection, the second foo, has nvim's own)
    v.wait_for("the other caret drawn at the first foo's end", |e| {
        drawn_carets(e) == [(row, col + 2, CursorShape::Block)]
    });
    let cell_bg = v.ui(|ui| {
        let (g, r, c) = ui.hit_test(row, col + 2).expect("grid cell");
        let cell = ui.grids.get(&g).and_then(|grid| grid.cell(r, c)).cloned();
        ui.colors(cell.unwrap_or_default().hl).1
    });
    assert_ne!(
        cell_bg,
        vimstorm::nvim::CARET_COLOR,
        "nvim's grid draws no block for it"
    );
    v.keystrokes("c z");
    v.wait_for("typing at both, the other caret a bar after its z", |e| {
        let lines = e.ui().screen_lines();
        lines.iter().any(|l| l.contains("z bar z"))
            && drawn_carets(e) == [(row, col + 1, CursorShape::Vertical)]
    });
    v.key("escape");
    v.key("escape");
    v.wait_for("one caret: none drawn besides it", |e| {
        e.extra_carets().is_empty()
    });
    // ⌥click on baz: a caret there
    let at = v.cell_pos(row as usize + 1, col as usize);
    v.cx.simulate_mouse_down(
        at,
        MouseButton::Left,
        Modifiers {
            alt: true,
            ..Default::default()
        },
    );
    v.cx.simulate_event(gpui_kit::MouseUpEvent {
        position: at,
        modifiers: Modifiers {
            alt: true,
            ..Default::default()
        },
        button: MouseButton::Left,
        click_count: 1,
    });
    v.wait_lua(
        "⌥click added a caret",
        "return require('multicursor-nvim').numCursors() == 2",
    );
    v.wait_for("...drawn where the caret was", |e| {
        drawn_carets(e).len() == 1
    });
}

#[test]
fn ctrl_arrows_and_bookmark_jumps_work_from_the_tree() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1;");
    // bookmark 1 in a.ts, then a second tab
    v.key("ctrl+shift+digit_1");
    v.wait_lua(
        "bookmark set",
        "local b = require('config.bookmarks').list()[1] \
         return b ~= nil and b.num == 1 and vim.fs.basename(b.file) == 'a.ts'",
    );
    v.lua("vim.cmd.edit('multi.txt') return true");
    v.wait_screen("alpha one");
    v.key("super+digit_1");
    v.wait_lua(
        "tree focused",
        "return require('config.app').native() == 'tree'",
    );
    // Ctrl+→ from the tree: the editor's next tab (as from the Lua tree)
    v.key("ctrl+arrow_right");
    v.wait_lua("next tab", "return vim.fn.expand('%:t') == 'a.ts'");
    v.key("ctrl+arrow_left");
    v.wait_lua("previous tab", "return vim.fn.expand('%:t') == 'multi.txt'");
    // Ctrl+1 from the tree: bookmark 1 (Cmd+1 again would close the tree)
    v.lua("if require('config.app').native() ~= 'tree' then require('config.app').focus('tree') end return true");
    v.wait_lua(
        "tree focused again",
        "return require('config.app').native() == 'tree'",
    );
    v.key("ctrl+digit_1");
    v.wait_lua("at bookmark 1", "return vim.fn.expand('%:t') == 'a.ts'");
}

/// Shift Shift opens Search Everywhere on its All tab from each place the keyboard can be.
#[test]
fn shift_shift_opens_search_everywhere_from_each_place() {
    const ROWS: &[(&str, &str, &str)] = &[
        (
            "normal mode",
            "",
            "return vim.api.nvim_get_mode().mode == 'n'",
        ),
        (
            "insert mode",
            "i",
            "return vim.api.nvim_get_mode().mode == 'i'",
        ),
        (
            "insert mode after typing",
            "i a b",
            "return vim.api.nvim_get_current_line():find('ab', 1, true) ~= nil",
        ),
        (
            "the tree",
            "cmd-1",
            "return require('config.app').native() == 'tree'",
        ),
    ];
    let dir = own_multi();
    for (name, keys, ready) in ROWS {
        let mut v = View::start(path(&dir), &["multi.txt"]);
        v.wait_screen("alpha one");
        if !keys.is_empty() {
            v.keystrokes(keys);
        }
        v.wait_lua(name, ready);
        for _ in 0..2 {
            v.modifiers(SHIFT);
            v.modifiers(Modifiers::default());
        }
        wait_picker(&mut v, &format!("{name}: Search Everywhere"), Some("all"));
    }
}

/// Double Shifts the app's detector reports for these steps: (ms from now, modifiers) or a key.
enum Step {
    Mods(u64, Modifiers),
    Key(&'static str),
}

fn detected(steps: &[Step]) -> usize {
    let mut k = Keys::new();
    let t0 = Instant::now();
    let mut n = 0;
    for s in steps {
        let actions = match s {
            Step::Mods(ms, m) => k.modifiers_changed(*m, t0 + Duration::from_millis(*ms)),
            Step::Key(trigger) => k.key_down(&input::down(trigger).unwrap()).actions,
        };
        n += actions
            .iter()
            .filter(|a| matches!(a, Action::Lua { code, .. } if code.contains("double_shift")))
            .count();
    }
    n
}

/// The app's Shift Shift detector counts one double tap after typing and after a held Shift.
#[test]
fn the_double_shift_detector_counts_one_double_tap() {
    use Step::*;
    const NONE: Modifiers = Modifiers {
        shift: false,
        control: false,
        alt: false,
        platform: false,
        function: false,
    };
    let rows: &[(&str, &[Step])] = &[
        (
            "typing, then a double tap",
            &[
                Key("a"),
                Key("b"),
                Mods(220, SHIFT),
                Mods(300, NONE),
                Mods(420, SHIFT),
                Mods(500, NONE),
            ],
        ),
        (
            "a held Shift, then a double tap",
            &[
                Mods(0, SHIFT),
                Mods(600, NONE),
                Mods(720, SHIFT),
                Mods(800, NONE),
                Mods(920, SHIFT),
                Mods(1000, NONE),
            ],
        ),
    ];
    for (name, steps) in rows {
        assert_eq!(detected(steps), 1, "{name}");
    }
}

#[test]
fn unmapped_cmd_keys_and_alt_space_keep_typing() {
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    v.key("i");
    v.wait_for("insert mode", |v| v.ui().mode == "insert");
    // Cmd+N, Cmd+8: nothing (Ghostty kept them; config/app.lua drops unmapped Cmd keys)
    v.key("super+n");
    v.key("super+digit_8");
    // Alt+Space: Quick Definition (no language server in a .txt: a balloon), never Esc + Space
    v.key("alt+space");
    v.settle();
    v.ime_commit("z");
    v.wait_lua(
        "still typing, nothing inserted",
        "return vim.fn.mode() == 'i' and vim.api.nvim_get_current_line() == 'zalpha one'",
    );
}

#[test]
fn font_size_keys_resize_the_cells_and_cmd_0_resets() {
    let mut v = View::start("proj", &["multi.txt"]);
    v.wait_screen("alpha one");
    init_app_menu(&mut v);
    let size = |v: &mut View| v.read(|e| e.metrics().font_size.as_f32());
    let cols = |v: &mut View| v.read(|e| e.ui().screen_size().0);
    let (cols13, font13) = (cols(&mut v), size(&mut v));
    assert_eq!(font13, 13.);
    // Ctrl+Cmd++ (its own key on the Swedish layout) and Ctrl+Cmd+= (Shift+0)
    v.key("super+ctrl++");
    v.wait_for("14 pt", |e| e.metrics().font_size == px(14.));
    v.wait_for("fewer columns", |e| e.ui().screen_size().0 < cols13);
    v.key("super+ctrl+shift+digit_0");
    v.wait_for("15 pt", |e| e.metrics().font_size == px(15.));
    v.key("super+ctrl+-");
    v.wait_for("14 pt again", |e| e.metrics().font_size == px(14.));
    v.key("super+digit_0");
    v.wait_for("reset", |e| e.metrics().font_size == px(13.));
    v.wait_for("columns back", |e| e.ui().screen_size().0 == cols13);
    assert_eq!(v.current_line(), "alpha one", "nvim got none of the keys");
}

#[test]
fn ctrl_cmd_f_toggles_full_screen_and_menu_items_type_their_shortcut() {
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    init_app_menu(&mut v);
    let menus: Vec<String> = v.cx.update(|_, cx| {
        cx.get_menus()
            .unwrap_or_default()
            .iter()
            .map(|m| m.name.to_string())
            .collect()
    });
    for name in ["VimStorm", "File", "Edit", "View", "Code", "Git", "Window"] {
        assert!(menus.iter().any(|m| m == name), "menu {name}: {menus:?}");
    }

    v.key("super+ctrl+f");
    v.wait_until("full screen", |v| v.cx.update(|w, _| w.is_fullscreen()));
    v.key("super+ctrl+f");
    v.wait_until("windowed", |v| !v.cx.update(|w, _| w.is_fullscreen()));

    // Edit > Duplicate Line or Selection = Cmd+D typed into the window
    v.cx.update(|w, cx| w.dispatch_action(Box::new(vimstorm::app::Replay("cmd-d")), cx));
    v.wait_lua(
        "duplicated from the menu",
        "local l = vim.api.nvim_buf_get_lines(0, 0, 2, false) return l[1] == l[2]",
    );
    // Feel vscode took Cmd+D (next occurrence): the menu item still duplicates
    feel_vscode(&mut v);
    v.cx.update(|w, cx| w.dispatch_action(Box::new(vimstorm::app::Replay("cmd-d")), cx));
    v.wait_lua(
        "duplicated from the menu under vscode",
        "local l = vim.api.nvim_buf_get_lines(0, 0, 3, false) \
         return l[1] == l[2] and l[2] == l[3] \
           and require('multicursor-nvim').numCursors() == 1",
    );
}

/// The keys the menu bar shows, by item: each item's first binding, as GPUI's macOS menu reads it.
fn menu_keys(v: &mut View) -> Vec<(String, Option<String>)> {
    v.pump();
    v.cx.update(|_, cx| {
        let keymap = cx.key_bindings();
        let keymap = keymap.borrow();
        cx.get_menus()
            .unwrap_or_default()
            .iter()
            .flat_map(|m| m.items.iter())
            .filter_map(|i| match i {
                gpui_kit::OwnedMenuItem::Action { name, action, .. } => Some((
                    name.to_string(),
                    keymap.bindings_for_action(action.as_ref()).next().map(|b| {
                        b.keystrokes()
                            .iter()
                            .map(|k| k.unparse())
                            .collect::<Vec<_>>()
                            .join(" ")
                    }),
                )),
                _ => None,
            })
            .collect()
    })
}

/// The menu bar shows each Feel's keys: VimStorm's (WebStorm's) under the Feels vimstorm and
/// webstorm, VS Code's under vscode and never a WebStorm key VS Code does otherwise; each VS Code
/// key it shows is one the Feel's nvim maps, and its item does the action (Save All by ⌥⌘S).
#[test]
fn the_menu_bar_shows_each_feel_s_keys() {
    use vimstorm::factory::FeelName;
    let dir = own_multi();
    let mut v = View::start(path(&dir), &["multi.txt"]);
    v.wait_screen("alpha one");
    init_app_menu(&mut v);
    let key = |keys: &[(String, Option<String>)], title: &str| {
        keys.iter()
            .find(|(t, _)| t == title)
            .unwrap_or_else(|| panic!("no {title}"))
            .1
            .clone()
    };
    let gpui = |k: &str| Some(gpui_kit::Keystroke::parse(k).unwrap().unparse());
    let webstorm = [
        ("Go to File…", gpui("cmd-o")),
        ("Show Context Actions", None),
        ("Project", gpui("cmd-1")),
        ("Git", gpui("cmd-3")),
        ("Terminal", gpui("cmd-t")),
        ("Save All", gpui("cmd-s")),
        ("Commit…", gpui("cmd-k")),
        ("Duplicate Line or Selection", gpui("cmd-d")),
        ("Extend Selection", gpui("cmd-w")),
    ];
    for feel in [FeelName::Vimstorm, FeelName::Webstorm] {
        v.set_feel(|f| f.feel = feel);
        let keys = menu_keys(&mut v);
        for (title, want) in &webstorm {
            assert_eq!(&key(&keys, title), want, "{feel:?}: {title}");
        }
    }

    feel_vscode(&mut v);
    let keys = menu_keys(&mut v);
    for (title, want) in [
        ("Go to File…", gpui("cmd-p")),
        ("Show Context Actions", gpui("cmd-.")),
        ("Project", gpui("cmd-shift-e")),
        ("Terminal", gpui("ctrl-`")),
        ("Save All", gpui("alt-cmd-s")),
        ("Replace…", gpui("alt-cmd-f")),
        ("Extend Selection", gpui("ctrl-shift-cmd-right")),
        ("Next Tab", gpui("alt-cmd-right")),
        // VS Code's too, or VimStorm's own actions
        ("Find…", gpui("cmd-f")),
        ("Find Previous", gpui("cmd-shift-g")),
        ("Chat", gpui("cmd-4")),
        ("Git", gpui("cmd-3")),
        ("Claude Code", gpui("ctrl-cmd-right")),
        // VS Code's is an F-key, a chord or none: no key shown
        ("Declaration or Usages", None),
        ("Commit…", None),
        ("Push…", None),
        ("Duplicate Line or Selection", None),
        ("Recent Projects…", None),
    ] {
        assert_eq!(key(&keys, title), want, "vscode: {title}");
    }
    // the items that type a key (the app's own, Hide … Minimize, aside): as `shown_keys` says
    let typed = vimstorm::app::shown_keys(FeelName::Vscode);
    let keys: Vec<_> = keys
        .into_iter()
        .filter(|(t, _)| typed.iter().any(|(title, _)| title == t))
        .collect();
    for (title, k) in &typed {
        assert_eq!(key(&keys, title), k.and_then(gpui), "{title}");
    }
    // no item shows a key the Feel vscode took from WebStorm (⌘B, ⌘K, ⌘D, ⌘W, ⌘⇧K, ⌘⇧O …)
    for (title, k) in &keys {
        let Some(k) = k else { continue };
        let ks = gpui_kit::Keystroke::parse(k).unwrap();
        assert!(
            !v.cx
                .update(|_, cx| vimstorm::editor::input::vscode_took(&ks, cx)),
            "{title} shows {k}, which VS Code's Feel took"
        );
    }
    // each key shown has a Lua map under vscode, or is the window's own
    let lhss: Vec<rmpv::Value> = keys
        .iter()
        .filter_map(|(_, k)| k.as_deref())
        .filter_map(|k| vimstorm::kit::notation_of(&gpui_kit::Keystroke::parse(k).unwrap()))
        .map(rmpv::Value::from)
        .collect();
    let unmapped = v.request(
        "nvim_exec_lua",
        vec![
            // the window's own (Rust): the pane keys, the bottom panel, the Chat column, Drag Chat
            // Out, the Factory, Maximize, the jumps, the rail
            "local app = { ['<D-S-e>'] = 1, ['<D-3>'] = 1, ['<D-j>'] = 1, ['<C-D-Left>'] = 1, ['<C-D-Right>'] = 1, ['<D-4>'] = 1, ['<D-S-2>'] = 1, ['<M-D-2>'] = 1, \
               ['<D-S-d>'] = 1, ['<M-D-a>'] = 1, ['<M-D-CR>'] = 1, ['<C-M-w>'] = 1, \
               ['<C-M-l>'] = 1, ['<D-Up>'] = 1, ['<D-Down>'] = 1, ['<D-§>'] = 1 } \
             local out = {} for _, lhs in ipairs(...) do \
               local ok = app[lhs] ~= nil \
               for _, m in ipairs({ 'n', 'i', 'x' }) do ok = ok or vim.fn.mapcheck(lhs, m) ~= '' end \
               if not ok then out[#out + 1] = lhs end \
             end return out"
                .into(),
            rmpv::Value::Array(vec![rmpv::Value::Array(lhss)]),
        ],
    );
    assert_eq!(
        unmapped.as_array().map(Vec::len),
        Some(0),
        "shown, no Lua map: {unmapped:?}"
    );

    // File > Save All under vscode: ⌥⌘S typed, VS Code's Save All saves the edited file
    v.lua("vim.api.nvim_buf_set_lines(0, 0, 1, false, { 'edited' }) return true");
    let save = v.cx.update(|_, cx| {
        cx.get_menus()
            .unwrap_or_default()
            .iter()
            .flat_map(|m| m.items.iter())
            .find_map(|i| match i {
                gpui_kit::OwnedMenuItem::Action { name, action, .. } if name == "Save All" => {
                    Some(action.boxed_clone())
                }
                _ => None,
            })
            .unwrap()
    });
    v.cx.update(|w, cx| w.dispatch_action(save, cx));
    v.wait_lua("saved from the menu", "return not vim.bo.modified");

    // back to WebStorm's keys
    v.set_feel(|f| f.feel = FeelName::Webstorm);
    v.lua("require('config.feel').set({ feel = 'webstorm' }) return true");
    let keys = menu_keys(&mut v);
    assert_eq!(key(&keys, "Go to File…"), gpui("cmd-o"));
}

/// Feel vscode's Activity bar: Explorer · Search · Source Control in a 48 px column at the
/// window's left, the islands right of it; Explorer hides and shows the Project tree (lit while
/// it shows), Search opens Find in Files, Source Control the Git tool window. Any other Feel: none.
#[test]
fn feel_vscode_activity_bar_explorer_search_and_source_control() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1;");
    assert!(v.cx.debug_bounds("activity-bar").is_none());
    feel_vscode(&mut v);
    v.wait_until("the Activity bar drawn", |v| {
        v.cx.debug_bounds("activity-bar").is_some()
    });
    let bar = v.cx.debug_bounds("activity-bar").unwrap();
    assert_eq!((bar.left(), bar.size.width), (px(0.), px(48.)));
    let tree_left = |v: &mut View| v.read(|e| e.geometry().layout.tree.map(|t| t.left()));
    assert_eq!(
        tree_left(&mut v),
        Some(px(48.)),
        "the tree right of the bar"
    );
    let tree_open = |v: &mut View| v.read_ws(|ws, cx| ws.tree_open(cx));
    assert!(tree_open(&mut v));
    let item = |v: &mut View, name: &'static str| {
        v.cx.debug_bounds(name)
            .unwrap_or_else(|| panic!("{name} drawn"))
            .center()
    };
    let at = item(&mut v, "activity-explorer");
    v.click(MouseButton::Left, at);
    v.wait_until("Explorer hid the tree", |v| !tree_open(v));
    let at = item(&mut v, "activity-explorer");
    v.click(MouseButton::Left, at);
    v.wait_until("...and shows it again", |v| tree_open(v));
    let at = item(&mut v, "activity-search");
    v.click(MouseButton::Left, at);
    wait_picker(&mut v, "Search opens Find in Files", Some("grep"));
    v.key("escape");
    wait_picker(&mut v, "closed", None);
    let at = item(&mut v, "activity-scm");
    v.click(MouseButton::Left, at);
    v.wait_until("Source Control opens the Git tool window", |v| {
        v.read_ws(|ws, cx| ws.git().read(cx).is_open())
    });
    // any other Feel: no bar, the tree at the margin again
    v.set_feel(|_| {});
    v.lua("require('config.feel').set({}) return true");
    v.wait_until("no bar", |v| v.cx.debug_bounds("activity-bar").is_none());
    assert!(tree_left(&mut v).is_some_and(|l| l < px(48.)));
}

// Editor-only Cmd keys from other surfaces ----------------------------------------------------------

/// Editor-only Cmd keys (`Owner::Editor` in `input/keymap.rs`; Swedish: Cmd+/ is Cmd+Shift+7).
/// Not Cmd+C / X / A: the native terminal copies and selects with them.
const EDITOR_KEYS: &[&str] = &[
    "super+alt+z",
    "super+z",
    "super+d",
    "super+shift+digit_7",
    "super+w",
    "super+shift+z",
    "super+b",
    "super+l",
    "super+g",
    "super+r",
    "super+-",
];

/// A project of its own with an edited buffer: Cmd+Z would undo the edit, Cmd+D / Cmd+/ change
/// it. The buffer is remembered in `vim.g.edit_buf`.
fn edited_buffer() -> (tempfile::TempDir, View) {
    let dir = tempfile::Builder::new()
        .prefix("vimstorm-surface-keys-")
        .tempdir()
        .unwrap();
    std::fs::write(
        dir.path().join("f.lua"),
        "local a = 1\nlocal b = 2\nreturn a + b\n",
    )
    .unwrap();
    let mut v = View::start(dir.path().to_str().unwrap(), &["f.lua"]);
    v.wait_screen("local a = 1");
    v.lua(
        "vim.g.edit_buf = vim.api.nvim_get_current_buf() \
         vim.api.nvim_buf_set_lines(0, 0, 0, false, { '-- edited' }) return true",
    );
    v.wait_screen("-- edited");
    (dir, v)
}

/// The edited buffer's undo state + text (not changedtick: an autosave when focus moves bumps it).
fn snapshot(v: &View) -> String {
    v.lua(
        "local b = vim.g.edit_buf local u = vim.fn.undotree(b) \
         return u.seq_cur .. '/' .. u.seq_last .. '|' .. table.concat(vim.api.nvim_buf_get_lines(b, 0, -1, false), '\\n')",
    )
    .as_str()
    .unwrap_or_default()
    .to_owned()
}

fn native_is(v: &View, want: &str) -> bool {
    v.lua("return require('config.app').native() or ''")
        .as_str()
        == Some(want)
}

fn wait_native(v: &mut View, want: &str) {
    v.wait_lua(
        &format!("{want} has the keyboard"),
        &format!("return require('config.app').native() == '{want}'"),
    );
}

fn has_lazygit() -> bool {
    std::process::Command::new("which")
        .arg("lazygit")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A surface that takes the keyboard from the editor: `open` gives it the keyboard and returns
/// what `holds` compares against (None: skipped here), `holds` says it still has the keyboard,
/// `global` presses global keys and waits for their effect.
struct Surface {
    name: &'static str,
    open: fn(&mut View, &Path) -> Option<String>,
    holds: fn(&mut View, &str) -> bool,
    global: fn(&mut View),
}

const SURFACES: &[Surface] = &[
    Surface {
        name: "the tree",
        open: |v, _| {
            v.key("super+digit_1");
            wait_native(v, "tree");
            Some(String::new())
        },
        holds: |v, _| native_is(v, "tree"),
        global: |v| {
            v.key("super+o");
            wait_picker(v, "Go to File", Some("files"));
            v.key("escape");
            wait_picker(v, "closed", None);
            wait_native(v, "tree");
            v.key("super+t");
            common::terminal::wait_typing(v);
        },
    },
    Surface {
        name: "a picker",
        open: |v, _| {
            for _ in 0..2 {
                v.modifiers(SHIFT);
                v.modifiers(Modifiers::default());
            }
            wait_picker(v, "Search Everywhere", Some("all"));
            wait_native(v, "pickers");
            Some(String::new())
        },
        holds: |v, _| native_is(v, "pickers"),
        global: |v| {
            v.key("super+shift+o");
            wait_picker(v, "Recent Projects", Some("projects"));
            v.key("super+digit_1");
            wait_native(v, "tree");
        },
    },
    Surface {
        name: "a popup",
        open: |v, _| {
            v.lua("vim.ui.input({ prompt = 'Name' }, function() end) return true");
            wait_native(v, "popups");
            Some(String::new())
        },
        holds: |v, _| native_is(v, "popups"),
        global: |v| {
            v.key("super+t");
            common::terminal::wait_typing(v);
        },
    },
    Surface {
        name: "the focused hover",
        open: |v, _| {
            v.lua(
                "local f = require('config.app.floats') \
                 f.show_hover('hover', { f.markdown('docs\\n\\nmore docs') }, f.caret(), vim.api.nvim_get_current_buf()) \
                 return true",
            );
            v.wait_until("hover shown", |v| {
                let ws = v.ws.clone();
                v.cx.update(|window, cx| {
                    ws.read(cx).floats().read(cx).shown(window).hover.is_some()
                })
            });
            v.lua("require('config.app.floats').enter_hover() return true");
            wait_native(v, "floats");
            Some(String::new())
        },
        holds: |v, _| native_is(v, "floats"),
        global: |v| {
            for _ in 0..2 {
                v.modifiers(SHIFT);
                v.modifiers(Modifiers::default());
            }
            wait_picker(v, "Search Everywhere", Some("all"));
        },
    },
    Surface {
        name: "the terminal",
        open: |v, _| {
            common::terminal::open(v);
            Some(common::terminal::prompt(v))
        },
        holds: |v, shell| {
            common::terminal::settle(v);
            common::terminal::typing(v) && common::terminal::prompt(v) == shell
        },
        global: |v| {
            // Go to File and Find in Files take the typed text; Esc gives back typing in the shell
            for (key, kind) in [("super+o", "files"), ("super+shift+f", "grep")] {
                v.key(key);
                wait_picker(v, kind, Some(kind));
                for c in ["a", "b", "c"] {
                    v.key(c);
                }
                v.wait_until(&format!("{kind}: typing goes into its field"), |v| {
                    v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| s.query))
                        .as_deref()
                        == Some("abc")
                });
                v.key("escape");
                wait_picker(v, "closed", None);
                common::terminal::wait_typing(v);
            }
        },
    },
    Surface {
        name: "terminal find",
        open: |v, _| {
            common::terminal::open(v);
            v.keystrokes("cmd-f");
            v.wait_until("find bar with the keyboard", |v| {
                common::terminal::find_label(v).is_some() && !common::terminal::typing(v)
            });
            Some(String::new())
        },
        holds: |v, _| native_is(v, "terminal") && common::terminal::find_label(v).is_some(),
        global: |v| {
            v.key("super+o");
            wait_picker(v, "Go to File", Some("files"));
        },
    },
    Surface {
        name: "the lazygit float",
        open: |v, dir| {
            if !has_lazygit() {
                eprintln!("lazygit not installed: skipped");
                return None;
            }
            let ok = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(ok.status.success(), "git init");
            v.keystrokes(", shift-g");
            v.wait_until("the float is up", |v| {
                common::terminal::read(v, |t, _| t.float_open())
            });
            v.wait_until("lazygit drew", |v| {
                common::terminal::read(v, |t, _| t.float_screen())
                    .iter()
                    .any(|l| l.contains("Status") || l.contains("Files"))
            });
            Some(String::new())
        },
        holds: |v, _| common::terminal::read(v, |t, _| t.float_open()),
        global: |v| {
            v.key("super+o");
            wait_picker(v, "Go to File", Some("files"));
        },
    },
];

/// Editor actions apply to the focused component only (WebStorm): while another surface has the
/// keyboard the editor-only Cmd keys never reach the edited buffer behind it, and the global keys
/// still work from there.
#[test]
fn editor_cmd_keys_stay_out_of_the_buffer_from_every_surface() {
    for s in SURFACES {
        let (dir, mut v) = edited_buffer();
        let Some(baseline) = (s.open)(&mut v, dir.path()) else {
            continue;
        };
        let before = snapshot(&v);
        for k in EDITOR_KEYS {
            v.key(k);
        }
        assert!(
            (s.holds)(&mut v, &baseline),
            "{}: kept the keyboard",
            s.name
        );
        (s.global)(&mut v);
        assert_eq!(
            snapshot(&v),
            before,
            "{}: the buffer behind it changed",
            s.name
        );
        assert_eq!(v.mode(), "n", "{}: Cmd+W started Visual mode", s.name);
    }
}
