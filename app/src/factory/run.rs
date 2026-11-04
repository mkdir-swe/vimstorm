//! The Run place's components (`abe/packages/ui/src/run/run-components.ts`; design C, the run on
//! the left), drawn in the main slot: the bar (`Run #2 · demo-shop · Bug run`, `#2` the card,
//! Linked ▾, expand), the steps (the run in time order, a quiet row per step run: its mark, its
//! name, a muted outcome under it, `↩` on one that sent the run back), the focus pane (the step the
//! keys are on: its name, skill and time, its state badges, its state block (the question it waits
//! on, what it is at now, where it sent the run back, what it was sent back with), what it did,
//! its actions, then two columns: what it read on the left in an island, what it made on the
//! right, stacked when the pane is narrow; each column's blocks hold its parts (the card, words,
//! lists, questions and answers, facts, commits, checks, review findings, lanes of tickets and
//! writers with milestones between, the pull request's ladder, a document, the verify kit (each
//! feature's verdict and env, screenshots at the column's width, Before over After, each opening
//! full size, with its page and account under it, a recording whose GIF plays in place, else its
//! control opens the file in the local player, how it was judged, not driven, a transcript), a
//! report's proof, criteria, files, decisions, numbered steps); then its details folded:
//! commands, scratch files and skills) and the spec's reader pane. Props in, pixels out: a click
//! names `run:card`, `run:linked`, `run:expand`, a row's `run:step:<id>`, Open in Chat
//! `run:chat:<id>`, a file's, a ticket's, a detail's fold, a scratch path's, a kit recording's,
//! shot's and page's, and
//! an action's own id, a criterion's `run:proof:<n>`, `run:spec:page`. The steps keep their
//! scroll per view and bring the selected row into view; the focus pane goes back to its top when
//! its step changes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, App, Bounds, FontWeight, HighlightStyle, Hsla, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, canvas, div, fill, font, img,
    point, prelude::FluentBuilder as _, px, size,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, hue, selector};
use super::protocol::{Hue, Node};
use super::select;
use super::transcript::selection_bg;
use crate::editor::markdown::image_size;
use crate::kit::TextButton;
use crate::look;
use crate::render::EDITOR_FONT;

/// The kinds of the set (`RUN_KINDS`).
pub const KINDS: &[&str] = &["RunBar", "RunSteps", "RunFocus", "RunSpecPane"];

const BAR_H: f32 = 34.;
const PAD_X: f32 = 16.;
const CAPTION_SIZE: f32 = 11.;
/// A step row's mark column, and its outcome's size under its name.
const GLYPH_W: f32 = 16.;
const OUTCOME_SIZE: f32 = 11.5;
/// The focus pane's step name, and its lead words (what it did).
const NAME_SIZE: f32 = 17.;
const LEAD_SIZE: f32 = 15.;
/// The focus pane's sides.
const FOCUS_PAD_X: f32 = 18.;
/// A detail's fold mark column: its content starts past it.
const FOLD_W: f32 = 10.;
/// A decision's left column: what it chose, over what.
const CHOSE_W: f32 = 200.;
/// A label column (a fact's, a lane card row's) sized to its longest label in dim caps, between
/// these; a longer one wraps.
const CAPS_CHAR_W: f32 = 8.5;
const LABEL_LEAST: f32 = 48.;
const LABEL_MOST: f32 = 132.;
/// The two columns side by side down to a pane this wide, else READ over MADE; they share the
/// width 5 to 7, a gap between.
const COLUMNS_FROM: f32 = 760.;
const COLUMNS_GAP: f32 = 24.;
const READ_SHARE: f32 = 5.;
const MADE_SHARE: f32 = 7.;
/// A lane's label column, and the least width of a card on it.
const LANE_LABEL_W: f32 = 92.;
const LANE_GAP: f32 = 12.;
const LANE_CARD_W: f32 = 240.;
/// A rung's least width on the pull request's ladder: six side by side in MADE at 1440.
const RUNG_W: f32 = 96.;
/// A recording's frame in the verify kit with no still, and a shot's while its image can't be
/// read (its alt words in it); one that can is drawn at the column's width, its own shape.
const SHOT_H: f32 = 200.;
/// A transcript's lines shown before the rest is left to its file.
const TRANSCRIPT_ROWS: usize = 24;

/// A mark as drawn: its glyph in its hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Mark {
    pub glyph: String,
    pub hue: Hue,
}

/// A word in its hue: a tag, an axis, a finding's state, a verdict, who takes a step.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Word {
    pub text: String,
    pub hue: Hue,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BarProps {
    /// `#2`; empty: no card.
    pub card: String,
    /// The card's title: `#2`'s tooltip.
    pub title: String,
    /// The keys are on `#2`.
    pub on: bool,
    pub context: String,
    pub linked: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRow {
    pub id: String,
    /// Its glyph empty for one not reached.
    pub mark: Mark,
    pub name: String,
    pub outcome: String,
    /// It sent the run back: `↩` after its outcome.
    pub back: bool,
    pub dim: bool,
    /// Not reached yet: nothing to open.
    pub todo: bool,
    pub needs_you: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StepsProps {
    pub rows: Vec<StepRow>,
    pub selected: Option<String>,
    pub empty: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Criterion {
    pub n: u32,
    pub mark: Mark,
    pub text: String,
    pub proof: bool,
}

/// A file it changed: its click (`run:file:<step>:<n>`) shows its diff under the files.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct File {
    pub id: String,
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub lines: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Command {
    pub mark: Mark,
    pub command: String,
    pub result: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Answer {
    pub q: String,
    pub a: String,
    pub by: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Evidence {
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Proof {
    pub n: u32,
    pub mark: Mark,
    pub text: String,
    pub how: String,
    pub evidence: Vec<Evidence>,
    pub chapter: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Recording {
    pub length: String,
    pub path: String,
    pub chapters: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Decision {
    pub chose: String,
    pub over: String,
    pub why: String,
}

/// A screenshot of the app: an Evidence file, its alt words and caption, the page and account
/// it was taken on ('' none). A click on it (`id`) opens it full size; on its URL (`url_id`), the
/// page.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: String,
    pub path: String,
    pub alt: String,
    pub caption: String,
    pub url: String,
    pub url_id: String,
    pub account: String,
}

/// One part of the verify kit (core's `verify-html.ts`), its paths absolute.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum KitPart {
    Pair {
        before: Shot,
        after: Shot,
    },
    Shot {
        shot: Shot,
    },
    /// Its GIF played in place until paused; without one, its control opens `path` in the
    /// local player.
    #[serde(rename_all = "camelCase")]
    Recording {
        id: String,
        gif: String,
        still: String,
        path: String,
        playing: bool,
        control: String,
        /// A click on it, and on `Open video`: the recording in the local player.
        video_id: String,
        open_video: bool,
        caption: String,
        url: String,
        url_id: String,
        account: String,
    },
    Judged {
        head: String,
        text: String,
    },
    NotDriven {
        head: String,
        text: String,
    },
    Transcript {
        path: String,
        caption: String,
        lines: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct KitFeature {
    pub feature: String,
    pub title: String,
    pub mark: Mark,
    pub verdict: String,
    pub file: String,
    /// Where the app ran (`local`); '' not said.
    pub env: String,
    pub parts: Vec<KitPart>,
}

/// A step's state: `✓ done` in its hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct State {
    pub text: String,
    pub hue: Hue,
}

/// What a step waiting on you asks: its question, the answers offered, where to answer.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Ask {
    pub question: String,
    pub options: Vec<String>,
    pub hint: String,
}

/// A step running now: `● Now · 4 min so far · subagent`, its agent's last words, a note.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Now {
    pub head: String,
    pub words: String,
    pub note: String,
}

/// A step that sent the run back: `↩ back to build`, then its words (`loop review → build`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Loop {
    pub head: String,
    pub words: Vec<String>,
}

/// A step that was sent back: `Sent back with · from review · round 1`, what it was given.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Carried {
    pub head: String,
    pub items: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Fact {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub primary: bool,
}

/// A text part's tone: plain words, quiet ones, or a quote in its box (a judge's call).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Plain,
    Dim,
    Quote,
}

/// A list's row: its mark, its words, a mono note under them.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ListRow {
    #[serde(default)]
    pub mark: Option<Mark>,
    pub text: String,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub note: String,
}

/// A check it ran: its mark, name, time and exit, its command; a red one's output's tail.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Check {
    pub mark: Mark,
    pub name: String,
    pub command: String,
    pub time: String,
    pub exit: String,
    pub output: Vec<String>,
    pub more: String,
    pub red: bool,
}

/// A review finding: its axis, `file:line`, what is wrong and its fix, its state.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Finding {
    pub axis: Word,
    pub loc: String,
    pub what: String,
    pub fix: String,
    #[serde(default)]
    pub state: Option<Word>,
}

/// A lane card's row, shown while it is open: `writer`, `commits`, `tests`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardRow {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub mark: Option<Mark>,
}

/// A card on a lane: a ticket (its click opens or shuts it) or a writer's (always open).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LaneCard {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub time: String,
    pub summary: String,
    pub tags: Vec<Word>,
    pub rows: Vec<CardRow>,
    pub chips: Vec<String>,
    pub open: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Milestone {
    pub label: String,
    pub text: String,
}

/// A lane: its label column (`Wave 1`, `2 writers at once`), its cards, a milestone after it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Lane {
    pub label: String,
    pub note: String,
    pub cards: Vec<LaneCard>,
    #[serde(default)]
    pub milestone: Option<Milestone>,
}

/// A rung of the pull request's way (Pushed, Opened, Checks …); the one it is on washed.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Rung {
    pub mark: Mark,
    pub label: String,
    pub note: String,
    pub on: bool,
}

/// A numbered step (a Playbook's): its title, its words in their hues, its text, a command.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PbStep {
    pub n: u32,
    pub title: String,
    pub meta: Vec<Word>,
    pub text: String,
    pub command: String,
}

/// One part of a column's block.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Piece {
    /// The card's head: `AB#4 · story · Sprint 1` in accent, its title, its words (markdown).
    Card {
        #[serde(rename = "ref")]
        reference: String,
        title: String,
        text: String,
    },
    Text {
        text: String,
        tone: Tone,
    },
    List {
        numbered: bool,
        rows: Vec<ListRow>,
    },
    Qa {
        rows: Vec<Answer>,
    },
    Facts {
        rows: Vec<Fact>,
    },
    Commits {
        rows: Vec<Commit>,
    },
    Checks {
        rows: Vec<Check>,
    },
    Findings {
        rows: Vec<Finding>,
    },
    Lanes {
        lanes: Vec<Lane>,
    },
    Ladder {
        rungs: Vec<Rung>,
    },
    /// A document on a paper: its eyebrow, title and meta, then its markdown.
    Doc {
        eyebrow: String,
        title: String,
        meta: String,
        markdown: String,
    },
    Kit {
        features: Vec<KitFeature>,
    },
    /// A report's numbered steps, then its recording's line.
    Proof {
        rows: Vec<Proof>,
        #[serde(default)]
        recording: Option<Recording>,
    },
    Criteria {
        rows: Vec<Criterion>,
    },
    Files {
        rows: Vec<File>,
    },
    Decisions {
        rows: Vec<Decision>,
    },
    Steps {
        rows: Vec<PbStep>,
    },
}

/// A column's block: unboxed, a dim caption over its parts; boxed, a panel with its title and
/// verdict on its head.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Block {
    pub title: String,
    #[serde(default)]
    pub verdict: Option<Word>,
    pub boxed: bool,
    pub parts: Vec<Piece>,
}

/// `READ` or `MADE`: a dim note after it, its blocks.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Column {
    pub note: String,
    pub blocks: Vec<Block>,
}

/// A folded detail's head: its click `id` opens or shuts it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Head {
    pub id: String,
    pub label: String,
    /// Dim on its right: `5 · 1 failed`, `3 features`.
    pub note: String,
    pub open: bool,
}

/// A scratch file: its click (`run:scratch:<step>:<n>`) opens it in the Editor.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PathRow {
    pub id: String,
    pub path: String,
}

/// A detail folded under a step's columns.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Detail {
    Commands {
        #[serde(flatten)]
        head: Head,
        rows: Vec<Command>,
    },
    Paths {
        #[serde(flatten)]
        head: Head,
        rows: Vec<PathRow>,
    },
    Skills {
        #[serde(flatten)]
        head: Head,
        names: Vec<String>,
    },
}

impl Detail {
    fn head(&self) -> &Head {
        match self {
            Detail::Commands { head, .. }
            | Detail::Paths { head, .. }
            | Detail::Skills { head, .. } => head,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FocusProps {
    pub step: String,
    pub name: String,
    /// Its one main skill (`implement`); empty for none.
    pub skill: String,
    /// After the skill: `09:18 · 3 min · subagent`.
    pub meta: String,
    pub state: State,
    /// Its subagent started with a cleared context: `⟲ fresh`.
    pub fresh: bool,
    /// `round 2 of 3`; empty for none.
    pub round: String,
    /// `sent back from checks`; empty for none.
    pub back: String,
    pub chat: bool,
    #[serde(default)]
    pub ask: Option<Ask>,
    #[serde(default)]
    pub now: Option<Now>,
    #[serde(default, rename = "loop")]
    pub sent_back: Option<Loop>,
    #[serde(default)]
    pub carried: Option<Carried>,
    pub did: String,
    /// Its Step summary is not in yet: `did` a quiet placeholder.
    pub pending: bool,
    pub actions: Vec<Action>,
    /// What it read, on the left (narrow: over `made`).
    pub read: Column,
    /// What it made, on the right (narrow: under `read`).
    pub made: Column,
    pub details: Vec<Detail>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SpecProps {
    pub head: String,
    pub title: String,
    pub meta: String,
    pub body: String,
    pub criteria: Vec<Criterion>,
    pub page: bool,
}

/// One of the set, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Bar(BarProps),
    Steps(StepsProps),
    Focus(Box<FocusProps>),
    Spec(SpecProps),
}

impl Part {
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Part, D::Error> {
        use serde::de::Error as _;
        Ok(match kind {
            "RunBar" => Part::Bar(serde::Deserialize::deserialize(props)?),
            "RunSteps" => Part::Steps(serde::Deserialize::deserialize(props)?),
            "RunFocus" => Part::Focus(serde::Deserialize::deserialize(props)?),
            "RunSpecPane" => Part::Spec(serde::Deserialize::deserialize(props)?),
            _ => {
                return Err(D::Error::custom(format!("not a run component: {kind}")));
            }
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Bar(_) => "RunBar",
            Part::Steps(_) => "RunSteps",
            Part::Focus(_) => "RunFocus",
            Part::Spec(_) => "RunSpecPane",
        }
    }
}

pub fn part(id: Option<&str>, p: &Part, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    match p {
        Part::Bar(p) => bar(id, p, drawn),
        Part::Steps(p) => steps(id, p, drawn, cx),
        Part::Focus(p) => focus(id, p, drawn, cx),
        Part::Spec(p) => spec(id, p, drawn),
    }
}

/// A dim upper-case caption (`WHAT IT DID`, `READ`).
fn caption(s: &str) -> gpui_kit::Div {
    text(s.to_uppercase())
        .text_size(px(CAPTION_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(look::TEXT_DIM)
}

/// A small mono chip on the lane wash (a skill, a scratch path).
fn chip(s: &str, color: gpui_kit::Rgba) -> gpui_kit::Div {
    mono(s.to_owned())
        .flex_none()
        .px(px(8.))
        .rounded(px(4.))
        .bg(look::ABE_LANE_BG)
        .text_color(color)
}

/// A small badge: its words in `color` on its faint wash.
fn badge(s: &str, color: gpui_kit::Rgba) -> gpui_kit::Div {
    text(s.to_owned())
        .flex_none()
        .px(px(6.))
        .rounded(px(4.))
        .text_size(px(CAPTION_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .bg(look::abe_badge_bg(color))
        .text_color(color)
}

/// Words on one line (an ellipsis where they are cut); the mouse selects them.
fn text(s: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .min_w_0()
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .child(select::text(s))
}

fn dim(s: impl Into<SharedString>) -> gpui_kit::Div {
    text(s).text_color(look::TEXT_DIM)
}

/// Words that wrap (what it did, a spec's paragraph).
fn prose(s: impl Into<SharedString>) -> gpui_kit::Div {
    div().min_w_0().child(select::text(s))
}

/// Words that wrap, quieter than the plain ones (a card's words, a summary).
fn quiet(s: impl Into<SharedString>) -> gpui_kit::Div {
    prose(s).text_color(look::TAB_TEXT_INACTIVE)
}

fn mark(m: &Mark) -> gpui_kit::Div {
    div()
        .flex_none()
        .text_color(hue(m.hue))
        .child(SharedString::from(m.glyph.clone()))
}

fn mono(s: impl Into<SharedString>) -> gpui_kit::Div {
    text(s).font(font(EDITOR_FONT))
}

/// Mono words that wrap (a note, a command, a path).
fn code(s: impl Into<SharedString>) -> gpui_kit::Div {
    prose(s).font(font(EDITOR_FONT))
}

/// A raised card on a column: the lane wash, its border, rounded.
fn card() -> gpui_kit::Div {
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .rounded(px(8.))
        .border_1()
        .border_color(look::ABE_CARD_BORDER)
        .bg(look::ABE_LANE_BG)
}

/// An island on the pane: the islands' wash, a quiet border, rounded.
fn island() -> gpui_kit::Div {
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .rounded(px(8.))
        .border_1()
        .border_color(look::SEPARATOR)
        .bg(look::PANEL_BG)
}

/// Children one under another `gap` apart, laid out as a block. A flex column measures each child
/// for its least height as well as its own (taffy, at every level), so the focus pane's nested
/// columns cost a power of their depth each frame; a block lays each child out once.
fn stack(gap: f32, children: impl IntoIterator<Item = AnyElement>) -> gpui_kit::Div {
    div()
        .min_w_0()
        .children(children.into_iter().enumerate().map(|(n, c)| {
            if n == 0 {
                c
            } else {
                div().mt(px(gap)).child(c).into_any_element()
            }
        }))
}

/// The width of a label column holding these labels in dim caps.
fn label_w<'a>(labels: impl Iterator<Item = &'a str>) -> f32 {
    let chars = labels.map(|l| l.chars().count()).max().unwrap_or(0);
    (chars as f32 * CAPS_CHAR_W + 2.).clamp(LABEL_LEAST, LABEL_MOST)
}

/// A label in dim caps that wraps, in its column `w` wide.
fn label(s: &str, w: f32) -> gpui_kit::Div {
    prose(s.to_uppercase())
        .flex_none()
        .w(px(w))
        .pt(px(1.))
        .text_size(px(CAPTION_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .text_color(look::TEXT_DIM)
}

/// A link-like word: accent, a click names `click`.
fn link(words: &str, click: &str, drawn: &Drawn) -> gpui_kit::Div {
    let sel = format!("factory-node-{click}");
    clickable(
        div()
            .debug_selector(move || sel)
            .flex_none()
            .whitespace_nowrap()
            .text_color(look::ABE_ACCENT)
            .child(SharedString::from(words.to_owned())),
        Some(click),
        drawn,
    )
}

/// A small toggle button: selected or not, its click its id.
fn toggle(label: &str, click: &str, on: bool, tip: Option<&str>, drawn: &mut Drawn) -> AnyElement {
    drawn.add(if on { "RunToggleOn" } else { "RunToggle" }, label);
    let sel = format!("factory-node-{click}");
    let (bg, border) = if drawn.focused {
        (look::TAB_SELECTED_BG, look::TAB_SELECTED_BORDER)
    } else {
        (
            look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG,
            look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER,
        )
    };
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .h(px(22.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded(px(4.))
        .border_1()
        .border_color(gpui_kit::transparent_black())
        .when(on, |d| d.bg(bg).border_color(border))
        .when(!on, |d| d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG)))
        .when_some(tip.map(str::to_owned), |d, tip| {
            d.tooltip(crate::kit::tooltip(tip, None))
        })
        .child(SharedString::from(label.to_owned()));
    clickable(d, Some(click), drawn).into_any_element()
}

/// A scroll kept across frames, and what it last showed (the steps' selected row, the focus
/// pane's step).
#[derive(Default)]
struct Kept {
    scroll: ScrollHandle,
    shown: Option<String>,
    /// A reveal asked before the scroll knew its children's places: asked again next frame.
    pending: bool,
}

/// The kept scroll of the part `id` (else `fallback`) in the view drawing it (its memory).
fn kept(id: Option<&str>, fallback: &str, drawn: &Drawn) -> std::rc::Rc<std::cell::RefCell<Kept>> {
    drawn.memory.kept::<Kept>(id.unwrap_or(fallback), "")
}

/// How far ⌃E / ⌃Y scroll the step shown.
const SCROLL_LINE: f32 = 40.;

/// A Run page key that scrolls the step shown (the focus pane; `key` in nvim notation) while the
/// page has the keys: ⌃E / ⌃Y a line, ⌃D / ⌃U half the pane, PgDn / PgUp and Space / ⇧Space the
/// pane less a line, Home / End its top and foot. The step keys (`l ö`, ↑ ↓, `gg` `G`) stay the
/// bridge's. Whether it scrolled: `key` is one and `tree` (the view's `slot`'s) shows a step.
pub(super) fn scroll_key(key: &str, memory: &super::memory::Memory, tree: &Node) -> bool {
    fn focus_id(n: &Node) -> Option<Option<&str>> {
        match n {
            Node::Run { id, part } if matches!(**part, Part::Focus(_)) => Some(id.as_deref()),
            n => n.children().iter().find_map(focus_id),
        }
    }
    let Some(id) = focus_id(tree) else {
        return false;
    };
    let Some(scroll) = memory
        .peek::<Kept>(id.unwrap_or("run-focus"), "")
        .map(|k| k.borrow().scroll.clone())
    else {
        return false;
    };
    let pane = f32::from(scroll.bounds().size.height);
    let page = (pane - SCROLL_LINE).max(SCROLL_LINE);
    let most = f32::from(scroll.max_offset().y);
    // the offset is how far the top went up: 0 at the top, -most at the foot
    let down = -f32::from(scroll.offset().y);
    let to = match key {
        "<C-e>" => down + SCROLL_LINE,
        "<C-y>" => down - SCROLL_LINE,
        "<C-d>" => down + pane / 2.,
        "<C-u>" => down - pane / 2.,
        "<PageDown>" | "<Space>" => down + page,
        "<PageUp>" | "<S-Space>" => down - page,
        "<Home>" => 0.,
        "<End>" => most,
        _ => return false,
    };
    scroll.set_offset(point(px(0.), px(-to.clamp(0., most.max(0.)))));
    true
}

// ── the bar ──────────────────────────────────────────────────────────────────────────────────

fn bar(id: Option<&str>, p: &BarProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add(
        "RunBar",
        format!("{} · {}", format!("Run {}", p.card).trim(), p.context),
    );
    let sel = selector("RunBar", ix, id);
    let card = (!p.card.is_empty()).then(|| {
        drawn.add(if p.on { "RunCardOn" } else { "RunCard" }, p.card.clone());
        let sel = "factory-node-run:card".to_owned();
        let d = div()
            .id("run-card")
            .debug_selector(move || sel)
            .flex_none()
            .px(px(4.))
            .rounded(px(4.))
            .text_color(look::ABE_ACCENT)
            .when(p.on, |d| d.bg(selection_bg(drawn)))
            .when(!p.on, |d| d.hover(|s| s.bg(look::HOVER_BG)))
            .when(!p.title.is_empty(), |d| {
                d.tooltip(crate::kit::tooltip(p.title.clone(), None))
            })
            .child(SharedString::from(p.card.clone()));
        clickable(d, Some("run:card"), drawn)
    });
    let linked = toggle(
        "Linked ▾",
        "run:linked",
        p.linked,
        Some("Linked  ⌃L · the card's story, spec, sessions, PR, pipelines, worktree, box"),
        drawn,
    );
    let expand = toggle(
        "⤢",
        "run:expand",
        false,
        Some("Expand the run  ⌥⌘⏎ · hides Chat; again or Esc restores"),
        drawn,
    );
    div()
        .debug_selector(move || sel)
        .flex_none()
        .h(px(BAR_H))
        .w_full()
        .px(px(PAD_X))
        .flex()
        .items_center()
        .gap(px(6.))
        .border_b_1()
        .border_color(look::BORDER)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::SEMIBOLD)
                .child(select::text("Run")),
        )
        .children(card)
        .when(!p.context.is_empty(), |d| {
            d.child(dim(format!("· {}", p.context)))
        })
        .child(div().flex_1())
        .child(linked)
        .child(expand)
        .into_any_element()
}

// ── the steps ────────────────────────────────────────────────────────────────────────────────

fn step_row(r: &StepRow, selected: bool, drawn: &mut Drawn) -> AnyElement {
    drawn.add(
        "RunStepRow",
        format!(
            "{} {} {}{}",
            r.mark.glyph,
            r.name,
            r.outcome,
            if r.back { " ↩" } else { "" }
        )
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" "),
    );
    if selected {
        drawn.add("RunStepSelected", r.name.clone());
    }
    let name = if r.needs_you {
        look::ABE_NEEDS_YOU.rgba()
    } else if r.dim {
        look::TEXT_DIM.rgba()
    } else {
        look::TEXT.rgba()
    };
    let quiet = if selected {
        look::TAB_TEXT_INACTIVE
    } else {
        look::TEXT_DIM
    };
    let click = format!("run:step:{}", r.id);
    let sel = format!("factory-node-{click}");
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .items_start()
        .gap(px(8.))
        .pl(px(8.))
        .pr(px(10.))
        .py(px(5.))
        .rounded(px(4.))
        .when(selected, |d| d.bg(selection_bg(drawn)))
        .when(!selected && !r.todo, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .child(mark(&r.mark).w(px(GLYPH_W)).flex().justify_center())
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    text(r.name.clone())
                        .font_weight(if r.dim {
                            FontWeight::NORMAL
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(name),
                )
                .when(!r.outcome.is_empty() || r.back, |d| {
                    d.child(
                        div()
                            .flex()
                            .min_w_0()
                            .text_size(px(OUTCOME_SIZE))
                            .text_color(quiet)
                            .child(text(r.outcome.clone()))
                            .when(r.back, |d| {
                                d.child(
                                    div()
                                        .flex_none()
                                        .text_color(look::ABE_WARN)
                                        .child(if r.outcome.is_empty() { "↩" } else { " ↩" }),
                                )
                            }),
                    )
                }),
        );
    if r.todo {
        d.into_any_element()
    } else {
        clickable(d, Some(&click), drawn).into_any_element()
    }
}

fn steps(id: Option<&str>, p: &StepsProps, drawn: &mut Drawn, _cx: &mut App) -> AnyElement {
    let ix = drawn.add("RunSteps", p.rows.len().to_string());
    let sel = selector("RunSteps", ix, id);
    let at = |r: &StepRow| p.selected.as_deref() == Some(r.id.as_str());
    let rows: Vec<AnyElement> = p.rows.iter().map(|r| step_row(r, at(r), drawn)).collect();
    if let Some(e) = &p.empty {
        drawn.add("RunEmpty", e.clone());
    }
    // the selected row brought into view when it changes (the empty notice is the first child)
    let scroll = {
        let kept = kept(id, "run-steps", drawn);
        let mut kept = kept.borrow_mut();
        if kept.shown != p.selected {
            kept.pending = true;
        }
        kept.shown = p.selected.clone();
        let scroll = kept.scroll.clone();
        if kept.pending
            && let Some(at) = p.rows.iter().position(at)
        {
            scroll.scroll_to_item(at + usize::from(p.empty.is_some()));
            kept.pending = scroll.bounds().size.height <= px(0.);
        } else {
            kept.pending = false;
        }
        scroll
    };
    let list = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(|| "run-steps".to_owned())
        .size_full()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(px(2.))
        .pl(px(10.))
        .pr(px(8.))
        .pt(px(10.))
        .pb(px(14.))
        .overflow_y_scroll()
        .track_scroll(&scroll)
        .when_some(p.empty.clone(), |d, e| {
            d.child(
                dim(e)
                    .flex_none()
                    .w_full()
                    .py(px(24.))
                    .flex()
                    .justify_center(),
            )
        })
        .children(rows);
    div()
        .debug_selector(move || sel)
        .size_full()
        .min_w_0()
        .min_h_0()
        .flex()
        .flex_col()
        .border_r_1()
        .border_color(look::BORDER)
        .child(list)
        .into_any_element()
}

// ── the focus pane ───────────────────────────────────────────────────────────────────────────

/// A block of the focus pane: its caption over what it holds.
fn captioned(head: &str, body: impl IntoElement) -> gpui_kit::Div {
    div()
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(6.))
        .min_w_0()
        .child(caption(head))
        .child(body)
}

/// The step's header: its name, its skill in accent then its time; Open in Chat on the right.
fn focus_head(p: &FocusProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add(
        "RunFocusHead",
        [p.name.as_str(), p.skill.as_str(), p.meta.as_str()]
            .iter()
            .filter(|w| !w.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" · "),
    );
    let chat = p.chat.then(|| {
        drawn.add("RunChat", p.step.clone());
        link("Open in Chat ↗", &format!("run:chat:{}", p.step), drawn)
    });
    div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .child(
            text(p.name.clone())
                .flex_none()
                .max_w(gpui_kit::relative(0.6))
                .text_size(px(NAME_SIZE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::ABE_CARD_TITLE),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(8.))
                .when(!p.skill.is_empty(), |d| {
                    // a narrow pane: cut with `…`, never under Open in Chat
                    d.child(
                        mono(p.skill.clone())
                            .flex_shrink_1()
                            .text_color(look::ABE_ACCENT),
                    )
                })
                .when(!p.skill.is_empty() && !p.meta.is_empty(), |d| {
                    d.child(dim("·").flex_none())
                })
                .when(!p.meta.is_empty(), |d| d.child(dim(p.meta.clone()))),
        )
        .children(chat)
        .into_any_element()
}

/// Under the header: its state, `⟲ fresh`, its round, who sent it back.
fn focus_sub(p: &FocusProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunState", p.state.text.clone());
    if p.fresh {
        drawn.add("RunFresh", "⟲ fresh");
    }
    if !p.round.is_empty() {
        drawn.add("RunRound", p.round.clone());
    }
    if !p.back.is_empty() {
        drawn.add("RunBack", p.back.clone());
    }
    div()
        .flex_none()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(badge(&p.state.text, hue(p.state.hue)))
        .when(p.fresh, |d| {
            d.child(badge("⟲ fresh", look::ABE_NEEDS_YOU.rgba()))
        })
        .when(!p.round.is_empty(), |d| {
            d.child(badge(&p.round, look::TAB_TEXT_INACTIVE.rgba()).bg(look::ABE_LANE_BG))
        })
        .when(!p.back.is_empty(), |d| {
            d.child(text(format!("{} ↩", p.back)).text_color(look::ABE_WARN))
        })
        .into_any_element()
}

/// The question a step waits on: its words, where to answer, the answers its agent offered.
fn ask(a: &Ask, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunAsk", a.question.clone());
    if !a.hint.is_empty() {
        drawn.add("RunAskHint", a.hint.clone());
    }
    let options: Vec<AnyElement> = a
        .options
        .iter()
        .enumerate()
        .map(|(n, o)| {
            drawn.add("RunAskOption", o.clone());
            div()
                .flex()
                .items_start()
                .gap(px(10.))
                .min_w_0()
                .px(px(8.))
                .py(px(4.))
                .rounded(px(5.))
                .bg(look::ABE_LANE_BG)
                .child(
                    mono((n + 1).to_string())
                        .flex_none()
                        .text_size(px(CAPTION_SIZE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(look::ABE_NEEDS_YOU),
                )
                .child(prose(o.clone()).flex_1())
                .into_any_element()
        })
        .collect();
    div()
        .debug_selector(|| "run-ask".to_owned())
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(8.))
        .min_w_0()
        .px(px(16.))
        .py(px(14.))
        .rounded(px(8.))
        .border_1()
        .border_color(look::ABE_NEEDS_YOU)
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(8.))
                .min_w_0()
                .text_size(px(LEAD_SIZE))
                .font_weight(FontWeight::MEDIUM)
                .child(div().flex_none().text_color(look::ABE_NEEDS_YOU).child("◆"))
                .child(prose(a.question.clone()).flex_1()),
        )
        .when(!a.hint.is_empty(), |d| {
            d.child(prose(a.hint.clone()).text_color(look::TEXT_DIM))
        })
        .when(!options.is_empty(), |d| {
            d.child(div().flex().flex_col().gap(px(4.)).children(options))
        })
        .into_any_element()
}

/// A step running now: its head in the running hue, its agent's last words, a quiet note.
fn now(n: &Now, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunNow", n.head.clone());
    div()
        .debug_selector(|| "run-now".to_owned())
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(4.))
        .min_w_0()
        .px(px(16.))
        .py(px(12.))
        .rounded(px(8.))
        .border_1()
        .border_color(look::ABE_WARN)
        .child(caption(&n.head).text_color(look::ABE_WARN))
        .when(!n.words.is_empty(), |d| {
            d.child(prose(n.words.clone()).text_size(px(look::UI_FONT_SIZE + 1.)))
        })
        .when(!n.note.is_empty(), |d| {
            d.child(
                prose(n.note.clone())
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM),
            )
        })
        .into_any_element()
}

/// Where it sent the run back: `↩ back to build` in the loop's hue, its words after it.
fn loop_line(l: &Loop, drawn: &mut Drawn) -> AnyElement {
    drawn.add(
        "RunLoop",
        std::iter::once(l.head.as_str())
            .chain(l.words.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" · "),
    );
    let words: Vec<AnyElement> = l
        .words
        .iter()
        .enumerate()
        .map(|(n, w)| {
            let w = if n == 0 { w.clone() } else { format!("· {w}") };
            text(w).flex_none().into_any_element()
        })
        .collect();
    div()
        .debug_selector(|| "run-loop".to_owned())
        .flex_none()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(8.))
        .gap_y(px(2.))
        .min_w_0()
        .text_size(px(look::UI_SMALL_FONT_SIZE + 0.5))
        .text_color(look::TAB_TEXT_INACTIVE)
        .child(
            text(l.head.clone())
                .flex_none()
                .font_weight(FontWeight::MEDIUM)
                .text_color(look::ABE_WARN),
        )
        .children(words)
        .into_any_element()
}

/// What it was sent back with, on an island: where from, then each thing carried.
fn carried(c: &Carried, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunCarried", c.head.clone());
    let items: Vec<AnyElement> = c
        .items
        .iter()
        .map(|i| {
            drawn.add("RunCarriedItem", i.clone());
            prose(i.clone()).into_any_element()
        })
        .collect();
    island()
        .debug_selector(|| "run-carried".to_owned())
        .flex_none()
        .gap(px(4.))
        .px(px(14.))
        .py(px(10.))
        .child(caption(&c.head).text_color(look::ABE_WARN))
        .children(items)
        .into_any_element()
}

fn actions(rows: &[Action], drawn: &mut Drawn) -> AnyElement {
    let buttons: Vec<TextButton> = rows
        .iter()
        .map(|a| {
            drawn.add("RunAction", a.label.clone());
            let sink = drawn.sink.clone();
            let click = a.id.clone();
            TextButton::new(SharedString::from(a.id.clone()), a.label.clone())
                .primary(a.primary)
                .on_click(move |_, window, cx| {
                    if let Some(sink) = &sink {
                        sink.click(click.clone(), window, cx);
                    }
                })
        })
        .collect();
    div()
        .flex_none()
        .flex()
        .flex_wrap()
        .gap(px(8.))
        .children(buttons)
        .into_any_element()
}

/// The two columns: READ (an island) left of MADE, 5 to 7; under a pane `COLUMNS_FROM` wide they
/// wrap, READ over MADE. A column with no blocks and no note is left out.
fn columns(p: &FocusProps, drawn: &mut Drawn) -> Option<AnyElement> {
    let shown = |c: &Column| !c.blocks.is_empty() || !c.note.is_empty();
    let read = shown(&p.read).then(|| column(&p.step, "Read", &p.read, drawn));
    let made = shown(&p.made).then(|| column(&p.step, "Made", &p.made, drawn));
    if read.is_none() && made.is_none() {
        return None;
    }
    Some(
        div()
            .debug_selector(|| "run-columns".to_owned())
            .flex_none()
            .flex()
            .flex_wrap()
            .items_start()
            .gap_x(px(COLUMNS_GAP))
            .gap_y(px(20.))
            .min_w_0()
            .children(read)
            .children(made)
            .into_any_element(),
    )
}

fn column(step: &str, label: &'static str, c: &Column, drawn: &mut Drawn) -> AnyElement {
    let read = label == "Read";
    drawn.add(if read { "RunRead" } else { "RunMade" }, c.note.clone());
    let share = if read { READ_SHARE } else { MADE_SHARE };
    // each column's least width side by side: the pane's less its sides and the gap, by share
    let basis = (COLUMNS_FROM - 2. * FOCUS_PAD_X - COLUMNS_GAP) * share / (READ_SHARE + MADE_SHARE);
    let blocks: Vec<AnyElement> = c.blocks.iter().map(|b| block(step, b, drawn)).collect();
    let empty = blocks.is_empty();
    let body = if read {
        stack(16., blocks)
            .p(px(16.))
            .rounded(px(8.))
            .border_1()
            .border_color(look::SEPARATOR)
            .bg(look::PANEL_BG)
    } else {
        stack(14., blocks)
    };
    let sel = format!("run-{}", label.to_lowercase());
    let head = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .min_w_0()
        .child(caption(label).flex_none())
        .when(!c.note.is_empty(), |d| {
            d.child(dim(c.note.clone()).text_size(px(look::UI_SMALL_FONT_SIZE)))
        });
    let parts = [head.into_any_element()]
        .into_iter()
        .chain((!empty).then(|| body.into_any_element()));
    stack(10., parts)
        .debug_selector(move || sel)
        .flex_grow(share)
        .flex_shrink(1.)
        .flex_basis(px(basis))
        .into_any_element()
}

/// A column's block: boxed, a panel with its title and verdict on its head; else a dim caption
/// (and its verdict) over its parts.
fn block(step: &str, b: &Block, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunBlock", b.title.clone());
    if let Some(v) = &b.verdict {
        drawn.add("RunVerdict", v.text.clone());
    }
    let parts: Vec<AnyElement> = b.parts.iter().map(|p| piece(step, p, drawn)).collect();
    let verdict = b.verdict.as_ref().map(|v| {
        text(v.text.to_uppercase())
            .flex_none()
            .text_size(px(OUTCOME_SIZE))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(hue(v.hue))
    });
    let headed = !b.title.is_empty() || verdict.is_some();
    if b.boxed {
        let head = headed.then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .min_w_0()
                .child(
                    prose(b.title.clone())
                        .flex_1()
                        .text_size(px(look::UI_FONT_SIZE + 1.))
                        .font_weight(FontWeight::SEMIBOLD),
                )
                .children(verdict)
                .into_any_element()
        });
        stack(12., head.into_iter().chain(parts))
            .px(px(16.))
            .py(px(14.))
            .rounded(px(8.))
            .border_1()
            .border_color(look::ABE_CARD_BORDER)
            .bg(look::ABE_LANE_BG)
            .into_any_element()
    } else {
        let head = headed.then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(caption(&b.title))
                .children(verdict)
                .into_any_element()
        });
        stack(6., head.into_iter().chain(parts)).into_any_element()
    }
}

fn piece(step: &str, p: &Piece, drawn: &mut Drawn) -> AnyElement {
    match p {
        Piece::Card {
            reference,
            title,
            text: words,
        } => {
            drawn.add(
                "RunCardHead",
                format!("{reference} {title}").trim().to_owned(),
            );
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(6.))
                .when(!reference.is_empty(), |d| {
                    d.child(
                        mono(reference.clone())
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(look::ABE_ACCENT),
                    )
                })
                .child(
                    prose(title.clone())
                        .text_size(px(16.))
                        .font_weight(FontWeight::SEMIBOLD),
                )
                // its words are markdown, as on the Card page
                .when(!words.is_empty(), |d| {
                    d.child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .text_color(look::TAB_TEXT_INACTIVE)
                            .children(doc_markdown(words, title)),
                    )
                })
                .into_any_element()
        }
        Piece::Text { text: words, tone } => words_part(words, *tone, drawn),
        Piece::List { numbered, rows } => list(*numbered, rows, drawn),
        Piece::Qa { rows } => qa(rows, drawn),
        Piece::Facts { rows } => facts(rows, drawn),
        Piece::Commits { rows } => commits(rows, drawn),
        Piece::Checks { rows } => checks(rows, drawn),
        Piece::Findings { rows } => findings(rows, drawn),
        Piece::Lanes { lanes: rows } => lanes(rows, drawn),
        Piece::Ladder { rungs } => ladder(rungs, drawn),
        Piece::Doc {
            eyebrow,
            title,
            meta,
            markdown: md,
        } => doc(eyebrow, title, meta, md, drawn),
        Piece::Kit { features } => {
            let features: Vec<AnyElement> = features
                .iter()
                .enumerate()
                .map(|(n, f)| kit_feature(f, n == 0, drawn))
                .collect();
            stack(16., features).into_any_element()
        }
        Piece::Proof { rows, recording } => div()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(10.))
            .children(proof(rows, recording.as_ref(), drawn))
            .into_any_element(),
        Piece::Criteria { rows } => criteria(rows, drawn).into_any_element(),
        Piece::Files { rows } => files(rows, drawn).into_any_element(),
        Piece::Decisions { rows } => decisions(rows, drawn).into_any_element(),
        Piece::Steps { rows } => pb_steps(step, rows, drawn),
    }
}

/// Words in their tone, a line each: plain, quiet, or a quote in its own box.
fn words_part(words: &str, tone: Tone, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunText", words);
    let lines: Vec<AnyElement> = words
        .lines()
        .map(|l| match tone {
            Tone::Plain => prose(l.to_owned()).into_any_element(),
            Tone::Dim | Tone::Quote => quiet(l.to_owned()).into_any_element(),
        })
        .collect();
    let d = div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.))
        .children(lines);
    match tone {
        Tone::Quote => island().px(px(14.)).py(px(12.)).child(d).into_any_element(),
        _ => d.into_any_element(),
    }
}

/// Rows of words, numbered or not, a mark before each, a dim mono note under each.
fn list(numbered: bool, rows: &[ListRow], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .enumerate()
        .map(|(n, r)| {
            drawn.add(
                "RunList",
                format!(
                    "{} {}",
                    r.mark.as_ref().map_or("", |m| m.glyph.as_str()),
                    r.text
                )
                .trim()
                .to_owned(),
            );
            div()
                .flex()
                .items_start()
                .gap(px(8.))
                .min_w_0()
                .when(numbered, |d| {
                    d.child(dim(format!("{}.", n + 1)).flex_none().min_w(px(GLYPH_W)))
                })
                .when_some(r.mark.as_ref(), |d, m| d.child(mark(m)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(1.))
                        .child(prose(r.text.clone()))
                        .when(!r.note.is_empty(), |d| {
                            d.child(
                                code(r.note.clone())
                                    .text_size(px(CAPTION_SIZE))
                                    .text_color(look::TEXT_DIM),
                            )
                        }),
                )
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(5.))
        .children(rows)
        .into_any_element()
}

/// The questions asked and answered in it: yours, and a judge's calls.
fn qa(rows: &[Answer], drawn: &mut Drawn) -> AnyElement {
    let qa: Vec<AnyElement> = rows
        .iter()
        .map(|a| {
            drawn.add("RunQa", format!("Q {} A {}", a.q, a.a));
            let letter = |l: &'static str| {
                mono(l)
                    .flex_none()
                    .w(px(12.))
                    .text_size(px(CAPTION_SIZE))
                    .text_color(look::TEXT_DIM)
            };
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .child(letter("Q"))
                        .child(quiet(a.q.clone()).flex_1()),
                )
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .child(letter("A"))
                        .child(prose(a.a.clone()).flex_1())
                        .when(!a.by.is_empty(), |d| {
                            d.child(
                                dim(a.by.clone())
                                    .flex_none()
                                    .text_size(px(look::UI_SMALL_FONT_SIZE)),
                            )
                        }),
                )
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(qa)
        .into_any_element()
}

/// Label and value rows: the label in dim caps.
fn facts(rows: &[Fact], drawn: &mut Drawn) -> AnyElement {
    let w = label_w(rows.iter().map(|f| f.label.as_str()));
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|f| {
            drawn.add("RunFact", format!("{} {}", f.label, f.value));
            div()
                .flex()
                .items_start()
                .gap(px(12.))
                .min_w_0()
                .child(label(&f.label, w))
                .child(prose(f.value.clone()).flex_1())
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(4.))
        .children(rows)
        .into_any_element()
}

/// A commit a row: its short sha in accent, its subject, a dim note on the right.
fn commits(rows: &[Commit], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|c| {
            drawn.add("RunCommit", format!("{} {}", c.sha, c.subject));
            div()
                .flex()
                .items_start()
                .gap(px(8.))
                .min_w_0()
                .text_size(px(look::UI_SMALL_FONT_SIZE + 0.5))
                .child(mono(c.sha.clone()).flex_none().text_color(look::ABE_ACCENT))
                .child(prose(c.subject.clone()).flex_1())
                .when(!c.note.is_empty(), |d| {
                    d.child(
                        mono(c.note.clone())
                            .flex_none()
                            .max_w(gpui_kit::relative(0.4))
                            .text_size(px(CAPTION_SIZE))
                            .text_color(look::TEXT_DIM),
                    )
                })
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(3.))
        .children(rows)
        .into_any_element()
}

/// A tail of output in a quiet mono box, its lines kept whole (cut at the box's edge).
fn output(lines: &[String]) -> AnyElement {
    div()
        .min_w_0()
        .px(px(10.))
        .py(px(8.))
        .rounded(px(6.))
        .border_1()
        .border_color(look::SEPARATOR)
        .bg(look::EDITOR_BG)
        .child(
            lines_text(lines, 0., |_| (None, None))
                .text_size(px(OUTCOME_SIZE))
                .text_color(look::TAB_TEXT_INACTIVE),
        )
        .into_any_element()
}

/// Lines in the editor's font as one text however many there are (a diff, a log: one element to
/// lay out, not a row each), `pad` in from the sides. `tone` gives a line its wash, painted under
/// it the box's width where it shows, and its colour. They don't wrap: a long one is cut at the
/// edge.
fn lines_text(
    lines: &[String],
    pad: f32,
    tone: impl Fn(&str) -> (Option<look::Tok>, Option<look::Tok>),
) -> gpui_kit::Div {
    let mut text = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    let mut runs = Vec::new();
    let mut washes: Vec<(usize, Hsla)> = Vec::new();
    for (n, l) in lines.iter().enumerate() {
        if n > 0 {
            text.push('\n');
        }
        let (wash, color) = tone(l);
        let start = text.len();
        text.push_str(l);
        if let Some(c) = color
            && start < text.len()
        {
            let style = HighlightStyle {
                color: Some(c.into()),
                ..HighlightStyle::default()
            };
            runs.push((start..text.len(), style));
        }
        if let Some(w) = wash {
            washes.push((n, w.into()));
        }
    }
    let washes = canvas(
        |_, _, _| {},
        move |bounds, (), window, _| {
            let line = window.line_height();
            let shown = window.content_mask().bounds;
            for (n, wash) in &washes {
                let top = bounds.origin.y + line * *n as f32;
                let row = Bounds::new(point(bounds.origin.x, top), size(bounds.size.width, line));
                if row.intersects(&shown) {
                    window.paint_quad(fill(row, *wash));
                }
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    div()
        .relative()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .font(font(EDITOR_FONT))
        .child(washes)
        .child(div().px(px(pad)).child(select::styled(text, runs)))
}

/// A check a card: its mark, name, time and exit, its command under; a red one's border in its
/// hue and its output's tail.
fn checks(rows: &[Check], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|c| {
            drawn.add(
                "RunCheck",
                format!("{} {} {}", c.mark.glyph, c.name, c.exit)
                    .trim()
                    .to_owned(),
            );
            let small = |s: &str| {
                mono(s.to_owned())
                    .flex_none()
                    .text_size(px(OUTCOME_SIZE))
                    .text_color(look::TEXT_DIM)
            };
            card()
                .gap(px(3.))
                .px(px(12.))
                .py(px(8.))
                .when(c.red, |d| d.border_color(hue(c.mark.hue)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .min_w_0()
                        .child(mark(&c.mark).w(px(GLYPH_W)))
                        .child(
                            text(c.name.clone())
                                .flex_1()
                                .font_weight(FontWeight::MEDIUM),
                        )
                        .when(!c.time.is_empty(), |d| d.child(small(&c.time)))
                        .when(!c.exit.is_empty(), |d| d.child(small(&c.exit))),
                )
                .when(!c.command.is_empty(), |d| {
                    d.child(
                        code(c.command.clone())
                            .pl(px(GLYPH_W + 10.))
                            .text_size(px(OUTCOME_SIZE))
                            .text_color(look::TAB_TEXT_INACTIVE),
                    )
                })
                .when(!c.output.is_empty(), |d| {
                    d.child(div().pt(px(4.)).child(output(&c.output)))
                })
                .when(!c.more.is_empty(), |d| {
                    d.child(
                        prose(c.more.clone())
                            .text_size(px(OUTCOME_SIZE))
                            .text_color(look::TEXT_DIM),
                    )
                })
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.))
        .children(rows)
        .into_any_element()
}

/// A finding a card: its axis, `file:line`, its state on the right; what is wrong, then its fix.
fn findings(rows: &[Finding], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|f| {
            drawn.add(
                "RunFinding",
                format!("{} {} {}", f.axis.text, f.loc, f.what),
            );
            card()
                .gap(px(4.))
                .px(px(12.))
                .py(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .min_w_0()
                        .child(badge(&f.axis.text.to_uppercase(), hue(f.axis.hue)))
                        .child(
                            mono(f.loc.clone())
                                .flex_1()
                                .text_size(px(OUTCOME_SIZE))
                                .text_color(look::TEXT),
                        )
                        .when_some(f.state.as_ref(), |d, s| {
                            d.child(
                                text(s.text.clone())
                                    .flex_none()
                                    .text_size(px(OUTCOME_SIZE))
                                    .text_color(hue(s.hue)),
                            )
                        }),
                )
                .child(prose(f.what.clone()).font_weight(FontWeight::MEDIUM))
                .when(!f.fix.is_empty(), |d| {
                    d.child(quiet(format!("→ {}", f.fix)))
                })
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(rows)
        .into_any_element()
}

/// Lanes: each its label column and its cards side by side (wrapping), a milestone after it.
fn lanes(rows: &[Lane], drawn: &mut Drawn) -> AnyElement {
    let mut out: Vec<AnyElement> = Vec::new();
    for l in rows {
        drawn.add(
            "RunLane",
            format!("{} {}", l.label, l.note).trim().to_owned(),
        );
        let cards: Vec<AnyElement> = l.cards.iter().map(|c| lane_card(c, drawn)).collect();
        out.push(
            div()
                .flex()
                .items_start()
                .gap(px(LANE_GAP))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .w(px(LANE_LABEL_W))
                        .pt(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .child(prose(l.label.clone()).font_weight(FontWeight::MEDIUM))
                        .when(!l.note.is_empty(), |d| {
                            d.child(prose(l.note.clone()).text_color(look::TEXT_DIM))
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_wrap()
                        .items_start()
                        .gap(px(10.))
                        .children(cards),
                )
                .into_any_element(),
        );
        if let Some(m) = &l.milestone {
            drawn.add("RunMilestone", format!("{} {}", m.label, m.text));
            out.push(
                div()
                    .ml(px(LANE_LABEL_W + LANE_GAP))
                    .pt(px(8.))
                    .border_t_1()
                    .border_dashed()
                    .border_color(look::ABE_CARD_BORDER)
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .min_w_0()
                    .text_size(px(look::UI_SMALL_FONT_SIZE + 0.5))
                    .child(
                        text(m.label.clone())
                            .flex_none()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(look::ABE_NEEDS_YOU),
                    )
                    .child(quiet(m.text.clone()).flex_1())
                    .into_any_element(),
            );
        }
    }
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(10.))
        .children(out)
        .into_any_element()
}

/// A card on a lane: its ref, title and time, what to build, its tags; open, its rows and the
/// spec's chips. A ticket's click opens or shuts it; a writer's is always open.
fn lane_card(c: &LaneCard, drawn: &mut Drawn) -> AnyElement {
    let open = c.open || c.id.is_none();
    let kind = match (&c.id, open) {
        (Some(_), true) => "RunTicketOpen",
        (Some(_), false) => "RunTicket",
        (None, _) => "RunLaneCard",
    };
    drawn.add(
        kind,
        format!("{} {}", c.reference, c.title).trim().to_owned(),
    );
    let small = |s: &str| {
        mono(s.to_owned())
            .flex_none()
            .text_size(px(CAPTION_SIZE))
            .text_color(look::TEXT_DIM)
    };
    let tags: Vec<AnyElement> = c
        .tags
        .iter()
        .map(|t| badge(&t.text, hue(t.hue)).into_any_element())
        .collect();
    let w = label_w(c.rows.iter().map(|r| r.label.as_str()));
    let rows: Vec<AnyElement> = if open {
        c.rows
            .iter()
            .map(|r| {
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .min_w_0()
                    .child(label(&r.label, w))
                    .when_some(r.mark.as_ref(), |d, m| d.child(mark(m)))
                    .child(prose(r.value.clone()).flex_1())
                    .into_any_element()
            })
            .collect()
    } else {
        Vec::new()
    };
    let chips: Vec<AnyElement> = if open {
        c.chips
            .iter()
            .map(|s| {
                prose(s.clone())
                    .flex_none()
                    .max_w_full()
                    .px(px(7.))
                    .rounded(px(4.))
                    .border_1()
                    .border_color(look::ABE_CARD_BORDER)
                    .text_size(px(OUTCOME_SIZE))
                    .text_color(look::TAB_TEXT_INACTIVE)
                    .into_any_element()
            })
            .collect()
    } else {
        Vec::new()
    };
    let fold = c.id.is_some().then(|| {
        dim(if open { "▾" } else { "▸" })
            .flex_none()
            .w(px(FOLD_W))
            .text_size(px(CAPTION_SIZE))
    });
    let d = card()
        .flex_grow(1.)
        .flex_shrink(1.)
        .flex_basis(px(LANE_CARD_W))
        .gap(px(5.))
        .px(px(12.))
        .py(px(10.))
        .text_size(px(look::UI_SMALL_FONT_SIZE + 0.5))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .children(fold)
                .child(small(&c.reference))
                .child(div().flex_1())
                .when(!c.time.is_empty(), |d| d.child(small(&c.time))),
        )
        .child(
            prose(c.title.clone())
                .text_size(px(look::UI_FONT_SIZE))
                .font_weight(FontWeight::MEDIUM),
        )
        .when(!c.summary.is_empty(), |d| d.child(quiet(c.summary.clone())))
        .when(!tags.is_empty(), |d| {
            d.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(5.))
                    .pt(px(2.))
                    .children(tags),
            )
        })
        .when(!rows.is_empty() || !chips.is_empty(), |d| {
            d.child(
                div()
                    .mt(px(4.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(look::ABE_CARD_BORDER)
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .min_w_0()
                    .children(rows)
                    .when(!chips.is_empty(), |d| {
                        d.child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .gap(px(6.))
                                .pt(px(4.))
                                .child(caption("From the spec").flex_none())
                                .children(chips),
                        )
                    }),
            )
        });
    match &c.id {
        Some(click) => {
            let sel = format!("factory-node-{click}");
            clickable(
                d.id(SharedString::from(sel.clone()))
                    .debug_selector(move || sel)
                    .hover(|s| s.border_color(look::ABE_ACCENT)),
                Some(click),
                drawn,
            )
            .into_any_element()
        }
        None => d.into_any_element(),
    }
}

/// The pull request's way, a rung each side by side (wrapping when narrow), the one it is on
/// washed.
fn ladder(rungs: &[Rung], drawn: &mut Drawn) -> AnyElement {
    let last = rungs.len().saturating_sub(1);
    let rungs: Vec<AnyElement> = rungs
        .iter()
        .enumerate()
        .map(|(n, r)| {
            drawn.add(
                if r.on { "RunRungOn" } else { "RunRung" },
                format!("{} {}", r.mark.glyph, r.label),
            );
            let sel = format!("run-rung-{n}");
            div()
                .debug_selector(move || sel)
                .flex_grow(1.)
                .flex_shrink(1.)
                .flex_basis(px(RUNG_W))
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .px(px(10.))
                .py(px(8.))
                .when(n != last, |d| {
                    d.border_r_1().border_color(look::ABE_CARD_BORDER)
                })
                .when(r.on, |d| d.bg(look::abe_badge_bg(look::ABE_ACCENT.rgba())))
                .child(mark(&r.mark).text_size(px(CAPTION_SIZE)))
                .child(text(r.label.clone()).font_weight(FontWeight::MEDIUM))
                .when(!r.note.is_empty(), |d| {
                    d.child(
                        prose(r.note.clone())
                            .text_size(px(CAPTION_SIZE))
                            .text_color(look::TEXT_DIM),
                    )
                })
                .into_any_element()
        })
        .collect();
    card()
        .flex_row()
        .flex_wrap()
        .overflow_hidden()
        .children(rungs)
        .into_any_element()
}

/// A document on its paper: a dim mono eyebrow, its title, a dim line, then its markdown.
fn doc(eyebrow: &str, title: &str, meta: &str, md: &str, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunDoc", title);
    island()
        .gap(px(12.))
        .px(px(22.))
        .py(px(18.))
        .when(!eyebrow.is_empty(), |d| {
            d.child(
                code(eyebrow.to_owned())
                    .text_size(px(CAPTION_SIZE))
                    .text_color(look::TEXT_DIM),
            )
        })
        .when(!title.is_empty(), |d| {
            d.child(
                prose(title.to_owned())
                    .text_size(px(NAME_SIZE))
                    .font_weight(FontWeight::SEMIBOLD),
            )
        })
        .when(!meta.is_empty(), |d| {
            d.child(
                code(meta.to_owned())
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM),
            )
        })
        .children(doc_markdown(md, title))
        .into_any_element()
}

/// A document's markdown as blocks: headings (the first level bold, the rest dim caps; a first
/// heading saying the title again left out), paragraphs (their lines joined), `-` / `*` bullets
/// and numbered items (indented by their depth, a run of them close together), `>` quotes,
/// fenced code in mono; inline marks (emphasis, code, a link's address) left out ([`plain`]).
fn doc_markdown(md: &str, title: &str) -> Vec<AnyElement> {
    #[derive(Default)]
    struct Blocks {
        out: Vec<AnyElement>,
        para: Vec<String>,
        items: Vec<AnyElement>,
    }
    impl Blocks {
        /// The paragraph or the run of items being gathered, closed.
        fn close(&mut self) {
            if !self.para.is_empty() {
                self.out.push(prose(self.para.join(" ")).into_any_element());
                self.para.clear();
            }
            if !self.items.is_empty() {
                let items = std::mem::take(&mut self.items);
                self.out.push(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(5.))
                        .children(items)
                        .into_any_element(),
                );
            }
        }
        fn push(&mut self, e: AnyElement) {
            self.close();
            self.out.push(e);
        }
    }
    let mut b = Blocks::default();
    let mut fence: Option<Vec<String>> = None;
    let mut first = true;
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            match fence.take() {
                Some(lines) => b.push(output(&lines)),
                None => {
                    b.close();
                    fence = Some(Vec::new());
                }
            }
            first = false;
            continue;
        }
        if let Some(lines) = fence.as_mut() {
            lines.push(line.to_owned());
            continue;
        }
        let t = line.trim();
        if t.is_empty() {
            b.close();
            continue;
        }
        let depth = (line.len() - line.trim_start().len()) / 2;
        let item = |mark: String, words: &str| {
            div()
                .flex()
                .items_start()
                .gap(px(6.))
                .min_w_0()
                .pl(px(depth.min(4) as f32 * 14.))
                .child(dim(mark).flex_none().min_w(px(14.)))
                .child(prose(plain(words)).flex_1())
                .into_any_element()
        };
        let numbered = t
            .split_once(". ")
            .filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
        if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count();
            let words = plain(t.trim_start_matches('#').trim());
            if first && words == plain(title) {
                first = false;
                continue;
            }
            b.push(if level == 1 {
                prose(words)
                    .pt(px(4.))
                    .text_size(px(16.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .into_any_element()
            } else {
                prose(words.to_uppercase())
                    .pt(px(6.))
                    .text_size(px(CAPTION_SIZE + 0.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(look::TEXT_DIM)
                    .into_any_element()
            });
        } else if let Some(words) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            if !b.para.is_empty() {
                b.close();
            }
            b.items.push(item("•".to_owned(), words));
        } else if let Some((n, words)) = numbered {
            if !b.para.is_empty() {
                b.close();
            }
            b.items.push(item(format!("{n}."), words));
        } else if let Some(words) = t.strip_prefix('>') {
            b.push(
                prose(plain(words.trim()))
                    .pl(px(10.))
                    .border_l_2()
                    .border_color(look::ABE_CARD_BORDER)
                    .text_color(look::TAB_TEXT_INACTIVE)
                    .into_any_element(),
            );
        } else {
            if !b.items.is_empty() {
                b.close();
            }
            b.para.push(plain(t));
        }
        first = false;
    }
    if let Some(lines) = fence {
        b.push(output(&lines));
    }
    b.close();
    b.out
}

/// A line's words without their inline markdown: `*orders*`, `**bold**`, `` `code` ``,
/// `[text](url)` read as their words; a tag (`<select>`) as written.
fn plain(line: &str) -> String {
    use pulldown_cmark::{Event, Parser};
    Parser::new(line)
        .filter_map(|e| match e {
            Event::Text(t) | Event::Code(t) | Event::Html(t) | Event::InlineHtml(t) => {
                Some(t.into_string())
            }
            Event::SoftBreak | Event::HardBreak => Some(" ".to_owned()),
            _ => None,
        })
        .collect()
}

/// Numbered steps (a Playbook's): a card each, its number, title, words in their hues, its text
/// and its command.
fn pb_steps(step: &str, rows: &[PbStep], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|s| {
            drawn.add("RunPbStep", format!("{}. {}", s.n, s.title));
            let meta: Vec<AnyElement> = s
                .meta
                .iter()
                .map(|w| {
                    text(w.text.clone())
                        .flex_none()
                        .text_color(hue(w.hue))
                        .into_any_element()
                })
                .collect();
            let sel = format!("run-pbstep-{step}-{}", s.n);
            card()
                .debug_selector(move || sel)
                .flex_row()
                .gap(px(10.))
                .px(px(12.))
                .py(px(10.))
                .child(
                    mono(s.n.to_string())
                        .flex_none()
                        .w(px(22.))
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(prose(s.title.clone()).font_weight(FontWeight::MEDIUM))
                        .when(!meta.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap_x(px(10.))
                                    .text_size(px(OUTCOME_SIZE))
                                    .children(meta),
                            )
                        })
                        .when(!s.text.is_empty(), |d| d.child(quiet(s.text.clone())))
                        .when(!s.command.is_empty(), |d| {
                            d.child(
                                code(s.command.clone())
                                    .mt(px(2.))
                                    .px(px(8.))
                                    .py(px(4.))
                                    .rounded(px(4.))
                                    .bg(look::EDITOR_BG)
                                    .text_size(px(OUTCOME_SIZE))
                                    .text_color(look::EDITOR_FG),
                            )
                        }),
                )
                .into_any_element()
        })
        .collect();
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .children(rows)
        .into_any_element()
}

fn criteria(rows: &[Criterion], drawn: &mut Drawn) -> gpui_kit::Div {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|c| {
            drawn.add("RunCriterion", format!("{} {}", c.mark.glyph, c.text));
            let sel = format!("run-criterion-{}", c.n);
            // a long criterion wraps whole, its mark and proof on its first line
            div()
                .debug_selector(move || sel)
                .flex()
                .items_start()
                .gap(px(6.))
                .min_w_0()
                .child(mark(&c.mark))
                .child(prose(c.text.clone()).flex_1())
                .when(c.proof, |d| {
                    d.child(link("proof ↓", &format!("run:proof:{}", c.n), drawn))
                })
                .into_any_element()
        })
        .collect();
    div().flex().flex_col().gap(px(4.)).min_w_0().children(rows)
}

/// What it changed: a chip each, `+` / `−` its lines; a click shows its diff under them.
fn files(rows: &[File], drawn: &mut Drawn) -> gpui_kit::Div {
    let mut chips: Vec<AnyElement> = Vec::new();
    let mut opened: Vec<AnyElement> = Vec::new();
    for f in rows {
        drawn.add("RunFile", format!("{} +{} −{}", f.path, f.added, f.removed));
        let sel = format!("factory-node-{}", f.id);
        let chip = div()
            .debug_selector(move || sel)
            .flex_none()
            .max_w_full()
            .flex()
            .gap(px(4.))
            .px(px(8.))
            .rounded(px(4.))
            .bg(look::ABE_LANE_BG)
            .child(mono(f.path.clone()).text_color(look::ABE_PATH))
            .child(
                mono(format!("+{}", f.added))
                    .flex_none()
                    .text_color(look::ABE_GOOD),
            )
            .child(
                mono(format!("−{}", f.removed))
                    .flex_none()
                    .text_color(look::ABE_BAD),
            );
        chips.push(clickable(chip, Some(&f.id), drawn).into_any_element());
        if let Some(lines) = &f.lines {
            drawn.add("RunDiff", f.path.clone());
            opened.push(diff(lines));
        }
    }
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .min_w_0()
        .child(div().flex().flex_wrap().gap(px(6.)).children(chips))
        .children(opened)
}

fn commands(rows: &[Command], drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|c| {
            drawn.add(
                "RunCommand",
                format!("{} {} {}", c.mark.glyph, c.command, c.result)
                    .trim()
                    .to_owned(),
            );
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .child(mark(&c.mark))
                .child(mono(c.command.clone()).text_color(look::TAB_TEXT_INACTIVE))
                .when(!c.result.is_empty(), |d| {
                    d.child(dim(c.result.clone()).flex_none().ml(px(2.)))
                })
                .into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .gap(px(3.))
        .children(rows)
        .into_any_element()
}

/// A report's proof: each criterion's how and evidence (a screenshot drawn, an output in its
/// box), then the recording's player line.
fn proof(rows: &[Proof], recording: Option<&Recording>, drawn: &mut Drawn) -> Vec<AnyElement> {
    let mut out: Vec<AnyElement> = rows
        .iter()
        .map(|p| {
            drawn.add("RunProof", format!("{} {}. {}", p.mark.glyph, p.n, p.text));
            let evidence: Vec<AnyElement> = p
                .evidence
                .iter()
                .map(|e| {
                    drawn.add("RunEvidence", e.text.clone());
                    if e.kind == "screenshot" {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .min_w_0()
                            .child(picture(&e.text, "", false))
                            .child(
                                code(e.text.clone())
                                    .text_size(px(CAPTION_SIZE))
                                    .text_color(look::TEXT_DIM),
                            )
                            .into_any_element()
                    } else {
                        let lines: Vec<String> = e.text.lines().map(str::to_owned).collect();
                        diff(&lines)
                    }
                })
                .collect();
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(6.))
                        .min_w_0()
                        .child(mark(&p.mark))
                        .child(prose(format!("{}. {}", p.n, p.text)).flex_1())
                        .when(!p.chapter.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex_none()
                                    .text_color(look::ABE_ACCENT)
                                    .child(SharedString::from(p.chapter.clone())),
                            )
                        }),
                )
                .when(!p.how.is_empty(), |d| {
                    d.child(prose(format!("How: {}", p.how)).text_color(look::TEXT_DIM))
                })
                .children(evidence)
                .into_any_element()
        })
        .collect();
    if let Some(r) = recording {
        drawn.add("RunRecording", format!("{} {}", r.length, r.path));
        out.push(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(
                    text(r.length.clone())
                        .flex_none()
                        .text_color(look::ABE_ACCENT),
                )
                .child(dim(r.path.clone()))
                .when(!r.chapters.is_empty(), |d| {
                    d.child(dim(format!("chapters {}", r.chapters.join(" "))).flex_none())
                })
                .into_any_element(),
        );
    }
    out
}

/// A folded detail under a separator line: `▸ label … note`, its content when open.
fn detail(d: &Detail, drawn: &mut Drawn) -> AnyElement {
    let h = d.head();
    drawn.add(
        if h.open { "RunDetailOpen" } else { "RunDetail" },
        h.label.clone(),
    );
    let sel = format!("factory-node-{}", h.id);
    let head = clickable(
        div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .flex()
            .items_center()
            .gap(px(8.))
            .min_w_0()
            .py(px(7.))
            .text_color(look::TAB_TEXT_INACTIVE)
            .child(
                dim(if h.open { "▾" } else { "▸" })
                    .flex_none()
                    .w(px(FOLD_W))
                    .text_size(px(CAPTION_SIZE)),
            )
            .child(text(h.label.clone()).flex_1())
            .when(!h.note.is_empty(), |d| {
                d.child(
                    dim(h.note.clone())
                        .flex_none()
                        .text_size(px(look::UI_SMALL_FONT_SIZE)),
                )
            }),
        Some(&h.id),
        drawn,
    );
    let body = h.open.then(|| match d {
        Detail::Commands { rows, .. } => commands(rows, drawn),
        Detail::Paths { rows, .. } => {
            let chips: Vec<AnyElement> = rows
                .iter()
                .map(|r| {
                    drawn.add("RunPath", r.path.clone());
                    let sel = format!("factory-node-{}", r.id);
                    let c = chip(&r.path, look::ABE_PATH.rgba()).debug_selector(move || sel);
                    clickable(c, Some(&r.id), drawn).into_any_element()
                })
                .collect();
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .children(chips)
                .into_any_element()
        }
        Detail::Skills { names, .. } => skills(names, drawn).into_any_element(),
    });
    div()
        .flex_none()
        .flex()
        .flex_col()
        .min_w_0()
        .border_t_1()
        .border_color(look::SEPARATOR)
        .child(head)
        .when_some(body, |d, body| {
            d.child(div().pl(px(FOLD_W + 8.)).pb(px(10.)).min_w_0().child(body))
        })
        .into_any_element()
}

fn focus(id: Option<&str>, p: &FocusProps, drawn: &mut Drawn, _cx: &mut App) -> AnyElement {
    let ix = drawn.add("RunFocus", p.name.clone());
    let sel = selector("RunFocus", ix, id);
    // another step shown: back to its top
    let scroll = {
        let kept = kept(id, "run-focus", drawn);
        let mut kept = kept.borrow_mut();
        if kept.shown.as_deref() != Some(p.step.as_str()) {
            kept.scroll.set_offset(point(px(0.), px(0.)));
            kept.shown = Some(p.step.clone());
        }
        kept.scroll.clone()
    };
    let mut body: Vec<AnyElement> = vec![focus_head(p, drawn), focus_sub(p, drawn)];
    // the state block: each only when it applies
    if let Some(a) = &p.ask {
        body.push(ask(a, drawn));
    }
    if let Some(n) = &p.now {
        body.push(now(n, drawn));
    }
    if let Some(l) = &p.sent_back {
        body.push(loop_line(l, drawn));
    }
    if let Some(c) = &p.carried {
        body.push(carried(c, drawn));
    }
    if !p.did.is_empty() {
        drawn.add(
            if p.pending { "RunDidPending" } else { "RunDid" },
            p.did.clone(),
        );
        body.push(
            captioned(
                "What it did",
                prose(p.did.clone())
                    .text_size(px(LEAD_SIZE))
                    .when(p.pending, |d| d.text_color(look::TEXT_DIM)),
            )
            .debug_selector(|| "run-did".to_owned())
            .into_any_element(),
        );
    }
    if !p.actions.is_empty() {
        body.push(actions(&p.actions, drawn));
    }
    if let Some(c) = columns(p, drawn) {
        body.push(c);
    }
    let details: Vec<AnyElement> = p.details.iter().map(|d| detail(d, drawn)).collect();
    // the folds close up under each other, their lines between them
    if !details.is_empty() {
        body.push(div().pt(px(8.)).children(details).into_any_element());
    }
    let pane = stack(14., body)
        .id(SharedString::from(sel.clone()))
        .debug_selector(|| "run-focus".to_owned())
        .size_full()
        .min_h_0()
        .px(px(FOCUS_PAD_X))
        .pt(px(12.))
        .pb(px(14.))
        .overflow_y_scroll()
        .track_scroll(&scroll);
    div()
        .debug_selector(move || sel)
        .size_full()
        .min_w_0()
        .min_h_0()
        .flex()
        .flex_col()
        .text_size(px(look::UI_FONT_SIZE))
        .child(pane)
        .into_any_element()
}

// ── the verify kit ───────────────────────────────────────────────────────────────────────────

/// What an Evidence file's header says: its pixel size (None: it can't be read) and, a GIF,
/// whether it is small enough to play in place.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Probed {
    size: Option<(f32, f32)>,
    gif_fits: bool,
}

/// The files probed by path (None: being read).
static PROBES: std::sync::LazyLock<parking_lot::Mutex<HashMap<String, Option<Probed>>>> =
    std::sync::LazyLock::new(Default::default);

thread_local! {
    /// The app the probes run in (its background executor), drawn again once one was read.
    static PROBING: std::cell::RefCell<Option<gpui_kit::AsyncApp>> = const {
        std::cell::RefCell::new(None)
    };
}

/// The Run page's files are probed in this app.
pub(super) fn probe_in(cx: &App) {
    PROBING.set(Some(cx.to_async()));
}

/// What `path`'s header says, once it was read: the first ask reads it off the UI thread (never
/// while drawing) and draws again once read; a failure kept as one.
fn probed(path: &str) -> Option<Probed> {
    {
        let mut known = PROBES.lock();
        if let Some(known) = known.get(path) {
            return *known;
        }
        known.insert(path.to_owned(), None);
    }
    let path = path.to_owned();
    PROBING.with_borrow(|app| match app {
        Some(app) => {
            let read = app.background_executor().spawn(async move {
                let probed = read_probe(&path);
                PROBES.lock().insert(path, Some(probed));
            });
            app.spawn(async move |cx| {
                read.await;
                cx.update(|cx| cx.refresh_windows());
            })
            .detach();
        }
        // (no app to draw again: a frame after it takes it)
        None => {
            let _ = std::thread::Builder::new()
                .name("run-probe".into())
                .spawn(move || {
                    let probed = read_probe(&path);
                    PROBES.lock().insert(path, Some(probed));
                });
        }
    });
    None
}

/// The most a GIF played in place may take decoded: gpui holds every frame (frames × w × h × 4).
const GIF_BYTES_MAX: f32 = 320. * 1024. * 1024.;

/// `path`'s header read (off the UI thread): its size, and a GIF's frames (each one's Graphic
/// Control Extension) times its pixel size against [`GIF_BYTES_MAX`]. One that can't be read
/// fits: its frame says so.
fn read_probe(path: &str) -> Probed {
    let size = image_size(Path::new(path)).filter(|(w, h)| *w > 0. && *h > 0.);
    let gif = Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("gif"));
    let gif_fits = match (gif, size) {
        (true, Some((w, h))) => match std::fs::read(path) {
            Ok(bytes) => {
                let frames = bytes
                    .windows(3)
                    .filter(|b| b[..] == *b"\x21\xf9\x04")
                    .count()
                    .max(1);
                frames as f32 * w * h * 4. <= GIF_BYTES_MAX
            }
            Err(_) => true,
        },
        _ => true,
    };
    Probed { size, gif_fits }
}

/// An image's pixel size; None while it is read or can't be.
fn pixel_size(path: &str) -> Option<(f32, f32)> {
    probed(path).and_then(|p| p.size)
}

/// An Evidence image at its frame's full width, its own shape; one that can't be read says its
/// alt words. A GIF plays only when `play`: its frame is the element's state, kept by its id.
fn picture(path: &str, alt: &str, play: bool) -> gpui_kit::Div {
    let alt = SharedString::from(if alt.is_empty() {
        path.rsplit('/').next().unwrap_or(path).to_owned()
    } else {
        alt.to_owned()
    });
    let image = img(PathBuf::from(path))
        .object_fit(ObjectFit::Contain)
        .with_fallback(move || {
            dim(alt.clone())
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .into_any_element()
        });
    let frame = div()
        .relative()
        .w_full()
        .rounded(px(8.))
        .border_1()
        .border_color(look::BORDER)
        .bg(look::EDITOR_BG)
        .overflow_hidden();
    let size = pixel_size(path);
    let image = match size {
        Some(_) => image.absolute().top_0().left_0().size_full(),
        None => image.size_full(),
    };
    let image = if play {
        image
            .id(SharedString::from(format!("run-gif-{path}")))
            .into_any_element()
    } else {
        image.into_any_element()
    };
    match size {
        Some((w, h)) => frame.aspect_ratio(w / h).child(image),
        None => frame.h(px(SHOT_H)).child(image),
    }
}

/// Whether a playing GIF was in its scroll's view when last drawn.
#[derive(Default)]
struct InView(std::rc::Rc<std::cell::Cell<bool>>);

/// A playing GIF: it plays while it is in view, else shows its first frame (gpui asks a frame
/// for every GIF it plays, shown or not: one scrolled away would keep the window drawing). One
/// coming into view asks the frame it starts in; one leaving stops in the frame it asked itself.
fn playing_gif(id: &str, gif: &str, caption: &str, drawn: &Drawn) -> gpui_kit::Div {
    let seen = drawn.memory.kept::<InView>(id, "gif").borrow().0.clone();
    picture(gif, caption, seen.get()).child(
        gpui_kit::canvas(
            move |bounds, window, _| {
                let shown = window.content_mask().bounds.intersects(&bounds);
                if shown != seen.replace(shown) && shown {
                    window.request_animation_frame();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full(),
    )
}

/// Where a shot or recording was taken: its page (a click opens it) and the account it was
/// driven as; None when it says neither.
fn where_line(url: &str, url_id: &str, account: &str, drawn: &mut Drawn) -> Option<gpui_kit::Div> {
    if url.is_empty() && account.is_empty() {
        return None;
    }
    drawn.add("RunKitWhere", format!("{url} · as {account}"));
    let sel = format!("factory-node-{url_id}");
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .when(!url.is_empty(), |d| {
                d.child(clickable(
                    mono(url.to_owned())
                        .debug_selector(move || sel)
                        .text_color(look::ABE_ACCENT),
                    Some(url_id),
                    drawn,
                ))
            })
            .when(!account.is_empty(), |d| {
                d.child(dim(format!("as {account}")).flex_none())
            }),
    )
}

/// A shot at the column's full width, its caption, page and account under it; in a pair its side
/// (`Before`, `After`) over it. A click on it opens it full size.
fn figure(s: &Shot, side: Option<&'static str>, drawn: &mut Drawn) -> gpui_kit::Div {
    drawn.add("RunKitShot", s.path.clone());
    if let Some(label) = side {
        drawn.add("RunKitPairLabel", label);
    }
    let sel = format!("factory-node-{}", s.id);
    let shot = clickable(
        picture(&s.path, &s.alt, false).debug_selector(move || sel),
        Some(&s.id),
        drawn,
    );
    let place = where_line(&s.url, &s.url_id, &s.account, drawn);
    let parts = side
        .map(|label| caption(label).into_any_element())
        .into_iter()
        .chain([shot.into_any_element()])
        .chain((!s.caption.is_empty()).then(|| {
            prose(s.caption.clone())
                .text_color(look::TEXT_DIM)
                .into_any_element()
        }))
        .chain(place.map(IntoElement::into_any_element));
    stack(6., parts).w_full().when_some(side, |d, label| {
        let sel = format!("run-kit-pair-{}", label.to_lowercase());
        d.debug_selector(move || sel)
    })
}

/// A boxed part: its caption, then its words (How it was judged, Not driven).
fn kit_box(head: &str, text: &str) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .px(px(12.))
        .py(px(10.))
        .rounded(px(6.))
        .bg(look::HOVER_BG)
        .child(caption(head))
        .children(text.lines().map(|l| prose(l.to_owned()).into_any_element()))
        .into_any_element()
}

fn kit_part(p: &KitPart, drawn: &mut Drawn) -> AnyElement {
    match p {
        KitPart::Pair { before, after } => {
            drawn.add(
                "RunKitPair",
                format!("{} | {}", before.caption, after.caption),
            );
            // each shot says which it is, over it; Before over After, each the column's width
            let shots = [
                figure(before, Some("Before"), drawn).into_any_element(),
                figure(after, Some("After"), drawn).into_any_element(),
            ];
            stack(14., shots).into_any_element()
        }
        KitPart::Shot { shot } => figure(shot, None, drawn).into_any_element(),
        KitPart::Recording {
            id,
            gif,
            still,
            path,
            playing,
            control,
            video_id,
            open_video,
            caption,
            url,
            url_id,
            account,
        } => {
            drawn.add(
                if *playing {
                    "RunKitPlaying"
                } else {
                    "RunKitRecording"
                },
                format!("{control} {path}"),
            );
            // (a GIF not probed yet shows its still: it plays once it is known to fit)
            let fits = (*playing && !gif.is_empty())
                .then(|| probed(gif).map(|p| p.gif_fits))
                .flatten();
            let long = fits == Some(false);
            if long {
                drawn.add("RunKitGifTooLong", gif.clone());
            }
            let media = if fits == Some(true) {
                playing_gif(id, gif, caption, drawn).into_any_element()
            } else if !still.is_empty() {
                picture(still, caption, false).into_any_element()
            } else {
                dim(if long {
                    "Too long to play here · Open video".to_owned()
                } else {
                    format!("Recording · {}", path.rsplit('/').next().unwrap_or(path))
                })
                .w_full()
                .h(px(SHOT_H / 2.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(8.))
                .border_1()
                .border_color(look::BORDER)
                .bg(look::EDITOR_BG)
                .into_any_element()
            };
            let media = clickable(
                div().w_full().cursor_pointer().child(media),
                Some(video_id),
                drawn,
            );
            let controls = div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .when(!long, |d| d.child(link(control, id, drawn)))
                .when(*open_video || long, |d| {
                    d.child(link("Open video", video_id, drawn))
                })
                .when(long, |d| d.child(dim("too long to play here")))
                .when(!caption.is_empty(), |d| {
                    d.child(dim(caption.clone()).flex_1())
                });
            let place = where_line(url, url_id, account, drawn);
            let parts = [media.into_any_element(), controls.into_any_element()]
                .into_iter()
                .chain(place.map(IntoElement::into_any_element));
            stack(6., parts).into_any_element()
        }
        KitPart::Judged { head, text } => {
            drawn.add("RunKitJudged", text.clone());
            kit_box(head, text)
        }
        KitPart::NotDriven { head, text } => {
            drawn.add("RunKitNotDriven", text.clone());
            kit_box(head, text)
        }
        KitPart::Transcript {
            path,
            caption: words,
            lines,
        } => {
            drawn.add("RunKitTranscript", path.clone());
            let shown: Vec<AnyElement> = lines
                .iter()
                .take(TRANSCRIPT_ROWS)
                .map(|l| {
                    mono(l.clone())
                        .px(px(6.))
                        .text_color(look::EDITOR_FG)
                        .into_any_element()
                })
                .collect();
            let more = lines.len().saturating_sub(TRANSCRIPT_ROWS);
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(look::SEPARATOR)
                        .bg(look::EDITOR_BG)
                        .py(px(4.))
                        .children(shown)
                        .when(more > 0, |d| {
                            d.child(dim(format!("{more} more lines in its file")).px(px(6.)))
                        }),
                )
                .child(dim(if words.is_empty() {
                    path.clone()
                } else {
                    words.clone()
                }))
                .into_any_element()
        }
    }
}

/// A feature of the verify kit: its verdict, title and Feature map file, then its parts.
fn kit_feature(f: &KitFeature, first: bool, drawn: &mut Drawn) -> AnyElement {
    drawn.add(
        "RunKitFeature",
        format!("{} {} {}", f.mark.glyph, f.verdict, f.title),
    );
    let parts: Vec<AnyElement> = f.parts.iter().map(|p| kit_part(p, drawn)).collect();
    let id = f.feature.clone();
    let head = div()
        .flex()
        .items_center()
        .gap(px(10.))
        .min_w_0()
        .child(mark(&f.mark))
        .child(
            text(f.verdict.clone())
                .flex_none()
                .text_color(hue(f.mark.hue)),
        )
        .child(
            text(f.title.clone())
                .text_size(px(look::UI_FONT_SIZE + 1.))
                .font_weight(FontWeight::SEMIBOLD),
        )
        .child(mono(f.file.clone()).text_color(look::TEXT_DIM))
        .when(!f.env.is_empty(), |d| {
            drawn.add("RunKitEnv", f.env.clone());
            d.child(chip(&f.env, look::TEXT_DIM.rgba()))
        });
    stack(12., [head.into_any_element()].into_iter().chain(parts))
        .debug_selector(move || format!("run-kit-{id}"))
        .when(!first, |d| {
            d.pt(px(16.)).border_t_1().border_color(look::BORDER)
        })
        .into_any_element()
}

// ── the focus pane's diffs, decisions and skills ─────────────────────────────────────────────

fn diff(lines: &[String]) -> AnyElement {
    let tone = |l: &str| match l.chars().next() {
        Some('+') => (Some(look::DIFF_INSERTED_BG), Some(look::GIT_ADDED)),
        Some('-') => (Some(look::DIFF_DELETED_BG), Some(look::ABE_BAD)),
        _ => (None, None),
    };
    div()
        .min_w_0()
        .rounded(px(4.))
        .border_1()
        .border_color(look::SEPARATOR)
        .bg(look::EDITOR_BG)
        .py(px(4.))
        .child(lines_text(lines, 6., tone).text_color(look::EDITOR_FG))
        .into_any_element()
}

/// A step's decisions: what it chose and over what on the left, why on the right.
fn decisions(rows: &[Decision], drawn: &mut Drawn) -> gpui_kit::Div {
    let rows: Vec<AnyElement> = rows
        .iter()
        .map(|d| {
            drawn.add(
                "RunStepDecision",
                format!("{} over {}: {}", d.chose, d.over, d.why),
            );
            div()
                .flex()
                .gap(px(16.))
                .min_w_0()
                .px(px(12.))
                .py(px(8.))
                .rounded(px(6.))
                .bg(look::HOVER_BG)
                .child(
                    div()
                        .flex_none()
                        .w(px(CHOSE_W))
                        .flex()
                        .flex_col()
                        .child(prose(d.chose.clone()).font_weight(FontWeight::SEMIBOLD))
                        .child(prose(format!("over {}", d.over)).text_color(look::TEXT_DIM)),
                )
                .child(prose(d.why.clone()).flex_1())
                .into_any_element()
        })
        .collect();
    div().flex().flex_col().gap(px(6.)).children(rows)
}

fn skills(names: &[String], drawn: &mut Drawn) -> gpui_kit::Div {
    let chips: Vec<AnyElement> = names
        .iter()
        .map(|n| {
            drawn.add("RunSkill", n.clone());
            chip(n, look::TEXT_DIM.rgba()).into_any_element()
        })
        .collect();
    div().flex().flex_wrap().gap(px(6.)).children(chips)
}

// ── the spec pane ────────────────────────────────────────────────────────────────────────────

/// The spec's markdown as lines: headings bold, items with their bullet, paragraphs wrapping.
fn markdown(body: &str) -> Vec<AnyElement> {
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let t = l.trim();
            if let Some(h) = t.strip_prefix('#') {
                prose(h.trim_start_matches('#').trim().to_owned())
                    .pt(px(6.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .into_any_element()
            } else if let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
                prose(format!("•  {item}")).into_any_element()
            } else {
                prose(t.to_owned()).into_any_element()
            }
        })
        .collect()
}

fn spec(id: Option<&str>, p: &SpecProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("RunSpecPane", p.title.clone());
    let sel = selector("RunSpecPane", ix, id);
    let head = if p.page {
        link(&p.head, "run:spec:page", drawn).into_any_element()
    } else {
        dim(p.head.clone()).into_any_element()
    };
    drawn.add("RunSpecMeta", p.meta.clone());
    let rows: Vec<AnyElement> = p
        .criteria
        .iter()
        .map(|c| {
            drawn.add("RunSpecCriterion", format!("{} {}", c.mark.glyph, c.text));
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .min_w_0()
                .child(mark(&c.mark))
                .child(prose(c.text.clone()).flex_1())
                .when(c.proof, |d| {
                    d.child(link("proof →", &format!("run:proof:{}", c.n), drawn))
                })
                .into_any_element()
        })
        .collect();
    div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .size_full()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(PAD_X))
        .border_l_1()
        .border_color(look::BORDER)
        .overflow_y_scroll()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(head)
        .child(
            prose(p.title.clone())
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD),
        )
        .child(dim(p.meta.clone()))
        .children(markdown(&p.body))
        .child(
            prose("Acceptance criteria")
                .pt(px(6.))
                .font_weight(FontWeight::SEMIBOLD),
        )
        .children(rows)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gif_too_big_to_hold_decoded_does_not_play_in_place() {
        let dir = std::env::temp_dir().join(format!("abe-gif-fits-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 960 × 600, then `frames` Graphic Control Extensions
        let gif = |name: &str, frames: usize| {
            let mut b = b"GIF89a\xc0\x03\x58\x02".to_vec();
            for _ in 0..frames {
                b.extend_from_slice(b"\x21\xf9\x04\x00\x05\x00\x00\x00");
            }
            let path = dir.join(name);
            std::fs::write(&path, b).unwrap();
            path.to_string_lossy().into_owned()
        };

        let fits = |p: &str| read_probe(p).gif_fits;
        assert!(fits(&gif("short.gif", 40)));
        assert!(!fits(&gif("long.gif", 1600)));
        assert!(fits("/nowhere/at/all.gif"));
        assert_eq!(read_probe(&gif("short.gif", 1)).size, Some((960., 600.)));
        assert_eq!(read_probe("/nowhere/at/all.png").size, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
