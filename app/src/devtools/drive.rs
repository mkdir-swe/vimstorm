//! The drive socket (`--features shots`): `VIMSTORM_DRIVE=<socket>` starts the app offscreen
//! as a shot does (never shown, never takes focus, its own state: [`super::shot`]), but it stays
//! up and takes steps over a user-only unix socket (0600, the peer's uid checked), so a tester
//! drives a live app step by step, and many run side by side with no OS keystroke. Only the
//! shots build has it; the release binary has no such socket.
//!
//! One JSON line each way, `v` 1. `see` and `wait` only look: answered at once, side by side with
//! anything else (a 10-minute `wait` holds up no other client's `see`). Keys, shots, films and
//! quit play one at a time, in order (a second client waits its turn). Each request answers
//! within its [`Request::budget`], else `{"ok":false,"error":"stuck: …"}` and the next goes on:
//!
//! ```text
//! {"v":1,"keys":"{@super+alt+a}{@ö}{@enter}"}             → {"ok":true,"ms":412}
//! {"v":1,"type":"own words"}                             → {"ok":true,"ms":…}
//! {"v":1,"click":[640,312]}  ("dblclick", "move" too)     → {"ok":true,"ms":…}
//! {"v":1,"scroll":[0,-80]}   ([dx, dy] px, at the pointer) → {"ok":true,"ms":…}
//! {"v":1,"see":["main","layer"]}  (none: all)             → {"ok":true,"view":…,"trees":{…},"status":[…],"balloons":[…],"title":…}
//! {"v":1,"wait":{"text":"Needs you","in":"chat","ms":600000}} → {"ok":true,"ms":…} | {"ok":false,"error":"timeout",…see}
//! {"v":1,"wait":{"text":"Saving","gone":true}}
//! {"v":1,"shot":"/tmp/qr/a/shots/s12.png"}                → {"ok":true,"path":…}
//! {"v":1,"film":{"to":"…/f3/f3.png","frames":40,"every":100},"keys":"…"} → {"ok":true,"ms":…,"frames":40}
//! {"v":1,"quit":true}                                    → {"ok":true} (then the app quits)
//! ```
//!
//! - `keys` is `VIMSTORM_SHOT_KEYS`'s grammar ([`super::shot::steps`], one parser and one player,
//!   [`super::shot::play`]); an unknown `{@…}` key is refused before anything plays.
//! - `see`: the latest bridge `tree` per slot (`main`, `chat`, `pane`, `review`) and the `layer`, as the
//!   outline `abe ui render` prints ([`outline`]); `status` the status bar's widgets and the
//!   bridge's status line; `balloons` those up (`<title>: <body>`); `title` the window's; `view`
//!   `factory` or `editor`; `terminal` the bottom pane's Terminal while it shows ([`terminal_text`]:
//!   its tabs, the current one in `[…]`, then the shown tab's screen; empty while hidden). The Editor's text comes from nvim (`{lua:…:lua}` for that).
//! - `wait` looks every 100 ms ([`Seen::has`]) for the text in one part (`in`, else anywhere),
//!   or for it gone; `ms` defaults to 10 s. A timeout answers with what was seen.
//! - `film`'s frames are `<to stem>-0001.png …` beside `to`, with `<to stem>-frames.tsv` (as a
//!   shot's film); `{shot:<label>}` in keys saves `<socket stem>-<label>.png` beside the socket,
//!   or beside a film's `to`.
//! - The hidden window draws at a steady pace (`VIMSTORM_DRIVE_FPS`, default 10): balloons' timers,
//!   animations and anything waiting for a frame run as in a shown window.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

use super::shot::{self, Step};

/// `VIMSTORM_DRIVE=<socket>`: drive the app over this socket.
pub const ENV: &str = "VIMSTORM_DRIVE";
/// `VIMSTORM_DRIVE_FPS=<n>`: the hidden window's draws a second (default 10, 1..=60).
pub const FPS_ENV: &str = "VIMSTORM_DRIVE_FPS";
/// The protocol's version (`v`).
pub const VERSION: u64 = 1;
/// A `wait`'s default and longest time.
const WAIT_MS: u64 = 10_000;
const WAIT_MAX_MS: u64 = 4 * 3600 * 1000;
/// How often a `wait` looks.
const WAIT_EVERY: Duration = Duration::from_millis(100);
/// What every request's [`Request::budget`] adds to its own time.
const BUDGET_MARGIN: Duration = Duration::from_secs(30);
/// The longest request line.
const MAX_LINE: u64 = 1 << 20;

static SOCKET: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Call first thing in `main`, while the process has one thread: reads `VIMSTORM_DRIVE` and takes
/// it out of the env (children never serve it), and makes the run an offscreen shot
/// (`VIMSTORM_SHOT=<socket>.png` unless set: hidden window, own state, counted active).
pub fn prepare() {
    let sock = std::env::var_os(ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    if let Some(sock) = &sock {
        // SAFETY: first thing in main, before any thread exists (no concurrent env access)
        unsafe {
            std::env::remove_var(ENV);
            if std::env::var_os("VIMSTORM_SHOT").is_none() {
                std::env::set_var("VIMSTORM_SHOT", sock.with_extension("png"));
            }
        }
    }
    let _ = SOCKET.set(sock);
}

/// The socket this app is driven on, if it is.
pub fn socket() -> Option<&'static Path> {
    SOCKET.get().and_then(|s| s.as_deref())
}

/// The draw pace: `VIMSTORM_DRIVE_FPS` (1..=60), else 10.
pub fn fps(var: Option<&str>) -> u32 {
    var.and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(10)
        .min(60)
}

// ---------------------------------------------------------------- the protocol

/// The parts `see` and `wait` name.
pub const PARTS: [&str; 10] = [
    "main", "chat", "pane", "review", "layer", "status", "balloons", "title", "view", "terminal",
];

/// One request.
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    /// Keys (or a typed text, a click, a scroll as one step), with frames taken while they play.
    Steps {
        steps: Vec<Step>,
        film: Option<FilmAsk>,
    },
    /// The parts asked for (none: all).
    See(Vec<String>),
    Wait(WaitFor),
    Shot(PathBuf),
    Quit,
}

/// `film`: `frames` frames, one every `every` ms, beside `to` (a PNG path).
#[derive(Clone, Debug, PartialEq)]
pub struct FilmAsk {
    pub to: PathBuf,
    pub frames: u32,
    pub every: u64,
}

/// `wait`: `text` in `within` (a [`PARTS`] name; None: anywhere), or gone from it.
#[derive(Clone, Debug, PartialEq)]
pub struct WaitFor {
    pub text: String,
    pub within: Option<String>,
    pub gone: bool,
    pub ms: u64,
}

const FIELDS: [&str; 10] = [
    "v", "keys", "type", "click", "dblclick", "move", "scroll", "see", "wait", "shot",
];

/// Reads one request line; what it refuses says why (nothing has played then).
pub fn parse(line: &str) -> Result<Request, String> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|e| format!("not JSON: {e}"))?;
    let Value::Object(o) = value else {
        return Err("a request is a JSON object".into());
    };
    match o.get("v").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(v) => return Err(format!("v{v}: this app speaks v{VERSION}")),
        None => return Err("no \"v\":1".into()),
    }
    if let Some(bad) = o
        .keys()
        .find(|k| !FIELDS.contains(&k.as_str()) && *k != "film" && *k != "quit")
    {
        return Err(format!("unknown field {bad:?}"));
    }
    let asked: Vec<&str> = FIELDS[1..]
        .iter()
        .chain(["quit"].iter())
        .copied()
        .filter(|k| o.contains_key(*k))
        .collect();
    let film = o.get("film").map(film_ask).transpose()?;
    match asked.as_slice() {
        [] if film.is_some() => Ok(Request::Steps {
            steps: Vec::new(),
            film,
        }),
        [] => Err(
            "nothing asked: keys, type, click, dblclick, move, scroll, see, wait, shot or quit"
                .into(),
        ),
        [one] => {
            let arg = &o[*one];
            if film.is_some()
                && !matches!(
                    *one,
                    "keys" | "type" | "click" | "dblclick" | "move" | "scroll"
                )
            {
                return Err(format!("film goes with keys, not {one}"));
            }
            let steps = |steps: Vec<Step>| -> Result<Request, String> {
                let bad = shot::unknown_keys(&steps);
                if !bad.is_empty() {
                    return Err(shot::unknown_key_message(&bad));
                }
                Ok(Request::Steps {
                    steps,
                    film: film.clone(),
                })
            };
            match *one {
                "keys" => steps(shot::steps(text(arg, "keys")?)),
                "type" => steps(vec![Step::Type(text(arg, "type")?.to_owned())]),
                "click" => pair(arg, "click").and_then(|(x, y)| steps(vec![Step::Click(x, y)])),
                "dblclick" => {
                    pair(arg, "dblclick").and_then(|(x, y)| steps(vec![Step::DoubleClick(x, y)]))
                }
                "move" => pair(arg, "move").and_then(|(x, y)| steps(vec![Step::Move(x, y)])),
                "scroll" => {
                    let (dx, dy) = match arg.as_f64() {
                        Some(dy) => (0., dy as f32),
                        None => pair(arg, "scroll")?,
                    };
                    steps(vec![Step::Scroll(dx, dy)])
                }
                "see" => see_parts(arg).map(Request::See),
                "wait" => wait_for(arg).map(Request::Wait),
                "shot" => Ok(Request::Shot(PathBuf::from(text(arg, "shot")?))),
                _ => match arg.as_bool() {
                    Some(true) => Ok(Request::Quit),
                    _ => Err("quit is true".into()),
                },
            }
        }
        many => Err(format!("one thing a request: {}", many.join(", "))),
    }
}

fn text<'a>(v: &'a Value, what: &str) -> Result<&'a str, String> {
    v.as_str().ok_or_else(|| format!("{what} is a string"))
}

fn pair(v: &Value, what: &str) -> Result<(f32, f32), String> {
    match v.as_array().map(Vec::as_slice) {
        Some([x, y]) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => Ok((x as f32, y as f32)),
            _ => Err(format!("{what} is [x, y] in logical px")),
        },
        _ => Err(format!("{what} is [x, y] in logical px")),
    }
}

fn part(name: &str) -> Result<String, String> {
    if PARTS.contains(&name) {
        Ok(name.to_owned())
    } else {
        Err(format!("no part {name:?}: {}", PARTS.join(", ")))
    }
}

fn see_parts(v: &Value) -> Result<Vec<String>, String> {
    match v {
        Value::Bool(true) | Value::Null => Ok(Vec::new()),
        Value::String(s) => part(s).map(|p| vec![p]),
        Value::Array(a) => a
            .iter()
            .map(|p| {
                p.as_str()
                    .ok_or("see names parts".to_owned())
                    .and_then(part)
            })
            .collect(),
        _ => Err("see is a list of parts".into()),
    }
}

fn wait_for(v: &Value) -> Result<WaitFor, String> {
    let Value::Object(o) = v else {
        return Err("wait is {\"text\":…, \"in\"?, \"gone\"?, \"ms\"?}".into());
    };
    if let Some(bad) = o
        .keys()
        .find(|k| !["text", "in", "gone", "ms"].contains(&k.as_str()))
    {
        return Err(format!("wait: unknown field {bad:?}"));
    }
    let text = o
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or("wait needs a text")?
        .to_owned();
    let within = match o.get("in") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == "any" => None,
        Some(Value::String(s)) => Some(part(s)?),
        Some(_) => return Err("wait's in is a part".into()),
    };
    let gone = o.get("gone").and_then(Value::as_bool).unwrap_or(false);
    let ms = match o.get("ms") {
        None => WAIT_MS,
        Some(ms) => ms.as_u64().ok_or("wait's ms is a number")?,
    }
    .min(WAIT_MAX_MS);
    Ok(WaitFor {
        text,
        within,
        gone,
        ms,
    })
}

fn film_ask(v: &Value) -> Result<FilmAsk, String> {
    let to = v
        .get("to")
        .and_then(Value::as_str)
        .ok_or("film needs to: the film's PNG path")?;
    let frames = v.get("frames").and_then(Value::as_u64).unwrap_or(0);
    let every = v
        .get("every")
        .and_then(Value::as_u64)
        .map(|e| e.to_string());
    let film = shot::Film::of(Some(&frames.to_string()), every.as_deref(), Path::new(to))
        .ok_or("film needs frames above 0")?;
    Ok(FilmAsk {
        to: PathBuf::from(to),
        frames: film.frames,
        every: film.every,
    })
}

impl Request {
    /// How long it may take before it answers `stuck` (and the next request goes on): its own
    /// pauses, keys, typed text and film, and a margin for a slow machine.
    pub fn budget(&self) -> Duration {
        let ms = match self {
            Request::Steps { steps, film } => {
                let played: u64 = steps
                    .iter()
                    .map(|s| match s {
                        Step::Wait(ms) => *ms,
                        Step::Type(text) => 200 * text.chars().count() as u64,
                        _ => 1000,
                    })
                    .sum();
                played + film.as_ref().map_or(0, |f| u64::from(f.frames) * f.every)
            }
            Request::Wait(w) => w.ms,
            Request::See(_) | Request::Shot(_) | Request::Quit => 0,
        };
        Duration::from_millis(ms) + BUDGET_MARGIN
    }

    /// What it is, in a `stuck` answer.
    fn name(&self) -> &'static str {
        match self {
            Request::Steps { film: Some(_), .. } => "film",
            Request::Steps { .. } => "keys",
            Request::See(_) => "see",
            Request::Wait(_) => "wait",
            Request::Shot(_) => "shot",
            Request::Quit => "quit",
        }
    }

    /// Only looks (`see`, `wait`): answered beside the others, not in their queue.
    fn looks(&self) -> bool {
        matches!(self, Request::See(_) | Request::Wait(_))
    }
}

/// A refusal or failure line's body.
pub fn refused(error: &str) -> Value {
    json!({"ok": false, "error": error})
}

// ---------------------------------------------------------------- what is seen

/// What the app shows, as text: the answer to `see`, what `wait` reads.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Seen {
    /// `factory` or `editor`.
    pub view: String,
    /// `main` / `chat` / `pane` / `review` / `layer`: [`outline`]s.
    pub trees: BTreeMap<String, String>,
    /// The status bar's widgets, then `status: <the bridge's line>`.
    pub status: Vec<String>,
    /// `<title>: <body>` each.
    pub balloons: Vec<String>,
    pub title: String,
    /// The shown workspace's bottom-pane Terminal ([`terminal_text`]).
    pub terminal: String,
}

impl Seen {
    /// One part's text.
    pub fn part(&self, name: &str) -> String {
        match name {
            "status" => self.status.join("\n"),
            "balloons" => self.balloons.join("\n"),
            "title" => self.title.clone(),
            "view" => self.view.clone(),
            "terminal" => self.terminal.clone(),
            tree => self.trees.get(tree).cloned().unwrap_or_default(),
        }
    }

    /// Whether `text` is in the part (None: any).
    pub fn has(&self, text: &str, within: Option<&str>) -> bool {
        match within {
            Some(p) => self.part(p).contains(text),
            None => PARTS.iter().any(|p| self.part(p).contains(text)),
        }
    }

    /// The answer: the parts asked for (none: all), `ok` set.
    pub fn answer(&self, parts: &[String]) -> Value {
        let all = parts.is_empty();
        let want = |p: &str| all || parts.iter().any(|x| x == p);
        let mut out = serde_json::Map::new();
        out.insert("ok".into(), Value::Bool(true));
        let trees: serde_json::Map<String, Value> = ["main", "chat", "pane", "review", "layer"]
            .into_iter()
            .filter(|p| want(p))
            .map(|p| (p.to_owned(), Value::String(self.part(p))))
            .collect();
        if !trees.is_empty() {
            out.insert("trees".into(), Value::Object(trees));
        }
        if want("status") {
            out.insert("status".into(), json!(self.status));
        }
        if want("balloons") {
            out.insert("balloons".into(), json!(self.balloons));
        }
        if want("title") {
            out.insert("title".into(), json!(self.title));
        }
        if want("view") {
            out.insert("view".into(), json!(self.view));
        }
        if want("terminal") {
            out.insert("terminal".into(), json!(self.terminal));
        }
        Value::Object(out)
    }
}

/// A tree as an indented outline, one node a line, `Kind #id prop=value …`, children under it:
/// `abe ui render`'s text (`uiRenderText` in `abe/packages/core/src/contract/ui.ts`).
pub fn outline(tree: &Value) -> String {
    let mut lines = Vec::new();
    outline_into(tree, 0, &mut lines);
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn outline_into(node: &Value, depth: usize, out: &mut Vec<String>) {
    let mut head = vec![
        node.get("kind")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned(),
    ];
    if let Some(id) = node.get("id").and_then(Value::as_str) {
        head.push(format!("#{id}"));
    }
    if let Some(Value::Object(props)) = node.get("props") {
        for (k, v) in props {
            head.push(format!("{k}={v}"));
        }
    }
    out.push(format!("{}{}", "  ".repeat(depth), head.join(" ")));
    if let Some(Value::Array(children)) = node.get("children") {
        for c in children {
            outline_into(c, depth + 1, out);
        }
    }
}

/// The trees the bridge sent last, per slot (`main`, `chat`, `pane`, `review`, its patches
/// applied) and the `layer`.
#[derive(Default)]
pub struct Tap(pub BTreeMap<String, Value>);

impl gpui_kit::Global for Tap {}

impl Tap {
    /// Notes a bridge line: a `tree` frame's tree for its slot, a `layer` frame's (or its end).
    pub fn note(&mut self, line: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match frame.get("type").and_then(Value::as_str) {
            Some("tree") => {
                let slot = frame
                    .get("slot")
                    .and_then(Value::as_str)
                    .unwrap_or("main")
                    .to_owned();
                if let Some(tree) = frame.get("tree") {
                    self.0.insert(slot, tree.clone());
                }
            }
            // a slot's patch of the tree noted there; one that does not apply drops it (the
            // window asks the bridge again and the whole tree follows)
            Some("patch") => {
                let slot = frame
                    .get("slot")
                    .and_then(Value::as_str)
                    .unwrap_or("main")
                    .to_owned();
                let ops = serde_json::from_value::<Vec<crate::factory::Op<Value>>>(
                    frame.get("ops").cloned().unwrap_or(Value::Null),
                );
                let applied = match (self.0.get_mut(&slot), ops) {
                    (Some(tree), Ok(ops)) => crate::factory::apply(tree, ops).is_ok(),
                    _ => false,
                };
                if !applied {
                    self.0.remove(&slot);
                }
            }
            Some("layer") => match frame.get("tree") {
                Some(tree) if !tree.is_null() => {
                    self.0.insert("layer".into(), tree.clone());
                }
                _ => {
                    self.0.remove("layer");
                }
            },
            _ => {}
        }
    }
}

/// A bridge line (`FactoryView::receive_line`): noted while the app is driven.
pub fn tap(line: &str, cx: &mut gpui_kit::App) {
    if socket().is_some() {
        cx.default_global::<Tap>().note(line);
    }
}

// ---------------------------------------------------------------- the socket

/// A request on the UI thread, and where its answer goes.
struct Asked {
    request: Request,
    reply: std::sync::mpsc::SyncSender<Value>,
}

/// The socket file, removed when the server goes (or the app quits).
struct SocketFile(PathBuf);

impl Drop for SocketFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Binds `sock` (0600; a stale file left by a dead app is taken over, a live one refused) and
/// accepts on a thread; each request goes to `tx` and its answer back to the client.
fn listen(
    sock: &Path,
    tx: futures::channel::mpsc::UnboundedSender<Asked>,
) -> std::io::Result<SocketFile> {
    use std::os::unix::fs::PermissionsExt as _;
    use std::os::unix::net::{UnixListener, UnixStream};
    if let Some(dir) = sock.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = match UnixListener::bind(sock) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if UnixStream::connect(sock).is_ok() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    format!("{} is driven by another app", sock.display()),
                ));
            }
            std::fs::remove_file(sock)?;
            UnixListener::bind(sock)?
        }
        Err(e) => return Err(e),
    };
    let guard = SocketFile(sock.to_path_buf());
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))?;
    std::thread::Builder::new()
        .name("drive".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let to_ui = tx.clone();
                let _ = std::thread::Builder::new()
                    .name("drive-client".into())
                    .spawn(move || serve_one(stream, &to_ui));
                if tx.is_closed() {
                    break;
                }
            }
        })?;
    Ok(guard)
}

/// One client: request lines in, an answer line out for each, until it hangs up.
fn serve_one(
    stream: std::os::unix::net::UnixStream,
    tx: &futures::channel::mpsc::UnboundedSender<Asked>,
) -> std::io::Result<()> {
    use std::io::{BufRead as _, BufReader, Read as _, Write as _};
    let answer = |v: Value| -> std::io::Result<()> {
        let mut line = v.to_string();
        line.push('\n');
        (&stream).write_all(line.as_bytes())
    };
    if !crate::app::same_user(&stream) {
        return answer(refused("refused: another user"));
    }
    let mut reader = BufReader::new(&stream);
    loop {
        let mut line = String::new();
        if (&mut reader).take(MAX_LINE).read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        let reply = match parse(&line) {
            Err(e) => refused(&e),
            Ok(request) => {
                let (reply, got) = std::sync::mpsc::sync_channel(1);
                if tx.unbounded_send(Asked { request, reply }).is_err() {
                    refused("the app is quitting")
                } else {
                    got.recv().unwrap_or_else(|_| refused("the app quit"))
                }
            }
        };
        answer(reply)?;
    }
}

/// Starts the driven app's socket once the screen is up (one per app), and the steady draws:
/// from the first root that comes up, the first editor's (`up` once it flushed) or Welcome's (a
/// launch with no project, no editor to wait for). `editor`: where nvim keys and Lua go while no
/// project is shown.
pub fn schedule<V: 'static>(
    window: &mut gpui_kit::Window,
    cx: &mut gpui_kit::Context<V>,
    editor: Option<gpui_kit::WeakEntity<crate::editor::EditorView>>,
    up: fn(&V) -> bool,
) {
    use futures::StreamExt as _;
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(sock) = socket().map(Path::to_path_buf) else {
        return;
    };
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let every =
        Duration::from_millis(1000 / u64::from(fps(std::env::var(FPS_ENV).ok().as_deref())));
    no_app_nap();
    cx.spawn_in(window, async move |this, cx| {
        let exec = cx.background_executor().clone();
        while this.update(cx, |v, _| !up(v)).unwrap_or(false) {
            exec.timer(Duration::from_millis(20)).await;
        }
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<Asked>();
        let guard = match listen(&sock, tx) {
            Ok(g) => std::rc::Rc::new(std::cell::RefCell::new(Some(g))),
            Err(e) => {
                eprintln!("[vimstorm] drive: {}: {e}", sock.display());
                let _ = cx.update(|_, cx| cx.quit());
                return;
            }
        };
        let on_quit = guard.clone();
        let _ = cx.update(|_, cx| {
            cx.on_app_quit(move |_| {
                on_quit.borrow_mut().take();
                async {}
            })
            .detach();
        });
        // the hidden window gets no frames of its own: a steady pace stands in for the display's,
        // each frame first running what waits for it (an animation's or a glide's next step, as
        // a shown window's frame does), then drawn; then the focus-in a shown window would hear
        // (GPUI tells the key window only)
        cx.spawn(async move |cx| {
            let exec = cx.background_executor().clone();
            loop {
                exec.timer(every).await;
                // (apart: what the callbacks notify is marked dirty once their update ends)
                let _ = cx.update(|window, cx| window.simulate_next_frame(cx));
                if cx.update(|window, cx| window.draw(cx).clear(cx)).is_err() {
                    break;
                }
                let _ = cx.update(|window, cx| {
                    if let Some(ws) = crate::shell::projects::active_workspace(cx) {
                        ws.update(cx, |ws, cx| ws.hear_focus_offscreen(window, cx));
                    }
                });
            }
        })
        .detach();
        eprintln!("[vimstorm] drive: listening on {}", sock.display());
        // keys, shots, films and quit: one at a time, in order, each within its budget
        let (queue, mut queued) = futures::channel::mpsc::unbounded::<Asked>();
        cx.spawn(async move |cx| {
            let mut pointer: Option<(f32, f32)> = None;
            while let Some(Asked { request, reply }) = queued.next().await {
                let quit = request == Request::Quit;
                let (budget, what) = (request.budget(), request.name());
                let answer = answer(request, editor.as_ref(), cx, &sock, &mut pointer);
                let answer = within(budget, what, std::pin::pin!(answer), &exec).await;
                let _ = reply.send(answer);
                if quit {
                    guard.borrow_mut().take();
                    exec.timer(Duration::from_millis(50)).await;
                    let _ = cx.update(|_, cx| cx.quit());
                    break;
                }
            }
        })
        .detach();
        // `see` and `wait` only look: answered beside the queue, so a long wait holds up nothing
        while let Some(asked) = rx.next().await {
            if !asked.request.looks() {
                let _ = queue.unbounded_send(asked);
                continue;
            }
            let Asked { request, reply } = asked;
            cx.spawn(async move |cx| {
                let exec = cx.background_executor().clone();
                let (budget, what) = (request.budget(), request.name());
                let answer = within(budget, what, std::pin::pin!(look(request, cx)), &exec).await;
                let _ = reply.send(answer);
            })
            .detach();
        }
    })
    .detach();
}

/// `fut`'s answer, or `stuck` once `budget` is up (`fut` dropped: the next request goes on).
async fn within(
    budget: Duration,
    what: &str,
    fut: std::pin::Pin<&mut impl std::future::Future<Output = Value>>,
    exec: &gpui_kit::BackgroundExecutor,
) -> Value {
    use futures::future::Either;
    match futures::future::select(fut, exec.timer(budget)).await {
        Either::Left((answer, _)) => answer,
        Either::Right(_) => {
            eprintln!("[vimstorm] drive: a {what} stuck past {budget:?}");
            refused(&format!(
                "stuck: the {what} did not finish in {} s",
                budget.as_secs()
            ))
        }
    }
}

/// A hidden app in the background is napped by macOS (App Nap: its timers coalesced, its GPU work
/// held back), so a live app's steps and frames would take seconds: it says it is doing user work
/// for as long as it runs.
fn no_app_nap() {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep
                | NSActivityOptions::LatencyCritical,
            &NSString::from_str("driven over the drive socket"),
        );
        // held for the process's life
        std::mem::forget(activity);
    }
}

/// Does one request and says how it went.
async fn answer(
    request: Request,
    this: Option<&gpui_kit::WeakEntity<crate::editor::EditorView>>,
    cx: &mut gpui_kit::AsyncWindowContext,
    sock: &Path,
    pointer: &mut Option<(f32, f32)>,
) -> Value {
    let start = Instant::now();
    match request {
        Request::Quit => json!({"ok": true}),
        Request::See(_) | Request::Wait(_) => look(request, cx).await,
        Request::Shot(path) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let exec = cx.background_executor().clone();
            match shot::capture(cx, &path, &exec, true).await {
                Some(save) => {
                    save.await;
                    if path.exists() {
                        json!({"ok": true, "path": path, "ms": start.elapsed().as_millis() as u64})
                    } else {
                        refused(&format!(
                            "{} not saved (the app's log says why)",
                            path.display()
                        ))
                    }
                }
                None => refused("the window could not be drawn"),
            }
        }
        Request::Steps { steps, film } => {
            let log = std::rc::Rc::new(std::cell::RefCell::new(shot::FilmLog::default()));
            let base = film
                .as_ref()
                .map(|f| f.to.clone())
                .unwrap_or_else(|| sock.with_extension("png"));
            if let Some(dir) = base.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let reel = film.as_ref().map(|f| {
                let film = shot::Film::of(
                    Some(&f.frames.to_string()),
                    Some(&f.every.to_string()),
                    &f.to,
                )
                .expect("a parsed film has frames");
                shot::roll(cx, film, log.clone(), start)
            });
            let exec = cx.background_executor().clone();
            for step in steps {
                log.borrow_mut().step(&step, start.elapsed());
                match step {
                    Step::Shot(label) => {
                        let file = shot::film_file(&base, &label);
                        let at = start.elapsed();
                        if let Some(save) = shot::capture(cx, &file, &exec, true).await {
                            log.borrow_mut().frame(&file, at, &label);
                            save.await;
                        }
                    }
                    step => shot::play(step, this, cx, pointer).await,
                }
            }
            if let Some(reel) = reel {
                reel.await;
            }
            if film.is_some() || log.borrow().has_frames() {
                log.borrow().write(&shot::film_list(&base));
            }
            let mut out = json!({"ok": true, "ms": start.elapsed().as_millis() as u64});
            if let Some(f) = film {
                out["frames"] = json!(f.frames);
            }
            out
        }
    }
}

/// A `see` or `wait`'s answer: they only look.
async fn look(request: Request, cx: &mut gpui_kit::AsyncWindowContext) -> Value {
    let start = Instant::now();
    match request {
        Request::See(parts) => seen(cx).answer(&parts),
        Request::Wait(w) => {
            let exec = cx.background_executor().clone();
            let end = start + Duration::from_millis(w.ms);
            loop {
                let now = seen(cx);
                if now.has(&w.text, w.within.as_deref()) != w.gone {
                    return json!({"ok": true, "ms": start.elapsed().as_millis() as u64});
                }
                if Instant::now() >= end {
                    let mut out = now.answer(&[]);
                    out["ok"] = Value::Bool(false);
                    out["error"] = json!("timeout");
                    out["ms"] = json!(start.elapsed().as_millis() as u64);
                    return out;
                }
                exec.timer(WAIT_EVERY).await;
            }
        }
        _ => refused("not a look"),
    }
}

/// The Terminal as `see` reads it: `Local  [Local (2)]` (the current tab boxed), then the shown
/// tab's rows (trailing blank rows dropped); empty while it doesn't show.
pub fn terminal_text(tabs: &[String], current: usize, rows: &[String]) -> String {
    if tabs.is_empty() {
        return String::new();
    }
    let head: Vec<String> = tabs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if i == current {
                format!("[{t}]")
            } else {
                t.clone()
            }
        })
        .collect();
    let mut rows: Vec<&str> = rows.iter().map(|r| r.trim_end()).collect();
    while rows.last().is_some_and(|r| r.is_empty()) {
        rows.pop();
    }
    let mut out = head.join("  ");
    for r in rows {
        out.push('\n');
        out.push_str(r);
    }
    out
}

/// What the app shows now.
fn seen(cx: &mut gpui_kit::AsyncWindowContext) -> Seen {
    cx.update(|window, cx| {
        let trees = cx
            .try_global::<Tap>()
            .map(|t| {
                t.0.iter()
                    .map(|(slot, tree)| (slot.clone(), outline(tree)))
                    .collect()
            })
            .unwrap_or_default();
        let shell = cx.try_global::<crate::factory::FactoryShell>();
        let mut status: Vec<String> = shell
            .map(|s| s.widgets.iter().map(|w| w.text.clone()).collect())
            .unwrap_or_default();
        if let Some(line) = shell.and_then(|s| s.status.clone()) {
            status.push(format!("status: {line}"));
        }
        let view = if shell.is_some_and(|s| s.shown) {
            "factory"
        } else {
            "editor"
        };
        let terminal = crate::shell::projects::active_workspace(cx)
            .map(|ws| ws.read(cx).terminal().read(cx))
            .filter(|t| t.shown() && shell.is_none_or(|s| !s.shown))
            .map(|t| terminal_text(&t.tab_names(), t.current(), &t.screen()))
            .unwrap_or_default();
        Seen {
            terminal,
            view: view.to_owned(),
            trees,
            status,
            balloons: crate::popups::shown_balloons(cx)
                .into_iter()
                .map(|(title, body)| format!("{title}: {body}"))
                .collect(),
            title: window.window_title(),
        }
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(steps: Vec<Step>) -> Result<Request, &'static str> {
        Ok(Request::Steps { steps, film: None })
    }

    /// Each request a line asks for, or the start of what the refusal says ("" for any).
    #[test]
    fn a_line_parses_to_its_request_or_says_why_not() {
        let wait = |text: &str, within: Option<&str>, gone, ms| {
            Ok(Request::Wait(WaitFor {
                text: text.into(),
                within: within.map(Into::into),
                gone,
                ms,
            }))
        };
        let rows: &[(&str, &str, Result<Request, &str>)] = &[
            (
                "keys reuse the shot grammar",
                r#"{"v":1,"keys":"{@super+alt+a}{wait:200}{@ö}{@enter}"}"#,
                steps(vec![
                    Step::Gpui("super+alt+a".into()),
                    Step::Wait(200),
                    Step::Gpui("ö".into()),
                    Step::Gpui("enter".into()),
                ]),
            ),
            (
                "an unknown key",
                r#"{"v":1,"keys":"{@tab}{@pagedown}"}"#,
                Err("unknown key {@pagedown}"),
            ),
            (
                "type",
                r#"{"v":1,"type":"keep it"}"#,
                steps(vec![Step::Type("keep it".into())]),
            ),
            (
                "click",
                r#"{"v":1,"click":[640,312.5]}"#,
                steps(vec![Step::Click(640., 312.5)]),
            ),
            (
                "double click",
                r#"{"v":1,"dblclick":[1,2]}"#,
                steps(vec![Step::DoubleClick(1., 2.)]),
            ),
            (
                "move",
                r#"{"v":1,"move":[3,4]}"#,
                steps(vec![Step::Move(3., 4.)]),
            ),
            (
                "scroll by x and y",
                r#"{"v":1,"scroll":[10,-80]}"#,
                steps(vec![Step::Scroll(10., -80.)]),
            ),
            (
                "scroll by y",
                r#"{"v":1,"scroll":-80}"#,
                steps(vec![Step::Scroll(0., -80.)]),
            ),
            ("a click without y", r#"{"v":1,"click":[1]}"#, Err("")),
            ("see all", r#"{"v":1,"see":[]}"#, Ok(Request::See(vec![]))),
            (
                "see true",
                r#"{"v":1,"see":true}"#,
                Ok(Request::See(vec![])),
            ),
            (
                "see parts",
                r#"{"v":1,"see":["main","layer"]}"#,
                Ok(Request::See(vec!["main".into(), "layer".into()])),
            ),
            (
                "see an unknown part",
                r#"{"v":1,"see":["board"]}"#,
                Err("no part"),
            ),
            (
                "wait in a part",
                r#"{"v":1,"wait":{"text":"Needs you","in":"chat","ms":600000}}"#,
                wait("Needs you", Some("chat"), false, 600_000),
            ),
            (
                "wait anywhere for text gone",
                r#"{"v":1,"wait":{"text":"Saving","gone":true,"in":"any"}}"#,
                wait("Saving", None, true, WAIT_MS),
            ),
            ("wait for no text", r#"{"v":1,"wait":{"text":""}}"#, Err("")),
            (
                "wait with an unknown field",
                r#"{"v":1,"wait":{"text":"a","for":1}}"#,
                Err(""),
            ),
            (
                "shot",
                r#"{"v":1,"shot":"/tmp/a.png"}"#,
                Ok(Request::Shot("/tmp/a.png".into())),
            ),
            (
                "film keys, every at least 10 ms",
                r#"{"v":1,"film":{"to":"/f/f3.png","frames":40,"every":5},"keys":"k"}"#,
                Ok(Request::Steps {
                    steps: vec![Step::Nvim("k".into())],
                    film: Some(FilmAsk {
                        to: "/f/f3.png".into(),
                        frames: 40,
                        every: 10,
                    }),
                }),
            ),
            (
                "film no frames",
                r#"{"v":1,"film":{"to":"/f.png","frames":0},"keys":"k"}"#,
                Err(""),
            ),
            (
                "film a see",
                r#"{"v":1,"film":{"to":"/f.png","frames":2},"see":[]}"#,
                Err(""),
            ),
            ("quit", r#"{"v":1,"quit":true}"#, Ok(Request::Quit)),
            ("not JSON", "keys", Err("not JSON")),
            ("no version", r#"{"keys":"k"}"#, Err("no \"v\":1")),
            (
                "another version",
                r#"{"v":2,"keys":"k"}"#,
                Err("v2: this app speaks v1"),
            ),
            ("nothing asked", r#"{"v":1}"#, Err("nothing asked")),
            (
                "two things asked",
                r#"{"v":1,"keys":"k","see":[]}"#,
                Err("one thing a request: keys, see"),
            ),
            (
                "an unknown field",
                r#"{"v":1,"kyes":"k"}"#,
                Err("unknown field \"kyes\""),
            ),
        ];
        for (name, line, want) in rows {
            match (parse(line), want) {
                (Err(got), Err(start)) => assert!(got.starts_with(start), "{name}: {got}"),
                (got, want) => assert_eq!(&got.map_err(|_| "refused"), want, "{name}"),
            }
        }
    }

    #[test]
    fn outline_is_abe_ui_renders() {
        let tree = json!({
            "kind": "Island",
            "children": [{
                "kind": "ListRow", "id": "card:101",
                "props": {"text": "#101 Free shipping", "state": "selected"},
            }, {
                "kind": "Badge", "props": {"text": "2 \"open\""}
            }]
        });
        assert_eq!(
            outline(&tree),
            "Island\n  ListRow #card:101 text=\"#101 Free shipping\" state=\"selected\"\n  Badge text=\"2 \\\"open\\\"\"\n"
        );
    }

    #[test]
    fn the_tap_keeps_each_slots_last_tree_and_the_layer() {
        let mut tap = Tap::default();
        tap.note(r#"{"v":2,"type":"tree","screen":"factory","rev":1,"tree":{"kind":"Island","props":{}}}"#);
        tap.note(r#"{"v":2,"type":"tree","screen":"chat","rev":1,"slot":"chat","tree":{"kind":"Empty","props":{"title":"No session"}}}"#);
        tap.note(r#"{"v":2,"type":"layer","rev":2,"tree":{"kind":"PickLayer","props":{"title":"Command mode"}}}"#);
        tap.note(r#"{"v":2,"type":"tree","screen":"review","rev":1,"slot":"review","tree":{"kind":"Empty","props":{}}}"#);
        tap.note("not json");
        assert_eq!(
            tap.0.keys().collect::<Vec<_>>(),
            ["chat", "layer", "main", "review"]
        );
        tap.note(r#"{"v":2,"type":"layer","rev":3,"tree":null}"#);
        assert_eq!(tap.0.keys().collect::<Vec<_>>(), ["chat", "main", "review"]);
        // a patch changes the slot's tree; one that does not apply drops it
        tap.note(r#"{"v":2,"type":"patch","screen":"factory","rev":4,"base":1,"ops":[{"path":[],"splice":[0,0],"add":[{"kind":"Empty","props":{"title":"Board"}}]}]}"#);
        assert_eq!(
            tap.0["main"],
            serde_json::json!({"kind":"Island","props":{},"children":[{"kind":"Empty","props":{"title":"Board"}}]})
        );
        tap.note(r#"{"v":2,"type":"patch","screen":"chat","rev":2,"base":1,"slot":"chat","ops":[{"path":[0],"node":{"kind":"Empty","props":{}}}]}"#);
        assert_eq!(tap.0.keys().collect::<Vec<_>>(), ["main", "review"]);
    }

    #[test]
    fn seen_finds_text_in_a_part_or_anywhere() {
        let seen = Seen {
            view: "factory".into(),
            trees: [
                ("chat".to_owned(), "Empty title=\"Needs you\"\n".to_owned()),
                ("review".to_owned(), "Diff title=\"PR #7\"\n".to_owned()),
            ]
            .into(),
            status: vec!["Factory ◆ 2".into()],
            balloons: vec!["Abe: abe serve restarted".into()],
            title: "demo — VimStorm".into(),
            terminal: terminal_text(
                &["Local".into(), "Local (2)".into()],
                1,
                &["$ echo hi".into(), "hi".into(), "".into()],
            ),
        };
        assert_eq!(seen.terminal, "Local  [Local (2)]\n$ echo hi\nhi");
        assert!(seen.has("echo hi", Some("terminal")));
        assert_eq!(terminal_text(&[], 0, &["x".into()]), "");
        assert!(seen.has("Needs you", Some("chat")));
        assert!(!seen.has("Needs you", Some("main")));
        assert!(seen.has("restarted", None));
        assert!(seen.has("◆ 2", Some("status")));
        assert!(seen.has("PR #7", Some("review")));
        assert!(seen.answer(&["review".into()])["trees"]["review"] == "Diff title=\"PR #7\"\n");
        let a = seen.answer(&["chat".into(), "title".into()]);
        assert_eq!(
            a,
            json!({"ok": true, "trees": {"chat": "Empty title=\"Needs you\"\n"}, "title": "demo — VimStorm"})
        );
        assert_eq!(seen.answer(&[])["view"], "factory");
    }

    #[test]
    fn each_request_has_its_own_time_and_a_margin() {
        let m = BUDGET_MARGIN.as_millis() as u64;
        for (line, ms, looks) in [
            (r#"{"v":1,"see":[]}"#, m, true),
            (
                r#"{"v":1,"wait":{"text":"a","ms":600000}}"#,
                600_000 + m,
                true,
            ),
            (
                r#"{"v":1,"keys":"{wait:500}{@enter}{type:abc}"}"#,
                500 + 1000 + 600 + m,
                false,
            ),
            (
                r#"{"v":1,"film":{"to":"/f.png","frames":40,"every":100},"keys":"{@tab}"}"#,
                1000 + 4000 + m,
                false,
            ),
            (r#"{"v":1,"shot":"/a.png"}"#, m, false),
            (r#"{"v":1,"quit":true}"#, m, false),
        ] {
            let r = parse(line).unwrap();
            assert_eq!(
                (r.budget().as_millis() as u64, r.looks()),
                (ms, looks),
                "{line}"
            );
        }
    }

    #[test]
    fn the_pace_is_ten_frames_a_second_unless_set() {
        assert_eq!(fps(None), 10);
        assert_eq!(fps(Some("30")), 30);
        assert_eq!(fps(Some("0")), 10);
        assert_eq!(fps(Some("500")), 60);
        assert_eq!(fps(Some("x")), 10);
    }
}
