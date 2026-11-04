//! A story's text drawn in VimStorm's markdown renderer with the scoped native detail profile
//! (`style::Profile::AbeDetail`): its rows, values and images; remote images fetched into its
//! cache; code coloured by the shown project's nvim, as the preview's. The card dialog
//! ([`super::dialog`]) and the rendered Chat's prose ([`super::transcript`]) draw with it, with
//! the dialog's section heading and ruled section.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, Div, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    ScrollHandle, SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::editor::markdown::{
    self, Colors, Display, Images, OnLink, Pos, Registry, RenderCache, Row, RowCx,
    measure_display_with_font,
};
use crate::look;

/// A part of a story: markdown, or a field with nothing in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoryPart {
    Markdown(String),
    Empty,
}

/// A markdown text parsed once: its rows, the gaps between them, its images.
#[derive(Clone)]
struct Doc {
    rows: Vec<Row>,
    gaps: Vec<f32>,
    bottom: f32,
    images: Images,
}

/// A text parsed, and whether it was drawn since the last [`CardDraw::sweep`].
type Parsed = (Rc<Doc>, Cell<bool>);

/// What the card dialog or the Chat's prose keeps between frames: its scroll, the markdown it
/// parsed, the texts laid out.
#[derive(Default)]
pub struct CardDraw {
    pub scroll: ScrollHandle,
    /// The texts parsed, by text, and whether one was drawn since the last [`CardDraw::sweep`].
    docs: RefCell<HashMap<String, Parsed>>,
    cache: Rc<RenderCache>,
    registry: Registry,
    /// Code colours the shown project's markdown preview gave ([`CardDraw::take_colors`]).
    colors: RefCell<Colors>,
    /// Fenced code wraps its long lines ([`CardDraw::wrapping_code`]).
    wrap_code: bool,
}

/// Images a frame found that the cache doesn't have yet.
pub type ToFetch = Vec<String>;

impl CardDraw {
    pub fn new() -> CardDraw {
        CardDraw::default()
    }

    /// One whose fenced code wraps its long lines instead of scrolling sideways: the rendered
    /// Chat's column is too narrow for an agent's tables.
    pub fn wrapping_code() -> CardDraw {
        CardDraw {
            wrap_code: true,
            ..CardDraw::default()
        }
    }

    /// `text` parsed (once per text); remote images it has that want fetching go in `fetch`.
    fn doc(&self, text: &str, fetch: &mut ToFetch) -> Rc<Doc> {
        if let Some((d, used)) = self.docs.borrow().get(text) {
            used.set(true);
            return d.clone();
        }
        let rows = markdown::parse(text);
        let (mut gaps, bottom) = markdown::gaps_with_profile(&rows, markdown::Profile::AbeDetail);
        if let Some(first) = gaps.first_mut() {
            *first = 0.;
        }
        let images = markdown::images(&rows, Path::new("/"));
        fetch.extend(markdown::to_fetch(&rows));
        let d = Rc::new(Doc {
            rows,
            gaps,
            bottom,
            images,
        });
        self.docs
            .borrow_mut()
            .insert(text.to_owned(), (d.clone(), Cell::new(true)));
        d
    }

    /// `text`, if parsed, stays at the next sweep (drawn or not: a transcript's row standing
    /// in for its part).
    pub fn keep(&self, text: &str) {
        if let Some((_, used)) = self.docs.borrow().get(text) {
            used.set(true);
        }
    }

    /// The texts not drawn since the last sweep go (a streamed answer's older drafts, a Chat
    /// shown before); the laid-out cache with them (it keys texts by their rows' addresses).
    pub fn sweep(&self) {
        let mut docs = self.docs.borrow_mut();
        let before = docs.len();
        docs.retain(|_, (_, used)| used.replace(false));
        if docs.len() != before {
            self.cache.clear();
        }
    }

    /// A fetched remote image: every text with it lays out again.
    pub fn fetched(&self, url: &str, path: std::path::PathBuf, size: (f32, f32)) {
        let mut docs = self.docs.borrow_mut();
        for (d, _) in docs.values_mut() {
            // (cached now: no longer one `to_fetch` names)
            if markdown::remote(&d.rows).iter().any(|u| u == url) {
                Rc::make_mut(d)
                    .images
                    .insert_fetched(url, path.clone(), size);
            }
        }
        self.cache.clear();
    }

    /// The fences of the texts drawn, `(lang, code)`: what the markdown preview's highlighter
    /// colours.
    pub fn code_blocks(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .docs
            .borrow()
            .values()
            .flat_map(|(d, _)| crate::editor::markdown::code_blocks(&d.rows))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// The colours of `blocks` the preview has (`colors`) taken; whether any is new (a frame
    /// draws them).
    pub fn take_colors(&self, blocks: &[(String, String)], colors: &Colors) -> bool {
        let mut mine = self.colors.borrow_mut();
        let mut new = false;
        for (lang, code) in blocks {
            let Some(spans) = colors.get(lang, code) else {
                continue;
            };
            if mine.get(lang, code).is_none_or(|s| !Rc::ptr_eq(s, spans)) {
                mine.insert((lang.clone(), code.clone()), spans.clone());
                new = true;
            }
        }
        if new {
            self.cache.clear();
        }
        new
    }

    /// Whether the fence `(lang, code)` draws in colours (tests).
    pub fn coloured(&self, lang: &str, code: &str) -> bool {
        self.colors
            .borrow()
            .get(lang, code)
            .is_some_and(|s| !s.is_empty())
    }

    /// How far the page is scrolled down (tests).
    pub fn scrolled(&self) -> f32 {
        -self.scroll.offset().y.as_f32()
    }
}

/// A blank field's `(empty)`.
pub(crate) fn empty() -> AnyElement {
    div()
        .py(px(6.))
        .text_color(look::TEXT_DIM)
        .child("(empty)")
        .into_any_element()
}

/// A text selection a story's markdown takes part in (the rendered Chat's transcript): its texts
/// registered in `registry` under rows `base` on, `sel` (ordered) drawn, each row's texts kept in
/// `rows` for copying.
#[derive(Clone)]
pub(crate) struct Selectable {
    pub registry: Registry,
    pub sel: Option<(Pos, Pos)>,
    pub base: usize,
    pub rows: Rc<RefCell<std::collections::BTreeMap<usize, Vec<Display>>>>,
}

/// Where a story's markdown goes: the elements' prefix (`<prefix>-row-<n>`, counted across the
/// story by `row_no`), the room, the link handler and the images it wants fetched.
pub(crate) struct Markdown<'a> {
    pub prefix: &'static str,
    pub draw: &'a CardDraw,
    pub width: f32,
    pub on_link: &'a OnLink,
    pub fetch: &'a mut ToFetch,
    pub row_no: usize,
    /// The selection its texts take part in; none: the card's own registry, nothing selected.
    pub select: Option<&'a Selectable>,
    /// Find's matches marked in its texts (the transcript's).
    pub marks: Option<markdown::Marks<'a>>,
}

impl Markdown<'_> {
    /// `text`'s rows in the preview's look; `selection` names the text's selection id.
    pub(crate) fn text(&mut self, text: &str, selection: String, window: &mut Window) -> Div {
        let ts = window.text_system().clone();
        let measure = move |d: &Display, bold: bool| -> f32 {
            measure_display_with_font(&ts, d, bold, crate::render::UI_FONT.name())
        };
        let avail = self.width.max(0.);
        let dir = Path::new("/");
        let colors = self.draw.colors.borrow();
        let d = self.draw.doc(text, self.fetch);
        let body = div()
            .font(gpui_kit::font(crate::render::UI_FONT))
            .text_size(px(markdown::BODY_SIZE))
            .line_height(px(markdown::BODY_SIZE * markdown::BODY_LINE))
            .text_color(markdown::FG);
        let mut body = body.flex().flex_col();
        let selection = SharedString::from(selection);
        for (i, r) in d.rows.iter().enumerate() {
            let (row, sel, registry) = match self.select {
                Some(s) => {
                    s.rows
                        .borrow_mut()
                        .insert(s.base + i, markdown::row_displays(r));
                    (s.base + i, s.sel, &s.registry)
                }
                None => (i, None, &self.draw.registry),
            };
            let mut rcx = RowCx::new(
                row,
                sel,
                &colors,
                registry,
                dir,
                None,
                selection.clone(),
                &measure,
                avail,
                &d.images,
                &self.draw.cache,
                self.on_link.clone(),
            );
            rcx.profile = markdown::Profile::AbeDetail;
            rcx.wrap_code = self.draw.wrap_code;
            rcx.marks = self.marks;
            let gap = d.gaps.get(i).copied().unwrap_or(0.);
            let bottom = if i + 1 == d.rows.len() { d.bottom } else { 0. };
            let selector = format!("{}-row-{}", self.prefix, self.row_no);
            self.row_no += 1;
            body = body.child(
                div()
                    .debug_selector(move || selector.clone())
                    .child(markdown::row(r, gap, bottom, &mut rcx)),
            );
        }
        body
    }
}

/// A story's parts in a column (`<prefix>-story`); `key` names the texts' selection ids.
#[allow(
    clippy::too_many_arguments,
    reason = "the one entry of a story's parts, its room and its selection"
)]
pub(crate) fn story(
    parts: &[StoryPart],
    (prefix, key): (&'static str, &str),
    draw: &CardDraw,
    width: f32,
    window: &mut Window,
    on_link: &OnLink,
    fetch: &mut ToFetch,
    select: Option<&Selectable>,
    marks: Option<markdown::Marks>,
) -> AnyElement {
    let mut col = div()
        .debug_selector(move || format!("{prefix}-story"))
        .flex()
        .flex_col()
        .min_w_0();
    let mut md = Markdown {
        prefix,
        draw,
        width,
        on_link,
        fetch,
        row_no: 0,
        select,
        marks,
    };
    for (pi, part) in parts.iter().enumerate() {
        col = col.child(match part {
            StoryPart::Empty => empty(),
            StoryPart::Markdown(text) => md
                .text(text, format!("{prefix}-{key}-0-{pi}"), window)
                .into_any_element(),
        });
    }
    col.into_any_element()
}

/// A section heading in the dialog: the title (600) and its dim note.
pub(crate) fn dialog_heading(title: &str, note: Option<&str>) -> AnyElement {
    div()
        .flex_none()
        .flex()
        .items_baseline()
        .gap(px(8.))
        .mb(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(SharedString::from(title.to_owned())),
        )
        .children(note.map(|n| {
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(n.to_owned()))
        }))
        .into_any_element()
}

/// One ruled section of the reading column: 14 above, 16 below, a separator under it.
pub(crate) fn ruled(el: impl IntoElement, last: bool) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .min_w_0()
        .pt(px(14.))
        .pb(px(16.))
        .when(!last, |d| d.border_b_1().border_color(look::SEPARATOR))
        .child(el)
        .into_any_element()
}
