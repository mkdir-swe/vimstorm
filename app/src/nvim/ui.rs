//! UI state built from redraw batches (applied on the UI thread, one batch per `flush`).
//!
//! Holds the grids, highlights, window placement and mode; [`UiState::layers`] gives the
//! composition order the renderer draws and the mouse hit-test walks.

use std::collections::HashMap;

use rmpv::Value;

use super::redraw::{Anchor, CursorShape, GridId, HlAttr, ModeInfo, RedrawEvent};

/// WebStorm's caret: Darcula `CARET_COLOR` (= darcula-contrast.lua's `Cursor` bg, Ghostty's
/// `cursor-color`).
pub const CARET_COLOR: u32 = 0xbbbbbb;

/// Text of one cell. A double-width char is followed by a cell with [`CellText::Empty`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum CellText {
    #[default]
    Space,
    Empty,
    Char(char),
    Str(Box<str>),
}

impl CellText {
    pub fn new(s: &str) -> Self {
        let mut chars = s.chars();
        match (chars.next(), chars.next()) {
            (None, _) => CellText::Empty,
            (Some(' '), None) => CellText::Space,
            (Some(c), None) => CellText::Char(c),
            _ => CellText::Str(s.into()),
        }
    }

    pub fn push_to(&self, out: &mut String) {
        match self {
            CellText::Space => out.push(' '),
            CellText::Empty => {}
            CellText::Char(c) => out.push(*c),
            CellText::Str(s) => out.push_str(s),
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, CellText::Empty)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cell {
    pub text: CellText,
    pub hl: u32,
}

/// Rows a window's `grid_scroll` pushed out, kept for smooth scrolling.
const KEEP_ROWS: usize = 2;

#[derive(Clone, Debug, Default)]
pub struct Grid {
    pub width: usize,
    pub height: usize,
    /// Row-major, `width * height`.
    pub cells: Vec<Cell>,
    /// Rows the last text-area scroll pushed out at the top / bottom (row-major, at most
    /// [`KEEP_ROWS`], in screen order): smooth scrolling draws them in the edge it reveals.
    pub above: Vec<Cell>,
    pub below: Vec<Cell>,
    /// Text-area scroll in the current batch (+ = content moved up).
    pub scrolled: i64,
}

impl Grid {
    pub fn row(&self, row: usize) -> &[Cell] {
        &self.cells[row * self.width..(row + 1) * self.width]
    }

    pub fn cell(&self, row: usize, col: usize) -> Option<&Cell> {
        (row < self.height && col < self.width).then(|| &self.cells[row * self.width + col])
    }

    /// Text of a row (double-width continuation cells add nothing).
    pub fn row_text(&self, row: usize) -> String {
        let mut s = String::with_capacity(self.width);
        for c in self.row(row) {
            c.text.push_to(&mut s);
        }
        s
    }

    /// Rows in [`Grid::above`] / [`Grid::below`].
    pub fn kept_rows(&self) -> (usize, usize) {
        let w = self.width.max(1);
        (self.above.len() / w, self.below.len() / w)
    }

    fn resize(&mut self, width: usize, height: usize) {
        let mut cells = vec![Cell::default(); width * height];
        for r in 0..height.min(self.height) {
            for c in 0..width.min(self.width) {
                cells[r * width + c] = std::mem::take(&mut self.cells[r * self.width + c]);
            }
        }
        *self = Grid {
            width,
            height,
            cells,
            ..Grid::default()
        };
    }

    fn clear(&mut self) {
        self.cells.fill(Cell::default());
        self.forget_kept();
    }

    fn forget_kept(&mut self) {
        self.above.clear();
        self.below.clear();
    }

    /// `grid_scroll`: rows > 0 moves the region's content up. `text_area`: the region is the
    /// window's whole text area (a scroll, or lines deleted / inserted at its top): keep the rows
    /// that leave it.
    fn scroll(
        &mut self,
        top: usize,
        bot: usize,
        left: usize,
        right: usize,
        rows: i64,
        text_area: bool,
    ) {
        let (bot, right) = (bot.min(self.height), right.min(self.width));
        if top >= bot || left >= right {
            return;
        }
        let w = self.width;
        if text_area && rows != 0 {
            let n = (rows.unsigned_abs() as usize).min(bot - top);
            let k = n.min(KEEP_ROWS);
            // the rows next to the content that stays
            let (first, keep, other) = if rows > 0 {
                (top + n - k, &mut self.above, &mut self.below)
            } else {
                (bot - n, &mut self.below, &mut self.above)
            };
            keep.clear();
            keep.extend_from_slice(&self.cells[first * w..(first + k) * w]);
            other.clear();
            self.scrolled += rows;
        } else {
            self.forget_kept();
        }
        let copy_row = |cells: &mut Vec<Cell>, from: usize, to: usize| {
            for c in left..right {
                cells[to * w + c] = cells[from * w + c].clone();
            }
        };
        if rows > 0 {
            let n = rows as usize;
            for to in top..bot.saturating_sub(n) {
                copy_row(&mut self.cells, to + n, to);
            }
        } else if rows < 0 {
            let n = (-rows) as usize;
            for to in (top + n..bot).rev() {
                copy_row(&mut self.cells, to - n, to);
            }
        }
    }
}

/// How a grid is placed on the screen.
#[derive(Clone, Debug, PartialEq)]
pub enum Placement {
    /// A split window at a position of grid 1.
    Split { row: usize, col: usize },
    Float {
        anchor: Anchor,
        anchor_grid: GridId,
        anchor_row: f64,
        anchor_col: f64,
        screen_pos: Option<(f64, f64)>,
        mouse_enabled: bool,
        zindex: i64,
        compindex: i64,
    },
    /// The message grid, full width at a row of grid 1.
    Message {
        row: usize,
        scrolled: bool,
        sep_char: String,
        zindex: i64,
        compindex: i64,
    },
}

#[derive(Clone, Debug)]
pub struct Window {
    pub win: i64,
    pub placement: Placement,
    pub hidden: bool,
    /// Outer size from `win_pos` (the grid's own size can differ while nvim catches up).
    pub width: usize,
    pub height: usize,
    pub viewport: Option<Viewport>,
    /// `win_viewport_margins`: rows / cols that are not text (winbar, float border).
    pub margins: Margins,
    /// Sum of `win_viewport` scroll_delta in the current batch (+ = topline moved down).
    pub scroll_lines: i64,
}

impl Window {
    /// Grid rows of the text area (below the winbar / border).
    pub fn text_rows(&self, grid_height: usize) -> std::ops::Range<usize> {
        let top = self.margins.top.min(grid_height);
        top..grid_height.saturating_sub(self.margins.bottom).max(top)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Viewport {
    pub topline: i64,
    pub botline: i64,
    pub curline: i64,
    pub curcol: i64,
    pub line_count: i64,
    pub scroll_delta: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Margins {
    pub top: usize,
    pub bottom: usize,
    pub left: usize,
    pub right: usize,
}

/// One grid as drawn: its top-left on the screen (in cells of grid 1) and stacking info.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Layer {
    pub grid: GridId,
    pub row: i64,
    pub col: i64,
    pub width: usize,
    pub height: usize,
    /// Floats / message grid; drawn after the base and split windows.
    pub floating: bool,
    pub mouse_enabled: bool,
    pub zindex: i64,
}

impl Layer {
    pub fn contains(&self, row: i64, col: i64) -> bool {
        row >= self.row
            && col >= self.col
            && row < self.row + self.height as i64
            && col < self.col + self.width as i64
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CursorPos {
    pub grid: GridId,
    pub row: usize,
    pub col: usize,
}

/// The caret as the renderer needs it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Caret {
    /// Screen cell (grid 1 coordinates).
    pub row: i64,
    pub col: i64,
    pub shape: CursorShape,
    /// 1..=100: share of the cell the bar / underline covers.
    pub percentage: u32,
    /// hl id for the caret colors (0 = swap the cell's fg / bg).
    pub attr_id: u32,
    /// The char under a block caret is two cells wide.
    pub wide: bool,
}

#[derive(Default)]
pub struct UiState {
    pub grids: HashMap<GridId, Grid>,
    pub windows: HashMap<GridId, Window>,
    /// Indexed by hl id; 0 = default colors.
    pub hl: Vec<HlAttr>,
    /// Builtin UI group name -> hl id (`hl_group_set`).
    pub hl_groups: HashMap<String, u32>,
    pub default_fg: u32,
    pub default_bg: u32,
    pub default_sp: u32,
    pub cursor: CursorPos,
    pub cursor_style_enabled: bool,
    pub modes: Vec<ModeInfo>,
    pub mode: String,
    pub mode_idx: usize,
    pub title: String,
    pub options: HashMap<String, Value>,
    pub busy: bool,
    pub mouse_enabled: bool,
    /// Number of flushes applied (tests wait on it).
    pub flushes: u64,
    /// Order windows were first placed, so splits keep a stable draw order.
    order: HashMap<GridId, u64>,
    next_order: u64,
}

impl UiState {
    pub fn new() -> Self {
        UiState {
            default_fg: 0xffffff,
            default_bg: 0x000000,
            default_sp: 0xff0000,
            mouse_enabled: true,
            ..Default::default()
        }
    }

    /// Applies one batch. Returns whether the batch ended with a flush (i.e. should be drawn).
    pub fn apply(&mut self, events: Vec<RedrawEvent>) -> bool {
        for g in self.grids.values_mut() {
            g.scrolled = 0;
        }
        for w in self.windows.values_mut() {
            w.scroll_lines = 0;
        }
        let mut flushed = false;
        for ev in events {
            flushed = matches!(ev, RedrawEvent::Flush);
            self.apply_one(ev);
        }
        flushed
    }

    fn apply_one(&mut self, ev: RedrawEvent) {
        use RedrawEvent as E;
        match ev {
            E::SetTitle(t) => self.title = t,
            E::ModeInfoSet {
                cursor_style_enabled,
                modes,
            } => {
                self.cursor_style_enabled = cursor_style_enabled;
                self.modes = modes;
            }
            E::OptionSet(name, value) => {
                self.options.insert(name, value);
            }
            E::ModeChange { mode, mode_idx } => {
                self.mode = mode;
                self.mode_idx = mode_idx;
            }
            E::MouseOn => self.mouse_enabled = true,
            E::MouseOff => self.mouse_enabled = false,
            E::BusyStart => self.busy = true,
            E::BusyStop => self.busy = false,
            E::Flush => {
                self.flushes += 1;
                // a window whose topline moved without a text-area grid_scroll was redrawn whole:
                // its kept rows aren't next to its content anymore
                for (grid, w) in &self.windows {
                    if w.scroll_lines != 0
                        && let Some(g) = self.grids.get_mut(grid)
                        && g.scrolled == 0
                    {
                        g.forget_kept();
                    }
                }
            }
            E::DefaultColorsSet { fg, bg, sp } => {
                self.default_fg = fg.unwrap_or(0xffffff);
                self.default_bg = bg.unwrap_or(0x000000);
                self.default_sp = sp.unwrap_or(0xff0000);
            }
            E::HlAttrDefine { id, attrs } => {
                let id = id as usize;
                if self.hl.len() <= id {
                    self.hl.resize(id + 1, HlAttr::default());
                }
                self.hl[id] = attrs;
            }
            E::HlGroupSet { name, id } => {
                self.hl_groups.insert(name, id);
            }
            E::GridResize {
                grid,
                width,
                height,
            } => self.grids.entry(grid).or_default().resize(width, height),
            E::GridClear { grid } => {
                if let Some(g) = self.grids.get_mut(&grid) {
                    g.clear();
                }
            }
            E::GridCursorGoto { grid, row, col } => self.cursor = CursorPos { grid, row, col },
            E::GridLine {
                grid,
                row,
                col_start,
                cells,
            } => {
                let Some(g) = self.grids.get_mut(&grid) else {
                    return;
                };
                if row >= g.height {
                    return;
                }
                let mut col = col_start;
                let base = row * g.width;
                for c in cells {
                    let text = CellText::new(&c.text);
                    for _ in 0..c.repeat {
                        if col >= g.width {
                            break;
                        }
                        g.cells[base + col] = Cell {
                            text: text.clone(),
                            hl: c.hl,
                        };
                        col += 1;
                    }
                }
            }
            E::GridScroll {
                grid,
                top,
                bot,
                left,
                right,
                rows,
            } => {
                let text_area = self.windows.get(&grid).is_some_and(|w| {
                    let m = w.margins;
                    let h = self.grids.get(&grid).map_or(0, |g| g.height);
                    let wd = self.grids.get(&grid).map_or(0, |g| g.width);
                    top == m.top && left == m.left && bot + m.bottom >= h && right + m.right >= wd
                });
                if let Some(g) = self.grids.get_mut(&grid) {
                    g.scroll(top, bot, left, right, rows, text_area);
                }
            }
            E::GridDestroy { grid } => {
                self.grids.remove(&grid);
                self.windows.remove(&grid);
                self.order.remove(&grid);
            }
            E::WinPos {
                grid,
                win,
                start_row,
                start_col,
                width,
                height,
            } => self.place(
                grid,
                win,
                Placement::Split {
                    row: start_row,
                    col: start_col,
                },
                width,
                height,
            ),
            E::WinFloatPos {
                grid,
                win,
                anchor,
                anchor_grid,
                anchor_row,
                anchor_col,
                mouse_enabled,
                zindex,
                compindex,
                screen_pos,
            } => {
                let (w, h) = self
                    .grids
                    .get(&grid)
                    .map(|g| (g.width, g.height))
                    .unwrap_or((0, 0));
                self.place(
                    grid,
                    win,
                    Placement::Float {
                        anchor,
                        anchor_grid,
                        anchor_row,
                        anchor_col,
                        screen_pos,
                        mouse_enabled,
                        zindex,
                        compindex,
                    },
                    w,
                    h,
                )
            }
            E::MsgSetPos {
                grid,
                row,
                scrolled,
                sep_char,
                zindex,
                compindex,
            } => {
                // grid 0: no message grid yet
                if grid == 0 {
                    return;
                }
                let (w, h) = self
                    .grids
                    .get(&grid)
                    .map(|g| (g.width, g.height))
                    .unwrap_or((0, 0));
                self.place(
                    grid,
                    0,
                    Placement::Message {
                        row,
                        scrolled,
                        sep_char,
                        zindex,
                        compindex,
                    },
                    w,
                    h,
                )
            }
            E::WinHide { grid } => {
                if let Some(w) = self.windows.get_mut(&grid) {
                    w.hidden = true;
                }
            }
            E::WinClose { grid } => {
                self.windows.remove(&grid);
                self.order.remove(&grid);
            }
            E::WinViewport {
                grid,
                topline,
                botline,
                curline,
                curcol,
                line_count,
                scroll_delta,
                ..
            } => {
                if let Some(w) = self.windows.get_mut(&grid) {
                    w.scroll_lines += scroll_delta;
                    w.viewport = Some(Viewport {
                        topline,
                        botline,
                        curline,
                        curcol,
                        line_count,
                        scroll_delta,
                    });
                }
            }
            E::WinViewportMargins {
                grid,
                top,
                bottom,
                left,
                right,
                ..
            } => {
                if let Some(w) = self.windows.get_mut(&grid) {
                    w.margins = Margins {
                        top,
                        bottom,
                        left,
                        right,
                    };
                }
            }
            E::WinExternalPos { .. } | E::Bell | E::VisualBell | E::Chdir(_) | E::Unknown(_) => {}
        }
    }

    fn place(&mut self, grid: GridId, win: i64, placement: Placement, width: usize, height: usize) {
        if !self.order.contains_key(&grid) {
            self.order.insert(grid, self.next_order);
            self.next_order += 1;
        }
        let w = self.windows.entry(grid).or_insert_with(|| Window {
            win,
            placement: placement.clone(),
            hidden: false,
            width,
            height,
            viewport: None,
            margins: Margins::default(),
            scroll_lines: 0,
        });
        w.win = win;
        w.placement = placement;
        w.hidden = false;
        w.width = width;
        w.height = height;
    }

    pub fn hl_attr(&self, id: u32) -> &HlAttr {
        static DEFAULT: HlAttr = HlAttr {
            fg: None,
            bg: None,
            sp: None,
            reverse: false,
            bold: false,
            italic: false,
            underline: false,
            undercurl: false,
            underdouble: false,
            underdotted: false,
            underdashed: false,
            strikethrough: false,
            blend: 0,
            name: None,
        };
        self.hl.get(id as usize).unwrap_or(&DEFAULT)
    }

    /// Caret colors (fill, text under a block caret): one fixed color like WebStorm's caret,
    /// never the cell's. From the mode's `attr_id` (else the `Cursor` group, which nvim's default
    /// 'guicursor' doesn't name) where it sets a bg; else [`CARET_COLOR`] and the editor bg.
    pub fn caret_colors(&self, attr_id: u32) -> (u32, u32) {
        let id = match attr_id {
            0 => self.hl_groups.get("Cursor").copied().unwrap_or(0),
            id => id,
        };
        let a = self.hl_attr(id);
        let (fill, text) = if a.reverse {
            (a.fg, a.bg)
        } else {
            (a.bg, a.fg)
        };
        match fill {
            Some(fill) => (fill, text.unwrap_or(self.default_bg)),
            None => (CARET_COLOR, self.default_bg),
        }
    }

    /// Resolved (fg, bg, sp) of an hl id, with `reverse` applied.
    pub fn colors(&self, id: u32) -> (u32, u32, u32) {
        let a = self.hl_attr(id);
        let fg = a.fg.unwrap_or(self.default_fg);
        let bg = a.bg.unwrap_or(self.default_bg);
        let sp = a.sp.unwrap_or(fg);
        if a.reverse {
            (bg, fg, sp)
        } else {
            (fg, bg, sp)
        }
    }

    /// Size of grid 1 (the screen) in cells.
    pub fn screen_size(&self) -> (usize, usize) {
        self.grids
            .get(&1)
            .map(|g| (g.width, g.height))
            .unwrap_or((0, 0))
    }

    /// Top-left screen cell of a placed grid (grid 1 is at 0,0).
    pub fn grid_origin(&self, grid: GridId) -> Option<(i64, i64)> {
        self.grid_origin_depth(grid, 0)
    }

    fn grid_origin_depth(&self, grid: GridId, depth: u8) -> Option<(i64, i64)> {
        if grid == 1 {
            return Some((0, 0));
        }
        let w = self.windows.get(&grid)?;
        if w.hidden {
            return None;
        }
        Some(match &w.placement {
            Placement::Split { row, col } => (*row as i64, *col as i64),
            Placement::Message { row, .. } => (*row as i64, 0),
            Placement::Float {
                anchor,
                anchor_grid,
                anchor_row,
                anchor_col,
                screen_pos,
                ..
            } => {
                if let Some((r, c)) = screen_pos {
                    (r.floor() as i64, c.floor() as i64)
                } else {
                    // Older nvims: place relative to the anchor grid's screen position.
                    if depth > 8 {
                        return None;
                    }
                    let (ar, ac) = self.grid_origin_depth(*anchor_grid, depth + 1)?;
                    let (gw, gh) = self
                        .grids
                        .get(&grid)
                        .map(|g| (g.width as f64, g.height as f64))
                        .unwrap_or((0.0, 0.0));
                    let (mut r, mut c) = (*anchor_row, *anchor_col);
                    if matches!(anchor, Anchor::SW | Anchor::SE) {
                        r -= gh;
                    }
                    if matches!(anchor, Anchor::NE | Anchor::SE) {
                        c -= gw;
                    }
                    (ar + r.floor() as i64, ac + c.floor() as i64)
                }
            }
        })
    }

    /// Grids to draw, bottom to top: grid 1, split windows, then floats and the message grid in
    /// nvim's `compindex` order. Hidden / closed windows are left out.
    pub fn layers(&self) -> Vec<Layer> {
        let mut out = Vec::with_capacity(self.windows.len() + 1);
        if let Some(g) = self.grids.get(&1) {
            out.push(Layer {
                grid: 1,
                row: 0,
                col: 0,
                width: g.width,
                height: g.height,
                floating: false,
                mouse_enabled: true,
                zindex: 0,
            });
        }
        let mut splits = Vec::new();
        let mut floats = Vec::new();
        for (&grid, w) in &self.windows {
            if w.hidden || grid == 1 {
                continue;
            }
            let Some(g) = self.grids.get(&grid) else {
                continue;
            };
            let Some((row, col)) = self.grid_origin(grid) else {
                continue;
            };
            let order = self.order.get(&grid).copied().unwrap_or(u64::MAX);
            let mut layer = Layer {
                grid,
                row,
                col,
                width: g.width,
                height: g.height,
                floating: false,
                mouse_enabled: true,
                zindex: 0,
            };
            match &w.placement {
                Placement::Split { .. } => splits.push((order, layer)),
                Placement::Float {
                    zindex,
                    compindex,
                    mouse_enabled,
                    ..
                } => {
                    layer.floating = true;
                    layer.zindex = *zindex;
                    layer.mouse_enabled = *mouse_enabled;
                    floats.push(((*compindex, *zindex, order), layer));
                }
                Placement::Message {
                    zindex, compindex, ..
                } => {
                    layer.floating = true;
                    layer.zindex = *zindex;
                    floats.push(((*compindex, *zindex, order), layer));
                }
            }
        }
        splits.sort_by_key(|(o, _)| *o);
        floats.sort_by_key(|(k, _)| *k);
        out.extend(splits.into_iter().map(|(_, l)| l));
        out.extend(floats.into_iter().map(|(_, l)| l));
        out
    }

    /// The separator line above a message grid that scrolled over the windows: (screen row,
    /// fill char, hl id of MsgSeparator), drawn full width like the TUI does.
    pub fn msg_separator(&self) -> Option<(i64, String, u32)> {
        self.windows.values().find_map(|w| match &w.placement {
            Placement::Message {
                row,
                scrolled: true,
                sep_char,
                ..
            } if !w.hidden && *row > 0 => Some((
                *row as i64 - 1,
                if sep_char.is_empty() {
                    " ".into()
                } else {
                    sep_char.clone()
                },
                self.hl_groups.get("MsgSeparator").copied().unwrap_or(0),
            )),
            _ => None,
        })
    }

    /// Topmost mouse-enabled grid under a screen cell: (grid, row, col) in that grid.
    pub fn hit_test(&self, row: i64, col: i64) -> Option<(GridId, usize, usize)> {
        self.layers()
            .iter()
            .rev()
            .filter(|l| l.mouse_enabled)
            .find(|l| l.contains(row, col))
            .map(|l| (l.grid, (row - l.row) as usize, (col - l.col) as usize))
    }

    /// How far the last batch scrolled a window's text, in rows (+ = content up). A grid_scroll
    /// without a topline change (lines deleted / inserted at the top) is no scroll.
    pub fn text_scroll(&self, grid: GridId) -> i64 {
        let lines = self.windows.get(&grid).map_or(0, |w| w.scroll_lines);
        if lines == 0 {
            return 0;
        }
        match self.grids.get(&grid).map_or(0, |g| g.scrolled) {
            // redrawn whole: the viewport's lines (no wrap in the editor) stand in for rows
            0 => lines,
            rows => rows,
        }
    }

    /// The caret to draw, if its grid is visible.
    pub fn caret(&self) -> Option<Caret> {
        self.caret_at(self.cursor, self.grids.get(&self.cursor.grid)?)
    }

    /// The caret at `cursor` on `grid` (nvim's cursor grid, or what's drawn in its place: local
    /// echo's, [`super::echo`]), if its grid is visible.
    pub fn caret_at(&self, cursor: CursorPos, grid: &Grid) -> Option<Caret> {
        let (r0, c0) = self.grid_origin(cursor.grid)?;
        if cursor.row >= grid.height || cursor.col >= grid.width {
            return None;
        }
        let mode = self.modes.get(self.mode_idx);
        let shape = if self.cursor_style_enabled {
            mode.and_then(|m| m.cursor_shape).unwrap_or_default()
        } else {
            CursorShape::Block
        };
        let percentage = mode
            .and_then(|m| m.cell_percentage)
            .filter(|p| *p > 0)
            .unwrap_or(100)
            .min(100);
        let wide = grid
            .cell(cursor.row, cursor.col + 1)
            .is_some_and(|c| c.text.is_empty());
        Some(Caret {
            row: r0 + cursor.row as i64,
            col: c0 + cursor.col as i64,
            shape,
            percentage,
            attr_id: mode.and_then(|m| m.attr_id).unwrap_or(0),
            wide,
        })
    }

    /// The composed screen as text, one string per row of grid 1 (tests, debugging).
    pub fn screen_lines(&self) -> Vec<String> {
        self.screen_lines_with(None)
    }

    /// [`UiState::screen_lines`] with `over` (a grid and what's drawn in its place) in nvim's
    /// grid's stead.
    pub fn screen_lines_with(&self, over: Option<(GridId, &Grid)>) -> Vec<String> {
        let (w, h) = self.screen_size();
        let mut screen = vec![vec![CellText::Space; w]; h];
        for layer in self.layers() {
            let g = match over {
                Some((grid, g)) if grid == layer.grid => g,
                _ => match self.grids.get(&layer.grid) {
                    Some(g) => g,
                    None => continue,
                },
            };
            for r in 0..g.height {
                let sr = layer.row + r as i64;
                if sr < 0 || sr >= h as i64 {
                    continue;
                }
                for c in 0..g.width {
                    let sc = layer.col + c as i64;
                    if sc < 0 || sc >= w as i64 {
                        continue;
                    }
                    screen[sr as usize][sc as usize] = g.cells[r * g.width + c].text.clone();
                }
            }
        }
        if let Some((row, sep, _)) = self.msg_separator()
            && let Some(line) = screen.get_mut(row as usize)
        {
            line.fill(CellText::new(&sep));
        }
        screen
            .into_iter()
            .map(|row| {
                let mut s = String::with_capacity(w);
                for t in &row {
                    t.push_to(&mut s);
                }
                s
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nvim::redraw::LineCell;

    fn line(grid: GridId, row: usize, col: usize, text: &str, hl: u32) -> RedrawEvent {
        RedrawEvent::GridLine {
            grid,
            row,
            col_start: col,
            cells: text
                .chars()
                .map(|c| LineCell {
                    text: c.to_string(),
                    hl,
                    repeat: 1,
                })
                .collect(),
        }
    }

    fn resize(grid: GridId, width: usize, height: usize) -> RedrawEvent {
        RedrawEvent::GridResize {
            grid,
            width,
            height,
        }
    }

    fn screen() -> UiState {
        let mut ui = UiState::new();
        ui.apply(vec![resize(1, 20, 6), RedrawEvent::Flush]);
        ui
    }

    #[test]
    fn text_area_scroll_keeps_the_rows_that_left() {
        use RedrawEvent as E;
        let mut ui = screen();
        let viewport = |topline, scroll_delta| E::WinViewport {
            grid: 2,
            win: 1000,
            topline,
            botline: topline + 4,
            curline: topline,
            curcol: 0,
            line_count: 50,
            scroll_delta,
        };
        let scroll = |top, rows| E::GridScroll {
            grid: 2,
            top,
            bot: 5,
            left: 0,
            right: 4,
            rows,
        };
        let row_text = |cells: &[Cell]| {
            let mut s = String::new();
            for c in cells {
                c.text.push_to(&mut s);
            }
            s
        };
        // a window with a winbar row: text area = rows 1..5
        ui.apply(vec![
            resize(2, 4, 5),
            E::WinPos {
                grid: 2,
                win: 1000,
                start_row: 0,
                start_col: 0,
                width: 4,
                height: 5,
            },
            E::WinViewportMargins {
                grid: 2,
                win: 1000,
                top: 1,
                bottom: 0,
                left: 0,
                right: 0,
            },
            line(2, 0, 0, "bar ", 0),
            line(2, 1, 0, "aaaa", 0),
            line(2, 2, 0, "bbbb", 0),
            line(2, 3, 0, "cccc", 0),
            line(2, 4, 0, "dddd", 0),
            viewport(0, 0),
            E::Flush,
        ]);
        assert_eq!(ui.windows[&2].text_rows(5), 1..5);
        // wheel down 3 rows: the last 2 rows that left at the top are kept
        ui.apply(vec![scroll(1, 3), viewport(3, 3), E::Flush]);
        assert_eq!(ui.text_scroll(2), 3);
        let g = &ui.grids[&2];
        assert_eq!(g.kept_rows(), (2, 0));
        assert_eq!(row_text(&g.above), "bbbbcccc");
        assert_eq!(g.row_text(0), "bar ");
        // a batch without scrolling: no scroll, the rows stay kept
        ui.apply(vec![line(2, 2, 0, "xxxx", 0), E::Flush]);
        assert_eq!(ui.text_scroll(2), 0);
        assert_eq!(ui.grids[&2].kept_rows(), (2, 0));
        // wheel up 1: the row that left at the bottom
        ui.apply(vec![scroll(1, -1), viewport(2, -1), E::Flush]);
        assert_eq!(ui.text_scroll(2), -1);
        let g = &ui.grids[&2];
        assert_eq!(g.kept_rows(), (0, 1));
        assert_eq!(row_text(&g.below), "dddd");
        // lines deleted at the top (no topline change): no scroll
        ui.apply(vec![scroll(1, 1), E::Flush]);
        assert_eq!(ui.text_scroll(2), 0);
        // lines deleted lower down: forgets the kept rows
        ui.apply(vec![scroll(2, 1), E::Flush]);
        assert_eq!(ui.grids[&2].kept_rows(), (0, 0));
        // topline moved, grid redrawn whole: lines stand in, nothing kept
        ui.apply(vec![scroll(1, 1), E::Flush]);
        ui.apply(vec![viewport(9, 7), E::Flush]);
        assert_eq!(ui.text_scroll(2), 7);
        assert_eq!(ui.grids[&2].kept_rows(), (0, 0));
    }

    #[test]
    fn grid_line_repeat_and_wide_chars() {
        let mut ui = screen();
        ui.apply(vec![RedrawEvent::GridLine {
            grid: 1,
            row: 0,
            col_start: 2,
            cells: vec![
                LineCell {
                    text: "x".into(),
                    hl: 3,
                    repeat: 3,
                },
                LineCell {
                    text: "界".into(),
                    hl: 4,
                    repeat: 1,
                },
                LineCell {
                    text: "".into(),
                    hl: 4,
                    repeat: 1,
                },
                LineCell {
                    text: "y".into(),
                    hl: 0,
                    repeat: 1,
                },
            ],
        }]);
        let g = &ui.grids[&1];
        assert_eq!(g.row_text(0), "  xxx界y            ");
        assert_eq!(g.cell(0, 4).unwrap().hl, 3);
        assert_eq!(g.cell(0, 5).unwrap().text, CellText::Char('界'));
        assert!(g.cell(0, 6).unwrap().text.is_empty());
    }

    fn scroll(
        grid: GridId,
        top: usize,
        bot: usize,
        left: usize,
        right: usize,
        rows: i64,
    ) -> RedrawEvent {
        RedrawEvent::GridScroll {
            grid,
            top,
            bot,
            left,
            right,
            rows,
        }
    }

    struct Move {
        name: &'static str,
        events: fn() -> Vec<RedrawEvent>,
        grid: GridId,
        rows: &'static [&'static str],
    }

    /// Grid 2 is 3 x 4 of `aaa` to `ddd`; grid 1 is 4 x 2 of `abcd` / `efgh`.
    const MOVES: &[Move] = &[
        Move {
            name: "grid_scroll up moves the region up, its last row stays",
            events: || vec![scroll(2, 0, 4, 0, 3, 1)],
            grid: 2,
            rows: &["bbb", "ccc", "ddd", "ddd"],
        },
        Move {
            name: "grid_scroll down moves only the region's columns",
            events: || vec![scroll(2, 0, 4, 0, 3, 1), scroll(2, 1, 4, 1, 3, -2)],
            grid: 2,
            rows: &["bbb", "ccc", "ddd", "dcc"],
        },
        Move {
            name: "grid_resize keeps the content that still fits",
            events: || vec![resize(1, 2, 3)],
            grid: 1,
            rows: &["ab", "ef", "  "],
        },
    ];

    #[test]
    fn grid_scroll_and_resize_move_the_cells() {
        for m in MOVES {
            let mut ui = UiState::new();
            let mut evs = vec![resize(2, 3, 4), resize(1, 4, 2)];
            for (r, t) in ["aaa", "bbb", "ccc", "ddd"].iter().enumerate() {
                evs.push(line(2, r, 0, t, 0));
            }
            evs.extend([line(1, 0, 0, "abcd", 0), line(1, 1, 0, "efgh", 0)]);
            ui.apply(evs);
            ui.apply((m.events)());
            let grid = &ui.grids[&m.grid];
            let rows: Vec<_> = (0..m.rows.len()).map(|r| grid.row_text(r)).collect();
            assert_eq!(rows, m.rows, "{}", m.name);
        }
    }

    #[test]
    fn composes_splits_floats_and_message_grid() {
        let mut ui = screen();
        ui.apply(vec![
            resize(2, 10, 5),
            line(2, 0, 0, "left", 0),
            RedrawEvent::WinPos {
                grid: 2,
                win: 1000,
                start_row: 0,
                start_col: 0,
                width: 10,
                height: 5,
            },
            resize(3, 9, 5),
            line(3, 0, 0, "right", 0),
            RedrawEvent::WinPos {
                grid: 3,
                win: 1001,
                start_row: 0,
                start_col: 11,
                width: 9,
                height: 5,
            },
            // float anchored SE at (3, 8) of grid 3 -> nvim's screen pos (2, 15)
            resize(4, 4, 1),
            line(4, 0, 0, "FLT!", 0),
            RedrawEvent::WinFloatPos {
                grid: 4,
                win: 1002,
                anchor: Anchor::SE,
                anchor_grid: 3,
                anchor_row: 3.0,
                anchor_col: 8.0,
                mouse_enabled: true,
                zindex: 50,
                compindex: 1,
                screen_pos: Some((2.0, 15.0)),
            },
            resize(5, 20, 1),
            line(5, 0, 0, ":messages", 0),
            RedrawEvent::MsgSetPos {
                grid: 5,
                row: 5,
                scrolled: false,
                sep_char: "".into(),
                zindex: 200,
                compindex: 2,
            },
            RedrawEvent::Flush,
        ]);
        let s = ui.screen_lines();
        assert_eq!(s[0], "left       right    ");
        assert_eq!(&s[2][15..19], "FLT!");
        assert_eq!(s[5].trim_end(), ":messages");
        assert_eq!(
            ui.layers().iter().map(|l| l.grid).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        // hit-test: float first, then the split under it, then the base grid
        assert_eq!(ui.hit_test(2, 16), Some((4, 0, 1)));
        assert_eq!(ui.hit_test(2, 12), Some((3, 2, 1)));
        assert_eq!(ui.hit_test(0, 10), Some((1, 0, 10)));
    }

    #[test]
    fn float_without_screen_pos_is_placed_from_its_anchor() {
        let mut ui = screen();
        ui.apply(vec![
            resize(2, 10, 5),
            RedrawEvent::WinPos {
                grid: 2,
                win: 1000,
                start_row: 1,
                start_col: 5,
                width: 10,
                height: 5,
            },
            resize(4, 4, 2),
            RedrawEvent::WinFloatPos {
                grid: 4,
                win: 1002,
                anchor: Anchor::SW,
                anchor_grid: 2,
                anchor_row: 4.0,
                anchor_col: 2.0,
                mouse_enabled: true,
                zindex: 50,
                compindex: 1,
                screen_pos: None,
            },
        ]);
        assert_eq!(ui.grid_origin(4), Some((1 + 4 - 2, 5 + 2)));
    }

    #[test]
    fn floats_stack_by_compindex_and_hidden_closed_grids_drop_out() {
        let mut ui = screen();
        let float = |grid, compindex| RedrawEvent::WinFloatPos {
            grid,
            win: grid as i64,
            anchor: Anchor::NW,
            anchor_grid: 1,
            anchor_row: 0.0,
            anchor_col: 0.0,
            mouse_enabled: true,
            zindex: 50,
            compindex,
            screen_pos: Some((0.0, 0.0)),
        };
        ui.apply(vec![
            resize(2, 3, 1),
            line(2, 0, 0, "aaa", 0),
            resize(3, 2, 1),
            line(3, 0, 0, "bb", 0),
            float(3, 2),
            float(2, 1),
        ]);
        assert_eq!(&ui.screen_lines()[0][..3], "bba");
        assert_eq!(ui.hit_test(0, 0), Some((3, 0, 0)));
        ui.apply(vec![RedrawEvent::WinHide { grid: 3 }]);
        assert_eq!(&ui.screen_lines()[0][..3], "aaa");
        ui.apply(vec![RedrawEvent::WinClose { grid: 2 }]);
        assert_eq!(&ui.screen_lines()[0][..3], "   ");
        ui.apply(vec![float(3, 3)]);
        assert_eq!(&ui.screen_lines()[0][..3], "bb ");
    }

    #[test]
    fn caret_follows_cursor_grid_and_mode_shape() {
        let mut ui = screen();
        ui.apply(vec![
            RedrawEvent::ModeInfoSet {
                cursor_style_enabled: true,
                modes: vec![
                    ModeInfo {
                        cursor_shape: Some(CursorShape::Block),
                        attr_id: Some(0),
                        ..Default::default()
                    },
                    ModeInfo {
                        cursor_shape: Some(CursorShape::Vertical),
                        cell_percentage: Some(25),
                        attr_id: Some(7),
                        ..Default::default()
                    },
                ],
            },
            resize(2, 10, 5),
            RedrawEvent::WinPos {
                grid: 2,
                win: 1000,
                start_row: 1,
                start_col: 3,
                width: 10,
                height: 5,
            },
            RedrawEvent::GridCursorGoto {
                grid: 2,
                row: 2,
                col: 4,
            },
            RedrawEvent::ModeChange {
                mode: "insert".into(),
                mode_idx: 1,
            },
        ]);
        let c = ui.caret().unwrap();
        assert_eq!(
            (c.row, c.col, c.shape, c.percentage, c.attr_id),
            (3, 7, CursorShape::Vertical, 25, 7)
        );
        ui.apply(vec![RedrawEvent::WinHide { grid: 2 }]);
        assert_eq!(ui.caret(), None);
    }

    #[test]
    fn reverse_swaps_resolved_colors() {
        let mut ui = screen();
        ui.apply(vec![
            RedrawEvent::DefaultColorsSet {
                fg: Some(0x111111),
                bg: Some(0x222222),
                sp: None,
            },
            RedrawEvent::HlAttrDefine {
                id: 1,
                attrs: HlAttr {
                    fg: Some(0xaa0000),
                    reverse: true,
                    ..Default::default()
                },
            },
        ]);
        assert_eq!(ui.colors(1), (0x222222, 0xaa0000, 0xaa0000));
        assert_eq!(ui.colors(0), (0x111111, 0x222222, 0x111111));
    }

    #[test]
    fn caret_color_is_fixed_not_the_cells() {
        use RedrawEvent as E;
        let hl = |id, attrs| E::HlAttrDefine { id, attrs };
        let mut ui = screen();
        ui.apply(vec![
            E::DefaultColorsSet {
                fg: Some(0xdddddd),
                bg: Some(0x111111),
                sp: None,
            },
            // a colored token, a Cursor-like group, a group with only fg
            hl(
                1,
                HlAttr {
                    fg: Some(0xcc7832),
                    ..Default::default()
                },
            ),
            hl(
                2,
                HlAttr {
                    fg: Some(0x101010),
                    bg: Some(0xabcdef),
                    ..Default::default()
                },
            ),
            hl(
                3,
                HlAttr {
                    fg: Some(0x123456),
                    ..Default::default()
                },
            ),
        ]);
        // no group (nvim's default 'guicursor'), no Cursor group: WebStorm's caret
        assert_eq!(ui.caret_colors(0), (CARET_COLOR, 0x111111));
        // a group without bg: still the fixed color
        assert_eq!(ui.caret_colors(3), (CARET_COLOR, 0x111111));
        // the mode's group with a bg
        assert_eq!(ui.caret_colors(2), (0xabcdef, 0x101010));
        // attr_id 0 falls back to the Cursor group
        ui.apply(vec![E::HlGroupSet {
            name: "Cursor".into(),
            id: 2,
        }]);
        assert_eq!(ui.caret_colors(0), (0xabcdef, 0x101010));
    }
}
