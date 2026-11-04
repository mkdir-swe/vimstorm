//! The Recent Projects… popup (menu item; WebStorm's project widget list): icon, name, path and
//! branch per project. Enter / click opens it in place of this project (closed like Close
//! Project), Shift+Enter / Shift+click alongside it (both stay open); an open one is just shown.
//! Typing filters by name (every letter; arrows, Ctrl-n / Ctrl-p move).

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseUpEvent, ParentElement as _, SharedString, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};

use super::ToolbarView;
use super::widgets::project_icon;
use crate::kit::{Icon, IconName};
use crate::kit::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, match_text,
};
use crate::look;
use crate::shell::recent::{self, RecentProject};

/// Row: 6 px above and below, lines with 2 px gaps around them (ProjectWidgetRenderer).
const ROW_PAD_Y: f32 = 6.;
const LINE_GAP: f32 = 2.;
const NAME_LINE: f32 = 16.;
const SMALL_LINE: f32 = 15.;

/// Row height: name + path (+ branch when any project has one: rows are uniform).
pub fn row_height(with_branch: bool) -> f32 {
    let lines = NAME_LINE + SMALL_LINE + if with_branch { SMALL_LINE } else { 0. };
    let n = if with_branch { 3. } else { 2. };
    2. * ROW_PAD_Y + lines + n * 2. * LINE_GAP
}

pub struct ProjectList {
    pub items: Vec<RecentProject>,
    pub toolbar: WeakEntity<ToolbarView>,
}

/// The popup's footer (WS popup ad text).
pub const HINT: &str = "Press ↩ to open in this window, ⇧↩ to open alongside";

impl ProjectList {
    fn with_branch(&self) -> bool {
        self.items.iter().any(|p| p.branch.is_some())
    }

    /// Opens row `ix`'s project: in place of this one, or `alongside` it.
    fn open(
        &self,
        ix: usize,
        alongside: bool,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        let path = self.items[ix].path.clone();
        let toolbar = self.toolbar.clone();
        window.defer(cx, move |window, cx| {
            let _ = toolbar.update(cx, |t, cx| t.open_project(path, alongside, window, cx));
        });
    }
}

impl ListSource for ProjectList {
    fn len(&self) -> usize {
        self.items.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        SharedString::from(self.items[ix].name.clone())
    }
}

impl ListDelegate for ProjectList {
    fn options(&self) -> ListOptions {
        ListOptions {
            row_height: px(row_height(self.with_branch())),
            ..ListOptions::menu()
        }
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let p = &self.items[ix];
        let fg = if row.selected && row.focused {
            look::SELECTION_TEXT
        } else {
            look::TEXT
        };
        // a dim 12 px line: the path, the branch (with the branch icon)
        let small = |text: String, icon: Option<IconName>| {
            div()
                .h(px(SMALL_LINE))
                .my(px(LINE_GAP))
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .when_some(icon, |d, i| d.child(Icon::new(i).size(px(12.))))
                .child(
                    div()
                        .min_w_0()
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(SharedString::from(text)),
                )
        };
        div()
            .size_full()
            .min_w_0()
            .flex()
            .items_start()
            // a click opens it (Shift: alongside)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, ev: &MouseUpEvent, window, cx| {
                    this.delegate.open(ix, ev.modifiers.shift, window, cx)
                }),
            )
            .py(px(ROW_PAD_Y))
            .child(div().mt(px(LINE_GAP)).mr(px(8.)).child(project_icon(
                &p.name,
                p.color,
                look::PROJECT_ICON_SIZE_POPUP,
            )))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(NAME_LINE))
                            .my(px(LINE_GAP))
                            .text_color(fg)
                            // open in the window (WS marks open projects)
                            .when(p.open, |d| d.font_weight(FontWeight::BOLD))
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(match_text(p.name.clone(), row.matches)),
                    )
                    .child(small(recent::display_path(&p.path), None))
                    .when_some(p.branch.clone(), |d, b| {
                        d.child(small(b, Some(IconName::Branch)))
                    }),
            )
            .into_any_element()
    }

    /// Shift+Enter: alongside.
    fn on_key(
        &mut self,
        key: &str,
        state: &mut ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> bool {
        if key != "<S-CR>" {
            return false;
        }
        if let Some(ix) = state.cursor() {
            self.open(ix, true, window, cx);
        }
        true
    }

    fn confirm(
        &mut self,
        ix: usize,
        _state: &ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        self.open(ix, false, window, cx);
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<ListView<Self>>) {
        let toolbar = self.toolbar.clone();
        window.defer(cx, move |window, cx| {
            let _ = toolbar.update(cx, |t, cx| t.close_popup(window, cx));
        });
    }
}
