//! A drawing view's memory of its parts between frames: a scroll, what it last revealed, the
//! markdown it parsed. One per view (a slot's [`super::SlotView`], the Factory view's own for
//! its main slot, popup and layers), reached while drawing through [`super::Drawn`], kept by
//! the part's node id. Swept after each tree, as the terminals are ([`super::terminal::Terms`]):
//! what a part kept goes once its id left the tree and it was not drawn since the last sweep,
//! and of one part's several (a transcript's per session) only the [`SUBS`] drawn last stay.
//! What it keeps [`Memory::lasting`] outlives its id leaving the tree (a transcript's scroll while
//! Chat shows Claude Code): of one kind's out of the tree, the [`SUBS`] drawn last stay.

use std::any::{Any, TypeId};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::protocol::Node;

/// How many of one part's several it keeps (the sessions a Chat's transcript was on).
pub const SUBS: usize = 8;

struct Entry {
    id: String,
    value: Rc<dyn Any>,
    used: Cell<bool>,
    /// When it was last drawn ([`Memory::tick`]).
    last: Cell<u64>,
    /// Kept while its id is out of the tree too ([`Memory::lasting`]).
    lasting: bool,
}

#[derive(Default)]
pub struct Memory {
    entries: RefCell<HashMap<(TypeId, String, String), Entry>>,
    tick: Cell<u64>,
}

impl std::fmt::Debug for Memory {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.debug_struct("Memory")
            .field("parts", &self.len())
            .finish()
    }
}

impl Memory {
    /// What the part `id` keeps as a `T` (`sub`: one of several it keeps, a session's), made on
    /// first use.
    pub fn kept<T: Default + 'static>(&self, id: &str, sub: &str) -> Rc<RefCell<T>> {
        self.keep(id, sub, false)
    }

    /// As [`Memory::kept`], but it stays while the part's id is out of the tree (its screen shows
    /// something else a while, then the part again where it was): of one kind's out of the tree,
    /// the [`SUBS`] drawn last.
    pub fn lasting<T: Default + 'static>(&self, id: &str, sub: &str) -> Rc<RefCell<T>> {
        self.keep(id, sub, true)
    }

    fn keep<T: Default + 'static>(&self, id: &str, sub: &str, lasting: bool) -> Rc<RefCell<T>> {
        let key = (TypeId::of::<T>(), id.to_owned(), sub.to_owned());
        let mut entries = self.entries.borrow_mut();
        let e = entries.entry(key).or_insert_with(|| Entry {
            id: id.to_owned(),
            value: Rc::new(RefCell::new(T::default())),
            used: Cell::new(false),
            last: Cell::new(0),
            lasting,
        });
        e.used.set(true);
        self.tick.set(self.tick.get() + 1);
        e.last.set(self.tick.get());
        e.value
            .clone()
            .downcast::<RefCell<T>>()
            .unwrap_or_else(|_| Rc::new(RefCell::new(T::default())))
    }

    /// What `id` keeps as a `T`, if it kept one (a key handled between frames).
    pub fn peek<T: 'static>(&self, id: &str, sub: &str) -> Option<Rc<RefCell<T>>> {
        let key = (TypeId::of::<T>(), id.to_owned(), sub.to_owned());
        self.entries
            .borrow()
            .get(&key)
            .and_then(|e| e.value.clone().downcast::<RefCell<T>>().ok())
    }

    /// Every `T` kept (tests: a view's transcripts).
    pub fn each<T: 'static>(&self) -> Vec<Rc<RefCell<T>>> {
        self.entries
            .borrow()
            .iter()
            .filter(|((t, _, _), _)| *t == TypeId::of::<T>())
            .filter_map(|(_, e)| e.value.clone().downcast::<RefCell<T>>().ok())
            .collect()
    }

    /// After a tree: what a part kept stays while its id is in `trees` or it was drawn since the
    /// last sweep; the rest goes.
    pub fn sweep(&self, trees: &[&Node]) {
        fn ids<'a>(n: &'a Node, out: &mut HashSet<&'a str>) {
            if let Some(id) = n.id() {
                out.insert(id);
            }
            for c in n.children() {
                ids(c, out);
            }
        }
        let mut live = HashSet::new();
        for t in trees {
            ids(t, &mut live);
        }
        let mut entries = self.entries.borrow_mut();
        entries.retain(|_, e| e.used.replace(false) || e.lasting || live.contains(e.id.as_str()));
        // of one kind's lasting out of the tree, the ones drawn last
        let mut gone: HashMap<TypeId, Vec<u64>> = HashMap::new();
        for ((t, id, _), e) in entries.iter() {
            if e.lasting && !live.contains(id.as_str()) {
                gone.entry(*t).or_default().push(e.last.get());
            }
        }
        let oldest_gone: HashMap<TypeId, u64> = gone
            .into_iter()
            .filter(|(_, lasts)| lasts.len() > SUBS)
            .map(|(t, mut lasts)| {
                lasts.sort_unstable_by(|a, b| b.cmp(a));
                (t, lasts[SUBS - 1])
            })
            .collect();
        if !oldest_gone.is_empty() {
            entries.retain(|(t, id, _), e| {
                !e.lasting
                    || live.contains(id.as_str())
                    || oldest_gone
                        .get(t)
                        .is_none_or(|floor| e.last.get() >= *floor)
            });
        }
        // of one part's several, the ones drawn last
        let mut parts: HashMap<(TypeId, &str), Vec<u64>> = HashMap::new();
        for ((t, id, _), e) in entries.iter() {
            parts
                .entry((*t, id.as_str()))
                .or_default()
                .push(e.last.get());
        }
        let oldest_kept: HashMap<(TypeId, String), u64> = parts
            .into_iter()
            .filter(|(_, lasts)| lasts.len() > SUBS)
            .map(|((t, id), mut lasts)| {
                lasts.sort_unstable_by(|a, b| b.cmp(a));
                ((t, id.to_owned()), lasts[SUBS - 1])
            })
            .collect();
        if !oldest_kept.is_empty() {
            entries.retain(|(t, id, _), e| {
                oldest_kept
                    .get(&(*t, id.clone()))
                    .is_none_or(|floor| e.last.get() >= *floor)
            });
        }
    }

    /// How many parts keep something (tests: it stays flat).
    pub(super) fn len(&self) -> usize {
        self.entries.borrow().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Scroll(u32);

    fn tree(ids: &[&str]) -> Node {
        let children = ids
            .iter()
            .map(|id| Node::Island {
                id: Some((*id).to_owned()),
                children: Vec::new(),
            })
            .collect();
        Node::Island { id: None, children }
    }

    /// (row, the ids kept, the trees swept after, what is still kept).
    type Row = (
        &'static str,
        &'static [&'static str],
        &'static [&'static [&'static str]],
        &'static [&'static str],
    );

    const ROWS: &[Row] = &[
        (
            "kept while its id is in the tree",
            &["a", "b"],
            &[&["a", "b"], &["a", "b"]],
            &["a", "b"],
        ),
        (
            "drawn since the last sweep: kept once more",
            &["a", "b"],
            &[&["a"]],
            &["a", "b"],
        ),
        (
            "gone from the tree and not drawn: swept",
            &["a", "b"],
            &[&["a"], &["a"]],
            &["a"],
        ),
        (
            "an anonymous part's goes once not drawn",
            &[""],
            &[&[], &[]],
            &[],
        ),
    ];

    #[test]
    fn a_views_memory_keeps_what_its_parts_drew_and_sweeps_what_left_the_tree() {
        for &(name, kept, trees, left) in ROWS {
            let m = Memory::default();
            for id in kept {
                m.kept::<Scroll>(id, "").borrow_mut().0 += 1;
            }
            for t in trees {
                m.sweep(&[&tree(t)]);
            }
            let mut still: Vec<&str> = kept
                .iter()
                .copied()
                .filter(|id| m.peek::<Scroll>(id, "").is_some())
                .collect();
            still.sort();
            assert_eq!(still, left, "{name}");
        }
        // what it keeps is the part's own across frames, by kind and sub
        let m = Memory::default();
        m.kept::<Scroll>("a", "s1").borrow_mut().0 = 7;
        assert_eq!(m.kept::<Scroll>("a", "s1").borrow().0, 7);
        assert_eq!(m.kept::<Scroll>("a", "s2").borrow().0, 0);
        assert_eq!(m.len(), 2);
        // a part on many sessions keeps the last ones only
        let m = Memory::default();
        for n in 0..50 {
            m.kept::<Scroll>("a", &format!("s{n}"));
            m.sweep(&[&tree(&["a"])]);
        }
        assert_eq!(m.len(), SUBS);
        assert!(m.peek::<Scroll>("a", "s49").is_some() && m.peek::<Scroll>("a", "s41").is_none());
        // a lasting one stays out of the tree; of one kind's out of it, the last ones
        let m = Memory::default();
        m.lasting::<Scroll>("a", "s1").borrow_mut().0 = 7;
        m.kept::<Scroll>("b", "");
        for _ in 0..3 {
            m.sweep(&[&tree(&[])]);
        }
        assert_eq!(m.lasting::<Scroll>("a", "s1").borrow().0, 7);
        assert!(m.peek::<Scroll>("b", "").is_none());
        for n in 0..50 {
            m.lasting::<Scroll>(&format!("p{n}"), "");
            m.sweep(&[&tree(&["p49"])]);
        }
        m.sweep(&[&tree(&["p49"])]);
        assert_eq!(
            m.len(),
            SUBS + 1,
            "the one in the tree and the last {SUBS} out of it"
        );
        assert!(m.peek::<Scroll>("p49", "").is_some() && m.peek::<Scroll>("p40", "").is_none());
    }
}
