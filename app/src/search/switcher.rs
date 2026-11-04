//! The Ctrl+Tab switcher: tool windows on the left, recent files on the right, the selected file's
//! path at the bottom. Hold Ctrl: Tab / Ctrl+Tab move down, Shift+Tab up; releasing Ctrl opens the
//! selection (the app sees the release itself). Arrows, l / ö / k / ä, Ctrl+N / P, Enter, a click
//! work too; Esc / q close. Lua (`config/switcher.lua`) gives the rows and opens the pick
//! (`switcher_pick`).
//!
//! Recent Files is the same popup in its recent mode (WS `SwitcherFE` with `onlyEditedFiles`):
//! titled "Recent Files", the "Show edited only" checkbox (⌘E toggles it) on the right of the
//! header, no tool window mnemonics, the files of the project's history; `/` starts the speed
//! search (typing filters the files).
//!
//! Look: WebStorm's `Switcher` (`SwitcherRenderingFE`): a complex header (bold title), the tool
//! window column (mnemonic grayed, icon, name) with a 1 px separator, the files column (icon, the
//! name in its git status color, red wave under files with errors, the folder grayed after it),
//! the path label at the bottom (trimmed at its start). At least 500 x 350
//! (`JBUI.DialogSizes.medium`), centred in the window.

use gpui_kit::Context;
use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, SharedString, Size, StatefulInteractiveElement as _, Styled as _,
    Window, div, prelude::FluentBuilder as _, px,
};
use nucleo_matcher::{Config, Matcher};
use rmpv::Value;
use serde::Deserialize;

use super::rows::{self, split_path};
use super::{Action, PickerState, PickersView, Popup};
use crate::kit::{self, Icon, IconName};
use crate::kit::{CheckState, Checkbox};
use crate::look;
use crate::shell::ColumnMode;

/// Lists' padding (`JBUI.Borders.empty(5, 0)`) and row padding (0,10).
const LIST_PAD_Y: f32 = 5.;
const ROW_PAD_X: f32 = 10.;
/// Tool window column width.
const TOOLS_W: f32 = 190.;
/// Files column minimum (`Switcher` files list min 250).
const FILES_MIN_W: f32 = 250.;
/// `JBUI.DialogSizes.medium()`: the popup's minimum size.
const MIN_W: f32 = 500.;
const MIN_H: f32 = 350.;
const MAX_ROWS: usize = 25;
/// Mnemonic column: width("W") + `ActionsList.mnemonic.icon.gap` 4; icon -> text
/// `ActionsList.icon.gap` 6 (tool windows), files `iconTextGap` 4.
const MNEMONIC_W: f32 = 12.;
const MNEMONIC_GAP: f32 = 4.;
const TOOL_ICON_GAP: f32 = 6.;
const FILE_ICON_GAP: f32 = 4.;

#[derive(Clone, Debug, Deserialize)]
pub struct SwitchFile {
    pub name: String,
    /// `~/` or project-relative.
    #[serde(default)]
    pub path: String,
    /// Unsaved changes (no marker drawn: WS shows none; kept for the edited-only filter).
    #[serde(default)]
    pub modified: bool,
    /// Git file status ("Modified", "Unversioned"...; "" unchanged): the name's color.
    #[serde(default)]
    pub status: String,
    /// Errors in the file: a red wave under the name.
    #[serde(default)]
    pub error: bool,
    /// Changed in the editor this session (Recent Files' "Show edited only").
    #[serde(default)]
    pub edited: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SwitchTool {
    pub name: String,
    /// Shortcut ("⌘1").
    #[serde(default)]
    pub key: String,
    /// "project" / "chat" / "vcs" / "terminal" / "sessions" / "boxes" / "pipelines".
    #[serde(default)]
    pub icon: String,
    /// The Chat column's mode the app shows with the keyboard ("chat"), not Lua.
    #[serde(default)]
    pub column: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Col {
    Tools,
    Files,
}

/// How a switcher opens.
#[derive(Clone, Copy, Debug, Default)]
pub struct Mode {
    /// Ctrl+Shift+Tab: starts at the bottom.
    pub back: bool,
    /// Releasing Ctrl opens the selection.
    pub wait: bool,
    /// The current file is the first row: start on the second.
    pub current_on_top: bool,
    /// Recent Files.
    pub recent: bool,
    /// Recent Files: "Show edited only" checked.
    pub edited_only: bool,
}

pub struct SwitcherPopup {
    token: i64,
    files: Vec<SwitchFile>,
    tools: Vec<SwitchTool>,
    col: Col,
    /// Selected row of the column (files: a row of `shown`).
    sel: usize,
    /// Releasing Ctrl opens the selection.
    pub wait: bool,
    /// Ctrl is up; the selection opens once nvim answers `switcher_sync`.
    pub release_pending: bool,
    /// Recent Files mode.
    pub recent: bool,
    edited_only: bool,
    /// Speed search text (after `/`, recent mode).
    search: Option<String>,
    /// Files shown (indices into `files`) and their matched chars.
    shown: Vec<(usize, Vec<u32>)>,
    /// First files row shown (more than [`MAX_ROWS`] files scroll).
    top: usize,
    /// The row under the mouse (WS adds a hover listener to both lists).
    hovered: Option<(Col, usize)>,
}

impl SwitcherPopup {
    pub fn new(token: i64, files: Vec<SwitchFile>, tools: Vec<SwitchTool>, mode: Mode) -> Self {
        let mut sw = SwitcherPopup {
            token,
            files,
            tools,
            col: Col::Files,
            sel: 0,
            wait: mode.wait,
            release_pending: false,
            recent: mode.recent,
            edited_only: mode.recent && mode.edited_only,
            search: None,
            shown: Vec::new(),
            top: 0,
            hovered: None,
        };
        sw.refilter();
        if sw.shown.is_empty() {
            sw.col = Col::Tools;
        }
        let n = sw.shown.len();
        // the previous file when the current one is on top (from a tool window: the last file)
        if mode.current_on_top && n > 1 {
            sw.sel = 1;
        }
        if mode.back && n > 0 {
            sw.sel = n - 1;
        }
        sw.reveal();
        sw
    }

    /// The Lua popup this is (its token: a pick names it).
    pub fn token(&self) -> i64 {
        self.token
    }

    /// Lua opened it again (Ctrl+Tab before the switcher had the keyboard): its rows and token,
    /// the selection kept.
    pub fn replace(&mut self, token: i64, files: Vec<SwitchFile>, tools: Vec<SwitchTool>) {
        self.token = token;
        self.files = files;
        self.tools = tools;
        self.refilter();
        if self.col == Col::Files && self.shown.is_empty() {
            self.col = Col::Tools;
        }
        self.sel = self.sel.min(self.len().saturating_sub(1));
        self.reveal();
    }

    /// The files shown: "Show edited only" and the speed search applied (the list's order kept,
    /// WS `FilteringListModel`).
    fn refilter(&mut self) {
        let pool: Vec<usize> = (0..self.files.len())
            .filter(|&i| !self.edited_only || self.files[i].edited || self.files[i].modified)
            .collect();
        self.shown = match self.search.as_deref().filter(|q| !q.is_empty()) {
            None => pool.into_iter().map(|i| (i, Vec::new())).collect(),
            Some(q) => {
                let names: Vec<&str> = pool.iter().map(|&i| self.files[i].name.as_str()).collect();
                let mut m = Matcher::new(Config::DEFAULT);
                let mut hits: Vec<(usize, Vec<u32>)> = super::rank::rank_plain(q, &names, &mut m)
                    .into_iter()
                    .map(|(ix, _, chars)| (pool[ix], chars))
                    .collect();
                hits.sort_by_key(|(i, _)| *i);
                hits
            }
        };
        self.top = 0;
    }

    /// Scrolls the files column so the selection shows.
    fn reveal(&mut self) {
        if self.col != Col::Files {
            return;
        }
        if self.sel < self.top {
            self.top = self.sel;
        } else if self.sel >= self.top + MAX_ROWS {
            self.top = self.sel + 1 - MAX_ROWS;
        }
    }

    fn len(&self) -> usize {
        match self.col {
            Col::Tools => self.tools.len(),
            Col::Files => self.shown.len(),
        }
    }

    /// Moves the selection `by` rows in its column (wrapping).
    pub fn step(&mut self, by: isize) {
        let n = self.len() as isize;
        if n > 0 {
            self.sel = (self.sel as isize + by).rem_euclid(n) as usize;
        }
        self.reveal();
    }

    fn column(&mut self, col: Col) {
        if self.col == col || (col == Col::Files && self.shown.is_empty()) {
            return;
        }
        self.col = col;
        self.sel = self.sel.min(self.len().saturating_sub(1));
        if col == Col::Files {
            self.sel = self.sel.max(self.top).min(self.len().saturating_sub(1));
        }
        self.reveal();
    }

    /// The files changed (filter, search): the first one selected.
    fn refreshed(&mut self) {
        if self.shown.is_empty() {
            if self.search.is_none() {
                self.col = Col::Tools;
            }
            self.sel = 0;
        } else {
            self.col = Col::Files;
            self.sel = 0;
        }
        self.reveal();
    }

    /// "Show edited only" (the checkbox, ⌘E).
    fn toggle_edited(&mut self) {
        self.edited_only = !self.edited_only;
        self.refilter();
        self.refreshed();
    }

    pub fn key(&mut self, key: &str, typed: Option<&str>) -> Action {
        if self.recent {
            if let Some(q) = &mut self.search {
                match key {
                    "<Esc>" => self.search = None,
                    "<BS>" => {
                        if q.pop().is_none() {
                            self.search = None;
                        }
                    }
                    "<CR>" => return self.confirm(),
                    "<Down>" | "<C-n>" | "<Tab>" => self.step(1),
                    "<Up>" | "<C-p>" | "<S-Tab>" => self.step(-1),
                    "<Left>" => self.column(Col::Tools),
                    "<Right>" => self.column(Col::Files),
                    "<D-e>" => {
                        self.toggle_edited();
                        return Action::Handled;
                    }
                    _ => match typed {
                        Some(t) if !t.is_empty() => q.push_str(t),
                        _ => return Action::Ignored,
                    },
                }
                self.refilter();
                self.refreshed();
                return Action::Handled;
            }
            match (key, typed) {
                (_, Some("/")) => {
                    self.search = Some(String::new());
                    return Action::Handled;
                }
                ("<D-e>", _) => {
                    self.toggle_edited();
                    return Action::Handled;
                }
                _ => {}
            }
        }
        // (Ctrl still held from Ctrl+Tab: arrows / Enter arrive as <C-…>)
        match key {
            "<C-Tab>" | "<Tab>" | "<Down>" | "<C-Down>" | "ö" | "<C-n>" => self.step(1),
            "<C-S-Tab>" | "<S-Tab>" | "<Up>" | "<C-Up>" | "l" | "<C-p>" => self.step(-1),
            "<Left>" | "<C-Left>" | "k" => self.column(Col::Tools),
            "<Right>" | "<C-Right>" | "ä" => self.column(Col::Files),
            "<CR>" | "<C-CR>" => return self.confirm(),
            "<Esc>" | "q" => return Action::Close,
            _ => return Action::Ignored,
        }
        Action::Handled
    }

    /// Opens the selection (Lua does it: tool windows and files are its).
    pub fn confirm(&self) -> Action {
        let item = match self.col {
            Col::Tools => (self.sel < self.tools.len()).then_some(self.sel),
            Col::Files => self.shown.get(self.sel).map(|(i, _)| *i),
        };
        let Some(item) = item else {
            return Action::Close;
        };
        if self.col == Col::Tools
            && let Some(mode) = self.tools[item].column.as_deref().and_then(column_mode)
        {
            return Action::Column(mode);
        }
        let col = match self.col {
            Col::Tools => "tools",
            Col::Files => "files",
        };
        Action::Lua {
            func: "switcher_pick",
            args: vec![
                Value::from(col),
                Value::from(item as i64 + 1),
                Value::from(self.token),
            ],
        }
    }

    pub fn state(&self) -> PickerState {
        let files = || self.shown.iter().map(|(i, _)| &self.files[*i]);
        PickerState {
            kind: if self.recent { "recent" } else { "switcher" }.into(),
            query: self.search.clone().unwrap_or_default(),
            rows: files().map(|f| f.name.clone()).collect(),
            details: self.tools.iter().map(|t| t.name.clone()).collect(),
            cursor: Some(self.sel),
            settled: true,
            preview: false,
            title: match self.col {
                Col::Tools => "tools".into(),
                Col::Files => "files".into(),
            },
            statuses: files().map(|f| f.status.clone()).collect(),
            checked: self.edited_only,
            ..Default::default()
        }
    }

    fn footer(&self) -> String {
        match self.col {
            Col::Tools => self.tools.get(self.sel).map(|t| t.name.clone()),
            Col::Files => self
                .shown
                .get(self.sel)
                .map(|(i, _)| self.files[*i].path.clone()),
        }
        .unwrap_or_default()
    }

    pub fn render(
        &mut self,
        viewport: Size<Pixels>,
        _window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        let margin = look::POPUP_WINDOW_MARGIN;
        let row_h = look::LIST_ROW_HEIGHT;
        let longest = self
            .files
            .iter()
            .map(|f| f.name.chars().count() + split_path(&f.path).0.chars().count() / 2)
            .max()
            .unwrap_or(0);
        let files_w =
            (longest as f32 * 7.5 + 2. * ROW_PAD_X + 16. + FILE_ICON_GAP + 40.).max(FILES_MIN_W);
        let vw = viewport.width.as_f32();
        let vh = viewport.height.as_f32();
        let width = (TOOLS_W + 1. + files_w).max(MIN_W).min(vw - 2. * margin);
        let search_h = if self.search.is_some() {
            row_h.get()
        } else {
            0.
        };
        let n = self.tools.len().max(self.shown.len()).clamp(1, MAX_ROWS);
        let fixed = look::COMPLEX_HEADER_HEIGHT + 1. + search_h + look::POPUP_AD_HEIGHT;
        let list_h = (n as f32 * row_h + 2. * LIST_PAD_Y).max(MIN_H - fixed);
        let height = (fixed + list_h).min(vh - 2. * margin);
        // WS showCenteredInCurrentWindow
        let x = kit::centered(width, vw);
        let y = kit::centered(height, vh);

        let tools = self
            .tools
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let selected = self.col == Col::Tools && self.sel == i;
                let icon = match t.icon.as_str() {
                    "project" => IconName::ToolWindowProject,
                    "terminal" => IconName::ToolWindowTerminal,
                    "chat" => IconName::Chat,
                    "sessions" => IconName::History,
                    "boxes" => IconName::Archive,
                    "pipelines" => IconName::ToolWindowRun,
                    _ => IconName::ToolWindowVcs,
                };
                // no mnemonics in Recent Files (its typing searches)
                let mnemonic = (!self.recent).then(|| {
                    div()
                        .w(px(MNEMONIC_W))
                        .mr(px(MNEMONIC_GAP))
                        .flex_none()
                        .text_color(rows::dim_fg(selected))
                        .child(SharedString::from(
                            t.key.trim_start_matches('⌘').to_string(),
                        ))
                });
                self.row(Col::Tools, i, selected, cx)
                    .child(
                        rows::row_content()
                            .px(px(look::LIST_ROW_INSET_X + ROW_PAD_X))
                            .children(mnemonic)
                            .child(Icon::new(icon))
                            .child(
                                div()
                                    .flex_1()
                                    .ml(px(TOOL_ICON_GAP))
                                    .whitespace_nowrap()
                                    .child(SharedString::from(t.name.clone())),
                            ),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        let files = self
            .shown
            .iter()
            .enumerate()
            .skip(self.top)
            .take(MAX_ROWS)
            .map(|(row, (i, matches))| {
                let f = &self.files[*i];
                let selected = self.col == Col::Files && self.sel == row;
                let (dir, _) = split_path(&f.path);
                let color =
                    (!f.status.is_empty()).then(|| crate::editor::tabs::status_color(&f.status));
                self.row(Col::Files, row, selected, cx)
                    .child(
                        rows::row_content()
                            .px(px(look::LIST_ROW_INSET_X + ROW_PAD_X))
                            .gap(px(FILE_ICON_GAP))
                            .child(Icon::new(kit::for_file(&f.name)))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .child(
                                        div()
                                            .flex_none()
                                            .when_some(color, |d, c| d.text_color(c))
                                            .when(f.error, |d| {
                                                d.text_decoration_1()
                                                    .text_decoration_wavy()
                                                    .text_decoration_color(
                                                        look::TAB_ERROR_UNDERLINE,
                                                    )
                                            })
                                            .child(rows::matched(f.name.clone(), matches)),
                                    )
                                    // WS: `" " + pathText` GRAYED, cut to fit
                                    .when(!dir.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .text_ellipsis()
                                                .text_color(rows::dim_fg(selected))
                                                .child(SharedString::from(format!(" {dir}"))),
                                        )
                                    }),
                            ),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        let title = if self.recent {
            "Recent Files"
        } else {
            "Switcher"
        };
        let header = kit::complex_header(title, self.recent.then(|| self.header_right(cx)));
        let search = self.search.as_ref().map(|q| {
            let count = self.shown.len();
            div()
                .debug_selector(|| "switcher-search".into())
                .h(px(row_h.get()))
                .flex_none()
                .px(px(look::LIST_ROW_INSET_X + ROW_PAD_X))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(Icon::new(IconName::Search))
                .child(div().flex_1().child(SharedString::from(q.clone())))
                .child(
                    div()
                        .text_color(if count == 0 {
                            look::SPEED_SEARCH_ERROR_FG
                        } else {
                            look::TEXT_DIM
                        })
                        .child(SharedString::from(match count {
                            0 => "No matches".to_string(),
                            1 => "1 match".to_string(),
                            n => format!("{n} matches"),
                        })),
                )
        });
        let body = div()
            .h(px(height - fixed))
            .flex_none()
            .flex()
            .child(
                div()
                    .w(px(TOOLS_W))
                    .flex_none()
                    .py(px(LIST_PAD_Y))
                    .flex()
                    .flex_col()
                    .children(tools),
            )
            .child(div().w(px(1.)).h_full().flex_none().bg(look::SEPARATOR))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .py(px(LIST_PAD_Y))
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .children(files),
            );
        let footer = kit::ad_text(self.footer())
            .text_ellipsis_start()
            .debug_selector(|| "switcher-path".into());
        kit::popup_frame()
            .id("switcher")
            .debug_selector(|| "switcher".into())
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(width))
            .h(px(height))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.close(window, cx);
            }))
            .child(header)
            .child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            .children(search)
            .child(body)
            .child(footer)
            .into_any_element()
    }

    /// Recent Files' header right: "Show edited only" and its shortcut (ContextHelp gray).
    fn header_right(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let entity = cx.entity().downgrade();
        let state = if self.edited_only {
            CheckState::Checked
        } else {
            CheckState::Unchecked
        };
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .font_weight(FontWeight::NORMAL)
            .child(
                div()
                    .debug_selector(|| "switcher-edited-only".into())
                    .child(
                        Checkbox::new("switcher-edited-only", state)
                            .label("Show edited only")
                            .on_toggle(move |_, _, cx| {
                                let _ = entity.update(cx, |this, cx| {
                                    if let Some(Popup::Switcher(s)) = &mut this.popup {
                                        s.toggle_edited();
                                    }
                                    cx.notify();
                                });
                            }),
                    ),
            )
            .child(div().text_color(look::TEXT_DIM).child("⌘E"))
            .into_any_element()
    }

    /// A row: a click selects and opens it (today's switcher); hover paints it.
    fn row(
        &self,
        col: Col,
        i: usize,
        selected: bool,
        cx: &mut Context<PickersView>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let id = match col {
            Col::Tools => "switcher-tool",
            Col::Files => "switcher-file",
        };
        let hovered = self.hovered == Some((col, i));
        rows::row((id, i), px(look::LIST_ROW_HEIGHT.get()), selected, hovered)
            .on_hover(cx.listener(move |this, h: &bool, _, cx| {
                if let Some(Popup::Switcher(s)) = &mut this.popup
                    && (*h || s.hovered == Some((col, i)))
                {
                    s.hovered = h.then_some((col, i));
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    let Some(Popup::Switcher(s)) = &mut this.popup else {
                        return;
                    };
                    s.col = col;
                    s.sel = i;
                    let action = s.confirm();
                    this.apply(action, window, cx);
                }),
            )
    }
}

/// A tool row's Chat column mode (`SwitchTool::column`).
fn column_mode(name: &str) -> Option<ColumnMode> {
    match name {
        "chat" => Some(ColumnMode::Chat),
        _ => None,
    }
}
