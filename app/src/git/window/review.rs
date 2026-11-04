//! PR review in the Git tool window's Log (RULES 11, GitLog "PR review in the Log"): the PR under
//! review in this worktree project. Abe 3.x's `review` screen holds it (the bridge's `review`
//! slot, `abe/packages/ui/src/review/review.ts` over `abe review …`); [`PrReview`] tells it which PR,
//! sends it what is pressed, and draws the `ReviewPane` it answers with while the Log's `PR: #n`
//! filter is set: the PR strip over the Log (state, checks, threads, the scope, Approve… /
//! Request changes… / Comment…, Open in browser, Submit review (N)), and the files pane beside the
//! table (the scope's files By heat or By folder, with their threads, drafts and reviewed marks,
//! then the scope's details text). The Log's selection is the scope (all changes, one commit, a
//! range).
//!
//! Keys while the files pane has the keyboard go to the screen (↑↓ `l ö` move, ←→ `k ä` fold, ⏎
//! the next change, ⇧⏎ the previous, Space marks reviewed, PgUp / PgDn); Tab / ⇧Tab go back to
//! the table. Its `show-diff` opens VimStorm's diff viewer through Lua (`config/app/git_changes.lua`
//! `diff`, the scope's base left, its head right, at the change's line).
//!
//! Review comments and the verdict: the diff opened here is a PR diff (`review = {pr}` to Lua),
//! where `config/app/review.lua`'s `,ic` / `,ip` / `,it` / `,iu` / `,in` notify this review over
//! its bridge (`vimstorm.git_review`: comment, post_now, reply, resolve, verdict, next); each goes
//! to the screen as its `review` ask. Its answer to them comes back as `review-said`, a balloon in
//! Lua (`config.app.review.said`). The verdict is the Submit review dialog ([`super::submit`]),
//! opened by the strip's buttons, `,ia` / `,ir` / `,is` (`submit {verdict}`) and the Log's menu.

use std::collections::BTreeMap;
use std::path::PathBuf;

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, Global, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, ParentElement as _, Pixels, Point, Render, Rgba, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::factory::FactoryView;
use crate::factory::{
    DiffFile, DiffPr, Drafted, Lifecycle, NodeKind, PaneLine, ReviewAsk, ReviewPaneProps,
    ReviewTone, Scope, Side, Strip, Verdict,
};
use crate::factory::{Node, Slot, UserInput};
use crate::git::window::GitCx;
use crate::kit::{ChangeStatus, chevron_x};
use crate::kit::{Icon, IconName, for_file};
use crate::kit::{IconButton, TextButton};
use crate::look;
use crate::render::{EDITOR_FONT, ui_font};

/// The review's own bridge name (`config/app/review.lua`).
pub const BRIDGE: &str = "git_review";

/// The screen the `review` slot opens.
pub const SCREEN: &str = "review";

/// The Factory view whose bridge holds the reviews, set as the projects window makes it.
#[derive(Clone)]
pub struct ReviewBridge(pub WeakEntity<FactoryView>);

impl Global for ReviewBridge {}

/// A sha as the Log's hash column shows it: its first 8 characters.
pub fn sha8(sha: &str) -> &str {
    sha.get(..8).unwrap_or(sha)
}

/// What opens a review: the PR, and the checkout it is reviewed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewOpen {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    /// The worktree the PR is checked out in (the main checkout when the checkout failed).
    pub path: PathBuf,
    /// Why it could not be checked out: its files are GitHub's, ⏎ cannot open them.
    pub unchecked: Option<String>,
}

/// What the files pane tells the Log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrReviewEvent {
    /// Tab / ⇧Tab: back to the table.
    Back,
}

/// A change the screen showed in VimStorm's diff viewer (tests read them).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffShown {
    pub root: String,
    pub files: Vec<DiffFile>,
    /// 1-based, into `files`.
    pub index: usize,
    pub base: String,
    pub head: String,
    pub line: u32,
}

pub struct PrReview {
    gcx: GitCx,
    /// The files pane's keyboard.
    focus: FocusHandle,
    open: Option<ReviewOpen>,
    /// The bridge's view, and its trees followed.
    factory: Option<WeakEntity<FactoryView>>,
    _sub: Option<Subscription>,
    /// This review's pane as the screen last drew it.
    pane: Option<ReviewPaneProps>,
    /// The diffs the screen showed, in order (tests).
    shown: Vec<DiffShown>,
    /// The drafts waiting as last told to Lua.
    drafted: Option<Vec<Drafted>>,
    saved_review: Option<Option<crate::factory::Saved>>,
    discussions: Option<(Vec<crate::factory::Thread>, Option<String>)>,
    /// The files pane's order: By heat (remembered across reviews), else By folder.
    heat: bool,
    /// A right-click's menu waits for the cursor to be on its line (the screen's answer).
    menu_at: Option<(usize, Point<Pixels>)>,
    /// The Submit review dialog, while open (G19).
    pub(crate) submit: Option<Entity<super::submit::SubmitDialog>>,
    /// Who had the keyboard when the dialog opened (the diff, the Log): it goes back there.
    submit_from: Option<FocusHandle>,
    /// The diff's writing card, while one is open (G21).
    writing: Option<super::writing::Writing>,
    /// Who had the keyboard when the card opened (the diff): it goes back there.
    writing_from: Option<FocusHandle>,
    /// The conversation's comment field (⌘⏎ posts it).
    say: Entity<crate::kit::TextArea>,
}

/// `vimstorm.git_review` (config/app/review.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ReviewEvent {
    Comment {
        path: String,
        side: String,
        line: u32,
        #[serde(default)]
        start_line: Option<u32>,
        body: String,
        old: String,
        new: String,
        /// An outdated draft's Rewrite: the draft it replaces, deleted once this one is kept.
        #[serde(default)]
        replaces: Option<u64>,
    },
    PostNow {
        path: String,
        side: String,
        line: u32,
        #[serde(default)]
        start_line: Option<u32>,
        body: String,
        old: String,
        new: String,
    },
    Reply {
        thread: String,
        body: String,
    },
    Resolve {
        thread: String,
        resolved: bool,
    },
    /// A draft card's Edit draft.
    Edit {
        seq: u64,
        body: String,
    },
    /// `,ia` / `,ir` / `,is`: the Submit review dialog with that verdict picked.
    Submit {
        #[serde(default)]
        verdict: Option<String>,
    },
    Verdict {
        verdict: String,
        #[serde(default)]
        body: String,
    },
    Next,
    /// The writing card opened (`,ic`, `,ip`, Edit draft, Rewrite).
    Write(super::writing::WriteEvent),
    /// Its file left the diff: it closes unanswered.
    WriteCancel {
        token: u64,
    },
    /// Keys typed before the card's field had the keyboard, held by nvim (answering `focused`).
    Typeahead {
        #[serde(default)]
        keys: Vec<String>,
        #[serde(default)]
        token: Option<u64>,
    },
}

impl ReviewEvent {
    /// The screen's ask, for what Lua said (the card's own events are the window's).
    fn ask(self) -> Option<ReviewAsk> {
        Some(match self {
            ReviewEvent::Comment {
                path,
                side,
                line,
                start_line,
                body,
                old,
                new,
                replaces,
            } => ReviewAsk::Comment {
                path,
                side: Side::of(&side)?,
                line,
                start: start_line,
                body,
                base: old,
                head: new,
                now: None,
                replaces,
            },
            ReviewEvent::PostNow {
                path,
                side,
                line,
                start_line,
                body,
                old,
                new,
            } => ReviewAsk::Comment {
                path,
                side: Side::of(&side)?,
                line,
                start: start_line,
                body,
                base: old,
                head: new,
                now: Some(true),
                replaces: None,
            },
            ReviewEvent::Reply { thread, body } => ReviewAsk::Reply { thread, body },
            ReviewEvent::Resolve { thread, resolved } => ReviewAsk::Resolve { thread, resolved },
            ReviewEvent::Edit { seq, body } => ReviewAsk::Edit { seq, body },
            ReviewEvent::Verdict { verdict, body } => ReviewAsk::Verdict {
                verdict: Verdict::of_event(&verdict)?,
                body,
            },
            ReviewEvent::Next => ReviewAsk::Next,
            ReviewEvent::Submit { .. }
            | ReviewEvent::Write(_)
            | ReviewEvent::WriteCancel { .. }
            | ReviewEvent::Typeahead { .. } => return None,
        })
    }
}

/// The keys the files pane hands its screen (the rest stay the view's and nvim's).
const PANE_KEYS: [&str; 16] = [
    "l",
    "ö",
    "k",
    "ä",
    "<Up>",
    "<Down>",
    "<Left>",
    "<Right>",
    "<PageUp>",
    "<PageDown>",
    "<CR>",
    "<S-CR>",
    "<Space>",
    "<Home>",
    "<End>",
    // Read Again
    "r",
];

fn heat_color(heat: &str) -> Rgba {
    match heat {
        "5" | "4" => look::ABE_BAD.rgba(),
        "3" => look::ABE_WARN.rgba(),
        "·" => look::TEXT_DISABLED.rgba(),
        _ => look::TEXT_DIM.rgba(),
    }
}

fn status_color(status: &str) -> Rgba {
    ChangeStatus::from_letter(status.chars().next().unwrap_or('M'))
        .unwrap_or(ChangeStatus::Modified)
        .color()
}

fn tone_color(tone: ReviewTone) -> Rgba {
    match tone {
        ReviewTone::Info => look::TEXT_DIM.rgba(),
        ReviewTone::Ok => look::ABE_GOOD.rgba(),
        ReviewTone::Warn => look::ABE_WARN.rgba(),
        ReviewTone::Error => look::ABE_BAD.rgba(),
    }
}

/// A strip chip: the Abe badge at 20 tall, its hue on a faint wash (`.vs-pr-chip`).
fn chip(id: &'static str, text: String, hue: Rgba) -> AnyElement {
    let mut wash = hue;
    wash.a = look::ABE_BADGE_ALPHA;
    div()
        .debug_selector(move || id.to_owned())
        .flex_none()
        .h(px(look::PR_CHIP_HEIGHT))
        .px(px(look::PR_CHIP_PAD_X))
        .flex()
        .items_center()
        .rounded(px(look::BUTTON_ARC))
        .bg(wash)
        .text_color(hue)
        .text_size(px(look::PR_SMALL_FONT_SIZE))
        .whitespace_nowrap()
        .child(SharedString::from(text))
        .into_any_element()
}

/// The Submit review button's label: `Submit review (N)`.
pub fn submit_label(strip: &Strip) -> String {
    strip.submit_label()
}

impl PrReview {
    pub fn new(gcx: GitCx, cx: &mut Context<Self>) -> Self {
        PrReview {
            gcx,
            focus: cx.focus_handle(),
            open: None,
            factory: None,
            _sub: None,
            pane: None,
            shown: Vec::new(),
            drafted: None,
            saved_review: None,
            discussions: None,
            heat: true,
            menu_at: None,
            submit: None,
            submit_from: None,
            writing: None,
            writing_from: None,
            say: cx
                .new(|cx| crate::kit::TextArea::new(cx).placeholder("Comment on the pull request")),
        }
    }

    /// The conversation's field (tests: the test window may not show it whole).
    pub fn say_field(&self) -> &Entity<crate::kit::TextArea> {
        &self.say
    }

    /// The conversation's field has the keyboard (its Ctrl keys edit the text).
    pub fn say_typing(&self, window: &Window, cx: &App) -> bool {
        self.say.focus_handle(cx).contains_focused(window, cx)
    }

    /// The conversation's Comment (⌘⏎ in its field): posted, the field emptied.
    fn post_say(&mut self, cx: &mut Context<Self>) {
        let body = self.say.read(cx).text().to_owned();
        if body.trim().is_empty() {
            return;
        }
        self.say.update(cx, |a, cx| a.set_text("", cx));
        self.ask(ReviewAsk::Say { body }, cx);
    }

    /// The bridge's view, followed once found (none without an `abe` 2.x: the pane says so).
    fn factory(&mut self, cx: &mut Context<Self>) -> Option<Entity<FactoryView>> {
        if let Some(f) = self.factory.as_ref().and_then(WeakEntity::upgrade) {
            return Some(f);
        }
        let f = cx.try_global::<ReviewBridge>()?.0.upgrade()?;
        self._sub = Some(cx.observe(&f, |t, f, cx| t.follow(&f, cx)));
        self.factory = Some(f.downgrade());
        Some(f)
    }

    /// The `review` slot's open params for this review.
    fn params(&self) -> Option<BTreeMap<String, String>> {
        let open = self.open.as_ref()?;
        let mut params = BTreeMap::from([
            ("pr".to_owned(), open.number.to_string()),
            ("path".to_owned(), open.path.to_string_lossy().into_owned()),
            (
                "list".to_owned(),
                if self.heat { "heat" } else { "folder" }.to_owned(),
            ),
        ]);
        if let Some(why) = &open.unchecked {
            params.insert("unchecked".to_owned(), why.clone());
        }
        Some(params)
    }

    /// A PR under review here: the screen opened on it (one under review here before goes).
    pub fn start(&mut self, open: ReviewOpen, cx: &mut Context<Self>) {
        self.open = Some(open);
        self.pane = None;
        self.shown.clear();
        self.drafted = None;
        self.discussions = None;
        self.saved_review = None;
        self.submit = None;
        self.writing = None;
        self.gcx
            .scx
            .call("config.app.review", "summary", vec![Value::Nil]);
        self.reattach(cx);
        cx.notify();
    }

    /// The screen on this review again (this project shown anew: the slot holds the shown one).
    pub fn reattach(&mut self, cx: &mut Context<Self>) {
        let Some(params) = self.params() else {
            return;
        };
        if let Some(f) = self.factory(cx) {
            f.update(cx, |f, cx| f.open_in(Slot::Review, SCREEN, params, cx));
            self.follow(&f, cx);
        }
    }

    /// The PR chip's ×: no PR under review here any more (its worktree stays open).
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if self.open.take().is_none() {
            return;
        }
        self.pane = None;
        self.submit = None;
        self.writing = None;
        self.drafted = None;
        self.discussions = None;
        self.saved_review = None;
        if let Some(f) = self.factory(cx) {
            f.update(cx, |f, cx| {
                f.open_in(Slot::Review, SCREEN, BTreeMap::new(), cx)
            });
        }
        let scx = &self.gcx.scx;
        scx.call(
            "config.app.review",
            "drafts",
            vec![Value::Array(Vec::new())],
        );
        scx.call(
            "config.app.review",
            "threads",
            vec![Value::Array(Vec::new()), Value::Nil],
        );
        scx.call("config.app.review", "summary", vec![Value::Nil]);
        cx.notify();
    }

    /// The slot's tree changed: this review's pane taken when it is this review's.
    fn follow(&mut self, f: &Entity<FactoryView>, cx: &mut Context<Self>) {
        let Some(open) = &self.open else {
            return;
        };
        let root = open.path.to_string_lossy();
        let pane = match f.read(cx).slot_tree(Slot::Review) {
            Some(Node::ReviewPane { props, .. })
                if props.number == open.number && props.root == root =>
            {
                Some((**props).clone())
            }
            _ => None,
        };
        let Some(pane) = pane else {
            return;
        };
        if self.pane.as_ref() == Some(&pane) {
            return;
        }
        self.pane = Some(pane);
        self.tell_drafts();
        self.tell_discussions();
        self.open_waiting_menu(cx);
        cx.notify();
    }

    /// The screen's answer to a diff key: a balloon in the diff.
    pub fn said(&mut self, text: &str, tone: ReviewTone) {
        self.gcx.scx.call(
            "config.app.review",
            "said",
            vec![text.into(), tone.lua().into()],
        );
    }

    /// A PR is under review here.
    pub fn attached(&self) -> bool {
        self.open.is_some()
    }

    /// The PR under review.
    pub fn number(&self) -> Option<u64> {
        self.open.as_ref().map(|o| o.number)
    }

    /// The checkout the PR is reviewed in.
    pub fn root(&self) -> Option<String> {
        self.open
            .as_ref()
            .map(|o| o.path.to_string_lossy().into_owned())
    }

    /// The Submit review dialog, while open.
    pub fn submit_dialog(&self) -> Option<&Entity<super::submit::SubmitDialog>> {
        self.submit.as_ref()
    }

    /// The pane as the screen drew it; none before it answered (or without a PR).
    pub fn model(&self, _cx: &App) -> Option<ReviewPaneProps> {
        self.open.as_ref().and(self.pane.clone())
    }

    /// The PR strip, once the PR and its files are read.
    pub fn strip(&self, cx: &App) -> Option<Strip> {
        self.model(cx)?.strip
    }

    /// The diffs the screen showed in VimStorm's viewer, in order (tests).
    pub fn diffs_shown(&self) -> &[DiffShown] {
        &self.shown
    }

    /// The drafts waiting, to Lua whenever they change (the diff's gutter marks).
    fn tell_drafts(&mut self) {
        let Some(model) = self.pane.clone() else {
            return;
        };
        if self.saved_review.as_ref() != Some(&model.saved) {
            let summary = model
                .saved
                .as_ref()
                .map(|r| {
                    Value::Map(vec![
                        ("body".into(), r.body.as_str().into()),
                        ("head".into(), r.head.as_str().into()),
                        ("verdict".into(), r.verdict.event().into()),
                    ])
                })
                .unwrap_or(Value::Nil);
            self.gcx
                .scx
                .call("config.app.review", "summary", vec![summary]);
            self.saved_review = Some(model.saved.clone());
        }
        if self.drafted.as_ref() == Some(&model.drafted) {
            return;
        }
        let list = Value::Array(
            model
                .drafted
                .iter()
                .map(|d| {
                    Value::Map(vec![
                        (Value::from("seq"), Value::from(d.seq)),
                        (Value::from("path"), Value::from(d.path.as_str())),
                        (Value::from("side"), Value::from(d.side.name())),
                        (Value::from("line"), Value::from(d.line)),
                        (Value::from("body"), Value::from(d.body.as_str())),
                        (
                            Value::from("head"),
                            d.head.as_deref().map(Value::from).unwrap_or(Value::Nil),
                        ),
                        (Value::from("outdated"), Value::from(d.outdated)),
                    ])
                })
                .collect(),
        );
        self.gcx.scx.call("config.app.review", "drafts", vec![list]);
        self.drafted = Some(model.drafted);
    }

    fn tell_discussions(&mut self) {
        let Some(model) = self.pane.clone() else {
            return;
        };
        let next = (model.threads, model.threads_note);
        if self.discussions.as_ref() == Some(&next) {
            return;
        }
        let list = Value::Array(
            next.0
                .iter()
                .map(|t| {
                    let mine = t.reply.as_ref();
                    Value::Map(vec![
                        ("id".into(), t.id.as_str().into()),
                        ("path".into(), t.path.as_str().into()),
                        ("side".into(), t.side.name().into()),
                        ("line".into(), t.line.map(Value::from).unwrap_or(Value::Nil)),
                        (
                            "start".into(),
                            t.start.map(Value::from).unwrap_or(Value::Nil),
                        ),
                        ("head".into(), t.head.as_str().into()),
                        ("outdated".into(), t.outdated.into()),
                        ("resolved".into(), t.resolved.into()),
                        ("can_reply".into(), t.can_reply.into()),
                        (
                            "reply_body".into(),
                            mine.map(|r| Value::from(r.body.as_str()))
                                .unwrap_or(Value::Nil),
                        ),
                        (
                            "reply_unconfirmed".into(),
                            mine.is_some_and(|r| r.unconfirmed).into(),
                        ),
                        (
                            "reply_error".into(),
                            mine.and_then(|r| r.error.as_deref())
                                .map(Value::from)
                                .unwrap_or(Value::Nil),
                        ),
                        ("can_resolve".into(), t.can_resolve.into()),
                        (
                            "comments".into(),
                            Value::Array(
                                t.comments
                                    .iter()
                                    .map(|c| {
                                        Value::Map(vec![
                                            ("author".into(), c.author.as_str().into()),
                                            ("body".into(), c.body.as_str().into()),
                                            ("url".into(), c.url.as_str().into()),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ),
                    ])
                })
                .collect(),
        );
        self.gcx.scx.call(
            "config.app.review",
            "threads",
            vec![
                list,
                next.1.as_deref().map(Value::from).unwrap_or(Value::Nil),
            ],
        );
        self.discussions = Some(next);
    }

    /// What the person did, to the screen (nothing without a PR or a bridge).
    fn send(&mut self, input: UserInput, cx: &mut Context<Self>) {
        if self.open.is_none() {
            return;
        }
        if let Some(f) = self.factory(cx) {
            f.update(cx, |f, cx| f.send_slot_input(Slot::Review, input, cx));
        }
    }

    /// An ask of the screen's (`review-asks.ts`).
    pub fn ask(&mut self, ask: ReviewAsk, cx: &mut Context<Self>) {
        self.send(UserInput::Review { ask }, cx);
    }

    /// A key of the files pane's, to the screen.
    pub fn key(&mut self, key: &str, cx: &mut Context<Self>) {
        self.send(
            UserInput::Key {
                key: key.to_owned(),
            },
            cx,
        );
    }

    /// The Log's selection: the scope's commits (none: all changes).
    pub fn set_scope(&mut self, commits: Vec<String>, cx: &mut Context<Self>) {
        self.ask(ReviewAsk::Scope { commits }, cx);
    }

    /// The files pane's order switch (By heat | By folder), remembered for the next review.
    pub fn set_heat(&mut self, heat: bool, cx: &mut Context<Self>) {
        self.heat = heat;
        self.ask(ReviewAsk::Order { heat }, cx);
    }

    /// The scope as the diff's switch names it: `All changes`, `Commit 3/5 · a1b2c3d4`,
    /// `Commits 2–4 of 5`.
    pub fn scope_label(&self, cx: &App) -> Option<String> {
        Some(self.strip(cx)?.switch_label)
    }

    /// Whether `path` is marked reviewed (the diff's Reviewed tick); none when not a PR file.
    pub fn reviewed(&self, path: &str, cx: &App) -> Option<bool> {
        self.model(cx)?.lines.iter().find_map(|l| match l {
            PaneLine::File {
                path: p, reviewed, ..
            } if p == path => Some(*reviewed),
            _ => None,
        })
    }

    /// The diff's Reviewed tick: `path` marked (or unmarked) reviewed in the PR.
    pub fn toggle_reviewed(&mut self, path: &str, cx: &mut Context<Self>) {
        self.ask(
            ReviewAsk::Mark {
                path: path.to_owned(),
            },
            cx,
        );
    }

    /// The diff's scope switch / ‹ ›: the scope changed, the diff of `path` shown again in it
    /// (the scope's first change of the file; a commit leaving the file alone shows none).
    pub fn rescope(&mut self, commits: Vec<String>, path: &str, cx: &mut Context<Self>) {
        self.ask(
            ReviewAsk::Rescope {
                commits,
                path: path.to_owned(),
            },
            cx,
        );
    }

    /// The commits `dir` away from the scope (‹ -1, › 1): none is all changes.
    pub fn stepped(&self, dir: i64, cx: &App) -> Option<Vec<String>> {
        let strip = self.strip(cx)?;
        let place = match &strip.scope {
            Scope::All => 0,
            Scope::Commit { place, .. } => *place,
            Scope::Range { to, .. } => *to,
        } as i64;
        let to = place + dir;
        if to < 0 || to > strip.commits.len() as i64 {
            return None;
        }
        Some(if to == 0 {
            Vec::new()
        } else {
            vec![strip.commits[to as usize - 1].sha.clone()]
        })
    }

    /// The diff's scope switch (G25): All changes, then each commit with its counts for `path`;
    /// the commits that leave it alone grey ("not in this file"); ✓ the scope.
    pub fn scope_menu(
        &mut self,
        path: String,
        anchor: crate::kit::Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(strip) = self.strip(cx) else {
            return;
        };
        let n = strip.commits.len();
        let current = match &strip.scope {
            Scope::All => Some(0),
            Scope::Commit { place, .. } => Some(*place),
            Scope::Range { .. } => None,
        };
        let check = |i: usize| current == Some(i);
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let mut entries: Vec<crate::popups::MenuEntry> = Vec::new();
        let mut picks: Vec<Option<Vec<String>>> = Vec::new();
        let mut all = crate::popups::MenuItem::new(format!(
            "All changes · {n} commit{}",
            if n == 1 { "" } else { "s" }
        ));
        if check(0) {
            all = all.icon(IconName::Checked);
        }
        entries.push(all.into());
        picks.push(Some(Vec::new()));
        entries.push(crate::popups::MenuEntry::Separator);
        picks.push(None);
        for (i, c) in strip.commits.iter().enumerate() {
            let counts = c.files.iter().find(|f| f.path == path);
            let mut item =
                crate::popups::MenuItem::new(format!("{} {} {}", i + 1, sha8(&c.sha), c.subject))
                    .shortcut(match counts {
                        Some(f) => format!("+{} −{}", f.additions, f.deletions),
                        None => "not in this file".to_owned(),
                    })
                    .enabled(counts.is_some());
            if check(i + 1) {
                item = item.icon(IconName::Checked);
            }
            entries.push(item.into());
            picks.push(Some(vec![c.sha.clone()]));
        }
        let mut menu = crate::popups::Menu::new(entries, anchor)
            .title(format!("A commit shows only what it changed in {name}"));
        menu.max_width = Some(px(540.));
        let me = cx.entity().downgrade();
        crate::popups::open_menu(menu, window, cx, move |choice, _, cx| {
            let Some(commits) = choice.and_then(|i| picks.get(i).cloned().flatten()) else {
                return;
            };
            let _ = me.update(cx, |r, cx| r.rescope(commits, &path, cx));
        });
    }

    /// The files pane has the keyboard.
    pub fn files_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }

    /// The files pane takes the keyboard.
    pub fn focus_files(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }

    /// A click on line `ix`: the keyboard to the files, the cursor there; a double-click is ⏎.
    fn click(
        &mut self,
        ix: usize,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_files(window, cx);
        self.ask(
            ReviewAsk::At {
                line: ix,
                open: (ev.click_count >= 2).then_some(true),
            },
            cx,
        );
    }

    /// A right-click on line `ix`: the cursor there, then the row's menu once the screen put it
    /// there (an item with a direct key shows it; the rest are commands).
    fn menu(
        &mut self,
        ix: usize,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_files(window, cx);
        let stop = self.pane.as_ref().is_some_and(|p| {
            matches!(
                p.lines.get(ix),
                Some(PaneLine::Node { .. } | PaneLine::File { .. })
            )
        });
        if !stop {
            return;
        }
        self.menu_at = Some((ix, ev.position));
        self.ask(
            ReviewAsk::At {
                line: ix,
                open: None,
            },
            cx,
        );
        self.open_waiting_menu(cx);
    }

    /// The right-click's menu, once the cursor is on its line.
    fn open_waiting_menu(&mut self, cx: &mut Context<Self>) {
        let Some((ix, at)) = self.menu_at else {
            return;
        };
        let Some(pane) = &self.pane else {
            return;
        };
        if pane.at != Some(ix) {
            return;
        }
        self.menu_at = None;
        let entries = pane
            .menu
            .iter()
            .map(|i| {
                crate::popups::MenuItem::new(i.label.clone())
                    .shortcut(i.key.clone())
                    .enabled(i.enabled)
                    .into()
            })
            .collect();
        let runs: Vec<String> = pane.menu.iter().map(|i| i.run.clone()).collect();
        let menu = crate::popups::Menu::new(entries, crate::kit::Anchor::Point(at));
        let me = cx.entity().downgrade();
        let window = cx.active_window();
        let open = move |window: &mut Window, cx: &mut App| {
            crate::popups::open_menu(menu, window, cx, move |choice, _, cx| {
                let Some(run) = choice.and_then(|i| runs.get(i).cloned()) else {
                    return;
                };
                let _ = me.update(cx, |t, cx| t.ask(ReviewAsk::Menu { run }, cx));
            });
        };
        if let Some(window) = window {
            cx.defer(move |cx| {
                let _ = window.update(cx, |_, window, cx| open(window, cx));
            });
        }
    }

    /// The PR's lifecycle rows (Mark ready for review, Merge…, Close…), grey with why: the Log's
    /// menu lists them under the review rows.
    pub fn lifecycle_rows(&self, cx: &App) -> Vec<Lifecycle> {
        self.model(cx).map(|m| m.lifecycle).unwrap_or_default()
    }

    /// A lifecycle row picked: its write, after a yes where it is risky (Command mode asks).
    pub fn run_lifecycle(&mut self, id: &str, cx: &mut Context<Self>) {
        self.ask(ReviewAsk::Lifecycle { id: id.to_owned() }, cx);
    }

    /// Approve… / Request changes… / Comment… / Submit review: the Submit review dialog with that
    /// verdict picked (none: the verdict saved before, else Comment).
    pub fn open_submit(
        &mut self,
        verdict: Option<Verdict>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(model) = self.model(cx) else {
            return;
        };
        let Some(strip) = model.strip.clone() else {
            return;
        };
        let saved = model.saved.clone();
        let verdict = verdict
            .or(saved.as_ref().map(|r| r.verdict))
            .filter(|v| !strip.own || *v == Verdict::Comment)
            .unwrap_or(Verdict::Comment);
        let body = saved
            .filter(|r| r.verdict == verdict)
            .map(|r| r.body)
            .unwrap_or_default();
        let me = cx.entity().downgrade();
        let drafted = model.drafted.clone();
        let dialog = cx.new(|cx| {
            super::submit::SubmitDialog::new(strip, drafted, verdict, body, me, window, cx)
        });
        self.submit = Some(dialog);
        self.submit_from = window.focused(cx);
        // the dialog lives in the Log: the Git window shows it (the keyboard is the dialog's)
        self.gcx
            .scx
            .call("config.app.git", "open", vec!["log".into(), false.into()]);
        cx.notify();
    }

    /// The Submit review dialog closed (sent or cancelled): the keyboard back to the Log.
    pub(crate) fn close_submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit = None;
        match self.submit_from.take() {
            Some(from) => window.focus(&from, cx),
            None => self.gcx.focus_view(window, cx),
        }
        cx.notify();
    }

    /// The dialog's Submit: the review with its verdict and summary, on the head read.
    pub(crate) fn send_review(&mut self, verdict: Verdict, body: String, cx: &mut Context<Self>) {
        self.ask(ReviewAsk::Verdict { verdict, body }, cx);
        cx.notify();
    }

    /// The screen's `show-diff`: `config.app.git_changes.diff(root, files, index, old, new, line,
    /// {pr, head})`.
    #[allow(clippy::too_many_arguments)]
    pub fn show_diff(
        &mut self,
        root: String,
        files: Vec<DiffFile>,
        index: usize,
        base: String,
        head: String,
        line: u32,
        pr: DiffPr,
    ) {
        let list = Value::Array(
            files
                .iter()
                .map(|f| {
                    let mut m = vec![
                        (Value::from("path"), Value::from(f.path.as_str())),
                        (Value::from("status"), Value::from(f.status.as_str())),
                    ];
                    if let Some(o) = &f.old_path {
                        m.push((Value::from("old_path"), Value::from(o.as_str())));
                    }
                    Value::Map(m)
                })
                .collect(),
        );
        self.gcx.scx.call(
            "config.app.git_changes",
            "diff",
            vec![
                root.as_str().into(),
                list,
                (index as i64).into(),
                base.as_str().into(),
                head.as_str().into(),
                i64::from(line).into(),
                // (the PR's head read: the right side's title says "head of #n" on it)
                Value::Map(vec![
                    (Value::from("pr"), Value::from(pr.number)),
                    (Value::from("head"), Value::from(pr.head.as_str())),
                ]),
            ],
        );
        self.shown.push(DiffShown {
            root,
            files,
            index,
            base,
            head,
            line,
        });
    }

    /// The diff's writing card, while one is open (G21).
    pub fn writing(&self) -> Option<&super::writing::Writing> {
        self.writing.as_ref()
    }

    /// The writing card's title and text, while one is open (tests).
    pub fn writing_state(&self, cx: &App) -> Option<(String, String)> {
        self.writing.as_ref().map(|w| (w.title.clone(), w.text(cx)))
    }

    /// `write {…}`: the card opens under its line (one at a time); the keyboard stays where it is
    /// until the card is drawn ([`Self::focus_writing`]).
    fn open_writing(
        &mut self,
        ev: &super::writing::WriteEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.writing.is_none() {
            self.writing_from = window.focused(cx);
        }
        self.writing = Some(super::writing::Writing::new(ev, cx));
        cx.notify();
    }

    /// The card is drawn: its field takes the keyboard and nvim hands over the keys it held.
    pub fn focus_writing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let scx = self.gcx.scx.clone();
        let Some(w) = self.writing.as_mut().filter(|w| w.wants_focus()) else {
            return;
        };
        let token = w.token;
        w.focus(&scx, window, cx, move |t: &mut Self, window, cx| {
            if let Some(w) = t.writing.as_mut().filter(|w| w.token == token) {
                w.release(window, cx);
            }
        });
    }

    /// A key while the card's field has the keyboard (before the field sees it).
    pub fn writing_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        use super::writing::Outcome;
        let Some(w) = self.writing.as_mut() else {
            return;
        };
        match w.key(ev) {
            Outcome::Field => return,
            Outcome::Queued | Outcome::Swallow => {}
            Outcome::Finish(how) => self.finish_writing(how, window, cx),
        }
        cx.stop_propagation();
    }

    /// nvim's held keys: typed into the card first; ⏎ / Esc among them answer it.
    fn writing_typeahead(
        &mut self,
        keys: &[String],
        token: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(w) = self
            .writing
            .as_mut()
            .filter(|w| token.is_none_or(|t| t == w.token))
        else {
            return;
        };
        let answer = w.typeahead(keys, window, cx);
        if token.is_some() {
            w.release(window, cx);
        }
        if let Some(how) = answer {
            self.finish_writing(how, window, cx);
        }
        cx.notify();
    }

    /// The card answered: its text to Lua (a draft, posted now, or nothing), the card gone and
    /// the keyboard back in the diff.
    pub fn finish_writing(
        &mut self,
        how: Option<super::writing::How>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(w) = self.writing.as_ref() else {
            return;
        };
        let text = w.text(cx);
        let (text, how) = match how {
            Some(h) if !text.trim().is_empty() => {
                (Value::from(text.as_str()), Value::from(h.lua()))
            }
            _ => (Value::Nil, Value::Nil),
        };
        self.gcx.scx.call(
            "config.app.review",
            "done",
            vec![Value::from(w.token), text, how],
        );
        self.close_writing(window, cx);
    }

    fn close_writing(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.writing = None;
        match self.writing_from.take() {
            Some(from) => window.focus(&from, cx),
            None => self.gcx.scx.focus_editor(window, cx),
        }
        cx.notify();
    }

    /// The PR diff's `,i` keys (config/app/review.lua): the screen's asks.
    pub fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = crate::nvim::lua::decode::<ReviewEvent>(BRIDGE, payload) else {
            return;
        };
        match ev {
            ReviewEvent::Submit { verdict } => {
                let verdict = verdict.as_deref().and_then(Verdict::of_event);
                self.open_submit(verdict, window, cx);
            }
            ReviewEvent::Write(w) => self.open_writing(&w, window, cx),
            ReviewEvent::WriteCancel { token } => {
                if self.writing.as_ref().is_some_and(|w| w.token == token) {
                    self.close_writing(window, cx);
                }
            }
            ReviewEvent::Typeahead { keys, token } => {
                self.writing_typeahead(&keys, token, window, cx)
            }
            ev => {
                if let Some(ask) = ev.ask() {
                    self.ask(ask, cx);
                }
            }
        }
        cx.notify();
    }

    /// The files pane's keys: the screen's; Tab back to the table; Esc, the tab stops, `,` and
    /// Cmd combos stay the view's / nvim's.
    pub fn on_files_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        if matches!(key, "<Tab>" | "<S-Tab>") {
            cx.emit(PrReviewEvent::Back);
            return true;
        }
        if !PANE_KEYS.contains(&key) || self.open.is_none() {
            return false;
        }
        self.key(key, cx);
        true
    }

    // ---- the strip -----------------------------------------------------------------------

    /// The PR strip over the Log (`.vs-pr-head`); a status line while the PR is being read.
    pub fn render_strip(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let base = div()
            .id("pr-strip")
            .debug_selector(|| "pr-strip".into())
            .flex_none()
            .w_full()
            .h(px(look::PR_STRIP_HEIGHT))
            .pl(px(look::PR_STRIP_PAD_LEFT))
            .pr(px(look::PR_STRIP_PAD_RIGHT))
            .flex()
            .items_center()
            .gap(px(look::PR_STRIP_GAP))
            .border_b_1()
            .border_color(look::BORDER)
            .whitespace_nowrap()
            .overflow_hidden()
            .font(ui_font())
            .text_size(px(look::UI_FONT_SIZE));
        let Some(model) = self.model(cx) else {
            return base.into_any_element();
        };
        let number = self.number().unwrap_or_default();
        let num = div()
            .flex_none()
            .font_family(EDITOR_FONT)
            .text_size(px(look::PR_SMALL_FONT_SIZE))
            .text_color(look::ABE_ACCENT)
            .child(SharedString::from(format!("#{number}")));
        let Some(strip) = model.strip.clone() else {
            return base
                .child(num)
                .child(
                    div()
                        .debug_selector(|| "pr-strip-status".into())
                        .text_color(tone_color(model.tone))
                        .child(SharedString::from(model.said.clone())),
                )
                .into_any_element();
        };
        let title_full: SharedString = strip.title.clone().into();
        let title = div()
            .id("pr-strip-title")
            .flex_shrink(1.)
            .min_w(px(80.))
            .overflow_hidden()
            .text_ellipsis()
            .font_weight(FontWeight::SEMIBOLD)
            .tooltip(crate::kit::tooltip(title_full.clone(), None))
            .child(title_full);
        use crate::factory::{Badge, ReviewHue};
        let (badge_hue, badge) = match strip.badge {
            Badge::Open => (look::ABE_GOOD, "Open"),
            Badge::Draft => (look::TEXT_DIM, "Draft"),
            Badge::Merged => (look::ABE_PERSON, "Merged"),
            Badge::Closed => (look::ABE_BAD, "Closed"),
        };
        let mut chips = vec![chip("pr-chip-state", badge.to_owned(), badge_hue.rgba())];
        if let Some(checks) = &strip.checks {
            let hue = match checks.hue {
                ReviewHue::Bad => look::ABE_BAD,
                ReviewHue::Good => look::ABE_GOOD,
                ReviewHue::Warn => look::ABE_WARN,
            };
            // a click: the PR's runs (the Pipelines tab on its branch's newest run, its log)
            let me = cx.entity().downgrade();
            chips.push(
                div()
                    .id("pr-chip-checks-click")
                    .cursor_pointer()
                    .tooltip(crate::kit::tooltip("Show the PR's runs", None))
                    .on_click(move |_, _, cx| {
                        let _ = me.update(cx, |t, cx| {
                            t.ask(
                                ReviewAsk::Menu {
                                    run: "checks".into(),
                                },
                                cx,
                            )
                        });
                    })
                    .child(chip("pr-chip-checks", checks.label.clone(), hue.rgba()))
                    .into_any_element(),
            );
        }
        if let Some(threads) = &strip.threads {
            let hue = if threads.open {
                look::ABE_WARN
            } else {
                look::TEXT_DIM
            };
            chips.push(chip("pr-chip-threads", threads.label.clone(), hue.rgba()));
        }
        if strip.outdated > 0 {
            chips.push(chip(
                "pr-chip-outdated",
                format!("✗ {} outdated", strip.outdated),
                look::ABE_BAD.rgba(),
            ));
        }
        if let Some(head) = &strip.new_revision {
            chips.push(chip(
                "pr-chip-revision",
                format!("New revision {}", sha8(head)),
                look::ABE_ACCENT.rgba(),
            ));
        }
        if let Some(reviews) = &strip.reviews {
            let hue = match reviews.hue {
                ReviewHue::Bad => look::ABE_BAD,
                ReviewHue::Good => look::ABE_GOOD,
                ReviewHue::Warn => look::ABE_WARN,
            };
            chips.push(chip("pr-chip-reviews", reviews.label.clone(), hue.rgba()));
        }
        if let Some(fresh) = &strip.fresh {
            chips.push(chip(
                "pr-chip-fresh",
                fresh.clone(),
                look::ABE_ACCENT.rgba(),
            ));
        }
        let n = strip.commits.len();
        let place = match &strip.scope {
            Scope::All => 0,
            Scope::Commit { place, .. } => *place,
            Scope::Range { to, .. } => *to,
        };
        let me = cx.entity().downgrade();
        let step = move |dir: i8| {
            let me = me.clone();
            move |_: &gpui_kit::ClickEvent, _: &mut Window, cx: &mut App| {
                let _ = me.update(cx, |t, cx| t.ask(ReviewAsk::Step { dir }, cx));
            }
        };
        let (label, sub) = (strip.scope_label.clone(), strip.scope_sub.clone());
        let scope = div()
            .debug_selector(|| "pr-scope".into())
            .flex_none()
            .flex()
            .items_center()
            .gap(px(2.))
            .child(
                IconButton::new("pr-scope-prev", IconName::ChevronLeft)
                    .tooltip("Previous commit", None)
                    .disabled(place == 0)
                    .on_click(step(-1)),
            )
            .child(
                IconButton::new("pr-scope-next", IconName::ChevronRight)
                    .tooltip("Next commit", None)
                    .disabled(place >= n)
                    .on_click(step(1)),
            )
            .child(
                div()
                    .debug_selector(|| "pr-scope-label".into())
                    .ml(px(4.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(SharedString::from(label)),
            )
            .child(
                div()
                    .ml(px(4.))
                    .text_color(look::TEXT_DIM)
                    .font_family(EDITOR_FONT)
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .child(SharedString::from(format!("· {sub}"))),
            );
        let open = strip.can_submit || strip.outdated > 0;
        let own = strip.own;
        let verdict_button = |id: &'static str, label: &'static str, verdict: Verdict| {
            let me = cx.entity().downgrade();
            // GitHub lets no author approve their own PR or ask changes of it
            let allowed = verdict == Verdict::Comment || !own;
            TextButton::new(id, label)
                .compact(true)
                .disabled(!open || !allowed)
                .when(!allowed, |b| {
                    b.tooltip("Your own pull request: Comment only")
                })
                .on_click(move |_, window, cx| {
                    let _ = me.update(cx, |t, cx| t.open_submit(Some(verdict), window, cx));
                })
        };
        let approve = verdict_button("pr-approve", "Approve…", Verdict::Approve);
        let changes = verdict_button(
            "pr-request-changes",
            "Request changes…",
            Verdict::RequestChanges,
        );
        let comment = verdict_button("pr-comment", "Comment…", Verdict::Comment);
        let url = strip.url.clone();
        let me = cx.entity().downgrade();
        let again = IconButton::new("pr-read-again", IconName::Refresh)
            .tooltip("Read Again from GitHub", Some("R"))
            .on_click(move |_, _, cx| {
                let _ = me.update(cx, |t, cx| {
                    t.ask(
                        ReviewAsk::Menu {
                            run: "refresh".into(),
                        },
                        cx,
                    )
                });
            });
        let browser = IconButton::new("pr-open-browser", IconName::ExternalLink)
            .tooltip("Open in browser", None)
            .on_click(move |_, _, cx| cx.open_url(&url));
        let me = cx.entity().downgrade();
        let submit_tip = if strip.outdated > 0 {
            "An outdated draft waits: rewrite it on its line or delete it"
        } else if strip.drafts == 0 {
            "No drafts yet: pick a verdict with Approve…, Request changes… or Comment…"
        } else {
            "Sends your drafts as one review"
        };
        let submit = TextButton::new("pr-submit-review", submit_label(&strip))
            .compact(true)
            .primary(true)
            .tooltip(submit_tip)
            .disabled(strip.drafts == 0 || !strip.can_submit)
            .on_click(move |_, window, cx| {
                let _ = me.update(cx, |t, cx| t.open_submit(None, window, cx));
            });
        base.child(num)
            .child(title)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(look::PR_CHIP_GAP))
                    .children(chips),
            )
            .child(crate::kit::toolbar_separator(crate::kit::Axis::Horizontal))
            .child(scope)
            .child(div().flex_1().min_w(px(8.)))
            .child(approve)
            .child(changes)
            .child(comment)
            .child(again)
            .child(browser)
            .child(crate::kit::toolbar_separator(crate::kit::Axis::Horizontal))
            .child(submit)
            .into_any_element()
    }

    // ---- the files pane ------------------------------------------------------------------

    fn row(
        &self,
        ix: usize,
        line: &PaneLine,
        cursor: bool,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bg = cursor.then_some(if focused {
            look::SELECTION_BG
        } else {
            look::SELECTION_BG_INACTIVE
        });
        let mut row = div()
            .id(("pr-file-row", ix))
            .debug_selector(move || format!("pr-changes-row-{ix}"))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |t, ev: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    t.click(ix, ev, window, cx)
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |t, ev: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    t.menu(ix, ev, window, cx)
                }),
            )
            .flex()
            .items_center()
            .gap(px(6.))
            .w_full()
            .h(px(look::TREE_ROW_HEIGHT.get()))
            .min_w_0()
            .pr(px(4.))
            .whitespace_nowrap()
            .when_some(bg, |d, bg| d.bg(bg).rounded(px(look::SELECTION_ARC)));
        let marks = |threads: usize, drafts: usize, outdated: bool, reviewed: bool| {
            div()
                .flex_none()
                .ml_auto()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .when(threads > 0, |d| {
                    d.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .text_color(look::TEXT_DIM)
                            .child(Icon::new(IconName::ReviewComment))
                            .child(SharedString::from(threads.to_string())),
                    )
                })
                .when(drafts > 0, |d| {
                    d.child(
                        div()
                            .text_color(if outdated {
                                look::ABE_BAD
                            } else {
                                look::ABE_WARN
                            })
                            .child(SharedString::from(format!(
                                "{drafts} draft{}",
                                if drafts == 1 { "" } else { "s" }
                            ))),
                    )
                })
                .when(reviewed, |d| {
                    d.child(
                        div()
                            .text_color(look::ABE_GOOD)
                            .text_size(px(look::UI_FONT_SIZE))
                            .child("✓"),
                    )
                })
        };
        match line {
            PaneLine::Band => {
                return div()
                    .w_full()
                    .h(px(6.))
                    .flex()
                    .items_center()
                    .child(div().w_full().h(px(1.)).bg(look::SEPARATOR))
                    .into_any_element();
            }
            PaneLine::Gap => {
                return div()
                    .w_full()
                    .h(px(look::TREE_ROW_HEIGHT / 2.))
                    .into_any_element();
            }
            PaneLine::Node {
                label,
                depth,
                open,
                count,
                reviewed,
                node: kind,
                ..
            } => {
                let chevron = if *open {
                    IconName::ChevronDown
                } else {
                    IconName::ChevronRight
                };
                let count = count.clone();
                row = row
                    .child(div().flex_none().w(px(chevron_x(*depth))))
                    .child(Icon::new(chevron))
                    .when(*kind == NodeKind::Dir, |d| {
                        d.child(Icon::new(IconName::Folder))
                    })
                    .child(SharedString::from(label.clone()))
                    .child(
                        div()
                            .text_color(look::CHANGES_COUNT_FG)
                            .child(SharedString::from(count)),
                    )
                    .child(marks(0, 0, false, *reviewed));
            }
            PaneLine::File {
                path,
                depth,
                status,
                heat,
                flat,
                reviewed,
                additions,
                deletions,
                threads,
                drafts,
                outdated,
                ..
            } => {
                let name = path.rsplit('/').next().unwrap_or(path).to_owned();
                // By heat lists every file by its full path at depth 0
                let flat = *flat;
                let score = heat.clone();
                row = if flat {
                    let heat: SharedString = score.clone().into();
                    row.child(
                        div()
                            .flex_none()
                            .pl(px(8.))
                            .w(px(look::PR_HEAT_WIDTH + 8.))
                            .flex()
                            .justify_end()
                            .text_size(px(look::PR_SMALL_FONT_SIZE))
                            .text_color(heat_color(&score))
                            .child(heat),
                    )
                } else {
                    row.child(div().flex_none().w(px(chevron_x(*depth) + 16.)))
                };
                let dir = path
                    .rsplit_once('/')
                    .map(|(d, _)| d.to_owned())
                    .unwrap_or_default();
                row = row
                    .child(Icon::new(for_file(&name)))
                    .child(
                        div()
                            .flex_none()
                            .text_color(status_color(status))
                            .child(SharedString::from(name)),
                    )
                    .when(flat && !dir.is_empty(), |d| {
                        d.child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .text_color(look::TEXT_DIM)
                                .child(SharedString::from(dir)),
                        )
                    })
                    .child(
                        div()
                            .flex_none()
                            .text_color(look::CHANGES_COUNT_FG)
                            .child(SharedString::from(format!("+{additions} −{deletions}"))),
                    )
                    .child(marks(*threads, *drafts, *outdated, *reviewed));
            }
        }
        row.into_any_element()
    }

    /// The order switch `.vs-seg`: By heat | By folder.
    fn seg(&self, cx: &mut Context<Self>) -> AnyElement {
        let item = |id: &'static str, label: &'static str, on: bool, heat: bool| {
            let me = cx.entity().downgrade();
            div()
                .id(id)
                .debug_selector(move || id.to_owned())
                .h_full()
                .px(px(look::SEG_ITEM_PAD_X))
                .flex()
                .items_center()
                .rounded(px(look::SEG_ITEM_ARC))
                .cursor_pointer()
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .map(|d| {
                    if on {
                        d.bg(look::TAB_SELECTED_BG).text_color(look::TEXT)
                    } else {
                        d.text_color(look::TEXT_DIM)
                            .hover(|s| s.text_color(look::TEXT))
                    }
                })
                .on_click(move |_, _, cx| {
                    let _ = me.update(cx, |t, cx| t.set_heat(heat, cx));
                })
                .child(label)
        };
        div()
            .flex_none()
            .h(px(look::SEG_HEIGHT))
            .p(px(1.))
            .flex()
            .border_1()
            .border_color(look::FIELD_BORDER)
            .rounded(px(look::BUTTON_ARC))
            .child(item("pr-order-heat", "By heat", self.heat, true))
            .child(item("pr-order-folder", "By folder", !self.heat, false))
            .into_any_element()
    }

    /// The details text under the files: the PR's description, one commit's message, or the
    /// range's commits.
    fn details(strip: &Strip) -> AnyElement {
        let mono = |s: String, color: Rgba| {
            div()
                .font_family(EDITOR_FONT)
                .text_size(px(look::PR_SMALL_FONT_SIZE))
                .text_color(color)
                .child(SharedString::from(s))
        };
        // (it gives way first when the Git window is short)
        let body = div()
            .debug_selector(|| "pr-details".into())
            .flex_shrink(1.)
            .min_h(px(0.))
            .h(px(look::PR_DETAILS_TEXT_HEIGHT))
            .px(px(14.))
            .pt(px(14.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .overflow_hidden()
            .border_t_1()
            .border_color(look::BORDER)
            .text_size(px(look::UI_FONT_SIZE));
        let n = strip.commits.len();
        match &strip.scope {
            Scope::All => body
                .child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(strip.title.clone())),
                )
                .when(!strip.body.trim().is_empty(), |d| {
                    d.child(SharedString::from(strip.body.trim().to_owned()))
                })
                .child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_color(look::LINK)
                                .child(SharedString::from(format!("#{}", strip.number))),
                        )
                        .child(SharedString::from(format!(
                            "by {} · {n} commit{}",
                            strip.author,
                            if n == 1 { "" } else { "s" }
                        ))),
                )
                .child(SharedString::from(format!(
                    "{} ← {}",
                    strip.base, strip.branch
                )))
                .into_any_element(),
            Scope::Commit { place, .. } => {
                let Some(c) = place.checked_sub(1).and_then(|i| strip.commits.get(i)) else {
                    return body.into_any_element();
                };
                body.child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(c.subject.clone())),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(mono(sha8(&c.sha).to_owned(), look::LINK.rgba()))
                        .child(SharedString::from(c.author.clone()))
                        .child(
                            div()
                                .text_color(look::TEXT_DIM)
                                .child(SharedString::from(c.date.clone())),
                        ),
                )
                .into_any_element()
            }
            Scope::Range { from, to, .. } => {
                let Some(range) = strip.commits.get(from.saturating_sub(1)..*to) else {
                    return body.into_any_element();
                };
                let same = range.windows(2).all(|w| w[0].author == w[1].author);
                let by = match range.first() {
                    Some(c) if same => format!(" by {}", c.author),
                    _ => String::new(),
                };
                body.child(
                    div()
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(format!("{} commits{by}", range.len()))),
                )
                .children(range.iter().rev().map(|c| {
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(mono(sha8(&c.sha).to_owned(), look::LINK.rgba()))
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(SharedString::from(c.subject.clone())),
                        )
                }))
                .into_any_element()
            }
        }
    }
}

impl EventEmitter<PrReviewEvent> for PrReview {}

impl Focusable for PrReview {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The files pane (`.vs-pr-files`): the toolbar (Show Diff, By heat | By folder, the count), the
/// scope's files, the details text.
impl Render for PrReview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window) && crate::editor::window_active(window);
        let body = div()
            .id("pr-files")
            .debug_selector(|| "pr-files".into())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|t, ev: &KeyDownEvent, window, cx| {
                // (keys typed in the Submit review dialog drawn inside bubble here: not the files')
                if !t.focus.is_focused(window) {
                    return;
                }
                if let Some(key) = crate::kit::notation(ev)
                    && t.on_files_key(&key, cx)
                {
                    cx.stop_propagation();
                }
            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .bg(look::PANEL_BG)
            .font(ui_font())
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT);
        let Some(model) = self.model(cx) else {
            return body;
        };
        let count = match &model.strip {
            Some(strip) => strip.files_label.clone(),
            // the read's progress or why it failed
            None => model.said.clone(),
        };
        let bad = model.strip.as_ref().is_some_and(|s| s.outdated > 0)
            || (model.strip.is_none() && model.tone == ReviewTone::Error);
        let me = cx.entity().downgrade();
        let toolbar = div()
            .flex_none()
            .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
            .pl(px(6.))
            .pr(px(12.))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                IconButton::new("pr-show-diff", IconName::Diff)
                    .tooltip("Show Diff", Some("⏎"))
                    .on_click(move |_, _, cx| {
                        let _ = me.update(cx, |t, cx| t.key("<CR>", cx));
                    }),
            )
            .child(self.seg(cx))
            .child(
                div()
                    .id("pr-files-count")
                    .debug_selector(|| "pr-files-count".into())
                    .ml_auto()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(if bad {
                        look::ABE_BAD
                    } else {
                        look::CHANGES_COUNT_FG
                    })
                    .when(bad, |d| {
                        d.tooltip(crate::kit::tooltip(
                            "A draft written on an earlier head is never moved: rewrite it on its line or delete it, then submit",
                            None,
                        ))
                    })
                    .child(SharedString::from(count)),
            );
        let rows: Vec<_> = model
            .lines
            .iter()
            .enumerate()
            .map(|(ix, line)| self.row(ix, line, model.at == Some(ix), focused, cx))
            .collect();
        let mut body = body.child(toolbar);
        if let Some(note) = &model.threads_note
            && model.strip.is_some()
        {
            body = body.child(
                div()
                    .px(px(look::TREE_PAD_X.get()))
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::ABE_WARN)
                    .child(SharedString::from(note.clone())),
            );
        }
        body = body.child(
            div()
                .id("pr-changes-rows")
                .flex_grow(1.)
                .flex_shrink(0.)
                .min_h(px(3. * look::TREE_ROW_HEIGHT))
                .overflow_y_scroll()
                .pt(px(2.))
                .px(px(look::VCS_LOG_SELECTION_INSET_X))
                .children(rows),
        );
        if let Some(strip) = &model.strip {
            body = body.child(if matches!(strip.scope, Scope::All) {
                let me = cx.entity().downgrade();
                let post = move |_: &gpui_kit::ClickEvent, _: &mut Window, cx: &mut App| {
                    let _ = me.update(cx, |t, cx| t.post_say(cx));
                };
                let me = cx.entity().downgrade();
                div()
                    .flex_shrink(1.)
                    .min_h(px(0.))
                    .flex()
                    .flex_col()
                    .capture_key_down(move |ev: &KeyDownEvent, window, cx| {
                        if crate::kit::notation(ev).as_deref() == Some("<D-CR>") {
                            let _ = me.update(cx, |t, cx| {
                                if t.say_typing(window, cx) {
                                    t.post_say(cx);
                                    cx.stop_propagation();
                                }
                            });
                        }
                    })
                    .child(super::conversation::section(
                        strip,
                        &model.conversation,
                        &self.say,
                        post,
                    ))
                    .into_any_element()
            } else {
                Self::details(strip)
            });
        }
        if let Some(dialog) = &self.submit {
            body = body.child(dialog.clone());
        }
        body
    }
}
