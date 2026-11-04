//! The Branches pane's tree (pure, unit-tested): WebStorm's branches dashboard model
//! (`git4idea/ui/branch/dashboard/BranchesTreeModel.kt` `NodeDescriptorsModel.buildTreeNodes`,
//! Apache-2.0): a "HEAD (Current Branch)" row, then the Local, Remote and Tags groups (empty ones
//! left out); remote branches under their remote ("origin"); names grouped by directory
//! (`factory/1237` = folder "factory" + "1237"; WS's default `GROUPING_BY_DIRECTORY`). Each
//! level sorted by `BranchTreeNodeComparator`: the current branch, favorites, folders holding
//! favorites, folders, the rest; then by name, naturally.
//!
//! [`flatten`] turns the nodes into the rows shown, given the folded groups.

use std::cmp::Ordering;
use std::collections::HashSet;

use crate::git::branches::FilterRefs;

/// WS `group.Git.HEAD.Branch.Filter.title`.
pub const HEAD_LABEL: &str = "HEAD (Current Branch)";

/// Which kind of ref a leaf is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

/// A branch or tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefInfo {
    /// The name git knows it by (`master`, `origin/factory/1237`, `v1.0`): the log's branch
    /// filter, checkout, the speed search's text.
    pub name: String,
    pub kind: RefKind,
    /// The checked-out branch.
    pub current: bool,
    /// WS's predefined favorites (`master` / `main`, `origin/master` / `origin/main`): a star.
    pub favorite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeKind {
    /// "HEAD (Current Branch)": the log filtered to HEAD.
    Head,
    /// Local / Remote / Tags.
    Section(RefKind),
    /// A remote ("origin").
    Remote,
    /// A name prefix ("factory").
    Folder,
    Ref(RefInfo),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    /// Unique and stable across reloads (fold state, the cursor).
    pub key: String,
    pub label: String,
    pub kind: NodeKind,
    pub children: Vec<Node>,
}

impl Node {
    fn group(key: String, label: &str, kind: NodeKind, children: Vec<Node>) -> Node {
        Node {
            key,
            label: label.to_owned(),
            kind,
            children,
        }
    }

    pub fn is_group(&self) -> bool {
        matches!(
            self.kind,
            NodeKind::Section(_) | NodeKind::Remote | NodeKind::Folder
        )
    }

    fn has_favorites(&self) -> bool {
        self.children.iter().any(|c| match &c.kind {
            NodeKind::Ref(r) => r.favorite,
            NodeKind::Folder => c.has_favorites(),
            _ => false,
        })
    }

    /// BranchTreeNodeComparator's weight.
    fn weight(&self) -> u8 {
        match &self.kind {
            NodeKind::Ref(r) if r.current => 0,
            NodeKind::Ref(r) if r.favorite => 1,
            NodeKind::Folder if self.has_favorites() => 2,
            NodeKind::Folder => 3,
            _ => 4,
        }
    }
}

/// Refs with their name's path segments still to place.
type Named<'a> = Vec<(Vec<&'a str>, RefInfo)>;

/// The tree for `refs`.
pub fn build(refs: &FilterRefs) -> Vec<Node> {
    let mut out = vec![Node::group(
        "HEAD".into(),
        HEAD_LABEL,
        NodeKind::Head,
        vec![],
    )];
    let current = refs.current.as_deref();
    let info = |name: &str, kind: RefKind| RefInfo {
        name: name.to_owned(),
        kind,
        current: kind == RefKind::Local && current == Some(name),
        favorite: is_favorite(name, kind),
    };
    // Local
    let local: Named<'_> = refs
        .local
        .iter()
        .map(|n| (n.split('/').collect(), info(n, RefKind::Local)))
        .collect();
    if !local.is_empty() {
        let key = "g:Local".to_string();
        let children = by_prefix(&key, local);
        out.push(Node::group(
            key,
            "Local",
            NodeKind::Section(RefKind::Local),
            children,
        ));
    }
    // Remote: by remote, then by directory of the name on the remote
    if !refs.remote.is_empty() {
        let key = "g:Remote".to_string();
        let mut remotes: Vec<(String, Named<'_>)> = Vec::new();
        for n in &refs.remote {
            let Some((remote, rest)) = n.split_once('/') else {
                continue;
            };
            let entry = (rest.split('/').collect(), info(n, RefKind::Remote));
            match remotes.iter_mut().find(|(r, _)| r == remote) {
                Some((_, list)) => list.push(entry),
                None => remotes.push((remote.to_owned(), vec![entry])),
            }
        }
        let mut children: Vec<Node> = remotes
            .into_iter()
            .map(|(remote, list)| {
                let rkey = format!("{key}/{remote}");
                let kids = by_prefix(&rkey, list);
                Node::group(rkey, &remote, NodeKind::Remote, kids)
            })
            .collect();
        sort(&mut children);
        out.push(Node::group(
            key,
            "Remote",
            NodeKind::Section(RefKind::Remote),
            children,
        ));
    }
    // Tags
    let tags: Named<'_> = refs
        .tags
        .iter()
        .map(|n| (n.split('/').collect(), info(n, RefKind::Tag)))
        .collect();
    if !tags.is_empty() {
        let key = "g:Tags".to_string();
        let children = by_prefix(&key, tags);
        out.push(Node::group(
            key,
            "Tags",
            NodeKind::Section(RefKind::Tag),
            children,
        ));
    }
    out
}

/// WS `DvcsBranchManager`'s predefined favorites.
fn is_favorite(name: &str, kind: RefKind) -> bool {
    match kind {
        RefKind::Local => matches!(name, "master" | "main"),
        RefKind::Remote => matches!(name, "origin/master" | "origin/main"),
        RefKind::Tag => false,
    }
}

/// `groupByPrefix`: refs by their remaining path segments, folders for shared prefixes.
fn by_prefix(parent: &str, refs: Named<'_>) -> Vec<Node> {
    let mut nodes = Vec::new();
    let mut folders: Vec<(String, Named<'_>)> = Vec::new();
    for (segs, r) in refs {
        match segs.split_first() {
            Some((leaf, [])) => nodes.push(Node {
                key: format!("r:{}:{}", kind_tag(r.kind), r.name),
                label: (*leaf).to_owned(),
                kind: NodeKind::Ref(r),
                children: vec![],
            }),
            Some((head, rest)) => {
                let rest = rest.to_vec();
                match folders.iter_mut().find(|(f, _)| f == head) {
                    Some((_, list)) => list.push((rest, r)),
                    None => folders.push(((*head).to_owned(), vec![(rest, r)])),
                }
            }
            None => {}
        }
    }
    for (name, list) in folders {
        let key = format!("{parent}/{name}");
        let children = by_prefix(&key, list);
        nodes.push(Node::group(key, &name, NodeKind::Folder, children));
    }
    sort(&mut nodes);
    nodes
}

fn kind_tag(k: RefKind) -> &'static str {
    match k {
        RefKind::Local => "l",
        RefKind::Remote => "r",
        RefKind::Tag => "t",
    }
}

fn sort(nodes: &mut [Node]) {
    nodes.sort_by(|a, b| {
        a.weight()
            .cmp(&b.weight())
            .then_with(|| natural_cmp(&a.label, &b.label))
    });
}

/// IntelliJ's `NaturalComparator` (`GitReference.REFS_NAMES_COMPARATOR`): digit runs by value,
/// letters ignoring case, then case as the tie-break.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let n = digits(&mut x);
                let m = digits(&mut y);
                let (nt, mt) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let ord = nt.len().cmp(&mt.len()).then_with(|| nt.cmp(mt));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

fn digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
        s.push(c);
        it.next();
    }
    s
}

/// A shown row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub key: String,
    pub label: String,
    pub kind: NodeKind,
    pub depth: usize,
    pub has_children: bool,
    pub open: bool,
    /// The parent group's row.
    pub parent: Option<usize>,
}

impl Row {
    pub fn is_group(&self) -> bool {
        self.has_children
    }

    pub fn ref_info(&self) -> Option<&RefInfo> {
        match &self.kind {
            NodeKind::Ref(r) => Some(r),
            _ => None,
        }
    }

    /// What the speed search matches: a ref's whole name (WS `getText`), else the label.
    pub fn search_text(&self) -> &str {
        self.ref_info().map_or(&self.label, |r| &r.name)
    }
}

/// The rows shown: every node whose ancestors are all open (groups in `closed` are folded).
pub fn flatten(nodes: &[Node], closed: &HashSet<String>) -> Vec<Row> {
    fn walk(
        nodes: &[Node],
        closed: &HashSet<String>,
        depth: usize,
        parent: Option<usize>,
        out: &mut Vec<Row>,
    ) {
        for n in nodes {
            let has_children = n.is_group() && !n.children.is_empty();
            let open = has_children && !closed.contains(&n.key);
            let ix = out.len();
            out.push(Row {
                key: n.key.clone(),
                label: n.label.clone(),
                kind: n.kind.clone(),
                depth,
                has_children,
                open,
                parent,
            });
            if open {
                walk(&n.children, closed, depth + 1, Some(ix), out);
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, closed, 0, None, &mut out);
    out
}

/// Every group's key (Collapse All).
pub fn group_keys(nodes: &[Node]) -> Vec<String> {
    let mut out = Vec::new();
    for n in nodes {
        if n.is_group() {
            out.push(n.key.clone());
            out.extend(group_keys(&n.children));
        }
    }
    out
}

/// The keys of `key`'s ancestors, outermost first (empty: top level or not found).
pub fn ancestors(nodes: &[Node], key: &str) -> Vec<String> {
    fn find(nodes: &[Node], key: &str, path: &mut Vec<String>) -> bool {
        for n in nodes {
            if n.key == key {
                return true;
            }
            path.push(n.key.clone());
            if find(&n.children, key, path) {
                return true;
            }
            path.pop();
        }
        false
    }
    let mut path = Vec::new();
    if find(nodes, key, &mut path) {
        path
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grepo() -> FilterRefs {
        FilterRefs {
            local: vec!["factory/1237".into(), "master".into()],
            remote: vec!["origin/factory/1237".into(), "origin/master".into()],
            tags: vec!["v1.0".into(), "backup/old-1".into()],
            current: Some("master".into()),
        }
    }

    fn shown(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| format!("{}{}", "  ".repeat(r.depth), r.label))
            .collect()
    }

    #[test]
    fn grouped_like_the_ws_branches_dashboard() {
        let nodes = build(&grepo());
        let rows = flatten(&nodes, &HashSet::new());
        assert_eq!(
            shown(&rows),
            [
                "HEAD (Current Branch)",
                "Local",
                "  master",
                "  factory",
                "    1237",
                "Remote",
                "  origin",
                "    master",
                "    factory",
                "      1237",
                "Tags",
                "  backup",
                "    old-1",
                "  v1.0",
            ]
        );
        let master = rows[2].ref_info().unwrap();
        assert!(master.current && master.favorite);
        let remote = rows[9].ref_info().unwrap();
        assert_eq!(remote.name, "origin/factory/1237");
        assert_eq!(remote.kind, RefKind::Remote);
        assert!(!remote.current);
        assert_eq!(rows[9].search_text(), "origin/factory/1237");
        assert_eq!(rows[4].parent, Some(3));
        assert_eq!(rows[3].parent, Some(1));
    }

    #[test]
    fn folding_hides_children_and_empty_groups_are_left_out() {
        let refs = FilterRefs {
            local: vec!["a/x".into(), "b".into()],
            ..Default::default()
        };
        let nodes = build(&refs);
        let closed: HashSet<String> = ["g:Local/a".to_string()].into();
        let rows = flatten(&nodes, &closed);
        assert_eq!(
            shown(&rows),
            ["HEAD (Current Branch)", "Local", "  a", "  b"]
        );
        assert!(rows[2].has_children && !rows[2].open);
        assert_eq!(group_keys(&nodes), ["g:Local", "g:Local/a"]);
        assert_eq!(ancestors(&nodes, "r:l:a/x"), ["g:Local", "g:Local/a"]);
        assert!(ancestors(&nodes, "g:Local").is_empty());
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["v10", "V2", "v1", "alpha", "Beta"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["alpha", "Beta", "v1", "V2", "v10"]);
    }
}
