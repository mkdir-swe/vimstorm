//! The workspace (window root) on the real nvim + config: islands laid out in pixels with nvim's
//! grids sized to them, the bottom tool window full width under the tree, gaps dragged with the
//! mouse, cursor shapes, focus and its cues, the Lua <-> Rust bridge, and one session over every
//! surface that leaves no Lua error.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use crate::common;

use std::rc::Rc;

use common::gitfix;
use common::gitui::{bounds, menu_rows, press, target, wait_target};
use common::pickers::{CTRL, NONE, edit, shift_shift, wait_picker};
use common::terminal::open as open_terminal;
use common::tree::{row_point, tv};
use common::view::{View, WINDOW};
use gpui_kit::{
    CursorStyle, ExternalPaths, FileDropEvent, Modifiers, MouseButton, Pixels, Rgba, point, px,
    size,
};
use vimstorm::editor::EditorView;
use vimstorm::git::diff::{Frame, Viewer};
use vimstorm::git::window::TabId;
use vimstorm::look;
use vimstorm::shell::{self, GapKind, Geometry, Role, WinKind};

fn geometry(v: &mut View) -> Rc<Geometry> {
    v.read(|e| e.geometry().clone())
}

/// Every window grid has the size that fits its island.
fn grids_fit(e: &EditorView) -> bool {
    let g = e.geometry();
    !g.layout.wins.is_empty()
        && g.layout.wins.iter().all(|w| {
            e.ui()
                .grids
                .get(&w.grid)
                .is_some_and(|grid| (grid.width, grid.height) == w.cells)
        })
}

fn count(e: &EditorView, kind: WinKind) -> usize {
    e.geometry()
        .layout
        .wins
        .iter()
        .filter(|w| w.kind == kind)
        .count()
}

fn git_open(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.git().read(cx).is_open())
}

fn term_open(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.terminal().read(cx).shown())
}

/// The Terminal's header draws its selected tab blue (active).
fn term_header_active(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.terminal().read(cx).header().read(cx).active())
}

/// The Git tool window's header draws its selected tab blue (active).
fn git_header_active(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.git().read(cx).header().read(cx).active())
}

/// Some editor tab bar is drawn focused (its active tab blue).
fn editor_bar_focused(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.tabs().read(cx).bars().values().any(|b| b.focused))
}

fn status_text(v: &mut View) -> Rgba {
    v.read_ws(|ws, cx| ws.statusbar().read(cx).text_color())
}

/// The color the tree's selected row (the cursor row) is painted with: its inset selection quad
/// (`SELECTION_BG` while the tree is active, `SELECTION_BG_INACTIVE` otherwise).
fn tree_selection(v: &mut View) -> Option<Rgba> {
    let ix = tv(v, |t| t.cursor().and_then(|c| t.row_index(&c)))?;
    let row = bounds(v, &format!("tree-row-{ix}"))?;
    v.cx.update(|window, _| {
        let s = window.scale_factor();
        let near = |a: f32, b: f32| (a - b).abs() < 1.;
        let x = (row.origin.x.as_f32() + look::SELECTION_INSET_X) * s;
        let y = row.origin.y.as_f32() * s;
        let h = row.size.height.as_f32() * s;
        window.painted_quads().into_iter().find_map(|q| {
            if !(near(q.bounds.origin.x.0, x)
                && near(q.bounds.origin.y.0, y)
                && near(q.bounds.size.height.0, h))
            {
                return None;
            }
            [
                look::SELECTION_BG.rgba(),
                look::SELECTION_BG_INACTIVE.rgba(),
            ]
            .into_iter()
            .find(|c| q.background.as_solid() == Some(look::hsla(*c)))
        })
    })
}

fn wait_tree_selection(v: &mut View, label: &str, want: Rgba) {
    v.wait_until(label, |v| {
        let now = tree_selection(v);
        if now != Some(want) {
            eprintln!("tree selection: {now:?}"); // (shown when the wait times out)
        }
        now == Some(want)
    });
}

fn int(v: &View, code: &str) -> i64 {
    v.lua(code).as_i64().unwrap()
}

#[test]
fn grids_follow_their_islands_and_the_tool_window_spans_the_full_width() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_for("one editor split, its grid fits", |e| {
        count(e, WinKind::Split) == 1 && grids_fit(e)
    });
    let g = geometry(&mut v);
    let ed = g.layout.wins[0];
    let tree = g.layout.tree.expect("tree panel open");
    assert!(ed.tab_bar.is_some(), "an editor split gets a tab bar slot");
    assert!(
        ed.island.origin.x > tree.right(),
        "editor island right of the tree"
    );
    // the editor's grid is narrower than its logical width: the tree takes part of the screen
    let (cols, _) = v.ui(|ui| ui.screen_size());
    assert!(ed.cells.0 < cols);

    // a vertical split: two islands, a gap between them, both grids fit
    v.lua("vim.cmd('vsplit diff.ts') return true");
    v.wait_for("two splits, grids fit", |e| {
        count(e, WinKind::Split) == 2 && grids_fit(e)
    });
    let g = geometry(&mut v);
    let (a, b) = (g.layout.wins[0], g.layout.wins[1]);
    assert!(a.island.right() < b.island.origin.x);
    assert!(
        g.layout
            .gaps
            .iter()
            .any(|gap| matches!(gap.kind, GapKind::Vertical { bottom: false, .. }))
    );

    // Git: the bottom tool window, full width under the tree and the editor
    v.lua("require('config.app.git').open() return true");
    v.wait_for("tool window laid out, grids fit", |e| {
        count(e, WinKind::Tool) >= 1 && e.geometry().layout.bottom.is_some() && grids_fit(e)
    });
    let g = geometry(&mut v);
    let term = *g
        .layout
        .wins
        .iter()
        .find(|w| w.kind == WinKind::Tool)
        .unwrap();
    let inner = g.layout.frame.inner;
    assert!(term.bottom);
    assert_eq!(term.island.origin.x, inner.origin.x);
    assert_eq!(term.island.right(), inner.right());
    let tree = g.layout.tree.unwrap();
    assert!(
        tree.bottom() < term.island.origin.y,
        "the tree ends above it"
    );
    // as wide as nvim's screen: its logical width is its drawn width
    let tw = int(
        &v,
        // (the Git tool window's host window: config/app/git.lua)
        "local w = require('config.app.git').win() return w and vim.api.nvim_win_get_width(w) or -1",
    );
    assert_eq!(tw as usize, term.cells.0.min(cols));

    // the window shrinks: still full width under the tree, grids follow
    v.cx.simulate_resize(size(px(WINDOW.0 - 120.), px(WINDOW.1 - 100.)));
    v.wait_for("relaid out after the resize", |e| {
        let g = e.geometry();
        g.layout.frame.viewport.width == px(WINDOW.0 - 120.) && grids_fit(e)
    });
    let g = geometry(&mut v);
    let term = g
        .layout
        .wins
        .iter()
        .find(|w| w.kind == WinKind::Tool)
        .unwrap();
    assert!(term.bottom);
    assert_eq!(term.island.right(), g.layout.frame.inner.right());
    assert_eq!(target(&v), "git", "Git kept the focus");
}

#[test]
fn dragging_gaps_resizes_splits_and_the_tree() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.lua("vim.cmd('vsplit diff.ts') return true");
    v.wait_for("two splits, grids fit", |e| {
        count(e, WinKind::Split) == 2 && grids_fit(e)
    });
    let g = geometry(&mut v);
    let gap = *g
        .layout
        .gaps
        .iter()
        .find(|gap| matches!(gap.kind, GapKind::Vertical { .. }))
        .unwrap();
    let GapKind::Vertical { col, .. } = gap.kind else {
        unreachable!()
    };
    assert_eq!(g.cursor_at(gap.bounds.center()), CursorStyle::ResizeColumn);
    let left = "vim.api.nvim_win_get_width(vim.fn.win_getid(1))";
    let before = int(&v, &format!("return {left}"));
    // the separator follows the pointer: 6 cells right
    let from = gap.bounds.center();
    let to = point(from.x + px(g.layout.x_editor.scale * 6.), from.y);
    v.drag(
        from,
        to,
        &format!("return vim.fn.getmousepos().screencol == {}", col + 1),
    );
    v.wait_lua(
        "left split 6 columns wider",
        &format!("return {left} == {}", before + 6),
    );
    v.wait_for("grids fit again", grids_fit);
    let g2 = geometry(&mut v);
    assert!(g2.layout.wins[0].island.right() > g.layout.wins[0].island.right());

    // a horizontal split: drag the gap between them 3 rows down
    v.lua("vim.cmd('split') return true");
    v.wait_for("three splits, grids fit", |e| {
        count(e, WinKind::Split) == 3 && grids_fit(e)
    });
    let g = geometry(&mut v);
    let gap = *g
        .layout
        .gaps
        .iter()
        .find(|gap| matches!(gap.kind, GapKind::Horizontal { .. }))
        .unwrap();
    let GapKind::Horizontal { row, .. } = gap.kind else {
        unreachable!()
    };
    assert_eq!(g.cursor_at(gap.bounds.center()), CursorStyle::ResizeRow);
    let from = gap.bounds.center();
    let to = point(from.x, from.y + px(g.layout.y.scale * 3.));
    v.drag(
        from,
        to,
        &format!("return vim.fn.getmousepos().screenrow == {}", row + 1),
    );
    v.wait_for("the separator 3 rows lower", |e| {
        e.geometry()
            .layout
            .gaps
            .iter()
            .any(|g| matches!(g.kind, GapKind::Horizontal { row: r, .. } if r == row + 3))
    });

    // the tree / editor gap: Rust's tree width, nvim's screen stays
    let screen = v.ui(|ui| ui.screen_size());
    let g = geometry(&mut v);
    let tree = g.layout.tree.unwrap();
    let gap = *g
        .layout
        .gaps
        .iter()
        .find(|gap| gap.kind == GapKind::Tree)
        .unwrap();
    assert_eq!(g.cursor_at(gap.bounds.center()), CursorStyle::ResizeColumn);
    let from = gap.bounds.center();
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(
        point(from.x + px(80.), from.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.cx.simulate_mouse_up(
        point(from.x + px(80.), from.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.wait_for("tree 80 px wider, grids fit", |e| {
        e.geometry()
            .layout
            .tree
            .is_some_and(|t| t.size.width == tree.size.width + px(80.))
            && grids_fit(e)
    });
    assert_eq!(v.ui(|ui| ui.screen_size()), screen);
}

#[test]
fn cursor_shapes_over_text_gaps_and_tool_windows() {
    let mut v = View::start("grepo", &["blame.ts"]);
    // (the bottom tool window: Git)
    v.lua("require('config.app.git').open() return true");
    v.wait_for("Git laid out", |e| {
        count(e, WinKind::Tool) >= 1 && grids_fit(e) && count(e, WinKind::Split) == 1
    });
    let g = geometry(&mut v);
    let ed = g
        .layout
        .wins
        .iter()
        .find(|w| w.kind == WinKind::Split)
        .unwrap();
    let term = g
        .layout
        .wins
        .iter()
        .find(|w| w.kind == WinKind::Tool)
        .unwrap();
    assert_eq!(g.cursor_at(ed.grid_area.center()), CursorStyle::IBeam);
    assert_eq!(g.cursor_at(term.grid_area.center()), CursorStyle::Arrow);
    let top = g
        .layout
        .gaps
        .iter()
        .find(|gap| matches!(gap.kind, GapKind::Horizontal { .. }))
        .expect("the tool window's top edge");
    assert_eq!(g.cursor_at(top.bounds.center()), CursorStyle::ResizeRow);
    let toolbar = g.layout.frame.toolbar.center();
    assert_eq!(g.cursor_at(toolbar), CursorStyle::Arrow);
}

#[test]
fn cmd_1_focuses_the_native_tree_again_closes_it_and_esc_goes_back() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    assert_eq!(target(&v), "split");
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), Some("tree"));
    assert_eq!(
        v.lua("return vim.g.ws_focus").as_str(),
        Some("tree"),
        "focus cues follow"
    );
    // a plain key the tree doesn't handle goes nowhere (not into the buffer)
    v.keystrokes("x");
    v.focus_code();
    wait_target(&mut v, "split");
    assert_eq!(v.current_line(), "line one");
    assert_eq!(v.read_ws(|ws, _| ws.native_focus()), None);

    // Esc in the tree: back to the editor
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.keystrokes("escape");
    wait_target(&mut v, "split");

    // Cmd+1 in the focused tree closes it, the keys back to the editor; hidden, Cmd+1 opens it
    // focused at the width it had
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    let width = geometry(&mut v).layout.tree.expect("the tree").size.width;
    v.keystrokes("cmd-1");
    wait_target(&mut v, "split");
    v.wait_for("tree panel closed, grids fit", |e| {
        e.geometry().layout.tree.is_none() && grids_fit(e)
    });
    let g = geometry(&mut v);
    assert_eq!(
        g.layout.wins[0].island.origin.x, g.layout.frame.inner.origin.x,
        "the editor takes the tree's place"
    );
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.wait_for("tree panel open", |e| e.geometry().layout.tree.is_some());
    assert_eq!(geometry(&mut v).layout.tree.unwrap().size.width, width);

    // a click in the editor gives nvim the keyboard back
    let row = v.cell_of("line one").0;
    let at = v.cell_pos(row, 3);
    v.click(MouseButton::Left, at);
    wait_target(&mut v, "split");
}

#[test]
fn bridge_round_trip_lua_rust_lua() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    // Lua -> Rust: the tree surface closes its panel
    v.lua("return require('config.app.bridge').notify('tree', { event = 'close' })");
    v.wait_for("tree closed", |e| e.geometry().layout.tree.is_none());
    // a bad payload is logged, nothing breaks
    v.lua("return require('config.app.bridge').notify('tree', { event = 'nope' })");
    v.lua("return require('config.app.bridge').notify('nosuchsurface', { event = 'x' })");
    // Lua -> Rust -> Lua: ask for the tree's focus, Rust tells Lua it has it
    v.lua("require('config.app').focus('tree') return true");
    v.wait_lua(
        "Lua told: the tree has the keyboard",
        "return require('config.app').native() == 'tree'",
    );
    assert_eq!(target(&v), "tree");
    v.wait_for("panel open again", |e| e.geometry().layout.tree.is_some());
    v.lua("require('config.app').focus(nil) return true");
    v.wait_lua(
        "Lua told: back in nvim",
        "return require('config.app').native() == nil",
    );
    // Snacks.explorer calls (VimEnter's auto-open, ,E) reach the native tree, no snacks window
    v.lua("Snacks.explorer() return true");
    v.wait_for("tree toggled closed", |e| {
        e.geometry().layout.tree.is_none()
    });
    assert_eq!(
        v.lua("return #Snacks.picker.get({ source = 'explorer' })")
            .as_i64(),
        Some(0)
    );
}

#[test]
fn command_line_shows_at_the_bottom_while_typing_and_messages_briefly() {
    use vimstorm::shell::PlaceKind;
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    let message = |e: &EditorView| {
        e.geometry()
            .places
            .iter()
            .find(|p| p.kind == PlaceKind::Message)
            .copied()
    };
    v.wait_for("no command line row while idle", |e| message(e).is_none());
    v.keystrokes(":");
    v.wait_for("command line shown", |e| message(e).is_some());
    let p = v.read(|e| message(e).unwrap());
    let inner = v.read(|e| e.geometry().layout.frame.inner);
    assert_eq!(p.clip.bottom(), inner.bottom(), "at the islands' bottom");
    assert_eq!(p.clip.size.width, inner.size.width, "full width");
    v.keystrokes("escape");
    v.wait_for("hidden again", |e| message(e).is_none());
}

/// The message grid starts at the islands' left edge, under the tree's column: painted above
/// the native tree island (a hit-enter prompt's first columns were hidden under it).
#[test]
fn message_grid_paints_above_the_tree() {
    use vimstorm::shell::PlaceKind;
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.lua("vim.schedule(function() vim.api.nvim_echo({ { 'one\\ntwo\\nthree' } }, true, {}) end) return true");
    v.wait_screen("Press ENTER");
    let (msg, tree) = v.read(|e| {
        let g = e.geometry();
        let msg = g
            .places
            .iter()
            .find(|p| p.kind == PlaceKind::Message)
            .copied();
        (msg, g.layout.tree)
    });
    let (msg, tree) = (msg.expect("message grid placed"), tree.expect("tree open"));
    assert!(
        msg.clip.origin.x < tree.right(),
        "{msg:?} reaches under {tree:?}"
    );
    v.pump();
    let (msg_order, tree_order) = v.cx.update(|window, _| {
        let s = window.scale_factor();
        let same = |q: gpui_kit::Bounds<gpui_kit::ScaledPixels>, b: gpui_kit::Bounds<Pixels>| {
            let near = |a: f32, b: f32| (a - b).abs() < 1.;
            near(q.origin.x.0, b.origin.x.as_f32() * s)
                && near(q.origin.y.0, b.origin.y.as_f32() * s)
                && near(q.size.width.0, b.size.width.as_f32() * s)
                && near(q.size.height.0, b.size.height.as_f32() * s)
        };
        let quads = window.painted_quads();
        let last = |b| {
            quads
                .iter()
                .filter(|q| same(q.bounds, b))
                .map(|q| q.order)
                .max()
        };
        (last(msg.clip), last(tree))
    });
    let (msg_order, tree_order) = (
        msg_order.expect("message bg"),
        tree_order.expect("tree island"),
    );
    assert!(
        msg_order > tree_order,
        "message {msg_order} over tree {tree_order}"
    );
    v.keystrokes("enter");
}

/// The bottom tool window (its windows) spans the islands' full width under the tree.
fn tool_window_full_width(e: &EditorView) -> bool {
    let g = e.geometry();
    let inner = g.layout.frame.inner;
    let tools: Vec<_> = g
        .layout
        .wins
        .iter()
        .filter(|w| w.kind == WinKind::Tool)
        .collect();
    let left = tools
        .iter()
        .map(|w| w.island.origin.x)
        .reduce(|a, b| a.min(b));
    let right = tools
        .iter()
        .map(|w| w.island.right())
        .reduce(|a, b| a.max(b));
    !tools.is_empty()
        && tools.iter().all(|w| w.bottom)
        && left == Some(inner.origin.x)
        && right == Some(inner.right())
        && g.layout
            .tree
            .is_none_or(|t| tools.iter().all(|w| t.bottom() < w.island.origin.y))
        && grids_fit(e)
}

#[test]
fn terminal_and_git_share_the_full_width_bottom_tool_window() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    // Cmd+T: the Terminal in the bottom, full width under the tree
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.wait_for("the Terminal full width under the tree", |e| {
        e.geometry().role_rect(Role::Terminal).is_some() && tool_window_full_width(e)
    });
    // Git in its place (two windows side by side in the Log tab too)
    crate::common::gitui::open_git(&mut v);
    v.wait_for("the Terminal gave Git the bottom", |e| {
        e.geometry().role_rect(Role::Terminal).is_none()
    });
    // the native Git tool window over its host window
    v.wait_until("GitView open", |v| {
        v.read_ws(|ws, cx| ws.git().read(cx).is_open())
    });
    v.wait_for("Git full width under the tree", tool_window_full_width);
    // the tree closes and opens beside it: still full width under it
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.lua("require('config.tree').close() return true");
    v.wait_for("tree closed", |e| e.geometry().layout.tree.is_none());
    v.wait_for("Git full width, no tree", tool_window_full_width);
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.wait_for("tree back, Git full width under it", |e| {
        e.geometry().layout.tree.is_some() && tool_window_full_width(e)
    });
    // Git hidden (focus in the editor), the editor fills the height again
    v.focus_code();
    wait_target(&mut v, "split");
    crate::common::gitui::hide_git(&mut v);
    v.wait_for("no bottom tool window", |e| {
        e.geometry().layout.bottom.is_none() && grids_fit(e)
    });

    // Git's Log (two windows side by side) through a shrink and a grow: still full width
    crate::common::gitui::open_git(&mut v);
    for _ in 0..3 {
        if common::gitui::active(&mut v) == TabId::Log {
            break;
        }
        v.keystrokes("alt-cmd-right");
        v.pump();
    }
    v.wait_until("Git on the Log", |v| common::gitui::active(v) == TabId::Log);
    v.wait_for("Log full width under the tree", tool_window_full_width);
    let small = (WINDOW.0 * 0.6, WINDOW.1 * 0.9);
    v.cx.simulate_resize(size(px(small.0), px(small.1)));
    v.wait_for("relaid out small", |e| {
        e.geometry().layout.frame.viewport.width == px(small.0) && grids_fit(e)
    });
    v.cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
    v.wait_for("relaid out at full size", |e| {
        e.geometry().layout.frame.viewport.width == px(WINDOW.0) && grids_fit(e)
    });
    v.wait_for("Git still spans the full width under the tree", |e| {
        e.geometry().layout.tree.is_some() && tool_window_full_width(e)
    });
    assert!(git_open(&mut v) && target(&v) == "git");
    // a window closed or swapped while the app resized grids gets no resize ("Invalid window
    // handle" error events)
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.wait_until("Terminal back", term_open);
    assert_eq!(v.nvim_errors(), Vec::<String>::new(), "nvim error events");
}

#[test]
fn ctrl_keys_a_surface_leaves_alone_never_reach_the_buffer_behind() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    v.lua("vim.api.nvim_win_set_cursor(0, { 3, 0 }) return true");
    let wins = int(&v, "return #vim.api.nvim_tabpage_list_wins(0)");
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    // Ctrl+A (increment the 3), Ctrl+W (window prefix), Ctrl+U: swallowed while the tree has keys
    v.keystrokes("ctrl-a ctrl-w ctrl-u");
    v.focus_code();
    wait_target(&mut v, "split");
    // a pending <C-w> would make this `v` a vertical split
    v.keystrokes("v escape");
    v.wait_lua("normal mode again", "return vim.fn.mode() == 'n'");
    assert_eq!(v.current_line(), "line 3 recent");
    assert_eq!(int(&v, "return #vim.api.nvim_tabpage_list_wins(0)"), wins);
}

// Role windows -------------------------------------------------------------------------------------

/// `b` inset by the island outline: where a surface mounted in an island slot is drawn.
fn inside_outline(b: gpui_kit::Bounds<Pixels>) -> gpui_kit::Bounds<Pixels> {
    let o = px(shell::ISLAND_BORDER);
    gpui_kit::Bounds::new(
        point(b.origin.x + o, b.origin.y + o),
        size(b.size.width - o * 2., b.size.height - o * 2.),
    )
}

/// Opens the terminal (Cmd+T): the bottom pane's Terminal with the keyboard; returns its host
/// window's island.
fn terminal_island(v: &mut View) -> gpui_kit::Bounds<Pixels> {
    v.keystrokes("cmd-t");
    wait_target(v, "terminal");
    v.wait_for("the Terminal's host laid out", |e| {
        e.geometry().role_rect(Role::Terminal).is_some()
    });
    v.read(|e| e.geometry().role_rect(Role::Terminal).unwrap().island)
}

#[test]
fn the_terminal_is_drawn_over_its_host_window_in_the_bottom_pane() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    let wins = int(&v, "return #vim.api.nvim_tabpage_list_wins(0)");
    let column = terminal_island(&mut v);
    let g = geometry(&mut v);
    let host = g.role_rect(Role::Terminal).expect("its host window");
    assert!(
        host.bottom && g.place(host.grid).is_none(),
        "a bottom tool window, grid not drawn"
    );
    assert_eq!(
        int(&v, "return #vim.api.nvim_tabpage_list_wins(0)"),
        wins + 1
    );
    // no grid mouse over it
    assert!(v.read(|e| e.hit_test(column.center())).is_none());
    let inside = |v: &mut View| {
        v.pump();
        v.cx.debug_bounds("terminal-view").is_some_and(|drawn| {
            inside_outline(column).contains(&drawn.origin)
                && drawn.right() <= column.right()
                && drawn.bottom() <= column.bottom()
        })
    };
    v.wait_until("TerminalView drawn in its island", inside);
}

#[test]
fn markdown_role_windows_are_all_reported_and_a_split_keeps_its_tab_bar() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    // the file's own split + a scratch window right of it (a preview placeholder: not a split)
    v.lua(
        "vim.w.test_md = true vim.cmd('rightbelow vnew') vim.bo.buftype = 'nofile' vim.w.test_md = true \
         require('config.app.layout').role_provider('test_markdown', function(w) \
           return vim.w[w].test_md and 'markdown' or nil end) \
         require('config.app.layout').sync(true) return true",
    );
    v.wait_for("two markdown windows", |e| {
        e.geometry().role_rects(Role::Markdown).len() == 2
    });
    let g = geometry(&mut v);
    let md = g.role_rects(Role::Markdown);
    let split = md.iter().find(|w| w.kind == WinKind::Split).unwrap();
    let preview = md.iter().find(|w| w.kind != WinKind::Split).unwrap();
    // the split: native tab bar slot + island kept, the surface paints below the bar
    let bar = split.tab_bar.expect("tab bar slot kept");
    assert!(split.draws_island());
    assert!(
        g.slots().iter().any(|s| s.win == split.win),
        "tabs draw its bar"
    );
    let area = split.surface_rect();
    assert_eq!(area.origin.y, bar.bottom());
    assert_eq!(area.bottom(), split.island.bottom());
    // the placeholder: no tab bar, the surface paints the whole island
    assert!(preview.tab_bar.is_none() && !preview.draws_island());
    assert_eq!(preview.surface_rect(), preview.island);
    for w in &md {
        assert!(g.place(w.grid).is_none(), "grid not drawn");
        assert!(!w.empty, "a role window is never the empty editor");
        let c = w.surface_rect().center();
        assert!(v.read(|e| e.hit_test(c)).is_none(), "no grid mouse");
    }
    // a click / wheel over the split's preview doesn't reach nvim's grid
    let cur = int(&v, "return vim.api.nvim_get_current_win()");
    v.click(MouseButton::Left, area.center());
    v.scroll(
        area.center(),
        gpui_kit::ScrollDelta::Lines(point(0., -3.)),
        gpui_kit::TouchPhase::Moved,
    );
    v.settle();
    assert_eq!(int(&v, "return vim.api.nvim_get_current_win()"), cur);
    assert_eq!(
        int(
            &v,
            "return vim.fn.line('w0', vim.fn.win_getid(vim.fn.winnr('h')))"
        ),
        1
    );
}

#[test]
fn the_terminal_is_the_keyboards_home_while_its_host_is_current() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    terminal_island(&mut v);
    v.wait_until("TerminalView has the keyboard", |v| {
        v.read_ws(|ws, _| ws.native_focus() == Some("terminal"))
    });
    // the tree takes it; "back to nvim" (a popup closing, `focus_editor`) comes back to the
    // terminal (its host is still nvim's current window), as to Git
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    let ws = v.ws.clone();
    v.cx.update(|window, cx| ws.update(cx, |ws, cx| ws.focus_editor(window, cx)));
    v.wait_until("the terminal has the keyboard again", |v| {
        v.read_ws(|ws, _| ws.native_focus() == Some("terminal"))
    });
    // Lua's `blur` from the terminal gives it back to the editor too
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.lua("require('config.app.bridge').notify('terminal', { event = 'blur' })");
    v.wait_until("editor after blur", |v| {
        v.read_ws(|ws, _| ws.native_focus().is_none())
    });
}

// Where the code starts, files from Finder ---------------------------------------------------------

/// The editor split's (grid, island, trim column) once Lua reported its textoff.
fn code_split(v: &mut View) -> (u64, gpui_kit::Bounds<Pixels>, usize) {
    v.wait_until("the split's gutter trim", |v| {
        v.read(|e| {
            let g = e.geometry();
            g.layout
                .wins
                .iter()
                .find(|w| w.kind == WinKind::Split)
                .and_then(|w| g.place(w.grid))
                .is_some_and(|p| p.trim_col.is_some())
        })
    });
    v.read(|e| {
        let g = e.geometry();
        let w = g
            .layout
            .wins
            .iter()
            .find(|w| w.kind == WinKind::Split)
            .unwrap();
        (w.grid, w.island, g.place(w.grid).unwrap().trim_col.unwrap())
    })
}

#[test]
fn code_starts_where_webstorms_does_and_clicks_land_on_it() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1;");
    let (grid, island, textoff) = code_split(&mut v);
    let textoff_lua = v
        .lua("return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff")
        .as_u64()
        .unwrap() as usize;
    assert_eq!(textoff, textoff_lua);
    // 30.png: the island's edge -> the code / caret 44.5 (whole cells would put it at 48.3)
    let code_x = v.read(|e| e.geometry().cell_to_px(grid, 0., textoff as f64).unwrap().x);
    let from_edge = (code_x - island.origin.x).as_f32();
    assert!(
        (from_edge - 44.5).abs() <= 0.6,
        "code at {from_edge} from the island edge"
    );
    // the gutter stays: its cells aren't moved, the last one's left part shows
    let (gutter_x, origin_x, last_gutter) = v.read(|e| {
        let g = e.geometry();
        (
            g.cell_to_px(grid, 0., 0.).unwrap().x,
            g.place(grid).unwrap().origin.x,
            g.cell_to_px(grid, 0., textoff as f64 - 1.).unwrap().x,
        )
    });
    assert_eq!(gutter_x, origin_x);
    assert!(last_gutter < code_x);
    // a click just inside the first code column puts the caret on column 0 (not in the gutter)
    v.lua("vim.api.nvim_win_set_cursor(0, {1, 5}) return true");
    let row_y = v.read(|e| e.geometry().cell_to_px(grid, 0.5, 0.).unwrap().y);
    v.click(MouseButton::Left, point(code_x + px(1.), row_y));
    v.wait_lua(
        "caret on column 0",
        "return vim.api.nvim_win_get_cursor(0)[2] == 0",
    );
    // and the 4th char's middle on column 3
    let cw = v.read(|e| e.metrics().cell_width);
    v.click(MouseButton::Left, point(code_x + cw * 3.5, row_y));
    v.wait_lua(
        "caret on column 3",
        "return vim.api.nvim_win_get_cursor(0)[2] == 3",
    );
}

#[test]
fn files_dropped_from_finder_open_in_the_editor() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1;");
    let cwd = v.lua("return vim.fn.getcwd()").as_str().unwrap().to_owned();
    let file = std::path::Path::new(&cwd).join("b.ts");
    let at = v.read(|e| e.geometry().layout.editor.center());
    v.cx.simulate_event(FileDropEvent::Entered {
        position: at,
        paths: ExternalPaths([file.clone()].into_iter().collect()),
    });
    v.cx.simulate_event(FileDropEvent::Pending { position: at });
    v.cx.simulate_event(FileDropEvent::Submit { position: at });
    v.pump();
    v.wait_lua(
        "the dropped file in the editor",
        &format!(
            "return vim.api.nvim_buf_get_name(0) == {:?}",
            file.to_string_lossy()
        ),
    );
}

/// Hiding the terminal never leaves insert mode in the editor (a tree speed search left
/// open).
#[test]
fn cmd_t_then_hide_after_a_tree_search_back_in_normal_mode() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.key("shift+digit_7");
    for _ in 0..3 {
        v.key("z");
    }
    v.wait_until("tree speed search zzz", |v| {
        tv(v, |t| t.query() == Some("zzz"))
    });
    v.focus_code();
    wait_target(&mut v, "split");
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    // Cmd+T in the terminal opens a new tab, so Hide hides it
    v.lua("require('config.app.terminal').hide() return true");
    wait_target(&mut v, "split");
    v.settle();
    assert_eq!(v.mode(), "n", "Cmd+T then Hide: normal mode");
    assert_eq!(v.lua("return vim.bo.buftype").as_str(), Some(""));
    assert_eq!(target(&v), "split");
}

/// The selected tool window tab, editor tab and tree row draw blue only where the keyboard is, and
/// a popup over the tree keeps it active. With the app in the background every cue dims
/// (WebStorm: an inactive frame has no active selection) and comes back when it is active again.
#[test]
fn focus_cues_follow_the_keyboard_and_dim_while_the_app_is_inactive() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_until("editor focused: its bar focused", editor_bar_focused);
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.wait_until("Terminal focused: its selected tab is blue", |v| {
        term_header_active(v)
    });
    v.wait_until("Terminal focused: the active editor tab turns gray", |v| {
        !editor_bar_focused(v)
    });
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until(
        "editor focused again: the Terminal's selected tab turns gray",
        |v| !term_header_active(v) && editor_bar_focused(v),
    );
    crate::common::gitui::open_git(&mut v);
    v.wait_until("Git focused: its selected tab is blue", git_header_active);
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    v.wait_until(
        "Project tool window focused: Git's selected tab gray",
        |v| !git_header_active(v),
    );
    wait_tree_selection(
        &mut v,
        "Project tool window focused: its selected row blue",
        look::SELECTION_BG.rgba(),
    );

    // the context menu over a row: the tree stays active
    let at = row_point(&mut v, "diff.ts", 4.);
    press(&mut v, at, MouseButton::Right, Modifiers::default(), 1);
    v.wait_until("the tree's menu open", |v| menu_rows(v).is_some());
    v.wait_until("diff.ts selected", |v| {
        tv(v, |t| t.cursor().as_deref() == Some("diff.ts"))
    });
    wait_tree_selection(
        &mut v,
        "a popup over the Project tool window keeps it active: selected row still blue",
        look::SELECTION_BG.rgba(),
    );
    v.keystrokes("escape");
    v.wait_until("menu closed", |v| menu_rows(v).is_none());
    wait_target(&mut v, "tree");
    wait_tree_selection(&mut v, "menu closed: still blue", look::SELECTION_BG.rgba());

    // the app in the background (the tree still has the keyboard)
    wait_tree_selection(&mut v, "tree focused: row blue", look::SELECTION_BG.rgba());
    assert_eq!(status_text(&mut v), look::STATUS_BAR_TEXT.rgba());

    v.cx.deactivate_window();
    wait_tree_selection(
        &mut v,
        "app unfocused: the selected row in the Project tool window turns gray",
        look::SELECTION_BG_INACTIVE.rgba(),
    );
    v.wait_until("app unfocused: status bar text dimmed", |v| {
        status_text(v) == look::STATUS_BAR_TEXT_INACTIVE.rgba()
    });
    // (keys reach only an active window: the editor gets the keyboard first, then the app goes)
    v.cx.update(|window, _| window.activate_window());
    wait_tree_selection(&mut v, "active again: row blue", look::SELECTION_BG.rgba());
    v.focus_code();
    wait_target(&mut v, "split");
    v.wait_until("editor focused: its bar focused", editor_bar_focused);
    v.cx.deactivate_window();
    v.wait_until(
        "app unfocused: the active editor tab gray even with the editor focused",
        |v| !editor_bar_focused(v),
    );

    v.cx.update(|window, _| window.activate_window());
    v.wait_until(
        "app focused again: active editor tab blue, status bar bright",
        |v| editor_bar_focused(v) && status_text(v) == look::STATUS_BAR_TEXT.rgba(),
    );
    v.keystrokes("cmd-1");
    wait_target(&mut v, "tree");
    wait_tree_selection(
        &mut v,
        "app focused again: the selected row in the Project tool window blue",
        look::SELECTION_BG.rgba(),
    );

    // the bottom tool windows' selected tabs dim the same way
    v.keystrokes("cmd-t");
    wait_target(&mut v, "terminal");
    v.wait_until("Terminal active", term_header_active);
    v.cx.deactivate_window();
    v.wait_until("app unfocused: the Terminal's selected tab gray", |v| {
        !term_header_active(v)
    });
    v.cx.update(|window, _| window.activate_window());
    v.wait_until("app focused again: the Terminal's tab blue", |v| {
        term_header_active(v)
    });
    crate::common::gitui::open_git(&mut v);
    v.wait_until("Git active", git_header_active);
    v.cx.deactivate_window();
    v.wait_until("app unfocused: Git's selected tab gray", |v| {
        !git_header_active(v)
    });
    v.cx.update(|window, _| window.activate_window());
    v.wait_until("app focused again: Git's tab blue", git_header_active);
}

/// Mouse moves over the text (tooltips need them) never break a key sequence.
#[test]
fn mouse_moves_never_break_a_key_sequence() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    let splits = |v: &mut View| v.read_ws(|ws, cx| ws.tabs().read(cx).slots().len());
    let (r, c) = v.cell_of("line one");
    let a = v.cell_pos(r, c + 2);
    let b = v.cell_pos(r + 1, c + 4);

    v.key(",");
    v.cx.simulate_mouse_move(a, None, Modifiers::default());
    v.pump();
    v.cx.simulate_mouse_move(b, None, Modifiers::default());
    v.settle();
    v.key("v");
    v.wait_until("mouse move between , and v: the split still opens", |v| {
        splits(v) == 2
    });
    v.key(",");
    v.key("q");
    v.wait_until("split closed", |v| splits(v) == 1);

    v.keystrokes("g g 0 c i");
    v.cx.simulate_mouse_move(a, None, Modifiers::default());
    v.pump();
    v.cx.simulate_mouse_move(b, None, Modifiers::default());
    v.settle();
    v.keystrokes("w");
    v.key("shift+x");
    v.keystrokes("escape");
    v.wait_lua(
        "mouse move inside ciw: the word still changes",
        "return vim.fn.getline(1) == 'X one'",
    );
    v.keystrokes("u");
}

fn viewer(v: &mut View) -> Option<Viewer> {
    v.read_ws(|ws, cx| ws.diff().read(cx).viewer().cloned())
}

fn frame(v: &mut View) -> Frame {
    v.read_ws(|ws, cx| ws.diff().read(cx).frame(cx))
        .expect("a viewer is open")
}

/// The diff pane with nvim's keyboard: "old" (the HEAD side) or the current file's name.
fn pane(v: &View) -> String {
    v.lua(
        "return vim.api.nvim_buf_get_name(0):match('^gitdiff://') and 'old' or vim.fn.expand('%:t')",
    )
    .as_str()
    .unwrap_or_default()
    .to_owned()
}

/// A click on the diff toolbar's blank space keeps the focus in the diff pane; a
/// click on a change mark of the right pane's scrollbar strip (from the left pane) moves it there.
#[test]
fn diff_toolbar_and_scrollbar_mark_clicks_keep_pane_focus() {
    let fx = gitfix::fixture("grepo");
    let mut v = View::start(fx.repo.to_str().unwrap(), &["blame.ts"]);
    // WebStorm's window size: the toolbar has room for every dropdown and some blank space
    v.cx.simulate_resize(size(px(1388.), px(1081.)));
    v.settle();
    v.lua(
        "require('git.cli').find_root() local f = { path = 'diff.ts', status = 'M' } \
         require('git.diff').open({ f }, f, { old = 'HEAD' }) return true",
    );
    v.wait_until("diff chrome, 3 differences", |v| {
        viewer(v).is_some_and(|x| x.toolbar.differences == Some(3))
    });
    let f = frame(&mut v);
    let p = &f.panes[1];
    let first = p.rows.rows.first().expect("rows drawn").y;
    let text = point(px(p.grid_x.0 + 40.), px(first + 5.));
    press(&mut v, text, MouseButton::Left, Modifiers::default(), 1);
    v.wait_until("click in the current pane", |v| pane(v) == "diff.ts");

    // blank toolbar space: left of the count
    let count = bounds(&mut v, "diff-count").expect("count drawn");
    let toolbar = frame(&mut v).panes[0].rect.toolbar;
    let blank = point(count.left() - px(6.), count.center().y);
    assert!(
        toolbar.contains(&blank),
        "{blank:?} in the toolbar {toolbar:?}"
    );
    press(&mut v, blank, MouseButton::Left, Modifiers::default(), 1);
    v.settle();
    assert_eq!(
        (target(&v), pane(&v)),
        ("diff".to_owned(), "diff.ts".to_owned()),
        "click on blank toolbar space: focus stays in the diff viewer"
    );

    // the right pane's change marks (its scrollbar strip), clicked from the left pane
    let f = frame(&mut v);
    let old = &f.panes[0];
    let first = old.rows.rows.first().expect("rows drawn").y;
    let at_old = point(px(old.grid_x.0 + 40.), px(first + 5.));
    press(&mut v, at_old, MouseButton::Left, Modifiers::default(), 1);
    v.wait_until("click in the old pane", |v| pane(v) == "old");
    let f = frame(&mut v);
    let p = &f.panes[1];
    let x = viewer(&mut v).unwrap();
    let m = p.rect.marks;
    let rh = p.rows.row_height;
    let lines = (x.panes[1].lines.max(1) as f32).max(m.size.height.as_f32() / rh);
    // line 2 changed (as chrome.rs paints the marks: the whole file scaled to the strip)
    let y = m.top().as_f32() + (2. - 1.) / lines * m.size.height.as_f32() + 1.;
    let mark = point(m.right() - px(2. + look::DIFF_MARK_WIDTH / 2.), px(y));
    press(&mut v, mark, MouseButton::Left, Modifiers::default(), 1);
    v.wait_until(
        "click on a change mark in the scrollbar: focus goes to the pane under it",
        |v| pane(v) == "diff.ts",
    );
    assert_eq!(target(&v), "diff");
}

// One session over every surface ----------------------------------------------------------------

/// The error lines of `:messages` (`E<n>:`, `Error`, `stack traceback`) and error-level
/// notifications.
const ERROR_SCAN: &str = r#"
  local out = {}
  for _, l in ipairs(vim.split(vim.fn.execute('messages'), '\n')) do
    if l:match('E%d+:') or l:match('Error') or l:match('stack traceback') then out[#out + 1] = l end
  end
  local ok, hist = pcall(function() return Snacks.notifier.get_history() end)
  for _, n in ipairs(ok and hist or {}) do
    if n.level == 'error' or n.level == vim.log.levels.ERROR then out[#out + 1] = 'balloon: ' .. tostring(n.msg) end
  end
  return out"#;

fn errors(v: &View) -> Vec<String> {
    v.lua(ERROR_SCAN)
        .as_array()
        .map(|a| {
            a.iter()
                .map(|l| l.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn menu_open(v: &mut View) -> bool {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| p.menu_rows().is_some())
}

fn popups_closed(v: &mut View) -> bool {
    let p = v.read_ws(|ws, _| ws.popups().clone());
    v.pump();
    p.read_with(&v.cx, |p, _| !p.is_open())
}

/// A tour of the app's surfaces in one session leaves no error in `:messages` and no error
/// notification.
#[test]
fn a_tour_of_the_surfaces_leaves_no_lua_errors() {
    let mut v = View::start("proj", &["a.ts"]);
    wait_target(&mut v, "split");

    // the tree and back
    v.key("super+digit_1");
    wait_target(&mut v, "tree");
    v.focus_code();
    wait_target(&mut v, "split");

    // the context menu
    v.keystrokes("cmd-enter");
    v.wait_until("menu", menu_open);
    v.key("escape");
    v.wait_until("menu closed", popups_closed);

    // Search Everywhere, Go to File, Find in Files
    shift_shift(&mut v);
    wait_picker(&mut v, "Search Everywhere", |s| {
        s.as_ref().is_some_and(|s| s.kind == "all")
    });
    v.key("escape");
    wait_picker(&mut v, "closed", Option::is_none);
    v.key("super+o");
    wait_picker(&mut v, "Go to File", |s| {
        s.as_ref().is_some_and(|s| s.kind == "files")
    });
    v.key("escape");
    wait_picker(&mut v, "closed", Option::is_none);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", |s| {
        s.as_ref().is_some_and(|s| s.kind == "grep")
    });
    v.key("escape");
    wait_picker(&mut v, "closed", Option::is_none);

    // the switcher: Ctrl+Tab released at once
    edit(&mut v, "b.ts");
    v.modifiers(CTRL);
    v.key("ctrl+tab");
    v.modifiers(NONE);
    wait_picker(&mut v, "switcher closed", Option::is_none);
    v.wait_lua("previous file", "return vim.fn.expand('%:t') == 'a.ts'");

    // the Git tool window and back
    crate::common::gitui::open_git(&mut v);
    v.focus_code();
    wait_target(&mut v, "split");

    // the terminal and back
    open_terminal(&mut v);
    v.lua("require('config.app.terminal').hide() return true");
    v.wait_lua(
        "back in the editor",
        "return require('config.focus').target() == 'split'",
    );

    // a markdown file, vim.ui.input / select cancelled, a notification
    v.lua("vim.fn.writefile({ '# Title', '', 'text' }, 'tour.md') return true");
    edit(&mut v, "tour.md");
    v.settle();
    v.lua("vim.ui.input({ prompt = 'Name' }, function() end) return true");
    v.wait_until("input field", |v| {
        let p = v.read_ws(|ws, _| ws.popups().clone());
        p.read_with(&v.cx, |p, cx| p.input_state(cx)).is_some()
    });
    v.key("escape");
    v.wait_until("input closed", popups_closed);
    v.lua("vim.ui.select({ 'One', 'Two' }, {}, function() end) return true");
    v.wait_until("select menu", menu_open);
    v.key("escape");
    v.wait_until("select closed", popups_closed);
    v.lua("vim.notify('tour done', vim.log.levels.INFO) return true");
    edit(&mut v, "a.ts");
    v.settle();

    let errs = errors(&v);
    assert!(
        errs.is_empty(),
        "no errors in :messages (tour):\n{}",
        errs.join("\n")
    );
}
