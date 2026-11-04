//! The review cards of a PR diff (G15 / G22, DiffViewer "Review comment card"): drawn in the
//! pane under their line, in the blank rows `config/app/review.lua` keeps there (the other pane
//! keeps as many, so the panes stay level). Content from the Git window's review
//! ([`crate::git::window::PrReview`]): a posted thread (each comment, Reply…, Resolve /
//! Reopen, Open in browser), a draft (Edit draft, Post comment now, Delete… asked first), an
//! outdated draft (never moved: Rewrite on line N, Delete…; Submit review waits for it).

use crate::factory::{Drafted, ReviewAsk, ReviewPaneProps, Thread};
use crate::git::window::sha8;
use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Rgba, SharedString, StatefulInteractiveElement as _, Styled as _, div,
    prelude::FluentBuilder as _, px,
};

use super::chrome::PaneFrame;
use super::model::CardSlot;
use crate::git::window::PrReview;
use crate::git::window::{How, Writing};
use crate::kit::Anchor;
use crate::kit::TextButton;
use crate::kit::{Icon, IconName};
use crate::look;
use crate::popups::{self, Menu, MenuItem};
use crate::render::{EDITOR_FONT, UI_FONT};
use crate::shell::SurfaceCx;

/// Only Abe's receipt paragraphs are hidden; the provider's text is kept (`review.lua`'s
/// `display_body`).
pub fn display_body(body: &str) -> String {
    let mut out = body.to_owned();
    for marker in [
        "<!-- vimstorm:comment:",
        "<!-- vimstorm:reply:",
        "<!-- vimstorm-review-v1:",
    ] {
        if let Some(i) = out.rfind(marker)
            && out[i..].trim_end().ends_with("-->")
            && !out[i..].contains('\n')
        {
            out.truncate(i);
        }
    }
    out.trim_end().to_owned()
}

fn badge(text: &str, hue: Rgba) -> AnyElement {
    let mut wash = hue;
    wash.a = look::ABE_BADGE_ALPHA;
    div()
        .flex_none()
        .px(px(5.))
        .rounded(px(look::BUTTON_ARC))
        .bg(wash)
        .text_color(hue)
        .text_size(px(look::PR_SMALL_FONT_SIZE))
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

/// The card's frame: the popup look with its state's hue as a 2 px left edge.
fn frame(id: String, hue: Rgba) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(SharedString::from(id.clone()))
        .debug_selector(move || id.clone())
        .relative()
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .bg(look::POPUP_BG)
        .border_1()
        .border_color(look::SEPARATOR)
        .rounded(px(4.))
        .font_family(UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .line_height(px(18.))
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .bottom_0()
                .w(px(2.))
                .bg(hue),
        )
}

fn head(left: Vec<AnyElement>, right: Vec<AnyElement>) -> AnyElement {
    div()
        .flex_none()
        .h(px(26.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(look::PR_SMALL_FONT_SIZE))
        .whitespace_nowrap()
        .children(left)
        .child(div().flex_1())
        .children(right)
        .into_any_element()
}

fn body(text: &str) -> AnyElement {
    div()
        .px(px(10.))
        .pb(px(8.))
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

fn actions(buttons: Vec<AnyElement>, note: Option<String>) -> AnyElement {
    div()
        .flex_none()
        .mt_auto()
        .px(px(10.))
        .py(px(6.))
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.))
        .border_t_1()
        .border_color(look::SEPARATOR)
        .children(buttons)
        .when_some(note, |d, n| {
            d.child(div().flex_1()).child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(n)),
            )
        })
        .into_any_element()
}

/// A posted thread's card.
fn thread_card(t: &Thread, scx: &SurfaceCx, review: &Entity<PrReview>) -> AnyElement {
    let hue = if t.resolved {
        look::ABE_GOOD
    } else {
        look::SEPARATOR
    };
    let url = t
        .comments
        .first()
        .map(|c| c.url.clone())
        .unwrap_or_default();
    let mut card = frame(format!("review-card-thread-{}", t.id), hue.rgba()).child(head(
        vec![],
        vec![
            badge(
                if t.resolved { "Resolved" } else { "Unresolved" },
                if t.resolved {
                    look::ABE_GOOD.rgba()
                } else {
                    look::ABE_WARN.rgba()
                },
            ),
            div()
                .id(SharedString::from(format!("review-card-open-{}", t.id)))
                .cursor_pointer()
                .on_click(move |_, _, cx| cx.open_url(&url))
                .child(Icon::new(IconName::ExternalLink))
                .into_any_element(),
        ],
    ));
    for (i, c) in t.comments.iter().enumerate() {
        card = card.child(
            div()
                .when(i > 0, |d| {
                    d.border_t_1().border_color(look::SEPARATOR).pt(px(4.))
                })
                .child(
                    div()
                        .px(px(10.))
                        .text_size(px(look::PR_SMALL_FONT_SIZE))
                        .text_color(look::ABE_PERSON)
                        .child(SharedString::from(c.author.clone())),
                )
                .child(body(&display_body(&c.body))),
        );
    }
    let reply = {
        let scx = scx.clone();
        let id = t.id.clone();
        div()
            .id(SharedString::from(format!("review-card-reply-{}", t.id)))
            .debug_selector({
                let id = t.id.clone();
                move || format!("review-card-reply-{id}")
            })
            .flex_1()
            .h(px(look::COMPACT_BUTTON_HEIGHT))
            .px(px(6.))
            .flex()
            .items_center()
            .rounded(px(look::BUTTON_ARC))
            .bg(look::FIELD_BG)
            .border_1()
            .border_color(look::FIELD_BORDER)
            .text_color(look::PLACEHOLDER)
            .cursor_pointer()
            .on_click(move |_, _, _| {
                scx.call("config.app.review", "reply", vec![id.as_str().into()])
            })
            .child("Reply…")
            .into_any_element()
    };
    let mut buttons = Vec::new();
    if t.can_reply {
        buttons.push(reply);
    }
    if t.can_resolve {
        let review = review.downgrade();
        let (id, resolved) = (t.id.clone(), t.resolved);
        buttons.push(
            TextButton::new(
                SharedString::from(format!("review-card-resolve-{}", t.id)),
                if resolved { "Reopen" } else { "Resolve" },
            )
            .compact(true)
            .on_click(move |_, _, cx| {
                let _ = review.update(cx, |r, cx| {
                    r.ask(
                        ReviewAsk::Resolve {
                            thread: id.clone(),
                            resolved: !resolved,
                        },
                        cx,
                    )
                });
            })
            .into_any_element(),
        );
    }
    card.when(!buttons.is_empty(), |c| c.child(actions(buttons, None)))
        .into_any_element()
}

/// Delete…: asked first, Cancel the default (RULES 18).
fn ask_delete(
    seq: u64,
    review: gpui_kit::WeakEntity<PrReview>,
    window: &mut gpui_kit::Window,
    cx: &mut App,
) {
    let menu = Menu::new(
        vec![
            MenuItem::new("Cancel").into(),
            MenuItem::new("Delete draft").into(),
        ],
        Anchor::Point(window.mouse_position()),
    )
    .title("Delete this draft?");
    popups::open_menu(menu, window, cx, move |choice, _, cx| {
        if choice == Some(1) {
            let _ = review.update(cx, |r, cx| r.ask(ReviewAsk::Delete { seq }, cx));
        }
    });
}

/// A draft's card, or an outdated draft's.
fn draft_card(
    d: &Drafted,
    outdated: bool,
    base_head: Option<(String, String)>,
    scx: &SurfaceCx,
    review: &Entity<PrReview>,
) -> AnyElement {
    let hue = if outdated {
        look::ABE_BAD
    } else {
        look::ABE_WARN
    };
    let seq = d.seq;
    let written = d.head.as_deref().map(sha8).unwrap_or("an earlier head");
    let left = if outdated {
        vec![
            badge("✗ Outdated draft", look::ABE_BAD.rgba()),
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(format!(
                    "written on line {} at {written} · the PR moved on since",
                    d.line
                )))
                .into_any_element(),
        ]
    } else {
        vec![
            badge("Draft", look::ABE_WARN.rgba()),
            div()
                .text_color(look::TEXT_DIM)
                .child("yours · not sent · goes with Submit review")
                .into_any_element(),
        ]
    };
    let weak = review.downgrade();
    let delete = TextButton::new(
        SharedString::from(format!("review-card-delete-{seq}")),
        "Delete…",
    )
    .compact(true)
    .danger(true)
    .on_click({
        let weak = weak.clone();
        move |_, window, cx| ask_delete(seq, weak.clone(), window, cx)
    })
    .into_any_element();
    let (buttons, note) = if outdated {
        let scx = scx.clone();
        let (side, line, text) = (d.side.name(), d.line, d.body.clone());
        (
            vec![
                TextButton::new(
                    SharedString::from(format!("review-card-rewrite-{seq}")),
                    format!("Rewrite on line {line}"),
                )
                .compact(true)
                .on_click(move |_, _, _| {
                    scx.call(
                        "config.app.review",
                        "rewrite",
                        vec![seq.into(), side.into(), line.into(), text.as_str().into()],
                    )
                })
                .into_any_element(),
                delete,
            ],
            Some(format!("kept on {written} until you choose")),
        )
    } else {
        let edit = {
            let scx = scx.clone();
            let text = d.body.clone();
            TextButton::new(
                SharedString::from(format!("review-card-edit-{seq}")),
                "Edit draft",
            )
            .compact(true)
            .on_click(move |_, _, _| {
                scx.call(
                    "config.app.review",
                    "edit",
                    vec![seq.into(), text.as_str().into()],
                )
            })
            .into_any_element()
        };
        let post = {
            let (path, side, line) = (d.path.clone(), d.side, d.line);
            let text = d.body.clone();
            TextButton::new(
                SharedString::from(format!("review-card-post-{seq}")),
                "Post comment now",
            )
            .compact(true)
            .disabled(base_head.is_none())
            .on_click(move |_, _, cx| {
                let Some((base, head)) = base_head.clone() else {
                    return;
                };
                let ask = ReviewAsk::Comment {
                    path: path.clone(),
                    side,
                    line,
                    start: None,
                    body: text.clone(),
                    base,
                    head,
                    now: Some(true),
                    replaces: None,
                };
                let _ = weak.update(cx, |r, cx| r.ask(ask, cx));
            })
            .into_any_element()
        };
        (vec![edit, post, delete], None)
    };
    frame(format!("review-card-draft-{seq}"), hue.rgba())
        .child(head(left, vec![]))
        .when(outdated, |c| {
            c.child(
                div()
                    .mx(px(10.))
                    .mb(px(4.))
                    .px(px(8.))
                    .rounded(px(4.))
                    .bg(look::EDITOR_BG)
                    .font_family(EDITOR_FONT)
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(format!(
                        "line {} as written at {written}",
                        d.line
                    ))),
            )
        })
        .child(body(&d.body))
        .child(actions(buttons, note))
        .into_any_element()
}

/// The writing card (G21): `Comment on line 19` and where, the blue-bordered field with the
/// keyboard, `⇧⏎ new line`, Cancel, the other answer with ⌘⏎ and the primary with ⏎.
fn writing_card(w: &Writing, review: &Entity<PrReview>) -> AnyElement {
    let label = |how: How| match how {
        How::Draft => "Save draft",
        How::Post => "Post comment now",
    };
    let answer = |how: Option<How>| {
        let weak = review.downgrade();
        move |_: &gpui_kit::ClickEvent, window: &mut gpui_kit::Window, cx: &mut App| {
            let _ = weak.update(cx, |r, cx| r.finish_writing(how, window, cx));
        }
    };
    let mut buttons = vec![
        TextButton::new("review-card-writing-cancel", "Cancel")
            .compact(true)
            .on_click(answer(None))
            .into_any_element(),
    ];
    if let Some(other) = w.secondary() {
        buttons.push(
            TextButton::new("review-card-writing-other", label(other))
                .compact(true)
                .key("⌘⏎")
                .on_click(answer(Some(other)))
                .into_any_element(),
        );
    }
    let primary = w.primary();
    buttons.push(
        TextButton::new("review-card-writing-primary", label(primary))
            .compact(true)
            .primary(true)
            .key("⏎")
            .on_click(answer(Some(primary)))
            .into_any_element(),
    );
    let weak = review.downgrade();
    frame("review-card-writing".to_owned(), look::FOCUS_BORDER.rgba())
        .capture_key_down(move |ev, window, cx| {
            let _ = weak.update(cx, |r, cx| r.writing_key(ev, window, cx));
        })
        .child(head(
            vec![
                div()
                    .flex_none()
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(look::TEXT)
                    .child(SharedString::from(w.title.clone()))
                    .into_any_element(),
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(w.meta.clone()))
                    .into_any_element(),
            ],
            vec![],
        ))
        .child(
            div()
                .id("review-card-writing-field")
                .debug_selector(|| "review-card-writing-field".into())
                .mx(px(8.))
                .mb(px(8.))
                .flex_1()
                .min_h(px(WRITING_FIELD_MIN))
                .px(px(6.))
                .py(px(4.))
                .rounded(px(look::BUTTON_ARC))
                .bg(look::FIELD_BG)
                .border_1()
                .border_color(look::FOCUS_BORDER)
                .child(w.area.clone()),
        )
        .child(
            div()
                .flex_none()
                .px(px(8.))
                .py(px(6.))
                .flex()
                // a narrow card: the buttons wrap (rows asked for in `writing_rows`), never cut
                .flex_wrap()
                .justify_end()
                .items_center()
                .gap(px(6.))
                .border_t_1()
                .border_color(look::SEPARATOR)
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_size(px(look::PR_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child("⇧⏎ new line"),
                )
                .child(div().flex_1())
                .children(buttons),
        )
        .into_any_element()
}

/// The writing card's field: min 3 lines of 16 + its padding (CommentBox's field, G21).
const WRITING_FIELD_MIN: f32 = 56.;
/// It grows to 12 lines, then scrolls.
const WRITING_FIELD_LINES: usize = 12;

/// The rows of `rh` px the writing card needs in a pane with `pane_w` px of code: its head, the
/// field holding its text (3 to 12 lines), the actions, the insets.
pub fn writing_rows(text: &str, pane_w: f32, rh: f32) -> i64 {
    let w = card_width(pane_w) - 16. - 12. - 4.;
    let lines = wrapped(text, w).clamp(1, WRITING_FIELD_LINES) as f32;
    let field = (lines * 16. + 10.).max(WRITING_FIELD_MIN);
    // the actions as wide as they get (both answers with their keys), wrapped at the card's width
    let actions = button_lines(
        &[
            "⇧⏎ new line",
            "Cancel",
            "Post comment now ⌘⏎",
            "Save draft ⏎",
        ],
        card_width(pane_w) - 16.,
    );
    let px_h = 26. + field + 8. + 37. + 30. * (actions - 1) as f32 + 2.;
    ((px_h + 8.) / rh).ceil() as i64
}

/// A card's key as `config/app/review.lua` names it (`t:<thread id>`, `d:<draft seq>`, `w` the
/// writing card).
pub fn key_of(slot: &CardSlot) -> Option<String> {
    if slot.kind == "writing" {
        return Some("w".to_owned());
    }
    match (&slot.id, slot.seq) {
        (Some(id), _) => Some(format!("t:{id}")),
        (None, Some(seq)) => Some(format!("d:{seq}")),
        _ => None,
    }
}

/// Lines `text` wraps to at `width` px (Inter 13 at ~7 px a character).
fn wrapped(text: &str, width: f32) -> usize {
    let per = (width / 7.).max(10.) as usize;
    text.split('\n')
        .map(|l| l.chars().count().div_ceil(per).max(1))
        .sum()
}

/// Lines a row of buttons `labels` wraps to at `width` px.
fn button_lines(labels: &[&str], width: f32) -> usize {
    let mut lines = 1;
    let mut x = 0.;
    for l in labels {
        let w = l.chars().count() as f32 * 7. + 2. * look::COMPACT_BUTTON_PAD_X + 6.;
        if x > 0. && x + w > width {
            lines += 1;
            x = 0.;
        }
        x += w;
    }
    lines
}

/// The rows of `rh` px a card needs in a pane with `pane_w` px of code: its head, its text (and
/// bylines), the quote, its actions (wrapped), the insets.
pub fn needed_rows(slot: &CardSlot, pane_w: f32, rh: f32, model: &ReviewPaneProps) -> Option<i64> {
    let w = card_width(pane_w) - 20.;
    let px_h = match slot.kind.as_str() {
        "thread" => {
            let t = model
                .threads
                .iter()
                .find(|t| Some(&t.id) == slot.id.as_ref())?;
            let text: f32 = t
                .comments
                .iter()
                .map(|c| 18. + 18. * wrapped(&display_body(&c.body), w) as f32 + 12.)
                .sum();
            26. + text + 12. + 30. * button_lines(&["Reply…               ", "Resolve"], w) as f32
        }
        kind => {
            let d = model.drafted.iter().find(|d| Some(d.seq) == slot.seq)?;
            let outdated = kind == "outdated";
            let labels: &[&str] = if outdated {
                &[
                    "Rewrite on line 000",
                    "Delete…",
                    "kept on 00000000 until you choose",
                ]
            } else {
                &["Edit draft", "Post comment now", "Delete…"]
            };
            26. + if outdated { 24. } else { 0. }
                + 18. * wrapped(&d.body, w) as f32
                + 8.
                + 12.
                + 30. * button_lines(labels, w) as f32
        }
    };
    Some(((px_h + 8.) / rh).ceil() as i64)
}

/// A card's width in a pane with `pane_w` px of code.
fn card_width(pane_w: f32) -> f32 {
    (pane_w - 52.).max(120.)
}

/// The cards of one pane this frame: each placed under its line's row (when drawn), across the
/// pane's code, clipped to its text area.
pub fn render(
    pane: &PaneFrame,
    slots: &[CardSlot],
    scx: &SurfaceCx,
    review: &Entity<PrReview>,
    cx: &App,
) -> Vec<AnyElement> {
    let Some(model) = review.read(cx).model(cx) else {
        return Vec::new();
    };
    let base_head = model
        .strip
        .as_ref()
        .map(|s| (s.base_sha.clone(), s.head_sha.clone()));
    let rh = pane.rows.row_height;
    let (x0, x1) = pane.grid_x;
    let clip_top = pane.clip.top().as_f32();
    let clip_bottom = pane.clip.bottom().as_f32();
    // placed inside the pane's text area, which clips them: a card never covers the panel below
    let (ox, oy) = (pane.clip.left().as_f32(), clip_top);
    let writing = review.read(cx).writing();
    // cards on the same line stack in Lua's order (each one's blank rows follow the one before)
    let mut above: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    let cards: Vec<AnyElement> = slots
        .iter()
        .filter_map(|slot| {
            let before = above.entry(slot.line).or_insert(0);
            let stacked = *before;
            *before += slot.rows;
            let row = pane.rows.row_of(slot.line)?;
            let top = row.y + rh * (1 + stacked) as f32 + 4.;
            let height = slot.rows as f32 * rh - 8.;
            if top >= clip_bottom || top + height <= clip_top {
                return None;
            }
            let card = match slot.kind.as_str() {
                "thread" => {
                    let id = slot.id.as_deref()?;
                    let t = model.threads.iter().find(|t| t.id == id)?;
                    thread_card(t, scx, review)
                }
                "writing" => {
                    let w = writing.filter(|w| Some(w.token) == slot.token)?;
                    writing_card(w, review)
                }
                kind => {
                    let seq = slot.seq?;
                    let d = model.drafted.iter().find(|d| d.seq == seq)?;
                    draft_card(d, kind == "outdated", base_head.clone(), scx, review)
                }
            };
            Some(
                div()
                    .absolute()
                    .left(px(x0 + 40. - ox))
                    .top(px(top - oy))
                    .w(px(card_width(x1 - x0)))
                    .h(px(height.max(rh)))
                    .child(card)
                    .into_any_element(),
            )
        })
        .collect();
    if cards.is_empty() {
        return cards;
    }
    // (wide enough for a card reaching past a narrow pane's text: only the height clips)
    let right = (x0 + 40. + card_width(x1 - x0)).max(pane.clip.right().as_f32());
    vec![
        div()
            .absolute()
            .left(px(ox))
            .top(px(oy))
            .w(px(right - ox))
            .h(px(clip_bottom - clip_top))
            .overflow_hidden()
            .children(cards)
            .into_any_element(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_hides_only_abe_s_receipt_paragraph() {
        assert_eq!(
            display_body(
                "Old side discussion\n\n<!-- ordinary note -->\n\n<!-- vimstorm:reply:0123456789abcd -->"
            ),
            "Old side discussion\n\n<!-- ordinary note -->"
        );
        assert_eq!(display_body("plain"), "plain");
    }

    #[test]
    fn the_writing_card_grows_with_its_text_up_to_twelve_lines() {
        let short = writing_rows("Debounce", 700., 20.);
        assert_eq!(short, 7, "head, a 3-line field, the actions");
        let long = writing_rows(&"line\n".repeat(8), 700., 20.);
        assert!(long > short);
        assert_eq!(
            writing_rows(&"line\n".repeat(40), 700., 20.),
            writing_rows(&"line\n".repeat(12), 700., 20.)
        );
        // a narrow pane: Save draft ⏎ wraps under the others and the card asks for its row
        assert!(writing_rows("Debounce", 300., 20.) > short);
    }

    #[test]
    fn a_narrow_card_wraps_its_buttons_and_asks_for_more_rows() {
        assert_eq!(
            button_lines(&["Edit draft", "Post comment now", "Delete…"], 600.),
            1
        );
        assert!(button_lines(&["Edit draft", "Post comment now", "Delete…"], 200.) >= 2);
        assert_eq!(wrapped("a\nb", 300.), 2);
    }
}
