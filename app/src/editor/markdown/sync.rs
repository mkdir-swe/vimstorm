//! Scroll sync between an editor window and its preview, by source line (pure, unit-tested).
//!
//! Positions: an editor's top is a fractional source line (0-based topline minus the smooth-scroll
//! offset in rows); a preview's top is (row, px into the row). A row maps its source lines onto
//! its content (below its top gap); the blank lines between two rows map onto the second row's
//! gap, so the mapping is continuous both ways.
//!
//! Who leads: the editor, until the user scrolls the preview (wheel / keys); then the preview,
//! whose top line goes to Lua (`set_top`), and the editor's topline changes that Lua reports back
//! (`expect`) are its own echo, not a new lead. An editor scroll to any other line leads again.

use std::collections::VecDeque;
use std::ops::Range;
use std::time::{Duration, Instant};

/// A row's lines and height split: `gap` px above its content, `height` px in all.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowGeom {
    pub gap: f32,
    pub height: f32,
}

/// Index of the row showing source line `line`: the first row not ending at or before it (the
/// last row past the end).
pub fn row_for_line(lines: &[Range<usize>], line: f64) -> usize {
    let ix = lines.partition_point(|r| r.end as f64 <= line);
    ix.min(lines.len().saturating_sub(1))
}

/// Px into row `ix` where source line `line` (fractional) starts.
pub fn offset_in_row(lines: &[Range<usize>], ix: usize, line: f64, g: RowGeom) -> f32 {
    let Some(r) = lines.get(ix) else {
        return 0.;
    };
    let (start, end) = (r.start as f64, r.end as f64);
    // the document's top: above the first row's gap too
    if ix == 0 && line <= start {
        let t = if start > 0. {
            (line / start).clamp(0., 1.)
        } else {
            0.
        };
        return (t as f32) * g.gap;
    }
    if line < start {
        // in the blank lines before it: its gap
        let prev_end = if ix == 0 {
            0.
        } else {
            lines[ix - 1].end as f64
        };
        let span = (start - prev_end).max(1e-9);
        let t = ((line - prev_end) / span).clamp(0., 1.);
        return (t as f32) * g.gap;
    }
    let t = ((line - start) / (end - start).max(1.)).clamp(0., 1.);
    g.gap + (t as f32) * (g.height - g.gap).max(0.)
}

/// The source line (fractional) at `offset` px into row `ix`.
pub fn line_at(lines: &[Range<usize>], ix: usize, offset: f32, g: RowGeom) -> f64 {
    let Some(r) = lines.get(ix) else {
        return lines.last().map_or(0., |r| r.end as f64);
    };
    let (start, end) = (r.start as f64, r.end as f64);
    if offset < g.gap {
        let prev_end = if ix == 0 {
            0.
        } else {
            lines[ix - 1].end as f64
        };
        let t = if g.gap > 0. {
            (offset / g.gap) as f64
        } else {
            1.
        };
        return prev_end + t.clamp(0., 1.) * (start - prev_end);
    }
    let content = (g.height - g.gap).max(1.);
    let t = (((offset - g.gap) / content) as f64).clamp(0., 1.);
    start + t * (end - start)
}

/// Who moved last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Lead {
    #[default]
    Editor,
    Preview,
}

/// One pair's sync state.
#[derive(Debug, Default)]
pub struct SyncState {
    pub lead: Lead,
    /// The editor's integer topline last seen.
    pub editor_top: Option<i64>,
    /// The preview's top line last sent to Lua.
    pub sent: Option<i64>,
    /// Toplines Lua reported after our `set_top`s (their redraws are our own echo).
    expect: VecDeque<(i64, Instant)>,
    /// The user scrolled the preview since the last check.
    pub user_scrolled: bool,
}

/// What a frame should do.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Nothing,
    /// Scroll the preview to this editor line.
    Follow(f64),
    /// Tell Lua the preview's top line (0-based).
    SetTop(i64),
}

const EXPECT_TTL: Duration = Duration::from_millis(1000);

impl SyncState {
    /// Lua set the editor's topline to `top` for us.
    pub fn expect(&mut self, top: i64) {
        let now = Instant::now();
        self.expect
            .retain(|(_, t)| now.duration_since(*t) < EXPECT_TTL);
        self.expect.push_back((top, now));
    }

    /// A frame: the editor shows integer topline `top` (`line` with the smooth offset); the
    /// preview's top is source line `preview_line`.
    pub fn frame(&mut self, top: i64, line: f64, preview_line: f64) -> Action {
        if self.editor_top != Some(top) {
            let first = self.editor_top.is_none();
            self.editor_top = Some(top);
            let now = Instant::now();
            self.expect
                .retain(|(_, t)| now.duration_since(*t) < EXPECT_TTL);
            if let Some(pos) = self.expect.iter().position(|(t, _)| *t == top) {
                // our own set_top's echo (older ones are passed)
                self.expect.drain(..=pos);
            } else if self.lead == Lead::Preview && !self.expect.is_empty() {
                // on its way to a top we asked for (presented in steps)
            } else if !first || self.lead == Lead::Editor {
                self.lead = Lead::Editor;
                self.user_scrolled = false;
                self.sent = None;
                return Action::Follow(line);
            }
        }
        if std::mem::take(&mut self.user_scrolled) {
            self.lead = Lead::Preview;
        }
        match self.lead {
            // (the smooth-scroll offset animates while the integer top stays)
            Lead::Editor => {
                if (line - preview_line).abs() > 1e-3 {
                    Action::Follow(line)
                } else {
                    Action::Nothing
                }
            }
            Lead::Preview => {
                let want = preview_line.floor() as i64;
                if self.sent != Some(want) && want != top {
                    self.sent = Some(want);
                    Action::SetTop(want)
                } else {
                    Action::Nothing
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: RowGeom = RowGeom {
        gap: 10.,
        height: 110.,
    };

    #[test]
    fn line_offset_round_trip() {
        // rows at lines 0..1 and 3..8 (2 blank lines between)
        let lines = vec![0..1, 3..8];
        assert_eq!(row_for_line(&lines, 0.), 0);
        assert_eq!(row_for_line(&lines, 1.), 1);
        assert_eq!(row_for_line(&lines, 5.), 1);
        assert_eq!(row_for_line(&lines, 99.), 1);
        // a blank line between: the second row's gap
        assert_eq!(offset_in_row(&lines, 1, 2., G), 5.);
        assert_eq!(offset_in_row(&lines, 1, 3., G), 10.);
        assert_eq!(offset_in_row(&lines, 1, 5.5, G), 60.);
        for line in [0., 0.5, 1., 2., 3., 4.25, 7.] {
            let ix = row_for_line(&lines, line);
            let off = offset_in_row(&lines, ix, line, G);
            assert!((line_at(&lines, ix, off, G) - line).abs() < 1e-6, "{line}");
        }
    }

    #[test]
    fn editor_leads_until_the_preview_is_scrolled() {
        let mut s = SyncState::default();
        // the first frame aligns the preview
        assert_eq!(s.frame(0, 0., 0.5), Action::Follow(0.));
        assert_eq!(s.frame(0, 0., 0.), Action::Nothing);
        assert_eq!(s.frame(10, 10., 0.), Action::Follow(10.));
        // smooth offset animating: still following
        assert_eq!(s.frame(10, 10.5, 10.), Action::Follow(10.5));
        assert_eq!(s.frame(10, 10.5, 10.5), Action::Nothing);
        // the user wheels the preview: its top line goes to Lua once
        s.user_scrolled = true;
        assert_eq!(s.frame(10, 10., 14.2), Action::SetTop(14));
        assert_eq!(s.frame(10, 10., 14.6), Action::Nothing);
        s.expect(14);
        // the echo doesn't move the preview back
        assert_eq!(s.frame(14, 14., 14.6), Action::Nothing);
        assert_eq!(s.lead, Lead::Preview);
        // the editor scrolled elsewhere by the user: it leads again
        assert_eq!(s.frame(30, 30., 14.6), Action::Follow(30.));
        assert_eq!(s.lead, Lead::Editor);
    }

    #[test]
    fn echoes_out_of_order_are_ignored() {
        let mut s = SyncState::default();
        s.frame(0, 0., 0.);
        s.user_scrolled = true;
        assert_eq!(s.frame(0, 0., 3.), Action::SetTop(3));
        s.expect(3);
        s.user_scrolled = true;
        assert_eq!(s.frame(0, 0., 6.), Action::SetTop(6));
        s.expect(6);
        assert_eq!(s.frame(3, 3., 6.), Action::Nothing);
        assert_eq!(s.frame(6, 6., 6.), Action::Nothing);
        assert_eq!(s.lead, Lead::Preview);
    }
}
