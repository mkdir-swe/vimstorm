//! The VCS log's ref label (LabelPainter / LabelIcon): a commit's branches and tags as
//! overlapping outlined tag icons, one per ref in its kind's color (HEAD yellow, local branch
//! green, remote branch purple, tag / other gray), the front one whole (with its hole), the ones
//! behind it showing their left edge; then the names in gray ("origin & master": a remote branch
//! whose local branch is on the same commit is written as "<remote> & <local>").
//!
//! Also [`RefLabel::text_for`], the pure naming rule, and the column text styles of the log
//! ([`look::VCS_LOG_AUTHOR_FG`] etc.).

use gpui_kit::{
    App, Bounds, IntoElement, ParentElement as _, PathBuilder, Pixels, Point, RenderOnce, Rgba,
    SharedString, Styled as _, Window, canvas, div, point, prelude::FluentBuilder as _, px,
};

use crate::look;

/// What a ref is (its icon color).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RefKind {
    /// Anything else (origin/HEAD, stash, ...).
    Other,
    Tag,
    RemoteBranch,
    LocalBranch,
    Head,
}

impl RefKind {
    pub fn color(self) -> Rgba {
        match self {
            Self::Head => look::VCS_REF_HEAD.rgba(),
            Self::LocalBranch => look::VCS_REF_LOCAL.rgba(),
            Self::RemoteBranch => look::VCS_REF_REMOTE.rgba(),
            Self::Tag => look::VCS_REF_TAG.rgba(),
            Self::Other => look::VCS_REF_OTHER.rgba(),
        }
    }
}

/// A commit's refs, drawn as tags + names.
pub struct RefLabel {
    refs: Vec<(SharedString, RefKind)>,
    background: Rgba,
    max_text_width: Option<Pixels>,
    /// The names shown instead of [`RefLabel::text_for`] (the log's compact rule: the first
    /// branch only; "" = icons only).
    text: Option<SharedString>,
}

impl RefLabel {
    pub fn new(refs: Vec<(SharedString, RefKind)>) -> Self {
        Self {
            refs,
            background: look::PANEL_BG.rgba(),
            max_text_width: None,
            text: None,
        }
    }

    /// Shows `text` instead of the names of all refs ("" = icons only).
    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// The row's background (the icons behind the front one are filled with it; a selected row
    /// passes its selection color).
    pub fn background(mut self, bg: Rgba) -> Self {
        self.background = bg;
        self
    }

    /// Names longer than this end in "…".
    pub fn max_text_width(mut self, w: Pixels) -> Self {
        self.max_text_width = Some(w);
        self
    }

    /// Icons back to front: other, tag, remote, local, HEAD (HEAD in front, as WS).
    pub fn icon_order(refs: &[(SharedString, RefKind)]) -> Vec<RefKind> {
        let mut kinds: Vec<RefKind> = refs.iter().map(|(_, k)| *k).collect();
        kinds.sort();
        kinds
    }

    /// The names shown: branches (local first, a remote branch with its local one as
    /// "<remote> & <local>"), then tags; HEAD / other refs only when nothing else has a name.
    pub fn text_for(refs: &[(SharedString, RefKind)]) -> String {
        let locals: Vec<&str> = refs
            .iter()
            .filter(|(_, k)| *k == RefKind::LocalBranch)
            .map(|(n, _)| n.as_ref())
            .collect();
        let mut parts: Vec<String> = Vec::new();
        let mut merged: Vec<&str> = Vec::new();
        for l in &locals {
            let remote = refs.iter().find_map(|(n, k)| {
                (*k == RefKind::RemoteBranch)
                    .then(|| n.as_ref().split_once('/'))
                    .flatten()
                    .filter(|(_, branch)| branch == l)
                    .map(|(remote, _)| (remote, n.as_ref()))
            });
            match remote {
                Some((remote, full)) => {
                    parts.push(format!("{remote} & {l}"));
                    merged.push(full);
                }
                None => parts.push(l.to_string()),
            }
        }
        for (n, k) in refs {
            if *k == RefKind::RemoteBranch && !merged.contains(&n.as_ref()) {
                parts.push(n.to_string());
            }
        }
        for (n, k) in refs {
            if *k == RefKind::Tag {
                parts.push(n.to_string());
            }
        }
        if parts.is_empty() {
            let head = refs.iter().find(|(_, k)| *k == RefKind::Head);
            if let Some((n, _)) = head.or(refs.first()) {
                parts.push(n.to_string());
            }
        }
        parts.join(", ")
    }
}

impl IntoElement for RefLabel {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

/// WS's New UI tag outline (TagPainter.paintTag: expui/vcs/currentBranch.svg's path in a 16-unit
/// box) at x offset `x0`, scaled to `size`.
fn tag_path(mut b: PathBuilder, o: Point<Pixels>, x0: f32, size: f32) -> PathBuilder {
    let s = size / 16.;
    let p = |x: f32, y: f32| point(o.x + px(x0 + x * s), o.y + px(y * s));
    b.move_to(p(13.4495, 7.5001));
    b.line_to(p(7.01028, 13.9394));
    b.cubic_bezier_to(
        p(6.30317, 13.9394),
        p(6.81502, 14.1347),
        p(6.49843, 14.1347),
    );
    b.line_to(p(2.06053, 9.69679));
    b.cubic_bezier_to(
        p(2.06053, 8.98968),
        p(1.86527, 9.50152),
        p(1.86527, 9.18494),
    );
    b.line_to(p(8.49978, 2.55035));
    b.cubic_bezier_to(
        p(8.92404, 2.40893),
        p(8.61106, 2.43907),
        p(8.76824, 2.38667),
    );
    b.line_to(p(12.6363, 2.93926));
    b.cubic_bezier_to(
        p(13.0606, 3.36352),
        p(12.8563, 2.97069),
        p(13.0292, 3.14354),
    );
    b.line_to(p(13.5909, 7.07584));
    b.cubic_bezier_to(p(13.4495, 7.5001), p(13.6132, 7.23163), p(13.5608, 7.38882));
    b.close();
    b
}

/// One tag: filled with the background, outlined in `color` (stroke = 1 unit), the dot on the
/// front one (TagPainter.paintTag).
fn paint_tag(
    o: Point<Pixels>,
    x0: f32,
    size: f32,
    dot: bool,
    bg: Rgba,
    color: Rgba,
    window: &mut Window,
) {
    if let Ok(path) = tag_path(PathBuilder::fill(), o, x0, size).build() {
        window.paint_path(path, bg);
    }
    if let Ok(path) = tag_path(PathBuilder::stroke(px(size / 16.)), o, x0, size).build() {
        window.paint_path(path, color);
    }
    if dot {
        let s = size / 16.;
        let (cx, cy, r) = (o.x + px(x0 + 10.5 * s), o.y + px(5.5 * s), px(s));
        let mut hole = PathBuilder::fill();
        hole.move_to(point(cx - r, cy));
        hole.arc_to(point(r, r), px(0.), false, true, point(cx + r, cy));
        hole.arc_to(point(r, r), px(0.), false, true, point(cx - r, cy));
        hole.close();
        if let Ok(path) = hole.build() {
            window.paint_path(path, color);
        }
    }
}

/// Width of `n` overlapping tags of height `size` (LabelIcon.getWidth).
pub fn icons_width(size: f32, n: usize) -> f32 {
    if n == 0 {
        return 0.;
    }
    ((LABEL_UNITS + 2. * (n - 1) as f32) * size / LABEL_UNITS).round()
}

/// LabelIcon.SIZE: a tag's height in its 2-unit steps.
const LABEL_UNITS: f32 = 6.25;

/// LabelIcon.paintTagsForNewUi: back (left) to front (right), each one covered by a background
/// tag √2 left of the next, so only its left edge shows.
fn paint_icons(bounds: Bounds<Pixels>, kinds: &[RefKind], bg: Rgba, window: &mut Window) {
    let size = look::VCS_REF_ICON_SIZE;
    let step = 2. * size / LABEL_UNITS;
    let o = point(
        bounds.left(),
        bounds.top() + (bounds.size.height - px(size)) / 2.,
    );
    let n = kinds.len();
    for (i, &kind) in kinds.iter().enumerate() {
        let x = step * i as f32;
        paint_tag(o, x, size, i + 1 == n, bg, kind.color(), window);
        if i + 1 != n {
            paint_tag(
                o,
                x + step - std::f32::consts::SQRT_2,
                size,
                false,
                bg,
                bg,
                window,
            );
        }
    }
}

impl RenderOnce for RefLabel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let kinds = Self::icon_order(&self.refs);
        let text: SharedString = self
            .text
            .clone()
            .unwrap_or_else(|| Self::text_for(&self.refs).into());
        let icons_w = icons_width(look::VCS_REF_ICON_SIZE, kinds.len());
        let bg = self.background;
        div()
            .flex()
            .items_center()
            .flex_none()
            .min_w_0()
            .px(px(look::VCS_REF_PAD_X))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| paint_icons(bounds, &kinds, bg, window),
                )
                .flex_none()
                .w(px(icons_w))
                .h(px(look::VCS_REF_ICON_SIZE)),
            )
            .when(!text.is_empty(), |d| {
                d.child(
                    div()
                        .pl(px(look::VCS_REF_ICON_TEXT_GAP))
                        .text_size(px(look::VCS_REF_FONT_SIZE))
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_color(look::VCS_REF_TEXT_FG)
                        .when_some(self.max_text_width, |d, w| d.max_w(w))
                        .child(text),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RefKind::*;

    fn refs(v: &[(&'static str, RefKind)]) -> Vec<(SharedString, RefKind)> {
        v.iter().map(|(n, k)| ((*n).into(), *k)).collect()
    }

    #[test]
    fn names_merge_remote_and_local() {
        let r = refs(&[
            ("origin/HEAD", Other),
            ("origin/master", RemoteBranch),
            ("master", LocalBranch),
            ("HEAD", Head),
        ]);
        assert_eq!(RefLabel::text_for(&r), "origin & master");
        assert_eq!(
            RefLabel::icon_order(&r),
            [Other, RemoteBranch, LocalBranch, Head],
            "HEAD in front"
        );
        let r = refs(&[
            ("origin/feat", RemoteBranch),
            ("main", LocalBranch),
            ("v1", Tag),
        ]);
        assert_eq!(RefLabel::text_for(&r), "main, origin/feat, v1");
        assert_eq!(RefLabel::text_for(&refs(&[("HEAD", Head)])), "HEAD");
        assert_eq!(
            RefLabel::text_for(&refs(&[("HEAD", Head), ("dev", LocalBranch)])),
            "dev"
        );
        assert_eq!(RefLabel::text_for(&[]), "");
    }

    #[test]
    fn icon_width_grows_two_units_per_tag() {
        // LabelIcon.getWidth: round((6.25 + 2 (n - 1)) * h / 6.25)
        assert_eq!(icons_width(15., 0), 0.);
        assert_eq!(icons_width(15., 1), 15.);
        assert_eq!(icons_width(15., 5), 34.);
    }
}
