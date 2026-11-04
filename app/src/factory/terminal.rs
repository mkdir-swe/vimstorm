//! The Terminal component (`abe/packages/ui/src/chat/terminal.ts`): a program the bridge
//! names (`argv`, `abe` being the bridge's own) in a PTY, drawn with VimStorm's terminal grid
//! ([`TermElement`]). The shell's one rule for it ([`Terms`]): one PTY per `key`, started when a
//! tree first holds the key, kept across trees while one does, dropped [`KEEP`] after the last tree
//! that held it or at once on `drop-terminal`. An exited program's last screen stays under its
//! key and is never started again; its exit goes to the bridge as an `exit` frame.
//!
//! Keys: every key goes to the program (typed text through the IME, the keys a TUI needs, ⌘V
//! pastes) except the node's `screenKeys` and other ⌘ keys, which go to the bridge as `key`
//! inputs. Which terminal has the keyboard is the tree's (`focused`), applied by the view.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alacritty_terminal::term::TermMode;
use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, EntityInputHandler, FocusHandle,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, SharedString, Styled as _,
    UTF16Selection, WeakEntity, Window, div, px,
};

use super::FactoryView;
use super::chat::{TerminalLink, TerminalProps};
use super::protocol::{Node, Slot, UserInput};
use crate::kit::notation;
use crate::render::CellMetrics;
use crate::render::{editor_font_size, scaled};
use crate::terminal::{self, ROW_HEIGHT, Shared, TermElement, TermHost};
use crate::terminal::{Pty, PtyEvent, Spawn};

/// How long a terminal no tree holds is kept (`TERMINAL_KEEP_MS`).
pub const KEEP: Duration = Duration::from_secs(10 * 60);

/// One program's terminal, drawn where its Terminal node is.
pub struct TermView {
    pub key: String,
    pty: Arc<Pty>,
    focus: FocusHandle,
    shared: Rc<Shared>,
    preedit: Option<String>,
    metrics: Option<CellMetrics>,
    /// The node's id: a click on the terminal names it to the bridge.
    node: Option<String>,
    screen_keys: Vec<String>,
    /// The node's links, compiled ([`TerminalLink`]).
    links: Vec<(regex::Regex, String)>,
    host: WeakEntity<FactoryView>,
    /// The slot whose tree holds it last: its keys and clicks go there.
    slot: Slot,
}

/// The links whose pattern compiles (a bad one logged once).
fn compiled(links: &[TerminalLink]) -> Vec<(regex::Regex, String)> {
    links
        .iter()
        .filter_map(|l| match regex::Regex::new(&l.pattern) {
            Ok(re) => Some((re, l.click.clone())),
            Err(e) => {
                super::protocol::log_once(
                    &format!("link:{}", l.pattern),
                    &format!(
                        "a terminal link's pattern doesn't compile ({e}): {}",
                        l.pattern
                    ),
                );
                None
            }
        })
        .collect()
}

/// The click a row's text names through the first link it matches.
pub fn link_click(links: &[(regex::Regex, String)], row: &str) -> Option<String> {
    links.iter().find_map(|(re, click)| {
        let caps = re.captures(row)?;
        let one = caps.get(1).map_or("", |m| m.as_str().trim());
        Some(click.replace("$1", one))
    })
}

impl TermView {
    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// Output came since the last call.
    pub fn take_dirty(&self) -> bool {
        self.pty.take_dirty()
    }

    /// Its PTY: the Editor's Claude Code tab draws an attach of Chat's session too.
    pub fn pty(&self) -> Arc<Pty> {
        self.pty.clone()
    }

    /// The program's pid (tests).
    pub fn pid(&self) -> u32 {
        self.pty.pid
    }

    /// The rows on screen (tests).
    pub fn screen(&self) -> Vec<String> {
        terminal::screen_lines(&*self.pty.term.lock())
    }

    /// Where row `row` of the screen is drawn, its middle (tests: a click on it).
    pub fn row_point(&self, row: usize) -> Option<gpui_kit::Point<Pixels>> {
        let l = self.shared.layout.get()?;
        Some(gpui_kit::point(
            l.origin.x + l.metrics.cell_width * 2.,
            l.origin.y + l.metrics.row_height * (row as f32 + 0.5),
        ))
    }

    /// The click a ⌘-click at `pos` names: the row under it, through the node's links.
    fn link_at(&self, pos: gpui_kit::Point<Pixels>) -> Option<String> {
        let layout = self.shared.layout.get()?;
        if !layout.bounds.contains(&pos) {
            return None;
        }
        let (row, _, _) = layout.cell_at(pos);
        let text = self.screen().get(row).cloned()?;
        link_click(&self.links, &text)
    }

    fn to_bridge(&self, input: UserInput, cx: &mut Context<Self>) {
        let slot = self.slot;
        let _ = self
            .host
            .update(cx, |v, cx| v.send_slot_input(slot, input, cx));
    }

    fn metrics(&mut self, window: &Window, cx: &App) -> CellMetrics {
        let size = editor_font_size(cx);
        match self.metrics {
            Some(m) if m.is_current(size) => m,
            _ => *self.metrics.insert(CellMetrics {
                row_height: px(scaled(ROW_HEIGHT, size)),
                ..CellMetrics::measure(window, size)
            }),
        }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let note = notation(ev).unwrap_or_default();
        let k = &ev.keystroke;
        if note == "<D-v>" {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                let bracketed = self
                    .pty
                    .term
                    .lock()
                    .mode()
                    .contains(TermMode::BRACKETED_PASTE);
                self.pty.write(terminal::paste(&text, bracketed));
            }
            cx.stop_propagation();
            return;
        }
        if k.modifiers.platform || self.screen_keys.contains(&note) {
            if !note.is_empty() {
                self.to_bridge(UserInput::Key { key: note }, cx);
            }
            cx.stop_propagation();
            return;
        }
        let mode = *self.pty.term.lock().mode();
        if let Some(bytes) = terminal::encode_in(k, mode) {
            self.pty.write(bytes);
            cx.stop_propagation();
        } else if k.modifiers.control {
            cx.stop_propagation();
        }
        // plain text goes on to the IME ([`EntityInputHandler`])
    }
}

impl TermHost for TermView {
    fn host_mouse_move(&mut self, _: &MouseMoveEvent, _: bool, _: bool, _: &mut Context<Self>) {}

    fn host_mouse_up(&mut self, _: &MouseUpEvent, _: bool, _: &mut Context<Self>) {}
}

impl EntityInputHandler for TermView {
    fn text_for_range(
        &mut self,
        range: std::ops::Range<usize>,
        adjusted: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let units: Vec<u16> = self
            .preedit
            .clone()
            .unwrap_or_default()
            .encode_utf16()
            .collect();
        let r = range.start.min(units.len())..range.end.min(units.len());
        *adjusted = Some(r.clone());
        Some(String::from_utf16_lossy(&units[r]))
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self
            .preedit
            .as_ref()
            .map_or(0, |m| m.encode_utf16().count());
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        self.preedit.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.preedit = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.preedit = None;
        if !text.is_empty() {
            self.pty.write(text.as_bytes().to_vec());
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        new_text: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.preedit = (!new_text.is_empty()).then(|| new_text.to_owned());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        None
    }

    fn character_index_for_point(
        &mut self,
        _: gpui_kit::Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

impl Render for TermView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let metrics = self.metrics(window, cx);
        let focused = self.focus.is_focused(window);
        let grid = TermElement {
            pty: self.pty.clone(),
            view: Some(cx.entity()),
            input_focus: self.focus.clone(),
            focused,
            metrics,
            scroll_px: 0.,
            matches: Rc::default(),
            current: None,
            preedit: if focused { self.preedit.clone() } else { None },
            shared: self.shared.clone(),
            float: false,
        };
        let key = self.key.clone();
        div()
            .id(SharedString::from(format!("factory-terminal-{key}")))
            .debug_selector(move || format!("factory-terminal-{key}"))
            .track_focus(&self.focus)
            .size_full()
            .bg(gpui_kit::rgb(terminal::palette().background))
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|t, ev: &MouseDownEvent, window, cx| {
                    // ⌘-click on a link row (`Show <title>`): its click, the keyboard staying put
                    if ev.modifiers.platform
                        && let Some(id) = t.link_at(ev.position)
                    {
                        t.to_bridge(UserInput::Click { id }, cx);
                        cx.stop_propagation();
                        return;
                    }
                    window.focus(&t.focus.clone(), cx);
                    if let Some(id) = t.node.clone() {
                        t.to_bridge(UserInput::Click { id }, cx);
                    }
                    cx.stop_propagation();
                }),
            )
            .child(grid)
    }
}

/// A terminal the view holds, and since when no tree has.
struct Held {
    view: Entity<TermView>,
    unheld: Option<Instant>,
}

/// Every terminal of the view, by key (see the module doc).
#[derive(Default)]
pub struct Terms {
    held: HashMap<String, Held>,
    /// A PTY's id → its key.
    ids: HashMap<u64, String>,
    next: u64,
    /// How long one no tree holds is kept ([`KEEP`]; tests shorten it).
    pub keep: Option<Duration>,
}

/// The Terminal nodes of a tree, in order.
pub fn terminals(n: &Node, out: &mut Vec<(Option<String>, TerminalProps)>) {
    if let Node::Terminal { id, props } = n {
        out.push((id.clone(), props.clone()));
    }
    for c in n.children() {
        terminals(c, out);
    }
}

/// What a program is started with: the bridge's program for `abe`, the bridge's environment and
/// the node's on the app's, and the terminal's own `TERM`.
pub struct Launch {
    pub abe: PathBuf,
    pub env: Vec<(String, String)>,
}

impl Terms {
    /// New trees (every slot's: one PTY per key whichever slot holds it): their terminals
    /// started or kept (their keys, id and slot updated), the others unheld from now, those
    /// unheld longer than [`KEEP`] dropped.
    pub fn sync(
        &mut self,
        trees: &[(Slot, &Node)],
        launch: &Launch,
        tx: &UnboundedSender<PtyEvent>,
        host: WeakEntity<FactoryView>,
        cx: &mut App,
    ) {
        let mut found = Vec::new();
        for (slot, tree) in trees {
            let mut here = Vec::new();
            terminals(tree, &mut here);
            found.extend(here.into_iter().map(|(node, props)| (*slot, node, props)));
        }
        let now = Instant::now();
        for held in self.held.values_mut() {
            held.unheld.get_or_insert(now);
        }
        for (slot, node, props) in found {
            if let Some(held) = self.held.get_mut(&props.key) {
                held.unheld = None;
                held.view.update(cx, |t, _| {
                    t.screen_keys = props.screen_keys.clone();
                    t.node = node.clone();
                    t.links = compiled(&props.links);
                    t.slot = slot;
                });
                continue;
            }
            self.next += 1;
            let id = self.next;
            let spec = spawn_spec(&props, launch);
            match Pty::spawn(id, spec, tx.clone()) {
                Ok(pty) => {
                    let key = props.key.clone();
                    let view = cx.new(|cx| TermView {
                        key: key.clone(),
                        pty: Arc::new(pty),
                        focus: cx.focus_handle(),
                        shared: Rc::default(),
                        preedit: None,
                        metrics: None,
                        node,
                        screen_keys: props.screen_keys.clone(),
                        links: compiled(&props.links),
                        host: host.clone(),
                        slot,
                    });
                    self.ids.insert(id, key.clone());
                    self.held.insert(key, Held { view, unheld: None });
                }
                Err(e) => super::protocol::log_once(
                    &format!("terminal:{}", props.key),
                    &format!("can't start {:?}: {e}", props.argv),
                ),
            }
        }
        self.sweep(cx);
    }

    /// Drops the terminals no tree has held for [`KEEP`].
    pub fn sweep(&mut self, cx: &App) {
        let keep = self.keep.unwrap_or(KEEP);
        let gone: Vec<String> = self
            .held
            .iter()
            .filter(|(_, h)| h.unheld.is_some_and(|t| t.elapsed() >= keep))
            .map(|(k, _)| k.clone())
            .collect();
        for key in gone {
            self.drop_key(&key, cx);
        }
    }

    /// `drop-terminal`: gone now, its program hung up (now: a frame drawn earlier may still hold
    /// its PTY a while).
    pub fn drop_key(&mut self, key: &str, cx: &App) {
        if let Some(h) = self.held.remove(key) {
            h.view.read(cx).pty.hang_up();
        }
        self.ids.retain(|_, k| k != key);
    }

    pub fn get(&self, key: &str) -> Option<&Entity<TermView>> {
        self.held.get(key).map(|h| &h.view)
    }

    /// The key of a PTY's id (its events).
    pub fn key_of(&self, id: u64) -> Option<&str> {
        self.ids.get(&id).map(String::as_str)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.held.keys().map(String::as_str)
    }

    pub fn views(&self) -> impl Iterator<Item = &Entity<TermView>> {
        self.held.values().map(|h| &h.view)
    }

    /// The exit code of the PTY with this id, once it exited (None: a signal).
    pub fn exit_code(&self, id: u64, cx: &App) -> Option<i32> {
        let view = self.get(self.key_of(id)?)?;
        view.read(cx).pty.exit_code().filter(|c| *c >= 0)
    }
}

fn spawn_spec(p: &TerminalProps, launch: &Launch) -> Spawn {
    let mut env: HashMap<String, String> = launch.env.iter().cloned().collect();
    env.extend(p.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    let (first, rest) = p
        .argv
        .split_first()
        .map_or(("", &[][..]), |(f, r)| (f.as_str(), r));
    let program = if first == "abe" {
        launch.abe.to_string_lossy().into_owned()
    } else {
        first.to_owned()
    };
    let cwd = p
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(dirs_home)
        .unwrap_or_else(|| PathBuf::from("/"));
    Spawn {
        program,
        args: rest.to_vec(),
        cwd,
        env,
        cols: 80,
        rows: 24,
        cell_width: 8,
        cell_height: 18,
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
