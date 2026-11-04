//! The BrowserView component (`abe/packages/ui/src/runtime/browser.ts`; DS 2.0 BrowserView, Sheet
//! state): the bar (`Sheet` · its title · its `sheet://` address · version, the badges and the
//! ⌘⏎ note) over the page, which [`crate::factory::pages`] places natively in the slot under it. A
//! click on the bar is a click on the node. A `bare` one (a prototype's Preview, whose page draws
//! its own URL bar) is the page alone.

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, SharedString, Styled as _, div, prelude::FluentBuilder as _, px,
};

use super::draw::{Drawn, selector};
use super::protocol::BrowserViewProps;
use crate::look;
use crate::render::EDITOR_FONT;

/// The bar's height: a tool window header's.
const BAR_H: crate::look::Met = look::TOOL_WINDOW_HEADER_HEIGHT;

/// The bar's words, as the tests read them: `Sheet · title · address · vN · badges · action`.
pub fn bar_text(p: &BrowserViewProps) -> String {
    let mut parts = vec![p.title.clone()];
    parts.extend(p.sub.clone());
    if let Some(a) = &p.address {
        parts.push(a.clone());
    }
    if let Some(v) = p.version {
        parts.push(format!("v{v}"));
    }
    if !p.badges.is_empty() {
        parts.push(p.badges.join(" · "));
    }
    if let Some(a) = &p.action {
        parts.push(format!("{} {}", a.keys, a.label));
    }
    parts.join(" · ")
}

pub fn browser_view(id: Option<&str>, p: &BrowserViewProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("BrowserView", p.key.clone());
    if !p.bare {
        drawn.add("BrowserBar", bar_text(p));
    }
    if p.focused {
        drawn.add("BrowserFocused", p.key.clone());
    }
    let sel = selector("BrowserView", ix, id);
    let address = p.address.as_ref().map(|a| {
        let version = p.version.map(|v| format!(" · v{v}")).unwrap_or_default();
        div()
            .flex_none()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .font_family(EDITOR_FONT)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(format!("{a}{version}")))
    });
    let badge = (!p.badges.is_empty() || p.action.is_some()).then(|| {
        let mut words = p.badges.join(" · ");
        if let Some(a) = &p.action {
            if !words.is_empty() {
                words.push_str(" · ");
            }
            words.push_str(&format!("{} {}", a.keys, a.label));
        }
        div()
            .debug_selector(|| "factory-browser-badge".into())
            .flex_none()
            .h(px(20.))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(look::ABE_CARD_ARC))
            .bg(look::abe_badge_bg(look::ABE_GOOD.rgba()))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::ABE_GOOD)
            .whitespace_nowrap()
            .child(SharedString::from(words))
    });
    let mut bar = div()
        .flex_none()
        .h(px(BAR_H.get()))
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .border_b_1()
        .border_color(look::SEPARATOR)
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(SharedString::from(p.title.clone())),
        )
        .children(p.sub.as_ref().map(|s| {
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(look::TEXT)
                .child(SharedString::from(s.clone()))
        }))
        .children(address)
        .child(div().flex_1())
        .children(badge);
    if let Some(id) = id {
        let id = id.to_owned();
        if let Some(sink) = drawn.sink.clone() {
            bar = bar.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                sink.click(id.clone(), window, cx);
            });
        }
    }
    let page = drawn
        .pages
        .get(&p.key)
        .map(|slot| slot.element(drawn.pages_shown));
    div()
        .debug_selector(move || sel)
        .size_full()
        .flex()
        .flex_col()
        .min_h_0()
        .overflow_hidden()
        .when(!p.bare, |d| d.child(bar))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .relative()
                .when(!p.bare, |d| d.rounded_b(px(look::ISLAND_ARC.get())))
                .overflow_hidden()
                .bg(look::EDITOR_BG)
                .children(page),
        )
        .into_any_element()
}
