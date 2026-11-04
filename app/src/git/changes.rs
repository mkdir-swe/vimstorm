//! Local Changes data (Lua `git/changes.lua` + `git/status.lua`): `git status` porcelain v2
//! (`-z`, every untracked file like Lua's `-uall`, ignored files left out), staged / unstaged
//! sides, renames with their old path, merge conflicts (unmerged XY); the tab's sections
//! (Merge Conflicts / Changes / Unversioned Files) and the merge in progress with git's prepared
//! message.

use std::path::Path;

use super::cli;
use super::repo::{self, Operation};
use super::status;

/// What a file shows in Local Changes (Lua `status.letter`: ? unversioned, U conflict, D, R, A,
/// else M).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Unversioned,
    Conflict,
}

impl ChangeKind {
    pub fn letter(self) -> char {
        match self {
            ChangeKind::Modified => 'M',
            ChangeKind::Added => 'A',
            ChangeKind::Deleted => 'D',
            ChangeKind::Renamed => 'R',
            ChangeKind::Unversioned => '?',
            ChangeKind::Conflict => 'U',
        }
    }

    /// `git/status.lua` `letter` on a porcelain XY.
    pub fn from_xy(xy: &str) -> ChangeKind {
        if xy == "??" {
            ChangeKind::Unversioned
        } else if status::is_conflict(xy) {
            ChangeKind::Conflict
        } else if xy.contains('D') {
            ChangeKind::Deleted
        } else if xy.contains('R') {
            ChangeKind::Renamed
        } else if xy.contains('A') {
            ChangeKind::Added
        } else {
            ChangeKind::Modified
        }
    }
}

/// A changed (or unversioned / conflicted) file.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Change {
    /// Repo-relative.
    pub path: String,
    /// Renames / copies: where it came from.
    pub old_path: Option<String>,
    /// Porcelain v1 style XY (`' '` = unchanged side; `??` untracked).
    pub xy: String,
    pub kind: ChangeKind,
}

impl Change {
    /// Has staged changes (index side).
    pub fn staged(&self) -> bool {
        let x = self.xy.as_bytes()[0];
        x != b' ' && x != b'?'
    }

    /// Has changes not staged (work tree side).
    pub fn unstaged(&self) -> bool {
        let y = self.xy.as_bytes()[1];
        y != b' ' && y != b'?'
    }
}

/// The `# branch.*` headers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchHeader {
    /// None before the first commit.
    pub oid: Option<String>,
    /// None when detached.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// One read of Local Changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalChanges {
    pub branch: BranchHeader,
    /// git's order (by path).
    pub files: Vec<Change>,
    /// A merge in progress (MERGE_HEAD): commits take every tracked change.
    pub merging: bool,
    /// The operation in progress, if any.
    pub operation: Option<Operation>,
    /// The message git prepared (MERGE_MSG: merge / revert / cherry-pick / failed squash).
    pub prepared_message: Option<String>,
}

/// Local Changes' top-level nodes (WS: the changelist, then unversioned files; conflicts first).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Conflicts,
    Changes,
    Unversioned,
}

impl Section {
    pub fn of(kind: ChangeKind) -> Section {
        match kind {
            ChangeKind::Conflict => Section::Conflicts,
            ChangeKind::Unversioned => Section::Unversioned,
            _ => Section::Changes,
        }
    }
}

impl LocalChanges {
    /// The non-empty sections with their files, in the tab's order (Lua `changes.lua` `render`).
    pub fn sections(&self) -> Vec<(Section, Vec<&Change>)> {
        [Section::Conflicts, Section::Changes, Section::Unversioned]
            .into_iter()
            .map(|s| {
                (
                    s,
                    self.files
                        .iter()
                        .filter(|f| Section::of(f.kind) == s)
                        .collect::<Vec<_>>(),
                )
            })
            .filter(|(_, f)| !f.is_empty())
            .collect()
    }

    pub fn has_conflicts(&self) -> bool {
        self.files.iter().any(|f| f.kind == ChangeKind::Conflict)
    }

    pub fn file(&self, path: &str) -> Option<&Change> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// `git status --porcelain=v2 -z --branch` output -> changes.
pub fn parse_porcelain_v2(out: &str) -> (BranchHeader, Vec<Change>) {
    let mut b = BranchHeader::default();
    let mut files = Vec::new();
    let mut it = out.split('\0');
    let v1_xy = |xy: &str| xy.replace('.', " ");
    while let Some(e) = it.next() {
        if let Some(h) = e.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" if v != "(initial)" => b.oid = Some(v.to_owned()),
                "branch.head" if v != "(detached)" => b.head = Some(v.to_owned()),
                "branch.upstream" => b.upstream = Some(v.to_owned()),
                "branch.ab" => {
                    for p in v.split(' ') {
                        if let Some(n) = p.strip_prefix('+') {
                            b.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix('-') {
                            b.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let Some(kind) = e.chars().next() else {
            continue;
        };
        match kind {
            '1' => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = e.splitn(9, ' ').collect();
                if f.len() == 9 {
                    let xy = v1_xy(f[1]);
                    files.push(Change {
                        path: f[8].to_owned(),
                        old_path: None,
                        kind: ChangeKind::from_xy(&xy),
                        xy,
                    });
                }
            }
            '2' => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let f: Vec<&str> = e.splitn(10, ' ').collect();
                let old = it.next().map(str::to_owned);
                if f.len() == 10 {
                    let xy = v1_xy(f[1]);
                    files.push(Change {
                        path: f[9].to_owned(),
                        old_path: old,
                        kind: ChangeKind::from_xy(&xy),
                        xy,
                    });
                }
            }
            'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = e.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let xy = v1_xy(f[1]);
                    files.push(Change {
                        path: f[10].to_owned(),
                        old_path: None,
                        kind: ChangeKind::Conflict,
                        xy,
                    });
                }
            }
            '?' => files.push(Change {
                path: e[2..].to_owned(),
                old_path: None,
                xy: "??".into(),
                kind: ChangeKind::Unversioned,
            }),
            _ => {} // '!' ignored: not in Local Changes
        }
    }
    (b, files)
}

/// The message git prepared for a merge / revert / cherry-pick in progress: MERGE_MSG without its
/// `#` comment lines, trimmed (the Lua prompt took its first line; the commit message area takes
/// it whole, like WS). None when there's none.
pub fn prepared_message(git_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(git_dir.join("MERGE_MSG")).ok()?;
    let msg: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).collect();
    let msg = msg.join("\n").trim().to_owned();
    (!msg.is_empty()).then_some(msg)
}

/// Reads Local Changes (`git status` like `git/status.lua`, `--no-optional-locks` via the
/// runner). Blocking.
pub fn read_blocking(dir: &Path) -> anyhow::Result<LocalChanges> {
    let out = cli::run_blocking(
        dir,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?
    .into_result()?;
    let (branch, files) = parse_porcelain_v2(&out);
    let git_dir = cli::run_blocking(dir, ["rev-parse", "--absolute-git-dir"])?.into_result()?;
    let git_dir = Path::new(git_dir.trim());
    let operation = repo::operation_in(git_dir);
    Ok(LocalChanges {
        branch,
        files,
        merging: git_dir.join("MERGE_HEAD").exists(),
        operation,
        prepared_message: prepared_message(git_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_v2_entries() {
        let out = "# branch.oid adf9b0e\0# branch.head master\0# branch.upstream origin/master\0\
                   # branch.ab +5 -1\0\
                   1 .M N... 100644 100644 100644 b5 b5 diff.ts\0\
                   1 A. N... 000000 100644 100644 00 aa src/with space.ts\0\
                   1 MM N... 100644 100644 100644 b5 b6 both.ts\0\
                   1 .D N... 100644 100644 000000 b5 b5 gone.ts\0\
                   2 R. N... 100644 100644 100644 b5 b5 R100 new name.ts\0old name.ts\0\
                   u UU N... 100644 100644 100644 100644 0f be 0a conflict.ts\0\
                   u AA N... 000000 100644 100644 100644 00 be 0a both-added.ts\0\
                   ? src/new.ts\0! ignored.log\0";
        let (b, files) = parse_porcelain_v2(out);
        assert_eq!(b.head.as_deref(), Some("master"));
        assert_eq!(b.upstream.as_deref(), Some("origin/master"));
        assert_eq!((b.ahead, b.behind), (5, 1));
        let kinds: Vec<char> = files.iter().map(|f| f.kind.letter()).collect();
        assert_eq!(kinds, ['M', 'A', 'M', 'D', 'R', 'U', 'U', '?']);
        assert_eq!(files[0].xy, " M");
        assert!(!files[0].staged() && files[0].unstaged());
        assert!(files[1].staged() && !files[1].unstaged());
        assert_eq!(files[1].path, "src/with space.ts");
        assert!(files[2].staged() && files[2].unstaged());
        assert_eq!(files[4].path, "new name.ts");
        assert_eq!(files[4].old_path.as_deref(), Some("old name.ts"));
        assert!(!files[7].staged() && !files[7].unstaged());
        let lc = LocalChanges {
            branch: b,
            files,
            ..Default::default()
        };
        let sections: Vec<(Section, usize)> =
            lc.sections().iter().map(|(s, f)| (*s, f.len())).collect();
        assert_eq!(
            sections,
            [
                (Section::Conflicts, 2),
                (Section::Changes, 5),
                (Section::Unversioned, 1)
            ]
        );
        assert!(lc.has_conflicts());
        // a detached head on an initial commit: no oid, no head
        let (b, files) = parse_porcelain_v2("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((b.oid, b.head), (None, None));
        assert!(files.is_empty());
    }

    #[test]
    fn prepared_merge_message() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(prepared_message(dir.path()), None);
        std::fs::write(
            dir.path().join("MERGE_MSG"),
            "Merge branch 'feature'\n\n# Conflicts:\n#\tconflict.ts\n",
        )
        .unwrap();
        assert_eq!(
            prepared_message(dir.path()).as_deref(),
            Some("Merge branch 'feature'")
        );
    }
}
