//! Single instance: `vimstorm <path>` while the app runs hands the path to it over a unix socket,
//! and the app opens or switches to that project (or opens the file in its project) and comes to
//! the front.
//!
//! The binary is its own client: before any GPUI / nvim start it tries the socket ([`hand_off`])
//! and exits once the running app accepted the path. Otherwise it binds the socket ([`bind`];
//! binding is the lock: of two quick launches only one becomes the server) and becomes the app.
//!
//! Protocol, one JSON line each way: `{"v":1,"open":"<abs path>"}` -> `{"ok":true}` or
//! `{"ok":false,"error":"..."}` (other fields are ignored: 1.x's `"abe":true` just opens). Opening
//! an existing absolute path is the one request (1.x's `abe cli` hand-off is gone). The socket is
//! user-only (0600, peer uid checked).

use std::ffi::OsString;
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::io::AsRawFd as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc;
use serde::{Deserialize, Serialize};

/// Protocol version; a request with another one is refused (an old CLI vs a new app).
pub const PROTOCOL: u32 = 1;
/// The socket path override (tests, several dev builds side by side).
pub const SOCKET_ENV: &str = "VIMSTORM_SOCKET";
/// `VIMSTORM_NO_INSTANCE=1`: neither hand off nor serve (screenshots, benches, debugging next to
/// the installed app).
pub const NO_INSTANCE_ENV: &str = "VIMSTORM_NO_INSTANCE";
/// macOS `sun_path` is 104 bytes, NUL included.
const SUN_PATH_MAX: usize = 103;
/// How long the client waits for the app's answer (it answers once the open has started).
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the server waits for a connected client's request line.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// Longest request line accepted (a path is well under this).
const MAX_LINE: u64 = 64 * 1024;

/// Whether this process takes part (see [`NO_INSTANCE_ENV`]). One-off runs (screenshots, the key
/// bench) never do: they must not hand their path to the user's running app.
pub fn enabled() -> bool {
    let off = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty() && v != "0");
    !(off(NO_INSTANCE_ENV) || off("VIMSTORM_SHOT") || off("VIMSTORM_BENCH_KEYS"))
}

/// The socket: `$VIMSTORM_SOCKET`, else `~/Library/Application Support/VimStorm/vimstorm.sock`,
/// else (path too long for a socket) `$TMPDIR/vimstorm-<uid>.sock`.
pub fn socket_path() -> PathBuf {
    socket_path_from(
        std::env::var_os(SOCKET_ENV),
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("TMPDIR").map(PathBuf::from),
        // SAFETY: getuid has no preconditions and can't fail.
        unsafe { libc::getuid() },
    )
}

fn socket_path_from(
    env: Option<OsString>,
    home: Option<PathBuf>,
    tmpdir: Option<PathBuf>,
    uid: u32,
) -> PathBuf {
    if let Some(p) = env.filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(home) = home {
        let p = home.join("Library/Application Support/VimStorm/vimstorm.sock");
        if p.as_os_str().len() <= SUN_PATH_MAX {
            return p;
        }
    }
    tmpdir
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(format!("vimstorm-{uid}.sock"))
}

/// One request: open `open`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    pub open: String,
}

/// A request line as the server reads it.
#[derive(Deserialize)]
struct Wire {
    v: u32,
    #[serde(default)]
    open: Option<String>,
}

/// The app's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    fn from_result(r: Result<(), String>) -> Self {
        match r {
            Ok(()) => Response {
                ok: true,
                error: None,
            },
            Err(e) => Response {
                ok: false,
                error: Some(e),
            },
        }
    }
}

/// The request line (newline included) for `path`.
pub fn encode_request(path: &Path) -> String {
    let req = Request {
        v: PROTOCOL,
        open: path.to_string_lossy().into_owned(),
    };
    // a struct of a number and a string always serializes
    let mut line = serde_json::to_string(&req).unwrap_or_default();
    line.push('\n');
    line
}

/// The path a request line asks for, validated ([`validate`]).
pub fn decode_request(line: &str) -> Result<Target, String> {
    let req: Wire = serde_json::from_str(line.trim()).map_err(|e| format!("bad request: {e}"))?;
    if req.v != PROTOCOL {
        return Err(format!(
            "protocol version {} not supported (the app speaks {PROTOCOL}): update the vimstorm command",
            req.v
        ));
    }
    match req.open {
        Some(open) => validate(Path::new(&open)),
        None => Err("bad request: no open".into()),
    }
}

/// What to open: a project dir or a file, canonical.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Dir(PathBuf),
    File(PathBuf),
}

impl Target {
    pub fn path(&self) -> &Path {
        match self {
            Target::Dir(p) | Target::File(p) => p,
        }
    }
}

/// Only existing absolute paths; symlinks resolved (the project is its real dir, as on startup).
pub fn validate(path: &Path) -> Result<Target, String> {
    if !path.is_absolute() {
        return Err(format!("not an absolute path: {}", path.display()));
    }
    let real = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if real.is_dir() {
        Ok(Target::Dir(real))
    } else if real.is_file() {
        Ok(Target::File(real))
    } else {
        Err(format!("not a file or directory: {}", path.display()))
    }
}

/// [`validate`]s `path` and finds a file's [`git_root`], off the UI thread (stats, a git process).
pub async fn locate(
    path: PathBuf,
    cx: &gpui_kit::AsyncApp,
) -> Result<(Target, Option<PathBuf>), String> {
    cx.background_executor()
        .spawn(async move {
            let target = validate(&path)?;
            let git = match &target {
                Target::File(f) => git_root(f),
                Target::Dir(_) => None,
            };
            Ok((target, git))
        })
        .await
}

/// The git work tree containing `file`: the nearest ancestor with a `.git` dir (or a worktree's /
/// submodule's `.git` file), what `git rev-parse --show-toplevel` finds, without running git (a
/// process: ~10 ms on the startup path of `vimstorm <file>`). None outside one.
pub fn git_root(file: &Path) -> Option<PathBuf> {
    let root = file
        .parent()?
        .ancestors()
        .find(|d| d.join(".git").exists())?
        .to_path_buf();
    // compare real paths like with like
    let root = crate::shell::real_path(&root);
    // a dotfiles repo in home (or one at /) isn't the file's project: its dir is
    let home = crate::shell::real_path(&crate::shell::home());
    (!crate::shell::not_a_project_root(&root, &home)).then_some(root)
}

/// The project `file` opens in: the open project containing it (the deepest one), else its git
/// work tree, else its dir.
pub fn project_for_file(file: &Path, open: &[PathBuf], git_root: Option<&Path>) -> PathBuf {
    open.iter()
        .filter(|p| file.starts_with(p) && file != p.as_path())
        .max_by_key(|p| p.components().count())
        .cloned()
        .or_else(|| {
            git_root
                .filter(|r| file.starts_with(r))
                .map(Path::to_path_buf)
        })
        .or_else(|| file.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// A validated request on its way to the UI thread. `git_root` is looked up on the server thread
/// for files (it runs git), so the UI thread only picks the project.
#[derive(Debug)]
pub struct Incoming {
    pub target: Target,
    pub git_root: Option<PathBuf>,
    /// The waiting client; None for paths from the platform (Finder, dock, `open -a`).
    reply: Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
}

impl Incoming {
    /// The project dir and the file to open in it, given the open projects.
    pub fn resolve(&self, open: &[PathBuf]) -> (PathBuf, Option<PathBuf>) {
        match &self.target {
            Target::Dir(d) => (d.clone(), None),
            Target::File(f) => (
                project_for_file(f, open, self.git_root.as_deref()),
                Some(f.clone()),
            ),
        }
    }

    /// Answers the client: Ok once the app took the path.
    pub fn reply(self, result: Result<(), String>) {
        match self.reply {
            Some(tx) => {
                let _ = tx.send(result);
            }
            None => {
                if let Err(e) = result {
                    eprintln!("[vimstorm] opening {}: {e}", self.target.path().display());
                }
            }
        }
    }

    /// A request without a client (tests; the platform's open events).
    pub fn local(target: Target, git_root: Option<PathBuf>) -> Self {
        Incoming {
            target,
            git_root,
            reply: None,
        }
    }
}

/// What the client got.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Handoff {
    /// The running app took the path.
    Accepted,
    /// No app is listening (no socket, or a stale one).
    NotRunning,
    /// The app refused it (bad path, protocol version...).
    Rejected(String),
}

/// Hands `path` (absolute) to the running app.
pub fn hand_off(socket: &Path, path: &Path, timeout: Duration) -> io::Result<Handoff> {
    let Some(mut stream) = connect(socket)? else {
        return Ok(Handoff::NotRunning);
    };
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(encode_request(path).as_bytes())?;
    let mut line = String::new();
    BufReader::new(&stream)
        .take(MAX_LINE)
        .read_line(&mut line)?;
    if line.is_empty() {
        // the app closed without answering: quitting, or a server that died mid-request
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the running VimStorm closed the connection without an answer",
        ));
    }
    let resp: Response = serde_json::from_str(line.trim())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad answer: {e}")))?;
    Ok(if resp.ok {
        Handoff::Accepted
    } else {
        Handoff::Rejected(resp.error.unwrap_or_else(|| "refused".into()))
    })
}

/// The running app's socket; none when nobody listens there, a path too long for a socket
/// included (no app could bind it).
fn connect(socket: &Path) -> io::Result<Option<UnixStream>> {
    if socket.as_os_str().len() > SUN_PATH_MAX {
        return Ok(None);
    }
    match UnixStream::connect(socket) {
        Ok(s) => Ok(Some(s)),
        Err(e) if not_running(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Connect errors meaning nobody listens there.
fn not_running(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

/// What `main` does after [`startup`].
#[derive(Debug)]
pub enum Startup {
    /// The running app took the path (exit 0) or refused it (exit 1, message printed).
    Exit(i32),
    /// Become the app; serve the socket once the window is up (None: single instance off or the
    /// socket couldn't be bound: the app still runs, just without hand-off).
    App(Option<Server>),
}

/// The client step at the very top of `main` (before nvim / GPUI): hands the argument (else the
/// cwd) to a running app, else binds the socket for this one. A LaunchServices launch without a
/// path (cwd `/`) hands nothing off. `VIMSTORM_TIMING=1` prints the hand-off time.
pub fn startup(arg: Option<&Path>) -> Startup {
    if !enabled() {
        return Startup::App(None);
    }
    let started = std::time::Instant::now();
    let socket = socket_path();
    let path = match arg {
        Some(p) => Some(std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())),
        None => std::env::current_dir().ok().filter(|d| d != Path::new("/")),
    };
    // two rounds: a launch that lost the bind race to another one hands off to the winner
    for _ in 0..2 {
        let handed = match &path {
            Some(path) => hand_off(&socket, path, ANSWER_TIMEOUT),
            None => Ok(Handoff::NotRunning),
        };
        match handed {
            Ok(Handoff::Accepted) => {
                if std::env::var_os("VIMSTORM_TIMING").is_some() {
                    eprintln!("[vimstorm] handed off in {:?}", started.elapsed());
                }
                return Startup::Exit(0);
            }
            Ok(Handoff::Rejected(e)) => {
                eprintln!("vimstorm: {e}");
                return Startup::Exit(1);
            }
            Ok(Handoff::NotRunning) => {}
            Err(e) => {
                let p = path.as_deref().unwrap_or(Path::new("")).display();
                eprintln!("vimstorm: the running VimStorm didn't take {p}: {e}");
                return Startup::Exit(1);
            }
        }
        match bind(&socket) {
            Ok(Bind::Bound(server)) => return Startup::App(Some(server)),
            Ok(Bind::Running) if path.is_none() => {
                eprintln!("[vimstorm] already running");
                return Startup::Exit(0);
            }
            Ok(Bind::Running) => continue,
            Err(e) => {
                eprintln!("[vimstorm] single instance off: {}: {e}", socket.display());
                return Startup::App(None);
            }
        }
    }
    eprintln!(
        "[vimstorm] single instance off: another VimStorm holds {}",
        socket.display()
    );
    Startup::App(None)
}

/// `vimstorm --remote <path>` (the CLI script): only hands off. Exit 0 = the app took it,
/// 1 = refused / error (printed), 3 = no app running (the script then starts one). None: no
/// `--remote` flag.
pub fn remote_main() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().is_none_or(|a| a != "--remote") {
        return None;
    }
    let Some(path) = args.next().map(PathBuf::from) else {
        eprintln!("usage: vimstorm --remote <path>");
        return Some(2);
    };
    let path = std::path::absolute(&path).unwrap_or(path);
    Some(match hand_off(&socket_path(), &path, ANSWER_TIMEOUT) {
        Ok(Handoff::Accepted) => 0,
        Ok(Handoff::NotRunning) => 3,
        Ok(Handoff::Rejected(e)) => {
            eprintln!("vimstorm: {e}");
            1
        }
        Err(e) => {
            eprintln!(
                "vimstorm: the running VimStorm didn't take {}: {e}",
                path.display()
            );
            1
        }
    })
}

/// The path argument (`-psn_…` from old LaunchServices skipped).
pub fn launch_args(args: &[OsString]) -> Option<PathBuf> {
    args.get(1)
        .filter(|a| !a.to_string_lossy().starts_with("-psn_"))
        .map(PathBuf::from)
}

/// The startup project and the file to open in it, from the argument: a dir is the project; a
/// file opens in its git work tree (else its dir). No argument: the cwd, except when launched by
/// LaunchServices (Finder, Dock, `open`: cwd `/`): the most recent project, else the home dir.
pub fn startup_project(arg: Option<&Path>) -> io::Result<(PathBuf, Option<PathBuf>)> {
    let Some(arg) = arg else {
        let cwd = std::env::current_dir()?;
        if cwd != Path::new("/") {
            return Ok((cwd, None));
        }
        let recent = crate::shell::recent()
            .into_iter()
            .find(|p| p.opened.is_some() && p.path.is_dir())
            .map(|p| p.path);
        let home = std::env::var_os("HOME").map(PathBuf::from);
        return Ok((recent.or(home).unwrap_or(cwd), None));
    };
    let real = arg.canonicalize()?;
    if real.is_dir() {
        return Ok((real, None));
    }
    let project = project_for_file(&real, &[], git_root(&real).as_deref());
    Ok((project, Some(real)))
}

/// The bound socket, not yet serving. Dropping it removes the socket file.
#[derive(Debug)]
pub struct Server {
    listener: UnixListener,
    guard: SocketFile,
}

/// Removes the socket file when dropped (app quit; [`ServerHandle::remove`]), if it's still the
/// one this process bound (dev / inode): a socket another instance bound there since stays.
#[derive(Debug)]
struct SocketFile(PathBuf, Option<(u64, u64)>);

impl SocketFile {
    fn new(path: &Path) -> Self {
        SocketFile(path.to_path_buf(), file_id(path))
    }
}

fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt as _;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|m| (m.dev(), m.ino()))
}

impl Drop for SocketFile {
    fn drop(&mut self) {
        if self.1.is_some() && file_id(&self.0) == self.1 {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Result of [`bind`].
#[derive(Debug)]
pub enum Bind {
    /// This process is the instance.
    Bound(Server),
    /// Another live instance listens there.
    Running,
}

/// Binds the socket: binding is the lock. A stale file (no listener: a crash, a SIGKILL) is
/// removed and rebound. The stale check + rebind run under an flock on `<socket>.lock`, so two
/// launches racing on a stale socket can't both end up listening.
pub fn bind(socket: &Path) -> io::Result<Bind> {
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let lock_path = lock_path(socket);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    let _ = std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600));
    // SAFETY: flock on a file descriptor we own; released on close (end of this function).
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => match UnixStream::connect(socket) {
            Ok(_) => return Ok(Bind::Running),
            Err(c) if not_running(&c) => {
                std::fs::remove_file(socket)?;
                UnixListener::bind(socket)?
            }
            Err(c) => return Err(c),
        },
        Err(e) => return Err(e),
    };
    // (the guard first: a failed chmod removes the file again)
    let guard = SocketFile::new(socket);
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(Bind::Bound(Server { listener, guard }))
}

fn lock_path(socket: &Path) -> PathBuf {
    let mut p = socket.as_os_str().to_owned();
    p.push(".lock");
    PathBuf::from(p)
}

/// The serving socket: requests arrive on [`ServerHandle::requests`].
pub struct ServerHandle {
    pub requests: mpsc::UnboundedReceiver<Incoming>,
    guard: SocketFile,
}

impl ServerHandle {
    /// Removes the socket file now (app quit): later clients start their own app.
    pub fn remove(self) {
        drop(self.guard);
    }
}

impl Server {
    /// Starts the accept thread. Requests are validated there (and a file's git root looked up),
    /// then sent to [`ServerHandle::requests`]; the client gets the answer given with
    /// [`Incoming::reply`].
    /// Each connection gets a thread of its own.
    pub fn serve(self) -> io::Result<ServerHandle> {
        let (tx, rx) = mpsc::unbounded();
        let Server { listener, guard } = self;
        std::thread::Builder::new()
            .name("instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    if let Ok(stream) = stream {
                        let tx = tx.clone();
                        // an error only means that client went away
                        let _ = std::thread::Builder::new()
                            .name("instance-client".into())
                            .spawn(move || serve_one(stream, &tx));
                    }
                    if tx.is_closed() {
                        break;
                    }
                }
            })?;
        Ok(ServerHandle {
            requests: rx,
            guard,
        })
    }
}

/// One connection: request line in, answer line out. Errors only mean the client went away.
fn serve_one(stream: UnixStream, tx: &mpsc::UnboundedSender<Incoming>) -> io::Result<()> {
    stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
    stream.set_write_timeout(Some(REQUEST_TIMEOUT))?;
    let result = if !same_user(&stream) {
        Err("refused: another user".to_string())
    } else {
        let mut line = String::new();
        BufReader::new(&stream)
            .take(MAX_LINE)
            .read_line(&mut line)?;
        decode_request(&line).and_then(|target| to_ui(target, tx))
    };
    let mut out = serde_json::to_string(&Response::from_result(result)).unwrap_or_default();
    out.push('\n');
    (&stream).write_all(out.as_bytes())
}

/// An open handed to the UI thread; its answer once the app took it.
fn to_ui(target: Target, tx: &mpsc::UnboundedSender<Incoming>) -> Result<(), String> {
    let git_root = match &target {
        Target::File(f) => git_root(f),
        Target::Dir(_) => None,
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    let incoming = Incoming {
        target,
        git_root,
        reply: Some(reply),
    };
    if tx.unbounded_send(incoming).is_err() {
        return Err("VimStorm is quitting".to_string());
    }
    answer
        .recv_timeout(ANSWER_TIMEOUT)
        .unwrap_or_else(|_| Err("VimStorm didn't answer".to_string()))
}

/// The peer runs as this user (the socket is 0600 already; belt and braces).
pub(crate) fn same_user(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: getpeereid writes two ids for a connected unix socket fd we own.
    let r = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    // SAFETY: getuid has no preconditions.
    r == 0 && uid == unsafe { libc::getuid() }
}

/// Serves the socket with [`open`] (main.rs, once the projects window is up).
pub fn serve(server: Server, cx: &mut gpui_kit::App) {
    match server.serve() {
        Ok(handle) => attach(handle, open, cx),
        Err(e) => eprintln!("[vimstorm] single instance off: {e}"),
    }
}

/// Runs `handle` on the UI thread for every request until the app quits. `handle` opens the
/// path and answers with [`Incoming::reply`].
pub fn attach(
    server: ServerHandle,
    handle: impl Fn(Incoming, &mut gpui_kit::App) + 'static,
    cx: &mut gpui_kit::App,
) {
    let ServerHandle {
        mut requests,
        guard,
    } = server;
    // the socket goes with the app: removed on quit, so a later `vimstorm` starts a new app
    let guard = std::rc::Rc::new(std::cell::RefCell::new(Some(guard)));
    let on_quit = guard.clone();
    cx.on_app_quit(move |_| {
        on_quit.borrow_mut().take();
        async {}
    })
    .detach();
    cx.spawn(async move |cx| {
        // the task (and with it the guard) lives as long as the app
        while let Some(req) = requests.next().await {
            cx.update(|cx| handle(req, cx));
        }
        drop(guard);
    })
    .detach();
}

/// Opens a request in the projects window (switching to its project, or starting it) and brings
/// the window to the front; the client gets the outcome.
pub fn open(req: Incoming, cx: &mut gpui_kit::App) {
    use crate::shell::projects::{self, OpenRequest};
    let (dir, file) = req.resolve(&projects::open_dirs(cx));
    let result = projects::open_path(OpenRequest { dir, file }, cx).map_err(|e| format!("{e:#}"));
    if result.is_ok() {
        bring_to_front(cx);
    }
    req.reply(result);
}

/// The app and its window in front (also un-minimizes it). Not with `VIMSTORM_BACKGROUND` (tests
/// next to the user's work). macOS 14+ may ignore this while another app is frontmost: the CLI
/// script also asks LaunchServices (`open -a`), which is honoured.
pub fn bring_to_front(cx: &mut gpui_kit::App) {
    if std::env::var_os("VIMSTORM_BACKGROUND").is_some() {
        return;
    }
    cx.activate(true);
    if let Some(w) = crate::shell::projects::window(cx) {
        let _ = w.update(cx, |_, window, _| window.activate_window());
    }
}

/// Paths the platform asks the app to open (`open -a VimStorm <path>`, Finder "Open With", dock
/// drops), as `file://` URLs. Register with [`platform_hooks`] before `run`; launch-time ones
/// arrive before `run`'s callback and wait here until [`UrlInbox::serve`].
pub struct UrlInbox(mpsc::UnboundedReceiver<Vec<String>>);

/// Registers the platform's open-URLs (-> the returned inbox) and reopen (dock click: the window
/// to the front) handlers. Call before `Application::run`.
pub fn platform_hooks(app: &gpui_kit::Application) -> UrlInbox {
    let (tx, rx) = mpsc::unbounded();
    app.on_open_urls(move |urls| {
        let _ = tx.unbounded_send(urls);
    });
    app.on_reopen(bring_to_front);
    UrlInbox(rx)
}

impl UrlInbox {
    /// Paths the platform already delivered (a cold `open -a VimStorm <dir>`: before the app's
    /// first window), without waiting.
    pub fn drain(&mut self) -> Vec<PathBuf> {
        let mut urls = Vec::new();
        while let Ok(u) = self.0.try_recv() {
            urls.extend(u);
        }
        paths_from_urls(&urls)
    }

    /// The next delivery's paths (None: the platform hook is gone).
    pub async fn next(&mut self) -> Option<Vec<PathBuf>> {
        let urls = self.0.next().await?;
        Some(paths_from_urls(&urls))
    }

    /// Opens every path (queued and later) like a socket request ([`open`]); git roots looked up off the UI
    /// thread.
    pub fn serve(self, cx: &mut gpui_kit::App) {
        let mut rx = self.0;
        cx.spawn(async move |cx| {
            while let Some(urls) = rx.next().await {
                for path in paths_from_urls(&urls) {
                    match locate(path, cx).await {
                        Ok((target, git)) => cx.update(|cx| open(Incoming::local(target, git), cx)),
                        Err(e) => eprintln!("[vimstorm] open: {e}"),
                    }
                }
            }
        })
        .detach();
    }
}

/// Paths from `file://` URLs (`open -a VimStorm <path>`, Finder "Open With", dock drops), others
/// dropped.
pub fn paths_from_urls(urls: &[String]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|u| u.strip_prefix("file://"))
        .map(|p| {
            // file://localhost/... is valid too
            let p = p.strip_prefix("localhost").unwrap_or(p);
            PathBuf::from(percent_decode(p.trim_end_matches('/')))
        })
        .filter(|p| p.is_absolute())
        .collect()
}

/// `%xx` escapes of a URL path (NSURL escapes spaces and non-ASCII).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The locale a launch without one gets (en_US: English messages from git and the tools, like
/// the C locale they had, but UTF-8).
pub const FALLBACK_LANG: &str = "en_US.UTF-8";

/// `LANG` for the app when nothing in its environment picks a locale (`get`: an env var). A Dock
/// / Finder launch has none (LaunchServices sets no LANG): nvim and the terminal's shells (zsh's
/// line editor, `ls`, git) would treat åäö as bytes. Ghostty used to set it. An explicit
/// `LC_ALL` / `LC_CTYPE` / `LANG` stays.
pub fn locale_fallback(get: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let set = |k: &str| get(k).is_some_and(|v| !v.is_empty());
    (!set("LC_ALL") && !set("LC_CTYPE") && !set("LANG")).then_some(FALLBACK_LANG)
}

/// The signals that save all and quit the app: SIGTERM, plus SIGINT / SIGHUP unless they were
/// ignored when it started. The CLI script starts the app with `nohup … &` (SIGHUP ignored; a
/// non-interactive shell's `&` ignores SIGINT): hooking them would override that, so a Ctrl+C in
/// the script's terminal or a HUP after it closed would quit the app it just started.
pub fn quit_signals() -> Vec<i32> {
    let ignored = |sig: i32| {
        // SAFETY: a query only (no new action); `old` is a valid, zeroed out-parameter.
        unsafe {
            let mut old: libc::sigaction = std::mem::zeroed();
            libc::sigaction(sig, std::ptr::null(), &mut old) == 0
                && old.sa_sigaction == libc::SIG_IGN
        }
    };
    [libc::SIGTERM, libc::SIGINT, libc::SIGHUP]
        .into_iter()
        .filter(|&s| s == libc::SIGTERM || !ignored(s))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        // short base: sun_path is 104 bytes and $TMPDIR is long on macOS
        tempfile::Builder::new()
            .prefix("vsi")
            .tempdir_in("/tmp")
            .unwrap()
    }

    /// (name, env, the fallback locale; None: the env has one)
    type Locale = (
        &'static str,
        &'static [(&'static str, &'static str)],
        Option<&'static str>,
    );

    const LOCALES: &[Locale] = &[
        ("no locale", &[], Some("en_US.UTF-8")),
        ("an empty LANG", &[("LANG", "")], Some("en_US.UTF-8")),
        ("LANG set", &[("LANG", "sv_SE.UTF-8")], None),
        ("LC_CTYPE set", &[("LC_CTYPE", "UTF-8")], None),
        ("LC_ALL set", &[("LC_ALL", "C")], None),
    ];

    #[test]
    fn a_launch_without_a_locale_gets_a_utf8_one() {
        for (name, env, want) in LOCALES {
            let got = locale_fallback(|k: &str| {
                env.iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            });
            assert_eq!(got, *want, "{name}");
        }
    }

    #[test]
    fn ignored_hup_and_int_stay_ignored() {
        assert!(quit_signals().contains(&libc::SIGTERM));
        // SAFETY: swaps SIGHUP's disposition and puts the old one back; nothing in the test
        // process sends SIGHUP meanwhile.
        let old = unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) };
        let with_nohup = quit_signals();
        // SAFETY: restores the disposition saved above (same contract as that call).
        unsafe { libc::signal(libc::SIGHUP, old) };
        assert!(!with_nohup.contains(&libc::SIGHUP), "{with_nohup:?}");
        assert!(with_nohup.contains(&libc::SIGTERM));
        if old != libc::SIG_IGN {
            assert!(quit_signals().contains(&libc::SIGHUP));
        }
    }

    #[test]
    fn a_request_and_its_answer_are_one_json_line_each() {
        let line = encode_request(Path::new("/tmp"));
        assert_eq!(line, "{\"v\":1,\"open\":\"/tmp\"}\n");
        let t = decode_request(&line).unwrap();
        assert_eq!(t, Target::Dir(Path::new("/tmp").canonicalize().unwrap()));
        let ok = serde_json::to_string(&Response::from_result(Ok(()))).unwrap();
        assert_eq!(ok, "{\"ok\":true}");
        let err = serde_json::to_string(&Response::from_result(Err("x".into()))).unwrap();
        assert_eq!(err, "{\"ok\":false,\"error\":\"x\"}");
    }

    #[test]
    fn a_path_is_absolute_existing_and_resolved_through_symlinks() {
        let d = tmp();
        let f = d.path().join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let real = d.path().canonicalize().unwrap();
        assert_eq!(validate(d.path()).unwrap(), Target::Dir(real.clone()));
        assert_eq!(validate(&f).unwrap(), Target::File(real.join("a.txt")));
        assert!(validate(Path::new("relative/x")).is_err());
        assert!(validate(&d.path().join("missing")).is_err());
        // symlinks resolve to the real path
        let link = d.path().join("link");
        std::os::unix::fs::symlink(&f, &link).unwrap();
        assert_eq!(validate(&link).unwrap(), Target::File(real.join("a.txt")));
    }

    #[test]
    fn the_socket_is_the_env_s_else_under_app_support_else_in_a_temp_dir() {
        let uid = 501;
        let env = Some(OsString::from("/tmp/x.sock"));
        assert_eq!(
            socket_path_from(env, None, None, uid),
            PathBuf::from("/tmp/x.sock")
        );
        let home = Some(PathBuf::from("/home/me"));
        assert_eq!(
            socket_path_from(Some(OsString::new()), home.clone(), None, uid),
            PathBuf::from("/home/me/Library/Application Support/VimStorm/vimstorm.sock")
        );
        let long = Some(PathBuf::from(format!("/home/{}", "x".repeat(80))));
        let tmpdir = Some(PathBuf::from("/var/folders/t/"));
        assert_eq!(
            socket_path_from(None, long, tmpdir, uid),
            PathBuf::from("/var/folders/t/vimstorm-501.sock")
        );
        assert_eq!(
            socket_path_from(None, None, None, uid),
            PathBuf::from("/tmp/vimstorm-501.sock")
        );
    }

    #[test]
    fn a_file_opens_in_the_deepest_open_project_else_its_git_root_else_its_folder() {
        let f = Path::new("/p/repo/sub/pkg/src/a.ts");
        let open = vec![
            PathBuf::from("/p/repo"),
            PathBuf::from("/p/repo/sub/pkg"),
            PathBuf::from("/p/other"),
        ];
        // deepest open project wins
        assert_eq!(
            project_for_file(f, &open, None),
            PathBuf::from("/p/repo/sub/pkg")
        );
        // no open one: the git root
        let git = Some(Path::new("/p/repo"));
        assert_eq!(project_for_file(f, &[], git), PathBuf::from("/p/repo"));
        // an open project beats the git root
        assert_eq!(
            project_for_file(f, &open[..1], Some(Path::new("/p/repo/sub"))),
            PathBuf::from("/p/repo")
        );
        // neither: the file's dir
        assert_eq!(
            project_for_file(f, &[], None),
            PathBuf::from("/p/repo/sub/pkg/src")
        );
        // a path prefix isn't a path component prefix
        let open = vec![PathBuf::from("/p/rep")];
        assert_eq!(
            project_for_file(f, &open, None),
            PathBuf::from("/p/repo/sub/pkg/src")
        );
    }

    #[test]
    fn a_file_s_git_root_is_the_nearest_git_dir_or_git_file() {
        let d = tmp();
        let repo = d.path().join("r");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(ok.success());
        let f = repo.join("src/a.txt");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(git_root(&f), Some(repo.canonicalize().unwrap()));
        let outside = d.path().join("b.txt");
        std::fs::write(&outside, "x").unwrap();
        assert_eq!(git_root(&outside), None);
        // a linked worktree / submodule: a `.git` file
        let wt = repo.join("src/wt");
        std::fs::create_dir_all(wt.join("lib")).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../../.git/worktrees/wt\n").unwrap();
        let f = wt.join("lib/b.txt");
        std::fs::write(&f, "x").unwrap();
        assert_eq!(git_root(&f), Some(wt.canonicalize().unwrap()));
    }

    #[test]
    fn bind_is_the_lock_and_dropping_it_removes_only_its_own_socket() {
        let d = tmp();
        let sock = d.path().join("s.sock");
        let Bind::Bound(first) = bind(&sock).unwrap() else {
            panic!("first bind should win");
        };
        let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(matches!(bind(&sock).unwrap(), Bind::Running));
        drop(first);
        assert!(!sock.exists(), "dropping the server removes the socket");
        let Bind::Bound(first) = bind(&sock).unwrap() else {
            panic!("bound again once free");
        };
        // someone removed it and another app bound the path meanwhile: its socket stays
        std::fs::remove_file(&sock).unwrap();
        let other = UnixListener::bind(&sock).unwrap();
        drop(first);
        assert!(sock.exists(), "the other instance's socket stays");
        drop(other);
    }

    #[test]
    fn racing_binds_over_a_stale_socket_have_one_winner() {
        let d = tmp();
        let sock = d.path().join("s.sock");
        // a stale socket file: bound once, listener gone, file left (as after a SIGKILL)
        let stale = UnixListener::bind(&sock).unwrap();
        drop(stale);
        assert!(sock.exists());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let sock = sock.clone();
                std::thread::spawn(move || bind(&sock).unwrap())
            })
            .collect();
        let results: Vec<Bind> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        let winners = results
            .iter()
            .filter(|b| matches!(b, Bind::Bound(_)))
            .count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn a_stale_or_missing_socket_is_not_running_and_a_stale_one_is_bound_again() {
        let d = tmp();
        let sock = d.path().join("s.sock");
        // the stale socket comes from another process: a listener bound here can leak into a
        // child another test spawns at that moment (macOS sets close-on-exec after `socket()`),
        // which keeps it listening after the drop (a connect, then EOF: the old flake)
        let made = std::process::Command::new("/usr/bin/python3")
            .args([
                "-c",
                "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
            ])
            .arg(&sock)
            .status()
            .unwrap();
        assert!(made.success() && sock.exists());
        assert_eq!(
            hand_off(&sock, Path::new("/tmp"), ANSWER_TIMEOUT).unwrap(),
            Handoff::NotRunning
        );
        assert!(matches!(bind(&sock).unwrap(), Bind::Bound(_)));
        // no socket at all
        let none = d.path().join("none.sock");
        assert_eq!(
            hand_off(&none, Path::new("/tmp"), ANSWER_TIMEOUT).unwrap(),
            Handoff::NotRunning
        );
    }

    #[test]
    fn file_urls_become_decoded_paths_and_other_urls_are_dropped() {
        let urls = vec![
            "file:///home/me/My%20Project/".to_string(),
            "file://localhost/tmp/a%C3%A5.txt".to_string(),
            "https://example.com".to_string(),
        ];
        assert_eq!(
            paths_from_urls(&urls),
            vec![
                PathBuf::from("/home/me/My Project"),
                PathBuf::from("/tmp/aå.txt")
            ]
        );
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
