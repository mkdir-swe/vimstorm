//! A collapsed side pane as WebStorm draws the VCS log's hidden Branches tree: a narrow vertical
//! strip with an expand chevron at the top and the pane's name rotated to read bottom-to-top,
//! a 1 px line on its right. Clicking anywhere on it expands ([`CollapsedStripe::on_expand`]).
//!
//! GPUI can't rotate text, so a label is a pre-rendered SVG path of the name in Inter
//! ([`VerticalLabel`], generated from the bundled `assets/fonts/Inter-Regular.ttf` outlines with
//! fontTools at the strip's font size; the generator is described in the SVG's comment).

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{
    App, ClickEvent, CursorStyle, ElementId, Global, ImageSource, InteractiveElement as _,
    IntoElement, ParentElement as _, RenderImage, RenderOnce, StatefulInteractiveElement as _,
    Styled as _, Window, div, img, px,
};

use super::icons::{Icon, IconName};
use super::tooltip::tooltip;
use crate::look;

/// The rotated names there are SVGs for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VerticalLabel {
    Branches,
}

impl VerticalLabel {
    pub const ALL: &'static [VerticalLabel] = &[VerticalLabel::Branches];

    /// The text it shows.
    pub fn text(self) -> &'static str {
        match self {
            Self::Branches => "Branches",
        }
    }

    /// The SVG as generated: its outlines filled with Islands Dark's text colour.
    pub fn svg(self) -> &'static str {
        match self {
            Self::Branches => include_str!("../../assets/icons/text/branchesVertical.svg"),
        }
    }

    /// The SVG filled with `fill` (`#rrggbb`) in place of the generated colour.
    pub fn svg_filled(self, fill: &str) -> String {
        self.svg().replace(GENERATED_FILL, fill)
    }
}

/// The colour the labels' outlines were generated in (Islands Dark's text).
const GENERATED_FILL: &str = "#D1D3D9";

/// `#rrggbb` of a colour.
fn hex(c: gpui_kit::Rgba) -> String {
    let b = |v: f32| (v * 255.).round() as u8;
    format!("#{:02X}{:02X}{:02X}", b(c.r), b(c.g), b(c.b))
}

#[derive(Default)]
struct LabelCache(HashMap<(VerticalLabel, String), Arc<RenderImage>>);

impl Global for LabelCache {}

/// The label rasterized (2x, cached) in the look's text colour (a light theme's dark text,
/// not Islands Dark's light grey on white).
pub fn label_image(label: VerticalLabel, cx: &mut App) -> Option<Arc<RenderImage>> {
    let key = (label, hex(look::TEXT.rgba()));
    if let Some(i) = cx.default_global::<LabelCache>().0.get(&key) {
        return Some(i.clone());
    }
    let img = cx
        .svg_renderer()
        .render_single_frame(label.svg_filled(&key.1).as_bytes(), 1.0)
        .map_err(|e| eprintln!("[vimstorm] vertical label {label:?}: {e}"))
        .ok()?;
    cx.default_global::<LabelCache>().0.insert(key, img.clone());
    Some(img)
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The collapsed strip.
pub struct CollapsedStripe {
    id: ElementId,
    label: VerticalLabel,
    on_expand: Option<Handler>,
}

impl CollapsedStripe {
    pub fn new(id: impl Into<ElementId>, label: VerticalLabel) -> Self {
        Self {
            id: id.into(),
            label,
            on_expand: None,
        }
    }

    pub fn on_expand(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_expand = Some(Rc::new(f));
        self
    }
}

impl IntoElement for CollapsedStripe {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl RenderOnce for CollapsedStripe {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let image = label_image(self.label, cx);
        let selector = format!("stripe-{}", self.id);
        let size = image.as_ref().map(|i| {
            let s = i.size(0);
            // rasterized at 2x
            (px(s.width.0 as f32 / 2.), px(s.height.0 as f32 / 2.))
        });
        let mut strip = div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex_none()
            .h_full()
            .w(px(look::STRIPE_WIDTH))
            .border_r_1()
            .border_color(look::SPLITTER_LINE)
            .flex()
            .flex_col()
            .items_center()
            .cursor(CursorStyle::PointingHand)
            .hover(|s| s.bg(look::STRIPE_HOVER_BG))
            .tooltip(tooltip(format!("Show {}", self.label.text()), None))
            .child(
                div()
                    .mt(px(look::STRIPE_PAD_TOP))
                    .size(px(look::ACTION_BUTTON_SIZE))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Icon::new(IconName::ChevronRight)),
            )
            .children(image.zip(size).map(|(i, (w, h))| {
                div()
                    .mt(px(look::STRIPE_TEXT_GAP))
                    .child(img(ImageSource::Render(i)).w(w).h(h).flex_none())
            }));
        if let Some(f) = self.on_expand {
            strip = strip.on_click(move |ev, window, cx| f(ev, window, cx));
        }
        strip
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_rasterize() {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        for &l in VerticalLabel::ALL {
            let img = cx.update(|cx| label_image(l, cx)).expect("renders");
            let s = img.size(0);
            // tall and narrow: rotated text
            assert!(
                s.height.0 > 3 * s.width.0,
                "{l:?} {}x{}",
                s.width.0,
                s.height.0
            );
            let ink = img
                .as_bytes(0)
                .unwrap()
                .as_chunks::<4>()
                .0
                .iter()
                .filter(|p| p[3] > 128)
                .count();
            assert!(ink > 100, "{l:?} has ink {ink}");
        }
    }

    /// The label takes the look's text colour; Islands Dark's is the generated one.
    #[test]
    fn labels_take_the_given_fill() {
        let l = VerticalLabel::Branches;
        assert!(l.svg().contains(GENERATED_FILL));
        let light = l.svg_filled("#000000");
        assert!(light.contains("fill=\"#000000\"") && !light.contains(GENERATED_FILL));
        assert_eq!(
            hex(look::palette::BUILT_IN[look::TEXT.0 as usize]),
            GENERATED_FILL
        );
    }
}
