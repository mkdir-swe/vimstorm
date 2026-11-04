//! The app binary on a real window: a signal saves all and quits nvim cleanly (no swap files).

use crate::common;

use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::{TIMEOUT, data_home};
use rmpv::Value;
use vimstorm::nvim::Rpc;

/// Polls `cond` every 20 ms until it holds; panics after [`TIMEOUT`].
fn wait_until(label: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for: {label}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn swap_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".swp"))
                .collect()
        })
        .unwrap_or_default()
}

/// Kills the app if the test fails before it exits.
struct App(Child);

impl Drop for App {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The app's log so far (empty: none).
fn log_of(log: &Path) -> String {
    std::fs::read_to_string(log).unwrap_or_default()
}

/// Starts the app on a file, its stdout / stderr nowhere (as a Dock launch has them), modifies
/// the buffer over nvim's `--listen` socket, sends `signal`, and checks the edit got written, no
/// swap file is left and the log says the signal quit it.
fn signal_saves_and_leaves_no_swap(signal: &str) {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-quit-")
        .tempdir()
        .unwrap();
    let project = tmp.path().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let file = project.join("a.txt");
    std::fs::write(&file, "original\n").unwrap();
    let state = tmp.path().join("state");
    let sock = tmp.path().join("nvim.sock");
    let log = tmp.path().join("logs/vimstorm.log");

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vimstorm"));
    // started as from a terminal: SIGINT / SIGHUP at their default. A run in the background (`&`
    // in a script, as the gate's) has them ignored, the app keeps them so (`quit_signals`) and
    // the signal would never reach it.
    // SAFETY: between fork and exec only `signal`, which is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGHUP, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut app = App(cmd
        .arg(&file)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("VIMSTORM_LOG", &log)
        // the window opens without focus / activation: the user works next to the tests
        .env("VIMSTORM_BACKGROUND", "1")
        .env("XDG_STATE_HOME", &state)
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", tmp.path().join("config"))
        .env("XDG_CACHE_HOME", tmp.path().join("cache"))
        .env("XDG_DATA_HOME", data_home())
        .env("VIMSTORM_LISTEN", &sock)
        // not the single instance: parallel tests (and the user's app) must not take each other's path
        .env("VIMSTORM_NO_INSTANCE", "1")
        .spawn()
        .unwrap());

    wait_until("nvim's socket", || UnixStream::connect(&sock).is_ok());
    let stream = UnixStream::connect(&sock).unwrap();
    let rpc = Rpc::start(stream.try_clone().unwrap(), stream, |_| {});
    let lua = |code: &str| {
        rpc.request_blocking(
            "nvim_exec_lua",
            vec![code.into(), Value::Array(vec![])],
            TIMEOUT,
        )
        .unwrap()
    };
    wait_until("VimEnter", || {
        lua("return vim.v.vim_did_enter == 1").as_bool() == Some(true)
    });
    let path = file.canonicalize().unwrap().display().to_string();
    // the config autosaves on FocusLost / BufLeave (parallel tests' windows steal focus): off, so
    // only the quit path can save
    let swap = lua(&format!(
        "vim.api.nvim_clear_autocmds({{ event = {{ 'FocusLost', 'BufLeave' }} }}) \
         local b = vim.fn.bufadd({path:?}) vim.fn.bufload(b) \
         vim.api.nvim_buf_set_lines(b, 0, -1, false, {{ 'edited' }}) \
         return vim.fn.swapname(b)"
    ));
    let swap = Path::new(swap.as_str().unwrap()).to_path_buf();
    let swap_dir = swap.parent().unwrap().to_path_buf();
    assert!(
        swap_dir.starts_with(&state),
        "swap dir {} not in the test's state dir",
        swap_dir.display()
    );
    wait_until("the swap file", || swap.exists());
    let modified = lua(&format!("return vim.bo[vim.fn.bufnr({path:?})].modified"));
    assert_eq!(
        modified.as_bool(),
        Some(true),
        "buffer saved before the signal"
    );

    let pid = app.0.id().to_string();
    let killed = Command::new("kill")
        .args([&format!("-{signal}"), &pid])
        .status()
        .unwrap();
    assert!(killed.success());
    wait_until("the app to exit", || app.0.try_wait().unwrap().is_some());

    let said = log_of(&log);
    assert!(said.contains("[vimstorm] start: VimStorm"), "{said}");
    let exits: Vec<&str> = said.lines().filter(|l| l.contains("] exit: ")).collect();
    assert_eq!(exits.len(), 1, "one exit line: {said}");
    assert!(
        exits[0].ends_with(&format!("exit: signal SIG{signal}")),
        "{said}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited\n");
    assert_eq!(
        swap_files(&swap_dir),
        Vec::<String>::new(),
        "swap files left"
    );
}

#[test]
fn a_signal_saves_all_and_quits_nvim_cleanly() {
    for signal in ["TERM", "INT"] {
        signal_saves_and_leaves_no_swap(signal);
    }
}

/// A Dock / Finder launch has no LANG (LaunchServices): the app sets a UTF-8 one, so nvim and the
/// shells it and the terminal start read åäö as three characters, not six bytes.
#[test]
fn a_launch_without_a_locale_gets_utf8_for_nvim_and_shells() {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-locale-")
        .tempdir()
        .unwrap();
    let project = tmp.path().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let sock = tmp.path().join("nvim.sock");
    let _app = App(Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .arg(&project)
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .env_remove("LC_CTYPE")
        .env("VIMSTORM_BACKGROUND", "1")
        .env("VIMSTORM_NO_INSTANCE", "1")
        .env("XDG_STATE_HOME", tmp.path().join("state"))
        // its own config link: never repoint the installed app's at this checkout
        .env("VIMSTORM_CONFIG_HOME", tmp.path().join("config"))
        .env("XDG_CACHE_HOME", tmp.path().join("cache"))
        .env("XDG_DATA_HOME", data_home())
        .env("VIMSTORM_LISTEN", &sock)
        .spawn()
        .unwrap());
    wait_until("nvim's socket", || UnixStream::connect(&sock).is_ok());
    let stream = UnixStream::connect(&sock).unwrap();
    let rpc = Rpc::start(stream.try_clone().unwrap(), stream, |_| {});
    let lua = |code: &str| {
        rpc.request_blocking(
            "nvim_exec_lua",
            vec![code.into(), Value::Array(vec![])],
            TIMEOUT,
        )
        .unwrap()
    };
    assert_eq!(lua("return vim.env.LANG").as_str(), Some("en_US.UTF-8"));
    let chars = lua("return vim.trim(vim.fn.system({ 'sh', '-c', 'printf åäö | wc -m' }))");
    assert_eq!(chars.as_str(), Some("3"), "åäö in a shell");
}

/// A launch that can't start (here: no nvim config where VIMSTORM_REPO points) from the Dock,
/// stderr nowhere: it exits 1 and its log says why and what to do. (Started by the test,
/// not macOS: no alert.)
#[test]
fn a_launch_that_fails_logs_why_and_the_fix() {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-fail-")
        .tempdir()
        .unwrap();
    let project = tmp.path().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let log = tmp.path().join("vimstorm.log");
    let mut app = App(Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .arg(&project)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("VIMSTORM_LOG", &log)
        .env("VIMSTORM_REPO", tmp.path().join("no-repo"))
        .env("VIMSTORM_BACKGROUND", "1")
        .env("VIMSTORM_NO_INSTANCE", "1")
        .env("VIMSTORM_CONFIG_HOME", tmp.path().join("config"))
        .spawn()
        .unwrap());
    wait_until("the app to exit", || app.0.try_wait().unwrap().is_some());
    assert_eq!(app.0.try_wait().unwrap().and_then(|s| s.code()), Some(1));
    let said = log_of(&log);
    assert!(
        said.contains("launch failed: VIMSTORM_REPO=") && said.contains("has no nvim/init.lua"),
        "{said}"
    );
    assert!(said.contains("] fix: Run install.sh"), "{said}");
    assert_eq!(said.matches("] exit: launch failed").count(), 1, "{said}");
}

/// The app's quit of an nvim whose BufWritePre is slow (conform's format on save, Prettier
/// starting): it writes the buffer without it and exits well before the kill, its swap file gone
/// and the session saved. With the format the kill came first and left the swap file behind.
/// A file an agent changed under unsaved edits (`config/app/agent_files.lua`) never asks either
/// (its "write anyway?" took the quit to the kill): left as the agent wrote it, the edits kept in
/// its conflict record for the next start.
#[test]
fn a_quit_writes_without_formatting_and_leaves_no_swap() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.yaml");
    std::fs::write(&file, "a: 1\n").unwrap();
    let raced = dir.path().join("b.txt");
    std::fs::write(&raced, "original\n").unwrap();
    let saved = dir.path().join("saved");
    let s = common::Session::start(&dir.path().display().to_string(), common::Opts::default());
    let path = file.canonicalize().unwrap().display().to_string();
    let raced_path = raced.canonicalize().unwrap().display().to_string();
    let swap = s.lua(&format!(
        "vim.api.nvim_create_autocmd('BufWritePre', {{ callback = function() vim.uv.sleep(3000) end }}) \
         vim.api.nvim_create_autocmd('VimLeavePre', {{ callback = function() vim.fn.writefile({{ 'yes' }}, '{}') end }}) \
         local b = vim.fn.bufadd({path:?}) vim.fn.bufload(b) \
         vim.api.nvim_buf_set_lines(b, 0, -1, false, {{ 'a: 2' }}) \
         return vim.fn.swapname(b)",
        saved.display()
    ));
    let swap = std::path::PathBuf::from(swap.as_str().unwrap());
    wait_until("the swap file", || swap.exists());
    let record = s.lua(&format!(
        "local b = vim.fn.bufadd({raced_path:?}) vim.fn.bufload(b) \
         vim.api.nvim_buf_set_lines(b, 0, -1, false, {{ 'mine' }}) \
         vim.uv.sleep(20) vim.fn.writefile({{ 'agent' }}, {raced_path:?}) \
         local files = require('config.app.agent_files') files.before_save_all() \
         return (files.conflict(b) or {{}}).editor"
    ));
    let record = std::path::PathBuf::from(record.as_str().expect("a conflict record"));
    let start = Instant::now();
    s.nvim.quitter().quit(vimstorm::nvim::QUIT_TIMEOUT);
    assert!(
        start.elapsed() < vimstorm::nvim::QUIT_TIMEOUT,
        "killed, not quit"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "a: 2\n");
    assert!(!swap.exists(), "swap file left: {}", swap.display());
    assert!(saved.is_file(), "VimLeavePre ran");
    assert_eq!(std::fs::read_to_string(&raced).unwrap(), "agent\n");
    assert_eq!(std::fs::read_to_string(&record).unwrap(), "mine\n");
}
