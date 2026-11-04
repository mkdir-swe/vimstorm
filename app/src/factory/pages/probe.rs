//! `vimstorm --browser-probe --url <url> [--mode sheet|app|open] [--eval <js>] [--click] [--esc]
//! [--forget] [--timeout <ms>]`: one real page ([`NativePage`], the shell's own) in an invisible
//! window, for the cargo tests and the evidence. Prints one JSON line per thing seen: `{"event": …}`
//! (each [`BrowserEvent`]), `{"eval": "<text>"}` (once loaded, `js` run until it answers a
//! non-empty string), `{"click": …}` / `{"esc": …}` (a click posted in the page, then Esc posted to
//! the window: who has the keyboard after each), then `{"done": true}`; exit 0, or 2 on its time.
//! `--forget` opens no page: it deletes the on-disk store an `open` page of `url` uses
//! (`{"forgot": …}`; WebKit holds a store its own process used until that process ends, so this is
//! a probe of its own).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use objc2::{MainThreadMarker, MainThreadOnly as _};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent,
    NSEventModifierFlags, NSEventType, NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString};

use super::native::NativePage;
use super::{BrowserEvent, Mode, Page};

const W: f64 = 800.;
const H: f64 = 600.;

struct Args {
    url: String,
    mode: Mode,
    eval: Option<String>,
    click: bool,
    esc: bool,
    /// Where to write a PNG of the page once it loaded (and answered `eval`).
    snapshot: Option<String>,
    /// No page: the on-disk store an `open` page of the URL uses deleted.
    forget: bool,
    timeout: Duration,
}

fn args(raw: &[String]) -> Result<Args, String> {
    let mut a = Args {
        url: String::new(),
        mode: Mode::Sheet,
        eval: None,
        click: false,
        esc: false,
        snapshot: None,
        forget: false,
        timeout: Duration::from_secs(20),
    };
    let mut it = raw.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--url" => a.url = value()?,
            "--mode" => {
                a.mode = match value()?.as_str() {
                    "sheet" => Mode::Sheet,
                    "app" => Mode::App,
                    "open" => Mode::Open,
                    m => return Err(format!("no mode {m}")),
                }
            }
            "--eval" => a.eval = Some(value()?),
            "--click" => a.click = true,
            "--esc" => a.esc = true,
            "--forget" => a.forget = true,
            "--snapshot" => a.snapshot = Some(value()?),
            "--timeout" => {
                let ms: u64 = value()?
                    .parse()
                    .map_err(|_| "--timeout takes ms".to_owned())?;
                a.timeout = Duration::from_millis(ms);
            }
            other => return Err(format!("unknown {other}")),
        }
    }
    if a.url.is_empty() {
        return Err("--url is needed".into());
    }
    Ok(a)
}

fn say(v: serde_json::Value) {
    println!("{v}");
}

/// What the probe waits for next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    Load,
    Eval,
    Click,
    Esc,
    Done,
}

pub fn run(raw: &[String]) -> i32 {
    let a = match args(raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("browser-probe: {e}");
            return 2;
        }
    };
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("browser-probe: not on the main thread");
        return 2;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    app.finishLaunching();
    if a.forget {
        let page = Page {
            key: "probe".into(),
            url: a.url.clone(),
            mode: a.mode,
            reload: 0,
        };
        forget(&app, &page, mtm);
        say(serde_json::json!({ "done": true }));
        return 0;
    }
    // SAFETY: AppKit's constructor, on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(W, H)),
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the window is ours and stays alive to the end of `run`.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setAlphaValue(0.);
    window.orderFrontRegardless();
    let Some(content) = window.contentView() else {
        eprintln!("browser-probe: the window has no view");
        return 2;
    };
    let seen: Rc<RefCell<Vec<BrowserEvent>>> = Rc::default();
    let sink = {
        let seen = seen.clone();
        Rc::new(move |ev: BrowserEvent| {
            say(serde_json::json!({ "event": ev }));
            seen.borrow_mut().push(ev);
        })
    };
    let page = Page {
        key: "probe".into(),
        url: a.url.clone(),
        mode: a.mode,
        reload: 0,
    };
    let mut native = NativePage::open(&content, &page, sink, mtm);
    native.place(0., 0., W, H);
    let answer: Rc<RefCell<Option<String>>> = Rc::default();
    let mut asked = Instant::now() - Duration::from_secs(1);
    let after_eval = if a.click {
        Step::Click
    } else if a.esc {
        Step::Esc
    } else {
        Step::Done
    };
    let mut step = Step::Load;
    // the current step's action (a click, an Esc) was posted
    let mut posted = false;
    let mut seen_at = 0;
    let started = Instant::now();
    while step != Step::Done {
        if started.elapsed() > a.timeout {
            say(serde_json::json!({ "timeout": format!("{step:?}") }));
            return 2;
        }
        pump(&app);
        let events: Vec<BrowserEvent> = seen.borrow()[seen_at..].to_vec();
        seen_at += events.len();
        let next = match step {
            Step::Load => {
                if events
                    .iter()
                    .any(|e| matches!(e, BrowserEvent::Failed { .. }))
                {
                    say(serde_json::json!({ "done": true }));
                    return 1;
                }
                let loaded = events
                    .iter()
                    .any(|e| matches!(e, BrowserEvent::Loaded { .. }));
                match (loaded, a.eval.is_some()) {
                    (false, _) => step,
                    (true, true) => Step::Eval,
                    (true, false) => after_eval,
                }
            }
            Step::Eval => {
                let text = answer.borrow_mut().take().filter(|t| !t.is_empty());
                match text {
                    Some(text) => {
                        say(serde_json::json!({ "eval": text }));
                        after_eval
                    }
                    None => {
                        if asked.elapsed() > Duration::from_millis(200) {
                            asked = Instant::now();
                            let answer = answer.clone();
                            native.evaluate(a.eval.as_deref().unwrap_or(""), move |t| {
                                *answer.borrow_mut() = t;
                            });
                        }
                        step
                    }
                }
            }
            Step::Click => {
                if !posted {
                    post_click(&app, &window);
                    posted = true;
                }
                if events.contains(&BrowserEvent::Focus { focused: true }) {
                    say(serde_json::json!({ "click": {
                        "focused": native.focused(),
                        "responder": responder(&window, &native),
                    } }));
                    if a.esc { Step::Esc } else { Step::Done }
                } else {
                    step
                }
            }
            Step::Esc => {
                if !posted {
                    if !native.focused() {
                        native.focus(true);
                    }
                    post_esc(&app, &window);
                    posted = true;
                }
                if events.contains(&BrowserEvent::Focus { focused: false }) {
                    say(serde_json::json!({ "esc": {
                        "focused": native.focused(),
                        "responder": responder(&window, &native),
                    } }));
                    Step::Done
                } else {
                    step
                }
            }
            Step::Done => step,
        };
        if next != step {
            step = next;
            posted = false;
        }
    }
    if let Some(path) = &a.snapshot {
        let png: Rc<RefCell<Option<Option<Vec<u8>>>>> = Rc::default();
        let got = png.clone();
        super::native::snapshot_png(native.view(), move |p| *got.borrow_mut() = Some(p));
        while png.borrow().is_none() {
            if started.elapsed() > a.timeout {
                say(serde_json::json!({ "timeout": "Snapshot" }));
                return 2;
            }
            pump(&app);
        }
        let bytes = png.borrow_mut().take().flatten().unwrap_or_default();
        let wrote = !bytes.is_empty() && std::fs::write(path, &bytes).is_ok();
        say(serde_json::json!({ "snapshot": path, "bytes": bytes.len(), "wrote": wrote }));
    }
    say(serde_json::json!({ "done": true }));
    drop(native);
    window.close();
    0
}

/// The page's on-disk store deleted (a few tries, 5 s at most).
fn forget(app: &NSApplication, page: &Page, mtm: MainThreadMarker) {
    let started = Instant::now();
    loop {
        let answer: Rc<RefCell<Option<Option<String>>>> = Rc::default();
        let got = answer.clone();
        super::native::forget_store(page, mtm, move |e| *got.borrow_mut() = Some(e));
        while answer.borrow().is_none() && started.elapsed() < Duration::from_secs(5) {
            pump(app);
        }
        let error = answer.borrow_mut().take();
        match error {
            Some(Some(_)) if started.elapsed() < Duration::from_secs(5) => continue,
            Some(error) => {
                say(serde_json::json!({ "forgot": error.is_none(), "error": error }));
                return;
            }
            None => {
                say(serde_json::json!({ "forgot": false, "error": "no answer" }));
                return;
            }
        }
    }
}

/// One turn of the run loop (50 ms at most), in its own autorelease pool as `NSApp run`'s are:
/// what WebKit autoreleased goes with it (a store in use until then cannot be deleted).
fn pump(app: &NSApplication) {
    objc2::rc::autoreleasepool(|_| {
        let until = NSDate::dateWithTimeIntervalSinceNow(0.05);
        // SAFETY: the run loop's own mode constant.
        let mode = unsafe { NSDefaultRunLoopMode };
        if let Some(ev) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
            objc2_app_kit::NSEventMask::Any,
            Some(&until),
            mode,
            true,
        ) {
            app.sendEvent(&ev);
        }
    });
}

/// Who has the window's keyboard: the page, the view under it, or something else.
fn responder(window: &NSWindow, native: &NativePage) -> &'static str {
    let Some(r) = window.firstResponder() else {
        return "none";
    };
    let Some(v) = r.downcast_ref::<objc2_app_kit::NSView>() else {
        return "other";
    };
    if v.isDescendantOf(native.view()) {
        return "page";
    }
    match window.contentView() {
        Some(c) if std::ptr::eq(&*c, v) => "parent",
        _ => "other",
    }
}

fn post_click(app: &NSApplication, window: &NSWindow) {
    let at = NSPoint::new(W / 2., H / 2.);
    for kind in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
        if let Some(ev) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            0.,
            window.windowNumber(),
            None,
            0,
            1,
            1.,
        ) {
            app.postEvent_atStart(&ev, false);
        }
    }
}

fn post_esc(app: &NSApplication, window: &NSWindow) {
    let esc = NSString::from_str("\u{1b}");
    if let Some(ev) = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0., 0.),
        NSEventModifierFlags::empty(),
        0.,
        window.windowNumber(),
        None,
        &esc,
        &esc,
        false,
        53,
    ) {
        app.postEvent_atStart(&ev, false);
    }
}
