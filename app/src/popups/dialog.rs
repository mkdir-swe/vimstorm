//! The flow dialog (1.0 design, `.vs-flow`): a centred popup in the card-dialog look for flows
//! with inputs or consequences: a complex header (the bold question or flow name, a dim subtitle,
//! ×), sections (a bold heading and a dim note, rows with a mark, a name, dim meta and a dim end
//! word, an optional checkbox, an optional text area), and a 48 px footer (a dim note, then the
//! buttons, each with its key). Stop agent (W-37), Archive workspace (W-36), Delete working files
//! (W-35), Instructions (W-31).
//!
//! Keys: ⏎ presses the default (primary) button, Esc or × cancels, a button's letter key presses it
//! (`y` Stop agent, `d` Delete working files, `a` Archive) while no text area has the keyboard,
//! ⌘⏎ the button whose key is `⌘⏎`; ⇧⏎ is a new line in the text area; Space toggles the
//! checkbox. A click on a button or a row's action answers with it.
//!
//! A flow with inputs (New workspace, W-09) adds selectable rows (`l ö` / ↑ ↓ move, ⏎ or a click
//! answers `row`), labelled values (Repository, Story) and choice cards (Environment, Agent: one
//! of N, `k ä` / ← → choose, a click too); Tab / ⇧Tab move between the rows and each card group.

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, CursorStyle, Entity, FocusHandle, Focusable as _,
    FontWeight, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Point, Rgba, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, deferred, div, point, prelude::FluentBuilder as _, px,
};

use super::{Done, PopupsView};
use crate::kit::TextArea;
use crate::kit::TextButton;
use crate::kit::{self, Anchor};
use crate::kit::{CheckState, check_box, checkbox_icon};
use crate::look;

/// A dialog to open ([`super::open_dialog`]).
#[derive(Clone, Debug, Default)]
pub struct Dialog {
    /// Its name in tests (`dialog-<id>`).
    pub id: &'static str,
    /// The question or flow name, bold ("Stop the agent?", "Instructions").
    pub title: SharedString,
    /// Dim after it: the object ("AB-1240 checkout copy").
    pub subtitle: Option<SharedString>,
    pub width: f32,
    /// A text area first (W-31's New instruction).
    pub field: Option<Field>,
    pub sections: Vec<Section>,
    /// Dim at the footer's left ("Commit and push first to keep the changes").
    pub note: Option<SharedString>,
    /// Left to right; the default one is [`Look::Primary`] and last.
    pub buttons: Vec<Button>,
    /// The dialog as text for tests, when its builder gives one ([`super::flow::Flow::lines`]).
    pub lines: Option<Vec<String>>,
    /// The footer's note while a card is chosen, in place of [`Self::note`]: `(group, card,
    /// note)` (K-01: Cloud's).
    pub notes: Vec<(usize, usize, SharedString)>,
}

#[derive(Clone, Debug, Default)]
pub struct Field {
    pub heading: SharedString,
    pub text: String,
    pub placeholder: SharedString,
    /// Dim under the area.
    pub hint: Option<SharedString>,
}

#[derive(Clone, Debug, Default)]
pub struct Section {
    pub heading: SharedString,
    /// Dim after the heading ("3 files · lost", "3 · oldest first").
    pub note: Option<SharedString>,
    pub rows: Vec<Row>,
    /// A checkbox under the rows (off by default: W-35's Also delete branch).
    pub check: Option<Check>,
    /// Dim text under it all.
    pub text: Option<SharedString>,
    /// Its rows are a list to pick from (`l ö`, ⏎ answers `row`; Recent workspaces).
    pub selectable: bool,
    /// Labelled values in the WebStorm dialog grid (label column 96): Repository, Story.
    pub values: Vec<Value>,
    /// One-of-N card groups (Environment, Agent).
    pub choices: Vec<Choices>,
    /// Rich lines after the rows ([`Rich`]).
    pub rich: Vec<Rich>,
    /// Lines after the card groups shown only while a card is chosen ([`When`]).
    pub when: Vec<When>,
}

/// A rich line shown only while card `card` of card group `group` (counted across sections) is
/// chosen: K-01's `Runs as` under Cloud.
#[derive(Clone, Debug)]
pub struct When {
    pub group: usize,
    pub card: usize,
    pub line: Rich,
}

/// Rich lines of a section, in order (the cloud flows: Hand back, Stop, Start from this
/// workspace): a labelled value of coloured spans, a bullet item with dim end words, a line of
/// text, or the dialog's text area under a label.
#[derive(Clone, Debug)]
pub enum Rich {
    Grid {
        label: SharedString,
        value: Vec<Span>,
    },
    Item {
        spans: Vec<Span>,
        end: Vec<Span>,
    },
    Text(Vec<Span>),
    Field {
        label: SharedString,
    },
}

pub use super::flow::Span;

#[derive(Clone, Debug, Default)]
pub struct Value {
    pub label: SharedString,
    pub value: SharedString,
    /// Dim at its right ("from main").
    pub hint: Option<SharedString>,
}

#[derive(Clone, Debug, Default)]
pub struct Choices {
    pub label: SharedString,
    pub cards: Vec<Card>,
    /// The chosen card.
    pub selected: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Card {
    pub title: SharedString,
    pub desc: SharedString,
    pub disabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Row {
    pub mark: Mark,
    pub name: SharedString,
    /// In the mono face (paths, hashes).
    pub mono: bool,
    pub name_color: Option<Rgba>,
    pub meta: Option<SharedString>,
    /// The dim end word ("stops", "kept", a state in its colour).
    pub end: Option<(SharedString, Option<Rgba>)>,
    /// Link-coloured actions at the end (W-31's Edit · Steer now · Remove), each answering with
    /// its id and this row's index.
    pub actions: Vec<(SharedString, &'static str)>,
    /// The whole name, wrapped over as many lines as it takes (W-14's reason, the command that
    /// failed), never cut with `…`.
    pub wrap: bool,
}

/// What leads a row.
#[derive(Clone, Debug, Default)]
pub enum Mark {
    #[default]
    Bullet,
    /// A state's dot.
    Dot(Rgba),
    /// A queue position, its colour.
    Number(usize, Rgba),
}

#[derive(Clone, Debug, Default)]
pub struct Check {
    pub label: SharedString,
    /// In the path colour after the label (a branch).
    pub value: Option<SharedString>,
    /// Dim after it.
    pub detail: Option<SharedString>,
}

#[derive(Clone, Debug)]
pub struct Button {
    pub id: &'static str,
    pub label: SharedString,
    /// Drawn after the label and pressing it ("⏎", "y", "⌘⏎").
    pub key: Option<SharedString>,
    pub look: Look,
    /// Greyed out: no key or click presses it (Hand back while the remote moved).
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// The default: blue, ⏎.
    Primary,
    Plain,
    /// A risky answer: outlined red.
    Danger,
}

impl Button {
    pub fn new(id: &'static str, label: impl Into<SharedString>, look: Look) -> Self {
        Self {
            id,
            label: label.into(),
            key: None,
            look,
            enabled: true,
        }
    }

    pub fn key(mut self, key: impl Into<SharedString>) -> Self {
        self.key = Some(key.into());
        self
    }

    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
}

/// How the dialog was answered (none: cancelled).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    /// The button's or the row action's id.
    pub id: &'static str,
    /// The row whose action it was.
    pub row: Option<usize>,
    /// The text area's text.
    pub text: String,
    /// The checkbox.
    pub checked: bool,
    /// Each card group's choice, in order.
    pub choices: Vec<usize>,
    /// A link span in a rich line answered (its id), not a button.
    pub link: bool,
}

pub(super) struct DialogPopup {
    pub(super) dialog: Dialog,
    area: Option<Entity<TextArea>>,
    checked: bool,
    pub(super) done: Done<Option<Answer>>,
    origin: Point<Pixels>,
    /// The selectable rows' cursor.
    row: usize,
    /// Where Tab put the keys: the selectable rows (0, when there are some), then each group.
    stop: usize,
    choice: Vec<usize>,
}

/// What a key did on the rows and cards.
pub(super) enum Nav {
    None,
    Moved,
    Answer(Answer),
}

/// The dialog's top: under the toolbar and strip, a little into the editor (W-35..37 sit there).
const TOP: f32 = 96.;

impl DialogPopup {
    pub(super) fn new(
        dialog: Dialog,
        done: Done<Option<Answer>>,
        window: &mut Window,
        cx: &mut Context<PopupsView>,
    ) -> Self {
        let area = dialog.field.as_ref().map(|f| {
            let placeholder = f.placeholder.clone();
            let text = f.text.clone();
            cx.new(|cx| {
                let mut a = TextArea::new(cx).placeholder(placeholder);
                a.set_text(text, cx);
                a
            })
        });
        let viewport = window.viewport_size();
        let origin = point(
            px(kit::centered(dialog.width, viewport.width.as_f32())),
            px(TOP.min((viewport.height.as_f32() / 6.).max(look::TOOLBAR_HEIGHT.get()))),
        );
        let choice = dialog
            .sections
            .iter()
            .flat_map(|s| s.choices.iter().map(|c| c.selected))
            .collect();
        let mut p = Self {
            dialog,
            area,
            checked: false,
            done,
            origin,
            row: 0,
            stop: 0,
            choice,
        };
        // the keys start on the first card group (⏎ is the primary button there); Tab reaches
        // the rows to pick from
        if !p.choice.is_empty() {
            p.stop = usize::from(p.pickable() > 0);
        }
        p
    }

    pub(super) fn focus(&self, own: &FocusHandle, window: &mut Window, cx: &mut App) {
        match &self.area {
            Some(a) => {
                let h = a.read(cx).focus_handle(cx);
                window.focus(&h, cx);
            }
            None => window.focus(own, cx),
        }
    }

    /// The answer for button / action `id`.
    pub(super) fn answer(&self, id: &'static str, row: Option<usize>, cx: &App) -> Answer {
        Answer {
            id,
            row,
            text: self
                .area
                .as_ref()
                .map(|a| a.read(cx).text().to_owned())
                .unwrap_or_default(),
            checked: self.checked,
            choices: self.choice.clone(),
            link: false,
        }
    }

    /// The selectable rows (all sections'), counted.
    fn pickable(&self) -> usize {
        self.dialog
            .sections
            .iter()
            .filter(|s| s.selectable)
            .map(|s| s.rows.len())
            .sum()
    }

    /// The Tab stops: the rows (when pickable), then each card group.
    fn stops(&self) -> usize {
        usize::from(self.pickable() > 0) + self.choice.len()
    }

    /// The card group with the keys (none: the rows have them).
    fn group(&self) -> Option<usize> {
        let first = usize::from(self.pickable() > 0);
        self.stop.checked_sub(first)
    }

    /// The index of the first row of the first selectable section across all sections (the
    /// answers name rows across sections).
    fn first_pick(&self) -> usize {
        let mut n = 0;
        for s in &self.dialog.sections {
            if s.selectable {
                return n;
            }
            n += s.rows.len();
        }
        n
    }

    /// A key on the rows and cards: moved (redraw), or the answer it gives.
    pub(super) fn nav(&mut self, key: &str, cx: &App) -> Nav {
        let stops = self.stops();
        match key {
            "<Tab>" if stops > 0 => {
                self.stop = (self.stop + 1) % stops;
                Nav::Moved
            }
            "<S-Tab>" if stops > 0 => {
                self.stop = (self.stop + stops - 1) % stops;
                Nav::Moved
            }
            "l" | "<Up>" | "ö" | "<Down>" if self.group().is_none() && self.pickable() > 0 => {
                let n = self.pickable();
                self.row = if matches!(key, "l" | "<Up>") {
                    self.row.saturating_sub(1)
                } else {
                    (self.row + 1).min(n - 1)
                };
                Nav::Moved
            }
            "k" | "<Left>" | "ä" | "<Right>" => {
                let Some(g) = self.group() else {
                    return Nav::None;
                };
                let cards: Vec<&Card> = self
                    .dialog
                    .sections
                    .iter()
                    .flat_map(|s| s.choices.iter())
                    .nth(g)
                    .map(|c| c.cards.iter().collect())
                    .unwrap_or_default();
                let back = matches!(key, "k" | "<Left>");
                let mut at = self.choice[g];
                loop {
                    let next = if back {
                        at.checked_sub(1)
                    } else {
                        Some(at + 1)
                    };
                    match next.filter(|&n| n < cards.len()) {
                        Some(n) if cards[n].disabled => at = n,
                        Some(n) => {
                            self.choice[g] = n;
                            return Nav::Moved;
                        }
                        None => return Nav::None,
                    }
                }
            }
            "<CR>" if self.group().is_none() && self.pickable() > 0 && self.stop == 0 => {
                Nav::Answer(self.answer("row", Some(self.first_pick() + self.row), cx))
            }
            _ => Nav::None,
        }
    }

    /// A click on card `card` of group `group`.
    pub(super) fn choose(&mut self, group: usize, card: usize) {
        if let Some(c) = self.choice.get_mut(group) {
            *c = card;
        }
        self.stop = usize::from(self.pickable() > 0) + group;
    }

    /// The cards chosen (tests).
    pub(super) fn chosen(&self) -> &[usize] {
        &self.choice
    }

    /// Card `card` of group `group` is the chosen one.
    fn chose(&self, group: usize, card: usize) -> bool {
        self.choice.get(group) == Some(&card)
    }

    /// The footer's note for the cards chosen now.
    pub(super) fn note(&self) -> Option<SharedString> {
        self.dialog
            .notes
            .iter()
            .find(|(g, c, _)| self.chose(*g, *c))
            .map(|(_, _, n)| n.clone())
            .or_else(|| self.dialog.note.clone())
    }

    /// The lines shown for the cards chosen now, as text (tests): `label: value` for the
    /// labelled values and the [`When`] grid lines.
    pub(super) fn value_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        for s in &self.dialog.sections {
            for v in &s.values {
                let hint = v.hint.as_ref().map_or(String::new(), |h| format!(" · {h}"));
                out.push(format!("{}: {}{hint}", v.label, v.value));
            }
            for w in s.when.iter().filter(|w| self.chose(w.group, w.card)) {
                if let Rich::Grid { label, value } = &w.line {
                    let text: Vec<String> = value.iter().map(|s| s.text.to_string()).collect();
                    out.push(format!("{label}: {}", text.join(" ")));
                }
            }
        }
        out
    }

    /// The text area holds text: a click outside keeps the dialog.
    pub(super) fn has_text(&self, cx: &App) -> bool {
        self.area.as_ref().is_some_and(|a| !a.read(cx).is_empty())
    }

    /// Text into its area as AppKit's input context commits it (tests).
    pub(super) fn type_text(&self, text: &str, cx: &mut App) {
        if let Some(a) = &self.area {
            a.update(cx, |a, cx| {
                let t = format!("{}{text}", a.text());
                a.set_text(t, cx);
            });
        }
    }

    /// Its text area has the keyboard (tests).
    pub(super) fn area_focused(&self, window: &Window, cx: &App) -> bool {
        self.area
            .as_ref()
            .is_some_and(|a| a.read(cx).focus_handle(cx).is_focused(window))
    }

    /// The button a key presses (`<CR>` the primary, a letter its button, `<D-CR>` ⌘⏎'s).
    pub(super) fn button_for(&self, key: &str, typing: bool) -> Option<&'static str> {
        let b = &self.dialog.buttons;
        match key {
            "<CR>" => b
                .iter()
                .find(|b| b.look == Look::Primary && b.enabled)
                .map(|b| b.id),
            "<D-CR>" => b
                .iter()
                .find(|b| b.enabled && b.key.as_deref() == Some("⌘⏎"))
                .map(|b| b.id),
            k if !typing && k.chars().count() == 1 => b
                .iter()
                .find(|b| b.enabled && b.look != Look::Primary && b.key.as_deref() == Some(k))
                .map(|b| b.id),
            _ => None,
        }
    }

    pub(super) fn toggle(&mut self) -> bool {
        if self.dialog.sections.iter().any(|s| s.check.is_some()) {
            self.checked = !self.checked;
            true
        } else {
            false
        }
    }

    pub(super) fn render(&self, cx: &mut Context<PopupsView>) -> AnyElement {
        let d = &self.dialog;
        let id = d.id;
        let title = div()
            .flex()
            .items_baseline()
            .gap(px(8.))
            .min_w_0()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(d.title.clone()),
            )
            .children(d.subtitle.clone().map(|s| {
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .font_weight(FontWeight::NORMAL)
                    .child(s)
            }));
        let close = crate::kit::IconButton::new(
            SharedString::from(format!("dialog-{id}-close")),
            crate::kit::IconName::Close,
        )
        .tooltip("Close", Some("Esc"))
        .on_click(cx.listener(|p, _, window, cx| p.finish_dialog(None, window, cx)));
        let head = kit::complex_header(title, Some(close.into_any_element()))
            .pr(px(look::FLOW_HEAD_PAD_R));
        let mut body = div().flex().flex_col();
        let inline = d
            .sections
            .iter()
            .any(|s| s.rich.iter().any(|r| matches!(r, Rich::Field { .. })));
        if let (Some(f), Some(area), false) = (&d.field, &self.area, inline) {
            body = body.child(
                section_frame(false)
                    .child(heading(f.heading.clone(), None))
                    .child(
                        div()
                            .debug_selector(move || format!("dialog-{id}-field"))
                            .h(px(look::FLOW_FIELD_HEIGHT))
                            .rounded(px(look::FIELD_ARC))
                            .border_2()
                            .border_color(look::FOCUS_BORDER)
                            .child(area.clone()),
                    )
                    .children(f.hint.clone().map(|h| {
                        div()
                            .mt(px(6.))
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(look::TEXT_DIM)
                            .child(h)
                    })),
            );
        }
        for (si, s) in d.sections.iter().enumerate() {
            let separated = si > 0 || (d.field.is_some() && !inline);
            let mut sec = section_frame(separated);
            if !s.heading.is_empty() {
                sec = sec.child(heading(s.heading.clone(), s.note.clone()));
            }
            let mut rows = div().flex().flex_col();
            for (ri, r) in s.rows.iter().enumerate() {
                rows = rows.child(self.row(si, ri, r, cx));
            }
            sec = sec.child(rows);
            for v in &s.values {
                sec = sec.child(value_row(v));
            }
            if !s.rich.is_empty() {
                let items = s.rich.iter().all(|r| matches!(r, Rich::Item { .. }));
                sec = sec.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(if items { 0. } else { 10. }))
                        .children(s.rich.iter().map(|r| self.rich(r, cx))),
                );
            }
            let before: usize = d.sections[..si].iter().map(|s| s.choices.len()).sum();
            for (gi, g) in s.choices.iter().enumerate() {
                sec = sec.child(self.choice_row(before + gi, g, cx));
            }
            for w in s.when.iter().filter(|w| self.chose(w.group, w.card)) {
                sec = sec.child(div().mt(px(10.)).child(self.rich(&w.line, cx)));
            }
            if let Some(c) = &s.check {
                let on = self.checked;
                sec = sec.child(
                    div()
                        .id(SharedString::from(format!("dialog-{id}-check")))
                        .debug_selector(move || format!("dialog-{id}-check"))
                        .mt(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .cursor(CursorStyle::PointingHand)
                        .child(check_box(checkbox_icon(
                            if on {
                                CheckState::Checked
                            } else {
                                CheckState::Unchecked
                            },
                            false,
                        )))
                        .child(c.label.clone())
                        .children(c.value.clone().map(|v| {
                            div()
                                .font_family(crate::render::EDITOR_FONT)
                                .text_color(look::ABE_PATH)
                                .child(v)
                        }))
                        .children(c.detail.clone().map(|t| {
                            div()
                                .text_size(px(look::UI_SMALL_FONT_SIZE))
                                .text_color(look::TEXT_DIM)
                                .child(t)
                        }))
                        .on_click(cx.listener(|p, _, _, cx| {
                            if let Some(super::Modal::Dialog(d)) = &mut p.modal {
                                d.toggle();
                                cx.notify();
                            }
                        })),
                );
            }
            if let Some(t) = &s.text {
                sec = sec.child(
                    div()
                        .mt(px(6.))
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(t.clone()),
                );
            }
            body = body.child(sec);
        }
        let buttons = d.buttons.iter().map(|b| {
            let bid = b.id;
            let mut t = TextButton::new(
                SharedString::from(format!("dialog-{id}-{bid}")),
                b.label.clone(),
            )
            .primary(b.look == Look::Primary)
            .danger(b.look == Look::Danger)
            .disabled(!b.enabled)
            .on_click(cx.listener(move |p, _, window, cx| {
                if let Some(super::Modal::Dialog(d)) = &p.modal {
                    let a = d.answer(bid, None, cx);
                    p.finish_dialog(Some(a), window, cx);
                }
            }));
            if let Some(k) = b.key.clone() {
                t = t.key(k);
            }
            t
        });
        let foot = div()
            .flex_none()
            .h(px(look::FLOW_FOOT_HEIGHT))
            .pl(px(look::FLOW_SECTION_PAD_X))
            .pr(px(look::FLOW_FOOT_PAD_R))
            .flex()
            .items_center()
            .gap(px(8.))
            .border_t_1()
            .border_color(look::SEPARATOR)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .children(self.note()),
            )
            .children(buttons);
        let frame = kit::popup_frame()
            .id(SharedString::from(format!("dialog-{id}")))
            .debug_selector(move || format!("dialog-{id}"))
            .w(px(d.width))
            .occlude()
            .capture_key_down(cx.listener(|p, ev: &gpui_kit::KeyDownEvent, window, cx| {
                p.dialog_capture_key(ev, window, cx)
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _: &MouseDownEvent, _, cx| cx.stop_propagation()),
            )
            .on_mouse_down_out(
                cx.listener(|p, _: &MouseDownEvent, window, cx| p.dismiss(window, cx)),
            )
            .child(head)
            .child(div().flex_none().h(px(1.)).bg(look::SEPARATOR))
            .child(body)
            .child(foot);
        deferred(kit::placed(Anchor::Point(self.origin), frame))
            .with_priority(super::PRIORITY)
            .into_any_element()
    }

    fn row(&self, si: usize, ri: usize, r: &Row, cx: &mut Context<PopupsView>) -> AnyElement {
        let id = self.dialog.id;
        // rows of every section count up: a row action names its row across sections
        let index: usize = self.dialog.sections[..si]
            .iter()
            .map(|s| s.rows.len())
            .sum::<usize>()
            + ri;
        let mark: AnyElement = match &r.mark {
            Mark::Bullet => div()
                .text_color(look::TEXT_DIM)
                .child("·")
                .into_any_element(),
            Mark::Dot(c) => div().text_color(*c).child("●").into_any_element(),
            Mark::Number(n, c) => div()
                .text_color(*c)
                .child(SharedString::from(n.to_string()))
                .into_any_element(),
        };
        let name = div()
            .when(!r.wrap, |d| {
                d.flex_none()
                    .max_w(relative_name())
                    .overflow_hidden()
                    .text_ellipsis()
            })
            .when(r.wrap, |d| d.flex_1().min_w_0().whitespace_normal())
            .when(r.mono, |d| {
                d.font_family(crate::render::EDITOR_FONT)
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
            })
            .when_some(r.name_color, |d, c| d.text_color(c))
            .child(r.name.clone());
        let actions = r.actions.iter().map(|(label, act)| {
            let act = *act;
            div()
                .id(SharedString::from(format!("dialog-{id}-{act}-{index}")))
                .debug_selector(move || format!("dialog-{id}-{act}-{index}"))
                .text_color(look::LINK)
                .cursor(CursorStyle::PointingHand)
                .child(label.clone())
                .on_click(cx.listener(move |p, _, window, cx| {
                    if let Some(super::Modal::Dialog(d)) = &p.modal {
                        let a = d.answer(act, Some(index), cx);
                        p.finish_dialog(Some(a), window, cx);
                    }
                }))
        });
        let pick = self.dialog.sections[si].selectable;
        let selected = pick && index == self.first_pick() + self.row;
        let focused = selected && self.group().is_none();
        div()
            .id(SharedString::from(format!("dialog-{id}-row-{index}")))
            .debug_selector(move || {
                if selected {
                    format!("dialog-{id}-row-{index}-selected")
                } else {
                    format!("dialog-{id}-row-{index}")
                }
            })
            .min_h(px(look::FLOW_ROW_HEIGHT))
            .px(px(8.))
            .rounded(px(look::BUTTON_ARC))
            .when(selected, |d| {
                d.bg(if focused {
                    look::SELECTION_BG
                } else {
                    look::SELECTION_BG_INACTIVE
                })
            })
            .when(pick, |d| {
                d.cursor(CursorStyle::PointingHand).on_click(cx.listener(
                    move |p, _, window, cx| {
                        if let Some(super::Modal::Dialog(d)) = &p.modal {
                            let a = d.answer("row", Some(index), cx);
                            p.finish_dialog(Some(a), window, cx);
                        }
                    },
                ))
            })
            .flex()
            .when(!r.wrap, |d| d.items_center().whitespace_nowrap())
            .when(r.wrap, |d| d.items_start().py(px(4.)))
            .gap(px(8.))
            .child(
                div()
                    .flex_none()
                    .w(px(14.))
                    .flex()
                    .justify_center()
                    .child(mark),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_baseline()
                    .gap(px(8.))
                    .overflow_hidden()
                    .child(name)
                    .children(r.meta.clone().map(|m| {
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(look::TEXT_DIM)
                            .child(m)
                    })),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .children(
                        r.end
                            .clone()
                            .map(|(w, c)| div().when_some(c, |d, c| d.text_color(c)).child(w)),
                    )
                    .children(actions),
            )
            .into_any_element()
    }
}

impl DialogPopup {
    fn span(&self, s: &Span, cx: &mut Context<PopupsView>) -> AnyElement {
        let mut el = div()
            .flex_none()
            .whitespace_nowrap()
            .text_color(s.color.unwrap_or(look::TEXT.rgba()))
            .when(s.mono, |d| {
                d.font_family(crate::render::EDITOR_FONT)
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
            })
            .when(s.bold, |d| d.font_weight(FontWeight::SEMIBOLD))
            .child(s.text.clone());
        if let Some(id) = s.link {
            el = el.cursor(CursorStyle::PointingHand).on_mouse_down(
                MouseButton::Left,
                cx.listener(move |p, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    if let Some(super::Modal::Dialog(d)) = &p.modal {
                        let mut a = d.answer(id, None, cx);
                        a.link = true;
                        p.finish_dialog(Some(a), window, cx);
                    }
                }),
            );
        }
        el.into_any_element()
    }

    fn spans(&self, spans: &[Span], cx: &mut Context<PopupsView>) -> AnyElement {
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .overflow_hidden()
            .children(spans.iter().map(|s| self.span(s, cx)))
            .into_any_element()
    }

    /// A rich line ([`Rich`]).
    fn rich(&self, r: &Rich, cx: &mut Context<PopupsView>) -> AnyElement {
        let id = self.dialog.id;
        match r {
            Rich::Grid { label, value } => div()
                .flex()
                .items_center()
                .gap(px(12.))
                .min_h(px(20.))
                .child(
                    div()
                        .flex_none()
                        .w(px(look::FLOW_LABEL_WIDTH))
                        .child(label.clone()),
                )
                .child(self.spans(value, cx))
                .into_any_element(),
            Rich::Item { spans, end } => div()
                .flex()
                .items_center()
                .gap(px(8.))
                .h(px(look::FLOW_ROW_HEIGHT))
                .px(px(8.))
                .child(
                    div()
                        .flex_none()
                        .w(px(6.))
                        .text_color(look::TEXT_DIM)
                        .child("·"),
                )
                .child(div().flex_1().min_w_0().child(self.spans(spans, cx)))
                .child(
                    div()
                        .flex_none()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(self.spans(end, cx)),
                )
                .into_any_element(),
            Rich::Text(spans) => self.spans(spans, cx),
            Rich::Field { label } => div()
                .flex()
                .items_start()
                .gap(px(12.))
                .child(
                    div()
                        .flex_none()
                        .w(px(look::FLOW_LABEL_WIDTH))
                        .pt(px(8.))
                        .child(label.clone()),
                )
                .child(
                    div()
                        .debug_selector(move || format!("dialog-{id}-field"))
                        .flex_1()
                        .min_w_0()
                        .h(px(look::FLOW_FIELD_HEIGHT))
                        .rounded(px(look::FIELD_ARC))
                        .border_2()
                        .border_color(look::FOCUS_BORDER)
                        .children(self.area.clone()),
                )
                .into_any_element(),
        }
    }

    /// A card group: its label in the grid's column, then the cards side by side.
    fn choice_row(&self, group: usize, g: &Choices, cx: &mut Context<PopupsView>) -> AnyElement {
        let id = self.dialog.id;
        let chosen = self.choice.get(group).copied().unwrap_or(g.selected);
        let focused = self.group() == Some(group);
        let cards = g.cards.iter().enumerate().map(|(ci, c)| {
            let on = ci == chosen;
            let disabled = c.disabled;
            div()
                .id(SharedString::from(format!(
                    "dialog-{id}-choice-{group}-{ci}"
                )))
                .debug_selector(move || {
                    if on {
                        format!("dialog-{id}-choice-{group}-{ci}-selected")
                    } else {
                        format!("dialog-{id}-choice-{group}-{ci}")
                    }
                })
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .pt(px(7.))
                .pb(px(8.))
                .px(px(10.))
                .rounded(px(look::FIELD_ARC))
                .border_1()
                .border_color(if on {
                    look::FOCUS_BORDER
                } else {
                    look::FIELD_BORDER
                })
                .when(on, |d| d.bg(look::SELECTION_BG_INACTIVE))
                .when(on && focused, |d| d.border_2())
                .when(!disabled, |d| {
                    d.cursor(CursorStyle::PointingHand)
                        .on_click(cx.listener(move |p, _, _, cx| {
                            if let Some(super::Modal::Dialog(d)) = &mut p.modal {
                                d.choose(group, ci);
                                cx.notify();
                            }
                        }))
                })
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .whitespace_nowrap()
                        .text_color(if disabled {
                            look::TEXT_DISABLED
                        } else {
                            look::TEXT
                        })
                        .child(
                            div()
                                .flex_none()
                                .size(px(14.))
                                .rounded(px(7.))
                                .border_color(if on {
                                    look::FOCUS_BORDER
                                } else {
                                    look::BUTTON_BORDER
                                })
                                .map(|d| {
                                    if on {
                                        d.border(px(4.)).bg(look::BUTTON_PRIMARY_FG)
                                    } else {
                                        d.border_1()
                                    }
                                }),
                        )
                        .child(c.title.clone()),
                )
                .child(
                    div()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(c.desc.clone()),
                )
        });
        div()
            .mt(px(10.))
            .flex()
            .items_start()
            .gap(px(12.))
            .child(
                div()
                    .flex_none()
                    .w(px(look::FLOW_LABEL_WIDTH))
                    .pt(px(8.))
                    .child(g.label.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .gap(px(8.))
                    .children(cards)
                    // a third each, as the design's grid of three (one card stays a third)
                    .children(
                        (g.cards.len()..3).map(|_| div().flex_1().min_w_0().into_any_element()),
                    ),
            )
            .into_any_element()
    }
}

/// A labelled value (Repository, Story): the label, then a box with the value and a dim hint.
fn value_row(v: &Value) -> AnyElement {
    div()
        .mt(px(10.))
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .flex_none()
                .w(px(look::FLOW_LABEL_WIDTH))
                .child(v.label.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h(px(look::BUTTON_HEIGHT))
                .px(px(9.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(look::FIELD_ARC))
                .bg(look::FIELD_BG)
                .border_1()
                .border_color(look::FIELD_BORDER)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(v.value.clone()),
                )
                .children(v.hint.clone().map(|h| {
                    div()
                        .flex_none()
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(h)
                })),
        )
        .into_any_element()
}

/// A row's name takes at most 60 % of it.
fn relative_name() -> gpui_kit::DefiniteLength {
    gpui_kit::relative(0.6)
}

fn section_frame(separated: bool) -> gpui_kit::Div {
    div()
        .flex()
        .flex_col()
        .pt(px(look::FLOW_SECTION_PAD_TOP))
        .pb(px(look::FLOW_SECTION_PAD_BOTTOM))
        .px(px(look::FLOW_SECTION_PAD_X))
        .when(separated, |d| d.border_t_1().border_color(look::SEPARATOR))
}

fn heading(text: SharedString, note: Option<SharedString>) -> gpui_kit::Div {
    div()
        .mb(px(8.))
        .flex()
        .items_baseline()
        .gap(px(8.))
        .child(div().font_weight(FontWeight::SEMIBOLD).child(text))
        .children(note.map(|n| {
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(n)
        }))
}
