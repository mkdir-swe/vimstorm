//! Single-line text field (WebStorm text / search field): Inter 13, caret, selection, Cmd+A/C/V/X,
//! Cmd+Z / Cmd+Shift+Z undo / redo,
//! Alt+Left/Right word moves, Cmd+Left/Right, Backspace / Delete (Alt: word, Cmd: to start),
//! mouse selection, IME through GPUI's input handler (Swedish dead keys compose), I-beam cursor,
//! placeholder, optional magnifier (search field look).
//!
//! Keys the field doesn't use (Enter, Esc, Up / Down, Tab) propagate to the parent, which reacts
//! to them (a picker moves its list); content changes are [`FieldEvent::Changed`].
//!
//! The input handler / text element follow GPUI's `examples/input.rs` (Apache-2.0).

use std::ops::Range;

use gpui_kit::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId,
    InspectorElementId, InteractiveElement, IntoElement, KeyDownEvent, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, ParentElement, Pixels, Point, Render,
    ShapedLine, SharedString, Style, Styled, TextAlign, TextRun, UTF16Selection, UnderlineStyle,
    Window, div, fill, point, prelude::FluentBuilder as _, px, relative, size,
};

use super::icons::{Icon, IconName};
use super::keys;
use crate::look;

/// What the field tells its parent.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldEvent {
    /// The text changed (typing, paste, cut, IME commit).
    Changed,
}

/// A single-line text input.
pub struct TextField {
    focus: FocusHandle,
    text: String,
    placeholder: SharedString,
    /// Placeholder color (default: look::PLACEHOLDER).
    placeholder_color: look::Tok,
    search_icon: bool,
    bordered: bool,
    /// Opt-in metrics (pickers' borderless fields: WS complex-popup input insets 4,2,4,2);
    /// None: FIELD_PADDING_X / FIELD_HEIGHT.
    pad_x: Option<f32>,
    height: Option<f32>,
    /// Byte range; empty = caret.
    selected: Range<usize>,
    /// The caret is at `selected.start` (selection made leftwards).
    reversed: bool,
    /// IME composition (dead key / marked text).
    marked: Option<Range<usize>>,
    /// Horizontal scroll so the caret stays visible.
    scroll_x: Pixels,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    selecting: bool,
    /// Cmd+Z / Cmd+Shift+Z: (text, selection) before each edit; typed chars of one word are one
    /// step (WebStorm's text fields).
    undo: Vec<(String, Range<usize>)>,
    redo: Vec<(String, Range<usize>)>,
    /// Where the last typed char ended (the next one there joins its undo step).
    typing_at: Option<usize>,
}

/// Undo steps a field keeps.
const UNDO_MAX: usize = 100;

impl EventEmitter<FieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextField {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            text: String::new(),
            placeholder: SharedString::default(),
            placeholder_color: look::PLACEHOLDER,
            search_icon: false,
            bordered: true,
            pad_x: None,
            height: None,
            selected: 0..0,
            reversed: false,
            marked: None,
            scroll_x: px(0.),
            last_layout: None,
            last_bounds: None,
            selecting: false,
            undo: Vec::new(),
            redo: Vec::new(),
            typing_at: None,
        }
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// WebStorm search field: magnifier before the text.
    pub fn search(mut self) -> Self {
        self.search_icon = true;
        self
    }

    /// No outline / background (a field inside another frame, e.g. a popup header).
    pub fn borderless(mut self) -> Self {
        self.bordered = false;
        self
    }

    /// Another horizontal padding than FIELD_PADDING_X (a borderless field whose magnifier lines
    /// up with its frame's insets).
    pub fn pad_x(mut self, pad: f32) -> Self {
        self.pad_x = Some(pad);
        self
    }

    /// Another height than FIELD_HEIGHT.
    pub fn height(mut self, h: f32) -> Self {
        self.height = Some(h);
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// Replaces the text, caret at the end (no [`FieldEvent::Changed`]: the caller knows).
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.text = text.into();
        self.selected = self.text.len()..self.text.len();
        self.reversed = false;
        self.marked = None;
        self.undo.clear();
        self.redo.clear();
        self.typing_at = None;
        cx.notify();
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

    /// Types `text` over the selection (as a key would; emits [`FieldEvent::Changed`]).
    pub fn insert(&mut self, text: &str, cx: &mut Context<Self>) {
        self.replace(self.selected.clone(), text, cx);
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selected = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected = offset..offset;
        self.reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        cx.notify();
    }

    /// Replaces the selection (or `range`) with `text`, caret after it.
    fn replace(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        let typed =
            range.is_empty() && text.chars().count() == 1 && !text.chars().all(char::is_whitespace);
        if !(typed && self.typing_at == Some(range.start)) {
            self.undo.push((self.text.clone(), self.selected.clone()));
            if self.undo.len() > UNDO_MAX {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.text.replace_range(range.clone(), text);
        let end = range.start + text.len();
        self.typing_at = typed.then_some(end);
        self.selected = end..end;
        self.reversed = false;
        self.marked = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    /// Cmd+Z (`back`) / Cmd+Shift+Z: the text before / after the last edit step.
    fn undo_redo(&mut self, back: bool, cx: &mut Context<Self>) {
        let (from, to) = if back {
            (&mut self.undo, &mut self.redo)
        } else {
            (&mut self.redo, &mut self.undo)
        };
        let Some((text, sel)) = from.pop() else {
            return;
        };
        to.push((
            std::mem::replace(&mut self.text, text),
            self.selected.clone(),
        ));
        self.selected = sel.start.min(self.text.len())..sel.end.min(self.text.len());
        self.reversed = false;
        self.marked = None;
        self.typing_at = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    /// Deletes the selection, or from the caret to `to` when nothing is selected.
    fn delete_to(&mut self, to: usize, cx: &mut Context<Self>) {
        let range = if self.selected.is_empty() {
            let c = self.cursor();
            c.min(to)..c.max(to)
        } else {
            self.selected.clone()
        };
        if !range.is_empty() {
            self.replace(range, "", cx);
        }
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

    /// Start of the word before `offset` (macOS Alt+Left).
    fn prev_word(&self, offset: usize) -> usize {
        let before: Vec<(usize, char)> = self.text[..offset].char_indices().collect();
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
    fn next_word(&self, offset: usize) -> usize {
        let mut it = self.text[offset..].char_indices().peekable();
        while it.peek().is_some_and(|(_, c)| !is_word(*c)) {
            it.next();
        }
        while it.peek().is_some_and(|(_, c)| is_word(*c)) {
            it.next();
        }
        it.peek().map_or(self.text.len(), |(i, _)| offset + i)
    }

    /// The word around `offset` (double-click).
    fn word_at(&self, offset: usize) -> Range<usize> {
        let start = self.text[..offset]
            .char_indices()
            .rev()
            .take_while(|(_, c)| is_word(*c))
            .last()
            .map_or(offset, |(i, _)| i);
        let end = self.text[offset..]
            .char_indices()
            .take_while(|(_, c)| is_word(*c))
            .last()
            .map_or(offset, |(i, c)| offset + i + c.len_utf8());
        start..end
    }

    /// A key in nvim notation; true when the field used it.
    pub fn key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let c = self.cursor();
        let len = self.text.len();
        match key {
            "<Left>" if !self.selected.is_empty() => self.move_to(self.selected.start, cx),
            "<Right>" if !self.selected.is_empty() => self.move_to(self.selected.end, cx),
            "<Left>" => self.move_to(self.prev_char(c), cx),
            "<Right>" => self.move_to(self.next_char(c), cx),
            "<S-Left>" => self.select_to(self.prev_char(c), cx),
            "<S-Right>" => self.select_to(self.next_char(c), cx),
            "<M-Left>" => self.move_to(self.prev_word(c), cx),
            "<M-Right>" => self.move_to(self.next_word(c), cx),
            "<M-S-Left>" => self.select_to(self.prev_word(c), cx),
            "<M-S-Right>" => self.select_to(self.next_word(c), cx),
            "<D-Left>" | "<Home>" => self.move_to(0, cx),
            "<D-Right>" | "<End>" => self.move_to(len, cx),
            "<D-S-Left>" | "<S-Home>" => self.select_to(0, cx),
            "<D-S-Right>" | "<S-End>" => self.select_to(len, cx),
            // insert-mode keys, as in snacks' input fields: Ctrl+H backspace, Ctrl+W the word
            // before, Ctrl+U to the start
            "<BS>" | "<C-h>" => self.delete_to(self.prev_char(c), cx),
            "<C-w>" => self.delete_to(self.prev_word(c), cx),
            "<C-u>" => self.delete_to(0, cx),
            "<Del>" => self.delete_to(self.next_char(c), cx),
            "<M-BS>" => self.delete_to(self.prev_word(c), cx),
            "<M-Del>" => self.delete_to(self.next_word(c), cx),
            "<D-BS>" => self.delete_to(0, cx),
            "<D-a>" => self.select_all(cx),
            "<D-z>" => self.undo_redo(true, cx),
            "<D-S-z>" | "<D-Z>" | "<S-D-z>" | "<S-D-Z>" => self.undo_redo(false, cx),
            "<D-c>" | "<D-x>" => {
                if !self.selected.is_empty() {
                    let text = self.text[self.selected.clone()].to_string();
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    if key == "<D-x>" {
                        self.replace(self.selected.clone(), "", cx);
                    }
                }
            }
            "<D-v>" => {
                if let Some(text) = cx.read_from_clipboard().and_then(|i| i.text()) {
                    // one line: newlines become spaces (WebStorm's single-line fields)
                    let text = text.replace(['\r', '\n'], " ");
                    self.replace(self.selected.clone(), &text, cx);
                }
            }
            _ => return false,
        }
        let _ = window;
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

    fn index_for_x(&self, x: Pixels) -> usize {
        let (Some(bounds), Some(line)) = (self.last_bounds, self.last_layout.as_ref()) else {
            return 0;
        };
        if self.text.is_empty() {
            return 0;
        }
        line.closest_index_for_x(x - bounds.left() + self.scroll_x)
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let at = self.index_for_x(ev.position.x);
        if ev.click_count == 2 {
            self.selected = self.word_at(at);
            self.reversed = false;
            cx.notify();
            return;
        }
        if ev.click_count >= 3 {
            return self.select_all(cx);
        }
        self.selecting = true;
        if ev.modifiers.shift {
            self.select_to(at, cx);
        } else {
            self.move_to(at, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting {
            self.select_to(self.index_for_x(ev.position.x), cx);
        }
    }

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

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl EntityInputHandler for TextField {
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

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // one line: Enter / Tab typed as text ("\n", "\t") are no input here
        if text.chars().any(char::is_control) {
            return;
        }
        let range = range
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selected.clone());
        self.replace(range, text, cx);
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
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.last_layout.as_ref()?;
        let range = self.range_from_utf16(&range);
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(range.start) - self.scroll_x,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(range.end) - self.scroll_x,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        p: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let bounds = self.last_bounds?;
        let line = self.last_layout.as_ref()?;
        let ix = line.index_for_x(p.x - bounds.left() + self.scroll_x)?;
        Some(self.utf8_to_utf16(ix))
    }
}

impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        div()
            .id("text-field")
            .debug_selector(|| "text-field".into())
            .key_context("VimStormField")
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .h(px(self.height.unwrap_or(look::FIELD_HEIGHT)))
            .w_full()
            .flex()
            .items_center()
            .gap(px(look::FIELD_ICON_GAP))
            .px(px(self.pad_x.unwrap_or(look::FIELD_PADDING_X)))
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .when(self.bordered, |d| {
                d.rounded(px(look::FIELD_ARC))
                    .bg(look::FIELD_BG)
                    .border_1()
                    .border_color(if focused {
                        look::FOCUS_BORDER
                    } else {
                        look::FIELD_BORDER
                    })
            })
            .when(self.search_icon, |d| d.child(Icon::new(IconName::Search)))
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .child(FieldText(cx.entity())),
            )
    }
}

/// The text line: placeholder / text, selection, caret; registers the IME handler.
struct FieldText(Entity<TextField>);

struct Prepaint {
    line: ShapedLine,
    selection: Option<PaintQuad>,
    caret: Option<PaintQuad>,
    scroll_x: Pixels,
}

impl IntoElement for FieldText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for FieldText {
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
        style.size.height = window.line_height().into();
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
        let field = self.0.read(cx);
        let style = window.text_style();
        let (shown, color) = if field.text.is_empty() {
            (
                field.placeholder.clone(),
                look::hsla(field.placeholder_color.rgba()),
            )
        } else {
            (SharedString::from(field.text.clone()), style.color)
        };
        let run = TextRun {
            len: shown.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match field.marked.clone().filter(|_| !field.text.is_empty()) {
            Some(m) => [
                TextRun {
                    len: m.start,
                    ..run.clone()
                },
                TextRun {
                    len: m.end - m.start,
                    underline: Some(UnderlineStyle {
                        color: Some(color),
                        thickness: px(1.),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: shown.len() - m.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect(),
            None => vec![run],
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(shown, font_size, &runs, None);
        let (caret_x, sel) = if field.text.is_empty() {
            (px(0.), None)
        } else {
            (
                line.x_for_index(field.cursor()),
                (!field.selected.is_empty()).then(|| {
                    (
                        line.x_for_index(field.selected.start),
                        line.x_for_index(field.selected.end),
                    )
                }),
            )
        };
        // keep the caret inside the field
        let width = bounds.size.width;
        let mut scroll_x = field.scroll_x;
        if caret_x - scroll_x > width - px(2.) {
            scroll_x = caret_x - width + px(2.);
        }
        if caret_x < scroll_x {
            scroll_x = caret_x;
        }
        scroll_x = scroll_x.min((line.width - width + px(2.)).max(px(0.)));
        let x = |v: Pixels| bounds.left() + v - scroll_x;
        let selection = sel.map(|(a, b)| {
            fill(
                Bounds::from_corners(point(x(a), bounds.top()), point(x(b), bounds.bottom())),
                look::FIELD_SELECTION_BG,
            )
        });
        let caret = field.selected.is_empty().then(|| {
            fill(
                Bounds::new(
                    point(x(caret_x), bounds.top()),
                    size(px(look::CARET_WIDTH), bounds.size.height),
                ),
                look::CARET,
            )
        });
        Prepaint {
            line,
            selection,
            caret,
            scroll_x,
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
        window.with_content_mask(Some(gpui_kit::ContentMask { bounds }), |window| {
            if let Some(sel) = pre.selection.take() {
                window.paint_quad(sel);
            }
            let origin = point(bounds.left() - pre.scroll_x, bounds.top());
            let _ = pre.line.paint(
                origin,
                window.line_height(),
                TextAlign::Left,
                None,
                window,
                cx,
            );
            if focus.is_focused(window)
                && let Some(caret) = pre.caret.take()
            {
                window.paint_quad(caret);
            }
        });
        let line = pre.line.clone();
        let scroll_x = pre.scroll_x;
        self.0.update(cx, |f, _| {
            f.last_layout = Some(line);
            f.last_bounds = Some(bounds);
            f.scroll_x = scroll_x;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{AppContext as _, TestAppContext, TestDispatcher};

    fn field(text: &str) -> (TestAppContext, Entity<TextField>) {
        let mut cx = TestAppContext::build(TestDispatcher::new(0), None);
        let f = cx.new(TextField::new);
        f.update(&mut cx, |f, cx| f.set_text(text, cx));
        (cx, f)
    }

    #[test]
    fn word_boundaries() {
        let (mut cx, f) = field("foo bar_baz  qux");
        f.update(&mut cx, |f, _| {
            assert_eq!(f.prev_word(16), 13);
            assert_eq!(f.prev_word(13), 4);
            assert_eq!(f.prev_word(4), 0);
            assert_eq!(f.prev_word(0), 0);
            assert_eq!(f.next_word(0), 3);
            assert_eq!(f.next_word(3), 11);
            assert_eq!(f.next_word(11), 16);
            assert_eq!(f.word_at(6), 4..11);
        });
    }

    /// Ctrl+W / Ctrl+U / Ctrl+H as real keystrokes into a focused field.
    #[test]
    fn insert_mode_ctrl_keys_delete() {
        use gpui_kit::VisualTestContext;
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        let window = app.add_window(|_, cx| TextField::new(cx));
        let f = window.root(&mut app).unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), &app);
        cx.update(|window, cx| {
            window.activate_window();
            let h = f.read(cx).focus.clone();
            window.focus(&h, cx);
        });
        let text = |cx: &mut VisualTestContext| f.read_with(cx, |f, _| f.text().to_owned());
        f.update(&mut cx, |f, cx| f.set_text("src/app foo-bar", cx));
        cx.simulate_keystrokes("ctrl-w");
        assert_eq!(text(&mut cx), "src/app foo-");
        cx.simulate_keystrokes("ctrl-h");
        assert_eq!(text(&mut cx), "src/app foo");
        cx.simulate_keystrokes("ctrl-w ctrl-w");
        assert_eq!(text(&mut cx), "src/");
        cx.simulate_keystrokes("ctrl-u");
        assert_eq!(text(&mut cx), "");
        // a selection: the keys delete it
        f.update(&mut cx, |f, cx| {
            f.set_text("abc def", cx);
            f.select_all(cx);
        });
        cx.simulate_keystrokes("ctrl-w");
        assert_eq!(text(&mut cx), "");
    }

    #[test]
    fn utf16_offsets() {
        let (mut cx, f) = field("åä😀b");
        f.update(&mut cx, |f, _| {
            assert_eq!(f.utf8_to_utf16(f.text.len()), 5);
            assert_eq!(f.utf16_to_utf8(4), 8);
            assert_eq!(f.utf16_to_utf8(2), 4);
        });
    }
}
