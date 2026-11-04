//! Key latency bench on a real window: `VIMSTORM_BENCH_KEYS` (GPUI keystrokes, space separated,
//! e.g. `i h e l l o space escape`; `#title` starts a new summary section) is dispatched through
//! the window like user input (`Window::dispatch_keystroke`: key down -> keymap / IME text), one
//! key at a time, waiting for each key's frame ([`crate::app::Latency`]). Then it prints the
//! summaries and quits nvim without saving. `VIMSTORM_BENCH_DELAY_MS` (default 3000) waits after
//! the first flush (plugins, LSP), `VIMSTORM_BENCH_GAP_MS` (default 30, + 0..8 ms) between keys.
//! `~<ms>` waits (e.g. after `cmd-down`: the next tile shows), `open:<dir>` opens / shows a project
//! (memory runs: open, switch, `cmd-q`). Only the first editor runs it (other
//! open projects' editors start later), so its keys are measured after cycling back to it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use gpui_kit::{Context, Keystroke, Window};

use crate::editor::EditorView;

/// A key without a frame by then had no visible effect (or macOS doesn't draw the window:
/// `VIMSTORM_BENCH_KEY_TIMEOUT_MS` shortens the wait; its numbers end at the flush).
const KEY_TIMEOUT_MS: u64 = 500;

pub fn schedule(window: &mut Window, cx: &mut Context<EditorView>) {
    static SCHEDULED: AtomicBool = AtomicBool::new(false);
    let Ok(script) = std::env::var("VIMSTORM_BENCH_KEYS") else {
        return;
    };
    if SCHEDULED.swap(true, Ordering::Relaxed) {
        return;
    }
    let env_ms = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let delay = env_ms("VIMSTORM_BENCH_DELAY_MS", 3000);
    let gap = env_ms("VIMSTORM_BENCH_GAP_MS", 30);
    let key_timeout =
        Duration::from_millis(env_ms("VIMSTORM_BENCH_KEY_TIMEOUT_MS", KEY_TIMEOUT_MS));
    cx.spawn_in(window, async move |this, cx| {
        let exec = cx.background_executor().clone();
        let wait = |ms| exec.timer(Duration::from_millis(ms));
        while this.update(cx, |v, _| v.ui().flushes == 0).unwrap_or(false) {
            wait(20).await;
        }
        wait(delay).await;
        let mut section = String::from("keys");
        let mut summaries = Vec::new();
        for (n, token) in script.split_whitespace().enumerate() {
            if let Some(title) = token.strip_prefix('#') {
                let s = this.update(cx, |v, _| v.latency().summary(&section));
                summaries.extend(s.ok().flatten());
                section = title.to_owned();
                continue;
            }
            if let Some(ms) = token.strip_prefix('~').and_then(|t| t.parse().ok()) {
                wait(ms).await;
                continue;
            }
            if let Some(dir) = token.strip_prefix("open:") {
                let req = crate::shell::projects::OpenRequest {
                    dir: dir.into(),
                    file: None,
                };
                // outside this window update: open_path updates the window itself
                let _ = cx.update(|_, cx| {
                    cx.defer(move |cx| {
                        if let Err(e) = crate::shell::projects::open_path(req, cx) {
                            eprintln!("[latency] open: {e:#}");
                        }
                    })
                });
                continue;
            }
            let keystroke = match Keystroke::parse(token) {
                Ok(k) => k,
                Err(e) => {
                    eprintln!("[latency] bad keystroke {token:?}: {e}");
                    continue;
                }
            };
            // not inside a view update: the key handlers update the view
            let _ = cx.update(|window, cx| window.dispatch_keystroke(keystroke, cx));
            let sent = Instant::now();
            while this
                .update(cx, |v, _| v.latency().pending())
                .unwrap_or(false)
            {
                if sent.elapsed() > key_timeout {
                    eprintln!("[latency] {token}: no frame within {key_timeout:?}");
                    let _ = this.update(cx, |v, _| v.latency().give_up());
                    break;
                }
                wait(1).await;
            }
            // + 0..8 ms: keys land at any point of the 8.3 ms frame (120 Hz), not in step with it
            wait(gap + (n as u64 * 7) % 9).await;
        }
        let s = this.update(cx, |v, _| v.latency().summary(&section));
        summaries.extend(s.ok().flatten());
        for s in summaries {
            eprintln!("{s}");
        }
        let _ = this.update(cx, |v, _| v.rpc().command("qa!"));
    })
    .detach();
}
