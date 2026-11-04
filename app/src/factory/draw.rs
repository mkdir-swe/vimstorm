//! A component tree drawn with the UI kit's tokens (Islands Dark, DS 2.0 READMEs): one function
//! per kind of the closed set. Nothing here decides anything: props in, pixels out; a node with an
//! `id` (and a header tab) sends its click back to the bridge.

use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement as _,
    Rgba, SharedString, StatefulInteractiveElement as _, Styled, div, prelude::FluentBuilder as _,
    px,
};

use super::FactoryView;
use super::board;
use super::protocol::{
    AgentProps, AgentState, Align, BadgeProps, Direction, EmptyProps, HeaderProps, HintContext,
    Hue, KeyHintProps, Node, RowProps, RowState, Size, StackProps, UserInput, log_once,
};
use super::select;
use crate::kit::{Icon, IconName};
use crate::look;
use crate::render::UI_FONT;

/// What a render drew, in order: (kind, its words). Tests read it ([`FactoryView::drawn`]).
#[derive(Clone, Debug, Default)]
pub struct Drawn {
    pub items: Vec<(String, String)>,
    /// The tree's nodes in the order drawn, each after its parent. Tests find each one's box and
    /// check it lies inside its parent's; kept only with debug assertions, as the tests run.
    #[cfg(debug_assertions)]
    pub nodes: Vec<DrawnNode>,
    /// The nodes being drawn, innermost last: the parent of the next one.
    #[cfg(debug_assertions)]
    pub(super) open: Vec<usize>,
    /// The ids its clickable parts send, each with the node drawing it, in the order drawn
    /// ([`clickable`]); kept only with debug assertions, as the tests run.
    #[cfg(debug_assertions)]
    pub clicks: std::cell::RefCell<Vec<(String, Option<usize>)>>,
    /// The view has the keyboard (selected tabs in the active colours).
    pub(super) focused: bool,
    /// What it draws with: the view's terminals by key ([`super::terminal::Terms`]).
    pub(super) terms:
        std::collections::HashMap<String, gpui_kit::Entity<super::terminal::TermView>>,
    /// Its pages by key ([`crate::factory::pages::Browsers`]), and whether they may show (no layer
    /// up, the view shown): a native page is drawn over everything GPUI draws.
    pub(super) pages: std::collections::HashMap<String, crate::factory::pages::PageSlot>,
    pub(super) pages_shown: bool,
    /// Where its clicks go: the view and the slot it draws ([`Sink`]).
    pub(super) sink: Option<Sink>,
    /// What a composer types with: its slot's keyboard and IME state ([`super::SlotView`]).
    pub(super) input: Option<super::composer::Input>,
    /// What the view's parts keep between frames ([`super::memory::Memory`]).
    pub(super) memory: std::rc::Rc<super::memory::Memory>,
    /// The tree it draws: a part drawn as a view of its own (a transcript) finds itself in it.
    pub(super) tree: Option<std::rc::Rc<Node>>,
    /// Where its items' indices start in their debug selectors: a view of its own drawn inside
    /// another numbers apart from it.
    pub(super) base: usize,
    /// The parts in it drawn by views of their own, where they are ([`Drawn::merged`]).
    pub(super) subs: Vec<Sub>,
    /// Where a status line keeps its room: its host draws it as a view of its own
    /// ([`super::status::StatusLine`]); None: drawn in place.
    pub(super) line: Option<std::rc::Rc<super::status::Spot>>,
    /// Merged ([`Drawn::merged`]): each item's index in its debug selector.
    pub ixs: Vec<usize>,
}

/// A part drawn by a view of its own inside a view's tree (a transcript): where its items,
/// nodes and clicks go among the host's, the host's node it is, and what it drew last.
#[derive(Clone, Debug)]
pub(super) struct Sub {
    pub(super) at_item: usize,
    #[cfg(debug_assertions)]
    pub(super) at_node: usize,
    #[cfg(debug_assertions)]
    pub(super) at_click: usize,
    #[cfg(debug_assertions)]
    pub(super) node: Option<usize>,
    pub(super) drawn: std::rc::Rc<std::cell::RefCell<Drawn>>,
}

/// A node as drawn: its kind and id, the index of its first item in [`Drawn::items`] and its
/// parent's index in [`Drawn::nodes`].
#[cfg(debug_assertions)]
#[derive(Clone, Debug)]
pub struct DrawnNode {
    pub kind: String,
    pub id: Option<String>,
    pub item: usize,
    pub parent: Option<usize>,
}

/// Where a drawn tree's clicks and keys go: the Factory view's bridge, as `input {slot}`.
#[derive(Clone, Debug)]
pub struct Sink {
    pub view: gpui_kit::WeakEntity<FactoryView>,
    pub slot: super::protocol::Slot,
    /// The keyboard of the view drawing the slot: a click there takes it.
    pub focus: Option<gpui_kit::FocusHandle>,
}

impl Sink {
    pub fn send(&self, input: UserInput, cx: &mut App) {
        let slot = self.slot;
        let _ = self
            .view
            .update(cx, |v, cx| v.send_slot_input(slot, input, cx));
    }

    /// The wheel over `id`: counted into whole steps of `step` px on `axis`.
    pub fn wheel(
        &self,
        id: String,
        axis: super::board::Axis,
        delta: gpui_kit::ScrollDelta,
        step: f32,
        cx: &mut App,
    ) {
        let slot = self.slot;
        let _ = self
            .view
            .update(cx, |v, cx| v.board_wheel(slot, id, axis, delta, step, cx));
    }

    /// A click on `id`: the slot's view takes the keyboard ([`Self::take_keys`]), then the bridge
    /// is told.
    pub fn click(&self, id: String, window: &mut gpui_kit::Window, cx: &mut App) {
        self.take_keys(window, cx);
        self.send(UserInput::Click { id }, cx);
    }

    /// A click in the slot gives its view the keyboard unless it (or a terminal in it) has it
    /// (a Board card clicked while Chat had the keys, a stray ⏎ answered Chat's question).
    pub fn take_keys(&self, window: &mut gpui_kit::Window, cx: &mut App) {
        if let Some(f) = &self.focus
            && !f.contains_focused(window, cx)
        {
            window.focus(f, cx);
        }
    }
}

impl Drawn {
    pub(super) fn add(&mut self, kind: &str, text: impl Into<String>) -> usize {
        self.items.push((kind.to_owned(), text.into()));
        self.base + self.items.len() - 1
    }

    /// Item `i`'s index in its debug selector (`factory-<kind>-<ix>`).
    pub fn ix(&self, i: usize) -> usize {
        self.ixs.get(i).copied().unwrap_or(self.base + i)
    }

    /// What it drew with each part a view of its own drew in its place, as one drawing would
    /// have (tests read it so); [`Drawn::ix`] names each item's selector.
    pub fn merged(&self) -> Drawn {
        let mut out = self.clone();
        if self.subs.is_empty() {
            return out;
        }
        out.subs.clear();
        let subs: Vec<(&Sub, std::cell::Ref<Drawn>)> =
            self.subs.iter().map(|s| (s, s.drawn.borrow())).collect();
        out.items.clear();
        out.ixs.clear();
        let mut k = 0;
        for (s, d) in &subs {
            for i in k..s.at_item {
                out.items.push(self.items[i].clone());
                out.ixs.push(self.ix(i));
            }
            k = s.at_item;
            for (j, it) in d.items.iter().enumerate() {
                out.items.push(it.clone());
                out.ixs.push(d.ix(j));
            }
        }
        for i in k..self.items.len() {
            out.items.push(self.items[i].clone());
            out.ixs.push(self.ix(i));
        }
        #[cfg(debug_assertions)]
        {
            // a host index from `at` on moves by what the subs placed before it put in
            let shift = |at: usize, of: &dyn Fn(&Sub, &Drawn) -> (usize, usize)| {
                subs.iter()
                    .map(|(s, d)| of(s, d))
                    .filter(|(from, _)| *from <= at)
                    .map(|(_, n)| n)
                    .sum::<usize>()
                    + at
            };
            let items = |s: &Sub, d: &Drawn| (s.at_item, d.items.len());
            let nodes = |s: &Sub, d: &Drawn| (s.at_node, d.nodes.len());
            let host_item = |i: usize| shift(i, &items);
            let host_node = |n: usize| shift(n, &nodes);
            let host = |n: &DrawnNode| DrawnNode {
                item: host_item(n.item),
                parent: n.parent.map(host_node),
                ..n.clone()
            };
            out.nodes.clear();
            let mut clicks = Vec::new();
            let mut k = (0, 0);
            for (s, d) in &subs {
                out.nodes
                    .extend(self.nodes[k.0..s.at_node].iter().map(host));
                clicks.extend(
                    self.clicks.borrow()[k.1..s.at_click]
                        .iter()
                        .map(|(id, n)| (id.clone(), n.map(host_node))),
                );
                k = (s.at_node, s.at_click);
                let (item0, node0) = (host_item(s.at_item) - d.items.len(), out.nodes.len());
                let parent = |p: Option<usize>| p.map(|p| node0 + p).or(s.node.map(host_node));
                out.nodes.extend(d.nodes.iter().map(|n| DrawnNode {
                    item: item0 + n.item,
                    parent: parent(n.parent),
                    ..n.clone()
                }));
                clicks.extend(
                    d.clicks
                        .borrow()
                        .iter()
                        .map(|(id, n)| (id.clone(), parent(*n))),
                );
            }
            out.nodes.extend(self.nodes[k.0..].iter().map(host));
            clicks.extend(
                self.clicks.borrow()[k.1..]
                    .iter()
                    .map(|(id, n)| (id.clone(), n.map(host_node))),
            );
            out.clicks = std::cell::RefCell::new(clicks);
        }
        out
    }

    /// The words drawn for `kind`, in order.
    pub fn texts(&self, kind: &str) -> Vec<&str> {
        self.items
            .iter()
            .filter(|(k, _)| k == kind)
            .map(|(_, t)| t.as_str())
            .collect()
    }
}

pub fn hue(h: Hue) -> Rgba {
    match h {
        Hue::Good => look::ABE_GOOD.rgba(),
        Hue::Warn => look::ABE_WARN.rgba(),
        Hue::NeedsYou => look::ABE_NEEDS_YOU.rgba(),
        Hue::Bad => look::ABE_BAD.rgba(),
        Hue::Accent => look::ABE_ACCENT.rgba(),
        Hue::Dim => look::TEXT_DIM.rgba(),
    }
}

pub(super) fn agent_color(s: AgentState) -> Rgba {
    match s {
        AgentState::Starting | AgentState::Idle => look::TEXT_DIM.rgba(),
        AgentState::Running => look::ABE_WARN.rgba(),
        AgentState::NeedsYou => look::ABE_NEEDS_YOU.rgba(),
        AgentState::Ready | AgentState::Merged | AgentState::OnTest => look::ABE_GOOD.rgba(),
        AgentState::Failed => look::ABE_BAD.rgba(),
        AgentState::Ended => look::TEXT_DISABLED.rgba(),
    }
}

/// The debug selector of drawn element `ix` of `kind` (`factory-ListRow-3`), or of a node's id.
pub(super) fn selector(kind: &str, ix: usize, id: Option<&str>) -> String {
    id.map_or_else(
        || format!("factory-{kind}-{ix}"),
        |id| format!("factory-node-{id}"),
    )
}

/// The root: the tree on the window's frame background, inset like the islands.
pub fn root(tree: &Node, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .p(px(look::ISLAND_EDGE_GAP))
        .bg(look::FRAME_BG)
        .font_family(UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .child(grow(
            node(tree, drawn, cx),
            Some(Size::Flex { flex: 1. }),
            Direction::Column,
        ))
        .into_any_element()
}

/// A slot's tree filling its bounds (a [`super::SlotView`]): no inset, its Island is the
/// island the host places.
pub fn fill(tree: &Node, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(look::FRAME_BG)
        .font_family(UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .child(grow(
            node(tree, drawn, cx),
            Some(Size::Flex { flex: 1. }),
            Direction::Column,
        ))
        .into_any_element()
}

/// `el` sized along `dir` as its Stack says.
fn grow(el: AnyElement, size: Option<Size>, dir: Direction) -> AnyElement {
    let mut d = div().flex().flex_col();
    match size {
        Some(Size::Fixed { fixed }) => {
            d = d.flex_none();
            d = match dir {
                Direction::Column => d.h(px(fixed)),
                Direction::Row => d.w(px(fixed)),
            };
        }
        Some(Size::Flex { flex }) => {
            d.style().flex_grow = Some(flex);
            d.style().flex_shrink = Some(1.);
            d.style().flex_basis = Some(px(0.).into());
            d = match dir {
                Direction::Column => d.min_h_0(),
                Direction::Row => d.min_w_0(),
            };
        }
        Some(Size::Fit { fit }) => {
            // its content's, at most `fit` of the Stack: past it the child scrolls its own
            d = d.flex_none();
            d = match dir {
                Direction::Column => d.min_h_0().max_h(gpui_kit::relative(fit)),
                Direction::Row => d.min_w_0().max_w(gpui_kit::relative(fit)),
            };
        }
        Some(Size::Auto(())) | None => d = d.flex_none(),
    }
    d.child(el).into_any_element()
}

/// Sends a click on `id` when the element is pressed.
pub(super) fn clickable<E: InteractiveElement + Styled>(
    d: E,
    id: Option<&str>,
    drawn: &Drawn,
) -> E {
    match (id, drawn.sink.clone()) {
        (Some(id), Some(sink)) => {
            let id = id.to_owned();
            #[cfg(debug_assertions)]
            drawn
                .clicks
                .borrow_mut()
                .push((id.clone(), drawn.open.last().copied()));
            d.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    sink.click(id.clone(), window, cx);
                })
        }
        _ => d,
    }
}

/// A part whose clicks are its own buttons' alone: a click in it gives the view the keyboard and
/// never reaches the clickable part around it (its island's).
pub(super) fn own_clicks<E: InteractiveElement>(d: E, drawn: &Drawn) -> E {
    match drawn.sink.clone() {
        Some(sink) => d.on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            sink.take_keys(window, cx);
        }),
        None => d,
    }
}

pub fn node(n: &Node, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    #[cfg(debug_assertions)]
    {
        let me = drawn.nodes.len();
        drawn.nodes.push(DrawnNode {
            kind: n.kind().to_owned(),
            id: n.id().map(str::to_owned),
            item: drawn.items.len(),
            parent: drawn.open.last().copied(),
        });
        drawn.open.push(me);
    }
    let el = kind(n, drawn, cx);
    #[cfg(debug_assertions)]
    drawn.open.pop();
    el
}

/// `n` drawn by its kind's function.
fn kind(n: &Node, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    match n {
        Node::Island { id, children } => island(id.as_deref(), children, drawn, cx),
        Node::Stack {
            id,
            props,
            children,
        } => stack(id.as_deref(), props, children, drawn, cx),
        Node::ToolWindowHeader { id, props } => header(id.as_deref(), props, drawn),
        Node::ListRow {
            id,
            props,
            children,
        } => row(id.as_deref(), props, children, drawn, cx),
        Node::Badge { id, props } => badge(id.as_deref(), props, drawn),
        Node::KeyHint { id, props } => key_hint(id.as_deref(), props, drawn),
        Node::AgentStatus { id, props } => agent(id.as_deref(), props, drawn),
        Node::Empty { id, props } => empty(id.as_deref(), props, drawn, cx),
        Node::BoardHeader { id, props } => board::board_header(id.as_deref(), props, drawn),
        Node::BoardColumns {
            id,
            props,
            children,
        } => board::columns(id.as_deref(), props, children, drawn, cx),
        Node::BoardColumn {
            id,
            props,
            children,
        } => board::column(id.as_deref(), props, children, drawn, cx),
        Node::BoardCard { id, props } => board::board_card(id.as_deref(), props, drawn),
        // a layer is the bridge's `layer` frame; inside a tree it draws in place
        Node::PickLayer { .. } | Node::PromptLayer { .. } | Node::ConfirmLayer { .. } => {
            super::layers::popup_of(n, drawn).unwrap_or_else(|| div().into_any_element())
        }
        // the card dialog is only ever the top layer: it needs the window's room
        Node::CardDialog { .. } => {
            log_once(
                "dialog-in-tree",
                "a CardDialog inside a tree: drawn only as a layer",
            );
            div().into_any_element()
        }
        // the Card page is the main slot's whole page ([`super::dialog::card_page`])
        Node::CardPage { .. } => {
            log_once(
                "card-page-in-tree",
                "a CardPage inside a tree: drawn only as the main slot's page",
            );
            div().into_any_element()
        }
        // the comment box is a layer; inside a tree it draws in place
        Node::CommentBox { props, .. } => super::comment::comment_box(props, drawn),
        Node::LaunchBox { props, .. } => super::launch::launch_box(props, drawn),
        Node::LinkedLayer { props, .. } => super::linked::popup_of(props, drawn),
        Node::Terminal { id, props } => super::chat::terminal(id.as_deref(), props, drawn),
        Node::ChatHeader { id, props } => super::chat::header(id.as_deref(), props, drawn),
        Node::BrowserView { id, props } => {
            super::browser::browser_view(id.as_deref(), props, drawn)
        }
        Node::ChatPart { id, part, children } => {
            super::transcript::part(id.as_deref(), part, children, drawn, cx)
        }
        Node::Card { id, card, children } => {
            super::cards::card(id.as_deref(), card, children, drawn, cx)
        }
        Node::Composer { id, part, children } => {
            super::composer::part(id.as_deref(), part, children, drawn, cx)
        }
        Node::Settings { id, part, children } => {
            super::settings::part(id.as_deref(), part, children, drawn, cx)
        }
        Node::Table { id, props } => super::table::table(id.as_deref(), props, drawn),
        Node::Pipeline { id, part } => super::pipelines::part(id.as_deref(), part, drawn, cx),
        Node::LocalBand { id, props } => super::local::band(id.as_deref(), props, drawn),
        Node::LocalPullRequest { id, props } => {
            super::local::pull_request(id.as_deref(), props, drawn)
        }
        Node::Run { id, part } => super::run::part(id.as_deref(), part, drawn, cx),
        Node::Install { id, part } => super::install::part(id.as_deref(), part, drawn),
        Node::PrototypePage {
            id,
            props,
            children,
        } => super::prototype::page(id.as_deref(), props, children, drawn, cx),
        Node::Unknown { kind, id } => unknown(kind, id.as_deref(), drawn),
        // the Git tool window draws the PR review; a generic slot has no place for it
        Node::ReviewPane { id, .. } => unknown("ReviewPane", id.as_deref(), drawn),
    }
}

fn island(id: Option<&str>, children: &[Node], drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    let ix = drawn.add("Island", id.unwrap_or_default());
    let sel = selector("Island", ix, id);
    let kids: Vec<AnyElement> = children.iter().map(|c| node(c, drawn, cx)).collect();
    let d = div()
        .debug_selector(move || sel)
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(look::ISLAND_ARC.get()))
        .bg(look::PANEL_BG)
        .border(px(look::ISLAND_BORDER_WIDTH))
        .border_color(look::ISLAND_BORDER)
        // one child fills the island; more stack in a column
        .children(
            kids.into_iter()
                .map(|k| grow(k, Some(Size::Flex { flex: 1. }), Direction::Column)),
        );
    clickable(d, id, drawn).into_any_element()
}

fn stack(
    id: Option<&str>,
    props: &StackProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("Stack", id.unwrap_or_default());
    let sel = selector("Stack", ix, id);
    let dir = props.direction;
    let kids: Vec<AnyElement> = children
        .iter()
        .enumerate()
        .map(|(i, c)| grow(node(c, drawn, cx), props.sizes.get(i).copied(), dir))
        .collect();
    let d = div()
        .debug_selector(move || sel)
        .size_full()
        .flex()
        .gap(px(props.gap))
        .when(dir == Direction::Row, |d| d.flex_row())
        .when(dir == Direction::Row && props.align == Align::Center, |d| {
            d.items_center()
        })
        .when(dir == Direction::Column, |d| d.flex_col())
        .when_some(props.pad, |d, [t, r, b, l]| {
            d.pt(px(t)).pr(px(r)).pb(px(b)).pl(px(l))
        })
        .children(kids);
    clickable(d, id, drawn).into_any_element()
}

fn header(id: Option<&str>, p: &HeaderProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("ToolWindowHeader", p.title.clone());
    let sel = selector("ToolWindowHeader", ix, id);
    let focused = drawn.focused;
    let mut tabs = div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(look::TOOLWINDOW_TAB_GAP))
        .overflow_hidden();
    for tab in &p.tabs {
        drawn.add("Tab", tab.label.clone());
        let selected = p.selected.as_deref() == Some(tab.id.as_str());
        let (bg, border) = if focused {
            (
                look::TOOLWINDOW_TAB_SELECTED_BG,
                look::TOOLWINDOW_TAB_SELECTED_BORDER,
            )
        } else {
            (
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG,
                look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BORDER,
            )
        };
        let tab_id = tab.id.clone();
        let t = div()
            .debug_selector(move || format!("factory-node-{tab_id}"))
            .flex_none()
            .h(px(look::TOOLWINDOW_TAB_HEIGHT))
            .max_w(px(look::TOOLWINDOW_TAB_MAX_WIDTH))
            .px(px(look::TOOLWINDOW_TAB_PAD_X))
            .flex()
            .items_center()
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
            .when(selected, |d| d.bg(bg).border_color(border))
            .when(!selected, |d| {
                d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
            })
            .child(SharedString::from(tab.label.clone()));
        tabs = tabs.child(clickable(t, Some(&tab.id), drawn));
    }
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
        .w_full()
        .flex()
        .items_center()
        .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .pr(px(look::TOOLWINDOW_ACTIONS_PAD_RIGHT + 6.))
        .border_b_1()
        .border_color(look::TOOLWINDOW_HEADER_BORDER)
        .text_size(px(look::TOOLWINDOW_TITLE_FONT_SIZE))
        .child(
            div()
                .flex_none()
                .font_weight(FontWeight::BOLD)
                .text_color(look::TOOLWINDOW_TITLE_FG)
                .child(SharedString::from(p.title.clone())),
        )
        .when_some(p.count, |d, n| {
            drawn.add("Count", n.to_string());
            d.child(
                div()
                    .flex_none()
                    .ml(px(6.))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(n.to_string())),
            )
        })
        .child(div().flex_none().w(px(look::TOOLWINDOW_TITLE_GAP)))
        .child(tabs)
        .when_some(p.note.clone(), |d, note| {
            drawn.add("Note", note.clone());
            d.child(
                div()
                    .flex_none()
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(note)),
            )
        });
    clickable(d, id, drawn).into_any_element()
}

/// An icon by name: the asset's file stem (`folder` for `nodes/folder_dark.svg`) or its variant.
fn icon_named(name: &str) -> Option<IconName> {
    IconName::ALL.iter().copied().find(|i| {
        let stem = i
            .path()
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .trim_end_matches(".svg")
            .trim_end_matches("_dark");
        stem.eq_ignore_ascii_case(name) || format!("{i:?}").eq_ignore_ascii_case(name)
    })
}

fn row(
    id: Option<&str>,
    p: &RowProps,
    children: &[Node],
    drawn: &mut Drawn,
    cx: &mut App,
) -> AnyElement {
    let ix = drawn.add("ListRow", p.text.clone());
    let sel = selector("ListRow", ix, id);
    let disabled = p.state == RowState::Disabled;
    // a selected row without the keyboard draws the inactive selection, as every list does
    let bg = match p.state {
        RowState::Selected if drawn.focused => Some(look::SELECTION_BG),
        RowState::Selected | RowState::SelectedInactive => Some(look::SELECTION_BG_INACTIVE),
        _ => None,
    };
    if let Some(bg) = bg {
        let look = if bg == look::SELECTION_BG {
            "active"
        } else {
            "inactive"
        };
        drawn.add("Selection", format!("{} {look}", p.text));
    }
    let kids: Vec<AnyElement> = children.iter().map(|c| node(c, drawn, cx)).collect();
    let inner = div()
        .size_full()
        .flex()
        .items_center()
        .gap(px(4.))
        .px(px(look::LIST_ROW_PADDING_X))
        .rounded(px(4.))
        .when_some(bg, |d, bg| d.bg(bg))
        .when(id.is_some() && bg.is_none() && !disabled, |d| {
            d.hover(|s| s.bg(look::HOVER_BG))
        })
        .text_color(if disabled {
            look::TEXT_DISABLED
        } else {
            look::TEXT
        })
        .when_some(p.icon.as_deref().and_then(icon_named), |d, icon| {
            d.child(div().flex_none().mr(px(2.)).child(Icon::new(icon)))
        })
        .child(
            div()
                .flex_none()
                .max_w_full()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(select::text(p.text.clone())),
        )
        .when_some(p.dim.clone(), |d, dim| {
            drawn.add("Dim", dim.clone());
            d.child(
                div()
                    .flex_shrink(1.)
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(look::TEXT_DIM)
                    .child(select::text(dim)),
            )
        })
        .children(
            kids.into_iter()
                .map(|k| div().flex_none().ml(px(4.)).child(k)),
        )
        .child(div().flex_1())
        .when_some(p.note.clone(), |d, note| {
            drawn.add("Note", note.clone());
            d.child(
                div()
                    .flex_none()
                    .text_color(look::TEXT_DIM)
                    .child(select::text(note)),
            )
        })
        .when_some(p.key.clone(), |d, key| {
            d.child(
                div()
                    .flex_none()
                    .ml(px(8.))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(crate::kit::label(&key))),
            )
        });
    let outer = div()
        .id(SharedString::from(sel.clone()))
        .debug_selector(move || sel)
        .flex_none()
        .h(px(look::LIST_ROW_HEIGHT.get()))
        .w_full()
        .px(px(look::LIST_ROW_INSET_X))
        .child(inner)
        .when_some(p.reason.clone().filter(|_| disabled), |d, why| {
            d.tooltip(crate::kit::tooltip(why, None))
        });
    clickable(outer, id.filter(|_| !disabled), drawn).into_any_element()
}

fn badge(id: Option<&str>, p: &BadgeProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("Badge", p.text.clone());
    let sel = selector("Badge", ix, id);
    let c = hue(p.hue);
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .px(px(5.))
        .rounded(px(4.))
        .bg(look::abe_badge_bg(c))
        .text_color(c)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(select::text(p.text.clone()));
    clickable(d, id, drawn).into_any_element()
}

fn key_hint(id: Option<&str>, p: &KeyHintProps, drawn: &mut Drawn) -> AnyElement {
    let words = match &p.label {
        Some(l) => format!("{} {l}", p.keys),
        None => p.keys.clone(),
    };
    let ix = drawn.add("KeyHint", words);
    let sel = selector("KeyHint", ix, id);
    let (key_fg, label_fg) = match (p.context, p.dim) {
        (_, true) => (look::TEXT_DIM, look::TEXT_DIM),
        (HintContext::Footer, false) => (look::POPUP_AD_FG, look::POPUP_AD_FG),
        (HintContext::Row, false) => (look::TEXT_DIM, look::TEXT_DIM),
        (HintContext::Button, false) => (look::TEXT, look::TEXT_DIM),
    };
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .when(p.context == HintContext::Footer, |d| {
            d.px(px(8.)).py(px(2.))
        })
        .child(
            div()
                .text_color(key_fg)
                .font_weight(FontWeight::SEMIBOLD)
                .child(SharedString::from(p.keys.clone())),
        )
        .when_some(p.label.clone(), |d, l| {
            d.child(div().text_color(label_fg).child(SharedString::from(l)))
        });
    clickable(d, id, drawn).into_any_element()
}

fn agent(id: Option<&str>, p: &AgentProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("AgentStatus", p.word.clone());
    let sel = selector("AgentStatus", ix, id);
    let color = agent_color(p.state);
    let dot = if p.state == AgentState::Starting {
        super::status::pulse(format!("factory-pulse-{ix}"), "●", color, drawn)
    } else {
        div().text_color(color).child("●").into_any_element()
    };
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .flex()
        .items_center()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .when(p.dot != Some(false), |d| {
            d.child(div().mr(px(4.)).child(dot))
        })
        .child(div().text_color(color).child(select::text(p.word.clone())))
        .when_some(p.reason.clone(), |d, why| {
            drawn.add("Reason", why.clone());
            d.child(
                div()
                    .ml(px(6.))
                    .text_color(look::TEXT_DIM)
                    .child(select::text(why)),
            )
        })
        .when_some(p.connection.clone(), |d, c| {
            d.child(
                div()
                    .text_color(look::TEXT_DIM)
                    .child(select::text(format!(" · {c}"))),
            )
        })
        .when_some(p.env.clone(), |d, env| {
            d.child(
                div()
                    .ml(px(6.))
                    .text_color(look::TEXT_DIM)
                    .child(select::text(env)),
            )
        });
    clickable(d, id, drawn).into_any_element()
}

/// px (W-NoSession): Abe's head, the gap from it to the title, from the title to the actions,
/// between the actions, the primary button's height; the inset from the island's sides.
const EMPTY_HEAD: f32 = 32.;
const EMPTY_HEAD_GAP: f32 = 12.;
const EMPTY_ACTIONS_GAP: f32 = 12.;
const EMPTY_ACTION_GAP: f32 = 8.;
const EMPTY_BUTTON_H: f32 = 24.;
const EMPTY_INSET: f32 = 16.;

fn empty(id: Option<&str>, p: &EmptyProps, drawn: &mut Drawn, cx: &mut App) -> AnyElement {
    let ix = drawn.add("Empty", p.title.clone());
    drawn.add("Line", p.line.clone());
    let sel = selector("Empty", ix, id);
    let head = p.head.then(|| {
        drawn.add("EmptyHead", "");
        div()
            .debug_selector(|| "factory-empty-head".into())
            .mb(px(EMPTY_HEAD_GAP - 4.))
            .child(crate::kit::head(EMPTY_HEAD, 1.0, cx))
    });
    let actions = (!p.actions.is_empty()).then(|| {
        let row = p.actions.iter().map(|a| {
            let aid = a.id.clone();
            let d = div()
                .debug_selector(move || format!("factory-node-{aid}"))
                .flex_none();
            let d = if a.primary {
                drawn.add("EmptyAction", format!("{} {}", a.label, a.keys));
                d.child(
                    crate::kit::TextButton::new(
                        SharedString::from(format!("factory-{}", a.id)),
                        a.label.clone(),
                    )
                    .primary(true)
                    .small(EMPTY_BUTTON_H)
                    .key(a.keys.clone()),
                )
            } else {
                drawn.add("EmptyAction", format!("{} {}", a.keys, a.label));
                d.flex()
                    .items_center()
                    .gap(px(4.))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(SharedString::from(a.keys.clone()))
                    .child(SharedString::from(a.label.clone()))
            };
            clickable(d, Some(&a.id), drawn).into_any_element()
        });
        let row: Vec<AnyElement> = row.collect();
        div()
            .debug_selector(|| "factory-empty-actions".into())
            .mt(px(EMPTY_ACTIONS_GAP - 4.))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(EMPTY_ACTION_GAP))
            .children(row)
    });
    let d = div()
        .debug_selector(move || sel)
        .size_full()
        .min_h(px(60.))
        .px(px(EMPTY_INSET))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(4.))
        .text_center()
        .children(head)
        .child(
            div()
                .debug_selector(|| "factory-empty-title".into())
                .text_color(look::TEXT)
                .font_weight(FontWeight::SEMIBOLD)
                .child(select::text(p.title.clone())),
        )
        .when(!p.line.is_empty(), |d| {
            d.child(
                div()
                    .debug_selector(|| "factory-empty-line".into())
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child(select::text(p.line.clone())),
            )
        })
        .children(actions);
    clickable(d, id, drawn).into_any_element()
}

/// A kind this build doesn't draw: a dim box naming it, logged once per kind.
fn unknown(kind: &str, id: Option<&str>, drawn: &mut Drawn) -> AnyElement {
    log_once(
        &format!("kind:{kind}"),
        &format!("needs component: {kind} (not in this build's set; drawn as a dim box)"),
    );
    let text = format!("needs component: {kind}");
    let ix = drawn.add("Unknown", text.clone());
    let sel = selector("Unknown", ix, id);
    div()
        .debug_selector(move || sel)
        .flex_none()
        .m(px(4.))
        .px(px(8.))
        .py(px(4.))
        .rounded(px(4.))
        .border_1()
        .border_color(look::SEPARATOR)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::TEXT_DISABLED)
        .child(SharedString::from(text))
        .into_any_element()
}
