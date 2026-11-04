//! Local mode's own components (`abe/packages/ui/src/board/local-components.ts`; boards LM-Board,
//! LM-PR): the band over the Board while local mode is on, and a local pull request (`#L3`) in
//! the Board's place. Both dashed or marked in the path hue (`--abe-path`) with the house mark
//! ([`house`], also the dashed card's, badge's and Held writes' mark). Props in, pixels out: a
//! click names a band link's `id`, a pull request's buttons `local-pr:merge` / `local-pr:discard`,
//! its `Diff` `local-pr:diff`, a file row `local-pr:file:<n>` (1-based); nothing else of them is
//! a click.

use gpui_kit::{
    AnyElement, Bounds, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, PathBuilder, Pixels, Rgba, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, canvas, div, point, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::{Drawn, clickable, hue, selector};
use super::protocol::Hue;
use crate::kit::TextButton;
use crate::look;
use crate::render::EDITOR_FONT;

/// Held cards' ids start past this (mirrors core's `LOCAL_FLOOR`, `local-names.ts`).
pub const LOCAL_FLOOR: u64 = 900_000_000;

/// A card's name after `#`: a held card (made in local mode) `LC1`, else its number.
pub fn card_name(id: u64) -> String {
    if id > LOCAL_FLOOR {
        format!("LC{}", id - LOCAL_FLOOR)
    } else {
        id.to_string()
    }
}

/// px (LM-Board): the band's height, padding, gap, its gap to the Board, its radius.
const BAND_H: f32 = 30.;
const BAND_PAD_X: f32 = 12.;
const BAND_GAP: f32 = 12.;
const BAND_BELOW: f32 = 6.;
const BAND_ARC: f32 = 8.;
/// px: the house mark beside words, and its gap to them.
pub const HOUSE: f32 = 12.;
pub const HOUSE_GAP: f32 = 4.;
/// px (LM-PR): the head's height and padding, the body's padding, the title, a caption, the
/// gaps between the parts, the body box's padding and line, the buttons' height.
const HEAD_H: f32 = 34.;
const HEAD_PAD_L: f32 = 14.;
const HEAD_PAD_R: f32 = 10.;
const PAGE_PAD_Y: f32 = 18.;
const PAGE_PAD_X: f32 = 24.;
const TITLE_SIZE: f32 = 20.;
const CAPTION_SIZE: f32 = 11.;
const PART_GAP: f32 = 14.;
const UNDER_GAP: f32 = 6.;
const CHECK_GAP: f32 = 14.;
const BODY_PAD_Y: f32 = 10.;
const BODY_PAD_X: f32 = 12.;
const BODY_LINE_H: f32 = 20.;
const BODY_ARC: f32 = 8.;
const BUTTON_H: f32 = 26.;
const ACTIONS_GAP: f32 = 16.;
/// px: a file's or commit's row, the gap between its words, the Diff button's height.
const ROW_H: f32 = 22.;
const ROW_GAP: f32 = 8.;
const DIFF_H: f32 = 20.;

/// The house mark (`M2.5 7.5 8 3l5.5 4.5V13…`, the boards' 16-unit path, stroke 1.4) at `size`
/// px in `color`.
pub fn house(size: f32, color: Rgba) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |b: Bounds<Pixels>, _, window: &mut Window, _| {
            let s = size / 16.;
            let o = b.origin;
            let p = |x: f32, y: f32| point(o.x + px(x * s), o.y + px(y * s));
            let stroke = px(1.4 * s);
            let mut roof = PathBuilder::stroke(stroke);
            roof.move_to(p(2.5, 7.5));
            roof.line_to(p(8., 3.));
            roof.line_to(p(13.5, 7.5));
            roof.line_to(p(13.5, 13.));
            roof.line_to(p(13., 13.5));
            roof.line_to(p(3., 13.5));
            roof.line_to(p(2.5, 13.));
            roof.close();
            if let Ok(path) = roof.build() {
                window.paint_path(path, color);
            }
            let mut door = PathBuilder::stroke(stroke);
            door.move_to(p(6.5, 13.5));
            door.line_to(p(6.5, 9.5));
            door.line_to(p(9.5, 9.5));
            door.line_to(p(9.5, 13.5));
            if let Ok(path) = door.build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .w(px(size))
    .h(px(size))
    .into_any_element()
}

/// A band link: its words, its click.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BandLink {
    pub id: String,
    pub label: String,
}

/// The band over the Board (`LocalBand`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BandProps {
    pub lead: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<BandLink>,
}

/// One check of a local pull request (`✓ tests`), its glyph in its hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Check {
    pub name: String,
    pub glyph: String,
    pub hue: Hue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Focus {
    Merge,
    Discard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct Actions {
    pub focus: Focus,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Done {
    pub text: String,
    pub hue: Hue,
}

/// A changed file's status letter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum FileStatus {
    A,
    M,
    D,
    R,
}

/// One changed file of a local pull request: `M +24 −3 src/x.ts`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct File {
    pub path: String,
    pub status: FileStatus,
    pub added: u64,
    pub removed: u64,
}

/// One commit of a local pull request: its short sha and subject.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
}

/// A local pull request (`LocalPullRequest`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PullRequestProps {
    pub name: String,
    pub line: String,
    pub title: String,
    pub about: String,
    #[serde(default)]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub files: Vec<File>,
    /// A `Diff` button at the right of the Files caption.
    #[serde(default)]
    pub diff: bool,
    #[serde(default)]
    pub commits: Vec<Commit>,
    pub body: String,
    pub actions: Option<Actions>,
    pub done: Option<Done>,
    pub note: Option<String>,
    /// The keys are elsewhere: the focused button not the default's blue.
    #[serde(default)]
    pub away: bool,
}

/// The band (LM-Board): 30 high, dashed in the path hue, the house, `**Local mode**: …`, its
/// links at the right in the link colour.
pub fn band(id: Option<&str>, p: &BandProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("LocalBand", format!("{}: {}", p.lead, p.text));
    drawn.add("HouseMark", "LocalBand");
    let sel = selector("LocalBand", ix, id);
    let links: Vec<AnyElement> = p
        .links
        .iter()
        .map(|l| {
            drawn.add("LocalLink", &l.label);
            let lid = l.id.clone();
            let d = div()
                .debug_selector(move || format!("factory-local-link-{lid}"))
                .flex_none()
                .text_color(look::LINK)
                .child(SharedString::from(l.label.clone()));
            clickable(d, Some(&l.id), drawn).into_any_element()
        })
        .collect();
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .h(px(BAND_H))
        .mb(px(BAND_BELOW))
        .px(px(BAND_PAD_X))
        .flex()
        .items_center()
        .gap(px(BAND_GAP))
        .rounded(px(BAND_ARC))
        .border_1()
        .border_dashed()
        .border_color(look::ABE_PATH)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .whitespace_nowrap()
        .child(house(HOUSE, look::ABE_PATH.rgba()))
        .child(
            div()
                .flex_shrink(1.)
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .child(
                    div()
                        .flex()
                        .child(
                            div()
                                .flex_none()
                                .font_weight(FontWeight::BOLD)
                                .child(SharedString::from(p.lead.clone())),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(SharedString::from(format!(": {}", p.text))),
                        ),
                ),
        )
        .child(div().flex_1())
        .children(links);
    d.into_any_element()
}

/// A caption over a part (`CHECKS, RUN HERE`): 600 11 px, dim, upper case.
fn caption(text: &str) -> gpui_kit::Div {
    div()
        .mt(px(PART_GAP))
        .text_size(px(CAPTION_SIZE))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(look::TEXT_DIM)
        .child(SharedString::from(text.to_uppercase()))
}

/// A local pull request (LM-PR): the head (house, `Pull request #L3`, the dim line), then its
/// title, what it is, the checks run here, its files and commits, its body as written, and Merge locally · Discard
/// (or what became of it) with the note at the right.
pub fn pull_request(id: Option<&str>, p: &PullRequestProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("LocalPullRequest", format!("{} {}", p.name, p.title));
    drawn.add("HouseMark", "LocalPullRequest");
    let sel = selector("LocalPullRequest", ix, id);
    let head = div()
        .flex_none()
        .h(px(HEAD_H))
        .pl(px(HEAD_PAD_L))
        .pr(px(HEAD_PAD_R))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_b_1()
        .border_color(look::ISLAND_BORDER)
        .whitespace_nowrap()
        .child(house(HOUSE, look::ABE_PATH.rgba()))
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(look::UI_FONT_SIZE))
                .text_color(look::TEXT)
                .child(SharedString::from(format!("Pull request {}", p.name))),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(p.line.clone())),
        );
    drawn.add("LocalLine", &p.line);
    let checks = (!p.checks.is_empty()).then(|| {
        let marks: Vec<AnyElement> = p
            .checks
            .iter()
            .map(|c| {
                drawn.add("LocalCheck", format!("{} {}", c.glyph, c.name));
                div()
                    .flex_none()
                    .flex()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_color(hue(c.hue))
                            .child(SharedString::from(c.glyph.clone())),
                    )
                    .child(SharedString::from(c.name.clone()))
                    .into_any_element()
            })
            .collect();
        div().child(caption("Checks, run here")).child(
            div()
                .mt(px(UNDER_GAP))
                .flex()
                .flex_wrap()
                .gap(px(CHECK_GAP))
                .text_color(look::TEXT)
                .children(marks),
        )
    });
    let sink = drawn.sink.clone();
    let press = move |click: &'static str| {
        let sink = sink.clone();
        move |_: &gpui_kit::ClickEvent, window: &mut Window, cx: &mut gpui_kit::App| {
            if let Some(sink) = &sink {
                sink.click(click.into(), window, cx);
            }
        }
    };
    let files = (!p.files.is_empty()).then(|| {
        let diff = p.diff.then(|| {
            drawn.add("LocalButton", "Diff");
            let click = "local-pr:diff";
            div()
                .id(SharedString::from(format!("factory-{click}-tip")))
                .debug_selector(move || format!("factory-{click}"))
                .flex_none()
                .tooltip(crate::kit::tooltip("Show Diff", Some("⌘D")))
                // the press is the button's alone, never the island's under it
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    TextButton::new(SharedString::from(format!("factory-{click}")), "Diff")
                        .small(DIFF_H)
                        .on_click(press(click)),
                )
        });
        let rows: Vec<AnyElement> = p
            .files
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let n = i + 1;
                drawn.add(
                    "LocalFile",
                    format!("+{} \u{2212}{} {}", f.added, f.removed, f.path),
                );
                let d = div()
                    .debug_selector(move || format!("factory-local-pr-file-{n}"))
                    .h(px(ROW_H))
                    .flex()
                    .items_center()
                    .gap(px(ROW_GAP))
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex_none()
                            .font_family(EDITOR_FONT)
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(format!("{:?}", f.status))),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(hue(Hue::Good))
                            .child(SharedString::from(format!("+{}", f.added))),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(hue(Hue::Bad))
                            .child(SharedString::from(format!("\u{2212}{}", f.removed))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(look::TEXT)
                            .child(SharedString::from(f.path.clone())),
                    );
                clickable(d, Some(&format!("local-pr:file:{n}")), drawn).into_any_element()
            })
            .collect();
        div()
            .child(
                div()
                    .flex()
                    .items_end()
                    .child(caption("Files"))
                    .child(div().flex_1())
                    .children(diff),
            )
            .child(div().mt(px(UNDER_GAP)).flex().flex_col().children(rows))
    });
    let commits = (!p.commits.is_empty()).then(|| {
        let rows: Vec<AnyElement> = p
            .commits
            .iter()
            .map(|c| {
                drawn.add("LocalCommit", format!("{} {}", c.sha, c.subject));
                div()
                    .h(px(ROW_H))
                    .flex()
                    .items_center()
                    .gap(px(ROW_GAP))
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex_none()
                            .font_family(EDITOR_FONT)
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(c.sha.clone())),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(look::TEXT)
                            .child(SharedString::from(c.subject.clone())),
                    )
                    .into_any_element()
            })
            .collect();
        div()
            .child(caption("Commits"))
            .child(div().mt(px(UNDER_GAP)).flex().flex_col().children(rows))
    });
    let body = (!p.body.is_empty()).then(|| {
        drawn.add("LocalBody", &p.body);
        div().child(caption("Body")).child(
            div()
                .mt(px(UNDER_GAP))
                .py(px(BODY_PAD_Y))
                .px(px(BODY_PAD_X))
                .rounded(px(BODY_ARC))
                .border_1()
                .border_color(look::ISLAND_BORDER)
                .line_height(px(BODY_LINE_H))
                .text_color(look::TEXT)
                .flex()
                .flex_col()
                // white space kept: each line its own, an empty one keeps its height
                .children(p.body.split('\n').map(|l| {
                    div()
                        .min_h(px(BODY_LINE_H))
                        .child(SharedString::from(l.to_owned()))
                })),
        )
    });
    let buttons: Vec<AnyElement> = match (&p.done, p.actions) {
        (Some(d), _) => {
            drawn.add("LocalDone", &d.text);
            vec![
                div()
                    .h(px(BUTTON_H))
                    .flex()
                    .items_center()
                    .text_color(hue(d.hue))
                    .child(SharedString::from(d.text.clone()))
                    .into_any_element(),
            ]
        }
        (None, Some(a)) => {
            let focus = |f: Focus| a.focus == f && !p.away;
            [
                (Focus::Merge, "Merge locally", "local-pr:merge"),
                (Focus::Discard, "Discard", "local-pr:discard"),
            ]
            .into_iter()
            .map(|(f, label, click)| {
                drawn.add("LocalButton", label);
                if a.focus == f {
                    drawn.add(
                        "LocalFocus",
                        format!("{label}{}", if p.away { " away" } else { "" }),
                    );
                }
                div()
                    .debug_selector(move || format!("factory-{click}"))
                    // the press is the button's alone, never the island's under it
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        TextButton::new(SharedString::from(format!("factory-{click}")), label)
                            .small(BUTTON_H)
                            .primary(focus(f))
                            .on_click(press(click)),
                    )
                    .into_any_element()
            })
            .collect()
        }
        (None, None) => Vec::new(),
    };
    let note = p.note.as_ref().map(|n| {
        drawn.add("LocalNote", n);
        div()
            .min_w_0()
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(n.clone()))
    });
    // taller than the view, the page scrolls under its head (the wheel, as the other pages)
    let page = div()
        .id(SharedString::from(format!("{sel}-scroll")))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .py(px(PAGE_PAD_Y))
        .px(px(PAGE_PAD_X))
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(TITLE_SIZE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(SharedString::from(p.title.clone())),
        )
        .child(
            div()
                .mt(px(UNDER_GAP))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(p.about.clone())),
        )
        .children(checks)
        .children(files)
        .children(commits)
        .children(body)
        .when(!buttons.is_empty() || note.is_some(), |d| {
            d.child(
                div()
                    .mt(px(ACTIONS_GAP))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .children(buttons)
                    .child(div().flex_1())
                    .children(note),
            )
        });
    let d = div()
        .debug_selector(move || sel)
        .size_full()
        .flex()
        .flex_col()
        .text_size(px(look::UI_FONT_SIZE))
        .child(head)
        .child(page);
    d.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card's name: a held card's past the floor reads `LC<n>`, any other its number.
    #[test]
    fn a_held_card_reads_lc_past_the_floor() {
        for (id, want) in [
            (1240, "1240"),
            (LOCAL_FLOOR, "900000000"),
            (LOCAL_FLOOR + 1, "LC1"),
            (LOCAL_FLOOR + 42, "LC42"),
        ] {
            assert_eq!(card_name(id), want, "{id}");
        }
    }
}
