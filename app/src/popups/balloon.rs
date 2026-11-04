//! Notification balloons (`vim.notify` through snacks' notifier, `config/app/balloon.lua`): bottom
//! right, WebStorm's look (level icon, bold title, the message wrapped under it), a click closes
//! one (it never takes the keyboard). The snacks notifier's rules: stacked with the newest on top
//! (`top_down = false`), only as many as fit above the status bar (the rest wait for room), each
//! at most 0.6 of the window high (`height.max`, the message cut with "…"), its timeout counted
//! from when it shows; same id = replaced in place (snacks' `id` / `replace`).
//!
//! Errors (one rule for every balloon, the bridge's `abe/packages/ui/src/runtime/errors.ts` says the
//! same): an error fades after [`ERROR_TIMEOUT`] and its reading time, or at the next key or click
//! once it has been up [`INPUT_GRACE`] ([`Balloons::dismiss_on_input`]); a hovered one stays until
//! the mouse leaves, then counts again. Only one that needs you (no timeout: Abe's `stays`) stays
//! until it is closed, its action taken or its cause gone. Every error shown goes to the history
//! (`errors.rs`, the status bar's `⚠ N`).

use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, BoxShadow, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, Pixels, SharedString, Size,
    StatefulInteractiveElement as _, Styled as _, Window, deferred, div, point,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use super::text_width;
use crate::kit::{Icon, IconName};
use crate::look;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Level {
    #[default]
    Info,
    Warning,
    Error,
    Debug,
    Trace,
}

/// What a balloon's action does.
pub type ActionRun = Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>;

/// A balloon's action link (`Log in…`, `Retry`): a click runs it; a balloon that stays
/// (no timeout) stays on until it is closed or dropped, any other closes.
#[derive(Clone)]
pub struct BalloonAction {
    pub label: SharedString,
    pub run: ActionRun,
}

impl std::fmt::Debug for BalloonAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BalloonAction")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

/// A balloon to show ([`super::notify`]).
#[derive(Clone, Debug)]
pub struct Balloon {
    /// Same id: replaces that balloon (None: a new one).
    pub id: Option<String>,
    pub level: Level,
    pub title: Option<SharedString>,
    pub body: SharedString,
    /// None: stays until clicked.
    pub timeout: Option<Duration>,
    /// Its action link under the text.
    pub action: Option<BalloonAction>,
    /// Where it was said, for the error history (None: its title).
    pub source: Option<SharedString>,
}

/// The notifier's timeout (plugins/ui.lua).
const TIMEOUT: Duration = Duration::from_millis(4000);
/// An error's least time on screen (`ERROR_FADE_MS` in the bridge's `errors.ts`).
pub const ERROR_TIMEOUT: Duration = Duration::from_secs(8);
/// A key or a click this soon after an error showed takes nothing away.
pub const INPUT_GRACE: Duration = Duration::from_secs(1);
/// A warning's least time on screen (long enough to read what to do).
const WARNING_TIMEOUT: Duration = Duration::from_secs(10);
/// Reading time per word on top (~240 words a minute).
const PER_WORD: Duration = Duration::from_millis(250);
/// The longest a balloon that times out stays.
const MAX_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a balloon stays: its base time (an error 8 s, a warning 10 s) plus the
/// time to read it, 30 s at most. One that needs you has no timeout (its caller's None).
pub fn reading_time(level: Level, title: &str, body: &str) -> Option<Duration> {
    let base = match level {
        Level::Error => ERROR_TIMEOUT,
        Level::Warning => WARNING_TIMEOUT,
        Level::Info | Level::Debug | Level::Trace => TIMEOUT,
    };
    let words = title.split_whitespace().count() + body.split_whitespace().count();
    let words = u32::try_from(words).unwrap_or(u32::MAX);
    Some((base + PER_WORD.saturating_mul(words)).min(MAX_TIMEOUT))
}
/// Waiting + shown balloons kept at most (the oldest go first).
const KEPT: usize = 50;
/// snacks' `height.max`: of the window's height.
const MAX_HEIGHT: f32 = 0.6;
/// Text line height (explicit, so heights are known before layout).
const LINE_HEIGHT: f32 = look::BALLOON_LINE_HEIGHT;

impl Balloon {
    pub fn info(title: impl Into<SharedString>, body: impl Into<SharedString>) -> Self {
        Self::new(Level::Info, title, body)
    }

    pub fn error(title: impl Into<SharedString>, body: impl Into<SharedString>) -> Self {
        Self::new(Level::Error, title, body)
    }

    pub fn new(
        level: Level,
        title: impl Into<SharedString>,
        body: impl Into<SharedString>,
    ) -> Self {
        let title: SharedString = title.into();
        Self {
            id: None,
            level,
            title: (!title.is_empty()).then_some(title),
            body: body.into(),
            timeout: Some(TIMEOUT),
            action: None,
            source: None,
        }
    }

    /// The timeout the rule gives it: an error that fades stays at least its reading time.
    fn ruled(mut self) -> Self {
        if self.level == Level::Error
            && let Some(t) = self.timeout
        {
            let title = self.title.as_deref().unwrap_or_default();
            let read = reading_time(Level::Error, title, &self.body).unwrap_or(t);
            self.timeout = Some(t.max(read));
        }
        self
    }

    /// An error that fades: the next key or click takes it away.
    fn fades_on_input(&self) -> bool {
        self.level == Level::Error && self.timeout.is_some()
    }
}

/// `{ event = "balloon", id, level, title, msg, timeout, action }` (config/app/balloon.lua).
#[derive(Debug, Deserialize)]
pub(super) struct LuaBalloon {
    id: String,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    msg: Option<String>,
    /// ms; 0 = until closed
    #[serde(default)]
    timeout: Option<u64>,
    /// Its action link's label: a click calls Lua's `act(id)` (`run`)
    #[serde(default)]
    action: Option<String>,
}

impl LuaBalloon {
    /// `run(id)`: what its action link's click does (asks Lua)
    pub(super) fn into_balloon(self, run: impl FnOnce(String) -> ActionRun) -> Balloon {
        let level = match self.level.as_deref() {
            Some("error") => Level::Error,
            Some("warn") => Level::Warning,
            Some("debug") => Level::Debug,
            Some("trace") => Level::Trace,
            _ => Level::Info,
        };
        let action = self
            .action
            .filter(|l| !l.is_empty())
            .map(|label| BalloonAction {
                label: label.into(),
                run: run(self.id.clone()),
            });
        Balloon {
            id: Some(self.id),
            level,
            title: self.title.filter(|t| !t.is_empty()).map(Into::into),
            body: self.msg.unwrap_or_default().into(),
            timeout: match self.timeout {
                Some(0) => None,
                Some(ms) => Some(Duration::from_millis(ms)),
                None => Some(TIMEOUT),
            },
            action,
            source: None,
        }
    }
}

struct Shown {
    id: String,
    balloon: Balloon,
    /// Bumped on replace: an older timer doesn't close the new content.
    generation: u64,
    hovered: bool,
    /// Its timeout runs (it has been on screen).
    timer: bool,
    /// When it first came on screen (the executor's clock: a test's advances it).
    shown_at: Option<Instant>,
    /// Its timeout ended while it was hovered: it goes once the mouse leaves (after a new one).
    lapsed: bool,
}

/// A balloon's timer to start: (id, generation, timeout).
pub type Timer = (String, u64, Duration);

/// A view that draws a stack of balloons (the popups surface; Abe mode, which runs no project's).
pub trait BalloonHost: 'static {
    fn balloons_mut(&mut self) -> &mut Balloons;
}

/// The balloons a host shows (see the module doc).
#[derive(Default)]
pub struct Balloons {
    list: Vec<Shown>,
    generation: u64,
    next_id: u64,
    /// Ids on screen at the last layout.
    visible: Vec<String>,
}

impl Balloons {
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// On screen: (title, body), oldest first.
    pub fn list(&self) -> Vec<(String, String)> {
        self.list
            .iter()
            .filter(|s| self.visible.contains(&s.id))
            .map(|s| {
                (
                    s.balloon.title.as_deref().unwrap_or_default().to_string(),
                    s.balloon.body.to_string(),
                )
            })
            .collect()
    }

    /// Ids on screen, oldest first (their elements: `balloon-<id>`).
    pub fn visible_ids(&self) -> Vec<String> {
        // (hidden since the last layout: gone)
        self.visible
            .iter()
            .filter(|id| self.list.iter().any(|s| &s.id == *id))
            .cloned()
            .collect()
    }

    /// Waiting for room (not on screen yet).
    pub fn waiting(&self) -> usize {
        self.list.len() - self.visible_ids().len()
    }

    /// Queues (or replaces) a balloon: its id.
    pub fn show(&mut self, balloon: Balloon) -> String {
        let balloon = balloon.ruled();
        self.generation += 1;
        let id = balloon.id.clone().unwrap_or_else(|| {
            self.next_id += 1;
            format!("rust-{}", self.next_id)
        });
        let generation = self.generation;
        if let Some(s) = self.list.iter_mut().find(|s| s.id == id) {
            // replaced: its timeout starts again
            s.balloon = balloon;
            s.generation = generation;
            s.timer = false;
            s.shown_at = None;
            s.lapsed = false;
        } else {
            self.list.push(Shown {
                id: id.clone(),
                balloon,
                generation,
                hovered: false,
                timer: false,
                shown_at: None,
                lapsed: false,
            });
            if self.list.len() > KEPT {
                self.list.remove(0);
            }
        }
        id
    }

    /// Timer end: true when it closed the balloon. A hovered one stays: it lapses, and
    /// counts again once the mouse leaves.
    pub fn expire(&mut self, id: &str, generation: u64) -> bool {
        if let Some(s) = self
            .list
            .iter_mut()
            .find(|s| s.id == id && s.generation == generation && s.hovered)
        {
            s.lapsed = true;
            return false;
        }
        let before = self.list.len();
        self.list
            .retain(|s| !(s.id == id && s.generation == generation));
        self.list.len() != before
    }

    /// A key or a click that does something else: the errors that fade go, once up
    /// [`INPUT_GRACE`] and not under the mouse. True when one went.
    pub fn dismiss_on_input(&mut self, now: Instant) -> bool {
        let before = self.list.len();
        self.list.retain(|s| {
            let up = s
                .shown_at
                .is_some_and(|at| now.saturating_duration_since(at) >= INPUT_GRACE);
            !(s.balloon.fades_on_input() && up && !s.hovered)
        });
        self.list.len() != before
    }

    /// Hides one balloon (None: all).
    pub fn hide(&mut self, id: Option<&str>) {
        match id {
            Some(id) => self.list.retain(|s| s.id != id),
            None => self.list.clear(),
        }
    }

    pub fn hover(&mut self, id: &str, hovered: bool) -> bool {
        let generation = self.generation + 1;
        match self.list.iter_mut().find(|s| s.id == id) {
            Some(s) if s.hovered != hovered => {
                s.hovered = hovered;
                // its time ran out under the mouse: a new timeout from now (the next render)
                if !hovered && s.lapsed {
                    s.lapsed = false;
                    s.timer = false;
                    s.generation = generation;
                    self.generation = generation;
                }
                true
            }
            _ => false,
        }
    }

    /// The stack bottom right, `above` px over the window's bottom edge (the status bar), as
    /// many as fit in `room` px (oldest first, at the bottom); the timers of balloons shown for
    /// the first time.
    pub fn render<T: BalloonHost>(
        &mut self,
        viewport: Size<Pixels>,
        above: Pixels,
        room: Pixels,
        window: &Window,
        cx: &mut Context<T>,
    ) -> (AnyElement, Vec<Timer>) {
        let cap = viewport.height * MAX_HEIGHT;
        let mut used = px(0.);
        let mut shown: Vec<(usize, Fit)> = Vec::new();
        for (ix, s) in self.list.iter().enumerate() {
            let f = fit(&s.balloon, cap, window);
            if !shown.is_empty() && used + f.height > room {
                break; // the rest wait for room (snacks shows them once it frees)
            }
            used += f.height + px(look::BALLOON_GAP);
            shown.push((ix, f));
        }
        self.visible = shown
            .iter()
            .map(|&(i, _)| self.list[i].id.clone())
            .collect();
        let mut timers = Vec::new();
        let now = cx.background_executor().now();
        for &(i, _) in &shown {
            let s = &mut self.list[i];
            if !s.timer {
                s.timer = true;
                s.shown_at.get_or_insert(now);
                if let Some(t) = s.balloon.timeout {
                    timers.push((s.id.clone(), s.generation, t));
                }
            }
        }
        let stack = div()
            .absolute()
            .right(px(look::BALLOON_MARGIN))
            .bottom(above + px(look::BALLOON_MARGIN))
            .flex()
            .flex_col()
            .items_end()
            .gap(px(look::BALLOON_GAP))
            .children(
                shown
                    .iter()
                    .rev()
                    .map(|&(i, f)| balloon(&self.list[i], f, cx)),
            );
        // a window-sized box (no listeners: never hit) to place the stack in
        let window_box = div()
            .absolute()
            .top_0()
            .left_0()
            .w(viewport.width)
            .h(viewport.height)
            .child(stack);
        (
            deferred(window_box).with_priority(1).into_any_element(),
            timers,
        )
    }
}

/// Starts the timeouts of balloons that just came on screen (snacks counts from when one shows).
pub fn start_timers<T: BalloonHost>(timers: Vec<Timer>, cx: &mut Context<T>) {
    for (id, generation, t) in timers {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(t).await;
            let _ = this.update(cx, |host, cx| {
                if host.balloons_mut().expire(&id, generation) {
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

/// Text column width.
fn text_room() -> Pixels {
    px(look::BALLOON_WIDTH
        - look::BALLOON_TEXT_X
        - look::BALLOON_PADDING_RIGHT
        - 2. * look::POPUP_BORDER_WIDTH)
}

/// Lines `text` wraps to in the text column (a word-wrap estimate from its width).
fn wrapped_lines(text: &str, weight: FontWeight, window: &Window) -> usize {
    let room = text_room().as_f32();
    text.split('\n')
        .map(|l| {
            // word wrap leaves the ends of lines empty: ~10% more than the bare width
            let w = text_width(window, l, weight).as_f32() * 1.1;
            ((w / room).ceil() as usize).max(1)
        })
        .sum()
}

/// How a balloon is laid out: its height, the body lines it shows, and WebStorm's vertical
/// layout (BalloonLayoutConfiguration.create: content longer than one line under a title, or
/// two without one, is `treeLines` (7 / 3 / 8), the rest `twoLines` (11 / 5 / 14)).
#[derive(Clone, Copy, Debug)]
struct Fit {
    height: Pixels,
    lines: usize,
    top: f32,
    gap: f32,
    bottom: f32,
}

/// The title's weight: bold only over a message (NotificationsUtil.buildHtml `boldTitle`).
fn title_weight(b: &Balloon) -> FontWeight {
    if b.body.is_empty() {
        FontWeight::NORMAL
    } else {
        FontWeight::BOLD
    }
}

/// A balloon's [`Fit`], its height capped at `cap`.
fn fit(b: &Balloon, cap: Pixels, window: &Window) -> Fit {
    let body = if b.body.is_empty() {
        0
    } else {
        wrapped_lines(&b.body, FontWeight::NORMAL, window)
    };
    let long = body > if b.title.is_some() { 1 } else { 2 };
    let (top, gap, bottom) = if long {
        (
            look::BALLOON_LONG_PADDING_TOP,
            look::BALLOON_LONG_TITLE_GAP,
            look::BALLOON_LONG_PADDING_BOTTOM,
        )
    } else {
        (
            look::BALLOON_PADDING_TOP,
            look::BALLOON_TITLE_GAP,
            look::BALLOON_PADDING_BOTTOM,
        )
    };
    // its action's link a line of its own under the text
    let action = if b.action.is_some() {
        gap + LINE_HEIGHT
    } else {
        0.
    };
    let chrome = top + bottom + 2. * look::POPUP_BORDER_WIDTH + action;
    let title = b.title.as_ref().map_or(0., |t| {
        let gap = if body > 0 { gap } else { 0. };
        wrapped_lines(t, title_weight(b), window) as f32 * LINE_HEIGHT + gap
    });
    let room = ((cap.as_f32() - chrome - title) / LINE_HEIGHT)
        .floor()
        .max(1.) as usize;
    let lines = body.min(room);
    Fit {
        height: px(chrome + title + lines as f32 * LINE_HEIGHT),
        lines,
        top,
        gap,
        bottom,
    }
}

fn balloon<T: BalloonHost>(s: &Shown, f: Fit, cx: &mut Context<T>) -> AnyElement {
    let b = &s.balloon;
    let icon = match b.level {
        Level::Info => IconName::Info,
        Level::Warning => IconName::Warning,
        Level::Error => IconName::Error,
        // snacks' debug / trace glyph is the debugger's bug: WebStorm's debug icon
        Level::Debug | Level::Trace => IconName::Debug,
    };
    let id = s.id.clone();
    let (click, hover, title_id) = (id.clone(), id.clone(), id.clone());
    // its action: a click runs it; one that needs you stays until its cause is gone (the
    // host drops it), any other closes
    let stays = b.timeout.is_none();
    let action = b.action.clone().map(|a| {
        let (selector, closes) = (id.clone(), id.clone());
        div()
            .id(SharedString::from(format!("balloon-action-{id}")))
            .debug_selector(move || format!("balloon-action-{selector}"))
            .text_color(look::LINK)
            .cursor_pointer()
            .child(a.label)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this: &mut T, _: &MouseDownEvent, window, cx| {
                    if !stays {
                        this.balloons_mut().hide(Some(&closes));
                    }
                    cx.stop_propagation();
                    cx.notify();
                    (a.run)(window, cx);
                }),
            )
    });
    div()
        .id(SharedString::from(format!("balloon-{id}")))
        .debug_selector(move || format!("balloon-{id}"))
        .relative()
        .w(px(look::BALLOON_WIDTH))
        .flex()
        .pt(px(f.top))
        .pb(px(f.bottom))
        .bg(look::BALLOON_BG)
        .border_1()
        .border_color(look::BALLOON_BORDER)
        .rounded(px(look::BALLOON_ARC))
        .shadow(vec![BoxShadow {
            color: look::hsla(look::BALLOON_SHADOW.rgba()),
            offset: point(px(0.), px(0.)),
            blur_radius: px(look::BALLOON_SHADOW_SIZE),
            spread_radius: px(0.),
            inset: false,
        }])
        .font_family(crate::render::UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .line_height(px(LINE_HEIGHT))
        .text_color(look::BALLOON_FG)
        .occlude()
        .cursor_pointer()
        .on_hover(cx.listener(move |this: &mut T, h: &bool, _, cx| {
            if this.balloons_mut().hover(&hover, *h) {
                cx.notify();
            }
        }))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this: &mut T, _: &MouseDownEvent, _, cx| {
                this.balloons_mut().hide(Some(&click));
                cx.stop_propagation();
                cx.notify();
            }),
        )
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(|_: &mut T, _: &MouseDownEvent, _, cx| cx.stop_propagation()),
        )
        // icon column: iconOffset (10, top inset) after the 4 px border inset; the text column
        // after WebStorm's 32 px icon panel and its 2 px gap
        .child(
            div()
                .flex_none()
                .w(px(look::BALLOON_TEXT_X))
                .pl(px(look::BALLOON_PADDING_LEFT + look::BALLOON_ICON_X))
                .child(Icon::new(icon)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .pr(px(look::BALLOON_PADDING_RIGHT))
                .flex()
                .flex_col()
                .gap(px(f.gap))
                .children(b.title.clone().map(|t| {
                    div()
                        .debug_selector(move || format!("balloon-title-{title_id}"))
                        .font_weight(title_weight(b))
                        .child(t)
                }))
                .when(f.lines > 0, |d| {
                    d.child(
                        div()
                            .line_clamp(f.lines)
                            .text_ellipsis()
                            .child(b.body.clone()),
                    )
                })
                .children(action),
        )
        .when(s.hovered, |d| {
            d.child(
                div()
                    .absolute()
                    .top(px(look::BALLOON_CLOSE_OFFSET))
                    .right(px(look::BALLOON_CLOSE_OFFSET))
                    .child(Icon::new(IconName::CloseSmall)),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_fades_and_the_rest_stay_as_long_as_their_words() {
        // An error fades too, 8 s on top of its words
        assert_eq!(
            reading_time(Level::Error, "Abe", "Terminate refused"),
            Some(Duration::from_millis(8750))
        );
        let short = reading_time(Level::Info, "Abe", "Comment posted");
        let long = reading_time(Level::Info, "Abe", &"word ".repeat(20));
        assert_eq!(short, Some(Duration::from_millis(4750)));
        assert_eq!(long, Some(Duration::from_millis(9250)));
        let warning = reading_time(Level::Warning, "", "profile-not-stored");
        assert_eq!(warning, Some(Duration::from_millis(10_250)));
        let huge = reading_time(Level::Warning, "", &"w ".repeat(500));
        assert_eq!(huge, Some(MAX_TIMEOUT));
        // the rest of the app's balloons keep the notifier's time, an error at least its own
        assert_eq!(
            Balloon::info("Git", "pushed").ruled().timeout,
            Some(TIMEOUT)
        );
        assert_eq!(
            Balloon::error("Git", "push failed").ruled().timeout,
            Some(Duration::from_millis(8750))
        );
        // one that needs you (no timeout) stays
        let stays = Balloon {
            timeout: None,
            ..Balloon::error("Abe", "login expired")
        };
        assert_eq!(stays.ruled().timeout, None);
    }

    /// One balloon shown at `at` (as `render` marks it).
    fn shown(b: &mut Balloons, balloon: Balloon, at: Instant) -> String {
        let id = b.show(balloon);
        let s = b.list.iter_mut().find(|s| s.id == id).unwrap();
        s.timer = true;
        s.shown_at = Some(at);
        id
    }

    #[test]
    fn the_next_key_or_click_takes_an_error_that_fades() {
        let mut b = Balloons::default();
        let t0 = Instant::now();
        shown(&mut b, Balloon::error("Abe", "boom"), t0);
        shown(&mut b, Balloon::info("Git", "pushed"), t0);
        let stays = Balloon {
            id: Some("login".into()),
            timeout: None,
            ..Balloon::error("Abe", "login expired")
        };
        shown(&mut b, stays, t0);
        let hovered = shown(&mut b, Balloon::error("Abe", "under the mouse"), t0);
        b.hover(&hovered, true);
        // the key that made it, as it came: nothing goes
        assert!(!b.dismiss_on_input(t0 + Duration::from_millis(500)));
        assert_eq!(b.list.len(), 4);
        // a second later: the error that fades goes; the info, the one that needs you and the
        // hovered one stay
        assert!(b.dismiss_on_input(t0 + INPUT_GRACE));
        let left: Vec<_> = b.list.iter().map(|s| s.balloon.body.to_string()).collect();
        assert_eq!(left, ["pushed", "login expired", "under the mouse"]);
    }

    #[test]
    fn hovering_keeps_it_then_it_counts_again() {
        let mut b = Balloons::default();
        let id = shown(&mut b, Balloon::error("Abe", "boom"), Instant::now());
        let g = b.list[0].generation;
        b.hover(&id, true);
        // its time runs out under the mouse: it stays
        assert!(!b.expire(&id, g));
        assert_eq!(b.list.len(), 1);
        // the mouse leaves: a new timeout starts (the old one closes nothing)
        b.hover(&id, false);
        assert!(!b.list[0].timer);
        assert!(!b.expire(&id, g));
        let g2 = b.list[0].generation;
        assert!(b.expire(&id, g2));
    }

    #[test]
    fn replace_expire_and_keep() {
        let mut b = Balloons::default();
        let a = b.show(Balloon::info("A", "one"));
        b.show(Balloon {
            id: Some("x".into()),
            ..Balloon::info("X", "1")
        });
        let g1 = b.list[1].generation;
        let x = b.show(Balloon {
            id: Some("x".into()),
            ..Balloon::info("X", "2")
        });
        assert_eq!(b.list.len(), 2);
        assert_eq!(b.list[1].balloon.body.as_ref(), "2");
        // the first timer of a replaced balloon doesn't close it
        assert!(!b.expire(&x, g1));
        let gx = b.list[1].generation;
        assert!(b.expire(&x, gx));
        let ga = b.list[0].generation;
        assert!(b.expire(&a, ga));
        assert!(b.is_empty());
        for i in 0..KEPT + 3 {
            b.show(Balloon::info(format!("{i}"), ""));
        }
        assert_eq!(b.list.len(), KEPT);
        b.hide(None);
        assert!(b.is_empty());
    }
}
