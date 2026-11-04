//! Mouse: GPUI buttons / modifiers -> `nvim_input_mouse` arguments, scroll deltas -> wheel steps.

use gpui_kit::{
    Modifiers, MouseButton, NavigationDirection, Pixels, Point, ScrollDelta, point, px,
};

use super::Action;

/// `nvim_input_mouse` action for a button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    /// Send only when the grid cell under the pointer changes.
    Drag,
    Release,
}

impl Action {
    /// `nvim_input_mouse(button, action, modifier, grid, row, col)` for a GPUI button.
    pub fn mouse(
        button: MouseButton,
        action: MouseAction,
        modifiers: Modifiers,
        grid: u64,
        row: u64,
        col: u64,
    ) -> Action {
        let button = match button {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
            MouseButton::Navigate(NavigationDirection::Back) => "x1",
            MouseButton::Navigate(NavigationDirection::Forward) => "x2",
        };
        let action = match action {
            MouseAction::Press => "press",
            MouseAction::Drag => "drag",
            MouseAction::Release => "release",
        };
        Action::Mouse {
            button,
            action,
            modifier: mouse_modifier(modifiers),
            grid,
            row,
            col,
        }
    }

    /// Pointer moved without a button (hover; nvim needs `'mousemoveevent'`).
    pub fn mouse_move(modifiers: Modifiers, grid: u64, row: u64, col: u64) -> Action {
        Action::Mouse {
            button: "move",
            action: "",
            modifier: mouse_modifier(modifiers),
            grid,
            row,
            col,
        }
    }
}

/// `nvim_input_mouse` modifier string, e.g. "C-S"; Alt as M (`<M-LeftMouse>`), Cmd as D.
pub fn mouse_modifier(m: Modifiers) -> String {
    [
        (m.control, "C"),
        (m.alt, "M"),
        (m.platform, "D"),
        (m.shift, "S"),
    ]
    .into_iter()
    .filter_map(|(on, name)| on.then_some(name))
    .collect::<Vec<_>>()
    .join("-")
}

/// Whole wheel steps from one scroll event. Positive = towards the start (wheel "up" / "left");
/// macOS deltas already carry the natural-scrolling direction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WheelSteps {
    pub up: i32,
    pub left: i32,
}

impl WheelSteps {
    pub fn is_empty(&self) -> bool {
        self.up == 0 && self.left == 0
    }

    /// One `nvim_input_mouse("wheel", ..)` per step.
    pub fn actions(&self, modifiers: Modifiers, grid: u64, row: u64, col: u64) -> Vec<Action> {
        let modifier = mouse_modifier(modifiers);
        let vertical = if self.up > 0 { "up" } else { "down" };
        let horizontal = if self.left > 0 { "left" } else { "right" };
        let steps = std::iter::repeat_n(vertical, self.up.unsigned_abs() as usize).chain(
            std::iter::repeat_n(horizontal, self.left.unsigned_abs() as usize),
        );
        steps
            .map(|action| Action::Mouse {
                button: "wheel",
                action,
                modifier: modifier.clone(),
                grid,
                row,
                col,
            })
            .collect()
    }
}

/// Rows (columns) per mouse-wheel line: nvim's default `mousescroll=ver:3` per wheel event, which
/// the app sets to 1 so trackpad steps are single rows.
const WHEEL_LINES: f32 = 3.;

/// Turns pixel deltas and mouse-wheel line deltas into whole row / column steps, keeping the
/// remainder for the next event.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScrollAccumulator {
    /// Not yet sent, in pixels, delta sign (positive = content moves down / right).
    pending: Point<f32>,
}

impl ScrollAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a GPUI scroll delta; returns the whole steps to send now.
    pub fn scroll(
        &mut self,
        delta: &ScrollDelta,
        row_height: Pixels,
        cell_width: Pixels,
    ) -> WheelSteps {
        let (row, cell) = (row_height.as_f32(), cell_width.as_f32());
        let pixels = match *delta {
            ScrollDelta::Pixels(p) => point(p.x.as_f32(), p.y.as_f32()),
            ScrollDelta::Lines(l) => point(l.x * cell * WHEEL_LINES, l.y * row * WHEEL_LINES),
        };
        self.pending = point(self.pending.x + pixels.x, self.pending.y + pixels.y);
        let up = whole_steps(&mut self.pending.y, row);
        let left = whole_steps(&mut self.pending.x, cell);
        WheelSteps { up, left }
    }

    /// The sub-row / sub-column remainder not sent yet (delta sign: positive y = content pulled
    /// down, i.e. the next step would be "up").
    pub fn offset(&self) -> Point<Pixels> {
        point(px(self.pending.x), px(self.pending.y))
    }

    pub fn reset(&mut self) {
        self.pending = Point::default();
    }
}

/// Takes the whole steps out of `pending` (truncating towards zero).
fn whole_steps(pending: &mut f32, step: f32) -> i32 {
    if step <= 0. {
        *pending = 0.;
        return 0;
    }
    let steps = (*pending / step).trunc();
    *pending -= steps * step;
    steps as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(control: bool, alt: bool, platform: bool, shift: bool) -> Modifiers {
        Modifiers {
            control,
            alt,
            platform,
            shift,
            function: false,
        }
    }

    /// (button, action, Ctrl Alt Cmd Shift, the button, action and modifier nvim gets)
    type Click = (
        MouseButton,
        MouseAction,
        [bool; 4],
        (&'static str, &'static str, &'static str),
    );

    const CLICKS: &[Click] = &[
        (
            MouseButton::Left,
            MouseAction::Press,
            [false; 4],
            ("left", "press", ""),
        ),
        (
            MouseButton::Left,
            MouseAction::Press,
            [false, false, true, false],
            ("left", "press", "D"),
        ),
        (
            MouseButton::Right,
            MouseAction::Release,
            [true, false, false, true],
            ("right", "release", "C-S"),
        ),
        (
            MouseButton::Middle,
            MouseAction::Drag,
            [false, true, false, false],
            ("middle", "drag", "M"),
        ),
        (
            MouseButton::Navigate(NavigationDirection::Back),
            MouseAction::Press,
            [true; 4],
            ("x1", "press", "C-M-D-S"),
        ),
    ];

    #[test]
    fn a_click_reaches_nvim_with_its_button_action_and_modifiers() {
        for &(b, a, [c, alt, cmd, shift], want) in CLICKS {
            let got = Action::mouse(b, a, mods(c, alt, cmd, shift), 2, 3, 4);
            let Action::Mouse {
                button,
                action,
                modifier,
                grid,
                row,
                col,
            } = got
            else {
                panic!("{want:?}: {got:?}")
            };
            assert_eq!((button, action, modifier.as_str()), want);
            assert_eq!((grid, row, col), (2, 3, 4), "{want:?}");
        }
        assert!(matches!(
            Action::mouse_move(Modifiers::default(), 1, 5, 6),
            Action::Mouse {
                button: "move",
                row: 5,
                col: 6,
                ..
            }
        ));
    }

    const ROW: Pixels = px(22.);
    const CELL: Pixels = px(8.);

    #[derive(Clone, Copy, Debug)]
    enum Delta {
        /// A trackpad's (x, y) in px.
        Px(f32, f32),
        /// A wheel's (x, y) in lines.
        Lines(f32, f32),
    }
    use Delta::*;

    /// (name, deltas each with the steps it sends (up, left), px left over after; None: not checked)
    type Wheel = (
        &'static str,
        &'static [(Delta, (i32, i32))],
        Option<(f32, f32)>,
    );

    const WHEEL: &[Wheel] = &[
        (
            "less than a row sends nothing",
            &[(Px(0., 10.), (0, 0))],
            Some((0., 10.)),
        ),
        (
            "trackpad px add up to rows",
            &[(Px(0., 10.), (0, 0)), (Px(0., 15.), (1, 0))],
            Some((0., 3.)),
        ),
        (
            "reversing eats the remainder first",
            &[
                (Px(0., 10.), (0, 0)),
                (Px(0., 15.), (1, 0)),
                (Px(0., -50.), (-2, 0)),
            ],
            Some((0., -3.)),
        ),
        (
            "sideways px use the cell width",
            &[(Px(-20., 0.), (0, -2))],
            Some((-4., 0.)),
        ),
        (
            "a wheel line is three rows",
            &[
                (Lines(0., -1.), (-3, 0)),
                (Lines(0., 0.2), (0, 0)),
                (Lines(1., 0.2), (1, 3)),
            ],
            None,
        ),
    ];

    #[test]
    fn scrolling_adds_up_to_whole_rows_and_cells() {
        for &(name, deltas, left_over) in WHEEL {
            let mut s = ScrollAccumulator::new();
            for &(d, (up, left)) in deltas {
                let delta = match d {
                    Px(x, y) => ScrollDelta::Pixels(point(px(x), px(y))),
                    Lines(x, y) => ScrollDelta::Lines(point(x, y)),
                };
                assert_eq!(
                    s.scroll(&delta, ROW, CELL),
                    WheelSteps { up, left },
                    "{name}: {d:?}"
                );
            }
            if let Some((x, y)) = left_over {
                assert_eq!(s.offset(), point(px(x), px(y)), "{name}");
            }
            s.reset();
            assert_eq!(s.offset(), Point::default(), "{name}: reset");
        }
    }

    #[test]
    fn steps_to_wheel_actions() {
        let steps = WheelSteps { up: -2, left: 1 };
        let actions = steps.actions(mods(true, false, false, false), 1, 7, 9);
        let got: Vec<_> = actions
            .iter()
            .map(|a| match a {
                Action::Mouse {
                    button,
                    action,
                    modifier,
                    grid,
                    row,
                    col,
                } => (*button, *action, modifier.as_str(), *grid, *row, *col),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            got,
            [
                ("wheel", "down", "C", 1, 7, 9),
                ("wheel", "down", "C", 1, 7, 9),
                ("wheel", "left", "C", 1, 7, 9)
            ]
        );
        assert!(
            WheelSteps::default()
                .actions(Modifiers::default(), 1, 0, 0)
                .is_empty()
        );
        assert!(WheelSteps::default().is_empty());
    }
}
