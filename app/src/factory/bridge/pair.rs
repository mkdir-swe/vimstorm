//! The session's in-memory adapter: a line pair per start, no process. What the app sends is
//! kept as lines; what the "bridge" says is decoded on a reader thread of its own, as the
//! process's stdout is. The bridge session's tests restart it without GPUI.

use std::sync::{Arc, Mutex};

use futures::channel::mpsc::UnboundedSender;

use super::{Adapter, BridgeEvent, Link};
use crate::factory::protocol::AppFrame;

/// The pairs, one per start; clones share them (the test keeps one, the session another).
#[derive(Clone, Default)]
pub struct Pair {
    ends: Arc<Mutex<Ends>>,
}

#[derive(Default)]
struct Ends {
    started: Vec<End>,
    /// The next start fails with this.
    refuse: Option<String>,
}

/// One start's pair: the lines the app sent it, its mouth (None once it ended).
#[derive(Default)]
struct End {
    heard: Vec<String>,
    mouth: Option<std::sync::mpsc::Sender<String>>,
}

impl Pair {
    pub fn new() -> Pair {
        Pair::default()
    }

    fn ends(&self) -> std::sync::MutexGuard<'_, Ends> {
        self.ends.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// How many bridges were started.
    pub fn starts(&self) -> usize {
        self.ends().started.len()
    }

    /// The lines start `n` (0-based) heard, in order.
    pub fn heard(&self, n: usize) -> Vec<String> {
        self.ends()
            .started
            .get(n)
            .map(|e| e.heard.clone())
            .unwrap_or_default()
    }

    /// Start `n`'s bridge prints `line`.
    pub fn say_on(&self, n: usize, line: &str) {
        if let Some(mouth) = self.ends().started.get(n).and_then(|e| e.mouth.as_ref()) {
            let _ = mouth.send(line.to_owned());
        }
    }

    /// The latest bridge prints `line`.
    pub fn say(&self, line: &str) {
        let n = self.starts().saturating_sub(1);
        self.say_on(n, line);
    }

    /// The latest bridge exits.
    pub fn end(&self) {
        if let Some(e) = self.ends().started.last_mut() {
            e.mouth = None;
        }
    }

    /// The next start fails, saying `why`.
    pub fn refuse(&self, why: &str) {
        self.ends().refuse = Some(why.to_owned());
    }
}

impl Adapter for Pair {
    fn start(
        &mut self,
        generation: u64,
        to_app: UnboundedSender<BridgeEvent>,
    ) -> std::io::Result<Box<dyn Link>> {
        let mut ends = self.ends();
        if let Some(why) = ends.refuse.take() {
            return Err(std::io::Error::other(why));
        }
        let (mouth, said) = std::sync::mpsc::channel::<String>();
        std::thread::Builder::new()
            .name("abe-bridge-pair".into())
            .spawn(move || super::read(said.into_iter(), generation, &to_app))?;
        ends.started.push(End {
            heard: Vec::new(),
            mouth: Some(mouth),
        });
        Ok(Box::new(PairLink {
            ends: self.ends.clone(),
            n: ends.started.len() - 1,
        }))
    }
}

struct PairLink {
    ends: Arc<Mutex<Ends>>,
    n: usize,
}

impl Link for PairLink {
    fn send(&self, frame: AppFrame) {
        let mut ends = self.ends.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = ends.started.get_mut(self.n) {
            e.heard.push(frame.line());
        }
    }
}

impl Drop for PairLink {
    /// The app let go of this bridge: it ends (as the process is killed).
    fn drop(&mut self) {
        let mut ends = self.ends.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = ends.started.get_mut(self.n) {
            e.mouth = None;
        }
    }
}
