//! Pieces every picker popup shares: the row frame (inset rounded selection like WebStorm's popup
//! lists), labels with matched chars highlighted, path helpers.

use std::ops::Range;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, Div, HighlightStyle, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, Rgba, SharedString, Stateful, Styled as _, div, prelude::FluentBuilder as _, px,
};

use crate::kit::MatchedText;
use crate::look;

/// A popup list row: full width, `height`, the selection / hover rect inset from the popup's
/// sides (WebStorm `Popup.Selection.leftRightInset`), content padded inside it. A selected row's
/// text is `*.selectionForeground` (children with their own color, file-status names, keep it).
pub fn row(
    id: (&'static str, usize),
    height: Pixels,
    selected: bool,
    hovered: bool,
) -> Stateful<Div> {
    row_tinted(id, height, selected, hovered, None)
}

/// [`row`] on a file color (`tint`, e.g. non-project yellow) where it's neither selected nor
/// hovered.
pub fn row_tinted(
    id: (&'static str, usize),
    height: Pixels,
    selected: bool,
    hovered: bool,
    tint: Option<Rgba>,
) -> Stateful<Div> {
    let bg = if selected {
        Some(look::SELECTION_BG.rgba())
    } else if hovered {
        Some(look::HOVER_BG.rgba())
    } else {
        tint
    };
    div()
        .id(id)
        .debug_selector(move || format!("{}-{}", id.0, id.1))
        .h(height)
        .w_full()
        .flex_none()
        .relative()
        .cursor_pointer()
        .when(selected, |d| d.text_color(look::SELECTION_TEXT))
        .when_some(bg, |d, bg| {
            d.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(look::LIST_ROW_INSET_X))
                    .right(px(look::LIST_ROW_INSET_X))
                    .rounded(px(look::LIST_SELECTION_ARC))
                    .bg(bg),
            )
        })
}

/// The content box of a [`row`]: a horizontal flex inside the selection rect's padding.
pub fn row_content() -> Div {
    div()
        .relative()
        .size_full()
        .px(px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X))
        .flex()
        .items_center()
        .overflow_hidden()
}

/// Highlight of matched chars in picker rows: WebStorm's speed-search match look.
pub fn match_style() -> HighlightStyle {
    HighlightStyle {
        color: Some(look::hsla(look::SEARCH_MATCH_FG.rgba())),
        background_color: Some(look::hsla(look::SEARCH_MATCH_BG.rgba())),
        ..Default::default()
    }
}

/// `text` with the chars at `matches` (char indices) highlighted (rounded match boxes).
pub fn matched(text: impl Into<SharedString>, matches: &[u32]) -> MatchedText {
    crate::kit::match_text(text, matches)
}

/// `text` with byte ranges highlighted; overlapping ranges layer (a later one's fields win: a
/// usage's bold over its syntax color). Match-colored ranges get WS's rounded match boxes.
pub fn ranged(
    text: impl Into<SharedString>,
    ranges: impl IntoIterator<Item = (Range<usize>, HighlightStyle)>,
) -> MatchedText {
    let text = text.into();
    let len = text.len();
    let ranges: Vec<_> = ranges
        .into_iter()
        .filter(|(r, _)| {
            r.start < r.end
                && r.end <= len
                && text.is_char_boundary(r.start)
                && text.is_char_boundary(r.end)
        })
        .collect();
    // GPUI wants sorted, non-overlapping ranges: cut at every boundary, layer the styles
    let mut cuts: Vec<usize> = ranges.iter().flat_map(|(r, _)| [r.start, r.end]).collect();
    cuts.sort_unstable();
    cuts.dedup();
    let mut out: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    for w in cuts.windows(2) {
        let seg = w[0]..w[1];
        let mut style: Option<HighlightStyle> = None;
        for (r, s) in &ranges {
            if r.start <= seg.start && seg.end <= r.end {
                style = Some(match style {
                    Some(base) => base.highlight(*s),
                    None => *s,
                });
            }
        }
        if let Some(style) = style {
            out.push((seg, style));
        }
    }
    crate::kit::highlighted(text, out)
}

/// Grayed text in a row (paths, containers): WS `ColoredListCellRenderer` paints every fragment
/// of a selected row in the selection foreground.
pub fn dim_fg(selected: bool) -> Rgba {
    if selected {
        look::SELECTION_TEXT.rgba()
    } else {
        look::TEXT_DIM.rgba()
    }
}

/// A dimmed label (paths, shortcuts, counts).
pub fn dim(text: impl Into<SharedString>) -> Div {
    div()
        .flex_none()
        .text_color(look::TEXT_DIM)
        .whitespace_nowrap()
        .child(text.into())
}

/// Color as GPUI's text color.
pub fn color(rgb: u32) -> Rgba {
    look::hex(rgb & 0xffffff)
}

/// A file path relative to the project when it's inside it, else with `~` for the home dir.
pub fn display_path(project: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(project) {
        return rel.to_string_lossy().into_owned();
    }
    crate::shell::display_path(path)
}

/// The absolute path of a picker candidate ([`display_path`]'s inverse).
pub fn absolute(project: &Path, shown: &str) -> PathBuf {
    let home = crate::shell::home();
    if let Some(rest) = shown.strip_prefix("~/")
        && !home.as_os_str().is_empty()
    {
        return home.join(rest);
    }
    let p = Path::new(shown);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        project.join(p)
    }
}

/// Splits a path into (dir, name) at its last `/` (dir without the slash, "" at the top).
pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

/// An empty-list message ("Nothing found") centred in the list area.
pub fn empty_message(text: impl Into<SharedString>) -> AnyElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .text_color(look::TEXT_DIM)
        .child(text.into())
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip() {
        let project = Path::new("/p/proj");
        assert_eq!(
            display_path(project, Path::new("/p/proj/src/a.ts")),
            "src/a.ts"
        );
        assert_eq!(
            absolute(project, "src/a.ts"),
            PathBuf::from("/p/proj/src/a.ts")
        );
        assert_eq!(absolute(project, "/x/y.ts"), PathBuf::from("/x/y.ts"));
        assert_eq!(split_path("src/a/b.ts"), ("src/a", "b.ts"));
        assert_eq!(split_path("b.ts"), ("", "b.ts"));
    }
}

#[cfg(test)]
mod ranged_tests {
    use super::*;
    use gpui_kit::FontWeight;

    #[test]
    fn overlapping_ranges_layer() {
        let color = HighlightStyle {
            color: Some(look::hsla(look::TEXT_DIM.rgba())),
            ..Default::default()
        };
        let bold = HighlightStyle {
            font_weight: Some(FontWeight::BOLD),
            ..Default::default()
        };
        // just checks it builds sorted, non-overlapping runs without panicking
        let _ = ranged("abcdef", [(0..4, color), (2..6, bold), (9..12, bold)]);
    }
}
