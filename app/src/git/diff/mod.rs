//! Diff / merge viewer chrome: the viewer's panes stay nvim windows (`git/diff.lua`,
//! `git/merge.lua`: buffers, highlights, revert / accept / ignore); this layer draws the WebStorm
//! chrome around and between their grids from Lua's viewer description (`vimstorm.diff`,
//! `config/app/diff.lua`) and routes chrome clicks back to Lua's actions.
//!
//! - Layout ([`crate::shell::ViewerRect`]): the panes share one island; a toolbar row
//!   over them, a title per pane, a 30 px divider between neighbours, the first pane mirrored
//!   (marks strip left, gutter right), the merge window's button row at the bottom. The grids
//!   keep their columns: the gutters of the other panes cover blank statuscolumn cells.
//! - Toolbar, titles, buttons: GPUI elements here (they don't scroll).
//! - Gutters, connectors, gap lines, scrollbar marks: [`chrome`], a canvas reading the frame's
//!   drawn grids (no drift while the panes smooth-scroll / are held for their sync partners).
//! - The panes scroll together in one frame through the editor's sync groups
//!   ([`crate::nvim`]); the wheel over the chrome scrolls the nearest pane.

mod cards;
mod chrome;
mod model;
mod rows;

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{
    App, Bounds, Context, CursorStyle, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};
use rmpv::Value;

use crate::kit::{Axis, IconButton, TextButton, toolbar, toolbar_separator};
use crate::kit::{Icon, IconName};
use crate::look;
use crate::nvim::lua;
use crate::render::UI_FONT;
use crate::shell::ViewerRect;
use crate::shell::{Surface, SurfaceCx};

pub use chrome::{Frame, PaneFrame, kind_bg};
pub use model::{ChangeKind, GutterIcon, Viewer, ViewerKind};
use model::{DiffEvent, Title};

pub struct DiffView {
    scx: SurfaceCx,
    focus: FocusHandle,
    viewer: Option<Rc<Viewer>>,
    /// A description waiting for the nvim flush that shows its panes (Lua sends it while it
    /// changes the windows, before nvim flushes them): (description or close, flushes then).
    pending: Option<(Option<Rc<Viewer>>, u64)>,
    recorder: chrome::Recorder,
    /// A PR diff follows its review (the scope, the Reviewed tick).
    review_sub: Option<gpui_kit::Subscription>,
    /// The rows told Lua each review card needs (by its key), so each is told once.
    told_rows: std::collections::HashMap<String, i64>,
}

/// Longest a description waits for its flush (nothing to redraw: shown anyway).
const PENDING_MAX: std::time::Duration = std::time::Duration::from_millis(50);

impl DiffView {
    pub fn scx(&self) -> &SurfaceCx {
        &self.scx
    }

    /// The open viewer's description (tests).
    pub fn viewer(&self) -> Option<&Viewer> {
        self.viewer.as_deref()
    }

    /// The chrome as the current geometry / drawn grids lay it out: panes, rows, icons (tests).
    pub fn frame(&self, cx: &App) -> Option<chrome::Frame> {
        let v = self.viewer.as_ref()?;
        let panes = chrome::panes(&self.scx, v, cx);
        let icons = chrome::icons(v, &panes);
        Some(chrome::Frame { panes, icons })
    }

    fn flushes(&self, cx: &App) -> u64 {
        self.scx
            .workspace
            .upgrade()
            .map_or(0, |ws| ws.read(cx).editor().read(cx).ui().flushes)
    }

    /// The pending description becomes the shown one once nvim flushed after it (or `force`).
    fn promote(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some((_, at)) = &self.pending else {
            return;
        };
        if force || self.flushes(cx) > *at {
            self.viewer = self.pending.take().and_then(|p| p.0);
            cx.notify();
        }
    }

    /// Starts (true) / stops recording what each frame shows (tests: frames mixing two files).
    pub fn record_frames(&self, on: bool) {
        *self.recorder.borrow_mut() = on.then(Vec::new);
    }

    /// The frames recorded since [`DiffView::record_frames`].
    pub fn recorded_frames(&self) -> Vec<chrome::FrameRecord> {
        self.recorder.borrow().clone().unwrap_or_default()
    }

    fn act(&self, name: &str, args: Vec<Value>) {
        let generation = self.viewer.as_ref().map_or(0, |v| v.generation);
        chrome::act(&self.scx, generation, name, args);
    }
}

impl Surface for DiffView {
    const NAME: &'static str = "diff";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        DiffView {
            scx,
            focus: cx.focus_handle(),
            viewer: None,
            pending: None,
            recorder: Default::default(),
            review_sub: None,
            told_rows: Default::default(),
        }
    }

    fn on_lua(&mut self, payload: Value, _window: &mut Window, cx: &mut Context<Self>) {
        let next = match lua::decode::<DiffEvent>(Self::NAME, payload) {
            Some(DiffEvent::Viewer(v)) => Some(Rc::new(*v)),
            Some(DiffEvent::Close) => None,
            None => return,
        };
        // only the toolbar changed (a toggle, a dropdown, the count): nothing in the panes to
        // wait for; shown at once (the flush after it may already have been applied: under load
        // nvim's redraw can be taken before this notification)
        let chrome_only = self.pending.is_none()
            && match (&self.viewer, &next) {
                (Some(cur), Some(n)) => {
                    cur.viewer == n.viewer && cur.panes == n.panes && cur.dividers == n.dividers
                }
                _ => false,
            };
        if chrome_only {
            self.viewer = next;
            cx.notify();
            return;
        }
        // a diff opened from a maximized tool window (the Git Log's ⏎): the usual layout back, so
        // the diff is not left behind it
        if self.viewer.is_none() && self.pending.is_none() && next.is_some() {
            let ws = self.scx.workspace.clone();
            cx.defer(move |cx| {
                let _ = ws.update(cx, |ws, cx| {
                    if ws
                        .maximized(cx)
                        .is_some_and(|i| !matches!(i, crate::shell::Island::Split(_)))
                    {
                        ws.restore_maximized(cx);
                    }
                });
            });
        }
        // shown with the flush that draws its panes, never a frame before (new file index over
        // the old file's text)
        let flushes = self.flushes(cx);
        self.pending = Some((next, flushes));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PENDING_MAX).await;
            let _ = this.update(cx, |v, cx| {
                if v.pending.as_ref().is_some_and(|p| p.1 == flushes) {
                    v.promote(true, cx);
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Focusable for DiffView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// An absolutely placed box at window coordinates.
fn slot(b: Bounds<Pixels>) -> gpui_kit::Div {
    div()
        .absolute()
        .left(b.origin.x)
        .top(b.origin.y)
        .w(b.size.width)
        .h(b.size.height)
}

/// Inter 13 label.
fn label(text: impl Into<SharedString>, color: impl Into<gpui_kit::Hsla>) -> gpui_kit::Div {
    div()
        .flex_none()
        .font_family(UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(color.into())
        .whitespace_nowrap()
        .child(text.into())
}

/// A toolbar combo box (WS ComboBoxAction in a toolbar: text + chevron, hover background); the
/// click opens Lua's menu of choices below it.
fn dropdown(scx: &SurfaceCx, name: &'static str, text: &str) -> impl IntoElement {
    let bounds = Rc::new(Cell::new(Bounds::default()));
    let b2 = bounds.clone();
    let scx = scx.clone();
    div()
        .id(SharedString::from(format!("diff-dropdown-{name}")))
        .debug_selector(move || format!("diff-dropdown-{name}"))
        .relative()
        .flex_none()
        .h(px(look::ACTION_BUTTON_SIZE))
        .pl(px(6.))
        .pr(px(2.))
        .flex()
        .items_center()
        .gap(px(2.))
        .rounded(px(look::ACTION_BUTTON_ARC))
        .cursor(CursorStyle::PointingHand)
        .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
        .active(|s| s.bg(look::ACTION_BUTTON_PRESSED_BG))
        .child(label(text.to_owned(), look::TEXT))
        .child(Icon::new(IconName::ChevronDown))
        .child(
            canvas(move |b, _, _| b2.set(b), |_, _, _, _| {})
                .absolute()
                .size_full(),
        )
        .on_click(move |_, _, cx| {
            cx.stop_propagation();
            let b = bounds.get();
            scx.call(
                "config.app.diff",
                "dropdown",
                vec![
                    name.into(),
                    b.left().as_f32().into(),
                    (b.bottom().as_f32() + 2.).into(),
                ],
            );
        })
}

/// Width of an Inter 13 label.
fn text_width(text: &str, window: &Window) -> f32 {
    let mut font = window.text_style().font();
    font.family = UI_FONT.into();
    crate::kit::width(window, text, font, px(look::UI_FONT_SIZE)).as_f32()
}

/// Toolbar pitch of an icon button / a separator / a dropdown with `text`.
const ICON_PITCH: f32 = look::ACTION_BUTTON_SIZE + look::ACTION_BUTTON_GAP;
const SEP_PITCH: f32 =
    look::SEPARATOR_WIDTH + 2. * look::TOOLBAR_SEPARATOR_MARGIN + look::ACTION_BUTTON_GAP;
fn dropdown_pitch(text: &str, window: &Window) -> f32 {
    6. + text_width(text, window) + 2. + look::ICON_SIZE + 2. + look::ACTION_BUTTON_GAP
}

/// Which dropdowns fit the toolbar (WS drops toolbar actions that don't fit; the Lua toolbar
/// dropped the viewer one first, then whitespace, then highlighting): `fixed` = the rest's width.
fn fitting(texts: &[&str], fixed: f32, width: f32, window: &Window) -> usize {
    let w: Vec<f32> = texts.iter().map(|t| dropdown_pitch(t, window)).collect();
    // keep the last `n` (the first ones go first)
    (0..=texts.len())
        .rev()
        .find(|&n| fixed + SEP_PITCH + w[texts.len() - n..].iter().sum::<f32>() <= width || n == 0)
        .unwrap_or(0)
}

/// WS `diff.count.differences.status.text`.
pub fn differences_text(n: i64) -> String {
    match n {
        0 => "No differences".into(),
        1 => "1 difference".into(),
        n => format!("{n} differences"),
    }
}

/// WS `merge.differences.status.text`: "2 changes. 1 conflict.", "No changes. No conflicts.".
pub fn merge_status_text(changes: i64, conflicts: i64) -> String {
    let count = |n: i64, one: &str| match n {
        0 => format!("No {one}s"),
        1 => format!("1 {one}"),
        n => format!("{n} {one}s"),
    };
    format!(
        "{}. {}.",
        count(changes, "change"),
        count(conflicts, "conflict")
    )
}

/// A pane's title: lock, hash, path (dim) or a text.
fn title(t: &Title, pane: usize) -> gpui_kit::Div {
    let mut row = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(px(4.))
        .overflow_hidden();
    if t.lock {
        row = row.child(Icon::new(IconName::Locked));
    }
    if let Some(hash) = &t.hash {
        row = row.child(
            label(hash.clone(), look::DIFF_TITLE_FG)
                .debug_selector(move || format!("diff-title-hash-{pane}")),
        );
    }
    if let Some(path) = &t.path {
        row = row.child(
            label(path.clone(), look::DIFF_TITLE_DIM_FG)
                .flex_shrink(1.)
                .min_w_0()
                .ml(px(4.))
                .overflow_hidden()
                .text_ellipsis(),
        );
    }
    if let Some(text) = &t.text {
        row = row.child(
            label(text.clone(), look::DIFF_TITLE_FG)
                .flex_shrink(1.)
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis(),
        );
    }
    row
}

impl DiffView {
    /// The PR under review whose diff this is (the workspace's Git window review).
    fn review(
        &self,
        t: &model::Toolbar,
        cx: &App,
    ) -> Option<gpui_kit::Entity<crate::git::window::PrReview>> {
        let bar = t.review.as_ref()?;
        let ws = self.scx.workspace.upgrade()?;
        let review = ws.read(cx).git().read(cx).review().clone();
        (review.read(cx).number() == Some(bar.pr)).then_some(review)
    }

    /// A PR diff's toolbar part (G25): `#n`, the scope switch (its pick), ‹ › the commit before /
    /// after, the Reviewed tick for the file shown. Its width for the fitting.
    fn review_part(
        &mut self,
        t: &model::Toolbar,
        cx: &mut Context<Self>,
    ) -> Option<(gpui_kit::AnyElement, f32)> {
        let bar = t.review.clone()?;
        let review = self.review(t, cx)?;
        if self.review_sub.is_none() {
            self.review_sub = Some(cx.observe(&review, |_, _, cx| cx.notify()));
        }
        let (label_text, reviewed, prev, next) = {
            let r = review.read(cx);
            (
                r.scope_label(cx)?,
                r.reviewed(&bar.path, cx),
                r.stepped(-1, cx),
                r.stepped(1, cx),
            )
        };
        let path = bar.path.clone();
        let menu_review = review.downgrade();
        let bounds = Rc::new(Cell::new(Bounds::default()));
        let b2 = bounds.clone();
        let scope = div()
            .id("diff-pr-scope")
            .debug_selector(|| "diff-pr-scope".into())
            .relative()
            .flex_none()
            .h(px(look::ACTION_BUTTON_SIZE))
            .pl(px(6.))
            .pr(px(2.))
            .flex()
            .items_center()
            .gap(px(2.))
            .rounded(px(look::ACTION_BUTTON_ARC))
            .cursor(CursorStyle::PointingHand)
            .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
            .child(
                label(label_text.clone(), look::TEXT).font_weight(gpui_kit::FontWeight::SEMIBOLD),
            )
            .child(Icon::new(IconName::ChevronDown))
            .child(
                canvas(move |b, _, _| b2.set(b), |_, _, _, _| {})
                    .absolute()
                    .size_full(),
            )
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                let anchor = crate::kit::Anchor::Below(bounds.get());
                let path = path.clone();
                let _ = menu_review.update(cx, |r, cx| r.scope_menu(path, anchor, window, cx));
            });
        let step =
            |id: &'static str, icon: IconName, tip: &'static str, to: Option<Vec<String>>| {
                let review = review.downgrade();
                let path = bar.path.clone();
                IconButton::new(id, icon)
                    .tooltip(tip, None)
                    .disabled(to.is_none())
                    .on_click(move |_, _, cx| {
                        if let Some(to) = to.clone() {
                            let _ = review.update(cx, |r, cx| r.rescope(to, &path, cx));
                        }
                    })
            };
        let tick = {
            let review = review.downgrade();
            let path = bar.path.clone();
            crate::kit::Checkbox::new(
                "diff-pr-reviewed",
                if reviewed == Some(true) {
                    crate::kit::CheckState::Checked
                } else {
                    crate::kit::CheckState::Unchecked
                },
            )
            .label("Reviewed")
            .disabled(reviewed.is_none())
            .on_toggle(move |_, _, cx| {
                let _ = review.update(cx, |r, cx| r.toggle_reviewed(&path, cx));
            })
        };
        let tick = div()
            .flex_none()
            .debug_selector(|| "diff-pr-reviewed".into())
            .child(tick);
        let num = format!("#{}", bar.pr);
        let width = SEP_PITCH
            + 7. * num.len() as f32
            + 8.
            + 30.
            + 7. * label_text.chars().count() as f32
            + 2. * ICON_PITCH
            + SEP_PITCH
            + 100.;
        let part = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(look::ACTION_BUTTON_GAP))
            .child(toolbar_separator(Axis::Horizontal))
            .child(
                div()
                    .debug_selector(|| "diff-pr-number".into())
                    .flex_none()
                    .font_family(crate::render::EDITOR_FONT)
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::ABE_ACCENT)
                    .child(num),
            )
            .child(scope)
            .child(step(
                "diff-pr-prev",
                IconName::ChevronLeft,
                "Previous commit",
                prev,
            ))
            .child(step(
                "diff-pr-next",
                IconName::ChevronRight,
                "Next commit",
                next,
            ))
            .child(toolbar_separator(Axis::Horizontal))
            .child(tick)
            .into_any_element();
        Some((part, width))
    }

    fn button(
        &self,
        id: &'static str,
        icon: IconName,
        tip: &str,
        key: Option<&str>,
        action: &'static str,
        cx: &mut Context<Self>,
    ) -> IconButton {
        IconButton::new(id, icon)
            .tooltip(tip.to_owned(), key)
            .on_click(cx.listener(move |v, _, _, _| v.act(action, vec![])))
    }

    /// Collapse Unchanged Fragments / Synchronize Scrolling (SimpleDiffViewer's toggles; the ⚙
    /// editor settings stay out: nothing to set there).
    fn view_toggles(&self, t: &model::Toolbar, cx: &mut Context<Self>) -> [IconButton; 2] {
        [
            self.button(
                "diff-collapse",
                IconName::CollapseAll,
                "Collapse Unchanged Fragments",
                None,
                "collapse",
                cx,
            )
            .toggled(t.collapsed),
            self.button(
                "diff-sync",
                IconName::SynchronizeScrolling,
                "Synchronize Scrolling",
                None,
                "sync_scroll",
                cx,
            )
            .toggled(t.synced),
        ]
    }

    fn toolbar(
        &mut self,
        v: &Viewer,
        rect: &ViewerRect,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let t = &v.toolbar;
        let close_w = ICON_PITCH + 8. + 2. * look::ACTION_TOOLBAR_PAD_X;
        let width = rect.toolbar.size.width.as_f32() - close_w - 12.;
        let mut left = toolbar(Axis::Horizontal)
            .flex_shrink(1.)
            .min_w_0()
            .overflow_hidden();
        let right = match v.viewer {
            ViewerKind::Diff => {
                left = left
                    .child(self.button(
                        "diff-prev",
                        IconName::PreviousDifference,
                        "Previous Difference",
                        Some("⌘L"),
                        "prev",
                        cx,
                    ))
                    .child(self.button(
                        "diff-next",
                        IconName::NextDifference,
                        "Next Difference",
                        Some("⌘Ö"),
                        "next",
                        cx,
                    ))
                    .child(self.button(
                        "diff-edit",
                        IconName::Edit,
                        "Open in Editor",
                        Some("F4"),
                        "open_in_editor",
                        cx,
                    ))
                    .child(toolbar_separator(Axis::Horizontal))
                    .child(self.button(
                        "diff-prev-file",
                        IconName::PreviousFile,
                        "Compare Previous File",
                        Some("⌥⌘←"),
                        "prev_file",
                        cx,
                    ))
                    .child(self.button(
                        "diff-next-file",
                        IconName::NextFile,
                        "Compare Next File",
                        Some("⌥⌘→"),
                        "next_file",
                        cx,
                    ));
                // WS DiffRequestProcessor: navigation + the viewer combo in one block, then the
                // viewer's own actions (ignore, highlight, collapse, sync) after a separator
                // (`fitting` adds the second separator)
                let mut fixed = 7. * ICON_PITCH + SEP_PITCH;
                if let Some((i, n)) = t.files.filter(|f| f.1 > 1) {
                    let text = format!("{i}/{n}");
                    fixed += text_width(&text, window) + look::ACTION_BUTTON_GAP;
                    left = left.child(
                        label(text, look::TEXT_DIM).debug_selector(|| "diff-file-index".into()),
                    );
                }
                if let Some(part) = self.review_part(t, cx) {
                    fixed += part.1;
                    left = left.child(part.0);
                }
                let count = differences_text(t.differences.unwrap_or(0));
                let names = ["viewer", "ignore", "highlight"];
                let texts = [
                    "Side-by-side viewer",
                    t.ignore.as_str(),
                    t.highlight.as_str(),
                ];
                let keep = fitting(&texts, fixed, width - text_width(&count, window), window);
                if keep == names.len() {
                    left = left.child(dropdown(&self.scx, names[0], texts[0]));
                }
                left = left.child(toolbar_separator(Axis::Horizontal));
                for i in (names.len() - keep).max(1)..names.len() {
                    left = left.child(dropdown(&self.scx, names[i], texts[i]));
                }
                left = left.children(self.view_toggles(t, cx));
                label(count, look::TEXT)
                    .debug_selector(|| "diff-count".into())
                    .into_any_element()
            }
            ViewerKind::Merge => {
                let simple = t.simple.unwrap_or(0) > 0;
                let done = "All non-conflicting changes are already applied";
                let apply_label = "Apply non-conflicting changes:";
                left = left
                    .child(self.button(
                        "diff-prev",
                        IconName::PreviousDifference,
                        "Previous Change",
                        Some("⌘L"),
                        "prev",
                        cx,
                    ))
                    .child(self.button(
                        "diff-next",
                        IconName::NextDifference,
                        "Next Change",
                        Some("⌘Ö"),
                        "next",
                        cx,
                    ))
                    .child(toolbar_separator(Axis::Horizontal))
                    // MergeThreesideViewer: a named separator before the apply actions
                    .child(
                        label(apply_label, look::TEXT_DIM)
                            .debug_selector(|| "merge-apply-label".into())
                            .mr(px(look::ACTION_BUTTON_GAP)),
                    )
                    .child(
                        IconButton::new("merge-apply-left", IconName::ApplyNonConflictsLeft)
                            .disabled(true)
                            .tooltip(done, None),
                    )
                    .child(
                        IconButton::new("merge-apply-all", IconName::ApplyNonConflicts)
                            .disabled(true)
                            .tooltip(done, None),
                    )
                    .child(
                        IconButton::new("merge-apply-right", IconName::ApplyNonConflictsRight)
                            .disabled(true)
                            .tooltip(done, None),
                    )
                    .child(
                        self.button(
                            "merge-magic",
                            IconName::MagicResolve,
                            "Resolve Simple Conflicts",
                            None,
                            "magic_all",
                            cx,
                        )
                        .disabled(!simple),
                    );
                let (changes, conflicts) = (t.changes.unwrap_or(0), t.conflicts.unwrap_or(0));
                let status = merge_status_text(changes, conflicts);
                let resolved = changes == 0 && conflicts == 0;
                let fixed = 8. * ICON_PITCH
                    + SEP_PITCH
                    + text_width(apply_label, window)
                    + look::ACTION_BUTTON_GAP;
                let status_w =
                    text_width(&status, window) + if resolved { look::ICON_SIZE + 4. } else { 0. };
                let names = ["ignore", "highlight"];
                let texts = [t.ignore.as_str(), t.highlight.as_str()];
                let keep = fitting(&texts, fixed, width - status_w, window);
                left = left.child(toolbar_separator(Axis::Horizontal));
                for i in names.len() - keep..names.len() {
                    left = left.child(dropdown(&self.scx, names[i], texts[i]));
                }
                left = left.children(self.view_toggles(t, cx));
                // done: green with WS's check mark
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .when(resolved, |d| d.child(Icon::new(IconName::GreenCheckmark)))
                    .child(
                        label(
                            status,
                            if resolved {
                                look::MERGE_DONE_FG
                            } else {
                                look::TEXT
                            },
                        )
                        .debug_selector(|| "diff-count".into()),
                    )
                    .into_any_element()
            }
        };
        slot(rect.toolbar)
            .id("diff-toolbar")
            .flex()
            .items_center()
            .justify_between()
            .px(px(look::ACTION_TOOLBAR_PAD_X.get()))
            .bg(look::PANEL_BG)
            .border_b_1()
            .border_color(look::FRAME_BG)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(left)
            .child(
                toolbar(Axis::Horizontal)
                    .pl(px(8.))
                    .child(right)
                    .child(self.button(
                        "diff-close",
                        IconName::Close,
                        "Close",
                        Some(",w"),
                        "close",
                        cx,
                    )),
            )
    }

    /// The merge window's button row. Too narrow: Accept Right, then Accept Left, then Cancel go
    /// (Lua dropped Accept Left / Right first; Apply always stays).
    fn buttons(
        &self,
        b: Bounds<Pixels>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        const GAP: f32 = 8.;
        const PAD: f32 = 12.;
        let all = [
            ("merge-accept-left", "Accept Left", "accept_left"),
            ("merge-accept-right", "Accept Right", "accept_right"),
            ("merge-cancel", "Cancel", "cancel"),
            ("merge-apply", "Apply", "apply"),
        ];
        let width = |text: &str| {
            (text_width(text, window) + 2. * look::BUTTON_PAD_X + 2.).max(look::BUTTON_MIN_WIDTH)
        };
        let room = b.size.width.as_f32() - 2. * PAD;
        // shown: indices into `all`, dropped from the front of `order`
        let order = [1, 0, 2];
        let mut shown = vec![0, 1, 2, 3];
        let total = |shown: &[usize]| {
            shown.iter().map(|&i| width(all[i].1)).sum::<f32>()
                + GAP * shown.len().saturating_sub(1) as f32
                + if shown.contains(&0) || shown.contains(&1) {
                    GAP
                } else {
                    0.
                }
        };
        for drop in order {
            if total(&shown) <= room {
                break;
            }
            shown.retain(|&i| i != drop);
        }
        let btn = |i: usize, cx: &mut Context<Self>| {
            let (id, text, action) = all[i];
            TextButton::new(id, text)
                .primary(action == "apply")
                .on_click(cx.listener(move |v, _, _, _| v.act(action, vec![])))
        };
        let mut left = div().flex().gap(px(GAP));
        let mut right = div().flex().gap(px(GAP));
        for &i in &shown {
            if i < 2 {
                left = left.child(btn(i, cx));
            } else {
                right = right.child(btn(i, cx));
            }
        }
        slot(b)
            .flex()
            .items_center()
            .justify_between()
            .px(px(PAD))
            .bg(look::PANEL_BG)
            .border_t_1()
            .border_color(look::FRAME_BG)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(left)
            .child(right)
    }
}

impl Render for DiffView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.promote(false, cx);
        let Some(v) = self.viewer.clone() else {
            return div();
        };
        let geo = self.scx.geometry();
        let rects: Vec<(usize, ViewerRect, i64)> = v
            .panes
            .iter()
            .enumerate()
            .filter_map(|(i, p)| Some((i, geo.win_rect(p.win)?.viewer?, p.win)))
            .collect();
        let Some((_, first, _)) = rects.first().copied() else {
            return div();
        };
        let mut root = div().absolute().top_0().left_0().size_full();
        root = root.child(self.toolbar(&v, &first, window, cx));
        for (i, r, win) in &rects {
            let scx = self.scx.clone();
            let (i, win) = (*i, *win);
            root = root.child(
                slot(r.header)
                    .id(("diff-title", i))
                    .debug_selector(move || format!("diff-title-{}", i + 1))
                    .flex()
                    .items_center()
                    .px(px(look::DIFF_TITLE_PAD_X))
                    .bg(look::PANEL_BG)
                    .border_b_1()
                    .border_color(look::FRAME_BG)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_mouse_down(MouseButton::Right, move |ev, _, cx| {
                        cx.stop_propagation();
                        scx.call(
                            "config.app.diff",
                            "menu",
                            vec![
                                win.into(),
                                0.into(),
                                ev.position.x.as_f32().into(),
                                ev.position.y.as_f32().into(),
                            ],
                        );
                    })
                    .child(title(&v.panes[i].title, i + 1)),
            );
            // the divider's part of the title row continues the titles' background
            if let Some(d) = r.divider {
                let mut b = d;
                b.size.height = r.header.size.height;
                root = root.child(
                    slot(b)
                        .bg(look::PANEL_BG)
                        .border_b_1()
                        .border_color(look::FRAME_BG),
                );
            }
        }
        if let Some(b) = first.buttons {
            root = root.child(self.buttons(b, window, cx));
        }
        let root = root.child(chrome::layer(
            self.scx.clone(),
            v.clone(),
            self.recorder.clone(),
        ));
        // a PR diff's review cards over the blank rows kept for them (G15 / G22)
        let cards: Vec<gpui_kit::AnyElement> = match self.review(&v.toolbar, cx) {
            Some(review) if v.panes.iter().any(|p| !p.cards.is_empty()) => {
                if self.review_sub.is_none() {
                    self.review_sub = Some(cx.observe(&review, |_, _, cx| cx.notify()));
                }
                let frame = self.frame(cx).map(|f| f.panes).unwrap_or_default();
                // the rows each card needs at this pane's width: Lua keeps that many
                if let Some(model) = review.read(cx).model(cx) {
                    for pf in &frame {
                        let Some(p) = v.panes.get(pf.pane - 1) else {
                            continue;
                        };
                        for slot in &p.cards {
                            let width = pf.grid_x.1 - pf.grid_x.0;
                            let rows = match slot.kind.as_str() {
                                "writing" => review.read(cx).writing().map(|w| {
                                    cards::writing_rows(&w.text(cx), width, pf.rows.row_height)
                                }),
                                _ => cards::needed_rows(slot, width, pf.rows.row_height, &model),
                            };
                            let (Some(key), Some(rows)) = (cards::key_of(slot), rows) else {
                                continue;
                            };
                            if rows != slot.rows && self.told_rows.get(&key) != Some(&rows) {
                                self.told_rows.insert(key.clone(), rows);
                                self.scx.call(
                                    "config.app.review",
                                    "card_rows",
                                    vec![key.into(), rows.into()],
                                );
                            }
                        }
                    }
                }
                let drawn: Vec<gpui_kit::AnyElement> = frame
                    .iter()
                    .filter_map(|pf| {
                        let slots = &v.panes.get(pf.pane - 1)?.cards;
                        Some(cards::render(pf, slots, &self.scx, &review, cx))
                    })
                    .flatten()
                    .collect();
                // the writing card drawn: its field takes the keyboard (G21)
                let writing_drawn = v
                    .panes
                    .iter()
                    .any(|p| p.cards.iter().any(|c| c.kind == "writing"));
                if writing_drawn && review.read(cx).writing().is_some_and(|w| w.wants_focus()) {
                    review.update(cx, |r, cx| r.focus_writing(window, cx));
                }
                drawn
            }
            _ => Vec::new(),
        };
        // the cards under the view's focus: a card's field focused, the view is the surface
        // with the keyboard (the shell's keys then leave its text alone: Space types a space).
        // Zero-sized, so a click elsewhere never takes the keyboard from nvim.
        root.child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_0()
                .track_focus(&self.focus)
                .children(cards),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_texts_follow_diff_bundle() {
        assert_eq!(differences_text(0), "No differences");
        assert_eq!(differences_text(1), "1 difference");
        assert_eq!(differences_text(3), "3 differences");
        assert_eq!(merge_status_text(0, 2), "No changes. 2 conflicts.");
        assert_eq!(merge_status_text(1, 1), "1 change. 1 conflict.");
        assert_eq!(merge_status_text(0, 0), "No changes. No conflicts.");
    }
}
