//! "New Branch…" (WebStorm's Create New Branch dialog, as a popup under the toolbar,
//! window middle): a name
//! field checked as you type (git's ref rules, existing branches); Enter creates the branch from
//! HEAD and checks it out, Esc cancels. The Branches… popup's "New Branch from '<b>'…" creates it
//! from that branch, and its "Rename…" opens the same field holding the old name.

use std::path::PathBuf;

use gpui_kit::{
    AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription, Task,
    WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};

use super::ToolbarView;
use crate::git;
use crate::kit;
use crate::kit::{FieldEvent, TextField};
use crate::look;

/// What the form does with the name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormMode {
    /// A new branch from HEAD.
    New,
    /// A new branch from this branch.
    From(String),
    /// This local branch renamed.
    Rename(String),
}

impl FormMode {
    fn title(&self) -> String {
        match self {
            FormMode::New => "Create New Branch".into(),
            FormMode::From(b) => format!("Create New Branch from {b}"),
            FormMode::Rename(b) => format!("Rename Branch {b}"),
        }
    }

    fn hint(&self) -> &'static str {
        match self {
            FormMode::Rename(_) => "Enter to rename, Esc to cancel",
            _ => "Enter to create and check out, Esc to cancel",
        }
    }
}

pub struct NewBranchForm {
    pub mode: FormMode,
    pub field: Entity<TextField>,
    /// Why the name can't be used (shown under the field; Enter does nothing then).
    pub error: Option<String>,
    dir: PathBuf,
    local: Vec<String>,
    toolbar: WeakEntity<ToolbarView>,
    _check: Option<Task<()>>,
    _sub: Subscription,
}

impl NewBranchForm {
    pub fn new(
        mode: FormMode,
        dir: PathBuf,
        local: Vec<String>,
        toolbar: WeakEntity<ToolbarView>,
        cx: &mut Context<Self>,
    ) -> Self {
        let field = cx.new(|cx| {
            let mut f = TextField::new(cx).placeholder("New branch name");
            // Rename: the old name, selected (typing replaces it)
            if let FormMode::Rename(old) = &mode {
                f.set_text(old.clone(), cx);
                f.select_all(cx);
            }
            f
        });
        let sub = cx.subscribe(&field, |this, _, _: &FieldEvent, cx| this.check(cx));
        Self {
            mode,
            field,
            error: None,
            dir,
            local,
            toolbar,
            _check: None,
            _sub: sub,
        }
    }

    pub fn name(&self, cx: &gpui_kit::App) -> String {
        self.field.read(cx).text().trim().to_owned()
    }

    /// Validates the name off the UI thread (`git check-ref-format`).
    fn check(&mut self, cx: &mut Context<Self>) {
        let name = self.name(cx);
        let (dir, local) = (self.dir.clone(), self.local.clone());
        let task = cx
            .background_executor()
            .spawn(async move { git::validate_new(&dir, &name, &local) });
        self._check = Some(cx.spawn(async move |this, cx| {
            let error = task.await;
            let _ = this.update(cx, |f, cx| {
                f.error = error;
                cx.notify();
            });
        }));
    }

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let toolbar = self.toolbar.clone();
        match kit::notation(ev).as_deref() {
            Some("<CR>") => {
                cx.stop_propagation();
                let name = self.name(cx);
                if name.is_empty() || self.error.is_some() {
                    return;
                }
                let mode = self.mode.clone();
                window.defer(cx, move |window, cx| {
                    let _ = toolbar.update(cx, |t, cx| t.branch_form_done(mode, name, window, cx));
                });
            }
            Some("<Esc>") => {
                cx.stop_propagation();
                window.defer(cx, move |window, cx| {
                    let _ = toolbar.update(cx, |t, cx| t.close_popup(window, cx));
                });
            }
            _ => {}
        }
    }
}

impl Focusable for NewBranchForm {
    fn focus_handle(&self, cx: &gpui_kit::App) -> FocusHandle {
        self.field.read(cx).focus_handle(cx)
    }
}

/// Popup width.
pub const WIDTH: f32 = 340.;

impl Render for NewBranchForm {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .debug_selector(|| "toolbar-new-branch".into())
            .w(px(WIDTH))
            .flex()
            .flex_col()
            .on_key_down(cx.listener(Self::on_key_down))
            .child(kit::header(SharedString::from(self.mode.title()), None))
            .child(
                div()
                    .px(px(look::POPUP_HEADER_PADDING_X))
                    .pt(px(4.))
                    .pb(px(look::POPUP_PADDING_Y))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(self.field.clone())
                    .when_some(self.error.clone(), |d, e| {
                        d.child(
                            div()
                                .text_size(px(look::UI_SMALL_FONT_SIZE))
                                .text_color(look::TEXT_ERROR)
                                .child(SharedString::from(e)),
                        )
                    }),
            )
            .child(kit::ad_text(self.mode.hint()))
    }
}
