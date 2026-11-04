//! Text measuring and wording shared by the surfaces.

use gpui_kit::{Font, Pixels, TextRun, Window, WindowTextSystem, px};

/// A one-line text's drawn width in `font` at `size` (layouts that size a box to its text).
pub fn width(window: &Window, text: &str, font: Font, size: Pixels) -> Pixels {
    width_in(window.text_system(), text, font, size)
}

/// [`width`] with a text system of its own: where a layout is built with no window at hand
/// (`WindowTextSystem::new(cx.text_system().clone())`).
pub fn width_in(text_system: &WindowTextSystem, text: &str, font: Font, size: Pixels) -> Pixels {
    if text.is_empty() {
        return px(0.);
    }
    let run = TextRun {
        len: text.len(),
        font,
        // (the color doesn't change the width)
        color: gpui_kit::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    text_system.layout_line(text, size, &[run], None).width
}

/// `text` broken into lines no wider than `max` at word boundaries (a word wider than `max`
/// keeps a line of its own); `measure` gives a candidate line's width.
pub fn wrap_with(text: &str, max: Pixels, measure: impl Fn(&str) -> Pixels) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let candidate = if line.is_empty() {
            word.to_owned()
        } else {
            format!("{line} {word}")
        };
        if line.is_empty() || measure(&candidate) <= max {
            line = candidate;
        } else {
            lines.push(std::mem::take(&mut line));
            line = word.to_owned();
        }
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines
}

/// "1 file", "2 files": `n` and `word`, plural with an `s` unless `n` is 1.
pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    #[test]
    fn plural() {
        assert_eq!(super::plural(1, "file"), "1 file");
        assert_eq!(super::plural(0, "file"), "0 files");
        assert_eq!(super::plural(3, "change"), "3 changes");
    }

    #[test]
    fn wrap_breaks_at_words() {
        // one pixel per char
        let w = |s: &str| gpui_kit::px(s.chars().count() as f32);
        let wrap = |t: &str, max: f32| super::wrap_with(t, gpui_kit::px(max), w);
        assert_eq!(wrap("Delete the branch?", 40.), ["Delete the branch?"]);
        assert_eq!(
            wrap("Delete the branch now?", 10.),
            ["Delete the", "branch", "now?"]
        );
        assert_eq!(wrap("a verylongword b", 4.), ["a", "verylongword", "b"]);
        assert_eq!(wrap("", 10.), [""]);
    }
}
