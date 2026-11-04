//! The Settings dialog, the Rust half of `abe/packages/ui/src/settings/settings-components.ts`:
//! WebStorm's Settings at 1040 × 700, centred over the whole window and modal, as canvas boards
//! T-Appearance (the frame, the tree, the footer), T-Agents (rows, greyed choices, locks),
//! S-Search and S-Problems draw it. Its keys and state are the bridge's (`ui/src/settings/settings.ts`, a
//! layer beside Command mode); this file draws: the title bar with Close, the search field over
//! the tree (240 px, rows 24), the page (crumb and scope, groups of rows: the label and the value
//! in its control on one line, the help, source and hint dim under it while focused), the footer
//! (the dim note, Undo once a change is saved, Close: each change saves at once) and ⌘⏎'s propose
//! popup (S-Propose: the value now → the one proposed, the reason, Open pull request). A click
//! names a node's or button's id.
//! A later page adds a control kind or a part here, never a new dialog.

use std::collections::HashMap;

use gpui_kit::{
    AnyElement, App, FontWeight, Global, InteractiveElement, IntoElement, ParentElement as _, Rgba,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled, canvas, deferred, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, node, selector};
use super::protocol::{Node, UserInput};
use super::select;
use crate::kit;
use crate::kit::TextButton;
use crate::kit::{CheckState, check_box, checkbox_icon};
use crate::kit::{Icon, IconName};
use crate::look;
use crate::render::EDITOR_FONT;

/// The screen's name: the app's `open` for ⌘, (`SETTINGS_SCREEN`).
pub const SCREEN: &str = "settings";

/// The parts' kinds, in `SETTINGS_KINDS`' order.
pub const KINDS: &[&str] = &[
    "SettingsDialog",
    "SettingsTree",
    "SettingsPage",
    "SettingsGroup",
    "SettingRow",
    "ProblemRow",
    "SettingsNote",
    "SettingsEmpty",
    "SettingsPropose",
    "CheckRow",
    "SettingsFix",
];

/// px (DS `6-settings.css` `.vs-sd*`, the 2.1 boards' `.nv-t*`): the dialog 1040 × 700 (taller
/// while the tree needs it and the window has room: [`height`]), its
/// title 32, the tree 240 wide with 24 px rows, the crumb 44, the page's padding 24, a row 28
/// with its label column (168 px, wider as a page's longest label needs: [`label_column`]), a
/// caption 20, the footer 52.
pub const WIDTH: f32 = 1040.;
pub const HEIGHT: f32 = 700.;
const TITLE_H: f32 = look::POPUP_TITLE_HEIGHT;
const SIDE_W: f32 = 240.;
const NODE_H: f32 = 24.;
const CRUMBS_H: f32 = 44.;
const PAGE_PAD_X: f32 = 24.;
const ROW_H: f32 = 28.;
const LABEL_W: f32 = 168.;
/// The widest a page's label column grows; a longer label ellipsises past it.
const LABEL_MAX_W: f32 = 280.;
const COL_GAP: f32 = 12.;
const LINE_H: f32 = 24.;
const CAPTION_H: f32 = 20.;
const FOOT_H: f32 = 52.;
const CONTROL_H: f32 = 24.;
const HELP_LINE_H: f32 = 16.;
/// A combo is as wide as its value (`.vs-sd-combo` `min-width: 180px`), up to 360: its
/// padding 8 + 4, the gap 6 before the chevron, the border.
const COMBO_W: f32 = 180.;
const COMBO_MAX_W: f32 = 360.;
const COMBO_CHROME_W: f32 = 8. + 4. + 6. + look::ICON_SIZE + 2.;
const LIST_W: f32 = 220.;
/// S-Propose's popup: 480 wide, its label column 96 (`.vs-flow__grid`).
const PROPOSE_W: f32 = 480.;
const PROPOSE_LABEL_W: f32 = 96.;
/// Over every other deferred overlay of the window (popups 2, a card dialog, the flow dialogs 3).
pub const PRIORITY: usize = 10;

/// A combo's width for `value` ([`COMBO_W`]).
fn combo_width(value: &str, drawn: &Drawn, cx: &mut App) -> f32 {
    (text_width(value, drawn, cx) + COMBO_CHROME_W)
        .ceil()
        .clamp(COMBO_W, COMBO_MAX_W)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Dim,
    Warn,
    Bad,
    Accent,
    Link,
}

fn tone(t: Option<Tone>) -> Rgba {
    match t {
        None | Some(Tone::Dim) => look::TEXT_DIM.rgba(),
        Some(Tone::Warn) => look::TEXT_WARNING.rgba(),
        Some(Tone::Bad) => look::TEXT_ERROR.rgba(),
        Some(Tone::Accent) => look::ABE_ACCENT.rgba(),
        Some(Tone::Link) => look::LINK.rgba(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Focus {
    Tree,
    Page,
    Search,
    /// The footer's Close.
    Close,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Button {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SearchProps {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogProps {
    pub title: String,
    pub search: SearchProps,
    pub note: String,
    #[serde(default)]
    pub note_tone: Option<Tone>,
    pub focus: Focus,
    /// ⌘A: the text of the field with the caret is selected.
    #[serde(default)]
    pub select_all: bool,
    /// ⌘Z's button in the footer once a change is saved: the last save taken back.
    #[serde(default)]
    pub undo: Option<Button>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fold {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Count {
    pub text: String,
    pub tone: Tone,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TreeRow {
    pub id: String,
    pub label: String,
    pub depth: u32,
    #[serde(default)]
    pub fold: Option<Fold>,
    #[serde(default)]
    pub count: Option<Count>,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub modified: bool,
    #[serde(default)]
    pub separator: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TreeProps {
    pub nodes: Vec<TreeRow>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PageProps {
    pub crumbs: Vec<String>,
    pub scope: String,
    #[serde(default)]
    pub reveal: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GroupProps {
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// Packed under the one before: no padding, no rule above it (Color scheme's token groups).
    #[serde(default)]
    pub tight: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Choice {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub greyed: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ComboOpen {
    pub choices: Vec<Choice>,
    pub cursor: usize,
    pub filter: String,
}

/// One item of a list setting (`ListItem`): its words, its detail dim after, greyed.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ListItem {
    pub text: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub off: bool,
}

/// An item typed in place: `at` its index, none a new one at the end.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ListField {
    pub at: Option<usize>,
    pub text: String,
}

/// A list's editor open (⏎): the cursor on an item, or on `+ Add` (the items' count).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ListOpen {
    pub cursor: usize,
    #[serde(default)]
    pub field: Option<ListField>,
}

/// A field's width by what it holds (`FieldSize`: WebStorm's number 72, short 120, free 240,
/// path 360); a field that names none is a free line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldSize {
    Number,
    Short,
    #[default]
    Free,
    Path,
}

impl FieldSize {
    pub fn width(self) -> f32 {
        match self {
            FieldSize::Number => 72.,
            FieldSize::Short => 120.,
            FieldSize::Free => 240.,
            FieldSize::Path => 360.,
        }
    }
}

/// A row's control (`SettingControl`); a later page adds a kind.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Control {
    Checkbox {
        on: bool,
        #[serde(default)]
        fixed: bool,
    },
    Combo {
        value: String,
        #[serde(default)]
        open: Option<ComboOpen>,
    },
    Segmented {
        choices: Vec<String>,
        on: String,
        #[serde(default)]
        editing: bool,
    },
    /// A text or number field; `size`: its width by what it holds, `unit` dim after it.
    Field {
        text: String,
        #[serde(default)]
        editing: bool,
        #[serde(default)]
        size: FieldSize,
        #[serde(default)]
        unit: Option<String>,
    },
    Value {
        text: String,
    },
    /// Appearance's theme list (T-Appearance): a preview cell per theme.
    Themes {
        themes: Vec<ThemeCell>,
        on: String,
        #[serde(default)]
        cursor: Option<usize>,
    },
    /// A colour token's swatch and hex (T-Colours); `editing`: a colour field.
    Colour {
        hex: String,
        #[serde(default)]
        editing: bool,
        #[serde(default)]
        text: Option<String>,
    },
    /// A list setting: chips while closed, one line per item with ↑ ↓ ✕ and `+ Add` while open;
    /// `browse`: its items are folders, `+ Add` has Choose….
    List {
        items: Vec<ListItem>,
        #[serde(default)]
        browse: Option<Button>,
        #[serde(default)]
        open: Option<ListOpen>,
    },
    /// A folder: its 360 field and Choose… (the system's folder panel).
    Path {
        text: String,
        #[serde(default)]
        editing: bool,
        browse: Button,
    },
    /// A token or password: `•` per character typed, never its text.
    Secret {
        set: bool,
        #[serde(default)]
        editing: bool,
        #[serde(default)]
        typed: Option<usize>,
    },
    /// Advanced: a value no plainer control holds, its JSON in a code field.
    Advanced {
        text: String,
        #[serde(default)]
        editing: bool,
    },
    /// A setting of records (`views`, `environments`): a header of its fields, a line of cells
    /// per record; `open`: the cursor's cell, typed in place or its list open.
    Records {
        columns: Vec<RecordColumn>,
        rows: Vec<Vec<String>>,
        #[serde(default)]
        open: Option<RecordsOpen>,
    },
    /// A kind a later page adds that this build does not know: the row draws, its value dim.
    #[serde(other)]
    Other,
}

/// A records control's field: its label over its cells, its share of the width, picked from a
/// list (a chevron in its cells).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RecordColumn {
    pub label: String,
    pub size: u32,
    #[serde(default)]
    pub pick: bool,
}

/// A cell typed in place.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RecordField {
    pub text: String,
}

/// A records editor open (⏎): the cursor's cell (`row` = the rows' count: `+ Add`), typed in
/// place or its choices' list open.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RecordsOpen {
    pub row: usize,
    pub col: usize,
    #[serde(default)]
    pub field: Option<RecordField>,
    #[serde(default)]
    pub pick: Option<ComboOpen>,
}

/// One theme's preview cell (`ThemeCell`): a mini window in its own colours.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ThemeCell {
    pub slug: String,
    pub name: String,
    pub source: String,
    pub colors: ThemeColors,
}

/// The colours a preview cell draws with, `#rrggbb`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub frame: String,
    pub panel: String,
    pub editor: String,
    pub text: String,
    pub dim: String,
    pub accent: String,
    pub selection: String,
    pub needs_you: String,
    pub good: String,
    pub border: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Source {
    pub text: String,
    #[serde(default)]
    pub tone: Option<Tone>,
    #[serde(default)]
    pub lock: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Reason {
    pub text: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct RowProps {
    pub label: String,
    pub control: Control,
    #[serde(default)]
    pub help: Option<String>,
    pub source: Source,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub focused: bool,
    /// `/` finds it on a page picked while searching: its label marked as a search match.
    #[serde(default)]
    pub hit: bool,
    /// Changed, its save not read back yet: the modified bar and label.
    #[serde(default)]
    pub changed: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub reason: Option<Reason>,
    /// The open pull request proposing it: `PR #14 open`, in the accent after the source.
    #[serde(default)]
    pub pr: Option<String>,
    /// Where a change of yours goes: `repo`, `yours`, `local`, a tag on the source line.
    #[serde(default)]
    pub scope: Option<String>,
    /// The built-in value, dim on the source line: `default 30`.
    #[serde(default, rename = "default")]
    pub default_value: Option<String>,
    /// Reset to default (⌫) while yours sets it.
    #[serde(default)]
    pub reset: Option<Button>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Way {
    pub label: String,
    #[serde(default)]
    pub tone: Option<Tone>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProblemProps {
    pub text: String,
    #[serde(rename = "where")]
    pub place: String,
    pub way: Way,
    /// An info row, not a problem (your Override).
    #[serde(default)]
    pub info: bool,
    #[serde(default)]
    pub focused: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct NoteProps {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct EmptyProps {
    pub title: String,
    #[serde(default)]
    pub line: Option<String>,
    #[serde(default)]
    pub action: Option<Button>,
}

/// Which part of the propose popup has the keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposeFocus {
    Value,
    Reason,
    Cancel,
    Open,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProposeValueKind {
    Pick,
    Toggle,
    Field,
    Fixed,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProposeValue {
    pub kind: ProposeValueKind,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProposeProps {
    pub title: String,
    pub label: String,
    pub value: ProposeValue,
    pub reason: Reason,
    pub focus: ProposeFocus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub busy: bool,
    #[serde(rename = "where")]
    pub where_: String,
    pub cancel: Button,
    pub open: Button,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CheckResult {
    pub text: String,
    #[serde(default)]
    pub tone: Option<Tone>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CheckProps {
    pub label: String,
    #[serde(default)]
    pub value: Option<String>,
    pub check: String,
    pub state: CheckResult,
    #[serde(default)]
    pub way: Option<String>,
    #[serde(default)]
    pub focused: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixProps {
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub state_tone: Option<Tone>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub command: String,
    pub note: String,
}

/// One part of the set, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Dialog(DialogProps),
    Tree(TreeProps),
    Page(PageProps),
    Group(GroupProps),
    Row(Box<RowProps>),
    Problem(ProblemProps),
    Note(NoteProps),
    Empty(EmptyProps),
    Propose(Box<ProposeProps>),
    Check(CheckProps),
    Fix(FixProps),
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
            "SettingsDialog" => Part::Dialog(Deserialize::deserialize(p)?),
            "SettingsTree" => Part::Tree(Deserialize::deserialize(p)?),
            "SettingsPage" => Part::Page(Deserialize::deserialize(p)?),
            "SettingsGroup" => Part::Group(Deserialize::deserialize(p)?),
            "SettingRow" => Part::Row(Box::new(Deserialize::deserialize(p)?)),
            "ProblemRow" => Part::Problem(Deserialize::deserialize(p)?),
            "SettingsNote" => Part::Note(Deserialize::deserialize(p)?),
            "SettingsEmpty" => Part::Empty(Deserialize::deserialize(p)?),
            "SettingsPropose" => Part::Propose(Box::new(Deserialize::deserialize(p)?)),
            "CheckRow" => Part::Check(Deserialize::deserialize(p)?),
            "SettingsFix" => Part::Fix(Deserialize::deserialize(p)?),
            _ => {
                return Err(D::Error::custom(format!("not a settings part: {kind}")));
            }
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Dialog(_) => "SettingsDialog",
            Part::Tree(_) => "SettingsTree",
            Part::Page(_) => "SettingsPage",
            Part::Group(_) => "SettingsGroup",
            Part::Row(_) => "SettingRow",
            Part::Problem(_) => "ProblemRow",
            Part::Note(_) => "SettingsNote",
            Part::Empty(_) => "SettingsEmpty",
            Part::Propose(_) => "SettingsPropose",
            Part::Check(_) => "CheckRow",
            Part::Fix(_) => "SettingsFix",
        }
    }
}

/// Whether a layer is the Settings dialog.
pub fn is_dialog(n: &Node) -> bool {
    matches!(n, Node::Settings { part, .. } if matches!(**part, Part::Dialog(_)))
}

/// The dialog's focus while it draws: the tree's and the buttons' selection look.
#[derive(Default)]
struct Drawing {
    focus: Option<Focus>,
    /// ⌘A: the field with the caret draws its text selected.
    select_all: bool,
    /// The tree's room in the dialog drawn ([`over`]), px.
    tree_room: f32,
    /// The page's label column drawn ([`label_column`]), px.
    label_w: f32,
    /// The page's room in the dialog drawn ([`over`]), px.
    page_room: f32,
}

impl Global for Drawing {}

/// Texts' widths measured (labels, combo values), by UI font family and text: the drawing
/// view's memory, gone with the dialog.
#[derive(Default)]
struct TextWidths(HashMap<SharedString, HashMap<String, f32>>);

/// A text's width in the UI font (measured once per family and text).
fn text_width(text: &str, drawn: &Drawn, cx: &mut App) -> f32 {
    text_width_at(text, look::UI_FONT_SIZE, drawn, cx)
}

/// A text's width in the UI font at `size` (measured once per family, size and text, while the
/// dialog shows).
fn text_width_at(text: &str, size: f32, drawn: &Drawn, cx: &mut App) -> f32 {
    let font = crate::render::ui_font();
    let key = if size == look::UI_FONT_SIZE {
        text.to_owned()
    } else {
        format!("{size}\u{0}{text}")
    };
    let widths = drawn.memory.kept::<TextWidths>("", "settings-text-widths");
    if let Some(&w) = widths
        .borrow()
        .0
        .get(&font.family)
        .and_then(|m| m.get(&key))
    {
        return w;
    }
    let ts = gpui_kit::WindowTextSystem::new(cx.text_system().clone());
    let family = font.family.clone();
    let w = crate::kit::width_in(&ts, text, font, px(size)).as_f32();
    widths
        .borrow_mut()
        .0
        .entry(family)
        .or_default()
        .insert(key, w);
    w
}

/// The labels in a page's column: its rows' (a checkbox's is beside its box) and its checks'.
fn column_labels<'a>(nodes: &'a [Node], out: &mut Vec<&'a str>) {
    for n in nodes {
        if let Node::Settings { part, children, .. } = n {
            match &**part {
                Part::Row(r) if !matches!(r.control, Control::Checkbox { .. }) => {
                    out.push(&r.label)
                }
                Part::Check(c) => out.push(&c.label),
                _ => {}
            }
            column_labels(children, out);
        }
    }
}

/// A page's label column (as WebStorm's settings forms size theirs): its longest label
/// whole, never under the design's 168 nor over [`LABEL_MAX_W`] (nor 40 % of a narrow window's
/// page); one column for the whole page so every control starts at the same x. 2 px over the
/// text: a search hit's 1 px padding each side.
fn label_column(children: &[Node], drawn: &Drawn, cx: &mut App) -> f32 {
    let room = cx.default_global::<Drawing>().page_room;
    let max = if room > 0. {
        (room * 0.4).clamp(LABEL_W, LABEL_MAX_W)
    } else {
        LABEL_MAX_W
    };
    let mut labels = Vec::new();
    column_labels(children, &mut labels);
    let widest = labels
        .into_iter()
        .map(|l| text_width(l, drawn, cx))
        .fold(0., f32::max);
    (widest + 2.).ceil().clamp(LABEL_W, max)
}

/// A field's text before its caret; `selected`: the caret is there and ⌘A selected it.
fn field_text(text: &str, selected: bool) -> AnyElement {
    let selected = selected && !text.is_empty();
    div()
        .flex_none()
        .when(selected, |d| {
            d.debug_selector(|| "factory-settings-selection".into())
                .bg(look::FIELD_SELECTION_BG)
        })
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

/// A row's label; a search's hit on a picked page marked as IntelliJ marks a match.
fn label_text(text: &str, color: Rgba, hit: bool) -> AnyElement {
    div()
        .min_w_0()
        .overflow_hidden()
        .text_ellipsis()
        .text_color(color)
        .when(hit, |d| {
            d.debug_selector(|| "factory-settings-hit".into())
                .px(px(1.))
                .rounded(px(look::SEARCH_MATCH_ARC))
                .bg(look::SEARCH_MATCH_BG)
                .text_color(look::SEARCH_MATCH_FG)
        })
        .child(select::text(text.to_owned()))
        .into_any_element()
}

/// The focused row's id and how tall it is drawn (open, refused, asking its reason): a change of
/// either reveals its group again.
fn focused_key(children: &[Node]) -> String {
    children
        .iter()
        .find_map(|c| match c {
            Node::Settings { part, id, children } => match &**part {
                Part::Row(r) if r.focused => {
                    let open = match &r.control {
                        Control::Combo { open, .. } => open.is_some(),
                        Control::List { open, .. } => open.is_some(),
                        Control::Records { open, .. } => open.is_some(),
                        _ => false,
                    };
                    Some(format!(
                        "{}:{open}:{}:{}",
                        id.as_deref().unwrap_or(""),
                        r.error.is_some(),
                        r.reason.is_some()
                    ))
                }
                _ => {
                    let k = focused_key(children);
                    (!k.is_empty()).then_some(k)
                }
            },
            _ => None,
        })
        .unwrap_or_default()
}

/// The page's scroll, kept across frames, and the reveal last applied.
#[derive(Default)]
struct Kept {
    scroll: ScrollHandle,
    revealed: Option<String>,
    /// A reveal asked before the scroll knew its children's places: asked again next frame.
    pending: bool,
}

pub fn part(
    id: Option<&str>,
    p: &Part,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    match p {
        Part::Dialog(d) => dialog(id, d, children, drawn, cx),
        Part::Tree(t) => tree(id, t, drawn, cx),
        Part::Page(pg) => page(id, pg, children, drawn, cx),
        Part::Group(g) => group(id, g, children, drawn, cx),
        Part::Row(r) => {
            let d = cx.default_global::<Drawing>();
            let (all, label_w) = (d.select_all, d.label_w.max(LABEL_W));
            let combo_w = match &r.control {
                Control::Combo { value, .. } => combo_width(value, drawn, cx),
                _ => COMBO_W,
            };
            row(id, r, all, label_w, combo_w, drawn)
        }
        Part::Problem(pr) => problem(id, pr, drawn),
        Part::Note(n) => note(id, n, drawn),
        Part::Empty(e) => empty(id, e, drawn),
        Part::Propose(pr) => {
            let all = cx.default_global::<Drawing>().select_all;
            propose(id, pr, all, drawn)
        }
        Part::Check(c) => {
            let label_w = cx.default_global::<Drawing>().label_w.max(LABEL_W);
            check_row(id, c, label_w, drawn)
        }
        Part::Fix(f) => fix_strip(id, f, children, drawn, cx),
    }
}

/// The dialog over the whole window, centred, modal: a scrim that takes the mouse under it, drawn
/// last. `top` is how far the view the layer is placed in starts below the window's top.
pub fn over(
    layer: &Node,
    viewport: (f32, f32),
    top: f32,
    text: &std::rc::Rc<select::TextSel>,
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let margin = look::POPUP_WINDOW_MARGIN;
    let w = WIDTH.min(viewport.0 - 2. * margin).max(320.);
    let h = height(layer, viewport.1);
    // the tree's room this frame, for its thumb before the scroll has been laid out once
    cx.default_global::<Drawing>().tree_room = h - CHROME_H - SEARCH_STRIP_H;
    cx.default_global::<Drawing>().page_room = w - SIDE_W - 2. * PAGE_PAD_X;
    let x = kit::centered(w, viewport.0);
    let y = kit::centered(h, viewport.1) - top;
    let el = node(layer, drawn, cx);
    let scrim = div()
        .id("factory-settings-scrim")
        .absolute()
        .left_0()
        .top(px(-top))
        .w(px(viewport.0))
        .h(px(viewport.1))
        .occlude()
        .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
            cx.stop_propagation()
        })
        .child(
            // a drag selects its words, a double-click a word, ⌘C copies them (`select.rs`)
            select::region(
                div()
                    .id("factory-settings-text")
                    .absolute()
                    .left(px(x))
                    .top(px(y + top))
                    .w(px(w))
                    .h(px(h)),
                text,
            )
            .child(el)
            .child(select::settled(text)),
        );
    deferred(scrim).with_priority(PRIORITY).into_any_element()
}

/// The room the dialog keeps from the window's top and bottom when it grows past [`HEIGHT`]
/// (design S-Look).
const GROW_MARGIN: f32 = 80.;
/// The tree's padding above its first row and below its last (`pt` / `pb`).
const TREE_PAD_TOP: f32 = 2.;
const TREE_PAD_BOTTOM: f32 = 8.;
/// A separator under a tree node: 1 px with 4 above and below.
const TREE_SEPARATOR_H: f32 = 9.;
/// The search field's strip above the tree: the field and its 8 px padding.
const SEARCH_STRIP_H: f32 = CONTROL_H + 4. + 16.;

/// The tree's rows, separators and padding, unclipped.
fn tree_content_height(nodes: &[TreeRow]) -> f32 {
    let seps = nodes.iter().filter(|n| n.separator).count() as f32;
    TREE_PAD_TOP + nodes.len() as f32 * NODE_H + seps * TREE_SEPARATOR_H + TREE_PAD_BOTTOM
}

/// The dialog's height in a window `window_h` tall: the design's 700, grown until every
/// tree node shows (never closer than 80 to the window's top and bottom); a window too short for
/// that keeps 700 (or what fits) and the tree scrolls with its thumb showing.
pub fn height(layer: &Node, window_h: f32) -> f32 {
    let tree = match layer {
        Node::Settings { children, .. } => children.iter().find_map(|c| match c {
            Node::Settings { part, .. } => match &**part {
                Part::Tree(t) => Some(t),
                _ => None,
            },
            _ => None,
        }),
        _ => None,
    };
    let wanted = tree.map_or(HEIGHT, |t| {
        HEIGHT.max(CHROME_H + SEARCH_STRIP_H + tree_content_height(&t.nodes))
    });
    let fits = HEIGHT.min(window_h - 2. * look::POPUP_WINDOW_MARGIN);
    wanted
        .min((window_h - 2. * GROW_MARGIN).max(fits))
        .max(240.)
}

/// The dialog's height less the tree's room: the title and the footer (their rules inside their
/// heights, border-box), the frame's border.
const CHROME_H: f32 = TITLE_H + FOOT_H + 2.;

fn dialog(
    id: Option<&str>,
    p: &DialogProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    drawn.add("SettingsDialog", &p.title);
    drawn.add("SettingsFocus", format!("{:?}", p.focus).to_lowercase());
    cx.default_global::<Drawing>().focus = Some(p.focus);
    cx.default_global::<Drawing>().select_all = p.select_all;
    cx.default_global::<Drawing>().label_w = LABEL_W;
    let active = drawn.focused;
    let (side, rest): (Vec<&Node>, Vec<&Node>) = children
        .iter()
        .partition(|c| matches!(c, Node::Settings { part, .. } if matches!(**part, Part::Tree(_))));
    let (popups, pages): (Vec<&Node>, Vec<&Node>) = rest.into_iter().partition(
        |c| matches!(c, Node::Settings { part, .. } if matches!(**part, Part::Propose(_))),
    );
    let title = div()
        .flex_none()
        .relative()
        .h(px(TITLE_H))
        .flex()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::SEMIBOLD)
        .border_b_1()
        .border_color(look::SEPARATOR)
        .child(SharedString::from(p.title.clone()))
        .child(clickable(
            div()
                .id("factory-settings-close")
                .debug_selector(|| "factory-settings-close".into())
                .absolute()
                .right(px(6.))
                .top(px(4.))
                .size(px(24.))
                .rounded(px(look::ACTION_BUTTON_ARC))
                .flex()
                .items_center()
                .justify_center()
                .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
                .child(Icon::new(IconName::Close)),
            Some("settings:close"),
            drawn,
        ));
    let here = p.focus == Focus::Search;
    let search = search_field(&p.search.text, here && active, here && p.select_all, drawn);
    let tree: Vec<AnyElement> = side.iter().map(|c| node(c, drawn, cx)).collect();
    let side = div()
        .flex_none()
        .w(px(SIDE_W))
        .h_full()
        .flex()
        .flex_col()
        .bg(look::PANEL_BG)
        .border_r_1()
        .border_color(look::SEPARATOR)
        .child(div().flex_none().p(px(8.)).child(search))
        .children(tree);
    let page: Vec<AnyElement> = pages.iter().map(|c| node(c, drawn, cx)).collect();
    let body = div().flex_1().min_h_0().flex().child(side).child(
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .children(page),
    );
    drawn.add("SettingsNote", &p.note);
    let sink = drawn.sink.clone();
    let button = |label: &str, bid: &str, primary: bool, focused: bool| {
        let sink = sink.clone();
        let click = bid.to_owned();
        let b = TextButton::new(
            SharedString::from(format!("factory-{bid}")),
            label.to_owned(),
        )
        .primary(primary)
        .on_click(move |_, _, cx| {
            if let Some(sink) = &sink {
                sink.send(UserInput::Click { id: click.clone() }, cx);
            }
        });
        div()
            .flex_none()
            .rounded(px(look::BUTTON_ARC + 2.))
            .border_2()
            .border_color(if focused {
                look::FOCUS_BORDER.into()
            } else {
                gpui_kit::transparent_black()
            })
            .child(b)
    };
    let foot = div()
        .debug_selector(|| "factory-settings-footer".into())
        .flex_none()
        .h(px(FOOT_H))
        .pl(px(12.))
        .pr(px(16.))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_t_1()
        .border_color(look::SEPARATOR)
        .child(
            div()
                .flex_none()
                .size(px(24.))
                .rounded_full()
                .border_1()
                .border_color(look::BUTTON_BORDER)
                .flex()
                .items_center()
                .justify_center()
                .child(Icon::new(IconName::Help)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(tone(p.note_tone))
                .child(SharedString::from(p.note.clone())),
        )
        .when_some(p.undo.as_ref(), |d, u| {
            drawn.add("SettingsUndo", &u.label);
            d.child(button(&u.label, &u.id, false, false))
        })
        .child(button(
            "Close",
            "settings:close",
            false,
            p.focus == Focus::Close && active,
        ));
    let popups: Vec<AnyElement> = popups.iter().map(|c| node(c, drawn, cx)).collect();
    let d = kit::popup_frame()
        .id(SharedString::from(
            id.map_or_else(|| "settings".to_owned(), str::to_owned),
        ))
        .debug_selector(|| "factory-settings".into())
        .relative()
        .size_full()
        .child(title)
        .child(body)
        .child(foot)
        .children(popups.into_iter().map(|a| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui_kit::rgba(0x00000040))
                .child(a)
        }));
    d.into_any_element()
}

/// The search field; `focused`: the caret drawn; `selected`: its text selected by ⌘A.
fn search_field(text: &str, focused: bool, selected: bool, drawn: &mut Drawn) -> AnyElement {
    drawn.add("SettingsSearch", text);
    let typed = !text.is_empty();
    let d = div()
        .id("factory-settings-search")
        .debug_selector(|| "factory-settings-search".into())
        .h(px(CONTROL_H + 4.))
        .px(px(6.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(look::FIELD_ARC))
        .bg(look::FIELD_BG)
        .border_1()
        .border_color(if focused {
            look::FOCUS_BORDER
        } else {
            look::FIELD_BORDER
        })
        .child(Icon::new(IconName::Search))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .flex()
                .items_center()
                .when(typed, |d| d.child(field_text(text, selected)))
                .when(!typed && !focused, |d| {
                    d.text_color(look::TEXT_DIM)
                        .child(SharedString::from("Search settings"))
                })
                .when(focused, |d| d.child(caret())),
        )
        .when(!typed, |d| d.child(key_chip("/")));
    clickable(d, Some("settings:search"), drawn).into_any_element()
}

fn caret() -> AnyElement {
    div()
        .debug_selector(|| "factory-settings-caret".into())
        .flex_none()
        .w(px(look::CARET_WIDTH))
        .h(px(look::UI_FONT_SIZE + 3.))
        .bg(look::CARET)
        .into_any_element()
}

/// A key as a small outlined chip (`.nv-tkey`).
fn key_chip(k: &str) -> AnyElement {
    div()
        .flex_none()
        .min_w(px(18.))
        .h(px(18.))
        .px(px(4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(look::FIELD_ARC))
        .border_1()
        .border_color(look::FIELD_BORDER)
        .text_size(px(11.))
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(k.to_owned()))
        .into_any_element()
}

fn tree(id: Option<&str>, p: &TreeProps, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    let focus = cx.default_global::<Drawing>().focus;
    let active = drawn.focused && focus == Some(Focus::Tree);
    let rows: Vec<AnyElement> = p
        .nodes
        .iter()
        .map(|r| {
            drawn.add("SettingsTreeRow", &r.label);
            if r.selected {
                drawn.add(
                    "SettingsTreeSelected",
                    format!("{} {}", r.label, if active { "active" } else { "inactive" }),
                );
            }
            if let Some(c) = &r.count {
                drawn.add("SettingsTreeCount", format!("{} {}", r.label, c.text));
            }
            let color = if r.selected && active {
                look::SELECTION_TEXT
            } else if r.dim {
                look::TEXT_DIM
            } else if r.modified {
                look::LINK
            } else {
                look::TEXT
            };
            let chevron = match r.fold {
                Some(Fold::Open) => Icon::new(IconName::ChevronDown).into_any_element(),
                Some(Fold::Closed) => Icon::new(IconName::ChevronRight).into_any_element(),
                None => div()
                    .flex_none()
                    .size(px(look::ICON_SIZE))
                    .into_any_element(),
            };
            let sel = selector("SettingsTreeRow", 0, Some(&r.id));
            let d = div()
                .id(SharedString::from(sel.clone()))
                .debug_selector(move || sel.clone())
                .flex_none()
                .h(px(NODE_H))
                .mx(px(8.))
                .pl(px(4. + r.depth as f32 * look::TREE_INDENT))
                .pr(px(8.))
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(look::SELECTION_ARC))
                .whitespace_nowrap()
                .text_color(color)
                .when(r.selected, |d| {
                    d.bg(if active {
                        look::SELECTION_BG
                    } else {
                        look::SELECTION_BG_INACTIVE
                    })
                })
                .when(!r.selected, |d| d.hover(|s| s.bg(look::HOVER_BG)))
                .child(chevron)
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(SharedString::from(r.label.clone())),
                )
                .when_some(r.count.as_ref(), |d, c| {
                    d.child(
                        div()
                            .flex_none()
                            .ml(px(4.))
                            .text_color(if r.selected && active {
                                look::SELECTION_TEXT.rgba()
                            } else {
                                match c.tone {
                                    Tone::Warn => look::TEXT_WARNING.rgba(),
                                    t => tone(Some(t)),
                                }
                            })
                            .when(c.tone != Tone::Warn, |d| {
                                d.text_size(px(look::UI_SMALL_FONT_SIZE))
                            })
                            .child(SharedString::from(c.text.clone())),
                    )
                });
            let el = clickable(d, Some(&r.id), drawn).into_any_element();
            if r.separator {
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .child(el)
                    .child(
                        div()
                            .flex_none()
                            .h(px(1.))
                            .mx(px(16.))
                            .my(px(4.))
                            .bg(look::SEPARATOR),
                    )
                    .into_any_element()
            } else {
                el
            }
        })
        .collect();
    // the selected node kept in view as the keys move it (the tree keeps its own scroll)
    let selected = p.nodes.iter().find(|n| n.selected).map(|n| n.id.clone());
    let scroll = {
        let kept = drawn.memory.kept::<Kept>(id.unwrap_or("settings:tree"), "");
        let mut kept = kept.borrow_mut();
        if kept.revealed != selected {
            kept.pending = true;
        }
        kept.revealed = selected.clone();
        let scroll = kept.scroll.clone();
        if kept.pending
            && let Some(at) = p.nodes.iter().position(|n| n.selected)
        {
            scroll.scroll_to_item(at);
            // laid out once: its children's places are known, the reveal holds
            kept.pending = scroll.bounds().size.height <= px(0.);
        }
        scroll
    };
    // more rows than room: a thumb always shows, placed by the last frame's scroll (the
    // dialog's own sum on the first frame)
    let laid = scroll.bounds().size.height.as_f32();
    let view = if laid > 0. {
        laid
    } else {
        cx.default_global::<Drawing>().tree_room
    };
    let content = tree_content_height(&p.nodes);
    let thumb = (view > 0. && content > view + 0.5).then(|| {
        let h = (view * view / content).max(TREE_THUMB_MIN).min(view);
        let top = -scroll.offset().y.as_f32();
        let y = (top / (content - view) * (view - h)).clamp(0., view - h);
        drawn.add("SettingsTreeThumb", format!("{y:.0} {h:.0}"));
        div()
            .debug_selector(|| "factory-settings-tree-thumb".into())
            .absolute()
            .top(px(y))
            .right(px(TREE_THUMB_INSET))
            .w(px(TREE_THUMB_W))
            .h(px(h))
            .rounded(px(TREE_THUMB_W / 2.))
            .bg(look::SCROLLBAR_THUMB)
    });
    div()
        .flex_1()
        .min_h_0()
        .relative()
        .child(
            div()
                .id(SharedString::from(
                    id.map_or_else(|| "settings-tree".to_owned(), str::to_owned),
                ))
                .size_full()
                .flex()
                .flex_col()
                .pt(px(TREE_PAD_TOP))
                .pb(px(TREE_PAD_BOTTOM))
                .overflow_y_scroll()
                .track_scroll(&scroll)
                .children(rows),
        )
        .children(thumb)
        .into_any_element()
}

/// The tree's thumb: the mac overlay scrollbar's (as the Project tree's).
const TREE_THUMB_W: f32 = 7.;
const TREE_THUMB_INSET: f32 = 3.;
const TREE_THUMB_MIN: f32 = 24.;

fn page(
    id: Option<&str>,
    p: &PageProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    drawn.add("SettingsCrumb", p.crumbs.join(" › "));
    drawn.add("SettingsScope", &p.scope);
    // each page keeps its own scroll (the results theirs)
    // revealed again when the focused row moves or grows (opened, refused) inside its group, so
    // the lines under it stay in view
    let asked = p
        .reveal
        .as_ref()
        .map(|r| format!("{r}|{}", focused_key(children)));
    let (scroll, reveal) = {
        let kept = drawn
            .memory
            .kept::<Kept>(id.unwrap_or("settings:page"), &p.crumbs.join(" › "));
        let mut kept = kept.borrow_mut();
        let reveal = (kept.revealed != asked).then(|| p.reveal.clone()).flatten();
        kept.revealed = asked;
        (kept.scroll.clone(), reveal)
    };
    if let Some(at) = reveal.and_then(|r| children.iter().position(|c| c.id() == Some(r.as_str())))
    {
        scroll.scroll_to_item(at);
    }
    let last = p.crumbs.len().saturating_sub(1);
    let mut crumbs = div()
        .flex_none()
        .h(px(CRUMBS_H))
        .pl(px(PAGE_PAD_X))
        .pr(px(10.))
        .flex()
        .items_center()
        .gap(px(2.))
        .whitespace_nowrap();
    for (i, c) in p.crumbs.iter().enumerate() {
        if i > 0 {
            crumbs = crumbs.child(Icon::new(IconName::ChevronRight));
        }
        crumbs = crumbs.child(
            div()
                .when(i == last, |d| {
                    d.text_color(look::TEXT).font_weight(FontWeight::SEMIBOLD)
                })
                .when(i != last, |d| d.text_color(look::TEXT_DIM))
                .child(SharedString::from(c.clone())),
        );
    }
    crumbs = crumbs.child(
        div()
            .ml(px(10.))
            .min_w_0()
            .overflow_hidden()
            .text_ellipsis()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(p.scope.clone())),
    );
    cx.default_global::<Drawing>().label_w = label_column(children, drawn, cx);
    let first = children.first().and_then(Node::id).map(str::to_owned);
    let kids: Vec<AnyElement> = children
        .iter()
        .map(|c| {
            let el = node(c, drawn, cx);
            // the first group and a tight one have no rule above them
            let top = c.id().map(str::to_owned) == first;
            let tight = matches!(c, Node::Settings { part, .. }
                if matches!(&**part, Part::Group(g) if g.tight));
            div()
                .flex_none()
                .when(!top && !tight, |d| {
                    d.border_t_1().border_color(look::SEPARATOR)
                })
                .child(el)
                .into_any_element()
        })
        .collect();
    let content = div()
        .id(SharedString::from(format!(
            "{}-scroll",
            id.unwrap_or("settings-page")
        )))
        .size_full()
        .flex()
        .flex_col()
        .px(px(PAGE_PAD_X))
        .pb(px(12.))
        .overflow_y_scroll()
        .track_scroll(&scroll)
        .children(kids);
    let thumb = page_thumb(&scroll, drawn);
    // measured once laid out: a page that grew past its room gets its thumb the next frame
    let measured = scroll.clone();
    let measure = canvas(
        move |_, _, cx| {
            let now = (
                measured.bounds().size.height.as_f32().round(),
                measured.max_offset().y.as_f32().round(),
            );
            let was = &mut cx.default_global::<PageRoom>().0;
            if *was != now {
                *was = now;
                cx.defer(|cx| cx.refresh_windows());
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0();
    // a click on the page's empty room: an edit left (committed as ⏎ commits), a combo closed
    let page_id = id.unwrap_or("settings:page").to_owned();
    let sink = drawn.sink.clone();
    div()
        .debug_selector(|| "factory-settings-page".into())
        .size_full()
        .min_h_0()
        .flex()
        .flex_col()
        .when_some(sink, |d, sink| {
            d.on_mouse_down(gpui_kit::MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                sink.click(page_id.clone(), window, cx);
            })
        })
        .child(crumbs)
        .child(
            div()
                .flex_1()
                .min_h_0()
                .relative()
                .child(content)
                .children(thumb)
                .child(measure),
        )
        .into_any_element()
}

/// The page's room and how far it scrolls, as last laid out: a change draws again.
#[derive(Default)]
struct PageRoom((f32, f32));

impl Global for PageRoom {}

/// A page taller than its room: the tree's thumb at its right edge, placed by the last frame's
/// scroll, so it says there is more below (the wheel, ↓ and j move it).
fn page_thumb(scroll: &ScrollHandle, drawn: &mut Drawn) -> Option<gpui_kit::Div> {
    let view = scroll.bounds().size.height.as_f32();
    let more = scroll.max_offset().y.as_f32();
    (view > 0. && more > 0.5).then(|| {
        let content = view + more;
        let h = (view * view / content).max(TREE_THUMB_MIN).min(view);
        let top = -scroll.offset().y.as_f32();
        let y = (top / more * (view - h)).clamp(0., view - h);
        drawn.add("SettingsPageThumb", format!("{y:.0} {h:.0}"));
        div()
            .debug_selector(|| "factory-settings-page-thumb".into())
            .absolute()
            .top(px(y))
            .right(px(TREE_THUMB_INSET))
            .w(px(TREE_THUMB_W))
            .h(px(h))
            .rounded(px(TREE_THUMB_W / 2.))
            .bg(look::SCROLLBAR_THUMB)
    })
}

fn group(
    id: Option<&str>,
    p: &GroupProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    if let Some(c) = &p.caption {
        drawn.add("SettingsCaption", c);
    }
    // a Table fills its place: a group gives it the height of its header, rows and key line
    let rows: Vec<AnyElement> = children
        .iter()
        .map(|c| match c {
            Node::Table { props, .. } => {
                let foot = if props.foot.is_empty() {
                    0.
                } else {
                    super::table::FOOT_H
                };
                let h = super::table::HEAD_H
                    + super::table::ROW_H * props.rows.len().max(1) as f32
                    + foot;
                div()
                    .flex_none()
                    .h(px(h))
                    .child(node(c, drawn, cx))
                    .into_any_element()
            }
            _ => node(c, drawn, cx),
        })
        .collect();
    let sel = selector("SettingsGroup", 0, id);
    div()
        .debug_selector(move || sel)
        .flex()
        .flex_col()
        .when(!p.tight, |d| d.pt(px(8.)).pb(px(10.)))
        .when_some(p.caption.as_ref(), |d, c| {
            d.child(
                div()
                    .h(px(CAPTION_H))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .whitespace_nowrap()
                    .text_size(px(11.))
                    .text_color(look::TEXT_DIM)
                    .child(select::text(c.to_uppercase()))
                    .when_some(p.note.as_ref(), |d, n| {
                        d.child(
                            div()
                                .text_size(px(look::UI_SMALL_FONT_SIZE))
                                .child(select::text(n.clone())),
                        )
                    }),
            )
        })
        .children(rows)
        .into_any_element()
}

/// A focused line's wash: the inactive selection, 8 px past the text on both sides.
fn focus_wash<E: gpui_kit::Styled>(d: E, on: bool) -> E {
    if on {
        d.bg(look::SELECTION_BG_INACTIVE)
            .rounded(px(look::SELECTION_ARC))
            .mx(px(-8.))
            .px(px(8.))
    } else {
        d
    }
}

/// A part of row `row`'s control as its own hit area: its click names `<row id>:<part>` (`press`
/// the control, `choice:<i>` a segment or theme, `cell:<r>:<c>` a closed records' cell), so one
/// click acts on the control and focuses its row (`onClick` in the dialog's `settings-keys.ts`).
fn part_click<E: InteractiveElement + Styled>(
    d: E,
    row: Option<&str>,
    part: &str,
    drawn: &Drawn,
) -> E {
    let Some(row) = row else { return d };
    let id = format!("{row}:{part}");
    let sel = format!("factory-node-{id}");
    clickable(d.debug_selector(move || sel), Some(&id), drawn)
}

/// A setting row; `all`: ⌘A selected the text of its field with the caret.
/// `label_w`: the page's label column; `combo_w`: a combo's width ([`combo_width`]).
fn row(
    id: Option<&str>,
    p: &RowProps,
    all: bool,
    label_w: f32,
    combo_w: f32,
    drawn: &mut Drawn,
) -> AnyElement {
    drawn.add("SettingRow", &p.label);
    drawn.add("SettingSource", &p.source.text);
    if p.focused {
        drawn.add("SettingFocused", &p.label);
    }
    if p.changed {
        drawn.add("SettingChanged", &p.label);
    }
    if p.hit {
        drawn.add("SettingHit", &p.label);
    }
    let wide = matches!(p.control, Control::Checkbox { .. });
    let label_color = if p.error.is_some() {
        look::TEXT_ERROR
    } else if p.changed {
        look::LINK
    } else {
        look::TEXT
    };
    let control = control(
        id,
        &p.control,
        &p.label,
        label_color.rgba(),
        p.hit,
        all,
        combo_w,
        drawn,
    );
    // the control is its own hit area (segments and themes are each theirs, a value none): a
    // click on it acts at once, a click on the rest of the row only focuses it
    let pressable = !matches!(
        p.control,
        Control::Segmented { .. } | Control::Themes { .. } | Control::Value { .. } | Control::Other
    );
    let control = if pressable {
        let full = matches!(p.control, Control::Records { .. });
        let d = div()
            .min_w_0()
            .flex()
            .items_center()
            .when(full, |d| d.flex_1())
            .child(control);
        // an open list or records editor: its items, cells and buttons are its hit areas, a click
        // in a gap between them keeps it open (no part of its own to aim at)
        let editor = matches!(
            p.control,
            Control::List { open: Some(_), .. } | Control::Records { open: Some(_), .. }
        );
        match id {
            Some(row) if editor => {
                clickable(d, Some(&format!("{row}:press")), drawn).into_any_element()
            }
            _ => part_click(d, id, "press", drawn).into_any_element(),
        }
    } else {
        control
    };
    // compact (WebStorm's forms): the label and the control on one line; the help, the source
    // line and the hint dim under it only while the row is focused
    let line = div()
        .min_h(px(LINE_H))
        .min_w_0()
        .flex()
        .items_center()
        .whitespace_nowrap()
        .child(control);
    let help = p.help.as_ref().filter(|_| p.focused).map(|h| {
        let sel = format!("factory-settings-help:{}", p.label);
        div()
            .debug_selector(move || sel)
            // its words select (the dialog's region hears the press first), never the row's
            // click: a double-click on a word opens no combo
            .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
                cx.stop_propagation()
            })
            .min_w_0()
            .when(wide, |d| d.pl(px(look::CHECKBOX_SIZE + 6.)))
            .whitespace_normal()
            .line_clamp(2)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .line_height(px(HELP_LINE_H))
            .text_color(look::TEXT_DIM)
            .child(select::text(h.clone()))
    });
    // the focused row's hint at the source line's end: focus never moves a row's text
    let hint = p.hint.as_ref().map(|h| {
        drawn.add("SettingHint", h);
        div()
            .flex_none()
            .when(p.reset.is_none(), |d| d.ml_auto())
            .pl(px(8.))
            .whitespace_nowrap()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .line_height(px(16.))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(h.clone()))
    });
    let scope = p.scope.as_ref().map(|sc| {
        drawn.add("SettingScope", sc);
        let sel = format!("factory-settings-scope:{}", p.label);
        div()
            .debug_selector(move || sel)
            .flex_none()
            .h(px(14.))
            .px(px(4.))
            .flex()
            .items_center()
            .rounded(px(3.))
            .bg(look::TOOLTIP_BG)
            .text_size(px(look::UI_SMALL_FONT_SIZE - 1.))
            .line_height(px(14.))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(sc.clone()))
    });
    let default = p.default_value.as_ref().map(|d| {
        drawn.add("SettingDefault", d);
        // the first to give way on a narrow line: the source and the hint stay whole
        div()
            .min_w(px(48.))
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .line_height(px(16.))
            .text_color(look::TEXT_DISABLED)
            .child(select::text(format!("default {d}")))
    });
    let reset = p.reset.as_ref().map(|b| {
        drawn.add("SettingReset", &b.label);
        let sel = format!("factory-settings-reset:{}", p.label);
        clickable(
            div()
                .id(SharedString::from(sel.clone()))
                .debug_selector(move || sel)
                .flex_none()
                .ml_auto()
                .pl(px(8.))
                .flex()
                .items_center()
                .gap(px(2.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .line_height(px(16.))
                .text_color(look::LINK)
                .hover(|s| s.underline())
                .child(Icon::new(IconName::Revert).size(px(12.)))
                .child(SharedString::from(b.label.clone())),
            Some(&b.id),
            drawn,
        )
    });
    let source = div()
        .h(px(16.))
        .flex()
        .items_center()
        .gap(px(4.))
        .min_w_0()
        .when(wide, |d| d.pl(px(look::CHECKBOX_SIZE + 6.)))
        .children(scope)
        .when(p.source.lock, |d| {
            d.child(Icon::new(IconName::Locked).size(px(12.)))
        })
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                // a short source never gives way to the default after it
                .when(p.source.text.chars().count() <= 40, |d| d.flex_none())
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .line_height(px(16.))
                .text_color(tone(p.source.tone))
                .child(select::text(p.source.text.clone())),
        )
        .when_some(p.pr.as_ref(), |d, pr| {
            drawn.add("SettingPr", pr);
            d.child(
                div()
                    .flex_none()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .line_height(px(16.))
                    .text_color(look::ABE_ACCENT)
                    .child(select::text(pr.clone())),
            )
        })
        .children(default)
        .children(reset)
        .children(hint);
    let small = |text: &str, color: Rgba| {
        div()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .line_height(px(16.))
            .text_color(color)
            .child(SharedString::from(text.to_owned()))
    };
    let reason = p.reason.as_ref().map(|r| {
        drawn.add("SettingReason", &r.text);
        let field = div()
            .debug_selector(|| "factory-settings-reason".into())
            .w(px(320.))
            .h(px(CONTROL_H))
            .px(px(6.))
            .flex()
            .items_center()
            .rounded(px(look::FIELD_ARC))
            .bg(look::FIELD_BG)
            .border_1()
            .border_color(if r.error.is_some() {
                look::TEXT_ERROR
            } else {
                look::FOCUS_BORDER
            })
            .when(r.text.is_empty(), |d| {
                d.child(caret()).child(
                    div()
                        .ml(px(2.))
                        .text_color(look::TEXT_DIM)
                        .child("Reason (required)"),
                )
            })
            .when(!r.text.is_empty(), |d| {
                d.child(field_text(&r.text, all)).child(caret())
            });
        div()
            .mt(px(4.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(field)
            .when_some(r.error.as_ref(), |d, e| {
                drawn.add("SettingError", e);
                d.child(small(e, look::TEXT_ERROR.rgba()))
            })
    });
    if let Some(e) = &p.error {
        drawn.add("SettingError", e);
    }
    let error = p.error.as_ref().map(|e| {
        let sel = format!("factory-settings-error:{}", p.label);
        small(e, look::TEXT_ERROR.rgba()).debug_selector(move || sel)
    });
    let value = div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(line)
        .children(help)
        .when(p.focused, |d| d.child(source))
        .children(reason)
        .children(error);
    let label = (!wide).then(|| {
        let sel = format!("factory-settings-label:{}", p.label);
        div()
            .debug_selector(move || sel)
            .flex_none()
            .w(px(label_w))
            .line_height(px(LINE_H))
            .whitespace_nowrap()
            .flex()
            .child(label_text(&p.label, label_color.rgba(), p.hit))
    });
    let sel = selector("SettingRow", 0, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel.clone())
        .relative()
        .min_h(px(ROW_H))
        .py(px(1.))
        .flex()
        .items_start()
        .gap(px(COL_GAP))
        .children(label)
        .child(div().flex_1().min_w_0().child(value))
        .when(p.changed, |d| {
            d.child(
                div()
                    .absolute()
                    .left(px(if p.focused { -4. } else { -12. }))
                    .top(px(6.))
                    .w(px(2.))
                    .h(px(16.))
                    .rounded(px(1.))
                    .bg(if p.error.is_some() {
                        look::TEXT_ERROR
                    } else {
                        look::LINK
                    }),
            )
        });
    clickable(focus_wash(d, p.focused), id, drawn).into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn control(
    row: Option<&str>,
    c: &Control,
    label: &str,
    label_color: Rgba,
    hit: bool,
    all: bool,
    combo_w: f32,
    drawn: &mut Drawn,
) -> AnyElement {
    let boxed = |editing: bool| {
        div()
            .flex_none()
            .h(px(CONTROL_H))
            .flex()
            .items_center()
            .rounded(px(look::FIELD_ARC))
            .border_1()
            .border_color(if editing {
                look::FOCUS_BORDER
            } else {
                look::FIELD_BORDER
            })
    };
    match c {
        Control::Checkbox { on, fixed } => {
            drawn.add("SettingValue", if *on { "on" } else { "off" });
            let state = if *on {
                CheckState::Checked
            } else {
                CheckState::Unchecked
            };
            let icon = if *fixed {
                if *on {
                    IconName::CheckBoxSelectedDisabled
                } else {
                    IconName::CheckBoxDisabled
                }
            } else {
                checkbox_icon(state, false)
            };
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(check_box(icon))
                .child(label_text(label, label_color, hit))
                .into_any_element()
        }
        Control::Combo { value, open } => {
            drawn.add("SettingValue", value);
            let combo = boxed(open.is_some())
                .debug_selector(|| "factory-settings-combo".into())
                .w(px(combo_w))
                .pl(px(8.))
                .pr(px(4.))
                .justify_between()
                .gap(px(6.))
                .bg(look::FRAME_BG)
                .child(
                    div()
                        .debug_selector(|| "factory-settings-combo-value".into())
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(SharedString::from(value.clone())),
                )
                .child(Icon::new(IconName::ChevronDown));
            let list = open.as_ref().map(|o| combo_list(o, combo_w, drawn));
            div()
                .relative()
                .child(combo)
                .children(list)
                .into_any_element()
        }
        Control::Segmented {
            choices,
            on,
            editing,
        } => {
            drawn.add("SettingValue", on);
            let mut d = boxed(*editing).overflow_hidden();
            for (i, choice) in choices.iter().enumerate() {
                drawn.add("SettingChoice", choice);
                let picked = choice == on;
                let segment = div()
                    .h_full()
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .when(i > 0, |d| d.border_l_1().border_color(look::FIELD_BORDER))
                    .when(picked, |d| d.bg(look::SELECTION_BG_INACTIVE))
                    .when(!picked, |d| d.hover(|s| s.bg(look::HOVER_BG)))
                    .text_color(if picked { look::TEXT } else { look::TEXT_DIM })
                    .child(SharedString::from(choice.clone()));
                d = d.child(part_click(segment, row, &format!("choice:{i}"), drawn));
            }
            d.into_any_element()
        }
        Control::Field {
            text,
            editing,
            size,
            unit,
        } => {
            drawn.add("SettingValue", text);
            // its width is its kind's, editing or not: a row never reflows under the caret
            let sel = format!("factory-settings-field:{label}");
            // typed past its width, the text's end and the caret stay in view (its start goes
            // off the left, as WebStorm's fields scroll)
            let field = boxed(*editing)
                .debug_selector(move || sel)
                .w(px(size.width()))
                .px(px(6.))
                .bg(look::FIELD_BG)
                .overflow_hidden()
                .when(*editing, |d| d.justify_end())
                .child(
                    div()
                        .flex_none()
                        .min_w_full()
                        .flex()
                        .items_center()
                        .child(field_text(text, *editing && all))
                        .when(*editing, |d| d.child(caret())),
                );
            div()
                .debug_selector(|| "factory-settings-field".into())
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(field)
                .when_some(unit.as_ref(), |d, u| {
                    drawn.add("SettingUnit", u);
                    let sel = format!("factory-settings-unit:{label}");
                    d.child(
                        div()
                            .debug_selector(move || sel)
                            .flex_none()
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(u.clone())),
                    )
                })
                .into_any_element()
        }
        Control::Themes { themes, on, cursor } => {
            drawn.add("SettingValue", on);
            // one row of small cells; more themes than the row has room for go on under it
            div()
                .min_w_0()
                .flex()
                .flex_wrap()
                .gap(px(THEME_GAP))
                .children(themes.iter().enumerate().map(|(i, t)| {
                    let cell = theme_cell(t, t.slug == *on, *cursor == Some(i), drawn);
                    part_click(
                        div().flex_none().child(cell),
                        row,
                        &format!("choice:{i}"),
                        drawn,
                    )
                }))
                .into_any_element()
        }
        Control::Colour { hex, editing, text } => {
            drawn.add("SettingValue", hex);
            let swatch = div()
                .debug_selector(|| "factory-settings-swatch".into())
                .flex_none()
                .size(px(14.))
                .rounded(px(3.))
                .border_1()
                .border_color(look::FIELD_BORDER)
                .bg(hex_color(hex));
            let shown = text.clone().unwrap_or_else(|| hex.clone());
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(swatch)
                .child(
                    boxed(*editing)
                        .w(px(96.))
                        .px(px(6.))
                        .bg(look::FIELD_BG)
                        .font_family(EDITOR_FONT)
                        .child(field_text(&shown, *editing && all))
                        .when(*editing, |d| d.child(caret())),
                )
                .into_any_element()
        }
        Control::List {
            items,
            browse,
            open,
        } => list_control(items, browse.as_ref(), open.as_ref(), label, all, drawn),
        Control::Records {
            columns,
            rows,
            open,
        } => records_control(row, columns, rows, open.as_ref(), all, drawn),
        Control::Path {
            text,
            editing,
            browse,
        } => {
            drawn.add("SettingValue", text);
            let sel = format!("factory-settings-field:{label}");
            let field = boxed(*editing)
                .debug_selector(move || sel)
                .w(px(FieldSize::Path.width()))
                .pl(px(6.))
                .pr(px(2.))
                .bg(look::FIELD_BG)
                .overflow_hidden()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .flex()
                        .items_center()
                        .when(*editing, |d| d.justify_end())
                        .child(field_text(text, *editing && all))
                        .when(*editing, |d| d.child(caret())),
                )
                .child(icon_button(
                    &browse.id,
                    &browse.label,
                    IconName::Folder,
                    drawn,
                ));
            div()
                .debug_selector(|| "factory-settings-path".into())
                .flex_none()
                .child(field)
                .into_any_element()
        }
        Control::Secret {
            set,
            editing,
            typed,
        } => {
            // never the secret's text: a dot per character typed, eight for one set
            let dots = if *editing {
                "•".repeat(typed.unwrap_or(0))
            } else if *set {
                "•".repeat(8)
            } else {
                String::new()
            };
            drawn.add("SettingValue", &dots);
            let sel = format!("factory-settings-field:{label}");
            boxed(*editing)
                .debug_selector(move || sel)
                .w(px(FieldSize::Free.width()))
                .px(px(6.))
                .bg(look::FIELD_BG)
                .overflow_hidden()
                .when(!*editing && !*set, |d| {
                    d.child(div().text_color(look::TEXT_DISABLED).child("not set"))
                })
                .when(!dots.is_empty(), |d| {
                    d.child(field_text(&dots, *editing && all))
                })
                .when(*editing, |d| d.child(caret()))
                .into_any_element()
        }
        Control::Advanced { text, editing } => {
            drawn.add("SettingValue", text);
            let sel = format!("factory-settings-field:{label}");
            let field = boxed(*editing)
                .debug_selector(move || sel)
                .w(px(FieldSize::Path.width()))
                .px(px(6.))
                .bg(look::FIELD_BG)
                .overflow_hidden()
                .font_family(EDITOR_FONT)
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .when(*editing, |d| d.justify_end())
                .child(
                    div()
                        .flex_none()
                        .min_w_full()
                        .flex()
                        .items_center()
                        .child(field_text(text, *editing && all))
                        .when(*editing, |d| d.child(caret())),
                );
            drawn.add("SettingTag", "Advanced");
            div()
                .debug_selector(|| "factory-settings-advanced".into())
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(field)
                .child(
                    div()
                        .flex_none()
                        .h(px(16.))
                        .px(px(4.))
                        .flex()
                        .items_center()
                        .rounded(px(3.))
                        .border_1()
                        .border_color(look::FIELD_BORDER)
                        .text_size(px(look::UI_SMALL_FONT_SIZE - 1.))
                        .text_color(look::TEXT_DIM)
                        .child("Advanced · JSON"),
                )
                .into_any_element()
        }
        Control::Other => {
            drawn.add("SettingValue", "");
            div()
                .text_color(look::TEXT_DIM)
                .child("needs a newer VimStorm")
                .into_any_element()
        }
        Control::Value { text } => {
            drawn.add("SettingValue", text);
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .child(SharedString::from(text.clone()))
                .into_any_element()
        }
    }
}

/// A list's editor and a list item line's height.
const ITEM_H: f32 = 22.;

/// A small icon button (a list item's ↑ ↓ ✕, a folder's Choose…): its click names `id`.
fn icon_button(id: &str, label: &str, icon: IconName, drawn: &mut Drawn) -> AnyElement {
    drawn.add("SettingButton", label);
    let sel = format!("factory-settings-button:{id}");
    clickable(
        div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .flex_none()
            .size(px(18.))
            .rounded(px(look::ACTION_BUTTON_ARC))
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
            .child(Icon::new(icon).size(px(12.))),
        Some(id),
        drawn,
    )
    .into_any_element()
}

/// The chips a closed list shows (`—` for none).
fn chips(items: impl Iterator<Item = (String, bool)>) -> AnyElement {
    let chips: Vec<_> = items.collect();
    if chips.is_empty() {
        return div()
            .text_color(look::TEXT_DIM)
            .child("—")
            .into_any_element();
    }
    div()
        .flex()
        .flex_wrap()
        .gap(px(4.))
        .min_w_0()
        .children(chips.into_iter().map(|(text, off)| {
            div()
                .h(px(20.))
                .px(px(6.))
                .flex()
                .items_center()
                .rounded(px(look::FIELD_ARC))
                .bg(look::TOOLTIP_BG)
                .font_family(EDITOR_FONT)
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(if off { look::TEXT_DISABLED } else { look::TEXT })
                .when(off, |d| d.line_through())
                .child(SharedString::from(text))
        }))
        .into_any_element()
}

/// A list setting (`list`): chips while closed; open, its editor: a line per item (the cursor's
/// selected, its ↑ ↓ ✕ at the right), an item typed in place, then `+ Add` (Choose… for folders).
fn list_control(
    items: &[ListItem],
    browse: Option<&Button>,
    open: Option<&ListOpen>,
    label: &str,
    all: bool,
    drawn: &mut Drawn,
) -> AnyElement {
    drawn.add(
        "SettingValue",
        items
            .iter()
            .map(|i| i.text.as_str())
            .collect::<Vec<_>>()
            .join(", "),
    );
    let Some(open) = open else {
        return chips(items.iter().map(|i| (i.text.clone(), i.off)));
    };
    drawn.add("SettingListOpen", label);
    let field_at = open.field.as_ref().map(|f| f.at);
    let typed = |f: &ListField| {
        div()
            .debug_selector(|| "factory-settings-list-field".into())
            .h(px(ITEM_H))
            .mx(px(2.))
            .px(px(4.))
            .flex()
            .items_center()
            .rounded(px(look::FIELD_ARC))
            .border_1()
            .border_color(look::FOCUS_BORDER)
            .bg(look::FIELD_BG)
            .font_family(EDITOR_FONT)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(field_text(&f.text, all))
            .child(caret())
            .into_any_element()
    };
    let mut lines: Vec<AnyElement> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        drawn.add("SettingItem", &item.text);
        if field_at == Some(Some(i)) {
            if let Some(f) = &open.field {
                lines.push(typed(f));
            }
            continue;
        }
        let on = open.cursor == i;
        let id = format!("settings:item:{i}");
        let sel = format!("factory-settings-item:{i}");
        let line = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .h(px(ITEM_H))
            .px(px(6.))
            .flex()
            .items_center()
            .gap(px(8.))
            .when(on, |d| d.bg(look::SELECTION_BG))
            .when(!on, |d| d.hover(|s| s.bg(look::HOVER_BG)))
            .child(
                div()
                    .flex_none()
                    .font_family(EDITOR_FONT)
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(if item.off {
                        look::TEXT_DISABLED
                    } else {
                        look::TEXT
                    })
                    .when(item.off, |d| d.line_through())
                    .child(SharedString::from(item.text.clone())),
            )
            .when_some(item.detail.as_ref(), |d, detail| {
                d.child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(detail.clone())),
                )
            });
        lines.push(clickable(line, Some(&id), drawn).into_any_element());
    }
    if field_at == Some(None) {
        if let Some(f) = &open.field {
            lines.push(typed(f));
        }
    } else {
        let on = open.cursor >= items.len();
        drawn.add("SettingItem", "+ Add");
        let add = div()
            .id("factory-settings-item-add")
            .debug_selector(|| "factory-settings-item-add".into())
            .h(px(ITEM_H))
            .px(px(6.))
            .flex()
            .items_center()
            .gap(px(4.))
            .when(on, |d| d.bg(look::SELECTION_BG))
            .when(!on, |d| d.hover(|s| s.bg(look::HOVER_BG)))
            .text_color(look::LINK)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(Icon::new(IconName::Add).size(px(12.)))
            .child("Add");
        lines.push(clickable(add, Some("settings:item-add"), drawn).into_any_element());
    }
    // WebStorm's list toolbar under it: + − ↑ ↓ on the cursor's item, Choose… for folders
    let at = (open.cursor < items.len()).then_some(open.cursor);
    let mut bar = div()
        .debug_selector(|| "factory-settings-list-bar".into())
        .h(px(ITEM_H))
        .px(px(2.))
        .flex()
        .items_center()
        .gap(px(2.))
        .border_t_1()
        .border_color(look::FIELD_BORDER)
        .child(icon_button(
            "settings:item-add",
            "Add",
            IconName::Add,
            drawn,
        ));
    if let Some(i) = at {
        bar = bar
            .child(icon_button(
                &format!("settings:item-remove:{i}"),
                "Remove",
                IconName::Delete,
                drawn,
            ))
            .child(icon_button(
                &format!("settings:item-up:{i}"),
                "Move up",
                IconName::ChevronUp,
                drawn,
            ))
            .child(icon_button(
                &format!("settings:item-down:{i}"),
                "Move down",
                IconName::ChevronDown,
                drawn,
            ));
    }
    if let Some(b) = browse {
        bar = bar.child(icon_button(&b.id, &b.label, IconName::Folder, drawn));
    }
    div()
        .debug_selector(|| "factory-settings-list".into())
        .flex_none()
        .w(px(FieldSize::Path.width()))
        .pt(px(2.))
        .flex()
        .flex_col()
        .rounded(px(look::FIELD_ARC))
        .border_1()
        .border_color(look::FOCUS_BORDER)
        .bg(look::FIELD_BG)
        .children(lines)
        .child(bar)
        .into_any_element()
}

/// A records line's and its header's height.
const CELL_H: f32 = 22.;
/// A record's ✕ at its line's end, and its header's room for it.
const REMOVE_W: f32 = 18.;

/// A records setting (`records`): its fields' labels, then a line of cells per record (each
/// field's share of the width); open, the cursor's cell has the focus border (`+ Add` after the
/// last record), typed in place or its list under it, each record's ✕ at its end.
fn records_control(
    row: Option<&str>,
    columns: &[RecordColumn],
    rows: &[Vec<String>],
    open: Option<&RecordsOpen>,
    all: bool,
    drawn: &mut Drawn,
) -> AnyElement {
    drawn.add(
        "SettingValue",
        rows.iter()
            .map(|r| r.join(" · "))
            .collect::<Vec<_>>()
            .join("; "),
    );
    if open.is_some() {
        drawn.add("SettingRecordsOpen", "");
    }
    let total = columns.iter().map(|c| c.size.max(1)).sum::<u32>().max(1) as f32;
    let share = |c: &RecordColumn| gpui_kit::relative(c.size.max(1) as f32 / total);
    let small = |d: gpui_kit::Div| d.text_size(px(look::UI_SMALL_FONT_SIZE));
    let header = div()
        .debug_selector(|| "factory-settings-records-head".into())
        .h(px(CELL_H - 4.))
        .flex()
        .items_center()
        .gap(px(4.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .children(columns.iter().map(|c| {
                    drawn.add("SettingColumn", &c.label);
                    small(
                        div()
                            .flex_none()
                            .w(share(c))
                            .px(px(5.))
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_color(look::TEXT_DIM),
                    )
                    .child(SharedString::from(c.label.clone()))
                })),
        )
        .when(open.is_some(), |d| {
            d.child(div().flex_none().w(px(REMOVE_W)))
        });
    let mut lines: Vec<AnyElement> = vec![header.into_any_element()];
    if rows.is_empty() && open.is_none() {
        lines.push(
            div()
                .h(px(CELL_H))
                .px(px(5.))
                .flex()
                .items_center()
                .text_color(look::TEXT_DIM)
                .child("—")
                .into_any_element(),
        );
    }
    for (r, cells) in rows.iter().enumerate() {
        let mut line = div().flex_1().min_w_0().flex().gap(px(0.));
        for (c, column) in columns.iter().enumerate() {
            let text = cells.get(c).cloned().unwrap_or_default();
            drawn.add("SettingCell", &text);
            let here = open.filter(|o| o.row == r && o.col == c);
            let field = here.and_then(|o| o.field.as_ref());
            let pick = here.and_then(|o| o.pick.as_ref());
            let sel = format!("factory-settings-cell:{r}:{c}");
            let shown = field.map_or_else(|| text.clone(), |f| f.text.clone());
            let empty = shown.is_empty() && field.is_none();
            let cell = div()
                .id(SharedString::from(sel.clone()))
                .debug_selector(move || sel)
                .relative()
                .h(px(CELL_H))
                .px(px(5.))
                .flex()
                .items_center()
                .gap(px(2.))
                .border_1()
                .rounded(px(look::FIELD_ARC))
                .border_color(if here.is_some() {
                    look::FOCUS_BORDER
                } else {
                    look::FIELD_BORDER
                })
                .bg(look::FIELD_BG)
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .overflow_hidden()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .flex()
                        .items_center()
                        .when(field.is_some(), |d| d.justify_end())
                        .when(empty, |d| {
                            d.text_color(look::TEXT_DISABLED)
                                .child(SharedString::from(column.label.to_lowercase()))
                        })
                        .when(!empty, |d| {
                            d.child(field_text(&shown, field.is_some() && all))
                        })
                        .when(field.is_some(), |d| d.child(caret())),
                )
                .when(column.pick, |d| {
                    d.child(Icon::new(IconName::ChevronDown).size(px(12.)))
                })
                .children(pick.map(|p| combo_list(p, 0., drawn)));
            let cell = if open.is_some() {
                let id = format!("settings:cell:{r}:{c}");
                clickable(cell, Some(&id), drawn).into_any_element()
            } else {
                cell.into_any_element()
            };
            let place = div().flex_none().w(share(column)).pr(px(2.)).child(cell);
            // closed, a cell's click opens the records on it, typed in
            line = line.child(if open.is_some() {
                place
            } else {
                part_click(place, row, &format!("cell:{r}:{c}"), drawn)
            });
        }
        lines.push(
            div()
                .h(px(CELL_H))
                .flex()
                .items_center()
                .gap(px(4.))
                .child(line)
                .when(open.is_some(), |d| {
                    d.child(icon_button(
                        &format!("settings:record-remove:{r}"),
                        "Remove",
                        IconName::Close,
                        drawn,
                    ))
                })
                .into_any_element(),
        );
    }
    if let Some(o) = open {
        let on = o.row >= rows.len();
        drawn.add("SettingCell", "+ Add");
        let add = div()
            .id("factory-settings-record-add")
            .debug_selector(|| "factory-settings-record-add".into())
            .h(px(CELL_H))
            .px(px(5.))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(look::FIELD_ARC))
            .when(on, |d| d.bg(look::SELECTION_BG))
            .when(!on, |d| d.hover(|s| s.bg(look::HOVER_BG)))
            .text_color(look::LINK)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(Icon::new(IconName::Add).size(px(12.)))
            .child("Add");
        lines.push(clickable(add, Some("settings:record-add"), drawn).into_any_element());
    }
    div()
        .debug_selector(|| "factory-settings-records".into())
        .w_full()
        .min_w_0()
        .py(px(1.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .children(lines)
        .into_any_element()
}

/// A click that opens the system's folder panel for a row (Choose…): the panel's pick is typed
/// into the field the click opened, then ⏎ (Esc when it is cancelled).
pub fn is_browse(id: &str) -> bool {
    id.starts_with("settings:browse:")
}

/// ⌘O on a focused folder row (a folder field, a list of folders): its Choose…'s click.
pub fn browse_key(layer: &Node, key: &str) -> Option<String> {
    fn walk(n: &Node) -> Option<String> {
        if let Node::Settings { part, .. } = n
            && let Part::Row(p) = &**part
            && p.focused
        {
            return match &p.control {
                Control::Path { browse, .. } => Some(browse.id.clone()),
                Control::List {
                    browse: Some(b), ..
                } => Some(b.id.clone()),
                _ => None,
            };
        }
        n.children().iter().find_map(walk)
    }
    (key == "<D-o>").then(|| walk(layer)).flatten()
}

const THEME_W: f32 = 128.;
const THEME_H: f32 = 80.;
const THEME_GAP: f32 = 12.;

/// `#rrggbb` or `#rrggbbaa` as a colour (a malformed one: transparent).
fn hex_color(s: &str) -> Rgba {
    let parsed = s
        .strip_prefix('#')
        .and_then(|h| u32::from_str_radix(h, 16).ok().map(|v| (v, h.len())));
    match parsed {
        Some((v, 6)) => look::hex(v),
        Some((v, 8)) => look::hexa(v),
        _ => gpui_kit::transparent_black().into(),
    }
}

/// A theme's preview cell (T-Appearance: small, one row of them as WebStorm's Theme combo
/// previews): a 128 × 80 mini window drawn in the theme's own colours (its toolbar band, a strip
/// tab, a card with a needs-you mark, the status bar), its name and source under it; the cursor's
/// cell is outlined in the focus colour, the theme shown in the selection.
fn theme_cell(t: &ThemeCell, on: bool, cursor: bool, drawn: &mut Drawn) -> AnyElement {
    drawn.add("ThemeCell", &t.name);
    if on {
        drawn.add("ThemeOn", &t.name);
    }
    if cursor {
        drawn.add("ThemeCursor", &t.name);
    }
    let c = &t.colors;
    let line = |w: f32, color: &str| {
        div()
            .h(px(3.))
            .w(px(w))
            .rounded(px(1.5))
            .bg(hex_color(color))
    };
    let mini = div()
        .debug_selector(|| format!("factory-theme-{}", t.slug))
        .w(px(THEME_W))
        .h(px(THEME_H))
        .flex()
        .flex_col()
        .rounded(px(look::FIELD_ARC + 2.))
        .overflow_hidden()
        .border_2()
        // the cursor's outline wins: it shows on the theme in force too
        .border_color(if cursor {
            look::FOCUS_BORDER.rgba()
        } else if on {
            look::SELECTION_BG.rgba()
        } else {
            hex_color(&c.border)
        })
        .bg(hex_color(&c.frame))
        // toolbar band, then the strip with one selected tab
        .child(div().h(px(8.)).flex_none())
        .child(
            div()
                .h(px(10.))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(3.))
                .px(px(4.))
                .child(
                    div()
                        .h(px(8.))
                        .w(px(30.))
                        .rounded(px(2.))
                        .bg(hex_color(&c.selection))
                        .flex()
                        .items_center()
                        .px(px(3.))
                        .child(line(18., &c.text)),
                )
                .child(line(16., &c.dim)),
        )
        // the island: a card with its needs-you edge, an editor of text lines
        .child(
            div()
                .flex_1()
                .mx(px(3.))
                .rounded(px(3.))
                .bg(hex_color(&c.panel))
                .flex()
                .gap(px(3.))
                .p(px(4.))
                .child(
                    div()
                        .w(px(40.))
                        .h(px(26.))
                        .rounded(px(2.))
                        .bg(hex_color(&c.frame))
                        .border_l_2()
                        .border_color(hex_color(&c.needs_you))
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .p(px(4.))
                        .child(line(26., &c.text))
                        .child(line(18., &c.dim))
                        .child(line(12., &c.good)),
                )
                .child(
                    div()
                        .flex_1()
                        .rounded(px(2.))
                        .bg(hex_color(&c.editor))
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .p(px(4.))
                        .child(line(34., &c.accent))
                        .child(line(46., &c.text))
                        .child(line(28., &c.dim)),
                ),
        )
        // the status bar: a needs-you count
        .child(
            div()
                .h(px(9.))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(3.))
                .px(px(4.))
                .child(
                    div()
                        .size(px(4.))
                        .rounded(px(2.))
                        .bg(hex_color(&c.needs_you)),
                )
                .child(line(14., &c.dim)),
        );
    div()
        .w(px(THEME_W))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(mini)
        .child(
            div()
                .mt(px(2.))
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(if on { look::TEXT } else { look::TEXT_DIM })
                .child(SharedString::from(t.name.clone())),
        )
        .child(
            div()
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(t.source.clone())),
        )
        .into_any_element()
}

/// A combo's open list under it, over the rows below (drawn after the dialog).
/// A combo's open list, at least as wide as its combo (`combo_w`) and [`LIST_W`].
fn combo_list(o: &ComboOpen, combo_w: f32, drawn: &mut Drawn) -> AnyElement {
    let rows: Vec<AnyElement> = o
        .choices
        .iter()
        .enumerate()
        .map(|(i, c)| {
            drawn.add("ComboChoice", &c.text);
            let at = i == o.cursor;
            if at {
                drawn.add("ComboCursor", &c.text);
            }
            let grey = c.greyed.is_some();
            let d = div()
                .id(SharedString::from(format!("factory-settings-choice-{i}")))
                .h(px(24.))
                .mx(px(6.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(look::LIST_SELECTION_ARC))
                .whitespace_nowrap()
                .when(at && !grey, |d| {
                    d.bg(look::SELECTION_BG).text_color(look::SELECTION_TEXT)
                })
                .when(grey, |d| d.text_color(look::TEXT_DISABLED))
                .child(
                    div()
                        .when(grey, |d| d.line_through())
                        .child(SharedString::from(c.text.clone())),
                )
                .when_some(c.greyed.as_ref(), |d, why| {
                    d.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .child(SharedString::from(why.clone())),
                    )
                });
            if grey {
                d.into_any_element()
            } else {
                clickable(d, Some(&c.id), drawn).into_any_element()
            }
        })
        .collect();
    let list = kit::popup_frame()
        .debug_selector(|| "factory-settings-combo-list".into())
        .min_w(px(LIST_W.max(combo_w)))
        .py(px(6.))
        .when(!o.filter.is_empty(), |d| {
            d.child(
                div()
                    .px(px(14.))
                    .pb(px(4.))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(o.filter.clone())),
            )
        })
        .children(rows);
    deferred(
        div()
            .absolute()
            .top(px(CONTROL_H + 2.))
            .left_0()
            .child(list),
    )
    .with_priority(PRIORITY + 1)
    .into_any_element()
}

fn problem(id: Option<&str>, p: &ProblemProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("ProblemRow", &p.text);
    drawn.add("ProblemWay", &p.way.label);
    if p.info {
        drawn.add("ProblemInfo", &p.text);
    }
    if p.focused {
        drawn.add("ProblemFocused", &p.text);
    }
    let sel = selector("ProblemRow", 0, id);
    let way = div()
        .flex_none()
        .h(px(look::BUTTON_HEIGHT))
        .px(px(look::BUTTON_PAD_X))
        .flex()
        .items_center()
        .gap(px(look::BUTTON_KEY_GAP))
        .rounded(px(look::BUTTON_ARC))
        .border_1()
        .border_color(look::BUTTON_BORDER)
        .text_color(match p.way.tone {
            Some(Tone::Warn) => look::ABE_WARN,
            _ => look::BUTTON_FG,
        })
        .child(SharedString::from(p.way.label.clone()))
        .child(
            div()
                .opacity(look::BUTTON_KEY_OPACITY)
                .child(SharedString::from("⏎")),
        );
    let way = part_click(way, id, "press", drawn);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel.clone())
        .py(px(10.))
        .flex()
        .items_center()
        .gap(px(10.))
        .border_b_1()
        .border_color(if p.focused {
            gpui_kit::transparent_black()
        } else {
            look::SEPARATOR.into()
        })
        .child(div().flex_none().self_start().child(Icon::new(if p.info {
            IconName::Info
        } else {
            IconName::Warning
        })))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(div().child(select::text(p.text.clone())))
                .child(
                    div()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .line_height(px(18.))
                        .text_color(look::TEXT_DIM)
                        .child(select::text(p.place.clone())),
                ),
        )
        .child(way);
    clickable(focus_wash(d, p.focused), id, drawn).into_any_element()
}

/// A check's value column: a version, or the account a login works as (`octo@example.com`).
const CHECK_VALUE_W: f32 = 160.;

/// A check's state at most: a long error (`⚠ can't check: …`) ends in `…` inside the page and
/// leaves the check its room.
const CHECK_STATE_MAX_W: f32 = 260.;

/// A login or a tool on Logins & tools (S-Logins): the name, what the check found, the check as it
/// runs (dim), then `✓ OK` or the problem in warn and `fix… ⏎`.
/// `label_w`: the page's label column.
fn check_row(id: Option<&str>, p: &CheckProps, label_w: f32, drawn: &mut Drawn) -> AnyElement {
    drawn.add("CheckRow", &p.label);
    drawn.add("CheckState", &p.state.text);
    if let Some(v) = &p.value {
        drawn.add("CheckValue", v);
    }
    if let Some(w) = &p.way {
        drawn.add("CheckWay", w);
    }
    if p.focused {
        drawn.add("CheckFocused", &p.label);
    }
    let sel = selector("CheckRow", 0, id);
    let way = p.way.as_ref().map(|w| {
        div()
            .flex_none()
            .h(px(look::BUTTON_HEIGHT))
            .px(px(look::BUTTON_PAD_X))
            .flex()
            .items_center()
            .gap(px(look::BUTTON_KEY_GAP))
            .rounded(px(look::BUTTON_ARC))
            .border_1()
            .border_color(look::BUTTON_BORDER)
            .text_color(look::ABE_WARN)
            .child(SharedString::from(w.clone()))
            .child(
                div()
                    .opacity(look::BUTTON_KEY_OPACITY)
                    .child(SharedString::from("⏎")),
            )
    });
    let way = way.map(|w| part_click(w, id, "press", drawn));
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel.clone())
        .h(px(ROW_H + 8.))
        .flex()
        .items_center()
        .gap(px(COL_GAP))
        .child({
            let sel = format!("factory-settings-label:{}", p.label);
            div()
                .debug_selector(move || sel)
                .flex_none()
                .w(px(label_w))
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(select::text(p.label.clone()))
        })
        // what it found: a version, who a login is signed in as
        .child(
            div()
                .flex_none()
                .w(px(CHECK_VALUE_W))
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(look::TEXT_DIM)
                .child(select::text(p.value.clone().unwrap_or_default())),
        )
        .child({
            let sel = format!("factory-settings-check:{}", p.label);
            div()
                .debug_selector(move || sel)
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .font_family(EDITOR_FONT)
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(select::text(p.check.clone()))
        })
        .child({
            let sel = format!("factory-settings-check-state:{}", p.label);
            div()
                .debug_selector(move || sel)
                .flex_none()
                .max_w(px(CHECK_STATE_MAX_W))
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(match p.state.tone {
                    Some(Tone::Warn) => look::ABE_WARN.rgba(),
                    None => look::TEXT.rgba(),
                    t => tone(t),
                })
                .child(select::text(p.state.text.clone()))
        })
        .children(way);
    clickable(focus_wash(d, p.focused), id, drawn).into_any_element()
}

/// The fix strip under the page (S-Logins): `fix · AWS SSO` and its state, the folder, the
/// command as typed (dim mono), the note; its Terminal child under them once it runs.
fn fix_strip(
    id: Option<&str>,
    p: &FixProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    drawn.add("SettingsFix", format!("{} · {}", p.title, p.state));
    drawn.add("FixCommand", &p.command);
    let sel = selector("SettingsFix", 0, id);
    let terms: Vec<AnyElement> = children.iter().map(|c| node(c, drawn, cx)).collect();
    let running = !terms.is_empty();
    div()
        .debug_selector(move || sel)
        .flex_none()
        .when(running, |d| d.h(px(220.)))
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(look::SEPARATOR)
        .bg(look::PANEL_BG)
        .child(
            div()
                .flex_none()
                .h(px(28.))
                .px(px(PAGE_PAD_X))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(SharedString::from(p.title.clone())),
                )
                .child(
                    div()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(tone(p.state_tone))
                        .child(SharedString::from(p.state.clone())),
                )
                .child(div().flex_1())
                .children(p.cwd.as_ref().map(|c| {
                    div()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(c.clone()))
                })),
        )
        .when(!running, |d| {
            d.child(
                div()
                    .flex_none()
                    .px(px(PAGE_PAD_X))
                    .pb(px(4.))
                    .font_family(EDITOR_FONT)
                    .child(SharedString::from(p.command.clone())),
            )
        })
        .children(
            terms
                .into_iter()
                .map(|t| div().flex_1().min_h_0().px(px(8.)).child(t)),
        )
        .child(
            div()
                .flex_none()
                .px(px(PAGE_PAD_X))
                .pb(px(8.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(p.note.clone())),
        )
        .into_any_element()
}

fn note(id: Option<&str>, p: &NoteProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("SettingsPageNote", &p.text);
    let sel = selector("SettingsNote", 0, id);
    div()
        .debug_selector(move || sel)
        .pt(px(12.))
        .pl(px(26.))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(select::text(p.text.clone()))
        .into_any_element()
}

fn empty(id: Option<&str>, p: &EmptyProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("SettingsEmpty", &p.title);
    let sel = selector("SettingsEmpty", 0, id);
    let action = p.action.as_ref().map(|b| {
        drawn.add("SettingsButton", &b.label);
        let sink = drawn.sink.clone();
        let click = b.id.clone();
        TextButton::new(
            SharedString::from(format!("factory-{}", b.id)),
            b.label.clone(),
        )
        .on_click(move |_, _, cx| {
            if let Some(sink) = &sink {
                sink.send(UserInput::Click { id: click.clone() }, cx);
            }
        })
    });
    div()
        .debug_selector(move || sel)
        .min_h(px(320.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .p(px(24.))
        .text_color(look::TEXT_DIM)
        .child(select::text(p.title.clone()))
        .when_some(p.line.as_ref(), |d, l| {
            d.child(
                div()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .child(select::text(l.clone())),
            )
        })
        .when_some(action, |d, a| d.child(div().mt(px(8.)).child(a)))
        .into_any_element()
}

/// ⌘⏎'s popup (S-Propose): `Propose for repo acme/demo-shop`, the setting's value now (dim) → the
/// one proposed, the reason (required), a refusal in bad, Cancel · Open pull request ⏎, and dim
/// under it where the pull request opens. A click on the value or the
/// reason gives it the keys (`<id>:value`, `<id>:reason`); the buttons name their own ids.
/// ⌘⏎'s popup; `all`: ⌘A selected the text of its field with the caret.
fn propose(id: Option<&str>, p: &ProposeProps, all: bool, drawn: &mut Drawn) -> AnyElement {
    let base = id.unwrap_or("settings:propose").to_owned();
    drawn.add("SettingsPropose", &p.title);
    drawn.add("ProposeFocus", format!("{:?}", p.focus).to_lowercase());
    drawn.add("ProposeValue", format!("{} → {}", p.value.from, p.value.to));
    drawn.add("ProposeReason", &p.reason.text);
    drawn.add("ProposeWhere", &p.where_);
    if let Some(e) = &p.error {
        drawn.add("ProposeError", e);
    }
    let sel = selector("SettingsPropose", 0, id);
    let boxed = |focused: bool| {
        div()
            .h(px(CONTROL_H))
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(6.))
            .rounded(px(look::FIELD_ARC))
            .border_1()
            .border_color(if focused {
                look::FOCUS_BORDER
            } else {
                look::FIELD_BORDER
            })
            .overflow_hidden()
            .whitespace_nowrap()
    };
    let label = |text: &str| {
        div()
            .flex_none()
            .w(px(PROPOSE_LABEL_W))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(text.to_owned()))
    };
    let line = |l: AnyElement, c: AnyElement| {
        div()
            .flex()
            .items_center()
            .gap(px(COL_GAP))
            .child(l)
            .child(div().flex_1().min_w_0().child(c))
    };
    let value_focused = p.focus == ProposeFocus::Value;
    let value = boxed(value_focused)
        .debug_selector(|| "factory-settings-propose-value".into())
        .when(p.value.kind != ProposeValueKind::Field, |d| {
            d.justify_between()
        })
        .bg(if p.value.kind == ProposeValueKind::Field {
            look::FIELD_BG
        } else {
            look::FRAME_BG
        })
        .child(
            div()
                .flex()
                .items_center()
                .min_w_0()
                .overflow_hidden()
                .child(
                    div()
                        .flex_none()
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(format!("{} →", p.value.from))),
                )
                .child(div().pl(px(4.)).min_w_0().text_ellipsis().child(field_text(
                    &p.value.to,
                    all && value_focused && p.value.kind == ProposeValueKind::Field,
                )))
                .when(
                    value_focused && p.value.kind == ProposeValueKind::Field,
                    |d| d.child(caret()),
                ),
        )
        .when(p.value.kind == ProposeValueKind::Pick, |d| {
            d.child(Icon::new(IconName::ChevronDown))
        })
        .when(p.value.kind == ProposeValueKind::Toggle, |d| {
            d.child(check_box(checkbox_icon(
                if p.value.to == "on" {
                    CheckState::Checked
                } else {
                    CheckState::Unchecked
                },
                false,
            )))
        });
    let value = clickable(
        value.id(SharedString::from(format!("factory-{base}:value"))),
        Some(&format!("{base}:value")),
        drawn,
    );
    let reason_focused = p.focus == ProposeFocus::Reason;
    let typed = !p.reason.text.is_empty();
    let reason = boxed(reason_focused)
        .debug_selector(|| "factory-settings-propose-reason".into())
        .bg(look::FIELD_BG)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_color(if typed {
                    look::TEXT
                } else {
                    look::TEXT_DISABLED
                })
                .child(if typed {
                    field_text(&p.reason.text, all && reason_focused)
                } else {
                    SharedString::from("Why, for the repo's people to read").into_any_element()
                }),
        )
        .when(reason_focused, |d| d.child(caret()));
    let reason = clickable(
        reason.id(SharedString::from(format!("factory-{base}:reason"))),
        Some(&format!("{base}:reason")),
        drawn,
    );
    let reason_label = div()
        .flex_none()
        .w(px(PROPOSE_LABEL_W))
        .flex()
        .items_baseline()
        .gap(px(4.))
        .child(div().text_color(look::TEXT_DIM).child("Reason"))
        .child(
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DISABLED)
                .child("required"),
        );
    let sink = drawn.sink.clone();
    let button = |b: &Button, primary: bool, focused: bool, key: Option<&str>| {
        let sink = sink.clone();
        let click = b.id.clone();
        let label = match key {
            Some(k) => format!("{}  {k}", b.label),
            None => b.label.clone(),
        };
        let t = TextButton::new(SharedString::from(format!("factory-{}", b.id)), label)
            .primary(primary)
            .on_click(move |_, _, cx| {
                if let Some(sink) = &sink {
                    sink.send(UserInput::Click { id: click.clone() }, cx);
                }
            });
        div()
            .flex_none()
            .rounded(px(look::BUTTON_ARC + 2.))
            .border_2()
            .border_color(if focused {
                look::FOCUS_BORDER.into()
            } else {
                gpui_kit::transparent_black()
            })
            .child(t)
    };
    let error = p.error.as_ref().or(p.reason.error.as_ref()).map(|e| {
        div()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_ERROR)
            .child(SharedString::from(e.clone()))
    });
    let foot = div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .when(p.busy, |d| d.child("Opening the pull request…")),
        )
        .child(button(
            &p.cancel,
            false,
            p.focus == ProposeFocus::Cancel,
            None,
        ))
        .child(button(
            &p.open,
            true,
            p.focus == ProposeFocus::Open,
            Some("⏎"),
        ));
    kit::popup_frame()
        .debug_selector(move || sel)
        .w(px(PROPOSE_W))
        .child(
            div()
                .h(px(TITLE_H))
                .flex()
                .items_center()
                .justify_center()
                .font_weight(FontWeight::SEMIBOLD)
                .border_b_1()
                .border_color(look::SEPARATOR)
                .child(SharedString::from(p.title.clone())),
        )
        .child(
            div()
                .p(px(16.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(line(
                    label(&p.label).into_any_element(),
                    value.into_any_element(),
                ))
                .child(line(
                    reason_label.into_any_element(),
                    reason.into_any_element(),
                ))
                .children(error)
                .child(foot),
        )
        .child(
            div()
                .px(px(16.))
                .pb(px(12.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(p.where_.clone())),
        )
        .into_any_element()
}

/// The dialog as Rust draws it while no bridge answers (`trees/settings-serve-down.json`, the
/// contract's own): the tree, `abe serve not answering` and Retry. Esc closes it, Retry starts
/// the bridge again.
pub fn fallback() -> Option<Node> {
    serde_json::from_str(include_str!(
        "../../../abe/packages/ui/contract/trees/settings-serve-down.json"
    ))
    .ok()
}

/// A key while the fallback is up: what it does without a bridge.
pub enum Fallback {
    Close,
    Retry,
    Nothing,
}

pub fn fallback_key(key: &str) -> Fallback {
    match key {
        "<Esc>" => Fallback::Close,
        "<CR>" => Fallback::Retry,
        _ => Fallback::Nothing,
    }
}
