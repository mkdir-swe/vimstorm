//! A transcript's windowing: which of its rows a frame draws. Those in its view and a view's
//! height either side of it are, and a row new or changed since the last frame wherever it is;
//! the rest stand in at the height they had when last drawn (one never drawn at its estimate),
//! so the scroll, its anchor and the glides see the same places. A long transcript's frame costs
//! what its view shows, not what it holds, its first one too (a session shown anew: drawn near
//! its end, or where it was left).

use std::collections::HashMap;

/// What a transcript's rows measured when last drawn, by key.
#[derive(Default, Debug)]
pub struct Heights(HashMap<String, f32>);

/// The view over the rows this frame, in px under the scroll's top (its padding in): where it
/// starts, how tall it is, and whether it jumps to the bottom this frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub top: f32,
    pub height: f32,
    pub bottom: bool,
}

/// One row: its key, the gap above it, how tall it is reckoned while never drawn, and whether
/// it is drawn wherever it is (new or changed, revealed, find's current match).
#[derive(Clone, Copy, Debug)]
pub struct Row<'a> {
    pub key: &'a str,
    pub gap: f32,
    pub est: f32,
    pub must: bool,
}

impl Heights {
    /// Each row's height to stand in at (None: it is drawn). `pad` is the scroll's padding top
    /// and bottom; with no view every row is drawn.
    pub fn plan(&self, rows: &[Row], pad: (f32, f32), view: Option<View>) -> Vec<Option<f32>> {
        let Some(v) = view.filter(|v| v.height > 0.) else {
            return vec![None; rows.len()];
        };
        let mut y = pad.0;
        let spans: Vec<(f32, f32, f32)> = rows
            .iter()
            .map(|r| {
                y += r.gap;
                let (top, h) = (y, self.0.get(r.key).copied().unwrap_or(r.est));
                y += h;
                (top, y, h)
            })
            .collect();
        let top = if v.bottom {
            y + pad.1 - v.height
        } else {
            v.top
        };
        let (from, to) = (top - v.height, top + 2. * v.height);
        rows.iter()
            .zip(spans)
            .map(|(r, (a, b, h))| (!r.must && (b < from || a > to)).then_some(h))
            .collect()
    }

    /// Row `key` drawn `h` tall.
    pub fn measured(&mut self, key: &str, h: f32) {
        match self.0.get_mut(key) {
            Some(was) => *was = h,
            None => {
                self.0.insert(key.to_owned(), h);
            }
        }
    }

    /// Only these rows are left: the others' heights go.
    pub fn keep<'a>(&mut self, keys: impl IntoIterator<Item = &'a str>) {
        let keys: std::collections::HashSet<&str> = keys.into_iter().collect();
        self.0.retain(|k, _| keys.contains(k.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (row, the rows' heights known (None: not measured, reckoned 100 px), the rows drawn
    /// whatever their place, the view, the rows drawn).
    type Case = (
        &'static str,
        &'static [Option<f32>],
        &'static [usize],
        Option<View>,
        &'static [usize],
    );

    const fn at(top: f32, height: f32) -> Option<View> {
        Some(View {
            top,
            height,
            bottom: false,
        })
    }

    /// Ten rows 100 px tall, 16 apart under a 12 px padding: row `i` from `28 + 116 i`.
    const TEN: &[Option<f32>] = &[Some(100.); 10];

    const CASES: &[Case] = &[
        (
            "no view yet: every row",
            TEN,
            &[],
            None,
            &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ),
        (
            "an empty view: every row",
            TEN,
            &[],
            at(0., 0.),
            &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        ),
        (
            "at the top: the view and what is under it",
            TEN,
            &[],
            at(0., 100.),
            &[0, 1],
        ),
        (
            "in the middle: a view's height either side",
            TEN,
            &[],
            at(500., 100.),
            &[3, 4, 5],
        ),
        (
            "jumping to the bottom: the last rows",
            TEN,
            &[],
            Some(View {
                top: 0.,
                height: 100.,
                bottom: true,
            }),
            &[8, 9],
        ),
        (
            "a row not measured stands in at its estimate away from the view",
            &[Some(100.), Some(100.), Some(100.), None, Some(100.)],
            &[],
            at(0., 50.),
            &[0],
        ),
        (
            "a first frame, none measured, at the bottom: the last rows",
            &[None; 10],
            &[],
            Some(View {
                top: 0.,
                height: 100.,
                bottom: true,
            }),
            &[8, 9],
        ),
        (
            "a first frame, none measured, where it was left: the rows there",
            &[None; 10],
            &[],
            at(500., 100.),
            &[3, 4, 5],
        ),
        (
            "a row it must draw, far below",
            TEN,
            &[9],
            at(0., 100.),
            &[0, 1, 9],
        ),
    ];

    #[test]
    fn a_frame_draws_the_rows_in_and_near_its_view_and_the_new_or_changed() {
        let keys: Vec<String> = (0..10).map(|i| format!("r{i}")).collect();
        for &(name, known, must, view, want) in CASES {
            let mut h = Heights::default();
            for (k, v) in keys.iter().zip(known) {
                if let Some(v) = v {
                    h.measured(k, *v);
                }
            }
            let rows: Vec<Row> = (0..known.len())
                .map(|i| Row {
                    key: &keys[i],
                    gap: 16.,
                    est: 100.,
                    must: must.contains(&i),
                })
                .collect();
            let plan = h.plan(&rows, (12., 8.), view);
            let drawn: Vec<usize> = (0..plan.len()).filter(|i| plan[*i].is_none()).collect();
            assert_eq!(drawn, want, "{name}");
            assert!(
                plan.iter().flatten().all(|h| *h == 100.),
                "{name}: a row stands in at its height"
            );
        }
        // a row gone from the transcript forgets its height
        let mut h = Heights::default();
        h.measured("a", 10.);
        h.measured("b", 20.);
        h.keep(["b"]);
        assert_eq!(h.0.len(), 1);
    }
}
