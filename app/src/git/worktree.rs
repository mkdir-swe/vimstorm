//! A worktree's working files deleted (the workspace tab's Delete Working Files…, W-35): what it
//! would lose read first ([`loss`]), then [`delete`] once the person said yes; never the main
//! checkout ([`checkout_of`] names it). Local git only (a box's workspace never comes here), with
//! a parent git's `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_INDEX_FILE` stripped.
//! Blocking: run off the UI thread.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A parent git's variables that would point git elsewhere.
const GIT_ENV: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
];

fn git_command(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    for var in GIT_ENV {
        cmd.env_remove(var);
    }
    cmd
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_command(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(format!("git {}: {err}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The clone a folder belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkout {
    /// The main checkout (a worktree's main repo); a folder outside git is its own.
    pub main: PathBuf,
    /// Whether the folder is in a git repo.
    pub git: bool,
}

/// `path`'s main checkout (a file's: its folder's), as `git rev-parse --git-common-dir` names it.
pub fn checkout_of(path: &Path) -> Checkout {
    let dir = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let common = git(
        dir,
        &[
            "--no-optional-locks",
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ],
    )
    .ok()
    .map(|s| PathBuf::from(s.trim()));
    match common.as_deref().and_then(Path::parent) {
        Some(main) => Checkout {
            main: main.to_path_buf(),
            git: true,
        },
        None => Checkout {
            main: dir.to_path_buf(),
            git: false,
        },
    }
}

/// What deleting a worktree's files would lose (W-35): its uncommitted files (`M` / `A` / `D` /
/// `?` and the path), its commits no remote has (short hash, subject, newest first) and its
/// branch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Loss {
    pub files: Vec<(char, String)>,
    pub commits: Vec<(String, String)>,
    pub branch: Option<String>,
}

/// [`Loss`] of the worktree at `path`, read from git.
pub fn loss(path: &Path) -> Result<Loss, String> {
    let status = git(path, &["status", "--porcelain", "--untracked-files=all"])?;
    let files = status
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| {
            let code = &l[..2];
            let mark = if code == "??" {
                '?'
            } else if code.contains('A') {
                'A'
            } else if code.contains('D') {
                'D'
            } else {
                'M'
            };
            (mark, l[3..].to_owned())
        })
        .collect();
    let log = git(
        path,
        &["log", "--format=%h %s", "HEAD", "--not", "--remotes"],
    )
    .unwrap_or_default();
    let commits = log
        .lines()
        .filter_map(|l| l.split_once(' '))
        .map(|(h, s)| (h.to_owned(), s.to_owned()))
        .collect();
    Ok(Loss {
        files,
        commits,
        branch: branch_of(path),
    })
}

fn branch_of(path: &Path) -> Option<String> {
    git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

/// What [`delete`] says for the main checkout.
pub const MAIN_STAYS: &str = "the main checkout stays";

/// Deletes the worktree's files after the person saw [`loss`] and said yes (W-35): uncommitted
/// files go; its branch (and the commits only it has) is deleted too only when `delete_branch`.
/// Never the main checkout.
pub fn delete(main: &Path, path: &Path, delete_branch: bool) -> Result<(), String> {
    if fs::canonicalize(main).ok() == fs::canonicalize(path).ok() {
        return Err(MAIN_STAYS.to_owned());
    }
    let branch = delete_branch.then(|| branch_of(path)).flatten();
    if path.is_dir() {
        let p = path.to_string_lossy();
        git(main, &["worktree", "remove", "--force", &p])?;
    } else {
        git(main, &["worktree", "prune"])?;
    }
    if let Some(b) = branch {
        git(main, &["branch", "-D", &b])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        let mut all = vec!["-c", "user.name=T", "-c", "user.email=t@x"];
        all.extend_from_slice(args);
        git(dir, &all).unwrap()
    }

    /// A main checkout `app` on master with one commit pushed to `origin`.
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        run(
            &root,
            &["init", "-q", "--bare", "-b", "master", "origin.git"],
        );
        let main = root.join("app");
        fs::create_dir_all(&main).unwrap();
        run(&main, &["init", "-q", "-b", "master"]);
        fs::write(main.join("a.ts"), "a\n").unwrap();
        run(&main, &["add", "-A"]);
        run(&main, &["commit", "-q", "-m", "a"]);
        run(&main, &["remote", "add", "origin", "../origin.git"]);
        run(&main, &["push", "-q", "origin", "master"]);
        (tmp, main)
    }

    fn worktree(main: &Path, branch: &str) -> PathBuf {
        let at = main.parent().unwrap().join(branch.replace('/', "-"));
        run(
            main,
            &["worktree", "add", "-q", "-b", branch, at.to_str().unwrap()],
        );
        at
    }

    fn branches(main: &Path) -> String {
        run(main, &["branch", "--list"])
    }

    #[test]
    fn git_runs_never_prompt_and_drop_a_parent_git_s_variables() {
        let cmd = git_command(Path::new("."));
        let envs: Vec<_> = cmd.get_envs().collect();
        for var in GIT_ENV {
            assert!(
                envs.contains(&(std::ffi::OsStr::new(var), None)),
                "{var} removed"
            );
        }
        assert!(envs.contains(&(
            std::ffi::OsStr::new("GIT_TERMINAL_PROMPT"),
            Some(std::ffi::OsStr::new("0"))
        )));
    }

    #[test]
    fn a_worktree_s_main_checkout_is_its_repo_and_a_folder_outside_git_is_its_own() {
        let (tmp, main) = repo();
        fs::create_dir_all(main.join("src")).unwrap();
        let at = worktree(&main, "abe/AB-1-x");
        let detached = main.parent().unwrap().join("app-pr-2041");
        run(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                detached.to_str().unwrap(),
            ],
        );
        for path in [
            main.clone(),
            main.join("src"),
            at.clone(),
            at.join("a.ts"),
            detached.clone(),
            detached.join("a.ts"),
        ] {
            let c = checkout_of(&path);
            assert_eq!((c.main, c.git), (main.clone(), true), "{path:?}");
        }
        let notes = tmp.path().canonicalize().unwrap().join("notes");
        fs::create_dir_all(&notes).unwrap();
        let plain = checkout_of(&notes);
        assert_eq!((plain.main, plain.git), (notes, false));
    }

    #[test]
    fn delete_working_files_lists_the_loss_then_deletes_and_keeps_the_branch_unless_asked() {
        let (_tmp, main) = repo();
        let at = worktree(&main, "abe/AB-1240-checkout-copy");
        fs::write(at.join("copy.ts"), "c\n").unwrap();
        run(&at, &["add", "copy.ts"]);
        run(&at, &["commit", "-q", "-m", "copy.ts"]);
        fs::write(at.join("copy.test.ts"), "t\n").unwrap();
        run(&at, &["add", "copy.test.ts"]);
        fs::write(at.join("notes.md"), "n\n").unwrap();
        let lost = loss(&at).unwrap();
        assert_eq!(
            lost.files,
            [
                ('A', "copy.test.ts".to_owned()),
                ('?', "notes.md".to_owned())
            ]
        );
        assert_eq!(lost.commits.len(), 1, "only the unpushed one");
        assert_eq!(lost.commits[0].1, "copy.ts");
        assert_eq!(lost.branch.as_deref(), Some("abe/AB-1240-checkout-copy"));
        // the main checkout never goes
        assert_eq!(delete(&main, &main, false).unwrap_err(), MAIN_STAYS);
        assert!(main.join("a.ts").exists());
        // Also delete branch off: the files go, the branch and its commit stay
        delete(&main, &at, false).unwrap();
        assert!(!at.exists());
        assert!(branches(&main).contains("abe/AB-1240-checkout-copy"));
        // on: the branch goes too
        let again = worktree(&main, "abe/AB-1241-x");
        delete(&main, &again, true).unwrap();
        assert!(!again.exists());
        assert!(!branches(&main).contains("abe/AB-1241-x"));
    }
}
