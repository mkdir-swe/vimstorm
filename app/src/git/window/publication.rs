//! Create Draft PR (G20, RULES 18): one flow dialog in place of the four popups. Normal Git work
//! with a reviewable publication choice: the repository and the branches (`base ← head`, its
//! commits and files), the title, the description (multi-line, started from the card the branch
//! names and its commits), what is pushed first and what stays local, then Cancel and the primary
//! `Create draft ⏎` (or `Open PR #n ⏎` when the branch has one open: it is reused). Pushing is the
//! explicit choice the dialog states ("is pushed first"); nothing is committed, stashed or reset.
//! A failure stays in the dialog as its footer's error, the text kept.
//!
//! The base is a pick of origin's branches (the default first) and Reviewers a row of people
//! (chips with ×, `Add reviewer…` the repo's assignable people), asked once the draft is made.
//!
//! Keys: ⏎ creates from the title, the base or the reviewers, the description takes ⏎ / ⇧⏎ as a
//! new line and ⌘⏎ creates from it; Space / ↓ on the base or the reviewers opens its pick,
//! ⌫ on the reviewers takes the last one off; Tab / ⇧Tab the next / previous field, Esc cancels. Hosted by the Git tool window ([`super::GitView`]), drawn over the window.

use crate::kit::TextArea;
use crate::kit::TextButton;
use crate::kit::TextField;
use crate::look;
use crate::popups::{self, Balloon};
use gpui_kit::{
    App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Pixels, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde::Deserialize;
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use super::GitView;
use super::flow;
use crate::git::window::review::ReviewBridge;

/// The PR open on the branch already, or the one just made.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct NewPr {
    pub number: u64,
    pub url: String,
}

/// Someone who can be asked to review.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Person {
    pub login: String,
    #[serde(default)]
    pub name: String,
}

/// How a reviewer reads: their name, else their login.
pub fn person_label(p: &Person) -> &str {
    if p.name.trim().is_empty() {
        &p.login
    } else {
        &p.name
    }
}

/// What the draft is made from (`abe pr draft-plan`), read without writing anything.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DraftPrPlan {
    pub root: String,
    pub repo: String,
    pub branch: String,
    pub head: String,
    pub base: String,
    pub title: String,
    /// The description the dialog starts with: the card the branch names, then the commits'
    /// subjects (G20 "From the commits and the card").
    pub body: String,
    /// The branch's commits and files not on the base (as last fetched; 0 when unknown).
    pub commits: usize,
    pub files: usize,
    /// Local changes not committed: not part of the PR (the dialog says so).
    pub uncommitted: Vec<String>,
    pub published: bool,
    pub existing: Option<NewPr>,
    /// The bases to pick from: the default branch first, then origin's other branches.
    pub branches: Vec<String>,
    /// Who can be asked to review (the repo's assignable people, you left out).
    pub reviewers: Vec<Person>,
}

/// `abe pr draft-create`'s answer: the draft (or the PR open on the branch), and why the
/// reviewers were not asked.
#[derive(Clone, Debug, Deserialize)]
struct Made {
    number: u64,
    url: String,
    asked: Option<String>,
}

fn report(message: impl Into<SharedString>, window: &mut Window, cx: &mut App) {
    popups::notify(Balloon::error("Create Draft PR", message), window, cx);
}

/// `abe <argv>` run by Abe 3.x's bridge in the shown folder: its data, or why not.
fn ask_abe(
    argv: Vec<String>,
    cx: &mut App,
) -> Option<futures::channel::oneshot::Receiver<serde_json::Value>> {
    let f = cx.try_global::<ReviewBridge>()?.0.upgrade()?;
    f.update(cx, |f, _| f.run(argv))
}

/// The answer's `data`, read as `T`; or the refusal's words.
fn answered<T: serde::de::DeserializeOwned>(
    answer: Result<serde_json::Value, futures::channel::oneshot::Canceled>,
) -> Result<T, String> {
    let Ok(doc) = answer else {
        return Err("abe ui bridge stopped before it answered".into());
    };
    if doc["ok"].as_bool() == Some(true) {
        return serde_json::from_value(doc["data"].clone()).map_err(|e| format!("abe: {e}"));
    }
    Err(doc["error"]["message"]
        .as_str()
        .unwrap_or("abe refused it")
        .to_owned())
}

/// The normal toolbar / command route: the branch's target read by `abe pr draft-plan` (nothing
/// is written), then the dialog in `host`.
pub fn open_current(host: WeakEntity<GitView>, root: PathBuf, window: &mut Window, cx: &mut App) {
    let argv = vec![
        "pr".to_owned(),
        "draft-plan".to_owned(),
        format!("--path={}", root.to_string_lossy()),
    ];
    let Some(answer) = ask_abe(argv, cx) else {
        report("Create Draft PR needs Abe 3.x: ./install.sh", window, cx);
        return;
    };
    window
        .spawn(cx, async move |cx| {
            let plan = answered::<DraftPrPlan>(answer.await);
            let _ = cx.update(|window, cx| match plan {
                Ok(plan) => {
                    let _ = host.update(cx, |g, cx| {
                        let dialog = cx.new(|cx| DraftPrDialog::new(plan, cx));
                        g.show_draft_pr(dialog, window, cx);
                    });
                }
                Err(why) => report(why, window, cx),
            });
        })
        .detach();
}

/// [`open_current`] (the window tests' entry).
pub fn open(host: WeakEntity<GitView>, root: PathBuf, window: &mut Window, cx: &mut App) {
    open_current(host, root, window, cx);
}

pub struct DraftPrDialog {
    pub plan: DraftPrPlan,
    title: Entity<TextField>,
    /// The base picked (the default branch first).
    base: String,
    base_focus: FocusHandle,
    base_at: Rc<Cell<Option<Bounds<Pixels>>>>,
    body: Entity<TextArea>,
    /// The people asked to review once the draft is made.
    pub reviewers: Vec<Person>,
    reviewers_focus: FocusHandle,
    reviewers_at: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The create is running (the dialog reads only).
    sending: bool,
    /// The last create's error, the text kept.
    pub error: Option<String>,
    /// The field with the keyboard once drawn (its window may only now be opening).
    focus_soon: bool,
    host: WeakEntity<GitView>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl DraftPrDialog {
    fn new(plan: DraftPrPlan, cx: &mut Context<Self>) -> Self {
        let title = cx.new(|cx| {
            let mut f = TextField::new(cx).placeholder("Title");
            f.set_text(plan.title.clone(), cx);
            f
        });
        let body = cx.new(|cx| {
            let mut a = TextArea::new(cx).placeholder("What it changes and how to test it");
            a.set_text(plan.body.clone(), cx);
            a
        });
        let subs = vec![
            cx.observe(&title, |_, _, cx| cx.notify()),
            cx.observe(&body, |_, _, cx| cx.notify()),
        ];
        DraftPrDialog {
            base: plan.base.clone(),
            plan,
            title,
            base_focus: cx.focus_handle(),
            base_at: Rc::default(),
            body,
            reviewers: Vec::new(),
            reviewers_focus: cx.focus_handle(),
            reviewers_at: Rc::default(),
            sending: false,
            error: None,
            focus_soon: true,
            host: WeakEntity::new_invalid(),
            _subs: subs,
        }
    }

    /// The Git window hosting it.
    pub(super) fn set_host(&mut self, host: WeakEntity<GitView>) {
        self.host = host;
    }

    /// A field of the dialog has the keyboard.
    pub fn typing(&self, window: &Window, cx: &App) -> bool {
        self.fields(cx)
            .iter()
            .any(|f| f.contains_focused(window, cx))
    }

    /// Title, base, description, reviewers: Tab's order.
    fn fields(&self, cx: &App) -> [FocusHandle; 4] {
        [
            self.title.focus_handle(cx),
            self.base_focus.clone(),
            self.body.focus_handle(cx),
            self.reviewers_focus.clone(),
        ]
    }

    /// The title, base and description as typed (tests).
    pub fn texts(&self, cx: &App) -> (String, String, String) {
        (
            self.title.read(cx).text().to_owned(),
            self.base.clone(),
            self.body.read(cx).text().to_owned(),
        )
    }

    /// The primary button's words.
    pub fn action(&self) -> String {
        match &self.plan.existing {
            Some(pr) => format!("Open PR #{} ⏎", pr.number),
            None if self.sending => "Creating…".into(),
            None => "Create draft ⏎".into(),
        }
    }

    fn ready(&self, cx: &App) -> bool {
        if self.plan.existing.is_some() {
            return true;
        }
        let base = self.base.trim();
        !self.sending
            && !self.title.read(cx).text().trim().is_empty()
            && !base.is_empty()
            && base != self.plan.branch
    }

    fn focus_step(&mut self, dir: isize, window: &mut Window, cx: &mut Context<Self>) {
        let fields = self.fields(cx);
        let at = fields
            .iter()
            .position(|f| f.contains_focused(window, cx))
            .unwrap_or(0) as isize;
        let to = (at + dir).rem_euclid(fields.len() as isize) as usize;
        window.focus(&fields[to], cx);
    }

    /// ⏎ / the primary: the existing PR opened, else the push (when the branch isn't on GitHub)
    /// and the draft made, as the person.
    pub fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.ready(cx) {
            return;
        }
        if let Some(existing) = &self.plan.existing {
            cx.open_url(&existing.url);
            self.close(window, cx);
            return;
        }
        let plan = &self.plan;
        // each value inline (`--body=…`): a text that starts with a dash stays a text
        let mut argv: Vec<String> = vec!["pr".into(), "draft-create".into()];
        argv.extend(
            [
                ("path", plan.root.as_str()),
                ("repo", plan.repo.as_str()),
                ("branch", plan.branch.as_str()),
                ("head", plan.head.as_str()),
                ("base", self.base.trim()),
                ("title", self.title.read(cx).text().trim()),
                ("body", self.body.read(cx).text()),
            ]
            .map(|(flag, value)| format!("--{flag}={value}")),
        );
        if !plan.published {
            argv.push("--push".into());
        }
        for p in &self.reviewers {
            argv.push(format!("--reviewer={}", p.login));
        }
        let Some(answer) = ask_abe(argv, cx) else {
            self.error = Some("Create Draft PR needs Abe 3.x: ./install.sh".into());
            cx.notify();
            return;
        };
        self.sending = true;
        self.error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let made = answered::<Made>(answer.await);
            let _ = this.update_in(cx, |d, window, cx| {
                d.sending = false;
                match made {
                    Ok(pr) => {
                        popups::notify(
                            Balloon::info("Draft PR", format!("PR #{} · {}", pr.number, pr.url)),
                            window,
                            cx,
                        );
                        if let Some(why) = pr.asked {
                            popups::notify(
                                Balloon::error(
                                    "Draft PR",
                                    format!("PR #{} made; reviewers not asked: {why}", pr.number),
                                ),
                                window,
                                cx,
                            );
                        }
                        cx.open_url(&pr.url);
                        d.close(window, cx);
                    }
                    Err(error) => {
                        d.error = Some(error);
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self.host.update(cx, |g, cx| g.close_draft_pr(window, cx));
    }

    fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        let in_body = self.body.focus_handle(cx).contains_focused(window, cx);
        let on_base = self.base_focus.is_focused(window);
        let on_reviewers = self.reviewers_focus.is_focused(window);
        match key.as_str() {
            "<Space>" | "<Down>" | "<M-Down>" if on_base => self.pick_base(window, cx),
            "<Space>" | "<Down>" | "<M-Down>" if on_reviewers => self.pick_reviewer(window, cx),
            "<BS>" if on_reviewers => {
                self.reviewers.pop();
                cx.notify();
            }
            // the description takes ⏎ / ⇧⏎ as a new line; ⌘⏎ creates from there
            "<CR>" if in_body => return,
            "<CR>" | "<D-CR>" => self.create(window, cx),
            "<Esc>" => self.close(window, cx),
            "<Tab>" => self.focus_step(1, window, cx),
            "<S-Tab>" => self.focus_step(-1, window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// Reviewers (G20): a chip per person asked (× takes them off), then `Add reviewer…`.
    fn reviewers_row(&self, window: &Window, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let me = cx.entity().downgrade();
        let at = self.reviewers_at.clone();
        let focused = self.reviewers_focus.is_focused(window);
        let chips: Vec<_> = self
            .reviewers
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let me = me.clone();
                div()
                    .id(SharedString::from(format!("draft-pr-reviewer-{}", p.login)))
                    .debug_selector({
                        let login = p.login.clone();
                        move || format!("draft-pr-reviewer-{login}")
                    })
                    .flex_none()
                    .h(px(20.))
                    .px(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(look::BUTTON_ARC))
                    .bg(look::SELECTION_BG_INACTIVE)
                    .text_color(look::ABE_PERSON)
                    .child(SharedString::from(person_label(p).to_owned()))
                    .child(
                        div()
                            .id(SharedString::from(format!("draft-pr-reviewer-x-{i}")))
                            .text_color(look::TEXT_DIM)
                            .cursor_pointer()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(move |_, _, cx| {
                                let _ = me.update(cx, |d, cx| {
                                    if i < d.reviewers.len() {
                                        d.reviewers.remove(i);
                                    }
                                    cx.notify();
                                });
                            })
                            .child("×"),
                    )
            })
            .collect();
        let none = self.plan.reviewers.is_empty();
        div()
            .id("draft-pr-reviewers")
            .debug_selector(|| "draft-pr-reviewers".into())
            .track_focus(&self.reviewers_focus)
            .relative()
            .min_h(px(look::FIELD_HEIGHT))
            .px(px(4.))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .rounded(px(look::BUTTON_ARC))
            .border_1()
            .border_color(if focused {
                look::FOCUS_BORDER
            } else {
                look::FIELD_BORDER
            })
            .bg(look::FIELD_BG)
            .cursor_pointer()
            .on_click(move |_, window, cx| {
                let _ = me.update(cx, |d, cx| {
                    window.focus(&d.reviewers_focus, cx);
                    d.pick_reviewer(window, cx);
                });
            })
            .child(
                gpui_kit::canvas(move |b, _, _| at.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .children(chips)
            .child(
                div()
                    .px(px(4.))
                    .text_color(look::PLACEHOLDER)
                    .child(if none {
                        "No one to ask on GitHub"
                    } else {
                        "Add reviewer…"
                    }),
            )
            .into_any_element()
    }

    /// The base's pick: the default branch first, then origin's others; ✓ the one picked.
    pub fn pick_base(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let names = self.plan.branches.clone();
        if names.is_empty() {
            return;
        }
        let entries = names
            .iter()
            .map(|b| {
                let mut item = popups::MenuItem::new(b.clone());
                if *b == self.base {
                    item = item.shortcut("✓");
                }
                item.into()
            })
            .collect();
        let anchor = anchor_of(&self.base_at, window);
        let menu = popups::Menu::new(entries, anchor).title("Base branch");
        let me = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, _, cx| {
            if let Some(name) = choice.and_then(|i| names.get(i).cloned()) {
                let _ = me.update(cx, |d, cx| {
                    d.base = name;
                    cx.notify();
                });
            }
        });
    }

    /// Add reviewer…: the repo's assignable people not asked yet.
    pub fn pick_reviewer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let left: Vec<Person> = self
            .plan
            .reviewers
            .iter()
            .filter(|p| !self.reviewers.iter().any(|r| r.login == p.login))
            .cloned()
            .collect();
        if left.is_empty() {
            return;
        }
        let entries = left
            .iter()
            .map(|p| {
                let mut item = popups::MenuItem::new(person_label(p).to_owned());
                if person_label(p) != p.login {
                    item = item.shortcut(p.login.clone());
                }
                item.into()
            })
            .collect();
        let anchor = anchor_of(&self.reviewers_at, window);
        let menu = popups::Menu::new(entries, anchor).title("Add reviewer");
        let me = cx.entity().downgrade();
        popups::open_menu(menu, window, cx, move |choice, _, cx| {
            if let Some(p) = choice.and_then(|i| left.get(i).cloned()) {
                let _ = me.update(cx, |d, cx| {
                    d.reviewers.push(p);
                    cx.notify();
                });
            }
        });
    }

    /// What is pushed first and what stays out (G20's note).
    fn note(&self) -> String {
        let p = &self.plan;
        let mut out = Vec::new();
        if let Some(pr) = &p.existing {
            out.push(format!(
                "PR #{} is already open for {}: it is reused.",
                pr.number, p.branch
            ));
        } else if !p.published {
            out.push(format!(
                "{} is not on GitHub yet; it is pushed first.",
                p.branch
            ));
        }
        match p.uncommitted.len() {
            0 => {}
            1 => out.push(format!(
                "1 uncommitted change ({}) is not included.",
                p.uncommitted[0]
            )),
            n => out.push(format!("{n} uncommitted changes are not included.")),
        }
        out.join(" ")
    }
}

impl Render for DraftPrDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.focus_soon) {
            let focus = self.title.focus_handle(cx);
            window.defer(cx, move |window, cx| window.focus(&focus, cx));
        }
        let me = cx.entity().downgrade();
        let p = &self.plan;
        let counts = match (p.commits, p.files) {
            (0, _) => String::new(),
            (c, f) => format!(
                "{c} commit{} · {f} file{}",
                if c == 1 { "" } else { "s" },
                if f == 1 { "" } else { "s" }
            ),
        };
        let base_at = self.base_at.clone();
        let base = div()
            .id("draft-pr-base")
            .debug_selector(|| "draft-pr-base".into())
            .track_focus(&self.base_focus)
            .relative()
            .h(px(look::FIELD_HEIGHT))
            .pl(px(8.))
            .pr(px(4.))
            .flex()
            .items_center()
            .gap(px(2.))
            .rounded(px(look::BUTTON_ARC))
            .border_1()
            .border_color(if self.base_focus.is_focused(window) {
                look::FOCUS_BORDER
            } else {
                look::FIELD_BORDER
            })
            .bg(look::FIELD_BG)
            .cursor_pointer()
            .on_click({
                let me = me.clone();
                move |_, window, cx| {
                    let _ = me.update(cx, |d, cx| {
                        window.focus(&d.base_focus, cx);
                        d.pick_base(window, cx);
                    });
                }
            })
            .child(
                gpui_kit::canvas(move |b, _, _| base_at.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .child(SharedString::from(self.base.clone()))
            .child(crate::kit::Icon::new(crate::kit::IconName::ChevronDown));
        let branches = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(base)
            .child(div().text_color(look::TEXT_DIM).child("←"))
            .child(
                div()
                    .debug_selector(|| "draft-pr-head".into())
                    .font_family(crate::render::EDITOR_FONT)
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::ABE_PATH)
                    .child(SharedString::from(p.branch.clone())),
            )
            .when(!counts.is_empty(), |d| {
                d.child(
                    div()
                        .text_size(px(look::PR_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(counts)),
                )
            });
        let description = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .h(px(look::FLOW_AREA_TALL_HEIGHT))
                    .child(self.body.clone()),
            )
            .child(
                div()
                    .text_size(px(look::PR_SMALL_FONT_SIZE))
                    .text_color(look::TEXT_DIM)
                    .child("From the commits and the card · ⇧⏎ new line · ⌘⏎ creates"),
            );
        let note = self.note();
        let grid = div()
            .px(px(look::FLOW_SECTION_PAD_X))
            .py(px(look::FLOW_SECTION_PAD_TOP))
            .flex()
            .flex_col()
            .gap(px(10.))
            .border_b_1()
            .border_color(look::SEPARATOR)
            .child(flow::row("Title", false, self.title.clone()))
            .child(flow::row("Branches", false, branches))
            .child(flow::row("Description", true, description))
            .child(flow::row(
                "Reviewers",
                false,
                self.reviewers_row(window, cx),
            ));
        let cancel = {
            let me = me.clone();
            TextButton::new("draft-pr-cancel", "Cancel").on_click(move |_, window, cx| {
                let _ = me.update(cx, |d, cx| d.close(window, cx));
            })
        };
        let create = {
            let me = me.clone();
            TextButton::new("draft-pr-create", self.action())
                .primary(true)
                .disabled(!self.ready(cx))
                .on_click(move |_, window, cx| {
                    let _ = me.update(cx, |d, cx| d.create(window, cx));
                })
        };
        let (foot, error) = match &self.error {
            Some(e) => (e.clone(), true),
            None => (
                "Opens as a draft; mark it ready from the PR".to_owned(),
                false,
            ),
        };
        let close = me.clone();
        let frame = flow::frame(look::FLOW_WIDTH_WIDE)
            .id("create-draft-pr")
            .key_context("CreateDraftPr")
            .capture_key_down(cx.listener(Self::on_key))
            .child(flow::title(
                "Create Draft PR",
                None,
                &p.repo,
                move |window, cx| {
                    let _ = close.update(cx, |d, cx| d.close(window, cx));
                },
            ))
            .child(grid)
            .when(!note.is_empty(), |d| {
                d.child(
                    div()
                        .debug_selector(|| "draft-pr-note".into())
                        .px(px(look::FLOW_SECTION_PAD_X))
                        .py(px(10.))
                        .border_b_1()
                        .border_color(look::SEPARATOR)
                        .text_size(px(look::PR_SMALL_FONT_SIZE))
                        .text_color(look::TEXT_DIM)
                        .child(SharedString::from(note)),
                )
            })
            .child(flow::foot(
                foot.into(),
                error,
                vec![cancel.into_any_element(), create.into_any_element()],
            ));
        flow::overlay(
            "create-draft-pr-dialog",
            look::FLOW_WIDTH_WIDE,
            frame,
            window,
        )
    }
}

/// Below `at` (the field as last drawn), else under the mouse.
fn anchor_of(at: &Rc<Cell<Option<Bounds<Pixels>>>>, window: &Window) -> crate::kit::Anchor {
    match at.get() {
        Some(b) => crate::kit::Anchor::Below(b),
        None => crate::kit::Anchor::Point(window.mouse_position()),
    }
}
