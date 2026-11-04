//! Markdown of LSP hover / documentation text -> styled blocks (paragraphs, headings, list items,
//! quotes, code blocks with the editor's colors, rules). Pure: the popups lay the blocks out.
//!
//! Each block is one selectable string with style spans (sorted, non-overlapping byte ranges), so
//! a popup can map mouse positions to text and copy what's shown.

use std::ops::Range;

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// How a run of text is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpanStyle {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    /// Inline code (editor font).
    pub code: bool,
    pub link: bool,
    /// Syntax color (0xRRGGBB) in code.
    pub fg: Option<u32>,
}

impl SpanStyle {
    fn is_plain(&self) -> bool {
        *self == SpanStyle::default()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub style: SpanStyle,
}

/// One string with its style spans.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<Span>,
}

impl Inline {
    pub fn plain(text: impl Into<String>) -> Self {
        Inline {
            text: text.into(),
            spans: Vec::new(),
        }
    }

    fn push(&mut self, text: &str, style: SpanStyle) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        if style.is_plain() {
            return;
        }
        // extend the previous span when it's the same style and adjacent
        if let Some(last) = self.spans.last_mut()
            && last.style == style
            && last.range.end == start
        {
            last.range.end = self.text.len();
            return;
        }
        self.spans.push(Span {
            range: start..self.text.len(),
            style,
        });
    }

    /// Trailing whitespace off (spans clipped).
    fn trim_end(&mut self) {
        let len = self.text.trim_end().len();
        self.text.truncate(len);
        self.spans.retain_mut(|s| {
            s.range.end = s.range.end.min(len);
            s.range.start < s.range.end
        });
    }

    fn is_blank(&self) -> bool {
        self.text.trim().is_empty()
    }
}

/// Problem severity of an error section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
    /// An information hint (WS `HintManager.showInformationHint`: "No usages found…"), no actions.
    Hint,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TextKind {
    Paragraph,
    /// Level 1..6.
    Heading(u8),
    /// `depth` 0 = top level; `marker` "•" / "1.".
    ListItem {
        depth: usize,
        marker: String,
    },
    Quote,
    /// A diagnostic's message (plain text).
    Problem(Severity),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Text {
        kind: TextKind,
        inline: Inline,
    },
    /// Code block: the code with its syntax colors (editor font).
    Code {
        inline: Inline,
    },
    /// Separator line (`---`, and between a popup's sections).
    Rule,
}

impl Block {
    /// The block's selectable text (none for a rule).
    pub fn text(&self) -> Option<&str> {
        match self {
            Block::Text { inline, .. } | Block::Code { inline } => Some(&inline.text),
            Block::Rule => None,
        }
    }
}

/// A code run's syntax look (Lua `config/app/floats.lua` `highlight`, as the editor draws it).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CodeLook {
    pub fg: Option<u32>,
    pub bold: bool,
    pub italic: bool,
}

/// Lua's code span `{ start, end, fg (-1: none), flags (1 bold, 2 italic) }` -> range + look.
pub fn code_span((start, end, fg, flags): (usize, usize, i64, u8)) -> (Range<usize>, CodeLook) {
    let look = CodeLook {
        fg: u32::try_from(fg).ok(),
        bold: flags & 1 != 0,
        italic: flags & 2 != 0,
    };
    (start..end, look)
}

/// Code text with syntax spans (invalid / overlapping spans are dropped).
pub fn code(text: &str, colors: &[(Range<usize>, CodeLook)]) -> Inline {
    let mut inline = Inline::plain(text);
    let mut end = 0;
    for (r, look) in colors {
        if r.start < end
            || r.end > text.len()
            || r.start >= r.end
            || !text.is_char_boundary(r.start)
            || !text.is_char_boundary(r.end)
        {
            continue;
        }
        end = r.end;
        let style = SpanStyle {
            bold: look.bold,
            italic: look.italic,
            fg: look.fg,
            ..SpanStyle::default()
        };
        if !style.is_plain() {
            inline.spans.push(Span {
                range: r.clone(),
                style,
            });
        }
    }
    inline
}

#[derive(Clone, Copy)]
enum ListKind {
    Bullet,
    Ordered(u64),
}

/// Parses markdown into blocks. `code_colors[i]` colors the i-th fenced / indented code block
/// (when its text matches; Lua highlights the same block text).
pub fn parse(src: &str, code_colors: &[Vec<(Range<usize>, CodeLook)>]) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur: Option<(TextKind, Inline)> = None;
    let mut style = SpanStyle::default();
    let mut bold = 0usize;
    let mut italic = 0usize;
    let mut strike = 0usize;
    let mut links = 0usize;
    let mut lists: Vec<ListKind> = Vec::new();
    // the item's marker until its first text is flushed
    let mut item_marker: Option<String> = None;
    let mut quote = 0usize;
    let mut code_block: Option<String> = None;
    let mut code_ix = 0usize;

    fn flush(out: &mut Vec<Block>, cur: &mut Option<(TextKind, Inline)>) {
        if let Some((kind, mut inline)) = cur.take() {
            inline.trim_end();
            if !inline.is_blank() {
                out.push(Block::Text { kind, inline });
            }
        }
    }

    // the kind for text starting now (inside list items / quotes)
    let text_kind = |lists: &Vec<ListKind>, marker: &mut Option<String>, quote: usize| {
        if !lists.is_empty() {
            TextKind::ListItem {
                depth: lists.len() - 1,
                marker: marker.take().unwrap_or_default(),
            }
        } else if quote > 0 {
            TextKind::Quote
        } else {
            TextKind::Paragraph
        }
    };

    let opts = Options::ENABLE_STRIKETHROUGH;
    for ev in Parser::new_ext(src, opts) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    flush(&mut out, &mut cur);
                    cur = Some((
                        text_kind(&lists, &mut item_marker, quote),
                        Inline::default(),
                    ));
                }
                Tag::Heading { level, .. } => {
                    flush(&mut out, &mut cur);
                    let n = match level {
                        HeadingLevel::H1 => 1,
                        HeadingLevel::H2 => 2,
                        HeadingLevel::H3 => 3,
                        HeadingLevel::H4 => 4,
                        HeadingLevel::H5 => 5,
                        HeadingLevel::H6 => 6,
                    };
                    cur = Some((TextKind::Heading(n), Inline::default()));
                }
                Tag::BlockQuote(_) => {
                    flush(&mut out, &mut cur);
                    quote += 1;
                }
                Tag::CodeBlock(_) => {
                    flush(&mut out, &mut cur);
                    code_block = Some(String::new());
                }
                Tag::List(start) => {
                    flush(&mut out, &mut cur);
                    lists.push(match start {
                        Some(n) => ListKind::Ordered(n),
                        None => ListKind::Bullet,
                    });
                }
                Tag::Item => {
                    flush(&mut out, &mut cur);
                    let marker = match lists.last_mut() {
                        Some(ListKind::Ordered(n)) => {
                            let m = format!("{n}.");
                            *n += 1;
                            m
                        }
                        _ => "•".to_owned(),
                    };
                    item_marker = Some(marker);
                }
                Tag::Emphasis => italic += 1,
                Tag::Strong => bold += 1,
                Tag::Strikethrough => strike += 1,
                Tag::Link { .. } => links += 1,
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::Item => {
                    flush(&mut out, &mut cur);
                }
                TagEnd::BlockQuote(_) => {
                    flush(&mut out, &mut cur);
                    quote = quote.saturating_sub(1);
                }
                TagEnd::CodeBlock => {
                    if let Some(mut text) = code_block.take() {
                        if text.ends_with('\n') {
                            text.pop();
                        }
                        let colors = code_colors.get(code_ix).map(Vec::as_slice).unwrap_or(&[]);
                        code_ix += 1;
                        out.push(Block::Code {
                            inline: code(&text, colors),
                        });
                    }
                }
                TagEnd::List(_) => {
                    flush(&mut out, &mut cur);
                    lists.pop();
                }
                TagEnd::Emphasis => italic = italic.saturating_sub(1),
                TagEnd::Strong => bold = bold.saturating_sub(1),
                TagEnd::Strikethrough => strike = strike.saturating_sub(1),
                TagEnd::Link => links = links.saturating_sub(1),
                _ => {}
            },
            Event::Text(t) => {
                if let Some(code) = code_block.as_mut() {
                    code.push_str(&t);
                    continue;
                }
                style.bold = bold > 0;
                style.italic = italic > 0;
                style.strike = strike > 0;
                style.link = links > 0;
                style.code = false;
                let c = cur.get_or_insert_with(|| {
                    (
                        text_kind(&lists, &mut item_marker, quote),
                        Inline::default(),
                    )
                });
                // bare URLs (JSDoc `@see https://…`) look like links, as in WebStorm's docs
                for (piece, url) in split_urls(&t) {
                    c.1.push(
                        piece,
                        SpanStyle {
                            link: style.link || url,
                            ..style
                        },
                    );
                }
            }
            Event::Code(t) => {
                let s = SpanStyle {
                    bold: bold > 0,
                    italic: italic > 0,
                    strike: strike > 0,
                    link: links > 0,
                    code: true,
                    fg: None,
                };
                let c = cur.get_or_insert_with(|| {
                    (
                        text_kind(&lists, &mut item_marker, quote),
                        Inline::default(),
                    )
                });
                c.1.push(&t, s);
            }
            Event::SoftBreak => {
                if let Some(c) = cur.as_mut() {
                    c.1.push(" ", SpanStyle::default());
                }
            }
            Event::HardBreak => {
                if let Some(c) = cur.as_mut() {
                    c.1.push("\n", SpanStyle::default());
                }
            }
            Event::InlineHtml(h) | Event::Html(h) => {
                // servers' `<br>` / `<br/>`: a line break; other tags are dropped
                let tag = h.trim().to_ascii_lowercase();
                if tag.starts_with("<br")
                    && let Some(c) = cur.as_mut()
                {
                    c.1.push("\n", SpanStyle::default());
                }
            }
            Event::Rule => {
                flush(&mut out, &mut cur);
                if !matches!(out.last(), None | Some(Block::Rule)) {
                    out.push(Block::Rule);
                }
            }
            _ => {}
        }
    }
    flush(&mut out, &mut cur);
    while matches!(out.last(), Some(Block::Rule)) {
        out.pop();
    }
    out
}

/// `text` cut into (piece, is a bare http(s) URL).
fn split_urls(text: &str) -> Vec<(&str, bool)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("https://").or_else(|| rest.find("http://")) {
        let end = rest[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '>' | ']' | '"' | '\''))
            .map_or(rest.len(), |e| start + e);
        // a sentence's final dot / comma isn't part of it
        let url = rest[start..end].trim_end_matches(['.', ',', ';', ':']);
        let end = start + url.len();
        if start > 0 {
            out.push((&rest[..start], false));
        }
        out.push((&rest[start..end], true));
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        out.push((rest, false));
    }
    out
}

/// A plain-text message (diagnostics): one block per paragraph, lines kept.
pub fn problem(text: &str, severity: Severity) -> Vec<Block> {
    text.split("\n\n")
        .map(str::trim_end)
        .filter(|p| !p.trim().is_empty())
        .map(|p| Block::Text {
            kind: TextKind::Problem(severity),
            inline: Inline::plain(p),
        })
        .collect()
}

/// The text shown between two selection points (block, byte), blocks joined by newlines.
pub fn selected_text(blocks: &[Block], from: (usize, usize), to: (usize, usize)) -> String {
    let (a, b) = if from <= to { (from, to) } else { (to, from) };
    let mut parts = Vec::new();
    for (ix, block) in blocks.iter().enumerate().take(b.0 + 1).skip(a.0) {
        let Some(text) = block.text() else { continue };
        let start = if ix == a.0 { a.1.min(text.len()) } else { 0 };
        let end = if ix == b.0 {
            b.1.min(text.len())
        } else {
            text.len()
        };
        if start <= end && text.is_char_boundary(start) && text.is_char_boundary(end) {
            parts.push(&text[start..end]);
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use super::*;

    fn texts(blocks: &[Block]) -> Vec<String> {
        blocks
            .iter()
            .map(|b| match b {
                Block::Rule => "---".to_owned(),
                b => b.text().unwrap().to_owned(),
            })
            .collect()
    }

    fn inline(b: &Block) -> &Inline {
        match b {
            Block::Code { inline } | Block::Text { inline, .. } => inline,
            b => panic!("no text: {b:?}"),
        }
    }

    const KEYWORD: CodeLook = CodeLook {
        fg: Some(0xcc7832),
        bold: false,
        italic: false,
    };
    const PLAIN: CodeLook = CodeLook {
        fg: None,
        bold: false,
        italic: false,
    };

    /// (name, markdown, the code block's colors, what `parse` makes of it)
    type Case = (
        &'static str,
        &'static str,
        &'static [(Range<usize>, CodeLook)],
        fn(&[Block]),
    );

    const PARSES: &[Case] = &[
        (
            "a hover: code, a rule, then docs",
            "```typescript\nfunction sum(a: number, b: number): number\n```\n---\nAdds two numbers.\n\n*@param* `a` — first",
            &[(0..8, KEYWORD)],
            |b| {
                assert_eq!(
                    texts(b),
                    vec![
                        "function sum(a: number, b: number): number",
                        "---",
                        "Adds two numbers.",
                        "@param a — first"
                    ]
                );
                let code = inline(&b[0]);
                assert_eq!(code.spans[0].range, 0..8);
                assert_eq!(code.spans[0].style.fg, Some(0xcc7832));
                let docs = inline(&b[3]);
                assert!(docs.spans[0].style.italic);
                assert!(docs.spans[1].style.code);
                assert_eq!(&docs.text[docs.spans[1].range.clone()], "a");
            },
        ),
        (
            "headings, lists, links, soft breaks and quotes",
            "# Title\n\nSee [docs](https://x.y) and **bold**\nnext\n\n- one\n- two\n  1. nested\n\n> quoted",
            &[],
            |b| {
                assert_eq!(
                    texts(b),
                    vec![
                        "Title",
                        "See docs and bold next",
                        "one",
                        "two",
                        "nested",
                        "quoted"
                    ]
                );
                assert!(matches!(
                    &b[0],
                    Block::Text {
                        kind: TextKind::Heading(1),
                        ..
                    }
                ));
                let spans = &inline(&b[1]).spans;
                assert!(spans.iter().any(|s| s.style.link));
                assert!(spans.iter().any(|s| s.style.bold));
                assert!(
                    matches!(&b[2], Block::Text { kind: TextKind::ListItem { depth: 0, marker }, .. } if marker == "•")
                );
                assert!(
                    matches!(&b[4], Block::Text { kind: TextKind::ListItem { depth: 1, marker }, .. } if marker == "1.")
                );
                assert!(matches!(
                    &b[5],
                    Block::Text {
                        kind: TextKind::Quote,
                        ..
                    }
                ));
            },
        ),
        (
            "colors past the code are dropped",
            "```ts\nab\n```",
            &[(0..9, PLAIN)],
            |b| assert!(inline(&b[0]).spans.is_empty()),
        ),
        ("br breaks the line", "a<br>b", &[], |b| {
            assert_eq!(b[0].text(), Some("a\nb"))
        }),
        (
            "no rule at the start, the end or twice",
            "---\na\n\n---\n\n---\n",
            &[],
            |b| assert_eq!(texts(b), vec!["a"]),
        ),
        (
            "a bare url is a link",
            "@see — https://x.y/a_b. More",
            &[],
            |b| {
                let t = inline(&b[0]);
                let link: Vec<_> = t.spans.iter().filter(|s| s.style.link).collect();
                assert_eq!(link.len(), 1);
                assert_eq!(&t.text[link[0].range.clone()], "https://x.y/a_b");
            },
        ),
    ];

    #[test]
    fn parse_turns_markdown_into_blocks() {
        for &(name, md, colors, check) in PARSES {
            let b = parse(md, &[colors.to_vec()]);
            let ok = catch_unwind(AssertUnwindSafe(|| check(&b)));
            assert!(ok.is_ok(), "{name}");
        }
    }

    #[test]
    fn selection_across_blocks() {
        let b = parse("```ts\nfunction sum()\n```\n---\nAdds two numbers.", &[]);
        assert_eq!(
            selected_text(&b, (0, 0), (2, 17)),
            "function sum()\nAdds two numbers."
        );
        // backwards, partial
        assert_eq!(selected_text(&b, (2, 4), (0, 9)), "sum()\nAdds");
        assert_eq!(problem("TS1: x\n\nmore", Severity::Error).len(), 2);
    }
}
