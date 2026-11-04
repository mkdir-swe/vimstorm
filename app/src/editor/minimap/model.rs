//! The minimap's rules, pure: VS Code's `MinimapLayout.create` (proportional size,
//! `scrollBeyondLastLine`, a 2x screen at scale 1: a minimap line 2 px tall, a character 1 px
//! wide) in lines, where a click or a drag puts the top line, and the runs a window's lines
//! draw as.

/// A minimap line's height (VS Code: `baseCharHeight` 2 at scale 2, over the pixel ratio 2).
pub const LINE_H: f32 = 2.0;
/// A minimap character's width.
pub const CHAR_W: f32 = 1.0;

/// A window's lines as Lua reported them (`config/app/minimap.lua`): from line `from` (0-based),
/// one byte a column, `b' '` blank, else `b'!' + i` for colour `palette[i]`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shapes {
    pub buf: i64,
    pub tick: i64,
    pub total: usize,
    pub from: usize,
    pub lines: Vec<Box<[u8]>>,
    /// `0xRRGGBB`.
    pub palette: Vec<u32>,
}

impl Shapes {
    /// Line `n`'s columns, if reported.
    pub fn line(&self, n: usize) -> Option<&[u8]> {
        n.checked_sub(self.from)
            .and_then(|i| self.lines.get(i))
            .map(|l| &l[..])
    }
}

/// What the minimap shows of a window (VS Code's `MinimapLayout`), lines 0-based.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    /// The first line drawn at the minimap's top.
    pub start: usize,
    /// One past the last line drawn.
    pub end: usize,
    /// The slider's top and height, px from the minimap's top.
    pub slider_top: f32,
    pub slider_height: f32,
    /// Slider px a line of scrolling moves it (`computedSliderRatio`); 0: nothing to drag.
    pub ratio: f32,
}

/// The minimap of a `height` px tall area over a window showing `rows` text rows from line `top`
/// (0-based) of `total`.
pub fn layout(height: f32, top: usize, rows: usize, total: usize) -> Layout {
    let total = total.max(1);
    let rows = rows.max(1);
    let fitting = (height / LINE_H).floor().max(0.) as usize;
    // VS Code in lines (its lineHeight 1): scrollTop = top, viewport = rows, and the scroll height
    // with `scrollBeyondLastLine` = total + rows - 1 (nvim's topline goes to the last line too)
    let slider_height = (rows as f32 * LINE_H).floor();
    let beyond = rows - 1;
    let max_top = if beyond > 0 {
        (total + beyond) as f32 - rows as f32 - 1.
    } else {
        (total as f32 - rows as f32).max(0.)
    } * LINE_H;
    let max_top = max_top.min(height - slider_height).max(0.);
    let range = (total - 1) as f32;
    let ratio = if range > 0. { max_top / range } else { 0. };
    let slider_top = top as f32 * ratio;
    if fitting >= total + beyond {
        return Layout {
            start: 0,
            end: total,
            slider_top,
            slider_height,
            ratio,
        };
    }
    // the minimap scrolls: its first line keeps the slider over the window's lines
    let start = (top as f32 - slider_top / LINE_H).floor().max(0.) as usize;
    let end = total.min(start + fitting);
    Layout {
        start,
        end,
        slider_top: (top - start.min(top)) as f32 * LINE_H,
        slider_height,
        ratio,
    }
}

impl Layout {
    /// The line drawn at `y` px from the minimap's top (VS Code's pointer down: that line).
    pub fn line_at(&self, y: f32, total: usize) -> usize {
        let n = self.start + (y.max(0.) / LINE_H).floor() as usize;
        n.min(total.saturating_sub(1))
    }

    /// Whether `y` is on the slider.
    pub fn on_slider(&self, y: f32) -> bool {
        y >= self.slider_top && y < self.slider_top + self.slider_height
    }
}

/// A click at `y` off the slider: the top line that shows the clicked line in the middle
/// (VS Code's `revealLineNumber`, `VerticalRevealType.Center`).
pub fn top_for_click(l: &Layout, y: f32, rows: usize, total: usize) -> usize {
    l.line_at(y, total).saturating_sub(rows / 2)
}

/// A slider drag `dy` px from where it started at `top0` (VS Code's
/// `getDesiredScrollTopFromDelta`), held to nvim's topline range.
pub fn top_for_drag(l: &Layout, top0: usize, dy: f32, total: usize) -> usize {
    if l.ratio <= 0. {
        return top0;
    }
    let top = (top0 as f32 + dy / l.ratio).round().max(0.) as usize;
    top.min(total.saturating_sub(1))
}

/// One stretch of same-coloured columns on a drawn line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    /// Lines below the layout's start.
    pub row: u32,
    pub col: u16,
    pub len: u16,
    /// Into [`Shapes::palette`].
    pub color: u8,
}

/// The runs of the lines `l` draws, at most `cols` columns wide.
pub fn runs(s: &Shapes, l: &Layout, cols: usize) -> Vec<Run> {
    let mut out = Vec::new();
    for n in l.start..l.end {
        let Some(line) = s.line(n) else { continue };
        let row = (n - l.start) as u32;
        let mut c = 0;
        let line = &line[..line.len().min(cols)];
        while c < line.len() {
            let b = line[c];
            if b <= b' ' {
                c += 1;
                continue;
            }
            let from = c;
            while c < line.len() && line[c] == b {
                c += 1;
            }
            out.push(Run {
                row,
                col: from as u16,
                len: (c - from) as u16,
                color: b - b'!',
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_file_fits_whole_and_the_slider_follows_the_top_line() {
        // 100 lines, 40 rows shown, a 600 px minimap (300 lines fit)
        let l = layout(600., 0, 40, 100);
        assert_eq!((l.start, l.end), (0, 100));
        assert_eq!((l.slider_top, l.slider_height), (0., 80.));
        // VS Code: maxMinimapSliderTop = (lines + rows - 1 - rows - 1) * 2 = 196 over 99 lines
        assert!((l.ratio - 196. / 99.).abs() < 1e-4);
        let l = layout(600., 50, 40, 100);
        assert!((l.slider_top - 50. * 196. / 99.).abs() < 1e-3);
        assert_eq!(l.start, 0);
    }

    #[test]
    fn a_long_file_scrolls_the_minimap_with_the_slider_over_the_shown_lines() {
        // 3000 lines, 40 rows, 600 px: 300 lines fit
        let top = layout(600., 0, 40, 3000);
        assert_eq!((top.start, top.end, top.slider_top), (0, 300, 0.));
        let mid = layout(600., 1500, 40, 3000);
        // the slider is halfway down its travel, the minimap's lines start so that it covers 1500
        let travel = 600. - 80.;
        assert!((mid.ratio - travel / 2999.).abs() < 1e-5);
        assert_eq!(
            mid.start,
            1500 - (1500. * travel / 2999. / 2.).floor() as usize - 1
        );
        assert_eq!(mid.end, mid.start + 300);
        assert_eq!(mid.slider_top, (1500 - mid.start) as f32 * 2.);
        assert!(mid.on_slider(mid.slider_top + 1.) && !mid.on_slider(mid.slider_top - 1.));
        // the last line on top: the slider at the bottom of its travel
        let end = layout(600., 2999, 40, 3000);
        assert!((end.slider_top - travel).abs() <= 2.);
        assert_eq!(end.end, 3000);
    }

    #[test]
    fn a_click_centres_its_line_and_a_drag_moves_by_the_slider_ratio() {
        let l = layout(600., 0, 40, 3000);
        // line 100 is at y 200: the top goes to 80 (100 in the middle of 40 rows)
        assert_eq!(l.line_at(201., 3000), 100);
        assert_eq!(top_for_click(&l, 201., 40, 3000), 80);
        // near the top: no negative top
        assert_eq!(top_for_click(&l, 3., 40, 3000), 0);
        // past the last line: the last line
        let short = layout(600., 0, 40, 10);
        assert_eq!(short.line_at(500., 10), 9);
        // a drag of the slider's whole travel goes to the end
        assert_eq!(top_for_drag(&l, 0, 520., 3000), 2999);
        assert_eq!(top_for_drag(&l, 0, 260., 3000), 1500);
        assert_eq!(top_for_drag(&l, 10, -100., 3000), 0);
        // nothing to scroll: stays
        let one = layout(600., 0, 40, 1);
        assert_eq!(top_for_drag(&one, 0, 50., 1), 0);
    }

    #[test]
    fn runs_join_same_coloured_columns_and_skip_blanks_and_unreported_lines() {
        let s = Shapes {
            from: 1,
            total: 4,
            lines: vec![
                b"!!! \"\"!".to_vec().into_boxed_slice(),
                b"".to_vec().into_boxed_slice(),
                b"  ##".to_vec().into_boxed_slice(),
            ],
            palette: vec![0xcccccc, 0x569cd6, 0xce9178],
            ..Shapes::default()
        };
        let l = Layout {
            start: 0,
            end: 4,
            slider_top: 0.,
            slider_height: 10.,
            ratio: 1.,
        };
        let r = runs(&s, &l, 120);
        let run = |row, col, len, color| Run {
            row,
            col,
            len,
            color,
        };
        assert_eq!(
            r,
            vec![
                run(1, 0, 3, 0),
                run(1, 4, 2, 1),
                run(1, 6, 1, 0),
                run(3, 2, 2, 2)
            ]
        );
        // clipped to the minimap's columns
        assert_eq!(runs(&s, &l, 2), vec![run(1, 0, 2, 0)]);
    }
}
