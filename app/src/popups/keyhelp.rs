//! `,?` key help (which-key's `show({ keys = "<leader>" })`): the `,` mappings with their
//! descriptions in columns at the bottom of the editor. Typing a key goes on with the sequence
//! (a group opens its keys, a mapping runs), Backspace goes back a level, Esc closes.

use std::collections::HashMap;

use gpui_kit::{
    AnyElement, Bounds, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, Pixels, SharedString, Styled as _, deferred, div, px,
};
use serde::Deserialize;

use super::PopupsView;
use crate::kit;
use crate::look;

/// `{ event = "key_help", leader, entries = { { keys, desc } }, groups = { { keys, desc } } }`;
/// `keys` after the leader in nvim notation ("fb", "<D-x>").
#[derive(Debug, Deserialize)]
pub(super) struct LuaKeyHelp {
    #[serde(default)]
    leader: Option<String>,
    #[serde(default)]
    entries: Vec<LuaKey>,
    #[serde(default)]
    groups: Vec<LuaKey>,
}

#[derive(Debug, Deserialize)]
struct LuaKey {
    keys: String,
    #[serde(default)]
    desc: Option<String>,
}

/// What a key did.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Stay,
    Close,
    /// Run the mapping: its keys after the leader.
    Run(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    key: String,
    desc: String,
    group: bool,
}

pub(super) struct KeyHelp {
    leader: String,
    entries: Vec<(Vec<String>, String)>,
    groups: HashMap<Vec<String>, String>,
    /// Keys typed so far (after the leader).
    prefix: Vec<String>,
}

/// Key tokens of a sequence: `<...>` names (case-insensitive) or single chars.
fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if c == '<'
            && let Some(end) = rest.find('>')
            && end > 1
        {
            out.push(normalize(&rest[..=end]));
            rest = &rest[end + 1..];
            continue;
        }
        out.push(c.to_string());
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// `<cr>` / `<CR>` alike; plain chars as they are.
fn normalize(token: &str) -> String {
    if token.len() > 2 && token.starts_with('<') {
        let inner = &token[1..token.len() - 1];
        let mut parts: Vec<String> = inner.split('-').map(str::to_owned).collect();
        let last = parts.len() - 1;
        for (i, p) in parts.iter_mut().enumerate() {
            // modifiers upper-case; a single-char key keeps its case (<D-x> vs <D-X>)
            if i < last || p.chars().count() > 1 {
                *p = p.to_uppercase();
            }
        }
        format!("<{}>", parts.join("-"))
    } else {
        token.to_string()
    }
}

/// which-key's alphanum order: letters / digits before specials, a before A before b.
fn sort_key(key: &str) -> (u8, String, bool) {
    let c = key.chars().next().unwrap_or(' ');
    let special = key.chars().count() > 1;
    (
        u8::from(special || !c.is_alphanumeric()),
        key.to_lowercase(),
        c.is_uppercase(),
    )
}

const COL_W: f32 = 230.;
const COL_GAP: f32 = 16.;
/// Rows a column takes before another column starts (which-key's height).
const ROWS_PER_COL: usize = 12;
/// From the editor's sides.
const MARGIN: f32 = 12.;
/// From the window's sides when the help is wider than the editor.
const WINDOW_MARGIN: f32 = 16.;
/// List popup body: the selection inset + its inner padding on each side.
const PAD_X: f32 = look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X;

/// How the help lays out its rows.
#[derive(Debug, PartialEq)]
struct Grid {
    cols: usize,
    per_col: usize,
    width: f32,
}

/// The frame's width for `cols` columns.
fn width_for(cols: usize) -> f32 {
    cols as f32 * COL_W + cols.saturating_sub(1) as f32 * COL_GAP + 2. * PAD_X
}

/// Columns of at most 12 rows; the editor's width when they fit in it, else as wide as they need up to
/// the window less 16 on each side, and when even that is too narrow, longer columns
/// (a column never runs past the frame).
fn grid(rows: usize, area_w: f32, window_w: f32) -> Grid {
    let fits = |w: f32| (((w - 2. * PAD_X + COL_GAP) / (COL_W + COL_GAP)).floor() as usize).max(1);
    let want = rows.div_ceil(ROWS_PER_COL).max(1);
    let editor_w = (area_w - 2. * MARGIN).max(width_for(1));
    if want <= fits(editor_w) {
        // the rows spread over every column the editor has room for
        let cols = fits(editor_w).min(rows.max(1));
        return Grid {
            cols,
            per_col: rows.div_ceil(cols).max(1),
            width: editor_w,
        };
    }
    let cols = want.min(fits(window_w - 2. * WINDOW_MARGIN).max(fits(editor_w)));
    Grid {
        cols,
        per_col: rows.div_ceil(cols).max(1),
        width: width_for(cols).max(editor_w),
    }
}

impl KeyHelp {
    pub(super) fn new(lua: LuaKeyHelp) -> Self {
        Self {
            leader: lua.leader.unwrap_or_else(|| ",".into()),
            entries: lua
                .entries
                .into_iter()
                .map(|e| (tokens(&e.keys), e.desc.unwrap_or_default()))
                .filter(|(t, _)| !t.is_empty())
                .collect(),
            groups: lua
                .groups
                .into_iter()
                .map(|g| (tokens(&g.keys), g.desc.unwrap_or_default()))
                .collect(),
            prefix: Vec::new(),
        }
    }

    /// The keys after the typed prefix, one row per next key.
    fn rows(&self) -> Vec<Row> {
        let n = self.prefix.len();
        let mut rows: Vec<Row> = Vec::new();
        for (keys, desc) in &self.entries {
            if keys.len() <= n || keys[..n] != self.prefix[..] {
                continue;
            }
            let key = &keys[n];
            let group = keys.len() > n + 1;
            match rows.iter_mut().find(|r| &r.key == key) {
                Some(r) => {
                    // a key with longer mappings under it is a group (which-key waits)
                    if group && !r.group {
                        r.group = true;
                    }
                    if !group && r.desc.is_empty() {
                        r.desc = desc.clone();
                    }
                }
                None => rows.push(Row {
                    key: key.clone(),
                    desc: if group { String::new() } else { desc.clone() },
                    group,
                }),
            }
        }
        for r in rows.iter_mut().filter(|r| r.group) {
            let mut path = self.prefix.clone();
            path.push(r.key.clone());
            let name = self.groups.get(&path).cloned().unwrap_or_else(|| {
                // no group name (which-key: "+N keymaps")
                let n = self
                    .entries
                    .iter()
                    .filter(|(k, _)| k.len() > path.len() && k[..path.len()] == path[..])
                    .count();
                format!("{n} keys")
            });
            r.desc = format!("+{name}");
        }
        rows.sort_by_key(|r| sort_key(&r.key));
        rows
    }

    pub(super) fn title(&self) -> String {
        format!("{}{}", self.leader, self.prefix.concat())
    }

    pub(super) fn rows_text(&self) -> Vec<(String, String)> {
        self.rows().into_iter().map(|r| (r.key, r.desc)).collect()
    }

    /// A key in nvim notation.
    pub(super) fn key(&mut self, key: &str) -> Step {
        match key {
            "<Esc>" | "<C-c>" => return Step::Close,
            "<BS>" => {
                return if self.prefix.pop().is_some() {
                    Step::Stay
                } else {
                    Step::Close
                };
            }
            _ => {}
        }
        let key = normalize(key);
        let Some(row) = self.rows().into_iter().find(|r| r.key == key) else {
            return Step::Close;
        };
        self.prefix.push(row.key);
        if row.group {
            Step::Stay
        } else {
            Step::Run(self.prefix.concat())
        }
    }

    /// Column-major grid in a frame along the bottom of `area` (the editor), widened past it
    /// (up to the window's width less 16 on each side) when its columns need more room.
    pub(super) fn render(
        &self,
        area: Bounds<Pixels>,
        window_w: Pixels,
        cx: &mut Context<PopupsView>,
    ) -> AnyElement {
        let rows = self.rows();
        let g = grid(rows.len(), area.size.width.as_f32(), window_w.as_f32());
        let (per_col, width) = (g.per_col, px(g.width));
        let pad_x = PAD_X;
        // centred on the editor, kept inside the window
        let left = (area.left().as_f32() + area.size.width.as_f32() / 2. - g.width / 2.)
            .min(window_w.as_f32() - WINDOW_MARGIN - g.width)
            .max(WINDOW_MARGIN.min(area.left().as_f32() + MARGIN));
        let columns = rows.chunks(per_col).map(|chunk| {
            div()
                .w(px(COL_W))
                .flex_none()
                .flex()
                .flex_col()
                .children(chunk.iter().map(|r| {
                    div()
                        .h(px(look::LIST_ROW_HEIGHT.get()))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .min_w(px(28.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(look::TEXT)
                                .child(SharedString::from(crate::kit::label(&r.key))),
                        )
                        .child(div().text_color(look::TEXT_DIM).child("→"))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(if r.group { look::LINK } else { look::TEXT })
                                .child(SharedString::from(r.desc.clone())),
                        )
                }))
        });
        let frame = kit::popup_frame()
            .id("key-help")
            .debug_selector(|| "key-help".into())
            .w(width)
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _: &MouseDownEvent, _, cx| cx.stop_propagation()),
            )
            .on_mouse_down_out(
                cx.listener(|this, _: &MouseDownEvent, window, cx| this.dismiss(window, cx)),
            )
            .child(
                kit::header(format!("Keys after {}", self.title()), None)
                    .debug_selector(|| "key-help-header".into()),
            )
            .child(
                // under a title the list body has no top inset (PopupUtil.getListInsets)
                div()
                    .px(px(pad_x))
                    .pb(px(look::POPUP_PADDING_Y))
                    .flex()
                    .gap(px(COL_GAP))
                    .children(columns),
            )
            // WebStorm hint popups put the keys in the advertiser
            .child(kit::ad_text("Esc close · ⌫ back").debug_selector(|| "key-help-ad".into()));
        let slot = div()
            .absolute()
            .left(px(left))
            .top(area.top())
            .w(width)
            .h(area.size.height - px(MARGIN))
            .flex()
            .flex_col()
            .justify_end()
            .child(frame);
        deferred(slot)
            .with_priority(super::PRIORITY)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 26 rows need three 12-row columns; a 650 px editor has room for two, so the help
    /// widens to three (centred, inside the window) instead of cutting the third off.
    #[test]
    fn the_grid_widens_past_a_narrow_editor_and_never_cuts_a_column() {
        let three = width_for(3);
        assert_eq!(
            grid(26, 650., 1400.),
            Grid {
                cols: 3,
                per_col: 9,
                width: three
            }
        );
        // the editor wide enough: its width, the rows over every column that fits
        let g = grid(26, 1200., 1400.);
        assert_eq!((g.cols, g.per_col, g.width), (4, 7, 1176.));
        // a window too narrow for three: two longer columns, never past the frame
        let g = grid(26, 500., 560.);
        assert_eq!((g.cols, g.per_col), (2, 13));
        assert!(width_for(g.cols) <= g.width);
        // every layout: the columns fit in the frame
        for (rows, area, win) in [(26, 650., 1400.), (40, 300., 1000.), (5, 900., 1000.)] {
            let g = grid(rows, area, win);
            assert!(
                width_for(g.cols) <= g.width + 0.5,
                "{rows} {area} {win}: {g:?}"
            );
            assert!(g.cols * g.per_col >= rows, "{g:?}");
        }
    }

    fn help() -> KeyHelp {
        let e = |k: &str, d: &str| LuaKey {
            keys: k.into(),
            desc: Some(d.into()),
        };
        KeyHelp::new(LuaKeyHelp {
            leader: Some(",".into()),
            entries: vec![
                e("fb", "Buffers"),
                e("fr", "Recent files"),
                e("w", "Close tab"),
                e("re", "Move/rename file"),
                e("?", "Show , shortcuts"),
                e("<D-x>", "cmd"),
                e("W", "Big w"),
            ],
            groups: vec![e("f", "find"), e("r", "refactor")],
        })
    }

    #[test]
    fn levels_groups_and_running() {
        let mut h = help();
        let rows = h.rows_text();
        assert!(rows.contains(&("f".into(), "+find".into())));
        assert!(rows.contains(&("r".into(), "+refactor".into())));
        let keys: Vec<_> = rows.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(keys, vec!["f", "r", "w", "W", "<D-x>", "?"]);
        assert_eq!(h.key("f"), Step::Stay);
        assert_eq!(h.title(), ",f");
        assert_eq!(
            h.rows_text(),
            vec![
                ("b".into(), "Buffers".into()),
                ("r".into(), "Recent files".into())
            ]
        );
        assert_eq!(h.key("<BS>"), Step::Stay);
        assert_eq!(h.title(), ",");
        assert_eq!(h.key("w"), Step::Run("w".into()));
        let mut h = help();
        h.key("f");
        assert_eq!(h.key("r"), Step::Run("fr".into()));
        let mut h = help();
        assert_eq!(h.key("<d-x>"), Step::Run("<D-x>".into()));
        let mut h = help();
        assert_eq!(h.key("z"), Step::Close);
        assert_eq!(help().key("<Esc>"), Step::Close);
        assert_eq!(tokens("<leader>a<CR>"), vec!["<LEADER>", "a", "<CR>"]);
        assert_eq!(crate::kit::label("<D-S-x>"), "⇧⌘x");
    }
}
