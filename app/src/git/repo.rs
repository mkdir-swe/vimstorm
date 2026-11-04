//! The repo's state for the Git tool window: root, git dir, HEAD (branch / detached / unborn), an
//! operation in progress (merge / rebase / cherry-pick / revert / bisect) and the upstream with
//! ahead / behind counts.

use std::path::{Path, PathBuf};

use super::cli;

/// What HEAD is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeadState {
    /// On a branch with commits.
    Branch(String),
    /// On a branch without commits yet.
    Unborn(String),
    /// Detached at a commit (full hash).
    Detached(String),
}

impl HeadState {
    pub fn branch(&self) -> Option<&str> {
        match self {
            HeadState::Branch(b) | HeadState::Unborn(b) => Some(b),
            HeadState::Detached(_) => None,
        }
    }

    /// The status bar / widget text: the branch, or the 8-char hash when detached (WS).
    pub fn label(&self) -> &str {
        match self {
            HeadState::Branch(b) | HeadState::Unborn(b) => b,
            HeadState::Detached(h) => &h[..h.len().min(8)],
        }
    }
}

/// An operation git is in the middle of (files in the git dir).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

/// The current branch's upstream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upstream {
    /// `origin/master`.
    pub name: String,
    /// `origin`.
    pub remote: String,
    /// The upstream ref is gone (deleted on the remote, fetched with prune).
    pub gone: bool,
    pub ahead: u32,
    pub behind: u32,
}

/// One read of the repo's state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoState {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    pub head: HeadState,
    pub operation: Option<Operation>,
    pub upstream: Option<Upstream>,
    /// Remote names (`git remote`).
    pub remotes: Vec<String>,
}

/// The operation in progress, from the git dir's marker files.
pub fn operation_in(git_dir: &Path) -> Option<Operation> {
    let has = |f: &str| git_dir.join(f).exists();
    if has("rebase-merge") || has("rebase-apply") {
        Some(Operation::Rebase)
    } else if has("MERGE_HEAD") {
        Some(Operation::Merge)
    } else if has("CHERRY_PICK_HEAD") {
        Some(Operation::CherryPick)
    } else if has("REVERT_HEAD") {
        Some(Operation::Revert)
    } else if has("BISECT_LOG") {
        Some(Operation::Bisect)
    } else {
        None
    }
}

/// `%(upstream:short)\0%(upstream:remotename)\0%(upstream:track,nobracket)` -> upstream.
pub fn parse_upstream(line: &str) -> Option<Upstream> {
    let mut f = line.trim_end_matches('\n').split('\0');
    let name = f.next().filter(|n| !n.is_empty())?.to_owned();
    let remote = f.next().unwrap_or("").to_owned();
    let track = f.next().unwrap_or("");
    let mut u = Upstream {
        name,
        remote,
        gone: track == "gone",
        ahead: 0,
        behind: 0,
    };
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            u.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            u.behind = n.parse().unwrap_or(0);
        }
    }
    Some(u)
}

/// Reads the state of the repo `dir` is in (None outside a repo). Blocking.
pub fn read_blocking(dir: &Path) -> Option<RepoState> {
    let out =
        cli::run_blocking(dir, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).ok()?;
    if !out.ok() {
        return None;
    }
    let mut lines = out.stdout.lines();
    let root = PathBuf::from(lines.next()?);
    let git_dir = PathBuf::from(lines.next()?);
    let head = match cli::run_blocking(&root, ["symbolic-ref", "-q", "--short", "HEAD"]) {
        Ok(o) if o.ok() => {
            let b = o.stdout.trim().to_owned();
            let born = cli::run_blocking(&root, ["rev-parse", "--verify", "-q", "HEAD"])
                .is_ok_and(|o| o.ok());
            if born {
                HeadState::Branch(b)
            } else {
                HeadState::Unborn(b)
            }
        }
        _ => {
            let h = cli::run_blocking(&root, ["rev-parse", "HEAD"]).ok()?;
            HeadState::Detached(h.stdout.trim().to_owned())
        }
    };
    let upstream = head.branch().and_then(|b| {
        let o = cli::run_blocking(
            &root,
            [
                "for-each-ref",
                "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:track,nobracket)",
                &format!("refs/heads/{b}"),
            ],
        )
        .ok()?;
        parse_upstream(&o.stdout)
    });
    let remotes = cli::run_blocking(&root, ["remote"])
        .map(|o| o.stdout.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    Some(RepoState {
        operation: operation_in(&git_dir),
        root,
        git_dir,
        head,
        upstream,
        remotes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_tracking() {
        let u = parse_upstream("origin/master\0origin\0ahead 5, behind 2\n").unwrap();
        assert_eq!(u.name, "origin/master");
        assert_eq!(u.remote, "origin");
        assert_eq!((u.ahead, u.behind, u.gone), (5, 2, false));
        let u = parse_upstream("origin/x\0origin\0gone").unwrap();
        assert!(u.gone);
        assert_eq!(parse_upstream("\0\0\n"), None);
        assert_eq!(HeadState::Detached("0123456789".into()).label(), "01234567");
    }
}
