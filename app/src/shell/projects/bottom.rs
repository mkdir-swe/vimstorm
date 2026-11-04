//! The bottom pane from the projects window ([`crate::shell::pane`]): what a tab draws (the
//! window's one `pane` slot view, the bridge's screen opened in it: `sessions`, `boxes`,
//! `pipelines`), the Factory view's pane filling the middle on the rail's Boxes and Pipelines
//! tiles, and the Factory view's Chat column dragged at its left gap (the Editor under the view
//! no longer takes that drag).

use std::path::PathBuf;

use gpui_kit::{
    AnyElement, AppContext as _, Context, CursorStyle, DispatchPhase, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement as _, Pixels, Styled as _, Subscription, Window, canvas, div,
    prelude::FluentBuilder as _, px,
};

use super::{Projects, Workspace};
use crate::factory::{BridgeCommand, FactoryView, Slot, SlotView};
use crate::look;
use crate::shell::layout::{GAP, GRAB, MARGIN};
use crate::shell::pane::{
    FactoryPane, FactoryPaneEvent, MAX_SHARE, MIN_SHARE, PaneContent, PaneTab,
};

/// The projects window's part of the bottom pane.
#[derive(Default)]
pub(super) struct Bottom {
    /// The Factory view's pane, made the first time it shows.
    factory: Option<(Entity<FactoryPane>, Subscription)>,
    /// The bridge's `pane` slot drawn (one for the window: one pane shows at a time).
    slot: Option<Entity<SlotView>>,
    /// The Factory pane's top gap being dragged: where the press was, the share then.
    drag: Option<(Pixels, f32)>,
    /// The Factory view's Chat column's left gap being dragged: where the press was, its width
    /// on screen then.
    column_drag: Option<(Pixels, f32)>,
    /// The Factory pane's last tool window shown.
    pub(super) factory_last: PaneTab,
}

/// While the Factory pane's gap is dragged: the window's mouse moves and the release, wherever
/// they are (over the Board, which takes the mouse, too).
fn drag_listener(cx: &mut Context<Projects>) -> impl IntoElement {
    let me = cx.entity().downgrade();
    canvas(
        |_, _, _| {},
        move |_, _, window, _| {
            let moved = me.clone();
            window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble {
                    let _ = moved.update(cx, |p, cx| p.pane_drag_move(ev, window, cx));
                }
            });
            let up = me.clone();
            window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                if phase == DispatchPhase::Bubble {
                    let _ = up.update(cx, |p, cx| p.pane_drag_end(cx));
                }
            });
        },
    )
    .absolute()
    .size_0()
}

impl Projects {
    /// The shown workspace's pane opened on `tab`: what it draws, handed to it; `shown`: the
    /// pane shown anew (its screen opened again).
    pub(super) fn hand_pane(
        &mut self,
        ws: Entity<Workspace>,
        tab: PaneTab,
        shown: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active() != Some(&ws) {
            return;
        }
        let pane = ws.read(cx).pane().clone();
        let content = self.pane_content(tab, shown, window, cx);
        pane.update(cx, |p, cx| p.set_content(content, cx));
    }

    /// The shown workspace's pane handed its screen again: the `pane` slot is one for the window,
    /// so another workspace's (or the Factory view's) pane may have opened another screen in it.
    pub(super) fn rehand_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ws) = self.active().cloned() else {
            return;
        };
        let (open, tab) = {
            let p = ws.read(cx).pane().read(cx);
            (p.is_open(), p.tab())
        };
        if open && tab.screen().is_some() {
            self.hand_pane(ws, tab, false, window, cx);
        }
    }

    /// What `tab` draws: the `pane` slot with its screen opened (once the bridge can run).
    fn pane_content(
        &mut self,
        tab: PaneTab,
        shown: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> PaneContent {
        let mut content = PaneContent::default();
        let Some(screen) = tab.screen() else {
            return content;
        };
        if !BridgeCommand::available(cx) {
            return content;
        }
        let factory = self.ensure_factory(window, cx);
        factory.update(cx, |v, cx| {
            v.start(window, cx);
            v.open_pane(screen, shown, cx);
        });
        content.slot = Some(self.pane_slot(&factory, window, cx));
        content.factory = Some(factory);
        content
    }

    /// The window's `pane` slot view (made once).
    fn pane_slot(
        &mut self,
        factory: &Entity<FactoryView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<SlotView> {
        if let Some(s) = &self.bottom.slot {
            return s.clone();
        }
        let slot = factory.update(cx, |f, cx| f.slot_view(Slot::Pane, window, cx));
        self.bottom.slot = Some(slot.clone());
        slot
    }

    /// The main checkout of the shown project (the Factory view's Git).
    pub(super) fn main_checkout(&self) -> PathBuf {
        // (Welcome: no project open, home's)
        let dir = self
            .open
            .get(self.active)
            .map_or_else(crate::shell::recent::home, |o| o.dir.clone());
        crate::git::checkout_of(&dir).main
    }

    /// The Factory view's pane (made the first time).
    pub(super) fn factory_pane(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<FactoryPane> {
        if let Some((p, _)) = &self.bottom.factory {
            return p.clone();
        }
        let pane = cx.new(|cx| FactoryPane::new(window, cx));
        let sub = cx.subscribe_in(
            &pane,
            window,
            |p, _, ev: &FactoryPaneEvent, window, cx| match *ev {
                FactoryPaneEvent::Show(tab) => p.show_factory_pane(tab, window, cx),
                FactoryPaneEvent::Hide => p.hide_factory_pane(window, cx),
                FactoryPaneEvent::Leave => p.factory_keys_back(window, cx),
            },
        );
        self.bottom.factory = Some((pane.clone(), sub));
        pane
    }

    /// The Factory view's pane, when made (tests).
    pub fn factory_pane_view(&self) -> Option<&Entity<FactoryPane>> {
        self.bottom.factory.as_ref().map(|(p, _)| p)
    }

    /// The Factory view's pane on `tab`, with the keyboard.
    pub(super) fn show_factory_pane(
        &mut self,
        tab: PaneTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Git is a workspace's: not on the Board
        if tab == PaneTab::Git {
            return;
        }
        self.bottom.factory_last = tab;
        let pane = self.factory_pane(window, cx);
        let content = self.pane_content(tab, false, window, cx);
        pane.update(cx, |p, cx| {
            p.set_tab(Some(tab), cx);
            p.set_content(content, cx);
        });
        window.focus(&pane.focus_handle(cx), cx);
        cx.notify();
    }

    fn hide_factory_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.factory_pane_view().cloned() else {
            return;
        };
        let had = pane.read(cx).has_keyboard(window, cx);
        pane.update(cx, |p, cx| p.set_tab(None, cx));
        if had {
            self.factory_keys_back(window, cx);
        }
        cx.notify();
    }

    /// Esc in the Factory pane (or it hid with the keys): the Board has them again.
    fn factory_keys_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Boxes or Pipelines: the list is all the middle shows (never the Board under it): Chat
        // takes the keys when it is shown, else the list keeps them
        if self.pane_place.is_some() {
            if crate::shell::column::state(cx).shown() {
                self.rail_chat_keys(window, cx);
            }
            cx.notify();
            return;
        }
        if let Some(view) = self.factory().cloned() {
            window.focus(&view.focus_handle(cx), cx);
        }
        cx.notify();
    }

    /// The Factory view's pane as drawn under the Board: the room it takes off the body and
    /// its island (with the drag strip on its top gap); none while hidden (the stripe picks).
    /// Boxes or Pipelines filling the middle: the Factory view's pane right of the rail, under
    /// the header's row, left of the Chat column (`column_room`); none while it shows no tab.
    pub(super) fn factory_pane_element(
        &mut self,
        column_room: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let pane = self.factory_pane(window, cx);
        pane.read(cx).tab()?;
        Some(
            div()
                .debug_selector(|| "factory-pane-place".into())
                .absolute()
                .left(px(crate::shell::projects::RAIL_WIDTH))
                .right(px(MARGIN + column_room))
                .top(px(look::TOOLBAR_HEIGHT.get() + look::TAB_HEIGHT))
                .bottom(px(look::STATUS_BAR_HEIGHT + MARGIN))
                // the hidden Board under it gets no hover or scroll
                .occlude()
                .child(pane.clone())
                .into_any_element(),
        )
    }

    /// The Factory view's Chat column's left gap, as the Editor's: a strip over the gap that drags
    /// its width (320–640, the Board keeping its least room); none while it isn't drawn.
    pub(super) fn factory_column_gap(&mut self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("factory-column-gap")
            .debug_selector(|| "factory-column-gap".into())
            .absolute()
            .top(px(look::TOOLBAR_HEIGHT.get() + look::TAB_HEIGHT))
            .bottom(px(look::STATUS_BAR_HEIGHT.get() + MARGIN))
            .right(px(MARGIN + width - GRAB))
            .w(px(GAP + 2. * GRAB))
            .cursor(CursorStyle::ResizeColumn)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |p, ev: &MouseDownEvent, _, cx| {
                    p.bottom.column_drag = Some((ev.position.x, width));
                    cx.stop_propagation();
                    cx.notify();
                }),
            )
            .when(self.bottom.column_drag.is_some(), |d| {
                d.child(drag_listener(cx))
            })
            .into_any_element()
    }

    /// The Factory pane's gap dragged: its share of the body follows the mouse (or the Chat
    /// column's: its width).
    fn pane_drag_move(&mut self, ev: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((start, width)) = self.bottom.column_drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                self.pane_drag_end(cx);
                return;
            }
            let want = width - f32::from(ev.position.x - start);
            let full = f32::from(window.viewport_size().width) - 2. * MARGIN;
            let w = crate::shell::layout::Frame::chat_width_for(want, full);
            crate::shell::column::set_state(cx, |s| s.width = w);
            cx.notify();
            return;
        }
        let Some((start, share)) = self.bottom.drag else {
            return;
        };
        if ev.pressed_button != Some(MouseButton::Left) {
            self.bottom.drag = None;
            return;
        }
        let Some(pane) = self.factory_pane_view().cloned() else {
            return;
        };
        let body = f32::from(window.viewport_size().height)
            - look::TOOLBAR_HEIGHT
            - look::STATUS_BAR_HEIGHT;
        let want = share - f32::from(ev.position.y - start) / body.max(1.);
        pane.update(cx, |p, cx| {
            p.share = want.clamp(MIN_SHARE, MAX_SHARE);
            cx.notify();
        });
        cx.notify();
    }

    fn pane_drag_end(&mut self, cx: &mut Context<Self>) {
        self.bottom.drag = None;
        if self.bottom.column_drag.take().is_some() {
            // the column's width for the next launch, as the Editor's gap keeps it
            let width = crate::shell::column::state(cx).width;
            crate::shell::column::save_width(width, super::state_home(cx), cx);
        }
        cx.notify();
    }
}
