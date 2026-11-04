//! A workflow file's preview beside its YAML (ADR 0033, design "Workflows in the editor"): drawn
//! in place of the markdown when Lua sends the buffer's `abe` preview (`config/workflow.lua`, from
//! `abe workflow read`). Abe decides the words and their hues
//! (`abe/packages/core/src/skills/workflow/preview.ts`); this draws them top to bottom: the title
//! with its badges and counts, a red banner while the file fails the load check, then one card
//! per step joined by a line (name and tag; main skill and what it does), a gated card dashed with
//! a dashed way around it (`skipped if no`), a way out as a dashed tag off a card's right, the
//! loops back as brackets on the right (`↩ build ×10`), a card's problem under it in red. The
//! caret's step is ringed; a click on a card puts the caret at its line (`abe:line/<n>`), an
//! action runs as the readable side's link (`abe:<action>`). A pane too narrow for the brackets
//! beside the cards lays them out narrow: the cards its width, their loops, gate and way out as
//! lines in them (`↩ back to build ×10`). Text wraps between words only, a word too long for the
//! line ellipsized.

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Rgba, SharedString, StatefulInteractiveElement as _, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::{MarkdownView, style};
use crate::editor::tabs::seq;
use crate::look::{self, Tok};

/// A preview's words' hue (core's `PREVIEW_HUES`).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Hue {
    #[default]
    Text,
    Dim,
    Accent,
    Good,
    Warn,
    Bad,
}

impl Hue {
    fn tok(self) -> Tok {
        match self {
            Hue::Text => style::FG,
            Hue::Dim => look::TEXT_DIM,
            Hue::Accent => look::ABE_ACCENT,
            Hue::Good => look::ABE_GOOD,
            Hue::Warn => look::ABE_WARN,
            Hue::Bad => look::ABE_BAD,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Badge {
    pub text: String,
    #[serde(default)]
    pub hue: Hue,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Exit {
    pub text: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Step {
    pub name: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub skill: String,
    #[serde(default)]
    pub about: String,
    #[serde(default)]
    pub gated: bool,
    #[serde(default)]
    pub bad: bool,
    #[serde(default)]
    pub problem: Option<String>,
    #[serde(default)]
    pub exit: Option<Exit>,
    #[serde(default)]
    pub line: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Loop {
    pub from: usize,
    pub to: usize,
    pub label: String,
    #[serde(default)]
    pub times: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Action {
    pub label: String,
    pub action: String,
}

/// `abe workflow read`'s `preview` (core's `WorkflowPreview`).
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct WorkflowPreview {
    pub title: String,
    #[serde(default, deserialize_with = "seq")]
    pub badges: Vec<Badge>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub about: String,
    #[serde(default, deserialize_with = "seq")]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default, deserialize_with = "seq")]
    pub steps: Vec<Step>,
    #[serde(default, deserialize_with = "seq")]
    pub loops: Vec<Loop>,
    #[serde(default)]
    pub end: String,
}

/// The column's left and top room.
const PAD_X: f32 = 32.;
const PAD_TOP: f32 = 18.;
/// A step card at its widest and narrowest (a narrower pane narrows it, so its tag and the
/// brackets right of it stay in view; one narrower still is [`Layout::Narrow`]), and the line
/// between two.
const CARD_W: f32 = 300.;
const CARD_MIN_W: f32 = 180.;
const CARD_H: f32 = 56.;
const LINK_H: f32 = 36.;
/// A narrow pane's line between two cards.
const NARROW_LINK_H: f32 = 20.;
/// A card's room round its text: its padding and border.
const CARD_PAD_X: f32 = 10.;
const CARD_CHROME: f32 = 2. * CARD_PAD_X + 2.;
/// Room under a card for its problem.
const PROBLEM_H: f32 = 18.;
const CARD_RADIUS: f32 = 8.;
/// A bracket's reach right of the cards, per loop.
const BRACKET_STEP: f32 = 24.;
/// Room right of the brackets for their labels (`↩ build ×10`, `skipped if no`).
const LABEL_W: f32 = 90.;
/// A way out's tag, right of its card.
const EXIT_X: f32 = 36.;
/// The column's right room.
const PAD_RIGHT: f32 = 16.;
/// A narrow pane's room each side: a 20th of it, in these bounds.
const NARROW_PAD: (f32, f32) = (4., 12.);
/// Between two words of text laid out a word at a time ([`words`]).
const SPACE: f32 = 4.;
const TITLE_SIZE: f32 = 17.;
const SMALL_SIZE: f32 = 12.;
const TAG_SIZE: f32 = 11.;

fn wash(t: Tok) -> Rgba {
    look::abe_badge_bg(t.rgba())
}

/// One word, on one line at most `max` wide: a longer one ellipsized, never broken.
fn word(w: impl Into<SharedString>, max: f32) -> gpui_kit::Div {
    div()
        .flex_none()
        .max_w(px(max.max(0.)))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .child(w.into())
}

/// `text`'s words (a run of letters is never split), each a [`word`].
fn split_words(text: &str) -> impl Iterator<Item = &str> {
    text.split_whitespace()
}

/// `text` wrapped between its words only, at most `max` wide: a line wrapped by width breaks a
/// word longer than the line mid-word, and a pane a few letters wide into a letter a line.
fn words(text: &str, max: f32) -> gpui_kit::Div {
    div()
        .flex()
        .flex_wrap()
        .gap_x(px(SPACE))
        .children(split_words(text).map(|w| word(w.to_owned(), max)))
}

/// A click that runs `target` as a preview link of window `win`.
fn link_to(
    el: gpui_kit::Stateful<gpui_kit::Div>,
    win: i64,
    target: String,
    cx: &mut Context<MarkdownView>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    el.cursor_pointer().on_mouse_down(
        MouseButton::Left,
        cx.listener(move |v, _, _, cx| {
            cx.stop_propagation();
            v.open_link(win, &target, cx);
        }),
    )
}

fn badge(b: &Badge, max: f32) -> AnyElement {
    let (fg, bg) = match b.hue {
        Hue::Dim | Hue::Text => (look::TEXT_DIM.rgba(), look::HOVER_BG.rgba()),
        h => (h.tok().rgba(), wash(h.tok())),
    };
    word(b.text.clone(), max)
        .px(px(6.))
        .rounded(px(4.))
        .text_size(px(SMALL_SIZE))
        .line_height(px(18.))
        .text_color(fg)
        .bg(bg)
        .into_any_element()
}

/// The title with its badges, the counts, what it's for, its actions and banner, in a column
/// `max` wide.
fn head(p: &WorkflowPreview, max: f32, win: i64, cx: &mut Context<MarkdownView>) -> AnyElement {
    let actions: Vec<AnyElement> = p
        .actions
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let el = div()
                .id(SharedString::from(format!("abe-preview-action-{win}-{i}")))
                .debug_selector(move || format!("abe-preview-action-{i}"))
                .max_w(px(max.max(0.)))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_color(style::LINK)
                .child(a.label.clone());
            link_to(el, win, format!("abe:{}", a.action), cx).into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(
                    words(&p.title, max)
                        .text_size(px(TITLE_SIZE))
                        .line_height(px(22.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(look::ABE_CARD_TITLE),
                )
                .children(p.badges.iter().map(|b| badge(b, max))),
        )
        // a line of its own, wrapped: beside the badges it ran past a narrow pane's edge
        .when(!p.summary.is_empty(), |d| {
            d.child(
                words(&p.summary, max)
                    .debug_selector(|| "abe-preview-summary".into())
                    .text_size(px(SMALL_SIZE))
                    .text_color(look::TEXT_DIM),
            )
        })
        .when(!p.about.is_empty(), |d| {
            d.child(words(&p.about, max).text_color(look::TEXT_DIM))
        })
        .when(!actions.is_empty(), |d| {
            d.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(12.))
                    .text_size(px(SMALL_SIZE))
                    .children(actions),
            )
        })
        .when_some(p.banner.as_deref(), |d, b| {
            d.child(
                words(b, max - 20.)
                    .debug_selector(|| "abe-preview-banner".into())
                    .mt(px(4.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .bg(wash(look::ABE_BAD))
                    .text_size(px(SMALL_SIZE))
                    .line_height(px(16.)),
            )
        })
        .into_any_element()
}

/// A 1 px line, absolute: `w` 1 is vertical, `h` 1 horizontal; `dashed` as a border.
fn line(x: f32, y: f32, w: f32, h: f32, dashed: bool) -> AnyElement {
    let d = div().absolute().left(px(x)).top(px(y));
    let d = if !dashed {
        d.w(px(w)).h(px(h)).bg(look::TEXT_DIM)
    } else if w <= 1. {
        d.w(px(0.))
            .h(px(h))
            .border_l_1()
            .border_dashed()
            .border_color(look::TEXT_DIM)
    } else {
        d.w(px(w))
            .h(px(0.))
            .border_t_1()
            .border_dashed()
            .border_color(look::TEXT_DIM)
    };
    d.into_any_element()
}

/// A small label over the lines (the editor's ground behind it), at most `max` wide.
fn label(x: f32, y: f32, max: f32, text: AnyElement) -> AnyElement {
    div()
        .absolute()
        .left(px(x))
        .top(px(y))
        .max_w(px(max))
        .overflow_hidden()
        .px(px(4.))
        .bg(style::BG)
        .text_size(px(SMALL_SIZE))
        .line_height(px(16.))
        .whitespace_nowrap()
        .child(text)
        .into_any_element()
}

/// A bracket's label (`↩ build`, then its `×10` dim) in [`LABEL_W`]; a longer one ellipsized.
fn bracket_label(text: SharedString, times: Option<SharedString>) -> AnyElement {
    let part = |t: SharedString| div().min_w_0().overflow_hidden().text_ellipsis().child(t);
    div()
        .flex()
        .gap(px(4.))
        .max_w(px(LABEL_W - 8.))
        .overflow_hidden()
        .child(part(text))
        .when_some(times, |d, t| {
            d.child(part(t).flex_none().text_color(look::TEXT_DIM))
        })
        .into_any_element()
}

/// A card's first line: the step's name and tag, a narrow pane's tag under a long name.
fn card_name(s: &Step, text_w: f32, narrow: bool) -> gpui_kit::Div {
    let name = div()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .child(s.name.clone());
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .text_size(px(13.))
        .line_height(px(18.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(look::ABE_CARD_TITLE)
        .child(if narrow {
            name.flex_none().max_w(px(text_w))
        } else {
            name.flex_1()
        })
        .when(narrow, |d| d.flex_wrap().gap_y(px(2.)))
        .when_some(s.tag.clone(), |d, t| {
            d.child(
                word(t, text_w)
                    .px(px(5.))
                    .rounded(px(4.))
                    .bg(look::HOVER_BG)
                    .text_size(px(TAG_SIZE))
                    .line_height(px(14.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(look::TEXT_DIM),
            )
        })
}

/// A card's second line: the main skill, then what it does (`✗ …` red); in a narrow pane wrapped
/// between words, else on the line, ellipsized.
fn card_skill(s: &Step, text_w: f32, narrow: bool) -> gpui_kit::Div {
    let about_hue = if s.about.starts_with('✗') {
        look::ABE_BAD
    } else {
        look::TEXT_DIM
    };
    let skill = word(s.skill.clone(), text_w)
        .font_family(style::CODE_FONT)
        .text_color(if s.bad { look::ABE_BAD } else { look::ABE_PATH });
    let d = div()
        .flex()
        .gap(px(8.))
        .text_size(px(SMALL_SIZE))
        .line_height(px(16.));
    if narrow {
        return d
            .flex_wrap()
            .gap_x(px(SPACE))
            .child(skill.mr(px(8. - SPACE)))
            .children(
                split_words(&s.about).map(|w| word(w.to_owned(), text_w).text_color(about_hue)),
            );
    }
    // the skill shrinks (ellipsized) only once what it does is gone
    d.items_center()
        .whitespace_nowrap()
        .child(skill.flex_initial().min_w_0())
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(about_hue)
                .child(s.about.clone()),
        )
}

/// A card's frame: its border (red when bad, dashed when gated), a click to its line.
fn card_frame(
    s: &Step,
    n: usize,
    win: i64,
    cx: &mut Context<MarkdownView>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let el = div()
        .id(SharedString::from(format!("abe-preview-step-{win}-{n}")))
        .debug_selector(move || format!("abe-preview-step-{n}"))
        .px(px(CARD_PAD_X))
        .py(px(8.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .rounded(px(CARD_RADIUS))
        .bg(look::ABE_CARD_BG)
        .border_1()
        .when(s.gated, |d| d.border_dashed())
        .border_color(if s.bad {
            look::ABE_BAD
        } else {
            look::ABE_CARD_BORDER
        });
    match s.line {
        Some(l) => link_to(el, win, format!("abe:line/{l}"), cx),
        None => el,
    }
}

/// The focus ring round the caret's step (its place round the card the caller's).
fn ring(n: usize) -> gpui_kit::Div {
    div()
        .debug_selector(move || format!("abe-preview-ring-{n}"))
        .absolute()
        .rounded(px(CARD_RADIUS + 2.))
        .border_2()
        .border_color(look::FOCUS_BORDER)
}

fn card(
    s: &Step,
    n: usize,
    cw: f32,
    top: f32,
    ringed: bool,
    win: i64,
    cx: &mut Context<MarkdownView>,
) -> AnyElement {
    let text_w = cw - CARD_CHROME;
    let el = card_frame(s, n, win, cx)
        .absolute()
        .left(px(0.))
        .top(px(top))
        .w(px(cw))
        .h(px(CARD_H))
        .child(card_name(s, text_w, false))
        .child(card_skill(s, text_w, false));
    if !ringed {
        return el.into_any_element();
    }
    div()
        .child(
            ring(n)
                .left(px(-2.))
                .top(px(top - 2.))
                .w(px(cw + 4.))
                .h(px(CARD_H + 4.)),
        )
        .child(el)
        .into_any_element()
}

/// The step the caret is in: the last one starting at or above its line.
pub(super) fn caret_step(p: &WorkflowPreview, caret: Option<i64>) -> Option<usize> {
    let caret = caret?;
    p.steps
        .iter()
        .enumerate()
        .rfind(|(_, s)| s.line.is_some_and(|l| l <= caret))
        .map(|(i, _)| i)
}

/// How the flow's laid out across a column.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Layout {
    /// Cards `cw` wide, the loops back as brackets right of them and a gate's way around, a way
    /// out as a tag; `right` the room right of the cards for those.
    Wide { cw: f32, right: f32 },
    /// A pane too narrow for those (cards [`CARD_MIN_W`] beside them): the cards the column's
    /// width, `pad` each side of it; the loops, the gate and the way out lines in their card.
    Narrow { pad: f32 },
}

impl Layout {
    /// The column's room left and right.
    fn pads(self) -> (f32, f32) {
        match self {
            Layout::Wide { .. } => (PAD_X, PAD_RIGHT),
            Layout::Narrow { pad } => (pad, pad),
        }
    }
}

/// The layout of a column `width` wide: the cards take what the pane leaves beside the brackets
/// and ways out right of them, at most [`CARD_W`]; less than [`CARD_MIN_W`] is narrow.
fn layout(p: &WorkflowPreview, width: f32) -> Layout {
    let gated = p.steps.iter().any(|s| s.gated);
    let n = (p.loops.len() + usize::from(gated)) as f32;
    let right = if n > 0. {
        BRACKET_STEP * n + LABEL_W
    } else if p.steps.iter().any(|s| s.exit.is_some()) {
        EXIT_X + LABEL_W
    } else {
        0.
    };
    let room = width - PAD_X - PAD_RIGHT;
    if room - right >= CARD_MIN_W {
        let cw = (room - right).min(CARD_W);
        return Layout::Wide {
            cw,
            right: room - cw,
        };
    }
    let (lo, hi) = NARROW_PAD;
    Layout::Narrow {
        pad: (width / 20.).clamp(lo, hi),
    }
}

/// What a narrow pane says in step `i`'s card in place of the brackets and tags right of it: its
/// loops back (`↩ back to build ×10`), its gate's way around, its way out.
fn card_notes(p: &WorkflowPreview, i: usize) -> Vec<String> {
    let mut out: Vec<String> = p
        .loops
        .iter()
        .filter(|l| l.from == i)
        .map(|l| {
            let to = l
                .label
                .strip_prefix("↩ ")
                .map_or_else(|| l.label.clone(), |t| format!("↩ back to {t}"));
            if l.times.is_empty() {
                to
            } else {
                format!("{to} {}", l.times)
            }
        })
        .collect();
    let s = &p.steps[i];
    if s.gated {
        out.push("skipped if no".into());
    }
    if let Some(e) = &s.exit {
        out.push(format!("⇢ {}", e.text));
    }
    out
}

/// The flow: the cards top to bottom, their lines, brackets, ways around and out.
fn flow(
    p: &WorkflowPreview,
    cw: f32,
    right: f32,
    caret: Option<i64>,
    win: i64,
    cx: &mut Context<MarkdownView>,
) -> AnyElement {
    let mut tops = Vec::with_capacity(p.steps.len());
    let mut y = 0.;
    for s in &p.steps {
        tops.push(y);
        y += CARD_H + LINK_H + if s.problem.is_some() { PROBLEM_H } else { 0. };
    }
    let height = (y - LINK_H).max(0.);
    let ringed = caret_step(p, caret);
    let mid = |i: usize| tops.get(i).copied().unwrap_or(0.) + CARD_H / 2.;
    let mut out: Vec<AnyElement> = Vec::new();
    for (i, s) in p.steps.iter().enumerate() {
        let top = tops[i];
        // the line down to the next card
        if let Some(&next) = tops.get(i + 1) {
            out.push(line(cw / 2., top + CARD_H, 1., next - top - CARD_H, false));
        }
        out.push(card(s, i, cw, top, ringed == Some(i), win, cx));
        if let Some(problem) = &s.problem {
            out.push(
                div()
                    .absolute()
                    .left(px(0.))
                    .top(px(top + CARD_H + 2.))
                    .w(px(cw))
                    .text_size(px(SMALL_SIZE))
                    .line_height(px(16.))
                    .text_color(look::ABE_BAD)
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(problem.clone())
                    .into_any_element(),
            );
        }
        // a way out: a dashed line to a dashed tag, its note under it
        if let Some(exit) = &s.exit {
            let max = right - EXIT_X;
            out.push(line(cw, top + CARD_H / 2., EXIT_X - 6., 1., true));
            out.push(
                word(exit.text.clone(), max)
                    .absolute()
                    .left(px(cw + EXIT_X))
                    .top(px(top + 18.))
                    .h(px(20.))
                    .px(px(7.))
                    .flex()
                    .items_center()
                    .rounded(px(4.))
                    .border_1()
                    .border_dashed()
                    .border_color(look::TEXT_DIM)
                    .bg(style::BG)
                    .text_size(px(SMALL_SIZE))
                    .into_any_element(),
            );
            if !exit.note.is_empty() {
                out.push(label(
                    cw + EXIT_X - 4.,
                    top + 42.,
                    max + 4.,
                    div()
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_size(px(TAG_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(exit.note.clone())
                        .into_any_element(),
                ));
            }
        }
    }
    // the loops back: a bracket each, further right the more there are
    for (k, l) in p.loops.iter().enumerate() {
        let reach = BRACKET_STEP * (k + 1) as f32;
        let (from, to) = (mid(l.from), mid(l.to) + 4. * k as f32);
        out.push(line(cw, from, reach, 1., false));
        out.push(line(cw + reach, to.min(from), 1., (from - to).abs(), false));
        out.push(line(cw, to, reach, 1., false));
        out.push(label(
            cw + reach + 6.,
            from - 8.,
            LABEL_W,
            bracket_label(
                l.label.clone().into(),
                (!l.times.is_empty()).then(|| l.times.clone().into()),
            ),
        ));
    }
    // a gate: a dashed way around its card, past the brackets
    let around = BRACKET_STEP * (p.loops.len() + 1) as f32;
    for (i, _) in p.steps.iter().enumerate().filter(|(_, s)| s.gated) {
        let from = if i == 0 {
            tops[i]
        } else {
            tops[i - 1] + CARD_H
        };
        let to = tops.get(i + 1).copied().unwrap_or(tops[i] + CARD_H);
        out.push(line(cw + around, from, 1., to - from, true));
        out.push(line(cw, from, around, 1., true));
        out.push(line(cw, to, around, 1., true));
        out.push(label(
            cw + around + 6.,
            (from + to) / 2. - 8.,
            LABEL_W,
            div()
                .text_color(look::TEXT_DIM)
                .child(bracket_label("skipped if no".into(), None))
                .into_any_element(),
        ));
    }
    div()
        .relative()
        .w_full()
        .h(px(height))
        .children(out)
        .into_any_element()
}

/// A narrow pane's flow: the cards the column's (`max`) width one under another, a line between;
/// a card's loops back, gate and way out lines in it ([`card_notes`]), its problem under it, every
/// text wrapped between words.
fn narrow_flow(
    p: &WorkflowPreview,
    max: f32,
    caret: Option<i64>,
    win: i64,
    cx: &mut Context<MarkdownView>,
) -> AnyElement {
    let text_w = max - CARD_CHROME;
    let ringed = caret_step(p, caret);
    let mut out: Vec<AnyElement> = Vec::new();
    for (i, s) in p.steps.iter().enumerate() {
        if i > 0 {
            out.push(
                div()
                    .h(px(NARROW_LINK_H))
                    .flex()
                    .justify_center()
                    .child(div().w(px(1.)).h_full().bg(look::TEXT_DIM))
                    .into_any_element(),
            );
        }
        let el = card_frame(s, i, win, cx)
            .relative()
            .w_full()
            .child(card_name(s, text_w, true))
            .child(card_skill(s, text_w, true))
            .children(card_notes(p, i).into_iter().map(|t| {
                words(&t, text_w)
                    .text_size(px(SMALL_SIZE))
                    .line_height(px(16.))
                    .text_color(look::TEXT_DIM)
            }))
            .when(ringed == Some(i), |d| {
                // round the card (inside it, its border's past it)
                d.child(
                    ring(i)
                        .left(px(-3.))
                        .top(px(-3.))
                        .right(px(-3.))
                        .bottom(px(-3.)),
                )
            });
        out.push(el.into_any_element());
        if let Some(problem) = &s.problem {
            out.push(
                words(problem, max)
                    .mt(px(2.))
                    .text_size(px(SMALL_SIZE))
                    .line_height(px(16.))
                    .text_color(look::ABE_BAD)
                    .into_any_element(),
            );
        }
    }
    div()
        .flex()
        .flex_col()
        .w_full()
        .children(out)
        .into_any_element()
}

/// The preview, a column scrolled on its own over the pane `width` wide (`win`: the file's
/// window; `caret`: its caret's line, which rings that step).
pub(super) fn view(
    p: &WorkflowPreview,
    width: f32,
    caret: Option<i64>,
    win: i64,
    cx: &mut Context<MarkdownView>,
) -> AnyElement {
    let layout = layout(p, width);
    let (pl, pr) = layout.pads();
    let max = width - pl - pr;
    let flow = match layout {
        Layout::Wide { cw, right } => flow(p, cw, right, caret, win, cx),
        Layout::Narrow { .. } => narrow_flow(p, max, caret, win, cx),
    };
    div()
        .id(SharedString::from(format!("abe-preview-{win}")))
        .debug_selector(|| "abe-preview".into())
        .size_full()
        .overflow_y_scroll()
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(16.))
                .pl(px(pl))
                .pr(px(pr))
                .pt(px(PAD_TOP))
                .pb(px(PAD_X))
                .child(head(p, max, win, cx))
                .child(flow)
                .when(!p.end.is_empty(), |d| {
                    d.child(
                        words(&format!("→ {}", p.end), max)
                            .text_size(px(SMALL_SIZE))
                            .text_color(look::TEXT_DIM),
                    )
                }),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(loops: usize, gated: bool) -> WorkflowPreview {
        let mut p: WorkflowPreview =
            rmpv::ext::from_value(rmpv::Value::Map(vec![("title".into(), "Bug".into())])).unwrap();
        p.steps = ["create-specification", "build", "checks"]
            .iter()
            .enumerate()
            .map(|(i, n)| Step {
                name: (*n).into(),
                tag: None,
                skill: (*n).into(),
                about: "Made sure of first: specified, sliced into tickets".into(),
                gated: gated && i == 2,
                bad: false,
                problem: None,
                exit: None,
                line: None,
            })
            .collect();
        p.loops = (0..loops)
            .map(|_| Loop {
                from: 2,
                to: 1,
                label: "↩ build".into(),
                times: "×10".into(),
            })
            .collect();
        p
    }

    #[test]
    fn a_preview_reads_lua_s_empty_lists_and_rings_the_carets_step() {
        // Lua sends an empty list as an empty map, and leaves out what core said null
        let v = rmpv::Value::Map(vec![
            ("title".into(), "Bug".into()),
            ("actions".into(), rmpv::Value::Map(vec![])),
            (
                "steps".into(),
                rmpv::Value::Array(
                    [3, 9]
                        .iter()
                        .map(|l| {
                            rmpv::Value::Map(vec![
                                ("name".into(), "s".into()),
                                ("line".into(), (*l).into()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]);
        let p: WorkflowPreview = rmpv::ext::from_value(v).unwrap();
        assert!(p.actions.is_empty() && p.banner.is_none());
        let at = |l| caret_step(&p, Some(l));
        assert_eq!(
            [at(1), at(3), at(8), at(40)],
            [None, Some(0), Some(0), Some(1)]
        );
    }

    #[test]
    fn a_narrower_pane_narrows_the_cards_then_lays_them_out_narrow() {
        let cw = |loops, w| match layout(&preview(loops, false), w) {
            Layout::Wide { cw, .. } => Some(cw),
            Layout::Narrow { .. } => None,
        };
        assert_eq!(cw(0, 900.), Some(CARD_W));
        assert_eq!(cw(0, 300.), Some(300. - PAD_X - PAD_RIGHT));
        // 3 loops: 72 of brackets and their labels beside the card
        assert_eq!(
            cw(3, 450.),
            Some(450. - PAD_X - PAD_RIGHT - 3. * BRACKET_STEP - LABEL_W)
        );
        // too narrow for that (a 308 pt pane beside the Chat column): narrow
        assert_eq!(cw(3, 308.), None);
        assert_eq!(cw(0, 200.), None);
    }

    /// Every box's right edge in a pane `width` wide: the cards', a bracket's label's, a gate's,
    /// and in a narrow pane a word's at its widest.
    fn right_edges(p: &WorkflowPreview, width: f32) -> Vec<f32> {
        match layout(p, width) {
            Layout::Wide { cw, right } => {
                let n = (p.loops.len() + usize::from(p.steps.iter().any(|s| s.gated))) as f32;
                assert!(cw + right <= width - PAD_X - PAD_RIGHT + 0.01);
                let mut out = vec![PAD_X + cw];
                if n > 0. {
                    // the furthest label: past the last bracket, LABEL_W at most
                    out.push(PAD_X + cw + BRACKET_STEP * n + 6. + LABEL_W);
                }
                out
            }
            Layout::Narrow { pad } => {
                let max = width - 2. * pad;
                // a card, and a word in it at its widest; one under a card
                vec![
                    pad + max,
                    pad + CARD_CHROME / 2. + (max - CARD_CHROME),
                    pad + max,
                ]
            }
        }
    }

    #[test]
    fn nothing_past_a_narrow_panes_right_edge() {
        for w in [60., 200., 300., 500., 900.] {
            for (loops, gated) in [(0, false), (3, true), (1, false)] {
                let p = preview(loops, gated);
                for e in right_edges(&p, w) {
                    assert!(e <= w, "{w} {loops} {gated}: {e} {:?}", layout(&p, w));
                }
            }
        }
        // a few letters wide: still a word a line, ellipsized, not a letter a line
        let Layout::Narrow { pad } = layout(&preview(0, false), 22.) else {
            panic!("narrow")
        };
        assert!(22. - 2. * pad >= 14., "{pad}");
    }

    #[test]
    fn a_narrow_card_says_its_loops_and_gate_and_breaks_text_between_words_only() {
        let mut p = preview(2, true);
        p.loops[1].to = 0;
        p.loops[1].label = "↩ create-specification".into();
        p.loops[1].times = String::new();
        p.steps[1].exit = Some(Exit {
            text: "report, end".into(),
            note: String::new(),
        });
        assert_eq!(
            card_notes(&p, 2),
            [
                "↩ back to build ×10",
                "↩ back to create-specification",
                "skipped if no"
            ]
        );
        assert_eq!(card_notes(&p, 1), ["⇢ report, end"]);
        assert!(card_notes(&p, 0).is_empty());
        let about = &p.steps[0].about;
        let ws: Vec<&str> = split_words(about).collect();
        assert_eq!(ws.join(" "), *about);
        assert!(ws.contains(&"specified,"));
    }
}
