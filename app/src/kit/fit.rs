//! An element built once its width is known: a one-line row that decides what it shows whole,
//! what it leaves out and what it cuts with an ellipsis by measuring its words at the width it
//! got (the Board card's rail row). Flex shrinking can only clip a word part-way (`Bı`);
//! this picks whole words instead.

use gpui_kit::{
    AnyElement, App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Style, Window, px, relative, size,
};

type Build = Box<dyn FnOnce(Pixels, &mut Window, &mut App) -> AnyElement>;

/// Takes its parent's width and `height` px; `build` makes what it draws from that width.
pub struct Fit {
    height: f32,
    build: Option<Build>,
}

/// A `height` px element as wide as its parent, drawn by `build(width, window, cx)`.
pub fn fit(
    height: f32,
    build: impl FnOnce(Pixels, &mut Window, &mut App) -> AnyElement + 'static,
) -> Fit {
    Fit {
        height,
        build: Some(Box::new(build)),
    }
}

impl IntoElement for Fit {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Fit {
    type RequestLayoutState = ();
    type PrepaintState = Option<AnyElement>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = px(self.height).into();
        style.min_size.width = px(0.).into();
        style.flex_shrink = 0.;
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let build = self.build.take()?;
        let mut el = build(bounds.size.width, window, cx);
        el.prepaint_as_root(
            bounds.origin,
            size(
                AvailableSpace::Definite(bounds.size.width),
                AvailableSpace::Definite(bounds.size.height),
            ),
            window,
            cx,
        );
        Some(el)
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        el: &mut Option<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(el) = el {
            el.paint(window, cx);
        }
    }
}

/// What a one-line row keeps: its fixed parts always, then as many of its parts that can go as
/// fit (each left out whole, the first first), then its fixed parts narrowed as far as they may,
/// then its one word that can be cut.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fitted {
    /// How many of the parts that can go were left out, from the first.
    pub dropped: usize,
    /// How many px the fixed parts give up (at most their `give`).
    pub squeeze: f32,
    /// The cut word's width, when it is cut (with an ellipsis); none when it is whole.
    pub cut: Option<f32>,
}

/// Float noise: the callers' widths are whole px (shaped widths rounded up, as layout draws them).
const SLACK: f32 = 0.01;

/// A row of `fixed` px (of which `give` may narrow), a `word` that is cut last and `drops` (each
/// with its gap) that are left out whole in order, in `room` px.
pub fn fit_line(fixed: f32, give: f32, word: f32, drops: &[f32], room: f32) -> Fitted {
    for dropped in 0..=drops.len() {
        let rest: f32 = drops[dropped..].iter().sum();
        if fixed + word + rest <= room + SLACK {
            return Fitted {
                dropped,
                squeeze: 0.,
                cut: None,
            };
        }
    }
    let over = fixed + word - room;
    if over <= give + SLACK {
        return Fitted {
            dropped: drops.len(),
            squeeze: over.min(give),
            cut: None,
        };
    }
    Fitted {
        dropped: drops.len(),
        squeeze: give,
        cut: Some((room - fixed + give).max(0.)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fit {
        name: &'static str,
        fixed: f32,
        give: f32,
        word: f32,
        drops: &'static [f32],
        room: f32,
        want: Fitted,
    }

    const fn fitted(dropped: usize, squeeze: f32, cut: Option<f32>) -> Fitted {
        Fitted {
            dropped,
            squeeze,
            cut,
        }
    }

    /// 100 fixed (20 of it can narrow) + a 50 px word + drops of 36 and 40: 226 px in all.
    const FITS: &[Fit] = &[
        Fit {
            name: "with room everything shows whole",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 300.,
            want: fitted(0, 0., None),
        },
        Fit {
            name: "one px short drops the last part whole",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 225.,
            want: fitted(1, 0., None),
        },
        Fit {
            name: "the first drop is enough down to its width",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 190.,
            want: fitted(1, 0., None),
        },
        Fit {
            name: "then the next part goes",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 150.,
            want: fitted(2, 0., None),
        },
        Fit {
            name: "with every part gone the fixed ones narrow",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 140.,
            want: fitted(2, 10., None),
        },
        Fit {
            name: "narrowed all the way the word is cut",
            fixed: 100.,
            give: 20.,
            word: 50.,
            drops: &[36., 40.],
            room: 110.,
            want: fitted(2, 20., Some(30.)),
        },
        Fit {
            name: "the cut is never below nothing",
            fixed: 100.,
            give: 0.,
            word: 50.,
            drops: &[],
            room: 80.,
            want: fitted(0, 0., Some(0.)),
        },
        Fit {
            name: "a row that fits within float noise is not cut",
            fixed: 100.25,
            give: 0.,
            word: 49.75,
            drops: &[],
            room: 150.,
            want: fitted(0, 0., None),
        },
        Fit {
            name: "a row a quarter px too wide is cut",
            fixed: 100.25,
            give: 0.,
            word: 50.,
            drops: &[],
            room: 150.,
            want: fitted(0, 0., Some(49.75)),
        },
    ];

    #[test]
    fn parts_drop_whole_in_order_then_the_fixed_ones_narrow_then_the_word_is_cut() {
        for f in FITS {
            assert_eq!(
                fit_line(f.fixed, f.give, f.word, f.drops, f.room),
                f.want,
                "{}",
                f.name
            );
        }
    }
}
