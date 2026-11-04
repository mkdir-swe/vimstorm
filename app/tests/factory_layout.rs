//! The Factory view's layout: one row per component and window size, checking what Rust owns of
//! it (sizes, where each part sits, where a text is cut and what then shows it whole). The words
//! are the contract trees' (`contract.rs` draws every one).
// GPUI records debug selectors only with debug assertions.
#![cfg(debug_assertions)]

use gpui_kit::{Bounds, Focusable as _, Modifiers, Pixels, px};
use serde_json::{Value, json};
use vimstorm::factory::FIRST_SCREEN;

use crate::common::bridge::{Win, fixture};

type B = Bounds<Pixels>;

/// What a row draws before its check.
enum Draw {
    /// A tree on file, as the screen.
    Tree(&'static str),
    /// A tree on file, as the layer.
    Layer(&'static str),
    /// A tree on file changed by the fn, as the screen.
    TreeWith(&'static str, fn(&mut Value)),
    /// A tree on file changed by the fn, as the layer.
    LayerWith(&'static str, fn(&mut Value)),
    /// Nothing: the check draws its own.
    Own,
}

struct Row {
    name: &'static str,
    /// The window's width and height.
    size: (f32, f32),
    draw: Draw,
    check: fn(&mut Win),
}

const ROWS: &[Row] = &[
    Row {
        name: "run page: the steps 240 px left of the focus pane, the step's actions in it",
        size: (1440., 900.),
        draw: Draw::Tree("trees/run-ready.json"),
        check: run_page,
    },
    Row {
        name: "run page: a step waiting on you asks in the focus pane",
        size: (1440., 900.),
        draw: Draw::Tree("trees/run-needs-you.json"),
        check: run_ask,
    },
    Row {
        name: "run page: Verify's kit in what it made, its criteria in what it read",
        size: (1440., 900.),
        draw: Draw::Tree("trees/run-verify.json"),
        check: run_verify_report,
    },
    Row {
        name: "run page: a kit shot is its column's width, its own shape",
        size: (1440., 900.),
        draw: Draw::TreeWith("trees/run-verify.json", real_shot),
        check: run_shot_shape,
    },
    Row {
        name: "run page: a long criterion in the focus pane wraps whole",
        size: (1440., 900.),
        draw: Draw::TreeWith("trees/run-verify.json", long_criterion),
        check: run_criterion_whole,
    },
    Row {
        name: "run page: its scroll keys move the step shown, its step keys don't",
        size: (1440., 900.),
        draw: Draw::TreeWith("trees/run-verify.json", long_log),
        check: run_key_scroll,
    },
    Row {
        name: "run page: a long step list scrolls, never squeezing the focus pane",
        size: (1440., 900.),
        draw: Draw::TreeWith("trees/run-live.json", long_steps),
        check: run_steps_scroll,
    },
    Row {
        name: "run page: a pane under 760 px stacks what it read over what it made",
        size: (980., 900.),
        draw: Draw::Tree("trees/run-live.json"),
        check: run_stacked,
    },
    Row {
        name: "run page: tickets by wave, side by side, the open one with its rows",
        size: (1440., 900.),
        draw: Draw::Tree("trees/run-tickets.json"),
        check: run_tickets,
    },
    Row {
        name: "status screen at 1000",
        size: (1000., 700.),
        draw: Draw::Tree("trees/status-sessions.json"),
        check: status_screen,
    },
    Row {
        name: "gallery at 1000",
        size: (1000., 700.),
        draw: Draw::Tree("trees/gallery.json"),
        check: gallery,
    },
    Row {
        name: "pick at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-pick.json"),
        check: pick,
    },
    Row {
        name: "confirm at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-confirm.json"),
        check: confirm,
    },
    Row {
        name: "action menu at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-menu.json"),
        check: action_menu,
    },
    Row {
        name: "launch box at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-launch.json"),
        check: launch_box,
    },
    Row {
        name: "launch box, another workflow picked, prod on, at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-launch-picked.json"),
        check: launch_box_picked,
    },
    Row {
        name: "launch box past its count at 1000",
        size: (1000., 700.),
        draw: Draw::LayerWith("trees/command-launch.json", launch_over),
        check: launch_box_over,
    },
    Row {
        name: "prompt caret at 1000",
        size: (1000., 700.),
        draw: Draw::Own,
        check: prompt_caret,
    },
    Row {
        name: "pick filter caret at 1000",
        size: (1000., 700.),
        draw: Draw::Own,
        check: pick_caret,
    },
    Row {
        name: "comment box caret at 1000",
        size: (1000., 700.),
        draw: Draw::Own,
        check: comment_caret,
    },
    Row {
        name: "comment box at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-comment.json"),
        check: comment_box,
    },
    Row {
        name: "linked at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/linked.json"),
        check: linked,
    },
    Row {
        name: "linked at 1000: a long state wraps whole in its row",
        size: (1000., 700.),
        draw: Draw::LayerWith("trees/linked.json", long_linked_state),
        check: linked_long_state,
    },
    Row {
        name: "card dialog at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/command-dialog.json"),
        check: card_dialog,
    },
    Row {
        name: "card dialog: the button the keys are on is the default",
        size: (1000., 700.),
        draw: Draw::LayerWith("trees/command-dialog.json", menu_button_focused),
        check: dialog_button_focus,
    },
    Row {
        name: "new card dialog refused at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/dialog-new-card-refused.json"),
        check: new_card_refused,
    },
    Row {
        name: "long story at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/story-running.json"),
        check: long_story,
    },
    Row {
        name: "short story at 1000",
        size: (1000., 700.),
        draw: Draw::Layer("trees/story-teammate.json"),
        check: short_story,
    },
    Row {
        name: "story comments and an image at 1000",
        size: (1000., 700.),
        draw: Draw::Own,
        check: story_comments,
    },
    Row {
        name: "card page at 1000: the main slot's whole page, its composer over the actions",
        size: (1000., 700.),
        draw: Draw::Tree("trees/card-page.json"),
        check: card_page,
    },
    Row {
        name: "card popup at 1440: the Board's card page over the Board, centred, smaller than it",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: card_popup,
    },
    Row {
        name: "card page: the keys on an action, the composer without its caret",
        size: (1000., 700.),
        draw: Draw::Tree("trees/card-page-actions.json"),
        check: card_page_actions,
    },
    Row {
        name: "board at 1440",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: board_1440,
    },
    Row {
        name: "board at 1100",
        size: (1100., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: board_1100,
    },
    Row {
        name: "board at 1000",
        size: (1000., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: board_1000,
    },
    Row {
        name: "board at 800",
        size: (800., 846.),
        draw: Draw::Tree("trees/factory-800.json"),
        check: board_800,
    },
    Row {
        name: "board at 600",
        size: (600., 846.),
        draw: Draw::Tree("trees/factory-narrow.json"),
        check: board_600,
    },
    Row {
        name: "board at 430",
        size: (430., 846.),
        draw: Draw::Tree("trees/factory-tightest.json"),
        check: board_430,
    },
    Row {
        name: "board with a filter at 400",
        size: (400., 846.),
        draw: Draw::Tree("trees/factory-tightest-filter.json"),
        check: board_filter_400,
    },
    Row {
        name: "board card with no run at 1440",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-boxes.json"),
        check: board_card_no_run,
    },
    Row {
        name: "board selected card's edge at 1440",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: board_selected_edge,
    },
    Row {
        name: "board card tooltips at 1440",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-overview.json"),
        check: board_card_tooltips,
    },
    Row {
        name: "board card title past two lines at 1440",
        size: (1440., 846.),
        draw: Draw::TreeWith("trees/factory-overview.json", long_card_title),
        check: board_long_title_tooltip,
    },
    Row {
        name: "board state word cut at 600",
        size: (600., 846.),
        draw: Draw::TreeWith("trees/factory-narrow.json", long_state_word),
        check: board_state_word_cut,
    },
    Row {
        name: "board note cut at 800",
        size: (800., 846.),
        draw: Draw::TreeWith("trees/factory-filter.json", long_board_note),
        check: board_note_cut,
    },
    Row {
        name: "board note that fits at 1440",
        size: (1440., 846.),
        draw: Draw::Tree("trees/factory-filter.json"),
        check: board_note_fits,
    },
    Row {
        name: "question card in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: question_card,
    },
    Row {
        name: "multiSelect question card: a box per row",
        size: (1000., 700.),
        draw: Draw::Own,
        check: multi_card,
    },
    Row {
        name: "answered card in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: answered_card,
    },
    Row {
        name: "deferred pill in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: deferred_pill,
    },
    Row {
        name: "grill round in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: grill_round,
    },
    Row {
        name: "own words in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: own_words,
    },
    Row {
        name: "long own words in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: long_own_words,
    },
    Row {
        name: "override card in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: override_card,
    },
    Row {
        name: "cards gallery in a 320 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: cards_gallery_320,
    },
    Row {
        name: "long card titles in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: long_card_titles,
    },
    Row {
        name: "an option's description in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: option_description,
    },
    Row {
        name: "a question's context folded under its title; rows stay put as the selection moves",
        size: (1000., 700.),
        draw: Draw::Own,
        check: question_context,
    },
    Row {
        name: "long pill in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: long_pill,
    },
    Row {
        name: "long permission command in a 420 column",
        size: (1000., 700.),
        draw: Draw::Own,
        check: long_permission,
    },
    Row {
        name: "sessions table at 1000",
        size: (1000., 700.),
        draw: Draw::Tree("trees/sessions.json"),
        check: sessions_table,
    },
    Row {
        name: "sessions table filtered at 1000",
        size: (1000., 700.),
        draw: Draw::Tree("trees/sessions-filter.json"),
        check: sessions_filter_note,
    },
    Row {
        name: "boxes table at 1000",
        size: (1000., 700.),
        draw: Draw::Tree("trees/table-boxes.json"),
        check: boxes_table,
    },
    Row {
        name: "empty table at 900 × 280",
        size: (900., 280.),
        draw: Draw::Tree("trees/sessions-empty.json"),
        check: empty_table_room,
    },
    Row {
        name: "empty table at 900 × 90",
        size: (900., 90.),
        draw: Draw::Tree("trees/sessions-empty.json"),
        check: empty_table_short,
    },
    Row {
        name: "pipelines overview at 1400",
        size: (1400., 900.),
        draw: Draw::Tree("trees/pipelines-overview.json"),
        check: pipelines_overview,
    },
    Row {
        name: "pipelines table headers at 760",
        size: (760., 300.),
        draw: Draw::Tree("trees/pipelines-narrow.json"),
        check: pipelines_narrow_headers,
    },
    Row {
        name: "pipelines graph at 1400",
        size: (1400., 800.),
        draw: Draw::Tree("trees/pipelines-graph.json"),
        check: pipelines_graph,
    },
    Row {
        name: "pipelines graph legend at 920 (a 1400 window, Chat docked)",
        size: (920., 800.),
        draw: Draw::Tree("trees/pipelines-graph.json"),
        check: pipelines_legend_one_line,
    },
    Row {
        name: "pipelines graph legend at 600",
        size: (600., 800.),
        draw: Draw::Tree("trees/pipelines-graph.json"),
        check: pipelines_legend_wraps_whole,
    },
    Row {
        name: "pipelines log at 1400",
        size: (1400., 800.),
        draw: Draw::Tree("trees/pipelines-log.json"),
        check: pipelines_log,
    },
    Row {
        name: "pipelines graph short at 1400 × 240",
        size: (1400., 240.),
        draw: Draw::Own,
        check: pipelines_graph_short,
    },
    Row {
        name: "pipelines graph narrow at 800 × 240",
        size: (800., 240.),
        draw: Draw::Own,
        check: pipelines_graph_narrow,
    },
    Row {
        name: "install strip under its Chat's header: a part's last check unfolded, wrapped",
        size: (1440., 900.),
        draw: Draw::Tree("trees/chat-install-part.json"),
        check: install_strip_part,
    },
    Row {
        name: "install strip under its Chat's header: the files unfolded, a row each",
        size: (1440., 900.),
        draw: Draw::Tree("trees/chat-install-files.json"),
        check: install_strip_files,
    },
    Row {
        name: "local mode gallery at 1440",
        size: (1440., 1400.),
        draw: Draw::Tree("trees/local-gallery.json"),
        check: local_gallery,
    },
    Row {
        name: "settings at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-appearance.json"),
        check: settings_dialog,
    },
    Row {
        name: "settings tallest tree at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-problems.json"),
        check: settings_tallest_tree,
    },
    Row {
        name: "settings tallest tree at 1000 × 560",
        size: (1000., 560.),
        draw: Draw::Layer("trees/settings-problems.json"),
        check: settings_short_window,
    },
    Row {
        name: "settings 24 tree nodes at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-problems.json", tree_of_24),
        check: settings_24_nodes,
    },
    Row {
        name: "settings 25 tree nodes at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-problems.json", tree_of_25),
        check: settings_25_nodes,
    },
    Row {
        name: "settings 24 tree nodes at 1000 × 760",
        size: (1000., 760.),
        draw: Draw::LayerWith("trees/settings-problems.json", tree_of_24),
        check: settings_24_nodes_short,
    },
    Row {
        name: "settings tree's last node selected at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-problems.json", last_node_selected),
        check: settings_tree_selected_in_view,
    },
    Row {
        name: "settings search hit and its selection at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Own,
        check: settings_search_hit,
    },
    Row {
        name: "settings page taller than the dialog: its thumb shows, the wheel brings its last row",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-agents.json"),
        check: settings_page_scrolls,
    },
    Row {
        name: "settings combo list at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-agents.json"),
        check: settings_combo_list,
    },
    Row {
        name: "settings list editor: a line per item, + Add typed in place",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-list.json"),
        check: settings_list_editor,
    },
    Row {
        name: "settings folder field: 360 wide, Choose… inside it",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-path.json"),
        check: settings_path_field,
    },
    Row {
        name: "settings secret: dots, never its text",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-secret.json"),
        check: settings_secret_field,
    },
    Row {
        name: "settings advanced: its JSON in a code field, the refusal under it",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-advanced.json"),
        check: settings_advanced_field,
    },
    Row {
        name: "settings row: its scope, its source and Reset on one line",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-reset.json"),
        check: settings_scope_reset,
    },
    Row {
        name: "settings propose popup at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-propose.json"),
        check: settings_propose,
    },
    Row {
        name: "settings reason and serve down at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Own,
        check: settings_asks,
    },
    Row {
        name: "settings records: a header, a line of cells per record, a cell typed in place, its reason under the row",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-records.json"),
        check: settings_records_editor,
    },
    Row {
        name: "settings records: a choice cell's list under it",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-records-pick.json"),
        check: settings_records_pick,
    },
    Row {
        name: "settings records closed: Reach's environments as rows of fields",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-environments.json"),
        check: settings_records_closed,
    },
    Row {
        name: "settings account dropdown: the profiles known, then the name as typed",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-combo-account.json"),
        check: settings_combo_account,
    },
    Row {
        name: "settings refused: its reason under the row, nothing saved",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-refused.json"),
        check: settings_refused,
    },
    Row {
        name: "settings saved at once: Undo and Close in the footer, no OK",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-saved.json"),
        check: settings_saved,
    },
    Row {
        name: "settings logins' fix strip at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-logins.json"),
        check: settings_fix_strip,
    },
    Row {
        name: "settings long check state at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-logins.json", long_check_state),
        check: settings_long_check_state,
    },
    Row {
        name: "settings tight groups at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-colours.json", tight_groups),
        check: settings_tight_groups,
    },
    Row {
        name: "settings browser profiles at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-profiles.json"),
        check: settings_profiles,
    },
    Row {
        name: "settings themes at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-themes.json"),
        check: settings_themes,
    },
    Row {
        name: "settings colours at 1440 × 900",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-colours.json"),
        check: settings_colours,
    },
    Row {
        name: "settings labels whole: appearance",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-appearance.json"),
        check: labels_whole,
    },
    Row {
        name: "settings labels whole: agents",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-agents.json"),
        check: labels_whole,
    },
    Row {
        name: "settings labels whole: logins",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-logins.json"),
        check: labels_whole,
    },
    Row {
        name: "settings labels whole: search",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-search.json"),
        check: labels_whole,
    },
    Row {
        name: "settings combo as wide as its value",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-appearance.json", long_combos),
        check: settings_long_combo,
    },
    Row {
        name: "settings combo at its least",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-appearance.json"),
        check: settings_short_combo,
    },
    Row {
        name: "settings fields by kind",
        size: (1440., 900.),
        draw: Draw::LayerWith("trees/settings-search-page.json", fields_by_kind),
        check: settings_fields,
    },
    Row {
        name: "settings number field",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-appearance.json"),
        check: settings_number_field,
    },
    Row {
        name: "settings help whole: appearance",
        size: (1440., 900.),
        draw: Draw::Own,
        check: help_whole_appearance,
    },
    Row {
        name: "settings help whole: agents",
        size: (1440., 900.),
        draw: Draw::Own,
        check: help_whole_agents,
    },
    Row {
        name: "settings help whole: search",
        size: (1440., 900.),
        draw: Draw::Own,
        check: help_whole_search,
    },
    Row {
        name: "settings help whole: propose",
        size: (1440., 900.),
        draw: Draw::Own,
        check: help_whole_propose,
    },
    Row {
        name: "settings help at 900 × 800",
        size: (900., 800.),
        draw: Draw::LayerWith("trees/settings-agents.json", focus_mcp),
        check: help_narrow,
    },
    Row {
        name: "settings rows keep their y: agents",
        size: (1440., 900.),
        draw: Draw::Own,
        check: rows_keep_y_agents,
    },
    Row {
        name: "settings rows keep their y: search page",
        size: (1440., 900.),
        draw: Draw::Own,
        check: rows_keep_y_search_page,
    },
    Row {
        name: "settings logins keep their y as checks land",
        size: (1440., 900.),
        draw: Draw::Layer("trees/settings-logins-checking.json"),
        check: logins_keep_y,
    },
];

#[test]
fn each_component_lays_out_at_its_window_size() {
    for row in ROWS {
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut w = Win::open_sized(None, row.size.0, row.size.1);
            match row.draw {
                Draw::Tree(rel) => w.tree(rel, 1),
                Draw::Layer(rel) => w.layer(Some(rel), 1),
                Draw::TreeWith(rel, edit) => {
                    let mut tree = tree_of(rel);
                    edit(&mut tree);
                    show(&mut w, tree, 1);
                }
                Draw::LayerWith(rel, edit) => {
                    let mut tree = tree_of(rel);
                    edit(&mut tree);
                    w.layer_tree(tree, 1);
                }
                Draw::Own => {}
            }
            (row.check)(&mut w);
        }));
        if let Err(e) = run {
            let why = e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default();
            panic!("{}: {why}", row.name);
        }
    }
}

// --- helpers ---

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn at(w: &mut Win, selector: &str) -> B {
    w.bounds(leak(selector.to_owned()))
}

fn maybe(w: &mut Win, selector: &str) -> Option<B> {
    w.cx.debug_bounds(leak(selector.to_owned()))
}

fn node(w: &mut Win, id: &str) -> B {
    at(w, &format!("factory-node-{id}"))
}

fn tree_of(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
}

/// `tree` as the bridge's tree frame of `rev`.
fn show(w: &mut Win, tree: Value, rev: u64) {
    let line = json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev, "tree": tree})
        .to_string();
    w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
    w.cx.run_until_parked();
}

/// The view with the keyboard, in an active window.
fn focus(w: &mut Win) {
    let view = w.view.clone();
    w.cx.update(|window, cx| {
        window.activate_window();
        window.focus(&view.focus_handle(cx), cx);
    });
    w.cx.run_until_parked();
}

/// The pointer resting on `selector` past the tooltip's delay.
fn hover(w: &mut Win, selector: &str) -> B {
    let b = at(w, selector);
    w.cx.simulate_mouse_move(b.center(), None, Modifiers::default());
    w.cx.executor()
        .advance_clock(std::time::Duration::from_secs(2));
    w.cx.run_until_parked();
    b
}

fn within(inner: B, outer: B) -> bool {
    inner.top() >= outer.top()
        && inner.bottom() <= outer.bottom()
        && inner.left() >= outer.left()
        && inner.right() <= outer.right()
}

/// The first node of `kind` in a tree.
fn find_kind<'a>(v: &'a mut Value, kind: &str) -> Option<&'a mut Value> {
    if v["kind"] == kind {
        return Some(v);
    }
    v.get_mut("children")?
        .as_array_mut()?
        .iter_mut()
        .find_map(|c| find_kind(c, kind))
}

/// The node with `id` in a tree.
fn find_id<'a>(n: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    if n["id"] == id {
        return Some(n);
    }
    n.get_mut("children")?
        .as_array_mut()?
        .iter_mut()
        .find_map(|k| find_id(k, id))
}

// --- the status screen, the gallery, Command mode's layers ---

fn run_page(w: &mut Win) {
    // the steps' column 240 px on the left, the focus pane the rest, both the body's height
    let steps = node(w, "run-steps");
    let focus = node(w, "run-focus");
    assert_eq!(steps.size.width, px(240.));
    assert!(steps.right() <= focus.left(), "{steps:?} {focus:?}");
    assert_eq!(steps.top(), focus.top());
    assert_eq!(steps.size.height, focus.size.height);
    assert_eq!(w.drawn("RunStepRow").len(), 11);
    assert_eq!(w.drawn("RunStepSelected"), ["pr"]);
    // one click each, in the focus pane, above the columns
    assert_eq!(w.drawn("RunAction"), ["Review changes", "Open PR #57"]);
    let review = at(w, "button-run:review");
    assert!(focus.contains(&review.center()), "{focus:?} {review:?}");
    // what it read on the left of what it made, side by side under the actions, 5 to 7
    let (read, made) = (at(w, "run-read"), at(w, "run-made"));
    assert!(read.right() <= made.left(), "{read:?} {made:?}");
    assert_eq!(read.top(), made.top());
    assert!(review.bottom() <= read.top(), "{review:?} {read:?}");
    assert!(
        within(read, focus) && made.right() <= focus.right(),
        "{read:?} {made:?}"
    );
    assert!(made.size.width > read.size.width, "{read:?} {made:?}");
    assert!(w.drawn("RunFact").iter().any(|f| f.starts_with("Result ")));
    // the pull request's way on one line, the rung it is on washed
    assert_eq!(w.drawn("RunRung").len(), 5);
    assert_eq!(w.drawn("RunRungOn"), ["● Review"]);
    let (first, last) = (at(w, "run-rung-0"), at(w, "run-rung-5"));
    assert_eq!(first.top(), last.top());
    assert!(within(last, made), "{last:?} in {made:?}");
    assert_eq!(w.drawn("RunDoc").len(), 1);
}

fn run_ask(w: &mut Win) {
    // its question and the answer offered, boxed inside the focus pane, above the columns
    let focus = node(w, "run-focus");
    let ask = at(w, "run-ask");
    assert!(within(ask, focus), "{ask:?} in {focus:?}");
    assert!(ask.bottom() <= at(w, "run-read").top(), "{ask:?}");
    assert_eq!(w.drawn("RunAskOption"), ["Pushed, go on"]);
    assert_eq!(w.drawn("RunState"), ["◆ needs you"]);
    assert_eq!(w.drawn("RunAction"), ["Answer in Chat"]);
}

/// The first part of `kind` at any depth (a focus pane's column part).
fn part_of<'a>(v: &'a mut Value, kind: &str) -> Option<&'a mut Value> {
    if v["kind"] == kind {
        return Some(v);
    }
    match v {
        Value::Object(m) => m.values_mut().find_map(|c| part_of(c, kind)),
        Value::Array(a) => a.iter_mut().find_map(|c| part_of(c, kind)),
        _ => None,
    }
}

fn long_criterion(tree: &mut Value) {
    part_of(tree, "criteria").expect("a criteria part")["rows"][0]["text"] = json!(
        "The product list heading reads \"Products (N)\" with N the number of products shown, \
         and the count updates when the list loads, and again each time a product is added or \
         taken away, without a reload of the page and without a flash of the old count"
    );
}

/// Checkout's shot a real 400 × 100 PNG.
fn real_shot(tree: &mut Value) {
    let path = std::env::temp_dir().join("vimstorm-run-kit-shot-400x100.png");
    image::RgbaImage::new(400, 100).save(&path).unwrap();
    part_of(tree, "kit").expect("a kit part")["features"][1]["parts"][0]["shot"]["path"] =
        json!(path.to_str().unwrap());
}

fn run_shot_shape(w: &mut Win) {
    // the feature's width, a quarter as tall: the image's shape, never fitted in a short frame
    let checkout = at(w, "run-kit-checkout");
    let shot = node(w, "run:shot:verify:1:1:0:0");
    assert_eq!(shot.size.width, checkout.size.width);
    assert!(shot.size.width > px(400.), "{shot:?}");
    let tall = shot.size.width / 4.;
    assert!(
        (shot.size.height - tall).abs() <= px(1.),
        "{shot:?}, {tall:?} tall"
    );
}

fn run_criterion_whole(w: &mut Win) {
    // the long one on lines of its own, taller than a one-line row, inside what it read
    let read = at(w, "run-read");
    let long = at(w, "run-criterion-1");
    let short = at(w, "run-criterion-2");
    assert!(
        long.size.height > short.size.height,
        "{long:?} vs {short:?}"
    );
    assert!(within(long, read), "{long:?} in {read:?}");
}

/// Sixty more rows: far taller than the window.
fn long_steps(tree: &mut Value) {
    let steps = find_id(tree, "run-steps").expect("the steps");
    let rows = steps["props"]["rows"].as_array_mut().unwrap();
    let row = rows[0].clone();
    for n in 0..60 {
        let mut r = row.clone();
        r["id"] = json!(format!("extra:{n}"));
        rows.push(r);
    }
}

/// A red check's 400-line log under what it made: far taller than the window.
fn long_log(tree: &mut Value) {
    let log: Vec<String> = (0..400).map(|n| format!("  ✓ cart › total {n}")).collect();
    let check = json!({"mark": {"glyph": "✗", "hue": "bad"}, "name": "test",
        "command": "bun test", "time": "41 s", "exit": "exit 1", "output": log, "more": "",
        "red": true});
    let focus = find_id(tree, "run-focus").expect("the focus pane");
    focus["props"]["made"]["blocks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"title": "Checks", "boxed": false,
            "parts": [{"kind": "checks", "rows": [check]}]}));
}

fn run_key_scroll(w: &mut Win) {
    focus(w);
    let pane = node(w, "run-focus").size.height;
    let start = at(w, "run-made").top();
    let went = |w: &mut Win, keys: &[&str]| {
        w.keys(keys);
        start - at(w, "run-made").top()
    };
    let near = |a: Pixels, b: Pixels| (a - b).abs() <= px(1.);
    // a line, half the pane, the pane less a line; back up by each
    assert!(near(went(w, &["ctrl+e"]), px(40.)));
    assert!(near(went(w, &["ctrl+y"]), px(0.)));
    assert!(near(went(w, &["ctrl+d"]), pane / 2.));
    assert!(near(went(w, &["ctrl+u"]), px(0.)));
    assert!(near(went(w, &["page_down"]), pane - px(40.)));
    assert!(near(went(w, &["space"]), (pane - px(40.)) * 2.));
    assert!(near(went(w, &["shift+space", "page_up"]), px(0.)));
    // the foot and no further, the top again
    let foot = went(w, &["end"]);
    assert!(foot > pane * 2., "{foot:?}");
    assert!(near(went(w, &["ctrl+e", "space"]), foot));
    assert!(near(went(w, &["home"]), px(0.)));
    // the step keys are the bridge's: the pane stays
    assert!(near(went(w, &["ö", "l", "arrow_down", "shift+g"]), px(0.)));
}

fn run_steps_scroll(w: &mut Win) {
    // the steps scroll in their column; the focus pane keeps its width and the body's height
    let steps = node(w, "run-steps");
    let focus = node(w, "run-focus");
    assert_eq!(steps.size.width, px(240.));
    assert_eq!(steps.size.height, focus.size.height);
    assert!(steps.bottom() <= px(900.), "{steps:?}");
    assert!(focus.size.width >= px(800.), "{focus:?}");
}

fn run_stacked(w: &mut Win) {
    // a pane under 760 px: what it read over what it made, each the pane's width
    let focus = node(w, "run-focus");
    assert!(focus.size.width < px(760.), "{focus:?}");
    let (read, made) = (at(w, "run-read"), at(w, "run-made"));
    assert!(read.bottom() <= made.top(), "{read:?} {made:?}");
    assert_eq!(read.left(), made.left());
    assert_eq!(read.size.width, made.size.width);
    // running now and what it was sent back with, above them
    assert!(at(w, "run-now").bottom() <= at(w, "run-carried").top());
    assert!(at(w, "run-carried").bottom() <= read.top());
}

fn run_tickets(w: &mut Win) {
    // a lane a wave, a milestone after the first two; the open ticket shows its rows
    assert_eq!(w.drawn("RunLane").len(), 3);
    assert_eq!(w.drawn("RunMilestone").len(), 2);
    assert_eq!(
        w.drawn("RunTicketOpen"),
        ["#41 · T1 Sign-in tokens: issue, store, expire"]
    );
    assert_eq!(w.drawn("RunTicket").len(), 3);
    // a wave's tickets side by side, inside what it made
    let made = at(w, "run-made");
    let (t1, t2, t3) = (
        node(w, "run:ticket:step:1:T1"),
        node(w, "run:ticket:step:1:T2"),
        node(w, "run:ticket:step:1:T3"),
    );
    assert!(
        t2.right() <= t3.left() && t2.top() == t3.top(),
        "{t2:?} {t3:?}"
    );
    assert!(t1.bottom() <= t2.top(), "{t1:?} {t2:?}");
    assert!(within(t3, made), "{t3:?} in {made:?}");
    assert!(t1.size.height > t2.size.height, "{t1:?} {t2:?}");
}

fn run_verify_report(w: &mut Win) {
    // a feature each, its verdict next to its word
    assert_eq!(
        w.drawn("RunKitFeature"),
        [
            "✓ Pass Cart total follows quantity",
            "✓ Pass Shipping added once",
            "○ Not driven Search",
        ]
    );
    assert_eq!(w.drawn("RunKitPair").len(), 1);
    // a pair says which shot is which, over each; Before over After, each the feature's width
    assert_eq!(w.drawn("RunKitPairLabel"), ["Before", "After"]);
    let (before, after) = (at(w, "run-kit-pair-before"), at(w, "run-kit-pair-after"));
    let cart = at(w, "run-kit-cart");
    assert!(before.bottom() <= after.top(), "{before:?} {after:?}");
    assert_eq!(before.size.width, cart.size.width);
    assert_eq!(after.size.width, cart.size.width);
    assert_eq!(w.drawn("RunKitShot").len(), 3);
    // a shot alone the feature's width too, a click on it its full size; its page and account
    // under it, the env by the feature's name
    let (checkout, summary) = (
        at(w, "run-kit-checkout"),
        node(w, "run:shot:verify:1:1:0:0"),
    );
    assert_eq!(summary.size.width, checkout.size.width);
    assert!(summary.size.height >= px(200.), "{summary:?}");
    let url = node(w, "run:url:verify:1:1:0:0");
    assert!(url.top() >= summary.bottom(), "{url:?} under {summary:?}");
    assert_eq!(
        w.drawn("RunKitWhere"),
        [
            "http://localhost:5173/cart · as buyer",
            "http://localhost:5173/cart · as buyer",
            "http://localhost:5173/cart · as buyer",
            "http://localhost:5173/checkout · as buyer",
            "http://localhost:5173/checkout · as buyer",
        ]
    );
    assert_eq!(w.drawn("RunKitEnv"), ["local", "local"]);
    assert_eq!(w.drawn("RunKitJudged").len(), 2);
    assert_eq!(
        w.drawn("RunKitNotDriven"),
        ["The diff touches no search code."]
    );
    // a GIF plays in place with its pause; a webm alone opens in the player
    assert_eq!(w.drawn("RunKitPlaying").len(), 1);
    assert!(w.drawn("RunKitPlaying")[0].starts_with("❚❚ Pause "));
    assert!(w.drawn("RunKitRecording")[0].starts_with("▶ Open in player "));
    // the criteria in what it read; the kit in what it made, its features one under another
    let (read, made) = (at(w, "run-read"), at(w, "run-made"));
    assert!(read.right() <= made.left(), "{read:?} {made:?}");
    let criterion = at(w, "run-criterion-1");
    assert!(within(criterion, read), "{criterion:?} in {read:?}");
    assert!(
        cart.left() >= made.left() && cart.right() <= made.right(),
        "{cart:?} in {made:?}"
    );
    assert!(cart.bottom() <= checkout.top(), "{cart:?} {checkout:?}");
}

fn status_screen(w: &mut Win) {
    // the Stack's sizes: serve as tall as its rows, sessions the rest, the hint at the bottom
    let serve = node(w, "serve");
    let sessions = node(w, "sessions");
    let hint = node(w, "reload");
    assert!(serve.bottom() <= sessions.top(), "{serve:?} {sessions:?}");
    assert!(
        sessions.size.height > serve.size.height,
        "flex takes the rest"
    );
    assert!(
        hint.top() >= sessions.bottom() && hint.bottom() > px(650.),
        "{hint:?}"
    );
    // rows are 22 px, an AgentStatus on its row
    let row = node(w, "session:s1");
    assert_eq!(row.size.height, px(22.));
    let status = w.sel("AgentStatus", "Needs you");
    let status = w.bounds(status);
    assert!(row.contains(&status.center()), "{row:?} {status:?}");
}

fn gallery(w: &mut Win) {
    // no keyboard: the selected row draws the inactive selection; with it, the active one
    let inactive = w.drawn("Selection");
    assert!(inactive[0].ends_with(" inactive"), "{inactive:?}");
    focus(w);
    let active = w.drawn("Selection");
    assert!(active[0].ends_with(" active"), "{active:?}");
    // the header is 31 high, its tabs left to right
    let header = w.sel("ToolWindowHeader", "Git");
    assert_eq!(w.bounds(header).size.height, px(31.));
    let (log, changes) = (node(w, "tab:log"), node(w, "tab:changes"));
    assert!(log.right() <= changes.left());
    // a row of badges: left to right, one top
    let (a, b) = (w.sel("Badge", "good"), w.sel("Badge", "warn"));
    let (a, b) = (w.bounds(a), w.bounds(b));
    assert!(a.right() <= b.left() && a.top() == b.top(), "{a:?} {b:?}");
}

fn pick(w: &mut Win) {
    // 480 wide, centred in the 1000 px view, 48 px down; a row 22 high inside it
    let pick = at(w, "factory-pick");
    assert_eq!(pick.size.width, px(480.));
    assert_eq!(pick.left(), px(260.));
    assert_eq!(pick.top(), px(48.));
    let row = at(w, "factory-pick-row-command:card show");
    assert_eq!(row.size.height, px(22.));
    assert!(pick.contains(&row.center()));
}

fn confirm(w: &mut Win) {
    // the risky choice first, No last
    let (risky, no) = (at(w, "factory-confirm-risky"), at(w, "factory-confirm-no"));
    assert!(risky.right() <= no.left(), "No last");
}

fn action_menu(w: &mut Win) {
    // the separator: a 9 px band with its line, between its two rows
    let line = at(w, "factory-pick-separator");
    assert_eq!(line.size.height, px(9.));
    assert!(line.top() >= at(w, "factory-pick-row-keep").bottom());
    assert!(line.bottom() <= at(w, "factory-pick-row-launch-local-sandbox").top());
    let pick = at(w, "factory-pick");
    assert_eq!(pick.size.width, px(480.));
    let first = at(w, "factory-pick-row-launch");
    assert_eq!(first.size.height, px(22.));
    // 12 of its 13 entries shown: a thumb inside the rows' right inset, its length their share
    let thumb = at(w, "factory-pick-scrollbar");
    assert!(thumb.right() <= pick.right() && thumb.left() >= pick.right() - px(8.));
    assert!(thumb.top() <= first.top() + px(1.));
    let rows = at(w, "factory-pick-row-prototype").bottom() - first.top();
    let share = thumb.size.height.as_f32() / rows.as_f32();
    assert!((share - 12. / 13.).abs() < 0.02, "thumb share {share}");
}

fn launch_box(w: &mut Win) {
    // 640 wide, centred in the 1000 px view
    let b = at(w, "factory-launch");
    assert_eq!(b.size.width, px(640.));
    assert_eq!(b.left(), px(180.));
    // the caret in the field, where it runs under it, Launch at the bottom right
    let field = at(w, "factory-launch-field");
    assert!(field.contains(&at(w, "factory-launch-caret").center()));
    assert!(at(w, "factory-launch-runs-cloud").top() > field.bottom());
    assert!(at(w, "factory-launch-go").right() <= b.right());
    assert!(
        w.drawn("LaunchCount").is_empty(),
        "no count under its bound"
    );
}

fn launch_box_picked(w: &mut Win) {
    let b = at(w, "factory-launch");
    // the workflows grouped by source above the note, the picked one alone lit, inside the box
    assert_eq!(w.drawn("LaunchWorkflowHead"), ["Repo’s", "Yours", "Abe’s"]);
    assert_eq!(w.drawn("LaunchWorkflowPicked"), ["Bug"]);
    let list = at(w, "factory-launch-workflows");
    assert!(list.bottom() <= at(w, "factory-launch-field").top());
    assert!(at(w, "factory-launch-workflow-investigate").right() <= b.right());
    // its on: misses the card: the warning under the list; prod on here: its warning, red
    assert_eq!(w.drawn("LaunchWorkflowWarn").len(), 1);
    assert!(
        at(w, "factory-launch-workflow-warn").top()
            > at(w, "factory-launch-workflow-investigate").bottom()
    );
    assert_eq!(
        w.drawn("LaunchRuns"),
        ["● Local · its card worktree", "○ A box · your environment"]
    );
    assert_eq!(
        w.drawn("LaunchReach"),
        ["✓ dev", "✓ test", "● prod on · this session"]
    );
    assert!(at(w, "factory-launch-prod-warn").top() > at(w, "factory-launch-reach-prod").bottom());
    // the whole box in the view, Launch inside it
    assert!(b.bottom() <= px(700.));
    assert!(at(w, "factory-launch-go").bottom() <= b.bottom());
}

fn launch_over(t: &mut Value) {
    t["props"]["count"] = "2001 / 2000".into();
    t["props"]["over"] = true.into();
}

fn launch_box_over(w: &mut Win) {
    // past its bound: the count shows, Launch grey
    assert_eq!(w.drawn("LaunchCount").len(), 1);
    assert_eq!(w.drawn("LaunchGo"), ["Launch (grey)"]);
}

fn prompt_caret(w: &mut Win) {
    // `12`, the caret at its end; `123` with the caret after `12`: the same place
    w.layer(Some("trees/command-prompt.json"), 1);
    let end = at(w, "factory-caret");
    w.layer(Some("trees/command-prompt-caret.json"), 2);
    assert_eq!(at(w, "factory-caret").left(), end.left());
}

fn pick_caret(w: &mut Win) {
    // the filter `card show` with the caret after `card sh`: where `card sh` ends
    let pick = |filter: &str| {
        json!({
            "kind": "PickLayer",
            "id": "command-mode",
            "props": {"title": "Command mode", "filter": filter, "caret": null, "rows": []},
        })
    };
    w.layer_tree(pick("card sh"), 1);
    let typed = at(w, "factory-caret");
    w.layer(Some("trees/command-pick-caret.json"), 2);
    assert_eq!(at(w, "factory-caret").left(), typed.left());
    w.layer_tree(pick("card show"), 3);
    assert!(at(w, "factory-caret").left() > typed.left());
}

fn comment_caret(w: &mut Win) {
    // the caret on the line it is in, at its place there
    let comment = |caret: Option<usize>| {
        json!({
            "kind": "CommentBox",
            "id": "comment:4",
            "props": {
                "title": "Comment on #4 Cart",
                "thread": {"state": "ready", "comments": []},
                "destination": "#4 · Azure Boards",
                "draft": "one\ntwo",
                "caret": caret,
                "state": "writing",
            },
        })
    };
    w.layer_tree(comment(None), 1);
    let last = at(w, "factory-comment-caret");
    w.layer_tree(comment(Some(1)), 2);
    let first = at(w, "factory-comment-caret");
    assert!(first.top() < last.top(), "on the first line");
    assert!(first.left() < last.left(), "after `o`");
}

fn comment_box(w: &mut Win) {
    assert_eq!(at(w, "factory-comment").size.width, px(640.));
    assert!(maybe(w, "factory-comment-caret").is_some());
}

fn linked(w: &mut Win) {
    // Search Everywhere's place: 670 wide, centred, 48 px from the top
    let popup = at(w, "factory-linked");
    assert_eq!(popup.size.width, px(670.));
    assert_eq!(popup.left(), px(165.));
    assert_eq!(popup.top(), px(48.));
    let story = at(w, "factory-linked-row-story");
    let sheets = at(w, "factory-linked-row-sheets");
    assert_eq!(story.size.height, px(30.));
    assert!(story.bottom() <= sheets.top(), "in their order");
    assert!(popup.contains(&sheets.center()));
}

fn long_linked_state(t: &mut Value) {
    let long = "not read · no board in the settings: set board (organization, project and team) \
                in .abe/settings.yaml, or answer Board in the install";
    t["props"]["rows"][0]["value"] = json!([{ "text": long }]);
}

fn linked_long_state(w: &mut Win) {
    // two lines, inside its row and the popup, never cut at the popup's edge
    let popup = at(w, "factory-linked");
    let story = at(w, "factory-linked-row-story");
    let value = at(w, "factory-linked-row-story-value");
    assert!(story.size.height > px(30.), "{story:?}");
    assert!(within(value, story), "{value:?} in {story:?}");
    assert!(within(story, popup), "{story:?} in {popup:?}");
    assert!(story.bottom() <= at(w, "factory-linked-row-sheets").top());
}

fn card_dialog(w: &mut Win) {
    // 840 wide, centred in the 1000 × 700 view; its markdown through the preview's renderer
    let frame = at(w, "factory-dialog");
    assert_eq!(frame.size.width, px(840.));
    assert_eq!(frame.left(), px(80.));
    assert!(maybe(w, "factory-dialog-row-0").is_some());
}

/// The card dialog with a plain button before its primary, the keys on it.
fn menu_button_focused(t: &mut Value) {
    let dialog = find_kind(t, "CardDialog").unwrap();
    let props = &mut dialog["props"];
    let primary = props["buttons"][0].clone();
    props["buttons"] = json!([{"id": "dialog:menu", "label": "More", "keys": "⌘⏎"}, primary]);
    props["focus"] = json!("dialog:menu");
}

fn dialog_button_focus(w: &mut Win) {
    // the first button filled (⏎ presses it), the primary plain while the keys are not on it
    let (focused, buttons) = w.view.read_with(&w.cx, |v, _| {
        let d = v.drawn();
        let texts = |k| {
            d.texts(k)
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        (texts("DialogButtonFocused"), texts("DialogButton"))
    });
    assert_eq!(focused.len(), 1, "{focused:?}");
    assert_eq!(buttons.first(), focused.first(), "{buttons:?}");
}

fn new_card_refused(w: &mut Win) {
    // the refusal on the footer's left, before the buttons
    let error = at(w, "factory-dialog-error");
    let create = at(w, "factory-dialog:primary");
    assert!(error.right() <= create.left(), "{error:?} {create:?}");
}

fn long_story(w: &mut Win) {
    // over the Board, centred; Linked between the body and the footer, 48 high, its chips 24
    // in one row; the hint before the primary
    let frame = at(w, "factory-dialog");
    assert_eq!(frame.size.width, px(840.));
    assert_eq!(frame.left(), px(80.));
    let linked = at(w, "factory-dialog-linked");
    assert_eq!(linked.size.height, px(48.));
    let body = at(w, "factory-dialog-body");
    assert!(linked.top() >= body.bottom());
    let session = at(w, "factory-dialog:linked:session");
    assert_eq!(session.size.height, px(24.));
    let pr = at(w, "factory-dialog:linked:pr");
    assert!(
        pr.left() > session.left() && pr.top() == session.top(),
        "one row"
    );
    let hint = at(w, "factory-dialog-hint");
    let primary = at(w, "factory-dialog:primary");
    assert!(
        hint.right() <= primary.left(),
        "the hint before the primary"
    );
    // a long story stops 80 px short of the view's edges, its body scrolling
    assert_eq!(frame.size.height, px(700. - 2. * 80.));
    assert_eq!(frame.top(), px(80.));
    assert!(body.size.height > px(100.), "{body:?}");
}

fn short_story(w: &mut Win) {
    // sized to its content, short of the 540 px at its tallest, centred in the 700 px view
    let frame = at(w, "factory-dialog");
    assert!(
        frame.size.height < px(460.),
        "sized to its content: {frame:?}"
    );
    let room = px(700.) - frame.size.height;
    assert!((frame.top() - room / 2.).abs() <= px(1.), "{frame:?}");
    // the body ends where Linked starts: no empty room between them
    let linked = at(w, "factory-dialog-linked");
    let body = at(w, "factory-dialog-body");
    assert!(
        linked.top() - body.bottom() <= px(1.),
        "{body:?} {linked:?}"
    );
    // a 1 px rule 4 px under each heading's text, across the column
    for i in 0..2 {
        let head = at(w, &format!("factory-dialog-section-title-{i}"));
        let rule = at(w, &format!("factory-dialog-section-rule-{i}"));
        assert_eq!(rule.size.height, px(1.), "rule {i}");
        assert_eq!(rule.top(), head.bottom() + px(4.), "rule {i}");
        assert!(rule.size.width > px(700.), "rule {i} spans the column");
    }
}

/// A 24 × 16 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x83, 0x46, 0x28,
    0xc2, 0x00, 0x00, 0x00, 0x25, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x78, 0x86, 0x04, 0x6c,
    0x2a, 0x4e, 0xc0, 0x11, 0xa9, 0xe2, 0x0c, 0xc3, 0xd8, 0x20, 0x4a, 0x34, 0x23, 0x8b, 0x0f, 0x67,
    0x83, 0x46, 0xd3, 0xd1, 0x68, 0x3a, 0xa2, 0x82, 0x41, 0x00, 0xba, 0xca, 0x22, 0xae, 0xf9, 0x1e,
    0x21, 0x95, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn story_comments(w: &mut Win) {
    // the tree names the image at a contract path; a real file stands there
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("cart.png");
    std::fs::write(&png, PNG).unwrap();
    let text = std::fs::read_to_string(fixture("trees/story-comments.json"))
        .unwrap()
        .replace("/abe-contract/images/cart.png", png.to_str().unwrap());
    w.layer_tree(serde_json::from_str(&text).unwrap(), 1);
    // oldest first, each under its byline
    let first = at(w, "factory-dialog-comment-0");
    let second = at(w, "factory-dialog-comment-1");
    assert!(first.bottom() <= second.top(), "{first:?} {second:?}");
    // the image drawn from its file, at its size, inside the second comment
    let image = w.bounds("md-image");
    assert_eq!(image.size.width, px(24.));
    assert_eq!(image.size.height, px(16.));
    assert!(second.contains(&image.origin), "{second:?} {image:?}");
}

fn card_page(w: &mut Win) {
    // an island filling the view inset by the islands' gap: no dialog frame, no close button
    let page = at(w, "factory-card-page");
    assert_eq!(page.left(), px(4.));
    assert_eq!(page.top(), px(4.));
    assert_eq!(page.size.width, px(1000. - 8.));
    assert_eq!(page.size.height, px(700. - 8.));
    assert!(maybe(w, "factory-dialog").is_none());
    assert!(maybe(w, "button-factory-dialog-close").is_none());
    // the body, Linked, the composer, the footer's actions, top to bottom, inside it
    let body = at(w, "factory-card-page-body");
    let linked = at(w, "factory-dialog-linked");
    let composer = at(w, "factory-card-page-composer");
    let comment = at(w, "factory-card:comment");
    assert!(body.bottom() <= linked.top(), "{body:?} {linked:?}");
    assert!(linked.bottom() <= composer.top(), "{linked:?} {composer:?}");
    assert!(
        composer.bottom() <= comment.top(),
        "{composer:?} {comment:?}"
    );
    assert!(within(comment, page), "{comment:?} in {page:?}");
    assert!(body.size.height > px(200.), "{body:?}");
    // the draft typed, its caret drawn while the keys are in it
    assert_eq!(w.drawn("CardPageComposerFocused"), ["Seen it"]);
    assert!(maybe(w, "factory-card-page-caret").is_some());
    // its session runs: Launch again… stops it first
    assert_eq!(
        w.drawn("DialogButton"),
        [
            "Comment ⏎",
            "Move…",
            "Assign…",
            "Launch again…",
            "Stop the session"
        ]
    );
    // a live session's card launches too: the launch stops it first
    assert!(w.drawn("DialogButtonDisabled").is_empty());
}

fn card_popup(w: &mut Win) {
    let board = node(w, "col:New");
    let line = json!({"v": 2, "type": "tree", "screen": "card", "rev": 2,
        "tree": tree_of("trees/card-page.json"), "slot": "popup"})
    .to_string();
    w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
    w.cx.run_until_parked();
    // the Board still drawn, dimmed under a scrim over the whole view
    let scrim = at(w, "factory-card-popup-scrim");
    assert_eq!(node(w, "col:New"), board);
    assert_eq!((scrim.size.width, scrim.size.height), (px(1440.), px(846.)));
    assert!(within(board, scrim), "{board:?} {scrim:?}");
    // the page in a popup frame: 76 % × 88 % of the view, centred, no island of its own
    let popup = at(w, "factory-card-popup");
    let (pw, ph) = (f32::from(popup.size.width), f32::from(popup.size.height));
    assert!((pw - 1440. * 0.76).abs() <= 1., "{popup:?}");
    assert!((ph - 846. * 0.88).abs() <= 1., "{popup:?}");
    let (left, right) = (popup.left() - scrim.left(), scrim.right() - popup.right());
    let (top, bottom) = (popup.top() - scrim.top(), scrim.bottom() - popup.bottom());
    assert!((left - right).abs() <= px(1.), "{popup:?}");
    assert!((top - bottom).abs() <= px(1.), "{popup:?}");
    assert!(maybe(w, "factory-card-page").is_none());
    // its parts inside it, top to bottom, its close button in the head
    let body = at(w, "factory-card-page-body");
    let composer = at(w, "factory-card-page-composer");
    let comment = at(w, "factory-card:comment");
    assert!(body.bottom() <= composer.top(), "{body:?} {composer:?}");
    assert!(within(comment, popup), "{comment:?} in {popup:?}");
    assert!(within(at(w, "button-factory-dialog-close"), popup));
    assert_eq!(w.drawn("CardPage"), ["Cart total includes shipping"]);
    // closed: the Board alone again
    let closed = json!({"v": 2, "type": "closed", "slot": "popup"}).to_string();
    w.view
        .update(&mut w.cx, |v, cx| v.receive_line(&closed, cx));
    w.cx.run_until_parked();
    assert!(maybe(w, "factory-card-popup").is_none());
    assert!(!w.view.read_with(&w.cx, |v, _| v.popup_open()));
}

fn card_page_actions(w: &mut Win) {
    // Move… drawn as the default while the keys are on it; the composer's caret not drawn
    assert_eq!(w.drawn("DialogButtonFocused"), ["Move…"]);
    assert!(w.drawn("CardPageComposerFocused").is_empty());
    assert!(maybe(w, "factory-card-page-caret").is_none());
    assert!(maybe(w, "factory-card-page-field").is_some());
}

// --- the Board ---

const COLUMNS: [&str; 4] = ["col:New", "col:Active", "col:Resolved", "col:Closed"];

fn columns(w: &mut Win) -> Vec<B> {
    COLUMNS.iter().map(|c| node(w, c)).collect()
}

/// A rail row's line height and a card at its tallest (`CARD_PITCH` 94 + 6 in `factory.ts`).
const RAIL_LINE: f32 = 16.;
const CARD_TALLEST: f32 = 94.;
/// The stage word's lead gap (`theme::ABE_CARD_GAP`): all that is left once it gave way.
const GAP: f32 = 6.;

/// The bounds of `factory-<name>-<ix>`, when drawn.
fn part(w: &mut Win, name: &str, ix: &str) -> Option<B> {
    maybe(w, &format!("factory-{name}-{ix}"))
}

/// The index of each drawn rail row, with its words.
fn rails(w: &mut Win) -> Vec<(String, String)> {
    w.drawn("Rail")
        .into_iter()
        .map(|rail| {
            let ix = w
                .sel("Rail", &rail)
                .trim_start_matches("factory-Rail-")
                .to_owned();
            (rail, ix)
        })
        .collect()
}

/// Every rail row is one line inside its card, its words whole and inside it (none over the
/// next), and no card is taller than the pitch.
fn rails_whole(w: &mut Win) {
    for (rail, ix) in rails(w) {
        let row = part(w, "Rail", &ix).unwrap();
        assert_eq!(row.size.height, px(RAIL_LINE), "{rail}: one line");
        let state = part(w, "RailState", &ix).unwrap();
        assert!(
            state.left() >= row.left() && state.right() <= row.right(),
            "{rail}: the state {state:?} in the row {row:?}"
        );
        if let Some(stage) = part(w, "RailStage", &ix) {
            let word = part(w, "RailStageWord", &ix).unwrap();
            assert!(
                word.left() >= stage.left() && word.right() <= stage.right(),
                "{rail}: the stage word {word:?} whole in {stage:?}"
            );
            assert!(stage.right() <= state.left(), "{rail}: the stage first");
        }
        let word = part(w, "RailWord", &ix).unwrap();
        assert!(word.left() >= state.left(), "{rail}: its word in the state");
        if let Some(mark) = part(w, "RailMark", &ix) {
            assert!(
                mark.left() >= state.right() && mark.right() <= row.right(),
                "{rail}: the box mark {mark:?} after the state, in {row:?}"
            );
        }
        if let Some(b) = part(w, "RailBox", &ix) {
            assert!(
                b.left() >= state.right() && b.right() <= row.right() && b.size.width == px(12.),
                "{rail}: the cloud {b:?} after the state, in the row {row:?}"
            );
        }
        // a box word is cut only on a full row, once the stage word gave way
        if let (Some(word), Some(clip), Some(mark)) = (
            part(w, "RailBoxWord", &ix),
            part(w, "RailBoxClip", &ix),
            part(w, "RailMark", &ix),
        ) {
            let whole = clip.right() >= word.right();
            let full = mark.left() - state.right() < px(0.5);
            let stage_gone = part(w, "RailStage", &ix).is_none_or(|s| s.size.width <= px(GAP));
            assert!(
                whole || (full && stage_gone),
                "{rail}: its box word cut with room, or before the stage word"
            );
        }
    }
    for card in w.drawn("BoardCard") {
        let id = card
            .split_whitespace()
            .next()
            .unwrap()
            .trim_start_matches('#');
        let c = node(w, &format!("card:{id}"));
        assert!(
            c.size.height <= px(CARD_TALLEST),
            "#{id}: {:?} tall",
            c.size.height
        );
    }
}

/// The rail row's index whose words are `rail`.
fn rail_ix(w: &mut Win, rail: &str) -> String {
    w.sel("Rail", rail)
        .trim_start_matches("factory-Rail-")
        .to_owned()
}

/// Every column one width; none of the cards wider than 360.
fn equal_columns(w: &mut Win) -> Vec<B> {
    let cols = columns(w);
    let first = cols[0].size.width;
    for (c, b) in COLUMNS.iter().zip(&cols) {
        assert!(
            (b.size.width - first).abs() < px(1.),
            "{c}: {:?} vs {first:?}",
            b.size.width
        );
    }
    // Closed holds nothing and keeps its share
    assert!(cols[3].size.width > px(240.));
    let card = node(w, "card:1234");
    assert!(card.size.width <= px(360.), "{:?}", card.size.width);
    cols
}

fn board_1440(w: &mut Win) {
    let cols = equal_columns(w);
    // a column wider than a card: the card sits at its left
    let card = node(w, "card:1234");
    assert!(cols[1].size.width > px(340.));
    assert!(card.left() - cols[1].left() < px(10.));
    rails_whole(w);
    // with room, nothing gives way: Queued whole, the segments whole (5 × 12, 2 apart), Build
    let queued = rail_ix(w, "○ Queued · 1 min");
    let (word, clip) = (
        part(w, "RailBoxWord", &queued).unwrap(),
        part(w, "RailBoxClip", &queued).unwrap(),
    );
    assert!(clip.right() >= word.right(), "Queued whole");
    let review = rail_ix(w, "Verify ● Verifying · 3 min");
    assert_eq!(part(w, "RailSegs", &review).unwrap().size.width, px(68.));
    let build = rail_ix(w, "Build ◆ Needs you · 4 min");
    assert!(part(w, "RailStage", &build).is_some(), "Build shown");
    // the assignee's initials: a round 16 px badge on the card
    let badge = at(w, "factory-Initials-1234");
    assert_eq!((badge.size.width, badge.size.height), (px(16.), px(16.)));
    assert!(card.contains(&badge.center()));
    // the sprint and its count 8 px in from the header's right end
    let head = node(w, "board-head");
    let counts = at(w, "factory-BoardCounts");
    let team = node(w, "tab:team");
    assert_eq!(counts.right(), head.right() - px(8.));
    assert!(counts.left() > team.right() + px(400.), "{counts:?}");
}

fn board_1100(w: &mut Win) {
    equal_columns(w);
    rails_whole(w);
    // a 230 px row: `Build ◆ Needs you · 4 min` and the cloud do not fit, so `Build` is left
    // out whole (the segments still say the stage) and the cloud stays
    let build = rail_ix(w, "Build ◆ Needs you · 4 min");
    assert_eq!(part(w, "Rail", &build).unwrap().size.width, px(230.));
    assert!(part(w, "RailStage", &build).is_none(), "Build left out");
    assert!(part(w, "RailBox", &build).is_some(), "the cloud stays");
}

fn board_1000(w: &mut Win) {
    rails_whole(w);
}

fn board_800(w: &mut Win) {
    let cols = columns(w);
    let board = node(w, "board");
    for (c, b) in COLUMNS.iter().zip(&cols) {
        assert_eq!(b.size.width, px(254.), "{c}");
    }
    // three columns whole on the Board; Closed wholly past its right edge, no sliver of it cut
    let area = node(w, "columns");
    for (c, b) in COLUMNS.iter().zip(&cols).take(3) {
        assert!(
            b.left() >= board.left() && b.right() <= board.right(),
            "{c} in view"
        );
    }
    assert!(
        cols[3].left() >= area.right() - px(10.),
        "Closed out of view whole: {:?} vs {area:?}",
        cols[3]
    );
    // the sign it is there: its name at the header's right, the sideways thumb at the bottom
    let more = at(w, "factory-BoardMore");
    let head = node(w, "board-head");
    assert!(more.right() <= head.right() && more.right() > head.right() - px(20.));
    let bar = at(w, "factory-BoardScrollBar");
    assert!(bar.bottom() <= area.bottom() && bar.top() >= cols[0].bottom());
    // the thumb: at the share scrolled past, as long as the share in view
    assert_eq!(w.drawn("ScrollBar"), ["0.00 0.75"]);
    assert!(bar.size.width > px(400.) && bar.size.width < area.size.width);
    rails_whole(w);
    // the counts before the hint, past the tabs
    let counts = at(w, "factory-BoardCounts");
    assert!(counts.right() < more.left(), "{counts:?} {more:?}");
    assert!(counts.left() > node(w, "tab:team").right() + px(100.));
}

fn board_600(w: &mut Win) {
    let cols = columns(w);
    for (c, b) in COLUMNS.iter().zip(&cols) {
        assert_eq!(b.size.width, px(285.), "{c}");
    }
    // moved one column left: New off the Board, Resolved (selected) in view
    let board = node(w, "board");
    assert!(cols[0].right() < board.left() + px(10.));
    assert!(cols[2].left() >= board.left() && cols[2].right() <= board.right());
    // the thumb: at the share scrolled past, as long as the share in view
    assert_eq!(w.drawn("ScrollBar"), ["0.25 0.50"]);
    rails_whole(w);
    // the longest state with `☁ asleep`: the stage word and the box word went first, whole
    let ix = rail_ix(w, "PR ● Ready for review · 25 min");
    assert!(part(w, "RailStage", &ix).is_none());
    assert!(part(w, "RailBoxWord", &ix).is_none());
    let row = part(w, "Rail", &ix).unwrap();
    let state = part(w, "RailState", &ix).unwrap();
    let cloud = part(w, "RailBox", &ix).unwrap();
    assert!(state.right() <= cloud.left() && cloud.right() <= row.right());
    assert_eq!(cloud.size.width, px(12.));
}

fn board_430(w: &mut Win) {
    // the narrowest column: the longest rail row stays on its one line inside the card
    let ix = rail_ix(w, "PR ● Ready for review · 25 min");
    let row = part(w, "Rail", &ix).unwrap();
    let card = node(w, "card:1263");
    let col = node(w, "col:Resolved");
    assert_eq!(col.size.width, px(200.));
    assert!(card.right() <= col.right());
    assert!(row.left() >= card.left() && row.right() <= card.right());
    rails_whole(w);
}

fn board_filter_400(w: &mut Win) {
    // side by side inside the header: the filter whole, the hint cut to an ellipsis
    let head = node(w, "board-head");
    let note = at(w, "factory-BoardNote");
    let more = at(w, "factory-BoardMore");
    assert!(note.size.width > px(35.), "the filter: {note:?}");
    assert!(more.size.width > px(10.), "the hint: {more:?}");
    assert!(note.right() <= more.left() && more.right() <= head.right());
}

fn board_card_no_run(w: &mut Win) {
    // card 1262 has no run, its box sleeps: its cloud at the note row's right, inside the card,
    // `asleep` whole
    let card = node(w, "card:1262");
    let ix = w
        .sel("CardNote", "No session")
        .trim_start_matches("factory-CardNote-")
        .to_owned();
    let cloud = part(w, "RailBox", &ix).unwrap();
    assert!(card.contains(&cloud.center()), "{cloud:?} in {card:?}");
    assert!(cloud.right() <= card.right());
    let word = part(w, "RailBoxWord", &ix).unwrap();
    let clip = part(w, "RailBoxClip", &ix).unwrap();
    assert!(clip.right() >= word.right(), "asleep drawn whole");
}

fn board_selected_edge(w: &mut Win) {
    focus(w);
    // with the keyboard, the header's selected tab in the active look
    let tabs = w.drawn("TabSelected");
    assert!(
        !tabs.is_empty() && tabs.iter().all(|t| t.ends_with(" active")),
        "{tabs:?}"
    );
    let edge = |w: &mut Win, card: &str| {
        w.drawn("CardEdge")
            .into_iter()
            .find(|e| e.starts_with(card))
            .unwrap_or_else(|| panic!("{card} has no edge"))
    };
    // selected and needing you: the focus border, the needs-you ring inside it
    assert_eq!(edge(w, "#1234 "), "#1234 focus · ring needs-you");
    // a card neither selected nor standing out: its plain border, no ring
    assert_eq!(edge(w, "#1251 "), "#1251 plain");
    // the same card failed: its red border, the focus ring inside it
    let text = std::fs::read_to_string(fixture("trees/factory-overview.json"))
        .unwrap()
        .replace(r#""emphasis": "needs-you""#, r#""emphasis": "failed""#);
    show(w, serde_json::from_str(&text).unwrap(), 2);
    assert_eq!(edge(w, "#1234 "), "#1234 bad · ring focus");
}

fn board_card_tooltips(w: &mut Win) {
    // all of card 1251 on the card: no tooltip
    hover(w, "factory-node-card:1251");
    assert!(w.cx.debug_bounds("tooltip").is_none(), "no tooltip");
    // card 1234's says what the card does not: below it, left-aligned with it
    let card = hover(w, "factory-node-card:1234");
    let tip = w.bounds("tooltip");
    assert!(
        tip.top() >= card.bottom(),
        "{tip:?} below the card {card:?}"
    );
    assert!(
        (tip.left() - card.left()).abs() < px(1.),
        "{tip:?} {card:?}"
    );
}

fn long_card_title(t: &mut Value) {
    let long =
        "Saved carts survive sign-out, a session timeout, a second device and a cleared cache";
    let text = t.to_string().replace("Saved carts survive sign-out", long);
    *t = serde_json::from_str(&text).unwrap();
}

fn board_long_title_tooltip(w: &mut Win) {
    // a title past the card's two lines: its tooltip below it, wrapped at its widest
    let card = hover(w, "factory-node-card:1251");
    let tip = w.bounds("tooltip");
    assert!(tip.top() >= card.bottom(), "{tip:?} below {card:?}");
    assert!(tip.size.width <= px(480.), "{tip:?}");
}

fn long_state_word(t: &mut Value) {
    let text = t.to_string().replace(
        r#""word":"Ready for review""#,
        r#""word":"Ready for review by the whole team today""#,
    );
    *t = serde_json::from_str(&text).unwrap();
    // and no reason: only the cut word makes its tooltip show
    let props = &mut find_id(t, "card:1263").unwrap()["props"];
    props["tooltip"] =
        "#1263 Friendly greeting with no name · Ready for review by the whole team today".into();
    props.as_object_mut().unwrap().remove("tipAdds");
}

fn board_state_word_cut(w: &mut Win) {
    let ix = rail_ix(w, "PR ● Ready for review by the whole team today · 25 min");
    let row = part(w, "Rail", &ix).unwrap();
    let word = part(w, "RailWord", &ix).unwrap();
    let state = part(w, "RailState", &ix).unwrap();
    // cut: narrower than the row, the state and its time inside the row
    assert!(word.size.width < row.size.width / 2., "{word:?} in {row:?}");
    assert!(state.right() <= row.right());
    // the segments narrowed first
    let segs = part(w, "RailSegs", &ix).unwrap();
    assert!(segs.size.width < px(68.), "{segs:?}");
    // its word cut: the tooltip shows
    hover(w, "factory-node-card:1263");
    assert!(w.cx.debug_bounds("tooltip").is_some(), "the tooltip shows");
}

fn long_board_note(t: &mut Value) {
    let long = "Board not read · Azure DevOps cannot be reached at 127.0.0.1:18922: Unable to \
                connect. Is the computer able to access the url?";
    let text = t.to_string().replace("/cart▏", long);
    *t = serde_json::from_str(&text).unwrap();
}

fn board_note_cut(w: &mut Win) {
    // cut with an ellipsis inside the header, never past its edge
    let head = node(w, "board-head");
    let note = at(w, "factory-BoardNote");
    assert!(note.right() <= head.right(), "{note:?} in {head:?}");
    assert!(note.size.width > px(40.), "{note:?}: some of it shows");
    // the pointer on it: the whole text, wrapped at the tooltip's widest, below the header
    let note = hover(w, "factory-BoardNote");
    let tip = w.bounds("tooltip");
    assert!(tip.top() >= note.bottom(), "{tip:?} below {note:?}");
    assert!(tip.size.width <= px(480.), "{tip:?}");
    assert!(tip.size.height > px(30.), "{tip:?}: wrapped, every word");
}

fn board_note_fits(w: &mut Win) {
    hover(w, "factory-BoardNote");
    assert!(w.cx.debug_bounds("tooltip").is_none(), "no tooltip");
}

// --- Chat's cards, in the column as Chat holds them ---

/// A contract tree in a `width` px column at the window's right.
fn column(tree: Value, width: f32) -> Value {
    json!({
        "kind": "Stack",
        "props": { "direction": "row", "sizes": [{ "flex": 1 }, { "fixed": width }], "align": "stretch" },
        "children": [{ "kind": "Island", "props": {}, "children": [] }, tree],
    })
}

/// The contract tree `rel` in a 420 px column, its QuestionCard changed by `edit`.
fn card_in_column(w: &mut Win, rel: &str, rev: u64, edit: impl FnOnce(&mut Value)) {
    let mut tree = tree_of(rel);
    if let Some(card) = find_kind(&mut tree, "QuestionCard") {
        edit(card);
    }
    show(w, column(tree, 420.), rev);
}

fn question_card(w: &mut Win) {
    card_in_column(w, "trees/cards-question.json", 1, |_| {});
    // inside the column, after the agent's words; option rows 30 px, one under the other
    let col = node(w, "cards:question");
    let card = node(w, "card:q-1");
    let prose = node(w, "cards:prose");
    assert_eq!(col.size.width, px(420.));
    assert!(
        card.left() >= col.left() && card.right() <= col.right(),
        "{card:?} in {col:?}"
    );
    assert!(prose.bottom() <= card.top());
    let one = node(w, "card:q-1:1");
    let two = node(w, "card:q-1:2");
    let own = node(w, "card:q-1:own");
    assert_eq!(one.size.height, px(30.));
    assert_eq!(two.top(), one.bottom());
    assert_eq!(own.size.height, px(30.));
    assert!(own.bottom() < card.bottom(), "{own:?} {card:?}");
    // padding 10 / 12, the 1 px edge
    assert_eq!(one.left() - card.left(), px(1. + 12.));
}

fn multi_card(w: &mut Win) {
    card_in_column(w, "trees/cards-multi.json", 1, |_| {});
    // a box before each label, the ticked ones ticked; the rows as tall as a single choice's
    assert_eq!(w.drawn("CardOptionBox").len(), 3);
    assert_eq!(
        w.drawn("CardOptionTicked"),
        ["The existing market table", "Keep the current behaviour"]
    );
    assert_eq!(node(w, "card:q-4:1").size.height, px(30.));
}

fn answered_card(w: &mut Win) {
    card_in_column(w, "trees/cards-answered.json", 1, |_| {});
    assert_eq!(node(w, "answered:q-1").size.height, px(24.));
}

fn deferred_pill(w: &mut Win) {
    card_in_column(w, "trees/cards-deferred.json", 1, |_| {});
    // pinned at the bottom of the column, over the composer's place
    let pill = node(w, "cards:pill");
    let col = node(w, "cards:deferred");
    assert!(pill.right() <= col.right());
    assert!(col.bottom() - pill.bottom() < px(40.), "{pill:?} {col:?}");
}

fn grill_round(w: &mut Win) {
    card_in_column(w, "trees/cards-grill.json", 1, |_| {});
    // one question at a time: the current one with its place, the others not drawn
    let q2 = node(w, "card:q-7.2");
    assert!(maybe(w, "factory-node-card:q-7.1:line").is_none());
    assert!(maybe(w, "factory-node-card:q-7.3").is_none());
    assert_eq!(w.drawn("CardStack"), ["2 of 3"]);
    assert!(node(w, "round:q-7").bottom() >= q2.bottom());
    // the round's dots are the ones the bridge sends, never worked out from its cards
    let mut tree = tree_of("trees/cards-grill.json");
    find_kind(&mut tree, "GrillRound").unwrap()["props"]["dots"] = json!(["done", "todo", "now"]);
    show(w, column(tree, 420.), 2);
    assert_eq!(w.drawn("GrillDots"), ["done todo now"]);
}

fn own_words(w: &mut Win) {
    card_in_column(w, "trees/cards-own.json", 1, |_| {});
    // one line: the field's 28 px, its caret drawn
    assert_eq!(at(w, "factory-card-field").size.height, px(28.));
    assert_eq!(w.drawn("CardCaret").len(), 1);
}

fn long_own_words(w: &mut Win) {
    // a long answer wraps in its field, which grows to show all of it, inside the card
    let long = "The product list, by price low to high. Keep it tiny; no PR needed, stop after \
                deciding, and tell me what you picked.";
    let text = column(tree_of("trees/cards-own.json"), 420.)
        .to_string()
        .replace(
            "\"typing\":\"Use the market table\"",
            &format!("\"typing\":\"{long}\""),
        );
    assert!(text.contains(long));
    show(w, serde_json::from_str(&text).unwrap(), 1);
    let field = at(w, "factory-card-field");
    let words = at(w, "factory-card-field-text");
    assert!(field.size.height > px(28.), "grown: {field:?}");
    assert!(
        words.size.height >= px(2. * 18.),
        "two lines or more: {words:?}"
    );
    assert!(
        within(words, field),
        "all of it shown: {words:?} in {field:?}"
    );
    let card = node(w, "card:q-1");
    assert!(field.right() <= card.right() && field.bottom() <= card.bottom());
}

fn override_card(w: &mut Win) {
    card_in_column(w, "trees/cards-override.json", 1, |_| {});
    assert_eq!(at(w, "factory-override-field").size.height, px(30.));
}

fn cards_gallery_320(w: &mut Win) {
    show(w, column(tree_of("trees/cards-gallery.json"), 320.), 1);
    // nothing wider than the column
    let col = node(w, "cards:gallery");
    for id in ["gallery:card", "gallery:waiting", "gallery:override"] {
        let b = node(w, id);
        assert!(
            b.left() >= col.left() && b.right() <= col.right(),
            "{id}: {b:?} in {col:?}"
        );
    }
}

const LONG: &str = "Should sign-in by email send a one-time magic link, or ask for a password the \
                    visitor sets on first sign-in? The story says \"sign in with email\" and the \
                    comments disagree.";

fn long_card_titles(w: &mut Win) {
    // a run's Needs you title (its reason) wraps, and so does a question's: all of it shown
    let long = "No stock source: the product API has no stock field, the story names none, and the \
                markets table has nothing either, so the run cannot pick one for you";
    card_in_column(w, "trees/cards-needs-you.json", 1, |c| {
        c["props"]["title"] = json!(long)
    });
    let wrapped = node(w, "card:needs-you:demo-shop-2-1");
    card_in_column(w, "trees/cards-needs-you.json", 2, |c| {
        c["props"]["title"] = json!("No stock source")
    });
    let short = node(w, "card:needs-you:demo-shop-2-1");
    assert!(
        wrapped.size.height >= short.size.height + px(16.),
        "{wrapped:?} {short:?}"
    );
    card_in_column(w, "trees/cards-question.json", 3, |_| {});
    let one = node(w, "card:q-1");
    card_in_column(w, "trees/cards-question.json", 4, |c| {
        c["props"]["title"] = json!(LONG)
    });
    let whole = node(w, "card:q-1");
    assert!(
        whole.size.height >= one.size.height + px(2. * 16.),
        "three lines: {whole:?} {one:?}"
    );
}

fn option_description(w: &mut Win) {
    // an option's description, under its label and wrapped: its row grows, the rest stay 30 px
    let note = "No password to store; the email service already sends transactional mail, so this \
                is the smallest change.";
    card_in_column(w, "trees/cards-question.json", 1, |c| {
        c["props"]["options"][0]["note"] = json!(note)
    });
    let one = node(w, "card:q-1:1");
    let two = node(w, "card:q-1:2");
    let card = node(w, "card:q-1");
    assert!(one.size.height >= px(30. + 2. * 16.), "{one:?}");
    assert_eq!(two.top(), one.bottom());
    assert_eq!(two.size.height, px(30.));
    assert!(one.right() <= card.right(), "{one:?} {card:?}");
}

fn question_context(w: &mut Win) {
    let context = "The story says \"sign in with email\" and the comments disagree.\nMagic links \
                   need no password store; a password needs a reset flow first.";
    card_in_column(w, "trees/cards-question.json", 1, |c| {
        c["props"]["more"] = json!(context)
    });
    // folded: one 16 px line under the title, the context not drawn
    let line = node(w, "card:q-1:more");
    assert_eq!(line.size.height, px(16.));
    assert!(maybe(w, "factory-card-more-text").is_none());
    let one = node(w, "card:q-1:1");
    assert!(line.bottom() <= one.top());
    // unfolded: the text under it, every paragraph, the rows below it
    card_in_column(w, "trees/cards-question.json", 2, |c| {
        c["props"]["more"] = json!(context);
        c["props"]["moreOpen"] = json!(true);
    });
    let text = at(w, "factory-card-more-text");
    assert!(text.size.height >= px(2. * 16.), "{text:?}");
    assert!(text.bottom() <= node(w, "card:q-1:1").top());
    // the selection moved to row 2: no row moves or changes height
    card_in_column(w, "trees/cards-question.json", 3, |_| {});
    let rows = |w: &mut Win| ["card:q-1:1", "card:q-1:2", "card:q-1:own"].map(|id| node(w, id));
    let before = rows(w);
    card_in_column(w, "trees/cards-question.json", 4, |c| {
        c["props"]["selected"] = json!(2)
    });
    assert_eq!(rows(w), before);
}

fn long_pill(w: &mut Win) {
    // the pill above the composer, as Chat places it (a padded row whose one child takes the
    // room), stays inside the column with a long question, cut with `…`
    let pill = json!({
        "kind": "Stack",
        "props": { "direction": "row", "pad": [4, 12, 4, 12], "sizes": [{ "flex": 1 }] },
        "children": [{ "kind": "DeferredPill", "id": "cards:pill", "props": { "count": 1, "text": LONG } }],
    });
    let island = json!({
        "kind": "Island", "id": "cards:foot", "props": {},
        "children": [{
            "kind": "Stack",
            "props": { "direction": "column", "sizes": [{ "flex": 1 }, "auto"] },
            "children": [{ "kind": "Stack", "props": { "direction": "column" }, "children": [] }, pill],
        }],
    });
    show(w, column(island, 420.), 1);
    let pill = node(w, "cards:pill");
    let col = node(w, "cards:foot");
    assert!(pill.right() <= col.right() - px(12.), "{pill:?} in {col:?}");
}

fn long_permission(w: &mut Win) {
    // a permission's long command stays inside the card, cut with `…`
    let cmd = "curl -s https://api.payments.example/v1/charges -d amount=100 -d currency=sek -d \
               source=tok_visa";
    card_in_column(w, "trees/cards-permission.json", 1, |c| {
        c["props"]["title"] = json!(format!("Allow Bash: {cmd}?"));
        c["props"]["mono"] = json!(cmd);
    });
    let mono = at(w, "factory-card-mono");
    let card = node(w, "card:p-1");
    assert!(mono.right() <= card.right(), "{mono:?} {card:?}");
}

// --- tables ---

fn sessions_table(w: &mut Win) {
    // 30 px rows under a 28 px header
    let (a, b) = (node(w, "session:s1"), node(w, "session:s2"));
    assert_eq!(a.size.height, px(30.));
    assert_eq!(b.top(), a.bottom());
    let table = node(w, "sessions-table");
    assert_eq!(a.top() - table.top(), px(28.));
}

fn sessions_filter_note(w: &mut Win) {
    // the note is the key line's, at its right end: under the header and its one row, never
    // over the column labels
    let (note, head) = (at(w, "factory-table-note"), at(w, "factory-table-head"));
    assert!(
        note.top() >= head.bottom() + px(30.),
        "{note:?} under {head:?}"
    );
    assert!(
        note.right() <= head.right() && note.left() > head.center().x,
        "{note:?} in {head:?}"
    );
}

fn boxes_table(w: &mut Win) {
    // a row with one cell spans the columns: the note's words run past the first column's 140 px
    let note = w.sel("TableRow", "Box sessions not read: AWS login expired");
    let row = w.bounds(note);
    let cell = node(w, "boxes-table-note-4-cell-0");
    assert!(
        cell.size.width > px(140.) && cell.right() <= row.right(),
        "{cell:?} in {row:?}"
    );
    // Cost is right-aligned: its words end at its column's end, past Up's
    let up = node(w, "box:demo-shop-1-cell-4");
    let cost = node(w, "box:demo-shop-1-cell-5");
    assert!(cost.left() > up.right(), "{up:?} {cost:?}");
}

fn empty_table_room(w: &mut Win) {
    // room: centred in the rows' place, under the header
    let head = at(w, "factory-table-head");
    let body = at(w, "factory-table-empty");
    let title = at(w, "factory-table-empty-title");
    assert!(
        title.top() > head.bottom() + px(20.),
        "{title:?} under {head:?}"
    );
    let (above, below) = (title.top() - body.top(), body.bottom() - title.bottom());
    assert!(
        above > px(40.) && below > px(40.),
        "{above:?} above, {below:?} below"
    );
}

fn empty_table_short(w: &mut Win) {
    // too short for it: from the body's top, never over the column labels
    let head = at(w, "factory-table-head");
    let title = at(w, "factory-table-empty-title");
    assert!(title.top() >= head.bottom(), "{title:?} under {head:?}");
}

// --- Pipelines ---

fn pipelines_overview(w: &mut Win) {
    // the runs' Table, the selected run's summary beside it
    let (table, summary) = (node(w, "pipelines-table"), at(w, "pipelines-summary"));
    assert!(table.right() <= summary.left(), "{table:?} {summary:?}");
}

fn pipelines_narrow_headers(w: &mut Win) {
    // the columns the pane holds whole (Agent and Duration gone), their headers on one line
    // inside the header row, in their columns' order, inside the Table; a row's cells under them
    let table = node(w, "pipelines-table");
    let heads = at(w, "factory-table-head");
    assert!(maybe(w, "factory-table-head-5").is_none());
    let mut left = heads.left();
    for i in 0..5 {
        let h = at(w, &format!("factory-table-head-{i}"));
        assert!(
            h.top() >= heads.top() && h.bottom() <= heads.bottom(),
            "{i}: one line inside the header row {h:?} {heads:?}"
        );
        assert!(h.left() >= left, "{i}: in the columns' order");
        assert!(h.right() <= table.right(), "{i}: inside the Table");
        left = h.left();
    }
    // a start column's words begin where its header does, an end column's end where it does
    for i in [0, 3, 4] {
        let h = at(w, &format!("factory-table-head-{i}"));
        let c = node(w, &format!("run:9003-cell-{i}"));
        let lined = if i == 4 {
            (c.right() - h.right()).abs() <= px(1.)
        } else {
            (c.left() - h.left()).abs() <= px(1.)
        };
        assert!(lined, "{i}: {c:?} under {h:?}");
    }
}

fn pipelines_graph(w: &mut Win) {
    // every dependency an elbow
    assert!(at(w, "pipelines-edge-job:90031-job:90032").size.width > px(0.));
    // columns are the dependency depth, rows the place in it
    let (install, e2e, deploy) = (
        node(w, "job:90031"),
        node(w, "job:90035"),
        node(w, "job:90036"),
    );
    assert!(install.right() < e2e.left() && e2e.right() < deploy.left());
    assert_eq!(install.top(), deploy.top());
    // the job's panel beside the graph, the run's head above
    let graph = at(w, "pipelines-graph");
    let job = at(w, "pipelines-job");
    assert!(graph.right() <= job.left(), "{graph:?} {job:?}");
    assert!(at(w, "pipelines-runhead").bottom() <= graph.top());
}

/// The legend's lines: its height less its padding, over the first mark's.
fn legend_lines(w: &mut Win) -> f32 {
    let legend = at(w, "pipelines-legend");
    let mark = at(w, "pipelines-legend-0");
    assert!(within(mark, legend), "{mark:?} {legend:?}");
    ((legend.size.height - px(16.)) / mark.size.height).round()
}

fn pipelines_legend_one_line(w: &mut Win) {
    // beside the job's panel every mark on one line, `· Skipped` too
    assert_eq!(legend_lines(w), 1.);
    let (graph, last) = (at(w, "pipelines-graph"), at(w, "pipelines-legend-6"));
    assert!(last.right() <= graph.right(), "{last:?} {graph:?}");
}

fn pipelines_legend_wraps_whole(w: &mut Win) {
    // really narrow: whole marks wrap, each inside the graph
    assert!(legend_lines(w) > 1.);
    let graph = at(w, "pipelines-graph");
    for i in 0..7 {
        let mark = at(w, &format!("pipelines-legend-{i}"));
        assert!(within(mark, graph), "{i}: {mark:?} {graph:?}");
    }
}

fn pipelines_log(w: &mut Win) {
    // the job's panel at the left, the log at the right, its lines in order inside it
    let (job, log) = (at(w, "pipelines-job"), at(w, "pipelines-log"));
    assert!(job.right() <= log.left(), "{job:?} {log:?}");
    let first = at(w, "pipelines-log-line-1");
    let last = at(w, "pipelines-log-line-8");
    assert!(first.top() < last.top());
    assert!(at(w, "pipeline-log-lines").contains(&first.center()));
}

/// The graph fixture with `selected` the selected box, as tree `rev`.
fn graph_on(w: &mut Win, selected: &str, rev: u64) {
    let mut tree = tree_of("trees/pipelines-graph.json");
    find_kind(&mut tree, "RunGraph").unwrap()["props"]["selected"] = json!(selected);
    show(w, tree, rev);
}

fn pipelines_graph_short(w: &mut Win) {
    // the third row starts below the graph's room
    graph_on(w, "job:90031", 1);
    let room = at(w, "pipelines-graph");
    assert!(
        !within(node(w, "job:90034"), room),
        "build is below the fold at first"
    );
    // the selection on build (row 3): scrolled into view; back on install: scrolled back
    graph_on(w, "job:90034", 2);
    let build = node(w, "job:90034");
    assert!(within(build, at(w, "pipelines-graph")), "{build:?}");
    graph_on(w, "job:90031", 3);
    let install = node(w, "job:90031");
    assert!(within(install, at(w, "pipelines-graph")), "{install:?}");
    // opened on a box below the fold: in view once laid out
    let mut fresh = Win::open_sized(None, 1400., 240.);
    graph_on(&mut fresh, "job:90034", 1);
    let build = node(&mut fresh, "job:90034");
    assert!(
        within(build, at(&mut fresh, "pipelines-graph")),
        "{build:?}"
    );
}

fn pipelines_graph_narrow(w: &mut Win) {
    // the last column comes into view sideways
    graph_on(w, "job:90031", 1);
    let canvas = at(w, "pipelines-graph-canvas");
    assert!(!within(node(w, "job:90036"), canvas));
    graph_on(w, "job:90036", 2);
    let deploy = node(w, "job:90036");
    let canvas = at(w, "pipelines-graph-canvas");
    assert!(
        deploy.left() >= canvas.left() && deploy.right() <= canvas.right(),
        "{deploy:?} in {canvas:?}"
    );
}

// --- the install's strip, local mode ---

/// The strip under the header, over the transcript and as wide; its one line 24 high, every
/// chip on it; what unfolded right under the line, inside the strip. Its bounds.
fn install_strip(w: &mut Win) -> B {
    let strip = node(w, "install-parts");
    let transcript = node(w, "chat:transcript");
    assert!(node(w, "chat-header").bottom() <= strip.top(), "{strip:?}");
    assert!(
        strip.bottom() <= transcript.top(),
        "{strip:?} over {transcript:?}"
    );
    assert_eq!(
        (strip.left(), strip.right()),
        (transcript.left(), transcript.right())
    );
    let line = at(w, "install-line");
    assert_eq!(line.size.height, px(24.));
    for part in ["logins", "board", "sources", "env-files", "checks", "done"] {
        let chip = at(w, &format!("install-part-{part}"));
        assert!(within(chip, line), "{part} {chip:?} in {line:?}");
    }
    assert!(within(at(w, "install-files"), line));
    let under = at(w, "install-unfolded");
    assert!(
        line.bottom() <= under.top() && within(under, strip),
        "{under:?}"
    );
    under
}

fn install_strip_part(w: &mut Win) {
    // the part's line and its buttons inside what unfolded; the line wrapped past the name
    let under = install_strip(w);
    let line = at(w, "install-unfolded-line");
    assert!(within(line, under), "{line:?} in {under:?}");
    assert!(line.size.height > px(20.), "{line:?}");
    assert_eq!(w.drawn("InstallAction"), ["Re-check", "Do again"]);
}

fn install_strip_files(w: &mut Win) {
    // each file a row of its own, one under the other
    let under = install_strip(w);
    let rows: Vec<B> = (0..5)
        .map(|n| at(w, &format!("install-file-{n}")))
        .collect();
    for (n, row) in rows.iter().enumerate() {
        assert!(within(*row, under), "file {n} {row:?} in {under:?}");
    }
    assert!(rows.windows(2).all(|r| r[0].bottom() <= r[1].top()));
    assert_eq!(
        w.drawn("InstallFile")[2],
        ".claude/skills/demo-shop-testing/SKILL.md"
    );
}

fn local_gallery(w: &mut Win) {
    // the dashed outline lies on the card's border, the band is 30 high, the wide pick 820
    let card = node(w, "card:1240");
    assert_eq!(at(w, "factory-card-local-1240"), card);
    assert_eq!(node(w, "local-band").size.height, px(30.));
    assert_eq!(at(w, "factory-pick").size.width, px(820.));
}

// --- Settings ---

fn settings_dialog(w: &mut Win) {
    // 1040 × 700, centred
    let b = at(w, "factory-settings");
    assert_eq!((b.size.width, b.size.height), (px(1040.), px(700.)));
    assert_eq!((b.origin.x, b.origin.y), (px(200.), px(100.)), "centred");
    // tree rows are 24 px, the tree 240 wide
    let tree = node(w, "settings:tree:appearance");
    assert_eq!(tree.size.height, px(24.));
    assert!(tree.right() <= b.origin.x + px(240.), "{tree:?}");
    // a row is 28 px at least, the focused one inside the page
    let row = node(w, "settings:line:7");
    assert!(row.size.height >= px(28.), "{row:?}");
    assert!(b.contains(&row.center()));
    // compact: an unfocused row is its one line, label and control; the focused one has its
    // source line (scope, source, Reset, hint) dim beneath
    for line in ["settings:line:0", "settings:line:4", "settings:line:5"] {
        assert_eq!(node(w, line).size.height, px(28.), "{line}");
    }
    assert!(row.size.height > px(28.), "{row:?}");
    let scope = at(w, "factory-settings-scope:Chat column open by default");
    assert!(
        scope.top() >= row.top() + px(24.),
        "{scope:?} under {row:?}"
    );
    assert!(maybe(w, "factory-settings-scope:UI font size").is_none());
    assert!(maybe(w, "factory-settings-help:Theme").is_none());
    // the footer: Close alone (each change saves at once), 52 high inside the 1 px border
    assert!(maybe(w, "button-factory-settings:close").is_some());
    assert!(maybe(w, "button-factory-settings:ok").is_none());
    assert!(maybe(w, "button-factory-settings:cancel").is_none());
    let foot = at(w, "factory-settings-footer");
    assert_eq!(foot.size.height, px(52.));
    assert_eq!(foot.bottom(), b.bottom() - px(1.), "inside the 1 px border");
}

fn settings_page_scrolls(w: &mut Win) {
    // Agents & models runs past the footer: a thumb says there is more, the wheel brings it
    let foot = at(w, "factory-settings-footer");
    let prod = node(w, "settings:line:15");
    assert!(prod.top() >= foot.top(), "{prod:?} already above {foot:?}");
    assert_eq!(w.drawn("SettingsPageThumb").len(), 1);
    let page = at(w, "factory-settings-page");
    w.cx.simulate_event(gpui_kit::ScrollWheelEvent {
        position: page.center(),
        delta: gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.), px(-2000.))),
        modifiers: Modifiers::default(),
        touch_phase: gpui_kit::TouchPhase::Moved,
    });
    w.cx.run_until_parked();
    let prod = node(w, "settings:line:15");
    assert!(prod.bottom() <= foot.top(), "{prod:?} under {foot:?}");
}

fn settings_tallest_tree(w: &mut Win) {
    // the tallest tree fits 700 with its last node whole above the footer
    let b = at(w, "factory-settings");
    assert_eq!(b.size.height, px(700.));
    assert_eq!(b.origin.y, px((900. - 700.) / 2.), "centred");
    let tools = node(w, "settings:tree:tools");
    let foot = at(w, "factory-settings-footer");
    assert!(tools.bottom() <= foot.top(), "{tools:?} under {foot:?}");
    assert!(w.drawn("SettingsTreeThumb").is_empty());
}

fn settings_short_window(w: &mut Win) {
    // a window too short for 700 keeps what fits and shows the tree's thumb from the first frame
    assert!(at(w, "factory-settings").size.height < px(700.));
    assert_eq!(w.drawn("SettingsTreeThumb").len(), 1);
    let thumb = at(w, "factory-settings-tree-thumb");
    assert!(thumb.size.height >= px(24.), "{thumb:?}");
}

/// The problems tree grown to `total` nodes (copies of its last, `settings:tree:more-<n>`).
fn taller_tree(t: &mut Value, total: usize) {
    let nodes = find_kind(t, "SettingsTree").expect("the tree")["props"]["nodes"]
        .as_array_mut()
        .expect("its nodes");
    let last = nodes.last().cloned().expect("a node");
    for n in 0..total.saturating_sub(nodes.len()) {
        let mut node = last.clone();
        node["id"] = json!(format!("settings:tree:more-{n}"));
        node["label"] = json!(format!("More {n}"));
        nodes.push(node);
    }
}

fn tree_of_24(t: &mut Value) {
    taller_tree(t, 24);
}

fn tree_of_25(t: &mut Value) {
    taller_tree(t, 25);
}

/// The last node of the grown tree.
fn last_tree_node(w: &mut Win) -> B {
    let mut tree = tree_of("trees/settings-problems.json");
    let have = find_kind(&mut tree, "SettingsTree").unwrap()["props"]["nodes"]
        .as_array()
        .unwrap()
        .len();
    node(w, &format!("settings:tree:more-{}", 24 - have - 1))
}

fn settings_24_nodes(w: &mut Win) {
    // a tree taller than 700's room grows the dialog until its last node shows whole above the
    // footer: 32 title + 44 search + 2 + 24 × 24 rows + 9 separator + 8 + 52 footer + the border
    let b = at(w, "factory-settings");
    assert_eq!(b.size.height, px(725.));
    assert_eq!(b.origin.y, px((900. - 725.) / 2.), "centred");
    let last = last_tree_node(w);
    let foot = at(w, "factory-settings-footer");
    assert!(last.bottom() <= foot.top(), "{last:?} under {foot:?}");
    assert!(w.drawn("SettingsTreeThumb").is_empty());
}

fn settings_25_nodes(w: &mut Win) {
    // past 900's room (740): the tree scrolls with its thumb
    assert_eq!(at(w, "factory-settings").size.height, px(740.));
    assert_eq!(w.drawn("SettingsTreeThumb").len(), 1);
}

fn settings_24_nodes_short(w: &mut Win) {
    // a window too short to grow it: 700, the tree's thumb
    assert_eq!(at(w, "factory-settings").size.height, px(700.));
    assert_eq!(w.drawn("SettingsTreeThumb").len(), 1);
}

fn last_node_selected(t: &mut Value) {
    let nodes = find_kind(t, "SettingsTree").unwrap()["props"]["nodes"]
        .as_array_mut()
        .unwrap();
    for n in nodes.iter_mut() {
        n["selected"] = json!(false);
    }
    nodes.last_mut().unwrap()["selected"] = json!(true);
}

fn settings_tree_selected_in_view(w: &mut Win) {
    // the scroll applies on the next frame
    w.cx.update(|window, _| window.refresh());
    w.cx.run_until_parked();
    let tools = node(w, "settings:tree:tools");
    let foot = at(w, "factory-settings-footer");
    assert!(tools.bottom() <= foot.top(), "{tools:?} above {foot:?}");
}

fn settings_search_hit(w: &mut Win) {
    // a page picked while searching marks its hit
    w.layer(Some("trees/settings-search-page.json"), 1);
    let hit = at(w, "factory-settings-hit");
    assert!(hit.size.width > px(0.), "{hit:?}");
    // ⌘A: the search's text on the selection, inside the field
    w.layer(Some("trees/settings-select-all.json"), 2);
    let sel = at(w, "factory-settings-selection");
    let field = at(w, "factory-settings-search");
    assert!(
        sel.size.width > px(0.) && field.contains(&sel.origin),
        "{sel:?} in {field:?}"
    );
}

fn settings_combo_list(w: &mut Win) {
    let list = at(w, "factory-settings-combo-list");
    let dialog = at(w, "factory-settings");
    assert!(dialog.contains(&list.origin), "{list:?} in {dialog:?}");
}

fn settings_list_editor(w: &mut Win) {
    // the editor in the dialog, an item's line in it, its toolbar (+ − ↑ ↓) under the last
    let list = at(w, "factory-settings-list");
    assert!(at(w, "factory-settings").contains(&list.center()));
    assert_eq!(list.size.width, px(360.));
    let first = at(w, "factory-settings-item:0");
    assert!(list.contains(&first.center()), "{first:?} in {list:?}");
    let bar = at(w, "factory-settings-list-bar");
    let last = at(w, "factory-settings-item:4");
    assert!(list.contains(&bar.center()) && bar.origin.y > last.origin.y);
    let remove = at(w, "factory-settings-button:settings:item-remove:4");
    assert!(bar.contains(&remove.center()));
    assert_eq!(w.drawn("SettingItem")[..2], ["*.test.*", "*.spec.*"]);
    // a new item typed in place: its field after the last item, the caret in it
    w.layer(Some("trees/settings-list-add.json"), 2);
    let field = at(w, "factory-settings-list-field");
    let caret = at(w, "factory-settings-caret");
    assert!(field.contains(&caret.center()), "{caret:?} in {field:?}");
    assert!(field.origin.y > at(w, "factory-settings-item:3").origin.y);
}

fn settings_path_field(w: &mut Win) {
    let field = at(w, "factory-settings-field:Your az login folder");
    assert_eq!(field.size.width, px(360.));
    let browse = at(w, "factory-settings-button:settings:browse:7");
    assert!(field.contains(&browse.center()), "{browse:?} in {field:?}");
}

fn settings_secret_field(w: &mut Win) {
    let field = at(w, "factory-settings-field:Box owner");
    assert_eq!(field.size.width, px(240.));
    assert!(w.drawn("SettingValue").contains(&"•••••••".to_owned()));
    assert!(
        !w.drawn("SettingValue")
            .iter()
            .any(|v| v.contains("hunter2"))
    );
}

fn settings_advanced_field(w: &mut Win) {
    let field = at(w, "factory-settings-field:View tweaks");
    let tag = at(w, "factory-settings-advanced");
    assert!(tag.contains(&field.center()));
    assert_eq!(w.drawn("SettingTag"), ["Advanced"]);
    assert_eq!(w.drawn("SettingError").len(), 1);
}

fn settings_scope_reset(w: &mut Win) {
    let label = "Chat column open by default";
    let scope = at(w, &format!("factory-settings-scope:{label}"));
    let reset = at(w, &format!("factory-settings-reset:{label}"));
    // one line: the scope at its start, Reset toward its end
    assert!((scope.center().y - reset.center().y).abs() < px(2.));
    assert!(reset.origin.x > scope.origin.x + px(200.));
    assert!(at(w, "factory-settings").contains(&reset.center()));
}

fn settings_propose(w: &mut Win) {
    // 480 wide inside the dialog, the caret in the reason it focuses
    let popup = node(w, "settings:propose");
    let dialog = at(w, "factory-settings");
    assert_eq!(popup.size.width, px(480.));
    assert!(dialog.contains(&popup.center()), "{popup:?} in {dialog:?}");
    let reason = at(w, "factory-settings-propose-reason");
    let caret = at(w, "factory-settings-caret");
    assert!(reason.contains(&caret.center()), "{caret:?} in {reason:?}");
}

fn settings_asks(w: &mut Win) {
    // the Override's reason field, serve down's Retry
    w.layer(Some("trees/settings-reason.json"), 1);
    assert!(maybe(w, "factory-settings-reason").is_some());
    w.layer(Some("trees/settings-serve-down.json"), 2);
    assert!(maybe(w, "button-factory-settings:retry").is_some());
}

fn settings_records_editor(w: &mut Win) {
    // inside the dialog: its header over a line of cells per record, `+ Add` after the last
    let dialog = at(w, "factory-settings");
    let records = at(w, "factory-settings-records");
    assert!(
        dialog.contains(&records.center()),
        "{records:?} in {dialog:?}"
    );
    assert_eq!(
        w.drawn("SettingColumn"),
        ["Screen", "Part", "Does", "Value"]
    );
    let head = at(w, "factory-settings-records-head");
    let first = at(w, "factory-settings-cell:0:0");
    let second = at(w, "factory-settings-cell:1:0");
    assert!(head.bottom() <= first.top() && first.bottom() <= second.top());
    let add = at(w, "factory-settings-record-add");
    assert!(add.top() >= second.bottom(), "{add:?} after {second:?}");
    // a record's ✕ at its line's end
    let remove = at(w, "factory-settings-button:settings:record-remove:0");
    assert!(remove.left() >= at(w, "factory-settings-cell:0:3").right());
    // the cell typed in place has the caret; the reason under the row
    let cell = at(w, "factory-settings-cell:1:1");
    let caret = at(w, "factory-settings-caret");
    assert!(cell.contains(&caret.center()), "{caret:?} in {cell:?}");
    let error = at(w, "factory-settings-error:View tweaks");
    assert!(error.top() >= add.bottom(), "{error:?} under {add:?}");
    assert_eq!(w.drawn("SettingError"), ["Row 2: Part is empty"]);
}

fn settings_records_pick(w: &mut Win) {
    // the choice cell's list under it, inside the dialog
    let cell = at(w, "factory-settings-cell:1:0");
    let list = at(w, "factory-settings-combo-list");
    assert!(
        list.top() >= cell.bottom() - px(1.),
        "{list:?} under {cell:?}"
    );
    assert!(
        (list.left() - cell.left()).abs() < px(2.),
        "{list:?} at {cell:?}"
    );
    assert!(at(w, "factory-settings").contains(&list.origin));
    assert_eq!(w.drawn("ComboChoice")[..2], ["factory", "chat"]);
}

fn settings_records_closed(w: &mut Win) {
    // closed: the header and both records, no editor's `+ Add` nor ✕
    let page = at(w, "factory-settings-page");
    let records = at(w, "factory-settings-records");
    assert!(page.contains(&records.center()), "{records:?} in {page:?}");
    assert_eq!(w.drawn("SettingColumn").len(), 6);
    assert!(maybe(w, "factory-settings-record-add").is_none());
    assert!(maybe(w, "factory-settings-button:settings:record-remove:0").is_none());
    for r in 0..2 {
        for c in 0..6 {
            let cell = at(w, &format!("factory-settings-cell:{r}:{c}"));
            assert!(records.contains(&cell.center()), "{r}:{c} {cell:?}");
        }
    }
    // each field's share of the width: Name 2, AWS account 3
    let name = at(w, "factory-settings-cell:0:0").size.width.as_f32();
    let account = at(w, "factory-settings-cell:0:1").size.width.as_f32();
    assert!((account / name - 1.5).abs() < 0.15, "{name} {account}");
    // the records fill the row's value column, past a 360 field
    assert!(records.size.width > px(400.), "{records:?}");
}

fn settings_combo_account(w: &mut Win) {
    let list = at(w, "factory-settings-combo-list");
    assert!(at(w, "factory-settings").contains(&list.origin));
    assert_eq!(
        w.drawn("ComboChoice"),
        ["demo-dev", "demo-tooling", "Use “demo”"]
    );
    assert_eq!(w.drawn("ComboCursor"), ["demo-dev"]);
}

fn settings_refused(w: &mut Win) {
    // the reason in bad under the row's line, inside the dialog
    let label = at(w, "factory-settings-label:AWS region");
    let error = at(w, "factory-settings-error:AWS region");
    assert!(error.top() >= label.bottom(), "{error:?} under {label:?}");
    assert!(at(w, "factory-settings").contains(&error.center()));
    assert_eq!(w.drawn("SettingError"), ["an AWS region, like eu-west-1"]);
}

fn settings_saved(w: &mut Win) {
    // saved at once: Undo beside Close in the footer, no OK or Cancel; the row says it is yours
    let foot = at(w, "factory-settings-footer");
    let undo = at(w, "button-factory-settings:undo");
    let close = at(w, "button-factory-settings:close");
    assert!(foot.contains(&undo.center()) && foot.contains(&close.center()));
    assert!(undo.right() <= close.left());
    assert!(maybe(w, "button-factory-settings:ok").is_none());
    assert!(maybe(w, "button-factory-settings:cancel").is_none());
    assert_eq!(w.drawn("SettingChanged"), ["Chat column open by default"]);
    assert!(
        w.drawn("SettingSource")
            .contains(&"yours · saved".to_owned())
    );
    assert!(
        w.drawn("SettingsNote")
            .iter()
            .any(|n| n.starts_with("Saved Chat column open by default"))
    );
}

fn settings_fix_strip(w: &mut Win) {
    let strip = node(w, "settings:fix");
    assert!(at(w, "factory-settings").contains(&strip.center()));
}

fn long_check_state(t: &mut Value) {
    let row = find_kind(t, "CheckRow").expect("a check row");
    row["props"]["state"] = json!({
        "text": format!("⚠ can't check: claude auth status failed: Do you trust the files in this folder? {}", "x".repeat(300)),
        "tone": "warn",
    });
}

fn settings_long_check_state(w: &mut Win) {
    // a long state ends inside the page, the check keeps its room
    let page = at(w, "factory-settings-page");
    let state = at(w, "factory-settings-check-state:GitHub");
    assert!(state.right() <= page.right(), "{state:?} past {page:?}");
    let check = at(w, "factory-settings-check:GitHub");
    assert!(check.size.width >= px(80.), "the check squeezed: {check:?}");
}

/// A Color scheme page: a plain group, two tight token groups (their folded heads), a plain group.
fn tight_groups(t: &mut Value) {
    let page = find_kind(t, "SettingsPage").expect("the page");
    let row = |id: &str, label: &str| {
        json!({"kind": "SettingRow", "id": id, "props": {
            "label": label, "control": {"kind": "value", "text": "125 tokens"}, "source": {"text": ""},
        }})
    };
    let group = |id: &str, tight: bool, kid: Value| json!({"kind": "SettingsGroup", "id": id, "props": {"tight": tight}, "children": [kid]});
    page["props"]["reveal"] = Value::Null;
    page["children"] = json!([
        group("g:scheme", false, row("r:scheme", "Scheme")),
        group("g:chrome", true, row("r:chrome", "▸ Chrome")),
        group("g:editor", true, row("r:editor", "▸ Editor")),
        group("g:after", false, row("r:after", "After")),
    ]);
}

fn settings_tight_groups(w: &mut Win) {
    // tight groups a row apart; a plain group keeps its 1 px rule and its padding
    let chrome = node(w, "r:chrome");
    let editor = node(w, "r:editor");
    assert_eq!(editor.top() - chrome.top(), chrome.size.height);
    let after = node(w, "r:after");
    assert_eq!(after.top() - editor.bottom(), px(1. + 8.));
}

fn settings_profiles(w: &mut Win) {
    // a table inside the page: header 28, four rows of 30, the key line 24
    let table = node(w, "settings:profiles");
    let dialog = at(w, "factory-settings");
    assert!(dialog.contains(&table.origin), "{table:?} in {dialog:?}");
    assert_eq!(table.size.height, px(28. + 4. * 30. + 24.));
    // each profile's Open button at its row's right end, inside the table
    let open = node(w, "settings:open:0");
    let row = node(w, "settings:line:0");
    assert!(within(open, row), "{open:?} in {row:?}");
    assert!(
        open.right() > row.right() - px(80.),
        "{open:?} at the end of {row:?}"
    );
    assert_eq!(
        w.drawn("TableButton"),
        ["settings:open:0", "settings:open:1"]
    );
}

/// Whether some quad was painted in `hex`.
fn painted(w: &mut Win, hex: u32) -> bool {
    let want = vimstorm::look::hsla(vimstorm::look::hex(hex));
    w.cx.update(|window, _| {
        window
            .painted_quads()
            .into_iter()
            .any(|q| q.background.as_solid() == Some(want))
    })
}

fn settings_themes(w: &mut Win) {
    // small cells side by side in one row, inside the dialog
    let dark = at(w, "factory-theme-islands-dark");
    let light = at(w, "factory-theme-islands-light");
    let modern = at(w, "factory-theme-dark-modern");
    assert_eq!((dark.size.width, dark.size.height), (px(128.), px(80.)));
    assert!(
        dark.right() <= light.left() && light.right() <= modern.left(),
        "side by side: {dark:?} {light:?} {modern:?}"
    );
    assert_eq!(
        (dark.top(), light.top()),
        (modern.top(), modern.top()),
        "one row"
    );
    assert!(at(w, "factory-settings").contains(&light.origin));
    // each cell in its own theme's colours: Islands Light's light frame
    assert!(painted(w, 0xebecf0), "the light cell in #ebecf0");
}

fn settings_colours(w: &mut Win) {
    // the swatch, 14 px, painted in its token's own colour
    let swatch = at(w, "factory-settings-swatch");
    assert_eq!((swatch.size.width, swatch.size.height), (px(14.), px(14.)));
    assert!(painted(w, 0x5ec8c0), "the swatch in #5ec8c0");
}

/// A drawn text's width in the window's UI font at `size`.
fn text_width(w: &mut Win, text: &str, size: f32) -> f32 {
    w.cx.update(|window, _| {
        vimstorm::kit::width(window, text, vimstorm::render::ui_font(), px(size)).as_f32()
    })
}

fn labels_whole(w: &mut Win) {
    // every label on the page shows whole: the label column as wide as its longest label, never
    // under the design's 168, every control starting at one x
    let mut ends = Vec::new();
    for label in w.drawn("SettingRow").into_iter().chain(w.drawn("CheckRow")) {
        // a checkbox's label is beside its box, not in the column
        let Some(b) = maybe(w, &format!("factory-settings-label:{label}")) else {
            continue;
        };
        let need = text_width(w, &label, vimstorm::look::UI_FONT_SIZE);
        assert!(
            b.size.width.as_f32() + 0.5 >= need,
            "{label:?} has {:?} for {need}",
            b.size.width
        );
        assert!(b.size.width.as_f32() >= 168., "{label:?} {b:?}");
        ends.push((label, b.right()));
    }
    assert!(!ends.is_empty(), "no labels in the column");
    let first = ends[0].1;
    assert!(
        ends.iter().all(|(_, r)| (*r - first).abs() < px(0.5)),
        "{ends:?}"
    );
}

/// Every `SettingRow` of a tree.
fn rows_of(v: &mut Value) -> Vec<&mut Value> {
    let mut out = Vec::new();
    fn walk<'a>(v: &'a mut Value, out: &mut Vec<&'a mut Value>) {
        if v.get("kind").and_then(|k| k.as_str()) == Some("SettingRow") {
            out.push(v);
            return;
        }
        match v {
            Value::Object(m) => m.values_mut().for_each(|c| walk(c, out)),
            Value::Array(a) => a.iter_mut().for_each(|c| walk(c, out)),
            _ => {}
        }
    }
    walk(v, &mut out);
    out
}

const LONG_VALUE: &str = "8 CPUs, 32 GB (m8g.2xlarge)";

/// Every combo of a tree holding `LONG_VALUE`.
fn long_combos(v: &mut Value) {
    fn set(v: &mut Value) -> usize {
        if v.get("kind").and_then(|k| k.as_str()) == Some("combo") {
            v["value"] = json!(LONG_VALUE);
            return 1;
        }
        match v {
            Value::Object(m) => m.values_mut().map(set).sum(),
            Value::Array(a) => a.iter_mut().map(set).sum(),
            _ => 0,
        }
    }
    assert!(set(v) > 0, "a combo on the page");
}

fn settings_long_combo(w: &mut Win) {
    // a combo as wide as its value
    let value = at(w, "factory-settings-combo-value");
    let need = text_width(w, LONG_VALUE, vimstorm::look::UI_FONT_SIZE);
    assert!(
        value.size.width.as_f32() + 0.5 >= need,
        "{value:?} for {need}"
    );
}

fn settings_short_combo(w: &mut Win) {
    // a short value keeps the design's 180
    let combo = at(w, "factory-settings-combo");
    assert!((combo.size.width.as_f32() - 180.).abs() < 0.5, "{combo:?}");
}

/// Fields of three kinds: short, path, and free typed past its width.
fn fields_by_kind(t: &mut Value) {
    for r in rows_of(t) {
        let label = r["props"]["label"].as_str().unwrap_or_default().to_owned();
        let c = &mut r["props"]["control"];
        if c["kind"] != "field" {
            continue;
        }
        match label.as_str() {
            "Max boxes per person" => c["size"] = json!("short"),
            "Idle stop" => c["size"] = json!("path"),
            "Waiting on you" => {
                c["size"] = json!("free");
                c["editing"] = json!(true);
                c["text"] = json!("1234567890".repeat(6));
            }
            _ => {}
        }
    }
}

fn field(w: &mut Win, label: &str) -> B {
    at(w, &format!("factory-settings-field:{label}"))
}

fn settings_fields(w: &mut Win) {
    // as wide as what it holds (WebStorm's short 120, path 360, free 240), editing or not
    assert_eq!(field(w, "Max boxes per person").size.width, px(120.));
    assert_eq!(field(w, "Idle stop").size.width, px(360.));
    assert_eq!(
        field(w, "Waiting on you").size.width,
        px(240.),
        "editing keeps it"
    );
    // its unit after it, on its line
    let idle = field(w, "Idle stop");
    let unit = at(w, "factory-settings-unit:Idle stop");
    assert!(unit.left() >= idle.right(), "{unit:?} after {idle:?}");
    assert!(
        (unit.center().y - idle.center().y).abs() < px(1.),
        "on its line"
    );
    // every field starts 12 px past the label column's right edge
    let lefts: Vec<_> = ["Max boxes per person", "Idle stop", "Waiting on you"]
        .into_iter()
        .map(|l| field(w, l).left())
        .collect();
    assert!(lefts.iter().all(|l| *l == lefts[0]), "{lefts:?}");
    let label = at(w, "factory-settings-label:Max boxes per person");
    assert_eq!(lefts[0], label.right() + px(12.), "{label:?}");
    // the caret of a field typed past its width stays in view
    let typed = field(w, "Waiting on you");
    let caret = at(w, "factory-settings-caret");
    assert!(
        caret.left() >= typed.left() && caret.right() <= typed.right(),
        "{caret:?} in {typed:?}"
    );
}

fn settings_number_field(w: &mut Win) {
    // a number field is 72, its unit after it
    let f = field(w, "UI font size");
    assert_eq!(f.size.width, px(72.));
    let unit = at(w, "factory-settings-unit:UI font size");
    assert!(unit.left() >= f.right(), "{unit:?} after {f:?}");
}

const LONG_HELP: &str = "sets Vim mode (off under WebStorm and VS Code), the tree's keys, how \
                         tabs open and close, and when a file saves";

/// A focused row's help is never cut at 1040: under its control, wrapping to two lines at most.
/// Each row with help is focused in turn; the first gets a long one.
fn help_whole(w: &mut Win, rel: &str) {
    let mut tree = tree_of(rel);
    if let Some(r) = rows_of(&mut tree)
        .into_iter()
        .find(|r| r["props"]["help"].is_string())
    {
        r["props"]["help"] = json!(LONG_HELP);
    }
    for r in rows_of(&mut tree) {
        r["props"]["focused"] = json!(false);
    }
    let n = rows_of(&mut tree).len();
    let mut seen = 0;
    for i in 0..n {
        let mut t = tree.clone();
        let (help, label) = {
            let mut rows = rows_of(&mut t);
            let p = &mut rows[i]["props"];
            let Some(help) = p["help"].as_str().map(str::to_owned) else {
                continue;
            };
            p["focused"] = json!(true);
            (help, p["label"].as_str().unwrap_or_default().to_owned())
        };
        w.layer_tree(t, 1 + i as u64);
        let Some(b) = maybe(w, &format!("factory-settings-help:{label}")) else {
            continue;
        };
        seen += 1;
        let need = text_width(w, &help, vimstorm::look::UI_SMALL_FONT_SIZE);
        // 16 px a line
        let lines = (b.size.height.as_f32() / 16.).round();
        assert!(lines <= 2., "{label:?} {lines} lines {b:?}");
        if lines <= 1. {
            assert!(
                b.size.width.as_f32() + 0.5 >= need,
                "{label:?}'s help cut: {b:?} for {need}"
            );
        } else {
            // two lines hold it, a word's slack at the first line's end
            assert!(
                2. * b.size.width.as_f32() >= need + 40.,
                "{label:?}'s help cut: {b:?} for {need}"
            );
        }
    }
    assert!(seen > 0, "no help drawn");
}

fn help_whole_appearance(w: &mut Win) {
    help_whole(w, "trees/settings-appearance.json");
}

fn help_whole_agents(w: &mut Win) {
    help_whole(w, "trees/settings-agents.json");
}

fn help_whole_search(w: &mut Win) {
    help_whole(w, "trees/settings-search.json");
}

fn help_whole_propose(w: &mut Win) {
    help_whole(w, "trees/settings-propose.json");
}

/// Agents & models with its MCP row focused (its help drawn under it).
fn focus_mcp(t: &mut Value) {
    for r in rows_of(t) {
        let mcp = r["props"]["label"].as_str() == Some("Your MCP servers, never a repo's");
        r["props"]["focused"] = json!(mcp);
    }
}

fn help_narrow(w: &mut Win) {
    // a narrow window: the help wraps inside the page, never past its right edge
    let page = at(w, "factory-settings-page");
    let help = at(w, "factory-settings-help:Your MCP servers, never a repo's");
    assert!(help.right() <= page.right(), "{help:?} in {page:?}");
}

/// Nothing jumps but the focused row: focusing a row grows it alone (its help and source line
/// under it), the rows above keep their y and the rows under it move down by that growth alone;
/// a change being saved (its blue, its bar, `yours · saving…`, a field typed into) moves nothing.
fn rows_keep_y(w: &mut Win, rel: &str) {
    let places = |w: &mut Win, tree: &mut Value| -> Vec<(String, f32, f32)> {
        let ids: Vec<String> = rows_of(tree)
            .into_iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect();
        ids.into_iter()
            .map(|id| {
                let b = node(w, &id);
                (id, b.top().as_f32(), b.size.height.as_f32())
            })
            .collect()
    };
    let mut tree = tree_of(rel);
    for r in rows_of(&mut tree) {
        r["props"]["focused"] = json!(false);
        r["props"]["hint"] = Value::Null;
        r["props"]["changed"] = json!(false);
    }
    w.layer_tree(tree.clone(), 1);
    let before = places(w, &mut tree);
    assert!(before.len() > 2, "{before:?}");
    for i in 0..before.len() {
        let mut t = tree.clone();
        {
            let mut rows = rows_of(&mut t);
            let p = &mut rows[i]["props"];
            p["focused"] = json!(true);
            p["hint"] = json!("⏎ change for me · ⌘⏎ propose for the repo");
        }
        w.layer_tree(t.clone(), 2 + 2 * i as u64);
        let focused = places(w, &mut t);
        let grew = focused[i].2 - before[i].2;
        assert!(grew >= 0., "row {i} shrank focused");
        for (j, ((id, y, h), (_, y0, h0))) in focused.iter().zip(&before).enumerate() {
            let moved = if j > i { grew } else { 0. };
            assert!(
                (y - y0 - moved).abs() < 0.5,
                "row {i} focused: {id} at {y}, was {y0}"
            );
            if j != i {
                assert!((h - h0).abs() < 0.5, "row {i} focused: {id} {h} was {h0}");
            }
        }
        {
            let mut rows = rows_of(&mut t);
            let p = &mut rows[i]["props"];
            p["changed"] = json!(true);
            p["source"]["text"] = json!("yours · saving…");
            // a field being typed into keeps its width
            if p["control"]["kind"] == "field" {
                p["control"]["editing"] = json!(true);
                p["control"]["text"] = json!("12345678901234567890");
            }
        }
        w.layer_tree(t.clone(), 3 + 2 * i as u64);
        assert_eq!(places(w, &mut t), focused, "row {i} changed");
    }
}

fn rows_keep_y_agents(w: &mut Win) {
    rows_keep_y(w, "trees/settings-agents.json");
}

fn rows_keep_y_search_page(w: &mut Win) {
    rows_keep_y(w, "trees/settings-search-page.json");
}

fn logins_keep_y(w: &mut Win) {
    // every row drawn at once as `checking…`; a read landing fills its rows in place
    let rows = w.drawn("CheckRow");
    assert_eq!(rows.len(), 12, "{rows:?}");
    let ys = |w: &mut Win| -> Vec<(f32, f32)> {
        (0..12)
            .map(|i| {
                let b = node(w, &format!("settings:line:{i}"));
                (b.top().as_f32(), b.size.height.as_f32())
            })
            .collect()
    };
    let before = ys(w);
    w.layer(Some("trees/settings-logins-half.json"), 2);
    assert_eq!(w.drawn("CheckRow"), rows);
    assert_eq!(ys(w), before);
}
