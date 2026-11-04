//! Chat's composer (2.1), the Rust half of `abe/packages/ui/src/chat/composer.ts`, drawn
//! as boards R-Composer, R-Anatomy and C-Context draw it at the bottom of the 420 px column: the
//! Composer (`.nv-rcomposer`: the field on its own ground, 1 px edge, 6 px arc, the focus border
//! and ring while it has the keys; the field 13 / 20 px, at least 2 rows, growing to 8, then its
//! last rows shown; the caret where the bridge says; the dim model line under it), its
//! ContextChip row (`.nv-ctxrow`: 20 px, 12 px dim, `⌫ drop` at the right) and the SlashMenu over
//! it (`.nv-rmenu`: a popup 4 px above the composer, 26 px rows, the command mono in 76 px, what
//! it does dim; the selected row tinted; a grey row with why as its tooltip). Props in, pixels
//! out: the composer's id, the chip's, the model line's and each row's send their clicks.
//!
//! Text comes as keys and as `text` (the bridge's, `UserInput::Text`): while the field has the
//! keys of its slot ([`Drawn::input`]), it is the window's input handler, so a dead key (`´` then
//! `e`) composes through AppKit and its `é` goes as `text`; the preedit is drawn at the caret.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, BoxShadow, Element, Entity, ExternalPaths, FocusHandle, GlobalElementId,
    HighlightStyle, InspectorElementId, InteractiveElement as _, IntoElement, LayoutId,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledText, UnderlineStyle, Window, deferred, div, point, prelude::FluentBuilder as _, px,
    relative, size,
};
use serde::Deserialize;

use super::draw::{Drawn, Sink, clickable, selector};
use super::protocol::{Node, UserInput};
use crate::editor::input::{Action, Ime, ImeHandler};
use crate::kit::TextArea;
use crate::look;
use crate::render::EDITOR_FONT;

/// The composer's kinds, in `COMPOSER_KINDS`' order.
pub const KINDS: &[&str] = &[
    "Composer",
    "ContextChip",
    "SlashMenu",
    "AttachChip",
    "ChatStatus",
];

/// px (boards R-Composer, R-Anatomy): `.nv-rcomposer` padding (top, right, bottom, left) and arc;
/// the field's line and its rows; the caret; the model bar; the chip row; the menu.
const PAD: [f32; 4] = [4., 4., 2., 10.];
const ARC: f32 = 6.;
pub const LINE_H: f32 = 20.;
pub const MIN_ROWS: f32 = 2.;
pub const MAX_ROWS: f32 = 8.;
const CARET_W: f32 = 2.;
const CARET_H: f32 = 16.;
const BAR_H: f32 = 22.;
const MODEL_PAD_X: f32 = 6.;
const CHIP_H: f32 = 20.;
const CHIP_LINE: f32 = 16.;
const CHIP_PAD_R: f32 = 6.;
const CHIP_GAP: f32 = 6.;
const MENU_GAP: f32 = 4.;
const MENU_PAD: f32 = 4.;
const MENU_ROW_H: f32 = 26.;
const MENU_ROW_PAD_X: f32 = 8.;
const MENU_ROW_GAP: f32 = 10.;
const MENU_CMD_W: f32 = 76.;
/// The command column grows with its longest name (`/abe:create-specification`) up to this.
const MENU_CMD_MOST: f32 = 200.;
/// A character of the editor font at the menu's size: the command column's width per character.
const MENU_CHAR_W: f32 = 7.3;
const ATTACH_MAX_W: f32 = 200.;
/// The composer's id: its click gives the field the keys.
pub const COMPOSER_ID: &str = "composer:composer";

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ModelLine {
    pub label: String,
    /// Dim after the label: `high · next resume`.
    pub note: Option<String>,
    pub id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ComposerProps {
    pub text: String,
    /// The text's caret in characters; None: at its end.
    pub caret: Option<usize>,
    pub placeholder: Option<String>,
    #[serde(default)]
    pub focused: bool,
    pub model: Option<ModelLine>,
    /// No field: this dim line in its place.
    pub line: Option<String>,
    /// The last `draft` number the screen took ([`super::slot::SlotView`]'s own field).
    #[serde(default)]
    pub seq: u64,
    /// The model pick is open over it: its keys are the pick's, the field takes none.
    #[serde(default)]
    pub picking: bool,
}

/// A file that goes with the next message: its name, a picture or a file glyph; a click drops it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AttachChipProps {
    pub name: String,
    #[serde(default)]
    pub image: bool,
}

/// What the agent does now (`ChatStatus`'s tone).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Working,
    Waiting,
    Idle,
    Starting,
}

/// The status line's subagents toggle.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Agents {
    pub text: String,
    pub id: String,
    pub running: u64,
    pub open: bool,
}

/// One listed subagent run.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SubagentRow {
    pub id: String,
    pub name: String,
    pub task: Option<String>,
    pub state: String,
    /// Epoch ms.
    pub since: f64,
    pub until: Option<f64>,
    pub last: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatStatusProps {
    pub tone: Tone,
    pub words: String,
    /// Epoch ms: the time shown counts from it, live.
    pub since: Option<f64>,
    pub agents: Option<Agents>,
    #[serde(default)]
    pub list: Vec<SubagentRow>,
    pub selected: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ContextChipProps {
    pub text: String,
    pub drop: Option<String>,
    #[serde(default)]
    pub dropped: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SlashItem {
    pub id: String,
    pub cmd: String,
    pub desc: String,
    /// Grey, never run: why.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SlashMenuProps {
    pub items: Vec<SlashItem>,
    pub selected: Option<usize>,
}

/// One part of the composer, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Composer(ComposerProps),
    Chip(ContextChipProps),
    Menu(SlashMenuProps),
    Attach(AttachChipProps),
    Status(ChatStatusProps),
}

impl Part {
    /// The part of `kind` (one of [`KINDS`]) from its props.
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Part, D::Error> {
        use serde::de::Error as _;
        Ok(match kind {
            "Composer" => Part::Composer(serde::Deserialize::deserialize(props)?),
            "ContextChip" => Part::Chip(serde::Deserialize::deserialize(props)?),
            "SlashMenu" => Part::Menu(serde::Deserialize::deserialize(props)?),
            "AttachChip" => Part::Attach(serde::Deserialize::deserialize(props)?),
            "ChatStatus" => Part::Status(serde::Deserialize::deserialize(props)?),
            _ => {
                return Err(D::Error::custom(format!("not a composer part: {kind}")));
            }
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Composer(_) => "Composer",
            Part::Chip(_) => "ContextChip",
            Part::Menu(_) => "SlashMenu",
            Part::Attach(_) => "AttachChip",
            Part::Status(_) => "ChatStatus",
        }
    }
}

/// What a slot's composer types with: its slot's keyboard and the IME state kept across frames
/// (the host's, [`super::SlotView`]).
#[derive(Clone, Debug)]
pub struct Input {
    pub focus: FocusHandle,
    pub ime: Rc<RefCell<Ime>>,
    /// The slot's own text area: the composer's field types there, natively.
    pub area: Option<Entity<TextArea>>,
    /// The node whose field the area is now: the composer's, or a card's own words.
    pub owner: Option<String>,
}

pub fn part(
    id: Option<&str>,
    part: &Part,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    match part {
        Part::Composer(p) => composer(id, p, children, drawn, cx),
        Part::Chip(p) => chip(id, p, drawn),
        Part::Menu(p) => menu(id, p, drawn),
        Part::Attach(p) => attach_chip(id, p, drawn),
        Part::Status(p) => super::status::status(id, p, drawn),
    }
}

fn composer(
    id: Option<&str>,
    p: &ComposerProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("Composer", p.text.clone());
    let sel = selector("Composer", ix, id);
    if let Some(line) = &p.line {
        drawn.add("ComposerLine", line.clone());
        let d = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .flex_none()
            .w_full()
            .h(px(BAR_H))
            .flex()
            .items_center()
            .px(px(PAD[3]))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(line.clone()));
        return clickable(d, id, drawn).into_any_element();
    }
    let chip = children
        .iter()
        .find(|n| n.kind() == "ContextChip")
        .map(|n| super::draw::node(n, drawn, cx));
    let menu = children
        .iter()
        .find(|n| n.kind() == "SlashMenu")
        .map(|n| super::draw::node(n, drawn, cx));
    let files: Vec<AnyElement> = children
        .iter()
        .filter(|n| n.kind() == "AttachChip")
        .map(|n| super::draw::node(n, drawn, cx))
        .collect();
    let files = (!files.is_empty()).then(|| {
        div()
            .flex_none()
            .w_full()
            .flex()
            .flex_wrap()
            .gap(px(CHIP_GAP))
            .pt(px(2.))
            .pb(px(4.))
            .children(files)
    });
    let drop_sink = drawn.sink.clone();
    let field = field(p, drawn);
    let bar = bar(p, drawn);
    let focused = p.focused;
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .relative()
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .pt(px(PAD[0]))
        .pr(px(PAD[1]))
        .pb(px(PAD[2]))
        .pl(px(PAD[3]))
        .rounded(px(ARC))
        .bg(look::FIELD_BG)
        .border_1()
        .border_color(if focused {
            look::FOCUS_BORDER
        } else {
            look::FIELD_BORDER
        })
        // `box-shadow: 0 0 0 1px var(--focus-border)`: the ring outside the border
        .when(focused, |d| {
            d.shadow(vec![BoxShadow {
                color: look::hsla(look::FOCUS_BORDER.rgba()),
                offset: point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: px(1.),
                inset: false,
            }])
        })
        .children(chip)
        .children(files)
        .child(field)
        .child(bar)
        // files dropped on it go with the next message (not opened in the editor)
        .drag_over::<ExternalPaths>(|st, _, _, _| st.border_color(look::FOCUS_BORDER))
        .on_drop(move |paths: &ExternalPaths, _, cx| {
            cx.stop_propagation();
            let paths: Vec<String> = paths
                .paths()
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Some(sink) = &drop_sink
                && !paths.is_empty()
            {
                sink.send(UserInput::Attach { paths }, cx);
            }
        })
        // the menu over it, 4 px above its top edge, as wide as its border; painted after the
        // window's other parts, over the status line its host draws over the slot
        .children(menu.map(|m| {
            deferred(
                div()
                    .absolute()
                    .left(px(-1.))
                    .right(px(-1.))
                    .bottom(relative(1.))
                    .pb(px(MENU_GAP))
                    .child(m),
            )
        }));
    // a click anywhere gives it the keys; the field is text under the mouse
    clickable(d, id, drawn).cursor_text().into_any_element()
}

/// The field: its text wrapped at the composer's width, at least 2 rows, at most 8 (taller, its
/// last rows: the text's end stays in view, a caret moved above them is not scrolled to yet), the
/// caret and the preedit at its place.
fn field(p: &ComposerProps, drawn: &mut Drawn) -> AnyElement {
    // the slot's own text area: typed natively, its text told the screen as drafts
    if let Some(area) = drawn
        .input
        .as_ref()
        .filter(|i| i.owner.as_deref() == Some(COMPOSER_ID))
        .and_then(|i| i.area.clone())
    {
        drawn.add("ComposerField", p.text.clone());
        if p.focused {
            drawn.add("ComposerCaret", "");
        }
        return div()
            .debug_selector(|| "factory-composer-field".into())
            .flex_none()
            .w_full()
            .child(area)
            .into_any_element();
    }
    let preedit = drawn
        .input
        .as_ref()
        .filter(|_| p.focused)
        .and_then(|i| i.ime.borrow().marked_text().map(str::to_owned));
    drawn.add("ComposerField", p.text.clone());
    let placeholder = p
        .placeholder
        .clone()
        .filter(|_| p.text.is_empty() && preedit.is_none());
    if let Some(ph) = &placeholder {
        drawn.add("ComposerPlaceholder", ph.clone());
    }
    if p.focused {
        drawn.add("ComposerCaret", "");
    }
    let text = CaretText {
        text: p.text.clone(),
        at: p.caret,
        preedit,
        placeholder,
        caret: p.focused,
        input: drawn.input.clone().filter(|_| p.focused),
        sink: drawn.sink.clone(),
    };
    div()
        .debug_selector(|| "factory-composer-field".into())
        .flex_none()
        .w_full()
        .min_h(px(MIN_ROWS * LINE_H))
        .max_h(px(MAX_ROWS * LINE_H))
        .overflow_hidden()
        .flex()
        .flex_col()
        // taller than 8 rows: the overflow goes out at the top, the last rows stay
        .justify_end()
        .child(
            div()
                .debug_selector(|| "factory-composer-text".into())
                .flex_none()
                .w_full()
                .min_h(px(MIN_ROWS * LINE_H))
                .text_size(px(look::UI_FONT_SIZE))
                .line_height(px(LINE_H))
                .text_color(look::TEXT)
                .child(text),
        )
        .into_any_element()
}

/// The model line under the field: `opus · medium` dim at the right, a click picks another.
fn bar(p: &ComposerProps, drawn: &mut Drawn) -> AnyElement {
    let model = p.model.as_ref().map(|m| {
        let words = match &m.note {
            Some(n) => format!("{} {n}", m.label),
            None => m.label.clone(),
        };
        let ix = drawn.add("ComposerModel", words);
        let sel = selector("ComposerModel", ix, m.id.as_deref());
        let b = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .flex_none()
            .h(px(BAR_H))
            .px(px(MODEL_PAD_X))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(4.))
            .hover(|s| s.bg(look::HOVER_BG))
            .tooltip(crate::kit::tooltip("Pick model and effort", None))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(m.label.clone()))
            .children(m.note.clone().map(|n| {
                div()
                    .text_color(look::TEXT_DISABLED)
                    .child(SharedString::from(n))
            }));
        clickable(b, m.id.as_deref(), drawn)
    });
    div()
        .flex_none()
        .w_full()
        .h(px(BAR_H))
        .flex()
        .items_center()
        .justify_end()
        .children(model)
        .into_any_element()
}

fn chip(id: Option<&str>, p: &ContextChipProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("ContextChip", p.text.clone());
    let sel = selector("ContextChip", ix, id);
    let drop = p.drop.clone().map(|t| {
        drawn.add("ContextDrop", t.clone());
        div()
            .flex_none()
            .ml_auto()
            .whitespace_nowrap()
            .child(SharedString::from(t))
    });
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(CHIP_H))
        .pr(px(CHIP_PAD_R))
        .pb(px(2.))
        .flex()
        .items_center()
        .gap(px(CHIP_GAP))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .line_height(px(CHIP_LINE))
        .text_color(if p.dropped {
            look::TEXT_DISABLED
        } else {
            look::TEXT_DIM
        })
        .tooltip(crate::kit::tooltip(
            "Sent with your next message",
            Some("⌫"),
        ))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(SharedString::from(p.text.clone())),
        )
        .children(drop);
    clickable(d, id, drawn).into_any_element()
}

/// A file going with the next message: its glyph, its name, × (a click drops it).
fn attach_chip(id: Option<&str>, p: &AttachChipProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("AttachChip", p.name.clone());
    let sel = selector("AttachChip", ix, id);
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .max_w(px(ATTACH_MAX_W))
        .h(px(CHIP_H))
        .pl(px(4.))
        .pr(px(2.))
        .flex()
        .items_center()
        .gap(px(4.))
        .rounded(px(4.))
        .bg(look::HOVER_BG)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT)
        .tooltip(crate::kit::tooltip(
            "Goes with your next message · click drops it",
            None,
        ))
        .child(
            crate::kit::Icon::new(if p.image {
                crate::kit::IconName::Image
            } else {
                crate::kit::IconName::AnyType
            })
            .size(px(14.)),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(SharedString::from(p.name.clone())),
        )
        .child(crate::kit::Icon::new(crate::kit::IconName::CloseSmall).size(px(14.)));
    clickable(d, id, drawn).into_any_element()
}

fn menu(id: Option<&str>, p: &SlashMenuProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("SlashMenu", "");
    let sel = selector("SlashMenu", ix, id);
    let cmd_w = menu_cmd_w(p);
    let rows: Vec<AnyElement> = p
        .items
        .iter()
        .enumerate()
        .map(|(i, r)| menu_row(r, p.selected == Some(i), cmd_w, drawn))
        .collect();
    div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .w_full()
        .flex()
        .flex_col()
        .p(px(MENU_PAD))
        .rounded(px(look::POPUP_ARC))
        .bg(look::POPUP_BG)
        .border(px(look::POPUP_BORDER_WIDTH))
        .border_color(look::POPUP_BORDER)
        .shadow(crate::kit::shadow())
        // the field's own clicks stay under it
        .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
            cx.stop_propagation()
        })
        .children(rows)
        .into_any_element()
}

/// The command column: wide enough for the longest name shown, at least `MENU_CMD_W`.
fn menu_cmd_w(p: &SlashMenuProps) -> f32 {
    let chars = p
        .items
        .iter()
        .map(|r| r.cmd.chars().count())
        .max()
        .unwrap_or(0);
    (chars as f32 * MENU_CHAR_W + 2.).clamp(MENU_CMD_W, MENU_CMD_MOST)
}

fn menu_row(r: &SlashItem, selected: bool, cmd_w: f32, drawn: &mut Drawn) -> AnyElement {
    let grey = r.reason.is_some();
    let ix = drawn.add(
        "SlashRow",
        format!("{} {}", r.cmd, r.desc).trim_end().to_owned(),
    );
    if selected {
        drawn.add("SlashSelected", r.cmd.clone());
    }
    let (fg, dim) = match (selected, grey) {
        (_, true) => (look::TEXT_DISABLED, look::TEXT_DISABLED),
        (true, false) => (look::SELECTION_TEXT, look::SELECTION_TEXT),
        (false, false) => (look::TEXT, look::TEXT_DIM),
    };
    let sel = selector("SlashRow", ix, Some(&r.id));
    let d = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(MENU_ROW_H))
        .px(px(MENU_ROW_PAD_X))
        .flex()
        .items_center()
        .gap(px(MENU_ROW_GAP))
        .rounded(px(4.))
        .when(selected, |d| d.bg(super::transcript::selection_bg(drawn)))
        .when(!selected, |d| d.hover(|s| s.bg(look::HOVER_BG)))
        .when_some(r.reason.clone(), |d, why| {
            d.tooltip(crate::kit::tooltip(why, None))
        })
        .whitespace_nowrap()
        .child(
            div()
                .flex_none()
                .w(px(cmd_w))
                .overflow_hidden()
                .text_ellipsis()
                .font(gpui_kit::font(EDITOR_FONT))
                .font_features(crate::render::editor_features())
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(fg)
                .child(SharedString::from(r.cmd.clone())),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(dim)
                .child(SharedString::from(r.desc.clone())),
        );
    clickable(d, Some(&r.id), drawn).into_any_element()
}

/// Where the IME's text goes: committed text to the bridge as `text`; a preedit alone only draws
/// the slot again.
pub fn ime_sink(sink: Sink) -> crate::editor::input::Sink {
    Rc::new(move |actions, _window, cx| {
        let text: String = actions
            .into_iter()
            .filter_map(|a| match a {
                Action::Input(keys) => Some(unescape(&keys)),
                _ => None,
            })
            .collect();
        if text.is_empty() {
            let _ = sink.view.update(cx, |_, cx| cx.notify());
        } else {
            sink.send(UserInput::Text { text }, cx);
        }
    })
}

/// Committed text from the IME, back from its nvim notation (`<lt>`, `<CR>`, `<Tab>`).
fn unescape(keys: &str) -> String {
    keys.replace("<CR>", "\n")
        .replace("<Tab>", "\t")
        .replace("<lt>", "<")
}

/// The field's text wrapped by GPUI, the preedit underlined at the caret (or the placeholder, dim),
/// and the 2 px caret painted at its place; while focused, the window's input handler.
pub(super) struct CaretText {
    text: String,
    /// The caret in characters; None: at the end.
    at: Option<usize>,
    preedit: Option<String>,
    placeholder: Option<String>,
    caret: bool,
    input: Option<Input>,
    sink: Option<Sink>,
}

impl CaretText {
    /// Typed text wrapped at its field's width with the caret at `at` (characters; None: the
    /// end), the keys coming as the bridge's (a Question card's own words).
    pub(super) fn typed(text: String, at: Option<usize>) -> CaretText {
        CaretText {
            text,
            at,
            preedit: None,
            placeholder: None,
            caret: true,
            input: None,
            sink: None,
        }
    }

    /// What is drawn and where the caret goes in it (a byte index).
    fn styled(&self) -> (StyledText, usize) {
        if let Some(ph) = &self.placeholder {
            let len = ph.len();
            let dim = HighlightStyle {
                color: Some(look::hsla(look::PLACEHOLDER.rgba())),
                ..Default::default()
            };
            return (
                StyledText::new(SharedString::from(ph.clone())).with_highlights([(0..len, dim)]),
                0,
            );
        }
        // the caret's byte; the preedit goes in there
        let caret = super::field::caret_byte(&self.text, self.at);
        match &self.preedit {
            Some(m) => {
                let (before, after) = self.text.split_at(caret);
                let all = format!("{before}{m}{after}");
                let at = caret..caret + m.len();
                let end = at.end;
                let marked = HighlightStyle {
                    underline: Some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(look::hsla(look::TEXT.rgba())),
                        wavy: false,
                    }),
                    ..Default::default()
                };
                (
                    StyledText::new(SharedString::from(all)).with_highlights([(at, marked)]),
                    end,
                )
            }
            None => (
                StyledText::new(SharedString::from(self.text.clone())),
                caret,
            ),
        }
    }
}

/// [`CaretText`]'s element: the text's own layout, the caret and the input handler after it.
pub struct CaretTextElement {
    text: StyledText,
    caret_at: usize,
    caret: bool,
    input: Option<Input>,
    sink: Option<Sink>,
}

impl IntoElement for CaretText {
    type Element = CaretTextElement;
    fn into_element(self) -> CaretTextElement {
        let (text, caret_at) = self.styled();
        CaretTextElement {
            text,
            caret_at,
            caret: self.caret,
            input: self.input,
            sink: self.sink,
        }
    }
}

impl IntoElement for CaretTextElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for CaretTextElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<gpui_kit::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        self.text.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: gpui_kit::Bounds<Pixels>,
        state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.text
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: gpui_kit::Bounds<Pixels>,
        state: &mut (),
        prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.text
            .paint(id, inspector_id, bounds, state, prepaint, window, cx);
        if !self.caret {
            return;
        }
        let layout = self.text.layout();
        let line_h = layout.line_height();
        let at = layout
            .position_for_index(self.caret_at)
            .unwrap_or(bounds.origin);
        let caret = gpui_kit::Bounds::new(
            point(at.x, at.y + (line_h - px(CARET_H)) / 2.),
            size(px(CARET_W), px(CARET_H)),
        );
        window.paint_quad(gpui_kit::fill(caret, look::CARET));
        let (Some(input), Some(sink)) = (self.input.clone(), self.sink.clone()) else {
            return;
        };
        input.ime.borrow_mut().set_caret_bounds(caret);
        window.handle_input(&input.focus, ImeHandler::new(input.ime, ime_sink(sink)), cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ime_text_comes_back_from_its_notation() {
        assert_eq!(unescape("a<lt>b>"), "a<b>");
        assert_eq!(unescape("x<CR>y"), "x\ny");
        assert_eq!(unescape("é"), "é");
    }

    #[test]
    fn the_caret_and_a_preedit_go_where_the_bridge_says() {
        let at = |at: Option<usize>, preedit: Option<&str>| {
            CaretText {
                preedit: preedit.map(str::to_owned),
                ..CaretText::typed("åbc".into(), at)
            }
            .styled()
            .1
        };
        // characters in, as the bridge counts them; none: the end
        assert_eq!(at(Some(1), None), "å".len());
        assert_eq!(at(None, None), "åbc".len());
        // a dead key's preedit at the caret, the caret after it
        assert_eq!(at(Some(1), Some("´")), "å´".len());
    }
}
