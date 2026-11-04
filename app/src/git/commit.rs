//! Commit, amend, rollback and Add to VCS from Local Changes (Lua `git/changes.lua`).
//!
//! Commit: the included files, or every tracked change when none is (unversioned files only when
//! included: WS leaves them out). Nothing is staged first: `commit -- paths` / `commit -a` use
//! git's temporary index, so a failed commit (hook) leaves the index, the included files and the
//! message (the UI keeps it as the draft) as they were; included unversioned files are added
//! just before and taken out again on failure. During a merge every tracked change is committed
//! (git refuses partial merge commits).

use std::collections::HashSet;
use std::path::Path;

use super::changes::{Change, ChangeKind};
use super::cli;
use super::ops::{Level, Outcome, run_action};

/// What a commit would do (the prompt's "Commit 2 marked file(s)" and git's arguments).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitPlan {
    /// "2 marked file(s)", "merge", "all 3 changed file(s)", "message only" (amend).
    pub what: String,
    /// git arguments after `commit` and the message: `-a`, or `--` + paths.
    pub args: Vec<String>,
    /// Included unversioned files: added before, removed from the index on failure.
    pub unversioned: Vec<String>,
    /// The included paths (they stop being included after a successful commit).
    pub included: Vec<String>,
}

/// Plans a commit of `files` (Local Changes) with `included` paths (Lua `changes.lua` `commit`'s
/// checks and arguments). Err: the balloon for why there's nothing to commit.
pub fn plan(
    files: &[Change],
    included: &HashSet<String>,
    merging: bool,
    amend: bool,
) -> Result<CommitPlan, Outcome> {
    if files.is_empty() && !amend {
        return Err(Outcome::refused(Level::Info, "No changes to commit"));
    }
    if files.iter().any(|f| f.kind == ChangeKind::Conflict) {
        return Err(Outcome::refused(
            Level::Warn,
            "Resolve the merge conflicts first",
        ));
    }
    // a merge commit takes every tracked change
    let inc: Vec<&Change> = if merging {
        Vec::new()
    } else {
        files
            .iter()
            .filter(|f| included.contains(&f.path))
            .collect()
    };
    let changed = files
        .iter()
        .filter(|f| f.kind != ChangeKind::Unversioned)
        .count();
    if inc.is_empty() && changed == 0 && !merging {
        if amend {
            // amend without changes: just the message (WS's amend of the last commit)
            return Ok(CommitPlan {
                what: "message only".into(),
                args: vec!["--only".into()],
                unversioned: Vec::new(),
                included: Vec::new(),
            });
        }
        return Err(Outcome::refused(
            Level::Info,
            "Only unversioned files: mark the ones to commit (Space)",
        ));
    }
    if inc.is_empty() {
        return Ok(CommitPlan {
            what: if merging {
                "merge".into()
            } else {
                format!("all {changed} changed file(s)")
            },
            args: vec!["-a".into()], // -a: tracked files only
            unversioned: Vec::new(),
            included: Vec::new(),
        });
    }
    let mut args = vec!["--".to_owned()];
    let mut unversioned = Vec::new();
    for f in &inc {
        if f.kind == ChangeKind::Unversioned {
            unversioned.push(f.path.clone());
        }
        args.push(f.path.clone());
        if let Some(o) = &f.old_path {
            args.push(o.clone());
        }
    }
    Ok(CommitPlan {
        what: format!("{} marked file(s)", inc.len()),
        args,
        unversioned,
        included: inc.iter().map(|f| f.path.clone()).collect(),
    })
}

/// What a commit did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitResult {
    pub outcome: Outcome,
    /// The new commit's hash on success.
    pub hash: Option<String>,
    /// Paths to stop including (the committed ones).
    pub committed: Vec<String>,
}

/// Commits (Cmd+K / Commit and Push's first half), or amends the last commit. Blocking (hooks may
/// take a while: show "Committing…" when it takes over half a second, like `act_async`).
pub fn commit_blocking(
    dir: &Path,
    message: &str,
    files: &[Change],
    included: &HashSet<String>,
    merging: bool,
    amend: bool,
) -> CommitResult {
    let fail = |outcome| CommitResult {
        outcome,
        hash: None,
        committed: Vec::new(),
    };
    if message.trim().is_empty() {
        return fail(Outcome::refused(Level::Info, "Commit message is empty"));
    }
    let plan = match plan(files, included, merging, amend) {
        Ok(p) => p,
        Err(o) => return fail(o),
    };
    if !plan.unversioned.is_empty() {
        let mut add = vec!["add", "--"];
        add.extend(plan.unversioned.iter().map(String::as_str));
        if let Err(e) = run_action(dir, &add) {
            return fail(Outcome::failed("add", e.to_string()));
        }
    }
    let mut args = vec!["commit".to_owned()];
    if amend {
        args.push("--amend".into());
    }
    args.extend(["-m".to_owned(), message.to_owned()]);
    args.extend(plan.args.iter().cloned());
    let out = run_action(dir, &args);
    let verb = if amend { "Amended" } else { "Committed" };
    let outcome = Outcome::from_output("commit", out, format!("{verb} {}", plan.what));
    if !outcome.ok {
        if !plan.unversioned.is_empty() {
            let mut rm = vec!["rm", "--cached", "-q", "--"];
            rm.extend(plan.unversioned.iter().map(String::as_str));
            let _ = run_action(dir, &rm);
        }
        return fail(outcome);
    }
    let hash = cli::run_blocking(dir, ["rev-parse", "HEAD"])
        .ok()
        .map(|o| o.stdout.trim().to_owned());
    CommitResult {
        outcome,
        hash,
        committed: plan.included,
    }
}

/// The last commit's message (Amend fills the message area with it, like WS). Blocking.
pub fn last_message_blocking(dir: &Path) -> Option<String> {
    super::log::message_blocking(dir, "HEAD")
}

/// Rollback options (WS's Rollback dialog).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RollbackOptions {
    /// "Delete local copies of the added files" (off by default, like WS / Lua: added files
    /// become unversioned again and keep their content).
    pub delete_added: bool,
}

/// The Rollback prompt's text (Lua `changes.lua`): "Rollback 2 file(s)? a.ts, b.ts" (5 names
/// max).
pub fn rollback_prompt(files: &[&Change]) -> String {
    let files: Vec<&&Change> = files
        .iter()
        .filter(|f| f.kind != ChangeKind::Unversioned)
        .collect();
    let names: Vec<&str> = files.iter().take(5).map(|f| f.path.as_str()).collect();
    format!(
        "Rollback {} file(s)? {}{}",
        files.len(),
        names.join(", "),
        if files.len() > 5 { ", …" } else { "" }
    )
}

/// Cmd+Z / Cmd+Alt+Z (Lua `changes.lua` `rollback`): unversioned files are left alone (like WS);
/// added files are taken out of the index; others restored from HEAD (index + work tree, renames
/// both paths). The UI confirms first ([`rollback_prompt`]). Blocking.
pub fn rollback_blocking(dir: &Path, files: &[&Change], opts: RollbackOptions) -> Outcome {
    let files: Vec<&&Change> = files
        .iter()
        .filter(|f| f.kind != ChangeKind::Unversioned)
        .collect();
    if files.is_empty() {
        return Outcome::refused(Level::Info, "Nothing to roll back");
    }
    let done = format!("Rolled back {} file(s)", files.len());
    let added: Vec<&str> = files
        .iter()
        .filter(|f| f.kind == ChangeKind::Added)
        .map(|f| f.path.as_str())
        .collect();
    if !added.is_empty() {
        let mut rm = vec!["rm", "--cached", "-f", "-q", "--"];
        rm.extend(added.iter().copied());
        if let Ok(o) = run_action(dir, &rm)
            && !o.ok()
        {
            return Outcome::failed("rm", cli::error_text(&o));
        }
        if opts.delete_added {
            for p in &added {
                let _ = std::fs::remove_file(dir.join(p));
            }
        }
    }
    let mut restore: Vec<&str> = Vec::new();
    for f in files.iter().filter(|f| f.kind != ChangeKind::Added) {
        restore.push(&f.path);
        if let Some(o) = &f.old_path {
            restore.push(o);
        }
    }
    if restore.is_empty() {
        return Outcome::done(done);
    }
    let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
    args.extend(restore);
    Outcome::from_output("restore", run_action(dir, &args), done)
}

/// Add to VCS (unversioned -> added; Lua `changes.lua` `add`).
pub fn add_blocking(dir: &Path, paths: &[&str]) -> Outcome {
    if paths.is_empty() {
        return Outcome::refused(Level::Info, "Nothing to add");
    }
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().copied());
    Outcome::from_output(
        "add",
        run_action(dir, &args),
        format!("Added {} file(s)", paths.len()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, kind: ChangeKind) -> Change {
        Change {
            path: path.into(),
            old_path: (kind == ChangeKind::Renamed).then(|| format!("{path}.old")),
            xy: match kind {
                ChangeKind::Unversioned => "??".into(),
                ChangeKind::Conflict => "UU".into(),
                ChangeKind::Renamed => "R ".into(),
                ChangeKind::Added => "A ".into(),
                _ => " M".into(),
            },
            kind,
        }
    }

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn commit_plans_like_the_lua_commit() {
        let files = vec![
            change("a.ts", ChangeKind::Modified),
            change("r.ts", ChangeKind::Renamed),
            change("new.ts", ChangeKind::Unversioned),
        ];
        let p = plan(&files, &set(&[]), false, false).unwrap();
        assert_eq!(p.what, "all 2 changed file(s)");
        assert_eq!(p.args, ["-a"]);
        let p = plan(&files, &set(&["r.ts", "new.ts"]), false, false).unwrap();
        assert_eq!(p.what, "2 marked file(s)");
        assert_eq!(p.args, ["--", "r.ts", "r.ts.old", "new.ts"]);
        assert_eq!(p.unversioned, ["new.ts"]);
        // merging: everything tracked, the marks ignored
        let p = plan(&files, &set(&["a.ts"]), true, false).unwrap();
        assert_eq!(
            (p.what.as_str(), p.args.as_slice()),
            ("merge", &["-a".to_owned()][..])
        );

        let only_new = vec![change("new.ts", ChangeKind::Unversioned)];
        let e = plan(&only_new, &set(&[]), false, false).unwrap_err();
        assert_eq!(
            e.message,
            "Only unversioned files: mark the ones to commit (Space)"
        );
        let e = plan(&[], &set(&[]), false, false).unwrap_err();
        assert_eq!(e.message, "No changes to commit");
        let conflict = vec![change("c.ts", ChangeKind::Conflict)];
        let e = plan(&conflict, &set(&[]), true, false).unwrap_err();
        assert_eq!(e.level, Level::Warn);
        // amend without changes: the message only
        let p = plan(&[], &set(&[]), false, true).unwrap();
        assert_eq!(p.args, ["--only"]);
    }

    #[test]
    fn rollback_prompt_text() {
        let files: Vec<Change> = (1..=7)
            .map(|i| change(&format!("f{i}.ts"), ChangeKind::Modified))
            .chain([change("u.ts", ChangeKind::Unversioned)])
            .collect();
        let refs: Vec<&Change> = files.iter().collect();
        assert_eq!(
            rollback_prompt(&refs),
            "Rollback 7 file(s)? f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, …"
        );
    }
}
