//! The flow dialog the Git window's PR flows use (`.vs-flow`, the card-dialog look N03; RULES 18:
//! a flow with inputs or consequences is a dialog, the primary blue with its key): Submit review
//! (G19, [`super::submit`]) and Create Draft PR (G20, [`super::publication`]). Centred near the
//! top of the window over a backdrop that keeps the mouse; the parts: the title row (bold name,
//! dim subject, ×), sections with a heading and a dim note, choice cards (a radio in a box), the
//! labelled grid rows, the footer (a dim note, Cancel, the primary button with its key).

use gpui_kit::{
    AnyElement, App, Div, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    deferred, div, point, prelude::FluentBuilder as _, px,
};

use crate::kit::{Anchor, centered, placed};
use crate::kit::{Icon, IconName};
use crate::look;
use crate::render::ui_font;

/// The dialog's frame centred near the window's top, over a backdrop that keeps the mouse (a click
/// outside does nothing: the dialog closes with Cancel, × or Esc).
pub fn overlay(
    id: &'static str,
    width: f32,
    frame: impl IntoElement,
    window: &Window,
) -> AnyElement {
    let view = window.viewport_size();
    let x = centered(width, view.width.as_f32());
    let backdrop = div()
        .id(id)
        .debug_selector(move || id.to_owned())
        .w(view.width)
        .h(view.height)
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .absolute()
                .left(px(x))
                .top(px(look::FLOW_TOP))
                .w(px(width))
                .child(frame),
        );
    deferred(placed(Anchor::Point(point(px(0.), px(0.))), backdrop))
        .with_priority(3)
        .into_any_element()
}

/// The frame `width` wide: the popup's background, border, radius and shadow, the UI font.
pub fn frame(width: f32) -> Div {
    crate::kit::popup_frame()
        .w(px(width))
        .border_color(look::POPUP_BORDER)
        .rounded(px(look::POPUP_ARC))
        .font(ui_font())
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
}

/// The title row: the bold name, then what it is about (dim, cut), the close ×.
pub fn title(
    name: &str,
    accent: Option<String>,
    sub: &str,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    div()
        .flex_none()
        .h(px(look::FLOW_TITLE_HEIGHT))
        .pl(px(16.))
        .pr(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .bg(look::POPUP_HEADER_BG)
        .border_b_1()
        .border_color(look::SEPARATOR)
        .whitespace_nowrap()
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::SEMIBOLD)
                .child(SharedString::from(name.to_owned())),
        )
        .when_some(accent, |d, a| {
            d.child(
                div()
                    .flex_none()
                    .font_family(crate::render::EDITOR_FONT)
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::ABE_ACCENT)
                    .child(SharedString::from(a)),
            )
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(sub.to_owned())),
        )
        .child(
            div()
                .id("flow-close")
                .debug_selector(|| "flow-close".into())
                .flex_none()
                .size(px(look::ACTION_BUTTON_SIZE))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(look::ACTION_BUTTON_ARC))
                .cursor_pointer()
                .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
                .on_click(move |_, window, cx| on_close(window, cx))
                .child(Icon::new(IconName::Close)),
        )
        .into_any_element()
}

/// A section: its heading and a dim note, then `body`.
pub fn section(heading: &str, note: Option<&str>, body: impl IntoElement) -> Div {
    div()
        .flex_none()
        .px(px(look::FLOW_SECTION_PAD_X))
        .pt(px(look::FLOW_SECTION_PAD_TOP))
        .pb(px(look::FLOW_SECTION_PAD_BOTTOM))
        .border_b_1()
        .border_color(look::SEPARATOR)
        .child(
            div()
                .flex()
                .items_baseline()
                .gap(px(8.))
                .mb(px(8.))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(SharedString::from(heading.to_owned())),
                )
                .when_some(note, |d, n| {
                    d.child(
                        div()
                            .text_size(px(look::PR_SMALL_FONT_SIZE))
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(n.to_owned())),
                    )
                }),
        )
        .child(body)
}

/// A choice card (`.vs-choice`): a radio and its title, a dim line under it; selected = the
/// focus border on the inactive selection.
pub fn choice(
    id: &'static str,
    title: &str,
    desc: &str,
    selected: bool,
    on_pick: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let radio = div().flex_none().size(px(14.)).rounded(px(7.)).map(|d| {
        if selected {
            d.border_4()
                .border_color(look::FOCUS_BORDER)
                .bg(look::BUTTON_PRIMARY_FG)
        } else {
            d.border_1().border_color(look::BUTTON_BORDER)
        }
    });
    div()
        .id(id)
        .debug_selector(move || id.to_owned())
        .flex_1()
        .min_w_0()
        .h(px(look::FLOW_CHOICE_HEIGHT))
        .px(px(12.))
        .py(px(10.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .rounded(px(look::BUTTON_ARC))
        .border_1()
        .cursor_pointer()
        .map(|d| {
            if selected {
                d.border_color(look::FOCUS_BORDER)
                    .bg(look::SELECTION_BG_INACTIVE)
            } else {
                d.border_color(look::BUTTON_BORDER)
            }
        })
        .on_click(move |_, window, cx| on_pick(window, cx))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .font_weight(FontWeight::SEMIBOLD)
                .whitespace_nowrap()
                .child(radio)
                .child(SharedString::from(title.to_owned())),
        )
        .child(
            div()
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(desc.to_owned())),
        )
        .into_any_element()
}

/// A labelled row of the dialog's grid (`.vs-flow__grid`: the label column 96 wide).
pub fn row(label: &str, top: bool, value: impl IntoElement) -> Div {
    div()
        .flex()
        .when(!top, |d| d.items_center())
        .gap(px(12.))
        .child(
            div()
                .flex_none()
                .w(px(look::FLOW_LABEL_WIDTH))
                .when(top, |d| d.pt(px(8.)))
                .child(SharedString::from(label.to_owned())),
        )
        .child(div().flex_1().min_w_0().child(value))
}

/// The footer: a dim note (or an error), then the buttons.
pub fn foot(note: SharedString, error: bool, buttons: Vec<AnyElement>) -> AnyElement {
    div()
        .flex_none()
        .h(px(look::FLOW_FOOT_HEIGHT))
        .px(px(16.))
        .flex()
        .items_center()
        .gap(px(8.))
        .child(
            div()
                .debug_selector(|| "flow-note".into())
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .text_color(if error {
                    look::TEXT_ERROR
                } else {
                    look::TEXT_DIM
                })
                .child(note),
        )
        .children(buttons)
        .into_any_element()
}
