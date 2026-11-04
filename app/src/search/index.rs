//! Project file and folder list for Go to File / Search Everywhere.
//!
//! The project scope ([`crate::search::scope`], the M4 snacks `files` source's rules, `fd --type f
//! --type l --color never -E .git`: hidden entries skipped, .gitignore (only inside a git repo),
//! .ignore, .fdignore, the global git excludes and .git/info/exclude) plus WebStorm's excluded
//! folders (`node_modules`, the `.idea/*.iml` excludes); symlinks listed but not followed. Folders
//! come from the same walk (WebStorm's Go to File lists them too): every folder it enters, so an
//! ignored / excluded folder is left out like its files.

use std::collections::BTreeSet;
use std::io::Read as _;
use std::path::Path;

use ignore::{DirEntry, ParallelVisitor, ParallelVisitorBuilder, WalkState};
use parking_lot::Mutex;

use crate::search::scope::{self, Exclusions};

/// All project files and folders under `root` as relative `/`-separated paths (folders end with
/// `/`), sorted lexicographically so the order is deterministic (the parallel walker yields
/// entries in any order). Reads the `.idea` excludes afresh: every walk sees the current ones.
#[cfg(test)]
pub fn walk(root: &Path) -> Vec<String> {
    walk_with(root, false, false)
}

/// [`walk`] with snacks' Alt+H / Alt+I toggles: `hidden` lists hidden files, `ignored` drops the
/// whole scope (ignore files and excluded folders; fd `--hidden` / `--no-ignore`).
pub fn walk_with(root: &Path, hidden: bool, ignored: bool) -> Vec<String> {
    let excl = (!ignored).then(|| Exclusions::read(root));
    let builder = scope::walker(root, excl.as_ref(), hidden);

    let out = Mutex::new(Vec::new());
    builder
        .build_parallel()
        .visit(&mut Collect { root, out: &out });
    // `visit` joins its threads, so every visitor has flushed by now
    let mut paths = out.into_inner();
    paths.sort_unstable();
    paths
}

/// [`walk_with`] for any project: a cloud workspace's from one `rg --files` on its box (its
/// folder is no folder here), folders from the files' paths. None: the box did not answer.
/// Blocking: a round trip to the box.
pub fn list(root: &Path, hidden: bool, ignored: bool) -> Option<Vec<String>> {
    let Some(exec) = crate::shell::remote::exec_for(root) else {
        return Some(walk_with(root, hidden, ignored));
    };
    let mut args = vec!["--files".to_owned(), "--null".to_owned()];
    if hidden {
        args.push("--hidden".into());
    }
    args.extend(scope::rg_never());
    if ignored {
        args.push("--no-ignore".into());
    } else {
        // the box's `.idea` is not read here: its excluded folders are node_modules
        args.extend(Exclusions::read(root).rg_globs());
    }
    let mut child = crate::shell::remote::rg(&exec, root, !ignored, &args)?
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    // rg there runs while its input is open: held until its output is read
    let input = child.stdin.take();
    let mut out = Vec::new();
    child.stdout.take()?.read_to_end(&mut out).ok()?;
    drop(input);
    let status = child.wait().ok()?;
    // 1: no files; 2: some unreadable, the rest listed
    match status.code() {
        Some(0 | 1) => {}
        Some(2) if !out.is_empty() => {}
        _ => return None,
    }
    Some(with_folders(&out))
}

/// `rg --files --null`'s paths and the folders above them (`/`-ended), sorted.
fn with_folders(out: &[u8]) -> Vec<String> {
    let mut all = BTreeSet::new();
    for rec in out.split(|b| *b == 0) {
        // non-UTF-8 names can't round-trip through nvim's string API; skip them
        let Ok(rel) = std::str::from_utf8(rec) else {
            continue;
        };
        let rel = rel.strip_prefix("./").unwrap_or(rel);
        if rel.is_empty() {
            continue;
        }
        for (i, _) in rel.match_indices('/') {
            all.insert(rel[..=i].to_owned());
        }
        all.insert(rel.to_owned());
    }
    all.into_iter().collect()
}

struct Collect<'a> {
    root: &'a Path,
    out: &'a Mutex<Vec<String>>,
}

impl<'s> ParallelVisitorBuilder<'s> for Collect<'s> {
    fn build(&mut self) -> Box<dyn ParallelVisitor + 's> {
        Box::new(Visitor {
            root: self.root,
            local: Vec::new(),
            out: self.out,
        })
    }
}

/// Per-thread buffer: one lock per thread instead of one per file.
struct Visitor<'a> {
    root: &'a Path,
    local: Vec<String>,
    out: &'a Mutex<Vec<String>>,
}

impl ParallelVisitor for Visitor<'_> {
    fn visit(&mut self, entry: Result<DirEntry, ignore::Error>) -> WalkState {
        // unreadable dirs / broken entries: skip them like fd does, keep walking
        let Ok(entry) = entry else {
            return WalkState::Continue;
        };
        let Some(ft) = entry.file_type() else {
            return WalkState::Continue;
        };
        // the root itself isn't a row
        let dir = ft.is_dir() && entry.depth() > 0;
        if !(dir || ft.is_file() || ft.is_symlink()) {
            return WalkState::Continue;
        }
        let Ok(rel) = entry.path().strip_prefix(self.root) else {
            return WalkState::Continue;
        };
        // non-UTF-8 names can't round-trip through nvim's string API; skip them
        if let Some(rel) = rel.to_str() {
            let mut rel = if std::path::MAIN_SEPARATOR == '/' {
                rel.to_owned()
            } else {
                rel.replace(std::path::MAIN_SEPARATOR, "/")
            };
            if dir {
                rel.push('/');
            }
            self.local.push(rel);
        }
        WalkState::Continue
    }
}

impl Drop for Visitor<'_> {
    fn drop(&mut self) {
        self.out.lock().append(&mut self.local);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use std::time::Instant;

    #[test]
    fn rg_files_paths_come_with_their_folders() {
        assert_eq!(
            with_folders(b"src/a/b.ts\0./README.md\0src/c.ts\0\0"),
            ["README.md", "src/", "src/a/", "src/a/b.ts", "src/c.ts"]
        );
    }

    struct Walk {
        name: &'static str,
        /// `git init` before the files are written.
        git: bool,
        files: &'static [(&'static str, &'static str)],
        /// (link, target)
        links: &'static [(&'static str, &'static str)],
        ignored: bool,
        want: &'static [&'static str],
    }

    const GITIGNORED: &[(&str, &str)] = &[
        ("keep.ts", "x"),
        ("vendor/pkg/index.js", "x"),
        ("dist/out.js", "x"),
        (".gitignore", "vendor\n/dist\n"),
    ];

    const IML: &[(&str, &str)] = &[
        ("src/a.ts", "x"),
        ("dist/out.js", "x"),
        ("node_modules/p/i.js", "x"),
        (
            ".idea/w.iml",
            "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />",
        ),
    ];

    const WALK: &[Walk] = &[
        Walk {
            name: "hidden files are skipped, symlinks listed",
            git: false,
            files: &[
                ("a.txt", "x"),
                (".hidden", "x"),
                (".config/x.lua", "x"),
                ("src/b.rs", "x"),
            ],
            links: &[("link.rs", "src/b.rs"), ("srclink", "src")],
            ignored: false,
            want: &["a.txt", "link.rs", "src/", "src/b.rs", "srclink"],
        },
        Walk {
            name: "outside a git repo .gitignore is not read",
            git: false,
            files: GITIGNORED,
            links: &[],
            ignored: false,
            want: &[
                "dist/",
                "dist/out.js",
                "keep.ts",
                "vendor/",
                "vendor/pkg/",
                "vendor/pkg/index.js",
            ],
        },
        Walk {
            name: "inside a git repo .gitignore and info/exclude apply",
            git: true,
            files: &[
                ("keep.ts", "x"),
                ("vendor/pkg/index.js", "x"),
                ("dist/out.js", "x"),
                (".gitignore", "vendor\n/dist\n"),
                ("excluded.txt", "x"),
                (".git/info/exclude", "excluded.txt\n"),
            ],
            links: &[],
            ignored: false,
            want: &["keep.ts"],
        },
        Walk {
            name: ".ignore and .fdignore apply",
            git: false,
            files: &[
                ("a.txt", "x"),
                ("b.log", "x"),
                ("c.tmp", "x"),
                (".ignore", "*.log\n"),
                (".fdignore", "*.tmp\n"),
            ],
            links: &[],
            ignored: false,
            want: &["a.txt"],
        },
        Walk {
            name: ".iml excluded folders and node_modules are left out",
            git: false,
            files: IML,
            links: &[],
            ignored: false,
            want: &["src/", "src/a.ts"],
        },
        Walk {
            name: "ignored files on: the scope's folders are listed",
            git: false,
            files: IML,
            links: &[],
            ignored: true,
            want: &[
                "dist/",
                "dist/out.js",
                "node_modules/",
                "node_modules/p/",
                "node_modules/p/i.js",
                "src/",
                "src/a.ts",
            ],
        },
        Walk {
            name: ".git is left out",
            git: true,
            files: &[("a.txt", "x")],
            links: &[],
            ignored: false,
            want: &["a.txt"],
        },
    ];

    #[test]
    fn walk_lists_what_the_scope_allows() {
        for row in WALK {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            if row.git {
                let ok = Command::new("git")
                    .args(["init", "-q"])
                    .current_dir(root)
                    .status()
                    .unwrap()
                    .success();
                assert!(ok, "{}: git init", row.name);
            }
            for (rel, body) in row.files {
                let p = root.join(rel);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(p, body).unwrap();
            }
            for (link, target) in row.links {
                std::os::unix::fs::symlink(target, root.join(link)).unwrap();
            }
            assert_eq!(
                walk_with(root, false, row.ignored),
                row.want,
                "{}",
                row.name
            );
        }
    }

    #[test]
    fn perf_10k_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for d in 0..100 {
            let sub = root.join(format!("src/dir{d}/sub"));
            fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                fs::write(sub.join(format!("file{f}.ts")), "").unwrap();
            }
        }
        let t = Instant::now();
        let entries = walk(root);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        println!("index::walk 10k files: {ms:.1} ms");
        let dirs = entries.iter().filter(|p| p.ends_with('/')).count();
        assert_eq!((entries.len() - dirs, dirs), (10_000, 201));
        assert!(ms < 300.0, "walk took {ms:.1} ms");
    }
}
