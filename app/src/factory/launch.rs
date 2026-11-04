//! The Launch box, the Rust half of `layers.ts`' `LaunchBox`: a card's run set up before it
//! starts. Its workflow (the card workflows grouped Repo's, Yours, Abe's, the picked one lit, each
//! its `on:`; why one is preselected, a warning when the picked one does not take the card), its
//! Launch note (the CommentBox's field, the caret where the bridge says), what goes along dim (the
//! standing notes), where it runs (local or a box), the environments it reaches (prod's warning
//! once turned on), a count from 1500 characters (red once over), Launch. 640 px, centred near the
//! top of the view, a layer over it. It holds no state: the bridge says what is typed and picked;
//! every key goes to it, a click names `launch:go`, `launch:workflow:<id>`, `launch:runs:<id>` or
//! a reach's own (`launch:prod`).

use gpui_kit::{
    AnyElement, App, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, Styled as _, div, px,
};
use serde::Deserialize;

use super::comment::{dim_line, draft_field};
use super::draw::Drawn;
use crate::kit;
use crate::look;
use crate::render::EDITOR_FONT;

/// The box's width (as the CommentBox's).
pub const WIDTH: f32 = 640.;
/// What Launch names when clicked.
pub const GO: &str = "launch:go";
/// What a workflow row names when clicked: this and its id.
pub const WORKFLOW: &str = "launch:workflow:";
/// What a place to run names when clicked: this and its id.
pub const RUNS: &str = "launch:runs:";
/// The label column's width: `Workflow`, `Runs`, `Reaches`.
const LABEL_W: f32 = 64.;

/// A place it runs: `Local · its card worktree`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LaunchPick {
    pub id: String,
    pub label: String,
}

/// A row of the workflows: a source's head, or one workflow.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LaunchWorkflowRow {
    Head {
        text: String,
    },
    Item {
        id: String,
        name: String,
        desc: String,
        on: String,
        takes: bool,
        picked: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LaunchWorkflows {
    pub rows: Vec<LaunchWorkflowRow>,
    pub note: String,
    pub warn: Option<String>,
}

/// One environment agents reach: `✓ dev`, `○ prod off`; `click` the one the person turns on here.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LaunchReach {
    pub env: String,
    pub label: String,
    pub on: bool,
    pub click: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LaunchBoxProps {
    pub title: String,
    pub label: String,
    pub draft: String,
    /// The draft's caret in characters; None: at its end.
    pub caret: Option<usize>,
    pub placeholder: Option<String>,
    #[serde(default)]
    pub along: Vec<String>,
    #[serde(rename = "where")]
    pub place: String,
    pub workflows: LaunchWorkflows,
    pub runs: Vec<LaunchPick>,
    pub ran: String,
    pub reach: Vec<LaunchReach>,
    #[serde(rename = "prodWarn")]
    pub prod_warn: Option<String>,
    pub count: Option<String>,
    #[serde(default)]
    pub over: bool,
    pub hint: Option<String>,
}

/// A clickable bit that names `id` to the bridge.
fn clicks(el: gpui_kit::Div, id: String, drawn: &Drawn) -> gpui_kit::Div {
    let sink = drawn.sink.clone();
    el.cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |_, window, cx: &mut App| {
            cx.stop_propagation();
            if let Some(sink) = &sink {
                sink.click(id.clone(), window, cx);
            }
        })
}

/// A row's label column: `Workflow`, `Runs`, `Reaches`.
fn label(text: &'static str) -> gpui_kit::Div {
    div()
        .flex_none()
        .w(px(LABEL_W))
        .text_color(look::TEXT_DIM)
        .child(text)
}

fn one_line(s: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .min_w_0()
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .child(s.into())
}

/// The workflows, grouped by source: `Quick fix   A bug, reproduced first   type Bug`, the picked
/// one on the selection; then why one is preselected, and the warning when it does not take the card.
fn workflows(p: &LaunchBoxProps, drawn: &mut Drawn) -> AnyElement {
    let w = &p.workflows;
    let rows: Vec<AnyElement> = w
        .rows
        .iter()
        .map(|r| match r {
            LaunchWorkflowRow::Head { text } => {
                drawn.add("LaunchWorkflowHead", text);
                div()
                    .flex_none()
                    .pt(px(4.))
                    .px(px(8.))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(text.clone()))
                    .into_any_element()
            }
            LaunchWorkflowRow::Item {
                id,
                name,
                desc,
                on,
                takes,
                picked,
            } => {
                drawn.add("LaunchWorkflow", format!("{name} · {on}"));
                if *picked {
                    drawn.add("LaunchWorkflowPicked", name);
                }
                let sel = id.clone();
                let row = div()
                    .debug_selector(move || format!("factory-launch-workflow-{sel}"))
                    .flex_none()
                    .h(px(look::LIST_ROW_HEIGHT.get()))
                    .px(px(8.))
                    .rounded(px(look::LIST_SELECTION_ARC))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(one_line(name.clone()).flex_none().w(px(110.)))
                    .child(one_line(desc.clone()).flex_1().text_color(look::TEXT_DIM))
                    .child(
                        one_line(on.clone())
                            .flex_none()
                            .font_family(EDITOR_FONT)
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(if *takes {
                                look::ABE_ACCENT
                            } else {
                                look::TEXT_DIM
                            }),
                    );
                let row = if *picked {
                    row.bg(look::SELECTION_BG).text_color(look::SELECTION_TEXT)
                } else {
                    row
                };
                clicks(row, format!("{WORKFLOW}{id}"), drawn).into_any_element()
            }
        })
        .collect();
    drawn.add("LaunchWorkflowNote", &w.note);
    let warn = w.warn.as_ref().map(|t| {
        drawn.add("LaunchWorkflowWarn", t);
        div()
            .debug_selector(|| "factory-launch-workflow-warn".into())
            .flex_none()
            .px(px(8.))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_WARNING)
            .child(SharedString::from(t.clone()))
    });
    div()
        .debug_selector(|| "factory-launch-workflows".into())
        .flex_none()
        .px(px(10.))
        .pt(px(6.))
        .flex()
        .gap(px(0.))
        .child(label("Workflow").pt(px(4.)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .children(rows)
                .child(
                    div()
                        .flex_none()
                        .px(px(8.))
                        .pt(px(2.))
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(w.note.clone())),
                )
                .children(warn),
        )
        .into_any_element()
}

/// `Runs   ● Local · its card worktree   ○ A box · your environment`.
fn runs(p: &LaunchBoxProps, drawn: &mut Drawn) -> AnyElement {
    let row = p.runs.iter().map(|r| {
        let on = r.id == p.ran;
        let text = format!("{} {}", if on { "●" } else { "○" }, r.label);
        drawn.add("LaunchRuns", &text);
        let id = r.id.clone();
        clicks(
            div()
                .debug_selector(move || format!("factory-launch-runs-{id}"))
                .flex_none()
                .text_color(if on { look::TEXT } else { look::TEXT_DIM })
                .child(SharedString::from(text)),
            format!("{RUNS}{}", r.id),
            drawn,
        )
    });
    // none lit while serve.target is not read: where it says, dim
    let unknown = (!p.runs.iter().any(|r| r.id == p.ran))
        .then(|| one_line(p.place.clone()).text_color(look::TEXT_DIM));
    div()
        .flex_none()
        .px(px(10.))
        .min_h(px(look::LIST_ROW_HEIGHT.get()))
        .flex()
        .items_center()
        .gap(px(16.))
        .child(label("Runs"))
        .children(row)
        .children(unknown)
        .into_any_element()
}

/// `Reaches   ✓ dev   ✓ test   ○ prod off`, then prod's warning once turned on here.
fn reach(p: &LaunchBoxProps, drawn: &mut Drawn) -> AnyElement {
    let row: Vec<gpui_kit::Div> = p
        .reach
        .iter()
        .map(|r| {
            drawn.add("LaunchReach", &r.label);
            let env = r.env.clone();
            let badge = div()
                .debug_selector(move || format!("factory-launch-reach-{env}"))
                .flex_none()
                .text_color(if r.on {
                    look::TEXT_SUCCESS
                } else {
                    look::TEXT_DIM
                })
                .child(SharedString::from(r.label.clone()));
            match &r.click {
                Some(id) => clicks(badge, id.clone(), drawn),
                None => badge,
            }
        })
        .collect();
    let warn = p.prod_warn.as_ref().map(|t| {
        drawn.add("LaunchProdWarn", t);
        div()
            .debug_selector(|| "factory-launch-prod-warn".into())
            .flex_none()
            .px(px(10.))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_ERROR)
            .child(SharedString::from(t.clone()))
    });
    div()
        .flex_none()
        .flex()
        .flex_col()
        .child(
            div()
                .flex_none()
                .px(px(10.))
                .min_h(px(look::LIST_ROW_HEIGHT.get()))
                .flex()
                .items_center()
                .gap(px(16.))
                .child(label("Reaches"))
                .children(row),
        )
        .children(warn)
        .into_any_element()
}

/// The box, unplaced: [`super::layers::over`] centres it near the view's top.
pub fn launch_box(p: &LaunchBoxProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("LaunchBox", &p.title);
    drawn.add("LaunchDraft", &p.draft);
    for a in &p.along {
        drawn.add("LaunchAlong", a);
    }
    drawn.add("LaunchWhere", &p.place);
    // past the most it launches nothing: Launch grey, as the bridge's ⏎ is
    drawn.add("LaunchGo", if p.over { "Launch (grey)" } else { "Launch" });
    let count = p.count.as_ref().map(|c| {
        drawn.add("LaunchCount", c);
        div()
            .debug_selector(|| "factory-launch-count".into())
            .flex_none()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(if p.over {
                look::TEXT_ERROR
            } else {
                look::TEXT_DIM
            })
            .child(SharedString::from(c.clone()))
    });
    let button = div()
        .debug_selector(|| "factory-launch-go".into())
        .flex_none()
        .px(px(12.))
        .py(px(4.))
        .rounded(px(4.))
        .child("Launch");
    let go = if p.over {
        button.bg(look::FIELD_BG).text_color(look::TEXT_DIM)
    } else {
        clicks(
            button
                .bg(look::SELECTION_BG)
                .text_color(look::SELECTION_TEXT),
            GO.to_owned(),
            drawn,
        )
    };
    kit::popup_frame()
        .debug_selector(|| "factory-launch".into())
        .w(px(WIDTH))
        .occlude()
        .child(kit::header(SharedString::from(p.title.clone()), None))
        .child(workflows(p, drawn))
        .child(dim_line(p.label.clone()))
        .child(draft_field(
            &p.draft,
            p.caret,
            p.placeholder.as_deref(),
            "launch",
        ))
        .children(p.along.iter().map(|a| dim_line(a.clone())))
        .child(runs(p, drawn))
        .child(reach(p, drawn))
        .child(
            div()
                .flex_none()
                .px(px(10.))
                .pb(px(8.))
                .flex()
                .items_center()
                .justify_end()
                .gap(px(12.))
                .children(count)
                .child(go),
        )
        .children(
            p.hint
                .as_ref()
                .map(|h| kit::ad_text(SharedString::from(h.clone()))),
        )
        .into_any_element()
}
