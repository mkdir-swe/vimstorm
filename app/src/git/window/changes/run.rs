//! Repo-changing git actions of the Local Changes tab (commit, rollback, push, pull, fetch,
//! ...): run off the UI thread, a progress balloon ("Committing…") when one takes
//! over half a second (like `git/cli.lua` `act`'s timer) or right away (Lua's "Pushing…"), the result's
//! balloon (`Outcome`: Lua's `vim.notify` texts and titles), then Lua reloads the buffers and
//! every git listener (`config/app/git_changes.lua` `changed`: checktime + `git.cli.changed()`,
//! which also refreshes the Git tool window's tabs).

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{AppContext as _, Context, Window};

use crate::git::ops::{Level, Outcome};
use crate::popups::{self, Balloon};
use crate::shell::SurfaceCx;

/// `act_async`'s delay before the progress balloon.
pub(crate) const BUSY_AFTER: Duration = Duration::from_millis(500);

/// The Lua side of the tabs.
pub(crate) const LUA: &str = "config.app.git_changes";

/// When the progress balloon shows.
pub(crate) enum Busy {
    None,
    /// Right away (push: Lua's "Pushing…").
    Now(String),
    /// After [`BUSY_AFTER`] if still running (commit hooks, pull, fetch).
    After(String),
}

/// An action's result as its balloon.
pub(crate) fn balloon(o: &Outcome) -> Balloon {
    let level = match o.level {
        Level::Info => popups::Level::Info,
        Level::Warn => popups::Level::Warning,
        Level::Error => popups::Level::Error,
    };
    Balloon::new(level, o.title.clone(), o.message.clone())
}

/// An info balloon titled "Git" (Lua's `vim.notify(msg, INFO, { title = "Git" })`).
pub(crate) fn info(msg: impl Into<String>, window: &mut Window, cx: &mut gpui_kit::App) {
    popups::notify(Balloon::info("Git", msg.into()), window, cx);
}

/// The repo changed under nvim: buffers reload, listeners (status bar, gutters, the tabs) hear it.
pub(crate) fn lua_changed(scx: &SurfaceCx) {
    scx.call(LUA, "changed", vec![]);
}

/// Runs `job` (blocking git) in the background with the busy balloon, then shows its outcome,
/// tells Lua the repo changed and calls `after` on the entity.
pub(crate) fn act<T: 'static, R: Send + 'static>(
    scx: &SurfaceCx,
    busy: Busy,
    job: impl FnOnce() -> (Outcome, R) + Send + 'static,
    window: &mut Window,
    cx: &mut Context<T>,
    after: impl FnOnce(&mut T, &Outcome, R, &mut Window, &mut Context<T>) + 'static,
) {
    let done = Rc::new(Cell::new(false));
    match busy {
        Busy::None => {}
        Busy::Now(text) => scx.notify(Balloon::info("Git", text), window, cx),
        Busy::After(text) => {
            let (done, scx) = (done.clone(), scx.clone());
            let timer = cx.background_executor().timer(BUSY_AFTER);
            cx.spawn_in(window, async move |_, cx| {
                timer.await;
                if !done.get() {
                    let _ =
                        cx.update(|window, cx| scx.notify(Balloon::info("Git", text), window, cx));
                }
            })
            .detach();
        }
    }
    let task = cx.background_spawn(async move { job() });
    let scx = scx.clone();
    cx.spawn_in(window, async move |this, cx| {
        let (outcome, r) = task.await;
        done.set(true);
        let _ = this.update_in(cx, |t, window, cx| {
            scx.notify(balloon(&outcome), window, cx);
            lua_changed(&scx);
            after(t, &outcome, r, window, cx);
            cx.notify();
        });
    })
    .detach();
}

/// Cmd+C in a changes tree: the selected rows' paths (Lua `filetree.lua` `copy`: one per line)
/// and Lua's "Copied <path>" / "Copied N paths" balloon. False: nothing to copy.
pub(crate) fn copy_tree_paths(
    tree: &gpui_kit::Entity<crate::kit::ListView<crate::kit::ChangesTree>>,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) -> bool {
    let paths = {
        let v = tree.read(cx);
        v.delegate.paths(&v.state.selection())
    };
    crate::kit::copy_paths(paths, window, cx)
}
