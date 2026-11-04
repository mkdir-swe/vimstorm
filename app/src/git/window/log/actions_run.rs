//! The git side of the Log's actions: confirmations and inputs (Lua's `vim.ui.select` /
//! `vim.ui.input` as native popups), git off the UI thread, the outcome's balloon, then Lua's
//! `checktime` + `git.cli.changed()` (as `git/cli.lua` `act`: buffers reload, the tabs refresh).

use std::path::Path;
use std::rc::Rc;

use gpui_kit::{App, Context, Window};

use super::{CommitRef, LogTab};
use crate::git::branches::{self, FilterRefs, Target};
use crate::git::cli;
use crate::git::ops::{self, Level, Outcome, ResetMode};
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::popups::{self, Balloon, Input, Menu, MenuEntry, MenuItem};

/// New Branch… / New Tag… at a commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NewRef {
    Branch,
    Tag,
}

/// The checkout picker's rows: Lua `branches.list()` order (local, remote, tags).
#[derive(Clone, Debug, PartialEq, Eq)]
enum RefKind {
    Local,
    Remote,
    Tag,
}

/// An action's result as its balloon (Lua's `vim.notify` level and title).
fn balloon(o: &Outcome) -> Balloon {
    let level = match o.level {
        Level::Info => popups::Level::Info,
        Level::Warn => popups::Level::Warning,
        Level::Error => popups::Level::Error,
    };
    Balloon::new(level, o.title.clone(), o.message.clone())
}

/// Lua `confirm(prompt, yes, fn)`: a menu titled `prompt` with `yes` / Cancel.
fn confirm(
    prompt: String,
    yes: &'static str,
    anchor: Anchor,
    w: &mut Window,
    cx: &mut App,
    then: impl FnOnce(&mut Window, &mut App) + 'static,
) {
    let menu = Menu::new(
        vec![MenuItem::new(yes).into(), MenuItem::new("Cancel").into()],
        anchor,
    )
    .title(prompt);
    popups::open_menu(menu, w, cx, move |choice, w, cx| {
        if choice == Some(0) {
            then(w, cx);
        }
    });
}

/// Cherry-picks `hashes` in order, stopping at the first failure (its error is the balloon).
pub(super) fn cherry_pick_all(root: &Path, hashes: &[String]) -> Outcome {
    let mut last = Outcome::refused(Level::Info, "Nothing to cherry-pick");
    for h in hashes {
        last = ops::cherry_pick_blocking(root, h);
        if !last.ok {
            return last;
        }
    }
    if hashes.len() > 1 {
        Outcome::done(format!("Cherry-picked {} commits", hashes.len()))
    } else {
        last
    }
}

impl LogTab {
    /// Runs a repo-changing `job` off the UI thread: its balloon, then Lua reloads buffers and
    /// every git listener (this tab's log included).
    pub(super) fn act(
        &mut self,
        job: impl FnOnce(&Path) -> Outcome + Send + 'static,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let task = crate::git::job::spawn(cx, move || job(&root));
        let scx = self.gcx.scx.clone();
        cx.spawn_in(w, async move |_, cx| {
            let outcome = task.await;
            let _ = cx.update(|w, cx| {
                scx.notify(balloon(&outcome), w, cx);
                // config/app/git_changes.lua `changed`: checktime + git.cli.changed()
                crate::git::window::changes::lua_changed(&scx);
            });
        })
        .detach();
    }

    /// Reset Current Branch to Here…: Soft / Mixed / Hard; Hard asks first (Lua).
    pub(super) fn reset_popup(
        &mut self,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        const MODES: [ResetMode; 3] = [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard];
        let entries: Vec<MenuEntry> = MODES
            .iter()
            .map(|m| MenuItem::new(m.label()).into())
            .collect();
        let menu = Menu::new(entries, anchor).title(format!("Reset to {}", c.short()));
        let this = cx.entity().downgrade();
        popups::open_menu(menu, w, cx, move |choice, w, cx| {
            let Some(&mode) = choice.and_then(|ix| MODES.get(ix)) else {
                return;
            };
            let run = move |w: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |t, cx| {
                    t.act(move |root| ops::reset_blocking(root, &c.hash, mode), w, cx)
                });
            };
            if mode == ResetMode::Hard {
                confirm(
                    "Discard all local changes?".into(),
                    "Reset hard",
                    anchor,
                    w,
                    cx,
                    run,
                );
            } else {
                run(w, cx);
            }
        });
    }

    /// Reword…: a new subject (the body stays); nothing when empty or unchanged (Lua).
    pub(super) fn reword_popup(
        &mut self,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = Input::new("New commit message", c.subject.clone(), anchor);
        let this = cx.entity().downgrade();
        popups::open_input(input, w, cx, move |text, w, cx| {
            let Some(subject) = text.filter(|s| !s.trim().is_empty() && *s != c.subject) else {
                return;
            };
            let _ = this.update(cx, |t, cx| {
                t.act(
                    move |root| ops::reword_subject_blocking(root, &c.hash, &subject),
                    w,
                    cx,
                )
            });
        });
    }

    /// Uncommit (keep changes): asks when it takes back more than one commit (Lua).
    pub(super) fn uncommit(
        &mut self,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let hash = c.hash.clone();
        let count = crate::git::job::spawn(cx, move || ops::uncommit_count_blocking(&root, &hash));
        cx.spawn_in(w, async move |this, cx| {
            let n = count.await;
            let weak = this.clone();
            let _ = this.update_in(cx, |t, w, cx| {
                let hash = c.hash;
                if n > 1 {
                    confirm(
                        format!("Uncommit {n} commits?"),
                        "Uncommit",
                        anchor,
                        w,
                        cx,
                        move |w, cx| {
                            let _ = weak.update(cx, |t, cx| {
                                t.act(move |root| ops::uncommit_blocking(root, &hash), w, cx)
                            });
                        },
                    );
                } else {
                    t.act(move |root| ops::uncommit_blocking(root, &hash), w, cx);
                }
            });
        })
        .detach();
    }

    /// Drop Commit: "Drop <hash8> <subject>?" first (Lua).
    pub(super) fn drop_commit(
        &mut self,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prompt = format!("Drop {} {}?", c.short(), c.subject);
        let this = cx.entity().downgrade();
        confirm(prompt, "Drop", anchor, w, cx, move |w, cx| {
            let _ = this.update(cx, |t, cx| {
                t.act(move |root| ops::drop_blocking(root, &c.hash), w, cx)
            });
        });
    }

    /// New Branch… (checked out, WS's dialog default) / New Tag… (lightweight) at the commit.
    /// A branch name git or the existing branches refuse: a warning balloon, nothing made.
    pub(super) fn new_ref_popup(
        &mut self,
        kind: NewRef,
        c: CommitRef,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let title = match kind {
            NewRef::Branch => "New Branch",
            NewRef::Tag => "New Tag",
        };
        let this = cx.entity().downgrade();
        popups::open_input(Input::new(title, "", anchor), w, cx, move |text, w, cx| {
            let Some(name) = text.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
                return;
            };
            let _ = this.update(cx, |t, cx| {
                t.act(
                    move |root| match kind {
                        NewRef::Branch => {
                            let local = branches::filter_refs_blocking(root)
                                .map(|r| r.local)
                                .unwrap_or_default();
                            match branches::validate_new(root, &name, &local) {
                                Some(why) => Outcome::refused(Level::Warn, why),
                                None => ops::new_branch_blocking(root, &name, &c.hash, true),
                            }
                        }
                        NewRef::Tag => ops::new_tag_blocking(root, &name, &c.hash, None),
                    },
                    w,
                    cx,
                )
            });
        });
    }

    /// c / Checkout Branch…: Lua's "Checkout branch" picker (local, remote, tags; `/` searches),
    /// then "Checkout <ref>?"; a remote branch becomes a local tracking branch, a tag detaches.
    pub(super) fn checkout_menu(&mut self, anchor: Anchor, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(refs) = self.branches.refs.clone() {
            self.open_checkout(refs, anchor, w, cx);
            return;
        }
        let Some(root) = self.gcx.root() else {
            return;
        };
        let task = crate::git::job::spawn(cx, move || branches::filter_refs_blocking(&root));
        cx.spawn_in(w, async move |this, cx| {
            let refs = task.await;
            let _ = this.update_in(cx, |t, w, cx| match refs {
                Ok(refs) => t.open_checkout(Rc::new(refs), anchor, w, cx),
                Err(e) => {
                    t.gcx
                        .scx
                        .notify(Balloon::error("git for-each-ref", e.to_string()), w, cx)
                }
            });
        })
        .detach();
    }

    fn open_checkout(
        &mut self,
        refs: Rc<FilterRefs>,
        anchor: Anchor,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut entries: Vec<MenuEntry> = Vec::new();
        let mut rows: Vec<Option<(String, RefKind)>> = Vec::new();
        let groups = [
            (&refs.local, RefKind::Local),
            (&refs.remote, RefKind::Remote),
            (&refs.tags, RefKind::Tag),
        ];
        for (names, kind) in groups {
            if names.is_empty() {
                continue;
            }
            if !entries.is_empty() {
                entries.push(MenuEntry::Separator);
                rows.push(None);
            }
            for name in names {
                let icon = match kind {
                    RefKind::Tag => IconName::Tag,
                    _ if refs.current.as_deref() == Some(name.as_str()) => IconName::CurrentBranch,
                    _ => IconName::Branch,
                };
                entries.push(MenuItem::new(name.clone()).icon(icon).into());
                rows.push(Some((name.clone(), kind.clone())));
            }
        }
        if entries.is_empty() {
            return;
        }
        let mut menu = Menu::new(entries, anchor).title("Checkout branch");
        menu.max_rows = Some(20);
        let current = refs.current.clone();
        let local = refs.local.clone();
        let this = cx.entity().downgrade();
        popups::open_menu(menu, w, cx, move |choice, w, cx| {
            let Some((name, kind)) = choice.and_then(|ix| rows.get(ix).cloned().flatten()) else {
                return;
            };
            // the current branch: nothing to do (Lua)
            if kind == RefKind::Local && current.as_deref() == Some(name.as_str()) {
                return;
            }
            confirm(
                format!("Checkout {name}?"),
                "Checkout",
                anchor,
                w,
                cx,
                move |w, cx| {
                    let _ = this.update(cx, |t, cx| {
                        t.act(move |root| checkout(root, &name, &kind, &local), w, cx)
                    });
                },
            );
        });
    }

    /// Go to Hash / Branch / Tag: the commit it names selected in the log, else a balloon.
    pub(super) fn go_to_ref(&mut self, anchor: Anchor, w: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let this = cx.entity().downgrade();
        let input = Input::new("Go to Hash/Branch/Tag", "", anchor);
        popups::open_input(input, w, cx, move |text, w, cx| {
            let Some(name) = text.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) else {
                return;
            };
            let _ = this.update(cx, |_, cx| {
                let task = crate::git::job::spawn(cx, move || {
                    let spec = format!("{name}^{{commit}}");
                    let hash =
                        cli::run_blocking(&root, ["rev-parse", "--verify", "--quiet", &spec])
                            .ok()
                            .filter(cli::Output::ok)
                            .map(|o| o.stdout.trim().to_owned())
                            .filter(|h| !h.is_empty());
                    (name, hash)
                });
                cx.spawn_in(w, async move |this, cx| {
                    let (name, hash) = task.await;
                    let _ = this.update_in(cx, |t, w, cx| match hash {
                        Some(hash) => t.show_commit(hash, w, cx),
                        // WS vcs.log.commit.or.reference.not.found
                        None => t.gcx.scx.clone().notify(
                            Balloon::new(
                                popups::Level::Warning,
                                "Git",
                                format!("Commit or reference '{name}' not found"),
                            ),
                            w,
                            cx,
                        ),
                    });
                })
                .detach();
            });
        });
    }
}

/// Lua `git/branches.lua` `checkout`: local -> switch, remote -> the local branch or a new
/// tracking one, tag -> detached.
fn checkout(root: &Path, name: &str, kind: &RefKind, local: &[String]) -> Outcome {
    let target = match kind {
        RefKind::Tag => return ops::checkout_tag_blocking(root, name),
        RefKind::Local => Target::Local(name.to_owned()),
        RefKind::Remote => Target::Remote(name.to_owned()),
    };
    match branches::checkout_blocking(root, &target, local) {
        Ok(msg) => Outcome::done(msg),
        Err(e) => Outcome::failed("switch", e),
    }
}
