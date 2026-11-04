//! Completion item kind icons: IntelliJ Platform node icons (intellij-community) per LSP `CompletionItemKind`
//! (`app/assets/icons/completion/`), rasterized once like `crate::kit`.

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{App, Global, ImageSource, IntoElement, Pixels, RenderImage, Styled as _, div, img};

/// The dark or the light theme's SVG, as the look in force (`theme::palette::dark`).
macro_rules! svg {
    ($name:literal) => {
        if crate::look::palette::dark() {
            &include_bytes!(concat!(
                "../../../assets/icons/completion/",
                $name,
                "_dark.svg"
            ))[..]
        } else {
            &include_bytes!(concat!("../../../assets/icons/completion/", $name, ".svg"))[..]
        }
    };
}

/// The SVG WebStorm shows for an LSP CompletionItemKind (1..25); none for text / keywords /
/// colors / operators (WebStorm draws keywords bold, without an icon).
pub fn svg(kind: u32) -> Option<&'static [u8]> {
    Some(match kind {
        2 => svg!("method"),
        3 => svg!("function"),
        4 => svg!("constructor"),
        5 | 20 => svg!("field"), // field, enum member
        6 => svg!("variable"),
        7 => svg!("class"),
        8 => svg!("interface"),
        9 => svg!("module"),
        10 => svg!("property"),
        11 | 12 | 21 => svg!("constant"), // unit, value, constant
        13 => svg!("enum"),
        15 => svg!("template"), // snippet / live template
        17 => svg!("anyType"),  // file
        18 => svg!("alias"),    // reference
        19 => svg!("folder"),
        22 => svg!("record"), // struct
        23 => svg!("lambda"), // event
        25 => svg!("type"),   // type parameter
        _ => return None,
    })
}

/// Keywords: bold label, no icon (WebStorm).
pub const KEYWORD: u32 = 14;

#[derive(Default)]
struct Cache(HashMap<(u32, bool), Option<Arc<RenderImage>>>);

impl Global for Cache {}

fn image(kind: u32, cx: &mut App) -> Option<Arc<RenderImage>> {
    let key = (kind, crate::look::palette::dark());
    if let Some(img) = cx.default_global::<Cache>().0.get(&key) {
        return img.clone();
    }
    let img = svg(kind).and_then(|bytes| {
        cx.svg_renderer()
            .render_single_frame(bytes, 1.0)
            .map_err(|e| eprintln!("[vimstorm] completion icon {kind}: {e}"))
            .ok()
    });
    cx.default_global::<Cache>().0.insert(key, img.clone());
    img
}

/// The kind's icon at `size` (an empty box of that size when it has none: the labels line up).
pub fn icon(kind: u32, size: Pixels, cx: &mut App) -> impl IntoElement {
    match image(kind, cx) {
        Some(data) => img(ImageSource::Render(data))
            .size(size)
            .flex_none()
            .into_any_element(),
        None => div().size(size).flex_none().into_any_element(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_icon_rasterizes() {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        for kind in 1..=25 {
            let has = svg(kind).is_some();
            let img = cx.update(|cx| image(kind, cx));
            assert_eq!(img.is_some(), has, "kind {kind}");
            // 16 px icons rasterized at 2x (crisp on Retina)
            if let Some(img) = img {
                let s = img.size(0);
                assert_eq!((s.width.0, s.height.0), (32, 32), "kind {kind}");
            }
        }
        assert!(svg(KEYWORD).is_none());
    }
}
