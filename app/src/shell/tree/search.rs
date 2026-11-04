//! Speed search in the tree (`/`), like the Lua tree's (`config/tree.lua`): the whole project is
//! searched (not only the open folders), gitignored files and excluded folders (node_modules,
//! `.idea` excludes) left out; results show under their folders in tree order; result folders
//! fold like the tree (folds survive more typing). Names match fuzzily (nucleo, smart case), the
//! matched chars highlighted.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use super::model::{Exclusions, Kids, RelEntry, Row};

/// One searchable file or folder.
#[derive(Clone, Debug)]
pub struct Item {
    pub path: Arc<Path>,
    pub name: String,
    pub dir: bool,
    pub link: bool,
    pub depth: usize,
    /// Index of its folder (None: the root).
    pub parent: Option<usize>,
}

/// Every searchable path of the project, in tree order (item 0 = the root).
#[derive(Clone, Debug, Default)]
pub struct Index {
    pub items: Vec<Item>,
}

/// Tree order of two paths below one root: per level folders first, then names in byte order;
/// a folder before what's inside it.
fn tree_order(a: &(PathBuf, bool), b: &(PathBuf, bool)) -> Ordering {
    let ca: Vec<Component> = a.0.components().collect();
    let cb: Vec<Component> = b.0.components().collect();
    for i in 0..ca.len().min(cb.len()) {
        if ca[i] != cb[i] {
            // a component that isn't the last is a folder
            let da = i + 1 < ca.len() || a.1;
            let db = i + 1 < cb.len() || b.1;
            return db
                .cmp(&da)
                .then_with(|| ca[i].as_os_str().cmp(cb[i].as_os_str()));
        }
    }
    ca.len().cmp(&cb.len())
}

impl Index {
    /// Walks the project by the project scope ([`crate::search`]: ignore files, excluded folders;
    /// hidden files included). Blocking: run it in the background.
    pub fn build(root: &Path, excl: &Exclusions) -> Index {
        let walk = crate::search::walker(root, Some(excl), true).build();
        let mut found: Vec<RelEntry> = Vec::new();
        for e in walk.filter_map(Result::ok) {
            if e.depth() == 0 {
                continue;
            }
            let Ok(rel) = e.path().strip_prefix(root) else {
                continue;
            };
            let ft = e.file_type();
            let link = ft.is_some_and(|t| t.is_symlink());
            let dir = ft.is_some_and(|t| t.is_dir())
                || (link && std::fs::metadata(e.path()).is_ok_and(|m| m.is_dir()));
            found.push(RelEntry {
                rel: rel.to_path_buf(),
                dir,
                link,
            });
        }
        Self::from_rel(root, found)
    }

    /// The index of relative paths (any order; folders above them may be missing).
    pub fn from_rel(root: &Path, mut found: Vec<RelEntry>) -> Index {
        // folders of every path, so results always nest (fd can list a file before its folder)
        let known: HashSet<PathBuf> = found.iter().map(|f| f.rel.clone()).collect();
        let mut extra = HashSet::new();
        for f in &found {
            for a in f.rel.ancestors().skip(1) {
                if a.as_os_str().is_empty() || known.contains(a) || !extra.insert(a.to_path_buf()) {
                    break;
                }
            }
        }
        found.extend(extra.into_iter().map(|rel| RelEntry {
            rel,
            dir: true,
            link: false,
        }));
        let mut keyed: Vec<((PathBuf, bool), bool)> = found
            .into_iter()
            .map(|f| ((f.rel, f.dir), f.link))
            .collect();
        keyed.sort_by(|a, b| tree_order(&a.0, &b.0));
        let mut items = Vec::with_capacity(keyed.len() + 1);
        items.push(Item {
            path: Arc::from(root),
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            dir: true,
            link: false,
            depth: 0,
            parent: None,
        });
        // the open folders on the way down: (depth, index)
        let mut stack: Vec<usize> = vec![0];
        for ((rel, dir), link) in keyed {
            let depth = rel.components().count();
            stack.truncate(depth);
            let parent = stack.last().copied();
            let ix = items.len();
            items.push(Item {
                path: Arc::from(root.join(&rel).as_path()),
                name: rel
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                dir,
                link,
                depth,
                parent,
            });
            if dir {
                stack.push(ix);
            }
        }
        Index { items }
    }
}

/// What a query found.
#[derive(Clone, Debug, Default)]
pub struct Results {
    /// Shown items in tree order: (item, matched char indices; None = only a folder of matches).
    pub shown: Vec<(usize, Option<Vec<u32>>)>,
    /// Matches (not counting their folders).
    pub count: usize,
}

/// Matches `query` against every item's name.
pub fn run(index: &Index, query: &str, matcher: &mut Matcher) -> Results {
    let pattern = Pattern::new(
        query,
        CaseMatching::Smart,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let n = index.items.len();
    let mut hit: Vec<Option<Vec<u32>>> = vec![None; n];
    let mut keep = vec![false; n];
    let mut buf = Vec::new();
    let mut count = 0;
    for (ix, it) in index.items.iter().enumerate().skip(1) {
        let mut indices = Vec::new();
        if pattern
            .indices(Utf32Str::new(&it.name, &mut buf), matcher, &mut indices)
            .is_some()
        {
            indices.sort_unstable();
            indices.dedup();
            hit[ix] = Some(indices);
            count += 1;
            let mut p = Some(ix);
            while let Some(i) = p {
                if keep[i] {
                    break;
                }
                keep[i] = true;
                p = index.items[i].parent;
            }
        }
    }
    keep[0] = true;
    let shown = (0..n)
        .filter(|&i| keep[i])
        .map(|i| (i, hit[i].take()))
        .collect();
    Results { shown, count }
}

/// A new matcher (reused across keystrokes).
pub fn matcher() -> Matcher {
    Matcher::new(Config::DEFAULT)
}

/// The result rows with folded folders' contents left out.
pub fn rows(
    index: &Index,
    res: &Results,
    folded: &HashSet<Arc<Path>>,
    excl: &Exclusions,
) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::with_capacity(res.shown.len());
    let mut skip: Option<&Path> = None;
    for (k, (ix, m)) in res.shown.iter().enumerate() {
        let it = &index.items[*ix];
        if let Some(s) = skip {
            if it.path.starts_with(s) && *it.path != *s {
                continue;
            }
            skip = None;
        }
        let is_folded = it.dir && folded.contains(&it.path);
        // a result folder with results inside: open unless folded
        let has_shown_kids = res
            .shown
            .get(k + 1)
            .is_some_and(|(j, _)| index.items[*j].parent == Some(*ix));
        out.push(Row {
            path: it.path.clone(),
            name: it.name.clone(),
            depth: it.depth,
            dir: it.dir,
            link: it.link,
            open: it.dir && has_shown_kids && !is_folded,
            kids: if !it.dir {
                Kids::No
            } else if has_shown_kids || it.depth == 0 {
                Kids::Yes
            } else {
                Kids::Unknown
            },
            excluded: excl.excluded(&it.path, it.dir),
            matches: m.clone(),
        });
        if is_folded {
            skip = Some(&it.path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(paths: &[&str]) -> Index {
        Index::from_rel(
            Path::new("/r"),
            paths
                .iter()
                .map(|p| RelEntry {
                    rel: PathBuf::from(p.trim_end_matches('/')),
                    dir: p.ends_with('/'),
                    link: false,
                })
                .collect(),
        )
    }

    fn rels(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| {
                r.path
                    .strip_prefix("/r")
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    #[test]
    fn tree_order_even_when_files_come_before_their_folders() {
        // fd lists in parallel: files before their folders, folders missing
        let ix = index(&[
            "theta/",
            "theta/sub/item1.ts",
            "item_root.ts",
            "alpha/sub/item2.ts",
            "alpha/",
            "theta/a.ts",
        ]);
        let names: Vec<_> = ix
            .items
            .iter()
            .map(|i| (i.depth, i.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                (0, "r"),
                (1, "alpha"),
                (2, "sub"),
                (3, "item2.ts"),
                (1, "theta"),
                (2, "sub"),
                (3, "item1.ts"),
                (2, "a.ts"),
                (1, "item_root.ts"),
            ]
        );
        assert_eq!(ix.items[3].parent, Some(2));
    }

    #[test]
    fn results_under_their_folders_with_folds() {
        let ix = index(&[
            "theta/sub/item1.ts",
            "theta/item1.ts",
            "theta/other.ts",
            "kappa/item2.ts",
            "item_root.ts",
        ]);
        let mut m = matcher();
        let res = run(&ix, "item", &mut m);
        assert_eq!(res.count, 4);
        let ex = Exclusions::default();
        let rows = rows(&ix, &res, &HashSet::new(), &ex);
        assert_eq!(
            rels(&rows),
            [
                "",
                "kappa",
                "kappa/item2.ts",
                "theta",
                "theta/sub",
                "theta/sub/item1.ts",
                "theta/item1.ts",
                "item_root.ts"
            ]
        );
        assert!(rows[1].open && rows[1].matches.is_none());
        assert_eq!(rows[2].matches.as_deref(), Some(&[0, 1, 2, 3][..]));
        // fold theta/sub, then theta
        let mut folded = HashSet::new();
        folded.insert(Arc::from(Path::new("/r/theta/sub")));
        let rows2 = super::rows(&ix, &res, &folded, &ex);
        assert!(!rels(&rows2).contains(&"theta/sub/item1.ts".to_string()));
        assert!(!rows2[4].open);
        folded.insert(Arc::from(Path::new("/r/theta")));
        let rows3 = super::rows(&ix, &res, &folded, &ex);
        assert_eq!(
            rels(&rows3),
            ["", "kappa", "kappa/item2.ts", "theta", "item_root.ts"]
        );
        // no match
        assert_eq!(run(&ix, "zz", &mut m).count, 0);
    }

    #[test]
    fn walk_leaves_out_ignored_and_excluded() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        for f in [
            "src/item.ts",
            "dist/item_built.js",
            "node_modules/pkg/item_dep.js",
            ".hidden/item_h.ts",
            "x.log",
        ] {
            let p = r.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "x").unwrap();
        }
        std::fs::write(r.join(".gitignore"), "dist\n*.log\n").unwrap();
        crate::git::run_blocking(r, ["init", "-q"]).unwrap();
        let ix = Index::build(r, &Exclusions::read(r));
        let names: Vec<_> = ix.items.iter().map(|i| i.name.as_str()).collect();
        assert!(
            names.contains(&"item.ts") && names.contains(&"item_h.ts"),
            "{names:?}"
        );
        assert!(!names.contains(&"item_built.js") && !names.contains(&"dist"));
        assert!(!names.contains(&"node_modules") && !names.contains(&"x.log"));
        assert!(!names.contains(&".git"));
    }
}
