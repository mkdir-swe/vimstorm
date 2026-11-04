//! The stripe (boards ST-*): WebStorm's tool window stripe at Welcome's left edge (a project
//! window has the rail instead, [`super::rail`]). The bridge sends its items
//! (`abe/packages/ui/src/shell/stripe.ts`, the one list): the top group's places then ⋯, the
//! bottom group's tool windows. The picked item is a filled accent square, a dot means news
//! (needs you, failed, running), the tooltip the name, its key and what the dot means.
//!
//! What it draws ([`shown`]) and its menu ([`menu_rows`]) are the TS side's `stripeAt` /
//! `stripeMenu`, checked against the contract's `stripe/*.json` (`tests/stripe.rs`).

use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Pixels,
    Point, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use crate::factory::{FactoryShell, StripeDot, StripeGroup, StripeItem};
use crate::kit::{Icon, IconName};
use crate::look;
use crate::popups::{MenuEntry, MenuItem};

/// The stripe's width at the window's left edge: the islands start right of it.
pub const STRIPE_WIDTH: f32 = 40.;
/// A button: a 30 px square, 6 px apart (ST-Editor).
const BUTTON: f32 = 30.;
const BUTTON_GAP: f32 = 6.;
const DOT: f32 = 6.;

/// What the main area shows: the code (Project), the Board, or the workspace's Run.
/// Each workspace keeps its own ([`Projects`]' pages, by slug in `workspace-pages.json`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Place {
    #[default]
    Project,
    Board,
    Run,
}

impl Place {
    pub fn slug(self) -> &'static str {
        match self {
            Place::Project => "project",
            Place::Board => "board",
            Place::Run => "run",
        }
    }

    pub fn parse(id: &str) -> Option<Place> {
        [Place::Project, Place::Board, Place::Run]
            .into_iter()
            .find(|p| p.slug() == id)
    }

    /// The main area is a workspace's (the code, or its Run): Run, Terminal and Git show.
    pub fn in_workspace(self) -> bool {
        matches!(self, Place::Project | Place::Run)
    }
}

/// One drawn button (the contract's `stripe/*.json` rows).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Drawn {
    pub id: String,
    pub icon: String,
    #[serde(default)]
    pub picked: bool,
    #[serde(default)]
    pub dot: Option<StripeDot>,
    pub tooltip: String,
}

/// What the stripe draws: the top group (⋯ last), the bottom group.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Shown {
    pub top: Vec<Drawn>,
    pub bottom: Vec<Drawn>,
}

/// The stripe at `place` with the bottom tool window `pane` shown: the items not hidden (the
/// workspace's only in one), by group, the place and the pane picked; ⋯ last in the top group.
pub fn shown(items: &[StripeItem], place: Place, pane: Option<&str>) -> Shown {
    let here = place.in_workspace();
    let group = |g: StripeGroup| {
        items
            .iter()
            .filter(|i| i.group == g && !i.hidden && (here || !i.workspace_only))
            .map(|i| Drawn {
                id: i.id.clone(),
                icon: i.icon.clone(),
                picked: i.id == place.slug() || Some(i.id.as_str()) == pane,
                dot: i.dot,
                tooltip: i.tooltip.clone(),
            })
            .collect::<Vec<_>>()
    };
    let mut top = group(StripeGroup::Top);
    top.push(Drawn {
        id: "more".into(),
        icon: "more".into(),
        picked: false,
        dot: None,
        tooltip: "More tool windows".into(),
    });
    Shown {
        top,
        bottom: group(StripeGroup::Bottom),
    }
}

/// A row of the right-click menu (the contract's `stripe/menu-*.json`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Row {
    Toggle {
        id: String,
        label: String,
        on: bool,
        enabled: bool,
    },
    Separator,
    Info {
        text: String,
    },
    Action {
        action: String,
        label: String,
        #[serde(default)]
        id: Option<String>,
    },
}

impl Row {
    /// The bridge's click for a choice (`widget:stripe-menu:toggle:git`, `…:reset`).
    pub fn click(&self) -> Option<String> {
        match self {
            Row::Toggle { id, enabled, .. } => {
                enabled.then(|| format!("widget:stripe-menu:toggle:{id}"))
            }
            Row::Action { action, id, .. } => Some(match id {
                Some(id) => format!("widget:stripe-menu:{action}:{id}"),
                None => format!("widget:stripe-menu:{action}"),
            }),
            Row::Separator | Row::Info { .. } => None,
        }
    }

    /// The menu's entry for it: a ticked item for a shown one, greyed outside a workspace.
    pub fn entry(&self) -> MenuEntry {
        match self {
            Row::Toggle {
                label, on, enabled, ..
            } => {
                let item = MenuItem::new(label.clone()).enabled(*enabled);
                if *on {
                    item.icon(IconName::Checked).into()
                } else {
                    item.into()
                }
            }
            Row::Separator => MenuEntry::Separator,
            Row::Info { text } => MenuEntry::Info(text.clone().into()),
            Row::Action { label, .. } => MenuItem::new(label.clone()).into(),
        }
    }
}

/// The right-click menu (on item `at`, or ⋯): show or hide each item by group, the workspace's
/// under "In a workspace" (greyed "Only in a workspace" elsewhere), then moving `at` to the other
/// group, then Reset the Stripe.
pub fn menu_rows(items: &[StripeItem], here: bool, at: Option<&str>) -> Vec<Row> {
    let toggle = |i: &StripeItem, enabled: bool| Row::Toggle {
        id: i.id.clone(),
        label: i.label.clone(),
        on: !i.hidden,
        enabled,
    };
    let mut rows = Vec::new();
    for g in [StripeGroup::Top, StripeGroup::Bottom] {
        let section: Vec<Row> = items
            .iter()
            .filter(|i| !i.workspace_only && i.group == g)
            .map(|i| toggle(i, true))
            .collect();
        if section.is_empty() {
            continue;
        }
        if !rows.is_empty() {
            rows.push(Row::Separator);
        }
        rows.extend(section);
    }
    let workspace: Vec<&StripeItem> = items.iter().filter(|i| i.workspace_only).collect();
    if !workspace.is_empty() {
        rows.push(Row::Separator);
        rows.push(Row::Info {
            text: if here {
                "In a workspace"
            } else {
                "Only in a workspace"
            }
            .into(),
        });
        rows.extend(workspace.into_iter().map(|i| toggle(i, here)));
    }
    rows.push(Row::Separator);
    if let Some(on) = items
        .iter()
        .find(|i| Some(i.id.as_str()) == at)
        .filter(|i| here || !i.workspace_only)
    {
        rows.push(match on.group {
            StripeGroup::Top => Row::Action {
                action: "bottom".into(),
                label: "Move to Bottom Group".into(),
                id: Some(on.id.clone()),
            },
            StripeGroup::Bottom => Row::Action {
                action: "top".into(),
                label: "Move to Top Group".into(),
                id: Some(on.id.clone()),
            },
        });
    }
    rows.push(Row::Action {
        action: "reset".into(),
        label: "Reset the Stripe".into(),
        id: None,
    });
    rows
}

/// An icon by the bridge's name.
pub fn icon_named(name: &str) -> IconName {
    match name {
        "project" => IconName::ToolWindowProject,
        "board" => IconName::StripeBoard,
        "run-path" => IconName::StripeRunPath,
        "history" => IconName::History,
        "archive" => IconName::Archive,
        "run" => IconName::ToolWindowRun,
        "preview" => IconName::EditorPreview,
        "terminal" => IconName::ToolWindowTerminal,
        "vcs" => IconName::ToolWindowVcs,
        _ => IconName::MoreHorizontal,
    }
}

/// A dot's colour: needs you teal, failed red, running amber.
pub fn dot_color(dot: StripeDot) -> gpui_kit::Rgba {
    match dot {
        StripeDot::NeedsYou => look::ABE_NEEDS_YOU.rgba(),
        StripeDot::Failed => look::ABE_BAD.rgba(),
        StripeDot::Running => look::ABE_WARN.rgba(),
    }
}

type OnClick = Rc<dyn Fn(&str, Point<Pixels>, &mut Window, &mut App)>;
type OnMenu = Rc<dyn Fn(Option<&str>, Point<Pixels>, &mut Window, &mut App)>;

fn button(d: &Drawn, click: OnClick, menu: OnMenu) -> AnyElement {
    let id = d.id.clone();
    let (cid, mid) = (id.clone(), id.clone());
    let selector = format!("stripe-{id}");
    div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector.clone())
        .relative()
        .flex_none()
        .w(px(BUTTON))
        .h(px(BUTTON))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .when(d.picked, |b| {
            let id = id.clone();
            b.bg(look::BUTTON_PRIMARY_BG).child(
                div()
                    .debug_selector(move || format!("stripe-picked-{id}"))
                    .absolute()
                    .size_0(),
            )
        })
        .when(!d.picked, |b| b.hover(|s| s.bg(look::TAB_HOVER_BG)))
        .tooltip(crate::kit::tooltip(d.tooltip.clone(), None))
        .child(Icon::new(icon_named(&d.icon)))
        .when_some(d.dot, |b, dot| {
            let id = id.clone();
            b.child(
                div()
                    .debug_selector(move || format!("stripe-dot-{id}"))
                    .absolute()
                    .top(px(3.))
                    .right(px(3.))
                    .w(px(DOT))
                    .h(px(DOT))
                    .rounded(px(DOT / 2.))
                    .bg(dot_color(dot))
                    .border(px(1.5))
                    .border_color(crate::shell::layout::FRAME_BG),
            )
        })
        .on_mouse_down(MouseButton::Left, move |ev, window, cx| {
            cx.stop_propagation();
            click(&cid, ev.position, window, cx);
        })
        .on_mouse_down(MouseButton::Right, move |ev, window, cx| {
            cx.stop_propagation();
            menu(Some(&mid), ev.position, window, cx);
        })
        .into_any_element()
}

/// The stripe filling its parent (the window's left edge, under the workspace strip): the top
/// group from the top, the bottom group from the bottom. `click(id, at)` runs an item;
/// `menu(item, at)` opens the right-click menu (on the empty room: no item).
pub fn render(
    shown: &Shown,
    click: impl Fn(&str, Point<Pixels>, &mut Window, &mut App) + 'static,
    menu: impl Fn(Option<&str>, Point<Pixels>, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let click: OnClick = Rc::new(click);
    let menu: OnMenu = Rc::new(menu);
    let group = |items: &[Drawn], name: &'static str| {
        div()
            .debug_selector(move || format!("stripe-{name}"))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(BUTTON_GAP))
            .children(items.iter().map(|d| button(d, click.clone(), menu.clone())))
    };
    let empty = menu.clone();
    div()
        .id("stripe")
        .debug_selector(|| "stripe".into())
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_between()
        .py(px(4.))
        .bg(crate::shell::layout::FRAME_BG)
        .occlude()
        .child(group(&shown.top, "top"))
        .child(group(&shown.bottom, "bottom"))
        .on_mouse_down(MouseButton::Right, move |ev, window, cx| {
            cx.stop_propagation();
            empty(None, ev.position, window, cx);
        })
        .into_any_element()
}

/// The stripe's items as the bridge sent them, its dots' words added (Welcome's stripe).
pub(super) fn items(cx: &gpui_kit::App) -> Vec<StripeItem> {
    let Some(shell) = cx.try_global::<FactoryShell>() else {
        return Vec::new();
    };
    shell
        .stripe
        .iter()
        .cloned()
        .map(|mut i| {
            if let Some(d) = shell.stripe_dots.iter().find(|d| d.id == i.id) {
                i.dot = d.dot;
                if let Some(words) = &d.words {
                    i.tooltip = format!("{} · {words}", i.tooltip);
                }
            }
            i
        })
        .collect()
}
