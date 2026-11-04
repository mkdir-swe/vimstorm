//! The Log's filter bar (M3 LOG/FILTERS) on the real nvim + config, driven by real keys and
//! clicks: the "Text or hash" field (`/`, Enter, Esc, ×, `.*` / `Cc`), the Branch / User / Date /
//! Paths chips (click, ×, right-click menu, narrow widths) and their popups (b / u / d / p: "All"
//! first, the caret on the value, Esc, Tab marks several, `/` + Enter in one burst). The session
//! side is what Rust sent Lua (`config.app.git` `log_filters()`, Lua's `saved()`).
//!
//! -- lua: filter bar: Text or hash field with .* and Cc, chips Branch: HEAD ×, User, Date, Paths -> rust: bar_shows_field_toggles_chips_and_toolbar
//! -- lua: u opens the user picker: All, then you first -> rust: user_popup_filters_and_chip_x_clears
//! -- lua: user filter: chip 'User: Ada Example ×', only your commits -> rust: user_popup_filters_and_chip_x_clears
//! -- lua: after a filter picker, focus is back in the log -> rust: user_popup_filters_and_chip_x_clears
//! -- lua: click on the chip's × clears the user filter -> rust: user_popup_filters_and_chip_x_clears
//! -- lua: date filter: recent commits only, chip 'Date: Last 7 Days ×' -> rust: date_popup_and_backspace_clears
//! -- lua: Backspace clears the filters -> rust: date_popup_and_backspace_clears
//! -- lua: click next to a chip's ×: its picker opens, the filter stays -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: …the date filter is still set -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: click the Date chip's ×: date cleared at once, chip unset, no picker, other filters kept -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: click the Paths chip's ×: paths cleared, the log reloads (other files' commits back), session updated -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: right-click on a set chip: menu with Filter by User… and Clear Filter -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: menu Clear Filter clears the user filter -> rust: chip_x_clears_only_its_filter_and_chip_menu
//! -- lua: click the text field's ×: text filter cleared, placeholder back -> rust: text_field_x_clears
//! -- lua: narrow: all 4 set chips (Branch, User, Date, Paths) keep their ×, nothing cut off -> rust: narrow_bar_keeps_every_x
//! -- lua: narrow: click the last chip's × clears paths -> rust: narrow_bar_keeps_every_x
//! -- lua: text filter (/) ignores case by default -> rust: text_filter_case_and_regex_toggles
//! -- lua: click Cc: match case -> rust: text_filter_case_and_regex_toggles
//! -- lua: click .*: the text is a regex -> rust: text_filter_case_and_regex_toggles
//! -- lua: .* off: plain text again, nothing matches: log and changed files empty -> rust: text_filter_case_and_regex_toggles
//! -- lua: % in a filter value shows as typed in the filter bar -> rust: text_filter_case_and_regex_toggles
//! -- lua: branch filter: only the branch's commits, tab 'Log: factory/1237' -> rust: branch_popup_and_tab_label
//! -- lua: click on the Branch chip opens the branch picker -> rust: branch_popup_and_tab_label
//! -- lua: all branches: the tab is just 'Log' -> rust: branch_popup_and_tab_label
//! -- lua: b: caret on the branch filter (HEAD) -> rust: branch_popup_keyboard_only
//! -- lua: b, l, Enter (All): branch chip unset, tab 'Log', every branch listed, session updated -> rust: branch_popup_keyboard_only
//! -- lua: b with no branch filter: caret on All -> rust: branch_popup_keyboard_only
//! -- lua: Esc in a filter picker changes nothing -> rust: branch_popup_keyboard_only
//! -- lua: u with no user filter: caret on All -> rust: user_popup_keyboard_only
//! -- lua: u: caret on the user filter's value -> rust: user_popup_keyboard_only
//! -- lua: u, l, Enter (All): user chip unset, log reloads, session updated -> rust: user_popup_keyboard_only
//! -- lua: u: Tab picks several; All among them clears the user filter -> rust: user_popup_keyboard_only
//! -- lua: u, marcus, Enter in one burst: the first match is picked, not All -> rust: user_popup_keyboard_only
//! -- lua: d with no date filter: caret on All -> rust: date_and_paths_popups_keyboard_only
//! -- lua: d: caret on the date filter's value -> rust: date_and_paths_popups_keyboard_only
//! -- lua: d, l…, Enter (All): date chip unset, log reloads, session updated -> rust: date_and_paths_popups_keyboard_only
//! -- lua: p with no paths filter: caret on All -> rust: date_and_paths_popups_keyboard_only
//! -- lua: p: caret on the paths filter's value -> rust: date_and_paths_popups_keyboard_only
//! -- lua: p, l…, Enter (All): paths chip unset, log reloads, session updated -> rust: date_and_paths_popups_keyboard_only
//! -- lua: / with a text filter: the field opens with it selected -> rust: text_field_keys
//! -- lua: typing replaces the selected text -> rust: text_field_keys
//! -- lua: /, Backspace, Enter: text filter cleared, placeholder back, log reloads, session updated -> rust: text_field_keys
//! -- lua: /, Cmd+Backspace: the field is empty -> rust: text_field_keys
//! -- lua: …Enter on the empty field clears the text filter -> rust: text_field_keys
//! -- lua: Esc in the text field: nothing applied, the filter stays, back in the log -> rust: text_field_keys

use super::common;
use super::{date_key, log, log_label, open_log, read_log, table_focused, update_log};

use common::gitui::*;
use common::view::View;
use gpui_kit::{MouseButton, point, px, size};
use rmpv::Value;
use vimstorm::git::window::TabId;
use vimstorm::git::window::log::DetailsTarget;
use vimstorm::git::window::log::LogTab;
use vimstorm::git::{BranchFilter, DateFilter, LogFilters};

/// 30.png's logical size: the Log gets the room its bar needs at full fit.
const WIDE: (f32, f32) = (1388., 900.);

fn with_log<R>(v: &mut View, f: impl FnOnce(&LogTab, &gpui_kit::App) -> R) -> R {
    let l = log(v);
    v.pump();
    l.read_with(&v.cx, f)
}

fn subjects(v: &mut View) -> Vec<String> {
    with_log(v, |t, _| {
        t.model.commits.iter().map(|c| c.subject.clone()).collect()
    })
}

fn listed(v: &mut View, subject: &str) -> bool {
    subjects(v).iter().any(|s| s.contains(subject))
}

fn filters(v: &mut View) -> LogFilters {
    with_log(v, |t, _| t.filters.clone())
}

/// The bar as drawn: "Text or hash .* Cc | Branch: HEAD × | User ⌄ | …".
fn bar(v: &mut View) -> String {
    with_log(v, |t, _| t.filter_bar_text().join(" | "))
}

fn has_chip(v: &mut View, text: &str) -> bool {
    with_log(v, |t, _| t.filter_bar_text().iter().any(|s| s == text))
}

/// The popup: (title, rows, caret).
fn popup(v: &mut View) -> Option<(String, Vec<String>, Option<String>)> {
    with_log(v, |t, cx| {
        t.filter_popup()
            .map(|p| (p.title.to_string(), p.rows(cx), p.caret(cx)))
    })
}

fn popup_title(v: &mut View) -> String {
    popup(v).map(|p| p.0).unwrap_or_default()
}

fn caret(v: &mut View) -> Option<String> {
    popup(v).and_then(|p| p.2)
}

fn wait_popup(v: &mut View, title: &str) {
    v.wait_until(&format!("popup {title:?} with its choices"), |v| {
        popup_title(v).starts_with(title)
            && !with_log(v, |t, cx| t.filter_popup().unwrap().loading(cx))
    });
}

fn wait_no_popup(v: &mut View) {
    v.wait_until("popup closed", |v| popup(v).is_none());
}

fn wait_caret(v: &mut View, item: &str) {
    v.wait_until(&format!("caret on {item:?}"), |v| {
        caret(v).as_deref() == Some(item)
    });
}

/// Keyboard only: ↑ up to the popup's "All".
fn up_to_all(v: &mut View) {
    for _ in 0..50 {
        if caret(v).as_deref() == Some("All") {
            return;
        }
        v.keystrokes("up");
    }
    panic!("no All, caret {:?}", caret(v));
}

fn field_focused(v: &mut View) -> bool {
    let l = log(v);
    v.pump();
    v.cx.update(|w, cx| {
        let f = l.read(cx).text_field().read(cx).field().clone();
        gpui_kit::Focusable::focus_handle(f.read(cx), cx).is_focused(w)
    })
}

/// The field's (text, selection).
fn field(v: &mut View) -> (String, std::ops::Range<usize>) {
    with_log(v, |t, cx| {
        let f = t.text_field().read(cx).field().read(cx);
        (f.text().to_owned(), f.selection())
    })
}

/// What Rust sent Lua for the session (`config.app.git` `log_filters()`).
fn saved(v: &mut View) -> Value {
    v.lua("return require('config.app.git').log_filters() or {}")
}

fn saved_str(v: &mut View, key: &str) -> Option<String> {
    map_get(&saved(v), key).and_then(|s| s.as_str().map(str::to_owned))
}

fn saved_list(v: &mut View, key: &str) -> Vec<String> {
    map_get(&saved(v), key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn map_get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

fn set_filters(v: &mut View, f: impl FnOnce(&mut LogFilters)) {
    let l = log(v);
    l.update(&mut v.cx, |t, cx| t.update_filters(f, cx));
    v.pump();
}

/// grepo in a wide window, the Git tool window on the Log, the table with the keyboard, rows in.
fn start() -> View {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.cx.simulate_resize(size(px(WIDE.0), px(WIDE.1)));
    v.wait_screen("line one");
    v.lua("require('config.app.git').open('log', true) return true");
    wait_target(&mut v, "git");
    v.wait_until("Log rows with the keyboard", |v| {
        active(v) == TabId::Log
            && listed(v, "Renamed b")
            && table_focused(v)
            && with_log(v, |t, _| !t.loading)
    });
    v.wait_until("bar drawn", |v| bounds(v, "chip-branch").is_some());
    v
}

fn click_sel(v: &mut View, selector: &str) {
    let b = bounds(v, selector).unwrap_or_else(|| panic!("no {selector}\nbar: {}", bar(v)));
    left(v, b.center());
}

// ---- tests -------------------------------------------------------------------------------------

#[test]
fn bar_shows_field_toggles_chips_and_toolbar() {
    let mut v = start();
    assert_eq!(
        bar(&mut v),
        "Text or hash .* Cc | Branch: HEAD × | PR ⌄ | User ⌄ | Date ⌄ | Paths ⌄"
    );
    for s in [
        "search-field-regex",
        "search-field-case",
        "chip-clear-branch",
        "button-log-refresh",
        "button-log-cherry-pick",
        "button-log-view-options",
        "button-log-go-to",
    ] {
        assert!(bounds(&mut v, s).is_some(), "{s} drawn");
    }
    // the field, chips and toolbar in one row of the filter bar's height, left to right
    let row = bounds(&mut v, "git-log-filter-bar").unwrap();
    assert_eq!(row.size.height, px(37.));
    let field = bounds(&mut v, "search-field").unwrap();
    let branch = bounds(&mut v, "chip-branch").unwrap();
    let paths = bounds(&mut v, "chip-paths").unwrap();
    let refresh = bounds(&mut v, "button-log-refresh").unwrap();
    assert!(field.right() < branch.left() && paths.right() < refresh.left());
    assert!((field.center().y - branch.center().y).abs() < px(1.));
    // the eye: View Options (Show Long Edges toggles the graph option)
    click_sel(&mut v, "button-log-view-options");
    v.wait_until("view options", |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l == "Show Long Edges"))
    });
    pick_menu(&mut v, "Show Long Edges");
    v.wait_until("long edges on", |v| {
        with_log(v, |t, _| t.graph_opts.show_long_edges)
    });
    click_sel(&mut v, "button-log-view-options");
    pick_menu(&mut v, "Show Changed Files and Details");
    v.wait_until("details hidden", |v| with_log(v, |t, _| !t.details_shown));
}

#[test]
fn user_popup_filters_and_chip_x_clears() {
    let mut v = start();
    v.keystrokes("u");
    wait_popup(&mut v, "User");
    let rows = popup(&mut v).unwrap().1;
    assert_eq!(rows[..2], ["All", "Ada Example"], "All, then you first");
    v.key("arrow_down");
    v.keystrokes("enter");
    v.wait_until("user filter", |v| {
        has_chip(v, "User: Ada Example ×") && listed(v, "Renamed b") && !listed(v, "fixed label")
    });
    assert!(popup(&mut v).is_none());
    assert!(table_focused(&mut v), "focus back in the log");
    assert_eq!(target(&v), "git");
    click_sel(&mut v, "chip-clear-user");
    v.wait_until("× cleared the user filter", |v| {
        has_chip(v, "User ⌄") && listed(v, "fixed label")
    });
}

#[test]
fn date_popup_and_backspace_clears() {
    let mut v = start();
    date_key(&mut v);
    wait_popup(&mut v, "Date");
    v.keystrokes("/ 7 space d a y s enter");
    v.wait_until("date filter", |v| {
        listed(v, "Recent blame line")
            && !listed(v, "Initial setup")
            && has_chip(v, "Date: Last 7 Days ×")
    });
    v.keystrokes("backspace");
    v.wait_until("Backspace clears the filters", |v| {
        has_chip(v, "Date ⌄") && listed(v, "Initial setup")
    });
}

#[test]
fn chip_x_clears_only_its_filter_and_chip_menu() {
    let mut v = start();
    set_filters(&mut v, |f| {
        f.authors = vec!["Ada Example".into()];
        f.date = Some(DateFilter::LastYear);
        f.paths = vec!["blame.ts".into()];
    });
    v.wait_until("filters set", |v| {
        has_chip(v, "Paths: blame.ts ×") && !listed(v, "Renamed b")
    });
    // next to the ×: the popup opens, the filter stays
    let x = bounds(&mut v, "chip-clear-date").unwrap();
    left(&mut v, point(x.left() - px(6.), x.center().y));
    wait_popup(&mut v, "Date");
    v.keystrokes("escape");
    wait_no_popup(&mut v);
    assert!(has_chip(&mut v, "Date: Last Year ×"), "{}", bar(&mut v));
    // the ×: cleared at once, others kept, no popup, session
    click_sel(&mut v, "chip-clear-date");
    v.wait_until("date cleared", |v| {
        has_chip(v, "Date ⌄")
            && has_chip(v, "User: Ada Example ×")
            && has_chip(v, "Paths: blame.ts ×")
            && popup(v).is_none()
            && saved_str(v, "date").is_none()
    });
    click_sel(&mut v, "chip-clear-paths");
    v.wait_until("paths cleared, reloaded, session", |v| {
        has_chip(v, "Paths ⌄")
            && listed(v, "Renamed b")
            && saved_list(v, "paths").is_empty()
            && popup(v).is_none()
    });
    // right-click: Filter by User… (u), Clear Filter
    let chip = bounds(&mut v, "chip-user").unwrap();
    press(
        &mut v,
        chip.center(),
        MouseButton::Right,
        Default::default(),
        1,
    );
    v.wait_until("chip menu", |v| {
        menu_rows(v).is_some_and(|r| {
            r.contains(&"Filter by User…".into()) && r.contains(&"Clear Filter".into())
        })
    });
    pick_menu(&mut v, "Clear Filter");
    v.wait_until("menu cleared the user filter", |v| {
        has_chip(v, "User ⌄") && listed(v, "fixed label") && saved_list(v, "authors").is_empty()
    });
    // its Filter by… opens the popup
    let chip = bounds(&mut v, "chip-user").unwrap();
    press(
        &mut v,
        chip.center(),
        MouseButton::Right,
        Default::default(),
        1,
    );
    pick_menu(&mut v, "Filter by User…");
    wait_popup(&mut v, "User");
}

#[test]
fn text_field_x_clears() {
    let mut v = start();
    set_filters(&mut v, |f| f.text = Some("renamed".into()));
    v.wait_until("text filter", |v| {
        bar(v).starts_with("renamed × .* Cc") && !listed(v, "Initial setup")
    });
    click_sel(&mut v, "search-field-clear");
    v.wait_until("× cleared the text filter", |v| {
        bar(v).starts_with("Text or hash .* Cc")
            && listed(v, "Initial setup")
            && saved_str(v, "text").is_none()
    });
    assert!(bounds(&mut v, "search-field-clear").is_none(), "× gone");
}

#[test]
fn narrow_bar_keeps_every_x() {
    let mut v = start();
    set_filters(&mut v, |f| {
        f.authors = vec!["Ada Example".into(), "Max".into()];
        f.date = Some(DateFilter::LastYear);
        f.paths = vec!["blame.ts".into()];
    });
    v.wait_until("filters set", |v| has_chip(v, "Paths: blame.ts ×"));
    v.cx.simulate_resize(size(px(640.), px(WIDE.1)));
    let xs = ["branch", "user", "date", "paths"];
    v.wait_until("narrow: 4 ×, nothing cut off", |v| {
        let Some(bar_b) = bounds(v, "git-log-filter-bar") else {
            return false;
        };
        let Some(tools) = bounds(v, "button-log-refresh") else {
            return false;
        };
        xs.iter().all(|k| {
            bounds(v, &format!("chip-clear-{k}"))
                .is_some_and(|b| b.left() >= bar_b.left() && b.right() <= tools.left())
        }) && bar(v).matches('×').count() == 4
            && !bar(v).contains("User ⌄")
            // the labels go first ("Paths: blame.ts" -> "blame.ts")
            && !bar(v).contains("Paths: ")
    });
    let shown = bar(&mut v);
    assert!(
        !shown.contains("Paths: "),
        "narrow: labels went first: {shown}"
    );
    click_sel(&mut v, "chip-clear-paths");
    v.wait_until("last × cleared paths", |v| {
        bar(v).matches('×').count() == 3 && saved_list(v, "paths").is_empty() && popup(v).is_none()
    });
}

/// the field at its narrow width still shows "Text or hash" whole (WS's minimum is 150 px,
/// less than its own placeholder needs beside the magnifier and the `.*` / `Cc` toggles).
#[test]
fn narrow_field_keeps_its_placeholder_whole() {
    let mut v = start();
    let needed = super::text_width(&mut v, "Text or hash") + 2. * vimstorm::look::FIELD_PADDING_X;
    let mut narrow = 0;
    let mut width = WIDE.0;
    while width > 500. {
        v.cx.simulate_resize(size(px(width), px(WIDE.1)));
        v.pump();
        let shown = bar(&mut v);
        if shown.starts_with("Text or hash")
            && let Some(text) = bounds(&mut v, "text-field")
        {
            // the wide field's text box is 143.5 px
            if text.size.width.as_f32() < 140. {
                narrow += 1;
            }
            assert!(
                text.size.width.as_f32() + 0.5 >= needed,
                "at {width} px the placeholder is cut: {} < {needed} ({shown})",
                text.size.width.as_f32()
            );
        }
        width -= 20.;
    }
    assert!(narrow > 0, "no width drew the narrow field");
}

#[test]
fn text_filter_case_and_regex_toggles() {
    let mut v = start();
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("renamed B");
    v.keystrokes("enter");
    v.wait_until("ignores case by default", |v| {
        listed(v, "Renamed b") && !listed(v, "Initial setup") && bar(v).starts_with("renamed B ×")
    });
    assert!(table_focused(&mut v));
    click_sel(&mut v, "search-field-case");
    v.wait_until("Cc: match case", |v| {
        filters(v).match_case && with_log(v, |t, _| !t.loading) && !listed(v, "Renamed b")
    });
    click_sel(&mut v, "search-field-case");
    v.wait_until("Cc off", |v| listed(v, "Renamed b"));
    click_sel(&mut v, "search-field-regex");
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("ren.med b");
    v.keystrokes("enter");
    v.wait_until(".*: a regex", |v| {
        filters(v).regex && listed(v, "Renamed b")
    });
    click_sel(&mut v, "search-field-regex");
    v.wait_until(
        ".* off: nothing matches, log and changed files empty",
        |v| {
            !filters(v).regex
                && with_log(v, |t, cx| {
                    !t.loading
                        && t.model.is_empty()
                        && t.details.read(cx).target == DetailsTarget::None
                })
        },
    );
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("100%");
    v.keystrokes("enter");
    v.wait_until("% shown as typed", |v| bar(v).starts_with("100% ×"));
    let n0 = with_log(&mut v, |t, _| t.filter_reloads);
    v.keystrokes("backspace");
    // the Backspace reload done (Lua clear_filters: the toggles go too)
    v.wait_until("cleared", |v| {
        bar(v).starts_with("Text or hash")
            && with_log(v, |t, _| t.filter_reloads > n0 && !t.loading)
            && !filters(v).regex
            && !filters(v).match_case
    });
    // the toggles without a text filter: no reload, the flags kept (counted as filter reloads:
    // a repo-change refresh from the poll may run meanwhile)
    let before = with_log(&mut v, |t, _| t.filter_reloads);
    click_sel(&mut v, "search-field-regex");
    v.wait_until("regex flag", |v| filters(v).regex);
    assert_eq!(with_log(&mut v, |t, _| t.filter_reloads), before);
}

#[test]
fn branch_popup_and_tab_label() {
    let mut v = start();
    assert_eq!(log_label(&mut v), "Log: HEAD");
    v.keystrokes("b");
    wait_popup(&mut v, "Branch");
    v.keystrokes("/ f a c t o r y enter");
    v.wait_until("branch filter, tab label", |v| {
        listed(v, "fixed label")
            && !listed(v, "Renamed b")
            && log_label(v) == "Log: factory/1237"
            && has_chip(v, "Branch: factory/1237 ×")
    });
    click_sel(&mut v, "chip-branch");
    wait_popup(&mut v, "Branch");
    assert_eq!(caret(&mut v).as_deref(), Some("factory/1237"));
    up_to_all(&mut v);
    v.keystrokes("enter");
    v.wait_until("all branches: tab 'Log'", |v| {
        log_label(v) == "Log" && has_chip(v, "Branch ⌄")
    });
    v.keystrokes("backspace");
    v.wait_until("Backspace: HEAD", |v| log_label(v) == "Log: HEAD");
}

#[test]
fn branch_popup_keyboard_only() {
    let mut v = start();
    v.keystrokes("b");
    wait_popup(&mut v, "Branch");
    wait_caret(&mut v, "HEAD");
    let rows = popup(&mut v).unwrap().1;
    assert_eq!(rows[..2], ["All", "HEAD"]);
    assert!(rows.contains(&"factory/1237".into()) && rows.contains(&"v1.0".into()));
    v.keystrokes("up enter");
    v.wait_until("All: chip unset, tab Log, every branch, session", |v| {
        has_chip(v, "Branch ⌄")
            && log_label(v) == "Log"
            && listed(v, "fixed label")
            && saved_str(v, "branch").as_deref() == Some("--all")
            && popup(v).is_none()
    });
    v.keystrokes("b");
    wait_popup(&mut v, "Branch");
    wait_caret(&mut v, "All");
    v.key("arrow_down");
    v.keystrokes("escape");
    wait_no_popup(&mut v);
    assert_eq!(
        filters(&mut v).branch,
        BranchFilter::All,
        "Esc changes nothing"
    );
    assert_eq!(saved_str(&mut v, "branch").as_deref(), Some("--all"));
    assert!(table_focused(&mut v));
    v.keystrokes("b");
    wait_caret(&mut v, "All");
    v.key("arrow_down");
    v.keystrokes("enter");
    v.wait_until("HEAD again", |v| log_label(v) == "Log: HEAD");
}

#[test]
fn user_popup_keyboard_only() {
    let mut v = start();
    // typed before its names load (the first open): Enter takes the first match
    assert!(popup(&mut v).is_none());
    v.keystrokes("u / m a x enter");
    v.wait_until("typed ahead: Max", |v| {
        filters(v).authors == ["Max"] && popup(v).is_none()
    });
    v.keystrokes("u");
    wait_caret(&mut v, "Max");
    up_to_all(&mut v);
    v.keystrokes("enter");
    v.wait_until("cleared", |v| has_chip(v, "User ⌄"));
    v.keystrokes("u");
    wait_popup(&mut v, "User");
    wait_caret(&mut v, "All");
    v.key("arrow_down");
    v.keystrokes("enter");
    v.wait_until("you", |v| {
        has_chip(v, "User: Ada Example ×") && !listed(v, "fixed label")
    });
    v.keystrokes("u");
    wait_popup(&mut v, "User");
    wait_caret(&mut v, "Ada Example");
    v.keystrokes("up enter");
    v.wait_until("All: unset, reloaded, session", |v| {
        has_chip(v, "User ⌄") && listed(v, "fixed label") && saved_list(v, "authors").is_empty()
    });
    // Tab marks several (a checkmark each)
    v.keystrokes("u");
    wait_caret(&mut v, "All");
    v.key("arrow_down");
    v.keystrokes("tab");
    v.key("arrow_down");
    v.keystrokes("tab");
    let marked = with_log(&mut v, |t, cx| t.filter_popup().unwrap().marked(cx));
    assert_eq!(marked.len(), 2);
    assert_eq!(marked[0], "Ada Example");
    v.keystrokes("enter");
    v.wait_until("two users", |v| has_chip(v, "User: Ada Example +1 ×"));
    assert_eq!(saved_list(&mut v, "authors").len(), 2);
    v.keystrokes("u");
    wait_caret(&mut v, "Ada Example");
    v.keystrokes("tab up up tab enter"); // you, then All
    v.wait_until("All among them clears", |v| {
        has_chip(v, "User ⌄") && saved_list(v, "authors").is_empty()
    });
    // one burst, typing filters at once (no `/`): Enter takes the search's first match, never
    // All
    v.keystrokes("u m a x enter");
    v.wait_until("Max", |v| {
        has_chip(v, "User: Max ×")
            && popup(v).is_none()
            && saved_list(v, "authors") == ["Max"]
            && !listed(v, "Renamed b")
    });
    v.keystrokes("u");
    wait_caret(&mut v, "Max");
    up_to_all(&mut v);
    v.keystrokes("enter");
    v.wait_until("cleared", |v| has_chip(v, "User ⌄"));
}

#[test]
fn date_and_paths_popups_keyboard_only() {
    let mut v = start();
    date_key(&mut v);
    wait_popup(&mut v, "Date");
    wait_caret(&mut v, "All");
    assert_eq!(
        popup(&mut v).unwrap().1,
        [
            "All",
            "Last 24 Hours",
            "Last 7 Days",
            "Last 30 Days",
            "Last Year",
            "Select…"
        ]
    );
    v.key("arrow_down");
    v.key("arrow_down");
    v.keystrokes("enter");
    v.wait_until("7 days", |v| {
        has_chip(v, "Date: Last 7 Days ×") && !listed(v, "Initial setup")
    });
    date_key(&mut v);
    wait_caret(&mut v, "Last 7 Days");
    up_to_all(&mut v);
    v.keystrokes("enter");
    v.wait_until("date cleared, session", |v| {
        has_chip(v, "Date ⌄") && listed(v, "Initial setup") && saved_str(v, "date").is_none()
    });

    v.keystrokes("p");
    wait_popup(&mut v, "Paths");
    wait_caret(&mut v, "All");
    let rows = popup(&mut v).unwrap().1;
    assert!(rows[1].ends_with('/'), "folders first: {rows:?}");
    v.keystrokes("/ b l a m e . t s enter");
    v.wait_until("paths", |v| {
        has_chip(v, "Paths: blame.ts ×") && !listed(v, "Renamed b")
    });
    v.keystrokes("p");
    wait_caret(&mut v, "blame.ts");
    up_to_all(&mut v);
    v.keystrokes("enter");
    v.wait_until("paths cleared, session", |v| {
        has_chip(v, "Paths ⌄") && listed(v, "Renamed b") && saved_list(v, "paths").is_empty()
    });
}

#[test]
fn text_field_keys() {
    let mut v = start();
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    // typed keys stay in the field: no popup, no log key
    v.cx.simulate_input("bud,p");
    assert!(popup(&mut v).is_none());
    assert_eq!(field(&mut v).0, "bud,p");
    v.keystrokes("cmd-a");
    v.cx.simulate_input("hello");
    v.keystrokes("enter");
    v.wait_until("hello", |v| bar(v).starts_with("hello ×"));
    v.keystrokes("/");
    v.wait_until("field with the text selected", |v| {
        field_focused(v) && field(v) == ("hello".into(), 0..5)
    });
    v.cx.simulate_input("renamed");
    v.keystrokes("enter");
    v.wait_until("typing replaced it", |v| {
        bar(v).starts_with("renamed ×") && saved_str(v, "text").as_deref() == Some("renamed")
    });
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.keystrokes("backspace enter");
    v.wait_until("Backspace, Enter: cleared", |v| {
        bar(v).starts_with("Text or hash")
            && listed(v, "Initial setup")
            && saved_str(v, "text").is_none()
            && table_focused(v)
    });
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("hello");
    v.keystrokes("enter");
    v.wait_until("hello", |v| bar(v).starts_with("hello ×"));
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.keystrokes("cmd-backspace");
    assert_eq!(field(&mut v).0, "", "Cmd+Backspace empties the field");
    v.keystrokes("enter");
    v.wait_until("empty Enter clears", |v| {
        bar(v).starts_with("Text or hash") && saved_str(v, "text").is_none()
    });
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("hello");
    v.keystrokes("enter");
    v.wait_until("hello", |v| bar(v).starts_with("hello ×"));
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("xyz");
    v.keystrokes("escape");
    v.wait_until("Esc: back in the log, the filter stays", |v| {
        table_focused(v)
            && bar(v).starts_with("hello ×")
            && saved_str(v, "text").as_deref() == Some("hello")
            && field(v).0 == "hello"
    });
    assert_eq!(target(&v), "git", "Esc didn't leave the tool window");
    // a click into the field focuses it
    click_sel(&mut v, "search-field");
    v.wait_until("click focuses the field", field_focused);
    v.keystrokes("escape");
    v.wait_until("back", table_focused);
}

#[test]
fn text_filter_history_popup_reapplies_a_recent_text() {
    let mut v = start();
    for text in ["renamed", "added"] {
        v.keystrokes("/");
        v.wait_until("field focused", field_focused);
        v.cx.simulate_input(text);
        v.keystrokes("enter");
        v.wait_until("applied", |v| filters(v).text.as_deref() == Some(text));
    }
    // the session keeps the history, newest first
    v.wait_until("saved", |v| history(v) == ["added", "renamed"]);
    // the magnifier ▾ (WS search history): recent texts, picking one applies it
    click_sel(&mut v, "search-field-icon");
    v.wait_until("history popup", |v| {
        menu_rows(v).is_some_and(|r| {
            let a = r.iter().position(|l| l.contains("added"));
            let b = r.iter().position(|l| l.contains("renamed"));
            a.is_some() && a < b
        })
    });
    pick_menu(&mut v, "renamed");
    v.wait_until("re-applied", |v| {
        filters(v).text.as_deref() == Some("renamed") && table_focused(v)
    });
    v.wait_until("moved to the top", |v| history(v) == ["renamed", "added"]);
}

fn history(v: &mut View) -> Vec<String> {
    let h = v.lua("return require('config.app.git').log_text_history()");
    h.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn no_matching_commits_centred_with_a_reset_filters_link() {
    let mut v = start();
    v.keystrokes("/");
    v.wait_until("field focused", field_focused);
    v.cx.simulate_input("no such commit at all");
    v.keystrokes("enter");
    v.wait_until("empty", |v| {
        with_log(v, |t, _| !t.loading && t.model.is_empty())
            && bounds(v, "git-log-reset-filters").is_some()
    });
    assert_eq!(
        with_log(&mut v, |t, _| t.empty_text()),
        "No commits matching filters"
    );
    // centred in the table (WS StatusText), the link on the next line
    let table = bounds(&mut v, "git-log-table").unwrap();
    let text = bounds(&mut v, "git-log-empty").unwrap();
    let link = bounds(&mut v, "git-log-reset-filters").unwrap();
    assert!((text.center().y - table.center().y).abs() < px(2.));
    assert!((link.center().x - table.center().x).abs() < px(2.));
    left(&mut v, link.center());
    v.wait_until("filters reset", |v| {
        filters(v) == LogFilters::default() && listed(v, "Renamed b")
    });
}

#[test]
fn intellisort_toggle_lists_a_branchs_commits_together() {
    let mut v = start();
    let dir = std::path::PathBuf::from(v.lua("return vim.fn.getcwd()").as_str().unwrap());
    let order = |o: &str| -> Vec<String> {
        git(&dir, &["log", o, "--format=%s", "HEAD"])
            .lines()
            .map(str::to_owned)
            .collect()
    };
    let (date, topo) = (order("--date-order"), order("--topo-order"));
    assert_eq!(subjects(&mut v), date, "WS default: IntelliSort off");
    click_sel(&mut v, "button-log-intellisort");
    v.wait_until("IntelliSort: topo order", |v| {
        with_log(v, |t, _| t.intellisort && !t.loading) && subjects(v) == topo
    });
    click_sel(&mut v, "button-log-intellisort");
    v.wait_until("off: date order", |v| {
        with_log(v, |t, _| !t.intellisort && !t.loading) && subjects(v) == date
    });
}

#[test]
fn backspace_clears_the_toggles_and_a_long_branch_label_is_cut() {
    let mut v = View::start("grepo", &["blame.ts"]);
    v.wait_screen("line one");
    open_log(&mut v);
    update_log(&mut v, |t, cx| {
        t.update_filters(
            |f| {
                f.regex = true;
                f.match_case = true;
                f.branch = BranchFilter::Ref("a/very/long/branch/name/that/goes/on".into());
            },
            cx,
        )
    });
    let label = v.read_ws(|ws, cx| ws.git().read(cx).labels(cx)[1].to_string());
    assert_eq!(label.chars().count(), 29, "{label}");
    assert!(label.ends_with('…'));
    v.wait_until("loaded", |v| read_log(v, |t| !t.loading));
    v.keystrokes("backspace");
    v.wait_until("all filters and toggles off", |v| {
        read_log(v, |t| {
            !t.filters.regex && !t.filters.match_case && t.filters.branch == BranchFilter::Head
        })
    });
}
