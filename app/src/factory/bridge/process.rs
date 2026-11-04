//! The session's process adapter: `abe ui bridge` spawned with piped stdio ([`BridgeCommand`]).

use std::io::{BufRead as _, BufReader, Write as _};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::Global;

use super::{Adapter, BridgeEvent, Link};
use crate::factory::protocol::AppFrame;

/// How the bridge is started: `$ABE_BIN`, else the `abe` next to this executable, with
/// `ui bridge`. Tests set it as a GPUI global (a fake bridge, its own env).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Added to the app's environment.
    pub env: Vec<(String, String)>,
}

impl Global for BridgeCommand {}

impl BridgeCommand {
    /// Whether there is an `abe` 2.0 to run: a command set as the global (tests), `$ABE_BIN`, or
    /// an `abe` beside this executable. Without one `:` says so (`projects::NO_ABE`).
    pub fn available(cx: &gpui_kit::App) -> bool {
        cx.has_global::<BridgeCommand>()
            || std::env::var_os("ABE_BIN").is_some_and(|p| !p.is_empty())
            || std::env::current_exe()
                .ok()
                .and_then(|exe| Some(exe.parent()?.join("abe")))
                .is_some_and(|p| p.is_file())
    }

    /// `$ABE_BIN ui bridge`, else `<this executable's dir>/abe ui bridge`.
    pub fn from_env() -> BridgeCommand {
        let program = std::env::var_os("ABE_BIN")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                let exe = std::env::current_exe().ok()?;
                Some(exe.parent()?.join("abe"))
            })
            .unwrap_or_else(|| PathBuf::from("abe"));
        BridgeCommand {
            program,
            args: vec!["ui".into(), "bridge".into()],
            env: Vec::new(),
        }
    }
}

/// The `abe ui bridge` child as the session's adapter: its stdout read and decoded on a thread
/// of its own ([`super::read`]), its stdin written on another (each frame serialized there), so
/// the UI thread never blocks on it or decodes what it says. Dropping the link kills it (and
/// reaps it on a thread).
impl Adapter for BridgeCommand {
    fn start(
        &mut self,
        generation: u64,
        to_app: UnboundedSender<BridgeEvent>,
    ) -> std::io::Result<Box<dyn Link>> {
        let mut child = Command::new(&self.program)
            .args(&self.args)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| {
                std::io::Error::new(e.kind(), format!("{}: {e}", self.program.display()))
            })?;
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::Builder::new()
            .name("abe-bridge-read".into())
            .spawn(move || {
                let lines = BufReader::new(stdout).lines().map_while(Result::ok);
                super::read(lines, generation, &to_app);
            })?;
        let (to_stdin, frames) = std::sync::mpsc::channel::<AppFrame>();
        std::thread::Builder::new()
            .name("abe-bridge-write".into())
            .spawn(move || {
                for frame in frames {
                    if writeln!(stdin, "{}", frame.line())
                        .and_then(|()| stdin.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(Box::new(Process {
            child: Some(child),
            stdin: to_stdin,
        }))
    }
}

/// A running bridge.
struct Process {
    /// Taken on drop: killed there, waited for on a thread of its own.
    child: Option<Child>,
    stdin: std::sync::mpsc::Sender<AppFrame>,
}

impl Link for Process {
    /// Written to the bridge's stdin (dropped when it is gone).
    fn send(&self, frame: AppFrame) {
        let _ = self.stdin.send(frame);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            // reaped off the UI thread
            let _ = std::thread::Builder::new()
                .name("abe-bridge-reap".into())
                .spawn(move || {
                    let _ = child.wait();
                });
        }
    }
}
