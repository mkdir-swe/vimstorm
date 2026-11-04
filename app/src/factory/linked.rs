//! ⌃L's Linked popup (board W-Linked; `abe/packages/ui/src/linked/linked-layer.ts`): a layer
//! of Command mode's, drawn in Search Everywhere's size and look ([`crate::search`]): 670
//! wide, 48 px from the top of the window, centred over it. The title row `Linked · <id> The cart
//! total ignores quantity` with `⌃L` dim at its right, the 1 px line, the story's ten rows 30 high
//! at least (the label 120 wide, its state at the right: a mark's words in their hue, the Run row's
//! StageRail before them; a row with nothing dim and in place), the selected one tinted, then the
//! footer. Its state (filter, cursor) is the bridge's; a click on a row sends its id.

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Rgba, SharedString, Styled as _, deferred, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::board::Segment;
use super::draw::{self, Drawn};
use super::protocol::Span;
use crate::kit;
use crate::look;

/// Search Everywhere's width.
pub const WIDTH: f32 = crate::search::WIDTH;
/// From the top of the window.
pub const TOP: f32 = 48.;
/// A row's height (board `nv-lrow`).
pub const ROW_HEIGHT: f32 = 30.;
/// Over and under a row's words, so a state that wraps keeps its row's air.
const ROW_PAD_Y: f32 = 4.;
/// The label's column.
const LABEL_WIDTH: f32 = 120.;
/// Between the label and the state (board `nv-lrow` gap 12).
const GAP: f32 = 12.;
/// Between the Run row's rail and its words (board `nv-lrow__v` gap 8).
const RAIL_GAP: f32 = 8.;
/// The body's own padding (board: 4 0).
const BODY_PAD_Y: f32 = 4.;
/// Over the view's own popups, as the other layers.
const PRIORITY: usize = 2;

/// One row as drawn (`LinkedRowView`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LinkedRow {
    pub id: String,
    pub label: String,
    pub value: Vec<Span>,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub rail: Option<Vec<Segment>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkedState {
    Loading,
    Error,
}

/// The popup's props (`LinkedLayerNode`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct LinkedProps {
    /// After `Linked · `.
    pub story: String,
    /// Dim at the title's right.
    pub keys: String,
    /// What is typed so far; empty: no filter row.
    pub filter: String,
    pub rows: Vec<LinkedRow>,
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default)]
    pub state: Option<LinkedState>,
    #[serde(default)]
    pub message: Option<String>,
    pub hint: String,
}

/// The popup placed over a window `viewport` px, for a view that starts `top` px down in it (the
/// toolbar's height in the projects window).
pub fn over(p: &LinkedProps, viewport: (f32, f32), top: f32, drawn: &mut Drawn) -> AnyElement {
    let x = kit::centered(WIDTH, viewport.0);
    let slot = div()
        .absolute()
        .left(px(x))
        .top(px(TOP - top))
        .child(popup_of(p, drawn));
    deferred(slot).with_priority(PRIORITY).into_any_element()
}

/// The popup itself.
pub fn popup_of(p: &LinkedProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("LinkedLayer", format!("Linked · {}", p.story));
    let title = div().flex().whitespace_nowrap().child("Linked").child(
        div()
            .font_weight(FontWeight::NORMAL)
            .child(SharedString::from(format!("\u{a0}·\u{a0}{}", p.story))),
    );
    let keys = div()
        .flex_none()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(p.keys.clone()))
        .into_any_element();
    let filter = (!p.filter.is_empty()).then(|| {
        drawn.add("Filter", &p.filter);
        div()
            .debug_selector(|| "factory-linked-filter".into())
            .h(px(look::MENU_SEARCH_HEIGHT))
            .flex_none()
            .px(px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X))
            .flex()
            .items_center()
            .text_color(if p.rows.is_empty() {
                look::SPEED_SEARCH_ERROR_FG
            } else {
                look::SPEED_SEARCH_FG
            })
            .child(SharedString::from(p.filter.clone()))
    });
    let note = |text: String, error: bool| {
        div()
            .h(px(ROW_HEIGHT))
            .px(px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X))
            .flex()
            .items_center()
            .text_color(if error {
                look::TEXT_ERROR
            } else {
                look::MENU_DISABLED_FG
            })
            .child(SharedString::from(text))
            .into_any_element()
    };
    let body: Vec<AnyElement> = match p.state {
        Some(LinkedState::Loading) => {
            let text = "Reading what is linked…";
            drawn.add("LinkedState", text);
            vec![note(text.into(), false)]
        }
        Some(LinkedState::Error) => {
            let text = format!("✗ {}", p.message.as_deref().unwrap_or("not read"));
            drawn.add("LinkedState", &text);
            vec![note(text, true)]
        }
        None if p.rows.is_empty() => vec![note("Nothing to show".into(), false)],
        None => p
            .rows
            .iter()
            .map(|r| row(r, p.selected.as_deref() == Some(&r.id), drawn))
            .collect(),
    };
    kit::popup_frame()
        .debug_selector(|| "factory-linked".into())
        .w(px(WIDTH))
        .occlude()
        .child(kit::complex_header(title, Some(keys)))
        .child(div().flex_none().h(px(1.)).bg(look::SEPARATOR))
        .children(filter)
        .child(div().flex().flex_col().py(px(BODY_PAD_Y)).children(body))
        .child(kit::ad_text(SharedString::from(p.hint.clone())))
        .into_any_element()
}

fn row(r: &LinkedRow, selected: bool, drawn: &mut Drawn) -> AnyElement {
    let words: String = r.value.iter().map(|s| s.text.as_str()).collect();
    drawn.add("LinkedRow", format!("{} {words}", r.label));
    if selected {
        drawn.add("LinkedSelected", &r.label);
    }
    if r.dim {
        drawn.add("LinkedDim", &r.label);
    }
    let fg = |hue: Option<Rgba>| match (selected, r.dim) {
        (true, _) => look::SELECTION_TEXT.rgba(),
        (false, true) => look::TEXT_DIM.rgba(),
        (false, false) => hue.unwrap_or(look::TEXT.rgba()),
    };
    let id = r.id.clone();
    let selector = format!(
        "factory-linked-row-{}",
        r.id.trim_start_matches("linked:row:")
    );
    let sink = drawn.sink.clone();
    let rail = r.rail.as_ref().map(|segs| {
        drawn.add(
            "LinkedRail",
            segs.iter()
                .map(|s| format!("{s:?}").to_lowercase())
                .collect::<Vec<_>>()
                .join(" "),
        );
        super::board::segments(segs)
    });
    // a state too long for its line wraps whole under itself, right-aligned, never cut
    let spans = r.value.iter().map(|s| {
        div()
            .min_w_0()
            .flex_shrink(1.)
            .text_right()
            .text_color(fg(s.hue.map(draw::hue)))
            .child(SharedString::from(s.text.clone()))
    });
    let value = format!("{selector}-value");
    div()
        .debug_selector(move || selector.clone())
        .min_h(px(ROW_HEIGHT))
        .flex_none()
        .w_full()
        .px(px(look::LIST_ROW_INSET_X))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            if let Some(sink) = &sink {
                sink.click(id.clone(), window, cx);
            }
        })
        .child(
            div()
                .w_full()
                .min_h(px(ROW_HEIGHT))
                .py(px(ROW_PAD_Y))
                .px(px(look::LIST_ROW_PADDING_X))
                .rounded(px(look::LIST_SELECTION_ARC))
                .when(selected, |d| d.bg(look::SELECTION_BG))
                .flex()
                .items_center()
                .gap(px(GAP))
                .child(
                    div()
                        .flex_none()
                        .w(px(LABEL_WIDTH))
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_color(fg(None))
                        .child(SharedString::from(r.label.clone())),
                )
                .child(
                    div()
                        .ml_auto()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(RAIL_GAP))
                        .children(rail)
                        .child(
                            div()
                                .debug_selector(move || value)
                                .min_w_0()
                                .flex()
                                .flex_wrap()
                                .justify_end()
                                .children(spans),
                        ),
                ),
        )
        .into_any_element()
}
