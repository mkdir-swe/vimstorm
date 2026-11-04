//! BrowserView: a Sheet's page reaches nothing but its own URL. The rules as tables; the
//! real WebKit page (`vimstorm --browser-probe`, the shell's own `NativePage`) on a test page
//! served without any CSP, whose fetch, `<img src=http…>`, WebSocket, form submit and meta refresh
//! all fail while a second local server counts what reached it (nothing); a click gives the page
//! the keyboard and Esc gives it back. In the Factory view (a test backend): the BrowserView
//! drawn from the contract's tree, one page per key kept across trees, hidden under a layer and
//! when unheld, the tree's focus applied, the page's events to the bridge; a terminal's
//! `Show <title>` row is a link (⌘-click).
#![cfg(debug_assertions)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui_kit::{Modifiers, MouseButton, MouseUpEvent};
use serde_json::{Value, json};
use vimstorm::factory::FIRST_SCREEN;
use vimstorm::factory::pages::{BrowserBackend, BrowserEvent, FakeBackend, FakeCall, Page};
use vimstorm::factory::pages::{
    Mode, allows, origin_of, rule_list, socket_origin_of, store_id, store_of,
};

use crate::common::bridge::{Win, fake, fixture, log};

#[test]
fn a_sheet_may_reach_only_its_own_url_an_app_its_origin_and_an_open_page_any_http() {
    let page = "http://127.0.0.1:5123/s/9f2c";
    for (target, main, sheet, app, open) in [
        (page, true, true, true, true),
        (
            "http://127.0.0.1:5123/s/9f2c#totals",
            true,
            true,
            true,
            true,
        ),
        ("http://127.0.0.1:5123/s/other", true, false, true, true),
        ("http://127.0.0.1:5123/", true, false, true, true),
        ("http://127.0.0.1:5124/s/9f2c", true, false, false, true),
        ("https://127.0.0.1:5123/s/9f2c", true, false, false, true),
        ("http://evil.test/", true, false, false, true),
        // the person's own app: its backend on another port, its sign-in provider and back
        (
            "http://localhost:8888/api/orders",
            false,
            false,
            false,
            true,
        ),
        (
            "https://tenant.auth.test/authorize?redirect_uri=x",
            true,
            false,
            false,
            true,
        ),
        (
            "http://localhost:4000/callback?code=c",
            true,
            false,
            false,
            true,
        ),
        ("data:text/html,hi", true, false, false, false),
        ("data:text/html,hi", false, false, false, true),
        ("blob:http://127.0.0.1:5123/1f", false, false, false, true),
        ("file:///etc/passwd", true, false, false, false),
        ("mailto:a@b.test", true, false, false, false),
        ("about:blank", true, false, false, false),
        ("about:blank", false, true, true, true),
        ("about:srcdoc", false, true, true, true),
    ] {
        assert_eq!(
            allows(Mode::Sheet, page, target, main),
            sheet,
            "sheet → {target}"
        );
        assert_eq!(allows(Mode::App, page, target, main), app, "app → {target}");
        assert_eq!(
            allows(Mode::Open, page, target, main),
            open,
            "open → {target}"
        );
    }
    // an open page runs under no rule list; its store is on disk per origin, a locked one's none
    assert_eq!(rule_list(Mode::Open, page), None);
    assert!(Mode::Sheet.locked() && Mode::App.locked() && !Mode::Open.locked());
    for (mode, page, store) in [
        (Mode::Sheet, "http://localhost:4000/", None),
        (Mode::App, "http://localhost:4000/", None),
        (
            Mode::Open,
            "http://localhost:4000/",
            Some("vimstorm-open:http://localhost:4000"),
        ),
        (
            Mode::Open,
            "http://LOCALHOST:4000/cart?x",
            Some("vimstorm-open:http://localhost:4000"),
        ),
        (
            Mode::Open,
            "http://localhost:4001/",
            Some("vimstorm-open:http://localhost:4001"),
        ),
        (Mode::Open, "file:///tmp/x.html", None),
    ] {
        assert_eq!(store_of(mode, page).as_deref(), store, "{mode:?} {page}");
    }
    // the same name the same id in every build (a stable hash), a version 8 UUID
    let hex = |id: [u8; 16]| id.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let id = store_id("vimstorm-open:http://localhost:4000");
    assert_eq!(hex(id), "e4901d798cca88b087ab99d7c46f0769");
    assert_ne!(id, store_id("vimstorm-open:http://localhost:4001"));
    assert_eq!((id[6] >> 4, id[8] >> 6), (8, 2));
    assert_eq!(
        origin_of("HTTP://127.0.0.1:5123/x?y#z").as_deref(),
        Some("http://127.0.0.1:5123")
    );
    assert_eq!(origin_of("http://user@evil.test/"), None);
    assert_eq!(origin_of("file:///etc/passwd"), None);

    let rules: Value = serde_json::from_str(&rule_list(Mode::Sheet, page).unwrap()).unwrap();
    let filters: Vec<(&str, &str)> = rules
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["trigger"]["url-filter"].as_str().unwrap(),
                r["action"]["type"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        filters,
        [
            (".*", "block"),
            (
                r"^http://127\.0\.0\.1:5123/s/9f2c(#.*)?$",
                "ignore-previous-rules"
            ),
            ("^data:", "ignore-previous-rules"),
            ("^blob:", "ignore-previous-rules"),
            ("^about:", "ignore-previous-rules"),
        ]
    );
    // an app: its origin, and its own server's WebSockets (a dev server's live reload) there
    for (page, origin, socket) in [
        (
            page,
            r"^http://127\.0\.0\.1:5123/",
            r"^ws://127\.0\.0\.1:5123/",
        ),
        (
            "http://127.0.0.1:60202",
            r"^http://127\.0\.0\.1:60202/",
            r"^ws://127\.0\.0\.1:60202/",
        ),
        (
            "https://app.test/x",
            r"^https://app\.test/",
            r"^wss://app\.test/",
        ),
    ] {
        let app: Value = serde_json::from_str(&rule_list(Mode::App, page).unwrap()).unwrap();
        let own: Vec<&str> = app.as_array().unwrap()[1..3]
            .iter()
            .map(|r| r["trigger"]["url-filter"].as_str().unwrap())
            .collect();
        assert_eq!(own, [origin, socket], "app {page}");
    }
    for (page, socket) in [
        ("http://127.0.0.1:60202/", Some("ws://127.0.0.1:60202")),
        ("HTTPS://App.test:8443/x?y", Some("wss://app.test:8443")),
        ("file:///etc/passwd", None),
    ] {
        assert_eq!(socket_origin_of(page).as_deref(), socket, "{page}");
    }
    // no http(s) page: no rules, so nothing loads
    assert_eq!(rule_list(Mode::Sheet, "file:///tmp/x.html"), None);
}

/// A local server answering every request with `body` (HTML, or a 404), counting them.
fn server(
    body: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
) -> (u16, Arc<Mutex<Vec<String>>>) {
    raw_server(move |path, _| match body(path) {
        Some(b) => format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
            b.len()
        ),
        None => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
    })
}

/// A local server answering every request (its path, its headers lower-cased) with `reply`'s whole
/// HTTP answer, counting them.
fn raw_server(
    reply: impl Fn(&str, &str) -> String + Send + Sync + 'static,
) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let seen = hits.clone();
    let reply = Arc::new(reply);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let seen = seen.clone();
            seen.lock().unwrap().push("conn".into());
            let reply = reply.clone();
            std::thread::spawn(move || answer(stream, &seen, &*reply));
        }
    });
    (port, hits)
}

fn answer(mut stream: TcpStream, seen: &Mutex<Vec<String>>, reply: &dyn Fn(&str, &str) -> String) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    // a connection opened ahead and closed unused (WebKit preconnects) asked nothing
    if reader.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    let mut length = 0;
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        let line = line.to_ascii_lowercase();
        if let Some(v) = line.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap_or(0);
        }
        headers.push_str(&line);
    }
    let mut rest = vec![0; length];
    let _ = reader.read_exact(&mut rest);
    let path = first.split(' ').nth(1).unwrap_or("").to_owned();
    seen.lock()
        .unwrap()
        .push(format!("{} {path}", first.split(' ').next().unwrap_or("")));
    let _ = stream.write_all(reply(&path, &headers).as_bytes());
}

/// The test Sheet: every way out it tries, its outcomes in `result()` once all are in.
fn sheet_page(outside: u16) -> String {
    let o = format!("http://127.0.0.1:{outside}");
    format!(
        r#"<!doctype html><html><head><title>t</title>
<meta http-equiv="refresh" content="0.3;url={o}/refresh">
<link rel="preconnect" href="{o}"><link rel="dns-prefetch" href="{o}"><link rel="prefetch" href="{o}/prefetch"></head><body>
<h1>Cart totals</h1>
<img id="img" src="{o}/img.png">
<form id="f" action="{o}/form" method="post"><input name="a" value="b"></form>
<script>
const r = {{}};
const img = document.getElementById('img');
img.onload = () => r.img = 'loaded'; img.onerror = () => r.img = 'failed';
if (img.complete && img.naturalWidth === 0) r.img = 'failed';
fetch("{o}/fetch").then(() => r.fetch = 'answered', () => r.fetch = 'failed');
try {{
  const ws = new WebSocket("ws://127.0.0.1:{outside}/ws");
  ws.onopen = () => r.ws = 'open'; ws.onerror = () => r.ws = 'failed';
}} catch (e) {{ r.ws = 'failed'; }}
r.rtc = typeof RTCPeerConnection === 'undefined' ? 'none' : 'there';
setTimeout(() => {{ r.form = 'submitted'; document.getElementById('f').submit(); }}, 1200);
setTimeout(() => {{ r.later = 'still here'; }}, 2200);
window.result = () => (r.img && r.fetch && r.ws && r.form && r.later) ? JSON.stringify(r) : '';
</script></body></html>"#
    )
}

fn probe(args: &[&str]) -> Vec<Value> {
    probe_exiting(args, 0)
}

/// The probe's lines, its exit code `code`.
fn probe_exiting(args: &[&str], code: i32) -> Vec<Value> {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_vimstorm"))
        .arg("--browser-probe")
        .args(args)
        .env("VIMSTORM_NO_INSTANCE", "1")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.code() == Some(code),
        "the probe exited otherwise ({:?}):\n{text}\n{}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    text.lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
        .collect()
}

#[test]
fn a_sheet_reaches_nothing_but_its_own_url_and_esc_gives_the_keyboard_back() {
    let (outside, reached) = server(|_| Some("leaked".into()));
    let page = sheet_page(outside);
    let (inside, served) = server(move |path| (path == "/s/9f2c").then(|| page.clone()));
    let url = format!("http://127.0.0.1:{inside}/s/9f2c");
    let lines = probe(&[
        "--url",
        &url,
        "--mode",
        "sheet",
        "--eval",
        "window.result ? window.result() : ''",
        "--click",
        "--esc",
    ]);
    let eval: Value = lines
        .iter()
        .find_map(|l| l["eval"].as_str())
        .map(|t| serde_json::from_str(t).unwrap())
        .expect("the page's results");
    assert_eq!(
        eval,
        json!({"img": "failed", "fetch": "failed", "ws": "failed", "rtc": "none", "form": "submitted", "later": "still here"}),
        "every way out failed, and the page was never navigated away"
    );
    let events: Vec<&Value> = lines.iter().filter_map(|l| l.get("event")).collect();
    assert!(
        events.contains(&&json!({"kind": "loaded", "url": url})),
        "{events:?}"
    );
    for (what, path) in [
        ("navigation", "/form"),
        ("navigation", "/refresh"),
        ("fetch", "/fetch"),
        ("websocket", "/ws"),
    ] {
        assert!(
            events.iter().any(|e| e["kind"] == "blocked"
                && e["what"] == what
                && e["url"].as_str().is_some_and(|u| u.ends_with(path))),
            "{what} {path} told as blocked: {events:?}"
        );
    }
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        *reached.lock().unwrap(),
        Vec::<String>::new(),
        "nothing reached the outside, not even a connection (preconnect, prefetch)"
    );
    let asked: Vec<String> = served
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.as_str() != "conn")
        .cloned()
        .collect();
    assert_eq!(asked, ["GET /s/9f2c"], "the page asked only for itself");
    // a click in the page gives it the keyboard; Esc gives it back to the view it sits on
    let at = |k: &str| lines.iter().find_map(|l| l.get(k)).cloned();
    assert_eq!(
        at("click"),
        Some(json!({"focused": true, "responder": "page"}))
    );
    assert_eq!(
        at("esc"),
        Some(json!({"focused": false, "responder": "parent"}))
    );
}

#[test]
fn a_page_whose_rules_cannot_be_made_loads_nothing() {
    let lines = probe_exiting(&["--url", "file:///etc/hosts", "--timeout", "10000"], 1);
    assert!(
        lines.iter().any(|l| l["event"]["kind"] == "failed"),
        "{lines:?}"
    );
    assert!(!lines.iter().any(|l| l["event"]["kind"] == "loaded"));
}

/// The person's own app (`open`): signed out, its page sends the browser to a provider on another
/// origin, which sends it back to `localhost` (as given) with a code; the callback sets the
/// session's cookie; the signed-in page fetches its backend on a third port. A second probe (the
/// Preview closed and opened again) is still signed in, and its popup loads in the same page.
#[test]
fn an_open_page_signs_in_through_another_origin_reaches_its_backend_and_stays_signed_in() {
    let ok = |headers: &str, body: &str| {
        format!(
            "HTTP/1.1 200 OK\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    };
    let to = |location: &str, more: &str| {
        format!(
            "HTTP/1.1 302 Found\r\nlocation: {location}\r\n{more}content-length: 0\r\nconnection: close\r\n\r\n"
        )
    };
    let (backend, fetched) = raw_server(move |_, _| {
        ok(
            "content-type: application/json\r\naccess-control-allow-origin: *\r\n",
            r#"{"orders": 3}"#,
        )
    });
    let (provider, asked) = raw_server(move |path, _| {
        let back = path.split("redirect_uri=").nth(1).unwrap_or("");
        to(&format!("{back}?code=c0de"), "")
    });
    let app_port = Arc::new(Mutex::new(0u16));
    let port = app_port.clone();
    let (app, _) = raw_server(move |path, headers| {
        let me = format!("http://localhost:{}", port.lock().unwrap());
        let signed_in = headers.contains("cookie: sid=demo-shop");
        match path {
            p if p.starts_with("/callback?code=c0de") => {
                to("/", "set-cookie: sid=demo-shop; Path=/; Max-Age=600\r\n")
            }
            "/" if !signed_in => to(
                &format!("http://127.0.0.1:{provider}/authorize?redirect_uri={me}/callback"),
                "",
            ),
            "/" => ok(
                "content-type: text/html\r\n",
                &format!(
                    r#"<!doctype html><title>Orders</title><h1 id="h">Orders</h1><script>
window.r = {{}};
fetch("http://127.0.0.1:{backend}/api/orders").then(a => a.json()).then(j => {{ r.orders = j.orders; document.getElementById('h').textContent = 'Orders: ' + j.orders; }}, () => r.orders = 'failed');
window.result = () => r.orders === undefined ? '' : JSON.stringify({{ orders: r.orders, at: location.href }});
</script>"#
                ),
            ),
            "/opener" => ok(
                "content-type: text/html\r\n",
                "<!doctype html><title>Opener</title>",
            ),
            _ => "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
        }
    });
    *app_port.lock().unwrap() = app;
    let home = format!("http://localhost:{app}/");
    let eval = |lines: &[Value]| -> Value {
        lines
            .iter()
            .find_map(|l| l["eval"].as_str())
            .map(|t| serde_json::from_str(t).unwrap())
            .unwrap_or_else(|| panic!("the page's results: {lines:?}"))
    };
    let lines = probe(&[
        "--url",
        &home,
        "--mode",
        "open",
        "--eval",
        "window.result ? window.result() : ''",
    ]);
    assert_eq!(eval(&lines), json!({"orders": 3, "at": home}), "{lines:?}");
    assert!(
        !lines.iter().any(|l| l["event"]["kind"] == "blocked"),
        "nothing blocked: {lines:?}"
    );
    let count = |hits: &Mutex<Vec<String>>, what: &str| {
        hits.lock()
            .unwrap()
            .iter()
            .filter(|l| l.starts_with(what))
            .count()
    };
    assert_eq!(
        count(&asked, "GET /authorize"),
        1,
        "signed in at the provider"
    );
    assert_eq!(
        count(&fetched, "GET /api/orders"),
        1,
        "the backend answered"
    );
    // opened again: its cookie kept on disk, so no sign-in; `window.open` loads in this page
    let lines = probe(&[
        "--url",
        &format!("http://localhost:{app}/opener"),
        "--mode",
        "open",
        "--eval",
        "window.result ? window.result() : (window.opened || (window.opened = window.open('/', '_blank') || 1), '')",
    ]);
    assert_eq!(eval(&lines), json!({"orders": 3, "at": home}), "{lines:?}");
    assert_eq!(count(&asked, "GET /authorize"), 1, "still signed in");
    let lines = probe(&["--url", &home, "--mode", "open", "--forget"]);
    assert!(
        lines.iter().any(|l| l["forgot"] == true),
        "its store deleted: {lines:?}"
    );
}

// ------------------------------------------------------------------ the Factory view's half

pub(crate) fn with_backend(w: &mut Win) -> FakeBackend {
    let fake = FakeBackend::default();
    let b = fake.clone();
    w.cx.update(|_, cx| cx.set_global(BrowserBackend(std::rc::Rc::new(b))));
    fake
}

const KEY: &str = "sheet:cart-totals-by-market-a1b2c3:yours:v1";

fn sheet_tree() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture("trees/factory-sheet.json")).unwrap())
        .unwrap()
}

pub(crate) fn send_tree(w: &mut Win, tree: &Value, rev: u64) {
    let line = json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev, "tree": tree})
        .to_string();
    w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
    w.cx.run_until_parked();
}

#[test]
fn the_sheet_tab_draws_its_bar_and_places_one_page_per_key() {
    let mut w = Win::open(None);
    let fake = with_backend(&mut w);
    w.tree("trees/factory-sheet.json", 1);
    assert_eq!(w.drawn("BrowserView"), [KEY]);
    assert_eq!(w.drawn("BrowserBar").len(), 1, "one bar over the page");
    let opened = fake.calls.borrow().clone();
    assert_eq!(
        opened[0],
        FakeCall::Open(Page {
            key: KEY.into(),
            url: "http://127.0.0.1:50123/s/9f2c4e1a".into(),
            mode: Mode::Sheet,
            reload: 0,
        })
    );
    // over its slot: under the bar, inside the view
    let placed = fake.placed(KEY).expect("placed");
    let view = w.bounds("factory-node-sheet-view");
    assert!(
        placed.origin.y > view.origin.y,
        "{placed:?} under the bar of {view:?}"
    );
    assert!(view.contains(&placed.center()));
    // the same key in a newer tree: the same page
    w.tree("trees/factory-sheet.json", 2);
    let opens = |f: &FakeBackend| {
        f.calls
            .borrow()
            .iter()
            .filter(|c| matches!(c, FakeCall::Open(_)))
            .count()
    };
    assert_eq!(opens(&fake), 1);
    // a layer up: hidden (a native page is drawn over what GPUI draws), back once it closes
    let layer = std::fs::read_to_string(fixture("trees/command-menu.json")).unwrap();
    let up = json!({"v": 2, "type": "layer", "rev": 3, "tree": serde_json::from_str::<Value>(&layer).unwrap()});
    w.view
        .update(&mut w.cx, |v, cx| v.receive_line(&up.to_string(), cx));
    w.cx.run_until_parked();
    assert_eq!(fake.placed(KEY), None, "hidden under the layer");
    let down = json!({"v": 2, "type": "layer", "rev": 4, "tree": null});
    w.view
        .update(&mut w.cx, |v, cx| v.receive_line(&down.to_string(), cx));
    w.cx.run_until_parked();
    assert!(fake.placed(KEY).is_some(), "shown again");
    // a balloon, popup or picker of the host over the view: hidden meanwhile
    w.view.update(&mut w.cx, |v, cx| v.set_covered(true, cx));
    w.cx.run_until_parked();
    assert_eq!(fake.placed(KEY), None, "hidden under the host's balloon");
    w.view.update(&mut w.cx, |v, cx| v.set_covered(false, cx));
    w.cx.run_until_parked();
    assert!(fake.placed(KEY).is_some());
    // a tree without it (Esc back to the lanes): hidden, kept for its time
    w.tree("trees/factory-overview.json", 5);
    assert_eq!(fake.placed(KEY), None);
    assert_eq!(w.view.read_with(&w.cx, |v, _| v.page_keys()), [KEY]);
    // the view hidden (the Editor shown): hidden too
    w.tree("trees/factory-sheet.json", 6);
    assert!(fake.placed(KEY).is_some());
    w.view.update(&mut w.cx, |v, cx| v.set_shown(false, cx));
    w.cx.run_until_parked();
    assert_eq!(fake.placed(KEY), None);
}

#[test]
fn the_tree_gives_the_page_the_keyboard_and_its_events_reach_the_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Win::open(Some(fake(dir.path(), &["frames/bridge-tree.json"], None)));
    let fake_pages = with_backend(&mut w);
    w.start();
    w.wait("the bridge's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    send_tree(&mut w, &sheet_tree(), 2);
    assert!(!fake_pages.has_focus(KEY));
    // the screen gives the page the keyboard (⏎ on the tab)
    let focused: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/factory-sheet-focused.json")).unwrap(),
    )
    .unwrap();
    send_tree(&mut w, &focused, 3);
    assert_eq!(w.drawn("BrowserFocused"), [KEY]);
    assert!(fake_pages.has_focus(KEY), "the page has the keyboard");
    // Esc in the page (WebKit's side: the monitor gives it back) is told to the bridge
    fake_pages.emit(KEY, BrowserEvent::Focus { focused: false });
    w.wait("the focus frame", |_| {
        log(dir.path()).iter().any(|l| {
            l == &format!(r#"{{"type":"browser","v":2,"key":"{KEY}","event":{{"kind":"focus","focused":false}}}}"#)
        })
    });
    // what it refused, too
    fake_pages.emit(
        KEY,
        BrowserEvent::Blocked {
            url: "http://evil.test/x".into(),
            what: "fetch".into(),
        },
    );
    w.wait("the blocked frame", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""kind":"blocked","url":"http://evil.test/x","what":"fetch""#))
    });
    // the screen took the keyboard back: the page no longer has it
    send_tree(&mut w, &sheet_tree(), 4);
    assert!(!fake_pages.has_focus(KEY));
}

/// A program printing a Show line the way Claude Code ends a message, then waiting.
fn show_script(dir: &Path) -> String {
    let path = dir.join("show.sh");
    std::fs::write(
        &path,
        "#!/bin/sh\necho 'I made a sheet with the 12 carts.'\necho '⏺ Show Cart totals by market'\nsleep 30\n",
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", path.to_str().unwrap()])
        .status()
        .unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn cmd_click_on_a_show_line_in_chats_terminal_opens_the_sheet() {
    let dir = tempfile::tempdir().unwrap();
    let script = show_script(dir.path());
    let mut w = Win::open(Some(fake(dir.path(), &["frames/bridge-tree.json"], None)));
    w.start();
    w.wait("the bridge's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    // a terminal with a Show link (`Terminal.links`: `Show <title>` → `show:<title>`), running
    // the script
    let mut chat = json!({
        "kind": "Island", "id": "chat", "props": {},
        "children": [{"kind": "Terminal", "id": "chat-terminal", "props": {
            "key": "chat:s1240:0", "argv": ["true"], "focused": true, "screenKeys": ["<Esc>"],
            "links": [{"pattern": r"^\W*Show (.+?)\s*$", "click": "show:$1"}],
        }}],
    });
    let links = set_terminal(&mut chat, &script).expect("a Terminal in factory-chat.json");
    assert_eq!(
        links,
        json!([{"pattern": r"^\W*Show (.+?)\s*$", "click": "show:$1"}])
    );
    send_tree(&mut w, &chat, 2);
    let key = "chat:s-probe:0";
    w.wait("the Show line", |w| {
        w.view.read_with(&w.cx, |v, cx| {
            v.terminal(key)
                .is_some_and(|t| t.read(cx).screen().iter().any(|l| l.contains("Show Cart")))
        })
    });
    let (row, at) = w.view.read_with(&w.cx, |v, cx| {
        let t = v.terminal(key).unwrap().read(cx);
        let row = t
            .screen()
            .iter()
            .position(|l| l.contains("Show Cart"))
            .unwrap();
        (row, t.row_point(row).unwrap())
    });
    let click = |w: &mut Win, at, modifiers: Modifiers| {
        w.cx.simulate_mouse_down(at, MouseButton::Left, modifiers);
        w.cx.simulate_event(MouseUpEvent {
            position: at,
            modifiers,
            button: MouseButton::Left,
            click_count: 1,
        });
        w.cx.run_until_parked();
    };
    let show = r#""input":{"kind":"click","id":"show:Cart totals by market"}"#;
    // a plain click is the terminal's own
    click(&mut w, at, Modifiers::default());
    assert!(!log(dir.path()).iter().any(|l| l.contains(show)));
    // ⌘-click on the row: the link's click
    click(&mut w, at, Modifiers::command());
    w.wait("the link's click at the bridge", |_| {
        log(dir.path()).iter().any(|l| l.contains(show))
    });
    // ⌘-click on another row: nothing
    let above = w.view.read_with(&w.cx, |v, cx| {
        v.terminal(key)
            .unwrap()
            .read(cx)
            .row_point(row - 1)
            .unwrap()
    });
    let before = log(dir.path()).len();
    click(&mut w, above, Modifiers::command());
    assert!(
        !log(dir.path())[before..]
            .iter()
            .any(|l| l.contains(r#""id":"show:"#)),
        "a row with no Show line is no link"
    );
}

/// Points the tree's Terminal at `script` under a key of its own; its links.
fn set_terminal(n: &mut Value, script: &str) -> Option<Value> {
    if n["kind"] == "Terminal" {
        n["props"]["argv"] = json!([script]);
        n["props"]["key"] = json!("chat:s-probe:0");
        return Some(n["props"]["links"].clone());
    }
    let kids = n.get_mut("children")?.as_array_mut()?;
    kids.iter_mut().find_map(|c| set_terminal(c, script))
}

fn layer(w: &mut Win, rel: &str, rev: u64) {
    let tree: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap();
    let line = json!({"v": 2, "type": "layer", "rev": rev, "tree": tree}).to_string();
    w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
    w.cx.run_until_parked();
}

#[test]
fn the_card_dialog_lists_the_cards_sheets_and_a_click_on_one_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Win::open(Some(fake(dir.path(), &["frames/bridge-tree.json"], None)));
    w.start();
    w.wait("the bridge's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    // ⏎ first: its Sheets still being read, so no column yet (the story dialog draws one only
    // once a Sheet is attached or the read failed, as F-Story has none)
    layer(&mut w, "trees/command-dialog.json", 2);
    assert!(w.drawn("DialogSheets").is_empty());
    layer(&mut w, "trees/command-dialog-sheets.json", 3);
    assert_eq!(w.drawn("DialogSheets").len(), 1, "the column's header");
    assert_eq!(w.drawn("DialogSheet").len(), 1, "a row per Sheet");
    assert_eq!(w.drawn("DialogSheetSelected").len(), 1, "the selected one");
    // the column at the dialog's right, inside it
    let frame = w.bounds("factory-dialog");
    let side = w.bounds("factory-dialog-sheets");
    assert!(
        side.left() > frame.center().x && side.right() <= frame.right(),
        "{side:?} in {frame:?}"
    );
    let row = "factory-dialog-sheet:1234/prototype-v3-c4d5e6";
    w.click(row);
    w.wait("the row's click", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""kind":"click","id":"sheet:1234/prototype-v3-c4d5e6""#))
    });
    layer(&mut w, "trees/command-dialog-sheets-error.json", 4);
    assert_eq!(
        w.drawn("DialogSheets").len(),
        1,
        "the column says the read failed"
    );
}

#[test]
fn a_prototypes_preview_places_its_app_at_the_viewports_width_and_fit_takes_it_all() {
    const PROTO: &str = "prototype:proto-1a2b3c";
    let mut w = Win::open(None);
    let fake = with_backend(&mut w);
    // 390 in a phone's frame: the app's page, no bar of its own (the page's URL bar is over it)
    w.tree("trees/prototype-preview.json", 1);
    assert_eq!(w.drawn("BrowserView"), [PROTO]);
    assert!(
        w.drawn("BrowserBar").is_empty(),
        "bare: the URL bar is the page's"
    );
    assert_eq!(w.drawn("PrototypeViewport"), ["390"]);
    assert_eq!(
        fake.calls.borrow()[0],
        FakeCall::Open(Page {
            key: PROTO.into(),
            url: "http://127.0.0.1:41207".into(),
            mode: Mode::App,
            reload: 0,
        })
    );
    let page = w.bounds("factory-node-prototype-page");
    let bar = w.bounds("prototype-bar");
    let placed = fake.placed(PROTO).expect("placed");
    assert!(
        (f32::from(placed.size.width) - 390.).abs() < 1.,
        "{placed:?}"
    );
    assert!(
        placed.origin.y >= bar.origin.y + bar.size.height,
        "under the URL bar"
    );
    let mid = |b: gpui_kit::Bounds<gpui_kit::Pixels>| f32::from(b.origin.x + b.size.width / 2.);
    assert!(
        (mid(placed) - mid(page)).abs() < 2.,
        "centred: {placed:?} in {page:?}"
    );
    // Fit: the whole width; a reload: the same page loads again
    let mut fit: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/prototype-preview.json")).unwrap(),
    )
    .unwrap();
    fit["props"]["body"]["width"] = Value::Null;
    fit["props"]["body"]["phone"] = json!(false);
    fit["children"][0]["props"]["reload"] = json!(1);
    send_tree(&mut w, &fit, 2);
    let placed = fake.placed(PROTO).expect("placed");
    assert!(
        f32::from(placed.size.width) > f32::from(page.size.width) - 4.,
        "{placed:?} fills {page:?}"
    );
    assert!(
        fake.calls
            .borrow()
            .iter()
            .any(|c| matches!(c, FakeCall::SetPage(p) if p.key == PROTO && p.reload == 1)),
        "reloaded"
    );
    // its app on its own ports (`open`): another data store, so the page is made again on it
    fit["children"][0]["props"]["mode"] = json!("open");
    fit["children"][0]["props"]["url"] = json!("http://localhost:4000");
    send_tree(&mut w, &fit, 3);
    let opened: Vec<Page> = fake
        .calls
        .borrow()
        .iter()
        .filter_map(|c| match c {
            FakeCall::Open(p) => Some(p.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        opened.last(),
        Some(&Page {
            key: PROTO.into(),
            url: "http://localhost:4000".into(),
            mode: Mode::Open,
            reload: 1,
        }),
        "{opened:?}"
    );
    assert_eq!(opened.len(), 2);
}
