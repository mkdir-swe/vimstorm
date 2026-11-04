//! The native markdown preview: [`MarkdownView`], ONE full-window layer painting every
//! preview over its window's island. Lua (`config/markdown.lua` + `config/app/markdown.lua`) keeps
//! the modes per file, the preview split and the read-only rule, and gives each preview window
//! role `"markdown"` ([`crate::shell::Role::Markdown`]): the placeholder right of
//! the editor (Editor and Preview), or the file's own split (Preview Only). Their grids aren't
//! drawn; this view paints the rendered markdown over `WinRect::surface_rect` and gets the mouse
//! there. The keyboard stays with nvim: Lua maps a preview's scroll / copy keys to `scroll` /
//! `copy` events.
//!
//! - Text: Lua sends a source buffer's text (coalesced to 40 ms while typing); it's parsed off
//!   the UI thread ([`doc::parse`]) into rows (top-level blocks, top-level list items), and each
//!   pane's GPUI `list` is spliced where rows changed (heights of the rest are kept).
//! - Code blocks: colours asked from Lua (`highlight`: nvim treesitter, the editor's scheme),
//!   cached by (lang, code).
//! - Scroll sync ([`sync`]): by source line, both ways, in the frame the editor's grid moves
//!   (the editor's drawn topline is read in this layer's prepaint, after the editor's).
//! - Mode toolbar (Editor Only / Editor and Preview / Preview Only) at the right end of the
//!   editor's tab row (WS's tab-pane actions), when Lua says the editor is wide enough.
//! - Links: http(s) / mailto open in the browser (`open`), `#anchor` scrolls, other targets open
//!   in the editor (Lua `open_link`). Text selection by mouse, Cmd+C / Cmd+A (Lua keys).
//! - A Layer's workflow file: its preview ([`abe`], Abe's words) is drawn in place of the text.

mod abe;
mod doc;
mod image;
mod render;
mod style;
mod sync;

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, CursorStyle, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ListAlignment, ListOffset, ListState, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render,
    ScrollWheelEvent, SharedString, Styled as _, Task, WeakEntity, Window, div, list, point, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::kit::IconButton;
use crate::kit::IconName;
use crate::look;
use crate::nvim::lua;
use crate::shell::{self, Geometry, WinRect};
use crate::shell::{Surface, SurfaceCx};

pub use doc::{Row, RowKind, parse};
pub(crate) use image::{Images, is_remote, size as image_size, to_fetch};
pub use image::{images, remote, set_cache_dir};
use render::Drawn;
pub use render::{Colors, row};
pub(crate) use render::{
    Display, Marks, OnLink, Pos, Registry, RenderCache, RowCx, copy_text, gaps_with_profile,
    mark_found, row_displays, selectable_styled, selectable_text, selected_in,
};
pub use style::KBD_BORDER;
pub(crate) use style::{BODY_LINE, BODY_SIZE, FG, Profile};
use sync::{Action, RowGeom, SyncState};

/// `vimstorm.markdown` (config/app/markdown.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event {
    State {
        wins: Vec<MdWin>,
    },
    Text {
        buf: i64,
        tick: i64,
        path: String,
        text: String,
    },
    /// A Layer's workflow file's preview (none: the buffer's text is drawn again).
    Abe {
        buf: i64,
        #[serde(default)]
        preview: Option<abe::WorkflowPreview>,
    },
    /// The caret's line of a buffer with a workflow preview: its step is ringed.
    Caret {
        buf: i64,
        line: i64,
    },
    Code {
        id: u64,
        colors: Vec<Vec<(usize, usize, i64, u8)>>,
    },
    Top {
        win: i64,
        top: i64,
    },
    Scroll {
        win: i64,
        by: String,
        n: i64,
    },
    Copy {
        win: i64,
    },
    SelectAll {
        win: i64,
    },
    Focus,
}

/// A markdown editor of the current tab (Lua's state).
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct MdWin {
    /// The file's window.
    pub win: i64,
    pub buf: i64,
    /// "editor" | "split" | "preview".
    pub mode: String,
    /// Editor and Preview: the placeholder window.
    #[serde(default)]
    pub preview: Option<i64>,
    /// The mode toolbar is shown (wide enough).
    #[serde(default)]
    pub bar: bool,
    pub host: i64,
}

impl MdWin {
    /// The window the preview is drawn over.
    pub fn preview_win(&self) -> Option<i64> {
        match self.mode.as_str() {
            "split" => self.preview,
            "preview" => Some(self.win),
            _ => None,
        }
    }
}

/// A source buffer's text and rows.
struct DocState {
    tick: i64,
    dir: PathBuf,
    rows: Rc<Vec<Row>>,
    /// Its images' sizes / cached files.
    images: Rc<image::Images>,
    version: u64,
    _parse: Option<Task<()>>,
}

/// One preview (by its file's window).
struct Pane {
    buf: i64,
    list: ListState,
    /// What the list shows (its doc version).
    rows: Rc<Vec<Row>>,
    gaps: Rc<Vec<f32>>,
    bottom: f32,
    version: u64,
    sync: SyncState,
    /// A Follow whose row wasn't measured yet: applied again next frame.
    follow: Option<f64>,
    registry: Registry,
    sel: Option<(Pos, Pos)>,
    /// Mouse down at (pos, link under it, moved since).
    press: Option<(Point<Pixels>, Option<String>, bool)>,
    /// Dragging the scrollbar: (mouse y, scroll offset) at the press.
    bar_drag: Option<(Pixels, Pixels)>,
    /// The mouse is over the scrollbar's track (the thumb brightens).
    bar_hover: bool,
    /// The link under the mouse: (row, text, display range).
    hover: Option<(usize, usize, Range<usize>)>,
    /// Where the pane is painted (window coordinates).
    bounds: Bounds<Pixels>,
    /// Source line (fractional) at the top, as last laid out.
    top_line: f64,
    /// The width the rows are laid out at, and a new width waiting since (see [`RELAYOUT_QUIET`]).
    laid_out_w: Option<Pixels>,
    new_w: Option<(Pixels, Instant)>,
    /// Displays / table widths reused across frames (cleared when rows or sizes change).
    cache: Rc<render::RenderCache>,
}

/// A long document keeps its rows' width while the pane is resized (divider drag, window
/// resize) and lays them out at the new width once it held this long: a relayout of every row
/// costs ~12 ms on a 2000-line README, too much for each frame of a drag.
const RELAYOUT_QUIET: Duration = Duration::from_millis(120);
/// Documents with more rows than this wait; shorter ones follow every frame.
const RELAYOUT_DEBOUNCE_ROWS: usize = 100;

impl Pane {
    /// The width to lay the rows out at for a pane `w` wide now (see [`RELAYOUT_QUIET`]).
    fn layout_width(&mut self, w: Pixels, now: Instant) -> Pixels {
        let Some(at) = self
            .laid_out_w
            .filter(|_| self.rows.len() > RELAYOUT_DEBOUNCE_ROWS)
        else {
            self.laid_out_w = Some(w);
            self.new_w = None;
            return w;
        };
        if w == at {
            self.new_w = None;
            return at;
        }
        match self.new_w {
            Some((nw, since)) if nw == w && now - since >= RELAYOUT_QUIET => {
                self.laid_out_w = Some(w);
                self.new_w = None;
                w
            }
            Some((nw, _)) if nw == w => at,
            _ => {
                self.new_w = Some((w, now));
                at
            }
        }
    }

    fn new(buf: i64) -> Pane {
        Pane {
            buf,
            // every row measured (rows changed / a new width: only those): exact scrollbar,
            // scroll sync to any line without a frame's delay
            list: ListState::new(0, ListAlignment::Top, px(600.)).measure_all(),
            rows: Rc::default(),
            gaps: Rc::default(),
            bottom: 0.,
            version: u64::MAX,
            sync: SyncState::default(),
            follow: None,
            registry: Registry::default(),
            sel: None,
            press: None,
            bar_drag: None,
            bar_hover: false,
            hover: None,
            bounds: Bounds::default(),
            top_line: 0.,
            laid_out_w: None,
            new_w: None,
            cache: Rc::default(),
        }
    }

    /// Shows `rows`: the changed middle spliced (heights of unchanged rows kept).
    fn set_rows(&mut self, rows: Rc<Vec<Row>>, version: u64) {
        self.cache.clear();
        let first = self.version == u64::MAX;
        let old = self.rows.clone();
        let prefix = old
            .iter()
            .zip(rows.iter())
            .take_while(|(a, b)| a.kind == b.kind)
            .count();
        let max_suffix = old.len().min(rows.len()) - prefix;
        let suffix = old
            .iter()
            .rev()
            .zip(rows.iter().rev())
            .take(max_suffix)
            .take_while(|(a, b)| a.kind == b.kind)
            .count();
        let removed = prefix..old.len() - suffix;
        let added = rows.len() - suffix - prefix;
        let changed = !(removed.is_empty() && added == 0);
        if first {
            self.list.reset(rows.len());
        } else if changed {
            self.list.splice(removed, added);
            // (a splice leaves new rows unmeasured: measure them now for the scrollbar)
            if added > 0 {
                self.list.remeasure_items(prefix..prefix + added);
            }
        }
        let (gaps, bottom) = render::gaps(&rows);
        // a row's gap depends on the row before it: the first unchanged row after the change
        if !first && suffix > 0 {
            let (i, oi) = (prefix + added, old.len() - suffix);
            if self.gaps.get(oi) != gaps.get(i) {
                self.list.remeasure_items(i..i + 1);
            }
        }
        if !first && bottom != self.bottom && !rows.is_empty() {
            let last = rows.len() - 1;
            self.list.remeasure_items(last..last + 1);
        }
        self.gaps = Rc::new(gaps);
        self.bottom = bottom;
        self.rows = rows;
        self.version = version;
        if changed {
            self.sel = None;
            self.hover = None;
        }
    }

    fn lines(&self) -> Vec<Range<usize>> {
        self.rows.iter().map(|r| r.lines.clone()).collect()
    }

    fn geom(&self, ix: usize) -> Option<RowGeom> {
        let h = self.list.bounds_for_item(ix)?.size.height.as_f32();
        Some(RowGeom {
            gap: self.gaps.get(ix).copied().unwrap_or(0.),
            height: h,
        })
    }

    /// The source line at the preview's top (None: its row isn't measured yet).
    fn preview_line(&self) -> Option<f64> {
        if self.rows.is_empty() {
            return Some(0.);
        }
        let top = self.list.logical_scroll_top();
        if top.item_ix >= self.rows.len() {
            // scrolled to the end: the list finds its real top when it lays out
            return None;
        }
        let g = self.geom(top.item_ix)?;
        Some(sync::line_at(
            &self.lines(),
            top.item_ix,
            top.offset_in_item.as_f32(),
            g,
        ))
    }

    /// Scrolls so `line` is at the top; false when its row isn't measured yet (retry).
    fn scroll_to_line(&mut self, line: f64) -> bool {
        if self.rows.is_empty() {
            return true;
        }
        let lines = self.lines();
        let ix = sync::row_for_line(&lines, line);
        self.list.scroll_to(ListOffset {
            item_ix: ix,
            offset_in_item: px(0.),
        });
        let Some(g) = self.geom(ix) else {
            return false;
        };
        let off = sync::offset_in_row(&lines, ix, line, g);
        self.list.scroll_to(ListOffset {
            item_ix: ix,
            offset_in_item: px(off),
        });
        true
    }

    /// The text under `pos` (or nearest to it): selection position + its display.
    fn hit(&self, pos: Point<Pixels>) -> Option<(Pos, Rc<Display>)> {
        hit(&self.registry, pos)
    }

    /// The link exactly under `pos`: (row, text, display range, target).
    fn link_at(&self, pos: Point<Pixels>) -> Option<(usize, usize, Range<usize>, String)> {
        let reg = self.registry.borrow();
        for ((row, text), d) in reg.iter() {
            if !d.layout.bounds().contains(&pos) {
                continue;
            }
            if let Ok(i) = d.layout.index_for_position(pos)
                && let Some((target, r)) = d.display.link_at(i)
            {
                return Some((*row, *text, r, target.to_owned()));
            }
        }
        None
    }

    /// The selected text (pads dropped), texts joined by newlines.
    fn selected_text(&self) -> String {
        let Some((a, b)) = self.sel.map(|(a, b)| if a <= b { (a, b) } else { (b, a) }) else {
            return String::new();
        };
        let mut out: Vec<String> = Vec::new();
        for row in a.row..=b.row.min(self.rows.len().saturating_sub(1)) {
            let ds = render::row_displays(&self.rows[row]);
            for (k, d) in ds.iter().enumerate() {
                let me = (row, k);
                if me < (a.row, a.text) || me > (b.row, b.text) {
                    continue;
                }
                let len = d.text.len();
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
                if s < e && d.text.is_char_boundary(s) && d.text.is_char_boundary(e) {
                    out.push(render::copy_text(&d.text[s..e]));
                }
            }
        }
        out.join("\n")
    }

    fn select_all(&mut self) {
        let Some(last) = self.rows.len().checked_sub(1) else {
            return;
        };
        let ds = render::row_displays(&self.rows[last]);
        let end = Pos {
            row: last,
            text: ds.len().saturating_sub(1),
            byte: ds.last().map_or(0, |d| d.text.len()),
        };
        self.sel = Some((Pos::default(), end));
    }
}

/// A drawn preview (tests).
#[derive(Clone, Debug)]
pub struct PaneInfo {
    /// The file's window.
    pub win: i64,
    /// The window it's drawn over.
    pub preview_win: i64,
    pub bounds: Bounds<Pixels>,
    /// Source line (0-based, fractional) at the top.
    pub top_line: f64,
    pub rows: usize,
    pub selection: Option<String>,
}

pub struct MarkdownView {
    scx: SurfaceCx,
    focus: FocusHandle,
    wins: Vec<MdWin>,
    docs: HashMap<i64, DocState>,
    panes: HashMap<i64, Pane>,
    colors: Colors,
    asked: HashSet<(String, String)>,
    requests: HashMap<u64, Vec<(String, String)>>,
    /// Colours carried over from a fence's previous text, until its own arrive.
    provisional: HashSet<(String, String)>,
    next_request: u64,
    /// Links opened in the browser.
    opened: Vec<String>,
    /// Actually open them (tests turn it off: [`Self::record_links_only`]).
    open_links: bool,
    /// Parse time of the last text (perf report).
    last_parse: Option<Duration>,
    /// Remote images being fetched ([`image::fetch_blocking`]).
    fetching: HashSet<String>,
    /// A Layer's workflow file's preview by its buffer, drawn in place of its text.
    abe: HashMap<i64, Rc<abe::WorkflowPreview>>,
    /// Their caret's line (1-based), by buffer.
    carets: HashMap<i64, i64>,
}

impl Surface for MarkdownView {
    const NAME: &'static str = "markdown";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        MarkdownView {
            scx,
            focus: cx.focus_handle(),
            wins: Vec::new(),
            docs: HashMap::new(),
            panes: HashMap::new(),
            colors: Colors::new(),
            asked: HashSet::new(),
            requests: HashMap::new(),
            provisional: HashSet::new(),
            next_request: 1,
            opened: Vec::new(),
            open_links: true,
            last_parse: None,
            fetching: HashSet::new(),
            abe: HashMap::new(),
            carets: HashMap::new(),
        }
    }

    fn on_lua(&mut self, payload: Value, _w: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<Event>(Self::NAME, payload) else {
            return;
        };
        match ev {
            Event::State { wins } => self.state(wins, cx),
            Event::Text {
                buf,
                tick,
                path,
                text,
            } => self.text(buf, tick, path, text, cx),
            Event::Abe { buf, preview } => {
                let now = preview.map(Rc::new);
                if self.abe.get(&buf) != now.as_ref() {
                    match now {
                        Some(p) => self.abe.insert(buf, p),
                        None => self.abe.remove(&buf),
                    };
                    cx.notify();
                }
            }
            Event::Caret { buf, line } => {
                if self.carets.insert(buf, line) != Some(line) {
                    cx.notify();
                }
            }
            Event::Code { id, colors } => {
                if let Some(keys) = self.requests.remove(&id) {
                    for key in &keys {
                        self.asked.remove(key);
                        self.provisional.remove(key);
                    }
                    for (key, spans) in keys.into_iter().zip(colors) {
                        // WS colours fences by foreground only (no bold / italic)
                        let spans: Vec<(Range<usize>, u32)> = spans
                            .into_iter()
                            .filter_map(|(s, e, fg, _)| Some((s..e, u32::try_from(fg).ok()?)))
                            .collect();
                        self.colors.insert(key, Rc::new(spans));
                    }
                    self.prune_colors();
                    cx.notify();
                }
            }
            Event::Top { win, top } => {
                if let Some(p) = self.panes.get_mut(&win) {
                    p.sync.expect(top - 1);
                }
            }
            Event::Scroll { win, by, n } => self.scroll(win, &by, n, cx),
            Event::Copy { win } => {
                if let Some(src) = self.pane_of(win)
                    && let Some(p) = self.panes.get(&src)
                    && p.sel.is_some_and(|(a, b)| a != b)
                {
                    let text = p.selected_text();
                    self.scx
                        .call("config.app.markdown", "copy", vec![text.into()]);
                }
            }
            Event::SelectAll { win } => {
                if let Some(src) = self.pane_of(win)
                    && let Some(p) = self.panes.get_mut(&src)
                {
                    p.select_all();
                    cx.notify();
                }
            }
            Event::Focus => {}
        }
    }
}

impl MarkdownView {
    /// The pane (by its file's window) for window `win` (the file's or the placeholder).
    fn pane_of(&self, win: i64) -> Option<i64> {
        self.wins
            .iter()
            .find(|w| w.win == win || w.preview == Some(win))
            .map(|w| w.win)
    }

    fn state(&mut self, wins: Vec<MdWin>, cx: &mut Context<Self>) {
        self.wins = wins;
        let keep: HashSet<i64> = self
            .wins
            .iter()
            .filter(|w| w.preview_win().is_some())
            .map(|w| w.win)
            .collect();
        self.panes.retain(|win, _| keep.contains(win));
        for w in &self.wins {
            if w.preview_win().is_none() {
                continue;
            }
            let pane = self.panes.entry(w.win).or_insert_with(|| Pane::new(w.buf));
            if pane.buf != w.buf {
                *pane = Pane::new(w.buf);
            }
            if let Some(d) = self.docs.get(&w.buf)
                && pane.version != d.version
                && d.version > 0
            {
                pane.set_rows(d.rows.clone(), d.version);
            }
        }
        let bufs: HashSet<i64> = self.wins.iter().map(|w| w.buf).collect();
        self.docs.retain(|b, _| bufs.contains(b));
        self.abe.retain(|b, _| bufs.contains(b));
        self.carets.retain(|b, _| bufs.contains(b));
        cx.notify();
    }

    fn text(&mut self, buf: i64, tick: i64, path: String, text: String, cx: &mut Context<Self>) {
        let dir = Path::new(&path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.scx.project.clone());
        let img_dir = dir.clone();
        let task = cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let parsed = cx
                .background_spawn(async move {
                    // a parser bug must never take the app down: the last good rows stay
                    std::panic::catch_unwind(move || {
                        let rows = doc::parse(&text);
                        let images = image::images(&rows, &img_dir);
                        let fetch = image::to_fetch(&rows);
                        (rows, images, fetch)
                    })
                    .ok()
                })
                .await;
            let took = started.elapsed();
            let Some((rows, images, fetch)) = parsed else {
                eprintln!(
                    "[vimstorm] markdown: the parser panicked; the preview keeps its last text"
                );
                return;
            };
            let _ = this.update(cx, |v, cx| {
                v.parsed(buf, tick, rows, images, took, cx);
                v.fetch_images(fetch, cx);
            });
        });
        let d = self.docs.entry(buf).or_insert_with(|| DocState {
            tick: -1,
            dir: dir.clone(),
            rows: Rc::default(),
            images: Rc::default(),
            version: 0,
            _parse: None,
        });
        d.dir = dir;
        d._parse = Some(task);
    }

    fn parsed(
        &mut self,
        buf: i64,
        tick: i64,
        rows: Vec<Row>,
        images: image::Images,
        took: Duration,
        cx: &mut Context<Self>,
    ) {
        self.last_parse = Some(took);
        let Some(d) = self.docs.get_mut(&buf) else {
            return;
        };
        if tick < d.tick {
            return;
        }
        d.tick = tick;
        d.version += 1;
        let old = std::mem::replace(&mut d.rows, Rc::new(rows));
        // a fence being edited keeps its previous colours (clipped) until Lua's new ones arrive
        let (before, now) = (code_blocks(&old), code_blocks(&d.rows));
        for (i, key) in now.iter().enumerate() {
            if self.colors.contains_key(key) {
                continue;
            }
            if let Some(prev) = before.get(i).filter(|k| k.0 == key.0)
                && let Some(c) = self.colors.get(&prev.0, &prev.1).cloned()
            {
                let len = key.1.len();
                let clipped: Vec<(Range<usize>, u32)> = c
                    .iter()
                    .filter(|(r, _)| {
                        r.end <= len
                            && key.1.is_char_boundary(r.start)
                            && key.1.is_char_boundary(r.end)
                    })
                    .cloned()
                    .collect();
                self.colors.insert(key.clone(), Rc::new(clipped));
                self.provisional.insert(key.clone());
            }
        }
        let Some(d) = self.docs.get_mut(&buf) else {
            return;
        };
        if *d.images != images {
            d.images = Rc::new(images);
            // an image's size changed (edited file): rows re-laid out
            for p in self.panes.values_mut().filter(|p| p.buf == buf) {
                p.list.remeasure();
                p.cache.clear();
            }
        }
        let (rows, version) = (d.rows.clone(), d.version);
        for p in self.panes.values_mut().filter(|p| p.buf == buf) {
            p.set_rows(rows.clone(), version);
        }
        self.ask_colors(&rows);
        cx.notify();
    }

    /// Fetches remote images off the UI thread (one after another); each one that arrives gets its
    /// size into every document and the rows are laid out again (the alt text gives way).
    fn fetch_images(&mut self, urls: Vec<String>, cx: &mut Context<Self>) {
        let urls: Vec<String> = urls
            .into_iter()
            .filter(|u| self.fetching.insert(u.clone()))
            .collect();
        if urls.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            for url in urls {
                let u = url.clone();
                let got = cx
                    .background_spawn(async move { image::fetch_blocking(&u) })
                    .await;
                let alive = this.update(cx, |v, cx| {
                    v.fetching.remove(&url);
                    let Some((path, size)) = got else {
                        return;
                    };
                    for d in v.docs.values_mut() {
                        if d.images.sizes.get(&url) != Some(&size)
                            || d.images.cached.get(&url) != Some(&path)
                        {
                            Rc::make_mut(&mut d.images).insert_fetched(&url, path.clone(), size);
                        }
                    }
                    for p in v.panes.values_mut() {
                        p.list.remeasure();
                        p.cache.clear();
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    return;
                }
            }
        })
        .detach();
    }

    /// Keeps the colour cache bounded: past `COLORS_MAX` entries only the open documents' fences
    /// stay (typing in a fence adds one entry per update).
    fn prune_colors(&mut self) {
        if self.colors.len() <= COLORS_MAX {
            return;
        }
        let live: HashSet<(String, String)> = self
            .docs
            .values()
            .flat_map(|d| code_blocks(&d.rows))
            .collect();
        self.colors
            .retain(|lang, code| live.contains(&(lang.to_owned(), code.to_owned())));
        self.provisional.retain(|k| live.contains(k));
    }

    /// Asks Lua for the colours of code blocks not coloured yet (or only provisionally).
    fn ask_colors(&mut self, rows: &[Row]) {
        self.ask_blocks(code_blocks(rows));
    }

    fn ask_blocks(&mut self, mut want: Vec<(String, String)>) {
        want.retain(|k| {
            (!self.colors.contains_key(k) || self.provisional.contains(k))
                && !self.asked.contains(k)
        });
        want.sort();
        want.dedup();
        if want.is_empty() {
            return;
        }
        let id = self.next_request;
        self.next_request += 1;
        let blocks = want
            .iter()
            .map(|(l, t)| Value::Array(vec![l.as_str().into(), t.as_str().into()]))
            .collect();
        self.asked.extend(want.iter().cloned());
        self.requests.insert(id, want);
        self.scx.call(
            "config.app.markdown",
            "highlight",
            vec![id.into(), Value::Array(blocks)],
        );
    }

    /// A scroll key in a preview (Lua): `by` "line" (40 px steps) | "half" | "page" | "top" |
    /// "bottom", `n` steps (negative: up).
    fn scroll(&mut self, win: i64, by: &str, n: i64, cx: &mut Context<Self>) {
        let Some(src) = self.pane_of(win) else {
            return;
        };
        let Some(p) = self.panes.get_mut(&src) else {
            return;
        };
        let h = p.list.viewport_bounds().size.height.as_f32();
        match by {
            "line" => p.list.scroll_by(px(style::KEY_STEP * n as f32)),
            "half" => p.list.scroll_by(px(h / 2. * n as f32)),
            "page" => p
                .list
                .scroll_by(px((h - style::KEY_STEP).max(h / 2.) * n as f32)),
            "top" => p.list.scroll_to(ListOffset {
                item_ix: 0,
                offset_in_item: px(0.),
            }),
            "bottom" => p.list.scroll_to_end(),
            // `5G` / `3gg`: that source line at the top
            "goto" => {
                let line = (n - 1).max(0) as f64;
                if !p.scroll_to_line(line) {
                    p.follow = Some(line);
                }
            }
            _ => return,
        }
        p.sync.user_scrolled = true;
        if by != "goto" {
            p.follow = None;
        }
        cx.notify();
    }

    // Test / report accessors ---------------------------------------------------------------------

    /// Lua's markdown editors.
    pub fn wins(&self) -> &[MdWin] {
        &self.wins
    }

    /// The panes as last drawn.
    pub fn panes(&self) -> Vec<PaneInfo> {
        let mut out: Vec<PaneInfo> = self
            .wins
            .iter()
            .filter_map(|w| {
                let p = self.panes.get(&w.win)?;
                Some(PaneInfo {
                    win: w.win,
                    preview_win: w.preview_win()?,
                    bounds: p.bounds,
                    top_line: p.top_line,
                    rows: p.rows.len(),
                    selection: p.sel.filter(|(a, b)| a != b).map(|_| p.selected_text()),
                })
            })
            .collect();
        out.sort_by_key(|p| p.win);
        out
    }

    /// The rows a pane shows.
    pub fn rows(&self, win: i64) -> Option<Rc<Vec<Row>>> {
        self.panes.get(&win).map(|p| p.rows.clone())
    }

    /// Where `needle` is drawn in pane `win` (first match): its first character's box.
    pub fn text_bounds(&self, win: i64, needle: &str) -> Option<Bounds<Pixels>> {
        let p = self.panes.get(&win)?;
        let reg = p.registry.borrow();
        let mut keys: Vec<_> = reg.keys().copied().collect();
        keys.sort();
        for k in keys {
            let d = &reg[&k];
            if let Some(i) = d.display.text.find(needle) {
                let a = d.layout.position_for_index(i)?;
                let end = i + needle.chars().next().map_or(1, char::len_utf8);
                let b = d.layout.position_for_index(end).unwrap_or(a);
                let h = d.layout.line_height();
                return Some(Bounds::from_corners(
                    a,
                    point(b.x.max(a.x + px(1.)), a.y + h),
                ));
            }
        }
        None
    }

    /// How many lines the drawn text containing `needle` wraps to in pane `win`.
    pub fn text_lines(&self, win: i64, needle: &str) -> Option<usize> {
        let p = self.panes.get(&win)?;
        let reg = p.registry.borrow();
        let d = reg.values().find(|d| d.display.text.contains(needle))?;
        Some(
            d.layout
                .line_layouts()
                .iter()
                .map(|l| l.wrap_boundaries.len() + 1)
                .sum(),
        )
    }

    /// Texts drawn in pane `win` this frame, in order.
    pub fn drawn_texts(&self, win: i64) -> Vec<String> {
        let Some(p) = self.panes.get(&win) else {
            return Vec::new();
        };
        let reg = p.registry.borrow();
        let mut keys: Vec<_> = reg.keys().copied().collect();
        keys.sort();
        keys.iter().map(|k| reg[k].display.text.clone()).collect()
    }

    /// Web links are only recorded in [`Self::opened`], not opened (tests).
    pub fn record_links_only(&mut self) {
        self.open_links = false;
    }

    /// Links opened in the browser.
    pub fn opened(&self) -> &[String] {
        &self.opened
    }

    /// How long the last parse took (off the UI thread).
    pub fn last_parse(&self) -> Option<Duration> {
        self.last_parse
    }

    /// Mode toolbar button `mode` ("editor" | "split" | "preview") of `win`'s editor, if shown.
    pub fn toolbar_button(&self, win: i64, mode: &str) -> Option<Bounds<Pixels>> {
        let geo = self.scx.geometry();
        let w = self.wins.iter().find(|w| w.win == win && w.bar)?;
        let rects = toolbar_rects(&geo, w)?;
        let i = MODES.iter().position(|(m, _, _)| *m == mode)?;
        Some(rects[i])
    }

    // Frame ------------------------------------------------------------------------------------

    /// Before the pane's list lays out (after the editor's grid prepaint): scroll sync.
    fn prepaint_pane(
        &mut self,
        win: i64,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let geo = self.scx.geometry();
        let Some(md) = self.wins.iter().find(|w| w.win == win).cloned() else {
            return;
        };
        let editor_top = self.editor_top(&geo, &md, cx);
        let Some(p) = self.panes.get_mut(&win) else {
            return;
        };
        p.bounds = bounds;
        p.registry.borrow_mut().clear();
        if p.new_w.is_some() {
            // a resize waits for its quiet time: frames keep coming until it's laid out
            window.request_animation_frame();
        }
        if let Some(line) = p.follow.take()
            && !p.scroll_to_line(line)
        {
            p.follow = Some(line);
        }
        let Some((top, line)) = editor_top else {
            return;
        };
        let Some(preview_line) = p.preview_line() else {
            // its top row isn't measured yet (the list measures it now): next frame
            window.refresh();
            return;
        };
        p.top_line = preview_line;
        match p.sync.frame(top, line, preview_line) {
            Action::Nothing => {}
            Action::Follow(l) => {
                if !p.scroll_to_line(l) {
                    p.follow = Some(l);
                }
                if let Some(pl) = p.preview_line() {
                    p.top_line = pl;
                }
            }
            Action::SetTop(l) => {
                self.scx.call(
                    "config.app.markdown",
                    "set_top",
                    vec![win.into(), (l + 1).into()],
                );
            }
        }
    }

    /// The file window's topline as shown: (integer topline, with the smooth-scroll offset).
    fn editor_top(&self, geo: &Geometry, md: &MdWin, cx: &App) -> Option<(i64, f64)> {
        let grid = geo.win_rect(md.win)?.grid;
        if md.mode == "split"
            && let Some(d) = self.scx.drawn().get(grid)
            && let Some(top) = d.topline
        {
            let rh = d.metrics.row_height.as_f32().max(1.);
            return Some((top, top as f64 - (d.offset.as_f32() / rh) as f64));
        }
        let ws = self.scx.workspace.upgrade()?;
        let top = ws.read(cx).editor().read(cx).presented_top(grid)?;
        Some((top, top as f64))
    }

    fn render_row(
        &mut self,
        win: i64,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(p) = self.panes.get(&win) else {
            return div().into_any_element();
        };
        let Some(row) = p.rows.get(ix) else {
            return div().into_any_element();
        };
        let cache = p.cache.clone();
        let (dir, images) = self
            .docs
            .get(&p.buf)
            .map(|d| (d.dir.clone(), d.images.clone()))
            .unwrap_or_default();
        let sel = p.sel.map(|(a, b)| if a <= b { (a, b) } else { (b, a) });
        let hover = p
            .hover
            .as_ref()
            .filter(|h| h.0 == ix)
            .map(|h| (h.1, h.2.clone()));
        let ts = window.text_system().clone();
        let measure = move |d: &Display, bold: bool| -> f32 { measure_display(&ts, d, bold) };
        let this = cx.entity().downgrade();
        let on_link: render::OnLink = Rc::new(move |target, _, cx| {
            if let Some(v) = this.upgrade() {
                v.update(cx, |v, cx| v.open_link(win, &target, cx));
            }
        });
        let avail = (p.bounds.size.width.as_f32() - 2. * style::BODY_MARGIN_X).max(0.);
        let gap = p.gaps.get(ix).copied().unwrap_or(0.);
        let bottom = if ix + 1 == p.rows.len() { p.bottom } else { 0. };
        let mut rcx = RowCx::new(
            ix,
            sel,
            &self.colors,
            &p.registry,
            &dir,
            hover,
            SharedString::from(format!("md{win}")),
            &measure,
            avail,
            &images,
            &cache,
            on_link,
        );
        render::row(row, gap, bottom, &mut rcx)
    }

    // Mouse ------------------------------------------------------------------------------------

    fn mouse_down(
        &mut self,
        win: i64,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let geo = self.scx.geometry();
        if geo.gap_at(ev.position).is_some() {
            return; // a divider drag (the workspace's)
        }
        cx.stop_propagation();
        // the keyboard goes where nvim's current window goes (the click makes the preview's
        // window current): from the tree / a native surface back to nvim, like a grid click
        window.focus(&self.scx.editor_focus, cx);
        let Some(target) = self
            .wins
            .iter()
            .find(|w| w.win == win)
            .and_then(MdWin::preview_win)
        else {
            return;
        };
        let Some(p) = self.panes.get_mut(&win) else {
            return;
        };
        match ev.button {
            MouseButton::Left
                if ev.position.x >= p.bounds.right() - px(style::SCROLLBAR_TRACK)
                    && p.list.max_offset_for_scrollbar().y > px(0.5) =>
            {
                // the scrollbar's track: drag the thumb (a press off it jumps there first)
                let view = p.list.viewport_bounds();
                let max = p.list.max_offset_for_scrollbar().y;
                let h = view.size.height;
                let off = -p.list.scroll_px_offset_for_scrollbar().y;
                let thumb = (h / (max + h) * h).max(px(20.));
                let thumb_top = view.top() + (off / max) * (h - thumb);
                let off = if ev.position.y < thumb_top || ev.position.y > thumb_top + thumb {
                    let want = (ev.position.y - view.top() - thumb / 2.) / (h - thumb) * max;
                    p.list.set_offset_from_scrollbar(point(px(0.), -want));
                    p.sync.user_scrolled = true;
                    want.clamp(px(0.), max)
                } else {
                    off
                };
                p.list.scrollbar_drag_started();
                p.bar_drag = Some((ev.position.y, off));
            }
            MouseButton::Left => {
                let link = p.link_at(ev.position).map(|l| l.3);
                if ev.modifiers.shift
                    && let Some((a, _)) = p.sel
                    && let Some((pos, _)) = p.hit(ev.position)
                {
                    p.sel = Some((a, pos));
                } else if ev.click_count >= 2
                    && let Some((pos, d)) = p.hit(ev.position)
                {
                    let (s, e) = word_at(&d.text, pos.byte, ev.click_count >= 3);
                    p.sel = Some((Pos { byte: s, ..pos }, Pos { byte: e, ..pos }));
                } else {
                    p.sel = p.hit(ev.position).map(|(pos, _)| (pos, pos));
                }
                p.press = Some((ev.position, link, false));
                self.scx
                    .navigate("config.app.markdown", "enter", vec![target.into()]);
            }
            MouseButton::Right => {
                let has_sel = p.sel.is_some_and(|(a, b)| a != b);
                self.scx.call(
                    "config.app.markdown",
                    "context",
                    vec![
                        target.into(),
                        Value::F64(ev.position.x.as_f32() as f64),
                        Value::F64(ev.position.y.as_f32() as f64),
                        has_sel.into(),
                    ],
                );
            }
            _ => {}
        }
        cx.notify();
    }

    fn mouse_move(&mut self, win: i64, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(p) = self.panes.get_mut(&win) else {
            return;
        };
        if let Some((y0, off0)) = p.bar_drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                p.bar_drag = None;
                p.list.scrollbar_drag_ended();
                return;
            }
            let h = p.list.viewport_bounds().size.height;
            let max = p.list.max_offset_for_scrollbar().y;
            let thumb = (h / (max + h) * h).max(px(20.));
            let want = off0 + (ev.position.y - y0) / (h - thumb).max(px(1.)) * max;
            p.list.set_offset_from_scrollbar(point(px(0.), -want));
            p.sync.user_scrolled = true;
            p.follow = None;
            cx.notify();
            return;
        }
        if ev.pressed_button == Some(MouseButton::Left)
            && let Some((start, _, moved)) = p.press.as_mut()
        {
            let d = ev.position - *start;
            if d.x.abs() + d.y.abs() > px(3.) {
                *moved = true;
            }
            if *moved
                && let Some((a, _)) = p.sel
                && let Some((pos, _)) = p.hit(ev.position)
            {
                p.sel = Some((a, pos));
                cx.notify();
            }
            return;
        }
        let on_bar = ev.position.x >= p.bounds.right() - px(style::SCROLLBAR_TRACK)
            && p.bounds.contains(&ev.position);
        if on_bar != p.bar_hover {
            p.bar_hover = on_bar;
            cx.notify();
        }
        let hover = p.link_at(ev.position).map(|(r, t, range, _)| (r, t, range));
        if hover != p.hover {
            p.hover = hover;
            cx.notify();
        }
    }

    fn mouse_up(&mut self, win: i64, ev: &MouseUpEvent, cx: &mut Context<Self>) {
        let Some(p) = self.panes.get_mut(&win) else {
            return;
        };
        if ev.button != MouseButton::Left {
            return;
        }
        if p.bar_drag.take().is_some() {
            p.list.scrollbar_drag_ended();
            return;
        }
        let Some((_, link, moved)) = p.press.take() else {
            return;
        };
        if p.sel.is_some_and(|(a, b)| a == b) {
            p.sel = None;
        }
        if !moved && let Some(target) = link {
            p.sel = None;
            self.open_link(win, &target, cx);
        }
        cx.notify();
    }

    fn on_wheel(&mut self, win: i64, cx: &mut Context<Self>) {
        if let Some(p) = self.panes.get_mut(&win) {
            p.sync.user_scrolled = true;
            p.follow = None;
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn open_link(&mut self, win: i64, target: &str, cx: &mut Context<Self>) {
        if let Some(anchor) = target.strip_prefix('#') {
            let Some(p) = self.panes.get_mut(&win) else {
                return;
            };
            let anchor = anchor.to_lowercase();
            let found = doc::anchors(&p.rows)
                .into_iter()
                .find(|(s, _)| *s == anchor)
                .map(|(_, ix)| ix)
                .or_else(|| {
                    let label = anchor.strip_prefix("fn-")?;
                    p.rows.iter().position(|r| {
                        matches!(&r.kind, doc::RowKind::Node(doc::Node::Footnote { label: l, .. }) if doc::slug(l) == label)
                    })
                });
            if let Some(ix) = found {
                let gap = p.gaps.get(ix).copied().unwrap_or(0.);
                p.list.scroll_to(ListOffset {
                    item_ix: ix,
                    offset_in_item: px(gap),
                });
                p.sync.user_scrolled = true;
                p.follow = None;
                cx.notify();
            }
            return;
        }
        let lower = target.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:")
        {
            self.opened.push(target.to_owned());
            if self.open_links {
                let url = target.to_owned();
                // (spawning a process never waits on the UI thread)
                std::thread::spawn(move || {
                    let _ = std::process::Command::new("open").arg(url).status();
                });
            }
            return;
        }
        self.scx.navigate(
            "config.app.markdown",
            "open_link",
            vec![win.into(), target.into()],
        );
    }

    fn pane_element(
        &mut self,
        md: &MdWin,
        rect: &WinRect,
        geo: &Geometry,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let win = md.win;
        let p = self.panes.get_mut(&win)?;
        // Preview Only: below the file's tab row; a placeholder joined to its editor's island
        // (layout's markdown_pairs): right of the divider; else its own island
        let joined = rect.win != md.win
            && geo
                .win_rect(md.win)
                .and_then(|e| e.tab_bar)
                .is_some_and(|tb| tb.right() >= rect.island.right() - px(0.5));
        let own_island = rect.tab_bar.is_none() && !joined;
        let area = rect.surface_rect();
        let b = px(shell::ISLAND_BORDER);
        let inner = Bounds::from_corners(
            point(
                area.origin.x + if joined { px(0.) } else { b },
                area.origin.y + if own_island { b } else { px(0.) },
            ),
            point(area.right() - b, area.bottom() - b),
        );
        let radius = px(shell::ISLAND_RADIUS.get()) - b;
        let frame = div()
            .id(SharedString::from(format!("markdown-pane-{win}")))
            .debug_selector(move || format!("markdown-pane-{win}"))
            .absolute()
            .left(inner.origin.x)
            .top(inner.origin.y)
            .w(inner.size.width)
            .h(inner.size.height)
            .bg(style::BG)
            .text_color(style::FG)
            .font_family(style::BODY_FONT)
            .text_size(px(style::BODY_SIZE))
            .line_height(px(style::BODY_SIZE * style::BODY_LINE))
            .overflow_hidden();
        let mut el = if let Some(pre) = self.abe.get(&p.buf).cloned() {
            // a workflow's preview: Abe's words, its own clicks and scroll
            let caret = self.carets.get(&p.buf).copied();
            frame.child(abe::view(&pre, inner.size.width.as_f32(), caret, win, cx))
        } else {
            self.text_pane(win, inner.size.width, frame, cx)?
        };
        el = if own_island {
            el.rounded(radius)
        } else if joined {
            el.rounded_br(radius)
        } else {
            el.rounded_bl(radius).rounded_br(radius)
        };
        let mut out = div().child(el);
        if joined {
            // WS's OnePixelSplitter between the editor and its preview
            out = out.child(
                div()
                    .absolute()
                    .left(area.origin.x - px(1.))
                    .top(area.origin.y)
                    .w(px(1.))
                    .h(area.size.height - b)
                    .bg(style::DIVIDER),
            );
        }
        if own_island {
            // the island's outline (the editor paints none for a role window without a tab bar)
            out = out.child(
                div()
                    .absolute()
                    .left(area.origin.x)
                    .top(area.origin.y)
                    .w(area.size.width)
                    .h(area.size.height)
                    .rounded(px(shell::ISLAND_RADIUS.get()))
                    .border(b)
                    .border_color(look::ISLAND_BORDER),
            );
        }
        Some(out.into_any_element())
    }

    /// The markdown's rows in the pane's `frame` (`column_w` wide): the list, its selection, links
    /// and scrollbar.
    fn text_pane(
        &mut self,
        win: i64,
        column_w: Pixels,
        frame: gpui_kit::Stateful<gpui_kit::Div>,
        cx: &mut Context<Self>,
    ) -> Option<gpui_kit::Stateful<gpui_kit::Div>> {
        let p = self.panes.get_mut(&win)?;
        let this: WeakEntity<MarkdownView> = cx.entity().downgrade();
        let state = p.list.clone();
        let rows = p.rows.len();
        let render = cx.processor(move |v: &mut MarkdownView, ix: usize, window, cx| {
            v.render_row(win, ix, window, cx)
        });
        let list_w = p.layout_width(column_w, Instant::now());
        let list_el = div()
            .h_full()
            .w(list_w)
            .child(list(state.clone(), render).size_full())
            .into_any_element();
        let hooked = render::Hooked {
            inner: list_el,
            before: Some(Box::new(move |bounds, window, cx| {
                if let Some(v) = this.upgrade() {
                    v.update(cx, |v, cx| v.prepaint_pane(win, bounds, window, cx));
                }
            })),
        };
        let cursor = if p.hover.is_some() {
            CursorStyle::PointingHand
        } else {
            CursorStyle::IBeam
        };
        let bar = scrollbar(&state, rows, p.bar_hover || p.bar_drag.is_some());
        Some(
            frame
                .cursor(cursor)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, ev, w, cx| v.mouse_down(win, ev, w, cx)),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |v, ev, w, cx| v.mouse_down(win, ev, w, cx)),
                )
                .on_mouse_move(cx.listener(move |v, ev, _, cx| v.mouse_move(win, ev, cx)))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(move |v, ev, _, cx| v.mouse_up(win, ev, cx)),
                )
                .on_mouse_up_out(
                    MouseButton::Left,
                    cx.listener(move |v, ev, _, cx| v.mouse_up(win, ev, cx)),
                )
                .on_scroll_wheel(
                    cx.listener(move |v, _: &ScrollWheelEvent, _, cx| v.on_wheel(win, cx)),
                )
                .child(hooked)
                .children(bar),
        )
    }

    fn toolbar(&self, md: &MdWin, geo: &Geometry) -> Option<AnyElement> {
        if !md.bar {
            return None;
        }
        let rects = toolbar_rects(geo, md)?;
        let mut el = div();
        for ((mode, icon, label), r) in MODES.iter().zip(rects) {
            let scx = self.scx.clone();
            let win = md.win;
            let mode = *mode;
            el = el.child(
                div().absolute().left(r.origin.x).top(r.origin.y).child(
                    IconButton::new(SharedString::from(format!("md-mode-{win}-{mode}")), *icon)
                        .toggled(md.mode == mode)
                        .tooltip(*label, None)
                        .on_click(move |_, _, _| {
                            scx.call(
                                "config.app.markdown",
                                "set_mode",
                                vec![win.into(), mode.into()],
                            );
                        }),
                ),
            );
        }
        Some(el.into_any_element())
    }
}

/// A display text's width as drawn in the body font: bold / italic / inline-code runs (table
/// columns: cells must not wrap when they fit).
pub(crate) fn measure_display(ts: &gpui_kit::WindowTextSystem, d: &Display, bold: bool) -> f32 {
    measure_display_with_font(ts, d, bold, style::BODY_FONT)
}

/// Detail surfaces share inline measurement while choosing their native body font.
pub(crate) fn measure_display_with_font(
    ts: &gpui_kit::WindowTextSystem,
    d: &Display,
    bold: bool,
    family: &'static str,
) -> f32 {
    let base = gpui_kit::font(family);
    let mut cuts = vec![0, d.text.len()];
    for (r, st) in &d.spans {
        cuts.extend([r.start, r.end]);
        if st.code {
            let pad = render::PAD.len_utf8();
            cuts.extend([r.start + pad, r.end.saturating_sub(pad)]);
        }
    }
    cuts.retain(|c| *c <= d.text.len() && d.text.is_char_boundary(*c));
    cuts.sort_unstable();
    cuts.dedup();
    let runs: Vec<gpui_kit::TextRun> = cuts
        .windows(2)
        .map(|w| {
            let st = d
                .spans
                .iter()
                .find(|(r, _)| r.start <= w[0] && w[1] <= r.end)
                .map(|(_, st)| st);
            let mut font = base.clone();
            if bold || st.is_some_and(|s| s.bold) {
                font.weight = gpui_kit::FontWeight::BOLD;
            }
            if st.is_some_and(|s| s.italic) {
                font.style = gpui_kit::FontStyle::Italic;
            }
            if st.is_some_and(|s| s.code) {
                // (its thin-space pads stay in the body font)
                let code = &d.text[w[0]..w[1]];
                if !code.starts_with(render::PAD) {
                    font.family = style::INLINE_CODE_FONT.into();
                }
            }
            gpui_kit::TextRun {
                len: w[1] - w[0],
                font,
                color: gpui_kit::black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }
        })
        .collect();
    ts.layout_line(&d.text, px(style::BODY_SIZE), &runs, None)
        .width
        .as_f32()
}

/// Colour cache size before it's pruned to the open documents' fences.
const COLORS_MAX: usize = 300;

/// The coloured fences of `rows` (lang, code), in document order.
pub fn code_blocks(rows: &[Row]) -> Vec<(String, String)> {
    fn walk(n: &doc::Node, want: &mut Vec<(String, String)>) {
        match n {
            doc::Node::Code { lang, text } if !lang.is_empty() => {
                want.push((lang.clone(), text.clone()))
            }
            doc::Node::List(l) => {
                for i in &l.items {
                    i.nodes.iter().for_each(|n| walk(n, want));
                }
            }
            doc::Node::Quote(ns) | doc::Node::Footnote { nodes: ns, .. } => {
                ns.iter().for_each(|n| walk(n, want))
            }
            _ => {}
        }
    }
    let mut want = Vec::new();
    for r in rows {
        match &r.kind {
            doc::RowKind::Node(n) => walk(n, &mut want),
            doc::RowKind::Item { item, .. } => item.nodes.iter().for_each(|n| walk(n, &mut want)),
        }
    }
    want
}

/// The modes as the toolbar shows them: (Lua mode, icon, tooltip).
const MODES: [(&str, IconName, &str); 3] = [
    ("editor", IconName::EditorOnly, "Editor Only"),
    ("split", IconName::EditorPreview, "Editor and Preview"),
    ("preview", IconName::PreviewOnly, "Preview Only"),
];

/// Gap from the tab row's right end (island outline + WS tab row inset).
const TOOLBAR_RIGHT: f32 = 6.0;

/// The tab row's room the toolbar takes (buttons, gaps, its inset, a tab gap).
fn toolbar_room() -> f32 {
    3. * look::ACTION_BUTTON_SIZE + look::ACTION_BUTTON_GAP + TOOLBAR_RIGHT + 8.
}

/// The toolbar buttons' boxes: at the right end of the editor's tab row (over the preview too
/// when it's joined to the editor; a preview elsewhere never moves it to another split's row).
fn toolbar_rects(geo: &Geometry, md: &MdWin) -> Option<[Bounds<Pixels>; 3]> {
    let editor = geo.win_rect(md.win)?;
    let bar = editor.tab_bar?;
    // (a joined preview's tab row spans both: layout's markdown_pairs)
    let right = bar.right();
    let size = px(look::ACTION_BUTTON_SIZE);
    let gap = px(look::ACTION_BUTTON_GAP / 2.);
    let top = bar.origin.y + (bar.size.height - size) / 2.;
    let mut x = right - px(TOOLBAR_RIGHT) - size * 3. - gap * 2.;
    let mut out = [Bounds::default(); 3];
    for b in &mut out {
        *b = Bounds::new(point(x, top), gpui_kit::size(size, size));
        x += size + gap;
    }
    Some(out)
}

/// WebKit's overlay scrollbar of the preview (shown while the content overflows).
fn scrollbar(state: &ListState, rows: usize, hover: bool) -> Option<AnyElement> {
    if rows == 0 {
        return None;
    }
    let view = state.viewport_bounds();
    let max = state.max_offset_for_scrollbar().y.as_f32();
    let h = view.size.height.as_f32();
    if max <= 0.5 || h <= 0. {
        return None;
    }
    let off = -state.scroll_px_offset_for_scrollbar().y.as_f32();
    let content = max + h;
    let inset = style::SCROLLBAR_INSET;
    let track = h - 2. * inset;
    let thumb = (h / content * track).max(20.);
    let y = inset + (off / max).clamp(0., 1.) * (track - thumb);
    Some(
        div()
            .absolute()
            .right(px(inset))
            .top(px(y))
            .w(px(style::SCROLLBAR_TRACK - 2. * inset))
            .h(px(thumb))
            .rounded(px(4.))
            .bg(if hover {
                style::SCROLLBAR_THUMB_HOVER
            } else {
                style::SCROLLBAR_THUMB
            })
            .into_any_element(),
    )
}

/// The text of `registry` under `pos` (or nearest to it): selection position + its display.
/// Only what shows counts: a text scrolled out of its clip is never hit.
pub(crate) fn hit(registry: &Registry, pos: Point<Pixels>) -> Option<(Pos, Rc<Display>)> {
    hit_in(registry, pos, false)
}

/// The nearest text so far: (distance, key, the text, what of it shows).
type Best<'a> = (f32, (usize, usize), &'a Drawn, Bounds<Pixels>);

/// [`hit`], with `on_line` only a text whose line band `pos` is in (a press beside a label, not
/// in the room between texts), one in the pane pressed first.
pub(crate) fn hit_in(
    registry: &Registry,
    pos: Point<Pixels>,
    on_line: bool,
) -> Option<(Pos, Rc<Display>)> {
    let reg = registry.borrow();
    let mut best: Option<Best> = None;
    for (key, d) in reg.iter() {
        let Some(b) = d.shown() else {
            continue;
        };
        let dy = if pos.y < b.top() {
            (b.top() - pos.y).as_f32()
        } else if pos.y > b.bottom() {
            (pos.y - b.bottom()).as_f32()
        } else {
            0.
        };
        if on_line && dy > 0. {
            continue;
        }
        let dx = if pos.x < b.left() {
            (b.left() - pos.x).as_f32()
        } else if pos.x > b.right() {
            (pos.x - b.right()).as_f32()
        } else {
            0.
        };
        // a press is its own pane's: a text clipped by another (a step list beside a log's
        // gutter) only when none of the line's is in the pane pressed
        let away = on_line && d.clip.is_some_and(|c| !c.contains(&pos));
        let dist = dy * 10_000. + dx + if away { 1e9 } else { 0. };
        if best.is_none_or(|(bd, bk, _, _)| dist < bd || (dist == bd && *key < bk)) {
            best = Some((dist, *key, d, b));
        }
    }
    let (_, (row, text), d, b) = best?;
    let p = point(
        pos.x.clamp(b.left(), b.right()),
        pos.y.clamp(b.top(), (b.bottom() - px(1.)).max(b.top())),
    );
    let byte = match d.layout.index_for_position(p) {
        Ok(i) | Err(i) => i.min(d.display.text.len()),
    };
    Some((Pos { row, text, byte }, d.display.clone()))
}

/// The word (with `line`: its line, the whole text when it has one) around byte `at`.
pub(crate) fn word_at(text: &str, at: usize, line: bool) -> (usize, usize) {
    if line {
        // a text of lines (a log, a diff, a code block): the line `at` is on
        let at = at.min(text.len());
        let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        return (start, end);
    }
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let at = at.min(text.len());
    let start = text[..at]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(at, |(i, _)| i);
    let end = text[at..]
        .char_indices()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(at, |(i, c)| at + i + c.len_utf8());
    (start, end)
}

impl Focusable for MarkdownView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for MarkdownView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let geo = self.scx.geometry();
        // the tab rows keep the room of the toolbars drawn on them (geometry can change any frame)
        let reserved: HashMap<i64, f32> = self
            .wins
            .iter()
            .filter(|w| w.bar && toolbar_rects(&geo, w).is_some())
            .map(|w| (w.win, toolbar_room()))
            .collect();
        if let Some(ws) = self.scx.workspace.upgrade() {
            let tabs = ws.read(cx).tabs().clone();
            tabs.update(cx, |t, cx| t.set_reserved(reserved, cx));
        }
        let mut root = div().size_full();
        let wins = self.wins.clone();
        for md in &wins {
            if let Some(pw) = md.preview_win()
                && let Some(rect) = geo.win_rect(pw).copied()
                && rect.role == Some(shell::Role::Markdown)
                && let Some(el) = self.pane_element(md, &rect, &geo, cx)
            {
                root = root.child(el);
            }
            if let Some(bar) = self.toolbar(md, &geo) {
                root = root.child(bar);
            }
        }
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_documents_relayout_once_a_resize_is_quiet() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let mut p = Pane::new(1);
        let text: String = (0..150).map(|i| format!("p{i}\n\n")).collect();
        p.rows = Rc::new(doc::parse(&text));
        assert_eq!(p.layout_width(px(600.), ms(0)), px(600.));
        // dragging: the rows keep 600 until a width holds RELAYOUT_QUIET
        assert_eq!(p.layout_width(px(620.), ms(10)), px(600.));
        assert_eq!(p.layout_width(px(640.), ms(20)), px(600.));
        assert_eq!(p.layout_width(px(640.), ms(100)), px(600.));
        assert_eq!(p.layout_width(px(640.), ms(20 + 120)), px(640.));
        // short documents follow every frame
        let mut q = Pane::new(2);
        q.rows = Rc::new(doc::parse("short\n"));
        q.layout_width(px(600.), ms(0));
        assert_eq!(q.layout_width(px(500.), ms(1)), px(500.));
    }

    #[test]
    fn words() {
        assert_eq!(word_at("foo bar_baz qux", 6, false), (4, 11));
        assert_eq!(word_at("foo", 3, false), (0, 3));
        assert_eq!(word_at("+ a\n- bc\n  d", 6, true), (4, 8));
        assert_eq!(word_at("a b", 1, true), (0, 3));
    }
}
