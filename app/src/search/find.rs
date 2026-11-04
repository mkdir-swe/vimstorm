//! Find in Files (Cmd+Shift+F): ripgrep over the project, streamed in while typing; results over a
//! preview of the selected match's file.
//!
//! Look: WebStorm's `FindPopupPanel` (New UI): a complex header ("Find in Files", the match count;
//! on the right the "File mask:" checkbox + field and the filter funnel), the borderless search
//! field with the Cc / W / .* toggles over a 1 px line inset 12, the scopes row ("In Project |
//! Directory"), result rows (the code line with the match highlighted, "file.ts 12" grayed on the
//! right, a file name repeated from the row above at half alpha), a splitter (results a third, the
//! preview the rest; every match in view marked) and the bottom hint bar. Centred, 115 px from the
//! window top. The toggles, file mask and filters stay as left for the next Find in Files of the
//! session (WS keeps them in `FindSettings`); regex starts off (WS `FindModel` default).

use std::collections::{BTreeSet, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::StreamExt as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    SharedString, Size, Styled as _, Subscription, Task, Window, div, prelude::FluentBuilder as _,
    px, uniform_list,
};

use super::grep::{self, Batch, GrepMatch, Options};
use super::preview::{self, Marks};
use super::rows::{self, split_path};
use super::{Action, PickerState, PickersView, Popup, Target};
use crate::kit;
use crate::kit::{CheckState, Checkbox};
use crate::kit::{FieldEvent, TextField};
use crate::kit::{Icon, IconName};
use crate::kit::{ListSource, ListState};
use crate::look;
use crate::search::scope::Exclusions;

/// `FindPopupPanel` y from the frame top without a navigation bar.
const TOP: f32 = 115.;
/// Title -> count gap (FindPopupHeader title cell right gap).
const COUNT_GAP: f32 = 12.;
/// Search field row: the complex text-field border (0,12 outer; input 4,2,4,2) around a 20 px
/// line, the 1 px line under it inset 12 (`PopupUtil.createComplexPopupTextFieldBorder`).
pub(crate) const FIELD_ROW: f32 = 28.;
pub(crate) const FIELD_INSET_X: f32 = 12.;
pub(super) const FIELD_INPUT_PAD_X: f32 = 2.;
/// Toggle buttons (Cc / W / .*, the filter): `SearchOption.selectedBackground` = Blue3.
const TOGGLE: f32 = 22.;
const TOGGLE_ON_BG: crate::look::Tok = look::SEARCH_FIELD_TOGGLE_ON_BG;
/// Scopes row: "FindPopup.scopesPanelInsets.compact" 1,20,1,20 around 28 px toolbar buttons;
/// RowBuilder gap 26 to the details.
const SCOPES_ROW: f32 = 30.;
const SCOPES_PAD_X: f32 = 20.;
const SCOPE_DETAILS_GAP: f32 = 26.;
/// A scope button (ActionButtonWithText: 0,8 insets, 24 high, selected = pushed look).
const SCOPE_BUTTON_H: f32 = 24.;
const SCOPE_BUTTON_PAD_X: f32 = 8.;
/// File mask field in the header (`FindPopupHeader` combo, min 80 px).
const MASK_W: f32 = 120.;
const MASK_H: f32 = 24.;
/// Bottom bar: Advertiser background, "FindPopup.bottomPanelInsets.compact" 1,18,1,18.
const BOTTOM_PAD_X: f32 = 18.;
/// `scrollPane.setBorder(JBUI.Borders.emptyBottom(4))` under the results.
const RESULTS_PAD_BOTTOM: f32 = 4.;
/// Results share of results + preview (`FindPopupPanel` splitter proportion).
const RESULTS_SHARE: f32 = 0.33;
/// Matching lines kept (the count shows "1000+").
const MAX: usize = 1000;

struct Len(usize);

impl ListSource for Len {
    fn len(&self) -> usize {
        self.0
    }
    fn text(&self, _: usize) -> SharedString {
        SharedString::default()
    }
}

/// What a Find in Files popup leaves for the next one of the session (WS `FindSettings`).
#[derive(Clone, Debug)]
pub struct Remembered {
    pub opts: Options,
    pub mask_on: bool,
    pub mask: String,
}

impl Default for Remembered {
    fn default() -> Self {
        Remembered {
            // WS `FindModel`: Cc / W / .* all off
            opts: Options {
                regex: false,
                ..Options::default()
            },
            mask_on: false,
            mask: String::new(),
        }
    }
}

pub struct FindPopup {
    pub field: Entity<TextField>,
    /// The header's "File mask:" field (rg globs, comma separated) and its checkbox.
    pub mask: Entity<TextField>,
    mask_on: bool,
    /// The filter funnel's menu (hidden / ignored / symlinks) is open.
    filter_open: bool,
    project: PathBuf,
    /// Searched dirs: empty = In Project, else the Directory scope.
    dirs: Vec<PathBuf>,
    /// The Directory scope's folder (Find in Folder's, else the current file's).
    folder: Option<PathBuf>,
    /// Opened as Find in Folder.
    from_folder: bool,
    opts: Options,
    /// The project scope as rg globs (None until read: a search waits for it, so nothing out of
    /// scope ever flashes in).
    excludes: Option<Vec<String>>,
    matches: Vec<GrepMatch>,
    files: HashSet<Arc<str>>,
    done: bool,
    truncated: bool,
    error: Option<String>,
    /// The running rg (dropping it kills rg).
    search: Option<grep::Search>,
    task: Option<Task<()>>,
    seq: u64,
    list: ListState,
    /// Snacks' Tab multi-selection (rows).
    selected: BTreeSet<usize>,
    /// Lines the preview is scrolled from its default (Ctrl+F / Ctrl+B, the wheel).
    preview_scroll: f32,
    /// Code rows the preview had at the last render.
    preview_rows: usize,
    pub typeahead_at: Option<usize>,
    _subs: Vec<Subscription>,
}

/// A dir relative to the project (rg then prints project-relative paths); "." for the project.
fn relative(project: &Path, d: PathBuf) -> PathBuf {
    let d = d.strip_prefix(project).map(Path::to_path_buf).unwrap_or(d);
    if d.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        d
    }
}

impl FindPopup {
    #[allow(
        clippy::too_many_arguments,
        reason = "Lua's open payload + the remembered toggles / scope, passed straight through"
    )]
    pub fn new(
        project: PathBuf,
        query: Option<String>,
        dirs: Vec<PathBuf>,
        folder: Option<PathBuf>,
        remembered: &Remembered,
        scope: Option<&Exclusions>,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> Self {
        let field = cx.new(|cx| {
            let mut f = TextField::new(cx)
                .search()
                .borderless()
                .pad_x(FIELD_INPUT_PAD_X)
                .height(FIELD_ROW);
            if let Some(q) = &query {
                f.set_text(q.clone(), cx);
                f.select_all(cx);
            }
            f
        });
        let mask = cx.new(|cx| {
            let mut f = TextField::new(cx)
                .height(MASK_H)
                .placeholder("*.ts, !*.spec.ts");
            f.set_text(remembered.mask.clone(), cx);
            f
        });
        let subs = vec![
            cx.subscribe_in(
                &field,
                window,
                |this: &mut PickersView, _, ev, window, cx| {
                    if *ev == FieldEvent::Changed {
                        this.query_changed(window, cx);
                    }
                },
            ),
            cx.subscribe_in(&mask, window, |this: &mut PickersView, _, ev, _, cx| {
                if *ev == FieldEvent::Changed
                    && let Some(Popup::Find(f)) = &mut this.popup
                    && f.mask_on
                {
                    f.requery(cx);
                    cx.notify();
                }
            }),
        ];
        let at = field.read(cx).text().len();
        let dirs: Vec<PathBuf> = dirs.into_iter().map(|d| relative(&project, d)).collect();
        let folder = dirs
            .first()
            .cloned()
            .or_else(|| folder.map(|d| relative(&project, d)));
        let mut f = FindPopup {
            field,
            mask,
            mask_on: remembered.mask_on,
            filter_open: false,
            project,
            from_folder: !dirs.is_empty(),
            dirs,
            folder,
            opts: remembered.opts,
            excludes: None,
            matches: Vec::new(),
            files: HashSet::new(),
            done: true,
            truncated: false,
            error: None,
            search: None,
            task: None,
            seq: 0,
            list: ListState::new(),
            selected: BTreeSet::new(),
            preview_scroll: 0.,
            preview_rows: 12,
            typeahead_at: Some(at),
            _subs: subs,
        };
        match scope {
            Some(ex) => f.set_scope(ex, cx),
            None => f.requery(cx),
        }
        f
    }

    /// The project scope (read again on every open): searches again when it changed.
    pub fn set_scope(&mut self, ex: &Exclusions, cx: &mut Context<PickersView>) {
        // Find in Folder on an excluded folder searches it (an explicit directory scope in
        // WebStorm); the ignore files still apply
        let inside = self
            .dirs
            .iter()
            .any(|d| ex.out_of_scope(&self.project.join(d), true));
        let globs = if inside { Vec::new() } else { ex.rg_globs() };
        if self.excludes.as_ref() != Some(&globs) {
            self.excludes = Some(globs);
            self.requery(cx);
        }
    }

    /// Searches again for the field's text (the running rg is killed).
    pub fn requery(&mut self, cx: &mut Context<PickersView>) {
        self.seq += 1;
        let seq = self.seq;
        let query = self.field.read(cx).text().to_string();
        self.search = None;
        self.matches.clear();
        self.files.clear();
        self.truncated = false;
        self.error = None;
        self.list.refresh(&Len(0));
        self.list.set_cursor(None);
        self.selected.clear();
        self.preview_scroll = 0.;
        if query.is_empty() {
            self.done = true;
            self.task = None;
            return;
        }
        self.done = false;
        let Some(excludes) = &self.excludes else {
            // set_scope searches once the scope is read
            self.task = None;
            return;
        };
        let globs = self.mask_globs(cx);
        let mut search = grep::search_with(
            &self.project,
            &query,
            MAX,
            self.opts,
            &self.dirs,
            &globs,
            excludes,
        );
        let mut rx = std::mem::replace(&mut search.rx, futures::channel::mpsc::unbounded().1);
        self.search = Some(search);
        self.task = Some(cx.spawn(async move |this, cx| {
            while let Some(batch) = rx.next().await {
                let alive = this.update(cx, |this, cx| {
                    let Some(Popup::Find(f)) = &mut this.popup else {
                        return false;
                    };
                    if f.seq != seq {
                        return false;
                    }
                    f.add(batch);
                    this.prefetch_preview(cx);
                    cx.notify();
                    true
                });
                if !matches!(alive, Ok(true)) {
                    break;
                }
            }
        }));
    }

    fn add(&mut self, batch: Batch) {
        match batch {
            Batch::Matches(ms) => {
                for m in &ms {
                    if !self.files.contains(&m.path) {
                        self.files.insert(m.path.clone());
                    }
                }
                self.matches.extend(ms);
                self.list.refresh(&Len(self.matches.len()));
                if self.list.cursor().is_none() {
                    self.list.set_cursor(Some(0));
                }
            }
            Batch::Done {
                truncated, error, ..
            } => {
                self.done = true;
                self.truncated = truncated;
                self.error = error;
                self.search = None;
            }
        }
    }

    /// The selected match's file.
    pub fn selected_path(&self) -> Option<PathBuf> {
        let m = self.matches.get(self.list.cursor()?)?;
        Some(self.project.join(&*m.path))
    }

    /// What the preview shows: (file, match line, rows, scroll).
    pub fn preview_target(&self) -> Option<(PathBuf, u32, usize, isize)> {
        let m = self.matches.get(self.list.cursor()?)?;
        Some((
            self.project.join(&*m.path),
            m.line,
            self.preview_rows,
            self.preview_scroll.round() as isize,
        ))
    }

    /// Opened as Find in Folder.
    pub fn in_folder(&self) -> bool {
        self.from_folder
    }

    /// The toggles / file mask for the next Find in Files.
    pub fn remembered(&self, cx: &gpui_kit::App) -> Remembered {
        Remembered {
            opts: self.opts,
            mask_on: self.mask_on,
            mask: self.mask.read(cx).text().to_string(),
        }
    }

    /// The file mask as rg globs (`*.ts, !*.spec.ts`), when its checkbox is on.
    fn mask_globs(&self, cx: &gpui_kit::App) -> Vec<String> {
        if !self.mask_on {
            return Vec::new();
        }
        self.mask
            .read(cx)
            .text()
            .split(',')
            .map(str::trim)
            .filter(|g| !g.is_empty())
            .map(|g| format!("--glob={g}"))
            .collect()
    }

    /// In Project (false) / Directory (true): searches again.
    fn set_directory_scope(&mut self, on: bool, cx: &mut Context<PickersView>) {
        let dirs: Vec<PathBuf> = if on {
            self.folder.iter().cloned().collect()
        } else {
            Vec::new()
        };
        if dirs != self.dirs {
            self.dirs = dirs;
            self.requery(cx);
        }
    }

    /// Every match of the search in `path` by line (the preview marks them), on the full line
    /// (row texts of long lines are cut).
    fn marks(&self, path: &str) -> Marks {
        let mut out = Marks::new();
        for m in self.matches.iter().filter(|m| &*m.path == path) {
            let shift = m.ranges.first().map_or(0, |r| m.col - r.start.min(m.col));
            out.entry(m.line)
                .or_default()
                .extend(m.ranges.iter().map(|r| r.start + shift..r.end + shift));
        }
        out
    }

    /// Marked ranges on the preview's shown lines (tests).
    pub fn preview_marks(&self, shown: std::ops::Range<usize>) -> usize {
        let Some(m) = self.list.cursor().and_then(|r| self.matches.get(r)) else {
            return 0;
        };
        self.marks(&m.path)
            .iter()
            .filter(|(l, _)| shown.contains(&(**l as usize)))
            .map(|(_, r)| r.len())
            .sum()
    }

    pub fn key(&mut self, key: &str, cx: &mut Context<PickersView>) -> Action {
        let n = self.matches.len();
        let mv = |s: &mut Self, k: &str| {
            s.list.key(k, None, &Len(n), &Default::default());
            s.preview_scroll = 0.;
            Action::Handled
        };
        let toggle = |s: &mut Self, cx: &mut Context<PickersView>, f: fn(&mut Options)| {
            f(&mut s.opts);
            s.requery(cx);
            Action::Handled
        };
        match key {
            // snacks' select_and_next / select_and_prev
            "<Tab>" | "<S-Tab>" => {
                if let Some(row) = self.list.cursor()
                    && !self.selected.remove(&row)
                {
                    self.selected.insert(row);
                }
                mv(self, if key == "<Tab>" { "<Down>" } else { "<Up>" })
            }
            "<Down>" | "<C-n>" | "<C-j>" => mv(self, "<Down>"),
            "<Up>" | "<C-p>" | "<C-k>" => mv(self, "<Up>"),
            "<PageDown>" | "<C-d>" => mv(self, "<PageDown>"),
            "<PageUp>" | "<C-u>" => mv(self, "<PageUp>"),
            "<C-f>" | "<C-b>" => {
                let half = 8.;
                self.preview_scroll += if key == "<C-f>" { half } else { -half };
                Action::Handled
            }
            // WebStorm's Alt+C / Alt+W / Alt+X, snacks' Alt+R / Alt+H / Alt+I / Alt+F
            "<M-c>" => toggle(self, cx, |o| o.case = !o.case),
            "<M-w>" => toggle(self, cx, |o| o.words = !o.words),
            "<M-x>" | "<M-r>" => toggle(self, cx, |o| o.regex = !o.regex),
            "<M-h>" => toggle(self, cx, |o| o.hidden = !o.hidden),
            "<M-i>" => toggle(self, cx, |o| o.ignored = !o.ignored),
            "<M-f>" => toggle(self, cx, |o| o.follow = !o.follow),
            "<C-q>" => self.quickfix(),
            "<Esc>" if self.filter_open => {
                self.filter_open = false;
                Action::Handled
            }
            "<CR>" => self.confirm(self.list.cursor(), "edit"),
            "<S-CR>" => self.confirm(self.list.cursor(), "pick"),
            "<C-v>" => self.confirm(self.list.cursor(), "vsplit"),
            "<C-s>" => self.confirm(self.list.cursor(), "split"),
            "<Esc>" | "<C-c>" => Action::Close,
            _ => Action::Ignored,
        }
    }

    fn target(&self, row: usize) -> Option<Target> {
        let m = self.matches.get(row)?;
        Some(Target {
            path: self.project.join(&*m.path),
            line: Some(m.line),
            // bytes: the caret goes on the match also after å / ä / ö and in cut long lines
            col: Some(m.col as u32 + 1),
            enc: None,
            text: m.text.trim().to_string(),
        })
    }

    /// Opens the result (or the Tab selection) at its match; before the first result: nothing,
    /// the popup stays (today's `confirm_found`).
    fn confirm(&self, row: Option<usize>, how: &'static str) -> Action {
        let rows: Vec<usize> = if self.selected.is_empty() {
            row.into_iter().collect()
        } else {
            self.selected.iter().copied().collect()
        };
        let targets: Vec<Target> = rows.into_iter().filter_map(|r| self.target(r)).collect();
        if targets.is_empty() {
            return Action::Handled;
        }
        Action::Open { targets, how }
    }

    /// Ctrl+Q: the selection (else every result) into the quickfix list.
    fn quickfix(&self) -> Action {
        let rows: Vec<usize> = if self.selected.is_empty() {
            (0..self.matches.len()).collect()
        } else {
            self.selected.iter().copied().collect()
        };
        Action::Quickfix {
            title: "Find in Files".into(),
            targets: rows.into_iter().filter_map(|r| self.target(r)).collect(),
        }
    }

    pub fn state(&self, cx: &gpui_kit::App) -> PickerState {
        let (rows, details) = self
            .matches
            .iter()
            .map(|m| {
                let (code, _) = trimmed(m);
                (code.to_string(), location(m))
            })
            .unzip();
        PickerState {
            kind: "grep".into(),
            query: self.field.read(cx).text().to_string(),
            rows,
            details,
            cursor: self.list.cursor(),
            settled: self.done,
            preview: true,
            title: "Find in Files".into(),
            right: self.scope_text(),
            ..Default::default()
        }
    }

    /// The scope as shown: "In Project" / "Directory <dir>", then the filters / mask that are on
    /// (tests).
    fn scope_text(&self) -> String {
        let mut out = match self.dirs.first() {
            Some(d) => format!("Directory {}", d.display()),
            None => "In Project".to_string(),
        };
        for (on, name) in [
            (self.opts.hidden, "hidden"),
            (self.opts.ignored, "ignored"),
            (self.opts.follow, "follow"),
            (self.opts.regex, "regex"),
            (self.mask_on, "mask"),
        ] {
            if on {
                out.push(' ');
                out.push_str(name);
            }
        }
        out
    }

    fn count_text(&self) -> String {
        if let Some(e) = &self.error {
            return e.clone();
        }
        let n = self.matches.len();
        if n == 0 {
            return if self.done || self.field_empty() {
                String::new()
            } else {
                "Searching…".into()
            };
        }
        let more = if self.truncated || !self.done {
            "+"
        } else {
            ""
        };
        let files = self.files.len();
        format!(
            "{n}{more} match{} in {files}{more} file{}",
            if n == 1 { "" } else { "es" },
            if files == 1 { "" } else { "s" }
        )
    }

    fn field_empty(&self) -> bool {
        self.matches.is_empty() && self.search.is_none()
    }

    // Render -------------------------------------------------------------------------------------

    pub fn render(
        &mut self,
        viewport: Size<Pixels>,
        previews: &mut preview::Cache,
        _window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        let margin = look::POPUP_WINDOW_MARGIN;
        let vw = viewport.width.as_f32();
        let vh = viewport.height.as_f32();
        let width = (vw * 0.62).clamp(700., 1100.).min(vw - 2. * margin);
        let top = TOP.min(vh * 0.12).max(margin);
        let height = (vh * 0.8).min(vh - top - margin).max(200.);
        let x = kit::centered(width, vw);
        let ad_h = look::POPUP_AD_HEIGHT;
        let body =
            height - look::COMPLEX_HEADER_HEIGHT - 1. - FIELD_ROW - 1. - SCOPES_ROW - ad_h - 1.;
        let row_h = look::LIST_ROW_HEIGHT;
        let results_h = ((body * RESULTS_SHARE - RESULTS_PAD_BOTTOM) / row_h)
            .floor()
            .max(4.)
            * row_h;
        let preview_rows = (((body - results_h - RESULTS_PAD_BOTTOM - preview::TITLE_HEIGHT)
            / preview::LINE_HEIGHT)
            .floor())
        .max(3.) as usize;
        self.list
            .set_page_rows(((results_h / row_h) as usize).saturating_sub(1).max(1));
        self.preview_rows = preview_rows;

        let n = self.matches.len();
        let title = div()
            .flex()
            .items_center()
            .gap(px(COUNT_GAP))
            .child("Find in Files")
            .child(
                div()
                    .font_weight(FontWeight::NORMAL)
                    .text_color(if self.error.is_some() {
                        look::TEXT_ERROR
                    } else {
                        look::TEXT_DIM
                    })
                    .child(SharedString::from(self.count_text())),
            );
        let header = kit::complex_header(title, Some(self.render_header_right(cx)))
            .debug_selector(|| "find-header".into());
        let toggles = [
            (IconName::MatchCase, "Match case", 0usize, self.opts.case),
            (IconName::Words, "Words", 1, self.opts.words),
            (IconName::Regex, "Regex", 2, self.opts.regex),
        ]
        .into_iter()
        .map(|(icon, name, i, on)| {
            toggle_button(("find-toggle", i), format!("find-toggle-{name}"), icon, on)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        if let Some(Popup::Find(f)) = &mut this.popup {
                            match i {
                                0 => f.opts.case = !f.opts.case,
                                1 => f.opts.words = !f.opts.words,
                                _ => f.opts.regex = !f.opts.regex,
                            }
                            let h = f.field.read(cx).focus_handle(cx);
                            window.focus(&h, cx);
                            f.requery(cx);
                        }
                        cx.notify();
                    }),
                )
        });
        // WS: a borderless text area on the popup bg, the toggles at its right end
        let field_row = div()
            .id("find-field-row")
            .debug_selector(|| "find-field-row".into())
            .h(px(FIELD_ROW))
            .flex_none()
            .px(px(FIELD_INSET_X))
            .flex()
            .items_center()
            .gap(px(2.))
            .child(div().flex_1().cursor_text().child(self.field.clone()))
            .children(toggles);
        let list: AnyElement = if n == 0 {
            let msg = if self.done && !self.field.read(cx).text().is_empty() {
                "Nothing found"
            } else {
                ""
            };
            rows::empty_message(msg)
        } else {
            uniform_list(
                "find-rows",
                n,
                cx.processor(
                    |this: &mut PickersView, range: Range<usize>, _window, cx| match &this.popup {
                        Some(Popup::Find(f)) => f.render_rows(range, cx),
                        _ => Vec::new(),
                    },
                ),
            )
            .track_scroll(self.list.scroll_handle())
            .size_full()
            .into_any_element()
        };
        let preview = match self.list.cursor().and_then(|r| self.matches.get(r)) {
            Some(m) => {
                let file = self.project.join(&*m.path);
                let lines = previews.get(&file, cx);
                let colors = previews.peek_colors(&file);
                let marks = self.marks(&m.path);
                div()
                    .id("find-preview")
                    .size_full()
                    .on_scroll_wheel(cx.listener(|this, ev: &gpui_kit::ScrollWheelEvent, _, cx| {
                        if let Some(Popup::Find(f)) = &mut this.popup {
                            f.preview_scroll += preview::wheel_lines(ev);
                            cx.notify();
                        }
                    }))
                    .child(preview::render(
                        &m.path,
                        lines.as_ref().map(|l| l.as_slice()),
                        colors.as_deref(),
                        m.line,
                        &marks,
                        preview_rows,
                        self.preview_scroll.round() as isize,
                    ))
                    .into_any_element()
            }
            None => div().flex_1().bg(look::EDITOR_BG).into_any_element(),
        };
        // WS: navigation hint left, the "open in the result window" hint right (ours: quickfix)
        let ad = kit::ad_text("Press ↩ to open, ⌃V to open in a split")
            .h(px(ad_h))
            .px(px(BOTTOM_PAD_X))
            .justify_between()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .gap(px(6.))
                    .child(div().text_color(look::TEXT_DIM).child("⌃Q"))
                    .child("Open in Quickfix List"),
            );
        let filter_menu = self.filter_open.then(|| self.render_filter_menu(cx));
        kit::popup_frame()
            .id("find-in-files")
            .debug_selector(|| "find-in-files".into())
            .absolute()
            .left(px(x))
            .top(px(top))
            .w(px(width))
            .h(px(height))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.close(window, cx);
            }))
            .child(header)
            .child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            .child(field_row)
            .child(
                div()
                    .h(px(1.))
                    .flex_none()
                    .mx(px(FIELD_INSET_X))
                    .bg(look::SEPARATOR),
            )
            .child(self.render_scopes(cx))
            .child(
                div()
                    .h(px(results_h + RESULTS_PAD_BOTTOM))
                    .flex_none()
                    .pb(px(RESULTS_PAD_BOTTOM))
                    .child(list),
            )
            .child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            .child(div().flex_1().min_h_0().overflow_hidden().child(preview))
            .child(ad)
            .children(filter_menu)
            .into_any_element()
    }

    /// The header's right part: "File mask:" checkbox + field, the filter funnel (WS
    /// FindPopupHeader; no pin: the popup never stays open on its own).
    fn render_header_right(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let state = if self.mask_on {
            CheckState::Checked
        } else {
            CheckState::Unchecked
        };
        let entity = cx.entity().downgrade();
        let check = Checkbox::new("find-mask-check", state)
            .label("File mask:")
            .on_toggle(move |st, window, cx| {
                let _ = entity.update(cx, |this, cx| {
                    if let Some(Popup::Find(f)) = &mut this.popup {
                        f.mask_on = st == CheckState::Checked;
                        let field = if f.mask_on { &f.mask } else { &f.field };
                        let h = field.read(cx).focus_handle(cx);
                        window.focus(&h, cx);
                        f.requery(cx);
                    }
                    cx.notify();
                });
            });
        let filters_on = self.opts.hidden || self.opts.ignored || self.opts.follow;
        let funnel = toggle_button(
            "find-filter",
            "find-filter".to_string(),
            IconName::Filter,
            filters_on || self.filter_open,
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                if let Some(Popup::Find(f)) = &mut this.popup {
                    f.filter_open = !f.filter_open;
                }
                cx.notify();
            }),
        );
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.))
            .font_weight(FontWeight::NORMAL)
            .child(
                div()
                    .debug_selector(|| "find-mask-check".into())
                    .child(check),
            )
            .child(
                div()
                    .w(px(MASK_W))
                    .flex_none()
                    .debug_selector(|| "find-mask".into())
                    .child(self.mask.clone()),
            )
            .child(funnel)
            .into_any_element()
    }

    /// The funnel's menu: hidden files / ignored files / symlinks (snacks' Alt+H / I / F).
    fn render_filter_menu(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let items = [
            (0usize, "Hidden files", "⌥H", self.opts.hidden),
            (1, "Ignored files", "⌥I", self.opts.ignored),
            (2, "Follow symlinks", "⌥F", self.opts.follow),
        ]
        .into_iter()
        .map(|(i, label, key, on)| {
            rows::row(
                ("find-filter-item", i),
                px(look::LIST_ROW_HEIGHT.get()),
                false,
                false,
            )
            .hover(|d| d.bg(look::HOVER_BG))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    if let Some(Popup::Find(f)) = &mut this.popup {
                        match i {
                            0 => f.opts.hidden = !f.opts.hidden,
                            1 => f.opts.ignored = !f.opts.ignored,
                            _ => f.opts.follow = !f.opts.follow,
                        }
                        f.filter_open = false;
                        f.requery(cx);
                    }
                    cx.notify();
                }),
            )
            .child(
                rows::row_content()
                    .gap(px(6.))
                    .child(
                        div()
                            .size(px(look::ICON_SIZE))
                            .flex_none()
                            .when(on, |d| d.child(Icon::new(IconName::Checked))),
                    )
                    .child(div().flex_1().child(label))
                    .child(rows::dim(key)),
            )
        });
        kit::popup_frame()
            .id("find-filter-menu")
            .debug_selector(|| "find-filter-menu".into())
            .absolute()
            .top(px(look::COMPLEX_HEADER_HEIGHT - 4.))
            .right(px(look::COMPLEX_HEADER_PAD_R))
            .w(px(200.))
            .py(px(look::POPUP_PADDING_Y / 2.))
            .children(items)
            .into_any_element()
    }

    /// "In Project | Directory" (WS scope toolbar; no modules / named scopes here) and the
    /// Directory scope's folder.
    fn render_scopes(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let dir_on = !self.dirs.is_empty();
        let button = |i: usize, label: &'static str, on: bool, cx: &mut Context<PickersView>| {
            div()
                .id(("find-scope", i))
                .debug_selector(move || format!("find-scope-{label}"))
                .h(px(SCOPE_BUTTON_H))
                .px(px(SCOPE_BUTTON_PAD_X))
                .flex()
                .items_center()
                .rounded(px(look::ACTION_BUTTON_ARC))
                .cursor_pointer()
                .when(on, |d| d.bg(look::HOVER_BG))
                .when(!on, |d| d.hover(|d| d.bg(look::HOVER_BG)))
                .child(label)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        if let Some(Popup::Find(f)) = &mut this.popup {
                            f.set_directory_scope(i == 1, cx);
                            let h = f.field.read(cx).focus_handle(cx);
                            window.focus(&h, cx);
                        }
                        cx.notify();
                    }),
                )
        };
        let details = self
            .dirs
            .first()
            .or(self.folder.as_ref())
            .filter(|_| dir_on)
            .map(|d| {
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis_start()
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(d.display().to_string()))
            });
        div()
            .h(px(SCOPES_ROW))
            .flex_none()
            .px(px(SCOPES_PAD_X))
            .flex()
            .items_center()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(button(0, "In Project", !dir_on, cx))
                    .when(self.folder.is_some(), |d| {
                        d.child(button(1, "Directory", dir_on, cx))
                    }),
            )
            .children(details.map(|d| div().pl(px(SCOPE_DETAILS_GAP)).min_w_0().child(d)))
            .into_any_element()
    }

    fn render_rows(&self, range: Range<usize>, cx: &mut Context<PickersView>) -> Vec<AnyElement> {
        range
            .filter_map(|row| {
                let m = self.matches.get(row)?;
                let (code, ranges) = trimmed(m);
                let style = rows::match_style();
                // the file name again on the next rows: half alpha (UsageTableCellRenderer)
                let repeated = row > 0 && self.matches[row - 1].path == m.path;
                let selected = self.list.cursor() == Some(row) || self.selected.contains(&row);
                let content = rows::row_content()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            // WS: the table's label font (Inter 13), syntax chunks colored;
                            // the editor's ligature setting, so Inter's `calt` never draws `=>`
                            // as `⇒` while the editor shows `=>`
                            .font_features(crate::render::editor_features())
                            .child(rows::ranged(
                                code.to_string(),
                                ranges.into_iter().map(|r| (r, style)),
                            )),
                    )
                    .child(
                        div()
                            .flex_none()
                            .pl(px(4.))
                            .whitespace_nowrap()
                            .text_color(look::TEXT_DIM)
                            .when(repeated && !selected, |d| d.opacity(0.5))
                            .child(SharedString::from(location(m))),
                    );
                Some(
                    // no hover look: WS removes it from the results table
                    rows::row(
                        ("find-row", row),
                        px(look::LIST_ROW_HEIGHT.get()),
                        selected,
                        false,
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            let Some(Popup::Find(f)) = &mut this.popup else {
                                return;
                            };
                            {
                                let h = f.field.read(cx).focus_handle(cx);
                                window.focus(&h, cx)
                            };
                            if ev.click_count >= 2 && f.list.cursor() == Some(row) {
                                let action = f.confirm(Some(row), "edit");
                                this.apply(action, window, cx);
                            } else {
                                f.list.set_cursor(Some(row));
                                f.preview_scroll = 0.;
                                this.prefetch_preview(cx);
                                cx.notify();
                            }
                        }),
                    )
                    .child(content)
                    .into_any_element(),
                )
            })
            .collect()
    }
}

/// A 22 px icon toggle (Cc / W / .*, the filter): Blue3 when on, the hover bg when off.
fn toggle_button(
    id: impl Into<gpui_kit::ElementId>,
    selector: String,
    icon: IconName,
    on: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .debug_selector(move || selector)
        .size(px(TOGGLE))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .cursor_pointer()
        .when(on, |d| d.bg(TOGGLE_ON_BG))
        .when(!on, |d| d.hover(|d| d.bg(look::HOVER_BG)))
        .child(Icon::new(icon))
}

/// "file.ts 12" (the row's right column).
fn location(m: &GrepMatch) -> String {
    let (_, name) = split_path(&m.path);
    format!("{name} {}", m.line)
}

/// The code without its indent (rows start with the code), ranges moved along.
fn trimmed(m: &GrepMatch) -> (&str, Vec<Range<usize>>) {
    let lead = m.text.len() - m.text.trim_start().len();
    let code = m.text[lead..].trim_end();
    let ranges = m
        .ranges
        .iter()
        .filter(|r| r.end > lead)
        .map(|r| r.start.saturating_sub(lead)..(r.end - lead).min(code.len()))
        .filter(|r| r.start < r.end)
        .collect();
    (code, ranges)
}
