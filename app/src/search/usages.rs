//! The usages popup at the caret: Show Usages (`grr`, Cmd+B on a declaration) and Choose
//! Declaration / Implementation / Type Declaration. Lua (`config/usages.lua`) runs the LSP
//! request and sends the rows (syntax colors resolved); a pick goes back to it (`usage_pick`).
//!
//! Look: WebStorm's `ShowUsagesTable` / `ShowUsagesHeader`: a complex header (bold title, the
//! count grayed on the right) over a separator, rows "file icon, file name, line number, the code
//! line (the usage-type icon column first, the usage bold, syntax colored in the UI font; the
//! caret's usage tagged "Current")", files outside the project on the yellow file color, columns
//! sized to their content, at most 30 rows. No north toolbar / scope advertiser (no scopes here).
//! Keys: a list (arrows, Ctrl-n / Ctrl-p, Enter, Esc; every letter searches, also the file column).

use std::ops::Range;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, Bounds, Context, FontStyle, FontWeight, HighlightStyle, InteractiveElement as _,
    IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, Window, div, font, prelude::FluentBuilder as _,
    px, size, uniform_list,
};
use rmpv::Value;
use serde::Deserialize;

use super::rows::{self, split_path};
use super::{Action, PickerState, PickersView, Popup};
use crate::kit::Anchor;
use crate::kit::{self, Icon};
use crate::kit::{ListOptions, ListOutcome, ListSource, ListState};
use crate::look;
use crate::render::UI_FONT;

/// Rows shown at most (`ShowUsagesAction` max visible rows 30).
const MAX_ROWS: usize = 30;
/// Column clamps (`ShowUsagesTable` sizes columns to content within 200..500 px; the file
/// column here only to its content).
const MAX_FILE_COL: f32 = 300.;
const MAX_CODE_COL: f32 = 700.;
const COL_GAP: f32 = 12.;
/// USAGE_TEXT_COL starts with the usage-type icon (16, empty if none) + 5 (`appendTextPadding`).
const USAGE_ICON_LEAD: f32 = 16. + 5.;
/// The "Current" tag: List.Tag (bg #393B40, fg #868A91), medium 12 px, 6 after the text.
const TAG_BG: u32 = 0x393B40;
const TAG_FG: u32 = 0x868A91;
const TAG_GAP: f32 = 6.;
const TAG_PAD_X: f32 = 6.;
const TAG_H: f32 = 16.;
const TAG_ARC: f32 = 4.;
/// Room the tag takes at the end of the code column.
const TAG_ROOM: f32 = 60.;

/// A row from Lua (`config/usages.lua` `show`).
#[derive(Clone, Debug, Deserialize)]
pub struct UsageItem {
    /// The code line, trimmed.
    pub text: String,
    /// "file.tsx 42" (the file name: the shortest unambiguous path).
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub file: String,
    /// (start byte, end byte, rgb, bold, italic, is the usage)
    #[serde(default)]
    pub spans: Vec<(usize, usize, u32, bool, bool, bool)>,
    /// Byte where the usage starts (kept visible when a long line is cut).
    #[serde(default)]
    pub focus: Option<usize>,
    /// The usage the caret is on ("Current" tag).
    #[serde(default)]
    pub current: bool,
}

impl UsageItem {
    /// (file column, line number) from `key` ("Password/index.tsx 42").
    fn file_line(&self) -> (&str, &str) {
        match self.key.rsplit_once(' ') {
            Some((f, l)) if l.chars().all(|c| c.is_ascii_digit()) => (f, l),
            _ => (self.key.as_str(), ""),
        }
    }
}

struct Items<'a>(&'a [UsageItem]);

impl ListSource for Items<'_> {
    fn len(&self) -> usize {
        self.0.len()
    }
    /// The speed search matches the code and the file column (today's `match_key`).
    fn text(&self, ix: usize) -> SharedString {
        let it = &self.0[ix];
        format!("{} {}", it.text, it.key).into()
    }
}

pub struct UsagesPopup {
    token: i64,
    project: PathBuf,
    title: String,
    right: String,
    items: Vec<UsageItem>,
    caret: Option<Bounds<Pixels>>,
    list: ListState,
    /// Measured column widths (file, line, code), from the first render.
    cols: Option<(f32, f32, f32)>,
    /// The editor font's char advance (code cells), for cutting long lines.
    char_w: f32,
}

impl UsagesPopup {
    pub fn new(
        token: i64,
        project: PathBuf,
        title: String,
        right: String,
        items: Vec<UsageItem>,
        caret: Option<Bounds<Pixels>>,
    ) -> Self {
        let mut list = ListState::new();
        list.refresh(&Items(&items));
        list.set_cursor((!items.is_empty()).then_some(0));
        UsagesPopup {
            token,
            project,
            title,
            right,
            items,
            caret,
            list,
            cols: None,
            char_w: 7.8,
        }
    }

    fn options() -> ListOptions {
        ListOptions::menu()
    }

    pub fn key(&mut self, key: &str, typed: Option<&str>) -> Action {
        let out = self
            .list
            .key(key, typed, &Items(&self.items), &Self::options());
        match out {
            // a dropdown: no Vim layer
            ListOutcome::Ignored | ListOutcome::Vim(_) => Action::Ignored,
            ListOutcome::Changed => Action::Handled,
            ListOutcome::Confirm(ix) => self.pick(ix),
            ListOutcome::Cancel => Action::Close,
        }
    }

    fn pick(&self, ix: usize) -> Action {
        Action::Lua {
            func: "usage_pick",
            args: vec![Value::from(self.token), Value::from(ix as i64 + 1)],
        }
    }

    pub fn state(&self) -> PickerState {
        let shown: Vec<usize> = (0..self.list.row_count())
            .filter_map(|r| self.list.item_at(r))
            .collect();
        PickerState {
            kind: "usages".into(),
            query: self.list.query().unwrap_or_default().to_string(),
            rows: shown
                .iter()
                .map(|&i| {
                    let it = &self.items[i];
                    // the tag shows after the code
                    if it.current {
                        format!("{} {CURRENT}", it.text)
                    } else {
                        it.text.clone()
                    }
                })
                .collect(),
            details: shown.iter().map(|&i| self.items[i].key.clone()).collect(),
            cursor: self.list.cursor(),
            settled: true,
            preview: false,
            title: self.title.clone(),
            right: self.right.clone(),
            ..Default::default()
        }
    }

    /// Column widths from the text (all in the UI font, like WS's table).
    fn measure(&mut self, window: &mut Window) -> (f32, f32, f32) {
        if let Some(c) = self.cols {
            return c;
        }
        let width = |text: &str, family: &'static str, window: &mut Window| -> f32 {
            crate::kit::width(window, text, font(family), px(13.)).as_f32()
        };
        let (mut f, mut l, mut c) = (0f32, 0f32, 0f32);
        for it in &self.items {
            let (file, line) = it.file_line();
            f = f.max(width(file, UI_FONT.name(), window));
            l = l.max(width(line, UI_FONT.name(), window));
            c = c.max(width(&it.text, UI_FONT.name(), window));
        }
        let tag = if self.items.iter().any(|it| it.current) {
            TAG_ROOM
        } else {
            0.
        };
        let cols = (
            f.ceil().min(MAX_FILE_COL) + look::ICON_SIZE + 6.,
            l.ceil(),
            c.ceil().min(MAX_CODE_COL) + 2. + USAGE_ICON_LEAD + tag,
        );
        self.cols = Some(cols);
        // average advance of code text in the UI font (cutting long lines)
        self.char_w = (width("abcdefghij", UI_FONT.name(), window) / 10.).max(1.);
        cols
    }

    pub fn render(
        &mut self,
        viewport: Size<Pixels>,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        let (fc, lc, cc) = self.measure(window);
        let margin = look::POPUP_WINDOW_MARGIN;
        let pad = look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X;
        let content_w = fc + COL_GAP + lc + COL_GAP + cc + 2. * pad;
        let header_w = 40. + self.title.len() as f32 * 7.5 + self.right.len() as f32 * 7.;
        let width = content_w
            .max(header_w)
            .max(300.)
            .min(viewport.width.as_f32() - 2. * margin);
        let rows_n = self.list.row_count();
        let searching = self.list.searching();
        let shown = rows_n.clamp(1, MAX_ROWS);
        let row_h = look::LIST_ROW_HEIGHT;
        let list_h = shown as f32 * row_h;
        let header_h = look::COMPLEX_HEADER_HEIGHT;
        let search_h = if searching { row_h.get() } else { 0. };
        let height = header_h + 1. + search_h + list_h + 2. * look::POPUP_PADDING_Y / 2.;
        let s = size(px(width), px(height));
        let origin = match self.caret {
            Some(c) => kit::place(Anchor::Below(c), s, viewport),
            None => kit::place(
                Anchor::Point(gpui_kit::point(
                    (viewport.width - s.width) / 2.,
                    viewport.height / 4.,
                )),
                s,
                viewport,
            ),
        };
        self.list.set_page_rows(shown.saturating_sub(1).max(1));
        let header = kit::complex_header(
            SharedString::from(self.title.clone()),
            Some(
                rows::dim(self.right.clone())
                    .font_weight(FontWeight::NORMAL)
                    .into_any_element(),
            ),
        )
        .debug_selector(|| "usages-header".into());
        let search = self.list.query().map(|q| {
            let count = self.list.match_count().unwrap_or(0);
            div()
                .h(px(row_h.get()))
                .flex_none()
                .px(px(pad))
                .flex()
                .items_center()
                .gap(px(6.))
                .child(Icon::new(kit::IconName::Search))
                .child(div().flex_1().child(SharedString::from(q.to_string())))
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
        let list = uniform_list(
            "usage-rows",
            rows_n,
            cx.processor(|this: &mut PickersView, range: Range<usize>, _window, cx| {
                match &this.popup {
                    Some(Popup::Usages(u)) => u.render_rows(range, cx),
                    _ => Vec::new(),
                }
            }),
        )
        .track_scroll(self.list.scroll_handle())
        .size_full();
        kit::popup_frame()
            .id("usages")
            .debug_selector(|| "usages".into())
            .absolute()
            .left(origin.x)
            .top(origin.y)
            .w(px(width))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.close(window, cx);
            }))
            .child(header)
            .child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            .children(search)
            .child(
                div()
                    .h(px(list_h + look::POPUP_PADDING_Y))
                    .flex_none()
                    .pt(px(look::POPUP_PADDING_Y / 2.))
                    .pb(px(look::POPUP_PADDING_Y / 2.))
                    .child(list),
            )
            .into_any_element()
    }

    fn render_rows(&self, range: Range<usize>, cx: &mut Context<PickersView>) -> Vec<AnyElement> {
        let (fc, lc, cc) = self.cols.unwrap_or((150., 30., 300.));
        let tag_room = if self.items.iter().any(|it| it.current) {
            TAG_ROOM
        } else {
            0.
        };
        let visible = ((cc - 2. - USAGE_ICON_LEAD - tag_room) / self.char_w)
            .floor()
            .max(8.) as usize;
        range
            .filter_map(|row| {
                let ix = self.list.item_at(row)?;
                let it = self.items.get(ix)?;
                let (file, line) = it.file_line();
                let (_, name) = split_path(&it.file);
                let selected = self.list.cursor() == Some(ix);
                let (text, cut) = clip_to_usage(it, visible);
                let spans = it
                    .spans
                    .iter()
                    .filter_map(move |&(s, e, rgb, bold, italic, usage)| {
                        // moved with the cut start ("…" in front)
                        let (s, e) = match cut {
                            Some(start) => {
                                if e <= start {
                                    return None;
                                }
                                let lead = ELLIPSIS.len();
                                (s.max(start) - start + lead, e - start + lead)
                            }
                            None => (s, e),
                        };
                        let style = HighlightStyle {
                            color: (!usage).then(|| look::hsla(rows::color(rgb))),
                            font_weight: (bold || usage).then_some(FontWeight::BOLD),
                            font_style: italic.then_some(FontStyle::Italic),
                            ..Default::default()
                        };
                        Some((s..e, style))
                    });
                let content = rows::row_content()
                    .gap(px(COL_GAP))
                    .child(
                        div()
                            .w(px(fc))
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .overflow_hidden()
                            .child(Icon::new(kit::for_file(name)))
                            .child(
                                div()
                                    .min_w_0()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .overflow_hidden()
                                    .child(SharedString::from(file.to_string())),
                            ),
                    )
                    .child(
                        div()
                            .w(px(lc))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(line.to_string())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pl(px(USAGE_ICON_LEAD))
                            .flex()
                            .items_center()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .child(rows::ranged(text, spans)),
                            )
                            .when(it.current, |d| d.child(current_tag())),
                    );
                let file = Path::new(&it.file);
                let outside = file.is_absolute() && !file.starts_with(&self.project);
                Some(
                    rows::row_tinted(
                        ("usage-row", ix),
                        px(look::LIST_ROW_HEIGHT.get()),
                        selected,
                        false,
                        outside.then_some(look::EXCLUDED_ROW_BG.rgba()),
                    )
                    .on_hover(cx.listener(move |this, h: &bool, _, cx| {
                        // popup lists: the mouse selects (menu.lua / WebStorm)
                        if *h
                            && let Some(Popup::Usages(u)) = &mut this.popup
                            && u.list.cursor() != Some(ix)
                        {
                            u.list.set_cursor(Some(ix));
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            let Some(Popup::Usages(u)) = &this.popup else {
                                return;
                            };
                            let action = u.pick(ix);
                            this.apply(action, window, cx);
                        }),
                    )
                    .child(content)
                    .into_any_element(),
                )
            })
            .collect()
    }
}

const ELLIPSIS: &str = "\u{2026}";
/// `show.usages.current.usage.label`.
const CURRENT: &str = "Current";

/// The "Current" tag after the caret's usage.
fn current_tag() -> impl IntoElement {
    div()
        .flex_none()
        .ml(px(TAG_GAP))
        .h(px(TAG_H))
        .px(px(TAG_PAD_X))
        .flex()
        .items_center()
        .rounded(px(TAG_ARC))
        .bg(look::hex(TAG_BG))
        .text_color(look::hex(TAG_FG))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .font_weight(FontWeight::MEDIUM)
        .child(CURRENT)
}

/// A code line too long for its column with the usage past the end: its start cut ("…" in front)
/// so the usage shows, like the Lua popup. Returns the text and the byte where the cut starts.
fn clip_to_usage(it: &UsageItem, visible: usize) -> (String, Option<usize>) {
    let usage_end = it
        .spans
        .iter()
        .find(|s| s.5)
        .map(|s| s.1)
        .or(it.focus)
        .unwrap_or(0)
        .min(it.text.len());
    let end_chars = it.text[..usage_end].chars().count();
    if it.text.chars().count() <= visible || end_chars + 2 <= visible {
        return (it.text.clone(), None);
    }
    // keep a few chars after the usage, the rest before it
    let skip = (end_chars + 4).saturating_sub(visible).max(1);
    let start = it
        .text
        .char_indices()
        .nth(skip)
        .map_or(it.text.len(), |(i, _)| i);
    (format!("{ELLIPSIS}{}", &it.text[start..]), Some(start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_lines_keep_the_usage_in_view() {
        let text = format!("{}usage()", "x".repeat(100));
        let it = UsageItem {
            text: text.clone(),
            key: "a.ts 1".into(),
            file: "a.ts".into(),
            spans: vec![(100, 105, 0, false, false, true)],
            focus: Some(100),
            current: false,
        };
        let (shown, cut) = clip_to_usage(&it, 40);
        assert!(
            shown.starts_with(ELLIPSIS) && shown.contains("usage()"),
            "{shown}"
        );
        assert!(shown.chars().count() <= 41);
        assert!(cut.is_some());
        // short lines / an early usage: untouched
        let short = UsageItem {
            text: "a usage".into(),
            spans: vec![(2, 7, 0, false, false, true)],
            ..it
        };
        assert_eq!(clip_to_usage(&short, 40), ("a usage".to_string(), None));
    }
}
