//! One shell: a PTY (`alacritty_terminal::tty`), its terminal state (`Term`: VT parser, grid,
//! scrollback) and alacritty's I/O thread (`EventLoop`), which reads the PTY and parses into the
//! `Term` off the UI thread. The UI thread hears about it through one channel shared by every
//! shell ([`PtyEvent`]); a burst of output is one [`PtyEvent::Wakeup`] until the UI took it
//! ([`Pty::take_dirty`]), so drawing is coalesced to at most one frame per batch whatever the
//! output rate. Replies the terminal owes the app (device attributes, OSC 4 color queries, text
//! area size) are written back from the I/O thread itself.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::tty;
use futures::channel::mpsc::UnboundedSender;
use parking_lot::Mutex;

use super::colors;

/// Lines of scrollback per tab (nvim's `'scrollback'` default, which the Lua terminal had).
pub const SCROLLBACK: usize = 10_000;

/// What a shell tells the UI thread.
#[derive(Debug, Clone, PartialEq)]
pub enum PtyEvent {
    /// New output was parsed (sent once until [`Pty::take_dirty`]).
    Wakeup(u64),
    /// OSC 0 / 2 title ("" = reset to the default name).
    Title(u64, String),
    /// BEL.
    Bell(u64),
    /// The shell exited (or the I/O thread stopped).
    Exit(u64),
    /// OSC 52: an app stores text in the clipboard.
    Clipboard(String),
}

/// How to start a shell.
#[derive(Clone, Debug)]
pub struct Spawn {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub cell_width: u16,
    pub cell_height: u16,
}

impl Spawn {
    /// A program in a clean environment (B11, agent launches): nothing of the app's is inherited,
    /// not even what the PTY itself sets for a shell; `env` is the whole of it. Run through
    /// `/usr/bin/env -i` (it clears, sets, then finds the program on the PATH given).
    pub fn clean(
        program: &str,
        args: &[String],
        cwd: PathBuf,
        env: &std::collections::BTreeMap<String, String>,
        size: (u16, u16),
        cell: (u16, u16),
    ) -> Spawn {
        let mut all: Vec<String> = vec!["-i".into()];
        all.extend(
            env.iter()
                .filter(|(k, _)| !k.is_empty() && !k.contains('='))
                .map(|(k, v)| format!("{k}={v}")),
        );
        all.push(program.to_owned());
        all.extend(args.iter().cloned());
        Spawn {
            program: "/usr/bin/env".into(),
            args: all,
            cwd,
            env: HashMap::new(),
            cols: size.0,
            rows: size.1,
            cell_width: cell.0,
            cell_height: cell.1,
        }
    }
}

/// The `Term`'s event sink (runs on the I/O thread).
#[derive(Clone)]
pub struct Listener {
    id: u64,
    tx: UnboundedSender<PtyEvent>,
    dirty: Arc<AtomicBool>,
    sender: Arc<OnceLock<EventLoopSender>>,
    size: Arc<Mutex<WindowSize>>,
    exited: Arc<AtomicBool>,
    code: Arc<Mutex<Option<i32>>>,
}

impl Listener {
    fn write(&self, bytes: Vec<u8>) {
        if let Some(s) = self.sender.get() {
            let _ = s.send(Msg::Input(Cow::Owned(bytes)));
        }
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup => {
                if !self.dirty.swap(true, Ordering::AcqRel) {
                    let _ = self.tx.unbounded_send(PtyEvent::Wakeup(self.id));
                }
            }
            Event::PtyWrite(text) => self.write(text.into_bytes()),
            Event::ColorRequest(index, format) => {
                self.write(format(colors::to_rgb(colors::indexed(index))).into_bytes())
            }
            Event::TextAreaSizeRequest(format) => {
                let size = *self.size.lock();
                self.write(format(size).into_bytes())
            }
            Event::ClipboardStore(_, text) => {
                let _ = self.tx.unbounded_send(PtyEvent::Clipboard(text));
            }
            Event::Title(title) => {
                let _ = self.tx.unbounded_send(PtyEvent::Title(self.id, title));
            }
            Event::ResetTitle => {
                let _ = self
                    .tx
                    .unbounded_send(PtyEvent::Title(self.id, String::new()));
            }
            Event::Bell => {
                let _ = self.tx.unbounded_send(PtyEvent::Bell(self.id));
            }
            Event::ChildExit(status) => {
                *self.code.lock() = Some(status.code().unwrap_or(-1));
                self.exited.store(true, Ordering::Release);
                let _ = self.tx.unbounded_send(PtyEvent::Exit(self.id));
            }
            Event::Exit => {
                self.exited.store(true, Ordering::Release);
                let _ = self.tx.unbounded_send(PtyEvent::Exit(self.id));
            }
            _ => {}
        }
    }
}

/// A running shell.
pub struct Pty {
    pub id: u64,
    pub term: Arc<FairMutex<Term<Listener>>>,
    /// The shell's process id (session restore asks Lua for its cwd; busy check).
    pub pid: u32,
    sender: Option<EventLoopSender>,
    size: Arc<Mutex<WindowSize>>,
    dirty: Arc<AtomicBool>,
    /// The shell exited (its I/O thread is ending).
    exited: Arc<AtomicBool>,
    /// Its exit code, once it exited (-1: killed by a signal).
    code: Arc<Mutex<Option<i32>>>,
    /// The fewest rows the grid keeps while held ([`Pty::hold_rows`]); 0: none.
    floor: AtomicU16,
}

/// How long a closed tab's shell gets after SIGHUP before its process group is killed, and how
/// long after that before the I/O thread is stopped anyway.
const HANGUP_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Marks the app's own file descriptors close-on-exec, so a shell (and its jobs) doesn't inherit
/// them: frameworks open some without O_CLOEXEC (Metal's shader cache files). The app never
/// passes fds to children that way (nvim / git get explicit pipes).
fn close_app_fds_on_exec() {
    // SAFETY: fcntl on descriptor numbers; unknown ones fail with EBADF and are skipped.
    unsafe {
        let max = libc::getdtablesize().clamp(0, 4096);
        for fd in 3..max {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

fn wait_flag(flag: &AtomicBool, max: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    while !flag.load(Ordering::Acquire) {
        if start.elapsed() >= max {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    true
}

impl Pty {
    pub fn spawn(id: u64, spec: Spawn, tx: UnboundedSender<PtyEvent>) -> std::io::Result<Pty> {
        let size = WindowSize {
            num_lines: spec.rows.max(1),
            num_cols: spec.cols.max(2),
            cell_width: spec.cell_width.max(1),
            cell_height: spec.cell_height.max(1),
        };
        let options = tty::Options {
            shell: Some(tty::Shell::new(spec.program, spec.args)),
            working_directory: Some(spec.cwd),
            drain_on_exit: true,
            env: spec.env,
        };
        close_app_fds_on_exec();
        let pty = tty::new(&options, size, id)?;
        let pid = pty.child().id();
        let dirty = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let code = Arc::new(Mutex::new(None));
        let sender_slot = Arc::new(OnceLock::new());
        let shared_size = Arc::new(Mutex::new(size));
        let listener = Listener {
            id,
            tx,
            dirty: dirty.clone(),
            sender: sender_slot.clone(),
            size: shared_size.clone(),
            exited: exited.clone(),
            code: code.clone(),
        };
        let config = Config {
            scrolling_history: SCROLLBACK,
            // CSI > u / < u / ? u (progressive enhancement), like nvim's :terminal: TUIs that
            // ask get Shift+Enter, Ctrl+I vs Tab ... apart (keys::encode)
            kitty_keyboard: true,
            ..Config::default()
        };
        let dims = TermSize::new(size.num_cols as usize, size.num_lines as usize);
        let term = Arc::new(FairMutex::new(Term::new(config, &dims, listener.clone())));
        let event_loop = EventLoop::new(term.clone(), listener, pty, true, false)?;
        let sender = event_loop.channel();
        let _ = sender_slot.set(sender.clone());
        // detached: it ends with the shell (or on Shutdown) and drops the PTY there
        drop(event_loop.spawn());
        Ok(Pty {
            id,
            term,
            pid,
            sender: Some(sender),
            size: shared_size,
            dirty,
            exited,
            code,
            floor: AtomicU16::new(0),
        })
    }

    /// Bytes to the shell.
    pub fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(Msg::Input(bytes.into()));
        }
    }

    /// New grid size (the island resized); no-op when unchanged. Never fewer rows than held.
    pub fn resize(&self, cols: u16, rows: u16, cell_width: u16, cell_height: u16) {
        let ws = WindowSize {
            num_lines: rows.max(self.floor.load(Ordering::Acquire)).max(1),
            num_cols: cols.max(2),
            cell_width: cell_width.max(1),
            cell_height: cell_height.max(1),
        };
        {
            let mut size = self.size.lock();
            if size.num_lines == ws.num_lines && size.num_cols == ws.num_cols {
                return;
            }
            *size = ws;
        }
        self.term
            .lock()
            .resize(TermSize::new(ws.num_cols as usize, ws.num_lines as usize));
        if let Some(sender) = &self.sender {
            let _ = sender.send(Msg::Resize(ws));
        }
    }

    /// The grid keeps at least `rows` rows, taller at once when shorter, until
    /// [`Pty::release_rows`]: a TUI driven through its PTY draws all of its screen even in a short
    /// island (the island shows its top; decision 30).
    pub fn hold_rows(&self, rows: u16) {
        self.floor.store(rows, Ordering::Release);
        let s = *self.size.lock();
        if s.num_lines < rows {
            self.resize(s.num_cols, rows, s.cell_width, s.cell_height);
        }
    }

    /// The grid fits its island again from the next frame on (the program's next output draws one).
    pub fn release_rows(&self) {
        self.floor.store(0, Ordering::Release);
    }

    /// (cols, rows) of the grid.
    pub fn size(&self) -> (u16, u16) {
        let s = self.size.lock();
        (s.num_cols, s.num_lines)
    }

    /// The program's exit code once it exited (-1: killed by a signal).
    pub fn exit_code(&self) -> Option<i32> {
        *self.code.lock()
    }

    /// Output came since the last call (re-arms the next [`PtyEvent::Wakeup`]).
    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::AcqRel)
    }
}

impl Pty {
    /// SIGHUP to the program's process group (the program is a session leader: pgid = pid), like
    /// a terminal window closing / Lua's jobstop. The I/O thread keeps reading, so a program busy
    /// writing its exit never blocks on a full PTY; it ends with the program's exit and reaps it.
    /// One that ignores the hangup is killed after a grace; the I/O thread is stopped only if
    /// even that didn't end it. An exited one just stops its I/O thread.
    pub fn hang_up(&self) {
        let Some(sender) = self.sender.as_ref() else {
            return;
        };
        if self.exited.load(Ordering::Acquire) {
            let _ = sender.send(Msg::Shutdown);
            return;
        }
        let pgid = self.pid as libc::pid_t;
        // SAFETY: signals to the program's own process group (no memory involved)
        unsafe {
            libc::kill(-pgid, libc::SIGHUP);
            libc::kill(pgid, libc::SIGHUP);
        }
        let exited = self.exited.clone();
        let sender = sender.clone();
        let _ = std::thread::Builder::new()
            .name("PTY hangup".into())
            .spawn(move || {
                if wait_flag(&exited, HANGUP_GRACE) {
                    return;
                }
                // SAFETY: as above
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                    libc::kill(pgid, libc::SIGKILL);
                }
                if !wait_flag(&exited, KILL_GRACE) {
                    let _ = sender.send(Msg::Shutdown);
                }
            });
    }
}

impl Drop for Pty {
    /// The tab closed: the program hung up ([`Pty::hang_up`]).
    fn drop(&mut self) {
        self.hang_up();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_spawn_runs_env_i_with_only_its_own_variables() {
        let env = [
            ("PATH".to_owned(), "/bin".to_owned()),
            ("A".to_owned(), "x=y".to_owned()),
        ]
        .into_iter()
        .collect();
        let s = Spawn::clean(
            "claude",
            &["-p".into()],
            "/tmp".into(),
            &env,
            (80, 24),
            (8, 18),
        );
        assert_eq!(s.program, "/usr/bin/env");
        assert_eq!(s.args, ["-i", "A=x=y", "PATH=/bin", "claude", "-p"]);
        assert!(s.env.is_empty());
    }
}
