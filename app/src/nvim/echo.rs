//! Local echo for a cloud workspace's Neovim, as mosh does: a char typed in insert mode is
//! drawn at the caret before the box's redraw comes back (~60 ms away), and nvim's redraw
//! confirms or corrects it.
//!
//! Drawing only: every key still goes to nvim once, unchanged. [`Echo`] keeps the run of keys
//! typed since nvim's last confirmed picture and draws them over nvim's grid ([`Echo::shown`]).
//!
//! - Predicted: a printable char (or Backspace over a predicted char) in insert mode, as nvim last
//!   said, on a plain cell of a code split's text area ([`Spot`], the editor's call: no completion
//!   menu, no IME composition), with no unanswered barrier (below). The char goes at the caret in
//!   the highlight of the cell to its left, the row's following cells shift right, the caret
//!   advances.
//! - Reconciled on every flush: the run's states (after 0, 1, … of its keys) are checked against
//!   nvim's grid, the earliest one at or after the last confirmed that matches (caret column and
//!   the run's chars in their cells) is what nvim has drawn so far; none matching (nvim drew
//!   something else: an abbreviation, a mapping), a mode change or a caret on another row drops
//!   the whole run. A run nvim has drawn to its end is done.
//! - A run whose oldest unconfirmed key is [`CONFIRM_WITHIN`] old is dropped ([`Echo::expire`]).
//! - Any other input the editor sends (a non-text key, a click, a scroll) drops the run. Anything
//!   not predicted also holds new runs back until a barrier sent after it comes back
//!   ([`Echo::answered`]): nvim runs the barrier (a notification) only after it read the keys
//!   before it and is not waiting for the rest of a key sequence, and flushes its screen first, so
//!   a new run starts on nvim's real mode and caret. A run an unpredicted key closed is dropped
//!   then too (nvim has drawn all of it), and one dropped with keys nvim hadn't drawn makes the
//!   next key wait for a barrier (they are still on their way). Other input with no run and a
//!   barrier out sends none of its own (a wheel tick, a drag move): the one out holds runs back.
//!
//! No GPUI types: tests drive it with redraw events.

use std::time::{Duration, Instant};

use unicode_width::UnicodeWidthChar;

use super::GridId;
use super::ui::{Cell, CellText, CursorPos, Grid, UiState};

/// A predicted key nvim hasn't drawn within this long is dropped, and nvim's picture shown.
pub const CONFIRM_WITHIN: Duration = Duration::from_secs(1);

/// A key the editor sends to nvim in a form echo can predict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// Text: one char of it.
    Char(char),
    /// `<BS>`.
    Backspace,
}

/// Where the caret is, when the editor allows predicting there: a code split's text area (no
/// completion menu, no IME composition, no native surface with the keyboard).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    /// The split's first text column (nvim's `textoff`): no text cell left of it.
    pub text_col: usize,
}

/// What a key did to the echo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Echoed {
    /// Drawn ahead of nvim.
    Predicted,
    /// Drawn as nvim draws it. With a barrier: send it after the key; no run starts until it is
    /// back ([`Echo::answered`]).
    Unpredicted { barrier: Option<u64> },
}

/// The grid echo draws in place of nvim's, and the caret on it.
#[derive(Clone, Debug)]
pub struct Shown {
    pub grid: GridId,
    pub cells: Grid,
    pub cursor: CursorPos,
}

#[derive(Clone, Copy, Debug)]
struct Typed {
    key: Key,
    at: Instant,
}

/// Keys typed from one caret, nvim's picture of the first `confirmed` of them.
#[derive(Clone, Debug)]
struct Run {
    grid: GridId,
    row: usize,
    /// nvim's caret column when the run's first key was typed.
    col: usize,
    text_col: usize,
    keys: Vec<Typed>,
    confirmed: usize,
    /// An unpredicted key went after it: it takes no more keys.
    closed: bool,
}

impl Run {
    /// The run's text after its first `n` keys.
    fn text(&self, n: usize) -> Vec<char> {
        let mut text = Vec::new();
        for t in &self.keys[..n] {
            match t.key {
                Key::Char(c) => text.push(c),
                Key::Backspace => {
                    text.pop();
                }
            }
        }
        text
    }

    /// Whether nvim's grid shows the run after its first `n` keys: the caret right after its text,
    /// each char in its cell.
    fn shows(&self, n: usize, grid: &Grid, caret: usize) -> bool {
        let text = self.text(n);
        if self.col + width(&text) != caret {
            return false;
        }
        let mut col = self.col;
        for c in text {
            let w = char_width(c);
            let ok = grid
                .cell(self.row, col)
                .is_some_and(|cell| cell.text == CellText::new(c.encode_utf8(&mut [0; 4])))
                && (w == 1
                    || grid
                        .cell(self.row, col + 1)
                        .is_some_and(|n| n.text.is_empty()));
            if !ok {
                return false;
            }
            col += w;
        }
        true
    }
}

/// Columns a char takes on nvim's grid (0 or unknown: not predicted).
fn char_width(c: char) -> usize {
    c.width().unwrap_or(0)
}

fn width(text: &[char]) -> usize {
    text.iter().map(|c| char_width(*c)).sum()
}

/// Local echo of one editor (off: every key unpredicted, nothing drawn).
#[derive(Debug, Default)]
pub struct Echo {
    on: bool,
    run: Option<Run>,
    /// The barrier sent after the last unpredicted input, until it is back.
    held: Option<u64>,
    barriers: u64,
    /// A run was dropped with keys nvim hadn't drawn: the next key waits for a barrier.
    stale: bool,
}

impl Echo {
    pub fn new(on: bool) -> Self {
        Echo {
            on,
            ..Echo::default()
        }
    }

    pub fn on(&self) -> bool {
        self.on
    }

    /// Keys drawn ahead of nvim.
    pub fn pending(&self) -> usize {
        self.run.as_ref().map_or(0, |r| r.keys.len() - r.confirmed)
    }

    /// A key sent to nvim, `spot` where the editor allows predicting (None: it doesn't).
    pub fn key(&mut self, key: Key, ui: &UiState, spot: Option<Spot>, now: Instant) -> Echoed {
        if !self.on {
            return Echoed::Unpredicted { barrier: None };
        }
        if self.predict(key, ui, spot, now) {
            return Echoed::Predicted;
        }
        if let Some(run) = &mut self.run {
            run.closed = true;
        }
        Echoed::Unpredicted {
            barrier: Some(self.barrier()),
        }
    }

    fn predict(&mut self, key: Key, ui: &UiState, spot: Option<Spot>, now: Instant) -> bool {
        let Some(spot) = spot else {
            return false;
        };
        if self.held.is_some() || self.stale || ui.mode != "insert" {
            return false;
        }
        let c = ui.cursor;
        let Some(grid) = ui.grids.get(&c.grid) else {
            return false;
        };
        if self.run.is_none() {
            let plain = c.col >= spot.text_col
                && grid
                    .cell(c.row, c.col)
                    .is_some_and(|cell| !cell.text.is_empty());
            if !plain {
                return false;
            }
            self.run = Some(Run {
                grid: c.grid,
                row: c.row,
                col: c.col,
                text_col: spot.text_col,
                keys: Vec::new(),
                confirmed: 0,
                closed: false,
            });
        }
        let Some(run) = self.run.as_mut().filter(|r| !r.closed) else {
            return false;
        };
        let text = run.text(run.keys.len());
        let fits = match key {
            Key::Char(ch) => {
                let w = char_width(ch);
                w > 0 && !ch.is_control() && run.col + width(&text) + w < grid.width
            }
            Key::Backspace => !text.is_empty(),
        };
        if fits {
            run.keys.push(Typed { key, at: now });
        } else if run.keys.is_empty() {
            self.run = None;
        }
        fits
    }

    /// Anything else sent to nvim (a non-text key, a click, a scroll, a Lua call): the run is
    /// dropped. Returns the barrier to send after it (echo on), none while no run was dropped and
    /// one is out already (each wheel tick, each drag move: the one out holds new runs back).
    pub fn other(&mut self) -> Option<u64> {
        if !self.on || (self.run.is_none() && self.held.is_some()) {
            return None;
        }
        self.run = None;
        Some(self.barrier())
    }

    fn barrier(&mut self) -> u64 {
        self.stale = false;
        self.barriers += 1;
        self.held = Some(self.barriers);
        self.barriers
    }

    /// Barrier `id` came back: nvim has read and drawn everything sent before it. A run an
    /// unpredicted key closed is done then. Returns whether that dropped a run.
    pub fn answered(&mut self, id: u64) -> bool {
        if self.held != Some(id) {
            return false;
        }
        self.held = None;
        let closed = self.run.as_ref().is_some_and(|r| r.closed);
        if closed {
            self.run = None;
        }
        closed
    }

    /// A barrier is out.
    pub fn holding(&self) -> bool {
        self.held.is_some()
    }

    /// nvim flushed `ui`: what it has drawn of the run is confirmed; a run it drew otherwise, or
    /// to its end, is dropped.
    pub fn flushed(&mut self, ui: &UiState) {
        let Some(run) = &mut self.run else {
            return;
        };
        let c = ui.cursor;
        let found = (ui.mode == "insert" && c.grid == run.grid && c.row == run.row)
            .then(|| ui.grids.get(&run.grid))
            .flatten()
            .and_then(|g| (run.confirmed..=run.keys.len()).find(|n| run.shows(*n, g, c.col)));
        match found {
            Some(n) if n < run.keys.len() => run.confirmed = n,
            Some(_) => self.run = None,
            None => {
                self.run = None;
                self.stale = true;
            }
        }
    }

    /// Drops a run whose oldest unconfirmed key is [`CONFIRM_WITHIN`] old. Returns whether it did.
    pub fn expire(&mut self, now: Instant) -> bool {
        let old = self.run.as_ref().is_some_and(|r| {
            r.keys
                .get(r.confirmed)
                .is_some_and(|t| now.saturating_duration_since(t.at) >= CONFIRM_WITHIN)
        });
        if old {
            self.run = None;
            self.stale = true;
        }
        old
    }

    /// nvim's grid with the run's unconfirmed keys drawn over it, and the caret after them.
    pub fn shown(&self, ui: &UiState) -> Option<Shown> {
        let run = self.run.as_ref().filter(|r| r.confirmed < r.keys.len())?;
        let grid = ui.grids.get(&run.grid)?;
        if run.row >= grid.height {
            return None;
        }
        let drawn = run.text(run.confirmed);
        let typed = run.text(run.keys.len());
        let nvim = grid.row(run.row);
        let start = run.col.min(grid.width);
        let tail_at = (run.col + width(&drawn)).min(grid.width);
        let mut row: Vec<Cell> = nvim[..start].to_vec();
        let same = drawn.iter().zip(&typed).take_while(|(a, b)| a == b).count();
        // nvim's own cells for what it has drawn already (its highlights)
        let kept = (run.col + width(&typed[..same])).min(grid.width);
        row.extend_from_slice(&nvim[start..kept]);
        let plain = nvim.last().map_or(0, |c| c.hl);
        for &c in &typed[same..] {
            let hl = match row.last() {
                Some(left) if row.len() > run.text_col => left.hl,
                _ => plain,
            };
            row.push(Cell {
                text: CellText::new(c.encode_utf8(&mut [0; 4])),
                hl,
            });
            if char_width(c) == 2 {
                row.push(Cell {
                    text: CellText::Empty,
                    hl,
                });
            }
        }
        row.extend_from_slice(&nvim[tail_at..]);
        let fill = nvim.last().cloned().unwrap_or_default();
        row.resize(grid.width, fill);
        let mut cells = grid.clone();
        let at = run.row * grid.width;
        cells.cells[at..at + grid.width].clone_from_slice(&row);
        Some(Shown {
            grid: run.grid,
            cells,
            cursor: CursorPos {
                grid: run.grid,
                row: run.row,
                col: run.col + width(&typed),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nvim::RedrawEvent;
    use crate::nvim::redraw::LineCell;

    const GRID: GridId = 2;
    const SPOT: Option<Spot> = Some(Spot { text_col: 0 });

    fn line(row: usize, col: usize, text: &str, hl: u32) -> RedrawEvent {
        RedrawEvent::GridLine {
            grid: GRID,
            row,
            col_start: col,
            cells: text
                .chars()
                .map(|c| LineCell {
                    text: c.to_string(),
                    hl,
                    repeat: 1,
                })
                .collect(),
        }
    }

    fn cursor(row: usize, col: usize) -> RedrawEvent {
        RedrawEvent::GridCursorGoto {
            grid: GRID,
            row,
            col,
        }
    }

    /// `日` at (row, col): the char, then the empty cell nvim sends for its second half.
    fn wide(row: usize, col: usize) -> RedrawEvent {
        let half = |text: &str| LineCell {
            text: text.into(),
            hl: 7,
            repeat: 1,
        };
        RedrawEvent::GridLine {
            grid: GRID,
            row,
            col_start: col,
            cells: vec![half("日"), half("")],
        }
    }

    fn mode(name: &str) -> RedrawEvent {
        RedrawEvent::ModeChange {
            mode: name.into(),
            mode_idx: 0,
        }
    }

    /// nvim's grid 2 (12 x 2) in insert mode: `fn x()` on row 0 in hl 7, the caret at `col`.
    fn editor(col: usize) -> UiState {
        let mut ui = UiState::new();
        ui.apply(vec![
            RedrawEvent::GridResize {
                grid: GRID,
                width: 12,
                height: 2,
            },
            line(0, 0, "fn x()", 7),
            mode("insert"),
            cursor(0, col),
            RedrawEvent::Flush,
        ]);
        ui
    }

    /// Row `row` of what's drawn: echo's grid when it draws one, else nvim's.
    fn drawn(echo: &Echo, ui: &UiState, row: usize) -> String {
        match echo.shown(ui) {
            Some(s) => s.cells.row_text(row),
            None => ui.grids[&GRID].row_text(row),
        }
    }

    fn caret(echo: &Echo, ui: &UiState) -> usize {
        echo.shown(ui).map_or(ui.cursor.col, |s| s.cursor.col)
    }

    fn typed(echo: &mut Echo, ui: &UiState, text: &str, now: Instant) {
        for c in text.chars() {
            assert_eq!(
                echo.key(Key::Char(c), ui, SPOT, now),
                Echoed::Predicted,
                "{c}"
            );
        }
    }

    #[test]
    fn a_typed_char_shows_at_the_caret_and_nvim_drawing_it_confirms_it() {
        let mut ui = editor(4);
        let mut echo = Echo::new(true);
        let t0 = Instant::now();
        typed(&mut echo, &ui, "ab", t0);
        assert_eq!(drawn(&echo, &ui, 0), "fn xab()    ");
        assert_eq!(caret(&echo, &ui), 6);
        // the char to its left gives the highlight
        let shown = echo.shown(&ui).unwrap();
        assert_eq!(shown.cells.cell(0, 4).unwrap().hl, 7);

        // nvim drew the first: one still ahead
        ui.apply(vec![line(0, 4, "a()", 7), cursor(0, 5), RedrawEvent::Flush]);
        echo.flushed(&ui);
        assert_eq!(echo.pending(), 1);
        assert_eq!(drawn(&echo, &ui, 0), "fn xab()    ");
        // and the second: nvim's own picture again
        ui.apply(vec![line(0, 5, "b()", 9), cursor(0, 6), RedrawEvent::Flush]);
        echo.flushed(&ui);
        assert_eq!(echo.pending(), 0);
        assert!(echo.shown(&ui).is_none());
        assert_eq!(drawn(&echo, &ui, 0), "fn xab()    ");
    }

    struct Drop {
        name: &'static str,
        redraw: fn() -> Vec<RedrawEvent>,
        row: &'static str,
        caret: usize,
    }

    /// Redraws after `ab` was typed at column 4 that say the prediction was wrong.
    const DROPS: &[Drop] = &[
        Drop {
            name: "nvim drew other text (an abbreviation or a mapping)",
            redraw: || vec![line(0, 4, "A()", 7), cursor(0, 5), RedrawEvent::Flush],
            row: "fn xA()     ",
            caret: 5,
        },
        Drop {
            name: "a mode change",
            redraw: || vec![mode("normal"), RedrawEvent::Flush],
            row: "fn x()      ",
            caret: 4,
        },
        Drop {
            name: "the caret elsewhere",
            redraw: || vec![cursor(1, 0), RedrawEvent::Flush],
            row: "fn x()      ",
            caret: 0,
        },
    ];

    #[test]
    fn a_redraw_that_disagrees_drops_the_run() {
        for d in DROPS {
            let mut ui = editor(4);
            let mut echo = Echo::new(true);
            typed(&mut echo, &ui, "ab", Instant::now());
            ui.apply((d.redraw)());
            echo.flushed(&ui);
            assert_eq!(echo.pending(), 0, "{}", d.name);
            assert!(echo.shown(&ui).is_none(), "{}", d.name);
            assert_eq!(drawn(&echo, &ui, 0), d.row, "{}", d.name);
            assert_eq!(caret(&echo, &ui), d.caret, "{}", d.name);
        }
    }

    #[test]
    fn a_flush_before_nvim_read_the_keys_keeps_them() {
        let mut ui = editor(4);
        let mut echo = Echo::new(true);
        typed(&mut echo, &ui, "ab", Instant::now());
        // a redraw of its own (a diagnostic on row 1), nvim's caret where it was
        ui.apply(vec![line(1, 0, "E", 3), RedrawEvent::Flush]);
        echo.flushed(&ui);
        assert_eq!(echo.pending(), 2);
        assert_eq!(drawn(&echo, &ui, 0), "fn xab()    ");
        assert_eq!(drawn(&echo, &ui, 1), "E           ");
    }

    #[test]
    fn a_key_nvim_has_not_drawn_within_a_second_is_dropped() {
        let ui = editor(4);
        let mut echo = Echo::new(true);
        let t0 = Instant::now();
        typed(&mut echo, &ui, "a", t0);
        assert!(!echo.expire(t0 + Duration::from_millis(900)));
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
        assert!(echo.expire(t0 + CONFIRM_WITHIN));
        assert_eq!(drawn(&echo, &ui, 0), "fn x()      ");
        assert_eq!(caret(&echo, &ui), 4);
    }

    #[test]
    fn other_input_drops_the_run_and_holds_new_ones_until_its_barrier_is_back() {
        let ui = editor(4);
        let mut echo = Echo::new(true);
        let now = Instant::now();
        typed(&mut echo, &ui, "a", now);
        let barrier = echo.other().unwrap();
        assert!(echo.shown(&ui).is_none());
        assert_eq!(
            echo.key(Key::Char('b'), &ui, SPOT, now),
            Echoed::Unpredicted {
                barrier: Some(barrier + 1)
            }
        );
        // the first barrier back: the second still out
        echo.answered(barrier);
        assert!(echo.holding());
        echo.answered(barrier + 1);
        assert_eq!(echo.key(Key::Char('c'), &ui, SPOT, now), Echoed::Predicted);
    }

    #[test]
    fn other_input_with_no_run_and_a_barrier_out_sends_no_new_one() {
        let ui = editor(4);
        let mut echo = Echo::new(true);
        let now = Instant::now();
        // the first wheel tick: a barrier
        let barrier = echo.other().unwrap();
        // the next ticks and drag moves: that one still out, none more
        assert_eq!(echo.other(), None);
        assert_eq!(echo.other(), None);
        // it still answers
        echo.answered(barrier);
        assert!(!echo.holding());
        assert_eq!(echo.key(Key::Char('a'), &ui, SPOT, now), Echoed::Predicted);
        // a run dropped by other input still gets one
        assert_eq!(echo.other(), Some(barrier + 1));
    }

    struct Refused {
        name: &'static str,
        on: bool,
        redraw: fn() -> Vec<RedrawEvent>,
        /// Every key but the last is predicted; the last is not.
        keys: &'static [Key],
        spot: Option<Spot>,
        barrier: bool,
    }

    /// Keys at column 4 of `fn x()` in insert mode (after `redraw`) that are not predicted.
    const REFUSED: &[Refused] = &[
        Refused {
            name: "a spot the editor does not allow (a menu, an IME composition)",
            on: true,
            redraw: Vec::new,
            keys: &[Key::Char('a')],
            spot: None,
            barrier: true,
        },
        Refused {
            name: "the gutter, left of the text",
            on: true,
            redraw: Vec::new,
            keys: &[Key::Char('a')],
            spot: Some(Spot { text_col: 5 }),
            barrier: true,
        },
        Refused {
            name: "normal mode",
            on: true,
            redraw: || vec![mode("normal"), RedrawEvent::Flush],
            keys: &[Key::Char('x')],
            spot: SPOT,
            barrier: true,
        },
        Refused {
            name: "the caret on a wide char's second cell",
            on: true,
            redraw: || vec![wide(1, 0), cursor(1, 1), RedrawEvent::Flush],
            keys: &[Key::Char('a')],
            spot: SPOT,
            barrier: true,
        },
        Refused {
            name: "the last column, where the line would wrap",
            on: true,
            redraw: || vec![cursor(0, 11), RedrawEvent::Flush],
            keys: &[Key::Char('a')],
            spot: SPOT,
            barrier: true,
        },
        Refused {
            name: "backspace over nvim's own text",
            on: true,
            redraw: Vec::new,
            keys: &[Key::Backspace],
            spot: SPOT,
            barrier: true,
        },
        Refused {
            name: "backspace over more than was typed",
            on: true,
            redraw: Vec::new,
            keys: &[Key::Char('a'), Key::Backspace, Key::Backspace],
            spot: SPOT,
            barrier: true,
        },
        Refused {
            name: "echo off (a local editor): no barrier either",
            on: false,
            redraw: Vec::new,
            keys: &[Key::Char('a')],
            spot: SPOT,
            barrier: false,
        },
    ];

    #[test]
    fn keys_echo_cannot_draw_safely_are_not_predicted() {
        let now = Instant::now();
        for r in REFUSED {
            let mut ui = editor(4);
            ui.apply((r.redraw)());
            let nvim_row = ui.grids[&GRID].row_text(0);
            let mut echo = Echo::new(r.on);
            let (last, before) = r.keys.split_last().unwrap();
            for k in before {
                assert_eq!(
                    echo.key(*k, &ui, r.spot, now),
                    Echoed::Predicted,
                    "{}",
                    r.name
                );
            }
            let Echoed::Unpredicted { barrier } = echo.key(*last, &ui, r.spot, now) else {
                panic!("{}: predicted", r.name);
            };
            assert_eq!(barrier.is_some(), r.barrier, "{}", r.name);
            if before.is_empty() {
                assert_eq!(drawn(&echo, &ui, 0), nvim_row, "{}", r.name);
            }
            if !r.on {
                assert_eq!(echo.other(), None, "{}", r.name);
            }
        }
    }

    #[test]
    fn an_unpredicted_key_keeps_what_is_drawn_but_the_run_takes_no_more() {
        let ui = editor(4);
        let mut echo = Echo::new(true);
        let now = Instant::now();
        typed(&mut echo, &ui, "a", now);
        // the completion menu opened: the editor allows no spot
        let Echoed::Unpredicted {
            barrier: Some(barrier),
        } = echo.key(Key::Char('b'), &ui, None, now)
        else {
            panic!("predicted with the menu open");
        };
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
        // the menu closed again: still nothing more on this run
        assert_ne!(echo.key(Key::Char('c'), &ui, SPOT, now), Echoed::Predicted);
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
        assert!(!echo.answered(barrier), "an older barrier");
    }

    #[test]
    fn backspace_over_a_predicted_char_takes_it_back() {
        let mut ui = editor(4);
        let mut echo = Echo::new(true);
        let now = Instant::now();
        typed(&mut echo, &ui, "ab", now);
        assert_eq!(echo.key(Key::Backspace, &ui, SPOT, now), Echoed::Predicted);
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
        assert_eq!(caret(&echo, &ui), 5);
        // nvim drew `ab`: its `b` is taken back on top of it, the line shifts left
        ui.apply(vec![
            line(0, 4, "ab()", 7),
            cursor(0, 6),
            RedrawEvent::Flush,
        ]);
        echo.flushed(&ui);
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
        assert_eq!(caret(&echo, &ui), 5);
        // then the Backspace
        ui.apply(vec![
            line(0, 5, "()  ", 7),
            cursor(0, 5),
            RedrawEvent::Flush,
        ]);
        echo.flushed(&ui);
        assert!(echo.shown(&ui).is_none());
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
    }

    struct Confirm {
        name: &'static str,
        typed: &'static str,
        row: &'static str,
        caret: usize,
        nvim: fn() -> Vec<RedrawEvent>,
    }

    /// Text typed at column 4 of `fn x()`, then nvim drawing the same.
    const CONFIRMS: &[Confirm] = &[
        Confirm {
            name: "a wide char takes two cells",
            typed: "日",
            row: "fn x日()    ",
            caret: 6,
            nvim: || {
                vec![
                    wide(0, 4),
                    line(0, 6, "()", 7),
                    cursor(0, 6),
                    RedrawEvent::Flush,
                ]
            },
        },
        Confirm {
            name: "a space is a char like any other",
            typed: "a b",
            row: "fn xa b()   ",
            caret: 7,
            nvim: || vec![line(0, 4, "a b()", 7), cursor(0, 7), RedrawEvent::Flush],
        },
    ];

    #[test]
    fn typed_text_shows_until_nvim_drawing_it_confirms_it() {
        for c in CONFIRMS {
            let mut ui = editor(4);
            let mut echo = Echo::new(true);
            typed(&mut echo, &ui, c.typed, Instant::now());
            assert_eq!(drawn(&echo, &ui, 0), c.row, "{}", c.name);
            assert_eq!(caret(&echo, &ui), c.caret, "{}", c.name);
            ui.apply((c.nvim)());
            echo.flushed(&ui);
            assert!(echo.shown(&ui).is_none(), "{}", c.name);
            assert_eq!(drawn(&echo, &ui, 0), c.row, "{}", c.name);
        }
    }

    #[test]
    fn at_the_start_of_the_text_the_char_takes_the_row_s_plain_highlight() {
        let mut ui = editor(0);
        // the row's blank end in hl 5 (the cursor line)
        ui.apply(vec![line(0, 6, "      ", 5), RedrawEvent::Flush]);
        let mut echo = Echo::new(true);
        typed(&mut echo, &ui, "a", Instant::now());
        let shown = echo.shown(&ui).unwrap();
        assert_eq!(shown.cells.row_text(0), "afn x()     ");
        assert_eq!(shown.cells.cell(0, 0).unwrap().hl, 5);
    }

    #[test]
    fn a_run_an_unpredicted_key_closed_is_dropped_when_its_barrier_is_back() {
        let mut ui = editor(4);
        let mut echo = Echo::new(true);
        let now = Instant::now();
        typed(&mut echo, &ui, "ab", now);
        // the menu opened: a Backspace nvim deletes `b` with, not predicted
        let Echoed::Unpredicted {
            barrier: Some(barrier),
        } = echo.key(Key::Backspace, &ui, None, now)
        else {
            panic!("predicted with the menu open");
        };
        // nvim drew all three in one flush: `a`, which the run's first key alone also shows
        ui.apply(vec![line(0, 4, "a()", 7), cursor(0, 5), RedrawEvent::Flush]);
        echo.flushed(&ui);
        assert!(echo.answered(barrier));
        assert!(echo.shown(&ui).is_none());
        assert_eq!(drawn(&echo, &ui, 0), "fn xa()     ");
    }

    #[test]
    fn after_a_run_dropped_with_keys_on_their_way_the_next_key_waits_for_a_barrier() {
        let now = Instant::now();
        // nvim drew something else
        let mut ui = editor(4);
        let mut echo = Echo::new(true);
        typed(&mut echo, &ui, "ab", now);
        ui.apply(vec![line(0, 4, "A()", 7), cursor(0, 5), RedrawEvent::Flush]);
        echo.flushed(&ui);
        let Echoed::Unpredicted {
            barrier: Some(barrier),
        } = echo.key(Key::Char('c'), &ui, SPOT, now)
        else {
            panic!("predicted on a caret `b` is still on its way to");
        };
        echo.answered(barrier);
        assert_eq!(echo.key(Key::Char('d'), &ui, SPOT, now), Echoed::Predicted);
        // a key nvim didn't draw in time
        let ui = editor(4);
        let mut echo = Echo::new(true);
        typed(&mut echo, &ui, "a", now);
        assert!(echo.expire(now + CONFIRM_WITHIN));
        assert_ne!(echo.key(Key::Char('b'), &ui, SPOT, now), Echoed::Predicted);
    }
}
