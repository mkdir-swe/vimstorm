//! The Project tree's test helpers: read it, wait on it, find a row's or a chevron's point.

use std::time::{Duration, Instant};

use gpui_kit::{Entity, Modifiers, MouseButton, Pixels, Point};
use vimstorm::shell::tree::TreeView;

use super::gitui::press;
use super::view::View;

pub fn tree(v: &mut View) -> Entity<TreeView> {
    v.read_ws(|ws, _| ws.tree().clone())
}

pub fn tv<R>(v: &mut View, f: impl FnOnce(&TreeView) -> R) -> R {
    let t = tree(v);
    v.pump();
    t.read_with(&v.cx, |t, _| f(t))
}

/// Waits until `pred` holds on the tree (pumping the UI, nvim's events and background work).
pub fn wait_tree(v: &mut View, label: &str, pred: impl Fn(&TreeView) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if tv(v, &pred) {
            return;
        }
        if Instant::now() > deadline {
            let rows = tv(v, |t| t.row_paths());
            let cur = tv(v, |t| t.cursor());
            panic!("timed out waiting for: {label}\nrows: {rows:?}\ncursor: {cur:?}");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Where a click lands on the row of `rel`, `dx` px into its name, once the row is shown.
pub fn row_point(v: &mut View, rel: &str, dx: f32) -> Point<Pixels> {
    wait_tree(v, &format!("tree row {rel}"), |t| {
        t.row_index(rel).is_some()
    });
    tv(v, |t| t.row_point(t.row_index(rel).unwrap(), dx).unwrap())
}

pub fn chevron(v: &mut View, rel: &str) -> Point<Pixels> {
    tv(v, |t| t.chevron_point(t.row_index(rel).unwrap()).unwrap())
}

/// A double-click on the row of `rel`.
pub fn double_click_row(v: &mut View, rel: &str) {
    let p = row_point(v, rel, 4.);
    press(v, p, MouseButton::Left, Modifiers::default(), 1);
    press(v, p, MouseButton::Left, Modifiers::default(), 2);
}
