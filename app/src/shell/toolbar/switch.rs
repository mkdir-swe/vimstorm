//! How the app starts a project's nvim ([`Launcher`]), what closing a project would lose
//! ([`Losses`]) and which closed projects' nvims are still saving ([`quitting`]). The open
//! projects themselves live in [`crate::shell::projects`]: switching keeps every project's
//! nvim running; only closing one quits it (`Quitter`: `wall | qa!`, its VimLeavePre saves the
//! session).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures::channel::oneshot;
use futures::future::Shared;
use gpui_kit::{App, Entity, Global};
use parking_lot::Mutex;
use rmpv::Value;

use crate::nvim::{NvimConfig, NvimEvent, Quitter};
use crate::shell::Workspace;

/// Sees every nvim event (reader thread).
pub type EventHook = Arc<dyn Fn(&NvimEvent) + Send + Sync>;
/// Gets every project workspace the app starts after the first (tests follow them).
pub type OpenHook = Rc<dyn Fn(Entity<Workspace>, &mut App)>;

/// How long a closed project's nvim may take to save and quit: longer than an app quit's
/// `QUIT_TIMEOUT`; nothing waits on it but a reopen of that project.
pub const CLOSE_QUIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How the app starts a project's nvim (main.rs registers it; tests register their own).
#[derive(Clone)]
pub struct Launcher {
    /// The nvim settings of the first window (args without files, env); `project` is replaced.
    pub template: NvimConfig,
    /// Every open project's nvim: app quit / signals save and quit them all.
    pub nvims: OpenNvims,
    /// Sees every event of a new nvim before the workspace does (tests wait on them).
    pub on_event: Option<EventHook>,
    /// Gets every new project workspace (tests follow them).
    pub on_open: Option<OpenHook>,
}

impl Global for Launcher {}

/// The open projects' nvims (by project dir), for quitting them all from any thread.
#[derive(Clone, Default)]
pub struct OpenNvims(
    Arc<Mutex<Vec<(PathBuf, Quitter)>>>,
    Arc<std::sync::atomic::AtomicBool>,
);

impl OpenNvims {
    /// Adds (or replaces) `dir`'s nvim.
    pub fn insert(&self, dir: PathBuf, quitter: Quitter) {
        let mut v = self.0.lock();
        v.retain(|(d, _)| *d != dir);
        v.push((dir, quitter));
    }

    pub fn remove(&self, dir: &Path) {
        self.0.lock().retain(|(d, _)| d != dir);
    }

    /// [`Self::quit_all`] ran: the app is quitting.
    pub fn is_quitting(&self) -> bool {
        self.1.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Saves and quits every nvim, all at once (each killed after `timeout`); blocks until all
    /// are gone. How many there were (none: Welcome).
    pub fn quit_all(&self, timeout: Duration) -> usize {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
        let all: Vec<Quitter> = self.0.lock().iter().map(|(_, q)| q.clone()).collect();
        let n = all.len();
        let threads: Vec<_> = all
            .into_iter()
            .map(|q| std::thread::spawn(move || q.quit(timeout)))
            .collect();
        for t in threads {
            let _ = t.join();
        }
        n
    }
}

/// Done when a closed project's nvim has quit.
pub(crate) type Quit = Shared<oneshot::Receiver<()>>;

/// Closed projects whose nvim is still saving and quitting.
#[derive(Clone, Default)]
pub(crate) struct Quitting(pub(crate) Arc<Mutex<HashMap<PathBuf, Quit>>>);

impl Global for Quitting {}

/// Whether `dir`'s previous nvim (its project was closed) is still saving and quitting (tests).
/// Keyed by the folder's real path, like the open projects.
pub fn quitting(dir: &Path, cx: &App) -> bool {
    let real = crate::shell::recent::real_path(dir);
    cx.try_global::<Quitting>()
        .is_some_and(|q| q.0.lock().contains_key(&real))
}

/// What closing a project would lose (Lua `config.app.toolbar.switch_check`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Losses {
    /// Terminals running something besides their idle shell.
    pub jobs: u64,
    /// Modified buffers `wall` couldn't write (no name, readonly, write error).
    pub unsaved: u64,
}

impl Losses {
    pub(crate) fn from_lua(v: &Value) -> Self {
        let get = |k: &str| crate::nvim::get(v, k).and_then(Value::as_u64).unwrap_or(0);
        Losses {
            jobs: get("jobs"),
            unsaved: get("unsaved"),
        }
    }

    /// The confirmation's question, None when nothing would be lost.
    pub fn question(&self) -> Option<String> {
        let plural = |n: u64, what: &str| crate::kit::plural(n as usize, what);
        let parts: Vec<String> = [
            (self.jobs > 0).then(|| plural(self.jobs, "running terminal job")),
            (self.unsaved > 0).then(|| plural(self.unsaved, "unsaved buffer")),
        ]
        .into_iter()
        .flatten()
        .collect();
        (!parts.is_empty())
            .then(|| format!("Close project? {} will be closed", parts.join(" and ")))
    }
}

/// P-17: closing a project (or quitting, `quit`) would lose work, as the one dialog: what goes
/// (`None`: Neovim didn't answer), Cancel the default (⏎), Close / Quit the risky answer (`y`).
pub fn close_dialog(losses: Option<Losses>, quit: bool, name: &str) -> crate::popups::Dialog {
    use crate::popups::{Button, Dialog, Look, Row, Section};
    let plural = |n: u64, what: &str| crate::kit::plural(n as usize, what);
    let rows = match losses {
        Some(l) => [
            (l.jobs > 0).then(|| Row {
                name: plural(l.jobs, "running terminal job").into(),
                meta: Some("their processes end".into()),
                end: Some(("stop".into(), None)),
                ..Default::default()
            }),
            (l.unsaved > 0).then(|| Row {
                name: plural(l.unsaved, "unsaved buffer").into(),
                meta: Some("Neovim couldn't write them".into()),
                end: Some(("lost".into(), None)),
                ..Default::default()
            }),
        ]
        .into_iter()
        .flatten()
        .collect(),
        None => vec![Row {
            name: "Neovim didn't answer".into(),
            meta: Some("unsaved work may be lost".into()),
            end: Some(("unknown".into(), None)),
            ..Default::default()
        }],
    };
    let (title, verb) = if quit {
        ("Quit VimStorm?", "Quit")
    } else {
        ("Close project?", "Close project")
    };
    Dialog {
        id: if quit { "quit-app" } else { "close-project" },
        title: title.into(),
        subtitle: Some(name.to_owned().into()),
        width: crate::look::FLOW_WIDTH_ARCHIVE,
        sections: vec![Section {
            heading: "What would be lost".into(),
            rows,
            text: Some("Agents keep running; reopening the workspace attaches to them.".into()),
            ..Default::default()
        }],
        buttons: vec![
            Button::new("close", verb, Look::Danger).key("y"),
            Button::new("cancel", "Cancel", Look::Primary).key("⏎"),
        ],
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_close_confirm_is_a_dialog_with_cancel_the_default() {
        let d = close_dialog(
            Some(Losses {
                jobs: 1,
                unsaved: 2,
            }),
            false,
            "shop-web",
        );
        assert_eq!(d.id, "close-project");
        assert_eq!(d.title.as_ref(), "Close project?");
        let ids: Vec<&str> = d.buttons.iter().map(|b| b.id).collect();
        assert_eq!(ids, ["close", "cancel"], "Cancel last, the default");
        assert_eq!(d.buttons[1].key.as_deref(), Some("⏎"));
        assert_eq!(d.buttons[0].key.as_deref(), Some("y"));
        let rows: Vec<&str> = d.sections[0].rows.iter().map(|r| r.name.as_ref()).collect();
        assert_eq!(rows, ["1 running terminal job", "2 unsaved buffers"]);
        let q = close_dialog(None, true, "2 projects");
        assert_eq!(q.title.as_ref(), "Quit VimStorm?");
        assert_eq!(q.sections[0].rows[0].name.as_ref(), "Neovim didn't answer");
    }

    #[test]
    fn question_names_what_is_lost() {
        assert_eq!(Losses::default().question(), None);
        assert_eq!(
            Losses {
                jobs: 1,
                unsaved: 0
            }
            .question()
            .as_deref(),
            Some("Close project? 1 running terminal job will be closed")
        );
        assert_eq!(
            Losses {
                jobs: 2,
                unsaved: 3
            }
            .question()
            .as_deref(),
            Some("Close project? 2 running terminal jobs and 3 unsaved buffers will be closed")
        );
        let lua = Value::Map(vec![
            ("jobs".into(), 0.into()),
            ("unsaved".into(), 1.into()),
        ]);
        assert_eq!(
            Losses::from_lua(&lua),
            Losses {
                jobs: 0,
                unsaved: 1
            }
        );
    }
}
