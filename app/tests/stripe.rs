//! The stripe, Welcome's (a project window has the rail, `tests/rail.rs`): what it draws per
//! place and its right-click menu are the contract's (`stripe/*.json`, from the bridge's
//! `stripe.ts`); on Welcome its clicks and menu are the screen's.
#![cfg(debug_assertions)]

use gpui_kit::{Bounds, MouseButton, Pixels};
use serde_json::Value;
use vimstorm::factory::StripeItem;
use vimstorm::shell::projects::{self, Place, Row, Shown};

use crate::common::bridge::{fixture, log};
use crate::common::view::View;

/// A contract frame as one line.
pub(crate) fn frame(rel: &str) -> String {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap();
    doc.to_string()
}

fn json<T: serde::de::DeserializeOwned>(rel: &str) -> T {
    serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
}

/// The developer's stripe as the bridge sends it (`frames/bridge-shell-stripe.json`).
fn items() -> Vec<StripeItem> {
    let doc: Value = json("frames/bridge-shell-stripe.json");
    serde_json::from_value(doc["effect"]["items"].clone()).unwrap()
}

/// `line` as the bridge's stdout says it (the bridge started first).
pub(crate) fn receive(v: &mut View, line: &str) {
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| projects.update(cx, |p, cx| p.follow_factory(window, cx)));
    let factory = projects.read_with(&v.cx, |p, _| p.factory().cloned().unwrap());
    factory.update(&mut v.cx, |f, cx| f.receive_line(line, cx));
    v.pump();
}

pub(crate) fn bounds(v: &mut View, selector: &str) -> Option<Bounds<Pixels>> {
    v.pump();
    // (GPUI keys its debug selectors by `&'static str`)
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    v.cx.debug_bounds(selector)
}

fn click(v: &mut View, selector: &str) {
    let b = bounds(v, selector).unwrap_or_else(|| panic!("no {selector}"));
    v.click(MouseButton::Left, b.center());
}

#[test]
fn the_stripe_draws_what_the_contract_says_per_place_and_bottom_tool_window() {
    let items = items();
    for (name, place, pane) in [
        ("editor", Place::Project, None),
        ("board", Place::Board, None),
        ("run", Place::Run, None),
        ("pane-sessions", Place::Project, Some("sessions")),
        ("pane-boxes", Place::Project, Some("boxes")),
        ("pane-pipelines", Place::Project, Some("pipelines")),
        ("pane-terminal", Place::Project, Some("terminal")),
        ("pane-git", Place::Project, Some("git")),
        ("board-pane-sessions", Place::Board, Some("sessions")),
    ] {
        let want: Shown = json(&format!("stripe/{name}.json"));
        assert_eq!(projects::shown(&items, place, pane), want, "{name}");
    }
    // Welcome's: its own items, the page's one picked
    let welcome: Vec<StripeItem> = {
        let doc: Value = json("frames/bridge-shell-stripe-welcome.json");
        serde_json::from_value(doc["effect"]["items"].clone()).unwrap()
    };
    for page in ["board", "projects", "sessions"] {
        let want: Shown = json(&format!("stripe/welcome-{page}.json"));
        assert_eq!(
            vimstorm::shell::projects::welcome_shown(&welcome, page),
            want,
            "welcome-{page}"
        );
    }
    for (name, here, at) in [
        ("menu-workspace", true, "pipelines"),
        ("menu-board", false, "board"),
    ] {
        let want: Vec<Row> = json(&format!("stripe/{name}.json"));
        assert_eq!(projects::menu_rows(&items, here, Some(at)), want, "{name}");
    }
}

/// Welcome's stripe: the bridge's items at the window's left edge off a workspace, Board
/// picked; a click is the screen's (the page it tells back picks Sessions), a right-click the
/// screen's menu, the title bar's gear Settings.
#[test]
fn welcome_draws_the_stripe_its_page_picked_its_clicks_the_screen_s_and_the_gear_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let mut v = View::start_projects("proj", &["a.txt"]);
    let mut command = crate::common::bridge::fake(
        tmp.path(),
        &[
            "frames/bridge-tree-welcome.json",
            "frames/bridge-shell-welcome.json",
            "frames/bridge-shell-stripe-welcome.json",
        ],
        None,
    );
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!(
            "widget:stripe:sessions={}",
            fixture("frames/bridge-shell-welcome-sessions.json").display()
        ),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+q");
    v.wait_until("Welcome shown", crate::projects::welcome_shown);
    v.wait_until("the stripe drawn, Board picked", |v| {
        bounds(v, "stripe-sessions").is_some() && bounds(v, "stripe-picked-board").is_some()
    });
    // a workspace's items leave it
    for id in ["run", "pipelines", "terminal", "git"] {
        assert!(bounds(&mut v, &format!("stripe-{id}")).is_none(), "{id}");
    }
    // at the window's left edge, the screen beside it
    let stripe = bounds(&mut v, "welcome-stripe").unwrap();
    let screen = bounds(&mut v, "factory-node-welcome").unwrap();
    assert_eq!(f32::from(stripe.origin.x), 0.);
    assert!(f32::from(screen.origin.x) >= vimstorm::shell::projects::STRIPE_WIDTH);
    // Sessions: the screen's click; the page it tells back picks it
    click(&mut v, "stripe-sessions");
    v.wait_until("Sessions picked", |v| {
        bounds(v, "stripe-picked-sessions").is_some() && bounds(v, "stripe-picked-board").is_none()
    });
    assert!(
        log(tmp.path())
            .iter()
            .any(|l| l.contains("widget:stripe:sessions"))
    );
    // a right-click: the screen's menu on that item
    let b = bounds(&mut v, "stripe-boxes").unwrap();
    v.click(MouseButton::Right, b.center());
    v.wait_until("the menu asked of the screen", |_| {
        log(tmp.path())
            .iter()
            .any(|l| l.contains("widget:stripe-at:boxes"))
    });
    // the gear: Settings
    click(&mut v, "toolbar-settings");
    v.wait_until("Settings opened", |_| {
        log(tmp.path())
            .iter()
            .any(|l| l.contains(r#""screen":"settings""#))
    });
}
