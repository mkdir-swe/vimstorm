//! The Log's commit graph, laid out like WebStorm's (IntelliJ's vcs-log graph): per row the
//! commit node's position, the half-edges that leave the row up / down (to the position of the
//! same line in the next row), long edges cut short with arrows, and a branch color per element.
//!
//! Ported from IntelliJ IDEA Community Edition (Apache License 2.0, Copyright 2000-2024 JetBrains
//! s.r.o. and contributors; see app/NOTICE), `platform/vcs-log/graph`:
//! - `impl/permanent/GraphLayoutBuilder.kt`: layout indexes (a DFS from the heads, sorted by
//!   `HeadCommitsComparator` + git4idea `GitRefManager.GitBranchLayoutComparator`),
//! - `impl/print/GraphElementComparatorByLayoutIndex.java`: the order of a row's elements,
//! - `impl/print/PrintElementGeneratorImpl.kt`: visible elements, positions, arrows,
//! - `impl/print/GraphColorGetterByHead.kt` + vcs-log `GraphColorManagerImpl.kt` +
//!   `PrintElementPresentationManagerImpl.kt`: color ids (head ref name hash / fragment index),
//! - vcs-log `paint/DefaultColorGenerator.kt` (id -> color, see [`color_rgb`]).
//!
//! Simplifications: no collapsing / filtered "dotted" edges (IntelliJ draws those from its full
//! graph index). A parent that isn't listed gets a short down edge ending in an arrow (IntelliJ's
//! NOT_LOAD_COMMIT edge) while the list may still grow (`dangling`), else no edge.

use std::cmp::Ordering;
use std::collections::HashMap;

use super::log::{Commit, HeadRef};

/// Layout options (WS's log "Show Long Edges", off by default).
#[derive(Clone, Debug)]
pub struct GraphOptions {
    /// Long edges drawn whole (with arrows near their ends), not cut after one row.
    pub show_long_edges: bool,
    /// Parents that aren't listed get a short edge with an arrow (the list is a prefix of
    /// history: paged / limited). Off when filters hide commits (text / user / date).
    pub dangling: bool,
}

impl Default for GraphOptions {
    fn default() -> Self {
        GraphOptions {
            show_long_edges: false,
            dangling: true,
        }
    }
}

// PrintElementGeneratorImpl's constants
const LONG_EDGE_SIZE: u32 = 30;
const LONG_EDGE_PART_SIZE: u32 = 1;
const VERY_LONG_EDGE_SIZE: u32 = 1000;
const VERY_LONG_EDGE_PART_SIZE: u32 = 250;

/// Part of an edge drawn in one row: from the element's position here to the row's top (`up`)
/// or bottom edge, ending halfway to `to` (the line's position in the neighbouring row), like
/// IntelliJ's `EdgePrintElement`. Painting: a line from (row center, `from`) to (row top /
/// bottom, (`from` + `to`) / 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgePart {
    pub from: u16,
    pub to: u16,
    /// Leaves through the row's top (toward the child), else the bottom (toward the parent).
    pub up: bool,
    /// The line's branch color, 0xRRGGBB ([`color_rgb`]).
    pub color: u32,
    /// An arrow head at the row boundary (a long edge continues out of sight).
    pub arrow: bool,
    /// A stub that ends here with an arrow (cut long edge / unlisted parent); `to == from`.
    pub terminal: bool,
}

/// One row of the graph.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GraphRow {
    /// The commit node's position (0 = leftmost lane).
    pub node: u16,
    /// The node's branch color, 0xRRGGBB ([`color_rgb`]).
    pub color: u32,
    /// Elements in this row (node + lines passing through): the width it needs in lanes.
    pub width: u16,
    pub edges: Vec<EdgePart>,
}

/// The laid out graph: one row per commit, same order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Graph {
    pub rows: Vec<GraphRow>,
    /// The widest row in lanes.
    pub width: u16,
}

/// Color id 0 (a head without refs): `JBColor.BLACK`, i.e. Label.foreground in the dark theme.
pub const NO_REF_COLOR: u32 = 0xD1D3D9;
/// `VersionControl.Log.Graph.saturation` / `.brightness` of ExperimentalDark (Islands Dark's
/// parent theme, expUI_dark.theme.json); the code defaults are 0.4 / 0.65.
const SATURATION: f32 = 0.6;
const BRIGHTNESS: f32 = 0.6;

/// The branch color (0xRRGGBB) for an IntelliJ color id: vcs-log `DefaultColorGenerator.kt`
/// (hue from a fixed RGB walk of the id, WS's dark-theme saturation / brightness). Ids 1-10:
/// #3D8A99 #573D99 #3D5499 #3D9982 #743D99 #3D3D99 #3D993D #4A993D #996B3D #74993D; "master"
/// #66993D, "main" #3D8A99, "origin/master" #99783D.
pub fn color_rgb(color_id: i32) -> u32 {
    if color_id == 0 {
        return NO_REF_COLOR;
    }
    let fix = |n: i32| (n % 100).unsigned_abs() as i32 + 70;
    let r = fix(color_id.wrapping_mul(200).wrapping_add(30));
    let g = fix(color_id.wrapping_mul(130).wrapping_add(50));
    let b = fix(color_id.wrapping_mul(90).wrapping_add(100));
    hsb_to_rgb(rgb_hue(r, g, b), SATURATION, BRIGHTNESS)
}

/// `java.awt.Color.RGBtoHSB(...)[0]` (float math like Java's).
fn rgb_hue(r: i32, g: i32, b: i32) -> f32 {
    let cmax = r.max(g).max(b);
    let cmin = r.min(g).min(b);
    if cmax == 0 || cmax == cmin {
        return 0.0;
    }
    let d = (cmax - cmin) as f32;
    let rc = (cmax - r) as f32 / d;
    let gc = (cmax - g) as f32 / d;
    let bc = (cmax - b) as f32 / d;
    let mut h = if r == cmax {
        bc - gc
    } else if g == cmax {
        2.0 + rc - bc
    } else {
        4.0 + gc - rc
    } / 6.0;
    if h < 0.0 {
        h += 1.0;
    }
    h
}

/// `java.awt.Color.HSBtoRGB`.
fn hsb_to_rgb(h: f32, s: f32, v: f32) -> u32 {
    let hh = (h - h.floor()) * 6.0;
    let f = hh - hh.floor();
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    let c = |x: f32| (x * 255.0 + 0.5) as u32;
    let (r, g, b) = match hh as u32 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    (c(r) << 16) | (c(g) << 8) | c(b)
}

/// Java's `String.hashCode` (UTF-16 units, wrapping): IntelliJ colors a branch by its ref name's.
pub fn java_hash(s: &str) -> i32 {
    s.encode_utf16()
        .fold(0i32, |h, u| h.wrapping_mul(31).wrapping_add(u as i32))
}

/// git4idea `GitRefManager.RefType` in `GitBranchLayoutComparator`'s order (the lower, the
/// further left its branch is laid out).
fn layout_rank(kind: RefType) -> u8 {
    match kind {
        RefType::OriginMaster => 0,
        RefType::Remote => 1,
        RefType::Master => 2,
        RefType::Local => 3,
        RefType::Tag => 4,
        RefType::Head => 6,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RefType {
    OriginMaster,
    Remote,
    Master,
    Local,
    Tag,
    Head,
}

/// The commit's best ref for the layout (`RefsModel.getRefForHeadCommit`: the minimum by the
/// branch layout comparator: type, then name), and whether it has a branch ref (HEAD, local,
/// remote; tags aren't branches).
fn best_ref(c: &Commit) -> (Option<(u8, String)>, bool) {
    let r = &c.refs;
    let mut best: Option<(u8, String)> = None;
    let mut consider = |kind: RefType, name: &str| {
        let key = (layout_rank(kind), name.to_owned());
        let better = match &best {
            None => true,
            Some((rank, n)) => key.0.cmp(rank).then_with(|| natural_cmp(&key.1, n)).is_lt(),
        };
        if better {
            best = Some(key);
        }
    };
    for l in &r.local {
        let kind = if l == "master" || l == "main" {
            RefType::Master
        } else {
            RefType::Local
        };
        consider(kind, l);
    }
    for b in &r.remote {
        let kind = if b == "origin/master" || b == "origin/main" {
            RefType::OriginMaster
        } else {
            RefType::Remote
        };
        consider(kind, b);
    }
    for t in &r.tags {
        consider(RefType::Tag, t);
    }
    if r.head != HeadRef::None {
        consider(RefType::Head, "HEAD");
    }
    let branch = !r.local.is_empty() || !r.remote.is_empty() || r.head != HeadRef::None;
    (best, branch)
}

/// IntelliJ's `NaturalComparator` (ref names): case-insensitive, digit runs by value
/// ("v2" < "v10"), then case-sensitive.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let num = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (n, m) = (num(&mut x), num(&mut y));
                let (nt, mt) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = nt.len().cmp(&mt.len()).then_with(|| nt.cmp(mt));
                if o.is_ne() {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o.is_ne() {
                    return o;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// A row element (IntelliJ `GraphElement`): a node, a normal edge (up row, down row), or a
/// special edge from a node to a parent that isn't listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Elem {
    Node(u32),
    Edge(u32, u32),
    Dangling(u32),
}

struct Layout<'a> {
    li: &'a [u32],
}

impl Layout<'_> {
    /// `GraphElementComparatorByLayoutIndex.compare`.
    fn cmp(&self, a: Elem, b: Elem) -> Ordering {
        let c = match (a, b) {
            (Elem::Node(_), Elem::Node(_)) => 0,
            (Elem::Node(n), e) => -self.cmp2(e, n),
            (e, Elem::Node(n)) => self.cmp2(e, n),
            (Elem::Dangling(n1), e2) => -self.cmp2(e2, n1),
            (e1, Elem::Dangling(n2)) => self.cmp2(e1, n2),
            (Elem::Edge(u1, d1), Elem::Edge(u2, d2)) => {
                if u1 == u2 {
                    if d1 < d2 {
                        -self.cmp2(b, d1)
                    } else {
                        self.cmp2(a, d2)
                    }
                } else if u1 < u2 {
                    self.cmp2(a, u2)
                } else {
                    -self.cmp2(b, u1)
                }
            }
        };
        c.cmp(&0)
    }

    /// `compare2(edge, node)`.
    fn cmp2(&self, e: Elem, node: u32) -> i64 {
        let li = |n: u32| self.li[n as usize] as i64;
        match e {
            Elem::Dangling(n) => li(n) - li(node),
            Elem::Edge(up, down) => {
                let m = li(up).max(li(down));
                if m != li(node) {
                    m - li(node)
                } else {
                    up as i64 - node as i64
                }
            }
            Elem::Node(n) => li(n) - li(node),
        }
    }
}

/// Lays out the graph of `commits` (log order: children before parents).
pub fn layout(commits: &[Commit], opts: &GraphOptions) -> Graph {
    let n = commits.len();
    if n == 0 {
        return Graph::default();
    }
    let index: HashMap<&str, u32> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.hash.as_str(), i as u32))
        .collect();
    // down nodes (parents, in order, duplicates dropped: DuplicateParentFixer), dangling flags,
    // and whether a node has children
    let mut parents: Vec<Vec<u32>> = Vec::with_capacity(n);
    let mut dangling = vec![false; n];
    let mut has_child = vec![false; n];
    for (i, c) in commits.iter().enumerate() {
        let mut ps: Vec<u32> = Vec::with_capacity(c.parents.len());
        for p in &c.parents {
            match index.get(p.as_str()) {
                // a parent above its child (not topological): no edge
                Some(&j) if j as usize > i => {
                    if !ps.contains(&j) {
                        ps.push(j);
                        has_child[j as usize] = true;
                    }
                }
                Some(_) => {}
                None => dangling[i] |= opts.dangling,
            }
        }
        parents.push(ps);
    }

    // heads: nodes without children + nodes with branch refs, sorted like IntelliJ
    let refs: Vec<(Option<(u8, String)>, bool)> = commits.iter().map(best_ref).collect();
    let mut heads: Vec<u32> = (0..n as u32)
        .filter(|&i| !has_child[i as usize] || refs[i as usize].1)
        .collect();
    heads.sort_by(|&a, &b| match (&refs[a as usize].0, &refs[b as usize].0) {
        (Some((ra, na)), Some((rb, nb))) => {
            ra.cmp(rb).then_with(|| natural_cmp(na, nb)).then(a.cmp(&b))
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.cmp(&b),
    });

    // layout indexes: GraphLayoutBuilder.build
    let mut li = vec![0u32; n];
    let mut important: Vec<u32> = Vec::new();
    let mut current = 1u32;
    let mut stack: Vec<u32> = Vec::new();
    for &head in &heads {
        if li[head as usize] != 0 {
            continue;
        }
        important.push(head);
        stack.push(head);
        while let Some(&node) = stack.last() {
            let first_visit = li[node as usize] == 0;
            if first_visit {
                li[node as usize] = current;
            }
            match parents[node as usize]
                .iter()
                .find(|&&p| li[p as usize] == 0)
            {
                Some(&p) => stack.push(p),
                None => {
                    if first_visit {
                        current += 1;
                    }
                    stack.pop();
                }
            }
        }
    }

    // colors: GraphColorGetterByHead + GraphColorManagerImpl
    let head_li: Vec<u32> = important.iter().map(|&h| li[h as usize]).collect();
    let color_id = |node: u32| -> i32 {
        let l = li[node as usize];
        let order = match head_li.binary_search(&l) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        };
        let head = important[order];
        if li[head as usize] == l {
            refs[head as usize]
                .0
                .as_ref()
                .map_or(0, |(_, name)| java_hash(name))
        } else {
            l as i32
        }
    };
    // few distinct ids: memoize the float math
    let mut rgb_of: HashMap<i32, u32> = HashMap::new();
    let node_color: Vec<u32> = (0..n as u32)
        .map(|i| {
            *rgb_of
                .entry(color_id(i))
                .or_insert_with_key(|&id| color_rgb(id))
        })
        .collect();
    let edge_color = |e: Elem| -> u32 {
        match e {
            Elem::Edge(up, down) => {
                if li[up as usize] >= li[down as usize] {
                    node_color[up as usize]
                } else {
                    node_color[down as usize]
                }
            }
            Elem::Dangling(node) | Elem::Node(node) => node_color[node as usize],
        }
    };

    let (long, part, arrow_size) = if opts.show_long_edges {
        (
            VERY_LONG_EDGE_SIZE,
            VERY_LONG_EDGE_PART_SIZE,
            LONG_EDGE_SIZE,
        )
    } else {
        (LONG_EDGE_SIZE, LONG_EDGE_PART_SIZE, u32::MAX)
    };
    let visible = |up: u32, down: u32, row: u32| -> bool {
        down - up < long || (row - up).min(down - row) <= part
    };
    // getArrowType: Some(true) = up arrow, Some(false) = down arrow
    let arrow = |e: Elem, row: u32| -> Option<bool> {
        match e {
            Elem::Edge(up, down) => {
                let size = down - up;
                let up_off = row.wrapping_sub(up);
                let down_off = down.wrapping_sub(row);
                if size >= long {
                    if up_off == part {
                        return Some(false);
                    }
                    if down_off == part {
                        return Some(true);
                    }
                }
                if size >= arrow_size {
                    if up_off == 1 {
                        return Some(false);
                    }
                    if down_off == 1 {
                        return Some(true);
                    }
                }
                None
            }
            Elem::Dangling(node) => (node + 1 == row).then_some(false),
            Elem::Node(_) => None,
        }
    };

    // the sorted visible elements of every row (getSortedVisibleElementsInRow)
    let lay = Layout { li: &li };
    let mut rows_elems: Vec<Vec<Elem>> = Vec::with_capacity(n);
    let mut active: Vec<(u32, u32)> = Vec::new();
    for r in 0..n as u32 {
        if r > 0 {
            active.extend(
                parents[r as usize - 1]
                    .iter()
                    .filter(|&&p| p > r)
                    .map(|&p| (r - 1, p)),
            );
        }
        active.retain(|&(_, down)| down > r);
        let mut elems = Vec::with_capacity(active.len() + 2);
        elems.push(Elem::Node(r));
        elems.extend(
            active
                .iter()
                .filter(|&&(up, down)| visible(up, down, r))
                .map(|&(up, down)| Elem::Edge(up, down)),
        );
        if r > 0 && dangling[r as usize - 1] {
            elems.push(Elem::Dangling(r - 1));
        }
        elems.sort_by(|&a, &b| lay.cmp(a, b));
        rows_elems.push(elems);
    }

    // print elements (getPrintElements)
    let pos_in = |row: Option<&Vec<Elem>>, e: Elem, node: Option<u32>| -> Option<u16> {
        let row = row?;
        row.iter()
            .position(|&x| x == e)
            .or_else(|| node.and_then(|nd| row.iter().position(|&x| x == Elem::Node(nd))))
            .map(|p| p as u16)
    };
    let mut rows = Vec::with_capacity(n);
    let mut width = 0u16;
    for r in 0..n as u32 {
        let elems = &rows_elems[r as usize];
        let above = (r > 0).then(|| &rows_elems[r as usize - 1]);
        let below = rows_elems.get(r as usize + 1);
        let mut edges = Vec::new();
        let mut node_pos = 0u16;
        for (p, &e) in elems.iter().enumerate() {
            let p = p as u16;
            match e {
                Elem::Node(nd) => {
                    node_pos = p;
                    // adjacent edges: to children (up), to parents (down), the dangling one
                    let mut adjacent = child_edges(&rows_elems, &parents, nd);
                    adjacent.extend(parents[nd as usize].iter().map(|&pp| Elem::Edge(nd, pp)));
                    if dangling[nd as usize] {
                        adjacent.push(Elem::Dangling(nd));
                    }
                    for edge in adjacent {
                        let (up_node, down_node) = match edge {
                            Elem::Edge(u, d) => (Some(u), Some(d)),
                            Elem::Dangling(u) => (Some(u), None),
                            Elem::Node(_) => (None, None),
                        };
                        let arr = arrow(edge, r);
                        let color = edge_color(edge);
                        if let Some(to) = pos_in(below, edge, down_node.filter(|&d| d == r + 1)) {
                            edges.push(EdgePart {
                                from: p,
                                to,
                                up: false,
                                color,
                                arrow: arr == Some(false),
                                terminal: false,
                            });
                        }
                        if let Some(to) = pos_in(above, edge, up_node.filter(|&u| u + 1 == r)) {
                            edges.push(EdgePart {
                                from: p,
                                to,
                                up: true,
                                color,
                                arrow: arr == Some(true),
                                terminal: false,
                            });
                        }
                    }
                }
                Elem::Edge(..) | Elem::Dangling(_) => {
                    let (up_node, down_node) = match e {
                        Elem::Edge(u, d) => (Some(u), Some(d)),
                        Elem::Dangling(u) => (Some(u), None),
                        Elem::Node(_) => (None, None),
                    };
                    let arr = arrow(e, r);
                    let color = edge_color(e);
                    match pos_in(below, e, down_node.filter(|&d| d == r + 1)) {
                        Some(to) => edges.push(EdgePart {
                            from: p,
                            to,
                            up: false,
                            color,
                            arrow: arr == Some(false),
                            terminal: false,
                        }),
                        None if arr == Some(false) => edges.push(EdgePart {
                            from: p,
                            to: p,
                            up: false,
                            color,
                            arrow: true,
                            terminal: true,
                        }),
                        None => {}
                    }
                    match pos_in(above, e, up_node.filter(|&u| u + 1 == r)) {
                        Some(to) => edges.push(EdgePart {
                            from: p,
                            to,
                            up: true,
                            color,
                            arrow: arr == Some(true),
                            terminal: false,
                        }),
                        None if arr == Some(true) => edges.push(EdgePart {
                            from: p,
                            to: p,
                            up: true,
                            color,
                            arrow: true,
                            terminal: true,
                        }),
                        None => {}
                    }
                }
            }
        }
        width = width.max(elems.len() as u16);
        rows.push(GraphRow {
            node: node_pos,
            color: node_color[r as usize],
            width: elems.len() as u16,
            edges,
        });
    }
    Graph { rows, width }
}

/// The edges from node `nd`'s children down to it that can show in the row above it: the row
/// above holds every edge passing into row `nd` (visible or not) only as elements, so the
/// candidates are the row above's edges ending at `nd` plus the edge from the row above's node.
fn child_edges(rows_elems: &[Vec<Elem>], parents: &[Vec<u32>], nd: u32) -> Vec<Elem> {
    if nd == 0 {
        return Vec::new();
    }
    let above = &rows_elems[nd as usize - 1];
    let mut out = Vec::new();
    for &e in above {
        match e {
            Elem::Edge(u, d) if d == nd => out.push(Elem::Edge(u, d)),
            Elem::Node(u) if parents[u as usize].contains(&nd) => out.push(Elem::Edge(u, nd)),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::log::Refs;

    /// Commits from (hash, parents, %D with full refs), log order.
    fn commits(spec: &[(&str, &str, &str)]) -> Vec<Commit> {
        spec.iter()
            .map(|(h, ps, refs)| Commit {
                hash: h.to_string(),
                parents: ps.split_whitespace().map(String::from).collect(),
                refs: Refs::parse(refs),
                ..Default::default()
            })
            .collect()
    }

    fn nodes(g: &Graph) -> Vec<u16> {
        g.rows.iter().map(|r| r.node).collect()
    }

    fn part(from: u16, to: u16, up: bool) -> (u16, u16, bool) {
        (from, to, up)
    }

    fn parts(r: &GraphRow) -> Vec<(u16, u16, bool)> {
        let mut v: Vec<_> = r.edges.iter().map(|e| (e.from, e.to, e.up)).collect();
        v.sort();
        v
    }

    #[test]
    fn colors_like_webstorm_dark() {
        let want = [
            0x3D8A99, 0x573D99, 0x3D5499, 0x3D9982, 0x743D99, 0x3D3D99, 0x3D993D, 0x4A993D,
            0x996B3D, 0x74993D,
        ];
        for (i, w) in want.iter().enumerate() {
            assert_eq!(color_rgb(i as i32 + 1), *w, "id {}", i + 1);
        }
        assert_eq!(color_rgb(java_hash("master")), 0x66993D);
        assert_eq!(color_rgb(java_hash("main")), 0x3D8A99);
        assert_eq!(color_rgb(java_hash("origin/master")), 0x99783D);
        assert_eq!(color_rgb(java_hash("origin/main")), 0x4D3D99);
        assert_eq!(color_rgb(0), NO_REF_COLOR);
        assert_eq!(java_hash("master"), -1081267614);
    }

    #[test]
    fn natural_order() {
        assert!(natural_cmp("v2", "v10").is_lt());
        assert!(natural_cmp("Feature", "feature/x").is_lt());
        assert!(natural_cmp("a", "B").is_lt());
        assert!(natural_cmp("x", "x").is_eq());
    }

    #[test]
    fn linear_history_is_one_lane() {
        let c = commits(&[
            ("c", "b", "HEAD -> refs/heads/main"),
            ("b", "a", ""),
            ("a", "", ""),
        ]);
        let g = layout(&c, &GraphOptions::default());
        assert_eq!(nodes(&g), [0, 0, 0]);
        assert_eq!(g.width, 1);
        assert_eq!(parts(&g.rows[0]), [part(0, 0, false)]);
        assert_eq!(parts(&g.rows[1]), [part(0, 0, false), part(0, 0, true)]);
        assert_eq!(parts(&g.rows[2]), [part(0, 0, true)]);
        // the whole line is main's color
        let main = color_rgb(java_hash("main"));
        assert!(g.rows.iter().all(|r| r.color == main));
        assert!(
            g.rows
                .iter()
                .flat_map(|r| &r.edges)
                .all(|e| e.color == main)
        );
    }

    #[test]
    fn merge_puts_the_side_branch_right() {
        // m = merge(a2, s2); side branch s2 - s1 off a1
        let c = commits(&[
            ("m", "a2 s2", "HEAD -> refs/heads/master"),
            ("s2", "s1", ""),
            ("a2", "a1", ""),
            ("s1", "a1", ""),
            ("a1", "", ""),
        ]);
        let g = layout(&c, &GraphOptions::default());
        assert_eq!(nodes(&g), [0, 1, 0, 1, 0]);
        // the merge: down to a2's line (0) and diagonally to s2 (1)
        assert_eq!(parts(&g.rows[0]), [part(0, 0, false), part(0, 1, false)]);
        // row 1: the edge m->a2 passes at 0, s2 at 1
        assert_eq!(
            parts(&g.rows[1]),
            [
                part(0, 0, false),
                part(0, 0, true),
                part(1, 0, true),
                part(1, 1, false)
            ]
        );
        // s1 joins a1 diagonally
        assert_eq!(
            parts(&g.rows[3]),
            [
                part(0, 0, false),
                part(0, 0, true),
                part(1, 0, false),
                part(1, 1, true)
            ]
        );
        // master's color on the first-parent line, a fragment color on the side branch
        let master = color_rgb(java_hash("master"));
        assert_eq!(g.rows[0].color, master);
        assert_eq!(g.rows[2].color, master);
        assert_eq!(g.rows[4].color, master);
        assert_ne!(g.rows[1].color, master);
        assert_eq!(g.rows[1].color, g.rows[3].color);
        // the merge's edge into the side branch takes the side branch's color
        let e = g.rows[0].edges.iter().find(|e| e.to == 1).unwrap();
        assert_eq!(e.color, g.rows[1].color);
    }

    #[test]
    fn branches_ordered_like_intellij() {
        // feature (current, ahead of main) and origin/main elsewhere: origin/main's head lays out
        // first (left), then main, then the local feature branch (its top node is alone in its
        // row: lane 0, then its line moves right of origin/main's)
        let c = commits(&[
            ("f2", "f1", "HEAD -> refs/heads/feature"),
            ("o1", "m1", "refs/remotes/origin/main"),
            ("f1", "m1", ""),
            ("m1", "", "refs/heads/main"),
        ]);
        let g = layout(&c, &GraphOptions::default());
        assert_eq!(nodes(&g), [0, 0, 1, 0]);
        assert_eq!(parts(&g.rows[0]), [part(0, 1, false)]);
        assert_eq!(g.rows[1].color, color_rgb(java_hash("origin/main")));
        assert_eq!(g.rows[0].color, color_rgb(java_hash("feature")));
    }

    #[test]
    fn long_edges_are_cut_with_arrows() {
        // m merges a side commit s whose parent is 40 rows down the main line
        let mut spec: Vec<(String, String, String)> = vec![
            (
                "m".into(),
                "x0 s".into(),
                "HEAD -> refs/heads/master".into(),
            ),
            ("s".into(), "x39".into(), String::new()),
        ];
        for i in 0..40 {
            let parent = if i < 39 {
                format!("x{}", i + 1)
            } else {
                String::new()
            };
            spec.push((format!("x{i}"), parent, String::new()));
        }
        let spec: Vec<(&str, &str, &str)> = spec
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
            .collect();
        let c = commits(&spec);
        let g = layout(&c, &GraphOptions::default());
        // s (row 1) -> x39 (row 41): 40 rows long. Row 2 shows it with a down arrow, then
        // it's gone until the row above x39, which shows an up arrow
        let row2 = &g.rows[2];
        assert!(
            row2.edges.iter().any(|e| e.terminal && !e.up && e.arrow),
            "{row2:?}"
        );
        assert_eq!(g.rows[10].width, 1, "cut: only the node");
        let row40 = &g.rows[40];
        assert!(
            row40.edges.iter().any(|e| e.terminal && e.up && e.arrow),
            "{row40:?}"
        );
        // shown whole with "Show Long Edges"
        let g = layout(
            &c,
            &GraphOptions {
                show_long_edges: true,
                ..Default::default()
            },
        );
        assert_eq!(g.rows[10].width, 2);
        assert!(
            g.rows[2]
                .edges
                .iter()
                .any(|e| e.arrow && !e.terminal && !e.up)
        );
    }

    #[test]
    fn unlisted_parents() {
        let c = commits(&[("b", "a", ""), ("z", "y", "")]);
        let g = layout(&c, &GraphOptions::default());
        // b -> a isn't listed: a stub with an arrow below b (in z's row)
        assert!(g.rows[0].edges.iter().any(|e| !e.up));
        assert!(g.rows[1].edges.iter().any(|e| e.terminal && e.arrow));
        let g = layout(
            &c,
            &GraphOptions {
                dangling: false,
                ..Default::default()
            },
        );
        assert!(g.rows.iter().all(|r| r.edges.is_empty()));
        assert_eq!(layout(&[], &GraphOptions::default()), Graph::default());
    }
}
