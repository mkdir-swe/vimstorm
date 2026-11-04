//! The bridge's text fields drawn: the caret where the frame's `caret` says (characters
//! from the start, as `ui/src/runtime/field.ts` counts them; absent: at the text's end). The bridge owns
//! the text and the caret and takes the keys; these only draw.

use gpui_kit::{
    AnyElement, Div, IntoElement, ParentElement as _, SharedString, Styled as _, div,
    prelude::FluentBuilder as _,
};

/// The byte index of the caret in `text`: `caret` characters in, the end when absent or past it.
pub fn caret_byte(text: &str, caret: Option<usize>) -> usize {
    caret
        .and_then(|n| text.char_indices().nth(n).map(|(i, _)| i))
        .unwrap_or(text.len())
}

/// `text` before and after its caret.
pub fn split(text: &str, caret: Option<usize>) -> (&str, &str) {
    text.split_at(caret_byte(text, caret))
}

/// One line of text with `caret_el` at its caret (none: no caret drawn), scrolled sideways so the
/// caret stays in view: the text after the caret gives way first, then the start before it.
pub fn caret_line(text: &str, caret: Option<usize>, caret_el: Option<Div>) -> AnyElement {
    let (before, after) = split(text, caret);
    div()
        .min_w_0()
        .overflow_hidden()
        .flex()
        .items_center()
        .whitespace_nowrap()
        .child(
            // clipped at its left: the end of the text before the caret stays
            div()
                .flex_shrink(1.)
                .min_w_0()
                .overflow_hidden()
                .flex()
                .justify_end()
                .child(
                    div()
                        .flex_none()
                        .child(SharedString::from(before.to_owned())),
                ),
        )
        .children(caret_el)
        .when(!after.is_empty(), |d| {
            // clipped at its right, and first: it gives way before the text before the caret
            d.child(
                div().flex_shrink(1000.).min_w_0().overflow_hidden().child(
                    div()
                        .flex_none()
                        .child(SharedString::from(after.to_owned())),
                ),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caret_counts_characters_and_absent_is_the_end() {
        assert_eq!(split("abc", None), ("abc", ""));
        assert_eq!(split("abc", Some(1)), ("a", "bc"));
        assert_eq!(split("abc", Some(9)), ("abc", ""));
        // characters, not bytes: å and an emoji are one step each
        assert_eq!(split("åb😀c", Some(1)), ("å", "b😀c"));
        assert_eq!(split("åb😀c", Some(3)), ("åb😀", "c"));
        assert_eq!(caret_byte("åb", Some(1)), 2);
    }
}
