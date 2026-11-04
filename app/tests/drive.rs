//! The drive socket (`--features shots`): live offscreen apps driven over their sockets, two at
//! once, each on its own state and its own fake bridge (`tests/fixtures/drive/board-bridge.sh`: a
//! board of cards 101 and 202, or a given tree); a shot draws a prototype's page; a long wait
//! holds up no other request. Requests parsed and refused are the source's own tests. Run with `cargo test --features shots --test app drive::`.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::common::data_home;

/// App start and nvim's config can take a while on a busy machine.
const UP: Duration = Duration::from_secs(90);

/// A driven app: its socket, its bridge's log; quit (else killed) on drop.
struct Driven {
    child: Child,
    sock: PathBuf,
    bridge_log: PathBuf,
    _dir: tempfile::TempDir,
}

impl Driven {
    /// Starts the app on a small project with the fake bridge (`env`: its `DRIVE_BRIDGE_*`
    /// settings), and waits for its socket.
    fn start(name: &str, env: &[(&str, &str)]) -> Driven {
        Self::launch(name, env, true)
    }

    /// [`Self::start`]; `project_arg`: false launches with no path and nothing to reopen (Welcome).
    fn launch(name: &str, env: &[(&str, &str)], project_arg: bool) -> Driven {
        // short: a socket path is at most 104 bytes
        let dir = tempfile::Builder::new()
            .prefix(&format!("vsd{name}"))
            .tempdir_in("/tmp")
            .unwrap();
        let d = dir.path();
        let project = d.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.txt"), "drive\n").unwrap();
        let sock = d.join("d.sock");
        let bridge_log = d.join("bridge.log");
        let bridge =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drive/board-bridge.sh");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_vimstorm"));
        // no path: as the Dock launches it, from /
        if project_arg {
            cmd.arg(&project).current_dir(&project);
        } else {
            cmd.current_dir("/");
        }
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .env("VIMSTORM_DRIVE", &sock)
            .env("VIMSTORM_SHOT_STATE", d.join("state"))
            .env("VIMSTORM_SHOT_ABE_CONFIG", d.join("abe-config"))
            .env("VIMSTORM_CONFIG_HOME", d.join("config"))
            .env("VIMSTORM_LOG", d.join("vimstorm.log"))
            .env("VIMSTORM_NO_INSTANCE", "1")
            .env("XDG_DATA_HOME", data_home())
            .env("ABE_BIN", &bridge)
            .env("ABE_CONFIG_DIR", d.join("cfg"))
            .env("ABE_STATE_DIR", d.join("s"))
            .env("ABE_SOCKET", d.join("s/s.sock"))
            .env("DRIVE_BRIDGE_LOG", &bridge_log)
            .envs(env.iter().copied());
        let child = cmd.spawn().unwrap();
        let app = Driven {
            child,
            sock,
            bridge_log,
            _dir: dir,
        };
        let end = Instant::now() + UP;
        while UnixStream::connect(&app.sock).is_err() {
            assert!(Instant::now() < end, "{name}: no drive socket in {UP:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
        app
    }

    /// One request, its answer.
    fn ask(&self, request: Value) -> Value {
        let mut s = UnixStream::connect(&self.sock).unwrap();
        s.set_read_timeout(Some(UP)).unwrap();
        writeln!(s, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(&s).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line:?}"))
    }

    fn ok(&self, request: Value) -> Value {
        let a = self.ask(request.clone());
        assert_eq!(a["ok"], true, "{request} → {a}");
        a
    }

    fn layer(&self) -> String {
        self.ok(json!({"v": 1, "see": ["layer"]}))["trees"]["layer"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn bridge_log(&self) -> String {
        std::fs::read_to_string(&self.bridge_log).unwrap_or_default()
    }
}

impl Drop for Driven {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.ask_quietly();
            let end = Instant::now() + Duration::from_secs(10);
            while self.child.try_wait().ok().flatten().is_none() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Driven {
    fn ask_quietly(&self) -> std::io::Result<()> {
        let mut s = UnixStream::connect(&self.sock)?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        writeln!(s, "{}", json!({"v": 1, "quit": true}))?;
        let mut line = String::new();
        BufReader::new(&s).read_line(&mut line)?;
        Ok(())
    }
}

#[test]
fn two_live_apps_are_driven_at_once_each_to_its_own_card() {
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| Driven::start("a", &[]));
        let b = s.spawn(|| Driven::start("b", &[]));
        (a.join().unwrap(), b.join().unwrap())
    });
    // user-only sockets
    for app in [&a, &b] {
        let mode = std::fs::metadata(&app.sock).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // both boards up, the first card selected in each
    for app in [&a, &b] {
        app.ok(json!({"v": 1, "wait": {"text": "#202", "in": "main", "ms": 60000}}));
    }
    // driven at the same time: A opens its first card, B moves down and opens the second
    std::thread::scope(|s| {
        s.spawn(|| a.ok(json!({"v": 1, "keys": "{@super+alt+a}{wait:300}{@enter}"})));
        s.spawn(|| b.ok(json!({"v": 1, "keys": "{@super+alt+a}{wait:300}{@ö}{@enter}"})));
    });
    a.ok(json!({"v": 1, "wait": {"text": "Open card #101", "in": "layer", "ms": 20000}}));
    b.ok(json!({"v": 1, "wait": {"text": "Open card #202", "in": "layer", "ms": 20000}}));
    let (la, lb) = (a.layer(), b.layer());
    assert!(la.contains("#101") && !la.contains("#202"), "A: {la}");
    assert!(lb.contains("#202") && !lb.contains("#101"), "B: {lb}");
    let seen = a.ok(json!({"v": 1, "see": ["view", "main"]}));
    assert_eq!(seen["view"], "factory");
    assert!(
        seen["trees"]["main"]
            .as_str()
            .unwrap()
            .contains("ListRow #card:101")
    );

    // A's keys never reach B: A closes its card, B's stays open
    a.ok(json!({"v": 1, "keys": "{@escape}"}));
    a.ok(json!({"v": 1, "wait": {"text": "Open card", "in": "layer", "gone": true, "ms": 20000}}));
    assert!(b.layer().contains("Open card #202"), "B: {}", b.layer());
    // and each bridge got only its own app's keys
    let (log_a, log_b) = (a.bridge_log(), b.bridge_log());
    assert!(!log_a.contains("\"key\":\"ö\""), "A got B's ö:\n{log_a}");
    assert!(log_b.contains("\"key\":\"ö\""), "B: {log_b}");
    assert!(!log_b.contains("<Esc>"), "B got A's Esc:\n{log_b}");

    // A's last project closed: Welcome, no editor left; its keys still reach the screen
    a.ok(json!({"v": 1, "keys": "{@super+q}"}));
    a.ok(json!({"v": 1, "wait": {"text": "Welcome to VimStorm", "in": "title", "ms": 30000}}));
    a.ok(json!({"v": 1, "keys": "{@super+digit_6}{@escape}{type:x}"}));
    let on_welcome = |log: &str| {
        let at = log.find(r#""screen":"welcome""#)?;
        let keys = [r#""key":"<D-6>""#, r#""key":"<Esc>""#, r#""key":"x""#];
        keys.iter().all(|k| log[at..].contains(k)).then_some(())
    };
    let end = Instant::now() + Duration::from_secs(20);
    while on_welcome(&a.bridge_log()).is_none() {
        assert!(
            Instant::now() < end,
            "keys not sent on Welcome:\n{}",
            a.bridge_log()
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // a shot of the live window, then quit: the socket goes and the app ends
    let png = b.sock.with_file_name("b.png");
    b.ok(json!({"v": 1, "shot": png}));
    assert!(std::fs::metadata(&png).unwrap().len() > 1000);
    b.ok(json!({"v": 1, "quit": true}));
    let mut b = b;
    let end = Instant::now() + Duration::from_secs(30);
    while b.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < end, "B still runs after quit");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!b.sock.exists(), "B's socket left behind");
}

impl Driven {
    /// Waits for the last `focus` frame the bridge got to name `slot` (`null`: none has the keys).
    fn told_focus(&self, slot: &str) {
        let told = format!(r#""slot":{slot}}}"#);
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let log = self.bridge_log();
            let last = log.lines().rfind(|l| l.contains(r#""type":"focus""#));
            if last.is_some_and(|l| l.ends_with(&told)) {
                return;
            }
            assert!(Instant::now() < end, "not told {slot}:\n{log}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[test]
fn the_editor_shown_again_the_bridge_hears_no_slot_has_the_keys() {
    // the offscreen window sends no focus events and the hidden Factory view draws no frame:
    // hiding it says so, else the Editor's `:` reads as the Board's (its Subject, no Run in Neovim)
    let app = Driven::start("f", &[]);
    app.ok(json!({"v": 1, "wait": {"text": "#202", "in": "main", "ms": 60000}}));
    app.ok(json!({"v": 1, "keys": "{@super+alt+a}{wait:300}{@super+1}"}));
    app.told_focus(r#""main""#);
    app.ok(json!({"v": 1, "keys": "{@super+alt+a}"}));
    app.ok(json!({"v": 1, "wait": {"text": "editor", "in": "view", "ms": 20000}}));
    app.told_focus("null");
}

#[test]
fn the_offscreen_window_tells_lua_where_the_keys_went_so_the_pane_keys_toggle() {
    // no focus events offscreen: Chat taking the keys (⌘4) and giving them back (⌘4 again) went
    // untold, Lua kept the tree as focused and ⌘1 then neither focused nor hid it
    let app = Driven::start("p", &[]);
    app.ok(json!({"v": 1, "wait": {"text": "editor", "in": "view", "ms": 60000}}));
    app.ok(json!({"v": 1, "keys": "{@super+1}"}));
    app.focus_target("tree");
    app.ok(json!({"v": 1, "keys": "{@super+4}"}));
    app.focus_target("popup");
    app.ok(json!({"v": 1, "keys": "{@super+4}"}));
    app.focus_target("split");
    app.ok(json!({"v": 1, "keys": "{@super+1}"}));
    app.focus_target("tree");
    app.ok(json!({"v": 1, "keys": "{@super+1}"}));
    app.focus_target("split");
}

impl Driven {
    /// Waits for Lua's focus target (`config.focus.target()`: `split`, `tree`; Chat is `popup`)
    /// to be `want`.
    fn focus_target(&self, want: &str) {
        let file = self.sock.with_file_name("target.txt");
        let ask = format!(
            "{{lua:vim.fn.writefile({{require('config.focus').target()}}, '{}'):lua}}",
            file.display()
        );
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            self.ok(json!({"v": 1, "keys": ask}));
            let got = std::fs::read_to_string(&file).unwrap_or_default();
            if got.trim() == want {
                return;
            }
            assert!(Instant::now() < end, "focus target {got:?}, not {want:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[test]
fn a_launch_with_nothing_to_reopen_is_driven_on_welcome() {
    // no editor comes up to start the socket from: Welcome does
    let app = Driven::launch("e", &[], false);
    app.ok(json!({"v": 1, "wait": {"text": "Welcome to VimStorm", "in": "title", "ms": 30000}}));
    let png = app.sock.with_file_name("e.png");
    app.ok(json!({"v": 1, "shot": png}));
    assert!(std::fs::metadata(&png).unwrap().len() > 1000);
}

#[test]
fn a_balloons_timer_fires_in_a_driven_app() {
    let app = Driven::start("c", &[("DRIVE_BRIDGE_BALLOON", "drive balloon")]);
    app.ok(json!({"v": 1, "wait": {"text": "drive balloon", "in": "balloons", "ms": 60000}}));
    // an info balloon's reading time (4 s + 250 ms a word) runs only while it is drawn: the
    // driven window draws at a steady pace, so it goes by itself
    app.ok(json!({"v": 1, "wait": {"text": "drive balloon", "in": "balloons", "gone": true, "ms": 20000}}));
}

impl Driven {
    /// One request that must answer within `limit` (a client's own timeout, as qarig's).
    fn ask_within(&self, request: Value, limit: Duration) -> Value {
        let mut s = UnixStream::connect(&self.sock).unwrap();
        s.set_read_timeout(Some(limit)).unwrap();
        writeln!(s, "{request}").unwrap();
        let mut line = String::new();
        BufReader::new(&s)
            .read_line(&mut line)
            .unwrap_or_else(|e| panic!("{request}: no answer in {limit:?} ({e})"));
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line:?}"))
    }
}

#[test]
fn a_long_wait_holds_up_no_other_request() {
    // the gate's G2: the Board, Launch, then a 10-minute wait for a launch that never comes;
    // meanwhile a tester's see, keys and snap still answer at once
    let app = Driven::start("w", &[]);
    for keys in [
        "{@super+3}{wait:300}{@/}{type:204}{@enter}{wait:300}",
        "{@super+enter}{wait:300}{type:Launch agent}{@enter}{wait:300}{type:a note}{@enter}",
    ] {
        app.ok(json!({"v": 1, "keys": keys}));
    }
    std::thread::scope(|s| {
        let waited = s.spawn(|| {
            let t = Instant::now();
            let a = app.ask(json!({"v": 1, "wait": {"text": "Starting Claude Code", "ms": 8000}}));
            (a, t.elapsed())
        });
        std::thread::sleep(Duration::from_millis(500));
        let quick = Duration::from_secs(5);
        for request in [
            json!({"v": 1, "see": ["view", "main"]}),
            json!({"v": 1, "keys": "{@super+2}"}),
            json!({"v": 1, "shot": app.sock.with_file_name("w.png")}),
        ] {
            let a = app.ask_within(request.clone(), quick);
            assert_eq!(a["ok"], true, "{request} → {a}");
        }
        let (a, took) = waited.join().unwrap();
        assert_eq!(
            (&a["ok"], &a["error"]),
            (&json!(false), &json!("timeout")),
            "{a}"
        );
        assert!(
            took >= Duration::from_secs(8),
            "the wait gave up early: {took:?}"
        );
    });
}
