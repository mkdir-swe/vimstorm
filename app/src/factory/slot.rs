//! A slot's view: draws the tree the bridge sends for one slot (`chat`: the Chat column,
//! `pane`: the bottom pane's tab) filling the bounds its host gives it. The host (the workspace)
//! makes one with [`FactoryView::slot_view`] and places it; everything else is the
//! [`FactoryView`]'s, which holds the bridge, every slot's tree and the terminals (one PTY per key,
//! whichever slot's tree holds it).
//!
//! Keys: while it has the keyboard every key goes to the bridge as `input {slot}` (⌘V's text as
//! `text`), as the main view's do; a Terminal node its tree gives the keyboard (`focused`) takes
//! it, its `screenKeys` and ⌘ keys going to the bridge the same way. A click on a node is its
//! `click`. Getting or losing the keyboard is the bridge's `focus` frame; its measured size is
//! `resize {slot}`. Its focus and activation are heard in the window it is drawn in (the torn-out
//! Chat's own, not the main window's).
//!
//! Chat's composer types in this view's own [`TextArea`] (native macOS editing: selection, ⌥ / ⌘
//! moves, undo, IME, paste of any length; it grows with its text to 40 % of the column, then
//! scrolls). Its text and caret go to the bridge as numbered `draft`s (a caret moved alone too:
//! a mid-message `/word`'s menu follows it), a burst of typing told once it
//! rests ([`DRAFT_REST`]), and always before a key the screen takes from it (⏎ sends, Esc, ⌘⏎,
//! the `/` menu's ↑ ↓ Tab, ⌫ in an empty field). The screen's text comes back into it only when
//! it is the screen's own change (a send emptied it, another session's draft): a tree whose `seq`
//! is older than the last draft sent was drawn before it. A pasted or dropped image or file is
//! saved off the UI thread and goes as `attach`. Typing never waits for the bridge: before, every
//! key went there and back, the whole Chat tree drawn again, before its character showed.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{
    AnyWindowHandle, AppContext as _, ClipboardEntry, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, Styled as _,
    Subscription, Task, Window, canvas, div, prelude::FluentBuilder as _,
};

use super::composer::{ComposerProps, Part};
use super::draw::{self, Drawn, Sink};
use super::protocol::{Node, Slot, UserInput, ViewSize};
use super::{FactoryView, placeholder};
use crate::kit::{TextArea, TextAreaEvent, TextAreaStyle};

/// A burst of typing is told the screen once it rests this long.
const DRAFT_REST: Duration = Duration::from_millis(120);
/// The composer's field grows to this share of the column's height, then scrolls.
const FIELD_SHARE: f32 = 0.4;
use super::composer::COMPOSER_ID;
/// A card's own words: one line, growing to six.
const CARD_ROWS: (f32, f32) = (1., 6.);

pub struct SlotView {
    factory: Entity<FactoryView>,
    slot: Slot,
    focus: FocusHandle,
    /// The size last measured, told the bridge as it changes.
    size: Rc<Cell<Option<ViewSize>>>,
    drawn: Drawn,
    /// A composer's IME state (dead keys, compositions), kept across frames.
    ime: Rc<RefCell<crate::editor::input::Ime>>,
    _observe: Subscription,
    /// The window its focus subscriptions are bound to and them (focus-in/out, activation).
    heard_in: AnyWindowHandle,
    _window_subs: [Subscription; 4],
    /// Chat's composer field: a native text area.
    area: Entity<TextArea>,
    _area_changed: Subscription,
    /// The caret moved alone (a click, ← →): told as a draft too.
    _area_moved: Subscription,
    /// The caret last told the screen (characters).
    told_caret: Option<usize>,
    /// The last draft number sent and the bridge's start it went to (a new bridge counts anew).
    seq: u64,
    seq_start: u64,
    /// Typed and not told yet; told once it rests ([`DRAFT_REST`]) or before a key.
    dirty: bool,
    _flush: Option<Task<()>>,
    /// What the tree last said of the field: whose it is, it has the keys, its `/` menu is open.
    owner: Option<String>,
    wants_field: bool,
    field_menu: bool,
    /// Chat's live parts (its status line, its working dots), a view of their own its host
    /// draws over this one ([`Self::hosted`]).
    line: Entity<super::status::Live>,
    /// The status line's clock: the line drawn again every second while a time ticks there.
    _clock: Option<Task<()>>,
    /// The text the mouse selects in its screen ([`super::select`]).
    text: Rc<super::select::TextSel>,
    /// What it last drew of the factory ([`FactoryView::slot_stamp`]).
    stamp: super::SlotStamp,
    /// What its tree's parts keep between frames, swept after each tree (the one it swept
    /// after: generation, rev).
    memory: Rc<super::memory::Memory>,
    swept: Option<(u64, u64)>,
    /// How many times it was drawn (tests).
    renders: u64,
}

impl SlotView {
    pub fn new(
        factory: Entity<FactoryView>,
        slot: Slot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        // drawn anew only when what it draws of the factory changed (its own tree, the layer,
        // the keyboard, the terminals): another slot's tree never redraws it
        let observe = cx.observe(&factory, |v: &mut SlotView, f, cx| {
            let stamp = f.read(cx).slot_stamp(v.slot);
            if stamp != v.stamp {
                v.stamp = stamp;
                cx.notify();
            }
        });
        let area = cx.new(|cx| {
            TextArea::new(cx).borderless().style(TextAreaStyle {
                line_height: super::composer::LINE_H,
                pad_x: 0.,
                pad_y: 0.,
                ..TextAreaStyle::field()
            })
        });
        let area_changed = cx.subscribe(&area, |v, _, _: &TextAreaEvent, cx| v.typed(cx));
        let area_moved = cx.observe(&area, |v: &mut SlotView, a, cx| {
            if Some(caret_chars(a.read(cx))) != v.told_caret && !v.dirty {
                v.typed(cx);
            }
        });
        let window_subs = Self::window_subs(&focus, &area, window, cx);
        SlotView {
            factory,
            slot,
            focus,
            size: Rc::default(),
            drawn: Drawn::default(),
            ime: Rc::default(),
            _observe: observe,
            heard_in: window.window_handle(),
            _window_subs: window_subs,
            area,
            _area_changed: area_changed,
            _area_moved: area_moved,
            told_caret: Some(0),
            seq: 0,
            seq_start: 0,
            dirty: false,
            _flush: None,
            owner: None,
            wants_field: false,
            field_menu: false,
            line: cx.new(|_| super::status::Live::new()),
            _clock: None,
            text: Rc::default(),
            stamp: Default::default(),
            memory: Rc::default(),
            swept: None,
            renders: 0,
        }
    }

    /// How many parts of its tree keep something (tests: it stays flat).
    pub fn memory_len(&self) -> usize {
        self.memory.len()
    }

    /// How many times it was drawn (tests: what redraws it).
    pub fn renders(&self) -> u64 {
        self.renders
    }

    /// The composer's field (tests: type in it as AppKit would).
    pub fn field(&self) -> Entity<TextArea> {
        self.area.clone()
    }

    fn send(&self, input: UserInput, cx: &mut Context<Self>) {
        let slot = self.slot;
        self.factory
            .update(cx, |f, cx| f.send_slot_input(slot, input, cx));
    }

    /// The field changed: told once typing rests.
    fn typed(&mut self, cx: &mut Context<Self>) {
        self.dirty = true;
        self._flush = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DRAFT_REST).await;
            let _ = this.update(cx, |v, cx| v.flush(cx));
        }));
    }

    /// The field's text told the screen now, numbered, if it changed since.
    fn flush(&mut self, cx: &mut Context<Self>) {
        self._flush = None;
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let start = self.factory.read(cx).starts();
        if start != self.seq_start {
            self.seq_start = start;
            self.seq = 0;
        }
        self.seq += 1;
        let area = self.area.read(cx);
        let (text, caret) = (area.text().to_owned(), caret_chars(area));
        self.told_caret = Some(caret);
        let seq = self.seq;
        self.send(
            UserInput::Draft {
                text,
                seq,
                caret: Some(caret),
            },
            cx,
        );
    }

    /// The tree's field (a card's own words being typed, else the composer): its text into the
    /// area when it is the screen's own change (or the area just became its), its placeholder,
    /// its height's bounds; whether it wants the keys.
    fn follow_composer(&mut self, tree: &Node, window: &mut Window, cx: &mut Context<Self>) {
        let found = field_in(tree);
        let owner = found.as_ref().map(|f| f.owner.clone());
        if owner != self.owner {
            // the area is another field's now: what was typed in it is told first
            self.flush(cx);
        }
        let (wants, menu) = match found {
            Some(f) => {
                let start = self.factory.read(cx).starts();
                let switched = owner != self.owner || start != self.seq_start;
                let stale = !switched && f.seq < self.seq;
                let line = super::composer::LINE_H;
                let room = self
                    .size
                    .get()
                    .map_or(super::composer::MAX_ROWS * line, |s| s.height * FIELD_SHARE);
                let (min, max) = match f.rows {
                    Some((lo, hi)) => (lo * line, hi * line),
                    None => (
                        super::composer::MIN_ROWS * line,
                        (room / line).floor() * line,
                    ),
                };
                let adopt = switched || (!self.dirty && !stale);
                let (text, placeholder, caret) = (f.text, f.placeholder, f.caret);
                let told = self.area.update(cx, |a, cx| {
                    a.set_grow(min, max, cx);
                    a.set_placeholder(placeholder, cx);
                    if adopt && a.text() != text {
                        // the screen's own change (a skill put in its `/word`'s place): its caret too
                        let at = super::field::caret_byte(&text, caret);
                        a.set_text(text, cx);
                        a.set_cursor(at, cx);
                        return Some(caret_chars(a));
                    }
                    None
                });
                // the screen knows where it put the caret: not told back
                if told.is_some() {
                    self.told_caret = told;
                }
                if switched {
                    self.seq_start = start;
                    self.seq = f.seq;
                    self.dirty = false;
                }
                (f.wants, f.menu)
            }
            None => (false, false),
        };
        self.owner = owner;
        let area_focus = self.area.focus_handle(cx);
        let mine = self.focus.contains_focused(window, cx);
        if wants && mine && !area_focus.is_focused(window) && self.focus.is_focused(window) {
            window.focus(&area_focus, cx);
        } else if !wants && self.wants_field && area_focus.is_focused(window) {
            // the screen took the keys back (Esc, a card, the model pick)
            window.focus(&self.focus, cx);
        }
        self.wants_field = wants;
        self.field_menu = menu;
    }

    /// ⌘V on the field: files or an image on the clipboard go with the next message (an image
    /// saved to a file off the UI thread first); true when it took them.
    fn paste_files(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let mut paths: Vec<String> = Vec::new();
        let mut images = Vec::new();
        for e in item.entries() {
            match e {
                ClipboardEntry::ExternalPaths(p) => {
                    paths.extend(p.paths().iter().map(|p| p.to_string_lossy().into_owned()))
                }
                ClipboardEntry::Image(i) => images.push(i.clone()),
                ClipboardEntry::String(_) => {}
            }
        }
        if paths.is_empty() && images.is_empty() {
            return false;
        }
        // a file copied in the Finder comes with its name as text too: the file wins
        if !paths.is_empty() {
            self.send(UserInput::Attach { paths }, cx);
            return true;
        }
        let saved = cx.background_spawn(async move {
            images
                .iter()
                .filter_map(|i| save_pasted(&i.bytes, i.format.extension()))
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let paths = saved.await;
            if !paths.is_empty() {
                let _ = this.update(cx, |v, cx| v.send(UserInput::Attach { paths }, cx));
            }
        })
        .detach();
        true
    }

    /// Keys the field never takes while it has the keyboard: the screen's (⏎ sends, the `/`
    /// menu's moves, ⌫ on nothing drops the chip), told after the field's text; ⌘V of files or
    /// an image attaches them.
    fn on_capture_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.area.focus_handle(cx).is_focused(window) || self.area.read(cx).composing() {
            return;
        }
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        // ⌘C with nothing selected in the field: the text selected in a view, if any
        if key == "<D-c>"
            && self.area.read(cx).selection().is_empty()
            && super::select::copy_selection(cx)
        {
            cx.stop_propagation();
            cx.notify();
            return;
        }
        // Esc: a view's selection let go too, ⌘C copies it no more (the key still goes on)
        if key == "<Esc>" && super::select::let_go(cx) {
            window.refresh();
        }
        let take = match key.as_str() {
            "<CR>" => true,
            "<Up>" | "<Down>" | "<Tab>" | "<S-Tab>" => self.field_menu,
            "<BS>" => self.area.read(cx).is_empty(),
            "<D-v>" => {
                if self.paste_files(cx) {
                    cx.stop_propagation();
                }
                return;
            }
            _ => false,
        };
        if take {
            cx.stop_propagation();
            self.flush(cx);
            self.send(UserInput::Key { key }, cx);
        }
    }

    /// What the last render drew, its transcript's in place (tests).
    pub fn drawn(&self) -> Drawn {
        self.drawn.merged()
    }

    /// How many times its status line was drawn (tests: what its clock redraws).
    pub fn status_renders(&self, cx: &gpui_kit::App) -> u64 {
        self.line.read(cx).drawn()
    }

    /// How many transcript rows it drew, every frame's (tests: what a frame costs).
    pub fn transcript_rows(&self, cx: &gpui_kit::App) -> u64 {
        super::transcript::rows_drawn(&self.memory, cx)
    }

    /// How many times its transcript was drawn (tests: what redraws it).
    pub fn transcript_renders(&self, cx: &gpui_kit::App) -> u64 {
        super::transcript::renders(&self.memory, cx)
    }

    /// The input handler a focused composer registers each frame (tests: AppKit's calls).
    pub fn ime_handler(&self) -> crate::editor::input::ImeHandler {
        let sink = Sink {
            view: self.factory.downgrade(),
            slot: self.slot,
            focus: None,
        };
        crate::editor::input::ImeHandler::new(self.ime.clone(), super::composer::ime_sink(sink))
    }

    /// The preedit a composer draws at its caret (tests).
    pub fn preedit(&self) -> Option<String> {
        self.ime.borrow().marked_text().map(str::to_owned)
    }

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        // the field let a key through: the screen's when it is a chord or Esc / Tab (⌘⏎, ⌘2,
        // ⌃W), never a typed character (the field's IME types it)
        if self.area.focus_handle(cx).is_focused(window) {
            if !screen_key(&key) {
                return;
            }
            cx.stop_propagation();
            self.flush(cx);
            self.send(UserInput::Key { key }, cx);
            return;
        }
        // a terminal has the keyboard: what it passed on is its IME's text
        if !self.focus.is_focused(window) {
            return;
        }
        cx.stop_propagation();
        // ⌘C / ⌘A / Esc on selected text: copied, all of it, let go here
        if super::select::selection_key(&key, &self.text, cx) {
            cx.notify();
            return;
        }
        // any other key: the screen's, what was selected on it let go
        self.text.clear();
        // ⌘V: files or an image go with the next message; else the clipboard's text, as text
        // (the screen decides where it goes)
        if key == "<D-v>" && self.paste_files(cx) {
            return;
        }
        let input = match cx.read_from_clipboard().and_then(|c| c.text()) {
            Some(text) if key == "<D-v>" => UserInput::Text { text },
            _ => UserInput::Key { key },
        };
        self.send(input, cx);
    }

    /// Its focus-in / focus-out and the window's activation, heard in `window`.
    fn window_subs(
        focus: &FocusHandle,
        area: &Entity<TextArea>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> [Subscription; 4] {
        let area_focus = area.focus_handle(cx);
        [
            // a click in the field took the keyboard before the screen gave it: the screen hears
            // the click (the field active, its menu open again)
            cx.on_focus_in(&area_focus, window, |v, _, cx| {
                if !v.wants_field && v.owner.as_deref() == Some(COMPOSER_ID) {
                    v.send(
                        UserInput::Click {
                            id: COMPOSER_ID.into(),
                        },
                        cx,
                    );
                }
            }),
            cx.on_focus_in(focus, window, |v, _, cx| {
                let slot = v.slot;
                v.factory.update(cx, |f, cx| f.slot_focus(slot, true, cx));
                cx.notify();
            }),
            cx.on_focus_out(focus, window, |v, _, _, cx| {
                v.ime.borrow_mut().clear();
                let slot = v.slot;
                v.factory.update(cx, |f, cx| f.slot_focus(slot, false, cx));
                cx.notify();
            }),
            cx.observe_window_activation(window, |_, _, cx| cx.notify()),
        ]
    }

    /// Drawn in another window (the Chat column torn out or docked again): its focus heard there.
    fn hear_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.heard_in != window.window_handle() {
            self.heard_in = window.window_handle();
            self._window_subs = Self::window_subs(&self.focus, &self.area.clone(), window, cx);
        }
    }

    /// The keyboard where the tree says while this view has it: its focused terminal (the
    /// composer's field keeps it: [`Self::follow_composer`] moves it there and back).
    fn place_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.contains_focused(window, cx) {
            return;
        }
        let want = self.factory.read(cx).wanted_terminal(self.slot, cx);
        match want {
            Some(f) if !f.is_focused(window) => window.focus(&f, cx),
            Some(_) => {}
            None if self.area.focus_handle(cx).is_focused(window) => {}
            None if !self.focus.is_focused(window) => window.focus(&self.focus, cx),
            None => {}
        }
    }

    /// The status line's time ticks: the line (never this view) drawn again every second while
    /// it shows one.
    fn tick(&mut self, cx: &mut Context<Self>) {
        if !self.line.read(cx).spot().ticks() {
            self._clock = None;
        } else if self._clock.is_none() {
            let line = self.line.downgrade();
            self._clock = Some(cx.spawn(async move |_, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if line.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    /// The slot `view` as its host draws it: cached (drawn again only when it says so, never
    /// for another slot's frame), its status line a view of its own over it, so the line's clock
    /// and the working dots draw only them ([`super::status`]).
    pub fn hosted(view: &Entity<SlotView>, cx: &gpui_kit::App) -> gpui_kit::AnyElement {
        let line = view.read(cx).line.clone();
        div()
            .relative()
            .size_full()
            .child(
                gpui_kit::AnyView::from(view.clone())
                    .cached(gpui_kit::StyleRefinement::default().size_full()),
            )
            .child(line)
            .into_any_element()
    }
}

impl Focusable for SlotView {
    fn focus_handle(&self, _: &gpui_kit::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SlotView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.hear_in(window, cx);
        self.place_focus(window, cx);
        let focused =
            self.focus.contains_focused(window, cx) && crate::editor::window_active(window);
        // the bridge hears what this frame draws (no focus event comes in a shot's window)
        if (self.factory.read(cx).focused_slot() == Some(self.slot)) != focused {
            let (factory, slot) = (self.factory.clone(), self.slot);
            cx.defer(move |cx| factory.update(cx, |f, cx| f.slot_focus(slot, focused, cx)));
        }
        self.renders += 1;
        let (tree, terms) = {
            let f = self.factory.read(cx);
            self.stamp = f.slot_stamp(self.slot);
            let tree = match (f.stopped(), f.shared_tree(self.slot)) {
                (Some(why), _) => Rc::new(placeholder("abe ui bridge stopped", why)),
                (None, Some(tree)) => tree,
                (None, None) => Rc::new(placeholder(
                    "Starting abe ui bridge",
                    "Abe's screens show once it answers.",
                )),
            };
            (tree, f.term_views(cx))
        };
        if self.swept != self.stamp.tree {
            self.swept = self.stamp.tree;
            self.memory.sweep(&[&tree]);
        }
        self.follow_composer(&tree, window, cx);
        // Chat's live parts: their room in the tree, drawn by a view of their own
        let line = (self.slot == Slot::Chat).then(|| self.line.read(cx).spot());
        if let Some(spot) = &line {
            spot.clear();
        }
        let mut drawn = Drawn {
            line,
            focused,
            terms,
            sink: Some(Sink {
                view: self.factory.downgrade(),
                slot: self.slot,
                focus: Some(self.focus.clone()),
            }),
            input: Some(super::composer::Input {
                focus: self.focus.clone(),
                ime: self.ime.clone(),
                area: Some(self.area.clone()),
                owner: self.owner.clone(),
            }),
            memory: self.memory.clone(),
            tree: Some(tree.clone()),
            ..Drawn::default()
        };
        // the screen's texts take part in its selection
        let text = self.text.clone();
        text.begin();
        let content = super::select::drawing_in(&text, || draw::fill(&tree, &mut drawn, cx));
        self.drawn = drawn;
        self.tick(cx);
        let slot = self.slot;
        let measured = self.size.clone();
        let factory = self.factory.downgrade();
        let name = format!("factory-slot-{slot:?}").to_lowercase();
        let selects = !self.factory.read(cx).layer_up();
        div()
            .id(gpui_kit::SharedString::from(name.clone()))
            .debug_selector(move || name.clone())
            .key_context("FactorySlot")
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::on_capture_key))
            .on_key_down(cx.listener(Self::on_key_down))
            .when(selects, |d| super::select::region(d, &text))
            .relative()
            .size_full()
            .child(content)
            .child(super::select::settled(&text))
            // its bounds, measured each frame: the bridge lays the screen out for them
            .child(
                canvas(
                    move |bounds, _, cx| {
                        let size = ViewSize {
                            width: f32::from(bounds.size.width),
                            height: f32::from(bounds.size.height),
                        };
                        if measured.get() != Some(size) {
                            measured.set(Some(size));
                            let _ = factory.update(cx, |f, _| f.resize_slot(slot, size));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
    }
}

/// The field the slot's area types for: its node, text, last draft number taken, placeholder,
/// whether it wants the keys and has a menu open; its rows' bounds (None: the composer's).
struct Field {
    owner: String,
    text: String,
    caret: Option<usize>,
    seq: u64,
    placeholder: String,
    wants: bool,
    menu: bool,
    rows: Option<(f32, f32)>,
}

/// A card's own words being typed, else the composer's field (none while it is a dim line).
fn field_in(tree: &Node) -> Option<Field> {
    card_typing(tree).or_else(|| {
        composer_in(tree)
            .filter(|(p, _)| p.line.is_none())
            .map(|(p, menu)| Field {
                owner: COMPOSER_ID.into(),
                text: p.text.clone(),
                caret: p.caret,
                seq: p.seq,
                placeholder: p.placeholder.clone().unwrap_or_default(),
                wants: p.focused && !p.picking,
                menu,
                rows: None,
            })
    })
}

fn card_typing(n: &Node) -> Option<Field> {
    if let Node::Card { id, card, .. } = n
        && let super::cards::Card::Question(p) = card.as_ref()
        && let Some(text) = &p.typing
    {
        return Some(Field {
            owner: id.clone().unwrap_or_default(),
            text: text.clone(),
            caret: None,
            seq: p.seq,
            placeholder: String::new(),
            wants: true,
            menu: false,
            rows: Some(CARD_ROWS),
        });
    }
    n.children().iter().find_map(card_typing)
}

/// The tree's composer field and whether its `/` menu (or model pick) is open over it.
fn composer_in(n: &Node) -> Option<(&ComposerProps, bool)> {
    if let Node::Composer { part, children, .. } = n
        && let Part::Composer(p) = part.as_ref()
    {
        return Some((p, children.iter().any(|c| c.kind() == "SlashMenu")));
    }
    n.children().iter().find_map(composer_in)
}

/// The area's caret in characters, as the bridge counts them.
fn caret_chars(a: &TextArea) -> usize {
    a.text()[..a.cursor()].chars().count()
}

/// A key the field let through that is the screen's: a ⌘ or ⌃ chord, Esc, Tab; never one that
/// types (a character, ⌥ with one, Space).
fn screen_key(key: &str) -> bool {
    matches!(key, "<Esc>" | "<Tab>" | "<S-Tab>")
        || key.starts_with("<D-")
        || key.starts_with("<C-")
        || (key.starts_with("<S-D-") || key.starts_with("<M-D-") || key.starts_with("<C-D-"))
}

/// A pasted image's bytes saved where the session can read them; its path.
fn save_pasted(bytes: &[u8], ext: &str) -> Option<String> {
    let dir = std::env::temp_dir().join("vimstorm-paste");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let path: PathBuf = dir.join(format!("pasted-{stamp}.{ext}"));
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_field_lets_chords_esc_and_tab_through_never_a_typed_key() {
        for key in ["<D-CR>", "<D-2>", "<C-w>", "<Esc>", "<Tab>", "<S-D-d>"] {
            assert!(screen_key(key), "{key}");
        }
        for key in ["a", "A", "ö", "<Space>", "<M-a>", "<lt>", "<Left>"] {
            assert!(!screen_key(key), "{key}");
        }
    }
}
