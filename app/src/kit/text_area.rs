//! Multi-line text area (the commit message of Local Changes): Inter 13, soft wrap at the area's
//! width, steady caret, multi-line selection, IME (Swedish dead keys compose), clipboard (newlines
//! kept), macOS word / line moves, undo / redo, placeholder, vertical scroll (wheel / trackpad; the
//! caret is kept in view), mouse selection (drag, Shift+click, double-click word, triple-click
//! line), I-beam cursor.
//!
//! Keys: Enter / Shift+Enter insert a newline. Arrows, Alt+arrows (words), Cmd+Left / Right (visual
//! line start / end), Cmd+Up / Down (text start / end), Home / End, PageUp / PageDown, with Shift
//! to select; Backspace / Delete (Alt: a word, Cmd: to the visual line start), Ctrl+H / W / U like
//! [`super::field::TextField`]; Cmd+A / C / X / V, Cmd+Z / Cmd+Shift+Z. Everything else (Cmd+Enter,
//! Esc, Tab, ...) propagates to the parent, which reacts to it (Cmd+Enter commits). Content changes
//! are [`TextAreaEvent::Changed`].
//!
//! Layout: each paragraph (text between newlines) is shaped and wrapped by GPUI's text system; the
//! wrapped rows ("visual rows") drive caret placement, vertical moves and hit testing. Shaping is
//! cached per text version / width / IME state, so a long message only re-shapes when it changes.
//!
//! The input handler / text element follow GPUI's `examples/input.rs` (Apache-2.0), like the field.

use std::ops::Range;
use std::rc::Rc;

use gpui_kit::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId,
    InspectorElementId, InteractiveElement, IntoElement, KeyDownEvent, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, ParentElement, Pixels, Point, Render,
    ScrollWheelEvent, ShapedLine, SharedString, Style, Styled, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, Window, WrappedLine, div, fill, font, point, prelude::FluentBuilder as _, px,
    relative, size,
};

use super::keys;

use crate::look;

/// Width a selected newline shows at a paragraph's end (approx: a space's width at 13 px).
const NEWLINE_SELECTION_W: f32 = 4.0;
/// Undo steps kept.
const MAX_UNDO: usize = 1000;

/// Font and colors: a UI text field's ([`TextAreaStyle::field`], default) or WS's commit
/// message editor's ([`TextAreaStyle::commit_message`]: the editor font and scheme colors).
#[derive(Clone, Copy, Debug, PartialEq)]
/// Colors and font are palette tokens and font names, read when drawn, so a look reaches an area
/// already open.
pub struct TextAreaStyle {
    pub font: crate::render::FontName,
    pub fg: look::Tok,
    pub bg: look::Tok,
    pub border: look::Tok,
    pub placeholder: look::Tok,
    /// Row pitch, whole px so rows stay crisp.
    pub line_height: f32,
    /// Text inset from the frame, left / right and top / bottom.
    pub pad_x: f32,
    pub pad_y: f32,
}

impl TextAreaStyle {
    pub fn field() -> Self {
        Self {
            font: crate::render::UI_FONT,
            fg: look::TEXT,
            bg: look::FIELD_BG,
            border: look::FIELD_BORDER,
            placeholder: look::PLACEHOLDER,
            line_height: look::TEXT_AREA_LINE_HEIGHT,
            pad_x: look::TEXT_AREA_PAD_X,
            pad_y: look::TEXT_AREA_PAD_Y,
        }
    }

    /// CommitMessage: an editor (setFontInheritedFromLAF(false) -> JetBrains Mono), scheme colors.
    pub fn commit_message() -> Self {
        Self {
            font: crate::render::EDITOR_FONT,
            fg: look::COMMIT_MESSAGE_FG,
            bg: look::COMMIT_MESSAGE_BG,
            border: look::COMMIT_MESSAGE_BORDER,
            placeholder: look::COMMIT_MESSAGE_PLACEHOLDER,
            line_height: look::COMMIT_MESSAGE_LINE_HEIGHT,
            pad_x: look::COMMIT_MESSAGE_PAD_X,
            pad_y: look::COMMIT_MESSAGE_PAD_Y,
        }
    }
}

/// What the area tells its parent.
#[derive(Clone, Debug, PartialEq)]
pub enum TextAreaEvent {
    /// The text changed (typing, paste, cut, undo / redo, IME commit).
    Changed,
}

/// A multi-line text input.
pub struct TextArea {
    focus: FocusHandle,
    text: String,
    placeholder: SharedString,
    bordered: bool,
    style: TextAreaStyle,
    /// Byte range; empty = caret.
    selected: Range<usize>,
    /// The caret is at `selected.start` (selection made leftwards / upwards).
    reversed: bool,
    /// The caret at a wrap point shows at the end of the upper row (after Cmd+Right / a click past
    /// a row's end), not at the start of the next one.
    upstream: bool,
    /// IME composition (dead key / marked text).
    marked: Option<Range<usize>>,
    /// Where a composition started: the text it replaced and the selection before it (one undo
    /// step per committed composition).
    compose: Option<(usize, String, Range<usize>)>,
    /// Up / Down keep this x (a row's caret x when the vertical moves began).
    goal_x: Option<Pixels>,
    scroll_y: Pixels,
    /// Scroll the caret into view at the next paint (after edits / moves, not after wheel scrolls).
    scroll_to_caret: bool,
    /// Bumped on every text change: the layout cache key.
    version: u64,
    layout: Option<Rc<Layout>>,
    /// The text box's width / height and bounds at the last paint.
    wrap_width: Option<Pixels>,
    view_height: Pixels,
    last_bounds: Option<Bounds<Pixels>>,
    selecting: bool,
    history: History,
    /// Grows with its text between these heights (px, padding included), then scrolls; None:
    /// fills its parent ([`TextArea::grow`]).
    grow: Option<(f32, f32)>,
}

impl EventEmitter<TextAreaEvent> for TextArea {}

impl Focusable for TextArea {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextArea {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            text: String::new(),
            placeholder: SharedString::default(),
            bordered: true,
            style: TextAreaStyle::field(),
            selected: 0..0,
            reversed: false,
            upstream: false,
            marked: None,
            compose: None,
            goal_x: None,
            scroll_y: px(0.),
            scroll_to_caret: false,
            version: 0,
            layout: None,
            wrap_width: None,
            view_height: px(0.),
            last_bounds: None,
            selecting: false,
            history: History::default(),
            grow: None,
        }
    }

    /// No frame of its own: its host draws the field around it (Chat's composer).
    pub fn borderless(mut self) -> Self {
        self.bordered = false;
        self
    }

    /// As tall as its wrapped text, `min` px at the least and `max` at most (padding
    /// included), then it scrolls with the caret kept in view; the host may change `max` as its
    /// room changes.
    pub fn set_grow(&mut self, min: f32, max: f32, cx: &mut Context<Self>) {
        let grow = Some((min, max.max(min)));
        if self.grow != grow {
            self.grow = grow;
            self.scroll_to_caret = true;
            cx.notify();
        }
    }

    /// The text dimmed while it is empty.
    pub fn set_placeholder(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        let text = text.into();
        if self.placeholder != text {
            self.placeholder = text;
            cx.notify();
        }
    }

    /// An IME composition is under way (a dead key's mark): its keys are AppKit's.
    pub fn composing(&self) -> bool {
        self.marked.is_some()
    }

    /// The height it wants while it grows: its wrapped rows (before its first paint, its lines)
    /// and its padding, between its bounds.
    fn grown_height(&mut self, window: &mut Window) -> Option<Pixels> {
        let (min, max) = self.grow?;
        let rows = match self.ensure_layout(window) {
            Some(l) => l.rows.len().max(1),
            None => self.text.split('\n').count().max(1),
        };
        let want = rows as f32 * self.style.line_height + 2. * self.style.pad_y;
        Some(px(want.clamp(min, max)))
    }

    /// Text shown (dimmed) while the area is empty ("Commit Message").
    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// Font and colors (default [`TextAreaStyle::field`]).
    pub fn style(mut self, style: TextAreaStyle) -> Self {
        self.style = style;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Replaces the text, caret at the end, undo history cleared (no [`TextAreaEvent::Changed`]:
    /// the caller knows).
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.text = text.into().replace("\r\n", "\n").replace('\r', "\n");
        self.selected = self.text.len()..self.text.len();
        self.reversed = false;
        self.upstream = false;
        self.marked = None;
        self.compose = None;
        self.goal_x = None;
        self.history = History::default();
        self.version += 1;
        self.scroll_to_caret = true;
        cx.notify();
    }

    /// The caret at byte `offset` (kept within the text, on a character), nothing selected.
    pub fn set_cursor(&mut self, offset: usize, cx: &mut Context<Self>) {
        let mut at = offset.min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        self.move_to(at, false, cx);
    }

    /// Selected byte range (empty = the caret's position).
    pub fn selection(&self) -> Range<usize> {
        self.selected.clone()
    }

    /// Caret byte offset.
    pub fn cursor(&self) -> usize {
        if self.reversed {
            self.selected.start
        } else {
            self.selected.end
        }
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selected = 0..self.text.len();
        self.reversed = false;
        self.upstream = false;
        self.history.seal();
        cx.notify();
    }

    /// `text` typed over the selection (keys typed before the area had the keyboard).
    pub fn insert(&mut self, text: &str, cx: &mut Context<Self>) {
        let sel = self.selected.clone();
        self.edit(sel, text, EditKind::Typing, cx);
    }

    // ------------------------------------------------------------ layout

    /// The wrapped layout of the current text (shaped again only when the text, width or IME
    /// state changed). None before the first paint (the width is unknown).
    fn ensure_layout(&mut self, window: &mut Window) -> Option<Rc<Layout>> {
        let width = self.wrap_width?;
        if let Some(l) = &self.layout
            && l.version == self.version
            && l.width == width
            && l.marked == self.marked
        {
            return Some(l.clone());
        }
        let l = Rc::new(Layout::shape(
            &self.text,
            width,
            self.marked.clone(),
            self.version,
            self.style,
            window,
        ));
        self.layout = Some(l.clone());
        Some(l)
    }

    // ------------------------------------------------------------ caret / selection

    fn move_to(&mut self, offset: usize, upstream: bool, cx: &mut Context<Self>) {
        self.selected = offset..offset;
        self.reversed = false;
        self.upstream = upstream;
        self.goal_x = None;
        self.scroll_to_caret = true;
        self.history.seal();
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, upstream: bool, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        self.upstream = upstream;
        self.goal_x = None;
        self.scroll_to_caret = true;
        self.history.seal();
        cx.notify();
    }

    fn go(&mut self, offset: usize, upstream: bool, extend: bool, cx: &mut Context<Self>) {
        if extend {
            self.select_to(offset, upstream, cx)
        } else {
            self.move_to(offset, upstream, cx)
        }
    }

    /// Up / Down by `by` visual rows, keeping the goal x; past the first / last row: the text's
    /// start / end (macOS).
    fn vertical(&mut self, by: isize, extend: bool, window: &mut Window, cx: &mut Context<Self>) {
        let c = self.cursor();
        let Some(l) = self.ensure_layout(window) else {
            // not laid out yet: the text's ends
            return self.go(if by < 0 { 0 } else { self.text.len() }, false, extend, cx);
        };
        let row = l.row_at(c, self.upstream);
        let goal = self.goal_x.unwrap_or_else(|| l.x_of(c, row));
        let target = row as isize + by;
        let (offset, upstream) = if target < 0 {
            (0, false)
        } else if target as usize >= l.rows.len() {
            (self.text.len(), false)
        } else {
            l.index_at(target as usize, goal)
        };
        self.go(offset, upstream, extend, cx);
        self.goal_x = Some(goal);
    }

    /// The caret's visual row: (start, end, end is a wrap point). Without a layout: its paragraph.
    fn row_span(&mut self, window: &mut Window) -> (usize, usize, bool) {
        let c = self.cursor();
        match self.ensure_layout(window) {
            Some(l) => {
                let row = l.row_at(c, self.upstream);
                let r = l.rows[row];
                (r.start, r.end, !l.ends_paragraph(row))
            }
            None => (line_start(&self.text, c), line_end(&self.text, c), false),
        }
    }

    // ------------------------------------------------------------ edits

    /// Replaces `range` with `new` (one undo step, coalesced by `kind`), caret after it.
    fn edit(&mut self, range: Range<usize>, new: &str, kind: EditKind, cx: &mut Context<Self>) {
        let old = self.text[range.clone()].to_string();
        if old.is_empty() && new.is_empty() {
            return;
        }
        self.history.record(Edit {
            at: range.start,
            old,
            new: new.to_string(),
            sel_before: self.selected.clone(),
            kind,
        });
        self.text.replace_range(range.clone(), new);
        let end = range.start + new.len();
        self.selected = end..end;
        self.reversed = false;
        self.upstream = false;
        self.changed(cx);
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.version += 1;
        self.marked = None;
        self.compose = None;
        self.goal_x = None;
        self.scroll_to_caret = true;
        cx.emit(TextAreaEvent::Changed);
        cx.notify();
    }

    /// Deletes the selection, or from the caret to `to` when nothing is selected.
    fn delete_to(&mut self, to: usize, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            let c = self.cursor();
            if c != to {
                self.edit(c.min(to)..c.max(to), "", EditKind::Delete, cx);
            }
        } else {
            self.edit(self.selected.clone(), "", EditKind::Other, cx);
        }
    }

    fn undo(&mut self, cx: &mut Context<Self>) {
        let Some(e) = self.history.undo() else { return };
        self.text.replace_range(e.at..e.at + e.new.len(), &e.old);
        let len = self.text.len();
        self.selected = e.sel_before.start.min(len)..e.sel_before.end.min(len);
        self.reversed = false;
        self.upstream = false;
        self.changed(cx);
    }

    fn redo(&mut self, cx: &mut Context<Self>) {
        let Some(e) = self.history.redo() else { return };
        self.text.replace_range(e.at..e.at + e.old.len(), &e.new);
        let end = e.at + e.new.len();
        self.selected = end..end;
        self.reversed = false;
        self.upstream = false;
        self.changed(cx);
    }

    fn prev_char(&self, offset: usize) -> usize {
        self.text[..offset]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next_char(&self, offset: usize) -> usize {
        self.text[offset..]
            .chars()
            .next()
            .map_or(offset, |c| offset + c.len_utf8())
    }

    /// A key in nvim notation; true when the area used it.
    pub fn key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let c = self.cursor();
        let len = self.text.len();
        let sel = self.selected.clone();
        match key {
            "<CR>" | "<S-CR>" => self.edit(sel, "\n", EditKind::Other, cx),
            "<Left>" if !sel.is_empty() => self.move_to(sel.start, false, cx),
            "<Right>" if !sel.is_empty() => self.move_to(sel.end, false, cx),
            "<Left>" => self.move_to(self.prev_char(c), false, cx),
            "<Right>" => self.move_to(self.next_char(c), false, cx),
            "<S-Left>" => self.select_to(self.prev_char(c), false, cx),
            "<S-Right>" => self.select_to(self.next_char(c), false, cx),
            "<M-Left>" => self.move_to(prev_word(&self.text, c), false, cx),
            "<M-Right>" => self.move_to(next_word(&self.text, c), false, cx),
            "<M-S-Left>" => self.select_to(prev_word(&self.text, c), false, cx),
            "<M-S-Right>" => self.select_to(next_word(&self.text, c), false, cx),
            "<Up>" => self.vertical(-1, false, window, cx),
            "<Down>" => self.vertical(1, false, window, cx),
            "<S-Up>" => self.vertical(-1, true, window, cx),
            "<S-Down>" => self.vertical(1, true, window, cx),
            "<PageUp>" | "<PageDown>" | "<S-PageUp>" | "<S-PageDown>" => {
                let rows =
                    ((self.view_height / px(self.style.line_height)).floor() as isize - 1).max(1);
                let by = if key.contains("Up") { -rows } else { rows };
                self.vertical(by, key.starts_with("<S-"), window, cx);
            }
            "<D-Up>" => self.move_to(0, false, cx),
            "<D-Down>" => self.move_to(len, false, cx),
            "<D-S-Up>" => self.select_to(0, false, cx),
            "<D-S-Down>" => self.select_to(len, false, cx),
            "<D-Left>" | "<Home>" | "<D-S-Left>" | "<S-Home>" => {
                let (start, _, _) = self.row_span(window);
                self.go(start, false, key.contains("S-"), cx);
            }
            "<D-Right>" | "<End>" | "<D-S-Right>" | "<S-End>" => {
                let (_, end, wrap) = self.row_span(window);
                self.go(end, wrap, key.contains("S-"), cx);
            }
            // insert-mode keys, as in the field: Ctrl+H backspace, Ctrl+W the word before,
            // Ctrl+U to the line start
            "<BS>" | "<C-h>" => self.delete_to(self.prev_char(c), cx),
            "<C-w>" | "<M-BS>" => self.delete_to(prev_word(&self.text, c), cx),
            "<C-u>" => self.delete_to(line_start(&self.text, c), cx),
            "<Del>" => self.delete_to(self.next_char(c), cx),
            "<M-Del>" => self.delete_to(next_word(&self.text, c), cx),
            "<D-BS>" => {
                let (start, _, _) = self.row_span(window);
                // at a row's start already: the newline before it (TextEdit)
                let to = if start == c { self.prev_char(c) } else { start };
                self.delete_to(to, cx);
            }
            "<D-a>" => self.select_all(cx),
            "<D-c>" | "<D-x>" => {
                if !sel.is_empty() {
                    let text = self.text[sel.clone()].to_string();
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    if key == "<D-x>" {
                        self.edit(sel, "", EditKind::Other, cx);
                    }
                }
            }
            "<D-v>" => {
                if let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) {
                    let text = text.replace("\r\n", "\n").replace('\r', "\n");
                    self.edit(sel, &text, EditKind::Other, cx);
                }
            }
            "<D-z>" => self.undo(cx),
            "<D-S-z>" | "<D-Z>" | "<D-S-Z>" => self.redo(cx),
            _ => return false,
        }
        true
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // a composition in progress gets every key (AppKit commits / cancels it)
        if self.marked.is_some() {
            return;
        }
        if let Some(key) = keys::notation(event)
            && self.key(&key, window, cx)
        {
            cx.stop_propagation();
        }
    }

    // ------------------------------------------------------------ mouse

    /// Text offset under a window point (rows clamp: above the text = the first row, below = the
    /// last) and whether it's at a wrapped row's end.
    fn index_for_point(&mut self, p: Point<Pixels>, window: &mut Window) -> Option<(usize, bool)> {
        let bounds = self.last_bounds?;
        let l = self.ensure_layout(window)?;
        let y = p.y - bounds.top() + self.scroll_y;
        let row = ((y / l.line_h).floor().max(0.) as usize).min(l.rows.len() - 1);
        Some(l.index_at(row, p.x - bounds.left()))
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some((at, upstream)) = self.index_for_point(ev.position, window) else {
            return;
        };
        match ev.click_count {
            2 => {
                self.selected = word_at(&self.text, at);
                self.reversed = false;
                self.history.seal();
                cx.notify();
            }
            n if n >= 3 => {
                self.selected = line_start(&self.text, at)..line_end(&self.text, at);
                self.reversed = false;
                self.history.seal();
                cx.notify();
            }
            _ => {
                self.selecting = true;
                self.go(at, upstream, ev.modifiers.shift, cx);
            }
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.selecting
            && let Some((at, upstream)) = self.index_for_point(ev.position, window)
        {
            self.select_to(at, upstream, cx);
        }
    }

    fn on_scroll(&mut self, ev: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(l) = self.ensure_layout(window) else {
            return;
        };
        let max = (l.height() - self.view_height).max(px(0.));
        let y = (self.scroll_y - ev.delta.pixel_delta(l.line_h).y).clamp(px(0.), max);
        if y != self.scroll_y {
            self.scroll_y = y;
            self.scroll_to_caret = false;
            cx.stop_propagation();
            cx.notify();
        }
    }

    // ------------------------------------------------------------ IME offsets

    fn utf16_to_utf8(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        for (i, ch) in self.text.char_indices() {
            if utf16 >= offset {
                return i;
            }
            utf16 += ch.len_utf16();
        }
        self.text.len()
    }

    fn utf8_to_utf16(&self, offset: usize) -> usize {
        self.text[..offset].chars().map(char::len_utf16).sum()
    }

    fn range_to_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.utf8_to_utf16(r.start)..self.utf8_to_utf16(r.end)
    }

    fn range_from_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.utf16_to_utf8(r.start)..self.utf16_to_utf8(r.end)
    }
}

// ---------------------------------------------------------------- text helpers

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Start of the word before `offset` (macOS Alt+Left; newlines are word breaks).
fn prev_word(text: &str, offset: usize) -> usize {
    let before: Vec<(usize, char)> = text[..offset].char_indices().collect();
    let mut i = before.len();
    while i > 0 && !is_word(before[i - 1].1) {
        i -= 1;
    }
    while i > 0 && is_word(before[i - 1].1) {
        i -= 1;
    }
    before.get(i).map_or(offset, |(b, _)| *b)
}

/// End of the word after `offset` (macOS Alt+Right).
fn next_word(text: &str, offset: usize) -> usize {
    let mut it = text[offset..].char_indices().peekable();
    while it.peek().is_some_and(|(_, c)| !is_word(*c)) {
        it.next();
    }
    while it.peek().is_some_and(|(_, c)| is_word(*c)) {
        it.next();
    }
    it.peek().map_or(text.len(), |(i, _)| offset + i)
}

/// The word around `offset` (double-click).
fn word_at(text: &str, offset: usize) -> Range<usize> {
    let start = text[..offset]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(offset, |(i, _)| i);
    let end = text[offset..]
        .char_indices()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(offset, |(i, c)| offset + i + c.len_utf8());
    start..end
}

/// Start of the (logical) line `offset` is on.
fn line_start(text: &str, offset: usize) -> usize {
    text[..offset].rfind('\n').map_or(0, |i| i + 1)
}

/// End of the (logical) line `offset` is on (before its newline).
fn line_end(text: &str, offset: usize) -> usize {
    text[offset..].find('\n').map_or(text.len(), |i| offset + i)
}

// ---------------------------------------------------------------- undo

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EditKind {
    /// A typed char: runs of them are one step.
    Typing,
    /// Backspace / Delete with nothing selected: runs are one step.
    Delete,
    /// Paste, cut, newline, a deleted selection: a step each.
    Other,
}

/// `old` at `at` became `new`.
#[derive(Clone, Debug, PartialEq)]
struct Edit {
    at: usize,
    old: String,
    new: String,
    sel_before: Range<usize>,
    kind: EditKind,
}

#[derive(Default)]
struct History {
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    /// The next edit starts a new step (after a caret move, undo / redo).
    sealed: bool,
}

impl History {
    fn record(&mut self, e: Edit) {
        self.redo.clear();
        let merged = !self.sealed
            && self.undo.last_mut().is_some_and(|last| {
                if last.kind != e.kind {
                    return false;
                }
                match e.kind {
                    EditKind::Typing if e.old.is_empty() && last.at + last.new.len() == e.at => {
                        last.new.push_str(&e.new);
                        true
                    }
                    // Backspace run: each deletion ends where the last one began
                    EditKind::Delete if e.at + e.old.len() == last.at => {
                        last.old.insert_str(0, &e.old);
                        last.at = e.at;
                        true
                    }
                    // Delete (forward) run: same place
                    EditKind::Delete if e.at == last.at => {
                        last.old.push_str(&e.old);
                        true
                    }
                    _ => false,
                }
            });
        if !merged {
            self.undo.push(e);
            if self.undo.len() > MAX_UNDO {
                self.undo.remove(0);
            }
        }
        self.sealed = false;
    }

    fn seal(&mut self) {
        self.sealed = true;
    }

    fn undo(&mut self) -> Option<Edit> {
        let e = self.undo.pop()?;
        self.redo.push(e.clone());
        self.sealed = true;
        Some(e)
    }

    fn redo(&mut self) -> Option<Edit> {
        let e = self.redo.pop()?;
        self.undo.push(e.clone());
        self.sealed = true;
        Some(e)
    }
}

// ---------------------------------------------------------------- layout

/// One visual row: absolute byte range of its paragraph's text (`end` = the next row's start at a
/// wrap point, the paragraph's end otherwise).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RowSpan {
    para: usize,
    start: usize,
    end: usize,
}

/// A paragraph's rows from its wrap points (byte offsets relative to the paragraph).
fn rows_for(para: usize, start: usize, len: usize, wraps: &[usize]) -> Vec<RowSpan> {
    let mut rows = Vec::with_capacity(wraps.len() + 1);
    let mut s = start;
    for &w in wraps {
        rows.push(RowSpan {
            para,
            start: s,
            end: start + w,
        });
        s = start + w;
    }
    rows.push(RowSpan {
        para,
        start: s,
        end: start + len,
    });
    rows
}

/// The row an offset shows on: at a wrap point the lower row, unless `upstream`.
fn row_at(rows: &[RowSpan], offset: usize, upstream: bool) -> usize {
    let ix = rows
        .partition_point(|r| r.start <= offset)
        .saturating_sub(1);
    if upstream && ix > 0 && rows[ix].start == offset && rows[ix - 1].para == rows[ix].para {
        ix - 1
    } else {
        ix
    }
}

struct Para {
    start: usize,
    line: WrappedLine,
    first_row: usize,
}

/// The shaped, wrapped text.
struct Layout {
    version: u64,
    line_h: Pixels,
    width: Pixels,
    marked: Option<Range<usize>>,
    paras: Vec<Para>,
    rows: Vec<RowSpan>,
}

impl Layout {
    fn shape(
        text: &str,
        width: Pixels,
        marked: Option<Range<usize>>,
        version: u64,
        style: TextAreaStyle,
        window: &mut Window,
    ) -> Layout {
        let font = font(style.font);
        let font_size = px(look::UI_FONT_SIZE);
        let color = look::hsla(style.fg.rgba());
        let run = |len: usize, underline: bool| TextRun {
            len,
            font: font.clone(),
            color,
            background_color: None,
            underline: underline.then_some(UnderlineStyle {
                color: Some(color),
                thickness: px(1.),
                wavy: false,
            }),
            strikethrough: None,
        };
        let wrap = (width > px(0.)).then_some(width);
        let mut paras = Vec::new();
        let mut rows = Vec::new();
        let mut start = 0;
        for (ix, para) in text.split('\n').enumerate() {
            let end = start + para.len();
            // the IME's marked text underlined
            let runs: Vec<TextRun> = match marked.as_ref() {
                Some(m) if m.start < end && m.end > start => {
                    let a = m.start.clamp(start, end) - start;
                    let b = m.end.clamp(start, end) - start;
                    [run(a, false), run(b - a, true), run(para.len() - b, false)]
                        .into_iter()
                        .filter(|r| r.len > 0)
                        .collect()
                }
                _ => vec![run(para.len(), false)],
            };
            let line = window
                .text_system()
                .shape_text(
                    SharedString::from(para.to_string()),
                    font_size,
                    &runs,
                    wrap,
                    None,
                )
                .ok()
                .and_then(|mut lines| lines.pop())
                .unwrap_or_default();
            let wraps: Vec<usize> = line
                .wrap_boundaries()
                .iter()
                .filter_map(|b| Some(line.runs().get(b.run_ix)?.glyphs.get(b.glyph_ix)?.index))
                .collect();
            let first_row = rows.len();
            rows.extend(rows_for(ix, start, para.len(), &wraps));
            paras.push(Para {
                start,
                line,
                first_row,
            });
            start = end + 1;
        }
        Layout {
            version,
            line_h: px(style.line_height),
            width,
            marked,
            paras,
            rows,
        }
    }

    fn height(&self) -> Pixels {
        self.line_h * self.rows.len().max(1) as f32
    }

    fn row_at(&self, offset: usize, upstream: bool) -> usize {
        row_at(&self.rows, offset, upstream)
    }

    /// The row is its paragraph's last (its end is not a wrap point).
    fn ends_paragraph(&self, row: usize) -> bool {
        self.rows
            .get(row + 1)
            .is_none_or(|next| next.para != self.rows[row].para)
    }

    /// x of a row's start in its paragraph's unwrapped line.
    fn row_x0(&self, row: usize) -> Pixels {
        let r = self.rows[row];
        let p = &self.paras[r.para];
        p.line.unwrapped_layout.x_for_index(r.start - p.start)
    }

    /// x of `offset` on `row`, from the row's left edge.
    fn x_of(&self, offset: usize, row: usize) -> Pixels {
        let r = self.rows[row];
        let p = &self.paras[r.para];
        let off = offset.clamp(r.start, r.end) - p.start;
        p.line.unwrapped_layout.x_for_index(off) - self.row_x0(row)
    }

    /// The offset closest to `x` on `row`, and whether it's the row's wrapped end (upstream).
    fn index_at(&self, row: usize, x: Pixels) -> (usize, bool) {
        let r = self.rows[row];
        let p = &self.paras[r.para];
        let ul = &p.line.unwrapped_layout;
        let rel = ul.closest_index_for_x(x + self.row_x0(row));
        let offset = (p.start + rel).clamp(r.start, r.end);
        (offset, offset == r.end && !self.ends_paragraph(row))
    }
}

// ---------------------------------------------------------------- view

impl EntityInputHandler for TextArea {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range);
        adjusted.replace(self.range_to_utf16(&range));
        Some(self.text[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected),
            reversed: self.reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        self.compose = None;
        self.version += 1;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Enter / Tab typed as text ("\n", "\t"): Enter is the key handler's, Tab the parent's
        if text.chars().any(char::is_control) {
            return;
        }
        let range = range
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        let kind = if text.chars().count() == 1 {
            EditKind::Typing
        } else {
            EditKind::Other
        };
        match self.compose.take() {
            // a committed composition: one step from the text before it started
            Some((at, old, sel_before)) if at <= range.start => {
                self.text.replace_range(range.clone(), text);
                let end = range.start + text.len();
                self.history.record(Edit {
                    at,
                    old,
                    new: self.text[at..end].to_string(),
                    sel_before,
                    kind,
                });
                self.selected = end..end;
                self.reversed = false;
                self.upstream = false;
                self.changed(cx);
            }
            _ => self.edit(range, text, kind, cx),
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        new_selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        if self.compose.is_none() {
            self.compose = Some((
                range.start,
                self.text[range.clone()].to_string(),
                self.selected.clone(),
            ));
        }
        self.text.replace_range(range.clone(), text);
        self.marked = (!text.is_empty()).then(|| range.start..range.start + text.len());
        self.selected = new_selected
            .map(|r| {
                // relative to the marked text
                let marked = &self.text[range.start..range.start + text.len()];
                let to8 = |u16off: usize| {
                    let mut n = 0;
                    for (i, ch) in marked.char_indices() {
                        if n >= u16off {
                            return i;
                        }
                        n += ch.len_utf16();
                    }
                    marked.len()
                };
                range.start + to8(r.start)..range.start + to8(r.end)
            })
            .unwrap_or(range.start + text.len()..range.start + text.len());
        self.reversed = false;
        self.upstream = false;
        self.version += 1;
        self.scroll_to_caret = true;
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let l = self.ensure_layout(window)?;
        let range = self.range_from_utf16(&range);
        let row = l.row_at(range.start, false);
        let x0 = l.x_of(range.start, row);
        let x1 = if l.row_at(range.end, true) == row {
            l.x_of(range.end, row)
        } else {
            x0
        };
        let line_h = px(self.style.line_height);
        let top = bounds.top() + line_h * row as f32 - self.scroll_y;
        Some(Bounds::from_corners(
            point(bounds.left() + x0, top),
            point(bounds.left() + x1, top + line_h),
        ))
    }

    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let (ix, _) = self.index_for_point(p, window)?;
        Some(self.utf8_to_utf16(ix))
    }
}

impl Render for TextArea {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        // the 2 px focus ring (DarculaNewUIUtil focusWidth) grows inward: the padding gives the
        // extra px back so the text doesn't move
        let ring = if focused && self.bordered { 1. } else { 0. };
        let grown = self.grown_height(window);
        div()
            .id("text-area")
            .debug_selector(|| "text-area".into())
            .key_context("VimStormTextArea")
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            .map(|d| match grown {
                Some(h) => d.w_full().h(h).flex_none(),
                None => d.size_full(),
            })
            .flex()
            .flex_col()
            .px(px(self.style.pad_x - ring))
            .py(px(self.style.pad_y - ring))
            .font_family(self.style.font)
            .text_size(px(look::UI_FONT_SIZE))
            .line_height(px(self.style.line_height))
            .text_color(self.style.fg)
            .when(self.bordered, |d| {
                d.rounded(px(look::FIELD_ARC)).bg(self.style.bg).map(|d| {
                    if focused {
                        d.border_2().border_color(look::FOCUS_BORDER)
                    } else {
                        d.border_1().border_color(self.style.border)
                    }
                })
            })
            .child(
                div()
                    .flex_1()
                    .w_full()
                    .overflow_hidden()
                    .child(AreaText(cx.entity())),
            )
    }
}

/// The text box: placeholder / wrapped text, selection, caret; registers the IME handler.
struct AreaText(Entity<TextArea>);

struct Prepaint {
    layout: Option<Rc<Layout>>,
    placeholder: Option<ShapedLine>,
    selection: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
    scroll_y: Pixels,
}

impl IntoElement for AreaText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for AreaText {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let style = self.0.read(cx).style;
        let line_h = px(style.line_height);
        let (layout, empty, placeholder_text, sel, caret_at, scroll_y) =
            self.0.update(cx, |area, _| {
                area.wrap_width = Some(bounds.size.width);
                area.view_height = bounds.size.height;
                let layout = area.ensure_layout(window);
                let c = area.cursor();
                let caret_row = layout.as_ref().map(|l| l.row_at(c, area.upstream));
                // keep the caret in view after edits / moves; clamp to the text's height
                if let (Some(l), Some(row)) = (&layout, caret_row) {
                    if area.scroll_to_caret {
                        let top = line_h * row as f32;
                        if top < area.scroll_y {
                            area.scroll_y = top;
                        } else if top + line_h > area.scroll_y + bounds.size.height {
                            area.scroll_y = top + line_h - bounds.size.height;
                        }
                        area.scroll_to_caret = false;
                    }
                    let max = (l.height() - bounds.size.height).max(px(0.));
                    area.scroll_y = area.scroll_y.clamp(px(0.), max);
                }
                (
                    layout,
                    area.text.is_empty(),
                    area.placeholder.clone(),
                    area.selected.clone(),
                    caret_row.map(|r| (c, r)),
                    area.scroll_y,
                )
            });
        let row_top = |row: usize| bounds.top() + line_h * row as f32 - scroll_y;
        let mut selection = Vec::new();
        let mut caret = None;
        if let Some(l) = &layout {
            if !sel.is_empty() {
                let first = l.row_at(sel.start, false);
                let last = l.row_at(sel.end, true);
                for row in first..=last.min(l.rows.len() - 1) {
                    let r = l.rows[row];
                    let a = sel.start.max(r.start);
                    let b = sel.end.min(r.end);
                    let x0 = l.x_of(a, row);
                    let mut x1 = l.x_of(b, row);
                    // the selected newline at a paragraph's end
                    if sel.end > r.end && l.ends_paragraph(row) {
                        x1 += px(NEWLINE_SELECTION_W);
                    }
                    if x1 > x0 {
                        let top = row_top(row);
                        selection.push(fill(
                            Bounds::from_corners(
                                point(bounds.left() + x0, top),
                                point(bounds.left() + x1, top + line_h),
                            ),
                            look::FIELD_SELECTION_BG,
                        ));
                    }
                }
            } else if let Some((c, row)) = caret_at {
                caret = Some(fill(
                    Bounds::new(
                        point(bounds.left() + l.x_of(c, row), row_top(row)),
                        size(px(look::CARET_WIDTH), line_h),
                    ),
                    look::CARET,
                ));
            }
        }
        let placeholder = (empty && !placeholder_text.is_empty()).then(|| {
            let run = TextRun {
                len: placeholder_text.len(),
                font: font(style.font),
                color: look::hsla(style.placeholder.rgba()),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            window
                .text_system()
                .shape_line(placeholder_text, px(look::UI_FONT_SIZE), &[run], None)
        });
        Prepaint {
            layout,
            placeholder,
            selection,
            caret,
            scroll_y,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        pre: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.0.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.0.clone()), cx);
        let line_h = px(self.0.read(cx).style.line_height);
        window.with_content_mask(Some(gpui_kit::ContentMask { bounds }), |window| {
            for q in pre.selection.drain(..) {
                window.paint_quad(q);
            }
            if let Some(p) = &pre.placeholder {
                let _ = p.paint(bounds.origin, line_h, TextAlign::Left, None, window, cx);
            }
            if let Some(l) = &pre.layout {
                for (ix, para) in l.paras.iter().enumerate() {
                    let rows =
                        l.paras.get(ix + 1).map_or(l.rows.len(), |n| n.first_row) - para.first_row;
                    let top = bounds.top() + line_h * para.first_row as f32 - pre.scroll_y;
                    // only the paragraphs in view
                    if top > bounds.bottom() || top + line_h * (rows as f32) < bounds.top() {
                        continue;
                    }
                    let _ = para.line.paint(
                        point(bounds.left(), top),
                        line_h,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    );
                }
            }
            if focus.is_focused(window)
                && let Some(caret) = pre.caret.take()
            {
                window.paint_quad(caret);
            }
        });
        self.0.update(cx, |a, _| a.last_bounds = Some(bounds));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    use gpui_kit::{AppContext as _, Modifiers, TestAppContext, TestDispatcher, VisualTestContext};

    #[test]
    fn rows_split_at_wrap_points_and_caret_affinity() {
        // "aaa bbb ccc" wrapped after "aaa " and "bbb ", then a second paragraph "dd"
        let mut rows = rows_for(0, 0, 11, &[4, 8]);
        rows.extend(rows_for(1, 12, 2, &[]));
        assert_eq!(
            rows.iter().map(|r| (r.start, r.end)).collect::<Vec<_>>(),
            [(0, 4), (4, 8), (8, 11), (12, 14)]
        );
        assert_eq!(row_at(&rows, 0, false), 0);
        assert_eq!(row_at(&rows, 3, false), 0);
        // a wrap point: the next row's start, or the upper row's end
        assert_eq!(row_at(&rows, 4, false), 1);
        assert_eq!(row_at(&rows, 4, true), 0);
        // a paragraph's end stays on its row; upstream doesn't cross paragraphs
        assert_eq!(row_at(&rows, 11, false), 2);
        assert_eq!(row_at(&rows, 12, true), 3);
        assert_eq!(row_at(&rows, 14, false), 3);
        // empty paragraphs ("\n\n")
        let mut rows = rows_for(0, 0, 0, &[]);
        rows.extend(rows_for(1, 1, 0, &[]));
        rows.extend(rows_for(2, 2, 0, &[]));
        assert_eq!(row_at(&rows, 1, false), 1);
        assert_eq!(row_at(&rows, 2, true), 2);
    }

    type Log = Rc<RefCell<Vec<String>>>;

    /// A parent that logs the keys the area lets through.
    struct Parent {
        area: Entity<TextArea>,
        log: Log,
        width: f32,
    }

    impl Render for Parent {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div()
                .size_full()
                .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, _| {
                    if let Some(k) = keys::notation(ev) {
                        this.log.borrow_mut().push(k);
                    }
                }))
                .child(div().w(px(self.width)).h(px(120.)).child(self.area.clone()))
        }
    }

    struct Kit {
        cx: VisualTestContext,
        area: Entity<TextArea>,
        log: Log,
        changes: Rc<RefCell<usize>>,
    }

    impl Kit {
        fn open(width: f32) -> Kit {
            Self::open_styled(width, TextAreaStyle::field())
        }

        fn open_styled(width: f32, style: TextAreaStyle) -> Kit {
            let mut app = TestAppContext::build(TestDispatcher::new(0), None);
            let log: Log = Rc::default();
            let changes: Rc<RefCell<usize>> = Rc::default();
            let (log2, changes2) = (log.clone(), changes.clone());
            let window = app.add_window(move |_, cx| {
                let area =
                    cx.new(|cx| TextArea::new(cx).style(style).placeholder("Commit Message"));
                cx.subscribe(&area, move |_, _, _: &TextAreaEvent, _| {
                    *changes2.borrow_mut() += 1;
                })
                .detach();
                Parent {
                    area,
                    log: log2,
                    width,
                }
            });
            let root = window.root(&mut app).unwrap();
            let mut cx = VisualTestContext::from_window(window.into(), &app);
            let area = root.read_with(&cx, |p, _| p.area.clone());
            cx.update(|window, cx| {
                window.activate_window();
                let h = area.read(cx).focus.clone();
                window.focus(&h, cx);
            });
            cx.run_until_parked();
            Kit {
                cx,
                area,
                log,
                changes,
            }
        }

        fn text(&mut self) -> String {
            self.area.read_with(&self.cx, |a, _| a.text().to_owned())
        }

        fn sel(&mut self) -> Range<usize> {
            self.area.read_with(&self.cx, |a, _| a.selection())
        }

        fn cursor(&mut self) -> usize {
            self.area.read_with(&self.cx, |a, _| a.cursor())
        }

        fn set(&mut self, text: &str) {
            let area = self.area.clone();
            self.cx
                .update(|_, cx| area.update(cx, |a, cx| a.set_text(text, cx)));
            self.cx.run_until_parked();
        }

        fn keys(&mut self, keys: &str) {
            self.cx.simulate_keystrokes(keys);
            self.cx.run_until_parked();
        }

        /// (row, x) of the caret.
        fn caret(&mut self) -> (usize, Pixels) {
            let area = self.area.clone();
            self.cx.update(|window, cx| {
                area.update(cx, |a, _| {
                    let l = a.ensure_layout(window).expect("laid out");
                    let c = a.cursor();
                    let row = l.row_at(c, a.upstream);
                    (row, l.x_of(c, row))
                })
            })
        }

        fn rows(&mut self) -> usize {
            let area = self.area.clone();
            self.cx.update(|window, cx| {
                area.update(cx, |a, _| {
                    a.ensure_layout(window).expect("laid out").rows.len()
                })
            })
        }

        /// Window point of a text offset (middle of its row).
        fn point_of(&mut self, offset: usize) -> Point<Pixels> {
            let area = self.area.clone();
            self.cx.update(|window, cx| {
                area.update(cx, |a, _| {
                    let l = a.ensure_layout(window).expect("laid out");
                    let b = a.last_bounds.expect("painted");
                    let row = l.row_at(offset, false);
                    point(
                        b.left() + l.x_of(offset, row) + px(0.5),
                        b.top() + l.line_h * (row as f32 + 0.5) - a.scroll_y,
                    )
                })
            })
        }
    }

    #[test]
    fn commit_message_rows_are_editor_rows_and_the_focus_ring_is_two_px() {
        let mut k = Kit::open_styled(300., TextAreaStyle::commit_message());
        k.set("fix\nbody");
        let (a, b) = (k.point_of(0), k.point_of(4));
        assert_eq!(b.y - a.y, px(22.), "the main editor's row pitch");
        let ring = |k: &mut Kit| {
            k.cx.update(|window, _| {
                window
                    .painted_quads()
                    .into_iter()
                    .find(|q| q.border_color == look::hsla(look::FOCUS_BORDER.rgba()))
                    .map(|q| q.border_widths.left)
            })
        };
        let scale = k.cx.update(|window, _| window.scale_factor());
        assert_eq!(ring(&mut k), Some(gpui_kit::ScaledPixels(2. * scale)));
        // unfocused: the 1 px border; the text stays where it was
        let other = k.cx.update(|_, cx| cx.focus_handle());
        k.cx.update(|window, cx| window.focus(&other, cx));
        k.cx.run_until_parked();
        assert_eq!(ring(&mut k), None);
        assert_eq!(k.point_of(0), a);
    }

    #[test]
    fn enter_types_newlines_and_other_keys_bubble() {
        let mut k = Kit::open(300.);
        k.cx.simulate_input("hej");
        k.keys("enter");
        k.cx.simulate_input("då");
        k.keys("shift-enter");
        assert_eq!(k.text(), "hej\ndå\n");
        assert!(*k.changes.borrow() >= 4);
        k.log.borrow_mut().clear();
        k.keys("cmd-enter escape tab");
        assert_eq!(k.text(), "hej\ndå\n", "Cmd+Enter / Esc / Tab type nothing");
        assert_eq!(*k.log.borrow(), ["<D-CR>", "<Esc>", "<Tab>"]);
        // used keys don't reach the parent
        k.log.borrow_mut().clear();
        k.keys("left up backspace");
        assert!(k.log.borrow().is_empty(), "{:?}", k.log.borrow());
    }

    #[test]
    fn up_down_cross_wrapped_rows_keeping_the_goal_x() {
        let mut k = Kit::open(120.);
        k.set("alpha beta gamma delta epsilon zeta eta theta");
        let rows = k.rows();
        assert!(rows >= 3, "wraps in a narrow area: {rows} rows");
        k.keys("cmd-up right right");
        assert_eq!(k.cursor(), 2);
        let (row, x) = k.caret();
        assert_eq!(row, 0);
        k.keys("down");
        let (row1, x1) = k.caret();
        assert_eq!(row1, 1);
        assert!((x1 - x).abs() < px(8.), "goal x kept: {x:?} -> {x1:?}");
        k.keys("down");
        assert_eq!(k.caret().0, 2);
        k.keys("cmd-up");
        assert_eq!(k.cursor(), 0);
        // Up on the first row: the start; Down on the last: the end
        k.keys("up");
        assert_eq!(k.cursor(), 0);
        k.keys("cmd-down down");
        assert_eq!(k.cursor(), k.text().len());
        // Cmd+Right: the end of the visual row (shown there, not on the next row)
        k.keys("cmd-up cmd-right");
        assert_eq!(k.caret().0, 0);
        assert!(k.cursor() > 0);
        // Shift+Down selects a row's worth
        k.keys("cmd-up shift-down");
        assert_eq!(k.sel().start, 0);
        assert!(k.sel().end > 0);
    }

    #[test]
    fn word_moves_over_multibyte_text() {
        let mut k = Kit::open(300.);
        k.set("åäö bär_x\nök");
        k.keys("cmd-up alt-right");
        assert_eq!(k.cursor(), 6);
        k.keys("alt-right");
        assert_eq!(k.cursor(), 13);
        k.keys("alt-shift-left");
        assert_eq!(k.sel(), 7..13);
        k.keys("alt-right alt-right");
        assert_eq!(k.cursor(), 17);
        k.keys("alt-backspace");
        assert_eq!(k.text(), "åäö bär_x\n");
        k.keys("backspace");
        assert_eq!(k.text(), "åäö bär_x");
        k.keys("cmd-backspace");
        assert_eq!(k.text(), "");
    }

    #[test]
    fn undo_redo_steps() {
        let mut k = Kit::open(300.);
        k.keys("a b c backspace backspace");
        assert_eq!(k.text(), "a");
        k.keys("cmd-z");
        assert_eq!(k.text(), "abc", "the backspace run is one step");
        k.keys("cmd-z");
        assert_eq!(k.text(), "", "the typing run is one step");
        k.keys("cmd-shift-z");
        assert_eq!(k.text(), "abc");
        k.keys("cmd-shift-z");
        assert_eq!(k.text(), "a");
        // a caret move between typing makes two steps
        k.keys("x left y");
        assert_eq!(k.text(), "ayx");
        k.keys("cmd-z");
        assert_eq!(k.text(), "ax");
        k.keys("cmd-z");
        assert_eq!(k.text(), "a");
        // undo puts the selection back
        k.set("one two");
        k.keys("cmd-a backspace cmd-z");
        assert_eq!(k.text(), "one two");
        assert_eq!(k.sel(), 0..7);
        // a new edit drops the redo
        k.keys("q cmd-shift-z");
        assert_eq!(k.text(), "q");
    }

    #[test]
    fn paste_keeps_newlines_and_copy_cut_work() {
        let mut k = Kit::open(300.);
        k.cx.write_to_clipboard(ClipboardItem::new_string("one\r\ntwo\nthree".into()));
        k.keys("cmd-v");
        assert_eq!(k.text(), "one\ntwo\nthree");
        k.keys("cmd-a cmd-c cmd-x");
        assert_eq!(k.text(), "");
        assert_eq!(
            k.cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("one\ntwo\nthree")
        );
        k.keys("cmd-v cmd-v cmd-z");
        assert_eq!(
            k.text(),
            "one\ntwo\nthree",
            "each paste is its own undo step"
        );
        k.keys("cmd-z");
        assert_eq!(k.text(), "");
    }

    #[test]
    fn mouse_drag_selects_across_lines_and_clicks_select_words_lines() {
        let mut k = Kit::open(300.);
        k.set("first line\nsecond line");
        let a = k.point_of(2);
        let b = k.point_of(15);
        k.cx.simulate_mouse_down(a, MouseButton::Left, Modifiers::default());
        k.cx.simulate_mouse_move(b, Some(MouseButton::Left), Modifiers::default());
        k.cx.simulate_mouse_up(b, MouseButton::Left, Modifiers::default());
        assert_eq!(k.sel(), 2..15);
        // Shift+click extends
        let c = k.point_of(20);
        k.cx.simulate_click(
            c,
            Modifiers {
                shift: true,
                ..Default::default()
            },
        );
        assert_eq!(k.sel(), 2..20);
        // double-click a word, triple-click its line
        let w = k.point_of(13);
        for count in [2, 3] {
            k.cx.simulate_event(MouseDownEvent {
                position: w,
                modifiers: Modifiers::default(),
                button: MouseButton::Left,
                click_count: count,
                first_mouse: false,
            });
            k.cx.simulate_event(MouseUpEvent {
                position: w,
                modifiers: Modifiers::default(),
                button: MouseButton::Left,
                click_count: count,
            });
            let want = if count == 2 { 11..17 } else { 11..22 };
            assert_eq!(k.sel(), want);
        }
    }

    #[test]
    #[cfg_attr(
        not(debug_assertions),
        ignore = "needs GPUI debug selectors (debug builds)"
    )]
    fn ime_composes_dead_keys_in_one_undo_step() {
        use gpui_kit::InputHandler as _;
        let mut k = Kit::open(300.);
        k.cx.simulate_input("m");
        // a caret move: the composition starts its own undo step
        k.keys("left right");
        let bounds = k.cx.debug_bounds("text-area").unwrap();
        let mut ime = ElementInputHandler::new(bounds, k.area.clone());
        k.cx.update(|window, cx| {
            ime.replace_and_mark_text_in_range(None, "¨", Some(1..1), window, cx)
        });
        assert_eq!(k.text(), "m¨");
        k.cx.update(|window, cx| ime.replace_text_in_range(None, "ü", window, cx));
        assert_eq!(k.text(), "mü");
        assert_eq!(k.sel(), 3..3);
        // one step back to before the dead key (no "m¨" in between)
        k.keys("cmd-z");
        assert_eq!(k.text(), "m");
        k.keys("cmd-shift-z");
        assert_eq!(k.text(), "mü");
    }

    #[test]
    #[cfg_attr(
        not(debug_assertions),
        ignore = "needs GPUI debug selectors (debug builds)"
    )]
    fn caret_kept_in_view_and_wheel_scrolls() {
        let mut k = Kit::open(300.);
        let long: Vec<String> = (0..40).map(|i| format!("line {i}")).collect();
        k.set(&long.join("\n"));
        let scrolled = k.area.read_with(&k.cx, |a, _| a.scroll_y);
        assert!(scrolled > px(0.), "the caret at the end is in view");
        let at = k.cx.debug_bounds("text-area").unwrap().center();
        k.cx.simulate_event(ScrollWheelEvent {
            position: at,
            delta: gpui_kit::ScrollDelta::Pixels(point(px(0.), px(10_000.))),
            modifiers: Modifiers::default(),
            touch_phase: gpui_kit::TouchPhase::Moved,
        });
        k.cx.run_until_parked();
        assert_eq!(k.area.read_with(&k.cx, |a, _| a.scroll_y), px(0.));
        // typing scrolls back to the caret
        k.cx.simulate_input("!");
        assert!(k.area.read_with(&k.cx, |a, _| a.scroll_y) > px(0.));
    }

    #[test]
    fn ten_thousand_chars_shape_once_per_change() {
        let mut k = Kit::open(300.);
        let text = "word ".repeat(2000);
        let t = std::time::Instant::now();
        k.set(&text);
        k.keys("cmd-up down down end");
        assert!(k.rows() > 10);
        // debug build budget
        assert!(t.elapsed().as_millis() < 2000, "{:?}", t.elapsed());
        let v = k
            .area
            .read_with(&k.cx, |a, _| a.layout.as_ref().map(|l| l.version));
        k.keys("down");
        let v2 = k
            .area
            .read_with(&k.cx, |a, _| a.layout.as_ref().map(|l| l.version));
        assert_eq!(v, v2, "moves reuse the layout");
    }
}
