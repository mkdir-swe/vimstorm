//! WebStorm's help tooltip (HelpTooltip, small text): the action name and its shortcut in gray,
//! on a rounded dark box. Use through GPUI's `.tooltip(tooltip("Show Diff", Some("⌘D")))`.

use gpui_kit::{
    AnyView, App, AppContext as _, Context, Div, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Window, div, px,
};

use crate::look;

/// The tooltip view GPUI shows over a hovered element.
pub struct Tooltip {
    text: SharedString,
    shortcut: Option<SharedString>,
}

impl Tooltip {
    pub fn new(text: impl Into<SharedString>, shortcut: Option<SharedString>) -> Self {
        Self {
            text: text.into(),
            shortcut,
        }
    }
}

/// A builder for GPUI's `.tooltip(..)`: "Show Diff  ⌘D".
pub fn tooltip(
    text: impl Into<SharedString>,
    shortcut: Option<&str>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    let shortcut: Option<SharedString> = shortcut.map(|s| SharedString::from(s.to_string()));
    move |_, cx| {
        let (text, shortcut) = (text.clone(), shortcut.clone());
        cx.new(|_| Tooltip::new(text, shortcut)).into()
    }
}

/// The tooltip box (colors, border, arc, padding) in the UI font; the caller sets the size.
pub fn frame() -> Div {
    div()
        .font_family(crate::render::UI_FONT)
        .text_color(look::TOOLTIP_FG)
        .bg(look::TOOLTIP_BG)
        .border_1()
        .border_color(look::TOOLTIP_BORDER)
        .rounded(px(look::TOOLTIP_ARC))
        .px(px(look::TOOLTIP_PADDING_X))
        .pt(px(look::TOOLTIP_PADDING_TOP))
        .pb(px(look::TOOLTIP_PADDING_BOTTOM))
}

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        frame()
            .debug_selector(|| "tooltip".into())
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            // under the pointer, not on it
            .mt(px(look::TOOLTIP_OFFSET_Y))
            .flex()
            .gap(px(look::TOOLTIP_SHORTCUT_GAP))
            .child(self.text.clone())
            .children(
                self.shortcut
                    .clone()
                    .map(|s| div().text_color(look::TOOLTIP_SHORTCUT_FG).child(s)),
            )
    }
}
