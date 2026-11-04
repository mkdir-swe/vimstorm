//! The Local Changes tab read from the window: its tree's rows, what is marked, which pane has the
//! keyboard, the commit hint, and the caret put on a row.

use gpui_kit::Entity;
use vimstorm::git::window::changes::{ChangesTab, Pane};
use vimstorm::kit::ListView;
use vimstorm::kit::{ChangesTree, RowKind, count};

use super::view::View;

pub fn tab(v: &mut View) -> Entity<ChangesTab> {
    v.read_ws(|ws, cx| ws.git().read(cx).changes().clone())
}

pub fn tree(v: &mut View) -> Entity<ListView<ChangesTree>> {
    let t = tab(v);
    v.cx.read(|cx| t.read(cx).tree().clone())
}

/// The tree's rows as text: "Changes 1 file", "frontend/apps/admin/src 1 file", "new.ts".
pub fn rows(v: &mut View) -> Vec<String> {
    let t = tree(v);
    v.pump();
    v.cx.read(|cx| {
        let d = &t.read(cx).delegate;
        d.rows()
            .iter()
            .map(|r| match &r.kind {
                RowKind::Group(g) => format!(
                    "{} {}",
                    d.groups()[*g].title.clone().unwrap_or_default(),
                    count(r.files.len())
                ),
                RowKind::Dir { name, .. } => format!("{name} {}", count(r.files.len())),
                RowKind::File(fr) => d.file(*fr).name().to_owned(),
                RowKind::Empty => "<empty>".into(),
            })
            .collect()
    })
}

pub fn row_of(v: &mut View, text: &str) -> Option<usize> {
    rows(v).iter().position(|r| r.contains(text))
}

pub fn has_row(v: &mut View, text: &str) -> bool {
    row_of(v, text).is_some()
}

pub fn loaded(v: &mut View) -> bool {
    let t = tab(v);
    v.cx.read(|cx| t.read(cx).data().is_some())
}

/// The marked files' paths, sorted.
pub fn included(v: &mut View) -> Vec<String> {
    let t = tab(v);
    let mut p: Vec<String> =
        v.cx.read(|cx| t.read(cx).included(cx).into_iter().collect());
    p.sort();
    p
}

pub fn pane(v: &mut View) -> Pane {
    let t = tab(v);
    v.cx.read(|cx| t.read(cx).pane())
}

/// The commit hint under the message ("Commit 1 marked file(s)").
pub fn hint(v: &mut View) -> String {
    let t = tab(v);
    v.cx.read(|cx| t.read(cx).commit_hint(cx))
}

/// The caret on the tree row containing `text`, the tree focused (setup).
pub fn goto_row(v: &mut View, text: &str) {
    let ix = row_of(v, text).unwrap_or_else(|| panic!("no row {text:?}: {:?}", rows(v)));
    let t = tree(v);
    v.cx.update(|window, cx| {
        t.update(cx, |l, cx| {
            l.state.set_selection(Some(ix), []);
            cx.notify();
        });
        let h = gpui_kit::Focusable::focus_handle(t.read(cx), cx);
        window.focus(&h, cx);
    });
    v.pump();
}
