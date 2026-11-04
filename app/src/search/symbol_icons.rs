//! Symbol kind icons for Search Everywhere's Symbols tab: WebStorm's node icons
//! (`app/assets/icons/completion/`, the same SVGs the completion menu shows) per LSP SymbolKind,
//! rasterized once like `crate::kit`.

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{
    AnyElement, App, Global, ImageSource, IntoElement, ParentElement as _, RenderImage,
    Styled as _, div, img, px,
};

use crate::look;

/// The dark or the light theme's SVG, as the look in force (`look::palette::dark`).
macro_rules! svg {
    ($name:literal) => {
        if crate::look::palette::dark() {
            &include_bytes!(concat!(
                "../../assets/icons/completion/",
                $name,
                "_dark.svg"
            ))[..]
        } else {
            &include_bytes!(concat!("../../assets/icons/completion/", $name, ".svg"))[..]
        }
    };
}

/// The SVG for an LSP SymbolKind name (`vim.lsp.protocol.SymbolKind`).
fn svg(kind: &str) -> Option<&'static [u8]> {
    Some(match kind {
        "Method" => svg!("method"),
        "Function" => svg!("function"),
        "Constructor" => svg!("constructor"),
        "Field" | "EnumMember" => svg!("field"),
        "Property" | "Key" => svg!("property"),
        "Variable" | "Array" | "Object" | "String" | "Number" | "Boolean" | "Null" => {
            svg!("variable")
        }
        "Constant" => svg!("constant"),
        "Class" => svg!("class"),
        "Interface" => svg!("interface"),
        "Module" | "Namespace" | "Package" => svg!("module"),
        "Enum" => svg!("enum"),
        "Struct" => svg!("record"),
        "Event" => svg!("lambda"),
        "TypeParameter" => svg!("type"),
        "File" => svg!("anyType"),
        _ => return None,
    })
}

#[derive(Default)]
struct Cache(HashMap<(String, bool), Option<Arc<RenderImage>>>);

impl Global for Cache {}

fn image(kind: &str, cx: &mut App) -> Option<Arc<RenderImage>> {
    let dark = look::palette::dark();
    if let Some(img) = cx
        .default_global::<Cache>()
        .0
        .get(&(kind.to_string(), dark))
    {
        return img.clone();
    }
    let img = svg(kind).and_then(|bytes| {
        cx.svg_renderer()
            .render_single_frame(bytes, 1.0)
            .map_err(|e| eprintln!("[vimstorm] symbol icon {kind}: {e}"))
            .ok()
    });
    cx.default_global::<Cache>()
        .0
        .insert((kind.to_string(), dark), img.clone());
    img
}

/// The kind's 16 px icon (an empty box when it has none, so names line up).
pub fn icon(kind: &str, cx: &mut App) -> AnyElement {
    let size = px(look::ICON_SIZE);
    match image(kind, cx) {
        Some(data) => img(ImageSource::Render(data))
            .size(size)
            .flex_none()
            .into_any_element(),
        None => div().size(size).flex_none().child("").into_any_element(),
    }
}
