//! An element placed by a rule once its size is known (window coordinates): the floats' own
//! placement (below / above a code cell, next to the completion menu), which `ui::popup::place`'s
//! two anchors don't cover.

use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, Point, Position, Size, Style, Window, point,
};

/// Top-left corner for a popup of `size` in a window of `viewport` size.
pub type Rule = Box<dyn Fn(Size<Pixels>, Size<Pixels>) -> Point<Pixels>>;

pub struct At {
    rule: Rule,
    child: AnyElement,
}

/// `child` at the corner `rule` picks for its size.
pub fn at(
    rule: impl Fn(Size<Pixels>, Size<Pixels>) -> Point<Pixels> + 'static,
    child: impl IntoElement,
) -> At {
    At {
        rule: Box::new(rule),
        child: child.into_any_element(),
    }
}

impl IntoElement for At {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for At {
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
        let origin = (self.rule)(size, window.viewport_size());
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
