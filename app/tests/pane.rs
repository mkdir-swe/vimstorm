//! The panes, on the real window with real keys and a fake bridge. The Boxes and Pipelines tiles
//! fill the middle with the Factory view's pane: its screen is the bridge's `pane` slot (`open
//! {screen, slot: pane}` when shown, its tree drawn there), its list has the keys while the tile's
//! Chat is hidden and keeps them through Esc on a filtered list and a menu over it. The Editor's
//! bottom pane (Problems under the Feel vscode; Lua's `config.app.pane`) opens at least 8 rows
//! tall, keeps its height across hide / show and drags taller by its top edge.
#![cfg(debug_assertions)]

use std::path::{Path, PathBuf};

use gpui_kit::{Modifiers, MouseButton, MouseMoveEvent, MouseUpEvent, px};
use serde_json::json;
use vimstorm::shell::PaneTab;
use vimstorm::shell::projects::{RAIL_WIDTH, Tile};

use crate::common::bridge::{fake_on, fixture, log};
use crate::common::gitfix::git;
use crate::common::view::View;

/// A repo with one commit.
pub(crate) fn repo(base: &Path) -> PathBuf {
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

/// `tree {slot: pane}` frames for the pane's screens, written into `dir`: an Island with an Empty
/// titled after the screen.
fn pane_tree(dir: &Path, screen: &str) -> PathBuf {
    let path = dir.join(format!("{screen}-tree.json"));
    let tree = json!({
        "kind": "Island", "id": screen, "props": {},
        "children": [{"kind": "Empty", "props": {"title": format!("{screen} from the bridge"), "line": ""}}],
    });
    std::fs::write(
        &path,
        json!({"v": 2, "type": "tree", "screen": screen, "rev": 1, "tree": tree, "slot": "pane"})
            .to_string(),
    )
    .unwrap();
    path
}

/// The window on `demo-shop` with the fake bridge answering the pane's screens.
pub(crate) fn start(base: &Path) -> View {
    let dir = repo(base);
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let sessions = pane_tree(base, "sessions");
    let boxes = pane_tree(base, "boxes");
    let command = fake_on(
        base,
        &["frames/bridge-tree.json"],
        &[
            (r#""type":"open","v":2,"screen":"sessions""#, vec![sessions]),
            (r#""type":"open","v":2,"screen":"boxes""#, vec![boxes]),
        ],
    );
    v.cx.update(|_, cx| cx.set_global(command));
    v
}

/// The Editor's pane: open, its tab, whether its host has the keyboard.
pub(crate) fn host(v: &mut View) -> (bool, PaneTab, bool) {
    v.pump();
    v.read_ws(|ws, cx| {
        let p = ws.pane().read(cx);
        (p.is_open(), p.tab(), ws.native_focus() == Some("pane"))
    })
}

/// The tile shown and the Factory view's pane's tab.
fn place(v: &mut View) -> (Tile, Option<PaneTab>) {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| {
        let tab = p.factory_pane_view().and_then(|f| f.read(cx).tab());
        (p.tile_now(cx), tab)
    })
}

/// The Factory view's pane has the keys.
fn pane_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let pane = projects.read_with(&v.cx, |p, _| p.factory_pane_view().cloned());
    v.cx.update(|window, cx| pane.is_some_and(|p| p.read(cx).has_keyboard(window, cx)))
}

/// The Boxes tile (clicked), its Chat hidden (⌘⌥2): the list has the keys.
fn to_boxes(v: &mut View) {
    v.click_place("boxes");
    v.wait_until("the Boxes tile", |v| {
        place(v) == (Tile::Boxes, Some(PaneTab::Boxes))
    });
    v.key("super+alt+digit_2");
    v.wait_until("the list has the keys", pane_keys);
}

/// The Editor's pane on Problems (`config.app.pane`, ⇧⌘M's under the Feel vscode), with the keys.
fn show_problems(v: &mut View) {
    v.lua("require('config.app.pane').show('problems') return true");
    v.wait_until("the pane on Problems", |v| {
        host(v) == (true, PaneTab::Problems, true)
    });
}

fn hide_pane(v: &mut View) {
    v.lua("require('config.app.pane').hide() return true");
    v.wait_until("the pane hidden", |v| !host(v).0);
}

/// The labels of the pane header's tabs and the one boxed, and its own tabs (none).
fn header(v: &mut View) -> (Vec<String>, usize, usize) {
    v.pump();
    v.read_ws(|ws, cx| {
        let h = ws.pane().read(cx).header().read(cx);
        let lead = h.lead().cloned().expect("the pane's tabs");
        (
            lead.tabs.iter().map(|t| t.label.to_string()).collect(),
            lead.selected.unwrap_or(usize::MAX),
            h.tabs().len(),
        )
    })
}

fn opened(base: &Path, screen: &str) -> bool {
    log(base).iter().any(|l| {
        l.contains(r#""type":"open""#)
            && l.contains(&format!(r#""screen":"{screen}""#))
            && l.contains(r#""slot":"pane""#)
    })
}

fn pane_rows(v: &mut View) -> i64 {
    v.lua("local w = require('config.app.pane').win() return w and vim.api.nvim_win_get_height(w) or -1")
        .as_i64()
        .unwrap()
}

#[test]
fn the_boxes_and_pipelines_tiles_show_their_screen_in_the_pane_slot() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = start(&base);
    // the Boxes tile: the bridge opens `boxes` in the pane slot and its tree draws in the pane
    to_boxes(&mut v);
    v.wait_until("boxes opened in the pane slot", |_| opened(&base, "boxes"));
    let projects = v.projects.clone().unwrap();
    let slot = projects.read_with(&v.cx, |p, cx| {
        p.factory_pane_view()
            .and_then(|f| f.read(cx).content().slot.clone())
    });
    let slot = slot.expect("the pane slot's view");
    v.wait_until("its tree drawn in the pane", |v| {
        v.pump();
        slot.read_with(&v.cx, |s, _| {
            s.drawn().texts("Empty") == ["boxes from the bridge"]
        })
    });
    // the middle: right of the rail, under the header's row
    let pane =
        v.cx.debug_bounds("factory-pane-place")
            .expect("the pane drawn");
    let drawn =
        v.cx.debug_bounds("factory-slot-pane")
            .expect("the slot drawn");
    assert!(pane.contains(&drawn.center()), "{pane:?} {drawn:?}");
    assert_eq!(pane.left(), px(RAIL_WIDTH));
    let header = v.cx.debug_bounds("rail-header").expect("the header's row");
    assert!(header.bottom() <= pane.top(), "{header:?} {pane:?}");
    // its tile: Pipelines, its screen opened in the pane slot
    v.click_place("pipelines");
    v.wait_until("the Pipelines tile", |v| {
        place(v) == (Tile::Pipelines, Some(PaneTab::Pipelines))
    });
    v.wait_until("pipelines opened in the pane slot", |_| {
        opened(&base, "pipelines")
    });
}

/// The window whose fake bridge answers `boxes` in the pane with the contract's filtered list
/// (`/pin` typed: the Table's `filter` on).
fn start_filtered(base: &Path) -> View {
    let dir = repo(base);
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let tree: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/sessions-filter.json")).unwrap(),
    )
    .unwrap();
    let path = base.join("boxes-filter-tree.json");
    std::fs::write(
        &path,
        json!({"v": 2, "type": "tree", "screen": "boxes", "rev": 1, "tree": tree, "slot": "pane"})
            .to_string(),
    )
    .unwrap();
    let command = fake_on(
        base,
        &["frames/bridge-tree.json"],
        &[(r#""type":"open","v":2,"screen":"boxes""#, vec![path])],
    );
    v.cx.update(|_, cx| cx.set_global(command));
    v
}

#[test]
fn esc_on_a_filtered_list_is_the_list_s_and_the_keys_stay_in_the_pane() {
    let base = tempfile::tempdir().unwrap();
    let mut v = start_filtered(base.path());
    to_boxes(&mut v);
    v.wait_until("the filtered tree drawn", |_| opened(base.path(), "boxes"));
    v.settle();
    // Esc goes to the screen (it clears its filter) and the pane keeps the keyboard
    v.key("escape");
    v.settle();
    assert!(pane_keys(&mut v), "the pane keeps the keys");
    v.wait_until("Esc to the screen", |_| {
        log(base.path())
            .iter()
            .any(|l| l.contains(r#""key":"<Esc>""#) && l.contains(r#""slot":"pane""#))
    });
}

#[test]
fn the_editor_pane_s_height_survives_hide_and_show() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = start(&base);
    // a third of nvim's rows at first, then as dragged, kept while hidden
    show_problems(&mut v);
    let lines = v.lua("return vim.o.lines").as_i64().unwrap();
    let rows = pane_rows(&mut v);
    assert!((rows - lines / 3).abs() <= 1, "{rows} of {lines}");
    v.lua("vim.api.nvim_win_set_height(require('config.app.pane').win(), 9) return true");
    hide_pane(&mut v);
    show_problems(&mut v);
    assert_eq!(pane_rows(&mut v), 9, "its height survived");
    // the Board and back: the same height
    v.key("super+alt+a");
    v.wait_until("the Board", |v| place(v).0 == Tile::Board);
    v.key("super+alt+a");
    v.wait_until("the workspace again", |v| place(v).0 != Tile::Board);
    show_problems(&mut v);
    assert_eq!(pane_rows(&mut v), 9, "the Editor's own height");
}

#[test]
fn the_pane_opens_at_least_8_rows_tall_whatever_height_was_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = start(&base);
    // a height kept from a 2-row bottom tool window (a Git window squeezed once, a session's):
    // the pane still opens 8 rows tall, its Sessions rows under the header
    v.lua("require('config.bottom').set_height(2) return true");
    show_problems(&mut v);
    assert_eq!(pane_rows(&mut v), 8);
    // a sane height kept is the height it opens at
    v.lua("vim.api.nvim_win_set_height(require('config.app.pane').win(), 11) return true");
    hide_pane(&mut v);
    show_problems(&mut v);
    assert_eq!(pane_rows(&mut v), 11);
}

/// The Editor pane's top edge (the gap over its header, full width, nvim's separator row above
/// the bottom tool window).
fn pane_edge(v: &mut View) -> vimstorm::shell::Gap {
    use vimstorm::shell::GapKind;
    // laid out as nvim has its windows now
    let top = |v: &mut View| {
        v.lua("local w = require('config.app.pane').win() return w and vim.fn.win_screenpos(w)[1] - 1 or -1")
            .as_i64()
            .unwrap()
    };
    v.wait_until("the pane laid out where nvim has it", |v| {
        let want = top(v);
        v.pump();
        v.read(|e| e.geometry().layout.bottom_row) == usize::try_from(want).ok()
    });
    let g = v.read(|e| e.geometry().clone());
    let row = g.layout.bottom_row.expect("a bottom tool window");
    *g.layout
        .gaps
        .iter()
        .find(|gap| matches!(gap.kind, GapKind::Horizontal { row: r, col: 0 } if r + 1 == row))
        .expect("the pane's top edge")
}

/// A left drag on the pane's top edge (separator `row`) from `from`, `dy` px down (up when
/// negative), its pointer moving there in `steps` once nvim took the press.
fn drag_by(
    v: &mut View,
    row: usize,
    from: gpui_kit::Point<gpui_kit::Pixels>,
    dy: f32,
    steps: usize,
) {
    let to = gpui_kit::point(from.x, from.y + px(dy));
    v.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    v.wait_lua(
        "nvim took the press",
        &format!("return vim.fn.getmousepos().screenrow == {}", row + 1),
    );
    for i in 1..=steps {
        let f = i as f32 / steps as f32;
        v.cx.simulate_event(MouseMoveEvent {
            position: gpui_kit::point(from.x, from.y + px(dy * f)),
            pressed_button: Some(MouseButton::Left),
            modifiers: Modifiers::default(),
        });
    }
    v.cx.simulate_event(MouseUpEvent {
        position: to,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
}

#[test]
fn the_editor_pane_s_top_edge_drags_it_taller_even_on_its_header_s_edge() {
    use vimstorm::shell::GapKind;
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = start(&base);
    show_problems(&mut v);
    v.wait_until("the pane drawn", |v| {
        v.pump();
        v.cx.debug_bounds("pane-host").is_some()
    });
    let row_h = v.read(|e| e.geometry().layout.y.scale);
    let before = pane_rows(&mut v);

    // pressed on the edge's lowest px: inside the pane's island, over its header (where the
    // resize cursor shows), the press is the edge's, not the header's
    let edge = pane_edge(&mut v);
    let pane = v.cx.debug_bounds("pane-host").unwrap();
    let from = gpui_kit::point(edge.bounds.center().x, edge.bounds.bottom() - px(1.));
    assert!(pane.contains(&from), "{pane:?} holds {from:?}");
    let GapKind::Horizontal { row, .. } = edge.kind else {
        unreachable!()
    };
    drag_by(&mut v, row, from, -6. * row_h, 20);
    v.wait_until("6 rows taller", |v| pane_rows(v) == before + 6);

    // dragged down over the pane's own rows: shorter again
    let edge = pane_edge(&mut v);
    let GapKind::Horizontal { row, .. } = edge.kind else {
        unreachable!()
    };
    drag_by(&mut v, row, edge.bounds.center(), 3. * row_h, 6);
    v.wait_until("3 rows shorter", |v| pane_rows(v) == before + 3);

    // with a picker up, a press on the edge is outside the picker: it closes, nothing drags
    v.key("escape");
    v.wait_until("the keys back in the editor", |v| !host(v).2);
    v.key("super+o");
    v.wait_until("the picker up", |v| {
        v.pump();
        v.read_ws(|ws, cx| ws.pickers().read(cx).is_open())
    });
    let edge = pane_edge(&mut v);
    v.cx.simulate_mouse_down(
        edge.bounds.center(),
        MouseButton::Left,
        Modifiers::default(),
    );
    v.cx.simulate_event(MouseUpEvent {
        position: edge.bounds.center(),
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
    v.wait_until("the picker closed", |v| {
        v.pump();
        v.read_ws(|ws, cx| !ws.pickers().read(cx).is_open())
    });
    assert_eq!(pane_rows(&mut v), before + 3);
}

/// Feel vscode: ⌘⇧M shows Code's bottom panel on Problems with the keyboard (its header leads with
/// the panel's tabs, Problems boxed): VS Code's words while there are none, then the workspace's
/// diagnostics by file; ⏎ on a problem opens its file there with the keyboard in the code. Any
/// other Feel keeps Problems (every Feel's panel tab now).
#[test]
fn feel_vscode_problems_tab_lists_the_diagnostics_and_enter_opens_one() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = start(&base);
    v.set_feel(|f| f.feel = vimstorm::factory::FeelName::Vscode);
    v.wait_lua(
        "the VS Code keys",
        "return require('config.keymap_vscode').active()",
    );
    v.key("super+shift+m");
    v.wait_until("the pane on Problems", |v| {
        host(v) == (true, PaneTab::Problems, true)
    });
    let tabs = ["Terminal", "Git", "Problems"].map(str::to_owned).to_vec();
    assert_eq!(header(&mut v), (tabs.clone(), 2, 0));
    let rows = |v: &mut View| {
        v.read_ws(|ws, cx| ws.pane().read(cx).problems().read(cx).delegate.row_texts())
    };
    assert!(rows(&mut v).is_empty());
    assert!(
        v.cx.debug_bounds("pane-problems").is_none(),
        "VS Code's empty words"
    );
    v.lua(
        "vim.diagnostic.set(vim.api.nvim_create_namespace('pane_problems'), vim.fn.bufnr('a.ts'), \
           { { lnum = 0, col = 7, message = \"Cannot find name 'x'.\", severity = vim.diagnostic.severity.ERROR, \
               source = 'ts', code = 2304 } }) return true",
    );
    v.wait_until("a.ts and its problem listed", |v| {
        rows(v)
            == [
                "a.ts 1".to_owned(),
                "Cannot find name 'x'. ts(2304) [Ln 1, Col 8]".to_owned(),
            ]
    });
    v.wait_until("drawn in the pane", |v| {
        v.cx.debug_bounds("pane-problems").is_some()
    });
    v.key("ö");
    v.key("enter");
    v.wait_lua(
        "⏎ opened a.ts at the problem, the keyboard in the code",
        "return vim.fn.expand('%:t') == 'a.ts' and vim.api.nvim_win_get_cursor(0)[2] == 7 \
           and require('config.focus').target() == 'split'",
    );
    // any other Feel: Problems stays
    v.set_feel(|_| {});
    v.settle();
    assert_eq!(header(&mut v), (tabs, 2, 0));
}

/// `layer {rev, tree}` frame files in `dir`: the contract's tree at `rel`, or none (closed).
fn layer_file(dir: &Path, rel: Option<&str>, rev: u64) -> PathBuf {
    let tree = rel.map_or(serde_json::Value::Null, |rel| {
        serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
    });
    let path = dir.join(format!("layer-{rev}.json"));
    std::fs::write(
        &path,
        json!({"v": 2, "type": "layer", "rev": rev, "tree": tree}).to_string(),
    )
    .unwrap();
    path
}

/// The `focus` frames the bridge was sent, each its slot (`null`: none).
fn focus_frames(base: &Path) -> Vec<String> {
    log(base)
        .iter()
        .filter_map(|l| {
            let f: serde_json::Value = serde_json::from_str(l).ok()?;
            (f["type"] == "focus").then(|| f["slot"].as_str().unwrap_or("null").to_owned())
        })
        .collect()
}

#[test]
fn a_menu_over_the_boxes_list_and_closed_never_tells_the_bridge_the_pane_lost_the_keys() {
    // the bridge tells the list under a layer it lost the keys to the layer and keeps its
    // held order; the app moving the keyboard to draw the layer over the Editor must not read
    // as the pane losing them for real
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let dir = repo(&base);
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let boxes = pane_tree(&base, "boxes");
    let menu = layer_file(&base, Some("trees/box-menu.json"), 1);
    let closed = layer_file(&base, None, 2);
    let command = fake_on(
        &base,
        &["frames/bridge-tree.json"],
        &[
            (r#""type":"open","v":2,"screen":"boxes""#, vec![boxes]),
            (r#""key":"<D-CR>"},"slot":"pane""#, vec![menu]),
            // (Esc from any slot: the layer has the keys over the list)
            (r#""key":"<Esc>"}"#, vec![closed]),
        ],
    );
    v.cx.update(|_, cx| cx.set_global(command));
    to_boxes(&mut v);
    v.wait_until("the bridge told the pane has them", |_| {
        focus_frames(&base).last().map(String::as_str) == Some("pane")
    });
    let before = focus_frames(&base).len();
    v.key("super+enter");
    v.wait_until("the menu over the list", |v| {
        v.pump();
        v.cx.debug_bounds("factory-menu").is_some() || v.cx.debug_bounds("factory-pick").is_some()
    });
    v.key("escape");
    v.wait_until("the menu closed, the keys back in the pane", |v| {
        v.pump();
        v.cx.debug_bounds("factory-menu").is_none()
            && v.cx.debug_bounds("factory-pick").is_none()
            && pane_keys(v)
    });
    v.settle();
    let after: Vec<String> = focus_frames(&base).split_off(before);
    assert!(
        after.iter().all(|s| s == "pane"),
        "the keys went nowhere but the pane: {after:?}"
    );
}
