//! The rail, on the real window with real keys and a fake bridge: Abe (the repo's main checkout)
//! first, the other workspaces as they opened, then the Board, Boxes and Pipelines. ⌘↑ / ⌘↓
//! go round the workspaces from either end (a place's tile is its click), ⌘← is the Board with
//! the card of the workspace you were in selected, ⌘→ from the Board goes into the selected card's workspace, ⌘§ is Abe and again back;
//! a move lands with the keys where they were as the tile (a workspace: its page) was left, Chat
//! on a first visit. Each workspace keeps its page and Code's panel (⌘3 its Git, ⌘T its Terminal,
//! ⌘J shown / hidden) and each tile its Chat (maximized here, docked there), kept for the next launch.
#![cfg(debug_assertions)]

use std::path::{Path, PathBuf};

use gpui_kit::Focusable as _;
use serde_json::{Value, json};
use vimstorm::shell::projects::{self, ChatMemory, ChatSize, Keys, Page, Tile, TileMemory};
use vimstorm::shell::{ColumnMode, PanelTab};

use crate::common::view::View;
use crate::pane::start;
use crate::stripe::{frame, receive};

/// The tile shown.
fn tile(v: &mut View) -> Tile {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| p.tile_now(cx))
}

/// The shown workspace's page.
fn page(v: &mut View) -> Page {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| p.page_now(cx))
}

/// The shown workspace's Code panel's tab (none: hidden).
fn panel(v: &mut View) -> Option<PanelTab> {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| {
        p.active().and_then(|ws| ws.read(cx).panel_shown(cx))
    })
}

/// The shown workspace's Code panel has the keys.
fn panel_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let Some(ws) = projects.read_with(&v.cx, |p, _| p.active().cloned()) else {
        return false;
    };
    v.cx.update(|window, cx| ws.read(cx).panel_has_keys(window, cx))
}

/// The shown workspace's folder (real).
fn shown(v: &mut View) -> PathBuf {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| {
        p.active()
            .map(|ws| ws.read(cx).project().clone())
            .unwrap_or_default()
    })
}

/// Chat (the shown workspace's column) has the keys.
fn chat_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let Some(column) = projects.read_with(&v.cx, |p, cx| {
        p.active().map(|ws| ws.read(cx).column().clone())
    }) else {
        return false;
    };
    v.cx.update(|window, cx| column.read(cx).has_keyboard(ColumnMode::Chat, window, cx))
}

/// The shown workspace's native surface with the keys (none: nvim's, the editor).
fn native(v: &mut View) -> Option<&'static str> {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| {
        p.active().and_then(|ws| ws.read(cx).native_focus())
    })
}

/// The page (the Factory view: the Board's list, Run, the Card page) has the keys.
fn page_has_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let Some(f) = projects.read_with(&v.cx, |p, _| p.factory().cloned()) else {
        return false;
    };
    v.cx.update(|window, cx| f.read(cx).focus_handle(cx).contains_focused(window, cx))
}

/// The code (the shown workspace's editor) has the keys.
fn code_has_keys(v: &mut View) -> bool {
    v.pump();
    let projects = v.projects.clone().unwrap();
    let Some(ws) = projects.read_with(&v.cx, |p, _| p.active().cloned()) else {
        return false;
    };
    v.cx.update(|window, cx| {
        let editor = ws.read(cx).editor().clone();
        editor
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
    })
}

/// The shown tile's Chat: docked, maximized or hidden.
fn chat_size(v: &mut View) -> ChatSize {
    v.pump();
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, cx| p.chat_now(cx).size)
}

/// A tile's Chat as a test's last quit left it: docked, Chat mode, 420 wide.
fn docked() -> ChatMemory {
    ChatMemory {
        size: ChatSize::Docked,
        ..ChatMemory::first(1400., 420.)
    }
}

/// The params of the last `chat` screen the bridge opened.
fn chat_opened(base: &Path) -> Option<Value> {
    crate::common::bridge::log(base)
        .iter()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|f| f["type"] == "open" && f["screen"] == "chat")
        .map(|f| f["params"].clone())
}

/// The feed saying `dir`'s session is card `card`'s, running.
fn feed(dir: &Path, card: u64) -> String {
    let mut doc: Value =
        serde_json::from_str(&frame("frames/bridge-shell-workspaces.json")).unwrap();
    let mut look = doc["effect"]["workspaces"][0].clone();
    look["root"] = json!(dir.display().to_string());
    look["box"] = Value::Null;
    look["cloud"] = Value::Null;
    look["cloudHue"] = Value::Null;
    look["story"]["id"] = json!(card);
    // idle: never shown, it lands on its code (a running one lands on Run, which this fake
    // bridge never draws)
    look["state"] = json!("idle");
    look["tab"] = json!(format!("#{card} card {card}"));
    doc["effect"]["workspaces"] = json!([look]);
    doc.to_string()
}

/// The demo repo (Abe) and a second workspace for card 7, its look in the feed, shown. The bridge
/// draws the Board on every open, a Card page or Run over it.
fn two_workspaces(base: &Path) -> (View, PathBuf, PathBuf) {
    let mut v = start(base);
    let screen = |name: &str| {
        let file = base.join(format!("{name}-tree.json"));
        let tree = json!({"kind": "Empty", "props": {"title": name, "line": ""}});
        let line = json!({"v": 2, "type": "tree", "screen": name, "rev": 1, "tree": tree});
        std::fs::write(&file, line.to_string()).unwrap();
        file
    };
    let (card, run) = (screen("card"), screen("run"));
    let command = crate::common::bridge::fake_on(
        base,
        &["frames/bridge-tree.json"],
        &[
            (r#""type":"open","v":2,"screen":"card""#, vec![card]),
            (r#""type":"open","v":2,"screen":"run""#, vec![run]),
        ],
    );
    v.cx.update(|_, cx| cx.set_global(command));
    receive(&mut v, &frame("frames/bridge-shell-stripe.json"));
    let abe = shown(&mut v);
    let other = base.join("card-7");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("b.ts"), "export const b = 1;\n").unwrap();
    let other = other.canonicalize().unwrap();
    receive(&mut v, &feed(&other, 7));
    let to = other.clone();
    v.cx.update(move |window, cx| projects::switch_to(to, window, cx));
    v.wait_until("card 7's workspace", |v| shown(v) == other);
    (v, abe, other)
}

#[test]
fn the_rail_goes_round_the_board_takes_the_cards_and_a_tile_left_in_chat_lands_in_chat() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (mut v, abe, other) = two_workspaces(&base);
    let (abe_t, other_t) = (Tile::Workspace(abe.clone()), Tile::Workspace(other.clone()));
    // card 7's Chat shown (a test window starts with it hidden)
    v.key("super+digit_4");
    v.wait_until("Chat has the keys", chat_keys);
    // ⌘↑ / ⌘↓ in the tile's group, round again from either end: the workspaces (Abe, card 7),
    // or (⌘← down to the Board, a click on Boxes or Pipelines) the places; ⌘→ back up
    for (how, to) in [
        ("super+arrow_down", abe_t.clone()),
        ("super+arrow_down", other_t.clone()),
        ("super+arrow_up", abe_t.clone()),
        ("super+arrow_up", other_t.clone()),
        ("super+arrow_left", Tile::Board),
        ("super+arrow_down", Tile::Boxes),
        ("super+arrow_down", Tile::Pipelines),
        ("super+arrow_down", Tile::Board),
        ("super+arrow_up", Tile::Pipelines),
        ("super+arrow_right", other_t.clone()),
        ("pipelines", Tile::Pipelines),
        ("super+arrow_up", Tile::Boxes),
        ("super+arrow_right", other_t.clone()),
        ("boxes", Tile::Boxes),
        ("super+arrow_left", Tile::Boxes),
        ("super+arrow_right", other_t.clone()),
        ("super+arrow_down", abe_t.clone()),
        ("super+arrow_down", other_t.clone()),
    ] {
        match how {
            "boxes" | "pipelines" => v.click_place(how),
            key => v.key(key),
        }
        v.wait_until(&format!("{how} to {to:?}"), |v| tile(v) == to);
        v.wait_until(&format!("Chat has the keys on {to:?}"), chat_keys);
        // Boxes and Pipelines: the Abe chat, never card 7's you came from
        if matches!(to, Tile::Boxes | Tile::Pipelines) {
            let want = json!({"abe": abe.display().to_string()});
            v.wait_until(&format!("the Abe chat on {to:?}"), |_| {
                chat_opened(&base) == Some(want.clone())
            });
        }
    }
    // ⌘←: the Board, card 7 (the workspace's) selected there
    let opens = |base: &Path| {
        crate::common::bridge::log(base)
            .iter()
            .filter(|l| l.contains(r#""screen":"factory""#) && l.contains(r#""card":"7""#))
            .count()
    };
    let before = opens(&base);
    v.key("super+arrow_left");
    v.wait_until("the Board", |v| tile(v) == Tile::Board);
    v.wait_until("card 7 selected on it", |_| opens(&base) > before);
    // again: nothing more to the left
    v.key("super+arrow_left");
    assert_eq!(tile(&mut v), Tile::Board);
    // ⌘→: into the selected card's workspace (the Board says card 7)
    let mut selected: Value =
        serde_json::from_str(&frame("frames/bridge-shell-selected.json")).unwrap();
    selected["effect"]["card"] = json!(7);
    receive(&mut v, &selected.to_string());
    v.key("super+§");
    v.wait_until("⌘§: Abe", |v| tile(v) == abe_t);
    v.key("super+§");
    v.wait_until("⌘§ again: back on the Board", |v| tile(v) == Tile::Board);
    v.key("super+arrow_right");
    v.wait_until("⌘→: card 7's workspace", |v| tile(v) == other_t);
    v.wait_until("Chat has the keys there", chat_keys);
    // inside a workspace ⌘→ is not the rail's
    v.key("super+arrow_right");
    assert_eq!(tile(&mut v), other_t);
}

#[test]
fn each_tile_and_page_lands_with_the_keys_where_they_were_left_kept_for_the_next_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (mut v, _abe, other) = two_workspaces(&base);
    let other_t = Tile::Workspace(other.clone());
    // card 7 left with the keys in Chat; the Board (a first visit: Chat's) left on its list (⌘1)
    v.key("super+digit_4");
    v.wait_until("Chat has the keys", chat_keys);
    v.key("super+arrow_left");
    v.wait_until("the Board, Chat with the keys", |v| {
        tile(v) == Tile::Board && chat_keys(v)
    });
    v.key("super+digit_1");
    v.wait_until("the Board's list has the keys", |v| {
        page_has_keys(v) && !chat_keys(v)
    });
    // ⌘→: card 7, the keys in Chat as it was left
    v.key("super+arrow_right");
    v.wait_until("card 7, Chat with the keys", |v| {
        tile(v) == other_t && chat_keys(v)
    });
    // ⌘← back: the Board's list, not Chat (shown there)
    v.key("super+arrow_left");
    v.wait_until("the Board's list has the keys again", |v| {
        tile(v) == Tile::Board && page_has_keys(v) && !chat_keys(v)
    });
    assert_eq!(chat_size(&mut v), ChatSize::Docked);
    // card 7's Run page left with the keys: back on it with them
    v.key("super+arrow_right");
    v.wait_until("card 7", |v| tile(v) == other_t && chat_keys(v));
    v.key("ctrl+digit_2");
    v.wait_until("Run with the keys", |v| {
        page(v) == Page::Run && page_has_keys(v)
    });
    v.key("super+arrow_left");
    v.wait_until("the Board's list", |v| {
        tile(v) == Tile::Board && page_has_keys(v)
    });
    v.key("super+arrow_right");
    v.wait_until("Run with the keys again", |v| {
        tile(v) == other_t && page(v) == Page::Run && page_has_keys(v) && !chat_keys(v)
    });
    // its code left with the keys (⌃1): back on it there, not in Chat
    v.key("ctrl+digit_1");
    v.wait_until("the code with the keys", |v| {
        page(v) == Page::Code && code_has_keys(v)
    });
    v.key("super+arrow_up");
    v.wait_until("Abe", |v| tile(v) != other_t);
    v.key("super+arrow_down");
    v.wait_until("the code with the keys again", |v| {
        tile(v) == other_t && page(v) == Page::Code && code_has_keys(v) && !chat_keys(v)
    });
    // kept for the next launch: the Board's list, card 7's Run and code
    let state = v.state_home().join("vimstorm");
    v.wait_until("where the keys were saved", |_| {
        let kept = TileMemory::load(&state);
        let keys = |page| kept.keys_left(&other_t, Some(page));
        kept.keys_left(&Tile::Board, None) == Some(Keys::Page)
            && [keys(Page::Code), keys(Page::Run), keys(Page::Card)]
                == [Some(Keys::Page), Some(Keys::Page), None]
    });
}

#[test]
fn where_the_keys_were_is_kept_for_the_next_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let abe = crate::pane::repo(&base);
    let abe_t = Tile::Workspace(abe.clone());
    // the last quit: the Board left on its list, its Chat docked
    let mut kept = TileMemory::default();
    kept.left(&Tile::Board, docked(), None, Keys::Page);
    let set = json!({"open": [abe], "active": abe}).to_string();
    let mut v = View::start_projects_launched_with(abe.to_str().unwrap(), move |_, home| {
        let state = home.join("vimstorm");
        std::fs::create_dir_all(&state).unwrap();
        kept.save(&state);
        std::fs::write(state.join("open-projects.json"), set).unwrap();
    });
    let command = crate::common::bridge::fake_on(&base, &["frames/bridge-tree.json"], &[]);
    v.cx.update(|_, cx| cx.set_global(command));
    receive(&mut v, &frame("frames/bridge-shell-stripe.json"));
    v.wait_until("Abe's Chat docked", |v| chat_size(v) == ChatSize::Docked);
    v.key("super+arrow_left");
    v.wait_until("the Board's list has the keys, Chat beside it", |v| {
        tile(v) == Tile::Board
            && page_has_keys(v)
            && !chat_keys(v)
            && chat_size(v) == ChatSize::Docked
    });
    v.key("super+arrow_right");
    v.wait_until("Abe", |v| tile(v) == abe_t);
}

#[test]
fn each_workspace_keeps_its_page_and_each_tile_its_chat_kept_for_the_next_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (mut v, abe, other) = two_workspaces(&base);
    // card 7 on the code, its panel hidden (a new workspace's starts so). ⌘T: on the Terminal,
    // again (with the keys) hidden. ⌘3 is Git's, passed over outside a git repository: Problems,
    // again hidden. In one, ⌘3 is Git; over the Terminal ⌘3 switches to Git and ⌘T to the
    // Terminal, never hiding. ⌘J hides the panel and shows it again on the tab it had; its Chat
    // maximized. Abe on the code, no panel, its Chat docked
    assert_eq!(panel(&mut v), None);
    v.key("super+t");
    v.wait_until("⌘T: the panel on the Terminal", |v| {
        panel(v) == Some(PanelTab::Terminal) && panel_keys(v)
    });
    v.key("super+t");
    v.wait_until("⌘T again: the panel hidden", |v| panel(v).is_none());
    v.key("super+digit_3");
    v.wait_until("⌘3 outside a repository: Problems", |v| {
        panel(v) == Some(PanelTab::Problems) && panel_keys(v)
    });
    v.key("super+digit_3");
    v.wait_until("⌘3 again: the panel hidden", |v| panel(v).is_none());
    crate::common::gitfix::git(&other, &["init", "-q", "-b", "main"]);
    v.key("super+digit_3");
    v.wait_until("⌘3: the panel on Git", |v| {
        panel(v) == Some(PanelTab::Git) && panel_keys(v)
    });
    v.key("super+t");
    v.wait_until("⌘T over Git: the Terminal", |v| {
        panel(v) == Some(PanelTab::Terminal) && panel_keys(v)
    });
    v.key("super+digit_3");
    v.wait_until("⌘3 over the Terminal: Git", |v| {
        panel(v) == Some(PanelTab::Git) && panel_keys(v)
    });
    v.key("super+digit_3");
    v.wait_until("⌘3 again: the panel hidden", |v| panel(v).is_none());
    assert_eq!(page(&mut v), Page::Code);
    v.key("super+j");
    v.wait_until("⌘J: the panel on the tab it had", |v| {
        panel(v) == Some(PanelTab::Git) && panel_keys(v)
    });
    v.key("super+j");
    v.wait_until("⌘J again: the panel hidden", |v| panel(v).is_none());
    // ⌘T and ⌘3 from the tree, the editor and Chat: theirs, no surface keeps them
    for (to, keys) in [
        ("super+digit_1", Some("tree")),
        ("super+digit_2", None),
        ("super+digit_4", Some("chat")),
    ] {
        v.key(to);
        v.wait_until(&format!("{to}: the keys there"), |v| native(v) == keys);
        for (key, tab) in [
            ("super+t", PanelTab::Terminal),
            ("super+digit_3", PanelTab::Git),
        ] {
            v.key(key);
            v.wait_until(&format!("{key} from {keys:?}: {tab:?}"), |v| {
                panel(v) == Some(tab) && panel_keys(v)
            });
            v.key(key);
            v.wait_until(&format!("{key} again: hidden"), |v| panel(v).is_none());
            v.key(to);
            v.wait_until(&format!("{to}: the keys there again"), |v| {
                native(v) == keys
            });
        }
    }
    // Chat hidden again, as a test window starts
    v.key("super+digit_4");
    v.wait_until("Chat hidden again", |v| chat_size(v) == ChatSize::Hidden);
    // the Card page's Chat in Claude Code mode is the session's Claude Code (as on the code), ⌃⌘←
    // Chat again; ⌘3 from there: the code, the panel on Git with the keys; ⌘T from the Card page:
    // the code, the panel on the Terminal
    v.key("ctrl+digit_3");
    v.wait_until("the Card page", |v| page(v) == Page::Card);
    v.key("super+ctrl+arrow_right");
    v.wait_until("Claude Code on the Card page", |_| {
        chat_opened(&base).is_some_and(|p| p["mode"] == "terminal")
    });
    v.key("super+ctrl+arrow_left");
    v.wait_until("Chat again", |_| {
        chat_opened(&base).is_some_and(|p| p.get("mode").is_none())
    });
    v.key("super+digit_3");
    v.wait_until("⌘3 from Card: the code, the panel on Git", |v| {
        page(v) == Page::Code && panel(v) == Some(PanelTab::Git) && panel_keys(v)
    });
    v.key("ctrl+digit_3");
    v.wait_until("the Card page again", |v| page(v) == Page::Card);
    v.key("super+t");
    v.wait_until("⌘T from Card: the code, the panel on its Terminal", |v| {
        page(v) == Page::Code && panel(v) == Some(PanelTab::Terminal) && panel_keys(v)
    });
    v.key("super+shift+digit_2");
    v.wait_until("Chat maximized", |v| chat_size(v) == ChatSize::Maximized);
    v.key("super+arrow_up");
    v.wait_until("Abe", |v| shown(v) == abe);
    v.wait_until("Abe's page: the code", |v| page(v) == Page::Code);
    assert_eq!(panel(&mut v), None);
    v.wait_until("Abe's Chat docked", |v| chat_size(v) == ChatSize::Docked);
    // Abe has no Run or Card page
    v.key("ctrl+digit_2");
    assert_eq!(page(&mut v), Page::Code);
    // back: the panel on the Terminal again, Chat maximized again, with the keys
    v.key("super+arrow_down");
    v.wait_until("card 7 again", |v| shown(v) == other);
    v.wait_until("its panel on the Terminal again", |v| {
        page(v) == Page::Code && panel(v) == Some(PanelTab::Terminal)
    });
    v.wait_until("its Chat maximized again", |v| {
        chat_size(v) == ChatSize::Maximized
    });
    v.wait_until("Chat has the keys", chat_keys);
    // ⌘⌥2 hides it and shows it again maximized, the size it had
    v.key("super+alt+digit_2");
    v.wait_until("Chat hidden", |v| chat_size(v) == ChatSize::Hidden);
    v.key("super+alt+digit_2");
    v.wait_until("Chat maximized again", |v| {
        chat_size(v) == ChatSize::Maximized
    });
    // the Board keeps its own Chat: hidden there, still maximized here
    v.key("super+arrow_left");
    v.wait_until("the Board", |v| tile(v) == Tile::Board);
    v.key("super+alt+digit_2");
    v.wait_until("the Board's Chat hidden", |v| {
        chat_size(v) == ChatSize::Hidden
    });
    v.key("super+arrow_right");
    v.wait_until("card 7, its Chat maximized", |v| {
        tile(v) == Tile::Workspace(other.clone()) && chat_size(v) == ChatSize::Maximized
    });
    // kept for the next launch, by the real folders
    let state = v.state_home().join("vimstorm");
    let other_t = Tile::Workspace(other.clone());
    v.wait_until("the page and the Chats saved", |_| {
        let kept = TileMemory::load(&state);
        let size = |t: &Tile| kept.chat(t).map(|c| c.size);
        kept.panel(&other_t)
            .is_some_and(|p| p.shown && p.tab == PanelTab::Terminal)
            && size(&other_t) == Some(ChatSize::Maximized)
            && size(&Tile::Board) == Some(ChatSize::Hidden)
    });
}

#[test]
fn a_launch_with_a_path_and_a_closed_workspace_land_with_the_tile_s_chat_as_it_was_left() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let abe = crate::pane::repo(&base);
    let abe_t = Tile::Workspace(abe.clone());
    // Abe's Chat left maximized at the last quit, Abe the set open then
    let mut kept = TileMemory::default();
    kept.keep_chat(
        &abe_t,
        ChatMemory {
            size: ChatSize::Maximized,
            ..docked()
        },
    );
    let set = json!({"open": [abe], "active": abe}).to_string();
    let mut v = View::start_projects_launched_with(abe.to_str().unwrap(), move |_, home| {
        let state = home.join("vimstorm");
        std::fs::create_dir_all(&state).unwrap();
        kept.save(&state);
        std::fs::write(state.join("open-projects.json"), set).unwrap();
    });
    let command = crate::common::bridge::fake_on(&base, &["frames/bridge-tree.json"], &[]);
    v.cx.update(|_, cx| cx.set_global(command));
    receive(&mut v, &frame("frames/bridge-shell-stripe.json"));
    // the launch with Abe's path: its Chat maximized, as it was left
    v.wait_until("Abe's Chat maximized", |v| {
        chat_size(v) == ChatSize::Maximized
    });
    // left, it stays kept maximized (never the docked a launch starts with)
    v.key("super+arrow_left");
    v.wait_until("the Board", |v| tile(v) == Tile::Board);
    let kept = TileMemory::load(&v.state_home().join("vimstorm"));
    assert_eq!(kept.chat(&abe_t).map(|c| c.size), Some(ChatSize::Maximized));
    v.key("super+arrow_right");
    v.wait_until("Abe, its Chat maximized again", |v| {
        tile(v) == abe_t && chat_size(v) == ChatSize::Maximized
    });
    // card 7's workspace shown, then closed: back on Abe, its Chat maximized as it was left
    let other = base.join("card-7");
    std::fs::create_dir_all(&other).unwrap();
    let other = other.canonicalize().unwrap();
    receive(&mut v, &feed(&other, 7));
    let to = other.clone();
    v.cx.update(move |window, cx| projects::switch_to(to, window, cx));
    v.wait_until("card 7's workspace", |v| shown(v) == other);
    v.cx.update(|window, cx| projects::close_active(None, window, cx));
    v.wait_until("closed: Abe, its Chat maximized", |v| {
        tile(v) == abe_t && chat_size(v) == ChatSize::Maximized
    });
}
