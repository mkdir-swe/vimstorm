//! The Branches pane's list: [`BranchesList`] is a `ui::list` delegate drawing the tree rows of
//! [`super::tree`] like WebStorm's branches tree (chevrons, folder / branch / tag icons, the
//! current branch's label icon, favorites' stars) and handling its keys: l / ö move (with a count,
//! `gg` / `G`), k / ä fold or go to the parent / first child, Enter shows the branch in the log,
//! `/` speed search (every group opens so every ref can be found), c checkout, Cmd+Enter the menu,
//! Esc / Tab back to the commit table, `g?` the Log's help. A click on a branch shows it in the log. The Log ([`super::super::LogTab`])
//! subscribes to [`BranchesEvent`].

use std::cell::Cell;
use std::collections::HashSet;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, Bounds, Context, EventEmitter, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseUpEvent, ParentElement as _, Pixels, Point, SharedString, Styled as _,
    Window, canvas, div, prelude::FluentBuilder as _, px,
};

use super::tree::{self, Node, NodeKind, RefInfo, RefKind, Row};
use crate::git::branches::FilterRefs;
use crate::kit;
use crate::kit::Anchor;
use crate::kit::chevron_x;
use crate::kit::{Icon, IconName};
use crate::kit::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, SearchMode, match_text,
};
use crate::look;

/// What the pane asks the Log for.
#[derive(Clone, Debug, PartialEq)]
pub enum BranchesEvent {
    /// Enter / a click on a branch, tag or HEAD: the log shows it (None = HEAD).
    Show(Option<String>),
    /// c: check the ref out (after confirming).
    Checkout(RefInfo, Anchor),
    /// Right-click / Cmd+Enter: the pane's menu.
    ContextMenu(Anchor),
    /// Esc / Tab: back to the commit table.
    Back,
    /// A Log key typed in the pane (b u d p filters, Backspace clears them, R refresh, `g?`).
    LogKey(String),
}

pub struct BranchesList {
    nodes: Vec<Node>,
    /// Folded groups (new groups come unfolded).
    closed: HashSet<String>,
    pub rows: Vec<Row>,
    /// The cursor row's bounds at the last paint (keyboard menus open below it).
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl EventEmitter<BranchesEvent> for ListView<BranchesList> {}

impl BranchesList {
    pub fn new() -> Self {
        BranchesList {
            nodes: Vec::new(),
            closed: HashSet::new(),
            rows: Vec::new(),
            cursor_bounds: Rc::default(),
        }
    }

    /// New refs: the tree is rebuilt, folds kept, the cursor stays on its node (or its closest
    /// ancestor still there).
    pub fn set_refs(&mut self, refs: &FilterRefs, state: &mut ListState) {
        let keep = self.cursor_key(state);
        let path = keep
            .as_deref()
            .map(|k| tree::ancestors(&self.nodes, k))
            .unwrap_or_default();
        self.nodes = tree::build(refs);
        self.rebuild(state);
        let target = keep
            .into_iter()
            .chain(path.into_iter().rev())
            .find(|k| self.row_of(k).is_some());
        self.set_cursor_key(target.as_deref(), state);
    }

    fn cursor_key(&self, state: &ListState) -> Option<String> {
        state
            .cursor()
            .and_then(|c| self.rows.get(c))
            .map(|r| r.key.clone())
    }

    fn row_of(&self, key: &str) -> Option<usize> {
        self.rows.iter().position(|r| r.key == key)
    }

    fn set_cursor_key(&self, key: Option<&str>, state: &mut ListState) {
        let ix = key.and_then(|k| self.row_of(k));
        if ix != state.cursor() {
            state.set_cursor(ix);
        }
    }

    /// Rows from the nodes and folds; the list model follows.
    fn rebuild(&mut self, state: &mut ListState) {
        self.rows = tree::flatten(&self.nodes, &self.closed);
        state.refresh(&*self);
    }

    /// Folds / unfolds the group on row `ix`; the cursor stays on its node.
    pub fn toggle(&mut self, ix: usize, open: Option<bool>, state: &mut ListState) {
        let Some(row) = self.rows.get(ix).filter(|r| r.is_group()) else {
            return;
        };
        let open = open.unwrap_or(!row.open);
        let key = row.key.clone();
        if open == row.open {
            return;
        }
        let keep = self.cursor_key(state);
        if open {
            self.closed.remove(&key);
        } else {
            self.closed.insert(key.clone());
        }
        self.rebuild(state);
        // the cursor was inside the folded group: onto the group
        let target = keep.filter(|k| self.row_of(k).is_some()).or(Some(key));
        self.set_cursor_key(target.as_deref(), state);
    }

    /// Expand All / Collapse All (a collapsed cursor goes to its top-level group).
    pub fn set_all_open(&mut self, open: bool, state: &mut ListState) {
        let keep = self.cursor_key(state);
        self.closed = if open {
            HashSet::new()
        } else {
            tree::group_keys(&self.nodes).into_iter().collect()
        };
        self.rebuild(state);
        let target = keep.and_then(|k| {
            let mut path = tree::ancestors(&self.nodes, &k);
            path.push(k);
            path.into_iter().find(|k| self.row_of(k).is_some())
        });
        self.set_cursor_key(target.as_deref(), state);
    }

    /// k / ←: an open group folds, else to the parent.
    fn left(&mut self, state: &mut ListState) {
        let Some(c) = state.cursor() else {
            return;
        };
        let row = &self.rows[c];
        if row.open {
            self.toggle(c, Some(false), state);
        } else if let Some(p) = row.parent {
            state.set_cursor(Some(p));
        }
    }

    /// ä / →: a folded group opens, an open one goes to its first child.
    fn right(&mut self, state: &mut ListState) {
        let Some(c) = state.cursor() else {
            return;
        };
        let row = &self.rows[c];
        if !row.is_group() {
            return;
        }
        if row.open {
            state.set_cursor(Some(c + 1));
        } else {
            self.toggle(c, Some(true), state);
        }
    }

    /// The ref (or HEAD) on row `ix`, as the log's branch filter (None = HEAD).
    pub fn target(&self, ix: usize) -> Option<Option<String>> {
        let row = self.rows.get(ix)?;
        match &row.kind {
            NodeKind::Head => Some(None),
            NodeKind::Ref(r) => Some(Some(r.name.clone())),
            _ => None,
        }
    }

    /// Below the cursor row (keyboard menus), else at the mouse.
    pub fn cursor_anchor(&self, window: &Window) -> Anchor {
        match self.cursor_bounds.get() {
            Some(b) => Anchor::Below(b),
            None => Anchor::Point(window.mouse_position()),
        }
    }

    fn icon(row: &Row) -> Option<IconName> {
        // GitBranchesTreeIconProvider.forRef / forGroup
        match &row.kind {
            NodeKind::Head => None,
            NodeKind::Section(_) | NodeKind::Remote | NodeKind::Folder => Some(IconName::Folder),
            NodeKind::Ref(r) => Some(match (r.current, r.favorite) {
                (true, true) => IconName::CurrentBranchFavorite,
                (true, false) => IconName::CurrentBranch,
                (false, true) => IconName::Favorite,
                _ if r.kind == RefKind::Tag => IconName::BranchLabel,
                _ => IconName::Branch,
            }),
        }
    }
}

impl Default for BranchesList {
    fn default() -> Self {
        Self::new()
    }
}

impl ListSource for BranchesList {
    fn len(&self) -> usize {
        self.rows.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        self.rows[ix].search_text().to_owned().into()
    }
}

impl ListDelegate for BranchesList {
    fn options(&self) -> ListOptions {
        ListOptions {
            multi_select: false,
            search: SearchMode::Highlight,
            ..ListOptions::tree()
        }
    }

    fn render_row(
        &mut self,
        ix: usize,
        row_state: RowState<'_>,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let row = self.rows[ix].clone();
        let chevron = row.has_children.then_some(if row.open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        });
        let icon = Self::icon(&row);
        // matches are char indices of the whole ref name; the label is its last segment
        let skip = row.search_text().chars().count() - row.label.chars().count();
        let matches: Vec<u32> = row_state
            .matches
            .iter()
            .filter_map(|&m| m.checked_sub(skip as u32))
            .collect();
        let cursor_bounds = row_state.cursor.then(|| self.cursor_bounds.clone());
        let clickable = self.target(ix).is_some();
        div()
            .id(("branches-row", ix))
            .debug_selector(move || format!("branches-row-{ix}"))
            .relative()
            .size_full()
            .flex()
            .items_center()
            .min_w_0()
            .child(div().flex_none().w(px(chevron_x(row.depth))))
            .child(
                div()
                    .id(("branches-chevron", ix))
                    .debug_selector(move || format!("branches-chevron-{ix}"))
                    .flex_none()
                    .size(px(look::TREE_CHEVRON_SIZE))
                    .when_some(chevron, |d, c| {
                        d.child(Icon::new(c)).on_mouse_down(
                            MouseButton::Left,
                            cx.listener(
                                move |v: &mut ListView<Self>, _: &MouseDownEvent, window, cx| {
                                    let ListView {
                                        delegate, state, ..
                                    } = v;
                                    delegate.toggle(ix, None, state);
                                    window.focus(&gpui_kit::Focusable::focus_handle(v, cx), cx);
                                    cx.stop_propagation();
                                    cx.notify();
                                },
                            ),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(look::TREE_CHEVRON_TO_RENDERER - look::TREE_CHEVRON_SIZE
                        + look::TREE_RENDERER_PAD_X)),
            )
            .when_some(icon, |d, icon| {
                d.child(Icon::new(icon))
                    .child(div().flex_none().w(px(look::TREE_ICON_GAP)))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(match_text(row.label.clone(), &matches)),
            )
            // the cursor row's bounds, for keyboard menus
            .when_some(cursor_bounds, |d, cell| {
                d.child(
                    canvas(move |b, _, _| cell.set(Some(b)), |_, _, _, _| {})
                        .absolute()
                        .size_full(),
                )
            })
            // a click on a branch shows it in the log (after the row took the selection)
            .when(clickable, |d| {
                d.on_mouse_up(
                    MouseButton::Left,
                    cx.listener(move |v: &mut ListView<Self>, _: &MouseUpEvent, _, cx| {
                        if let Some(t) = v.delegate.target(ix)
                            && v.state.cursor() == Some(ix)
                        {
                            cx.emit(BranchesEvent::Show(t));
                        }
                    }),
                )
            })
            .into_any_element()
    }

    fn on_key(
        &mut self,
        key: &str,
        state: &mut ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> bool {
        if state.searching() {
            // typed text and moves are the search's; Enter still shows the match
            if key == "<CR>" {
                if let Some(t) = state.cursor().and_then(|c| self.target(c)) {
                    cx.emit(BranchesEvent::Show(t));
                }
                return true;
            }
            return false;
        }
        match key {
            "/" => {
                // every ref findable: open every group (the list opens its search next)
                if !self.closed.is_empty() {
                    let keep = self.cursor_key(state);
                    self.closed.clear();
                    self.rebuild(state);
                    self.set_cursor_key(keep.as_deref(), state);
                }
                false
            }
            "k" | "<Left>" => {
                self.left(state);
                true
            }
            "ä" | "<Right>" => {
                self.right(state);
                true
            }
            "<CR>" => {
                match state.cursor() {
                    Some(c) if self.rows[c].is_group() => self.toggle(c, None, state),
                    Some(c) => {
                        if let Some(t) = self.target(c) {
                            cx.emit(BranchesEvent::Show(t));
                        }
                    }
                    None => {}
                }
                true
            }
            "c" => {
                if let Some(r) = state
                    .cursor()
                    .and_then(|c| self.rows[c].ref_info())
                    .cloned()
                {
                    cx.emit(BranchesEvent::Checkout(r, self.cursor_anchor(window)));
                }
                true
            }
            "<D-CR>" => {
                cx.emit(BranchesEvent::ContextMenu(self.cursor_anchor(window)));
                true
            }
            "<Tab>" | "<S-Tab>" => {
                cx.emit(BranchesEvent::Back);
                true
            }
            "b" | "u" | "d" | "p" | "<BS>" | "R" => {
                cx.emit(BranchesEvent::LogKey(key.to_owned()));
                true
            }
            _ => false,
        }
    }

    fn confirm(
        &mut self,
        ix: usize,
        _: &ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        // double-click: a group folds (its first click selected it), a branch shows
        if self.rows.get(ix).is_some_and(Row::is_group) {
            let view = cx.entity().downgrade();
            cx.defer(move |cx| {
                let _ = view.update(cx, |v, cx| {
                    let ListView {
                        delegate, state, ..
                    } = v;
                    delegate.toggle(ix, None, state);
                    cx.notify();
                });
            });
        } else if let Some(t) = self.target(ix) {
            cx.emit(BranchesEvent::Show(t));
        }
    }

    fn cancel(&mut self, _: &mut Window, cx: &mut Context<ListView<Self>>) {
        cx.emit(BranchesEvent::Back);
    }

    /// The list's Vim layer gives counts and `gg` / `G`; no branch rename / delete here yet,
    /// so only `g?` (the Log's help).
    fn vim_cmd(
        &mut self,
        cmd: kit::Cmd,
        _: &mut ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        if cmd == kit::Cmd::Help {
            cx.emit(BranchesEvent::LogKey("g?".into()));
        }
    }

    fn secondary_click(
        &mut self,
        _ix: usize,
        position: Point<Pixels>,
        _: &ListState,
        _: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        cx.emit(BranchesEvent::ContextMenu(Anchor::Point(position)));
    }
}
