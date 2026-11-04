//! The Factory view's Board (board F-Board), the Rust half of
//! `abe/packages/ui/src/board/board.ts`: the Board's header (title, Mine · Team tabs, dim counts, a
//! note), its columns side by side (BoardColumns: equal shares of the width, or `scroll.width`
//! each moved `scroll.offset` px left when they do not fit), a column (BoardColumn: its header,
//! then its cards) and the card (BoardCard: `#id`, type, initials, points; the title in two lines
//! at most; the rail row, one line: the stage rail, the stage word, the state's glyph and word
//! in its hue, the time, the box mark; too narrow, whole words go (the stage word, then the box
//! mark's), then the state's word is cut with an ellipsis, measured at the card's width
//! (`ui::fit`); the initials a round badge; the tooltip only when it says what the card
//! does not, below the card), at DS 2.0's values (FactoryPage, BoardCard). Props in, pixels
//! out: which card stands out or is selected is the bridge's.

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{
    Anchor, AnyElement, App, AppContext as _, Bounds, BoxShadow, Context, FontWeight,
    InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels, Render, Rgba,
    SharedString, StatefulInteractiveElement as _, Styled, Window, anchored, canvas, div, font,
    point, prelude::FluentBuilder as _, px, relative,
};
use serde::Deserialize;

use super::draw::{Drawn, agent_color, clickable, hue, node, selector};
use super::protocol::{AgentState, CloudState, Hue, Node, Tab};
use crate::kit::{Icon, IconName};
use crate::kit::{fit, fit_line};
use crate::look;
use crate::render::EDITOR_FONT;

/// A selection's look: none, where the keys are, or elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Selection {
    #[default]
    Default,
    Selected,
    SelectedInactive,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Count {
    pub text: String,
    pub hue: Option<Hue>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct BoardHeaderProps {
    pub title: String,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    pub selected: Option<String>,
    /// The Board has the keys: its selected tab in the active look.
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub counts: Vec<Count>,
    pub note: Option<String>,
    /// Dim at the far right while the columns scroll sideways: those out of view.
    pub more: Option<String>,
}

/// The columns' sideways scroll: each column's width, how far the row is moved left and the
/// width they are shown in (the scrollbar's thumb).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Scroll {
    pub width: f32,
    pub offset: f32,
    pub view: f32,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct ColumnsProps {
    pub scroll: Option<Scroll>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct ColumnProps {
    pub name: String,
    /// None until the board is read.
    pub count: Option<u64>,
    pub note: Option<String>,
    #[serde(default)]
    pub focused: bool,
    /// Dim in the body: `No stories in Sprint 1`.
    pub empty: Option<String>,
    /// An empty column's dim `＋ New card` row: a click is `newcard:<name>`.
    pub add: Option<String>,
}

/// One segment of the stage rail.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Segment {
    Todo,
    Done,
    Now,
    Need,
    Fail,
    Ready,
    Wait,
}

impl Segment {
    fn word(self) -> &'static str {
        match self {
            Segment::Todo => "todo",
            Segment::Done => "done",
            Segment::Now => "now",
            Segment::Need => "need",
            Segment::Fail => "fail",
            Segment::Ready => "ready",
            Segment::Wait => "wait",
        }
    }
}

/// The box mark at the rail row's right.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxMark {
    Running,
    Starting,
    Asleep,
    Queued,
}

/// A card's rail row.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RailRow {
    pub segments: Vec<Segment>,
    pub stage: Option<String>,
    pub glyph: String,
    pub word: String,
    pub state: AgentState,
    pub time: Option<String>,
    #[serde(rename = "box")]
    pub mark: Option<BoxMark>,
}

/// The card's last row with no run: `No session` dim, `◆ Needs info` in its hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardNote {
    pub text: String,
    pub hue: Option<Hue>,
    /// The card's box mark with no run (a box tagged with the card), at the row's right.
    #[serde(default, rename = "box")]
    pub mark: Option<BoxMark>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Emphasis {
    #[default]
    Normal,
    NeedsYou,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BoardCardProps {
    pub card: u64,
    /// The card has a prototype linked (its `prototype` tag): the mark before `#id`.
    #[serde(default)]
    pub prototype: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub bug: bool,
    pub initials: Option<String>,
    pub points: Option<String>,
    pub title: String,
    pub rail: Option<RailRow>,
    pub note: Option<CardNote>,
    #[serde(default)]
    pub emphasis: Emphasis,
    #[serde(default)]
    pub theirs: bool,
    /// A done card of the sprint (Closed, Done): dim as theirs, the sprint's work done.
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub selection: Selection,
    /// Local mode (LM-Board): its state here over the board's (`Resolved here · GitHub:
    /// Active`): the card dashed in the path hue, this line with the house mark under its title.
    pub local: Option<String>,
    pub tooltip: Option<String>,
    /// The tooltip says more than the card shows whole (a reason): shown on every hover.
    #[serde(default, rename = "tipAdds")]
    pub tip_adds: bool,
}

/// px (DS 2.0 `vs-card`, board F-Board): a card's widest, its radius and padding (8 / 10), the
/// gap between its rows, a line, a title line (two at most), a column's header, the gap between
/// columns and the Board's pad, a rail segment.
pub const CARD_MAX_W: f32 = 360.;
/// px: the prototype mark before a card's `#id`, the facts line's small icon.
const PROTOTYPE_MARK: f32 = 12.;
const CARD_ARC: f32 = 8.;
const CARD_PAD_Y: f32 = 8.;
const CARD_PAD_X: f32 = 10.;
const CARD_ROW_GAP: f32 = 4.;
const LINE_H: f32 = 16.;
const TITLE_LINE_H: f32 = 18.;
const COLUMN_HEADER_H: f32 = 30.;
const COLUMN_GAP: f32 = 6.;
const BOARD_PAD: f32 = 8.;
const SEG_W: f32 = 12.;
/// A rail segment at its narrowest, when a card's row has to give way.
const SEG_MIN_W: f32 = 4.;
/// The box mark's cloud, as the header's.
const CLOUD_SIZE: f32 = 12.;
const SEG_H: f32 = 4.;
const SEG_GAP: f32 = 2.;
/// theirs' type at 60 %.
const THEIRS_TYPE: f32 = 0.6;
/// design `.vs-fhead__title`: 13 / 700, 6 before the tabs.
const BAND_TITLE_GAP: f32 = 6.;

/// The selection's background and border; `focused`: the view has the keyboard.
fn selection_look(sel: Selection, focused: bool) -> Option<(Rgba, Rgba)> {
    match sel {
        Selection::Selected if focused => {
            Some((look::SELECTION_BG.rgba(), look::FOCUS_BORDER.rgba()))
        }
        Selection::Selected | Selection::SelectedInactive => Some((
            look::SELECTION_BG_INACTIVE.rgba(),
            look::ABE_CARD_BORDER.rgba(),
        )),
        Selection::Default => None,
    }
}

/// A card's title colour: theirs dim, as WebStorm's muted rows, until selected: then it reads
/// brighter on the selection as a selected row's dim text does (theirs' dim on the
/// selection blue was 2:1), the selection's text colour while the Board has the keyboard, the
/// plain text on the inactive selection.
fn title_color(theirs: bool, sel: Selection, focused: bool) -> Rgba {
    match (theirs, sel) {
        (false, _) => look::ABE_CARD_TITLE.rgba(),
        (true, Selection::Selected) if focused => look::SELECTION_TEXT.rgba(),
        (true, Selection::Selected | Selection::SelectedInactive) => look::TEXT.rgba(),
        (true, Selection::Default) => look::TEXT_DIM.rgba(),
    }
}

fn note_selection(drawn: &mut Drawn, what: &str, sel: Selection) -> bool {
    let look = selection_look(sel, drawn.focused);
    if let Some((bg, _)) = look {
        let word = if bg == look::SELECTION_BG.rgba() {
            "active"
        } else {
            "inactive"
        };
        drawn.add("Selection", format!("{what} {word}"));
    }
    look.is_some_and(|(bg, _)| bg == look::SELECTION_BG.rgba())
}

fn small(text: impl Into<SharedString>, color: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(color)
        .child(text.into())
}

/// The Board's header (FactoryPage `.vs-boardhead`, 31 px): title, tabs, dim counts, the note at
/// the right (the filter, `Board not read · <reason>`).
pub fn board_header(id: Option<&str>, p: &BoardHeaderProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("BoardHeader", p.title.clone());
    let sel = selector("BoardHeader", ix, id);
    let active = p.active && drawn.focused;
    let mut d = div()
        .debug_selector(move || sel)
        .flex_none()
        .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
        .w_full()
        .flex()
        .items_center()
        .gap(px(look::TOOLWINDOW_TAB_GAP))
        .px(px(BOARD_PAD))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(
            div()
                .flex_none()
                .mr(px(BAND_TITLE_GAP))
                .text_size(px(look::UI_FONT_SIZE))
                .font_weight(FontWeight::BOLD)
                .text_color(look::TEXT)
                .child(SharedString::from(p.title.clone())),
        );
    for tab in &p.tabs {
        drawn.add("Tab", tab.label.clone());
        let selected = p.selected.as_deref() == Some(tab.id.as_str());
        if selected {
            drawn.add(
                "TabSelected",
                format!(
                    "{} {}",
                    tab.label,
                    if active { "active" } else { "inactive" }
                ),
            );
        }
        let (bg, border) = if active {
            (
                look::TOOLWINDOW_TAB_SELECTED_BG,
                look::TOOLWINDOW_TAB_SELECTED_BORDER,
            )
        } else {
            (
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG,
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER,
            )
        };
        let tab_id = tab.id.clone();
        // short of room a tab not shown gives way first (an ellipsis), then the hint, then the
        // note; the shown one never
        let t = div()
            .debug_selector(move || format!("factory-node-{tab_id}"))
            .map(|mut d| {
                if selected {
                    d.style().flex_shrink = Some(0.);
                } else {
                    d.style().flex_shrink = Some(TAB_SHRINK);
                    d = d.min_w_0().overflow_hidden().text_ellipsis();
                }
                d
            })
            .h(px(look::TOOLWINDOW_TAB_HEIGHT))
            .px(px(look::TOOLWINDOW_TAB_PAD_X - 1.))
            .flex()
            .items_center()
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .text_color(look::TEXT)
            .when(selected, |d| d.bg(bg).border_color(border))
            .when(!selected, |d| {
                d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
            })
            .child(SharedString::from(tab.label.clone()));
        d = d.child(clickable(t, Some(&tab.id), drawn));
    }
    // the rest sits at the right end (F-Board): the note, the counts, the columns out of view
    d = d.child(div().flex_1());
    let d = d.when_some(p.note.clone(), |d, note| {
        drawn.add("Note", note.clone());
        d.child(board_note(note))
    });
    let counts = (!p.counts.is_empty()).then(|| {
        let mut row = div()
            .debug_selector(|| "factory-BoardCounts".into())
            .flex_none()
            .flex()
            .items_center()
            .gap(px(look::TOOLWINDOW_TAB_GAP));
        for (i, c) in p.counts.iter().enumerate() {
            drawn.add("BoardCount", c.text.clone());
            if i > 0 || p.note.is_some() {
                row = row.child(small("·", look::TEXT_DIM.rgba()));
            }
            row = row.child(small(
                c.text.clone(),
                c.hue.map_or(look::TEXT_DIM.rgba(), hue),
            ));
        }
        row
    });
    let d = d.children(counts);
    // the columns out of view, at the far right, after the note or counts with a dot;
    // short of room the hint gives way first (an ellipsis), then the note
    let d = d.when_some(p.more.clone(), |d, more| {
        drawn.add("More", more.clone());
        let text = if p.note.is_none() && p.counts.is_empty() {
            more
        } else {
            format!("· {more}")
        };
        d.child(
            div()
                .debug_selector(|| "factory-BoardMore".into())
                .map(|mut d| {
                    d.style().flex_shrink = Some(MORE_SHRINK);
                    d
                })
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(text)),
        )
    });
    clickable(d, id, drawn).into_any_element()
}

/// How much faster a tab not shown gives way than the note, short of room: before the hint.
const TAB_SHRINK: f32 = 40.;

/// How much faster the header's hint of the columns out of view gives way than the note.
const MORE_SHRINK: f32 = 20.;

/// The header's note: cut with an ellipsis at the header's edge (a long `Board not read ·
/// <reason>`), and then its tooltip shows it whole, wrapped, below the note.
fn board_note(note: String) -> impl IntoElement {
    let at = Rc::new(Cell::new(None));
    let cut = Rc::new(Cell::new(false));
    let tip = CardTip {
        text: note.clone().into(),
        more: false,
        cut: cut.clone(),
        title_cut: Rc::new(Cell::new(false)),
        at: at.clone(),
    };
    let text = note.clone();
    let probe = canvas(
        move |b, window, _| {
            at.set(Some(b));
            cut.set(small_width(window, &text) > f32::from(b.size.width).ceil());
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    div()
        .id("board-note")
        .debug_selector(|| "factory-BoardNote".into())
        .relative()
        .min_w_0()
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(note))
        .child(probe)
        .tooltip(move |_, cx| {
            let tip = tip.clone();
            cx.new(|_| tip).into()
        })
}

/// px: a step of the wheel down a column, a card at its tallest and the gap under it
/// (`CARD_PITCH` in `factory.ts`, which scrolls the column by whole cards).
const CARD_PITCH: f32 = 100.;

/// Which way the wheel scrolls the Board: sideways (the columns) or down a column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

/// The wheel and the trackpad over the Board counted into whole steps: pixels by the
/// step's size (a card down a column, a column sideways), a mouse wheel's lines one step each.
/// The remainder waits for the next event; another column under the pointer, or pixels after
/// lines (or lines after pixels), start anew.
#[derive(Debug, Default)]
pub struct Wheels {
    x: Tally,
    y: Tally,
}

/// One axis' tally: over what, whether in lines, and what is not a whole step yet.
#[derive(Debug, Default)]
struct Tally {
    target: Option<String>,
    lines: bool,
    pending: f32,
}

impl Wheels {
    /// The whole steps `delta` adds on `axis` over `target`: + down / right, − up / left.
    pub fn steps(
        &mut self,
        target: &str,
        axis: Axis,
        delta: gpui_kit::ScrollDelta,
        step: f32,
    ) -> i32 {
        let count = match axis {
            Axis::X => &mut self.x,
            Axis::Y => &mut self.y,
        };
        let lines = matches!(delta, gpui_kit::ScrollDelta::Lines(_));
        if count.target.as_deref() != Some(target) || count.lines != lines {
            count.target = Some(target.to_owned());
            count.lines = lines;
            count.pending = 0.;
        }
        let units = match (delta, axis) {
            (gpui_kit::ScrollDelta::Pixels(p), Axis::X) if step > 0. => p.x.as_f32() / step,
            (gpui_kit::ScrollDelta::Pixels(p), Axis::Y) if step > 0. => p.y.as_f32() / step,
            (gpui_kit::ScrollDelta::Pixels(_), _) => 0.,
            (gpui_kit::ScrollDelta::Lines(l), Axis::X) => l.x,
            (gpui_kit::ScrollDelta::Lines(l), Axis::Y) => l.y,
        };
        count.pending += units;
        let whole = count.pending.trunc();
        count.pending -= whole;
        // GPUI's delta is the content's move: content pulled down shows what is above
        -(whole as i32)
    }
}

/// Whether `delta` moves mainly on `axis`: a scroll down with a little sideways drift never
/// slides the columns (nor a sideways one the column).
pub(super) fn moves_on(delta: gpui_kit::ScrollDelta, axis: Axis) -> bool {
    let (x, y) = match delta {
        gpui_kit::ScrollDelta::Pixels(p) => (p.x.as_f32().abs(), p.y.as_f32().abs()),
        gpui_kit::ScrollDelta::Lines(l) => (l.x.abs(), l.y.abs()),
    };
    match axis {
        Axis::X => x > y,
        Axis::Y => y > 0. && y >= x,
    }
}

/// The Board's columns side by side: equal shares of the width (an empty one keeps its share), or
/// with `scroll` each `scroll.width` px, the row moved `scroll.offset` px left inside the Board.
pub fn columns(
    id: Option<&str>,
    p: &ColumnsProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("BoardColumns", children.len().to_string());
    if let Some(s) = p.scroll {
        drawn.add("Scroll", format!("{} {}", s.width, s.offset));
    }
    let sel = selector("BoardColumns", ix, id);
    let kids: Vec<AnyElement> = children
        .iter()
        .map(|c| {
            let k = node(c, drawn, cx);
            let slot = div().h_full().min_w_0().flex().flex_col();
            match p.scroll {
                Some(s) => slot.flex_none().w(px(s.width)),
                // flex-basis 0: the same width whatever each holds
                None => slot.flex_1().flex_basis(px(0.)),
            }
            .child(k)
            .into_any_element()
        })
        .collect();
    // scrolled: the row is taken out of the layout (absolute), so its width never widens the
    // Board, and moved left by the offset inside the clipped area
    let row = div()
        .flex()
        .gap(px(COLUMN_GAP))
        .map(|d| match p.scroll {
            Some(s) => d.absolute().top_0().bottom_0().left(px(-s.offset)),
            None => d.size_full(),
        })
        .children(kids);
    // the wheel sideways moves the columns by whole ones, only while they scroll
    let sideways = match (id, p.scroll, drawn.sink.clone()) {
        (Some(id), Some(s), Some(sink)) => Some((id.to_owned(), s.width + COLUMN_GAP, sink)),
        _ => None,
    };
    let n = children.len() as f32;
    div()
        .debug_selector(move || sel)
        .relative()
        .when_some(sideways, |d, (id, step, sink)| {
            d.on_scroll_wheel(move |ev, _, cx| {
                if moves_on(ev.delta, Axis::X) {
                    sink.wheel(id.clone(), Axis::X, ev.delta, step, cx);
                }
            })
        })
        .size_full()
        .min_w_0()
        .px(px(BOARD_PAD))
        .pb(px(BOARD_PAD))
        .child(
            div()
                .relative()
                .size_full()
                .min_w_0()
                .overflow_hidden()
                .child(row),
        )
        .when_some(p.scroll, |d, s| d.child(sideways_bar(s, n, drawn)))
        .into_any_element()
}

/// px: the sideways scrollbar's thumb (WebStorm's transparent scrollbar, laid in the Board's
/// bottom pad), and its gap above the pad's bottom.
const BAR_THICK: f32 = 4.;
const BAR_INSET: f32 = 2.;

/// The scrolled columns' thumb: always shown while they scroll, so the columns out of
/// view are never a mystery; its width the share in view, at the share scrolled past.
fn sideways_bar(s: Scroll, n: f32, drawn: &mut Drawn) -> impl IntoElement {
    let total = (n * s.width + (n - 1.).max(0.) * COLUMN_GAP).max(1.);
    let size = (s.view / total).clamp(0., 1.);
    let at = (s.offset / total).clamp(0., 1. - size);
    drawn.add("ScrollBar", format!("{:.2} {:.2}", at, size));
    div()
        .absolute()
        .left(px(BOARD_PAD))
        .right(px(BOARD_PAD))
        .bottom(px(BAR_INSET))
        .h(px(BAR_THICK))
        .child(
            div()
                .debug_selector(|| "factory-BoardScrollBar".into())
                .absolute()
                .top_0()
                .h_full()
                .left(relative(at))
                .w(relative(size))
                .rounded(px(BAR_THICK / 2.))
                .bg(look::SCROLLBAR_THUMB),
        )
}

/// One Azure column (BoardColumn): its header (name, count, note), then its cards, at most
/// `CARD_MAX_W` wide each, left-aligned.
pub fn column(
    id: Option<&str>,
    p: &ColumnProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("BoardColumn", p.name.clone());
    if p.focused {
        drawn.add("ColumnFocused", p.name.clone());
    }
    let sel = selector("BoardColumn", ix, id);
    let header = div()
        .flex_none()
        .h(px(COLUMN_HEADER_H))
        .px(px(look::ABE_LANE_HEADER_PAD_X))
        .flex()
        .items_center()
        .gap(px(look::ABE_CARD_GAP))
        .whitespace_nowrap()
        .overflow_hidden()
        .child(
            div()
                .flex_none()
                .text_color(look::TEXT)
                .when(p.focused, |d| d.font_weight(FontWeight::BOLD))
                .child(SharedString::from(p.name.clone())),
        )
        .when_some(p.count, |d, n| {
            let name = p.name.clone();
            d.child(
                div()
                    .debug_selector(move || format!("factory-ColumnCount-{name}"))
                    .flex_none()
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(n.to_string())),
            )
        })
        .when_some(p.note.clone(), |d, note| {
            drawn.add("ColumnNote", note.clone());
            d.child(div().flex_1()).child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(note)),
            )
        });
    let kids: Vec<AnyElement> = children.iter().map(|c| node(c, drawn, cx)).collect();
    let d = div()
        .debug_selector(move || sel)
        .size_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(look::ABE_CARD_GAP))
        .px(px(look::ABE_CARD_GAP))
        .pb(px(look::ABE_CARD_GAP))
        .overflow_hidden()
        .rounded(px(look::ABE_LANE_ARC))
        .bg(look::ABE_LANE_BG)
        .child(header)
        .when_some(p.empty.clone(), |d, e| {
            drawn.add("ColumnEmpty", e.clone());
            d.child(
                div()
                    .flex_none()
                    .px(px(look::ABE_LANE_HEADER_PAD_X - look::ABE_CARD_GAP))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(e)),
            )
        })
        .children(
            kids.into_iter()
                .map(|k| div().flex_none().w_full().max_w(px(CARD_MAX_W)).child(k)),
        )
        .children(p.add.clone().map(|a| {
            drawn.add("ColumnAdd", a.clone());
            let click = format!("newcard:{}", p.name);
            let row = div()
                .debug_selector(|| "factory-column-add".into())
                .flex_none()
                .px(px(look::ABE_LANE_HEADER_PAD_X - look::ABE_CARD_GAP))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(a));
            match drawn.sink.clone() {
                Some(sink) => row
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        sink.click(click.clone(), window, cx);
                    })
                    .into_any_element(),
                None => row.into_any_element(),
            }
        }));
    // the wheel down the column under the pointer scrolls it by whole cards
    let d = match (id, drawn.sink.clone()) {
        (Some(id), Some(sink)) => {
            let id = id.to_owned();
            d.on_scroll_wheel(move |ev, _, cx| {
                if moves_on(ev.delta, Axis::Y) {
                    sink.wheel(id.clone(), Axis::Y, ev.delta, CARD_PITCH, cx);
                }
            })
        }
        _ => d,
    };
    clickable(d, id, drawn).into_any_element()
}

pub(crate) fn segment_color(s: Segment) -> Rgba {
    match s {
        Segment::Todo => look::SEPARATOR.rgba(),
        Segment::Done | Segment::Ready => look::ABE_GOOD.rgba(),
        Segment::Now => look::ABE_WARN.rgba(),
        Segment::Need => look::ABE_NEEDS_YOU.rgba(),
        Segment::Fail => look::ABE_BAD.rgba(),
        Segment::Wait => look::TEXT_DIM.rgba(),
    }
}

/// The stage rail's segments, 12 × 4 px, 2 apart (Chat's header draws them too).
pub(super) fn segments(segs: &[Segment]) -> gpui_kit::Div {
    segments_of(segs, SEG_W)
}

/// A card's rail segments narrowed to `w` px each (`SEG_MIN_W` at the least) when its row must.
fn segments_of(segs: &[Segment], w: f32) -> gpui_kit::Div {
    div()
        .flex_none()
        .flex()
        .gap(px(SEG_GAP))
        .children(segs.iter().map(|s| {
            div()
                .flex_none()
                .w(px(w))
                .h(px(SEG_H))
                .rounded(px(SEG_H / 2.))
                .bg(segment_color(*s))
        }))
}

/// The gap between the state's glyph, its word and its time, and before the box mark's word.
const WORD_GAP: f32 = 4.;

/// A word's drawn width in the rail row's font (the UI font, small), in whole px as layout
/// rounds it.
fn small_width(window: &Window, text: &str) -> f32 {
    f32::from(crate::kit::width(
        window,
        text,
        crate::render::ui_font(),
        px(look::UI_SMALL_FONT_SIZE),
    ))
    .ceil()
}

/// The box mark's cloud, word and colour: the header's 12 px cloud (`workspaces::cloud`) in the
/// accent and filled while its box runs, dashed while it starts; `☁ asleep` and `☁ Queued` an
/// outline, dim.
fn mark_look(m: BoxMark) -> (CloudState, &'static str, Rgba) {
    match m {
        BoxMark::Running => (CloudState::Running, "", look::ABE_ACCENT.rgba()),
        BoxMark::Starting => (CloudState::Starting, "", look::ABE_ACCENT.rgba()),
        BoxMark::Asleep => (CloudState::Asleep, "asleep", look::TEXT_DIM.rgba()),
        BoxMark::Queued => (CloudState::Asleep, "Queued", look::TEXT_DIM.rgba()),
    }
}

/// The box mark at the row's right (pushed there by the free room, `WORD_GAP`… after the state
/// when the row is full): the cloud, and its word when the row keeps it.
fn mark_el(m: BoxMark, rail: usize, word: bool) -> gpui_kit::Div {
    let (cloud, text, fg) = mark_look(m);
    div()
        .debug_selector(move || format!("factory-RailMark-{rail}"))
        .flex_none()
        .ml_auto()
        .pl(px(look::ABE_CARD_GAP))
        .flex()
        .items_center()
        .text_color(fg)
        .child(
            div()
                .debug_selector(move || format!("factory-RailBox-{rail}"))
                .flex_none()
                .child(super::workspaces::cloud(cloud, CLOUD_SIZE, fg)),
        )
        .when(word && !text.is_empty(), |d| {
            d.child(
                div()
                    .debug_selector(move || format!("factory-RailBoxClip-{rail}"))
                    .flex_none()
                    .ml(px(WORD_GAP))
                    .child(
                        div()
                            .debug_selector(move || format!("factory-RailBoxWord-{rail}"))
                            .whitespace_nowrap()
                            .child(text),
                    ),
            )
        })
}

/// The box mark's own width and its word's (with its gap), as the row measures them.
fn mark_widths(m: Option<BoxMark>, window: &Window) -> (f32, Option<f32>) {
    let Some(m) = m else { return (0., None) };
    let (_, text, _) = mark_look(m);
    let word = (!text.is_empty()).then(|| WORD_GAP + small_width(window, text));
    (look::ABE_CARD_GAP + CLOUD_SIZE, word)
}

/// A word shown whole, or cut to `cut` px with an ellipsis.
fn word_el(text: String, color: Rgba, cut: Option<f32>, sel: String) -> gpui_kit::Div {
    div()
        .debug_selector(move || sel)
        .flex_none()
        .whitespace_nowrap()
        .text_color(color)
        .when_some(cut, |d, w| d.w(px(w)).overflow_hidden().text_ellipsis())
        .child(text)
}

/// The rail row, one line at any card width: the five segments, the stage word, the state's
/// glyph and word in its hue, ` · 21 min`, the box mark at the right. Too narrow, words go whole
/// (never a word clipped part-way, `Bı`): the stage word first (the segments still say
/// the stage), then the box mark's word; then the segments narrow (to `SEG_MIN_W` each); only
/// then the state's word is cut, with an ellipsis. The glyph, the time and the cloud always
/// show. `cut` is told when the state's word is cut (the card's tooltip then shows). `Done`:
/// `✓ On test · 31 min`.
fn rail_row(r: &RailRow, card: u64, cut: Rc<Cell<bool>>, drawn: &mut Drawn) -> gpui_kit::Div {
    let words = [
        r.stage.clone().unwrap_or_default(),
        format!("{} {}", r.glyph, r.word),
    ]
    .iter()
    .filter(|w| !w.is_empty())
    .cloned()
    .collect::<Vec<_>>()
    .join(" ");
    let words = match &r.time {
        Some(t) => format!("{words} · {t}"),
        None => words,
    };
    let ix = drawn.add("Rail", words);
    drawn.add(
        "Segments",
        r.segments
            .iter()
            .map(|s| s.word())
            .collect::<Vec<_>>()
            .join(" "),
    );
    if let Some(m) = r.mark {
        drawn.add(
            "BoxMark",
            format!(
                "#{} {}",
                super::local::card_name(card),
                format!("{m:?}").to_lowercase()
            ),
        );
    }
    let r = r.clone();
    let build = move |width: Pixels, window: &mut Window, _: &mut App| {
        let n = r.segments.len() as f32;
        let segs = n * SEG_W + (n - 1.).max(0.) * SEG_GAP;
        let time = r.time.as_ref().map(|t| format!("· {t}"));
        let state = look::ABE_CARD_GAP
            + small_width(window, &r.glyph)
            + WORD_GAP
            + time
                .as_deref()
                .map_or(0., |t| WORD_GAP + small_width(window, t));
        let (mark, mark_word) = mark_widths(r.mark, window);
        let stage = r
            .stage
            .as_deref()
            .map(|s| look::ABE_CARD_GAP + small_width(window, s));
        let drops: Vec<f32> = stage.iter().chain(mark_word.iter()).copied().collect();
        let fitted = fit_line(
            segs + state + mark,
            n * (SEG_W - SEG_MIN_W),
            small_width(window, &r.word),
            &drops,
            width.into(),
        );
        // whole px (layout rounds a fraction up, past the row's end)
        let seg_w = if n > 0. {
            (SEG_W - fitted.squeeze / n).floor().max(SEG_MIN_W)
        } else {
            SEG_W
        };
        let show_stage = stage.is_some() && fitted.dropped == 0;
        let show_mark_word = mark_word.is_some() && fitted.dropped < drops.len();
        cut.set(fitted.cut.is_some());
        let fg = agent_color(r.state);
        let glyph = div().flex_none().text_color(fg).child(r.glyph.clone());
        let glyph = if r.state == AgentState::Starting {
            crate::kit::pulsing(
                SharedString::from(format!("factory-rail-pulse-{card}")),
                glyph,
            )
        } else {
            glyph.into_any_element()
        };
        let state = div()
            .debug_selector(move || format!("factory-RailState-{ix}"))
            .flex_none()
            .ml(px(look::ABE_CARD_GAP))
            .flex()
            .items_center()
            .gap(px(WORD_GAP))
            .child(glyph)
            .child(word_el(
                r.word.clone(),
                fg,
                fitted.cut,
                format!("factory-RailWord-{ix}"),
            ))
            .when_some(time, |d, t| d.child(small(t, look::TEXT_DIM.rgba())));
        line(width)
            .child(
                segments_of(&r.segments, seg_w)
                    .debug_selector(move || format!("factory-RailSegs-{ix}")),
            )
            .when(show_stage, |d| {
                d.child(
                    div()
                        .debug_selector(move || format!("factory-RailStage-{ix}"))
                        .flex_none()
                        .pl(px(look::ABE_CARD_GAP))
                        .child(word_el(
                            r.stage.clone().unwrap_or_default(),
                            look::TEXT.rgba(),
                            None,
                            format!("factory-RailStageWord-{ix}"),
                        )),
                )
            })
            .child(state)
            .when_some(r.mark, |d, m| d.child(mark_el(m, ix, show_mark_word)))
            .into_any_element()
    };
    fit_row(format!("factory-Rail-{ix}"), build)
}

/// A card's one-line row as wide as the card, drawn by `build` at that width (`ui::fit`).
fn fit_row(
    sel: String,
    build: impl FnOnce(Pixels, &mut Window, &mut App) -> AnyElement + 'static,
) -> gpui_kit::Div {
    div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .min_w_0()
        .h(px(LINE_H))
        .child(fit(LINE_H, build))
}

/// What a fitted row's words sit in: `width` px, one small line, nothing past its end.
fn line(width: Pixels) -> gpui_kit::Div {
    div()
        .w(width)
        .h(px(LINE_H))
        .flex()
        .flex_nowrap()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .line_height(px(LINE_H))
}

/// The card's last row with no run: its note (`No session` dim, `◆ Needs info` in its hue), cut
/// with an ellipsis when it must, and its box mark at the right, whose word goes whole
/// first.
fn note_row(
    note: Option<&CardNote>,
    card: u64,
    cut: Rc<Cell<bool>>,
    drawn: &mut Drawn,
) -> gpui_kit::Div {
    let (text, fg) = note.map_or((String::new(), look::TEXT_DIM.rgba()), |n| {
        (n.text.clone(), n.hue.map_or(look::TEXT_DIM.rgba(), hue))
    });
    let ix = drawn.add("CardNote", text.clone());
    let mark = note.and_then(|n| n.mark);
    if let Some(m) = mark {
        drawn.add(
            "BoxMark",
            format!(
                "#{} {}",
                super::local::card_name(card),
                format!("{m:?}").to_lowercase()
            ),
        );
    }
    let build = move |width: Pixels, window: &mut Window, _: &mut App| {
        let (fixed, mark_word) = mark_widths(mark, window);
        let drops: Vec<f32> = mark_word.into_iter().collect();
        let fitted = fit_line(fixed, 0., small_width(window, &text), &drops, width.into());
        cut.set(fitted.cut.is_some());
        line(width)
            .child(word_el(
                text,
                fg,
                fitted.cut,
                format!("factory-CardNoteText-{ix}"),
            ))
            .when_some(mark, |d, m| {
                d.child(mark_el(m, ix, fitted.dropped < drops.len()))
            })
            .into_any_element()
    };
    fit_row(format!("factory-CardNote-{ix}"), build)
}

/// A card's border and the 1 px ring inside it (2 px in all with the border).
#[derive(Clone, Copy)]
struct CardEdge {
    border: Rgba,
    ring: Option<Rgba>,
}

/// A card's background and edge. Needs you: the needs-you border and ring; selected, the
/// selection's border with the needs-you ring still inside it. Failed: the red border; selected,
/// the selection's colour as the ring inside it. Both stay readable on a selected card.
fn card_edge(emphasis: Emphasis, look: Option<(Rgba, Rgba)>) -> (Rgba, CardEdge) {
    let (bg, sel) = match look {
        Some((bg, border)) => (bg, Some(border)),
        None => (look::ABE_CARD_BG.rgba(), None),
    };
    let edge = match (emphasis, sel) {
        (Emphasis::NeedsYou, Some(s)) => CardEdge {
            border: s,
            ring: Some(look::ABE_NEEDS_YOU.rgba()),
        },
        (Emphasis::NeedsYou, None) => CardEdge {
            border: look::ABE_NEEDS_YOU.rgba(),
            ring: Some(look::ABE_NEEDS_YOU.rgba()),
        },
        (Emphasis::Failed, s) => CardEdge {
            border: look::ABE_BAD.rgba(),
            ring: s,
        },
        (_, s) => CardEdge {
            border: s.unwrap_or(look::ABE_CARD_BORDER.rgba()),
            ring: None,
        },
    };
    (bg, edge)
}

/// A colour of a card's edge, as the tests read it.
fn edge_word(c: Rgba) -> &'static str {
    match c {
        c if c == look::FOCUS_BORDER.rgba() => "focus",
        c if c == look::ABE_NEEDS_YOU.rgba() => "needs-you",
        c if c == look::ABE_BAD.rgba() => "bad",
        _ => "plain",
    }
}

/// A card (DS `vs-card`): `#id` in the accent, the type badge, initials, points; the title in two
/// lines at most; the rail row or its dim note. Standing out or theirs as the bridge says.
pub fn board_card(id: Option<&str>, p: &BoardCardProps, drawn: &mut Drawn) -> AnyElement {
    // a held card reads `#LC1` (its number past local mode's floor)
    let name = format!("#{}", super::local::card_name(p.card));
    let what = format!("{name} {}", p.title);
    let ix = drawn.add("BoardCard", what.clone());
    let sel = selector("BoardCard", ix, id);
    note_selection(drawn, &name, p.selection);
    if p.emphasis != Emphasis::Normal {
        drawn.add("Emphasis", format!("{name} {:?}", p.emphasis));
    }
    if p.theirs {
        drawn.add("Theirs", name.clone());
    }
    if p.closed {
        drawn.add("Closed", name.clone());
    }
    if p.prototype {
        drawn.add("PrototypeMark", name.clone());
    }
    // a teammate's card and a done one read dim
    let dim = p.theirs || p.closed;
    let look = selection_look(p.selection, drawn.focused);
    let (bg, edge) = card_edge(p.emphasis, look);
    let kind = if p.bug {
        look::ABE_BUG
    } else {
        look::ABE_STORY
    };
    let facts = div()
        .flex_none()
        .h(px(LINE_H))
        .flex()
        .items_center()
        .gap(px(look::ABE_CARD_GAP))
        .whitespace_nowrap()
        // a prototype's card: the preview mark before its number, also once launched
        .when(p.prototype, |d| {
            d.child(Icon::new(IconName::PreviewOnly).size(px(PROTOTYPE_MARK)))
        })
        .child(small(name.clone(), look::ABE_ACCENT.rgba()).font(font(EDITOR_FONT)))
        .child(small(p.kind.clone(), kind.rgba()).when(dim, |d| d.opacity(THEIRS_TYPE)))
        .child(div().flex_1())
        .when_some(p.initials.clone(), |d, who| {
            drawn.add("Initials", format!("{name} {who}"));
            d.child(avatar(who, p.card))
        })
        .when_some(p.points.clone(), |d, pts| {
            d.child(small(pts, look::TEXT_DIM.rgba()))
        });
    // what the card cannot show whole (its title past two lines, its state's word cut): its
    // tooltip then shows
    let cut = Rc::new(Cell::new(false));
    let title_cut = Rc::new(Cell::new(false));
    let title = div()
        .relative()
        .flex_none()
        .min_w_0()
        .max_h(px(2. * TITLE_LINE_H))
        .overflow_hidden()
        .line_height(px(TITLE_LINE_H))
        .line_clamp(2)
        .text_ellipsis()
        .text_size(px(look::UI_FONT_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(title_color(dim, p.selection, drawn.focused))
        .child(SharedString::from(p.title.clone()))
        .child(title_probe(p.title.clone(), title_cut.clone()));
    // local mode's word (LM-Board: 12 px in the path hue)
    let local = p.local.as_ref().map(|l| {
        drawn.add("CardLocal", format!("{name} {l}"));
        div()
            .flex_none()
            .h(px(LINE_H))
            .flex()
            .items_center()
            .gap(px(super::local::HOUSE_GAP))
            .whitespace_nowrap()
            .overflow_hidden()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::ABE_PATH)
            .child(super::local::house(
                super::local::HOUSE,
                look::ABE_PATH.rgba(),
            ))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(SharedString::from(l.clone())),
            )
    });
    let last = match (&p.rail, &p.note) {
        (Some(r), _) => rail_row(r, p.card, cut.clone(), drawn),
        (None, note) => note_row(note.as_ref(), p.card, cut.clone(), drawn),
    };
    drawn.add(
        "CardEdge",
        format!(
            "{name} {}{}",
            edge_word(edge.border),
            edge.ring
                .map_or(String::new(), |r| format!(" · ring {}", edge_word(r)))
        ),
    );
    let border = edge.border;
    let ring = edge.ring.map(|r| {
        vec![BoxShadow {
            color: look::hsla(r),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(1.),
            inset: true,
        }]
    });
    let d = div()
        .id(SharedString::from(format!("factory-card-{}", p.card)))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .py(px(CARD_PAD_Y))
        .px(px(CARD_PAD_X))
        .flex()
        .flex_col()
        .gap(px(CARD_ROW_GAP))
        .rounded(px(CARD_ARC))
        .border_1()
        .border_color(border)
        .bg(bg)
        .when_some(ring, |d, s| d.shadow(s))
        .text_size(px(look::UI_FONT_SIZE))
        .relative()
        .child(facts)
        .child(title)
        .children(local)
        .child(last)
        // local mode's dashed outline over its border (LM-Board: `outline-offset: -1px`)
        .when(p.local.is_some(), |d| {
            let card = p.card;
            d.child(
                div()
                    .debug_selector(move || format!("factory-card-local-{card}"))
                    .absolute()
                    .top(px(-1.))
                    .left(px(-1.))
                    .right(px(-1.))
                    .bottom(px(-1.))
                    .rounded(px(CARD_ARC))
                    .border_1()
                    .border_dashed()
                    .border_color(look::ABE_PATH),
            )
        })
        .when_some(p.tooltip.clone(), |d, t| {
            // shown only when it says what the card does not: the bridge's `tipAdds` (a
            // reason), or the title or the state's word cut where it was drawn
            let at = Rc::new(Cell::new(None));
            let tip = CardTip {
                text: t.into(),
                more: p.tip_adds,
                cut: cut.clone(),
                title_cut: title_cut.clone(),
                at: at.clone(),
            };
            d.child(bounds_probe(at)).tooltip(move |_, cx| {
                let tip = tip.clone();
                cx.new(|_| tip).into()
            })
        });
    let d = match (id, drawn.sink.clone()) {
        // a click selects (`card:<id>`), the second press of a double-click opens the story
        // dialog as ⏎ (`open:card:<id>`), a right-click is the card's
        // menu (`menu:card:<id>`)
        (Some(id), Some(sink)) => {
            let (pick, open, menu) = (id.to_owned(), format!("open:{id}"), format!("menu:{id}"));
            let right = sink.clone();
            d.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |ev, window, cx| {
                    cx.stop_propagation();
                    let id = if ev.click_count == 2 { &open } else { &pick };
                    sink.click(id.clone(), window, cx);
                })
                .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                    cx.stop_propagation();
                    right.click(menu.clone(), window, cx);
                })
        }
        _ => d,
    };
    d.into_any_element()
}

/// px: the initials' round badge (WebStorm's avatar: JetBrains Mono semibold at 13 / 20 of its
/// size), and the gap between a card and its tooltip.
const AVATAR: f32 = 16.;
const TIP_GAP: f32 = 4.;
/// px: a card's tooltip at its widest, wrapped past it.
const TIP_MAX_W: f32 = 480.;

/// The assignee's initials in a round badge (a lone dim `I`, one name's one letter, read as
/// a stray glyph).
fn avatar(who: String, card: u64) -> gpui_kit::Div {
    div()
        .debug_selector(move || format!("factory-Initials-{card}"))
        .flex_none()
        .size(px(AVATAR))
        .rounded_full()
        .bg(look::ABE_CARD_BORDER)
        .flex()
        .items_center()
        .justify_center()
        .font(font(EDITOR_FONT))
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(px(AVATAR * look::PROJECT_ICON_FONT_RATIO))
        .line_height(px(AVATAR))
        .text_color(look::TEXT)
        .child(who)
}

/// Notes whether `title` takes more than the card's two lines at the width it is drawn.
fn title_probe(title: String, cut: Rc<Cell<bool>>) -> impl IntoElement {
    canvas(
        move |b, window, _| {
            let mut f = crate::render::ui_font();
            f.weight = FontWeight::MEDIUM;
            let run = gpui_kit::TextRun {
                len: title.len(),
                font: f,
                color: gpui_kit::black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let lines = window
                .text_system()
                .shape_text(
                    title.into(),
                    px(look::UI_FONT_SIZE),
                    &[run],
                    Some(b.size.width),
                    None,
                )
                .map_or(0, |ls| {
                    ls.iter().map(|l| l.wrap_boundaries().len() + 1).sum()
                });
            cut.set(lines > 2);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// Notes the card's bounds where it is drawn (its tooltip goes below it).
fn bounds_probe(at: Rc<Cell<Option<Bounds<Pixels>>>>) -> impl IntoElement {
    // (an absolute box over the whole card: its bounds are the card's)
    canvas(move |b, _, _| at.set(Some(b)), |_, _, _, _| {})
        .absolute()
        .top_0()
        .left_0()
        .size_full()
}

/// A card's tooltip, and the header note's: drawn below the card, left-aligned
/// with it (above when there is no room below), never over the card; nothing when it says only
/// what the card shows whole. It is built when the hover starts and keeps that frame's cells: a
/// card's bounds, title and word cut as they were drawn then (a card moved meanwhile keeps the
/// tooltip where it was until a new hover starts).
#[derive(Clone)]
struct CardTip {
    text: SharedString,
    /// It says more than the card (the bridge's `tipAdds`).
    more: bool,
    /// The card's state word, its title: cut where it was drawn.
    cut: Rc<Cell<bool>>,
    title_cut: Rc<Cell<bool>>,
    at: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl Render for CardTip {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let shows = self.more || self.cut.get() || self.title_cut.get();
        let Some(card) = self.at.get().filter(|_| shows) else {
            return div();
        };
        // its text wrapped at `TIP_MAX_W` (a long title never wider than the window), in lines
        let room = (window.viewport_size().width - px(2. * TIP_GAP)).min(px(TIP_MAX_W));
        let inner = f32::from(room) - 2. * (look::TOOLTIP_PADDING_X + 1.);
        let lines = (small_width(window, &self.text) / inner.max(1.))
            .ceil()
            .max(1.);
        let tall =
            px(look::TOOLTIP_PADDING_TOP + look::TOOLTIP_PADDING_BOTTOM + lines * LINE_H + 2.);
        let below = card.bottom() + px(TIP_GAP);
        let (at, corner) = if below + tall <= window.viewport_size().height {
            (point(card.left(), below), Anchor::TopLeft)
        } else {
            (
                point(card.left(), card.top() - px(TIP_GAP)),
                Anchor::BottomLeft,
            )
        };
        div().child(
            anchored()
                .position(at)
                .anchor(corner)
                .snap_to_window_with_margin(px(TIP_GAP))
                .child(
                    crate::kit::tooltip_frame()
                        .debug_selector(|| "tooltip".into())
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .line_height(px(LINE_H))
                        .max_w(room)
                        .child(self.text.clone()),
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WCAG contrast of two opaque colours.
    fn contrast(a: Rgba, b: Rgba) -> f32 {
        let lum = |c: Rgba| {
            let f = |v: f32| {
                if v <= 0.03928 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
        };
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    /// A selected teammate's card is easier to read than an unselected one, never 2:1.
    #[test]
    fn a_selected_teammates_title_reads_brighter_on_the_selection() {
        let unselected = contrast(
            title_color(true, Selection::Default, true),
            look::ABE_CARD_BG.rgba(),
        );
        for (sel, focused, bg) in [
            (Selection::Selected, true, look::SELECTION_BG),
            (Selection::Selected, false, look::SELECTION_BG_INACTIVE),
            (
                Selection::SelectedInactive,
                true,
                look::SELECTION_BG_INACTIVE,
            ),
        ] {
            let c = contrast(title_color(true, sel, focused), bg.rgba());
            assert!(c >= 4.5 && c > unselected, "{sel:?} {focused}: {c:.2}");
        }
        // theirs stays dim unselected; mine keeps its title colour
        assert_eq!(
            title_color(true, Selection::Default, true),
            look::TEXT_DIM.rgba()
        );
        assert_eq!(
            title_color(false, Selection::Selected, true),
            look::ABE_CARD_TITLE.rgba()
        );
    }
}
