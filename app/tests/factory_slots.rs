//! The Factory's terminals and slot views. A Terminal component runs its argv in a PTY kept per
//! key across trees and dropped once no tree holds it for its time; real keys go to the program,
//! its screen keys and ⌘ keys to the bridge, its exit is told; it fits its island. A slot's tree
//! (`tree {slot: chat}`) draws in a [`SlotView`] in its own window; its keys and clicks go back as
//! `input {slot: chat}`, its keyboard as `focus {slot}`, its size as `resize {slot}`.
#![cfg(debug_assertions)]

use std::path::Path;
use std::time::{Duration, Instant};

use gpui_kit::{Entity, Focusable as _, Modifiers, MouseButton, MouseUpEvent, VisualTestContext};
use serde_json::{Value, json};
use vimstorm::editor::input;
use vimstorm::factory::{FIRST_SCREEN, Slot, SlotView};

use crate::common::bridge::{
    Win, echo_script, fake, fake_on, fixture, log, press, screen, send, started,
};
use crate::common::view::View;

fn terminal(key: &str, argv: &[&str], focused: bool) -> Value {
    json!({
        "kind": "Terminal",
        "id": "chat-terminal",
        "props": {
            "key": key,
            "argv": argv,
            "env": { "FROM_NODE": "node-env" },
            "focused": focused,
            "screenKeys": ["<Esc>"],
        },
    })
}

fn island(children: Vec<Value>) -> Value {
    json!({ "kind": "Island", "id": "chat", "props": {}, "children": children })
}

fn tree_line(rev: u64, children: Vec<Value>) -> String {
    json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev, "tree": island(children)})
        .to_string()
}

fn pid(w: &mut Win, key: &str) -> Option<u32> {
    w.view
        .read_with(&w.cx, |v, cx| v.terminal(key).map(|t| t.read(cx).pid()))
}

/// The process runs (a zombie waiting to be reaped has ended).
fn alive(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

/// The Factory view on the fake bridge, its main tree drawn, and a SlotView on the Chat slot
/// whose `open {slot: chat}` the bridge answers with `chat_tree`.
fn slot_on(dir: &Path, chat_tree: Value) -> (Win, VisualTestContext, Entity<SlotView>) {
    let frame = dir.join("chat-tree.json");
    std::fs::write(
        &frame,
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "tree": chat_tree, "slot": "chat"})
            .to_string(),
    )
    .unwrap();
    let mut w = Win::open(Some(fake_on(
        dir,
        &["frames/bridge-tree.json"],
        &[(r#""type":"open","v":2,"screen":"chat""#, vec![frame])],
    )));
    w.start();
    w.wait("main's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    let (scx, slot) = w.open_slot(Slot::Chat);
    (w, scx, slot)
}

fn wait_both(
    w: &mut Win,
    scx: &mut VisualTestContext,
    label: &str,
    mut pred: impl FnMut(&mut Win, &mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        w.cx.run_until_parked();
        scx.run_until_parked();
        if pred(w, scx) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for: {label}; focused {:?}",
            w.view.read_with(&w.cx, |v, _| v.focused_slot())
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn slot_drawn(scx: &mut VisualTestContext, slot: &Entity<SlotView>, kind: &str) -> usize {
    scx.run_until_parked();
    slot.read_with(scx, |v, _| v.drawn().texts(kind).len())
}

fn press_in(scx: &mut VisualTestContext, keys: &str) {
    for k in keys.split(' ') {
        let ks = input::keystroke(k).unwrap_or_else(|| panic!("no key {k}"));
        scx.update(|window, cx| window.dispatch_keystroke(ks, cx));
        scx.run_until_parked();
    }
}

/// Where a terminal runs: the Factory view's own tree, or the Chat slot's tree in a slot view.
#[derive(Clone, Copy, Debug)]
enum Host {
    Main,
    ChatSlot,
}

/// A terminal runs its argv with the node's env, real keys reach the program, its screen keys and
/// ⌘ keys go to the bridge (with the slot, in a slot), and its exit is told with its code.
#[test]
fn a_terminal_runs_its_argv_and_takes_real_keys_its_screen_and_cmd_keys_go_to_the_bridge() {
    const ROWS: &[(&str, Host)] = &[
        ("in the Factory view's tree", Host::Main),
        ("in the chat slot's tree", Host::ChatSlot),
    ];
    for &(name, host) in ROWS {
        let dir = tempfile::tempdir().unwrap();
        let script = echo_script(dir.path());
        let key = "t1";
        let (mut w, mut scx) = match host {
            Host::Main => {
                let mut w = started(dir.path());
                send(&mut w, &tree_line(2, vec![terminal(key, &[&script], true)]));
                (w, None)
            }
            Host::ChatSlot => {
                let (mut w, mut scx, slot) =
                    slot_on(dir.path(), island(vec![terminal(key, &[&script], true)]));
                wait_both(&mut w, &mut scx, "the slot's terminal runs", |w, _| {
                    w.view.read_with(&w.cx, |v, _| v.terminal_keys() == [key])
                });
                // the tree gives the terminal the keyboard while the slot has it
                let focus = slot.read_with(&scx, |v, cx| v.focus_handle(cx));
                scx.update(|window, cx| window.focus(&focus, cx));
                (w, Some(scx))
            }
        };
        let mut keys = |w: &mut Win, keys: &str| match scx.as_mut() {
            Some(scx) => press_in(scx, keys),
            None => press(w, keys),
        };
        w.wait(
            &format!("{name}: the program's first line, with the node's env"),
            |w| screen(w, key).contains("ready node-env"),
        );
        keys(&mut w, "h i enter");
        w.wait(&format!("{name}: the program got the line"), |w| {
            screen(w, key).contains("got: hi")
        });
        keys(&mut w, "escape super+enter");
        let slot = match host {
            Host::Main => "",
            Host::ChatSlot => r#","slot":"chat""#,
        };
        w.wait(&format!("{name}: Esc and ⌘⏎ at the bridge"), |_| {
            let l = log(dir.path());
            let at = |k: &str| {
                l.iter()
                    .any(|l| l.contains(&format!(r#""key":"{k}"}}{slot}"#)))
            };
            at("<Esc>") && at("<D-CR>")
        });
        assert!(
            !screen(&mut w, key).contains("got: \u{1b}"),
            "{name}: Esc reached the program"
        );
        keys(&mut w, "q u i t enter");
        w.wait(&format!("{name}: the exit frame"), |_| {
            log(dir.path()).iter().any(|l| {
                l.contains(r#""type":"exit""#)
                    && l.contains(&format!(r#""key":"{key}""#))
                    && l.contains(r#""code":3"#)
            })
        });
        assert!(
            screen(&mut w, key).contains("got: hi"),
            "{name}: an exited program's last screen stays under its key"
        );
    }
}

#[test]
fn a_terminal_is_kept_across_trees_and_dropped_once_unheld_for_its_time() {
    let dir = tempfile::tempdir().unwrap();
    let script = echo_script(dir.path());
    let mut w = started(dir.path());
    let both = || {
        vec![
            terminal("a", &[&script], false),
            terminal("b", &[&script], false),
        ]
    };
    send(&mut w, &tree_line(2, both()));
    let a = pid(&mut w, "a").unwrap();
    let b = pid(&mut w, "b").unwrap();
    // a newer tree holding the same keys: the same programs
    send(&mut w, &tree_line(3, both()));
    assert_eq!((pid(&mut w, "a"), pid(&mut w, "b")), (Some(a), Some(b)));
    // unheld: kept for its time (10 minutes), here none
    send(
        &mut w,
        &tree_line(4, vec![terminal("b", &[&script], false)]),
    );
    assert_eq!(
        w.view.read_with(&w.cx, |v, _| v.terminal_keys()),
        ["a", "b"],
        "kept while its time runs"
    );
    w.view
        .update(&mut w.cx, |v, _| v.set_terminal_keep(Duration::ZERO));
    send(
        &mut w,
        &tree_line(5, vec![terminal("b", &[&script], false)]),
    );
    assert_eq!(w.view.read_with(&w.cx, |v, _| v.terminal_keys()), ["b"]);
    w.wait("a's program hung up", |_| !alive(a));
    assert!(alive(b), "b runs on");
}

/// Chat's tree as the ui package draws it (Island > column Stack: header, then the terminal at
/// flex 1) in the projects window: the program sees the island's size, not the PTY's spawn size
/// (80 x 24), and keeps it when a newer tree holds the same key.
#[test]
fn a_terminal_fits_its_island_and_keeps_its_size_across_trees() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let probe = base.join("size.sh");
    std::fs::write(
        &probe,
        "#!/bin/sh\nwhile :; do echo \"size $(stty size)\"; sleep 0.1; done\n",
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", probe.to_str().unwrap()])
        .status()
        .unwrap();
    let tree = |rev: u64| {
        json!({
            "v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev,
            "tree": island(vec![json!({
                "kind": "Stack",
                "props": { "direction": "column", "sizes": ["auto", { "flex": 1 }] },
                "children": [
                    { "kind": "ChatHeader", "id": "chat-header",
                      "props": { "title": "Chat", "env": "Cloud", "hide": "chat:hide" } },
                    terminal("size", &[probe.to_str().unwrap()], true),
                ],
            })]),
        })
        .to_string()
    };
    let frame = base.join("chat.json");
    std::fs::write(&frame, tree(1)).unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let command = fake(&base, &[frame.to_str().unwrap()], None);
    v.cx.update(|_, cx| cx.set_global(command));
    // the Board with its Chat hidden: the island the window's width
    crate::common::chat::board_without_chat(&mut v);
    let factory = projects
        .read_with(&v.cx, |p, _| p.factory().cloned())
        .unwrap();
    let screen = |v: &mut View| {
        factory.read_with(&v.cx, |f, cx| {
            f.terminal("size")
                .map(|t| t.read(cx).screen().join("\n"))
                .unwrap_or_default()
        })
    };
    let size = |s: &str| -> Option<(u32, u32)> {
        let last = s.lines().rev().find(|l| l.starts_with("size "))?;
        let n: Vec<u32> = last
            .split_whitespace()
            .skip(1)
            .filter_map(|n| n.parse().ok())
            .collect();
        (n.len() == 2).then(|| (n[0], n[1]))
    };
    // the test window: well over 80 columns and 24 rows
    let fits = |s: &str| size(s).is_some_and(|(rows, cols)| rows > 24 && cols > 100);
    let wait_fit = |v: &mut View, label: &str| {
        let t0 = Instant::now();
        loop {
            v.settle();
            let s = screen(v);
            if fits(&s) {
                return size(&s).unwrap();
            }
            assert!(
                t0.elapsed() < Duration::from_secs(10),
                "{label}: the program never saw the island's size:\n{}",
                s.lines().rev().take(3).collect::<Vec<_>>().join("\n")
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let first = wait_fit(&mut v, "the first tree");
    let pid = factory.read_with(&v.cx, |f, cx| f.terminal("size").map(|t| t.read(cx).pid()));
    factory.update(&mut v.cx, |f, cx| f.receive_line(&tree(2), cx));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(wait_fit(&mut v, "a newer tree"), first, "the size changed");
    assert_eq!(
        factory.read_with(&v.cx, |f, cx| f.terminal("size").map(|t| t.read(cx).pid())),
        pid,
        "the same program"
    );
}

#[test]
fn a_chat_slot_tree_draws_in_a_slot_view_and_its_keys_and_clicks_go_back_with_slot_chat() {
    let dir = tempfile::tempdir().unwrap();
    let tree: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/chat-no-session.json")).unwrap(),
    )
    .unwrap();
    let (mut w, mut scx, slot) = slot_on(dir.path(), tree.clone());
    // the slot view opened the chat screen in its slot
    wait_both(&mut w, &mut scx, "the chat slot's tree", |_, _| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""screen":"chat""#) && l.contains(r#""slot":"chat""#))
    });
    wait_both(&mut w, &mut scx, "drawn", |_, scx| {
        slot_drawn(scx, &slot, "Empty") == 1 && scx.debug_bounds("factory-empty-actions").is_some()
    });
    // the head, the title and the actions centred on one line, top to bottom
    let title = scx.debug_bounds("factory-empty-title").expect("the title");
    let actions = scx
        .debug_bounds("factory-empty-actions")
        .expect("the actions");
    let head = scx.debug_bounds("factory-empty-head").expect("the head");
    let mid = |b: gpui_kit::Bounds<gpui_kit::Pixels>| f32::from(b.center().x);
    assert!(
        (mid(actions) - mid(title)).abs() < 1.,
        "{actions:?} under {title:?}"
    );
    assert!(
        (mid(head) - mid(title)).abs() < 1.,
        "{head:?} over {title:?}"
    );
    assert!(actions.origin.y > title.origin.y && head.origin.y < title.origin.y);
    // main's tree is still main's
    assert_eq!(w.drawn("BoardHeader").len(), 1);
    assert_eq!(slot_drawn(&mut scx, &slot, "BoardHeader"), 0);
    // a Board frame never draws Chat's slot again; a tree of its own does
    let renders = |scx: &mut VisualTestContext| {
        scx.run_until_parked();
        slot.read_with(scx, |v, _| v.renders())
    };
    let before = renders(&mut scx);
    let mut board: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("frames/bridge-tree.json")).unwrap())
            .unwrap();
    board["rev"] = json!(50);
    w.view
        .update(&mut w.cx, |v, cx| v.receive_line(&board.to_string(), cx));
    w.cx.run_until_parked();
    assert_eq!(w.view.read_with(&w.cx, |v, _| v.rev()), Some(50));
    assert_eq!(renders(&mut scx), before, "a Board frame drew Chat's slot");
    let own =
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 51, "tree": tree, "slot": "chat"});
    w.view
        .update(&mut w.cx, |v, cx| v.receive_line(&own.to_string(), cx));
    w.cx.run_until_parked();
    assert!(renders(&mut scx) > before, "its own tree drew it");
    // the slot measured itself: its size went as `resize {slot: chat}`
    wait_both(&mut w, &mut scx, "resize", |_, _| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""type":"resize""#) && l.contains(r#""slot":"chat""#))
    });

    // the keyboard in the slot: `focus {slot: chat}`, then its keys with `slot: chat`
    let focus = slot.read_with(&scx, |v, cx| v.focus_handle(cx));
    // focus events need the window active, as the app's is
    scx.update(|window, cx| {
        window.activate_window();
        window.focus(&focus, cx);
    });
    wait_both(&mut w, &mut scx, "focus", |_, _| {
        log(dir.path())
            .iter()
            .any(|l| l == r#"{"type":"focus","v":2,"slot":"chat"}"#)
    });
    assert_eq!(
        w.view.read_with(&w.cx, |v, _| v.focused_slot()),
        Some(Slot::Chat)
    );
    press_in(&mut scx, "enter super+enter");
    let at = scx
        .debug_bounds("factory-node-chat:launch")
        .expect("Launch agent drawn")
        .center();
    scx.simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
    scx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
    wait_both(&mut w, &mut scx, "the keys and the click", |_, _| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""id":"chat:launch""#))
    });
    let sent: Vec<String> = log(dir.path())
        .into_iter()
        .filter(|l| l.contains(r#""type":"input""#))
        .collect();
    assert_eq!(
        sent,
        [
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"<CR>"},"slot":"chat"}"#,
            r#"{"type":"input","v":2,"input":{"kind":"key","key":"<D-CR>"},"slot":"chat"}"#,
            r#"{"type":"input","v":2,"input":{"kind":"click","id":"chat:launch"},"slot":"chat"}"#,
        ]
    );
}

#[test]
fn the_chat_slot_hears_the_shown_workspace_its_editors_caret_and_branch() {
    use vimstorm::factory::{Caret, EditorAt, Lines, ShownProject, set_editor_at};
    let dir = tempfile::tempdir().unwrap();
    let tree: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/chat-no-session.json")).unwrap(),
    )
    .unwrap();
    let (mut w, mut scx, _slot) = slot_on(dir.path(), tree);
    let wt = std::path::PathBuf::from("/p/shop-wt/1-show-stock");
    w.view.update(&mut w.cx, |v, cx| {
        v.set_shown_project(
            Some(ShownProject {
                dir: wt.clone(),
                root: Some("/p/shop-wt/1-show-stock".into()),
                box_: None,
            }),
            cx,
        );
    });
    // its Editor says where the caret is and what branch it is on (the status bar's parts)
    w.cx.update(|_, cx| {
        set_editor_at(
            &wt,
            EditorAt {
                caret: Some(Caret {
                    file: "src/cart.ts".into(),
                    line: 18,
                    selection: Some(Lines { from: 12, to: 18 }),
                }),
                branch: Some("card/1-show-stock".into()),
            },
            cx,
        );
    });
    // the caret goes once it rested
    w.cx.executor()
        .advance_clock(vimstorm::factory::CARET_DEBOUNCE);
    wait_both(
        &mut w,
        &mut scx,
        "project, open chat and the caret",
        |_, _| {
            let l = log(dir.path());
            l.iter().any(|l| {
            l == r#"{"type":"project","v":2,"root":"/p/shop-wt/1-show-stock","branch":"card/1-show-stock"}"#
        }) && l.iter().any(|l| {
            l == r#"{"type":"open","v":2,"screen":"chat","params":{"root":"/p/shop-wt/1-show-stock"},"slot":"chat"}"#
        }) && l.iter().any(|l| {
            l == r#"{"type":"caret","v":2,"file":"src/cart.ts","line":18,"selection":{"from":12,"to":18}}"#
        })
        },
    );
    // no file open any more: `no-caret` (the Chat's implicit context clears), once. The fake
    // bridge logs what it reads on its own process, so this reads the log by order (the
    // `no-caret` the shown project sent before its Editor said anything comes before the caret)
    // and counts only up to a frame sent after the one that must not go.
    const CARET: &str =
        r#"{"type":"caret","v":2,"file":"src/cart.ts","line":18,"selection":{"from":12,"to":18}}"#;
    const NO_CARET: &str = r#"{"type":"no-caret","v":2}"#;
    const BOX: &str = r#"{"type":"open","v":2,"screen":"chat","params":{"box":"demo-shop-102","root":"/p/shop-wt/1-show-stock"},"slot":"chat"}"#;
    let after_caret = |dir: &Path| -> Vec<String> {
        let l = log(dir);
        let at = l
            .iter()
            .position(|l| l == CARET)
            .expect("the caret was sent");
        l[at + 1..].to_vec()
    };
    w.cx.update(|_, cx| {
        set_editor_at(
            &wt,
            EditorAt {
                caret: None,
                branch: Some("card/1-show-stock".into()),
            },
            cx,
        );
    });
    wait_both(&mut w, &mut scx, "no-caret after the caret", |_, _| {
        after_caret(dir.path()).iter().any(|l| l == NO_CARET)
    });
    // the Editor moves on still with no file open (its branch): no second `no-caret`
    w.cx.update(|_, cx| {
        set_editor_at(
            &wt,
            EditorAt {
                caret: None,
                branch: Some("main".into()),
            },
            cx,
        );
    });
    // a cloud workspace shown: Chat pins by its box; commands stay in the last local folder
    w.view.update(&mut w.cx, |v, cx| {
        v.set_shown_project(
            Some(ShownProject {
                dir: "/workspace/repo".into(),
                root: None,
                box_: Some("demo-shop-102".into()),
            }),
            cx,
        );
    });
    wait_both(&mut w, &mut scx, "the box", |_, _| {
        log(dir.path()).iter().any(|l| l == BOX)
    });
    // everything sent before the box's `open` is in the log by now
    let before_box: Vec<String> = after_caret(dir.path())
        .into_iter()
        .take_while(|l| l != BOX)
        .collect();
    assert!(
        before_box
            .iter()
            .any(|l| l
                == r#"{"type":"project","v":2,"root":"/p/shop-wt/1-show-stock","branch":"main"}"#),
        "the Editor's move was heard: {before_box:?}"
    );
    let told: Vec<&String> = before_box.iter().filter(|l| *l == NO_CARET).collect();
    assert_eq!(told.len(), 1, "no-caret is told once: {told:?}");
}
