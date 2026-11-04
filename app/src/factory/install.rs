//! The install's strip (`abe/packages/ui/src/chat/install-parts.ts`), one dim line under the
//! header of the repo's Abe chat: `Install`, its state, `Join` on a teammate's install, a mark
//! (and name, unless compact) per part, `Files N` at the right; under it what a click unfolded:
//! a part's last check with Re-check and Do again, or the files the install wrote. Props in,
//! pixels out: a click names its id (`install:part:<part>`, `install:files`, `install:file:<n>`,
//! a button's `install:recheck:<part>`, `install:again:<part>`).

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    Styled as _, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, hue, selector};
use super::protocol::Hue;
use crate::kit::TextButton;
use crate::look;

/// The kinds of the set (`INSTALL_KINDS`).
pub const KINDS: &[&str] = &["InstallParts"];

/// px: the strip's side padding, its line's height, the gap between its chips, a file's row,
/// a button's height.
const PAD: f32 = 12.;
const LINE_H: f32 = 24.;
const CHIP_GAP: f32 = 10.;
const FILE_H: f32 = 20.;
const BUTTON_H: f32 = 20.;

/// Words in a hue (the state, Join).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Tinted {
    pub text: String,
    pub hue: Hue,
}

/// A button, or a file under the strip: its click is its id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
}

/// A part on the strip: its mark in its hue, its name; `open`: its line unfolded.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Chip {
    pub id: String,
    pub glyph: String,
    pub hue: Hue,
    pub name: String,
    #[serde(default)]
    pub open: bool,
}

/// `Files N`: its click unfolds the files.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct FilesChip {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub open: bool,
}

/// What unfolds under the strip: a part's last check with its buttons, or the files.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Unfolded {
    Part {
        glyph: String,
        hue: Hue,
        name: String,
        tag: Option<String>,
        line: String,
        actions: Vec<Action>,
    },
    Files {
        files: Vec<Action>,
    },
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PartsProps {
    pub title: String,
    pub state: Tinted,
    pub join: Option<Tinted>,
    pub parts: Vec<Chip>,
    pub files: Option<FilesChip>,
    pub unfolded: Option<Unfolded>,
    /// A narrow column: the marks without names.
    #[serde(default)]
    pub compact: bool,
}

/// One of the set, by its kind.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Parts(PartsProps),
}

impl Part {
    pub fn decode<'de, D: serde::Deserializer<'de>>(
        kind: &str,
        props: D,
    ) -> Result<Part, D::Error> {
        use serde::de::Error as _;
        match kind {
            "InstallParts" => Ok(Part::Parts(serde::Deserialize::deserialize(props)?)),
            _ => Err(D::Error::custom(format!(
                "not an install component: {kind}"
            ))),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Part::Parts(_) => "InstallParts",
        }
    }
}

pub fn part(id: Option<&str>, p: &Part, drawn: &mut Drawn) -> AnyElement {
    match p {
        Part::Parts(p) => strip(id, p, drawn),
    }
}

fn text(s: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .min_w_0()
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .child(s.into())
}

/// A badge in its hue (the DS `vs-badge`).
fn badge(b: &Tinted) -> gpui_kit::Div {
    let c = hue(b.hue);
    text(b.text.clone())
        .flex_none()
        .px(px(5.))
        .rounded(px(4.))
        .bg(look::abe_badge_bg(c))
        .text_color(c)
}

/// What its click unfolds or opens (`install:part:board` drawn as `install-part-board`): dim,
/// brighter on hover and while open.
fn toggle(id: &str, open: bool, drawn: &Drawn) -> gpui_kit::Div {
    let sel = id.replace(':', "-");
    clickable(
        div()
            .debug_selector(move || sel)
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(3.))
            .rounded(px(3.))
            .text_color(if open { look::TEXT } else { look::TEXT_DIM })
            .when(open, |d| d.bg(look::HOVER_BG))
            .hover(|s| s.text_color(look::TEXT)),
        Some(id),
        drawn,
    )
}

/// A part's chip: its mark in its hue, its name unless compact.
fn chip(c: &Chip, compact: bool, drawn: &mut Drawn) -> gpui_kit::Div {
    drawn.add("InstallPart", format!("{} {}", c.glyph, c.name));
    toggle(&c.id, c.open, drawn)
        .child(
            div()
                .text_color(hue(c.hue))
                .child(SharedString::from(c.glyph.clone())),
        )
        .when(!compact, |d| d.child(SharedString::from(c.name.clone())))
}

fn button(a: &Action, drawn: &mut Drawn) -> TextButton {
    drawn.add("InstallAction", a.label.clone());
    let sink = drawn.sink.clone();
    let click = a.id.clone();
    TextButton::new(SharedString::from(a.id.clone()), a.label.clone())
        .small(BUTTON_H)
        .on_click(move |_, window, cx| {
            if let Some(sink) = &sink {
                sink.click(click.clone(), window, cx);
            }
        })
}

/// What unfolded under the line: a part's mark, name and tag, its line (wrapped) and its buttons
/// at the right; or the files, a row each.
fn unfolded(u: &Unfolded, drawn: &mut Drawn) -> AnyElement {
    let at = div()
        .debug_selector(|| "install-unfolded".into())
        .w_full()
        .min_w_0()
        .px(px(PAD))
        .pb(px(6.));
    match u {
        Unfolded::Part {
            glyph,
            hue: h,
            name,
            tag,
            line,
            actions,
        } => {
            drawn.add("InstallLine", format!("{glyph} {name}: {line}"));
            let actions: Vec<TextButton> = actions.iter().map(|a| button(a, drawn)).collect();
            let head = format!("{glyph} {name}");
            at.flex()
                .items_start()
                .gap(px(8.))
                .child(
                    div()
                        .debug_selector(|| "install-unfolded-line".into())
                        .flex_1()
                        .min_w_0()
                        .line_height(px(FILE_H))
                        .child(
                            div()
                                .flex()
                                .gap(px(6.))
                                .child(div().text_color(hue(*h)).child(SharedString::from(head)))
                                .when_some(tag.clone(), |d, t| d.child(SharedString::from(t))),
                        )
                        .child(
                            div()
                                .text_color(look::TEXT)
                                .child(SharedString::from(line.clone())),
                        ),
                )
                .child(div().flex_none().flex().gap(px(4.)).children(actions))
                .into_any_element()
        }
        Unfolded::Files { files } => {
            let rows: Vec<AnyElement> = files
                .iter()
                .map(|f| {
                    drawn.add("InstallFile", f.label.clone());
                    toggle(&f.id, false, drawn)
                        .h(px(FILE_H))
                        .flex_shrink(1.)
                        .min_w_0()
                        .child(text(f.label.clone()))
                        .into_any_element()
                })
                .collect();
            if rows.is_empty() {
                drawn.add("InstallFile", NO_FILES);
            }
            at.flex()
                .flex_col()
                .items_start()
                .when(rows.is_empty(), |d| d.child(text(NO_FILES)))
                .children(rows)
                .into_any_element()
        }
    }
}

/// The files unfolded before the install wrote any.
const NO_FILES: &str = "No files written yet";

fn strip(id: Option<&str>, p: &PartsProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("InstallParts", p.title.clone());
    drawn.add("InstallState", p.state.text.clone());
    if let Some(j) = &p.join {
        drawn.add("InstallJoin", j.text.clone());
    }
    let sel = selector("InstallParts", ix, id);
    let chips: Vec<gpui_kit::Div> = p.parts.iter().map(|c| chip(c, p.compact, drawn)).collect();
    let files = p.files.as_ref().map(|f| {
        drawn.add("InstallFiles", f.text.clone());
        toggle(&f.id, f.open, drawn).child(SharedString::from(f.text.clone()))
    });
    let under = p.unfolded.as_ref().map(|u| unfolded(u, drawn));
    div()
        .debug_selector(move || sel)
        .w_full()
        .min_w_0()
        .flex()
        .flex_col()
        .border_b_1()
        .border_color(look::BORDER.rgba())
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(
            div()
                .debug_selector(|| "install-line".into())
                .h(px(LINE_H))
                .px(px(PAD - 3.))
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(CHIP_GAP))
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .pl(px(3.))
                        .child(
                            text(p.title.clone())
                                .flex_none()
                                .font_weight(FontWeight::MEDIUM),
                        )
                        .child(
                            text(p.state.text.clone())
                                .flex_none()
                                .text_color(hue(p.state.hue)),
                        )
                        .when_some(p.join.as_ref(), |d, j| d.child(badge(j))),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .flex()
                        .items_center()
                        .gap(px(if p.compact { 2. } else { CHIP_GAP - 4. }))
                        .children(chips),
                )
                .children(files),
        )
        .children(under)
        .into_any_element()
}
