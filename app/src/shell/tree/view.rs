//! Drawing the tree: WebStorm's Project view metrics (`ui::theme` `TREE_*`, measured on 30.png):
//! chevron at `TREE_PAD_X + depth * TREE_INDENT`, icon 21 px right of it, name 2 px after the
//! 16 px icon; selection = rounded rect inset `SELECTION_INSET_X` (blue focused, gray not);
//! excluded rows tinted the full width; names colored by git status, error files underlined.

use std::path::Path;
use std::sync::Arc;

use gpui_kit::{
    AnyElement, AppContext as _, Context, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    uniform_list,
};

use super::model::{Kids, Row};
use super::{DraggedPaths, HEADER, TOP_PAD, TreeView};
use crate::factory::Decorations;
use crate::git::FileStatus;
use crate::kit::match_text;
use crate::kit::{self, Icon, IconName};
use crate::look;
use crate::render::UI_FONT;

/// Chevron box left, px from the tree's left edge.
pub fn chevron_x(depth: usize) -> f32 {
    look::TREE_PAD_X + depth as f32 * look::TREE_INDENT
}

/// Icon left.
pub fn icon_x(depth: usize) -> f32 {
    chevron_x(depth) + look::TREE_CHEVRON_TO_RENDERER + look::TREE_RENDERER_PAD_X
}

/// Name text left.
pub fn name_x(depth: usize) -> f32 {
    icon_x(depth) + look::ICON_SIZE + look::TREE_ICON_GAP
}

/// What's dragged, drawn under the mouse.
struct DragLabel(SharedString);

impl Render for DragLabel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(8.))
            .h(px(look::TREE_ROW_HEIGHT.get()))
            .flex()
            .items_center()
            .rounded(px(look::SELECTION_ARC))
            .bg(look::SELECTION_BG)
            .font_family(UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .child(self.0.clone())
    }
}

impl TreeView {
    /// Has a folder row rows under it (chevron)? Folders not listed yet are asked once, in the
    /// background (drawn with a chevron until the answer comes).
    fn row_kids(&mut self, row: &Row, cx: &mut Context<Self>) -> bool {
        match row.kids {
            Kids::Yes => true,
            Kids::No => false,
            Kids::Unknown => {
                self.want_kids(&row.path, cx);
                self.kids_drawn(&row.path)
            }
        }
    }

    fn name_color(&self, row: &Row) -> Option<gpui_kit::Rgba> {
        let rel = row.path.strip_prefix(&self.tree.root).ok()?;
        self.git.color(rel, row.dir)
    }

    fn on_row_down(
        &mut self,
        ix: usize,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        if let Some(s) = &mut self.search {
            s.input = false;
        }
        let Some(path) = self.rows.get(ix).map(|r| r.path.clone()) else {
            return;
        };
        let m = ev.modifiers;
        let plain =
            ev.button == MouseButton::Left && !(m.shift || m.platform || m.alt || m.control);
        self.click_open = (self.feel.single_click
            && plain
            && ev.click_count == 1
            && self.rows.get(ix).is_some_and(|r| !r.dir))
        .then(|| path.clone());
        if ev.button == MouseButton::Right {
            // right-click on a selected row keeps the multi-selection (WebStorm)
            if !self.sel.is_selected(&path) {
                self.sel.set(Some(path));
            }
            self.open_menu(ev.position, cx);
        } else if m.shift {
            self.sel.extend_to(&self.rows, ix);
        } else if m.platform || m.alt || m.control {
            self.sel.toggle(&self.rows, ix);
        } else if ev.click_count >= 2 && ev.click_count.is_multiple_of(2) {
            // a double-click (and the 4th click of two fast ones)
            self.sel.set(Some(path));
            self.confirm(window, cx);
        } else if self.sel.is_selected(&path) && !self.rows[ix].is_root() {
            // on the selection: a drag moves it (drag and drop); a plain click selects the row
            if self.sel.has_multi() {
                self.press_single = Some(path);
            } else {
                self.sel.set(Some(path));
            }
        } else {
            // off the selection: a drag selects the rows it goes over (the Lua tree's Visual)
            self.sel.set(Some(path.clone()));
            self.drag_select = Some(path);
        }
        cx.notify();
    }

    /// The rows' area, window y: (top of the first row's slot, bottom of the island).
    fn list_y(&self) -> Option<(f32, f32)> {
        let island = self.scx.geometry().layout.tree?;
        let top = island.origin.y.as_f32()
            + look::ISLAND_BORDER_WIDTH
            + HEADER
            + TOP_PAD
            + if self.search.is_some() {
                look::TREE_ROW_HEIGHT.get()
            } else {
                0.
            };
        Some((top, island.bottom().as_f32() - look::ISLAND_BORDER_WIDTH))
    }

    /// The row under a window y (clamped to the rows).
    fn row_at_y(&self, y: f32) -> Option<usize> {
        let (top, _) = self.list_y()?;
        let ix = ((y - top + self.scroll_top().1) / look::TREE_ROW_HEIGHT).floor();
        (!self.rows.is_empty()).then(|| ix.clamp(0., (self.rows.len() - 1) as f32) as usize)
    }

    /// Drag-select: the rows from the anchor to `to`.
    fn drag_select_to(&mut self, to: usize) {
        let Some(anchor) = self.drag_select.clone() else {
            return;
        };
        let Some(&from) = self.row_of.get(&anchor) else {
            return;
        };
        self.sel.set(Some(anchor));
        if to != from {
            self.sel.extend_to(&self.rows, to);
        }
        self.reveal_cursor();
    }

    /// Drag-select past the list's top / bottom edge: scroll a row at a time (and select it)
    /// while the mouse stays there, like WebStorm.
    fn auto_scroll(&mut self, dir: i8, cx: &mut Context<Self>) {
        let was = std::mem::replace(&mut self.scroll_dir, dir);
        if dir == 0 || was != 0 {
            return;
        }
        self.scroll_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let go_on = this.update(cx, |t, cx| {
                    if t.drag_select.is_none() || t.scroll_dir == 0 {
                        t.scroll_dir = 0;
                        return false;
                    }
                    if let Some(c) = t.cursor_ix() {
                        let to = (c as isize + t.scroll_dir as isize)
                            .clamp(0, t.rows.len() as isize - 1)
                            as usize;
                        t.drag_select_to(to);
                        cx.notify();
                    }
                    true
                });
                if !matches!(go_on, Ok(true)) {
                    break;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(AUTO_SCROLL_MS))
                    .await;
            }
        }));
    }

    fn on_tree_mouse_move(&mut self, ev: &gpui_kit::MouseMoveEvent, cx: &mut Context<Self>) {
        if self.thumb_drag.is_some() {
            return self.on_thumb_move(ev, cx);
        }
        if self.drag_select.is_none() {
            return;
        }
        if ev.pressed_button != Some(MouseButton::Left) {
            self.drag_select = None;
            self.scroll_dir = 0;
            return;
        }
        let y = ev.position.y.as_f32();
        let Some((top, bottom)) = self.list_y() else {
            return;
        };
        let dir = if y < top {
            -1
        } else if y > bottom {
            1
        } else {
            0
        };
        if dir == 0
            && let Some(to) = self.row_at_y(y)
        {
            self.drag_select_to(to);
        }
        self.auto_scroll(dir, cx);
        cx.notify();
    }

    /// Release: a drag-select ends; a plain click on a multi-selection selects just that row.
    fn on_tree_mouse_up(&mut self, cx: &mut Context<Self>) {
        self.thumb_drag = None;
        self.drag_select = None;
        self.scroll_dir = 0;
        if let Some(p) = self.press_single.take()
            && !cx.has_active_drag()
        {
            self.sel.set(Some(p));
        }
        // `tree.singleClick`: a click that stayed a click (no move, no drag-select) opens it
        if let Some(p) = self.click_open.take()
            && !cx.has_active_drag()
            && !self.sel.has_multi()
            && self.sel.cursor.as_ref() == Some(&p)
        {
            self.open_single(&p);
        }
        cx.notify();
    }

    fn on_chevron_down(
        &mut self,
        ix: usize,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // `tree.singleClick`: a chevron opens no file (an earlier row press's open, left by a
        // drop that stopped its mouse up, goes too)
        self.click_open = None;
        let m = ev.modifiers;
        if m.shift || m.platform || m.alt || m.control {
            return; // the row's own click (range / toggle, like the Lua tree's)
        }
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        if let Some(s) = &mut self.search {
            s.input = false;
        }
        self.sel.set(self.rows.get(ix).map(|r| r.path.clone()));
        self.toggle_row(ix, cx);
        cx.notify();
    }

    /// A click below the rows: focus; right-click: the menu of the selected row (else the root).
    fn on_empty_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.click_open = None;
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        if let Some(s) = &mut self.search {
            s.input = false;
        }
        if ev.button == MouseButton::Right {
            if self.cursor_ix().is_none() {
                self.sel.set(self.rows.first().map(|r| r.path.clone()));
            }
            self.reveal_cursor();
            self.open_menu(ev.position, cx);
        } else if let Some(last) = self.rows.last().map(|r| r.path.clone()) {
            // below the rows: a drag up selects from the last row
            self.sel.set(Some(last.clone()));
            self.drag_select = Some(last);
        }
        cx.notify();
    }

    fn render_row(&mut self, ix: usize, focused: bool, cx: &mut Context<Self>) -> AnyElement {
        let row = self.rows[ix].clone();
        let selected = self.sel.is_selected(&row.path);
        let selected_at = |i: Option<usize>| {
            i.and_then(|i| self.rows.get(i))
                .is_some_and(|r| self.sel.is_selected(&r.path))
        };
        let joins = (selected_at(ix.checked_sub(1)), selected_at(Some(ix + 1)));
        let kids = row.dir && (row.is_root() || self.row_kids(&row, cx));
        let chevron = kids.then_some(if row.open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        });
        let icon = if row.dir {
            if !row.is_root() && self.tree.excl.dir_itself(&row.path) {
                IconName::FolderExcluded
            } else {
                IconName::Folder
            }
        } else {
            kit::for_file(&row.name)
        };
        let color = self.name_color(&row);
        let problem = self.problems.contains(&*row.path);
        let label = self.label(&row, color, problem);
        let drag: Vec<Arc<Path>> = if selected && self.sel.has_multi() {
            self.sel.multi().to_vec()
        } else {
            vec![row.path.clone()]
        };
        let drag_text: SharedString = if drag.len() > 1 {
            format!("{} items", drag.len()).into()
        } else {
            row.name.clone().into()
        };
        div()
            .id(("tree-row", ix))
            .debug_selector(|| format!("tree-row-{ix}"))
            .h(px(look::TREE_ROW_HEIGHT.get()))
            .w_full()
            .relative()
            .flex()
            .items_center()
            .when(row.excluded, |d| d.bg(look::EXCLUDED_ROW_BG))
            .when(selected, |d| {
                d.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(look::SELECTION_INSET_X))
                        .right(px(look::SELECTION_INSET_X))
                        .map(|d| {
                            crate::kit::selection_corners(d, look::SELECTION_ARC, joins.0, joins.1)
                        })
                        .bg(if focused {
                            look::SELECTION_BG
                        } else {
                            look::SELECTION_BG_INACTIVE
                        }),
                )
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |t, ev: &MouseDownEvent, window, cx| {
                    t.on_row_down(ix, ev, window, cx)
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |t, ev: &MouseDownEvent, window, cx| {
                    t.on_row_down(ix, ev, window, cx)
                }),
            )
            // only a drag that starts on the selection moves it
            .when(selected && !row.is_root(), |d| {
                d.on_drag(DraggedPaths(drag), move |_, _, _, cx| {
                    let text = drag_text.clone();
                    cx.new(|_| DragLabel(text))
                })
            })
            .when(row.dir, |d| {
                d.drag_over::<DraggedPaths>(|style, _, _, _| style.bg(look::SELECTION_BG_INACTIVE))
            })
            .on_drop(cx.listener(move |t, dragged: &DraggedPaths, window, cx| {
                t.drop_on(ix, dragged, window, cx)
            }))
            // from Finder: copied into the folder (WebStorm's Copy dialog)
            .when(row.dir, |d| {
                d.drag_over::<gpui_kit::ExternalPaths>(|style, _, _, _| {
                    style.bg(look::SELECTION_BG_INACTIVE)
                })
            })
            .on_drop(
                cx.listener(move |t, paths: &gpui_kit::ExternalPaths, _, cx| {
                    t.drop_external(Some(ix), paths.paths(), cx)
                }),
            )
            .child(div().flex_none().w(px(chevron_x(row.depth))))
            .child(
                div()
                    .id(("tree-chevron", ix))
                    .flex_none()
                    .size(px(look::TREE_CHEVRON_SIZE))
                    .when_some(chevron, |d, c| {
                        d.child(Icon::new(c)).on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |t, ev: &MouseDownEvent, window, cx| {
                                t.on_chevron_down(ix, ev, window, cx)
                            }),
                        )
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(icon_x(0) - chevron_x(0) - look::TREE_CHEVRON_SIZE)),
            )
            .child(
                div()
                    .flex_none()
                    .relative()
                    .size(px(look::ICON_SIZE))
                    // the repo's abe/ folder: Abe's head (ADR 0033)
                    .map(|d| {
                        if self.tree.first.as_deref() == Some(&*row.path) {
                            d.child(crate::kit::head(look::ICON_SIZE, 1., cx))
                        } else {
                            d.child(Icon::new(icon))
                        }
                    })
                    .when(row.link, |d| {
                        d.child(
                            div()
                                .absolute()
                                .top_0()
                                .left_0()
                                .child(Icon::new(IconName::SymlinkOverlay)),
                        )
                    }),
            )
            .child(div().flex_none().w(px(look::TREE_ICON_GAP)))
            .child(label)
            .into_any_element()
    }

    /// The tool window header (WebStorm's "Project ⌄"): the view switcher title, bold, and its
    /// chevron; while the mouse is over the tool window, ⋮ (options) and − (hide) at the right
    /// end. No line under it (Islands). The title / ⌄ and ⋮ open [`TreeView::header_menu`].
    fn render_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let record = |cell: &std::rc::Rc<std::cell::Cell<gpui_kit::Bounds<gpui_kit::Pixels>>>| {
            let cell = cell.clone();
            gpui_kit::canvas(move |b, _, _| cell.set(b), |_, _, _, _| {})
                .absolute()
                .top_0()
                .left_0()
                .size_full()
        };
        let this = cx.entity().downgrade();
        let button = |id: &'static str, icon: IconName, tip: &'static str, key: &'static str| {
            let this = this.clone();
            crate::kit::IconButton::new(id, icon)
                .tooltip(tip, Some(key).filter(|k| !k.is_empty()))
                .on_click(move |_, window, cx| {
                    let _ = this.update(cx, |t, cx| t.header_action(id, window, cx));
                })
        };
        div()
            .id("tree-header")
            .debug_selector(|| "tree-header".into())
            .flex_none()
            .h(px(HEADER.get()))
            .w_full()
            .flex()
            .items_center()
            .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
            // a press here activates the tool window, nothing else (no row / drag-select)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|t, _, window, cx| {
                    window.focus(&t.focus, cx);
                    cx.stop_propagation();
                    cx.notify();
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|_, _, _, cx| cx.stop_propagation()),
            )
            .child(
                div()
                    .id("tree-header-title")
                    .debug_selector(|| "tree-header-title".into())
                    .relative()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(look::TOOLBAR_WIDGET_CHEVRON_GAP))
                    .cursor(gpui_kit::CursorStyle::PointingHand)
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(look::TOOLWINDOW_TITLE_FONT_SIZE))
                            .text_color(look::TOOLWINDOW_TITLE_FG)
                            .child("Project"),
                    )
                    .child(Icon::new(IconName::ChevronDown))
                    .child(record(&self.header_title))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|t, _, window, cx| {
                            window.focus(&t.focus, cx);
                            cx.stop_propagation();
                            t.header_action("switcher", window, cx);
                        }),
                    ),
            )
            .child(div().flex_1())
            .when(self.hovered, |d| {
                d.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(look::TOOLWINDOW_TAB_GAP))
                        .pr(px(look::TOOLWINDOW_ACTIONS_PAD_RIGHT))
                        .child(
                            div()
                                .relative()
                                .child(button(
                                    "tree-header-more",
                                    IconName::MoreVertical,
                                    "Options",
                                    "",
                                ))
                                .child(record(&self.header_more)),
                        )
                        .child(button("tree-header-hide", IconName::Hide, "Hide", "⌘1")),
                )
            })
            .into_any_element()
    }

    /// The header's buttons: "switcher" (Project ⌄) and "more" (⋮) open the view menu below
    /// them, "hide" (−) closes the tool window.
    pub(super) fn header_action(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        match id {
            "tree-header-hide" | "hide" => self.set_open(false, window, cx),
            "tree-header-more" | "more" => self.header_menu(self.header_more.get(), window, cx),
            _ => self.header_menu(self.header_title.get(), window, cx),
        }
    }

    /// WebStorm's view switcher ("Project" checked) + the tree's view actions. The other views
    /// (Packages, Open Files, Scratches) don't exist here.
    fn header_menu(
        &mut self,
        below: gpui_kit::Bounds<gpui_kit::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::popups::{Menu, MenuEntry, MenuItem};
        let entries: Vec<MenuEntry> = vec![
            MenuItem::new("Project").icon(IconName::Checked).into(),
            MenuEntry::Separator,
            MenuItem::new("Select Opened File").shortcut(",g").into(),
            MenuItem::new("Collapse All").shortcut("⇧⌘-").into(),
            MenuItem::new("Expand All").shortcut("⇧⌘=").into(),
            MenuEntry::Separator,
            MenuItem::new("Hide").shortcut("⌘1").into(),
        ];
        // per entry (separators included)
        let actions = [
            None,
            None,
            Some("select_opened"),
            Some("collapse_all"),
            Some("expand_all"),
            None,
            Some("hide"),
        ];
        let this = cx.entity().downgrade();
        crate::popups::open_menu(
            Menu::new(entries, crate::kit::Anchor::Below(below)),
            window,
            cx,
            move |choice, window, cx| {
                let Some(name) = choice.and_then(|c| actions.get(c).copied().flatten()) else {
                    return;
                };
                let _ = this.update(cx, |t, cx| {
                    if name == "hide" {
                        t.set_open(false, window, cx);
                    } else {
                        t.action(name, window, cx);
                    }
                    cx.notify();
                });
            },
        );
    }

    /// What a row's label shows besides its name: the root row's `[module]` and `~/path` (its name
    /// bold when there's no module), a library root's "library root". A story workspace's root
    /// row: the story bold in the folder's place, then its path dim
    /// (`cart total ignores quantity  /workspace/repo`).
    fn label_text(&self, row: &Row) -> LabelText {
        if row.is_root()
            && let Some(story) = &self.story
        {
            return LabelText {
                name: Some(story.clone()),
                name_bold: true,
                module: None,
                path: Some(format!(
                    "\u{a0}\u{a0}{}",
                    crate::shell::recent::display_path(&row.path)
                )),
                library: None,
            };
        }
        if row.is_root() {
            let module = self.tree.excl.module.clone().filter(|m| *m != row.name);
            return LabelText {
                name: None,
                // WebStorm: the plain name + a bold "[module]", else the name in bold
                name_bold: module.is_none(),
                module: module.map(|m| format!("\u{a0}[{m}]")),
                path: Some(format!(
                    "\u{a0}{}",
                    crate::shell::recent::display_path(&row.path)
                )),
                library: None,
            };
        }
        LabelText {
            name: None,
            name_bold: false,
            module: None,
            path: None,
            library: (row.dir && row.name == crate::search::LIBRARY_ROOT)
                .then(|| "\u{a0}library root".into()),
        }
    }

    /// `tree.decorations = letters` (VS Code): at the row's right a file's problem count (`9+`
    /// past nine; red with errors, else yellow) and its git letter (`2, M`), in the problem's
    /// colour when it has some, else the git status's; a folder holding problems a `•`.
    fn decoration(&self, row: &Row) -> Option<(String, gpui_kit::Rgba)> {
        if self.feel.decorations != Decorations::Letters {
            return None;
        }
        let tone = |errors: u32| {
            if errors > 0 {
                look::TEXT_ERROR.rgba()
            } else {
                look::TEXT_WARNING.rgba()
            }
        };
        if row.dir {
            let errors = self
                .problem_counts
                .iter()
                .filter(|(p, _)| p.starts_with(&*row.path))
                .map(|(_, (e, w))| (*e, *w))
                .reduce(|a, b| (a.0 + b.0, a.1 + b.1))?;
            return Some(("•".to_owned(), tone(errors.0)));
        }
        let git = row
            .path
            .strip_prefix(&self.tree.root)
            .ok()
            .and_then(|rel| self.git.status(rel, false))
            .and_then(|st| {
                let letter = match st {
                    FileStatus::Modified => "M",
                    FileStatus::Added => "A",
                    FileStatus::Unversioned => "U",
                    FileStatus::Deleted => "D",
                    FileStatus::Conflict => "C",
                    FileStatus::Ignored => return None,
                };
                Some((letter, st.color()))
            });
        let count = self
            .problem_counts
            .get(&*row.path)
            .map(|(e, w)| (*e, e + w));
        match (count, git) {
            (Some((errors, n)), git) => {
                let n = if n > 9 {
                    "9+".to_owned()
                } else {
                    n.to_string()
                };
                let text = git.map_or(n.clone(), |(l, _)| format!("{n}, {l}"));
                Some((text, tone(errors)))
            }
            (None, Some((letter, color))) => Some((letter.to_owned(), color)),
            (None, None) => None,
        }
    }

    /// Row `ix`'s decoration as drawn (tests; None: none).
    pub fn row_decoration(&self, ix: usize) -> Option<String> {
        self.decoration(self.rows.get(ix)?).map(|(l, _)| l)
    }

    /// Row `ix`'s label as drawn, (text, bold) per part (tests).
    pub fn row_label(&self, ix: usize) -> Option<Vec<(String, bool)>> {
        let row = self.rows.get(ix)?;
        let t = self.label_text(row);
        let mut v = vec![(
            t.name.clone().unwrap_or_else(|| row.name.clone()),
            t.name_bold,
        )];
        v.extend(t.module.map(|m| (m, true)));
        v.extend(t.path.map(|p| (p, false)));
        v.extend(t.library.map(|l| (l, false)));
        Some(v)
    }

    /// The row's text: name (git color, matches, error underline), "library root", or the root
    /// row's `name [module] ~/path`.
    fn label(&self, row: &Row, color: Option<gpui_kit::Rgba>, problem: bool) -> AnyElement {
        let letter = self.decoration(row);
        let name = div()
            .flex_none()
            .whitespace_nowrap()
            // a long name gives way to the git letter (ellipsis), never pushes it out
            .when(letter.is_some(), |d| {
                d.flex_shrink(1.)
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
            })
            .when_some(color, |d, c| d.text_color(c))
            .when(problem, |d| {
                d.text_decoration_1()
                    .text_decoration_wavy()
                    .text_decoration_color(look::TREE_PROBLEM_UNDERLINE)
            });
        let line = div()
            .flex()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .items_center()
            .pr(px(look::SELECTION_INSET_X + 4.));
        let t = self.label_text(row);
        if let Some(path) = t.path {
            return line
                .child(
                    name.when(t.name_bold, |d| d.font_weight(FontWeight::BOLD))
                        .child(t.name.clone().unwrap_or_else(|| row.name.clone())),
                )
                .when_some(t.module, |d, m| {
                    d.child(div().flex_none().font_weight(FontWeight::BOLD).child(m))
                })
                .child(
                    div()
                        .debug_selector(|| "tree-root-path".into())
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_color(look::TEXT_DIM)
                        .child(path),
                )
                .into_any_element();
        }
        let tag = self.tags.get(&*row.path).cloned();
        line.child(name.child(name_or_matches(row)))
            .when_some(t.library, |d, l| {
                d.child(div().flex_none().text_color(look::TEXT_DIM).child(l))
            })
            // a workflow file: whose it is and what it takes, dim; red while it fails the load check
            .when_some(tag, |d, (tag, bad)| {
                d.child(
                    div()
                        .debug_selector(|| "tree-abe-tag".into())
                        .flex_none()
                        .pl(px(6.))
                        .text_color(if bad {
                            look::TEXT_ERROR
                        } else {
                            look::TEXT_DIM
                        })
                        .child(SharedString::from(tag)),
                )
            })
            .when_some(letter, |d, (letter, color)| {
                // VS Code's problem count and git letter at the row's right
                d.child(div().flex_1()).child(
                    div()
                        .debug_selector(|| "tree-decoration".into())
                        .flex_none()
                        .pl(px(4.))
                        .text_color(color)
                        .child(SharedString::from(letter)),
                )
            })
            .into_any_element()
    }

    /// Whether the speed search (`/`) is open: typed keys are its text.
    pub fn searching(&self) -> bool {
        self.search.is_some()
    }

    /// The match count drawn at the search field's end, and whether it's the "No matches" error
    /// (None: no search, no text or results not in yet).
    pub fn search_count_label(&self) -> Option<(String, bool)> {
        let s = self.search.as_ref()?;
        if s.query.is_empty() {
            return None;
        }
        match s.results.as_ref()?.count {
            0 => Some(("No matches".into(), true)),
            1 => Some(("1 match".into(), false)),
            n => Some((format!("{n} matches"), false)),
        }
    }

    fn render_search(&self, focused: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = self.search.as_ref()?;
        let (count, none) = self.search_count_label().unwrap_or_default();
        let caret = focused && s.input;
        Some(
            div()
                .id("tree-search")
                .debug_selector(|| "tree-search".into())
                .cursor(gpui_kit::CursorStyle::IBeam)
                // a click in the field: it gets the keys (nothing selected, no drag-select)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|t, _, window, cx| {
                        window.focus(&t.focus, cx);
                        if let Some(s) = &mut t.search {
                            s.input = true;
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(|_, _, _, cx| cx.stop_propagation()),
                )
                .h(px(look::TREE_ROW_HEIGHT.get()))
                .mt(px(TOP_PAD))
                .flex_none()
                .px(px(look::SELECTION_INSET_X))
                .child(
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .gap(px(look::TREE_ICON_GAP + 2.))
                        .px(px(4.))
                        .rounded(px(look::SELECTION_ARC))
                        .bg(look::SPEED_SEARCH_BG)
                        .border_1()
                        .border_color(if caret {
                            look::FOCUS_BORDER
                        } else {
                            look::SPEED_SEARCH_BORDER
                        })
                        .child(Icon::new(IconName::Search))
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_color(look::SPEED_SEARCH_FG)
                                .child(s.query.replace(' ', "\u{a0}"))
                                .when(caret, |d| {
                                    d.child(
                                        div()
                                            .flex_none()
                                            .w(px(look::CARET_WIDTH))
                                            .h(px(15.))
                                            .bg(look::CARET),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex_none()
                                .pr(px(4.))
                                .text_color(if none {
                                    look::SPEED_SEARCH_ERROR_FG
                                } else {
                                    look::TEXT_DIM
                                })
                                .child(count),
                        ),
                )
                .into_any_element(),
        )
    }
}

/// [`TreeView::label_text`]: the label's parts besides the name.
struct LabelText {
    /// In the row's name's place (a story workspace's root).
    name: Option<String>,
    name_bold: bool,
    module: Option<String>,
    path: Option<String>,
    library: Option<String>,
}

/// A name with search matches is drawn by `match_text` (already the child).
fn name_or_matches(row: &Row) -> AnyElement {
    match &row.matches {
        Some(m) => match_text(row.name.clone(), m).into_any_element(),
        None => SharedString::from(row.name.clone()).into_any_element(),
    }
}

/// Scrollbar thumb (WebStorm's mac overlay scrollbar: thin, shown while the mouse is over the
/// tree or it's dragged).
const THUMB_WIDTH: f32 = 7.0;
const THUMB_INSET: f32 = 3.0;
const THUMB_MIN: f32 = 24.0;
/// Drag-select past the edge scrolls a row this often.
const AUTO_SCROLL_MS: u64 = 40;

impl TreeView {
    /// (viewport height, content height, scroll top) of the rows.
    fn scroll_metrics(&self) -> (f32, f32, f32) {
        let view = self
            .scroll
            .0
            .borrow()
            .base_handle
            .bounds()
            .size
            .height
            .as_f32();
        let content = self.rows.len() as f32 * look::TREE_ROW_HEIGHT;
        (view, content, self.scroll_top().1)
    }

    /// The thumb's (top, height) in the list, None when everything fits.
    fn thumb(&self) -> Option<(f32, f32)> {
        let (view, content, top) = self.scroll_metrics();
        if view <= 0. || content <= view + 0.5 {
            return None;
        }
        let h = (view * view / content).max(THUMB_MIN).min(view);
        let y = top / (content - view) * (view - h);
        Some((y.clamp(0., view - h), h))
    }

    /// Window position of the scrollbar thumb's center (shown or not), None when all rows fit.
    pub fn thumb_center(&self) -> Option<gpui_kit::Point<gpui_kit::Pixels>> {
        let (y, h) = self.thumb()?;
        let island = self.scx.geometry().layout.tree?;
        // the rows' container: under the header, the search field (with its margin) or the pad
        let above = HEADER
            + TOP_PAD
            + if self.search.is_some() {
                look::TREE_ROW_HEIGHT.get()
            } else {
                0.
            };
        let border = look::ISLAND_BORDER_WIDTH;
        Some(gpui_kit::point(
            island.right() - px(border + THUMB_INSET + THUMB_WIDTH / 2.),
            island.origin.y + px(border + above + y + h / 2.),
        ))
    }

    fn render_scrollbar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (y, h) = self.thumb()?;
        if !self.hovered && self.thumb_drag.is_none() {
            return None;
        }
        let dragging = self.thumb_drag.is_some();
        let pad = if self.search.is_none() { TOP_PAD } else { 0. };
        Some(
            div()
                .id("tree-scrollbar")
                .absolute()
                .top(px(y + pad))
                .right(px(THUMB_INSET))
                .w(px(THUMB_WIDTH))
                .h(px(h))
                .rounded(px(THUMB_WIDTH / 2.))
                .bg(if dragging {
                    look::SCROLLBAR_THUMB_HOVER
                } else {
                    look::SCROLLBAR_THUMB
                })
                .hover(|s| s.bg(look::SCROLLBAR_THUMB_HOVER))
                // (no occlude: the tree stays hovered, its listener below runs after this one)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|t, ev: &MouseDownEvent, _, cx| {
                        t.thumb_drag = Some((ev.position.y.as_f32(), t.scroll_top().1));
                        cx.stop_propagation();
                        cx.notify();
                    }),
                )
                .into_any_element(),
        )
    }

    fn on_thumb_move(&mut self, ev: &gpui_kit::MouseMoveEvent, cx: &mut Context<Self>) {
        let Some((y0, top0)) = self.thumb_drag else {
            return;
        };
        if ev.pressed_button != Some(MouseButton::Left) {
            self.thumb_drag = None;
            cx.notify();
            return;
        }
        let (view, content, _) = self.scroll_metrics();
        let Some((_, h)) = self.thumb() else { return };
        let per_px = (content - view) / (view - h).max(1.);
        let top = (top0 + (ev.position.y.as_f32() - y0) * per_px).clamp(0., content - view);
        self.scroll
            .0
            .borrow()
            .base_handle
            .set_offset(gpui_kit::point(px(0.), px(-top)));
        cx.stop_propagation();
        cx.notify();
    }
}

impl Render for TreeView {
    /// Mounted in the tree island (`Geometry::layout.tree`, rounded, tool window background).
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // a cloud workspace's first listing, in the background
        let unlisted = self.tree.take_unlisted();
        if !unlisted.is_empty() {
            self.relist_remote(unlisted, cx);
        }
        // active: the keyboard is here or in a popup opened from here (the row's context menu keeps
        // it blue, as WebStorm's); never while the app window is inactive (WebStorm dims it)
        let focused = (self.focus.contains_focused(window, cx)
            || crate::popups::opened_from(&self.focus, window, cx))
            && crate::editor::window_active(window);
        let n = self.rows.len();
        let search = self.render_search(focused, cx);
        // while dragging (rows / the scrollbar thumb), moves anywhere in the window count
        let dragging = self.drag_select.is_some() || self.thumb_drag.is_some();
        let this = cx.entity().downgrade();
        let tracker = dragging.then(|| {
            gpui_kit::canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let this = this.clone();
                    window.on_mouse_event(move |ev: &gpui_kit::MouseMoveEvent, phase, _, cx| {
                        if phase == gpui_kit::DispatchPhase::Bubble {
                            let _ = this.update(cx, |t, cx| t.on_tree_mouse_move(ev, cx));
                        }
                    });
                },
            )
            .absolute()
            .size_0()
        });
        let scrollbar = self.render_scrollbar(cx);
        let header = self.render_header(cx);
        div()
            .id("tree")
            .key_context("ProjectTree")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_empty_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_empty_down))
            // Finder files dropped below the rows: into the project's root
            .on_drop(cx.listener(|t, paths: &gpui_kit::ExternalPaths, _, cx| {
                t.drop_external(None, paths.paths(), cx)
            }))
            .on_hover(cx.listener(|t, hovered: &bool, _, cx| {
                t.hovered = *hovered;
                cx.notify();
            }))
            .children(tracker)
            .child(header)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|t, _, _, cx| t.on_tree_mouse_up(cx)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|t, _, _, cx| t.on_tree_mouse_up(cx)),
            )
            .children(search)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .when(self.search.is_none(), |d| d.pt(px(TOP_PAD)))
                    .child(
                        uniform_list(
                            "tree-rows",
                            n,
                            cx.processor(move |t, range: std::ops::Range<usize>, _window, cx| {
                                range
                                    .map(|ix| t.render_row(ix, focused, cx))
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .track_scroll(&self.scroll)
                        .size_full(),
                    )
                    .children(scrollbar),
            )
    }
}
