//! A light poll of the repo's git dir while the Git tool window is shown: HEAD, the index, refs and
//! reflogs (the tree's watcher approach: mtimes read off the UI thread every [`POLL`]). Catches
//! commits / checkouts / fetches made outside nvim (a terminal, another app).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use gpui_kit::{Context, Task, Window};

use super::{GitView, RepoChange};

pub const POLL: Duration = Duration::from_millis(1000);

/// The git dir of a work tree: `.git`, or the `gitdir:` a `.git` file (worktree, submodule)
/// points to.
pub fn git_dir(root: &Path) -> PathBuf {
    let dot = root.join(".git");
    if dot.is_file()
        && let Ok(text) = std::fs::read_to_string(&dot)
        && let Some(dir) = text.trim().strip_prefix("gitdir:")
    {
        let dir = PathBuf::from(dir.trim());
        return if dir.is_absolute() {
            dir
        } else {
            root.join(dir)
        };
    }
    dot
}

/// The files / folders whose mtimes say the repo changed. A worktree's HEAD / index / reflog live
/// in its own git dir, refs in the common one.
pub fn watched(git_dir: &Path) -> Vec<PathBuf> {
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|c| {
            let c = PathBuf::from(c.trim());
            if c.is_absolute() { c } else { git_dir.join(c) }
        })
        .unwrap_or_else(|| git_dir.to_path_buf());
    let mut out: Vec<PathBuf> = ["HEAD", "index", "logs/HEAD", "MERGE_HEAD", "ORIG_HEAD"]
        .iter()
        .map(|p| git_dir.join(p))
        .collect();
    out.extend(
        [
            "packed-refs",
            "FETCH_HEAD",
            "refs/heads",
            "refs/tags",
            "refs/remotes",
        ]
        .iter()
        .map(|p| common.join(p)),
    );
    out
}

/// The mtimes of `paths` (None: missing).
pub fn snapshot(paths: &[PathBuf]) -> Vec<Option<SystemTime>> {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .collect()
}

pub struct Watch {
    root: Option<PathBuf>,
    task: Option<Task<()>>,
}

impl Watch {
    pub fn new() -> Self {
        Watch {
            root: None,
            task: None,
        }
    }

    pub fn set_root(&mut self, root: PathBuf) {
        if self.root.as_ref() != Some(&root) {
            self.root = Some(root);
            // a running poll watches the old repo
            self.task = None;
        }
    }

    pub fn stop(&mut self) {
        self.task = None;
    }

    pub fn running(&self) -> bool {
        self.task.is_some()
    }

    /// Starts polling (no-op when running or without a root). The first poll only notes the
    /// state; a change after it refreshes the view's tabs.
    pub fn start(&mut self, window: &mut Window, cx: &mut Context<GitView>) {
        if self.task.is_some() {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        let exec = cx.background_executor().clone();
        self.task = Some(cx.spawn_in(window, async move |this, cx| {
            let paths = exec.spawn(async move { watched(&git_dir(&root)) }).await;
            let mut seen: Option<Vec<Option<SystemTime>>> = None;
            loop {
                let p = paths.clone();
                let now = exec.spawn(async move { snapshot(&p) }).await;
                if seen.as_ref().is_some_and(|s| *s != now)
                    && this
                        .update_in(cx, |v, window, cx| v.refresh(RepoChange::Files, window, cx))
                        .is_err()
                {
                    return;
                }
                seen = Some(now);
                exec.timer(POLL).await;
            }
        }));
    }
}

impl Default for Watch {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dir_follows_a_gitdir_file_and_lists_refs_in_the_common_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("wt");
        let real = tmp.path().join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(root.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        std::fs::write(real.join("commondir"), "../..\n").unwrap();
        assert_eq!(git_dir(&root), real);
        let w = watched(&real);
        assert!(w.contains(&real.join("HEAD")));
        assert!(w.contains(&real.join("../..").join("refs/heads")));
        // a plain repo
        let plain = tmp.path().join("p");
        std::fs::create_dir_all(plain.join(".git")).unwrap();
        assert_eq!(git_dir(&plain), plain.join(".git"));
        let before = snapshot(&[plain.join(".git/HEAD")]);
        assert_eq!(before, vec![None]);
        std::fs::write(plain.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_ne!(snapshot(&[plain.join(".git/HEAD")]), before);
    }
}
