//! Chat's status line, the Rust half of `ChatStatus` in `abe/packages/ui/src/chat/composer.ts`:
//! one 24 px line right above the composer, what the agent does now (a pulsing dot while it works,
//! `Thinking`, `Reading cart.ts`, `Waiting on you`, `Idle · your turn`) and for how long, counted
//! here from `since` every second (no bridge round trip), and at its right `N subagents` (a click
//! folds their list). Unfolded, the list above it: each run's state mark, name and task, its last
//! tool (its result once done) and its time; the selected one tinted, a click goes to its Agent
//! call in the transcript. Props in, pixels out.
//!
//! In a slot (Chat's) the line and the tree's other working dots ([`pulse`]) are a view of their
//! own, [`Live`], drawn over the slot's cached view by its host ([`super::SlotView::hosted`]): the
//! slot's tree only keeps their room ([`Spot`]), so the clock's tick and a dot's pulse draw them
//! alone, never the slot and its transcript (gpui draws every cached view inside one it draws
//! again anew).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::{
    AnyElement, App, AvailableSpace, Bounds, Context, Element, ElementId, GlobalElementId,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, ParentElement as _, Pixels,
    Render, Rgba, SharedString, StatefulInteractiveElement as _, Style, Styled as _, Window,
    canvas, div, prelude::FluentBuilder as _, px,
};

use super::composer::{ChatStatusProps, SubagentRow, Tone};
use super::draw::{Drawn, Sink, Sub, clickable, selector};
use crate::kit::{Icon, IconName};
use crate::look;

/// px: the line, a listed run's row, the dot's column, the gaps.
pub const LINE_H: f32 = 24.;
pub const ROW_H: f32 = 22.;
const DOT_W: f32 = 10.;
const GAP: f32 = 6.;
const LIST_PAD: f32 = 4.;
const LIST_GAP: f32 = 2.;

/// What [`Drawn`] records while a time ticks on the line: its view draws again every second.
pub const CLOCK: &str = "ChatStatusClock";

/// Now, in epoch ms.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |d| d.as_secs_f64() * 1000.)
}

/// A span of time as the line says it: `8s`, `1m 05s`, `1h 02m`.
pub fn elapsed(ms: f64) -> String {
    let s = (ms.max(0.) / 1000.).floor() as u64;
    match (s / 3600, (s / 60) % 60, s % 60) {
        (0, 0, s) => format!("{s}s"),
        (0, m, s) => format!("{m}m {s:02}s"),
        (h, m, _) => format!("{h}h {m:02}m"),
    }
}

fn tone_color(t: Tone) -> Rgba {
    match t {
        Tone::Working => look::ABE_WARN.rgba(),
        Tone::Waiting => look::ABE_NEEDS_YOU.rgba(),
        Tone::Idle | Tone::Starting => look::TEXT_DIM.rgba(),
    }
}

fn small(text: impl Into<SharedString>, color: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(color)
        .child(text.into())
}

/// The line's height, and the list's above it while unfolded.
fn height(p: &ChatStatusProps) -> f32 {
    let list = if p.list.is_empty() {
        0.
    } else {
        p.list.len() as f32 * ROW_H + 2. * (LIST_PAD + look::POPUP_BORDER_WIDTH) + LIST_GAP
    };
    LINE_H + list
}

/// The line, and above it the list while unfolded: in a slot whose host draws its [`Live`]
/// view, only its room here; else drawn in place.
pub fn status(id: Option<&str>, p: &ChatStatusProps, drawn: &mut Drawn) -> AnyElement {
    match drawn.line.clone() {
        Some(spot) => spot.keep(id, p, drawn),
        None => draw(id, p, drawn),
    }
}

/// What a slot's tree said of its live parts (the status line, the working dots) and where it
/// keeps their room: its [`Live`] view draws them there.
#[derive(Debug)]
pub struct Spot {
    said: RefCell<Option<Said>>,
    at: Cell<Option<Bounds<Pixels>>>,
    dots: RefCell<Vec<Rc<Dot>>>,
    /// What the line drew last (the slot's drawing reads it in place: [`Drawn::merged`]).
    out: Rc<RefCell<Drawn>>,
    /// Where its items' selectors start: a range of its own.
    base: usize,
}

/// A working dot: its glyph and colour pulsing where its room is, in the text style there.
#[derive(Debug)]
struct Dot {
    id: SharedString,
    glyph: SharedString,
    color: Rgba,
    at: RefCell<Option<(Bounds<Pixels>, gpui_kit::TextStyle)>>,
}

#[derive(Debug)]
struct Said {
    id: Option<String>,
    props: ChatStatusProps,
    sink: Option<Sink>,
    focused: bool,
}

thread_local! {
    static SPOTS: Cell<usize> = const { Cell::new(0) };
}

impl Spot {
    fn new() -> Self {
        let n = SPOTS.with(|v| {
            v.set(v.get() + 1);
            v.get()
        });
        Spot {
            said: RefCell::default(),
            at: Cell::default(),
            dots: RefCell::default(),
            out: Rc::default(),
            // apart from the slot's own and its transcripts' (theirs from 1 << 24 up)
            base: (1 << 40) + (n << 24),
        }
    }

    /// The slot draws its tree anew: no line nor dot until the tree says one.
    pub(super) fn clear(&self) {
        self.said.replace(None);
        self.dots.borrow_mut().clear();
    }

    /// The line shows a time: it ticks.
    pub(super) fn ticks(&self) -> bool {
        self.said
            .borrow()
            .as_ref()
            .is_some_and(|s| s.props.since.is_some())
    }

    /// The tree's line: kept for its view, its room in the tree.
    fn keep(
        self: Rc<Self>,
        id: Option<&str>,
        p: &ChatStatusProps,
        drawn: &mut Drawn,
    ) -> AnyElement {
        self.said.replace(Some(Said {
            id: id.map(str::to_owned),
            props: p.clone(),
            sink: drawn.sink.clone(),
            focused: drawn.focused,
        }));
        drawn.subs.push(Sub {
            at_item: drawn.items.len(),
            #[cfg(debug_assertions)]
            at_node: drawn.nodes.len(),
            #[cfg(debug_assertions)]
            at_click: drawn.clicks.borrow().len(),
            #[cfg(debug_assertions)]
            node: drawn.open.last().copied(),
            drawn: self.out.clone(),
        });
        let spot = self.clone();
        div()
            .flex_none()
            .w_full()
            .h(px(height(p)))
            .child(canvas(move |b, _, _| spot.at.set(Some(b)), |_, _, _, _| {}).size_full())
            .into_any_element()
    }
}

/// A working dot `glyph` in `color`, pulsing: in a slot whose host draws its [`Live`] view,
/// only its room here (the glyph unseen); else drawn in place.
pub fn pulse(
    id: impl Into<SharedString>,
    glyph: impl Into<SharedString>,
    color: Rgba,
    drawn: &Drawn,
) -> AnyElement {
    let (id, glyph) = (id.into(), glyph.into());
    let Some(spot) = &drawn.line else {
        return crate::kit::pulsing(id, div().flex_none().text_color(color).child(glyph));
    };
    let dot = Rc::new(Dot {
        id,
        glyph: glyph.clone(),
        color,
        at: RefCell::new(None),
    });
    spot.dots.borrow_mut().push(dot.clone());
    div()
        .relative()
        .flex_none()
        .text_color(gpui_kit::transparent_black())
        .child(glyph)
        .child(
            canvas(
                move |b, window, _| *dot.at.borrow_mut() = Some((b, window.text_style())),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .into_any_element()
}

/// A slot's live parts (its status line, its working dots), a view of their own its host draws
/// over the slot ([`Spot`]).
pub struct Live {
    spot: Rc<Spot>,
    /// How many times its line was built (tests: what a tick draws).
    drawn: Rc<Cell<u64>>,
}

impl Live {
    pub(super) fn new() -> Self {
        Live {
            spot: Rc::new(Spot::new()),
            drawn: Rc::default(),
        }
    }

    /// How many times its line was built (tests).
    pub(super) fn drawn(&self) -> u64 {
        self.drawn.get()
    }

    pub(super) fn spot(&self) -> Rc<Spot> {
        self.spot.clone()
    }
}

impl Render for Live {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Over {
            spot: self.spot.clone(),
            drawn: self.drawn.clone(),
            els: Vec::new(),
        }
    }
}

/// The live parts drawn where the slot's tree kept their room. Laid out out of flow (no room of
/// their own); built when prepainted, after the slot (its sibling before it) placed the rooms.
struct Over {
    spot: Rc<Spot>,
    drawn: Rc<Cell<u64>>,
    els: Vec<AnyElement>,
}

impl IntoElement for Over {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Over {
    type RequestLayoutState = ();
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
    ) -> (LayoutId, ()) {
        let style = Style {
            position: gpui_kit::Position::Absolute,
            ..Style::default()
        };
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mut drawn = Drawn {
            base: self.spot.base,
            ..Drawn::default()
        };
        let mut els: Vec<(AnyElement, Bounds<Pixels>)> = Vec::new();
        {
            let said = self.spot.said.borrow();
            if let (Some(s), Some(at)) = (said.as_ref(), self.spot.at.get()) {
                drawn.focused = s.focused;
                drawn.sink = s.sink.clone();
                let line = draw(s.id.as_deref(), &s.props, &mut drawn);
                // as the slot's tree draws its parts ([`super::draw::fill`])
                let line = div()
                    .size_full()
                    .font_family(crate::render::UI_FONT)
                    .text_size(px(look::UI_FONT_SIZE))
                    .text_color(look::TEXT)
                    .child(line)
                    .into_any_element();
                els.push((line, at));
            }
        }
        *self.spot.out.borrow_mut() = drawn;
        for dot in self.spot.dots.borrow().iter() {
            let Some((at, style)) = dot.at.borrow().clone() else {
                continue;
            };
            let el = div()
                .size_full()
                .font_family(style.font_family.clone())
                .text_size(style.font_size)
                .line_height(style.line_height)
                .font_weight(style.font_weight)
                .child(crate::kit::pulsing(
                    dot.id.clone(),
                    div().text_color(dot.color).child(dot.glyph.clone()),
                ))
                .into_any_element();
            els.push((el, at));
        }
        if els.is_empty() {
            return;
        }
        self.drawn.set(self.drawn.get() + 1);
        for (mut el, at) in els {
            el.layout_as_root(gpui_kit::Size::<AvailableSpace>::from(at.size), window, cx);
            el.prepaint_at(at.origin, window, cx);
            self.els.push(el);
        }
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
        for el in &mut self.els {
            el.paint(window, cx);
        }
    }
}

/// The line, and above it the list while unfolded, drawn.
fn draw(id: Option<&str>, p: &ChatStatusProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("ChatStatus", p.words.clone());
    let sel = selector("ChatStatus", ix, id);
    let now = now_ms();
    let time = p.since.map(|since| elapsed(now - since));
    if let Some(t) = &time {
        drawn.add(CLOCK, t.clone());
    }
    let color = tone_color(p.tone);
    let dot = div()
        .flex_none()
        .w(px(DOT_W))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(color)
        .child("●");
    let dot = if matches!(p.tone, Tone::Working | Tone::Starting) {
        crate::kit::pulsing(
            SharedString::from(format!("factory-status-pulse-{ix}")),
            dot,
        )
    } else {
        dot.into_any_element()
    };
    let agents = p.agents.as_ref().map(|a| {
        drawn.add("ChatStatusAgents", a.text.clone());
        let sel = selector("ChatStatusAgents", ix, Some(&a.id));
        let b = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .flex_none()
            .h(px(20.))
            .px(px(6.))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(4.))
            .hover(|s| s.bg(look::HOVER_BG))
            .tooltip(crate::kit::tooltip(
                if a.open {
                    "Fold the subagents"
                } else {
                    "Unfold the subagents"
                },
                Some("Tab"),
            ))
            .when(a.running > 0, |d| {
                d.child(small("●", look::ABE_WARN.rgba()))
            })
            .child(small(
                a.text.clone(),
                if a.running > 0 {
                    look::TEXT.rgba()
                } else {
                    look::TEXT_DIM.rgba()
                },
            ))
            .child(
                Icon::new(if a.open {
                    IconName::ChevronDown
                } else {
                    IconName::ChevronUp
                })
                .size(px(12.)),
            );
        clickable(b, Some(&a.id), drawn)
    });
    let line = div()
        .flex_none()
        .w_full()
        .h(px(LINE_H))
        .flex()
        .items_center()
        .gap(px(GAP))
        .px(px(2.))
        .child(dot)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(if p.tone == Tone::Idle {
                    look::TEXT_DIM
                } else {
                    look::TEXT
                })
                .child(SharedString::from(p.words.clone())),
        )
        .children(time.map(|t| small(t, look::TEXT_DIM.rgba())))
        .child(div().flex_1())
        .children(agents);
    let rows: Vec<AnyElement> = p
        .list
        .iter()
        .enumerate()
        .map(|(i, r)| row(r, p.selected == Some(i), now, drawn))
        .collect();
    let list = (!rows.is_empty()).then(|| {
        div()
            .debug_selector(|| "factory-status-list".into())
            .flex_none()
            .w_full()
            .flex()
            .flex_col()
            .p(px(LIST_PAD))
            .mb(px(LIST_GAP))
            .rounded(px(look::POPUP_ARC))
            .bg(look::POPUP_BG)
            .border(px(look::POPUP_BORDER_WIDTH))
            .border_color(look::POPUP_BORDER)
            .children(rows)
    });
    div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(height(p)))
        .flex()
        .flex_col()
        .children(list)
        .child(line)
        .into_any_element()
}

/// One listed run: `●` running / `✓` done, its name and task, its last tool, its time.
fn row(r: &SubagentRow, selected: bool, now: f64, drawn: &mut Drawn) -> AnyElement {
    let running = r.state == "running";
    let words = match &r.task {
        Some(t) => format!("{} · {t}", r.name),
        None => r.name.clone(),
    };
    let ix = drawn.add("SubagentRow", words.clone());
    if selected {
        drawn.add("SubagentSelected", words.clone());
    }
    let time = elapsed(r.until.unwrap_or(now) - r.since);
    let sel = selector("SubagentRow", ix, Some(&r.id));
    let (fg, dim) = if selected {
        (look::SELECTION_TEXT.rgba(), look::SELECTION_TEXT.rgba())
    } else {
        (look::TEXT.rgba(), look::TEXT_DIM.rgba())
    };
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(ROW_H))
        .px(px(6.))
        .flex()
        .items_center()
        .gap(px(GAP))
        .rounded(px(4.))
        .when(selected, |d| d.bg(super::transcript::selection_bg(drawn)))
        .when(!selected, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .tooltip(crate::kit::tooltip(
            format!(
                "{words}{}",
                r.last.as_ref().map_or(String::new(), |l| format!("\n{l}"))
            ),
            Some("⏎ go to its call · o its transcript"),
        ))
        .child(small(
            if running { "●" } else { "✓" },
            if running {
                look::ABE_WARN.rgba()
            } else {
                look::ABE_GOOD.rgba()
            },
        ))
        .child(
            div()
                .flex_none()
                .max_w(relative_w(0.5))
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(fg)
                .child(SharedString::from(words)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(dim)
                .children(r.last.clone().map(SharedString::from)),
        )
        .child(small(time, dim));
    clickable(d, Some(&r.id), drawn).into_any_element()
}

fn relative_w(f: f32) -> gpui_kit::DefiniteLength {
    gpui_kit::relative(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_time_reads_as_seconds_minutes_or_hours() {
        assert_eq!(elapsed(0.), "0s");
        assert_eq!(elapsed(8_900.), "8s");
        assert_eq!(elapsed(65_000.), "1m 05s");
        assert_eq!(elapsed(3_720_000.), "1h 02m");
        assert_eq!(elapsed(-5.), "0s");
    }
}
