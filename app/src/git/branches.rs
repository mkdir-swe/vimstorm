//! Branches for the Branches… popup and the Log's Branch filter: HEAD, local / remote branches, recently
//! checked-out ones, checkout and new branch. Like Lua `git/branches.lua` (refs from
//! `for-each-ref`, remote branches checked out as a local tracking branch) plus WebStorm's
//! "Recent" group (the reflog's checkouts). Blocking calls: run them off the UI thread.

use std::path::Path;

use super::cli;

/// What HEAD is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Head {
    /// On a branch (also an unborn one: "No commits yet").
    Branch(String),
    /// Detached: the commit's 8-char hash (WebStorm and `git/status.lua` show it so).
    Detached(String),
    /// Not a git repo.
    None,
}

impl Head {
    pub fn branch(&self) -> Option<&str> {
        match self {
            Head::Branch(b) => Some(b),
            _ => None,
        }
    }
}

/// The repo's branches.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Branches {
    pub local: Vec<String>,
    /// `origin/x` (no `origin/HEAD`).
    pub remote: Vec<String>,
    /// Local branches checked out recently, newest first (the current one included).
    pub recent: Vec<String>,
}

/// How many recent branches the popup lists.
pub const RECENT_MAX: usize = 5;

/// HEAD of the repo at `dir`.
pub fn head_blocking(dir: &Path) -> Head {
    match cli::run_blocking(dir, ["symbolic-ref", "-q", "--short", "HEAD"]) {
        Ok(out) if out.ok() => Head::Branch(out.stdout.trim().to_owned()),
        // exit 1: detached; 128: not a repo
        Ok(out) if out.code == Some(1) => {
            match cli::run_blocking(dir, ["rev-parse", "--short=8", "HEAD"]) {
                Ok(h) if h.ok() => Head::Detached(h.stdout.trim().to_owned()),
                _ => Head::Detached("HEAD".into()),
            }
        }
        _ => Head::None,
    }
}

/// Local and remote branches (by name) and the recent ones.
pub fn load_blocking(dir: &Path) -> anyhow::Result<Branches> {
    let refs = cli::run_blocking(
        dir,
        [
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?
    .into_result()?;
    let mut b = parse_refs(&refs);
    // the reflog can be missing (core.logAllRefUpdates off): no recent group then
    let reflog = cli::run_blocking(dir, ["reflog", "-n", "1000", "--format=%gs", "HEAD"])
        .ok()
        .filter(cli::Output::ok)
        .map(|o| o.stdout)
        .unwrap_or_default();
    let current = head_blocking(dir);
    b.recent = parse_recent(&reflog, &b.local, current.branch());
    Ok(b)
}

/// `for-each-ref --format=%(refname)\t%(refname:short)` -> local / remote, sorted by full ref name
/// (git's own order).
pub fn parse_refs(out: &str) -> Branches {
    let mut b = Branches::default();
    for line in out.lines() {
        let Some((full, short)) = line.split_once('\t') else {
            continue;
        };
        if full.starts_with("refs/heads/") {
            b.local.push(short.to_owned());
        } else if full.starts_with("refs/remotes/")
            && !full.ends_with("/HEAD")
            && short.contains('/')
        {
            b.remote.push(short.to_owned());
        }
    }
    b
}

/// Recent branches from the reflog's `checkout: moving from A to B` subjects (newest first):
/// the current branch first, then the branches moved to / from, existing local ones only.
pub fn parse_recent(reflog: &str, local: &[String], current: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |name: &str| {
        if local.iter().any(|l| l == name) && !out.iter().any(|o| o == name) {
            out.push(name.to_owned());
        }
    };
    if let Some(c) = current {
        push(c);
    }
    for subject in reflog.lines() {
        let Some(rest) = subject.strip_prefix("checkout: moving from ") else {
            continue;
        };
        if let Some((from, to)) = rest.split_once(" to ") {
            push(to.trim());
            push(from.trim());
        }
    }
    out.truncate(RECENT_MAX);
    out
}

/// What to check out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Local(String),
    /// `origin/x`: the local `x` if there is one, else a new branch tracking it.
    Remote(String),
}

/// The git arguments of a checkout and its success message (Lua `git/branches.lua` `checkout`).
pub fn checkout_args(target: &Target, local: &[String]) -> (Vec<String>, String) {
    match target {
        Target::Local(name) => (
            vec!["switch".into(), name.clone()],
            format!("Switched to {name}"),
        ),
        Target::Remote(remote) => {
            let name = remote.split_once('/').map_or(remote.as_str(), |(_, n)| n);
            if local.iter().any(|l| l == name) {
                (
                    vec!["switch".into(), name.into()],
                    format!("Switched to {name}"),
                )
            } else {
                (
                    vec!["switch".into(), "--track".into(), remote.clone()],
                    format!("Checked out {remote} as {name}"),
                )
            }
        }
    }
}

/// Runs a checkout: Ok(message) or Err(git's error text).
pub fn checkout_blocking(dir: &Path, target: &Target, local: &[String]) -> Result<String, String> {
    let (args, msg) = checkout_args(target, local);
    finish(cli::run_blocking(dir, &args), msg)
}

/// Creates `name` from HEAD and checks it out (WebStorm's "New Branch…" with "Checkout branch").
pub fn create_blocking(dir: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Branch name is empty".into());
    }
    finish(
        cli::run_blocking(dir, ["switch", "-c", name]),
        format!("Created and checked out {name}"),
    )
}

/// Creates `name` from `from` (a branch, local or remote) and checks it out (the Branches…
/// popup's "New Branch from '<b>'…").
pub fn create_from_blocking(dir: &Path, name: &str, from: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Branch name is empty".into());
    }
    finish(
        cli::run_blocking(dir, ["switch", "-c", name, from]),
        format!("Created {name} from {from} and checked it out"),
    )
}

/// Renames the local branch `old` to `new` (the popup's "Rename…"; the current one too).
pub fn rename_blocking(dir: &Path, old: &str, new: &str) -> Result<String, String> {
    let new = new.trim();
    if new.is_empty() {
        return Err("Branch name is empty".into());
    }
    finish(
        cli::run_blocking(dir, ["branch", "-m", old, new]),
        format!("Renamed {old} to {new}"),
    )
}

/// A branch's name as git takes it (`origin/x` for a remote one).
pub fn target_name(target: &Target) -> &str {
    match target {
        Target::Local(n) | Target::Remote(n) => n,
    }
}

/// The log range "Compare with Current" shows: the commits on `target` that HEAD lacks
/// (WebStorm's compare dialog's first list), from `HEAD` when detached.
pub fn compare_range(head: &Head, target: &Target) -> String {
    let current = head.branch().unwrap_or("HEAD");
    format!("{current}..{}", target_name(target))
}

/// How many of `target`'s commits HEAD lacks (0: deleting it loses nothing).
pub fn unmerged_blocking(dir: &Path, target: &Target) -> usize {
    let range = format!("HEAD..{}", target_name(target));
    cli::run_blocking(dir, ["rev-list", "--count", range.as_str()])
        .ok()
        .filter(|o| o.ok())
        .and_then(|o| o.stdout.trim().parse().ok())
        .unwrap_or(0)
}

/// The git arguments deleting `target` and the success message: a local branch even when not
/// merged (the popup asked first), a remote one on its remote (`git push <remote> --delete`).
pub fn delete_args(target: &Target) -> (Vec<String>, String) {
    match target {
        Target::Local(n) => (
            vec!["branch".into(), "-D".into(), n.clone()],
            format!("Deleted branch {n}"),
        ),
        Target::Remote(r) => {
            let (remote, name) = r.split_once('/').unwrap_or(("origin", r.as_str()));
            (
                vec!["push".into(), remote.into(), "--delete".into(), name.into()],
                format!("Deleted remote branch {r}"),
            )
        }
    }
}

/// Deletes `target` (see [`delete_args`]).
pub fn delete_blocking(dir: &Path, target: &Target) -> Result<String, String> {
    let (args, msg) = delete_args(target);
    finish(cli::run_blocking(dir, &args), msg)
}

/// Why `name` can't be a new branch (None: fine). Checked as the user types, like WebStorm's
/// dialog: git's ref name rules, existing branches.
pub fn validate_new(dir: &Path, name: &str, local: &[String]) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    if local.iter().any(|l| l == name) {
        return Some(format!("Branch {name} already exists"));
    }
    match cli::run_blocking(dir, ["check-ref-format", "--branch", name]) {
        Ok(out) if out.ok() => None,
        Ok(_) => Some(format!("Invalid branch name: {name}")),
        Err(e) => Some(e.to_string()),
    }
}

fn finish(out: std::io::Result<cli::Output>, msg: String) -> Result<String, String> {
    match out {
        Ok(o) if o.ok() => Ok(msg),
        Ok(o) => {
            let err = if o.stderr.trim().is_empty() {
                o.stdout
            } else {
                o.stderr
            };
            Err(err.trim().to_owned())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Refs for the Log's Branch filter (Lua `git/branches.lua` `load` / `list`): local and remote
/// branches by full ref name, tags newest first (by creator date).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FilterRefs {
    pub local: Vec<String>,
    pub remote: Vec<String>,
    pub tags: Vec<String>,
    /// The current branch (None when detached).
    pub current: Option<String>,
}

impl FilterRefs {
    /// The picker's list after "All" and "HEAD": local, remote, tags.
    pub fn list(&self) -> Vec<String> {
        self.local
            .iter()
            .chain(&self.remote)
            .chain(&self.tags)
            .cloned()
            .collect()
    }
}

/// `for-each-ref --sort=-creatordate --format=%(HEAD)%09%(refname)%09%(refname:short)` -> refs.
pub fn parse_filter_refs(out: &str) -> FilterRefs {
    let mut r = FilterRefs::default();
    let mut local: Vec<(&str, &str)> = Vec::new();
    let mut remote: Vec<(&str, &str)> = Vec::new();
    for line in out.lines() {
        let mut f = line.splitn(3, '\t');
        let (Some(head), Some(full), Some(short)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if full.starts_with("refs/heads/") {
            local.push((full, short));
            if head == "*" {
                r.current = Some(short.to_owned());
            }
        } else if full.starts_with("refs/remotes/") {
            if !short.ends_with("/HEAD") && short.contains('/') {
                remote.push((full, short));
            }
        } else if full.starts_with("refs/tags/") {
            r.tags.push(short.to_owned()); // newest first (the sort)
        }
    }
    local.sort_by_key(|(full, _)| *full);
    remote.sort_by_key(|(full, _)| *full);
    r.local = local.into_iter().map(|(_, s)| s.to_owned()).collect();
    r.remote = remote.into_iter().map(|(_, s)| s.to_owned()).collect();
    r
}

/// The Branch filter's refs. Blocking.
pub fn filter_refs_blocking(dir: &Path) -> anyhow::Result<FilterRefs> {
    let out = cli::run_blocking(
        dir,
        [
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(HEAD)%09%(refname)%09%(refname:short)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?
    .into_result()?;
    Ok(parse_filter_refs(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = cli::run_blocking(dir, args).unwrap();
        assert!(out.ok(), "git {args:?}: {}", out.stderr);
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        git(d, &["init", "-q", "-b", "main"]);
        git(d, &["config", "user.email", "t@example.com"]);
        git(d, &["config", "user.name", "T"]);
        std::fs::write(d.join("a"), "a").unwrap();
        git(d, &["add", "-A"]);
        git(d, &["commit", "-q", "-m", "one"]);
        dir
    }

    #[test]
    fn refs_split_into_local_and_remote() {
        let out = "refs/heads/main\tmain\nrefs/heads/feat/x\tfeat/x\n\
                   refs/remotes/origin/HEAD\torigin\nrefs/remotes/origin/main\torigin/main\n";
        let b = parse_refs(out);
        assert_eq!(b.local, ["main", "feat/x"]);
        assert_eq!(b.remote, ["origin/main"]);
    }

    #[test]
    fn filter_refs_like_the_lua_branches() {
        let out = "*\trefs/heads/zeta\tzeta\n \trefs/tags/v2\tv2\n \trefs/heads/alpha\talpha\n\
                   \trefs/remotes/origin/HEAD\torigin\n \trefs/remotes/origin/b\torigin/b\n\
                   \trefs/tags/v1\tv1\n";
        let r = parse_filter_refs(out);
        assert_eq!(r.local, ["alpha", "zeta"]);
        assert_eq!(r.remote, ["origin/b"]);
        assert_eq!(r.tags, ["v2", "v1"]);
        assert_eq!(r.current.as_deref(), Some("zeta"));
        assert_eq!(r.list(), ["alpha", "zeta", "origin/b", "v2", "v1"]);
    }

    #[test]
    fn recent_from_reflog_checkouts() {
        let local: Vec<String> = ["main", "a", "b", "c"].map(String::from).to_vec();
        let reflog = "commit: x\ncheckout: moving from a to main\ncheckout: moving from b to a\n\
                      checkout: moving from gone to b\ncheckout: moving from main to gone\n";
        assert_eq!(
            parse_recent(reflog, &local, Some("main")),
            ["main", "a", "b"]
        );
        assert_eq!(parse_recent("", &local, None), Vec::<String>::new());
    }

    #[test]
    fn remote_checkout_reuses_or_tracks() {
        let local = vec!["main".to_owned()];
        let (args, msg) = checkout_args(&Target::Remote("origin/main".into()), &local);
        assert_eq!(args, ["switch", "main"]);
        assert_eq!(msg, "Switched to main");
        let (args, msg) = checkout_args(&Target::Remote("origin/feat/x".into()), &local);
        assert_eq!(args, ["switch", "--track", "origin/feat/x"]);
        assert_eq!(msg, "Checked out origin/feat/x as feat/x");
    }

    #[test]
    fn head_new_branch_checkout_and_detached() {
        let dir = repo();
        let d = dir.path();
        assert_eq!(head_blocking(d), Head::Branch("main".into()));
        assert_eq!(
            create_blocking(d, " feat/x "),
            Ok("Created and checked out feat/x".into())
        );
        assert_eq!(head_blocking(d), Head::Branch("feat/x".into()));
        let b = load_blocking(d).unwrap();
        assert_eq!(b.local, ["feat/x", "main"]);
        assert_eq!(b.recent, ["feat/x", "main"]);
        // errors come back as git's text
        let err = create_blocking(d, "main").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(validate_new(d, "main", &b.local).is_some());
        assert!(validate_new(d, "bad..name", &b.local).is_some());
        assert_eq!(validate_new(d, "fine/name", &b.local), None);
        assert_eq!(
            checkout_blocking(d, &Target::Local("main".into()), &b.local),
            Ok("Switched to main".into())
        );
        assert_eq!(head_blocking(d), Head::Branch("main".into()));
        git(d, &["switch", "-q", "--detach", "HEAD"]);
        match head_blocking(d) {
            Head::Detached(h) => assert_eq!(h.len(), 8),
            h => panic!("{h:?}"),
        }
        let outside = tempfile::tempdir().unwrap();
        assert_eq!(head_blocking(outside.path()), Head::None);
    }

    #[test]
    fn branch_actions_new_from_rename_compare_delete() {
        let dir = repo();
        let d = dir.path();
        assert_eq!(
            create_from_blocking(d, "feat", "main"),
            Ok("Created feat from main and checked it out".into())
        );
        git(d, &["commit", "-q", "--allow-empty", "-m", "on feat"]);
        git(d, &["switch", "-q", "main"]);
        let feat = Target::Local("feat".into());
        assert_eq!(
            unmerged_blocking(d, &feat),
            1,
            "feat has a commit main lacks"
        );
        assert_eq!(unmerged_blocking(d, &Target::Local("main".into())), 0);
        assert_eq!(
            compare_range(&Head::Branch("main".into()), &feat),
            "main..feat"
        );
        assert_eq!(
            compare_range(&Head::Detached("0123abcd".into()), &feat),
            "HEAD..feat"
        );
        assert_eq!(
            rename_blocking(d, "feat", "feat2"),
            Ok("Renamed feat to feat2".into())
        );
        assert_eq!(load_blocking(d).unwrap().local, ["feat2", "main"]);
        assert_eq!(
            delete_blocking(d, &Target::Local("feat2".into())),
            Ok("Deleted branch feat2".into())
        );
        assert_eq!(load_blocking(d).unwrap().local, ["main"]);
        assert_eq!(
            delete_args(&Target::Remote("origin/x/y".into())).0,
            ["push", "origin", "--delete", "x/y"]
        );
    }
}
