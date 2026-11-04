//! `git status` for the Project tree's name colors, read with the `git` CLI off the UI thread.
//!
//! Same XY rule as `nvim/lua/git/status.lua` (`file_status`), same colors as the M4 Lua tree
//! (`name_hl`; drawn by `crate::shell::tree::view`): ignored names (and everything under an ignored folder) orange,
//! untracked red (also everything inside an untracked folder), added green, conflicts red, other
//! tracked changes blue; a folder is blue when a tracked change is somewhere inside it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use gpui_kit::{App, AppContext as _, Rgba, Task};

use super::cli;
use crate::look;

/// What a file's name shows (`git/status.lua` `file_status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileStatus {
    Modified,
    Added,
    Unversioned,
    Ignored,
    Deleted,
    Conflict,
}

impl FileStatus {
    /// From its name ("Modified", ...: what Lua sends for tab labels).
    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "Modified" => Self::Modified,
            "Added" => Self::Added,
            "Unversioned" => Self::Unversioned,
            "Ignored" => Self::Ignored,
            "Deleted" => Self::Deleted,
            "Conflict" => Self::Conflict,
            _ => return None,
        })
    }

    /// The name color (WebStorm file status colors; the one map: tree, tabs, changes trees).
    pub fn color(self) -> Rgba {
        match self {
            FileStatus::Modified => look::GIT_MODIFIED.rgba(),
            FileStatus::Added => look::GIT_ADDED.rgba(),
            FileStatus::Unversioned => look::GIT_UNTRACKED.rgba(),
            FileStatus::Ignored => look::GIT_IGNORED.rgba(),
            FileStatus::Deleted => look::GIT_DELETED.rgba(),
            FileStatus::Conflict => look::GIT_CONFLICT.rgba(),
        }
    }
}

/// Both sides changed it, or one deleted what the other changed / both added it.
pub fn is_conflict(xy: &str) -> bool {
    let b = xy.as_bytes();
    b.len() == 2 && (b[0] == b'U' || b[1] == b'U' || xy == "AA" || xy == "DD")
}

/// Porcelain XY -> status (`git/status.lua` `file_status`).
pub fn file_status(xy: &str) -> Option<FileStatus> {
    match xy {
        "??" => return Some(FileStatus::Unversioned),
        "!!" => return Some(FileStatus::Ignored),
        _ => {}
    }
    if is_conflict(xy) {
        return Some(FileStatus::Conflict);
    }
    let b = xy.as_bytes();
    if b.len() != 2 {
        return None;
    }
    if b[0] == b'A' {
        return Some(FileStatus::Added);
    }
    let c = if b[0] != b' ' { b[0] } else { b[1] };
    match c {
        b'A' => Some(FileStatus::Added),
        b'M' | b'R' | b'C' | b'T' => Some(FileStatus::Modified),
        b'D' => Some(FileStatus::Deleted),
        _ => None,
    }
}

/// One read of `git status`, paths relative to the project dir (not the repo root).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitStatus {
    /// File (or untracked folder, no trailing slash) -> status.
    files: HashMap<PathBuf, FileStatus>,
    /// Ignored files / folders (`--ignored=matching`: a folder stands for all inside it).
    ignored: HashSet<PathBuf>,
    /// Untracked folders (`?? dir/`): everything inside is untracked.
    untracked_dirs: HashSet<PathBuf>,
    /// Folders with a tracked change inside.
    changed_dirs: HashSet<PathBuf>,
}

impl GitStatus {
    /// Parses `git status --porcelain=v1 -z --ignored=matching` output; `prefix` = the project dir
    /// relative to the repo root (`rev-parse --show-prefix`, "" or ending in `/`).
    pub fn parse(out: &str, prefix: &str) -> GitStatus {
        let mut s = GitStatus::default();
        let mut parts = out.split('\0');
        while let Some(e) = parts.next() {
            if e.len() < 4 || e.starts_with("## ") {
                continue;
            }
            let (xy, path) = (&e[..2], &e[3..]);
            if xy.contains(['R', 'C']) {
                parts.next(); // the old path
            }
            // the project's own part of the repo
            let Some(rel) = path.strip_prefix(prefix) else {
                continue;
            };
            let is_dir = rel.ends_with('/');
            let rel = PathBuf::from(rel.trim_end_matches('/'));
            if rel.as_os_str().is_empty() {
                continue;
            }
            match xy {
                "!!" => {
                    s.ignored.insert(rel);
                }
                "??" if is_dir => {
                    s.untracked_dirs.insert(rel);
                }
                _ => {
                    let Some(st) = file_status(xy) else { continue };
                    if st != FileStatus::Unversioned {
                        for a in rel.ancestors().skip(1) {
                            if a.as_os_str().is_empty() || !s.changed_dirs.insert(a.to_path_buf()) {
                                break;
                            }
                        }
                    }
                    s.files.insert(rel, st);
                }
            }
        }
        s
    }

    /// How many files are changed (an untracked folder counts once): the ear's Git badge.
    pub fn changed(&self) -> usize {
        self.files.len() + self.untracked_dirs.len()
    }

    /// The color of a row's name (`rel`: relative to the project dir; "" = the root row).
    pub fn color(&self, rel: &Path, dir: bool) -> Option<Rgba> {
        self.status(rel, dir).map(FileStatus::color)
    }

    /// What a row shows (its name color in `crate::shell::tree::view`).
    pub fn status(&self, rel: &Path, dir: bool) -> Option<FileStatus> {
        if rel.as_os_str().is_empty() {
            return None;
        }
        let mut untracked = false;
        for a in rel.ancestors() {
            if a.as_os_str().is_empty() {
                break;
            }
            if self.ignored.contains(a) {
                return Some(FileStatus::Ignored);
            }
            untracked = untracked || self.untracked_dirs.contains(a);
        }
        if untracked {
            return Some(FileStatus::Unversioned);
        }
        if dir {
            // WebStorm marks a folder only for tracked changes inside it
            return self
                .changed_dirs
                .contains(rel)
                .then_some(FileStatus::Modified);
        }
        self.files.get(rel).copied()
    }

    /// Is `rel` (or a folder above it) gitignored?
    pub fn is_ignored(&self, rel: &Path) -> bool {
        rel.ancestors()
            .take_while(|a| !a.as_os_str().is_empty())
            .any(|a| self.ignored.contains(a))
    }
}

/// Reads the status of the repo `dir` is in (None outside a repo / when git fails). Blocking:
/// call it from a background task.
pub fn read_blocking(dir: &Path) -> Option<GitStatus> {
    let prefix = cli::run_blocking(dir, ["rev-parse", "--show-prefix"]).ok()?;
    if !prefix.ok() {
        return None;
    }
    let prefix = prefix.stdout.trim_end_matches('\n').to_owned();
    let out = cli::run_blocking(
        dir,
        ["status", "--porcelain=v1", "-z", "--ignored=matching"],
    )
    .ok()?;
    out.ok().then(|| GitStatus::parse(&out.stdout, &prefix))
}

/// [`read_blocking`] off the UI thread (a cloud workspace's on a thread of its own).
pub fn read(dir: PathBuf, cx: &App) -> Task<Option<GitStatus>> {
    let job = crate::shell::remote::background(&dir.clone(), cx, move || read_blocking(&dir));
    cx.background_spawn(async move { job.await.flatten() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xy_rule_matches_the_lua_one() {
        use FileStatus::*;
        for (xy, want) in [
            ("??", Some(Unversioned)),
            ("!!", Some(Ignored)),
            ("UU", Some(Conflict)),
            ("AA", Some(Conflict)),
            ("DD", Some(Conflict)),
            ("A ", Some(Added)),
            ("AM", Some(Added)),
            (" M", Some(Modified)),
            ("M ", Some(Modified)),
            ("R ", Some(Modified)),
            (" D", Some(Deleted)),
            ("  ", None),
        ] {
            assert_eq!(file_status(xy), want, "{xy:?}");
        }
    }

    const PORCELAIN: &str = " M b.ts\0 M src/main.ts\0?? new.ts\0?? fresh/\0!! node_modules/\0!! ignored.log\0R  c2.ts\0c.ts\0";
    const SUBFOLDER: &str = " M app/x.ts\0 M other/y.ts\0";

    struct Colour {
        name: &'static str,
        out: &'static str,
        /// The project's folder in the repo.
        prefix: &'static str,
        path: &'static str,
        dir: bool,
        want: Option<FileStatus>,
    }

    const fn row(
        name: &'static str,
        path: &'static str,
        dir: bool,
        want: Option<FileStatus>,
    ) -> Colour {
        Colour {
            name,
            out: PORCELAIN,
            prefix: "",
            path,
            dir,
            want,
        }
    }

    const COLOURS: &[Colour] = {
        use FileStatus::*;
        &[
            row("modified", "b.ts", false, Some(Modified)),
            row("new", "new.ts", false, Some(Unversioned)),
            row("a new folder", "fresh", true, Some(Unversioned)),
            row("in a new folder", "fresh/x/y.ts", false, Some(Unversioned)),
            row("ignored", "ignored.log", false, Some(Ignored)),
            row("an ignored folder", "node_modules", true, Some(Ignored)),
            row(
                "in an ignored folder",
                "node_modules/lib/i.js",
                false,
                Some(Ignored),
            ),
            row(
                "a folder with a tracked change",
                "src",
                true,
                Some(Modified),
            ),
            row("a clean folder", "backend", true, None),
            row("renamed to", "c2.ts", false, Some(Modified)),
            row("renamed from", "c.ts", false, None),
            row("the root", "", true, None),
            Colour {
                name: "a project in a subfolder of the repo",
                out: SUBFOLDER,
                prefix: "app/",
                path: "x.ts",
                dir: false,
                want: Some(Modified),
            },
            Colour {
                name: "a change outside the project",
                out: SUBFOLDER,
                prefix: "app/",
                path: "other/y.ts",
                dir: false,
                want: None,
            },
        ]
    };

    #[test]
    fn paths_take_the_lua_trees_colours() {
        for row in COLOURS {
            let s = GitStatus::parse(row.out, row.prefix);
            assert_eq!(
                s.status(Path::new(row.path), row.dir),
                row.want,
                "{}",
                row.name
            );
        }
        assert!(GitStatus::parse(PORCELAIN, "").is_ignored(Path::new("node_modules/a")));
    }
}
