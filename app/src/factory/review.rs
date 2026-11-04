//! The PR review's wire (`abe/packages/ui/src/review/review-components.ts`, `review-asks.ts`): the
//! `ReviewPane` node the `review` slot's screen sends (the strip over the Git Log, the files pane,
//! what the diff's `,i` keys show), the asks the Git tool window and the diff send it, and the
//! effects it answers with. Every word is the screen's; the Git tool window only draws them
//! (`crate::git::window`).

use serde::{Deserialize, Serialize};

/// A status's tone, as the review says it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    #[default]
    Info,
    Ok,
    Warn,
    Error,
}

impl Tone {
    /// As `config.app.review.said` takes it.
    pub fn lua(self) -> &'static str {
        match self {
            Tone::Info => "info",
            Tone::Ok => "ok",
            Tone::Warn => "warn",
            Tone::Error => "error",
        }
    }
}

/// A line's side of the diff: LEFT the base, RIGHT the head.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Side {
    #[serde(rename = "LEFT")]
    Left,
    #[serde(rename = "RIGHT")]
    Right,
}

impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Side::Left => "LEFT",
            Side::Right => "RIGHT",
        }
    }

    pub fn of(name: &str) -> Option<Side> {
        match name {
            "LEFT" => Some(Side::Left),
            "RIGHT" => Some(Side::Right),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Dir,
    Area,
    Group,
}

/// A line of the files pane.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PaneLine {
    Node {
        key: String,
        node: NodeKind,
        label: String,
        depth: usize,
        open: bool,
        /// Its files (`· not ranked` after a group's).
        count: String,
        /// Every PR file under it is reviewed.
        reviewed: bool,
    },
    #[serde(rename_all = "camelCase")]
    File {
        path: String,
        label: String,
        depth: usize,
        /// git's letter: A M D R.
        status: String,
        /// The heat shown (`·` none).
        heat: String,
        /// By heat: its full path at depth 0, the heat in front, the folder dim after.
        flat: bool,
        reviewed: bool,
        additions: u32,
        deletions: u32,
        changes: usize,
        hunk: Option<usize>,
        threads: usize,
        drafts: usize,
        outdated: bool,
    },
    Band,
    Gap,
}

/// What the strip shows of the PR's commits: all changes, one commit, a range (1-based places).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Scope {
    All,
    Commit {
        place: usize,
        sha: String,
    },
    #[serde(rename_all = "camelCase")]
    Range {
        from: usize,
        to: usize,
        from_sha: String,
        to_sha: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CommitFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// One of the PR's commits, oldest first.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct StripCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub files: Vec<CommitFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Badge {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Hue {
    Good,
    Warn,
    Bad,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Checks {
    pub label: String,
    pub hue: Hue,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Threads {
    pub label: String,
    pub open: bool,
}

/// The PR strip over the Log and the files pane's count.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Strip {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub body: String,
    pub badge: Badge,
    pub checks: Option<Checks>,
    pub threads: Option<Threads>,
    pub outdated: usize,
    pub own: bool,
    pub drafts: usize,
    pub scope: Scope,
    pub scope_label: String,
    pub scope_sub: String,
    pub switch_label: String,
    pub commits: Vec<StripCommit>,
    pub base_sha: String,
    pub head_sha: String,
    pub new_revision: Option<String>,
    /// Who decided: `✓ ada approved · ✗ cy requested changes`.
    #[serde(default)]
    pub reviews: Option<Checks>,
    /// `3 new`: comments GitHub had that the person has not looked at yet.
    #[serde(default)]
    pub fresh: Option<String>,
    pub files: usize,
    pub reviewed: usize,
    pub additions: u32,
    pub deletions: u32,
    pub files_label: String,
    pub can_submit: bool,
}

impl Strip {
    /// The Submit review button's label: `Submit review (N)`.
    pub fn submit_label(&self) -> String {
        format!("Submit review ({})", self.drafts)
    }
}

/// A draft waiting to go, where it sits: the diff's gutter marks the line.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Drafted {
    pub seq: u64,
    pub path: String,
    pub side: Side,
    pub line: u32,
    pub body: String,
    pub head: Option<String>,
    pub outdated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ThreadComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub url: String,
}

/// Your reply kept for a discussion: its text, tried and unconfirmed, why it did not go.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ThreadReply {
    pub body: String,
    pub unconfirmed: bool,
    pub error: Option<String>,
}

/// A posted discussion on the PR's diff.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub path: String,
    pub side: Side,
    pub line: Option<u32>,
    pub start: Option<u32>,
    pub head: String,
    pub outdated: bool,
    pub resolved: bool,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub comments: Vec<ThreadComment>,
    pub reply: Option<ThreadReply>,
}

/// GitHub's review events.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Comment,
    RequestChanges,
    Approve,
}

impl Verdict {
    pub fn label(self) -> &'static str {
        match self {
            Verdict::Comment => "Comment",
            Verdict::RequestChanges => "Request changes",
            Verdict::Approve => "Approve",
        }
    }

    /// GitHub's `event`.
    pub fn event(self) -> &'static str {
        match self {
            Verdict::Comment => "COMMENT",
            Verdict::RequestChanges => "REQUEST_CHANGES",
            Verdict::Approve => "APPROVE",
        }
    }

    pub fn of_event(s: &str) -> Option<Verdict> {
        [Verdict::Comment, Verdict::RequestChanges, Verdict::Approve]
            .into_iter()
            .find(|v| v.event() == s)
    }
}

/// The verdict and summary kept for Submit review.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Saved {
    pub head: String,
    pub verdict: Verdict,
    pub body: String,
}

/// A row of the files pane's right-click menu.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MenuRow {
    pub run: String,
    pub key: String,
    pub label: String,
    pub enabled: bool,
}

/// A lifecycle row of the Log's PR menu: grey with why.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Lifecycle {
    pub id: String,
    pub title: String,
    pub reason: Option<String>,
}

/// A comment on the PR's conversation, or a review sent with a verdict or a summary.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ConversationItem {
    /// `comment`, `approved`, `changes`, `commented`, `dismissed`.
    pub kind: String,
    pub author: String,
    pub body: String,
    /// How long ago (`5 min ago`).
    pub when: String,
}

/// The `ReviewPane` node: one PR under review, as the Git tool window draws it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPaneProps {
    /// The checkout it is read in, and the PR.
    pub root: String,
    pub number: u64,
    pub title: String,
    pub said: String,
    pub tone: Tone,
    pub heat: bool,
    pub since: bool,
    pub lines: Vec<PaneLine>,
    pub at: Option<usize>,
    pub drafted: Vec<Drafted>,
    pub threads: Vec<Thread>,
    pub threads_note: Option<String>,
    pub saved: Option<Saved>,
    pub strip: Option<Strip>,
    /// The PR's conversation, oldest first.
    #[serde(default)]
    pub conversation: Vec<ConversationItem>,
    pub menu: Vec<MenuRow>,
    pub lifecycle: Vec<Lifecycle>,
}

/// What the review's surfaces ask of the `review` slot's screen (the `review` input).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReviewAsk {
    /// `,ic` (`now`: posted at once): a comment on a line (or from `start`) of `base`..`head`.
    Comment {
        path: String,
        side: Side,
        line: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        body: String,
        base: String,
        head: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        now: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replaces: Option<u64>,
    },
    Reply {
        thread: String,
        body: String,
    },
    Resolve {
        thread: String,
        resolved: bool,
    },
    Edit {
        seq: u64,
        body: String,
    },
    Delete {
        seq: u64,
    },
    Verdict {
        verdict: Verdict,
        body: String,
    },
    Next,
    At {
        line: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        open: Option<bool>,
    },
    Scope {
        commits: Vec<String>,
    },
    Rescope {
        commits: Vec<String>,
        path: String,
    },
    Step {
        dir: i8,
    },
    Order {
        heat: bool,
    },
    Mark {
        path: String,
    },
    Menu {
        run: String,
    },
    Lifecycle {
        id: String,
    },
    /// The conversation's Comment.
    Say {
        body: String,
    },
    Pick {
        number: u64,
    },
}

/// A file of the diff VimStorm's viewer walks.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DiffPr {
    pub number: u64,
    pub head: String,
}

/// A row of the Git Log's PR pick: a caption (Mine, Others) or a PR with its note at the right.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum PickRow {
    Caption {
        caption: String,
    },
    Pr {
        number: u64,
        label: String,
        note: String,
    },
}
