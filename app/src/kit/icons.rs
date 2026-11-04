//! WebStorm's own New UI icons (`app/assets/icons/`, embedded), drawn in their original colors:
//! the dark theme's SVGs under a dark look, the light theme's under a light one
//! (`look::palette::dark`).
//!
//! GPUI's `svg()` element paints an SVG as a one-color mask, so icons go through `img()` instead:
//! each SVG is rasterized once by GPUI's resvg renderer (at 2x, crisp at 16 px on Retina) into a
//! `RenderImage`, cached per icon, and painted as a polychrome sprite.
//!
//! [`for_file`] / [`for_filetype`] pick a file's icon like `nvim/lua/config/icons.lua`.

mod table;

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{
    App, Global, ImageSource, IntoElement, Pixels, RenderImage, RenderOnce, Styled, StyledImage,
    ViewElement, Window, div, img, px,
};

pub use table::{IconName, for_file, for_filetype};

use crate::look;

/// Rasterized icons, one per name and theme kind (GPUI's sprite atlas keys on the image, so reuse
/// matters).
#[derive(Default)]
struct IconCache(HashMap<(IconName, bool), Arc<RenderImage>>);

impl IconName {
    /// The SVG for the look in force: the dark or the light theme's (`look::palette::dark`).
    pub fn svg(self) -> &'static [u8] {
        self.svg_in(look::palette::dark())
    }
}

impl Global for IconCache {}

/// The icon as an image GPUI can paint (rasterized on first use, then cached). None if the SVG
/// doesn't parse (a broken asset; logged once).
pub fn image(name: IconName, cx: &mut App) -> Option<Arc<RenderImage>> {
    image_in(name, look::palette::dark(), cx)
}

/// [`image`] for a dark (`true`) or light theme.
fn image_in(name: IconName, dark: bool, cx: &mut App) -> Option<Arc<RenderImage>> {
    if let Some(img) = cx.default_global::<IconCache>().0.get(&(name, dark)) {
        return Some(img.clone());
    }
    // scale 1.0 = the SVG's own size (16 px) times GPUI's 2x smoothing factor
    match cx
        .svg_renderer()
        .render_single_frame(name.svg_in(dark), 1.0)
    {
        Ok(img) => {
            cx.default_global::<IconCache>()
                .0
                .insert((name, dark), img.clone());
            Some(img)
        }
        Err(e) => {
            eprintln!("[vimstorm] icon {}: {e}", name.path_in(dark));
            None
        }
    }
}

/// An icon element, 16 px (WebStorm's icon size) unless sized otherwise.
pub struct Icon {
    name: IconName,
    size: Pixels,
    disabled: bool,
}

impl Icon {
    pub fn new(name: IconName) -> Self {
        Self {
            name,
            size: px(look::ICON_SIZE),
            disabled: false,
        }
    }

    pub fn size(mut self, size: Pixels) -> Self {
        self.size = size;
        self
    }

    /// WebStorm's disabled look (IconLoader.getDisabledIcon: gray, faded).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

// what `#[derive(IntoElement)]` writes (its expansion names the `gpui` crate, which is
// `gpui_kit` here)
impl IntoElement for Icon {
    type Element = ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        ViewElement::new(self)
    }
}

impl RenderOnce for Icon {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        match image(self.name, cx) {
            Some(data) => img(ImageSource::Render(data))
                .size(self.size)
                .flex_none()
                .grayscale(self.disabled)
                .opacity(if self.disabled {
                    look::ICON_DISABLED_ALPHA
                } else {
                    1.0
                })
                .into_any_element(),
            // keep the layout (icon column) even without the picture
            None => div().size(self.size).flex_none().into_any_element(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BGRA pixels of a rasterized icon (the dark theme's).
    fn pixels(name: IconName) -> (usize, usize, Vec<[u8; 4]>) {
        pixels_in(name, true)
    }

    fn pixels_in(name: IconName, dark: bool) -> (usize, usize, Vec<[u8; 4]>) {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        let img = cx
            .update(|cx| image_in(name, dark, cx))
            .expect("icon renders");
        let size = img.size(0);
        let bytes = img.as_bytes(0).unwrap();
        let px = bytes.as_chunks::<4>().0.to_vec();
        (size.width.0 as usize, size.height.0 as usize, px)
    }

    #[test]
    fn every_icon_rasterizes_at_2x() {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        for (&name, dark) in IconName::ALL.iter().flat_map(|n| [(n, true), (n, false)]) {
            let img = cx
                .update(|cx| image_in(name, dark, cx))
                .unwrap_or_else(|| panic!("{name:?} dark={dark} doesn't render"));
            let s = img.size(0);
            // 16 px icons at GPUI's 2x smoothing; some chrome icons are 12 / 20 px
            assert!(
                s.width.0 >= 16 && s.width.0 <= 48,
                "{name:?}: {}x{}",
                s.width.0,
                s.height.0
            );
            let visible = img
                .as_bytes(0)
                .unwrap()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|p| p[3] > 0);
            assert!(visible, "{name:?} dark={dark} is empty");
        }
    }

    /// On a light theme an unchecked checkbox is a white box and a folder a light body with a
    /// grey outline, never the dark theme's dark fills.
    #[test]
    fn light_theme_icons_are_light() {
        let lum = |[b, g, r, _]: [u8; 4]| (r as u32 * 3 + g as u32 * 6 + b as u32) / 10;
        // the box's middle: dark #2B2D30 in Islands Dark, white in Islands Light
        let (w, h, px) = pixels_in(IconName::CheckBox, false);
        let mid = px[(h / 2) * w + w / 2];
        assert!(lum(mid) > 240, "light box middle {mid:?}");
        let (w, h, px) = pixels_in(IconName::CheckBox, true);
        let mid = px[(h / 2) * w + w / 2];
        assert!(lum(mid) < 60, "dark box middle {mid:?}");
        // the folder's body: #EBECF0 in Islands Light, #43454A in Islands Dark
        let (w, h, px) = pixels_in(IconName::Folder, false);
        let mid = px[(h / 2) * w + w / 2];
        assert!(mid[3] > 200 && lum(mid) > 200, "light folder body {mid:?}");
        let (w, h, px) = pixels_in(IconName::Folder, true);
        let mid = px[(h / 2) * w + w / 2];
        assert!(mid[3] > 200 && lum(mid) < 90, "dark folder body {mid:?}");
    }

    /// The point of using img(): colors survive (svg() would give a one-color mask).
    #[test]
    fn icons_keep_their_colors() {
        // TypeScript: a blue badge with a light "TS"
        let (w, h, px) = pixels(IconName::TypeScript);
        assert_eq!((w, h), (32, 32));
        let blue = px
            .iter()
            .filter(|[b, g, r, a]| *a > 200 && *b > 150 && (*b as i32 - *r as i32) > 60 && *g < *b)
            .count();
        let light = px
            .iter()
            .filter(|[b, g, r, a]| *a > 200 && *r > 200 && *g > 200 && *b > 200)
            .count();
        assert!(blue > 50, "blue pixels: {blue}");
        assert!(light > 5, "light pixels (letters): {light}");
        // HTML: green-ish, not blue
        let (_, _, px) = pixels(IconName::Html);
        let green = px
            .iter()
            .filter(|[b, g, r, a]| *a > 200 && *g > *r && *g > *b)
            .count();
        assert!(green > 20, "green pixels: {green}");
    }

    #[test]
    fn cache_returns_the_same_image() {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        let (a, b) = cx.update(|cx| (image(IconName::Folder, cx), image(IconName::Folder, cx)));
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
    }
}
