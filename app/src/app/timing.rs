//! Timing (`VIMSTORM_TIMING=1`, on stderr): startup milestones (ms since process start) and
//! per-key latency ([`Latency`]: key at the view -> `nvim_input` sent -> the flush with its redraw
//! -> painted -> the next vsync).

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();
/// When the reader thread last handed over a flushed batch.
static RECEIVED: Mutex<Option<Instant>> = Mutex::new(None);

/// Call first thing in `main`. `VIMSTORM_BENCH_KEYS` turns timing on too.
pub fn start() {
    START.get_or_init(Instant::now);
    ENABLED.get_or_init(|| {
        std::env::var_os("VIMSTORM_TIMING").is_some_and(|v| v != "0")
            || std::env::var_os("VIMSTORM_BENCH_KEYS").is_some()
    });
}

pub fn enabled() -> bool {
    *ENABLED.get().unwrap_or(&false)
}

pub fn mark(label: &str) {
    if enabled() {
        let ms = START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
        eprintln!("[timing] {ms:8.1} ms  {label}");
    }
}

/// Reader thread: a flushed redraw batch came off nvim's stdout (before the UI thread gets it).
pub fn redraw_received() {
    if enabled() {
        *RECEIVED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }
}

fn last_received() -> Option<Instant> {
    *RECEIVED.lock().unwrap_or_else(|e| e.into_inner())
}

/// One key's trip. Stages are set once, in order.
struct Probe {
    label: String,
    key: Instant,
    sent: Option<Instant>,
    received: Option<Instant>,
    applied: Option<Instant>,
    /// The frame drawing it started (prepaint).
    drawing: Option<Instant>,
    painted: Option<Instant>,
}

const STAGES: [&str; 6] = ["sent", "rx", "flush", "draw", "paint", "vsync"];

/// Key -> frame latency, one key at a time (keys typed while one is in flight aren't probed).
#[derive(Default)]
pub struct Latency {
    probe: Option<Probe>,
    /// ms from the key to each of [`STAGES`].
    done: Vec<[f64; 6]>,
}

impl Latency {
    /// A key reached the view. A probe that never got a redraw (no visible effect) is dropped
    /// after a second.
    pub fn key(&mut self, label: &str) {
        if !enabled() {
            return;
        }
        let stale = self
            .probe
            .as_ref()
            .is_some_and(|p| p.key.elapsed().as_secs_f64() > 1.0);
        if self.probe.is_none() || stale {
            self.probe = Some(Probe {
                label: label.to_owned(),
                key: Instant::now(),
                sent: None,
                received: None,
                applied: None,
                drawing: None,
                painted: None,
            });
        }
    }

    /// Input for the key went to nvim.
    pub fn sent(&mut self) {
        if let Some(p) = &mut self.probe
            && p.sent.is_none()
        {
            p.sent = Some(Instant::now());
        }
    }

    /// A flush was applied on the UI thread.
    pub fn flushed(&mut self) {
        if let Some(p) = &mut self.probe
            && p.sent.is_some()
            && p.applied.is_none()
        {
            p.received = last_received();
            p.applied = Some(Instant::now());
        }
    }

    /// A frame's prepaint started.
    pub fn drawing(&mut self) {
        if let Some(p) = &mut self.probe
            && p.applied.is_some()
            && p.drawing.is_none()
        {
            p.drawing = Some(Instant::now());
        }
    }

    /// A frame was painted; true when it's the one showing the probed key's flush (the caller
    /// then calls [`Self::presented`] on the next frame).
    pub fn painted(&mut self) -> bool {
        match &mut self.probe {
            Some(p) if p.applied.is_some() && p.painted.is_none() => {
                p.painted = Some(Instant::now());
                true
            }
            _ => false,
        }
    }

    /// The next vsync after the paint (the frame is on screen): logs the key's numbers.
    pub fn presented(&mut self) {
        if let Some(p) = self.probe.take() {
            self.log(p, Some(Instant::now()));
        }
    }

    /// The probed key's frame never came (a window macOS doesn't draw: occluded, background
    /// bench runs): logs what it got up to the flush; a key without a flush is dropped.
    pub fn give_up(&mut self) {
        if let Some(p) = self.probe.take().filter(|p| p.applied.is_some()) {
            self.log(p, None);
        }
    }

    fn log(&mut self, p: Probe, presented: Option<Instant>) {
        let ms = |t: Option<Instant>| t.map_or(f64::NAN, |t| (t - p.key).as_secs_f64() * 1000.0);
        let row = [
            ms(p.sent),
            ms(p.received),
            ms(p.applied),
            ms(p.drawing),
            ms(p.painted),
            ms(presented),
        ];
        let stages: Vec<String> = STAGES
            .iter()
            .zip(row)
            .map(|(s, v)| format!("{s} {v:5.1}"))
            .collect();
        eprintln!("[latency] {:<10} {} ms", p.label, stages.join("  "));
        self.done.push(row);
    }

    /// A probe is in flight.
    pub fn pending(&self) -> bool {
        self.probe.is_some()
    }

    /// Median / p95 / max per stage over the keys measured since the last summary (None: no
    /// keys); clears them.
    pub fn summary(&mut self, title: &str) -> Option<String> {
        let n = self.done.len();
        if n == 0 {
            return None;
        }
        let mut out = format!("[latency] {title}: {n} keys (ms from the key: median / p95 / max)");
        for (i, stage) in STAGES.iter().enumerate() {
            let mut v: Vec<f64> = self
                .done
                .iter()
                .map(|r| r[i])
                .filter(|x| !x.is_nan())
                .collect();
            v.sort_by(f64::total_cmp);
            let at = |q: f64| {
                v.get(((v.len() as f64 - 1.0) * q).round() as usize)
                    .copied()
            };
            if let (Some(med), Some(p95), Some(max)) = (at(0.5), at(0.95), v.last()) {
                out += &format!("\n[latency]   {stage:<6} {med:6.1} {p95:6.1} {max:6.1}");
            }
        }
        self.done.clear();
        Some(out)
    }
}
