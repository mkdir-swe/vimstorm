//! WebStorm popup frame (menus, pickers, switcher, balloons, completion / hover floats) and its
//! placement: next to an anchor, flipped to the other side when there's no room, then clamped
//! inside the window.
//!
//! A popup is `placed(anchor, frame().child(..))` inside a `deferred(..)` (drawn over the rest).
//! [`place`] is the pure placement rule (unit-tested); [`Placed`] applies it at layout time, when
//! the popup's size is known.

use gpui_kit::{
    AnyElement, App, Bounds, BoxShadow, Div, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, ParentElement, Pixels, Point, Position,
    SharedString, Size, Style, Styled, Window, div, point, prelude::FluentBuilder as _, px,
};

use crate::look;

/// What a popup is placed against (window coordinates).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    /// Menus at the mouse / caret: top-left corner at the point; above / left of it when it
    /// doesn't fit.
    Point(Point<Pixels>),
    /// Dropdowns (toolbar widgets), completion under a caret rect: below the rect, left-aligned;
    /// above it when it doesn't fit below.
    Below(Bounds<Pixels>),
}

/// Gap between an anchor rect and its popup.
pub const ANCHOR_GAP: f32 = 2.;

/// Where a popup of `size` goes in a window of `viewport` (top-left corner).
pub fn place(anchor: Anchor, size: Size<Pixels>, viewport: Size<Pixels>) -> Point<Pixels> {
    let margin = px(look::POPUP_WINDOW_MARGIN);
    let gap = px(ANCHOR_GAP);
    let (mut x, mut y) = match anchor {
        Anchor::Point(p) => {
            let x = if p.x + size.width > viewport.width - margin && p.x - size.width >= margin {
                p.x - size.width
            } else {
                p.x
            };
            let y = if p.y + size.height > viewport.height - margin && p.y - size.height >= margin {
                p.y - size.height
            } else {
                p.y
            };
            (x, y)
        }
        Anchor::Below(r) => {
            let below = r.bottom() + gap;
            let above = r.top() - gap - size.height;
            let y = if below + size.height > viewport.height - margin && above >= margin {
                above
            } else {
                below
            };
            (r.left(), y)
        }
    };
    // clamp: right / bottom edge first, so a popup bigger than the window keeps its top-left
    x = x.min(viewport.width - margin - size.width).max(margin);
    y = y.min(viewport.height - margin - size.height).max(margin);
    point(x, y)
}

/// Where a popup `len` long starts when centred in `room` (one axis, window coordinates; WS
/// `showCenteredInCurrentWindow`): at least the window margin from the edge.
pub fn centered(len: f32, room: f32) -> f32 {
    ((room - len) / 2.).max(look::POPUP_WINDOW_MARGIN)
}

/// The popup frame: background, 1 px border, rounded corners, shadow, UI font; a column (header,
/// content, ad text).
pub fn frame() -> Div {
    div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .bg(look::POPUP_BG)
        .border_1()
        .border_color(look::POPUP_BORDER)
        .rounded(px(look::POPUP_ARC))
        .shadow(shadow())
        .font_family(crate::render::UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
}

/// WebStorm's popup shadow (a soft drop shadow under the frame).
pub fn shadow() -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: look::hsla(look::POPUP_SHADOW.rgba()),
        offset: point(px(0.), px(look::POPUP_SHADOW_OFFSET_Y)),
        blur_radius: px(look::POPUP_SHADOW_BLUR),
        spread_radius: px(0.),
        inset: false,
    }]
}

/// A titled popup's header (vim.ui.select prompt, input, key help): WebStorm's New UI TitlePanel,
/// a bold title centred in 32 px (TitlePanel's label is CENTER-aligned); with a right part the
/// title goes left.
pub fn header(title: impl IntoElement, right: Option<AnyElement>) -> Div {
    let centred = right.is_none();
    div()
        .flex_none()
        .h(px(look::POPUP_TITLE_HEIGHT))
        .px(px(look::POPUP_TITLE_PAD_X))
        .flex()
        .items_center()
        .when(centred, |d| d.justify_center())
        .when(!centred, |d| d.justify_between())
        .gap(px(8.))
        .bg(look::POPUP_HEADER_BG)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_color(look::POPUP_HEADER_TEXT)
                .font_weight(gpui_kit::FontWeight::BOLD)
                .child(title),
        )
        .children(right)
}

/// [`header`] for a title too long for one line (a question, P-12): its lines centred, each
/// [`look::POPUP_TITLE_LINE_HEIGHT`] high inside the same 8 px insets.
pub fn wrapped_header(lines: Vec<SharedString>) -> Div {
    let pad_y = (look::POPUP_TITLE_HEIGHT - look::POPUP_TITLE_LINE_HEIGHT) / 2.;
    div()
        .flex_none()
        .py(px(pad_y))
        .px(px(look::POPUP_TITLE_PAD_X))
        .flex()
        .flex_col()
        .items_center()
        .bg(look::POPUP_HEADER_BG)
        .text_color(look::POPUP_HEADER_TEXT)
        .font_weight(gpui_kit::FontWeight::BOLD)
        .children(lines.into_iter().map(|l| {
            div()
                .h(px(look::POPUP_TITLE_LINE_HEIGHT))
                .max_w_full()
                .flex()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(l)
        }))
}

/// A complex popup's title row (Find in Files, Usages, Switcher, Recent Files / Projects): bold
/// title left in 34 px ("ComplexPopup.Header.insets"), `right` at the right end. The caller draws
/// the 1 px separator under it.
pub fn complex_header(title: impl IntoElement, right: Option<AnyElement>) -> Div {
    div()
        .flex_none()
        .h(px(look::COMPLEX_HEADER_HEIGHT))
        .pl(px(look::COMPLEX_HEADER_PAD_L))
        .pr(px(look::COMPLEX_HEADER_PAD_R))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .bg(look::POPUP_HEADER_BG)
        .child(
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(look::POPUP_HEADER_TEXT)
                .font_weight(gpui_kit::FontWeight::BOLD)
                .child(title),
        )
        .children(right)
}

/// The ad-text footer ("Press ⌘↩ to …"): small dim text, "Popup.Advertiser.borderInsets".
pub fn ad_text(text: impl Into<SharedString>) -> Div {
    div()
        .flex_none()
        .h(px(look::POPUP_AD_HEIGHT))
        .px(px(look::POPUP_AD_PADDING_X))
        .pt(px(look::POPUP_AD_PADDING_TOP.get()))
        .pb(px(look::POPUP_AD_PADDING_BOTTOM.get()))
        .flex()
        .items_center()
        .bg(look::POPUP_AD_BG)
        .text_size(px(look::POPUP_AD_FONT_SIZE))
        .text_color(look::POPUP_AD_FG)
        .whitespace_nowrap()
        .overflow_hidden()
        .child(text.into())
}

/// A list popup separator: a 1 px line inset 8 from the sides (JBUI Popup.separatorInsets).
pub fn separator() -> Div {
    div()
        .flex_none()
        .h(px(look::POPUP_SEPARATOR_HEIGHT))
        .px(px(look::POPUP_SEPARATOR_INSET_X))
        .flex()
        .items_center()
        .child(div().h(px(1.)).w_full().bg(look::SEPARATOR))
}

/// Positions its child by [`place`] once its size is known (like GPUI's `anchored`, which only
/// knows points).
pub struct Placed {
    anchor: Anchor,
    child: AnyElement,
}

/// `child` placed against `anchor`; wrap in `deferred(..)` to draw it over everything.
pub fn placed(anchor: Anchor, child: impl IntoElement) -> Placed {
    Placed {
        anchor,
        child: child.into_any_element(),
    }
}

impl IntoElement for Placed {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Placed {
    type RequestLayoutState = LayoutId;
    type PrepaintState = ();

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
    ) -> (LayoutId, LayoutId) {
        let child = self.child.request_layout(window, cx);
        let style = Style {
            position: Position::Absolute,
            ..Style::default()
        };
        (window.request_layout(style, [child], cx), child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        child: &mut LayoutId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let size = window.layout_bounds(*child).size;
        let origin = place(self.anchor, size, window.viewport_size());
        let offset = origin - bounds.origin;
        window.with_element_offset(point(offset.x.round(), offset.y.round()), |window| {
            self.child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut LayoutId,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::size;

    const VIEW: Size<Pixels> = Size {
        width: px(1000.),
        height: px(800.),
    };
    const M: f32 = look::POPUP_WINDOW_MARGIN;

    fn at(x: f32, y: f32) -> Point<Pixels> {
        point(px(x), px(y))
    }

    struct Place {
        name: &'static str,
        anchor: fn() -> Anchor,
        size: (f32, f32),
        want: (f32, f32),
    }

    const PLACES: &[Place] = &[
        Place {
            name: "a point with room right and below: at the point",
            anchor: || Anchor::Point(at(100., 100.)),
            size: (200., 300.),
            want: (100., 100.),
        },
        Place {
            name: "a point with no room right: left of it",
            anchor: || Anchor::Point(at(900., 100.)),
            size: (200., 300.),
            want: (700., 100.),
        },
        Place {
            name: "a point with no room below: above it",
            anchor: || Anchor::Point(at(100., 700.)),
            size: (200., 300.),
            want: (100., 400.),
        },
        Place {
            name: "a point with no room above or below: clamped inside",
            anchor: || Anchor::Point(at(100., 400.)),
            size: (200., 700.),
            want: (100., 800. - M - 700.),
        },
        Place {
            name: "a rect: below it",
            anchor: || Anchor::Below(Bounds::new(at(50., 10.), size(px(120.), px(30.)))),
            size: (300., 200.),
            want: (50., 40. + ANCHOR_GAP),
        },
        Place {
            name: "a rect at the bottom right: above it, pulled in from the right edge",
            anchor: || Anchor::Below(Bounds::new(at(950., 700.), size(px(2.), px(18.)))),
            size: (300., 200.),
            want: (1000. - M - 300., 700. - ANCHOR_GAP - 200.),
        },
        Place {
            name: "bigger than the window: keeps its top left",
            anchor: || Anchor::Point(at(10., 10.)),
            size: (2000., 2000.),
            want: (M, M),
        },
    ];

    #[test]
    fn popups_flip_to_the_side_with_room_and_stay_in_the_window() {
        for p in PLACES {
            let s = size(px(p.size.0), px(p.size.1));
            assert_eq!(
                place((p.anchor)(), s, VIEW),
                at(p.want.0, p.want.1),
                "{}",
                p.name
            );
        }
    }
}
