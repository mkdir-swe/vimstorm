//! Open projects in the one window (`vimstorm::shell::projects`): one nvim per project, only
//! the shown one drawn; switching away and back keeps everything (nvim, tabs, caret, terminal
//! shells, Git tool window, keyboard place); ⌘↑ / ⌘↓ walk the rail; Close Project quits that
//! nvim and drops its entities (asking when a terminal job runs); nvim quitting on its own closes
//! just its project; the last one quits the app; hidden projects don't poll.
// GPUI records debug selectors only with debug assertions.
#![cfg(debug_assertions)]

use crate::common;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::gitfix::git;
use common::gitui;
use common::terminal as term;
use common::view::View;
use gpui_kit::{Entity, Focusable as _, KeyDownEvent};
use rmpv::Value;
use vimstorm::shell::Workspace;
use vimstorm::shell::projects::{self, MAX_WORKTREES, SavedSet};

/// A private copy of a fixture (sessions / git state stay per test).
fn copy(name: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let out = std::process::Command::new("cp")
        .arg("-R")
        .arg(common::fixtures().join(name))
        .arg(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "cp {name}");
    (tmp, root.join(name))
}

fn dirs(v: &mut View) -> Vec<PathBuf> {
    v.pump();
    let p = v.projects.clone().unwrap();
    p.read_with(&v.cx, |p, _| p.dirs())
}

fn active_dir(v: &mut View) -> PathBuf {
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, _| ws.project().clone())
}

fn pid(v: &mut View, ws: &Entity<Workspace>) -> u32 {
    let e = ws.read_with(&v.cx, |ws, _| ws.editor().clone());
    e.update(&mut v.cx, |e, _| e.nvim_mut().pid())
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// A real app process (the binary): killed when the test ends, passed or not.
struct KillOnDrop(u32);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-9", &self.0.to_string()])
            .status();
    }
}

/// A Lua expression's value in the real app's nvim listening on `sock` (`--remote-expr`).
fn remote_lua(sock: &Path, code: &str) -> Option<String> {
    let out = std::process::Command::new("nvim")
        .arg("--server")
        .arg(sock)
        .arg("--remote-expr")
        .arg(format!("luaeval(\"{code}\")"))
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Polls `pred` (another process's state) until it holds; fails at `deadline`.
fn wait_remote(label: &str, deadline: Instant, mut pred: impl FnMut() -> bool) {
    while !pred() {
        assert!(Instant::now() < deadline, "timed out waiting for: {label}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `pid`'s nvim child processes (`pgrep -P`).
fn children(pid: u32) -> Vec<u32> {
    let out = std::process::Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .filter(|c: &u32| {
            let cmd = std::process::Command::new("ps")
                .args(["-o", "command=", "-p", &c.to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            cmd.trim_start().starts_with("nvim")
        })
        .collect()
}

/// Waits (pumping the UI) until `pred` holds; for conditions outside nvim's events (processes).
fn wait_real(v: &mut View, label: &str, mut pred: impl FnMut(&mut View) -> bool) {
    let deadline = Instant::now() + common::TIMEOUT;
    while !pred(v) {
        assert!(Instant::now() < deadline, "timed out: {label}");
        v.pump();
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// From the shown project (Lua's menu path): shows `dir`, opening it if needed; then the view's
/// helpers drive that project, once its config is up.
fn open_project(v: &mut View, dir: &Path) -> Entity<Workspace> {
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        dir.display()
    ));
    v.wait_until("project shown", |v| active_dir(v) == dir);
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_lua("nvim started", common::STARTED);
    v.wait_for("first frame", |e| e.ui().flushes > 0);
    v.settle();
    ws
}

/// Whether `ws`'s editor (or a surface inside it) has the keyboard, by name.
fn keyboard(v: &mut View, ws: &Entity<Workspace>) -> Option<&'static str> {
    v.pump();
    let ws = ws.clone();
    v.cx.update(|window, cx| {
        let w = ws.read(cx);
        if w.editor().read(cx).focus_handle(cx).is_focused(window) {
            return Some("editor");
        }
        if w.tree()
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
        {
            return Some("tree");
        }
        if w.terminal()
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
        {
            return Some("terminal");
        }
        if w.git()
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
        {
            return Some("git");
        }
        None
    })
}

fn caret(v: &View) -> Value {
    v.lua("return vim.api.nvim_win_get_cursor(0)")
}

#[test]
fn switching_away_and_back_keeps_the_project_running() {
    let (_a_tmp, a) = copy("proj");
    let (_b_tmp, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &["a.ts"]);
    let ws_a = v.active_project();
    let pid_a = pid(&mut v, &ws_a);
    // a second tab, the caret somewhere, a shell with output, the keyboard in the terminal
    v.lua("vim.cmd.edit('multi.txt') vim.api.nvim_win_set_cursor(0, { 3, 2 }) return true");
    let tabs = v.lua("return #require('config.editor_tabs').tabs()");
    let cur = caret(&v);
    term::open(&mut v);
    term::run(&mut v, "echo marker''-a");
    term::wait_line(&mut v, "marker-a");
    let shells = term::read(&mut v, |t, _| t.pids());
    assert_eq!(keyboard(&mut v, &ws_a), Some("terminal"));

    // b: a new nvim; a hidden, still running, its polls paused
    let ws_b = open_project(&mut v, &b);
    assert_ne!(ws_a, ws_b);
    assert_eq!(dirs(&mut v), [a.clone(), b.clone()]);
    assert!(alive(pid_a));
    assert!(!ws_a.read_with(&v.cx, |ws, _| ws.is_active()));
    let tree_a = ws_a.read_with(&v.cx, |ws, _| ws.tree().clone());
    assert!(
        !tree_a.read_with(&v.cx, |t, _| t.is_polling()),
        "hidden tree polls"
    );
    // b's Git tool window open with the keyboard, b's Chat hidden (⌘⌥2: the page keeps them)
    gitui::open_git(&mut v);
    assert_eq!(keyboard(&mut v, &ws_b), Some("git"));
    if v.cx
        .update(|_, cx| vimstorm::shell::column_state(cx).shown())
    {
        v.key("super+alt+digit_2");
    }
    v.wait_until("b's Git keeps the keyboard", |v| {
        keyboard(v, &ws_b) == Some("git")
    });

    // back with ⌘↑ (a is above b on the rail): the same nvim, tabs, caret, shell + scrollback, the
    // keyboard in the terminal
    let at = Instant::now();
    v.key("super+arrow_up");
    v.wait_until("a shown", |v| active_dir(v) == a);
    let took = at.elapsed();
    eprintln!(
        "switch back (test context): {:.1} ms",
        took.as_secs_f64() * 1000.
    );
    assert!(took < Duration::from_secs(1), "switch took {took:?}");
    v.use_project(&ws_a);
    assert_eq!(v.active_project(), ws_a);
    assert_eq!(pid(&mut v, &ws_a), pid_a);
    assert_eq!(v.lua("return #require('config.editor_tabs').tabs()"), tabs);
    assert_eq!(term::read(&mut v, |t, _| t.pids()), shells);
    assert!(shells.iter().all(|p| alive(*p)));
    assert!(
        term::all_lines(&mut v)
            .iter()
            .any(|l| l.contains("marker-a"))
    );
    // a never left by the rail: its Chat docked with the keys; hidden (⌘⌥2), its page has them
    v.key("super+alt+digit_2");
    v.wait_until("keyboard back in a's terminal", |v| {
        keyboard(v, &ws_a) == Some("terminal")
    });
    assert!(
        tree_a.read_with(&v.cx, |t, _| t.is_polling()),
        "shown tree polls again"
    );
    // nvim's own state: the caret where it was in the editor
    v.lua("require('config.focus').edit() return true");
    v.wait_lua(
        "caret kept",
        &format!(
            "local c = vim.api.nvim_win_get_cursor(0) return c[1] == {} and c[2] == {}",
            cur.as_array().unwrap()[0],
            cur.as_array().unwrap()[1]
        ),
    );

    // and b again (⌘↓): its Git tool window still open, with the keyboard
    v.key("super+arrow_down");
    v.wait_until("b shown", |v| active_dir(v) == b);
    v.use_project(&ws_b);
    assert!(v.read_ws(|ws, cx| ws.git().read(cx).is_open()));
    v.wait_until("keyboard back in b's Git", |v| {
        keyboard(v, &ws_b) == Some("git")
    });
}

#[test]
fn the_rail_and_the_menu_walk_the_projects_and_the_widget_lists_them_by_use() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    open_project(&mut v, &b);
    open_project(&mut v, &c);
    assert_eq!(dirs(&mut v), [a.clone(), b.clone(), c.clone()]);
    // up the rail: b, then a (Abe, the first main checkout)
    v.key("super+arrow_up");
    assert_eq!(active_dir(&mut v), b);
    v.key("super+arrow_up");
    assert_eq!(active_dir(&mut v), a);
    // the menu item does the same: down to b
    let ws = v.active_project();
    v.use_project(&ws);
    v.lua("require('config.app.toolbar').cycle_project(1) return true");
    v.wait_until("next", |v| active_dir(v) == b);
    // nvim never saw the keys (no <D-Up> mapping hit, no error)
    let ws = v.active_project();
    v.use_project(&ws);
    assert_eq!(v.mode(), "n");
    // Recent Projects / the project widget list the open ones first, this one on top
    let rows = open_rows(&mut v);
    assert_eq!(
        &rows[..3],
        [(b.clone(), true), (a.clone(), true), (c.clone(), true)]
    );
    assert!(rows[3..].iter().all(|(_, open)| !open));
}

/// The project widget's popup rows: (path, open), then closes it.
fn open_rows(v: &mut View) -> Vec<(PathBuf, bool)> {
    let tb = v.read_ws(|ws, _| ws.toolbar().clone());
    v.cx.update(|window, cx| tb.update(cx, |t, cx| t.open_projects(window, cx)));
    v.wait_until("popup", |v| {
        let tb = v.read_ws(|ws, _| ws.toolbar().clone());
        tb.read_with(&v.cx, |t, cx| !t.project_rows(cx).is_empty())
    });
    let rows = tb.read_with(&v.cx, |t, cx| t.project_rows(cx));
    v.keystrokes("escape");
    rows.into_iter().map(|p| (p.path, p.open)).collect()
}

#[test]
fn close_project_quits_its_nvim_and_drops_it() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_b = open_project(&mut v, &b);
    let ws_c = open_project(&mut v, &c);
    // most recently used: c, b, a; back to b, so closing it shows c
    v.key("super+arrow_up");
    assert_eq!(active_dir(&mut v), b);
    v.use_project(&ws_b);
    let pid_b = pid(&mut v, &ws_b);
    let shells = {
        term::open(&mut v);
        term::read(&mut v, |t, _| t.pids())
    };
    // a job running in b's terminal: asks first; Cancel keeps it
    term::run(&mut v, "sleep 300");
    wait_real(&mut v, "sleep started", |_| {
        shells.iter().any(|p| {
            std::process::Command::new("pgrep")
                .args(["-P", &p.to_string()])
                .output()
                .is_ok_and(|o| !o.stdout.is_empty())
        })
    });
    v.lua("require('config.app.toolbar').close_project() return true");
    v.wait_until("asked", |v| {
        dialog(v).is_some_and(|(id, _)| id == "close-project")
            && dialog_rows(v)
                .iter()
                .any(|r| r.contains("1 running terminal job"))
    });
    v.keystrokes("escape");
    v.wait_until("question gone", |v| dialog(v).is_none());
    v.settle();
    assert_eq!(dirs(&mut v).len(), 3);
    // Close: b goes, c (used last) shows; b's nvim quits, its shells close, its entities drop
    let weak_b = ws_b.downgrade();
    let tree_b = ws_b.read_with(&v.cx, |ws, _| ws.tree().downgrade());
    let term_b = ws_b.read_with(&v.cx, |ws, _| ws.terminal().downgrade());
    drop(ws_b);
    v.lua("require('config.app.toolbar').close_project() return true");
    v.wait_until("asked", |v| dialog(v).is_some());
    // ⏎ is Cancel (P-17); `y` closes
    v.keystrokes("y");
    v.wait_until("c shown", |v| active_dir(v) == c);
    assert_eq!(dirs(&mut v), [a.clone(), c.clone()]);
    v.use_project(&ws_c);
    wait_real(&mut v, "b's nvim quit", |_| !alive(pid_b));
    wait_real(&mut v, "b's shells closed", |_| {
        shells.iter().all(|p| !alive(*p))
    });
    wait_real(&mut v, "b's entities dropped", |v| {
        v.pump();
        weak_b.upgrade().is_none() && tree_b.upgrade().is_none() && term_b.upgrade().is_none()
    });
    // its session was saved (reopening it reads it)
    let state = v.lua("return vim.fn.stdpath('state')");
    let session = PathBuf::from(state.as_str().unwrap())
        .join("open-files")
        .join(format!("{}.json", b.display()).replace('/', "%"));
    assert!(session.is_file(), "b's session saved: {session:?}");
}

#[test]
fn nvim_quitting_closes_only_its_project_and_the_last_quits_the_app() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    let ws_b = open_project(&mut v, &b);
    open_project(&mut v, &c);
    // :qa in a hidden project (b): only b goes, c stays shown
    let rpc_b = ws_b.read_with(&v.cx, |ws, _| ws.rpc().clone());
    rpc_b.command("qa!");
    v.wait_until("b closed", |v| dirs(v).len() == 2);
    assert_eq!(dirs(&mut v), [a.clone(), c.clone()]);
    assert_eq!(active_dir(&mut v), c);
    // :qa in the shown one (c): a shows
    let ws = v.active_project();
    v.use_project(&ws);
    v.lua("vim.schedule(function() vim.cmd('qa!') end) return true");
    v.wait_until("c closed", |v| dirs(v) == [a.clone()]);
    assert_eq!(v.active_project(), ws_a);
    v.use_project(&ws_a);
    let p = v.projects.clone().unwrap();
    assert!(!p.read_with(&v.cx, |p, _| p.quitting()));
    // the last one: the app quits
    v.lua("vim.schedule(function() vim.cmd('qa!') end) return true");
    v.wait_until("app quits", |v| {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, _| p.quitting())
    });
}

#[test]
fn switching_to_an_open_project_from_the_popup_never_asks() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    // a buffer `wall` can't write: switching away loses nothing, so no question
    v.lua("vim.cmd.enew() vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'draft' }) return true");
    open_project(&mut v, &b);
    assert!(gitui::menu_rows(&mut v).is_none());
    // b -> a through the Recent Projects… popup (a listed, open: just shown)
    let rows = open_rows(&mut v);
    assert_eq!(rows[0], (b.clone(), true));
    assert_eq!(rows[1], (a.clone(), true));
    let tb = v.read_ws(|ws, _| ws.toolbar().clone());
    let to = a.clone();
    v.cx.update(|window, cx| tb.update(cx, |t, cx| t.open_project(to, false, window, cx)));
    v.wait_until("a shown", |v| active_dir(v) == a);
    v.use_project(&ws_a);
    assert_eq!(v.current_line(), "draft");
}

#[test]
fn a_window_resized_while_hidden_reaches_its_nvim_before_it_shows() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &["a.ts"]);
    let ws_a = v.active_project();
    let size_a = v.ui(|ui| ui.screen_size());
    open_project(&mut v, &b);
    // smaller while a is hidden: b follows, a doesn't know yet
    v.cx.simulate_resize(gpui_kit::size(gpui_kit::px(700.), gpui_kit::px(600.)));
    v.wait_for("b resized", |e| {
        e.ui().screen_size() != size_a && e.screen_matches()
    });
    let a_editor = ws_a.read_with(&v.cx, |ws, _| ws.editor().clone());
    assert_eq!(
        a_editor.read_with(&v.cx, |e, _| e.ui().screen_size()),
        size_a
    );
    // shown only once its nvim drew at the new size (no frame of old grids in the new layout)
    v.key("super+arrow_up");
    v.wait_until("a shown", |v| active_dir(v) == a);
    let (now, matches) =
        a_editor.read_with(&v.cx, |e, _| (e.ui().screen_size(), e.screen_matches()));
    assert!(matches && now != size_a, "a's nvim at {now:?} when shown");
}

#[test]
fn hidden_projects_get_focus_lost_and_keep_their_hands_off_the_keyboard() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &["a.ts"]);
    let ws_a = v.active_project();
    v.lua(
        "vim.g.lost, vim.g.gained = 0, 0 \
         vim.api.nvim_create_autocmd('FocusLost', { callback = function() vim.g.lost = vim.g.lost + 1 end }) \
         vim.api.nvim_create_autocmd('FocusGained', { callback = function() vim.g.gained = vim.g.gained + 1 end }) \
         return true",
    );
    let ws_b = open_project(&mut v, &b);
    v.use_project(&ws_a);
    v.wait_lua("a got FocusLost", "return vim.g.lost == 1");
    // a (hidden) asks for the tree: b's editor keeps the keyboard; a's tree gets it when shown
    v.lua("require('config.app').focus('tree') return true");
    v.settle();
    v.use_project(&ws_b);
    v.settle();
    assert_eq!(keyboard(&mut v, &ws_b), Some("editor"));
    assert_eq!(active_dir(&mut v), b);
    // (shown again from Recent Projects: no rail move, whose landing is Chat's)
    let to = a.clone();
    v.cx.update(move |window, cx| projects::switch_to(to, window, cx));
    v.wait_until("a shown", |v| active_dir(v) == a);
    v.use_project(&ws_a);
    v.wait_lua("a got FocusGained", "return vim.g.gained == 1");
    v.wait_until("a's tree has the keyboard", |v| {
        keyboard(v, &ws_a) == Some("tree")
    });
}

#[test]
fn open_path_shows_or_opens_the_project_with_the_file() {
    use vimstorm::shell::projects::{self, OpenRequest};
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    // a new project, with a file: its nvim starts on it
    let file_b = std::fs::read_dir(&b)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file() && !p.file_name().unwrap().to_string_lossy().starts_with('.'))
        .unwrap();
    let req = OpenRequest {
        dir: b.clone(),
        file: Some(file_b.clone()),
    };
    v.cx.cx.update(|cx| projects::open_path(req, cx)).unwrap();
    v.wait_until("b shown", |v| active_dir(v) == b);
    let ws_b = v.active_project();
    v.use_project(&ws_b);
    v.wait_lua(
        "b's file open",
        &format!(
            "return vim.api.nvim_buf_get_name(0) == '{}'",
            file_b.display()
        ),
    );
    let open = v.cx.update(|_, cx| projects::open_dirs(cx));
    assert_eq!(open, [a.clone(), b.clone()]);
    // an open project, with a file: shown, the file opened in its editor with the keyboard
    let req = OpenRequest {
        dir: a.clone(),
        file: Some(a.join("b.ts")),
    };
    v.cx.cx.update(|cx| projects::open_path(req, cx)).unwrap();
    v.wait_until("a shown", |v| active_dir(v) == a);
    v.use_project(&ws_a);
    v.wait_lua("b.ts open in a", "return vim.fn.expand('%:t') == 'b.ts'");
    assert_eq!(keyboard(&mut v, &ws_a), Some("editor"));
    // not a folder: refused
    let req = OpenRequest {
        dir: a.join("nope"),
        file: None,
    };
    assert!(v.cx.cx.update(|cx| projects::open_path(req, cx)).is_err());
    assert!(v.cx.update(|_, cx| projects::window(cx)).is_some());
}

/// The app binary: quitting it (a signal) saves and quits every open project's nvim.
#[test]
fn app_quit_saves_every_open_project() {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-projects-")
        .tempdir()
        .unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let dirs: Vec<PathBuf> = ["a", "b", "c"].iter().map(|n| root.join(n)).collect();
    for d in &dirs {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("package.json"), "{}\n").unwrap();
    }
    let sock = root.join("nvim.sock");
    let state = root.join("state");
    let mut app = std::process::Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .arg(&dirs[0])
        .env("VIMSTORM_NO_INSTANCE", "1")
        .env("VIMSTORM_LISTEN", &sock)
        .env("XDG_STATE_HOME", &state)
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", common::data_home())
        .env("VIMSTORM_WINDOW_SIZE", "800x600")
        // never in front of what you're doing
        .env("VIMSTORM_BACKGROUND", "1")
        // each project's "editor flush" mark: its config is up (a session is saved only then)
        .env("VIMSTORM_TIMING", "1")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let editors = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        use std::io::BufRead as _;
        let (stderr, editors) = (app.stderr.take().unwrap(), editors.clone());
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                if line.contains("editor flush") {
                    editors.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        });
    }
    let _guard = KillOnDrop(app.id());
    let lua = |code: &str| remote_lua(&sock, code);
    let deadline = Instant::now() + common::TIMEOUT;
    wait_remote("app's nvim up", deadline, || {
        lua("vim.v.vim_did_enter").as_deref() == Some("1")
    });
    for d in &dirs[1..] {
        lua(&format!(
            "require('config.app.toolbar').open_project('{}')",
            d.display()
        ));
    }
    while children(app.id()).len() < 3 {
        assert!(
            Instant::now() < deadline,
            "3 nvims: {:?}",
            children(app.id())
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let nvims = children(app.id());
    while editors.load(std::sync::atomic::Ordering::SeqCst) < 3 {
        assert!(Instant::now() < deadline, "3 editors up");
        std::thread::sleep(Duration::from_millis(20));
    }
    std::process::Command::new("kill")
        .args(["-TERM", &app.id().to_string()])
        .status()
        .unwrap();
    let deadline = Instant::now() + common::TIMEOUT;
    while app.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "app quit");
        std::thread::sleep(Duration::from_millis(50));
    }
    for d in &dirs {
        let session = state
            .join("vimstorm/open-files")
            .join(format!("{}.json", d.display()).replace('/', "%"));
        assert!(session.is_file(), "session saved: {session:?}");
    }
    assert!(nvims.iter().all(|p| !alive(*p)), "every nvim quit");
}

/// The open projects set as saved (`<state>/vimstorm/open-projects.json`).
fn saved_set(v: &View) -> Option<vimstorm::shell::projects::SavedSet> {
    vimstorm::shell::projects::SavedSet::load(Some(&v.state_home()))
}

#[test]
fn the_open_projects_are_remembered_and_reopened_lazily() {
    use vimstorm::shell::projects::SavedSet;
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    open_project(&mut v, &b);
    open_project(&mut v, &c);
    v.key("super+arrow_up");
    let want = SavedSet {
        open: vec![a.clone(), b.clone(), c.clone()],
        active: Some(b.clone()),
    };
    wait_real(&mut v, "set saved", |v| {
        saved_set(v).as_ref() == Some(&want)
    });
    drop(v);

    // a launch without a path: all three open, b shown and running, a and c not started yet
    let at = Instant::now();
    let mut v = View::start_projects_restored(want.clone());
    eprintln!(
        "restored start (b running, a / c lazy): {:.0} ms",
        at.elapsed().as_secs_f64() * 1000.
    );
    let p = v.projects.clone().unwrap();
    assert_eq!(dirs(&mut v), [a.clone(), b.clone(), c.clone()]);
    assert_eq!(active_dir(&mut v), b);
    let running = |v: &mut View, d: &Path| {
        v.pump();
        p.read_with(&v.cx, |p, _| p.is_running(d))
    };
    assert!(running(&mut v, &b) && !running(&mut v, &a) && !running(&mut v, &c));
    // the popups list them all as open
    let rows = open_rows(&mut v);
    assert!(rows[..3].iter().all(|(_, open)| *open), "{rows:?}");
    // first shown: c starts now (⌘↓, the rail in open order)
    let at = Instant::now();
    v.key("super+arrow_down");
    eprintln!(
        "lazy start of c on the UI thread (key + start + show): {:.1} ms",
        at.elapsed().as_secs_f64() * 1000.
    );
    v.wait_until("c shown", |v| active_dir(v) == c);
    let ws_c = v.active_project();
    v.use_project(&ws_c);
    v.wait_lua("c's nvim up", common::STARTED);
    eprintln!(
        "lazy start of c to its config up: {:.0} ms",
        at.elapsed().as_secs_f64() * 1000.
    );
    assert!(running(&mut v, &c) && !running(&mut v, &a));
    v.settle();
    let rss = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid(&mut v, &ws_c).to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    eprintln!("c's idle nvim: {rss} KB RSS");
    // the set follows (c shown now); a stays in it though it never ran
    let want = SavedSet {
        active: Some(c.clone()),
        ..want
    };
    wait_real(&mut v, "set saved", |v| {
        saved_set(v).as_ref() == Some(&want)
    });
}

#[test]
fn a_hidden_projects_balloons_wait_and_its_menus_are_dropped() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    let ws_b = open_project(&mut v, &b);
    // a (hidden): a Rust surface's balloon (a git result after a switch) and a Lua one
    let scx_a = ws_a.read_with(&v.cx, |ws, cx| ws.annotate().read(cx).scx().clone());
    v.cx.update(|window, cx| {
        scx_a.notify(
            vimstorm::popups::Balloon::info("Git", "Pushed to origin/main"),
            window,
            cx,
        )
    });
    v.use_project(&ws_a);
    v.lua("vim.notify('from a', vim.log.levels.WARN) return true");
    // a menu in a: answered "cancelled", never shown
    v.lua(
        "vim.g.choice = 'waiting' \
         vim.ui.select({ 'One', 'Two' }, {}, function(c) vim.g.choice = c or 'cancelled' end) \
         return true",
    );
    v.wait_lua("a's menu cancelled", "return vim.g.choice == 'cancelled'");
    v.use_project(&ws_b);
    v.settle();
    assert!(gitui::balloons(&mut v).is_empty(), "b shows a's balloons");
    assert!(gitui::menu_rows(&mut v).is_none(), "b shows a's menu");
    // shown again: a's balloons are there
    v.key("super+arrow_up");
    v.wait_until("a shown", |v| active_dir(v) == a);
    v.use_project(&ws_a);
    v.wait_until("a's balloons", |v| {
        gitui::has_balloon(v, "Pushed to origin/main") && gitui::has_balloon(v, "from a")
    });
    assert!(gitui::menu_rows(&mut v).is_none());
}

/// The app binary launched without a path from LaunchServices (cwd `/`, as the Dock / Finder
/// start it): reopens the projects open at the last quit, the shown one running, the other
/// started only when shown.
#[test]
fn a_launch_without_a_path_reopens_the_last_projects() {
    use vimstorm::shell::projects::SavedSet;
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-reopen-")
        .tempdir()
        .unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (a, b) = (root.join("a"), root.join("b"));
    for d in [&a, &b] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("package.json"), "{}\n").unwrap();
    }
    let state = root.join("state");
    let set = SavedSet {
        open: vec![a.clone(), b.clone()],
        active: Some(b.clone()),
    };
    std::fs::create_dir_all(state.join("vimstorm")).unwrap();
    std::fs::write(
        state.join("vimstorm/open-projects.json"),
        serde_json::to_string(&set).unwrap(),
    )
    .unwrap();
    let sock = root.join("nvim.sock");
    let mut app = std::process::Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .current_dir("/")
        .env("VIMSTORM_NO_INSTANCE", "1")
        .env("VIMSTORM_BACKGROUND", "1")
        .env("VIMSTORM_LISTEN", &sock)
        .env("XDG_STATE_HOME", &state)
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", common::data_home())
        .env("VIMSTORM_WINDOW_SIZE", "800x600")
        .spawn()
        .unwrap();
    let _guard = KillOnDrop(app.id());
    let lua = |code: &str| remote_lua(&sock, code);
    let deadline = Instant::now() + common::TIMEOUT;
    wait_remote("app's nvim up", deadline, || {
        lua("vim.v.vim_did_enter").as_deref() == Some("1")
    });
    // the first nvim runs b (the one shown at the last quit); a waits for its first show
    assert_eq!(lua("vim.fn.getcwd()").as_deref(), b.to_str());
    assert_eq!(children(app.id()).len(), 1, "one nvim");
    std::process::Command::new("kill")
        .args(["-TERM", &app.id().to_string()])
        .status()
        .unwrap();
    while app.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "app quit");
        std::thread::sleep(Duration::from_millis(50));
    }
    // the set is kept for the next launch (a still in it)
    assert_eq!(SavedSet::load(Some(&state)), Some(set));
}

#[test]
fn cmd_q_closes_the_project_and_shows_the_next_one_the_last_quits() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    let ws_a = v.active_project();
    open_project(&mut v, &b);
    open_project(&mut v, &c);
    // b shown, a used just before it: Cmd+Q shows c (next on the rail), not a (MRU)
    v.key("super+arrow_up");
    v.key("super+arrow_up");
    v.key("super+arrow_down");
    assert_eq!(active_dir(&mut v), b);
    let ws = v.active_project();
    v.use_project(&ws);
    v.key("super+q");
    v.wait_until("c shown", |v| active_dir(v) == c);
    assert_eq!(dirs(&mut v), [a.clone(), c.clone()]);
    // from a tool window too (before the surface sees it); the last in order wraps to the first
    let ws = v.active_project();
    v.use_project(&ws);
    term::open(&mut v);
    v.key("super+q");
    v.wait_until("a shown", |v| active_dir(v) == a);
    assert_eq!(dirs(&mut v), std::slice::from_ref(&a));
    // the last one, with work that would be lost: asks; Cancel keeps it, Close quits the app
    v.use_project(&ws_a);
    v.lua("vim.cmd.enew() vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'draft' }) return true");
    v.key("super+q");
    v.wait_until("asked", |v| {
        dialog_rows(v)
            .iter()
            .any(|r| r.contains("1 unsaved buffer"))
    });
    v.keystrokes("escape");
    v.wait_until("question gone", |v| dialog(v).is_none());
    let p = v.projects.clone().unwrap();
    assert!(!p.read_with(&v.cx, |p, _| p.quitting()));
    v.key("super+q");
    v.wait_until("asked again", |v| dialog(v).is_some());
    // ⏎ is Cancel (P-17); `y` closes
    v.keystrokes("y");
    v.wait_until("app quits", |v| {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, _| p.quitting())
    });
}

/// The app binary on one project `a`, stderr nowhere as a Dock launch has it: `ends` (Lua, in
/// its nvim) ends it; it quits, its session saved by its nvim's quit, its log's one exit line
///  returned with `a`.
fn last_project_ends(ends: &str) -> (String, PathBuf) {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-last-")
        .tempdir()
        .unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let a = root.join("a");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::write(a.join("package.json"), "{}\n").unwrap();
    let state = root.join("state");
    let sock = root.join("nvim.sock");
    let log = root.join("vimstorm.log");
    let mut app = std::process::Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .arg(&a)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env("VIMSTORM_LOG", &log)
        .env("VIMSTORM_NO_INSTANCE", "1")
        .env("VIMSTORM_BACKGROUND", "1")
        .env("VIMSTORM_LISTEN", &sock)
        .env("XDG_STATE_HOME", &state)
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", root.join("config"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_DATA_HOME", common::data_home())
        .env("VIMSTORM_WINDOW_SIZE", "800x600")
        .spawn()
        .unwrap();
    let _guard = KillOnDrop(app.id());
    let lua = |code: &str| remote_lua(&sock, code);
    let deadline = Instant::now() + common::TIMEOUT;
    // (the config up: VimEnter, lazy's VeryLazy)
    while lua("vim.v.vim_did_enter == 1 and package.loaded['config.app'] and 1 or 0").as_deref()
        != Some("1")
    {
        assert!(Instant::now() < deadline, "app's config up");
        std::thread::sleep(Duration::from_millis(50));
    }
    lua(ends);
    while app.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "app quit");
        std::thread::sleep(Duration::from_millis(50));
    }
    let session = state
        .join("vimstorm/open-files")
        .join(format!("{}.json", a.display()).replace('/', "%"));
    assert!(session.is_file(), "session saved: {session:?}");
    let said = std::fs::read_to_string(&log).unwrap_or_default();
    let exits: Vec<&str> = said.lines().filter(|l| l.contains("] exit: ")).collect();
    assert_eq!(exits.len(), 1, "one exit line: {said}");
    let exit = exits[0]
        .split_once("] ")
        .map(|(_, e)| e.to_owned())
        .unwrap();
    (exit, a)
}

/// A way the last project ends: its name, the Lua that ends it, the exit line for project `a`.
type LastEnd = (&'static str, &'static str, fn(&Path) -> String);

/// The app binary: the last project ending quits it, and the log says why.
const LAST_ENDS: &[LastEnd] = &[
    (
        "Close Project on the last project",
        "require('config.app.toolbar').close_project()",
        |a| format!("exit: the last open project closed ({})", a.display()),
    ),
    (
        "the last nvim quitting on its own (`:qa`, a crash)",
        "vim.schedule(function() vim.cmd('qa!') end)",
        |a| format!("exit: nvim of {} exited", a.display()),
    ),
];

#[test]
fn the_last_project_ending_quits_the_app_and_logs_why() {
    for (name, ends, want) in LAST_ENDS {
        let (exit, a) = last_project_ends(ends);
        assert_eq!(exit, want(&a), "{name}");
    }
}

#[test]
fn app_menu_quit_asks_once_for_every_project_then_quits() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    // a hidden project with a draft `wall` can't write
    v.lua("vim.cmd.enew() vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'draft' }) return true");
    open_project(&mut v, &b);
    let quit = |v: &mut View| v.cx.update(vimstorm::shell::projects::quit);
    quit(&mut v);
    v.wait_until("asked", |v| {
        dialog(v).is_some_and(|(id, t)| id == "quit-app" && t == "Quit VimStorm?")
            && dialog_rows(v)
                .iter()
                .any(|r| r.contains("1 unsaved buffer"))
    });
    v.keystrokes("escape");
    v.wait_until("question gone", |v| dialog(v).is_none());
    let p = v.projects.clone().unwrap();
    assert!(!p.read_with(&v.cx, |p, _| p.quitting()));
    assert_eq!(dirs(&mut v).len(), 2, "nothing closed");
    quit(&mut v);
    v.wait_until("asked again", |v| dialog(v).is_some());
    v.keystrokes("y");
    v.wait_until("app quits", |v| {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, _| p.quitting())
    });
}

/// A copy of fixture `name` renamed to `to` (a name no other recent project matches).
fn renamed(name: &str, to: &str) -> (tempfile::TempDir, PathBuf) {
    let (t, dir) = copy(name);
    let new = dir.with_file_name(to);
    std::fs::rename(&dir, &new).unwrap();
    (t, new)
}

/// Listed as a recent project (a saved session in the view's state dir).
fn recent(v: &View, dir: &Path) {
    let state = v.lua("return vim.fn.stdpath('state')");
    let sessions = PathBuf::from(state.as_str().unwrap()).join("open-files");
    std::fs::create_dir_all(&sessions).unwrap();
    let name = format!("{}.json", dir.display()).replace('/', "%");
    std::fs::write(sessions.join(name), r#"{"files":[]}"#).unwrap();
}

/// Recent Projects (Cmd+Shift+O), `query` typed, its first row picked with `key`.
fn recent_projects_pick(v: &mut View, query: &str, key: &str) {
    v.key("super+shift+o");
    v.wait_until("Recent Projects open", |v| {
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
            .is_some_and(|s| s.kind == "projects" && s.settled)
    });
    v.wait_lua("nvim answered the picker", "return true");
    for c in query.chars() {
        v.key(&c.to_string());
    }
    v.wait_until("the picker settled on the query", |v| {
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
            .is_some_and(|s| {
                s.kind == "projects" && s.query == query && s.settled && !s.rows.is_empty()
            })
    });
    v.key(key);
}

#[test]
fn recent_projects_enter_opens_in_place_shift_enter_alongside() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = renamed("grepo", "zzalong");
    let (_t3, c) = renamed("stree", "yyplace");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    recent(&v, &b);
    recent(&v, &c);
    // Shift+Enter: alongside (one more open project)
    recent_projects_pick(&mut v, "zza", "shift+enter");
    v.wait_until("b shown", |v| active_dir(v) == b);
    assert_eq!(dirs(&mut v), [a.clone(), b.clone()]);
    let ws_b = v.active_project();
    v.use_project(&ws_b);
    v.wait_lua("b's config up", common::STARTED);
    // Enter: in place of b (nothing to lose: no question), same count, b's nvim quits
    let pid_b = pid(&mut v, &ws_b);
    recent_projects_pick(&mut v, "yyp", "enter");
    v.wait_until("c shown", |v| active_dir(v) == c);
    assert_eq!(dirs(&mut v), [a.clone(), c.clone()]);
    wait_real(&mut v, "b's nvim gone", |_| !alive(pid_b));
}

/// With no `abe`, each of its entries says how to install it in one line and the keyboard stays
/// where it was: ⌃⌘O, the strip's `+`, File › Workspaces… and `:`. The editor's `:` is then
/// Neovim's own command line; the tree's keeps the keyboard in the tree.
#[test]
fn without_abe_its_entries_say_how_to_install_it_and_keep_the_keyboard() {
    let (_tmp, dir) = copy("proj");
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let ws = v.active_project();
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    v.focus_code();
    v.wait_until("editor focused", |v| keyboard(v, &ws) == Some("editor"));
    let origin = v.cx.update(|window, cx| window.focused(cx)).unwrap();
    let said = |v: &mut View| {
        gitui::balloons(v)
            .iter()
            .filter(|(_, b)| b == vimstorm::shell::projects::NO_ABE)
            .count()
    };
    let plus = gitui::bounds(&mut v, "rail-new").unwrap();
    v.click(gpui_kit::MouseButton::Left, plus.center());
    v.wait_until("the rail's + says so", |v| said(v) == 1);
    v.cx.update(|window, cx| {
        window.dispatch_action(Box::new(vimstorm::app::Workspaces), cx);
    });
    v.wait_until("File › New Workspace… says so", |v| said(v) == 2);
    assert!(v.cx.update(|window, _| origin.is_focused(window)));
    assert_eq!(dirs(&mut v), [dir]);

    // `:` in the editor: says so, then Neovim's command line
    gitui::wait_target(&mut v, "split");
    v.keystrokes(":");
    v.wait_until("`:` says so", |v| said(v) == 3);
    v.wait_until("Neovim command line", |v| v.mode() == "c");
    v.key("escape");
    v.wait_until("normal mode", |v| v.mode() == "n");

    // `:` in the tree: the tree keeps the keyboard
    v.key("super+1");
    gitui::wait_target(&mut v, "tree");
    v.wait_until("the tree has the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus()) == Some("tree")
    });
    let origin =
        v.cx.update(|window, cx| window.focused(cx))
            .expect("native focus");
    v.keystrokes(":");
    v.settle();
    assert!(
        v.cx.update(|window, _| origin.is_focused(window)),
        "the tree keeps the keyboard"
    );
    assert_eq!(v.mode(), "n", "Neovim's command line stays shut");
}

/// The Settings dialog is up (the bridge's layer; here its serve-down tree: no `abe`).
fn settings_up(v: &mut View) -> bool {
    v.pump();
    v.cx.update(|_, cx| vimstorm::factory::settings_up(cx))
}

/// Design T-Appearance: ⌘, opens Settings as a 1040 × 700 dialog centred over whatever
/// is shown, the editor too; its keys are its own, Esc closes it and the keyboard goes back.
#[test]
fn cmd_comma_opens_settings_as_a_centred_dialog_and_esc_gives_the_keyboard_back() {
    let (_tmp, dir) = copy("grepo");
    let mut v = View::start_projects(dir.to_str().unwrap(), &["blame.ts"]);
    v.focus_code();
    gitui::wait_target(&mut v, "split");
    let origin =
        v.cx.update(|window, cx| window.focused(cx))
            .expect("the editor's focus");
    v.key("super+,");
    v.wait_until("the Settings dialog", |v| {
        settings_up(v) && gitui::bounds(v, "factory-settings").is_some()
    });
    let b = gitui::bounds(&mut v, "factory-settings").expect("drawn");
    let viewport = v.cx.update(|window, _| window.viewport_size());
    let left = b.origin.x.as_f32();
    let right = viewport.width.as_f32() - (b.origin.x + b.size.width).as_f32();
    assert!((left - right).abs() <= 1., "centred: {left} / {right}");
    let top = b.origin.y.as_f32();
    let bottom = viewport.height.as_f32() - (b.origin.y + b.size.height).as_f32();
    assert!((top - bottom).abs() <= 1., "centred: {top} / {bottom}");
    assert!(gitui::bounds(&mut v, "factory-settings-footer").is_some());
    // the dialog's keys: ↓ moves nothing of the editor's
    let line = v.current_line();
    v.key("arrow_down");
    v.settle();
    assert_eq!(v.current_line(), line);
    v.key("escape");
    v.wait_until("closed", |v| !settings_up(v));
    v.wait_until("the keyboard back", |v| {
        v.cx.update(|window, _| origin.is_focused(window))
    });
}

fn dialog(v: &mut View) -> Option<(&'static str, String)> {
    let p = gitui::popups(v);
    v.pump();
    p.read_with(&v.cx, |p, _| p.dialog())
}

fn dialog_rows(v: &mut View) -> Vec<String> {
    let p = gitui::popups(v);
    v.pump();
    p.read_with(&v.cx, |p, _| p.dialog_rows())
}

/// A worktree of a private `grepo` on branch `abe/AB-1240-checkout-copy`, beside it.
fn worktree() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let (tmp, main) = copy("grepo");
    let wt = main.parent().unwrap().join("grepo-AB-1240");
    let out = std::process::Command::new("git")
        .args(["worktree", "add", "-q", "-b", "abe/AB-1240-checkout-copy"])
        .arg(&wt)
        .current_dir(&main)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    (tmp, main, wt)
}

/// The rail tile of the open workspace at `dir` (its real folder).
fn tile(v: &mut View, dir: &Path) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    let real = dir.canonicalize().unwrap();
    gitui::bounds(v, &format!("rail-tile-{}", real.display()))
        .unwrap_or_else(|| panic!("{} on the rail", real.display()))
}

#[test]
fn a_tiles_menu_keeps_delete_apart_from_close_and_abe_has_neither() {
    let (_tmp, main, wt) = worktree();
    let mut v = View::start_projects(main.to_str().unwrap(), &[]);
    open_project(&mut v, &wt);
    let at = tile(&mut v, &wt);
    v.click(gpui_kit::MouseButton::Right, at.center());
    v.wait_until("the tile's menu", |v| gitui::menu_rows(v).is_some());
    let rows = gitui::menu_rows(&mut v).unwrap();
    for want in [
        "Open in Finder",
        "Delete Working Files…",
        "Close the workspace",
    ] {
        assert!(rows.iter().any(|r| r.contains(want)), "{want} in {rows:?}");
    }
    for gone in ["Hide", "Instructions…", "Stop Agent…", "Archive…"] {
        assert!(!rows.iter().any(|r| r.contains(gone)), "{gone} in {rows:?}");
    }
    let at = |r: &[String], w: &str| r.iter().position(|l| l.contains(w)).unwrap();
    assert!(at(&rows, "Close the workspace") > at(&rows, "Delete Working Files…"));
    v.key("escape");
    v.wait_until("closed", |v| gitui::menu_rows(v).is_none());
    // Abe (the main checkout) never closes: both rows grey there
    let at = tile(&mut v, &main);
    v.click(gpui_kit::MouseButton::Right, at.center());
    v.wait_until("Abe's menu", |v| gitui::menu_rows(v).is_some());
    let rows = gitui::menu_rows(&mut v).unwrap();
    let popups = gitui::popups(&mut v);
    let can = |v: &mut View, w: &str| {
        let ix = rows.iter().position(|l| l.contains(w)).unwrap();
        popups.read_with(&v.cx, |p, _| p.menu_row_selectable(ix))
    };
    assert_eq!(can(&mut v, "Open in Finder"), Some(true), "{rows:?}");
    for grey in ["Delete Working Files…", "Close the workspace"] {
        assert_eq!(can(&mut v, grey), Some(false), "{grey} in {rows:?}");
    }
    v.key("escape");
    assert_eq!(dirs(&mut v), [main.clone(), wt.clone()]);
}

#[test]
fn the_main_checkout_is_first_on_the_rail_and_closes_last() {
    let (_tmp, main, wt) = worktree();
    let mut v = View::start_projects(wt.to_str().unwrap(), &[]);
    open_project(&mut v, &main);
    // opened second, drawn first
    assert_eq!(dirs(&mut v).len(), 2);
    assert!(tile(&mut v, &main).top() < tile(&mut v, &wt).top());
    assert_eq!(active_dir(&mut v), main);
    // ⌘Q on it while its worktree is open: nothing closes, the status line says how to quit
    let ws = v.active_project();
    v.use_project(&ws);
    v.key("super+q");
    v.wait_until("said", |v| {
        v.cx.update(|_, cx| {
            cx.try_global::<vimstorm::factory::FactoryShell>()
                .and_then(|s| s.status.clone())
                .is_some_and(|s| s == projects::MAIN_STAYS)
        })
    });
    v.settle();
    assert_eq!(dirs(&mut v).len(), 2);
    assert_eq!(active_dir(&mut v), main);
    // the worktree closed: the main checkout is the last, ⌘Q closes it (the app quits)
    let to = wt.clone();
    v.cx.update(move |window, cx| projects::switch_to(to, window, cx));
    v.wait_until("the worktree shown", |v| active_dir(v) == wt);
    let ws = v.active_project();
    v.use_project(&ws);
    v.key("super+q");
    v.wait_until("the main checkout alone", |v| dirs(v) == [main.clone()]);
    let ws = v.active_project();
    v.use_project(&ws);
    v.key("super+q");
    v.wait_until("app quits", |v| {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, _| p.quitting())
    });
}

#[test]
fn delete_working_files_lists_what_is_lost_cancel_keeps_them_and_d_deletes() {
    let (_tmp, main, wt) = worktree();
    let mut v = View::start_projects(main.to_str().unwrap(), &[]);
    let ws = open_project(&mut v, &wt);
    v.use_project(&ws);
    std::fs::write(wt.join("notes.md"), "lost\n").unwrap();
    let open_delete = |v: &mut View| {
        let at = tile(v, &wt);
        v.click(gpui_kit::MouseButton::Right, at.center());
        gitui::pick_menu(v, "Delete Working Files…");
        v.wait_until("Delete working files?", |v| {
            dialog(v).is_some_and(|(id, _)| id == "delete-working-files")
        });
    };
    open_delete(&mut v);
    let rows = dialog_rows(&mut v);
    assert!(
        rows.iter()
            .any(|r| r == "Uncommitted changes: notes.md · ?"),
        "{rows:?}"
    );
    // ⏎ is Cancel
    v.keystrokes("enter");
    v.wait_until("closed", |v| dialog(v).is_none());
    assert!(wt.join("notes.md").exists());
    open_delete(&mut v);
    v.keystrokes("d");
    v.wait_until("the worktree's files deleted", |_| !wt.exists());
    v.wait_until("its project closed", |v| dirs(v) == [main.clone()]);
    // its branch stays (Also delete branch was off)
    let branches = std::process::Command::new("git")
        .args(["branch", "--list", "abe/AB-1240-checkout-copy"])
        .current_dir(&main)
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&branches.stdout).trim().is_empty());
}

#[test]
fn the_feel_reaches_every_projects_nvim_and_a_new_one_at_start() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    // VimStorm until the bridge says
    v.wait_lua(
        "VimStorm's tab limit",
        "return require('config.feel').tabs_limit() == 10",
    );
    v.set_feel(|f| {
        f.feel = vimstorm::factory::FeelName::Vscode;
        f.tabs.limit = None;
        f.files.auto_save = vimstorm::factory::AutoSave::Off;
        // your keys ride along, nvim binds them
        f.keys = vec![vimstorm::factory::KeyBind {
            key: "⌘Y".into(),
            action: "goToFile".into(),
            lhs: vec!["<D-y>".into()],
            does: "<D-o>".into(),
        }];
    });
    v.wait_lua(
        "the shown project's nvim has the Feel",
        "local f = require('config.feel') return f.tabs_limit() == nil and f.auto_save() == 'off'",
    );
    v.wait_lua(
        "...and your ⌘Y bound to Go to File",
        "return vim.fn.maparg('<D-y>', 'n', false, true).desc == 'goToFile (yours: ⌘Y)'",
    );
    // a project opened after it gets it when its nvim starts
    open_project(&mut v, &b);
    v.wait_lua(
        "the new project's nvim has it too",
        "local f = require('config.feel') return f.tabs_limit() == nil and f.auto_save() == 'off'",
    );
}

/// Vim mode off (the Feel's `editor.vim` false): the file types at once, Esc stays typing,
/// ⇧→ selects to type over, and the status bar names no mode; Vim mode on is Normal mode again.
#[test]
fn vim_mode_off_types_at_once_and_the_status_bar_names_no_mode() {
    use vimstorm::factory::FeelName;
    let (_t, a) = copy("proj");
    let mut v = View::start_projects(a.to_str().unwrap(), &["multi.txt"]);
    v.wait_screen("alpha one");
    let segment = |v: &mut View| v.read_ws(|ws, cx| ws.statusbar().read(cx).segment_text(cx));
    assert_eq!(segment(&mut v), "VIMSTORM · NORMAL");
    v.set_feel(|f| {
        f.feel = FeelName::Webstorm;
        f.editor.vim = false;
    });
    v.wait_lua(
        "typing at once",
        "return vim.api.nvim_get_mode().mode == 'i'",
    );
    v.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 }) return true");
    for key in ["q", "k", "escape", "x"] {
        v.key(key);
    }
    v.wait_lua(
        "letters type, Esc stays typing",
        "return vim.api.nvim_get_current_line():sub(1, 3) == 'qkx' and vim.api.nvim_get_mode().mode == 'i'",
    );
    v.wait_screen("qkxalpha one");
    assert_eq!(segment(&mut v), "VIMSTORM");
    for key in [
        "shift+arrow_right",
        "shift+arrow_right",
        "shift+arrow_right",
        "z",
    ] {
        v.key(key);
    }
    v.wait_lua(
        "⇧→ selected 'alp', z typed over it",
        "return vim.api.nvim_get_current_line() == 'qkxzha one'",
    );
    v.set_feel(|_| {});
    v.wait_lua(
        "Vim mode on: Normal mode",
        "return vim.api.nvim_get_mode().mode == 'n'",
    );
    v.wait_until("the mode named again", |v| {
        segment(v) == "VIMSTORM · NORMAL"
    });
}

/// Lua's menu path without waiting: asks to show `dir`, opening it if needed.
fn ask_open(v: &mut View, dir: &Path) {
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        dir.display()
    ));
}

/// Welcome is shown, no project open.
pub(crate) fn welcome_shown(v: &mut View) -> bool {
    let p = v.projects.clone().unwrap();
    p.read_with(&v.cx, |p, _| p.welcome_shown() && p.dirs().is_empty())
}

/// Cmd+Q as macOS sends it, `held`: an auto-repeat of the key held down.
fn cmd_q(v: &mut View, held: bool) {
    let keystroke = vimstorm::editor::input::keystroke("super+q").unwrap();
    v.cx.update(|window, cx| {
        window.dispatch_event(
            gpui_kit::PlatformInput::KeyDown(KeyDownEvent {
                keystroke,
                is_held: held,
                prefer_character_input: false,
            }),
            cx,
        );
    });
}

/// A main checkout `app` on master with one commit.
fn main_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().canonicalize().unwrap().join("app");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "master"]);
    std::fs::write(main.join("a.ts"), "export const a = 1;\n").unwrap();
    git(&main, &["add", "-A"]);
    git(
        &main,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@x",
            "commit",
            "-q",
            "-m",
            "AB#1 a",
        ],
    );
    (tmp, main)
}

#[test]
fn a_symlinked_path_opens_the_same_project() {
    let (tmp, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let link = tmp.path().join("link-to-proj");
    std::os::unix::fs::symlink(&a, &link).unwrap();
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    open_project(&mut v, &b);
    // the link from Recent Projects: a is shown again, no second nvim on its folder
    ask_open(&mut v, &link);
    v.wait_until("a shown again", |v| active_dir(v) == a);
    assert_eq!(dirs(&mut v), [a.clone(), b.clone()]);
    // the app's open path (`vimstorm <link>`, Finder) too
    v.key("super+arrow_down");
    v.wait_until("b shown", |v| active_dir(v) == b);
    let req = vimstorm::shell::projects::OpenRequest {
        dir: link.clone(),
        file: None,
    };
    v.cx.cx
        .update(|cx| vimstorm::shell::projects::open_path(req, cx))
        .unwrap();
    v.wait_until("a shown by its link", |v| active_dir(v) == a);
    assert_eq!(dirs(&mut v), [a, b]);
}

#[test]
fn a_held_or_doubled_cmd_q_closes_one_project() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let mut v = View::start_projects(a.to_str().unwrap(), &[]);
    open_project(&mut v, &b);
    open_project(&mut v, &c);
    // nothing to lose: the close answers at once. Held: the repeats close nothing more
    cmd_q(&mut v, false);
    for _ in 0..5 {
        cmd_q(&mut v, true);
    }
    v.wait_until("c closed", |v| dirs(v).len() == 2);
    v.settle();
    assert_eq!(dirs(&mut v), [a.clone(), b.clone()]);
    // two presses before Lua answered the first: one close
    let ws = v.active_project();
    v.use_project(&ws);
    cmd_q(&mut v, false);
    cmd_q(&mut v, false);
    v.wait_until("one more closed", |v| dirs(v).len() == 1);
    v.settle();
    assert_eq!(dirs(&mut v).len(), 1);
    let p = v.projects.clone().unwrap();
    assert!(!p.read_with(&v.cx, |p, _| p.quitting()), "the app stays");
}

#[test]
fn closing_onto_a_project_that_cant_start_shows_a_running_one() {
    let (_t1, a) = copy("proj");
    let (_t2, b) = copy("grepo");
    let (_t3, c) = copy("stree");
    let set = SavedSet {
        open: vec![a.clone(), b.clone(), c.clone()],
        active: Some(a.clone()),
    };
    let mut v = View::start_projects_restored(set);
    // b (restored, never started) is gone: its nvim can't start in it
    std::fs::remove_dir_all(&b).unwrap();
    v.key("super+q");
    v.wait_until("c shown", |v| active_dir(v) == c);
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_lua("c's nvim up", common::STARTED);
    let p = v.projects.clone().unwrap();
    v.pump();
    assert!(p.read_with(&v.cx, |p, _| p.is_running(&c)));
    // b stays listed (not running): showing it again tries again
    assert_eq!(dirs(&mut v), [b, c]);
}

#[test]
fn cmd_q_on_welcome_quits_and_cmd_w_only_closes_the_window() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let command = common::bridge::fake(tmp.path(), &["frames/bridge-tree-welcome.json"], None);
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+q");
    v.wait_until("Welcome shown", welcome_shown);
    // ⌘W: the window closes (the app hides; not in tests), the app stays and so does Welcome
    v.key("super+w");
    v.pump();
    assert!(projects.read_with(&v.cx, |p, _| p.welcome_shown() && !p.quitting()));
    // ⌘Q on Welcome: quits at once, nothing asked
    v.key("super+q");
    v.wait_until("the app quits", |v| {
        projects.read_with(&v.cx, |p, _| p.quitting())
    });
}

#[test]
fn one_worktree_project_too_many_closes_the_least_recent_clean_one() {
    let (_tmp, main) = main_repo();
    let mut v = View::start_projects("proj", &["a.ts"]);
    let trees: Vec<PathBuf> = (1..=7)
        .map(|i| {
            let t = main.parent().unwrap().join(format!("app-AB-{i}"));
            git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    &format!("feature/AB-{i}"),
                    t.to_str().unwrap(),
                ],
            );
            t
        })
        .collect();
    // the oldest has uncommitted work
    std::fs::write(trees[0].join("wip.ts"), "x\n").unwrap();
    let open = |v: &mut View, t: &Path| {
        let dir = t.to_path_buf();
        v.cx.update(|_, cx| projects::open_worktree(dir, cx));
        v.wait_until("the worktree shown", |v| active_dir(v) == t);
    };
    for t in &trees[..MAX_WORKTREES] {
        open(&mut v, t);
    }
    assert_eq!(dirs(&mut v).len(), 1 + MAX_WORKTREES, "five stay open");
    let p = v.projects.clone().unwrap();
    // the sixth: the least recent clean one (the second) goes, the dirty oldest stays
    open(&mut v, &trees[5]);
    v.wait_until("one closed", |v| dirs(v).len() == 1 + MAX_WORKTREES);
    let now = dirs(&mut v);
    assert!(
        now.contains(&trees[0]),
        "a dirty worktree project is never closed: {now:?}"
    );
    assert!(
        !now.contains(&trees[1]),
        "the least recent clean one closed: {now:?}"
    );
    assert!(now.contains(&trees[5]));
    // the seventh: the next clean one
    open(&mut v, &trees[6]);
    v.wait_until("one more closed", |v| !dirs(v).contains(&trees[2]));
    let now = dirs(&mut v);
    assert!(
        now.contains(&trees[0]) && now.contains(&trees[6]),
        "{now:?}"
    );
    assert_eq!(now.len(), 1 + MAX_WORKTREES);
    // the project opened as such (proj) never counts
    assert!(!p.read_with(&v.cx, |p, _| p.is_worktree(&now[0])));
    // the candidates, least recent first: never the shown one, even when it is the least recent
    // (open: proj, w1..w6)
    let worktree = [false, true, true, true, true, true, true];
    let mru = [6, 5, 4, 3, 2, 1, 0];
    assert_eq!(
        projects::lru_candidates(&worktree, &mru, 6, 5),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        projects::lru_candidates(&worktree, &mru, 6, 6),
        Vec::<usize>::new()
    );
    assert_eq!(
        projects::lru_candidates(&worktree, &[1, 6, 5, 4, 3, 2, 0], 1, 5),
        [2, 3, 4, 5, 6]
    );
}
