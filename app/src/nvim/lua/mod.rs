//! Lua <-> Rust: Lua's notifications to a surface and Rust's calls into Lua ("Bridge
//! contract"; "bridge" in the app means Abe's `abe ui bridge` only).
//!
//! Lua -> Rust: `require("config.app.bridge").notify(surface, payload)` sends the RPC notification
//! `vimstorm.<surface>` with one table (an `event` field + typed fields) to the app's UI channel.
//! The workspace routes it to that surface's `on_lua`, which decodes it with [`decode`] into its
//! own `#[derive(Deserialize)] #[serde(tag = "event", rename_all = "snake_case")]` enum.
//!
//! Rust -> Lua: [`call`] runs `require(module).fn(args...)` as an `nvim_exec_lua` notification.
//! Nothing waits for nvim: answers come back as Lua notifications (with a request id where
//! needed).

use std::collections::HashSet;

use parking_lot::Mutex;
use rmpv::Value;
use serde::de::DeserializeOwned;

use crate::nvim::Rpc;

/// RPC method prefix of Lua notifications.
pub const PREFIX: &str = "vimstorm.";

/// The surface a notification method addresses (`vimstorm.tree` -> `tree`).
pub fn surface_of(method: &str) -> Option<&str> {
    method.strip_prefix(PREFIX).filter(|s| !s.is_empty())
}

/// The payload of a bridge notification: its one argument (nil when missing).
pub fn payload(mut params: Vec<Value>) -> Value {
    if params.is_empty() {
        Value::Nil
    } else {
        params.swap_remove(0)
    }
}

/// The `event` field of a payload (for messages).
pub fn event_name(payload: &Value) -> Option<&str> {
    crate::nvim::get(payload, "event")?.as_str()
}

/// Decodes a payload into `T`. A bad one is logged to stderr once per surface + event (never a
/// panic, never a log flood) and gives `None`.
pub fn decode<T: DeserializeOwned>(surface: &str, payload: Value) -> Option<T> {
    match rmpv::ext::from_value::<T>(payload.clone()) {
        Ok(v) => Some(v),
        Err(e) => {
            log_once(surface, &payload, &e.to_string());
            None
        }
    }
}

/// Logs an unusable payload once per surface + event name.
pub fn log_once(surface: &str, payload: &Value, why: &str) {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let key = format!("{surface}.{}", event_name(payload).unwrap_or("?"));
    let mut seen = SEEN.lock();
    if seen.get_or_insert_with(HashSet::new).insert(key.clone()) {
        eprintln!("[vimstorm] bridge: bad {key} payload ({why}): {payload}");
    }
}

/// The Lua code [`call`] runs.
pub fn lua_call(module: &str, func: &str) -> String {
    format!("require('{module}').{func}(...)")
}

/// Rust -> Lua: `require(module).func(args...)` as an `nvim_exec_lua` notification. `module` and
/// `func` are fixed names from Rust code (not user input).
pub fn call(rpc: &Rpc, module: &str, func: &str, args: Vec<Value>) {
    rpc.notify(
        "nvim_exec_lua",
        vec![lua_call(module, func).into(), Value::Array(args)],
    );
}

/// The Lua [`navigate`] runs: `config/app/normal.lua`'s `call(module, func, ...)`.
const NAVIGATE: &str = "require('config.app.normal').call(...)";

/// Rust -> Lua for a move (a file opened, a tab or split picked, a tool window given the keys):
/// as [`call`], in Normal mode. Lua leaves what nvim is in first (the command line, an operator
/// waiting for its motion, Insert / Visual / Select mode), so the move never lands under an open
/// `/` or a pending `d`; a blocking prompt, where Lua can't run, gets Esc ([`Rpc::unblock`]).
pub fn navigate(rpc: &Rpc, module: &str, func: &str, args: Vec<Value>) {
    let mut all = Vec::with_capacity(args.len() + 2);
    all.push(module.into());
    all.push(func.into());
    all.extend(args);
    rpc.notify("nvim_exec_lua", vec![NAVIGATE.into(), Value::Array(all)]);
    rpc.unblock();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(tag = "event", rename_all = "snake_case")]
    enum Ev {
        Open { focus: bool },
        Close,
    }

    fn map(pairs: Vec<(&str, Value)>) -> Value {
        Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    #[test]
    fn methods_payloads_and_typed_events() {
        assert_eq!(surface_of("vimstorm.tree"), Some("tree"));
        assert_eq!(surface_of("vimstorm."), None);
        assert_eq!(surface_of("redraw"), None);
        let p = payload(vec![map(vec![
            ("event", "open".into()),
            ("focus", true.into()),
        ])]);
        assert_eq!(event_name(&p), Some("open"));
        assert_eq!(decode::<Ev>("t", p), Some(Ev::Open { focus: true }));
        assert_eq!(
            decode::<Ev>("t", map(vec![("event", "close".into())])),
            Some(Ev::Close)
        );
        // bad payloads: None, no panic
        assert_eq!(decode::<Ev>("t", map(vec![("event", "nope".into())])), None);
        assert_eq!(decode::<Ev>("t", map(vec![("event", "open".into())])), None);
        assert_eq!(decode::<Ev>("t", Value::Nil), None);
        assert_eq!(payload(vec![]), Value::Nil);
        assert_eq!(
            lua_call("config.app", "native_focus"),
            "require('config.app').native_focus(...)"
        );
    }
}
