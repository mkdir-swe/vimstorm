//! The Log's Branches pane (WebStorm's branches dashboard in the Git Log,
//! `git4idea/ui/branch/dashboard/BranchesInGitLogUiFactoryProvider.kt`; Lua `git/branches.lua`).
//!
//! Collapsed (the default): the vertical "Branches" strip on the Log's left
//! ([`CollapsedStripe`]); a click expands it. Expanded: WS's vertical toolbar in the strip's
//! place (Hide Branches chevron at the top, Expand All / Collapse All), then the branches tree
//! ([`list::BranchesList`]: HEAD, Local, Remote → origin, Tags, names grouped by directory) and a
//! one-pixel splitter to the log (the width is kept while the tab lives).
//!
//! A click / Enter on a branch, tag or HEAD filters the log by it (WS "Filter Log by Branch on
//! selection"). Right-click / Cmd+Enter: Checkout (confirmed like Lua's `branches.checkout`:
//! remote → a local tracking branch, tag → detached), Show in Log, Expand All / Collapse All,
//! Hide Branches. Esc / Tab: back to the commit table.
//!
//! [`LogTab::reload_branches`] refreshes the refs (`git for-each-ref` off the UI thread) on every
//! repo change; the Branch filter popup reads them from [`BranchesUi::refs`].

#[path = "branches_list.rs"]
pub mod list;
#[path = "branches_tree.rs"]
pub mod tree;

use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, CursorStyle, DispatchPhase, Entity, Focusable as _,
    HitboxBehavior, InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Styled as _, Subscription, Task,
    Window, canvas, div, px,
};

use super::LogTab;
use crate::git::branches::{self as gbranches, FilterRefs, Target};
use crate::git::log::BranchFilter;
use crate::kit::Anchor;
use crate::kit::IconName;
use crate::kit::ListView;
use crate::kit::{Axis, IconButton, toolbar, toolbar_separator};
use crate::kit::{CollapsedStripe, VerticalLabel};
use crate::look;
use crate::popups::{self, Balloon, Menu, MenuEntry, MenuItem};
use list::{BranchesEvent, BranchesList};
use tree::{RefInfo, RefKind};

/// The tree's default width (own: WS opens it at 30 % of the log, ~240 px in 30.png's window).
const PANE_WIDTH: f32 = 240.;
/// Narrowest tree (own; the splitter's minimum pane is too narrow for branch names).
const PANE_MIN: f32 = 120.;
/// The tree takes at most this share of the window's width (the log keeps the rest).
const PANE_MAX_SHARE: f32 = 0.6;

pub struct BranchesUi {
    pub open: bool,
    /// Local / remote branches and tags (`branches::filter_refs_blocking`), reloaded with the
    /// log: the pane and the Branch filter popup list them.
    pub refs: Option<Rc<FilterRefs>>,
    pub list: Entity<ListView<BranchesList>>,
    /// The tree's width (kept while the tab lives).
    width: Pixels,
    /// Splitter drag: the mouse x and the width when it started.
    drag: Option<(Pixels, Pixels)>,
    load_gen: u64,
    load_task: Option<Task<()>>,
    _sub: Subscription,
}

impl BranchesUi {
    pub fn new(window: &mut Window, cx: &mut Context<LogTab>) -> Self {
        let list = cx.new(|cx| ListView::new(BranchesList::new(), cx));
        let sub = cx.subscribe_in(
            &list,
            window,
            |t: &mut LogTab, _, ev: &BranchesEvent, window, cx| t.on_branches_event(ev, window, cx),
        );
        BranchesUi {
            // shots of the expanded pane (`--features shots`)
            open: cfg!(feature = "shots") && std::env::var_os("VIMSTORM_SHOT_BRANCHES").is_some(),
            refs: None,
            list,
            width: px(PANE_WIDTH),
            drag: None,
            load_gen: 0,
            load_task: None,
            _sub: sub,
        }
    }
}

impl LogTab {
    pub(super) fn render_branches(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let this = cx.entity().downgrade();
        if !self.branches.open {
            return CollapsedStripe::new("git-log-branches", VerticalLabel::Branches)
                .on_expand(move |_, window, cx| {
                    let _ = this.update(cx, |t, cx| t.set_branches_open(true, true, window, cx));
                })
                .into_any_element();
        }
        // WS: the vertical toolbar replaces the collapsed strip (ExpandablePanelController)
        let button = |id: &'static str, icon: IconName, tip: &'static str, open: Option<bool>| {
            let this = this.clone();
            IconButton::new(id, icon)
                .tooltip(tip, None)
                .on_click(move |_, window, cx| {
                    let _ = this.update(cx, |t, cx| match open {
                        None => t.set_branches_open(false, false, window, cx),
                        Some(open) => t.branches_set_all_open(open, cx),
                    });
                })
        };
        let bar = div()
            .flex_none()
            .h_full()
            .w(px(look::STRIPE_WIDTH))
            .flex()
            .flex_col()
            .items_center()
            .pt(px(look::STRIPE_PAD_TOP))
            .child(
                toolbar(Axis::Vertical)
                    .child(button(
                        "git-log-branches-hide",
                        IconName::ChevronLeft,
                        "Hide Branches",
                        None,
                    ))
                    .child(toolbar_separator(Axis::Vertical))
                    .child(button(
                        "git-log-branches-expand-all",
                        IconName::ExpandAll,
                        "Expand All",
                        Some(true),
                    ))
                    .child(button(
                        "git-log-branches-collapse-all",
                        IconName::CollapseAll,
                        "Collapse All",
                        Some(false),
                    )),
            );
        let grab = px(look::SPLITTER_GRAB);
        let handle = div()
            .id("git-log-branches-divider")
            .debug_selector(|| "git-log-branches-divider".into())
            .absolute()
            .top_0()
            .bottom_0()
            .right(-grab / 2.)
            .w(grab + px(look::SEPARATOR_WIDTH))
            .cursor(CursorStyle::ResizeColumn)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|t, ev: &MouseDownEvent, _, cx| {
                    t.branches.drag = Some((ev.position.x, t.branches.width));
                    cx.stop_propagation();
                    cx.notify();
                }),
            );
        let drag = self.branches.drag.is_some().then(|| {
            let (mv, up) = (this.clone(), this.clone());
            canvas(
                |bounds, window, _| window.insert_hitbox(bounds, HitboxBehavior::Normal),
                move |_, _, window, _| {
                    window.on_mouse_event(move |ev: &MouseMoveEvent, phase, window, cx| {
                        if phase == DispatchPhase::Capture {
                            let max = window.viewport_size().width * PANE_MAX_SHARE;
                            let _ = mv.update(cx, |t, cx| t.drag_branches(ev.position.x, max, cx));
                        }
                    });
                    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = up.update(cx, |t, cx| {
                                t.branches.drag = None;
                                cx.notify();
                            });
                        }
                    });
                },
            )
            .absolute()
            .size_full()
        });
        let max = window.viewport_size().width * PANE_MAX_SHARE;
        let width = self.branches.width.min(max).max(px(PANE_MIN));
        let tree = div()
            .id("git-log-branches-pane")
            .debug_selector(|| "git-log-branches-pane".into())
            .relative()
            .flex_none()
            .h_full()
            .w(width)
            // WS: the tree panel's left border, then the OnePixelSplitter's line
            .border_l_1()
            .border_r_1()
            .border_color(look::SPLITTER_LINE)
            .child(
                div()
                    .size_full()
                    .pt(px(look::TREE_PAD_Y.get()))
                    .child(self.branches.list.clone()),
            )
            .child(handle);
        div()
            .flex_none()
            .h_full()
            .flex()
            .flex_row()
            .child(bar)
            .child(tree)
            .children(drag)
            .into_any_element()
    }

    fn drag_branches(&mut self, x: Pixels, max: Pixels, cx: &mut Context<Self>) {
        let Some((start, width)) = self.branches.drag else {
            return;
        };
        self.branches.width = (width + (x - start)).min(max).max(px(PANE_MIN));
        cx.notify();
    }

    /// Refs may have moved: the pane / filter lists reload.
    pub(super) fn reload_branches(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        self.branches.load_gen += 1;
        let generation = self.branches.load_gen;
        let task = crate::git::job::spawn(cx, move || gbranches::filter_refs_blocking(&root));
        self.branches.load_task = Some(cx.spawn(async move |this, cx| {
            let refs = task.await;
            let _ = this.update(cx, |t, cx| {
                // a newer load is on its way
                if t.branches.load_gen != generation {
                    return;
                }
                match refs {
                    Ok(refs) => t.set_branch_refs(refs, cx),
                    Err(e) => eprintln!("[vimstorm] git branches: {e:#}"),
                }
            });
        }));
    }

    fn set_branch_refs(&mut self, refs: FilterRefs, cx: &mut Context<Self>) {
        if self.branches.refs.as_deref() == Some(&refs) {
            return;
        }
        self.branches.list.update(cx, |l, cx| {
            let ListView {
                delegate, state, ..
            } = l;
            delegate.set_refs(&refs, state);
            cx.notify();
        });
        self.branches.refs = Some(Rc::new(refs));
        cx.notify();
    }

    /// Expands (`focus`: the tree takes the keyboard) / collapses the pane (the table gets the
    /// keyboard back if the tree had it).
    pub fn set_branches_open(
        &mut self,
        open: bool,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let had_focus = self.branches_focused(window, cx);
        self.branches.open = open;
        if open && focus {
            let handle = self.branches.list.focus_handle(cx);
            window.focus(&handle, cx);
        } else if !open && had_focus {
            self.focus_table(window, cx);
        }
        cx.notify();
    }

    fn branches_set_all_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.branches.list.update(cx, |l, cx| {
            let ListView {
                delegate, state, ..
            } = l;
            delegate.set_all_open(open, state);
            cx.notify();
        });
    }

    fn on_branches_event(
        &mut self,
        ev: &BranchesEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            BranchesEvent::Show(target) => self.show_branch(target.clone(), cx),
            BranchesEvent::Checkout(r, anchor) => {
                self.confirm_checkout(r.clone(), *anchor, window, cx)
            }
            BranchesEvent::ContextMenu(anchor) => self.branches_menu(*anchor, window, cx),
            BranchesEvent::Back => self.focus_table(window, cx),
            BranchesEvent::LogKey(key) => match key.as_str() {
                "g?" => popups::notify(popups::Balloon::info("Git", super::HELP), window, cx),
                _ => {
                    self.common_key(key, window, cx);
                }
            },
        }
    }

    /// The log filtered by a branch / tag (None: HEAD).
    fn show_branch(&mut self, target: Option<String>, cx: &mut Context<Self>) {
        let branch = target.map_or(BranchFilter::Head, BranchFilter::Ref);
        self.update_filters(|f| f.branch = branch, cx);
    }

    /// The pane's menu for the cursor row.
    fn branches_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let (target, info) = {
            let l = self.branches.list.read(cx);
            let c = l.state.cursor();
            (
                c.and_then(|c| l.delegate.target(c)),
                c.and_then(|c| l.delegate.rows[c].ref_info().cloned()),
            )
        };
        let can_checkout = info.as_ref().is_some_and(|r| !r.current);
        let entries: Vec<MenuEntry> = vec![
            MenuItem::new("Checkout")
                .shortcut("c")
                .enabled(can_checkout)
                .into(),
            MenuItem::new("Show in Log")
                .shortcut("⏎")
                .enabled(target.is_some())
                .into(),
            MenuEntry::Separator,
            MenuItem::new("Expand All").icon(IconName::ExpandAll).into(),
            MenuItem::new("Collapse All")
                .icon(IconName::CollapseAll)
                .into(),
            MenuEntry::Separator,
            MenuItem::new("Hide Branches").into(),
        ];
        let this = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let _ = this.update(cx, |t, cx| match choice {
                    Some(0) => {
                        if let Some(r) = info {
                            t.confirm_checkout(r, anchor, window, cx);
                        }
                    }
                    Some(1) => {
                        if let Some(target) = target {
                            t.show_branch(target, cx);
                        }
                    }
                    Some(3) => t.branches_set_all_open(true, cx),
                    Some(4) => t.branches_set_all_open(false, cx),
                    Some(6) => t.set_branches_open(false, false, window, cx),
                    _ => {}
                });
            },
        );
    }

    /// Checkout after confirming (Lua `branches.checkout`: nothing for the current branch).
    fn confirm_checkout(
        &mut self,
        r: RefInfo,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if r.current {
            return;
        }
        let menu = Menu::new(
            vec![
                MenuItem::new("Checkout").into(),
                MenuItem::new("Cancel").into(),
            ],
            anchor,
        )
        .title(format!("Checkout {}?", r.name));
        let this = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, window, cx| {
            if choice == Some(0) {
                let _ = this.update(cx, |t, cx| t.checkout_ref(r, window, cx));
            }
        });
    }

    /// Runs the checkout off the UI thread; a balloon tells the result, Lua refreshes the views.
    fn checkout_ref(&mut self, r: RefInfo, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        let local: Vec<String> = self
            .branches
            .refs
            .as_ref()
            .map(|r| r.local.clone())
            .unwrap_or_default();
        let task = crate::git::job::spawn(cx, move || match r.kind {
            RefKind::Local => gbranches::checkout_blocking(&root, &Target::Local(r.name), &local),
            RefKind::Remote => gbranches::checkout_blocking(&root, &Target::Remote(r.name), &local),
            RefKind::Tag => {
                let o = crate::git::ops::checkout_tag_blocking(&root, &r.name);
                if o.ok { Ok(o.message) } else { Err(o.message) }
            }
        });
        let scx = self.gcx.scx.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = cx.update(|window, cx| {
                let balloon = match result {
                    Ok(msg) => Balloon::info("Git", msg),
                    Err(err) => Balloon::error("git switch", err),
                };
                scx.notify(balloon, window, cx);
                // buffers reload, GitView / status bar / gutters refresh (checktime +
                // git.cli.changed, as Lua's `cli.act`)
                crate::git::window::changes::lua_changed(&scx);
                let _ = this.update(cx, |t, cx| t.reload_branches(cx));
            });
        })
        .detach();
    }

    // ---- for tests ----------------------------------------------------------------------------

    /// The pane is expanded.
    pub fn branches_open(&self) -> bool {
        self.branches.open
    }

    /// The refs the pane and the Branch filter list.
    pub fn branch_refs(&self) -> Option<Rc<FilterRefs>> {
        self.branches.refs.clone()
    }

    /// The tree's rows: two spaces per level, then the label.
    pub fn branch_rows(&self, cx: &App) -> Vec<String> {
        self.branches
            .list
            .read(cx)
            .delegate
            .rows
            .iter()
            .map(|r| format!("{}{}", "  ".repeat(r.depth), r.label))
            .collect()
    }

    /// The tree's cursor row.
    pub fn branch_cursor(&self, cx: &App) -> Option<usize> {
        self.branches.list.read(cx).state.cursor()
    }

    /// The tree has the keyboard.
    pub fn branches_focused(&self, window: &Window, cx: &App) -> bool {
        self.branches
            .list
            .read(cx)
            .focus_handle(cx)
            .contains_focused(window, cx)
    }
}
