//! The toolbar's pieces: a dropdown widget (WebStorm's `ToolbarComboButton`), the project icon.

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, Context, Element, ElementId, FontWeight, GlobalElementId,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, MouseUpEvent,
    ParentElement as _, Pixels, Position, SharedString, Stateful, StatefulInteractiveElement as _,
    Style, Styled as _, Window, div, linear_color_stop, linear_gradient, point, px,
};

use crate::kit;
use crate::kit::{Icon, IconName};
use crate::kit::{ListDelegate, ListView};
use crate::look;
use crate::render;
use crate::shell::recent;

/// Where an element was painted last (popups anchor below their widget).
pub type BoundsCell = Rc<Cell<Bounds<Pixels>>>;

/// A main toolbar icon button (MainToolbar ActionButton): 26 px, the transparent rounded hover /
/// pressed background, a tooltip.
pub fn icon_button(
    id: &'static str,
    icon: IconName,
    tip: &'static str,
    shortcut: Option<&'static str>,
) -> Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex_none()
        .size(px(look::TOOLBAR_BUTTON_SIZE.get()))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(look::TOOLBAR_BUTTON_ARC.get()))
        .cursor_pointer()
        .hover(|s| s.bg(look::TOOLBAR_BUTTON_HOVER_BG))
        .active(|s| s.bg(look::TOOLBAR_BUTTON_PRESSED_BG))
        .tooltip(crate::kit::tooltip(tip, shortcut))
        .child(Icon::new(icon))
}

/// Offscreen shots (`--features shots`): AppKit draws the real traffic lights outside the GPUI
/// scene, so the shot gets stand-ins where they sit (x 13 / 33 / 53, Ø12, centred in the toolbar).
#[cfg(feature = "shots")]
pub fn traffic_lights() -> Option<AnyElement> {
    std::env::var_os("VIMSTORM_SHOT")?;
    const LIGHTS: [(u32, u32); 3] = [
        (0xFF5F57, 0xE0443E),
        (0xFEBC2E, 0xDEA123),
        (0x28C840, 0x1AAC29),
    ];
    let d = 12.;
    Some(
        div()
            .absolute()
            .left_0()
            .top_0()
            .size_full()
            .children(LIGHTS.iter().enumerate().map(|(i, (fill, ring))| {
                div()
                    .absolute()
                    .left(px(13. + 20. * i as f32))
                    .top(px((look::TOOLBAR_HEIGHT - d) / 2.))
                    .size(px(d))
                    .rounded_full()
                    .bg(gpui_kit::rgb(*fill))
                    .border(px(0.5))
                    .border_color(gpui_kit::rgb(*ring))
            }))
            .into_any_element(),
    )
}

/// WebStorm's generated project icon: the initials in white JetBrains Mono semibold on a
/// rounded square with the palette's diagonal gradient (`AvatarUtils.generateColoredAvatar`).
pub fn project_icon(name: &str, color: usize, size: f32) -> impl IntoElement {
    let (start, end) = look::PROJECT_ICON_COLORS[color % look::PROJECT_ICON_COLORS.len()];
    // GradientPaint from the bottom-left (end) to the top-right (start): 45° in CSS terms
    let bg = linear_gradient(
        45.,
        linear_color_stop(look::hsla(end), 0.),
        linear_color_stop(look::hsla(start), 1.),
    );
    div()
        .flex_none()
        .size(px(size))
        .rounded(px(size * look::PROJECT_ICON_ARC_RATIO / 2.))
        .bg(bg)
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .font_family(render::EDITOR_FONT)
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(px((size * look::PROJECT_ICON_FONT_RATIO).floor()))
        .line_height(px(size))
        .text_color(gpui_kit::white())
        .child(SharedString::from(recent::initials(name)))
}

/// A popup row acts on a single click (WebStorm popups; the list itself confirms on a double
/// click): the row content's mouse-up listener.
pub fn click_confirms<D: ListDelegate>(
    ix: usize,
    cx: &mut Context<ListView<D>>,
) -> impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static {
    cx.listener(move |this, _: &MouseUpEvent, window, cx| {
        let ListView {
            delegate, state, ..
        } = this;
        delegate.confirm(ix, state, window, cx);
    })
}

/// A popup under a widget, placed by [`kit::place`] at prepaint with the widget's bounds of
/// the same frame (deferred popups prepaint after the widgets; `kit::placed` takes the anchor
/// at render time, which is the previous frame's: none yet on a window's first frame).
pub struct BelowWidget {
    widget: BoundsCell,
    child: AnyElement,
}

pub fn below_widget(widget: &BoundsCell, child: impl IntoElement) -> BelowWidget {
    BelowWidget {
        widget: widget.clone(),
        child: child.into_any_element(),
    }
}

impl IntoElement for BelowWidget {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for BelowWidget {
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
        let anchor = kit::Anchor::Below(self.widget.get());
        let origin = kit::place(anchor, size, window.viewport_size());
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
