//! Chat's glide (2.2 re-feel): a transcript part that moves on screen by itself (a row appended
//! under it at the bottom, the question card landing, an earlier turn folding on send) is painted
//! where it was and eases to its new place in [`GLIDE`], instead of jumping there in one frame.
//! Layout is never changed (scroll, stick to the bottom, `hold`): only where the parts are painted
//! (FLIP). A part that is new this frame moves with the part above it, so the question card slides
//! in from below with the rows it pushes up. The wheel, `reveal`, `bottom` and a resized column
//! move at once (the reader moved it, or it is laid out anew).
//!
//! On only where the app turned it on ([`enable`], `main.rs`): tests see the layout's places
//! unless they turn it on and move the executor's clock.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use super::anchor::Anchor;
use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, Global, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, ScrollHandle, Window, point, px,
};

/// How long a glide takes: short, eased out, no bounce (macOS list moves are 150–250 ms).
pub const GLIDE: Duration = Duration::from_millis(200);

/// Glides are on (the app's window; a test that films them).
pub struct GlideOn;

impl Global for GlideOn {}

/// Turns glides on for every transcript the app draws.
pub fn enable(cx: &mut App) {
    cx.set_global(GlideOn);
}

/// One part's glide: painted `from` px off its place at `start`, eased to 0 over [`GLIDE`].
#[derive(Clone, Copy, Debug, PartialEq)]
struct Move {
    from: f32,
    start: Instant,
}

impl Move {
    fn at(&self, now: Instant) -> f32 {
        let t = now.saturating_duration_since(self.start).as_secs_f32() / GLIDE.as_secs_f32();
        if t >= 1. {
            0.
        } else {
            // ease-out quad: starts at twice the mean speed (a cubic's thrice reads as a jump),
            // and a new move mid-glide goes on at speed rather than stopping to start again
            self.from * (1. - t).powi(2)
        }
    }
}

/// What a transcript's glide keeps across frames.
#[derive(Default, Debug)]
pub struct Glide {
    /// Each part's place last frame (its top from the column's bottom edge, unglided).
    last: HashMap<String, f32>,
    next: HashMap<String, f32>,
    moves: HashMap<String, Move>,
    /// The column's bounds last frame: other bounds, it was laid out anew (no glide).
    view: Option<Bounds<Pixels>>,
    /// The parts were laid out at another width last frame (the first frame wraps prose at a
    /// guess, a resize): the next frame re-wraps them, which is no move of theirs.
    relaid: bool,
    /// The scroll offset the last frame ended with: another one now is the wheel's.
    offset: Option<f32>,
    /// This frame may glide (set by [`Glide::begin`], cleared by a new column).
    allowed: bool,
    /// The column's bounds were checked this frame.
    viewed: bool,
    /// The move of the part placed just before, this frame (a new part takes it).
    above: Option<Move>,
}

impl Glide {
    /// A new frame. `on`: glides are on and the system does not ask for reduced motion.
    /// `offset` is the scroll's offset now (before layout): another than the one the last frame
    /// ended with means the wheel moved it. `jumped`: a `reveal` or `bottom` applied.
    pub fn begin(&mut self, on: bool, offset: f32, jumped: bool) {
        let wheeled = self.offset.is_some_and(|o| (o - offset).abs() > 0.5);
        let relaid = std::mem::take(&mut self.relaid);
        self.allowed = on && !wheeled && !jumped && !relaid;
        if !self.allowed {
            self.moves.clear();
        }
        self.viewed = false;
        self.above = None;
        self.next.clear();
    }

    /// Where to paint the part `key` laid out at `top` (window px) in the column `view`: the
    /// offset from its place. `drawn`: it was drawn last frame (its element state carried over;
    /// not, its place here is stale: the column was hidden, another card shown, the view away).
    pub fn place(
        &mut self,
        key: &str,
        drawn: bool,
        top: f32,
        view: Bounds<Pixels>,
        now: Instant,
    ) -> f32 {
        if !self.viewed {
            self.viewed = true;
            if self.view != Some(view) {
                self.view = Some(view);
                self.allowed = false;
                self.moves.clear();
            }
        }
        let tall = view.size.height.as_f32();
        let y = top - view.bottom().as_f32();
        // a repeated id: the second part is drawn in its place (two parts can't share a glide)
        if self.next.insert(key.to_owned(), y).is_some() {
            return 0.;
        }
        let current = self.moves.get(key).map_or(0., |m| m.at(now));
        let moved = match self.last.get(key).filter(|_| drawn) {
            // where it was painted, from where it is now
            Some(old) if (old - y).abs() > 0.5 => {
                let from = old + current - y;
                (self.allowed && from.abs() <= tall).then_some(Move { from, start: now })
            }
            Some(_) => self.moves.get(key).copied(),
            // new: with the part above it
            None => self.above.filter(|_| self.allowed),
        };
        let moved = moved.filter(|m| m.at(now) != 0.);
        match moved {
            Some(m) => self.moves.insert(key.to_owned(), m),
            None => self.moves.remove(key),
        };
        self.above = moved;
        moved.map_or(0., |m| m.at(now))
    }

    /// The frame ended with the scroll at `offset`: parts not placed are gone.
    pub fn end(&mut self, offset: f32) {
        self.last = std::mem::take(&mut self.next);
        let last = &self.last;
        self.moves.retain(|k, _| last.contains_key(k));
        self.offset = Some(offset);
    }

    /// Some part is still gliding.
    pub fn moving(&self) -> bool {
        !self.moves.is_empty()
    }

    /// The parts were laid out at another width this frame: the next frame's re-wrap is no move.
    pub fn relaid(&mut self) {
        self.relaid = true;
    }

    /// Forget every place: the next frame draws where it lays out.
    pub fn reset(&mut self) {
        self.last.clear();
        self.moves.clear();
        self.view = None;
        self.offset = None;
    }
}

/// A transcript part painted at its glide's offset (its layout untouched); its layout told to the
/// transcript's scroll anchor.
pub struct Glided {
    pub key: String,
    pub glide: Rc<RefCell<Glide>>,
    pub anchor: Rc<RefCell<Anchor>>,
    pub scroll: ScrollHandle,
    pub child: AnyElement,
}

impl IntoElement for Glided {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Glided {
    type RequestLayoutState = ();
    type PrepaintState = ();

    /// The part's id: its element state says whether it was drawn last frame.
    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Name(self.key.clone().into()))
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
    ) -> (LayoutId, ()) {
        let id = self.child.request_layout(window, cx);
        self.anchor.borrow_mut().laid(&self.key, id);
        (id, ())
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let now = cx.background_executor().now();
        let drawn =
            id.is_some_and(|id| window.with_element_state::<(), _>(id, |s, _| (s.is_some(), ())));
        let dy = self.glide.borrow_mut().place(
            &self.key,
            drawn,
            bounds.top().as_f32(),
            self.scroll.bounds(),
            now,
        );
        window.with_element_offset(point(px(0.), px(dy.round())), |window| {
            self.child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
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
    use gpui_kit::{point, size};

    fn view() -> Bounds<Pixels> {
        Bounds::new(point(px(0.), px(100.)), size(px(420.), px(600.)))
    }

    /// One frame: each (key, top) placed, the offsets back.
    fn frame(g: &mut Glide, parts: &[(&str, f32)], now: Instant, offset: f32) -> Vec<f32> {
        g.begin(true, offset, false);
        let out = parts
            .iter()
            .map(|(k, t)| g.place(k, true, *t, view(), now))
            .collect();
        g.end(offset);
        out
    }

    #[test]
    fn a_card_landing_paints_the_parts_where_they_were_then_eases_them_up() {
        let t0 = Instant::now();
        let mut g = Glide::default();
        assert_eq!(frame(&mut g, &[("a", 500.), ("b", 600.)], t0, 0.), [0., 0.]);
        // the card (400 px) lands at the bottom: a and b laid out 400 px higher
        let at = frame(&mut g, &[("a", 100.), ("b", 200.), ("card", 300.)], t0, 0.);
        assert_eq!(
            at,
            [400., 400., 400.],
            "a, b where they were; the card under b"
        );
        let mid = frame(
            &mut g,
            &[("a", 100.), ("b", 200.), ("card", 300.)],
            t0 + GLIDE / 2,
            0.,
        );
        assert!(
            mid[0] > 0. && mid[0] <= 100.,
            "eased out, most of the way: {mid:?}"
        );
        assert_eq!(mid[0], mid[2], "the card moves with the rows above it");
        let end = frame(
            &mut g,
            &[("a", 100.), ("b", 200.), ("card", 300.)],
            t0 + GLIDE,
            0.,
        );
        assert_eq!(end, [0., 0., 0.]);
        assert!(!g.moving());
    }

    struct AtOnce {
        name: &'static str,
        /// The scroll offset last frame and this frame.
        offsets: (f32, f32),
        width: f32,
        jump: bool,
        drawn_last_frame: bool,
        /// `a`'s top this frame (500 last frame).
        top: f32,
    }

    const AT_ONCE: &[AtOnce] = &[
        AtOnce {
            name: "the wheel moved the offset",
            offsets: (-100., -300.),
            width: 420.,
            jump: false,
            drawn_last_frame: true,
            top: 700.,
        },
        AtOnce {
            name: "a new column width",
            offsets: (0., 0.),
            width: 640.,
            jump: false,
            drawn_last_frame: true,
            top: 300.,
        },
        AtOnce {
            name: "a jump",
            offsets: (0., 0.),
            width: 420.,
            jump: true,
            drawn_last_frame: true,
            top: 100.,
        },
        AtOnce {
            name: "a part not drawn last frame lands in place",
            offsets: (0., 0.),
            width: 420.,
            jump: false,
            drawn_last_frame: false,
            top: 300.,
        },
    ];

    #[test]
    fn a_part_moves_at_once_without_a_glide() {
        for row in AT_ONCE {
            let t0 = Instant::now();
            let mut g = Glide::default();
            frame(&mut g, &[("a", 500.)], t0, row.offsets.0);
            g.begin(true, row.offsets.1, row.jump);
            let bounds = Bounds::new(point(px(0.), px(100.)), size(px(row.width), px(600.)));
            let at = g.place("a", row.drawn_last_frame, row.top, bounds, t0);
            g.end(row.offsets.1);
            assert_eq!(at, 0., "{}", row.name);
        }
    }

    #[test]
    fn a_move_mid_glide_starts_where_it_is_painted() {
        let t0 = Instant::now();
        let mut g = Glide::default();
        frame(&mut g, &[("a", 500.)], t0, 0.);
        frame(&mut g, &[("a", 476.)], t0, 0.);
        let half = t0 + GLIDE / 3;
        let painted = 476. + frame(&mut g, &[("a", 476.)], half, 0.)[0];
        // another row appended: laid out 24 px higher again
        let now = frame(&mut g, &[("a", 452.)], half, 0.)[0];
        assert!((452. + now - painted).abs() < 0.01, "no step");
    }

    #[test]
    fn redrawn_in_place_a_glide_goes_on_and_ends() {
        let t0 = Instant::now();
        let mut g = Glide::default();
        frame(&mut g, &[("a", 500.)], t0, 0.);
        let first = frame(&mut g, &[("a", 476.)], t0, 0.)[0];
        // two draws per frame (the shots build) or a tick: the same glide, not a new one
        let again = frame(&mut g, &[("a", 476.)], t0, 0.)[0];
        assert_eq!(first, again);
        assert_eq!(frame(&mut g, &[("a", 476.)], t0 + GLIDE, 0.), [0.]);
    }

    #[test]
    fn a_part_that_goes_leaves_nothing_behind() {
        let t0 = Instant::now();
        let mut g = Glide::default();
        frame(&mut g, &[("a", 500.), ("b", 524.)], t0, 0.);
        frame(&mut g, &[("a", 476.)], t0, 0.);
        assert_eq!(g.moves.len(), 1);
        assert!(!g.last.contains_key("b"));
    }
}
