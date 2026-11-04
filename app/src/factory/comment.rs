//! The CommentBox (DS 2.0 `components/CommentBox`), the Rust half of `layers.ts`'
//! `CommentBox`: a card's thread oldest first (the latest at the bottom), the destination, the
//! draft with its caret where the bridge says (the placeholder after it while empty), Send
//! (`Sending…` while posting), the error of a failed post. 640 px, centred near the top of the view, a layer
//! over it. It holds no state: the bridge says what is typed; every key goes to it, a click on
//! Send names `comment:send`.

use gpui_kit::{
    AnyElement, App, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, Styled as _, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::draw::Drawn;
use crate::kit;
use crate::look;

/// The box's width (DS: literal 640).
pub const WIDTH: f32 = 640.;
/// The thread's most height before older comments scroll out above (DS: the room left).
const THREAD_MAX_H: f32 = 260.;
/// A field line (DS 16) and its least height, three lines and the padding (56).
const FIELD_LINE_H: f32 = 16.;
const FIELD_MIN_H: f32 = 56.;
/// What Send names when clicked.
pub const SEND: &str = "comment:send";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadState {
    Loading,
    Error,
    Ready,
}

/// One comment of a thread: in the story dialog its markdown; in the CommentBox its lines as
/// the bridge cut them (quote marks and blank lines dropped there, `threadLines`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ThreadComment {
    pub by: String,
    pub when: String,
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Thread {
    pub state: ThreadState,
    pub message: Option<String>,
    #[serde(default)]
    pub comments: Vec<ThreadComment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxState {
    Writing,
    Posting,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CommentBoxProps {
    pub title: String,
    pub thread: Thread,
    pub destination: String,
    pub draft: String,
    /// The draft's caret in characters; None: at its end.
    pub caret: Option<usize>,
    pub placeholder: Option<String>,
    pub state: BoxState,
    pub error: Option<String>,
    pub hint: Option<String>,
}

pub(super) fn dim_line(text: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .flex_none()
        .px(px(10.))
        .min_h(px(look::LIST_ROW_HEIGHT.get()))
        .flex()
        .items_center()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DIM)
        .child(text.into())
}

fn thread(t: &Thread, drawn: &mut Drawn) -> AnyElement {
    let body: Vec<AnyElement> = match t.state {
        ThreadState::Loading => vec![dim_line("Loading comments…").into_any_element()],
        ThreadState::Error => {
            let text = format!("✗ {}", t.message.as_deref().unwrap_or("failed"));
            drawn.add("CommentThreadState", &text);
            vec![
                dim_line(text)
                    .text_color(look::TEXT_ERROR)
                    .into_any_element(),
            ]
        }
        ThreadState::Ready if t.comments.is_empty() => {
            vec![dim_line("No comments yet").into_any_element()]
        }
        ThreadState::Ready => {
            t.comments
                .iter()
                .map(|c| {
                    drawn.add("CommentBy", format!("{} · {}", c.by, c.when));
                    div()
                        .flex_none()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(look::UI_SMALL_FONT_SIZE))
                                .text_color(look::ABE_PERSON)
                                .child(SharedString::from(format!("{} · {}", c.by, c.when))),
                        )
                        // a line each, as the bridge cut them (`threadLines`)
                        .children(c.markdown.lines().map(|l| {
                            div()
                                .text_color(look::TEXT)
                                .child(SharedString::from(l.to_owned()))
                        }))
                        .into_any_element()
                })
                .collect()
        }
    };
    div()
        .debug_selector(|| "factory-comment-thread".into())
        .flex_none()
        .max_h(px(THREAD_MAX_H))
        .px(px(10.))
        .py(px(6.))
        .flex()
        .flex_col()
        // the newest at the bottom; older ones go out at the top
        .justify_end()
        .gap(px(8.))
        .overflow_hidden()
        .children(body)
        .into_any_element()
}

fn field(p: &CommentBoxProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("CommentDraft", &p.draft);
    draft_field(&p.draft, p.caret, p.placeholder.as_deref(), "comment")
}

/// A multi-line draft with its caret where the bridge says and the placeholder after it while
/// empty: the CommentBox's and the Launch box's field. `name` makes its selectors
/// (`factory-<name>-field`, `factory-<name>-caret`).
pub(super) fn draft_field(
    draft: &str,
    caret: Option<usize>,
    placeholder: Option<&str>,
    name: &'static str,
) -> AnyElement {
    draft_field_keys(draft, caret, placeholder, name, true)
}

/// [`draft_field`], its caret and focus border only while the keys are in it (`focused`): the Card
/// page's composer, which the keys leave for the page and its actions.
pub(super) fn draft_field_keys(
    draft: &str,
    caret: Option<usize>,
    placeholder: Option<&str>,
    name: &'static str,
    focused: bool,
) -> AnyElement {
    let lines: Vec<&str> = if draft.is_empty() {
        vec![""]
    } else {
        draft.split('\n').collect()
    };
    // the caret's line and its place in it, in characters
    let (before, _) = super::field::split(draft, caret);
    let at_line = before.matches('\n').count();
    let at_col = before.rsplit('\n').next().map_or(0, |l| l.chars().count());
    let caret = move || {
        div()
            .debug_selector(move || format!("factory-{name}-caret"))
            .flex_none()
            .w(px(look::CARET_WIDTH))
            .h(px(FIELD_LINE_H))
            .bg(look::CARET)
    };
    let placeholder = placeholder.filter(|_| draft.is_empty()).map(str::to_owned);
    div()
        .debug_selector(move || format!("factory-{name}-field"))
        .flex_none()
        .mx(px(4.))
        .mb(px(8.))
        .min_h(px(FIELD_MIN_H))
        .px(px(6.))
        .py(px(4.))
        .rounded(px(4.))
        .bg(look::FIELD_BG)
        .border_1()
        .border_color(if focused {
            look::FOCUS_BORDER
        } else {
            look::FIELD_BORDER
        })
        .flex()
        .flex_col()
        .children(lines.into_iter().enumerate().map(|(i, l)| {
            div()
                .h(px(FIELD_LINE_H))
                .flex()
                .items_center()
                .whitespace_nowrap()
                .overflow_hidden()
                .when(i != at_line, |d| d.child(SharedString::from(l.to_owned())))
                .when(i == at_line, |d| {
                    d.child(super::field::caret_line(
                        l,
                        Some(at_col),
                        focused.then(caret),
                    ))
                    .children(placeholder.clone().map(|ph| {
                        div()
                            .pl(px(2.))
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(ph))
                    }))
                })
        }))
        .into_any_element()
}

/// The box, unplaced: [`super::layers::over`] centres it near the view's top.
pub fn comment_box(p: &CommentBoxProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("CommentBox", &p.title);
    drawn.add("CommentDestination", &p.destination);
    let posting = p.state == BoxState::Posting;
    let send_label = if posting { "Sending…" } else { "Send" };
    drawn.add("CommentSend", send_label);
    let error = p
        .error
        .as_ref()
        .filter(|_| p.state == BoxState::Failed)
        .map(|e| {
            drawn.add("CommentError", e);
            dim_line(format!("✗ {e}")).text_color(look::TEXT_ERROR)
        });
    let sink = drawn.sink.clone();
    let send = div()
        .debug_selector(|| "factory-comment-send".into())
        .flex_none()
        .px(px(12.))
        .py(px(4.))
        .rounded(px(4.))
        .bg(look::SELECTION_BG)
        .text_color(look::SELECTION_TEXT)
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |_, window, cx: &mut App| {
            cx.stop_propagation();
            if let Some(sink) = &sink {
                sink.click(SEND.into(), window, cx);
            }
        })
        .child(SharedString::from(send_label));
    kit::popup_frame()
        .debug_selector(|| "factory-comment".into())
        .w(px(WIDTH))
        .occlude()
        .child(kit::header(SharedString::from(p.title.clone()), None))
        .child(thread(&p.thread, drawn))
        .child(div().flex_none().mx(px(10.)).h(px(1.)).bg(look::SEPARATOR))
        .child(dim_line(p.destination.clone()))
        .child(field(p, drawn))
        .children(error)
        .child(
            div()
                .flex_none()
                .px(px(4.))
                .pb(px(8.))
                .flex()
                .justify_end()
                .child(send),
        )
        .children(
            p.hint
                .as_ref()
                .map(|h| kit::ad_text(SharedString::from(h.clone()))),
        )
        .into_any_element()
}
