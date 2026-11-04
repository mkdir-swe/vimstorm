//! Where a tab bar's tabs go (pure, unit-tested): each tab's width from its label's width
//! (WebStorm's Islands tab: insets, icon, label, close button space on every tab so tabs never
//! jump), and which tabs fit. Too many for the bar: a run of tabs around the active one (the bar
//! scrolls to it in WebStorm, `config/tabbar.lua` did the same), the rest behind the hidden tabs
//! button at the bar's right end.

use crate::look;

/// Label right -> close button.
pub const CLOSE_GAP: f32 = look::TAB_CLOSE_GAP;
/// Icon -> label: measured 30.png (icon ink end -> label ink 7.6 vs 6.5 with `TAB_ICON_GAP` 4).
pub const ICON_GAP: f32 = look::TAB_ICON_GAP + 1.;
/// The selected / hovered box's top below the bar's top: measured 30.png (island edge y 40.5 ->
/// box outline 47.5: 4.9; centred in the strip it would be 3.5).
pub const BOX_TOP: f32 = 5.;
/// Labels sit this much below the box's centre line (30.png: x-height top 3.4 above the centre
/// vs 4.5 with GPUI's centred line box).
pub const LABEL_DROP: f32 = 1.;
/// A tab's width without its label: insets, icon, gaps, close button.
pub const CHROME: f32 = look::TAB_PADDING_LEFT
    + look::ICON_SIZE
    + ICON_GAP
    + CLOSE_GAP
    + look::TAB_CLOSE_SIZE
    + look::TAB_PADDING_RIGHT;
/// First tab's left edge from the bar's left (island outline + Islands' first tab offset).
pub const START: f32 = look::ISLAND_BORDER_WIDTH + look::TAB_FIRST_OFFSET;
/// Room kept free at the bar's right end.
pub const END: f32 = look::ISLAND_BORDER_WIDTH + look::TAB_FIRST_OFFSET;

/// A tab's width (outer: the selected box is `TAB_BOX_INSET_X` inside it on each side).
pub fn tab_width(label: f32) -> f32 {
    CHROME + label.ceil()
}

/// A placed tab: its index in the bar's tab list, x from the bar's left, width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub index: usize,
    pub x: f32,
    pub width: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BarLayout {
    pub tabs: Vec<Placed>,
    /// Indexes of the tabs that don't fit, in tab order.
    pub hidden: Vec<usize>,
    /// The hidden tabs button's x (when some are hidden).
    pub more_x: Option<f32>,
}

/// Lays out tabs of `widths` (each tab's outer width) in a bar `bar` wide. `active`: the tab that
/// must be shown; `more`: the hidden tabs button's width.
pub fn layout(widths: &[f32], active: Option<usize>, bar: f32, more: f32) -> BarLayout {
    let total: f32 = widths.iter().sum();
    let room = bar - START - END;
    let (first, last) = if total <= room || widths.is_empty() {
        (0, widths.len())
    } else {
        // the active tab, then neighbours right / left (alternating) while they fit
        let room = room - more;
        let ci = active.unwrap_or(0).min(widths.len() - 1);
        let (mut first, mut last, mut used) = (ci, ci + 1, widths[ci]);
        loop {
            let mut grew = false;
            if last < widths.len() && used + widths[last] <= room {
                used += widths[last];
                last += 1;
                grew = true;
            }
            if first > 0 && used + widths[first - 1] <= room {
                first -= 1;
                used += widths[first];
                grew = true;
            }
            if !grew {
                break;
            }
        }
        (first, last)
    };
    let mut x = START;
    let mut out = BarLayout::default();
    for (index, &width) in widths.iter().enumerate() {
        if (first..last).contains(&index) {
            out.tabs.push(Placed { index, x, width });
            x += width;
        } else {
            out.hidden.push(index);
        }
    }
    if !out.hidden.is_empty() {
        out.more_x = Some((bar - END - more).max(x));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MORE: f32 = 40.;
    /// Room for three tabs of 100 next to the button.
    const ROOM_FOR_3: f32 = START + END + MORE + 300.;

    /// (name, tab widths, active tab, bar width, tabs shown, tabs hidden, where the button sits
    /// when it is not just after the shown tabs)
    type Bar = (
        &'static str,
        &'static [f32],
        Option<usize>,
        f32,
        &'static [usize],
        &'static [usize],
        Option<f32>,
    );

    const BARS: &[Bar] = &[
        ("no tabs", &[], None, 100., &[], &[], None),
        (
            "all fit",
            &[50., 60., 70.],
            Some(1),
            400.,
            &[0, 1, 2],
            &[],
            None,
        ),
        (
            "too many: a run around the active tab, the button at the bar's end",
            &[100.; 10],
            Some(6),
            ROOM_FOR_3,
            &[5, 6, 7],
            &[0, 1, 2, 3, 4, 8, 9],
            Some(ROOM_FOR_3 - END - MORE),
        ),
        (
            "the last tab active: the run ends with it",
            &[100.; 10],
            Some(9),
            ROOM_FOR_3,
            &[7, 8, 9],
            &[0, 1, 2, 3, 4, 5, 6],
            None,
        ),
        (
            "no active tab: from the first",
            &[100.; 10],
            None,
            ROOM_FOR_3,
            &[0, 1, 2],
            &[3, 4, 5, 6, 7, 8, 9],
            None,
        ),
        (
            "a tab wider than the bar is still shown",
            &[500., 50.],
            Some(0),
            200.,
            &[0],
            &[1],
            None,
        ),
    ];

    #[test]
    fn tabs_run_left_to_right_around_the_active_one_and_the_rest_go_under_the_button() {
        for &(name, widths, active, bar, shown, hidden, more_at) in BARS {
            let l = layout(widths, active, bar, MORE);
            let got: Vec<usize> = l.tabs.iter().map(|t| t.index).collect();
            assert_eq!(got, shown, "{name}");
            assert_eq!(l.hidden, hidden, "{name}");
            // placed edge to edge from the bar's start, each as wide as asked
            let mut x = START;
            for t in &l.tabs {
                assert_eq!(
                    (t.x, t.width),
                    (x, widths[t.index]),
                    "{name}: tab {}",
                    t.index
                );
                x += t.width;
            }
            assert_eq!(l.more_x.is_some(), !hidden.is_empty(), "{name}");
            if let Some(at) = l.more_x {
                assert!(
                    at >= x,
                    "{name}: the button at {at} over the tabs ending at {x}"
                );
            }
            if let Some(want) = more_at {
                assert_eq!(l.more_x, Some(want), "{name}");
            }
        }
    }

    #[test]
    fn a_tab_is_its_label_rounded_up_plus_the_chrome() {
        assert_eq!(tab_width(80.2), CHROME + 81.);
    }
}
