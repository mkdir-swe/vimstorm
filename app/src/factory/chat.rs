//! Chat's components, the Rust half of `abe/packages/ui/src/chat/terminal.ts`: the
//! Terminal (a [`super::terminal::TermView`] by its key) and ChatHeader (DS 2.0 ChatView: the 31 px
//! header, `Chat` and the card's short name, Hide; the 28 px quiet row, the lane, the state, the
//! environment, `N subagents`, `+ my skills` and its buttons; under it one dim `note` line, the
//! `A hard one · :improve-retro me`); with a `story`, 2.1's header (B Signal, boards R-Anatomy,
//! H-States): the `Chat | Terminal` tool header with ⋮ and ×, `#2 <title>` with its box's cloud or
//! `Local sandbox` and `⌘⏎`, the rail line (Needs you purple with ◆), an override's warn row.
//! Props in, pixels out.

use std::collections::BTreeMap;

use gpui_kit::{
    AnyElement, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::board::{Segment, segments};
use super::draw::{Drawn, agent_color, clickable, selector};
use super::protocol::AgentState;
use crate::kit::{Icon, IconName};
use crate::look;

/// The quiet row's height (DS ChatView: 28).
const QUIET_HEIGHT: f32 = 28.;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProps {
    pub key: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub screen_keys: Vec<String>,
    /// Rows that are links: ⌘-click on a row matching `pattern` is a click on `click`.
    #[serde(default)]
    pub links: Vec<TerminalLink>,
}

/// A terminal row's link: a regex on the row's text, the click id it names (`$1`: its first
/// group, trimmed).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TerminalLink {
    pub pattern: String,
    pub click: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatHeaderProps {
    pub title: String,
    pub env: Option<String>,
    pub subagents: Option<u64>,
    pub hide: Option<String>,
    /// One dim line under the quiet row: a suggestion that opens nothing.
    pub note: Option<String>,
    /// 2.1 (B Signal): with a story the header draws [`signal`]'s look.
    pub story: Option<Story>,
    #[serde(default)]
    pub modes: Vec<ChatMode>,
    pub mode: Option<String>,
    pub menu: Option<String>,
    #[serde(rename = "box")]
    pub cloud: Option<ChatBox>,
    pub hint: Option<String>,
    /// Line 2's first words as a link (a prototype chat's proxy address, a click shows its
    /// page), before the rail's stage.
    pub address: Option<ChatAddress>,
    pub rail: Option<ChatRail>,
    #[serde(rename = "override")]
    pub overridden: Option<String>,
    /// Your settings Overrides the run launched under: a pill on the story line.
    pub pill: Option<ChatPill>,
    /// The Abe chat: Abe's face before the story, `Abe · <repo>`.
    #[serde(default)]
    pub face: bool,
    /// The Abe chat's conversations, a tab row under the header; `add`: its `+`.
    #[serde(default)]
    pub tabs: Vec<ChatTab>,
    pub add: Option<String>,
}

/// One Abe chat conversation's tab: a click names `id`, its × `close`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatTab {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub selected: bool,
    pub mark: Option<TabMark>,
    pub close: String,
}

/// A tab's mark: it works (a dot), or asks you (◆: a question or a dialog only).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TabMark {
    Working,
    NeedsYou,
}

/// A link on the header's line 2: its words and the id a click names.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatAddress {
    pub id: String,
    pub text: String,
}

/// `Override · autoMerge on`, its tooltip why and since when.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatPill {
    pub text: String,
    pub tooltip: Option<String>,
}

/// `#2` and the story's title.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Story {
    pub id: String,
    pub title: String,
}

/// Chat mode or Terminal mode's tab; `needs_you`: ◆ on it while hidden.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMode {
    pub id: String,
    pub label: String,
    pub tooltip: Option<String>,
    #[serde(default)]
    pub needs_you: bool,
}

/// A box's state: its cloud filled (running), outlined (asleep) or dashed (starting).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxState {
    Running,
    Asleep,
    Starting,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatBox {
    pub name: String,
    pub state: BoxState,
}

/// The header's second line: the rail, the stage, the state word, the time in it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatRail {
    pub segments: Vec<Segment>,
    pub stage: String,
    pub state: AgentState,
    /// The state's glyph, as TS's Board look has it (ADR 0013: TS says what it is).
    pub glyph: String,
    pub word: String,
    pub elapsed: Option<String>,
}

/// The terminal under the node's key, filling its place.
pub fn terminal(id: Option<&str>, p: &TerminalProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("Terminal", p.key.clone());
    let sel = selector("Terminal", ix, id);
    let view = drawn.terms.get(&p.key).cloned();
    div()
        .debug_selector(move || sel)
        .size_full()
        .min_h_0()
        .overflow_hidden()
        .rounded_b(px(look::ISLAND_ARC.get()))
        .bg(gpui_kit::rgb(crate::terminal::palette().background))
        .children(view)
        .into_any_element()
}

fn dim(text: impl Into<SharedString>) -> gpui_kit::Div {
    div()
        .flex_none()
        .whitespace_nowrap()
        .text_color(look::TEXT_DIM)
        .child(text.into())
}

pub fn header(id: Option<&str>, p: &ChatHeaderProps, drawn: &mut Drawn) -> AnyElement {
    let ix = drawn.add("ChatHeader", p.title.clone());
    let sel = selector("ChatHeader", ix, id);
    if let Some(story) = &p.story {
        return signal(id, sel, story, p, drawn);
    }
    let top = div()
        .flex_none()
        .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.))
        .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .pr(px(6.))
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
        .child(div().flex_1())
        .when_some(p.hide.clone(), |d, hide| {
            let b = div()
                .id(SharedString::from(format!("factory-node-{hide}")))
                .debug_selector({
                    let hide = hide.clone();
                    move || format!("factory-node-{hide}")
                })
                .flex_none()
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .hover(|s| s.bg(look::HOVER_BG))
                .tooltip(crate::kit::tooltip("Hide", Some("⌥⌘2")))
                .child(Icon::new(IconName::Hide));
            d.child(clickable(b, Some(&hide), drawn))
        });
    // the quiet row: where it runs at the left, its subagents at the right (wrapped under, never
    // cut, when both do not fit)
    let words = div()
        .flex_none()
        .max_w_full()
        .min_w_0()
        .h(px(QUIET_HEIGHT))
        .flex()
        .items_center()
        .gap(px(8.))
        .overflow_hidden()
        .when_some(p.env.clone(), |d, env| {
            drawn.add("ChatEnv", env.clone());
            d.child(
                dim(env)
                    .flex_shrink(1.)
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis(),
            )
        });
    let buttons = div()
        .flex_none()
        .ml_auto()
        .min_h(px(QUIET_HEIGHT))
        .flex()
        .items_center()
        .gap(px(8.))
        .when_some(p.subagents, |d, n| {
            let words = format!("{n} subagent{}", if n == 1 { "" } else { "s" });
            drawn.add("ChatSubagents", words.clone());
            d.child(dim(words))
        });
    let quiet = div()
        .debug_selector(|| "factory-chat-quiet".into())
        .flex_none()
        .w_full()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(8.))
        .px(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(words)
        .child(buttons);
    let note = p.note.clone().map(|note| {
        drawn.add("ChatNote", note.clone());
        div()
            .debug_selector(|| "factory-chat-note".into())
            .flex_none()
            .w_full()
            .px(px(look::TOOL_WINDOW_HEADER_PAD_X))
            .pb(px(6.))
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(note))
    });
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .border_b_1()
        .border_color(look::TOOLWINDOW_HEADER_BORDER)
        .child(top)
        .child(quiet)
        .children(note);
    clickable(d, id, drawn).into_any_element()
}

/// px (boards R-Anatomy, H-States `.nv-chathead`): the two lines' block, line 1, line 2, the
/// override row (`.vs-chatbar__grant`), the cloud.
const SIGNAL_H: f32 = 48.;
const LINE1_H: f32 = 18.;
const LINE2_H: f32 = 16.;
const GRANT_H: f32 = 24.;
/// The Abe chat's tab row (slim: a 20 px tab in it) and a tab's widest.
const TABS_H: f32 = 24.;
const TAB_MAX_W: f32 = 160.;
const CLOUD: f32 = 12.;

/// Your Override's pill on the story line: small, bordered, the accent hue; the tooltip
/// says why and since when.
fn override_pill(p: &ChatPill, drawn: &mut Drawn) -> AnyElement {
    drawn.add("ChatPill", p.text.clone());
    div()
        .id("factory-chat-pill")
        .debug_selector(|| "factory-chat-pill".into())
        .flex_none()
        .h(px(16.))
        .px(px(6.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .border_1()
        .border_color(look::ABE_ACCENT)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .text_color(look::ABE_ACCENT)
        .when_some(p.tooltip.clone(), |d, t| {
            d.tooltip(crate::kit::tooltip(t, None))
        })
        .child(SharedString::from(p.text.clone()))
        .into_any_element()
}

/// A 22 px icon button of the tool header (⋮, ×): a click names its id.
fn act(id: &str, icon: IconName, tip: &str, drawn: &Drawn) -> AnyElement {
    let sid = id.to_owned();
    let b = div()
        .id(SharedString::from(format!("factory-node-{id}")))
        .debug_selector(move || format!("factory-node-{sid}"))
        .flex_none()
        .size(px(22.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .hover(|s| s.bg(look::HOVER_BG))
        .tooltip(crate::kit::tooltip(tip.to_owned(), None))
        .child(Icon::new(icon));
    clickable(b, Some(id), drawn).into_any_element()
}

/// 2.1's header (B Signal): the `Chat | Terminal` tool header with ⋮ and ×, then `#2 <title>`
/// with its cloud or `Local sandbox` and `⌘⏎`, then the rail line (Needs you: purple, ◆) or,
/// with no rail, the note dim (an Improve chat's `your layer · ~/.config/abe`), then an
/// override's warn row.
fn signal(
    id: Option<&str>,
    sel: String,
    story: &Story,
    p: &ChatHeaderProps,
    drawn: &mut Drawn,
) -> AnyElement {
    let focused = drawn.focused;
    // the tool header: the modes as tool window tabs, the actions at the right
    let mut tabs = div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(look::TOOLWINDOW_TAB_GAP))
        .overflow_hidden();
    for m in &p.modes {
        drawn.add(
            "ChatMode",
            if m.needs_you {
                format!("{} ◆", m.label)
            } else {
                m.label.clone()
            },
        );
        let selected = p.mode.as_deref() == Some(m.id.as_str());
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
        let mid = m.id.clone();
        let t = div()
            .id(SharedString::from(format!("factory-node-{mid}")))
            .debug_selector(move || format!("factory-node-{mid}"))
            .flex_none()
            .h(px(look::TOOLWINDOW_TAB_HEIGHT))
            .px(px(look::TOOLWINDOW_TAB_PAD_X))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .text_size(px(look::TOOLWINDOW_TAB_FONT_SIZE))
            .when(selected, |d| d.bg(bg).border_color(border))
            .when(!selected, |d| {
                d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
            })
            .when_some(m.tooltip.clone(), |d, t| {
                d.tooltip(crate::kit::tooltip(t, None))
            })
            .child(SharedString::from(m.label.clone()))
            .when(m.needs_you, |d| {
                d.child(div().text_color(look::ABE_NEEDS_YOU).child("◆"))
            });
        tabs = tabs.child(clickable(t, Some(&m.id), drawn));
    }
    let tool = (!p.modes.is_empty() || p.menu.is_some() || p.hide.is_some()).then(|| {
        div()
            .flex_none()
            .h(px(look::TOOL_WINDOW_HEADER_HEIGHT.get()))
            .w_full()
            .flex()
            .items_center()
            .gap(px(2.))
            .pl(px(look::TOOL_WINDOW_HEADER_PAD_X
                - look::TOOLWINDOW_TAB_BOX_INSET_X
                - 4.))
            .pr(px(6.))
            .border_b_1()
            .border_color(look::TOOLWINDOW_HEADER_BORDER)
            .child(tabs)
            .children(
                p.menu
                    .as_deref()
                    .map(|m| act(m, IconName::MoreVertical, "Options", drawn)),
            )
            .children(
                p.hide
                    .as_deref()
                    .map(|h| act(h, IconName::CloseSmall, "Hide", drawn)),
            )
    });

    // line 1: the card's number, the title, where it runs, the hint
    drawn.add("ChatStory", format!("{} {}", story.id, story.title));
    let place = match &p.cloud {
        Some(b) => {
            drawn.add(
                "ChatCloud",
                format!("{:?} {}", b.state, b.name).to_lowercase(),
            );
            Some(b.name.clone())
        }
        None => p.env.clone().inspect(|env| {
            drawn.add("ChatEnv", env.clone());
        }),
    };
    let line1 = div()
        .flex_none()
        .h(px(LINE1_H))
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(6.))
        .whitespace_nowrap()
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .when(p.face, |d| {
            d.child(crate::kit::Head {
                size: 16.,
                opacity: 1.,
            })
        })
        .when(!p.face, |d| {
            d.child(
                div()
                    .flex_none()
                    .text_color(look::ABE_ACCENT)
                    .child(SharedString::from(story.id.clone())),
            )
        })
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .child(SharedString::from(if p.face {
                    format!("{} {}", story.id, story.title)
                } else {
                    story.title.clone()
                })),
        )
        .children(p.cloud.as_ref().map(|b| Cloud { state: b.state }))
        .children(place.map(|w| dim(w).text_size(px(look::UI_SMALL_FONT_SIZE))))
        .children(p.pill.as_ref().map(|pill| override_pill(pill, drawn)))
        .when_some(p.hint.clone(), |d, h| {
            drawn.add("ChatHint", h.clone());
            d.child(
                div()
                    .flex_none()
                    .ml_auto()
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DISABLED)
                    .child(SharedString::from(h)),
            )
        });

    // line 2: the rail and its words
    let line2 = p.rail.as_ref().map(|r| {
        let need = r.state == AgentState::NeedsYou;
        let names: Vec<String> = r
            .segments
            .iter()
            .map(|s| format!("{s:?}").to_lowercase())
            .collect();
        drawn.add("Segments", names.join(" "));
        let mark = r.glyph.clone();
        let elapsed = r
            .elapsed
            .as_ref()
            .map(|e| format!(" · {e}"))
            .unwrap_or_default();
        let subs = p
            .subagents
            .map(|n| format!(" · {n} subagent{}", if n == 1 { "" } else { "s" }))
            .unwrap_or_default();
        drawn.add(
            "ChatRail",
            format!("{} {mark} {}{elapsed}{subs}", r.stage, r.word),
        );
        let address = p.address.as_ref().map(|a| {
            drawn.add("ChatAddress", a.text.clone());
            let id = a.id.clone();
            let link = div()
                .id(SharedString::from(format!("factory-node-{id}")))
                .debug_selector(move || format!("factory-node-{id}"))
                .flex_none()
                .text_color(look::LINK)
                .hover(|s| s.underline())
                .child(SharedString::from(a.text.clone()));
            clickable(link, Some(&a.id), drawn)
        });
        let hue = agent_color(r.state);
        let state_dot = if r.state == AgentState::Running || r.state == AgentState::Starting {
            super::status::pulse("factory-chat-live", mark, hue, drawn)
        } else {
            div()
                .flex_none()
                .text_color(hue)
                .child(mark)
                .into_any_element()
        };
        let stage_fg = if need {
            look::ABE_NEEDS_YOU
        } else {
            look::TEXT
        };
        let elapsed_fg = if need {
            look::ABE_NEEDS_YOU
        } else {
            look::TEXT_DIM
        };
        div()
            .flex_none()
            .h(px(LINE2_H))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .overflow_hidden()
            .whitespace_nowrap()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .when(!r.segments.is_empty(), |d| d.child(segments(&r.segments)))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .when_some(address, |d, a| {
                        d.child(a).child(div().flex_none().mx(px(4.)).child("·"))
                    })
                    .child(
                        div()
                            .flex_none()
                            .text_color(stage_fg)
                            .child(SharedString::from(r.stage.clone())),
                    )
                    // one space's width between the stage, the mark and the word
                    .child(div().flex_none().ml(px(4.)).child(state_dot))
                    .child(
                        div()
                            .flex_none()
                            .ml(px(4.))
                            .text_color(hue)
                            .child(SharedString::from(r.word.clone())),
                    )
                    .when(!elapsed.is_empty(), |d| {
                        d.child(
                            div()
                                .flex_none()
                                .text_color(elapsed_fg)
                                .child(SharedString::from(elapsed.clone())),
                        )
                    })
                    .when(!subs.is_empty(), |d| {
                        d.child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .when(need, |d| d.text_color(look::ABE_NEEDS_YOU))
                                .child(SharedString::from(subs.clone())),
                        )
                    }),
            )
    });
    // line 2 without a rail (an Improve chat, an Improve retro chat): the note, dim
    let line2 = line2.or_else(|| {
        p.note.clone().map(|note| {
            drawn.add("ChatNote", note.clone());
            div()
                .debug_selector(|| "factory-chat-note".into())
                .flex_none()
                .h(px(LINE2_H))
                .min_w_0()
                .flex()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(SharedString::from(note)),
                )
        })
    });
    let head = div()
        .flex_none()
        .h(px(SIGNAL_H))
        .w_full()
        .flex()
        .flex_col()
        .justify_center()
        .gap(px(3.))
        .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
        .pr(px(10.))
        .bg(look::PANEL_BG)
        .border_b_1()
        .border_color(look::TOOLWINDOW_HEADER_BORDER)
        .child(line1)
        .children(line2);
    let overridden = p.overridden.clone().map(|o| {
        let words = format!("✎ {o}");
        drawn.add("ChatOverride", words.clone());
        div()
            .id("factory-chat-override")
            .flex_none()
            .h(px(GRANT_H))
            .w_full()
            .flex()
            .items_center()
            .pl(px(look::TOOL_WINDOW_HEADER_PAD_X))
            .pr(px(6.))
            .border_b_1()
            .border_color(look::TOOLWINDOW_HEADER_BORDER)
            .overflow_hidden()
            .whitespace_nowrap()
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::ABE_WARN)
            .tooltip(crate::kit::tooltip(
                "Ends with the session · noted on the story and the PR",
                None,
            ))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(SharedString::from(words)),
            )
    });
    let tabs = (!p.tabs.is_empty()).then(|| tab_row(p, drawn));
    let d = div()
        .debug_selector(move || sel)
        .flex_none()
        .w_full()
        .flex()
        .flex_col()
        .bg(look::PANEL_BG)
        .children(tool)
        .child(head)
        .children(tabs)
        .children(overridden);
    clickable(d, id, drawn).into_any_element()
}

/// The Abe chat's conversations under its header, the newest at the right: each its name (the
/// shown one as the tool window's selected tab), a working dot or ◆, its × (on the shown one, or
/// hovered); `+` a new one.
fn tab_row(p: &ChatHeaderProps, drawn: &mut Drawn) -> gpui_kit::Div {
    let focused = drawn.focused;
    let mut row = div()
        .debug_selector(|| "factory-chat-tabs".into())
        .flex_none()
        .h(px(TABS_H))
        .w_full()
        .flex()
        .items_center()
        .gap(px(2.))
        .pl(px(look::TOOL_WINDOW_HEADER_PAD_X - 6.))
        .pr(px(6.))
        .border_b_1()
        .border_color(look::TOOLWINDOW_HEADER_BORDER)
        .overflow_hidden()
        .whitespace_nowrap()
        .text_size(px(look::UI_SMALL_FONT_SIZE));
    for t in &p.tabs {
        drawn.add(
            "ChatTab",
            match t.mark {
                Some(TabMark::Working) => format!("● {}", t.label),
                Some(TabMark::NeedsYou) => format!("◆ {}", t.label),
                None => t.label.clone(),
            },
        );
        let bg = if focused {
            look::TOOLWINDOW_TAB_SELECTED_BG
        } else {
            look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG
        };
        let group = SharedString::from(format!("factory-tab-{}", t.id));
        let close = div()
            .flex_none()
            .px(px(2.))
            .text_color(look::TEXT_DIM)
            .when(!t.selected, |d| {
                d.invisible().group_hover(group.clone(), |s| s.visible())
            })
            .hover(|s| s.text_color(look::TEXT))
            .child("×");
        let mark = t.mark.map(|m| match m {
            TabMark::Working => div().flex_none().text_color(look::ABE_WARN).child("●"),
            TabMark::NeedsYou => div().flex_none().text_color(look::ABE_NEEDS_YOU).child("◆"),
        });
        let sel = format!("factory-node-{}", t.id);
        let tab = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel)
            .group(group)
            .flex_shrink(1.)
            .min_w(px(48.))
            .max_w(px(TAB_MAX_W))
            .h(px(TABS_H - 4.))
            .flex()
            .items_center()
            .gap(px(4.))
            .pl(px(6.))
            .pr(px(2.))
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .text_color(if t.selected {
                look::TEXT
            } else {
                look::TEXT_DIM
            })
            .when(t.selected, |d| d.bg(bg))
            .when(!t.selected, |d| {
                d.hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
            })
            .tooltip(crate::kit::tooltip(t.label.clone(), None))
            .children(mark)
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(SharedString::from(t.label.clone())),
            )
            .child(clickable(close, Some(&t.close), drawn));
        row = row.child(clickable(tab, Some(&t.id), drawn));
    }
    if let Some(add) = &p.add {
        let plus = div()
            .id("factory-chat-tab-add")
            .debug_selector(|| "factory-chat-tab-add".into())
            .flex_none()
            .size(px(TABS_H - 4.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(look::TOOLWINDOW_TAB_ARC))
            .hover(|s| s.bg(look::TOOLWINDOW_TAB_HOVER_BG))
            .tooltip(crate::kit::tooltip("New conversation", None))
            .child(Icon::new(IconName::Add).size(px(look::ICON_SIZE)));
        row = row.child(clickable(plus, Some(add), drawn));
    }
    row
}

/// The box's 12 px cloud (board H-States): filled while it runs, outlined asleep, dashed while
/// it starts; the accent colour unless asleep. Drawn from its SVG, rasterized once per look.
struct Cloud {
    state: BoxState,
}

/// The rasterized clouds by their SVG's text: it names the state's shape and the colour in force,
/// so a look's other colours rasterize anew instead of drawing the last look's.
#[derive(Default)]
struct Clouds(std::collections::HashMap<String, std::sync::Arc<gpui_kit::RenderImage>>);

impl gpui_kit::Global for Clouds {}

/// The cloud's SVG in the look in force: what [`Clouds`] keys its rasterized images by.
pub fn cloud_svg(state: BoxState) -> String {
    Cloud::svg(state)
}

impl Cloud {
    fn svg(state: BoxState) -> String {
        let (color, fill, dash) = match state {
            BoxState::Running => (look::ABE_ACCENT, true, false),
            BoxState::Asleep => (look::TEXT_DIM, false, false),
            BoxState::Starting => (look::ABE_ACCENT, false, true),
        };
        let hex = super::diff_card::hex(color.rgba());
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M3.15 9.5a2.25 2.25 0 0 1-.2-4.49 3 3 0 0 1 5.6-.86A2.35 2.35 0 0 1 8.65 9.5z" fill="{}" stroke="{hex}" stroke-width="1.5" stroke-linejoin="round"{}/></svg>"#,
            if fill { hex.as_str() } else { "none" },
            if dash {
                r#" stroke-dasharray="2 1.6""#
            } else {
                ""
            },
        )
    }
}

// what `#[derive(IntoElement)]` writes (its expansion names the `gpui` crate)
impl IntoElement for Cloud {
    type Element = gpui_kit::ViewElement<Self>;

    fn into_element(self) -> Self::Element {
        gpui_kit::ViewElement::new(self)
    }
}

impl gpui_kit::RenderOnce for Cloud {
    fn render(self, _: &mut gpui_kit::Window, cx: &mut gpui_kit::App) -> impl IntoElement {
        let svg = Cloud::svg(self.state);
        let cached = cx.default_global::<Clouds>().0.get(&svg).cloned();
        let image = cached.or_else(|| {
            let img = cx
                .svg_renderer()
                // 1.0: the SVG's own 12 px at GPUI's 2x smoothing, as the icons ([`crate::kit`])
                .render_single_frame(svg.as_bytes(), 1.0)
                .ok()?;
            cx.default_global::<Clouds>().0.insert(svg, img.clone());
            Some(img)
        });
        match image {
            Some(img) => gpui_kit::img(gpui_kit::ImageSource::Render(img))
                .size(px(CLOUD))
                .flex_none()
                .into_any_element(),
            None => div().size(px(CLOUD)).flex_none().into_any_element(),
        }
    }
}
