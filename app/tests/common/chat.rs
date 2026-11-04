//! The Chat column in tests: its window-wide state, the torn window, the fake bridge's frames for
//! the `chat` slot and the projects windows the Chat column tests start on.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gpui_kit::{AnyWindowHandle, Entity, Focusable as _, VisualTestContext};
use serde_json::json;
use vimstorm::factory::FactoryView;
use vimstorm::shell::{self, ColumnState};

use super::bridge::{fake_on, fixture, log};
use super::gitfix::git;
use super::view::View;

/// The window's Chat column state, after what is ready ran.
pub fn state(v: &mut View) -> ColumnState {
    v.pump();
    v.cx.update(|_, cx| shell::column_state(cx))
}

/// The torn window, if the column is torn out.
pub fn torn(v: &mut View) -> Option<AnyWindowHandle> {
    state(v).torn
}

/// A test context on the torn window.
pub fn torn_cx(v: &mut View) -> VisualTestContext {
    let handle = torn(v).expect("torn out");
    VisualTestContext::from_window(handle, &v.cx)
}

/// Where the shown workspace's native keyboard is (`chat` for the column).
pub fn native(v: &mut View) -> Option<&'static str> {
    v.read_ws(|ws, _| ws.native_focus())
}

/// nvim's focus target (`split`, `tree`...).
pub fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

pub fn wait_target(v: &mut View, want: &str) {
    v.wait_lua(
        &format!("focus.target() == {want}"),
        &format!("return require('config.focus').target() == '{want}'"),
    );
}

/// A repo with one commit, `a.ts`, at `base/name`.
pub fn repo(base: &Path, name: &str) -> PathBuf {
    let dir = base.join(name);
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

/// A frame file in `dir` the fake bridge prints.
pub fn frame(dir: &Path, name: &str, frame: serde_json::Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, frame.to_string()).unwrap();
    path
}

/// The Factory screen's `selected` on `card`, with its title as the Board has it.
pub fn selected(dir: &Path, card: u64, owner: Option<&str>) -> PathBuf {
    frame(
        dir,
        &format!("selected-{card}.json"),
        json!({"v": 2, "type": "shell", "effect": {
            "kind": "selected", "card": card, "owner": owner, "title": format!("Story {card}"),
        }}),
    )
}

/// The `chat` screen's `chat-session`.
pub fn chat_session(dir: &Path, session: Option<&str>) -> PathBuf {
    frame(
        dir,
        &format!("chat-session-{}.json", session.unwrap_or("none")),
        json!({"v": 2, "type": "shell", "effect": {"kind": "chat-session", "session": session}}),
    )
}

/// The window on a `demo-shop` repo with both columns shown: the fake bridge draws a Chat tree in
/// the chat slot, says the selection moved as `ö`, `ä` and `k` reach the Factory view, answers
/// the chat slot's Esc `unhandled` and ⏎ `focus {slot: chat}`; `more` rules after its own (a
/// frame both match prints the later one last).
pub fn on_board(base: &Path, more: Vec<(&str, Vec<PathBuf>)>) -> View {
    let dir = repo(base, "demo-shop");
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let chat = frame(
        base,
        "chat-tree.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "slot": "chat", "tree": {
            "kind": "Island", "id": "chat", "props": {},
            "children": [{"kind": "Empty", "props": {"title": "Chat from the bridge", "line": ""}}],
        }}),
    );
    let mut rules = vec![
        (r#""type":"open","v":2,"screen":"chat""#, vec![chat]),
        (r#""key":"ö""#, vec![selected(base, 5, None)]),
        (r#""key":"ä""#, vec![selected(base, 6, None)]),
        (r#""key":"k""#, vec![selected(base, 7, Some("Lee Park"))]),
        (
            r#""key":"<Esc>"},"slot":"chat""#,
            vec![frame(
                base,
                "unhandled.json",
                json!({"v": 2, "type": "shell", "effect": {"kind": "unhandled", "slot": "chat", "key": "<Esc>"}}),
            )],
        ),
        (
            r#""key":"<CR>""#,
            vec![frame(
                base,
                "focus-chat.json",
                json!({"v": 2, "type": "shell", "effect": {"kind": "focus", "slot": "chat"}}),
            )],
        ),
    ];
    rules.extend(more);
    let command = fake_on(base, &["frames/bridge-tree.json"], &rules);
    v.cx.update(|_, cx| {
        cx.set_global(command);
        shell::set_column_state(cx, |s| {
            s.open = true;
            s.factory_open = true;
        });
    });
    v
}

/// A projects window as the app starts it whose Chat column draws the contract's no-session chat
/// tree in the `chat` slot, its Esc answered `unhandled`.
pub fn with_chat_slot(base: &Path) -> View {
    let tree: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("trees/chat-no-session.json")).unwrap(),
    )
    .unwrap();
    let chat = frame(
        base,
        "chat-tree.json",
        json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "tree": tree, "slot": "chat"}),
    );
    let unhandled = frame(
        base,
        "unhandled.json",
        json!({"v": 2, "type": "shell", "effect": {"kind": "unhandled", "slot": "chat", "key": "<Esc>"}}),
    );
    let mut v = View::start_projects_app_column("proj", &["a.ts"]);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|_, cx| {
        cx.set_global(fake_on(
            base,
            &["frames/bridge-tree.json"],
            &[
                (r#""type":"open","v":2,"screen":"chat""#, vec![chat]),
                (r#""key":"<Esc>"},"slot":"chat""#, vec![unhandled]),
            ],
        ))
    });
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_until("the chat slot drawn", |v| {
        v.pump();
        v.cx.debug_bounds("factory-node-chat:launch").is_some()
    });
    v
}

/// The `open chat` frames sent so far, their params as JSON.
pub fn chat_opens(base: &Path) -> Vec<String> {
    log(base)
        .into_iter()
        .filter(|l| l.contains(r#""type":"open""#) && l.contains(r#""slot":"chat""#))
        .filter_map(|l| {
            let v: serde_json::Value = serde_json::from_str(&l).ok()?;
            Some(v["params"].to_string())
        })
        .collect()
}

/// Chat was last opened on what its target says now: the bridge's last `open` of the `chat` slot
/// carries the Factory view's own params (which ones a target gives is
/// `factory::chat_target`'s table). Its `branch` aside: the Editor reads a workspace's branch after
/// its folder, and a branch read later goes to Chat with `project`, never in another `open`.
pub fn chat_open_now(v: &mut View, base: &Path) -> bool {
    v.pump();
    let mut want = factory(v).read_with(&v.cx, |f, cx| f.chat_open_params(cx));
    want.remove("branch");
    chat_opens(base)
        .last()
        .and_then(|p| serde_json::from_str::<BTreeMap<String, String>>(p).ok())
        .is_some_and(|mut got| {
            got.remove("branch");
            got == want
        })
}

/// The `focus` frames sent to the bridge so far.
pub fn focus_frames(base: &Path) -> Vec<String> {
    log(base)
        .into_iter()
        .filter(|l| l.contains(r#""type":"focus""#))
        .collect()
}

/// The shown workspace's Chat column draws its header active (its selected segment blue).
pub fn column_active(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| {
        let ws = projects.read(cx).active().cloned().unwrap();
        let column = ws.read(cx).column().clone();
        column.read(cx).header_active(window, cx)
    })
}

/// The projects window's Factory view.
pub fn factory(v: &mut View) -> Entity<FactoryView> {
    let projects = v.projects.clone().unwrap();
    projects
        .read_with(&v.cx, |p, _| p.factory().cloned())
        .unwrap()
}

/// The Factory view (the Board) has the keyboard.
pub fn board_has_keys(v: &mut View) -> bool {
    let f = factory(v);
    v.pump();
    v.cx.update(|window, cx| f.read(cx).focus_handle(cx).contains_focused(window, cx))
}

/// Shows the Factory view (⌥⌘A) and waits for it.
pub fn show_factory(v: &mut View) {
    let projects = v.projects.clone().unwrap();
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        v.pump();
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
}

/// The Board (⌥⌘A) with its Chat hidden (⌘⌥2, the tile's own): the Board has the keys.
pub fn board_without_chat(v: &mut View) {
    show_factory(v);
    v.key("super+alt+digit_2");
    v.wait_until("the Board has the keys", board_has_keys);
}
