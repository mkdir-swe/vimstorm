//! Helpers for the Git tool window's tab tests (Local Changes): open it, find rows /
//! buttons / checkboxes, mouse presses with modifiers and click counts, popups' menus and
//! balloons, the focus target.

use std::path::{Path, PathBuf};
use std::process::Command;

use gpui_kit::{
    Bounds, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Pixels, Point, point, px,
};
use vimstorm::git::window::TabId;
use vimstorm::popups::PopupsView;

use super::view::View;

/// `config/focus.lua` `target()`.
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

pub fn git_open(v: &mut View) -> bool {
    v.read_ws(|ws, cx| ws.git().read(cx).is_open())
}

pub fn active(v: &mut View) -> TabId {
    v.read_ws(|ws, cx| ws.git().read(cx).active())
}

/// Git with the keyboard until its tool window has it: Code's bottom panel on Git (its tab, as a
/// click on it) in a projects window, `config.app.git.open` in a bare one (no rail).
pub fn open_git(v: &mut View) {
    if v.projects.is_some() {
        v.lua("require('config.app.pane').show('git') return true");
    } else {
        v.lua("require('config.app.git').open() return true");
    }
    wait_target(v, "git");
    v.wait_until("Git tool window open", git_open);
}

/// Hides the Git tool window (`config.app.git.hide`, as its header's −), the keys back in the
/// split.
pub fn hide_git(v: &mut View) {
    v.lua("require('config.app.git').hide() return true");
    v.wait_until("Git tool window hidden", |v| !git_open(v));
}

/// Runs a shell script (`sh -c`), asserts success.
pub fn sh(script: &str) {
    let out = Command::new("sh").arg("-c").arg(script).output().unwrap();
    assert!(
        out.status.success(),
        "sh: {}\n{}",
        script,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// git in `dir` (trimmed stdout; failures allowed).
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A fresh temp dir (kept: nvim's session files point into it until the test ends).
pub fn temp_dir(prefix: &str) -> PathBuf {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .unwrap()
        .keep()
        .canonicalize()
        .unwrap()
}

/// An element's bounds by its debug selector.
pub fn bounds(v: &mut View, selector: &str) -> Option<Bounds<Pixels>> {
    v.pump();
    let s: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    v.cx.debug_bounds(s)
}

pub fn press(v: &mut View, at: Point<Pixels>, button: MouseButton, m: Modifiers, clicks: usize) {
    v.cx.simulate_event(MouseDownEvent {
        position: at,
        button,
        modifiers: m,
        click_count: clicks,
        first_mouse: false,
    });
    v.cx.simulate_event(MouseUpEvent {
        position: at,
        button,
        modifiers: m,
        click_count: clicks,
    });
    v.pump();
}

pub fn left(v: &mut View, at: Point<Pixels>) {
    press(v, at, MouseButton::Left, Modifiers::default(), 1);
}

/// Hides every balloon (they sit over the tool window's bottom right, where the commit panel's
/// buttons are).
pub fn hide_balloons(v: &mut View) {
    v.lua("require('config.app.balloon').hide() return true");
    v.wait_until("balloons hidden", |v| balloons(v).is_empty());
}

/// Clicks a button (`button-<id>`), the balloons hidden first.
pub fn click_button(v: &mut View, id: &str) {
    hide_balloons(v);
    let b = bounds(v, &format!("button-{id}")).unwrap_or_else(|| panic!("no button {id}"));
    left(v, b.center());
}

/// A point on a list row: `x` px into the row of the list whose bounds are `list` (rows of
/// `row_h` from its top; no scroll).
pub fn row_point(list: Bounds<Pixels>, row: usize, x: f32, row_h: f32) -> Point<Pixels> {
    point(
        list.left() + px(x),
        list.top() + px(row as f32 * row_h + row_h / 2.),
    )
}

pub fn popups(v: &mut View) -> gpui_kit::Entity<PopupsView> {
    v.read_ws(|ws, _| ws.popups().clone())
}

pub fn menu_rows(v: &mut View) -> Option<Vec<String>> {
    let p = popups(v);
    v.pump();
    p.read_with(&v.cx, |p, _| p.menu_rows())
}

pub fn menu_title(v: &mut View) -> Option<String> {
    let p = popups(v);
    v.pump();
    p.read_with(&v.cx, |p, _| p.menu_title())
}

/// Shown balloons: (title, body).
pub fn balloons(v: &mut View) -> Vec<(String, String)> {
    let p = popups(v);
    v.pump();
    p.read_with(&v.cx, |p, _| p.balloons())
}

pub fn has_balloon(v: &mut View, text: &str) -> bool {
    balloons(v)
        .iter()
        .any(|(t, b)| t.contains(text) || b.contains(text))
}

/// Picks a menu row by its label (keys: down to it, Enter).
pub fn pick_menu(v: &mut View, label: &str) {
    v.wait_until(&format!("menu with {label:?}"), |v| {
        menu_rows(v).is_some_and(|r| r.iter().any(|l| l.contains(label)))
    });
    let p = popups(v);
    let item = p.read_with(&v.cx, |p, _| p.menu_item(label));
    assert!(item.is_some(), "menu item {label:?}");
    for _ in 0..40 {
        let sel = p
            .read_with(&v.cx, |p, _| p.menu_selected())
            .unwrap_or_default();
        if sel.contains(label) {
            break;
        }
        v.keystrokes("down");
        v.pump();
    }
    v.keystrokes("enter");
    v.pump();
}

/// The clipboard's text.
pub fn clipboard(v: &mut View) -> String {
    v.cx.read_from_clipboard()
        .and_then(|c| c.text())
        .unwrap_or_default()
}

pub const SHIFT: Modifiers = Modifiers {
    control: false,
    alt: false,
    shift: true,
    platform: false,
    function: false,
};
