//! Chat's scroll anchoring (2.2, after the re-feel): scrolled up, a part above the view changing
//! height (an earlier turn folding, a row re-rendered taller, the question card collapsing to its
//! line) leaves the reader's line where it is, as CSS `overflow-anchor` and `NSScrollView` do. The
//! anchor is the first part whose top is in view (or, none's, the part across the view's top);
//! gone the next frame (a step row folded away), the next part in view is. The next frame, before
//! the scroll puts its parts on screen, the scroll takes the anchor's move in the new layout. At the bottom the transcript sticks there instead, and a `reveal` or
//! `bottom` jumps (the transcript skips the anchor then).
//!
//! Places are the parts' unscrolled tops in px under the transcript's top: the layout's, not
//! where a glide paints them.

use gpui_kit::LayoutId;

/// How many parts above the view stand in when every part in view goes.
const ABOVE: usize = 16;

/// A transcript's anchor across frames; `Id` names a part's layout (gpui's [`LayoutId`]).
#[derive(Debug)]
pub struct Anchor<Id = LayoutId> {
    /// The parts the reader's line may be on last frame, first first, and their places: the
    /// parts whose top was in view, then those above it, nearest first.
    at: Vec<(String, f32)>,
    /// This frame's parts and their layout ids, in order (set as they lay out).
    laid: Vec<(String, Id)>,
}

impl<Id> Default for Anchor<Id> {
    fn default() -> Self {
        Anchor {
            at: Vec::new(),
            laid: Vec::new(),
        }
    }
}

impl<Id: Copy> Anchor<Id> {
    /// A new frame: its parts lay out anew.
    pub fn begin(&mut self) {
        self.laid.clear();
    }

    /// The part `key` laid out as `id` this frame.
    pub fn laid(&mut self, key: &str, id: Id) {
        self.laid.push((key.to_owned(), id));
    }

    /// How far the scroll moves down (px; up when negative) so the anchor (the first of last
    /// frame's still laid out) stays where it was on screen, its place this frame read by `place`
    /// from its layout id; none when it did not move or every one is gone.
    pub fn shift(&self, mut place: impl FnMut(Id) -> f32) -> Option<f32> {
        let (id, was) = self.at.iter().find_map(|(key, was)| {
            let (_, id) = self.laid.iter().find(|(k, _)| k == key)?;
            Some((*id, *was))
        })?;
        let dy = place(id) - was;
        // the anchor's place is read anew each frame: a smaller move left alone would add up
        (dy.abs() > 0.01).then_some(dy)
    }

    /// The frame ended: `parts` (key, place) in order and the view's top and bottom edges as
    /// places (the scroll's offset taken out). The anchor is the first part whose top is in view;
    /// none's, the one across the view's top; gone, the next in view, then the nearest above. A
    /// repeated key counts once, as [`Anchor::shift`] finds it.
    pub fn end<'a>(
        &mut self,
        parts: impl IntoIterator<Item = (&'a str, f32)>,
        top: f32,
        bottom: f32,
    ) {
        let mut above = Vec::new();
        let mut seen = std::collections::HashSet::new();
        self.at.clear();
        for (key, at) in parts {
            if at >= bottom {
                break;
            }
            if !seen.insert(key) {
                continue;
            }
            if at >= top - 0.5 {
                self.at.push((key.to_owned(), at));
            } else {
                above.push((key, at));
            }
        }
        // then the parts above, nearest first: every part in view gone (a turn's rows folding to
        // `N steps`), the nearest left above keeps its place, the fold collapsing under it
        let near = above.iter().rev().take(ABOVE);
        self.at
            .extend(near.map(|(key, at)| ((*key).to_owned(), *at)));
    }

    /// Forget it: another session drawn here, its places are not this one's.
    pub fn reset(&mut self) {
        self.at.clear();
        self.laid.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Parts = &'static [(&'static str, f32)];

    struct End {
        name: &'static str,
        parts: Parts,
        top: f32,
        bottom: f32,
        /// The parts kept, the anchor first.
        want: Parts,
    }

    const END: &[End] = &[
        End {
            name: "the first part whose top is in view, then those above",
            parts: &[("a", 0.), ("b", 300.), ("c", 500.), ("d", 700.)],
            top: 250.,
            bottom: 650.,
            want: &[("b", 300.), ("c", 500.), ("a", 0.)],
        },
        End {
            name: "a part right at the view's top is in view",
            parts: &[("a", 0.), ("b", 250.)],
            top: 250.,
            bottom: 650.,
            want: &[("b", 250.), ("a", 0.)],
        },
        End {
            name: "a repeated key counts once",
            parts: &[("x", 0.), ("b", 300.), ("x", 400.)],
            top: 250.,
            bottom: 650.,
            want: &[("b", 300.), ("x", 0.)],
        },
        End {
            name: "a tall part across the view, a part under it",
            parts: &[("a", 0.), ("tall", 100.), ("c", 900.)],
            top: 250.,
            bottom: 650.,
            want: &[("tall", 100.), ("a", 0.)],
        },
        End {
            name: "a tall part across the view, the last part",
            parts: &[("a", 0.), ("tall", 100.)],
            top: 250.,
            bottom: 650.,
            want: &[("tall", 100.), ("a", 0.)],
        },
        End {
            name: "no parts",
            parts: &[],
            top: 0.,
            bottom: 650.,
            want: &[],
        },
    ];

    #[test]
    fn end_keeps_the_anchor_and_the_parts_above() {
        let mut a = Anchor::<u32>::default();
        for row in END {
            a.end(row.parts.iter().copied(), row.top, row.bottom);
            let want: Vec<(String, f32)> = row
                .want
                .iter()
                .map(|(k, t)| ((*k).to_owned(), *t))
                .collect();
            assert_eq!(a.at, want, "{}", row.name);
        }
    }

    struct Shift {
        name: &'static str,
        parts: Parts,
        top: f32,
        bottom: f32,
        /// This frame's parts and their ids.
        laid: &'static [(&'static str, u32)],
        /// Each id's place this frame.
        places: &'static [f32],
        reset: bool,
        want: Option<f32>,
    }

    const AB: Parts = &[("a", 0.), ("b", 300.)];
    const ROWS: Parts = &[("row", 300.), ("row2", 324.), ("prose", 356.)];
    const MSG: Parts = &[("msg", 200.), ("row", 260.), ("row2", 284.)];

    const SHIFT: &[Shift] = &[
        Shift {
            name: "a fold above moves the anchor up",
            parts: AB,
            top: 250.,
            bottom: 650.,
            laid: &[("a", 0), ("b", 1)],
            places: &[180., 180.],
            reset: false,
            want: Some(-120.),
        },
        Shift {
            name: "the anchor gone, the part above did not move",
            parts: AB,
            top: 250.,
            bottom: 650.,
            laid: &[("a", 0)],
            places: &[0.],
            reset: false,
            want: None,
        },
        Shift {
            name: "a move under 0.01 px is no move",
            parts: AB,
            top: 250.,
            bottom: 650.,
            laid: &[("a", 0), ("b", 1)],
            places: &[300.005, 300.005],
            reset: false,
            want: None,
        },
        Shift {
            name: "reset forgets the anchor",
            parts: AB,
            top: 250.,
            bottom: 650.,
            laid: &[("a", 0), ("b", 1)],
            places: &[180., 180.],
            reset: true,
            want: None,
        },
        Shift {
            name: "the anchor gone, the next part in view holds the line",
            parts: ROWS,
            top: 250.,
            bottom: 650.,
            laid: &[("steps", 0), ("prose", 1)],
            places: &[300., 332.],
            reset: false,
            want: Some(-24.),
        },
        Shift {
            name: "every part in view gone, the nearest above stays",
            parts: MSG,
            top: 250.,
            bottom: 300.,
            laid: &[("msg", 0), ("steps", 1)],
            places: &[200., 200.],
            reset: false,
            want: None,
        },
        Shift {
            name: "every part in view gone, the nearest above moved",
            parts: MSG,
            top: 250.,
            bottom: 300.,
            laid: &[("msg", 0), ("steps", 1)],
            places: &[180., 180.],
            reset: false,
            want: Some(-20.),
        },
    ];

    #[test]
    fn shift_is_the_anchors_move_in_the_new_layout() {
        for row in SHIFT {
            let mut a = Anchor::<u32>::default();
            a.end(row.parts.iter().copied(), row.top, row.bottom);
            a.begin();
            for (key, id) in row.laid {
                a.laid(key, *id);
            }
            if row.reset {
                a.reset();
            }
            assert_eq!(
                a.shift(|id| row.places[id as usize]),
                row.want,
                "{}",
                row.name
            );
        }
    }
}
