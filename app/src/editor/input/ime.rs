//! Text input through AppKit's input context: committed text -> `nvim_input`, marked text
//! (dead keys, IME composition) kept as a preedit for the renderer.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::{App, Bounds, InputHandler, Pixels, Point, UTF16Selection, Window};

use super::Action;

/// Receives what the IME produced; also called with no actions when only the preedit changed.
pub type Sink = Rc<dyn Fn(Vec<Action>, &mut Window, &mut App)>;

/// IME state shared by the view and the per-frame [`ImeHandler`]. The "document" AppKit sees is
/// only the preedit: nvim owns the real text.
#[derive(Debug, Default)]
pub struct Ime {
    marked: String,
    /// Selection inside the preedit (UTF-16) as the IME set it.
    selected: Option<Range<usize>>,
    caret: Option<Bounds<Pixels>>,
}

impl Ime {
    pub fn new() -> Self {
        Self::default()
    }

    /// The preedit to draw at the caret (e.g. a pending dead key `¨`).
    pub fn marked_text(&self) -> Option<&str> {
        (!self.marked.is_empty()).then_some(self.marked.as_str())
    }

    /// The caret cell in window coordinates: where the IME candidate window goes.
    pub fn set_caret_bounds(&mut self, bounds: Bounds<Pixels>) {
        self.caret = Some(bounds);
    }

    /// Drop the preedit (focus lost), like Ghostty.
    pub fn clear(&mut self) {
        self.marked.clear();
        self.selected = None;
    }

    fn commit(&mut self, text: &str) -> Vec<Action> {
        self.clear();
        text_input(text).into_iter().collect()
    }

    fn mark(&mut self, text: &str, selected: Option<Range<usize>>) {
        self.marked = text.to_string();
        self.selected = selected;
    }

    fn marked_range(&self) -> Option<Range<usize>> {
        self.marked_text().map(|m| 0..utf16_len(m))
    }

    fn selected_range(&self) -> UTF16Selection {
        let end = utf16_len(&self.marked);
        let range = self
            .selected
            .clone()
            .filter(|r| r.end <= end)
            .unwrap_or(end..end);
        UTF16Selection {
            range,
            reversed: false,
        }
    }

    fn text_for_range(&self, range: Range<usize>, adjusted: &mut Option<Range<usize>>) -> String {
        let units: Vec<u16> = self.marked.encode_utf16().collect();
        let range = range.start.min(units.len())..range.end.min(units.len());
        *adjusted = Some(range.clone());
        String::from_utf16_lossy(&units[range])
    }
}

/// Committed text as `nvim_input` keys: `<` escaped, line breaks as `<CR>`.
pub(super) fn text_input(text: &str) -> Option<Action> {
    let mut keys = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '<' => keys.push_str("<lt>"),
            '\n' | '\r' => keys.push_str("<CR>"),
            '\t' => keys.push_str("<Tab>"),
            _ => keys.push(ch),
        }
    }
    (!keys.is_empty()).then_some(Action::Input(keys))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// GPUI's platform input handler; build one per frame in paint for `window.handle_input`.
pub struct ImeHandler {
    ime: Rc<RefCell<Ime>>,
    sink: Sink,
}

impl ImeHandler {
    pub fn new(ime: Rc<RefCell<Ime>>, sink: Sink) -> Self {
        Self { ime, sink }
    }

    fn send(&self, actions: Vec<Action>, window: &mut Window, cx: &mut App) {
        (self.sink)(actions, window, cx);
    }
}

impl InputHandler for ImeHandler {
    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut App,
    ) -> Option<UTF16Selection> {
        Some(self.ime.borrow().selected_range())
    }

    fn marked_text_range(&mut self, _: &mut Window, _: &mut App) -> Option<Range<usize>> {
        self.ime.borrow().marked_range()
    }

    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<String> {
        Some(
            self.ime
                .borrow()
                .text_for_range(range_utf16, adjusted_range),
        )
    }

    /// insertText: the whole committed text (it replaces the preedit), so the range is moot.
    fn replace_text_in_range(
        &mut self,
        _replacement_range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        let actions = self.ime.borrow_mut().commit(text);
        self.send(actions, window, cx);
    }

    /// setMarkedText: a new preedit (empty = composition cancelled).
    fn replace_and_mark_text_in_range(
        &mut self,
        _range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.ime.borrow_mut().mark(new_text, new_selected_range);
        self.send(Vec::new(), window, cx);
    }

    /// unmarkText: AppKit lets the client dispose of the preedit; Ghostty drops it, so do we.
    fn unmark_text(&mut self, window: &mut Window, cx: &mut App) {
        self.ime.borrow_mut().clear();
        self.send(Vec::new(), window, cx);
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<Bounds<Pixels>> {
        self.ime.borrow().caret
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _: &mut Window,
        _: &mut App,
    ) -> Option<usize> {
        None
    }

    /// Holding a key repeats it (Vim motions) instead of opening the accent popup.
    fn apple_press_and_hold_enabled(&mut self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (preedit before, text AppKit commits, the input nvim gets; None: nothing sent)
    const COMMITS: &[(Option<&str>, &str, Option<&str>)] = &[
        (None, "a", Some("a")),
        (None, "<", Some("<lt>")),
        (None, "a<b>", Some("a<lt>b>")),
        (None, "å ä ö", Some("å ä ö")),
        (None, "!\"#¤%&/()=", Some("!\"#¤%&/()=")),
        (None, "@£$[]{}|\\~", Some("@£$[]{}|\\~")),
        (None, "x\ny", Some("x<CR>y")),
        (None, "", None),
        // Swedish ¨ then u: the next key commits ü once
        (Some("¨"), "ü", Some("ü")),
        // a dead key then a key it does not compose with: both chars
        (Some("´"), "´x", Some("´x")),
        // a dead key then space: the accent alone
        (Some("^"), "^", Some("^")),
        (Some("にほ😀"), "日本😀", Some("日本😀")),
    ];

    #[test]
    fn committed_text_is_escaped_and_ends_the_preedit() {
        for &(preedit, text, want) in COMMITS {
            let mut ime = Ime::new();
            if let Some(p) = preedit {
                ime.mark(p, None);
            }
            let want: Vec<Action> = want.map(|w| Action::Input(w.into())).into_iter().collect();
            assert_eq!(ime.commit(text), want, "{text:?}");
            assert_eq!(ime.marked_text(), None, "{text:?}");
            assert_eq!(ime.marked_range(), None, "{text:?}");
        }
    }

    /// (preedit, its selection, marked range, selected range, a range asked for, its text,
    /// the range adjusted to). Ranges are UTF-16.
    type Preedit = (
        &'static str,
        Range<usize>,
        Range<usize>,
        Range<usize>,
        Range<usize>,
        &'static str,
        Option<Range<usize>>,
    );

    const PREEDITS: &[Preedit] = &[
        ("¨", 1..1, 0..1, 1..1, 0..5, "¨", Some(0..1)),
        ("にほ😀", 1..2, 0..4, 1..2, 2..4, "😀", None),
    ];

    #[test]
    fn a_preedit_reports_its_ranges_in_utf16() {
        for (text, selected, marked, want_selected, asked, want_text, want_adjusted) in PREEDITS {
            let mut ime = Ime::new();
            ime.mark(text, Some(selected.clone()));
            assert_eq!(ime.marked_text(), Some(*text));
            assert_eq!(ime.marked_range(), Some(marked.clone()), "{text}");
            assert_eq!(ime.selected_range().range, *want_selected, "{text}");
            let mut adjusted = None;
            assert_eq!(ime.text_for_range(asked.clone(), &mut adjusted), *want_text);
            if want_adjusted.is_some() {
                assert_eq!(adjusted, *want_adjusted, "{text}");
            }
        }
    }

    #[test]
    fn an_empty_preedit_or_clear_drops_it_and_the_caret_is_kept_for_the_candidates() {
        let mut ime = Ime::new();
        // Option+¨ is the dead ~ on the Swedish layout
        ime.mark("~", None);
        assert_eq!(ime.marked_text(), Some("~"));
        ime.mark("", None);
        assert_eq!(ime.marked_text(), None);
        ime.mark("~", None);
        ime.clear();
        assert_eq!(ime.marked_text(), None);
        assert_eq!(ime.caret, None);
        let caret = Bounds::new(
            gpui_kit::point(gpui_kit::px(10.), gpui_kit::px(20.)),
            gpui_kit::size(gpui_kit::px(8.), gpui_kit::px(22.)),
        );
        ime.set_caret_bounds(caret);
        assert_eq!(ime.caret, Some(caret));
    }
}
