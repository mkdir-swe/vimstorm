//! Chat's cards (2.1), the Rust half of `abe/packages/ui/src/chat/cards.ts`, drawn as
//! canvas boards R-Question and C-States draw them in the 420 px column: the QuestionCard (a
//! question, a permission, a run's Needs you, a grill question; `.nv-q`: a purple-edged block on
//! the column's ground, the ◆ and the bold title, the dim why and where lines, the context folded
//! to one `▸ More context` line, 30 px option rows with the key in the accent (a 2 px edge always
//! there, the accent on the selected one: nothing moves as the selection does), the own row (a
//! field while typed), the keys' line, the stack's `2 of 3` and the edges of the cards under it),
//! a CardLine (an answered card folded to one dim line), a GrillRound (its header, progress dots
//! and its one question), the OverrideCard (the warn-edged reason card)
//! and the DeferredPill above the composer. Props in, pixels out: a row's id (`<card>:<n>`,
//! `<card>:own`) and a node's id send their clicks.

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Rgba,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _,
    px,
};
use serde::Deserialize;

use super::composer::CaretText;
use super::draw::{Drawn, clickable, node, selector};
use super::protocol::Node;
use super::transcript::selection_bg;
use crate::look;
use crate::render::{EDITOR_FONT, editor_features};

/// The cards' kinds, in `CARD_COMPONENT_KINDS`' order.
pub const KINDS: &[&str] = &[
    "QuestionCard",
    "CardLine",
    "GrillRound",
    "OverrideCard",
    "DeferredPill",
];

/// px (boards C-States, C-Grill, C-Override, R-Anatomy): `.nv-q` padding, gap, radius; an option
/// row; the key and mark columns; the why lines' indent; the stack's edges; the pill.
const PAD: [f32; 4] = [10., 10., 8., 12.];
const GAP: f32 = 8.;
const ARC: f32 = 6.;
const ROW_H: f32 = 30.;
const ROW_GAP: f32 = 10.;
const MARK_W: f32 = 12.;
const INDENT: f32 = 20.;
const LINE: f32 = 18.;
const SMALL_LINE: f32 = 16.;
const EDGE_H: f32 = 4.;
const PILL_H: f32 = 22.;
const FIELD_H: f32 = 30.;
/// The own words' field grows to this many lines, then shows its last ones.
const OWN_MAX_LINES: f32 = 6.;
const FACT_LABEL_W: f32 = 44.;
const DOT: f32 = 6.;
/// `color-mix(<hue> 45% / 30% / 18%, transparent)`: the card's edge, the first and second edges under it.
const EDGE_ALPHA: f32 = 0.45;
const UNDER_ALPHA: [f32; 2] = [0.30, 0.18];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardKind {
    Question,
    Grill,
    Permission,
    NeedsYou,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardOption {
    pub n: u8,
    /// Drawn in place of its digit: Abe's own row on a run's Needs you (`w`, `e`).
    pub letter: Option<String>,
    pub label: String,
    /// What it means, dim and wrapped under the label (an AskUserQuestion option's description).
    pub note: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    pub key: Option<String>,
    /// Grey, never picked: why.
    pub reason: Option<String>,
    /// A multiSelect question's row: ticked to go with the answer.
    #[serde(default)]
    pub ticked: bool,
}

/// The selected row: an option's `n`, or the own row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Selected {
    Option(u8),
    Own(OwnRow),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnRow {
    Own,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Stack {
    pub n: u32,
    pub of: u32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct QuestionCardProps {
    pub ask: CardKind,
    pub title: String,
    pub mono: Option<String>,
    pub why: Option<String>,
    #[serde(rename = "where")]
    pub place: Option<String>,
    pub options: Vec<CardOption>,
    /// Several options may go (a multiSelect question): a box before each label.
    #[serde(default)]
    pub multi: bool,
    /// None: no own row (a card nothing can be told to).
    pub own: Option<String>,
    pub typing: Option<String>,
    /// The typed words' caret in characters; None: at their end.
    pub caret: Option<usize>,
    /// The last `draft` number the screen took from the slot's own field.
    #[serde(default)]
    pub seq: u64,
    pub selected: Option<Selected>,
    pub stack: Option<Stack>,
    #[serde(default)]
    pub under: u8,
    pub foot: Option<String>,
    pub expired: Option<String>,
    pub whose: Option<String>,
    /// The question's context, folded under its title; `more_open`: unfolded.
    pub more: Option<String>,
    #[serde(default, rename = "moreOpen")]
    pub more_open: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardLineProps {
    pub head: String,
    pub text: Option<String>,
    pub n: Option<u8>,
    pub note: Option<String>,
    #[serde(default)]
    pub waiting: bool,
    #[serde(default)]
    pub boxed: bool,
    #[serde(default)]
    pub selected: bool,
}

/// A grill question's progress dot (ADR 0013: TS says which).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrillDot {
    Done,
    Now,
    Todo,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GrillRoundProps {
    pub round: u32,
    pub questions: u32,
    pub answered: u32,
    /// One per question, as TS says: `done`, `now`, `todo`.
    pub dots: Vec<GrillDot>,
    pub foot: Option<String>,
    pub whose: Option<String>,
    pub stack: Option<Stack>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Fact {
    pub label: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct OverrideCardProps {
    pub title: String,
    pub line: String,
    pub reason: String,
    /// The reason's caret in characters; None: at its end.
    pub caret: Option<usize>,
    #[serde(default)]
    pub missing: bool,
    pub error: Option<String>,
    pub facts: Vec<Fact>,
    pub foot: String,
    #[serde(default)]
    pub sending: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DeferredPillProps {
    pub count: u32,
    pub text: String,
}

/// One card of the set, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Card {
    Question(Box<QuestionCardProps>),
    Line(CardLineProps),
    Round(GrillRoundProps),
    Override(OverrideCardProps),
    Pill(DeferredPillProps),
}

impl Card {
    /// The card of `kind` (one of [`KINDS`]) from its props.
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Card, D::Error> {
        use serde::de::Error as _;
        Ok(match kind {
            "QuestionCard" => Card::Question(Box::new(serde::Deserialize::deserialize(props)?)),
            "CardLine" => Card::Line(serde::Deserialize::deserialize(props)?),
            "GrillRound" => Card::Round(serde::Deserialize::deserialize(props)?),
            "OverrideCard" => Card::Override(serde::Deserialize::deserialize(props)?),
            "DeferredPill" => Card::Pill(serde::Deserialize::deserialize(props)?),
            _ => return Err(D::Error::custom(format!("not a card: {kind}"))),
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Card::Question(_) => "QuestionCard",
            Card::Line(_) => "CardLine",
            Card::Round(_) => "GrillRound",
            Card::Override(_) => "OverrideCard",
            Card::Pill(_) => "DeferredPill",
        }
    }
}

pub fn card(
    id: Option<&str>,
    c: &Card,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    match c {
        Card::Question(q) => question(id, q, drawn),
        Card::Line(l) => line(id, l, drawn),
        Card::Round(r) => round(id, r, children, drawn, cx),
        Card::Override(o) => override_card(id, o, drawn),
        Card::Pill(p) => pill(id, p, drawn),
    }
}

const fn alpha(c: Rgba, a: f32) -> Rgba {
    Rgba { a, ..c }
}

fn text(t: impl Into<SharedString>, size: f32, color: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(px(size))
        .text_color(color)
        .child(t.into())
}

/// Text that gives way at the right with an ellipsis.
fn shrinking(t: impl Into<SharedString>, color: Rgba) -> gpui_kit::Div {
    div()
        .min_w_0()
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .text_color(color)
        .child(t.into())
}

fn mono(t: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .flex_none()
        .whitespace_nowrap()
        .font(gpui_kit::font(EDITOR_FONT))
        .font_features(editor_features())
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(t.into())
}

/// The ◆ column (12 px), in `color`.
fn mark(color: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .w(px(MARK_W))
        .flex()
        .justify_center()
        .text_color(color)
        .child("◆")
}

/// A dim line under the head, indented past the ◆ (`.nv-q__why`).
fn under_line(t: &str, kind: &str, drawn: &mut Drawn) -> gpui_kit::Div {
    drawn.add(kind, t);
    div()
        .flex_none()
        .pl(px(INDENT))
        .line_height(px(SMALL_LINE))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(t.to_owned()))
}

/// The 1 px caret in typed text.
fn caret() -> gpui_kit::Div {
    div()
        .debug_selector(|| "factory-card-caret".into())
        .flex_none()
        .w(px(look::CARET_WIDTH))
        .h(px(SMALL_LINE))
        .bg(look::CARET)
}

/// The head: ◆, the title (its `mono` part in mono), the stack's `2 of 3` at the right. The title
/// wraps, whole (board C-NeedsYou's `nv-q__text--wrap`; a question's too: an agent's
/// question is often two sentences); a permission's with its command in mono stays on one line,
/// the command giving way with `…` at the column's edge.
fn head(
    p: &QuestionCardProps,
    mark_color: Rgba,
    title_color: Rgba,
    drawn: &mut Drawn,
) -> gpui_kit::Div {
    let wraps = p.mono.is_none();
    let mut title = div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_baseline()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_color(title_color);
    match p
        .mono
        .as_deref()
        .and_then(|m| p.title.find(m).map(|at| (m, at)))
    {
        _ if wraps => {
            title = div()
                .flex_1()
                .min_w_0()
                .whitespace_normal()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(title_color)
                .child(SharedString::from(p.title.clone()));
        }
        Some((m, at)) => {
            let (before, rest) = p.title.split_at(at);
            let after = &rest[m.len()..];
            title = title
                .child(text(before.to_owned(), look::UI_FONT_SIZE, title_color))
                .child(
                    mono(m.to_owned())
                        .flex_shrink(1.)
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .debug_selector(|| "factory-card-mono".into()),
                )
                .child(shrinking(after.to_owned(), title_color));
        }
        None => title = title.child(shrinking(p.title.clone(), title_color)),
    }
    div()
        .flex_none()
        .flex()
        .map(|d| {
            if wraps {
                d.items_start()
            } else {
                d.items_baseline()
            }
        })
        .gap(px(GAP))
        .line_height(px(LINE))
        .child(mark(mark_color))
        .child(title)
        .children(stack_of(p, drawn))
}

/// The stack's `2 of 3`, dim.
fn stack_of(p: &QuestionCardProps, drawn: &mut Drawn) -> Option<gpui_kit::Div> {
    p.stack.map(|s| {
        let words = format!("{} of {}", s.n, s.of);
        drawn.add("CardStack", words.clone());
        text(words, look::UI_SMALL_FONT_SIZE, look::TEXT_DIM.rgba())
    })
}

fn option_row(
    card_id: Option<&str>,
    o: &CardOption,
    (selected, multi): (bool, bool),
    grey: bool,
    drawn: &mut Drawn,
) -> AnyElement {
    let digit = o.n.to_string();
    let shown = o.letter.as_deref().unwrap_or(&digit);
    let words = format!(
        "{} {}{}",
        shown,
        o.label,
        if o.recommended { " recommended" } else { "" }
    );
    let ix = drawn.add("CardOption", words.clone());
    if selected {
        drawn.add("Selection", words);
    }
    let grey = grey || o.reason.is_some();
    let rid = card_id.map(|c| format!("{c}:{}", o.n));
    let sel = selector("CardOption", ix, rid.as_deref());
    let fg = if grey {
        look::TEXT_DISABLED
    } else {
        look::TEXT
    };
    // a multiSelect question's box, ticked or not
    let tick = multi.then(|| {
        drawn.add("CardOptionBox", o.label.clone());
        if o.ticked {
            drawn.add("CardOptionTicked", o.label.clone());
        }
        let state = if o.ticked {
            crate::kit::CheckState::Checked
        } else {
            crate::kit::CheckState::Unchecked
        };
        crate::kit::check_box(crate::kit::checkbox_icon(state, false))
    });
    // the label's line: the box, the label, `recommended`, the key at the right
    let label = div()
        .flex_none()
        .w_full()
        .h(px(LINE))
        .flex()
        .items_center()
        .gap(px(ROW_GAP))
        .children(tick)
        .child(shrinking(o.label.clone(), fg.rgba()))
        .when(o.recommended, |d| {
            d.child(text(
                "recommended",
                look::UI_SMALL_FONT_SIZE,
                look::TEXT_DIM.rgba(),
            ))
        })
        .when_some(o.key.clone(), |d, k| {
            d.child(text(k, look::UI_SMALL_FONT_SIZE, look::TEXT_DIM.rgba()).ml_auto())
        });
    // its description under it, dim, wrapped to two lines at most (all of it in the tooltip):
    // the row as tall whatever is selected or hovered
    let note = o.note.as_deref().map(|n| {
        drawn.add("CardOptionNote", n);
        div()
            .debug_selector(|| "factory-card-option-note".into())
            .flex_none()
            .w_full()
            .whitespace_normal()
            .line_clamp(2)
            .line_height(px(SMALL_LINE))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(if grey {
                look::TEXT_DISABLED
            } else {
                look::TEXT_DIM
            })
            .child(SharedString::from(n.to_owned()))
    });
    // one line: 30 px, centred; with a description, as tall as both, 6 px above and below
    let pad_y = (ROW_H - LINE) / 2.;
    let row = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .min_h(px(ROW_H))
        .flex()
        .items_start()
        .gap(px(ROW_GAP))
        .px(px(8.))
        .py(px(pad_y))
        .rounded(px(look::LIST_SELECTION_ARC))
        .map(|d| selection_bar(d, selected))
        .when(selected, |d| d.bg(selection_bg(drawn)))
        .when(!selected && !grey, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .when_some(o.reason.clone().or_else(|| o.note.clone()), |d, r| {
            d.tooltip(crate::kit::tooltip(r, None))
        })
        .child(key_col(shown, grey).h(px(LINE)).items_center())
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(label)
                .children(note),
        );
    if grey {
        row.into_any_element()
    } else {
        clickable(row, rid.as_deref(), drawn).into_any_element()
    }
}

/// A row's 2 px left edge, always there (nothing moves as the selection does): the accent on the
/// selected row, clear on the others.
fn selection_bar<D: gpui_kit::Styled>(d: D, selected: bool) -> D {
    d.border_l_2().border_color(if selected {
        look::hsla(look::ABE_ACCENT.rgba())
    } else {
        gpui_kit::transparent_black()
    })
}

/// The 12 px key column: the digit or `o`, mono, in the accent.
fn key_col(k: &str, grey: bool) -> gpui_kit::Div {
    div()
        .flex_none()
        .w(px(MARK_W))
        .flex()
        .justify_center()
        .font(gpui_kit::font(EDITOR_FONT))
        .font_features(editor_features())
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(if grey {
            look::TEXT_DISABLED
        } else {
            look::ABE_ACCENT
        })
        .child(SharedString::from(k.to_owned()))
}

/// The own row: `o Type your own answer…`, dim; while typed, a field with the words wrapped at its
/// width (one line high at first, growing to [`OWN_MAX_LINES`], then its last lines: the caret's
/// end stays in view) and the caret where the bridge says (moved above the last lines
/// it is not scrolled to yet).
fn own_row(
    card_id: Option<&str>,
    p: &QuestionCardProps,
    grey: bool,
    drawn: &mut Drawn,
) -> AnyElement {
    let selected = matches!(p.selected, Some(Selected::Own(_)));
    let typed = p.typing.clone();
    let own = p.own.clone().unwrap_or_default();
    let words = typed.clone().unwrap_or_else(|| own.clone());
    let ix = drawn.add("CardOwn", words.clone());
    if selected {
        drawn.add("Selection", format!("o {words}"));
    }
    let rid = card_id.map(|c| format!("{c}:own"));
    let sel = selector("CardOwn", ix, rid.as_deref());
    let typing = typed.is_some();
    // one line: the field's 28 px (its 1 px border, the line, its padding)
    let pad_y = (look::FIELD_HEIGHT - LINE) / 2. - 1.;
    // the slot's own text area types them (native editing) when this card has it
    let area = drawn
        .input
        .as_ref()
        .filter(|i| i.owner.is_some() && i.owner.as_deref() == card_id)
        .and_then(|i| i.area.clone());
    let body = match typed {
        Some(_) if area.is_some() => {
            drawn.add("CardCaret", "");
            div()
                .debug_selector(|| "factory-card-field".into())
                .flex_1()
                .min_w_0()
                .px(px(8.))
                .py(px(pad_y))
                .border_1()
                .border_color(look::FOCUS_BORDER)
                .rounded(px(look::FIELD_ARC))
                .bg(look::FIELD_BG)
                .children(area)
        }
        Some(t) => {
            drawn.add("CardCaret", "");
            div()
                .debug_selector(|| "factory-card-field".into())
                .flex_1()
                .min_w_0()
                .min_h(px(look::FIELD_HEIGHT))
                .px(px(8.))
                .py(px(pad_y))
                .border_1()
                .border_color(look::FOCUS_BORDER)
                .rounded(px(look::FIELD_ARC))
                .bg(look::FIELD_BG)
                .text_color(look::TEXT)
                .child(
                    // taller than its lines: the overflow goes out at the top, the last lines
                    // stay (clipped at the lines, not in the padding)
                    div()
                        .max_h(px(OWN_MAX_LINES * LINE))
                        .overflow_hidden()
                        .flex()
                        .flex_col()
                        .justify_end()
                        .child(
                            div()
                                .debug_selector(|| "factory-card-field-text".into())
                                .flex_none()
                                .w_full()
                                .line_height(px(LINE))
                                .child(CaretText::typed(t, p.caret)),
                        ),
                )
        }
        None => shrinking(own, look::TEXT_DIM.rgba()),
    };
    let row = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .when(!typing, |d| d.h(px(ROW_H)).items_center())
        // typed: as tall as its field, the key beside its first line
        .when(typing, |d| {
            d.min_h(px(ROW_H))
                .py(px((ROW_H - look::FIELD_HEIGHT) / 2.))
                .items_start()
        })
        .flex()
        .gap(px(ROW_GAP))
        .pl(px(8.))
        .pr(px(if typing { 0. } else { 8. }))
        .rounded(px(look::LIST_SELECTION_ARC))
        .map(|d| selection_bar(d, selected))
        .when(selected && p.typing.is_none(), |d| {
            d.bg(selection_bg(drawn))
        })
        .when(!selected && !grey, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .child(key_col("o", grey).h(px(look::FIELD_HEIGHT)).items_center())
        .child(body);
    if grey {
        row.into_any_element()
    } else {
        clickable(row, rid.as_deref(), drawn).into_any_element()
    }
}

/// The keys' line under the rows (`.nv-q__foot`), or what stands in for it.
fn foot(t: &str, kind: &str, indent: f32, color: Rgba, drawn: &mut Drawn) -> gpui_kit::Div {
    drawn.add(kind, t);
    div()
        .flex_none()
        .pl(px(indent))
        .line_height(px(SMALL_LINE))
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(color)
        .child(SharedString::from(t.to_owned()))
}

/// The card's block: the column's ground, a 1 px edge in `edge`, 6 px corners, `.nv-q`'s padding.
fn block(edge: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(GAP))
        .pt(px(PAD[0]))
        .pr(px(PAD[1]))
        .pb(px(PAD[2]))
        .pl(px(PAD[3]))
        .bg(look::PANEL_BG)
        .border_1()
        .border_color(edge)
        .rounded(px(ARC))
        .text_size(px(look::UI_FONT_SIZE))
        .line_height(px(LINE))
        .text_color(look::TEXT)
}

fn question(id: Option<&str>, p: &QuestionCardProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("QuestionCard", p.title.clone());
    let sel = selector("QuestionCard", ix, id);
    let grey = p.expired.is_some();
    let read_only = p.whose.is_some();
    let edge = alpha(look::ABE_NEEDS_YOU.rgba(), EDGE_ALPHA);
    // the why line 2 px under the head, the where line right under it (`.nv-q__why`'s margins)
    let why = p
        .why
        .as_deref()
        .map(|w| under_line(w, "CardWhy", drawn).mt(px(2.)));
    let place = p
        .place
        .as_deref()
        .map(|w| under_line(w, "CardWhere", drawn).when(p.why.is_none(), |d| d.mt(px(2.))));
    let context = p.more.as_deref().map(|m| more(id, m, p.more_open, drawn));
    let top = div()
        .flex_none()
        .flex()
        .flex_col()
        .child(head(
            p,
            look::ABE_NEEDS_YOU.rgba(),
            look::TEXT.rgba(),
            drawn,
        ))
        .children(why)
        .children(place)
        .children(context);
    let mut rows = div().flex_none().flex().flex_col();
    for o in &p.options {
        let selected = matches!(p.selected, Some(Selected::Option(n)) if n == o.n);
        rows = rows.child(option_row(
            id,
            o,
            (selected, p.multi),
            grey || read_only,
            drawn,
        ));
    }
    if p.own.is_some() {
        rows = rows.child(own_row(id, p, grey || read_only, drawn));
    }
    let foot = if let Some(e) = &p.expired {
        Some(foot(e, "CardExpired", 8., look::ABE_WARN.rgba(), drawn))
    } else if let Some(w) = &p.whose {
        Some(foot(w, "CardWhose", 8., look::TEXT_DIM.rgba(), drawn))
    } else {
        p.foot
            .as_deref()
            .map(|f| foot(f, "CardFoot", 8., look::TEXT_DIM.rgba(), drawn))
    };
    let b = block(edge)
        .debug_selector(move || sel)
        .child(top)
        .child(rows)
        .children(foot);
    let edges = (0..p.under.min(2)).map(|i| {
        let inset = 8. * f32::from(i + 1);
        div()
            .flex_none()
            .h(px(EDGE_H))
            .mx(px(inset))
            .border_l_1()
            .border_r_1()
            .border_b_1()
            .border_color(alpha(
                look::ABE_NEEDS_YOU.rgba(),
                UNDER_ALPHA[usize::from(i)],
            ))
            .rounded_b(px(ARC))
            .bg(look::PANEL_BG)
    });
    if p.under > 0 {
        drawn.add("CardUnder", p.under.min(2).to_string());
    }
    let d = div()
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .child(b)
        .children(edges);
    clickable(d, id, drawn).into_any_element()
}

/// The question's context under its title: folded, one 16 px line `▸ More context  m` (a click or
/// `m` unfolds it); unfolded, `▾ Less` and the text, dim and wrapped, a line per paragraph.
fn more(card_id: Option<&str>, text: &str, open: bool, drawn: &mut Drawn) -> gpui_kit::Div {
    let words = if open { "▾ Less" } else { "▸ More context" };
    let ix = drawn.add("CardMore", words);
    let rid = card_id.map(|c| format!("{c}:more"));
    let sel = selector("CardMore", ix, rid.as_deref());
    let toggle = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .h(px(SMALL_LINE))
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .hover(|s| s.text_color(look::TEXT))
        .cursor_pointer()
        .child(SharedString::from(words))
        .child(key_col("m", false));
    let body = open.then(|| {
        drawn.add("CardMoreText", text);
        div()
            .debug_selector(|| "factory-card-more-text".into())
            .flex_none()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(4.))
            .whitespace_normal()
            .line_height(px(SMALL_LINE))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .children(
                text.split('\n')
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| div().child(SharedString::from(l.to_owned()))),
            )
    });
    div()
        .flex_none()
        .mt(px(4.))
        .pl(px(INDENT))
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(clickable(toggle, rid.as_deref(), drawn))
        .children(body)
}

fn line(id: Option<&str>, p: &CardLineProps, drawn: &mut Drawn) -> AnyElement {
    let mut words = format!("◆ {}", p.head);
    if let Some(t) = &p.text {
        words.push_str(&format!(" · {t}"));
    }
    if let Some(n) = p.n {
        words.push_str(&format!(" ({n})"));
    }
    if let Some(note) = &p.note {
        words.push_str(&format!(" · {note}"));
    }
    let ix = drawn.add("CardLine", words.clone());
    if p.selected {
        drawn.add("Selection", words.clone());
    }
    let sel = selector("CardLine", ix, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .items_baseline()
        .gap(px(GAP))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .map(|d| {
            if p.boxed {
                d.py(px(5.))
                    .px(px(12.))
                    .line_height(px(LINE))
                    .border_1()
                    .border_color(look::SEPARATOR)
                    .rounded(px(ARC))
                    .bg(if p.selected {
                        selection_bg(drawn)
                    } else {
                        look::PANEL_BG.rgba()
                    })
            } else {
                d.h(px(24.))
                    .items_center()
                    .px(px(4.))
                    .rounded(px(4.))
                    .when(p.selected, |d| d.bg(selection_bg(drawn)))
            }
        })
        .when(!p.selected, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        // a grill's answered question opens again; a waiting card shows again
        .when(p.boxed || p.waiting, |d| {
            d.tooltip(crate::kit::tooltip(
                if p.waiting {
                    "Show the question"
                } else {
                    "Open it again"
                },
                Some("⏎"),
            ))
        })
        .child(mark(if p.waiting {
            look::ABE_NEEDS_YOU.rgba()
        } else {
            look::TEXT_DIM.rgba()
        }))
        .child(text(
            format!("{} ·", p.head),
            look::UI_SMALL_FONT_SIZE,
            look::TEXT_DIM.rgba(),
        ))
        .when_some(p.text.clone(), |d, t| {
            d.child(shrinking(t, look::TEXT.rgba()))
        })
        .when_some(p.n, |d, n| {
            d.child(text(
                format!("({n})"),
                look::UI_SMALL_FONT_SIZE,
                look::TEXT_DIM.rgba(),
            ))
        })
        .when_some(p.note.clone(), |d, n| {
            d.child(text(
                format!("· {n}"),
                look::UI_SMALL_FONT_SIZE,
                look::TEXT_DIM.rgba(),
            ))
        });
    clickable(d, id, drawn).into_any_element()
}

fn round(
    id: Option<&str>,
    p: &GrillRoundProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut gpui_kit::App,
) -> AnyElement {
    let title = format!(
        "Round {} · {} question{}",
        p.round,
        p.questions,
        if p.questions == 1 { "" } else { "s" }
    );
    let progress = format!("{} of {} answered", p.answered, p.questions);
    let ix = drawn.add("GrillRound", format!("◆ {title}  {progress}"));
    let sel = selector("GrillRound", ix, id);
    // one dot per question, as TS says: answered, the current one, to do
    let dots: Vec<&str> = p
        .dots
        .iter()
        .map(|d| match d {
            GrillDot::Done => "done",
            GrillDot::Now => "now",
            GrillDot::Todo => "todo",
        })
        .collect();
    drawn.add("GrillDots", dots.join(" "));
    let dot = |d: &str| {
        div()
            .flex_none()
            .size(px(DOT))
            .rounded(px(DOT / 2.))
            .bg(match d {
                "now" => look::ABE_NEEDS_YOU,
                "done" => look::TEXT_DIM,
                _ => look::SEPARATOR,
            })
    };
    let stack = p.stack.map(|s| {
        let words = format!("{} of {}", s.n, s.of);
        drawn.add("CardStack", words.clone());
        text(words, look::UI_SMALL_FONT_SIZE, look::TEXT_DIM.rgba())
    });
    let header = div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(GAP))
        .px(px(4.))
        .line_height(px(20.))
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(mark(look::ABE_NEEDS_YOU.rgba()))
        .child(text(title, look::UI_SMALL_FONT_SIZE, look::TEXT.rgba()))
        .child(
            div()
                .ml_auto()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .children(dots.iter().map(|d| dot(d))),
                )
                .child(text(
                    progress,
                    look::UI_SMALL_FONT_SIZE,
                    look::TEXT_DIM.rgba(),
                ))
                .children(stack),
        );
    let cards = children
        .iter()
        .map(|c| node(c, drawn, cx))
        .collect::<Vec<_>>();
    let foot = match (&p.whose, &p.foot) {
        (Some(w), _) => Some(foot(w, "CardWhose", 4., look::TEXT_DIM.rgba(), drawn)),
        (None, Some(f)) => Some(foot(f, "CardFoot", 4., look::TEXT_DIM.rgba(), drawn).pt(px(2.))),
        _ => None,
    };
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(6.))
        .text_size(px(look::UI_FONT_SIZE))
        .line_height(px(LINE))
        .child(header)
        .children(cards)
        .children(foot);
    clickable(d, id, drawn).into_any_element()
}

fn override_card(id: Option<&str>, p: &OverrideCardProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("OverrideCard", p.title.clone());
    let sel = selector("OverrideCard", ix, id);
    let head = div()
        .flex_none()
        .flex()
        .items_baseline()
        .gap(px(GAP))
        .child(mark(look::ABE_WARN.rgba()))
        .child(shrinking(p.title.clone(), look::TEXT.rgba()));
    let field_words = if p.missing {
        format!("{} (required)", p.reason)
    } else {
        p.reason.clone()
    };
    drawn.add("OverrideField", field_words);
    let border = if p.missing {
        look::ABE_BAD
    } else {
        look::FOCUS_BORDER
    };
    let field = div()
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(4.))
        .pl(px(INDENT))
        .child(
            div()
                .flex()
                .gap(px(6.))
                .line_height(px(SMALL_LINE))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .child(text("Reason", look::UI_SMALL_FONT_SIZE, look::TEXT.rgba()))
                .child(text(
                    "required",
                    look::UI_SMALL_FONT_SIZE,
                    if p.missing {
                        look::ABE_BAD.rgba()
                    } else {
                        look::TEXT_DIM.rgba()
                    },
                )),
        )
        .child(
            div()
                .debug_selector(|| "factory-override-field".into())
                .flex_none()
                .h(px(FIELD_H))
                .flex()
                .items_center()
                .px(px(8.))
                .border_1()
                .border_color(border)
                .rounded(px(look::FIELD_ARC))
                .bg(look::EDITOR_BG)
                .overflow_hidden()
                .whitespace_nowrap()
                .text_color(look::TEXT)
                .child(super::field::caret_line(
                    &p.reason,
                    p.caret,
                    (!p.sending).then(caret),
                )),
        )
        .when_some(p.error.clone(), |d, e| {
            drawn.add("OverrideError", e.clone());
            d.child(
                div()
                    .line_height(px(SMALL_LINE))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::ABE_BAD)
                    .child(SharedString::from(e)),
            )
        });
    let facts = div()
        .flex_none()
        .flex()
        .flex_col()
        .pl(px(INDENT))
        .children(p.facts.iter().map(|f| {
            drawn.add("OverrideFact", format!("{}  {}", f.label, f.text));
            div()
                .flex()
                .gap(px(12.))
                .h(px(LINE))
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(
                    div()
                        .flex_none()
                        .w(px(FACT_LABEL_W))
                        .child(SharedString::from(f.label.clone())),
                )
                .child(shrinking(f.text.clone(), look::TEXT_DIM.rgba()))
        }));
    let keys = if p.sending {
        "Overriding…".to_owned()
    } else {
        p.foot.clone()
    };
    let b = block(alpha(look::ABE_WARN.rgba(), EDGE_ALPHA))
        .debug_selector(move || sel)
        .mb(px(6.))
        .child(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(head)
                .child(under_line(&p.line, "OverrideLine", drawn).mt(px(2.))),
        )
        .child(field)
        .child(facts)
        .child(foot(
            &keys,
            "CardFoot",
            INDENT,
            look::TEXT_DIM.rgba(),
            drawn,
        ));
    clickable(b, id, drawn).into_any_element()
}

fn pill(id: Option<&str>, p: &DeferredPillProps, drawn: &mut Drawn) -> AnyElement {
    let lead = format!("◆ {} for later", p.count);
    let ix = drawn.add("DeferredPill", format!("{lead} · {}", p.text));
    let sel = selector("DeferredPill", ix, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .max_w_full()
        .h(px(PILL_H))
        .flex()
        .items_center()
        .gap(px(6.))
        .px(px(10.))
        .rounded(px(PILL_H / 2.))
        .bg(look::abe_badge_bg(look::ABE_NEEDS_YOU.rgba()))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .tooltip(crate::kit::tooltip("Back to the question", Some("⏎")))
        .child(text(
            lead,
            look::UI_SMALL_FONT_SIZE,
            look::ABE_NEEDS_YOU.rgba(),
        ))
        .child(shrinking(p.text.clone(), look::TEXT.rgba()));
    // `align-self: flex-start`: as wide as its words
    let row = div().flex_none().w_full().flex().child(d);
    clickable(row, id, drawn).into_any_element()
}
