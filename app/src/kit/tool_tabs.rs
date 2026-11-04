//! A tool window's header: its title ("Git", bold) and content tabs ("Local Changes
//! [Log: HEAD ×]"), WebStorm New UI / Islands look: the selected tab is a rounded box with a 1 px
//! border (blue while the tool window has focus, gray otherwise), others are plain text with a
//! hover box; closable tabs carry a small ×.
//!
//! Mouse: press on a tab selects it ([`ToolTabsEvent::Select`]), the × (or a middle click)
//! closes it ([`ToolTabsEvent::Close`]). When the tabs don't fit, tabs after the last that fits
//! hide (the selected one always shows) and a "▾ N" button at the end emits
//! [`ToolTabsEvent::ShowHidden`] with the hidden tabs and the button's bounds (the owner opens
//! the list popup, like WS's tab list). The header doesn't take the keyboard: the owner maps its
//! keys (Ctrl+Tab etc.) to [`ToolTabs::select`].
//!
//! Title actions (optional, [`ToolTabs::with_actions`]): icon buttons right after the tabs (the
//! terminal's + and ⌄) and at the header's right end (⋮, −), WS's tool window title actions;
//! a click emits [`ToolActionEvent`] with the button's bounds (for a popup below it).
//!
//! Modes (optional, [`ToolTabs::with_modes`]): two or more titles in place of the one, the
//! selected one bold; a click on one emits
//! [`ToolModeEvent`] with its index.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::{
    Bounds, Context, CursorStyle, EventEmitter, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};

use super::icons::{Icon, IconName};
use crate::look;

/// One tab.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolTab {
    pub label: SharedString,
    pub closable: bool,
}

impl ToolTab {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            closable: false,
        }
    }

    pub fn closable(mut self, closable: bool) -> Self {
        self.closable = closable;
        self
    }
}

/// What the header tells its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolTabsEvent {
    Select(usize),
    Close(usize),
    /// The overflow button: hidden tab indices and the button's bounds (window coordinates).
    ShowHidden(Vec<usize>, Bounds<Pixels>),
}

/// A title action button.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolAction {
    pub id: &'static str,
    pub icon: IconName,
    pub tooltip: SharedString,
    pub shortcut: Option<&'static str>,
    /// A text action (the Git window's `Commit`, `Push 2`, `Draft PR…`): the icon then this.
    pub label: Option<SharedString>,
    /// After the label, dim (`Push 2`'s count).
    pub count: Option<SharedString>,
    pub disabled: bool,
}

impl ToolAction {
    pub fn new(id: &'static str, icon: IconName, tooltip: impl Into<SharedString>) -> Self {
        Self {
            id,
            icon,
            tooltip: tooltip.into(),
            shortcut: None,
            label: None,
            count: None,
            disabled: false,
        }
    }

    pub fn shortcut(mut self, shortcut: &'static str) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    /// Drawn as icon + text (`.vs-git-hbtn`).
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn count(mut self, count: Option<String>) -> Self {
        self.count = count.map(Into::into);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// Between a lead item's icon, name and badge.
const LEAD_ITEM_GAP: f32 = 4.;

/// Below this window width, text actions show their icon only.
const TEXT_ACTIONS_MIN_WIDTH: f32 = 720.;

/// A title action was clicked: its id and bounds (window coordinates).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolActionEvent(pub &'static str, pub Bounds<Pixels>);

/// The bottom pane's lead drawn in place of the title (the shown tool window's name, boxed);
/// the owner's own tabs (the Git tool window's Local Changes · Log) after a divider.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneLead {
    pub tabs: Vec<LeadItem>,
    /// The pane tab shown (none: none boxed).
    pub selected: Option<usize>,
}

/// One of the lead's items: its icon, name and badge, its words on hover.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LeadItem {
    pub id: SharedString,
    pub label: SharedString,
    pub icon: Option<IconName>,
    /// Quiet unless `hue` says otherwise (dim words).
    pub badge: Option<SharedString>,
    pub hue: Option<gpui_kit::Rgba>,
    pub tooltip: Option<SharedString>,
}

impl LeadItem {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ..Self::default()
        }
    }
}

/// A pane tab of the lead was pressed: its index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaneLeadEvent(pub usize);

/// A right-click on the lead: the menu of its items opens at this point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LeadMenuEvent(pub gpui_kit::Point<Pixels>);

/// A mode's title was clicked: its index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolModeEvent(pub usize);

/// The header view.
pub struct ToolTabs {
    title: SharedString,
    tabs: Vec<ToolTab>,
    selected: usize,
    /// The tool window has focus: the selected box is blue.
    active: bool,
    /// Width available to the tabs (measured at the last paint).
    width: Pixels,
    overflow_bounds: Bounds<Pixels>,
    /// Each shown tab's box as last painted (window coordinates; owners' tests click them).
    painted: Painted,
    /// Title actions right after the tabs / at the right end.
    after: Vec<ToolAction>,
    right: Vec<ToolAction>,
    /// Each action button as last painted.
    action_painted: ActionsPainted,
    /// Titles in place of `title`, the selected one bold (none: the one title).
    modes: Vec<SharedString>,
    mode: usize,
    /// Each mode's title as last painted.
    modes_painted: Painted,
    /// The bottom pane's lead in place of the title (none: the title).
    lead: Option<PaneLead>,
    /// The lead's tabs as last painted.
    lead_painted: Painted,
    /// The whole header's width at the last paint: what the lead may take (the narrow cut).
    header_width: Pixels,
}

type ActionsPainted = Rc<RefCell<Vec<(&'static str, Bounds<Pixels>)>>>;

/// Tab index -> its painted box.
type Painted = Rc<RefCell<Vec<(usize, Bounds<Pixels>)>>>;

impl EventEmitter<ToolTabsEvent> for ToolTabs {}
impl EventEmitter<ToolActionEvent> for ToolTabs {}
impl EventEmitter<ToolModeEvent> for ToolTabs {}
impl EventEmitter<PaneLeadEvent> for ToolTabs {}
impl EventEmitter<LeadMenuEvent> for ToolTabs {}

impl ToolTabs {
    pub fn new(title: impl Into<SharedString>, tabs: Vec<ToolTab>) -> Self {
        Self {
            title: title.into(),
            tabs,
            selected: 0,
            active: false,
            width: px(f32::MAX),
            overflow_bounds: Bounds::default(),
            painted: Rc::default(),
            after: Vec::new(),
            right: Vec::new(),
            action_painted: Rc::default(),
            modes: Vec::new(),
            mode: 0,
            modes_painted: Rc::default(),
            lead: None,
            lead_painted: Rc::default(),
            header_width: px(f32::MAX),
        }
    }

    /// [`Self::set_lead`] at construction.
    pub fn with_lead(mut self, lead: PaneLead) -> Self {
        self.lead = Some(lead);
        self
    }

    /// The bottom pane's tabs in place of the title.
    pub fn set_lead(&mut self, lead: Option<PaneLead>, cx: &mut Context<Self>) {
        if self.lead != lead {
            self.lead = lead;
            cx.notify();
        }
    }

    pub fn lead(&self) -> Option<&PaneLead> {
        self.lead.as_ref()
    }

    /// Where the lead's pane tab `ix` was last painted (window coordinates; tests click it).
    pub fn lead_bounds(&self, ix: usize) -> Option<Bounds<Pixels>> {
        self.lead_painted
            .borrow()
            .iter()
            .find(|(i, _)| *i == ix)
            .map(|(_, b)| *b)
    }

    /// With title actions: `after` right after the tabs, `right` at the header's right end.
    pub fn with_actions(mut self, after: Vec<ToolAction>, right: Vec<ToolAction>) -> Self {
        self.after = after;
        self.right = right;
        self
    }

    /// The actions at the right end change (a count, a disabled action).
    pub fn set_right_actions(&mut self, right: Vec<ToolAction>, cx: &mut Context<Self>) {
        if self.right != right {
            self.right = right;
            cx.notify();
        }
    }

    /// The actions at the right end (tests).
    pub fn right_actions(&self) -> &[ToolAction] {
        &self.right
    }

    /// Where action `id` was last painted (window coordinates).
    pub fn action_bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.action_painted
            .borrow()
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, b)| *b)
    }

    /// Where tab `ix` was last painted (window coordinates); `None` while hidden (overflow).
    pub fn tab_bounds(&self, ix: usize) -> Option<Bounds<Pixels>> {
        self.painted
            .borrow()
            .iter()
            .find(|(i, _)| *i == ix)
            .map(|(_, b)| *b)
    }

    pub fn tabs(&self) -> &[ToolTab] {
        &self.tabs
    }

    pub fn set_tabs(&mut self, tabs: Vec<ToolTab>, cx: &mut Context<Self>) {
        self.tabs = tabs;
        self.selected = self.selected.min(self.tabs.len().saturating_sub(1));
        cx.notify();
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Selects a tab (no event: the owner did it).
    pub fn select(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix < self.tabs.len() {
            self.selected = ix;
            cx.notify();
        }
    }

    /// The selected box is drawn blue (the tool window is active) rather than gray (tests).
    pub fn active(&self) -> bool {
        self.active
    }

    /// The tool window has the keyboard (blue selected box) or not (gray).
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active != active {
            self.active = active;
            cx.notify();
        }
    }

    /// Width of a tab's box.
    fn tab_width(&self, ix: usize, window: &Window) -> Pixels {
        let t = &self.tabs[ix];
        let w = text_width(&t.label, window);
        let close = if t.closable {
            px(look::TOOLWINDOW_TAB_CLOSE_GAP + look::TOOLWINDOW_TAB_CLOSE_SIZE)
        } else {
            px(0.)
        };
        let right = if t.closable {
            look::TOOLWINDOW_TAB_PAD_RIGHT_CLOSE
        } else {
            look::TOOLWINDOW_TAB_PAD_X
        };
        px(look::TOOLWINDOW_TAB_PAD_X) + w + close + px(right)
    }

    /// Tabs that fit in order (the selected one always), and whether the overflow button shows.
    fn fit(&self, window: &Window) -> (Vec<usize>, bool) {
        let widths: Vec<f32> = (0..self.tabs.len())
            .map(|i| self.tab_width(i, window).as_f32())
            .collect();
        // the actions after the tabs share their row
        let actions =
            self.after.len() as f32 * (look::ACTION_BUTTON_SIZE + look::TOOLWINDOW_TAB_GAP);
        fit_widths(
            &widths,
            self.selected,
            self.width.as_f32() - actions,
            look::TOOLWINDOW_TAB_GAP,
            look::TOOLWINDOW_OVERFLOW_WIDTH,
        )
    }

    fn on_tab_down(&mut self, ix: usize, ev: &MouseDownEvent, cx: &mut Context<Self>) {
        match ev.button {
            MouseButton::Left => {
                if self.selected != ix {
                    self.selected = ix;
                    cx.notify();
                }
                cx.emit(ToolTabsEvent::Select(ix));
            }
            MouseButton::Middle if self.tabs[ix].closable => cx.emit(ToolTabsEvent::Close(ix)),
            _ => {}
        }
    }
}

/// Width of a label in the header font.
fn text_width(text: &SharedString, window: &Window) -> Pixels {
    let mut font = window.text_style().font();
    font.family = crate::render::UI_FONT.into();
    super::text::width(window, text, font, px(look::TOOLWINDOW_TAB_FONT_SIZE))
}

impl Render for ToolTabs {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.render_title(cx);
        let untitled = self.title.is_empty() && self.modes.is_empty();
        let lead = self.render_lead(window, cx);
        let (shown, overflow) = self.fit(window);
        let hidden: Vec<usize> = (0..self.tabs.len())
            .filter(|i| !shown.contains(i))
            .collect();
        let (sel_bg, sel_border) = if self.active {
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
        self.action_painted.borrow_mut().clear();
        let narrow = window.viewport_size().width < px(TEXT_ACTIONS_MIN_WIDTH);
        let action = |a: &ToolAction, cx: &mut Context<Self>| {
            let record = self.action_painted.clone();
            let id = a.id;
            let emit = {
                let entity = cx.entity().downgrade();
                let record = record.clone();
                move |_: &gpui_kit::ClickEvent, _: &mut Window, cx: &mut gpui_kit::App| {
                    let b = record
                        .borrow()
                        .iter()
                        .find(|(i, _)| *i == id)
                        .map(|(_, b)| *b)
                        .unwrap_or_default();
                    let _ = entity.update(cx, |_, cx| cx.emit(ToolActionEvent(id, b)));
                }
            };
            // a narrow window keeps the icons only (the tabs keep their room)
            let text = a.label.clone().filter(|_| !narrow).map(|label| {
                let enabled = !a.disabled;
                div()
                    .id(SharedString::from(id))
                    .debug_selector(move || format!("button-{id}"))
                    .h(px(look::ACTION_BUTTON_SIZE))
                    .pl(px(3.))
                    .pr(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(look::ACTION_BUTTON_ARC))
                    .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
                    .whitespace_nowrap()
                    .text_color(if enabled {
                        look::TEXT
                    } else {
                        look::TEXT_DISABLED
                    })
                    .child(Icon::new(a.icon).disabled(!enabled))
                    .child(label)
                    .when_some(a.count.clone(), |d, c| {
                        d.child(div().text_color(look::TEXT_DIM).child(c))
                    })
                    .tooltip(crate::kit::tooltip::tooltip(a.tooltip.clone(), a.shortcut))
                    .when(enabled, |d| {
                        d.cursor_pointer()
                            .hover(|s| s.bg(look::HOVER_BG))
                            .on_click(emit.clone())
                    })
            });
            div()
                .relative()
                .flex_none()
                .when_some(text, |d, t| d.child(t))
                .when(a.label.is_none() || narrow, |d| {
                    d.child(
                        crate::kit::button::IconButton::new(SharedString::from(id), a.icon)
                            .tooltip(a.tooltip.clone(), a.shortcut)
                            .on_click({
                                let entity = cx.entity().downgrade();
                                let record = record.clone();
                                move |_, _, cx| {
                                    let b = record
                                        .borrow()
                                        .iter()
                                        .find(|(i, _)| *i == id)
                                        .map(|(_, b)| *b)
                                        .unwrap_or_default();
                                    let _ =
                                        entity.update(cx, |_, cx| cx.emit(ToolActionEvent(id, b)));
                                }
                            }),
                    )
                })
                .child(
                    canvas(
                        move |b, _, _| record.borrow_mut().push((id, b)),
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
        };
        let after: Vec<_> = self.after.iter().map(|a| action(a, cx)).collect();
        let right: Vec<_> = self.right.iter().map(|a| action(a, cx)).collect();
        let has_right = !right.is_empty();
        self.painted.borrow_mut().clear();
        let painted = self.painted.clone();
        let tabs = shown.into_iter().map(|ix| {
            let record = painted.clone();
            let t = self.tabs[ix].clone();
            let selected = ix == self.selected;
            div()
                .id(("tool-tab", ix))
                .debug_selector(move || format!("tool-tab-{ix}"))
                // the selected tab gives way when even it doesn't fit (a narrow pane whose lead
                // took the room): clipped, the overflow button stays reachable
                .map(|d| {
                    if overflow && selected {
                        d.flex_shrink_1().min_w_0()
                    } else {
                        d.flex_none()
                    }
                })
                .max_w(px(look::TOOLWINDOW_TAB_MAX_WIDTH))
                .overflow_hidden()
                .whitespace_nowrap()
                .h(px(look::TOOLWINDOW_TAB_HEIGHT))
                // every tab has the 1 px border (transparent unless selected): pads include it
                .pl(px(look::TOOLWINDOW_TAB_PAD_X - look::TAB_BORDER_WIDTH))
                .pr(px(if t.closable {
                    look::TOOLWINDOW_TAB_PAD_RIGHT_CLOSE
                } else {
                    look::TOOLWINDOW_TAB_PAD_X
                } - look::TAB_BORDER_WIDTH))
                .flex()
                .items_center()
                .rounded(px(look::TOOLWINDOW_TAB_ARC))
                .border_1()
                .cursor(CursorStyle::PointingHand)
                .text_color(if selected {
                    look::TOOLWINDOW_TAB_SELECTED_FG
                } else {
                    look::TOOLWINDOW_TAB_FG
                })
                .map(|d| {
                    if selected {
                        d.bg(sel_bg).border_color(sel_border)
                    } else {
                        d.border_color(gpui_kit::transparent_black())
                            .hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
                    }
                })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        this.on_tab_down(ix, ev, cx)
                    }),
                )
                .on_mouse_down(
                    MouseButton::Middle,
                    cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                        this.on_tab_down(ix, ev, cx)
                    }),
                )
                .relative()
                .child(
                    canvas(
                        move |b, _, _| record.borrow_mut().push((ix, b)),
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
                .child(
                    div()
                        .debug_selector(move || format!("tool-tab-label-{ix}"))
                        .relative()
                        .top(px(look::TOOLWINDOW_TEXT_DY))
                        .child(t.label.clone()),
                )
                .when(t.closable, |d| {
                    d.child(div().flex_none().w(px(look::TOOLWINDOW_TAB_CLOSE_GAP)))
                        .child(
                            div()
                                .id(("tool-tab-close", ix))
                                .debug_selector(move || format!("tool-tab-close-{ix}"))
                                .group("tool-tab-close")
                                .relative()
                                .flex_none()
                                .size(px(look::TOOLWINDOW_TAB_CLOSE_SIZE))
                                // WS swaps in closeSmallHovered (a gray circle behind the ×)
                                .child(Icon::new(IconName::CloseSmall))
                                .child(
                                    div()
                                        .absolute()
                                        .top_0()
                                        .left_0()
                                        .invisible()
                                        .group_hover("tool-tab-close", |s| s.visible())
                                        .child(Icon::new(IconName::CloseSmallHovered)),
                                )
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(move |_, _: &MouseDownEvent, _, cx| {
                                        cx.stop_propagation();
                                        cx.emit(ToolTabsEvent::Close(ix));
                                    }),
                                ),
                        )
                })
        });
        let entity = cx.entity().downgrade();
        let measure = canvas(
            move |bounds, _, cx| {
                // the room the tabs get: remeasured every paint, re-render when it changed
                let _ = entity.update(cx, |this, cx| {
                    if this.width != bounds.size.width {
                        this.width = bounds.size.width;
                        cx.notify();
                    }
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let entity = cx.entity().downgrade();
        let overflow_measure = canvas(
            move |bounds, _, cx| {
                let _ = entity.update(cx, |this, _| this.overflow_bounds = bounds);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let entity = cx.entity().downgrade();
        let header_measure = canvas(
            move |bounds, _, cx| {
                let _ = entity.update(cx, |this, cx| {
                    if this.header_width != bounds.size.width {
                        this.header_width = bounds.size.width;
                        cx.notify();
                    }
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        div()
            .debug_selector(|| "tool-tabs".into())
            .relative()
            .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
            .w_full()
            .child(header_measure)
            // UIUtil.drawHeader's bottom line
            .border_b_1()
            .border_color(look::TOOLWINDOW_HEADER_BORDER)
            .flex()
            .items_center()
            .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
            .map(|d| match lead {
                Some(lead) => d.child(lead),
                // no title (the Chat column's Terminal row): the first tab's box at the 12 px
                // padding less its inset, as the pane lead's, no empty gap before it
                None if untitled => {
                    d.child(div().flex_none().ml(px(-look::TOOLWINDOW_TAB_BOX_INSET_X)))
                }
                None => d.child(title).child(div().flex_none().w(px(
                    look::TOOLWINDOW_TITLE_GAP + look::TOOLWINDOW_TAB_BOX_INSET_X
                ))),
            })
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(look::TOOLWINDOW_TAB_GAP))
                    .overflow_hidden()
                    .child(measure)
                    .children(tabs)
                    .when(overflow, |d| {
                        d.child(
                            div()
                                .id("tool-tabs-overflow")
                                .debug_selector(|| "tool-tabs-overflow".into())
                                .flex_none()
                                .relative()
                                .flex_none()
                                .h(px(look::TOOLWINDOW_TAB_HEIGHT))
                                .px(px(4.))
                                .flex()
                                .items_center()
                                .gap(px(2.))
                                .rounded(px(look::TOOLWINDOW_TAB_ARC))
                                .cursor(CursorStyle::PointingHand)
                                .hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
                                .text_color(look::TOOLWINDOW_TAB_FG)
                                .child(overflow_measure)
                                .child(Icon::new(IconName::ChevronDown))
                                .child(
                                    div()
                                        .relative()
                                        .top(px(look::TOOLWINDOW_TEXT_DY))
                                        .child(format!("{}", hidden.len())),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let b = this.overflow_bounds;
                                    cx.emit(ToolTabsEvent::ShowHidden(hidden.clone(), b));
                                })),
                        )
                    })
                    .children(after),
            )
            .when(has_right, |d| {
                d.child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(look::TOOLWINDOW_TAB_GAP))
                        .pl(px(look::TOOLWINDOW_TAB_GAP))
                        .pr(px(look::TOOLWINDOW_ACTIONS_PAD_RIGHT))
                        .children(right),
                )
            })
    }
}

impl ToolTabs {
    /// Which of the lead's items keep their name (the narrow cut): every one while all fit in
    /// the header, else names drop right to left, leaving icon and badge.
    fn lead_named(&self, lead: &PaneLead, window: &Window) -> Vec<bool> {
        let items: Vec<&LeadItem> = lead.tabs.iter().collect();
        let width = |i: &LeadItem, named: bool| {
            let mut w = 2. * look::TOOLWINDOW_TAB_PAD_X;
            let mut parts = 0;
            if i.icon.is_some() {
                w += look::ICON_SIZE;
                parts += 1;
            }
            if named || i.icon.is_none() {
                w += text_width(&i.label, window).as_f32();
                parts += 1;
            }
            if let Some(b) = &i.badge {
                w += text_width(b, window).as_f32();
                parts += 1;
            }
            w + (parts.max(1) - 1) as f32 * LEAD_ITEM_GAP
        };
        let gaps = items.len().saturating_sub(1) as f32 * look::TOOLWINDOW_TAB_GAP;
        let narrow = window.viewport_size().width < px(TEXT_ACTIONS_MIN_WIDTH);
        let right = self
            .right
            .iter()
            .map(|a| {
                let text = match (&a.label, narrow) {
                    (Some(l), false) => {
                        text_width(l, window).as_f32()
                            + a.count
                                .as_ref()
                                .map_or(0., |c| text_width(c, window).as_f32() + 4.)
                            + 13.
                    }
                    _ => 0.,
                };
                look::ACTION_BUTTON_SIZE + text + look::TOOLWINDOW_TAB_GAP
            })
            .sum::<f32>()
            + look::TOOLWINDOW_ACTIONS_PAD_RIGHT;
        // the owner's own tabs (the Git tool window's) keep their room, and its actions after them
        let own = if self.tabs.is_empty() {
            0.
        } else {
            (0..self.tabs.len())
                .map(|i| self.tab_width(i, window).as_f32() + look::TOOLWINDOW_TAB_GAP)
                .sum::<f32>()
                + 2. * look::PANE_GROUP_SEP_GAP
                + look::SEPARATOR_WIDTH
                + self.after.len() as f32 * (look::ACTION_BUTTON_SIZE + look::TOOLWINDOW_TAB_GAP)
        };
        let room = self.header_width.as_f32() - look::TOOL_WINDOW_HEADER_PAD_X - right - own;
        let mut named = vec![true; items.len()];
        let total = |named: &[bool]| {
            items
                .iter()
                .zip(named)
                .map(|(i, n)| width(i, *n))
                .sum::<f32>()
                + gaps
        };
        for ix in (0..items.len()).rev() {
            if total(&named) <= room {
                break;
            }
            if items[ix].icon.is_some() {
                named[ix] = false;
            }
        }
        named
    }

    /// The bottom pane's lead, the shown one boxed (blue while the pane has the keyboard), then a
    /// divider when the owner has tabs of its own.
    fn render_lead(&self, window: &Window, cx: &mut Context<Self>) -> Option<gpui_kit::AnyElement> {
        let lead = self.lead.clone()?;
        let (sel_bg, sel_border) = if self.active {
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
        let named = self.lead_named(&lead, window);
        self.lead_painted.borrow_mut().clear();
        let item = |item: &LeadItem, named: bool, selected: bool, record: Painted, ix: usize| {
            let hue = item.hue;
            div()
                .relative()
                .flex_none()
                .h(px(look::TOOLWINDOW_TAB_HEIGHT))
                .px(px(look::TOOLWINDOW_TAB_PAD_X - look::TAB_BORDER_WIDTH))
                .flex()
                .items_center()
                .gap(px(LEAD_ITEM_GAP))
                .rounded(px(look::TOOLWINDOW_TAB_ARC))
                .border_1()
                .cursor(CursorStyle::PointingHand)
                .whitespace_nowrap()
                .text_color(if selected {
                    look::TOOLWINDOW_TAB_SELECTED_FG
                } else {
                    look::TOOLWINDOW_TAB_FG
                })
                .map(|d| {
                    if selected {
                        d.bg(sel_bg).border_color(sel_border)
                    } else {
                        d.border_color(gpui_kit::transparent_black())
                            .hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
                    }
                })
                .child(
                    canvas(
                        move |b, _, _| record.borrow_mut().push((ix, b)),
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
                .when_some(item.icon, |d, icon| d.child(Icon::new(icon)))
                .when(named || item.icon.is_none(), |d| {
                    let id = item.id.clone();
                    d.child(
                        div()
                            .debug_selector(move || format!("lead-label-{id}"))
                            .relative()
                            .top(px(look::TOOLWINDOW_TEXT_DY))
                            .child(item.label.clone()),
                    )
                })
                .when_some(item.badge.clone(), |d, b| {
                    let id = item.id.clone();
                    d.child(
                        div()
                            .debug_selector(move || format!("lead-badge-{id}"))
                            .relative()
                            .top(px(look::TOOLWINDOW_TEXT_DY))
                            .text_color(hue.unwrap_or(look::TEXT_DIM.rgba()))
                            .child(b),
                    )
                })
        };
        let tabs = lead.tabs.iter().enumerate().map(|(ix, t)| {
            item(
                t,
                named[ix],
                lead.selected == Some(ix),
                self.lead_painted.clone(),
                ix,
            )
            .id(("pane-tab", ix))
            .debug_selector(move || format!("pane-tab-{ix}"))
            .when_some(t.tooltip.clone(), |d, tip| {
                d.tooltip(crate::kit::tooltip::tooltip(tip, None))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |_, _: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    cx.emit(PaneLeadEvent(ix));
                }),
            )
        });
        let sep = || {
            div()
                .flex_none()
                .mx(px(look::PANE_GROUP_SEP_GAP))
                .w(px(look::SEPARATOR_WIDTH))
                .h(px(look::PANE_GROUP_SEP_HEIGHT))
                .bg(look::SEPARATOR)
        };
        let own = !self.tabs.is_empty();
        Some(
            div()
                .id("pane-lead")
                .debug_selector(|| "pane-lead".into())
                .flex_none()
                .flex()
                .items_center()
                .gap(px(look::TOOLWINDOW_TAB_GAP))
                // the tabs' box sits its inset left of the 12 px pad, as the first tab's
                .ml(px(-look::TOOLWINDOW_TAB_BOX_INSET_X))
                .children(tabs)
                .when(own, |d| d.child(sep()))
                // a right-click: the menu of its items, each with its key
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(|_, ev: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        cx.emit(LeadMenuEvent(ev.position));
                    }),
                )
                .into_any_element(),
        )
    }

    /// The title, or the modes' titles side by side (the selected one bold, the others a click
    /// away).
    fn render_title(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let title = || {
            div()
                .flex_none()
                .relative()
                .top(px(look::TOOLWINDOW_TEXT_DY))
                .text_size(px(look::TOOLWINDOW_TITLE_FONT_SIZE))
        };
        if self.modes.is_empty() {
            return title()
                .debug_selector(|| "tool-tabs-title".into())
                .font_weight(FontWeight::BOLD)
                .text_color(look::TOOLWINDOW_TITLE_FG)
                .child(self.title.clone())
                .into_any_element();
        }
        self.modes_painted.borrow_mut().clear();
        let modes = self.modes.iter().enumerate().map(|(ix, label)| {
            let selected = ix == self.mode;
            let name = label.to_string();
            let painted = self.modes_painted.clone();
            let record = canvas(
                move |b, _, _| painted.borrow_mut().push((ix, b)),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full();
            let el = title()
                .id(("tool-mode", ix))
                .debug_selector(move || {
                    if selected {
                        format!("tool-mode-{name}-selected")
                    } else {
                        format!("tool-mode-{name}")
                    }
                })
                .child(record)
                .child(label.clone())
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |_, _: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        cx.emit(ToolModeEvent(ix));
                    }),
                );
            if selected {
                el.font_weight(FontWeight::BOLD)
                    .text_color(look::TOOLWINDOW_TITLE_FG)
            } else {
                el.cursor(CursorStyle::PointingHand)
                    .text_color(look::TOOLWINDOW_TAB_FG)
            }
        });
        div()
            .debug_selector(|| "tool-tabs-title".into())
            .flex_none()
            .flex()
            .items_center()
            .gap(px(look::TOOLWINDOW_TITLE_GAP))
            .children(modes)
            .into_any_element()
    }
}

/// The fitting rule: which tabs (by width) fit in `room` in order, the selected one always;
/// `overflow_w` is kept free for the overflow button when not all fit.
pub fn fit_widths(
    widths: &[f32],
    selected: usize,
    room: f32,
    gap: f32,
    overflow_w: f32,
) -> (Vec<usize>, bool) {
    let total: f32 = widths.iter().map(|w| w + gap).sum();
    if total <= room || widths.is_empty() {
        return ((0..widths.len()).collect(), false);
    }
    let room = room - overflow_w;
    let mut used = widths.get(selected).map_or(0., |w| w + gap);
    let mut shown = vec![selected];
    for (i, &w) in widths.iter().enumerate() {
        if i == selected {
            continue;
        }
        if used + w + gap > room {
            break;
        }
        used += w + gap;
        shown.push(i);
    }
    shown.sort_unstable();
    (shown, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_that_dont_fit_hide_the_selected_stays() {
        let w = [80., 40., 90., 60.];
        assert_eq!(fit_widths(&w, 0, 1000., 4., 30.), (vec![0, 1, 2, 3], false));
        // room for ~2 tabs: the selected (3) + the first that fits in order
        assert_eq!(fit_widths(&w, 3, 200., 4., 30.), (vec![0, 3], true));
        assert_eq!(fit_widths(&w, 1, 120., 4., 30.), (vec![1], true));
    }

    /// A header with no title (the Chat column's Terminal row) starts its first tab's box at
    /// the 12 px padding less its inset (as the pane lead above it), with no empty title gap; a titled one keeps the title and its gap first.
    #[cfg(debug_assertions)]
    #[test]
    fn an_untitled_header_starts_its_first_tab_at_the_padding() {
        use gpui_kit::{TestAppContext, TestDispatcher, VisualTestContext, size};
        let first_tab_x = |title: &'static str| {
            let mut app = TestAppContext::build(TestDispatcher::new(0), None);
            let window = app.open_window(size(px(600.), px(100.)), move |_, _| {
                ToolTabs::new(title, vec![ToolTab::new("Local").closable(true)])
            });
            let mut cx = VisualTestContext::from_window(window.into(), &app);
            cx.run_until_parked();
            let header = cx.debug_bounds("tool-tabs").expect("header drawn");
            let tab = cx.debug_bounds("tool-tab-0").expect("tab drawn");
            (tab.left() - header.left()).as_f32()
        };
        assert_eq!(
            first_tab_x(""),
            look::TOOL_WINDOW_HEADER_PAD_X - look::TOOLWINDOW_TAB_BOX_INSET_X
        );
        assert!(first_tab_x("Terminal") > look::TOOL_WINDOW_HEADER_PAD_X + 40.);
    }
}
