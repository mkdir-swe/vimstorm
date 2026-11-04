//! A prototype's page (`abe/packages/ui/src/prototype/prototype-components.ts`, design B · Tiles),
//! the main slot on a prototype's tile: Preview (its URL bar over the app: the prototype proxy's
//! page in a BrowserView in `app` mode, or the app on its fixed ports in `open` mode, the node's
//! child, at the viewport's width; 390 draws a
//! phone's frame; or Starting the app…, the app did not start, Stopped with its last screenshot
//! dimmed), Code (the files it changed, the picked one's diff, its screenshots) and Logs (the
//! start script's output, then what the proxy refused). Props in, pixels out: every word and
//! state is the screen's; a click names the node's ids (`proto:reload`, `proto:viewport:390`,
//! `proto:file:2`, an action's own id).

use std::path::PathBuf;

use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement as _, IntoElement as _, ObjectFit,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, div, img, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, hue, node, selector};
use super::protocol::{Hue, Node};
use super::select;
use crate::kit::TextButton;
use crate::look;
use crate::render::EDITOR_FONT;

/// The URL bar's height: a tool window header's.
const BAR_H: look::Met = look::TOOL_WINDOW_HEADER_HEIGHT;
/// A phone's frame round the page (390 px wide): its edge and corner.
const PHONE_EDGE: f32 = 10.;
const PHONE_ARC: f32 = 28.;
/// The Code page's file list.
const FILES_W: f32 = 240.;
const ROW_H: f32 = 24.;
const SHOT_H: f32 = 90.;

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Viewport {
    pub id: String,
    pub label: String,
    pub on: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub keys: String,
    #[serde(default)]
    pub primary: bool,
}

/// The Preview's URL bar.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Bar {
    pub host: String,
    pub path: String,
    pub viewports: Vec<Viewport>,
    pub reload: String,
    pub open: String,
    #[serde(default)]
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Step {
    pub mark: String,
    pub hue: Hue,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct File {
    pub id: String,
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub selected: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Shot {
    pub id: String,
    pub path: String,
    pub what: String,
}

/// What the page shows under its bar.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Body {
    /// The app: the node's BrowserView at `width` px (none: the whole width), in a phone's frame.
    Live {
        width: Option<f32>,
        phone: bool,
        /// The page has the keys: `keys in the app · Esc gives them back`.
        keys: bool,
    },
    Starting {
        title: String,
        steps: Vec<Step>,
        note: String,
    },
    Failed {
        title: String,
        lines: Vec<String>,
        hint: String,
        actions: Vec<Action>,
    },
    Stopped {
        title: String,
        /// Its last screenshot (absolute); empty: none.
        shot: String,
        line: String,
        actions: Vec<Action>,
    },
    Code {
        files: Vec<File>,
        lines: Vec<String>,
        shots: Vec<Shot>,
        note: String,
    },
    Logs {
        log: Vec<String>,
        refused: Vec<String>,
        note: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageName {
    Preview,
    Code,
    Logs,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Props {
    pub page: PageName,
    pub bar: Option<Bar>,
    pub body: Body,
}

/// The page: its bar (the Preview's) over its body, filling the slot.
pub fn page(
    id: Option<&str>,
    p: &Props,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add(
        "PrototypePage",
        match p.page {
            PageName::Preview => "preview",
            PageName::Code => "code",
            PageName::Logs => "logs",
        },
    );
    let sel = selector("PrototypePage", ix, id);
    let bar = p.bar.as_ref().map(|b| url_bar(b, drawn));
    let body = match &p.body {
        Body::Live { width, phone, keys } => live(*width, *phone, *keys, children, drawn, cx),
        Body::Starting { title, steps, note } => starting(title, steps, note, drawn),
        Body::Failed {
            title,
            lines,
            hint,
            actions,
        } => failed(title, lines, hint, actions, drawn),
        Body::Stopped {
            title,
            shot,
            line,
            actions,
        } => stopped(title, shot, line, actions, drawn),
        Body::Code {
            files,
            lines,
            shots,
            note,
        } => code(files, lines, shots, note, drawn),
        Body::Logs { log, refused, note } => logs(log, refused, note, drawn),
    };
    div()
        .debug_selector(move || sel)
        .size_full()
        .min_h_0()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(look::ISLAND_ARC.get()))
        .bg(look::EDITOR_BG)
        .children(bar)
        .child(div().flex_1().min_h_0().relative().child(body))
        .into_any_element()
}

fn dim(s: impl Into<SharedString>) -> gpui_kit::Div {
    div().text_color(look::TEXT_DIM).child(select::text(s))
}

fn mono(s: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .font_family(EDITOR_FONT)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .whitespace_nowrap()
        .child(select::text(s))
}

/// A row of buttons, each a click on its id.
fn buttons(rows: &[Action], drawn: &mut Drawn) -> gpui_kit::Div {
    let buttons: Vec<TextButton> = rows
        .iter()
        .map(|a| {
            drawn.add("PrototypeAction", a.label.clone());
            let sink = drawn.sink.clone();
            let click = a.id.clone();
            TextButton::new(SharedString::from(a.id.clone()), a.label.clone())
                .key(a.keys.clone())
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
}

/// A glyph button of the bar (reload, ↗), a click on `id`.
fn glyph(id: &str, glyph: &'static str, tip: &'static str, drawn: &mut Drawn) -> AnyElement {
    let sel = format!("prototype-bar-{}", id.rsplit(':').next().unwrap_or(id));
    clickable(
        div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel.clone())
            .flex_none()
            .w(px(24.))
            .h(px(22.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(look::ABE_CARD_ARC))
            .text_color(look::TEXT_DIM)
            .hover(|d| d.bg(look::ABE_LANE_BG))
            .tooltip(crate::kit::tooltip(tip, None))
            .child(glyph),
        Some(id),
        drawn,
    )
    .into_any_element()
}

/// Reload, the address (host dim, path bright), the viewports, the actions, ↗.
fn url_bar(b: &Bar, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PrototypeBar", format!("{}{}", b.host, b.path));
    let reload = glyph(&b.reload, "↻", "Reload · r", drawn);
    let open = glyph(&b.open, "↗", "Open in browser · o", drawn);
    let seg: Vec<AnyElement> = b
        .viewports
        .iter()
        .map(|v| {
            if v.on {
                drawn.add("PrototypeViewport", v.label.clone());
            }
            let sel = format!("prototype-viewport-{}", v.label);
            clickable(
                div()
                    .debug_selector(move || sel.clone())
                    .px(px(8.))
                    .h(px(20.))
                    .flex()
                    .items_center()
                    .rounded(px(look::ABE_CARD_ARC))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .when(v.on, |d| d.bg(look::ABE_LANE_BG).text_color(look::TEXT))
                    .when(!v.on, |d| d.text_color(look::TEXT_DIM))
                    .child(SharedString::from(v.label.clone())),
                Some(&v.id),
                drawn,
            )
            .into_any_element()
        })
        .collect();
    div()
        .debug_selector(|| "prototype-bar".into())
        .flex_none()
        .h(px(BAR_H.get()))
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .border_b_1()
        .border_color(look::SEPARATOR)
        .child(reload)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h(px(22.))
                .px(px(8.))
                .flex()
                .items_center()
                .overflow_hidden()
                .rounded(px(look::ABE_CARD_ARC))
                .border_1()
                .border_color(look::BORDER)
                .child(mono(b.host.clone()).text_color(look::TEXT_DIM))
                .child(mono(b.path.clone()).text_color(look::TEXT)),
        )
        .child(
            div()
                .flex_none()
                .flex()
                .gap(px(2.))
                .p(px(1.))
                .rounded(px(look::ABE_CARD_ARC))
                .border_1()
                .border_color(look::BORDER)
                .children(seg),
        )
        .child(buttons(&b.actions, drawn))
        .child(open)
        .into_any_element()
}

/// The app at the viewport's width, centred (Fit: all of it), a phone's frame round 390.
fn live(
    width: Option<f32>,
    phone: bool,
    keys: bool,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let kids: Vec<AnyElement> = children.iter().map(|c| node(c, drawn, cx)).collect();
    let frame = div()
        .debug_selector(|| "prototype-frame".into())
        .relative()
        .h_full()
        .min_h_0()
        .flex()
        .flex_col()
        .overflow_hidden()
        .children(kids);
    // the page itself is `width` wide: a phone's edge goes round it
    let edge = if phone { 2. * PHONE_EDGE } else { 0. };
    let frame = match width {
        Some(w) => frame.flex_none().w(px(w + edge)),
        None => frame.flex_1().w_full(),
    };
    let frame = if phone {
        frame
            .border(px(PHONE_EDGE))
            .border_color(look::ABE_LANE_BG)
            .rounded(px(PHONE_ARC))
    } else {
        frame
    };
    let flag = keys.then(|| {
        drawn.add("PrototypeKeys", "in the app");
        div()
            .debug_selector(|| "prototype-keys".into())
            .absolute()
            .right(px(10.))
            .bottom(px(10.))
            .px(px(8.))
            .py(px(3.))
            .rounded(px(look::ABE_CARD_ARC))
            .bg(look::abe_badge_bg(look::ABE_ACCENT.rgba()))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::ABE_ACCENT)
            .child("keys in the app · Esc gives them back")
    });
    div()
        .size_full()
        .flex()
        .justify_center()
        .when(phone, |d| d.py(px(12.)))
        .bg(if width.is_some() {
            look::ABE_CARD_BG
        } else {
            look::EDITOR_BG
        })
        .child(frame)
        .children(flag)
        .into_any_element()
}

/// A state's column, centred in the body.
fn center() -> gpui_kit::Div {
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.))
        .p(px(24.))
}

fn big(s: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .text_size(px(16.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(select::text(s))
}

fn starting(title: &str, steps: &[Step], note: &str, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PrototypeState", title.to_owned());
    let rows = steps.iter().map(|s| {
        drawn.add("PrototypeStep", s.text.clone());
        div()
            .flex()
            .gap(px(8.))
            .child(
                div()
                    .w(px(14.))
                    .text_color(hue(s.hue))
                    .child(s.mark.clone()),
            )
            .child(
                div()
                    .text_color(look::TEXT)
                    .child(select::text(s.text.clone())),
            )
    });
    center()
        .child(big(title.to_owned()))
        .child(div().flex().flex_col().gap(px(4.)).children(rows))
        .when(!note.is_empty(), |d| d.child(dim(note.to_owned())))
        .into_any_element()
}

/// Log lines in the editor font, an error's in red.
fn log_block(lines: &[String]) -> gpui_kit::Div {
    div()
        .w_full()
        .max_w(px(720.))
        .p(px(10.))
        .rounded(px(look::ABE_LANE_ARC))
        .bg(look::ABE_CARD_BG)
        .border_1()
        .border_color(look::BORDER)
        .font_family(EDITOR_FONT)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .flex()
        .flex_col()
        .children(lines.iter().map(|l| {
            let bad = l.contains("Error") || l.contains("error:");
            div()
                .text_color(if bad { look::ABE_BAD } else { look::TEXT })
                .child(select::text(l.clone()))
        }))
}

fn failed(
    title: &str,
    lines: &[String],
    hint: &str,
    actions: &[Action],
    drawn: &mut Drawn,
) -> AnyElement {
    drawn.add("PrototypeState", title.to_owned());
    center()
        .justify_start()
        .child(big(title.to_owned()).text_color(look::ABE_BAD))
        .when(!lines.is_empty(), |d| d.child(log_block(lines)))
        .when(!hint.is_empty(), |d| d.child(dim(hint.to_owned())))
        .child(buttons(actions, drawn))
        .into_any_element()
}

fn stopped(
    title: &str,
    shot: &str,
    line: &str,
    actions: &[Action],
    drawn: &mut Drawn,
) -> AnyElement {
    drawn.add("PrototypeState", title.to_owned());
    let picture = (!shot.is_empty()).then(|| {
        drawn.add("PrototypeShot", shot.to_owned());
        div()
            .debug_selector(|| "prototype-last-shot".into())
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .opacity(0.35)
            .child(
                img(PathBuf::from(shot))
                    .size_full()
                    .object_fit(ObjectFit::Cover)
                    .with_fallback(|| div().into_any_element()),
            )
    });
    div()
        .size_full()
        .relative()
        .children(picture)
        .child(
            center()
                .absolute()
                .top_0()
                .left_0()
                .child(big(title.to_owned()))
                .child(buttons(actions, drawn))
                .when(!line.is_empty(), |d| {
                    d.child(mono(line.to_owned()).text_color(look::TEXT_DIM))
                }),
        )
        .into_any_element()
}

/// The files it changed (left), the picked one's diff, its screenshots under the files.
fn code(
    files: &[File],
    lines: &[String],
    shots: &[Shot],
    note: &str,
    drawn: &mut Drawn,
) -> AnyElement {
    let rows: Vec<AnyElement> = files
        .iter()
        .map(|f| {
            drawn.add("PrototypeFile", f.path.clone());
            let name = f.path.rsplit('/').next().unwrap_or(&f.path).to_owned();
            clickable(
                div()
                    .h(px(ROW_H))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .when(f.selected, |d| d.bg(look::ABE_LANE_BG))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .child(name),
                    )
                    .child(mono(format!("+{} −{}", f.added, f.removed)).text_color(look::ABE_GOOD)),
                Some(&f.id),
                drawn,
            )
            .into_any_element()
        })
        .collect();
    let thumbs: Vec<AnyElement> = shots
        .iter()
        .map(|s| {
            drawn.add("PrototypeThumb", s.what.clone());
            clickable(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .h(px(SHOT_H))
                            .w_full()
                            .rounded(px(look::ABE_CARD_ARC))
                            .border_1()
                            .border_color(look::BORDER)
                            .overflow_hidden()
                            .child(
                                img(PathBuf::from(s.path.clone()))
                                    .size_full()
                                    .object_fit(ObjectFit::Cover)
                                    .with_fallback(|| div().into_any_element()),
                            ),
                    )
                    .child(dim(s.what.clone()).text_size(px(look::UI_SMALL_FONT_SIZE))),
                Some(&s.id),
                drawn,
            )
            .into_any_element()
        })
        .collect();
    let caption = |s: String| {
        div()
            .px(px(12.))
            .pt(px(8.))
            .pb(px(4.))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::ABE_WARN)
            .child(s)
    };
    let left = div()
        .id("prototype-files")
        .debug_selector(|| "prototype-files".into())
        .flex_none()
        .w(px(FILES_W))
        .h_full()
        .overflow_y_scroll()
        .border_r_1()
        .border_color(look::SEPARATOR)
        .child(caption(format!("Changed · {}", files.len())))
        .children(rows)
        .when(!shots.is_empty(), |d| {
            d.child(caption(format!("Screenshots · {}", shots.len())))
                .child(
                    div()
                        .px(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .children(thumbs),
                )
        });
    let diff = div()
        .id("prototype-diff")
        .debug_selector(|| "prototype-diff".into())
        .flex_1()
        .min_w_0()
        .h_full()
        .overflow_y_scroll()
        .p(px(12.))
        .font_family(EDITOR_FONT)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .when(lines.is_empty() && !note.is_empty(), |d| {
            d.child(dim(note.to_owned()))
        })
        .children(lines.iter().map(|l| {
            let d = div().whitespace_nowrap().child(select::text(l.clone()));
            match l.chars().next() {
                Some('+') => d.bg(look::DIFF_INSERTED_BG),
                Some('-') => d.bg(look::DIFF_DELETED_BG),
                Some('@') => d.text_color(look::TEXT_DIM),
                _ => d,
            }
        }));
    div()
        .size_full()
        .flex()
        .child(left)
        .child(diff)
        .into_any_element()
}

/// The start script's output, then the hosts the proxy refused.
fn logs(log: &[String], refused: &[String], note: &str, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PrototypeLog", log.len().to_string());
    div()
        .id("prototype-logs")
        .debug_selector(|| "prototype-logs".into())
        .size_full()
        .overflow_y_scroll()
        .p(px(12.))
        .flex()
        .flex_col()
        .gap(px(8.))
        .when(log.is_empty() && !note.is_empty(), |d| {
            d.child(dim(note.to_owned()))
        })
        .when(!log.is_empty(), |d| d.child(log_block(log).max_w_full()))
        .child(
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::ABE_WARN)
                .child(format!("Refused · {}", refused.len())),
        )
        .children(
            refused
                .iter()
                .map(|r| mono(r.clone()).text_color(look::TEXT_DIM)),
        )
        .into_any_element()
}
