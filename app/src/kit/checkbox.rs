//! WebStorm's New UI checkbox: the theme's own SVGs (`themes/expUI/icons/dark/checkBox*.svg`,
//! a 15 px rounded box on a 24 px canvas; a light theme's in its light palette), tri-state
//! for folders, optional label. Click (or Space while the caller has the keyboard) toggles: the
//! caller owns the state.

use std::rc::Rc;

use gpui_kit::{
    App, ClickEvent, CursorStyle, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};

use super::icons::{Icon, IconName};
use crate::look;

/// Unchecked / checked / some (a folder with some of its files checked).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CheckState {
    #[default]
    Unchecked,
    Checked,
    Mixed,
}

impl CheckState {
    /// What a click makes of it: Mixed and Unchecked check, Checked unchecks (WS
    /// ThreeStateCheckBox in trees).
    pub fn toggled(self) -> Self {
        match self {
            Self::Checked => Self::Unchecked,
            _ => Self::Checked,
        }
    }
}

/// The WS SVG for a state.
pub fn checkbox_icon(state: CheckState, focused: bool) -> IconName {
    match (state, focused) {
        (CheckState::Unchecked, false) => IconName::CheckBox,
        (CheckState::Unchecked, true) => IconName::CheckBoxFocused,
        (CheckState::Checked, false) => IconName::CheckBoxSelected,
        (CheckState::Checked, true) => IconName::CheckBoxSelectedFocused,
        (CheckState::Mixed, false) => IconName::CheckBoxIndeterminate,
        (CheckState::Mixed, true) => IconName::CheckBoxIndeterminateFocused,
    }
}

fn disabled_icon(state: CheckState) -> IconName {
    match state {
        CheckState::Unchecked => IconName::CheckBoxDisabled,
        CheckState::Checked => IconName::CheckBoxSelectedDisabled,
        CheckState::Mixed => IconName::CheckBoxIndeterminateDisabled,
    }
}

/// The box alone, laid out as a [`look::CHECKBOX_SIZE`] square (the SVG's 24 px canvas
/// overhangs it, the drawn box fills it).
pub fn check_box(icon: IconName) -> impl IntoElement {
    let canvas = look::CHECKBOX_CANVAS;
    let off = (look::CHECKBOX_SIZE - canvas) / 2.;
    div()
        .flex_none()
        .relative()
        .size(px(look::CHECKBOX_SIZE))
        .child(
            div()
                .absolute()
                .left(px(off))
                .top(px(off))
                .child(Icon::new(icon).size(px(canvas))),
        )
}

type Handler = Rc<dyn Fn(CheckState, &mut Window, &mut App)>;

/// A checkbox with an optional label ("Amend").
pub struct Checkbox {
    id: ElementId,
    state: CheckState,
    label: Option<SharedString>,
    focused: bool,
    disabled: bool,
    on_toggle: Option<Handler>,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, state: CheckState) -> Self {
        Self {
            id: id.into(),
            state,
            label: None,
            focused: false,
            disabled: false,
            on_toggle: None,
        }
    }

    pub fn label(mut self, text: impl Into<SharedString>) -> Self {
        self.label = Some(text.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Click: called with the new state ([`CheckState::toggled`]).
    pub fn on_toggle(mut self, f: impl Fn(CheckState, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(f));
        self
    }
}

impl IntoElement for Checkbox {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl RenderOnce for Checkbox {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let icon = if self.disabled {
            disabled_icon(self.state)
        } else {
            checkbox_icon(self.state, self.focused)
        };
        let next = self.state.toggled();
        let enabled = !self.disabled;
        div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(px(look::CHECKBOX_LABEL_GAP))
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(if enabled {
                look::TEXT
            } else {
                look::TEXT_DISABLED
            })
            .when(enabled, |d| d.cursor(CursorStyle::PointingHand))
            .child(check_box(icon))
            .children(self.label)
            .when_some(self.on_toggle.filter(|_| enabled), |d, f| {
                d.on_click(move |_: &ClickEvent, window, cx| f(next, window, cx))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggling_and_icons() {
        assert_eq!(CheckState::Unchecked.toggled(), CheckState::Checked);
        assert_eq!(CheckState::Mixed.toggled(), CheckState::Checked);
        assert_eq!(CheckState::Checked.toggled(), CheckState::Unchecked);
        assert_eq!(
            checkbox_icon(CheckState::Mixed, false),
            IconName::CheckBoxIndeterminate
        );
        assert_eq!(
            checkbox_icon(CheckState::Checked, true),
            IconName::CheckBoxSelectedFocused
        );
        assert_eq!(
            disabled_icon(CheckState::Unchecked),
            IconName::CheckBoxDisabled
        );
    }
}
