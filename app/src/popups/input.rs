//! The text field popup (`vim.ui.input`: LSP rename, the tree's rename / new file): WebStorm's
//! "New File" popup (NewItemSimplePopupPanel): the prompt as a bold centred title, a borderless
//! 32 px field on the popup background ("Name" when empty, unless the caller names its own), its text selected so typing replaces it
//! (`plugins/ui.lua`'s Select-mode trick, natively). Enter gives the text, Esc / a click outside
//! cancels. Below the caret (snacks' `relative = "cursor", row = 1`) unless placed otherwise.
//!
//! A [`Dialog`] (`vim.ui.input`'s `dialog`: the PR review's verdict) draws it as Abe's
//! prompt layer instead (`factory::layers`: 480 px, centred near the window's top, the prompt as the
//! header, a line of text, a bordered field, the keys as ad text); Enter and Esc work the same.

use std::ops::Range;

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    Point, SharedString, Styled as _, Window, deferred, div, point, px, size,
};

use super::{Done, PopupsView};
use crate::kit::TextField;
use crate::kit::{self, Anchor};
use crate::look;

/// A text field popup to open ([`super::open_input`]).
#[derive(Clone, Debug)]
pub struct Input {
    /// The header ("Rename"); empty: none.
    pub title: SharedString,
    /// Starts selected.
    pub text: String,
    pub anchor: Anchor,
    /// Drawn as Abe's prompt (a confirm with a body).
    pub dialog: Option<Dialog>,
    /// The empty field's hint; none: "Name" (the dialog's: "A body, or ⏎ for none").
    pub placeholder: Option<String>,
}

/// The dialog look's extras: a line above the field and the keys below it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub struct Dialog {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub hints: Option<String>,
}

impl Input {
    pub fn new(title: impl Into<SharedString>, text: impl Into<String>, anchor: Anchor) -> Self {
        Self {
            title: title.into(),
            text: text.into(),
            anchor,
            dialog: None,
            placeholder: None,
        }
    }
}

/// The dialog's height without its text line: header, field (with its bottom pad) and ad text.
fn dialog_height(text: bool) -> f32 {
    look::POPUP_TITLE_HEIGHT
        + if text { look::UI_FONT_SIZE + 12. } else { 0. }
        + look::INPUT_FIELD_HEIGHT
        + look::INPUT_POPUP_PADDING
        + look::POPUP_AD_HEIGHT
        + 2. * look::POPUP_BORDER_WIDTH
}

pub(super) struct InputPopup {
    pub(super) title: SharedString,
    field: Entity<TextField>,
    pub(super) done: Done<Option<String>>,
    pub(super) lua_id: Option<u64>,
    origin: Point<Pixels>,
    /// `vim.ui.input`'s `completion` kind ("file", "dir"...): Tab completes through Lua.
    pub(super) completion: Option<String>,
    /// The last completions and the one shown (Tab / Shift+Tab cycle, like `input()`'s).
    cands: Vec<String>,
    cand: Option<usize>,
    dialog: Option<Dialog>,
}

impl InputPopup {
    pub(super) fn new(
        input: Input,
        done: Done<Option<String>>,
        lua_id: Option<u64>,
        window: &mut Window,
        cx: &mut Context<PopupsView>,
    ) -> Self {
        // vim.ui.input prompts end in ": " ("New Name: "): a header has none
        let title: SharedString = input
            .title
            .trim()
            .trim_end_matches(':')
            .trim_end()
            .to_string()
            .into();
        let placeholder: SharedString = match (&input.placeholder, &input.dialog) {
            (Some(p), _) => p.clone().into(),
            (None, Some(_)) => "A body, or ⏎ for none".into(),
            (None, None) => "Name".into(),
        };
        let field = cx.new(|cx| {
            let mut f = TextField::new(cx).borderless().placeholder(placeholder);
            f.set_text(input.text, cx);
            f.select_all(cx);
            f
        });
        let mut p = Self {
            title,
            field,
            done,
            lua_id,
            origin: point(px(0.), px(0.)),
            completion: None,
            cands: Vec::new(),
            cand: None,
            dialog: input.dialog,
        };
        let viewport = window.viewport_size();
        p.origin = match &p.dialog {
            // Abe's layers: centred across, near the top (under the main toolbar)
            Some(_) => point(
                px(kit::centered(
                    crate::factory::LAYER_WIDTH,
                    viewport.width.as_f32(),
                )),
                px(look::TOOLBAR_HEIGHT + crate::factory::LAYER_TOP),
            ),
            None => kit::place(input.anchor, p.size(), viewport),
        };
        p
    }

    fn size(&self) -> gpui_kit::Size<Pixels> {
        if let Some(d) = &self.dialog {
            return size(
                px(crate::factory::LAYER_WIDTH),
                px(dialog_height(d.text.is_some())),
            );
        }
        let header = if self.title.is_empty() {
            look::INPUT_POPUP_PADDING
        } else {
            look::POPUP_TITLE_HEIGHT
        };
        size(
            px(look::INPUT_POPUP_WIDTH + 2. * look::POPUP_BORDER_WIDTH),
            px(header
                + look::INPUT_FIELD_HEIGHT
                + look::INPUT_POPUP_PADDING
                + 2. * look::POPUP_BORDER_WIDTH),
        )
    }

    pub(super) fn bounds(&self) -> Option<Bounds<Pixels>> {
        Some(Bounds::new(self.origin, self.size()))
    }

    /// The text field (typeahead types into it).
    pub(super) fn field(&self) -> Entity<TextField> {
        self.field.clone()
    }

    pub(super) fn focus(&self, window: &mut Window, cx: &mut App) {
        let handle = self.field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    /// (title, text, selected byte range)
    pub(super) fn state(&self, cx: &App) -> (String, String, Range<usize>) {
        let f = self.field.read(cx);
        (self.title.to_string(), f.text().to_string(), f.selection())
    }

    /// Tab (Shift+Tab: `back`): the next completion when one is shown, else Some(text) to ask
    /// Lua for completions of.
    pub(super) fn complete(&mut self, back: bool, cx: &mut App) -> Option<String> {
        let text = self.field.read(cx).text().to_string();
        if let Some(ix) = self.cand
            && self.cands.get(ix) == Some(&text)
        {
            let n = self.cands.len();
            let next = if back { (ix + n - 1) % n } else { (ix + 1) % n };
            self.cand = Some(next);
            let t = self.cands[next].clone();
            self.field.update(cx, |f, cx| f.set_text(t, cx));
            return None;
        }
        self.cands.clear();
        self.cand = None;
        Some(text)
    }

    /// Lua's completions for `text`: the first one goes in (unless the text changed meanwhile).
    pub(super) fn completed(&mut self, text: &str, items: Vec<String>, cx: &mut App) {
        if self.field.read(cx).text() != text || items.is_empty() {
            return;
        }
        let first = items[0].clone();
        self.cands = items;
        self.cand = Some(0);
        self.field.update(cx, |f, cx| f.set_text(first, cx));
    }

    /// The dialog look: the layers' prompt look (`factory::layers`).
    fn render_dialog(&self, d: &Dialog, cx: &mut Context<PopupsView>) -> AnyElement {
        let field = div()
            .debug_selector(|| "input-dialog-field".into())
            .mx(px(look::INPUT_FIELD_INSET - look::FIELD_PADDING_X))
            .mb(px(look::INPUT_POPUP_PADDING))
            .h(px(look::INPUT_FIELD_HEIGHT))
            .px(px(look::FIELD_PADDING_X))
            .rounded(px(look::FIELD_ARC))
            .bg(look::FIELD_BG)
            .border_1()
            .border_color(look::FIELD_BORDER)
            .flex()
            .items_center()
            .child(self.field.clone());
        let text = d.text.clone().map(|t| {
            div()
                .px(px(look::INPUT_FIELD_INSET))
                .h(px(look::UI_FONT_SIZE + 12.))
                .flex()
                .items_center()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(t))
        });
        let frame = kit::popup_frame()
            .id("input-dialog")
            .debug_selector(|| "input-dialog".into())
            .w(self.size().width)
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _: &MouseDownEvent, _, cx| cx.stop_propagation()),
            )
            .on_mouse_down_out(
                cx.listener(|this, _: &MouseDownEvent, window, cx| this.dismiss(window, cx)),
            )
            .child(kit::header(self.title.clone(), None))
            .children(text)
            .child(field)
            .child(kit::ad_text(SharedString::from(
                d.hints.clone().unwrap_or_default(),
            )));
        deferred(kit::placed(Anchor::Point(self.origin), frame))
            .with_priority(super::PRIORITY)
            .into_any_element()
    }

    pub(super) fn render(&self, cx: &mut Context<PopupsView>) -> AnyElement {
        if let Some(d) = &self.dialog {
            return self.render_dialog(d, cx);
        }
        let pad = px(look::INPUT_POPUP_PADDING);
        let header = (!self.title.is_empty()).then(|| {
            kit::header(self.title.clone(), None).debug_selector(|| "input-header".into())
        });
        let frame = kit::popup_frame()
            .id("input-popup")
            .debug_selector(|| "input-popup".into())
            .w(self.size().width)
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _: &MouseDownEvent, _, cx| cx.stop_propagation()),
            )
            .on_mouse_down_out(
                cx.listener(|this, _: &MouseDownEvent, window, cx| this.dismiss(window, cx)),
            )
            .children(header)
            .child(
                // the field's own text inset is FIELD_PADDING_X: the rest of WebStorm's 13
                div()
                    .debug_selector(|| "input-field".into())
                    .h(px(look::INPUT_FIELD_HEIGHT))
                    .mt(if self.title.is_empty() { pad } else { px(0.) })
                    .mb(pad)
                    .pl(px(look::INPUT_FIELD_INSET - look::FIELD_PADDING_X))
                    .pr(px(look::INPUT_FIELD_INSET - look::FIELD_PADDING_X))
                    .flex()
                    .items_center()
                    .child(self.field.clone()),
            );
        deferred(kit::placed(Anchor::Point(self.origin), frame))
            .with_priority(super::PRIORITY)
            .into_any_element()
    }
}
