//! Smooth trackpad scrolling of one window grid: the content follows the fingers at pixel
//! precision (momentum included: macOS sends it as more deltas). Whole rows go to nvim as wheel
//! steps (`mousescroll=ver:1`); the rest is drawn as a sub-row offset of the window's text area.
//!
//! The idea of drawing a grid shifted and filling the revealed edge with rows nvim scrolled out is
//! Neovide's (MIT, `src/renderer/rendered_window.rs`); the code here is not. Unlike Neovide (which
//! animates after nvim scrolled), nvim is kept one step *ahead* of the fingers: the drawn content
//! lags behind nvim's, so the revealed edge is always a row that was on screen a moment ago (kept
//! by `UiState` on `grid_scroll`), never one nvim hasn't sent.

/// Most wheel steps one scroll event may send (a hard flick).
const MAX_STEPS: usize = 200;
/// Settle animation time constant (ms): the remaining offset eases out like WebStorm's.
const SETTLE_TAU_MS: f32 = 35.;
/// Settle ticks before giving up on steps nvim never applied (a float mapping the wheel).
const SETTLE_MAX_TICKS: u32 = 60;

/// Pixel scroll state of the grid being scrolled. Sign convention of GPUI / macOS deltas:
/// positive = content moves down (towards the file's start, wheel "up").
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SmoothScroll {
    grid: Option<u64>,
    /// Where the content is drawn relative to nvim's current grid, px (+ = lower).
    offset: f32,
    /// Wheel steps sent that nvim hasn't scrolled yet (+ = up).
    in_flight: i64,
    /// Direction of the last step sent, i.e. which edge nvim keeps rows for: 1 = down (rows that
    /// left at the top), -1 = up (rows that left at the bottom), 0 = none.
    lag: i8,
    settle_ticks: u32,
}

impl SmoothScroll {
    pub fn new() -> Self {
        Self::default()
    }

    /// The grid being scrolled.
    pub fn grid(&self) -> Option<u64> {
        self.grid
    }

    /// (grid, offset in px) to draw, before clamping to the rows nvim's grid has kept.
    pub fn offset(&self) -> Option<(u64, f32)> {
        self.grid
            .filter(|_| self.offset != 0.)
            .map(|g| (g, self.offset))
    }

    /// Done: draw the grid where nvim has it.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// A trackpad delta `dy` (px) over `grid`, whose window shows 0-based `topline` of
    /// `line_count` lines. Returns the wheel steps to send now (+ = up).
    pub fn scroll(&mut self, grid: u64, dy: f32, row: f32, topline: i64, line_count: i64) -> i64 {
        if self.grid != Some(grid) {
            *self = Self {
                grid: Some(grid),
                ..Self::default()
            };
        }
        self.settle_ticks = 0;
        self.offset += dy;
        let mut steps = 0;
        for _ in 0..MAX_STEPS {
            // offset once the steps on their way are applied, and nvim's topline then
            let p = self.offset - self.in_flight as f32 * row;
            let top = topline - self.in_flight;
            if p > 0. && !(self.lag > 0 && p < row) {
                if top <= 0 {
                    // nothing above the first line
                    self.offset -= p;
                    break;
                }
                steps += 1;
                self.in_flight += 1;
                self.lag = -1;
            } else if p < 0. && !(self.lag < 0 && p > -row) {
                // nvim's wheel stops with the last line at the top
                if top >= line_count - 1 {
                    self.offset -= p;
                    break;
                }
                steps -= 1;
                self.in_flight -= 1;
                self.lag = 1;
            } else {
                break;
            }
        }
        steps
    }

    /// nvim scrolled `grid`'s text by `rows` in a redraw batch (+ = content up, topline down the
    /// file). Steps we sent keep the content where it was drawn; other scrolls (keys) move it.
    pub fn scrolled(&mut self, grid: u64, rows: i64, row: f32) {
        if self.grid != Some(grid) || rows == 0 {
            return;
        }
        let k = if self.in_flight < 0 && rows > 0 {
            rows.min(-self.in_flight)
        } else if self.in_flight > 0 && rows < 0 {
            -((-rows).min(self.in_flight))
        } else {
            0
        };
        self.in_flight += k;
        self.offset += k as f32 * row;
    }

    /// nvim's viewport after a batch: steps towards an edge it's already at never apply.
    pub fn viewport(&mut self, grid: u64, topline: i64, line_count: i64) {
        if self.grid != Some(grid) {
            return;
        }
        if self.in_flight > 0 && topline <= 0 {
            self.in_flight = 0;
            self.offset = self.offset.min(0.);
        } else if self.in_flight < 0 && topline >= line_count - 1 {
            self.in_flight = 0;
            self.offset = self.offset.max(0.);
        }
    }

    /// The gesture (and its momentum) ended: finish on the nearest whole row. Returns the step to
    /// send for that (+ = up), if any.
    pub fn settle_start(&mut self, row: f32) -> i64 {
        let p = self.offset - self.in_flight as f32 * row;
        // the kept row is more than half visible: scroll it in instead of back out
        if self.lag > 0 && p > row / 2. {
            self.in_flight += 1;
            self.lag = -1;
            1
        } else if self.lag < 0 && p < -row / 2. {
            self.in_flight -= 1;
            self.lag = 1;
            -1
        } else {
            0
        }
    }

    /// One settle animation frame of `dt_ms`: eases the drawn offset to nvim's position. True when
    /// done (state reset).
    pub fn settle_tick(&mut self, dt_ms: f32, row: f32) -> bool {
        self.settle_ticks += 1;
        let target = self.in_flight as f32 * row;
        let k = 1. - (-dt_ms / SETTLE_TAU_MS).exp();
        self.offset += (target - self.offset) * k;
        if (self.offset - target).abs() < 0.5 {
            self.offset = target;
            if self.in_flight == 0 {
                self.reset();
                return true;
            }
        }
        if self.settle_ticks > SETTLE_MAX_TICKS {
            self.reset();
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROW: f32 = 22.;
    const G: u64 = 4;

    /// A window on a 100-line file plus a fake nvim that applies steps when told.
    struct Sim {
        s: SmoothScroll,
        topline: i64,
        lines: i64,
        /// Steps sent, not applied yet (+ = up).
        queued: i64,
    }

    impl Sim {
        fn new(topline: i64) -> Self {
            Sim {
                s: SmoothScroll::new(),
                topline,
                lines: 100,
                queued: 0,
            }
        }

        fn scroll(&mut self, dy: f32) -> i64 {
            let steps = self.s.scroll(G, dy, ROW, self.topline, self.lines);
            self.queued += steps;
            steps
        }

        /// nvim handles the queued steps and redraws.
        fn apply(&mut self) {
            let before = self.topline;
            self.topline = (self.topline - self.queued).clamp(0, self.lines - 1);
            self.queued = 0;
            self.s.scrolled(G, self.topline - before, ROW);
            self.s.viewport(G, self.topline, self.lines);
        }

        /// Content position in px from the file's start (+ = further down the file).
        fn shown(&self) -> f32 {
            self.topline as f32 * ROW - self.s.offset
        }
    }

    #[test]
    fn content_follows_the_fingers_and_nvim_stays_ahead() {
        let mut sim = Sim::new(10);
        let start = sim.shown();
        // fingers up 5 px: content up, nvim already one row further down the file
        assert_eq!(sim.scroll(-5.), -1);
        sim.apply();
        assert_eq!(sim.topline, 11);
        assert_eq!(sim.s.offset, 17.);
        assert_eq!(sim.shown(), start + 5.);
        // within the row: no step
        assert_eq!(sim.scroll(-10.), 0);
        assert_eq!(sim.shown(), start + 15.);
        // past it: the next one
        assert_eq!(sim.scroll(-10.), -1);
        sim.apply();
        assert_eq!(sim.shown(), start + 25.);
        assert!(sim.s.offset >= 0. && sim.s.offset < ROW);
    }

    #[test]
    fn drawn_offset_is_relative_to_what_nvim_drew() {
        let mut sim = Sim::new(10);
        sim.scroll(-5.);
        // nvim hasn't scrolled yet: the grid still shows the old rows, 5 px up
        assert_eq!(sim.s.offset(), Some((G, -5.)));
        sim.apply();
        assert_eq!(sim.s.offset(), Some((G, 17.)));
    }

    /// (name, topline, finger moves each applied by nvim, topline after, content shown after)
    const GESTURES: &[(&str, i64, &[f32], i64, f32)] = &[
        (
            "a flick sends many steps",
            10,
            &[-200.],
            20,
            10. * ROW + 200.,
        ),
        (
            "reversing scrolls back past the start",
            10,
            &[-5., 20.],
            9,
            10. * ROW + 5. - 20.,
        ),
        ("pulled down at the first line", 0, &[30.], 0, 0.),
        ("pulled past the start", 0, &[-30., 100.], 0, 0.),
        (
            "back down from the start, no dead zone",
            0,
            &[-30., 100., -5.],
            0,
            5.,
        ),
        ("the last line stops at the top", 98, &[-50.], 99, 99. * ROW),
        (
            "back up from the last line",
            98,
            &[-50., 5.],
            99,
            99. * ROW - 5.,
        ),
    ];

    #[test]
    fn content_moves_with_the_fingers_and_stops_at_the_file_s_ends() {
        for &(name, topline, moves, want_topline, want_shown) in GESTURES {
            let mut sim = Sim::new(topline);
            for &dy in moves {
                sim.scroll(dy);
                sim.apply();
            }
            assert_eq!(
                (sim.topline, sim.shown()),
                (want_topline, want_shown),
                "{name}"
            );
            assert!(sim.s.offset.abs() < ROW, "{name}: {:?}", sim.s);
        }
        // nothing to scroll above the first line: no step, nothing drawn moved
        let mut sim = Sim::new(0);
        assert_eq!(sim.scroll(30.), 0);
        assert_eq!(sim.s.offset(), None);
    }

    #[test]
    fn steps_nvim_did_not_apply_are_dropped_at_an_edge() {
        // nvim at the top though our topline was stale: up steps never apply
        let mut sim = Sim::new(1);
        sim.scroll(30.);
        sim.topline = 0;
        sim.queued = 0;
        sim.s.scrolled(G, 0, ROW);
        sim.s.viewport(G, 0, 100);
        assert_eq!(sim.s.in_flight, 0);
        assert!(sim.s.offset <= 0.);
    }

    #[test]
    fn other_scrolls_move_the_content() {
        let mut sim = Sim::new(10);
        sim.scroll(-5.);
        sim.apply();
        let off = sim.s.offset;
        // a key scrolled the window: no steps were on their way, the content jumps with it
        sim.s.scrolled(G, 3, ROW);
        assert_eq!(sim.s.offset, off);
        // another grid's scroll: ignored
        sim.s.scrolled(G + 1, 1, ROW);
        assert_eq!(sim.s.offset, off);
    }

    #[test]
    fn another_grid_starts_over() {
        let mut s = SmoothScroll::new();
        s.scroll(G, -5., ROW, 10, 100);
        s.scroll(G + 1, -3., ROW, 10, 100);
        assert_eq!(s.grid(), Some(G + 1));
        assert_eq!(s.offset(), Some((G + 1, -3.)));
    }

    #[test]
    fn settles_on_the_nearest_row() {
        // less than half the kept row shown: eases back out
        let mut sim = Sim::new(10);
        sim.scroll(-15.);
        sim.apply();
        assert_eq!(sim.s.offset, 7.);
        assert_eq!(sim.s.settle_start(ROW), 0);
        let mut ticks = 0;
        while !sim.s.settle_tick(8., ROW) {
            ticks += 1;
            assert!(ticks < 50);
        }
        assert_eq!(sim.s.offset(), None);
        assert_eq!(sim.shown(), 11. * ROW);

        // more than half: one more step scrolls it in
        let mut sim = Sim::new(10);
        sim.scroll(-5.);
        sim.apply();
        assert_eq!(sim.s.offset, 17.);
        let step = sim.s.settle_start(ROW);
        assert_eq!(step, 1);
        sim.queued += step;
        sim.apply();
        assert_eq!(sim.topline, 10);
        assert_eq!(sim.s.offset, -5.);
        while !sim.s.settle_tick(8., ROW) {}
        assert_eq!(sim.shown(), 10. * ROW);
    }

    #[test]
    fn settle_gives_up_on_steps_that_never_apply() {
        let mut s = SmoothScroll::new();
        s.scroll(G, -5., ROW, 10, 100);
        let mut n = 0;
        while !s.settle_tick(8., ROW) {
            n += 1;
        }
        assert!(n <= SETTLE_MAX_TICKS);
        assert_eq!(s, SmoothScroll::default());
    }
}
