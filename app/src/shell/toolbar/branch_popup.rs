//! The Branches… popup under the toolbar (WebStorm's Git Branches popup; Branches… menu items): "New Branch…", then the Recent,
//! Local and Remote groups. A branch's row has WebStorm's actions in a submenu at its right (⏎, →
//! or a click open it): Checkout, New Branch from '<b>'…, Compare with Current, Rename…,
//! Delete… ([`actions`]); typing filters the rows (every letter; arrows, Ctrl-n / Ctrl-p move).

use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    SharedString, Styled as _, WeakEntity, Window, div, prelude::FluentBuilder as _, px,
};

use super::ToolbarView;
use super::widgets::click_confirms;
use crate::git::{Branches, Head, Target};
use crate::kit::{Icon, IconName};
use crate::kit::{
    ListDelegate, ListOptions, ListSource, ListState, ListView, RowState, match_text,
};
use crate::look;

/// One row of the popup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchRow {
    NewBranch,
    /// A group caption ("Recent", "Local", "Remote"); `line`: a separator above it.
    Caption {
        title: &'static str,
        line: bool,
    },
    Branch {
        target: Target,
        current: bool,
    },
}

impl BranchRow {
    /// The text the row shows (and the search matches).
    pub fn label(&self) -> &str {
        match self {
            BranchRow::NewBranch => "New Branch…",
            BranchRow::Caption { title, .. } => title,
            BranchRow::Branch {
                target: Target::Local(n) | Target::Remote(n),
                ..
            } => n,
        }
    }
}

/// The rows for `branches` with HEAD at `head`.
pub fn rows(branches: &Branches, head: &Head) -> Vec<BranchRow> {
    let current = head.branch();
    let mut out = vec![BranchRow::NewBranch];
    let group = |title, names: &[String], remote: bool, out: &mut Vec<BranchRow>| {
        if names.is_empty() {
            return;
        }
        out.push(BranchRow::Caption { title, line: true });
        for n in names {
            let target = if remote {
                Target::Remote(n.clone())
            } else {
                Target::Local(n.clone())
            };
            out.push(BranchRow::Branch {
                current: !remote && Some(n.as_str()) == current,
                target,
            });
        }
    };
    group("Recent", &branches.recent, false, &mut out);
    group("Local", &branches.local, false, &mut out);
    group("Remote", &branches.remote, true, &mut out);
    out
}

/// What a branch's submenu offers (WebStorm's branch actions).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchAction {
    Checkout,
    NewFrom,
    Compare,
    Rename,
    Delete,
}

impl BranchAction {
    /// The submenu row's text for branch `name`.
    pub fn label(self, name: &str) -> String {
        match self {
            BranchAction::Checkout => "Checkout".into(),
            BranchAction::NewFrom => format!("New Branch from '{name}'…"),
            BranchAction::Compare => "Compare with Current".into(),
            BranchAction::Rename => "Rename…".into(),
            BranchAction::Delete => "Delete…".into(),
        }
    }
}

/// A branch's actions, as WebStorm's popup lists them: the current branch can't be checked out,
/// compared with itself or deleted; a remote one isn't renamed here.
pub fn actions(target: &Target, current: bool) -> Vec<BranchAction> {
    use BranchAction::*;
    match (target, current) {
        (_, true) => vec![NewFrom, Rename],
        (Target::Local(_), false) => vec![Checkout, NewFrom, Compare, Rename, Delete],
        (Target::Remote(_), false) => vec![Checkout, NewFrom, Compare, Delete],
    }
}

/// The popup's list delegate.
pub struct BranchList {
    pub rows: Vec<BranchRow>,
    /// Local branch names (a remote checkout reuses one of them).
    pub local: Vec<String>,
    /// HEAD when the popup opened (Compare with Current's range).
    pub head: Head,
    pub toolbar: WeakEntity<ToolbarView>,
}

impl ListSource for BranchList {
    fn len(&self) -> usize {
        self.rows.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        match &self.rows[ix] {
            // captions never match: a search shows only actions and branches
            BranchRow::Caption { .. } => SharedString::default(),
            r => SharedString::from(r.label().to_owned()),
        }
    }

    fn selectable(&self, ix: usize) -> bool {
        !matches!(self.rows[ix], BranchRow::Caption { .. })
    }
}

impl ListDelegate for BranchList {
    fn options(&self) -> ListOptions {
        ListOptions::menu()
    }

    /// → opens the branch's submenu, as WebStorm's popup does (ä types into the filter).
    fn on_key(
        &mut self,
        key: &str,
        state: &mut ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> bool {
        let Some(ix) = state.cursor().filter(|_| key == "<Right>") else {
            return false;
        };
        if !matches!(self.rows[ix], BranchRow::Branch { .. }) {
            return false;
        }
        self.confirm(ix, state, window, cx);
        true
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let text_color = if row.selected && row.focused {
            look::SELECTION_TEXT
        } else {
            look::TEXT
        };
        match &self.rows[ix] {
            BranchRow::Caption { title, line } => caption(title, *line),
            r => {
                let icon = match r {
                    BranchRow::NewBranch => Some(IconName::Add),
                    BranchRow::Branch { current: true, .. } => Some(IconName::CurrentBranch),
                    _ => None,
                };
                // a branch's submenu chevron at the right (WebStorm's popup)
                let chevron = matches!(r, BranchRow::Branch { .. }).then(|| {
                    div()
                        .flex_none()
                        .ml_auto()
                        .child(Icon::new(IconName::ChevronRight))
                });
                div()
                    .flex()
                    .items_center()
                    .size_full()
                    .min_w_0()
                    .on_mouse_up(MouseButton::Left, click_confirms(ix, cx))
                    .gap(px(look::TREE_ICON_GAP + 4.))
                    .text_color(text_color)
                    .child(
                        div()
                            .size(px(look::ICON_SIZE))
                            .flex_none()
                            .when_some(icon, |d, i| d.child(Icon::new(i))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(match_text(r.label().to_owned(), row.matches)),
                    )
                    .children(chevron)
                    .into_any_element()
            }
        }
    }

    fn confirm(
        &mut self,
        ix: usize,
        _state: &ListState,
        window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) {
        let row = self.rows[ix].clone();
        let local = self.local.clone();
        let toolbar = self.toolbar.clone();
        // the toolbar replaces this popup: not while the list is being updated
        window.defer(cx, move |window, cx| {
            let _ = toolbar.update(cx, |t, cx| match row {
                BranchRow::NewBranch => t.open_new_branch(window, cx),
                BranchRow::Branch { target, current } => {
                    t.branch_actions(ix, target, current, local, window, cx)
                }
                BranchRow::Caption { .. } => {}
            });
        });
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<ListView<Self>>) {
        let toolbar = self.toolbar.clone();
        window.defer(cx, move |window, cx| {
            let _ = toolbar.update(cx, |t, cx| t.close_popup(window, cx));
        });
    }
}

const SEPARATOR_OUTSET: f32 =
    look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X - look::POPUP_SEPARATOR_INSET_X;

/// A group caption: dim small text, a line above it unless it's first.
fn caption(title: &str, line: bool) -> AnyElement {
    div()
        .relative()
        .size_full()
        .flex()
        .items_center()
        // the row's content inset is the list's; captions sit at the popup's caption inset
        .ml(px(look::POPUP_CAPTION_PADDING_X
            - look::LIST_ROW_INSET_X
            - look::LIST_ROW_PADDING_X))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::POPUP_CAPTION_FG)
        .when(line, |d| {
            d.child(
                div()
                    .absolute()
                    .top_0()
                    // from the content inset out to the separator inset on both sides
                    .left(px(-SEPARATOR_OUTSET))
                    .right(px(-SEPARATOR_OUTSET))
                    .h(px(1.))
                    .bg(look::SEPARATOR),
            )
        })
        .child(SharedString::from(title.to_owned()))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_actions_as_webstorm_lists_them() {
        use BranchAction::*;
        let local = Target::Local("feat".into());
        let remote = Target::Remote("origin/feat".into());
        assert_eq!(
            actions(&local, false),
            [Checkout, NewFrom, Compare, Rename, Delete]
        );
        assert_eq!(
            actions(&remote, false),
            [Checkout, NewFrom, Compare, Delete]
        );
        assert_eq!(actions(&local, true), [NewFrom, Rename]);
        assert_eq!(NewFrom.label("feat"), "New Branch from 'feat'…");
    }

    #[test]
    fn groups_in_webstorm_order() {
        let b = Branches {
            local: vec!["feat".into(), "master".into()],
            remote: vec!["origin/master".into()],
            recent: vec!["master".into()],
        };
        let r = rows(&b, &Head::Branch("master".into()));
        let labels: Vec<&str> = r.iter().map(BranchRow::label).collect();
        assert_eq!(
            labels,
            [
                "New Branch…",
                "Recent",
                "master",
                "Local",
                "feat",
                "master",
                "Remote",
                "origin/master"
            ]
        );
        assert!(matches!(r[2], BranchRow::Branch { current: true, .. }));
        assert!(matches!(r[4], BranchRow::Branch { current: false, .. }));
        // detached: nothing is current
        let r = rows(&b, &Head::Detached("0123abcd".into()));
        assert!(
            !r.iter()
                .any(|r| matches!(r, BranchRow::Branch { current: true, .. }))
        );
    }
}
