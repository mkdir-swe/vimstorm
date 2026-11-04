//! What a page may reach, as plain data (no WebKit): the content rule list WebKit compiles, the
//! navigation rule the delegate applies, the script that reports what was refused, and where its
//! cookies are kept. A Sheet (`sheet` mode) reaches only its own URL; an app (`app` mode, the
//! prototype proxy) only its URL's origin and that origin's WebSockets (`ws`/`wss`). Everything
//! else is blocked before it leaves the page, whatever the page's own headers say (a `<form
//! action>`, a `<meta refresh>`, a link, `location = …` included). The person's own app on its
//! fixed ports (`open` mode, ADR 0041) is a browser: no rule list, any http(s) navigation, its
//! cookies kept on disk per origin (signed in once).

use serde::{Deserialize, Serialize};

/// What the page is allowed to reach (the BrowserView's `mode`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Only the page's own URL: a Sheet served by `abe sheet open`.
    #[default]
    Sheet,
    /// Only the page's origin: an app behind the prototype proxy.
    App,
    /// Anywhere over http(s), as a browser: the person's own app on its fixed ports (its backend
    /// on another port, its sign-in provider's redirects), never an agent's page.
    Open,
}

impl Mode {
    /// Whether the page runs under a rule list and the report script (`sheet`, `app`).
    pub fn locked(self) -> bool {
        self != Mode::Open
    }
}

/// `scheme://host[:port]` of an absolute http(s) URL, lower-cased; `None` for anything else.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("{scheme}://{}", host.to_ascii_lowercase()))
}

/// The page's origin as its WebSockets name it (`http` → `ws`, `https` → `wss`): an app behind the
/// proxy reaches its own server's socket (a dev server's live reload) there and nowhere else.
pub fn socket_origin_of(url: &str) -> Option<String> {
    let origin = origin_of(url)?;
    Some(match origin.strip_prefix("https://") {
        Some(host) => format!("wss://{host}"),
        None => format!("ws://{}", &origin["http://".len()..]),
    })
}

/// The URL without its fragment: what a request for it asks.
fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

/// Whether a navigation to `target` stays inside: the page itself (`sheet`), its origin (`app`)
/// or any http(s) URL (`open`; a frame may also be `data:` / `blob:`); a frame's `about:blank` /
/// `about:srcdoc` stays inside too, a top-level one does not.
pub fn allows(mode: Mode, page: &str, target: &str, main_frame: bool) -> bool {
    if !main_frame && (target == "about:blank" || target == "about:srcdoc") {
        return true;
    }
    match mode {
        Mode::Sheet => without_fragment(target) == without_fragment(page),
        Mode::App => origin_of(page).is_some_and(|o| origin_of(target).as_deref() == Some(&o)),
        Mode::Open => {
            origin_of(target).is_some()
                || (!main_frame && (target.starts_with("data:") || target.starts_with("blob:")))
        }
    }
}

/// Where the page's cookies and storage are kept: `None` in memory, gone with the page (`sheet`,
/// `app`); `open`: on disk under a name made of its origin, so a sign-in outlives a reload, the
/// Preview's close and the app's restart, and is never a Sheet's. `None` for no http(s) URL.
pub fn store_of(mode: Mode, page: &str) -> Option<String> {
    match mode {
        Mode::Open => origin_of(page).map(|o| format!("vimstorm-open:{o}")),
        Mode::Sheet | Mode::App => None,
    }
}

/// A stable 16-byte id for a store's name (FNV-1a twice, as a version 8 UUID): the same name gives
/// the same id in every build, so a store is found again after an update.
pub fn store_id(name: &str) -> [u8; 16] {
    let fnv = |seed: u64| {
        name.bytes().fold(seed, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    };
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&fnv(0xcbf2_9ce4_8422_2325).to_be_bytes());
    id[8..].copy_from_slice(&fnv(0x6c62_272e_07bb_0142).to_be_bytes());
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

/// `text` as a literal in WebKit's content-blocker regex (a subset: no disjunction).
fn literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The content rule list (WebKit's JSON): every load blocked, then the page's own (`sheet`: its
/// URL, any fragment; `app`: its origin and that origin's WebSockets) and inline `data:` /
/// `blob:` / `about:` let through.
/// `None` when the page's URL is no http(s) URL: nothing may load then (fail closed); `None` for
/// `open` too, which runs under none (see [`Mode::locked`]).
pub fn rule_list(mode: Mode, page: &str) -> Option<String> {
    let origin = origin_of(page)?;
    let own = match mode {
        Mode::Sheet => vec![format!("^{}(#.*)?$", literal(without_fragment(page)))],
        Mode::App => [Some(origin), socket_origin_of(page)]
            .into_iter()
            .flatten()
            .map(|o| format!("^{}/", literal(&o)))
            .collect(),
        Mode::Open => return None,
    };
    let rule = |filter: &str, action: &str| serde_json::json!({ "trigger": { "url-filter": filter }, "action": { "type": action } });
    let mut rules = vec![rule(".*", "block")];
    rules.extend(own.iter().map(|o| rule(o, "ignore-previous-rules")));
    rules.extend([
        rule("^data:", "ignore-previous-rules"),
        rule("^blob:", "ignore-previous-rules"),
        rule("^about:", "ignore-previous-rules"),
    ]);
    Some(serde_json::Value::Array(rules).to_string())
}

/// The name of the script message handler the page's reports come in on.
pub const HANDLER: &str = "vimstormBrowser";

/// Runs first in every frame (document start): takes WebRTC away (UDP, which no rule list sees),
/// and reports, best-effort, each request the page makes outside what it may reach (the rule list
/// has already refused it) and each CSP violation, as `{kind: 'blocked', url, what}` messages to
/// [`HANDLER`].
pub fn report_script(mode: Mode, page: &str) -> String {
    let own = serde_json::to_string(without_fragment(page)).unwrap_or_else(|_| "\"\"".into());
    let origin = serde_json::to_string(&origin_of(page).unwrap_or_default())
        .unwrap_or_else(|_| "\"\"".into());
    let socket = serde_json::to_string(&socket_origin_of(page).unwrap_or_default())
        .unwrap_or_else(|_| "\"\"".into());
    let app = matches!(mode, Mode::App);
    format!(
        r#"(() => {{
  const own = {own}, origin = {origin}, socket = {socket}, app = {app};
  // WebRTC reaches out over UDP, which no rule list sees: a page here has none
  for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport']) {{
    try {{ Object.defineProperty(window, n, {{ value: undefined, writable: false, configurable: false }}); }} catch (_) {{}}
  }}
  const post = (m) => {{ try {{ window.webkit.messageHandlers.{HANDLER}.postMessage(JSON.stringify(m)); }} catch (_) {{}} }};
  const inside = (raw) => {{
    let u;
    try {{ u = new URL(String(raw), document.baseURI); }} catch (_) {{ return true; }}
    if (['data:', 'blob:', 'about:', 'javascript:'].includes(u.protocol)) return true;
    return app ? u.origin === origin || u.origin === socket : u.href.split('#')[0] === own;
  }};
  const report = (what, url) => {{ if (!inside(url)) post({{ kind: 'blocked', url: String(url), what }}); }};
  const f = window.fetch;
  if (f) window.fetch = function (input, init) {{
    report('fetch', input && input.url !== undefined ? input.url : input);
    return f.apply(this, arguments);
  }};
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {{
    report('xhr', url);
    return open.apply(this, arguments);
  }};
  for (const name of ['WebSocket', 'EventSource']) {{
    const C = window[name];
    if (!C) continue;
    const Wrapped = function (url, ...rest) {{ report(name === 'WebSocket' ? 'websocket' : 'eventsource', url); return new C(url, ...rest); }};
    Wrapped.prototype = C.prototype;
    Object.setPrototypeOf(Wrapped, C);
    window[name] = Wrapped;
  }}
  addEventListener('error', (e) => {{
    const t = e.target;
    if (t && t !== window && t.tagName) report(t.tagName.toLowerCase(), t.currentSrc || t.src || t.href || '');
  }}, true);
  addEventListener('securitypolicyviolation', (e) => {{
    post({{ kind: 'blocked', url: String(e.blockedURI || ''), what: String(e.effectiveDirective || e.violatedDirective || 'csp') }});
  }}, true);
}})();"#
    )
}
