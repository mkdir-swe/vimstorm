//! The Project tree's folders: what's listed, what's expanded, excluded folders, and the rows
//! that makes (pure apart from reading directories; unit-tested on temp dirs).
//!
//! Rules from [`crate::search`] (the Lua tree's snacks explorer options `hidden = true, ignored =
//! true, exclude = { ".git", ".DS_Store" }`): everything is shown but `.git` and `.DS_Store`;
//! folders first, then names in byte order (snacks' `Tree:walk` sort); excluded
//! folders = `node_modules` (a "library root") + the project's `.idea/*.iml` `excludePattern` /
//! `excludeFolder` entries ([`crate::search`]: shown here, tinted; left out of every search).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The excluded folders live with the project scope (one rule for the tree and every search).
pub use crate::search::Exclusions;
/// Names never shown (snacks `exclude`).
pub use crate::search::NEVER as HIDDEN_NAMES;

/// One directory entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub link: bool,
}

/// An entry below a root, by its path relative to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelEntry {
    pub rel: PathBuf,
    pub dir: bool,
    pub link: bool,
}

/// Lists a directory the tree's way (hidden names left out, sorted). Unreadable: empty. A cloud
/// workspace's folder is listed on its box ([`crate::shell::remote`]).
pub fn list_dir(dir: &Path) -> Vec<Entry> {
    if let Some(exec) = crate::shell::remote::exec_for(dir) {
        return remote_list(&exec, dir).unwrap_or_default();
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Entry> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if HIDDEN_NAMES.contains(&name.as_str()) {
                return None;
            }
            let ft = e.file_type().ok()?;
            let link = ft.is_symlink();
            // a link to a folder is a folder (snacks: `.scratch` -> folder with an arrow)
            let dir =
                ft.is_dir() || (link && std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir()));
            Some(Entry { name, dir, link })
        })
        .collect();
    sort_entries(&mut out);
    out
}

/// `dir` listed through a cloud workspace's exec prefix; None: no folder there.
fn remote_list(exec: &[String], dir: &Path) -> Option<Vec<Entry>> {
    crate::shell::remote::list_dir(exec, dir).map(entries_of)
}

/// A box's listing the tree's way (hidden names left out, sorted).
fn entries_of(listed: Vec<crate::shell::remote::Listed>) -> Vec<Entry> {
    let mut out: Vec<Entry> = listed
        .into_iter()
        .filter(|l| !HIDDEN_NAMES.contains(&l.name.as_str()))
        .map(|l| Entry {
            name: l.name,
            dir: l.dir,
            link: l.link,
        })
        .collect();
    sort_entries(&mut out);
    out
}

/// A cloud workspace's folders from `dir` down, breadth first, at most `limit`, in one call to
/// its box; None when it isn't one or the box can't say. Blocking.
pub fn walk_remote(dir: &Path, limit: usize) -> Option<Vec<(PathBuf, Vec<Entry>)>> {
    let exec = crate::shell::remote::exec_for(dir)?;
    let listings = crate::shell::remote::list_dirs(
        &exec,
        &[dir.to_path_buf()],
        crate::shell::remote::Reach::Walk,
        limit,
    )?;
    Some(
        listings
            .into_iter()
            .filter_map(|(d, v)| Some((d, entries_of(v?))))
            .collect(),
    )
}

/// Folders first, then names in byte order.
pub fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
}

/// Has each folder anything the tree would show? A cloud workspace's in one call.
pub fn has_children_all(dirs: Vec<Arc<Path>>) -> Vec<(Arc<Path>, bool)> {
    let (remote, local): (Vec<_>, Vec<_>) = dirs
        .into_iter()
        .partition(|d| crate::shell::remote::exec_for(d).is_some());
    let mut out: Vec<_> = local
        .into_iter()
        .map(|d| {
            let k = has_children(&d);
            (d, k)
        })
        .collect();
    let paths: Vec<PathBuf> = remote.iter().map(|d| d.to_path_buf()).collect();
    let listed: HashMap<PathBuf, bool> = relist(paths)
        .into_iter()
        .map(|(d, v)| (d, v.is_some_and(|v| !v.is_empty())))
        .collect();
    out.extend(remote.into_iter().map(|d| {
        // no answer from the box: drawn with a chevron, as before it was asked
        let k = listed.get(d.as_ref()).copied().unwrap_or(true);
        (d, k)
    }));
    out
}

/// Has the folder anything the tree would show?
pub fn has_children(dir: &Path) -> bool {
    if let Some(exec) = crate::shell::remote::exec_for(dir) {
        return remote_list(&exec, dir).is_some_and(|v| !v.is_empty());
    }
    std::fs::read_dir(dir).is_ok_and(|mut rd| {
        rd.any(|e| {
            e.is_ok_and(|e| !HIDDEN_NAMES.contains(&e.file_name().to_string_lossy().as_ref()))
        })
    })
}

/// Lists every folder under `dir` (itself included) Expand All would open: folders first,
/// leaving out excluded ones, symlinks and `skip` (gitignored), at most `limit`. A cloud
/// workspace's in one call to its box. Blocking.
pub fn list_below(
    dir: &Path,
    excl: &Exclusions,
    skip: &dyn Fn(&Path) -> bool,
    limit: usize,
) -> Vec<(PathBuf, Vec<Entry>)> {
    if crate::shell::remote::exec_for(dir).is_some() {
        let walked: HashMap<PathBuf, Vec<Entry>> = walk_remote(dir, limit)
            .unwrap_or_default()
            .into_iter()
            .collect();
        // the walk went into every folder: keep those Expand All would have reached
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Some(entries) = walked.get(&d) else {
                continue;
            };
            for e in entries.iter().rev() {
                let p = d.join(&e.name);
                if e.dir && !e.link && !excl.dir_itself(&p) && !skip(&p) {
                    stack.push(p);
                }
            }
            out.push((d, entries.clone()));
        }
        return out;
    }
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let entries = list_dir(&d);
        for e in entries.iter().rev() {
            let p = d.join(&e.name);
            if e.dir && !e.link && !excl.dir_itself(&p) && !skip(&p) {
                stack.push(p);
            }
        }
        out.push((d, entries));
    }
    out
}

/// Lists folders again (None: gone). A cloud workspace's in one call to its box; none of
/// them when the box can't say. Blocking.
pub fn relist(dirs: Vec<PathBuf>) -> Vec<(PathBuf, Option<Vec<Entry>>)> {
    let mut out = Vec::new();
    let mut remote: Vec<(Vec<String>, Vec<PathBuf>)> = Vec::new();
    for d in dirs {
        match crate::shell::remote::exec_for(&d) {
            Some(exec) => match remote.iter_mut().find(|(e, _)| *e == exec) {
                Some((_, ds)) => ds.push(d),
                None => remote.push((exec, vec![d])),
            },
            None => {
                let v = d.is_dir().then(|| list_dir(&d));
                out.push((d, v));
            }
        }
    }
    for (exec, ds) in remote {
        let n = ds.len();
        let listings =
            crate::shell::remote::list_dirs(&exec, &ds, crate::shell::remote::Reach::Only, n)
                .unwrap_or_default();
        out.extend(listings.into_iter().map(|(d, v)| (d, v.map(entries_of))));
    }
    out
}

/// Does the row's folder have rows under it (a chevron)?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kids {
    Yes,
    No,
    /// Not listed yet: ask the file system ([`has_children`]) when drawn.
    Unknown,
}

/// One row of the tree (or of the search results).
#[derive(Clone, Debug)]
pub struct Row {
    pub path: Arc<Path>,
    pub name: String,
    /// 0 = the project root.
    pub depth: usize,
    pub dir: bool,
    pub link: bool,
    /// Chevron down (an open folder; in the results: not folded).
    pub open: bool,
    pub kids: Kids,
    /// Excluded folder or inside one (tinted row, orange folder icon).
    pub excluded: bool,
    /// Search: the name's matched chars; None = no search or only a folder of matches.
    pub matches: Option<Vec<u32>>,
}

impl Row {
    pub fn is_root(&self) -> bool {
        self.depth == 0
    }
}

/// Listed folders + which are open.
pub struct FsTree {
    pub root: PathBuf,
    listed: HashMap<PathBuf, Vec<Entry>>,
    /// A cloud workspace's closed folders [`FsTree::dirs_to_relist`] forgot: still searched by
    /// the speed search until listed again.
    forgotten: HashMap<PathBuf, Vec<Entry>>,
    open: HashSet<PathBuf>,
    /// Bumped whenever the open folders change (who keeps a copy can tell cheaply).
    pub generation: u64,
    pub excl: Exclusions,
    /// A cloud workspace's folders opened but not listed yet: their listing is a round trip to
    /// the box, which the view runs in the background ([`FsTree::take_unlisted`]).
    unlisted: Vec<PathBuf>,
    /// A cloud workspace's tree: a listed folder says whether it has rows even while closed (its
    /// listing came with the first walk), so no folder is asked on its own.
    remote: bool,
    /// The Feel's `tree.compactFolders` (VS Code): a chain of folders with one folder in each
    /// and no files is one row `a/b/c` ([`FsTree::list_chains`] lists what that needs).
    pub compact: bool,
    /// A folder of the root shown first, before the others: the repo's `abe/` in its main
    /// checkout (ADR 0033).
    pub first: Option<PathBuf>,
}

impl FsTree {
    /// The tree of `root`, the root open.
    pub fn new(root: &Path) -> FsTree {
        let mut t = FsTree {
            root: root.to_path_buf(),
            listed: HashMap::new(),
            forgotten: HashMap::new(),
            open: HashSet::new(),
            generation: 0,
            excl: Exclusions::read(root),
            unlisted: Vec::new(),
            remote: crate::shell::remote::exec_for(root).is_some(),
            compact: false,
            first: None,
        };
        t.open(root);
        t
    }

    /// Opens a folder (lists it the first time).
    pub fn open(&mut self, dir: &Path) {
        if !self.listed.contains_key(dir) {
            // a cloud workspace's: never on the UI thread (the view lists it in the background)
            let listing = if crate::shell::remote::exec_for(dir).is_some() {
                self.unlisted.push(dir.to_path_buf());
                Vec::new()
            } else {
                list_dir(dir)
            };
            self.listed.insert(dir.to_path_buf(), listing);
        }
        if self.open.insert(dir.to_path_buf()) {
            self.generation += 1;
        }
    }

    pub fn close(&mut self, dir: &Path) {
        if self.open.remove(dir) {
            self.generation += 1;
        }
    }

    /// Opens the folders down to `path` (not `path` itself). False when it isn't in the project.
    pub fn reveal(&mut self, path: &Path) -> bool {
        if !path.starts_with(&self.root) {
            return false;
        }
        let mut chain: Vec<PathBuf> = path
            .ancestors()
            .skip(1)
            .take_while(|a| a.starts_with(&self.root))
            .map(Path::to_path_buf)
            .collect();
        chain.reverse();
        for d in chain {
            self.open(&d);
        }
        true
    }

    /// Compact folders: lists the open folders' child folders (and down their one-folder chains)
    /// not listed yet, so [`FsTree::rows`] can tell a chain. A cloud workspace's are never listed
    /// here (a round trip each): its chains are what its walk listed. No-op unless `compact`.
    pub fn list_chains(&mut self) {
        if !self.compact || self.remote {
            return;
        }
        let mut todo: Vec<PathBuf> = Vec::new();
        // an excluded folder's (node_modules) children are never chain-listed: hundreds of
        // readdirs on the UI thread, each one then polled
        for d in self.open.iter().filter(|d| !self.excl.excluded(d, true)) {
            for e in self.listed.get(d).into_iter().flatten() {
                if e.dir && !e.link {
                    todo.push(d.join(&e.name));
                }
            }
        }
        while let Some(d) = todo.pop() {
            if self.excl.dir_itself(&d) {
                continue;
            }
            if !self.listed.contains_key(&d) {
                let listing = list_dir(&d);
                self.listed.insert(d.clone(), listing);
            }
            let listing = &self.listed[&d];
            if let [only] = listing.as_slice()
                && only.dir
                && !only.link
            {
                todo.push(d.join(&only.name));
            }
        }
    }

    /// Where a compacted row ends: `dir` and, while a folder holds exactly one folder and no
    /// files (listed, not excluded, not a link), that one; its name `a/b/c`.
    fn chain_end(&self, dir: PathBuf, name: &str) -> (PathBuf, String) {
        let mut end = dir;
        let mut label = name.to_owned();
        while self.compact && !self.excl.dir_itself(&end) {
            let Some([only]) = self.listed.get(&end).map(Vec::as_slice) else {
                break;
            };
            let next = end.join(&only.name);
            if !only.dir || only.link || self.excl.dir_itself(&next) {
                break;
            }
            label = format!("{label}/{}", only.name);
            end = next;
        }
        (end, label)
    }

    /// A cloud workspace's folders opened unlisted since the last ask.
    pub fn take_unlisted(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.unlisted)
    }

    /// A cloud workspace's folders to list again (the box did not answer), if still listed.
    pub fn unlisted_again(&mut self, dirs: Vec<PathBuf>) {
        self.unlisted
            .extend(dirs.into_iter().filter(|d| self.listed.contains_key(d)));
    }

    /// Folders listed elsewhere, opened or not (a cloud workspace's first walk).
    pub fn add_listed(&mut self, listings: Vec<(PathBuf, Vec<Entry>)>) {
        for (d, _) in &listings {
            self.forgotten.remove(d);
        }
        self.listed.extend(listings);
    }

    /// Every folder closed but the root (Collapse All).
    pub fn collapse_all(&mut self) {
        let root = self.root.clone();
        self.open.retain(|d| *d == root);
        self.generation += 1;
    }

    /// Opens every folder under `dir` (Expand All), leaving out excluded ones and `skip`
    /// (gitignored), at most `limit` folders.
    pub fn expand_all(&mut self, dir: &Path, skip: &dyn Fn(&Path) -> bool, limit: usize) {
        let listings = list_below(dir, &self.excl, skip, limit);
        self.open_listed(listings);
    }

    /// Opens folders listed elsewhere ([`list_below`] in the background).
    pub fn open_listed(&mut self, listings: Vec<(PathBuf, Vec<Entry>)>) {
        for (d, entries) in listings {
            self.listed.insert(d.clone(), entries);
            self.open(&d);
        }
    }

    /// Lists a folder again if it was listed (the file watcher / a file action changed it).
    pub fn refresh(&mut self, dir: &Path) {
        if let Some(v) = self.listed.get_mut(dir) {
            *v = list_dir(dir);
        }
    }

    /// Lists every listed folder again; forgets folders that are gone.
    pub fn refresh_all(&mut self) {
        let listings = relist(self.listed_dirs());
        self.apply_relist(listings);
        self.excl = Exclusions::read(&self.root);
    }

    /// New listings of listed folders ([`relist`] in the background); None = the folder is gone.
    pub fn apply_relist(&mut self, listings: Vec<(PathBuf, Option<Vec<Entry>>)>) {
        for (d, entries) in listings {
            match entries {
                Some(v) => {
                    if let Some(old) = self.listed.get_mut(&d) {
                        *old = v;
                    }
                }
                None if d != self.root => {
                    self.listed.remove(&d);
                    self.forgotten.remove(&d);
                    if self.open.remove(&d) {
                        self.generation += 1;
                    }
                }
                None => {}
            }
        }
    }

    /// The folders a file job lists again. A cloud workspace's: only the open ones; the closed
    /// ones its walk listed are forgotten (asked again, in one call, as they are drawn), so a
    /// rename does not bring the whole walk back from the box.
    pub fn dirs_to_relist(&mut self) -> Vec<PathBuf> {
        if self.remote {
            let closed: Vec<PathBuf> = self
                .listed
                .keys()
                .filter(|d| !self.open.contains(*d))
                .cloned()
                .collect();
            for d in closed {
                if let Some(v) = self.listed.remove(&d) {
                    self.forgotten.insert(d, v);
                }
            }
        }
        self.listed_dirs()
    }

    /// A cloud workspace's tree (its folders listed on the box).
    pub fn is_remote(&self) -> bool {
        self.remote
    }

    /// What a cloud workspace's speed search runs over: every listing its walk and the
    /// folders opened since gave, so the box is not asked again. A copy: matched off the UI thread.
    pub fn listings(&self) -> Listings {
        let mut dirs = self.forgotten.clone();
        // (a folder opened but not listed yet keeps what it had)
        dirs.extend(
            self.listed
                .iter()
                .filter(|(d, _)| !self.unlisted.contains(d))
                .map(|(d, v)| (d.clone(), v.clone())),
        );
        Listings {
            root: self.root.clone(),
            excl: self.excl.clone(),
            dirs,
        }
    }

    /// Folders listed (the file watcher's list).
    pub fn listed_dirs(&self) -> Vec<PathBuf> {
        self.listed.keys().cloned().collect()
    }

    /// Open folders below the root, relative to it (the session's `tree_dirs`).
    pub fn open_rel(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .open
            .iter()
            .filter(|d| **d != self.root)
            .filter_map(|d| d.strip_prefix(&self.root).ok())
            .map(|r| r.to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// The rows: the root, then every open folder's entries, depth first.
    pub fn rows(&self) -> Vec<Row> {
        let mut out = Vec::new();
        let name = self
            .root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.to_string_lossy().into_owned());
        let open = self.open.contains(&self.root);
        out.push(Row {
            path: Arc::from(self.root.as_path()),
            name,
            depth: 0,
            dir: true,
            link: false,
            open,
            kids: Kids::Yes,
            excluded: false,
            matches: None,
        });
        if open {
            self.push_children(&self.root, 1, false, &mut out);
        }
        out
    }

    fn push_children(&self, dir: &Path, depth: usize, excluded: bool, out: &mut Vec<Row>) {
        let Some(entries) = self.listed.get(dir) else {
            return;
        };
        // the root's `first` folder before the others (the rest keep their order)
        let first = self
            .first
            .as_deref()
            .filter(|f| f.parent() == Some(dir))
            .and_then(|f| f.file_name());
        let ordered = entries
            .iter()
            .filter(|e| first.is_some_and(|n| e.dir && *n == *e.name))
            .chain(
                entries
                    .iter()
                    .filter(|e| !first.is_some_and(|n| e.dir && *n == *e.name)),
            );
        for e in ordered {
            let (path, name) = if e.dir && !e.link {
                self.chain_end(dir.join(&e.name), &e.name)
            } else {
                (dir.join(&e.name), e.name.clone())
            };
            let ex = excluded || (e.dir && self.excl.dir_itself(&path));
            let open = e.dir && self.open.contains(&path);
            let known = open || self.remote;
            let kids = match (e.dir, known.then(|| self.listed.get(&path)).flatten()) {
                (false, _) => Kids::No,
                (true, Some(v)) => {
                    if v.is_empty() {
                        Kids::No
                    } else {
                        Kids::Yes
                    }
                }
                (true, None) => Kids::Unknown,
            };
            out.push(Row {
                path: Arc::from(path.as_path()),
                name,
                depth,
                dir: e.dir,
                link: e.link,
                open,
                kids,
                excluded: ex,
                matches: None,
            });
            if open {
                self.push_children(&path, depth + 1, ex, out);
            }
        }
    }
}

/// A tree's listings ([`FsTree::listings`]).
pub struct Listings {
    root: PathBuf,
    excl: Exclusions,
    dirs: HashMap<PathBuf, Vec<Entry>>,
}

impl Listings {
    /// Every listed entry below the root, relative, with (folder, link), by the project scope:
    /// excluded entries, `skip`ped (gitignored) ones and what is in them left out, links not
    /// entered.
    pub fn entries(&self, skip: &dyn Fn(&Path) -> bool) -> Vec<RelEntry> {
        let mut out = Vec::new();
        let mut queue = std::collections::VecDeque::from([self.root.clone()]);
        while let Some(dir) = queue.pop_front() {
            for e in self.dirs.get(&dir).into_iter().flatten() {
                let path = dir.join(&e.name);
                if self.excl.entry_out(&path, e.dir) || skip(&path) {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(&self.root) else {
                    continue;
                };
                out.push(RelEntry {
                    rel: rel.to_path_buf(),
                    dir: e.dir,
                    link: e.link,
                });
                if e.dir && !e.link {
                    queue.push_back(path);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloud_trees_search_keeps_the_walks_closed_folders_after_a_relist() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        for f in ["src/deep/basket.ts", "src/cart.ts", "node_modules/p/i.js"] {
            std::fs::create_dir_all(r.join(f).parent().unwrap()).unwrap();
            std::fs::write(r.join(f), "x").unwrap();
        }
        // "on a box": listed through an empty exec prefix (the listing script run here)
        let attach = Arc::new(crate::shell::remote::Attach {
            nvim: vec![],
            shell: vec![],
            exec: vec![],
            box_: crate::shell::remote::BoxInfo {
                name: "b".into(),
                region: None,
            },
            waking: false,
            download: None,
        });
        crate::shell::remote::register(&r, attach);
        let mut t = FsTree::new(&r);
        assert!(t.is_remote());
        t.take_unlisted();
        t.add_listed(walk_remote(&r, 100).unwrap());
        let found = |t: &FsTree| {
            let mut v: Vec<String> = t
                .listings()
                .entries(&|_| false)
                .into_iter()
                .map(|e| e.rel.display().to_string())
                .collect();
            v.sort();
            v
        };
        let all = ["src", "src/cart.ts", "src/deep", "src/deep/basket.ts"];
        assert_eq!(found(&t), all);
        // a file job relists the open folders only: the closed ones are still searched
        let dirs = t.dirs_to_relist();
        assert_eq!(dirs, std::slice::from_ref(&r));
        assert_eq!(found(&t), all);
        // gitignored ones left out with what is in them
        let deep = r.join("src/deep");
        let v = t.listings().entries(&|p| p == deep);
        assert_eq!(v.len(), 2);
        crate::shell::remote::unregister(&r);
    }

    #[test]
    fn the_repos_abe_folder_comes_first_the_rest_in_their_order() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        for f in [
            "api/x.ts",
            "abe/workflows/feature.yaml",
            ".claude/skills/a/SKILL.md",
            "README.md",
        ] {
            std::fs::create_dir_all(r.join(f).parent().unwrap()).unwrap();
            std::fs::write(r.join(f), "x").unwrap();
        }
        let mut t = FsTree::new(&r);
        let names = |t: &FsTree| -> Vec<String> {
            t.rows().iter().skip(1).map(|r| r.name.clone()).collect()
        };
        assert_eq!(names(&t), [".claude", "abe", "api", "README.md"]);
        t.first = Some(r.join("abe"));
        assert_eq!(names(&t), ["abe", ".claude", "api", "README.md"]);
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        if rel.ends_with('/') {
            std::fs::create_dir_all(&p).unwrap();
        } else {
            std::fs::write(&p, "x").unwrap();
        }
    }

    fn names(rows: &[Row], root: &Path) -> Vec<String> {
        rows.iter()
            .map(|r| {
                let rel = r.path.strip_prefix(root).unwrap().to_string_lossy();
                format!(
                    "{}{}",
                    "  ".repeat(r.depth),
                    if rel.is_empty() { "/" } else { &rel }
                )
            })
            .collect()
    }

    #[test]
    fn reveal_opens_the_folders_above_close_keeps_the_ones_inside_open() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in ["a/b/c.ts", "a/x.ts", "z.ts"] {
            touch(r, f);
        }
        let mut t = FsTree::new(r);
        assert!(t.reveal(&r.join("a/b/c.ts")));
        assert_eq!(
            names(&t.rows(), r),
            [
                "/",
                "  a",
                "    a/b",
                "      a/b/c.ts",
                "    a/x.ts",
                "  z.ts"
            ]
        );
        assert_eq!(t.open_rel(), ["a", "a/b"]);
        t.close(&r.join("a"));
        assert_eq!(names(&t.rows(), r), ["/", "  a", "  z.ts"]);
        let a = &t.rows()[1];
        assert_eq!(a.kids, Kids::Unknown);
        t.open(&r.join("a"));
        // b stayed open inside
        assert_eq!(t.rows().len(), 6);
        t.collapse_all();
        assert_eq!(t.rows().len(), 3);
        t.expand_all(r, &|_| false, 100);
        assert_eq!(t.rows().len(), 6);
        assert!(!t.reveal(Path::new("/elsewhere/x")));
    }

    #[test]
    fn a_refresh_sees_new_and_removed_files() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        touch(r, "a/x.ts");
        let mut t = FsTree::new(r);
        t.open(&r.join("a"));
        touch(r, "a/y.ts");
        assert_eq!(t.rows().len(), 3);
        t.refresh(&r.join("a"));
        assert_eq!(t.rows().len(), 4);
        std::fs::remove_dir_all(r.join("a")).unwrap();
        t.refresh_all();
        assert_eq!(names(&t.rows(), r), ["/"]);
    }

    #[test]
    fn compact_folders_never_list_inside_an_excluded_folder() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in [
            "node_modules/a/x.js",
            "node_modules/b/c/y.js",
            "src/deep/z.ts",
        ] {
            touch(r, f);
        }
        let mut t = FsTree::new(r);
        t.open(&r.join("node_modules"));
        t.open(&r.join("node_modules/b"));
        t.compact = true;
        t.list_chains();
        assert!(t.listed.contains_key(&r.join("src/deep")));
        for dir in ["node_modules/a", "node_modules/b/c"] {
            assert!(!t.listed.contains_key(&r.join(dir)), "{dir} listed");
        }
    }

    #[test]
    fn node_modules_and_the_iml_s_folders_and_patterns_are_excluded() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in [
            "node_modules/lib/i.js",
            ".turbo/x",
            "dist/a.js",
            "src/a.ts",
            "pkg/node_modules/q.js",
        ] {
            touch(r, f);
        }
        std::fs::create_dir_all(r.join(".idea")).unwrap();
        std::fs::write(
            r.join(".idea/proj.iml"),
            "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />\n<excludePattern pattern=\".tur*\" />",
        )
        .unwrap();
        std::fs::write(
            r.join(".idea/modules.xml"),
            "<module fileurl=\"file://$PROJECT_DIR$/.idea/web.iml\" filepath=\"$PROJECT_DIR$/.idea/web.iml\" />",
        )
        .unwrap();
        let ex = Exclusions::read(r);
        assert_eq!(ex.module.as_deref(), Some("web"));
        assert!(ex.excluded(&r.join("node_modules"), true));
        assert!(ex.excluded(&r.join("node_modules/lib/i.js"), false));
        assert!(ex.excluded(&r.join("pkg/node_modules/q.js"), false));
        assert!(ex.excluded(&r.join("dist"), true));
        assert!(ex.excluded(&r.join(".turbo/x"), false));
        assert!(!ex.excluded(&r.join("src/a.ts"), false));
        assert!(!ex.excluded(r, true));
        let mut t = FsTree::new(r);
        t.open(&r.join("node_modules"));
        let rows = t.rows();
        let lib = rows.iter().find(|r| r.name == "lib").unwrap();
        assert!(lib.excluded);
        let src = rows.iter().find(|r| r.name == "src").unwrap();
        assert!(!src.excluded);
    }
}
