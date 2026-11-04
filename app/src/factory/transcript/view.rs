//! The transcript as a view of its own, cached: drawn again only when its part of the host's
//! tree changed, the keyboard or the host's selection moved, or it was told (its scroll, a glide,
//! a hover in it). The host's other redraws (the status line's clock, a draft, another slot's
//! frame) leave it as it was painted. Drawn so, it windows its rows ([`super::window`]).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, Render, StyleRefinement,
    Styled as _, Window, div,
};

use super::super::draw::{Drawn, Sub};
use super::super::memory::Memory;
use super::super::protocol::{Node, Slot};
use super::super::select::{self, TextSel};
use super::{Part, TranscriptProps, body, row_key, rows_of};

/// What the transcript's part of the tree was the frame before it drew.
pub(in crate::factory) enum Since<'a> {
    /// The same tree.
    Same,
    /// Another tree, the transcript's children in it these.
    Was(&'a [Node]),
    /// None drawn yet (or not found in it).
    First,
}

impl Since<'_> {
    /// Each row (`keys`, `rows`) new or changed since: drawn wherever it is.
    pub(super) fn changed(
        &self,
        keys: &[String],
        rows: &[(f32, &Node)],
        pinned: impl Fn(&Node) -> bool,
    ) -> Vec<bool> {
        match self {
            Since::Same => vec![false; rows.len()],
            Since::First => vec![true; rows.len()],
            Since::Was(old) => {
                let parts: Vec<&Node> = old.iter().filter(|c| !pinned(c)).collect();
                let was: HashMap<String, &Node> = rows_of(&parts)
                    .into_iter()
                    .enumerate()
                    .map(|(i, (_, c))| (row_key(i, c), c))
                    .collect();
                keys.iter()
                    .zip(rows)
                    .map(|(k, (_, c))| was.get(k) != Some(c))
                    .collect()
            }
        }
    }
}

/// What a host draws its transcript with; another than last frame's draws it again at once.
#[derive(Clone, Debug, PartialEq)]
struct With {
    root: usize,
    path: Vec<usize>,
    focused: bool,
    owner: Option<String>,
    host: usize,
    slot: Option<Slot>,
    sel: String,
    pages_shown: bool,
}

/// A host's transcript view, kept in its memory by the transcript's id.
#[derive(Default)]
struct Hosted {
    view: Option<Entity<TranscriptView>>,
    with: Option<With>,
}

pub struct TranscriptView {
    /// The host's tree and where the transcript is in it.
    root: Option<Rc<Node>>,
    path: Vec<usize>,
    sel: String,
    slot: String,
    /// What it draws with: the host's (no items).
    with: Drawn,
    /// The host's selection, the transcript's is drawn in.
    host: Option<Rc<TextSel>>,
    /// Where its items' selectors start: its own range.
    base: usize,
    /// What it drew last (the host reads it in place: [`Drawn::merged`]).
    out: Rc<RefCell<Drawn>>,
    /// The tree it drew last and where the transcript was in it.
    last: Option<(Rc<Node>, Vec<usize>)>,
    renders: u64,
    /// How many rows it drew, every frame's.
    rows: Rc<Cell<u64>>,
}

thread_local! {
    static VIEWS: Cell<usize> = const { Cell::new(0) };
}

impl TranscriptView {
    fn new() -> Self {
        let n = VIEWS.with(|v| {
            v.set(v.get() + 1);
            v.get()
        });
        TranscriptView {
            root: None,
            path: Vec::new(),
            sel: String::new(),
            slot: String::new(),
            with: Drawn::default(),
            host: None,
            base: n << 24,
            out: Rc::default(),
            last: None,
            renders: 0,
            rows: Rc::default(),
        }
    }
}

/// The transcript `p` as a view of its own in the host's tree: its element (drawn now when what
/// it draws with changed, else as painted unless it was told), its drawing placed in the host's;
/// None when the host has no tree it is in (a layer's: drawn in place).
pub(super) fn hosted(
    sel: &str,
    slot: &str,
    p: &TranscriptProps,
    drawn: &mut Drawn,
    cx: &mut App,
) -> Option<AnyElement> {
    let root = drawn.tree.clone()?;
    let path = path_to(&root, p, &mut Vec::new())?;
    let hosted = drawn.memory.kept::<Hosted>(slot, "");
    let mut h = hosted.borrow_mut();
    let view = h
        .view
        .get_or_insert_with(|| cx.new(|_| TranscriptView::new()))
        .clone();
    let host = select::drawing();
    let with = With {
        root: Rc::as_ptr(&root) as usize,
        path: path.clone(),
        focused: drawn.focused,
        owner: drawn.input.as_ref().and_then(|i| i.owner.clone()),
        host: host.as_ref().map_or(0, |h| Rc::as_ptr(h) as usize),
        slot: drawn.sink.as_ref().map(|s| s.slot),
        sel: sel.to_owned(),
        pages_shown: drawn.pages_shown,
    };
    let fresh = h.with.as_ref() != Some(&with);
    if fresh {
        let with_drawn = Drawn {
            focused: drawn.focused,
            terms: drawn.terms.clone(),
            pages: drawn.pages.clone(),
            pages_shown: drawn.pages_shown,
            sink: drawn.sink.clone(),
            input: drawn.input.clone(),
            memory: drawn.memory.clone(),
            ..Drawn::default()
        };
        let (sel, slot) = (sel.to_owned(), slot.to_owned());
        view.update(cx, |v, _| {
            v.root = Some(root);
            v.path = path;
            v.with = with_drawn;
            v.host = host;
            v.sel = sel;
            v.slot = slot;
        });
        h.with = Some(with);
    }
    drawn.subs.push(Sub {
        at_item: drawn.items.len(),
        #[cfg(debug_assertions)]
        at_node: drawn.nodes.len(),
        #[cfg(debug_assertions)]
        at_click: drawn.clicks.borrow().len(),
        #[cfg(debug_assertions)]
        node: drawn.open.last().copied(),
        drawn: view.read(cx).out.clone(),
    });
    Some(if fresh {
        view.into_any_element()
    } else {
        view.cached(StyleRefinement::default().size_full().min_h_0())
            .into_any_element()
    })
}

/// How many times the transcripts a view keeps were drawn (tests: what redraws them).
pub(in crate::factory) fn renders(memory: &Memory, cx: &App) -> u64 {
    memory
        .each::<Hosted>()
        .iter()
        .filter_map(|h| h.borrow().view.clone())
        .map(|v| v.read(cx).renders)
        .sum()
}

/// How many rows the transcripts a view keeps drew, every frame's (tests: what a frame costs).
pub(in crate::factory) fn rows_drawn(memory: &Memory, cx: &App) -> u64 {
    memory
        .each::<Hosted>()
        .iter()
        .filter_map(|h| h.borrow().view.clone())
        .map(|v| v.read(cx).rows.get())
        .sum()
}

/// Where the transcript `p` is in `n`: each child's index from it down.
fn path_to(n: &Node, p: &TranscriptProps, at: &mut Vec<usize>) -> Option<Vec<usize>> {
    if let Node::ChatPart { part, .. } = n
        && let Part::Transcript(t) = &**part
        && std::ptr::eq(t, p)
    {
        return Some(at.clone());
    }
    for (i, c) in n.children().iter().enumerate() {
        at.push(i);
        if let Some(found) = path_to(c, p, at) {
            return Some(found);
        }
        at.pop();
    }
    None
}

/// The transcript at `path` in `root`: its id, props and children.
fn transcript_at<'a>(
    root: &'a Node,
    path: &[usize],
) -> Option<(Option<&'a str>, &'a TranscriptProps, &'a [Node])> {
    let n = path.iter().try_fold(root, |n, i| n.children().get(*i))?;
    match n {
        Node::ChatPart { id, part, children } => match &**part {
            Part::Transcript(p) => Some((id.as_deref(), p, children)),
            _ => None,
        },
        _ => None,
    }
}

impl Render for TranscriptView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let Some(root) = self.root.clone() else {
            return div().into_any_element();
        };
        let Some((id, p, children)) = transcript_at(&root, &self.path) else {
            return div().into_any_element();
        };
        let last = self.last.replace((root.clone(), self.path.clone()));
        let since = match &last {
            Some((r, _)) if Rc::ptr_eq(r, &root) => Since::Same,
            Some((r, path)) => {
                transcript_at(r, path).map_or(Since::First, |(_, _, c)| Since::Was(c))
            }
            None => Since::First,
        };
        let w = &self.with;
        let mut drawn = Drawn {
            focused: w.focused,
            terms: w.terms.clone(),
            pages: w.pages.clone(),
            pages_shown: w.pages_shown,
            sink: w.sink.clone(),
            input: w.input.clone(),
            memory: w.memory.clone(),
            base: self.base,
            ..Drawn::default()
        };
        let (sel, slot, host) = (self.sel.clone(), self.slot.clone(), self.host.clone());
        let cx: &mut App = cx;
        let el = {
            let windowed = super::Windowed {
                since,
                tall: window.viewport_size().height.as_f32(),
                rows: self.rows.clone(),
            };
            let draw = || body(id, &sel, &slot, p, children, &mut drawn, cx, Some(windowed));
            match &host {
                Some(h) => select::drawing_in(h, draw),
                None => draw(),
            }
        };
        *self.out.borrow_mut() = drawn;
        el
    }
}
