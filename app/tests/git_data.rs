//! `crate::git` data on real repos: copies of `tests/fixtures.sh`'s grepo / mrepo (each test its
//! own) and a generated 10k-commit repo. Expected data mirrors `tests/git_log_test.lua` /
//! `tests/git_changes_test.lua`. Perf numbers: `cargo test --release --test app git_data::perf --
//! --nocapture` (strict budgets only in release).

use crate::common;

use std::path::Path;
use std::time::Instant;

use common::gitfix::{self, git};
use futures::StreamExt;
use vimstorm::git::GraphOptions;
use vimstorm::git::{
    self, BranchFilter, DateFilter, HeadRef, LineRange, LogFilters, LogKind, LogOptions,
    LogSnapshot, RefKind,
};

fn load(repo: &Path, f: LogFilters) -> LogSnapshot {
    let s = git::load_log_blocking(repo, &f, &LogOptions::default());
    assert_eq!(s.error, None);
    assert!(s.done);
    s
}

fn subjects(s: &LogSnapshot) -> Vec<String> {
    s.commits.iter().map(|c| c.subject.clone()).collect()
}

// Log -------------------------------------------------------------------------------------------

#[test]
fn log_lists_head_history_with_refs_and_graph() {
    let fx = gitfix::fixture("grepo");
    let s = load(&fx.repo, LogFilters::default());
    assert_eq!(s.kind, LogKind::Graph);
    assert_eq!(
        subjects(&s),
        [
            "AB#1235 Renamed b",
            "AB#1236 Recent blame line",
            "Merge branch 'factory/1237'",
            "AB#1234 Added checkout page texts",
            "fixed label typo",
            "AB#101 Added service b",
            "AB#100 Initial setup",
        ]
    );
    let head = &s.commits[0];
    assert_eq!(head.refs.head, HeadRef::Branch("master".into()));
    assert_eq!(head.author.name, "Ada Example");
    assert_eq!(head.author_text(), "Ada Example");
    let fixed = s
        .commits
        .iter()
        .find(|c| c.subject == "fixed label typo")
        .unwrap();
    let labels = fixed.refs.labels();
    assert_eq!(labels[0].name.as_deref(), Some("origin & factory/1237"));
    assert_eq!(labels[0].icons, [RefKind::Local, RefKind::Remote]);
    let tagged = &s.commits[3];
    assert_eq!(tagged.refs.tags.len(), 2);
    assert_eq!(tagged.refs.labels()[0].tags, 2);
    // graph: one row per commit, the merge forks into two lanes
    assert_eq!(s.graph.rows.len(), 7);
    let merge = &s.graph.rows[2];
    assert_eq!(merge.edges.iter().filter(|e| !e.up).count(), 2, "{merge:?}");
    assert_eq!(s.graph.width, 2);
    assert_eq!(s.graph.rows[0].node, 0);
}

/// One row of the filter table: the filters for the fixture repo, the log kind and subjects they
/// list, and what else the snapshot shows.
struct Filtered {
    name: &'static str,
    filters: fn(&Path) -> LogFilters,
    kind: LogKind,
    subjects: &'static [&'static str],
    also: fn(&LogSnapshot),
}

fn text(t: &str, regex: bool, match_case: bool) -> LogFilters {
    LogFilters {
        text: Some(t.into()),
        regex,
        match_case,
        ..Default::default()
    }
}

const RENAMED: &[&str] = &["AB#1235 Renamed b"];
const NOTHING: &[&str] = &[];

const FILTERED: &[Filtered] = &[
    Filtered {
        name: "text ignores case by default",
        filters: |_| text("renamed B", false, false),
        kind: LogKind::Graph,
        subjects: RENAMED,
        also: |_| {},
    },
    Filtered {
        name: "Cc matches case",
        filters: |_| text("renamed B", false, true),
        kind: LogKind::Graph,
        subjects: NOTHING,
        also: |_| {},
    },
    Filtered {
        name: ".* takes a regex",
        filters: |_| text("Re.amed", true, false),
        kind: LogKind::Graph,
        subjects: RENAMED,
        also: |_| {},
    },
    Filtered {
        name: "plain text is no regex",
        filters: |_| text("Re.amed", false, false),
        kind: LogKind::Graph,
        subjects: NOTHING,
        also: |_| {},
    },
    Filtered {
        name: "text is a fixed string",
        filters: |_| text("AB#10", false, false),
        kind: LogKind::Graph,
        subjects: &["AB#101 Added service b", "AB#100 Initial setup"],
        also: |_| {},
    },
    Filtered {
        name: "a user: their commits, no stubs to hidden parents",
        filters: |_| LogFilters {
            authors: vec!["Max".into()],
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &["AB#1236 Recent blame line", "fixed label typo"],
        also: |s| {
            assert!(
                s.graph
                    .rows
                    .iter()
                    .all(|r| r.edges.iter().all(|e| !e.terminal))
            )
        },
    },
    Filtered {
        name: "several users and text together",
        filters: |_| LogFilters {
            authors: vec!["Max".into(), "Aaron Sample".into()],
            text: Some("ab#".into()),
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &[
            "AB#1236 Recent blame line",
            "AB#101 Added service b",
            "AB#100 Initial setup",
        ],
        also: |_| {},
    },
    Filtered {
        name: "the last 7 days",
        filters: |_| LogFilters {
            date: Some(DateFilter::Last7Days),
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &["AB#1236 Recent blame line"],
        also: |_| {},
    },
    Filtered {
        name: "a branch",
        filters: |_| LogFilters {
            branch: BranchFilter::Ref("factory/1237".into()),
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &[
            "fixed label typo",
            "AB#101 Added service b",
            "AB#100 Initial setup",
        ],
        also: |_| {},
    },
    Filtered {
        name: "all branches",
        filters: |_| LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &[
            "AB#1235 Renamed b",
            "AB#1236 Recent blame line",
            "Merge branch 'factory/1237'",
            "AB#1234 Added checkout page texts",
            "fixed label typo",
            "AB#101 Added service b",
            "AB#100 Initial setup",
        ],
        also: |_| {},
    },
    Filtered {
        name: "a path",
        filters: |_| LogFilters {
            paths: vec!["src/services/bee.ts".into()],
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: RENAMED,
        also: |_| {},
    },
    Filtered {
        name: "a file's history follows its rename",
        filters: |_| LogFilters::file_history("src/services/bee.ts"),
        kind: LogKind::Graph,
        subjects: &["AB#1235 Renamed b", "AB#101 Added service b"],
        also: |_| {},
    },
    Filtered {
        name: "a folder: parents rewritten, the graph connected",
        filters: |_| LogFilters {
            paths: vec!["backend/".into()],
            ..Default::default()
        },
        kind: LogKind::Graph,
        subjects: &["fixed label typo", "AB#100 Initial setup"],
        also: |s| assert_eq!(s.commits[0].parents, [s.commits[1].hash.clone()]),
    },
    Filtered {
        name: "a short hash",
        filters: |repo| {
            text(
                git(repo, &["rev-parse", "--short=9", "HEAD~2"]).trim(),
                false,
                false,
            )
        },
        kind: LogKind::Hash,
        subjects: &["Merge branch 'factory/1237'"],
        also: |_| {},
    },
    Filtered {
        name: "Show History for Selection: blame.ts lines 2-3",
        filters: |_| LogFilters {
            lines: Some(LineRange {
                path: "blame.ts".into(),
                from: 2,
                to: 3,
            }),
            ..Default::default()
        },
        kind: LogKind::Lines,
        subjects: &[
            "AB#1236 Recent blame line",
            "AB#1234 Added checkout page texts",
            "AB#100 Initial setup",
        ],
        also: |s| {
            let first = s.commits[0].change.clone().unwrap();
            assert_eq!((first.path.as_str(), first.line), ("blame.ts", 2));
            assert!(s.commits[2].change.as_ref().unwrap().added);
        },
    },
];

#[test]
fn log_filters_list_the_matching_commits() {
    let fx = gitfix::fixture("grepo");
    for row in FILTERED {
        let s = load(&fx.repo, (row.filters)(&fx.repo));
        assert_eq!(s.kind, row.kind, "{}", row.name);
        assert_eq!(subjects(&s), row.subjects, "{}", row.name);
        (row.also)(&s);
    }
    // a bad ref: git's error, no rows
    let bad = git::load_log_blocking(
        &fx.repo,
        &LogFilters {
            branch: BranchFilter::Ref("nope".into()),
            ..Default::default()
        },
        &LogOptions::default(),
    );
    assert!(bad.error.unwrap().contains("nope"));
    assert!(bad.commits.is_empty());
}

#[test]
fn authors_paths_and_me() {
    let fx = gitfix::fixture("grepo");
    let authors = git::authors_blocking(&fx.repo).unwrap();
    assert_eq!(authors[0], "Ada Example");
    assert_eq!(authors.len(), 3);
    let paths = git::path_choices_blocking(&fx.repo).unwrap();
    assert!(paths.contains(&"src/".to_string()));
    assert!(paths.contains(&"backend/scripts/".to_string()));
    assert!(paths.contains(&"blame.ts".to_string()));
    assert_eq!(git::me_blocking(&fx.repo).email, "ada@x.se");
    let refs = vimstorm::git::filter_refs_blocking(&fx.repo).unwrap();
    assert_eq!(refs.local, ["factory/1237", "master"]);
    assert_eq!(refs.remote, ["origin/factory/1237", "origin/master"]);
    assert_eq!(refs.tags.len(), 2);
    assert_eq!(refs.current.as_deref(), Some("master"));
    let msg = git::messages_blocking(&fx.repo, &[("HEAD", "x"), ("nope", "fallback")]);
    assert_eq!(msg, "AB#1235 Renamed b\n\nfallback");
}

// Streaming + perf ------------------------------------------------------------------------------

#[test]
fn log_streams_first_rows_then_the_rest() {
    let fx = gitfix::big_repo(10_000);
    let n = git(&fx.repo, &["rev-list", "--count", "--all"]);
    assert_eq!(n.trim(), "10000");
    let stream = git::stream(
        fx.repo.clone(),
        LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        },
        LogOptions::default(),
    );
    let snaps: Vec<LogSnapshot> = futures::executor::block_on(stream.collect());
    let first = &snaps[0];
    assert!(!first.done);
    assert!(first.commits.len() >= 200 && first.commits.len() < 10_000);
    assert_eq!(first.graph.rows.len(), first.commits.len());
    let last = snaps.last().unwrap();
    assert!(last.done);
    assert_eq!(last.commits.len(), 10_000);
    assert_eq!(last.graph.rows.len(), 10_000);
    // cumulative: each snapshot extends the one before
    for w in snaps.windows(2) {
        assert!(w[1].commits.len() >= w[0].commits.len());
        assert_eq!(w[1].commits[0].hash, w[0].commits[0].hash);
    }
    // the generated history has merges, features and an origin/master
    assert!(last.graph.width >= 2);
    assert!(last.commits.iter().any(|c| c.parents.len() == 2));
    assert!(
        last.commits
            .iter()
            .any(|c| c.refs.remote == ["origin/master"])
    );

    // a limit: truncated
    let s = git::load_log_blocking(
        &fx.repo,
        &LogFilters::default(),
        &LogOptions {
            limit: Some(500),
            ..Default::default()
        },
    );
    assert_eq!(s.commits.len(), 500);
    assert!(s.truncated);
}

#[test]
fn log_stream_cancel_stops_git() {
    let fx = gitfix::big_repo(3_000);
    let stream = git::stream(
        fx.repo.clone(),
        LogFilters::default(),
        LogOptions::default(),
    );
    stream.cancel();
    let got: Vec<LogSnapshot> = futures::executor::block_on(stream.collect());
    // nothing complete after a cancel (at most snapshots from before it)
    assert!(got.iter().all(|s| !s.done || s.commits.len() < 3_000));
}

/// Release budgets (the brief): 10k-commit log parse + graph layout, graph layout alone < 50 ms.
#[test]
fn perf_log_10k_parse_and_graph() {
    let fx = gitfix::big_repo(10_000);
    let (args, kind) = git::log_args(
        &LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        },
        false,
        None,
    );
    let out = vimstorm::git::run_blocking(&fx.repo, &args).unwrap();
    let t = Instant::now();
    let commits = git::LogParser::parse(kind, &out.stdout);
    let parse = t.elapsed();
    let t = Instant::now();
    let g = vimstorm::git::layout(&commits, &GraphOptions::default());
    let layout = t.elapsed();
    let t = Instant::now();
    let s = git::load_log_blocking(
        &fx.repo,
        &LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        },
        &LogOptions::default(),
    );
    let total = t.elapsed();
    assert_eq!(commits.len(), 10_000);
    assert_eq!(g.rows.len(), 10_000);
    assert_eq!(s.commits.len(), 10_000);
    eprintln!(
        "perf: 10k log parse {parse:?}, graph layout {layout:?}, git log + parse + snapshots {total:?} (graph width {})",
        g.width
    );
    if !cfg!(debug_assertions) {
        assert!(layout.as_millis() < 50, "layout {layout:?}");
        assert!(parse.as_millis() < 50, "parse {parse:?}");
    }
}

// Commit details ----------------------------------------------------------------------------------

use std::collections::HashSet;

#[test]
fn details_of_one_and_several_commits() {
    let fx = gitfix::fixture("grepo");
    let head = git(&fx.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    let d = git::details_blocking(&fx.repo, &head).unwrap();
    assert_eq!(d.subject(), "AB#1235 Renamed b");
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].change.letter(), 'R');
    assert_eq!(d.files[0].path, "src/services/bee.ts");
    assert_eq!(d.files[0].old_path.as_deref(), Some("src/services/b.ts"));
    assert!(!d.other_committer());
    // the merge: its changes vs the first parent
    let merge = git::details_blocking(&fx.repo, "HEAD~2").unwrap();
    let paths: Vec<&str> = merge.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        ["backend/scripts/en.json", "backend/scripts/sv.json"]
    );
    // branches containing it
    let b = git::containing_branches_blocking(&fx.repo, "HEAD~2").unwrap();
    assert_eq!(b, ["master"]);
    assert_eq!(git::branches_text(&b).unwrap(), "In 1 branch: master");
    let b = git::containing_branches_blocking(&fx.repo, "factory/1237").unwrap();
    assert_eq!(b, ["factory/1237", "master", "origin/factory/1237"]);
    // cache
    let cache = git::DetailsCache::default();
    let a = cache.load_blocking(&fx.repo, &head).unwrap();
    assert!(std::sync::Arc::ptr_eq(
        &a,
        &cache.load_blocking(&fx.repo, &head).unwrap()
    ));

    // 3 selected commits (newest first): the union, diffed from before the oldest
    let hashes: Vec<String> = ["HEAD", "HEAD~1", "HEAD~3"]
        .iter()
        .map(|r| git(&fx.repo, &["rev-parse", r]).trim().to_owned())
        .collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    let c = git::combined_blocking(&fx.repo, &refs).unwrap();
    assert_eq!(c.old_rev, format!("{}^", hashes[2]));
    assert_eq!(c.new_rev, hashes[0]);
    let mut files: Vec<(char, &str)> = c
        .files
        .iter()
        .map(|f| (f.change.letter(), f.path.as_str()))
        .collect();
    files.sort();
    assert_eq!(
        files,
        [
            ('M', "blame.ts"),
            ('M', "src/a.ts"),
            ('R', "src/services/bee.ts")
        ]
    );
    // the root commit alone: from the empty tree
    let root = git(&fx.repo, &["rev-list", "--max-parents=0", "HEAD"])
        .trim()
        .to_owned();
    let c = git::combined_blocking(&fx.repo, &[&root]).unwrap();
    assert_eq!(c.old_rev, git::EMPTY_TREE);
    assert!(c.files.iter().all(|f| f.change.letter() == 'A'));
    // file text at a revision
    assert_eq!(
        git::file_at_blocking(&fx.repo, "HEAD", "src/a.ts").as_deref(),
        Some("export const a = 3;\n")
    );
    assert_eq!(git::file_at_blocking(&fx.repo, "HEAD", "src/new.ts"), None);
    assert_eq!(git::short_hash_blocking(&fx.repo, "HEAD").unwrap().len(), 8);
}

// Local Changes / commit / rollback ---------------------------------------------------------------

#[test]
fn local_changes_sections() {
    let fx = gitfix::fixture("grepo");
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    assert_eq!(lc.branch.head.as_deref(), Some("master"));
    assert_eq!(lc.branch.upstream.as_deref(), Some("origin/master"));
    assert_eq!(lc.branch.ahead, 5);
    let s: Vec<(git::Section, Vec<&str>)> = lc
        .sections()
        .into_iter()
        .map(|(s, f)| (s, f.iter().map(|c| c.path.as_str()).collect()))
        .collect();
    assert_eq!(
        s,
        [
            (
                git::Section::Changes,
                vec!["diff.ts", "long.ts", "src/a.ts"]
            ),
            (git::Section::Unversioned, vec!["src/new.ts"]),
        ]
    );
    assert!(!lc.merging);

    let mx = gitfix::fixture("mrepo");
    let lc = git::read_changes_blocking(&mx.repo).unwrap();
    assert!(lc.merging);
    assert_eq!(lc.operation, Some(git::Operation::Merge));
    assert!(lc.has_conflicts());
    assert_eq!(lc.sections()[0].0, git::Section::Conflicts);
    assert_eq!(
        lc.prepared_message.as_deref(),
        Some("Merge branch 'feature'")
    );
    // conflicts block the commit
    let r = git::commit_blocking(&mx.repo, "x", &lc.files, &HashSet::new(), true, false);
    assert_eq!(r.outcome.message, "Resolve the merge conflicts first");
    // resolved: the merge commit takes everything, with git's message
    git(&mx.repo, &["checkout", "--theirs", "conflict.ts"]);
    git(&mx.repo, &["add", "conflict.ts"]);
    let lc = git::read_changes_blocking(&mx.repo).unwrap();
    let msg = lc.prepared_message.clone().unwrap();
    let r = git::commit_blocking(
        &mx.repo,
        &msg,
        &lc.files,
        &HashSet::new(),
        lc.merging,
        false,
    );
    assert!(r.outcome.ok, "{:?}", r.outcome);
    assert_eq!(r.outcome.message, "Committed merge");
    assert_eq!(
        git(&mx.repo, &["log", "-1", "--format=%p"])
            .split(' ')
            .count(),
        2
    );
    assert_eq!(git::read_repo_blocking(&mx.repo).unwrap().operation, None);
}

fn included(paths: &[&str]) -> HashSet<String> {
    paths.iter().map(|p| p.to_string()).collect()
}

#[test]
fn commit_marked_files_and_unversioned() {
    let fx = gitfix::fixture("grepo");
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    let r = git::commit_blocking(
        &fx.repo,
        "Two files",
        &lc.files,
        &included(&["src/a.ts", "src/new.ts"]),
        false,
        false,
    );
    assert!(r.outcome.ok, "{:?}", r.outcome);
    assert_eq!(r.outcome.message, "Committed 2 marked file(s)");
    assert_eq!(r.committed, ["src/a.ts", "src/new.ts"]);
    assert_eq!(
        r.hash.unwrap(),
        git(&fx.repo, &["rev-parse", "HEAD"]).trim()
    );
    let files = git(&fx.repo, &["show", "--format=", "--name-only", "HEAD"]);
    assert_eq!(files, "src/a.ts\nsrc/new.ts\n");
    // the others are untouched and unstaged
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    let left: Vec<&str> = lc.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(left, ["diff.ts", "long.ts"]);
    assert!(lc.files.iter().all(|f| !f.staged()));

    // amend: message only, then with all changes
    let r = git::commit_blocking(&fx.repo, "Reworded", &[], &HashSet::new(), false, true);
    assert!(r.outcome.ok, "{:?}", r.outcome);
    assert_eq!(
        git(&fx.repo, &["log", "-1", "--format=%s"]).trim(),
        "Reworded"
    );
    assert_eq!(git::last_message_blocking(&fx.repo).unwrap(), "Reworded");
    let r = git::commit_blocking(&fx.repo, "All", &lc.files, &HashSet::new(), false, true);
    assert_eq!(r.outcome.message, "Amended all 2 changed file(s)");
    assert!(
        git::read_changes_blocking(&fx.repo)
            .unwrap()
            .files
            .is_empty()
    );
}

#[test]
fn failed_commit_leaves_everything_as_it_was() {
    let fx = gitfix::fixture("grepo");
    let hook = fx.repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
    let ok = std::process::Command::new("chmod")
        .args(["+x"])
        .arg(&hook)
        .status()
        .unwrap();
    assert!(ok.success());
    let before = git(&fx.repo, &["rev-parse", "HEAD"]);
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    let r = git::commit_blocking(
        &fx.repo,
        "x",
        &lc.files,
        &included(&["src/new.ts", "diff.ts"]),
        false,
        false,
    );
    assert!(!r.outcome.ok);
    assert_eq!(r.outcome.title, "git commit");
    assert!(
        r.outcome.message.contains("hook says no"),
        "{:?}",
        r.outcome
    );
    assert!(r.committed.is_empty());
    assert_eq!(git(&fx.repo, &["rev-parse", "HEAD"]), before);
    // nothing staged, the unversioned file unversioned again
    let lc2 = git::read_changes_blocking(&fx.repo).unwrap();
    assert_eq!(lc2.files, lc.files);
}

#[test]
fn rollback_and_add() {
    let fx = gitfix::fixture("grepo");
    // an added file + a staged rename + a modified file
    std::fs::write(fx.repo.join("added.ts"), "new\n").unwrap();
    git(&fx.repo, &["add", "added.ts"]);
    git(&fx.repo, &["mv", "diff.ts", "renamed.ts"]);
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    let pick = |p: &str| lc.file(p).unwrap();
    assert_eq!(pick("added.ts").kind, git::ChangeKind::Added);
    assert_eq!(pick("renamed.ts").kind, git::ChangeKind::Renamed);
    let targets = [
        pick("added.ts"),
        pick("renamed.ts"),
        pick("src/a.ts"),
        pick("src/new.ts"),
    ];
    assert_eq!(
        git::rollback_prompt(&targets),
        "Rollback 3 file(s)? added.ts, renamed.ts, src/a.ts"
    );
    let o = git::rollback_blocking(&fx.repo, &targets, git::RollbackOptions::default());
    assert!(o.ok, "{o:?}");
    assert_eq!(o.message, "Rolled back 3 file(s)");
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    let st: Vec<(char, &str)> = lc
        .files
        .iter()
        .map(|f| (f.kind.letter(), f.path.as_str()))
        .collect();
    // added -> unversioned (content kept); rename undone; a.ts restored; new.ts left alone
    assert_eq!(
        st,
        [('M', "long.ts"), ('?', "added.ts"), ('?', "src/new.ts")]
    );
    assert_eq!(
        std::fs::read_to_string(fx.repo.join("added.ts")).unwrap(),
        "new\n"
    );
    assert!(fx.repo.join("diff.ts").exists());
    let o = git::rollback_blocking(
        &fx.repo,
        &[lc.file("src/new.ts").unwrap()],
        Default::default(),
    );
    assert_eq!(o.message, "Nothing to roll back");
    let o = git::add_blocking(&fx.repo, &["src/new.ts"]);
    assert_eq!(o.message, "Added 1 file(s)");
    let lc = git::read_changes_blocking(&fx.repo).unwrap();
    assert_eq!(lc.file("src/new.ts").unwrap().kind, git::ChangeKind::Added);
}

// Ops ----------------------------------------------------------------------------------------------

#[test]
fn push_pull_fetch_with_the_fixture_remote() {
    let fx = gitfix::fixture("grepo");
    let info = git::push_info_blocking(&fx.repo).unwrap();
    assert_eq!(info.branch.as_deref(), Some("master"));
    assert_eq!(info.upstream.as_deref(), Some("origin/master"));
    assert_eq!(info.remote.as_deref(), Some("origin"));
    assert_eq!(info.outgoing.len(), 5);
    let cancel = vimstorm::git::Cancel::new();
    let mut lines = Vec::new();
    let o = git::push_blocking(&fx.repo, &cancel, |l| lines.push(l.to_owned()));
    assert!(o.ok, "{o:?}");
    assert_eq!(o.message, "Pushed");
    assert!(
        git::push_info_blocking(&fx.repo)
            .unwrap()
            .outgoing
            .is_empty()
    );
    // a new branch: the first push sets the upstream (git itself with push.autoSetupRemote)
    git(&fx.repo, &["switch", "-q", "-c", "topic"]);
    let info = git::push_info_blocking(&fx.repo).unwrap();
    assert_eq!(info.upstream, None);
    assert!(info.outgoing.is_empty(), "same commits as origin/master");
    let o = git::push_blocking(&fx.repo, &cancel, |_| {});
    assert!(o.ok && o.message.starts_with("Pushed"), "{o:?}");
    assert_eq!(
        git::read_repo_blocking(&fx.repo)
            .unwrap()
            .upstream
            .unwrap()
            .name,
        "origin/topic"
    );
    let o = git::fetch_blocking(&fx.repo, &cancel, |_| {});
    assert_eq!(o.message, "Fetched", "{o:?}");
    let o = git::pull_blocking(&fx.repo, &cancel, |_| {});
    assert_eq!(o.message, "All files are up-to-date", "{o:?}");
    // incoming commits (pushed from another clone), local changes stashed around the pull
    let other = fx.tmp.path().join("other");
    git(
        fx.tmp.path(),
        &["clone", "-q", "-b", "topic", "gremote.git", "other"],
    );
    git(
        &other,
        &[
            "-c",
            "user.name=O",
            "-c",
            "user.email=o@x",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "From other",
        ],
    );
    git(&other, &["push", "-q"]);
    let o = git::pull_blocking(&fx.repo, &cancel, |_| {});
    assert_eq!(o.message, "Pulled", "{o:?}");
    assert_eq!(
        git(&fx.repo, &["log", "-1", "--format=%s"]).trim(),
        "From other"
    );
    assert_eq!(git::read_changes_blocking(&fx.repo).unwrap().files.len(), 4);
    // a bad remote: git's error text
    git(
        &fx.repo,
        &["remote", "set-url", "origin", "/nonexistent/repo.git"],
    );
    let o = git::fetch_blocking(&fx.repo, &cancel, |_| {});
    assert!(!o.ok);
    assert_eq!(o.title, "git fetch");
    assert!(o.message.contains("nonexistent"), "{o:?}");
}

#[test]
fn commit_actions() {
    let fx = gitfix::fixture("grepo");
    let r = &fx.repo;
    git(r, &["stash", "-q", "-u"]);
    let head = git(r, &["rev-parse", "HEAD"]).trim().to_owned();
    assert!(git::is_unpushed_blocking(r, &head));
    assert!(!git::is_unpushed_blocking(r, "HEAD~5"));
    // new branch / tag at a commit
    let o = git::new_branch_blocking(r, "at-old", "HEAD~1", false);
    assert_eq!(o.message, "Created branch at-old");
    let o = git::new_tag_blocking(r, "t1", "HEAD~1", None);
    assert_eq!(o.message, "Created tag t1");
    let o = git::new_tag_blocking(r, "t1", "HEAD", None);
    assert!(!o.ok && o.message.contains("already exists"), "{o:?}");
    // reword HEAD and an older commit, drop, uncommit
    let o = git::reword_subject_blocking(r, &head, "Renamed b better");
    assert!(o.ok, "{o:?}");
    assert_eq!(
        git(r, &["log", "-1", "--format=%s"]).trim(),
        "Renamed b better"
    );
    let older = git(r, &["rev-parse", "HEAD~1"]).trim().to_owned();
    let o = git::reword_blocking(r, &older, "Recent blame line, reworded\n\nWith a body.");
    assert!(o.ok, "{o:?}");
    assert_eq!(
        git(r, &["log", "-1", "--format=%B", "HEAD~1"]).trim(),
        "Recent blame line, reworded\n\nWith a body."
    );
    assert_eq!(
        git(r, &["log", "-1", "--format=%s"]).trim(),
        "Renamed b better"
    );
    // can't rewrite past the merge
    let o = git::drop_blocking(r, git(r, &["rev-parse", "HEAD~3"]).trim());
    assert_eq!(o.message, "Can't rewrite: there are merge commits after it");
    let o = git::drop_blocking(r, git(r, &["rev-parse", "HEAD~1"]).trim());
    assert!(o.ok, "{o:?}");
    assert_eq!(
        git(r, &["log", "-1", "--format=%s", "HEAD~1"]).trim(),
        "Merge branch 'factory/1237'"
    );
    let top = git(r, &["rev-parse", "HEAD"]).trim().to_owned();
    assert_eq!(git::uncommit_count_blocking(r, &top), 1);
    let o = git::uncommit_blocking(r, &top);
    assert_eq!(o.message, "Uncommitted 1 commit(s)");
    assert!(
        git(r, &["status", "--porcelain"]).contains("R  src/services/b.ts -> src/services/bee.ts")
    );
    git(r, &["reset", "-q", "--hard"]);
    // cherry-pick / revert / reset
    let side = git(r, &["rev-parse", "factory/1237"]).trim().to_owned();
    git(r, &["switch", "-q", "-c", "pick", "HEAD~3"]);
    let o = git::cherry_pick_blocking(r, &side);
    assert!(o.ok, "{o:?}");
    assert_eq!(o.message, format!("Cherry-picked {}", &side[..8]));
    let picked = git(r, &["rev-parse", "HEAD"]).trim().to_owned();
    let o = git::revert_blocking(r, &picked);
    assert!(o.ok, "{o:?}");
    assert!(git(r, &["log", "-1", "--format=%s"]).starts_with("Revert"));
    let o = git::reset_blocking(r, "HEAD~2", git::ResetMode::Hard);
    assert!(o.message.starts_with("Reset (hard) to "), "{o:?}");
    let o = git::checkout_tag_blocking(r, "v1.0");
    assert_eq!(o.message, "Checked out tag v1.0");
    assert!(matches!(
        git::read_repo_blocking(r).unwrap().head,
        git::HeadState::Detached(_)
    ));
    let o = git::checkout_revision_blocking(r, &side);
    assert_eq!(o.message, format!("Checked out {}", &side[..8]));
    let o = git::cherry_pick_blocking(r, "nope");
    assert_eq!(o.title, "git cherry-pick");
}

// Blame / hunks / repo -----------------------------------------------------------------------------

#[test]
fn blame_file_and_unsaved_text() {
    let fx = gitfix::fixture("grepo");
    let cancel = vimstorm::git::Cancel::new();
    let b = git::blame_blocking(&fx.repo, "blame.ts", None, &cancel).unwrap();
    assert_eq!(b.lines.len(), 4);
    let summary = |n: usize| b.line(n).unwrap().1.summary.clone();
    assert_eq!(summary(1), "AB#100 Initial setup");
    assert_eq!(summary(2), "AB#1234 Added checkout page texts");
    assert_eq!(summary(3), "AB#1236 Recent blame line");
    assert_eq!(b.line(3).unwrap().1.author.name, "Max");
    // order colors: the newest revision brightest
    let colors = b.order_colors();
    let c3 = b.line(3).unwrap().0.commit;
    assert_eq!(colors[c3], Some(git::ANNOTATION_COLORS[0]));
    assert_eq!(b.last_commit(), Some(c3));
    // unsaved text: an inserted line is uncommitted
    let text = "line one\nline TWO\nnew unsaved\nline 3 recent\nline four\n";
    let b = git::blame_blocking(&fx.repo, "blame.ts", Some(text), &cancel).unwrap();
    assert_eq!(b.lines.len(), 5);
    assert!(b.line(3).unwrap().1.uncommitted);
    assert_eq!(b.line(4).unwrap().0.orig_line, 3);
    let now = vimstorm::git::now();
    let zone = vimstorm::git::Zone::system();
    assert_eq!(git::annotation_text(b.line(3).unwrap().1, now, zone), "");
    assert!(git::annotation_text(b.line(1).unwrap().1, now, zone).ends_with(" Sample"));
    // a file git doesn't know
    assert!(git::blame_blocking(&fx.repo, "src/new.ts", None, &cancel).is_err());
    cancel.cancel();
    assert!(git::blame_blocking(&fx.repo, "blame.ts", None, &cancel).is_err());
}

#[test]
fn change_hunks_vs_head() {
    let fx = gitfix::fixture("grepo");
    // diff.ts: changed 2, deleted 4, added 7 (fixtures.sh)
    let h = git::hunks_blocking(&fx.repo, "diff.ts", git::Base::Head, None).unwrap();
    let kinds: Vec<(git::HunkKind, u32, u32)> = h
        .iter()
        .map(|h| (h.kind(), h.new_start, h.new_count))
        .collect();
    assert_eq!(
        kinds,
        [
            (git::HunkKind::Modified, 2, 1),
            (git::HunkKind::Deleted, 3, 0),
            (git::HunkKind::Added, 6, 1)
        ]
    );
    let h = git::hunks_blocking(&fx.repo, "long.ts", git::Base::Head, None).unwrap();
    assert_eq!(
        (h[0].kind(), h[0].new_start, h[0].new_count),
        (git::HunkKind::Added, 50, 10)
    );
    // unsaved text against HEAD; an unversioned file: all added
    let h = git::hunks_blocking(&fx.repo, "blame.ts", git::Base::Head, Some("line one\n")).unwrap();
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].kind(), git::HunkKind::Deleted);
    let h = git::hunks_blocking(&fx.repo, "src/new.ts", git::Base::Head, None).unwrap();
    assert_eq!((h[0].kind(), h[0].new_count), (git::HunkKind::Added, 1));
    let h = git::hunks_blocking(&fx.repo, "blame.ts", git::Base::Index, None).unwrap();
    assert!(h.is_empty());
}

#[test]
fn repo_state() {
    let fx = gitfix::fixture("grepo");
    let s = git::read_repo_blocking(&fx.repo.join("src")).unwrap();
    assert_eq!(s.root, fx.repo);
    assert_eq!(s.head, git::HeadState::Branch("master".into()));
    let u = s.upstream.unwrap();
    assert_eq!(
        (u.name.as_str(), u.ahead, u.behind),
        ("origin/master", 5, 0)
    );
    assert_eq!(s.remotes, ["origin"]);
    assert_eq!(s.operation, None);
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(git::read_repo_blocking(outside.path()), None);
    let fresh = tempfile::tempdir().unwrap();
    git(fresh.path(), &["init", "-q", "-b", "main"]);
    let s = git::read_repo_blocking(fresh.path()).unwrap();
    assert_eq!(s.head, git::HeadState::Unborn("main".into()));
    assert_eq!(s.upstream, None);
}

/// `git status` on a large tree (release budget: the brief's "status on a large tree").
#[test]
fn perf_status_large_tree() {
    let fx = gitfix::big_repo(2_000);
    // 20k files in 200 folders, 500 changed, 300 unversioned
    let r = &fx.repo;
    for d in 0..200 {
        let dir = r.join(format!("tree/d{d}"));
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..100 {
            std::fs::write(dir.join(format!("f{f}.ts")), format!("{d} {f}\n")).unwrap();
        }
    }
    git(r, &["add", "-A"]);
    git(r, &["commit", "-q", "-m", "tree"]);
    for d in 0..50 {
        for f in 0..10 {
            std::fs::write(r.join(format!("tree/d{d}/f{f}.ts")), "changed\n").unwrap();
        }
        for f in 0..6 {
            std::fs::write(r.join(format!("tree/d{d}/new{f}.ts")), "new\n").unwrap();
        }
    }
    let t = Instant::now();
    let lc = git::read_changes_blocking(r).unwrap();
    let el = t.elapsed();
    assert_eq!(lc.files.len(), 800);
    eprintln!("perf: status of 20k files (800 changed) {el:?}");
}
