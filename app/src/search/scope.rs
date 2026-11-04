//! The project scope: which files a search sees. One rule for every search (tree speed search,
//! Expand All, Go to File / Search Everywhere files + folders, Find in Files):
//!
//! - the gitignore family: `.gitignore` (inside a git repo, like fd / rg), `.ignore`, `.fdignore`,
//!   the global git excludes and `.git/info/exclude`;
//! - WebStorm's excluded folders ([`Exclusions`]): `node_modules` (a library root, which WebStorm
//!   leaves out of project searches too) and the `.idea/*.iml` `excludeFolder` / `excludePattern`
//!   entries;
//! - `.git` and `.DS_Store` never.
//!
//! The pickers' Alt+I ("include ignored", snacks' `ignored`) drops all of it but `.git` /
//! `.DS_Store`. The tree still SHOWS excluded folders (tinted orange); only its search and Expand
//! All leave them out. Find in Files gets the same rule through rg: rg applies the gitignore
//! family itself (same semantics), the exclusions go in as `--glob=!…` ([`Exclusions::rg_globs`]).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Names never listed (snacks `exclude`; fd's `-E .git`).
pub const NEVER: [&str; 2] = [".git", ".DS_Store"];
/// Never searched either (the tree still shows it): a bare repo's git dir next to its worktrees.
const NEVER_SEARCHED: [&str; 1] = [".bare"];

/// The library root WebStorm leaves out of project searches (the tree labels it "library root").
pub const LIBRARY_ROOT: &str = "node_modules";

/// rg globs for what searches never see ([`NEVER`], `.bare`), whatever the scope (Alt+I too).
pub fn rg_never() -> Vec<String> {
    NEVER
        .iter()
        .chain(&NEVER_SEARCHED)
        .map(|n| format!("--glob=!{n}"))
        .collect()
}

/// A shell glob on one name: `*` any run, `?` one char (the `.iml` exclude patterns).
pub fn glob_match(pat: &str, name: &str) -> bool {
    if !pat.contains(['*', '?']) {
        return pat == name;
    }
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    wild(&p, &n)
}

/// Wildcard match without recursion blow-up: greedy `*`, backtracking to the last one.
fn wild(p: &[char], n: &[char]) -> bool {
    let (mut pi, mut ni) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        match p.get(pi) {
            Some('*') => {
                star = Some((pi, ni));
                pi += 1;
            }
            Some(c) if *c == '?' || *c == n[ni] => {
                pi += 1;
                ni += 1;
            }
            _ => match star {
                Some((sp, sn)) => {
                    pi = sp + 1;
                    ni = sn + 1;
                    star = Some((sp, sn + 1));
                }
                None => return false,
            },
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// Excluded folders and the module name of a project (WebStorm's `.idea`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Exclusions {
    root: PathBuf,
    /// Name globs (`node_modules` + `excludePattern`s): folders and files of that name.
    patterns: Vec<String>,
    /// `excludeFolder`s (absolute).
    dirs: HashSet<PathBuf>,
    /// `.idea/modules.xml`'s module, shown `[like this]` on the root row when it differs from
    /// the folder's name.
    pub module: Option<String>,
    /// The files read (`.idea/*.iml`, `modules.xml`): the tree polls them for in-place edits.
    sources: Vec<PathBuf>,
    /// The root's `.fdignore`, if any (rg reads only `.gitignore` / `.ignore` / `.rgignore` by
    /// itself).
    fdignore: Option<PathBuf>,
}

impl Exclusions {
    /// Reads `.idea/*.iml` and `.idea/modules.xml` (missing: just `node_modules`). Blocking (a
    /// few small files): run it off the UI thread.
    pub fn read(root: &Path) -> Exclusions {
        let mut ex = Exclusions {
            root: root.to_path_buf(),
            patterns: vec![LIBRARY_ROOT.into()],
            ..Default::default()
        };
        let idea = root.join(".idea");
        if let Ok(rd) = std::fs::read_dir(&idea) {
            let mut imls: Vec<PathBuf> = rd
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "iml"))
                .collect();
            imls.sort();
            for p in imls {
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                for line in text.lines() {
                    if let Some(pats) = attr_after(line, "<excludePattern pattern=\"") {
                        // WebStorm's field takes several, `;`-separated
                        for pat in pats.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                            if !ex.patterns.iter().any(|q| q == pat) {
                                ex.patterns.push(pat.to_owned());
                            }
                        }
                    }
                    if let Some(dir) = attr_after(line, "<excludeFolder url=\"file://$MODULE_DIR$/")
                    {
                        ex.dirs.insert(root.join(dir.trim_end_matches('/')));
                    }
                }
                ex.sources.push(p);
            }
        }
        let modules_xml = idea.join("modules.xml");
        let modules = std::fs::read_to_string(&modules_xml).unwrap_or_default();
        ex.module = modules.lines().find_map(|l| {
            let fp = attr_after(l, "filepath=\"")?;
            let file = fp.rsplit('/').next()?;
            file.strip_suffix(".iml").map(str::to_owned)
        });
        ex.sources.push(modules_xml);
        ex.fdignore = Some(root.join(".fdignore")).filter(|p| p.is_file());
        ex
    }

    /// The files [`read`](Self::read) looked at (a change there = read again).
    pub fn sources(&self) -> &[PathBuf] {
        &self.sources
    }

    /// The folder itself is excluded (its name or path), not counting its parents.
    pub fn dir_itself(&self, dir: &Path) -> bool {
        if self.dirs.contains(dir) {
            return true;
        }
        dir.file_name()
            .is_some_and(|n| self.name_matches(&n.to_string_lossy()))
    }

    /// This entry itself is out of scope: an excluded folder, or a file / folder whose name
    /// matches an exclude pattern (WebStorm's "Exclude files" patterns cover files too). Parents
    /// aren't checked: a walk never enters an excluded folder.
    pub fn entry_out(&self, path: &Path, dir: bool) -> bool {
        if dir {
            return self.dir_itself(path);
        }
        path.file_name()
            .is_some_and(|n| self.name_matches(&n.to_string_lossy()))
    }

    /// A folder (or a file's folder) is excluded, or a folder above it (below the root): the
    /// tree's tint.
    pub fn excluded(&self, path: &Path, dir: bool) -> bool {
        let start = if dir { Some(path) } else { path.parent() };
        start.is_some_and(|s| {
            s.ancestors()
                .take_while(|a| *a != self.root && a.starts_with(&self.root))
                .any(|a| self.dir_itself(a))
        })
    }

    /// Out of scope anywhere on its way down from the root: the entry ([`entry_out`]) or a
    /// folder above it.
    ///
    /// [`entry_out`]: Self::entry_out
    pub fn out_of_scope(&self, path: &Path, dir: bool) -> bool {
        self.entry_out(path, dir) || self.excluded(path, false)
    }

    fn name_matches(&self, name: &str) -> bool {
        self.patterns.iter().any(|p| glob_match(p, name))
    }

    /// The exclusions as rg override globs (`--glob=!…`, relative to the project root = rg's
    /// cwd): patterns match a name at any depth, excluded folders are anchored. Folders inside
    /// another excluded one are dropped (rg never gets there), keeping the command line short.
    /// Plus the root's `.fdignore` as an `--ignore-file` (nested ones only reach the walker).
    pub fn rg_globs(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .patterns
            .iter()
            .map(|p| format!("--glob=!{}", escape_glob(p, false)))
            .collect();
        let mut dirs: Vec<&PathBuf> = self
            .dirs
            .iter()
            .filter(|d| {
                // redundant: below another excluded folder / named like a pattern
                !d.parent().is_some_and(|p| self.excluded(p, true))
                    && !d
                        .file_name()
                        .is_some_and(|n| self.name_matches(&n.to_string_lossy()))
            })
            .collect();
        dirs.sort();
        for d in dirs {
            if let Some(rel) = d.strip_prefix(&self.root).ok().and_then(Path::to_str)
                && !rel.is_empty()
            {
                out.push(format!("--glob=!/{}/", escape_glob(rel, true)));
            }
        }
        if let Some(f) = &self.fdignore {
            out.push(format!("--ignore-file={}", f.display()));
        }
        out
    }
}

/// rg glob specials in a literal (`[`, `{`...) escaped; `*` / `?` kept as wildcards in patterns.
fn escape_glob(s: &str, literal: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let special =
            matches!(c, '[' | ']' | '{' | '}' | '\\' | '!') || (literal && matches!(c, '*' | '?'));
        if special {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The text after `prefix` up to the next `"`.
fn attr_after<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = &line[line.find(prefix)? + prefix.len()..];
    Some(&rest[..rest.find('"')?])
}

/// A walker of `root` by the scope: `scope` = the exclusions to leave out, None = Alt+I (include
/// ignored: no ignore files, no exclusions); `hidden` = dot files too. `.git` / `.DS_Store` are
/// always left out, symlinks listed but not followed.
pub fn walker(root: &Path, scope: Option<&Exclusions>, hidden: bool) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    let honour = scope.is_some();
    b.hidden(!hidden)
        .parents(honour)
        .ignore(honour)
        .git_ignore(honour)
        .git_global(honour)
        .git_exclude(honour)
        .follow_links(false);
    if honour {
        b.add_custom_ignore_filename(".fdignore");
    }
    let scope = scope.cloned().map(Arc::new);
    b.filter_entry(move |e| {
        if NEVER
            .iter()
            .chain(&NEVER_SEARCHED)
            .any(|n| e.file_name() == std::ffi::OsStr::new(n))
        {
            return false;
        }
        let Some(scope) = &scope else { return true };
        let dir = e.file_type().is_some_and(|t| t.is_dir());
        e.depth() == 0 || !scope.entry_out(e.path(), dir)
    });
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "x").unwrap();
    }

    fn project() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in [
            "src/a.ts",
            "src/dist/keep.ts",
            "dist/out.js",
            "dist/sub/x.js",
            ".turbo/cache",
            "pkg/node_modules/q.js",
            "pkg/b.min.js",
            "pkg/b.js",
            "gen/[x]/y.ts",
            "ignored.log",
        ] {
            touch(r, f);
        }
        touch(r, ".idea/web.iml");
        std::fs::write(
            r.join(".idea/web.iml"),
            "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />\n\
             <excludeFolder url=\"file://$MODULE_DIR$/dist/sub\" />\n\
             <excludeFolder url=\"file://$MODULE_DIR$/gen/[x]\" />\n\
             <excludePattern pattern=\".tur*;*.min.js\" />",
        )
        .unwrap();
        std::fs::write(r.join(".gitignore"), "*.log\n").unwrap();
        crate::git::run_blocking(r, ["init", "-q"]).unwrap();
        d
    }

    fn walk(root: &Path, scope: Option<&Exclusions>) -> Vec<String> {
        let mut v: Vec<String> = walker(root, scope, true)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.depth() > 0)
            .map(|e| e.path().strip_prefix(root).unwrap().display().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn rule_combines_ignore_files_iml_and_node_modules() {
        let d = project();
        let r = d.path();
        let ex = Exclusions::read(r);
        assert!(ex.out_of_scope(&r.join("dist"), true));
        assert!(ex.out_of_scope(&r.join("dist/sub/x.js"), false));
        assert!(ex.out_of_scope(&r.join("pkg/node_modules/q.js"), false));
        assert!(ex.out_of_scope(&r.join(".turbo"), true));
        assert!(ex.out_of_scope(&r.join("pkg/b.min.js"), false));
        assert!(!ex.out_of_scope(&r.join("pkg/b.js"), false));
        // only the top-level dist is excluded, not any folder named dist
        assert!(!ex.out_of_scope(&r.join("src/dist/keep.ts"), false));
        assert!(!ex.out_of_scope(r, true));
        assert_eq!(ex.sources().len(), 2, "{:?}", ex.sources());

        let all = walk(r, Some(&ex));
        assert_eq!(
            all,
            [
                ".gitignore",
                ".idea",
                ".idea/web.iml",
                "gen",
                "pkg",
                "pkg/b.js",
                "src",
                "src/a.ts",
                "src/dist",
                "src/dist/keep.ts",
            ]
        );
        // Alt+I: everything but .git
        let all = walk(r, None);
        for p in [
            "dist/out.js",
            ".turbo/cache",
            "pkg/node_modules/q.js",
            "pkg/b.min.js",
            "ignored.log",
            "gen/[x]/y.ts",
        ] {
            assert!(all.iter().any(|a| a == p), "{p} in {all:?}");
        }
        assert!(!all.iter().any(|a| a.starts_with(".git/") || a == ".git"));
    }

    #[test]
    fn rg_globs_match_the_rule() {
        let d = project();
        let r = d.path();
        let globs = Exclusions::read(r).rg_globs();
        assert_eq!(
            globs,
            [
                "--glob=!node_modules",
                "--glob=!.tur*",
                "--glob=!*.min.js",
                "--glob=!/dist/",
                "--glob=!/gen/\\[x\\]/",
            ]
        );
        // what rg finds with them = the walk's files
        let out = std::process::Command::new("rg")
            .args(["--files", "--hidden", "--glob=!.git"])
            .args(&globs)
            .current_dir(r)
            .output()
            .unwrap();
        let mut files: Vec<&str> = std::str::from_utf8(&out.stdout).unwrap().lines().collect();
        files.sort();
        assert_eq!(
            files,
            [
                ".gitignore",
                ".idea/web.iml",
                "pkg/b.js",
                "src/a.ts",
                "src/dist/keep.ts"
            ]
        );
        // no .idea: node_modules only
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            Exclusions::read(empty.path()).rg_globs(),
            ["--glob=!node_modules"]
        );
    }

    #[test]
    fn glob_match_takes_star_and_question_mark() {
        assert!(glob_match("*.log", "a.log"));
        assert!(!glob_match("*.log", "a.logx"));
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("*a*b*", "xxaxxbxx"));
        assert!(!glob_match("*a*b", "xxaxxbxx"));
        assert!(glob_match("*", ""));
        assert!(glob_match("node_modules", "node_modules"));
        assert!(!glob_match("node_modules", "node_module"));
        assert!(glob_match("å?", "åä"));
    }
}
