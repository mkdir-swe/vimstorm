//! The VCS log's filter chips (VcsLogPopupComponent): "User ⌄" while no value is set,
//! "Branch: HEAD ×" with one (the name dimmed, the value in the text color, a × that clears).
//! No hover background (WS FilterComponent): hovering turns the name to the value color. A click
//! opens the filter's popup, which is the owner's (it gets the chip's bounds to place it under);
//! while it's open ([`FilterChip::open`]) the name keeps the value color.

use std::rc::Rc;

use gpui_kit::{
    App, Bounds, CursorStyle, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};

use super::icons::{Icon, IconName};
use crate::look;

type OpenHandler = Rc<dyn Fn(Bounds<Pixels>, &mut Window, &mut App)>;
type ClearHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A filter chip.
pub struct FilterChip {
    id: ElementId,
    name: SharedString,
    value: Option<SharedString>,
    open: bool,
    /// "Branch: " before a value (a narrow filter bar drops it: just the value and its ×).
    show_name: bool,
    on_open: Option<OpenHandler>,
    on_clear: Option<ClearHandler>,
}

impl FilterChip {
    /// `name`: "Branch", "User", "Date", "Paths".
    pub fn new(id: impl Into<ElementId>, name: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            value: None,
            open: false,
            show_name: true,
            on_open: None,
            on_clear: None,
        }
    }

    /// The filter's value ("HEAD"); None: no filter (chevron instead of ×).
    pub fn value(mut self, value: Option<impl Into<SharedString>>) -> Self {
        self.value = value.map(Into::into);
        self
    }

    /// Its popup is open (the pressed background stays).
    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// false: a set chip shows just its value and × (narrow bars; unset chips keep the name).
    pub fn show_name(mut self, show: bool) -> Self {
        self.show_name = show;
        self
    }

    /// Click: open the popup under `bounds` (the chip, window coordinates).
    pub fn on_open(mut self, f: impl Fn(Bounds<Pixels>, &mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(Rc::new(f));
        self
    }

    /// The ×: clear the filter.
    pub fn on_clear(mut self, f: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_clear = Some(Rc::new(f));
        self
    }
}

impl IntoElement for FilterChip {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl RenderOnce for FilterChip {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let bounds = Rc::new(std::cell::Cell::new(Bounds::<Pixels>::default()));
        let b2 = bounds.clone();
        let selector = format!("chip-{}", self.id);
        let clear_selector = format!("chip-clear-{}", self.id);
        let has_value = self.value.is_some();
        let on_open = self.on_open.clone();
        div()
            .id(self.id.clone())
            .debug_selector(move || selector.clone())
            .relative()
            .flex_none()
            .group("filter-chip")
            .h(px(look::FILTER_CHIP_HEIGHT))
            .p(px(look::FILTER_CHIP_PAD))
            .flex()
            .items_center()
            .rounded(px(look::FILTER_CHIP_FOCUS_ARC))
            .cursor(CursorStyle::PointingHand)
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .child(
                canvas(move |b, _, _| b2.set(b), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .when(!has_value || self.show_name, |d| {
                d.child(
                    div()
                        .text_color(if self.open {
                            look::FILTER_CHIP_VALUE_FG
                        } else {
                            look::FILTER_CHIP_NAME_FG
                        })
                        // WS: no hover background, the name takes the value color
                        .group_hover("filter-chip", |s| s.text_color(look::FILTER_CHIP_VALUE_FG))
                        .child(if has_value {
                            SharedString::from(format!("{}: ", self.name))
                        } else {
                            self.name.clone()
                        }),
                )
            })
            .children(
                self.value
                    .clone()
                    .map(|v| div().text_color(look::FILTER_CHIP_VALUE_FG).child(v)),
            )
            .child(div().flex_none().w(px(look::FILTER_CHIP_ICON_GAP)))
            .map(|d| match (has_value, self.on_clear.clone()) {
                (true, Some(clear)) => d.child(
                    div()
                        .id(clear_selector.clone())
                        .debug_selector(move || clear_selector.clone())
                        .flex_none()
                        .group("filter-chip-clear")
                        .relative()
                        .size(px(look::ICON_SIZE))
                        .child(Icon::new(IconName::CloseSmall))
                        .child(
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .invisible()
                                .group_hover("filter-chip-clear", |s| s.visible())
                                .child(Icon::new(IconName::CloseSmallHovered)),
                        )
                        .on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, _, cx| {
                            cx.stop_propagation()
                        })
                        .on_click(move |_, window, cx| {
                            cx.stop_propagation();
                            clear(window, cx)
                        }),
                ),
                (true, None) => d,
                (false, _) => d.child(Icon::new(IconName::ChevronDown)),
            })
            .when_some(on_open, |d, f| {
                d.on_click(move |_, window, cx| f(bounds.get(), window, cx))
            })
    }
}
