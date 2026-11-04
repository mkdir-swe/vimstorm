//! The commit details below the changed files (WebStorm's CommitDetailsPanel, M4 Lua
//! `details.lua` `render`): subject (bold), body paragraphs, "hash author <email> on date at time" (the hash a
//! link: a click copies it), the committer line, "In N branches: …"; several selected commits:
//! "N commits selected" + one "hash subject" row each (100 at most); the commit's branch / tag
//! labels between the metadata and "In N branches" (CommitDetailsPanel ReferencesPanel). The
//! message in the editor font (FontUtil.getCommitMessageFont), the rest Inter, wrapped at the
//! pane's width.

use std::sync::Arc;

use gpui_kit::{
    AnyElement, FontWeight, HighlightStyle, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, StyledText,
    div, px,
};

use crate::git::dates::{self, Zone};
use crate::git::log::{Person, Time};
use crate::git::show::{CommitDetails, branches_text};
use crate::kit::{RefKind, RefLabel};
use crate::look;

/// WS CommitDetailsPanel: SIDE_BORDER 14 (left), EXTERNAL_BORDER 14 (message top, branches
/// bottom), INTERNAL_BORDER 10 (between the message and the metadata).
pub const SIDE: f32 = 14.;
pub const EXTERNAL: f32 = 14.;
pub const INTERNAL: f32 = 10.;
/// ReferencesPanel: H_GAP between labels, 10 below the row.
pub const REFS_GAP: f32 = 4.;
pub const REFS_BOTTOM: f32 = 10.;
/// Rows listed for a multi-selection (Lua `details.lua`).
pub const MAX_LISTED: usize = 100;

/// What the text shows.
#[derive(Clone, Debug, Default)]
pub enum Info {
    #[default]
    None,
    One {
        details: Arc<CommitDetails>,
        /// The branches containing it (None: not known yet).
        branches: Option<Vec<String>>,
    },
    /// Several selected commits, newest first: (hash, subject).
    Many(Vec<(String, String)>),
}

/// "2026-10-15" / "11:56" in the local zone (WS `DateFormatUtil.formatDate` / `formatTime`).
fn date_time(t: Time) -> (String, String) {
    let l = Zone::system().local(t.unix);
    (l.date(), l.time())
}

/// "Name <email>" pieces: the name, the email in angle brackets (a link in WS).
fn person(p: &Person) -> (String, Option<String>) {
    let name = dates::display_name(p).to_owned();
    let email = (!p.email.is_empty()).then(|| format!("<{}>", p.email));
    (name, email)
}

/// The author line after the hash: "Ada Example <ada@x.se> on 2026-10-15 at 11:56" as
/// (text, link) words (WS `vcs.log.details.author.on.date.at.time`).
pub fn author_words(d: &CommitDetails) -> Vec<(String, bool)> {
    let (name, email) = person(&d.author);
    let (date, time) = date_time(d.author_time);
    let mut w: Vec<(String, bool)> = name.split(' ').map(|s| (s.to_owned(), false)).collect();
    w.extend(email.map(|e| (e, true)));
    w.extend(
        ["on", &date, "at", &time]
            .into_iter()
            .map(|s| (s.to_owned(), false)),
    );
    w
}

/// The gray committer line (WS `getCommitterHtml`): "committed by Name <email> on D at T" when
/// someone else committed it (date only when it differs from the author's), "committed on D at
/// T" when the same person committed it later; None otherwise.
pub fn committer_words(d: &CommitDetails) -> Option<Vec<(String, bool)>> {
    let other = !dates::same_person(&d.author, &d.committer)
        && !(d.committer.name.is_empty() && d.committer.email.is_empty());
    let later = d.commit_time.unix != d.author_time.unix;
    if !other && !later {
        return None;
    }
    let mut w: Vec<(String, bool)> = vec![("committed".into(), false)];
    if other {
        let (name, email) = person(&d.committer);
        w.push(("by".into(), false));
        w.extend(name.split(' ').map(|s| (s.to_owned(), false)));
        w.extend(email.map(|e| (e, true)));
    }
    if later {
        let (date, time) = date_time(d.commit_time);
        w.extend(
            ["on", &date, "at", &time]
                .into_iter()
                .map(|s| (s.to_owned(), false)),
        );
    }
    Some(w)
}

/// Every line of the text as plain strings (tests, `details_text()`).
pub fn plain(info: &Info) -> Vec<String> {
    let join = |w: Vec<(String, bool)>| w.into_iter().map(|(s, _)| s).collect::<Vec<_>>().join(" ");
    match info {
        Info::None => Vec::new(),
        Info::One { details, branches } => {
            let mut out = vec![details.subject().to_owned()];
            let body = details.body();
            if !body.is_empty() {
                out.push(String::new());
                out.extend(body.lines().map(|l| l.trim_end().to_owned()));
            }
            out.push(String::new());
            out.push(format!(
                "{} {}",
                &details.hash[..details.hash.len().min(8)],
                join(author_words(details))
            ));
            if let Some(w) = committer_words(details) {
                out.push(join(w));
            }
            if let Some(b) = branches.as_deref().and_then(branches_text) {
                out.push(String::new());
                out.push(b);
            }
            out
        }
        Info::Many(commits) => {
            let mut out = vec![format!("{} commits selected", commits.len()), String::new()];
            out.extend(
                commits
                    .iter()
                    .take(MAX_LISTED)
                    .map(|(h, s)| format!("{} {s}", &h[..h.len().min(8)])),
            );
            if commits.len() > MAX_LISTED {
                out.push(format!("and {} more", commits.len() - MAX_LISTED));
            }
            out
        }
    }
}

/// Words in a wrapping row (a word never splits; the hash / links stay clickable elements).
fn word_row(
    first: Option<AnyElement>,
    words: Vec<(String, bool)>,
    color: gpui_kit::Rgba,
) -> gpui_kit::Div {
    div()
        .flex()
        .flex_row()
        .flex_wrap()
        .children(first)
        .children(words.into_iter().map(|(w, link)| {
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_color(if link { look::LINK.rgba() } else { color })
                .child(format!("{w} "))
        }))
}

/// The labels shown: branches (local, remote), then tags (WS ReferencesPanel; HEAD and
/// origin/HEAD have no label there).
pub fn shown_refs(refs: &[(SharedString, RefKind)]) -> Vec<(SharedString, RefKind)> {
    [RefKind::LocalBranch, RefKind::RemoteBranch, RefKind::Tag]
        .into_iter()
        .flat_map(|kind| refs.iter().filter(move |(_, k)| *k == kind))
        .cloned()
        .collect()
}

/// The branch / tag labels (icon + name each).
fn refs_row(refs: &[(SharedString, RefKind)]) -> Option<gpui_kit::Div> {
    let shown = shown_refs(refs);
    (!shown.is_empty()).then(|| {
        div()
            .debug_selector(|| "details-refs".into())
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(REFS_GAP))
            .pb(px(REFS_BOTTOM))
            .children(shown.into_iter().map(|r| {
                div()
                    .flex_none()
                    .child(RefLabel::new(vec![r]).background(look::PANEL_BG.rgba()))
            }))
    })
}

/// The text's element; `refs`: the commit's labels; `on_hash`: a click on the hash.
pub fn render(
    info: &Info,
    refs: &[(SharedString, RefKind)],
    on_hash: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static,
) -> AnyElement {
    // CommitDetailsPanel emptyRight(SIDE_BORDER) too
    let col = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .pl(px(SIDE))
        .pr(px(SIDE))
        .text_color(look::TEXT);
    let blank = || div().h(px(look::VCS_DETAILS_LINE_HEIGHT));
    match info {
        Info::None => col.into_any_element(),
        Info::One { details, branches } => {
            // the subject in <b> (CommitPresentationUtil.formatCommitText)
            let mut message = div()
                .debug_selector(|| "details-message".into())
                .flex()
                .flex_col()
                .pt(px(EXTERNAL))
                .pb(px(INTERNAL))
                .font(crate::render::editor_font(false, false))
                .child(
                    div()
                        .debug_selector(|| "details-subject".into())
                        .font_weight(FontWeight::BOLD)
                        .child(SharedString::from(details.subject().to_owned())),
                );
            let body = details.body();
            if !body.is_empty() {
                message = message.child(blank());
                for l in body.lines() {
                    message = if l.trim().is_empty() {
                        message.child(blank())
                    } else {
                        message.child(div().child(SharedString::from(l.trim_end().to_owned())))
                    };
                }
            }
            let short = details.hash[..details.hash.len().min(8)].to_owned();
            let hash = div()
                .id("details-hash")
                .debug_selector(|| "details-hash".into())
                .flex_none()
                .whitespace_nowrap()
                .cursor_pointer()
                .text_color(look::LINK)
                .child(format!("{short} "))
                .on_click(on_hash);
            let meta = div()
                .flex()
                .flex_col()
                .pt(px(INTERNAL))
                .pb(px(INTERNAL))
                .child(word_row(
                    Some(hash.into_any_element()),
                    author_words(details),
                    look::TEXT.rgba(),
                ))
                .children(
                    committer_words(details)
                        .map(|w| word_row(None, w, look::VCS_DETAILS_COMMITTER_FG.rgba())),
                );
            let branches = branches.as_deref().and_then(branches_text).map(|b| {
                div()
                    .debug_selector(|| "details-branches".into())
                    .pb(px(EXTERNAL))
                    .child(b)
            });
            col.child(message)
                .child(meta)
                .children(refs_row(refs))
                .children(branches)
                .into_any_element()
        }
        Info::Many(commits) => {
            let link = HighlightStyle {
                color: Some(look::LINK.into()),
                ..Default::default()
            };
            let rows = commits.iter().take(MAX_LISTED).map(|(h, s)| {
                let short = &h[..h.len().min(8)];
                let text = format!("{short} {s}");
                div().child(StyledText::new(text).with_highlights([(0..short.len(), link)]))
            });
            let more = (commits.len() > MAX_LISTED).then(|| {
                div()
                    .text_color(look::TEXT_DIM)
                    .child(format!("and {} more", commits.len() - MAX_LISTED))
            });
            col.pt(px(EXTERNAL))
                .pb(px(EXTERNAL))
                .child(div().child(format!("{} commits selected", commits.len())))
                .child(blank())
                .children(rows)
                .children(more)
                .into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn details(committer: (&str, &str), commit_time: i64) -> CommitDetails {
        CommitDetails {
            hash: "0123456789abcdef".into(),
            parents: vec![],
            author: Person {
                name: "Ada Example".into(),
                email: "ada@x.se".into(),
            },
            author_time: Time {
                unix: 1_000_000,
                offset_min: 0,
            },
            committer: Person {
                name: committer.0.into(),
                email: committer.1.into(),
            },
            commit_time: Time {
                unix: commit_time,
                offset_min: 0,
            },
            message: "Subject\n\nBody one.\n\nBody two.".into(),
            files: vec![],
        }
    }

    #[test]
    fn committer_line_follows_ws() {
        // same person (names compared loosely), same time: none
        assert!(committer_words(&details(("ada.example", "other@x.se"), 1_000_000)).is_none());
        // same person later: "committed on D at T"
        let w = committer_words(&details(("Ada Example", "ada@x.se"), 2_000_000)).unwrap();
        assert_eq!(w[0].0, "committed");
        assert_eq!(w[1].0, "on");
        // someone else, same time: "committed by X <email>" without a date
        let w = committer_words(&details(("GitHub", "noreply@github.com"), 1_000_000)).unwrap();
        let text: Vec<&str> = w.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(text, ["committed", "by", "GitHub", "<noreply@github.com>"]);
        assert!(w[3].1, "the email is a link");
    }

    #[test]
    fn plain_lines() {
        let d = Arc::new(details(("Ada Example", "ada@x.se"), 1_000_000));
        let lines = plain(&Info::One {
            details: d,
            branches: Some(vec!["master".into()]),
        });
        assert_eq!(lines[..5], ["Subject", "", "Body one.", "", "Body two."]);
        assert!(lines[6].starts_with("01234567 Ada Example <ada@x.se> on "));
        assert_eq!(lines.last().unwrap(), "In 1 branch: master");
        let many: Vec<(String, String)> = (0..102)
            .map(|i| (format!("{i:08}abc"), format!("c{i}")))
            .collect();
        let lines = plain(&Info::Many(many));
        assert_eq!(lines[0], "102 commits selected");
        assert_eq!(lines[2], "00000000 c0");
        assert_eq!(lines.last().unwrap(), "and 2 more");
        assert_eq!(lines.len(), 2 + MAX_LISTED + 1);
    }
}
