//! WebStorm's toolbar icon button (ActionButton) and toolbars: a 16 px icon centred in a square
//! hit box, a rounded hover / pressed background, a toggled ("selected") background, the gray
//! disabled icon, the corner triangle of buttons that open a popup, a tooltip ("Show Diff ⌘D").
//! [`toolbar`] lays buttons out in a row or column; [`separator`] is the 1 px divider between
//! groups.
//!
//! Buttons act on click (mouse up over the button, GPUI's `on_click`); a disabled button ignores
//! the mouse. Keyboard access is the owner's (menus / shortcuts), like WS toolbars.

use std::rc::Rc;

use gpui_kit::{
    App, ClickEvent, CursorStyle, Div, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use super::icons::{Icon, IconName};
use super::tooltip::tooltip;
use crate::look;

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A toolbar icon button.
pub struct IconButton {
    id: ElementId,
    icon: IconName,
    toggled: bool,
    disabled: bool,
    dropdown: bool,
    size: Pixels,
    tooltip: Option<(SharedString, Option<SharedString>)>,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    /// `id` must be unique among its siblings (`debug_selector` = the id's text too).
    pub fn new(id: impl Into<ElementId>, icon: IconName) -> Self {
        Self {
            id: id.into(),
            icon,
            toggled: false,
            disabled: false,
            dropdown: false,
            size: px(look::ACTION_BUTTON_SIZE),
            tooltip: None,
            on_click: None,
        }
    }

    /// A toggle action that is on (WS: the selected background).
    pub fn toggled(mut self, on: bool) -> Self {
        self.toggled = on;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Opens a popup: the small corner triangle (WS ActionButton.paintDownArrow).
    pub fn dropdown(mut self, dropdown: bool) -> Self {
        self.dropdown = dropdown;
        self
    }

    /// Tooltip text and shortcut ("Show Diff", Some("⌘D")).
    pub fn tooltip(mut self, text: impl Into<SharedString>, shortcut: Option<&str>) -> Self {
        self.tooltip = Some((text.into(), shortcut.map(|s| s.to_string().into())));
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl IntoElement for IconButton {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl RenderOnce for IconButton {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let selector = format!("button-{}", self.id);
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex_none()
            .relative()
            .size(self.size)
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(look::ACTION_BUTTON_ARC))
            .when(self.toggled, |d| d.bg(look::ACTION_BUTTON_TOGGLED_BG))
            .when(enabled, |d| {
                d.cursor(CursorStyle::PointingHand)
                    .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
                    .active(|s| s.bg(look::ACTION_BUTTON_PRESSED_BG))
            })
            .child(Icon::new(self.icon).disabled(self.disabled))
            .when(self.dropdown, |d| {
                // WS paints AllIcons.General.Dropdown in the bottom-right corner of the box
                d.child(
                    div()
                        .absolute()
                        .right(px(look::ACTION_BUTTON_DROPDOWN_INSET))
                        .bottom(px(look::ACTION_BUTTON_DROPDOWN_INSET))
                        .child(Icon::new(IconName::Dropdown).disabled(self.disabled)),
                )
            })
            .when_some(self.tooltip, |d, (text, key)| {
                d.tooltip(tooltip(text, key.as_deref()))
            })
            .when_some(self.on_click.filter(|_| enabled), |d, f| {
                d.on_click(move |ev, window, cx| {
                    cx.stop_propagation();
                    f(ev, window, cx)
                })
            })
    }
}

/// Toolbar direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// A toolbar: buttons in a row (Horizontal) or column (Vertical) with WS's gap between buttons.
pub fn toolbar(axis: Axis) -> Div {
    let d = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(look::ACTION_BUTTON_GAP));
    match axis {
        Axis::Horizontal => d.flex_row(),
        Axis::Vertical => d.flex_col(),
    }
}

/// The 1 px separator between toolbar groups (vertical line in a horizontal toolbar).
pub fn separator(axis: Axis) -> impl IntoElement {
    let line = div().flex_none().bg(look::TOOLBAR_SEPARATOR);
    let line = match axis {
        Axis::Horizontal => line
            .w(px(look::SEPARATOR_WIDTH))
            .h(px(look::TOOLBAR_SEPARATOR_LENGTH))
            .mx(px(look::TOOLBAR_SEPARATOR_MARGIN)),
        Axis::Vertical => line
            .h(px(look::SEPARATOR_WIDTH))
            .w(px(look::TOOLBAR_SEPARATOR_LENGTH))
            .my(px(look::TOOLBAR_SEPARATOR_MARGIN)),
    };
    line.debug_selector(|| "toolbar-separator".into())
}

/// A text push button (WS Button): "Commit" (primary: blue, the default action) / "Commit and
/// Push…" (secondary: outlined). Click (mouse up over it) runs it; disabled ignores the mouse.
pub struct TextButton {
    id: ElementId,
    label: SharedString,
    primary: bool,
    danger: bool,
    disabled: bool,
    compact: bool,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
    /// The key that presses it, after the label (1.0 design Button: `⏎` on the default, a
    /// letter on a risky one).
    key: Option<SharedString>,
    /// The small look (an inline row action, `vs-button--small`).
    height: Option<f32>,
}

impl TextButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            primary: false,
            danger: false,
            disabled: false,
            compact: false,
            tooltip: None,
            on_click: None,
            key: None,
            height: None,
        }
    }

    /// Its key after the label, dimmer.
    pub fn key(mut self, key: impl Into<SharedString>) -> Self {
        self.key = Some(key.into());
        self
    }

    /// The small look at `height` (20 inside a 26 px row; 24 in an evidence row).
    pub fn small(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }

    /// The compact form for strips and cards (`.vs-button--compact`: 24 tall, 12 px, no 72 min
    /// width).
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    /// A hover tooltip (a disabled button says why).
    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    /// A risky yes (red: filled as the default button, red text and border otherwise).
    pub fn danger(mut self, danger: bool) -> Self {
        self.danger = danger;
        self
    }

    /// The default button (blue).
    pub fn primary(mut self, primary: bool) -> Self {
        self.primary = primary;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl IntoElement for TextButton {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl RenderOnce for TextButton {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let enabled = !self.disabled;
        let selector = format!("button-{}", self.id);
        let (bg, border, fg) = match (self.primary, enabled) {
            (true, true) if self.danger => (
                look::BUTTON_DANGER_BG,
                look::BUTTON_DANGER_BG,
                look::BUTTON_DANGER_FG,
            ),
            (false, true) if self.danger => (
                look::BUTTON_BG,
                look::BUTTON_DANGER_BORDER,
                look::BUTTON_DANGER_TEXT,
            ),
            (true, true) => (
                look::BUTTON_PRIMARY_BG,
                look::BUTTON_PRIMARY_BORDER,
                look::BUTTON_PRIMARY_FG,
            ),
            (false, true) => (look::BUTTON_BG, look::BUTTON_BORDER, look::BUTTON_FG),
            (_, false) => (
                look::BUTTON_DISABLED_BG,
                look::BUTTON_DISABLED_BORDER,
                look::TEXT_DISABLED,
            ),
        };
        let (h, pad, min_w, size) = if self.compact {
            (
                look::COMPACT_BUTTON_HEIGHT,
                look::COMPACT_BUTTON_PAD_X,
                0.,
                look::PR_SMALL_FONT_SIZE,
            )
        } else {
            (
                look::BUTTON_HEIGHT,
                look::BUTTON_PAD_X,
                look::BUTTON_MIN_WIDTH,
                look::UI_FONT_SIZE,
            )
        };
        // the small look (pipelines' inline row actions) at its own height
        let (h, pad, min_w, size) = match self.height {
            Some(height) => (height, 8., 0., look::UI_SMALL_FONT_SIZE),
            None => (h, pad, min_w, size),
        };
        let tip = self.tooltip.clone();
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex_none()
            .h(px(h))
            .px(px(pad))
            .min_w(px(min_w))
            .whitespace_nowrap()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .rounded(px(look::BUTTON_ARC))
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_color(fg)
            .font_family(crate::render::UI_FONT)
            .text_size(px(size))
            .when(enabled, |d| d.cursor(CursorStyle::PointingHand))
            .when_some(tip, |d, t| d.tooltip(tooltip(t, None)))
            .child(self.label)
            .when_some(self.key, |d, key| {
                // white on blue dimmed; on an outlined button the dim text (a danger one keeps
                // its red)
                let key = div().child(key);
                let key = if (self.primary || self.danger) && enabled {
                    key.opacity(look::BUTTON_KEY_OPACITY)
                } else {
                    key.text_color(if enabled {
                        look::TEXT_DIM
                    } else {
                        look::TEXT_DISABLED
                    })
                };
                d.gap(px(look::BUTTON_KEY_GAP)).child(key)
            })
            .when_some(self.on_click.filter(|_| enabled), |d, f| {
                d.on_click(move |ev, window, cx| {
                    cx.stop_propagation();
                    f(ev, window, cx)
                })
            })
    }
}
