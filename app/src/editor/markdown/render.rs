//! A preview row -> GPUI elements, in WebStorm's preview CSS (see [`super::style`]): margins
//! between blocks collapse like CSS's; every text is one `StyledText` registered for hit testing
//! (selection, links) once it's laid out ([`Tracked`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::path::Path;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, Element, ElementId, FontStyle, FontWeight, GlobalElementId,
    HighlightStyle, InspectorElementId, InteractiveElement as _, IntoElement, LayoutId,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, StrikethroughStyle,
    Styled as _, StyledImage as _, StyledText, TextLayout, UnderlineStyle, Window, div, img,
    prelude::FluentBuilder as _, px, relative,
};

use super::doc::{Align, Cell, Image, Item, Node, Piece, Row, RowKind, Style, Table, Text};
use super::image::Images;
use super::style as s;
use crate::look::hsla;

/// Pads around inline code: CSS `margin: 2px` outside the tint, `padding: 0.4em` inside. Thin
/// spaces in the text itself (GPUI has no inline boxes); dropped again when copying.
pub const PAD: char = '\u{2009}';

/// A text as drawn: code spans padded.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Display {
    pub text: String,
    pub spans: Vec<(Range<usize>, Style)>,
}

impl Display {
    pub fn of(t: &Text) -> Display {
        if !t.spans.iter().any(|s| s.style.code) {
            return Display {
                text: t.text.clone(),
                spans: t
                    .spans
                    .iter()
                    .map(|s| (s.range.clone(), s.style.clone()))
                    .collect(),
            };
        }
        let mut out = Display::default();
        let mut at = 0;
        for sp in &t.spans {
            out.text.push_str(&t.text[at..sp.range.start]);
            if sp.style.code {
                // margin (plain), padding (tinted), code, padding, margin
                out.text.push(PAD);
                let start = out.text.len();
                out.text.push(PAD);
                out.text.push_str(&t.text[sp.range.clone()]);
                out.text.push(PAD);
                out.spans.push((start..out.text.len(), sp.style.clone()));
                out.text.push(PAD);
            } else {
                let start = out.text.len();
                out.text.push_str(&t.text[sp.range.clone()]);
                out.spans.push((start..out.text.len(), sp.style.clone()));
            }
            at = sp.range.end;
        }
        out.text.push_str(&t.text[at..]);
        out
    }

    pub fn link_at(&self, ix: usize) -> Option<(&str, Range<usize>)> {
        self.spans
            .iter()
            .find(|(r, _)| r.start <= ix && ix < r.end)
            .and_then(|(r, st)| Some((st.link.as_deref()?, r.clone())))
    }
}

/// The copied text of a display range: pads dropped.
pub fn copy_text(s: &str) -> String {
    s.chars().filter(|c| *c != PAD).collect()
}

/// A selection point: row, text (in render order), display byte.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub row: usize,
    pub text: usize,
    pub byte: usize,
}

/// One drawn text: its layout (hit testing), display text and the clip it was painted in (a
/// scroll's: what of it shows).
#[derive(Clone)]
pub struct Drawn {
    pub layout: TextLayout,
    pub display: Rc<Display>,
    pub clip: Option<Bounds<Pixels>>,
    /// When it was prepainted, of every text: texts laid out in the order they were drawn.
    pub seq: u64,
}

thread_local! {
    /// Texts prepainted so far ([`Drawn::seq`]).
    static PREPAINTED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

impl Drawn {
    /// What of it shows: its bounds inside its clip; none when scrolled out of it.
    pub fn shown(&self) -> Option<Bounds<Pixels>> {
        let b = self.layout.bounds();
        let b = match self.clip {
            Some(c) => b.intersect(&c),
            None => b,
        };
        (b.size.width > Pixels::ZERO && b.size.height > Pixels::ZERO).then_some(b)
    }
}

/// Texts laid out this frame, by (row, text).
pub type Registry = Rc<RefCell<HashMap<(usize, usize), Drawn>>>;

/// What frames reuse until the rows change (a new parse / image sizes): each text's display
/// form + its shared string (by the source's address in the rows), tables' column widths (by the
/// table's address and the body width).
/// A text's display form and its shared string.
type Shown = (Rc<Display>, SharedString);
/// A table's column widths by (its address, the body width's bits).
type Widths = HashMap<(usize, u32), Rc<Vec<f32>>>;

#[derive(Default)]
pub struct RenderCache {
    displays: RefCell<HashMap<usize, Shown>>,
    widths: RefCell<Widths>,
}

impl RenderCache {
    pub fn clear(&self) {
        self.displays.borrow_mut().clear();
        self.widths.borrow_mut().clear();
    }

    fn display(&self, key: usize, make: impl FnOnce() -> Display) -> Shown {
        self.displays
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let d = make();
                let s = SharedString::from(d.text.clone());
                (Rc::new(d), s)
            })
            .clone()
    }
}

/// Opens a link target (a linked image's click).
pub type OnLink = Rc<dyn Fn(String, &mut Window, &mut App)>;

/// A fence's colours: (range, 0xRRGGBB).
pub type Spans = Rc<Vec<(Range<usize>, u32)>>;

/// Code colors by (lang, code), looked up by `&str`s (every frame draws the fences: no key
/// clones there).
#[derive(Default)]
pub struct Colors(HashMap<String, HashMap<String, Spans>>);

impl Colors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, lang: &str, code: &str) -> Option<&Spans> {
        self.0.get(lang)?.get(code)
    }

    pub fn contains_key(&self, k: &(String, String)) -> bool {
        self.get(&k.0, &k.1).is_some()
    }

    pub fn insert(&mut self, k: (String, String), v: Spans) {
        self.0.entry(k.0).or_default().insert(k.1, v);
    }

    pub fn len(&self) -> usize {
        self.0.values().map(HashMap::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Keeps the (lang, code) entries `keep` says yes to.
    pub fn retain(&mut self, mut keep: impl FnMut(&str, &str) -> bool) {
        for (lang, codes) in self.0.iter_mut() {
            codes.retain(|code, _| keep(lang, code));
        }
        self.0.retain(|_, codes| !codes.is_empty());
    }
}

/// A text's find matches (display ranges), the current one's `true`; the text is the one drawn
/// under its (row, text) key in the registry.
pub type Marks<'a> = &'a dyn Fn(&str, Option<(usize, usize)>) -> Vec<(Range<usize>, bool)>;

pub struct RowCx<'a> {
    pub row: usize,
    pub profile: s::Profile,
    /// Ordered selection.
    pub sel: Option<(Pos, Pos)>,
    pub colors: &'a Colors,
    pub registry: &'a Registry,
    /// The markdown file's folder (relative images).
    pub dir: &'a Path,
    /// The hovered link: (text, display range).
    pub hover: Option<(usize, Range<usize>)>,
    pub id: SharedString,
    /// A text's natural width as drawn (its runs: bold, code, links; `bold`: all bold), for
    /// table columns.
    pub measure: &'a dyn Fn(&Display, bool) -> f32,
    /// A click on a linked image: its target.
    pub on_link: OnLink,
    /// The body's text width.
    pub avail: f32,
    /// The document's image sizes / cached files.
    pub imgs: &'a Images,
    pub cache: &'a RenderCache,
    /// Fenced code wraps its long lines instead of scrolling sideways (the rendered Chat's narrow
    /// column).
    pub wrap_code: bool,
    /// Find's matches in a text, marked (the rendered Chat's transcript): their ranges, the
    /// current one's `true`.
    pub marks: Option<Marks<'a>>,
    next: usize,
    images: usize,
}

impl<'a> RowCx<'a> {
    #[allow(
        clippy::too_many_arguments,
        reason = "the one constructor of this per-row borrow bundle"
    )]
    pub fn new(
        row: usize,
        sel: Option<(Pos, Pos)>,
        colors: &'a Colors,
        registry: &'a Registry,
        dir: &'a Path,
        hover: Option<(usize, Range<usize>)>,
        id: SharedString,
        measure: &'a dyn Fn(&Display, bool) -> f32,
        avail: f32,
        imgs: &'a Images,
        cache: &'a RenderCache,
        on_link: OnLink,
    ) -> Self {
        RowCx {
            row,
            profile: s::Profile::Preview,
            sel,
            colors,
            registry,
            dir,
            hover,
            id,
            measure,
            avail,
            imgs,
            cache,
            on_link,
            wrap_code: false,
            marks: None,
            next: 0,
            images: 0,
        }
    }

    /// The selected display range of text `k` (len `len`).
    fn selected(&self, k: usize, len: usize) -> Option<Range<usize>> {
        selected_in(self.sel?, (self.row, k), len)
    }

    /// A new linked image's element id.
    fn image_id(&mut self) -> ElementId {
        self.images += 1;
        ElementId::Name(format!("{}-{}-img{}", self.id, self.row, self.images).into())
    }

    fn element_id(&self, what: &str) -> ElementId {
        ElementId::Name(format!("{}-{}-{}-{what}", self.id, self.row, self.next).into())
    }
}

/// The display range of text `me` (`(row, text)`, len `len`) the ordered selection `(a, b)` covers.
pub fn selected_in((a, b): (Pos, Pos), me: (usize, usize), len: usize) -> Option<Range<usize>> {
    if me < (a.row, a.text) || me > (b.row, b.text) {
        return None;
    }
    let s = if me == (a.row, a.text) {
        a.byte.min(len)
    } else {
        0
    };
    let e = if me == (b.row, b.text) {
        b.byte.min(len)
    } else {
        len
    };
    (s < e).then_some(s..e)
}

/// A plain text registered for hit testing under `key` (the rendered Chat's step output), the
/// part of it the ordered selection `sel` covers drawn selected.
pub fn selectable_text(
    text: String,
    key: (usize, usize),
    sel: Option<(Pos, Pos)>,
    registry: &Registry,
) -> AnyElement {
    selectable_styled(text, Vec::new(), key, sel, registry)
}

/// [`selectable_text`] with its own runs (sorted, apart: a word's colour), the selection's
/// background over them.
pub fn selectable_styled(
    text: String,
    runs: Vec<(Range<usize>, HighlightStyle)>,
    key: (usize, usize),
    sel: Option<(Pos, Pos)>,
    registry: &Registry,
) -> AnyElement {
    let range = sel.and_then(|s| selected_in(s, key, text.len()));
    let shared = SharedString::from(text.clone());
    let styled = StyledText::new(shared).with_highlights(with_selected(runs, range));
    let layout = styled.layout().clone();
    Tracked {
        inner: styled.into_any_element(),
        kbd: None,
        key,
        drawn: Some(Drawn {
            layout,
            display: Rc::new(Display {
                text,
                spans: Vec::new(),
            }),
            clip: None,
            seq: 0,
        }),
        registry: registry.clone(),
    }
    .into_any_element()
}

/// `runs` (sorted, apart) with the selection's background over `selected`: cut where they meet.
fn with_selected(
    runs: Vec<(Range<usize>, HighlightStyle)>,
    selected: Option<Range<usize>>,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let Some(sel) = selected else {
        return runs;
    };
    let bg = HighlightStyle {
        background_color: Some(hsla(s::SELECTION_BG.rgba())),
        ..Default::default()
    };
    let mut cuts: Vec<usize> = runs
        .iter()
        .flat_map(|(r, _)| [r.start, r.end])
        .chain([sel.start, sel.end])
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2)
        .filter_map(|w| {
            let piece = w[0]..w[1];
            let own = runs
                .iter()
                .find(|(r, _)| r.start <= piece.start && piece.end <= r.end)
                .map(|(_, h)| *h);
            let selected = sel.start <= piece.start && piece.end <= sel.end;
            match (own, selected) {
                (Some(h), true) => Some((piece, h.highlight(bg))),
                (Some(h), false) => Some((piece, h)),
                (None, true) => Some((piece, bg)),
                (None, false) => None,
            }
        })
        .collect()
}

/// Every text of a row as display texts, in render order (copy of rows not on screen).
pub fn row_displays(row: &Row) -> Vec<Display> {
    let mut out = Vec::new();
    match &row.kind {
        RowKind::Node(n) => node_displays(n, &mut out),
        RowKind::Item { item, .. } => item_displays(item, &mut out),
    }
    out
}

fn item_displays(item: &Item, out: &mut Vec<Display>) {
    for n in &item.nodes {
        node_displays(n, out);
    }
}

fn pieces_displays(pieces: &[Piece], out: &mut Vec<Display>) {
    for p in pieces {
        if let Piece::Text(t) = p {
            out.push(Display::of(t));
        }
    }
}

fn node_displays(n: &Node, out: &mut Vec<Display>) {
    match n {
        Node::Para(pieces) | Node::Heading { pieces, .. } => pieces_displays(pieces, out),
        Node::Center(n) => node_displays(n, out),
        Node::Code { text, .. } => out.push(Display {
            text: text.clone(),
            spans: Vec::new(),
        }),
        Node::Rule => {}
        Node::List(l) => {
            for item in &l.items {
                item_displays(item, out);
            }
        }
        Node::Quote(nodes) | Node::Footnote { nodes, .. } => {
            for n in nodes {
                node_displays(n, out);
            }
        }
        Node::Table(t) => {
            for c in t.head.iter().chain(t.rows.iter().flatten()) {
                pieces_displays(c, out);
            }
        }
    }
}

// Margins ----------------------------------------------------------------------------------------

/// A node's CSS (margin-top, margin-bottom).
fn margins(n: &Node, profile: s::Profile) -> (f32, f32) {
    match n {
        Node::Center(n) => margins(n, profile),
        Node::Heading { level, .. } => (profile.heading(*level).2, profile.block_margin()),
        Node::Rule => (s::HR_MARGIN, s::HR_MARGIN),
        _ => (profile.block_margin(), profile.block_margin()),
    }
}

/// A row's (margin-top, margin-bottom), as a block in the body.
pub fn row_margins(row: &Row, prev: Option<&Row>) -> (f32, f32) {
    row_margins_with_profile(row, prev, s::Profile::Preview)
}

fn row_margins_with_profile(row: &Row, prev: Option<&Row>, profile: s::Profile) -> (f32, f32) {
    match &row.kind {
        RowKind::Node(n) => margins(n, profile),
        RowKind::Item { list, item } => {
            let top = if list.index == 0 {
                profile.block_margin()
            } else if item.task.is_some()
                && matches!(prev.map(|p| &p.kind), Some(RowKind::Item { item: pi, .. }) if pi.task.is_some())
            {
                s::TASK_GAP
            } else {
                0.
            };
            let bottom = if list.index + 1 == list.count {
                profile.block_margin()
            } else {
                0.
            };
            (top, bottom)
        }
    }
}

/// The gap above each row (collapsed margins: the larger of the neighbours'), and the bottom
/// margin after the last.
pub fn gaps(rows: &[Row]) -> (Vec<f32>, f32) {
    gaps_with_profile(rows, s::Profile::Preview)
}

/// Collapsed block gaps for a specific native detail or preview surface.
pub fn gaps_with_profile(rows: &[Row], profile: s::Profile) -> (Vec<f32>, f32) {
    let mut out = Vec::with_capacity(rows.len());
    let mut prev_bottom = 0f32;
    let mut prev: Option<&Row> = None;
    for r in rows {
        let (top, bottom) = match profile {
            s::Profile::Preview => row_margins(r, prev),
            s::Profile::AbeDetail => row_margins_with_profile(r, prev, profile),
        };
        out.push(top.max(prev_bottom));
        prev_bottom = bottom;
        prev = Some(r);
    }
    (out, prev_bottom)
}

// Rows -------------------------------------------------------------------------------------------

/// Row `cx.row`: its gap on top, its block, and `bottom` px below (the last row's margin).
pub fn row(row: &Row, gap: f32, bottom: f32, cx: &mut RowCx) -> AnyElement {
    let body = match &row.kind {
        RowKind::Node(n) => node(n, 0, cx),
        RowKind::Item { list, item } => list_item(
            list.start.map(|n| n + list.index as u64),
            item,
            0,
            false,
            cx,
        ),
    };
    div()
        .w_full()
        .pt(px(gap))
        .pb(px(bottom))
        .px(px(cx.profile.margin_x()))
        .child(body)
        .into_any_element()
}

/// Nested blocks (quote / list item / footnote content): margins collapse between them, none
/// at the container's edges (`blockquote > :first-child`, `li > p`).
fn nodes(ns: &[Node], depth: usize, in_item: bool, cx: &mut RowCx) -> AnyElement {
    let mut col = div().flex().flex_col();
    let mut prev_bottom = 0f32;
    for (i, n) in ns.iter().enumerate() {
        let (mut top, mut bottom) = margins(n, cx.profile);
        // li > p and nested lists: no margins
        if in_item && matches!(n, Node::Para(_) | Node::List(_)) {
            top = 0.;
            bottom = 0.;
        }
        let gap = if i == 0 { 0. } else { top.max(prev_bottom) };
        col = col.child(div().pt(px(gap)).child(node(n, depth, cx)));
        prev_bottom = bottom;
    }
    col.into_any_element()
}

fn node(n: &Node, depth: usize, cx: &mut RowCx) -> AnyElement {
    match n {
        Node::Para(pieces) => para(pieces, cx),
        // align="center": the text centred, images in the middle
        Node::Center(n) => div()
            .flex()
            .flex_col()
            .items_center()
            .text_center()
            .child(node(n, depth, cx))
            .into_any_element(),
        Node::Heading { level, pieces, .. } => heading(*level, pieces, cx),
        Node::Code { lang, text } => code_block(lang, text, cx),
        Node::Rule => div().h(px(1.)).w_full().bg(s::SEPARATOR).into_any_element(),
        Node::List(l) => {
            let mut col = div().flex().flex_col();
            let mut prev_task = false;
            for (i, item) in l.items.iter().enumerate() {
                let gap = if i > 0 && prev_task && item.task.is_some() {
                    s::TASK_GAP
                } else {
                    0.
                };
                prev_task = item.task.is_some();
                col = col.child(div().pt(px(gap)).child(list_item(
                    l.start.map(|n| n + i as u64),
                    item,
                    depth + 1,
                    true,
                    cx,
                )));
            }
            col.into_any_element()
        }
        Node::Quote(ns) => {
            let (t, r, b, l) = s::QUOTE_PAD;
            div()
                .bg(s::CODE_BG)
                .border_l(px(s::QUOTE_BORDER))
                .border_color(s::QUOTE_BORDER_COLOR)
                .rounded_tr(px(s::RADIUS))
                .rounded_br(px(s::RADIUS))
                .pt(px(t))
                .pr(px(r))
                .pb(px(b))
                .pl(px(l))
                .child(nodes(ns, depth, false, cx))
                .into_any_element()
        }
        Node::Table(t) => table(t, cx),
        Node::Footnote { label, nodes: ns } => div()
            .flex()
            .child(
                div()
                    .flex_none()
                    .w(px(s::LIST_INDENT))
                    .text_color(s::H6_FG)
                    .child(format!("{label}.")),
            )
            .child(div().flex_1().min_w_0().child(nodes(ns, depth, false, cx)))
            .into_any_element(),
    }
}

/// A list item: its marker in the 2em indent, its blocks right of it. `depth` 0 = top level;
/// `number`: ordered. A task item's checkbox sits inline at its text start (`margin-left:
/// -0.6em`, `margin-right: 0.35em`), so its text starts that much further right.
fn list_item(
    number: Option<u64>,
    item: &Item,
    depth: usize,
    _nested: bool,
    cx: &mut RowCx,
) -> AnyElement {
    let (marker, indent) = match (item.task, number) {
        (Some(done), _) => (
            checkbox(done),
            s::LIST_INDENT + s::CHECKBOX_MARGIN_LEFT + s::CHECKBOX_SIZE + s::CHECKBOX_MARGIN_RIGHT,
        ),
        (None, Some(n)) => (ordered_marker(n, depth), s::LIST_INDENT),
        (None, None) => (bullet(depth), s::LIST_INDENT),
    };
    div()
        .flex()
        .child(
            div()
                .flex_none()
                .w(px(indent))
                .h(px(s::BODY_SIZE * s::BODY_LINE))
                .relative()
                .child(marker),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(nodes(&item.nodes, depth, true, cx)),
        )
        .into_any_element()
}

/// Chromium's list markers: disc, circle, square by nesting (`list-style: outside`), right of
/// the marker box ending one space before the text.
fn bullet(depth: usize) -> AnyElement {
    // marker box: Chromium sizes the disc by the font (~0.33em), centred on the x-height
    let d = 5.0;
    let line = s::BODY_SIZE * s::BODY_LINE;
    let dot = div()
        .absolute()
        .size(px(d))
        .right(px(8.3))
        .top(px((line - d) / 2. + 0.6));
    match depth {
        0 => dot.rounded_full().bg(s::FG),
        1 => dot.rounded_full().border_1().border_color(s::FG),
        _ => dot.bg(s::FG),
    }
    .into_any_element()
}

/// Decimal at the top level; `ol ol` lower-roman, deeper lower-alpha (WS's default.css).
fn ordered_marker(n: u64, depth: usize) -> AnyElement {
    let label = match depth {
        0 => n.to_string(),
        1 => roman(n),
        _ => alpha(n),
    };
    div()
        .absolute()
        .right(px(3.6))
        .top_0()
        .whitespace_nowrap()
        .child(format!("{label}."))
        .into_any_element()
}

fn roman(mut n: u64) -> String {
    const T: [(u64, &str); 13] = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut s = String::new();
    for (v, r) in T {
        while n >= v {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

fn alpha(n: u64) -> String {
    let mut n = n.max(1);
    let mut s = Vec::new();
    while n > 0 {
        n -= 1;
        s.push((b'a' + (n % 26) as u8) as char);
        n /= 26;
    }
    s.iter().rev().collect()
}

/// Chromium's disabled checkbox (WS's GFM task items; measured on the reference render: a
/// #9F9F9F box, 2.5 px corners, a #D8D8D8 check).
fn checkbox(done: bool) -> AnyElement {
    let line = s::BODY_SIZE * s::BODY_LINE;
    let size = s::CHECKBOX_SIZE;
    let b = div()
        .absolute()
        .left(px(s::LIST_INDENT + s::CHECKBOX_MARGIN_LEFT))
        .top(px((line - size) / 2. + s::CHECKBOX_DROP))
        .size(px(size))
        .rounded(px(2.5))
        .bg(s::CHECKBOX_BG);
    if !done {
        return b
            .bg(s::CHECKBOX_OPEN_BG)
            .border_1()
            .border_color(s::CHECKBOX_BG)
            .into_any_element();
    }
    b.child(
        gpui_kit::canvas(
            |_, _, _| {},
            |bounds, _, window, _| {
                let o = bounds.origin;
                let mut p = gpui_kit::PathBuilder::stroke(px(1.75));
                p.move_to(o + gpui_kit::point(px(2.4), px(6.6)));
                p.line_to(o + gpui_kit::point(px(5.2), px(9.6)));
                p.line_to(o + gpui_kit::point(px(10.0), px(2.6)));
                if let Ok(path) = p.build() {
                    window.paint_path(path, s::CHECKBOX_MARK);
                }
            },
        )
        .size_full(),
    )
    .into_any_element()
}

/// Inline content: texts as blocks, runs of images side by side (badge lines, icons), wrapping.
fn pieces_el(pieces: &[Piece], cx: &mut RowCx) -> AnyElement {
    let mut col = div().flex().flex_col();
    let mut i = 0;
    while i < pieces.len() {
        match &pieces[i] {
            Piece::Text(t) => {
                let d = cx
                    .cache
                    .display(t as *const Text as usize, || Display::of(t));
                col = col.child(text(d, cx, None));
                i += 1;
            }
            Piece::Image(_) => {
                let mut run = div().flex().flex_wrap().items_end().gap(px(4.));
                while let Some(Piece::Image(im)) = pieces.get(i) {
                    run = run.child(image(im, cx));
                    i += 1;
                }
                col = col.child(run);
            }
        }
    }
    col.into_any_element()
}

fn para(pieces: &[Piece], cx: &mut RowCx) -> AnyElement {
    let line = px(s::BODY_SIZE * s::BODY_LINE);
    div()
        .line_height(line)
        .child(pieces_el(pieces, cx))
        .into_any_element()
}

fn heading(level: u8, pieces: &[Piece], cx: &mut RowCx) -> AnyElement {
    let (size, lh, _, pad_top) = cx.profile.heading(level);
    div()
        .pt(px(pad_top))
        .text_size(px(size))
        .line_height(relative(lh))
        .font_weight(FontWeight::BOLD)
        .when_h6(level)
        .child(pieces_el(pieces, cx))
        .into_any_element()
}

trait H6 {
    fn when_h6(self, level: u8) -> Self;
}

impl H6 for gpui_kit::Div {
    fn when_h6(self, level: u8) -> Self {
        if level == 6 {
            self.text_color(s::H6_FG)
        } else {
            self
        }
    }
}

fn code_block(lang: &str, code: &str, cx: &mut RowCx) -> AnyElement {
    let colors = cx.colors.get(lang, code).cloned();
    let display = cx.cache.display(code.as_ptr() as usize, || Display {
        text: code.to_owned(),
        spans: Vec::new(),
    });
    let id = cx.element_id("pre");
    let wrap = cx.wrap_code;
    let group = SharedString::from(format!("{}-{}-{}-fence", cx.id, cx.row, cx.next));
    let el = text(display, cx, colors.as_deref().map(Vec::as_slice));
    // WS copy-button.css: a copy icon at the fence's top-left while it's hovered
    let copied = code.to_owned();
    let copy = div()
        .absolute()
        .top(px(s::COPY_INSET))
        .left(px(s::COPY_INSET))
        .invisible()
        .group_hover(group.clone(), |st| st.visible())
        // its press is its own: the text under it starts no selection, a part around it no click
        .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
            cx.stop_propagation()
        })
        .child(
            crate::kit::IconButton::new("md-copy", crate::kit::IconName::Copy)
                .tooltip("Copy to clipboard", None)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(copied.clone()));
                }),
        );
    div()
        .relative()
        .group(group)
        .bg(s::CODE_BG)
        .rounded(px(s::RADIUS))
        .child(
            div()
                .id(id)
                .debug_selector(|| "md-fence".into())
                .when(!wrap, |d| {
                    d.overflow_x_scroll()
                        .restrict_scroll_to_axis()
                        .whitespace_nowrap()
                })
                // wrapped: every word in view, a long line goes on under itself
                .when(wrap, |d| d.min_w_0().whitespace_normal())
                .p(px(s::PRE_PAD))
                .font_family(s::CODE_FONT)
                .font_features(crate::render::editor_features())
                .text_size(px(s::PRE_SIZE))
                .line_height(px((s::PRE_SIZE * s::PRE_LINE).round()))
                .child(el),
        )
        .child(copy)
        .into_any_element()
}

fn table(t: &Table, cx: &mut RowCx) -> AnyElement {
    let cols = t
        .aligns
        .len()
        .max(t.head.len())
        .max(t.rows.iter().map(Vec::len).max().unwrap_or(0));
    let all: Vec<(bool, &Vec<Cell>)> = std::iter::once((true, &t.head))
        .chain(t.rows.iter().map(|r| (false, r)))
        .collect();
    let key = (t as *const Table as usize, cx.avail.to_bits());
    let cached = cx.cache.widths.borrow().get(&key).cloned();
    let widths = cached.unwrap_or_else(|| {
        let w = Rc::new(column_widths(&all, cols, cx));
        cx.cache.widths.borrow_mut().insert(key, w.clone());
        w
    });
    // collapsed 1 px borders: the grid's left / top, each cell's right / bottom
    let mut grid = div()
        .debug_selector(|| "md-table".into())
        .flex()
        .flex_col()
        .flex_none()
        .border_l_1()
        .border_t_1()
        .border_color(s::SEPARATOR);
    for (i, (head, cells)) in all.into_iter().enumerate() {
        let _ = i;
        let mut r = div().flex().flex_none();
        for (c, w) in widths.iter().enumerate() {
            let align = t.aligns.get(c).copied().unwrap_or(Align::None);
            let cell = match cells.get(c) {
                Some(pieces) => pieces_el(pieces, cx),
                None => div().into_any_element(),
            };
            let mut d = div()
                .debug_selector(move || format!("md-table-cell-{c}"))
                .flex()
                .flex_col()
                .flex_none()
                .w(px(*w))
                .px(px(s::CELL_PAD_X))
                .py(px(s::CELL_PAD_Y))
                .border_r_1()
                .border_b_1()
                .border_color(s::SEPARATOR)
                .line_height(px(s::BODY_SIZE * s::BODY_LINE))
                .child(cell);
            d = match align {
                Align::Center => d.items_center(),
                Align::Right => d.items_end(),
                _ => d,
            };
            if head {
                d = d.font_weight(FontWeight::BOLD);
            }
            r = r.child(d);
        }
        grid = grid.child(r);
    }
    // (columns are shrunk to fit the body: no horizontal scrolling needed)
    div().flex().child(grid).into_any_element()
}

/// Column widths (cell box, padding + border included): the widest cell as one line; too wide
/// for the body: shrunk towards each column's widest word (the text wraps), like a CSS auto table;
/// too wide even then: the widest columns cut to one level, their words broken ([`fit_level`]).
fn column_widths(all: &[(bool, &Vec<Cell>)], cols: usize, cx: &RowCx) -> Vec<f32> {
    let chrome = 2. * s::CELL_PAD_X + 1.;
    // (the grid's 1 px left border beside the columns)
    let avail = cx.avail - 1.;
    let mut natural = vec![0f32; cols];
    let mut min = vec![0f32; cols];
    for (head, cells) in all {
        for (c, pieces) in cells.iter().enumerate().take(cols) {
            // texts stack (their widest), image runs side by side
            let (mut widest, mut run) = (0f32, 0f32);
            for p in pieces {
                match p {
                    Piece::Text(t) => {
                        let d = Display::of(t);
                        widest = widest.max((cx.measure)(&d, *head).ceil() + 1.);
                        run = 0.;
                        for w in d.text.split_whitespace() {
                            let word = Display {
                                text: w.to_owned(),
                                spans: Vec::new(),
                            };
                            min[c] = min[c].max((cx.measure)(&word, *head).ceil());
                        }
                    }
                    Piece::Image(im) => {
                        let (w, _) = image_size(im, cx).unwrap_or((0., 0.));
                        run += w + if run > 0. { 4. } else { 0. };
                        widest = widest.max(run);
                        min[c] = min[c].max(w);
                    }
                }
            }
            natural[c] = natural[c].max(widest);
        }
    }
    let total: f32 = natural.iter().map(|w| w + chrome).sum();
    if total <= avail || avail <= 0. {
        return natural.iter().map(|w| w + chrome).collect();
    }
    // share the room left over the minimums by each column's extra width
    let base: f32 = min.iter().map(|w| w + chrome).sum();
    if base > avail {
        // even the widest words don't fit (paths, branch names): the widest columns are cut
        // down to one level that fits the body, their words break, nothing is cut off at the edge
        // (a column keeps its padding and a little text however narrow the body)
        let mins: Vec<f32> = min.iter().map(|w| w + chrome).collect();
        return fit_level(&mins, avail)
            .into_iter()
            .zip(&mins)
            .map(|(w, m)| w.max(m.min(chrome + 16.)))
            .collect();
    }
    let extra: f32 = natural.iter().zip(&min).map(|(n, m)| n - m).sum();
    let room = (avail - base).max(0.);
    natural
        .iter()
        .zip(&min)
        .map(|(n, m)| {
            let share = if extra > 0. {
                (n - m) / extra * room
            } else {
                0.
            };
            m + chrome + share.min(n - m)
        })
        .collect()
}

/// Widths no wider than `level`, the level where they add up to `avail`: the narrow columns
/// keep their width, the wide ones share what is left equally.
fn fit_level(widths: &[f32], avail: f32) -> Vec<f32> {
    let mut sorted = widths.to_vec();
    sorted.sort_by(f32::total_cmp);
    let (mut narrow, mut level) = (0f32, avail / widths.len().max(1) as f32);
    for (i, w) in sorted.iter().enumerate() {
        let wide = (sorted.len() - i) as f32;
        let at = (avail - narrow) / wide;
        if *w > at {
            level = at;
            break;
        }
        narrow += w;
        level = *w;
    }
    widths.iter().map(|w| w.min(level)).collect()
}

/// An image's drawn size: `<img width height>` (the other side by the file's ratio), else the
/// file's pixel size; at most the body's width (`max-width: 100%`).
fn image_size(im: &Image, cx: &RowCx) -> Option<(f32, f32)> {
    let file = cx.imgs.sizes.get(&im.src).copied();
    let (w, h) = match (im.width, im.height, file) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((fw, fh))) => (w, if fw > 0. { w * fh / fw } else { fh }),
        (None, Some(h), Some((fw, fh))) => (if fh > 0. { h * fw / fh } else { fw }, h),
        (_, _, Some(size)) => size,
        _ => return None,
    };
    let scale = if cx.avail > 0. && w > cx.avail {
        cx.avail / w
    } else {
        1.
    };
    Some((w * scale, h * scale))
}

/// An image at its size ([`image_size`]); remote / unreadable ones show their alt text. A linked
/// image (README badges) opens its link on a click.
fn image(im: &Image, cx: &mut RowCx) -> AnyElement {
    let alt: SharedString = im.alt.clone().into();
    let path = cx.imgs.path(&im.src, cx.dir);
    let el = match (path, image_size(im, cx)) {
        (Some(path), Some((w, h))) => {
            let fallback_alt = alt.clone();
            img(path)
                .debug_selector(|| "md-image".into())
                .w(px(w))
                .h(px(h))
                .flex_none()
                .with_fallback(move || {
                    div()
                        .text_color(s::H6_FG)
                        .child(fallback_alt.clone())
                        .into_any_element()
                })
                .into_any_element()
        }
        _ => div()
            .text_color(if im.link.is_some() { s::LINK } else { s::H6_FG })
            .child(alt)
            .into_any_element(),
    };
    let Some(link) = im.link.clone() else {
        return el;
    };
    let on_link = cx.on_link.clone();
    let id = cx.image_id();
    let selector = format!("md-badge-{link}");
    div()
        .id(id)
        .debug_selector(move || selector.clone())
        .flex_none()
        .cursor(gpui_kit::CursorStyle::PointingHand)
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            on_link(link.clone(), window, cx)
        })
        .child(el)
        .into_any_element()
}

/// A text: its spans + the selection as highlights, inline code in the editor font on its tint,
/// links in the link colour (underlined while hovered). `code`: a code block's syntax colours.
fn text((d, shared): Shown, cx: &mut RowCx, code: Option<&[(Range<usize>, u32)]>) -> AnyElement {
    let k = cx.next;
    cx.next += 1;
    let sel = cx.selected(k, d.text.len());
    let hover = cx
        .hover
        .as_ref()
        .filter(|(t, _)| *t == k)
        .map(|(_, r)| r.clone());
    let mut cuts = vec![0, d.text.len()];
    for (r, st) in &d.spans {
        cuts.extend([r.start, r.end]);
        if st.code {
            // the code itself, inside its pads
            cuts.extend([
                r.start + PAD.len_utf8(),
                r.end.saturating_sub(PAD.len_utf8()),
            ]);
        }
    }
    for (r, _) in code.unwrap_or(&[]) {
        cuts.extend([r.start, r.end]);
    }
    if let Some(r) = &sel {
        cuts.extend([r.start, r.end]);
    }
    let found = cx
        .marks
        .map(|m| m(&d.text, Some((cx.row, k))))
        .unwrap_or_default();
    for (r, _) in &found {
        cuts.extend([r.start, r.end]);
    }
    cuts.retain(|c| *c <= d.text.len() && d.text.is_char_boundary(*c));
    cuts.sort_unstable();
    cuts.dedup();
    let mut highlights = Vec::new();
    let mut fonts = Vec::new();
    for w in cuts.windows(2) {
        let r = w[0]..w[1];
        let mut h = HighlightStyle::default();
        if let Some((sr, st)) = d
            .spans
            .iter()
            .find(|(sr, _)| sr.start <= r.start && r.end <= sr.end)
        {
            if st.bold {
                h.font_weight = Some(FontWeight::BOLD);
            }
            if st.italic {
                h.font_style = Some(FontStyle::Italic);
            }
            if st.strike {
                h.strikethrough = Some(StrikethroughStyle {
                    thickness: px(1.),
                    color: None,
                });
            }
            if st.ins {
                h.background_color = Some(hsla(s::INS_BG.rgba()));
            }
            if st.code {
                h.background_color = Some(hsla(s::CODE_BG.rgba()));
                // (the pads stay in the body font: thin)
                let inner = sr.start + PAD.len_utf8()..sr.end - PAD.len_utf8();
                if inner.start <= r.start && r.end <= inner.end {
                    fonts.push((r.clone(), SharedString::from(s::INLINE_CODE_FONT)));
                }
            }
            if st.link.is_some() {
                h.color = Some(hsla(s::LINK.rgba()));
                if hover
                    .as_ref()
                    .is_some_and(|hr| hr.start <= r.start && r.end <= hr.end)
                {
                    h.underline = Some(UnderlineStyle {
                        thickness: px(1.),
                        color: None,
                        wavy: false,
                    });
                }
            }
        }
        if let Some((_, fg)) = code
            .unwrap_or(&[])
            .iter()
            .find(|(cr, _)| cr.start <= r.start && r.end <= cr.end)
        {
            h.color = Some(hsla(crate::look::hex(*fg)));
        }
        if let Some((_, current)) = found
            .iter()
            .find(|(fr, _)| fr.start <= r.start && r.end <= fr.end)
        {
            mark_found(&mut h, *current);
        }
        if sel
            .as_ref()
            .is_some_and(|s| s.start <= r.start && r.end <= s.end)
        {
            h.background_color = Some(hsla(s::SELECTION_BG.rgba()));
        }
        if h != HighlightStyle::default() {
            highlights.push((r, h));
        }
    }
    let styled = StyledText::new(shared)
        .with_highlights(highlights)
        .with_font_family_overrides(fonts);
    let layout = styled.layout().clone();
    // <kbd>: the tinted box gets a 1 px border (painted after the text, per line)
    let kbd: Vec<Range<usize>> = d
        .spans
        .iter()
        .filter(|(_, st)| st.kbd)
        .map(|(r, _)| r.clone())
        .collect();
    Tracked {
        inner: styled.into_any_element(),
        kbd: (!kbd.is_empty()).then(|| (layout.clone(), kbd)),
        key: (cx.row, k),
        drawn: Some(Drawn {
            layout,
            display: d,
            clip: None,
            seq: 0,
        }),
        registry: cx.registry.clone(),
    }
    .into_any_element()
}

/// A find match's look: the current one as selected, the others the speed search's.
pub fn mark_found(h: &mut HighlightStyle, current: bool) {
    if current {
        h.background_color = Some(hsla(s::SELECTION_BG.rgba()));
    } else {
        h.background_color = Some(hsla(crate::look::SEARCH_MATCH_BG.rgba()));
        h.color = Some(hsla(crate::look::SEARCH_MATCH_FG.rgba()));
    }
}

/// Registers a text's layout once it's prepainted (only then can it be hit-tested).
struct Tracked {
    inner: AnyElement,
    /// `<kbd>` spans to outline (display ranges) and the layout to find them in.
    kbd: Option<(TextLayout, Vec<Range<usize>>)>,
    key: (usize, usize),
    drawn: Option<Drawn>,
    registry: Registry,
}

impl IntoElement for Tracked {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for Tracked {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.inner.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner.prepaint(window, cx);
        if let Some(mut d) = self.drawn.take() {
            d.clip = Some(window.content_mask().bounds);
            d.seq = PREPAINTED.with(|n| {
                n.set(n.get() + 1);
                n.get()
            });
            self.registry.borrow_mut().insert(self.key, d);
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner.paint(window, cx);
        if let Some((layout, spans)) = &self.kbd {
            for r in spans {
                for b in kbd_boxes(layout, r.clone()) {
                    window.paint_quad(
                        gpui_kit::outline(
                            b,
                            hsla(s::KBD_BORDER.rgba()),
                            gpui_kit::BorderStyle::Solid,
                        )
                        .corner_radii(px(s::RADIUS)),
                    );
                }
            }
        }
    }
}

/// A `<kbd>` span's boxes, one per line it wraps over.
fn kbd_boxes(layout: &TextLayout, r: Range<usize>) -> Vec<Bounds<Pixels>> {
    let (Some(a), Some(b)) = (
        layout.position_for_index(r.start),
        layout.position_for_index(r.end),
    ) else {
        return Vec::new();
    };
    let lh = layout.line_height();
    let all = layout.bounds();
    let line = |y: Pixels, x0: Pixels, x1: Pixels| {
        Bounds::from_corners(gpui_kit::point(x0, y), gpui_kit::point(x1, y + lh))
    };
    if a.y == b.y {
        return vec![line(a.y, a.x, b.x)];
    }
    let mut out = vec![line(a.y, a.x, all.right())];
    let mut y = a.y + lh;
    while y < b.y {
        out.push(line(y, all.left(), all.right()));
        y += lh;
    }
    out.push(line(b.y, all.left(), b.x));
    out.retain(|b| b.size.width > px(0.));
    out
}

/// A wrapper running `before` ahead of its child's prepaint (the preview's scroll sync reads the
/// editor's drawn grid there: the same frame) and `after` once it's done.
pub struct Hooked {
    pub inner: AnyElement,
    #[allow(
        clippy::type_complexity,
        reason = "used once; an alias would only rename it"
    )]
    pub before: Option<Box<dyn FnOnce(Bounds<Pixels>, &mut Window, &mut App)>>,
}

impl IntoElement for Hooked {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl Element for Hooked {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.inner.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(f) = self.before.take() {
            f(bounds, window, cx);
        }
        self.inner.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.inner.paint(window, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::markdown::doc;

    /// Too wide even at their widest words, the narrow columns keep their width and the
    /// wide ones share the rest at one level.
    #[test]
    fn overwide_columns_are_cut_to_one_level() {
        assert_eq!(fit_level(&[30., 300., 500.], 400.), vec![30., 185., 185.]);
        assert_eq!(fit_level(&[30., 40., 500.], 400.), vec![30., 40., 330.]);
        assert_eq!(fit_level(&[300., 300.], 400.), vec![200., 200.]);
    }

    #[test]
    fn inline_code_is_padded_and_copied_without_pads() {
        let rows = doc::parse("a `b` c");
        let ds = row_displays(&rows[0]);
        assert_eq!(ds[0].text, format!("a {PAD}{PAD}b{PAD}{PAD} c"));
        assert_eq!(copy_text(&ds[0].text), "a b c");
        let (r, st) = &ds[0].spans[0];
        assert!(st.code);
        assert_eq!(&ds[0].text[r.clone()], format!("{PAD}b{PAD}"));
    }

    #[test]
    fn collapsed_margins() {
        let rows = doc::parse("# T\n\npara\n\n- a\n- b\n\n---\n");
        let (g, bottom) = gaps(&rows);
        // h1: its own margin-top; p after h1: 16; first item: 16; second: 0; hr: 20
        assert_eq!(g, vec![28.6, 16., 16., 0., 20.]);
        assert_eq!(bottom, 20.);
        let rows = doc::parse("- [ ] a\n- [x] b\n");
        assert_eq!(gaps(&rows).0, vec![16., 3.]);
    }

    #[test]
    fn list_markers() {
        assert_eq!(roman(4), "iv");
        assert_eq!(roman(9), "ix");
        assert_eq!(alpha(1), "a");
        assert_eq!(alpha(27), "aa");
    }
}
