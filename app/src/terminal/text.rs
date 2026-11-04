//! Reading a terminal's text: rows as strings (find, tests), double-click words with WebStorm's
//! word characters, find matches over the whole scrollback (plain text, case-insensitive by
//! default, like the Lua find), the selection as WS copies it.

use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::Flags;

/// WS's word separators for double-click (`TerminalTextSelectioner`; also the Lua terminal's
/// `iskeyword`): blanks and ' " $ ( ) [ ] { } < >. `/ - . : _ @ =` are part of words.
pub fn is_word_char(c: char) -> bool {
    !(c.is_whitespace()
        || c == '\u{a0}'
        || matches!(
            c,
            '\'' | '"' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        ))
}

/// One grid row's text and, per char, its column (wide chars' spacers skipped, trailing blanks
/// kept as spaces).
pub fn row_chars<T>(term: &Term<T>, line: Line) -> Vec<(char, usize)> {
    let row = &term.grid()[line];
    let mut out = Vec::with_capacity(term.columns());
    for col in 0..term.columns() {
        let cell = &row[Column(col)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        out.push((cell.c, col));
        if let Some(zw) = cell.zerowidth() {
            out.extend(zw.iter().map(|c| (*c, col)));
        }
    }
    out
}

/// A row's text, trailing blanks trimmed.
pub fn row_text<T>(term: &Term<T>, line: Line) -> String {
    let s: String = row_chars(term, line).into_iter().map(|(c, _)| c).collect();
    s.trim_end().to_owned()
}

/// The rows on screen (scrolled view included), trailing blanks trimmed.
pub fn screen_lines<T>(term: &Term<T>) -> Vec<String> {
    let offset = term.grid().display_offset() as i32;
    (0..term.screen_lines() as i32)
        .map(|r| row_text(term, Line(r - offset)))
        .collect()
}

/// Current process screen, independent of user scrollback. Readiness/control must never match
/// a historical input prompt or a scrolled view instead of the live CLI state.
pub fn live_lines<T>(term: &Term<T>) -> Vec<String> {
    (0..term.screen_lines() as i32)
        .map(|row| row_text(term, Line(row)))
        .collect()
}

/// Every row, scrollback first.
pub fn all_lines<T>(term: &Term<T>) -> Vec<String> {
    let top = term.topmost_line().0;
    let bottom = term.bottommost_line().0;
    (top..=bottom).map(|l| row_text(term, Line(l))).collect()
}

/// The word around `point` (start, end inclusive), None on a separator.
pub fn word_at<T>(term: &Term<T>, point: Point) -> Option<(Point, Point)> {
    let chars = row_chars(term, point.line);
    let i = chars.iter().rposition(|(_, col)| *col <= point.column.0)?;
    if !is_word_char(chars[i].0) {
        return None;
    }
    let mut a = i;
    while a > 0 && is_word_char(chars[a - 1].0) {
        a -= 1;
    }
    let mut b = i;
    while b + 1 < chars.len() && is_word_char(chars[b + 1].0) {
        b += 1;
    }
    let end_col = chars[b].1;
    // a wide char ends on its spacer
    let wide = term.grid()[point.line][Column(end_col)]
        .flags
        .contains(Flags::WIDE_CHAR);
    Some((
        Point::new(point.line, Column(chars[a].1)),
        Point::new(point.line, Column(end_col + wide as usize)),
    ))
}

/// A find match: grid line, first column, columns covered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    pub line: i32,
    pub col: usize,
    pub cols: usize,
}

/// Plain-text matches of `query` in every row (scrollback first), left to right; `match_case`
/// false = ignoring case (the Lua find's rule).
pub fn find<T>(term: &Term<T>, query: &str, match_case: bool) -> Vec<Match> {
    let fold = |c: char| {
        if match_case {
            c
        } else {
            c.to_lowercase().next().unwrap_or(c)
        }
    };
    let q: Vec<char> = query.chars().map(fold).collect();
    let mut out = Vec::new();
    if q.is_empty() {
        return out;
    }
    let top = term.topmost_line().0;
    let bottom = term.bottommost_line().0;
    for l in top..=bottom {
        let chars = row_chars(term, Line(l));
        let folded: Vec<char> = chars.iter().map(|(c, _)| fold(*c)).collect();
        let mut i = 0;
        while i + q.len() <= folded.len() {
            if folded[i..i + q.len()] == q[..] {
                let col = chars[i].1;
                let last = chars[i + q.len() - 1].1;
                let wide = term.grid()[Line(l)][Column(last)]
                    .flags
                    .contains(Flags::WIDE_CHAR);
                out.push(Match {
                    line: l,
                    col,
                    cols: last + 1 + wide as usize - col,
                });
                i += q.len();
            } else {
                i += 1;
            }
        }
    }
    out
}

/// Regex matches (the find bar's Regex toggle), row by row like [`find`]. An invalid pattern
/// matches nothing.
pub fn find_regex<T>(term: &Term<T>, pattern: &str, match_case: bool) -> Vec<Match> {
    use alacritty_terminal::index::Direction;
    use alacritty_terminal::term::search::{RegexIter, RegexSearch};
    let pattern = if match_case {
        pattern.to_owned()
    } else {
        format!("(?i){pattern}")
    };
    let Ok(mut regex) = RegexSearch::new(&pattern) else {
        return Vec::new();
    };
    let start = Point::new(term.topmost_line(), Column(0));
    let end = Point::new(term.bottommost_line(), term.last_column());
    let mut out = Vec::new();
    for m in RegexIter::new(start, end, Direction::Right, term, &mut regex) {
        let (a, b) = (*m.start(), *m.end());
        if a.line != b.line {
            // a match running onto the next (wrapped) row: drawn on its first row
            out.push(Match {
                line: a.line.0,
                col: a.column.0,
                cols: term.columns() - a.column.0,
            });
        } else {
            out.push(Match {
                line: a.line.0,
                col: a.column.0,
                cols: b.column.0 + 1 - a.column.0,
            });
        }
        if out.len() >= 100_000 {
            break;
        }
    }
    out
}

/// The selection's text as WebStorm copies it: a line the terminal wrapped is one line, no line
/// break after the last line (also when the drag went past its end).
pub fn selection_text<T>(term: &Term<T>) -> Option<String> {
    let text = term.selection_to_string()?;
    let text = text.trim_end_matches('\n').to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::term::test::mock_term;

    #[test]
    fn ws_word_chars() {
        for c in ['a', '-', '/', '.', ':', '_', '@', '=', '~', 'å'] {
            assert!(is_word_char(c), "{c}");
        }
        for c in [
            ' ', '\t', '\'', '"', '$', '(', ')', '[', ']', '{', '}', '<', '>',
        ] {
            assert!(!is_word_char(c), "{c}");
        }
    }

    #[test]
    fn words_finds_and_rows() {
        let term = mock_term("echo word-one ~/a/b.ts (x)\r\nNEEDLE needle\r\n");
        let (a, b) = word_at(&term, Point::new(Line(0), Column(8))).unwrap();
        assert_eq!((a.column.0, b.column.0), (5, 12));
        let (a, b) = word_at(&term, Point::new(Line(0), Column(15))).unwrap();
        assert_eq!((a.column.0, b.column.0), (14, 21));
        assert!(word_at(&term, Point::new(Line(0), Column(4))).is_none());
        let m = find(&term, "needle", false);
        assert_eq!(m.len(), 2);
        assert_eq!(
            m[0],
            Match {
                line: 1,
                col: 0,
                cols: 6
            }
        );
        assert_eq!(find(&term, "needle", true).len(), 1);
        assert_eq!(find_regex(&term, "ne+dle", false).len(), 2);
        assert_eq!(row_text(&term, Line(1)), "NEEDLE needle");
    }
}
