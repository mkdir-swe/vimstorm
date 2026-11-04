//! Which buffer line each drawn row of a pane shows, read from the grid itself: the pane's
//! statuscolumn writes the line as one invisible character U+F0000 + line in its first cell and a
//! fold mark in the second (`config/app/diff.lua` `column`). Reading it from the picture being
//! drawn (nvim's grid, a held sync-group picture, the rows kept for smooth scrolling) keeps the
//! native gutter and the connectors on the text in every frame, folds and wraps included.

use crate::nvim::{Cell, CellText, Grid};

/// First code point of the line code (`config/app/diff.lua` `CODE`).
pub const CODE: u32 = 0xF0000;
/// Highest line with a code (`MAX_LINE`).
pub const MAX_LINE: u32 = 0xFFFD;
/// The second cell's mark on a closed fold's row (`FOLD`).
pub const FOLD: char = '\u{F0001}';

/// A drawn row's buffer line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RowLine {
    /// 1-based.
    pub line: i64,
    /// A closed fold starting at `line`.
    pub folded: bool,
    /// Top of the row as drawn (window px).
    pub y: f32,
}

fn cell_char(c: &Cell) -> Option<char> {
    match &c.text {
        CellText::Char(ch) => Some(*ch),
        CellText::Str(s) => s.chars().next(),
        _ => None,
    }
}

/// The line a row's cells start with (None: no code there, e.g. a wrapped line's continuation).
pub fn decode(cells: &[Cell]) -> Option<(i64, bool)> {
    let code = cell_char(cells.first()?)? as u32;
    let line = code
        .checked_sub(CODE)
        .filter(|l| (1..=MAX_LINE).contains(l))?;
    let folded = cells.get(1).and_then(cell_char) == Some(FOLD);
    Some((line as i64, folded))
}

/// Cells of grid row `r` as drawn: rows of the grid, or (`r` outside them) the rows the last
/// scroll kept above / below the text area `text` (smooth scrolling draws them).
pub fn row_cells<'a>(grid: &'a Grid, text: &std::ops::Range<usize>, r: i64) -> Option<&'a [Cell]> {
    let w = grid.width;
    if w == 0 {
        return None;
    }
    let (above, below) = grid.kept_rows();
    let start = text.start as i64;
    let end = text.end as i64;
    if r >= 0 && (r as usize) < grid.height {
        return Some(grid.row(r as usize));
    }
    if r < start && r >= start - above as i64 {
        let i = (r - (start - above as i64)) as usize;
        return grid.above.get(i * w..(i + 1) * w);
    }
    if r >= end && r < end + below as i64 {
        let i = (r - end) as usize;
        return grid.below.get(i * w..(i + 1) * w);
    }
    None
}

/// The rows of one pane on screen, top to bottom, with their lines.
#[derive(Clone, Debug, Default)]
pub struct RowMap {
    pub rows: Vec<RowLine>,
    pub row_height: f32,
}

impl RowMap {
    pub fn new(mut rows: Vec<RowLine>, row_height: f32) -> Self {
        rows.sort_by(|a, b| a.y.total_cmp(&b.y));
        RowMap { rows, row_height }
    }

    /// The row showing `line` (a fold's row for the line it starts with).
    pub fn row_of(&self, line: i64) -> Option<&RowLine> {
        self.rows.iter().find(|r| r.line == line)
    }

    /// y of the boundary above `line` (= below `line - 1`), also for lines off screen (counted
    /// on from the nearest drawn row) and inside a closed fold (its row's bottom).
    pub fn y_above(&self, line: i64) -> Option<f32> {
        let rh = self.row_height;
        let first = self.rows.first()?;
        let last = self.rows.last()?;
        if let Some(r) = self.row_of(line) {
            return Some(r.y);
        }
        if line < first.line {
            return Some(first.y - (first.line - line) as f32 * rh);
        }
        if line > last.line {
            // the last row's bottom, then one row per line (its fold, if any, counts as one)
            return Some(last.y + rh + (line - last.line - 1) as f32 * rh);
        }
        // between two drawn rows (inside a fold / past a wrapped line): below the row before it
        let before = self.rows.iter().rev().find(|r| r.line < line)?;
        let next = self.rows.iter().find(|r| r.y > before.y);
        Some(next.map_or(before.y + rh, |n| n.y))
    }

    /// Top and bottom y of lines `[s, e)` (equal for an empty range: the boundary above `s`).
    pub fn span(&self, s: i64, e: i64) -> Option<(f32, f32)> {
        let top = self.y_above(s)?;
        if e <= s {
            return Some((top, top));
        }
        Some((top, self.y_above(e)?.max(top)))
    }

    /// The row at y (clicks on the gutter).
    pub fn at(&self, y: f32) -> Option<&RowLine> {
        self.rows
            .iter()
            .find(|r| y >= r.y && y < r.y + self.row_height)
    }

    /// First and last line on screen.
    pub fn visible(&self) -> Option<(i64, i64)> {
        Some((self.rows.first()?.line, self.rows.last()?.line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(c: char) -> Cell {
        Cell {
            text: CellText::new(&c.to_string()),
            hl: 0,
        }
    }

    fn code(line: u32) -> char {
        char::from_u32(CODE + line).unwrap()
    }

    #[test]
    fn decodes_line_codes_and_fold_marks() {
        assert_eq!(decode(&[cell(code(12)), cell(' ')]), Some((12, false)));
        assert_eq!(decode(&[cell(code(3)), cell(FOLD)]), Some((3, true)));
        assert_eq!(
            decode(&[cell(' '), cell(' ')]),
            None,
            "wrapped continuation"
        );
        assert_eq!(decode(&[cell('a')]), None);
        assert_eq!(
            decode(&[cell(char::from_u32(CODE).unwrap())]),
            None,
            "line 0"
        );
    }

    fn map(lines: &[(i64, bool)]) -> RowMap {
        let rows = lines
            .iter()
            .enumerate()
            .map(|(i, (line, folded))| RowLine {
                line: *line,
                folded: *folded,
                y: 100. + 20. * i as f32,
            })
            .collect();
        RowMap::new(rows, 20.)
    }

    #[test]
    fn boundaries_on_and_off_screen() {
        // lines 10..=14 on screen
        let m = map(&[
            (10, false),
            (11, false),
            (12, false),
            (13, false),
            (14, false),
        ]);
        assert_eq!(m.y_above(10), Some(100.));
        assert_eq!(m.y_above(12), Some(140.));
        assert_eq!(m.span(11, 13), Some((120., 160.)));
        assert_eq!(m.span(12, 12), Some((140., 140.)));
        // off screen: counted on
        assert_eq!(m.y_above(15), Some(200.));
        assert_eq!(m.y_above(17), Some(240.));
        assert_eq!(m.y_above(8), Some(60.));
        assert_eq!(m.at(145.).map(|r| r.line), Some(12));
        assert_eq!(m.visible(), Some((10, 14)));
    }

    #[test]
    fn a_closed_fold_is_one_row() {
        // 1, fold 2..=40, 41, 42
        let m = map(&[(1, false), (2, true), (41, false), (42, false)]);
        assert_eq!(m.y_above(2), Some(120.));
        assert_eq!(
            m.y_above(20),
            Some(140.),
            "inside the fold: its row's bottom"
        );
        assert_eq!(m.y_above(41), Some(140.));
        assert_eq!(m.span(2, 41), Some((120., 140.)));
    }
}
