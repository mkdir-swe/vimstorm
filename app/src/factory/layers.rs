//! The layers of the set (`abe/packages/ui/src/runtime/layers.ts`): PickLayer, PromptLayer and
//! ConfirmLayer, drawn with the popup kit (DS 2.0 `components/<Name>`: 480 px, centred, 48 px
//! from the top of the view, over it). They hold no state: the bridge's `layer` frame says what
//! is typed, which row the cursor is on and which button has focus; every key goes to the bridge.
//! A click on a pick's row sends its id, on a confirm's buttons `risky` / `no`.

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, Styled as _, deferred, div, font,
    prelude::FluentBuilder as _, px, relative,
};

use super::FactoryView;
use super::draw::Drawn;
use super::protocol::{
    ConfirmFocus, ConfirmProps, Node, PickProps, PickRow, PickState, PromptProps, UserInput,
};
use crate::kit;
use crate::kit::TextButton;
use crate::kit::{Icon, IconName};
use crate::look;
use crate::render::EDITOR_FONT;

/// A layer's width (DS `--popup-width-pick`).
pub const WIDTH: f32 = 480.;
/// A wide pick's (LM-Held: a list whose rows say a lot).
pub const WIDE: f32 = 820.;
/// px (LM-Held): a row's lead column (`09:41`, mono 12) and a wide pick's note column.
const LEAD_W: f32 = 44.;
const WIDE_NOTE_W: f32 = 210.;
/// From the top of the view it is centred in.
pub const TOP: f32 = 48.;
/// Over the view's own popups (DS: priority 2).
const PRIORITY: usize = 2;
/// A confirm's padding (WS Messages: 16).
const PAD: f32 = 16.;
/// A pick's scrollbar thumb: its width and its gap to the popup's right edge. Thinner than
/// MacScrollBarUI's idle 11 (`look::SCROLLBAR_WIDTH`) so it fits the rows' 8 px inset
/// (`LIST_ROW_INSET_X`) clear of the selection; always shown, being the only sign of more rows.
const THUMB_WIDTH: f32 = 5.;
const THUMB_INSET: f32 = 2.;

/// The layer, placed over a view `size` px: a pick, prompt or confirm centred near its top, the
/// card dialog centred in it; drawn last.
pub fn over(
    layer: &Node,
    size: (f32, f32),
    dialog: &super::dialog::DialogDraw,
    drawn: &mut Drawn,
    window: &mut gpui_kit::Window,
    cx: &mut Context<FactoryView>,
) -> Option<AnyElement> {
    let slot = match layer {
        Node::CardDialog { id, props } => {
            super::dialog::card_dialog(id.as_deref(), props, dialog, size, drawn, window, cx)
        }
        Node::CommentBox { props, .. } => div()
            .absolute()
            .left(px(kit::centered(super::comment::WIDTH, size.0)))
            .top(px(TOP))
            .child(super::comment::comment_box(props, drawn))
            .into_any_element(),
        Node::LaunchBox { props, .. } => div()
            .absolute()
            .left(px(kit::centered(super::launch::WIDTH, size.0)))
            .top(px(TOP))
            .child(super::launch::launch_box(props, drawn))
            .into_any_element(),
        _ => {
            let width = match layer {
                Node::PickLayer { props, .. } => pick_width(props),
                _ => WIDTH,
            };
            let el = popup_of(layer, drawn)?;
            div()
                .absolute()
                .left(px(kit::centered(width, size.0)))
                .top(px(TOP))
                .child(el)
                .into_any_element()
        }
    };
    Some(deferred(slot).with_priority(PRIORITY).into_any_element())
}

/// The popup itself, for a layer kind; None for any other node.
pub fn popup_of(n: &Node, drawn: &mut Drawn) -> Option<AnyElement> {
    Some(match n {
        Node::PickLayer { props, .. } => pick(props, drawn),
        Node::PromptLayer { props, .. } => prompt(props, drawn),
        Node::ConfirmLayer { props, .. } => confirm(props, drawn),
        _ => return None,
    })
}

/// Text with the 1 px caret at its place, kept in view when the text is too long.
fn caret_text(text: &str, caret: Option<usize>) -> AnyElement {
    let caret_el = div()
        .debug_selector(|| "factory-caret".into())
        .flex_none()
        .w(px(look::CARET_WIDTH))
        .h(px(look::UI_FONT_SIZE + 3.))
        .bg(look::CARET);
    super::field::caret_line(text, caret, Some(caret_el))
}

/// A pick's width: 480, a wide one's 820.
fn pick_width(p: &PickProps) -> f32 {
    if p.wide { WIDE } else { WIDTH }
}

/// A pick's title: local mode's house before it, its caption dim after it (LM-Held).
fn pick_title(p: &PickProps, drawn: &mut Drawn) -> AnyElement {
    if p.local {
        drawn.add("HouseMark", "PickLayer");
    }
    let caption = p.caption.as_ref().map(|c| {
        drawn.add("PickCaption", c);
        div()
            .min_w_0()
            .overflow_hidden()
            .text_ellipsis()
            .font_weight(FontWeight::NORMAL)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM)
            .child(SharedString::from(c.clone()))
    });
    if !p.local && caption.is_none() {
        return SharedString::from(p.title.clone()).into_any_element();
    }
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .when(p.local, |d| {
            d.child(super::local::house(
                super::local::HOUSE,
                look::ABE_PATH.rgba(),
            ))
        })
        .child(SharedString::from(p.title.clone()))
        .children(caption)
        .into_any_element()
}

fn pick(p: &PickProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PickLayer", &p.title);
    if p.wide {
        drawn.add("PickWide", &p.title);
    }
    let none = p.state.is_none() && p.rows.is_empty();
    let filter = p.filter.as_ref().map(|f| {
        drawn.add("Filter", f);
        div()
            .debug_selector(|| "factory-pick-filter".into())
            .h(px(look::MENU_SEARCH_HEIGHT))
            .flex_none()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .gap(px(look::FIELD_ICON_GAP))
                    .px(px(12.))
                    .child(Icon::new(IconName::Search))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .flex()
                            .items_center()
                            .text_color(if none {
                                look::SPEED_SEARCH_ERROR_FG
                            } else {
                                look::SPEED_SEARCH_FG
                            })
                            .child(caret_text(f, p.caret))
                            // the line's dim words while nothing is typed
                            .children(p.placeholder.as_ref().filter(|_| f.is_empty()).map(|ph| {
                                drawn.add("PickPlaceholder", ph);
                                div()
                                    .text_color(look::MENU_DISABLED_FG)
                                    .child(SharedString::from(ph.clone()))
                            })),
                    ),
            )
            .child(div().flex_none().h(px(1.)).bg(look::SEPARATOR))
    });
    let state_line = |text: String, error: bool| {
        div()
            .h(px(look::LIST_ROW_HEIGHT.get()))
            .px(px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X))
            .flex()
            .items_center()
            .text_color(if error {
                look::TEXT_ERROR
            } else {
                look::MENU_DISABLED_FG
            })
            .child(SharedString::from(text))
            .into_any_element()
    };
    let body: Vec<AnyElement> = match (p.state, &p.message) {
        (Some(PickState::Loading), _) => vec![state_line("Loading…".into(), false)],
        (Some(PickState::Error), m) => {
            let text = format!("✗ {}", m.as_deref().unwrap_or("failed"));
            drawn.add("PickState", &text);
            vec![state_line(text, true)]
        }
        (None, _) if p.rows.is_empty() => vec![state_line("Nothing to show".into(), false)],
        (None, _) => p
            .rows
            .iter()
            .enumerate()
            .flat_map(|(i, r)| {
                // a group's heading has a line above it unless it is the first row
                let line = (r.separator || (r.section.is_some() && i > 0)).then(|| {
                    drawn.add("PickSeparator", &r.text);
                    kit::popup_separator()
                        .debug_selector(|| "factory-pick-separator".into())
                        .into_any_element()
                });
                let heading = r.section.as_ref().map(|t| section_line(t, drawn));
                line.into_iter().chain(heading).chain([pick_row(
                    r,
                    p.selected.as_deref() == Some(&r.id),
                    p.wide,
                    drawn,
                )])
            })
            .collect(),
    };
    let shown = p.rows.len();
    let thumb = p
        .scroll
        .filter(|s| p.state.is_none() && shown > 0 && s.total > shown)
        .map(|s| scroll_thumb(s.top, shown, s.total, drawn));
    let sink = drawn.sink.clone();
    kit::popup_frame()
        .debug_selector(|| "factory-pick".into())
        .w(px(pick_width(p)))
        .occlude()
        // the wheel moves the selection a row per step and the window with it, as the
        // native menus do: the rows past the window are reached by mouse too
        .when_some(sink.filter(|_| thumb.is_some()), |d, sink| {
            d.on_scroll_wheel(move |ev, _, cx| {
                cx.stop_propagation();
                let rows = wheel_rows(ev.delta);
                let key = if rows > 0 { "<Down>" } else { "<Up>" };
                for _ in 0..rows.unsigned_abs() {
                    sink.send(UserInput::Key { key: key.into() }, cx);
                }
            })
        })
        .child(kit::header(pick_title(p, drawn), None))
        .children(filter)
        .child(
            div().py(px(look::POPUP_PADDING_Y)).child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .children(body)
                    .children(thumb),
            ),
        )
        .children(p.hint.as_ref().map(|h| {
            drawn.add("PickHint", h);
            kit::ad_text(SharedString::from(h.clone()))
        }))
        .into_any_element()
}

thread_local! {
    /// A trackpad's pixels not yet a whole row (one pick is up at a time).
    static WHEEL: std::cell::Cell<f32> = const { std::cell::Cell::new(0.) };
}

/// Rows a wheel event moves the selection, down positive: a line each, pixels a row's height.
fn wheel_rows(delta: gpui_kit::ScrollDelta) -> i32 {
    match delta {
        gpui_kit::ScrollDelta::Lines(l) => -l.y.round() as i32,
        gpui_kit::ScrollDelta::Pixels(p) => WHEEL.with(|w| {
            let row = look::LIST_ROW_HEIGHT.get();
            let total = w.get() + p.y.as_f32();
            let n = (total / row).trunc();
            w.set(total - n * row);
            -(n as i32)
        }),
    }
}

/// The scrollbar thumb: a pick holding more rows than it shows says so, as a WebStorm
/// list popup does. Over the rows' right inset (8 px, clear of the selection), its place and
/// length the window's share of all the rows.
fn scroll_thumb(top: usize, shown: usize, total: usize, drawn: &mut Drawn) -> AnyElement {
    let top = top.min(total - shown);
    drawn.add(
        "PickScroll",
        format!("{}–{} of {total}", top + 1, top + shown),
    );
    div()
        .debug_selector(|| "factory-pick-scrollbar".into())
        .absolute()
        .right(px(THUMB_INSET))
        .w(px(THUMB_WIDTH))
        .top(relative(top as f32 / total as f32))
        .h(relative(shown as f32 / total as f32))
        .rounded(px(THUMB_WIDTH / 2.))
        .bg(look::SCROLLBAR_THUMB)
        .into_any_element()
}

/// A group's dim heading in a pick (Command mode's `#1234 Cart total…`, `Board`,
/// `Anywhere`): never selectable, as a WebStorm popup's group title.
fn section_line(text: &str, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PickSection", text);
    div()
        .debug_selector(|| "factory-pick-section".into())
        .h(px(look::LIST_ROW_HEIGHT.get()))
        .flex_none()
        .px(px(look::LIST_ROW_INSET_X + look::LIST_ROW_PADDING_X))
        .flex()
        .items_center()
        .overflow_hidden()
        .text_color(look::MENU_DISABLED_FG)
        .child(SharedString::from(text.to_string()))
        .into_any_element()
}

fn pick_row(r: &PickRow, selected: bool, wide: bool, drawn: &mut Drawn) -> AnyElement {
    let enabled = r.reason.is_none();
    let selected = selected && enabled;
    drawn.add("PickRow", &r.text);
    if selected {
        drawn.add("PickSelected", &r.text);
    }
    if r.risky && enabled {
        drawn.add("PickRisky", &r.text);
    }
    let fg = |normal| match (enabled, selected) {
        (false, _) => look::MENU_DISABLED_FG,
        (true, true) => look::SELECTION_TEXT,
        (true, false) => normal,
    };
    // a risky row's title and key in bad (X-BoxMenu's `nv-pick-danger`), its detail dim
    let strong = |normal| fg(if r.risky { look::ABE_BAD } else { normal });
    // why it is grey after a dash (`Launch agent — already running`), a detail after a dot
    let after = r
        .reason
        .as_ref()
        .map(|why| format!("— {why}"))
        .or_else(|| r.dim.as_ref().map(|d| format!("· {d}")));
    if let Some(a) = &after {
        drawn.add("PickDetail", format!("{} {a}", r.text));
    }
    let id = r.id.clone();
    div()
        .debug_selector(move || format!("factory-pick-row-{id}"))
        .h(px(look::LIST_ROW_HEIGHT.get()))
        .flex_none()
        .w_full()
        .px(px(look::LIST_ROW_INSET_X))
        .when(enabled, |d| {
            let id = r.id.clone();
            let sink = drawn.sink.clone();
            d.cursor_pointer()
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    if let Some(sink) = &sink {
                        sink.click(id.clone(), window, cx);
                    }
                })
        })
        .child(
            div()
                .size_full()
                .px(px(look::LIST_ROW_PADDING_X))
                .rounded(px(look::LIST_SELECTION_ARC))
                .when(selected, |d| d.bg(look::SELECTION_BG))
                .flex()
                .items_center()
                .gap(px(look::MENU_SHORTCUT_GAP))
                .text_color(strong(look::TEXT))
                // its lead in a column of its own (Held writes' time)
                .children(r.lead.as_ref().map(|l| {
                    drawn.add("PickLead", format!("{l} {}", r.text));
                    div()
                        .flex_none()
                        .w(px(LEAD_W))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .font(font(EDITOR_FONT))
                        .text_size(px(look::UI_SMALL_FONT_SIZE))
                        .text_color(fg(look::TEXT_DIM))
                        .child(SharedString::from(l.clone()))
                }))
                .child(
                    div()
                        .flex_none()
                        .max_w_1_2()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(SharedString::from(r.text.clone())),
                )
                .children(after.map(|a| {
                    div()
                        .flex_shrink(1.)
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_color(fg(look::TEXT_DIM))
                        .child(SharedString::from(a))
                }))
                .child(div().flex_1())
                .children(r.note.as_ref().map(|n| {
                    div()
                        .flex_none()
                        .when(wide, |d| d.w(px(WIDE_NOTE_W)))
                        .max_w_1_2()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_color(strong(look::MENU_SHORTCUT_FG))
                        .child(SharedString::from(n.clone()))
                })),
        )
        .into_any_element()
}

fn prompt(p: &PromptProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("PromptLayer", &p.title);
    drawn.add("Field", &p.text);
    let ad = match (&p.error, &p.hint) {
        (Some(e), _) => {
            drawn.add("FieldError", e);
            Some(format!("✗ {e}"))
        }
        (None, h) => h.clone(),
    };
    let field = div()
        .debug_selector(|| "factory-prompt-field".into())
        .mx(px(look::INPUT_FIELD_INSET - look::FIELD_PADDING_X))
        .mb(px(look::INPUT_POPUP_PADDING))
        .min_h(px(look::INPUT_FIELD_HEIGHT))
        .px(px(look::FIELD_PADDING_X))
        .py(px(4.))
        .rounded(px(look::FIELD_ARC))
        .bg(look::FIELD_BG)
        .border_1()
        .border_color(if p.error.is_some() {
            look::BUTTON_DANGER_BORDER
        } else {
            look::FIELD_BORDER
        })
        .overflow_hidden()
        .flex()
        .flex_col()
        .justify_center()
        .child(caret_text(&p.text, p.caret));
    kit::popup_frame()
        .debug_selector(|| "factory-prompt".into())
        .w(px(WIDTH))
        .occlude()
        .child(kit::header(SharedString::from(p.title.clone()), None))
        .child(field)
        .children(ad.map(|a| {
            kit::ad_text(SharedString::from(a))
                .when(p.error.is_some(), |d| d.text_color(look::TEXT_ERROR))
        }))
        .into_any_element()
}

fn confirm(p: &ConfirmProps, drawn: &mut Drawn) -> AnyElement {
    drawn.add("ConfirmLayer", &p.question);
    let risky_focused = p.focus == ConfirmFocus::Risky;
    let no = p.no.clone().unwrap_or_else(|| "No".into());
    // the focused one is the default (filled, ⏎); the risky one carries its letter
    let risky_key = if risky_focused {
        "⏎".to_owned()
    } else {
        p.risky.letter.clone()
    };
    drawn.add("Button", format!("{} {risky_key}", p.risky.label));
    drawn.add(
        "Button",
        if risky_focused {
            no.clone()
        } else {
            format!("{no} ⏎")
        },
    );
    if risky_focused {
        drawn.add("Default", &p.risky.label);
    } else {
        drawn.add("Default", &no);
    }
    let sink = drawn.sink.clone();
    let press = move |id: &'static str| {
        let sink = sink.clone();
        move |_: &gpui_kit::ClickEvent, window: &mut gpui_kit::Window, cx: &mut gpui_kit::App| {
            if let Some(sink) = &sink {
                sink.click(id.into(), window, cx);
            }
        }
    };
    let risky = TextButton::new("factory-confirm-risky", p.risky.label.clone())
        .primary(risky_focused)
        .danger(p.danger)
        .key(risky_key)
        .on_click(press("risky"));
    let mut no_button = TextButton::new("factory-confirm-no", no)
        .primary(!risky_focused)
        .on_click(press("no"));
    if !risky_focused {
        no_button = no_button.key("⏎");
    }
    kit::popup_frame()
        .debug_selector(|| "factory-confirm".into())
        .w(px(WIDTH))
        .occlude()
        .when(p.danger, |d| d.border_color(look::BUTTON_DANGER_BORDER))
        .child(
            div()
                .p(px(PAD))
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .when(p.danger, |d| d.text_color(look::BUTTON_DANGER_TEXT))
                        .child(SharedString::from(p.question.clone())),
                )
                .children(p.details.iter().map(|l| {
                    div()
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(l.clone()))
                }))
                .child(
                    div()
                        .pt(px(8.))
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            div()
                                .debug_selector(|| "factory-confirm-risky".into())
                                .child(risky),
                        )
                        .child(
                            div()
                                .debug_selector(|| "factory-confirm-no".into())
                                .child(no_button),
                        ),
                ),
        )
        .into_any_element()
}
