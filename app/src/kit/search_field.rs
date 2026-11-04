//! WebStorm's search field with option toggles (the VCS log's "Text or hash" filter,
//! SearchTextField + ExtendableTextField): a magnifier (with the history ▾ when the field keeps a
//! history), the text ([`TextField`], borderless), then `.*` (regex) and `Cc` (match case)
//! toggle buttons; the frame turns blue while the text has focus.
//!
//! Keys: everything [`TextField`] does; Alt+X toggles regex, Alt+C match case (WS find
//! options); Enter / Esc / arrows bubble to the owner. Mouse: a toggle click flips it (the text
//! keeps the keyboard), the magnifier of a history field emits [`SearchFieldEvent::History`].

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, CursorStyle, Entity, EventEmitter,
    FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};

use super::field::{FieldEvent, TextField};
use super::icons::{Icon, IconName};
use crate::look;

/// What the search field tells its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum SearchFieldEvent {
    /// The text changed.
    Changed,
    /// Regex / match case flipped (read [`SearchField::regex`] / [`SearchField::match_case`]).
    OptionsChanged,
    /// The history magnifier was clicked: open the history popup below these bounds.
    History(Bounds<Pixels>),
    /// The × at the end was clicked ([`SearchField::set_clear`]): the owner clears its filter.
    Clear,
}

/// The search field view.
pub struct SearchField {
    field: Entity<TextField>,
    regex: bool,
    match_case: bool,
    /// The magnifier has the history ▾ and is clickable.
    history: bool,
    /// The × after the text (an applied filter the owner clears at once).
    clear: bool,
    /// Just the magnifier (and the ×): a narrow bar (the VCS log's filter bar fit rule).
    compact: bool,
    /// No frame of its own (inside a search bar that has one: the terminal's find).
    frameless: bool,
    /// Match Case before Regex (WS's editor-style find); the VCS log keeps `.*` first (30.png).
    case_first: bool,
    /// Left / right padding (the frame's insets) override.
    pad: Option<(f32, f32)>,
    icon_bounds: Bounds<Pixels>,
}

impl EventEmitter<SearchFieldEvent> for SearchField {}

impl Focusable for SearchField {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.field.focus_handle(cx)
    }
}

impl SearchField {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        let placeholder = placeholder.into();
        let field = cx.new(|cx| TextField::new(cx).borderless().placeholder(placeholder));
        cx.subscribe(&field, |_, _, ev: &FieldEvent, cx| {
            if *ev == FieldEvent::Changed {
                cx.emit(SearchFieldEvent::Changed);
            }
        })
        .detach();
        Self {
            field,
            regex: false,
            match_case: false,
            history: false,
            clear: false,
            compact: false,
            frameless: false,
            case_first: false,
            pad: None,
            icon_bounds: Bounds::default(),
        }
    }

    /// No border / background / focus ring: the field sits in a bar that has them (WS's editor
    /// search component).
    pub fn frameless(mut self) -> Self {
        self.frameless = true;
        self
    }

    /// `Cc` before `.*`: WS's editor-style search (RwTerminalSearchSession: ToggleMatchCase,
    /// ToggleRegex).
    pub fn case_first(mut self) -> Self {
        self.case_first = true;
        self
    }

    /// Left / right padding instead of the VCS log field's.
    pub fn padding(mut self, left: f32, right: f32) -> Self {
        self.pad = Some((left, right));
        self
    }

    /// With a search history (the magnifier's ▾).
    pub fn with_history(mut self) -> Self {
        self.history = true;
        self
    }

    pub fn field(&self) -> &Entity<TextField> {
        &self.field
    }

    pub fn text<'a>(&self, cx: &'a App) -> &'a str {
        self.field.read(cx).text()
    }

    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.field.update(cx, |f, cx| f.set_text(text, cx));
    }

    pub fn regex(&self) -> bool {
        self.regex
    }

    pub fn match_case(&self) -> bool {
        self.match_case
    }

    pub fn set_regex(&mut self, on: bool, cx: &mut Context<Self>) {
        self.regex = on;
        cx.notify();
    }

    pub fn set_match_case(&mut self, on: bool, cx: &mut Context<Self>) {
        self.match_case = on;
        cx.notify();
    }

    /// Shows the × after the text (click: [`SearchFieldEvent::Clear`]).
    pub fn set_clear(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.clear != on {
            self.clear = on;
            cx.notify();
        }
    }

    /// Only the magnifier (and the ×); a click into it focuses the text, which shows it again
    /// (the owner leaves compact mode while the text has focus).
    pub fn set_compact(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.compact != on {
            self.compact = on;
            cx.notify();
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let handle = self.field.focus_handle(cx);
        window.focus(&handle, cx);
    }

    fn toggle(&mut self, regex: bool, cx: &mut Context<Self>) {
        if regex {
            self.regex = !self.regex;
        } else {
            self.match_case = !self.match_case;
        }
        cx.emit(SearchFieldEvent::OptionsChanged);
        cx.notify();
    }

    /// Alt+X / Alt+C before the field turns them into Option chars.
    fn on_capture_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        if !k.modifiers.alt || k.modifiers.platform || k.modifiers.control {
            return;
        }
        match k.key.to_ascii_lowercase().as_str() {
            "x" => self.toggle(true, cx),
            "c" => self.toggle(false, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    fn toggle_button(
        &self,
        id: &'static str,
        icon: IconName,
        on: bool,
        regex: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex_none()
            .size(px(look::SEARCH_FIELD_TOGGLE_SIZE))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(look::SEARCH_FIELD_TOGGLE_ARC))
            .cursor(CursorStyle::PointingHand)
            .map(|d| {
                if on {
                    d.bg(look::SEARCH_FIELD_TOGGLE_ON_BG)
                        .hover(|s| s.bg(look::SEARCH_FIELD_TOGGLE_ON_HOVER_BG))
                } else {
                    d.hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
                }
            })
            .child(Icon::new(icon))
            // the text keeps the keyboard (and its caret)
            .on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(regex, cx)))
            .into_any_element()
    }
}

impl Render for SearchField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.field.focus_handle(cx).contains_focused(window, cx);
        let entity = cx.entity().downgrade();
        let icon = div()
            .id("search-field-icon")
            .debug_selector(|| "search-field-icon".into())
            .relative()
            .flex_none()
            .child(Icon::new(if self.history {
                IconName::SearchHistory
            } else {
                IconName::Search
            }))
            .child(
                canvas(
                    move |b, _, cx| {
                        let _ = entity.update(cx, |this, _| this.icon_bounds = b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .when(self.history, |d| {
                d.cursor(CursorStyle::PointingHand)
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.emit(SearchFieldEvent::History(this.icon_bounds));
                    }))
            });
        let regex = self.toggle_button("search-field-regex", IconName::Regex, self.regex, true, cx);
        let case = self.toggle_button(
            "search-field-case",
            IconName::MatchCase,
            self.match_case,
            false,
            cx,
        );
        let clear = self.clear.then(|| {
            div()
                .id("search-field-clear")
                .debug_selector(|| "search-field-clear".into())
                .flex_none()
                .group("search-field-clear")
                .relative()
                .size(px(look::ICON_SIZE))
                .mr(px(look::SEARCH_FIELD_TOGGLE_GAP))
                .cursor(CursorStyle::PointingHand)
                .child(Icon::new(IconName::CloseSmall))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .invisible()
                        .group_hover("search-field-clear", |s| s.visible())
                        .child(Icon::new(IconName::CloseSmallHovered)),
                )
                .on_click(cx.listener(|_, _, _, cx| {
                    cx.stop_propagation();
                    cx.emit(SearchFieldEvent::Clear);
                }))
        });
        let compact = self.compact && !focused;
        let field = self.field.clone();
        let (pad_l, pad_r) = self
            .pad
            .unwrap_or((look::SEARCH_FIELD_PAD_LEFT, look::SEARCH_FIELD_PAD_RIGHT));
        // WS paints the focus ring 2 px wide inside the border's outer edge
        // (DarculaNewUIUtil.paintComponentBorder focusWidth): the padding gives the extra px back so
        // the text doesn't move.
        let ring = if focused && !self.frameless { 1. } else { 0. };
        let (first, second) = if self.case_first {
            (case, regex)
        } else {
            (regex, case)
        };
        div()
            .debug_selector(|| "search-field".into())
            .capture_key_down(cx.listener(Self::on_capture_key))
            .h(px(look::SEARCH_FIELD_HEIGHT))
            .w_full()
            .flex()
            .items_center()
            .pl(px(pad_l - ring))
            .pr(px(pad_r - ring))
            .rounded(px(look::FIELD_ARC))
            .when(!self.frameless, |d| {
                d.bg(look::FIELD_BG).map(|d| {
                    if focused {
                        d.border_2().border_color(look::FOCUS_BORDER)
                    } else {
                        d.border_1().border_color(look::FIELD_BORDER)
                    }
                })
            })
            .when(compact, |d| {
                d.cursor(CursorStyle::IBeam).on_mouse_down(
                    MouseButton::Left,
                    move |_: &MouseDownEvent, window, cx| {
                        let handle = field.focus_handle(cx);
                        window.focus(&handle, cx);
                    },
                )
            })
            .child(icon)
            // the inner field pads itself by FIELD_PADDING_X; WS's gap is the icon's
            .when(!compact, |d| {
                d.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .ml(px(look::SEARCH_FIELD_ICON_GAP - look::FIELD_PADDING_X))
                        .child(self.field.clone()),
                )
            })
            .when(compact, |d| d.child(div().flex_1().min_w(px(4.))))
            .children(clear)
            .when(!compact, |d| {
                d.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(look::SEARCH_FIELD_TOGGLE_GAP))
                        .child(first)
                        .child(second),
                )
            })
    }
}
