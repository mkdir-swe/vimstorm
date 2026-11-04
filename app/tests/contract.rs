//! The contract's files (`abe/packages/ui/contract`, written by `bun run contract`): each one
//! decodes, and every tree draws in the Factory view with a fake bridge, whole, its clicks
//! reaching the bridge by id.
// GPUI records debug selectors only with debug assertions.
#![cfg(debug_assertions)]

use gpui_kit::{Bounds, Modifiers, MouseButton, MouseUpEvent, Pixels, Point, point, px, size};
use serde_json::Value;
use vimstorm::factory::{self, AppFrame, KINDS, Node};

use crate::common::bridge::{Win, contract, fake, fixture, log};

fn json_files(dir: &str) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = std::fs::read_dir(contract().join(dir))
        .unwrap_or_else(|e| panic!("{dir}: {e}"))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                serde_json::from_str(&text).unwrap(),
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "no fixtures in {dir}");
    out
}

fn kinds_of(n: &Node, out: &mut Vec<String>) {
    out.push(n.kind().to_owned());
    for c in n.children() {
        kinds_of(c, out);
    }
}

#[test]
fn every_contract_file_decodes_and_the_kinds_agree() {
    let schema: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("schema.json")).unwrap()).unwrap();
    assert_eq!(schema["version"], factory::VERSION);
    let theirs: Vec<&str> = schema["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    assert_eq!(theirs, KINDS, "both sides draw one list");

    for (name, v) in json_files("trees") {
        let node: Node = serde_json::from_value(v).unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut kinds = Vec::new();
        kinds_of(&node, &mut kinds);
        assert!(
            kinds.iter().all(|k| KINDS.contains(&k.as_str())),
            "{name}: {kinds:?}"
        );
    }
    for (name, v) in json_files("frames") {
        if name.starts_with("app-") {
            let frame: AppFrame =
                serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            // what Rust writes is the fixture, field for field
            assert_eq!(
                numbers(serde_json::to_value(&frame).unwrap()),
                numbers(v),
                "{name}"
            );
        } else {
            assert!(factory::read_line(&v.to_string()).is_some(), "{name}");
        }
    }
    let (_, unknown) = &json_files("unknown")[0];
    let node: Node = serde_json::from_value(unknown.clone()).unwrap();
    assert_eq!(
        node.children()[0],
        Node::Unknown {
            kind: "Chooser".into(),
            id: Some("chooser".into())
        }
    );
    assert_eq!(node.children()[1].kind(), "Empty");
}

/// Each patch case on file (`patches/<name>.json`: `{"base": <tree>, "frame": <patch frame>,
/// "want": <tree>}`, the bridge's own diff of `base` to `want`) applied here as the reader thread
/// and the drive socket's tap apply it: to the decoded tree and to the JSON, each giving `want`.
#[test]
fn every_patch_on_file_applies_to_its_base_as_its_want() {
    let cases = json_files("patches");
    assert!(!cases.is_empty(), "no patch cases in the contract");
    for (name, case) in cases {
        let Some(factory::Said::Patch(patch)) = factory::read_said(&case["frame"].to_string())
        else {
            panic!("{name}: its frame is no patch");
        };
        assert_eq!(patch.v, factory::VERSION, "{name}");
        let mut tree: Node =
            serde_json::from_value(case["base"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let want: Node =
            serde_json::from_value(case["want"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        factory::apply(&mut tree, patch.ops).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(tree, want, "{name}");

        let ops: Vec<factory::Op<Value>> = serde_json::from_value(case["frame"]["ops"].clone())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut json = case["base"].clone();
        factory::apply(&mut json, ops).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(numbers(json), numbers(case["want"].clone()), "{name}");
    }
}

/// `v` with every number as a float (`1200` and `1200.0` are one px).
fn numbers(v: Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(numbers).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, numbers(v))).collect()),
        v => v,
    }
}

/// The kinds the bridge sends as a layer over the screen.
const LAYERS: &[&str] = &[
    "PickLayer",
    "PromptLayer",
    "ConfirmLayer",
    "CardDialog",
    "CommentBox",
    "LaunchBox",
    "LinkedLayer",
    "SettingsDialog",
];

/// A layer whose nodes lie on a page of its own that scrolls: the page's selector.
const PAGES: &[(&str, &str)] = &[("SettingsDialog", "factory-settings-page")];

/// The kinds drawn elsewhere: the Git tool window draws a ReviewPane (`abe_review.rs`).
const ELSEWHERE: &[&str] = &["ReviewPane"];

/// The window a tree was written for, when not 1440 × 900.
const SIZES: &[(&str, f32, f32)] = &[
    ("factory-800.json", 800., 846.),
    ("factory-narrow.json", 600., 846.),
    ("factory-tightest.json", 430., 846.),
    ("factory-tightest-filter.json", 400., 846.),
    ("local-gallery.json", 1440., 1900.),
    ("run-spec.json", 1400., 860.),
];

/// The kinds whose children scroll under their edges: a child there may be cut or out of view.
const SCROLLS: &[&str] = &["Transcript", "BoardColumns"];

/// The kinds drawn over their parent, past its edge (a menu opening above its field).
const OVER: &[&str] = &["SlashMenu"];

/// The kinds whose focus wash runs past their parent's sides, and by how much.
const WASH: &[(&str, f32)] = &[("SettingRow", 8.), ("CheckRow", 8.)];

/// What a tree on file draws wrong today, found by this test: (the tree, the start of its finding,
/// why). The test fails once one goes, so its row goes with the fix.
const KNOWN: &[(&str, &str, &str)] = &[];

/// A node as drawn, with its box when it has one of its own.
struct NodeBox {
    kind: String,
    id: Option<String>,
    parent: Option<usize>,
    bounds: Option<Bounds<Pixels>>,
}

fn selector(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// Every `id` in a tree, at any depth, in order.
fn ids_of(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(id)) = m.get("id") {
                out.push(id.clone());
            }
            m.values().for_each(|c| ids_of(c, out));
        }
        Value::Array(a) => a.iter().for_each(|c| ids_of(c, out)),
        _ => {}
    }
}

/// `a` inside `b`, its sides allowed `side` px past.
fn inside(a: Bounds<Pixels>, b: Bounds<Pixels>, side: f32) -> bool {
    let (e, s) = (px(0.5), px(side + 0.5));
    a.left() >= b.left() - s
        && a.right() <= b.right() + s
        && a.top() >= b.top() - e
        && a.bottom() <= b.bottom() + e
}

fn apart(a: Bounds<Pixels>, b: Bounds<Pixels>) -> bool {
    a.right() <= b.left() || a.left() >= b.right() || a.bottom() <= b.top() || a.top() >= b.bottom()
}

/// A point in `b` in none of `others`: 3 px in from its edges and corners first (a part's own
/// padding, clear of what it holds), then its centre, then a grid over it.
fn free_point(b: Bounds<Pixels>, others: &[Bounds<Pixels>]) -> Option<Point<Pixels>> {
    let (l, t, r, bt, c) = (
        b.left() + px(3.),
        b.top() + px(3.),
        b.right() - px(3.),
        b.bottom() - px(3.),
        b.center(),
    );
    let edges = [
        point(l, c.y),
        point(c.x, t),
        point(l, t),
        point(r, t),
        point(l, bt),
        point(r, bt),
        point(r, c.y),
        point(c.x, bt),
        c,
    ];
    let grid = (1..8).flat_map(|i| {
        (1..8).map(move |j| {
            point(
                b.left() + b.size.width * (i as f32 / 8.),
                b.top() + b.size.height * (j as f32 / 8.),
            )
        })
    });
    edges
        .into_iter()
        .chain(grid)
        .find(|p| b.contains(p) && !others.iter().any(|o| o.contains(p)))
}

/// The bridge's log as clicks (`Ok` with the id) and marks (`Err` with the mark's root).
fn clicks_and_marks(lines: &[String]) -> Vec<Result<String, String>> {
    lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            if v["type"] == "project" {
                return Some(Err(v["root"].as_str().unwrap_or_default().to_owned()));
            }
            (v["input"]["kind"] == "click")
                .then(|| Ok(v["input"]["id"].as_str().unwrap_or_default().to_owned()))
        })
        .collect()
}

/// One tree drawn, and what it drew wrong.
struct Check<'a> {
    w: &'a mut Win,
    /// How many nodes the screen under a layer drew: the layer's own come after them.
    from: usize,
    dir: &'a std::path::Path,
    name: &'a str,
    wrong: Vec<String>,
}

impl Check<'_> {
    fn wrong(&mut self, what: String) {
        self.wrong.push(format!("{}: {what}", self.name));
    }

    /// The tree's own nodes as drawn, each with its box.
    fn nodes(&mut self, tree: &Value) -> Vec<NodeBox> {
        let from = self.from;
        let mut ids = Vec::new();
        ids_of(tree, &mut ids);
        let (items, ixs, nodes) = self.w.view.read_with(&self.w.cx, |v, _| {
            let d = v.drawn();
            let nodes: Vec<_> = d
                .nodes
                .iter()
                .map(|n| (n.kind.clone(), n.id.clone(), n.item, n.parent))
                .collect();
            let ixs: Vec<usize> = (0..d.items.len()).map(|i| d.ix(i)).collect();
            (d.items.clone(), ixs, nodes)
        });
        nodes
            .into_iter()
            .skip(from)
            .map(|(kind, id, item, parent)| {
                // a node's box: by its id when no other part has it, else by its first item
                let sel = match &id {
                    Some(id) if ids.iter().filter(|x| *x == id).count() == 1 => {
                        Some(format!("factory-node-{id}"))
                    }
                    Some(_) => None,
                    None => items
                        .get(item)
                        .map(|(k, _)| format!("factory-{k}-{}", ixs[item])),
                };
                let bounds = sel.and_then(|s| self.w.cx.debug_bounds(selector(s)));
                NodeBox {
                    kind,
                    id,
                    parent: parent.and_then(|p| p.checked_sub(from)),
                    bounds,
                }
            })
            .collect()
    }

    /// Node `i`'s box, else its nearest parent's, else `page`.
    fn bound_of(nodes: &[NodeBox], i: usize, page: Bounds<Pixels>) -> Bounds<Pixels> {
        nodes[i]
            .bounds
            .unwrap_or_else(|| Self::bound(nodes, i, page).0)
    }

    /// The box node `i` lies in: its nearest parent with a box (and that parent), else `page`.
    fn bound(nodes: &[NodeBox], i: usize, page: Bounds<Pixels>) -> (Bounds<Pixels>, Option<usize>) {
        let mut p = nodes[i].parent;
        while let Some(at) = p {
            if let Some(b) = nodes[at].bounds {
                return (b, Some(at));
            }
            p = nodes[at].parent;
        }
        (page, None)
    }

    /// Every node lies in its parent's box, or under the edge of one that scrolls. Returns which
    /// nodes show: those inside each parent's box.
    fn whole(&mut self, nodes: &[NodeBox], page: Bounds<Pixels>, page_scrolls: bool) -> Vec<bool> {
        let mut shown = vec![false; nodes.len()];
        for (i, n) in nodes.iter().enumerate() {
            let Some(b) = n.bounds else {
                shown[i] = n.parent.is_none_or(|p| shown[p]);
                continue;
            };
            let (outer, by) = Self::bound(nodes, i, page);
            let wash = WASH.iter().find(|(k, _)| *k == n.kind).map_or(0., |w| w.1);
            let scrolls = by.map_or(page_scrolls, |p| SCROLLS.contains(&nodes[p].kind.as_str()));
            let within = inside(b, outer, wash);
            shown[i] = within && by.is_none_or(|p| shown[p]);
            if !within && !scrolls && !OVER.contains(&n.kind.as_str()) {
                let how = if apart(b, outer) {
                    "outside"
                } else {
                    "across the edge of"
                };
                let id = n.id.as_deref().unwrap_or_default();
                self.wrong(format!("{} {id} {b:?} {how} {outer:?}", n.kind));
            }
        }
        shown
    }

    /// A click on each shown part the view marks clickable sends its id to the bridge.
    fn clicks(&mut self, tree: &Value, nodes: &[NodeBox], shown: &[bool], page: Bounds<Pixels>) {
        let mut ids = Vec::new();
        ids_of(tree, &mut ids);
        let from = self.from;
        let marked: Vec<(String, Option<usize>)> = self.w.view.read_with(&self.w.cx, |v, _| {
            let d = v.drawn();
            let clicks = d.clicks.borrow();
            clicks
                .iter()
                .map(|(id, at)| (id.clone(), at.and_then(|a| a.checked_sub(from))))
                .collect()
        });
        // every box of a part with an id and of a node: (the id, the box, the node it is)
        let boxes: Vec<(String, Bounds<Pixels>, Option<usize>)> = ids
            .iter()
            .chain(marked.iter().map(|(m, _)| m).filter(|m| !ids.contains(m)))
            .filter(|id| ids.iter().filter(|x| x == id).count() <= 1)
            .filter_map(|id| {
                let b = self
                    .w
                    .cx
                    .debug_bounds(selector(format!("factory-node-{id}")))?;
                let node = nodes.iter().position(|n| n.id.as_ref() == Some(id));
                Some((id.clone(), b, node))
            })
            .chain(
                nodes
                    .iter()
                    .enumerate()
                    .filter_map(|(i, n)| Some((String::new(), n.bounds?, Some(i)))),
            )
            .collect();
        let mut asked: Vec<String> = Vec::new();
        for (k, (id, owner)) in marked.iter().enumerate() {
            if marked[..k].iter().any(|(m, _)| m == id)
                || ids.iter().filter(|x| *x == id).count() > 1
            {
                continue;
            }
            // a part whose head takes the click (a diff card) by its head
            let head = format!("{id}-head");
            let mut at = vec![format!("factory-node-{id}")];
            if !ids.contains(&head) {
                at.insert(0, format!("factory-node-{head}"));
            }
            let Some(b) = at
                .into_iter()
                .find_map(|s| self.w.cx.debug_bounds(selector(s)))
            else {
                continue;
            };
            // shown: inside the node drawing it, that node shown, and under no box but the nodes
            // holding it
            let mut holders = Vec::new();
            let mut p = *owner;
            while let Some(i) = p {
                holders.push(i);
                p = nodes[i].parent;
            }
            let held = match owner {
                Some(i) => shown[*i] && inside(b, Self::bound_of(nodes, *i, page), 0.),
                None => inside(b, page, 0.),
            };
            let covered = boxes.iter().any(|(i, o, node)| {
                i != id
                    && !apart(*o, b)
                    && !inside(*o, b, 0.)
                    && !node.is_some_and(|n| holders.contains(&n))
            });
            if !held || covered {
                continue;
            }
            // what a click must miss: the boxes inside it
            let under: Vec<Bounds<Pixels>> = boxes
                .iter()
                .filter(|(i, o, _)| i != id && inside(*o, b, 0.) && *o != b)
                .map(|(_, o, _)| *o)
                .collect();
            let Some(at) = free_point(b, &under) else {
                continue;
            };
            self.w
                .cx
                .simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
            self.w.cx.simulate_event(MouseUpEvent {
                position: at,
                modifiers: Modifiers::default(),
                button: MouseButton::Left,
                click_count: 1,
            });
            self.w.cx.run_until_parked();
            asked.push(id.clone());
            // a mark after each click: what the bridge hears between two marks is that click's
            let mark = format!("/{}/{}", self.name, asked.len());
            self.w
                .view
                .update(&mut self.w.cx, |v, _| v.set_root(Some(mark)));
        }
        if asked.is_empty() {
            return;
        }
        let last = Err(format!("/{}/{}", self.name, asked.len()));
        let dir = self.dir;
        self.w.wait("every click told", |_| {
            clicks_and_marks(&log(dir)).contains(&last)
        });
        let told = clicks_and_marks(&log(dir));
        let first = Err(format!("/{}/1", self.name));
        let mut start = told.iter().position(|t| *t == first).unwrap();
        // back to the first click before this tree's first mark
        while start > 0 && told[start - 1].is_ok() {
            start -= 1;
        }
        let mut sent: Vec<Vec<String>> = vec![Vec::new()];
        for t in &told[start..] {
            match t {
                Ok(id) => sent.last_mut().unwrap().push(id.clone()),
                Err(_) => sent.push(Vec::new()),
            }
        }
        for (id, sent) in asked.iter().zip(&sent) {
            if sent != std::slice::from_ref(id) {
                self.wrong(format!("a click on {id} sent {sent:?}"));
            }
        }
    }
}

/// Every tree on file, in the window it was written for: it draws, every kind in it is one the
/// shell draws, every node lies whole inside its parent, and a click on each clickable part
/// sends its id to the bridge. A layer draws as a layer over no screen; `unknown/` draws its
/// needs-component box.
#[test]
fn every_tree_on_file_draws_whole() {
    let dir = tempfile::tempdir().unwrap();
    let mut w = Win::open_sized(Some(fake(dir.path(), &[], None)), 1440., 900.);
    w.start();
    let mut trees: Vec<(String, Value)> = json_files("trees")
        .into_iter()
        .map(|(n, v)| (format!("trees/{n}"), v))
        .collect();
    trees.extend(
        json_files("unknown")
            .into_iter()
            .map(|(n, v)| (format!("unknown/{n}"), v)),
    );
    let kind = |v: &Value| v["kind"].as_str().unwrap_or_default().to_owned();
    // the layers first, over no screen
    trees.sort_by_key(|(n, v)| (!LAYERS.contains(&kind(v).as_str()), n.clone()));
    let (mut rev, mut layer_rev) = (0, 0);
    let mut wrong = Vec::new();
    let mut at = (1440., 900.);
    for (rel, tree) in &trees {
        let root = kind(tree);
        let name = rel.rsplit('/').next().unwrap();
        if ELSEWHERE.contains(&root.as_str()) {
            continue;
        }
        let is_layer = LAYERS.contains(&root.as_str());
        let want = SIZES
            .iter()
            .find(|(n, ..)| *n == name)
            .map_or((1440., 900.), |&(_, w, h)| (w, h));
        if want != at {
            w.cx.simulate_resize(size(px(want.0), px(want.1)));
            at = want;
        }
        layer_rev += 1;
        w.layer(None, layer_rev);
        let from = w.view.read_with(&w.cx, |v, _| v.drawn().nodes.len());
        if is_layer {
            layer_rev += 1;
            w.layer(Some(rel), layer_rev);
        } else {
            rev += 1;
            w.tree(rel, rev);
        }
        let taken = w.view.read_with(&w.cx, |v, _| {
            if is_layer {
                v.layer_up()
            } else {
                v.rev() == Some(rev)
            }
        });
        let mut c = Check {
            w: &mut w,
            from: if is_layer { from } else { 0 },
            dir: dir.path(),
            name,
            wrong: Vec::new(),
        };
        let items = c.w.view.read_with(&c.w.cx, |v, _| v.drawn().items.clone());
        if !taken || items.is_empty() {
            c.wrong("not drawn".into());
        }
        let unknown: Vec<&String> = items
            .iter()
            .filter(|(k, _)| k == "Unknown")
            .map(|(_, t)| t)
            .collect();
        if rel.starts_with("unknown/") {
            if unknown != ["needs component: Chooser"]
                || c.w.cx.debug_bounds("factory-node-chooser").is_none()
            {
                c.wrong(format!("no needs-component box: {unknown:?}"));
            }
        } else if !unknown.is_empty() {
            c.wrong(format!("a kind the shell does not draw: {unknown:?}"));
        }
        let page = PAGES
            .iter()
            .find(|(k, _)| *k == root)
            .and_then(|(_, s)| c.w.cx.debug_bounds(s));
        let window = Bounds::new(point(px(0.), px(0.)), size(px(at.0), px(at.1)));
        let nodes = c.nodes(tree);
        let shown = c.whole(&nodes, page.unwrap_or(window), page.is_some());
        c.clicks(tree, &nodes, &shown, page.unwrap_or(window));
        wrong.extend(c.wrong);
    }
    for (tree, finding, why) in KNOWN {
        let at = format!("{tree}: {finding}");
        let found = wrong.iter().position(|w| w.starts_with(&at));
        assert!(
            found.is_some(),
            "{tree} draws whole now ({why}): drop its row"
        );
        wrong.remove(found.unwrap());
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
