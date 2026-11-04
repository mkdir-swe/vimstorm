//! The card dialog (`layers.ts` `CardDialog`, DS 2.0 StoryTab, App Map D14): the card read
//! first, centred over the view in the card-dialog look, 840 × 700 at most. The kicker (its type)
//! · `#id` and its state badge, the title and one meta line, its sections as markdown through
//! VimStorm's renderer ([`super::story`]), the footer's buttons right-aligned. The story look (board F-Story, given a `heading`): a dim
//! cap (`STORY · DEMO-SHOP`) and a close button over `#id` and the title and the facts line, the
//! Linked block at its end (a chip per row, a dim one not there yet), `⌘⏎ more` before the one
//! primary. Its keys are the bridge's (Command mode): Rust draws, scrolls to the `scroll` lines it
//! is told and sends a button's, a Linked chip's or the close button's click as its id. The Card
//! page ([`card_page`], the `card` screen) is the same story look as the main slot's page: no
//! backdrop and no close button, the comment composer over its footer, its actions the buttons;
//! the Board's card popup ([`card_popup`], the `popup` slot's) is that page in the dialog's
//! frame over the dimmed Board.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::{
    AnyElement, Context, FontWeight, HighlightStyle, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, canvas, deferred, div, point, prelude::FluentBuilder as _, px,
};

use super::FactoryView;
use super::comment::BoxState;
use super::comment::{Thread, ThreadState};
use super::draw::Drawn;
use super::draw::hue;
use super::protocol::{
    CardDialogProps, CardPageProps, DialogFact, DialogLink, DialogSheets, FactTone, PageComposer,
    PickState, UserInput,
};
use super::select;
use super::story::{CardDraw, StoryPart, dialog_heading, ruled};
use crate::editor::markdown::OnLink;
use crate::kit;
use crate::kit::IconName;
use crate::kit::{IconButton, TextButton};
use crate::look;

/// The story look's caps (`STORY · DEMO-SHOP`, `LINKED`): board F-Story `.nv-cap` 11 px.
const CAP_SIZE: f32 = 11.;
/// A Linked chip's height (F-Story `.nv-link` 24 px) and the block's (`.nv-linked` 48 px).
const LINK_H: f32 = 24.;
const LINKED_H: f32 = 48.;

/// The story look's room above and below it at its tallest (F-Story: the view less 2 × 80),
/// and the least it keeps in a short view.
const STORY_INSET: f32 = 80.;
const STORY_MIN_H: f32 = 320.;

/// One `l` / `ö` of the bridge's: a list row.
const LINE_PX: crate::look::Met = look::LIST_ROW_HEIGHT;

/// What the dialog keeps between frames: its markdown and scroll, the scroll last applied.
#[derive(Default)]
pub struct DialogDraw {
    pub draw: CardDraw,
    /// The card and lines last scrolled to; a new `scroll` (or card) moves the page.
    applied: Cell<Option<(u64, u32)>>,
    /// The dialog (its node id) and how far its page scrolls, as last told the bridge.
    told: Rc<RefCell<Option<(String, u32)>>>,
}

impl DialogDraw {
    /// How far the page is scrolled down, px (tests).
    pub fn scrolled(&self) -> f32 {
        self.draw.scrolled()
    }

    /// No dialog drawn: the next one tells its extent whatever was told before.
    pub fn forget_extent(&self) {
        self.told.borrow_mut().take();
    }

    /// The page at `lines` down (within it), once its height is known.
    fn scroll_to(&self, card: u64, lines: u32) {
        if self.applied.get() == Some((card, lines)) {
            return;
        }
        let max = self.draw.scroll.max_offset().y.as_f32();
        let to = (lines as f32 * LINE_PX).min(max.max(0.));
        self.draw.scroll.set_offset(point(px(0.), px(-to)));
        // laid out (or at the top): done; else again next frame
        if max > 0. || lines == 0 {
            self.applied.set(Some((card, lines)));
        }
    }
}

/// How far a page scrolls in the bridge's `l` / `ö` steps: a last part step reaches its end.
pub fn extent_lines(max_offset: f32) -> u32 {
    (max_offset.max(0.) / LINE_PX.get()).ceil() as u32
}

/// Tells the bridge how far the page scrolls once laid out, and again as that changes: a
/// child of the scrolled body, prepainted after the body measured its content this frame.
fn measure(id: Option<&str>, dd: &DialogDraw, cx: &mut Context<FactoryView>) -> Option<AnyElement> {
    let id = id?.to_owned();
    let scroll = dd.draw.scroll.clone();
    let told = dd.told.clone();
    let view = cx.entity().downgrade();
    let el = canvas(
        move |_, _, cx| {
            if scroll.bounds().size.height <= px(0.) {
                return;
            }
            let lines = extent_lines(scroll.max_offset().y.as_f32());
            if told
                .borrow()
                .as_ref()
                .is_some_and(|(was, l)| *was == id && *l == lines)
            {
                return;
            }
            *told.borrow_mut() = Some((id.clone(), lines));
            cx.defer(move |cx| {
                let _ = view.update(cx, |v, _| v.send_extent(id, lines));
            });
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0();
    Some(el.into_any_element())
}

/// The head's words, as drawn, and its `#id` (none for card 0: no card yet).
fn head_words(p: &CardDialogProps, drawn: &mut Drawn) -> Option<String> {
    drawn.add("CardDialog", &p.title);
    // Card 0: no card yet (Make card's draft of a new one): no number.
    let number = (p.card > 0).then(|| format!("#{}", super::local::card_name(p.card)));
    if let Some(h) = &p.heading {
        drawn.add("DialogHeading", h);
    } else {
        drawn.add(
            "DialogKicker",
            number
                .as_ref()
                .map_or_else(|| p.kicker.clone(), |n| format!("{} {n}", p.kicker)),
        );
        drawn.add("DialogState", &p.state);
    }
    drawn.add("DialogMeta", p.meta.join(" · "));
    number
}

/// How the shared parts are laid out: the sections' column width, the story look, and whether
/// they make the Card page (no close button, the body filling what is left).
#[derive(Clone, Copy)]
struct Look {
    col_w: f32,
    story: bool,
    page: bool,
    /// Its head's close button (`dialog:close`): the dialog's and the Board's popup's.
    close: bool,
}

/// What the card dialog and the Card page draw alike: the head, the scrolled body (the sections,
/// the Comments, the Sheets beside them), the Linked block, the footer.
struct Parts {
    head: Vec<AnyElement>,
    body: AnyElement,
    linked: Option<AnyElement>,
    footer: AnyElement,
}

/// `card`: the node's id, its props and the head's `#id`.
fn parts(
    (id, p, number): (Option<&str>, &CardDialogProps, Option<String>),
    dd: &DialogDraw,
    lk: Look,
    drawn: &mut Drawn,
    window: &mut Window,
    cx: &mut Context<FactoryView>,
) -> Parts {
    let Look {
        col_w,
        story,
        page,
        close,
    } = lk;
    let view = cx.entity().downgrade();
    let press = move |id: String| {
        let view = view.clone();
        move |_: &gpui_kit::ClickEvent, _: &mut Window, cx: &mut gpui_kit::App| {
            let _ = view.update(cx, |v, cx| {
                v.send_input(UserInput::Click { id: id.clone() }, cx)
            });
        }
    };
    let head = match &p.heading {
        Some(h) => story_head(
            p,
            h,
            number,
            drawn,
            close.then(|| press("dialog:close".into())),
        ),
        None => card_head(p, number),
    };
    // only web links open: a card's text names any URL (`file://…/x.app` too)
    let on_link: OnLink = Rc::new(|url: String, _: &mut Window, cx: &mut gpui_kit::App| {
        if crate::editor::markdown::is_remote(&url) {
            cx.open_url(&url)
        }
    });
    let mut fetch = Vec::new();
    let n = p.sections.len();
    let sections = p.sections.iter().enumerate().map(|(i, s)| {
        drawn.add("DialogSection", &s.title);
        let part = if s.markdown.trim().is_empty() {
            StoryPart::Empty
        } else {
            StoryPart::Markdown(s.markdown.clone())
        };
        let heading = if story {
            story_heading(&s.title, s.note.as_deref(), i)
        } else {
            dialog_heading(&s.title, s.note.as_deref())
        };
        let el = div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(heading)
            .child(super::story::story(
                std::slice::from_ref(&part),
                ("factory-dialog", &format!("{}-{i}", p.card)),
                &dd.draw,
                col_w,
                window,
                &on_link,
                &mut fetch,
                select::drawing().map(|t| t.selectable()).as_ref(),
                None,
            ));
        // the story look rules each heading instead of the gap between sections, and keeps
        // them closer (F-Story)
        if story {
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .pt(px(if i == 0 { 14. } else { 0. }))
                .pb(px(8.))
                .child(el)
                .into_any_element()
        } else {
            ruled(el, i + 1 == n)
        }
    });
    let mut sections: Vec<AnyElement> = sections.collect();
    if let Some(t) = &p.comments {
        sections.push(comments_section(
            t,
            n,
            (p.card, col_w, &on_link),
            &dd.draw,
            drawn,
            window,
            &mut fetch,
        ));
    }
    let body = div()
        .id(SharedString::from(format!(
            "factory-dialog-scroll-{}",
            p.card
        )))
        .min_w_0()
        .debug_selector(move || {
            if page {
                "factory-card-page-body".into()
            } else {
                "factory-dialog-body".into()
            }
        })
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .track_scroll(&dd.draw.scroll)
        .px(px(look::ABE_DIALOG_PAD_X))
        .children(sections)
        .children(measure(id, dd, cx));
    let side = p.sheets.as_ref().map(|sh| sheets_column(sh, drawn, cx));
    let body = div()
        .map(|d| {
            if story && !page {
                d.flex_shrink(1.)
            } else {
                d.flex_1()
            }
        })
        .min_h_0()
        .flex()
        .flex_row()
        .child(body)
        .children(side)
        .into_any_element();
    let buttons = p.buttons.iter().map(|b| {
        let text = match &b.keys {
            Some(k) => format!("{} {k}", b.label),
            None => b.label.clone(),
        };
        // the button the keys are on is the default, as a confirm's (⏎ presses it)
        let default = p.focus.as_ref().map_or(b.primary, |f| *f == b.id);
        if p.focus.as_ref() == Some(&b.id) {
            drawn.add("DialogButtonFocused", text.clone());
        }
        drawn.add(
            if b.reason.is_some() {
                "DialogButtonDisabled"
            } else {
                "DialogButton"
            },
            text,
        );
        let id = b.id.clone();
        let mut button =
            TextButton::new(SharedString::from(format!("factory-{id}")), b.label.clone())
                .primary(default)
                .disabled(b.reason.is_some());
        if let Some(k) = &b.keys {
            button = button.key(k.clone());
        }
        if let Some(r) = &b.reason {
            button = button.tooltip(r.clone());
        } else {
            button = button.on_click(press(id.clone()));
        }
        div()
            .debug_selector(move || format!("factory-{id}"))
            .child(button)
            .into_any_element()
    });
    let buttons: Vec<AnyElement> = buttons.collect();
    let reason = p
        .buttons
        .iter()
        .find(|b| b.primary)
        .and_then(|b| b.reason.clone());
    let footer = div()
        .flex_none()
        .h(px(look::ABE_DIALOG_FOOTER_HEIGHT))
        .pl(px(look::ABE_DIALOG_PAD_X))
        .pr(px(16.))
        .flex()
        .items_center()
        .justify_end()
        .gap(px(8.))
        .border_t_1()
        .border_color(look::SEPARATOR)
        .children(p.error.as_ref().map(|e| {
            drawn.add("DialogError", e);
            div()
                .debug_selector(|| "factory-dialog-error".into())
                .flex_1()
                .min_w_0()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::ABE_BAD)
                .child(SharedString::from(e.clone()))
        }))
        .children(reason.filter(|_| p.error.is_none()).map(|r| {
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::MENU_DISABLED_FG)
                .child(SharedString::from(r))
        }))
        .children(p.hint.as_ref().map(|h| {
            drawn.add("DialogHint", h);
            div()
                .id("factory-dialog-hint")
                .debug_selector(|| "factory-dialog-hint".into())
                .flex_none()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .cursor_pointer()
                .on_click(press("dialog:menu".into()))
                .child(SharedString::from(h.clone()))
        }))
        .children(buttons)
        .into_any_element();
    let linked = (!p.linked.is_empty()).then(|| linked_block(&p.linked, drawn, &press));
    Parts {
        head,
        body,
        linked,
        footer,
    }
}

/// The Sheets column's width beside the sections, while the card has them.
fn side_width(p: &CardDialogProps) -> f32 {
    if p.sheets.is_some() {
        look::ABE_DIALOG_SIDE_WIDTH
    } else {
        0.
    }
}

/// The dialog over a view `size` px, centred: its frame.
pub fn card_dialog(
    id: Option<&str>,
    p: &CardDialogProps,
    dd: &DialogDraw,
    size: (f32, f32),
    drawn: &mut Drawn,
    window: &mut Window,
    cx: &mut Context<FactoryView>,
) -> AnyElement {
    let number = head_words(p, drawn);
    dd.scroll_to(p.card, p.scroll);
    let margin = look::POPUP_WINDOW_MARGIN;
    let w = look::ABE_DIALOG_WIDTH.min(size.0 - 2. * margin).max(0.);
    let h = look::ABE_DIALOG_HEIGHT.min(size.1 - 2. * margin).max(0.);
    // the story look sizes to its content, its body scrolling past the view less 80 a side
    let story = p.heading.is_some();
    let story_max = (size.1 - 2. * STORY_INSET)
        .max((size.1 - 2. * margin).min(STORY_MIN_H))
        .max(0.);
    // the Sheets column takes its width from the sections'
    let col_w = w - 2. * look::ABE_DIALOG_PAD_X - side_width(p);
    let lk = Look {
        col_w,
        story,
        page: false,
        close: true,
    };
    let parts = parts((id, p, number), dd, lk, drawn, window, cx);
    let frame = kit::popup_frame()
        .id("factory-dialog")
        .debug_selector(|| "factory-dialog".into())
        .w(px(w))
        .map(|d| {
            if story {
                d.max_h(px(story_max))
            } else {
                d.h(px(h))
            }
        })
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .children(parts.head)
        .child(parts.body)
        .children(parts.linked)
        .child(parts.footer);
    if story {
        // its height is its content's: centred by the layout
        return div()
            .absolute()
            .top_0()
            .left_0()
            .w(px(size.0))
            .h(px(size.1))
            .flex()
            .items_center()
            .justify_center()
            .child(frame)
            .into_any_element();
    }
    div()
        .absolute()
        .left(px(kit::centered(w, size.0)))
        .top(px(kit::centered(h, size.1)))
        .child(frame)
        .into_any_element()
}

/// The Card page (the `card` screen's tree) filling a view `size` px: the dialog's story look as
/// an island of its own, no backdrop and no close button, the body taking what the head, Linked,
/// the composer and the footer leave.
pub fn card_page(
    id: Option<&str>,
    p: &CardPageProps,
    dd: &DialogDraw,
    size: (f32, f32),
    drawn: &mut Drawn,
    window: &mut Window,
    cx: &mut Context<FactoryView>,
) -> AnyElement {
    let edge = look::ISLAND_EDGE_GAP;
    let inner = size.0 - 2. * edge - 2. * look::ISLAND_BORDER_WIDTH;
    let island = page_column(id, p, dd, (inner, false), drawn, window, cx)
        .id("factory-card-page")
        .debug_selector(|| "factory-card-page".into())
        .flex_1()
        .rounded(px(look::ISLAND_ARC.get()))
        .bg(look::PANEL_BG)
        .border(px(look::ISLAND_BORDER_WIDTH))
        .border_color(look::ISLAND_BORDER);
    div()
        .size_full()
        .flex()
        .flex_col()
        .p(px(edge))
        .bg(look::FRAME_BG)
        .font_family(crate::render::UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .text_color(look::TEXT)
        .child(island)
        .into_any_element()
}

/// The Board's card popup (the `popup` slot's Card page) over a view `size` px: the page in the
/// dialog's frame, [`POPUP_SHARE`] of the view, centred, its close button in the head; the view
/// behind dimmed as the `,G` float's (`term-float-backdrop`), its clicks taken. Its words select
/// as the page's do.
pub fn card_popup(
    id: Option<&str>,
    p: &CardPageProps,
    dd: &DialogDraw,
    size: (f32, f32),
    drawn: &mut Drawn,
    window: &mut Window,
    cx: &mut Context<FactoryView>,
) -> AnyElement {
    let margin = look::POPUP_WINDOW_MARGIN;
    let w = (size.0 * POPUP_SHARE.0).min(size.0 - 2. * margin).max(0.);
    let h = (size.1 * POPUP_SHARE.1).min(size.1 - 2. * margin).max(0.);
    let column = page_column(id, p, dd, (w, true), drawn, window, cx).flex_1();
    let frame = kit::popup_frame()
        .id("factory-card-popup")
        .debug_selector(|| "factory-card-popup".into())
        .w(px(w))
        .h(px(h))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(column);
    let at = div()
        .absolute()
        .left(px(kit::centered(w, size.0)))
        .top(px(kit::centered(h, size.1)))
        .child(frame);
    let scrim = div()
        .id("factory-card-popup-scrim")
        .debug_selector(|| "factory-card-popup-scrim".into())
        .absolute()
        .top_0()
        .left_0()
        .w(px(size.0))
        .h(px(size.1))
        .bg(gpui_kit::rgba(crate::terminal::palette().backdrop))
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
    // a drag over its words selects them, the view's own region being under the scrim
    let scrim = match select::drawing() {
        Some(text) => select::region(scrim, &text).child(at),
        None => scrim.child(at),
    };
    deferred(scrim).with_priority(1).into_any_element()
}

/// The popup's share of the view: its width, its height.
const POPUP_SHARE: (f32, f32) = (0.76, 0.88);

/// The Card page's column, `w` px wide inside (`popup`: the close button in its head): its head,
/// the scrolled body, Linked, the composer, the actions.
fn page_column(
    id: Option<&str>,
    p: &CardPageProps,
    dd: &DialogDraw,
    (w, popup): (f32, bool),
    drawn: &mut Drawn,
    window: &mut Window,
    cx: &mut Context<FactoryView>,
) -> gpui_kit::Div {
    let d = &p.dialog;
    drawn.add("CardPage", &d.title);
    let number = head_words(d, drawn);
    dd.scroll_to(d.card, d.scroll);
    let lk = Look {
        col_w: (w - 2. * look::ABE_DIALOG_PAD_X - side_width(d)).max(0.),
        story: true,
        page: true,
        close: popup,
    };
    let parts = parts((id, d, number), dd, lk, drawn, window, cx);
    let composer = page_composer(&p.composer, drawn, cx);
    div()
        .min_h_0()
        .flex()
        .flex_col()
        .overflow_hidden()
        .children(parts.head)
        .child(parts.body)
        .children(parts.linked)
        .child(composer)
        .child(parts.footer)
}

/// The Card page's composer over its footer: the draft (the placeholder while empty), its caret
/// only while the keys are in it; `Sending…` while it posts, why when refused. A click in it
/// names `card:composer` (the keys go there).
fn page_composer(c: &PageComposer, drawn: &mut Drawn, cx: &mut Context<FactoryView>) -> AnyElement {
    drawn.add("CardPageComposer", &c.text);
    if c.focused {
        drawn.add("CardPageComposerFocused", &c.text);
    }
    let state = match c.state {
        BoxState::Posting => Some(("Sending…".to_owned(), look::TEXT_DIM)),
        BoxState::Failed => Some((
            format!("✗ {}", c.error.as_deref().unwrap_or("not posted")),
            look::TEXT_ERROR,
        )),
        BoxState::Writing => None,
    };
    div()
        .id("factory-card-page-composer")
        .debug_selector(|| "factory-card-page-composer".into())
        .flex_none()
        .px(px(look::ABE_DIALOG_PAD_X - 4.))
        .pt(px(8.))
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(look::SEPARATOR)
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|v, _, _, cx| {
                cx.stop_propagation();
                v.send_input(
                    UserInput::Click {
                        id: "card:composer".into(),
                    },
                    cx,
                );
            }),
        )
        .child(super::comment::draft_field_keys(
            &c.text,
            c.caret,
            Some(&c.placeholder),
            "card-page",
            c.focused,
        ))
        .children(state.map(|(text, color)| {
            drawn.add("CardPageComposerState", &text);
            div()
                .px(px(4.))
                .pb(px(6.))
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(color)
                .child(SharedString::from(text))
        }))
        .into_any_element()
}

/// The story's Comments after its sections: `Comments` and how many, then each one oldest
/// first, `by · when` in the person colour over its markdown; being read, or why not.
fn comments_section(
    t: &Thread,
    i: usize,
    (card, width, on_link): (u64, f32, &OnLink),
    draw: &CardDraw,
    drawn: &mut Drawn,
    window: &mut Window,
    fetch: &mut Vec<String>,
) -> AnyElement {
    drawn.add("DialogSection", "Comments");
    let count = (t.state == ThreadState::Ready && !t.comments.is_empty())
        .then(|| t.comments.len().to_string());
    let dim = |text: String| {
        div()
            .py(px(6.))
            .text_color(look::TEXT_DIM)
            .child(select::text(text))
            .into_any_element()
    };
    let body: Vec<AnyElement> = match t.state {
        ThreadState::Loading => {
            drawn.add("DialogCommentsState", "Loading comments…");
            vec![dim("Loading comments…".into())]
        }
        ThreadState::Error => {
            let text = format!("✗ {}", t.message.as_deref().unwrap_or("failed"));
            drawn.add("DialogCommentsState", &text);
            vec![
                div()
                    .py(px(6.))
                    .text_color(look::TEXT_ERROR)
                    .child(select::text(text))
                    .into_any_element(),
            ]
        }
        ThreadState::Ready if t.comments.is_empty() => vec![dim("No comments yet".into())],
        ThreadState::Ready => t
            .comments
            .iter()
            .enumerate()
            .map(|(j, c)| {
                let by = format!("{} · {}", c.by, c.when);
                drawn.add("DialogCommentBy", &by);
                let part = StoryPart::Markdown(c.markdown.clone());
                div()
                    .debug_selector(move || format!("factory-dialog-comment-{j}"))
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(look::UI_SMALL_FONT_SIZE))
                            .text_color(look::ABE_PERSON)
                            .child(select::text(by)),
                    )
                    .child(super::story::story(
                        std::slice::from_ref(&part),
                        ("factory-dialog-comment", &format!("{card}-{j}")),
                        draw,
                        width,
                        window,
                        on_link,
                        fetch,
                        select::drawing().map(|t| t.selectable()).as_ref(),
                        None,
                    ))
                    .into_any_element()
            })
            .collect(),
    };
    div()
        .debug_selector(|| "factory-dialog-comments".into())
        .flex()
        .flex_col()
        .min_w_0()
        .pb(px(8.))
        .child(story_heading("Comments", count.as_deref(), i))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .gap(px(12.))
                .children(body),
        )
        .into_any_element()
}

/// A section heading in the story look (F-Story `.vs-story__section-head`): the title (600) and
/// its dim note, a 1 px separator 4 px under the text.
fn story_heading(title: &str, note: Option<&str>, i: usize) -> AnyElement {
    let text = div()
        .debug_selector(move || format!("factory-dialog-section-title-{i}"))
        .flex()
        .items_baseline()
        .gap(px(8.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(select::text(title.to_owned())),
        )
        .children(note.map(|n| {
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .child(select::text(n.to_owned()))
        }));
    div()
        .flex_none()
        .flex()
        .flex_col()
        .mb(px(8.))
        .child(text)
        .child(
            div()
                .debug_selector(move || format!("factory-dialog-section-rule-{i}"))
                .mt(px(4.))
                .h(px(1.))
                .bg(look::SEPARATOR),
        )
        .into_any_element()
}

/// The facts line (F-Story `.nv-story__facts`): one text, `·` between the facts, the type
/// rose for a Bug (else the story's hue), the points blue, the tags gold after a dim label; the
/// rest dim. One text so a long line still ends in an ellipsis.
fn facts_line(facts: &[DialogFact], drawn: &mut Drawn) -> AnyElement {
    let mut text = String::new();
    let mut runs = Vec::new();
    for (i, f) in facts.iter().enumerate() {
        let tone = f.tone.map(|t| match t {
            FactTone::Bug => ("bug", look::ABE_BUG),
            FactTone::Story => ("story", look::ABE_STORY),
            FactTone::Points => ("points", look::ABE_POINTS),
            FactTone::Tags => ("tags", look::ABE_TAGS),
        });
        drawn.add(
            "DialogFact",
            format!(
                "{}{}{}",
                f.label
                    .as_ref()
                    .map(|l| format!("{l}: "))
                    .unwrap_or_default(),
                f.text,
                tone.map(|(n, _)| format!(" [{n}]")).unwrap_or_default()
            ),
        );
        if i > 0 {
            text.push_str(" · ");
        }
        if let Some(l) = &f.label {
            text.push_str(l);
            text.push(' ');
        }
        let start = text.len();
        text.push_str(&f.text);
        if let Some((_, c)) = tone {
            let style = HighlightStyle {
                color: Some(c.rgba().into()),
                ..HighlightStyle::default()
            };
            runs.push((start..text.len(), style));
        }
    }
    select::styled(text, runs)
}

/// 2.0's head: the kicker row (type · `#id`, the state badge), the title and the meta line.
fn card_head(p: &CardDialogProps, number: Option<String>) -> Vec<AnyElement> {
    let kicker = div()
        .flex()
        .items_center()
        .gap(px(6.))
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .child(
            div()
                .text_color(look::ABE_STORY)
                .child(select::text(p.kicker.clone())),
        )
        .when_some(number, |d, n| {
            d.child(
                div()
                    .font(gpui_kit::font(crate::render::EDITOR_FONT))
                    .text_color(look::ABE_ACCENT)
                    .child(select::text(n)),
            )
        });
    let badge = div()
        .debug_selector(|| "factory-dialog-state".into())
        .flex_none()
        .h(px(20.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded(px(look::ABE_CARD_ARC))
        .bg(look::abe_badge_bg(look::ABE_ACCENT.rgba()))
        .text_color(look::ABE_ACCENT)
        .child(SharedString::from(p.state.clone()));
    let title_row = div()
        .flex_none()
        .h(px(look::COMPLEX_HEADER_HEIGHT))
        .pl(px(20.))
        .pr(px(8.))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .bg(look::POPUP_HEADER_BG)
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(kicker)
        .when(!p.state.is_empty(), |d| d.child(badge));
    let head = div()
        .flex_none()
        .px(px(look::ABE_DIALOG_PAD_X))
        .pt(px(16.))
        .pb(px(12.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .border_b_1()
        .border_color(look::SEPARATOR)
        .child(
            div()
                .debug_selector(|| "factory-dialog-title".into())
                .text_size(px(look::ABE_DIALOG_TITLE_SIZE))
                .line_height(px(look::ABE_DIALOG_TITLE_LINE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child(select::text(p.title.clone())),
        )
        .child(
            div()
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .text_color(look::TEXT_DIM)
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(select::text(p.meta.join(" · "))),
        );
    vec![title_row.into_any_element(), head.into_any_element()]
}

/// The story look's head (board F-Story `.nv-story__head`, padding 12 16 12 24): the dim cap and
/// the close button, `#id` (accent) and the title, the facts line.
fn story_head(
    p: &CardDialogProps,
    heading: &str,
    number: Option<String>,
    drawn: &mut Drawn,
    close: Option<impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static>,
) -> Vec<AnyElement> {
    let top = div()
        .h(px(LINK_H))
        .flex()
        .items_center()
        .justify_between()
        .child(
            div()
                .debug_selector(|| "factory-dialog-heading".into())
                .text_size(px(CAP_SIZE))
                .text_color(look::TEXT_DIM)
                .whitespace_nowrap()
                .child(select::text(heading.to_uppercase())),
        )
        .children(close.map(|close| {
            IconButton::new("factory-dialog-close", IconName::Close)
                .tooltip("Close", Some("Esc"))
                .on_click(close)
        }));
    let title = div()
        .debug_selector(|| "factory-dialog-title".into())
        .mt(px(2.))
        .flex()
        .gap(px(6.))
        .text_size(px(look::ABE_DIALOG_TITLE_SIZE))
        .line_height(px(look::ABE_DIALOG_TITLE_LINE))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(look::TEXT)
        .when_some(number, |d, n| {
            d.child(
                div()
                    .flex_none()
                    .text_color(look::ABE_ACCENT)
                    .child(select::text(n)),
            )
        })
        .child(div().min_w_0().child(select::text(p.title.clone())));
    let facts = div()
        .debug_selector(|| "factory-dialog-facts".into())
        .mt(px(4.))
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .line_height(px(18.))
        .text_color(look::TEXT_DIM)
        .whitespace_nowrap()
        .overflow_hidden()
        .text_ellipsis()
        .map(|d| {
            if p.facts.is_empty() {
                d.child(select::text(p.meta.join(" · ")))
            } else {
                d.child(facts_line(&p.facts, drawn))
            }
        });
    vec![
        div()
            .flex_none()
            .pt(px(12.))
            .pb(px(12.))
            .pl(px(look::ABE_DIALOG_PAD_X))
            .pr(px(16.))
            .flex()
            .flex_col()
            .child(top)
            .child(title)
            .child(facts)
            .into_any_element(),
    ]
}

/// The Linked block at the story's end (board F-Story `.nv-linked`): `LINKED`, then a chip per
/// row, `label words` (the label dim, the words in their hue); a dim chip is greyed and takes no
/// click, any other names its id.
fn linked_block<F, H>(links: &[DialogLink], drawn: &mut Drawn, press: &F) -> AnyElement
where
    F: Fn(String) -> H,
    H: Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
{
    let chips = links.iter().map(|l| {
        let text = match &l.state {
            Some(st) => format!("{} {} {st}", l.label, l.words),
            None => format!("{} {}", l.label, l.words),
        };
        drawn.add(if l.dim { "DialogLinkDim" } else { "DialogLink" }, text);
        // the hue is the state's (`● Running`), else the words'; the stage word stays plain
        let tint = l.hue.map_or(look::TEXT.rgba(), hue);
        let (label, words, state) = if l.dim {
            let off = look::TEXT_DISABLED.rgba();
            (off, off, off)
        } else if l.state.is_some() {
            (look::TEXT_DIM.rgba(), look::TEXT.rgba(), tint)
        } else {
            (look::TEXT_DIM.rgba(), tint, tint)
        };
        let sel = format!("factory-{}", l.id);
        let chip = div()
            .id(SharedString::from(sel.clone()))
            .debug_selector(move || sel.clone())
            .flex_none()
            .h(px(LINK_H))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(6.))
            .border_1()
            .border_color(look::FIELD_BORDER)
            .rounded(px(4.))
            .child(div().text_color(label).child(select::text(l.label.clone())))
            .child(div().text_color(words).child(select::text(l.words.clone())))
            .children(
                l.state
                    .as_ref()
                    .map(|st| div().text_color(state).child(select::text(st.clone()))),
            );
        if l.dim {
            chip.into_any_element()
        } else {
            chip.cursor_pointer()
                .on_click(press(l.id.clone()))
                .into_any_element()
        }
    });
    let chips: Vec<AnyElement> = chips.collect();
    div()
        .debug_selector(|| "factory-dialog-linked".into())
        .flex_none()
        .h(px(LINKED_H))
        .px(px(look::ABE_DIALOG_PAD_X))
        .flex()
        .items_center()
        .gap(px(8.))
        .border_t_1()
        .border_color(look::SEPARATOR)
        .whitespace_nowrap()
        .overflow_hidden()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(
            div()
                .mr(px(4.))
                .text_size(px(CAP_SIZE))
                .text_color(look::TEXT_DIM)
                .child(select::text("LINKED")),
        )
        .children(chips)
        .into_any_element()
}

/// The card's Sheets beside its sections (App Map V2-15): every Sheet attached to it, the
/// row the keys are on selected (Tab takes them there); a click on a row names its id.
fn sheets_column(
    sh: &DialogSheets,
    drawn: &mut Drawn,
    cx: &mut Context<FactoryView>,
) -> AnyElement {
    let note = match sh.state {
        Some(PickState::Loading) => "reading…".to_owned(),
        Some(PickState::Error) => "not read".to_owned(),
        None if sh.rows.is_empty() => "none attached".to_owned(),
        None => format!("{} · ⏎ shows", sh.rows.len()),
    };
    drawn.add("DialogSheets", format!("Sheets {note}"));
    let head = div()
        .flex()
        .items_baseline()
        .gap(px(6.))
        .mb(px(4.))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(look::TEXT)
                .child("Sheets"),
        )
        .child(
            div()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(note)),
        );
    let body: Vec<AnyElement> = match (&sh.state, &sh.message) {
        (Some(PickState::Error), message) => vec![
            div()
                .text_color(look::ABE_BAD)
                .child(SharedString::from(format!(
                    "✗ {}",
                    message.clone().unwrap_or_default()
                )))
                .into_any_element(),
        ],
        _ => sh
            .rows
            .iter()
            .map(|r| {
                let selected = sh.selected.as_deref() == Some(r.id.as_str());
                drawn.add(
                    if selected {
                        "DialogSheetSelected"
                    } else {
                        "DialogSheet"
                    },
                    match &r.dim {
                        Some(d) => format!("{} · {d}", r.title),
                        None => r.title.clone(),
                    },
                );
                let id = r.id.clone();
                let sel = format!("factory-dialog-{id}");
                let bg = match (selected, sh.focused) {
                    (true, true) => Some(look::SELECTION_BG),
                    (true, false) => Some(look::SELECTION_BG_INACTIVE),
                    _ => None,
                };
                let mut row = div()
                    .id(SharedString::from(sel.clone()))
                    .debug_selector(move || sel.clone())
                    .h(px(look::LIST_ROW_HEIGHT.get()))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(look::LIST_SELECTION_ARC))
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .cursor_pointer()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |v, _, _, cx| {
                            cx.stop_propagation();
                            v.send_input(UserInput::Click { id: id.clone() }, cx);
                        }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_color(look::TEXT)
                            .child(SharedString::from(r.title.clone())),
                    )
                    .children(r.dim.as_ref().map(|d| {
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(format!("· {d}")))
                    }));
                if let Some(bg) = bg {
                    row = row.bg(bg);
                }
                row.into_any_element()
            })
            .collect(),
    };
    div()
        .debug_selector(|| "factory-dialog-sheets".into())
        .flex_none()
        .w(px(look::ABE_DIALOG_SIDE_WIDTH))
        .h_full()
        .border_l_1()
        .border_color(look::SEPARATOR)
        .px(px(16.))
        .py(px(14.))
        .flex()
        .flex_col()
        .text_size(px(look::UI_SMALL_FONT_SIZE))
        .child(head)
        .children(body)
        .into_any_element()
}
