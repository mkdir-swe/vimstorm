//! PR review in the Log (RULES 11, GitLog "PR review in the Log", G10 / G23–G26): reviewing a
//! PR is this tab on the PR's checked-out worktree, filtered by a `PR: #n` chip. While a PR is
//! under review ([`PrReview`] attached) the tab shows the PR strip over the filter bar, the chip
//! (× clears it; the worktree stays open), "All changes" as the table's first row over the PR's
//! commits (`base..head`), and the scope's files ([`PrReview`]'s pane) in place of the commit
//! details. The selection is the scope: All changes, the cursor's commit, or the commits selected
//! (⇧↑ / ⇧↓, ⇧click). The unset chip `PR ⌄` opens the PR pick (G26): the review screen reads the
//! repo's open PRs (Mine then Others, Review requested) and answers `pr-pick`; ⏎ checks the PR out
//! in its worktree (`abe review open`) and its `review-open` opens it here.

use std::collections::BTreeMap;

use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};

use super::LogTab;
use crate::factory::{PickRow, ReviewAsk, Scope};
use crate::factory::{Slot, UserInput};
use crate::git::log::PrRange;
use crate::git::window::review::{PrReview, PrReviewEvent, ReviewBridge, SCREEN, sha8};
use crate::kit::Anchor;
use crate::kit::FilterChip;
use crate::kit::{Icon, IconName};
use crate::look;
use crate::popups::{self, Balloon, Menu, MenuEntry, MenuItem};

impl LogTab {
    /// The Git window's PR review: the Log follows it (its filter, strip and files).
    pub fn set_review(
        &mut self,
        review: Entity<PrReview>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pr_subs = vec![
            cx.observe(&review, |t, _, cx| t.follow_review(cx)),
            cx.subscribe_in(
                &review,
                window,
                |t, _, ev: &PrReviewEvent, window, cx| match ev {
                    PrReviewEvent::Back => t.focus_table(window, cx),
                },
            ),
        ];
        self.review = Some(review);
    }

    /// The PR under review here, while one is.
    pub fn pr_number(&self, cx: &gpui_kit::App) -> Option<u64> {
        self.review.as_ref()?.read(cx).number()
    }

    /// The Log shows a PR's review (strip, chip, All changes row, files).
    pub fn reviewing(&self, cx: &gpui_kit::App) -> bool {
        self.pr_number(cx).is_some()
    }

    /// The All changes row has the cursor (the scope is the whole PR).
    pub fn pr_all(&self) -> bool {
        self.pr_all
    }

    /// The review changed: the filter follows its PR's `base..head` once read; none without one.
    fn follow_review(&mut self, cx: &mut Context<Self>) {
        let Some(review) = &self.review else {
            return;
        };
        let r = review.read(cx);
        let want = match (r.number(), r.strip(cx)) {
            (Some(number), Some(strip)) if !strip.base_sha.is_empty() => Some(PrRange {
                number,
                base: strip.base_sha.clone(),
                head: strip.head_sha.clone(),
            }),
            // reading, or not checked out: no commits to list
            (Some(number), _) => self.filters.pr.clone().filter(|p| p.number == number),
            (None, _) => None,
        };
        if want != self.filters.pr {
            if want.as_ref().map(|p| p.number) != self.filters.pr.as_ref().map(|p| p.number) {
                // a new PR: the whole of it, the files' keyboard where it was
                self.pr_all = true;
                self.pr_scope.clear();
            }
            self.update_filters(|f| f.pr = want, cx);
        } else {
            self.select_scope(cx);
        }
        cx.notify();
    }

    /// The scope changed outside the table (the strip's ‹ ›, the diff's switch): the selection
    /// follows it, so the table always shows what is in scope.
    fn select_scope(&mut self, cx: &mut Context<Self>) {
        let Some(strip) = self.review.as_ref().and_then(|r| r.read(cx).strip(cx)) else {
            return;
        };
        let scope: Vec<String> = match &strip.scope {
            Scope::All => Vec::new(),
            Scope::Commit { sha, .. } => vec![sha.clone()],
            Scope::Range {
                from_sha, to_sha, ..
            } => vec![from_sha.clone(), to_sha.clone()],
        };
        let mine = match self.pr_scope.len() {
            0 | 1 => self.pr_scope.clone(),
            _ => {
                // the Log's range is all its commits: compare its ends
                let rows: Vec<usize> = self
                    .pr_scope
                    .iter()
                    .filter_map(|h| self.model.index_of(h))
                    .collect();
                match (rows.iter().max(), rows.iter().min()) {
                    (Some(&old), Some(&new)) => vec![
                        self.model.commits[old].hash.clone(),
                        self.model.commits[new].hash.clone(),
                    ],
                    _ => Vec::new(),
                }
            }
        };
        if scope == mine {
            return;
        }
        match scope.as_slice() {
            [] => {
                self.pr_all = true;
                self.model.clear_selection();
            }
            [one] => {
                let Some(ix) = self.model.index_of(one) else {
                    return;
                };
                self.pr_all = false;
                self.model.clear_selection();
                self.model.move_to(ix);
            }
            [from, to, ..] => {
                let (Some(a), Some(b)) = (self.model.index_of(from), self.model.index_of(to))
                else {
                    return;
                };
                self.pr_all = false;
                self.model.select_drag(a, b);
            }
        }
        // what the table now implies is the scope: no press back
        self.pr_scope = if self.pr_all {
            Vec::new()
        } else {
            let sel = self.model.selection();
            if sel.len() > 1 {
                sel.iter().map(|c| c.hash.clone()).collect()
            } else {
                self.model
                    .current()
                    .map(|c| vec![c.hash.clone()])
                    .unwrap_or_default()
            }
        };
        self.reveal_cursor();
    }

    /// The scope follows the selection: All changes, the cursor's commit, or the commits
    /// selected.
    pub(super) fn pr_follow_scope(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review.clone() else {
            return;
        };
        if self.filters.pr.is_none() {
            return;
        }
        let scope: Vec<String> = if self.pr_all {
            Vec::new()
        } else {
            let sel = self.model.selection();
            if sel.len() > 1 {
                sel.iter().map(|c| c.hash.clone()).collect()
            } else {
                self.model
                    .current()
                    .map(|c| vec![c.hash.clone()])
                    .unwrap_or_default()
            }
        };
        if scope != self.pr_scope {
            self.pr_scope = scope.clone();
            review.update(cx, |r, cx| r.set_scope(scope, cx));
        }
    }

    /// The table's keys while a PR is under review, before the plain Log's: up from the first
    /// commit to All changes and back down, ⏎ / → / Tab into the scope's files. True: handled.
    pub(super) fn pr_table_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.filters.pr.is_none() || !self.reviewing(cx) {
            return false;
        }
        match key {
            "<CR>" | "ä" | "<Right>" | "<Tab>" | "<S-Tab>" => {
                self.focus_pr_files(window, cx);
                true
            }
            "ö" | "<Down>" if self.pr_all => {
                self.pr_all = false;
                self.model.move_to(0);
                self.cursor_moved(cx);
                true
            }
            "l" | "<Up>" | "<Home>" if self.pr_all => true,
            "l" | "<Up>" | "<Home>" if self.model.cursor() == Some(0) || key == "<Home>" => {
                self.pr_all_row(cx);
                true
            }
            _ => {
                if self.pr_all && !key.starts_with('<') && key.len() > 1 {
                    return false;
                }
                // a move from All changes starts on the first commit
                if self.pr_all && matches!(key, "<S-Down>" | "<S-Up>" | "<Space>") {
                    self.pr_all = false;
                    self.model.move_to(0);
                }
                false
            }
        }
    }

    /// The All changes row picked (a click, ↑ from the first commit): the whole PR.
    pub(super) fn pr_all_row(&mut self, cx: &mut Context<Self>) {
        self.pr_all = true;
        self.model.clear_selection();
        self.cursor_moved(cx);
    }

    /// The scope's files take the keyboard.
    pub(super) fn focus_pr_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(review) = &self.review {
            let focus = gpui_kit::Focusable::focus_handle(review.read(cx), cx);
            window.focus(&focus, cx);
        }
    }

    /// The PR files pane has the keyboard.
    pub(super) fn pr_files_focused(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        self.reviewing(cx)
            && self
                .review
                .as_ref()
                .is_some_and(|r| r.read(cx).files_focused(window))
    }

    /// The Submit review dialog's summary has the keyboard.
    pub(super) fn pr_typing(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        self.review.as_ref().is_some_and(|r| {
            let r = r.read(cx);
            r.say_typing(window, cx)
                || r.submit_dialog()
                    .is_some_and(|d| d.read(cx).typing(window, cx))
        })
    }

    /// The strip over the Log while a PR is under review.
    pub(super) fn render_pr_strip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let review = self.review.clone()?;
        if !review.read(cx).attached() {
            return None;
        }
        Some(review.update(cx, |r, cx| r.render_strip(cx)))
    }

    /// The PR chip: `PR: #n ×` while one is under review, else `PR ⌄` (its pick).
    pub(super) fn render_pr_chip(&self, label: bool, cx: &mut Context<Self>) -> AnyElement {
        let value = self.pr_number(cx).map(|n| format!("#{n}"));
        let this = cx.entity().downgrade();
        let me = this.clone();
        let chip = FilterChip::new("pr", "PR")
            .value(value)
            .show_name(label)
            .on_open(move |bounds, window, cx| {
                let _ = me.update(cx, |t, cx| {
                    t.open_pr_pick(Anchor::Below(bounds), window, cx)
                });
            })
            .on_clear(move |_, cx| {
                let _ = this.update(cx, |t, cx| t.clear_pr(cx));
            });
        div()
            .relative()
            .flex_none()
            .debug_selector(|| "chip-pr".into())
            .child(chip)
            .into_any_element()
    }

    /// The chip's ×: no PR under review; the plain Log of the worktree (it stays open).
    pub fn clear_pr(&mut self, cx: &mut Context<Self>) {
        if let Some(review) = &self.review {
            review.update(cx, |r, cx| r.stop(cx));
        }
        self.pr_all = false;
        self.pr_scope.clear();
        self.update_filters(|f| f.pr = None, cx);
    }

    /// "All changes" over the PR's commits (`.vs-gitlog-row--scope`): its commits, the base and
    /// head, then a rule.
    pub(super) fn render_pr_all_row(
        &self,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.filters.pr.as_ref()?;
        let strip = self.review.as_ref()?.read(cx).strip(cx)?;
        let n = strip.commits.len();
        let bg = self.pr_all.then_some(if focused {
            look::SELECTION_BG
        } else {
            look::SELECTION_BG_INACTIVE
        });
        let row = div()
            .id("pr-all-changes")
            .debug_selector(|| "pr-all-changes".into())
            .relative()
            .flex_none()
            .h(px(look::VCS_LOG_ROW_HEIGHT.get()))
            .w_full()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(look::VCS_LOG_SELECTION_INSET_X))
                    .right(px(look::VCS_LOG_SELECTION_INSET_X))
                    .rounded(px(look::VCS_LOG_SELECTION_ARC))
                    .when_some(bg, |d, bg| d.bg(bg))
                    .when(bg.is_none(), |d| d.hover(|s| s.bg(look::VCS_LOG_HOVER_BG))),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex_none()
                            .w(px(super::table::GRAPH_LEFT
                                + 16.5
                                + super::table::SUBJECT_GAP))
                            .pl(px(super::table::GRAPH_LEFT + 0.5))
                            .child(Icon::new(IconName::ListChanges)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .flex()
                            .gap(px(4.))
                            .child(div().font_weight(FontWeight::SEMIBOLD).child("All changes"))
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .text_color(look::TEXT_DIM)
                                    .child(SharedString::from(format!(
                                        "· {n} commit{} · {}…{}",
                                        if n == 1 { "" } else { "s" },
                                        strip.base,
                                        strip.branch
                                    ))),
                            ),
                    )
                    // the sums: as wide as they need up to their column, cut with … before the
                    // commits' words run into them
                    .child(
                        div()
                            .flex_shrink(1.)
                            .min_w(px(60.))
                            .max_w(px(look::PR_SCOPE_SUM_WIDTH))
                            .pl(px(12.))
                            .pr(px(12.))
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_color(look::TEXT_DIM)
                            .child(SharedString::from(format!(
                                "{} file{} · +{} −{} · {}…{}",
                                strip.files,
                                if strip.files == 1 { "" } else { "s" },
                                strip.additions,
                                strip.deletions,
                                sha8(&strip.base_sha),
                                sha8(&strip.head_sha)
                            ))),
                    ),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|t, ev: &MouseDownEvent, window, cx| {
                    t.focus_table(window, cx);
                    t.pr_all_row(cx);
                    if ev.click_count >= 2 {
                        t.focus_pr_files(window, cx);
                    }
                }),
            );
        Some(
            div()
                .flex_none()
                .flex()
                .flex_col()
                .child(row)
                .child(
                    div()
                        .h(px(1.))
                        .mx(px(look::PR_SCOPE_SEP_MARGIN_X))
                        .my(px(2.))
                        .bg(look::SEPARATOR),
                )
                .into_any_element(),
        )
    }

    /// `PR ⌄`: the repo's open PRs, Mine then Others, read by the review screen (its
    /// `pr-pick` comes back to [`Self::show_pr_pick`]); a pick is checked out in its worktree and
    /// reviewed there.
    pub fn open_pr_pick(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        self.pr_anchor = Some(anchor);
        let Some(f) = cx.try_global::<ReviewBridge>().and_then(|b| b.0.upgrade()) else {
            popups::notify(
                Balloon::error("Pull requests", "PR review needs Abe 3.x: ./install.sh"),
                window,
                cx,
            );
            return;
        };
        let root = self.gcx.scx.project.to_string_lossy().into_owned();
        f.update(cx, |f, _| {
            f.open_once(
                Slot::Review,
                SCREEN,
                BTreeMap::from([("pick".to_owned(), root)]),
            )
        });
    }

    /// The screen's `pr-pick`: the open PRs under the chip (its anchor), a pick sent back.
    pub fn show_pr_pick(
        &mut self,
        repo: String,
        rows: Vec<PickRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let anchor = self
            .pr_anchor
            .take()
            .unwrap_or(Anchor::Point(window.mouse_position()));
        self.pr_pick_rows = rows.clone();
        let menu = pick_menu(&repo, &rows, anchor);
        let numbers: Vec<Option<u64>> = rows
            .iter()
            .map(|r| match r {
                PickRow::Pr { number, .. } => Some(*number),
                PickRow::Caption { .. } => None,
            })
            .collect();
        popups::open_menu(menu, window, cx, move |choice, _, cx| {
            let Some(number) = choice.and_then(|i| numbers.get(i).copied().flatten()) else {
                return;
            };
            if let Some(f) = cx.try_global::<ReviewBridge>().and_then(|b| b.0.upgrade()) {
                f.update(cx, |f, cx| {
                    f.send_slot_input(
                        Slot::Review,
                        UserInput::Review {
                            ask: ReviewAsk::Pick { number },
                        },
                        cx,
                    )
                });
            }
        });
    }
}

fn pick_menu(repo: &str, rows: &[PickRow], anchor: Anchor) -> Menu {
    let mut captions = Vec::new();
    let entries: Vec<MenuEntry> = if rows.is_empty() {
        vec![MenuEntry::Info("No open pull requests".into())]
    } else {
        rows.iter()
            .enumerate()
            .map(|(i, r)| match r {
                PickRow::Caption { caption } => {
                    captions.push((i, SharedString::from(caption.clone())));
                    MenuEntry::Separator
                }
                PickRow::Pr {
                    number,
                    label,
                    note,
                } => {
                    let end = format!("#{number}").len();
                    let mut item = MenuItem::new(label.clone()).shortcut(note.clone());
                    item.highlights = vec![popups::Highlight {
                        range: 0..end,
                        color: Some(look::ABE_ACCENT.rgba()),
                        bold: false,
                    }];
                    item.into()
                }
            })
            .collect()
    };
    let mut menu = Menu::new(entries, anchor).title(format!("Open pull requests · {repo}"));
    menu.captions = captions;
    menu.max_rows = Some(16);
    menu.max_width = Some(px(600.));
    menu
}
