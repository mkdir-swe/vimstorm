//! The Pipelines tab's own components (`abe/packages/ui/src/pipelines/pipeline-components.ts`; 1.0
//! artboards L-01 … L-21, PipelineRuns / PipelineGraph READMEs), drawn in the bottom pane's slot:
//! the scope bar over the runs (a [`super::table`] Table), the selected run's summary beside them,
//! a run's head, its jobs as a graph (dependency elbows, group frames, the log view's narrow
//! form, the legend), a job's panel (its card, step counters, steps and evidence) and its log.
//! Props in, pixels out (the 1.x Rust tab's look, now with the screen's words, hues and places):
//! a click names the scope tab's id, `workflow`, `workflow:clear`, a crumb's id, a button's
//! `act:<row>`, a box's `job:<id>`, an evidence row's `evidence:<n>`, its Open file
//! `open-file:<n>`; the wheel over the log is `scroll` on `pipelines-log`. The graph scrolls
//! both ways in its room and keeps the selected box in view as the keys move it.

use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Pixels, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, div, font, point, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::board::{Axis, moves_on};
use super::draw::{Drawn, clickable, hue, own_clicks, selector};
use super::protocol::{Hue, UserInput};
use super::select;
use crate::kit::TextButton;
use crate::look;
use crate::render::EDITOR_FONT;

/// The kinds of the set (`PIPELINE_KINDS`).
pub const KINDS: &[&str] = &[
    "PipelinesBar",
    "RunSummary",
    "RunHead",
    "RunGraph",
    "JobPanel",
    "JobLog",
];

// The overview's metrics (PipelineRuns README "Values", L-01).
const BAR_H: f32 = 30.;
const SCOPE_TAB_H: f32 = 22.;
const PAD_X: f32 = 14.;
const JOB_LINE_H: f32 = 20.;
const FACT_W: f32 = 64.;
// The graph's (PipelineGraph README "Values", L-05 / L-18).
const JOB_W: f32 = 184.;
const JOB_W_NARROW: f32 = 132.;
const JOB_H: f32 = 55.;
const COL_PITCH: f32 = 228.;
const COL_PITCH_NARROW: f32 = 168.;
const ROW_PITCH: f32 = 67.;
const ROW_PITCH_NARROW: f32 = 63.;
const GRAPH_PAD: f32 = 24.;
const GRAPH_PAD_NARROW: f32 = 16.;
// The log's (L-07).
pub const LOG_LINE_H: f32 = 20.;
const LOG_NUM_W: f32 = 44.;
const LOG_TIME_W: f32 = 76.;
/// The screen moves the log 3 lines per wheel step (`pipelines.ts`): a step is 3 lines' worth.
const LOG_STEP: f32 = 3. * LOG_LINE_H;
const EVIDENCE_H: f32 = 44.;
const STEP_H: f32 = 22.;
const SMALL_BUTTON_H: f32 = 24.;
/// The graph's legend: a size under the small one, so its seven marks fit one line beside the
/// job's panel.
const LEGEND_FONT: f32 = 11.;

/// A state as drawn: glyph, word, hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct StateMark {
    pub glyph: String,
    pub word: String,
    pub hue: Hue,
}

/// A button of a run's head, a job's card or the summary: its click is its `id` (`act:<row>`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Scope {
    pub id: String,
    pub label: String,
    pub tooltip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Workflow {
    pub label: String,
    pub on: bool,
}

/// The scope row (L-01 §1).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BarProps {
    pub scopes: Vec<Scope>,
    pub selected: String,
    pub workflow: Workflow,
    pub count: String,
    pub source: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SummaryJob {
    pub mark: String,
    pub name: String,
    pub duration: String,
    pub hue: Hue,
    #[serde(default)]
    pub prod: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Fact {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SummaryAgent {
    pub word: String,
    pub hue: Hue,
    pub workspace: String,
    pub env: String,
}

/// The selected run at a glance (L-01's right pane).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SummaryProps {
    pub identity: String,
    pub state: StateMark,
    pub title: String,
    pub meta: String,
    pub jobs: Vec<SummaryJob>,
    pub skipped: Option<String>,
    pub facts: Vec<Fact>,
    pub agent: Option<SummaryAgent>,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Crumb {
    pub id: Option<String>,
    pub text: String,
}

/// A run entered (L-05).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct HeadProps {
    pub crumbs: Vec<Crumb>,
    pub title: String,
    pub state: StateMark,
    pub meta: String,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GraphJob {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    pub state: StateMark,
    pub duration: String,
    pub column: usize,
    pub row: usize,
}

/// A run's jobs as dependency-connected boxes (L-05 / L-18).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GraphProps {
    pub jobs: Vec<GraphJob>,
    /// Absent: dependency data unavailable (no lines drawn).
    pub edges: Option<Vec<(String, String)>>,
    pub selected: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub narrow: bool,
    pub legend: Option<Vec<StateMark>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Counter {
    pub text: String,
    pub hue: Hue,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Step {
    pub state: StateMark,
    pub name: String,
    pub duration: String,
    #[serde(default)]
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Evidence {
    pub title: String,
    pub detail: String,
    pub unavailable: Option<String>,
    pub file: Option<String>,
    /// An artifact (▤), not a line of the log (✗).
    #[serde(default)]
    pub artifact: bool,
}

/// The selected job (L-06).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct JobProps {
    pub name: String,
    pub state: StateMark,
    pub words: String,
    pub counters: Vec<Counter>,
    pub actions: Vec<Action>,
    pub steps: Vec<Step>,
    #[serde(rename = "evidenceTitle")]
    pub evidence_title: Option<String>,
    pub evidence: Vec<Evidence>,
    pub selected: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LogLine {
    pub n: u64,
    pub time: String,
    pub text: String,
    #[serde(default)]
    pub error: bool,
    #[serde(default)]
    pub evidence: bool,
}

/// A job's log (L-07).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LogProps {
    pub title: String,
    pub range: String,
    pub lines: Vec<LogLine>,
}

/// One component of the set.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Bar(BarProps),
    Summary(SummaryProps),
    Head(HeadProps),
    Graph(GraphProps),
    Job(JobProps),
    Log(LogProps),
}

impl Part {
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Part, D::Error> {
        use serde::de::Error as _;
        Ok(match kind {
            "PipelinesBar" => Part::Bar(serde::Deserialize::deserialize(props)?),
            "RunSummary" => Part::Summary(serde::Deserialize::deserialize(props)?),
            "RunHead" => Part::Head(serde::Deserialize::deserialize(props)?),
            "RunGraph" => Part::Graph(serde::Deserialize::deserialize(props)?),
            "JobPanel" => Part::Job(serde::Deserialize::deserialize(props)?),
            "JobLog" => Part::Log(serde::Deserialize::deserialize(props)?),
            _ => {
                return Err(D::Error::custom(format!(
                    "not a pipelines component: {kind}"
                )));
            }
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Bar(_) => "PipelinesBar",
            Part::Summary(_) => "RunSummary",
            Part::Head(_) => "RunHead",
            Part::Graph(_) => "RunGraph",
            Part::Job(_) => "JobPanel",
            Part::Log(_) => "JobLog",
        }
    }
}

/// Whether `tree` is the Pipelines screen inside one workflow or a run (its root Island
/// `pipelines-history` or `pipelines-run`): Esc is the screen's there, it steps back, and the pane
/// keeps the keyboard; on the overview (`pipelines`) Esc gives it back.
pub fn steps_back(tree: &super::protocol::Node) -> bool {
    matches!(tree.id(), Some("pipelines-history" | "pipelines-run"))
}

/// The component drawn.
pub fn part(id: Option<&str>, p: &Part, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    match p {
        Part::Bar(p) => bar(id, p, drawn),
        Part::Summary(p) => summary(p, drawn),
        Part::Head(p) => head(p, drawn),
        Part::Graph(p) => graph(p, drawn, cx),
        Part::Job(p) => job(p, drawn),
        Part::Log(p) => log(id, p, drawn),
    }
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

fn state(w: &StateMark) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .min_w_0()
        .whitespace_nowrap()
        .text_color(hue(w.hue))
        .child(div().flex_none().child(SharedString::from(w.glyph.clone())))
        .child(text(w.word.clone()))
        .into_any_element()
}

/// A button: its click is its id, sent to the bridge (the slot's view takes the keyboard).
fn button(at: &str, a: &Action, drawn: &mut Drawn) -> TextButton {
    drawn.add(
        "PipelinesAction",
        format!("{}{}", a.label, if a.disabled { " (disabled)" } else { "" }),
    );
    let sink = drawn.sink.clone();
    let click = a.id.clone();
    TextButton::new(
        SharedString::from(format!("pipelines-{at}-{}", a.id)),
        a.label.clone(),
    )
    .primary(a.primary)
    .disabled(a.disabled)
    .on_click(move |_, window, cx| {
        if let Some(sink) = &sink {
            sink.click(click.clone(), window, cx);
        }
    })
}

fn buttons(at: &str, actions: &[Action], drawn: &mut Drawn) -> gpui_kit::Div {
    let row: Vec<TextButton> = actions.iter().map(|a| button(at, a, drawn)).collect();
    div().flex_none().flex().gap(px(8.)).children(row)
}

// ── the overview ─────────────────────────────────────────────────────────────────────────────

fn bar(id: Option<&str>, p: &BarProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("PipelinesBar", p.count.clone());
    let sel = selector("PipelinesBar", ix, id);
    let focused = drawn.focused;
    let mut tabs: Vec<AnyElement> = Vec::new();
    for s in &p.scopes {
        let on = s.id == p.selected;
        drawn.add("PipelinesScope", s.label.clone());
        if on {
            drawn.add("PipelinesScopeSelected", s.label.clone());
        }
        let sid = s.id.clone();
        let (bg, border) = if focused {
            (look::TAB_SELECTED_BG, look::TAB_SELECTED_BORDER)
        } else {
            (
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG,
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER,
            )
        };
        let t = div()
            .id(SharedString::from(format!("pipelines-{sid}")))
            .debug_selector(move || {
                if on {
                    format!("factory-node-{sid}-selected")
                } else {
                    format!("factory-node-{sid}")
                }
            })
            .flex_none()
            .h(px(SCOPE_TAB_H))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(4.))
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .when(on, |d| d.bg(bg).border_color(border))
            .when(!on, |d| d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG)))
            .when_some(s.tooltip.clone(), |d, tip| {
                d.tooltip(crate::kit::tooltip(tip, None))
            })
            .child(SharedString::from(s.label.clone()));
        tabs.push(clickable(t, Some(&s.id), drawn).into_any_element());
    }
    drawn.add("PipelinesWorkflow", p.workflow.label.clone());
    let chip = if p.workflow.on {
        let clear = clickable(
            div()
                .debug_selector(|| "factory-node-workflow:clear".into())
                .text_color(look::TEXT_DIM)
                .child("×"),
            Some("workflow:clear"),
            drawn,
        );
        let name = clickable(
            div()
                .debug_selector(|| "factory-node-workflow".into())
                .child(text(p.workflow.label.clone())),
            Some("workflow"),
            drawn,
        );
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(name)
            .child(clear)
            .into_any_element()
    } else {
        clickable(
            div()
                .debug_selector(|| "factory-node-workflow".into())
                .flex_none()
                .flex()
                .items_center()
                .text_color(look::FILTER_CHIP_NAME_FG)
                .child(SharedString::from(p.workflow.label.clone())),
            Some("workflow"),
            drawn,
        )
        .into_any_element()
    };
    drawn.add("PipelinesCount", p.count.clone());
    if let Some(s) = &p.source {
        drawn.add("PipelinesSource", s.clone());
    }
    div()
        .debug_selector(move || sel)
        .flex_none()
        .h(px(BAR_H))
        .w_full()
        .px(px(PAD_X))
        .flex()
        .items_center()
        .gap(px(4.))
        .border_b_1()
        .border_color(look::BORDER)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .whitespace_nowrap()
        .overflow_hidden()
        .children(tabs)
        .child(
            div()
                .flex_none()
                .w(px(1.))
                .h(px(16.))
                .mx(px(6.))
                .bg(look::SEPARATOR),
        )
        .child(chip)
        .child(div().flex_1())
        .child(
            dim(p.count.clone())
                .flex_shrink(1.)
                .debug_selector(|| "pipelines-count".into()),
        )
        .when_some(p.source.clone(), |d, s| {
            d.child(
                dim(s)
                    .ml(px(12.))
                    .flex_shrink(1.)
                    .text_color(look::TEXT_DISABLED),
            )
        })
        .into_any_element()
}

fn summary(s: &SummaryProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunSummary", s.title.clone());
    drawn.add("RunSummaryIdentity", s.identity.clone());
    drawn.add("RunSummaryState", s.state.word.clone());
    drawn.add("RunSummaryMeta", s.meta.clone());
    let facts: Vec<AnyElement> = s
        .facts
        .iter()
        .map(|f| {
            drawn.add("RunSummaryFact", format!("{} {}", f.label, f.value));
            div()
                .flex_none()
                .flex()
                .gap(px(10.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .child(dim(f.label.clone()).flex_none().w(px(FACT_W)))
                .child(text(f.value.clone()))
                .into_any_element()
        })
        .collect();
    let jobs: Vec<AnyElement> = s
        .jobs
        .iter()
        .map(|j| {
            drawn.add(
                "RunSummaryJob",
                format!("{} {} {}", j.mark, j.name, j.duration),
            );
            div()
                .flex_none()
                .h(px(JOB_LINE_H))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_none()
                        .w(px(14.))
                        .text_color(hue(j.hue))
                        .child(SharedString::from(j.mark.clone())),
                )
                .child(text(j.name.clone()).flex_1().text_color(if j.prod {
                    look::ABE_BAD
                } else {
                    look::TEXT
                }))
                .child(
                    div()
                        .flex_none()
                        .w(px(56.))
                        .flex()
                        .justify_end()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(select::text(j.duration.clone())),
                )
                .into_any_element()
        })
        .collect();
    let agent = s.agent.as_ref().map(|a| {
        drawn.add(
            "RunSummaryAgent",
            format!("{} · {} · {}", a.word, a.workspace, a.env),
        );
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(10.))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(dim("Agent").flex_none().w(px(FACT_W)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .min_w_0()
                    .whitespace_nowrap()
                    .child(div().flex_none().text_color(hue(a.hue)).child("●"))
                    .child(
                        div()
                            .flex_none()
                            .text_color(hue(a.hue))
                            .child(select::text(a.word.clone())),
                    )
                    .child(div().flex_none().text_color(look::TEXT_DISABLED).child("·"))
                    .child(text(a.workspace.clone())),
            )
            .child(dim(format!("· {}", a.env)))
    });
    let actions = buttons("summary", &s.actions, drawn);
    let skipped = s.skipped.clone().map(|sk| {
        drawn.add("RunSummarySkipped", sk.clone());
        dim(format!("· {sk}"))
            .h(px(JOB_LINE_H))
            .text_color(look::TEXT_DISABLED)
    });
    // what the run is, then its jobs, facts and agent: clipped when the pane is short (the jobs
    // give way first), the actions always under them
    let body = div()
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex_none()
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .child(dim(format!("{} ·", s.identity)))
                .child(state(&s.state)),
        )
        .child(
            text(s.title.clone())
                .flex_none()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::SELECTION_TEXT),
        )
        .child(
            dim(s.meta.clone())
                .flex_none()
                .text_size(px(look::UI_SMALL_FONT_SIZE)),
        )
        .child(
            div()
                .debug_selector(|| "pipelines-summary-jobs".into())
                .min_h_0()
                .overflow_hidden()
                .flex()
                .flex_col()
                .children(jobs)
                .children(skipped),
        )
        .children(facts)
        .children(agent);
    // its buttons' clicks alone, never the island's too
    own_clicks(div(), drawn)
        .debug_selector(|| "pipelines-summary".into())
        .size_full()
        .min_h_0()
        .px(px(PAD_X))
        .py(px(10.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .border_l_1()
        .border_color(look::TAB_STRIP_BORDER)
        .overflow_hidden()
        .child(body)
        .child(actions)
        .into_any_element()
}

// ── a run entered ────────────────────────────────────────────────────────────────────────────

fn head(g: &HeadProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("RunHead", g.title.clone());
    drawn.add("RunHeadState", g.state.word.clone());
    drawn.add("RunHeadMeta", g.meta.clone());
    let n = g.crumbs.len();
    let mut crumbs: Vec<AnyElement> = Vec::new();
    for (i, c) in g.crumbs.iter().enumerate() {
        drawn.add("RunCrumb", c.text.clone());
        if i > 0 {
            crumbs.push(
                div()
                    .text_color(look::TEXT_DISABLED)
                    .child("›")
                    .into_any_element(),
            );
        }
        let here = i + 1 == n;
        let at = c.id.clone().map_or_else(
            || format!("pipelines-crumb-{i}"),
            |id| format!("factory-node-{id}"),
        );
        let d = div()
            .debug_selector(move || at)
            .whitespace_nowrap()
            .text_color(if here { look::TEXT } else { look::TEXT_DIM })
            .when(c.id.is_some() && !here, |d| {
                d.hover(|s| s.text_color(look::TEXT))
            })
            .child(SharedString::from(c.text.clone()));
        crumbs.push(clickable(d, c.id.as_deref(), drawn).into_any_element());
    }
    let actions = buttons("head", &g.actions, drawn);
    div()
        .debug_selector(|| "pipelines-runhead".into())
        .size_full()
        .px(px(PAD_X))
        .py(px(10.))
        .flex()
        .items_center()
        .gap(px(12.))
        .border_b_1()
        .border_color(look::BORDER)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .overflow_hidden()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .children(crumbs),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .min_w_0()
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(15.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(select::text(g.title.clone())),
                        )
                        .child(div().flex_none().child(state(&g.state)))
                        .child(dim(g.meta.clone()).text_size(px(look::UI_SMALL_FONT_SIZE))),
                ),
        )
        .child(actions)
        .into_any_element()
}

/// The graph's geometry: box width, column and row pitch, the padding round it.
fn metrics(narrow: bool) -> (f32, f32, f32, f32) {
    if narrow {
        (
            JOB_W_NARROW,
            COL_PITCH_NARROW,
            ROW_PITCH_NARROW,
            GRAPH_PAD_NARROW,
        )
    } else {
        (JOB_W, COL_PITCH, ROW_PITCH, GRAPH_PAD)
    }
}

/// A graph's scrolls kept across frames (down: the note, the boxes and the legend; across: the
/// boxes), and the box last brought into view.
#[derive(Default)]
struct GraphScroll {
    down: ScrollHandle,
    across: ScrollHandle,
    revealed: Option<String>,
    /// A reveal asked before the scrolls were laid out: placed on the next frame.
    pending: bool,
    /// That next frame was asked for (once a reveal).
    asked: bool,
    /// Whether the last frame drew the note over the boxes (the boxes' child index then).
    noted: Option<bool>,
}

/// `offset` moved only as far as shows `[from, to]` (content px) in a `room` px viewport.
fn shown_from(offset: Pixels, from: Pixels, to: Pixels, room: Pixels) -> Pixels {
    if from < -offset {
        -from
    } else if to > -offset + room {
        -(to - room).min(from)
    } else {
        offset
    }
}

/// The selected box (`left`, `top` on the canvas) scrolled into view, the padding round it too;
/// false while the scrolls have not been laid out yet.
fn reveal(k: &GraphScroll, canvas_ix: usize, at: (f32, f32), size: (f32, f32), pad: f32) -> bool {
    let (down, across) = (k.down.bounds(), k.across.bounds());
    let Some(canvas) = k.down.bounds_for_item(canvas_ix) else {
        return false;
    };
    if down.size.height <= px(0.) || across.size.width <= px(0.) {
        return false;
    }
    let top = canvas.top() - down.top() + px(at.1 - pad);
    let bottom = canvas.top() - down.top() + px(at.1 + size.1 + pad);
    let off = k.down.offset();
    k.down.set_offset(point(
        off.x,
        shown_from(off.y, top, bottom, down.size.height),
    ));
    let off = k.across.offset();
    let x = shown_from(
        off.x,
        px(at.0 - pad),
        px(at.0 + size.0 + pad),
        across.size.width,
    );
    k.across.set_offset(point(x, off.y));
    true
}

fn graph(g: &GraphProps, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    let (w, pitch_x, pitch_y, pad) = metrics(g.narrow);
    let cols = g.jobs.iter().map(|j| j.column + 1).max().unwrap_or(1);
    let rows = g.jobs.iter().map(|j| j.row + 1).max().unwrap_or(1);
    let width = pad * 2. + (cols - 1) as f32 * pitch_x + w;
    let height = pad * 2. + (rows - 1) as f32 * pitch_y + JOB_H;
    let x = |c: usize| pad + c as f32 * pitch_x;
    let y = |r: usize| pad + r as f32 * pitch_y;
    let mut canvas = div().relative().flex_none().w(px(width)).h(px(height));
    // elbows behind the boxes, bending before the receiving column, a filled head at the target
    for (from, to) in g.edges.as_deref().unwrap_or_default() {
        let (Some(a), Some(b)) = (
            g.jobs.iter().find(|j| &j.id == from),
            g.jobs.iter().find(|j| &j.id == to),
        ) else {
            continue;
        };
        if a.column >= b.column {
            continue;
        }
        let lit = g.selected.as_ref() == Some(from) || g.selected.as_ref() == Some(to);
        drawn.add(
            "RunGraphEdge",
            format!("{from} → {to}{}", if lit { " lit" } else { "" }),
        );
        let color = if lit {
            look::FOCUS_BORDER
        } else {
            look::FIELD_BORDER
        };
        let line = |l: f32, t: f32, w: f32, h: f32| {
            div()
                .absolute()
                .left(px(l))
                .top(px(t))
                .w(px(w.max(1.)))
                .h(px(h.max(1.)))
                .bg(color)
        };
        let (sx, sy) = (x(a.column) + w, y(a.row) + JOB_H / 2.);
        let (tx, ty) = (x(b.column), y(b.row) + JOB_H / 2.);
        let bend = tx - (pitch_x - w) / 2.;
        let edge = format!("pipelines-edge-{from}-{to}");
        canvas = canvas.child(
            div()
                .debug_selector(move || edge)
                .absolute()
                .size_full()
                .child(line(sx, sy, bend - sx, 1.))
                .child(line(bend, sy.min(ty), 1., (ty - sy).abs()))
                .child(line(bend, ty, tx - bend - 6., 1.))
                // the arrowhead: a filled 6 × 8 triangle, as narrowing columns
                .children((0..4).map(|i| {
                    let i = i as f32;
                    line(tx - 6. + i * 1.5, ty - 4. + i, 1.5, 8. - i * 2.)
                })),
        );
    }
    // a group's boxes in one column framed together under its name: a reusable workflow's jobs
    // under their caller, a matrix's legs under their key, an Azure stage's jobs under it
    let mut framed: Vec<(&str, usize, usize, usize)> = Vec::new();
    for j in &g.jobs {
        let Some(name) = j.group.as_deref() else {
            continue;
        };
        match framed
            .iter_mut()
            .find(|(n, c, _, _)| *n == name && *c == j.column)
        {
            Some(f) => {
                f.2 = f.2.min(j.row);
                f.3 = f.3.max(j.row);
            }
            None => framed.push((name, j.column, j.row, j.row)),
        }
    }
    for (name, column, top, bottom) in framed {
        drawn.add("RunGraphGroup", name.to_owned());
        let slug = name.to_lowercase().replace([' ', '/'], "-");
        canvas = canvas.child(
            div()
                .debug_selector(move || format!("pipelines-group-{slug}"))
                .absolute()
                .left(px(x(column) - 6.))
                .top(px(y(top) - 18.))
                .w(px(w + 12.))
                .h(px(y(bottom) - y(top) + JOB_H + 24.))
                .rounded(px(look::ABE_LANE_ARC + 2.))
                .border_1()
                .border_dashed()
                .border_color(look::BORDER)
                .px(px(6.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(text(name.to_owned())),
        );
    }
    for j in &g.jobs {
        let active = g.selected.as_deref() == Some(j.id.as_str());
        drawn.add(
            "RunGraphJob",
            format!("{} {} {}", j.name, j.state.word, j.duration),
        );
        if active {
            drawn.add("RunGraphSelected", j.name.clone());
        }
        let skipped = j.state.hue == Hue::Dim;
        let tip = format!("{} · {} · {}", j.name, j.state.word, j.duration);
        let sel = format!("factory-node-{}", j.id);
        let d = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .absolute()
            .left(px(x(j.column)))
            .top(px(y(j.row)))
            .w(px(w))
            .h(px(JOB_H))
            .rounded(px(look::ABE_LANE_ARC))
            .border_1()
            .when(skipped, |d| d.border_dashed())
            .border_color(if active {
                look::FOCUS_BORDER
            } else {
                look::FIELD_BORDER
            })
            .bg(if active {
                look::TAB_SELECTED_BG
            } else {
                look::EDITOR_BG
            })
            .px(px(12.))
            .py(px(6.))
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(4.))
            .tooltip(crate::kit::tooltip(tip, None))
            .child(text(j.name.clone()).text_color(if skipped {
                look::TEXT_DIM
            } else {
                look::TEXT
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .whitespace_nowrap()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(hue(j.state.hue))
                    .child(div().size(px(6.)).rounded_full().bg(hue(j.state.hue)))
                    .child(SharedString::from(j.state.word.clone()))
                    .child(div().flex_1())
                    .child(dim(j.duration.clone())),
            );
        // a click selects the box; a double-click is then its ⏎ (the job's log), as a Table row's
        let d = match drawn.sink.clone() {
            Some(sink) => {
                let id = j.id.clone();
                d.cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |ev, window, cx| {
                        cx.stop_propagation();
                        sink.click(id.clone(), window, cx);
                        if ev.click_count == 2 {
                            sink.send(UserInput::Key { key: "<CR>".into() }, cx);
                        }
                    })
                    .into_any_element()
            }
            None => d.into_any_element(),
        };
        canvas = canvas.child(d);
    }
    // the selected box kept in view as the keys move it (a short or narrow pane clips the rest)
    // the drawing view's own, by the graph's form
    let (down, across, again) = {
        let scrolls = drawn
            .memory
            .kept::<GraphScroll>("", if g.narrow { "graph:narrow" } else { "graph" });
        let mut scrolls = scrolls.borrow_mut();
        let scrolls = &mut *scrolls;
        if scrolls.revealed != g.selected {
            scrolls.revealed = g.selected.clone();
            scrolls.pending = true;
            scrolls.asked = false;
        }
        // the last frame's children are what the reveal measures: the note there as here
        let laid = scrolls.noted == Some(g.note.is_some());
        scrolls.noted = Some(g.note.is_some());
        if scrolls.pending && !laid {
            scrolls.asked = false;
        }
        if scrolls.pending
            && laid
            && let Some(j) = g.jobs.iter().find(|j| g.selected.as_ref() == Some(&j.id))
        {
            let canvas_ix = usize::from(g.note.is_some());
            scrolls.pending = !reveal(scrolls, canvas_ix, (x(j.column), y(j.row)), (w, JOB_H), pad);
        }
        // first drawn: placed once it is laid out, on a frame asked for now
        let again = scrolls.pending && !scrolls.asked;
        scrolls.asked |= again;
        (scrolls.down.clone(), scrolls.across.clone(), again)
    };
    if again {
        cx.defer(|cx| cx.refresh_windows());
    }
    let viewport = div()
        .id("pipelines-graph-canvas")
        .debug_selector(|| "pipelines-graph-canvas".into())
        .relative()
        .w_full()
        .flex_none()
        .h(px(height))
        .overflow_x_scroll()
        .track_scroll(&across)
        .child(canvas);
    let legend = g.legend.as_ref().map(|l| {
        for m in l {
            drawn.add("RunGraphLegend", format!("{} {}", m.glyph, m.word));
        }
        div()
            .debug_selector(|| "pipelines-legend".into())
            .flex_none()
            .px(px(PAD_X))
            .py(px(8.))
            .flex()
            .flex_wrap()
            .items_center()
            // one line in a graph pane beside the job (a 1400 px window, Chat docked); narrower,
            // whole marks wrap right under
            .gap_x(px(8.))
            .gap_y(px(4.))
            .text_size(px(LEGEND_FONT))
            .children(l.iter().enumerate().map(|(i, m)| {
                div()
                    .debug_selector(move || format!("pipelines-legend-{i}"))
                    .flex_none()
                    .child(state(m))
            }))
    });
    div()
        .id("pipelines-graph")
        .debug_selector(|| "pipelines-graph".into())
        .size_full()
        .min_h_0()
        .overflow_y_scroll()
        .track_scroll(&down)
        .flex()
        .flex_col()
        .when_some(g.note.clone(), |d, n| {
            drawn.add("RunGraphNote", n.clone());
            d.child(
                dim(n)
                    .debug_selector(|| "pipelines-graph-note".into())
                    .flex_none()
                    .px(px(PAD_X))
                    .pt(px(8.)),
            )
        })
        .child(viewport)
        .children(legend)
        .into_any_element()
}

fn counters(c: &[Counter], drawn: &mut Drawn) -> AnyElement {
    div()
        .flex()
        .flex_wrap()
        .gap(px(6.))
        .children(c.iter().map(|c| {
            drawn.add("JobCounter", c.text.clone());
            div()
                .h(px(22.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .bg(look::abe_badge_bg(hue(c.hue)))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(hue(c.hue))
                .whitespace_nowrap()
                .child(select::text(c.text.clone()))
        }))
        .into_any_element()
}

fn evidence_row(i: usize, e: &Evidence, selected: bool, drawn: &mut Drawn) -> AnyElement {
    let detail = match &e.unavailable {
        Some(u) => format!("{} · {u}", e.detail),
        None => e.detail.clone(),
    };
    drawn.add("JobEvidence", format!("{} · {detail}", e.title));
    if selected {
        drawn.add("JobEvidenceSelected", e.title.clone());
    }
    let open = e.file.as_ref().map(|f| {
        drawn.add("JobEvidenceFile", f.clone());
        let sink = drawn.sink.clone();
        let click = format!("open-file:{i}");
        TextButton::new(
            SharedString::from(format!("pipelines-open-file-{i}")),
            "Open file",
        )
        .small(SMALL_BUTTON_H)
        .tooltip(f.clone())
        .on_click(move |_, window, cx| {
            if let Some(sink) = &sink {
                sink.click(click.clone(), window, cx);
            }
        })
    });
    let gone = e.unavailable.is_some();
    let d = div()
        .id(SharedString::from(format!("pipelines-evidence-{i}")))
        .debug_selector(move || format!("factory-node-evidence:{i}"))
        .flex_none()
        .min_h(px(EVIDENCE_H))
        .mx(px(6.))
        .px(px(8.))
        .py(px(4.))
        .rounded(px(4.))
        .flex()
        .items_center()
        .gap(px(10.))
        .when(selected, |d| d.bg(look::SELECTION_BG_INACTIVE))
        .when(!selected, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .child(
            div()
                .flex_none()
                .text_color(match (gone, e.artifact) {
                    (true, _) => look::TEXT_DISABLED,
                    (false, true) => look::TEXT_DIM,
                    (false, false) => look::ABE_BAD,
                })
                .child(if e.artifact { "▤" } else { "✗" }),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(text(e.title.clone()).when(gone, |d| d.text_color(look::TEXT_DIM)))
                .child(
                    dim(detail)
                        .font(font(EDITOR_FONT))
                        .text_size(px(look::UI_SMALL_FONT_SIZE)),
                ),
        )
        .children(open);
    clickable(d, Some(&format!("evidence:{i}")), drawn).into_any_element()
}

fn job(p: &JobProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("JobPanel", p.name.clone());
    drawn.add("JobPanelState", p.state.word.clone());
    drawn.add("JobPanelWords", p.words.clone());
    let actions = buttons("job", &p.actions, drawn);
    let card = div()
        .debug_selector(|| "pipelines-job-card".into())
        .flex_none()
        .mx(px(PAD_X))
        .mt(px(10.))
        .p(px(12.))
        .rounded(px(look::ABE_LANE_ARC))
        .border_1()
        .border_color(look::BORDER)
        .bg(look::EDITOR_BG)
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(select::text(p.name.clone())),
                )
                .child(div().flex_none().child(state(&p.state))),
        )
        .child(dim(p.words.clone()).text_size(px(look::UI_SMALL_FONT_SIZE)))
        .child(counters(&p.counters, drawn))
        .when(!p.actions.is_empty(), |d| d.child(actions));
    let steps: Vec<AnyElement> = p
        .steps
        .iter()
        .map(|s| {
            drawn.add(
                "JobStep",
                format!(
                    "{} {} {}{}",
                    s.state.glyph,
                    s.name,
                    s.duration,
                    if s.current { " current" } else { "" }
                ),
            );
            div()
                .flex_none()
                .h(px(STEP_H))
                .px(px(PAD_X))
                .flex()
                .items_center()
                .gap(px(10.))
                .when(s.current, |d| d.bg(look::SELECTION_BG_INACTIVE))
                .child(
                    div()
                        .flex_none()
                        .w(px(12.))
                        .text_color(hue(s.state.hue))
                        .child(SharedString::from(s.state.glyph.clone())),
                )
                .child(text(s.name.clone()).flex_1())
                .child(dim(s.duration.clone()).text_size(px(look::UI_SMALL_FONT_SIZE)))
                .into_any_element()
        })
        .collect();
    let heading = |t: String| {
        dim(t)
            .flex_none()
            .px(px(PAD_X))
            .py(px(6.))
            .text_size(px(look::STRIPE_FONT_SIZE))
    };
    let evidence: Vec<AnyElement> = p
        .evidence
        .iter()
        .enumerate()
        .map(|(i, e)| evidence_row(i, e, p.selected == Some(i), drawn))
        .collect();
    let title = p.evidence_title.clone().filter(|_| !p.evidence.is_empty());
    if let Some(t) = &title {
        drawn.add("JobEvidenceTitle", t.clone());
    }
    div()
        .id("pipelines-job")
        .debug_selector(|| "pipelines-job".into())
        .size_full()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(2.))
        .pb(px(12.))
        .border_l_1()
        .border_r_1()
        .border_color(look::TAB_STRIP_BORDER)
        .child(card)
        .when(!steps.is_empty(), |d| {
            d.child(heading(format!("STEPS · {}", p.name.to_uppercase())))
                .children(steps)
        })
        .when_some(title, |d, t| d.child(heading(t)).children(evidence))
        .into_any_element()
}

fn log_line(l: &LogLine, drawn: &mut Drawn) -> AnyElement {
    let marks = match (l.error, l.evidence) {
        (true, true) => " [error evidence]",
        (true, false) => " [error]",
        (false, true) => " [evidence]",
        (false, false) => "",
    };
    drawn.add(
        "JobLogLine",
        format!("{} {} {}{marks}", l.n, l.time, l.text),
    );
    let n = l.n;
    div()
        .debug_selector(move || format!("pipelines-log-line-{n}"))
        .flex_none()
        .h(px(LOG_LINE_H))
        .flex()
        .items_center()
        .whitespace_nowrap()
        .when(l.evidence, |d| {
            d.bg(look::abe_badge_bg(look::ABE_BAD.rgba()))
        })
        .child(
            div()
                .flex_none()
                .w(px(LOG_NUM_W))
                .pr(px(8.))
                .flex()
                .justify_end()
                .text_color(look::TEXT_DISABLED)
                .child(SharedString::from(l.n.to_string())),
        )
        .child(
            div()
                .flex_none()
                .w(px(LOG_TIME_W))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(l.time.clone())),
        )
        .child(
            div()
                .flex_none()
                .text_color(if l.error { look::ABE_BAD } else { look::TEXT })
                // the line's words alone are copied, its number and time are not
                .child(select::text(l.text.clone())),
        )
        .into_any_element()
}

fn log(id: Option<&str>, p: &LogProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("JobLog", p.title.clone());
    drawn.add("JobLogRange", p.range.clone());
    let lines: Vec<AnyElement> = p.lines.iter().map(|l| log_line(l, drawn)).collect();
    // the screen holds the lines from where it is: the wheel moves it (`scroll` on the log's id)
    let body = div()
        .id("pipeline-log-lines")
        .debug_selector(|| "pipeline-log-lines".into())
        .flex_1()
        .min_h_0()
        .overflow_x_scroll()
        .bg(look::EDITOR_BG)
        .font(font(EDITOR_FONT))
        .text_size(px(look::UI_FONT_SIZE))
        .flex()
        .flex_col()
        .children(lines);
    let body = match (id, drawn.sink.clone()) {
        (Some(id), Some(sink)) => {
            let id = id.to_owned();
            body.on_scroll_wheel(move |ev, _, cx| {
                if moves_on(ev.delta, Axis::Y) {
                    cx.stop_propagation();
                    sink.wheel(id.clone(), Axis::Y, ev.delta, LOG_STEP, cx);
                }
            })
            .into_any_element()
        }
        _ => body.into_any_element(),
    };
    div()
        .debug_selector(|| "pipelines-log".into())
        .size_full()
        .min_w_0()
        .min_h_0()
        .flex()
        .flex_col()
        .child(
            div()
                .flex_none()
                .px(px(PAD_X))
                .py(px(6.))
                .flex()
                .gap(px(12.))
                .text_size(px(look::STRIPE_FONT_SIZE))
                .child(dim(p.title.clone()).flex_1())
                .child(dim(p.range.clone()).flex_none()),
        )
        .child(body)
        .into_any_element()
}
