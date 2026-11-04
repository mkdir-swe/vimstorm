//! Pixel layout of the window (pure, no GPUI entities): the fixed chrome regions ([`Frame`]), the
//! islands of nvim's windows ([`layout`]) and the per-frame [`Geometry`] snapshot surfaces read.
//!
//! nvim's cell layout is logical. Its screen (`nvim_ui_try_resize`) is the islands' area in cells
//! (tree width included, see [`Frame::screen_size`]). Each axis of a region maps logical cell edges to pixels proportionally
//! ([`Axis`]); a separator cell (vertical separator, horizontal separator / status line) becomes a
//! [`GAP`]: the window before it ends `GAP` px before the next one starts. Editor-region windows map
//! x onto the editor area, the bottom tool window (tool windows below everything else) onto the
//! full width under the tree. Each window's grid is then sized to its island in whole cells
//! (`nvim_ui_try_resize_grid`), so grids and logical sizes differ; nothing here feeds back into the
//! logical layout.

use gpui_kit::{Bounds, CursorStyle, Pixels, Point, Size, point, px, size};

use crate::look;
use crate::nvim::Anchor;
use crate::nvim::GridId;
use crate::render::CellMetrics;

// Chrome metrics and colors: WebStorm's, from `crate::look` (sources there).
/// Window frame: toolbar, status bar and the gaps between islands.
pub const FRAME_BG: crate::look::Tok = look::FRAME_BG;
/// Tool window islands: the tree panel.
pub const TOOL_BG: crate::look::Tok = look::PANEL_BG;
/// Main toolbar (traffic lights inside it).
pub const TOOLBAR_HEIGHT: crate::look::Met = look::TOOLBAR_HEIGHT;
pub const STATUS_HEIGHT: crate::look::Met = look::STATUS_BAR_HEIGHT;
/// Between two islands.
pub const GAP: crate::look::Met = look::ISLAND_GAP;
/// Between the islands and the window's left / right / bottom edge.
pub const MARGIN: f32 = look::ISLAND_EDGE_GAP;
pub const ISLAND_RADIUS: crate::look::Met = look::ISLAND_ARC;
/// Island outline (inside the island; grids start inside it).
pub const ISLAND_BORDER: f32 = look::ISLAND_BORDER_WIDTH;
/// Editor tab bar above each editor split's grid.
pub const TAB_BAR_HEIGHT: f32 = look::TAB_HEIGHT;
/// Project tree panel width at start.
pub const TREE_WIDTH: f32 = 300.0;
pub const TREE_MIN_WIDTH: f32 = 120.0;
/// The editor area never gets narrower than this by dragging the tree (or the Chat column).
pub const EDITOR_MIN_WIDTH: f32 = 200.0;
/// The Editor's right Chat column (2.1 board W-Editor): 420 px, from 320 by dragging its gap, as
/// wide as [`LEFT_MIN_WIDTH`] leaves it (the 2000 px cap only bounds a saved width).
pub const CHAT_WIDTH: f32 = look::CHAT_COLUMN_WIDTH;
pub const CHAT_MIN_WIDTH: f32 = 320.0;
pub const CHAT_MAX_WIDTH: f32 = 2000.0;
/// What the Chat column always leaves left of it while the window has the room: the
/// Project tree's minimum and the editor's (and the [`GAP`] between them). The same in the Factory
/// view, where the Board takes it (at least one whole column), so the column keeps its width across
/// the views.
pub const LEFT_MIN_WIDTH: f32 = TREE_MIN_WIDTH + EDITOR_MIN_WIDTH;
/// A draggable gap's hit zone reaches this far into the islands on each side.
pub const GRAB: f32 = 3.0;
/// Rows of nvim's screen below the windows: the global status line (`laststatus=3`) and the
/// command line (`cmdheight=1`). Neither is drawn in place (status bar: native; message grid: at
/// the bottom when it shows something).
pub const EXTRA_ROWS: usize = 2;

/// What an nvim window is, as `config/app/layout.lua` reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WinKind {
    /// Not reported (yet): an editor-region island without a tab bar.
    #[default]
    Other,
    /// An editor split: tab bar on top.
    Split,
    /// A window of the open diff / merge viewer.
    Viewer,
    /// A window of the bottom tool window (Git, the bottom pane).
    Tool,
}

/// A native surface drawn over an nvim window instead of its grid (`config/app/layout.lua` `role`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The Git tool window's host window: [`crate::git::window::GitView`] over its island.
    Git,
    /// 1.0's terminal host window (Lua's `role = "terminal"`): no module reports it since 2.1
    /// (the terminal is drawn in the Chat column, [`Frame::chat`]); kept so an old
    /// payload still parses.
    Terminal,
    /// The bottom pane's host window (one): [`crate::shell::pane::PaneHost`] over its
    /// island (Sessions, Boxes, Pipelines).
    Pane,
    /// A markdown preview (many): the preview placeholder window, or in Preview Only the file's
    /// own split window. [`crate::editor::markdown::MarkdownView`] (a full-window layer) paints each one
    /// over [`WinRect::surface_rect`]; a split keeps its native tab bar and island.
    Markdown,
}

impl Role {
    /// Lua's name (`config/app/layout.lua` `role`).
    pub fn parse(name: &str) -> Option<Role> {
        match name {
            "git" => Some(Role::Git),
            "terminal" => Some(Role::Terminal),
            "pane" => Some(Role::Pane),
            "markdown" => Some(Role::Markdown),
            _ => None,
        }
    }
}

/// A sync group's id (`git/scrollsync.lua`): windows presented together (diff / merge panes).
pub use crate::nvim::SyncGroup;

/// A diff / merge pane's place in its viewer (`config/app/diff.lua` `layout_info`, sent with the
/// layout): the viewer's panes are laid out as ONE island with the native chrome of
/// [`crate::git::diff`] around and between their grids ([`ViewerRect`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub struct ViewerPane {
    /// 1-based, left to right.
    pub pane: usize,
    pub panes: usize,
    #[serde(default)]
    pub merge: bool,
    /// Cells of the pane's native gutter (line numbers + icon column).
    pub gutter: usize,
}

/// Where a viewer pane's chrome goes (window coordinates). WebStorm's side-by-side layout: the
/// first pane is mirrored (scrollbar marks at its left edge, gutter at its right next to the
/// divider), the others have the gutter on the left and the marks on the right; a divider with
/// the change connectors between panes; one toolbar row over all panes, a header per pane, the
/// merge window's button row under them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewerRect {
    pub pane: ViewerPane,
    /// All the viewer's panes (the island they share).
    pub group: Bounds<Pixels>,
    pub toolbar: Bounds<Pixels>,
    /// This pane's title row (its full width).
    pub header: Bounds<Pixels>,
    /// Line numbers + icons: x extent (rows are the grid's). First pane: right of its grid;
    /// others: over the grid's first `gutter` cells (blank statuscolumn cells).
    pub gutter: Bounds<Pixels>,
    /// Scrollbar change marks. First pane: over its grid's first two cells; others: right of it.
    pub marks: Bounds<Pixels>,
    /// The divider to the right (not after the last pane).
    pub divider: Option<Bounds<Pixels>>,
    /// Merge: the button row under all panes.
    pub buttons: Option<Bounds<Pixels>>,
}

/// Rust-owned panel state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Panels {
    pub tree_open: bool,
    pub tree_width: f32,
    /// The Chat column's width while it is docked and shown (None: no column; its room is
    /// nvim's). It takes its width off the islands' area, full height, right of everything else.
    pub chat: Option<f32>,
    /// Feel vscode's Activity bar: a [`ACTIVITY_BAR_WIDTH`] icon column at the window's
    /// left, the islands right of it.
    pub activity: bool,
    /// The rail: [`super::projects::RAIL_WIDTH`] at the window's left edge from the toolbar
    /// down, the islands right of it (a projects window's workspace).
    pub rail: bool,
}

/// Feel vscode's Activity bar's width (VS Code's `activitybar` 48 px).
pub const ACTIVITY_BAR_WIDTH: f32 = look::ACTIVITY_BAR_WIDTH;

impl Default for Panels {
    fn default() -> Self {
        Panels {
            tree_open: true,
            tree_width: TREE_WIDTH,
            chat: None,
            activity: false,
            rail: false,
        }
    }
}

/// The island ⌥⌘⏎ gives the whole body: an editor split or a bottom pane's host window
/// (nvim window handles), the Project tree, the Chat column. The rest keep running, not drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Island {
    /// An editor split (keeps its own tab bar).
    Split(i64),
    /// The bottom pane's host window (Sessions · Boxes · Pipelines, or Git's).
    Bottom(i64),
    Tree,
    Chat,
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Bounds<Pixels> {
    Bounds::new(
        point(px(x0), px(y0)),
        size(px((x1 - x0).max(0.)), px((y1 - y0).max(0.))),
    )
}

fn x0(b: &Bounds<Pixels>) -> f32 {
    b.origin.x.as_f32()
}
fn y0(b: &Bounds<Pixels>) -> f32 {
    b.origin.y.as_f32()
}
fn x1(b: &Bounds<Pixels>) -> f32 {
    b.right().as_f32()
}
fn y1(b: &Bounds<Pixels>) -> f32 {
    b.bottom().as_f32()
}

/// The window's fixed regions (window coordinates).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub viewport: Size<Pixels>,
    pub toolbar: Bounds<Pixels>,
    pub status: Bounds<Pixels>,
    /// Between toolbar and status bar.
    pub body: Bounds<Pixels>,
    /// Where islands go: the body minus the margins.
    pub inner: Bounds<Pixels>,
    /// Tree panel column (left, right) when open.
    pub tree_x: Option<(f32, f32)>,
    /// Editor area column (left, right).
    pub editor_x: (f32, f32),
    /// The Chat column's island (right of `inner`, the body's full height) when shown.
    pub chat: Option<Bounds<Pixels>>,
    /// Feel vscode's Activity bar (the body's height at the window's left) when shown.
    pub activity: Option<Bounds<Pixels>>,
    /// The rail: the window's left edge from the toolbar to the status bar, when shown (the
    /// workspace header's row starts right of it).
    pub rail: Option<Bounds<Pixels>>,
}

impl Frame {
    pub fn new(viewport: Size<Pixels>, panels: Panels) -> Frame {
        Self::with_workspace_strip(viewport, panels, false)
    }

    /// Reserve workspace navigation below the native toolbar while keeping every surface in
    /// window coordinates. Bare workspaces retain their original layout.
    pub fn with_workspace_strip(viewport: Size<Pixels>, panels: Panels, shown: bool) -> Frame {
        let (w, h) = (viewport.width.as_f32(), viewport.height.as_f32());
        let toolbar_bottom = TOOLBAR_HEIGHT.get().min(h);
        let top = (toolbar_bottom + if shown { look::TAB_HEIGHT } else { 0. }).min(h);
        let bottom = (h - STATUS_HEIGHT).max(top);
        let body = rect(0., top, w, bottom);
        // the rail: its column at the left edge, beside the header's row too
        let rail = panels.rail.then(|| {
            rect(
                0.,
                toolbar_bottom,
                super::projects::RAIL_WIDTH.min(w),
                bottom,
            )
        });
        let edge = rail.map_or(0., |s| x1(&s));
        // Feel vscode's Activity bar: its column off the left, the islands right against it
        let activity = panels
            .activity
            .then(|| rect(edge, top, (edge + ACTIVITY_BAR_WIDTH).min(w), bottom));
        let left = activity
            .map(|a| x1(&a))
            .or(rail.map(|s| x1(&s)))
            .unwrap_or(MARGIN);
        let mut inner = rect(
            left,
            top,
            (w - MARGIN).max(left),
            (bottom - MARGIN).max(top),
        );
        // the Chat column: its width off the right of the islands' area (nvim's screen)
        let chat = panels.chat.map(|want| {
            let cw = Self::chat_width_for(want, inner.size.width.as_f32());
            let right = x1(&inner);
            let column = rect(right - cw, y0(&inner), right, y1(&inner));
            inner = rect(
                x0(&inner),
                y0(&inner),
                (right - cw - GAP).max(x0(&inner)),
                y1(&inner),
            );
            column
        });
        let (l, r) = (x0(&inner), x1(&inner));
        let (tree_x, editor_x) = if panels.tree_open {
            let tw = Self::tree_width_for(panels.tree_width, r - l);
            (Some((l, l + tw)), (l + tw + GAP, r))
        } else {
            (None, (l, r))
        };
        Frame {
            viewport,
            toolbar: rect(0., 0., w, toolbar_bottom),
            status: rect(0., bottom, w, h),
            body,
            inner,
            tree_x,
            editor_x: (editor_x.0.min(r), editor_x.1),
            chat,
            activity,
            rail,
        }
    }

    /// Where a maximized island goes: the body, no tree and no Chat column (the islands' area
    /// then); the toolbar and the status bar stay, and in a projects window (`rail`) the rail
    /// and the workspace header's row too.
    pub fn maximized(viewport: Size<Pixels>, rail: bool) -> Bounds<Pixels> {
        let panels = Panels {
            tree_open: false,
            chat: None,
            rail,
            ..Panels::default()
        };
        Self::with_workspace_strip(viewport, panels, rail).inner
    }

    /// The Chat column's width actually used for the full islands' width `full` (the column
    /// included): [`CHAT_MIN_WIDTH`]..[`CHAT_MAX_WIDTH`], leaving [`LEFT_MIN_WIDTH`] (the tree's
    /// and the editor's minimum, or the Board's) while it can: a narrow window narrows the column,
    /// its dragged width comes back when the window grows; narrower still, the column keeps
    /// its minimum and the editor shrinks.
    pub fn chat_width_for(want: f32, full: f32) -> f32 {
        want.clamp(CHAT_MIN_WIDTH, CHAT_MAX_WIDTH)
            .min((full - GAP - GAP - LEFT_MIN_WIDTH).max(CHAT_MIN_WIDTH))
            .min(full.max(0.))
    }

    /// The tree width actually used for an `inner` width: at least [`TREE_MIN_WIDTH`], leaving
    /// the editor [`EDITOR_MIN_WIDTH`].
    pub fn tree_width_for(want: f32, inner: f32) -> f32 {
        want.min(inner - GAP - EDITOR_MIN_WIDTH)
            .max(TREE_MIN_WIDTH)
            .min(inner.max(0.))
    }

    /// nvim's screen in cells: the islands' width (tree included) and rows + [`EXTRA_ROWS`].
    /// The full width, not the editor area's: the bottom tool window's logical width then is its
    /// drawn width (Lua pads its rows to `nvim_win_get_width`), and the tree's width never
    /// resizes nvim's screen; editor splits get narrower grids than their logical width instead.
    pub fn screen_size(&self, m: &CellMetrics) -> (usize, usize) {
        let cols = (self.inner.size.width / m.cell_width).floor().max(1.) as usize;
        let rows = (self.inner.size.height / m.row_height).floor().max(1.) as usize;
        (cols, rows + EXTRA_ROWS)
    }
}

/// Maps logical cell edges of one axis of a region to pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Axis {
    pub p0: f32,
    pub scale: f32,
}

impl Axis {
    /// `n` cells spread over `p0..p1`.
    fn spread(n: usize, p0: f32, p1: f32) -> Axis {
        Axis {
            p0,
            scale: (p1 - p0) / n.max(1) as f32,
        }
    }

    /// Pixel position of logical edge `e` (fractional for float anchors).
    pub fn at(&self, e: f64) -> f32 {
        self.p0 + e as f32 * self.scale
    }

    /// Pixel position of logical edge `e`, on a whole pixel (crisp island edges).
    pub fn edge(&self, e: usize) -> f32 {
        self.at(e as f64).round()
    }

    /// Logical cell under pixel `p`.
    pub fn cell(&self, p: f32) -> i64 {
        ((p - self.p0) / self.scale.max(0.001)).floor() as i64
    }

    /// Pixel extent of cells `a..b`: up to the next window's start minus [`GAP`] when a separator
    /// follows (`b < n`), else to the region's end.
    fn extent(&self, a: usize, b: usize, n: usize) -> (f32, f32) {
        let start = self.edge(a);
        let end = if b < n {
            self.edge(b + 1) - GAP
        } else {
            self.edge(b)
        };
        (start, end.max(start))
    }
}

/// One nvim window as nvim lays it out (cells of grid 1, from `win_pos`) plus what Lua says it is.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NvimWin {
    pub grid: GridId,
    pub win: i64,
    pub row: usize,
    pub col: usize,
    pub width: usize,
    pub height: usize,
    /// Rows above the text area (winbar): part of the grid, not of the size request.
    pub winbar: usize,
    pub kind: WinKind,
    /// The empty editor (no file open): its hints are drawn by the tabs surface.
    pub empty: bool,
    /// A native surface is drawn over it; its grid isn't.
    pub role: Option<Role>,
    /// A diff / merge pane.
    pub viewer: Option<ViewerPane>,
    /// A code split showing VS Code's minimap at its right (`editor.minimap`): the grid
    /// gets the island minus [`minimap_width`].
    pub minimap: bool,
    /// Feel vscode's breadcrumbs: their strip under the tab bar ([`CRUMBS_HEIGHT`]).
    pub crumbs: bool,
}

/// VS Code's minimap: what it takes off the right of a split's `area` px wide text area
/// with `cell` px wide characters, or None where the code would keep fewer than
/// [`MINIMAP_MIN_COLS`]. VS Code's `_computeMinimapLayout` (scale 1, `renderCharacters`, a 2x
/// screen: a minimap character 1 px wide): `floor((width - 2) / (cell + 1)) + 8` (its 8 px
/// `MINIMAP_GUTTER_WIDTH`), at most `editor.minimap.maxColumn` 120 characters.
pub fn minimap_width(area: f32, cell: f32) -> Option<f32> {
    if cell <= 0. {
        return None;
    }
    let w = (((area - 2.) / (cell + 1.)).floor().max(0.) + MINIMAP_GUTTER).min(MINIMAP_MAX_COLS);
    (area - w >= MINIMAP_MIN_COLS * cell).then_some(w)
}

/// VS Code's `editor.minimap.maxColumn` default (one px a character).
pub const MINIMAP_MAX_COLS: f32 = 120.;
/// VS Code's `MINIMAP_GUTTER_WIDTH`.
const MINIMAP_GUTTER: f32 = 8.;
/// A split narrower than this many code columns beside the minimap shows none.
pub const MINIMAP_MIN_COLS: f32 = 20.;

/// The breadcrumbs strip's height under an editor split's tab bar (Feel vscode: VS Code's
/// `breadcrumbs` bar, 22 px).
pub const CRUMBS_HEIGHT: f32 = look::CRUMBS_HEIGHT;

/// A window's island.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WinRect {
    pub grid: GridId,
    pub win: i64,
    pub kind: WinKind,
    pub empty: bool,
    /// A native surface is drawn over the island (its grid isn't drawn, gets no mouse).
    pub role: Option<Role>,
    /// In the bottom tool window (full width under the tree).
    pub bottom: bool,
    /// The rounded panel.
    pub island: Bounds<Pixels>,
    /// Editor splits: the native tab bar's slot at the island's top.
    pub tab_bar: Option<Bounds<Pixels>>,
    /// The breadcrumbs strip right under the tab bar ([`NvimWin::crumbs`]).
    pub crumbs: Option<Bounds<Pixels>>,
    /// Where the grid's cell (0, 0) starts; the grid is clipped to this.
    pub grid_area: Bounds<Pixels>,
    /// Grid size that fits `grid_area` (cols, rows; rows include the winbar).
    pub cells: (usize, usize),
    /// `nvim_ui_try_resize_grid(grid, width, height)`: the text area (without the winbar).
    pub request: (usize, usize),
    /// Logical rect (row, col, width, height).
    pub logical: (usize, usize, usize, usize),
    /// A diff / merge pane's chrome (its `island` is then the whole viewer).
    pub viewer: Option<ViewerRect>,
    /// VS Code's minimap right of `grid_area` ([`NvimWin::minimap`]; [`crate::editor::minimap`]
    /// draws it): the text area's height, [`minimap_width`] wide.
    pub minimap: Option<Bounds<Pixels>>,
    /// The split asked for a minimap (it may not have the room): a maximized one gets it.
    pub wants_minimap: bool,
}

/// Splits a text area into the grid's and the minimap's when `wanted` and there's room.
fn with_minimap(
    area: Bounds<Pixels>,
    cell: f32,
    wanted: bool,
) -> (Bounds<Pixels>, Option<Bounds<Pixels>>) {
    let Some(w) = wanted
        .then(|| minimap_width(area.size.width.as_f32(), cell))
        .flatten()
    else {
        return (area, None);
    };
    let split = (x1(&area) - w).round();
    (
        rect(x0(&area), y0(&area), split, y1(&area)),
        Some(rect(split, y0(&area), x1(&area), y1(&area))),
    )
}

impl WinRect {
    /// The editor paints the island (panel, corners, outline) under the grid: windows without a
    /// role, and role windows with a tab bar (a markdown split keeps its native look; its surface
    /// paints only [`Self::surface_rect`]). Other role windows get their island from the surface
    /// mounting them (Git, the bottom pane).
    pub fn draws_island(&self) -> bool {
        self.role.is_none() || self.tab_bar.is_some()
    }

    /// Where a role's surface paints: the island below the tab bar slot (the whole island when
    /// there's none).
    pub fn surface_rect(&self) -> Bounds<Pixels> {
        match self.tab_bar {
            Some(tb) => rect(
                x0(&self.island),
                y1(&tb),
                x1(&self.island),
                y1(&self.island),
            ),
            None => self.island,
        }
    }
}

/// A draggable border.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GapKind {
    /// Tree panel | editor area: Rust's tree width.
    Tree,
    /// The islands | the Chat column: the column's width (the workspace's).
    Chat,
    /// Between windows side by side: nvim's vertical separator at this cell of grid 1.
    Vertical {
        row: usize,
        col: usize,
        bottom: bool,
    },
    /// Between windows stacked: nvim's horizontal separator at this cell of grid 1.
    Horizontal { row: usize, col: usize },
    /// A diff / merge viewer's divider band ([`ViewerRect::divider`]): nvim's vertical separator
    /// between its panes at this cell of grid 1, as [`GapKind::Vertical`], but the viewer's
    /// chrome takes a press first (its » arrows, a double click) and lets the rest through.
    Divider { row: usize, col: usize },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gap {
    /// Hit zone (the gap plus [`GRAB`] on each side).
    pub bounds: Bounds<Pixels>,
    pub kind: GapKind,
}

impl Gap {
    pub fn cursor(&self) -> CursorStyle {
        match self.kind {
            GapKind::Horizontal { .. } => CursorStyle::ResizeRow,
            _ => CursorStyle::ResizeColumn,
        }
    }
}

/// The islands of nvim's windows and the regions around them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layout {
    pub frame: Frame,
    /// Grid 1's size the logical rects refer to.
    pub screen: (usize, usize),
    pub wins: Vec<WinRect>,
    /// Tree panel island.
    pub tree: Option<Bounds<Pixels>>,
    /// Editor region (where its islands go).
    pub editor: Bounds<Pixels>,
    /// Bottom tool window region.
    pub bottom: Option<Bounds<Pixels>>,
    pub gaps: Vec<Gap>,
    pub x_editor: Axis,
    pub x_bottom: Axis,
    pub y: Axis,
    /// First logical row of the bottom tool window.
    pub bottom_row: Option<usize>,
    /// The maximized island and its rect ([`Layout::maximize`]).
    pub maximized: Option<(Island, Bounds<Pixels>)>,
}

/// Lays out nvim's split windows (`wins`, logical) in `frame`; `screen` = grid 1's size.
pub fn layout(frame: &Frame, m: &CellMetrics, screen: (usize, usize), wins: &[NvimWin]) -> Layout {
    let inner = frame.inner;
    let cols = wins
        .iter()
        .map(|w| w.col + w.width)
        .max()
        .unwrap_or(0)
        .max(screen.0)
        .max(1);
    let rows = wins
        .iter()
        .map(|w| w.row + w.height)
        .max()
        .unwrap_or(1)
        .max(1);
    // the bottom tool window: tool windows below everything else
    let bottom_row = wins
        .iter()
        .filter(|w| w.kind == WinKind::Tool)
        .map(|w| w.row)
        .min()
        .filter(|&top| {
            top > 0
                && wins
                    .iter()
                    .all(|w| w.kind == WinKind::Tool || w.row + w.height < top)
        });
    let y = Axis::spread(rows, y0(&inner), y1(&inner));
    let x_editor = Axis::spread(cols, frame.editor_x.0, frame.editor_x.1);
    let x_bottom = Axis::spread(cols, x0(&inner), x1(&inner));
    // bottom of the editor region / tree: one gap above the bottom tool window
    let upper_end = bottom_row.map_or(y1(&inner), |r| y.edge(r) - GAP);

    let mut out = Layout {
        frame: *frame,
        screen,
        tree: frame.tree_x.map(|(l, r)| rect(l, y0(&inner), r, upper_end)),
        editor: rect(frame.editor_x.0, y0(&inner), frame.editor_x.1, upper_end),
        bottom: bottom_row.map(|r| rect(x0(&inner), y.edge(r), x1(&inner), y1(&inner))),
        x_editor,
        x_bottom,
        y,
        bottom_row,
        ..Default::default()
    };

    let (cw, rh) = (m.cell_width.as_f32(), m.row_height.as_f32());
    for w in wins {
        let bottom = bottom_row.is_some_and(|r| w.row >= r);
        let x = if bottom { x_bottom } else { x_editor };
        let (l, r) = x.extent(w.col, w.col + w.width, cols);
        let (t, b) = y.extent(w.row, w.row + w.height, rows);
        let island = rect(l, t, r, b);
        let tab_bar = (!bottom && w.kind == WinKind::Split)
            .then(|| rect(l, t, r, (t + TAB_BAR_HEIGHT).min(b)));
        // inside the island's outline
        let o = ISLAND_BORDER;
        let (crumbs, grid_top) = match tab_bar {
            Some(tb) => under_bar(&tb, (l + o, r - o, b), w.crumbs),
            None => (None, t + o),
        };
        let wants_minimap = w.minimap && tab_bar.is_some() && w.role.is_none() && !w.empty;
        let (grid_area, minimap) =
            with_minimap(rect(l + o, grid_top, r - o, b - o), cw, wants_minimap);
        let gc = (grid_area.size.width.as_f32() / cw).floor().max(1.) as usize;
        let gr = (grid_area.size.height.as_f32() / rh).floor().max(1.) as usize;
        out.wins.push(WinRect {
            grid: w.grid,
            win: w.win,
            kind: w.kind,
            empty: w.empty,
            role: w.role,
            bottom,
            island,
            tab_bar,
            crumbs,
            grid_area,
            cells: (gc, gr.max(w.winbar + 1)),
            request: (gc, gr.saturating_sub(w.winbar).max(1)),
            logical: (w.row, w.col, w.width, w.height),
            viewer: None,
            minimap,
            wants_minimap,
        });
        // separators after it become draggable gaps (between viewer panes: the divider band,
        // viewer_chrome's)
        let viewer_inside = w.viewer.is_some_and(|v| v.pane < v.panes);
        if w.col + w.width < cols && !viewer_inside {
            out.gaps.push(Gap {
                bounds: rect(r - GRAB, t, r + GAP + GRAB, b),
                // a row in the middle: the top one may be the winbar (no drag there)
                kind: GapKind::Vertical {
                    row: w.row + w.height / 2,
                    col: w.col + w.width,
                    bottom,
                },
            });
        }
        if w.row + w.height < rows && bottom_row != Some(w.row + w.height + 1) {
            out.gaps.push(Gap {
                bounds: rect(l, b - GRAB, r, b + GAP + GRAB),
                kind: GapKind::Horizontal {
                    row: w.row + w.height,
                    col: w.col + w.width / 2,
                },
            });
        }
    }
    viewer_chrome(&mut out, m, wins);
    markdown_pairs(&mut out);
    // the bottom tool window's top edge: full width (under the tree too), nvim's separator row
    // above it (the frame at column 0 there is the bottom of the editor stack)
    if let Some(r) = bottom_row {
        out.gaps.push(Gap {
            bounds: rect(
                x0(&inner),
                upper_end - GRAB,
                x1(&inner),
                upper_end + GAP + GRAB,
            ),
            kind: GapKind::Horizontal { row: r - 1, col: 0 },
        });
    }
    if let Some(tree) = out.tree {
        out.gaps.push(Gap {
            bounds: rect(
                x1(&tree) - GRAB,
                y0(&tree),
                x1(&tree) + GAP + GRAB,
                y1(&tree),
            ),
            kind: GapKind::Tree,
        });
    }
    if let Some(chat) = frame.chat {
        out.gaps.push(Gap {
            bounds: rect(
                x0(&chat) - GAP - GRAB,
                y0(&chat),
                x0(&chat) + GRAB,
                y1(&chat),
            ),
            kind: GapKind::Chat,
        });
    }
    out
}

impl Layout {
    /// Gives `area` to `island` alone: its rect becomes `area` (a split keeps its tab bar
    /// and gets the grid that fills the rest; a bottom host window's surface draws there); every
    /// other window, the tree and the Chat column are left out (not drawn, no mouse, their grids
    /// keep their sizes) and no gap drags. nvim's screen and logical layout stay. False (nothing
    /// changed) when the island isn't laid out.
    pub fn maximize(&mut self, island: Island, area: Bounds<Pixels>, m: &CellMetrics) -> bool {
        let keep = match island {
            Island::Split(win) => self
                .wins
                .iter()
                .position(|w| w.win == win && w.kind == WinKind::Split && !w.bottom),
            Island::Bottom(win) => self.wins.iter().position(|w| w.win == win && w.bottom),
            Island::Tree | Island::Chat => None,
        };
        let laid_out = match island {
            Island::Split(_) | Island::Bottom(_) => keep.is_some(),
            Island::Tree => self.tree.is_some(),
            Island::Chat => self.frame.chat.is_some(),
        };
        if !laid_out {
            return false;
        }
        let kept = keep.map(|i| self.wins.swap_remove(i));
        self.wins.clear();
        self.gaps.clear();
        self.tree = (island == Island::Tree).then_some(area);
        self.frame.chat = (island == Island::Chat).then_some(area);
        self.bottom = None;
        self.editor = rect(x0(&area), y0(&area), x0(&area), y0(&area));
        if let Some(mut w) = kept {
            let (l, t, r, b) = (x0(&area), y0(&area), x1(&area), y1(&area));
            w.island = area;
            if w.bottom {
                self.bottom = Some(area);
            } else {
                self.editor = area;
                let o = ISLAND_BORDER;
                let bar = rect(l, t, r, (t + TAB_BAR_HEIGHT).min(b));
                let (crumbs, grid_top) = under_bar(&bar, (l + o, r - o, b), w.crumbs.is_some());
                w.crumbs = crumbs;
                w.tab_bar = Some(bar);
                (w.grid_area, w.minimap) = with_minimap(
                    rect(l + o, grid_top, r - o, b - o),
                    m.cell_width.as_f32(),
                    w.wants_minimap,
                );
                let winbar = w.cells.1.saturating_sub(w.request.1);
                let gc = (w.grid_area.size.width / m.cell_width).floor().max(1.) as usize;
                let gr = (w.grid_area.size.height / m.row_height).floor().max(1.) as usize;
                w.cells = (gc, gr.max(winbar + 1));
                w.request = (gc, gr.saturating_sub(winbar).max(1));
            }
            self.wins.push(w);
        }
        self.maximized = Some((island, area));
        true
    }
}

/// What an editor split keeps under its tab bar `tb`: the breadcrumbs strip (Feel vscode),
/// inside the outline (`l`..`r`, never past `b`); and where the grid starts below it.
fn under_bar(
    tb: &Bounds<Pixels>,
    (l, r, b): (f32, f32, f32),
    crumbs: bool,
) -> (Option<Bounds<Pixels>>, f32) {
    let top = y1(tb);
    let crumbs = crumbs.then(|| rect(l, top, r, (top + CRUMBS_HEIGHT).min(b)));
    (crumbs, crumbs.map_or(top, |s| y1(&s)))
}

/// A markdown preview placeholder (role Markdown, not a split) right beside its editor split
/// joins the split's island, like WebStorm's editor with preview (one island, one tab row over
/// both, a 1 px divider): the split's island and tab bar span both; the preview's island becomes
/// the part right of the divider (the middle of nvim's separator gap), below the tab row.
fn markdown_pairs(out: &mut Layout) {
    let previews: Vec<usize> = (0..out.wins.len())
        .filter(|&i| out.wins[i].role == Some(Role::Markdown) && out.wins[i].kind == WinKind::Other)
        .collect();
    for pi in previews {
        let (row, col, _, height) = out.wins[pi].logical;
        let Some(si) = out.wins.iter().position(|w| {
            let (r, c, wd, h) = w.logical;
            w.kind == WinKind::Split && !w.bottom && r == row && h == height && c + wd + 1 == col
        }) else {
            continue;
        };
        let (Some(bar), split, prev) = (
            out.wins[si].tab_bar,
            out.wins[si].island,
            out.wins[pi].island,
        ) else {
            continue;
        };
        let group = split.union(&prev);
        let divider = x1(&split) + GAP / 2. - 0.5;
        out.wins[si].island = group;
        out.wins[si].tab_bar = Some(rect(x0(&group), y0(&bar), x1(&group), y1(&bar)));
        out.wins[pi].island = rect(divider + 1., y1(&bar), x1(&group), y1(&group));
    }
}

/// Joins a viewer's pane islands into one and places its chrome (see [`ViewerRect`]); the panes'
/// grids shrink to what's left.
fn viewer_chrome(out: &mut Layout, m: &CellMetrics, wins: &[NvimWin]) {
    let panes: Vec<(usize, ViewerPane)> = out
        .wins
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == WinKind::Viewer && !r.bottom)
        .filter_map(|(i, r)| Some((i, wins.iter().find(|w| w.grid == r.grid)?.viewer?)))
        .collect();
    let Some(first) = panes.first() else {
        return;
    };
    let mut group = out.wins[first.0].island;
    for (i, _) in &panes {
        group = group.union(&out.wins[*i].island);
    }
    let o = ISLAND_BORDER;
    let cw = m.cell_width.as_f32();
    let rh = m.row_height.as_f32();
    let merge = panes.iter().any(|(_, v)| v.merge);
    let top = y0(&group) + o;
    let header_top = top + look::DIFF_TOOLBAR_HEIGHT;
    let grid_top = header_top + look::DIFF_TITLE_HEIGHT;
    let bottom = y1(&group) - o - if merge { look::DIFF_BUTTONS_HEIGHT } else { 0. };
    let toolbar = rect(x0(&group) + o, top, x1(&group) - o, header_top);
    let buttons = merge.then(|| rect(x0(&group) + o, bottom, x1(&group) - o, y1(&group) - o));
    // half of the divider beyond nvim's separator gap, taken from each neighbour
    let h = ((look::DIFF_DIVIDER_WIDTH - GAP) / 2.).max(0.);
    for (i, v) in &panes {
        let r = &mut out.wins[*i];
        let (l, rr) = (x0(&r.island), x1(&r.island));
        let first = v.pane <= 1;
        let last = v.pane >= v.panes;
        let left = if first { l + o } else { l + h };
        let right = if last { rr - o } else { rr - h };
        let gutter_w = v.gutter as f32 * cw;
        let (grid_l, grid_r, gutter, marks) = if first {
            let gl = (right - gutter_w).max(left);
            (
                left,
                gl,
                rect(gl, grid_top, right, bottom),
                rect(left, grid_top, (left + 2. * cw).min(gl), bottom),
            )
        } else {
            let mr = (right - look::DIFF_MARKS_WIDTH).max(left);
            (
                left,
                mr,
                rect(left, grid_top, (left + gutter_w).min(mr), bottom),
                rect(mr, grid_top, right, bottom),
            )
        };
        let grid_area = rect(grid_l, grid_top, grid_r, bottom);
        let gc = ((grid_r - grid_l) / cw).floor().max(1.) as usize;
        let gr = ((bottom - grid_top) / rh).floor().max(1.) as usize;
        let winbar = r.cells.1 - r.request.1;
        r.island = group;
        r.tab_bar = None;
        r.crumbs = None;
        r.grid_area = grid_area;
        r.cells = (gc, gr.max(winbar + 1));
        r.request = (gc, gr.saturating_sub(winbar).max(1));
        let divider = (!last).then(|| rect(right, header_top, rr + GAP + h, bottom));
        let (row, col, width, height) = r.logical;
        r.viewer = Some(ViewerRect {
            pane: *v,
            group,
            toolbar,
            header: rect(left, header_top, right, grid_top),
            gutter,
            marks,
            divider,
            buttons,
        });
        if let Some(d) = divider {
            out.gaps.push(Gap {
                bounds: d,
                kind: GapKind::Divider {
                    row: row + height / 2,
                    col: col + width,
                },
            });
        }
    }
}

/// What a placed grid is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaceKind {
    Window,
    Float,
    Message,
}

/// A grid as drawn: its cell (0, 0) at `origin`, clipped to `clip`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridPlace {
    pub grid: GridId,
    pub origin: Point<Pixels>,
    pub clip: Bounds<Pixels>,
    /// Grid size (cols, rows).
    pub cells: (usize, usize),
    pub kind: PlaceKind,
    pub mouse: bool,
    /// Editor text (I-beam).
    pub text: bool,
    /// A code split's first text column (nvim's `textoff`): from there on its cells are drawn
    /// [`look::GUTTER_TRIM`] px further left, so the code starts where WebStorm's does (nvim's
    /// statuscolumn can only give whole cells). None: no trim.
    pub trim_col: Option<usize>,
}

/// x of column `col` (fractional: float anchors) from a grid's origin, with the gutter trim.
pub fn col_x(col: f64, cell_width: Pixels, trim_col: Option<usize>) -> Pixels {
    let x = cell_width * col as f32;
    if trim_col.is_some_and(|t| col >= t as f64) {
        x - px(look::GUTTER_TRIM)
    } else {
        x
    }
}

/// The column at `x` px from a grid's origin, with the gutter trim (may be outside the grid).
pub fn col_at(x: Pixels, cell_width: Pixels, trim_col: Option<usize>) -> i64 {
    if let Some(t) = trim_col {
        let shifted = ((x + px(look::GUTTER_TRIM)) / cell_width).floor() as i64;
        if shifted >= t as i64 {
            return shifted;
        }
    }
    (x / cell_width).floor() as i64
}

/// An editor split's slot for the tabs surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EditorSlot {
    pub win: i64,
    pub grid: GridId,
    pub tab_bar: Bounds<Pixels>,
    /// The breadcrumbs strip under the tab bar (Feel vscode), while it has one.
    pub crumbs: Option<Bounds<Pixels>>,
    pub island: Bounds<Pixels>,
    pub empty: bool,
}

/// Read-only geometry snapshot of one layout (window coordinates), shared with every surface.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Geometry {
    pub layout: Layout,
    pub metrics: CellMetrics,
    /// Placed grids, bottom to top (windows, then floats / the message grid in nvim's order).
    pub places: Vec<GridPlace>,
    /// The caret's cell (IME candidate window, popups at the caret).
    pub caret: Option<Bounds<Pixels>>,
}

impl Geometry {
    pub fn place(&self, grid: GridId) -> Option<&GridPlace> {
        self.places.iter().find(|p| p.grid == grid)
    }

    /// Top-left of cell (row, col) of a grid (fractional for float anchors).
    pub fn cell_to_px(&self, grid: GridId, row: f64, col: f64) -> Option<Point<Pixels>> {
        if grid == 1 {
            // grid 1's cells (`relative=editor` floats: pickers, menus):
            // nvim's screen over the islands' whole width, ~1 cell per cell
            let l = &self.layout;
            return Some(point(px(l.x_bottom.at(col)), px(l.y.at(row))));
        }
        let p = self.place(grid)?;
        Some(point(
            p.origin.x + col_x(col, self.metrics.cell_width, p.trim_col),
            p.origin.y + self.metrics.row_height * row as f32,
        ))
    }

    /// Bounds of `cols` cells at (row, col) of a grid.
    pub fn cell_bounds(
        &self,
        grid: GridId,
        row: usize,
        col: usize,
        cols: usize,
    ) -> Option<Bounds<Pixels>> {
        let o = self.cell_to_px(grid, row as f64, col as f64)?;
        Some(Bounds::new(
            o,
            size(
                self.metrics.cell_width * cols as f32,
                self.metrics.row_height,
            ),
        ))
    }

    /// The island of an nvim window (by window handle).
    pub fn win_rect(&self, win: i64) -> Option<&WinRect> {
        self.layout.wins.iter().find(|w| w.win == win)
    }

    /// The island a native surface is drawn over (its host window), when that window is shown.
    pub fn role_rect(&self, role: Role) -> Option<&WinRect> {
        self.layout.wins.iter().find(|w| w.role == Some(role))
    }

    /// Every window with `role`, in nvim's window order (markdown previews: many).
    pub fn role_rects(&self, role: Role) -> Vec<&WinRect> {
        self.layout
            .wins
            .iter()
            .filter(|w| w.role == Some(role))
            .collect()
    }

    /// A maximized island's rect ([`Layout::maximize`]); else the whole body as islands
    /// (tree + editor region + bottom tool window + Chat column as one: the lazygit float).
    pub fn maximized_rect(&self) -> Bounds<Pixels> {
        let l = &self.layout;
        if let Some((_, area)) = l.maximized {
            return area;
        }
        let mut b = l.editor;
        for r in [l.tree, l.bottom, l.frame.chat].into_iter().flatten() {
            b = b.union(&r);
        }
        b
    }

    /// Editor splits' tab bar slots, in nvim's window order.
    pub fn slots(&self) -> Vec<EditorSlot> {
        self.layout
            .wins
            .iter()
            .filter_map(|w| {
                Some(EditorSlot {
                    win: w.win,
                    grid: w.grid,
                    tab_bar: w.tab_bar?,
                    crumbs: w.crumbs,
                    island: w.island,
                    empty: w.empty,
                })
            })
            .collect()
    }

    pub fn caret(&self) -> Option<Bounds<Pixels>> {
        self.caret
    }

    /// The part of a place that shows its grid's cells.
    fn visible(&self, p: &GridPlace) -> Bounds<Pixels> {
        let extent = Bounds::new(
            p.origin,
            size(
                self.metrics.cell_width * p.cells.0 as f32,
                self.metrics.row_height * p.cells.1 as f32,
            ),
        );
        extent.intersect(&p.clip)
    }

    /// Topmost mouse-enabled grid under `pos`: (grid, row, col) in that grid.
    pub fn grid_at(&self, pos: Point<Pixels>) -> Option<(GridId, usize, usize)> {
        let p = self
            .places
            .iter()
            .rev()
            .filter(|p| p.mouse)
            .find(|p| self.visible(p).contains(&pos))?;
        let (row, col) = self.cell_in(p, pos);
        Some((p.grid, row.max(0) as usize, col.max(0) as usize))
    }

    /// Cell of `pos` relative to a place's origin (may be outside the grid).
    pub fn cell_in(&self, p: &GridPlace, pos: Point<Pixels>) -> (i64, i64) {
        (
            ((pos.y - p.origin.y) / self.metrics.row_height).floor() as i64,
            col_at(pos.x - p.origin.x, self.metrics.cell_width, p.trim_col),
        )
    }

    /// A float / the message grid under `pos` (they cover gaps).
    fn overlay_at(&self, pos: Point<Pixels>) -> bool {
        self.places
            .iter()
            .any(|p| p.kind != PlaceKind::Window && self.visible(p).contains(&pos))
    }

    /// The draggable border under `pos` (not under a float).
    pub fn gap_at(&self, pos: Point<Pixels>) -> Option<&Gap> {
        if self.overlay_at(pos) {
            return None;
        }
        // nvim's separators before the tree's (the tree gap only borders the tree)
        self.layout.gaps.iter().find(|g| g.bounds.contains(&pos))
    }

    /// Mouse cursor at `pos` over the grids: resize arrows on gaps, I-beam over editor text, an
    /// arrow elsewhere (surfaces set their own over their clickables).
    pub fn cursor_at(&self, pos: Point<Pixels>) -> CursorStyle {
        self.cursor_regions()
            .into_iter()
            .rev()
            .find(|(b, _)| b.contains(&pos))
            .map_or(CursorStyle::Arrow, |(_, c)| c)
    }

    /// Cursor regions in paint order (a later one wins where they overlap).
    pub fn cursor_regions(&self) -> Vec<(Bounds<Pixels>, CursorStyle)> {
        let mut out = Vec::new();
        for p in self.places.iter().filter(|p| p.kind == PlaceKind::Window) {
            let style = if p.text {
                CursorStyle::IBeam
            } else {
                CursorStyle::Arrow
            };
            out.push((p.clip, style));
        }
        for g in &self.layout.gaps {
            out.push((g.bounds, g.cursor()));
        }
        for p in self.places.iter().filter(|p| p.kind != PlaceKind::Window) {
            out.push((self.visible(p), CursorStyle::Arrow));
        }
        out
    }

    /// Where a float goes: its anchor point (on its anchor grid) minus its size for the S / E
    /// anchors, kept inside the window.
    pub fn float_origin(
        &self,
        anchor: Anchor,
        anchor_grid: GridId,
        anchor_row: f64,
        anchor_col: f64,
        cols: usize,
        rows: usize,
    ) -> Option<Point<Pixels>> {
        let at = self.cell_to_px(anchor_grid, anchor_row, anchor_col)?;
        let (w, h) = (
            self.metrics.cell_width.as_f32() * cols as f32,
            self.metrics.row_height.as_f32() * rows as f32,
        );
        let mut x = at.x.as_f32();
        let mut y = at.y.as_f32();
        if matches!(anchor, Anchor::NE | Anchor::SE) {
            x -= w;
        }
        if matches!(anchor, Anchor::SW | Anchor::SE) {
            y -= h;
        }
        let vp = self.layout.frame.viewport;
        let (vw, vh) = (vp.width.as_f32(), vp.height.as_f32());
        Some(point(px(x.min(vw - w).max(0.)), px(y.min(vh - h).max(0.))))
    }

    /// The message grid (command line, messages) at the bottom of the islands, full width.
    pub fn message_place(&self, grid: GridId, cols: usize, rows: usize) -> GridPlace {
        let inner = self.layout.frame.inner;
        let h = self.metrics.row_height * rows as f32;
        let top = inner.bottom() - h;
        GridPlace {
            grid,
            origin: point(inner.origin.x, top),
            clip: Bounds::new(point(inner.origin.x, top), size(inner.size.width, h)),
            cells: (cols, rows),
            kind: PlaceKind::Message,
            mouse: true,
            text: false,
            trim_col: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m() -> CellMetrics {
        CellMetrics {
            font_size: px(13.),
            cell_width: px(8.),
            row_height: px(20.),
            ..Default::default()
        }
    }

    const W: f32 = 1008.;
    const H: f32 = 868.;
    /// Islands area: x MARGIN..W-MARGIN, y TOOLBAR..H-STATUS-MARGIN.
    const IL: f32 = MARGIN;
    const IR: f32 = W - MARGIN;
    // compact density, as the tests run
    const IT: f32 = 30.;
    const IB: f32 = H - 23. - MARGIN;
    /// Editor area left with the 300 px tree open.
    const EL: f32 = IL + 300. + 3.;

    fn frame(tree: bool) -> Frame {
        Frame::new(
            size(px(W), px(H)),
            Panels {
                tree_open: tree,
                tree_width: 300.,
                chat: None,
                activity: false,
                rail: false,
            },
        )
    }

    fn cols(w: f32) -> usize {
        (w / 8.).floor() as usize
    }

    fn cols_of(w: f32) -> usize {
        cols(w)
    }

    fn win(
        grid: GridId,
        row: usize,
        col: usize,
        width: usize,
        height: usize,
        kind: WinKind,
    ) -> NvimWin {
        NvimWin {
            grid,
            win: 1000 + grid as i64,
            row,
            col,
            width,
            height,
            kind,
            ..Default::default()
        }
    }

    fn b(x0: f32, y0: f32, x1: f32, y1: f32) -> Bounds<Pixels> {
        rect(x0, y0, x1, y1)
    }

    /// nvim's screen for the test frame.
    fn screen() -> (usize, usize) {
        frame(true).screen_size(&m())
    }

    #[test]
    fn each_island_maximizes_alone_over_the_body_with_the_strip_s_row() {
        let viewport = size(px(W), px(H));
        let panels = Panels {
            chat: Some(420.),
            ..Panels::default()
        };
        let f = Frame::with_workspace_strip(viewport, panels, true);
        let (cols, rows) = f.screen_size(&m());
        let wins = [
            win(2, 0, 0, cols / 2, rows - 12, WinKind::Split),
            win(
                3,
                0,
                cols / 2 + 1,
                cols - cols / 2 - 1,
                rows - 12,
                WinKind::Split,
            ),
            win(4, rows - 10, 0, cols, 8, WinKind::Tool),
        ];
        let mut l = layout(&f, &m(), (cols, rows), &wins);
        let before = l.wins[1];
        let area = Frame::maximized(viewport, false);
        // the strip's row is the body's again; the margins stay; no tree, no column
        assert_eq!(area, b(IL, IT, IR, IB));
        assert!(l.maximize(Island::Split(before.win), area, &m()));
        assert_eq!(l.maximized, Some((Island::Split(before.win), area)));
        assert_eq!(l.wins.len(), 1);
        let w = l.wins[0];
        assert_eq!(w.island, area);
        assert_eq!(w.tab_bar, Some(b(IL, IT, IR, IT + TAB_BAR_HEIGHT)));
        assert_eq!(w.grid_area.top(), px(IT + TAB_BAR_HEIGHT));
        // the grid fills what is left, in whole cells
        let o = ISLAND_BORDER;
        assert_eq!(
            w.request,
            (
                cols_of(IR - IL - 2. * o),
                ((IB - o - IT - TAB_BAR_HEIGHT) / 20.).floor() as usize
            )
        );
        assert!(w.request.0 > before.request.0 && w.request.1 > before.request.1);
        assert_eq!(l.tree, None);
        assert_eq!(l.frame.chat, None);
        assert_eq!(l.bottom, None);
        assert!(l.gaps.is_empty());
        // not laid out: nothing changes
        let mut again = layout(&f, &m(), (cols, rows), &wins);
        let copy = again.clone();
        assert!(!again.maximize(Island::Split(42), area, &m()));
        assert_eq!(again, copy);
        // the tree, the chat column and a bottom host maximize alone too
        let mut pane = win(4, rows - 10, 0, cols, 8, WinKind::Tool);
        pane.role = Some(Role::Pane);
        let wins = [win(2, 0, 0, cols, rows - 12, WinKind::Split), pane];
        for island in [Island::Tree, Island::Chat, Island::Bottom(pane.win)] {
            let mut l = layout(&f, &m(), (cols, rows), &wins);
            let host = *l.wins.iter().find(|w| w.win == pane.win).unwrap();
            assert!(l.maximize(island, area, &m()), "{island:?}");
            assert_eq!(l.tree, (island == Island::Tree).then_some(area));
            assert_eq!(l.frame.chat, (island == Island::Chat).then_some(area));
            match island {
                Island::Bottom(_) => {
                    let r = l.wins.iter().find(|w| w.role == Some(Role::Pane)).unwrap();
                    assert_eq!(r.island, area);
                    // a surface draws there: its placeholder grid is not resized
                    assert_eq!(r.request, host.request);
                    assert_eq!(l.wins.len(), 1);
                }
                _ => assert!(l.wins.is_empty()),
            }
        }
        // a closed tree / no column: not laid out
        let mut l = layout(&frame(false), &m(), screen(), &[]);
        assert!(!l.maximize(Island::Tree, area, &m()));
        assert!(!l.maximize(Island::Chat, area, &m()));
    }

    #[test]
    fn workspace_strip_reserves_body_space_without_moving_native_chrome() {
        // The shortened IDE window keeps native chrome and a usable body too.
        for height in [880., 220.] {
            let viewport = size(px(936.), px(height));
            let original = Frame::new(viewport, Panels::default());
            let managed = Frame::with_workspace_strip(viewport, Panels::default(), true);
            assert_eq!(managed.toolbar, original.toolbar);
            assert_eq!(managed.status, original.status);
            assert_eq!(
                managed.body.top(),
                original.body.top() + px(look::TAB_HEIGHT)
            );
            assert_eq!(managed.body.bottom(), original.body.bottom());
            assert_eq!(managed.editor_x, original.editor_x);
            assert!(managed.body.size.height > px(100.));
        }
    }

    #[test]
    fn frame_regions_and_screen_size() {
        let f = frame(true);
        assert_eq!(f.toolbar, b(0., 0., W, TOOLBAR_HEIGHT.get()));
        assert_eq!(f.status, b(0., H - STATUS_HEIGHT, W, H));
        assert_eq!(f.inner, b(IL, IT, IR, IB));
        assert_eq!(f.tree_x, Some((IL, IL + 300.)));
        assert_eq!(f.editor_x, (EL, IR));
        // the islands' whole width (the tree's too) and rows + status line + command line
        let rows = ((IB - IT) / 20.).floor() as usize;
        assert_eq!(f.screen_size(&m()), (cols(IR - IL), rows + EXTRA_ROWS));
        // tree closed: the editor gets the whole width, nvim's screen stays
        let f = frame(false);
        assert_eq!(f.editor_x, (IL, IR));
        assert_eq!(f.screen_size(&m()), screen());
    }

    #[test]
    fn the_chat_column_takes_its_width_off_nvim_s_screen_full_height_on_the_right() {
        let panels = Panels {
            chat: Some(420.),
            ..Panels::default()
        };
        let f = Frame::new(size(px(W), px(H)), panels);
        // the column: right edge of the islands' area, the body's full height
        assert_eq!(f.chat, Some(b(IR - 420., IT, IR, IB)));
        // the islands (tree, editor, bottom) end one gap before it; nvim's screen with them
        assert_eq!(f.inner, b(IL, IT, IR - 420. - GAP, IB));
        assert_eq!(f.editor_x, (EL, IR - 420. - GAP));
        assert_eq!(f.screen_size(&m()).0, cols(IR - 420. - GAP - IL));
        // its gap drags the width; maximize covers it too
        let l = layout(&f, &m(), f.screen_size(&m()), &[]);
        let gap = l
            .gaps
            .iter()
            .find(|g| g.kind == GapKind::Chat)
            .expect("chat gap");
        assert!(
            gap.bounds
                .contains(&point(px(IR - 420. - 1.), px(IT + 100.)))
        );
        let geo = Geometry {
            layout: l,
            ..Default::default()
        };
        assert_eq!(geo.maximized_rect().right(), px(IR));
        // no column: no gap, the room is nvim's
        let f = frame(true);
        assert_eq!(f.chat, None);
        let l = layout(&f, &m(), screen(), &[]);
        assert!(l.gaps.iter().all(|g| g.kind != GapKind::Chat));
    }

    struct Width {
        name: &'static str,
        of: fn(f32, f32) -> f32,
        want: f32,
        room: f32,
        is: f32,
    }

    #[test]
    fn a_panel_s_width_is_clamped_to_its_range_and_the_room_left() {
        // GAP follows the density: not a const
        let widths = [
            Width {
                name: "the chat column below its minimum",
                of: Frame::chat_width_for,
                want: 100.,
                room: 1400.,
                is: CHAT_MIN_WIDTH,
            },
            Width {
                name: "the chat column above its maximum",
                of: Frame::chat_width_for,
                want: 2500.,
                room: 4000.,
                is: CHAT_MAX_WIDTH,
            },
            Width {
                name: "the chat column in range",
                of: Frame::chat_width_for,
                want: 500.,
                room: 1400.,
                is: 500.,
            },
            Width {
                name: "the chat column leaves the tree and the editor their minimum",
                of: Frame::chat_width_for,
                want: 590.,
                room: 784.,
                is: 784. - GAP - GAP - TREE_MIN_WIDTH - EDITOR_MIN_WIDTH,
            },
            Width {
                name: "the chat column keeps its minimum when the editor has to shrink",
                of: Frame::chat_width_for,
                want: 420.,
                room: 600.,
                is: CHAT_MIN_WIDTH,
            },
            Width {
                name: "the tree below its minimum",
                of: Frame::tree_width_for,
                want: 10.,
                room: 1000.,
                is: TREE_MIN_WIDTH,
            },
            Width {
                name: "the tree leaves the editor its minimum",
                of: Frame::tree_width_for,
                want: 950.,
                room: 1000.,
                is: 1000. - GAP - EDITOR_MIN_WIDTH,
            },
        ];
        for w in &widths {
            assert_eq!((w.of)(w.want, w.room), w.is, "{}", w.name);
        }
    }

    /// The column dragged to 590 px in an 800 px window gives way, the tree and the editor
    /// keep their minimum. In a window too narrow for both minimums the tree keeps its own.
    #[test]
    fn a_narrow_window_narrows_the_dragged_column_and_the_editor_not_the_tree() {
        let panels = Panels {
            chat: Some(590.),
            ..Panels::default()
        };
        let f = Frame::new(size(px(800.), px(700.)), panels);
        let chat = f.chat.expect("the column");
        let (tl, tr) = f.tree_x.expect("the tree");
        assert!(tr - tl >= TREE_MIN_WIDTH, "{f:?}");
        assert!(f.editor_x.1 - f.editor_x.0 >= EDITOR_MIN_WIDTH, "{f:?}");
        assert!(chat.size.width.as_f32() < 590., "{chat:?}");
        // wide again: the dragged width comes back
        let f = Frame::new(size(px(1400.), px(700.)), panels);
        assert_eq!(f.chat.unwrap().size.width.as_f32(), 590.);
        let f = Frame::new(size(px(300.), px(300.)), Panels::default());
        assert_eq!(f.tree_x.map(|(l, r)| r - l), Some(TREE_MIN_WIDTH));
    }

    const RAIL: f32 = super::super::projects::RAIL_WIDTH;

    struct LeftBars {
        name: &'static str,
        rail: bool,
        activity: bool,
        /// Where the rail ends and the Activity bar starts, None for a bar not shown.
        rail_x1: Option<f32>,
        activity_x0: Option<f32>,
        islands_x0: f32,
    }

    const LEFT_BARS: &[LeftBars] = &[
        LeftBars {
            name: "neither",
            rail: false,
            activity: false,
            rail_x1: None,
            activity_x0: None,
            islands_x0: MARGIN,
        },
        LeftBars {
            name: "the rail",
            rail: true,
            activity: false,
            rail_x1: Some(RAIL),
            activity_x0: None,
            islands_x0: RAIL,
        },
        LeftBars {
            name: "Feel vscode's Activity bar",
            rail: false,
            activity: true,
            rail_x1: None,
            activity_x0: Some(0.),
            islands_x0: ACTIVITY_BAR_WIDTH,
        },
        LeftBars {
            name: "the Activity bar right of the rail",
            rail: true,
            activity: true,
            rail_x1: Some(RAIL),
            activity_x0: Some(RAIL),
            islands_x0: RAIL + ACTIVITY_BAR_WIDTH,
        },
    ];

    /// The rail and the Activity bar take their width off the left of the islands, at the
    /// window's edge, the body's height; the islands keep their right and bottom edge.
    #[test]
    fn the_left_bars_take_their_width_off_the_left_of_the_islands() {
        let vp = size(px(1400.), px(900.));
        let plain = Frame::new(vp, Panels::default());
        for row in LEFT_BARS {
            let f = Frame::new(
                vp,
                Panels {
                    rail: row.rail,
                    activity: row.activity,
                    ..Panels::default()
                },
            );
            let (top, bottom) = (y0(&f.body), y1(&f.body));
            let name = row.name;
            assert_eq!(
                f.rail,
                row.rail_x1.map(|x| rect(0., top, x, bottom)),
                "{name}"
            );
            assert_eq!(
                f.activity,
                row.activity_x0
                    .map(|x| rect(x, top, x + ACTIVITY_BAR_WIDTH, bottom)),
                "{name}"
            );
            assert_eq!(x0(&f.inner), row.islands_x0, "{name}");
            assert_eq!(f.tree_x.map(|t| t.0), Some(row.islands_x0), "{name}");
            assert_eq!(x1(&f.inner), x1(&plain.inner), "{name}");
            assert_eq!(y1(&f.inner), y1(&plain.inner), "{name}");
        }
    }

    #[test]
    fn a_split_with_the_minimap_leaves_vs_code_s_width_at_its_right() {
        let f = frame(true);
        let (c, r) = screen();
        let rows = r - EXTRA_ROWS;
        let o = ISLAND_BORDER;
        let on = |w: NvimWin| NvimWin { minimap: true, ..w };
        let l = layout(
            &f,
            &m(),
            (c, r),
            &[on(win(2, 0, 0, c, rows, WinKind::Split))],
        );
        let w = &l.wins[0];
        // 8 px cells, the text area 696 px: floor(694 / 9) + 8 = 85 px
        let area = IR - o - (EL + o);
        let mw = ((area - 2.) / 9.).floor() + 8.;
        assert_eq!(minimap_width(area, 8.), Some(mw));
        let split = (IR - o - mw).round();
        let top = IT + TAB_BAR_HEIGHT;
        assert_eq!(w.minimap, Some(b(split, top, IR - o, IB - o)));
        assert_eq!(w.grid_area, b(EL + o, top, split, IB - o));
        assert_eq!(w.request.0, cols(split - EL - o));
        // a wide split: VS Code's 120 columns at most
        assert_eq!(minimap_width(2000., 8.), Some(120.));
        // too narrow to keep 20 code columns beside it: none
        assert_eq!(minimap_width(180., 8.), None);
        // two splits side by side: each its own
        let half = c / 2;
        let l = layout(
            &f,
            &m(),
            (c, r),
            &[
                on(win(2, 0, 0, half, rows, WinKind::Split)),
                on(win(3, 0, half + 1, c - half - 1, rows, WinKind::Split)),
            ],
        );
        for w in &l.wins {
            let mm = w.minimap.unwrap();
            assert_eq!(mm.left(), w.grid_area.right());
            assert_eq!(mm.right().as_f32(), x1(&w.island) - o);
        }
        // the empty editor, a tool window, a role window, a viewer pane: none
        let none = [
            NvimWin {
                empty: true,
                ..on(win(2, 0, 0, c, rows, WinKind::Split))
            },
            on(win(2, 0, 0, c, rows, WinKind::Tool)),
            NvimWin {
                role: Some(Role::Markdown),
                ..on(win(2, 0, 0, c, rows, WinKind::Split))
            },
            on(win(2, 0, 0, c, rows, WinKind::Viewer)),
        ];
        for w in none {
            let l = layout(&f, &m(), (c, r), &[w]);
            assert_eq!(l.wins[0].minimap, None, "{w:?}");
        }
        // off: the grid has the whole text area
        let l = layout(&f, &m(), (c, r), &[win(2, 0, 0, c, rows, WinKind::Split)]);
        assert_eq!(
            (l.wins[0].minimap, l.wins[0].grid_area.right().as_f32()),
            (None, IR - o)
        );
        // maximized: at the new right, as wide as the wider text area gives
        let viewport = size(px(W), px(H));
        let f = Frame::with_workspace_strip(viewport, Panels::default(), false);
        let (c, r) = f.screen_size(&m());
        let split = on(win(2, 0, 0, c, r - EXTRA_ROWS, WinKind::Split));
        let mut l = layout(&f, &m(), (c, r), &[split]);
        let area = Frame::maximized(viewport, false);
        assert!(l.maximize(Island::Split(split.win), area, &m()));
        let w = &l.wins[0];
        let mm = w.minimap.unwrap();
        assert_eq!(mm.right().as_f32(), x1(&area) - ISLAND_BORDER);
        assert_eq!(mm.left(), w.grid_area.right());
        let text = x1(&area) - x0(&area) - 2. * ISLAND_BORDER;
        assert_eq!(Some(mm.size.width.as_f32()), minimap_width(text, 8.));
    }

    #[test]
    fn feel_vscode_breadcrumbs_take_22_px_under_the_tab_bar() {
        let f = frame(true);
        let (c, r) = screen();
        let rows = r - EXTRA_ROWS;
        let split = NvimWin {
            crumbs: true,
            ..win(2, 0, 0, c, rows, WinKind::Split)
        };
        let l = layout(&f, &m(), (c, r), &[split]);
        let w = &l.wins[0];
        let o = ISLAND_BORDER;
        let top = IT + TAB_BAR_HEIGHT;
        assert_eq!(w.crumbs, Some(b(EL + o, top, IR - o, top + 22.)));
        assert_eq!(w.grid_area, b(EL + o, top + 22., IR - o, IB - o));
        // a tool window has none
        let tool = NvimWin {
            crumbs: true,
            ..win(2, 0, 0, c, rows, WinKind::Tool)
        };
        assert_eq!(layout(&f, &m(), (c, r), &[tool]).wins[0].crumbs, None);
        // maximized: kept under the bar
        let mut l = layout(&f, &m(), (c, r), &[split]);
        let area = b(0., 40., 800., 600.);
        assert!(l.maximize(Island::Split(1002), area, &m()));
        assert_eq!(
            l.wins[0].crumbs,
            Some(b(o, 40. + TAB_BAR_HEIGHT, 800. - o, 62. + TAB_BAR_HEIGHT))
        );
    }

    #[test]
    fn one_split_fills_the_editor_area_below_its_tab_bar() {
        let f = frame(true);
        let (c, r) = screen();
        let rows = r - EXTRA_ROWS;
        let l = layout(&f, &m(), (c, r), &[win(2, 0, 0, c, rows, WinKind::Split)]);
        let w = &l.wins[0];
        assert_eq!(w.island, b(EL, IT, IR, IB));
        assert_eq!(w.tab_bar, Some(b(EL, IT, IR, IT + TAB_BAR_HEIGHT)));
        let o = ISLAND_BORDER;
        assert_eq!(w.grid_area, b(EL + o, IT + TAB_BAR_HEIGHT, IR - o, IB - o));
        // fewer columns than its logical width: the tree takes part of nvim's screen
        let fit = (
            cols(IR - EL - 2. * o),
            ((IB - o - IT - TAB_BAR_HEIGHT) / 20.).floor() as usize,
        );
        assert_eq!(w.cells, fit);
        assert_eq!(w.request, fit);
        assert!(fit.0 < c);
        assert_eq!(l.tree, Some(b(IL, IT, IL + 300., IB)));
        assert_eq!(l.bottom, None);
        // only the tree's gap
        assert_eq!(l.gaps.len(), 1);
        assert_eq!(l.gaps[0].kind, GapKind::Tree);
        assert_eq!(l.gaps[0].bounds, b(IL + 300. - GRAB, IT, EL + GRAB, IB));
    }

    #[test]
    fn winbar_rows_are_not_part_of_the_request() {
        let f = frame(true);
        let (c, r) = screen();
        let mut w = win(2, 0, 0, c, r - EXTRA_ROWS, WinKind::Other);
        w.winbar = 1;
        let l = layout(&f, &m(), (c, r), &[w]);
        // no tab bar slot; one of the grid's rows is the winbar
        let rows = ((IB - IT - 2. * ISLAND_BORDER) / 20.).floor() as usize;
        assert_eq!(l.wins[0].cells.1, rows);
        assert_eq!(l.wins[0].request.1, rows - 1);
    }

    #[test]
    fn markdown_preview_joins_its_editors_island_and_tab_row() {
        let f = frame(true);
        let (c, r) = screen();
        let half = (c - 1) / 2;
        let rows = r - EXTRA_ROWS;
        let mut p = win(3, 0, half + 1, c - half - 1, rows, WinKind::Other);
        p.role = Some(Role::Markdown);
        let l = layout(
            &f,
            &m(),
            (c, r),
            &[win(2, 0, 0, half, rows, WinKind::Split), p],
        );
        let (e, p) = (&l.wins[0], &l.wins[1]);
        assert_eq!(e.island, b(EL, IT, IR, IB));
        assert_eq!(e.tab_bar, Some(b(EL, IT, IR, IT + TAB_BAR_HEIGHT)));
        // the editor's grid keeps its half; the preview starts right of the 1 px divider
        assert!(x1(&e.grid_area) < x0(&p.island));
        assert_eq!(y0(&p.island), IT + TAB_BAR_HEIGHT);
        assert_eq!(x1(&p.island), IR);
        assert_eq!(p.surface_rect(), p.island);
        // the separator stays draggable
        assert!(
            l.gaps
                .iter()
                .any(|g| matches!(g.kind, GapKind::Vertical { .. }))
        );
    }

    #[test]
    fn neighbour_splits_get_a_draggable_gap_on_nvim_s_separator() {
        let f = frame(true);
        let (c, r) = screen();
        let half = (c - 1) / 2;
        let rows = r - EXTRA_ROWS;
        let l = layout(
            &f,
            &m(),
            (c, r),
            &[
                win(2, 0, 0, half, rows, WinKind::Split),
                win(3, 0, half + 1, c - half - 1, rows, WinKind::Split),
            ],
        );
        let (a, d) = (&l.wins[0], &l.wins[1]);
        let x = l.x_editor;
        assert_eq!(x0(&a.island), EL);
        assert_eq!(x1(&a.island), x.edge(half + 1) - GAP);
        assert_eq!(x0(&d.island), x.edge(half + 1));
        assert_eq!(x1(&d.island), IR);
        assert_eq!(x0(&d.island) - x1(&a.island), GAP);
        let gap = l
            .gaps
            .iter()
            .find(|g| matches!(g.kind, GapKind::Vertical { .. }))
            .unwrap();
        assert_eq!(
            gap.kind,
            GapKind::Vertical {
                row: rows / 2,
                col: half,
                bottom: false
            }
        );
        assert_eq!(gap.cursor(), CursorStyle::ResizeColumn);
        // a pointer in the gap is on the separator's logical column
        let mid = gap.bounds.center().x.as_f32();
        assert_eq!(x.cell(mid), half as i64);
        // stacked splits: a gap between them on the separator row
        let (c, r) = screen();
        let l = layout(
            &frame(false),
            &m(),
            (c, r),
            &[
                win(2, 0, 0, c, 19, WinKind::Split),
                win(3, 20, 0, c, 19, WinKind::Split),
            ],
        );
        let gap = l
            .gaps
            .iter()
            .find(|g| matches!(g.kind, GapKind::Horizontal { .. }))
            .unwrap();
        assert_eq!(
            gap.kind,
            GapKind::Horizontal {
                row: 19,
                col: c / 2
            }
        );
        assert_eq!(l.y.cell(gap.bounds.center().y.as_f32()), 19);
        assert_eq!(y0(&l.wins[1].island) - y1(&l.wins[0].island), GAP);
    }

    /// An editor split over rows 0..29, nvim's separator row 29, a tool window 30..end.
    fn editor_and_tool() -> Layout {
        let (c, r) = screen();
        layout(
            &frame(true),
            &m(),
            (c, r),
            &[
                win(2, 0, 0, c, 29, WinKind::Split),
                win(4, 30, 0, c, r - EXTRA_ROWS - 30, WinKind::Tool),
            ],
        )
    }

    #[test]
    fn a_tool_window_under_the_editor_spans_the_full_width_under_the_tree() {
        let l = editor_and_tool();
        assert_eq!(l.bottom_row, Some(30));
        let y = l.y;
        let (ed, term) = (&l.wins[0], &l.wins[1]);
        assert!(!ed.bottom && term.bottom);
        assert_eq!(term.island, b(IL, y.edge(30), IR, IB));
        assert_eq!(y1(&ed.island), y.edge(30) - GAP);
        // the tree ends with the editor region, a gap above the tool window
        assert_eq!(l.tree.map(|t| y1(&t)), Some(y.edge(30) - GAP));
        // the tool window's grid is as wide as nvim's screen (its logical width)
        assert_eq!(term.cells.0, cols(IR - IL - 2. * ISLAND_BORDER));
        assert_eq!(term.request.0, term.cells.0);
        // one full-width gap above it, on nvim's separator row
        let top = l
            .gaps
            .iter()
            .find(|g| g.kind == GapKind::Horizontal { row: 29, col: 0 })
            .unwrap();
        assert_eq!(x0(&top.bounds), IL);
        assert_eq!(x1(&top.bounds), IR);
        assert_eq!(top.cursor(), CursorStyle::ResizeRow);
        assert_eq!(
            l.gaps
                .iter()
                .filter(|g| matches!(g.kind, GapKind::Horizontal { .. }))
                .count(),
            1
        );
        // beside an editor split: not a bottom region
        let (c, r) = screen();
        let l = layout(
            &frame(true),
            &m(),
            (c, r),
            &[
                win(2, 0, 0, 43, 39, WinKind::Split),
                win(4, 0, 44, c - 44, 39, WinKind::Tool),
            ],
        );
        assert_eq!(l.bottom, None);
        assert!(l.wins.iter().all(|w| !w.bottom));
    }

    fn geometry(l: Layout) -> Geometry {
        let places = l
            .wins
            .iter()
            .map(|w| GridPlace {
                grid: w.grid,
                origin: w.grid_area.origin,
                clip: w.grid_area,
                cells: w.cells,
                kind: PlaceKind::Window,
                mouse: true,
                text: w.kind != WinKind::Tool,
                trim_col: None,
            })
            .collect();
        Geometry {
            layout: l,
            metrics: m(),
            places,
            caret: None,
        }
    }

    #[test]
    fn hit_testing_cursor_shapes_and_floats() {
        let mut g = geometry(editor_and_tool());
        let ed = g.layout.wins[0].grid_area.origin;
        // cell (2, 3) of the editor grid
        let at = ed + point(px(3. * 8. + 1.), px(2. * 20. + 1.));
        assert_eq!(g.grid_at(at), Some((2, 2, 3)));
        assert_eq!(g.cursor_at(at), CursorStyle::IBeam);
        let term = g.layout.wins[1].grid_area;
        let in_term = point(term.origin.x + px(10.), term.origin.y + px(5.));
        assert_eq!(g.grid_at(in_term), Some((4, 0, 1)));
        assert_eq!(g.cursor_at(in_term), CursorStyle::Arrow);
        // the tree / editor gap
        let gap = point(px(IL + 300. + 1.), px(300.));
        assert_eq!(g.gap_at(gap).map(|g| g.kind), Some(GapKind::Tree));
        assert_eq!(g.cursor_at(gap), CursorStyle::ResizeColumn);
        assert_eq!(g.grid_at(gap), None);
        // toolbar: nothing
        assert_eq!(g.grid_at(point(px(500.), px(10.))), None);
        assert_eq!(g.cursor_at(point(px(500.), px(10.))), CursorStyle::Arrow);

        // a float anchored SW at cell (2, 3) of the editor grid: above that cell
        let o = g.float_origin(Anchor::SW, 2, 2., 3., 10, 2).unwrap();
        assert_eq!(o, ed + point(px(24.), px(0.)));
        g.places.push(GridPlace {
            grid: 7,
            origin: o,
            clip: b(0., 0., W, H),
            cells: (10, 2),
            kind: PlaceKind::Float,
            mouse: true,
            text: false,
            trim_col: None,
        });
        let on_float = point(o.x + px(1.), o.y + px(21.));
        assert_eq!(g.grid_at(on_float), Some((7, 1, 0)));
        assert_eq!(g.cursor_at(on_float), CursorStyle::Arrow);
        // floats stay inside the window
        let o = g.float_origin(Anchor::NW, 2, 0., 200., 40, 2).unwrap();
        assert_eq!(o.x, px(W - 320.));
        // relative=editor: grid 1's logical cells over the islands' width
        let o = g.float_origin(Anchor::NW, 1, 10., 2., 4, 1).unwrap();
        assert_eq!(o, point(px(IL + 2. * 8.), px(g.layout.y.at(10.))));
    }

    #[test]
    fn message_grid_sits_at_the_bottom_full_width() {
        let g = geometry(layout(&frame(true), &m(), screen(), &[]));
        let p = g.message_place(9, 87, 2);
        assert_eq!(p.origin, point(px(IL), px(IB - 40.)));
        assert_eq!(p.clip, b(IL, IB - 40., IR, IB));
    }
}
