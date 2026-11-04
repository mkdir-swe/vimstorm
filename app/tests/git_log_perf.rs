//! Log tab performance on a generated 10k-commit repo (`gitfix::big_repo`): Git opened -> the first
//! painted rows, and the frame build time while scrolling the whole log (wheel, PageDown, held ö).
//! Numbers go to stderr (`--nocapture`); budgets are loose in debug builds, the release numbers are
//! the ones reported (`cargo test --release --test perf git_log_perf -- --nocapture`).

use crate::common;

use std::time::{Duration, Instant};

use common::gitfix;
use common::view::View;
use gpui_kit::{KeyDownEvent, Keystroke, ScrollDelta, TouchPhase, point, px, size};
use vimstorm::shell::Role;

fn release() -> bool {
    !cfg!(debug_assertions)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.
}

/// Builds one frame of the window (what a display-link frame does after an event).
fn frame(v: &mut View) -> Duration {
    v.cx.run_until_parked();
    v.cx.update(|window, cx| {
        let t = Instant::now();
        window.refresh();
        window.draw(cx).clear(cx);
        t.elapsed()
    })
}

fn stats(name: &str, frames: &[Duration]) -> (f64, f64) {
    let mut v: Vec<f64> = frames.iter().copied().map(ms).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = v.iter().sum::<f64>() / v.len().max(1) as f64;
    let p95 = v[((v.len() as f64 * 0.95) as usize).min(v.len() - 1)];
    eprintln!(
        "PERF {name}: {} frames, avg {avg:.2} ms, p95 {p95:.2} ms, max {:.2} ms",
        v.len(),
        v.last().copied().unwrap_or(0.)
    );
    (avg, p95)
}

#[test]
fn a_10k_log_opens_fast_and_scrolls_smoothly() {
    let _serial = crate::serial();
    let fx = gitfix::big_repo(10_000);
    eprintln!("PERF repo {}", fx.repo.display());
    let mut v = View::start(fx.repo.to_str().unwrap(), &[]);
    v.cx.simulate_resize(size(px(1388.), px(1081.)));
    v.settle();
    let t0 = Instant::now();
    v.lua("require('config.app.git').open() return true");
    v.wait_until("rows painted", |v| {
        v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).rows_painted_at.is_some())
    });
    let painted = v
        .read_ws(|ws, cx| ws.git().read(cx).log().read(cx).rows_painted_at)
        .unwrap();
    let open = painted - t0;
    let (started, first) = v.read_ws(|ws, cx| {
        let l = ws.git().read(cx).log().read(cx);
        (l.load_started_at.unwrap(), l.first_snapshot_at.unwrap())
    });
    eprintln!(
        "PERF Git opened -> log load started {:.1} ms, first snapshot {:.1} ms",
        ms(started - t0),
        ms(first - t0)
    );
    v.wait_until("the whole log listed", |v| {
        v.read_ws(|ws, cx| !ws.git().read(cx).log().read(cx).loading)
    });
    let all = t0.elapsed();
    let n = v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).model.len());
    eprintln!(
        "PERF Git opened -> first log rows painted {:.1} ms; all {n} listed {:.1} ms",
        ms(open),
        ms(all)
    );
    assert!(n > 7_000, "{n} commits listed (HEAD's history)");

    // the table has the keyboard
    let host = v.read(|e| e.geometry().role_rect(Role::Git).unwrap().island);
    let over = point(host.center().x - px(200.), host.center().y + px(40.));
    frame(&mut v);

    // wheel: 120 steps of 3 rows
    let mut wheel = Vec::new();
    for _ in 0..120 {
        v.scroll(
            over,
            ScrollDelta::Pixels(point(px(0.), px(-72.))),
            TouchPhase::Moved,
        );
        wheel.push(frame(&mut v));
    }
    // PageDown: 100 pages
    let mut pages = Vec::new();
    for _ in 0..100 {
        v.keystrokes("pagedown");
        pages.push(frame(&mut v));
    }
    // held ö: key repeats
    let mut held = Vec::new();
    let ks = Keystroke::parse("ö").unwrap();
    for _ in 0..200 {
        v.cx.simulate_event(KeyDownEvent {
            keystroke: ks.clone(),
            is_held: true,
            prefer_character_input: false,
        });
        held.push(frame(&mut v));
    }
    let cursor = v.read_ws(|ws, cx| ws.git().read(cx).log().read(cx).model.cursor());
    assert!(
        cursor.is_some_and(|c| c >= 100 + 200),
        "PageDown / ö moved the cursor: {cursor:?}"
    );
    let (_, wheel95) = stats("wheel frame", &wheel);
    let (_, page95) = stats("PageDown frame", &pages);
    let (_, held95) = stats("held ö frame", &held);
    if std::env::var_os("PERF_KEEP").is_some() {
        std::mem::forget(fx);
    }
    if release() {
        assert!(ms(open) < 100., "Git opened -> rows {:.1} ms", ms(open));
        for p in [wheel95, page95, held95] {
            assert!(p < 8.3, "frame p95 {p:.2} ms over a 120 Hz frame");
        }
    }
}
