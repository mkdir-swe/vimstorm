//! The Project tree on the real nvim + config, driven with real keys and mouse: rows, git colors,
//! excluded rows, the root row, keys, chevrons and double-clicks, menus, file actions,
//! multi-selection, drag and drop, speed search with folds, the session's tree state and a
//! 10k-file tree. Moving never changes the editor (no preview). Most tests stub Lua's popups
//! (vim.ui.input and select, the menu) with recorders, since popups.rs owns them; the tests on
//! `start_native` use the real native menus.

use crate::common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use common::gitui::{bounds, menu_rows, menu_title, pick_menu, press, target, wait_target};
use common::tree::{chevron, row_point, tree, tv, wait_tree};
use common::view::View;
use gpui_kit::{
    ExternalPaths, FileDropEvent, Modifiers, MouseButton, Pixels, Point, ScrollDelta, SharedString,
    TextRun, TouchPhase, point, px,
};
use rmpv::Value;
use vimstorm::git::FileStatus;
use vimstorm::look;

fn cur(v: &mut View) -> String {
    tv(v, |t| t.cursor().unwrap_or_default())
}

fn listed(v: &mut View, rel: &str) -> bool {
    tv(v, |t| t.row_index(rel).is_some())
}

fn selected(v: &mut View) -> Vec<String> {
    tv(v, |t| t.selected())
}

/// Cmd+1 until the tree has the keyboard (Cmd+1 on a focused tree closes it).
fn focus_tree(v: &mut View) {
    if target(v) != "tree" {
        v.key("super+digit_1");
    }
    wait_target(v, "tree");
}

/// Selects a row the way the keys would leave it (setup for what's checked next).
fn sel(v: &mut View, rel: &str) {
    let t = tree(v);
    let rel2 = rel.to_owned();
    v.cx.update(|window, cx| {
        t.update(cx, |t, cx| {
            let p = t.root().join(&rel2);
            t.test_select(&p, window, cx)
        })
    });
    wait_tree(v, &format!("{rel} selected"), |t| {
        t.cursor().as_deref() == Some(rel)
    });
}

fn click(v: &mut View, at: Point<Pixels>) {
    press(v, at, MouseButton::Left, Modifiers::default(), 1);
}

fn exists(v: &mut View, rel: &str) -> bool {
    tv(v, |t| t.root().join(rel).exists())
}

/// Lua recorders for the popups the tree opens: vim.ui.input / select answer from `_G.answers`,
/// the menu is kept in `_G.menu` (`run_item(label)` runs one of its items).
const STUBS: &str = r#"
  _G.asked, _G.answers = {}, {}
  vim.ui.input = function(opts, cb)
    table.insert(_G.asked, { kind = 'input', prompt = opts.prompt, default = opts.default })
    cb(table.remove(_G.answers, 1))
  end
  vim.ui.select = function(items, opts, cb)
    table.insert(_G.asked, { kind = 'select', prompt = opts.prompt })
    local a = table.remove(_G.answers, 1)
    for i, it in ipairs(items) do if it == a then return cb(it, i) end end
    cb(nil, nil)
  end
  _G.menu = nil
  require('config.menu').open = function(items, opts) _G.menu = { items = items, opts = opts } end
  _G.menu_labels = function()
    if not _G.menu then return '' end
    local out = {}
    for _, it in ipairs(_G.menu.items) do out[#out + 1] = type(it) == 'table' and it[1] or '-' end
    return table.concat(out, '|')
  end
  _G.run_item = function(label)
    for _, it in ipairs(_G.menu.items) do
      if type(it) == 'table' and it[1] == label then _G.menu = nil it[2]() return true end
    end
    return false
  end
  _G.revealed = nil
  require('config.tree').run = function(cmd) _G.revealed = cmd end
  return true
"#;

fn stubs(v: &mut View) {
    v.lua(STUBS);
}

fn answer(v: &mut View, answers: &[&str]) {
    let list = answers
        .iter()
        .map(|a| format!("{a:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    v.lua(&format!("_G.answers = {{ {list} }} return true"));
}

fn menu_labels(v: &mut View) -> String {
    v.lua("return _G.menu_labels()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn wait_menu(v: &mut View, has: &str) -> String {
    v.wait_lua(
        &format!("menu with {has}"),
        &format!("return _G.menu_labels():find({has:?}, 1, true) ~= nil"),
    );
    menu_labels(v)
}

fn run_item(v: &mut View, label: &str) {
    assert_eq!(
        v.lua(&format!("return _G.run_item({label:?})")).as_bool(),
        Some(true),
        "menu item {label}: {}",
        menu_labels(v)
    );
}

/// The current buffer's name (absolute).
fn buf_name(v: &View) -> String {
    v.lua("return vim.api.nvim_buf_get_name(0)")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=T", "-c", "user.email=t@x"])
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A project of committed files, then local changes (b.ts + src/main.ts modified,
/// new.ts untracked), ignored files, node_modules, an empty folder, a symlink, a named module.
fn make_project() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-tree-")
        .tempdir()
        .unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("tproj");
    for (f, t) in [
        (".gitignore", "node_modules\n*.log\n"),
        ("a.ts", "export const a = 1;\n"),
        ("b.ts", "export const b = 2;\n"),
        ("c.ts", "export const c = 3;\n"),
        ("package.json", "{ \"name\": \"tproj\" }\n"),
        ("ignored.log", "log\n"),
        ("rn.tsx", "export {}\n"),
        ("src/main.ts", "export const m = 1;\n"),
        ("src/util.ts", "export const u = 1;\n"),
        ("backend/scripts/en.json", "{\"x\":1}\n"),
        ("backend/server.ts", "export const s = 1;\n"),
        ("node_modules/lib/index.js", "module.exports = {}\n"),
        ("multi/a.ts", "x"),
        ("multi/b.ts", "x"),
        ("multi/c.ts", "x"),
        ("multi/d.ts", "x"),
        ("multi/e.ts", "x"),
        ("multi/sub/keep.ts", "x"),
        (
            ".idea/modules.xml",
            "<module fileurl=\"file://$PROJECT_DIR$/.idea/tproj-web.iml\" filepath=\"$PROJECT_DIR$/.idea/tproj-web.iml\" />\n",
        ),
    ] {
        write(&dir, f, t);
    }
    std::fs::create_dir_all(dir.join("emptydir")).unwrap();
    std::os::unix::fs::symlink("a.ts", dir.join("link.ts")).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    write(&dir, "b.ts", "export const b = 3;\n");
    write(&dir, "src/main.ts", "export const m = 2;\n");
    write(&dir, "new.ts", "new\n");
    (tmp, dir)
}

fn start(dir: &Path, files: &[&str]) -> View {
    vimstorm::shell::tree::USE_TRASH.store(false, std::sync::atomic::Ordering::Relaxed);
    let mut v = View::start(dir.to_str().unwrap(), files);
    stubs(&mut v);
    v
}

/// The window with the real native menus: no Lua recorders.
fn start_native(dir: &Path, files: &[&str]) -> View {
    vimstorm::shell::tree::USE_TRASH.store(false, std::sync::atomic::Ordering::Relaxed);
    View::start(dir.to_str().unwrap(), files)
}

/// Finder is a recorder (`_G.revealed`: the command it would run).
fn stub_finder(v: &mut View) {
    v.lua("_G.revealed = nil require('config.tree').run = function(cmd) _G.revealed = cmd end return true");
}

fn wait_menu_row(v: &mut View, label: &str) -> Vec<String> {
    v.wait_until(&format!("menu with {label:?}"), |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains(label)))
    });
    menu_rows(v).unwrap()
}

fn query(v: &mut View) -> Option<String> {
    tv(v, |t| t.query().map(str::to_owned))
}

fn island(v: &mut View) -> gpui_kit::Bounds<Pixels> {
    v.read(|e| e.geometry().layout.tree.unwrap())
}

/// `~/x` for a path in the home folder, as the root row shows it.
fn home_relative(p: &Path) -> String {
    match std::env::var_os("HOME").and_then(|h| p.strip_prefix(h).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => p.display().to_string(),
    }
}

/// Width of `text` in the tree's font (Inter, UI size).
fn text_width(v: &mut View, text: &str) -> f32 {
    let text: SharedString = text.to_owned().into();
    v.cx.update(|window, _| {
        let run = TextRun {
            len: text.len(),
            font: vimstorm::render::ui_font(),
            color: gpui_kit::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        window
            .text_system()
            .shape_line(text.clone(), px(look::UI_FONT_SIZE), &[run], None)
            .width
            .as_f32()
    })
}

// Rows ------------------------------------------------------------------------------------------

#[test]
fn rows_chevrons_git_colors_excluded_and_root() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    wait_tree(&mut v, "git status read", |t| {
        t.git().status(Path::new("b.ts"), false).is_some()
    });
    let rows = tv(&mut v, |t| t.row_paths());
    // root first, folders first (byte order), .git / .DS_Store left out
    assert_eq!(
        rows,
        [
            "",
            ".idea",
            "backend",
            "emptydir",
            "multi",
            "node_modules",
            "src",
            ".gitignore",
            "a.ts",
            "b.ts",
            "c.ts",
            "ignored.log",
            "link.ts",
            "new.ts",
            "package.json",
            "rn.tsx"
        ]
    );
    let row = |v: &mut View, rel: &str| tv(v, |t| t.rows()[t.row_index(rel).unwrap()].clone());
    // folders get a chevron unless empty (asked in the background when first drawn)
    wait_tree(&mut v, "src has a chevron, emptydir none", |t| {
        t.has_chevron(t.row_index("src").unwrap())
            && !t.has_chevron(t.row_index("emptydir").unwrap())
    });
    assert!(row(&mut v, "link.ts").link);
    // names colored by git status: modified, untracked, ignored, folder with changes; clean plain
    let st = |v: &mut View, rel: &str, dir: bool| tv(v, |t| t.git().status(Path::new(rel), dir));
    assert_eq!(st(&mut v, "b.ts", false), Some(FileStatus::Modified));
    assert_eq!(st(&mut v, "new.ts", false), Some(FileStatus::Unversioned));
    assert_eq!(st(&mut v, "ignored.log", false), Some(FileStatus::Ignored));
    assert_eq!(st(&mut v, "src", true), Some(FileStatus::Modified));
    assert_eq!(st(&mut v, "backend", true), None);
    assert_eq!(st(&mut v, "package.json", false), None);
    // node_modules: excluded (tinted row), ignored (orange name)
    assert!(row(&mut v, "node_modules").excluded);
    assert!(!row(&mut v, "src").excluded);
    assert_eq!(st(&mut v, "node_modules", true), Some(FileStatus::Ignored));
    // the root row: project name + [module], the first row under the "Project" header
    assert_eq!(tv(&mut v, |t| t.module()), Some("tproj-web".to_owned()));
    let top = tv(&mut v, |t| t.row_point(0, 0.).unwrap().y);
    let island = v.read(|e| e.geometry().layout.tree.unwrap());
    assert_eq!(
        top - px(theme_row() / 2.),
        island.origin.y + px(1. + 31. + 2.5),
        "root row under the header: {top:?} vs {island:?}"
    );

    // errors (from Lua's diagnostics): the file and its folders get the underline
    v.lua(
        "vim.diagnostic.set(vim.api.nvim_create_namespace('tree_test'), vim.fn.bufadd('src/main.ts'), \
         { { lnum = 0, col = 0, message = 'boom', severity = vim.diagnostic.severity.ERROR } }) return true",
    );
    wait_tree(&mut v, "error underline on src", |t| {
        t.has_problem(&t.root().join("src")) && t.has_problem(&t.root().join("src/main.ts"))
    });
}

fn theme_row() -> f32 {
    vimstorm::look::TREE_ROW_HEIGHT.get()
}

// Keys ------------------------------------------------------------------------------------------

#[test]
fn keys_expand_collapse_move_and_escape() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    sel(&mut v, "backend");
    v.key("arrow_right");
    wait_tree(&mut v, "→ expands", |t| {
        t.row_index("backend/scripts").is_some()
    });
    v.key("arrow_right");
    assert_eq!(
        cur(&mut v),
        "backend/scripts",
        "→ on an open folder: first child"
    );
    v.key("arrow_left");
    assert_eq!(cur(&mut v), "backend", "← on a closed folder: parent");
    v.key("arrow_left");
    assert!(
        !listed(&mut v, "backend/scripts"),
        "← on an open folder collapses"
    );
    sel(&mut v, "c.ts");
    v.key("arrow_right");
    assert_eq!(cur(&mut v), "c.ts", "→ on a file does nothing");
    // his keys: ä / k like → / ←, ö / l down / up, capitals 5 rows
    sel(&mut v, "backend");
    v.key("ä");
    assert!(listed(&mut v, "backend/scripts"));
    v.key("ä");
    assert_eq!(cur(&mut v), "backend/scripts");
    v.key("k");
    assert_eq!(cur(&mut v), "backend");
    v.key("k");
    assert!(!listed(&mut v, "backend/scripts"));
    v.key("ö");
    assert_eq!(cur(&mut v), "emptydir");
    v.key("l");
    assert_eq!(cur(&mut v), "backend");
    v.key("shift+ö");
    assert_eq!(cur(&mut v), ".gitignore");
    v.key("shift+l");
    assert_eq!(cur(&mut v), "backend");
    v.key("end");
    assert_eq!(cur(&mut v), "rn.tsx");
    v.key("home");
    assert_eq!(cur(&mut v), "");
    // other letters do nothing (no search, nothing typed into the buffer)
    v.key("w");
    v.key("z");
    assert_eq!(tv(&mut v, |t| t.query().map(str::to_owned)), None);
    assert_eq!(target(&v), "tree");
    // Enter on a folder toggles it; on a file opens it (focus to the editor)
    sel(&mut v, "src");
    v.key("enter");
    assert!(listed(&mut v, "src/main.ts"));
    v.key("enter");
    assert!(!listed(&mut v, "src/main.ts"));
    sel(&mut v, "c.ts");
    v.key("enter");
    wait_target(&mut v, "split");
    v.wait_lua(
        "c.ts opened",
        "return vim.api.nvim_buf_get_name(0):match('/c%.ts$') ~= nil",
    );
    // Esc in the tree: back to the editor
    focus_tree(&mut v);
    v.key("escape");
    wait_target(&mut v, "split");
}

// Moving through the tree / the search results never changes the editor ---------------------------

#[test]
fn moving_never_changes_the_editor_only_enter_opens() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    let before = buf_name(&v);
    focus_tree(&mut v);
    sel(&mut v, "src");
    v.key("arrow_right");
    for k in ["ö", "ö", "arrow_down", "l", "arrow_up"] {
        v.key(k);
    }
    // a single click on a file only selects it
    let p = row_point(&mut v, "src/util.ts", 4.);
    click(&mut v, p);
    assert_eq!(cur(&mut v), "src/util.ts");
    // the search results: moving through them doesn't preview either
    v.key("shift+digit_7");
    for c in ["t", "s"] {
        v.key(c);
    }
    wait_tree(&mut v, "results", |t| {
        t.match_count().is_some_and(|n| n > 2)
    });
    for _ in 0..4 {
        v.key("arrow_down");
    }
    v.settle();
    assert_eq!(buf_name(&v), before, "the editor shows what it showed");
    assert_eq!(target(&v), "tree");
    assert_eq!(
        v.lua("return #vim.tbl_filter(function(b) return vim.bo[b].buflisted end, vim.api.nvim_list_bufs())")
            .as_i64(),
        Some(1),
        "no buffer was opened for a preview"
    );
    // Enter opens the selected result
    let want = cur(&mut v);
    v.key("enter");
    v.wait_lua(
        "the result opened",
        &format!(
            "return vim.api.nvim_buf_get_name(0):sub(-{}) == {want:?}",
            want.len()
        ),
    );
}

// Mouse -----------------------------------------------------------------------------------------

#[test]
fn mouse_chevrons_double_clicks_and_menus() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    // a click on a chevron opens / closes the folder
    let c = chevron(&mut v, "src");
    click(&mut v, c);
    wait_tree(&mut v, "chevron opens", |t| {
        t.row_index("src/main.ts").is_some()
    });
    assert_eq!(target(&v), "tree", "a click focuses the tree");
    let c = chevron(&mut v, "src");
    click(&mut v, c);
    wait_tree(&mut v, "chevron closes", |t| {
        t.row_index("src/main.ts").is_none()
    });
    // double-click on a folder's name: open; two fast double-clicks (3rd / 4th click): closed again
    let p = row_point(&mut v, "src", 4.);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 1);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 2);
    assert!(listed(&mut v, "src/main.ts"));
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 3);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 4);
    assert!(!listed(&mut v, "src/main.ts"));
    assert_eq!(v.mode(), "n");
    // double-click on a file opens it
    let p = row_point(&mut v, "c.ts", 4.);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 1);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 2);
    v.wait_lua(
        "c.ts opened",
        "return vim.api.nvim_buf_get_name(0):match('/c%.ts$') ~= nil",
    );
    wait_target(&mut v, "split");

    // right-click on a file: its menu at the mouse
    let p = row_point(&mut v, "b.ts", 4.);
    press(&mut v, p, MouseButton::Right, Modifiers::default(), 1);
    let labels = wait_menu(&mut v, "Rename…");
    assert!(
        labels.contains("Reveal in Finder") && labels.contains("Open|"),
        "{labels}"
    );
    assert_eq!(cur(&mut v), "b.ts", "right-click selects the row");
    let pos = v.lua("return { _G.menu.opts.pos.x, _G.menu.opts.pos.y }");
    let xy: Vec<f64> = pos
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect();
    assert!(
        (xy[0] - f64::from(p.x.as_f32())).abs() < 1.
            && (xy[1] - f64::from(p.y.as_f32())).abs() < 1.
    );
    // Cmd+Enter: the same menu; below the rows: the selected row's
    v.lua("_G.menu = nil return true");
    v.key("super+enter");
    wait_menu(&mut v, "Collapse All");
    v.lua("_G.menu = nil return true");
    let island = v.read(|e| e.geometry().layout.tree.unwrap());
    let below = point(island.origin.x + px(40.), island.bottom() - px(10.));
    press(&mut v, below, MouseButton::Right, Modifiers::default(), 1);
    wait_menu(&mut v, "New File or Directory…");
    // menu items run on the tree: Collapse All / Select Opened File / Search in Tree…
    sel(&mut v, "src");
    v.key("arrow_right");
    v.key("super+enter");
    wait_menu(&mut v, "Collapse All");
    run_item(&mut v, "Collapse All");
    wait_tree(&mut v, "all collapsed", |t| t.row_paths().len() == 16);
    v.lua("vim.cmd.edit('src/util.ts') return true");
    v.key("super+enter");
    wait_menu(&mut v, "Select Opened File");
    run_item(&mut v, "Select Opened File");
    wait_tree(&mut v, "opened file selected", |t| {
        t.cursor().as_deref() == Some("src/util.ts")
    });
    wait_target(&mut v, "tree");
    v.key("super+enter");
    wait_menu(&mut v, "Search in Tree…");
    run_item(&mut v, "Search in Tree…");
    wait_tree(&mut v, "search open", |t| t.search_input());
}

#[test]
fn select_opened_file_with_leader_g() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    v.lua("vim.cmd.edit('src/util.ts') return true");
    // from the code: ,g selects the file in the tree (folders opened), tree focused
    v.keystrokes(", g");
    wait_tree(&mut v, ",g from the code", |t| {
        t.cursor().as_deref() == Some("src/util.ts")
    });
    wait_target(&mut v, "tree");
    // in the tree too
    sel(&mut v, "backend");
    v.key("super+shift+-");
    wait_tree(&mut v, "collapsed", |t| {
        t.row_index("src/util.ts").is_none()
    });
    v.key(",");
    v.key("g");
    wait_tree(&mut v, ",g in the tree", |t| {
        t.cursor().as_deref() == Some("src/util.ts")
    });
}

// File actions ----------------------------------------------------------------------------------

#[test]
fn new_rename_delete_copy_cut_paste() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    // ,n: new file with a new folder: created, opened in the editor, selected in the tree
    sel(&mut v, "src");
    answer(&mut v, &["qa_dir/qa_new.ts"]);
    v.key(",");
    v.key("n");
    v.wait_lua(
        "qa_new.ts opened",
        "return vim.api.nvim_buf_get_name(0):match('qa_dir/qa_new%.ts$') ~= nil",
    );
    assert!(exists(&mut v, "src/qa_dir/qa_new.ts"));
    wait_tree(&mut v, "new file selected", |t| {
        t.cursor().as_deref() == Some("src/qa_dir/qa_new.ts")
    });
    // a folder (ends with /): created and selected, keyboard stays in the tree
    focus_tree(&mut v);
    answer(&mut v, &["newdir/"]);
    v.key(",");
    v.key("n");
    wait_tree(&mut v, "new folder selected", |t| {
        t.cursor().as_deref() == Some("src/qa_dir/newdir")
    });
    assert_eq!(target(&v), "tree");

    // Backspace: WebStorm's confirmation, "Delete" deletes, the file's tab closes
    sel(&mut v, "src/qa_dir/qa_new.ts");
    answer(&mut v, &["Delete"]);
    v.key("backspace");
    wait_tree(&mut v, "deleted", |t| {
        t.row_index("src/qa_dir/qa_new.ts").is_none()
    });
    assert!(!exists(&mut v, "src/qa_dir/qa_new.ts"));
    assert_eq!(
        v.lua("return _G.asked[#_G.asked].prompt").as_str(),
        Some("Delete file \"qa_new.ts\"?")
    );
    v.wait_lua(
        "its buffer is gone",
        "for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_get_name(b):match('qa_new') and vim.bo[b].buflisted then return false end end return true",
    );
    // Cancel keeps it; Cmd+Backspace asks too
    sel(&mut v, "c.ts");
    answer(&mut v, &["Cancel"]);
    v.key("super+backspace");
    v.wait_lua(
        "asked",
        "return _G.asked[#_G.asked].prompt == 'Delete file \"c.ts\"?'",
    );
    assert!(exists(&mut v, "c.ts"));

    // Cmd+C on a file, Cmd+V on a folder: copies it there; the clipboard has its path
    sel(&mut v, "c.ts");
    v.key("super+c");
    v.wait_lua(
        "path copied",
        "return vim.fn.getreg('+'):match('/c%.ts') ~= nil",
    );
    sel(&mut v, "src/qa_dir");
    v.key("super+v");
    wait_tree(&mut v, "copied", |t| {
        t.root().join("src/qa_dir/c.ts").exists()
    });
    assert!(exists(&mut v, "c.ts"));

    // Shift+F6: the name field with the name, Enter renames (selected after)
    sel(&mut v, "rn.tsx");
    answer(&mut v, &["renamed.tsx"]);
    v.key("shift+f6");
    wait_tree(&mut v, "renamed", |t| {
        t.cursor().as_deref() == Some("renamed.tsx")
    });
    assert!(exists(&mut v, "renamed.tsx") && !exists(&mut v, "rn.tsx"));
    assert_eq!(
        v.lua("return _G.asked[#_G.asked].default").as_str(),
        Some("rn.tsx")
    );
    let msgs = v.lua("return vim.fn.execute('messages')");
    assert!(
        !msgs.as_str().unwrap_or("").contains("deprecated"),
        "{msgs}"
    );

    // F5 on one row: a copy under a new name
    sel(&mut v, "a.ts");
    answer(&mut v, &["a2.ts"]);
    v.key("f5");
    wait_tree(&mut v, "copy selected", |t| {
        t.cursor().as_deref() == Some("a2.ts")
    });

    // Cmd+X then Cmd+V on a folder moves the selection
    sel(&mut v, "multi");
    v.key("arrow_right");
    sel(&mut v, "multi/a.ts");
    v.key("shift+arrow_down");
    v.key("super+x");
    v.wait_lua(
        "cut",
        "return vim.fn.getreg('+'):match('multi/b%.ts') ~= nil",
    );
    sel(&mut v, "multi/sub");
    v.key("super+v");
    // (and the tree took it in: the target folder opened and selected after Lua's move, so a
    // selection made before that would be replaced)
    wait_tree(&mut v, "moved", |t| {
        let r = t.root();
        r.join("multi/sub/a.ts").exists()
            && r.join("multi/sub/b.ts").exists()
            && !r.join("multi/a.ts").exists()
            && t.row_index("multi/sub/a.ts").is_some()
    });

    // F5 on a multi-selection: copy them all to a folder (asked)
    sel(&mut v, "multi/c.ts");
    v.key("shift+arrow_down");
    answer(&mut v, &["multi/copy"]);
    v.key("f5");
    wait_tree(&mut v, "copied to the folder", |t| {
        let r = t.root();
        r.join("multi/copy/c.ts").exists()
            && r.join("multi/copy/d.ts").exists()
            && r.join("multi/c.ts").exists()
            && t.row_index("multi/copy/c.ts").is_some()
    });
    assert_eq!(
        v.lua("return _G.asked[#_G.asked].prompt").as_str(),
        Some("Copy 2 items to directory")
    );

    // Backspace on a multi-selection: asks for all, deletes them all
    sel(&mut v, "multi/c.ts");
    v.key("shift+arrow_down");
    answer(&mut v, &["Delete"]);
    v.key("backspace");
    wait_tree(&mut v, "both deleted", |t| {
        !t.root().join("multi/c.ts").exists() && !t.root().join("multi/d.ts").exists()
    });
    assert_eq!(
        v.lua("return _G.asked[#_G.asked].prompt").as_str(),
        Some("Delete 2 items?")
    );
    assert!(selected(&mut v).is_empty());
}

#[test]
fn vim_counts_first_last_and_doubled_keys() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    sel(&mut v, "");
    let rows = tv(&mut v, |t| t.row_paths());
    v.keystrokes("3 ö");
    assert_eq!(cur(&mut v), rows[3]);
    v.keystrokes("2 l");
    assert_eq!(cur(&mut v), rows[1]);
    v.keystrokes("shift-g");
    assert_eq!(&cur(&mut v), rows.last().unwrap());
    v.keystrokes("g g");
    assert_eq!(cur(&mut v), "");
    // dd: the delete confirmation (Cancel keeps the file)
    sel(&mut v, "c.ts");
    answer(&mut v, &["Cancel"]);
    v.keystrokes("d d");
    v.wait_lua(
        "asked",
        "return _G.asked[#_G.asked] ~= nil and _G.asked[#_G.asked].prompt == 'Delete file \"c.ts\"?'",
    );
    assert!(exists(&mut v, "c.ts"));
    // rr: the rename field
    sel(&mut v, "rn.tsx");
    answer(&mut v, &["renamed.tsx"]);
    v.keystrokes("r r");
    wait_tree(&mut v, "renamed", |t| {
        t.cursor().as_deref() == Some("renamed.tsx")
    });
    // yy: Cmd+C's path copy
    sel(&mut v, "a.ts");
    v.keystrokes("y y");
    v.wait_lua(
        "path copied",
        "return vim.fn.getreg('+'):match('/a%.ts') ~= nil",
    );
}

#[test]
fn multi_selection_keys_mouse_menu_reveal_and_open_all() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    sel(&mut v, "multi");
    v.key("arrow_right");
    sel(&mut v, "multi/a.ts");
    v.key("shift+arrow_down");
    v.key("shift+arrow_down");
    assert_eq!(selected(&mut v), ["multi/a.ts", "multi/b.ts", "multi/c.ts"]);
    assert_eq!(cur(&mut v), "multi/c.ts");
    v.key("shift+arrow_up");
    assert_eq!(selected(&mut v), ["multi/a.ts", "multi/b.ts"]);
    v.key("l");
    assert!(selected(&mut v).is_empty(), "a plain move clears it");
    sel(&mut v, "multi/a.ts");
    v.key("shift+arrow_down");
    v.key("escape");
    assert!(selected(&mut v).is_empty(), "Esc clears it");
    assert_eq!(target(&v), "tree", "focus stays");

    // Shift+click: a range; Alt+click / Cmd+click toggle rows
    sel(&mut v, "multi/a.ts");
    let shift = Modifiers {
        shift: true,
        ..Default::default()
    };
    let alt = Modifiers {
        alt: true,
        ..Default::default()
    };
    let cmd = Modifiers {
        platform: true,
        ..Default::default()
    };
    let p = row_point(&mut v, "multi/d.ts", 4.);
    press(&mut v, p, MouseButton::Left, shift, 1);
    assert_eq!(
        selected(&mut v),
        ["multi/a.ts", "multi/b.ts", "multi/c.ts", "multi/d.ts"]
    );
    let p = row_point(&mut v, "multi/b.ts", 4.);
    press(&mut v, p, MouseButton::Left, alt, 1);
    assert_eq!(selected(&mut v), ["multi/a.ts", "multi/c.ts", "multi/d.ts"]);
    let p = row_point(&mut v, "multi/e.ts", 4.);
    press(&mut v, p, MouseButton::Left, cmd, 1);
    assert_eq!(
        selected(&mut v),
        ["multi/a.ts", "multi/c.ts", "multi/d.ts", "multi/e.ts"]
    );

    // the menu: the multi-row actions
    v.key("super+enter");
    let labels = wait_menu(&mut v, "Delete 4 Items");
    assert!(
        labels.contains("Open 4 Files") && labels.contains("Move 4 Items…"),
        "{labels}"
    );
    // right-click on a selected row keeps the selection
    let p = row_point(&mut v, "multi/c.ts", 4.);
    press(&mut v, p, MouseButton::Right, Modifiers::default(), 1);
    assert_eq!(selected(&mut v).len(), 4);
    // Ctrl+Cmd+Shift+O: Reveal in Finder (the recorder)
    v.key("ctrl+super+shift+o");
    v.wait_lua(
        "revealed",
        "return _G.revealed ~= nil and #_G.revealed == 6",
    );
    // Cmd+C: every selected path
    v.key("super+c");
    v.wait_lua(
        "4 paths",
        "return select(2, vim.fn.getreg('+'):gsub('multi/', '')) == 4",
    );
    // Cmd+Shift+C: Copy Path
    v.lua("vim.fn.setreg('+', 'S') return true");
    v.key("super+shift+c");
    v.wait_lua(
        "copy path",
        "return select(2, vim.fn.getreg('+'):gsub('/multi/', '')) == 4",
    );
    // Enter opens every selected file
    v.key("enter");
    v.wait_lua(
        "4 opened",
        "local n = 0 for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].buflisted and vim.api.nvim_buf_get_name(b):find('multi/[acde]%.ts$') then n = n + 1 end end return n == 4",
    );
    wait_target(&mut v, "split");
    // Cmd+C on the root row: the project's path
    focus_tree(&mut v);
    v.key("home");
    v.key("super+c");
    let root = tv(&mut v, |t| t.root().to_string_lossy().into_owned());
    v.wait_lua(
        "root path",
        &format!("return vim.fn.getreg('+'):gsub('\\n$', '') == {root:?}"),
    );
}

/// Mouse drag from `from` to `to` (press, a step past the drag threshold, the target, release).
fn mouse_drag(v: &mut View, from: Point<Pixels>, to: Point<Pixels>) {
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(
        point(from.x + px(5.), from.y + px(5.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    v.pump();
}

#[test]
fn drag_off_the_selection_selects_rows_drag_on_it_moves_them() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    sel(&mut v, "multi");
    v.key("arrow_right");
    sel(&mut v, "multi/a.ts");
    // a drag starting on an unselected row selects the rows it goes over (nothing moves)
    let from = row_point(&mut v, "multi/b.ts", 4.);
    let to = row_point(&mut v, "multi/d.ts", 4.);
    mouse_drag(&mut v, from, to);
    assert_eq!(selected(&mut v), ["multi/b.ts", "multi/c.ts", "multi/d.ts"]);
    assert_eq!(cur(&mut v), "multi/d.ts");
    assert!(exists(&mut v, "multi/b.ts"), "a drag-select moves nothing");
    // Cmd+C copies the dragged rows' paths
    v.key("super+c");
    v.wait_lua(
        "3 paths",
        "return select(2, vim.fn.getreg('+'):gsub('multi/', '')) == 3",
    );
    // a plain click on the selection: just that row
    let p = row_point(&mut v, "multi/c.ts", 4.);
    click(&mut v, p);
    assert!(selected(&mut v).is_empty());
    assert_eq!(cur(&mut v), "multi/c.ts");

    // a drag starting on the selection moves it into the folder under the drop
    sel(&mut v, "multi/d.ts");
    v.key("shift+arrow_down");
    assert_eq!(selected(&mut v), ["multi/d.ts", "multi/e.ts"]);
    let from = row_point(&mut v, "multi/e.ts", 4.);
    let to = row_point(&mut v, "backend", 4.);
    // it asks first (WebStorm's Move dialog): Cancel moves nothing
    mouse_drag(&mut v, from, to);
    assert_eq!(
        menu_rows(&mut v),
        Some(vec!["Move".to_owned(), "Cancel".to_owned()]),
        "{:?}",
        menu_title(&mut v)
    );
    assert_eq!(
        menu_title(&mut v).as_deref(),
        Some("Move 2 items to backend?")
    );
    v.key("escape");
    v.pump();
    assert!(exists(&mut v, "multi/e.ts") && menu_rows(&mut v).is_none());
    // Move moves them
    let from = row_point(&mut v, "multi/e.ts", 4.);
    mouse_drag(&mut v, from, to);
    assert!(menu_rows(&mut v).is_some());
    v.key("enter");
    wait_tree(&mut v, "dropped into backend", |t| {
        let r = t.root();
        r.join("backend/d.ts").exists()
            && r.join("backend/e.ts").exists()
            && !r.join("multi/e.ts").exists()
    });
    wait_tree(&mut v, "target folder selected", |t| {
        t.cursor().as_deref() == Some("backend")
    });
    // one selected row drags too
    sel(&mut v, "multi/c.ts");
    let from = row_point(&mut v, "multi/c.ts", 4.);
    let to = row_point(&mut v, "src", 4.);
    mouse_drag(&mut v, from, to);
    assert_eq!(menu_title(&mut v).as_deref(), Some("Move \"c.ts\" to src?"));
    v.key("enter");
    wait_tree(&mut v, "dropped into src", |t| {
        t.root().join("src/c.ts").exists()
    });
}

// Fix round: search field clicks, Cmd+V, leader in the results, rename path, delete, Ctrl+click,
// `:e <dir>` ----------------------------------------------------------------------------------------

/// Window point inside the speed search field.
fn search_field(v: &mut View) -> Point<Pixels> {
    let island = v.read(|e| e.geometry().layout.tree.unwrap());
    point(
        island.origin.x + px(80.),
        island.origin.y + px(1. + 31. + 2.5 + 11.),
    )
}

#[test]
fn search_field_takes_clicks_and_cmd_v_pastes_text() {
    let mut v = start(&common::fixtures().join("stree"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    go(&mut v, "kappa");
    let p = row_point(&mut v, "kappa", 4.);
    click(&mut v, p);
    assert!(!tv(&mut v, |t| t.search_input()), "a result has the keys");
    // a click in the field: the field gets the keys; nothing else selected, no drag-select
    let f = search_field(&mut v);
    v.cx.simulate_mouse_down(f, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(
        point(f.x, f.y + px(60.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.cx.simulate_mouse_up(
        point(f.x, f.y + px(60.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.pump();
    assert!(tv(&mut v, |t| t.search_input()));
    assert_eq!(cur(&mut v), "kappa");
    assert!(selected(&mut v).is_empty());
    // Cmd+V in the field: the clipboard's text goes into the search (not files into a folder)
    v.key("super+backspace");
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("item2\nignored".into()));
    v.key("super+v");
    wait_tree(&mut v, "pasted", |t| t.results_query() == Some("item2"));
    assert!(!listed(&mut v, "kappa/item1.ts"));
}

#[test]
fn leader_keys_in_the_results_and_the_leader_timeout() {
    let mut v = start(&common::fixtures().join("stree"), &["alpha/item1.ts"]);
    focus_tree(&mut v);
    search_start(&mut v, "item3");
    let p = row_point(&mut v, "beta/item3.ts", 4.);
    click(&mut v, p);
    // `,` from the results list is the leader (not typed): ,g selects the opened file
    v.key(",");
    v.key("g");
    wait_tree(&mut v, ",g: opened file selected", |t| {
        t.query().is_none() && t.cursor().as_deref() == Some("alpha/item1.ts")
    });
    // in the field `,` types
    search_start(&mut v, "a,");
    v.key("escape");
    // the leader waits nvim's timeoutlen (the tree's own clock), then `n` is just a key
    stubs(&mut v);
    v.key(",");
    wait_tree(&mut v, "`,` waits for a leader key", |t| t.leader_pending());
    wait_tree(&mut v, "the leader timed out", |t| !t.leader_pending());
    v.key("n");
    v.settle();
    assert_eq!(
        v.lua("return #_G.asked").as_i64(),
        Some(0),
        "no New File field"
    );
    v.key(",");
    v.key("n");
    v.wait_lua("New File field", "return #_G.asked == 1");
}

#[test]
fn rename_path_delete_selects_next_ctrl_click_and_open_dir() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    // the rename field starts with the path relative to the project; editing it moves the file
    sel(&mut v, "src/util.ts");
    answer(&mut v, &["lib/util2.ts"]);
    v.key("shift+f6");
    wait_tree(&mut v, "moved by the rename", |t| {
        t.cursor().as_deref() == Some("lib/util2.ts")
    });
    assert_eq!(
        v.lua("return _G.asked[#_G.asked].default").as_str(),
        Some("src/util.ts")
    );
    assert!(!exists(&mut v, "src/util.ts"));
    // delete: the next row gets selected (the Lua tree kept the list's cursor index)
    sel(&mut v, "c.ts");
    answer(&mut v, &["Delete"]);
    v.key("backspace");
    wait_tree(&mut v, "next row selected", |t| {
        t.row_index("c.ts").is_none() && t.cursor().as_deref() == Some("ignored.log")
    });
    // Ctrl+click on a chevron toggles the row in the selection (doesn't open the folder)
    sel(&mut v, "a.ts");
    let c = chevron(&mut v, "backend");
    let ctrl = Modifiers {
        control: true,
        ..Default::default()
    };
    press(&mut v, c, MouseButton::Left, ctrl, 1);
    assert_eq!(selected(&mut v), ["a.ts", "backend"]);
    assert!(!listed(&mut v, "backend/scripts"));
    // `:e <dir>`: the folder in the tree, expanded and selected; no directory buffer
    v.key("escape");
    v.key("escape");
    wait_target(&mut v, "split");
    v.lua("vim.cmd.edit('backend') return true");
    wait_tree(&mut v, "folder revealed", |t| {
        t.cursor().as_deref() == Some("backend") && t.row_index("backend/scripts").is_some()
    });
    wait_target(&mut v, "tree");
    v.wait_lua(
        "no directory buffer",
        "for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].buflisted and vim.api.nvim_buf_get_name(b) ~= '' and vim.fn.isdirectory(vim.api.nvim_buf_get_name(b)) == 1 then return false end end return true",
    );
}

// Session ---------------------------------------------------------------------------------------

#[test]
fn open_state_width_and_folders_go_to_the_session() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    focus_tree(&mut v);
    sel(&mut v, "src");
    v.key("arrow_right");
    v.wait_lua(
        "Lua has the expanded folder",
        "local s = require('config.app.tree').get_state() return s ~= nil and s.open and vim.tbl_contains(s.dirs, 'src')",
    );
    // the session file gets them (VimLeavePre's save)
    v.lua("vim.api.nvim_exec_autocmds('VimLeavePre', {}) return true");
    let saved = v.lua(
        "local f = vim.fn.stdpath('state') .. '/open-files/' .. vim.fn.getcwd():gsub('[/\\\\:]', '%%') .. '.json' \
         local l = vim.json.decode(table.concat(vim.fn.readfile(f), '')).layout \
         return { l.tree, l.tree_width, table.concat(l.tree_dirs, ',') }",
    );
    let saved = saved.as_array().unwrap();
    assert_eq!(saved[0].as_bool(), Some(true));
    assert!(saved[1].as_i64().unwrap_or(0) > 100, "{saved:?}");
    assert_eq!(saved[2].as_str(), Some("src"));
    // restore: width, folders, closed
    v.lua(
        "require('config.app.bridge').notify('tree', { event = 'restore', open = true, width = 333, dirs = { 'backend', 'multi' }, focus = true }) return true",
    );
    wait_tree(&mut v, "restored folders", |t| {
        t.row_index("backend/scripts").is_some() && t.row_index("multi/a.ts").is_some()
    });
    v.wait_for("width restored", |e| e.panels().tree_width == 333.);
    wait_target(&mut v, "tree");
    v.lua("require('config.app.bridge').notify('tree', { event = 'restore', open = false, dirs = {} }) return true");
    v.wait_for("closed", |e| e.geometry().layout.tree.is_none());
    v.wait_lua(
        "Lua knows it's closed",
        "return require('config.app.tree').get_state().open == false",
    );
    let _ = Value::Nil;
}

// Speed search on the stree and sbig fixtures --------------------------------------------------------

fn search_start(v: &mut View, text: &str) {
    v.key("shift+digit_7");
    for c in text.chars() {
        let k = c.to_string();
        v.key(&k);
    }
    let t = text.to_owned();
    wait_tree(v, &format!("results for {text}"), move |tr| {
        tr.results_query() == Some(t.as_str())
    });
}

/// Moves with ↓ / ↑ to the row `rel`.
fn go(v: &mut View, rel: &str) {
    let (want, at) = tv(v, |t| {
        (t.row_index(rel), t.cursor().and_then(|c| t.row_index(&c)))
    });
    let (want, at) = (
        want.unwrap_or_else(|| panic!("{rel} not listed")),
        at.unwrap(),
    );
    for _ in 0..want.abs_diff(at) {
        v.key(if want > at { "arrow_down" } else { "arrow_up" });
    }
    assert_eq!(cur(v), rel);
}

/// The selected row's place on screen (y px from the list's top).
fn screen_y(v: &mut View) -> f32 {
    tv(v, |t| {
        let ix = t.row_index(&t.cursor().unwrap()).unwrap();
        ix as f32 * theme_row() - t.scroll_top().1
    })
}

#[test]
fn speed_search_starts_closes_filters_and_folds() {
    let mut v = start(&common::fixtures().join("stree"), &[]);
    focus_tree(&mut v);
    // a letter doesn't start it; `/` does (the field gets the keys typed right after it)
    v.key("z");
    assert_eq!(tv(&mut v, |t| t.query().map(str::to_owned)), None);
    search_start(&mut v, "zz");
    assert_eq!(tv(&mut v, |t| t.match_count()), Some(0));
    // Cmd+2 closes it (focus in the editor, full tree)
    v.focus_code();
    wait_target(&mut v, "split");
    wait_tree(&mut v, "search closed", |t| {
        t.query().is_none() && t.row_index("dist").is_some()
    });
    // fast keys after `/` all go to the search (also ones that would be tree keys)
    focus_tree(&mut v);
    v.key("shift+digit_7");
    for k in ["g", "g", "l", "ö", "k", ",", "space"] {
        v.key(k);
    }
    assert_eq!(
        tv(&mut v, |t| t.query().map(str::to_owned)),
        Some("ggl\u{f6}k, ".into())
    );
    v.key("escape");
    wait_tree(&mut v, "Esc closes", |t| t.query().is_none());
    assert_eq!(target(&v), "tree", "Esc closes the search, focus stays");

    // results: under their folders; ignored (dist) and excluded (node_modules) not searched
    search_start(&mut v, "item");
    assert!(listed(&mut v, "theta/sub/item2.ts") && listed(&mut v, "theta/sub"));
    assert!(!listed(&mut v, "dist") && !listed(&mut v, "node_modules"));
    assert_eq!(
        cur(&mut v),
        "alpha/sub/item1.ts",
        "the first match selected"
    );

    // ← folds an open folder (selected row stays on its screen row), again: the parent
    go(&mut v, "theta/sub");
    let y = screen_y(&mut v);
    v.key("arrow_left");
    assert!(!listed(&mut v, "theta/sub/item1.ts") && cur(&mut v) == "theta/sub");
    assert_eq!(screen_y(&mut v), y, "the view stays put");
    assert_eq!(
        tv(&mut v, |t| t.query().map(str::to_owned)),
        Some("item".into())
    );
    v.key("arrow_left");
    assert_eq!(cur(&mut v), "theta");
    v.key("arrow_down");
    v.key("arrow_right");
    assert!(listed(&mut v, "theta/sub/item1.ts"), "→ unfolds");
    v.key("arrow_right");
    assert_eq!(cur(&mut v), "theta/sub/item1.ts", "→ again: first child");
    // Enter on a folder folds it; the fold survives more typing
    go(&mut v, "theta");
    v.key("enter");
    assert!(!listed(&mut v, "theta/item1.ts"));
    v.key("digit_1");
    wait_tree(&mut v, "item1", |t| t.results_query() == Some("item1"));
    assert!(
        listed(&mut v, "theta")
            && !listed(&mut v, "theta/item1.ts")
            && listed(&mut v, "kappa/item1.ts")
    );
    v.key("backspace");
    wait_tree(&mut v, "item again", |t| t.results_query() == Some("item"));

    // a click on a result: the list has the keys (his moves move / fold, other letters type)
    go(&mut v, "kappa");
    let p = row_point(&mut v, "kappa", 4.);
    click(&mut v, p);
    assert!(!tv(&mut v, |t| t.search_input()));
    v.key("ö");
    assert_eq!(cur(&mut v), "kappa/sub");
    assert_eq!(
        tv(&mut v, |t| t.query().map(str::to_owned)),
        Some("item".into())
    );
    v.key("l");
    v.key("k");
    assert!(!listed(&mut v, "kappa/item1.ts"), "k folds");
    v.key("k");
    assert_eq!(cur(&mut v), "", "k again: the parent (the root)");
    v.key("ä");
    assert_eq!(cur(&mut v), "alpha");
    v.key("digit_2");
    wait_tree(&mut v, "typed", |t| {
        t.results_query() == Some("item2") && t.search_input()
    });
    v.key("backspace");
    wait_tree(&mut v, "item again", |t| t.results_query() == Some("item"));
    // a chevron click and a double-click fold a result folder
    go(&mut v, "kappa");
    v.key("arrow_right");
    let c = chevron(&mut v, "kappa");
    click(&mut v, c);
    assert!(!listed(&mut v, "kappa/item1.ts"));
    let p = row_point(&mut v, "kappa", 4.);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 1);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 2);
    assert!(listed(&mut v, "kappa/item1.ts"), "double-click unfolds");

    // multi-selection in the results; Esc clears it first, the search stays
    v.key("shift+digit_7");
    go(&mut v, "eta/sub/item1.ts");
    v.key("shift+arrow_down");
    v.key("shift+arrow_down");
    assert_eq!(selected(&mut v).len(), 3);
    v.key("escape");
    assert!(selected(&mut v).is_empty() && tv(&mut v, |t| t.query().is_some()));

    // Esc closes it: the full tree (ignored folders too), the result selected on its screen row
    go(&mut v, "eta/sub/item3.ts");
    let y = screen_y(&mut v);
    v.key("escape");
    wait_tree(&mut v, "closed", |t| t.query().is_none());
    assert!(listed(&mut v, "dist") && listed(&mut v, "node_modules"));
    assert_eq!(cur(&mut v), "eta/sub/item3.ts");
    // as far as scrolling allows (rows above it in the full tree)
    let ix = tv(&mut v, |t| t.row_index("eta/sub/item3.ts").unwrap()) as f32;
    assert_eq!(screen_y(&mut v), y.min(ix * theme_row()), "same screen row");
    assert_eq!(target(&v), "tree");

    // clearing the text: the full tree, the result still selected
    search_start(&mut v, "item");
    go(&mut v, "iota/sub/item1.ts");
    v.key("super+backspace");
    wait_tree(&mut v, "cleared", |t| t.query() == Some(""));
    assert!(listed(&mut v, "iota/other.ts"));
    assert_eq!(cur(&mut v), "iota/sub/item1.ts");
    v.key("escape");

    // Enter on a result file: opens it, closes the search, the file selected in the tree
    search_start(&mut v, "item2");
    go(&mut v, "beta/item2.ts");
    v.key("enter");
    v.wait_lua(
        "opened",
        "return vim.api.nvim_buf_get_name(0):match('beta/item2%.ts$') ~= nil",
    );
    wait_tree(&mut v, "closed, selected", |t| {
        t.query().is_none() && t.cursor().as_deref() == Some("beta/item2.ts")
    });

    // a click into the editor closes it
    focus_tree(&mut v);
    search_start(&mut v, "b");
    v.focus_code();
    wait_target(&mut v, "split");
    wait_tree(&mut v, "focus left: closed", |t| t.query().is_none());
}

#[test]
fn speed_search_refresh_keeps_the_view() {
    let stree = common::fixtures().join("stree");
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("stree");
    assert!(
        Command::new("cp")
            .arg("-R")
            .arg(&stree)
            .arg(&dir)
            .status()
            .unwrap()
            .success()
    );
    let mut v = start(&dir, &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    go(&mut v, "kappa/sub/item2.ts");
    go(&mut v, "theta");
    v.key("arrow_left"); // fold theta
    go(&mut v, "kappa/sub/item2.ts");
    let y = screen_y(&mut v);
    std::fs::write(dir.join("item_new.ts"), "x").unwrap();
    // the poll notices (500 ms), the index is walked again
    for _ in 0..40 {
        v.advance(Duration::from_millis(600));
        if listed(&mut v, "item_new.ts") {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(listed(&mut v, "item_new.ts"), "the new match is listed");
    assert_eq!(cur(&mut v), "kappa/sub/item2.ts");
    assert_eq!(screen_y(&mut v), y, "selected row stays put");
    assert!(!listed(&mut v, "theta/item1.ts"), "folds kept");
}

#[test]
fn many_results_in_tree_order_and_the_first_match() {
    let mut v = start(&common::fixtures().join("sbig"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    let rows = tv(&mut v, |t| t.row_paths());
    assert!(rows.len() > 1700, "{}", rows.len());
    // every row under the one before it or a sibling of a folder above it: tree order
    for w in rows.windows(2).skip(1) {
        let parent = Path::new(&w[1])
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            rows.contains(&parent) || parent.is_empty(),
            "not under its folder: {}",
            w[1]
        );
    }
    let mut sorted = rows.clone();
    sorted.sort_by(|a, b| tree_cmp(a, b));
    assert_eq!(rows, sorted);
    v.key("digit_1");
    wait_tree(&mut v, "item1", |t| t.results_query() == Some("item1"));
    assert_eq!(cur(&mut v), "d01/s01/deep/item10.ts");
    let n = tv(&mut v, |t| t.match_count()).unwrap();
    assert!(n > 100, "{n}");
}

/// Folders first per level (dirs = names without a dot here), then names.
fn tree_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split('/').collect(), b.split('/').collect());
    if a.is_empty() || b.is_empty() {
        return a.len().cmp(&b.len());
    }
    for i in 0..pa.len().min(pb.len()) {
        if pa[i] != pb[i] {
            let da = i + 1 < pa.len() || !pa[i].contains('.');
            let db = i + 1 < pb.len() || !pb[i].contains('.');
            return db.cmp(&da).then(pa[i].cmp(pb[i]));
        }
    }
    pa.len().cmp(&pb.len())
}

// 10k files -------------------------------------------------------------------------------------

#[test]
fn ten_thousand_files_expand_and_scroll() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("big");
    for d in 0..100 {
        let sub = dir.join(format!("dir{d:03}"));
        std::fs::create_dir_all(&sub).unwrap();
        for f in 0..100 {
            std::fs::write(sub.join(format!("file{f:03}.ts")), "").unwrap();
        }
    }
    let mut v = start(&dir, &[]);
    focus_tree(&mut v);
    let t0 = Instant::now();
    v.key("super+shift+-"); // collapse all (nothing open): warm
    v.lua("require('config.app.bridge').notify('tree', { event = 'action', name = 'expand_all' }) return true");
    wait_tree(&mut v, "10k rows", |t| t.row_paths().len() == 10_101);
    let expand = t0.elapsed();
    // scrolling: PageDown through all of it, one frame each
    let t1 = Instant::now();
    let mut frames = 0;
    while cur(&mut v) != "dir099/file099.ts" {
        v.key("page_down");
        frames += 1;
        assert!(frames < 2000);
    }
    let scroll = t1.elapsed();
    let per = scroll / frames;
    // a wheel scroll
    let at = row_point(&mut v, "dir099/file099.ts", 4.);
    let t2 = Instant::now();
    for _ in 0..50 {
        v.scroll(
            at,
            gpui_kit::ScrollDelta::Pixels(point(px(0.), px(200.))),
            gpui_kit::TouchPhase::Moved,
        );
        v.pump();
    }
    let wheel = t2.elapsed() / 50;
    // background search over 10k names: how long until the results are in
    let t3 = Instant::now();
    search_start(&mut v, "file05");
    let search = t3.elapsed();
    v.key("escape");
    v.key("escape");
    focus_tree(&mut v);
    // drag-select past the bottom edge: scrolls (and selects) a row at a time while held there
    v.key("home");
    let island = v.read(|e| e.geometry().layout.tree.unwrap());
    let from = row_point(&mut v, "dir000", 4.);
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(
        point(from.x, island.bottom() + px(20.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    for _ in 0..60 {
        v.advance(Duration::from_millis(40));
    }
    let below = point(from.x, island.bottom() + px(20.));
    v.cx.simulate_mouse_up(below, MouseButton::Left, Modifiers::default());
    v.pump();
    let (n, top) = (selected(&mut v).len(), tv(&mut v, |t| t.scroll_top().1));
    assert!(
        n > 40 && top > 0.,
        "auto-scrolled: {n} rows selected, top {top}"
    );
    v.key("escape");
    // the scrollbar: shown while the mouse is over the tree; dragging its thumb scrolls
    v.key("home");
    let thumb = tv(&mut v, |t| t.thumb_center()).expect("a thumb for 10k rows");
    v.cx.simulate_mouse_move(thumb, None, Modifiers::default());
    v.cx.simulate_mouse_down(thumb, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(
        point(thumb.x, thumb.y + px(200.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.cx.simulate_mouse_up(
        point(thumb.x, thumb.y + px(200.)),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.pump();
    let top = tv(&mut v, |t| t.scroll_top().1);
    assert!(top > 2000., "dragging the thumb scrolls: {top}");
    assert_eq!(cur(&mut v), "", "the selection stays");
    println!(
        "10k tree ({}): expand all {expand:?}; PageDown {frames} pages, {per:?} per key+frame; wheel {wheel:?} per step; search {search:?}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    assert!(per < Duration::from_millis(250), "{per:?}");
}

// Header, Finder drops, background polling ------------------------------------------------------

/// Files dragged in from Finder and dropped at `at`.
fn drop_files(v: &mut View, at: Point<Pixels>, paths: &[PathBuf]) {
    v.cx.simulate_event(FileDropEvent::Entered {
        position: at,
        paths: ExternalPaths(paths.iter().cloned().collect()),
    });
    v.cx.simulate_event(FileDropEvent::Pending { position: at });
    v.cx.simulate_event(FileDropEvent::Submit { position: at });
    v.pump();
}

/// Moves the menu's selection to `label` and runs it.
fn choose(v: &mut View, label: &str) {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    for _ in 0..12 {
        if p.read_with(&v.cx, |p, _| p.menu_selected()).as_deref() == Some(label) {
            v.key("enter");
            v.pump();
            return;
        }
        v.key("arrow_down");
        v.pump();
    }
    panic!("no {label} in {:?}", menu_rows(v));
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "GPUI debug selectors (debug_bounds) exist in debug builds only"
)]
fn header_project_menu_actions_and_hide() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    let island = v.read(|e| e.geometry().layout.tree.unwrap());
    // WebStorm's tool window header: 31 high at the island's top, "Project" at x 12, no line under it
    v.wait_until("header drawn", |v| {
        v.cx.debug_bounds("tree-header").is_some()
    });
    let header = v.cx.debug_bounds("tree-header").unwrap();
    assert_eq!(header.size.height, px(31.));
    assert_eq!(header.origin.y, island.origin.y + px(1.));
    let title = v.cx.debug_bounds("tree-header-title").unwrap();
    assert_eq!(title.origin.x, island.origin.x + px(1. + 12.));
    // the first row's slot is drawn where the clicks map it
    let row0 = v.cx.debug_bounds("tree-row-0").unwrap();
    assert_eq!(row0.origin.y, island.origin.y + px(1. + 31. + 2.5));
    let a = row_point(&mut v, "a.ts", 4.);
    click(&mut v, a);
    assert_eq!(cur(&mut v), "a.ts");

    // "Project ⌄": the view menu (Project checked + the tree's view actions)
    sel(&mut v, "src");
    v.key("arrow_right");
    wait_tree(&mut v, "src open", |t| t.row_index("src/main.ts").is_some());
    click(&mut v, title.center());
    let rows = menu_rows(&mut v).expect("the header's menu");
    for want in [
        "Project",
        "Select Opened File",
        "Collapse All",
        "Expand All",
        "Hide",
    ] {
        assert!(rows.iter().any(|r| r == want), "{want} in {rows:?}");
    }
    choose(&mut v, "Collapse All");
    wait_tree(&mut v, "Collapse All from the header", |t| {
        t.row_index("src/main.ts").is_none()
    });

    // ⋮ and − show while the mouse is over the tool window; − hides it
    v.cx.simulate_mouse_move(point(px(900.), px(400.)), None, Modifiers::default());
    v.pump();
    v.cx.simulate_mouse_move(a, None, Modifiers::default());
    wait_tree(&mut v, "the tool window hovered", |t| t.is_hovered());
    v.wait_until("header actions on hover", |v| {
        v.cx.debug_bounds("button-tree-header-hide").is_some()
    });
    let more = v.cx.debug_bounds("button-tree-header-more").unwrap();
    let hide = v.cx.debug_bounds("button-tree-header-hide").unwrap();
    assert!(more.right() <= hide.left() && hide.right() <= island.right() - px(1. + 6. - 0.5));
    click(&mut v, more.center());
    assert!(menu_rows(&mut v).is_some_and(|r| r.iter().any(|r| r == "Expand All")));
    v.key("escape");
    v.pump();
    // (a key hides hover until the mouse moves)
    v.cx.simulate_mouse_move(hide.center(), None, Modifiers::default());
    v.wait_until("− back on mouse move", |v| {
        v.cx.debug_bounds("button-tree-header-hide").is_some()
    });
    click(&mut v, hide.center());
    v.wait_until("− hides the tree", |v| {
        !v.read_ws(|ws, cx| ws.tree_open(cx))
    });
}

#[test]
fn finder_drops_copy_into_the_folder() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("dropped.txt");
    std::fs::write(&file, "x").unwrap();
    // on a folder row: WebStorm's Copy dialog with that folder, then the copy
    answer(&mut v, &["backend"]);
    let at = row_point(&mut v, "backend", 4.);
    drop_files(&mut v, at, std::slice::from_ref(&file));
    v.wait_lua(
        "copy asked with the folder",
        "local a = _G.asked[#_G.asked] return a and a.prompt == 'Copy \"dropped.txt\" to directory' and a.default == 'backend'",
    );
    wait_tree(&mut v, "copied into backend", |t| {
        t.root().join("backend/dropped.txt").exists()
    });
    assert!(file.exists(), "a copy: the original stays");
}

#[test]
fn no_folder_polling_while_the_app_is_in_the_background() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    v.cx.update(|window, _| window.activate_window());
    wait_tree(&mut v, "polling while active", |t| t.is_polling());
    write(&dir, "while_active.ts", "x");
    v.advance(Duration::from_millis(600));
    wait_tree(&mut v, "a new file shows while active", |t| {
        t.row_index("while_active.ts").is_some()
    });
    v.cx.deactivate_window();
    wait_tree(&mut v, "poll stopped in the background", |t| {
        !t.is_polling()
    });
    write(&dir, "while_away.ts", "x");
    // 1.5 s of the app's clock, every timer due in it fired and its work done
    for _ in 0..15 {
        v.advance(Duration::from_millis(100));
    }
    assert!(!listed(&mut v, "while_away.ts"), "no disk work while away");
    // back: caught up at once
    v.cx.update(|window, _| window.activate_window());
    wait_tree(&mut v, "shown on activation", |t| {
        t.row_index("while_away.ts").is_some()
    });
}

// The Feel's switches -----------------------------------------------------------------------

/// `tree.decorations = letters`: a file's problem count at the right as VS Code shows it
/// (`2, M` beside its git letter, red with an error, yellow with warnings only, `9+` past nine), a
/// folder holding problems a `•`; colours only (VimStorm) show none.
#[test]
fn feel_letters_show_each_files_problem_count() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    wait_tree(&mut v, "git status read", |t| {
        t.git().status(Path::new("b.ts"), false).is_some()
    });
    v.lua(
        "local ns = vim.api.nvim_create_namespace('feel_counts') \
         local E, W = vim.diagnostic.severity.ERROR, vim.diagnostic.severity.WARN \
         local function d(n, sev) local out = {} for i = 1, n do out[i] = { lnum = 0, col = i, message = 'x', severity = sev } end return out end \
         vim.diagnostic.set(ns, vim.fn.bufadd('b.ts'), vim.list_extend(d(1, E), d(1, W))) \
         vim.diagnostic.set(ns, vim.fn.bufadd('c.ts'), d(2, W)) \
         vim.diagnostic.set(ns, vim.fn.bufadd('src/main.ts'), d(12, W)) \
         return true",
    );
    let deco =
        |v: &mut View, rel: &str| tv(v, |t| t.row_index(rel).and_then(|i| t.row_decoration(i)));
    wait_tree(&mut v, "the counts in", |t| {
        t.has_problem(&dir.join("b.ts"))
    });
    assert_eq!(deco(&mut v, "c.ts"), None, "VimStorm: colours only");
    v.set_feel(|f| f.tree.decorations = vimstorm::factory::Decorations::Letters);
    v.wait_until("b.ts: 2, M", |v| deco(v, "b.ts").as_deref() == Some("2, M"));
    assert_eq!(deco(&mut v, "c.ts").as_deref(), Some("2"));
    assert_eq!(deco(&mut v, "a.ts"), None);
    assert_eq!(deco(&mut v, "src").as_deref(), Some("•"));
    assert_eq!(deco(&mut v, "backend"), None);
    let open = chevron(&mut v, "src");
    click(&mut v, open);
    wait_tree(&mut v, "src open", |t| t.row_index("src/main.ts").is_some());
    assert_eq!(deco(&mut v, "src/main.ts").as_deref(), Some("9+, M"));
    v.wait_until("drawn at the row's right", |v| {
        v.cx.debug_bounds("tree-decoration").is_some()
    });
}

#[test]
fn feel_compact_folders_and_git_letters() {
    let (_tmp, dir) = make_project();
    write(&dir, "deep/one/two/x.ts", "x");
    let mut v = start(&dir, &["a.ts"]);
    wait_tree(&mut v, "git status read", |t| {
        t.git().status(Path::new("b.ts"), false).is_some()
    });
    // VimStorm: a folder a row, git colours only
    assert!(listed(&mut v, "deep"));
    let letter = |v: &mut View, rel: &str| tv(v, |t| t.row_decoration(t.row_index(rel).unwrap()));
    assert_eq!(letter(&mut v, "b.ts"), None);
    v.set_feel(|f| {
        f.tree.compact_folders = true;
        f.tree.decorations = vimstorm::factory::Decorations::Letters;
    });
    wait_tree(&mut v, "deep/one/two on one row", |t| {
        t.row_index("deep/one/two").is_some() && t.row_index("deep").is_none()
    });
    let name = tv(&mut v, |t| {
        t.rows()[t.row_index("deep/one/two").unwrap()].name.clone()
    });
    assert_eq!(name, "deep/one/two");
    // a folder with files beside its folder stays one row (backend: scripts/ + server.ts)
    assert!(listed(&mut v, "backend"));
    // expanding works on the last folder
    let c = chevron(&mut v, "deep/one/two");
    click(&mut v, c);
    wait_tree(&mut v, "x.ts under the chain", |t| {
        t.row_index("deep/one/two/x.ts").is_some()
    });
    // ← from the chain's row goes to the row above the chain (the root)
    focus_tree(&mut v);
    sel(&mut v, "deep/one/two");
    v.key("arrow_left");
    wait_tree(&mut v, "chain closed", |t| {
        t.row_index("deep/one/two/x.ts").is_none()
    });
    v.key("arrow_left");
    assert_eq!(cur(&mut v), "");
    // VS Code's letters: modified, untracked; a clean file none
    assert_eq!(letter(&mut v, "b.ts").as_deref(), Some("M"));
    assert_eq!(letter(&mut v, "new.ts").as_deref(), Some("U"));
    assert_eq!(letter(&mut v, "a.ts"), None);
    // back to VimStorm: the folders one a row again
    v.set_feel(|_| {});
    wait_tree(&mut v, "deep again", |t| t.row_index("deep").is_some());
    assert_eq!(letter(&mut v, "b.ts"), None);
}

#[test]
fn feel_single_click_opens_and_auto_reveal_follows_the_editor() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    v.set_feel(|f| {
        f.tree.single_click = true;
        f.tree.auto_reveal = true;
    });
    // a single click on a file opens it; the tree keeps the keyboard
    let p = row_point(&mut v, "c.ts", 4.);
    click(&mut v, p);
    v.wait_lua(
        "c.ts opened by one click",
        "return vim.api.nvim_buf_get_name(0):sub(-4) == 'c.ts'",
    );
    wait_target(&mut v, "tree");
    // a click on a folder still only selects it
    let p = row_point(&mut v, "src", 4.);
    click(&mut v, p);
    assert_eq!(cur(&mut v), "src");
    assert!(!listed(&mut v, "src/main.ts"));
    // a drag of the selected file moves it (asked first), it does not open it
    sel(&mut v, "rn.tsx");
    let opened = buf_name(&v);
    let from = row_point(&mut v, "rn.tsx", 4.);
    let to = row_point(&mut v, "backend", 4.);
    mouse_drag(&mut v, from, to);
    assert_eq!(
        menu_rows(&mut v),
        Some(vec!["Move".to_owned(), "Cancel".to_owned()])
    );
    v.key("escape");
    v.settle();
    assert_eq!(buf_name(&v), opened, "a drag and drop is no click");
    // ...nor does a later mouse up open it (the drop stopped the mouse up that took the press's open)
    let p = row_point(&mut v, "rn.tsx", 4.);
    v.cx.simulate_mouse_up(p, MouseButton::Left, Modifiers::default());
    v.settle();
    assert_eq!(buf_name(&v), opened, "a stale click after the drop");
    // a drag-select from a file does not open it either
    let from = row_point(&mut v, "rn.tsx", 4.);
    let to = row_point(&mut v, "package.json", 4.);
    mouse_drag(&mut v, from, to);
    v.settle();
    assert!(
        !buf_name(&v).ends_with("rn.tsx"),
        "a drag-select is no click"
    );
    // the editor's file shown in the tree (folders opened), the keyboard left where it is
    v.lua("vim.cmd.edit('src/util.ts') return true");
    v.lua(&format!(
        "require('config.app.bridge').notify('tree', {{ event = 'follow', file = {:?} }}) return true",
        dir.join("src/util.ts").to_string_lossy()
    ));
    wait_tree(&mut v, "src/util.ts followed", |t| {
        t.cursor().as_deref() == Some("src/util.ts")
    });
    // never into an excluded folder (a go-to-definition into node_modules)
    v.lua(&format!(
        "require('config.app.bridge').notify('tree', {{ event = 'follow', file = {:?} }}) return true",
        dir.join("node_modules/lib/index.js").to_string_lossy()
    ));
    v.settle();
    assert_eq!(cur(&mut v), "src/util.ts");
    assert!(!listed(&mut v, "node_modules/lib"));
    // VimStorm: no follow, one click only selects
    v.set_feel(|_| {});
    v.lua(&format!(
        "require('config.app.bridge').notify('tree', {{ event = 'follow', file = {:?} }}) return true",
        dir.join("a.ts").to_string_lossy()
    ));
    v.settle();
    assert_eq!(cur(&mut v), "src/util.ts");
    let before = buf_name(&v);
    let p = row_point(&mut v, "b.ts", 4.);
    click(&mut v, p);
    v.settle();
    assert_eq!(buf_name(&v), before);
}

/// Stock Vim keys (the Feel vim, or Vim mode on under webstorm or vscode): nvim has no `,`
/// leader maps, so the tree hands it no `,` key (VimStorm's ,v would split; its own ,g / ,n stay).
#[test]
fn stock_vim_keys_hand_nvim_no_leader_key() {
    let (_tmp, dir) = make_project();
    let mut v = start(&dir, &["a.ts"]);
    let wins = |v: &mut View| v.lua("return #vim.api.nvim_tabpage_list_wins(0)").as_i64();
    let before = wins(&mut v);
    v.set_feel(|f| f.feel = vimstorm::factory::FeelName::Vim);
    focus_tree(&mut v);
    v.key(",");
    v.key("v");
    v.settle();
    assert_eq!(wins(&mut v), before, "no ,v reached nvim");
    v.set_feel(|_| {});
    focus_tree(&mut v);
    v.key(",");
    v.key("v");
    v.wait_until("Feel vimstorm: ,v splits", |v| wins(v) > before);
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "GPUI debug selectors (debug_bounds) exist in debug builds only"
)]
fn row_labels_library_root_and_root_row() {
    let nb = "\u{a0}";
    let (_tmp, dir) = make_project();
    let mut v = start_native(&dir, &["a.ts"]);
    // node_modules: "node_modules library root", the excluded (tinted) row
    let (label, excluded) = tv(&mut v, |t| {
        let ix = t.row_index("node_modules").unwrap();
        (t.row_label(ix).unwrap(), t.rows()[ix].excluded)
    });
    assert_eq!(
        label,
        [
            ("node_modules".to_owned(), false),
            (format!("{nb}library root"), false)
        ]
    );
    assert!(excluded);
    // other folders: just the name
    let src = tv(&mut v, |t| {
        t.row_label(t.row_index("src").unwrap()).unwrap()
    });
    assert_eq!(src, [("src".to_owned(), false)]);
    // root row with a module: plain name, bold [module], the dim home-relative path
    let path = home_relative(&dir);
    let root = tv(&mut v, |t| t.row_label(0).unwrap());
    assert_eq!(
        root,
        [
            ("tproj".to_owned(), false),
            (format!("{nb}[tproj-web]"), true),
            (format!("{nb}{path}"), false)
        ]
    );
    // the path is cut to fit the tree (the temp dir's path is longer than the tree is wide):
    // the shown part ends inside the island, more than a few chars of it shown (text_ellipsis)
    let isl = island(&mut v);
    let full = text_width(&mut v, &format!("{nb}{path}"));
    let few = text_width(&mut v, &format!("{nb}/var…"));
    let b = bounds(&mut v, "tree-root-path").expect("the root row's path is drawn");
    assert!(
        b.right() <= isl.right() && b.size.width.as_f32() > few,
        "path shown inside the island: {b:?} vs {isl:?}"
    );
    assert!(
        b.size.width.as_f32() + 1. < full,
        "the path is cut: shown {:?} of {full}",
        b.size.width
    );
    drop(v);

    // a root with no .idea module: the name bold, then the path
    let stree = common::fixtures().join("stree");
    let mut v = start_native(&stree, &[]);
    let root = tv(&mut v, |t| t.row_label(0).unwrap());
    assert_eq!(
        root,
        [
            ("stree".to_owned(), true),
            (format!("{nb}{}", home_relative(&stree)), false)
        ]
    );
    let b = bounds(&mut v, "tree-root-path").unwrap();
    let isl = island(&mut v);
    assert!(b.right() <= isl.right(), "{b:?} vs {isl:?}");
}

// The native menu --------------------------------------------------------------------------------

/// multi/a, c, d, e selected (Shift+click a range, Alt+click b off, Cmd+click e on).
fn select_four(v: &mut View) {
    focus_tree(v);
    sel(v, "multi");
    v.key("arrow_right");
    sel(v, "multi/a.ts");
    let shift = Modifiers {
        shift: true,
        ..Default::default()
    };
    let alt = Modifiers {
        alt: true,
        ..Default::default()
    };
    let cmd = Modifiers {
        platform: true,
        ..Default::default()
    };
    let p = row_point(v, "multi/d.ts", 4.);
    press(v, p, MouseButton::Left, shift, 1);
    let p = row_point(v, "multi/b.ts", 4.);
    press(v, p, MouseButton::Left, alt, 1);
    let p = row_point(v, "multi/e.ts", 4.);
    press(v, p, MouseButton::Left, cmd, 1);
    assert_eq!(
        selected(v),
        ["multi/a.ts", "multi/c.ts", "multi/d.ts", "multi/e.ts"]
    );
}

/// The native menu's Esc keeps the multi-selection; Reveal in Finder reveals the editor's file
/// (Ctrl+Cmd+Shift+O) and the menu's row.
#[test]
fn the_native_menu_keeps_the_selection_on_esc_and_reveals_in_finder() {
    let (_tmp, dir) = make_project();
    let mut v = start_native(&dir, &["a.ts"]);
    select_four(&mut v);
    v.key("super+enter");
    let rows = wait_menu_row(&mut v, "Delete 4 Items");
    assert!(rows.iter().any(|r| r.contains("Open 4 Files")), "{rows:?}");
    v.key("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    assert_eq!(
        selected(&mut v),
        ["multi/a.ts", "multi/c.ts", "multi/d.ts", "multi/e.ts"],
        "the selection is kept"
    );
    wait_target(&mut v, "tree");

    stub_finder(&mut v);
    stub_finder(&mut v);
    v.focus_code();
    wait_target(&mut v, "split");
    // in the editor: Ctrl+Cmd+Shift+O reveals the current file
    v.key("ctrl+super+shift+o");
    v.wait_lua(
        "the file revealed",
        "local r = _G.revealed return r ~= nil and #r == 3 and r[1] == 'open' and r[2] == '-R' \
         and r[3] == vim.api.nvim_buf_get_name(0)",
    );
    // the tree's menu (the real one): Reveal in Finder reveals the row
    focus_tree(&mut v);
    sel(&mut v, "multi");
    v.key("arrow_right");
    sel(&mut v, "multi/e.ts");
    v.lua("_G.revealed = nil return true");
    v.key("super+enter");
    pick_menu(&mut v, "Reveal in Finder");
    v.wait_lua(
        "the row revealed",
        "local r = _G.revealed return r ~= nil and #r == 3 and r[2] == '-R' and r[3]:find('multi/e%.ts$') ~= nil",
    );
}

// Speed search in the results ---------------------------------------------------------------------

/// (cursor, screen row, scroll top, query): what a fold must leave as it was.
type Put = (String, f32, f32, Option<String>);

fn put(v: &mut View) -> Put {
    (cur(v), screen_y(v), tv(v, |t| t.scroll_top().1), query(v))
}

/// A fold / unfold in the results (`act`): `rel` gets listed == `want`; the selected row, its
/// screen row, the scroll and the search stay as they were.
fn fold_check(v: &mut View, label: &str, rel: &str, want: bool, act: impl FnOnce(&mut View)) {
    let before = put(v);
    act(v);
    wait_tree(v, &format!("{label}: {rel} listed == {want}"), |t| {
        t.row_index(rel).is_some() == want
    });
    v.settle();
    assert_eq!(put(v), before, "{label}: selected row and view stay put");
}

#[test]
fn search_folds_keep_the_selected_row_put() {
    let mut v = start_native(&common::fixtures().join("stree"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    // scrolled down the list: theta/sub is below the first screen
    go(&mut v, "theta/sub");
    v.key("arrow_left");
    assert!(!listed(&mut v, "theta/sub/item1.ts"));
    fold_check(&mut v, "→", "theta/sub/item1.ts", true, |v| {
        v.key("arrow_right")
    });
    go(&mut v, "theta");
    fold_check(&mut v, "Enter", "theta/item1.ts", false, |v| v.key("enter"));
    v.key("arrow_right");
    // the results list focused (a click on a result), then a chevron click
    go(&mut v, "kappa");
    let p = row_point(&mut v, "kappa", 4.);
    click(&mut v, p);
    assert!(!tv(&mut v, |t| t.search_input()));
    fold_check(&mut v, "chevron click", "kappa/item1.ts", false, |v| {
        let c = chevron(v, "kappa");
        click(v, c);
    });
    v.key("arrow_right");
    wait_tree(&mut v, "kappa unfolded", |t| {
        t.row_index("kappa/item1.ts").is_some()
    });
    // the menu's Collapse (the real menu)
    fold_check(&mut v, "menu Collapse", "kappa/item1.ts", false, |v| {
        v.key("super+enter");
        pick_menu(v, "Collapse");
    });
    drop(v);

    // many results: ← on a folder deep in the list (scrolled)
    let mut v = start_native(&common::fixtures().join("sbig"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    go(&mut v, "d02/s03/item4.ts");
    assert!(tv(&mut v, |t| t.scroll_top().1) > 0., "scrolled down");
    v.key("arrow_left");
    assert_eq!(cur(&mut v), "d02/s03", "← on a file: its folder");
    fold_check(
        &mut v,
        "← (many results)",
        "d02/s03/item1.ts",
        false,
        |v| v.key("arrow_left"),
    );
}

#[test]
fn search_mouse_menu_and_closing() {
    let mut v = start_native(&common::fixtures().join("stree"), &[]);
    focus_tree(&mut v);
    // a click into the editor closes the search (focus to the editor, the full tree)
    search_start(&mut v, "b");
    let at = v.cell_pos(5, 10);
    v.click(MouseButton::Left, at);
    v.pump();
    wait_target(&mut v, "split");
    wait_tree(&mut v, "click into the editor: closed", |t| {
        t.query().is_none() && t.row_index("alpha").is_some() && t.row_index("dist").is_some()
    });

    // a double-click on a result folder (from another row): selects it, folds it
    focus_tree(&mut v);
    search_start(&mut v, "item");
    go(&mut v, "kappa");
    v.key("arrow_down");
    assert_eq!(cur(&mut v), "kappa/sub");
    let p = row_point(&mut v, "kappa", 4.);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 1);
    press(&mut v, p, MouseButton::Left, Modifiers::default(), 2);
    assert_eq!(cur(&mut v), "kappa");
    assert!(!listed(&mut v, "kappa/item1.ts"), "double-click folds");
    assert_eq!(query(&mut v).as_deref(), Some("item"));

    // the menu on a result folder: Collapse folds it in the results
    v.key("arrow_right");
    wait_tree(&mut v, "unfolded", |t| {
        t.row_index("kappa/item1.ts").is_some()
    });
    let p = row_point(&mut v, "kappa", 4.);
    press(&mut v, p, MouseButton::Right, Modifiers::default(), 1);
    pick_menu(&mut v, "Collapse");
    wait_tree(&mut v, "menu Collapse folds", |t| {
        t.row_index("kappa/item1.ts").is_none()
    });
    assert_eq!(cur(&mut v), "kappa");
    assert_eq!(query(&mut v).as_deref(), Some("item"));
    v.key("escape");
    wait_tree(&mut v, "closed", |t| t.query().is_none());

    // Esc with the results list focused (a click on a result): closes, the tree keeps the keys
    focus_tree(&mut v);
    search_start(&mut v, "item3");
    let p = row_point(&mut v, "beta/item3.ts", 4.);
    click(&mut v, p);
    assert!(!tv(&mut v, |t| t.search_input()), "the list has the keys");
    v.key("escape");
    wait_tree(&mut v, "Esc from the list: closed", |t| t.query().is_none());
    assert_eq!(cur(&mut v), "beta/item3.ts");
    assert_eq!(target(&v), "tree");
}

#[test]
#[cfg_attr(
    not(debug_assertions),
    ignore = "GPUI debug selectors (debug_bounds) exist in debug builds only"
)]
fn search_field_layout_and_count_text() {
    let mut v = start_native(&common::fixtures().join("stree"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "zz");
    // the field right under the "Project" header (WS layout), the list under it; "No matches" in red
    let isl = island(&mut v);
    let field = bounds(&mut v, "tree-search").expect("the search field");
    let top = field.top() - isl.top();
    let header = look::TOOL_WINDOW_HEADER_HEIGHT;
    assert!(
        top >= px(header.get()) && top < px(header + look::TREE_ROW_HEIGHT / 2.),
        "field under the island's header: {field:?} vs {isl:?}"
    );
    let first = tv(&mut v, |t| t.row_point(0, 0.).unwrap());
    assert!(
        first.y > field.bottom(),
        "the list under the field: {first:?} vs {field:?}"
    );
    assert_eq!(
        tv(&mut v, |t| t.search_count_label()),
        Some(("No matches".to_owned(), true))
    );
    drop(v);

    // sbig: the count drawn is the current results'
    let mut v = start_native(&common::fixtures().join("sbig"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    v.key("digit_1");
    wait_tree(&mut v, "item1", |t| t.results_query() == Some("item1"));
    let n = tv(&mut v, |t| t.match_count()).unwrap();
    assert!(n > 100, "{n}");
    assert_eq!(
        tv(&mut v, |t| t.search_count_label()),
        Some((format!("{n} matches"), false))
    );
}

#[test]
fn search_many_results_scroll_and_wheel() {
    let mut v = start_native(&common::fixtures().join("sbig"), &[]);
    focus_tree(&mut v);
    search_start(&mut v, "item");
    let h = look::TREE_ROW_HEIGHT;
    let isl = island(&mut v);
    let bottom = isl.bottom().as_f32() - look::ISLAND_BORDER_WIDTH;
    let status = v.read(|e| e.geometry().layout.frame.status);
    assert!(
        isl.bottom() <= status.top(),
        "the list ends above the status bar"
    );
    let row_bottom = |v: &mut View| {
        let c = cur(v);
        row_point(v, &c, 0.).y.as_f32() + h / 2.
    };
    assert_eq!(tv(&mut v, |t| t.scroll_top().1), 0.);
    // ↓ scrolls only past the last row on screen
    let mut steps = 0;
    loop {
        let rb = row_bottom(&mut v);
        let top = tv(&mut v, |t| t.scroll_top().1);
        let last = rb + h > bottom + 0.5;
        v.key("arrow_down");
        let top2 = tv(&mut v, |t| t.scroll_top().1);
        if !last {
            assert_eq!(top2, 0., "no scrolling before the last row (step {steps})");
        } else {
            assert_eq!(top, 0., "never scrolled before");
            assert!(rb <= bottom + 0.5, "last row on screen: {rb} vs {bottom}");
            assert!(
                top2 > 0. && top2 <= h + 0.01,
                "past the last row: scrolls (up to) one row: {top2}"
            );
            let nb = row_bottom(&mut v);
            assert!(
                (nb - bottom).abs() < 0.5,
                "the new row at the bottom: {nb} vs {bottom}"
            );
            break;
        }
        steps += 1;
        assert!(steps < 200);
    }
    let top = tv(&mut v, |t| t.scroll_top().1);
    v.key("arrow_down");
    let top2 = tv(&mut v, |t| t.scroll_top().1);
    assert!((top2 - top - h).abs() < 0.01, "one row: {top} -> {top2}");

    // the wheel: the view scrolls, the selected row stays
    let c = cur(&mut v);
    let at = row_point(&mut v, &c, 4.);
    v.scroll(
        point(at.x, at.y - px(100.)),
        ScrollDelta::Pixels(point(px(0.), px(-3. * h))),
        TouchPhase::Moved,
    );
    v.pump();
    let top3 = tv(&mut v, |t| t.scroll_top().1);
    assert!(
        (top3 - top2 - 3. * h).abs() < 0.5,
        "wheel scrolls: {top2} -> {top3}"
    );
    assert_eq!(cur(&mut v), c, "the selected row stays");
}
