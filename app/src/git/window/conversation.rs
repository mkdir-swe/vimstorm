//! The PR's description and conversation under its files while the scope is all changes: the
//! description and each comment as markdown (headings, paragraphs, lists, quotes, code), the
//! reviews sent with a verdict or a summary, and a field to comment on the PR (⌘⏎ posts it with
//! `abe review say`), in one scrolling column.

use gpui_kit::{
    AnyElement, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _,
    px,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use crate::factory::{ConversationItem, Strip};
use crate::kit::{TextArea, TextButton};
use crate::look;
use crate::render::EDITOR_FONT;

/// The column's height: the description and a few comments without scrolling.
pub const HEIGHT: f32 = 300.;

/// A block of markdown as the column draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Heading(String),
    Paragraph(String),
    Item(usize, String),
    Quote(String),
    Code(String),
}

/// `text`'s blocks; inline marks dropped (`**b**` reads `b`, a link its words).
pub fn blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut lists = 0usize;
    let mut quote = 0usize;
    for ev in Parser::new_ext(
        text,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    ) {
        match ev {
            Event::Start(Tag::List(_)) => {
                // an item's own words before its nested list
                flush_item(&mut out, &mut buf, lists, quote);
                lists += 1;
            }
            Event::End(TagEnd::List(_)) => lists = lists.saturating_sub(1),
            Event::Start(Tag::BlockQuote(_)) => quote += 1,
            Event::End(TagEnd::BlockQuote(_)) => quote = quote.saturating_sub(1),
            Event::Start(Tag::Item) | Event::Start(Tag::Paragraph) => {
                flush_item(&mut out, &mut buf, lists, quote)
            }
            Event::Start(Tag::Heading { .. }) | Event::Start(Tag::CodeBlock(_)) => buf.clear(),
            Event::End(TagEnd::Heading(_)) => out.push(Block::Heading(take(&mut buf))),
            Event::End(TagEnd::CodeBlock) => {
                out.push(Block::Code(take(&mut buf).trim_end().to_owned()))
            }
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Item) => {
                flush_item(&mut out, &mut buf, lists, quote)
            }
            Event::Text(t) | Event::Code(t) => buf.push_str(&t),
            Event::SoftBreak => buf.push(' '),
            Event::HardBreak => buf.push('\n'),
            Event::TaskListMarker(done) => buf.push_str(if done { "☑ " } else { "☐ " }),
            _ => {}
        }
    }
    flush_item(&mut out, &mut buf, lists, quote);
    out
}

fn take(buf: &mut String) -> String {
    std::mem::take(buf).trim().to_owned()
}

/// What was gathered goes as an item (inside a list), a quote or a paragraph.
fn flush_item(out: &mut Vec<Block>, buf: &mut String, lists: usize, quote: usize) {
    let text = take(buf);
    if text.is_empty() {
        return;
    }
    out.push(if lists > 0 {
        Block::Item(lists, text)
    } else if quote > 0 {
        Block::Quote(text)
    } else {
        Block::Paragraph(text)
    });
}

fn render_blocks(text: &str) -> AnyElement {
    let mut col = div().flex().flex_col().gap(px(4.)).min_w_0();
    for b in blocks(text) {
        col = col.child(match b {
            Block::Heading(t) => div()
                .pt(px(2.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(SharedString::from(t)),
            Block::Paragraph(t) => div().child(SharedString::from(t)),
            Block::Item(depth, t) => div()
                .pl(px(12. * depth as f32))
                .flex()
                .gap(px(6.))
                .child(div().flex_none().text_color(look::TEXT_DIM).child("•"))
                .child(div().min_w_0().child(SharedString::from(t))),
            Block::Quote(t) => div()
                .pl(px(8.))
                .border_l_2()
                .border_color(look::SEPARATOR)
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(t)),
            Block::Code(t) => div()
                .px(px(6.))
                .py(px(4.))
                .rounded(px(4.))
                .bg(look::FIELD_BG)
                .font_family(EDITOR_FONT)
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .whitespace_nowrap()
                .overflow_hidden()
                .child(SharedString::from(t)),
        });
    }
    col.into_any_element()
}

/// A conversation item's verdict word and its hue.
fn verdict(kind: &str) -> Option<(&'static str, gpui_kit::Rgba)> {
    match kind {
        "approved" => Some(("approved", look::ABE_GOOD.rgba())),
        "changes" => Some(("requested changes", look::ABE_BAD.rgba())),
        "commented" => Some(("reviewed", look::TEXT_DIM.rgba())),
        "dismissed" => Some(("review dismissed", look::TEXT_DIM.rgba())),
        _ => None,
    }
}

fn item(ix: usize, c: &ConversationItem) -> AnyElement {
    let mut head = div().flex().items_center().gap(px(6.)).child(
        div()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(look::ABE_PERSON)
            .child(SharedString::from(c.author.clone())),
    );
    if let Some((word, hue)) = verdict(&c.kind) {
        head = head.child(div().text_color(hue).child(word));
    }
    head = head.child(
        div()
            .text_color(look::TEXT_DIM)
            .text_size(px(look::PR_SMALL_FONT_SIZE))
            .child(SharedString::from(c.when.clone())),
    );
    div()
        .debug_selector(move || format!("pr-conversation-{ix}"))
        .flex()
        .flex_col()
        .gap(px(4.))
        .pt(px(8.))
        .border_t_1()
        .border_color(look::SEPARATOR)
        .child(head)
        .when(!c.body.trim().is_empty(), |d| {
            d.child(render_blocks(&c.body))
        })
        .into_any_element()
}

/// The column: the PR's title, author and branches, its description, the conversation, the
/// comment field and its Comment button (`post`).
pub fn section(
    strip: &Strip,
    items: &[ConversationItem],
    say: &Entity<TextArea>,
    post: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> AnyElement {
    let n = strip.commits.len();
    let mut col = div()
        .id("pr-conversation")
        .debug_selector(|| "pr-details".into())
        // (it gives way first when the Git window is short)
        .flex_shrink(1.)
        .min_h(px(0.))
        .h(px(HEIGHT))
        .px(px(14.))
        .py(px(12.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .overflow_y_scroll()
        .border_t_1()
        .border_color(look::BORDER)
        .text_size(px(look::UI_FONT_SIZE))
        .child(
            div()
                .font_weight(FontWeight::BOLD)
                .child(SharedString::from(strip.title.clone())),
        )
        .child(
            div()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(format!(
                    "#{} by {} · {n} commit{} · {} ← {}",
                    strip.number,
                    strip.author,
                    if n == 1 { "" } else { "s" },
                    strip.base,
                    strip.branch
                ))),
        )
        .when(!strip.body.trim().is_empty(), |d| {
            d.child(render_blocks(&strip.body))
        });
    for (ix, c) in items.iter().enumerate() {
        col = col.child(item(ix, c));
    }
    col.child(
        div()
            .pt(px(8.))
            .border_t_1()
            .border_color(look::SEPARATOR)
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .id("pr-say-field")
                    .debug_selector(|| "pr-say-field".into())
                    .min_h(px(48.))
                    .px(px(6.))
                    .py(px(4.))
                    .rounded(px(look::BUTTON_ARC))
                    .bg(look::FIELD_BG)
                    .border_1()
                    .border_color(look::SEPARATOR)
                    .child(say.clone()),
            )
            .child(
                div().flex().justify_end().child(
                    TextButton::new("pr-say", "Comment")
                        .compact(true)
                        .key("⌘⏎")
                        .on_click(post),
                ),
            ),
    )
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_s_markdown_reads_as_blocks() {
        assert_eq!(
            blocks(
                "## Changes\n\n- `src/cart.ts`: **lineTotal**\n  - nested\n\n> quoted\n\nPlain [link](u) text.\n\n```ts\nconst a = 1;\n```"
            ),
            vec![
                Block::Heading("Changes".into()),
                Block::Item(1, "src/cart.ts: lineTotal".into()),
                Block::Item(2, "nested".into()),
                Block::Quote("quoted".into()),
                Block::Paragraph("Plain link text.".into()),
                Block::Code("const a = 1;".into()),
            ]
        );
    }
}
