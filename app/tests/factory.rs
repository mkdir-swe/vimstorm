//! The Factory view's own rules, with a fake `abe ui bridge`
//! (`tests/fixtures/factory/fake-bridge.sh`): the bridge's lifecycle (told hello and the shown
//! project, started once more, then said stopped), the frames it takes or drops, keys and the
//! mouse reaching it, trees held under the pointer, which view shows and whether the window is in
//! front; and the view in the real window: ⌘⌥A, Command mode over the Editor, a launch's Chat, the
//! Pipelines tile's pane, New workspace and Settings. What the trees draw is `contract.rs` and `factory_layout.rs`.
// GPUI records debug selectors only with debug assertions.
#![cfg(debug_assertions)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gpui_kit::{
    Entity, Focusable as _, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, ScrollDelta,
    TestAppContext, TestDispatcher, VisualTestContext, WindowOptions, point, px, size,
};
use serde_json::{Value, json};
use vimstorm::factory::{FIRST_SCREEN, FactoryView, Slot, SlotView};
use vimstorm::shell::PaneTab;
use vimstorm::shell::projects::{ChatMemory, ChatSize, Page, Tile, TileMemory};

use crate::common::bridge::{Win, fake, fake_on, fixture, layer_frame, log};
use crate::common::bridge::{echo_script, screen, started};
use crate::common::gitfix::git;
use crate::common::view::View;

/// The input frames the bridge was sent, in order.
fn inputs(dir: &Path) -> Vec<String> {
    log(dir)
        .into_iter()
        .filter(|l| l.contains(r#""type":"input""#))
        .collect()
}

/// The `input` of each input frame the bridge was sent, as JSON (`{"kind":"key","key":"r"}`).
fn sent(dir: &Path) -> Vec<String> {
    inputs(dir)
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|v| v["input"].to_string())
        .collect()
}

/// Waits until the bridge has heard everything the view sent so far: a `project` frame as the
/// last of them.
fn heard(w: &mut Win, dir: &Path, mark: &str) {
    let root = format!("/heard/{mark}");
    let want = root.clone();
    w.view.update(&mut w.cx, |v, _| v.set_root(Some(root)));
    w.wait(&format!("{mark}: told"), |_| {
        log(dir)
            .iter()
            .any(|l| l.contains(r#""type":"project""#) && l.contains(&want))
    });
}

fn tree_of(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
}

/// `tree` as the bridge's tree frame of `rev` on `screen`.
fn tree_line(screen: &str, rev: u64, tree: &Value) -> String {
    json!({"v": 2, "type": "tree", "screen": screen, "rev": rev, "tree": tree}).to_string()
}

fn receive(w: &mut Win, line: &str) {
    w.view.update(&mut w.cx, |v, cx| v.receive_line(line, cx));
    w.cx.run_until_parked();
}

fn focused(w: &mut Win) -> bool {
    let view = w.view.clone();
    w.cx.update(|window, cx| view.focus_handle(cx).is_focused(window))
}

/// Runs each row, its failure named.
fn rows<R>(rows: &[R], name: impl Fn(&R) -> &str, run: impl Fn(&R)) {
    for row in rows {
        let done = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(row)));
        if let Err(e) = done {
            let why = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default();
            panic!("{}: {why}", name(row));
        }
    }
}

// --- the bridge's lifecycle ---

#[test]
fn the_bridge_is_told_hello_opens_the_first_screen_and_hears_the_shown_project() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut w = Win::open(Some(fake(d, &["frames/bridge-tree.json"], None)));
    // nothing drawn until the bridge answers
    assert_eq!(w.drawn("Empty"), ["Starting abe ui bridge"]);
    w.view.update(&mut w.cx, |v, _| {
        v.set_root(Some("/home/me/projects/demo-shop".into()))
    });
    w.start();
    w.wait("the bridge's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    let started = log(d);
    assert_eq!(started[0], "start ui bridge");
    let hello: Value = serde_json::from_str(&started[1]).unwrap();
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["size"]["width"], 1000.0);
    assert_eq!(hello["root"], "/home/me/projects/demo-shop");
    assert_eq!(
        started[2],
        r#"{"type":"open","v":2,"screen":"factory","params":{}}"#
    );
    // another project shown while it runs: told as `project`
    w.view.update(&mut w.cx, |v, _| {
        v.set_root(Some("/home/me/projects/demo-api".into()))
    });
    w.wait("project", |_| {
        log(d)
            .iter()
            .any(|l| l == r#"{"type":"project","v":2,"root":"/home/me/projects/demo-api"}"#)
    });
}

/// A bridge dying: (row, how often the fake dies, whether the view then says it stopped).
const DEATHS: &[(&str, &str, bool)] = &[
    ("dies once", "once", false),
    ("dies each time", "always", true),
];

#[test]
fn a_dead_bridge_is_started_once_more_then_said_stopped() {
    rows(
        DEATHS,
        |r| r.0,
        |&(_, die, stops)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut w = Win::open(Some(fake(d, &["frames/bridge-tree.json"], Some(die))));
            w.start();
            w.wait("started again", |w| {
                w.view.read_with(&w.cx, |v, _| {
                    v.starts() == 2 && (v.rev() == Some(1) || v.stopped().is_some())
                })
            });
            if stops {
                w.wait("stopped", |w| {
                    w.view.read_with(&w.cx, |v, _| v.stopped().is_some())
                });
                assert_eq!(w.view.read_with(&w.cx, |v, _| v.starts()), 2, "one restart");
                assert_eq!(w.drawn("Empty"), ["abe ui bridge stopped"]);
                return;
            }
            // the second one keeps running and answers
            w.keys(&["a"]);
            w.wait("the key reached the second", |_| {
                log(d).last().is_some_and(|l| l.contains(r#""key":"a""#))
            });
            let starts = log(d).iter().filter(|l| l.starts_with("start")).count();
            assert_eq!(starts, 2);
            assert!(w.view.read_with(&w.cx, |v, _| v.stopped().is_none()));
        },
    );
}

/// A frame older than the one drawn: (row, the newer frame, the older one); a layer frame of
/// `None` closes the layer.
const OLDER: &[(&str, bool, &str, &str)] = &[
    (
        "a tree",
        false,
        "trees/status-unreachable.json",
        "trees/status-asking.json",
    ),
    (
        "a layer",
        true,
        "trees/command-confirm.json",
        "trees/command-pick.json",
    ),
];

#[test]
fn a_frame_older_than_the_one_drawn_is_dropped() {
    rows(
        OLDER,
        |r| r.0,
        |&(_, layer, newer, older)| {
            let mut w = Win::open(None);
            let show = |w: &mut Win, rel: &str, rev: u64| {
                if layer {
                    w.layer(Some(rel), rev);
                } else {
                    w.tree(rel, rev);
                }
            };
            show(&mut w, newer, 2);
            let drawn = w.view.read_with(&w.cx, |v, _| v.drawn().items.clone());
            show(&mut w, older, 1);
            assert_eq!(
                w.view.read_with(&w.cx, |v, _| v.drawn().items.clone()),
                drawn,
                "the older frame dropped"
            );
            show(&mut w, older, 3);
            assert_ne!(
                w.view.read_with(&w.cx, |v, _| v.drawn().items.clone()),
                drawn,
                "a newer one drawn"
            );
            if layer {
                w.layer(None, 4);
                assert!(w.cx.debug_bounds("factory-pick").is_none());
                assert!(!w.view.read_with(&w.cx, |v, _| v.layer_up()));
            }
        },
    );
}

// --- keys and the mouse ---

/// Keys typed into the view: (row, the layer up, if any, the keys, the bridge's notation of each).
/// Every key is the bridge's, whatever is up: the Board's moves, a pick's filter, a dialog's
/// letters.
type Keys = (
    &'static str,
    Option<&'static str>,
    &'static [&'static str],
    &'static [&'static str],
);

const KEYS: &[Keys] = &[
    (
        "the Board",
        None,
        &[
            "r",
            "enter",
            "ä",
            "ö",
            "k",
            "tab",
            "space",
            "super+enter",
            "g",
            "i",
        ],
        &[
            "r", "<CR>", "ä", "ö", "k", "<Tab>", "<Space>", "<D-CR>", "g", "i",
        ],
    ),
    // ⌘O is Go to File in the editor (nvim's); the view's screen gets it
    ("⌘O on the view", None, &["super+o"], &["<D-o>"]),
    // ⌘O on a Settings folder row is its Choose… (the system's folder panel)
    (
        "⌘O on a Settings folder row",
        Some("trees/settings-path.json"),
        &["super+o", "escape"],
        &[r#"{"kind":"click","id":"settings:browse:7"}"#, "<Esc>"],
    ),
    (
        "a pick",
        Some("trees/command-menu.json"),
        &["m", "o", "v", "backspace", "enter"],
        &["m", "o", "v", "<BS>", "<CR>"],
    ),
    (
        "the card dialog",
        Some("trees/dialog-new-card.json"),
        &["l", "o", "o", "k", "space", "ö", "ä", "super+enter"],
        &["l", "o", "o", "k", "<Space>", "ö", "ä", "<D-CR>"],
    ),
    (
        "the comment box",
        Some("trees/command-comment.json"),
        &["o", "k", "shift+enter", "space"],
        &["o", "k", "<S-CR>", "<Space>"],
    ),
    (
        "the settings dialog",
        Some("trees/settings-appearance.json"),
        &[
            "ö",
            "enter",
            "super+enter",
            "shift+digit_7",
            "super+a",
            "tab",
            "arrow_down",
            "arrow_up",
            "super+s",
            "escape",
        ],
        &[
            "ö", "<CR>", "<D-CR>", "/", "<D-a>", "<Tab>", "<Down>", "<Up>", "<D-s>", "<Esc>",
        ],
    ),
];

#[test]
fn keys_reach_the_bridge_as_their_notation() {
    rows(
        KEYS,
        |r| r.0,
        |&(_, layer, keys, want)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut w = started(d);
            if let Some(rel) = layer {
                w.layer(Some(rel), 1);
            }
            w.keys(keys);
            heard(&mut w, d, "keys");
            // a want that is a frame's JSON (a click) as it is, any other a key
            let want: Vec<String> = want
                .iter()
                .map(|k| {
                    if k.starts_with('{') {
                        (*k).to_owned()
                    } else {
                        json!({"kind": "key", "key": k}).to_string()
                    }
                })
                .collect();
            assert_eq!(sent(d), want);
        },
    );
}

/// A part clicked: the row, the window, the tree or layer drawn, whether a layer, the parts
/// clicked, the ids the bridge hears in that order, the ids of grey parts it never hears, and
/// whether the click gives the view the keyboard (the card dialog's buttons leave it where it
/// is). These parts send their click their own way (`contract.rs` clicks the ones the drawing
/// marks).
type Click = (
    &'static str,
    (f32, f32),
    &'static str,
    bool,
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
    bool,
);

const CLICKS: &[Click] = &[
    (
        "a header tab and a Board card",
        (1000., 700.),
        "trees/factory-overview.json",
        false,
        &["factory-node-tab:team", "factory-node-card:1240"],
        &["tab:team", "card:1240"],
        &[],
        true,
    ),
    (
        "an empty column's New card row",
        (1440., 846.),
        "trees/factory-empty-column.json",
        false,
        &["factory-column-add"],
        &["newcard:Resolved"],
        &[],
        true,
    ),
    (
        "a table row",
        (1000., 700.),
        "trees/sessions.json",
        false,
        &["factory-node-session:s3"],
        &["session:s3"],
        &[],
        true,
    ),
    (
        "a pick row",
        (1000., 700.),
        "trees/command-pick.json",
        true,
        &["factory-pick-row-command:card move"],
        &["command:card move"],
        &[],
        true,
    ),
    (
        "the confirm's risky choice",
        (1000., 700.),
        "trees/command-confirm.json",
        true,
        &["factory-confirm-risky"],
        &["risky"],
        &[],
        true,
    ),
    (
        "a Linked row",
        (1000., 700.),
        "trees/linked.json",
        true,
        &["factory-linked-row-worktree"],
        &["linked:row:worktree"],
        &[],
        true,
    ),
    (
        "the story's chips, hint, primary and close; its dim chip",
        (1000., 700.),
        "trees/story-running.json",
        true,
        &[
            "factory-dialog:linked:session",
            "factory-dialog:linked:pr",
            "factory-dialog-hint",
            "factory-dialog:primary",
            "button-factory-dialog-close",
        ],
        &[
            "dialog:linked:session",
            "dialog:menu",
            "dialog:primary",
            "dialog:close",
        ],
        &["dialog:linked:pr"],
        false,
    ),
    (
        "a settings tree node",
        (1440., 900.),
        "trees/settings-appearance.json",
        true,
        &["factory-node-settings:tree:vim"],
        &["settings:tree:vim"],
        &[],
        true,
    ),
    (
        "a settings list's item, its toolbar's + − ↑ ↓",
        (1440., 900.),
        "trees/settings-list.json",
        true,
        &[
            "factory-settings-item:1",
            "factory-settings-button:settings:item-add",
            "factory-settings-button:settings:item-up:4",
            "factory-settings-button:settings:item-down:4",
            "factory-settings-button:settings:item-remove:4",
        ],
        &[
            "settings:item:1",
            "settings:item-add",
            "settings:item-up:4",
            "settings:item-down:4",
            "settings:item-remove:4",
        ],
        &[],
        true,
    ),
    (
        "a settings row's Reset",
        (1440., 900.),
        "trees/settings-reset.json",
        true,
        &["factory-settings-reset:Chat column open by default"],
        &["settings:reset:7"],
        &[],
        true,
    ),
    (
        "a settings records editor's cell, a record's ✕ and + Add",
        (1440., 900.),
        "trees/settings-records.json",
        true,
        &[
            "factory-settings-cell:0:0",
            "factory-settings-cell:1:2",
            "factory-settings-button:settings:record-remove:0",
            "factory-settings-record-add",
        ],
        &[
            "settings:cell:0:0",
            "settings:cell:1:2",
            "settings:record-remove:0",
            "settings:record-add",
        ],
        &[],
        true,
    ),
    (
        "the settings footer's Undo and Close",
        (1440., 900.),
        "trees/settings-saved.json",
        true,
        &[
            "button-factory-settings:undo",
            "button-factory-settings:close",
        ],
        &["settings:undo", "settings:close"],
        &[],
        // the footer's buttons are a button's click alone, as Retry's
        false,
    ),
    (
        "an install part's Re-check and Do again, unfolded under its strip",
        (1440., 900.),
        "trees/chat-install-part.json",
        false,
        &[
            "button-install:recheck:env-files",
            "button-install:again:env-files",
        ],
        &["install:recheck:env-files", "install:again:env-files"],
        &[],
        true,
    ),
    (
        "a run's Review changes, Open PR, a step row and its card",
        (1440., 900.),
        "trees/run-ready.json",
        false,
        &[
            "button-run:review",
            "button-run:pr",
            "factory-node-run:step:verify:1",
            "factory-node-run:card",
        ],
        &["run:review", "run:pr", "run:step:verify:1", "run:card"],
        &[],
        true,
    ),
    (
        "a verify kit recording's play/pause, a shot's full size, its page",
        (1440., 1400.),
        "trees/run-verify.json",
        false,
        &[
            "factory-node-run:recording:verify:1:0:1",
            "factory-node-run:shot:verify:1:0:0:0",
            "factory-node-run:url:verify:1:0:0:0",
        ],
        &[
            "run:recording:verify:1:0:1",
            "run:shot:verify:1:0:0:0",
            "run:url:verify:1:0:0:0",
        ],
        &[],
        true,
    ),
    (
        "a run's ticket, shut and open",
        (1440., 900.),
        "trees/run-tickets.json",
        false,
        &[
            "factory-node-run:ticket:step:1:T2",
            "factory-node-run:ticket:step:1:T1",
        ],
        &["run:ticket:step:1:T2", "run:ticket:step:1:T1"],
        &[],
        true,
    ),
    (
        "a file the build made, and a detail's fold",
        (1440., 900.),
        "trees/run-build.json",
        false,
        &[
            "factory-node-run:file:build:1:0",
            "factory-node-run:detail:build:1:commands",
        ],
        &["run:file:build:1:0", "run:detail:build:1:commands"],
        &[],
        true,
    ),
    (
        "a pipeline run's summary button",
        (1400., 900.),
        "trees/pipelines-overview.json",
        false,
        &["button-pipelines-summary-act:rerun-failed"],
        &["act:rerun-failed"],
        &[],
        true,
    ),
    (
        "a pipeline run's summary and its button: never its island's click",
        (1400., 900.),
        "trees/pipelines-overview.json",
        false,
        &[
            "pipelines-summary",
            "button-pipelines-summary-act:rerun-failed",
        ],
        &["act:rerun-failed"],
        &["pipelines"],
        true,
    ),
    (
        "a pipeline graph's box and its head's button",
        (1400., 800.),
        "trees/pipelines-graph.json",
        false,
        &["factory-node-job:90033", "button-pipelines-head-act:rerun"],
        &["job:90033", "act:rerun"],
        &[],
        true,
    ),
    (
        "local mode's pull request buttons",
        (1440., 1400.),
        "trees/local-gallery.json",
        false,
        &["factory-local-pr:merge", "factory-local-pr:diff"],
        &["local-pr:merge", "local-pr:diff"],
        &[],
        true,
    ),
    (
        "a card's grey row, an open one and its context line",
        (1000., 700.),
        "trees/cards-gallery.json",
        false,
        &[
            "factory-node-gallery:card:2",
            "factory-node-gallery:card:1",
            "factory-node-gallery:card:more",
        ],
        &["gallery:card:1", "gallery:card:more"],
        &["gallery:card:2"],
        true,
    ),
];

#[test]
fn a_click_reaches_the_bridge_by_its_id_and_gives_the_view_the_keyboard() {
    rows(
        CLICKS,
        |r| r.0,
        |&(_, (width, height), rel, layer, at, want, silent, keys)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut w = Win::open_sized(
                Some(fake(d, &["frames/bridge-tree.json"], None)),
                width,
                height,
            );
            w.start();
            w.wait("the bridge's tree", |w| {
                w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
            });
            if layer {
                w.layer(Some(rel), 1);
            } else {
                w.tree(rel, 2);
            }
            // the keyboard elsewhere first: a click takes it back
            w.cx.update(|window, cx| window.blur(cx));
            for at in at {
                w.click(Box::leak(at.to_string().into_boxed_str()));
            }
            heard(&mut w, d, "clicks");
            let clicks: Vec<String> = sent(d)
                .iter()
                .filter_map(|i| serde_json::from_str::<Value>(i).ok())
                .filter(|i| i["kind"] == "click")
                .map(|i| i["id"].as_str().unwrap_or_default().to_owned())
                .collect();
            // in order: a part's container may hear its own click too
            let mut rest = clicks.iter();
            for id in want {
                assert!(rest.any(|c| c == id), "{id} not heard in order: {clicks:?}");
            }
            for id in silent {
                assert!(!clicks.iter().any(|c| c == id), "{id} heard: {clicks:?}");
            }
            if keys {
                assert!(focused(&mut w), "the view has the keyboard");
            }
        },
    );
}

fn press_at(w: &mut Win, at: gpui_kit::Point<gpui_kit::Pixels>, button: MouseButton, count: usize) {
    w.cx.simulate_event(MouseDownEvent {
        position: at,
        modifiers: Modifiers::default(),
        button,
        click_count: count,
        first_mouse: false,
    });
    w.cx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: Modifiers::default(),
        button,
        click_count: count,
    });
    w.cx.run_until_parked();
}

fn wheel(w: &mut Win, at: gpui_kit::Point<gpui_kit::Pixels>, delta: ScrollDelta) {
    w.cx.simulate_event(gpui_kit::ScrollWheelEvent {
        position: at,
        delta,
        modifiers: Modifiers::default(),
        touch_phase: gpui_kit::TouchPhase::Moved,
    });
    w.cx.run_until_parked();
}

fn pixels(x: f32, y: f32) -> ScrollDelta {
    ScrollDelta::Pixels(point(px(x), px(y)))
}

/// The mouse on the view: (row, the window, the tree, the layer over it, what the mouse does, the
/// inputs the bridge hears).
type Mouse = (
    &'static str,
    (f32, f32),
    &'static str,
    Option<&'static str>,
    fn(&mut Win),
    &'static [&'static str],
);

const MOUSE: &[Mouse] = &[
    (
        "a right-click on a card asks for its menu, no plain click",
        (1000., 700.),
        "trees/factory-overview.json",
        None,
        |w| {
            let at = w.bounds("factory-node-card:1234").center();
            press_at(w, at, MouseButton::Right, 1);
        },
        &[r#"{"id":"menu:card:1234","kind":"click"}"#],
    ),
    (
        "a double-click on a card selects it, then asks for its story",
        (1000., 700.),
        "trees/factory-overview.json",
        None,
        |w| {
            let at = w.bounds("factory-node-card:1234").center();
            press_at(w, at, MouseButton::Left, 1);
            press_at(w, at, MouseButton::Left, 2);
        },
        &[
            r#"{"id":"card:1234","kind":"click"}"#,
            r#"{"id":"open:card:1234","kind":"click"}"#,
        ],
    ),
    (
        "a double-click on a table row is its click, then its ⏎",
        (1000., 700.),
        "trees/sessions.json",
        None,
        |w| {
            let at = w.bounds("factory-node-session:s3").center();
            press_at(w, at, MouseButton::Left, 1);
            press_at(w, at, MouseButton::Left, 2);
        },
        &[
            r#"{"id":"session:s3","kind":"click"}"#,
            r#"{"id":"session:s3","kind":"click"}"#,
            r#"{"key":"<CR>","kind":"key"}"#,
        ],
    ),
    (
        "a double-click on a Settings row's help selects its word, never opens the row",
        (1000., 700.),
        "trees/pipelines-log.json",
        Some("trees/settings-path.json"),
        |w| {
            let h = w.bounds("factory-settings-help:Your az login folder");
            let at = point(h.left() + px(6.), h.top() + px(8.));
            press_at(w, at, MouseButton::Left, 1);
            press_at(w, at, MouseButton::Left, 2);
        },
        &[],
    ),
    (
        "a click on a Settings row's value is the row's click",
        (1000., 700.),
        "trees/pipelines-log.json",
        Some("trees/settings-appearance.json"),
        |w| {
            let l = w.bounds("factory-settings-label:Theme");
            press_at(
                w,
                point(l.right() + px(16.), l.center().y),
                MouseButton::Left,
                1,
            );
        },
        &[r#"{"id":"settings:line:1","kind":"click"}"#],
    ),
    (
        "each Settings control is its own hit area: a segment, the checkbox, the combo, the \
         field, then a label and the page's empty room",
        (1440., 900.),
        "trees/pipelines-log.json",
        Some("trees/settings-appearance.json"),
        |w| {
            for at in [
                "factory-node-settings:line:0:choice:2",
                "factory-node-settings:line:7:press",
                "factory-settings-combo",
                "factory-settings-field:UI font size",
                "factory-settings-label:UI font",
            ] {
                let c = w.bounds(at).center();
                press_at(w, c, MouseButton::Left, 1);
            }
            let p = w.bounds("factory-settings-page");
            press_at(
                w,
                point(p.right() - px(24.), p.top() + px(12.)),
                MouseButton::Left,
                1,
            );
        },
        &[
            r#"{"id":"settings:line:0:choice:2","kind":"click"}"#,
            r#"{"id":"settings:line:7:press","kind":"click"}"#,
            r#"{"id":"settings:line:4:press","kind":"click"}"#,
            r#"{"id":"settings:line:5:press","kind":"click"}"#,
            r#"{"id":"settings:line:4","kind":"click"}"#,
            r#"{"id":"settings:page","kind":"click"}"#,
        ],
    ),
    (
        "a click on a cell of Settings records not open names the cell",
        (1440., 900.),
        "trees/pipelines-log.json",
        Some("trees/settings-environments.json"),
        |w| {
            let c = w.bounds("factory-node-settings:line:1:cell:1:2").center();
            press_at(w, c, MouseButton::Left, 1);
        },
        &[r#"{"id":"settings:line:1:cell:1:2","kind":"click"}"#],
    ),
    (
        "the wheel over a pick longer than its window moves its selection: two lines, a row back",
        (1000., 700.),
        "trees/factory-overview.json",
        Some("trees/command-menu-running.json"),
        |w| {
            let over = w.bounds("factory-pick").center();
            wheel(w, over, ScrollDelta::Lines(point(0., -2.)));
            wheel(w, over, pixels(0., 22.));
        },
        &[
            r#"{"key":"<Down>","kind":"key"}"#,
            r#"{"key":"<Down>","kind":"key"}"#,
            r#"{"key":"<Up>","kind":"key"}"#,
        ],
    ),
    (
        "the wheel over the Board scrolls the column under it by cards, the columns sideways by \
         columns",
        (800., 846.),
        "trees/factory-800.json",
        None,
        |w| {
            let new = w.bounds("factory-node-col:New").center();
            w.cx.simulate_mouse_move(new, None, Modifiers::default());
            // 250 px up the trackpad: two cards down, 50 px kept for the next move
            wheel(w, new, pixels(0., -250.));
            wheel(w, new, pixels(0., -60.));
            // a mouse wheel's notch: one card back up
            wheel(w, new, ScrollDelta::Lines(point(0., 1.)));
            // sideways: a column is 246 px with its gap; a scroll down drifting sideways never
            // adds to it
            wheel(w, new, pixels(-200., -400.));
            wheel(w, new, pixels(-300., 0.));
        },
        &[
            r#"{"id":"col:New","kind":"scroll","x":0,"y":2}"#,
            r#"{"id":"col:New","kind":"scroll","x":0,"y":1}"#,
            r#"{"id":"col:New","kind":"scroll","x":0,"y":-1}"#,
            r#"{"id":"col:New","kind":"scroll","x":0,"y":4}"#,
            r#"{"id":"columns","kind":"scroll","x":1,"y":0}"#,
        ],
    ),
    (
        "the wheel over a table scrolls it by whole rows, a remainder kept",
        (1000., 700.),
        "trees/sessions.json",
        None,
        |w| {
            let at = w.bounds("factory-node-session:s2").center();
            w.cx.simulate_mouse_move(at, None, Modifiers::default());
            // 75 px up the trackpad: two rows down, 15 px kept; 20 more: one; a notch up: one back
            wheel(w, at, pixels(0., -75.));
            wheel(w, at, pixels(0., -20.));
            wheel(w, at, ScrollDelta::Lines(point(0., 1.)));
        },
        &[
            r#"{"id":"sessions-table","kind":"scroll","x":0,"y":2}"#,
            r#"{"id":"sessions-table","kind":"scroll","x":0,"y":1}"#,
            r#"{"id":"sessions-table","kind":"scroll","x":0,"y":-1}"#,
        ],
    ),
];

#[test]
fn the_mouse_reaches_the_bridge_as_menus_opens_and_scrolls() {
    rows(
        MOUSE,
        |r| r.0,
        |&(_, (width, height), rel, layer, act, want)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut w = Win::open_sized(
                Some(fake(d, &["frames/bridge-tree.json"], None)),
                width,
                height,
            );
            w.start();
            w.wait("the bridge's tree", |w| {
                w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
            });
            w.tree(rel, 2);
            if let Some(layer) = layer {
                w.layer(Some(layer), 1);
            }
            act(&mut w);
            heard(&mut w, d, "the mouse");
            let want: Vec<Value> = want
                .iter()
                .map(|i| serde_json::from_str(i).unwrap())
                .collect();
            let got: Vec<Value> = sent(d)
                .iter()
                .map(|i| serde_json::from_str(i).unwrap())
                .collect();
            assert_eq!(got, want);
        },
    );
}

// --- selecting text ---

/// The mouse selecting text on a screen: (row, the tree, what the mouse and keys do, what ⌘C
/// copies then; none: nothing is selected, ⌘C is the bridge's).
type Selects = (
    &'static str,
    &'static str,
    fn(&mut Win),
    Option<&'static str>,
);

const SELECTS: &[Selects] = &[
    (
        "a drag over a job's log lines: their words, a line each",
        "trees/pipelines-log.json",
        drag_log,
        Some(
            " ✓ src/api/price.test.ts (3 tests) 12ms\n ✗ src/api/cart.test.ts > cartTotal > rounds to two decimals",
        ),
    ),
    (
        "a triple-click on the Card page's title: all of it, not its number",
        "trees/card-page.json",
        |w| {
            let t = w.bounds("factory-dialog-title");
            for clicks in 1..=3 {
                press_at(
                    w,
                    point(t.left() + px(90.), t.center().y),
                    MouseButton::Left,
                    clicks,
                );
            }
        },
        Some("Cart total includes shipping"),
    ),
    (
        "a triple-click on the Board's card popup's title: all of it, as on the page",
        "trees/factory-overview.json",
        |w| {
            let tree: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(crate::common::bridge::fixture("trees/card-page.json"))
                    .unwrap(),
            )
            .unwrap();
            let line = serde_json::json!({"v": 2, "type": "tree", "screen": "card", "rev": 3,
                "tree": tree, "slot": "popup"})
            .to_string();
            w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
            w.cx.run_until_parked();
            let t = w.bounds("factory-dialog-title");
            for clicks in 1..=3 {
                press_at(
                    w,
                    point(t.left() + px(90.), t.center().y),
                    MouseButton::Left,
                    clicks,
                );
            }
        },
        Some("Cart total includes shipping"),
    ),
    (
        "a drag from the Card page's title into its description: a blank line between blocks",
        "trees/card-page.json",
        |w| {
            let (t, h) = (
                w.bounds("factory-dialog-title"),
                w.bounds("factory-dialog-section-title-0"),
            );
            drag(
                w,
                point(t.left() + px(1.), t.center().y),
                point(h.left() + px(30.), h.bottom() + px(20.)),
            );
        },
        Some(
            "#1234 Cart total includes shipping\nUS · Active · AE · tags cart, pricing\nDescription\n\nWhy",
        ),
    ),
    (
        "Esc lets the selection go",
        "trees/pipelines-log.json",
        |w| {
            drag_log(w);
            crate::common::bridge::press(w, "escape");
        },
        None,
    ),
    (
        "a drag from a log line's number: the log's words",
        "trees/pipelines-log.json",
        |w| {
            let (a, b) = (
                w.bounds("pipelines-log-line-3"),
                w.bounds("pipelines-log-line-4"),
            );
            drag(
                w,
                point(a.left() + px(10.), a.center().y),
                point(b.right() - px(2.), b.center().y),
            );
        },
        Some(
            " ✓ src/api/price.test.ts (3 tests) 12ms\n ✗ src/api/cart.test.ts > cartTotal > rounds to two decimals",
        ),
    ),
    (
        "a double-click on a Settings help word: that word",
        "trees/pipelines-log.json",
        |w| {
            w.layer(Some("trees/settings-path.json"), 3);
            let h = w.bounds("factory-settings-help:Your az login folder");
            for clicks in 1..=2 {
                press_at(
                    w,
                    point(h.left() + px(6.), h.top() + px(8.)),
                    MouseButton::Left,
                    clicks,
                );
            }
        },
        Some("where"),
    ),
    (
        "Settings up, a press off its words: the screen's selection behind it let go",
        "trees/pipelines-log.json",
        |w| {
            drag_log(w);
            w.layer(Some("trees/settings-appearance.json"), 3);
            let f = w.bounds("factory-settings-footer");
            press_at(
                w,
                point(f.left() + px(4.), f.center().y),
                MouseButton::Left,
                1,
            );
        },
        None,
    ),
    (
        "Settings up, Esc: the screen's selection behind it let go",
        "trees/pipelines-log.json",
        |w| {
            drag_log(w);
            w.layer(Some("trees/settings-appearance.json"), 3);
            crate::common::bridge::press(w, "escape");
        },
        None,
    ),
];

/// A drag from `from` to `to` with the left button.
fn drag(
    w: &mut Win,
    from: gpui_kit::Point<gpui_kit::Pixels>,
    to: gpui_kit::Point<gpui_kit::Pixels>,
) {
    w.cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    w.cx.run_until_parked();
}

/// From the start of log line 3's words (past its number and time) to the end of line 4.
fn drag_log(w: &mut Win) {
    let (a, b) = (
        w.bounds("pipelines-log-line-3"),
        w.bounds("pipelines-log-line-4"),
    );
    drag(
        w,
        point(a.left() + px(44. + 76. + 1.), a.center().y),
        point(b.right() - px(2.), b.center().y),
    );
}

#[test]
fn a_screens_text_selects_and_copies_as_a_text_views() {
    rows(
        SELECTS,
        |r| r.0,
        |&(_, rel, act, want)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut w = started(d);
            w.tree(rel, 2);
            w.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("S".into()));
            act(&mut w);
            crate::common::bridge::press(&mut w, "super+c");
            heard(&mut w, d, "⌘C");
            let clip = w.cx.read_from_clipboard().and_then(|c| c.text());
            let to_bridge = sent(d).iter().any(|i| i.contains("<D-c>"));
            match want {
                Some(text) => {
                    assert_eq!(clip.as_deref(), Some(text));
                    assert!(!to_bridge, "⌘C on a selection went to the bridge too");
                }
                None => {
                    assert_eq!(clip.as_deref(), Some("S"));
                    assert!(to_bridge, "⌘C with nothing selected: not the bridge's");
                }
            }
        },
    );
}

/// Copying reads a screen's words in the order they were drawn: every contract tree draws them
/// in the order they are laid out.
#[test]
fn every_screens_words_are_drawn_in_reading_order() {
    let dir = crate::common::bridge::contract().join("trees");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    let mut w = Win::open_sized(None, 1440., 900.);
    let mut bad = Vec::new();
    for (rev, name) in names.iter().enumerate() {
        w.tree(
            Box::leak(format!("trees/{name}").into_boxed_str()),
            rev as u64 + 1,
        );
        let out = w.view.read_with(&w.cx, |v, _| v.misordered_texts());
        if !out.is_empty() {
            bad.push(format!("{name}: {}", out.join("; ")));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// The wheel scrolls a page taller than its view: (frame, fixture, window height, the page, a
/// part on it).
const PAGE_SCROLLS: &[(&str, &str, f32, &str, &str)] = &[
    (
        "layer",
        "trees/settings-list.json",
        900.,
        "factory-settings-page",
        "factory-settings-field",
    ),
    (
        "tree",
        "trees/factory-local-pr.json",
        300.,
        "factory-node-local-pr",
        "factory-local-pr-file-2",
    ),
];

#[test]
fn the_wheel_scrolls_a_page_taller_than_its_view() {
    for &(frame, rel, height, page, part) in PAGE_SCROLLS {
        let mut w = Win::open_sized(None, 1440., height);
        if frame == "layer" {
            w.layer(Some(rel), 1);
        } else {
            w.tree(rel, 1);
        }
        let at = w.bounds(page).center();
        let before = w.bounds(part);
        w.cx.simulate_event(gpui_kit::ScrollWheelEvent {
            position: at,
            delta: gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-200.))),
            modifiers: Modifiers::default(),
            touch_phase: gpui_kit::TouchPhase::Moved,
        });
        w.cx.run_until_parked();
        let after = w.bounds(part);
        assert!(
            after.origin.y < before.origin.y,
            "{rel}: {before:?} → {after:?}"
        );
    }
}

// --- trees held under the pointer ---

/// `factory-overview` changed by `edit`, as the tree frame of `rev` on `screen`.
fn overview_with(rev: u64, screen: &str, edit: impl FnOnce(&mut Value)) -> String {
    let mut tree = tree_of("trees/factory-overview.json");
    edit(&mut tree);
    tree_line(screen, rev, &tree)
}

/// The node with `id` in `n`.
fn node_mut<'a>(n: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    if n["id"] == id {
        return Some(n);
    }
    n.get_mut("children")?
        .as_array_mut()?
        .iter_mut()
        .find_map(|k| node_mut(k, id))
}

/// `card` taken out of its column and put in `to` at `at`.
fn move_card(tree: &mut Value, card: &str, to: &str, at: usize) {
    fn take(n: &mut Value, card: &str) -> Option<Value> {
        let kids = n.get_mut("children")?.as_array_mut()?;
        if let Some(i) = kids.iter().position(|k| k["id"] == card) {
            return Some(kids.remove(i));
        }
        kids.iter_mut().find_map(|k| take(k, card))
    }
    let c = take(tree, card).unwrap();
    let col = node_mut(tree, to).unwrap()["children"]
        .as_array_mut()
        .unwrap();
    col.insert(at.min(col.len()), c);
}

/// `factory-overview` with `card` moved to the top of the `to` column.
fn moved(card: &str, to: &str, rev: u64) -> String {
    overview_with(rev, FIRST_SCREEN, |t| move_card(t, card, to, 0))
}

/// The first card drawn in the column `col` (`New`).
fn first_in(w: &mut Win, col: &str) -> String {
    let column = w.bounds(Box::leak(
        format!("factory-node-col:{col}").into_boxed_str(),
    ));
    w.drawn("BoardCard")
        .into_iter()
        .find(|c| {
            let id = c.split_whitespace().next().unwrap().trim_start_matches('#');
            let sel: &'static str = Box::leak(format!("factory-node-card:{id}").into_boxed_str());
            column.contains(&w.bounds(sel).center())
        })
        .unwrap_or_default()
}

fn holding(w: &mut Win) -> bool {
    w.view.read_with(&w.cx, |v, _| v.holding())
}

/// The overview at 1440 with the pointer over card 1251.
fn pointer_on_the_board() -> (Win, gpui_kit::Point<gpui_kit::Pixels>) {
    let mut w = Win::open_sized(None, 1440., 846.);
    w.tree("trees/factory-overview.json", 1);
    let at = w.bounds("factory-node-card:1251").center();
    w.cx.simulate_mouse_move(at, None, Modifiers::default());
    w.cx.run_until_parked();
    (w, at)
}

/// A tree moving cards while the pointer is over the Board: (row, what happens and is checked).
const HOLDS: &[(&str, fn())] = &[
    ("new cards below move nothing drawn: drawn at once", || {
        let (mut w, _) = pointer_on_the_board();
        let line = overview_with(2, FIRST_SCREEN, |t| {
            let c = node_mut(t, "card:1258").unwrap().clone();
            let mut c2 = c.clone();
            c2["id"] = "card:1300".into();
            c2["props"]["card"] = 1300.into();
            let mut c3 = c;
            c3["id"] = "card:1301".into();
            c3["props"]["card"] = 1301.into();
            node_mut(t, "col:New").unwrap()["children"]
                .as_array_mut()
                .unwrap()
                .push(c2);
            node_mut(t, "col:Closed").unwrap()["children"]
                .as_array_mut()
                .unwrap()
                .push(c3);
        });
        receive(&mut w, &line);
        assert!(!holding(&mut w));
    }),
    ("another card selected: drawn at once", || {
        let (mut w, _) = pointer_on_the_board();
        let line = overview_with(2, FIRST_SCREEN, |t| {
            node_mut(t, "card:1234").unwrap()["props"]["selection"] = "default".into();
            node_mut(t, "card:1251").unwrap()["props"]["selection"] = "selected".into();
            move_card(t, "card:1251", "col:Active", 0);
        });
        receive(&mut w, &line);
        assert!(!holding(&mut w));
        assert_eq!(w.drawn("Selection"), ["#1251 inactive"]);
    }),
    ("another screen: drawn at once", || {
        let (mut w, _) = pointer_on_the_board();
        let line = overview_with(2, "triage", |t| move_card(t, "card:1251", "col:Active", 0));
        receive(&mut w, &line);
        assert!(!holding(&mut w));
    }),
    (
        "a card moved under the pointer: held until the hold ends",
        || {
            let (mut w, at) = pointer_on_the_board();
            let before = w.drawn("BoardCard");
            receive(&mut w, &moved("card:1251", "col:Active", 2));
            assert!(holding(&mut w));
            assert_eq!(w.drawn("BoardCard"), before, "drawn where it was aimed at");
            assert!(w.bounds("factory-node-card:1251").contains(&at));
            w.cx.executor()
                .advance_clock(vimstorm::factory::HOLD + Duration::from_millis(100));
            w.cx.run_until_parked();
            assert!(!holding(&mut w));
            assert_eq!(first_in(&mut w, "New"), "#1262 Greeted by time of day");
        },
    ),
    ("the pointer leaving the view shows a held tree", || {
        let (mut w, _) = pointer_on_the_board();
        receive(&mut w, &moved("card:1251", "col:Active", 2));
        assert!(holding(&mut w));
        w.cx.simulate_mouse_move(point(px(-20.), px(-20.)), None, Modifiers::default());
        w.cx.run_until_parked();
        assert!(!holding(&mut w));
        assert_eq!(first_in(&mut w, "New"), "#1262 Greeted by time of day");
    }),
    ("the pointer elsewhere: drawn at once", || {
        let mut w = Win::open_sized(None, 1440., 846.);
        w.tree("trees/factory-overview.json", 1);
        receive(&mut w, &moved("card:1251", "col:Active", 2));
        assert!(!holding(&mut w));
        assert_eq!(first_in(&mut w, "New"), "#1262 Greeted by time of day");
    }),
    (
        "a key, its answer, a click and the view hidden show a held tree",
        || {
            let (mut w, at) = pointer_on_the_board();
            let view = w.view.clone();
            w.cx.update(|window, cx| {
                window.activate_window();
                window.focus(&view.focus_handle(cx), cx);
            });
            receive(&mut w, &moved("card:1251", "col:Active", 2));
            assert!(holding(&mut w));
            w.keys(&["ö"]);
            assert!(!holding(&mut w), "a key shows it");
            assert_eq!(first_in(&mut w, "New"), "#1262 Greeted by time of day");
            // the key's answer moves cards: drawn at once, the pointer still over the Board
            receive(&mut w, &moved("card:1262", "col:Active", 3));
            assert!(!holding(&mut w), "the key's answer");
            // past its answer, a move under the pointer is held again
            w.cx.executor()
                .advance_clock(vimstorm::factory::INPUT_ANSWER + Duration::from_millis(100));
            w.cx.run_until_parked();
            receive(&mut w, &moved("card:1271", "col:Active", 4));
            assert!(holding(&mut w), "held again");
            w.cx.simulate_click(at, Modifiers::default());
            w.cx.run_until_parked();
            assert!(!holding(&mut w), "a click shows it");
            // the view hidden shows it, and holds nothing more until the pointer is over it again
            w.cx.executor()
                .advance_clock(vimstorm::factory::INPUT_ANSWER + Duration::from_millis(100));
            w.cx.run_until_parked();
            receive(&mut w, &moved("card:1258", "col:New", 5));
            assert!(holding(&mut w), "held under the pointer");
            w.view.update(&mut w.cx, |v, cx| v.set_shown(false, cx));
            w.cx.run_until_parked();
            assert!(!holding(&mut w), "hidden shows it");
            receive(&mut w, &moved("card:1240", "col:New", 6));
            assert!(!holding(&mut w), "nothing held once hidden");
        },
    ),
];

#[test]
fn a_tree_moving_cards_under_the_pointer_waits_for_it() {
    rows(HOLDS, |r| r.0, |&(_, row)| row());
}

// --- the layers ---

#[test]
fn the_layers_are_driven_with_real_keys_clicks_and_a_paste() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let command = fake_on(
        d,
        &["frames/bridge-tree.json"],
        &[
            (r#""key":":""#, vec![fixture("frames/bridge-layer.json")]),
            (
                r#""key":"<CR>""#,
                vec![layer_frame(d, Some("trees/command-prompt.json"), 3)],
            ),
            (
                r#""kind":"text""#,
                vec![layer_frame(d, Some("trees/command-confirm.json"), 4)],
            ),
            (
                r#""id":"risky""#,
                vec![
                    layer_frame(d, None, 5),
                    fixture("frames/bridge-shell-status.json"),
                ],
            ),
        ],
    );
    let mut w = Win::open(Some(command));
    w.start();
    w.wait("the screen", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev() == Some(1))
    });
    // `:` opens Command mode: the bridge answers with the pick
    w.keys(&["shift+."]);
    w.wait("the pick", |w| w.drawn("PickLayer") == ["Command mode"]);
    // typing and the moves are the bridge's: Rust forwards them as keys
    w.keys(&["c", "ö", "l", "backspace", "enter"]);
    w.wait("the prompt", |w| {
        w.drawn("PromptLayer") == ["abe card show <card>"]
    });
    // ⌘V pastes the clipboard as text
    w.cx.update(|_, cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string("12".into())));
    w.keys(&["super+v"]);
    w.wait("the confirm", |w| !w.drawn("ConfirmLayer").is_empty());
    w.keys(&["y", "escape"]);
    w.click("factory-confirm-risky");
    w.wait("closed", |w| !w.view.read_with(&w.cx, |v, _| v.layer_up()));
    let inputs: Vec<String> = log(d)
        .into_iter()
        .filter(|l| l.contains(r#""type":"input""#))
        .collect();
    assert_eq!(
        inputs,
        [
            r#"{"type":"input","v":2,"input":{"kind":"key","key":":"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"c"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"ö"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"l"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"<BS>"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"<CR>"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"text","text":"12"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"y"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"<Esc>"}}"#,
            r#"{"type":"input","v":2,"input":{"kind":"click","id":"risky"}}"#,
        ]
    );
}

#[test]
fn the_card_dialog_tells_the_bridge_how_far_it_scrolls_once_and_scrolls_as_told() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let command = fake_on(
        d,
        &["frames/bridge-tree.json"],
        &[
            (
                r#""key":"i""#,
                vec![layer_frame(d, Some("trees/command-dialog.json"), 1)],
            ),
            (
                r#""key":"ö""#,
                vec![layer_frame(
                    d,
                    Some("trees/command-dialog-scrolled.json"),
                    2,
                )],
            ),
            (r#""key":"<Esc>""#, vec![layer_frame(d, None, 3)]),
        ],
    );
    let mut w = Win::open(Some(command));
    w.start();
    w.wait("the screen", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev().is_some())
    });
    w.keys(&["i"]);
    w.wait("the dialog", |w| w.drawn("CardDialog").len() == 1);
    assert_eq!(
        w.view.read_with(&w.cx, |v, _| v.dialog_draw().scrolled()),
        0.
    );
    // the page as drawn tells the bridge how far it scrolls, in `l` / `ö` steps, once while it
    // stays the same
    w.wait("the extent told", |w| {
        let lines = w.view.read_with(&w.cx, |v, _| {
            let max = v.dialog_draw().draw.scroll.max_offset().y.as_f32();
            vimstorm::factory::extent_lines(max)
        });
        let told = format!(r#""type":"extent","v":2,"id":"dialog:1234","lines":{lines}"#);
        lines > 0 && log(d).iter().any(|l| l.contains(&told))
    });
    let extents = log(d)
        .iter()
        .filter(|l| l.contains(r#""type":"extent""#))
        .count();
    assert_eq!(extents, 1, "told once while it stays the same");
    // `ö` is the bridge's to answer: here 2 lines down
    w.keys(&["ö"]);
    w.wait("scrolled", |w| {
        w.view.read_with(&w.cx, |v, _| v.dialog_draw().scrolled()) == 44.
    });
    // Esc: the bridge closes it, the view keeps the keyboard
    w.keys(&["escape"]);
    w.wait("closed", |w| !w.view.read_with(&w.cx, |v, _| v.layer_up()));
    assert!(focused(&mut w));
}

// --- which view shows, the window in front ---

/// The view in a window that never draws it, as the real window does while the Editor shows.
struct Holder(Entity<FactoryView>);

impl gpui_kit::Render for Holder {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        _: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        gpui_kit::div()
    }
}

const FACTORY: &str = r#"{"type":"window","v":2,"view":"factory","active":true}"#;
const EDITOR: &str = r#"{"type":"window","v":2,"view":"editor","active":true}"#;
const EDITOR_BACK: &str = r#"{"type":"window","v":2,"view":"editor","active":false}"#;

/// The view: drawn as a window's root, or never drawn.
const WINDOWS: &[(&str, bool)] = &[("the view drawn", true), ("the view never drawn", false)];

/// The bridge hears which view is shown and whether the window is in front, once each time either
/// changes: it keeps the Board's outside data fresh while it is shown, and looks at once as the
/// window comes to the front. A view never drawn says so too.
#[test]
fn the_bridge_hears_the_view_shown_and_the_window_in_front_once_each_change() {
    rows(
        WINDOWS,
        |r| r.0,
        |&(_, drawn)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let command = fake(d, &["frames/bridge-tree.json"], None);
            let mut app = TestAppContext::build(TestDispatcher::new(0), None);
            app.update(|cx| cx.set_global(command));
            let (mut cx, view) = if drawn {
                let window = app.open_window(size(px(1000.), px(700.)), FactoryView::new);
                let view = window.root(&mut app).unwrap();
                (VisualTestContext::from_window(window.into(), &app), view)
            } else {
                let window = app.open_window(size(px(1000.), px(700.)), |window, cx| {
                    Holder(gpui_kit::AppContext::new(cx, |cx| {
                        FactoryView::new(window, cx)
                    }))
                });
                let holder = window.root(&mut app).unwrap();
                let cx = VisualTestContext::from_window(window.into(), &app);
                let view = cx.read(|cx| holder.read(cx).0.clone());
                (cx, view)
            };
            let windows = |d: &Path| -> Vec<String> {
                log(d)
                    .into_iter()
                    .filter(|l| l.contains(r#""type":"window""#))
                    .collect()
            };
            let wait = |cx: &mut VisualTestContext, label: &str, want: &str| {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    cx.run_until_parked();
                    if windows(d).last().map(String::as_str) == Some(want) {
                        return;
                    }
                    assert!(Instant::now() < deadline, "timed out waiting for: {label}");
                    std::thread::sleep(Duration::from_millis(20));
                }
            };
            cx.update(|window, cx| view.update(cx, |v, cx| v.start(window, cx)));
            if drawn {
                cx.update(|window, _| window.activate_window());
                wait(&mut cx, "the Factory view in front", FACTORY);
                // drawn again with nothing changed: nothing more said
                let told = windows(d).len();
                view.update(&mut cx, |_, cx| cx.notify());
                cx.run_until_parked();
                assert_eq!(windows(d).len(), told);
            }
            // the Editor shown, the window to the back, to the front again
            view.update(&mut cx, |v, cx| v.set_shown(false, cx));
            cx.update(|window, _| window.activate_window());
            wait(&mut cx, "the Editor in front", EDITOR);
            let told = windows(d).len();
            cx.deactivate_window();
            wait(&mut cx, "the window to the back", EDITOR_BACK);
            cx.update(|window, _| window.activate_window());
            wait(&mut cx, "the window to the front again", EDITOR);
            assert_eq!(windows(d)[told - 1..], [EDITOR, EDITOR_BACK, EDITOR]);
        },
    );
}

// --- the view in the real window ---

#[test]
fn cmd_alt_a_toggles_the_factory_and_the_editor_keeping_the_caret() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two', 'three' }) return true");
    v.key("ö");
    v.key("ä");
    let caret = v.lua("return vim.api.nvim_win_get_cursor(0)");
    let projects = v.projects.clone().unwrap();
    let command = fake(
        dir.path(),
        &[
            "frames/bridge-tree.json",
            "frames/bridge-shell-widgets.json",
        ],
        None,
    );
    v.cx.update(|_, cx| cx.set_global(command));

    v.key("super+alt+a");
    v.wait_until("the Factory view with the bridge's tree", |v| {
        projects.read_with(&v.cx, |p, cx| {
            p.factory_shown() && p.factory().is_some_and(|f| f.read(cx).rev().is_some())
        })
    });
    v.wait_until("ABE · BOARD and the widgets", |v| {
        v.read_ws(|ws, cx| ws.statusbar().read(cx).segment_text(cx)) == "ABE · BOARD"
            && v.cx.debug_bounds("factory-widget-needs-you").is_some()
    });
    assert!(v.cx.debug_bounds("factory-node-board").is_some());
    // keys go to the bridge, not nvim
    v.key("ö");
    v.wait_until("ö reached the bridge", |_| {
        log(dir.path()).iter().any(|l| l.contains(r#""key":"ö""#))
    });
    assert_eq!(v.lua("return vim.api.nvim_win_get_cursor(0)"), caret);

    v.key("super+alt+a");
    v.wait_until("the Editor back", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
            && v.read_ws(|ws, cx| ws.statusbar().read(cx).segment_text(cx))
                .starts_with("VIMSTORM")
    });
    assert!(v.cx.debug_bounds("factory-node-cards").is_none());
    assert_eq!(v.lua("return vim.api.nvim_win_get_cursor(0)"), caret);
    // nvim has the keyboard again
    v.key("ö");
    v.wait_until("the caret moved", |v| {
        v.lua("return vim.api.nvim_win_get_cursor(0)") != caret
    });
    // the Editor's own widget stays on its status bar, the Factory view's go
    assert!(v.cx.debug_bounds("factory-widget-factory").is_some());
    assert!(v.cx.debug_bounds("factory-widget-needs-you").is_none());

    // another project shown while the Factory is: the Editor comes back, on that project
    v.key("super+alt+a");
    v.wait_until("the Factory again", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    let other = tempfile::tempdir().unwrap();
    std::fs::write(other.path().join("b.txt"), "b\n").unwrap();
    let dir = other.path().canonicalize().unwrap();
    v.cx.update(|window, cx| vimstorm::shell::projects::switch_to(dir.clone(), window, cx));
    v.wait_until("the other project's editor, the Factory left", |v| {
        let (shown, factory) =
            projects.read_with(&v.cx, |p, _| (p.factory_shown(), p.factory().cloned()));
        let focused = v
            .cx
            .update(|window, cx| factory.is_some_and(|f| f.focus_handle(cx).is_focused(window)));
        !shown
            && !focused
            && v.cx
                .update(|_, cx| vimstorm::shell::projects::open_dirs_by_use(cx))
                .first()
                .is_some_and(|d| *d == dir)
    });
}

/// The widths the bridge was told for the Board (main's `hello` and `resize`, no slot).
fn board_widths(dir: &std::path::Path) -> Vec<f32> {
    log(dir)
        .iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|f| {
            (f["type"] == "hello" || f["type"] == "resize")
                && f.get("slot").is_none_or(|s| s.is_null())
        })
        .filter_map(|f| f["size"]["width"].as_f64())
        .map(|w| w as f32)
        .collect()
}

#[test]
fn the_board_is_laid_out_for_its_own_width_whichever_view_is_shown() {
    // the column count is the Board's width's alone: hidden behind the Editor the Board was told
    // the whole window's width, so shown again beside the Chat column it drew four columns in the
    // room of three until the bridge answered
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let dir = base.join("demo-shop");
    std::fs::create_dir_all(&dir).unwrap();
    crate::common::gitfix::git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.ts"), "export const a = 1;\n").unwrap();
    let mut v = crate::common::view::View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let command = crate::common::bridge::fake_on(&base, &["frames/bridge-tree.json"], &[]);
    v.cx.update(|_, cx| {
        cx.set_global(command);
        vimstorm::shell::set_column_state(cx, |s| {
            s.open = true;
            s.factory_open = true;
        });
    });
    let projects = v.projects.clone().unwrap();
    let shown = |v: &mut crate::common::view::View, on: bool| {
        v.wait_until(if on { "the Factory view" } else { "the Editor" }, |v| {
            v.pump();
            projects.read_with(&v.cx, |p, _| p.factory_shown()) == on
                && (!on || v.cx.debug_bounds("factory-view").is_some())
        });
    };
    v.key("super+alt+a");
    shown(&mut v, true);
    let board = f32::from(v.cx.debug_bounds("factory-view").unwrap().size.width);
    v.wait_until("the Board's width told", |v| {
        v.pump();
        board_widths(&base)
            .last()
            .is_some_and(|w| (w - board).abs() < 1.)
    });
    // the Editor shown, then the Factory view again
    v.key("super+alt+a");
    shown(&mut v, false);
    v.key("super+alt+a");
    shown(&mut v, true);
    let widths = board_widths(&base);
    assert!(
        widths.iter().all(|w| (w - board).abs() < 1.),
        "the bridge heard {widths:?} for a Board {board} px wide"
    );
}

// --- Command mode over the Editor ---

#[test]
fn colon_in_the_editor_opens_command_mode_over_it_and_gives_the_keyboard_back() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut v = View::start_projects("proj", &["a.txt"]);
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two', 'three' }) return true");
    let caret = v.lua("return vim.api.nvim_win_get_cursor(0)");
    let projects = v.projects.clone().unwrap();
    let command = fake_on(
        d,
        &[],
        &[
            (r#""key":":""#, vec![fixture("frames/bridge-layer.json")]),
            (
                r#""key":"x""#,
                vec![
                    layer_frame(d, None, 10),
                    fixture("frames/bridge-shell-status.json"),
                    fixture("frames/bridge-shell-cmdline.json"),
                ],
            ),
        ],
    );
    v.cx.update(|_, cx| cx.set_global(command));

    // the editor's `:` (its Lua map): Command mode over the Editor, the Factory view not shown
    v.keystrokes(":");
    v.wait_until("the pick over the editor", |v| {
        v.cx.debug_bounds("factory-pick").is_some()
    });
    assert!(!projects.read_with(&v.cx, |p, _| p.factory_shown()));
    assert!(projects.read_with(&v.cx, |p, cx| p.command_mode_up(cx)));
    assert!(
        v.cx.debug_bounds("factory-node-serve").is_none(),
        "no screen drawn"
    );
    assert_eq!(v.mode(), "n", "Neovim's command line stays shut");
    // keys go to the bridge, not nvim
    v.keystrokes("ö");
    v.wait_until("ö reached the bridge", |_| {
        log(d).iter().any(|l| l.contains(r#""key":"ö""#))
    });
    assert_eq!(v.lua("return vim.api.nvim_win_get_cursor(0)"), caret);
    // a click on the editor takes the keyboard: the layer closes, the bridge is told
    let editor = v.read(|e| e.geometry().layout.editor);
    v.click(
        gpui_kit::MouseButton::Left,
        editor.bottom_right() - gpui_kit::point(px(40.), px(40.)),
    );
    v.wait_until("blurred", |v| {
        v.cx.debug_bounds("factory-pick").is_none()
            && log(d)
                .iter()
                .any(|l| l.contains(r#""input":{"kind":"blur"}"#))
    });
    // `:` again: the bridge's pick (a newer rev)
    v.keystrokes(":");
    v.wait_until("the pick again", |v| {
        v.cx.debug_bounds("factory-pick").is_some()
    });
    // the bridge closes the layer, puts a line on the status line and asks for `::`: Neovim's own
    // command line, the keyboard back in the editor
    v.keystrokes("x");
    v.wait_until("Neovim's command line, the layer gone", |v| {
        v.mode() == "c" && v.cx.debug_bounds("factory-pick").is_none()
    });
    v.wait_until("the status line says it", |v| {
        v.cx.debug_bounds("factory-status").is_some()
    });
    v.key("escape");
    v.wait_until("normal mode", |v| v.mode() == "n");
    v.keystrokes("ö");
    v.wait_until("the caret moved", |v| {
        v.lua("return vim.api.nvim_win_get_cursor(0)") != caret
    });
}

/// The window's keys while Command mode is up over the Editor: the layer gives way (closed, the
/// bridge told) and the key does its own; no key stays with a layer (⌘J hiding the panel moves no
/// keyboard).
#[test]
fn a_window_key_closes_command_mode_over_the_editor_and_does_its_own() {
    type Done = fn(&mut View) -> bool;
    fn panel(v: &mut View) -> Option<vimstorm::shell::PanelTab> {
        v.pump();
        let projects = v.projects.clone().unwrap();
        projects.read_with(&v.cx, |p, cx| {
            p.active().and_then(|ws| ws.read(cx).panel_shown(cx))
        })
    }
    // what, the keys before `:`, the key, what it did
    let table: [(&str, &[&str], &str, Done); 4] = [
        ("⌘J: the panel shown", &[], "super+j", |v| {
            panel(v).is_some()
        }),
        (
            "⌘J: the panel hidden",
            &["super+j", "super+digit_2"],
            "super+j",
            |v| panel(v).is_none(),
        ),
        ("⌘3: Git", &[], "super+digit_3", |v| panel(v).is_some()),
        ("⌘4: Chat", &[], "super+digit_4", |v| {
            v.pump();
            v.cx.update(|_, cx| vimstorm::shell::column_state(cx).open)
        }),
    ];
    rows(
        &table,
        |r| r.0,
        |&(_, before, key, done)| {
            let dir = tempfile::tempdir().unwrap();
            let d = dir.path();
            let mut v = View::start_projects("proj", &["a.txt"]);
            let projects = v.projects.clone().unwrap();
            let command = fake_on(
                d,
                &[],
                &[(r#""key":":""#, vec![fixture("frames/bridge-layer.json")])],
            );
            v.cx.update(|_, cx| cx.set_global(command));
            for k in before {
                v.key(k);
            }
            v.keystrokes(":");
            v.wait_until("Command mode", |v| {
                v.cx.debug_bounds("factory-pick").is_some()
            });
            v.key(key);
            v.wait_until("the layer closed, the bridge told", |v| {
                v.pump();
                v.cx.debug_bounds("factory-pick").is_none()
                    && log(d)
                        .iter()
                        .any(|l| l.contains(r#""input":{"kind":"blur"}"#))
            });
            assert!(!projects.read_with(&v.cx, |p, cx| p.command_mode_up(cx)));
            v.wait_until("the key did its own", done);
        },
    );
}

/// `:w⏎` typed fast in the Editor: the keys Neovim held after `:` reach Command mode whole,
/// after what the Editor said of itself (its Ex names, the caret, its menu's items); the bridge's
/// Run in Neovim saves the file.
#[test]
fn colon_w_enter_typed_fast_in_the_editor_saves_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    // a folder of its own: the module's other tests' autosaves write `proj`'s a.txt, and `:w` on
    // a new buffer over a file that came since asks before it overwrites
    let project = d.canonicalize().unwrap().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("package.json"), "{}\n").unwrap();
    let mut v = View::start_projects(project.to_str().unwrap(), &["a.txt"]);
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'saved by :w' }) return true");
    let file = v
        .lua("return vim.fn.expand('%:p')")
        .as_str()
        .expect("the file's path")
        .to_owned();
    let ex = d.join("shell-ex-w.json");
    std::fs::write(
        &ex,
        serde_json::json!({"v": 2, "type": "shell", "effect": {"kind": "ex", "text": "w"}})
            .to_string(),
    )
    .unwrap();
    let command = fake_on(
        d,
        &[],
        &[
            (r#""key":":""#, vec![fixture("frames/bridge-layer.json")]),
            (r#""key":"<CR>""#, vec![layer_frame(d, None, 10), ex]),
        ],
    );
    v.cx.update(|_, cx| cx.set_global(command));
    v.keystrokes(": w enter");
    v.wait_until("saved", |_| {
        std::fs::read_to_string(&file).is_ok_and(|t| t == "saved by :w\n")
    });
    let sent = log(d);
    let here = sent
        .iter()
        .position(|l| l.contains(r#""type":"editor-here""#))
        .expect("the Editor's here");
    assert!(sent[here].contains(r#""write""#), "{}", sent[here]);
    assert!(sent[here].contains(r#""file":"a.txt""#), "{}", sent[here]);
    let keys: Vec<&String> = sent[here..]
        .iter()
        .filter(|l| l.contains(r#""kind":"key""#))
        .collect();
    assert_eq!(keys.len(), 3, "{keys:?}");
    assert!(keys[0].contains(r#""key":":""#));
    assert!(keys[1].contains(r#""key":"w""#));
    assert!(keys[2].contains(r#""key":"<CR>""#));
}

// --- a launch ---

/// A launch shows the workspace on its page as at the last quit: Chat opens on the session it was
/// on there then (`restore`); on the Board (⌘←) its first selection is not followed, another card
/// is. What Chat says it is on in the workspace is kept for the next launch; on the Board it is the
/// card's, never kept as the workspace's.
#[test]
fn a_launch_opens_chat_on_the_session_it_was_on_at_the_last_quit() {
    let dir = tempfile::tempdir().unwrap();
    let (_t, a) = copy("proj");
    let set = vimstorm::shell::projects::SavedSet {
        open: vec![a.clone()],
        active: Some(a.clone()),
    };
    let command = fake_on(dir.path(), &["frames/bridge-tree.json"], &[]);
    let tile = Tile::Workspace(a.clone());
    // the last quit: on the code, Chat on s7, docked
    let mut memory = TileMemory::default();
    memory.set_page(&tile, Page::Code);
    memory.chat_said(&tile, Some("s7"));
    memory.keep_chat(
        &tile,
        ChatMemory {
            size: ChatSize::Docked,
            ..ChatMemory::first(1400., 420.)
        },
    );
    let mut v = View::start_projects_restored_with(set, move |cx, home| {
        let state = vimstorm::shell::state_dir(Some(home));
        std::fs::create_dir_all(&state).unwrap();
        memory.save(&state);
        cx.set_global(command);
        vimstorm::shell::set_column_state(cx, |s| {
            s.open = true;
            s.factory_open = true;
        });
    });
    let projects = v.projects.clone().unwrap();
    let opens = |dir: &Path| -> Vec<String> {
        log(dir)
            .into_iter()
            .filter(|l| l.contains(r#""screen":"chat""#) && l.contains(r#""slot":"chat""#))
            .collect()
    };
    // (the bridge started as at launch)
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    v.wait_until("Chat opened on s7", |v| {
        v.pump();
        opens(dir.path())
            .last()
            .is_some_and(|l| l.contains(r#""restore":"s7""#))
    });
    assert!(
        !projects.read_with(&v.cx, |p, _| p.factory_shown()),
        "the code"
    );
    let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
    let say = |v: &mut View, effect: Value| {
        let line = json!({"v": 2, "type": "shell", "effect": effect}).to_string();
        factory.update(&mut v.cx, |f, cx| f.receive_line(&line, cx));
        v.pump();
    };
    say(&mut v, json!({"kind": "chat-session", "session": "s7"}));
    // the Board: its selection as it starts, Chat stays
    v.key("super+arrow_left");
    v.wait_until("the Board", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    say(
        &mut v,
        json!({"kind": "selected", "card": 5, "title": "Story 5"}),
    );
    v.settle();
    assert!(
        opens(dir.path())
            .iter()
            .all(|l| !l.contains(r#""card":"5""#)),
        "{:?}",
        opens(dir.path())
    );
    // another card: Chat follows it
    say(
        &mut v,
        json!({"kind": "selected", "card": 6, "title": "Story 6"}),
    );
    v.wait_until("Chat on card 6", |v| {
        v.pump();
        opens(dir.path())
            .last()
            .is_some_and(|l| l.contains(r#""card":"6""#) && !l.contains("restore"))
    });
    // its session there is the card's: not kept as the workspace's
    let state = vimstorm::shell::state_dir(Some(&v.state_home()));
    let kept = |state: &Path| TileMemory::load(state).session(&tile).map(str::to_owned);
    say(&mut v, json!({"kind": "chat-session", "session": "s9"}));
    v.settle();
    assert_ne!(kept(&state).as_deref(), Some("s9"));
    // back in the workspace (⌘→ up from the Board), Chat on s8: kept for the next launch
    v.key("super+arrow_right");
    v.wait_until("the workspace", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    say(&mut v, json!({"kind": "chat-session", "session": "s8"}));
    v.wait_until("s8 saved", |_| kept(&state).as_deref() == Some("s8"));
}

/// A private copy of a fixture.
fn copy(name: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let out = std::process::Command::new("cp")
        .arg("-R")
        .arg(crate::common::fixtures().join(name))
        .arg(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "cp {name}");
    (tmp, root.join(name))
}

// --- the pane's screens (the Boxes and Pipelines tiles) ---

/// A repo with one commit.
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

/// `tree {slot: pane}` of the contract's `rel` as `screen`'s, written into `dir`.
fn pane_frame(dir: &Path, screen: &str, rel: &str) -> PathBuf {
    let name = rel.rsplit('/').next().unwrap();
    let path = dir.join(format!("pane-{name}"));
    let frame = json!({"v": 2, "type": "tree", "screen": screen, "rev": 1, "tree": tree_of(rel), "slot": "pane"});
    std::fs::write(&path, frame.to_string()).unwrap();
    path
}

/// A key the pane's screen was sent, as the fake bridge logs it.
fn pane_key(key: &str) -> String {
    format!(r#""key":"{key}"}},"slot":"pane""#)
}

/// The window on `demo-shop`, its fake bridge answering `screen` opened in the pane with `rel`,
/// and the pane's keys with frames (`on`).
fn on_pane(base: &Path, screen: &str, rel: &str, on: Vec<(String, Vec<PathBuf>)>) -> View {
    let dir = repo(base);
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    v.cx.simulate_resize(size(px(1400.), px(900.)));
    let open = format!(r#""type":"open","v":2,"screen":"{screen}""#);
    let mut rules = vec![(open, vec![pane_frame(base, screen, rel)])];
    rules.extend(on);
    let rules: Vec<(&str, Vec<PathBuf>)> =
        rules.iter().map(|(k, f)| (k.as_str(), f.clone())).collect();
    let command = fake_on(base, &["frames/bridge-tree.json"], &rules);
    v.cx.update(|_, cx| cx.set_global(command));
    v
}

fn opened_in_pane(base: &Path, screen: &str) -> bool {
    log(base).iter().any(|l| {
        l.contains(r#""type":"open""#)
            && l.contains(&format!(r#""screen":"{screen}""#))
            && l.contains(r#""slot":"pane""#)
    })
}

/// What the pane's slot drew of `kind`.
fn pane_drawn(v: &mut View, slot: &Entity<SlotView>, kind: &str) -> Vec<String> {
    v.pump();
    slot.read_with(&v.cx, |s, _| {
        s.drawn()
            .texts(kind)
            .into_iter()
            .map(str::to_owned)
            .collect()
    })
}

/// The Factory view's pane on Pipelines with the keys: its tile clicked, its Chat hidden (⌘⌥2).
fn to_pipelines(v: &mut View, base: &Path) {
    v.click_place("pipelines");
    v.wait_until("the Pipelines tile", |v| {
        factory_pane(v) == Some(PaneTab::Pipelines)
    });
    v.key("super+alt+digit_2");
    v.wait_until("the list has the keys", pane_has_keys);
    v.wait_until("opened in the pane slot", |_| {
        opened_in_pane(base, "pipelines")
    });
}

/// The Factory view's pane's tab.
fn factory_pane(v: &mut View) -> Option<PaneTab> {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| {
        p.factory_pane_view().and_then(|f| f.read(cx).tab())
    })
}

/// The Factory view's pane has the keys.
fn pane_has_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let pane = projects.read_with(&v.cx, |p, _| p.factory_pane_view().cloned());
    v.cx.update(|window, cx| pane.is_some_and(|p| p.read(cx).has_keyboard(window, cx)))
}

/// Esc on the Pipelines tile's list gives the keyboard back and the list stays; inside a run (the
/// tree's root `pipelines-run`) Esc is the screen's and the list keeps the keyboard.
#[test]
fn esc_in_the_pane_gives_the_keys_back_unless_inside_a_run() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let graph = pane_frame(&base, "pipelines", "trees/pipelines-graph.json");
    let mut v = on_pane(
        &base,
        "pipelines",
        "trees/pipelines-overview.json",
        vec![(pane_key("<CR>"), vec![graph])],
    );
    to_pipelines(&mut v, &base);
    assert!(v.cx.debug_bounds("factory-pane").is_some());
    // Esc on the overview, Chat hidden: the list keeps the keys (the Board under it is not
    // shown); Chat shown: it takes them, the list stays; Esc in Chat: the list again
    v.key("escape");
    v.settle();
    assert!(
        factory_pane(&mut v) == Some(PaneTab::Pipelines) && pane_has_keys(&mut v),
        "nothing shown takes them"
    );
    v.key("super+alt+digit_2");
    v.wait_until("Chat has the keys", |v| {
        factory_pane(v) == Some(PaneTab::Pipelines) && !pane_has_keys(v)
    });
    for _ in 0..2 {
        v.key("escape");
        v.settle();
        if pane_has_keys(&mut v) {
            break;
        }
    }
    v.wait_until("Esc in Chat: the keys in the list", pane_has_keys);
    v.key("super+alt+digit_2");
    v.settle();
    assert!(
        pane_has_keys(&mut v),
        "Chat hidden again, the list keeps them"
    );
    // ⏎ is the screen's: its run's graph comes back, the tree's root `pipelines-run`
    let projects = v.projects.clone().unwrap();
    let slot = projects
        .read_with(&v.cx, |p, cx| {
            p.factory_pane_view()
                .and_then(|f| f.read(cx).content().slot.clone())
        })
        .expect("the pane slot's view");
    v.key("enter");
    v.wait_until("the run's graph", |v| {
        !pane_drawn(v, &slot, "RunGraphJob").is_empty()
    });
    // Esc inside the run: the screen's (it steps back), the list keeps the keyboard
    let escs = |base: &Path| {
        log(base)
            .iter()
            .filter(|l| l.contains(&pane_key("<Esc>")))
            .count()
    };
    let before = escs(&base);
    v.key("escape");
    v.wait_until("Esc went to the screen", |_| escs(&base) > before);
    assert!(pane_has_keys(&mut v), "the list keeps the keyboard");
}

/// The Factory view on the fake bridge, a SlotView on the pane in a window of its own, and
/// `sessions` opened there; the bridge answers that open with the sessions tree.
fn pane_on(dir: &Path) -> (Win, VisualTestContext, Entity<SlotView>) {
    let frame = pane_frame(dir, "sessions", "trees/sessions.json");
    let mut w = Win::open(Some(fake_on(
        dir,
        &["frames/bridge-tree.json"],
        &[(r#""screen":"sessions""#, vec![frame])],
    )));
    w.start();
    w.wait("main's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    let factory: Entity<FactoryView> = w.view.clone();
    let handle =
        w.cx.update(|_, cx| {
            cx.open_window(WindowOptions::default(), |window, cx| {
                factory.update(cx, |f, cx| f.slot_view(Slot::Pane, window, cx))
            })
        })
        .unwrap();
    let slot = handle.root(&mut w.cx).unwrap();
    let scx = VisualTestContext::from_window(handle.into(), &w.cx);
    w.view.update(&mut w.cx, |v, cx| {
        v.open_in(Slot::Pane, "sessions", BTreeMap::new(), cx);
    });
    scx.run_until_parked();
    (w, scx, slot)
}

/// A slot's screen opens with `slot: pane`; with the keyboard there the bridge hears
/// `focus {slot: pane}` and its selection draws active; its keys and clicks go back with
/// `slot: pane`, a double-click as the click, then the row's ⏎.
#[test]
fn a_slots_screen_hears_its_keys_and_clicks_with_its_slot() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let (mut w, mut scx, slot) = pane_on(d);
    let wait = |w: &mut Win,
                scx: &mut VisualTestContext,
                label: &str,
                pred: &dyn Fn(&mut VisualTestContext) -> bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            w.cx.run_until_parked();
            scx.run_until_parked();
            if pred(scx) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for: {label}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait(&mut w, &mut scx, "the pane's table", &|scx| {
        slot.read_with(scx, |v, _| !v.drawn().texts("TableRow").is_empty())
    });
    assert!(
        log(d)
            .iter()
            .any(|l| l == r#"{"type":"open","v":2,"screen":"sessions","params":{},"slot":"pane"}"#),
        "{:?}",
        log(d)
    );
    let selected = |scx: &mut VisualTestContext| {
        slot.read_with(scx, |v, _| {
            v.drawn()
                .texts("TableSelected")
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
    };
    assert!(
        selected(&mut scx)[0].ends_with(" inactive"),
        "grey until it has the keys"
    );
    // the keyboard in the pane: told, the selection active
    let focus = slot.read_with(&scx, |v, cx| v.focus_handle(cx));
    scx.update(|window, cx| {
        window.activate_window();
        window.focus(&focus, cx);
    });
    wait(&mut w, &mut scx, "focus {slot: pane}", &|_| {
        log(d)
            .iter()
            .any(|l| l == r#"{"type":"focus","v":2,"slot":"pane"}"#)
    });
    scx.run_until_parked();
    assert!(selected(&mut scx)[0].ends_with(" active"));
    for k in ["ö", "g", "g", "ctrl+w", "ctrl+i", "super+enter"] {
        let ks = vimstorm::editor::input::keystroke(k).unwrap();
        scx.update(|window, cx| window.dispatch_keystroke(ks, cx));
        scx.run_until_parked();
    }
    let at = scx
        .debug_bounds("factory-node-session:s3")
        .unwrap()
        .center();
    for count in [1, 2] {
        scx.simulate_event(MouseDownEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: count,
            first_mouse: false,
        });
        scx.simulate_event(MouseUpEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: count,
        });
    }
    let key = |k: &str| {
        format!(r#"{{"type":"input","v":2,"input":{{"kind":"key","key":"{k}"}},"slot":"pane"}}"#)
    };
    let click =
        r#"{"type":"input","v":2,"input":{"kind":"click","id":"session:s3"},"slot":"pane"}"#;
    wait(&mut w, &mut scx, "the keys and the clicks", &|_| {
        log(d).iter().any(|l| *l == key("<CR>"))
    });
    assert_eq!(
        inputs(d),
        [
            key("ö"),
            key("g"),
            key("g"),
            key("<C-w>"),
            key("<C-i>"),
            key("<D-CR>"),
            click.to_owned(),
            click.to_owned(),
            key("<CR>"),
        ]
    );
}

/// New workspace (the rail's `+`, File › New Workspace…) is the Board on its New card dialog: the
/// Board tile, `widget:new-card` clicked on it.
#[test]
fn new_workspace_shows_the_board_on_new_card() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let dir = base.join("demo-shop");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.ts"), "export const a = 1;\n").unwrap();
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    v.cx.update(|_, cx| vimstorm::app::init_menu(cx));
    let command = fake_on(&base, &["frames/bridge-tree.json"], &[]);
    v.cx.update(|_, cx| cx.set_global(command));
    let projects = v.projects.clone().unwrap();
    let new_cards = |base: &Path| {
        log(base)
            .iter()
            .filter(|l| l.contains(r#""kind":"click","id":"widget:new-card""#))
            .count()
    };
    let on_new_card = |v: &mut View, n: usize| {
        v.wait_until(&format!("the Board, New card #{n}"), |v| {
            v.pump();
            projects.read_with(&v.cx, |p, cx| p.tile_now(cx) == Tile::Board)
                && new_cards(&base) == n
        });
    };
    // the rail's +: its menu, New card… (New prototype… the other row)
    let plus = v.cx.debug_bounds("rail-new").expect("the rail's +");
    v.click(MouseButton::Left, plus.center());
    crate::common::gitui::pick_menu(&mut v, "New card…");
    on_new_card(&mut v, 1);
    // back on the workspace: ⌘→ up from the Board
    v.key("super+arrow_right");
    v.wait_until("the workspace", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.cx.update(|window, cx| {
        window.dispatch_action(Box::new(vimstorm::app::Workspaces), cx);
    });
    on_new_card(&mut v, 2);
}

// --- Settings ---

/// A layer frame of a contract tree, written to `dir` for the fake bridge to print.
fn layer_file(dir: &Path, rel: &str) -> String {
    layer_frame(dir, Some(rel), 1)
        .to_string_lossy()
        .into_owned()
}

/// Settings opens its screen on the page asked; it keeps the keyboard where it is, so no blur is
/// sent while it is up.
#[test]
fn settings_opens_on_its_page_and_sends_no_blur_while_up() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut command = fake(d, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!(
            "\"screen\":\"settings\"={}",
            layer_file(d, "trees/settings-appearance.json")
        ),
    ));
    let mut w = Win::open(Some(command));
    w.start();
    w.wait("the screen", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev().is_some())
    });
    let view = w.view.clone();
    w.cx.update(|window, cx| {
        view.update(cx, |v, cx| v.open_settings(Some("appearance"), window, cx))
    });
    w.wait("the dialog", |w| !w.drawn("SettingsDialog").is_empty());
    assert!(
        log(d)
            .iter()
            .any(|l| l.contains(r#""screen":"settings""#) && l.contains(r#""page":"appearance""#))
    );
    // the modal dialog stays when the keyboard goes elsewhere
    w.cx.update(|window, cx| window.blur(cx));
    w.keys(&["ö"]);
    heard(&mut w, d, "settings");
    assert!(
        !inputs(d).iter().any(|l| l.contains("blur")),
        "{:?}",
        inputs(d)
    );
}

/// Settings is up in the projects window.
fn settings_up(v: &mut View) -> bool {
    v.pump();
    v.cx.update(|_, cx| vimstorm::factory::settings_up(cx))
}

#[test]
fn cmd_comma_opens_settings_from_the_editor_and_from_the_factory_view() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(d, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!(
            "\"screen\":\"settings\"={}\n\"key\":\"<Esc>\"={}",
            layer_file(d, "trees/settings-appearance.json"),
            frame_null(d),
        ),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two', 'three' }) return true");
    let caret = v.lua("return vim.api.nvim_win_get_cursor(0)");
    let ws = projects
        .read_with(&v.cx, |p, _| p.active().cloned())
        .unwrap();
    let editor = v.cx.update(|window, cx| window.focused(cx)).unwrap();
    // from the Editor: over the code, centred in the window
    v.key("super+,");
    v.wait_until("the dialog over the Editor", |v| {
        settings_up(v) && v.cx.debug_bounds("factory-settings").is_some()
    });
    let b = v.cx.debug_bounds("factory-settings").unwrap();
    let viewport = v.cx.update(|window, _| window.viewport_size());
    assert!(
        ((viewport.width - b.size.width) / 2. - b.origin.x).abs() <= px(1.),
        "{b:?} in {viewport:?}"
    );
    assert!(
        ((viewport.height - b.size.height) / 2. - b.origin.y).abs() <= px(1.),
        "{b:?} in {viewport:?}"
    );
    // its keys are the bridge's, not nvim's
    v.key("ö");
    v.wait_until("ö reached the bridge", |_| {
        log(d).iter().any(|l| l.contains(r#""key":"ö""#))
    });
    // modal: with the keyboard moved under it, its keys still are its own (⌘S its OK)
    v.cx.update(|window, cx| ws.update(cx, |w, cx| w.focus_editor(window, cx)));
    v.key("ö");
    v.key("super+s");
    v.wait_until("⌘S reached the bridge", |_| {
        log(d).iter().any(|l| l.contains(r#""key":"<D-s>""#))
    });
    assert_eq!(
        log(d).iter().filter(|l| l.contains(r#""key":"ö""#)).count(),
        2
    );
    assert_eq!(v.lua("return vim.api.nvim_win_get_cursor(0)"), caret);
    v.key("escape");
    v.wait_until("closed", |v| !settings_up(v));
    // the keyboard back on the code
    v.wait_until("the editor's keyboard", |v| {
        v.cx.update(|window, _| editor.is_focused(window))
    });
    // from the Factory view
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("super+,");
    v.wait_until("the dialog over the Factory view", |v| {
        settings_up(v) && v.cx.debug_bounds("factory-settings").is_some()
    });
    let opens = log(d)
        .iter()
        .filter(|l| l.contains(r#""screen":"settings""#))
        .count();
    assert_eq!(opens, 2, "one open each time");
    let focus = projects
        .read_with(&v.cx, |p, cx| p.factory().map(|f| f.focus_handle(cx)))
        .unwrap();
    assert!(
        v.cx.update(|window, cx| focus.contains_focused(window, cx)),
        "the dialog has the keyboard"
    );
}

/// A `layer: null` frame: the bridge closed the dialog.
fn frame_null(dir: &Path) -> String {
    let path = dir.join("layer-null");
    std::fs::write(
        &path,
        serde_json::json!({"v": 2, "type": "layer", "rev": 1, "tree": null}).to_string(),
    )
    .unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn with_no_abe_settings_opens_as_serve_down_and_esc_closes_it() {
    let mut v = View::start_projects("proj", &["a.txt"]);
    v.key("super+4");
    v.key("super+,");
    v.wait_until("the serve-down dialog", |v| {
        settings_up(v) && v.cx.debug_bounds("factory-settings").is_some()
    });
    assert!(v.cx.debug_bounds("button-factory-settings:retry").is_some());
    v.key("escape");
    v.wait_until("closed", |v| !settings_up(v));
}

/// ⏎ on a fix in Logins & tools runs it in a terminal inside the dialog: real keys reach it, Esc
/// is the dialog's, and its end is told.
#[test]
fn a_fix_runs_in_a_terminal_inside_the_settings_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let script = echo_script(dir.path());
    let mut w = started(dir.path());
    let mut tree = tree_of("trees/settings-logins.json");
    fn find_kind<'a>(v: &'a mut Value, kind: &str) -> Option<&'a mut Value> {
        if v["kind"] == kind {
            return Some(v);
        }
        v.get_mut("children")?
            .as_array_mut()?
            .iter_mut()
            .find_map(|c| find_kind(c, kind))
    }
    let fix = find_kind(&mut tree, "SettingsFix").expect("the strip");
    fix["children"] = json!([{
        "kind": "Terminal",
        "id": "settings-fix-terminal",
        "props": { "key": "settings-fix:5", "argv": [script], "focused": true, "screenKeys": ["<Esc>"] },
    }]);
    w.layer_tree(tree, 2);
    w.wait("the fix's program runs", |w| {
        screen(w, "settings-fix:5").contains("ready")
    });
    w.keys(&["h", "i", "enter"]);
    w.wait("real keys reach it", |w| {
        screen(w, "settings-fix:5").contains("got: hi")
    });
    w.keys(&["escape"]);
    w.wait("Esc is the dialog's", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""key":"<Esc>""#))
    });
    w.keys(&["q", "u", "i", "t", "enter"]);
    w.wait("its end told", |_| {
        log(dir.path())
            .iter()
            .any(|l| l == r#"{"type":"exit","v":2,"key":"settings-fix:5","code":3}"#)
    });
}
