//! The WKWebView behind a BrowserView (macOS): a child view of GPUI's own NSView (the window's
//! raw handle), kept over its slot. A locked page (`sheet`, `app`) gets a non-persistent data
//! store, the content rule list [`rules::rule_list`] compiled before anything loads (no rules, no
//! load: it fails closed), a navigation delegate letting only [`rules::allows`] navigations
//! through, and the report script. An `open` page (the person's own app) gets the persistent store
//! [`rules::store_of`] names, no rule list and no script; the delegate lets any http(s) navigation
//! through. A popup (`window.open`, `target=_blank`) loads in the same page when [`rules::allows`]
//! it (no second view: a provider's redirect sign-in comes back there), else is told blocked.
//! One local event monitor for every page: Esc while a page has the keyboard gives it back to the
//! window's view (`focus` false), a click in a page takes it (`focus` true), a click elsewhere
//! gives it back.

use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{
    ClassType as _, DefinedClass as _, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    sel,
};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSResponder, NSView};
use objc2_foundation::{NSError, NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest, NSUUID};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKNavigation, WKNavigationAction,
    WKNavigationActionPolicy, WKNavigationDelegate, WKScriptMessage, WKScriptMessageHandler,
    WKUIDelegate, WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView,
    WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};

use super::rules::{self, HANDLER, Mode};
use super::{BrowserEvent, Page};

/// Where a page's events go (called on the main thread).
pub type Sink = Rc<dyn Fn(BrowserEvent)>;

/// What the delegate needs to judge a navigation and to tell.
pub struct DelegateIvars {
    mode: Cell<Mode>,
    page: RefCell<String>,
    sink: Sink,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; Delegate does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VimStormBrowserDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl WKNavigationDelegate for Delegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(
            &self,
            _web: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // SAFETY: plain getters of the action WebKit hands over, on the main thread.
            let (url, main) = unsafe {
                let request = action.request();
                let url = request.URL().and_then(|u| u.absoluteString());
                let main = action.targetFrame().is_none_or(|f| f.isMainFrame());
                (url.map(|u| u.to_string()).unwrap_or_default(), main)
            };
            let iv = self.ivars();
            if rules::allows(iv.mode.get(), &iv.page.borrow(), &url, main) {
                handler.call((WKNavigationActionPolicy::Allow,));
            } else {
                handler.call((WKNavigationActionPolicy::Cancel,));
                (iv.sink)(BrowserEvent::Blocked {
                    url,
                    what: if main { "navigation" } else { "frame" }.into(),
                });
            }
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
            // SAFETY: a getter on the main thread.
            let url = unsafe { web.URL() }
                .and_then(|u| u.absoluteString())
                .map(|u| u.to_string())
                .unwrap_or_default();
            (self.ivars().sink)(BrowserEvent::Loaded { url });
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed_early(
            &self,
            _web: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.failed(error);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed_late(
            &self,
            _web: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.failed(error);
        }
    }

    unsafe impl WKUIDelegate for Delegate {
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn popup(
            &self,
            web: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            // SAFETY: plain getters of the action WebKit hands over, on the main thread.
            let request = unsafe { action.request() };
            let url = request
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let iv = self.ivars();
            // no second view: the popup's page loads here, through the navigation rule again
            if rules::allows(iv.mode.get(), &iv.page.borrow(), &url, true) {
                // SAFETY: a load on the main thread, in the view WebKit asked for.
                unsafe { web.loadRequest(&request) };
            } else {
                (iv.sink)(BrowserEvent::Blocked {
                    url,
                    what: "popup".into(),
                });
            }
            None
        }
    }

    unsafe impl WKScriptMessageHandler for Delegate {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn message(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            // SAFETY: the message's body, on the main thread; the script posts strings.
            let body = unsafe { message.body() };
            let Ok(text) = body.downcast::<NSString>() else {
                return;
            };
            if let Some(ev) = reported(&text.to_string()) {
                (self.ivars().sink)(ev);
            }
        }
    }
);

impl Delegate {
    fn new(mtm: MainThreadMarker, page: &Page, sink: Sink) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars {
            mode: Cell::new(page.mode),
            page: RefCell::new(page.url.clone()),
            sink,
        });
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }

    fn failed(&self, error: &NSError) {
        // 102 (frame load interrupted) is our own Cancel; -999 another load took its place
        let code = error.code();
        if code == 102 || code == -999 {
            return;
        }
        (self.ivars().sink)(BrowserEvent::Failed {
            message: error.localizedDescription().to_string(),
        });
    }
}

/// A report script message as an event: `{kind: 'blocked', url, what}`.
fn reported(text: &str) -> Option<BrowserEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("kind")?.as_str()? {
        "blocked" => Some(BrowserEvent::Blocked {
            url: v.get("url")?.as_str()?.to_owned(),
            what: v.get("what")?.as_str()?.to_owned(),
        }),
        _ => None,
    }
}

/// A page the monitor watches: its view, whether it has the keyboard, where it tells.
struct Watched {
    web: Weak<WKWebView>,
    focused: Rc<Cell<bool>>,
    sink: Sink,
}

thread_local! {
    static WATCHED: RefCell<Vec<Watched>> = const { RefCell::new(Vec::new()) };
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

/// The Esc key's virtual key code.
const ESC: u16 = 53;

/// Whether `responder` is `web` or a view inside it.
fn holds(web: &WKWebView, responder: &NSResponder) -> bool {
    if std::ptr::eq(
        (web as *const WKWebView).cast::<u8>(),
        (responder as *const NSResponder).cast::<u8>(),
    ) {
        return true;
    }
    match responder.downcast_ref::<NSView>() {
        Some(view) => view.isDescendantOf(web),
        None => false,
    }
}

/// The keyboard back to the view the page sits on (GPUI's), if the page has it.
fn give_back(web: &WKWebView) -> bool {
    let Some(window) = web.window() else {
        return false;
    };
    let had = window.firstResponder().is_some_and(|r| holds(web, &r));
    if had {
        // SAFETY: a getter on the main thread.
        let parent = unsafe { web.superview() };
        window.makeFirstResponder(parent.as_deref().map(|p| p as &NSResponder));
    }
    had
}

fn on_event(event: &NSEvent) -> bool {
    let kind = event.r#type();
    WATCHED.with(|w| {
        let mut watched = w.borrow_mut();
        watched.retain(|p| p.web.load().is_some());
        let mtm = MainThreadMarker::new();
        for p in watched.iter() {
            let Some(web) = p.web.load() else { continue };
            let same_window = match (mtm.and_then(|m| event.window(m)), web.window()) {
                (Some(a), Some(b)) => std::ptr::eq(&*a, &*b),
                _ => false,
            };
            if !same_window {
                continue;
            }
            if kind == NSEventType::KeyDown && event.keyCode() == ESC {
                if give_back(&web) {
                    p.focused.set(false);
                    (p.sink)(BrowserEvent::Focus { focused: false });
                    return true;
                }
            } else if kind == NSEventType::LeftMouseDown {
                let inside = !web.isHiddenOrHasHiddenAncestor() && {
                    let at = web.convertPoint_fromView(event.locationInWindow(), None);
                    web.mouse_inRect(at, web.bounds())
                };
                if inside && !p.focused.get() {
                    p.focused.set(true);
                    (p.sink)(BrowserEvent::Focus { focused: true });
                } else if !inside && p.focused.get() {
                    give_back(&web);
                    p.focused.set(false);
                    (p.sink)(BrowserEvent::Focus { focused: false });
                }
            }
        }
        false
    })
}

fn watch(web: &WKWebView, focused: Rc<Cell<bool>>, sink: Sink) {
    WATCHED.with(|w| {
        w.borrow_mut().push(Watched {
            web: Weak::new(web),
            focused,
            sink,
        })
    });
    MONITOR.with(|m| {
        if m.borrow().is_some() {
            return;
        }
        let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit hands a live event to the monitor.
            let ev = unsafe { event.as_ref() };
            if on_event(ev) {
                std::ptr::null_mut()
            } else {
                event.as_ptr()
            }
        });
        // SAFETY: the block lives as long as the monitor (it is copied by AppKit).
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown | NSEventMask::LeftMouseDown,
                &block,
            )
        };
        *m.borrow_mut() = token;
    });
}

/// One page's WKWebView.
pub struct NativePage {
    web: Retained<WKWebView>,
    delegate: Retained<Delegate>,
    controller: Retained<WKUserContentController>,
    sink: Sink,
    focused: Rc<Cell<bool>>,
    /// Which load the rule list's compile is for: an older one's answer loads nothing.
    load: Rc<Cell<u64>>,
    frame: Option<(f64, f64, f64, f64)>,
    shown: bool,
}

impl NativePage {
    /// A page on `parent` (hidden until placed), loading `page` once its rules are in.
    pub fn open(parent: &NSView, page: &Page, sink: Sink, mtm: MainThreadMarker) -> Self {
        // SAFETY: WebKit's constructors and setters, on the main thread (`mtm`).
        let (web, delegate, controller) = unsafe {
            let config = WKWebViewConfiguration::new(mtm);
            config.setWebsiteDataStore(&data_store(page, mtm));
            let controller = config.userContentController();
            let delegate = Delegate::new(mtm, page, sink.clone());
            controller.addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*delegate),
                &NSString::from_str(HANDLER),
            );
            let web = WKWebView::initWithFrame_configuration(
                WKWebView::alloc(mtm),
                NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.)),
                &config,
            );
            web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            web.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            (web, delegate, controller)
        };
        web.setHidden(true);
        parent.addSubview(&web);
        let focused = Rc::new(Cell::new(false));
        watch(&web, focused.clone(), sink.clone());
        let mut this = NativePage {
            web,
            delegate,
            controller,
            sink,
            focused,
            load: Rc::new(Cell::new(0)),
            frame: None,
            shown: false,
        };
        this.set_page(page);
        this
    }

    /// Another URL or mode: its rules compiled, then it loads; until then nothing does.
    pub fn set_page(&mut self, page: &Page) {
        let iv = self.delegate.ivars();
        iv.mode.set(page.mode);
        *iv.page.borrow_mut() = page.url.clone();
        let n = self.load.get() + 1;
        self.load.set(n);
        if !page.mode.locked() {
            self.load_open(page);
            return;
        }
        let Some(json) = rules::rule_list(page.mode, &page.url) else {
            (self.sink)(BrowserEvent::Failed {
                message: format!("{} is no http(s) URL: nothing loads", page.url),
            });
            return;
        };
        // SAFETY: WebKit calls on the main thread (the page was opened there).
        unsafe {
            // the old rules stay until the new ones are in: the page never runs unruled
            self.web.stopLoading();
            self.controller.removeAllUserScripts();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(MainThreadMarker::from(&*self.web)),
                &NSString::from_str(&rules::report_script(page.mode, &page.url)),
                WKUserScriptInjectionTime::AtDocumentStart,
                false,
            );
            self.controller.addUserScript(&script);
        }
        let mtm = MainThreadMarker::from(&*self.web);
        // SAFETY: the shared store, on the main thread.
        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
            (self.sink)(BrowserEvent::Failed {
                message: "WebKit has no content rule list store: nothing loads".into(),
            });
            return;
        };
        let ident = NSString::from_str(&format!("vimstorm-browser-{:016x}", hash(&json)));
        let web = self.web.clone();
        let controller = self.controller.clone();
        let sink = self.sink.clone();
        let load = self.load.clone();
        let url = page.url.clone();
        let kept = (store.clone(), ident.clone());
        let done = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
            let (store, ident) = &kept;
            let forgot = RcBlock::new(|_: *mut NSError| {});
            // SAFETY: on the main thread; the list in memory stays good without its file.
            unsafe {
                store.removeContentRuleListForIdentifier_completionHandler(
                    Some(ident),
                    Some(&forgot),
                )
            };
            if load.get() != n {
                return;
            }
            // SAFETY: WebKit hands either a compiled list or an error, on the main thread.
            match unsafe { list.as_ref() } {
                Some(list) => unsafe {
                    controller.removeAllContentRuleLists();
                    controller.addContentRuleList(list);
                    let Some(u) = NSURL::URLWithString(&NSString::from_str(&url)) else {
                        sink(BrowserEvent::Failed {
                            message: format!("{url} is no URL"),
                        });
                        return;
                    };
                    web.loadRequest(&NSURLRequest::requestWithURL(&u));
                },
                None => {
                    let why = unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_default();
                    sink(BrowserEvent::Failed {
                        message: format!("the page's rules did not compile ({why}): nothing loads"),
                    });
                }
            }
        });
        // SAFETY: on the main thread; WebKit copies the blocks. The compiled list is kept in
        // memory by the controller; its copy on disk goes at once (ports change: no pile-up).
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&ident),
                Some(&NSString::from_str(&json)),
                Some(&done),
            );
        }
    }

    /// An `open` page: no rule list, no report script, its URL loaded at once (an http(s) one).
    fn load_open(&mut self, page: &Page) {
        let url = rules::origin_of(&page.url)
            .and_then(|_| NSURL::URLWithString(&NSString::from_str(&page.url)));
        let Some(u) = url else {
            (self.sink)(BrowserEvent::Failed {
                message: format!("{} is no http(s) URL: nothing loads", page.url),
            });
            return;
        };
        // SAFETY: WebKit calls on the main thread (the page was opened there).
        unsafe {
            self.web.stopLoading();
            self.controller.removeAllUserScripts();
            self.controller.removeAllContentRuleLists();
            self.web.loadRequest(&NSURLRequest::requestWithURL(&u));
        }
    }

    /// Shown over `top`/`left` `width` × `height` (points from the parent's top left).
    pub fn place(&mut self, left: f64, top: f64, width: f64, height: f64) {
        // SAFETY: a getter on the main thread.
        let Some(parent) = (unsafe { self.web.superview() }) else {
            return;
        };
        let parent_h = parent.frame().size.height;
        let y = if parent.isFlipped() {
            top
        } else {
            parent_h - top - height
        };
        let frame = (left, y, width.max(0.), height.max(0.));
        if self.frame != Some(frame) {
            self.web.setFrame(NSRect::new(
                NSPoint::new(frame.0, frame.1),
                NSSize::new(frame.2, frame.3),
            ));
            self.frame = Some(frame);
        }
        if !self.shown {
            self.web.setHidden(false);
            self.shown = true;
        }
    }

    /// Hidden (the keyboard given back first, when it had it).
    pub fn hide(&mut self) {
        if !self.shown {
            return;
        }
        if give_back(&self.web) || self.focused.get() {
            self.focused.set(false);
            (self.sink)(BrowserEvent::Focus { focused: false });
        }
        self.web.setHidden(true);
        self.shown = false;
    }

    /// The keyboard to the page (true) or back to the view it sits on.
    pub fn focus(&mut self, on: bool) {
        if on {
            // only a shown page takes the keyboard, and only if AppKit gives it
            let took = self.shown
                && self
                    .web
                    .window()
                    .is_some_and(|w| w.makeFirstResponder(Some(&self.web)));
            self.focused.set(took);
        } else {
            give_back(&self.web);
            self.focused.set(false);
        }
    }

    pub fn focused(&self) -> bool {
        self.focused.get()
    }

    /// Runs `js` in the page; its result (a string, else its JSON) to `then` (tests, the probe).
    pub fn evaluate(&self, js: &str, then: impl Fn(Option<String>) + 'static) {
        let block = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
            // SAFETY: WebKit's result object, on the main thread.
            let text = unsafe { value.as_ref() }
                .and_then(|v| v.downcast_ref::<NSString>().map(|s| s.to_string()));
            then(text);
        });
        // SAFETY: on the main thread; WebKit copies the block.
        unsafe {
            self.web
                .evaluateJavaScript_completionHandler(&NSString::from_str(js), Some(&block));
        }
    }

    /// The page's view (the probe).
    pub fn view(&self) -> &WKWebView {
        &self.web
    }
}

impl Drop for NativePage {
    fn drop(&mut self) {
        // a compile still in flight loads nothing now
        self.load.set(self.load.get() + 1);
        self.hide();
        // SAFETY: on the main thread; the handler is ours.
        unsafe {
            self.controller
                .removeScriptMessageHandlerForName(&NSString::from_str(HANDLER));
            self.web.setNavigationDelegate(None);
            self.web.stopLoading();
        }
        self.web.removeFromSuperview();
    }
}

/// The data store a page is made with: in memory for a locked page; on disk for an `open` one,
/// one per [`rules::store_of`] name (macOS 14's `dataStoreForIdentifier:`; before it, the app's
/// default store, which no locked page uses either).
fn data_store(page: &Page, mtm: MainThreadMarker) -> Retained<WKWebsiteDataStore> {
    let Some(name) = rules::store_of(page.mode, &page.url) else {
        // SAFETY: WebKit's constructor, on the main thread.
        return unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) };
    };
    let cls = WKWebsiteDataStore::class();
    // SAFETY: NSObject's class method, on a class.
    let named: bool = unsafe { msg_send![cls, respondsToSelector: sel!(dataStoreForIdentifier:)] };
    // SAFETY: WebKit's constructors, on the main thread; the id is no nil UUID (its version bits).
    unsafe {
        if named {
            WKWebsiteDataStore::dataStoreForIdentifier(&uuid(&name), mtm)
        } else {
            WKWebsiteDataStore::defaultDataStore(mtm)
        }
    }
}

/// Deletes the on-disk store `page` was made with (an `open` page's; none: nothing to do), then
/// `done` with WebKit's error, if any (the probe's `--forget`). Its views must be gone first.
pub fn forget_store(page: &Page, mtm: MainThreadMarker, done: impl Fn(Option<String>) + 'static) {
    let cls = WKWebsiteDataStore::class();
    // SAFETY: NSObject's class method, on a class.
    let can: bool = unsafe {
        msg_send![cls, respondsToSelector: sel!(removeDataStoreForIdentifier:completionHandler:)]
    };
    let Some(name) = rules::store_of(page.mode, &page.url).filter(|_| can) else {
        done(None);
        return;
    };
    // WebKit sets up its main run loop with its first object; the removal answers on it
    // SAFETY: WebKit's constructor, on the main thread.
    let _ = unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) };
    let block = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: WebKit's error (or none), on the main thread.
        done(unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()));
    });
    // SAFETY: on the main thread; WebKit copies the block.
    unsafe {
        WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(
            &uuid(&name),
            &block,
            mtm,
        );
    }
}

/// A store's NSUUID (built from its text: `from_bytes`' message encoding trips objc2's check).
fn uuid(name: &str) -> Retained<NSUUID> {
    let b = rules::store_id(name);
    let hex =
        |r: std::ops::Range<usize>| b[r].iter().map(|x| format!("{x:02x}")).collect::<String>();
    let text = format!(
        "{}-{}-{}-{}-{}",
        hex(0..4),
        hex(4..6),
        hex(6..8),
        hex(8..10),
        hex(10..16)
    );
    NSUUID::from_string(&NSString::from_str(&text)).unwrap_or_else(|| NSUUID::from_bytes(b))
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash as _, Hasher as _};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What `web` draws, as PNG bytes, to `done` (WebKit's snapshot; `None` when it has none).
pub fn snapshot_png(web: &WKWebView, done: impl FnOnce(Option<Vec<u8>>) + 'static) {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    let done = RefCell::new(Some(done));
    let block = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
        // SAFETY: WebKit's snapshot (or none), on the main thread.
        let png = unsafe { image.as_ref() }.and_then(|image| {
            let tiff = image.TIFFRepresentation()?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
            // SAFETY: an empty properties dictionary.
            let data = unsafe {
                rep.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &objc2_foundation::NSDictionary::new(),
                )
            }?;
            Some(data.to_vec())
        });
        if let Some(done) = done.borrow_mut().take() {
            done(png);
        }
    });
    // SAFETY: on the main thread; WebKit copies the block.
    unsafe { web.takeSnapshotWithConfiguration_completionHandler(None, &block) };
}

/// A page's frame in the window (points from the top left: x, y, width, height) and its PNG.
#[cfg(feature = "shots")]
pub type PageShot = ((f64, f64, f64, f64), Vec<u8>);

/// How long a page's snapshot may take (WebKit answers once it paints).
#[cfg(feature = "shots")]
const SNAPSHOT_MS: u64 = 5000;

/// Fires after `ms` (a thread's sleep: no GPUI executor here).
#[cfg(feature = "shots")]
fn after(ms: u64) -> futures::channel::oneshot::Receiver<()> {
    let (tx, rx) = futures::channel::oneshot::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        let _ = tx.send(());
    });
    rx
}

/// The pages shown now, each with its frame in the window (points, from the top left) and a PNG
/// of what it draws: for an offscreen shot (`shots`), which GPUI's render cannot see.
#[cfg(feature = "shots")]
pub async fn shown_snapshots() -> Vec<PageShot> {
    let shown: Vec<Retained<WKWebView>> = WATCHED.with(|w| {
        w.borrow()
            .iter()
            .filter_map(|p| p.web.load())
            .filter(|web| !web.isHiddenOrHasHiddenAncestor())
            .collect()
    });
    let mut out = Vec::new();
    for web in shown {
        let Some(window) = web.window() else { continue };
        // WebKit paints only a window that is on screen: the shot's, ordered in unseen (clear,
        // clicks through) a moment, and out again after (a driven app stays up)
        let unseen = !window.isVisible();
        if unseen {
            window.setAlphaValue(0.);
            window.setIgnoresMouseEvents(true);
            window.orderFrontRegardless();
            let _ = after(1500).await;
        }
        let in_window = web.convertRect_toView(web.bounds(), None);
        let content_h = window.contentView().map_or(0., |c| c.frame().size.height);
        let frame = (
            in_window.origin.x,
            content_h - in_window.origin.y - in_window.size.height,
            in_window.size.width,
            in_window.size.height,
        );
        let (tx, rx) = futures::channel::oneshot::channel::<Option<Vec<u8>>>();
        snapshot_png(&web, move |png| {
            let _ = tx.send(png);
        });
        // WebKit answers once the page paints: one that never does (gone, hung) is left out
        let png = match futures::future::select(rx, after(SNAPSHOT_MS)).await {
            futures::future::Either::Left((png, _)) => png,
            futures::future::Either::Right(_) => {
                eprintln!("[vimstorm] shot: no page snapshot in {SNAPSHOT_MS} ms");
                Ok(None)
            }
        };
        if unseen {
            window.orderOut(None);
            window.setIgnoresMouseEvents(false);
            window.setAlphaValue(1.);
        }
        if let Ok(Some(png)) = png {
            out.push((frame, png));
        }
    }
    out
}
