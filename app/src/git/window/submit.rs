//! The Submit review dialog (G19, DiffViewer "Submit review dialog"): one flow dialog in place of
//! the old chooser and its field. The verdict as three choices (Comment "Feedback, no verdict",
//! Approve "Ready to merge as it is", Request changes "Must change before merging"; the strip's
//! button that opened it picked one), the summary (multi-line; required for Request changes), the
//! drafts that go with it (`file:line` and the text), then "Read at <rev>, the PR's head", Cancel
//! and the primary `Submit review (N) ⏎`.
//!
//! Keys: ⏎ submits, ⇧⏎ a new line, Tab / ⇧Tab the next / previous verdict, Esc cancels. The send
//! is the review screen's (`abe review submit`): the PR's head read anew first, refused when it
//! moved (the drafts kept), one review with the drafts on the head read.

use crate::factory::{Drafted, Strip as PrStrip, Verdict};
use crate::git::window::review::sha8;
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement as _, Render, SharedString, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};

use super::flow;
use super::review::PrReview;
use crate::kit::TextButton;
use crate::kit::{TextArea, TextAreaEvent};
use crate::look;

const VERDICTS: [(Verdict, &str, &str, &str); 3] = [
    (
        Verdict::Comment,
        "submit-comment",
        "Comment",
        "Feedback, no verdict",
    ),
    (
        Verdict::Approve,
        "submit-approve",
        "Approve",
        "Ready to merge as it is",
    ),
    (
        Verdict::RequestChanges,
        "submit-request-changes",
        "Request changes",
        "Must change before merging",
    ),
];

pub struct SubmitDialog {
    strip: PrStrip,
    drafted: Vec<Drafted>,
    pub verdict: Verdict,
    summary: Entity<TextArea>,
    review: WeakEntity<PrReview>,
    /// The summary takes the keyboard once drawn (the Git window may only now be opening).
    focus_soon: bool,
    _subs: Vec<gpui_kit::Subscription>,
}

impl SubmitDialog {
    pub fn new(
        strip: PrStrip,
        drafted: Vec<Drafted>,
        verdict: Verdict,
        body: String,
        review: WeakEntity<PrReview>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let summary = cx.new(|cx| {
            let mut area = TextArea::new(cx).placeholder("What the author should know");
            area.set_text(body, cx);
            area
        });
        let subs = vec![cx.subscribe(&summary, |_, _, _: &TextAreaEvent, cx| cx.notify())];
        SubmitDialog {
            strip,
            drafted,
            verdict,
            summary,
            review,
            focus_soon: true,
            _subs: subs,
        }
    }

    /// The summary has the keyboard (the tool window leaves `,` and Esc to it).
    pub fn typing(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        use gpui_kit::Focusable as _;
        self.summary
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
    }

    /// The summary as typed (tests).
    pub fn summary(&self, cx: &gpui_kit::App) -> String {
        self.summary.read(cx).text().to_owned()
    }

    /// Request changes needs a summary; a comment needs a summary or a draft (else nothing goes).
    pub fn ready(&self, cx: &gpui_kit::App) -> bool {
        let summary = !self.summary.read(cx).text().trim().is_empty();
        match self.verdict {
            Verdict::RequestChanges => summary,
            Verdict::Comment => summary || !self.drafted.is_empty(),
            Verdict::Approve => true,
        }
    }

    pub fn pick(&mut self, verdict: Verdict, cx: &mut Context<Self>) {
        if self.strip.own && verdict != Verdict::Comment {
            return;
        }
        self.verdict = verdict;
        cx.notify();
    }

    fn step(&mut self, dir: isize, cx: &mut Context<Self>) {
        let i = VERDICTS
            .iter()
            .position(|v| v.0 == self.verdict)
            .unwrap_or(0) as isize;
        let next = (i + dir).rem_euclid(VERDICTS.len() as isize) as usize;
        self.pick(VERDICTS[next].0, cx);
    }

    /// Submit: the review core sends it; the dialog closes.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(cx) {
            return;
        }
        let body = self.summary.read(cx).text().trim().to_owned();
        let verdict = self.verdict;
        let _ = self.review.update(cx, |r, cx| {
            r.send_review(verdict, body, cx);
            r.close_submit(window, cx);
        });
    }

    pub fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self.review.update(cx, |r, cx| r.close_submit(window, cx));
    }

    /// ⏎ / ⇧⏎ / Tab / Esc before the summary takes them.
    fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        match key.as_str() {
            "<CR>" => self.submit(window, cx),
            "<Esc>" => self.cancel(window, cx),
            "<Tab>" => self.step(1, cx),
            "<S-Tab>" => self.step(-1, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    fn label(&self) -> String {
        match self.drafted.len() {
            0 => "Submit review ⏎".to_owned(),
            n => format!("Submit review ({n}) ⏎"),
        }
    }
}

impl Render for SubmitDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.focus_soon) {
            let focus = gpui_kit::Focusable::focus_handle(self.summary.read(cx), cx);
            window.defer(cx, move |window, cx| window.focus(&focus, cx));
        }
        let me = cx.entity().downgrade();
        let choices =
            div()
                .flex()
                .gap(px(8.))
                .children(VERDICTS.iter().map(|(verdict, id, title, desc)| {
                    let me = me.clone();
                    let verdict = *verdict;
                    // your own PR: GitHub takes a comment only
                    if self.strip.own && verdict != Verdict::Comment {
                        return flow::choice(id, title, "Not on your own PR", false, |_, _| {});
                    }
                    flow::choice(id, title, desc, self.verdict == verdict, move |_, cx| {
                        let _ = me.update(cx, |d, cx| d.pick(verdict, cx));
                    })
                }));
        let note = match self.verdict {
            Verdict::RequestChanges => "required for Request changes",
            _ => "optional for Approve and Comment",
        };
        let summary = div()
            .h(px(look::FLOW_AREA_MIN_HEIGHT))
            .child(self.summary.clone());
        let n = self.drafted.len();
        let drafts = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .text_size(px(look::PR_SMALL_FONT_SIZE))
            .children(self.drafted.iter().map(|d| {
                let name = d.path.rsplit('/').next().unwrap_or(&d.path);
                div()
                    .h(px(20.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex_none()
                            .w(px(150.))
                            .overflow_hidden()
                            .text_ellipsis()
                            .font_family(crate::render::EDITOR_FONT)
                            .text_color(if d.outdated {
                                look::ABE_BAD
                            } else {
                                look::ABE_PATH
                            })
                            .child(SharedString::from(format!("{name}:{}", d.line))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(SharedString::from(d.body.replace('\n', " "))),
                    )
            }))
            .when(n == 0, |d| {
                d.child(
                    div()
                        .text_color(look::TEXT_DIM)
                        .child("No draft comments: the summary is the review"),
                )
            });
        let drafts_note = match n {
            0 => None,
            1 => Some("1 comment goes with this review".to_owned()),
            n => Some(format!("{n} comments go with this review")),
        };
        let cancel = {
            let me = me.clone();
            TextButton::new("submit-cancel", "Cancel").on_click(move |_, window, cx| {
                let _ = me.update(cx, |d, cx| d.cancel(window, cx));
            })
        };
        let send = {
            let me = me.clone();
            TextButton::new("submit-send", self.label())
                .primary(true)
                .disabled(!self.ready(cx))
                .on_click(move |_, window, cx| {
                    let _ = me.update(cx, |d, cx| d.submit(window, cx));
                })
        };
        let close = me.clone();
        let frame = flow::frame(look::FLOW_WIDTH)
            .id("submit-review")
            .key_context("SubmitReview")
            .capture_key_down(cx.listener(Self::on_key))
            .child(flow::title(
                "Submit review",
                Some(format!("#{}", self.strip.number)),
                &self.strip.title,
                move |window, cx| {
                    let _ = close.update(cx, |d, cx| d.cancel(window, cx));
                },
            ))
            .child(flow::section("Verdict", None, choices))
            .child(flow::section("Summary", Some(note), summary))
            .child(flow::section("Drafts", drafts_note.as_deref(), drafts))
            .child(flow::foot(
                format!(
                    "Read at {}, the PR's head · ⇥ verdict · ⇧⏎ new line",
                    sha8(&self.strip.head_sha)
                )
                .into(),
                false,
                vec![cancel.into_any_element(), send.into_any_element()],
            ));
        flow::overlay("submit-review-dialog", look::FLOW_WIDTH, frame, window)
    }
}
