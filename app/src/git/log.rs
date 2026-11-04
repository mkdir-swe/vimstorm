//! The Log tab's data: `git log` with the Lua log's filters (Lua `git/log.lua` `M.args`:
//! text or hash with `.*` / `Cc`, branch, users, date, paths, Show History for Selection's
//! `-L`), plus file history (`--follow`), streamed: the first rows arrive while git still walks
//! history, each snapshot with its graph layout ([`super::graph`]).
//!
//! Differences to the Lua log (it parsed `git log --graph`'s ASCII art): Rust lays the graph out
//! itself (IntelliJ's algorithm), so the log runs with `--date-order` (IntelliJ's default "Off"
//! sort: by commit date, parents after children) and `--parents` when paths filter it (git
//! rewrites the parents through the filtered history).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::channel::mpsc;

use super::cli::{self, Cancel};
use super::graph::{self, Graph, GraphOptions};

/// Field / record separators of the log format (never in names or subjects).
const FS: char = '\x1f';
const RS: char = '\x1e';

/// One commit per line: hash, parents, author name / email / unix time / ISO time (for the
/// zone), committer ditto, decorations (full ref names), subject.
pub const FORMAT: &str =
    "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%aI%x1f%cn%x1f%ce%x1f%ct%x1f%cI%x1f%D%x1f%s";

/// Someone's name + email as git recorded them (no mailmap: the User filter matches these).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Person {
    pub name: String,
    pub email: String,
}

/// A point in time with its zone (git's `%at` + the offset of `%aI`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Time {
    /// Seconds since the epoch.
    pub unix: i64,
    /// The zone's offset from UTC in minutes (+120 = UTC+2).
    pub offset_min: i32,
}

impl Time {
    /// From `%at`-style seconds and a `%aI` ISO date (`2026-10-01T10:00:00+02:00`, `...Z`).
    pub fn parse(unix: &str, iso: &str) -> Time {
        Time {
            unix: unix.trim().parse().unwrap_or(0),
            offset_min: parse_offset(iso),
        }
    }
}

/// The zone offset at the end of an ISO 8601 date, in minutes.
fn parse_offset(iso: &str) -> i32 {
    let iso = iso.trim();
    if iso.ends_with('Z') || iso.len() < 6 {
        return 0;
    }
    let tail = &iso[iso.len() - 6..];
    let sign = match tail.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return 0,
    };
    let h: i32 = tail[1..3].parse().unwrap_or(0);
    let m: i32 = tail[4..6].parse().unwrap_or(0);
    sign * (h * 60 + m)
}

/// HEAD on a commit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum HeadRef {
    #[default]
    None,
    /// `HEAD -> refs/heads/<name>`.
    Branch(String),
    /// Detached HEAD here.
    Detached,
}

/// The refs on a commit (`%D` with full ref names), short names.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Refs {
    pub head: HeadRef,
    /// Local branches (the current one included), git's order.
    pub local: Vec<String>,
    /// `origin/x` (no `origin/HEAD`).
    pub remote: Vec<String>,
    pub tags: Vec<String>,
    /// Remote HEADs (`origin/HEAD`): WS draws them as a gray "other" tag, without a name.
    pub other: Vec<String>,
}

/// A kind of ref label icon (WS VCS log ref colors: HEAD yellow, local green, remote purple,
/// tag gray).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RefKind {
    Head,
    Local,
    Remote,
    Tag,
}

/// One label of the log row's refs (Lua `git/log.lua` `ref_labels`): its icons and name. A local
/// branch and its remote on the same commit share one: "origin & master"; tags get one label
/// without a name (one icon, stacked when there are several).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefLabel {
    pub icons: Vec<RefKind>,
    pub name: Option<String>,
    /// The tag label's count (0 for branches).
    pub tags: usize,
}

impl Refs {
    /// Parses `%D` with `--decorate=full`: `HEAD -> refs/heads/master, refs/remotes/origin/master,
    /// tag: refs/tags/v1`. Other refs (stash, notes) are left out.
    pub fn parse(d: &str) -> Refs {
        let mut r = Refs::default();
        for part in d.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
            if part == "HEAD" {
                r.head = HeadRef::Detached;
            } else if let Some(b) = part.strip_prefix("HEAD -> ") {
                let name = b.strip_prefix("refs/heads/").unwrap_or(b).to_owned();
                r.local.push(name.clone());
                r.head = HeadRef::Branch(name);
            } else if let Some(t) = part.strip_prefix("tag: ") {
                r.tags
                    .push(t.strip_prefix("refs/tags/").unwrap_or(t).to_owned());
            } else if let Some(b) = part.strip_prefix("refs/heads/") {
                r.local.push(b.to_owned());
            } else if let Some(b) = part.strip_prefix("refs/remotes/")
                && b.contains('/')
            {
                if b.ends_with("/HEAD") {
                    r.other.push(b.to_owned());
                } else {
                    r.remote.push(b.to_owned());
                }
            }
        }
        r
    }

    pub fn is_empty(&self) -> bool {
        self.head == HeadRef::None
            && self.local.is_empty()
            && self.remote.is_empty()
            && self.tags.is_empty()
    }

    /// HEAD is on this commit (the WS log draws its node hollow / its row bold).
    pub fn is_head(&self) -> bool {
        self.head != HeadRef::None
    }

    /// The labels in WS order (Lua `git/log.lua` `ref_labels`): tags, the current branch,
    /// detached HEAD, other local branches, remote branches; names sorted within a kind.
    pub fn labels(&self) -> Vec<RefLabel> {
        let current = match &self.head {
            HeadRef::Branch(b) => Some(b.as_str()),
            _ => None,
        };
        let mut locals: Vec<&str> = self
            .local
            .iter()
            .map(String::as_str)
            .filter(|l| Some(*l) != current)
            .collect();
        locals.sort_unstable();
        let mut remotes: Vec<&str> = self.remote.iter().map(String::as_str).collect();
        remotes.sort_unstable();
        let mut labels = Vec::new();
        if !self.tags.is_empty() {
            labels.push(RefLabel {
                icons: vec![RefKind::Tag],
                name: None,
                tags: self.tags.len(),
            });
        }
        let mut branch = |name: &str, kind: RefKind, remotes: &mut Vec<&str>| {
            let mut label = RefLabel {
                icons: vec![kind],
                name: Some(name.to_owned()),
                tags: 0,
            };
            let paired = remotes
                .iter()
                .position(|r| r.split_once('/').is_some_and(|(_, short)| short == name));
            if let Some(i) = paired {
                let r = remotes.remove(i);
                let remote = r.split_once('/').map_or(r, |(remote, _)| remote);
                label.icons.push(RefKind::Remote);
                label.name = Some(format!("{remote} & {name}"));
            }
            labels.push(label);
        };
        if let Some(c) = current {
            branch(c, RefKind::Head, &mut remotes);
        }
        if self.head == HeadRef::Detached {
            branch("HEAD", RefKind::Head, &mut Vec::new());
        }
        for l in locals {
            branch(l, RefKind::Local, &mut remotes);
        }
        for r in remotes {
            labels.push(RefLabel {
                icons: vec![RefKind::Remote],
                name: Some(r.to_owned()),
                tags: 0,
            });
        }
        labels
    }
}

/// Show History for Selection: a commit's change to the selected lines (its part of `git log
/// -L`'s patch, Lua `git/log.lua` `GitLinesChange`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinesChange {
    /// The file at the commit.
    pub path: String,
    /// Before the commit, when renamed.
    pub old_path: Option<String>,
    /// The file came with this commit (`--- /dev/null`).
    pub added: bool,
    /// First line of the change in the commit's version.
    pub line: u32,
}

/// One row of the log.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: Person,
    pub committer: Person,
    pub author_time: Time,
    pub commit_time: Time,
    pub refs: Refs,
    pub subject: String,
    /// Show History for Selection only.
    pub change: Option<LinesChange>,
}

impl Commit {
    pub fn short(&self) -> &str {
        &self.hash[..self.hash.len().min(8)]
    }

    /// The author column's text: "Name*" when someone else committed it (rebased, cherry-picked,
    /// applied), like WebStorm (Lua `git/log.lua` `author_text`; see
    /// [`super::dates::author_text`]).
    pub fn author_text(&self) -> String {
        super::dates::author_text(&self.author, &self.committer)
    }

    /// Parses one log line (`FORMAT`, starting with the record separator).
    pub fn parse(line: &str) -> Option<Commit> {
        let rest = line.strip_prefix(RS)?;
        let mut f = rest.splitn(12, FS);
        let mut next = || f.next().unwrap_or("");
        let hash = next().to_owned();
        if hash.len() < 7 {
            return None;
        }
        let parents = next().split_whitespace().map(str::to_owned).collect();
        let author = Person {
            name: next().to_owned(),
            email: next().to_owned(),
        };
        let at = next();
        let author_time = Time::parse(at, next());
        let committer = Person {
            name: next().to_owned(),
            email: next().to_owned(),
        };
        let ct = next();
        let commit_time = Time::parse(ct, next());
        let refs = Refs::parse(next());
        let subject = next().to_owned();
        Some(Commit {
            hash,
            parents,
            author,
            committer,
            author_time,
            commit_time,
            refs,
            subject,
            change: None,
        })
    }
}

/// The Branch filter (Lua `git/log.lua` filters.branch: "HEAD", "--all" or a ref).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub enum BranchFilter {
    #[default]
    Head,
    All,
    Ref(String),
}

impl BranchFilter {
    /// From the Lua session value ("HEAD", "--all", a ref).
    pub fn from_lua(v: &str) -> BranchFilter {
        match v {
            "" | "HEAD" => BranchFilter::Head,
            "--all" => BranchFilter::All,
            r => BranchFilter::Ref(r.to_owned()),
        }
    }

    /// The git argument (and the Lua session value).
    pub fn arg(&self) -> &str {
        match self {
            BranchFilter::Head => "HEAD",
            BranchFilter::All => "--all",
            BranchFilter::Ref(r) => r,
        }
    }

    /// The Log tab's label ("Log: HEAD", "Log: main"; just "Log" for all branches).
    pub fn tab_label(&self) -> String {
        match self {
            BranchFilter::All => "Log".into(),
            b => format!("Log: {}", b.arg()),
        }
    }
}

/// The Date filter's choices (Lua `git/log.lua` `M.DATES`) plus a custom range.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum DateFilter {
    Last24Hours,
    Last7Days,
    Last30Days,
    LastYear,
    /// Git date strings (`2026-01-31`, `2 weeks ago`); either may be missing.
    Range {
        since: Option<String>,
        until: Option<String>,
    },
}

impl DateFilter {
    /// The presets in menu order.
    pub const PRESETS: [DateFilter; 4] = [
        DateFilter::Last24Hours,
        DateFilter::Last7Days,
        DateFilter::Last30Days,
        DateFilter::LastYear,
    ];

    /// The session id (`24h`, `7d`, `30d`, `1y`); None for a custom range.
    pub fn id(&self) -> Option<&'static str> {
        Some(match self {
            DateFilter::Last24Hours => "24h",
            DateFilter::Last7Days => "7d",
            DateFilter::Last30Days => "30d",
            DateFilter::LastYear => "1y",
            DateFilter::Range { .. } => return None,
        })
    }

    /// The picker / chip text.
    pub fn label(&self) -> String {
        match self {
            DateFilter::Last24Hours => "Last 24 Hours".into(),
            DateFilter::Last7Days => "Last 7 Days".into(),
            DateFilter::Last30Days => "Last 30 Days".into(),
            DateFilter::LastYear => "Last Year".into(),
            DateFilter::Range { since, until } => match (since, until) {
                (Some(s), Some(u)) => format!("{s} – {u}"),
                (Some(s), None) => format!("Since {s}"),
                (None, Some(u)) => format!("Until {u}"),
                (None, None) => "All".into(),
            },
        }
    }

    /// A preset by id or label (sessions saved before the ids kept the label: `date_choice`).
    pub fn from_id(v: &str) -> Option<DateFilter> {
        Self::PRESETS
            .into_iter()
            .find(|d| d.id() == Some(v) || d.label() == v)
    }

    fn args(&self) -> Vec<String> {
        let since = match self {
            DateFilter::Last24Hours => "24 hours ago",
            DateFilter::Last7Days => "7 days ago",
            DateFilter::Last30Days => "30 days ago",
            DateFilter::LastYear => "1 year ago",
            DateFilter::Range { since, until } => {
                let mut a = Vec::new();
                if let Some(s) = since {
                    a.push(format!("--since-as-filter={s}"));
                }
                if let Some(u) = until {
                    a.push(format!("--until={u}"));
                }
                return a;
            }
        };
        vec![format!("--since-as-filter={since}")]
    }
}

/// Show History for Selection's lines (Lua `git/log.lua` `GitLineRange`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LineRange {
    /// Repo-relative, at HEAD.
    pub path: String,
    /// First / last line at HEAD (1-based).
    pub from: u32,
    pub to: u32,
}

/// PR review's filter (1.0, the Log's `PR: #n` chip): the PR's commits, `base..head`, in the
/// worktree it is checked out in.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PrRange {
    pub number: u64,
    /// The merge base and the head read.
    pub base: String,
    pub head: String,
}

/// The Log's filters (Lua `git/log.lua` `GitFilters`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct LogFilters {
    /// Message text or a commit hash.
    pub text: Option<String>,
    /// The text is a regex (the field's `.*`).
    pub regex: bool,
    /// The text matches case (the field's `Cc`).
    pub match_case: bool,
    pub branch: BranchFilter,
    /// Author names (any of them).
    pub authors: Vec<String>,
    pub date: Option<DateFilter>,
    /// Repo-relative paths (files or folders).
    pub paths: Vec<String>,
    /// File history: follow renames (`--follow`; only with exactly one path).
    pub follow: bool,
    /// Show History for Selection (replaces `paths`).
    pub lines: Option<LineRange>,
    /// PR review: the PR's commits in place of the branch (not kept in the session).
    pub pr: Option<PrRange>,
}

impl LogFilters {
    /// File history (WS Show History for File): the file's commits through renames.
    pub fn file_history(path: impl Into<String>) -> LogFilters {
        LogFilters {
            paths: vec![path.into()],
            follow: true,
            ..Default::default()
        }
    }

    fn text(&self) -> Option<&str> {
        self.text.as_deref().filter(|t| !t.is_empty())
    }

    /// Filters that hide commits whose parents are listed (text / user / date): their rows'
    /// parents may be missing, which is no reason to draw an edge.
    pub fn hides_commits(&self) -> bool {
        self.text().is_some() || !self.authors.is_empty() || self.date.is_some()
    }

    /// A hex text of 7+ chars may be a hash (then [`is_hash_blocking`] asks git).
    pub fn text_may_be_hash(&self) -> bool {
        self.lines.is_none()
            && self
                .text()
                .is_some_and(|t| t.len() >= 7 && t.chars().all(|c| c.is_ascii_hexdigit()))
    }
}

/// Escapes a literal for git's regex flavor (basic by default, extended with `.*` on).
fn regex_escape(s: &str, extended: bool) -> String {
    let special: &[char] = if extended {
        &[
            '.', '*', '^', '$', '[', ']', '\\', '+', '?', '(', ')', '{', '}', '|',
        ]
    } else {
        &['.', '*', '^', '$', '[', ']', '\\']
    };
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if special.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// What the log shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    /// The commit graph.
    Graph,
    /// One commit found by its hash (no graph, `--no-walk`).
    Hash,
    /// Show History for Selection (`-L`): a plain list with a hash column, no graph.
    Lines,
}

/// The `git log` arguments for the filters (Lua `git/log.lua` `M.args`). `is_hash`: the text is
/// a commit hash ([`is_hash_blocking`]). `limit`: at most this many commits.
pub fn log_args(f: &LogFilters, is_hash: bool, limit: Option<usize>) -> (Vec<String>, LogKind) {
    let mut a: Vec<String> = [
        "log",
        "--no-color",
        "--no-show-signature",
        "--decorate=full",
        FORMAT,
    ]
    .map(String::from)
    .to_vec();
    if let Some(n) = limit {
        a.push(format!("-n{n}"));
    }
    if let (Some(text), true, None) = (f.text(), is_hash, &f.lines) {
        a.extend(["--no-walk".into(), text.to_owned()]);
        return (a, LogKind::Hash);
    }
    let kind = if f.lines.is_some() {
        LogKind::Lines
    } else {
        LogKind::Graph
    };
    if kind == LogKind::Graph {
        a.push("--date-order".into());
    }
    if let Some(text) = f.text() {
        a.push(
            if f.regex {
                "--extended-regexp"
            } else {
                "--fixed-strings"
            }
            .into(),
        );
        if !f.match_case {
            a.push("--regexp-ignore-case".into());
        }
        a.push(format!("--grep={text}"));
    }
    for name in &f.authors {
        // `--fixed-strings` covers --author too: the name as is then (a substring of "Name
        // <email>"); else anchored like the Lua log
        if f.text().is_some() && !f.regex {
            a.push(format!("--author={name} <"));
        } else {
            // ERE only with a text filter (`--extended-regexp` comes with it): `.*` alone
            // leaves git's basic regex
            let ere = f.regex && f.text().is_some();
            a.push(format!("--author=^{} <", regex_escape(name, ere)));
        }
    }
    if let Some(d) = &f.date {
        a.extend(d.args());
    }
    if let Some(l) = &f.lines {
        a.push(f.branch.arg().to_owned());
        a.push(format!("-L{},{}:{}", l.from, l.to, l.path));
        return (a, kind);
    }
    if !f.paths.is_empty() {
        // parents rewritten through the filtered history: the graph connects the listed commits
        a.push("--parents".into());
        if f.follow && f.paths.len() == 1 {
            a.push("--follow".into());
        }
    }
    match &f.pr {
        // the merge base comes too (`--boundary`), drawn dim under the PR's commits
        Some(pr) => a.extend(["--boundary".to_owned(), format!("{}..{}", pr.base, pr.head)]),
        None => a.push(f.branch.arg().to_owned()),
    }
    if !f.paths.is_empty() {
        a.push("--".into());
        a.extend(f.paths.iter().cloned());
    }
    (a, kind)
}

/// Is `text` a commit of this repo (Lua `git/log.lua` `is_hash`)? Blocking.
pub fn is_hash_blocking(dir: &Path, text: &str) -> bool {
    if text.len() < 7 || !text.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    cli::run_blocking(
        dir,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{text}^{{commit}}"),
        ],
    )
    .is_ok_and(|o| o.ok())
}

/// Parses `git log` output line by line: commit lines, and in `-L` mode each commit's patch
/// (Lua `git/log.lua` `parse_lines`: `--- a/old`, `+++ b/new`, the first `@@`).
#[derive(Default)]
pub struct LogParser {
    lines_mode: bool,
    /// Past the current commit's first `@@` (the rest is patch text).
    done: bool,
    pub commits: Vec<Commit>,
}

impl LogParser {
    pub fn new(kind: LogKind) -> Self {
        LogParser {
            lines_mode: kind == LogKind::Lines,
            done: true,
            commits: Vec::new(),
        }
    }

    /// Takes one line; true when it completed a new commit row.
    pub fn line(&mut self, line: &str) -> bool {
        if line.starts_with(RS) {
            let Some(mut c) = Commit::parse(line) else {
                return false;
            };
            if self.lines_mode {
                c.change = Some(LinesChange {
                    line: 1,
                    ..Default::default()
                });
                self.done = false;
            }
            self.commits.push(c);
            return true;
        }
        if !self.lines_mode || self.done {
            return false;
        }
        let Some(b) = self.commits.last_mut().and_then(|c| c.change.as_mut()) else {
            return false;
        };
        if let Some(rest) = line.strip_prefix("--- ") {
            b.old_path = rest.strip_prefix("a/").map(str::to_owned);
            b.added = b.old_path.is_none(); // --- /dev/null
        } else if let Some(p) = line.strip_prefix("+++ b/") {
            b.path = p.to_owned();
            if b.old_path.as_deref() == Some(p) {
                b.old_path = None;
            }
        } else if let Some(rest) = line.strip_prefix("@@ ") {
            // "@@ -a,b +c,d @@": c
            let new = rest.split_whitespace().nth(1).unwrap_or("+1");
            let start = new.trim_start_matches('+').split(',').next().unwrap_or("1");
            b.line = start.parse::<u32>().unwrap_or(1).max(1);
            self.done = true;
        }
        false
    }

    /// The whole output at once (tests, small logs).
    pub fn parse(kind: LogKind, out: &str) -> Vec<Commit> {
        let mut p = LogParser::new(kind);
        for l in out.lines() {
            p.line(l);
        }
        p.commits
    }
}

/// One state of a loading log: the rows so far and their graph.
#[derive(Clone, Debug)]
pub struct LogSnapshot {
    pub commits: Arc<Vec<Commit>>,
    pub graph: Arc<Graph>,
    pub kind: LogKind,
    /// git finished (or failed: `error`); no more snapshots come.
    pub done: bool,
    /// Stopped at the limit: more commits exist (Lua `load_more`).
    pub truncated: bool,
    /// git's error text (bad ref / regex ...); `commits` is empty then.
    pub error: Option<String>,
}

/// Load options.
#[derive(Clone, Debug, Default)]
pub struct LogOptions {
    /// At most this many commits (None: all).
    pub limit: Option<usize>,
    pub graph: GraphOptions,
    /// WS IntelliSort: a branch's commits together (`--topo-order`) instead of by date
    /// (`--date-order`, WS "Off", the default).
    pub intellisort: bool,
}

/// A running log load: a `futures::Stream` of snapshots (the last one has `done`). Dropping it
/// kills git, so replacing the stored stream with a newer load cancels the old one.
pub struct LogStream {
    updates: mpsc::UnboundedReceiver<LogSnapshot>,
    cancel: Cancel,
}

impl futures::Stream for LogStream {
    type Item = LogSnapshot;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<LogSnapshot>> {
        std::pin::Pin::new(&mut self.updates).poll_next(cx)
    }
}

impl LogStream {
    /// Stops the load (git is killed; no more snapshots).
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// When to send a snapshot: after the first screen's rows (or 150 ms with any), then every
/// time the rows grew 5x (each snapshot lays out the graph of all rows so far), then at the end.
const FIRST_BATCH: usize = 200;
const FIRST_WAIT: Duration = Duration::from_millis(150);

/// Starts `git log` for the filters on its own thread. The UI awaits `updates` from a
/// `cx.spawn` and applies each snapshot (they're cumulative: replace, don't append).
pub fn stream(dir: PathBuf, filters: LogFilters, opts: LogOptions) -> LogStream {
    let (tx, rx) = mpsc::unbounded();
    let cancel = Cancel::new();
    let c = cancel.clone();
    std::thread::Builder::new()
        .name("git-log".into())
        .spawn(move || run_stream(&dir, &filters, &opts, &c, &tx))
        .expect("spawn git-log thread");
    LogStream {
        updates: rx,
        cancel,
    }
}

fn run_stream(
    dir: &Path,
    filters: &LogFilters,
    opts: &LogOptions,
    cancel: &Cancel,
    tx: &mpsc::UnboundedSender<LogSnapshot>,
) {
    let is_hash = filters.text_may_be_hash() && is_hash_blocking(dir, filters.text().unwrap());
    let (mut args, kind) = log_args(filters, is_hash, opts.limit);
    if opts.intellisort {
        for a in args.iter_mut().filter(|a| a.as_str() == "--date-order") {
            *a = "--topo-order".into();
        }
    }
    let gopts = GraphOptions {
        dangling: !filters.hides_commits(),
        ..opts.graph.clone()
    };
    // `--date-order` makes git walk all of history before its first line (without a
    // commit-graph file): a plain-order `-n FIRST_BATCH` run shows the first screen meanwhile
    // (LOG; same rows on any repo without clock skew), replaced by the first real snapshot
    let main_sent = Arc::new(std::sync::Mutex::new(false));
    if kind == LogKind::Graph && opts.limit.is_none_or(|l| l > FIRST_BATCH) {
        let preview: Vec<String> = args
            .iter()
            .filter(|a| a.as_str() != "--date-order" && a.as_str() != "--topo-order")
            .cloned()
            .collect();
        let (dir, tx, main_sent, gopts) = (
            dir.to_path_buf(),
            tx.clone(),
            main_sent.clone(),
            gopts.clone(),
        );
        let _ = std::thread::Builder::new()
            .name("git-log-preview".into())
            .spawn(move || preview_first_screen(&dir, preview, kind, &gopts, &tx, &main_sent));
    }
    // WS colors the graph of all refs, so with one branch listed master / main keep their color
    // from where they fork off (their heads aren't listed): their merge-bases with the listed
    // branch stand in for their refs in the layout (Lua `bases`; LOG)
    let bases_job =
        (kind == LogKind::Graph && filters.branch != BranchFilter::All && filters.paths.is_empty())
            .then(|| {
                let (dir, branch) = (dir.to_path_buf(), filters.branch.arg().to_owned());
                std::thread::spawn(move || main_bases_blocking(&dir, &branch))
            });
    let bases_job = std::cell::RefCell::new(bases_job);
    let bases: std::cell::RefCell<Vec<(String, String)>> = Default::default();
    let take_bases = |wait: bool| {
        let mut job = bases_job.borrow_mut();
        if job.as_ref().is_some_and(|j| wait || j.is_finished())
            && let Some(Ok(b)) = job.take().map(|j| j.join())
        {
            *bases.borrow_mut() = b;
        }
    };
    let mut parser = LogParser::new(kind);
    let start = Instant::now();
    let mut next = FIRST_BATCH;
    let mut sent = 0usize;
    let snapshot = |commits: &[Commit], done: bool, truncated: bool, error: Option<String>| {
        take_bases(done);
        let colored = with_bases(commits, &bases.borrow());
        let graph = graph::layout(colored.as_deref().unwrap_or(commits), &gopts);
        LogSnapshot {
            commits: Arc::new(commits.to_vec()),
            graph: Arc::new(graph),
            kind,
            done,
            truncated,
            error,
        }
    };
    let res = cli::run_lines(dir, &args, cancel, |line| {
        if !parser.line(line) {
            return true;
        }
        let n = parser.commits.len();
        // in -L mode a commit's patch follows it: send it with the next commit
        let ready = if kind == LogKind::Lines { n - 1 } else { n };
        if ready >= next || (sent == 0 && ready > 0 && start.elapsed() >= FIRST_WAIT) {
            sent = ready;
            next = (ready * 5).max(FIRST_BATCH);
            let snap = snapshot(&parser.commits[..ready], false, false, None);
            let mut first = main_sent.lock().unwrap_or_else(|e| e.into_inner());
            *first = true;
            if tx.unbounded_send(snap).is_err() {
                return false; // nobody listens anymore
            }
        }
        true
    });
    if cancel.is_cancelled() {
        return;
    }
    let commits = parser.commits;
    let last = match res {
        Ok((Some(0), _)) | Ok((None, _)) => {
            let truncated = opts.limit.is_some_and(|l| commits.len() >= l);
            snapshot(&commits, true, truncated, None)
        }
        Ok((_, stderr)) => snapshot(&[], true, false, Some(stderr.trim().to_owned())),
        Err(e) => snapshot(&[], true, false, Some(e.to_string())),
    };
    *main_sent.lock().unwrap_or_else(|e| e.into_inner()) = true;
    let _ = tx.unbounded_send(last);
}

/// Merge-bases of `branch` with master / main and their remotes (Lua `git/log.lua` `MAIN_REFS`):
/// (commit, ref name).
fn main_bases_blocking(dir: &Path, branch: &str) -> Vec<(String, String)> {
    ["origin/master", "origin/main", "master", "main"]
        .into_iter()
        .filter_map(|r| {
            let out = cli::run_blocking(dir, ["merge-base", branch, r]).ok()?;
            out.ok()
                .then(|| (out.stdout.trim().to_owned(), r.to_owned()))
        })
        .filter(|(h, _)| !h.is_empty())
        .collect()
}

/// The commits with each base's ref added where it isn't listed already (layout only: the rows
/// keep their real refs). None: nothing to add.
fn with_bases(commits: &[Commit], bases: &[(String, String)]) -> Option<Vec<Commit>> {
    let mut out: Option<Vec<Commit>> = None;
    for (hash, name) in bases {
        let listed = commits
            .iter()
            .any(|c| c.refs.local.contains(name) || c.refs.remote.contains(name));
        if listed {
            continue;
        }
        let Some(i) = commits.iter().position(|c| &c.hash == hash) else {
            continue;
        };
        let v = out.get_or_insert_with(|| commits.to_vec());
        if name.contains('/') {
            v[i].refs.remote.push(name.clone());
        } else {
            v[i].refs.local.push(name.clone());
        }
    }
    out
}

/// The first screen in git's plain order (see `run_stream`), sent unless the real log already
/// sent something.
fn preview_first_screen(
    dir: &Path,
    mut args: Vec<String>,
    kind: LogKind,
    gopts: &GraphOptions,
    tx: &mpsc::UnboundedSender<LogSnapshot>,
    main_sent: &std::sync::Mutex<bool>,
) {
    args.insert(1, format!("-n{FIRST_BATCH}"));
    let mut parser = LogParser::new(kind);
    let cancel = Cancel::new();
    let ok = cli::run_lines(dir, &args, &cancel, |line| {
        parser.line(line);
        !*main_sent.lock().unwrap_or_else(|e| e.into_inner())
    });
    if !matches!(ok, Ok((Some(0), _))) || parser.commits.is_empty() {
        return;
    }
    let graph = graph::layout(
        &parser.commits,
        &GraphOptions {
            dangling: true,
            ..gopts.clone()
        },
    );
    let sent = main_sent.lock().unwrap_or_else(|e| e.into_inner());
    if !*sent {
        let _ = tx.unbounded_send(LogSnapshot {
            commits: Arc::new(parser.commits),
            graph: Arc::new(graph),
            kind,
            done: false,
            truncated: false,
            error: None,
        });
    }
}

/// The whole log at once (blocking; tests and small uses).
pub fn load_blocking(dir: &Path, filters: &LogFilters, opts: &LogOptions) -> LogSnapshot {
    let (tx, mut rx) = mpsc::unbounded();
    run_stream(dir, filters, opts, &Cancel::new(), &tx);
    drop(tx);
    let mut last = None;
    while let Ok(s) = rx.try_recv() {
        last = Some(s);
    }
    last.expect("a final snapshot")
}

/// The full message of a commit (`show -s --format=%B`), trimmed. Blocking.
pub fn message_blocking(dir: &Path, hash: &str) -> Option<String> {
    let out = cli::run_blocking(dir, ["show", "-s", "--format=%B", hash]).ok()?;
    out.ok().then(|| out.stdout.trim().to_owned())
}

/// Cmd+C in the log (Lua `git/log.lua` `copy_message`): the full messages of the commits (newest
/// first, a blank line between); a commit git can't show falls back to `subjects`.
pub fn messages_blocking(dir: &Path, commits: &[(&str, &str)]) -> String {
    commits
        .iter()
        .map(|(hash, subject)| message_blocking(dir, hash).unwrap_or_else(|| subject.to_string()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The configured user (`git config user.name / user.email`): the log bolds their name and the
/// User picker lists them first.
pub fn me_blocking(dir: &Path) -> Person {
    let out = cli::run_blocking(dir, ["config", "--get-regexp", r"^user\.(name|email)$"])
        .map(|o| o.stdout)
        .unwrap_or_default();
    parse_me(&out)
}

pub fn parse_me(out: &str) -> Person {
    let mut me = Person::default();
    for l in out.lines() {
        if let Some(v) = l.strip_prefix("user.name ") {
            me.name = v.to_owned();
        } else if let Some(v) = l.strip_prefix("user.email ") {
            me.email = v.to_owned();
        }
    }
    me
}

/// The User filter's names (was Lua `git/init.lua` `fetch_authors`): every author by commit
/// count (raw `%an`, not mailmap names), the configured user first. Blocking.
pub fn authors_blocking(dir: &Path) -> anyhow::Result<Vec<String>> {
    let out = cli::run_blocking(dir, ["shortlog", "-sn", "--all", "--group=format:%an"])?
        .into_result()?;
    Ok(parse_authors(&out, Some(&me_blocking(dir).name)))
}

/// `shortlog -sn` output -> names, `me` moved first.
pub fn parse_authors(out: &str, me: Option<&str>) -> Vec<String> {
    let mut list: Vec<String> = out
        .lines()
        .filter_map(|l| l.trim_start().split_once('\t').map(|(_, n)| n.to_owned()))
        .collect();
    if let Some(i) = me.and_then(|me| list.iter().position(|n| n == me)) {
        let me = list.remove(i);
        list.insert(0, me);
    }
    list
}

/// The Paths filter's choices (was Lua `git/init.lua` `filter_paths`): every tracked folder
/// (with a trailing `/`, sorted) then every tracked file (git's order). Blocking.
pub fn path_choices_blocking(dir: &Path) -> anyhow::Result<Vec<String>> {
    let out = cli::run_blocking(dir, ["ls-files", "-z"])?.into_result()?;
    Ok(parse_path_choices(
        out.split('\0').filter(|f| !f.is_empty()),
    ))
}

pub fn parse_path_choices<'a>(files: impl Iterator<Item = &'a str> + Clone) -> Vec<String> {
    let mut dirs = HashSet::new();
    for f in files.clone() {
        let mut d = f;
        while let Some((parent, _)) = d.rsplit_once('/') {
            if !dirs.insert(parent) {
                break;
            }
            d = parent;
        }
    }
    let mut items: Vec<String> = dirs.into_iter().map(|d| format!("{d}/")).collect();
    items.sort();
    items.extend(files.map(str::to_owned));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(fields: &[&str]) -> String {
        format!("{RS}{}", fields.join(&FS.to_string()))
    }

    #[test]
    fn parses_a_commit_line() {
        let l = line(&[
            "a3197a0dac3d686f5e9a32936267bfa2b4b7b72d",
            "p1 p2",
            "Max",
            "m@x.se",
            "1773136800",
            "2026-03-10T10:00:00+01:00",
            "Ada Example",
            "ada@x.se",
            "1773140400",
            "2026-03-10T11:00:00-05:30",
            "HEAD -> refs/heads/master, refs/remotes/origin/master, tag: refs/tags/v1.0",
            "fixed label typo",
        ]);
        let c = Commit::parse(&l).unwrap();
        assert_eq!(c.short(), "a3197a0d");
        assert_eq!(c.parents, ["p1", "p2"]);
        assert_eq!(c.author.name, "Max");
        assert_eq!(
            c.author_time,
            Time {
                unix: 1773136800,
                offset_min: 60
            }
        );
        assert_eq!(c.commit_time.offset_min, -330);
        assert_eq!(c.refs.head, HeadRef::Branch("master".into()));
        assert_eq!(c.refs.local, ["master"]);
        assert_eq!(c.refs.remote, ["origin/master"]);
        assert_eq!(c.refs.tags, ["v1.0"]);
        assert_eq!(c.subject, "fixed label typo");
        assert_eq!(c.author_text(), "Max*");
        assert!(Commit::parse("not a record").is_none());
    }

    #[test]
    fn subject_may_contain_separator_like_text() {
        let l = line(&[
            "abcdef0123456",
            "",
            "A",
            "a@x",
            "1",
            "1970-01-01T00:00:01Z",
            "A",
            "a@x",
            "1",
            "1970-01-01T00:00:01Z",
            "",
            "fix: a, b -> c",
        ]);
        let c = Commit::parse(&l).unwrap();
        assert!(c.parents.is_empty());
        assert!(c.refs.is_empty());
        assert_eq!(c.subject, "fix: a, b -> c");
        assert_eq!(c.author_text(), "A");
    }

    #[test]
    fn ref_labels_like_the_lua_log() {
        let r = Refs::parse(
            "HEAD -> refs/heads/master, refs/remotes/origin/master, refs/remotes/origin/HEAD, \
             tag: refs/tags/v1.0, tag: refs/tags/backup/old-1, refs/heads/zz, refs/stash",
        );
        assert!(r.is_head());
        let labels = r.labels();
        assert_eq!(labels.len(), 3, "{labels:?}");
        assert_eq!(labels[0].icons, [RefKind::Tag]);
        assert_eq!(labels[0].tags, 2);
        assert_eq!(labels[0].name, None);
        assert_eq!(labels[1].icons, [RefKind::Head, RefKind::Remote]);
        assert_eq!(labels[1].name.as_deref(), Some("origin & master"));
        assert_eq!(labels[2].name.as_deref(), Some("zz"));

        let r = Refs::parse("refs/remotes/origin/factory/1237, refs/heads/factory/1237");
        let labels = r.labels();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].icons, [RefKind::Local, RefKind::Remote]);
        assert_eq!(labels[0].name.as_deref(), Some("origin & factory/1237"));

        let r = Refs::parse("HEAD, refs/remotes/upstream/x");
        let labels = r.labels();
        assert_eq!(labels[0].name.as_deref(), Some("HEAD"));
        assert_eq!(labels[1].icons, [RefKind::Remote]);
        assert_eq!(labels[1].name.as_deref(), Some("upstream/x"));
    }

    struct Args {
        name: &'static str,
        filters: fn() -> LogFilters,
        is_hash: bool,
        limit: Option<usize>,
        kind: LogKind,
        /// The args after `log`'s fixed format ones.
        want: &'static [&'static str],
    }

    const ARGS: &[Args] = &[
        Args {
            name: "no filter: the HEAD graph",
            filters: LogFilters::default,
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &["--date-order", "HEAD"],
        },
        Args {
            name: "a text matches as is, any case",
            filters: || LogFilters {
                text: Some("AB#1".into()),
                authors: vec!["Ada Example".into()],
                date: Some(DateFilter::Last7Days),
                branch: BranchFilter::All,
                paths: vec!["src/".into(), "a.ts".into()],
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &[
                "--date-order",
                "--fixed-strings",
                "--regexp-ignore-case",
                "--grep=AB#1",
                "--author=Ada Example <",
                "--since-as-filter=7 days ago",
                "--parents",
                "--all",
                "--",
                "src/",
                "a.ts",
            ],
        },
        Args {
            name: "a regex text makes the author an anchored extended regex",
            filters: || LogFilters {
                text: Some("Re.amed".into()),
                regex: true,
                match_case: true,
                authors: vec!["A.B (x)".into()],
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &[
                "--date-order",
                "--extended-regexp",
                "--grep=Re.amed",
                r"--author=^A\.B \(x\) <",
                "HEAD",
            ],
        },
        Args {
            name: "no text: the author is an anchored basic regex",
            filters: || LogFilters {
                authors: vec!["A.B".into()],
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &["--date-order", r"--author=^A\.B <", "HEAD"],
        },
        Args {
            name: "regex on without a text keeps the basic regex, parens literal",
            filters: || LogFilters {
                regex: true,
                authors: vec!["A (B)".into()],
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &["--date-order", "--author=^A (B) <", "HEAD"],
        },
        Args {
            name: "file history follows renames",
            filters: || LogFilters::file_history("src/a.ts"),
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &[
                "--date-order",
                "--parents",
                "--follow",
                "HEAD",
                "--",
                "src/a.ts",
            ],
        },
        Args {
            name: "a hash text lists that commit alone",
            filters: || LogFilters {
                text: Some("adf9b0e".into()),
                ..Default::default()
            },
            is_hash: true,
            limit: Some(10),
            kind: LogKind::Hash,
            want: &["-n10", "--no-walk", "adf9b0e"],
        },
        Args {
            name: "a line range replaces the paths",
            filters: || LogFilters {
                lines: Some(LineRange {
                    path: "blame.ts".into(),
                    from: 2,
                    to: 3,
                }),
                paths: vec!["ignored".into()],
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Lines,
            want: &["HEAD", "-L2,3:blame.ts"],
        },
        Args {
            name: "a PR lists its commits and merge base in place of the branch",
            filters: || LogFilters {
                pr: Some(PrRange {
                    number: 56,
                    base: "ba5e".into(),
                    head: "c0ffee".into(),
                }),
                ..Default::default()
            },
            is_hash: false,
            limit: None,
            kind: LogKind::Graph,
            want: &["--date-order", "--boundary", "ba5e..c0ffee"],
        },
    ];

    #[test]
    fn filters_make_log_args() {
        for row in ARGS {
            let (args, kind) = log_args(&(row.filters)(), row.is_hash, row.limit);
            assert_eq!(kind, row.kind, "{}", row.name);
            assert_eq!(&args[5..], row.want, "{}", row.name);
        }
        let hash = |text: &str| LogFilters {
            text: Some(text.into()),
            ..Default::default()
        };
        assert!(hash("adf9b0e").text_may_be_hash());
        let lines = LogFilters {
            lines: Some(LineRange {
                path: "a".into(),
                from: 1,
                to: 1,
            }),
            ..hash("adf9b0e")
        };
        assert!(!lines.text_may_be_hash(), "a line range is never a hash");
    }

    #[test]
    fn date_filters() {
        assert_eq!(DateFilter::from_id("7d"), Some(DateFilter::Last7Days));
        assert_eq!(DateFilter::from_id("Last Year"), Some(DateFilter::LastYear));
        assert_eq!(DateFilter::from_id("All"), None);
        let r = DateFilter::Range {
            since: Some("2026-01-01".into()),
            until: Some("2026-02-01".into()),
        };
        assert_eq!(
            r.args(),
            ["--since-as-filter=2026-01-01", "--until=2026-02-01"]
        );
        assert_eq!(r.id(), None);
        assert_eq!(BranchFilter::from_lua("--all").tab_label(), "Log");
        assert_eq!(BranchFilter::Head.tab_label(), "Log: HEAD");
    }

    #[test]
    fn line_history_patches() {
        let c1 = line(&[
            "1111111111",
            "2222222222",
            "A",
            "a@x",
            "1",
            "x",
            "A",
            "a@x",
            "1",
            "x",
            "",
            "two",
        ]);
        let c2 = line(&[
            "2222222222",
            "",
            "A",
            "a@x",
            "1",
            "x",
            "A",
            "a@x",
            "1",
            "x",
            "",
            "one",
        ]);
        let out = format!(
            "{c1}\n\ndiff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -2,2 +3,2 @@\n-x\n+y\n--- a/z\n\
             {c2}\n\ndiff --git a/old.ts b/old.ts\n--- /dev/null\n+++ b/old.ts\n@@ -0,0 +1,3 @@\n+a\n"
        );
        let commits = LogParser::parse(LogKind::Lines, &out);
        assert_eq!(commits.len(), 2);
        let a = commits[0].change.clone().unwrap();
        assert_eq!(
            a,
            LinesChange {
                path: "new.ts".into(),
                old_path: Some("old.ts".into()),
                added: false,
                line: 3
            }
        );
        let b = commits[1].change.clone().unwrap();
        assert!(b.added);
        assert_eq!(b.path, "old.ts");
        assert_eq!(b.line, 1);
    }

    #[test]
    fn authors_and_paths() {
        let out = "     5\tAaron Sample\n     3\tAda Example\n     1\tMax\n";
        assert_eq!(
            parse_authors(out, Some("Ada Example")),
            ["Ada Example", "Aaron Sample", "Max"]
        );
        assert_eq!(parse_authors(out, None)[0], "Aaron Sample");
        let files = ["a.ts", "src/x/y.ts", "src/z.ts"];
        assert_eq!(
            parse_path_choices(files.into_iter()),
            ["src/", "src/x/", "a.ts", "src/x/y.ts", "src/z.ts"]
        );
        assert_eq!(
            parse_me("user.name Ada\nuser.email i@x\n"),
            Person {
                name: "Ada".into(),
                email: "i@x".into()
            }
        );
    }
}
