//! The file preview under Find in Files' results (and Search Everywhere's, Alt+P): the file's
//! lines around the match in the editor font, line numbers, the match line and the matches
//! highlighted. Files are read off the UI thread and cached while pickers are open. A cloud
//! workspace's file is read on its box, once per popup: no stat each frame (each would be
//! a round trip), read again by the next popup.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use gpui_kit::{
    AnyElement, Context, HighlightStyle, IntoElement, ParentElement as _, ScrollDelta,
    ScrollWheelEvent, SharedString, Styled as _, Task, div, prelude::FluentBuilder as _, px,
};

use super::PickersView;
use super::rows;
use crate::look;
use crate::render::EDITOR_FONT;

/// Code line height (JetBrains Mono 13 at WebStorm's 1.2 line spacing, rounded).
pub const LINE_HEIGHT: f32 = 18.;
/// The file title row over the code: `FindPopupPanel.applyPreviewTitleInsets` 10,20,6,0 around
/// a 16 px label.
pub const TITLE_HEIGHT: f32 = 32.;
const TITLE_PAD_TOP: f32 = 10.;
const TITLE_PAD_BOTTOM: f32 = 6.;
const TITLE_PAD_LEFT: f32 = 20.;
/// Biggest file previewed (bigger ones show their first part).
const MAX_BYTES: usize = 4 << 20;
/// Editor search-result color (Darcula Contrast `SEARCH_RESULT_ATTRIBUTES` background).
const MATCH_BG: u32 = 0x32593D;

/// Files read for previews: path -> (modified time, lines with tabs as one space each: byte
/// offsets stay). A file changed on disk is read again; a cloud workspace's by the next popup.
#[derive(Default)]
pub struct Cache {
    files: HashMap<PathBuf, (Option<SystemTime>, Arc<Vec<String>>)>,
    loading: HashSet<PathBuf>,
    tasks: Vec<Task<()>>,
    /// Popups closed: a box file's read begun under an earlier popup is not kept.
    popups: u64,
    /// Syntax colors per file (from Lua's treesitter, `highlights`): the file's mtime then, spans
    /// by line.
    colors: HashMap<PathBuf, (Option<SystemTime>, Arc<Colors>)>,
    /// Requests sent to Lua: id -> file.
    asked: HashMap<u64, (PathBuf, Option<SystemTime>)>,
    next_id: u64,
}

/// A file's syntax colors: 1-based line -> (start byte, end byte, rgb, bold, italic).
pub type Colors = HashMap<u32, Vec<(usize, usize, u32, bool, bool)>>;

impl Cache {
    /// The file's lines; None while it's first read (a re-render follows). A stale copy shows
    /// while a changed file is read again.
    pub fn get(&mut self, path: &Path, cx: &mut Context<PickersView>) -> Option<Arc<Vec<String>>> {
        let exec = crate::shell::remote::exec_for(path);
        let mtime = if exec.is_some() {
            None
        } else {
            local_mtime(path)
        };
        let cached = self.files.get(path).cloned();
        if let Some((seen, lines)) = &cached
            && (exec.is_some() || *seen == mtime)
        {
            return Some(lines.clone());
        }
        if self.loading.insert(path.to_path_buf()) {
            let p = path.to_path_buf();
            let begun = exec.is_some().then_some(self.popups);
            let read = crate::shell::remote::background(path, cx, move || match exec {
                Some(exec) => crate::shell::remote::read_head(&exec, &p, MAX_BYTES)
                    .map_or_else(Vec::new, |b| lines_of(&b)),
                None => read_lines(&p),
            });
            let key = path.to_path_buf();
            self.tasks.retain(|t| !t.is_ready());
            self.tasks.push(cx.spawn(async move |this, cx| {
                let lines = Arc::new(read.await.unwrap_or_default());
                let _ = this.update(cx, |this, cx| {
                    this.previews.loading.remove(&key);
                    if begun.is_some_and(|n| n != this.previews.popups) {
                        cx.notify();
                        return;
                    }
                    // keep memory bounded across long sessions
                    if this.previews.files.len() > 64 {
                        this.previews.files.clear();
                    }
                    this.previews.files.insert(key, (mtime, lines));
                    cx.notify();
                });
            }));
        }
        cached.map(|(_, lines)| lines)
    }
}

impl Cache {
    /// The file's syntax colors, if Lua answered for its current version; else asks it (once),
    /// via `ask(id, path)`.
    pub fn colors(&mut self, path: &Path, ask: impl FnOnce(u64, &Path)) -> Option<Arc<Colors>> {
        let mtime = local_mtime(path);
        if let Some((seen, c)) = self.colors.get(path)
            && *seen == mtime
        {
            return Some(c.clone());
        }
        if !self.asked.values().any(|(p, m)| p == path && *m == mtime) {
            self.next_id += 1;
            self.asked.insert(self.next_id, (path.to_path_buf(), mtime));
            ask(self.next_id, path);
        }
        None
    }

    /// A popup closed: a cloud workspace's files and colors are read again by the next one (they
    /// are not stat'ed while shown); reads and color requests still going are dropped.
    pub fn forget_remote(&mut self) {
        let local = |p: &PathBuf| crate::shell::remote::attach_for(p).is_none();
        self.popups += 1;
        self.files.retain(|p, _| local(p));
        self.colors.retain(|p, _| local(p));
        self.asked.retain(|_, (p, _)| local(p));
    }

    /// The file's syntax colors if known (no request: [`Self::colors`] asks).
    pub fn peek_colors(&self, path: &Path) -> Option<Arc<Colors>> {
        self.colors.get(path).map(|(_, c)| c.clone())
    }

    /// Lua's answer to request `id`.
    pub fn set_colors(&mut self, id: u64, spans: Vec<(u32, usize, usize, u32, bool, bool)>) {
        let Some((path, mtime)) = self.asked.remove(&id) else {
            return;
        };
        let mut by_line: Colors = HashMap::new();
        for (line, s, e, rgb, bold, italic) in spans {
            by_line
                .entry(line)
                .or_default()
                .push((s, e, rgb, bold, italic));
        }
        if self.colors.len() > 64 {
            self.colors.clear();
        }
        self.colors.insert(path, (mtime, Arc::new(by_line)));
    }
}

/// The 1-based line numbers shown (end exclusive): `line` a third of the way down, moved by
/// `scroll`, the end of the file not scrolled past.
pub fn window(line: u32, rows: usize, len: usize, scroll: isize) -> Range<usize> {
    let target = line.max(1) as usize;
    let last_start = len.saturating_sub(rows) + 1;
    let start = (target.saturating_sub(rows / 3).max(1) as isize + scroll)
        .clamp(1, last_start.max(1) as isize) as usize;
    start..(start + rows).min(len + 1)
}

/// The lines a cached file's preview shows (tests; None until read).
impl Cache {
    /// A cached file's line count (None until read).
    pub fn len(&self, path: &Path) -> Option<usize> {
        self.files.get(path).map(|(_, l)| l.len())
    }

    pub fn shown(&self, path: &Path, line: u32, rows: usize, scroll: isize) -> Option<Vec<String>> {
        let (_, lines) = self.files.get(path)?;
        let r = window(line, rows, lines.len(), scroll);
        Some(lines[r.start - 1..r.end - 1].to_vec())
    }
}

/// Lines a wheel / trackpad event scrolls the preview (down = positive).
pub fn wheel_lines(ev: &ScrollWheelEvent) -> f32 {
    match ev.delta {
        ScrollDelta::Lines(l) => -l.y * 3.,
        ScrollDelta::Pixels(p) => -p.y.as_f32() / LINE_HEIGHT,
    }
}

/// A local file's modified time; None for a cloud workspace's (its box's file, not stat'ed here).
fn local_mtime(path: &Path) -> Option<SystemTime> {
    if crate::shell::remote::attach_for(path).is_some() {
        return None;
    }
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn read_lines(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    lines_of(&bytes)
}

/// A file's first [`MAX_BYTES`] as lines, tabs as one space each.
fn lines_of(bytes: &[u8]) -> Vec<String> {
    let bytes = &bytes[..bytes.len().min(MAX_BYTES)];
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|l| l.replace('\t', " "))
        .collect()
}

/// Byte ranges to mark per 1-based line (the search's matches in the previewed file).
pub type Marks = HashMap<u32, Vec<Range<usize>>>;

/// The preview: `title` (the path: WS `myUsagePreviewTitle`, the file name then its folder
/// grayed), then `rows` code lines around `line` (1-based; a third of the way down, moved by
/// `scroll` lines), `marks` highlighted with the editor's search-result color (every match in
/// view, like WS's usage preview).
pub fn render(
    title: &str,
    lines: Option<&[String]>,
    colors: Option<&Colors>,
    line: u32,
    marks: &Marks,
    rows: usize,
    scroll: isize,
) -> AnyElement {
    let (dir, name) = rows::split_path(title);
    let title_row = div()
        .h(px(TITLE_HEIGHT))
        .flex_none()
        .pl(px(TITLE_PAD_LEFT))
        .pt(px(TITLE_PAD_TOP))
        .pb(px(TITLE_PAD_BOTTOM))
        .flex()
        .items_center()
        .overflow_hidden()
        .whitespace_nowrap()
        .child(
            div()
                .flex_none()
                .text_color(look::TEXT)
                .child(SharedString::from(name.to_string())),
        )
        // a thin space, then the folder (ContextHelp gray)
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis_start()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(format!("\u{2009}{dir}"))),
        );
    let lines = lines.unwrap_or(&[]);
    let target = line.max(1) as usize;
    let Range { start, end } = window(line, rows, lines.len(), scroll);
    let digits = (end.max(1)).to_string().len().max(3);
    let num_w = digits as f32 * 7.8 + 16.;
    let match_style = HighlightStyle {
        background_color: Some(look::hsla(look::hex(MATCH_BG))),
        ..Default::default()
    };
    let code = (start..end).map(|n| {
        let text = lines.get(n - 1).cloned().unwrap_or_default();
        let current = n == target;
        // syntax colors, the matches over them
        let syntax = colors
            .and_then(|c| c.get(&(n as u32)))
            .into_iter()
            .flatten()
            .map(|&(s, e, rgb, bold, italic)| {
                let style = HighlightStyle {
                    color: Some(look::hsla(rows::color(rgb))),
                    font_weight: bold.then_some(gpui_kit::FontWeight::BOLD),
                    font_style: italic.then_some(gpui_kit::FontStyle::Italic),
                    ..Default::default()
                };
                (s..e, style)
            });
        let matches = marks
            .get(&(n as u32))
            .into_iter()
            .flatten()
            .map(|r| (r.clone(), match_style));
        let styled = rows::ranged(text, syntax.chain(matches).collect::<Vec<_>>());
        div()
            .h(px(LINE_HEIGHT))
            .flex_none()
            .flex()
            .items_center()
            .when(current, |d| d.bg(look::EDITOR_CARET_ROW_BG))
            .child(
                div()
                    .w(px(num_w))
                    .flex_none()
                    .pr(px(12.))
                    .flex()
                    .justify_end()
                    .text_color(if current {
                        look::EDITOR_LINE_NUMBER_CURRENT
                    } else {
                        look::EDITOR_LINE_NUMBER
                    })
                    .child(SharedString::from(n.to_string())),
            )
            .child(
                div()
                    .flex_1()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .child(styled),
            )
    });
    div()
        .flex_none()
        .flex()
        .flex_col()
        .bg(look::EDITOR_BG)
        .child(title_row.bg(look::POPUP_BG))
        .child(
            div()
                .h(px(rows as f32 * LINE_HEIGHT))
                .flex_none()
                .overflow_hidden()
                .font_family(EDITOR_FONT)
                // ligatures as the editor draws them
                .font_features(crate::render::editor_features())
                .text_size(px(13.))
                .text_color(look::TEXT)
                .children(code),
        )
        .into_any_element()
}
