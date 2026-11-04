//! The rendered Chat's parts (2.1), the Rust half of
//! `abe/packages/ui/src/chat/chat-components.ts`, drawn as canvas board R-Anatomy draws them at the
//! column's 420 px: the Transcript (newest at the bottom, 16 px between turns), a Turn (its parts
//! 8 px apart, step rows abutting), your message with its chip, the changes bar, the diff card
//! ([`super::diff_card`]), step rows (24 px; unfolded, their output), an earlier turn's
//! `12 steps`, the agent's prose through VimStorm's markdown renderer (the card dialog's AbeDetail
//! profile), the stage divider and a queued message with its ×. Props in, pixels out; a node's
//! id (and a button's) sends its click.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, ClipboardItem, Global, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, RenderOnce, Rgba, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, ViewElement, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

mod view;
mod window;

pub(super) use view::{renders, rows_drawn};

use super::anchor::Anchor;
use super::diff_card::{self, DiffCardProps};
use super::draw::{Drawn, clickable, node, own_clicks, selector};
use super::glide::{Glide, GlideOn, Glided};
use super::protocol::{Node, UserInput};
use super::select::{self, TextSel};
use super::story::{CardDraw, Selectable, StoryPart, story};
use crate::editor::markdown::{self, Display, OnLink};
use crate::kit::{Icon, IconName};
use crate::look;
use crate::render::EDITOR_FONT;

/// The parts' kinds, in `CHAT_COMPONENT_KINDS`' order.
pub const KINDS: &[&str] = &[
    "Transcript",
    "Turn",
    "ChatMessage",
    "ChangesBar",
    "DiffCard",
    "StepRow",
    "StepsFold",
    "Prose",
    "StageDivider",
    "NewBelow",
    "QueuedMessage",
];

/// A line of prose: find's current match is in view when this much under it is.
const MATCH_LINE: f32 = 20.;
/// px (board R-Anatomy, R-Turn): `.nv-rlog` gap and padding, `.nv-rturn` gap, a step row, the
/// message's radius and padding, a quiet text button.
const TURN_GAP: f32 = 16.;
const PART_GAP: f32 = 8.;
const LOG_PAD: [f32; 4] = [12., 12., 8., 12.];
const STEP_H: f32 = 24.;
const MARK_W: f32 = 12.;
const MESSAGE_ARC: f32 = 6.;
const TEXT_BUTTON_H: f32 = 22.;
/// The prose's room for its tables and images until its transcript is laid out: the 420 px
/// column less the log's padding.
const PROSE_W: f32 = 396.;
/// The mono lines' size and height (`.nv-rstep__out`, `.nv-rdiff .vs-code`).
pub(super) const MONO_SIZE: f32 = 12.;
pub(super) const MONO_LINE: f32 = 18.;

/// A quiet text button (`Open all`, `Keep`): a click names its id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PartAction {
    pub id: String,
    pub label: String,
    pub tooltip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct TranscriptProps {
    /// Brought into view when it changes: a part's id (its top-level message, turn or divider).
    pub reveal: Option<String>,
    /// Scrolled to the bottom when it changes (`↓ N new`'s ⏎).
    pub bottom: Option<u64>,
    /// Whose transcript: its scroll is kept by it, never carried to another session's.
    pub session: Option<String>,
    /// A question was answered and the agent goes on with it: at the bottom, what goes leaves its
    /// room there for what comes.
    #[serde(default)]
    pub hold: bool,
    /// Find's bar at its top and the matches it marks.
    pub find: Option<TranscriptFind>,
    /// `abe`: the Abe chat's, Abe's face faint behind its parts.
    pub mark: Option<String>,
}

/// Find's bar over the transcript (`chat/find.ts`): the field (`typing`: its caret), `3 of 12`
/// (`none`: `No matches`, red), ↑ ↓ ×; `text` marked in the parts, `at` the current match.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TranscriptFind {
    pub text: String,
    pub caret: Option<usize>,
    #[serde(default)]
    pub typing: bool,
    pub count: Option<String>,
    #[serde(default)]
    pub none: bool,
    pub at: Option<FindAt>,
}

/// The current match: the `n`th in part `part`, counted top to bottom.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FindAt {
    pub part: String,
    pub n: usize,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatMessageProps {
    pub text: String,
    pub context: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChangesBarProps {
    pub files: u64,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    #[serde(rename = "where")]
    pub place: Option<String>,
    #[serde(default)]
    pub actions: Vec<PartAction>,
    /// Keep was pressed: the bar dim, `kept` after its counts.
    #[serde(default)]
    pub kept: bool,
    /// The transcript's cursor is on it (t113d).
    #[serde(default)]
    pub selected: bool,
    /// In place of `N files changed` (a prototype chat's `2 changes`).
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepMark {
    Good,
    Bad,
    Live,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Path,
    Command,
    #[default]
    Text,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRowProps {
    pub mark: StepMark,
    pub verb: String,
    pub object: Option<String>,
    #[serde(default)]
    pub object_kind: ObjectKind,
    pub result: Option<String>,
    pub time: Option<String>,
    #[serde(default)]
    pub unfolded: bool,
    #[serde(default)]
    pub output: Vec<String>,
    /// Output lines not drawn: a dim `show N more` row under it, as a diff card's.
    #[serde(default)]
    pub more: Option<diff_card::DiffMore>,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StepsFoldProps {
    pub count: u64,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProseProps {
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StageDividerProps {
    pub from: String,
    pub to: String,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct NewBelowProps {
    pub count: u64,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct QueuedMessageProps {
    pub text: String,
    pub remove: Option<String>,
}

/// One part of the set, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Transcript(TranscriptProps),
    Turn,
    ChatMessage(ChatMessageProps),
    ChangesBar(ChangesBarProps),
    DiffCard(DiffCardProps),
    StepRow(StepRowProps),
    StepsFold(StepsFoldProps),
    Prose(ProseProps),
    StageDivider(StageDividerProps),
    NewBelow(NewBelowProps),
    QueuedMessage(QueuedMessageProps),
}

impl Part {
    /// The part of `kind` (one of [`KINDS`]) from its props.
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Part, D::Error> {
        use serde::de::Error as _;
        let p = props;
        Ok(match kind {
            "Transcript" => Part::Transcript(serde::Deserialize::deserialize(p)?),
            "Turn" => {
                serde::de::IgnoredAny::deserialize(p)?;
                Part::Turn
            }
            "ChatMessage" => Part::ChatMessage(serde::Deserialize::deserialize(p)?),
            "ChangesBar" => Part::ChangesBar(serde::Deserialize::deserialize(p)?),
            "DiffCard" => Part::DiffCard(serde::Deserialize::deserialize(p)?),
            "StepRow" => Part::StepRow(serde::Deserialize::deserialize(p)?),
            "StepsFold" => Part::StepsFold(serde::Deserialize::deserialize(p)?),
            "Prose" => Part::Prose(serde::Deserialize::deserialize(p)?),
            "StageDivider" => Part::StageDivider(serde::Deserialize::deserialize(p)?),
            "NewBelow" => Part::NewBelow(serde::Deserialize::deserialize(p)?),
            "QueuedMessage" => Part::QueuedMessage(serde::Deserialize::deserialize(p)?),
            _ => {
                return Err(D::Error::custom(format!("not a chat part: {kind}")));
            }
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Transcript(_) => "Transcript",
            Part::Turn => "Turn",
            Part::ChatMessage(_) => "ChatMessage",
            Part::ChangesBar(_) => "ChangesBar",
            Part::DiffCard(_) => "DiffCard",
            Part::StepRow(_) => "StepRow",
            Part::StepsFold(_) => "StepsFold",
            Part::Prose(_) => "Prose",
            Part::StageDivider(_) => "StageDivider",
            Part::NewBelow(_) => "NewBelow",
            Part::QueuedMessage(_) => "QueuedMessage",
        }
    }
}

pub fn part(
    id: Option<&str>,
    p: &Part,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    match p {
        Part::Transcript(t) => transcript(id, t, children, drawn, cx),
        Part::Turn => turn(id, children, drawn, cx),
        Part::ChatMessage(m) => chat_message(id, m, drawn, cx),
        Part::ChangesBar(b) => changes_bar(id, b, drawn),
        Part::DiffCard(d) => diff_card::diff_card(id, d, drawn),
        Part::StepRow(s) => step_row(
            id,
            s,
            drawn,
            select::drawing().as_deref(),
            part_marks(id, cx),
        ),
        Part::StepsFold(s) => steps_folded(id, s, drawn),
        Part::Prose(s) => prose(id, s, drawn, cx),
        Part::StageDivider(s) => stage_divider(id, s, drawn),
        Part::NewBelow(n) => new_below(id, n, drawn),
        Part::QueuedMessage(q) => queued(id, q, drawn),
    }
}

/// The selection's look where the keys are, or grey elsewhere (as every list's).
pub(super) fn selection_bg(drawn: &Drawn) -> Rgba {
    if drawn.focused {
        look::SELECTION_BG.rgba()
    } else {
        look::SELECTION_BG_INACTIVE.rgba()
    }
}

pub(super) fn small(text: impl Into<SharedString>, color: Rgba) -> gpui_kit::Div {
    div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(color)
        .child(text.into())
}

/// `+4 −2`: the added count green, the removed red (`dim`: both dim).
pub(super) fn counts(added: Option<u64>, removed: Option<u64>, dim: bool) -> Vec<gpui_kit::Div> {
    let (plus, minus) = if dim {
        (look::TEXT_DIM, look::TEXT_DIM)
    } else {
        (look::GIT_ADDED, look::ABE_BAD)
    };
    let mut out = Vec::new();
    if let Some(a) = added {
        out.push(small(format!("+{a}"), plus.rgba()));
    }
    if let Some(r) = removed {
        out.push(small(format!("−{r}"), minus.rgba()));
    }
    out
}

/// What a transcript keeps across frames, by its id: its scroll, whether it sits at the bottom,
/// the room its parts had, the `reveal` and `bottom` last applied.
struct Kept {
    scroll: ScrollHandle,
    stuck: Rc<Cell<bool>>,
    width: Rc<Cell<f32>>,
    /// The floor, under the list's top: where the parts ended last frame at the bottom, and while
    /// `hold` the furthest they reached. Held, a marker there keeps the scroll as tall, so a part
    /// that goes (an answered card folding to its line) leaves room there for what comes next
    /// instead of moving everything above it down.
    floor: Rc<Cell<f32>>,
    /// The spacer's height last frame (it keeps a short transcript on the bottom edge): held, it
    /// may shrink, never grow, or the parts would move down after all.
    spacer: Rc<Cell<f32>>,
    /// The scroll's height last frame: another height lays the parts out anew, the floor goes.
    height: Rc<Cell<f32>>,
    revealed: Option<String>,
    bottomed: Option<u64>,
    /// Find's current match last brought into view.
    sought: Option<FindAt>,
    /// Where its parts were painted: a part that moves by itself glides there.
    glide: Rc<RefCell<Glide>>,
    /// The part the reader's line is on: scrolled up, it stays where it is.
    anchor: Rc<RefCell<Anchor>>,
    /// The text the mouse selects in it.
    text: Rc<TextSel>,
    /// Its rows' heights when last drawn: drawn as a view of its own, a row away from the view
    /// stands in at its height ([`window`]).
    heights: Rc<RefCell<window::Heights>>,
}

impl Default for Kept {
    fn default() -> Self {
        Kept {
            scroll: ScrollHandle::new(),
            stuck: Rc::new(Cell::new(true)),
            width: Rc::new(Cell::new(PROSE_W)),
            floor: Rc::new(Cell::new(0.)),
            spacer: Rc::new(Cell::new(f32::MAX)),
            height: Rc::new(Cell::new(0.)),
            revealed: None,
            bottomed: None,
            sought: None,
            glide: Rc::default(),
            anchor: Rc::default(),
            text: Rc::default(),
            heights: Rc::default(),
        }
    }
}

/// The session a transcript id drew last (another session's drawn there since, its parts'
/// places are stale: no glide from them).
#[derive(Default)]
struct DrewLast(Option<String>);

/// The room prose lays out in: its transcript's width, set while the transcript draws its parts.
struct ProseRoom(f32);

impl Default for ProseRoom {
    fn default() -> Self {
        ProseRoom(PROSE_W)
    }
}

impl Global for ProseRoom {}

/// Find's matches being marked as the transcript's parts draw: what is searched (lower case),
/// the current match.
struct FindMark {
    needle: Vec<char>,
    at: Option<FindAt>,
    /// Where the current match was drawn: its text's registry key and first byte.
    current: Cell<Option<((usize, usize), usize)>>,
}

#[derive(Default)]
struct Finding(Option<Rc<FindMark>>);

impl Global for Finding {}

/// One part's matches, counted top to bottom as its texts draw (`find.ts` counts them so).
#[derive(Clone)]
struct PartMarks {
    mark: Rc<FindMark>,
    part: String,
    seen: Rc<Cell<usize>>,
}

impl PartMarks {
    /// `text`'s matches, the current one's `true` (its place kept when `key` names the text).
    fn marks(
        &self,
        text: &str,
        key: Option<(usize, usize)>,
    ) -> Vec<(std::ops::Range<usize>, bool)> {
        found_in(text, &self.mark.needle)
            .into_iter()
            .map(|r| {
                let n = self.seen.get();
                self.seen.set(n + 1);
                let at = self.mark.at.as_ref();
                let current = at.is_some_and(|a| a.part == self.part && a.n == n);
                if let (true, Some(key)) = (current, key) {
                    self.mark.current.set(Some((key, r.start)));
                }
                (r, current)
            })
            .collect()
    }
}

/// Part `id`'s marks while a find shows.
fn part_marks(id: Option<&str>, cx: &App) -> Option<PartMarks> {
    let mark = cx.try_global::<Finding>()?.0.clone()?;
    Some(PartMarks {
        mark,
        part: id?.to_owned(),
        seen: Rc::default(),
    })
}

/// Where `needle` (lower case) is in `text`, ignoring case, none overlapping.
fn found_in(text: &str, needle: &[char]) -> Vec<std::ops::Range<usize>> {
    let lower = |c: char| c.to_lowercase().next().unwrap_or(c);
    let chars: Vec<(usize, char)> = text.char_indices().map(|(i, c)| (i, lower(c))).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while !needle.is_empty() && i + needle.len() <= chars.len() {
        if chars[i..i + needle.len()]
            .iter()
            .map(|(_, c)| *c)
            .eq(needle.iter().copied())
        {
            let end = chars.get(i + needle.len()).map_or(text.len(), |(b, _)| *b);
            out.push(chars[i].0..end);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// `text` with its find matches marked (a step row's words).
fn marked(text: String, marks: Option<&PartMarks>) -> gpui_kit::StyledText {
    let found = marks.map(|m| m.marks(&text, None)).unwrap_or_default();
    let highlights = found
        .into_iter()
        .map(|(r, current)| {
            let mut h = gpui_kit::HighlightStyle::default();
            markdown::mark_found(&mut h, current);
            (r, h)
        })
        .collect::<Vec<_>>();
    gpui_kit::StyledText::new(text).with_highlights(highlights)
}

/// Find's bar: the field, the count, ↑ ↓ × (a click names `<transcript>:find`, `:find:prev`,
/// `:find:next`, `:find:close`).
fn find_bar(transcript: &str, f: &TranscriptFind, drawn: &mut Drawn) -> AnyElement {
    drawn.add("TranscriptFind", f.text.clone());
    if let Some(c) = &f.count {
        drawn.add("TranscriptFindCount", c.clone());
    }
    let id = format!("{transcript}:find");
    let button = |what: &str, icon: IconName, tip: &'static str, key: &'static str| {
        let click = format!("{id}:{what}");
        let sink = drawn.sink.clone();
        crate::kit::IconButton::new(SharedString::from(format!("factory-find-{what}")), icon)
            .tooltip(tip, Some(key))
            .on_click(move |_, window, cx| {
                if let Some(sink) = &sink {
                    sink.click(click.clone(), window, cx);
                }
            })
    };
    let caret = f.typing.then(|| {
        div()
            .flex_none()
            .w(px(look::CARET_WIDTH))
            .h(px(16.))
            .bg(look::CARET)
    });
    let field = div()
        .id("factory-find-field")
        .debug_selector(|| "factory-find-field".into())
        .flex_1()
        .min_w_0()
        .h(px(look::SEARCH_FIELD_HEIGHT))
        .flex()
        .items_center()
        .gap(px(look::SEARCH_FIELD_ICON_GAP))
        .pl(px(look::REPLACE_BAR_FIELD_PAD_LEFT))
        .pr(px(look::REPLACE_BAR_FIELD_PAD_RIGHT))
        .whitespace_nowrap()
        .child(Icon::new(IconName::Search).size(px(look::ICON_SIZE)))
        .child(super::field::caret_line(&f.text, f.caret, caret));
    let field = clickable(field, Some(&id), drawn).cursor_text();
    let count = div()
        .debug_selector(|| "factory-find-count".into())
        .flex_none()
        .min_w(px(48.))
        .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
        .text_color(if f.none {
            look::TEXT_ERROR
        } else {
            look::TEXT_DIM
        })
        .children(f.count.clone().map(SharedString::from));
    div()
        .debug_selector(|| "factory-find".into())
        .flex_none()
        .w_full()
        .flex()
        .items_center()
        .gap(px(look::REPLACE_BAR_GAP))
        .pr(px(look::REPLACE_BAR_PAD_RIGHT))
        .py(px(look::REPLACE_BAR_PAD_Y))
        .bg(look::REPLACE_BAR_BG)
        .border_b_1()
        .border_color(look::REPLACE_BAR_BORDER)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .child(field)
        .child(count)
        .child(button(
            "prev",
            IconName::PreviousDifference,
            "Previous Occurrence",
            "⇧⏎",
        ))
        .child(button(
            "next",
            IconName::NextDifference,
            "Next Occurrence",
            "⏎",
        ))
        .child(button("close", IconName::CloseSmall, "Close", "⎋"))
        .into_any_element()
}

/// A part's copy button: at its top-right while the part is hovered, copying `text`; its press is
/// its own (the part under it neither takes the click nor starts a selection's caret).
fn copy_button(key: &str, text: String, group: SharedString) -> AnyElement {
    div()
        .absolute()
        .top(px(2.))
        .right(px(2.))
        .invisible()
        .group_hover(group, |s| s.visible())
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            crate::kit::IconButton::new(SharedString::from(format!("copy-{key}")), IconName::Copy)
                .tooltip("Copy", None)
                .on_click(move |_, _, cx| {
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                }),
        )
        .into_any_element()
}

/// The transcript: its parts 16 px apart in a scrolling column, the newest at the bottom. It
/// sticks to the bottom while it is there (new parts scroll in); scrolled up, new parts leave it
/// where it is, and it tells the bridge which (a click on `<id>:up` / `<id>:bottom`, so the screen
/// can say `↓ N new`). A trailing NewBelow is pinned under the scrolled parts.
///
/// A Turn's parts are the scroll's own children: `reveal` scrolls the least that shows the
/// part itself, a step row deep in a turn taller than the column too, never the turn's top. Whether
/// it sits at the bottom is read after the list laid out and scrolled in the same frame, so a
/// reveal that moved it up is never taken back by the next frame's stick to the bottom.
fn transcript(
    id: Option<&str>,
    p: &TranscriptProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("Transcript", id.unwrap_or_default());
    let sel = selector("Transcript", ix, id);
    let slot = id.map_or_else(|| sel.clone(), str::to_owned);
    // a view of its own where the host can say which tree it is in, else drawn here, whole
    view::hosted(&sel, &slot, p, drawn, cx)
        .unwrap_or_else(|| body(id, &sel, &slot, p, children, drawn, cx, None))
}

/// How a transcript drawn as a view of its own windows its rows ([`window`]): what its tree was
/// the frame before, and how tall its view is reckoned before it was ever laid out (the window's
/// height).
pub(super) struct Windowed<'a> {
    pub since: view::Since<'a>,
    pub tall: f32,
    /// Counts the rows it draws (tests: what a frame costs).
    pub rows: Rc<Cell<u64>>,
}

/// The transcript's own drawing ([`transcript`]); `windowed`: drawn as a view of its own, its
/// rows windowed; None: every part drawn.
#[allow(clippy::too_many_arguments)]
fn body(
    id: Option<&str>,
    sel: &str,
    slot: &str,
    p: &TranscriptProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
    windowed: Option<Windowed>,
) -> AnyElement {
    let since = windowed.as_ref().map(|w| &w.since);
    let (sel, slot) = (sel.to_owned(), slot.to_owned());
    // one scroll per session (the view's memory): another session pinned starts at its own
    // bottom
    let key = p.session.clone().unwrap_or_default();
    let glides = cx.has_global::<GlideOn>() && !cx.reduce_motion();
    let (
        scroll,
        stuck,
        width,
        floor,
        spacer,
        height,
        reveal,
        bottom,
        glide,
        anchor,
        switched,
        text,
        sought,
        heights,
    ) = {
        // both outlive the transcript leaving the tree (Chat showing Claude Code a while): back,
        // it is where it was, and a `reveal` it applied before is not applied again
        let last = drawn.memory.lasting::<DrewLast>(&slot, "");
        let switched = last.borrow_mut().0.replace(key.clone()).as_ref() != Some(&key);
        let kept = drawn.memory.lasting::<Kept>(&slot, &key);
        let mut kept = kept.borrow_mut();
        let reveal = (p.reveal.is_some() && kept.revealed != p.reveal).then(|| p.reveal.clone());
        let bottom = p.bottom.is_some() && kept.bottomed != p.bottom;
        let sought =
            std::mem::replace(&mut kept.sought, p.find.as_ref().and_then(|f| f.at.clone()));
        kept.revealed = p.reveal.clone();
        kept.bottomed = p.bottom;
        (
            kept.scroll.clone(),
            kept.stuck.clone(),
            kept.width.clone(),
            kept.floor.clone(),
            kept.spacer.clone(),
            kept.height.clone(),
            reveal.flatten(),
            bottom,
            kept.glide.clone(),
            kept.anchor.clone(),
            switched,
            kept.text.clone(),
            sought,
            kept.heights.clone(),
        )
    };
    text.begin();
    {
        let mut a = anchor.borrow_mut();
        if switched {
            a.reset();
        }
        a.begin();
    }
    {
        let mut g = glide.borrow_mut();
        if switched {
            g.reset();
        }
        g.begin(
            glides,
            scroll.offset().y.as_f32(),
            bottom || reveal.is_some(),
        );
    }
    let pinned =
        |c: &Node| matches!(c, Node::ChatPart { part, .. } if matches!(**part, Part::NewBelow(_)));
    let (below, parts): (Vec<&Node>, Vec<&Node>) = children.iter().partition(|c| pinned(c));
    let rows = scrolled(&parts, drawn);
    // prose lays out in the room the parts had last frame
    let room = std::mem::replace(&mut cx.default_global::<ProseRoom>().0, width.get());
    let finding = p.find.as_ref().map(|f| {
        Rc::new(FindMark {
            needle: f.text.to_lowercase().chars().collect(),
            at: f.at.clone(),
            current: Cell::new(None),
        })
    });
    // the current match moved: brought into view once laid out (a long answer's line, not its top)
    let seek = finding
        .clone()
        .filter(|m| m.at.is_some() && sought.as_ref() != m.at.as_ref());
    let outer_find = std::mem::replace(&mut cx.default_global::<Finding>().0, finding);
    let keys: Vec<String> = rows
        .iter()
        .enumerate()
        .map(|(i, (_, c))| row_key(i, c))
        .collect();
    let named: Vec<bool> = rows.iter().map(|(_, c)| c.id().is_some()).collect();
    // the part revealed, the one holding find's current match (in view when its line cannot be
    // found)
    let reveal_at = reveal
        .as_ref()
        .and_then(|r| rows.iter().position(|(_, c)| contains(c, r)));
    let seek_item = seek.as_ref().and_then(|m| {
        let part = &m.at.as_ref()?.part;
        rows.iter().position(|(_, c)| contains(c, part))
    });
    // still where the last frame left it at the bottom: a wheel since then moved it up (the
    // offset is the wheel's, the room last frame's), and that is kept
    let wheeled = scroll.max_offset().y.as_f32() + scroll.offset().y.as_f32() >= 2.;
    let jumps = bottom || (stuck.get() && !wheeled && reveal.is_none());
    let [t, r, b, l] = LOG_PAD;
    // a view of its own draws the rows in and near its view, and those new or changed since
    // the last frame, revealed or holding find's match (every row while text is selected in
    // it: ⌘A and ⌘C take all of it); here, every row
    let plan: Vec<Option<f32>> = match &windowed {
        None => vec![None; rows.len()],
        Some(w) => {
            // a session shown anew: nothing was drawn of it to change, its rows reckoned until
            // drawn near its end (or where it was left)
            let mut must = if switched || matches!(w.since, view::Since::First) {
                vec![false; rows.len()]
            } else {
                w.since.changed(&keys, &rows, pinned)
            };
            for at in [reveal_at, seek_item].into_iter().flatten() {
                must[at] = true;
            }
            let at = scroll.bounds().size.height.as_f32();
            let view = (!text.selecting()).then(|| window::View {
                top: -scroll.offset().y.as_f32(),
                height: if at > 0. { at } else { w.tall },
                bottom: jumps,
            });
            let room = width.get();
            let wants: Vec<window::Row> = keys
                .iter()
                .zip(&rows)
                .zip(&must)
                .map(|((key, (gap, c)), must)| window::Row {
                    key,
                    gap: *gap,
                    est: estimate(c, room),
                    must: *must,
                })
                .collect();
            heights.borrow().plan(&wants, (t, b), view)
        }
    };
    // the markdown no part drew since it last looked goes (each frame; a view of its own when
    // its tree changed, keeping the rows standing in)
    match since {
        None => prose_draw(drawn).sweep(),
        Some(view::Since::Same) => {}
        Some(_) => {
            heights.borrow_mut().keep(keys.iter().map(String::as_str));
            let draw = prose_draw(drawn);
            for ((_, c), _) in rows.iter().zip(&plan).filter(|(_, h)| h.is_some()) {
                if let Some(text) = markdown_of(c) {
                    draw.keep(text);
                }
            }
            draw.sweep();
        }
    }
    let laid: Vec<bool> = plan.iter().map(Option::is_none).collect();
    if let Some(w) = &windowed {
        w.rows
            .set(w.rows.get() + laid.iter().filter(|l| **l).count() as u64);
    }
    // its parts' texts take part in its own selection, each row's numbered apart
    let kids: Vec<AnyElement> = select::drawing_in(&text, || {
        rows.iter()
            .zip(&keys)
            .zip(&plan)
            .enumerate()
            .map(|(i, (((gap, c), key), stand))| {
                let part = div().flex_none().w_full().mt(px(*gap));
                let part = match stand {
                    None => {
                        text.group(i + 1);
                        part.child(node(c, drawn, cx))
                    }
                    Some(h) => {
                        let sel = c.id().map(|id| format!("factory-node-{id}"));
                        part.h(px(*h))
                            .when_some(sel, |d, sel| d.debug_selector(move || sel))
                    }
                };
                Glided {
                    key: key.clone(),
                    glide: glide.clone(),
                    anchor: anchor.clone(),
                    scroll: scroll.clone(),
                    child: part.into_any_element(),
                }
                .into_any_element()
            })
            .collect()
    });
    text.groups(rows.len() + 1);
    cx.default_global::<ProseRoom>().0 = room;
    cx.default_global::<Finding>().0 = outer_find;
    let below: Vec<AnyElement> = below.iter().map(|c| node(c, drawn, cx)).collect();
    if jumps {
        scroll.scroll_to_bottom();
    }
    // scrolled up (no jump this frame): the scroll takes the anchor's move in the new layout,
    // before the list puts its parts on screen
    let anchored = !jumps && reveal.is_none();
    let anchoring = {
        let (scroll, anchor) = (scroll.clone(), anchor.clone());
        gpui_kit::canvas(
            move |bounds, window, _| {
                if !anchored {
                    return;
                }
                let top = bounds.top().as_f32();
                let dy = anchor
                    .borrow()
                    .shift(|id| window.layout_bounds(id).top().as_f32() - top);
                if let Some(dy) = dy {
                    let mut at = scroll.offset();
                    at.y -= px(dy);
                    scroll.set_offset(at);
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full()
    };
    // child 0 is the spacer that keeps short transcripts on the bottom edge
    if let Some(at) = reveal_at {
        scroll.scroll_to_item(at + 1);
    }
    let bar = p
        .find
        .as_ref()
        .map(|f| find_bar(id.unwrap_or_default(), f, drawn));
    let sink = drawn.sink.clone();
    let tell = id.map(str::to_owned);
    // the scroll's children: the spacer, the parts, the floor marker
    let marker = rows.len() + 1;
    let hold = p.hold;
    let watch = {
        let registry = text.registry.clone();
        let (scroll, stuck, width, floor, spacer, height, glide, anchor, heights) = (
            scroll.clone(),
            stuck.clone(),
            width.clone(),
            floor.clone(),
            spacer.clone(),
            height.clone(),
            glide.clone(),
            anchor.clone(),
            heights.clone(),
        );
        gpui_kit::canvas(
            move |bounds, window, cx| {
                let room = (bounds.size.width.as_f32() - r - l).max(0.);
                let tall = scroll.bounds().size.height.as_f32();
                let rewidth = (width.get() - room).abs() > 0.5;
                let resized = rewidth || (height.get() - tall).abs() > 0.5;
                height.set(tall);
                if rewidth {
                    width.set(room);
                    // (a refresh while drawing is dropped: the prose lays out again next frame)
                    window.defer(cx, |window, _| window.refresh());
                }
                {
                    let mut g = glide.borrow_mut();
                    g.end(scroll.offset().y.as_f32());
                    if rewidth {
                        g.relaid();
                    }
                    if g.moving() {
                        window.request_animation_frame();
                    }
                }
                let max = scroll.max_offset().y.as_f32();
                let at = -scroll.offset().y.as_f32();
                let now = max - at < 2.;
                {
                    // the parts' places and the view's edges, unscrolled, under the transcript's top
                    let origin = bounds.top().as_f32();
                    let view = scroll.bounds();
                    // a part with no id is named by its index, another part's once one above
                    // goes: never an anchor
                    let places = keys
                        .iter()
                        .zip(&named)
                        .enumerate()
                        .filter_map(|(i, (k, n))| {
                            let b = scroll.bounds_for_item(i + 1).filter(|_| *n)?;
                            Some((k.as_str(), b.top().as_f32() - origin))
                        });
                    let top = view.top().as_f32() - origin + at;
                    anchor
                        .borrow_mut()
                        .end(places, top, top + view.size.height.as_f32());
                }
                // the rows drawn, measured: away from the view they stand in at these heights
                {
                    let mut h = heights.borrow_mut();
                    for (i, k) in keys.iter().enumerate().filter(|(i, _)| laid[*i]) {
                        if let Some(b) = scroll.bounds_for_item(i + 1) {
                            h.measured(k, b.size.height.as_f32());
                        }
                    }
                }
                // where the parts end under the list's top (the marker's `top` is from there too)
                let parts = (1..marker)
                    .filter_map(|i| scroll.bounds_for_item(i))
                    .map(|b| b.bottom().as_f32())
                    .fold(f32::MIN, f32::max)
                    - scroll.bounds().top().as_f32();
                // held, the floor only goes down with the parts (scrolled up it stays, so going
                // back up is no jump); else it is where they end; laid out anew, none
                floor.set(if resized {
                    0.
                } else if hold {
                    if now {
                        floor.get().max(parts)
                    } else {
                        floor.get()
                    }
                } else {
                    parts.max(0.)
                });
                spacer.set(
                    scroll
                        .bounds_for_item(0)
                        .map_or(f32::MAX, |b| b.size.height.as_f32()),
                );
                if now != stuck.get() {
                    stuck.set(now);
                    if let (Some(id), Some(sink)) = (tell.clone(), sink.clone()) {
                        let click = format!("{id}:{}", if now { "bottom" } else { "up" });
                        cx.defer(move |cx| sink.send(UserInput::Click { id: click }, cx));
                    }
                }
                // find's current match outside the view: its line a third down it, drawn next
                // frame (as a wheel would move it: no longer stuck to the bottom)
                let place = seek
                    .as_ref()
                    .and_then(|m| m.current.get())
                    .and_then(|(key, byte)| {
                        let at = registry
                            .borrow()
                            .get(&key)?
                            .layout
                            .position_for_index(byte)?;
                        Some(at.y.as_f32())
                    });
                let view = scroll.bounds();
                let (top, tall) = (view.top().as_f32(), view.size.height.as_f32());
                match (place, seek_item) {
                    (Some(y), _) if y < top || y + MATCH_LINE > top + tall => {
                        let mut at = scroll.offset();
                        at.y = px((at.y.as_f32() - (y - top - tall / 3.))
                            .clamp(-scroll.max_offset().y.as_f32(), 0.));
                        scroll.set_offset(at);
                        window.defer(cx, |window, _| window.refresh());
                    }
                    // a step row's (its words are not laid out as text): the row
                    (None, Some(ix)) => {
                        scroll.scroll_to_item(ix + 1);
                        window.defer(cx, |window, _| window.refresh());
                    }
                    _ => {}
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full()
    };
    let list = div()
        .id(SharedString::from(format!("{sel}-scroll")))
        .flex_1()
        .min_h_0()
        .w_full()
        .flex()
        .flex_col()
        .pt(px(t))
        .pr(px(r))
        .pb(px(b))
        .pl(px(l))
        .overflow_y_scroll()
        .track_scroll(&scroll)
        // the mouse selects text in it as in any text view; the parts still take their clicks
        .capture_any_mouse_down({
            let text = text.clone();
            move |ev, window, cx| {
                if ev.button == MouseButton::Left {
                    let at = (ev.position, ev.click_count, ev.modifiers.shift);
                    select::press(&text, at, false, window, cx);
                    window.refresh();
                }
            }
        })
        .on_mouse_move({
            let text = text.clone();
            move |ev, window, cx| {
                if select::drag(&text, ev.position, ev.pressed_button, window, cx) {
                    window.refresh();
                }
            }
        })
        .child(div().flex_1().when(hold, |d| d.max_h(px(spacer.get()))))
        .children(kids)
        .child(
            // held, at the floor; never above the parts' first, where it would make the scroll
            // taller
            div()
                .absolute()
                .top(px(if hold { floor.get().max(t) } else { t }))
                .left_0()
                .w(px(1.))
                .h(px(0.)),
        );
    let d = div()
        .debug_selector(move || sel)
        .relative()
        .size_full()
        .min_h_0()
        .flex()
        .flex_col()
        // first: prepainted before the list, it moves the scroll it puts the parts on screen with
        .child(anchoring)
        // the Abe chat's: Abe's face, 128 px at 12 %, centred under the parts
        .when(p.mark.as_deref() == Some("abe"), |d| {
            d.child(
                div()
                    .debug_selector(|| "factory-transcript-mark".into())
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(crate::kit::Head {
                        size: 128.,
                        opacity: 0.12,
                    }),
            )
        })
        .children(bar)
        .child(list)
        .child(select::settled(&text))
        .children(
            below
                .into_iter()
                .map(|k| div().flex_none().px(px(l)).pb(px(b)).child(k)),
        )
        // last: prepainted after the list, it reads the offset the list ends this frame with
        .child(watch);
    clickable(d, id, drawn).into_any_element()
}

/// The scroll's children with the gap above each: a part 16 px under the one before, a Turn's
/// parts in its place one by one, as [`turn`] spaces them.
fn scrolled<'a>(parts: &[&'a Node], drawn: &mut Drawn) -> Vec<(f32, &'a Node)> {
    for c in parts {
        if matches!(c, Node::ChatPart { part, .. } if matches!(**part, Part::Turn)) {
            drawn.add("Turn", c.id().unwrap_or_default());
        }
    }
    rows_of(parts)
}

/// [`scrolled`]'s rows.
fn rows_of<'a>(parts: &[&'a Node]) -> Vec<(f32, &'a Node)> {
    let mut out = Vec::new();
    for c in parts {
        match c {
            Node::ChatPart { part, .. } if matches!(**part, Part::Turn) => {
                let kids = c.children();
                for (i, (gap, k)) in turn_gaps(kids).zip(kids).enumerate() {
                    out.push((if i == 0 { TURN_GAP } else { gap }, k));
                }
            }
            _ => out.push((TURN_GAP, *c)),
        }
    }
    out
}

/// A row's key: its id, else its place.
fn row_key(i: usize, c: &Node) -> String {
    c.id().map_or_else(|| format!("#{i}"), str::to_owned)
}

/// The markdown a row lays out (a message's, the agent's prose).
fn markdown_of(n: &Node) -> Option<&str> {
    match n {
        Node::ChatPart { part, .. } => match &**part {
            Part::ChatMessage(m) => Some(&m.text),
            Part::Prose(p) => Some(&p.markdown),
            _ => None,
        },
        _ => None,
    }
}

/// How tall row `c` is reckoned before it was ever drawn at `width` px: its words wrapped at
/// an average letter's width (a step row, a card: a line or two).
fn estimate(c: &Node, width: f32) -> f32 {
    const LINE: f32 = 20.;
    const LETTER: f32 = 7.;
    let Some(text) = markdown_of(c) else {
        return 2. * LINE;
    };
    let per_line = (width / LETTER).max(1.);
    let lines: f32 = text
        .lines()
        .map(|l| (l.chars().count() as f32 / per_line).ceil().max(1.))
        .sum();
    lines * LINE + LINE
}

/// The gap above each of a turn's parts: 8 px, step rows abutting, none above the first.
fn turn_gaps(children: &[Node]) -> impl Iterator<Item = f32> + '_ {
    let step =
        |c: &Node| matches!(c, Node::ChatPart { part, .. } if matches!(**part, Part::StepRow(_)));
    children.iter().enumerate().map(move |(i, c)| {
        if i == 0 || (step(c) && children.get(i - 1).is_some_and(step)) {
            0.
        } else {
            PART_GAP
        }
    })
}

/// `n` is the part `id` or holds it.
fn contains(n: &Node, id: &str) -> bool {
    n.id() == Some(id) || n.children().iter().any(|c| contains(c, id))
}

fn turn(id: Option<&str>, children: &[Node], drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    drawn.add("Turn", id.unwrap_or_default());
    let mut col = div().flex_none().w_full().flex().flex_col();
    for (gap, c) in turn_gaps(children).zip(children) {
        col = col.child(
            div()
                .flex_none()
                .w_full()
                .mt(px(gap))
                .child(node(c, drawn, cx)),
        );
    }
    clickable(col, id, drawn).into_any_element()
}

/// A ChatMessage's own padding each side: its markdown lays out in the room less these.
const MESSAGE_PAD_X: f32 = 10.;

fn chat_message(
    id: Option<&str>,
    p: &ChatMessageProps,
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("ChatMessage", p.text.clone());
    let sel = selector("ChatMessage", ix, id);
    // markdown as the agent's prose is (a launch prompt's headings and bold drawn, not raw)
    let text = ProseEl {
        draw: prose_draw(drawn),
        markdown: p.text.clone(),
        key: format!(
            "msg\u{0}{}",
            id.map_or_else(|| ix.to_string(), str::to_owned)
        ),
        room: (cx.default_global::<ProseRoom>().0 - 2. * MESSAGE_PAD_X).max(0.),
        select: select::drawing().map(|t| t.selectable()),
        marks: part_marks(id, cx),
    };
    let group = SharedString::from(format!("{sel}-group"));
    let copy = copy_button(
        &format!("msg-{}", id.map_or_else(|| ix.to_string(), str::to_owned)),
        p.text.clone(),
        group.clone(),
    );
    let d = div()
        .debug_selector(move || sel)
        .relative()
        .group(group)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(2.))
        .px(px(MESSAGE_PAD_X))
        .py(px(8.))
        .rounded(px(MESSAGE_ARC))
        .bg(look::HOVER_BG)
        .text_size(px(look::UI_FONT_SIZE))
        .line_height(px(18.))
        .text_color(look::TEXT)
        .when_some(p.context.clone(), |d, c| {
            drawn.add("MessageContext", c.clone());
            d.child(
                div()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .line_height(px(16.))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(c)),
            )
        })
        .child(div().min_w_0().child(text))
        .child(copy);
    clickable(d, id, drawn).cursor_text().into_any_element()
}

/// A quiet text button: its label, hover wash; a click names its id.
pub(super) fn text_button(a: &PartAction, fg: Rgba, drawn: &Drawn) -> AnyElement {
    let id = a.id.clone();
    let b = div()
        .id(SharedString::from(format!("factory-node-{id}")))
        .debug_selector(move || format!("factory-node-{id}"))
        .flex_none()
        .h(px(TEXT_BUTTON_H))
        .px(px(6.))
        .flex()
        .items_center()
        .rounded(px(4.))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(fg)
        .hover(|s| s.bg(look::TOOLBAR_BUTTON_HOVER_BG))
        .when_some(a.tooltip.clone(), |d, t| {
            d.tooltip(crate::kit::tooltip(t, None))
        })
        .child(SharedString::from(a.label.clone()));
    clickable(b, Some(&a.id), drawn).into_any_element()
}

fn changes_bar(id: Option<&str>, p: &ChangesBarProps, drawn: &mut Drawn) -> AnyElement {
    let files = p.label.clone().unwrap_or_else(|| {
        format!(
            "{} file{} changed",
            p.files,
            if p.files == 1 { "" } else { "s" }
        )
    });
    let mut words = files.clone();
    if let Some(a) = p.added {
        words.push_str(&format!(" · +{a}"));
    }
    if let Some(r) = p.removed {
        words.push_str(&format!(" −{r}"));
    }
    if let Some(w) = &p.place {
        words.push_str(&format!(" · {w}"));
    }
    if p.kept {
        words.push_str(" · kept");
    }
    let ix = drawn.add("ChangesBar", words.clone());
    if p.selected {
        drawn.add("Selection", words);
    }
    let fg = if p.kept { look::TEXT_DIM } else { look::TEXT };
    let sel = selector("ChangesBar", ix, id);
    let has_counts = p.added.is_some() || p.removed.is_some();
    let sum = div()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(4.))
        .overflow_hidden()
        .whitespace_nowrap()
        .child(small(files, fg.rgba()))
        .when(has_counts, |d| {
            d.child(small("·", fg.rgba()))
                .children(counts(p.added, p.removed, p.kept))
        })
        .when_some(p.place.clone(), |d, w| {
            d.child(small("·", fg.rgba())).child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(w)),
            )
        })
        .when(p.kept, |d| d.child(small("· kept", look::TEXT_DIM.rgba())));
    let mut acts = div().ml_auto().flex_none().flex().items_center();
    for a in &p.actions {
        drawn.add("ChangesAction", a.label.clone());
        acts = acts.child(text_button(a, fg.rgba(), drawn));
    }
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(STEP_H))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(4.))
        .when(p.selected, |d| d.bg(selection_bg(drawn)))
        .child(sum)
        .child(acts);
    clickable(d, id, drawn).into_any_element()
}

fn mark_of(m: StepMark) -> (&'static str, Rgba) {
    match m {
        StepMark::Good => ("✓", look::ABE_GOOD.rgba()),
        StepMark::Bad => ("✗", look::ABE_BAD.rgba()),
        StepMark::Live => ("●", look::ABE_WARN.rgba()),
    }
}

fn step_row(
    id: Option<&str>,
    p: &StepRowProps,
    drawn: &mut Drawn,
    text: Option<&TextSel>,
    marks: Option<PartMarks>,
) -> AnyElement {
    let (glyph, color) = mark_of(p.mark);
    // find's matches in its verb, object and result, in that order
    let marks = marks.as_ref();
    let mut words = format!("{glyph} {}", p.verb);
    if let Some(o) = &p.object {
        words.push_str(&format!(" {o}"));
    }
    if let Some(r) = &p.result {
        words.push_str(&format!(" · {r}"));
    }
    if p.mark == StepMark::Live {
        words.push_str(" …");
    }
    if let Some(t) = &p.time {
        words.push_str(&format!(" {t}"));
    }
    let ix = drawn.add("StepRow", words.clone());
    let sel = selector("StepRow", ix, id);
    let bg = if p.selected {
        drawn.add("Selection", words);
        Some(selection_bg(drawn))
    } else if p.unfolded {
        Some(look::HOVER_BG.rgba())
    } else {
        None
    };
    let verb = marked(p.verb.clone(), marks);
    let object = p.object.clone().map(|o| {
        let d = div()
            .min_w_0()
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap();
        match p.object_kind {
            ObjectKind::Path => d.text_color(look::ABE_PATH),
            ObjectKind::Command => d
                .font(gpui_kit::font(EDITOR_FONT))
                .font_features(crate::render::editor_features())
                .text_size(px(MONO_SIZE)),
            ObjectKind::Text => d,
        }
        .child(marked(o, marks))
    });
    let row = div()
        .id(SharedString::from(format!("{sel}-row")))
        .flex_none()
        .w_full()
        .h(px(STEP_H))
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(4.))
        .rounded(px(4.))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .when_some(bg, |d, bg| d.bg(bg))
        .when(bg.is_none(), |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .child(
            div()
                .flex_none()
                .w(px(MARK_W))
                .flex()
                .justify_center()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(color)
                .child(glyph),
        )
        .child(div().flex_none().child(verb))
        .children(object)
        .when_some(p.result.clone(), |d, r| {
            d.child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .flex()
                    .child("· ")
                    .child(marked(r, marks)),
            )
        })
        .when(p.mark == StepMark::Live, |d| {
            d.child(div().flex_none().child("…"))
        })
        .when_some(p.time.clone(), |d, t| {
            d.child(small(t, look::TEXT_DISABLED.rgba()).ml_auto())
        });
    let out = (p.unfolded && !p.output.is_empty()).then(|| {
        for l in &p.output {
            drawn.add("StepOutput", l.clone());
        }
        div()
            .flex_none()
            .mt(px(2.))
            .ml(px(24.))
            .py(px(2.))
            .pl(px(10.))
            .border_l_1()
            .border_color(look::SEPARATOR)
            .overflow_hidden()
            .font(gpui_kit::font(EDITOR_FONT))
            .font_features(crate::render::editor_features())
            .text_size(px(MONO_SIZE))
            .line_height(px(MONO_LINE))
            .text_color(look::TEXT_DIM)
            .children({
                // its lines take part in the transcript's selection, a row each
                let at = text.map(|t| (t.part(), t.ordered()));
                p.output.iter().enumerate().map(move |(i, l)| {
                    let line = div().h(px(MONO_LINE)).whitespace_nowrap().overflow_hidden();
                    match (text, at) {
                        (Some(t), Some((base, sel))) => {
                            t.rows.borrow_mut().insert(
                                base + i,
                                vec![Display {
                                    text: l.clone(),
                                    spans: Vec::new(),
                                }],
                            );
                            line.child(markdown::selectable_text(
                                l.clone(),
                                (base + i, 0),
                                sel,
                                &t.registry,
                            ))
                        }
                        _ => line.child(SharedString::from(l.clone())),
                    }
                })
            })
    });
    // its output is text to select: a press there folds nothing
    let out = out.map(|o| own_clicks(o.cursor_text(), drawn));
    // output past its first lines: `show N more`, a click shows the rest
    let more = p.more.as_ref().filter(|_| p.unfolded).map(|m| {
        let words = format!("show {} more", m.count);
        drawn.add("StepMore", words.clone());
        if m.selected {
            drawn.add("Selection", words.clone());
        }
        let more_sel = format!("{sel}-more");
        let row = div()
            .id(SharedString::from(more_sel.clone()))
            .debug_selector(move || more_sel)
            .flex_none()
            .ml(px(24.))
            .pl(px(10.))
            .h(px(MONO_LINE))
            .flex()
            .items_center()
            .rounded(px(4.))
            .when(m.selected, |d| d.bg(selection_bg(drawn)))
            .hover(|s| s.bg(look::HOVER_BG))
            .child(small(words, look::TEXT_DIM.rgba()));
        clickable(row, m.id.as_deref(), drawn)
    });
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .child(row)
        .children(out);
    let d = clickable(d, id, drawn).into_any_element();
    match more {
        None => d,
        Some(more) => div()
            .flex_none()
            .w_full()
            .flex()
            .flex_col()
            .child(d)
            .child(more)
            .into_any_element(),
    }
}

fn steps_folded(id: Option<&str>, p: &StepsFoldProps, drawn: &mut Drawn) -> AnyElement {
    let words = format!("{} step{}", p.count, if p.count == 1 { "" } else { "s" });
    let ix = drawn.add("StepsFold", words.clone());
    if p.selected {
        drawn.add("Selection", words.clone());
    }
    let sel = selector("StepsFold", ix, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(STEP_H))
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(4.))
        .rounded(px(4.))
        .when(p.selected, |d| d.bg(selection_bg(drawn)))
        .hover(|s| s.bg(look::HOVER_BG))
        .tooltip(crate::kit::tooltip("Show the steps", Some("⏎")))
        .child(Icon::new(IconName::ChevronRight).size(px(MARK_W)))
        .child(small(words, look::TEXT_DIM.rgba()));
    clickable(d, id, drawn).into_any_element()
}

/// The markdown the prose parts parsed and laid out, kept across frames (the drawing view's
/// memory); its fenced code wraps in the narrow column.
struct ProseDraw(Rc<CardDraw>);

impl Default for ProseDraw {
    fn default() -> Self {
        ProseDraw(Rc::new(CardDraw::wrapping_code()))
    }
}

/// The drawing view's prose markdown.
fn prose_draw(drawn: &Drawn) -> Rc<CardDraw> {
    drawn
        .memory
        .kept::<ProseDraw>("", "prose")
        .borrow()
        .0
        .clone()
}

/// The prose's words kept for the tests' and the drive socket's reading (a release build's
/// frames never copy each prose's markdown).
const RECORD_PROSE: bool = cfg!(any(debug_assertions, feature = "shots"));

/// The agent's markdown in the card dialog's look ([`story`], AbeDetail): drawn when the
/// window lays it out, which the markdown rows measure against.
struct ProseEl {
    draw: Rc<CardDraw>,
    markdown: String,
    key: String,
    room: f32,
    /// The transcript's selection its texts take part in.
    select: Option<Selectable>,
    /// Find's matches in it.
    marks: Option<PartMarks>,
}

// what `#[derive(IntoElement)]` writes (its expansion names the `gpui` crate)
impl IntoElement for ProseEl {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for ProseEl {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        let draw = self.draw;
        let on_link: OnLink =
            Rc::new(|url: String, _: &mut Window, cx: &mut App| cx.open_url(&url));
        let mut fetch = Vec::new();
        let marks = self.marks.map(|m| move |t: &str, key| m.marks(t, key));
        story(
            &[StoryPart::Markdown(self.markdown)],
            ("factory-prose", &self.key),
            &draw,
            self.room,
            window,
            &on_link,
            &mut fetch,
            self.select.as_ref(),
            marks.as_ref().map(|m| m as markdown::Marks),
        )
    }
}

fn prose(id: Option<&str>, p: &ProseProps, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    let ix = drawn.add(
        "Prose",
        if RECORD_PROSE {
            p.markdown.clone()
        } else {
            String::new()
        },
    );
    let sel = selector("Prose", ix, id);
    let key = id.map_or_else(|| ix.to_string(), str::to_owned);
    let group = SharedString::from(format!("{sel}-group"));
    let d = div()
        .debug_selector(move || sel.clone())
        .relative()
        .group(group.clone())
        .flex_none()
        .w_full()
        .min_w_0()
        .child(ProseEl {
            draw: prose_draw(drawn),
            markdown: p.markdown.clone(),
            key: key.clone(),
            room: cx.default_global::<ProseRoom>().0,
            select: select::drawing().map(|t| t.selectable()),
            marks: part_marks(id, cx),
        })
        .child(copy_button(&key, p.markdown.clone(), group));
    // text under the mouse: it selects
    clickable(d, id, drawn).cursor_text().into_any_element()
}

fn stage_divider(id: Option<&str>, p: &StageDividerProps, drawn: &mut Drawn) -> AnyElement {
    // no `to`: a mark of its own, `Reopened 09:14`
    let words = if p.to.is_empty() {
        format!("{} {}", p.from, p.at)
    } else {
        format!("{} → {} · {}", p.from, p.to, p.at)
    };
    let ix = drawn.add("StageDivider", words.clone());
    let sel = selector("StageDivider", ix, id);
    let rule = || div().flex_1().h(px(1.)).bg(look::SEPARATOR);
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(16.))
        .flex()
        .items_center()
        .gap(px(8.))
        .child(rule())
        .child(small(words, look::TEXT_DIM.rgba()))
        .child(rule());
    clickable(d, id, drawn).into_any_element()
}

fn new_below(id: Option<&str>, p: &NewBelowProps, drawn: &mut Drawn) -> AnyElement {
    let words = format!("↓ {} new", p.count);
    let ix = drawn.add("NewBelow", words.clone());
    if p.selected {
        drawn.add("Selection", words.clone());
    }
    let sel = selector("NewBelow", ix, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(STEP_H))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .when(p.selected, |d| d.bg(selection_bg(drawn)))
        .hover(|s| s.bg(look::HOVER_BG))
        .tooltip(crate::kit::tooltip("Jump down", Some("⏎")))
        .child(small(words, look::TEXT_DIM.rgba()));
    clickable(d, id, drawn).into_any_element()
}

fn queued(id: Option<&str>, p: &QueuedMessageProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("QueuedMessage", p.text.clone());
    let sel = selector("QueuedMessage", ix, id);
    let remove = p.remove.clone().map(|r| {
        let rid = r.clone();
        let b = div()
            .id(SharedString::from(format!("factory-node-{r}")))
            .debug_selector(move || format!("factory-node-{rid}"))
            .flex_none()
            .size(px(22.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .hover(|s| s.bg(look::HOVER_BG))
            .tooltip(crate::kit::tooltip("Remove", None))
            .child(Icon::new(IconName::CloseSmall));
        clickable(b, Some(&r), drawn)
    });
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(STEP_H))
        .flex()
        .items_center()
        .gap(px(8.))
        .pl(px(10.))
        .pr(px(2.))
        .rounded(px(4.))
        .hover(|s| s.bg(look::HOVER_BG))
        .tooltip(crate::kit::tooltip("Sent when the turn ends", None))
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(SharedString::from(p.text.clone())),
        )
        .children(remove);
    clickable(d, id, drawn).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_marks_what_find_ts_counts_ignoring_case_none_overlapping() {
        let at = |t: &str, n: &str| found_in(t, &n.chars().collect::<Vec<_>>());
        assert_eq!(at("The Cart and the cart", "cart"), vec![4..8, 17..21]);
        assert_eq!(at("aaaa", "aa"), vec![0..2, 2..4]);
        // byte ranges past characters wider than one byte
        assert_eq!(at("Åtgärd: ÄNDRA", "ändra"), vec![10..16]);
        assert!(at("cart", "").is_empty());
        assert!(at("ca", "cart").is_empty());
    }
}
