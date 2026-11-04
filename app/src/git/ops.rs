//! Repo-changing actions with WS / Lua balloons (Lua `git/actions.lua`, `branches.lua`,
//! `changes.lua` push): push / pull / fetch (progress lines, upstream info, outgoing commits),
//! checkout of a tag / revision, new branch / tag at a commit, cherry-pick, revert, reset, and the
//! interactive-rebase helpers for unpushed commits (reword, uncommit, drop). Every action returns
//! an [`Outcome`]: the balloon text (`git/cli.lua` `act`: the success message titled "Git", else
//! git's error text titled "git <command>"). All blocking: run them off the UI thread
//! ([`super::job::spawn`]) and refresh the views after.

use std::io;
use std::path::{Path, PathBuf};

use super::cli::{self, Cancel, Output};
use super::log::{self, Commit, LogKind, LogParser};
use super::repo;

/// Balloon level (Lua's vim.log.levels).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// What an action did, for its balloon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    pub level: Level,
    /// "Git", or "git <command>" for a git error.
    pub title: String,
    pub message: String,
}

impl Outcome {
    pub fn done(message: impl Into<String>) -> Outcome {
        Outcome {
            ok: true,
            level: Level::Info,
            title: "Git".into(),
            message: message.into(),
        }
    }

    /// Nothing to do / refused before running git (Lua's INFO / WARN balloons).
    pub fn refused(level: Level, message: impl Into<String>) -> Outcome {
        Outcome {
            ok: false,
            level,
            title: "Git".into(),
            message: message.into(),
        }
    }

    /// git failed: its error text (`cli.act`).
    pub fn failed(command: &str, text: impl Into<String>) -> Outcome {
        Outcome {
            ok: false,
            level: Level::Error,
            title: format!("git {command}"),
            message: text.into(),
        }
    }

    /// From a finished git command: `msg` on success, else git's error text.
    pub fn from_output(command: &str, out: io::Result<Output>, msg: impl Into<String>) -> Outcome {
        match out {
            Ok(o) if o.ok() => Outcome::done(msg),
            Ok(o) => Outcome::failed(command, cli::error_text(&o)),
            Err(e) => Outcome::failed(command, e.to_string()),
        }
    }
}

/// Runs a repo-changing git command: never waits for an editor (`GIT_EDITOR=true`; messages come
/// with `-m` / `-F` / `--no-edit`).
pub fn run_action<I, S>(dir: &Path, args: I) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = cli::command(dir, args)?
        .env("GIT_EDITOR", "true")
        .output()?;
    Ok(Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn short(hash: &str) -> &str {
    &hash[..hash.len().min(8)]
}

/// A temp file for messages / rebase todo lists (removed on drop).
pub(crate) struct TempFile(pub PathBuf);

impl TempFile {
    pub fn new(text: &str) -> io::Result<TempFile> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let path = std::env::temp_dir().join(format!(
            "vimstorm-git-{}-{n}-{nanos}.txt",
            std::process::id()
        ));
        std::fs::write(&path, text)?;
        Ok(TempFile(path))
    }

    pub fn path_str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// POSIX shell single quotes (`vim.fn.shellescape`).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn is_auth_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("authentication failed")
        || e.contains("terminal prompts disabled")
        || e.contains("could not read username")
        || e.contains("could not read password")
        || e.contains("permission denied (publickey")
}

/// git's error, with "Authentication failed" in front when that's what it was (prompts are off).
fn remote_error(command: &str, out: &Output) -> Outcome {
    let text = cli::error_text(out);
    if is_auth_error(&text) && !text.starts_with("Authentication failed") {
        Outcome::failed(command, format!("Authentication failed\n{text}"))
    } else {
        Outcome::failed(command, text)
    }
}

// Push / pull / fetch -----------------------------------------------------------------------------

/// What a push would do (WS Push dialog: the branch, where it goes, the commits).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushInfo {
    /// None when detached (nothing to push).
    pub branch: Option<String>,
    /// The upstream (`origin/master`), None the first time (push sets it).
    pub upstream: Option<String>,
    /// Where it goes: the upstream's remote, else `origin` / the first remote.
    pub remote: Option<String>,
    /// The commits not on the remote yet, newest first.
    pub outgoing: Vec<Commit>,
}

/// Reads [`PushInfo`]. Blocking.
pub fn push_info_blocking(dir: &Path) -> anyhow::Result<PushInfo> {
    let st = repo::read_blocking(dir).ok_or_else(|| anyhow::anyhow!("Not a git repository"))?;
    let branch = st.head.branch().map(str::to_owned);
    let upstream = st.upstream.as_ref().map(|u| u.name.clone());
    let remote = st.upstream.as_ref().map(|u| u.remote.clone()).or_else(|| {
        st.remotes
            .iter()
            .find(|r| *r == "origin")
            .or(st.remotes.first())
            .cloned()
    });
    let range: Vec<&str> = if upstream.is_some() {
        vec!["@{upstream}..HEAD"]
    } else {
        vec!["HEAD", "--not", "--remotes"]
    };
    let mut args = vec![
        "log",
        "--no-color",
        "--decorate=full",
        log::FORMAT,
        "-n1000",
    ];
    args.extend(range);
    let out = cli::run_blocking(dir, &args)?;
    let outgoing = if out.ok() {
        LogParser::parse(LogKind::Graph, &out.stdout)
    } else {
        Vec::new()
    };
    Ok(PushInfo {
        branch,
        upstream,
        remote,
        outgoing,
    })
}

/// Cmd+Shift+K (Lua `changes.lua` `push`): `git push`; the first time (no upstream) `push -u
/// origin HEAD`. `progress` gets git's progress lines. Blocking.
pub fn push_blocking(dir: &Path, cancel: &Cancel, mut progress: impl FnMut(&str)) -> Outcome {
    let out = cli::run_with_progress(dir, ["push", "--progress"], cancel, &mut progress);
    match out {
        Ok(o) if o.ok() => Outcome::done("Pushed"),
        Ok(o) if o.stderr.contains("no upstream") => {
            match cli::run_with_progress(
                dir,
                ["push", "--progress", "-u", "origin", "HEAD"],
                cancel,
                &mut progress,
            ) {
                Ok(o) if o.ok() => Outcome::done("Pushed (upstream set)"),
                Ok(o) => remote_error("push", &o),
                Err(e) => Outcome::failed("push", e.to_string()),
            }
        }
        Ok(o) => remote_error("push", &o),
        Err(e) => Outcome::failed("push", e.to_string()),
    }
}

/// Pull (WS Update / Pull, merge by default): `git pull --no-edit` with the user's pull config,
/// local changes stashed around it (`--autostash`, WS's update stashes too); when git asks how
/// to reconcile divergent branches (no `pull.rebase` set), merge like WS's default. Blocking.
pub fn pull_blocking(dir: &Path, cancel: &Cancel, mut progress: impl FnMut(&str)) -> Outcome {
    let done = |o: &Output| {
        // git exits 0 when re-applying the autostash conflicted: the local changes are left
        // conflicted (and kept in an "autostash" stash entry); a warning, not "Pulled"
        let text = format!("{}\n{}", o.stdout, o.stderr);
        let unmerged =
            cli::run_blocking(dir, ["ls-files", "-u"]).is_ok_and(|u| !u.stdout.trim().is_empty());
        if text.contains("autostash resulted in conflicts") || unmerged {
            Outcome {
                ok: true,
                level: Level::Warn,
                title: "Git".into(),
                message: "Pulled, but your local changes conflict with it: resolve the \
                          conflicts (the changes are also kept in the stash, \"autostash\")"
                    .into(),
            }
        } else if o.stdout.contains("Already up to date") {
            Outcome::done("All files are up-to-date")
        } else {
            Outcome::done("Pulled")
        }
    };
    match cli::run_with_progress(
        dir,
        ["pull", "--no-edit", "--autostash", "--progress"],
        cancel,
        &mut progress,
    ) {
        Ok(o) if o.ok() => done(&o),
        Ok(o) if o.stderr.contains("divergent branches") => {
            match cli::run_with_progress(
                dir,
                [
                    "pull",
                    "--no-rebase",
                    "--no-edit",
                    "--autostash",
                    "--progress",
                ],
                cancel,
                &mut progress,
            ) {
                Ok(o) if o.ok() => done(&o),
                Ok(o) => remote_error("pull", &o),
                Err(e) => Outcome::failed("pull", e.to_string()),
            }
        }
        Ok(o) => remote_error("pull", &o),
        Err(e) => Outcome::failed("pull", e.to_string()),
    }
}

/// Fetch all remotes (WS Fetch). Blocking.
pub fn fetch_blocking(dir: &Path, cancel: &Cancel, progress: impl FnMut(&str)) -> Outcome {
    match cli::run_with_progress(dir, ["fetch", "--all", "--progress"], cancel, progress) {
        Ok(o) if o.ok() => Outcome::done("Fetched"),
        Ok(o) => remote_error("fetch", &o),
        Err(e) => Outcome::failed("fetch", e.to_string()),
    }
}

// Checkout / branch / tag -------------------------------------------------------------------------

/// Checks out a tag, detached (Lua `branches.lua`: "Checked out tag v1"). Branches: see
/// [`super::branches::checkout_blocking`].
pub fn checkout_tag_blocking(dir: &Path, tag: &str) -> Outcome {
    Outcome::from_output(
        "switch",
        run_action(dir, ["switch", "--detach", tag]),
        format!("Checked out tag {tag}"),
    )
}

/// Checks out a commit, detached (WS Checkout Revision).
pub fn checkout_revision_blocking(dir: &Path, hash: &str) -> Outcome {
    Outcome::from_output(
        "switch",
        run_action(dir, ["switch", "--detach", hash]),
        format!("Checked out {}", short(hash)),
    )
}

/// New Branch at a commit (WS New Branch… from the log), checked out or not.
pub fn new_branch_blocking(dir: &Path, name: &str, at: &str, checkout: bool) -> Outcome {
    let name = name.trim();
    if name.is_empty() {
        return Outcome::refused(Level::Warn, "Branch name is empty");
    }
    if checkout {
        Outcome::from_output(
            "switch",
            run_action(dir, ["switch", "-c", name, at]),
            format!("Created and checked out {name}"),
        )
    } else {
        Outcome::from_output(
            "branch",
            run_action(dir, ["branch", name, at]),
            format!("Created branch {name}"),
        )
    }
}

/// New Tag at a commit (lightweight; annotated with a message).
pub fn new_tag_blocking(dir: &Path, name: &str, at: &str, message: Option<&str>) -> Outcome {
    let name = name.trim();
    if name.is_empty() {
        return Outcome::refused(Level::Warn, "Tag name is empty");
    }
    let out = match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => run_action(dir, ["tag", "-a", name, "-m", m, at]),
        None => run_action(dir, ["tag", name, at]),
    };
    Outcome::from_output("tag", out, format!("Created tag {name}"))
}

// Commit actions (M4 Lua actions.lua) -----------------------------------------------------------

pub fn cherry_pick_blocking(dir: &Path, hash: &str) -> Outcome {
    Outcome::from_output(
        "cherry-pick",
        run_action(dir, ["cherry-pick", hash]),
        format!("Cherry-picked {}", short(hash)),
    )
}

pub fn revert_blocking(dir: &Path, hash: &str) -> Outcome {
    Outcome::from_output(
        "revert",
        run_action(dir, ["revert", "--no-edit", hash]),
        format!("Reverted {}", short(hash)),
    )
}

/// Reset current branch to here (Soft keeps changes staged, Mixed keeps them, Hard discards).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    pub fn name(self) -> &'static str {
        match self {
            ResetMode::Soft => "soft",
            ResetMode::Mixed => "mixed",
            ResetMode::Hard => "hard",
        }
    }

    /// The Lua menu's choices.
    pub fn label(self) -> &'static str {
        match self {
            ResetMode::Soft => "Soft (keep changes staged)",
            ResetMode::Mixed => "Mixed (keep changes)",
            ResetMode::Hard => "Hard (discard changes)",
        }
    }
}

/// `reset --<mode> <hash>` (the UI confirms Hard first: "Discard all local changes?").
pub fn reset_blocking(dir: &Path, hash: &str, mode: ResetMode) -> Outcome {
    Outcome::from_output(
        "reset",
        run_action(dir, ["reset", &format!("--{}", mode.name()), hash]),
        format!("Reset ({}) to {}", mode.name(), short(hash)),
    )
}

/// On the current branch and on no remote branch: Reword / Uncommit / Drop are offered
/// (Lua `actions.lua` `unpushed`, like WS).
pub fn is_unpushed_blocking(dir: &Path, hash: &str) -> bool {
    let ancestor =
        cli::run_blocking(dir, ["merge-base", "--is-ancestor", hash, "HEAD"]).is_ok_and(|o| o.ok());
    ancestor
        && cli::run_blocking(dir, ["branch", "-r", "--contains", hash])
            .is_ok_and(|o| o.ok() && o.stdout.trim().is_empty())
}

fn has_parent(dir: &Path, hash: &str) -> bool {
    cli::run_blocking(
        dir,
        ["rev-parse", "--verify", "--quiet", &format!("{hash}^")],
    )
    .is_ok_and(|o| o.ok())
}

fn lines(dir: &Path, args: &[&str]) -> Vec<String> {
    cli::run_blocking(dir, args)
        .ok()
        .filter(Output::ok)
        .map(|o| o.stdout.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Rebases `hash^..HEAD` with a todo list built here (no editor; Lua `actions.lua` `rewrite`):
/// `edit` gets the `pick <hash>` lines, oldest first (`todo[0]` is the target commit).
fn rewrite(dir: &Path, hash: &str, edit: impl FnOnce(&mut Vec<String>), done: String) -> Outcome {
    if !has_parent(dir, hash) {
        return Outcome::refused(Level::Warn, "Can't rewrite the first commit");
    }
    let range = format!("{hash}^..HEAD");
    if !lines(dir, &["rev-list", "--merges", &range]).is_empty() {
        return Outcome::refused(
            Level::Warn,
            "Can't rewrite: there are merge commits after it",
        );
    }
    let mut todo: Vec<String> = lines(dir, &["rev-list", "--reverse", &range])
        .into_iter()
        .map(|c| format!("pick {c}"))
        .collect();
    edit(&mut todo);
    let file = match TempFile::new(&(todo.join("\n") + "\n")) {
        Ok(f) => f,
        Err(e) => return Outcome::failed("rebase", e.to_string()),
    };
    let editor = format!("sequence.editor=cp {}", shell_quote(&file.path_str()));
    let out = run_action(
        dir,
        [
            "-c",
            &editor,
            "rebase",
            "-i",
            "--autostash",
            &format!("{hash}^"),
        ],
    );
    Outcome::from_output("rebase", out, done)
}

/// Reword… an unpushed commit with a new full message: HEAD by `commit --amend --only`, an older
/// one by a rebase that amends it (Lua `actions.lua` `reword`).
pub fn reword_blocking(dir: &Path, hash: &str, message: &str) -> Outcome {
    if message.trim().is_empty() {
        return Outcome::refused(Level::Info, "Commit message is empty");
    }
    let file = match TempFile::new(message) {
        Ok(f) => f,
        Err(e) => return Outcome::failed("commit", e.to_string()),
    };
    let head = cli::run_blocking(dir, ["rev-parse", "HEAD"])
        .map(|o| o.stdout.trim().to_owned())
        .unwrap_or_default();
    let full = cli::run_blocking(dir, ["rev-parse", hash])
        .map(|o| o.stdout.trim().to_owned())
        .unwrap_or_default();
    if head == full {
        return Outcome::from_output(
            "commit",
            run_action(
                dir,
                [
                    "commit",
                    "--amend",
                    "--only",
                    "--no-verify",
                    "-F",
                    &file.path_str(),
                ],
            ),
            "Reworded",
        );
    }
    let exec = format!(
        "exec git commit --amend --only --no-verify -F {}",
        shell_quote(&file.path_str())
    );
    rewrite(dir, hash, |todo| todo.insert(1, exec), "Reworded".into())
}

/// The Lua reword: a new subject, the old body kept ("subject\n\nbody").
pub fn reword_subject_blocking(dir: &Path, hash: &str, subject: &str) -> Outcome {
    let body = cli::run_blocking(dir, ["show", "-s", "--format=%b", hash])
        .map(|o| o.stdout.trim().to_owned())
        .unwrap_or_default();
    let msg = if body.is_empty() {
        subject.to_owned()
    } else {
        format!("{subject}\n\n{body}")
    };
    reword_blocking(dir, hash, &msg)
}

/// How many commits Uncommit takes back (the UI confirms when more than 1).
pub fn uncommit_count_blocking(dir: &Path, hash: &str) -> usize {
    lines(dir, &["rev-list", &format!("{hash}^..HEAD")]).len()
}

/// Uncommit (keep changes): `reset --soft hash^`.
pub fn uncommit_blocking(dir: &Path, hash: &str) -> Outcome {
    let n = uncommit_count_blocking(dir, hash);
    Outcome::from_output(
        "reset",
        run_action(dir, ["reset", "--soft", &format!("{hash}^")]),
        format!("Uncommitted {n} commit(s)"),
    )
}

/// Drop commit (the UI confirms: "Drop 1a2b3c4d subject?").
pub fn drop_blocking(dir: &Path, hash: &str) -> Outcome {
    rewrite(
        dir,
        hash,
        |todo| {
            if !todo.is_empty() {
                todo.remove(0);
            }
            if todo.is_empty() {
                todo.push("noop".into());
            }
        },
        format!("Dropped {}", short(hash)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_and_outcomes() {
        assert_eq!(shell_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        let o = Outcome::from_output(
            "push",
            Ok(Output {
                code: Some(1),
                stdout: String::new(),
                stderr: "  fatal: nope\n".into(),
            }),
            "Pushed",
        );
        assert_eq!(o.title, "git push");
        assert_eq!(o.message, "fatal: nope");
        assert_eq!(o.level, Level::Error);
        let auth = Output {
            code: Some(128),
            stdout: String::new(),
            stderr: "fatal: could not read Username for 'https://x': terminal prompts disabled\n"
                .into(),
        };
        assert!(
            remote_error("push", &auth)
                .message
                .starts_with("Authentication failed\n")
        );
        assert_eq!(ResetMode::Hard.label(), "Hard (discard changes)");
    }
}
