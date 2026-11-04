//! Abe's mark (canvas board W-Faces): Abraham's 16×16 head (`assets/abe/abe-head.svg`). Drawn
//! in its own palette in both themes (never recoloured, never tinted by a state hue); only the
//! empty editor fades the head (12 %).
//!
//! The SVGs are pixel grids (`crispEdges`), rasterized once per size by GPUI's resvg renderer at
//! the size they are drawn (×2 for Retina) so the pixels stay square, then painted with `img()`
//! (GPUI's `svg()` would paint a one-colour mask).

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{
    AnyElement, App, Global, ImageSource, IntoElement, RenderImage, RenderOnce, Styled as _,
    ViewElement, Window, div, img, px,
};

/// Abraham's head, 16×16 pixels.
pub const HEAD_SVG: &[u8] = include_bytes!("../../assets/abe/abe-head.svg");

/// The SVGs' own size in px (their viewBox).
const GRID: f32 = 16.0;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Which {
    Head,
}

/// Rasterized marks by (which, px size).
#[derive(Default)]
struct MarkCache(HashMap<(Which, u32), Arc<RenderImage>>);

impl Global for MarkCache {}

fn image(which: Which, size: f32, cx: &mut App) -> Option<Arc<RenderImage>> {
    let key = (which, size.round() as u32);
    if let Some(i) = cx.default_global::<MarkCache>().0.get(&key) {
        return Some(i.clone());
    }
    let svg = match which {
        Which::Head => HEAD_SVG,
    };
    // scale 1.0 = the SVG's 16 px (times GPUI's own 2x): one SVG pixel per (size / 16) px
    match cx.svg_renderer().render_single_frame(svg, size / GRID) {
        Ok(i) => {
            cx.default_global::<MarkCache>().0.insert(key, i.clone());
            Some(i)
        }
        Err(e) => {
            eprintln!("[vimstorm] abe mark: {e}");
            None
        }
    }
}

fn element(which: Which, size: f32, opacity: f32, cx: &mut App) -> AnyElement {
    match image(which, size, cx) {
        Some(i) => img(ImageSource::Render(i))
            .size(px(size))
            .flex_none()
            .opacity(opacity)
            .into_any_element(),
        None => div().size(px(size)).flex_none().into_any_element(),
    }
}

/// Abraham's head at `size` px (W-Faces: 128 in the empty editor, 64 / 32 at full strength).
pub fn head(size: f32, opacity: f32, cx: &mut App) -> AnyElement {
    element(Which::Head, size, opacity, cx)
}

/// [`head`] as an element, for a tree drawn without the app at hand (the Abe chat's header and
/// its transcript's watermark).
pub struct Head {
    pub size: f32,
    pub opacity: f32,
}

// what `#[derive(IntoElement)]` writes (its expansion names the `gpui` crate)
impl IntoElement for Head {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for Head {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        head(self.size, self.opacity, cx)
    }
}
