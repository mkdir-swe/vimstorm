//! The pulse: an element fading 1 → 0.35 → 1 every 1.2 s (a Starting dot, a running step's
//! mark, a live session's dot).

use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, Div, ElementId, IntoElement, Styled as _,
    pulsating_between,
};

use crate::look;

/// `el` pulsing (`id` names it among its siblings).
pub fn pulsing(id: impl Into<ElementId>, el: Div) -> AnyElement {
    el.with_animation(
        id,
        Animation::new(std::time::Duration::from_secs_f32(
            look::STARTING_PULSE_SECS,
        ))
        .repeat()
        .with_easing(pulsating_between(look::STARTING_PULSE_MIN, 1.))
        .with_max_fps(20.),
        |el, delta| el.opacity(delta),
    )
    .into_any_element()
}
