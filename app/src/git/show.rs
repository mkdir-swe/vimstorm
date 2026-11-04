//! Commit details for the Log's right pane (Lua `git/details.lua`): one commit's message,
//! author / committer, changed files (A / M / D / R with the old path, C copies) and the branches
//! containing it; several selected commits' combined changed files (`show_many`: every file any
//! of them changed, diffed from before the oldest to the newest); file contents at a revision
//! for the diff panes.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;

use super::cli;
use super::log::{Person, Time};

/// git's empty tree: the "before" of a root commit.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// How a file changed in a commit (`--name-status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    /// Renamed (similarity %).
    Renamed(u8),
    /// Copied (similarity %).
    Copied(u8),
    TypeChanged,
    Unmerged,
}

impl FileChange {
    pub fn parse(s: &str) -> Option<FileChange> {
        let score = || s.get(1..).and_then(|n| n.parse().ok()).unwrap_or(100);
        Some(match s.as_bytes().first()? {
            b'A' => FileChange::Added,
            b'M' => FileChange::Modified,
            b'D' => FileChange::Deleted,
            b'R' => FileChange::Renamed(score()),
            b'C' => FileChange::Copied(score()),
            b'T' => FileChange::TypeChanged,
            b'U' => FileChange::Unmerged,
            _ => return None,
        })
    }

    /// The Lua `GitFile.status` letter: A M D R C (T counts as M, U as U).
    pub fn letter(self) -> char {
        match self {
            FileChange::Added => 'A',
            FileChange::Modified | FileChange::TypeChanged => 'M',
            FileChange::Deleted => 'D',
            FileChange::Renamed(_) => 'R',
            FileChange::Copied(_) => 'C',
            FileChange::Unmerged => 'U',
        }
    }
}

/// A changed file of a commit / combined selection.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ChangedFile {
    pub change: FileChange,
    /// Repo-relative path after the change.
    pub path: String,
    /// Renames / copies: where it came from.
    pub old_path: Option<String>,
}

/// `--name-status -z` output -> files (Lua `details.lua` `parse_name_status`, NUL separated so
/// any file name works).
pub fn parse_name_status_z(out: &str) -> Vec<ChangedFile> {
    let mut files = Vec::new();
    let mut it = out.split('\0').map(|s| s.trim_start_matches('\n'));
    while let Some(st) = it.next() {
        let Some(change) = FileChange::parse(st) else {
            continue;
        };
        let Some(first) = it.next() else { break };
        match change {
            FileChange::Renamed(_) | FileChange::Copied(_) => {
                let Some(new) = it.next() else { break };
                files.push(ChangedFile {
                    change,
                    path: new.to_owned(),
                    old_path: Some(first.to_owned()),
                });
            }
            _ => files.push(ChangedFile {
                change,
                path: first.to_owned(),
                old_path: None,
            }),
        }
    }
    files
}

/// One commit's details.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: Person,
    pub author_time: Time,
    pub committer: Person,
    pub commit_time: Time,
    /// The full message, trimmed (first line = subject).
    pub message: String,
    /// Changed files vs the first parent (`--diff-merges=first-parent`), renames detected.
    pub files: Vec<ChangedFile>,
}

impl CommitDetails {
    pub fn subject(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }

    /// The message after the subject (trimmed; "" when none).
    pub fn body(&self) -> &str {
        self.message.split_once('\n').map_or("", |(_, b)| b.trim())
    }

    /// The details show a "committed by" line (Lua `details.lua`: a different committer name or
    /// email).
    pub fn other_committer(&self) -> bool {
        self.committer != self.author
    }

    /// What a changed file's diff compares: (old rev, new rev) = (hash^, hash).
    pub fn revs(&self) -> (String, String) {
        (format!("{}^", self.hash), self.hash.clone())
    }
}

const META: &str =
    "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%aI%x1f%cn%x1f%ce%x1f%ct%x1f%cI%x1f%B%x1e";

/// `git show` meta + name-status -> details.
pub fn parse_show(out: &str) -> Option<CommitDetails> {
    let (meta, files) = out.split_once('\x1e')?;
    let mut f = meta.splitn(11, '\x1f');
    let mut next = || f.next().unwrap_or("");
    let hash = next().to_owned();
    let parents = next().split_whitespace().map(str::to_owned).collect();
    let author = Person {
        name: next().to_owned(),
        email: next().to_owned(),
    };
    let at = next();
    let author_time = Time::parse(at, next());
    let committer = Person {
        name: next().to_owned(),
        email: next().to_owned(),
    };
    let ct = next();
    let commit_time = Time::parse(ct, next());
    let message = next().trim().to_owned();
    if hash.is_empty() {
        return None;
    }
    Some(CommitDetails {
        hash,
        parents,
        author,
        author_time,
        committer,
        commit_time,
        message,
        files: parse_name_status_z(files),
    })
}

/// One commit's details (Lua `details.lua` `show`'s git call). Blocking.
pub fn details_blocking(dir: &Path, hash: &str) -> anyhow::Result<CommitDetails> {
    let out = cli::run_blocking(
        dir,
        [
            "show",
            "-z",
            META,
            "--name-status",
            "-M",
            "--diff-merges=first-parent",
            hash,
            "--",
        ],
    )?
    .into_result()?;
    parse_show(&out).ok_or_else(|| anyhow::anyhow!("can't read commit {hash}"))
}

/// Commit details never change: a per-hash cache (like Lua `details.lua`'s, cleared past 2000)
/// so moving back through the log is instant. Share one per repo (clones share the map).
#[derive(Clone, Default)]
pub struct DetailsCache(Arc<Mutex<HashMap<String, Arc<CommitDetails>>>>);

impl DetailsCache {
    pub fn get(&self, hash: &str) -> Option<Arc<CommitDetails>> {
        self.0.lock().get(hash).cloned()
    }

    /// From the cache, else git (blocking).
    pub fn load_blocking(&self, dir: &Path, hash: &str) -> anyhow::Result<Arc<CommitDetails>> {
        if let Some(d) = self.get(hash) {
            return Ok(d);
        }
        let d = Arc::new(details_blocking(dir, hash)?);
        let mut map = self.0.lock();
        if map.len() > 2000 {
            map.clear();
        }
        map.insert(hash.to_owned(), d.clone());
        Ok(d)
    }
}

/// `branch -a --contains <hash> --format=%(refname)` -> names: local branches first, then remote
/// ones (`origin/x`, no `origin/HEAD`) (Lua `details.lua` `parse_branches`).
pub fn parse_branches(out: &str) -> Vec<String> {
    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    for r in out.lines() {
        if let Some(n) = r.strip_prefix("refs/heads/") {
            locals.push(n.to_owned());
        } else if let Some(n) = r.strip_prefix("refs/remotes/")
            && !n.ends_with("/HEAD")
        {
            remotes.push(n.to_owned());
        }
    }
    locals.extend(remotes);
    locals
}

/// The branches containing a commit ("In 2 branches: master, origin/master"). Blocking; slow in
/// big repos: load it separately from the details (Lua `details.lua` shows the rest first).
pub fn containing_branches_blocking(dir: &Path, hash: &str) -> anyhow::Result<Vec<String>> {
    let out = cli::run_blocking(
        dir,
        ["branch", "-a", "--contains", hash, "--format=%(refname)"],
    )?
    .into_result()?;
    Ok(parse_branches(&out))
}

/// The details line about branches (Lua `details.lua`): "In 1 branch: master", "In 9 branches:
/// a, b, …, h and 1 more" (8 named at most); None for no branches.
pub fn branches_text(branches: &[String]) -> Option<String> {
    if branches.is_empty() {
        return None;
    }
    let shown = &branches[..branches.len().min(8)];
    let mut s = if branches.len() == 1 {
        "In 1 branch: ".to_owned()
    } else {
        format!("In {} branches: ", branches.len())
    };
    s.push_str(&shown.join(", "));
    if branches.len() > shown.len() {
        s.push_str(&format!(" and {} more", branches.len() - shown.len()));
    }
    Some(s)
}

/// Several selected commits' changed files (Lua `details.lua` `show_many`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CombinedChanges {
    pub files: Vec<ChangedFile>,
    /// A file's diff: from before the oldest commit (its parent, or the empty tree for a root)...
    pub old_rev: String,
    /// ...to the newest.
    pub new_rev: String,
}

/// The selected commits (log order: newest first): every file any of them changed (renames
/// keep both names), as changed from before the oldest to the newest; files changed and changed
/// back are still listed (status M), unless gone. Blocking.
pub fn combined_blocking(dir: &Path, hashes: &[&str]) -> anyhow::Result<CombinedChanges> {
    let Some(oldest) = hashes.last() else {
        anyhow::bail!("no commits");
    };
    let base_check = cli::run_blocking(
        dir,
        ["rev-parse", "--verify", "--quiet", &format!("{oldest}^")],
    )?;
    let old_rev = if base_check.ok() {
        format!("{oldest}^")
    } else {
        EMPTY_TREE.to_owned()
    };
    combined_from(dir, hashes, old_rev, |h| {
        let out = cli::run_blocking(
            dir,
            [
                "show",
                "-z",
                "--format=",
                "--name-status",
                "-M",
                "--diff-merges=first-parent",
                h,
                "--",
            ],
        )?;
        Ok(out.ok().then(|| parse_name_status_z(&out.stdout)))
    })
}

impl DetailsCache {
    /// [`combined_blocking`] with each commit's files (and whether the oldest has a parent) from
    /// the cache: a selection that grows by one commit (held Space in the log) costs one
    /// `git show` + the combined `git diff`, like Lua `details.lua`'s per-hash `name_status`
    /// cache.
    pub fn combined_blocking(
        &self,
        dir: &Path,
        hashes: &[&str],
    ) -> anyhow::Result<CombinedChanges> {
        let Some(oldest) = hashes.last() else {
            anyhow::bail!("no commits");
        };
        let old_rev = if self.load_blocking(dir, oldest)?.parents.is_empty() {
            EMPTY_TREE.to_owned()
        } else {
            format!("{oldest}^")
        };
        combined_from(dir, hashes, old_rev, |h| {
            Ok(self.load_blocking(dir, h).ok().map(|d| d.files.clone()))
        })
    }
}

/// The combined files of `hashes` (newest first) from `old_rev` to the newest; `files_of` gives
/// one commit's own changed files (None: skip it).
fn combined_from(
    dir: &Path,
    hashes: &[&str],
    old_rev: String,
    mut files_of: impl FnMut(&str) -> anyhow::Result<Option<Vec<ChangedFile>>>,
) -> anyhow::Result<CombinedChanges> {
    let Some(newest) = hashes.first() else {
        anyhow::bail!("no commits");
    };
    let mut order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for h in hashes {
        let Some(files) = files_of(h)? else {
            continue;
        };
        for f in files {
            for p in f.old_path.into_iter().chain([f.path]) {
                if seen.insert(p.clone()) {
                    order.push(p);
                }
            }
        }
    }
    let result = |files| CombinedChanges {
        files,
        old_rev: old_rev.clone(),
        new_rev: newest.to_string(),
    };
    if order.is_empty() {
        return Ok(result(Vec::new()));
    }
    let mut args: Vec<String> = [
        "--literal-pathspecs",
        "diff",
        "-z",
        "--name-status",
        "-M",
        &old_rev,
        newest,
        "--",
    ]
    .map(String::from)
    .to_vec();
    args.extend(order.iter().cloned());
    let out = cli::run_blocking(dir, &args)?;
    let mut files = parse_name_status_z(&out.stdout);
    let mut listed: HashSet<&str> = HashSet::new();
    for f in &files {
        listed.insert(&f.path);
        if let Some(o) = &f.old_path {
            listed.insert(o);
        }
    }
    let left: Vec<String> = order
        .iter()
        .filter(|p| !listed.contains(p.as_str()))
        .cloned()
        .collect();
    if !left.is_empty() {
        let mut args: Vec<String> = [
            "--literal-pathspecs",
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            newest,
            "--",
        ]
        .map(String::from)
        .to_vec();
        args.extend(left);
        let out = cli::run_blocking(dir, &args)?;
        files.extend(
            out.stdout
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(|p| ChangedFile {
                    change: FileChange::Modified,
                    path: p.to_owned(),
                    old_path: None,
                }),
        );
    }
    Ok(result(files))
}

/// A file's text at a revision (`git show rev:path`; `rev` "" = the index, `:path`): None when
/// the file isn't there (`git/cli.lua` `show` gave ""). Blocking.
pub fn file_at_blocking(dir: &Path, rev: &str, path: &str) -> Option<String> {
    let out = cli::run_blocking(dir, ["show", &format!("{rev}:{path}")]).ok()?;
    out.ok().then_some(out.stdout)
}

/// A revision's 8-char hash (diff pane headers). Blocking.
pub fn short_hash_blocking(dir: &Path, rev: &str) -> Option<String> {
    let out = cli::run_blocking(dir, ["rev-parse", "--short=8", rev]).ok()?;
    out.ok().then(|| out.stdout.trim().to_owned())
}

/// The balloon after copying a hash (Lua `actions.lua`: "Copied 1a2b3c4d").
pub fn copied_text(hash: &str) -> String {
    format!("Copied {}", &hash[..hash.len().min(8)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status_with_renames_and_odd_names() {
        let out = "\nM\0a b.ts\0R087\0old\tx\0new\nx\0C100\0src\0dst\0D\0gone\0A\0added\0T\0link\0";
        let files = parse_name_status_z(out);
        assert_eq!(files.len(), 6);
        assert_eq!(files[0].path, "a b.ts");
        assert_eq!(files[1].change, FileChange::Renamed(87));
        assert_eq!(files[1].old_path.as_deref(), Some("old\tx"));
        assert_eq!(files[1].path, "new\nx");
        assert_eq!(files[2].change.letter(), 'C');
        assert_eq!(files[3].change.letter(), 'D');
        assert_eq!(files[5].change.letter(), 'M');
    }

    #[test]
    fn show_output() {
        let out = "abc1234\x1fp1\x1fA\x1fa@x\x1f10\x1f1970-01-01T00:00:10+01:00\x1fC\x1fc@x\x1f20\x1f\
                   1970-01-01T00:00:20Z\x1fSubject\n\nBody line.\n\x1e\0\nM\0f.ts\0";
        let d = parse_show(out).unwrap();
        assert_eq!(d.subject(), "Subject");
        assert_eq!(d.body(), "Body line.");
        assert!(d.other_committer());
        assert_eq!(d.author_time.offset_min, 60);
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.revs(), ("abc1234^".into(), "abc1234".into()));
    }

    #[test]
    fn branches_line() {
        let out = "refs/remotes/origin/HEAD\nrefs/remotes/origin/master\nrefs/heads/master\n";
        let b = parse_branches(out);
        assert_eq!(b, ["master", "origin/master"]);
        assert_eq!(branches_text(&b[..1]).unwrap(), "In 1 branch: master");
        assert_eq!(
            branches_text(&b).unwrap(),
            "In 2 branches: master, origin/master"
        );
        let many: Vec<String> = (1..=10).map(|i| format!("b{i}")).collect();
        assert_eq!(
            branches_text(&many).unwrap(),
            "In 10 branches: b1, b2, b3, b4, b5, b6, b7, b8 and 2 more"
        );
        assert_eq!(branches_text(&[]), None);
        assert_eq!(copied_text("0123456789abc"), "Copied 01234567");
    }
}
