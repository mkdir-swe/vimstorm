//! The bridge session: the one owner of the `abe ui bridge` the window talks to. It holds the
//! process (behind an [`Adapter`]: the process, [`BridgeCommand`], or the in-memory [`Pair`]),
//! its generation and how often it was restarted, and what the window wants the bridge to know:
//! the screens open in each slot, the sizes, the keyboard, the window, the shown project, the
//! caret and the Settings dialog. Each `want_*` sends only what changed since the bridge was last
//! told; a new bridge (a restart, a retry) is told all of it again, in one order, with the
//! [`Landing`] the view gives for that start. What the bridge says is decoded on the adapter's
//! reader thread ([`read`]), where a slot's patch is applied to the tree held for it ([`Trees`])
//! so the window only ever takes whole trees; [`Session::take`] drops a dead bridge's frames and
//! any tree or layer older than the one already taken, asks again for a slot whose patch did not
//! apply, refuses a bridge of another contract version, and answers the shell's own `run`s.
//!
//! The view only says what it wants ([`super::FactoryView`]); nothing here needs GPUI.

#[cfg(test)]
mod pair;
mod process;

use std::collections::{BTreeMap, HashMap};

use futures::channel::mpsc::UnboundedSender;
use futures::channel::oneshot;
use serde_json::Value;

use super::protocol::{
    self, AppFrame, BridgeFrame, Caret, Node, Said, Slot, VERSION, ViewName, ViewSize,
};

#[cfg(test)]
pub use pair::Pair;
pub use process::BridgeCommand;

/// Params of a screen's `open`.
pub type Params = BTreeMap<String, String>;

/// How a bridge is started: its frames (decoded) and its end go to `to_app` tagged with
/// `generation`; what the app sends goes to the returned [`Link`].
pub trait Adapter {
    fn start(
        &mut self,
        generation: u64,
        to_app: UnboundedSender<BridgeEvent>,
    ) -> std::io::Result<Box<dyn Link>>;
}

/// A started bridge's writing half; dropping it ends that bridge.
pub trait Link {
    fn send(&self, frame: AppFrame);
}

/// What a bridge's reader thread hands the UI thread, tagged with its generation: a decoded
/// frame (and, in a shots build, its line for the drive socket's tap), or its end.
#[derive(Debug)]
pub enum BridgeEvent {
    Frame {
        generation: u64,
        frame: Box<BridgeFrame>,
        #[cfg(feature = "shots")]
        line: String,
    },
    /// A patch for `slot` did not apply to the tree held there: the bridge is asked for it whole.
    Again {
        generation: u64,
        slot: Slot,
    },
    Exited(u64),
}

/// Each slot's tree as the reader last built it, with the rev and screen of the frame that set
/// it: what that slot's next patch applies to. One per reader, so a new bridge starts empty.
#[derive(Default)]
pub struct Trees {
    held: HashMap<Slot, Held>,
}

struct Held {
    screen: String,
    rev: u64,
    tree: Node,
}

impl Trees {
    /// A decoded line as the window takes it: a frame (a patch made a whole tree), or Err(slot)
    /// when a patch for it did not apply (what was held there is dropped).
    pub fn take(&mut self, said: Said) -> Result<Box<BridgeFrame>, Slot> {
        match said {
            Said::Frame(frame) => {
                match frame.as_ref() {
                    BridgeFrame::Tree {
                        screen,
                        rev,
                        tree,
                        slot,
                        ..
                    } => {
                        let held = Held {
                            screen: screen.clone(),
                            rev: *rev,
                            tree: tree.clone(),
                        };
                        self.held.insert(slot.unwrap_or_default(), held);
                    }
                    BridgeFrame::Closed { slot, .. } => {
                        self.held.remove(slot);
                    }
                    _ => {}
                }
                Ok(frame)
            }
            Said::Patch(p) => {
                let slot = p.slot.unwrap_or_default();
                let Some(mut held) = self.held.remove(&slot) else {
                    protocol::log_once("patch:none", "a patch with no tree held: asked again");
                    return Err(slot);
                };
                if held.rev != p.base || held.screen != p.screen {
                    protocol::log_once(
                        "patch:base",
                        &format!(
                            "a patch on {} rev {} over {} rev {}: asked again",
                            p.screen, p.base, held.screen, held.rev
                        ),
                    );
                    return Err(slot);
                }
                if let Err(why) = protocol::apply(&mut held.tree, p.ops) {
                    protocol::log_once("patch:apply", &format!("a patch did not apply ({why})"));
                    return Err(slot);
                }
                held.rev = p.rev;
                let frame = BridgeFrame::Tree {
                    v: p.v,
                    screen: p.screen,
                    rev: p.rev,
                    tree: held.tree.clone(),
                    slot: p.slot,
                };
                self.held.insert(slot, held);
                Ok(Box::new(frame))
            }
        }
    }
}

/// A bridge's lines decoded where they are read (never on the UI thread), its patches applied
/// there, then its end.
pub(super) fn read(
    lines: impl Iterator<Item = String>,
    generation: u64,
    to_app: &UnboundedSender<BridgeEvent>,
) {
    let mut trees = Trees::default();
    for line in lines {
        let Some(said) = protocol::read_said(&line) else {
            continue;
        };
        let ev = match trees.take(said) {
            Ok(frame) => BridgeEvent::Frame {
                generation,
                frame,
                #[cfg(feature = "shots")]
                line,
            },
            Err(slot) => BridgeEvent::Again { generation, slot },
        };
        if to_app.unbounded_send(ev).is_err() {
            return;
        }
    }
    let _ = to_app.unbounded_send(BridgeEvent::Exited(generation));
}

/// What the session hands on of what the current bridge said.
#[derive(Debug)]
pub enum Heard {
    /// A frame to apply: a newer tree or layer, a closed slot, a shell effect.
    Frame(Box<BridgeFrame>),
    /// The bridge exited.
    Exited,
    /// It speaks another contract version: refused ([`Session::stopped`] says why from now on).
    Refused,
}

/// The params some screens open with on one start in place of the kept ones (a restarted Board
/// on the card the dead one had selected, Chat on the session picked in it).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Landing {
    pub slots: Vec<(Slot, Params)>,
}

/// A slot's screen and the params it was opened with.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Opened {
    pub screen: String,
    pub params: Params,
}

/// The shown project as the bridge hears it: `hello`'s root, then `project`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Project {
    pub root: Option<String>,
    pub box_: Option<String>,
    pub branch: Option<String>,
}

/// The view shown, the window's activation, the stripe's place (`window`).
#[derive(Clone, Debug, PartialEq)]
pub struct WindowAt {
    pub view: ViewName,
    pub active: bool,
    pub place: Option<String>,
}

/// What the window wants the bridge to know.
#[derive(Default)]
struct Want {
    size: Option<ViewSize>,
    project: Project,
    /// Main's (always there once the view said its screen) and the other slots'.
    opened: BTreeMap<Slot, Opened>,
    sizes: BTreeMap<Slot, ViewSize>,
    focus: Option<Slot>,
    window: Option<WindowAt>,
    /// None: nothing to say; `Some(None)`: no file open.
    caret: Option<Option<Caret>>,
    settings: Option<Params>,
}

/// What the current bridge was told; a new one starts at its defaults (no slot focused, the
/// rest unknown).
#[derive(Default)]
struct Told {
    size: Option<ViewSize>,
    project: Option<(String, Option<String>, Option<String>)>,
    sizes: BTreeMap<Slot, ViewSize>,
    focus: Option<Slot>,
    window: Option<WindowAt>,
    caret: Option<Option<Caret>>,
}

pub struct Session {
    adapter: Option<Box<dyn Adapter>>,
    link: Option<Box<dyn Link>>,
    to_app: UnboundedSender<BridgeEvent>,
    generation: u64,
    restarts: u32,
    stopped: Option<String>,
    want: Want,
    told: Told,
    /// The newest tree's rev taken per slot, and the layer's (this bridge's: a new one counts
    /// from 1 again).
    revs: HashMap<Slot, u64>,
    layer_rev: Option<u64>,
    /// The shell's own commands waiting on their answer, by id.
    runs: HashMap<String, oneshot::Sender<Value>>,
    run_seq: u64,
    /// A version refusal not handed on yet ([`Heard::Refused`]).
    refused: bool,
}

impl Session {
    /// A session with no bridge yet; its bridges' events go to `to_app`.
    pub fn new(to_app: UnboundedSender<BridgeEvent>) -> Session {
        Session {
            adapter: None,
            link: None,
            to_app,
            generation: 0,
            restarts: 0,
            stopped: None,
            want: Want::default(),
            told: Told::default(),
            revs: HashMap::new(),
            layer_rev: None,
            runs: HashMap::new(),
            run_seq: 0,
            refused: false,
        }
    }

    // ------------------------------------------------------------------ the bridge's life

    /// Started (once; see [`Self::retry`]): the first bridge, told everything wanted. Err: it
    /// could not start (the caller treats it as [`Self::lost`]).
    pub fn start(&mut self, adapter: Box<dyn Adapter>, landing: Landing) -> Result<(), String> {
        self.adapter = Some(adapter);
        self.connect(landing)
    }

    /// Whether a bridge was ever started.
    pub fn started(&self) -> bool {
        self.adapter.is_some()
    }

    /// A bridge runs (one can be told things).
    pub fn up(&self) -> bool {
        self.link.is_some()
    }

    /// How many bridges were started (1, or 2 after its restart).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Why there is no bridge any more (it died after its one restart).
    pub fn stopped(&self) -> Option<&str> {
        self.stopped.as_deref()
    }

    /// The bridge is gone: the shell's commands waiting on it hear so now.
    pub fn lost(&mut self) {
        self.link = None;
        self.runs.clear();
    }

    /// After [`Self::lost`]: the one restart, with `landing`; Err with why it stays down (it was
    /// restarted already, or the restart failed too), [`Self::stopped`] from then on.
    pub fn restart(&mut self, why: String, landing: Landing) -> Result<(), String> {
        let result = if self.restarts == 0 {
            self.restarts += 1;
            self.connect(landing)
        } else {
            Err(why)
        };
        if let Err(why) = &result {
            self.link = None;
            self.stopped = Some(why.clone());
        }
        result
    }

    /// Started anew after it stopped (Settings' Retry): one restart allowed again. Err: it could
    /// not start (the caller treats it as [`Self::lost`]).
    pub fn retry(
        &mut self,
        adapter: impl FnOnce() -> Box<dyn Adapter>,
        landing: Landing,
    ) -> Result<(), String> {
        if self.up() {
            return Ok(());
        }
        self.restarts = 0;
        self.stopped = None;
        if self.adapter.is_none() {
            self.adapter = Some(adapter());
        }
        self.connect(landing)
    }

    /// A new bridge, told all that is wanted.
    fn connect(&mut self, landing: Landing) -> Result<(), String> {
        let Some(adapter) = self.adapter.as_mut() else {
            return Err("no bridge to start".into());
        };
        self.generation += 1;
        self.link = None;
        self.told = Told::default();
        self.revs.clear();
        self.layer_rev = None;
        let link = adapter
            .start(self.generation, self.to_app.clone())
            .map_err(|e| e.to_string())?;
        let size = self.want.size.unwrap_or(ViewSize {
            width: 0.,
            height: 0.,
        });
        link.send(AppFrame::Hello {
            v: VERSION,
            size,
            version: env!("CARGO_PKG_VERSION").into(),
            root: self.want.project.root.clone(),
        });
        self.told.size = Some(size);
        self.link = Some(link);
        let landed = |slot: Slot, o: &Opened| {
            landing
                .slots
                .iter()
                .find(|(s, _)| *s == slot)
                .map_or_else(|| o.params.clone(), |(_, p)| p.clone())
        };
        if let Some(main) = self.want.opened.get(&Slot::Main).cloned() {
            let params = landed(Slot::Main, &main);
            self.send_open(Slot::Main, &main.screen, params);
        }
        // the dialog was up when the bridge went: open again on the new one
        if let Some(params) = self.want.settings.clone() {
            self.send(AppFrame::Open {
                v: VERSION,
                screen: super::settings::SCREEN.into(),
                params,
                slot: None,
            });
        }
        self.tell_project();
        let others: Vec<(Slot, Opened)> = self
            .want
            .opened
            .iter()
            .filter(|(s, _)| **s != Slot::Main)
            .map(|(s, o)| (*s, o.clone()))
            .collect();
        for (slot, o) in others {
            let params = landed(slot, &o);
            self.send_open(slot, &o.screen, params);
        }
        self.tell_sizes();
        self.tell_focus();
        self.tell_window();
        self.tell_caret();
        Ok(())
    }

    // ------------------------------------------------------------------ what the window wants

    /// Sent now when a bridge runs (dropped when none does): the one-off frames (keys, clicks,
    /// extents, exits, jumps). Whether one ran.
    pub fn send(&self, frame: AppFrame) -> bool {
        match &self.link {
            Some(l) => {
                l.send(frame);
                true
            }
            None => false,
        }
    }

    fn send_open(&self, slot: Slot, screen: &str, params: Params) {
        self.send(AppFrame::Open {
            v: VERSION,
            screen: screen.to_owned(),
            params,
            slot: slot.named(),
        });
    }

    /// `screen` opened in `slot` (main: in place of its screen): sent now, and again to a new
    /// bridge.
    pub fn open(&mut self, slot: Slot, screen: &str, params: Params) {
        self.send_open(slot, screen, params.clone());
        self.want.opened.insert(
            slot,
            Opened {
                screen: screen.to_owned(),
                params,
            },
        );
    }

    /// `screen` opened in `slot` now only: a new bridge opens what was there before.
    pub fn open_once(&mut self, slot: Slot, screen: &str, params: Params) {
        self.send_open(slot, screen, params);
    }

    /// The bridge drew `screen` in `slot` (it opens screens itself too): a new bridge opens that
    /// one, with the params kept (main's is there from the first; another slot only once opened).
    pub fn screen_is(&mut self, slot: Slot, screen: &str) {
        let o = match slot {
            Slot::Main => Some(self.want.opened.entry(Slot::Main).or_default()),
            _ => self.want.opened.get_mut(&slot),
        };
        if let Some(o) = o
            && o.screen != screen
        {
            screen.clone_into(&mut o.screen);
        }
    }

    /// What `slot` has open, as a new bridge would open it.
    pub fn opened(&self, slot: Slot) -> Option<&Opened> {
        self.want.opened.get(&slot)
    }

    /// The popup closed by the app (the Board left): the bridge told, its trees count anew.
    pub fn close(&mut self, slot: Slot) {
        self.send(AppFrame::Close { v: VERSION, slot });
        self.revs.remove(&slot);
    }

    /// The main slot's size (the Board's).
    pub fn want_size(&mut self, size: ViewSize) {
        self.want.size = Some(size);
        if self.up() && self.told.size != Some(size) {
            self.send(AppFrame::Resize {
                v: VERSION,
                size,
                slot: None,
            });
            self.told.size = Some(size);
        }
    }

    /// Another slot's measured size.
    pub fn want_slot_size(&mut self, slot: Slot, size: ViewSize) {
        self.want.sizes.insert(slot, size);
        self.tell_sizes();
    }

    fn tell_sizes(&mut self) {
        if !self.up() {
            return;
        }
        let changed: Vec<(Slot, ViewSize)> = self
            .want
            .sizes
            .iter()
            .filter(|(s, z)| self.told.sizes.get(s) != Some(z))
            .map(|(s, z)| (*s, *z))
            .collect();
        for (slot, size) in changed {
            self.send(AppFrame::Resize {
                v: VERSION,
                size,
                slot: slot.named(),
            });
            self.told.sizes.insert(slot, size);
        }
    }

    /// The shown project: its folder (`hello`'s root, then `project` once there is one), its
    /// box, the branch checked out there.
    pub fn want_project(&mut self, project: Project) {
        self.want.project = project;
        self.tell_project();
    }

    pub fn project(&self) -> &Project {
        &self.want.project
    }

    fn tell_project(&mut self) {
        let p = &self.want.project;
        let Some(root) = p.root.clone() else {
            return;
        };
        let now = (root, p.box_.clone(), p.branch.clone());
        if !self.up() || self.told.project.as_ref() == Some(&now) {
            return;
        }
        self.send(AppFrame::Project {
            v: VERSION,
            root: now.0.clone(),
            box_: now.1.clone(),
            branch: now.2.clone(),
        });
        self.told.project = Some(now);
    }

    /// The slot with the keyboard (None: none of them).
    pub fn want_focus(&mut self, slot: Option<Slot>) {
        self.want.focus = slot;
        self.tell_focus();
    }

    /// The slot the bridge is to hear has the keyboard.
    pub fn focus(&self) -> Option<Slot> {
        self.want.focus
    }

    fn tell_focus(&mut self) {
        if self.up() && self.told.focus != self.want.focus {
            self.send(AppFrame::Focus {
                v: VERSION,
                slot: self.want.focus,
            });
            self.told.focus = self.want.focus;
        }
    }

    /// The keyboard told to leave its slot and come back (a landing in the slot that had it).
    pub fn refocus(&self) {
        if self.told.focus.is_some() && self.told.focus == self.want.focus {
            for slot in [None, self.want.focus] {
                self.send(AppFrame::Focus { v: VERSION, slot });
            }
        }
    }

    /// The view shown, the window's activation and the stripe's place.
    pub fn want_window(&mut self, at: WindowAt) {
        self.want.window = Some(at);
        self.tell_window();
    }

    fn tell_window(&mut self) {
        let Some(at) = self.want.window.clone() else {
            return;
        };
        if self.up() && self.told.window.as_ref() != Some(&at) {
            self.send(AppFrame::Window {
                v: VERSION,
                view: at.view,
                active: at.active,
                place: at.place.clone(),
            });
            self.told.window = Some(at);
        }
    }

    /// The Editor's caret (None: no file open there).
    pub fn want_caret(&mut self, caret: Option<Caret>) {
        self.want.caret = Some(caret);
        self.tell_caret();
    }

    /// The caret wanted (None: nothing said; `Some(None)`: no file open).
    pub fn caret(&self) -> Option<Option<&Caret>> {
        self.want.caret.as_ref().map(Option::as_ref)
    }

    /// Another workspace is shown: its caret is told anew, even the same.
    pub fn forget_caret(&mut self) {
        self.want.caret = None;
        self.told.caret = None;
    }

    fn tell_caret(&mut self) {
        let Some(want) = self.want.caret.clone() else {
            return;
        };
        if !self.up() || self.told.caret.as_ref() == Some(&want) {
            return;
        }
        self.send(match &want {
            Some(caret) => AppFrame::Caret {
                v: VERSION,
                caret: caret.clone(),
            },
            None => AppFrame::NoCaret { v: VERSION },
        });
        self.told.caret = Some(want);
    }

    /// The Settings dialog asked for (on its params): sent now, and opened again on a new bridge
    /// while it is up.
    pub fn open_settings(&mut self, params: Params) {
        self.send(AppFrame::Open {
            v: VERSION,
            screen: super::settings::SCREEN.into(),
            params: params.clone(),
            slot: None,
        });
        self.want.settings = Some(params);
    }

    /// The Settings dialog is up on these params (None: closed), nothing sent.
    pub fn set_settings(&mut self, params: Option<Params>) {
        self.want.settings = params;
    }

    pub fn settings(&self) -> Option<&Params> {
        self.want.settings.as_ref()
    }

    /// `abe <argv> --json` for the shell itself, its document once answered; None without a
    /// bridge (one gone before it answered drops the sender: the receiver hears cancelled).
    pub fn run(&mut self, argv: Vec<String>) -> Option<oneshot::Receiver<Value>> {
        if !self.up() {
            return None;
        }
        self.run_seq += 1;
        let id = format!(
            "{}:{}",
            argv.iter().take(2).cloned().collect::<Vec<_>>().join("-"),
            self.run_seq
        );
        let (tx, rx) = oneshot::channel();
        self.runs.insert(id.clone(), tx);
        self.send(AppFrame::Run {
            v: VERSION,
            id,
            argv,
        });
        Some(rx)
    }

    // ------------------------------------------------------------------ what the bridge says

    /// An event of a bridge: the current one's frames that count, its end; a dead one's nothing.
    pub fn take(&mut self, ev: BridgeEvent) -> Option<Heard> {
        match ev {
            BridgeEvent::Frame {
                generation, frame, ..
            } if generation == self.generation => self.accept(*frame).map(Heard::Frame),
            BridgeEvent::Exited(generation) if generation == self.generation => Some(Heard::Exited),
            BridgeEvent::Again { generation, slot } if generation == self.generation => {
                self.send(AppFrame::Again { v: VERSION, slot });
                None
            }
            _ => None,
        }
        .or_else(|| std::mem::take(&mut self.refused).then_some(Heard::Refused))
    }

    /// Why a frame says this bridge speaks another contract: its `v`, or its refusal of ours.
    fn mismatch(frame: &BridgeFrame, v: u32) -> Option<String> {
        if v != VERSION {
            return Some(format!(
                "abe ui bridge speaks contract v{v}, this VimStorm v{VERSION}: install the Abe that ships with this VimStorm"
            ));
        }
        match frame {
            BridgeFrame::Error { error, .. } if error.code == "unsupported-version" => {
                Some(format!(
                    "abe ui bridge refused this VimStorm's contract v{VERSION} ({}): install the Abe that ships with this VimStorm",
                    error.message
                ))
            }
            _ => None,
        }
    }

    /// A bridge of another contract version: stopped for good (a restart would be the same
    /// bridge), its waiters told, the reason kept for the view.
    fn refuse(&mut self, why: String) {
        protocol::log_once("version", &why);
        self.lost();
        self.restarts = 1;
        self.stopped = Some(why);
        self.refused = true;
    }

    /// A frame of the current bridge (tests hand fixture frames in here): None when it is
    /// another version's, a tree or layer older than the one taken, an answer (its waiter told)
    /// or an error (logged once).
    pub fn accept(&mut self, frame: BridgeFrame) -> Option<Box<BridgeFrame>> {
        let v = match &frame {
            BridgeFrame::Tree { v, .. }
            | BridgeFrame::Closed { v, .. }
            | BridgeFrame::Layer { v, .. }
            | BridgeFrame::Shell { v, .. }
            | BridgeFrame::Answer { v, .. }
            | BridgeFrame::Error { v, .. } => *v,
        };
        if let Some(why) = Self::mismatch(&frame, v) {
            if self.stopped.is_none() {
                self.refuse(why);
            }
            return None;
        }
        match frame {
            BridgeFrame::Tree { rev, slot, .. } => {
                let slot = slot.unwrap_or_default();
                if self.revs.get(&slot).is_some_and(|had| rev <= *had) {
                    return None;
                }
                self.revs.insert(slot, rev);
            }
            BridgeFrame::Layer { rev, .. } => {
                if self.layer_rev.is_some_and(|had| rev <= had) {
                    return None;
                }
                self.layer_rev = Some(rev);
            }
            BridgeFrame::Closed { slot, .. } => {
                self.revs.remove(&slot);
            }
            BridgeFrame::Answer { id, reply, .. } => {
                if let Some(tx) = self.runs.remove(&id) {
                    let _ = tx.send(reply);
                }
                return None;
            }
            BridgeFrame::Error { error, .. } => {
                protocol::log_once(
                    &format!("error:{}", error.code),
                    &format!(
                        "the bridge refused a frame: {} ({})",
                        error.message, error.code
                    ),
                );
                return None;
            }
            BridgeFrame::Shell { .. } => {}
        }
        Some(Box::new(frame))
    }
}

#[cfg(test)]
mod tests;
