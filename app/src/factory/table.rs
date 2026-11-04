//! The Table (`Table` in `abe/packages/ui/src/runtime/components.ts`; boards F-Sessions, X-Boxes):
//! a header of columns, 30 px rows of cells, the selected row tinted, an Empty in the rows' place
//! while there are none, the key line under them with a dim note at its right (at the
//! header's right a long note ran over the column labels). Props in, pixels out: which rows show
//! (the screen windows them to the height), which is selected and what the keys do is the
//! bridge's. A click on a row names its id.

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Rgba, SharedString, StatefulInteractiveElement as _, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::board::{Axis, Segment, moves_on, segments};
use super::draw::{Drawn, hue, selector};
use super::protocol::{CloudState, Hue, UserInput};
use super::select;
use super::workspaces::cloud;
use crate::look;

/// A column's width: fixed px, or a share of what the fixed ones leave.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ColumnWidth {
    Fixed { fixed: f32 },
    Flex { flex: f32 },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnAlign {
    #[default]
    Start,
    End,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TableColumn {
    pub label: String,
    pub width: ColumnWidth,
    #[serde(default)]
    pub align: ColumnAlign,
}

/// One cell: the accent words, the rail, the cloud, the mark and the text, left to right.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TableCell {
    pub accent: Option<String>,
    pub rail: Option<Vec<Segment>>,
    pub cloud: Option<CloudState>,
    pub mark: Option<String>,
    pub text: Option<String>,
    pub hue: Option<Hue>,
    pub tooltip: Option<String>,
    /// A button in the row (Settings' Open): a click names this id, not the row's.
    pub id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TableRow {
    pub id: Option<String>,
    pub cells: Vec<TableCell>,
    pub hue: Option<Hue>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TableEmpty {
    pub title: String,
    pub line: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TableFoot {
    pub keys: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TableProps {
    pub columns: Vec<TableColumn>,
    #[serde(default)]
    pub rows: Vec<TableRow>,
    pub selected: Option<String>,
    pub note: Option<String>,
    /// The `/` filter's text while one is on: Esc is the list's then, it clears it.
    pub filter: Option<String>,
    pub empty: Option<TableEmpty>,
    #[serde(default)]
    pub foot: Vec<TableFoot>,
}

/// px (board F-Sessions `.nv-sess__*`): the header row, a row (DS `abe-row-height`), the key line,
/// the gap between cells, the selection's inset and the text's inside it, a cell's parts apart.
pub const HEAD_H: f32 = 28.;
pub const ROW_H: f32 = 30.;
pub const FOOT_H: f32 = 24.;
const CELL_GAP: f32 = 12.;
const INSET_X: f32 = 8.;
const PAD_X: f32 = 8.;
const PART_GAP: f32 = 6.;
/// The box's cloud (boards F-Sessions, X-Boxes: 12 px).
const CLOUD: f32 = 12.;

/// Every row's cells laid out as the header's: one box per column, its width as the column says;
/// a row with fewer cells than columns has its last cell take the rest.
fn line(columns: &[TableColumn], cells: Vec<AnyElement>) -> gpui_kit::Div {
    let n = cells.len();
    let mut d = div()
        .size_full()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(CELL_GAP));
    for (i, cell) in cells.into_iter().enumerate() {
        let spans = i + 1 == n && n < columns.len();
        let col = &columns[i.min(columns.len() - 1)];
        let mut c = div()
            .h_full()
            .min_w_0()
            .flex()
            .items_center()
            .overflow_hidden()
            .when(col.align == ColumnAlign::End && !spans, |c| c.justify_end());
        c = match (spans, col.width) {
            (false, ColumnWidth::Fixed { fixed }) => c.flex_none().w(px(fixed)),
            (false, ColumnWidth::Flex { flex }) => {
                c.style().flex_grow = Some(flex);
                c.style().flex_shrink = Some(1.);
                c.style().flex_basis = Some(px(0.).into());
                c
            }
            (true, _) => c.flex_1(),
        };
        d = d.child(c.child(cell));
    }
    d
}

/// The words a cell draws, for [`Drawn`]: `#2 The cart total…`, `◆ Needs you`, `☁ running`.
fn words(c: &TableCell) -> String {
    let cloud = c.cloud.map(|s| {
        format!(
            "☁ {}",
            match s {
                CloudState::Running => "running",
                CloudState::Asleep => "asleep",
                CloudState::Starting => "starting",
            }
        )
    });
    [c.accent.clone(), cloud, c.mark.clone(), c.text.clone()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
}

fn cell(c: &TableCell, key: &str, active: bool, drawn: &mut Drawn) -> AnyElement {
    let plain = if active {
        look::SELECTION_TEXT
    } else {
        look::TEXT
    };
    // on the active selection dim words and the accent read as the selection's text, as lists do;
    // a state's hue stays
    let tone = |h: Option<Hue>| -> Rgba {
        match h {
            None => plain.rgba(),
            Some(Hue::Dim | Hue::Accent) if active => look::SELECTION_TEXT.rgba(),
            Some(h) => hue(h),
        }
    };
    if let Some(r) = &c.rail {
        let segs: Vec<String> = r.iter().map(|s| format!("{s:?}").to_lowercase()).collect();
        drawn.add("TableRail", segs.join(" "));
    }
    if let Some(s) = c.cloud {
        drawn.add("TableCloud", format!("{s:?}").to_lowercase());
    }
    // a button cell is found by its own id, as a row is
    let key = c.id.as_deref().unwrap_or(key);
    let at = format!("factory-node-{key}");
    let d = div()
        .id(SharedString::from(key.to_owned()))
        .debug_selector(move || at)
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(PART_GAP))
        .overflow_hidden()
        .whitespace_nowrap()
        .when_some(c.accent.clone(), |d, a| {
            d.child(
                div()
                    .flex_none()
                    .text_color(tone(Some(Hue::Accent)))
                    .child(select::text(a)),
            )
        })
        .when_some(c.rail.as_deref(), |d, r| d.child(segments(r)))
        .when_some(c.cloud, |d, state| {
            // the header's cloud: the accent, dim asleep
            let color = match state {
                CloudState::Asleep => look::TEXT_DIM,
                CloudState::Running | CloudState::Starting => look::ABE_ACCENT,
            };
            d.child(cloud(state, CLOUD, color.rgba()))
        })
        .when_some(c.mark.clone(), |d, m| {
            d.child(
                div()
                    .flex_none()
                    .text_color(tone(c.hue))
                    .child(SharedString::from(m)),
            )
        })
        .when_some(c.text.clone(), |d, t| {
            d.child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_color(tone(c.hue))
                    .child(select::text(t)),
            )
        })
        .when_some(c.tooltip.clone(), |d, t| {
            d.tooltip(crate::kit::tooltip(t, None))
        });
    match (c.id.clone(), drawn.sink.clone()) {
        (Some(id), Some(sink)) => {
            drawn.add("TableButton", id.clone());
            d.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    // the button's, not the row's click under it
                    cx.stop_propagation();
                    sink.click(id.clone(), window, cx);
                })
                .into_any_element()
        }
        _ => d.into_any_element(),
    }
}

fn row(r: &TableRow, ix: usize, p: &TableProps, table: &str, drawn: &mut Drawn) -> AnyElement {
    let text: Vec<String> = r.cells.iter().map(words).collect();
    let text = text.join(" | ");
    let dix = drawn.add("TableRow", text.clone());
    let selected = r.id.is_some() && r.id == p.selected;
    let active = selected && drawn.focused;
    if selected {
        drawn.add(
            "TableSelected",
            format!("{text} {}", if active { "active" } else { "inactive" }),
        );
    }
    if let Some(h) = r.hue {
        drawn.add("TableRowHue", format!("{h:?}").to_lowercase());
    }
    let bg = match (selected, active, r.hue) {
        (true, true, _) => Some(look::SELECTION_BG.rgba()),
        (true, false, _) => Some(look::SELECTION_BG_INACTIVE.rgba()),
        (false, _, Some(h)) => Some(look::abe_badge_bg(hue(h))),
        (false, _, None) => None,
    };
    let row_key = r.id.clone().unwrap_or_else(|| format!("{table}-note-{ix}"));
    let cells: Vec<AnyElement> = r
        .cells
        .iter()
        .enumerate()
        .map(|(i, c)| cell(c, &format!("{row_key}-cell-{i}"), active, drawn))
        .collect();
    let sel = selector("TableRow", dix, r.id.as_deref());
    let inner = div()
        .size_full()
        .px(px(PAD_X))
        .rounded(px(4.))
        .when_some(bg, |d, bg| d.bg(bg))
        .when(r.id.is_some() && !selected, |d| {
            d.hover(|s| s.bg(look::HOVER_BG))
        })
        .child(line(&p.columns, cells));
    let outer = div()
        .debug_selector(move || sel)
        .flex_none()
        .h(px(ROW_H))
        .w_full()
        .px(px(INSET_X))
        .text_size(px(look::UI_FONT_SIZE))
        .child(inner);
    // a click selects; a double-click is then the row's ⏎ (attach, open), as a graph box's
    match (r.id.clone(), drawn.sink.clone()) {
        (Some(id), Some(sink)) => outer
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, move |ev, window, cx| {
                cx.stop_propagation();
                sink.click(id.clone(), window, cx);
                if ev.click_count == 2 {
                    sink.send(UserInput::Key { key: "<CR>".into() }, cx);
                }
            })
            .into_any_element(),
        _ => outer.into_any_element(),
    }
}

/// Whether `tree` holds a Table with its `/` filter on: Esc clears it first.
pub fn filtering(tree: &super::protocol::Node) -> bool {
    match tree {
        super::protocol::Node::Table { props, .. } => props.filter.is_some(),
        n => n.children().iter().any(filtering),
    }
}

fn head(p: &TableProps, drawn: &mut Drawn) -> AnyElement {
    let labels: Vec<AnyElement> = p
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            drawn.add("TableHead", c.label.clone());
            div()
                .debug_selector(move || format!("factory-table-head-{i}"))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(SharedString::from(c.label.clone()))
                .into_any_element()
        })
        .collect();
    div()
        .debug_selector(|| "factory-table-head".into())
        .flex_none()
        .h(px(HEAD_H))
        .w_full()
        .flex()
        .items_center()
        .px(px(INSET_X + PAD_X))
        .gap(px(CELL_GAP))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(line(&p.columns, labels)),
        )
        .into_any_element()
}

/// The Empty in the rows' place: centred in the body while it fits, else from the body's top (auto
/// margins, never centring past the edges), clipped to the body: never over the header (a
/// short pane drew `Asking abe serve` over the column labels).
fn empty(e: &TableEmpty, drawn: &mut Drawn) -> AnyElement {
    drawn.add("TableEmpty", e.title.clone());
    drawn.add("TableEmptyLine", e.line.clone());
    div()
        .debug_selector(|| "factory-table-empty".into())
        .flex_1()
        .min_h_0()
        .overflow_hidden()
        .flex()
        .flex_col()
        .items_center()
        .child(
            div()
                .my_auto()
                .py(px(4.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .child(
                    div()
                        .debug_selector(|| "factory-table-empty-title".into())
                        .text_color(look::TEXT)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(select::text(e.title.clone())),
                )
                .child(
                    div()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(select::text(e.line.clone())),
                ),
        )
        .into_any_element()
}

/// The key line, the note at its right end (cut with … when it runs into the keys).
fn foot(keys: &[TableFoot], note: Option<&str>, drawn: &mut Drawn) -> AnyElement {
    let mut d = div()
        .flex_none()
        .h(px(FOOT_H))
        .w_full()
        .flex()
        .items_center()
        .gap(px(PART_GAP))
        .px(px(INSET_X + PAD_X))
        .whitespace_nowrap()
        .overflow_hidden()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM);
    for (i, k) in keys.iter().enumerate() {
        drawn.add("TableFoot", format!("{} {}", k.keys, k.label));
        if i > 0 {
            d = d.child(div().flex_none().child("·"));
        }
        d = d.child(
            div()
                .flex_none()
                .flex()
                .gap(px(4.))
                .child(
                    div()
                        .text_color(look::ABE_ACCENT)
                        .child(SharedString::from(k.keys.clone())),
                )
                .child(SharedString::from(k.label.clone())),
        );
    }
    if let Some(note) = note {
        drawn.add("TableNote", note.to_owned());
        d = d.child(
            div()
                .debug_selector(|| "factory-table-note".into())
                .ml_auto()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .child(SharedString::from(note.to_owned())),
        );
    }
    d.into_any_element()
}

/// The Table filling its place: header, rows (or the Empty), the key line at the bottom.
pub fn table(id: Option<&str>, p: &TableProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("Table", id.unwrap_or_default());
    let sel = selector("Table", ix, id);
    let key = id.map_or_else(|| format!("table-{ix}"), str::to_owned);
    let header = head(p, drawn);
    let body: AnyElement = match (&p.empty, p.rows.is_empty()) {
        (Some(e), true) => empty(e, drawn),
        _ => {
            let rows: Vec<AnyElement> = p
                .rows
                .iter()
                .enumerate()
                .map(|(i, r)| row(r, i, p, &key, drawn))
                .collect();
            let d = div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .overflow_hidden()
                .children(rows);
            // the wheel over the rows scrolls them by whole rows, as a Board column by
            // cards; the selection stays
            match (id, drawn.sink.clone()) {
                (Some(id), Some(sink)) => {
                    let id = id.to_owned();
                    d.on_scroll_wheel(move |ev, _, cx| {
                        if moves_on(ev.delta, Axis::Y) {
                            cx.stop_propagation();
                            sink.wheel(id.clone(), Axis::Y, ev.delta, ROW_H, cx);
                        }
                    })
                    .into_any_element()
                }
                _ => d.into_any_element(),
            }
        }
    };
    let footer =
        (!p.foot.is_empty() || p.note.is_some()).then(|| foot(&p.foot, p.note.as_deref(), drawn));
    // its rows take the clicks: the table itself names none
    div()
        .debug_selector(move || sel)
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(header)
        .child(body)
        .children(footer)
        .into_any_element()
}
