//! Block elements, box-drawing lines and legacy-computing mosaics drawn as shapes, like a
//! terminal does: font glyphs for them don't fill a 22 px row, so frames would show gaps.
//!
//! The smooth-mosaic table (U+1FB3C..U+1FB67) follows Ghostty's encoding, and the branch drawing
//! glyphs (U+F5D0..U+F60D, Kitty's spec for git graphs in terminal programs: no font has them,
//! terminals draw them; the editor grid and the terminal share this table) port Ghostty's
//! `branch.zig` / `box.zig` `arc` (MIT, see `app/NOTICE`).

/// A cell corner: an [`Shape::Arc`] joins the centers of the two edges meeting there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// A cell edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Top,
    Bottom,
    Left,
    Right,
}

/// A shape in cell fractions (x: 0..1 left to right, y: 0..1 top to bottom).
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// Filled rect; `alpha` < 1 for shades.
    Rect {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        alpha: f32,
    },
    /// A line through the cell center: horizontal from `from` to `to` (x), or vertical (y).
    /// Thickness in px: light 1, heavy 2.
    HLine {
        from: f32,
        to: f32,
        heavy: bool,
    },
    VLine {
        from: f32,
        to: f32,
        heavy: bool,
    },
    /// Convex polygon.
    Poly(Vec<(f32, f32)>),
    /// Light rounded corner (like ╭ for [`Corner::BottomRight`]): straight from the edge
    /// centers, a curve of radius min(w, h) / 2 around the cell center.
    Arc(Corner),
    /// Light line through the center, fading out toward `Edge`.
    Fade(Edge),
    /// Branch node: a circle as wide as the cell (round in a tall cell), filled or an outline,
    /// with light lines from it to the edges in `arms` (up, right, down, left).
    Node {
        arms: [bool; 4],
        filled: bool,
    },
    /// ╲ (`down`) / ╱: a light diagonal over the full row height from the line center of one
    /// neighbouring column to the other's, so a text git graph's forks / merges (`\` / `/`
    /// between two lanes) join the lanes and nodes above and below.
    Diag {
        down: bool,
    },
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Shape {
    Shape::Rect {
        x0,
        y0,
        x1,
        y1,
        alpha: 1.0,
    }
}

/// Shapes for `ch`, or `None` to draw it with the font.
pub fn sprite(ch: char) -> Option<Vec<Shape>> {
    let cp = ch as u32;
    match cp {
        0x2500..=0x257F => box_drawing(cp),
        0x2580..=0x259F => Some(block(cp)),
        0x1FB00..=0x1FB3B => Some(sextant(cp)),
        0x1FB3C..=0x1FB67 => Some(vec![smooth_mosaic(cp)]),
        0xF5D0..=0xF60D => Some(branch(cp)),
        _ => None,
    }
}

fn block(cp: u32) -> Vec<Shape> {
    let e = |n: u32| n as f32 / 8.0;
    let (ul, ur, ll, lr) = (
        rect(0.0, 0.0, 0.5, 0.5),
        rect(0.5, 0.0, 1.0, 0.5),
        rect(0.0, 0.5, 0.5, 1.0),
        rect(0.5, 0.5, 1.0, 1.0),
    );
    let shade = |alpha| Shape::Rect {
        x0: 0.0,
        y0: 0.0,
        x1: 1.0,
        y1: 1.0,
        alpha,
    };
    match cp {
        0x2580 => vec![rect(0.0, 0.0, 1.0, 0.5)],
        0x2581..=0x2588 => vec![rect(0.0, 1.0 - e(cp - 0x2580), 1.0, 1.0)],
        0x2589..=0x258F => vec![rect(0.0, 0.0, e(0x2590 - cp), 1.0)],
        0x2590 => vec![rect(0.5, 0.0, 1.0, 1.0)],
        0x2591 => vec![shade(0.25)],
        0x2592 => vec![shade(0.5)],
        0x2593 => vec![shade(0.75)],
        0x2594 => vec![rect(0.0, 0.0, 1.0, e(1))],
        0x2595 => vec![rect(e(7), 0.0, 1.0, 1.0)],
        0x2596 => vec![ll],
        0x2597 => vec![lr],
        0x2598 => vec![ul],
        0x2599 => vec![ul, ll, lr],
        0x259A => vec![ul, lr],
        0x259B => vec![ul, ur, ll],
        0x259C => vec![ul, ur, lr],
        0x259D => vec![ur],
        0x259E => vec![ur, ll],
        _ => vec![ur, ll, lr], // 0x259F
    }
}

/// Arms of the common box-drawing chars: (up, down, left, right), 0 none / 1 light / 2 heavy.
fn arms(cp: u32) -> Option<[u8; 4]> {
    Some(match cp {
        0x2500 => [0, 0, 1, 1],          // ─
        0x2501 => [0, 0, 2, 2],          // ━
        0x2502 => [1, 1, 0, 0],          // │
        0x2503 => [2, 2, 0, 0],          // ┃
        0x250C | 0x256D => [0, 1, 0, 1], // ┌ ╭ (rounded drawn square)
        0x250F => [0, 2, 0, 2],
        0x2510 | 0x256E => [0, 1, 1, 0], // ┐ ╮
        0x2513 => [0, 2, 2, 0],
        0x2514 | 0x2570 => [1, 0, 0, 1], // └ ╰
        0x2517 => [2, 0, 0, 2],
        0x2518 | 0x256F => [1, 0, 1, 0], // ┘ ╯
        0x251B => [2, 0, 2, 0],
        0x251C => [1, 1, 0, 1], // ├
        0x2523 => [2, 2, 0, 2],
        0x2524 => [1, 1, 1, 0], // ┤
        0x252B => [2, 2, 2, 0],
        0x252C => [0, 1, 1, 1], // ┬
        0x2533 => [0, 2, 2, 2],
        0x2534 => [1, 0, 1, 1], // ┴
        0x253B => [2, 0, 2, 2],
        0x253C => [1, 1, 1, 1], // ┼
        0x254B => [2, 2, 2, 2],
        0x2574 => [0, 0, 1, 0], // ╴
        0x2575 => [1, 0, 0, 0],
        0x2576 => [0, 0, 0, 1],
        0x2577 => [0, 1, 0, 0],
        _ => return None,
    })
}

fn box_drawing(cp: u32) -> Option<Vec<Shape>> {
    match cp {
        0x2571 => return Some(vec![Shape::Diag { down: false }]),
        0x2572 => return Some(vec![Shape::Diag { down: true }]),
        _ => {}
    }
    let [up, down, left, right] = arms(cp)?;
    let mut out = Vec::new();
    // Arms meet at the center; a straight line is one shape so it has no seam.
    if left > 0 && right > 0 && left == right {
        out.push(Shape::HLine {
            from: 0.0,
            to: 1.0,
            heavy: left == 2,
        });
    } else {
        if left > 0 {
            out.push(Shape::HLine {
                from: 0.0,
                to: 0.5,
                heavy: left == 2,
            });
        }
        if right > 0 {
            out.push(Shape::HLine {
                from: 0.5,
                to: 1.0,
                heavy: right == 2,
            });
        }
    }
    if up > 0 && down > 0 && up == down {
        out.push(Shape::VLine {
            from: 0.0,
            to: 1.0,
            heavy: up == 2,
        });
    } else {
        if up > 0 {
            out.push(Shape::VLine {
                from: 0.0,
                to: 0.5,
                heavy: up == 2,
            });
        }
        if down > 0 {
            out.push(Shape::VLine {
                from: 0.5,
                to: 1.0,
                heavy: down == 2,
            });
        }
    }
    Some(out)
}

const H_LINE: Shape = Shape::HLine {
    from: 0.0,
    to: 1.0,
    heavy: false,
};
const V_LINE: Shape = Shape::VLine {
    from: 0.0,
    to: 1.0,
    heavy: false,
};

/// Ghostty's branch drawing set (Kitty's spec): lines, fading lines, arcs and their
/// combinations, then 16 nodes (arm sets) in filled / outline pairs.
fn branch(cp: u32) -> Vec<Shape> {
    use Corner::*;
    use Shape::Arc;
    match cp {
        0xF5D0 => vec![H_LINE],
        0xF5D1 => vec![V_LINE],
        0xF5D2 => vec![Shape::Fade(Edge::Right)],
        0xF5D3 => vec![Shape::Fade(Edge::Left)],
        0xF5D4 => vec![Shape::Fade(Edge::Bottom)],
        0xF5D5 => vec![Shape::Fade(Edge::Top)],
        0xF5D6 => vec![Arc(BottomRight)],
        0xF5D7 => vec![Arc(BottomLeft)],
        0xF5D8 => vec![Arc(TopRight)],
        0xF5D9 => vec![Arc(TopLeft)],
        0xF5DA => vec![V_LINE, Arc(TopRight)],
        0xF5DB => vec![V_LINE, Arc(BottomRight)],
        0xF5DC => vec![Arc(TopRight), Arc(BottomRight)],
        0xF5DD => vec![V_LINE, Arc(TopLeft)],
        0xF5DE => vec![V_LINE, Arc(BottomLeft)],
        0xF5DF => vec![Arc(TopLeft), Arc(BottomLeft)],
        0xF5E0 => vec![Arc(BottomLeft), H_LINE],
        0xF5E1 => vec![Arc(BottomRight), H_LINE],
        0xF5E2 => vec![Arc(BottomRight), Arc(BottomLeft)],
        0xF5E3 => vec![Arc(TopLeft), H_LINE],
        0xF5E4 => vec![Arc(TopRight), H_LINE],
        0xF5E5 => vec![Arc(TopRight), Arc(TopLeft)],
        0xF5E6 => vec![V_LINE, Arc(TopLeft), Arc(TopRight)],
        0xF5E7 => vec![V_LINE, Arc(BottomLeft), Arc(BottomRight)],
        0xF5E8 => vec![H_LINE, Arc(BottomLeft), Arc(TopLeft)],
        0xF5E9 => vec![H_LINE, Arc(TopRight), Arc(BottomRight)],
        0xF5EA => vec![V_LINE, Arc(TopLeft), Arc(BottomRight)],
        0xF5EB => vec![V_LINE, Arc(TopRight), Arc(BottomLeft)],
        0xF5EC => vec![H_LINE, Arc(TopLeft), Arc(BottomRight)],
        0xF5ED => vec![H_LINE, Arc(TopRight), Arc(BottomLeft)],
        _ => {
            // U+F5EE..U+F60D: (up, right, down, left), even code points filled
            const ARMS: [[bool; 4]; 16] = {
                let (t, f) = (true, false);
                [
                    [f, f, f, f],
                    [f, t, f, f],
                    [f, f, f, t],
                    [f, t, f, t],
                    [f, f, t, f],
                    [t, f, f, f],
                    [t, f, t, f],
                    [f, t, t, f],
                    [f, f, t, t],
                    [t, t, f, f],
                    [t, f, f, t],
                    [t, t, t, f],
                    [t, f, t, t],
                    [f, t, t, t],
                    [t, t, f, t],
                    [t, t, t, t],
                ]
            };
            let k = (cp - 0xF5EE) as usize;
            vec![Shape::Node {
                arms: ARMS[k / 2],
                filled: k.is_multiple_of(2),
            }]
        }
    }
}

/// U+1FB00..U+1FB3B: 2x3 blocks. The code points skip the two patterns that are half blocks.
fn sextant(cp: u32) -> Vec<Shape> {
    let idx = cp - 0x1FB00;
    let bits = idx + idx / 0x14 + 1;
    let t = 1.0 / 3.0;
    let cells = [
        (0.0, 0.0, 0.5, t),
        (0.5, 0.0, 1.0, t),
        (0.0, t, 0.5, 2.0 * t),
        (0.5, t, 1.0, 2.0 * t),
        (0.0, 2.0 * t, 0.5, 1.0),
        (0.5, 2.0 * t, 1.0, 1.0),
    ];
    cells
        .iter()
        .enumerate()
        .filter(|(i, _)| bits & (1 << i) != 0)
        .map(|(_, &(x0, y0, x1, y1))| rect(x0, y0, x1, y1))
        .collect()
}

/// U+1FB3C..U+1FB67 as 4 rows x 3 columns of points ('#' = corner of the filled polygon).
const MOSAICS: [&str; 44] = [
    "......#..##.",
    "......#\\.###",
    "...#..#\\.##.",
    "...#..##.###",
    "#..#..##.##.",
    "/###########",
    "./##########",
    ".##.########",
    "..#.########",
    ".##.##.#####",
    "..../#######",
    "........#.##",
    "......./####",
    ".....#./#.##",
    ".....#.#####",
    "..#..#.##.##",
    "##\\#########",
    "#\\.#########",
    "##.##.######",
    "#..##.######",
    "##.##.##.###",
    "...#\\.######",
    "#########\\##",
    "#########.\\#",
    "######.##.##",
    "######.##..#",
    "###.##.##.##",
    "##.#........",
    "####/.......",
    "##.#/.#.....",
    "#####.#.....",
    "##.##.#..#..",
    "#######/....",
    "###########/",
    "##########/.",
    "########.##.",
    "########.#..",
    "#####.##.##.",
    ".##..#......",
    "###.\\#......",
    ".##.\\#..#...",
    "###.##..#...",
    ".##.##..#..#",
    "######.\\#...",
];

fn smooth_mosaic(cp: u32) -> Shape {
    let p: Vec<bool> = MOSAICS[(cp - 0x1FB3C) as usize]
        .chars()
        .map(|c| c == '#')
        .collect();
    let at = |row: usize, col: usize| p[row * 3 + col];
    let t = 1.0 / 3.0;
    // Perimeter points counterclockwise from the top-left; a middle point on a straight filled
    // edge is skipped (it's not a corner).
    let points = [
        (at(0, 0), (0.0, 0.0)),
        (at(1, 0) && !(at(0, 0) && at(2, 0)), (0.0, t)),
        (at(2, 0) && !(at(1, 0) && at(3, 0)), (0.0, 2.0 * t)),
        (at(3, 0), (0.0, 1.0)),
        (at(3, 1) && !(at(3, 0) && at(3, 2)), (0.5, 1.0)),
        (at(3, 2), (1.0, 1.0)),
        (at(2, 2) && !(at(3, 2) && at(1, 2)), (1.0, 2.0 * t)),
        (at(1, 2) && !(at(2, 2) && at(0, 2)), (1.0, t)),
        (at(0, 2), (1.0, 0.0)),
        (at(0, 1) && !(at(0, 2) && at(0, 0)), (0.5, 0.0)),
    ];
    Shape::Poly(
        points
            .iter()
            .filter(|(on, _)| *on)
            .map(|(_, p)| *p)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `sprite` gives for a char.
    enum Drawn {
        /// The font draws it.
        Font,
        /// Exactly these shapes.
        Shapes(fn() -> Vec<Shape>),
        /// This many shapes.
        Count(usize),
        /// One polygon with this many corners.
        Corners(usize),
    }
    use Drawn::*;

    const SPRITES: &[(char, Drawn)] = &[
        ('a', Font),
        // blocks the config uses
        ('▐', Shapes(|| vec![rect(0.5, 0.0, 1.0, 1.0)])),
        ('▁', Shapes(|| vec![rect(0.0, 0.875, 1.0, 1.0)])),
        ('█', Shapes(|| vec![rect(0.0, 0.0, 1.0, 1.0)])),
        ('▎', Shapes(|| vec![rect(0.0, 0.0, 0.25, 1.0)])),
        // box lines; a straight line is one shape, with no seam
        ('│', Shapes(|| vec![V_LINE])),
        ('┬', Count(2)),
        // sextants skip the two patterns that are half blocks: U+1FB14 is tr, ml and bl
        ('\u{1fb00}', Shapes(|| vec![rect(0.0, 0.0, 0.5, 1.0 / 3.0)])),
        ('\u{1fb14}', Count(3)),
        // smooth mosaics keep only real corners
        (
            '\u{1fb48}',
            Shapes(|| vec![Shape::Poly(vec![(0.0, 1.0), (1.0, 1.0), (1.0, 2.0 / 3.0)])]),
        ),
        ('\u{1fb41}', Corners(5)),
        // branch glyphs: a lane, nodes, a lane with arcs
        ('\u{f5d1}', Shapes(|| vec![V_LINE])),
        (
            '\u{f5fa}',
            Shapes(|| {
                vec![Shape::Node {
                    arms: [true, false, true, false],
                    filled: true,
                }]
            }),
        ),
        (
            '\u{f5f7}',
            Shapes(|| {
                vec![Shape::Node {
                    arms: [false, false, true, false],
                    filled: false,
                }]
            }),
        ),
        (
            '\u{f60d}',
            Shapes(|| {
                vec![Shape::Node {
                    arms: [true; 4],
                    filled: false,
                }]
            }),
        ),
        (
            '\u{f5eb}',
            Shapes(|| {
                vec![
                    V_LINE,
                    Shape::Arc(Corner::TopRight),
                    Shape::Arc(Corner::BottomLeft),
                ]
            }),
        ),
    ];

    #[test]
    fn a_char_is_drawn_as_shapes_or_by_the_font() {
        for (ch, drawn) in SPRITES {
            let got = sprite(*ch);
            let name = format!("U+{:X}", *ch as u32);
            match drawn {
                Font => assert_eq!(got, None, "{name}"),
                Shapes(want) => assert_eq!(got, Some(want()), "{name}"),
                Count(n) => assert_eq!(got.map(|s| s.len()), Some(*n), "{name}"),
                Corners(n) => {
                    assert!(
                        matches!(got.as_deref(), Some([Shape::Poly(p)]) if p.len() == *n),
                        "{name}: {got:?}"
                    )
                }
            }
        }
        // every branch glyph of Ghostty's range draws
        for cp in 0xF5D0..=0xF60D {
            let ch = char::from_u32(cp).unwrap();
            assert!(sprite(ch).is_some_and(|s| !s.is_empty()), "U+{cp:X}");
        }
    }
}
