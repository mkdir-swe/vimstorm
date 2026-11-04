//! The flow dialog (LocalCloudPopups, decided 21 Oct 2026): a centred dialog in the card-dialog
//! look for a flow with inputs or consequences: a title row (bold title, dim subject, ×), ruled
//! sections (a 600 heading with a dim note, then label / value grid rows, bullet rows or a text
//! area), and a 48 px footer (a dim consequence note left, buttons right, each with its key).
//!
//! In a confirm the primary is `Cancel ⏎` and the risky button is outlined with its letter
//! (`Hand back h`); Esc and ⏎ cancel. With a text area (Start from this workspace's handoff
//! summary) the area has the keyboard: ⏎ presses the primary, ⇧⏎ is a newline.
//!
//! A builder over the one flow dialog primitive ([`super::dialog`]): [`Flow::into_dialog`] gives
//! the dialog it opens ([`super::open_flow`]); its rich lines keep their coloured spans.

use gpui_kit::{Rgba, SharedString};

use super::dialog;
use crate::look;

/// A run of text in a row.
#[derive(Clone, Debug, Default)]
pub struct Span {
    pub text: SharedString,
    pub color: Option<Rgba>,
    pub mono: bool,
    pub bold: bool,
    /// Pressing it answers [`FlowAnswer::Link`] with this id.
    pub link: Option<&'static str>,
}

impl Span {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }
    pub fn dim(text: impl Into<SharedString>) -> Self {
        Self::new(text).color(look::TEXT_DIM.rgba())
    }
    pub fn color(mut self, color: Rgba) -> Self {
        self.color = Some(color);
        self
    }
    pub fn mono(mut self) -> Self {
        self.mono = true;
        self
    }
    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }
    pub fn link(mut self, id: &'static str) -> Self {
        self.link = Some(id);
        self.color = Some(look::LINK.rgba());
        self
    }
}

/// A row of a section.
#[derive(Clone, Debug)]
pub enum Row {
    /// A label in the 96 px column and its value.
    Grid {
        label: SharedString,
        value: Vec<Span>,
    },
    /// A bullet row: its text, and dim words at its end.
    Item { spans: Vec<Span>, end: Vec<Span> },
    /// The dialog's text area, under a label.
    Field { label: SharedString },
    /// A line of text.
    Text(Vec<Span>),
}

#[derive(Clone, Debug, Default)]
pub struct Section {
    pub heading: Option<SharedString>,
    pub note: Option<SharedString>,
    pub rows: Vec<Row>,
}

#[derive(Clone, Debug)]
pub struct Button {
    pub id: &'static str,
    pub label: SharedString,
    /// Its key, drawn after the label: `⏎` or a letter.
    pub key: Option<SharedString>,
    pub primary: bool,
    /// The risky answer: outlined red.
    pub danger: bool,
    pub enabled: bool,
}

impl Button {
    pub fn new(id: &'static str, label: impl Into<SharedString>) -> Self {
        Self {
            id,
            label: label.into(),
            key: None,
            primary: false,
            danger: false,
            enabled: true,
        }
    }
    /// The default: blue, pressed by ⏎.
    pub fn primary(mut self) -> Self {
        self.primary = true;
        self.key = Some("⏎".into());
        self
    }
    /// The risky answer with its letter.
    pub fn risky(mut self, letter: char) -> Self {
        self.danger = true;
        self.key = Some(letter.to_string().into());
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
}

/// A flow dialog to open ([`super::open_flow`]).
#[derive(Clone, Debug, Default)]
pub struct Flow {
    pub title: SharedString,
    /// Dim, after the title (the workspace).
    pub subject: SharedString,
    pub sections: Vec<Section>,
    /// The footer's dim note.
    pub foot: SharedString,
    /// Left to right; one is primary.
    pub buttons: Vec<Button>,
    pub width: f32,
    /// The text area's starting text (a [`Row::Field`] shows it).
    pub field: Option<String>,
}

/// How a flow dialog ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlowAnswer {
    /// A button, with the text area's text when there is one.
    Button(&'static str, Option<String>),
    /// A link span was pressed (the dialog closed).
    Link(&'static str),
    /// Esc, ×, a click outside.
    Cancel,
}

impl Flow {
    /// The dialog as text, for tests: title, then each section's heading and rows, the foot and
    /// the buttons (`[Cancel ⏎]`).
    pub fn lines(&self) -> Vec<String> {
        let words = |spans: &[Span]| {
            spans
                .iter()
                .map(|s| s.text.to_string())
                .collect::<Vec<_>>()
                .join("")
        };
        let mut out = vec![format!("{} · {}", self.title, self.subject)];
        for s in &self.sections {
            if let Some(h) = &s.heading {
                out.push(match &s.note {
                    Some(n) => format!("## {h} · {n}"),
                    None => format!("## {h}"),
                });
            }
            for r in &s.rows {
                out.push(match r {
                    Row::Grid { label, value } => format!("{label}: {}", words(value)),
                    Row::Item { spans, end } => format!("· {}  {}", words(spans), words(end))
                        .trim_end()
                        .into(),
                    Row::Field { label } => format!("{label}: [field]"),
                    Row::Text(spans) => words(spans),
                });
            }
        }
        out.push(format!("-- {}", self.foot));
        out.push(
            self.buttons
                .iter()
                .map(|b| match &b.key {
                    Some(k) => format!("[{} {k}]", b.label),
                    None => format!("[{}]", b.label),
                })
                .collect::<Vec<_>>()
                .join(" "),
        );
        out
    }

    /// The one flow dialog primitive's dialog for it.
    pub fn into_dialog(self) -> dialog::Dialog {
        let lines = Some(self.lines());
        let sections = self
            .sections
            .into_iter()
            .map(|s| dialog::Section {
                heading: s.heading.unwrap_or_default(),
                note: s.note,
                rich: s
                    .rows
                    .into_iter()
                    .map(|r| match r {
                        Row::Grid { label, value } => dialog::Rich::Grid { label, value },
                        Row::Item { spans, end } => dialog::Rich::Item { spans, end },
                        Row::Field { label } => dialog::Rich::Field { label },
                        Row::Text(spans) => dialog::Rich::Text(spans),
                    })
                    .collect(),
                ..Default::default()
            })
            .collect();
        let buttons = self
            .buttons
            .into_iter()
            .map(|b| {
                let look = if b.primary {
                    dialog::Look::Primary
                } else if b.danger {
                    dialog::Look::Danger
                } else {
                    dialog::Look::Plain
                };
                let mut out = dialog::Button::new(b.id, b.label, look).enabled(b.enabled);
                out.key = b.key;
                out
            })
            .collect();
        dialog::Dialog {
            id: "flow",
            title: self.title,
            subtitle: (!self.subject.is_empty()).then_some(self.subject),
            width: if self.width > 0. { self.width } else { 600. },
            field: self.field.map(|text| dialog::Field {
                text,
                ..Default::default()
            }),
            sections,
            note: (!self.foot.is_empty()).then_some(self.foot),
            buttons,
            lines,
            notes: Vec::new(),
        }
    }
}

/// A dialog's answer as a flow's.
pub(super) fn answer_of(a: Option<dialog::Answer>, field: bool) -> FlowAnswer {
    match a {
        None => FlowAnswer::Cancel,
        Some(a) if a.link => FlowAnswer::Link(a.id),
        Some(a) if a.id == "cancel" => FlowAnswer::Cancel,
        Some(a) => FlowAnswer::Button(a.id, field.then_some(a.text)),
    }
}
