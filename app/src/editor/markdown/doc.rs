//! Markdown source -> the preview's rows (pure, unit-tested). pulldown-cmark with GitHub's
//! extensions (tables, task lists, strikethrough, footnotes); every row knows the source lines it
//! came from (scroll sync both ways). A row is a top-level block, or one item of a top-level list
//! (finer scroll sync in long lists; items are laid out on their own anyway).
//!
//! HTML (WebStorm's preview renders it; we have no HTML engine): `<img>` becomes an image, `<br>`
//! a line break, `<b> <strong> <i> <em> <s> <del> <code> <kbd> <a href>` style their text (`<ins>`
//! on the diff's inserted tint, as a spec edit's word diff marks new words), other
//! tags are dropped and their text kept, comments vanish. In HTML blocks (README headers) also:
//! `<h1>`..`<h6>` headings, `<hr>` rules, `align="center"` on p / div / h* centred, `<details>`
//! closed (only its `<summary>`, after a ▶, Chromium's default), `<picture>` its `<img>`.

use std::ops::Range;

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// How a run of text is drawn.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    /// Inline code (editor font on a tint).
    pub code: bool,
    /// `<kbd>`: inline code with a 1 px border (WS preview CSS `kbd`).
    pub kbd: bool,
    /// `<ins>`: on the diff's inserted tint (a spec edit's new words, D-26).
    pub ins: bool,
    /// A link's target (`https://…`, `other.md`, `#anchor`).
    pub link: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub style: Style,
}

/// One string with its style spans (sorted, non-overlapping; plain text has none).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Text {
    pub text: String,
    pub spans: Vec<Span>,
}

impl Text {
    pub fn plain(text: impl Into<String>) -> Text {
        Text {
            text: text.into(),
            spans: Vec::new(),
        }
    }

    fn push(&mut self, s: &str, style: &Style) {
        if s.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(s);
        if *style == Style::default() {
            return;
        }
        if let Some(last) = self.spans.last_mut()
            && last.style == *style
            && last.range.end == start
        {
            last.range.end = self.text.len();
            return;
        }
        self.spans.push(Span {
            range: start..self.text.len(),
            style: style.clone(),
        });
    }

    /// Leading / trailing whitespace off (CSS collapses it at line starts / ends).
    fn trim(&mut self) {
        let end = self.text.trim_end().len();
        let start = (self.text.len() - self.text.trim_start().len()).min(end);
        if start == 0 && end == self.text.len() {
            return;
        }
        self.text = self.text[start..end].to_owned();
        self.spans.retain_mut(|s| {
            s.range.start = s.range.start.saturating_sub(start).min(end - start);
            s.range.end = s.range.end.saturating_sub(start).min(end - start);
            s.range.start < s.range.end
        });
    }

    /// The link at byte `ix`.
    pub fn link_at(&self, ix: usize) -> Option<&str> {
        self.spans
            .iter()
            .find(|s| s.range.contains(&ix))
            .and_then(|s| s.style.link.as_deref())
    }
}

/// A paragraph's / heading's / cell's content: text, and images between it.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    Text(Text),
    Image(Image),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Image {
    pub src: String,
    pub alt: String,
    /// The link around it (`[![badge](…)](target)`).
    pub link: Option<String>,
    /// `<img width height>` (px).
    pub width: Option<f32>,
    pub height: Option<f32>,
}

/// A table cell / heading's content.
pub type Cell = Vec<Piece>;

/// The pieces' text as one (images by their alt text): slugs, plain copies.
pub fn pieces_text(pieces: &[Piece]) -> String {
    let mut out = String::new();
    for p in pieces {
        match p {
            Piece::Text(t) => out.push_str(&t.text),
            Piece::Image(i) => out.push_str(&i.alt),
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub aligns: Vec<Align>,
    pub head: Vec<Cell>,
    pub rows: Vec<Vec<Cell>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct List {
    /// Ordered: the first number.
    pub start: Option<u64>,
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// A task list item: checked?
    pub task: Option<bool>,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Para(Vec<Piece>),
    /// A paragraph / heading with `align="center"` (HTML blocks).
    Center(Box<Node>),
    Heading {
        level: u8,
        pieces: Vec<Piece>,
        /// The anchor id (`#slug` links), GitHub's rule.
        slug: String,
    },
    Code {
        lang: String,
        text: String,
    },
    Rule,
    List(List),
    Quote(Vec<Node>),
    Table(Table),
    Footnote {
        label: String,
        nodes: Vec<Node>,
    },
}

/// A top-level list's shape, for its item rows.
#[derive(Clone, Debug, PartialEq)]
pub struct ListHead {
    pub start: Option<u64>,
    /// The item's index in its list.
    pub index: usize,
    pub count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Node(Node),
    /// One item of a top-level list.
    Item {
        list: ListHead,
        item: Item,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// Source lines (0-based, end exclusive; at least one line).
    pub lines: Range<usize>,
    pub kind: RowKind,
}

/// Parses `src` into rows.
pub fn parse(src: &str) -> Vec<Row> {
    let mut b = Builder::new(src);
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES;
    for (ev, range) in Parser::new_ext(src, opts).into_offset_iter() {
        b.event(ev, range);
    }
    b.finish()
}

/// Where a heading's `#slug` points: (slug, row index).
pub fn anchors(rows: &[Row]) -> Vec<(&str, usize)> {
    rows.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.kind {
            RowKind::Node(Node::Heading { slug, .. }) => Some((slug.as_str(), i)),
            _ => None,
        })
        .collect()
}

/// GitHub's heading id: lowercase, letters / digits / `-` / `_` kept, spaces to `-`, the rest
/// dropped.
pub fn slug(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

enum Frame {
    Quote(Vec<Node>),
    List {
        start: Option<u64>,
        items: Vec<Item>,
        /// Each item's first byte (row line ranges).
        starts: Vec<usize>,
    },
    Item {
        task: Option<bool>,
        nodes: Vec<Node>,
    },
    Footnote {
        label: String,
        nodes: Vec<Node>,
    },
    Table {
        table: Table,
        row: Vec<Cell>,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum InlineKind {
    Para,
    Heading(u8),
    Cell,
}

/// Inline content being collected.
struct Inline {
    kind: InlineKind,
    pieces: Vec<Piece>,
    cur: Text,
    start: usize,
}

impl Inline {
    fn new(kind: InlineKind, start: usize) -> Inline {
        Inline {
            kind,
            pieces: Vec::new(),
            cur: Text::default(),
            start,
        }
    }

    fn flush_text(&mut self) {
        if !self.cur.text.is_empty() {
            self.pieces.push(Piece::Text(std::mem::take(&mut self.cur)));
        }
    }

    /// The pieces, text trimmed, empty ones dropped.
    fn into_pieces(mut self) -> Vec<Piece> {
        self.flush_text();
        self.pieces
            .into_iter()
            .filter_map(|p| match p {
                Piece::Text(mut t) => {
                    t.trim();
                    (!t.text.is_empty()).then_some(Piece::Text(t))
                }
                img => Some(img),
            })
            .collect()
    }
}

struct Builder<'s> {
    src: &'s str,
    line_starts: Vec<usize>,
    rows: Vec<Row>,
    frames: Vec<Frame>,
    inline: Option<Inline>,
    bold: usize,
    italic: usize,
    strike: usize,
    code_tag: usize,
    kbd_tag: usize,
    ins_tag: usize,
    links: Vec<String>,
    image: Option<(String, String)>,
    code: Option<(String, String, usize)>,
    html: Option<(String, usize)>,
    /// Inside an HTML block: its block structure.
    hblock: Option<HtmlBlock>,
    /// Open `<details>`: their content is hidden (also markdown between the HTML blocks), but the
    /// summary.
    details: usize,
    /// The HTML block's own nodes are being emitted (a summary inside open details).
    html_emitting: bool,
    slugs: Vec<String>,
}

/// An HTML block's state while its tags are read (see the module doc).
#[derive(Default)]
struct HtmlBlock {
    /// The open p / div / h* has `align="center"`.
    center: bool,
    /// An open `<hN>`.
    heading: Option<u8>,
    in_summary: bool,
    out: Vec<Node>,
}

impl<'s> Builder<'s> {
    fn new(src: &'s str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(src.match_indices('\n').map(|(i, _)| i + 1));
        Builder {
            src,
            line_starts,
            rows: Vec::new(),
            frames: Vec::new(),
            inline: None,
            bold: 0,
            italic: 0,
            strike: 0,
            code_tag: 0,
            kbd_tag: 0,
            ins_tag: 0,
            hblock: None,
            details: 0,
            html_emitting: false,
            links: Vec::new(),
            image: None,
            code: None,
            html: None,
            slugs: Vec::new(),
        }
    }

    fn line_of(&self, byte: usize) -> usize {
        self.line_starts
            .partition_point(|&s| s <= byte)
            .saturating_sub(1)
    }

    /// Source lines of bytes `range` (at least one line).
    fn lines(&self, range: Range<usize>) -> Range<usize> {
        let first = self.line_of(range.start);
        let end = if range.end > range.start {
            // a block's range ends after its last newline: that line isn't part of it
            let last_byte = range.end - 1;
            let last =
                if self.src.as_bytes().get(last_byte) == Some(&b'\n') && last_byte > range.start {
                    self.line_of(last_byte - 1)
                } else {
                    self.line_of(last_byte)
                };
            last + 1
        } else {
            first + 1
        };
        first..end.max(first + 1)
    }

    fn style(&self) -> Style {
        Style {
            bold: self.bold > 0,
            italic: self.italic > 0,
            strike: self.strike > 0,
            code: self.code_tag > 0 || self.kbd_tag > 0,
            kbd: self.kbd_tag > 0,
            ins: self.ins_tag > 0,
            link: self.links.last().cloned(),
        }
    }

    /// Inline content to add to: the open one, or an implicit paragraph (tight list items).
    fn inline_at(&mut self, start: usize) -> &mut Inline {
        self.inline
            .get_or_insert_with(|| Inline::new(InlineKind::Para, start))
    }

    fn text(&mut self, s: &str, start: usize) {
        if let Some((_, alt)) = self.image.as_mut() {
            alt.push_str(s);
            return;
        }
        let style = self.style();
        if style.link.is_some() || style.code {
            self.inline_at(start).cur.push(s, &style);
            return;
        }
        // GFM autolinks: bare http(s):// and www. URLs
        for (piece, url) in autolinks(s) {
            let st = match url {
                Some(u) => Style {
                    link: Some(u),
                    ..style.clone()
                },
                None => style.clone(),
            };
            self.inline_at(start).cur.push(piece, &st);
        }
    }

    /// A finished block: a row at the top level, else into its container.
    fn emit(&mut self, node: Node, range: Range<usize>) {
        if self.details > 0 && !self.html_emitting {
            return; // inside a closed <details>
        }
        match self.frames.last_mut() {
            Some(Frame::Quote(nodes))
            | Some(Frame::Item { nodes, .. })
            | Some(Frame::Footnote { nodes, .. }) => nodes.push(node),
            Some(Frame::List { .. }) | Some(Frame::Table { .. }) => {}
            None => {
                let lines = self.lines(range);
                self.rows.push(Row {
                    lines,
                    kind: RowKind::Node(node),
                });
            }
        }
    }

    /// Closes the open inline content as a paragraph (a tight list item's text).
    fn close_para(&mut self, end: usize) {
        if let Some(inl) = self.inline.take() {
            let start = inl.start;
            match inl.kind {
                InlineKind::Para => {
                    let pieces = inl.into_pieces();
                    if !pieces.is_empty() {
                        self.emit(Node::Para(pieces), start..end);
                    }
                }
                // (headings / cells close on their own end tags)
                _ => self.inline = Some(inl),
            }
        }
    }

    fn unique_slug(&mut self, text: &str) -> String {
        let base = slug(text);
        let mut s = base.clone();
        let mut n = 0;
        while self.slugs.contains(&s) {
            n += 1;
            s = format!("{base}-{n}");
        }
        self.slugs.push(s.clone());
        s
    }

    fn event(&mut self, ev: Event, range: Range<usize>) {
        if let Some((html, _)) = self.html.as_mut() {
            match ev {
                Event::Html(h) | Event::Text(h) => {
                    html.push_str(&h);
                    return;
                }
                Event::End(TagEnd::HtmlBlock) => {
                    let (html, start) = self.html.take().unwrap_or_default();
                    self.html_block(&html, start..range.end);
                    return;
                }
                _ => {}
            }
        }
        if let Some((_, text, _)) = self.code.as_mut() {
            match ev {
                Event::Text(t) => {
                    text.push_str(&t);
                    return;
                }
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, mut text, start) = self.code.take().unwrap_or_default();
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    self.emit(Node::Code { lang, text }, start..range.end);
                    return;
                }
                _ => return,
            }
        }
        match ev {
            Event::Start(tag) => self.start(tag, range),
            Event::End(tag) => self.end(tag, range),
            Event::Text(t) => self.text(&t, range.start),
            Event::Code(t) => {
                if let Some((_, alt)) = self.image.as_mut() {
                    alt.push_str(&t);
                    return;
                }
                let mut style = self.style();
                style.code = true;
                self.inline_at(range.start).cur.push(&t, &style);
            }
            Event::InlineMath(t) | Event::DisplayMath(t) => self.text(&t, range.start),
            Event::SoftBreak => self.text(" ", range.start),
            Event::HardBreak => self.text("\n", range.start),
            Event::Rule => {
                self.close_para(range.start);
                self.emit(Node::Rule, range);
            }
            Event::TaskListMarker(done) => {
                if let Some(Frame::Item { task, .. }) = self.frames.last_mut() {
                    *task = Some(done);
                }
            }
            Event::FootnoteReference(label) => {
                let style = Style {
                    link: Some(format!("#fn-{}", slug(&label))),
                    ..self.style()
                };
                self.inline_at(range.start)
                    .cur
                    .push(&format!("[{label}]"), &style);
            }
            Event::InlineHtml(h) | Event::Html(h) => self.inline_html(&h, range.start),
        }
    }

    fn start(&mut self, tag: Tag, range: Range<usize>) {
        match tag {
            Tag::Paragraph => {
                self.close_para(range.start);
                self.inline = Some(Inline::new(InlineKind::Para, range.start));
            }
            Tag::Heading { level, .. } => {
                self.close_para(range.start);
                let n = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
                self.inline = Some(Inline::new(InlineKind::Heading(n), range.start));
            }
            Tag::BlockQuote(_) => {
                self.close_para(range.start);
                self.frames.push(Frame::Quote(Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                self.close_para(range.start);
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info
                        .split(|c: char| c.is_whitespace() || c == ',' || c == '{')
                        .next()
                        .unwrap_or("")
                        .to_owned(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.code = Some((lang, String::new(), range.start));
            }
            Tag::HtmlBlock => {
                self.close_para(range.start);
                self.html = Some((String::new(), range.start));
            }
            Tag::List(start) => {
                self.close_para(range.start);
                self.frames.push(Frame::List {
                    start,
                    items: Vec::new(),
                    starts: Vec::new(),
                });
            }
            Tag::Item => {
                self.close_para(range.start);
                if let Some(Frame::List { starts, .. }) = self.frames.last_mut() {
                    starts.push(range.start);
                }
                self.frames.push(Frame::Item {
                    task: None,
                    nodes: Vec::new(),
                });
            }
            Tag::FootnoteDefinition(label) => {
                self.close_para(range.start);
                self.frames.push(Frame::Footnote {
                    label: label.to_string(),
                    nodes: Vec::new(),
                });
            }
            Tag::Table(aligns) => {
                self.close_para(range.start);
                let aligns = aligns
                    .iter()
                    .map(|a| match a {
                        Alignment::None => Align::None,
                        Alignment::Left => Align::Left,
                        Alignment::Center => Align::Center,
                        Alignment::Right => Align::Right,
                    })
                    .collect();
                self.frames.push(Frame::Table {
                    table: Table {
                        aligns,
                        head: Vec::new(),
                        rows: Vec::new(),
                    },
                    row: Vec::new(),
                });
            }
            Tag::TableCell => self.inline = Some(Inline::new(InlineKind::Cell, range.start)),
            Tag::Emphasis => self.italic += 1,
            Tag::Strong => self.bold += 1,
            Tag::Strikethrough => self.strike += 1,
            Tag::Link { dest_url, .. } => self.links.push(dest_url.to_string()),
            Tag::Image { dest_url, .. } => self.image = Some((dest_url.to_string(), String::new())),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd, range: Range<usize>) {
        match tag {
            TagEnd::Paragraph => self.close_para(range.end),
            TagEnd::Heading(_) => {
                if let Some(inl) = self.inline.take() {
                    let level = match inl.kind {
                        InlineKind::Heading(n) => n,
                        _ => 1,
                    };
                    let pieces = inl.into_pieces();
                    // (the anchor is the heading's text, not its images' alt)
                    let words: Vec<&str> = pieces
                        .iter()
                        .filter_map(|p| match p {
                            Piece::Text(t) => Some(t.text.as_str()),
                            Piece::Image(_) => None,
                        })
                        .collect();
                    let slug = self.unique_slug(&words.join(" "));
                    self.emit(
                        Node::Heading {
                            level,
                            pieces,
                            slug,
                        },
                        range,
                    );
                }
            }
            TagEnd::BlockQuote(_) => {
                self.close_para(range.end);
                if let Some(Frame::Quote(nodes)) = self.frames.pop() {
                    self.emit(Node::Quote(nodes), range);
                }
            }
            TagEnd::Item => {
                self.close_para(range.end);
                if let Some(Frame::Item { task, nodes }) = self.frames.pop()
                    && let Some(Frame::List { items, .. }) = self.frames.last_mut()
                {
                    items.push(Item { task, nodes });
                }
            }
            TagEnd::List(_) => {
                self.close_para(range.end);
                let Some(Frame::List {
                    start,
                    items,
                    starts,
                }) = self.frames.pop()
                else {
                    return;
                };
                if self.frames.is_empty() {
                    // one row per item: from its start to the next one's
                    let count = items.len();
                    for (index, item) in items.into_iter().enumerate() {
                        let s = starts.get(index).copied().unwrap_or(range.start);
                        let e = starts.get(index + 1).copied().unwrap_or(range.end);
                        let lines = self.lines(s..e);
                        self.rows.push(Row {
                            lines,
                            kind: RowKind::Item {
                                list: ListHead {
                                    start,
                                    index,
                                    count,
                                },
                                item,
                            },
                        });
                    }
                } else {
                    self.emit(Node::List(List { start, items }), range);
                }
            }
            TagEnd::FootnoteDefinition => {
                self.close_para(range.end);
                if let Some(Frame::Footnote { label, nodes }) = self.frames.pop() {
                    self.emit(Node::Footnote { label, nodes }, range);
                }
            }
            TagEnd::TableCell => {
                if let Some(inl) = self.inline.take()
                    && let Some(Frame::Table { row, .. }) = self.frames.last_mut()
                {
                    row.push(inl.into_pieces());
                }
            }
            TagEnd::TableHead => {
                if let Some(Frame::Table { table, row }) = self.frames.last_mut() {
                    table.head = std::mem::take(row);
                }
            }
            TagEnd::TableRow => {
                if let Some(Frame::Table { table, row }) = self.frames.last_mut() {
                    table.rows.push(std::mem::take(row));
                }
            }
            TagEnd::Table => {
                if let Some(Frame::Table { table, .. }) = self.frames.pop() {
                    self.emit(Node::Table(table), range);
                }
            }
            TagEnd::Emphasis => self.italic = self.italic.saturating_sub(1),
            TagEnd::Strong => self.bold = self.bold.saturating_sub(1),
            TagEnd::Strikethrough => self.strike = self.strike.saturating_sub(1),
            TagEnd::Link => {
                self.links.pop();
            }
            TagEnd::Image => {
                if let Some((src, alt)) = self.image.take() {
                    let link = self.links.last().cloned();
                    let inl = self.inline_at(range.start);
                    inl.flush_text();
                    inl.pieces.push(Piece::Image(Image {
                        src,
                        alt,
                        link,
                        ..Image::default()
                    }));
                }
            }
            _ => {}
        }
    }

    /// Inline HTML: the tags we can show (see the module doc).
    fn inline_html(&mut self, html: &str, start: usize) {
        let mut rest = html;
        while !rest.is_empty() {
            let Some(lt) = rest.find('<') else {
                if !self.html_hidden() {
                    self.text(&decode_entities(rest), start);
                }
                break;
            };
            if lt > 0 && !self.html_hidden() {
                self.text(&decode_entities(&rest[..lt]), start);
            }
            rest = &rest[lt..];
            if let Some(after) = rest.strip_prefix("<!--") {
                rest = after.find("-->").map_or("", |e| &after[e + 3..]);
                continue;
            }
            let Some(gt) = rest.find('>') else {
                self.text(&decode_entities(rest), start);
                break;
            };
            let tag = &rest[1..gt];
            rest = &rest[gt + 1..];
            self.html_tag(tag, start);
        }
    }

    /// Text inside a closed `<details>` (not its summary) isn't shown.
    fn html_hidden(&self) -> bool {
        self.details > 0 && !self.hblock.as_ref().is_some_and(|h| h.in_summary)
    }

    /// HTML block structure; true: the tag was handled.
    fn html_block_tag(&mut self, name: &str, body: &str, closing: bool, start: usize) -> bool {
        if self.hblock.is_none() {
            return false;
        }
        let center = attr(body, "align").is_some_and(|a| a.eq_ignore_ascii_case("center"));
        let level = match name {
            "h1" => Some(1),
            "h2" => Some(2),
            "h3" => Some(3),
            "h4" => Some(4),
            "h5" => Some(5),
            "h6" => Some(6),
            _ => None,
        };
        match (name, level) {
            (_, Some(l)) => {
                self.html_flush(start);
                if let Some(h) = self.hblock.as_mut() {
                    h.heading = (!closing).then_some(l);
                    h.center = !closing && center;
                }
            }
            ("p" | "div", _) => {
                self.html_flush(start);
                if let Some(h) = self.hblock.as_mut() {
                    h.center = !closing && center;
                }
            }
            ("hr", _) => {
                self.html_flush(start);
                if let Some(h) = self.hblock.as_mut() {
                    h.out.push(Node::Rule);
                }
            }
            ("details", _) => {
                self.html_flush(start);
                self.details = if closing {
                    self.details.saturating_sub(1)
                } else {
                    self.details + 1
                };
            }
            ("summary", _) => {
                if closing {
                    self.html_flush(start);
                    if let Some(h) = self.hblock.as_mut() {
                        h.in_summary = false;
                    }
                } else {
                    self.html_flush(start);
                    if let Some(h) = self.hblock.as_mut() {
                        h.in_summary = true;
                    }
                    self.text("\u{25b6}\u{a0}", start);
                }
            }
            _ => return false,
        }
        true
    }

    /// The HTML block's text so far becomes a node (paragraph / heading, centred or not).
    fn html_flush(&mut self, start: usize) {
        let Some(inl) = self.inline.replace(Inline::new(InlineKind::Para, start)) else {
            return;
        };
        let mut pieces = inl.into_pieces();
        for p in &mut pieces {
            if let Piece::Text(t) = p {
                collapse_newlines(t);
            }
        }
        pieces.retain(|p| !matches!(p, Piece::Text(t) if t.text.is_empty()));
        if pieces.is_empty() {
            return;
        }
        let Some((heading, center)) = self.hblock.as_ref().map(|h| (h.heading, h.center)) else {
            return;
        };
        let node = match heading {
            Some(level) => {
                let slug = self.unique_slug(&pieces_text(&pieces));
                Node::Heading {
                    level,
                    pieces,
                    slug,
                }
            }
            None => Node::Para(pieces),
        };
        let node = if center {
            Node::Center(Box::new(node))
        } else {
            node
        };
        if let Some(h) = self.hblock.as_mut() {
            h.out.push(node);
        }
    }

    fn html_tag(&mut self, tag: &str, start: usize) {
        let closing = tag.starts_with('/');
        let body = tag.trim_start_matches('/').trim_end_matches('/');
        let name = body
            .split(|c: char| c.is_whitespace())
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if self.html_block_tag(&name, body, closing, start) {
            return;
        }
        let n = |c: &mut usize| {
            if closing {
                *c = c.saturating_sub(1)
            } else {
                *c += 1
            }
        };
        match name.as_str() {
            "br" => self.text("\n", start),
            "b" | "strong" => n(&mut self.bold),
            "i" | "em" => n(&mut self.italic),
            "s" | "del" | "strike" => n(&mut self.strike),
            "code" => n(&mut self.code_tag),
            "kbd" => n(&mut self.kbd_tag),
            "ins" => n(&mut self.ins_tag),
            "a" if closing => {
                self.links.pop();
            }
            "a" => self
                .links
                .push(attr(body, "href").unwrap_or_default().to_owned()),
            "img" if !closing => {
                if let Some(src) = attr(body, "src") {
                    let alt = attr(body, "alt").unwrap_or_default().to_owned();
                    let px = |name| {
                        attr(body, name)
                            .and_then(|v| v.trim().trim_end_matches("px").parse::<f32>().ok())
                            .filter(|v| *v > 0.)
                    };
                    let (width, height) = (px("width"), px("height"));
                    let link = self.links.last().cloned().filter(|l| !l.is_empty());
                    let inl = self.inline_at(start);
                    inl.flush_text();
                    inl.pieces.push(Piece::Image(Image {
                        src: src.to_owned(),
                        alt,
                        link,
                        width,
                        height,
                    }));
                }
            }
            // block tags end a line of text
            "p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "tr" if closing => {
                self.text("\n", start)
            }
            _ => {}
        }
    }

    /// An HTML block: its paragraphs / headings / rules (nothing for comments only).
    fn html_block(&mut self, html: &str, range: Range<usize>) {
        let outer = self.inline.take();
        self.inline = Some(Inline::new(InlineKind::Para, range.start));
        self.hblock = Some(HtmlBlock::default());
        // newlines in HTML source are spaces (block tags add the breaks)
        let flat: String = html.lines().map(str::trim).collect::<Vec<_>>().join(" ");
        self.inline_html(&flat, range.start);
        self.html_flush(range.start);
        let block = self.hblock.take().unwrap_or_default();
        self.inline = outer;
        self.html_emitting = true;
        for node in block.out {
            self.emit(node, range.clone());
        }
        self.html_emitting = false;
    }

    fn finish(mut self) -> Vec<Row> {
        let end = self.src.len();
        self.close_para(end);
        self.rows
    }
}

/// `s` cut at bare URLs: (piece, its link target for URL pieces). GFM's extended autolinks:
/// `http://`, `https://`, `www.` up to whitespace / `<`, trailing punctuation and unbalanced `)`
/// left out.
pub fn autolinks(s: &str) -> Vec<(&str, Option<String>)> {
    let mut out = Vec::new();
    let mut at = 0;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let boundary = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let scheme = if rest.starts_with("https://") || rest.starts_with("http://") {
            Some("")
        } else if rest.starts_with("www.") {
            Some("http://")
        } else {
            None
        };
        if let (true, Some(prefix)) = (boundary, scheme) {
            let mut end = i + rest
                .find(|c: char| c.is_whitespace() || c == '<')
                .unwrap_or(rest.len());
            // trailing punctuation isn't part of it; a `)` only when balanced
            loop {
                let url = &s[i..end];
                let Some(last) = url.chars().last() else {
                    break;
                };
                let unbalanced = last == ')' && url.matches(')').count() > url.matches('(').count();
                if ".,:;!?\"'*_~".contains(last) || unbalanced {
                    end -= last.len_utf8();
                } else {
                    break;
                }
            }
            let url = &s[i..end];
            let host = url.split_once("://").map_or(url, |(_, h)| h);
            let valid = if prefix.is_empty() {
                !host.is_empty()
            } else {
                host.get(4..).is_some_and(|h| h.contains('.'))
            };
            if valid {
                if at < i {
                    out.push((&s[at..i], None));
                }
                out.push((url, Some(format!("{prefix}{url}"))));
                at = end;
                i = end;
                continue;
            }
        }
        i += rest.chars().next().map_or(1, char::len_utf8);
    }
    if at < s.len() {
        out.push((&s[at..], None));
    }
    out
}

/// `name="value"` (or 'value') of a tag's attributes.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let v = rest[1..].trim_start();
        let (q, v) = match v.chars().next() {
            Some(q @ ('"' | '\'')) => (Some(q), &v[1..]),
            _ => (None, v),
        };
        let end = match q {
            Some(q) => v.find(q).unwrap_or(v.len()),
            None => v.find(|c: char| c.is_whitespace()).unwrap_or(v.len()),
        };
        return Some(&v[..end]);
    }
    None
}

/// Runs of line breaks / blanks from HTML structure -> single breaks, none at the ends.
fn collapse_newlines(t: &mut Text) {
    if !t.text.contains('\n') {
        return;
    }
    // rebuild keeping spans: drop a char when it's a newline / blank next to a newline
    let src = std::mem::take(t);
    let mut out = Text::default();
    let mut prev_nl = true;
    let chars: Vec<(usize, char)> = src.text.char_indices().collect();
    for (k, &(i, c)) in chars.iter().enumerate() {
        let next_nl = chars[k + 1..]
            .iter()
            .find(|(_, c)| *c != ' ')
            .is_none_or(|(_, c)| *c == '\n');
        if (c == '\n' && prev_nl) || (c == ' ' && (prev_nl || next_nl)) {
            continue;
        }
        let style = src
            .spans
            .iter()
            .find(|s| s.range.contains(&i))
            .map(|s| s.style.clone())
            .unwrap_or_default();
        out.push(c.encode_utf8(&mut [0; 4]), &style);
        prev_nl = c == '\n';
    }
    while out.text.ends_with('\n') {
        out.text.pop();
        let len = out.text.len();
        out.spans.retain_mut(|s| {
            s.range.end = s.range.end.min(len);
            s.range.start < s.range.end
        });
    }
    *t = out;
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    s.replace("&nbsp;", "\u{a0}")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// The plain text of a node (copy, tests).
#[cfg(test)]
pub fn node_text(node: &Node, out: &mut Vec<String>) {
    match node {
        Node::Para(pieces) => {
            for p in pieces {
                if let Piece::Text(t) = p {
                    out.push(t.text.clone());
                }
            }
        }
        Node::Heading { pieces, .. } => out.push(pieces_text(pieces)),
        Node::Center(n) => node_text(n, out),
        Node::Code { text, .. } => out.push(text.clone()),
        Node::Rule => {}
        Node::List(l) => {
            for item in &l.items {
                for n in &item.nodes {
                    node_text(n, out);
                }
            }
        }
        Node::Quote(nodes) | Node::Footnote { nodes, .. } => {
            for n in nodes {
                node_text(n, out);
            }
        }
        Node::Table(t) => {
            for row in std::iter::once(&t.head).chain(&t.rows) {
                out.push(
                    row.iter()
                        .map(|c| pieces_text(c))
                        .collect::<Vec<_>>()
                        .join("\t"),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use super::*;

    fn kinds(rows: &[Row]) -> Vec<&RowKind> {
        rows.iter().map(|r| &r.kind).collect()
    }

    fn para(row: &Row) -> &[Piece] {
        let RowKind::Node(Node::Para(p)) = &row.kind else {
            panic!("not a paragraph: {row:?}")
        };
        p
    }

    fn text(piece: &Piece) -> &Text {
        let Piece::Text(t) = piece else {
            panic!("not text: {piece:?}")
        };
        t
    }

    /// (name, markdown, what `parse` makes of it)
    type Case = (&'static str, &'static str, fn(&[Row]));

    const PARSES: &[Case] = &[
        (
            "blocks keep their source lines",
            "# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n---\n",
            |rows| {
                let lines: Vec<_> = rows.iter().map(|r| r.lines.clone()).collect();
                assert_eq!(lines, vec![0..1, 2..3, 4..5, 5..6, 7..10, 11..12]);
                assert!(
                    matches!(&rows[0].kind, RowKind::Node(Node::Heading { level: 1, slug, .. }) if slug == "title")
                );
                let t = text(&para(&rows[1])[0]);
                assert_eq!(t.text, "Some bold text.");
                assert_eq!(t.spans[0].range, 5..9);
                assert!(t.spans[0].style.bold);
                assert!(matches!(
                    &rows[2].kind,
                    RowKind::Item {
                        list: ListHead {
                            index: 0,
                            count: 2,
                            start: None
                        },
                        ..
                    }
                ));
                assert_eq!(
                    rows[4].kind,
                    RowKind::Node(Node::Code {
                        lang: "ts".into(),
                        text: "const x = 1;".into()
                    })
                );
                assert_eq!(rows[5].kind, RowKind::Node(Node::Rule));
            },
        ),
        (
            "a soft break is a space, a hard break a newline",
            "a\nb  \nc",
            |rows| {
                assert_eq!(para(&rows[0]), &[Piece::Text(Text::plain("a b\nc"))]);
                assert_eq!(rows[0].lines, 0..3);
            },
        ),
        (
            "tasks, links, inline code and strike",
            "- [ ] todo\n- [x] done\n\n[a link](https://x.y) `c` ~~s~~\n",
            |rows| {
                let RowKind::Item { item, .. } = &rows[0].kind else {
                    panic!()
                };
                assert_eq!(item.task, Some(false));
                let RowKind::Item { item, .. } = &rows[1].kind else {
                    panic!()
                };
                assert_eq!(item.task, Some(true));
                let t = text(&para(&rows[2])[0]);
                assert_eq!(t.text, "a link c s");
                assert_eq!(t.link_at(0), Some("https://x.y"));
                assert_eq!(t.link_at(7), None);
                assert!(t.spans.iter().any(|s| s.style.code && s.range == (7..8)));
                assert!(t.spans.iter().any(|s| s.style.strike && s.range == (9..10)));
            },
        ),
        (
            "ins tints its text, del strikes",
            "Code <del>first.</del><ins>first, always.</ins>\n",
            |rows| {
                let t = text(&para(&rows[0])[0]);
                let ins: Vec<&str> = t
                    .spans
                    .iter()
                    .filter(|s| s.style.ins)
                    .map(|s| &t.text[s.range.clone()])
                    .collect();
                assert_eq!(ins, ["first, always."]);
                assert!(t.spans.iter().any(|s| s.style.strike && !s.style.ins));
            },
        ),
        (
            "kbd is code with its own flag",
            "press <kbd>Cmd</kbd> and `x`\n",
            |rows| {
                let t = text(&para(&rows[0])[0]);
                let kbd: Vec<_> = t.spans.iter().filter(|s| s.style.kbd).collect();
                assert_eq!(kbd.len(), 1);
                assert!(kbd[0].style.code);
                assert_eq!(&t.text[kbd[0].range.clone()], "Cmd");
                assert!(t.spans.iter().any(|s| s.style.code && !s.style.kbd));
            },
        ),
        (
            "nested lists, quotes and tables",
            "1. a\n   - b\n2. c\n\n> q **x**\n> more\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n",
            |rows| {
                assert_eq!(rows.len(), 4, "{:#?}", kinds(rows));
                let RowKind::Item { list, item } = &rows[0].kind else {
                    panic!()
                };
                assert_eq!(list.start, Some(1));
                assert_eq!(rows[0].lines, 0..2);
                assert!(
                    matches!(&item.nodes[1], Node::List(l) if l.start.is_none() && l.items.len() == 1)
                );
                assert!(matches!(&rows[2].kind, RowKind::Node(Node::Quote(n)) if n.len() == 1));
                assert_eq!(rows[2].lines, 4..6);
                let RowKind::Node(Node::Table(t)) = &rows[3].kind else {
                    panic!()
                };
                assert_eq!(t.aligns, vec![Align::Left, Align::Right]);
                assert_eq!(pieces_text(&t.head[0]), "A");
                assert_eq!(pieces_text(&t.rows[0][1]), "2");
                assert_eq!(rows[3].lines, 7..10);
            },
        ),
        (
            "images, centred html and a comment with no row",
            "![Alt](img.png)\n\n<p align=\"center\"><img src=\"a.png\" alt=\"x\"><br>Hi <b>there</b></p>\n\n<!-- c -->\n",
            |rows| {
                assert_eq!(
                    para(&rows[0]),
                    &[Piece::Image(Image {
                        src: "img.png".into(),
                        alt: "Alt".into(),
                        ..Image::default()
                    })]
                );
                let RowKind::Node(Node::Center(n)) = &rows[1].kind else {
                    panic!("{rows:#?}")
                };
                let Node::Para(p) = &**n else { panic!() };
                assert!(matches!(&p[0], Piece::Image(i) if i.src == "a.png"));
                let t = text(&p[1]);
                assert_eq!(t.text, "Hi there");
                assert!(t.spans[0].style.bold);
                assert_eq!(rows.len(), 2);
            },
        ),
        (
            "html blocks keep headings, rules, centring and closed details",
            "<p align=\"center\">\n  <img src=\"logo.png\" width=\"80\">\n</p>\n\n\
             <h1 align=\"center\">My Tool</h1>\n\n<hr>\n\n\
             <details>\n<summary>More info</summary>\n\nhidden text\n\n</details>\n\n\
             <picture><source srcset=\"dark.png\"><img src=\"light.png\" alt=\"pic\"></picture>\n",
            |rows| {
                let mut texts = Vec::new();
                for r in rows {
                    if let RowKind::Node(n) = &r.kind {
                        node_text(n, &mut texts);
                    }
                }
                let k = kinds(rows);
                assert!(matches!(k[0], RowKind::Node(Node::Center(n))
                    if matches!(&**n, Node::Para(p) if matches!(p[0], Piece::Image(_)))));
                // a centred h1 keeps its own anchor
                assert!(matches!(k[1], RowKind::Node(Node::Center(n))
                    if matches!(&**n, Node::Heading { level: 1, slug, .. } if slug == "my-tool")));
                assert!(rows.iter().any(|r| r.kind == RowKind::Node(Node::Rule)));
                // details stay closed: only the summary shows
                assert!(
                    texts
                        .iter()
                        .any(|t| t.contains("\u{25b6}") && t.contains("More info")),
                    "{texts:?}"
                );
                assert!(
                    !texts.iter().any(|t| t.contains("hidden text")),
                    "{texts:?}"
                );
                // a picture shows its img
                assert!(matches!(&para(rows.last().unwrap())[0],
                    Piece::Image(i) if i.src == "light.png"));
            },
        ),
        (
            "blank text between images and linked badges",
            "![a](i.png) ![b](i.png)\n\n[![CI](https://x/ci.svg)](https://x/ci)\n[![npm](https://x/n.svg)](https://x/n)\n",
            |rows| {
                // an all-blank text piece between images used to crash
                assert_eq!(para(&rows[0]).len(), 2);
                let p = para(&rows[1]);
                assert!(
                    matches!(&p[0], Piece::Image(i) if i.link.as_deref() == Some("https://x/ci"))
                );
                assert!(
                    matches!(&p[1], Piece::Image(i) if i.link.as_deref() == Some("https://x/n"))
                );
                let mut t = Text::plain("  \n ");
                t.trim();
                assert_eq!(t.text, "");
            },
        ),
        (
            "html image sizes, images in headings and table cells",
            "<img src=\"logo.png\" width=\"80\">\n\n# ![i](i.png) Head\n\n| ![x](x.png) | a |\n|---|---|\n| b | c |\n",
            |rows| {
                assert!(
                    matches!(&para(&rows[0])[0], Piece::Image(i) if i.width == Some(80.) && i.height.is_none())
                );
                let RowKind::Node(Node::Heading { pieces, slug, .. }) = &rows[1].kind else {
                    panic!()
                };
                assert!(matches!(&pieces[0], Piece::Image(_)));
                assert_eq!(slug, "head");
                let RowKind::Node(Node::Table(t)) = &rows[2].kind else {
                    panic!()
                };
                assert!(matches!(&t.head[0][0], Piece::Image(i) if i.src == "x.png"));
            },
        ),
        (
            "a footnote links to its note",
            "x[^1]\n\n[^1]: note\n",
            |rows| {
                let t = text(&para(&rows[0])[0]);
                assert_eq!(t.text, "x[1]");
                assert_eq!(t.link_at(2), Some("#fn-1"));
                assert!(
                    matches!(&rows[1].kind, RowKind::Node(Node::Footnote { label, .. }) if label == "1")
                );
            },
        ),
        (
            "repeated headings get unique anchors",
            "# A\n\n# A\n",
            |rows| assert_eq!(anchors(rows), vec![("a", 0), ("a-1", 1)]),
        ),
        (
            "an edit keeps the other rows equal",
            "# T\n\npara\n\nlast\n",
            |a| {
                let b = parse("# T\n\npara!\n\nlast\n");
                assert_eq!(a[0], b[0]);
                assert_ne!(a[1], b[1]);
                assert_eq!(a[2].kind, b[2].kind);
            },
        ),
    ];

    #[test]
    fn parse_turns_markdown_into_rows() {
        for &(name, src, check) in PARSES {
            let rows = parse(src);
            let ok = catch_unwind(AssertUnwindSafe(|| check(&rows)));
            assert!(ok.is_ok(), "{name}");
        }
    }

    #[test]
    fn slugs_are_github_style() {
        for (heading, want) in [
            ("VimStorm Markdown", "vimstorm-markdown"),
            ("Quote & code!", "quote--code"),
        ] {
            assert_eq!(slug(heading), want, "{heading}");
        }
    }

    #[test]
    fn autolinks_split_bare_urls_from_text() {
        assert_eq!(
            autolinks("see https://github.com/a/b. and (www.x.org) ok"),
            vec![
                ("see ", None),
                (
                    "https://github.com/a/b",
                    Some("https://github.com/a/b".into())
                ),
                (". and (", None),
                ("www.x.org", Some("http://www.x.org".into())),
                (") ok", None)
            ]
        );
    }
}
