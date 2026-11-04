//! What a drawn row's statuscolumn cells say, read from the grid itself (so it always matches
//! the picture, folds and wrapped lines included): the buffer line (`%l`, blank on a wrapped
//! line's continuation rows), the annotate cells Lua reserved (`WsAnnotate<buf>`, blank, painted
//! over here), and gitsigns' change sign (its hl group; the app's sign text is blank).

use std::ops::Range;

use crate::nvim::{Cell, CellText, Grid};

/// A change marker kind (gitsigns' sign groups, staged ones alike: WS compares with HEAD).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Modified,
    /// Lines deleted below this line: a marker on the boundary under it.
    Deleted,
    /// Lines deleted above line 1: a marker on the boundary above it.
    TopDeleted,
}

impl ChangeKind {
    /// gitsigns' sign hl group -> kind. `changedelete` (a change that also removed lines) is a
    /// modified range in WS (no deletion marker).
    pub fn from_group(name: &str) -> Option<ChangeKind> {
        let kind = name.strip_prefix("GitSigns")?;
        let kind = kind.strip_prefix("Staged").unwrap_or(kind);
        Some(match kind {
            "Add" | "Untracked" => ChangeKind::Added,
            "Change" | "Changedelete" => ChangeKind::Modified,
            "Delete" => ChangeKind::Deleted,
            "Topdelete" => ChangeKind::TopDeleted,
            _ => return None,
        })
    }
}

/// One drawn row's gutter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GutterRow {
    /// The row has line number cells (a buffer line or its continuation).
    pub numbered: bool,
    /// Buffer line (1-based); None on a wrapped line's continuation rows.
    pub lnum: Option<u32>,
    /// Annotate cells: the buffer they annotate and their columns.
    pub annotate: Option<(i64, Range<usize>)>,
    /// First sign cell (where the change bar goes).
    pub sign_col: Option<usize>,
    pub change: Option<ChangeKind>,
}

const ANNOTATE_GROUP: &str = "WsAnnotate";
/// Nobody's statuscolumn is wider than this (annotate + number + bookmark + signs).
const MAX_SCAN: usize = 96;

/// A line number cell's group (`%l` in a statuscolumn).
pub fn is_number(name: &str) -> bool {
    matches!(
        name,
        "LineNr" | "CursorLineNr" | "LineNrAbove" | "LineNrBelow"
    )
}

fn is_sign(name: &str) -> bool {
    matches!(name, "SignColumn" | "CursorLineSign") || name.starts_with("GitSigns")
}

/// Reads one row's statuscolumn cells; `name` = a hl id's group name (ext_hlstate).
pub fn scan<'a>(cells: &[Cell], name: impl Fn(u32) -> Option<&'a str>) -> GutterRow {
    let mut row = GutterRow::default();
    let mut digits = String::new();
    for (col, cell) in cells.iter().enumerate().take(MAX_SCAN) {
        let Some(group) = name(cell.hl) else {
            continue;
        };
        if let Some(buf) = group.strip_prefix(ANNOTATE_GROUP) {
            let buf = buf.parse().unwrap_or(0);
            match &mut row.annotate {
                Some((b, cols)) if *b == buf && cols.end == col => cols.end = col + 1,
                None => row.annotate = Some((buf, col..col + 1)),
                _ => {}
            }
        } else if is_number(group) && row.sign_col.is_none() {
            row.numbered = true;
            if let CellText::Char(c) = cell.text
                && c.is_ascii_digit()
            {
                digits.push(c);
            }
        } else if is_sign(group) {
            let first = *row.sign_col.get_or_insert(col);
            if row.change.is_none() {
                row.change = ChangeKind::from_group(group);
            }
            if col > first {
                break; // two sign cells read: the code follows
            }
        }
        // anything else: a bookmark cell, or the code of a window without signs
    }
    row.lnum = digits.parse().ok();
    row
}

/// The cells of text-area row `row` as drawn: rows outside `text_rows` are the ones the last
/// scroll kept (`Grid::above` / `below`), shown in the edge the smooth-scroll offset reveals.
pub fn drawn_row<'a>(grid: &'a Grid, text_rows: &Range<usize>, row: i64) -> Option<&'a [Cell]> {
    let w = grid.width;
    let (above, below) = grid.kept_rows();
    let (start, end) = (text_rows.start as i64, text_rows.end as i64);
    if row < start {
        let i = above as i64 - (start - row);
        let i = usize::try_from(i).ok()?;
        return grid.above.get(i * w..(i + 1) * w);
    }
    if row >= end {
        let i = usize::try_from(row - end).ok()?;
        if i >= below {
            return None;
        }
        return grid.below.get(i * w..(i + 1) * w);
    }
    (row < grid.height as i64).then(|| grid.row(row as usize))
}

/// A run of rows that belong to one buffer line (its first row has the number).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineRows {
    pub lnum: u32,
    /// Drawn rows (grid rows, may be outside the text area while smooth scrolling).
    pub rows: Range<i64>,
    /// The line's first row is on screen (else it starts above: a continuation shown first).
    pub starts_here: bool,
    pub annotate: Option<(i64, Range<usize>)>,
    pub sign_col: Option<usize>,
    pub change: Option<ChangeKind>,
}

/// Groups a window's scanned rows (in screen order) into buffer lines: continuation rows join the
/// line above them. A first row that's a continuation of a line starting above gets `lnum` from
/// `above_lnum` (unknown: dropped).
pub fn lines(rows: &[(i64, GutterRow)]) -> Vec<LineRows> {
    let mut out: Vec<LineRows> = Vec::new();
    for (r, g) in rows {
        if !g.numbered {
            continue;
        }
        match g.lnum {
            Some(lnum) => out.push(LineRows {
                lnum,
                rows: *r..r + 1,
                starts_here: true,
                annotate: g.annotate.clone(),
                sign_col: g.sign_col,
                change: g.change,
            }),
            None => {
                if let Some(last) = out.last_mut().filter(|l| l.rows.end == *r) {
                    last.rows.end = r + 1;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cells from (text, group) pairs; hl id = index into `groups`.
    fn row(spec: &[(&str, &str)]) -> (Vec<Cell>, Vec<String>) {
        let mut groups = vec![String::new()];
        let mut cells = Vec::new();
        for (text, group) in spec {
            let hl = groups.iter().position(|g| g == group).unwrap_or_else(|| {
                groups.push(group.to_string());
                groups.len() - 1
            });
            for c in text.chars() {
                cells.push(Cell {
                    text: CellText::new(&c.to_string()),
                    hl: hl as u32,
                });
            }
        }
        (cells, groups)
    }

    fn scan_spec(spec: &[(&str, &str)]) -> GutterRow {
        let (cells, groups) = row(spec);
        scan(&cells, |hl| {
            let g = groups[hl as usize].as_str();
            (!g.is_empty()).then_some(g)
        })
    }

    const BLANK: GutterRow = GutterRow {
        numbered: false,
        lnum: None,
        annotate: None,
        sign_col: None,
        change: None,
    };

    struct Scan {
        name: &'static str,
        cells: &'static [(&'static str, &'static str)],
        want: GutterRow,
    }

    const SCAN: &[Scan] = &[
        Scan {
            name: "annotate, number, bookmark and sign cells",
            cells: &[
                ("    ", "WsAnnotate7"),
                (" 12", "LineNr"),
                (" ", "WsBookmark"),
                ("  ", "GitSignsChange"),
                ("code", "@variable"),
            ],
            want: GutterRow {
                numbered: true,
                lnum: Some(12),
                annotate: Some((7, 0..4)),
                sign_col: Some(8),
                change: Some(ChangeKind::Modified),
            },
        },
        Scan {
            name: "a continuation row has a blank number and no sign",
            cells: &[
                ("   ", "CursorLineNr"),
                (" ", ""),
                ("  ", "CursorLineSign"),
                ("x", "@x"),
            ],
            want: GutterRow {
                numbered: true,
                sign_col: Some(4),
                ..BLANK
            },
        },
        Scan {
            name: "a numbered bookmark cell is not part of the line number",
            cells: &[
                (" 4", "LineNr"),
                ("3", "WsBookmarkNumber"),
                ("  ", "SignColumn"),
            ],
            want: GutterRow {
                numbered: true,
                lnum: Some(4),
                sign_col: Some(3),
                ..BLANK
            },
        },
        Scan {
            name: "past the end of the buffer",
            cells: &[("~", "EndOfBuffer"), ("     ", "EndOfBuffer")],
            want: BLANK,
        },
        Scan {
            name: "a window without a statuscolumn",
            cells: &[("$ ls", "Normal")],
            want: BLANK,
        },
    ];

    #[test]
    fn scan_reads_the_statuscolumn_cells() {
        for row in SCAN {
            assert_eq!(scan_spec(row.cells), row.want, "{}", row.name);
        }
    }

    #[test]
    fn gitsigns_groups_map_to_change_kinds() {
        use ChangeKind::*;
        for (g, k) in [
            ("GitSignsAdd", Some(Added)),
            ("GitSignsStagedAdd", Some(Added)),
            ("GitSignsChange", Some(Modified)),
            ("GitSignsChangedelete", Some(Modified)),
            ("GitSignsStagedChangedelete", Some(Modified)),
            ("GitSignsDelete", Some(Deleted)),
            ("GitSignsTopdelete", Some(TopDeleted)),
            ("GitSignsAddInline", None),
            ("SignColumn", None),
        ] {
            assert_eq!(ChangeKind::from_group(g), k, "{g}");
        }
    }

    #[test]
    fn wrapped_lines_group_their_rows() {
        let g = |lnum: Option<u32>| GutterRow {
            numbered: true,
            lnum,
            ..Default::default()
        };
        let rows = vec![
            (-1, g(None)), // continuation of a line above the screen: dropped
            (0, g(Some(3))),
            (1, g(None)),
            (2, g(None)),
            (3, g(Some(4))),
            (4, GutterRow::default()), // past the end
        ];
        let ls = lines(&rows);
        assert_eq!(ls.len(), 2);
        assert_eq!((ls[0].lnum, ls[0].rows.clone()), (3, 0..3));
        assert_eq!((ls[1].lnum, ls[1].rows.clone()), (4, 3..4));
    }

    #[test]
    fn kept_rows_are_read_from_above_and_below() {
        let mut grid = Grid {
            width: 1,
            height: 3,
            cells: vec![Cell::default(); 3],
            ..Default::default()
        };
        grid.above = vec![
            Cell {
                text: CellText::Char('a'),
                hl: 0,
            },
            Cell {
                text: CellText::Char('b'),
                hl: 0,
            },
        ];
        let tr = 0..3;
        assert_eq!(
            drawn_row(&grid, &tr, -1).unwrap()[0].text,
            CellText::Char('b')
        );
        assert_eq!(
            drawn_row(&grid, &tr, -2).unwrap()[0].text,
            CellText::Char('a')
        );
        assert!(drawn_row(&grid, &tr, -3).is_none());
        assert!(drawn_row(&grid, &tr, 3).is_none());
        assert!(drawn_row(&grid, &tr, 2).is_some());
    }
}
