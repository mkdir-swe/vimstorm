//! The Log's commit table (WS `VcsLogGraphTable` in the New UI): a virtual list of 24 px rows
//! (`VersionControl.Log.Commit.rowHeight`), each the graph + subject (following the row's own
//! graph width) with the ref labels right-aligned at its end, then the Author (bold for your own
//! commits when there are other authors: WS MyCommitsHighlighter) and Date columns
//! (`git::dates::format_log_date`); Show History for Selection adds a hash column. Selection: an
//! inset rounded rect (VcsLogNewUiCellWrapper), blue while the table has the keyboard; hovered
//! rows a lighter one; with all branches listed, the current branch's commits get WS's
//! current-branch background.
//!
//! Columns drop when the table gets narrow (Lua `git/log.lua` `M.columns`): the date first, then
//! the author (then the hash).
//!
//! Mouse: click = cursor, Shift+click = range, Cmd+click = toggle, drag = the rows dragged over,
//! double-click = the changed files (history for a selection: the lines' diff), right-click =
//! the context menu.

use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, Bounds, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, Rgba, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, point,
    prelude::FluentBuilder as _, px, size, uniform_list,
};

use super::{LogTab, graph_paint, model};
use crate::git::dates::{self, Zone};
use crate::git::log::{BranchFilter, Commit, HeadRef, LogKind};
use crate::kit::Anchor;
use crate::kit::selection_corners;
use crate::kit::{RefKind, RefLabel};
use crate::look;
use crate::render::ui_font;

/// The graph's first lane starts this far from the table's left edge (30.png: node center
/// 22.5 px from the log's left edge; IntelliJ: cell inset 4 + additional gap 8, + lane offset).
pub const GRAPH_LEFT: f32 = 8.5;
/// From the end of a row's graph lanes to its subject (calibrated on 30.png: 1 lane -> subject
/// 41 px after the lane's left edge).
pub const SUBJECT_GAP: f32 = 24.;
/// Gap between the ref labels and the author column (30.png ~7 px).
const REFS_GAP: f32 = 7.;
/// Space after the date column's text (30.png: dates end ~22 px before the details splitter).
const RIGHT_PAD: f32 = 12.;
/// Natural column widths are calibrated on 30.png (Author 205 px, Date from the widest date + the
/// gap, at least 125 px); WS sizes them from the first 1000 rows' widest value + gaps.
const AUTHOR_MIN: f32 = 205.;
const AUTHOR_MAX: f32 = 300.;
const AUTHOR_GAP: f32 = 24.;
const DATE_MIN: f32 = 125.;
const DATE_GAP: f32 = 8.;
/// Show History for Selection's hash column (8 chars + gap).
const HASH_W: f32 = 80.;
/// Rows measured for the column widths (WS `VcsLogGraphTable` checks the first 1000).
const MEASURE_ROWS: usize = 1000;
/// The ref names take at most this share of the subject column (Lua `git/log.lua`: 45 %).
const REFS_SHARE: f32 = 0.45;

#[derive(Default)]
pub struct TableUi {
    /// The listing the column widths were measured for (commits pointer, row count).
    pub measured_for: Option<(usize, usize)>,
    author_w: f32,
    date_w: f32,
    /// Your commits are bold only when someone else authored commits too (WS isSingleUser).
    multi_author: bool,
    /// Text widths already measured (author names, dates), normal / bold.
    widths: HashMap<(String, bool), f32>,
    /// The table's width at the last layout (narrow rules).
    width: Rc<Cell<f32>>,
    /// The list viewport at the last layout (row anchors).
    viewport: Rc<Cell<Bounds<Pixels>>>,
    /// The columns' widths at the last render (author, date, hash; 0 = dropped).
    last_cols: Cell<(f32, f32, f32)>,
    /// Scroll offset + viewport height when the tab was hidden: put back once the list is laid
    /// out at that height again (a layout at another height meanwhile would clamp it).
    pub restore_scroll: Rc<Cell<Option<(Pixels, Pixels)>>>,
    /// A drag selecting rows started on this row.
    drag: Option<usize>,
    /// Rows of the current branch (all branches listed), per listing.
    head_rows: Option<(usize, Rc<Vec<bool>>)>,
}

impl TableUi {
    /// A row's box (window coordinates) if it's laid out.
    pub fn row_bounds(&self, row: Option<usize>) -> Option<Bounds<Pixels>> {
        let row = row?;
        let vp = self.viewport.get();
        if vp.size.height <= px(0.) {
            return None;
        }
        Some(Bounds::new(
            point(
                vp.left(),
                vp.top() + px(row as f32 * look::VCS_LOG_ROW_HEIGHT),
            ),
            size(vp.size.width, px(look::VCS_LOG_ROW_HEIGHT.get())),
        ))
    }
}

fn text_width(window: &Window, text: &str, bold: bool) -> f32 {
    let mut font = ui_font();
    if bold {
        font.weight = FontWeight::BOLD;
    }
    crate::kit::width(window, text, font, px(look::VCS_LOG_FONT_SIZE)).as_f32()
}

/// A commit's ref icons, one per ref (WS LabelIcon), and the compact name (the first branch
/// label's: "origin & master"; tags alone show no name).
pub fn ref_icons(c: &Commit) -> (Vec<(SharedString, RefKind)>, String) {
    let r = &c.refs;
    let mut refs: Vec<(SharedString, RefKind)> = Vec::new();
    for o in &r.other {
        refs.push((o.clone().into(), RefKind::Other));
    }
    for t in &r.tags {
        refs.push((t.clone().into(), RefKind::Tag));
    }
    for b in &r.remote {
        refs.push((b.clone().into(), RefKind::RemoteBranch));
    }
    for b in &r.local {
        refs.push((b.clone().into(), RefKind::LocalBranch));
    }
    if r.head != HeadRef::None {
        refs.push(("HEAD".into(), RefKind::Head));
    }
    let name = r
        .labels()
        .into_iter()
        .find_map(|l| l.name)
        .unwrap_or_default();
    (refs, name)
}

/// git's answer in a repo without commits ("ambiguous argument 'HEAD': unknown revision",
/// "does not have any commits yet"): WS shows an empty log, not the error.
fn no_commits_yet(err: &str) -> bool {
    err.contains("does not have any commits") || err.contains("unknown revision")
}

/// The Author column's text.
pub fn author_text(c: &Commit) -> String {
    dates::author_text(&c.author, &c.committer)
}

impl LogTab {
    /// Column widths from the first rows (once per listing).
    fn measure(&mut self, window: &Window) {
        let key = (
            std::sync::Arc::as_ptr(&self.model.commits) as usize,
            self.model.len(),
        );
        if self.table.measured_for == Some(key) {
            return;
        }
        self.table.measured_for = Some(key);
        let me = self.me.clone();
        let zone = Zone::system();
        let now = dates::now();
        let mut author_w: f32 = 0.;
        let mut date_w: f32 = 0.;
        let mut first: Option<&str> = None;
        let mut multi = false;
        let rows = &self.model.commits[..self.model.len().min(MEASURE_ROWS)];
        let widths = &mut self.table.widths;
        for c in rows {
            match first {
                None => first = Some(&c.author.name),
                Some(f) if f != c.author.name => multi = true,
                _ => {}
            }
            let bold = me
                .as_ref()
                .is_some_and(|m| dates::same_person(&c.author, m));
            let a = author_text(c);
            let w = *widths
                .entry((a.clone(), bold))
                .or_insert_with(|| text_width(window, &a, bold));
            author_w = author_w.max(w);
            let d = dates::format_log_date(c.author_time.unix, now, zone);
            let w = *widths
                .entry((d.clone(), false))
                .or_insert_with(|| text_width(window, &d, false));
            date_w = date_w.max(w);
        }
        self.table.author_w = (author_w + AUTHOR_GAP).clamp(AUTHOR_MIN, AUTHOR_MAX);
        self.table.date_w = (date_w + DATE_GAP).max(DATE_MIN);
        self.table.multi_author = multi;
    }

    /// What an empty table says (VcsLogBundle: "Loading commits…", git's error, "No commits
    /// matching filters"; a repo without commits: the latter, WS shows an empty log).
    pub fn empty_text(&self) -> String {
        if self.loading {
            "Loading commits…".to_string()
        } else if let Some(e) = self.error.as_ref().filter(|e| !no_commits_yet(e)) {
            e.lines().next().unwrap_or_default().to_string()
        } else {
            "No commits matching filters".to_string()
        }
    }

    /// The "Reset filters" link under the empty text (`vcs.log.reset.filters.status.action`):
    /// only when filters hide commits.
    pub fn shows_reset_link(&self) -> bool {
        !self.loading
            && self.error.as_ref().is_none_or(|e| no_commits_yet(e))
            && self.filters.lines.is_none()
            && self.filters != crate::git::log::LogFilters::default()
    }

    fn head_rows(&mut self) -> Option<Rc<Vec<bool>>> {
        if self.filters.branch != BranchFilter::All || self.model.kind != LogKind::Graph {
            return None;
        }
        let key = std::sync::Arc::as_ptr(&self.model.commits) as usize;
        if self.table.head_rows.as_ref().is_none_or(|(k, _)| *k != key) {
            self.table.head_rows = Some((key, Rc::new(self.model.head_reachable())));
        }
        self.table.head_rows.as_ref().map(|(_, v)| v.clone())
    }

    pub(super) fn render_table(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.measure(window);
        let width_cell = self.table.width.clone();
        let viewport = self.table.viewport.clone();
        let view = cx.entity().downgrade();
        let measure = canvas(
            move |bounds, window, cx| {
                let w = bounds.size.width.as_f32();
                if width_cell.get() != w {
                    width_cell.set(w);
                    let _ = view.update(cx, |_, cx| cx.notify());
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let empty = self.model.is_empty();
        let mut root = div()
            .id("git-log-table")
            .debug_selector(|| "git-log-table".into())
            .relative()
            .size_full()
            .child(measure);
        if empty {
            // WS StatusText: centred in the table, the action link on the next line
            let text = self.empty_text();
            let link = self.shows_reset_link().then(|| {
                div()
                    .id("git-log-reset-filters")
                    .debug_selector(|| "git-log-reset-filters".into())
                    .text_color(look::LINK)
                    .cursor(gpui_kit::CursorStyle::PointingHand)
                    .hover(|s| s.underline())
                    .child("Reset filters")
                    .on_click(cx.listener(|t, _, _, cx| t.clear_filters(cx)))
            });
            root = root.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .debug_selector(|| "git-log-empty".into())
                            .flex()
                            .flex_col()
                            .items_center()
                            .text_color(look::TEXT_DIM)
                            .child(text)
                            .children(link),
                    ),
            );
        } else {
            let vp = viewport.clone();
            let handle = self.scroll.clone();
            let restore = self.table.restore_scroll.clone();
            let list = uniform_list(
                "git-log-rows",
                self.model.len(),
                cx.processor(|this, rows: Range<usize>, window, cx| {
                    this.render_rows(rows, window, cx)
                }),
            )
            .track_scroll(&self.scroll)
            .size_full();
            // the list's viewport + scroll offset, for row anchors (menus below a row)
            let anchor = canvas(
                move |bounds, window, _| {
                    if let Some((y, h)) = restore.get()
                        && (h - bounds.size.height).abs() < px(1.)
                    {
                        restore.set(None);
                        let base = handle.0.borrow().base_handle.clone();
                        if (base.offset().y - y).abs() >= px(1.) {
                            base.set_offset(point(px(0.), y));
                            window.refresh();
                        }
                    }
                    let off = handle.0.borrow().base_handle.offset();
                    vp.set(Bounds::new(
                        point(bounds.left(), bounds.top() + off.y),
                        bounds.size,
                    ));
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_full();
            root = root.child(list).child(anchor);
            self.rows_painted();
        }
        root.on_mouse_up(
            MouseButton::Left,
            cx.listener(|t, _, _, _| {
                t.table.drag = None;
            }),
        )
        .into_any_element()
    }

    fn render_rows(
        &mut self,
        rows: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let focused = self.table_focused(window);
        let head_rows = self.head_rows();
        let lines = self.model.kind == LogKind::Lines;
        let graph = self.model.kind == LogKind::Graph;
        let width = self.table.width.get();
        let widest_graph = if graph {
            self.model
                .graph
                .rows
                .get(rows.clone())
                .map(|r| r.iter().map(graph_paint::width).fold(0., f32::max))
                .unwrap_or(0.)
        } else {
            0.
        };
        let subject_left = GRAPH_LEFT
            + if graph {
                widest_graph + SUBJECT_GAP
            } else {
                0.
            };
        let cols = model::columns(
            width - RIGHT_PAD,
            subject_left,
            self.table.author_w,
            self.table.date_w,
            if lines || self.filters.pr.is_some() {
                HASH_W
            } else {
                0.
            },
        );
        self.table
            .last_cols
            .set((cols.author, cols.date, cols.hash));
        let subject_w =
            (width - RIGHT_PAD - subject_left - cols.author - cols.date - cols.hash).max(0.);
        let zone = Zone::system();
        let now = dates::now();
        let me = self.me.clone();
        let multi = self.table.multi_author;
        let has_sel = self.model.has_selection();
        // PR review: the All changes row has the cursor, no commit does
        let cursor = if self.pr_all {
            None
        } else {
            self.model.cursor()
        };
        let h = look::VCS_LOG_ROW_HEIGHT;
        let bg_of =
            |ix: usize| -> Option<Rgba> {
                let is_cursor = cursor == Some(ix);
                if self.model.is_selected(ix) || (is_cursor && !has_sel) {
                    Some(if focused {
                        look::SELECTION_BG.rgba()
                    } else {
                        look::SELECTION_BG_INACTIVE.rgba()
                    })
                } else if is_cursor {
                    // the cursor beside a multi-selection (Lua: the brighter cursor line)
                    Some(look::SELECTION_BG_INACTIVE.rgba())
                } else if self.pr_all
                    && self.filters.pr.as_ref().is_some_and(|p| {
                        self.model.commits.get(ix).is_some_and(|c| c.hash != p.base)
                    })
                {
                    // All changes is the scope: the PR's commits are in it (G-10), its base is not
                    Some(look::SELECTION_BG_INACTIVE.rgba())
                } else {
                    None
                }
            };
        rows.filter_map(|ix| {
            let c = self.model.commits.get(ix)?;
            let sel_bg = bg_of(ix);
            // selected rows next to each other melt into one block (same color only)
            let joins_above = sel_bg.is_some() && ix > 0 && bg_of(ix - 1) == sel_bg;
            let joins_below = sel_bg.is_some() && bg_of(ix + 1) == sel_bg;
            let current_branch = head_rows
                .as_ref()
                .is_some_and(|r| r.get(ix).copied().unwrap_or(false));
            let row_bg = sel_bg.unwrap_or(if current_branch {
                look::VCS_LOG_CURRENT_BRANCH_BG.rgba()
            } else {
                look::PANEL_BG.rgba()
            });
            let mut row = div()
                .id(("git-log-row", ix))
                .group("git-log-row")
                .relative()
                .h(px(h.get()))
                .w_full()
                .when(current_branch, |d| d.bg(look::VCS_LOG_CURRENT_BRANCH_BG))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(look::VCS_LOG_SELECTION_INSET_X))
                        .right(px(look::VCS_LOG_SELECTION_INSET_X))
                        .map(|d| {
                            selection_corners(
                                d,
                                look::VCS_LOG_SELECTION_ARC,
                                joins_above,
                                joins_below,
                            )
                        })
                        .map(|d| match sel_bg {
                            Some(bg) => d.bg(bg),
                            None => d.group_hover("git-log-row", |s| s.bg(look::VCS_LOG_HOVER_BG)),
                        }),
                );
            if graph && let Some(g) = self.model.graph.rows.get(ix) {
                let g = g.clone();
                let head = c.refs.is_head();
                let gw = graph_paint::width(&g);
                row = row.child(
                    canvas(
                        |_, _, _| {},
                        move |b, _, window, _| {
                            graph_paint::paint_row(window, b.origin, h.get(), &g, head, row_bg)
                        },
                    )
                    .absolute()
                    .top_0()
                    .left(px(GRAPH_LEFT))
                    .w(px(gw))
                    .h(px(h.get())),
                );
            }
            // the subject follows the row's own graph (WS)
            let own_left = if graph {
                GRAPH_LEFT
                    + self
                        .model
                        .graph
                        .rows
                        .get(ix)
                        .map(graph_paint::width)
                        .unwrap_or(0.)
                    + SUBJECT_GAP
            } else {
                GRAPH_LEFT
            };
            let (refs, name) = ref_icons(c);
            let bold = self.author_bold_in(ix, multi, me.as_ref());
            // PR review: the merge base under the PR's commits, shown but not the PR's
            let unmatched = self.filters.pr.as_ref().is_some_and(|p| p.base == c.hash);
            let subject_room = subject_w + (subject_left - own_left);
            let content = div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(own_left))
                .right(px(RIGHT_PAD))
                .flex()
                .flex_row()
                .items_center()
                .whitespace_nowrap()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .w(px(subject_room))
                        .flex_none()
                        .min_w_0()
                        .overflow_hidden()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .debug_selector(move || format!("git-log-subject-{ix}"))
                                .text_color(if unmatched {
                                    look::VCS_LOG_UNMATCHED_FG
                                } else {
                                    look::VCS_LOG_SUBJECT_FG
                                })
                                .child(c.subject.clone()),
                        )
                        .when(!refs.is_empty(), |d| {
                            d.child(
                                div()
                                    .debug_selector(move || format!("git-log-refs-{ix}"))
                                    .flex_none()
                                    .pl(px(4.))
                                    .pr(px(REFS_GAP - look::VCS_REF_PAD_X))
                                    .child(
                                        RefLabel::new(refs)
                                            .text(name)
                                            .background(row_bg)
                                            .max_text_width(px(
                                                (subject_room * REFS_SHARE).max(40.)
                                            )),
                                    ),
                            )
                        }),
                )
                .when(cols.author > 0., |d| {
                    d.child(
                        div()
                            .flex_none()
                            .w(px(cols.author))
                            .debug_selector(move || format!("git-log-author-{ix}"))
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(look::VCS_LOG_AUTHOR_FG)
                            .when(bold, |d| d.font_weight(FontWeight::BOLD))
                            .child(author_text(c)),
                    )
                })
                .when(cols.date > 0., |d| {
                    d.child(
                        div()
                            .flex_none()
                            .w(px(cols.date))
                            .debug_selector(move || format!("git-log-date-{ix}"))
                            .overflow_hidden()
                            .text_color(look::VCS_LOG_DATE_FG)
                            .child(dates::format_log_date(c.author_time.unix, now, zone)),
                    )
                })
                .when(cols.hash > 0., |d| {
                    d.child(
                        div()
                            .flex_none()
                            .w(px(cols.hash))
                            .debug_selector(move || format!("git-log-hash-{ix}"))
                            .overflow_hidden()
                            .text_color(look::TEXT_DIM)
                            .child(c.hash.chars().take(8).collect::<String>()),
                    )
                });
            row = row
                .child(content)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |t, ev: &MouseDownEvent, w, cx| t.row_down(ix, ev, w, cx)),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |t, ev: &MouseDownEvent, w, cx| t.row_right(ix, ev, w, cx)),
                )
                .on_mouse_move(
                    cx.listener(move |t, ev: &MouseMoveEvent, _, cx| t.row_drag(ix, ev, cx)),
                );
            Some(row.into_any_element())
        })
        .collect()
    }

    fn author_bold_in(&self, ix: usize, multi: bool, me: Option<&crate::git::log::Person>) -> bool {
        multi
            && self
                .model
                .commits
                .get(ix)
                .zip(me)
                .is_some_and(|(c, m)| dates::same_person(&c.author, m))
    }

    /// Row `ix`'s author is drawn bold (your own commit, other authors listed: WS
    /// MyCommitsHighlighter).
    pub fn author_bold(&self, ix: usize) -> bool {
        self.author_bold_in(ix, self.table.multi_author, self.me.as_ref())
    }

    /// The commit table's columns shown now (narrow rules): (author, date, hash) widths.
    pub fn shown_columns(&self) -> (f32, f32, f32) {
        self.table.last_cols.get()
    }

    fn row_down(&mut self, ix: usize, ev: &MouseDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.focus_table(w, cx);
        self.pr_all = false;
        let m = ev.modifiers;
        if ev.click_count >= 2 && !m.shift && !m.platform {
            self.model.move_to(ix);
            self.cursor_moved(cx);
            if self.filters.lines.is_some() {
                self.show_change(true, cx);
            } else if self.details_shown {
                self.details.update(cx, |d, cx| d.focus(w, cx));
            }
            return;
        }
        if m.shift {
            self.model.extend_to(ix);
        } else if m.platform || m.alt {
            self.model.toggle_row(ix);
        } else {
            self.model.move_to(ix);
            self.table.drag = Some(ix);
        }
        self.cursor_moved(cx);
    }

    fn row_right(
        &mut self,
        ix: usize,
        ev: &MouseDownEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_table(w, cx);
        // the clicked commit is the menu's (Lua moves the caret there); a selection stays
        self.model.move_to(ix);
        self.cursor_moved(cx);
        cx.stop_propagation();
        self.context_menu(Anchor::Point(ev.position), w, cx);
    }

    fn row_drag(&mut self, ix: usize, ev: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(start) = self.table.drag else {
            return;
        };
        if ev.pressed_button != Some(MouseButton::Left) {
            self.table.drag = None;
            return;
        }
        if ix == start && !self.model.has_selection() {
            return;
        }
        self.model.select_drag(start, ix);
        self.cursor_moved(cx);
    }
}
