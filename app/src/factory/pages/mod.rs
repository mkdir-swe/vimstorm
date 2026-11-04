//! BrowserView (DS 2.0 BrowserView, Sheet): a web page drawn by the system's WebKit in a
//! slot the component tree gives it. Rust holds no rule about what a page is for: props in
//! ([`Page`]: a key, a URL, a [`Mode`]), events out ([`BrowserEvent`]: `loaded`, `blocked`,
//! `focus`, `failed`). The Factory view's Sheet tab uses it (`sheet` mode), a prototype's
//! Preview page too (`app` mode, the prototype proxy's URL; `open` mode, the person's own app on
//! its fixed ports).
//!
//! - One page per key ([`Browsers`]): made the first time its slot is painted, kept across trees
//!   while one holds the key, dropped [`KEEP`] after the last one did; a new URL, mode or
//!   `reload` count for the same key loads in the same page (the Preview's reload), unless its
//!   data store changes ([`store_of`]): then the page is made again.
//! - It reaches nothing but its own URL (`sheet`) or origin (`app`), whatever it asks: a content
//!   rule list compiled before it loads, a navigation delegate ([`rules`]), no stored data.
//!   `open` (ADR 0041) is a browser: no rule list, any http(s) navigation, its cookies kept on
//!   disk per origin; a popup (`window.open`, `target=_blank`) loads in the same page.
//! - The page is a native view over GPUI's (DECISION: a child WKWebView on the window's own
//!   NSView, objc2 directly; no child window, no `wry`): it is drawn over everything GPUI draws,
//!   so the host hides it while anything GPUI draws should be over it (a layer up, the view
//!   hidden) and shows it where its slot is painted.
//! - Keys go to the page only while it has the keyboard: a click in it, or the host's
//!   [`Browsers::focus`]. Esc gives the keyboard back to the window's view and tells (`focus`
//!   false), as a click outside does; ⌘ keys stay the window's.
//!
//! The backend ([`Backend`]): WebKit ([`native`]) in the app; tests set [`BrowserBackend`] to
//! [`FakeBackend`], which records what the shell asked and sends the events a test makes.
//! `vimstorm --browser-probe` ([`probe`]) runs one real page headless for the cargo tests.

mod rules;

#[cfg(target_os = "macos")]
mod native;
#[cfg(target_os = "macos")]
mod probe;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{
    AnyElement, App, Bounds, Global, IntoElement as _, Pixels, Styled as _, Window, canvas,
};
use serde::{Deserialize, Serialize};

#[cfg(all(target_os = "macos", feature = "shots"))]
pub use native::{PageShot, shown_snapshots};
#[cfg(target_os = "macos")]
pub use probe::run as run_probe;
pub use rules::{Mode, allows, origin_of, rule_list, socket_origin_of, store_id, store_of};

/// How long a page no tree holds is kept (as a terminal is).
pub const KEEP: Duration = Duration::from_secs(10 * 60);

/// What a BrowserView shows: its key, URL, what it may reach, and its reload count (a change
/// loads the URL again).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub key: String,
    pub url: String,
    pub mode: Mode,
    pub reload: u64,
}

/// What a page tells, as the bridge's `browser` frame carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BrowserEvent {
    /// Its page loaded (the URL it shows).
    Loaded { url: String },
    /// It asked for something outside (a load, a navigation): refused.
    Blocked { url: String, what: String },
    /// It took the keyboard (a click in it) or gave it back (Esc, a click outside).
    Focus { focused: bool },
    /// It could not load (its rules, the server).
    Failed { message: String },
}

/// A page drawn natively.
pub trait PageView {
    /// Another URL for its key.
    fn set_page(&mut self, page: &Page);
    /// Shown over these window bounds (logical px, the window's top left).
    fn place(&mut self, bounds: Bounds<Pixels>);
    fn hide(&mut self);
    /// The keyboard to the page, or back to the window's view.
    fn focus(&mut self, on: bool);
    fn focused(&self) -> bool;
}

/// Where a page's events go (on the main thread).
pub type Sink = Rc<dyn Fn(BrowserEvent)>;

/// What makes pages.
pub trait Backend {
    /// A page for `page` in `window` (hidden until placed); `None` where there can be none.
    fn open(&self, window: &Window, page: &Page, sink: Sink) -> Option<Box<dyn PageView>>;
}

/// The backend the shell uses: WebKit, unless a test set its own.
#[derive(Clone)]
pub struct BrowserBackend(pub Rc<dyn Backend>);

impl Global for BrowserBackend {}

fn backend(cx: &App) -> Rc<dyn Backend> {
    match cx.try_global::<BrowserBackend>() {
        Some(b) => b.0.clone(),
        None => Rc::new(WebKit),
    }
}

/// The system's WebKit, in a child view of the window's own.
pub struct WebKit;

#[cfg(target_os = "macos")]
impl Backend for WebKit {
    fn open(&self, window: &Window, page: &Page, sink: Sink) -> Option<Box<dyn PageView>> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let mtm = objc2::MainThreadMarker::new()?;
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return None;
        };
        // SAFETY: GPUI's live NSView for this window, on the main thread.
        let parent: &objc2_app_kit::NSView = unsafe { h.ns_view.cast().as_ref() };
        Some(Box::new(native::NativePage::open(parent, page, sink, mtm)))
    }
}

#[cfg(not(target_os = "macos"))]
impl Backend for WebKit {
    fn open(&self, _: &Window, _: &Page, _: Sink) -> Option<Box<dyn PageView>> {
        None
    }
}

#[cfg(target_os = "macos")]
impl PageView for native::NativePage {
    fn set_page(&mut self, page: &Page) {
        native::NativePage::set_page(self, page);
    }

    fn place(&mut self, b: Bounds<Pixels>) {
        native::NativePage::place(
            self,
            f64::from(f32::from(b.origin.x)),
            f64::from(f32::from(b.origin.y)),
            f64::from(f32::from(b.size.width)),
            f64::from(f32::from(b.size.height)),
        );
    }

    fn hide(&mut self) {
        native::NativePage::hide(self);
    }

    fn focus(&mut self, on: bool) {
        native::NativePage::focus(self, on);
    }

    fn focused(&self) -> bool {
        native::NativePage::focused(self)
    }
}

/// One key's page: what it shows, its view once painted.
struct Slot {
    page: Page,
    view: Option<Box<dyn PageView>>,
    tx: UnboundedSender<(String, BrowserEvent)>,
    /// The keyboard asked for before the view was made.
    focus: bool,
}

impl Slot {
    fn paint(&mut self, bounds: Bounds<Pixels>, window: &Window, cx: &App) {
        if self.view.is_none() {
            let tx = self.tx.clone();
            let key = self.page.key.clone();
            let sink: Sink = Rc::new(move |ev| {
                let _ = tx.unbounded_send((key.clone(), ev));
            });
            self.view = backend(cx).open(window, &self.page, sink);
            if self.focus
                && let Some(v) = &mut self.view
            {
                v.place(bounds);
                v.focus(true);
                return;
            }
        }
        if let Some(v) = &mut self.view {
            v.place(bounds);
            // asked while it was hidden (a layer just closed): it takes the keyboard once shown
            if self.focus && !v.focused() {
                v.focus(true);
            }
        }
    }
}

struct Held {
    slot: Rc<RefCell<Slot>>,
    unheld: Option<Instant>,
}

/// Every page of a host, by key (see the module doc).
pub struct Browsers {
    held: HashMap<String, Held>,
    tx: UnboundedSender<(String, BrowserEvent)>,
    /// How long one no tree holds is kept ([`KEEP`]; tests shorten it).
    pub keep: Option<Duration>,
}

impl Browsers {
    /// Pages whose events go to `tx` as (key, event).
    pub fn new(tx: UnboundedSender<(String, BrowserEvent)>) -> Self {
        Browsers {
            held: HashMap::new(),
            tx,
            keep: None,
        }
    }

    /// A new tree's pages: kept (a changed URL, mode or reload loaded), new ones made once painted,
    /// the others hidden and unheld from now, those unheld longer than [`KEEP`] dropped.
    pub fn sync(&mut self, pages: &[Page]) {
        let now = Instant::now();
        for held in self.held.values_mut() {
            held.unheld.get_or_insert(now);
        }
        for page in pages {
            if let Some(held) = self.held.get_mut(&page.key) {
                held.unheld = None;
                let mut slot = held.slot.borrow_mut();
                if slot.page != *page {
                    let moved =
                        store_of(slot.page.mode, &slot.page.url) != store_of(page.mode, &page.url);
                    slot.page = page.clone();
                    if moved {
                        // a web view keeps the store it was made with: made again on the new one
                        slot.view = None;
                    } else if let Some(v) = &mut slot.view {
                        v.set_page(page);
                    }
                }
                continue;
            }
            self.held.insert(
                page.key.clone(),
                Held {
                    slot: Rc::new(RefCell::new(Slot {
                        page: page.clone(),
                        view: None,
                        tx: self.tx.clone(),
                        focus: false,
                    })),
                    unheld: None,
                },
            );
        }
        for held in self.held.values() {
            if held.unheld.is_some()
                && let Some(v) = &mut held.slot.borrow_mut().view
            {
                v.hide();
            }
        }
        self.sweep();
    }

    /// Drops the pages no tree has held for [`KEEP`].
    pub fn sweep(&mut self) {
        let keep = self.keep.unwrap_or(KEEP);
        self.held
            .retain(|_, h| h.unheld.is_none_or(|t| t.elapsed() < keep));
    }

    /// Every page hidden: nothing of them over what GPUI draws.
    pub fn hide_all(&mut self) {
        for held in self.held.values() {
            if let Some(v) = &mut held.slot.borrow_mut().view {
                v.hide();
            }
        }
    }

    /// The keyboard to `key`'s page (it takes it once it is made), or back from it.
    pub fn focus(&mut self, key: &str, on: bool) {
        if let Some(held) = self.held.get(key) {
            let mut slot = held.slot.borrow_mut();
            slot.focus = on;
            if let Some(v) = &mut slot.view
                && v.focused() != on
            {
                v.focus(on);
            }
        }
    }

    /// Whether `key`'s page has the keyboard.
    pub fn focused(&self, key: &str) -> bool {
        self.held
            .get(key)
            .is_some_and(|h| h.slot.borrow().view.as_ref().is_some_and(|v| v.focused()))
    }

    /// A page told it took or gave back the keyboard: what is asked of it follows.
    pub fn told_focus(&mut self, key: &str, on: bool) {
        if let Some(held) = self.held.get(key) {
            held.slot.borrow_mut().focus = on;
        }
    }

    /// The keys held (tests).
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.held.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Every page's slot, by key: what a drawn tree places its pages with.
    pub fn slots(&self) -> HashMap<String, PageSlot> {
        self.held
            .iter()
            .map(|(k, h)| (k.clone(), PageSlot(h.slot.clone())))
            .collect()
    }
}

/// Where one key's page goes: [`Self::element`] fills its parent and places the page there.
#[derive(Clone)]
pub struct PageSlot(Rc<RefCell<Slot>>);

impl std::fmt::Debug for PageSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PageSlot({})", self.0.borrow().page.key)
    }
}

impl PageSlot {
    /// The element the page is placed over. `shown` false: the page stays hidden (something
    /// GPUI draws is over it).
    pub fn element(&self, shown: bool) -> AnyElement {
        let slot = self.0.clone();
        canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                let mut s = slot.borrow_mut();
                if shown {
                    s.paint(bounds, window, cx);
                } else if let Some(v) = &mut s.view {
                    v.hide();
                }
            },
        )
        .size_full()
        .into_any_element()
    }
}

/// What a test's backend was asked, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum FakeCall {
    Open(Page),
    SetPage(Page),
    Place(String, Bounds<Pixels>),
    Hide(String),
    Focus(String, bool),
}

/// A backend for tests: records the calls, sends the events a test makes ([`Self::emit`]).
#[derive(Clone, Default)]
pub struct FakeBackend {
    pub calls: Rc<RefCell<Vec<FakeCall>>>,
    sinks: Rc<RefCell<HashMap<String, Sink>>>,
    focused: Rc<RefCell<HashMap<String, bool>>>,
}

impl FakeBackend {
    /// `key`'s page tells `ev` (as WebKit would, on the main thread).
    pub fn emit(&self, key: &str, ev: BrowserEvent) {
        if let BrowserEvent::Focus { focused } = &ev {
            self.focused.borrow_mut().insert(key.into(), *focused);
        }
        let sink = self.sinks.borrow().get(key).cloned();
        if let Some(sink) = sink {
            sink(ev);
        }
    }

    /// The page shown last at these bounds, or hidden since (`None`).
    pub fn placed(&self, key: &str) -> Option<Bounds<Pixels>> {
        let mut at = None;
        for c in self.calls.borrow().iter() {
            match c {
                FakeCall::Place(k, b) if k == key => at = Some(*b),
                FakeCall::Hide(k) if k == key => at = None,
                _ => {}
            }
        }
        at
    }

    pub fn has_focus(&self, key: &str) -> bool {
        self.focused.borrow().get(key).copied().unwrap_or(false)
    }
}

struct FakePage {
    key: String,
    calls: Rc<RefCell<Vec<FakeCall>>>,
    focused: Rc<RefCell<HashMap<String, bool>>>,
    shown: Option<Bounds<Pixels>>,
}

impl PageView for FakePage {
    fn set_page(&mut self, page: &Page) {
        self.calls
            .borrow_mut()
            .push(FakeCall::SetPage(page.clone()));
    }

    fn place(&mut self, bounds: Bounds<Pixels>) {
        if self.shown != Some(bounds) {
            self.shown = Some(bounds);
            self.calls
                .borrow_mut()
                .push(FakeCall::Place(self.key.clone(), bounds));
        }
    }

    fn hide(&mut self) {
        if self.shown.take().is_some() {
            self.calls
                .borrow_mut()
                .push(FakeCall::Hide(self.key.clone()));
        }
    }

    fn focus(&mut self, on: bool) {
        self.focused.borrow_mut().insert(self.key.clone(), on);
        self.calls
            .borrow_mut()
            .push(FakeCall::Focus(self.key.clone(), on));
    }

    fn focused(&self) -> bool {
        self.focused
            .borrow()
            .get(&self.key)
            .copied()
            .unwrap_or(false)
    }
}

impl Backend for FakeBackend {
    fn open(&self, _: &Window, page: &Page, sink: Sink) -> Option<Box<dyn PageView>> {
        self.calls.borrow_mut().push(FakeCall::Open(page.clone()));
        self.sinks.borrow_mut().insert(page.key.clone(), sink);
        Some(Box::new(FakePage {
            key: page.key.clone(),
            calls: self.calls.clone(),
            focused: self.focused.clone(),
            shown: None,
        }))
    }
}
