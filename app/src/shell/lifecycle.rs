//! A workspace's lifecycle as the person sees it: Stop, Delete and Close are three things.
//! A rail tile's menu and the dialog that says what is lost before Delete:
//! Delete working files? (W-35), Cancel the default. Pure builders: the projects window gathers
//! the facts off the UI thread and runs the answer. (Its agent is a 2.2 session, `abe serve`'s.)

use crate::git::Loss;

use crate::look;
use crate::popups::{Button, Check, Dialog, Look, Row, Section};
use crate::popups::{MenuEntry, MenuItem};

/// A rail tile's menu (a right-click on a workspace's tile, ⌘⏎ over it): Story (its Card page),
/// Open in Finder, Stop the session…, then Delete Working Files… and Close the workspace apart
/// at the bottom.
pub const TILE_MENU: [&str; 5] = [
    "Story",
    "Open in Finder",
    "Stop the session…",
    "Delete Working Files…",
    "Close the workspace",
];

/// [`TILE_MENU`] as menu entries; `card`: it is a card's (Abe has no story); `session`: its
/// session is known; `closable`: not the main checkout (Abe never closes).
pub fn tile_menu(card: bool, session: bool, closable: bool) -> Vec<MenuEntry> {
    vec![
        MenuItem::new(TILE_MENU[0])
            .enabled(card)
            .shortcut("⌃3")
            .into(),
        MenuItem::new(TILE_MENU[1]).into(),
        MenuItem::new(TILE_MENU[2]).enabled(session).into(),
        MenuEntry::Separator,
        MenuItem::new(TILE_MENU[3]).enabled(closable).into(),
        MenuItem::new(TILE_MENU[4]).enabled(closable).into(),
    ]
}

/// The menu row chosen ([`crate::popups::open_menu`]'s index counts the separator too) as its
/// label in [`TILE_MENU`].
pub fn tile_menu_choice(choice: usize) -> Option<&'static str> {
    let ix = match choice {
        0..=2 => choice,
        4 | 5 => choice - 1,
        _ => return None,
    };
    TILE_MENU.get(ix).copied()
}

/// Stop the session? (a tile's menu): the agent stops, the workspace stays; Cancel the default.
pub fn stop_dialog(name: &str) -> Dialog {
    Dialog {
        id: "stop-session",
        title: "Stop the session?".into(),
        subtitle: Some(name.to_owned().into()),
        width: look::FLOW_WIDTH_DELETE,
        note: Some("The workspace and its files stay".into()),
        buttons: vec![
            Button::new("stop", "Stop the session", Look::Danger).key("s"),
            Button::new("cancel", "Cancel", Look::Primary).key("⏎"),
        ],
        ..Default::default()
    }
}

fn plural(n: usize, one: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {one}s")
    }
}

/// The colour a file's status letter gets (the tree's Git colours).
fn file_colour(mark: char) -> gpui_kit::Rgba {
    match mark {
        'A' => look::GIT_ADDED.rgba(),
        '?' => look::GIT_UNTRACKED.rgba(),
        'D' => look::GIT_DELETED.rgba(),
        _ => look::GIT_MODIFIED.rgba(),
    }
}

/// W-35: Delete working files? The uncommitted files (lost), the commits no remote has (Also
/// delete branch, off) and the workspace's session while it runs (`session`: its state word, as
/// the feed says it: `abe serve`'s, stopped from its Chat, never here). Cancel is the default; `d`
/// deletes.
pub fn delete_dialog(name: &str, loss: &Loss, session: Option<&str>) -> Dialog {
    let mut sections = Vec::new();
    if !loss.files.is_empty() {
        sections.push(Section {
            heading: "Uncommitted changes".into(),
            note: Some(format!("{} · lost", plural(loss.files.len(), "file")).into()),
            rows: loss
                .files
                .iter()
                .map(|(mark, path)| Row {
                    name: path.clone().into(),
                    mono: true,
                    name_color: Some(file_colour(*mark)),
                    end: Some((mark.to_string().into(), Some(file_colour(*mark)))),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });
    }
    if !loss.commits.is_empty() || loss.branch.is_some() {
        let n = loss.commits.len();
        sections.push(Section {
            heading: "Commits not on the remote".into(),
            note: Some(n.to_string().into()),
            rows: loss
                .commits
                .iter()
                .map(|(hash, subject)| Row {
                    name: hash.clone().into(),
                    mono: true,
                    name_color: Some(look::ABE_ACCENT.rgba()),
                    meta: Some(subject.clone().into()),
                    end: Some(("not pushed".into(), None)),
                    ..Default::default()
                })
                .collect(),
            check: loss.branch.as_ref().map(|b| Check {
                label: "Also delete branch".into(),
                value: Some(b.clone().into()),
                detail: Some(if n == 0 {
                    "off: the branch stays".into()
                } else {
                    format!("off: the {} stay on it", plural(n, "commit")).into()
                }),
            }),
            ..Default::default()
        });
    }
    if let Some(word) = session {
        sections.push(Section {
            heading: "Running".into(),
            note: Some("1".into()),
            rows: vec![Row {
                name: "Its session".into(),
                meta: Some(word.to_owned().into()),
                end: Some(("keeps running · stop it from Chat first".into(), None)),
                ..Default::default()
            }],
            ..Default::default()
        });
    }
    if sections.is_empty() {
        sections.push(Section {
            heading: "Nothing is lost".into(),
            text: Some("No uncommitted files, every commit is on the remote.".into()),
            ..Default::default()
        });
    }
    let lossy = !loss.files.is_empty() || !loss.commits.is_empty();
    Dialog {
        id: "delete-working-files",
        title: "Delete working files?".into(),
        subtitle: Some(name.to_owned().into()),
        width: look::FLOW_WIDTH_DELETE,
        sections,
        note: lossy.then(|| "Commit and push first to keep the changes".into()),
        buttons: vec![
            Button::new("delete", "Delete working files", Look::Danger).key("d"),
            Button::new("cancel", "Cancel", Look::Primary).key("⏎"),
        ],
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tile_menu_keeps_delete_and_close_apart_at_the_bottom() {
        let rows: Vec<String> = tile_menu(true, true, true)
            .into_iter()
            .map(|e| match e {
                MenuEntry::Separator => "—".into(),
                MenuEntry::Item(i) => i.label.to_string(),
                MenuEntry::Info(t) => t.to_string(),
            })
            .collect();
        assert_eq!(
            rows,
            [
                "Story",
                "Open in Finder",
                "Stop the session…",
                "—",
                "Delete Working Files…",
                "Close the workspace"
            ]
        );
        assert_eq!(tile_menu_choice(2), Some("Stop the session…"));
        assert_eq!(tile_menu_choice(4), Some("Delete Working Files…"));
        assert_eq!(tile_menu_choice(5), Some("Close the workspace"));
        assert_eq!(tile_menu_choice(3), None);
    }

    #[test]
    fn delete_names_what_is_lost_and_cancel_is_the_default() {
        let loss = Loss {
            files: vec![
                ('M', "src/checkout/copy.ts".into()),
                ('?', "notes/nordic-copy.md".into()),
            ],
            commits: vec![("4d8b2e7".into(), "Copy for Nordic markets".into())],
            branch: Some("abe/AB-1240-checkout-copy".into()),
        };
        let d = delete_dialog("AB-1240 checkout copy", &loss, Some("Running"));
        let heads: Vec<String> = d.sections.iter().map(|s| s.heading.to_string()).collect();
        assert_eq!(
            heads,
            [
                "Uncommitted changes",
                "Commits not on the remote",
                "Running"
            ]
        );
        let quiet = delete_dialog("AB-1240 checkout copy", &loss, None);
        assert_eq!(quiet.sections.len(), 2);
        assert_eq!(d.sections[0].note.as_deref(), Some("2 files · lost"));
        let check = d.sections[1].check.as_ref().unwrap();
        assert_eq!(check.value.as_deref(), Some("abe/AB-1240-checkout-copy"));
        assert_eq!(
            check.detail.as_deref(),
            Some("off: the 1 commit stay on it")
        );
        let looks: Vec<(&str, Look, Option<&str>)> = d
            .buttons
            .iter()
            .map(|b| (b.id, b.look, b.key.as_deref()))
            .collect();
        assert_eq!(
            looks,
            [
                ("delete", Look::Danger, Some("d")),
                ("cancel", Look::Primary, Some("⏎"))
            ]
        );
    }
}
