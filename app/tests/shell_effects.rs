//! The shell-effect table: each contract `shell` frame handed to the Projects window's Factory view
//! and what the window shell then holds or shows. The view only decodes a frame; the shell's
//! executor (`vimstorm::shell::effects`) applies it, so every row goes through the real window.
#![cfg(debug_assertions)]

use std::path::Path;

use gpui_kit::Entity;
use serde_json::{Value, json};
use vimstorm::factory::{BridgeFrame, FactoryShell, FactoryView, Feel, ShellEffect, WorkspaceFeed};
use vimstorm::shell::{self, ColumnMode};

use crate::common;
use crate::common::bridge::{echo_script, fake, fake_on, fixture, log};
use crate::common::chat::{
    board_has_keys, board_without_chat, chat_opens, chat_session, column_active, factory,
    focus_frames, frame, native, on_board, repo, show_factory, state, torn, torn_cx, wait_target,
    with_chat_slot,
};
use crate::common::view::View;

/// What a row checks once its frame is in: the window as the effect left it.
type Check = fn(&mut View, &Entity<FactoryView>, &ShellEffect) -> bool;

fn shell(v: &mut View) -> FactoryShell {
    v.cx.update(|_, cx| cx.try_global::<FactoryShell>().cloned())
        .unwrap_or_default()
}

/// The shown project's balloons' texts.
fn balloons(v: &mut View) -> Vec<String> {
    let popups = v
        .active_project()
        .read_with(&v.cx, |ws, _| ws.popups().clone());
    popups.read_with(&v.cx, |p, _| {
        p.balloons().into_iter().map(|(_, body)| body).collect()
    })
}

fn factory_shown(v: &mut View) -> bool {
    let projects = v.projects.clone().unwrap();
    projects.read_with(&v.cx, |p, _| p.factory_shown())
}

/// (contract frame, what the window holds after it). Rows run in order on one window.
const ROWS: &[(&str, Check)] = &[
    ("bridge-shell-status.json", |v, _, e| {
        let ShellEffect::Status { text } = e else {
            return false;
        };
        shell(v).status.as_ref() == Some(text)
    }),
    ("bridge-shell-clipboard.json", |v, _, e| {
        let ShellEffect::Clipboard { text } = e else {
            return false;
        };
        v.cx.read_from_clipboard().and_then(|c| c.text()).as_ref() == Some(text)
    }),
    ("bridge-shell-stripe.json", |v, _, e| {
        let ShellEffect::Stripe { items, gear } = e else {
            return false;
        };
        let s = shell(v);
        s.stripe == *items && s.gear == *gear
    }),
    ("bridge-shell-stripe-dot.json", |v, _, e| {
        let ShellEffect::StripeDot { dot } = e else {
            return false;
        };
        shell(v).stripe_dots.contains(dot)
    }),
    ("bridge-shell-widgets.json", |v, _, e| {
        let ShellEffect::Widgets { widgets } = e else {
            return false;
        };
        shell(v).widgets == *widgets
    }),
    ("bridge-shell-workspaces.json", |v, _, e| {
        let ShellEffect::Workspaces {
            workspaces,
            factory,
            answering,
            ..
        } = e
        else {
            return false;
        };
        v.cx.update(|_, cx| {
            cx.try_global::<WorkspaceFeed>().is_some_and(|f| {
                f.workspaces == *workspaces
                    && f.factory == *factory
                    && f.answering == *answering
                    && !f.bridge_down
            })
        })
    }),
    ("bridge-shell-feel.json", |v, _, e| {
        let ShellEffect::Feel { feel } = e else {
            return false;
        };
        v.cx.update(|_, cx| cx.try_global::<Feel>() == Some(feel))
    }),
    ("bridge-shell-chat-session.json", |v, f, e| {
        let ShellEffect::ChatSession { session } = e else {
            return false;
        };
        f.read_with(&v.cx, |f, _| f.chat_session() == Some(session.as_deref()))
    }),
    ("bridge-shell-chat-session-none.json", |v, f, _| {
        f.read_with(&v.cx, |f, _| f.chat_session() == Some(None))
    }),
    ("bridge-shell-selected.json", |v, f, e| {
        let ShellEffect::Selected { card, .. } = e else {
            return false;
        };
        f.read_with(&v.cx, |f, _| f.selected() == *card)
    }),
    ("bridge-shell-balloon.json", |v, _, e| {
        let ShellEffect::Balloon { text, .. } = e else {
            return false;
        };
        balloons(v).contains(text)
    }),
    ("bridge-shell-open-url.json", |v, _, e| {
        let ShellEffect::OpenUrl { url } = e else {
            return false;
        };
        v.cx.opened_url().as_ref() == Some(url)
    }),
    ("bridge-shell-view.json", |v, _, _| !factory_shown(v)),
];

#[test]
fn every_shell_effect_reaches_the_window_shell() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|_, cx| cx.set_global(fake(dir.path(), &["frames/bridge-tree.json"], None)));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    v.wait_until("the bridge started, its screen opened", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""type":"open""#))
    });
    let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
    for &(name, check) in ROWS {
        let line = std::fs::read_to_string(fixture(&format!("frames/{name}"))).unwrap();
        let frame: Value = serde_json::from_str(&line).unwrap();
        let Some(BridgeFrame::Shell { effect, .. }) = vimstorm::factory::read_line(&line) else {
            panic!("{name}: not a shell frame");
        };
        factory.update(&mut v.cx, |f, cx| f.receive_line(&frame.to_string(), cx));
        v.wait_until(name, |v| check(v, &factory, &effect));
    }
}

#[test]
fn terminal_tab_and_show_open_a_boxs_attach_and_the_boxes_tab() {
    common::table(&[
        ("enter_on_a_box_in_the_pane_opens_its_attach_in_the_terminal", boxes::enter_on_a_box_in_the_pane_opens_its_attach_in_the_terminal),
        ("a_repo_box_draws_its_workspaces_under_it_and_enter_on_one_attaches_to_its_card", boxes::a_repo_box_draws_its_workspaces_under_it_and_enter_on_one_attaches_to_its_card),
        ("enter_on_a_box_from_the_factory_view_shows_the_editor_with_the_attach", boxes::enter_on_a_box_from_the_factory_view_shows_the_editor_with_the_attach),
        ("the_status_bars_boxes_widget_is_red_with_why_on_both_views_and_a_click_shows_the_boxes_tab", boxes::the_status_bars_boxes_widget_is_red_with_why_on_both_views_and_a_click_shows_the_boxes_tab),
    ]);
}

#[test]
fn balloons_and_widgets_say_on_the_status_bar_and_go_with_their_cause() {
    common::table(&[
        ("errors_fade_go_with_their_cause_stay_when_they_need_you_and_are_kept", errors::errors_fade_go_with_their_cause_stay_when_they_need_you_and_are_kept),
        ("the_widgets_frame_shows_on_the_editor_quietly_and_cmd_alt_a_lands_in_chat_and_back", needs_you::the_widgets_frame_shows_on_the_editor_quietly_and_cmd_alt_a_lands_in_chat_and_back),
    ]);
}

#[test]
fn the_factory_view_and_the_column_follow_the_bridges_state() {
    common::table(&[
        (
            "a_restarted_bridge_opens_on_the_card_the_dead_one_had_selected",
            a_restarted_bridge_opens_on_the_card_the_dead_one_had_selected,
        ),
        (
            "a_restarted_bridge_opens_chat_on_the_session_chat_session_named",
            a_restarted_bridge_opens_chat_on_the_session_chat_session_named,
        ),
        (
            "drop_terminal_drops_a_held_terminal_at_once",
            drop_terminal_drops_a_held_terminal_at_once,
        ),
        (
            "the_feels_chat_settings_apply_once_at_the_start",
            the_feels_chat_settings_apply_once_at_the_start,
        ),
    ]);
}

#[test]
fn focus_and_an_unhandled_esc_move_the_keyboard() {
    common::table(&[
        ("an_unhandled_esc_from_the_chat_slot_gives_the_keys_back_and_restores_a_maximized_column", an_unhandled_esc_from_the_chat_slot_gives_the_keys_back_and_restores_a_maximized_column),
        ("an_unhandled_esc_in_the_torn_window_brings_the_main_window_back_on_the_code", an_unhandled_esc_in_the_torn_window_brings_the_main_window_back_on_the_code),
        ("focus_on_chat_gives_the_editors_column_the_keys", focus_on_chat_gives_the_editors_column_the_keys),
        ("focus_on_chat_from_the_board_gives_its_column_the_keys_and_unhandled_esc_gives_them_back", focus_on_chat_from_the_board_gives_its_column_the_keys_and_unhandled_esc_gives_them_back),
        ("focus_on_chat_with_the_column_in_terminal_mode_gives_chat_mode_the_keys_never_the_sessions_terminal", focus_on_chat_with_the_column_in_terminal_mode_gives_chat_mode_the_keys_never_the_sessions_terminal),
        ("focus_on_chat_on_landing_tells_the_bridge_and_lights_the_column", focus_on_chat_on_landing_tells_the_bridge_and_lights_the_column),
    ]);
}

#[test]
fn open_project_open_file_show_and_expand_land_where_the_bridge_says() {
    common::table(&[
        ("the_last_project_closing_shows_welcome_and_open_project_on_a_card_brings_the_window_back", welcome_stripe_review::the_last_project_closing_shows_welcome_and_open_project_on_a_card_brings_the_window_back),
        ("open_project_of_the_project_just_closed_opens_it_on_its_card_rooted_there", welcome_stripe_review::open_project_of_the_project_just_closed_opens_it_on_its_card_rooted_there),
        ("open_project_with_chat_lands_in_the_workspace_with_the_keys_in_its_chat_column", editor_side::open_project_with_chat_lands_in_the_workspace_with_the_keys_in_its_chat_column),
        ("linkeds_boxes_row_shows_the_boxes_tile", editor_side::linkeds_boxes_row_shows_the_boxes_tile),
        ("open_file_shows_the_editor_with_the_file_at_the_line", open_file_shows_the_editor_with_the_file_at_the_line),
        ("stripe_open_goes_to_the_tile_or_page_it_names_and_tells_the_bridge_the_place", welcome_stripe_review::stripe_open_goes_to_the_tile_or_page_it_names_and_tells_the_bridge_the_place),
        ("the_run_bars_expand_maximizes_the_main_area_and_again_or_esc_restores", editor_side::the_run_bars_expand_maximizes_the_main_area_and_again_or_esc_restores),
        ("a_caret_menu_item_chosen_in_command_mode_runs_in_the_editor", editor_item::a_caret_menu_item_chosen_in_command_mode_runs_in_the_editor),
    ]);
}

#[test]
fn welcome_and_clone_project_change_the_project_list() {
    common::table(&[
        ("welcome_draws_its_crumb_and_forget_project_lists_the_projects_without_it", welcome_stripe_review::welcome_draws_its_crumb_and_forget_project_lists_the_projects_without_it),
        ("clone_project_clones_into_the_clones_folder_and_opens_it", welcome_stripe_review::clone_project_clones_into_the_clones_folder_and_opens_it),
    ]);
}

#[test]
fn the_review_effects_reach_the_git_window_of_the_project_reviewed() {
    common::table(&[
        ("a_comment_drafted_in_the_diff_reaches_the_screen_and_review_said_marks_the_gutter", welcome_stripe_review::a_comment_drafted_in_the_diff_reaches_the_screen_and_review_said_marks_the_gutter),
        ("pr_pick_lists_the_screens_rows_and_review_open_reviews_the_pr_in_its_worktree", welcome_stripe_review::pr_pick_lists_the_screens_rows_and_review_open_reviews_the_pr_in_its_worktree),
    ]);
}

#[test]
fn the_workspaces_feed_draws_the_rail_and_the_header() {
    common::table(&[
        (
            "the_workspaces_feed_draws_a_story_worktree_and_the_main_checkout",
            editor_side::the_workspaces_feed_draws_a_story_worktree_and_the_main_checkout,
        ),
        (
            "a_box_workspace_says_its_story_and_its_box_never_its_folder",
            editor_side::a_box_workspace_says_its_story_and_its_box_never_its_folder,
        ),
    ]);
}

/// The screen's `selected` lands in the Factory view, so a restarted bridge opens on the card the
/// dead one had selected, not on the first card a fresh screen picks.
fn a_restarted_bridge_opens_on_the_card_the_dead_one_had_selected() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let command = fake(
        dir.path(),
        &[
            "frames/bridge-tree.json",
            "frames/bridge-shell-selected.json",
        ],
        Some("once"),
    );
    v.cx.update(|_, cx| cx.set_global(command));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
    let opens = |dir: &std::path::Path| -> Vec<String> {
        log(dir)
            .into_iter()
            .filter(|l| l.contains(r#""type":"open""#) && l.contains(r#""screen":"factory""#))
            .collect()
    };
    v.wait_until("started again, its screen opened", |v| {
        factory.read_with(&v.cx, |f, _| f.starts() == 2) && opens(dir.path()).len() == 2
    });
    let opens = opens(dir.path());
    assert!(!opens[0].contains(r#""card""#), "{}", opens[0]);
    assert!(
        opens[1].contains(r#""params":{"card":"4","tab":"mine"}"#),
        "{}",
        opens[1]
    );
}

fn an_unhandled_esc_from_the_chat_slot_gives_the_keys_back_and_restores_a_maximized_column() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = with_chat_slot(dir.path());
    let ws = v.active_project();
    v.key("super+digit_4");
    v.wait_until("Chat with the keyboard", |v| native(v) == Some("chat"));
    v.key("escape");
    wait_target(&mut v, "split");
    assert!(
        v.read(|e| e.geometry().layout.frame.chat.is_some()),
        "Esc keeps the column"
    );
    assert!(
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""key":"<Esc>"},"slot":"chat""#)),
        "Esc reached the slot's screen first"
    );
    // maximized: Esc goes to the slot's screen first; its `unhandled` restores, Chat keeps the
    // keyboard
    v.cx.update(|_, cx| ws.update(cx, |ws, cx| ws.restore_maximized(cx)));
    let maximized = |v: &mut View| {
        v.pump();
        v.read_ws(|ws, cx| ws.maximized(cx))
    };
    v.key("super+digit_4");
    v.wait_until("the slot has the keyboard", |v| native(v) == Some("chat"));
    v.key("super+alt+enter");
    v.wait_until("Chat maximized", |v| {
        maximized(v) == Some(vimstorm::shell::Island::Chat)
    });
    let escs = |dir: &Path| {
        log(dir)
            .iter()
            .filter(|l| l.contains(r#""key":"<Esc>"},"slot":"chat""#))
            .count()
    };
    let sent = escs(dir.path());
    v.key("escape");
    v.wait_until("restored by the unhandled Esc", |v| maximized(v).is_none());
    assert_eq!(escs(dir.path()), sent + 1, "the slot's screen had it first");
    assert_eq!(native(&mut v), Some("chat"), "Chat keeps the keyboard");
}

fn an_unhandled_esc_in_the_torn_window_brings_the_main_window_back_on_the_code() {
    let dir = tempfile::tempdir().unwrap();
    let mut v = with_chat_slot(dir.path());
    v.key("super+shift+d");
    v.wait_until("torn out", |v| torn(v).is_some());
    let mut tcx = torn_cx(&mut v);
    tcx.run_until_parked();
    tcx.update(|w, _| w.activate_window());
    tcx.run_until_parked();
    assert!(
        !v.cx.update(|w, _| w.is_window_active()),
        "the torn window is the active one"
    );
    // Esc there: the screen had it first and answered `unhandled`: the main window comes to the
    // front with the keyboard in the code
    tcx.simulate_keystrokes("escape");
    v.wait_until("Esc reached the chat slot", |_| {
        log(dir.path())
            .iter()
            .any(|l| l.contains(r#""key":"<Esc>"},"slot":"chat""#))
    });
    v.wait_until("the main window active again", |v| {
        v.pump();
        v.cx.update(|w, _| w.is_window_active())
    });
    assert!(torn(&mut v).is_some(), "the column stays torn out");
}

fn the_feels_chat_settings_apply_once_at_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut feel: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("frames/bridge-shell-feel.json")).unwrap(),
    )
    .unwrap();
    feel["effect"]["feel"]["chat"] = json!({"openByDefault": false, "width": 500});
    let path = dir.path().join("feel.json");
    std::fs::write(&path, feel.to_string()).unwrap();
    let mut v = View::start_projects_app_column("proj", &["a.ts"]);
    let projects = v.projects.clone().unwrap();
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_until("the column shown", |v| {
        v.read(|e| e.geometry().layout.frame.chat.is_some())
    });
    v.cx.update(|_, cx| {
        cx.set_global(fake_on(
            dir.path(),
            &[],
            &[(r#""type":"hello""#, vec![path])],
        ))
    });
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    // `chat.openByDefault` off: hidden once the bridge's first `feel` came; `chat.width` its width
    v.wait_until("the column hidden", |v| {
        v.read(|e| e.geometry().layout.frame.chat.is_none())
    });
    let s = state(&mut v);
    assert_eq!((s.width, s.settings_pending), (500., false));
    // once: ⌘2 shows it again and the settings never close it again
    v.key("super+digit_4");
    v.wait_until("the column shown again", |v| {
        v.read(|e| e.geometry().layout.frame.chat.is_some())
    });
}

fn focus_on_chat_gives_the_editors_column_the_keys() {
    // as ⏎ on a Sessions row or `:override` do (`focus {slot: chat}`): the Chat column shown on
    // Chat with the keyboard, not only asked for
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let dir = repo(&base, "demo-shop");
    let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
    let focus = frame(
        &base,
        "focus-chat.json",
        json!({"v": 2, "type": "shell", "effect": {"kind": "focus", "slot": "chat"}}),
    );
    let command = fake_on(
        &base,
        &["frames/bridge-tree.json"],
        &[(r#""type":"open","v":2,"screen":"chat""#, vec![focus])],
    );
    v.cx.update(|_, cx| {
        cx.set_global(command);
        shell::set_column_state(cx, |s| {
            s.open = true;
            s.mode = ColumnMode::Chat;
        });
    });
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let ws = v.active_project();
    let column = ws.read_with(&v.cx, |ws, _| ws.column().clone());
    v.wait_until("the column's Chat has the keyboard", |v| {
        v.pump();
        let c = column.clone();
        v.cx.update(|window, cx| c.read(cx).has_keyboard(ColumnMode::Chat, window, cx))
    });
}

fn focus_on_chat_from_the_board_gives_its_column_the_keys_and_unhandled_esc_gives_them_back() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    board_without_chat(&mut v);
    v.key("enter");
    v.wait_until("the column shown with the keys", |v| {
        v.pump();
        v.cx.debug_bounds("factory-chat-column").is_some() && !board_has_keys(v)
    });
    let s = v.cx.update(|_, cx| shell::column_state(cx));
    assert!(s.factory_open, "{s:?}");
    v.key("escape");
    v.wait_until("the Board has the keys again", board_has_keys);
    assert!(
        v.cx.debug_bounds("factory-chat-column").is_some(),
        "Esc keeps the column"
    );
}

fn focus_on_chat_with_the_column_in_terminal_mode_gives_chat_mode_the_keys_never_the_sessions_terminal()
 {
    // a launch or ⏎ on a card asks for Chat with the keys: a column left in Terminal mode shows
    // Chat, so Esc and `:` meant for the app never reach the session's Claude Code
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = on_board(&base, Vec::new());
    // the Board's Chat left in Claude Code (⌘4), hidden (⌘⌥2)
    show_factory(&mut v);
    v.key("super+ctrl+arrow_right");
    v.wait_until("Claude Code on the Board", |v| {
        v.cx.update(|_, cx| shell::column_state(cx)).factory_mode == ColumnMode::Terminal
    });
    v.key("super+alt+digit_2");
    v.wait_until("the Board has the keys", board_has_keys);
    v.key("enter");
    v.wait_until("the column has the keys", |v| {
        v.pump();
        !board_has_keys(v) && column_active(v)
    });
    let s = v.cx.update(|_, cx| shell::column_state(cx));
    assert_eq!(s.factory_mode, ColumnMode::Chat, "{s:?}");
    assert!(s.factory_open, "{s:?}");
}

fn focus_on_chat_on_landing_tells_the_bridge_and_lights_the_column() {
    // the Factory view shown from the Editor lands on Chat with the keys (`focus {slot: chat}`):
    // the bridge hears where they went (the composer draws its caret, the Board grey)
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let landing = frame(
        &base,
        "landing-focus-chat.json",
        json!({"v": 2, "type": "shell", "effect": {"kind": "focus", "slot": "chat"}}),
    );
    let mut v = on_board(&base, vec![(r#""from":"editor""#, vec![landing])]);
    v.cx.update(|_, cx| shell::set_column_state(cx, |s| s.factory_open = false));
    show_factory(&mut v);
    let factory = factory(&mut v);
    v.wait_until("Chat has the keys, looks it, and the bridge knows", |v| {
        v.pump();
        let slot = factory.read_with(&v.cx, |f, _| f.focused_slot());
        slot == Some(vimstorm::factory::Slot::Chat)
            && column_active(v)
            && focus_frames(&base)
                .last()
                .is_some_and(|l| l.contains(r#""slot":"chat""#))
    });
}

fn a_restarted_bridge_opens_chat_on_the_session_chat_session_named() {
    use vimstorm::factory::{Slot, UserInput};
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    // Chat moves to s7 by itself (a session picked in it): the shell only hears chat-session
    let mut v = on_board(
        &base,
        vec![(r#""key":"<F20>""#, vec![chat_session(&base, Some("s7"))])],
    );
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    v.wait_until("Chat opened", |v| {
        v.pump();
        !chat_opens(&base).is_empty()
    });
    let factory = factory(&mut v);
    let say = |v: &mut View, key: &str| {
        let f = factory.clone();
        let key = key.to_owned();
        v.cx.update(|_, cx| {
            f.update(cx, |f, cx| {
                f.send_slot_input(Slot::Chat, UserInput::Key { key }, cx)
            })
        });
    };
    say(&mut v, "<F20>");
    v.wait_until("the shell heard s7", |v| {
        factory.read_with(&v.cx, |f, _| f.chat_session() == Some(Some("s7")))
    });
    assert!(chat_opens(&base).iter().all(|p| !p.contains("s7")));
    // the bridge dies; the new one opens Chat on s7, not on the workspace's first session
    let before = chat_opens(&base).len();
    say(&mut v, "<F35>");
    v.wait_until("Chat opened again on s7", |v| {
        v.pump();
        let opens = chat_opens(&base);
        opens.len() > before
            && opens
                .last()
                .is_some_and(|p| p.contains(r#""session":"s7""#))
    });
    assert_eq!(factory.read_with(&v.cx, |f, _| f.starts()), 2);
}

/// `open-file` (⏎ on a diff card): the Editor shown, the file open at the line.
fn open_file_shows_the_editor_with_the_file_at_the_line() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let dir = projects.read_with(&v.cx, |p, _| p.dirs())[0].clone();
    let file = dir.join("cart.ts");
    std::fs::write(&file, "one\ntwo\nthree\nfour\nfive\n").unwrap();
    let path = base.join("open-file.json");
    std::fs::write(
        &path,
        json!({
            "v": 2, "type": "shell",
            "effect": { "kind": "open-file", "path": file, "line": 4 },
        })
        .to_string(),
    )
    .unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", path.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("w");
    v.wait_until("the Editor on cart.ts at line 4", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown())
            && v.lua("return vim.fn.expand('%:t') .. ':' .. vim.fn.line('.')")
                .as_str()
                == Some("cart.ts:4")
    });
}

/// `drop-terminal` lets a terminal go at once, even while a tree holds it.
fn drop_terminal_drops_a_held_terminal_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let script = echo_script(dir.path());
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|_, cx| cx.set_global(fake(dir.path(), &["frames/bridge-tree.json"], None)));
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
    v.wait_until("the bridge's tree", |v| {
        factory.read_with(&v.cx, |f, _| f.rev() == Some(1))
    });
    let tree = json!({
        "v": 2, "type": "tree", "screen": vimstorm::factory::FIRST_SCREEN, "rev": 2,
        "tree": { "kind": "Island", "id": "chat", "props": {}, "children": [{
            "kind": "Terminal", "id": "chat-terminal",
            "props": { "key": "b", "argv": [script], "focused": false },
        }]},
    });
    factory.update(&mut v.cx, |f, cx| f.receive_line(&tree.to_string(), cx));
    v.wait_until("the terminal runs", |v| {
        factory.read_with(&v.cx, |f, _| f.terminal_keys() == ["b"])
    });
    let drop = json!({"v": 2, "type": "shell", "effect": {"kind": "drop-terminal", "key": "b"}});
    factory.update(&mut v.cx, |f, cx| f.receive_line(&drop.to_string(), cx));
    v.wait_until("dropped while its tree still holds it", |v| {
        factory.read_with(&v.cx, |f, _| f.terminal_keys().is_empty())
    });
}

/// Welcome's open-project, forget-project, welcome and clone-project, the stripe's stripe-open,
/// and the review's review-said, pr-pick and review-open.
mod welcome_stripe_review {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use gpui_kit::{Size, size};
    use serde_json::{Value, json};
    use vimstorm::factory::{PickRow, Verdict};
    use vimstorm::git::window::TabId;
    use vimstorm::shell::projects::{OpenRequest, Page, Tile, open_path};

    use crate::abe_review::*;
    use crate::common;
    use crate::common::bridge::{fake, log};
    use crate::common::view::View;
    use crate::projects::welcome_shown;
    use crate::stripe::receive;

    // ---- Welcome -------------------------------------------------------------------------------------

    fn copy(name: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let out = std::process::Command::new("cp")
            .arg("-R")
            .arg(common::fixtures().join(name))
            .arg(&root)
            .output()
            .unwrap();
        assert!(out.status.success(), "cp {name}");
        (tmp, root.join(name))
    }

    fn window_size(v: &mut View) -> Size<f32> {
        v.cx.update(|window, _| {
            let s = window.bounds().size;
            size(f32::from(s.width), f32::from(s.height))
        })
    }

    /// A fake bridge that prints Welcome's tree on every `open`, and on ⏎ the screen's
    /// `open-project` of `dir` on card 101.
    fn bridge(log_dir: &Path, dir: &Path) -> vimstorm::factory::BridgeCommand {
        let open = log_dir.join("open-card.json");
        std::fs::write(
            &open,
            serde_json::json!({
                "v": 2,
                "type": "shell",
                "effect": { "kind": "open-project", "path": dir, "card": 101 },
            })
            .to_string(),
        )
        .unwrap();
        let mut command = fake(log_dir, &["frames/bridge-tree-welcome.json"], None);
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!(r#""key":"<CR>"={}"#, open.display()),
        ));
        command
    }

    pub(super) fn the_last_project_closing_shows_welcome_and_open_project_on_a_card_brings_the_window_back()
     {
        let tmp = tempfile::tempdir().unwrap();
        let (_t, b) = copy("grepo");
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        let command = bridge(tmp.path(), &b);
        v.cx.update(|_, cx| cx.set_global(command));
        let project_size = window_size(&mut v);

        // ⌘Q on the last project: Close Project, then Welcome, the app still up
        v.key("super+q");
        v.wait_until("Welcome shown", welcome_shown);
        assert!(
            !projects.read_with(&v.cx, |p, _| p.quitting()),
            "the app stays"
        );
        v.wait_until(
            "its screen opened on the recent projects, from home",
            |_| {
                let sent = log(tmp.path());
                sent.iter()
                    .any(|l| l.contains(r#""screen":"welcome""#) && l.contains(r#""projects""#))
            },
        );
        v.wait_until("the welcome tree drawn", |v| {
            v.cx.debug_bounds("factory-node-welcome").is_some()
                && v.cx.debug_bounds("welcome-status").is_some()
        });
        assert_eq!(
            window_size(&mut v),
            size(1000., 680.),
            "Welcome's own frame"
        );
        let home = vimstorm::shell::home();
        assert!(
            log(tmp.path())
                .iter()
                .any(|l| l.contains(&format!(r#""root":"{}""#, home.display()))),
            "commands run from home: {:?}",
            log(tmp.path())
        );

        // keys go to the screen, the Board's ⌘ keys too (its rail's ⌘5 / ⌘6, ⌘⏎, Esc)
        for (typed, sent) in [
            ("ö", "ö"),
            ("super+digit_5", "<D-5>"),
            ("super+digit_6", "<D-6>"),
            ("super+enter", "<D-CR>"),
            ("escape", "<Esc>"),
        ] {
            v.key(typed);
            let want = format!(r#""key":"{sent}""#);
            v.wait_until(&format!("{typed} reached the bridge as {sent}"), |_| {
                log(tmp.path()).iter().any(|l| l.contains(&want))
            });
        }
        // ⏎ on a card: the screen's open-project on card 101, the normal window back on it
        v.key("enter");
        v.wait_until("the project open", |v| {
            projects.read_with(&v.cx, |p, _| p.dirs()) == [b.clone()]
        });
        v.wait_until("the Factory view on the card", |v| {
            projects.read_with(&v.cx, |p, _| !p.welcome_shown() && p.factory_shown())
                && log(tmp.path())
                    .iter()
                    .any(|l| l.contains(r#""screen":"factory""#) && l.contains(r#""card":"101""#))
        });
        assert_eq!(
            window_size(&mut v),
            project_size,
            "the project's frame back"
        );
        assert!(v.cx.debug_bounds("welcome-status").is_none());

        // closing it again: Welcome; the Dock / `vimstorm <dir>`: the Editor on that project
        v.key("super+q");
        v.wait_until("Welcome again", welcome_shown);
        let req = OpenRequest {
            dir: b.clone(),
            file: None,
        };
        v.cx.cx.update(|cx| open_path(req, cx)).unwrap();
        v.wait_until("the Editor on it", |v| {
            projects.read_with(&v.cx, |p, _| {
                p.dirs() == [b.clone()] && !p.welcome_shown() && !p.factory_shown()
            })
        });
        assert_eq!(window_size(&mut v), project_size);
    }

    pub(super) fn open_project_of_the_project_just_closed_opens_it_on_its_card_rooted_there() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        let dir = projects.read_with(&v.cx, |p, _| p.dirs()[0].clone());
        let real = dir.canonicalize().unwrap();
        let command = bridge(tmp.path(), &dir);
        v.cx.update(|_, cx| cx.set_global(command));
        v.key("super+q");
        v.wait_until("Welcome shown", welcome_shown);
        // at once: its nvim may still be saving; the open waits for it and the card is kept
        v.key("enter");
        v.wait_until("the Factory view on the card in that project", |v| {
            projects.read_with(&v.cx, |p, _| {
                p.dirs().len() == 1 && !p.welcome_shown() && p.factory_shown()
            }) && log(tmp.path())
                .iter()
                .any(|l| l.contains(r#""screen":"factory""#) && l.contains(r#""card":"101""#))
        });
        v.wait_until("the bridge rooted in the project again, not home", |_| {
            log(tmp.path())
                .iter()
                .rev()
                .find(|l| l.contains(r#""type":"project""#))
                .is_some_and(|l| l.contains(&format!(r#""root":"{}""#, real.display())))
        });
    }

    pub(super) fn welcome_draws_its_crumb_and_forget_project_lists_the_projects_without_it() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        let dir = projects.read_with(&v.cx, |p, _| p.dirs()[0].clone());
        let shell = |name: &str, effect: serde_json::Value| {
            let f = tmp.path().join(name);
            let frame = serde_json::json!({ "v": 2, "type": "shell", "effect": effect });
            std::fs::write(&f, frame.to_string()).unwrap();
            f.display().to_string()
        };
        let forget = shell(
            "forget.json",
            serde_json::json!({ "kind": "forget-project", "path": dir }),
        );
        let said = shell(
            "said.json",
            serde_json::json!({ "kind": "status", "text": "Removed from the list" }),
        );
        let mut command = fake(
            tmp.path(),
            &[
                "frames/bridge-tree-welcome.json",
                "frames/bridge-shell-welcome.json",
            ],
            None,
        );
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!(r#""key":"x"={forget} {said}"#),
        ));
        v.cx.update(|_, cx| cx.set_global(command));
        v.key("super+q");
        v.wait_until("Welcome shown", welcome_shown);
        // the screen's word: the board's crumb on the status bar (the Dock badge is AppKit's)
        v.wait_until("the crumb on the status bar", |v| {
            v.cx.debug_bounds("welcome-crumb").is_some()
        });
        let opens = |dir: &Path| -> Vec<bool> {
            log(tmp.path())
                .iter()
                .filter(|l| l.contains(r#""screen":"welcome""#))
                .map(|l| l.contains(&*dir.to_string_lossy()))
                .collect()
        };
        v.wait_until("its screen opened and drawn", |v| {
            !opens(&dir).is_empty() && v.cx.debug_bounds("factory-node-welcome").is_some()
        });
        // Remove from list: the screen opened again on the projects without it
        assert_eq!(opens(&dir).first(), Some(&true), "the project listed first");
        v.key("x");
        v.wait_until("the projects read again, without it", |_| {
            let o = opens(&dir);
            o.len() >= 2 && o.last() == Some(&false)
        });
        // the screen's words on Welcome: the status bar (no project's balloons here)
        v.wait_until("its words on the status bar", |v| {
            v.cx.debug_bounds("welcome-note").is_some()
        });
    }

    /// Clone…: the screen's `clone-project` clones into the clones folder and opens it; a folder
    /// already there opens as it is; a clone that fails says why on the status bar.
    pub(super) fn clone_project_clones_into_the_clones_folder_and_opens_it() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let origin = base.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("a.txt"), "a\n").unwrap();
        for args in [
            &["init", "-q"][..],
            &["add", "a.txt"],
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "a",
            ],
        ] {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&origin)
                .status()
                .unwrap();
            assert!(ok.success(), "git {args:?}");
        }
        let clones = base.join("clones");
        let shell = |name: &str, url: &Path| {
            let f = base.join(name);
            let frame = serde_json::json!({
                "v": 2, "type": "shell",
                "effect": { "kind": "clone-project", "url": url },
            });
            std::fs::write(&f, frame.to_string()).unwrap();
            f.display().to_string()
        };
        let good = shell("clone.json", &origin);
        let bad = shell("bad.json", &base.join("nowhere"));
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        let mut command = fake(&base, &["frames/bridge-tree-welcome.json"], None);
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!("\"key\":\"c\"={good}\n\"key\":\"x\"={bad}"),
        ));
        let into = clones.clone();
        v.cx.update(|_, cx| {
            cx.set_global(command);
            cx.set_global(vimstorm::shell::projects::ClonesDir(into));
        });
        v.key("super+q");
        v.wait_until("Welcome shown", welcome_shown);
        // a URL that does not clone: its words on the status bar, Welcome stays
        v.key("x");
        v.wait_until("why on the status bar", |v| {
            v.cx.debug_bounds("welcome-note").is_some()
        });
        assert!(welcome_shown(&mut v));
        // cloned, then opened
        v.key("c");
        let cloned = clones.join("origin");
        v.wait_until("the clone open", |v| {
            projects.read_with(&v.cx, |p, _| p.dirs()) == [cloned.clone()]
        });
        assert!(cloned.join("a.txt").exists());
        // again from Welcome: there already, opened as it is
        v.key("super+q");
        v.wait_until("Welcome again", welcome_shown);
        v.key("c");
        v.wait_until("the same folder open again", |v| {
            projects.read_with(&v.cx, |p, _| p.dirs()) == [cloned.clone()]
        });
    }

    // ---- the stripe ----------------------------------------------------------------------------------

    pub(super) fn stripe_open_goes_to_the_tile_or_page_it_names_and_tells_the_bridge_the_place() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let mut v = crate::pane::start(&base);
        let projects = v.projects.clone().unwrap();
        let tile = |v: &mut View| {
            v.pump();
            projects.read_with(&v.cx, |p, cx| p.tile_now(cx))
        };
        let projects2 = v.projects.clone().unwrap();
        let page = move |v: &mut View| {
            v.pump();
            projects2.read_with(&v.cx, |p, cx| p.page_now(cx))
        };
        let open = |id: &str| {
            format!(r#"{{"v":2,"type":"shell","effect":{{"kind":"stripe-open","id":"{id}"}}}}"#)
        };
        receive(&mut v, &open("board"));
        v.wait_until("Go to Board: the Board", |v| tile(v) == Tile::Board);
        v.wait_until("the bridge told the Board's place", |_| {
            log(&base)
                .iter()
                .any(|l| l.contains(r#""type":"window""#) && l.contains(r#""place":"board""#))
        });
        receive(&mut v, &open("project"));
        v.wait_until("Go to Project: the code", |v| {
            !tile(v).is_place() && page(v) == Page::Code
        });
        receive(&mut v, &open("boxes"));
        v.wait_until("Go to Boxes: its tile", |v| tile(v) == Tile::Boxes);
        receive(&mut v, &open("git"));
        v.wait_until("Go to Git: Code's panel on Git", |v| {
            page(v) == Page::Code
                && v.read_ws(|ws, cx| ws.panel_shown(cx)) == Some(vimstorm::shell::PanelTab::Git)
        });
    }

    // ---- the review ----------------------------------------------------------------------------------

    /// The Git Log's PR pick on the shown project, as the chip's `PR ⌄` opens it.
    fn open_pr_pick(v: &mut View) {
        let ws = v.active_project();
        let log = ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).log().clone());
        v.cx.update(|window, cx| {
            let at = gpui_kit::point(gpui_kit::px(200.), gpui_kit::px(40.));
            log.update(cx, |l, cx| {
                l.open_pr_pick(vimstorm::kit::Anchor::Point(at), window, cx)
            })
        });
    }

    pub(super) fn a_comment_drafted_in_the_diff_reaches_the_screen_and_review_said_marks_the_gutter()
     {
        let r = pr_repo();
        let draft = json!({
            "seq": 1, "path": "src/b.ts", "side": "RIGHT", "line": 2, "body": "guard",
            "head": r.head, "outdated": false
        });
        let mut rules = opened(&r);
        rules.extend([
            (
                r#""kind":"comment","path":"src/b.ts""#.to_owned(),
                vec![
                    tree_frame(
                        &r,
                        &Pane {
                            drafted: vec![draft.clone()],
                            ..Pane::default()
                        },
                    ),
                    said(&r, "✎ Draft on b.ts:2 · ,is submits 1 draft in one review"),
                ],
            ),
            (
                r#""kind":"verdict","verdict":"APPROVE""#.to_owned(),
                vec![
                    tree_frame(&r, &Pane::default()),
                    said(&r, "✓ Approve sent to PR #7, 1 comment in one review"),
                ],
            ),
        ]);
        let mut v = start(&r, rules);
        let ws = into_the_diff(&mut v, &r);

        // `,is` with no summary and no draft: the dialog on Comment, its Submit refused in place
        v.key(",");
        v.key("i");
        v.key("s");
        v.wait_until("the dialog", |v| dialog(v, &ws).is_some());
        assert_eq!(dialog(&mut v, &ws), Some(Verdict::Comment));
        v.key("enter");
        v.advance(Duration::from_millis(200));
        assert_eq!(
            dialog(&mut v, &ws),
            Some(Verdict::Comment),
            "nothing to send: it stays"
        );
        v.key("escape");
        v.wait_until("the dialog gone", |v| dialog(v, &ws).is_none());
        keyboard_to_the_diff(&mut v, &ws);

        // `,ic`: the writing card under the caret's line (b.ts:2, G21); the comment typed at once,
        // before the card has the keyboard: held by nvim, typed into the card, never into the diff
        v.key(",");
        v.key("i");
        v.key("c");
        v.keystrokes("g u a r d");
        v.wait_until("the writing card", |v| writing_card(v, &ws).is_some());
        assert!(
            field(&mut v, &ws).is_none(),
            "no native field: the card in the diff"
        );
        assert_eq!(writing_card(&mut v, &ws).unwrap().0, "Comment on line 2");
        v.wait_until("the card drawn under its line", |v| {
            v.advance(Duration::from_millis(30));
            v.pump();
            v.cx.debug_bounds("review-card-writing-field").is_some()
        });
        v.wait_until("the keys typed early are in the card", |v| {
            v.advance(Duration::from_millis(30));
            writing_card(v, &ws).is_some_and(|(_, text)| text == "guard")
        });
        // typed in the card: the diff the surface with the keyboard, Space a space (never nvim's)
        v.keystrokes("space i t");
        v.wait_until("Space types a space in the card", |v| {
            writing_card(v, &ws).is_some_and(|(_, text)| text == "guard it")
        });
        assert!(
            v.cx.debug_bounds("button-review-card-writing-primary")
                .is_some(),
            "Save draft ⏎"
        );
        v.key("enter");
        v.wait_until("the comment asked", |_| {
            asks(&r).iter().any(|a| a["kind"] == "comment")
        });
        let comment = asks(&r)
            .into_iter()
            .find(|a| a["kind"] == "comment")
            .unwrap();
        assert_eq!(
            comment,
            json!({
                "kind": "comment", "path": "src/b.ts", "side": "RIGHT", "line": 2, "body": "guard it",
                "base": r.base, "head": r.head
            }),
            "the caret's line of the diff shown"
        );
        // the screen's answer: a balloon in the diff, the draft's mark in the PR head's gutter
        v.wait_until("the draft's balloon", |v| {
            balloons(v, &ws)
                .iter()
                .any(|(_, body)| body.starts_with("✎ Draft on b.ts:2"))
        });
        v.wait_until("the draft's mark in the PR head's gutter", |v| {
            viewer(v, &ws).is_some_and(|d| {
                d.panes[1]
                    .drafts
                    .iter()
                    .map(|x| (x.line, x.body.as_str()))
                    .collect::<Vec<_>>()
                    == [(2, "guard")]
                    && d.panes[0].drafts.is_empty()
            })
        });
        // the draft's card under its line (G15): Delete… asks first, Cancel keeps it
        let card: &'static str = "review-card-draft-1";
        let delete_id: &'static str = "button-review-card-delete-1";
        v.wait_until("the card holds its buttons", |v| {
            v.advance(Duration::from_millis(30));
            v.pump();
            match (v.cx.debug_bounds(card), v.cx.debug_bounds(delete_id)) {
                (Some(c), Some(d)) => c.contains(&d.center()),
                _ => false,
            }
        });
        let delete = v.cx.debug_bounds(delete_id).expect("Delete…").center();
        v.click(gpui_kit::MouseButton::Left, delete);
        v.wait_until("Delete asks first", |v| {
            menu_rows(v).is_some_and(|r| r.first().map(String::as_str) == Some("Cancel"))
        });
        v.key("enter");
        v.wait_until("asked", |v| menu_rows(v).is_none());
        assert!(
            !asks(&r).iter().any(|a| a["kind"] == "delete"),
            "Cancel keeps the draft"
        );
        keyboard_to_the_diff(&mut v, &ws);

        // `,ia`: the Submit review dialog on Approve; Esc first takes it back
        v.key(",");
        v.key("i");
        v.key("a");
        v.wait_until("the Submit review dialog", |v| dialog(v, &ws).is_some());
        assert_eq!(dialog(&mut v, &ws), Some(Verdict::Approve));
        assert!(v.cx.debug_bounds("submit-review-dialog").is_some(), "drawn");
        v.key("escape");
        v.wait_until("the dialog gone", |v| dialog(v, &ws).is_none());
        v.advance(Duration::from_millis(200));
        assert!(
            !asks(&r).iter().any(|a| a["kind"] == "verdict"),
            "Esc sends nothing"
        );
        // the strip's Approve… opens it too; ⏎ sends the verdict to the screen
        let approve =
            v.cx.debug_bounds("button-pr-approve")
                .expect("Approve…")
                .center();
        v.click(gpui_kit::MouseButton::Left, approve);
        v.wait_until("the Submit review dialog", |v| dialog(v, &ws).is_some());
        assert_eq!(dialog(&mut v, &ws), Some(Verdict::Approve));
        v.key("enter");
        v.wait_until("the verdict asked", |_| {
            asked(
                &r,
                json!({"kind": "verdict", "verdict": "APPROVE", "body": ""}),
            )
        });
        v.wait_until("its balloon", |v| {
            balloons(v, &ws)
                .iter()
                .any(|(_, body)| body == "✓ Approve sent to PR #7, 1 comment in one review")
        });
        // sent: no draft waits, no mark
        v.wait_until("the mark gone", |v| {
            v.advance(Duration::from_millis(50));
            viewer(v, &ws).is_some_and(|d| d.panes[1].drafts.is_empty())
        });
    }

    pub(super) fn pr_pick_lists_the_screens_rows_and_review_open_reviews_the_pr_in_its_worktree() {
        let r = pr_repo();
        let mut rules = opened(&r);
        let first = common::fixtures().join("proj");
        rules.extend([
            (
                r#""pick":""#.to_owned(),
                vec![json!({"v": 2, "type": "shell", "effect": {
                    "kind": "pr-pick", "root": first.to_string_lossy(), "repo": "o/r",
                    "rows": [
                        {"caption": "Others"},
                        {"number": 7, "label": "#7 AB#1 Fix the login   ada", "note": "Open"}
                    ]
                }})],
            ),
            (
                r#""kind":"pick","number":7"#.to_owned(),
                vec![json!({"v": 2, "type": "shell", "effect": {
                    "kind": "review-open", "path": r.tree.to_string_lossy(), "repo": "o/r",
                    "number": 7, "unchecked": null
                }})],
            ),
            (
                r#""kind":"lifecycle","id":"pr-close""#.to_owned(),
                vec![tree_frame(&r, &Pane::default())],
            ),
        ]);
        let mut v = start(&r, rules);
        let ws = v.active_project();
        let log_tab = ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).log().clone());
        assert_eq!(
            active_dir(&mut v).canonicalize().unwrap(),
            first.canonicalize().unwrap()
        );
        // the chip's `PR ⌄`: the screen opened on the pick for this checkout; its rows the menu
        open_pr_pick(&mut v);
        v.wait_until("the PR pick", |v| {
            menu_rows(v).is_some_and(|r| r.iter().any(|x| x.contains("#7 AB#1 Fix the login")))
        });
        let open = log(&r.dir)
            .into_iter()
            .find(|l| l.contains(r#""pick":""#))
            .expect("the pick opened");
        let open: Value = serde_json::from_str(&open).unwrap();
        assert_eq!(open["params"], json!({"pick": first.to_string_lossy()}));
        let picked = log_tab.read_with(&v.cx, |l, _| l.pr_pick_rows.clone());
        assert_eq!(
            picked,
            [
                PickRow::Caption {
                    caption: "Others".into()
                },
                PickRow::Pr {
                    number: 7,
                    label: "#7 AB#1 Fix the login   ada".into(),
                    note: "Open".into()
                }
            ]
        );
        // ⏎: the pick asked; the screen's review-open shows the worktree, the Log filtered to it
        v.key("enter");
        v.wait_until("the PR's worktree shown", |v| active_dir(v) == r.tree);
        assert!(asked(&r, json!({"kind": "pick", "number": 7})));
        let ws = v.active_project();
        v.wait_until("the Log on PR #7", |v| {
            v.pump();
            ws.read_with(&v.cx, |ws, cx| {
                let g = ws.git().read(cx);
                g.active() == TabId::Log
                    && g.log().read(cx).pr_number(cx) == Some(7)
                    && g.log().read(cx).filters.pr.is_some()
            })
        });
        let chips = ws.read_with(&v.cx, |ws, cx| {
            ws.git().read(cx).log().read(cx).filter_bar_text().to_vec()
        });
        assert!(chips.iter().any(|c| c == "PR: #7 ×"), "{chips:?}");
        // the branch has PR 7 under review: the Git header's Draft PR… is grey, saying so
        v.wait_until("Draft PR… grey with PR #7", |v| {
            v.pump();
            ws.read_with(&v.cx, |ws, cx| {
                ws.git()
                    .read(cx)
                    .header()
                    .read(cx)
                    .right_actions()
                    .iter()
                    .any(|a| {
                        a.id == "create-draft-pr"
                            && a.disabled
                            && a.tooltip.contains("PR #7 is already open")
                    })
            })
        });
        // the Log's menu: the strip's actions and the PR's lifecycle, each grey with why
        let log_tab = ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).log().clone());
        v.wait_until("the strip read", |v| {
            v.pump();
            ws.read_with(&v.cx, |ws, cx| {
                ws.git().read(cx).review().read(cx).strip(cx).is_some()
            })
        });
        let run = |v: &mut View, row: &str| {
            v.wait_until("no menu up", |v| menu_rows(v).is_none());
            v.cx.update(|window, cx| {
                log_tab.update(cx, |l, cx| {
                    l.context_menu(
                        vimstorm::kit::Anchor::Point(gpui_kit::point(
                            gpui_kit::px(100.),
                            gpui_kit::px(100.),
                        )),
                        window,
                        cx,
                    )
                })
            });
            let shown = v.active_project();
            v.use_project(&shown);
            common::gitui::pick_menu(v, row);
        };
        v.cx.update(|window, cx| {
            log_tab.update(cx, |l, cx| {
                l.context_menu(
                    vimstorm::kit::Anchor::Point(gpui_kit::point(
                        gpui_kit::px(100.),
                        gpui_kit::px(100.),
                    )),
                    window,
                    cx,
                )
            })
        });
        v.wait_until("the Log's menu", |v| {
            menu_rows(v).is_some_and(|r| r.iter().any(|x| x.starts_with("Approve…")))
        });
        let menu = menu_rows(&mut v).unwrap();
        for row in [
            "Approve…",
            "Request Changes…",
            "Comment…",
            "Submit Review (0)…",
            "Open Pull Request in Browser",
            "Mark ready for review",
            "Close without merging",
            "Clear PR Filter",
        ] {
            assert!(menu.iter().any(|r| r.starts_with(row)), "{row}: {menu:?}");
        }
        assert!(
            menu.iter()
                .any(|r| r.starts_with("Merge into main (squash) · needs approval")),
            "merge grey with why: {menu:?}"
        );
        v.key("escape");
        run(&mut v, "Approve…");
        v.wait_until("the Submit review dialog on Approve", |v| {
            dialog(v, &ws) == Some(Verdict::Approve)
        });
        v.key("escape");
        v.wait_until("the dialog gone", |v| dialog(v, &ws).is_none());
        run(&mut v, "Close without merging");
        v.wait_until("close asked of the screen", |_| {
            asked(&r, json!({"kind": "lifecycle", "id": "pr-close"}))
        });
        // the chip's ×: the plain Log of the worktree again (it stays open), the slot told
        v.cx.update(|_, cx| log_tab.update(cx, |l, cx| l.clear_pr(cx)));
        v.wait_until("the PR filter cleared", |v| {
            v.pump();
            ws.read_with(&v.cx, |ws, cx| {
                let l = ws.git().read(cx).log().read(cx);
                l.pr_number(cx).is_none() && l.filters.pr.is_none()
            })
        });
        assert_eq!(active_dir(&mut v), r.tree, "the worktree stays open");
        assert!(
            log(&r.dir)
                .iter()
                .any(|l| l.contains(r#""slot":"review""#) && l.contains(r#""params":{}"#)),
            "the review slot emptied"
        );
    }
}

/// The editor side's: open-project and show from the jumps, expand and the workspaces feed.
mod editor_side {
    use std::path::{Path, PathBuf};

    use gpui_kit::px;
    use serde_json::{Value, json};
    use vimstorm::factory::Segment;
    use vimstorm::factory::{CloudState, Hue, WorkspaceState};
    use vimstorm::factory::{ContextLine, TabParts, WorkspaceFeed};
    use vimstorm::shell::projects::FactoryIsland;
    use vimstorm::shell::{self, ColumnMode};

    use crate::common::bridge::{fake, fixture, log};
    use crate::common::gitfix::git;
    use crate::common::view::View;
    use crate::jumps::{factory, frame, nvim_has_keyboard, window};
    use crate::maximize::factory::{board_has_keys, drawn, max, start as factory_start};
    use crate::remote_workspace::{frame as attach_frame, wrapper};

    // open-project and show -------------------------------------------------------------------------

    /// `open-project {chat}` from the Factory view lands in the workspace with the Chat column on
    /// Chat and the keyboard there, for its composer.
    pub(super) fn open_project_with_chat_lands_in_the_workspace_with_the_keys_in_its_chat_column() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        let wt = dir.join("demo-shop-wt/2-cart-total");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("cart.ts"), "export const total = 2;\n").unwrap();
        let open = frame(
            &dir,
            "open.json",
            json!({"v": 2, "type": "shell", "effect": {"kind": "open-project", "path": wt, "chat": true}}),
        );
        let mut v = window(&dir, &[]);
        let projects = v.projects.clone().unwrap();
        // from the Factory view
        v.key("super+alt+a");
        v.wait_until("the Factory view", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        let line = std::fs::read_to_string(&open).unwrap();
        factory(&v).update(&mut v.cx, |f, cx| f.receive_line(&line, cx));
        v.wait_until("#2's workspace shown", |v| {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.project() == &wt)
        });
        assert!(!projects.read_with(&v.cx, |p, _| p.factory_shown()));
        let ws = v.active_project();
        v.use_project(&ws);
        v.wait_lua("nvim started", crate::common::STARTED);
        v.wait_until("the Chat column on Chat", |v| {
            let s = v.cx.update(|_, cx| shell::column_state(cx));
            s.open && s.mode == ColumnMode::Chat
        });
        let column = ws.read_with(&v.cx, |ws, _| ws.column().clone());
        v.wait_until("the keyboard in its Chat column", |v| {
            v.pump();
            let c = column.clone();
            v.cx.update(|window, cx| c.read(cx).has_keyboard(ColumnMode::Chat, window, cx))
        });
        assert!(!nvim_has_keyboard(&mut v));
    }

    /// `show {place: boxes}` (Linked's Box row) shows the Boxes tile, the keys in Chat's composer.
    pub(super) fn linkeds_boxes_row_shows_the_boxes_tile() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let show = frame(
            dir,
            "show.json",
            json!({"v": 2, "type": "shell", "effect": {"kind": "show", "place": "boxes"}}),
        );
        let mut v = window(dir, &[(r#""to":"linked""#, vec![show])]);
        // (as Linked's Box row's ⏎ hands it: the Boxes tile)
        v.key("ctrl+alt+l");
        let projects = v.projects.clone().unwrap();
        v.wait_until("the Boxes tile", |v| {
            v.pump();
            projects.read_with(&v.cx, |p, cx| p.tile_now(cx))
                == vimstorm::shell::projects::Tile::Boxes
        });
        // the Factory view's pane on Boxes, the keys in Chat's composer (a rail move)
        v.wait_until("the pane on Boxes", |v| {
            v.pump();
            projects.read_with(&v.cx, |p, cx| {
                p.factory_pane_view().map(|f| f.read(cx).tab())
                    == Some(Some(vimstorm::shell::PaneTab::Boxes))
            })
        });
        v.wait_until("Chat has the keys", crate::common::chat::column_active);
    }

    // expand ----------------------------------------------------------------------------------------

    /// The Run bar's `expand` maximizes the main area as ⌥⌘⏎ does, Chat not drawn; again restores, and
    /// so does an Esc the screen leaves unhandled.
    pub(super) fn the_run_bars_expand_maximizes_the_main_area_and_again_or_esc_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (mut v, projects, factory) = factory_start(&base);
        // (the rail's move gave Chat the keys: Esc gives them to the Board, where the Run bar is)
        v.key("escape");
        v.wait_until("the Board has the keys", |v| board_has_keys(v, &factory));
        let expand = |v: &mut View| {
            factory.update(&mut v.cx, |f, cx| {
                f.receive_line(r#"{"v":2,"type":"shell","effect":{"kind":"expand"}}"#, cx)
            });
        };
        expand(&mut v);
        v.wait_until("the main area maximized", |v| {
            max(v, &projects) == Some(FactoryIsland::Board)
        });
        assert!(!drawn(&mut v, "factory-chat-column"), "Chat not drawn");
        expand(&mut v);
        v.wait_until("restored", |v| max(v, &projects).is_none());
        assert!(drawn(&mut v, "factory-chat-column"), "Chat back");
        expand(&mut v);
        v.wait_until("maximized again", |v| max(v, &projects).is_some());
        v.wait_until("the Board has the keys", |v| board_has_keys(v, &factory));
        v.key("escape");
        v.wait_until("Esc restored", |v| max(v, &projects).is_none());
    }

    // workspaces: the feed drawn on the rail, the toolbar's line, the tree's root and the status bar --

    /// `demo-shop` on main with one commit, and card 2's worktree beside it on its story branch.
    fn demo_shop(base: &Path) -> (PathBuf, PathBuf) {
        let main = base.join("demo-shop");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        std::fs::write(main.join("a.ts"), "export const a = 1;\n").unwrap();
        git(&main, &["add", "."]);
        git(
            &main,
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
        let wt = base.join("demo-shop-wt/2-cart-total");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "card/2-the-cart-total-ignores-quantity",
                wt.to_str().unwrap(),
            ],
        );
        (main, wt)
    }

    /// The contract's feed with card 2's worktree at `wt` and card 1 on box `box_`, written into `dir`.
    fn feed(dir: &Path, wt: &Path, box_: &str) -> PathBuf {
        let mut doc: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("frames/bridge-shell-workspaces.json")).unwrap(),
        )
        .unwrap();
        for w in doc["effect"]["workspaces"].as_array_mut().unwrap() {
            match w["story"]["id"].as_u64() {
                Some(2) => w["root"] = Value::from(wt.to_str().unwrap()),
                Some(1) => {
                    w["box"] = Value::from(box_);
                    w["line"][2]["text"] = Value::from(box_);
                }
                _ => {}
            }
        }
        let path = dir.join("workspaces.json");
        std::fs::write(&path, doc.to_string()).unwrap();
        path
    }

    fn tabs(v: &mut View) -> Vec<TabParts> {
        let projects = v.projects.clone().unwrap();
        v.pump();
        projects.read_with(&v.cx, |p, cx| p.rail_parts(cx))
    }

    fn line(v: &mut View) -> ContextLine {
        v.pump();
        v.read_ws(|ws, cx| ws.toolbar().read(cx).context_line().clone())
    }

    fn badges(l: &ContextLine) -> Vec<(String, Hue)> {
        match l {
            ContextLine::Badges { chips, .. } => {
                chips.iter().map(|c| (c.text.clone(), c.hue)).collect()
            }
            ContextLine::Factory(f) => f.line.iter().map(|c| (c.text.clone(), c.hue)).collect(),
            _ => Vec::new(),
        }
    }

    fn open_project(v: &mut View, dir: &Path) {
        v.lua(&format!(
            "require('config.app.toolbar').open_project('{}') return true",
            dir.display()
        ));
        v.wait_until("the project shown", |v| {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.project() == dir)
        });
        let ws = v.active_project();
        v.use_project(&ws);
        v.wait_lua("nvim started", crate::common::STARTED);
    }

    fn s(t: &str) -> String {
        t.to_owned()
    }

    pub(super) fn the_workspaces_feed_draws_a_story_worktree_and_the_main_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (main, wt) = demo_shop(&base);
        let feed = feed(&base, &wt, "demo-shop-102");
        let mut v = View::start_projects(main.to_str().unwrap(), &["a.ts"]);
        let projects = v.projects.clone().unwrap();
        let mut command = fake(
            &base,
            &[feed.to_str().unwrap(), "frames/bridge-shell-widgets.json"],
            None,
        );
        // a click on the line: then serve stops answering
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!(
                "\"to\":\"linked\"={}",
                fixture("frames/bridge-shell-workspaces-down.json").display()
            ),
        ));
        v.cx.update(|_, cx| cx.set_global(command));
        // the launch's start: the bridge follows while the Editor stays shown
        v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
        v.wait_until("the feed", |v| {
            v.cx.update(|_, cx| cx.has_global::<WorkspaceFeed>())
        });

        // the main checkout: its folder's name, no dot, no rail; its line `demo-shop · main`
        v.wait_until("the main checkout's tab", |v| {
            tabs(v).first().is_some_and(|t| t.name == "demo-shop")
        });
        let t = &tabs(&mut v)[0];
        assert_eq!((t.state, t.rail.len(), t.cloud), (None, 0, None));
        v.wait_until("demo-shop · main", |v| {
            badges(&line(v)) == [(s("demo-shop"), Hue::Accent), (s("main"), Hue::Dim)]
        });
        assert!(
            v.cx.debug_bounds("toolbar-title").is_none(),
            "never the title beside it"
        );

        // a notice on the status line is the project's it was said in: gone on another one
        let status = std::fs::read_to_string(fixture("frames/bridge-shell-status.json")).unwrap();
        let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
        factory.update(&mut v.cx, |f, cx| f.receive_line(&status, cx));
        v.wait_until("the notice", |v| super::shell(v).status.is_some());

        // card 2's worktree: `● <id> cart total ignores quantity`, its rail, no cloud (local)
        open_project(&mut v, &wt);
        v.wait_until("the notice gone", |v| super::shell(v).status.is_none());
        // never shown, its card running: it lands on Run (the bridge asked for it); ⌃1 its code
        v.wait_until("Run opened", |_| {
            log(&base).iter().any(|l| l.contains(r#""screen":"run""#))
        });
        v.key("ctrl+digit_1");
        v.wait_until("#2's tab", |v| {
            tabs(v)
                .get(1)
                .is_some_and(|t| t.name == "#2 cart total ignores quantity")
        });
        let t = tabs(&mut v)[1].clone();
        assert_eq!(t.state, Some(WorkspaceState::Running));
        assert_eq!(t.dot, Some((s("●"), Hue::Warn)));
        use Segment::{Done, Now, Todo};
        assert_eq!(t.rail, [Done, Now, Todo, Todo, Todo]);
        assert_eq!(t.cloud, None);
        assert_eq!(
            t.tooltip,
            "#2 The cart total ignores quantity · Build · Running 21 min · Local sandbox"
        );
        // its tile on the rail: its letters over the stage bar in its lower half; the main
        // checkout's has none
        let (wt_key, main_key) = (wt.display(), main.display());
        let tile = crate::common::gitui::bounds(&mut v, &format!("rail-tile-{wt_key}")).unwrap();
        assert!(
            crate::common::gitui::bounds(&mut v, &format!("rail-letters-{wt_key}-CT")).is_some(),
            "CT: Cart Total"
        );
        let bar = crate::common::gitui::bounds(&mut v, &format!("rail-stages-{wt_key}")).unwrap();
        assert!(
            tile.contains(&bar.center()) && bar.center().y > tile.center().y,
            "{bar:?} {tile:?}"
        );
        assert!(
            crate::common::gitui::bounds(&mut v, &format!("rail-stages-{main_key}")).is_none(),
            "the main checkout has none"
        );

        // the context line: badges in their hues, left to right, centred in the toolbar
        assert_eq!(
            badges(&line(&mut v)),
            [
                (s("#2 cart total ignores…"), Hue::Accent),
                (s("Build ● Running 21 min"), Hue::Warn),
                (s("Local"), Hue::Dim),
                (s("PR —"), Hue::Dim),
            ]
        );
        let first = v.cx.debug_bounds("toolbar-badge-0").unwrap();
        let last = v.cx.debug_bounds("toolbar-badge-3").unwrap();
        assert!(first.right() <= last.left() && last.bottom() <= px(30.));
        assert_eq!(first.size.height, px(20.));
        let middle = (first.left() + last.right()) / 2.;
        let width = v.cx.update(|window, _| window.viewport_size().width);
        assert!(
            (middle - width / 2.).abs() < px(24.),
            "{middle:?} of {width:?}"
        );

        // the status bar: the story in the folder's place, the editor's own, then the branch
        v.wait_until("the story crumb", |v| {
            v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().clone())
                .crumbs
                .first()
                .is_some_and(|c| c == "#2 cart total ignores quantity")
        });
        v.wait_until("the branch at the right end", |v| {
            v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().clone())
                .right
                .last()
                .is_some_and(|b| b == "card/2-the-cart-total-ignores-quantity")
        });
        // the tree's root row: the story bold, its path dim
        let tree = v.read_ws(|ws, _| ws.tree().clone());
        let root = tree.read_with(&v.cx, |t, _| t.row_label(0)).unwrap();
        assert_eq!(root[0], (s("cart total ignores quantity"), true));
        assert_eq!(
            root[1],
            (
                format!("\u{a0}\u{a0}{}", vimstorm::shell::display_path(&wt)),
                false
            )
        );
        // the empty editor's caption under Abe's face
        let caption = v
            .read_ws(|ws, cx| ws.tabs().read(cx).face_caption(cx))
            .unwrap();
        let words: String = caption.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(words, "cart total ignores quantity · Build ● Running");
        assert_eq!(caption[1].hue, Some(vimstorm::look::ABE_WARN.rgba()));

        // the Factory view: its own line and bar, no workspace's branch
        v.key("super+alt+a");
        v.wait_until("the Factory view", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        v.wait_until(
            "Factory · demo-shop · Sprint 1 · ◆ 1 needs you · ● 1 running",
            |v| matches!(line(v), ContextLine::Factory(_)),
        );
        assert_eq!(
            badges(&line(&mut v)),
            [
                (s("demo-shop"), Hue::Accent),
                (s("Sprint 1"), Hue::Dim),
                (s("◆ 1 needs you"), Hue::NeedsYou),
                (s("● 1 running"), Hue::Warn),
            ]
        );
        v.pump();
        let drawn = v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().clone());
        assert_eq!(drawn.crumbs, ["demo-shop · Sprint 1"]);
        assert_eq!(
            drawn.right,
            ["◆ 1 needs you", "● 1 running"],
            "no branch, no line:col"
        );
        assert_eq!(
            v.read_ws(|ws, cx| ws.statusbar().read(cx).segment_text(cx)),
            "ABE · BOARD"
        );
        v.key("super+alt+a");
        v.wait_until("the Editor again", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown())
        });

        // a click on the line opens Linked as ⌃L does: a jump from the toolbar
        v.wait_until("the line drawn", |v| {
            v.cx.debug_bounds("toolbar-context").is_some()
        });
        let ctx = v.cx.debug_bounds("toolbar-context").unwrap();
        crate::common::gitui::left(&mut v, ctx.center());
        v.wait_until("the click reached the bridge", |_| {
            log(&base).iter().any(|l| {
                l.contains(r#""type":"jump""#)
                    && l.contains(r#""to":"linked","from":{"place":"toolbar""#)
            })
        });
        // serve stopped answering: the line says so, dim
        v.wait_until("abe serve not answering", |v| line(v) == ContextLine::Down);
        // nothing it said counts: card 2's tab is its branch's story with no dot, no rail
        v.wait_until("no dot while serve is down", |v| {
            tabs(v)
                .get(1)
                .is_some_and(|t| t.dot.is_none() && t.rail.is_empty())
        });
        assert_eq!(tabs(&mut v)[1].name, "#2 cart total ignores quantity");

        // another repo open whose folder is `demo-shop` too: each main checkout's face and window
        // title say its parent folder, the worktree's title its repo before its folder
        let b = base.join("b/demo-shop");
        std::fs::create_dir_all(&b).unwrap();
        git(&b, &["init", "-q", "-b", "main"]);
        open_project(&mut v, &b);
        v.wait_lua("b's title", "return vim.o.titlestring == 'b/demo-shop'");
        let mine = format!("{}/demo-shop", base.file_name().unwrap().to_string_lossy());
        for (dir, letters) in [(&b, "BD"), (&main, "TD")] {
            let sel = format!("rail-letters-{}-{letters}", dir.display());
            v.wait_until(&sel, |v| crate::common::gitui::bounds(v, &sel).is_some());
        }
        for (dir, title) in [
            (&main, mine.clone()),
            (&wt, format!("{mine} › 2-cart-total")),
        ] {
            let to = dir.clone();
            v.cx.update(move |window, cx| vimstorm::shell::projects::switch_to(to, window, cx));
            v.wait_until("shown", |v| {
                let ws = v.active_project();
                ws.read_with(&v.cx, |ws, _| ws.project() == dir)
            });
            let ws = v.active_project();
            v.use_project(&ws);
            v.wait_lua(
                &title,
                &format!("return vim.o.titlestring:find('{title}', 1, true) == 1"),
            );
        }
    }

    pub(super) fn a_box_workspace_says_its_story_and_its_box_never_its_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        // the box's clone on its story branch, behind the attach's wrapper (`remote_workspace.rs`)
        let real = base.join("clone");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("cart.ts"), "export const total = 1;\n").unwrap();
        git(
            &real,
            &["init", "-q", "-b", "card/1-show-stock-on-a-product-card"],
        );
        git(&real, &["add", "."]);
        git(
            &real,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "one",
            ],
        );
        let root = base.join("box/workspace/repo");
        let wrap = wrapper(&base, &root, &real).display().to_string();
        let logged = |n: &str| base.join(n).display().to_string();
        let open = attach_frame(
            &base,
            "open.json",
            &root,
            vec![
                wrap.clone(),
                logged("nvim.log"),
                "nvim".into(),
                "--embed".into(),
            ],
            vec![wrap.clone(), logged("shell.log"), "/bin/sh".into()],
            vec![wrap, logged("exec.log")],
        );
        let feed = feed(&base, &base.join("nowhere"), "shop-4");
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        let mut command = fake(
            &base,
            &["frames/bridge-tree.json", feed.to_str().unwrap()],
            None,
        );
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!("\"key\":\"w\"={}", open.display()),
        ));
        v.cx.update(|_, cx| cx.set_global(command));
        v.key("super+alt+a");
        v.wait_until("the Factory view", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        v.key("g");
        v.key("w");
        v.wait_until("the box's workspace shown", |v| {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.project() == &root)
        });
        // never shown, its run needing you: it lands on Run; ⌃1 its code
        v.key("ctrl+digit_1");
        v.wait_until("its code", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown())
        });
        let ws = v.active_project();
        v.use_project(&ws);
        v.wait_until("attached", |v| {
            v.read_ws(|ws, _| ws.remote().is_some_and(|r| r.attached()))
        });

        // its tab: ◆ (it needs you), its story, the box's cloud filled in the accent; never `repo`
        v.wait_until("#1's tab", |v| {
            tabs(v)
                .iter()
                .any(|t| t.name == "#1 show stock on a product card")
        });
        let all = tabs(&mut v);
        assert!(all.iter().all(|t| t.name != "repo"), "{all:?}");
        let ix = all
            .iter()
            .position(|t| t.name == "#1 show stock on a product card")
            .unwrap();
        assert_eq!(all[ix].state, Some(WorkspaceState::NeedsYou));
        assert_eq!(
            all[ix].cloud,
            Some((CloudState::Running, Some(Hue::Accent)))
        );
        assert_eq!(all[ix].dot, Some((s("◆"), Hue::NeedsYou)));
        // its tile on the rail draws the cloud
        let key = projects
            .read_with(&v.cx, |p, _| {
                p.rail_drawn()
                    .iter()
                    .filter_map(|t| match t {
                        vimstorm::shell::projects::Tile::Workspace(r) => {
                            Some(r.display().to_string())
                        }
                        _ => None,
                    })
                    .nth(ix)
            })
            .unwrap();
        assert!(crate::common::gitui::bounds(&mut v, &format!("rail-cloud-{key}")).is_some());
        // the line: the story, its state, the box (accent, its cloud), no pull request
        assert_eq!(
            badges(&line(&mut v)),
            [
                (s("#1 show stock…"), Hue::Accent),
                (s("Spec ◆ Needs you 8 min"), Hue::NeedsYou),
                (s("shop-4"), Hue::Accent),
                (s("PR —"), Hue::Dim),
            ]
        );
        // the tree's root: the story bold, `…/workspace/repo` dim
        let tree = v.read_ws(|ws, _| ws.tree().clone());
        let label = tree.read_with(&v.cx, |t, _| t.row_label(0)).unwrap();
        assert_eq!(label[0], (s("show stock on a product card"), true));
        assert!(label[1].0.ends_with("/workspace/repo"), "{label:?}");
        // the status bar: the story crumb, the box's name (never `your environment`), the branch
        v.wait_until("the box and the branch", |v| {
            let d = v.read_ws(|ws, cx| ws.statusbar().read(cx).drawn().clone());
            d.crumbs
                .first()
                .is_some_and(|c| c == "#1 show stock on a product card")
                && d.right
                    .ends_with(&[s("shop-4"), s("card/1-show-stock-on-a-product-card")])
        });
    }
}

/// The Boxes tile (the Factory view's pane filling the middle): Enter's `terminal-tab` opens the
/// attach in the workspace's Terminal (Code's bottom panel), and the status bar's boxes widget, whose click's `show`
/// is the Boxes tile.
mod boxes {
    use std::path::{Path, PathBuf};

    use serde_json::{Value, json};
    use vimstorm::factory::SlotView;
    use vimstorm::shell::PaneTab;
    use vimstorm::shell::projects::{Page, Tile};

    use crate::common::bridge::{fake_on, fixture, log};
    use crate::common::gitfix::git;
    use crate::common::view::View;

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

    /// `tree {slot: pane}` of the contract's `rel` as the `boxes` screen's, written into `dir`.
    fn boxes_frame(dir: &Path, rel: &str) -> PathBuf {
        let tree: Value =
            serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap();
        let path = dir.join("boxes-tree.json");
        std::fs::write(
            &path,
            json!({"v": 2, "type": "tree", "screen": "boxes", "rev": 1, "tree": tree, "slot": "pane"})
                .to_string(),
        )
        .unwrap();
        path
    }

    /// The window on `demo-shop`; the fake bridge answers `boxes` opened in the pane with X-Boxes'
    /// problems fixture, and ⏎ there with the `terminal-tab` effect on demo-shop-1.
    fn start(base: &Path) -> View {
        let dir = repo(base);
        let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
        let boxes = boxes_frame(base, "trees/boxes-problems.json");
        let command = fake_on(
            base,
            &["frames/bridge-tree.json"],
            &[
                (r#""type":"open","v":2,"screen":"boxes""#, vec![boxes]),
                (
                    r#""key":"<CR>"},"slot":"pane""#,
                    vec![fixture("frames/bridge-shell-terminal-tab.json")],
                ),
            ],
        );
        v.cx.update(|_, cx| cx.set_global(command));
        v
    }

    /// The Boxes tile shown: the Factory view's pane on Boxes.
    fn on_boxes(v: &mut View) -> bool {
        v.pump();
        let projects = v.projects.clone().unwrap();
        projects.read_with(&v.cx, |p, cx| {
            p.tile_now(cx) == Tile::Boxes
                && p.factory_pane_view().map(|f| f.read(cx).tab()) == Some(Some(PaneTab::Boxes))
        })
    }

    /// The Boxes tile (clicked), its Chat hidden (⌘⌥2): the list has the keys.
    fn to_boxes(v: &mut View) {
        v.click_place("boxes");
        v.wait_until("the Boxes tile", on_boxes);
        v.key("super+alt+digit_2");
        let projects = v.projects.clone().unwrap();
        v.wait_until("the list has the keys", |v| {
            v.pump();
            let pane = projects.read_with(&v.cx, |p, _| p.factory_pane_view().cloned());
            v.cx.update(|window, cx| pane.is_some_and(|p| p.read(cx).has_keyboard(window, cx)))
        });
    }

    fn opened(base: &Path, screen: &str) -> bool {
        log(base).iter().any(|l| {
            l.contains(r#""type":"open""#)
                && l.contains(&format!(r#""screen":"{screen}""#))
                && l.contains(r#""slot":"pane""#)
        })
    }

    fn slot(v: &mut View) -> gpui_kit::Entity<SlotView> {
        v.pump();
        let projects = v.projects.clone().unwrap();
        projects
            .read_with(&v.cx, |p, cx| {
                p.factory_pane_view()
                    .and_then(|f| f.read(cx).content().slot.clone())
            })
            .expect("the pane slot's view")
    }

    fn drawn(v: &mut View, slot: &gpui_kit::Entity<SlotView>, kind: &str) -> Vec<String> {
        v.pump();
        slot.read_with(&v.cx, |s, _| {
            s.drawn()
                .texts(kind)
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
    }

    const ROWS: [&str; 5] = [
        "demo-shop-2 | — | ● starting · 6 min | m8g.large | — | v11 | 6 min | $0.01 today | —",
        "demo-shop-4 | — | ● running · serve not answering · 1 h 12 min | m8g.large | — | v11 | 1 h 12 min | $0.12 today | —",
        "demo-shop-1 | — | ● running | m8g.large | — | v11 | 1 h 12 min | $0.12 today | stops at 10:30",
        "demo-shop-5 | #5 show delivery dates | Queued | — | — | — | — | — | —",
        "demo-shop-3 | — | ○ asleep | m8g.large | — | v11 | — | $0.84 today | —",
    ];

    /// The attach's tab in the shown workspace's Terminal, Code's panel on it, the fake
    /// `abe` (the bridge's own program) started with `box attach demo-shop-1`.
    fn attached(v: &mut View, base: &Path) -> bool {
        v.pump();
        let (tabs, shown) = v.read_ws(|ws, cx| {
            let t = ws.terminal().read(cx);
            (t.tab_names(), t.shown())
        });
        let projects = v.projects.clone().unwrap();
        let page = projects.read_with(&v.cx, |p, cx| p.page_now(cx));
        tabs.iter().any(|t| t == "demo-shop-1")
            && shown
            && page == Page::Code
            && log(base)
                .iter()
                .any(|l| l == "start box attach demo-shop-1")
    }

    pub(super) fn enter_on_a_box_in_the_pane_opens_its_attach_in_the_terminal() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let mut v = start(&base);

        // the Boxes tile, the list with the keyboard, `boxes` opened in the pane slot
        to_boxes(&mut v);
        v.wait_until("boxes opened in the pane slot", |_| opened(&base, "boxes"));
        let slot = slot(&mut v);
        v.wait_until("its Table drawn", |v| {
            !drawn(v, &slot, "TableRow").is_empty()
        });
        assert_eq!(
            drawn(&mut v, &slot, "TableHead"),
            [
                "Box", "Story", "State", "Size", "Disk", "Release", "Up", "Cost", "Until"
            ]
        );
        assert_eq!(drawn(&mut v, &slot, "TableRow"), ROWS);
        assert_eq!(drawn(&mut v, &slot, "TableRowHue"), ["bad", "bad"]);
        assert_eq!(
            drawn(&mut v, &slot, "TableFoot"),
            ["⏎ box shell", "⌘⏎ actions", "r read again"]
        );

        // ⏎ goes to the screen as `input {slot: pane}`; its `terminal-tab` opens the attach on the
        // workspace's Terminal (Code's bottom panel)
        v.key("enter");
        v.wait_until("the attach's tab in Terminal mode", |v| attached(v, &base));
        v.wait_until("the terminal has the keyboard", |v| {
            v.pump();
            v.read_ws(|ws, _| ws.native_focus() == Some("terminal"))
        });
    }

    /// ADR 0022: a repo's box with its workspaces under it, each its story, state and disk; ⏎'s
    /// answer (`abe box attach demo-shop --card 101`) runs in Terminal mode. Which row's card ⏎
    /// picks is abe's (ui boxes.test.ts); the fake answers any ⏎ with that frame.
    pub(super) fn a_repo_box_draws_its_workspaces_under_it_and_enter_on_one_attaches_to_its_card() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let dir = repo(&base);
        let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
        let boxes = boxes_frame(&base, "trees/boxes-workspaces.json");
        let command = fake_on(
            &base,
            &["frames/bridge-tree.json"],
            &[
                (r#""type":"open","v":2,"screen":"boxes""#, vec![boxes]),
                (
                    r#""key":"<CR>"},"slot":"pane""#,
                    vec![fixture("frames/bridge-shell-terminal-tab-card.json")],
                ),
            ],
        );
        v.cx.update(|_, cx| cx.set_global(command));
        to_boxes(&mut v);
        v.wait_until("boxes opened in the pane slot", |_| opened(&base, "boxes"));
        let slot = slot(&mut v);
        v.wait_until("its Table drawn", |v| {
            !drawn(v, &slot, "TableRow").is_empty()
        });
        assert_eq!(
            drawn(&mut v, &slot, "TableRow"),
            [
                "demo-shop | 2 workspaces | ● running | m8g.large | 31 / 60 GB | v11 | 1 h 12 min | $0.12 today | stops at 10:30",
                " | #101 show stock on cards | ● workspace up | — | 4.1 GB | — | — | — | —",
                " | #102 cart total | ○ workspace stopped | — | 3.8 GB | — | — | — | —",
                "demo-shop-9 | #9 saved carts | ⚠ old box · asleep | m8g.large | — | v11 | — | — | —",
            ]
        );
        v.key("enter");
        v.wait_until("the card's attach in Terminal mode", |v| {
            v.pump();
            let tabs = v.read_ws(|ws, cx| ws.terminal().read(cx).tab_names());
            tabs.iter().any(|t| t == "demo-shop #101")
                && log(&base)
                    .iter()
                    .any(|l| l == "start box attach demo-shop --card 101")
        });
    }

    pub(super) fn enter_on_a_box_from_the_factory_view_shows_the_editor_with_the_attach() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let mut v = start(&base);
        let projects = v.projects.clone().unwrap();

        to_boxes(&mut v);
        v.wait_until("boxes opened in the pane slot", |_| opened(&base, "boxes"));
        v.key("enter");
        v.wait_until("the Editor with the attach's tab", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown()) && attached(v, &base)
        });
    }

    /// The bridge's `show {place: boxes}` (what a click on the boxes widget answers).
    fn show_boxes(dir: &Path) -> PathBuf {
        let path = dir.join("show-boxes.json");
        std::fs::write(
            &path,
            json!({"v": 2, "type": "shell", "effect": {"kind": "show", "place": "boxes"}})
                .to_string(),
        )
        .unwrap();
        path
    }

    /// The boxes widget as the status bar shows it now.
    fn boxes_widget(v: &mut View) -> Option<vimstorm::factory::Widget> {
        v.pump();
        v.cx.update(|_, cx| {
            vimstorm::factory::shown_widgets(cx, vimstorm::factory::WidgetPlace::End)
                .into_iter()
                .find(|w| w.id == "boxes")
        })
    }

    pub(super) fn the_status_bars_boxes_widget_is_red_with_why_on_both_views_and_a_click_shows_the_boxes_tab()
     {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let dir = repo(&base);
        let mut v = View::start_projects(dir.to_str().unwrap(), &["a.ts"]);
        let command = fake_on(
            &base,
            &[
                "frames/bridge-tree.json",
                "frames/bridge-shell-widgets-boxes.json",
            ],
            &[(r#""id":"widget:boxes""#, vec![show_boxes(&base)])],
        );
        v.cx.update(|_, cx| cx.set_global(command));
        let projects = v.projects.clone().unwrap();
        v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));

        // the Editor: at the status bar's right, red, the stuck box named on hover
        v.wait_until("☁ 3 boxes on the Editor", |v| {
            v.cx.debug_bounds("factory-widget-boxes").is_some()
        });
        let w = boxes_widget(&mut v).unwrap();
        assert_eq!(w.text, "3 boxes · 1 running");
        // the cloud before the words, red with them
        assert_eq!(w.cloud, Some(vimstorm::factory::CloudState::Running));
        assert!(v.cx.debug_bounds("factory-widget-cloud-Running").is_some());
        assert_eq!(w.hue, Some(vimstorm::factory::Hue::Bad));
        assert_eq!(w.tooltip.as_deref(), Some("demo-shop-2 starting · 6 min"));
        let width = v.cx.update(|window, _| window.viewport_size().width);
        let at = v.cx.debug_bounds("factory-widget-boxes").unwrap();
        assert!(at.left() > width / 2., "{at:?} at the status bar's right");

        // the Factory view too
        v.key("super+alt+a");
        v.wait_until("the Factory view with ☁ 3 boxes", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
                && v.cx.debug_bounds("factory-widget-boxes").is_some()
        });
        v.key("super+alt+a");
        v.wait_until("the Editor back", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown())
        });

        // a click: `widget:boxes` to the bridge, its `show` the Boxes tile (as Linked's Box row)
        let at = v.cx.debug_bounds("factory-widget-boxes").unwrap().center();
        v.click(gpui_kit::MouseButton::Left, at);
        v.wait_until("the click reached the bridge", |_| {
            log(&base)
                .iter()
                .any(|l| l.contains(r#""kind":"click","id":"widget:boxes""#))
        });
        v.wait_until("the Boxes tile", on_boxes);
    }
}

/// Error balloons: they fade, go with their cause (`drop-balloon`), stay when they need you, and
/// every one is kept in the status bar's history.
mod errors {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use gpui_kit::MouseButton;
    use serde_json::json;

    use crate::common::bridge::{fake_on, log};
    use crate::common::view::View;

    /// A bridge `shell` frame's line.
    fn shell(effect: serde_json::Value) -> String {
        json!({ "v": 2, "type": "shell", "effect": effect }).to_string()
    }

    fn error(text: &str, key: &str, extra: serde_json::Value) -> String {
        let mut effect = json!({
            "kind": "balloon", "tone": "error", "text": text, "key": key, "where": "factory",
        });
        if let (Some(e), Some(more)) = (effect.as_object_mut(), extra.as_object()) {
            e.extend(more.clone());
        }
        shell(effect)
    }

    fn file(dir: &Path, name: &str, line: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, line).unwrap();
        path
    }

    /// The shown project's balloons' texts, oldest first.
    fn balloons(v: &mut View) -> Vec<String> {
        let popups = v
            .active_project()
            .read_with(&v.cx, |ws, _| ws.popups().clone());
        popups.read_with(&v.cx, |p, _| {
            p.balloons().into_iter().map(|(_, body)| body).collect()
        })
    }

    fn bounds(v: &mut View, selector: &str) -> Option<gpui_kit::Bounds<gpui_kit::Pixels>> {
        v.cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
    }

    pub(super) fn errors_fade_go_with_their_cause_stay_when_they_need_you_and_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = View::start_projects("proj", &["a.txt"]);
        let projects = v.projects.clone().unwrap();
        // a click on `widget:gone` answered with the cause gone: `drop-balloon` of run:c
        let gone = file(
            dir.path(),
            "gone.json",
            &shell(json!({ "kind": "drop-balloon", "key": "run:c" })),
        );
        let done = file(
            dir.path(),
            "done.json",
            &shell(json!({ "kind": "drop-balloon", "key": "run:b" })),
        );
        let command = fake_on(
            dir.path(),
            &["frames/bridge-tree.json"],
            &[
                ("widget:gone", vec![gone]),
                ("widget:logged-in", vec![done]),
            ],
        );
        v.cx.update(|_, cx| cx.set_global(command));
        v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
        v.wait_until("the bridge started, its screen opened", |_| {
            log(dir.path())
                .iter()
                .any(|l| l.contains(r#""type":"open""#))
        });
        let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
        let say = |v: &mut View, line: String| {
            factory.update(&mut v.cx, |f, cx| f.receive_line(&line, cx));
            v.pump();
        };

        // one that fades, one that needs you (its action), one whose cause will go
        say(
            &mut v,
            error("the card did not move (move-failed)", "run:a", json!({})),
        );
        say(
            &mut v,
            error(
                "no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)",
                "run:b",
                json!({ "stays": true, "action": "Log in…" }),
            ),
        );
        say(&mut v, error("Board not read (failed)", "run:c", json!({})));
        v.wait_until("three balloons", |v| balloons(v).len() == 3);
        assert!(
            bounds(&mut v, "balloon-action-abe:run:b").is_some(),
            "Log in… under its text"
        );

        // the key that came with them takes nothing; a key once they were up a second takes the
        // ones that fade, never the one that needs you
        v.key("ö");
        v.pump();
        assert_eq!(balloons(&mut v).len(), 3);
        v.advance(Duration::from_millis(1100));
        v.key("l");
        v.wait_until("the ones that fade went", |v| {
            balloons(v) == ["no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)"]
        });

        // its cause gone: the bridge's drop-balloon closes it with no click
        say(&mut v, error("Board not read (failed)", "run:c", json!({})));
        v.wait_until("said again", |v| balloons(v).len() == 2);
        click_widget(&mut v, "gone");
        v.wait_until("dropped by the bridge", |v| {
            balloons(v) == ["no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)"]
        });

        // with no key it fades after its reading time; the one that needs you stays
        say(
            &mut v,
            error("Sheet: it could not load (failed)", "said:sheet", json!({})),
        );
        v.wait_until("said", |v| balloons(v).len() == 2);
        v.advance(Duration::from_secs(11));
        v.wait_until("faded", |v| {
            balloons(v) == ["no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)"]
        });

        // its action: the bridge's click; it stays until its cause is gone (the run again answered
        // ok once logged in: the bridge's drop-balloon, which the fake says on `widget:logged-in`)
        let link = bounds(&mut v, "balloon-action-abe:run:b").expect("its link");
        v.click(MouseButton::Left, link.center());
        v.wait_until("Log in… went to the bridge", |_| {
            log(dir.path())
                .iter()
                .any(|l| l.contains(r#""id":"balloon:run:b""#))
        });
        v.pump();
        assert_eq!(balloons(&mut v).len(), 1, "it stays until done");
        click_widget(&mut v, "logged-in");
        v.wait_until("logged in: dropped", |v| balloons(v).is_empty());

        // nothing is lost: ⚠ N on the status bar, its list newest first with when and where
        let widget = bounds(&mut v, "status-errors").expect("⚠ N on the status bar");
        v.click(MouseButton::Left, widget.center());
        let popups = v
            .active_project()
            .read_with(&v.cx, |ws, _| ws.popups().clone());
        v.wait_until("the history's list", |v| {
            popups.read_with(&v.cx, |p, _| p.menu_rows()).is_some()
        });
        let rows = popups.read_with(&v.cx, |p, _| p.menu_rows()).unwrap();
        assert_eq!(
            rows.first().map(String::as_str),
            Some("Sheet: it could not load (failed)"),
            "{rows:?}"
        );
        assert!(
            rows.iter().any(|r| r == "Board not read (failed) ×2"),
            "{rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r == "no Azure DevOps token from az (az exited 1): run `az login --allow-no-subscriptions` and retry (auth)"),
            "{rows:?}"
        );
        let item = popups
            .read_with(&v.cx, |p, _| {
                p.menu_item("the card did not move (move-failed)")
            })
            .unwrap();
        assert!(
            item.shortcut
                .as_deref()
                .is_some_and(|s| s.ends_with(" · Abe · factory")),
            "{:?}",
            item.shortcut
        );
        v.key("escape");
    }

    /// A click on the bridge's status bar widget `id` (as the bar's own do).
    fn click_widget(v: &mut View, id: &str) {
        let id = format!("widget:{id}");
        v.cx.update(|window, cx| vimstorm::shell::projects::factory_click(id, window, cx));
        v.pump();
    }
}

/// The `widgets` frame on the Editor's status bar, and the `view` frame a click on one answers.
mod needs_you {
    use std::path::{Path, PathBuf};

    use gpui_kit::{Focusable as _, MouseButton};
    use serde_json::{Value, json};
    use vimstorm::factory::FIRST_SCREEN;

    use crate::common::bridge::{fake, fixture, log};
    use crate::common::view::View;

    /// The widgets frame of the contract: `Factory ◆ 1` for the Editor, the Factory view's own.
    fn widgets_line() -> String {
        let doc: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("frames/bridge-shell-widgets.json")).unwrap(),
        )
        .unwrap();
        doc.to_string()
    }

    /// A program that stays up in the landed Chat's terminal.
    fn sleeper(dir: &Path) -> String {
        let path = dir.join("sleeper.sh");
        std::fs::write(&path, "#!/bin/sh\necho waiting on you\nexec sleep 600\n").unwrap();
        std::process::Command::new("chmod")
            .args(["+x", path.to_str().unwrap()])
            .status()
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The tree the screen gives once landed: Chat on the waiting session, its terminal focused.
    fn landed_tree(dir: &Path) -> PathBuf {
        let tree = json!({
            "v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": 1,
            "tree": { "kind": "Island", "id": "chat", "props": {}, "children": [{
                "kind": "Terminal",
                "id": "chat-terminal",
                "props": {
                    "key": "chat:s1234:0",
                    "argv": [sleeper(dir)],
                    "focused": true,
                    "screenKeys": ["<Esc>"],
                },
            }]},
        });
        let path = dir.join("landed.json");
        std::fs::write(&path, tree.to_string()).unwrap();
        path
    }

    /// The bridge's `view: factory` effect (what a click on the widget answers).
    fn view_factory(dir: &Path) -> PathBuf {
        let path = dir.join("view-factory.json");
        std::fs::write(
            &path,
            json!({"v": 2, "type": "shell", "effect": {"kind": "view", "view": "factory"}})
                .to_string(),
        )
        .unwrap();
        path
    }

    fn caret(v: &View) -> String {
        format!("{:?}", v.lua("return vim.api.nvim_win_get_cursor(0)"))
    }

    /// The landed Chat's terminal has the keyboard.
    fn chat_has_keys(v: &mut View) -> bool {
        let projects = v.projects.clone().unwrap();
        v.cx.update(|window, cx| {
            projects.read(cx).factory().is_some_and(|f| {
                f.read(cx)
                    .terminal("chat:s1234:0")
                    .is_some_and(|t| t.read(cx).focus_handle().is_focused(window))
            })
        })
    }

    /// nvim's editor has the keyboard.
    fn editor_has_keys(v: &mut View) -> bool {
        let ws = v.active_project();
        v.cx.update(|window, cx| ws.read(cx).editor().focus_handle(cx).is_focused(window))
    }

    pub(super) fn the_widgets_frame_shows_on_the_editor_quietly_and_cmd_alt_a_lands_in_chat_and_back()
     {
        let dir = tempfile::tempdir().unwrap();
        let mut v = View::start_projects("proj", &["a.txt"]);
        v.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two', 'three' }) return true");
        v.key("ö");
        v.key("ä");
        let projects = v.projects.clone().unwrap();
        let landed = landed_tree(dir.path());
        let mut command = fake(dir.path(), &["frames/bridge-tree.json"], None);
        // `from: editor` answered with the landed tree; a click on the widget with `view: factory`
        command.env.push((
            "FAKE_BRIDGE_ON".into(),
            format!(
                "\"from\":\"editor\"={}\nwidget:factory={}",
                landed.display(),
                view_factory(dir.path()).display()
            ),
        ));
        v.cx.update(|_, cx| cx.set_global(command));
        // the launch's start: the bridge follows while the Editor stays shown
        v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
        v.wait_until("the bridge started, its screen opened", |_| {
            log(dir.path())
                .iter()
                .any(|l| l.contains(r#""type":"open""#))
        });
        assert!(!projects.read_with(&v.cx, |p, _| p.factory_shown()));

        // typing in insert mode when a session asks
        v.key("i");
        v.wait_until("insert mode", |v| v.mode() == "i");
        let at = caret(&v);
        let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
        let line = widgets_line();
        factory.update(&mut v.cx, |f, cx| f.receive_line(&line, cx));
        v.wait_until("Factory ◆ 1 on the Editor's status bar", |v| {
            v.cx.debug_bounds("factory-widget-factory").is_some()
        });
        // only the Editor's: the Factory view's own widgets wait for it
        assert!(v.cx.debug_bounds("factory-widget-needs-you").is_none());
        assert!(v.cx.debug_bounds("factory-widget-running").is_none());
        // beside the mode badge, at the status bar's left
        let widget = v.cx.debug_bounds("factory-widget-factory").unwrap();
        let bar = v.cx.debug_bounds("status-bar").unwrap();
        assert!(
            widget.left() < bar.left() + bar.size.width / 4.,
            "{widget:?} in {bar:?}"
        );
        // nothing else changed: no balloon, the keys, the caret and the mode where they were
        let popups = v.read_ws(|ws, _| ws.popups().clone());
        assert!(popups.read_with(&v.cx, |p, _| p.balloons()).is_empty());
        assert!(editor_has_keys(&mut v));
        assert!(!projects.read_with(&v.cx, |p, _| p.factory_shown()));
        assert_eq!(v.mode(), "i");
        assert_eq!(caret(&v), at);

        // ⌘⌥A: the Board (a rail move), the keys in Chat's composer
        v.key("super+alt+a");
        v.wait_until("the Board with Chat's keys", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown())
                && crate::common::chat::column_active(v)
        });
        // the Factory view's widgets now, not the Editor's
        v.wait_until("◆ 1 needs you on the Factory view", |v| {
            v.cx.debug_bounds("factory-widget-needs-you").is_some()
                && v.cx.debug_bounds("factory-widget-factory").is_none()
        });

        // ⌘⌥A again: the Editor, caret and mode as they were
        v.key("super+alt+a");
        v.wait_until("the Editor back with the keys", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown()) && editor_has_keys(v)
        });
        assert_eq!(caret(&v), at);
        assert_eq!(v.mode(), "i");

        // a click on Factory ◆ 1 asks the bridge, whose `view: factory` lands the same way
        let before = log(dir.path()).len();
        let at_widget =
            v.cx.debug_bounds("factory-widget-factory")
                .unwrap()
                .center();
        v.click(MouseButton::Left, at_widget);
        v.wait_until("the click reached the bridge", |_| {
            log(dir.path())[before..].iter().any(|l| {
                l == r#"{"type":"input","v":2,"input":{"kind":"click","id":"widget:factory"}}"#
            })
        });
        v.wait_until("shown from the click, the Chat with the keys", |v| {
            projects.read_with(&v.cx, |p, _| p.factory_shown()) && chat_has_keys(v)
        });
        // its screen opened again from the Editor: it lands
        assert!(
            log(dir.path())
                .iter()
                .any(|l| l
                    == r#"{"type":"open","v":2,"screen":"factory","params":{"from":"editor"}}"#),
            "{:?}",
            log(dir.path())
        );
        v.key("super+alt+a");
        v.wait_until("the Editor back", |v| {
            !projects.read_with(&v.cx, |p, _| p.factory_shown()) && editor_has_keys(v)
        });
        assert_eq!(caret(&v), at);
        assert_eq!(v.mode(), "i");
    }
}

/// The `editor-item` frame Command mode runs in the Editor.
mod editor_item {
    use crate::common::bridge::{fake_on, fixture, layer_frame, log};
    use crate::common::view::View;

    /// A caret menu item chosen in `:`: the bridge's `editor-item` runs it in Lua, in the Editor.
    pub(super) fn a_caret_menu_item_chosen_in_command_mode_runs_in_the_editor() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let mut v = View::start_projects("proj", &["a.txt"]);
        v.lua(
            "require('config.menu').provider(10000, function() \
             return { { 'Probe', function() vim.g.colon_probe = 1 end } } end) return true",
        );
        let item = d.join("shell-item.json");
        std::fs::write(
            &item,
            serde_json::json!({"v": 2, "type": "shell", "effect": {"kind": "editor-item", "index": 0}})
                .to_string(),
        )
        .unwrap();
        let command = fake_on(
            d,
            &[],
            &[
                (r#""key":":""#, vec![fixture("frames/bridge-layer.json")]),
                (r#""key":"<CR>""#, vec![layer_frame(d, None, 10), item]),
            ],
        );
        v.cx.update(|_, cx| cx.set_global(command));
        v.keystrokes(": enter");
        v.wait_until("the item ran", |v| {
            v.lua("return vim.g.colon_probe") == rmpv::Value::from(1)
        });
        assert!(
            log(d)
                .iter()
                .any(|l| l.contains(r#""items":[{"text":"Probe"}]"#)),
            "{:?}",
            log(d)
        );
    }
}
