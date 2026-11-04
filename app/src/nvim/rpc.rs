//! msgpack-rpc with nvim over its stdio (hand-rolled on `rmpv`; nvim-rs is LGPL).
//!
//! A writer thread owns stdin and a reader thread owns stdout, so callers (the UI thread) never
//! block on the pipe. The reader parses `redraw` notifications into typed events and hands them
//! over in complete batches cut at `flush`; responses go to whoever made the request.

use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use futures::channel::oneshot;
use parking_lot::Mutex;
use rmpv::Value;

use super::redraw::{RedrawEvent, parse_redraw};

/// `nvim_error_event`s [`Rpc::error_events`] keeps.
const MAX_ERRORS: usize = 16;

/// nvim's answer to a resize of a grid whose window closed meanwhile ([`Rpc::ui_try_resize_grid`]).
const GONE_GRID: &str = "Invalid window handle";
/// A request's error when nvim's pipe is closed / when nvim exited before answering.
const GONE: &str = "nvim is gone";
const EXITED: &str = "nvim exited";

/// What the reader thread reports.
#[derive(Debug)]
pub enum NvimEvent {
    /// Redraw events up to and including a `flush`: apply them, then draw.
    Redraw(Vec<RedrawEvent>),
    /// Any other notification (`rpcnotify(0, ...)` from Lua).
    Notification(String, Vec<Value>),
    /// stdout closed: nvim exited.
    Exited,
}

/// Error part of a response: nvim's `[type, message]`, or a transport error.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError(pub String);

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RpcError {}

type Responder = Box<dyn FnOnce(Result<Value, RpcError>) + Send>;

struct Inner {
    out: mpsc::Sender<Value>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Responder>>,
    /// nvim's `nvim_error_event`s (a notification it couldn't run), oldest first, the last few.
    errors: Mutex<Vec<String>>,
    gate: Mutex<InputGate>,
}

impl Inner {
    /// Keeps an error for [`Rpc::error_events`] (the last [`MAX_ERRORS`]).
    fn keep_error(&self, msg: String) {
        let mut errors = self.errors.lock();
        if errors.len() == MAX_ERRORS {
            errors.remove(0);
        }
        errors.push(msg);
    }
}

/// Keys / mouse input held until nvim has run a notification sent before them
/// ([`Rpc::hold_input`]): `nvim_input` is handled the moment it arrives and nvim reads typeahead
/// before queued notifications, so without this a key typed right after the app's focus change
/// reached Lua before the change did.
#[derive(Default)]
struct InputGate {
    /// Last hold handed out.
    held: u64,
    /// Highest hold nvim acked (`vimstorm.input_ack`) or that timed out.
    acked: u64,
    /// Input messages waiting for the ack, in order.
    queue: Vec<Value>,
}

/// The notification Lua sends when it ran a held-for notification (config/app.lua
/// `native_focus`): `[seq]`. The reader thread opens the gate itself (no UI thread round trip).
pub const INPUT_ACK: &str = "vimstorm.input_ack";

/// Cheap to clone handle for talking to nvim.
#[derive(Clone)]
pub struct Rpc {
    inner: Arc<Inner>,
}

impl Rpc {
    /// Starts the reader / writer threads. `on_event` runs on the reader thread.
    pub fn start(
        stdin: impl Write + Send + 'static,
        stdout: impl Read + Send + 'static,
        on_event: impl FnMut(NvimEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<Value>();
        let inner = Arc::new(Inner {
            out: tx,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            errors: Mutex::new(Vec::new()),
            gate: Mutex::new(InputGate::default()),
        });
        std::thread::Builder::new()
            .name("nvim-writer".into())
            .spawn(move || writer(stdin, rx))
            .expect("spawn nvim writer");
        let rpc = Rpc { inner };
        let reader_rpc = rpc.clone();
        std::thread::Builder::new()
            .name("nvim-reader".into())
            .spawn(move || reader(stdout, reader_rpc, on_event))
            .expect("spawn nvim reader");
        rpc
    }

    /// The last [`MAX_ERRORS`] `nvim_error_event` messages (a notification nvim rejected).
    pub fn error_events(&self) -> Vec<String> {
        self.inner.errors.lock().clone()
    }

    /// Fire-and-forget notification.
    pub fn notify(&self, method: &str, args: Vec<Value>) {
        let msg = Value::Array(vec![2.into(), method.into(), Value::Array(args)]);
        let _ = self.inner.out.send(msg);
    }

    /// Request; `done` runs on the reader thread with the result.
    pub fn request_with(
        &self,
        method: &str,
        args: Vec<Value>,
        done: impl FnOnce(Result<Value, RpcError>) + Send + 'static,
    ) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner.pending.lock().insert(id, Box::new(done));
        let msg = Value::Array(vec![0.into(), id.into(), method.into(), Value::Array(args)]);
        if self.inner.out.send(msg).is_err()
            && let Some(done) = self.inner.pending.lock().remove(&id)
        {
            done(Err(RpcError(GONE.into())));
        }
    }

    /// Request, awaitable from any executor (GPUI's foreground `cx.spawn` included).
    pub fn request(
        &self,
        method: &str,
        args: Vec<Value>,
    ) -> impl Future<Output = Result<Value, RpcError>> + use<> {
        let (tx, rx) = oneshot::channel();
        self.request_with(method, args, move |r| {
            let _ = tx.send(r);
        });
        async move { rx.await.unwrap_or_else(|_| Err(RpcError(GONE.into()))) }
    }

    /// Blocking request with a timeout. Never call this on the UI thread (tests / startup only).
    pub fn request_blocking(
        &self,
        method: &str,
        args: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value> {
        let (tx, rx) = mpsc::channel();
        self.request_with(method, args, move |r| {
            let _ = tx.send(r);
        });
        rx.recv_timeout(timeout)
            .map_err(|_| anyhow!("{method}: no response within {timeout:?}"))?
            .map_err(|e| anyhow!("{method}: {e}"))
    }

    // Typed helpers for the calls the app makes (all fire-and-forget).

    /// Holds keys / mouse input from now until Lua acks the returned number
    /// ([`INPUT_ACK`]) or [`Rpc::release_input`] gives up on it. Send the notification Lua acks
    /// right after this.
    pub fn hold_input(&self) -> u64 {
        let mut g = self.inner.gate.lock();
        g.held += 1;
        g.held
    }

    /// Hold `seq` is done (acked, or timed out): sends the held input once no later hold waits.
    pub fn release_input(&self, seq: u64) {
        let mut g = self.inner.gate.lock();
        g.acked = g.acked.max(seq);
        if g.acked >= g.held {
            // (under the lock: input sent meanwhile queues behind these)
            for msg in g.queue.drain(..) {
                let _ = self.inner.out.send(msg);
            }
        }
    }

    /// Input is being held ([`Rpc::hold_input`]).
    pub fn input_held(&self) -> bool {
        let g = self.inner.gate.lock();
        g.acked < g.held
    }

    /// Input notification: sent, or queued while a hold waits.
    fn notify_input(&self, method: &str, args: Vec<Value>) {
        let msg = Value::Array(vec![2.into(), method.into(), Value::Array(args)]);
        let mut g = self.inner.gate.lock();
        if g.acked < g.held {
            g.queue.push(msg);
        } else {
            let _ = self.inner.out.send(msg);
        }
    }

    /// `nvim_input`: keys in nvim notation (`<C-x>`, `<lt>`, ...).
    pub fn input(&self, keys: &str) {
        self.notify_input("nvim_input", vec![keys.into()]);
    }

    /// `nvim_input_mouse`. `button`: left / right / middle / wheel / move; `action`: press / drag /
    /// release, or up / down / left / right for the wheel; `modifier`: e.g. "C-S-".
    pub fn input_mouse(
        &self,
        button: &str,
        action: &str,
        modifier: &str,
        grid: u64,
        row: usize,
        col: usize,
    ) {
        self.notify_input(
            "nvim_input_mouse",
            vec![
                button.into(),
                action.into(),
                modifier.into(),
                grid.into(),
                (row as u64).into(),
                (col as u64).into(),
            ],
        );
    }

    pub fn ui_try_resize(&self, cols: usize, rows: usize) {
        self.notify(
            "nvim_ui_try_resize",
            vec![(cols as u64).into(), (rows as u64).into()],
        );
    }

    /// `nvim_ui_try_resize_grid`: a window grid's text area (without its winbar). nvim keeps the
    /// request (`w_width_request` / `w_height_request`) across layout changes; 0 drops it.
    ///
    /// Sent as a request, not a notification: keys typed before the app read the redraw it sizes
    /// for (`nvim_input` runs the moment it arrives) can close the window first, and nvim answers
    /// a resize of a gone grid with "Invalid window handle", nothing to do then. Other errors are
    /// kept with the error events.
    pub fn ui_try_resize_grid(&self, grid: u64, cols: usize, rows: usize) {
        let inner = Arc::downgrade(&self.inner);
        self.request_with(
            "nvim_ui_try_resize_grid",
            vec![grid.into(), (cols as u64).into(), (rows as u64).into()],
            move |r| {
                if let Err(RpcError(msg)) = r
                    && !msg.starts_with(GONE_GRID)
                    && msg != GONE
                    && msg != EXITED
                    && let Some(inner) = inner.upgrade()
                {
                    eprintln!("[vimstorm] nvim_ui_try_resize_grid: {msg}");
                    inner.keep_error(msg);
                }
            },
        );
    }

    pub fn ui_set_focus(&self, focused: bool) {
        self.notify("nvim_ui_set_focus", vec![focused.into()]);
    }

    pub fn command(&self, cmd: &str) {
        self.notify("nvim_command", vec![cmd.into()]);
    }

    /// `nvim_exec_lua` as a notification (the Lua bridge).
    pub fn exec_lua(&self, code: &str, args: Vec<Value>) {
        self.notify("nvim_exec_lua", vec![code.into(), Value::Array(args)]);
    }

    /// A blocking prompt (hit-enter, `-- More --`, confirm(), getchar()) gets Esc, so the Lua sent
    /// before this runs (nvim runs no Lua until the prompt has its key). `nvim_get_mode` is
    /// answered at once, in a prompt too; the Esc goes ahead of held input.
    pub fn unblock(&self) {
        let inner = Arc::downgrade(&self.inner);
        self.request_with("nvim_get_mode", Vec::new(), move |r| {
            if let (Ok(mode), Some(inner)) = (r, inner.upgrade())
                && super::mode_blocking(&mode)
            {
                let esc = Value::Array(vec![
                    2.into(),
                    "nvim_input".into(),
                    Value::Array(vec!["<Esc>".into()]),
                ]);
                let _ = inner.out.send(esc);
            }
        });
    }

    /// `nvim_exec_lua` as a notification sent in order with the input: queued behind input a hold
    /// waits on ([`Rpc::hold_input`]), so nvim runs it after those keys.
    pub fn exec_lua_after_input(&self, code: &str, args: Vec<Value>) {
        self.notify_input("nvim_exec_lua", vec![code.into(), Value::Array(args)]);
    }

    fn respond(&self, id: u64, result: Result<Value, RpcError>) {
        if let Some(done) = self.inner.pending.lock().remove(&id) {
            done(result);
        }
    }

    fn fail_all_pending(&self) {
        let pending: Vec<_> = self.inner.pending.lock().drain().collect();
        for (_, done) in pending {
            done(Err(RpcError(EXITED.into())));
        }
    }
}

fn writer(stdin: impl Write, rx: mpsc::Receiver<Value>) {
    let mut w = BufWriter::new(stdin);
    while let Ok(msg) = rx.recv() {
        if rmpv::encode::write_value(&mut w, &msg).is_err() {
            return;
        }
        // Batch whatever is queued already into one write.
        while let Ok(msg) = rx.try_recv() {
            if rmpv::encode::write_value(&mut w, &msg).is_err() {
                return;
            }
        }
        if w.flush().is_err() {
            return;
        }
    }
}

fn reader(stdout: impl Read, rpc: Rpc, mut on_event: impl FnMut(NvimEvent)) {
    let mut r = BufReader::with_capacity(1 << 16, stdout);
    let mut batch: Vec<RedrawEvent> = Vec::new();
    loop {
        let msg = match rmpv::decode::read_value(&mut r) {
            Ok(v) => v,
            Err(e) => {
                if !is_eof(&e) {
                    eprintln!("[vimstorm] nvim rpc read error: {e}");
                }
                break;
            }
        };
        let Some(items) = msg.as_array() else {
            continue;
        };
        match items.first().and_then(Value::as_u64) {
            // response: [1, msgid, error, result]
            Some(1) => {
                let Some(id) = items.get(1).and_then(Value::as_u64) else {
                    continue;
                };
                let err = items.get(2).cloned().unwrap_or(Value::Nil);
                let result = if err.is_nil() {
                    Ok(items.get(3).cloned().unwrap_or(Value::Nil))
                } else {
                    Err(RpcError(error_message(&err)))
                };
                rpc.respond(id, result);
            }
            // notification: [2, method, params]
            Some(2) => {
                let method = items.get(1).and_then(Value::as_str).unwrap_or("");
                let params = items
                    .get(2)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                match method {
                    "redraw" => {
                        for ev in parse_redraw(&params) {
                            let flush = ev == RedrawEvent::Flush;
                            batch.push(ev);
                            if flush {
                                on_event(NvimEvent::Redraw(std::mem::take(&mut batch)));
                            }
                        }
                    }
                    "nvim_error_event" => {
                        eprintln!("[vimstorm] nvim_error_event: {params:?}");
                        let msg = params.get(1).and_then(Value::as_str).unwrap_or("");
                        rpc.inner.keep_error(msg.to_owned());
                    }
                    INPUT_ACK => {
                        if let Some(seq) = params.first().and_then(Value::as_u64) {
                            rpc.release_input(seq);
                        }
                    }
                    _ => on_event(NvimEvent::Notification(method.to_owned(), params)),
                }
            }
            // request from nvim (rpcrequest): the app serves none yet; answer so nvim doesn't hang
            Some(0) => {
                if let Some(id) = items.get(1).and_then(Value::as_u64) {
                    let method = items.get(2).and_then(Value::as_str).unwrap_or("");
                    let _ = rpc.inner.out.send(Value::Array(vec![
                        1.into(),
                        id.into(),
                        format!("vimstorm: unknown request {method}").into(),
                        Value::Nil,
                    ]));
                }
            }
            _ => {}
        }
    }
    rpc.fail_all_pending();
    on_event(NvimEvent::Exited);
}

fn is_eof(e: &rmpv::decode::Error) -> bool {
    match e {
        rmpv::decode::Error::InvalidMarkerRead(io) | rmpv::decode::Error::InvalidDataRead(io) => {
            io.kind() == std::io::ErrorKind::UnexpectedEof
        }
        _ => false,
    }
}

fn error_message(err: &Value) -> String {
    err.as_array()
        .and_then(|a| a.get(1))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    /// A fake nvim on a socket pair: returns (rpc, fake end, events).
    fn setup() -> (Rpc, UnixStream, mpsc::Receiver<NvimEvent>) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (tx, rx) = mpsc::channel();
        let rpc = Rpc::start(ours.try_clone().unwrap(), ours, move |ev| {
            let _ = tx.send(ev);
        });
        (rpc, theirs, rx)
    }

    /// A resize answered "Invalid window handle" (keys closed the window first) is no error; any
    /// other answer is kept with the error events.
    #[test]
    fn a_resize_of_a_closed_grid_is_no_error() {
        let (rpc, mut fake, _events) = setup();
        for (grid, answer) in [(5, "Invalid window handle: 5"), (6, "Bad size")] {
            rpc.ui_try_resize_grid(grid, 80, 20);
            let req = rmpv::decode::read_value(&mut fake).unwrap();
            let req = req.as_array().unwrap().clone();
            assert_eq!(req[0].as_u64(), Some(0), "a request");
            assert_eq!(req[2].as_str(), Some("nvim_ui_try_resize_grid"));
            let err = Value::Array(vec![1.into(), answer.into()]);
            let msg = Value::Array(vec![1.into(), req[1].clone(), err, Value::Nil]);
            rmpv::encode::write_value(&mut fake, &msg).unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while rpc.error_events().is_empty() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(rpc.error_events(), vec!["Bad size".to_owned()]);
    }

    #[test]
    fn requests_get_their_responses_and_redraw_is_cut_at_flush() {
        let (rpc, mut fake, events) = setup();
        let (tx, rx) = mpsc::channel();
        rpc.request_with("nvim_eval", vec!["1+1".into()], move |r| {
            tx.send(r).unwrap();
        });
        let req = rmpv::decode::read_value(&mut fake).unwrap();
        let req = req.as_array().unwrap();
        assert_eq!(req[0].as_u64(), Some(0));
        assert_eq!(req[2].as_str(), Some("nvim_eval"));
        let id = req[1].clone();

        let redraw =
            |evs: Vec<Value>| Value::Array(vec![2.into(), "redraw".into(), Value::Array(evs)]);
        let ev = |name: &str, args: Vec<Value>| Value::Array(vec![name.into(), Value::Array(args)]);
        for msg in [
            redraw(vec![ev("grid_clear", vec![1.into()])]),
            Value::Array(vec![1.into(), id, Value::Nil, 2.into()]),
            redraw(vec![ev("grid_clear", vec![2.into()]), ev("flush", vec![])]),
        ] {
            rmpv::encode::write_value(&mut fake, &msg).unwrap();
        }
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Ok(2.into())
        );
        match events.recv_timeout(Duration::from_secs(5)).unwrap() {
            NvimEvent::Redraw(evs) => assert_eq!(
                evs,
                vec![
                    RedrawEvent::GridClear { grid: 1 },
                    RedrawEvent::GridClear { grid: 2 },
                    RedrawEvent::Flush
                ]
            ),
            other => panic!("{other:?}"),
        }
        drop(fake);
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            NvimEvent::Exited
        ));
    }

    /// Input after a hold waits for Lua's ack (or the release), in order; other messages don't.
    #[test]
    fn held_input_goes_out_after_the_ack_in_order() {
        let (rpc, mut fake, _events) = setup();
        let mut w = fake.try_clone().unwrap();
        let mut read = || {
            let v = rmpv::decode::read_value(&mut fake).unwrap();
            let a = v.as_array().unwrap().clone();
            let method = a[1].as_str().unwrap().to_owned();
            let arg = a[2].as_array().unwrap().first().cloned();
            (method, arg.and_then(|v| v.as_str().map(str::to_owned)))
        };
        let seq = rpc.hold_input();
        rpc.exec_lua("focus", vec![]);
        rpc.input("<D-t>");
        rpc.input_mouse("left", "press", "", 1, 0, 0);
        assert!(rpc.input_held());
        assert_eq!(read(), ("nvim_exec_lua".into(), Some("focus".into())));
        // a second hold: the first ack alone doesn't open the gate
        let seq2 = rpc.hold_input();
        rpc.input("x");
        let ack = |seq: u64| {
            Value::Array(vec![
                2.into(),
                INPUT_ACK.into(),
                Value::Array(vec![seq.into()]),
            ])
        };
        rmpv::encode::write_value(&mut w, &ack(seq)).unwrap();
        rpc.command("marker");
        assert_eq!(read(), ("nvim_command".into(), Some("marker".into())));
        assert!(rpc.input_held());
        rmpv::encode::write_value(&mut w, &ack(seq2)).unwrap();
        assert_eq!(read(), ("nvim_input".into(), Some("<D-t>".into())));
        assert_eq!(read().0, "nvim_input_mouse");
        assert_eq!(read(), ("nvim_input".into(), Some("x".into())));
        assert!(!rpc.input_held());
        // a timed-out hold releases too; input then goes straight out
        let seq3 = rpc.hold_input();
        rpc.input("y");
        rpc.release_input(seq3);
        rpc.input("z");
        assert_eq!(read(), ("nvim_input".into(), Some("y".into())));
        assert_eq!(read(), ("nvim_input".into(), Some("z".into())));
    }

    #[test]
    fn pending_requests_fail_when_nvim_exits() {
        let (rpc, fake, _events) = setup();
        let fut = rpc.request("nvim_get_mode", vec![]);
        drop(fake);
        assert!(futures::executor::block_on(fut).is_err());
    }
}
