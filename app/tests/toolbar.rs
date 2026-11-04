//! The main toolbar on the real nvim + config: no project / branch widget, the centered window
//! title, the Branches… popup (groups, keys, typing filters, checkout, New Branch…), the Recent
//! Projects… popup and opening a project in the window (in place of the shown one, or alongside:
//! one nvim per open project), closing one (asks when work would be lost).
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::view::View;
use gpui_kit::{Bounds, Entity, MouseButton, Pixels, Point};
use vimstorm::git;
use vimstorm::git::Target;
use vimstorm::shell::Workspace;
use vimstorm::shell::toolbar::Launcher;
use vimstorm::shell::toolbar::{BranchRow, PopupKind, ToolbarView};

/// A private copy of the grepo fixture (and its remote) to check out / branch in.
struct Repo {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
}

fn grepo_copy() -> Repo {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    for name in ["grepo", "gremote.git"] {
        let out = std::process::Command::new("cp")
            .arg("-R")
            .arg(common::fixtures().join(name))
            .arg(&root)
            .output()
            .unwrap();
        assert!(out.status.success(), "cp {name}");
    }
    Repo {
        _tmp: tmp,
        dir: root.join("grepo"),
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = git::run_blocking(dir, args).unwrap();
    assert!(out.ok(), "git {args:?}: {}", out.stderr);
    out.stdout.trim().to_owned()
}

fn start(dir: &Path, files: &[&str]) -> View {
    View::start(dir.to_str().unwrap(), files)
}

fn toolbar(v: &mut View) -> Entity<ToolbarView> {
    v.read_ws(|ws, _| ws.toolbar().clone())
}

fn tb<R>(v: &mut View, f: impl FnOnce(&ToolbarView, &gpui_kit::App) -> R) -> R {
    let t = toolbar(v);
    v.pump();
    t.read_with(&v.cx, f)
}

/// Polls `f` (pumping the UI: background git tasks, nvim's events) until it holds.
#[track_caller]
fn wait(v: &mut View, label: &str, mut f: impl FnMut(&mut View) -> bool) {
    let deadline = Instant::now() + common::TIMEOUT;
    loop {
        v.pump();
        if f(v) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for: {label}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[track_caller]
fn bounds(v: &mut View, selector: &'static str) -> Bounds<Pixels> {
    v.pump();
    v.cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} isn't drawn"))
}

fn center(b: Bounds<Pixels>) -> Point<Pixels> {
    b.center()
}

#[track_caller]
fn click(v: &mut View, selector: &'static str) {
    let at = center(bounds(v, selector));
    v.click(MouseButton::Left, at);
    v.pump();
}

/// Waits until the repo's checked-out branch is `want` (git itself; the branch popup reads it).
#[track_caller]
fn wait_branch(v: &mut View, dir: &Path, want: &str) {
    let label = format!("{want} checked out");
    wait(v, &label, |_| {
        git(dir, &["branch", "--show-current"]) == want
    });
}

/// Branches… (the editor context menu item; there's no branch widget).
fn open_branches(v: &mut View) {
    v.lua("require('config.app.toolbar').open('branches') return true");
    wait_popup(v, Some(PopupKind::Branches));
}

#[track_caller]
fn wait_popup(v: &mut View, want: Option<PopupKind>) {
    wait(v, &format!("popup {want:?}"), |v| {
        tb(v, |t, _| t.popup_kind() == want)
    });
}

fn native_focus(v: &mut View) -> Option<&'static str> {
    v.read_ws(|ws, _| ws.native_focus())
}

fn branch(name: &str, current: bool) -> BranchRow {
    BranchRow::Branch {
        target: Target::Local(name.into()),
        current,
    }
}

fn remote(name: &str) -> BranchRow {
    BranchRow::Branch {
        target: Target::Remote(name.into()),
        current: false,
    }
}

fn caption(title: &'static str) -> BranchRow {
    BranchRow::Caption { title, line: true }
}

#[test]
fn centered_title_and_no_project_widget() {
    let repo = grepo_copy();
    let mut v = start(&repo.dir, &["blame.ts"]);
    // nvim's title (config/statusline.lua): "project – file"
    wait(&mut v, "title", |v| {
        tb(v, |t, _| t.title() == "grepo – blame.ts")
    });

    let title = bounds(&mut v, "toolbar-title");
    let toolbar = v.read(|e| e.geometry().layout.frame.toolbar);
    // no project widget (the user removed it) and no branch widget (the branch is in the status
    // bar): the traffic lights, then the title
    assert!(v.cx.debug_bounds("toolbar-project").is_none());
    assert!(v.cx.debug_bounds("toolbar-branch").is_none());
    assert!(title.origin.x >= Pixels::from(78.), "{title:?}");
    // centered in the window
    let mid = toolbar.size.width / 2.;
    assert!(
        (title.center().x - mid).abs() < Pixels::from(1.),
        "title {title:?} not centered on {mid:?}"
    );

    // the right group: Search Everywhere (26 px), then Settings' gear 8 from the right
    // edge; a click on the magnifier opens it
    let search = bounds(&mut v, "toolbar-search");
    assert_eq!(
        search.size,
        gpui_kit::size(Pixels::from(26.), Pixels::from(26.))
    );
    let gear = bounds(&mut v, "toolbar-settings");
    assert!((toolbar.right() - gear.right() - Pixels::from(8.)).abs() < Pixels::from(0.5));
    assert!(search.right() < gear.left());
    assert!(toolbar.contains(&search.center()));
    click(&mut v, "toolbar-search");
    let kind = |v: &mut View| v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).map(|s| s.kind));
    wait(&mut v, "Search Everywhere from the magnifier", |v| {
        kind(v).as_deref() == Some("all")
    });
    v.key("escape");
    wait(&mut v, "Search Everywhere closed", |v| kind(v).is_none());

    // another file: the title follows
    v.lua("vim.cmd.edit('diff.ts') return true");
    wait(&mut v, "title follows", |v| {
        tb(v, |t, _| t.title() == "grepo – diff.ts")
    });

    // narrow: no room to center it -> right of the traffic lights, cut
    v.cx.simulate_resize(gpui_kit::size(Pixels::from(420.), Pixels::from(600.)));
    v.pump();
    let title = bounds(&mut v, "toolbar-title");
    assert!(title.origin.x >= Pixels::from(78.), "{title:?}");
    assert!(title.right() <= Pixels::from(420.), "title {title:?}");
}

#[test]
fn branch_popup_keys_search_and_checkout() {
    let repo = grepo_copy();
    // a clean tree, so master -> factory/1237 can switch
    git(&repo.dir, &["stash", "-u", "-q"]);
    let mut v = start(&repo.dir, &["blame.ts"]);
    assert_eq!(v.current_line(), "line one");

    open_branches(&mut v);
    // under the toolbar, in the window's middle
    let popup = bounds(&mut v, "toolbar-popup");
    let toolbar = v.read(|e| e.geometry().layout.frame.toolbar);
    assert!(popup.top() >= toolbar.bottom(), "{popup:?}");
    assert!(
        (popup.center().x - toolbar.center().x).abs() < Pixels::from(2.),
        "{popup:?} centered"
    );
    assert_eq!(
        native_focus(&mut v),
        Some("toolbar"),
        "the popup has the keyboard"
    );
    let rows = tb(&mut v, |t, cx| t.branch_rows(cx));
    assert_eq!(
        rows,
        vec![
            BranchRow::NewBranch,
            BranchRow::Caption {
                title: "Recent",
                line: true
            },
            branch("master", true),
            branch("factory/1237", false),
            caption("Local"),
            branch("factory/1237", false),
            branch("master", true),
            caption("Remote"),
            remote("origin/factory/1237"),
            remote("origin/master"),
        ]
    );
    // on the current branch; ↓ / ↑ (and Ctrl-n / Ctrl-p) move, captions are skipped
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(branch("master", true))
    );
    v.key("arrow_down");
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(branch("factory/1237", false))
    );
    v.key("ctrl+n");
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(branch("factory/1237", false)),
        "the Local caption is skipped"
    );
    v.key("arrow_up");
    v.key("ctrl+p");
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(branch("master", true))
    );

    // → opens the branch's submenu (Esc back); every letter filters at once (k / ä too, no `/`)
    v.key("arrow_right");
    wait(&mut v, "→: the submenu", |v| popups_menu(v).is_some());
    v.keystrokes("escape");
    wait(&mut v, "Esc: back to the branches", |v| {
        popups_menu(v).is_none()
    });
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_rows_shown(cx).len()),
        rows.len()
    );
    v.keystrokes("k");
    assert!(
        tb(&mut v, |t, cx| t.branch_rows_shown(cx).len()) < rows.len(),
        "k filters"
    );
    v.keystrokes("backspace");
    v.cx.simulate_input("origin/m");
    let shown = tb(&mut v, |t, cx| t.branch_rows_shown(cx));
    assert_eq!(shown, vec![remote("origin/master")], "{shown:?}");
    // Esc: the search, then the popup (keyboard back to nvim)
    v.keystrokes("escape");
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_rows_shown(cx).len()),
        rows.len()
    );
    v.keystrokes("escape");
    wait_popup(&mut v, None);
    wait(&mut v, "keyboard back to nvim", |v| {
        native_focus(v).is_none()
    });

    // a click outside closes
    open_branches(&mut v);
    // in the editor, away from the popup
    let editor = v.read(|e| e.geometry().layout.editor);
    let at = Point {
        x: editor.right() - Pixels::from(40.),
        y: editor.bottom() - Pixels::from(40.),
    };
    v.click(MouseButton::Left, at);
    wait_popup(&mut v, None);

    // Enter opens the branch's actions beside it (the popup stays); Enter on Checkout: git and the
    // open buffer follow
    open_branches(&mut v);
    v.key("arrow_down");
    v.keystrokes("enter");
    wait(&mut v, "the branch's submenu", |v| {
        popups_menu(v).is_some_and(|r| r.first().is_some_and(|f| f == "Checkout"))
    });
    assert_eq!(
        popups_menu(&mut v).unwrap(),
        [
            "Checkout",
            "New Branch from 'factory/1237'…",
            "Compare with Current",
            "Rename…",
            "Delete…"
        ]
    );
    assert_eq!(
        tb(&mut v, |t, _| t.popup_kind()),
        Some(PopupKind::Branches),
        "the branches stay under their submenu"
    );
    v.keystrokes("enter");
    wait_popup(&mut v, None);
    wait_branch(&mut v, &repo.dir, "factory/1237");
    // the result in a balloon
    wait(&mut v, "result balloon", |v| {
        let p = v.read_ws(|ws, _| ws.popups().clone());
        p.read_with(&v.cx, |p, _| p.balloons())
            .iter()
            .any(|(_, body)| body == "Switched to factory/1237")
    });
    v.wait_lua(
        "blame.ts reloaded (checktime)",
        "return vim.api.nvim_buf_get_lines(0, 1, 2, false)[1] == 'line two'",
    );

    // a remote branch with a local twin: switches to the local one
    open_branches(&mut v);
    let rows = tb(&mut v, |t, cx| t.branch_rows(cx));
    let ix = rows
        .iter()
        .position(|r| r == &remote("origin/master"))
        .unwrap();
    let row_bounds = list_row(&mut v, ix);
    v.click(MouseButton::Left, center(row_bounds));
    wait(&mut v, "the remote branch's submenu", |v| {
        popups_menu(v).is_some_and(|r| r.len() == 4 && r[0] == "Checkout")
    });
    // beside the row, to the popup's right
    let menu = bounds(&mut v, "menu");
    assert!(
        menu.left() > row_bounds.center().x,
        "{menu:?} {row_bounds:?}"
    );
    assert!(
        (menu.top() - row_bounds.top()).abs() < Pixels::from(12.),
        "{menu:?} {row_bounds:?}"
    );
    click(&mut v, "menu-row-0");
    wait_branch(&mut v, &repo.dir, "master");
}

/// P-19: a branch's submenu (→, Enter, a click) holds WebStorm's actions: New Branch from
/// '<b>'…, Rename…, Compare with Current (the Git Log on `current..branch`), Delete… (asked
/// first: Cancel is the default, `d` deletes); Esc goes back to the branches.
#[test]
fn branch_submenu_new_from_rename_compare_delete() {
    let repo = grepo_copy();
    let mut v = start(&repo.dir, &["blame.ts"]);
    let submenu = |v: &mut View, row: BranchRow| {
        open_branches(v);
        assert!(tb(v, |t, cx| t.branch_rows(cx)).contains(&row), "{row:?}");
        while tb(v, |t, cx| t.branch_cursor(cx)) != Some(row.clone()) {
            v.key("arrow_down");
        }
        v.key("arrow_right");
        wait(v, "the submenu", |v| popups_menu(v).is_some());
    };

    // the current branch: only New Branch from… and Rename…; Esc back to the branches
    submenu(&mut v, branch("master", true));
    assert_eq!(
        popups_menu(&mut v).unwrap(),
        ["New Branch from 'master'…", "Rename…"]
    );
    v.keystrokes("escape");
    wait(&mut v, "submenu closed", |v| popups_menu(v).is_none());
    assert_eq!(tb(&mut v, |t, _| t.popup_kind()), Some(PopupKind::Branches));
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(branch("master", true)),
        "the keys are the branches' again"
    );
    v.keystrokes("escape");
    wait_popup(&mut v, None);

    // New Branch from 'factory/1237'…: created there and checked out
    submenu(&mut v, branch("factory/1237", false));
    v.keystrokes("down enter");
    wait_popup(&mut v, Some(PopupKind::NewBranch));
    v.cx.simulate_input("from-factory");
    v.keystrokes("enter");
    // the fixture's local changes block the switch: git's reason stays in the form
    wait(&mut v, "git's error in the form", |v| {
        tb(v, |t, cx| t.new_branch_error(cx)).is_some_and(|e| e.contains("local changes"))
    });
    git(&repo.dir, &["reset", "-q", "--hard"]);
    // (the reason goes once the name is edited)
    v.keystrokes("backspace");
    v.cx.simulate_input("y");
    wait(&mut v, "no error", |v| {
        tb(v, |t, cx| t.new_branch_error(cx)).is_none()
    });
    v.keystrokes("enter");
    wait_branch(&mut v, &repo.dir, "from-factory");
    assert_eq!(
        git(&repo.dir, &["rev-parse", "from-factory"]),
        git(&repo.dir, &["rev-parse", "factory/1237"])
    );

    // Rename…: the old name in the field, selected; typing replaces it
    submenu(&mut v, branch("from-factory", true));
    v.keystrokes("down enter");
    wait_popup(&mut v, Some(PopupKind::NewBranch));
    v.cx.simulate_input("renamed");
    v.keystrokes("enter");
    wait_branch(&mut v, &repo.dir, "renamed");

    // Compare with Current: the Git Log on renamed..master
    submenu(&mut v, branch("master", false));
    v.keystrokes("down down enter");
    wait_popup(&mut v, None);
    v.wait_lua(
        "the Log filtered to the range",
        "local f = require('config.app.git').log_filters() return f ~= nil and f.branch == 'renamed..master'",
    );

    // Delete…: asked first, Cancel by default (Enter keeps it)
    submenu(&mut v, branch("master", false));
    v.keystrokes("l enter");
    let p = v.read_ws(|ws, _| ws.popups().clone());
    wait(&mut v, "the delete question", |v| {
        v.pump();
        p.read_with(&v.cx, |p, _| p.dialog())
            .is_some_and(|(id, _)| id == "delete-branch")
    });
    v.keystrokes("enter");
    wait(&mut v, "cancelled", |v| {
        p.read_with(&v.cx, |p, _| p.dialog()).is_none()
    });
    assert!(git(&repo.dir, &["branch", "--list", "master"]).contains("master"));
    // `d` deletes
    submenu(&mut v, branch("master", false));
    v.keystrokes("l enter");
    wait(&mut v, "the delete question", |v| {
        v.pump();
        p.read_with(&v.cx, |p, _| p.dialog()).is_some()
    });
    v.keystrokes("d");
    wait(&mut v, "master deleted", |_| {
        git(&repo.dir, &["branch", "--list", "master"]).is_empty()
    });
}

/// Window bounds of list row `ix` (the popup's list rows have debug selectors).
fn list_row(v: &mut View, ix: usize) -> Bounds<Pixels> {
    let sel: &'static str = Box::leak(format!("list-row-{ix}").into_boxed_str());
    bounds(v, sel)
}

#[test]
fn new_branch_validates_creates_and_checks_out() {
    let repo = grepo_copy();
    let mut v = start(&repo.dir, &[]);

    open_branches(&mut v);
    v.keystrokes("home");
    assert_eq!(
        tb(&mut v, |t, cx| t.branch_cursor(cx)),
        Some(BranchRow::NewBranch)
    );
    v.keystrokes("enter");
    wait_popup(&mut v, Some(PopupKind::NewBranch));
    assert_eq!(native_focus(&mut v), Some("toolbar"));

    // an existing name: an error, Enter does nothing
    v.cx.simulate_input("master");
    wait(&mut v, "error for an existing branch", |v| {
        tb(v, |t, cx| t.new_branch_error(cx)).is_some_and(|e| e.contains("already exists"))
    });
    v.keystrokes("enter");
    assert_eq!(
        tb(&mut v, |t, _| t.popup_kind()),
        Some(PopupKind::NewBranch)
    );

    // a good one: created from HEAD and checked out (local changes come along)
    v.keystrokes("cmd-a backspace");
    v.cx.simulate_input("feature/x");
    wait(&mut v, "no error", |v| {
        tb(v, |t, cx| t.new_branch_error(cx)).is_none()
    });
    v.keystrokes("enter");
    wait_popup(&mut v, None);
    wait_branch(&mut v, &repo.dir, "feature/x");
    wait(&mut v, "keyboard back to nvim", |v| {
        native_focus(v).is_none()
    });

    // the menu item (Lua) opens the form too; Esc closes it
    v.lua(
        "for _, e in ipairs(require('config.app.toolbar').menu_items()) do \
           if e[1] == 'New Branch…' then e[2]() end end return true",
    );
    wait_popup(&mut v, Some(PopupKind::NewBranch));
    v.keystrokes("escape");
    wait_popup(&mut v, None);
}

#[test]
fn a_detached_head_has_no_current_branch_in_the_popup() {
    let repo = grepo_copy();
    let mut v = start(&repo.dir, &[]);
    // a checkout in a terminal
    git(&repo.dir, &["switch", "-q", "--detach", "HEAD"]);
    open_branches(&mut v);
    let rows = tb(&mut v, |t, cx| t.branch_rows(cx));
    assert!(
        !rows
            .iter()
            .any(|r| matches!(r, BranchRow::Branch { current: true, .. }))
    );
    v.keystrokes("escape");
    wait_popup(&mut v, None);
}

/// The window's open projects' dirs (the app's root, `View::start_projects`).
fn open_dirs(v: &mut View) -> Vec<PathBuf> {
    v.pump();
    let p = v.projects.clone().unwrap();
    p.read_with(&v.cx, |p, _| p.dirs())
}

/// The shown project's dir.
fn shown(v: &mut View) -> PathBuf {
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, _| ws.project().clone())
}

/// A saved session for `dir` in the view's state dir (it's listed as a recent project).
fn session(v: &View, dir: &Path) {
    let state = v.lua("return vim.fn.stdpath('state')");
    let sessions = PathBuf::from(state.as_str().unwrap()).join("open-files");
    std::fs::create_dir_all(&sessions).unwrap();
    let name = format!("{}.json", dir.display()).replace('/', "%");
    std::fs::write(sessions.join(name), r#"{"files":[]}"#).unwrap();
}

/// Waits until a workspace's nvim runs in `dir`.
fn wait_cwd(v: &mut View, ws: &Entity<Workspace>, dir: &Path) {
    v.use_project(ws);
    wait(v, &format!("nvim in {dir:?}"), |v| {
        v.lua("return vim.fn.getcwd()").as_str() == dir.to_str()
    });
}

fn popups_menu(v: &mut View) -> Option<Vec<String>> {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| p.menu_rows())
}

fn pid_of(v: &mut View, ws: &Entity<Workspace>) -> u32 {
    let e = ws.read_with(&v.cx, |ws, _| ws.editor().clone());
    e.update(&mut v.cx, |e, _| e.nvim_mut().pid())
}

/// Recent Projects… (the editor menu's item; no widget any more).
fn open_projects_popup(v: &mut View) {
    v.lua("require('config.app.toolbar').open('projects') return true");
    wait_popup(v, Some(PopupKind::Projects));
    v.pump();
}

/// The popup's rows shown (filtered), by name.
fn project_names(v: &mut View) -> Vec<String> {
    let rows = tb(v, |t, cx| t.project_rows_shown(cx));
    rows.into_iter().map(|p| p.name).collect()
}

fn exited(v: &mut View, ws: &Entity<Workspace>) -> bool {
    let e = ws.read_with(&v.cx, |ws, _| ws.editor().clone());
    e.update(&mut v.cx, |e, _| e.nvim_mut().exited())
}

/// A grepo copy renamed to `name` (in its own temp dir).
fn named_copy(name: &str) -> (Repo, PathBuf) {
    let r = grepo_copy();
    let dir = r.dir.parent().unwrap().join(name);
    std::fs::rename(&r.dir, &dir).unwrap();
    (r, dir)
}

#[test]
fn project_popup_opens_in_place_or_alongside() {
    // (names no other recent project matches: the list has WS's recent projects too)
    let (_a, a_dir) = named_copy("wwfirst");
    let (_b, b_dir) = named_copy("zzother");
    let (_c, c_dir) = named_copy("qqthird");
    let (_d, d_dir) = named_copy("xxfourth");

    let mut v = View::start_projects(a_dir.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    let pid_a = pid_of(&mut v, &ws_a);
    for d in [&d_dir, &c_dir, &b_dir] {
        session(&v, d);
    }

    // this project on top and selected (WS): Enter on it changes nothing
    open_projects_popup(&mut v);
    let rows = tb(&mut v, |t, cx| t.project_rows(cx));
    assert_eq!(rows[0].path, a_dir, "{rows:?}");
    assert!(
        rows[0].open && rows.iter().skip(1).all(|r| !r.open),
        "{rows:?}"
    );
    let other = rows.iter().find(|r| r.path == b_dir).expect("other listed");
    assert_eq!(other.branch.as_deref(), Some("master"));
    assert!(v.cx.debug_bounds("toolbar-close-project").is_some());
    // the footer says what Enter / Shift+Enter do (WS popup ad text)
    assert!(v.cx.debug_bounds("toolbar-projects-hint").is_some());
    // under the toolbar, centered
    let popup = bounds(&mut v, "toolbar-popup");
    let toolbar = v.read(|e| e.geometry().layout.frame.toolbar);
    assert!(
        popup.top() >= toolbar.bottom() - Pixels::from(1.),
        "{popup:?}"
    );
    assert!(
        (popup.center().x - toolbar.center().x).abs() < Pixels::from(1.),
        "{popup:?}"
    );
    v.keystrokes("enter");
    wait_popup(&mut v, None);
    v.settle();
    assert_eq!(
        open_dirs(&mut v),
        std::slice::from_ref(&a_dir),
        "nothing opened"
    );

    // typing filters at once; Shift+Enter: alongside (a new nvim, a keeps running)
    open_projects_popup(&mut v);
    v.cx.simulate_input("zzo");
    assert_eq!(project_names(&mut v), ["zzother"]);
    v.keystrokes("shift-enter");
    wait(&mut v, "zzother shown", |v| shown(v) == b_dir);
    let ws_b = v.active_project();
    wait_cwd(&mut v, &ws_b, &b_dir);
    assert_eq!(
        open_dirs(&mut v),
        [a_dir.clone(), b_dir.clone()],
        "one more"
    );
    assert!(!exited(&mut v, &ws_a));
    assert_eq!(pid_of(&mut v, &ws_a), pid_a);
    // the new toolbar is on `other`, the new editor has the keyboard
    let title = tb(&mut v, |t, _| t.title().to_owned());
    assert!(title.starts_with("zzother"), "{title}");
    let typing = v.cx.update(|window, cx| {
        let editor = ws_b.read(cx).editor().clone();
        gpui_kit::Focusable::focus_handle(editor.read(cx), cx).is_focused(window)
    });
    assert!(typing, "the new editor has the keyboard");

    // Enter on an open one: just shown (nothing closes)
    open_projects_popup(&mut v);
    v.cx.simulate_input("wwf");
    v.keystrokes("enter");
    wait(&mut v, "a shown", |v| shown(v) == a_dir);
    assert_eq!(open_dirs(&mut v), [a_dir.clone(), b_dir.clone()]);
    assert!(!exited(&mut v, &ws_b));

    // Enter on a closed one: in place of this one (nothing to lose: no question); its nvim
    // quits, the new one takes its place in the Cmd+< order, the other stays
    v.use_project(&ws_a);
    open_projects_popup(&mut v);
    v.cx.simulate_input("qqt");
    v.keystrokes("enter");
    wait(&mut v, "third shown", |v| shown(v) == c_dir);
    let ws_c = v.active_project();
    wait_cwd(&mut v, &ws_c, &c_dir);
    assert_eq!(
        open_dirs(&mut v),
        [c_dir.clone(), b_dir.clone()],
        "same count"
    );
    wait(&mut v, "a's nvim quit", |v| exited(v, &ws_a));
    assert!(!exited(&mut v, &ws_b));

    // work that would be lost: asked first; Cancel keeps it, Close replaces
    v.wait_lua("third's config up", common::STARTED);
    v.lua("vim.cmd.enew() vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'draft' }) return true");
    open_projects_popup(&mut v);
    v.cx.simulate_input("xxf");
    v.keystrokes("enter");
    wait(&mut v, "confirmation", close_dialog);
    v.keystrokes("escape");
    wait(&mut v, "confirmation closed", |v| !close_dialog(v));
    v.settle();
    assert_eq!(
        open_dirs(&mut v),
        [c_dir.clone(), b_dir.clone()],
        "not replaced"
    );
    assert_eq!(v.current_line(), "draft");
    open_projects_popup(&mut v);
    v.cx.simulate_input("xxf");
    v.keystrokes("enter");
    wait(&mut v, "confirmation", close_dialog);
    // ⏎ is Cancel (P-17); `y` closes
    v.keystrokes("y");
    wait(&mut v, "fourth shown", |v| shown(v) == d_dir);
    assert_eq!(open_dirs(&mut v), [d_dir.clone(), b_dir.clone()]);
    wait(&mut v, "third's nvim quit", |v| exited(v, &ws_c));
}

/// A long recent list in a short window: the popup stays under the toolbar, the list shrinks
/// (and scrolls) so the "Close Project" row and the hint fit above the window's bottom margin.
#[test]
fn project_popup_fits_under_the_toolbar() {
    let a = grepo_copy();
    let tmp = tempfile::tempdir().unwrap();
    let mut v = View::start_projects(a.dir.to_str().unwrap(), &[]);
    for i in 0..12 {
        let dir = tmp.path().canonicalize().unwrap().join(format!("p{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        session(&v, &dir);
    }
    v.cx.simulate_resize(gpui_kit::size(Pixels::from(900.), Pixels::from(400.)));
    v.pump();
    open_projects_popup(&mut v);
    let toolbar = v.read(|e| e.geometry().layout.frame.toolbar);
    let popup = bounds(&mut v, "toolbar-popup");
    let close = bounds(&mut v, "toolbar-close-project");
    let hint = bounds(&mut v, "toolbar-projects-hint");
    assert!(
        popup.top() >= toolbar.bottom() - Pixels::from(1.),
        "{popup:?} under {toolbar:?}"
    );
    assert!(
        popup.bottom() <= Pixels::from(400. - 8.),
        "{popup:?} above the window margin"
    );
    assert!(
        close.bottom() <= hint.top() + Pixels::from(0.5),
        "{close:?} over {hint:?}"
    );
    assert!(hint.bottom() <= popup.bottom(), "{hint:?} in {popup:?}");
}

#[test]
fn closing_a_project_asks_first_when_work_would_be_lost() {
    let a = grepo_copy();
    let b = grepo_copy();
    let mut v = View::start_projects(a.dir.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    let open = format!(
        "require('config.app.toolbar').open_project('{}') return true",
        b.dir.display()
    );
    v.lua(&open);
    wait(&mut v, "b shown", |v| shown(v) == b.dir);
    let ws_b = v.active_project();
    wait_cwd(&mut v, &ws_b, &b.dir);
    v.wait_lua("b's config up", common::STARTED);
    // a buffer `wall` can't write (no name)
    v.lua("vim.cmd.enew() vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'draft' }) return true");

    // the Recent Projects… popup's Close Project
    open_projects_popup(&mut v);
    click(&mut v, "toolbar-close-project");
    wait(&mut v, "confirmation", close_dialog);
    // Esc: stays, the draft too
    v.keystrokes("escape");
    wait(&mut v, "confirmation closed", |v| !close_dialog(v));
    v.settle();
    assert_eq!(open_dirs(&mut v).len(), 2, "not closed");
    assert_eq!(v.current_line(), "draft");
    // ⏎: Cancel is the default (P-17)
    v.lua("require('config.app.toolbar').close_project() return true");
    wait(&mut v, "confirmation", close_dialog);
    v.keystrokes("enter");
    wait(&mut v, "cancelled", |v| !close_dialog(v));
    v.settle();
    assert_eq!(open_dirs(&mut v).len(), 2, "⏎ cancels");

    // Close (`y`): b goes, a shows
    v.lua("require('config.app.toolbar').close_project() return true");
    wait(&mut v, "confirmation", close_dialog);
    v.keystrokes("y");
    wait(&mut v, "a shown", |v| shown(v) == a.dir);
    assert_eq!(open_dirs(&mut v), std::slice::from_ref(&a.dir));
    assert_eq!(v.active_project(), ws_a);
}

#[test]
fn reopening_a_project_just_closed_waits_for_its_session() {
    let a = grepo_copy();
    let b = grepo_copy();
    let mut v = View::start_projects(a.dir.to_str().unwrap(), &[]);
    // each new project: was b's old nvim already gone when it started?
    // (b quitting, b's old nvim exited) per new project
    type Seen = Rc<RefCell<Vec<(bool, Option<bool>)>>>;
    let seen: Seen = Rc::default();
    let old: Rc<RefCell<Option<Entity<Workspace>>>> = Rc::default();
    let (s2, b2, o2) = (seen.clone(), b.dir.clone(), old.clone());
    v.cx.update(|_, cx| {
        let mut l = cx.global::<Launcher>().clone();
        l.on_open = Some(Rc::new(move |_, cx| {
            let quitting = vimstorm::shell::toolbar::quitting(&b2, cx);
            let exited = o2.borrow().as_ref().map(|ws: &Entity<Workspace>| {
                let e = ws.read(cx).editor().clone();
                e.update(cx, |e, _| e.nvim_mut().exited())
            });
            s2.borrow_mut().push((quitting, exited));
        }));
        cx.set_global(l);
    });

    // a -> b, close b (nothing to lose: no question), straight back to b while its nvim may
    // still be saving
    let open = format!(
        "require('config.app.toolbar').open_project('{}') return true",
        b.dir.display()
    );
    v.lua(&open);
    wait(&mut v, "b shown", |v| shown(v) == b.dir);
    let ws_b = v.active_project();
    wait_cwd(&mut v, &ws_b, &b.dir);
    v.wait_lua("b's config up", common::STARTED);
    *old.borrow_mut() = Some(ws_b.clone());
    v.lua("require('config.app.toolbar').close_project() return true");
    wait(&mut v, "a shown", |v| shown(v) == a.dir);
    let ws_a = v.active_project();
    v.use_project(&ws_a);
    v.lua(&open);
    wait(&mut v, "b shown again", |v| shown(v) == b.dir);
    let ws_b2 = v.active_project();
    assert_ne!(ws_b2, ws_b);
    wait_cwd(&mut v, &ws_b2, &b.dir);
    let seen = seen.borrow().clone();
    assert_eq!(
        seen[1],
        (false, Some(true)),
        "b's new nvim started after the old one quit: {seen:?}"
    );
}

/// The Close project dialog (P-17) is open, naming the unsaved buffer.
fn close_dialog(v: &mut View) -> bool {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| {
        p.dialog().is_some_and(|(id, _)| id == "close-project")
            && p.dialog_rows().iter().any(|r| r.contains("unsaved buffer"))
    })
}
