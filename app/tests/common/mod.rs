//! Integration test harness: the real embedded nvim with the worktree config, UI attached through
//! the app's `nvim` module, no GUI. Mirrors `tests/harness.lua`: fixtures from `tests/fixtures.sh`,
//! own XDG state / cache per session, data dir = links to the real `~/.local/share/vimstorm`
//! (plugins, parsers, Mason) minus `snacks/` (pickers' history / frecency stay out of it), an
//! in-memory clipboard. Waits on conditions with timeouts, never fixed sleeps.
//!
//! First run: plugins must be installed (`app/scripts/warmup.sh`, network, a few minutes).

#![allow(dead_code)] // the `perf` binary uses a subset

/// The Factory's bridge: contract fixtures and a fake bridge.
pub mod bridge;
/// The Local Changes tab read from the window.
pub mod changes;
/// The Chat column: its state, the torn window, the chat slot's frames.
pub mod chat;
/// Git fixture copies + a generated big repo (git data tests).
pub mod gitfix;
/// Git tool window tab helpers (Local Changes).
pub mod gitui;
/// The native pickers' helpers.
pub mod pickers;
/// Native terminal helpers.
pub mod terminal;
/// Project tree helpers.
pub mod tree;
pub mod view;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use rmpv::Value;
use vimstorm::nvim::{Nvim, NvimConfig, NvimEvent, UiState};

pub const TIMEOUT: Duration = Duration::from_secs(15);

/// Runs a table's rows in order, each a named case that sets itself up; a failing row's panic
/// names the row.
pub fn table(rows: &[(&str, fn())]) {
    for (name, row) in rows {
        if let Err(e) = std::panic::catch_unwind(row) {
            let msg = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default();
            panic!("row {name}: {msg}");
        }
    }
}

/// The fixture root of the running test's file (`tests/fixtures.sh`): proj/, grepo/, ... Tests
/// open and write these in place, so each former test file (a module of the one test binary)
/// gets a copy of its own, as when each file was its binary (and as `tests/run.sh` gives each Lua
/// test file): keyed by the test thread's name, which libtest makes `<file>::<test>`. Off a test
/// thread: a copy shared by those calls. `fixtures.sh` runs once per binary.
pub fn fixtures() -> &'static Path {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    static ROOTS: Mutex<BTreeMap<String, &'static Path>> = Mutex::new(BTreeMap::new());
    let built = BUILT.get_or_init(|| {
        let dir = tempfile::Builder::new()
            .prefix("vimstorm-fixtures-")
            .tempdir()
            .unwrap()
            .keep();
        let script = repo().join("tests/fixtures.sh");
        let out = std::process::Command::new("bash")
            .arg(&script)
            .arg(&dir)
            .output()
            .expect("run fixtures.sh");
        assert!(
            out.status.success(),
            "fixtures.sh: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        dir
    });
    let file = std::thread::current()
        .name()
        .and_then(|name| name.split_once("::"))
        .map_or_else(|| "-".to_owned(), |(file, _)| file.to_owned());
    let mut roots = ROOTS.lock();
    roots.entry(file.clone()).or_insert_with(|| {
        let dir = tempfile::Builder::new()
            .prefix(&format!("vimstorm-fixtures-{file}-"))
            .tempdir()
            .unwrap()
            .keep();
        // clones on APFS (-c): the copy costs next to nothing
        let ok = std::process::Command::new("cp")
            .arg("-Rc")
            .arg(built.join("."))
            .arg(&dir)
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok, "copy the fixtures for {file}");
        Box::leak(dir.into_boxed_path())
    })
}

/// Remote markdown images cache in a fresh folder of their own from now on (returned). The cache
/// folder is the process's: each one stays until the binary ends (a test's own temp folder would
/// go with it while another test still fetches into it).
pub fn fresh_image_cache() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = ROOT.get_or_init(|| {
        tempfile::Builder::new()
            .prefix("vimstorm-md-images-")
            .tempdir()
            .unwrap()
            .keep()
    });
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = root.join(n.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    vimstorm::editor::markdown::set_cache_dir(dir.clone());
    dir
}

pub fn repo() -> PathBuf {
    vimstorm::nvim::find_repo().unwrap()
}

/// Data dir shared by all sessions of this binary: links to the real app data dir minus snacks/.
pub fn data_home() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let real = PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/vimstorm");
        assert!(
            real.join("lazy/lazy.nvim").is_dir(),
            "{} has no plugins: run app/scripts/warmup.sh once",
            real.display()
        );
        let dir = tempfile::Builder::new()
            .prefix("vimstorm-data-")
            .tempdir()
            .unwrap()
            .keep();
        let link_dir = dir.join("vimstorm");
        std::fs::create_dir_all(&link_dir).unwrap();
        for entry in std::fs::read_dir(&real).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() != "snacks" {
                std::os::unix::fs::symlink(entry.path(), link_dir.join(entry.file_name())).unwrap();
            }
        }
        dir
    })
}

#[derive(Default)]
struct Shared {
    ui: UiState,
    exited: bool,
    last_flush: Option<Instant>,
}

/// One running nvim with an attached (headless) UI.
pub struct Session {
    pub nvim: Nvim,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    _state: tempfile::TempDir,
}

pub struct Opts<'a> {
    pub cols: usize,
    pub rows: usize,
    pub args: &'a [&'a str],
}

impl Default for Opts<'_> {
    fn default() -> Self {
        Opts {
            cols: 120,
            rows: 40,
            args: &[],
        }
    }
}

const CLIPBOARD: &str = "lua local s = {} vim.g.clipboard = { name = 'test', \
    copy = { ['+'] = function(l, t) s['+'] = { l, t } end, ['*'] = function(l, t) s['*'] = { l, t } end }, \
    paste = { ['+'] = function() return s['+'] or { { '' }, 'v' } end, ['*'] = function() return s['*'] or { { '' }, 'v' } end } }";

/// Lua: true once nvim is up (VimEnter + VeryLazy).
pub const STARTED: &str = "return vim.v.vim_did_enter == 1 and vim.g.nvt_lazy == 1";

/// nvim config for a test session in `project` (a fixture name or an absolute path): its own XDG
/// state / cache (dropped with the returned dir), the shared data dir, an in-memory clipboard.
pub fn nvim_config(project: &str, files: &[&str]) -> (NvimConfig, tempfile::TempDir) {
    let dir = if project.starts_with('/') {
        PathBuf::from(project)
    } else {
        fixtures().join(project)
    };
    let state = tempfile::Builder::new()
        .prefix("vimstorm-state-")
        .tempdir()
        .unwrap();
    let mut cfg = NvimConfig::new(&dir).unwrap();
    // Tests must never repoint the installed editor's config link, even when a native
    // Projects launch clones this template for another worktree.
    cfg.config_home = state.path().join("config");
    // A cloud workspace's launch gets none of the local Neovim's config vars (they are the
    // box's to set, as `docker exec -e`); a test's stand-in box runs this Mac's nvim, so they ride
    // in `env`, which every launch keeps.
    cfg.env.insert("NVIM_APPNAME".into(), "vimstorm".into());
    cfg.env.insert(
        "XDG_CONFIG_HOME".into(),
        cfg.config_home.display().to_string(),
    );
    cfg.env.insert(
        "XDG_STATE_HOME".into(),
        state.path().join("state").display().to_string(),
    );
    cfg.env.insert(
        "XDG_CACHE_HOME".into(),
        state.path().join("cache").display().to_string(),
    );
    cfg.env
        .insert("XDG_DATA_HOME".into(), data_home().display().to_string());
    // the personal Layer, whose nvim/ loads over VimStorm's config (`config/userconfig.lua`): none
    cfg.env.insert(
        "ABE_CONFIG_DIR".into(),
        state.path().join("abe").display().to_string(),
    );
    let mut args: Vec<String> = vec![
        "--cmd".into(),
        CLIPBOARD.into(),
        "--cmd".into(),
        "autocmd User VeryLazy ++once let g:nvt_lazy = 1".into(),
    ];
    args.extend(files.iter().map(|s| s.to_string()));
    cfg.args = args;
    (cfg, state)
}

impl Session {
    /// Starts nvim in `project` (a fixture name or an absolute path) and returns once the config is
    /// up (VimEnter + VeryLazy, the tree drawn if the session opens it) and the screen is quiet.
    pub fn start(project: &str, opts: Opts) -> Session {
        let (cfg, state) = nvim_config(project, opts.args);

        let shared: Arc<(Mutex<Shared>, Condvar)> = Arc::default();
        shared.0.lock().ui = UiState::new();
        let s2 = shared.clone();
        let mut nvim = Nvim::start(&cfg, move |ev| {
            let (lock, cv) = &*s2;
            let mut sh = lock.lock();
            match ev {
                NvimEvent::Redraw(batch) => {
                    if sh.ui.apply(batch) {
                        sh.last_flush = Some(Instant::now());
                    }
                }
                NvimEvent::Exited => sh.exited = true,
                NvimEvent::Notification(..) => {}
            }
            cv.notify_all();
        })
        .unwrap();
        nvim.attach(opts.cols, opts.rows);
        let s = Session {
            nvim,
            shared,
            _state: state,
        };
        s.wait_lua("nvim started (VimEnter + VeryLazy)", STARTED);
        s.settle();
        s
    }

    /// Runs `f` on the current UI state.
    pub fn ui<R>(&self, f: impl FnOnce(&UiState) -> R) -> R {
        f(&self.shared.0.lock().ui)
    }

    /// Waits until `pred` holds on the UI state (checked after every redraw batch).
    pub fn wait_for(&self, label: &str, pred: impl Fn(&UiState) -> bool) {
        let (lock, cv) = &*self.shared;
        let deadline = Instant::now() + TIMEOUT;
        let mut sh = lock.lock();
        while !pred(&sh.ui) {
            assert!(!sh.exited, "nvim exited while waiting for: {label}");
            if cv.wait_until(&mut sh, deadline).timed_out() && !pred(&sh.ui) {
                let screen = sh.ui.screen_lines().join("\n");
                panic!("timed out waiting for: {label}\n--- screen ---\n{screen}");
            }
        }
    }

    /// Waits until `text` is on the composed screen.
    pub fn wait_screen(&self, text: &str) {
        self.wait_for(&format!("screen shows {text:?}"), |ui| {
            ui.screen_lines().iter().any(|l| l.contains(text))
        });
    }

    /// Waits until the screen has been quiet (no flush) for 100 ms, at most 2 s.
    pub fn settle(&self) {
        let (lock, cv) = &*self.shared;
        let quiet = Duration::from_millis(100);
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut sh = lock.lock();
        loop {
            let now = Instant::now();
            let since = sh.last_flush.map(|t| now - t).unwrap_or(quiet);
            if since >= quiet || now >= deadline {
                return;
            }
            let _ = cv.wait_until(&mut sh, (now + quiet - since).min(deadline));
        }
    }

    pub fn screen(&self) -> Vec<String> {
        self.ui(|ui| ui.screen_lines())
    }

    /// Keys in nvim notation, as the app sends them (`nvim_input`).
    pub fn input(&self, keys: &str) {
        self.nvim.rpc.input(keys);
    }

    pub fn request(&self, method: &str, args: Vec<Value>) -> Value {
        self.nvim
            .rpc
            .request_blocking(method, args, TIMEOUT)
            .unwrap()
    }

    /// `nvim_exec_lua` (the code must `return` its result).
    pub fn lua(&self, code: &str) -> Value {
        self.request("nvim_exec_lua", vec![code.into(), Value::Array(vec![])])
    }

    /// Polls a Lua condition (returns true when done), re-checked after every redraw / 20 ms.
    pub fn wait_lua(&self, label: &str, code: &str) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self.lua(code).as_bool() == Some(true) {
                return;
            }
            if Instant::now() > deadline {
                panic!(
                    "timed out waiting for: {label}\n--- screen ---\n{}",
                    self.screen().join("\n")
                );
            }
            let (lock, cv) = &*self.shared;
            let mut sh = lock.lock();
            let _ = cv.wait_for(&mut sh, Duration::from_millis(20));
        }
    }

    /// Mode as nvim reports it (`nvim_get_mode().mode`).
    pub fn mode(&self) -> String {
        let m = self.request("nvim_get_mode", vec![]);
        map_get(&m, "mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    }

    pub fn resize(&self, cols: usize, rows: usize) {
        self.nvim.rpc.ui_try_resize(cols, rows);
        self.wait_for(&format!("screen {cols}x{rows}"), |ui| {
            ui.screen_size() == (cols, rows)
        });
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.nvim.kill();
    }
}

pub fn map_get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}
