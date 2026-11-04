//! Feel vscode's Activity bar (VS Code's `activitybar`): a 48 px icon column at the window's
//! left, Explorer · Search · Source Control. Each is the VimStorm surface that does it, through
//! `config/keymap_vscode.lua` `activity(item)`: Explorer the Project tree (shown / hidden, as VS
//! Code's side bar), Search Find in Files (⌘⇧F's popup), Source Control the Git tool window (⌃⇧G).
//! The one whose surface shows is lit with VS Code's bar on its left edge.

use gpui_kit::{
    AnyElement, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _,
    px,
};

use crate::kit::{Icon, IconName};
use crate::look;

/// An Activity bar item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item {
    Explorer,
    Search,
    SourceControl,
}

impl Item {
    pub const ALL: [Item; 3] = [Item::Explorer, Item::Search, Item::SourceControl];

    /// Lua's name (`keymap_vscode.activity`).
    pub fn slug(self) -> &'static str {
        match self {
            Item::Explorer => "explorer",
            Item::Search => "search",
            Item::SourceControl => "scm",
        }
    }

    /// VS Code's tooltip: the view and its key.
    pub fn tooltip(self) -> (&'static str, &'static str) {
        match self {
            Item::Explorer => ("Explorer", "⇧⌘E"),
            Item::Search => ("Search", "⇧⌘F"),
            Item::SourceControl => ("Source Control", "⇧⌘G"),
        }
    }

    fn icon(self) -> IconName {
        match self {
            Item::Explorer => IconName::ToolWindowProject,
            Item::Search => IconName::ToolWindowFind,
            Item::SourceControl => IconName::ToolWindowVcs,
        }
    }
}

/// The bar in `bounds`; `lit(item)`: its surface shows; `press(item)` runs it.
pub fn render(
    bounds: gpui_kit::Bounds<gpui_kit::Pixels>,
    lit: impl Fn(Item) -> bool,
    press: impl Fn(Item, &mut gpui_kit::App) + Clone + 'static,
) -> AnyElement {
    let w = bounds.size.width;
    div()
        .id("activity-bar")
        .debug_selector(|| "activity-bar".into())
        .absolute()
        .left(bounds.origin.x)
        .top(bounds.origin.y)
        .w(w)
        .h(bounds.size.height)
        .flex()
        .flex_col()
        .children(Item::ALL.map(|item| {
            let on = lit(item);
            let press = press.clone();
            div()
                .id(SharedString::from(format!("activity-{}", item.slug())))
                .debug_selector(move || format!("activity-{}", item.slug()))
                .relative()
                .w(w)
                .h(w)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .opacity(if on { 1. } else { 0.6 })
                .hover(|d| d.opacity(1.))
                .tooltip({
                    let (text, key) = item.tooltip();
                    crate::kit::tooltip(text, Some(key))
                })
                .when(on, |d| {
                    d.child(
                        div()
                            .absolute()
                            .left_0()
                            .top_0()
                            .bottom_0()
                            .w(px(2.))
                            .bg(look::FOCUS_BORDER),
                    )
                })
                .child(Icon::new(item.icon()).size(px(24.)))
                .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                    cx.stop_propagation();
                    press(item, cx);
                })
        }))
        .into_any_element()
}
