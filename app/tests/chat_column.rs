//! The Chat column: the Editor's right island, full height, its width off nvim's screen; ⌘4 shows
//! it with the keyboard in its mode (again, with the keyboard: hides it), ⌃⌘← / ⌃⌘→ in Chat /
//! Terminal mode (never hiding it), × or ⌘⌥2 hides it, Esc gives the keyboard
//! back, its gap drags from 320 to the room left; Terminal mode is the session's Claude Code; the state is the
//! window's. The Factory view has a column of its own beside the Board. ⌘⇧D tears it out into a
//! window. Chat follows the selected card and the shown workspace. The transcript and the composer
//! draw from the bridge's trees: their places at 320 to 640 px, the scroll and the glides.
// GPUI records debug selectors (`debug_bounds`) only with debug assertions.
#![cfg(debug_assertions)]

use std::path::Path;
use std::time::Duration;

use gpui_kit::{InputHandler as _, Modifiers, MouseButton, VisualTestContext, point, px};
use serde_json::{Value, json};
use vimstorm::editor::EditorView;
use vimstorm::factory::{ChatTarget, FIRST_SCREEN, Slot};
use vimstorm::shell::{self, ColumnMode, ColumnState};
use vimstorm::shell::{
    CHAT_MAX_WIDTH, CHAT_MIN_WIDTH, CHAT_WIDTH, EDITOR_MIN_WIDTH, Frame, GAP, GapKind, Geometry,
    MARGIN, TREE_MIN_WIDTH,
};

use crate::common::bridge::{Win, fake_on, fixture, log, press, send, started};
use crate::common::chat::{
    board_has_keys, board_without_chat, chat_open_now, chat_opens, chat_session, column_active,
    factory, focus_frames, frame, native, on_board, repo, show_factory, state, target, torn,
    torn_cx, wait_target, with_chat_slot,
};
use crate::common::terminal::{self, wait_prompt, wait_typing};
use crate::common::view::View;
use crate::common::{self, table};

// The Editor's column, on the real window with real keys.

fn geometry(v: &mut View) -> std::rc::Rc<Geometry> {
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

fn shown(v: &mut View) -> bool {
    v.read(|e| e.geometry().layout.frame.chat.is_some())
}

fn wait_shown(v: &mut View, want: bool) {
    v.wait_for(
        if want {
            "the Chat column shown, grids fit"
        } else {
            "the Chat column hidden, grids fit"
        },
        |e| e.geometry().layout.frame.chat.is_some() == want && grids_fit(e),
    );
}

/// The column's × (it hides it; no key toggles it back).
fn hide(v: &mut View) {
    let hide = v.cx.debug_bounds("column-hide").expect("the × button");
    v.click(MouseButton::Left, hide.center());
    wait_shown(v, false);
}

fn chat_gap(v: &mut View) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    geometry(v)
        .layout
        .gaps
        .iter()
        .find(|g| g.kind == GapKind::Chat)
        .expect("the column's gap")
        .bounds
}

fn drag(v: &mut View, from: gpui_kit::Point<gpui_kit::Pixels>, by: f32) {
    let to = point(from.x + px(by), from.y);
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    v.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
}

/// A second project folder beside the fixtures, `b.ts` in it.
fn other_project(tmp: &Path) -> std::path::PathBuf {
    let other = tmp.canonicalize().unwrap().join("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("b.ts"), "export const b = 2;\n").unwrap();
    other
}

#[test]
fn the_column_is_a_right_island_at_its_width() {
    table(&[
        (
            "full height at the right, nvim's screen loses its width",
            island_full_height,
        ),
        ("its gap drags it from 320 to the room left", gap_drag_stops),
        (
            "a narrow window narrows it, the editor keeps its minimum",
            narrow_window,
        ),
        (
            "the app starts it shown and keeps a dragged width",
            app_start_width,
        ),
        (
            "the Factory view's column beside the Board",
            factory_view_column,
        ),
    ]);
}

fn island_full_height() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    assert!(!shown(&mut v), "a bare workspace starts without it");
    let before = geometry(&mut v);
    let cols = v.ui(|ui| ui.screen_size()).0;

    v.key("super+digit_4");
    wait_shown(&mut v, true);
    let g = geometry(&mut v);
    let chat = g.layout.frame.chat.unwrap();
    let full = before.layout.frame.inner;
    // 420 px, right of everything, from the strip to the status bar
    assert_eq!(chat.size.width, px(CHAT_WIDTH));
    assert_eq!(chat.right(), full.right());
    assert_eq!((chat.top(), chat.bottom()), (full.top(), full.bottom()));
    assert_eq!(g.layout.editor.right(), chat.left() - px(GAP.get()));
    // nvim's screen: the column's cells fewer
    let lost = ((CHAT_WIDTH + GAP) / g.metrics.cell_width.as_f32()) as usize;
    v.wait_until("nvim's screen narrower", |v| {
        v.ui(|ui| ui.screen_size()).0 + lost >= cols && v.ui(|ui| ui.screen_size()).0 < cols
    });
    // drawn: the header's toggle in Chat mode, the placeholder until the bridge's chat lands
    v.pump();
    assert!(v.cx.debug_bounds("chat-column").is_some());
    assert!(v.cx.debug_bounds("column-mode-Chat-selected").is_some());
    assert!(v.cx.debug_bounds("column-mode-Terminal").is_some());
    assert!(v.cx.debug_bounds("column-chat-placeholder").is_some());

    // the bottom pane (Git) sits left of it, under the tree and the editor
    v.lua("require('config.app.git').open() return true");
    v.wait_for("Git in the bottom pane", |e| {
        e.geometry().layout.bottom.is_some()
    });
    let g = geometry(&mut v);
    let bottom = g.layout.bottom.unwrap();
    assert!(
        bottom.right() <= chat.left() - px(GAP.get()),
        "{bottom:?} {chat:?}"
    );
    assert_eq!(
        g.layout.frame.chat,
        Some(chat),
        "the column keeps its full height"
    );
}

fn gap_drag_stops() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    wait_shown(&mut v, true);
    // 60 px to the left: 60 px wider
    let from = chat_gap(&mut v).center();
    drag(&mut v, from, -60.);
    v.wait_for("480 px, grids fit", |e| {
        e.geometry()
            .layout
            .frame
            .chat
            .is_some_and(|c| c.size.width == px(CHAT_WIDTH + 60.))
            && grids_fit(e)
    });
    // far left: as wide as the tree's and the editor's minimum leave it (under the cap in the 936 px
    // test window); far right: 320 (moves stay inside the window: the workspace hears them there)
    let most = Frame::chat_width_for(CHAT_MAX_WIDTH, common::view::WINDOW.0 - 2. * MARGIN);
    assert!(most < CHAT_MAX_WIDTH);
    let from = chat_gap(&mut v).center();
    drag(&mut v, from, 60. - from.x.as_f32());
    v.wait_until("the most the room allows", |v| state(v).width == most);
    let from = chat_gap(&mut v).center();
    drag(&mut v, from, common::view::WINDOW.0 - 10. - from.x.as_f32());
    v.wait_until("320", |v| state(v).width == CHAT_MIN_WIDTH);
    v.wait_for("grids fit", grids_fit);
}

/// The column dragged wide, the window made 800 px: the column gives way, the tree and the editor
/// keep their minimum; wide again, the dragged width comes back.
fn narrow_window() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    wait_shown(&mut v, true);
    v.cx.update(|_, cx| shell::set_column_state(cx, |s| s.width = 590.));
    v.cx.simulate_resize(gpui_kit::size(px(800.), px(700.)));
    v.wait_for("the column narrower, grids fit", |e| {
        e.geometry()
            .layout
            .frame
            .chat
            .is_some_and(|c| c.size.width < px(590.))
            && grids_fit(e)
    });
    let f = geometry(&mut v).layout.frame;
    let (tl, tr) = f.tree_x.expect("the tree open");
    assert!(tr - tl >= TREE_MIN_WIDTH, "{f:?}");
    assert!(f.editor_x.1 - f.editor_x.0 >= EDITOR_MIN_WIDTH, "{f:?}");
    assert_eq!(state(&mut v).width, 590., "the dragged width is kept");
    // dragged there, it moves from the width on screen (no dead zone back to the 590)
    let on_screen = f.chat.unwrap().size.width;
    let from = chat_gap(&mut v).center();
    drag(&mut v, from, 10.);
    v.wait_for("10 px narrower", |e| {
        e.geometry()
            .layout
            .frame
            .chat
            .is_some_and(|c| c.size.width == on_screen - px(10.))
    });
    v.cx.update(|_, cx| shell::set_column_state(cx, |s| s.width = 590.));
    v.cx.simulate_resize(gpui_kit::size(px(1400.), px(700.)));
    v.wait_for("590 px again", |e| {
        e.geometry()
            .layout
            .frame
            .chat
            .is_some_and(|c| c.size.width == px(590.))
            && grids_fit(e)
    });
}

fn app_start_width() {
    let mut v = View::start_projects_app_column("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    let ws = v.active_project();
    v.use_project(&ws);
    // shown by default (the test window is wider than 900 px), in Chat mode, docked
    wait_shown(&mut v, true);
    let s = state(&mut v);
    assert!(s.open && s.torn.is_none() && s.mode == ColumnMode::Chat);
    assert_eq!(s.width, CHAT_WIDTH);
    // a drag keeps the width in the app's state dir for the next launch
    let from = chat_gap(&mut v).center();
    drag(&mut v, from, -80.);
    let home = v.state_home();
    v.wait_until("the width kept", |_| {
        shell::load_width(Some(&home)) == Some(CHAT_WIDTH + 80.)
    });
    assert_eq!(
        ColumnState::at_start(1440., Some(&home)).width,
        CHAT_WIDTH + 80.
    );
    // ⌘4 from the code: the keyboard (it was shown); a projects window takes the key first;
    // again (it has the keyboard): hidden, the keyboard back to the code; ⌘4 shows it again
    v.key("super+digit_4");
    v.wait_until("Chat has the keyboard", |v| native(v) == Some("chat"));
    v.key("super+digit_4");
    wait_shown(&mut v, false);
    v.wait_until("the keyboard back to the code", |v| native(v).is_none());
    v.key("super+digit_4");
    wait_shown(&mut v, true);
    v.wait_until("Chat has the keyboard again", |v| native(v) == Some("chat"));
    assert_eq!(state(&mut v).width, CHAT_WIDTH + 80., "its width kept");
    hide(&mut v);
    assert!(target(&v) == "split" || target(&v) == "other");
}

/// In the Factory view the column is full height at the right, the Board and its bottom pane left
/// of it; its gap drags it; ⌘4 shows it and ⌘⌥2 hides it apart from the Editor's, and on Chat while the
/// Editor's is on Terminal.
fn factory_view_column() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    let projects = v.projects.clone().unwrap();
    v.key("super+alt+a");
    v.wait_until("the Factory view with its column", |v| {
        v.pump();
        projects.read_with(&v.cx, |p, _| p.factory_shown())
            && v.cx.debug_bounds("factory-chat-column").is_some()
    });
    let viewport = v.cx.update(|window, _| window.viewport_size());
    let col = v.cx.debug_bounds("factory-chat-column").unwrap();
    let (vw, vh) = (f32::from(viewport.width), f32::from(viewport.height));
    // full height from the header's row to the status bar, at the right, 420 wide
    assert!(
        (f32::from(col.right()) - (vw - MARGIN)).abs() < 1.,
        "{col:?} in {vw}"
    );
    assert_eq!(f32::from(col.top()), 30. + vimstorm::look::TAB_HEIGHT);
    let status = v.cx.debug_bounds("status-bar").expect("the status bar");
    assert!(
        (f32::from(status.top() - col.bottom()) - MARGIN).abs() < 1.,
        "{col:?} over {status:?} in {vh}"
    );
    assert!((f32::from(col.size.width) - 420.).abs() < 1., "{col:?}");
    // the Board left of it: the bridge hears the narrower view
    let board = projects
        .read_with(&v.cx, |p, cx| p.factory().map(|f| f.read(cx).chrome_width))
        .unwrap();
    assert!(board > 420., "the Board loses the column's room: {board}");

    // Boxes (its tile: the Factory view's pane filling the middle) stops left of the column
    v.click_place("boxes");
    v.wait_until("the Boxes tile's pane", |v| {
        v.pump();
        v.cx.debug_bounds("factory-pane-place").is_some()
    });
    let pane = v.cx.debug_bounds("factory-pane-place").unwrap();
    let col = v.cx.debug_bounds("factory-chat-column").unwrap();
    assert!(pane.right() < col.left(), "{pane:?} beside {col:?}");
    // ⌘↑ among the places: Boxes to the Board
    v.key("super+arrow_up");
    v.wait_until("the Board again", |v| {
        v.pump();
        v.cx.debug_bounds("factory-pane-place").is_none()
    });

    // its left gap drags its width, as the Editor's (the Editor under the view takes no drag)
    let gap = v.cx.debug_bounds("factory-column-gap").expect("its gap");
    assert!(
        gap.left() < col.left() && col.left() < gap.right(),
        "{gap:?} {col:?}"
    );
    drag(&mut v, gap.center(), -40.);
    v.wait_until("40 px wider", |v| {
        v.pump();
        v.cx.debug_bounds("factory-chat-column")
            .is_some_and(|c| (f32::from(c.size.width) - 460.).abs() < 1.)
    });
    v.cx.update(|_, cx| shell::set_column_state(cx, |s| s.width = 420.));
    v.pump();

    // ⌘4 the Factory view's own column with the keys, ⌘⌥2 hides it (the Board's tile's Chat; the
    // rail's move gave it the keys: Esc gives them to the Board first)
    v.key("escape");
    v.wait_until("the Board has the keys", board_has_keys);
    v.key("super+digit_4");
    v.wait_until("⌘4: the column has the keys", |v| !board_has_keys(v));
    v.key("super+alt+digit_2");
    v.wait_until("hidden in the Factory view", |v| !state(v).factory_open);
    v.wait_until("not drawn", |v| {
        v.pump();
        v.cx.debug_bounds("factory-chat-column").is_none()
    });
    let wide = projects
        .read_with(&v.cx, |p, cx| p.factory().map(|f| f.read(cx).chrome_width))
        .unwrap();
    // the Board full width but the rail's
    assert_eq!(
        wide,
        vimstorm::shell::projects::RAIL_WIDTH,
        "the Board full width"
    );
    v.key("super+digit_4");
    v.wait_until("shown again", |v| state(v).factory_open);
    // the Editor again: its column as it was
    v.key("super+alt+a");
    v.wait_until("the Editor", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    let s = state(&mut v);
    assert!(s.open && s.factory_open && !s.factory_shown, "{s:?}");

    // the workspace's Chat in Claude Code (⌘4, then ⌃⌘→: back on the code the keys land where
    // they were, the code's): the Board's still on Chat, and back in the workspace Claude Code
    // again (each tile its own)
    v.key("super+digit_4");
    v.wait_until("⌘4: Chat has the keys", |v| native(v) == Some("chat"));
    v.key("super+ctrl+arrow_right");
    v.wait_until("Claude Code in the workspace", |v| {
        state(v).mode == ColumnMode::Terminal
    });
    v.key("super+alt+a");
    v.wait_until("the Factory view's column on Chat", |v| {
        v.pump();
        v.cx.debug_bounds("factory-chat-column").is_some()
            && v.cx.debug_bounds("column-chat").is_some()
    });
    v.key("super+alt+a");
    v.wait_until("Claude Code again in the workspace", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
            && state(v).mode == ColumnMode::Terminal
    });
}

#[test]
fn cmd_4_ctrl_cmd_arrows_and_esc_show_the_editors_column_with_the_keys() {
    table(&[
        (
            "⌘4 shows, focuses, hides; ⌃⌘← ⌃⌘→ never hide, Esc keeps it shown",
            cycle,
        ),
        ("the toggle switches modes", toggle),
        (
            "the chat slot's keys reach it, the window's keys stay",
            slot_keys,
        ),
        (
            "Esc before the chat screen is drawn gives the keys back",
            esc_before_drawn,
        ),
        (
            "a hidden workspace's terminal leaves the column alone",
            hidden_workspace_terminal,
        ),
        (
            "back on a workspace with it hidden, the keys go to its editor",
            back_on_hidden,
        ),
        (
            "Terminal mode draws Chat's session attached, no shell",
            terminal_mode_attach,
        ),
        (
            "on Code ⌃⌘← ⌃⌘→ are the tabs of the pane with the keys, in Chat its modes",
            arrows_follow_the_keys,
        ),
    ]);
}

/// ⌃⌘← / ⌃⌘→ act on the pane with the keys: the editor's open files, the Terminal's shells;
/// Chat / Claude Code only with the keys in Chat (the column left alone meanwhile).
fn arrows_follow_the_keys() {
    let mut v = View::start("proj", &["a.ts", "b.ts"]);
    v.wait_screen("export const a = 1");
    let untouched = |v: &mut View| {
        let s = state(v);
        !s.open && s.mode == ColumnMode::Chat
    };
    // the editor: a.ts and b.ts open, on b.ts; ⌃⌘→ the next file (round to a.ts), ⌃⌘← back
    common::pickers::edit(&mut v, "b.ts");
    v.key("super+ctrl+arrow_right");
    common::pickers::wait_file(&mut v, "a.ts");
    v.key("super+ctrl+arrow_left");
    common::pickers::wait_file(&mut v, "b.ts");
    assert!(untouched(&mut v), "{:?}", state(&mut v));
    // the Terminal: two shells, on the second; ⌃⌘→ the next shell (round to the first), ⌃⌘← back
    v.key("super+t");
    wait_typing(&mut v);
    wait_prompt(&mut v);
    v.keystrokes("cmd-shift-t");
    v.wait_until("two shells, on the second", |v| {
        terminal::tab_names(v) == "Local,Local (2)"
            && terminal::selected(v) == "Local (2)"
            && terminal::typing(v)
    });
    wait_prompt(&mut v);
    v.key("super+ctrl+arrow_right");
    v.wait_until("⌃⌘→: the next shell", |v| {
        terminal::selected(v) == "Local" && terminal::typing(v)
    });
    v.key("super+ctrl+arrow_left");
    v.wait_until("⌃⌘←: the shell before", |v| {
        terminal::selected(v) == "Local (2)" && terminal::typing(v)
    });
    assert!(untouched(&mut v), "{:?}", state(&mut v));
    // Chat with the keys: ⌃⌘→ Claude Code, ⌃⌘← Chat, the keys staying in the column
    v.key("super+digit_4");
    v.wait_until("Chat has the keys", |v| native(v) == Some("chat"));
    v.key("super+ctrl+arrow_right");
    v.wait_until("⌃⌘→ in Chat: Claude Code with the keys", |v| {
        native(v) == Some("chat") && state(v).shows(ColumnMode::Terminal)
    });
    v.key("super+ctrl+arrow_left");
    v.wait_until("⌃⌘← in Claude Code: Chat with the keys", |v| {
        native(v) == Some("chat") && state(v).mode == ColumnMode::Chat
    });
    assert_eq!(
        terminal::selected(&mut v),
        "Local (2)",
        "the shells left alone"
    );
}

fn cycle() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");

    // hidden: shown in Chat with the keyboard
    v.key("super+digit_4");
    wait_shown(&mut v, true);
    v.wait_until("Chat has the keyboard", |v| native(v) == Some("chat"));
    assert_eq!(state(&mut v).mode, ColumnMode::Chat);
    // Esc: the keyboard back to the code, the column stays
    v.key("escape");
    wait_target(&mut v, "split");
    assert!(shown(&mut v));
    // shown without the keyboard: the keyboard
    v.key("super+digit_4");
    v.wait_until("Chat has the keyboard again", |v| native(v) == Some("chat"));
    // with the keyboard: hidden, the keyboard back to the code (where it was before)
    v.key("super+digit_4");
    wait_shown(&mut v, false);
    wait_target(&mut v, "split");

    // View › Claude Code (from the code, where ⌃⌘→ is the next file): shown in Terminal mode (the
    // session's Claude Code) with the keyboard; no shell
    let tabs = |v: &mut View| v.read_ws(|ws, cx| ws.terminal().read(cx).tab_names()).len();
    let terminal_mode =
        |v: &mut View| native(v) == Some("chat") && state(v).shows(ColumnMode::Terminal);
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    v.cx.update(|w, cx| w.dispatch_action(Box::new(vimstorm::app::Replay("ctrl-cmd-right")), cx));
    wait_shown(&mut v, true);
    v.wait_until("Terminal mode with the keyboard", terminal_mode);
    v.pump();
    assert!(v.cx.debug_bounds("column-mode-Terminal-selected").is_some());
    assert!(
        v.cx.debug_bounds("terminal-view").is_none(),
        "no shell in the column"
    );
    assert_eq!(tabs(&mut v), 0);
    // Terminal shown: ⌃⌘← switches to Chat (the same column, the keyboard there)
    v.key("super+ctrl+arrow_left");
    v.wait_until("Chat mode with the keyboard", |v| {
        native(v) == Some("chat") && state(v).mode == ColumnMode::Chat
    });
    // ⌘T: the bottom pane's Terminal, never the column (it stays shown, on Chat)
    v.key("super+t");
    wait_typing(&mut v);
    wait_prompt(&mut v);
    assert_eq!(tabs(&mut v), 1);
    let term =
        v.cx.debug_bounds("terminal-view")
            .expect("the terminal drawn");
    let chat = geometry(&mut v).layout.frame.chat.unwrap();
    assert!(!chat.contains(&term.center()), "outside the column");
    assert!(shown(&mut v));
    assert_eq!(state(&mut v).mode, ColumnMode::Chat);
    // ⌘4 then ⌃⌘→ twice (in the Terminal ⌃⌘→ is its next shell): Terminal mode with the
    // keyboard, and it stays
    v.key("super+digit_4");
    v.key("super+ctrl+arrow_right");
    v.wait_until("Terminal mode with the keyboard", terminal_mode);
    v.key("super+ctrl+arrow_right");
    v.settle();
    assert!(terminal_mode(&mut v));
    // ⌘4 with the keyboard: hidden; again: the mode it was in (Terminal), with the keyboard
    v.key("super+digit_4");
    wait_shown(&mut v, false);
    v.key("super+digit_4");
    v.wait_until("⌘4: Terminal mode again", terminal_mode);
    hide(&mut v);
    // the shells keep running in the bottom pane
    assert_eq!(tabs(&mut v), 1);
}

fn toggle() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    wait_shown(&mut v, true);
    // a click on Terminal: Terminal mode with the keyboard
    let seg = v.cx.debug_bounds("column-mode-Terminal").unwrap();
    v.click(MouseButton::Left, seg.center());
    v.wait_until("Terminal mode with the keyboard", |v| {
        native(v) == Some("chat") && state(v).mode == ColumnMode::Terminal
    });
    // a click on Chat: Chat mode
    let seg = v.cx.debug_bounds("column-mode-Chat").unwrap();
    v.click(MouseButton::Left, seg.center());
    v.wait_until("Chat mode", |v| state(v).mode == ColumnMode::Chat);
    v.pump();
    assert!(
        v.cx.debug_bounds("terminal-view").is_none(),
        "no shell drawn in either mode"
    );
}

fn slot_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = with_chat_slot(dir.path());
    // the column (shown by default) draws the bridge's chat slot in Chat mode
    v.wait_until("the chat slot drawn in the column", |v| {
        v.pump();
        let column = v.read(|e| e.geometry().layout.frame.chat);
        let node = v.cx.debug_bounds("factory-node-chat:launch");
        column
            .zip(node)
            .is_some_and(|(c, n)| c.contains(&n.center()))
    });
    assert!(v.cx.debug_bounds("column-chat-placeholder").is_none());
    // ⌘4: the keyboard in the slot; its keys go to the bridge as `slot: chat`
    v.key("super+digit_4");
    v.wait_until("the slot has the keyboard", |v| native(v) == Some("chat"));
    v.key("enter");
    v.wait_until("⏎ reached the chat slot", |_| {
        log(dir.path()).iter().any(|l| {
            l.contains(r#""type":"input""#)
                && l.contains(r#""key":"<CR>""#)
                && l.contains(r#""slot":"chat""#)
        })
    });
    // the window's keys don't: ⌘1 is the tree's, ⌘2 the open file's, ⌘4 the column's
    v.key("super+digit_1");
    wait_target(&mut v, "tree");
    v.key("super+digit_4");
    v.wait_until("the slot has the keyboard again", |v| {
        native(v) == Some("chat")
    });
    v.key("super+digit_2");
    wait_target(&mut v, "split");
    v.key("super+digit_4");
    v.wait_until("Chat again with the keyboard", |v| {
        native(v) == Some("chat")
    });
    assert!(
        !log(dir.path()).iter().any(|l| {
            l.contains(r#""key":"<D-2>""#)
                || l.contains(r#""key":"<D-1>""#)
                || l.contains(r#""key":"<D-4>""#)
        }),
        "neither ⌘1, ⌘2 nor ⌘4 reached the bridge"
    );
    // nor ⌘5 or ⌥⌘⏎
    let inputs = |dir: &Path| {
        log(dir)
            .iter()
            .filter(|l| l.contains(r#""type":"input""#))
            .count()
    };
    let before = inputs(dir.path());
    v.key("super+digit_5");
    v.key("super+alt+enter");
    v.settle();
    assert_eq!(inputs(dir.path()), before, "⌘5 / ⌥⌘⏎ reached the bridge");
}

fn esc_before_drawn() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = View::start_projects_app_column("proj", &["a.ts"]);
    let projects = v.projects.clone().unwrap();
    // a bridge that never draws the chat screen
    v.cx.update(|_, cx| cx.set_global(fake_on(dir.path(), &["frames/bridge-tree.json"], &[])));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    v.wait_until("the slot has the keyboard", |v| native(v) == Some("chat"));
    v.key("escape");
    wait_target(&mut v, "split");
    assert!(shown(&mut v), "Esc keeps the column");
}

fn hidden_workspace_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let other = other_project(tmp.path());
    let mut v = View::start_projects("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    let a = v.active_project();
    // another project, then back: it runs hidden
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        other.display()
    ));
    v.wait_until("other shown", |v| v.active_project() != a);
    let b = v.active_project();
    v.use_project(&b);
    v.wait_lua("nvim started", common::STARTED);
    let a_dir = a.read_with(&v.cx, |ws, _| ws.project().clone());
    v.cx.update(|window, cx| vimstorm::shell::projects::switch_to(a_dir, window, cx));
    v.wait_until("a shown again", |v| v.active_project() == a);
    assert!(!state(&mut v).open, "the column starts hidden here");
    // the hidden project's terminal opens (its Lua asks, as ⌘T there would): the shown column
    // stays as it was
    let rpc = b.read_with(&v.cx, |ws, _| ws.rpc().clone());
    vimstorm::nvim::lua::call(&rpc, "config.app.terminal", "show", Vec::new());
    v.wait_until("b's shell runs", |v| {
        b.read_with(&v.cx, |ws, cx| {
            !ws.terminal().read(cx).tab_names().is_empty()
        })
    });
    v.settle();
    let s = state(&mut v);
    assert!(!s.open && s.mode == ColumnMode::Chat, "{s:?}");
    v.use_project(&a);
    assert_eq!(native(&mut v), None, "the keyboard stays in a's editor");
}

fn back_on_hidden() {
    let tmp = tempfile::tempdir().unwrap();
    let other = other_project(tmp.path());
    let mut v = View::start_projects("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    let a = v.active_project();
    // A: Terminal mode with the keyboard (⌘4 first: from the code ⌃⌘→ is the next file)
    v.key("super+digit_4");
    v.key("super+ctrl+arrow_right");
    v.wait_until("A's column has the keys", |v| {
        state(v).shows(ColumnMode::Terminal) && native(v) == Some("chat")
    });
    // B shown, the column hidden there (window-wide)
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        other.display()
    ));
    v.wait_until("B shown", |v| v.active_project() != a);
    let b = v.active_project();
    v.use_project(&b);
    v.wait_lua("nvim started", common::STARTED);
    v.cx.update(|_, cx| {
        shell::set_column_state(cx, |s| {
            s.open = false;
            s.mode = ColumnMode::Chat;
        })
    });
    let a_dir = a.read_with(&v.cx, |ws, _| ws.project().clone());
    v.cx.update(|window, cx| vimstorm::shell::projects::switch_to(a_dir, window, cx));
    v.wait_until("A shown again", |v| v.active_project() == a);
    v.use_project(&a);
    assert!(!state(&mut v).shown());
    // A's column isn't drawn: its editor has the keys
    v.settle();
    assert_eq!(native(&mut v), None, "the keyboard in A's editor");
}

/// The bridge's own `abe` for Terminal mode's attach: `abe session attach <id>` and `abe box
/// attach …` say what they attach and then echo what is typed (`cat`); anything else is the fake
/// bridge.
fn fake_attach(base: &Path, bridge: &Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let path = base.join("fake-abe.sh");
    std::fs::write(
        &path,
        format!(
            "#!/bin/bash\ncase \"$1\" in session|box) echo \"attached: $*\"; exec cat ;; esac\nexec {} \"$@\"\n",
            bridge.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The `chat` screen in Terminal mode on `session`: its attach.
fn attach_tree(dir: &Path, session: &str) -> std::path::PathBuf {
    frame(
        dir,
        &format!("chat-attach-{session}.json"),
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "slot": "chat", "tree": {
            "kind": "Island", "id": "chat", "props": {},
            "children": [{"kind": "Terminal", "id": "chat-terminal", "props": {
                "key": format!("attach:{session}:0"),
                "argv": ["abe", "session", "attach", session],
                "focused": false,
            }}],
        }}),
    )
}

fn terminal_mode_attach() {
    use crate::common::terminal::read;
    use vimstorm::factory::UserInput;
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(
        &base,
        vec![
            // Chat pinned to s4 on every open; in Terminal mode the screen attaches it
            (
                r#""type":"open","v":2,"screen":"chat""#,
                vec![chat_session(&base, Some("s4"))],
            ),
            (r#""mode":"terminal""#, vec![attach_tree(&base, "s4")]),
            // a Retry: Chat on its new session at once
            (
                r#""key":"<F20>""#,
                vec![chat_session(&base, Some("s9")), attach_tree(&base, "s9")],
            ),
        ],
    );
    v.cx.update(|_, cx| {
        let mut command = cx.global::<vimstorm::factory::BridgeCommand>().clone();
        command.program = fake_attach(&base, &command.program);
        cx.set_global(command);
    });
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));

    // ⌘4, ⌃⌘→: the column's Terminal mode is the chat screen's attach, drawn in the column; no
    // shell
    v.key("super+digit_4");
    v.key("super+ctrl+arrow_right");
    v.wait_until("Terminal mode: the session attached in the column", |v| {
        state(v).mode == ColumnMode::Terminal
            && chat_open_now(v, &base)
            && v.cx.debug_bounds("factory-terminal-attach:s4:0").is_some()
    });
    assert!(v.cx.debug_bounds("column-mode-Terminal-selected").is_some());
    assert!(read(&mut v, |t, _| t.tab_names().is_empty()), "no shell");
    assert!(
        v.cx.debug_bounds("terminal-view").is_none(),
        "no Terminal drawn"
    );

    // a Retry's new session: the attach follows it
    let factory = factory(&mut v);
    v.cx.update(|_, cx| {
        factory.update(cx, |f, cx| {
            f.send_slot_input(
                Slot::Chat,
                UserInput::Key {
                    key: "<F20>".into(),
                },
                cx,
            )
        })
    });
    v.wait_until("the attach on the new session", |v| {
        v.pump();
        v.cx.debug_bounds("factory-terminal-attach:s9:0").is_some()
    });
    assert!(
        read(&mut v, |t, _| t.tab_names().is_empty()),
        "still no shell"
    );
}

#[test]
fn in_the_factory_view_the_column_and_the_board_trade_the_keys() {
    table(&[
        (
            "a click on a card gives the Board the keys back",
            click_card,
        ),
        (
            "⌘4 lights the column, Esc gives the Board its look back",
            cmd_4_lights,
        ),
        (
            "⌃⌘→ and the Terminal tab attach the card's session, ⌘1 is the Board's list",
            factory_terminal_mode,
        ),
    ]);
}

fn click_card() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    board_without_chat(&mut v);
    // a launch: Chat on its card with the keys (a stray ⏎ there answers its question)
    v.key("enter");
    v.wait_until("Chat has the keys", |v| {
        v.pump();
        v.cx.debug_bounds("factory-chat-column").is_some() && !board_has_keys(v)
    });
    let card = v.cx.debug_bounds("factory-node-card:1251").unwrap();
    v.click(MouseButton::Left, card.center());
    v.wait_until("the card clicked and the Board has the keys", |v| {
        board_has_keys(v)
            && log(&base)
                .iter()
                .any(|l| l.contains(r#""kind":"click","id":"card:1251""#))
    });
}

/// Exactly one island looks as having the keys; after ⌘4 that is the Chat column.
fn cmd_4_lights() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    // the rail's move to the Board: the column has the keys and looks it
    show_factory(&mut v);
    v.wait_until("the column has the keys and looks it", |v| {
        !board_has_keys(v) && column_active(v)
    });
    v.wait_until("the bridge told the chat slot has them", |v| {
        v.pump();
        focus_frames(&base)
            .last()
            .is_some_and(|l| l.contains(r#""slot":"chat""#))
    });
    v.key("escape");
    v.wait_until("the Board has the keys", board_has_keys);
    assert!(
        !column_active(&mut v),
        "the column looks inactive beside the Board"
    );
    v.key("super+4");
    v.wait_until("⌘4: the column has the keys and looks it again", |v| {
        !board_has_keys(v) && column_active(v)
    });
}

fn factory_terminal_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    // the chat screen in Terminal mode: the session attached, a Terminal in its tree
    let attached = frame(
        &base,
        "chat-attached.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "slot": "chat", "tree": {
            "kind": "Island", "id": "chat", "props": {},
            "children": [{"kind": "Terminal", "id": "chat-terminal", "props": {
                "key": "attach:s5:0", "argv": ["/bin/sh", "-c", "echo attached; sleep 60"],
                "focused": true,
            }}],
        }}),
    );
    let mut v = on_board(&base, vec![(r#""mode":"terminal""#, vec![attached])]);
    let projects = v.projects.clone().unwrap();
    v.key("super+alt+a");
    v.wait_until("the Factory view's Chat open", |v| {
        v.pump();
        !chat_opens(&base).is_empty()
    });
    // (the rail's move gave Chat the keys: Esc gives them to the Board)
    v.key("escape");
    v.wait_until("the Board has the keys", board_has_keys);
    let factory = factory(&mut v);
    v.key("ö");
    v.wait_until("card 5 selected", |v| {
        v.pump();
        factory.read_with(&v.cx, |f, _| f.selected()) == Some(5)
    });
    v.cx.executor().advance_clock(vimstorm::factory::CARD_REST);
    v.wait_until("Chat on card 5", |v| chat_open_now(v, &base));

    // ⌃⌘→: the column in Terminal mode, the chat screen told, its Terminal drawn with the keys
    v.key("super+ctrl+arrow_right");
    v.wait_until("the session attached in the column", |v| {
        state(v).mode_now() == ColumnMode::Terminal
            && chat_open_now(v, &base)
            && v.cx.debug_bounds("factory-terminal-attach:s5:0").is_some()
    });
    assert!(
        v.cx.debug_bounds("column-mode-Terminal-selected").is_some(),
        "the toggle on Terminal"
    );
    assert!(
        v.cx.debug_bounds("factory-chat-column").is_some(),
        "in the Factory view's column"
    );
    let has_keys = |v: &mut View, mode| {
        v.pump();
        let ws = v.active_project();
        v.cx.update(|window, cx| ws.read(cx).column().read(cx).has_keyboard(mode, window, cx))
    };
    v.wait_until("Terminal mode has the keys", |v| {
        has_keys(v, ColumnMode::Terminal)
    });
    // ⌃⌘←: back to Chat, the screen told
    v.key("super+ctrl+arrow_left");
    v.wait_until("Chat mode again", |v| {
        state(v).mode_now() == ColumnMode::Chat && chat_open_now(v, &base)
    });

    // a click on the Terminal tab: Terminal mode again
    v.pump();
    let seg = v.cx.debug_bounds("column-mode-Terminal").unwrap();
    v.click(MouseButton::Left, seg.center());
    v.wait_until("Terminal mode from the tab", |v| {
        state(v).mode_now() == ColumnMode::Terminal && chat_open_now(v, &base)
    });

    // ⌘1 on the Board: its list (the Board) with the keys, the page stays
    v.key("super+digit_1");
    v.wait_until("the Board has the keys", board_has_keys);
    assert!(projects.read_with(&v.cx, |p, _| p.factory_shown()));
    // ⌘⌥A: the Editor
    v.key("super+alt+a");
    v.wait_until("the Editor", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    // the Editor's column stays on Chat; the Factory view's comes back on Terminal
    assert_eq!(state(&mut v).mode, ColumnMode::Chat);
    v.key("super+alt+a");
    v.wait_until("the Factory view on Terminal mode", |v| {
        v.pump();
        projects.read_with(&v.cx, |p, _| p.factory_shown())
            && v.cx.debug_bounds("column-mode-Terminal-selected").is_some()
    });
}

// The torn window (⌘⇧D).

fn editor_right(v: &mut View) -> gpui_kit::Pixels {
    v.read(|e| e.geometry().layout.editor.right())
}

fn wait_docked(v: &mut View) {
    v.wait_until("docked on the right again", |v| {
        torn(v).is_none() && v.read(|e| e.geometry().layout.frame.chat.is_some())
    });
}

#[test]
fn cmd_shift_d_tears_the_column_out_into_a_window_and_docks_it_again() {
    table(&[
        (
            "⌘⇧D tears it out, ⌃⌘← / ⌃⌘→ there, ⌘⇧D docks it",
            tear_and_dock,
        ),
        (
            "closing the window docks it and it comes back where it was",
            close_docks,
        ),
        ("× there hides it and closes the window", hiding_closes),
        (
            "the torn Chat has the keys by the torn window's focus",
            torn_focus,
        ),
        ("⌥⌘⏎ does nothing there and ⌃⌥L jumps", torn_window_keys),
    ]);
}

fn tear_and_dock() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    v.wait_for("the column shown", |e| {
        e.geometry().layout.frame.chat.is_some()
    });
    let docked = editor_right(&mut v);
    let inner = v.read(|e| e.geometry().layout.frame.inner);
    assert_eq!(v.cx.windows().len(), 1);

    // ⌘⇧D in the main window: a window of its own, the editor widens to the window's edge
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    v.wait_for("the main window has the room back", |e| {
        e.geometry().layout.frame.chat.is_none()
    });
    assert!(editor_right(&mut v) > docked + px(400.));
    assert!(v.read(|e| e.geometry().layout.frame.inner.right()) > inner.right());
    assert_eq!(v.cx.windows().len(), 2);
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    assert!(tcx.debug_bounds("torn-chat").is_some());
    assert!(tcx.debug_bounds("chat-column").is_some());
    assert!(tcx.debug_bounds("column-chat-placeholder").is_some());
    assert!(tcx.debug_bounds("torn-chat-footer").is_some());
    // the column's width
    let b = tcx.update(|w, _| w.bounds());
    assert_eq!(b.size.width, px(state(&mut v).width));
    // its title names the workspace
    let project = v.ws.read_with(&v.cx, |ws, _| ws.project().clone());
    let title = v.cx.update(|_, cx| shell::torn_title(&project, cx));
    assert!(title.starts_with("Chat · "), "{title}");

    // ⌃⌘→ there: Terminal mode in the torn window (the session's Claude Code: no shell anywhere)
    tcx.simulate_keystrokes("ctrl-cmd-right");
    v.wait_until("Terminal mode", |v| state(v).mode == ColumnMode::Terminal);
    tcx.run_until_parked();
    assert!(tcx.debug_bounds("column-mode-Terminal-selected").is_some());
    assert!(
        tcx.debug_bounds("terminal-view").is_none(),
        "no shell in the column"
    );
    // ⌃⌘← there: Chat mode
    tcx.simulate_keystrokes("ctrl-cmd-left");
    v.wait_until("Chat mode", |v| state(v).mode == ColumnMode::Chat);

    // ⌘⇧D in the torn window: docked again, the window gone
    tcx.simulate_keystrokes("cmd-shift-d");
    wait_docked(&mut v);
    v.wait_until("one window", |v| v.cx.windows().len() == 1);
    assert_eq!(editor_right(&mut v), docked);
}

fn close_docks() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    let first = tcx.update(|w, _| w.bounds());
    // the window's close button: docked
    assert!(tcx.simulate_close(), "it may close");
    tcx.update(|w, _| w.remove_window());
    wait_docked(&mut v);
    assert_eq!(
        state(&mut v).torn_bounds,
        Some(first),
        "its place remembered"
    );
    // ⌘⇧D again from the main window: torn out where it was
    v.key("super+shift+d");
    v.wait_until("torn out again", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    assert_eq!(tcx.update(|w, _| w.bounds()), first);
    // ⌘⇧D in the main window docks it too
    v.key("super+shift+d");
    wait_docked(&mut v);
    v.wait_until("one window", |v| v.cx.windows().len() == 1);
}

fn hiding_closes() {
    let mut v = View::start("proj", &["a.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    // the torn window has the keyboard on Chat: × there hides the column, the window closes
    let hide = tcx.debug_bounds("column-hide").expect("the × button");
    tcx.simulate_click(hide.center(), gpui_kit::Modifiers::default());
    v.wait_until("hidden and docked", |v| {
        let s = state(v);
        !s.open && s.torn.is_none()
    });
    v.wait_until("one window", |v| v.cx.windows().len() == 1);
    v.wait_for("no column", |e| e.geometry().layout.frame.chat.is_none());
}

/// The torn Chat looks as having the keys (its header blue, the bridge told `chat`) exactly
/// while the torn window's own focus is in it: its Terminal mode too, the main window in front.
fn torn_focus() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().to_path_buf();
    let mut v = with_chat_slot(&base);
    let factory = factory(&mut v);
    let column = v
        .active_project()
        .read_with(&v.cx, |ws, _| ws.column().clone());
    let told_chat = |v: &mut View| {
        v.pump();
        let slot = factory.read_with(&v.cx, |f, _| f.focused_slot());
        let frame = log(&base)
            .into_iter()
            .rfind(|l| l.contains(r#""type":"focus""#))
            .is_some_and(|l| l.contains(r#""slot":"chat""#));
        (slot == Some(Slot::Chat), frame)
    };
    // the docked Chat has the keys
    v.key("super+digit_4");
    v.wait_until("docked Chat told", |v| told_chat(v) == (true, true));
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    let lit = |v: &mut View, tcx: &mut VisualTestContext| {
        v.pump();
        tcx.run_until_parked();
        let c = column.clone();
        tcx.update(|w, cx| c.read(cx).header_active(w, cx))
    };
    v.wait_until("the torn Chat has the keys and looks it", |v| {
        told_chat(v) == (true, true) && lit(v, &mut tcx)
    });
    // ⌃⌘→ there: Terminal mode has the torn window's keys; it is the Chat slot's own (the
    // session's Claude Code, the `chat` screen in `mode: terminal`), so the slot keeps them
    tcx.simulate_keystrokes("ctrl-cmd-right");
    v.wait_until("Terminal mode with the keys", |v| {
        v.pump();
        tcx.run_until_parked();
        let c = column.clone();
        state(v).mode == ColumnMode::Terminal
            && tcx.update(|w, cx| c.read(cx).has_keyboard(ColumnMode::Terminal, w, cx))
    });
    v.wait_until("the Chat slot still told it has them", |v| {
        told_chat(v) == (true, true)
    });
    // ⌃⌘← there: back on Chat
    tcx.simulate_keystrokes("ctrl-cmd-left");
    v.wait_until("the torn Chat has them again", |v| {
        told_chat(v) == (true, true) && lit(v, &mut tcx)
    });
    // the main window in front: the torn Chat grey, the bridge told
    v.cx.update(|w, _| w.activate_window());
    v.wait_until("the torn Chat without the keys", |v| {
        told_chat(v) == (false, false) && !lit(v, &mut tcx)
    });
}

fn torn_window_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = View::start_projects_app_column("proj", &["a.ts"]);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|_, cx| cx.set_global(fake_on(dir.path(), &["frames/bridge-tree.json"], &[])));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_screen("export const a = 1");
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    // ⌥⌘⏎: no island of the main window maximized
    tcx.simulate_keystrokes("cmd-alt-enter");
    v.settle();
    assert_eq!(v.read_ws(|ws, cx| ws.maximized(cx)), None);
    // ⌃⌥L: the jump told the bridge, from Chat
    tcx.simulate_keystrokes("ctrl-alt-l");
    v.wait_until("the jump reached the bridge", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""type":"jump""#) && l.contains("linked"))
    });
}

// Chat follows: the Factory screen's `selected` opens the `chat` screen on the card at once in
// Chat mode (the Board's tree waits for Chat's answer so both change in one frame), once it rested
// in Terminal mode; the Editor follows the shown workspace.

#[test]
fn chat_follows_the_selected_card_and_the_shown_workspace() {
    table(&[
        (
            "on each card at once in Chat mode, on the workspace in the Editor",
            follows_at_once,
        ),
        (
            "the Board's tree waits for Chat's answer",
            board_waits_for_chat,
        ),
        (
            "in Terminal mode on the card once it rested",
            follows_once_rested,
        ),
        (
            "the Editor's Chat on the shown workspace across a switch",
            follows_shown_workspace,
        ),
    ]);
}

fn none_selected(base: &Path) -> std::path::PathBuf {
    frame(
        base,
        "selected-none.json",
        json!({"v": 2, "type": "shell", "effect": {"kind": "selected", "card": null, "owner": null}}),
    )
}

fn wait_chat_open(v: &mut View, base: &Path) {
    v.key("super+alt+a");
    v.wait_until("the Factory view's Chat open", |v| {
        v.pump();
        !chat_opens(base).is_empty()
    });
}

fn follows_at_once() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    // `l`: the ring on an empty column, no card selected
    let mut v = on_board(&base, vec![(r#""key":"l""#, vec![none_selected(&base)])]);
    wait_chat_open(&mut v, &base);
    // three cards in a row: Chat on each as the Board moves, the clock never advanced, the
    // Board's title with it so its header names the card in the same frame as its body
    let factory = factory(&mut v);
    let on = |v: &mut View, card: Option<u64>, target: ChatTarget| {
        chat_open_now(v, &base)
            && factory.read_with(&v.cx, |f, _| {
                f.selected() == card && *f.chat_target() == target
            })
    };
    let before = chat_opens(&base).len();
    for key in ["ö", "ä", "k"] {
        v.key(key);
    }
    v.wait_until("Chat on the last card without a rest", |v| {
        on(v, Some(7), ChatTarget::Card)
    });
    assert_eq!(chat_opens(&base).len(), before + 3, "on each, at once");
    // the ring on an empty column: Chat on no card at once, not left on the last
    v.key("l");
    v.wait_until("Chat on no card without a rest", |v| {
        on(v, None, ChatTarget::Card)
    });
    v.key("k");
    v.wait_until("Chat on the card again", |v| {
        on(v, Some(7), ChatTarget::Card)
    });
    // the Editor again: Chat back on the shown workspace at once
    v.key("super+alt+a");
    v.wait_until("Chat on the workspace", |v| {
        on(v, Some(7), ChatTarget::Workspace)
    });
    // and the Factory view again: on its card at once
    v.key("super+alt+a");
    v.wait_until("Chat on the card again", |v| {
        on(v, Some(7), ChatTarget::Card)
    });
}

/// The ring and Chat's header and body change together, not the Board first.
fn board_waits_for_chat() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    wait_chat_open(&mut v, &base);
    let factory = factory(&mut v);
    let board = |rev: u64| -> String {
        let text = std::fs::read_to_string(fixture("frames/bridge-tree.json")).unwrap();
        let mut f: Value = serde_json::from_str(&text).unwrap();
        f["rev"] = rev.into();
        f.to_string()
    };
    let chat = |rev: u64| -> String {
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": rev, "slot": "chat", "tree": {
            "kind": "Island", "id": "chat", "props": {},
            "children": [{"kind": "Empty", "props": {"title": "Chat on the new card", "line": ""}}],
        }})
        .to_string()
    };
    let feed = |v: &mut View, line: String| {
        factory.update(&mut v.cx, |f, cx| f.receive_line(&line, cx));
    };
    let selected_line = |card: u64| {
        json!({"v": 2, "type": "shell", "effect": {"kind": "selected", "card": card, "owner": null}})
            .to_string()
    };
    // the selection, then the Board's tree: held until Chat answers the open
    feed(&mut v, selected_line(5));
    feed(&mut v, board(100));
    assert!(
        factory.read_with(&v.cx, |f, _| f.holding()),
        "the Board waits for Chat"
    );
    feed(&mut v, chat(100));
    assert!(
        !factory.read_with(&v.cx, |f, _| f.holding()),
        "drawn with Chat's answer, in the same update"
    );
    // a Chat that does not answer: the Board shows alone after CHAT_SYNC
    feed(&mut v, selected_line(6));
    feed(&mut v, board(101));
    assert!(factory.read_with(&v.cx, |f, _| f.holding()));
    v.cx.executor().advance_clock(vimstorm::factory::CHAT_SYNC);
    v.wait_until("the Board shown alone", |v| {
        v.pump();
        !factory.read_with(&v.cx, |f, _| f.holding())
    });
}

/// Each card there attaches its session: moving through cards attaches only the last.
fn follows_once_rested() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, vec![(r#""key":"l""#, vec![none_selected(&base)])]);
    wait_chat_open(&mut v, &base);
    v.key("super+ctrl+arrow_right");
    v.wait_until("the column in Terminal mode", |v| {
        state(v).mode_now() == ColumnMode::Terminal && chat_open_now(v, &base)
    });
    let factory = factory(&mut v);
    let before = chat_opens(&base).len();
    for key in ["ö", "ä", "k"] {
        v.key(key);
    }
    v.wait_until("the last selection heard", |v| {
        v.pump();
        factory.read_with(&v.cx, |f, _| f.selected()) == Some(7)
    });
    assert_eq!(chat_opens(&base).len(), before, "not before it rested");
    v.cx.executor().advance_clock(vimstorm::factory::CARD_REST);
    v.wait_until("Chat on the last card", |v| chat_open_now(v, &base));
    assert_eq!(chat_opens(&base).len(), before + 1, "once, on the last");
    // the ring on an empty column: nothing to attach, Chat on no card at once
    v.key("l");
    v.wait_until("Chat on no card without a rest", |v| {
        chat_open_now(v, &base) && factory.read_with(&v.cx, |f, _| f.selected()).is_none()
    });
}

fn follows_shown_workspace() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    let a = base.join("demo-shop");
    let b = repo(&base, "other-shop");
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let on = |v: &mut View, dir: &Path| {
        let root = factory(v).read_with(&v.cx, |f, cx| f.chat_open_params(cx).remove("root"));
        chat_open_now(v, &base) && root.as_deref() == dir.to_str()
    };
    v.wait_until("Chat on the first workspace", |v| on(v, &a));
    v.lua(&format!(
        "require('config.app.toolbar').open_project('{}') return true",
        b.display()
    ));
    v.wait_until("Chat on the shown one", |v| on(v, &b));
    // its branch, read after the folder, goes with `project`
    v.wait_until("the shown one's branch told", |v| {
        v.pump();
        log(&base).iter().any(|l| {
            serde_json::from_str::<Value>(l).is_ok_and(|f| {
                f["type"] == "project" && f["root"] == b.to_str().unwrap() && f["branch"] == "main"
            })
        })
    });
    v.key("super+arrow_up");
    v.wait_until("Chat back on the first", |v| on(v, &a));
}

// The transcript, drawn from the bridge's trees in a Factory view of its own.

/// The rendered Chat of the contract's `chat-turn` at `width` px beside an empty island;
/// `mutate` changes its Transcript.
fn turn_at(width: f32, mutate: impl FnOnce(&mut Value)) -> Value {
    let path = fixture("trees/chat-turn.json");
    let mut chat: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    mutate(&mut chat["children"][0]["children"][1]);
    in_column(chat, width)
}

/// `tree` in a `width` px column at the window's right, as the Chat column holds it.
fn in_column(tree: Value, width: f32) -> Value {
    json!({
        "kind": "Stack",
        "props": { "direction": "row", "sizes": [{ "flex": 1 }, { "fixed": width }], "align": "stretch" },
        "children": [{ "kind": "Island", "props": {}, "children": [] }, tree],
    })
}

/// The contract tree `rel` in a `width` px column.
fn tree_in_column(rel: &str, width: f32) -> Value {
    let tree: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap();
    in_column(tree, width)
}

/// The column at 420 px with `extra` messages after the turn.
fn longer(extra: usize, mutate: impl FnOnce(&mut Value)) -> Value {
    turn_at(420., move |t| {
        let parts = t["children"].as_array_mut().unwrap();
        for i in 0..extra {
            parts.push(json!({"kind": "ChatMessage", "id": format!("more:{i}"), "props": {"text": format!("more {i}")}}));
        }
        mutate(t);
    })
}

fn show(w: &mut Win, rev: u64, tree: Value) {
    let line = json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev, "tree": tree})
        .to_string();
    send(w, &line);
}

fn node(w: &mut Win, id: &str) -> gpui_kit::Bounds<gpui_kit::Pixels> {
    w.bounds(Box::leak(format!("factory-node-{id}").into_boxed_str()))
}

fn inside(b: gpui_kit::Bounds<gpui_kit::Pixels>, of: gpui_kit::Bounds<gpui_kit::Pixels>) -> bool {
    b.left() >= of.left() && b.right() <= of.right()
}

#[test]
fn the_transcript_lays_out_inside_the_column_at_its_width() {
    table(&[
        ("at 320 px", transcript_at_320),
        ("at 420 px", transcript_at_420),
        ("at 640 px", transcript_at_640),
        ("the header's second line under its first", header_note),
        ("new below pinned under the parts", new_below),
    ]);
}

/// The gallery: everything inside a 320 px transcript, a diff over 12 lines cut at 12 and a step's
/// output at 10, the unfolded step its row then its output.
fn transcript_at_320() {
    let mut w = Win::open(None);
    w.tree("trees/chat-turn-gallery.json", 1);
    assert_eq!(w.drawn("DiffLine").len(), 12 + 1, "cut at 12");
    assert_eq!(w.drawn("DiffMore").len(), 1);
    // the plain README takes no colours
    assert_eq!(w.drawn("DiffSpans").len(), 12);
    assert_eq!(w.drawn("StepOutput").len(), 4 + 10, "cut at 10");
    assert_eq!(w.drawn("StepMore").len(), 1);
    let t = node(&mut w, "gallery:transcript");
    assert_eq!(t.size.width, px(320.));
    for id in [
        "gallery:diff",
        "gallery:step:failed",
        "gallery:new",
        "gallery:changes",
        "gallery:prose",
    ] {
        let b = node(&mut w, id);
        assert!(inside(b, t), "{id}: {b:?} in {t:?}");
    }
    let failed = node(&mut w, "gallery:step:failed");
    assert_eq!(failed.size.height, px(24. + 2. + 2. + 4. * 18. + 2.));
}

/// The contract's turn: the header, then the turn changes first; the open card's nine lines
/// coloured with the DS syntax tokens on the diff's line backgrounds, the folded one none.
fn transcript_at_420() {
    let mut w = Win::open(None);
    w.tree("trees/chat-turn.json", 1);
    assert_eq!(w.drawn("DiffLine").len(), 9);
    assert_eq!(
        w.drawn("DiffSpans")[0],
        "export=keyword #cc7832 function=keyword #cc7832 cartTotal=func #ffc66d number=keyword #cc7832"
    );
    assert_eq!(
        w.drawn("DiffLineBg"),
        [
            "none", "none", "none", "#484a4a", "#294436", "#294436", "#294436", "none", "none"
        ]
    );
    // top to bottom: header, message, bar, cards, steps, prose
    let header = node(&mut w, "chat:header");
    let msg = node(&mut w, "msg:1");
    let bar = node(&mut w, "changes:1");
    let card = node(&mut w, "diff:1:api/src/cart.ts");
    let folded = node(&mut w, "diff:1:api/test/cart.test.ts");
    let step = node(&mut w, "step:1:1");
    let step2 = node(&mut w, "step:1:2");
    let prose = node(&mut w, "prose:1");
    assert!(header.bottom() <= msg.top(), "{header:?} {msg:?}");
    // turns 16 apart, parts 8
    assert_eq!(bar.top() - msg.bottom(), px(16.));
    assert_eq!(card.top() - bar.bottom(), px(8.));
    assert!(card.bottom() <= folded.top() && folded.bottom() <= step.top());
    assert_eq!(step.size.height, px(24.));
    assert_eq!(step2.top(), step.bottom(), "step rows abut");
    assert!(step2.bottom() <= prose.top());
    // the header: the tool header (31), the two lines (48)
    assert_eq!(header.size.height, px(31. + 48.));
    // 26 px card head, 18 px lines (+ 2 + 2 padding, the head's rule, the card's border)
    assert_eq!(card.size.height, px(2. + 26. + 2. + 9. * 18. + 2.));
    assert_eq!(folded.size.height, px(2. + 26.));
}

fn transcript_at_640() {
    let mut w = Win::open(None);
    show(&mut w, 1, turn_at(640., |_| {}));
    let t = node(&mut w, "chat:transcript");
    assert_eq!(t.size.width, px(640. - 2.), "the island's border");
    for id in [
        "msg:1",
        "changes:1",
        "diff:1:api/src/cart.ts",
        "step:1:2",
        "prose:1",
    ] {
        let b = node(&mut w, id);
        assert!(inside(b, t), "{id}: {b:?} in {t:?}");
        assert_eq!(
            b.size.width,
            t.size.width - px(24.),
            "{id} fills the column"
        );
    }
}

/// The Abe chat's header: line 2 (its checkout) under line 1, inside the header.
fn header_note() {
    let mut w = Win::open(None);
    w.tree("trees/chat-hub.json", 1);
    let note = w.bounds("factory-chat-note");
    let header = w.bounds("factory-node-chat-header");
    assert!(note.top() > header.top() && note.bottom() <= header.bottom());
}

fn new_below() {
    let mut w = Win::open(None);
    show(
        &mut w,
        1,
        longer(3, |t| {
            t["children"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind": "NewBelow", "id": "new", "props": {"count": 2}}));
        }),
    );
    let t = node(&mut w, "chat:transcript");
    let new = node(&mut w, "new");
    let last = node(&mut w, "more:2");
    assert!(
        new.bottom() <= t.bottom() && new.top() >= last.bottom(),
        "{new:?} {last:?} {t:?}"
    );
}

/// Markdown in the transcript fits the 420 px column: your message's fence inside its bubble, the
/// agent's wide fence wrapped, a pipe table with long unbroken words narrowed and broken.
#[test]
fn markdown_in_the_transcript_fits_the_column() {
    let wide = "Feature · AB#30 QA card 30: sort the order list\nKind          feature   the \
                product list sorts by name on purpose; sorting by price is new behaviour\nRisky \
                no        only the order the products are shown in changes; no money";
    let table = "| # | Probe | Result |\n|---|---|---|\n\
                 | 1 | Write `/tmp/v22/probe.txt` | **Refused** by a hook: \
                 `/home/ada/projects/mkdir-swe/demo-shop/.abe/worktrees/102-the-cart-total-ignores-quantity` \
                 is the only place its tools write, not `/tmp/v22/probe.txt`; nothing written. |\n\
                 | 3 | `git push origin HEAD:refs/heads/abe-verify-push-probe` | **Allowed**, exit 0: \
                 `* [new branch] HEAD -> abe-verify-push-probe` on `github.com/mkdir-swe/demo-shop` |\n";
    // name, the part (put first or last), its id, the drawn block's selector, its least height
    let rows: [(&str, Value, bool, &str, &'static str, f32); 3] = [
        (
            "your message's markdown inside its bubble",
            json!({"kind": "ChatMessage", "id": "msg:launch", "props": {"text":
                "/abe:factory Work on card AB#101\n\n### Why\n\nShoppers see **In stock**.\n\n```\nnpm ci\n```\n"}}),
            true,
            "msg:launch",
            "md-fence",
            0.,
        ),
        (
            "a wide code block wraps, three lines four high or more",
            json!({"kind": "Prose", "id": "prose:wide", "props": {"markdown": format!("Here:\n\n```\n{wide}\n```\n")}}),
            false,
            "prose:wide",
            "md-fence",
            4. * 16. + 2. * 16.,
        ),
        (
            "a wide table's words break",
            json!({"kind": "Prose", "id": "prose:table", "props": {"markdown": format!("Probes:\n\n{table}\nDone.\n")}}),
            false,
            "prose:table",
            "md-table",
            0.,
        ),
    ];
    for (name, part, first, id, block, least) in rows {
        let mut w = Win::open(None);
        show(
            &mut w,
            1,
            turn_at(420., move |t| {
                let parts = t["children"].as_array_mut().unwrap();
                if first {
                    parts.insert(0, part);
                } else {
                    parts.push(part);
                }
            }),
        );
        // the next frame lays the part out in the room the transcript measured
        w.cx.run_until_parked();
        let outer = node(&mut w, id);
        let b = w.bounds(block);
        assert!(
            inside(b, outer) && b.top() >= outer.top() && b.bottom() <= outer.bottom(),
            "{name}: {b:?} in {outer:?}"
        );
        assert!(b.size.height >= px(least), "{name}: not wrapped: {b:?}");
        if block == "md-table" {
            let last = w.bounds("md-table-cell-2");
            assert!(
                last.right() <= outer.right(),
                "{name}: the Result column out of view"
            );
            assert!(
                last.size.height >= px(4. * 18.),
                "{name}: not wrapped: {last:?}"
            );
        }
    }
}

// Copying from the transcript: the mouse selects its text as a text view's, ⌘C copies it.

const MESSAGE: &str = "Fix the cart total: it ignores each line's quantity";

/// The chat-turn on the fake bridge with no diff cards, `npm test`'s failing run unfolded with
/// two lines of output, the clipboard holding `S`.
fn copying(dir: &Path) -> Win {
    let mut w = started(dir);
    show(
        &mut w,
        2,
        turn_at(420., |t| {
            // no diff cards: the whole turn in view
            let turn = t["children"][1]["children"].as_array_mut().unwrap();
            turn.retain(|p| p["kind"] != "DiffCard");
            let step = &mut turn[2]["props"];
            step["unfolded"] = json!(true);
            step["output"] = json!(["FAIL api/test/cart.test.ts", "  expected 30, got 10"]);
        }),
    );
    w.cx.run_until_parked();
    w.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("S".into()));
    w
}

fn clipboard(w: &mut Win) -> String {
    w.cx.read_from_clipboard()
        .and_then(|c| c.text())
        .unwrap_or_default()
}

fn drag_over(
    w: &mut Win,
    from: gpui_kit::Point<gpui_kit::Pixels>,
    to: gpui_kit::Point<gpui_kit::Pixels>,
) {
    w.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    w.cx.run_until_parked();
}

#[test]
fn the_transcripts_text_selects_and_copies_as_a_text_views() {
    table(&[
        ("a drag over your message, ⌘C: its words", copy_drag),
        ("a double-click takes the word", copy_word),
        ("a click selects nothing: ⌘C is the screen's", copy_click),
        (
            "a drag over a step's output: its lines, the step stays",
            copy_output,
        ),
        ("the prose's copy button: its markdown", copy_button_prose),
    ]);
}

fn copy_drag() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = copying(dir.path());
    let m = node(&mut w, "msg:1");
    drag_over(
        &mut w,
        point(m.left() + px(1.), m.top() + px(1.)),
        point(m.right() - px(1.), m.bottom() - px(1.)),
    );
    press(&mut w, "super+c");
    assert_eq!(clipboard(&mut w), MESSAGE);
    assert!(
        !log(dir.path()).iter().any(|l| l.contains("<D-c>")),
        "⌘C on a selection went to the bridge too"
    );
}

fn copy_word() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = copying(dir.path());
    let m = node(&mut w, "msg:1");
    // its text's first word: under the 8 px padding, the 16 px context line and the 2 px gap
    let at = point(m.left() + px(12.), m.top() + px(8. + 16. + 2. + 8.));
    for clicks in [1, 2] {
        w.cx.simulate_event(gpui_kit::MouseDownEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: clicks,
            first_mouse: false,
        });
        w.cx.simulate_event(gpui_kit::MouseUpEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: clicks,
        });
    }
    w.cx.run_until_parked();
    press(&mut w, "super+c");
    assert_eq!(clipboard(&mut w), "Fix");
}

fn copy_click() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = copying(dir.path());
    w.click("factory-node-prose:1");
    press(&mut w, "super+c");
    assert_eq!(clipboard(&mut w), "S");
    w.wait("the click and ⌘C at the bridge", |_| {
        let l = log(dir.path());
        l.iter().any(|l| l.contains(r#""id":"prose:1""#)) && l.iter().any(|l| l.contains("<D-c>"))
    });
}

fn copy_output() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = copying(dir.path());
    let step = node(&mut w, "step:1:2");
    // the output under the step's 24 px row
    drag_over(
        &mut w,
        point(step.left() + px(40.), step.top() + px(24. + 4.)),
        point(step.right() - px(2.), step.bottom() - px(2.)),
    );
    press(&mut w, "super+c");
    assert_eq!(
        clipboard(&mut w),
        "FAIL api/test/cart.test.ts\n  expected 30, got 10"
    );
    assert!(
        !log(dir.path())
            .iter()
            .any(|l| l.contains(r#""id":"step:1:2""#)),
        "the press on its output folded the step"
    );
}

fn copy_button_prose() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = copying(dir.path());
    let prose = node(&mut w, "prose:1");
    w.cx.simulate_mouse_move(prose.center(), None::<MouseButton>, Modifiers::default());
    w.cx.run_until_parked();
    w.click("button-copy-prose:1");
    assert!(
        clipboard(&mut w).starts_with("`cartTotal` added each line's price once"),
        "{}",
        clipboard(&mut w)
    );
    assert!(
        !log(dir.path())
            .iter()
            .any(|l| l.contains(r#""id":"prose:1""#)),
        "the copy button's press clicked the prose"
    );
}

/// The parts the tree marks selected draw the selection: one, then the bar, `N steps` and the
/// second bar.
#[test]
fn a_selected_part_draws_the_selection() {
    let mut w = Win::open(None);
    w.tree("trees/chat-rendered-keys.json", 1);
    assert_eq!(w.drawn("Selection").len(), 1);
    let mut tree: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/chat-rendered.json")).unwrap(),
    )
    .unwrap();
    fn select(n: &mut Value) {
        let kind = n["kind"].as_str().unwrap_or_default().to_owned();
        if kind == "ChangesBar" || kind == "StepsFold" {
            n["props"]["selected"] = json!(true);
        }
        if let Some(c) = n.get_mut("children").and_then(Value::as_array_mut) {
            c.iter_mut().for_each(select);
        }
    }
    select(&mut tree);
    show(&mut w, 2, tree);
    assert_eq!(w.drawn("Selection").len(), 3);
}

/// ADR 0013: TS says what the header's state is, glyph and all; Rust draws the glyph it is sent,
/// never one of its own by the state.
#[test]
fn the_header_rail_draws_the_glyph_it_is_sent() {
    const ROWS: &[(&str, &str, &str, &str)] = &[
        (
            "an answered question's run that ended: ✓",
            "ended",
            "✓",
            "Answered",
        ),
        (
            "a pull request ready for review: ● as on the Board",
            "ready",
            "●",
            "Ready for review",
        ),
    ];
    let mut w = Win::open(None);
    for (rev, &(name, state, glyph, word)) in (1..).zip(ROWS) {
        let mut chat: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("trees/chat-turn.json")).unwrap(),
        )
        .unwrap();
        let r = &mut chat["children"][0]["children"][0]["props"]["rail"];
        r["state"] = json!(state);
        r["glyph"] = json!(glyph);
        r["word"] = json!(word);
        show(&mut w, rev, chat);
        let rail = w.drawn("ChatRail");
        assert!(
            rail.len() == 1 && rail[0].contains(&format!(" {glyph} {word} ")),
            "{name}: {rail:?}"
        );
    }
}

// The transcript's scroll and glides.

fn wheel(w: &mut Win, dy: f32) {
    let t = node(w, "chat:transcript");
    w.cx.simulate_mouse_move(t.center(), None, Modifiers::default());
    w.cx.simulate_event(gpui_kit::ScrollWheelEvent {
        position: t.center(),
        delta: gpui_kit::ScrollDelta::Pixels(point(px(0.), px(dy))),
        modifiers: Modifiers::default(),
        touch_phase: gpui_kit::TouchPhase::Moved,
    });
    w.cx.run_until_parked();
}

fn told(dir: &Path, what: &str) -> usize {
    log(dir)
        .iter()
        .filter(|l| l.contains(&format!(r#""id":"chat:transcript:{what}""#)))
        .count()
}

fn at_bottom(b: gpui_kit::Bounds<gpui_kit::Pixels>, t: gpui_kit::Bounds<gpui_kit::Pixels>) -> bool {
    b.bottom() <= t.bottom() && b.bottom() > t.bottom() - px(40.)
}

fn said(id: &str, lines: usize) -> Value {
    let text = vec!["Going on with the magic link."; lines].join("\n\n");
    json!({"kind": "ChatMessage", "id": id, "props": {"text": text}})
}

/// The column at 420 px, 5 messages after the turn, then `tail`; `hold` as TS says it (a question
/// answered, the agent going on with it).
fn with_tail(tail: Vec<Value>, hold: bool) -> Value {
    longer(5, move |t| {
        t["children"].as_array_mut().unwrap().extend(tail);
        if hold {
            t["props"]["hold"] = json!(true);
        }
    })
}

/// The column with 8 messages after the turn and `part` second (under the first message): far
/// above the view once scrolled up from the bottom.
fn above(part: Value) -> Value {
    longer(8, move |t| {
        t["children"].as_array_mut().unwrap().insert(1, part);
    })
}

fn steps_fold(id: &str) -> Value {
    json!({"kind": "StepsFold", "id": id, "props": {"count": 12}})
}

/// Glides on (the app turns them on in `main.rs`), the executor's clock moved by hand.
fn gliding() -> Win {
    let mut w = Win::open(None);
    w.cx.update(|_, cx| vimstorm::factory::enable_glides(cx));
    w
}

/// `ms` later: the clock moved and the window drawn again.
fn later(w: &mut Win, ms: u64) {
    w.cx.executor().advance_clock(Duration::from_millis(ms));
    w.cx.update(|window, _| window.refresh());
    w.cx.run_until_parked();
}

#[test]
fn at_the_bottom_the_transcript_sticks_there() {
    table(&[
        (
            "new parts scroll in, scrolled up they don't, bottom jumps down",
            sticks_and_stays,
        ),
        (
            "another session starts at its own bottom",
            another_sessions_bottom,
        ),
        ("an unheld part going leaves no room", unheld_no_room),
        (
            "in the Chat slot a long answer landing at once shows its end",
            long_answer_lands_at_the_bottom,
        ),
    ]);
}

/// Chat's tree (the contract's `chat-rendered`) with `parts` as its transcript's, `hold` as TS
/// says it.
fn chat_with(parts: Vec<Value>, hold: bool) -> Value {
    let path = fixture("trees/chat-rendered.json");
    let mut chat: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let t = &mut chat["children"][0]["children"][1];
    t["children"] = json!(parts);
    if hold {
        t["props"]["hold"] = json!(true);
    }
    chat
}

/// Read steps as a turn's, `n` of them, then the answer's prose (`lines` bullets) if any.
fn reads_then(n: usize, lines: usize) -> Vec<Value> {
    let mut parts: Vec<Value> = (0..n)
        .map(|i| json!({"kind": "ChatMessage", "id": format!("read:{i}"), "props": {"text": format!("Read src/file{i}.ts")}}))
        .collect();
    if lines > 0 {
        let bullets: Vec<String> = (0..lines)
            .map(|i| format!("- point {i}: the form posts to /api/session"))
            .collect();
        parts.push(json!({"kind": "Prose", "id": "answer", "props": {"markdown": format!("Done reading the sign-in code.\n\n{}", bullets.join("\n"))}}));
    }
    parts
}

/// A long answer arriving whole while Chat sits at its bottom (a short transcript before, held
/// or not), at the column's width: glided in, its last line in view.
fn long_answer_lands_at_the_bottom() {
    for hold in [false, true] {
        let mut w = gliding();
        let (mut scx, _slot) = w.open_slot(Slot::Chat);
        scx.simulate_resize(gpui_kit::size(px(430.), px(900.)));
        scx.run_until_parked();
        let chat_line = |rev: u64, tree: Value| {
            json!({"v": 2, "type": "tree", "screen": "chat", "rev": rev, "slot": "chat", "tree": tree})
                .to_string()
        };
        send(&mut w, &chat_line(1, chat_with(reads_then(12, 0), hold)));
        scx.run_until_parked();
        send(&mut w, &chat_line(2, chat_with(reads_then(12, 20), hold)));
        scx.run_until_parked();
        // the glide in: each frame (the display's: what waits for it runs) a step on
        for _ in 0..20 {
            scx.executor().advance_clock(Duration::from_millis(50));
            scx.update(|window, cx| window.simulate_next_frame(cx));
            scx.run_until_parked();
        }
        let t = scx.debug_bounds("factory-node-chat:transcript").unwrap();
        let answer = scx.debug_bounds("factory-node-answer").unwrap();
        assert!(
            answer.bottom() <= t.bottom() && answer.bottom() > t.bottom() - px(60.),
            "hold {hold}: the answer's end in view: {answer:?} {t:?}"
        );
    }
}

#[test]
fn back_from_terminal_mode_chat_is_where_it_was() {
    table(&[
        ("at the bottom: still there, new parts in", back_at_bottom),
        ("scrolled up: the same line in view", back_scrolled_up),
    ]);
}

/// The Chat slot at 430×700 px, glides on.
fn chat_slot() -> (Win, VisualTestContext) {
    let mut w = gliding();
    let (scx, _slot) = w.open_slot(Slot::Chat);
    scx.simulate_resize(gpui_kit::size(px(430.), px(700.)));
    scx.run_until_parked();
    (w, scx)
}

/// The chat screen's tree `rev` in the Chat slot, drawn and settled.
fn chat_tree(w: &mut Win, scx: &mut VisualTestContext, rev: u64, tree: Value) {
    let line =
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": rev, "slot": "chat", "tree": tree})
            .to_string();
    send(w, &line);
    for _ in 0..6 {
        scx.executor().advance_clock(Duration::from_millis(50));
        scx.update(|window, cx| window.simulate_next_frame(cx));
        scx.run_until_parked();
    }
}

/// Terminal mode's trees (the session attached: no transcript), `n` of them from `rev` on: one
/// keeps the slot's memory of the transcript a sweep longer, a second sweeps what is not lasting.
fn away(w: &mut Win, scx: &mut VisualTestContext, rev: u64, n: u64) {
    for i in 0..n {
        let tree = json!({"kind": "Island", "id": "chat", "props": {}, "children": []});
        chat_tree(w, scx, rev + i, tree);
    }
}

fn wheel_in(scx: &mut VisualTestContext, t: gpui_kit::Bounds<gpui_kit::Pixels>, dy: f32) {
    scx.simulate_mouse_move(t.center(), None, Modifiers::default());
    scx.simulate_event(gpui_kit::ScrollWheelEvent {
        position: t.center(),
        delta: gpui_kit::ScrollDelta::Pixels(point(px(0.), px(dy))),
        modifiers: Modifiers::default(),
        touch_phase: gpui_kit::TouchPhase::Moved,
    });
    scx.run_until_parked();
}

/// Chat's tree with `parts`, the cursor on `read:2` (a click on it, or `gg`: its `reveal` stays in
/// the props after it was scrolled to).
fn cursor_on_read_2(parts: Vec<Value>) -> Value {
    let mut chat = chat_with(parts, false);
    chat["children"][0]["children"][1]["props"]["reveal"] = json!("read:2");
    chat
}

fn back_at_bottom() {
    for n in [1, 3] {
        let (mut w, mut scx) = chat_slot();
        chat_tree(&mut w, &mut scx, 1, cursor_on_read_2(reads_then(40, 20)));
        let t = scx.debug_bounds("factory-node-chat:transcript").unwrap();
        let answer = scx.debug_bounds("factory-node-answer").unwrap();
        assert!(!at_bottom(answer, t), "{n}: at the cursor first");
        // the wheel down to the bottom
        wheel_in(&mut scx, t, -20_000.);
        let answer = scx.debug_bounds("factory-node-answer").unwrap();
        assert!(at_bottom(answer, t), "{n}: wheeled to the bottom");
        away(&mut w, &mut scx, 2, n);
        // back, the same transcript: at its bottom, never at the cursor's part again
        chat_tree(&mut w, &mut scx, 10, cursor_on_read_2(reads_then(40, 20)));
        let answer = scx.debug_bounds("factory-node-answer").unwrap();
        assert!(
            at_bottom(answer, t),
            "{n}: back at the bottom: {answer:?} {t:?}"
        );
        // away again, a turn more arrives meanwhile: back at the new bottom
        away(&mut w, &mut scx, 11, n);
        let mut more = reads_then(40, 20);
        more.push(said("newer", 3));
        chat_tree(&mut w, &mut scx, 20, cursor_on_read_2(more));
        let newer = scx.debug_bounds("factory-node-newer").unwrap();
        assert!(
            at_bottom(newer, t),
            "{n}: the newer part in: {newer:?} {t:?}"
        );
    }
}

fn back_scrolled_up() {
    for n in [1, 3] {
        let (mut w, mut scx) = chat_slot();
        chat_tree(&mut w, &mut scx, 1, chat_with(reads_then(40, 0), false));
        let t = scx.debug_bounds("factory-node-chat:transcript").unwrap();
        wheel_in(&mut scx, t, 600.);
        // the first message wholly in view: the reader's line
        let (id, line) = (0..40)
            .map(|i| format!("factory-node-read:{i}"))
            .find_map(|id| {
                let b = scx.debug_bounds(Box::leak(id.clone().into_boxed_str()))?;
                (b.top() > t.top() && b.bottom() < t.bottom()).then_some((id, b))
            })
            .unwrap();
        assert!(
            !at_bottom(scx.debug_bounds("factory-node-read:39").unwrap(), t),
            "{n}: scrolled up"
        );
        away(&mut w, &mut scx, 2, n);
        chat_tree(&mut w, &mut scx, 10, chat_with(reads_then(40, 0), false));
        assert_eq!(
            scx.debug_bounds(Box::leak(id.into_boxed_str())),
            Some(line),
            "{n}: the line moved"
        );
    }
}

fn sticks_and_stays() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = started(dir.path());
    // the 700 px window is short: the column scrolls, the newest at the bottom
    show(&mut w, 2, longer(3, |_| {}));
    let t = node(&mut w, "chat:transcript");
    let last = node(&mut w, "more:2");
    assert!(at_bottom(last, t), "{last:?} {t:?}");
    assert!(
        node(&mut w, "msg:1").top() < t.top(),
        "the first message scrolled away"
    );
    // a new part while at the bottom scrolls in
    show(&mut w, 3, longer(4, |_| {}));
    let last = node(&mut w, "more:3");
    assert!(last.bottom() <= t.bottom(), "{last:?} {t:?}");
    // scrolled up: the bridge hears it, and a new part leaves the view where it is
    wheel(&mut w, 300.);
    w.wait("up told", |_| told(dir.path(), "up") > 0);
    let before = node(&mut w, "more:3");
    show(&mut w, 4, longer(5, |_| {}));
    assert_eq!(node(&mut w, "more:3"), before, "new parts don't move it");
    assert!(
        node(&mut w, "more:4").top() >= t.bottom(),
        "the new one below the fold"
    );
    // `reveal` brings a part in; `bottom` jumps down and the bridge hears it
    show(
        &mut w,
        5,
        longer(5, |t| t["props"]["reveal"] = json!("msg:1")),
    );
    let msg = node(&mut w, "msg:1");
    assert!(
        msg.top() >= t.top() && msg.top() < t.bottom(),
        "{msg:?} {t:?}"
    );
    show(
        &mut w,
        6,
        longer(5, |t| {
            t["props"]["reveal"] = json!("msg:1");
            t["props"]["bottom"] = json!(1);
        }),
    );
    let last = node(&mut w, "more:4");
    assert!(last.bottom() <= t.bottom(), "{last:?} {t:?}");
    w.wait("bottom told", |_| told(dir.path(), "bottom") > 0);
}

/// Each session's transcript keeps its own scroll; another session's starts at its bottom.
fn another_sessions_bottom() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = started(dir.path());
    let of = |session: &'static str, extra: usize| {
        longer(extra, move |t| t["props"]["session"] = json!(session))
    };
    show(&mut w, 2, of("s1", 5));
    let t = node(&mut w, "chat:transcript");
    wheel(&mut w, 300.);
    w.wait("up told", |_| told(dir.path(), "up") > 0);
    // another session pinned with one part more: it sticks to its own bottom, the part scrolls in
    show(&mut w, 3, of("s2", 6));
    let last = node(&mut w, "more:5");
    assert!(
        last.bottom() <= t.bottom(),
        "s2 at its bottom: {last:?} {t:?}"
    );
}

/// The room a part leaves is kept only while TS holds it: any other part that goes (an earlier
/// turn's steps folding when you send a message) leaves no hole.
fn unheld_no_room() {
    let mut w = Win::open(None);
    show(&mut w, 1, with_tail(vec![said("card", 8)], false));
    let t = node(&mut w, "chat:transcript");
    show(&mut w, 2, with_tail(vec![said("you", 1)], false));
    let last = node(&mut w, "you");
    assert!(at_bottom(last, t), "{last:?} {t:?}");
}

#[test]
fn scrolled_up_the_line_in_view_stays_still() {
    table(&[
        ("a part above changing height", part_above_changes_height),
        (
            "the anchor part going, the next one holds the line",
            anchor_goes,
        ),
        (
            "gliding, the wheel moves at once and a new part moves nothing",
            gliding_wheel,
        ),
        (
            "gliding, a fold above moves nothing in view",
            gliding_fold_above,
        ),
    ]);
}

/// An earlier turn's steps folding or a part re-rendered taller keeps the reader's line still: the
/// first part whose top is in view stays where it is, the scroll takes the difference.
fn part_above_changes_height() {
    let mut w = Win::open(None);
    show(&mut w, 1, above(said("steps", 12)));
    let t = node(&mut w, "chat:transcript");
    wheel(&mut w, 150.);
    let line = node(&mut w, "more:3");
    assert!(
        line.top() > t.top() && line.bottom() < t.bottom(),
        "in view: {line:?} {t:?}"
    );
    assert!(node(&mut w, "steps").bottom() < t.top(), "above the view");
    show(&mut w, 2, above(steps_fold("steps")));
    assert_eq!(node(&mut w, "more:3"), line, "the fold moved the line");
    show(&mut w, 3, above(said("steps", 20)));
    assert_eq!(node(&mut w, "more:3"), line, "growing moved the line");
    // a new part at the bottom, below the view: nothing moves either
    show(
        &mut w,
        4,
        longer(9, |t| {
            t["children"]
                .as_array_mut()
                .unwrap()
                .insert(1, said("steps", 20));
        }),
    );
    assert_eq!(node(&mut w, "more:3"), line, "a new part moved it");
}

fn anchor_goes() {
    let mut w = Win::open(None);
    let without = |gone: Option<usize>| {
        turn_at(420., move |t| {
            t["children"] = (0..14)
                .filter(|i| Some(*i) != gone)
                .map(|i| said(&format!("m:{i}"), 1))
                .collect();
        })
    };
    show(&mut w, 1, without(None));
    let t = node(&mut w, "chat:transcript");
    wheel(&mut w, 150.);
    let first = (0..14)
        .find(|i| node(&mut w, &format!("m:{i}")).top() >= t.top())
        .unwrap();
    let next = format!("m:{}", first + 1);
    let line = node(&mut w, &next);
    assert!(line.bottom() < t.bottom(), "in view: {line:?} {t:?}");
    show(&mut w, 2, without(Some(first)));
    assert_eq!(node(&mut w, &next), line, "the line moved");
}

fn gliding_wheel() {
    let mut w = gliding();
    show(&mut w, 1, longer(4, |_| {}));
    later(&mut w, 1000);
    let before = node(&mut w, "more:3");
    wheel(&mut w, 120.);
    let up = node(&mut w, "more:3");
    assert_eq!(up.top(), before.top() + px(120.), "at once");
    show(
        &mut w,
        2,
        longer(5, |t| {
            t["children"].as_array_mut().unwrap().push(said("card", 8))
        }),
    );
    assert_eq!(node(&mut w, "more:3"), up, "nothing in view moved");
    later(&mut w, 300);
    assert_eq!(node(&mut w, "more:3"), up, "nor later");
}

/// The anchor holds the line; only what is above glides.
fn gliding_fold_above() {
    let mut w = gliding();
    show(&mut w, 1, above(said("steps", 12)));
    later(&mut w, 1000);
    wheel(&mut w, 150.);
    later(&mut w, 300);
    let line = node(&mut w, "more:3");
    show(&mut w, 2, above(steps_fold("steps")));
    assert_eq!(node(&mut w, "more:3"), line, "on its first frame");
    later(&mut w, 100);
    assert_eq!(node(&mut w, "more:3"), line, "mid-glide");
    later(&mut w, 300);
    assert_eq!(node(&mut w, "more:3"), line, "after it");
}

/// At the bottom, a part TS holds the room of (the answered card folding to its line) moves
/// nothing above it: its room stays at the bottom, and a reply fills it without moving anything
/// either; only a reply taller than that room pushes the parts up.
#[test]
fn a_held_fold_moves_nothing_above_it() {
    table(&[
        ("at the bottom of a long transcript", held_fold_at_bottom),
        ("on a short transcript", held_fold_short),
    ]);
}

fn answered_line() -> Value {
    json!({"kind": "CardLine", "id": "answered:q", "props": {"head": "Answered", "text": "Magic link", "n": 1}})
}

fn held_fold_at_bottom() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = started(dir.path());
    let line = answered_line();
    // the question's card: a tall part at the bottom
    show(&mut w, 2, with_tail(vec![said("card", 8)], false));
    let t = node(&mut w, "chat:transcript");
    let above = node(&mut w, "more:4");
    assert!(node(&mut w, "card").bottom() <= t.bottom());
    // answered: the card folds to its line, in place
    show(&mut w, 3, with_tail(vec![line.clone()], true));
    assert_eq!(
        node(&mut w, "more:4"),
        above,
        "folding moved the parts above"
    );
    let folded = node(&mut w, "answered:q");
    assert_eq!(folded.top(), node(&mut w, "more:4").bottom() + px(16.));
    // the reply, shorter than the card was: into its room, nothing moves
    show(
        &mut w,
        4,
        with_tail(vec![line.clone(), said("reply", 2)], true),
    );
    assert_eq!(node(&mut w, "more:4"), above, "a short reply moved them");
    assert_eq!(node(&mut w, "answered:q"), folded);
    // more than the room: it scrolls in at the bottom, as ever
    show(
        &mut w,
        5,
        with_tail(vec![line, said("reply", 2), said("next", 12)], true),
    );
    let next = node(&mut w, "next");
    assert!(at_bottom(next, t), "{next:?} {t:?}");
    assert!(node(&mut w, "more:4").top() < above.top());
    assert_eq!(told(dir.path(), "up"), 0, "still at the bottom throughout");
}

/// What is left is shorter than the column: no spacer pushes the parts back down to its bottom.
fn held_fold_short() {
    let mut w = Win::open(None);
    let short = |tail: Vec<Value>, hold: bool| {
        turn_at(420., move |t| {
            t["children"] =
                json!([{"kind": "ChatMessage", "id": "msg:1", "props": {"text": "go"}}]);
            t["children"].as_array_mut().unwrap().extend(tail);
            t["props"]["hold"] = json!(hold);
        })
    };
    show(&mut w, 1, short(vec![said("card", 30)], false));
    let t = node(&mut w, "chat:transcript");
    let card = node(&mut w, "card");
    assert!(
        card.top() < t.top(),
        "the card fills the column: {card:?} {t:?}"
    );
    show(
        &mut w,
        2,
        short(vec![said("before", 2), said("card", 30)], false),
    );
    let before = node(&mut w, "before");
    show(
        &mut w,
        3,
        short(vec![said("before", 2), answered_line()], true),
    );
    assert_eq!(node(&mut w, "before"), before, "folding moved it down");
}

/// The column at 420 px whose transcript is one turn of `rows` step rows (taller than the 700 px
/// window), `reveal` set to `step:<n>` when given.
fn tall_turn(rows: usize, reveal: Option<usize>) -> Value {
    turn_at(420., move |t| {
        let steps: Vec<Value> = (0..rows)
            .map(|i| {
                json!({"kind": "StepRow", "id": format!("step:{i}"),
                       "props": {"mark": "good", "verb": "Read", "object": format!("src/f{i}.ts"), "objectKind": "path",
                                 "selected": reveal == Some(i)}})
            })
            .collect();
        t["children"] = json!([{"kind": "ChatMessage", "id": "msg:1", "props": {"text": "go"}},
                               {"kind": "Turn", "id": "turn:1", "props": {}, "children": steps}]);
        if let Some(n) = reveal {
            t["props"]["reveal"] = json!(format!("step:{n}"));
        }
    })
}

/// The cursor on a row deep in a turn taller than the column shows that row, scrolling the least:
/// at the bottom a row already in view moves nothing (and tells nothing), one above the view comes
/// in at the top, never the turn's top; and the next frame does not snap it back down.
#[test]
fn reveal_in_a_tall_turn_shows_the_row_and_stays() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = started(dir.path());
    show(&mut w, 2, tall_turn(60, None));
    let t = node(&mut w, "chat:transcript");
    let last = node(&mut w, "step:59");
    assert!(at_bottom(last, t));
    let up = told(dir.path(), "up");
    // ö then l l l: the cursor on the third row from the end, in view: nothing moves
    for (rev, n) in [(3, 59), (4, 58), (5, 57)] {
        show(&mut w, rev, tall_turn(60, Some(n)));
        assert_eq!(node(&mut w, "step:59"), last, "row {n}: the view moved");
    }
    show(&mut w, 6, tall_turn(60, Some(57)));
    assert_eq!(node(&mut w, "step:59"), last, "a frame later");
    assert_eq!(told(dir.path(), "up"), up, "nothing scrolled up");
    // a row above the view: it comes in at the top, the turn's first row stays out of view
    show(&mut w, 7, tall_turn(60, Some(20)));
    let row = node(&mut w, "step:20");
    assert!(
        row.top() >= t.top() && row.bottom() <= t.bottom(),
        "{row:?} {t:?}"
    );
    assert!(
        node(&mut w, "step:0").bottom() <= t.top(),
        "not the turn's top"
    );
    w.wait("up told", |_| told(dir.path(), "up") > up);
    // drawn again for another reason (a tick): it stays where the reveal put it
    show(&mut w, 8, tall_turn(60, Some(20)));
    show(&mut w, 9, tall_turn(60, Some(20)));
    assert_eq!(node(&mut w, "step:20"), row, "snapped back");
    assert_eq!(
        told(dir.path(), "bottom"),
        0,
        "never told it went back down"
    );
}

/// Glides on: at the bottom, a part landing or folding paints the parts above where they were and
/// glides them to their place, nothing jumps in one frame.
#[test]
fn glides_move_the_parts_above_over_their_time() {
    table(&[
        ("a tall part landing glides them up", glide_up),
        ("a fold glides them down", glide_down),
    ]);
}

/// The question card landing: the parts above glide up in 200 ms, the card comes in under them.
fn glide_up() {
    let mut w = gliding();
    show(&mut w, 1, longer(3, |_| {}));
    later(&mut w, 1000);
    let t = node(&mut w, "chat:transcript");
    let above = node(&mut w, "more:2");
    show(
        &mut w,
        2,
        longer(3, |t| {
            t["children"].as_array_mut().unwrap().push(said("card", 8))
        }),
    );
    assert_eq!(node(&mut w, "more:2"), above, "painted where it was");
    let card = node(&mut w, "card");
    assert_eq!(card.top(), above.bottom() + px(16.), "the card under it");
    later(&mut w, 100);
    let mid = node(&mut w, "more:2");
    assert!(mid.top() < above.top(), "on its way up: {mid:?} {above:?}");
    later(&mut w, 100);
    let card = node(&mut w, "card");
    assert!(
        at_bottom(card, t),
        "in its place at the bottom: {card:?} {t:?}"
    );
    let end = node(&mut w, "more:2");
    assert!(end.top() < mid.top());
    assert_eq!(end.bottom() + px(16.), card.top());
    later(&mut w, 100);
    assert_eq!(node(&mut w, "more:2"), end, "and stays");
}

/// A tall part near the bottom folding to a short one (an earlier turn's steps to `N steps` on
/// send) moves the parts above it down.
fn glide_down() {
    let mut w = gliding();
    let with = |part: Value| {
        longer(6, move |t| {
            let parts = t["children"].as_array_mut().unwrap();
            parts.push(part);
            parts.push(said("tail", 1));
        })
    };
    show(&mut w, 1, with(said("steps", 12)));
    later(&mut w, 1000);
    let above = node(&mut w, "more:5");
    let tail = node(&mut w, "tail");
    show(&mut w, 2, with(steps_fold("steps")));
    assert_eq!(node(&mut w, "more:5"), above, "painted where it was");
    assert_eq!(node(&mut w, "tail"), tail, "the bottom stays");
    later(&mut w, 250);
    assert!(
        node(&mut w, "more:5").top() > above.top(),
        "down in its place"
    );
}

/// Glides on: what is drawn in a new place for a reason other than a move lands there at once.
#[test]
fn glides_never_start_from_stale_places() {
    table(&[
        ("another session's transcript", glide_other_session),
        ("a column wider than the first guess", glide_wider_column),
    ]);
}

/// Another session is drawn in its own place at once, and back on the first one with a part more,
/// that is where it lays out too.
fn glide_other_session() {
    let mut w = gliding();
    let of = |s: &'static str, n: usize| longer(n, move |t| t["props"]["session"] = json!(s));
    show(&mut w, 1, of("a", 3));
    later(&mut w, 1000);
    let t = node(&mut w, "chat:transcript");
    show(&mut w, 2, of("b", 1));
    let b = node(&mut w, "more:0");
    later(&mut w, 300);
    assert_eq!(node(&mut w, "more:0"), b, "b drawn in place at once");
    show(&mut w, 3, of("a", 5));
    let last = node(&mut w, "more:4");
    assert!(at_bottom(last, t), "{last:?} {t:?}");
}

/// A column at another width than the prose's first guess (640 px) wraps its prose again on the
/// next frame; that is no move.
fn glide_wider_column() {
    let mut w = gliding();
    let row = "| `src/auth/signin.ts` | posts the form to the session endpoint and reads the token back |";
    let long = format!("| File | What |\n|---|---|\n{}\n", [row; 6].join("\n"));
    show(
        &mut w,
        1,
        turn_at(640., move |t| {
            t["children"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind": "Prose", "id": "long", "props": {"markdown": long}}));
        }),
    );
    let first = node(&mut w, "msg:1");
    later(&mut w, 300);
    assert_eq!(node(&mut w, "msg:1"), first, "no glide after the wrap");
}

// The composer, from the contract's `composer-*` trees at the bottom of the 420 px column.

fn composer_at(rel: &str) -> Win {
    let mut w = Win::open(None);
    show(&mut w, 1, tree_in_column(rel, 420.));
    w
}

#[test]
fn the_composer_lays_out_at_the_bottom_of_the_column() {
    table(&[
        (
            "empty: the dock, its chip, field and model line",
            composer_empty,
        ),
        (
            "typed text wraps in 20 px rows, the caret while it has the keys",
            composer_wraps,
        ),
        (
            "the field grows to eight rows, then shows its last",
            composer_eight_rows,
        ),
        ("the / menu 4 px over the composer", composer_slash_menu),
        ("the model pick fits over it", composer_model_pick),
        ("a queued row above it with its ×", composer_queued),
        ("the gallery inside the column", composer_gallery),
        (
            "at work: the status line right over it, its subagents unfolded above, file chips in it",
            composer_working,
        ),
    ]);
}

fn composer_working() {
    let mut w = composer_at("trees/composer-working.json");
    let col = node(&mut w, "col:working");
    let status = node(&mut w, "chat:status");
    let composer = node(&mut w, "composer:composer");
    let toggle = node(&mut w, "chat:agents");
    let first = node(&mut w, "chat:agent:a2");
    let chip = node(&mut w, "composer:detach:0");
    let file = node(&mut w, "composer:detach:1");
    assert!(inside(status, col), "{status:?} in {col:?}");
    // the line is the dock's last row before the field: 4 px over it, its toggle at the right
    assert_eq!(composer.top() - status.bottom(), px(4.));
    assert!(toggle.right() <= status.right() && toggle.left() > status.center().x);
    // the list above the line, its rows 22 px
    assert!(
        first.bottom() <= status.bottom() - px(24.),
        "{first:?} {status:?}"
    );
    assert_eq!(first.size.height, px(22.));
    assert_eq!(w.drawn("SubagentRow").len(), 3);
    assert_eq!(w.drawn("SubagentSelected").len(), 1);
    // the chips in the composer, side by side, over the field
    assert!(inside(chip, composer) && inside(file, composer));
    assert_eq!(chip.top(), file.top());
    assert!(chip.right() <= file.left());
    assert!(chip.bottom() <= w.bounds("factory-composer-field").top());
    assert_eq!(w.drawn("ChatStatusClock").len(), 1);
}

fn composer_empty() {
    let mut w = composer_at("trees/composer-empty.json");
    // not focused: no caret
    assert!(w.drawn("ComposerCaret").is_empty());
    let col = node(&mut w, "col:empty");
    let composer = node(&mut w, "composer:composer");
    let chip = node(&mut w, "composer:chip");
    let field = w.bounds("factory-composer-field");
    let model = node(&mut w, "composer:model");
    assert_eq!(col.size.width, px(420.));
    // the dock: 12 px from the column's sides and bottom (its 1 px edge inside)
    assert_eq!(composer.left() - col.left(), px(1. + 12.));
    assert_eq!(col.right() - composer.right(), px(1. + 12.));
    assert_eq!(col.bottom() - composer.bottom(), px(1. + 12.));
    // chip row 20, field two 20 px rows, model bar 22, padding 4 / 2 and the 1 px edge
    assert_eq!(chip.size.height, px(20.));
    assert_eq!(field.size.height, px(40.));
    assert_eq!(chip.top() - composer.top(), px(1. + 4.));
    assert_eq!(field.top(), chip.bottom());
    assert_eq!(model.size.height, px(22.));
    assert_eq!(composer.bottom() - model.bottom(), px(2. + 1.));
    // the model line at the right, the field 10 px in from the left edge
    assert_eq!(composer.right() - model.right(), px(4. + 1.));
    assert_eq!(field.left() - composer.left(), px(10. + 1.));
}

fn composer_wraps() {
    let mut w = composer_at("trees/composer-text.json");
    assert_eq!(w.drawn("ComposerCaret").len(), 1);
    // wrapped in 20 px rows; the field as tall as its rows (two at the least)
    let text = w.bounds("factory-composer-text");
    let field = w.bounds("factory-composer-field");
    let rows = f32::from(text.size.height) / 20.;
    assert!(rows >= 2. && rows.fract() == 0., "{text:?}");
    assert_eq!(field.size.height, text.size.height);
    assert_eq!(field.top(), text.top());
}

fn composer_eight_rows() {
    let mut w = composer_at("trees/composer-long.json");
    let field = w.bounds("factory-composer-field");
    let text = w.bounds("factory-composer-text");
    assert_eq!(field.size.height, px(8. * 20.));
    // ten lines: taller than the field, its last rows in view (the caret's end)
    assert!(text.size.height >= px(10. * 20.), "{text:?}");
    assert_eq!(text.bottom(), field.bottom());
    assert!(text.top() < field.top());
}

fn composer_slash_menu() {
    let mut w = composer_at("trees/composer-slash.json");
    let composer = node(&mut w, "composer:composer");
    let menu = node(&mut w, "composer:menu");
    // `bottom: calc(100% + 4px)` of the composer's padding box: 3 px over its 1 px edge; as wide
    // as it; 26 px rows inside its 4 px padding and 1 px edge
    assert_eq!(composer.top() - menu.bottom(), px(3.));
    assert_eq!(menu.left(), composer.left());
    assert_eq!(menu.right(), composer.right());
    let first = node(&mut w, "composer:menu:0");
    let second = node(&mut w, "composer:menu:1");
    assert_eq!(first.size.height, px(26.));
    assert_eq!(second.top(), first.bottom());
    assert_eq!(first.top() - menu.top(), px(1. + 4.));
    let rows = w.drawn("SlashRow").len() as f32;
    assert_eq!(menu.size.height, px(rows * 26. + 2. * 4. + 2.));
}

fn composer_model_pick() {
    let mut w = composer_at("trees/composer-pick.json");
    let col = node(&mut w, "col:pick");
    let menu = node(&mut w, "composer:pick");
    assert!(menu.top() >= col.top(), "{menu:?} in {col:?}");
}

fn composer_queued() {
    let mut w = composer_at("trees/composer-queued.json");
    let row = node(&mut w, "composer:queued:1");
    let composer = node(&mut w, "composer:composer");
    let remove = node(&mut w, "composer:unqueue:1");
    assert_eq!(row.size.height, px(24.));
    assert_eq!(composer.top() - row.bottom(), px(4.));
    assert!(remove.right() <= row.right() && remove.left() > row.center().x);
}

fn composer_gallery() {
    let mut w = composer_at("trees/composer-gallery.json");
    let col = node(&mut w, "col:gallery");
    let composer = node(&mut w, "gallery:composer");
    assert!(inside(composer, col), "{composer:?} in {col:?}");
}

#[test]
fn a_click_on_a_menu_row_is_the_rows_not_the_composers_under_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = started(dir.path());
    show(&mut w, 2, tree_in_column("trees/composer-slash.json", 420.));
    w.click("factory-node-composer:menu:1");
    w.wait("the row's click", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""kind":"click","id":"composer:menu:1""#))
    });
    assert!(
        !log(dir.path())
            .iter()
            .any(|l| l.contains(r#""id":"composer:composer""#)),
        "the composer took it too"
    );
}

#[test]
fn in_the_chat_slot_a_dead_keys_composed_text_goes_as_text_and_its_preedit_is_drawn() {
    let dir = tempfile::tempdir().unwrap();
    let tree: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/composer-text.json")).unwrap(),
    )
    .unwrap();
    let chat = frame(
        dir.path(),
        "chat-tree.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "tree": tree, "slot": "chat"}),
    );
    let mut w = Win::open(Some(fake_on(
        dir.path(),
        &["frames/bridge-tree.json"],
        &[(r#""type":"open","v":2,"screen":"chat""#, vec![chat])],
    )));
    w.start();
    let (mut scx, slot) = w.open_slot(Slot::Chat);
    w.wait("the composer in the slot", |w| {
        w.cx.run_until_parked();
        scx.run_until_parked();
        slot.read_with(&scx, |v, _| !v.drawn().texts("ComposerField").is_empty())
    });
    // AppKit marks the dead key ´, then commits é
    let mut ime = slot.read_with(&scx, |v, _| v.ime_handler());
    scx.update(|window, cx| ime.replace_and_mark_text_in_range(None, "´", Some(1..1), window, cx));
    scx.run_until_parked();
    assert_eq!(slot.read_with(&scx, |v, _| v.preedit()), Some("´".into()));
    scx.update(|window, cx| ime.replace_text_in_range(None, "é", window, cx));
    w.wait("é as text with slot chat", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""kind":"text","text":"é""#) && l.contains(r#""slot":"chat""#))
    });
    assert_eq!(slot.read_with(&scx, |v, _| v.preedit()), None);
}

// The Chat slot's own field: a native text area typing at once, its text told as drafts.

/// A chat column whose composer holds `text`, the field's last draft `seq`, with the keys.
fn field_tree(text: &str, seq: u64) -> Value {
    json!({"kind": "Island", "id": "col:field", "props": {}, "children": [
        {"kind": "Stack", "props": {"direction": "column", "sizes": [{"flex": 1}, "auto"]}, "children": [
            {"kind": "Stack", "props": {"direction": "column"}, "children": []},
            {"kind": "Stack", "id": "composer:dock", "props": {"direction": "column", "gap": 4, "pad": [4, 12, 12, 12]}, "children": [
                {"kind": "ChatStatus", "id": "chat:status", "props": {
                    "tone": "working", "words": "Thinking", "since": 1_790_000_000_000_u64,
                    "agents": {"text": "2 subagents", "id": "chat:agents", "running": 2, "open": false}}},
                {"kind": "Composer", "id": "composer:composer", "props": {
                    "text": text, "placeholder": "Ask or tell the agent…", "focused": true, "seq": seq}}
            ]}
        ]}
    ]})
}

/// The slot drawing `field_tree("", 0)`; the screen answers ⏎ with `then` (a tree frame's file).
fn field_slot(
    dir: &Path,
    then: Vec<(&'static str, Vec<std::path::PathBuf>)>,
) -> (
    Win,
    VisualTestContext,
    gpui_kit::Entity<vimstorm::factory::SlotView>,
) {
    let tree = |name: &str, text: &str, seq: u64| {
        frame(
            dir,
            name,
            json!({"v": 2, "type": "tree", "screen": "chat", "rev": seq + 1, "tree": field_tree(text, seq), "slot": "chat"}),
        )
    };
    let first = tree("field-0.json", "", 0);
    let mut on = vec![(r#""type":"open","v":2,"screen":"chat""#, vec![first])];
    on.extend(then);
    let mut w = Win::open(Some(fake_on(dir, &["frames/bridge-tree.json"], &on)));
    w.start();
    let (mut scx, slot) = w.open_slot(Slot::Chat);
    w.wait("the field in the slot", |w| {
        w.cx.run_until_parked();
        scx.run_until_parked();
        slot.read_with(&scx, |v, _| !v.drawn().texts("ComposerField").is_empty())
    });
    let area = slot.read_with(&scx, |v, _| v.field());
    scx.update(|window, cx| {
        window.focus(&gpui_kit::Focusable::focus_handle(area.read(cx), cx), cx)
    });
    scx.run_until_parked();
    (w, scx, slot)
}

fn rest(w: &mut Win, scx: &mut VisualTestContext) {
    scx.executor().advance_clock(Duration::from_millis(200));
    scx.run_until_parked();
    w.cx.run_until_parked();
}

#[test]
fn the_chat_slots_own_field_types_at_once_and_tells_the_screen_drafts() {
    table(&[
        (
            "typed text shows at once, goes as one numbered draft once typing rests, before ⏎",
            field_drafts,
        ),
        (
            "the screen emptying it after a send empties it; an older tree changes nothing",
            field_echo,
        ),
        (
            "it grows with its lines to 40 % of the column, then scrolls",
            field_grows,
        ),
        (
            "the status line over it: its words, its time, its subagents",
            field_status,
        ),
        (
            "a caret moved alone goes as a draft; a skill the screen puts in a /word's place puts the caret after it",
            field_caret,
        ),
    ]);
}

fn field_caret() {
    let dir = tempfile::tempdir().unwrap();
    let mut picked = field_tree("run /abe:triage and go", 2);
    picked["children"][0]["children"][1]["children"][1]["props"]["caret"] = json!(16);
    let picked = frame(
        dir.path(),
        "field-picked.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 9, "tree": picked, "slot": "chat"}),
    );
    let (mut w, mut scx, slot) = field_slot(dir.path(), vec![(r#""key":"<CR>""#, vec![picked])]);
    let area = slot.read_with(&scx, |v, _| v.field());
    let drafts = |dir: &Path| {
        log(dir)
            .into_iter()
            .filter(|l| l.contains(r#""kind":"draft""#))
            .collect::<Vec<_>>()
    };
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert("run /abe:tr and go", cx)));
    rest(&mut w, &mut scx);
    // the caret back after `/abe:tr`, the text as it was: told
    scx.update(|_, cx| area.update(cx, |a, cx| a.set_cursor(11, cx)));
    rest(&mut w, &mut scx);
    let told = drafts(dir.path());
    assert_eq!(told.len(), 2, "{told:?}");
    assert!(
        told[1].contains(r#""text":"run /abe:tr and go","seq":2,"caret":11"#),
        "{told:?}"
    );
    scx.simulate_keystrokes("enter");
    w.wait("the skill in its word's place", |w| {
        w.cx.run_until_parked();
        scx.run_until_parked();
        area.read_with(&scx, |a, _| a.text() == "run /abe:triage and go")
    });
    assert_eq!(area.read_with(&scx, |a, _| a.cursor()), 16);
    // where the screen put it is not told back
    rest(&mut w, &mut scx);
    assert_eq!(drafts(dir.path()).len(), 2);
}

fn field_drafts() {
    let dir = tempfile::tempdir().unwrap();
    let (mut w, mut scx, slot) = field_slot(dir.path(), vec![]);
    let area = slot.read_with(&scx, |v, _| v.field());
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert("why not", cx)));
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert(" here", cx)));
    assert_eq!(
        area.read_with(&scx, |a, _| a.text().to_owned()),
        "why not here"
    );
    // nothing told while typing goes on
    assert!(
        !log(dir.path())
            .iter()
            .any(|l| l.contains(r#""kind":"draft""#))
    );
    rest(&mut w, &mut scx);
    let drafts: Vec<String> = log(dir.path())
        .into_iter()
        .filter(|l| l.contains(r#""kind":"draft""#))
        .collect();
    assert_eq!(drafts.len(), 1, "{drafts:?}");
    assert!(
        drafts[0].contains(r#""text":"why not here","seq":1"#),
        "{drafts:?}"
    );
    // typed on and ⏎ at once: the draft first, then the key
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert("?", cx)));
    scx.simulate_keystrokes("enter");
    w.wait("⏎ after its draft", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""key":"<CR>""#))
    });
    let l = log(dir.path());
    let draft = l
        .iter()
        .position(|x| x.contains(r#""text":"why not here?","seq":2"#))
        .expect("the draft");
    let enter = l
        .iter()
        .position(|x| x.contains(r#""key":"<CR>""#))
        .unwrap();
    assert!(draft < enter);
    // ⏎ is the screen's: no new line in the field
    assert_eq!(
        area.read_with(&scx, |a, _| a.text().to_owned()),
        "why not here?"
    );
}

fn field_echo() {
    let dir = tempfile::tempdir().unwrap();
    let cleared = frame(
        dir.path(),
        "field-cleared.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 9, "tree": field_tree("", 1), "slot": "chat"}),
    );
    let (mut w, mut scx, slot) = field_slot(dir.path(), vec![(r#""key":"<CR>""#, vec![cleared])]);
    let area = slot.read_with(&scx, |v, _| v.field());
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert("send me", cx)));
    rest(&mut w, &mut scx);
    // a tree drawn before the draft (seq 0) leaves the field as typed
    slot.update(&mut scx, |_, cx| cx.notify());
    scx.run_until_parked();
    assert_eq!(area.read_with(&scx, |a, _| a.text().to_owned()), "send me");
    scx.simulate_keystrokes("enter");
    w.wait("the screen emptied it", |w| {
        w.cx.run_until_parked();
        scx.run_until_parked();
        area.read_with(&scx, |a, _| a.text().is_empty())
    });
}

fn field_grows() {
    let dir = tempfile::tempdir().unwrap();
    let (_w, mut scx, slot) = field_slot(dir.path(), vec![]);
    let area = slot.read_with(&scx, |v, _| v.field());
    let height = |scx: &mut VisualTestContext| {
        scx.update(|window, _| window.refresh());
        scx.run_until_parked();
        scx.debug_bounds("factory-composer-field")
            .expect("the field")
            .size
            .height
    };
    assert_eq!(height(&mut scx), px(40.), "two rows at the least");
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert("one\ntwo\nthree", cx)));
    assert_eq!(height(&mut scx), px(60.));
    let long = (0..60)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    scx.update(|_, cx| area.update(cx, |a, cx| a.insert(&long, cx)));
    let column = scx
        .debug_bounds("factory-node-col:field")
        .expect("the column")
        .size
        .height;
    let max = (f32::from(column) * 0.4 / 20.).floor() * 20.;
    let tall = height(&mut scx);
    assert!(
        tall <= px(max + 1.) && tall >= px(max - 20.),
        "{tall:?} for {column:?}"
    );
    // the whole paste is in it
    assert_eq!(area.read_with(&scx, |a, _| a.text().lines().count()), 62);
}

fn field_status() {
    let dir = tempfile::tempdir().unwrap();
    let (_w, mut scx, slot) = field_slot(dir.path(), vec![]);
    let status = scx
        .debug_bounds("factory-node-chat:status")
        .expect("the status line");
    let field = scx
        .debug_bounds("factory-composer-field")
        .expect("the field");
    assert!(status.bottom() <= field.top(), "{status:?} over {field:?}");
    assert_eq!(status.size.height, px(24.));
    let d = slot.read_with(&scx, |v, _| {
        (
            v.drawn()
                .texts("ChatStatus")
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            v.drawn()
                .texts("ChatStatusAgents")
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            v.drawn().texts("ChatStatusClock").len(),
        )
    });
    assert_eq!(d.0, vec!["Thinking".to_string()]);
    assert_eq!(d.1, vec!["2 subagents".to_string()]);
    assert_eq!(d.2, 1, "its time ticks");
}
