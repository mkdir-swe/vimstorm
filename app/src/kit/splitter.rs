//! A split between two panes with WebStorm's divider (OnePixelSplitter): a 1 px line, a wider
//! invisible grab zone over it, the resize cursor; dragging moves it (clamped to both panes'
//! minimum sizes). One pane has the fixed size ([`SplitState`]: WS's log keeps the details
//! pane's width when the window resizes); the other takes the rest.
//!
//! `split(id, state, first, second)` draws it; the state is an entity the owner keeps (and
//! persists from [`SplitEvent::Resized`]).

use gpui_kit::{
    AnyElement, App, Bounds, Context, CursorStyle, DispatchPhase, Entity, EventEmitter,
    HitboxBehavior, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Styled as _, canvas, div,
    prelude::FluentBuilder as _, px,
};

use crate::look;

/// Which way the panes go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitAxis {
    /// Side by side, a vertical divider.
    Horizontal,
    /// One above the other, a horizontal divider.
    Vertical,
}

/// Which pane keeps its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fixed {
    First,
    Second,
}

/// The divider moved (drag end): the fixed pane's new size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitEvent {
    pub size: Pixels,
}

/// Split geometry: the fixed pane's size and the limits.
pub struct SplitState {
    pub axis: SplitAxis,
    pub fixed: Fixed,
    /// The fixed pane's size.
    size: Pixels,
    pub min_first: Pixels,
    pub min_second: Pixels,
    /// The split's length along the axis (last layout).
    total: Pixels,
    /// Mouse position and size when the drag started.
    drag: Option<(Pixels, Pixels)>,
}

impl EventEmitter<SplitEvent> for SplitState {}

impl SplitState {
    pub fn new(axis: SplitAxis, fixed: Fixed, size: Pixels) -> Self {
        Self {
            axis,
            fixed,
            size,
            min_first: px(look::SPLITTER_MIN_PANE),
            min_second: px(look::SPLITTER_MIN_PANE),
            total: px(0.),
            drag: None,
        }
    }

    pub fn with_min(mut self, first: Pixels, second: Pixels) -> Self {
        self.min_first = first;
        self.min_second = second;
        self
    }

    /// The fixed pane's size as asked (before clamping to the current layout).
    pub fn size(&self) -> Pixels {
        self.size
    }

    pub fn set_size(&mut self, size: Pixels, cx: &mut Context<Self>) {
        self.size = size;
        cx.notify();
    }

    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// The first pane's length in a split `total` long (pure rule; divider takes 1 px).
    pub fn first_len(&self, total: Pixels) -> Pixels {
        let line = px(look::SEPARATOR_WIDTH);
        let avail = (total - line).max(px(0.));
        let first = match self.fixed {
            Fixed::First => self.size,
            Fixed::Second => avail - self.size,
        };
        clamp(first, self.min_first, avail - self.min_second)
    }

    fn along(&self, p: gpui_kit::Point<Pixels>) -> Pixels {
        match self.axis {
            SplitAxis::Horizontal => p.x,
            SplitAxis::Vertical => p.y,
        }
    }

    fn drag_to(&mut self, pos: Pixels, cx: &mut Context<Self>) {
        let Some((start, size)) = self.drag else {
            return;
        };
        let delta = pos - start;
        let new = match self.fixed {
            Fixed::First => size + delta,
            Fixed::Second => size - delta,
        };
        // keep both panes' minimums
        let line = px(look::SEPARATOR_WIDTH);
        let avail = (self.total - line).max(px(0.));
        let (min_fixed, min_other) = match self.fixed {
            Fixed::First => (self.min_first, self.min_second),
            Fixed::Second => (self.min_second, self.min_first),
        };
        self.size = clamp(new, min_fixed, avail - min_other);
        cx.notify();
    }
}

fn clamp(v: Pixels, lo: Pixels, hi: Pixels) -> Pixels {
    if hi < lo { lo } else { v.max(lo).min(hi) }
}

/// The two panes with the divider between them.
pub fn split(
    id: &'static str,
    state: &Entity<SplitState>,
    first: impl IntoElement,
    second: impl IntoElement,
    cx: &App,
) -> AnyElement {
    let s = state.read(cx);
    let axis = s.axis;
    let first_len = s.first_len(s.total);
    let measured = s.total > px(0.);
    let dragging = s.dragging();
    let horizontal = axis == SplitAxis::Horizontal;
    let grab = px(look::SPLITTER_GRAB);
    let st = state.downgrade();
    // the split's length, for the next layout / drag clamping
    let measure = canvas(
        move |bounds: Bounds<Pixels>, window, cx| {
            let total = if horizontal {
                bounds.size.width
            } else {
                bounds.size.height
            };
            let changed = st
                .update(cx, |s, cx| {
                    let changed = s.total != total;
                    if changed {
                        s.total = total;
                        cx.notify();
                    }
                    changed
                })
                .unwrap_or(false);
            // the owner view may not observe the state: draw again with the new length
            if changed {
                window.refresh();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full();
    // while dragging: mouse moves / ups anywhere in the window
    let st = state.downgrade();
    let drag_events = dragging.then(|| {
        canvas(
            |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
            move |_, _, window, _| {
                let st2 = st.clone();
                window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = st.update(cx, |s, cx| {
                            let p = s.along(ev.position);
                            s.drag_to(p, cx)
                        });
                        window.refresh();
                    }
                });
                window.on_mouse_event(move |_: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = st2.update(cx, |s, cx| {
                            s.drag = None;
                            cx.emit(SplitEvent { size: s.size });
                            cx.notify();
                        });
                        window.refresh();
                    }
                });
            },
        )
        .absolute()
        .size_full()
    });
    let st = state.downgrade();
    let cursor = if horizontal {
        CursorStyle::ResizeColumn
    } else {
        CursorStyle::ResizeRow
    };
    let handle = div()
        .id((id, 1usize))
        .debug_selector(move || format!("{id}-divider"))
        .absolute()
        .cursor(cursor)
        .map(|d| {
            if horizontal {
                d.top_0()
                    .bottom_0()
                    .left(first_len - grab / 2.)
                    .w(grab + px(look::SEPARATOR_WIDTH))
            } else {
                d.left_0()
                    .right_0()
                    .top(first_len - grab / 2.)
                    .h(grab + px(look::SEPARATOR_WIDTH))
            }
        })
        .on_mouse_down(MouseButton::Left, move |ev: &MouseDownEvent, window, cx| {
            cx.stop_propagation();
            let _ = st.update(cx, |s, cx| {
                s.drag = Some((s.along(ev.position), s.size));
                cx.notify();
            });
            window.refresh();
        });
    let line = div().flex_none().bg(look::SPLITTER_LINE).map(|d| {
        if horizontal {
            d.w(px(look::SEPARATOR_WIDTH)).h_full()
        } else {
            d.h(px(look::SEPARATOR_WIDTH)).w_full()
        }
    });
    let pane = |e: AnyElement, len: Option<Pixels>| {
        div()
            .relative()
            .overflow_hidden()
            .map(|d| match (len, horizontal) {
                (Some(l), true) => d.flex_none().w(l).h_full(),
                (Some(l), false) => d.flex_none().h(l).w_full(),
                (None, true) => d.flex_1().min_w_0().h_full(),
                (None, false) => d.flex_1().min_h_0().w_full(),
            })
            .child(e)
    };
    div()
        .id(id)
        .relative()
        .size_full()
        .flex()
        .when(!horizontal, |d| d.flex_col())
        .child(measure)
        // until the first layout the first pane takes half
        .child(pane(
            first.into_any_element(),
            measured.then_some(first_len),
        ))
        .child(line)
        .child(pane(second.into_any_element(), None))
        .child(handle)
        .children(drag_events)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_pane_length_keeps_minimums() {
        let mut s = SplitState::new(SplitAxis::Horizontal, Fixed::Second, px(300.));
        s.min_first = px(100.);
        s.min_second = px(150.);
        // second fixed: first takes the rest (minus the 1 px line)
        assert_eq!(s.first_len(px(1001.)), px(700.));
        // too small for the fixed size: the first keeps its minimum
        assert_eq!(s.first_len(px(351.)), px(100.));
        assert_eq!(s.first_len(px(201.)), px(100.));
        s.fixed = Fixed::First;
        s.size = px(50.);
        assert_eq!(s.first_len(px(1001.)), px(100.));
    }
}
