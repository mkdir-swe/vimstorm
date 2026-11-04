//! Git fixtures for data tests: private copies of `tests/fixtures.sh`'s repos (each test its own,
//! so tests may commit / reset freely) and a generated big repo (`git fast-import`) for perf.
//!
//! Use from a test module: `use crate::common::gitfix;`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A repo in its own temp dir (deleted on drop).
pub struct GitFixture {
    pub tmp: tempfile::TempDir,
    /// The work tree.
    pub repo: PathBuf,
}

/// A fresh copy of a `tests/fixtures.sh` repo: "grepo" (with its remote `gremote.git` next to
/// it, as its relative `origin` URL expects) or "mrepo" (mid-merge with a conflict).
pub fn fixture(name: &str) -> GitFixture {
    let tmp = tempfile::Builder::new()
        .prefix(&format!("vimstorm-{name}-"))
        .tempdir()
        .unwrap();
    let src = super::fixtures();
    let mut names = vec![name.to_owned()];
    if name == "grepo" {
        names.push("gremote.git".into());
    }
    for n in names {
        let ok = Command::new("cp")
            .arg("-R")
            .arg(src.join(&n))
            .arg(tmp.path().join(&n))
            .status()
            .unwrap()
            .success();
        assert!(ok, "copy {n}");
    }
    // canonical: macOS /var -> /private/var, so paths compare equal to git's
    let repo = tmp.path().join(name).canonicalize().unwrap();
    GitFixture { tmp, repo }
}

/// Runs git in `dir`, asserts success, returns stdout. Never signs: a global `commit.gpgsign`
/// would make a test's commits wait on a signing agent.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A generated repo of exactly `commits` commits on `master` and side branches: every ~10 main
/// line commits a side branch of 1-7 commits merged back (`--no-ff` style merges), three
/// long-lived `team/N` branches merged in every 60 steps (parallel lanes), unmerged
/// `feature/N` branches every 400 commits, `release/N` tags every 500, `origin/master` a few
/// commits behind, 5 authors. Built with `git fast-import` (10k commits in well under a second).
pub fn big_repo(commits: usize) -> GitFixture {
    let tmp = tempfile::Builder::new()
        .prefix("vimstorm-big-")
        .tempdir()
        .unwrap();
    let repo = tmp.path().join("big").canonicalize_or_create();
    git(&repo, &["init", "-q", "-b", "master"]);
    git(&repo, &["config", "user.name", "Big Repo"]);
    git(&repo, &["config", "user.email", "big@x.se"]);
    let stream = fast_import_stream(commits);
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["fast-import", "--quiet", "--done"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "fast-import");
    git(&repo, &["reset", "-q", "--hard", "master"]);
    GitFixture { tmp, repo }
}

trait CreateDir {
    fn canonicalize_or_create(self) -> PathBuf;
}

impl CreateDir for PathBuf {
    fn canonicalize_or_create(self) -> PathBuf {
        std::fs::create_dir_all(&self).unwrap();
        self.canonicalize().unwrap()
    }
}

/// The fast-import commands for [`big_repo`].
pub fn fast_import_stream(total: usize) -> String {
    const AUTHORS: [(&str, &str); 5] = [
        ("Ada Example", "ada@x.se"),
        ("Aaron Sample", "a@x.se"),
        ("Max", "m@x.se"),
        ("Robin Doe", "r@x.se"),
        ("Kim Lee", "k@x.se"),
    ];
    let mut s = String::with_capacity(total * 220);
    let mut mark = 0usize; // == commits so far
    let mut time = 1_577_836_800i64; // 2020-01-01
    let mut master: Option<usize> = None;
    let mut team: [Option<usize>; 3] = [None; 3];
    let mut commit = |s: &mut String,
                      branch: &str,
                      from: Option<usize>,
                      merge: Option<usize>,
                      msg: &str,
                      mark: &mut usize| {
        *mark += 1;
        time += 600;
        let (name, email) = AUTHORS[*mark % AUTHORS.len()];
        let content = format!("{mark}\n");
        s.push_str(&format!(
            "commit refs/heads/{branch}\nmark :{mark}\nauthor {name} <{email}> {time} +0100\n\
             committer {name} <{email}> {time} +0100\ndata {}\n{msg}\n",
            msg.len() + 1
        ));
        if let Some(f) = from {
            s.push_str(&format!("from :{f}\n"));
        }
        if let Some(m) = merge {
            s.push_str(&format!("merge :{m}\n"));
        }
        s.push_str(&format!(
            "M 100644 inline src/f{}.txt\ndata {}\n{content}\n",
            *mark % 50,
            content.len()
        ));
        *mark
    };
    let mut i = 0usize;
    while mark < total {
        i += 1;
        let left = total - mark;
        if i.is_multiple_of(400) && left >= 3 {
            let base = master;
            let mut tip = base;
            for k in 0..2 {
                tip = Some(commit(
                    &mut s,
                    &format!("feature/{i}"),
                    tip,
                    None,
                    &format!("Feature {i}.{k}"),
                    &mut mark,
                ));
            }
        } else if i.is_multiple_of(10) && left >= 3 {
            // a side branch off master, merged back
            let len = (i % 7 + 1).min(left - 2);
            let base = master;
            let mut tip = base;
            for k in 0..len {
                tip = Some(commit(
                    &mut s,
                    "side",
                    tip,
                    None,
                    &format!("Side {i}.{k}"),
                    &mut mark,
                ));
            }
            master = Some(commit(
                &mut s,
                "master",
                base,
                tip,
                &format!("Merge side {i}"),
                &mut mark,
            ));
        } else if i.is_multiple_of(60) && team.iter().any(Option::is_some) {
            // a team branch merged into master; it starts again from there
            let t = (i / 60) % team.len();
            if let Some(tip) = team[t].take() {
                master = Some(commit(
                    &mut s,
                    "master",
                    master,
                    Some(tip),
                    &format!("Merge team/{t}"),
                    &mut mark,
                ));
            }
        } else if i % 3 == 1 && master.is_some() {
            // three long-lived team branches running alongside master
            let t = (i / 3) % team.len();
            let from = team[t].or(master);
            team[t] = Some(commit(
                &mut s,
                &format!("team/{t}"),
                from,
                None,
                &format!("Team {t} commit {i}"),
                &mut mark,
            ));
        } else {
            master = Some(commit(
                &mut s,
                "master",
                master,
                None,
                &format!("Commit {i}"),
                &mut mark,
            ));
            if i.is_multiple_of(500) {
                s.push_str(&format!(
                    "reset refs/tags/release/{i}\nfrom :{}\n",
                    master.unwrap()
                ));
            }
        }
        if mark + 5 >= total && mark < total {
            // origin/master a little behind
            if let Some(m) = master {
                s.push_str(&format!("reset refs/remotes/origin/master\nfrom :{m}\n"));
            }
        }
    }
    s.push_str("done\n");
    s
}
