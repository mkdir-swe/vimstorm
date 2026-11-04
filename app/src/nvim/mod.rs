//! Embedded nvim: process, msgpack-rpc, redraw parser, UI state. No GPUI types, so all of it runs
//! headless in tests.

mod echo;
pub mod lua;
mod process;
mod redraw;
mod rpc;
mod sync;
mod ui;

use std::process::Child;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use parking_lot::Mutex;
use rmpv::Value;

pub use echo::Key;
pub(crate) use echo::{CONFIRM_WITHIN, Echo, Echoed, Shown, Spot};
pub use process::{NvimConfig, find_repo};
pub(crate) use redraw::HlAttr;
pub use redraw::{Anchor, CursorShape, GridId, RedrawEvent};
pub use rpc::{NvimEvent, Rpc, RpcError};
pub use sync::SyncGroup;
pub(crate) use sync::{HOLD_SYNC, Presented, SyncState};
pub use ui::{CARET_COLOR, CellText, Layer, UiState};
pub(crate) use ui::{Caret, Cell, CursorPos, Grid, Margins, Placement};

/// How long the app waits for nvim to save and quit before killing it.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(1);
/// While quitting, how often [`Quitter`] checks that nvim isn't stuck in a prompt.
const UNBLOCK_EVERY: Duration = Duration::from_millis(50);

/// Field `key` of a msgpack map (None: not a map, or no such key).
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

/// Whether an `nvim_get_mode` answer says nvim waits for a key in a prompt / pending sequence.
pub fn mode_blocking(mode: &Value) -> bool {
    get(mode, "blocking")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A running nvim with its RPC handle.
pub struct Nvim {
    pub rpc: Rpc,
    child: Arc<Mutex<Child>>,
    /// The screen size `nvim_ui_attach` was sent with (startup attaches before the window opens).
    attached: Option<(usize, usize)>,
    /// A cloud workspace's, started through its [`NvimConfig::launch`].
    remote: bool,
    /// How it ended, once it did (a cloud workspace's).
    exit: ExitSlot,
}

/// How long the reader waits, once stdout closed, for the process's exit and the rest of its
/// stderr before it says [`NvimEvent::Exited`].
const EXIT_SETTLE: Duration = Duration::from_secs(2);

/// What a cloud workspace's stderr keeps at most: its last bytes.
const STDERR_TAIL: usize = 4096;

/// How a cloud workspace's Neovim ended: its attach's exit code (None: a signal, or still
/// running after [`EXIT_SETTLE`]) and the last of what it said on stderr.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub stderr: String,
}

/// Where a cloud workspace's [`Exit`] lands, before its [`NvimEvent::Exited`] goes out.
#[derive(Clone, Default)]
pub struct ExitSlot(Arc<Mutex<Option<Exit>>>);

impl ExitSlot {
    /// How it ended; None while it runs (and for a local nvim).
    pub fn get(&self) -> Option<Exit> {
        self.0.lock().clone()
    }
}

/// Copies `from` to the app's stderr (the log keeps it), its last [`STDERR_TAIL`] bytes kept in
/// `tail`; `done` drops when `from` closed.
fn tee_stderr(
    mut from: impl std::io::Read,
    tail: Arc<Mutex<Vec<u8>>>,
    done: std::sync::mpsc::Sender<()>,
) {
    use std::io::Write as _;
    let mut buf = [0u8; 4096];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = std::io::stderr().write_all(&buf[..n]);
                let mut t = tail.lock();
                t.extend_from_slice(&buf[..n]);
                let over = t.len().saturating_sub(STDERR_TAIL);
                t.drain(..over);
            }
        }
    }
    drop(done);
}

/// The exit code once `child` exits, waiting at most `wait`.
fn exit_code(child: &Mutex<Child>, wait: Duration) -> Option<i32> {
    let deadline = Instant::now() + wait;
    loop {
        match child.lock().try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => {}
            _ => return None,
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Nvim {
    /// Spawns nvim (contract 1); `on_event` runs on the reader thread for every event.
    pub fn start(
        cfg: &NvimConfig,
        on_event: impl FnMut(NvimEvent) + Send + 'static,
    ) -> Result<Self> {
        let p = process::spawn(cfg)?;
        let child = Arc::new(Mutex::new(p.child));
        let exit = ExitSlot::default();
        let mut on_event = on_event;
        let on_event: Box<dyn FnMut(NvimEvent) + Send> = match p.stderr {
            // a cloud workspace's: its exit code and stderr known before Exited goes out
            Some(err) => {
                let tail = Arc::new(Mutex::new(Vec::new()));
                let (done, ended) = std::sync::mpsc::channel::<()>();
                let kept = tail.clone();
                let tee = std::thread::Builder::new()
                    .name("nvim-stderr".into())
                    .spawn(move || tee_stderr(err, kept, done));
                if let Err(e) = tee {
                    let mut c = child.lock();
                    let _ = c.kill();
                    let _ = c.wait();
                    return Err(e.into());
                }
                let (child, slot) = (child.clone(), exit.clone());
                Box::new(move |ev| {
                    if matches!(ev, NvimEvent::Exited) {
                        let _ = ended.recv_timeout(EXIT_SETTLE);
                        let code = exit_code(&child, EXIT_SETTLE);
                        let stderr = String::from_utf8_lossy(&tail.lock()).into_owned();
                        *slot.0.lock() = Some(Exit { code, stderr });
                    }
                    on_event(ev);
                })
            }
            None => Box::new(on_event),
        };
        let rpc = Rpc::start(p.stdin, p.stdout, on_event);
        Ok(Nvim {
            rpc,
            child,
            attached: None,
            remote: cfg.launch.is_some(),
            exit,
        })
    }

    /// `nvim_ui_attach` with the options the app draws with: linegrid + multigrid + hlstate.
    /// nvim draws the cmdline, messages and popup menu on its own grids (no ext_cmdline /
    /// ext_messages / ext_popupmenu): blink.cmp, snacks etc. are floats anyway.
    pub fn attach(&mut self, cols: usize, rows: usize) {
        self.rpc.notify("nvim_ui_attach", attach_args(cols, rows));
        self.attached = Some((cols, rows));
    }

    /// The size the UI was attached with, if it was.
    pub fn attached(&self) -> Option<(usize, usize)> {
        self.attached
    }

    /// A cloud workspace's Neovim (its keys echo locally: [`echo`]).
    pub fn remote(&self) -> bool {
        self.remote
    }

    pub fn pid(&self) -> u32 {
        self.child.lock().id()
    }

    /// Kills the process (tests; the app lets nvim quit on its own so sessions get saved).
    pub fn kill(&mut self) {
        let mut child = self.child.lock();
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Whether the process has exited.
    pub fn exited(&mut self) -> bool {
        !matches!(self.child.lock().try_wait(), Ok(None))
    }

    /// Where how it ended lands (a cloud workspace's).
    pub fn exit(&self) -> ExitSlot {
        self.exit.clone()
    }

    /// A handle that quits this nvim cleanly from any thread (window close, app quit, signals).
    pub fn quitter(&self) -> Quitter {
        Quitter {
            rpc: self.rpc.clone(),
            child: self.child.clone(),
        }
    }
}

/// Quits nvim saving everything first. When its stdio just closes, nvim preserves swap files
/// (crash recovery), so every app exit that isn't nvim's own goes through here.
#[derive(Clone)]
pub struct Quitter {
    rpc: Rpc,
    child: Arc<Mutex<Child>>,
}

impl Quitter {
    /// What nvim runs: write every modified buffer (silently skipping unwritable ones), then quit
    /// (VimLeavePre still saves the session). Written as autosave writes: agents' changes on disk
    /// checked first (a conflicting buffer stays unwritten: its guard, its edits carried in its
    /// record), no BufWritePre, never a prompt (`noconfirm`: a "write anyway?" waited for the
    /// kill). BufWritePre formats each file in turn (conform, loaded on the first write, Prettier
    /// up to 1 s a file): the app quit's [`QUIT_TIMEOUT`] ran out, the kill left a swap file for
    /// every buffer, and the next start stopped at Vim's ATTENTION prompt.
    pub const COMMAND: &str = "exe \"silent! lua require('config.app.agent_files').before_save_all()\" \
        | set noconfirm eventignore+=BufWritePre | silent! wall | qa!";

    /// Sends [`Self::COMMAND`] and blocks until nvim has exited, killing it after `timeout`.
    /// Returns at once when nvim is already gone. Blocks: off the UI thread unless quitting.
    pub fn quit(&self, timeout: Duration) {
        if self.reaped() {
            return;
        }
        self.unblock();
        self.rpc.command(Self::COMMAND);
        let deadline = Instant::now() + timeout;
        let mut check = Instant::now() + UNBLOCK_EVERY;
        while !self.reaped() {
            let now = Instant::now();
            if now >= deadline {
                eprintln!("[vimstorm] nvim didn't quit within {timeout:?}: killing it");
                let mut child = self.child.lock();
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            // a prompt can come up while it quits too (a message from a handler on the way out)
            if now >= check {
                self.unblock();
                check = Instant::now() + UNBLOCK_EVERY;
            }
            // try_wait has no blocking-with-timeout form; nvim takes a few ms to write and quit
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// nvim waiting for a key in a prompt (hit-enter, more, confirm) or a pending sequence runs
    /// no command until it gets one: the quit would hang until the kill, losing the session.
    /// `nvim_get_mode` (a fast call) answers even then; Esc gets it out.
    fn unblock(&self) {
        let blocking = self
            .rpc
            .request_blocking("nvim_get_mode", Vec::new(), UNBLOCK_EVERY)
            .is_ok_and(|m| mode_blocking(&m));
        if blocking {
            self.rpc.input("<Esc>");
        }
    }

    /// Whether the process has exited (and is reaped).
    fn reaped(&self) -> bool {
        !matches!(self.child.lock().try_wait(), Ok(None))
    }
}

/// Args of `nvim_ui_attach`.
pub fn attach_args(cols: usize, rows: usize) -> Vec<Value> {
    let opts = Value::Map(vec![
        ("rgb".into(), true.into()),
        ("ext_linegrid".into(), true.into()),
        ("ext_multigrid".into(), true.into()),
        ("ext_hlstate".into(), true.into()),
    ]);
    vec![
        (cols.max(1) as u64).into(),
        (rows.max(1) as u64).into(),
        opts,
    ]
}
