//! Text the mouse selects in Abe's views, as in any text view: a drag selects from where it was
//! pressed, a double-click takes the word, a triple-click the whole text (a paragraph, a log
//! line), ⇧-click extends; ⌘C copies, ⌘A takes it all once something is selected, Esc lets it go.
//! A view owns a [`TextSel`] (each slot's, the rendered Chat's transcript its own): while it draws
//! its tree ([`drawing_in`]) every text drawn with [`text`] takes part in it, a story's markdown
//! and a transcript part through [`TextSel::selectable`]. Copied: plain text in reading order, a
//! line between texts (a space between texts side by side), a blank line between blocks.
//!
//! Reading order is the order the texts are laid out, not the order a component builds them in
//! (a block's parts are often built before its title): each text or block is a unit numbered by
//! where the last frame laid it out ([`settle`]), a new one after them until it has been.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::rc::{Rc, Weak};

use gpui_kit::{
    AnyElement, App, ClipboardItem, FocusHandle, Global, HighlightStyle, InteractiveElement,
    IntoElement as _, MouseButton, Pixels, Point, SharedString, StyledText, Window,
};

use super::story::Selectable;
use crate::editor::markdown::{self, Display, Pos, Registry};

/// Rows a unit's texts are registered under: the unit read `n`th from `n * PART_ROWS`.
const PART_ROWS: usize = 1 << 20;
/// Units a group (a transcript's row) numbers: group `g`'s `n`th read is unit
/// `g * GROUP_UNITS + n`.
const GROUP_UNITS: usize = 1 << 16;

/// A view's text selection: the texts laid out this frame (hit testing), each row's texts
/// (copying), the selection from where the mouse was pressed to where it is.
#[derive(Default)]
pub(super) struct TextSel {
    pub(super) registry: Registry,
    pub(super) rows: Rc<RefCell<BTreeMap<usize, Vec<Display>>>>,
    /// (anchor, head).
    sel: Cell<Option<(Pos, Pos)>>,
    dragging: Cell<bool>,
    /// The group the next units are built in: a transcript numbers each row's units apart, so
    /// a row drawn or not leaves the others' numbers as they were (one view: group 0).
    group: Cell<usize>,
    /// Units (a plain text, a block) built so far this frame in the group.
    units: Cell<usize>,
    /// Where each unit of a group is read within it, by the order it was built: the layout's
    /// of the last frame that drew it.
    read: RefCell<HashMap<usize, Vec<usize>>>,
    /// This frame's units: where each is read → its group and the order it was built in.
    built: RefCell<HashMap<usize, (usize, usize)>>,
    /// The units that are blocks (where they are read): a blank line around them when copied.
    blocks: RefCell<HashSet<usize>>,
    /// The selection of the view it is drawn in (a transcript's: its slot's).
    host: RefCell<Weak<TextSel>>,
    /// What had the keys when the mouse was pressed on its text: a selection gives them back (a
    /// composer elsewhere keeps them; a plain click takes them as clicks do).
    keys: RefCell<Option<FocusHandle>>,
}

impl TextSel {
    /// A frame starts: its texts register anew.
    pub(super) fn begin(&self) {
        self.registry.borrow_mut().clear();
        self.rows.borrow_mut().clear();
        self.group.set(0);
        self.units.set(0);
        self.built.borrow_mut().clear();
        self.blocks.borrow_mut().clear();
    }

    /// The next units are group `g`'s (a transcript's row, from 1), numbered after those of
    /// the groups before it, read in the order its own laid out. Group 0 is the view's own: it
    /// is drawn each frame, the others may not be.
    pub(super) fn group(&self, g: usize) {
        self.group.set(g);
        self.units.set(0);
    }

    /// The view has `n` groups now: what the others read goes.
    pub(super) fn groups(&self, n: usize) {
        self.read.borrow_mut().retain(|g, _| *g < n);
    }

    /// Text is selected (not a caret only).
    pub(super) fn selecting(&self) -> bool {
        self.sel.get().is_some_and(|(a, b)| a != b)
    }

    /// The next unit's first row: where the last frame read it in its group, a new one after
    /// them all.
    fn unit(&self, block: bool) -> usize {
        let (g, n) = (self.group.get(), self.units.get());
        self.units.set(n + 1);
        let read = self.read.borrow();
        let read = read.get(&g).map_or(&[][..], Vec::as_slice);
        let at = g * GROUP_UNITS + read.get(n).copied().unwrap_or(read.len() + n);
        self.built.borrow_mut().insert(at, (g, n));
        if block {
            self.blocks.borrow_mut().insert(at);
        }
        at * PART_ROWS
    }

    /// The next block's first row (a blank line around it when copied).
    pub(super) fn part(&self) -> usize {
        self.unit(true)
    }

    /// The frame laid out: each group's units numbered by where its first text was laid out
    /// (one with none after them; a group not drawn but the view's own keeps its numbers);
    /// whether that moved one (the view draws again with it).
    fn settle(&self) -> bool {
        let mut first: HashMap<usize, u64> = HashMap::new();
        for (key, d) in self.registry.borrow().iter() {
            let at = first.entry(key.0 / PART_ROWS).or_insert(u64::MAX);
            *at = (*at).min(d.seq);
        }
        let mut groups: HashMap<usize, Vec<(u64, usize, usize)>> = HashMap::from([(0, vec![])]);
        for (at, (g, n)) in self.built.borrow().iter() {
            let seq = first.get(at).copied().unwrap_or(u64::MAX);
            groups.entry(*g).or_default().push((seq, *at, *n));
        }
        let mut moved = false;
        let mut was = self.read.borrow_mut();
        for (g, mut units) in groups {
            units.sort_unstable();
            let mut read = vec![0; units.len()];
            for (i, (_, _, n)) in units.iter().enumerate() {
                if let Some(r) = read.get_mut(*n) {
                    *r = i;
                }
            }
            moved |= was.get(&g).map_or(&[][..], Vec::as_slice) != read.as_slice();
            was.insert(g, read);
        }
        moved
    }

    pub(super) fn ordered(&self) -> Option<(Pos, Pos)> {
        self.sel
            .get()
            .map(|(a, b)| if a <= b { (a, b) } else { (b, a) })
    }

    /// What the next part (a story's markdown) draws with.
    pub(super) fn selectable(&self) -> Selectable {
        Selectable {
            registry: self.registry.clone(),
            sel: self.ordered(),
            base: self.part(),
            rows: self.rows.clone(),
        }
    }

    /// A plain text, a unit of its own, its own `runs` on it.
    fn flat(&self, text: String, runs: Vec<(Range<usize>, HighlightStyle)>) -> AnyElement {
        let row = self.unit(false);
        self.rows.borrow_mut().insert(
            row,
            vec![Display {
                text: text.clone(),
                spans: Vec::new(),
            }],
        );
        markdown::selectable_styled(text, runs, (row, 0), self.ordered(), &self.registry)
    }

    /// The mouse pressed at `at`: a click puts the caret there (with Shift the selection goes
    /// on to it), a double-click takes the word, a triple-click the whole text. With `on_line`
    /// only a press on a text's line starts one; whether it did.
    fn press(&self, at: Point<Pixels>, clicks: usize, shift: bool, on_line: bool) -> bool {
        self.dragging.set(false);
        let Some((p, d)) = markdown::hit_in(&self.registry, at, on_line) else {
            self.sel.set(None);
            return false;
        };
        if clicks >= 2 {
            let (s, e) = markdown::word_at(&d.text, p.byte, clicks >= 3);
            self.sel
                .set(Some((Pos { byte: s, ..p }, Pos { byte: e, ..p })));
            return true;
        }
        let anchor = match self.sel.get() {
            Some((a, _)) if shift => a,
            _ => p,
        };
        self.sel.set(Some((anchor, p)));
        self.dragging.set(true);
        true
    }

    /// The mouse dragged to `at`; whether the selection changed.
    fn drag(&self, at: Point<Pixels>) -> bool {
        if !self.dragging.get() {
            return false;
        }
        let (Some((anchor, head)), Some((p, _))) =
            (self.sel.get(), markdown::hit(&self.registry, at))
        else {
            return false;
        };
        self.sel.set(Some((anchor, p)));
        p != head
    }

    /// Everything selected.
    fn all(&self) {
        let rows = self.rows.borrow();
        let first = rows.keys().next().copied();
        let last = rows.iter().next_back().map(|(r, ds)| Pos {
            row: *r,
            text: ds.len().saturating_sub(1),
            byte: ds.last().map_or(0, |d| d.text.len()),
        });
        if let (Some(row), Some(end)) = (first, last) {
            self.sel.set(Some((
                Pos {
                    row,
                    text: 0,
                    byte: 0,
                },
                end,
            )));
        }
    }

    /// Whether it is `view`'s or drawn in it.
    fn within(&self, view: &TextSel) -> bool {
        std::ptr::eq(self, view) || self.host.borrow().upgrade().is_some_and(|h| h.within(view))
    }

    /// The texts registered under a key lower than one laid out before them (tests: what is
    /// copied goes by key, the eye by layout; a frame after a new tree, none).
    pub(super) fn misordered(&self) -> Vec<String> {
        let reg = self.registry.borrow();
        let mut laid: Vec<_> = reg.iter().collect();
        laid.sort_by_key(|(_, d)| d.seq);
        laid.windows(2)
            .filter(|w| w[1].0 < w[0].0)
            .map(|w| format!("{:?} before {:?}", w[0].1.display.text, w[1].1.display.text))
            .collect()
    }

    /// Nothing selected; whether something was.
    pub(super) fn clear(&self) -> bool {
        self.dragging.set(false);
        let had = !self.text().is_empty();
        self.sel.set(None);
        had
    }

    /// The selected text, in reading order: a line between texts (a space between two side by
    /// side), a blank line between parts (code pads dropped).
    pub(super) fn text(&self) -> String {
        let Some((a, b)) = self.ordered() else {
            return String::new();
        };
        let reg = self.registry.borrow();
        let blocks = self.blocks.borrow();
        let mut out = String::new();
        let mut last: Option<(usize, usize)> = None;
        for (row, ds) in self.rows.borrow().range(a.row..=b.row) {
            for (k, d) in ds.iter().enumerate() {
                let Some(r) = markdown::selected_in((a, b), (*row, k), d.text.len()) else {
                    continue;
                };
                if !d.text.is_char_boundary(r.start) || !d.text.is_char_boundary(r.end) {
                    continue;
                }
                if let Some(l) = last {
                    let beside = || {
                        let (p, q) = (
                            reg.get(&l)?.layout.bounds(),
                            reg.get(&(*row, k))?.layout.bounds(),
                        );
                        Some(q.top() < p.bottom() && q.bottom() > p.top() && q.left() > p.left())
                    };
                    let (was, now) = (l.0 / PART_ROWS, row / PART_ROWS);
                    out.push_str(
                        if was != now && (blocks.contains(&was) || blocks.contains(&now)) {
                            "\n\n"
                        } else if beside() == Some(true) {
                            " "
                        } else {
                            "\n"
                        },
                    );
                }
                out.push_str(&markdown::copy_text(&d.text[r]));
                last = Some((*row, k));
            }
        }
        out
    }
}

thread_local! {
    /// The selection of the view drawing its tree: [`text`] draws into it.
    static DRAWING: RefCell<Option<Rc<TextSel>>> = const { RefCell::new(None) };
}

/// `draw` with `sel` the selection its texts take part in (the outer one's again after).
pub(super) fn drawing_in<R>(sel: &Rc<TextSel>, draw: impl FnOnce() -> R) -> R {
    let outer = DRAWING.with(|d| d.borrow_mut().replace(sel.clone()));
    *sel.host.borrow_mut() = outer.as_ref().map_or_else(Weak::new, Rc::downgrade);
    let out = draw();
    DRAWING.with(|d| *d.borrow_mut() = outer);
    out
}

/// The selection of the view drawing, if one is.
pub(super) fn drawing() -> Option<Rc<TextSel>> {
    DRAWING.with(|d| d.borrow().clone())
}

/// Read-only words the mouse selects: registered in the drawing view's selection (a line of
/// its own when copied), plain words where no view draws one. They take the look of the element
/// they are in.
pub(super) fn text(s: impl Into<SharedString>) -> AnyElement {
    let s: SharedString = s.into();
    match drawing() {
        Some(t) => t.flat(s.to_string(), Vec::new()),
        None => s.into_any_element(),
    }
}

/// [`text`] with its own runs (sorted, apart: a word's colour).
pub(super) fn styled(s: String, runs: Vec<(Range<usize>, HighlightStyle)>) -> AnyElement {
    match drawing() {
        Some(t) => t.flat(s, runs),
        None => StyledText::new(s).with_highlights(runs).into_any_element(),
    }
}

/// Last in a view's selection region: once its texts are laid out, their units numbered by
/// where (the view drawn again when that moved one).
pub(super) fn settled(sel: &Rc<TextSel>) -> impl gpui_kit::IntoElement {
    use gpui_kit::Styled as _;
    let sel = sel.clone();
    gpui_kit::canvas(
        move |_, window, cx| {
            if sel.settle() {
                // (a refresh while drawing is dropped)
                window.defer(cx, |window, _| window.refresh());
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
}

/// The selection the mouse was last pressed in: ⌘C copies it.
#[derive(Default)]
struct Pressed(Option<Rc<TextSel>>);

impl Global for Pressed {}

/// A press at `at` in `sel` (`on_line`: only on a text's line, see [`TextSel::press`]): once it
/// lands on text it is the selection ⌘C copies, the one pressed before let go; off text it lets
/// another view's go all the same (⌘C never copies a selection left behind).
pub(super) fn press(
    sel: &Rc<TextSel>,
    (at, clicks, shift): (Point<Pixels>, usize, bool),
    on_line: bool,
    window: &mut Window,
    cx: &mut App,
) {
    if !sel.press(at, clicks, shift, on_line) {
        let p = &mut cx.default_global::<Pressed>().0;
        // (a view drawn in another, a transcript in its slot, is the same press's)
        if let Some(was) = p.take_if(|was| !was.within(sel) && !sel.within(was)) {
            was.clear();
        }
        return;
    }
    let keys = window.focused(cx);
    sel.keys.replace(keys.clone());
    // a word or a paragraph selected: the keys stay where they were once the clicks took them
    if clicks >= 2
        && let Some(f) = keys
    {
        window.defer(cx, move |window, cx| window.focus(&f, cx));
    }
    let p = &mut cx.default_global::<Pressed>().0;
    if let Some(was) = p.replace(sel.clone())
        && !Rc::ptr_eq(&was, sel)
    {
        was.clear();
    }
}

/// The mouse moved with `pressed` held: the selection follows a drag, the keys go back where
/// they were at the press once text is selected; whether it changed.
pub(super) fn drag(
    sel: &TextSel,
    at: Point<Pixels>,
    pressed: Option<MouseButton>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    if pressed != Some(MouseButton::Left) {
        sel.dragging.set(false);
        return false;
    }
    if !sel.drag(at) {
        return false;
    }
    if let Some(f) = sel.keys.borrow().as_ref()
        && !f.is_focused(window)
        && !sel.text().is_empty()
    {
        window.focus(f, cx);
    }
    true
}

/// `el` a view's selection region: a press on a text's line starts a selection in `sel`
/// (the clicks still go where they go), a drag extends it.
pub(super) fn region<E: InteractiveElement>(el: E, sel: &Rc<TextSel>) -> E {
    let (down, moved) = (sel.clone(), sel.clone());
    el.capture_any_mouse_down(move |ev, window, cx| {
        if ev.button == MouseButton::Left {
            let at = (ev.position, ev.click_count, ev.modifiers.shift);
            press(&down, at, true, window, cx);
            window.refresh();
        }
    })
    .on_mouse_move(move |ev, window, cx| {
        if drag(&moved, ev.position, ev.pressed_button, window, cx) {
            window.refresh();
        }
    })
}

/// The text selected where the mouse was last pressed, if any.
fn pressed(cx: &App) -> Option<String> {
    let t = cx.try_global::<Pressed>()?.0.as_ref()?.text();
    (!t.is_empty()).then_some(t)
}

/// ⌘C: the selected text to the clipboard; false when nothing is selected (the key is the
/// screen's then).
pub fn copy_selection(cx: &mut App) -> bool {
    match pressed(cx) {
        Some(text) => {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            true
        }
        None => false,
    }
}

/// Esc wherever the keys are: what ⌘C would copy let go; whether something was.
pub fn let_go(cx: &mut App) -> bool {
    cx.try_global::<Pressed>()
        .and_then(|p| p.0.clone())
        .is_some_and(|t| t.clear())
}

/// ⌘C / ⌘A / Esc on the view whose selection is `view`: the selection's own while text is
/// selected (true: done, the key goes no further). ⌘A selects all of its view; Esc lets it go,
/// the key done when it is in this view (another view's Esc is still that view's screen's).
pub(super) fn selection_key(key: &str, view: &TextSel, cx: &mut App) -> bool {
    if pressed(cx).is_none() {
        return false;
    }
    let Some(t) = cx.try_global::<Pressed>().and_then(|p| p.0.clone()) else {
        return false;
    };
    match key {
        "<D-c>" => copy_selection(cx),
        "<D-a>" => {
            t.all();
            true
        }
        "<Esc>" => t.clear() && t.within(view),
        _ => false,
    }
}
