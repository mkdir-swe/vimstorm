//! ⌥⌘⏎ maximizes the island with the keyboard, on the real window with real keys: an
//! editor split, the Project tree, the Chat column (Chat and Terminal mode) and the bottom panel's Git fill
//! the middle; the toolbar, the status bar, the rail and the header row stay; the label shows;
//! ⌥⌘⏎ again or Esc where it has nothing else to do restores (Insert mode's Esc only leaves
//! Insert, a PTY's Esc is the program's); a picker up ignores it; ⌘⌥A restores first; ⌃⌘⏎ does
//! nothing.
#![cfg(debug_assertions)]

use std::rc::Rc;

use gpui_kit::{Bounds, Pixels};
use vimstorm::editor::EditorView;
use vimstorm::shell::{Frame, Geometry, Island, Role};

use crate::common::terminal::wait_prompt;
use crate::common::view::View;

fn geometry(v: &mut View) -> Rc<Geometry> {
    v.pump();
    v.read(|e| e.geometry().clone())
}

/// Where a maximized island goes for this window.
fn body(v: &mut View) -> Bounds<Pixels> {
    let viewport = geometry(v).layout.frame.viewport;
    Frame::maximized(viewport, true)
}

fn maximized(v: &mut View) -> Option<Island> {
    v.pump();
    v.read_ws(|ws, cx| ws.maximized(cx))
}

fn native(v: &mut View) -> Option<&'static str> {
    v.pump();
    v.read_ws(|ws, _| ws.native_focus())
}

/// Every laid-out window grid has the size that fits its island.
fn grids_fit(e: &EditorView) -> bool {
    let g = e.geometry();
    !g.layout.wins.is_empty()
        && g.layout.wins.iter().all(|w| {
            w.role.is_some()
                || e.ui()
                    .grids
                    .get(&w.grid)
                    .is_some_and(|grid| (grid.width, grid.height) == w.cells)
        })
}

fn rail_drawn(v: &mut View) -> bool {
    v.pump();
    v.cx.debug_bounds("rail").is_some()
}

fn label(v: &mut View) -> Option<Bounds<Pixels>> {
    v.pump();
    v.cx.debug_bounds("maximized-label")
}

fn cursor(v: &View) -> String {
    format!("{:?}", v.lua("return vim.api.nvim_win_get_cursor(0)"))
}

fn wait_target(v: &mut View, want: &str) {
    v.wait_lua(
        &format!("focus.target() == {want}"),
        &format!("return require('config.focus').target() == '{want}'"),
    );
}

/// The window with the Chat column shown (its keyboard given back to the code) and the tree.
fn start() -> View {
    let mut v = View::start_projects("proj", &["a.ts", "src/b.ts"]);
    v.wait_screen("export const a = 1");
    v.key("super+digit_4");
    v.wait_until("Chat has the keyboard", |v| native(v) == Some("chat"));
    v.key("escape");
    wait_target(&mut v, "split");
    v.wait_for("the tree and the column laid out", |e| {
        let l = &e.geometry().layout;
        l.tree.is_some() && l.frame.chat.is_some()
    });
    v
}

#[test]
fn a_split_fills_the_body_and_esc_in_normal_mode_restores_insert_s_only_leaves_insert() {
    let mut v = start();
    let before = geometry(&mut v);
    let split = before
        .layout
        .wins
        .iter()
        .find(|w| w.tab_bar.is_some())
        .unwrap()
        .win;
    assert!(rail_drawn(&mut v));
    assert!(label(&mut v).is_none());
    v.keystrokes("A");
    v.keystrokes("escape");
    v.wait_until("Normal mode", |v| v.mode() == "n");
    let caret = cursor(&v);

    v.key("super+alt+enter");
    let area = body(&mut v);
    v.wait_for("the split maximized, its grid fits", |e| {
        e.geometry().layout.maximized == Some((Island::Split(split), area)) && grids_fit(e)
    });
    let g = geometry(&mut v);
    // the middle under the header row; nothing else laid out
    assert_eq!(
        area.top(),
        before.layout.frame.inner.top(),
        "the header row stays"
    );
    assert_eq!(g.layout.wins.len(), 1);
    let w = g.layout.wins[0];
    assert_eq!(w.island, area);
    // its own tab bar at the top
    let slot = g.slots();
    assert_eq!(slot.len(), 1);
    assert_eq!(slot[0].tab_bar.top(), area.top());
    assert_eq!(g.layout.tree, None);
    assert_eq!(g.layout.frame.chat, None);
    assert!(rail_drawn(&mut v), "the rail stays");
    assert!(v.cx.debug_bounds("chat-column").is_none());
    // the toolbar and the status bar as they were
    assert_eq!(g.layout.frame.toolbar, before.layout.frame.toolbar);
    assert_eq!(g.layout.frame.status, before.layout.frame.status);
    // the label at its top right
    let l = label(&mut v).expect("the label");
    assert!(l.right() <= area.right() && l.right() > area.right() - gpui_kit::px(40.));
    assert!(l.top() >= area.top() && l.bottom() <= w.grid_area.top());
    // caret, mode and the keyboard unchanged
    assert_eq!(cursor(&v), caret);
    assert_eq!(v.mode(), "n");
    assert_eq!(native(&mut v), None);

    // Insert mode: Esc only leaves it
    v.keystrokes("i");
    v.wait_until("Insert mode", |v| v.mode() == "i");
    v.key("escape");
    v.wait_until("Normal mode again", |v| v.mode() == "n");
    v.settle();
    assert_eq!(maximized(&mut v), Some(Island::Split(split)));
    // an operator pending: Esc is nvim's too
    v.keystrokes("d");
    v.wait_until("operator pending", |v| v.mode() == "no");
    v.key("escape");
    v.wait_until("Normal mode after the operator", |v| v.mode() == "n");
    v.settle();
    assert_eq!(maximized(&mut v), Some(Island::Split(split)));

    // a count typed: Esc drops it, nothing more
    v.keystrokes("5");
    v.key("escape");
    v.settle();
    assert_eq!(maximized(&mut v), Some(Island::Split(split)));
    // the search highlighted: Esc clears it first
    v.lua("vim.fn.setreg('/', 'const') vim.o.hlsearch = true vim.cmd('let v:hlsearch = 1') return true");
    v.key("escape");
    v.wait_until("the highlight cleared", |v| {
        v.lua("return vim.v.hlsearch").as_i64() == Some(0)
    });
    v.settle();
    assert_eq!(maximized(&mut v), Some(Island::Split(split)));

    // Normal mode with nothing pending: Esc restores, everything back where it was
    let caret = cursor(&v);
    v.key("escape");
    v.wait_for("restored, grids fit", |e| {
        let l = &e.geometry().layout;
        l.maximized.is_none() && l.tree.is_some() && l.frame.chat.is_some() && grids_fit(e)
    });
    let g = geometry(&mut v);
    let again = g.layout.wins.iter().find(|w| w.win == split).unwrap();
    let was = before.layout.wins.iter().find(|w| w.win == split).unwrap();
    assert_eq!((again.island, again.cells), (was.island, was.cells));
    assert!(rail_drawn(&mut v));
    assert!(label(&mut v).is_none());
    assert_eq!(cursor(&v), caret);
    assert_eq!(v.mode(), "n");
    assert!(v.nvim_errors().is_empty(), "{:?}", v.nvim_errors());
}

#[test]
fn alt_cmd_enter_again_restores_a_picker_up_ignores_it_and_ctrl_cmd_enter_does_nothing() {
    let mut v = start();
    v.key("super+alt+enter");
    v.wait_until("maximized", |v| maximized(v).is_some());
    v.key("super+alt+enter");
    v.wait_until("restored", |v| maximized(v).is_none());
    assert!(rail_drawn(&mut v));

    // nvim's cursor going to another split (⌃W w) restores: the keys would go where nothing is drawn
    v.lua("vim.cmd('rightbelow vsplit') return true");
    v.wait_for("two splits", |e| e.geometry().slots().len() == 2);
    v.key("super+alt+enter");
    v.wait_until("maximized", |v| maximized(v).is_some());
    v.keystrokes("ctrl-w w");
    v.wait_until("⌃W w restored", |v| maximized(v).is_none());
    v.lua("vim.cmd('only') return true");

    // ⌃⌘⏎ (1.0's maximize): nothing
    v.key("super+ctrl+enter");
    v.settle();
    assert_eq!(maximized(&mut v), None);

    // Go to File up: ⌥⌘⏎ maximizes nothing
    v.key("super+o");
    v.wait_until("the picker up", |v| {
        v.pump();
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).is_some())
    });
    v.key("super+alt+enter");
    v.settle();
    assert_eq!(maximized(&mut v), None);
    v.key("escape");
    v.wait_until("the picker closed", |v| {
        v.pump();
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx).is_none())
    });
}

#[test]
fn the_tree_maximizes_esc_restores_and_the_code_taking_the_keyboard_restores_first() {
    let mut v = start();
    v.key("super+digit_1");
    v.wait_until("the tree has the keyboard", |v| native(v) == Some("tree"));
    v.key("super+alt+enter");
    let area = body(&mut v);
    v.wait_until("the tree maximized", |v| {
        let l = geometry(v).layout.clone();
        l.maximized == Some((Island::Tree, area)) && l.tree == Some(area) && l.wins.is_empty()
    });
    assert!(label(&mut v).is_some());
    v.key("escape");
    v.wait_until("restored", |v| maximized(v).is_none());
    assert_eq!(native(&mut v), Some("tree"), "the tree keeps the keyboard");

    // maximized again, the code takes the keyboard (a file opened from it): restored first
    v.key("super+alt+enter");
    v.wait_until("the tree maximized again", |v| {
        maximized(v) == Some(Island::Tree)
    });
    // (the tree's ⏎ on a file gives the keyboard to the code: as Lua's focus does here)
    v.focus_code();
    v.wait_until("restored", |v| maximized(v).is_none());
}

#[test]
fn chat_maximizes_over_the_body_esc_restores_the_terminal_keeps_esc_for_the_pty() {
    let mut v = start();
    v.key("super+digit_4");
    v.wait_until("Chat has the keyboard", |v| native(v) == Some("chat"));
    v.key("super+alt+enter");
    let area = body(&mut v);
    v.wait_until("Chat maximized over the body", |v| {
        let l = geometry(v).layout.clone();
        l.maximized == Some((Island::Chat, area)) && l.frame.chat == Some(area)
    });
    let column = v.cx.debug_bounds("chat-column").expect("the column drawn");
    assert_eq!(
        column.size.width,
        area.size.width - gpui_kit::px(2.),
        "the full width"
    );
    assert!(rail_drawn(&mut v), "the rail stays");
    assert!(label(&mut v).is_some());
    v.key("escape");
    v.wait_until("restored", |v| maximized(v).is_none());
    assert_eq!(native(&mut v), Some("chat"), "Chat keeps the keyboard");

    // the bottom pane's Terminal: Esc is the program's, only ⌥⌘⏎ restores
    v.key("super+t");
    v.wait_until("the terminal has the keyboard", |v| {
        native(v) == Some("terminal")
    });
    wait_prompt(&mut v);
    v.key("super+alt+enter");
    let host = |v: &mut View| geometry(v).role_rect(Role::Terminal).map(|r| r.win);
    v.wait_until("the terminal maximized", |v| {
        let h = host(v);
        h.is_some() && maximized(v) == h.map(Island::Bottom)
    });
    v.key("escape");
    v.settle();
    assert!(matches!(maximized(&mut v), Some(Island::Bottom(_))));
    assert_eq!(native(&mut v), Some("terminal"));
    v.key("super+alt+enter");
    v.wait_until("restored by ⌥⌘⏎", |v| maximized(v).is_none());
}

#[test]
fn the_git_page_maximizes_and_the_board_restores_first() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = crate::pane::start(&base);
    v.wait_screen("export const a = 1");
    crate::common::gitui::open_git(&mut v);
    v.wait_until("Git has the keyboard", |v| native(v) == Some("git"));
    v.key("super+alt+enter");
    let area = body(&mut v);
    v.wait_until("Git maximized over the body", |v| {
        let g = geometry(v);
        let host = g.role_rect(Role::Git).map(|r| (r.win, r.island));
        host.is_some_and(|(win, island)| {
            g.layout.maximized == Some((Island::Bottom(win), area)) && island == area
        }) && g.layout.wins.len() == 1
    });
    let l = label(&mut v).expect("the label");
    assert!(
        l.right() <= area.right() - gpui_kit::px(300.),
        "left of the Git header's actions: {l:?} in {area:?}"
    );
    // a diff opened from it (the Log's ⏎): the usual layout back, the diff not behind it
    v.lua(
        "local root = require('git.cli').find_root(); \
         require('config.app.git_changes').diff(root, { { path = 'a.ts', status = 'M' } }, 1, 'HEAD')",
    );
    v.wait_until("a diff opened: restored", |v| maximized(v).is_none());
    v.lua("require('git.diff').close()");

    // the code taking the keys: the Code page (its split shown)
    v.focus_code();
    v.wait_until("the Code page", |v| {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, cx| p.page_now(cx)) == vimstorm::shell::projects::Page::Code
    });
    // ⌘⌥A (the Factory view) restores; back in the Editor nothing is maximized
    v.key("super+alt+enter");
    v.wait_until("maximized again", |v| maximized(v).is_some());
    v.key("super+alt+a");
    v.wait_until("the Factory view, restored", |v| {
        v.pump();
        let shown = v
            .projects
            .clone()
            .map(|p| p.read_with(&v.cx, |p, _| p.factory_shown()));
        shown == Some(true) && maximized(v).is_none()
    });
}

/// The Factory view (Behaviour 7): its own islands, the Board, its Chat column and its pane.
pub(crate) mod factory {
    use std::path::{Path, PathBuf};

    use gpui_kit::{Entity, Focusable as _};
    use serde_json::json;
    use vimstorm::factory::FactoryView;
    use vimstorm::shell;
    use vimstorm::shell::PaneTab;
    use vimstorm::shell::projects::FactoryIsland;
    use vimstorm::shell::projects::{Projects, RAIL_WIDTH};

    use crate::common::bridge::fixture;
    use crate::common::bridge::{fake_on, log};
    use crate::common::gitfix::git;
    use crate::common::view::View;

    fn repo(base: &Path) -> PathBuf {
        let dir = base.join("demo-shop");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.ts"), "export const a = 1;\n").unwrap();
        git(&dir, &["add", "."]);
        git(
            &dir,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "a",
            ],
        );
        dir
    }

    fn frame(dir: &Path, name: &str, frame: serde_json::Value) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, frame.to_string()).unwrap();
        path
    }

    fn unhandled(dir: &Path, slot: &str) -> PathBuf {
        frame(
            dir,
            &format!("unhandled-{slot}.json"),
            json!({"v": 2, "type": "shell", "effect": {"kind": "unhandled", "slot": slot, "key": "<Esc>"}}),
        )
    }

    /// The window on `demo-shop` in the Factory view with its Chat column: the fake bridge draws a
    /// Chat tree, opens Command mode's layer on `:`, and answers an Esc with `unhandled` (the
    /// Board's and Chat's screens had nothing open), as their screens do.
    pub(crate) fn start(base: &Path) -> (View, Entity<Projects>, Entity<FactoryView>) {
        let dir = repo(base);
        let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
        let chat = frame(
            base,
            "chat-tree.json",
            json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "slot": "chat", "tree": {
                "kind": "Island", "id": "chat", "props": {},
                "children": [{"kind": "Empty", "props": {"title": "Chat from the bridge", "line": ""}}],
            }}),
        );
        let sessions = frame(
            base,
            "sessions-tree.json",
            json!({"v": 2, "type": "tree", "screen": "sessions", "rev": 1, "slot": "pane", "tree": {
                "kind": "Island", "id": "sessions", "props": {},
                "children": [{"kind": "Empty", "props": {"title": "sessions from the bridge", "line": ""}}],
            }}),
        );
        let command = fake_on(
            base,
            &["frames/bridge-tree.json"],
            &[
                (r#""type":"open","v":2,"screen":"chat""#, vec![chat]),
                (r#""type":"open","v":2,"screen":"sessions""#, vec![sessions]),
                (r#""key":"<Esc>"}}"#, vec![unhandled(base, "main")]),
                (
                    r#""key":"<Esc>"},"slot":"chat""#,
                    vec![unhandled(base, "chat")],
                ),
                (r#""key":":"}}"#, vec![fixture("frames/bridge-layer.json")]),
            ],
        );
        v.cx.update(|_, cx| {
            cx.set_global(command);
            shell::set_column_state(cx, |s| {
                s.open = true;
                s.factory_open = true;
            });
        });
        let projects = v.projects.clone().unwrap();
        v.key("super+alt+a");
        v.wait_until("the Factory view with its column", |v| {
            v.pump();
            projects.read_with(&v.cx, |p, _| p.factory_shown())
                && v.cx.debug_bounds("factory-chat-column").is_some()
        });
        let factory = projects
            .read_with(&v.cx, |p, _| p.factory().cloned())
            .unwrap();
        (v, projects, factory)
    }

    pub(crate) fn max(v: &mut View, p: &Entity<Projects>) -> Option<FactoryIsland> {
        v.pump();
        p.read_with(&v.cx, |p, cx| p.factory_maximized(cx))
    }

    pub(crate) fn board_has_keys(v: &mut View, f: &Entity<FactoryView>) -> bool {
        v.pump();
        let f = f.clone();
        v.cx.update(|window, cx| f.read(cx).focus_handle(cx).contains_focused(window, cx))
    }

    fn board_width(v: &mut View, p: &Entity<Projects>) -> f32 {
        v.pump();
        p.read_with(&v.cx, |p, cx| p.factory().map(|f| f.read(cx).chrome_width))
            .unwrap()
    }

    pub(crate) fn drawn(v: &mut View, sel: &'static str) -> bool {
        v.pump();
        v.cx.debug_bounds(sel).is_some()
    }

    #[test]
    fn the_board_maximizes_a_layer_takes_the_first_esc_then_esc_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (mut v, projects, factory) = start(&base);
        // (the rail's move gave Chat the keys: Esc gives them to the Board)
        v.key("escape");
        v.wait_until("the Board has the keys", |v| board_has_keys(v, &factory));
        assert!(
            board_width(&mut v, &projects) > 420.,
            "the column's room off it"
        );

        v.key("super+alt+enter");
        v.wait_until("the Board maximized", |v| {
            max(v, &projects) == Some(FactoryIsland::Board)
        });
        assert!(
            !drawn(&mut v, "factory-chat-column"),
            "the column not drawn"
        );
        assert!(drawn(&mut v, "maximized-label"), "the label");
        assert_eq!(
            board_width(&mut v, &projects),
            RAIL_WIDTH,
            "the Board the whole width but the rail's"
        );
        assert!(board_has_keys(&mut v, &factory), "the keyboard stays");
        // the screen had nothing open: its `unhandled` restores
        v.key("escape");
        v.wait_until("restored by Esc", |v| max(v, &projects).is_none());
        assert!(drawn(&mut v, "factory-chat-column"), "the column back");
        assert!(!drawn(&mut v, "maximized-label"));
        assert!(board_has_keys(&mut v, &factory));

        // ⌥⌘⏎ again restores
        v.key("super+alt+enter");
        v.wait_until("maximized", |v| max(v, &projects).is_some());
        v.key("super+alt+enter");
        v.wait_until("restored by ⌥⌘⏎", |v| max(v, &projects).is_none());

        // Command mode's layer up takes the first Esc
        v.key("super+alt+enter");
        v.wait_until("maximized", |v| max(v, &projects).is_some());
        v.key("shift+.");
        v.wait_until("Command mode's layer", |v| {
            v.pump();
            factory.read_with(&v.cx, |f, _| f.layer_up())
        });
        let escs = |base: &Path| {
            log(base)
                .iter()
                .filter(|l| l.contains(r#""key":"<Esc>"}}"#))
                .count()
        };
        let before = escs(&base);
        v.key("escape");
        v.wait_until("the Esc reached the layer", |v| {
            v.pump();
            escs(&base) > before
        });
        v.pump();
        assert_eq!(
            max(&mut v, &projects),
            Some(FactoryIsland::Board),
            "the layer's Esc keeps it maximized"
        );
        // the layer's screen closes it (the fake answers every Esc alike)
        factory.update(&mut v.cx, |f, cx| {
            f.receive_line(r#"{"v":2,"type":"layer","rev":99,"tree":null}"#, cx)
        });
        v.wait_until("closed", |v| {
            v.pump();
            !factory.read_with(&v.cx, |f, _| f.layer_up())
        });
        assert_eq!(max(&mut v, &projects), Some(FactoryIsland::Board));
        v.key("escape");
        v.wait_until("the next Esc restores", |v| max(v, &projects).is_none());

        // ⌘⌥A restores; the Factory view comes back as it was
        v.key("super+alt+enter");
        v.wait_until("maximized", |v| max(v, &projects).is_some());
        v.key("super+alt+a");
        v.wait_until("the Editor", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        v.key("super+alt+a");
        v.wait_until("the Factory view", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        assert_eq!(max(&mut v, &projects), None, "⌘⌥A restored");
        assert!(drawn(&mut v, "factory-chat-column"));
    }

    #[test]
    fn the_factory_chat_column_and_pane_maximize_and_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (mut v, projects, factory) = start(&base);
        // Chat (the rail's move gave it the keys): the whole width, the Board under it keeps its
        // size
        v.wait_until("Chat has the keys", |v| {
            v.pump();
            !board_has_keys(v, &factory) && drawn(v, "column-chat")
        });
        let usual = board_width(&mut v, &projects);
        v.key("super+alt+enter");
        v.wait_until("Chat maximized", |v| {
            max(v, &projects) == Some(FactoryIsland::Chat)
        });
        let viewport = v.cx.update(|window, _| window.viewport_size());
        // the middle: right of the rail, under the header's row
        let area = vimstorm::shell::Frame::maximized(viewport, true);
        let col = v.cx.debug_bounds("factory-chat-column").unwrap();
        assert!(
            (col.size.width - area.size.width).abs() < gpui_kit::px(1.)
                && (col.left() - area.left()).abs() < gpui_kit::px(1.),
            "{col:?} in {area:?}"
        );
        assert!(drawn(&mut v, "maximized-label"));
        assert_eq!(
            board_width(&mut v, &projects),
            usual,
            "the Board keeps its size"
        );
        // Chat's screen had nothing open: restores, the keys stay in Chat
        v.key("escape");
        v.wait_until("restored by Esc", |v| max(v, &projects).is_none());
        let col = v.cx.debug_bounds("factory-chat-column").unwrap();
        assert!((f32::from(col.size.width) - 420.).abs() < 1., "{col:?}");
        assert!(!board_has_keys(&mut v, &factory), "the keys stay in Chat");
        // ⌥⌘⏎ again restores too
        v.key("super+alt+enter");
        v.wait_until("Chat maximized", |v| max(v, &projects).is_some());
        v.key("super+alt+enter");
        v.wait_until("restored", |v| max(v, &projects).is_none());

        // Boxes (its tile: the pane filling the middle), its Chat hidden: the list maximizes over
        // the middle, Esc restores, so does ⌥⌘⏎
        v.click_place("boxes");
        v.key("super+alt+digit_2");
        let pane = |v: &mut View| {
            v.pump();
            projects.read_with(&v.cx, |p, cx| {
                p.factory_pane_view().map(|f| {
                    let f = f.read(cx);
                    (f.tab(), f.focus_handle(cx))
                })
            })
        };
        v.wait_until("the pane on Boxes with the keys", |v| {
            let Some((tab, focus)) = pane(v) else {
                return false;
            };
            tab == Some(PaneTab::Boxes)
                && v.cx.update(|window, cx| focus.contains_focused(window, cx))
        });
        v.key("super+alt+enter");
        v.wait_until("the pane maximized", |v| {
            max(v, &projects) == Some(FactoryIsland::Pane)
        });
        let drawn_pane = v.cx.debug_bounds("factory-pane").expect("drawn");
        assert!(
            (drawn_pane.size.height - area.size.height).abs() < gpui_kit::px(2.)
                && (drawn_pane.size.width - area.size.width).abs() < gpui_kit::px(2.),
            "{drawn_pane:?} in {area:?}"
        );
        assert!(!drawn(&mut v, "factory-chat-column"));
        // the screen lays its rows out for the maximized pane at once, no key pressed:
        // `resize {slot: pane}` with the room it fills now
        let pane_height = |line: &str| {
            let f: serde_json::Value = serde_json::from_str(line).ok()?;
            (f["type"] == "resize" && f["slot"] == "pane").then(|| f["size"]["height"].as_f64())?
        };
        let tall = f64::from(f32::from(drawn_pane.size.height)) - 80.;
        v.wait_until("the pane's screen told its maximized size", |_| {
            log(&base)
                .iter()
                .rev()
                .find_map(|l| pane_height(l))
                .is_some_and(|h| h >= tall)
        });
        v.key("escape");
        v.wait_until("restored by Esc", |v| max(v, &projects).is_none());
        v.key("super+alt+enter");
        v.wait_until("the pane maximized", |v| max(v, &projects).is_some());
        v.key("super+alt+enter");
        v.wait_until("⌥⌘⏎ restored", |v| max(v, &projects).is_none());
    }
}
