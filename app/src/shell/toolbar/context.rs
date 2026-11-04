//! The toolbar's centre (B Signal, boards H-EditorB / H-FactoryB): the shown workspace's
//! context line as small badges (`#2 cart total · Build ● Running 4 min · Local · PR —`, each in
//! its hue at 16 %), the Factory view's (`Factory` then `demo-shop · Sprint 1 · ◆ 1 needs you ·
//! ● 2 running`), or `abe serve not answering` dim. The words are the bridge's
//! ([`crate::factory`]). A click on the line opens Linked as ⌃L does (a `jump
//! {to: linked}` from the toolbar); a badge with an id of its own (the Factory's Needs you) names
//! that id.

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::factory::{self, ContextLine};
use crate::look;

/// The line's box: 24 high, 8 px in, 6 between the badges, the toolbar button's hover.
fn line_box() -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id("toolbar-context")
        .debug_selector(|| "toolbar-context".into())
        .flex_none()
        .h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(look::TAB_ARC.get()))
        .text_size(px(look::TAB_FONT_SIZE.get()))
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(|d| d.bg(look::TOOLBAR_BUTTON_HOVER_BG))
        // (not a window drag)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(|_, window, cx| crate::shell::projects::linked_from_toolbar(window, cx))
}

fn badges(chips: &[crate::factory::Chip]) -> Vec<AnyElement> {
    chips
        .iter()
        .enumerate()
        .map(|(ix, c)| {
            let b = factory::badge(c)
                .id(SharedString::from(format!("toolbar-badge-{ix}")))
                .debug_selector(move || format!("toolbar-badge-{ix}"));
            match c.id.clone() {
                Some(id) => b
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        crate::shell::projects::factory_click(id.clone(), window, cx)
                    })
                    .into_any_element(),
                None => b.into_any_element(),
            }
        })
        .collect()
}

/// The line as drawn; None for [`ContextLine::Title`] (the window title stays). Its hover is the
/// boards' `Linked  ⌃L`; how it reads whole (`label`) is kept with the line for tests (GPUI has
/// no accessibility tree to give it to).
pub(crate) fn line(line: &ContextLine) -> Option<AnyElement> {
    let tip = |_label: &str| crate::kit::tooltip("Linked", Some("⌃L"));
    match line {
        ContextLine::Title => None,
        ContextLine::Down => Some(
            line_box()
                .text_color(look::TEXT_DIM)
                .child("abe serve not answering")
                .into_any_element(),
        ),
        ContextLine::Factory(f) => Some(
            line_box()
                .tooltip(tip(&f.label))
                .child(
                    div()
                        .text_size(px(look::UI_FONT_SIZE))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(look::TEXT)
                        .child("Abe"),
                )
                .children(badges(&f.line))
                .into_any_element(),
        ),
        ContextLine::Badges { chips, label } => Some(
            line_box()
                .tooltip(tip(label))
                .when(chips.is_empty(), |d| d.text_color(look::TEXT_DIM))
                .children(badges(chips))
                .into_any_element(),
        ),
    }
}
