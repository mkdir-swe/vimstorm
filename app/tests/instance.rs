//! Single instance: the socket protocol end to end (client <-> server thread <-> GPUI UI thread),
//! handed paths opening / switching projects in the projects window, the binary as a client, and
//! the app binary serving its socket.

use crate::common;

use std::cell::RefCell;
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output};
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::view::View;
use futures::StreamExt as _;
use gpui_kit::{TestAppContext, TestDispatcher};
use vimstorm::app::{self, Bind, Handoff, Incoming, Server, Target};

/// A short dir for sockets (`sun_path` is 104 bytes; macOS `$TMPDIR` is long).
fn sock_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("vsi")
        .tempdir_in("/tmp")
        .unwrap()
}

fn bound(sock: &Path) -> Server {
    match app::bind(sock).unwrap() {
        Bind::Bound(s) => s,
        Bind::Running => panic!("{} already served", sock.display()),
    }
}

/// Serves `sock` on a plain thread (no GPUI): every request is recorded and accepted, except
/// files named `refuse.txt`.
fn serve_plain(sock: &Path) -> std::sync::mpsc::Receiver<(Target, Option<PathBuf>)> {
    let mut handle = bound(sock).serve().unwrap();
    let (seen_tx, seen) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while let Some(req) = futures::executor::block_on(handle.requests.next()) {
            let _ = seen_tx.send((req.target.clone(), req.git_root.clone()));
            let refuse = req.target.path().ends_with("refuse.txt");
            req.reply(if refuse {
                Err("refused here".into())
            } else {
                Ok(())
            });
        }
        drop(handle);
    });
    seen
}

fn git_init(dir: &Path) {
    let ok = Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(ok.success());
}

#[test]
fn client_server_round_trip() {
    let d = sock_dir();
    let sock = d.path().join("s.sock");
    let seen = serve_plain(&sock);
    let t = app::ANSWER_TIMEOUT;

    // a dir
    let proj = d.path().join("proj");
    std::fs::create_dir_all(proj.join("src")).unwrap();
    git_init(&proj);
    assert_eq!(app::hand_off(&sock, &proj, t).unwrap(), Handoff::Accepted);
    let real = proj.canonicalize().unwrap();
    assert_eq!(seen.recv().unwrap(), (Target::Dir(real.clone()), None));

    // a file: its git root comes along (looked up on the server thread)
    let file = proj.join("src/a.ts");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(app::hand_off(&sock, &file, t).unwrap(), Handoff::Accepted);
    assert_eq!(
        seen.recv().unwrap(),
        (Target::File(real.join("src/a.ts")), Some(real.clone()))
    );

    // the app's refusal reaches the client
    let refuse = proj.join("refuse.txt");
    std::fs::write(&refuse, "x").unwrap();
    assert_eq!(
        app::hand_off(&sock, &refuse, t).unwrap(),
        Handoff::Rejected("refused here".into())
    );
    seen.recv().unwrap();

    // bad paths never reach the app
    let missing = app::hand_off(&sock, &proj.join("missing"), t).unwrap();
    assert!(matches!(missing, Handoff::Rejected(_)), "{missing:?}");
    let relative = app::hand_off(&sock, Path::new("proj"), t).unwrap();
    assert!(
        matches!(&relative, Handoff::Rejected(e) if e.contains("absolute")),
        "{relative:?}"
    );

    // raw protocol: another version, garbage, a command: refused with a JSON answer
    for line in [
        "{\"v\":2,\"open\":\"/tmp\"}",
        "hello",
        "{\"v\":1,\"run\":\"echo hi\"}",
    ] {
        let mut s = UnixStream::connect(&sock).unwrap();
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut answer = String::new();
        BufReader::new(&s).read_line(&mut answer).unwrap();
        assert!(
            answer.starts_with("{\"ok\":false,\"error\":"),
            "{line} -> {answer}"
        );
    }
    assert!(seen.try_recv().is_err(), "a bad request reached the app");

    // 1.x's bare `abe` sent `"abe":true` beside `open`: an open like any other
    let mut s = UnixStream::connect(&sock).unwrap();
    let line = format!(
        r#"{{"v":1,"open":{:?},"abe":true}}"#,
        proj.display().to_string()
    );
    s.write_all(format!("{line}\n").as_bytes()).unwrap();
    let mut answer = String::new();
    BufReader::new(&s).read_line(&mut answer).unwrap();
    assert_eq!(answer.trim(), r#"{"ok":true}"#, "{line}");
    assert_eq!(seen.recv().unwrap(), (Target::Dir(real), None));
}

/// A request resolved to (project dir, file).
type Resolved = (PathBuf, Option<PathBuf>);

#[test]
fn requests_run_on_the_ui_thread() {
    let d = sock_dir();
    let sock = d.path().join("s.sock");
    let handle = bound(&sock).serve().unwrap();
    let app = TestAppContext::build(TestDispatcher::new(0), None);
    let opened: Rc<RefCell<Vec<Resolved>>> = Rc::default();
    let o2 = opened.clone();
    let open = vec![d.path().canonicalize().unwrap()];
    app.update(|cx| {
        app::attach(
            handle,
            move |req: Incoming, _cx| {
                // resolution against the open projects happens here, on the UI thread
                o2.borrow_mut().push(req.resolve(&open));
                req.reply(Ok(()));
            },
            cx,
        );
    });

    let file = d.path().join("sub/b.txt");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "x").unwrap();
    let f2 = file.clone();
    let s2 = sock.clone();
    let client = std::thread::spawn(move || app::hand_off(&s2, &f2, app::ANSWER_TIMEOUT));
    let deadline = Instant::now() + common::TIMEOUT;
    while !client.is_finished() {
        assert!(Instant::now() < deadline, "no answer");
        app.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(client.join().unwrap().unwrap(), Handoff::Accepted);
    let root = d.path().canonicalize().unwrap();
    // the open project containing the file wins over its dir
    assert_eq!(
        *opened.borrow(),
        vec![(root.clone(), Some(root.join("sub/b.txt")))]
    );

    // app quit removes the socket: the next `vimstorm` starts a new app
    app.quit();
    assert!(!sock.exists(), "socket left after quit");
}

/// Kills a started app if the test fails before it exits.
struct Proc(Child);

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn binary(sock: &Path, args: &[&Path]) -> (Output, Duration) {
    let started = Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .args(args)
        .env("VIMSTORM_BACKGROUND", "1")
        .env("VIMSTORM_SOCKET", sock)
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", sock.with_extension("config"))
        .env("VIMSTORM_TIMING", "1")
        .env_remove("VIMSTORM_NO_INSTANCE")
        .output()
        .unwrap();
    (out, started.elapsed())
}

#[test]
fn binary_hands_off_without_starting_the_app() {
    let d = sock_dir();
    let sock = d.path().join("s.sock");
    let proj = d.path().join("p");
    std::fs::create_dir_all(&proj).unwrap();

    // nobody listening: --remote says so (the CLI script then starts the app)
    let (out, _) = binary(&sock, &[Path::new("--remote"), &proj]);
    assert_eq!(out.status.code(), Some(3));

    let seen = serve_plain(&sock);
    let (out, took) = binary(&sock, &[&proj]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let real = proj.canonicalize().unwrap();
    assert_eq!(seen.recv().unwrap().0, Target::Dir(real.clone()));
    eprintln!(
        "binary hand-off: {took:?} wall; {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    assert!(took < Duration::from_secs(5), "hand-off took {took:?}");

    let (out, _) = binary(&sock, &[Path::new("--remote"), &proj]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(seen.recv().unwrap().0, Target::Dir(real.clone()));

    // refused: exit 1 with the reason
    let refuse = proj.join("refuse.txt");
    std::fs::write(&refuse, "x").unwrap();
    let (out, _) = binary(&sock, &[&refuse]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("refused here"));
}

#[test]
fn app_serves_its_socket_and_removes_it_on_quit() {
    let d = sock_dir();
    let sock = d.path().join("s.sock");
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-instance-")
        .tempdir()
        .unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("a.txt"), "a\n").unwrap();

    let app = Proc(
        Command::new(env!("CARGO_BIN_EXE_vimstorm"))
            .arg(&proj)
            // no focus / activation (also for the hand-off's bring_to_front): the user works
            // next to the tests
            .env("VIMSTORM_BACKGROUND", "1")
            .env("VIMSTORM_SOCKET", &sock)
            .env_remove("VIMSTORM_NO_INSTANCE")
            .env("XDG_STATE_HOME", tmp.path().join("state"))
            // its own config link: never repoint the installed app's at this checkout
            .env("VIMSTORM_CONFIG_HOME", tmp.path().join("config"))
            .env("XDG_CACHE_HOME", tmp.path().join("cache"))
            .env("XDG_DATA_HOME", common::data_home())
            .spawn()
            .unwrap(),
    );
    let mut app = app;
    let deadline = Instant::now() + common::TIMEOUT;
    while UnixStream::connect(&sock).is_err() {
        assert!(Instant::now() < deadline, "the app never served its socket");
        assert!(app.0.try_wait().unwrap().is_none(), "the app exited");
        std::thread::sleep(Duration::from_millis(20));
    }

    // a second launch can't become a server: the socket is taken
    assert!(matches!(app::bind(&sock).unwrap(), Bind::Running));
    // the app answers (bad paths refused before any project code)
    let missing = app::hand_off(&sock, &proj.join("missing"), app::ANSWER_TIMEOUT);
    assert!(matches!(missing, Ok(Handoff::Rejected(_))), "{missing:?}");
    // the same project: a switch to the active one, the binary as client exits 0
    let (out, took) = binary(&sock, &[&proj]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    eprintln!(
        "app hand-off: {took:?} wall; {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );

    let killed = Command::new("kill")
        .args(["-TERM", &app.0.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    let deadline = Instant::now() + common::TIMEOUT;
    while app.0.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the app didn't quit");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!sock.exists(), "socket left after quit");
}

/// A private copy of a fixture (sessions stay per test).
fn copy(name: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let out = Command::new("cp")
        .arg("-R")
        .arg(common::fixtures().join(name))
        .arg(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "cp {name}");
    (tmp, root.join(name))
}

/// Hands `path` over the socket from a client thread while the UI thread runs.
fn hand(v: &mut View, sock: &Path, path: &Path) -> Handoff {
    let (s, p) = (sock.to_path_buf(), path.to_path_buf());
    let client = std::thread::spawn(move || app::hand_off(&s, &p, app::ANSWER_TIMEOUT));
    let deadline = Instant::now() + common::TIMEOUT;
    while !client.is_finished() {
        assert!(
            Instant::now() < deadline,
            "no answer for {}",
            path.display()
        );
        v.pump();
        std::thread::sleep(Duration::from_millis(5));
    }
    client.join().unwrap().unwrap()
}

fn active_dir(v: &mut View) -> PathBuf {
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, _| ws.project().clone())
}

#[test]
fn handed_paths_open_and_switch_projects() {
    let (_t1, proj) = copy("proj");
    let (_t2, icons) = copy("icons");
    let mut v = View::start_projects(proj.to_str().unwrap(), &[]);
    let d = sock_dir();
    let sock = d.path().join("s.sock");
    let handle = bound(&sock).serve().unwrap();
    v.cx.update(|_, cx| app::attach(handle, app::open, cx));

    // a dir that isn't open: a new project, shown
    assert_eq!(hand(&mut v, &sock, &icons), Handoff::Accepted);
    v.wait_until("icons shown", |v| active_dir(v) == icons);
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_lua("icons' nvim started", common::STARTED);
    let projects = v.projects.clone().unwrap();
    let dirs = projects.read_with(&v.cx, |p, _| p.dirs());
    assert_eq!(dirs, vec![proj.clone(), icons.clone()]);

    // a file inside an open project: switches back to it and opens the file there
    let file = proj.join("src/../b.ts");
    assert_eq!(hand(&mut v, &sock, &file), Handoff::Accepted);
    v.wait_until("proj shown", |v| active_dir(v) == proj);
    let ws = v.active_project();
    v.use_project(&ws);
    let want = proj.join("b.ts");
    v.wait_lua(
        "b.ts opened in proj's nvim",
        &format!(
            "return vim.api.nvim_buf_get_name(0) == {:?}",
            want.display().to_string()
        ),
    );
    // no new project for it
    let dirs = projects.read_with(&v.cx, |p, _| p.dirs());
    assert_eq!(dirs.len(), 2, "{dirs:?}");

    // the shown project again: accepted, nothing changes
    assert_eq!(hand(&mut v, &sock, &proj), Handoff::Accepted);
    assert_eq!(active_dir(&mut v), proj);
}

#[test]
fn the_launch_arguments_name_the_path() {
    let os = |a: &[&str]| a.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
    assert_eq!(
        app::launch_args(&os(&["vimstorm", "/r"])),
        Some(PathBuf::from("/r"))
    );
    assert_eq!(app::launch_args(&os(&["vimstorm"])), None);
    assert_eq!(app::launch_args(&os(&["vimstorm", "-psn_0_123"])), None);
}
