//! PR review in the Git Log in the real window, on a fixture PR repo (a temp main checkout with
//! an `origin` holding the PR's branch, its worktree; git real) and Abe 3.x's bridge faked: the
//! `review` slot's screen (`abe/packages/ui/src/review/review.ts`, its own scenarios in bun) is the fake
//! bridge's frames, written here with the fixture's paths and shas. The app's part: a review opens
//! the PR's worktree as a project and its Git tool window on the Log filtered by `PR: #7`, tells
//! the screen which PR (`open review {pr, path, list}`), draws the `ReviewPane` it answers (the
//! strip over the Log, the files beside it), sends it the files pane's keys, clicks and menu, the
//! Log's selection, the diff's `,i` keys and the Submit review dialog as `review` asks, and does
//! its effects: `show-diff` (VimStorm's diff viewer, merge base left, PR head right, at the line),
//! `review-said` (a balloon in the diff), the drafts' gutter marks, `pr-pick` (the chip's menu)
//! and `review-open` (the picked PR's worktree opened and reviewed).
#![cfg(debug_assertions)]

use crate::common;
use crate::common::bridge::{fake_on, fixture, log};

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::gitfix;
use common::view::View;
use gpui_kit::Entity;
use serde_json::{Value, json};
use vimstorm::factory::{PaneLine, Scope, Verdict};
use vimstorm::git::window::TabId;
use vimstorm::shell::Workspace;

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "user.name=T", "-c", "user.email=t@x"];
    all.extend_from_slice(args);
    gitfix::git(dir, &all).trim().to_owned()
}

/// The fixture: a main checkout `app` on master with an `origin`; the PR's branch there (`src/a.ts`
/// changed from line 3, `src/b.ts` line 2, the lockfile), checked out in the worktree `app-pr-7`.
pub(crate) struct Repo {
    pub(crate) _tmp: tempfile::TempDir,
    /// The fake bridge's folder: its log and the frames it prints.
    pub(crate) dir: PathBuf,
    pub(crate) main: PathBuf,
    pub(crate) tree: PathBuf,
    pub(crate) head: String,
    pub(crate) base: String,
}

pub(crate) fn pr_repo() -> Repo {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    git(
        &root,
        &["init", "-q", "--bare", "-b", "master", "origin.git"],
    );
    let main = root.join("app");
    std::fs::create_dir_all(main.join("src")).unwrap();
    git(&main, &["init", "-q", "-b", "master"]);
    let a = |big: bool| {
        (1..=12)
            .map(|i| format!("const a{i} = {};\n", if big && i >= 3 { i * 10 } else { i }))
            .collect::<String>()
    };
    std::fs::write(main.join("src/a.ts"), a(false)).unwrap();
    std::fs::write(
        main.join("src/b.ts"),
        "export const b = 1;\nexport const c = 2;\nexport const d = 3;\n",
    )
    .unwrap();
    std::fs::write(main.join("package-lock.json"), "{\"v\": 1}\n").unwrap();
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-q", "-m", "base"]);
    let base = git(&main, &["rev-parse", "HEAD"]);
    let origin = root.join("origin.git");
    git(
        &main,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&main, &["push", "-q", "-u", "origin", "master"]);
    git(&main, &["checkout", "-q", "-b", "feature/AB-1-login"]);
    std::fs::write(main.join("src/a.ts"), a(true)).unwrap();
    std::fs::write(
        main.join("src/b.ts"),
        "export const b = 1;\nexport const c = 20;\nexport const d = 3;\n",
    )
    .unwrap();
    std::fs::write(main.join("package-lock.json"), "{\"v\": 1}\n").unwrap();
    git(&main, &["commit", "-q", "-am", "AB#1 the change"]);
    let head = git(&main, &["rev-parse", "HEAD"]);
    git(&main, &["push", "-q", "-u", "origin", "feature/AB-1-login"]);
    git(&main, &["checkout", "-q", "master"]);
    let tree = root.join("app-pr-7");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            tree.to_str().unwrap(),
            "feature/AB-1-login",
        ],
    );
    let dir = root.join("bridge");
    std::fs::create_dir_all(&dir).unwrap();
    Repo {
        _tmp: tmp,
        dir,
        main,
        tree,
        head,
        base,
    }
}

/// A frame file for the fake bridge to print.
pub(crate) fn frame(dir: &Path, name: &str, value: Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, value.to_string()).unwrap();
    path
}

pub(crate) fn file(path: &str, depth: usize, heat: &str, adds: u32, reviewed: bool) -> Value {
    let label = if depth == 0 {
        path
    } else {
        path.rsplit('/').next().unwrap()
    };
    json!({
        "kind": "file", "path": path, "label": label, "depth": depth, "status": "M",
        "heat": heat, "flat": depth == 0 && path.contains('/'), "reviewed": reviewed,
        "additions": adds, "deletions": adds, "changes": 1, "hunk": null, "threads": 0,
        "drafts": 0, "outdated": false,
    })
}

/// What the screen's pane is in each test: the order, the scope, b.ts reviewed, the cursor, the
/// drafts waiting.
#[derive(Clone, Default)]
pub(crate) struct Pane {
    pub(crate) folder: bool,
    pub(crate) commit: bool,
    pub(crate) marked: bool,
    pub(crate) at: usize,
    pub(crate) drafted: Vec<Value>,
}

/// The `review` slot's tree frame for PR 7 in the fixture's worktree (the contract's sample
/// `ReviewPane` with the fixture's files, shas and `pane`).
pub(crate) fn tree_frame(r: &Repo, p: &Pane) -> Value {
    let sample: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("trees/review-pane.json")).unwrap())
            .unwrap();
    let mut tree = sample;
    let props = &mut tree["props"];
    props["root"] = json!(r.tree.to_string_lossy());
    props["number"] = json!(7);
    props["heat"] = json!(!p.folder);
    props["at"] = json!(p.at);
    props["lines"] = if p.folder {
        json!([
            {"kind": "node", "key": "d:src", "node": "dir", "label": "src/", "depth": 0,
             "open": true, "count": "2 files", "reviewed": false},
            file("src/a.ts", 1, "2", 10, false),
            file("src/b.ts", 1, "5", 1, p.marked),
            file("package-lock.json", 0, "1", 1, false),
        ])
    } else {
        json!([
            file("src/b.ts", 0, "5", 1, p.marked),
            file("src/a.ts", 0, "2", 10, false),
            {"kind": "gap"},
            {"kind": "node", "key": "g:lock", "node": "group", "label": "Lockfiles", "depth": 0,
             "open": false, "count": "1 file", "reviewed": false},
        ])
    };
    props["drafted"] = json!(p.drafted);
    props["threads"] = json!([]);
    props["saved"] = Value::Null;
    props["conversation"] = json!([{
        "kind": "changes", "author": "cy", "body": "## Nit\n\n- rename `x`", "when": "5 min ago"
    }]);
    let strip = &mut props["strip"];
    strip["title"] = json!("AB#1 Fix the login");
    strip["url"] = json!("https://github.com/o/r/pull/7");
    strip["branch"] = json!("feature/AB-1-login");
    strip["base"] = json!("master");
    strip["drafts"] = json!(p.drafted.len());
    strip["threads"] = json!({"label": "No threads", "open": false});
    strip["commits"] = json!([{
        "sha": r.head, "subject": "AB#1 the change", "author": "T",
        "date": "2026-10-20T09:00:00Z",
        "files": [{"path": "src/a.ts", "additions": 10, "deletions": 10}]
    }]);
    strip["scope"] = if p.commit {
        json!({"kind": "commit", "place": 1, "sha": r.head})
    } else {
        json!({"kind": "all"})
    };
    strip["baseSha"] = json!(r.base);
    strip["headSha"] = json!(r.head);
    strip["files"] = json!(3);
    strip["reviewed"] = json!(usize::from(p.marked));
    json!({"v": 2, "type": "tree", "screen": "review", "rev": 0, "tree": tree, "slot": "review"})
}

/// A `show-diff` of the PR's two files at file `index` (1-based) and `line`.
pub(crate) fn show_diff(r: &Repo, index: usize, line: u32) -> Value {
    json!({"v": 2, "type": "shell", "effect": {
        "kind": "show-diff", "root": r.tree.to_string_lossy(),
        "files": [{"path": "src/b.ts", "status": "M"}, {"path": "src/a.ts", "status": "M"}],
        "index": index, "base": r.base, "head": r.head, "line": line,
        "pr": {"number": 7, "head": r.head}
    }})
}

pub(crate) fn said(r: &Repo, text: &str) -> Value {
    json!({"v": 2, "type": "shell", "effect": {
        "kind": "review-said", "root": r.tree.to_string_lossy(), "text": text, "tone": "ok"
    }})
}

/// The window on a plain project, the fake bridge answering `rules` (a text the app's frame
/// holds, the frames printed), started.
pub(crate) fn start(r: &Repo, rules: Vec<(String, Vec<Value>)>) -> View {
    let mut v = View::start_projects("proj", &["a.ts"]);
    let mut on: Vec<(String, Vec<PathBuf>)> = Vec::new();
    for (n, (when, frames)) in rules.into_iter().enumerate() {
        let files = frames
            .into_iter()
            .enumerate()
            .map(|(i, f)| frame(&r.dir, &format!("rule-{n}-{i}.json"), f))
            .collect();
        on.push((when, files));
    }
    let on: Vec<(&str, Vec<PathBuf>)> = on.iter().map(|(w, f)| (w.as_str(), f.clone())).collect();
    let command = fake_on(&r.dir, &["frames/bridge-tree.json"], &on);
    let projects = v.projects.clone().unwrap();
    v.cx.update(|window, cx| {
        vimstorm::app::init_menu(cx);
        cx.set_global(command);
        projects.update(cx, |p, cx| p.follow_factory(window, cx));
    });
    v.wait_until("the bridge started", |_| {
        log(&r.dir).iter().any(|l| l.starts_with("start "))
    });
    v
}

/// The rules every review test shares: the open answered with the pane by heat, the pane's ⏎ with
/// b.ts's change.
pub(crate) fn opened(r: &Repo) -> Vec<(String, Vec<Value>)> {
    vec![
        (r#""pr":"7""#.into(), vec![tree_frame(r, &Pane::default())]),
        (r#""key":"<CR>""#.into(), vec![show_diff(r, 1, 2)]),
    ]
}

/// The `review` asks the app sent, as JSON.
pub(crate) fn asks(r: &Repo) -> Vec<Value> {
    log(&r.dir)
        .into_iter()
        .filter(|l| l.contains(r#""kind":"review""#))
        .filter_map(|l| {
            let v: Value = serde_json::from_str(&l).ok()?;
            Some(v["input"]["ask"].clone())
        })
        .collect()
}

pub(crate) fn asked(r: &Repo, ask: Value) -> bool {
    asks(r).contains(&ask)
}

/// The production review entry: PR 7 opened in the fixture's worktree.
pub(crate) fn open_review(v: &mut View, r: &Repo) {
    let open = vimstorm::git::window::ReviewOpen {
        repo: "o/r".into(),
        number: 7,
        path: r.tree.clone(),
        unchecked: None,
    };
    let tree = r.tree.clone();
    v.cx.update(|_, cx| vimstorm::shell::projects::open_review(tree, open, cx));
}

pub(crate) fn active_dir(v: &mut View) -> PathBuf {
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, _| ws.project().clone())
}

/// The PR files pane's lines as `heat name` (nodes as `▸ label` / `▾ label`).
pub(crate) fn pane_lines(v: &mut View, ws: &Entity<Workspace>) -> Option<Vec<String>> {
    v.pump();
    let model = ws.read_with(&v.cx, |ws, cx| {
        ws.git().read(cx).review().read(cx).model(cx)
    })?;
    Some(
        model
            .lines
            .iter()
            .filter_map(|l| match l {
                PaneLine::File {
                    label,
                    heat,
                    reviewed,
                    ..
                } => Some(format!(
                    "{heat} {label}{}",
                    if *reviewed { " ✓" } else { "" }
                )),
                PaneLine::Node { label, open, .. } => {
                    Some(format!("{} {label}", if *open { "▾" } else { "▸" }))
                }
                _ => None,
            })
            .collect(),
    )
}

/// The worktree's project shown on the Log filtered by PR 7, its files drawn, the files with
/// the keyboard. The workspace shown.
pub(crate) fn to_the_pane(v: &mut View, r: &Repo) -> Entity<Workspace> {
    open_review(v, r);
    v.wait_until("the worktree's project shown", |v| active_dir(v) == r.tree);
    let ws = v.active_project();
    v.wait_until("the PR's files by heat", |v| {
        ws.read_with(&v.cx, |ws, cx| {
            let g = ws.git().read(cx);
            g.active() == TabId::Log && g.log().read(cx).filters.pr.is_some()
        }) && pane_lines(v, &ws).is_some_and(|l| l.iter().any(|x| x.starts_with("5 ")))
    });
    let files = ws.read_with(&v.cx, |ws, cx| {
        gpui_kit::Focusable::focus_handle(ws.git().read(cx).review().read(cx), cx)
    });
    v.cx.update(|window, cx| window.focus(&files, cx));
    ws
}

pub(crate) fn viewer(v: &mut View, ws: &Entity<Workspace>) -> Option<vimstorm::git::diff::Viewer> {
    v.pump();
    ws.read_with(&v.cx, |ws, cx| ws.diff().read(cx).viewer().cloned())
}

pub(crate) fn file_of(d: &vimstorm::git::diff::Viewer) -> Option<String> {
    d.panes.first().and_then(|p| p.title.path.clone())
}

/// The diff viewer on `path`, waited for (its chrome shows with nvim's next flush, or after its
/// grace timer: the test clock).
pub(crate) fn wait_diff_of(v: &mut View, ws: &Entity<Workspace>, path: &str) {
    v.wait_until(&format!("the diff of {path}"), |v| {
        v.advance(Duration::from_millis(60));
        viewer(v, ws).is_some_and(|d| d.panes.len() == 2 && file_of(&d).as_deref() == Some(path))
    });
}

pub(crate) fn focus_target(v: &mut View) -> Option<String> {
    v.active_project()
        .read_with(&v.cx, |ws, _| ws.rpc().clone())
        .request_blocking(
            "nvim_exec_lua",
            vec![
                "return require('config.focus').target()".into(),
                rmpv::Value::Array(vec![]),
            ],
            Duration::from_secs(5),
        )
        .ok()
        .and_then(|t| t.as_str().map(str::to_owned))
}

/// Esc until the diff has the keyboard (the viewer's panes are the editor).
pub(crate) fn keyboard_to_the_diff(v: &mut View, ws: &Entity<Workspace>) {
    v.wait_until("the diff has the keyboard", |v| {
        focus_target(v) == Some("diff".into()) || {
            v.key("escape");
            false
        }
    });
    v.wait_until("the keyboard in the editor", |v| {
        v.cx.update(|window, cx| {
            use gpui_kit::Focusable as _;
            window.focused(cx).as_ref() == Some(&ws.read(cx).editor().focus_handle(cx))
        })
    });
}

/// The pane's ⏎: b.ts's change in the diff at line 2; Esc: the keyboard in the diff.
pub(crate) fn into_the_diff(v: &mut View, r: &Repo) -> Entity<Workspace> {
    let ws = to_the_pane(v, r);
    v.key("enter");
    wait_diff_of(v, &ws, "src/b.ts");
    keyboard_to_the_diff(v, &ws);
    ws
}

pub(crate) fn writing_card(v: &mut View, ws: &Entity<Workspace>) -> Option<(String, String)> {
    v.pump();
    ws.read_with(&v.cx, |ws, cx| {
        ws.git().read(cx).review().read(cx).writing_state(cx)
    })
}

pub(crate) fn field(v: &mut View, ws: &Entity<Workspace>) -> Option<(String, String)> {
    v.pump();
    ws.read_with(&v.cx, |ws, cx| {
        ws.popups()
            .read(cx)
            .input_state(cx)
            .map(|(title, text, _)| (title, text))
    })
}

/// The Submit review dialog's verdict, while it is open.
pub(crate) fn dialog(v: &mut View, ws: &Entity<Workspace>) -> Option<Verdict> {
    v.pump();
    ws.read_with(&v.cx, |ws, cx| {
        let d = ws
            .git()
            .read(cx)
            .review()
            .read(cx)
            .submit_dialog()
            .cloned()?;
        Some(d.read(cx).verdict)
    })
}

pub(crate) fn menu_rows(v: &mut View) -> Option<Vec<String>> {
    v.pump();
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, cx| ws.popups().read(cx).menu_rows())
}

pub(crate) fn balloons(v: &mut View, ws: &Entity<Workspace>) -> Vec<(String, String)> {
    v.pump();
    ws.read_with(&v.cx, |ws, cx| ws.popups().read(cx).balloons())
}

#[test]
fn the_review_opens_the_pr_in_the_log_draws_the_screen_s_pane_and_its_enter_opens_the_pr_diff() {
    let r = pr_repo();
    let mut rules = opened(&r);
    rules.extend([
        (
            r#""kind":"order","heat":false"#.to_owned(),
            vec![tree_frame(
                &r,
                &Pane {
                    folder: true,
                    ..Pane::default()
                },
            )],
        ),
        (
            r#""kind":"order","heat":true"#.to_owned(),
            vec![tree_frame(&r, &Pane::default())],
        ),
        (
            format!(r#""kind":"scope","commits":["{}"]"#, r.head),
            vec![tree_frame(
                &r,
                &Pane {
                    commit: true,
                    ..Pane::default()
                },
            )],
        ),
        (
            r#""kind":"scope","commits":[]"#.to_owned(),
            vec![tree_frame(&r, &Pane::default())],
        ),
        (
            r#""kind":"mark","path":"src/b.ts""#.to_owned(),
            vec![tree_frame(
                &r,
                &Pane {
                    marked: true,
                    ..Pane::default()
                },
            )],
        ),
    ]);
    let mut v = start(&r, rules);
    let first = active_dir(&mut v);
    open_review(&mut v, &r);

    // the worktree's project shown, its Git tool window on the Log filtered to the PR
    v.wait_until("the worktree's project shown", |v| active_dir(v) == r.tree);
    // the project shown before stays open; the main checkout stays on its branch
    assert!(v.cx.update(|_, cx| vimstorm::shell::projects::open_dirs(cx).contains(&first)));
    assert_eq!(git(&r.main, &["branch", "--show-current"]), "master");
    let ws = v.active_project();
    v.wait_until("the Log on PR #7", |v| {
        ws.read_with(&v.cx, |ws, cx| {
            let g = ws.git().read(cx);
            g.is_open() && g.active() == TabId::Log && g.log().read(cx).pr_number(cx) == Some(7)
        })
    });
    let labels = ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).labels(cx));
    assert_eq!(
        labels.iter().map(|l| l.as_ref()).collect::<Vec<_>>(),
        ["Local Changes", "Log: PR #7"],
        "PR review is the Log's PR filter"
    );
    // the screen told which PR, in which checkout, by heat
    let open = log(&r.dir)
        .into_iter()
        .find(|l| l.contains(r#""type":"open""#) && l.contains(r#""slot":"review""#))
        .expect("the review slot opened");
    let open: Value = serde_json::from_str(&open).unwrap();
    assert_eq!(open["screen"], "review");
    assert_eq!(
        open["params"],
        json!({"pr": "7", "path": r.tree.to_string_lossy(), "list": "heat"})
    );
    // its pane: the files by heat
    v.wait_until("the files by heat", |v| {
        pane_lines(v, &ws).is_some_and(|l| l.iter().any(|x| x.starts_with("5 ")))
    });
    assert_eq!(
        pane_lines(&mut v, &ws).unwrap(),
        ["5 src/b.ts", "2 src/a.ts", "▸ Lockfiles"]
    );
    // the Log lists the PR's commits (the strip's base..head) under All changes
    v.wait_until("the PR's commits", |v| {
        v.pump();
        ws.read_with(&v.cx, |ws, cx| {
            let log = ws.git().read(cx).log().read(cx);
            log.filters.pr.is_some() && log.model.len() == 2 && !log.loading
        })
    });
    let subjects = ws.read_with(&v.cx, |ws, cx| {
        let l = ws.git().read(cx).log().read(cx);
        l.model
            .commits
            .iter()
            .map(|c| c.subject.clone())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        subjects,
        ["AB#1 the change", "base"],
        "the PR's commit, then its merge base (drawn dim, not the PR's)"
    );
    for drawn in [
        "pr-strip",
        "pr-all-changes",
        "chip-pr",
        "pr-files",
        "pr-scope-label",
    ] {
        assert!(v.cx.debug_bounds(drawn).is_some(), "{drawn} drawn");
    }
    let strip = |v: &mut View| {
        v.pump();
        ws.read_with(&v.cx, |ws, cx| {
            ws.git().read(cx).review().read(cx).strip(cx)
        })
        .expect("the strip")
    };
    assert_eq!(strip(&mut v).scope, Scope::All);
    // By folder / By heat: the order asked of the screen, its pane drawn
    let folder =
        v.cx.debug_bounds("pr-order-folder")
            .expect("By folder")
            .center();
    v.click(gpui_kit::MouseButton::Left, folder);
    v.wait_until("by folder", |v| {
        pane_lines(v, &ws).unwrap() == ["▾ src/", "2 a.ts", "5 b.ts", "1 package-lock.json"]
    });
    let heat =
        v.cx.debug_bounds("pr-order-heat")
            .expect("By heat")
            .center();
    v.click(gpui_kit::MouseButton::Left, heat);
    v.wait_until("by heat again", |v| {
        pane_lines(v, &ws).is_some_and(|l| l.first().map(String::as_str) == Some("5 src/b.ts"))
    });
    // ö in the table: the PR's one commit is the scope (G23); ↑ back to All changes
    let table = ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).gcx().view_focus().clone());
    v.cx.update(|window, cx| window.focus(&table, cx));
    v.key("ö");
    v.wait_until("Commit 1/1", |v| {
        matches!(strip(v).scope, Scope::Commit { place: 1, .. })
    });
    assert!(asked(&r, json!({"kind": "scope", "commits": [r.head]})));
    v.key("l");
    v.wait_until("All changes again", |v| strip(v).scope == Scope::All);

    // ⏎ into the files, ⏎ there: the screen's show-diff, merge base left, PR head right, line 2
    v.key("enter");
    v.wait_until("the files have the keyboard", |v| {
        v.cx.update(|window, cx| {
            ws.read(cx)
                .git()
                .read(cx)
                .review()
                .read(cx)
                .files_focused(window)
        })
    });
    v.key("enter");
    wait_diff_of(&mut v, &ws, "src/b.ts");
    assert!(
        log(&r.dir)
            .iter()
            .any(|l| l.contains(r#""slot":"review""#) && l.contains(r#""key":"<CR>""#)),
        "⏎ is the screen's"
    );
    let d = viewer(&mut v, &ws).unwrap();
    assert_eq!(
        d.panes[0].title.hash.as_deref(),
        Some(&r.base[..8]),
        "the merge base left"
    );
    assert_eq!(
        d.panes[1].title.hash.as_deref(),
        Some(&r.head[..8]),
        "the PR head right"
    );
    assert_eq!(d.toolbar.files, Some((1, 2)), "the PR's files");
    // the PR diff's toolbar (G25): the PR's number, the scope switch, ‹ ›, Reviewed; the right side the head
    assert_eq!(
        d.toolbar.review.as_ref().map(|r| (r.pr, r.path.as_str())),
        Some((7, "src/b.ts"))
    );
    assert_eq!(d.panes[1].title.path.as_deref(), Some("head of #7"));
    v.wait_until("the PR part of the diff's toolbar", |v| {
        v.pump();
        v.cx.debug_bounds("diff-pr-scope").is_some()
            && v.cx.debug_bounds("diff-pr-reviewed").is_some()
    });
    // Reviewed: b.ts marked reviewed by the screen
    let tick = v.cx.debug_bounds("diff-pr-reviewed").unwrap().center();
    v.click(gpui_kit::MouseButton::Left, tick);
    v.wait_until("b.ts reviewed", |v| {
        pane_lines(v, &ws).is_some_and(|l| l.contains(&"5 src/b.ts ✓".to_owned()))
    });
    assert!(asked(&r, json!({"kind": "mark", "path": "src/b.ts"})));
    let shown = ws.read_with(&v.cx, |ws, cx| {
        ws.git().read(cx).review().read(cx).diffs_shown().to_vec()
    });
    assert_eq!(shown.len(), 1);
    assert_eq!((shown[0].line, shown[0].index), (2, 1));
    let rpc = ws.read_with(&v.cx, |ws, _| ws.rpc().clone());
    let cursor = |rpc: &vimstorm::nvim::Rpc| -> i64 {
        rpc.request_blocking(
            "nvim_exec_lua",
            vec![
                "local s = require('git.diff').state(); return vim.api.nvim_win_get_cursor(s.new_win)[1]".into(),
                rmpv::Value::Array(vec![]),
            ],
            Duration::from_secs(5),
        )
        .unwrap()
        .as_i64()
        .unwrap_or(-1)
    };
    v.wait_until("the cursor on the change", |_| cursor(&rpc) == 2);

    // Esc to the diff; Cmd+Ö there: b.ts has one change, so the next file's first (a.ts, line 3)
    keyboard_to_the_diff(&mut v, &ws);
    v.key("super+ö");
    wait_diff_of(&mut v, &ws, "src/a.ts");
    assert_eq!(viewer(&mut v, &ws).unwrap().toolbar.files, Some((2, 2)));
    v.wait_until("its first change", |_| cursor(&rpc) == 3);

    // Code's panel on Git (⌘3) returns to the PR's Log in the review worktree's workspace.
    v.key("super+digit_3");
    v.wait_until("the Git tool window has the keyboard", |v| {
        ws.read_with(&v.cx, |ws, _| ws.native_focus()) == Some("git")
    });
    assert_eq!(
        ws.read_with(&v.cx, |ws, cx| ws.git().read(cx).active()),
        TabId::Log,
    );
    assert_eq!(
        git(&r.main, &["branch", "--show-current"]),
        "master",
        "the main checkout untouched"
    );
}

#[test]
fn the_pane_takes_the_mouse_a_click_moves_the_screen_s_cursor_the_row_menu_and_a_double_click_open()
{
    use gpui_kit::MouseButton;
    let r = pr_repo();
    let mut rules = opened(&r);
    rules.extend([
        (
            r#""kind":"at","line":1}"#.to_owned(),
            vec![tree_frame(
                &r,
                &Pane {
                    at: 1,
                    ..Pane::default()
                },
            )],
        ),
        (
            r#""kind":"at","line":0}"#.to_owned(),
            vec![tree_frame(&r, &Pane::default())],
        ),
        (
            r#""kind":"menu","run":"select""#.to_owned(),
            vec![tree_frame(
                &r,
                &Pane {
                    marked: true,
                    ..Pane::default()
                },
            )],
        ),
        (
            r#""kind":"at","line":1,"open":true"#.to_owned(),
            vec![show_diff(&r, 2, 3)],
        ),
    ]);
    let mut v = start(&r, rules);
    let ws = to_the_pane(&mut v, &r);
    // the PR's files have the keyboard: the header still marks Log (it has no tab of its own)
    v.wait_until("the header marks Log", |v| {
        v.pump();
        ws.read_with(&v.cx, |ws, cx| {
            let h = ws.git().read(cx).header().read(cx);
            h.tabs()
                .get(h.selected())
                .is_some_and(|t| t.label.starts_with("Log"))
        })
    });
    let row = |v: &mut View, ix: usize| {
        v.pump();
        v.cx.debug_bounds(Box::leak(format!("pr-changes-row-{ix}").into_boxed_str()))
            .unwrap_or_else(|| panic!("row {ix} not drawn"))
            .center()
    };
    let cursor = |v: &mut View| {
        v.pump();
        ws.read_with(&v.cx, |ws, cx| {
            ws.git().read(cx).review().read(cx).model(cx)
        })
        .and_then(|m| m.at)
    };
    // a click on a.ts's row: the screen's cursor there
    let at = row(&mut v, 1);
    v.click(MouseButton::Left, at);
    v.wait_until("the cursor on a.ts", |v| cursor(v) == Some(1));
    assert!(asked(&r, json!({"kind": "at", "line": 1})));
    // a right-click on b.ts's: the cursor there first, then the screen's menu rows
    let at = row(&mut v, 0);
    v.click(MouseButton::Right, at);
    v.wait_until("the row's menu", |v| menu_rows(v).is_some());
    let shown = menu_rows(&mut v).unwrap();
    for item in [
        "Next Change",
        "Previous File by Heat",
        "Mark Reviewed",
        "Mark Reviewed with Copies",
        "Drop Draft",
        "Tree / Areas / Heat",
        "Previous Commit",
        "Next Commit",
        "Open on GitHub",
    ] {
        assert!(
            shown.iter().any(|r| r.starts_with(item)),
            "{item}: {shown:?}"
        );
    }
    assert_eq!(cursor(&mut v), Some(0), "the right-click's row");
    v.keystrokes("m a r");
    v.key("enter");
    v.wait_until("b.ts marked", |v| {
        pane_lines(v, &ws).is_some_and(|l| l.contains(&"5 src/b.ts ✓".to_owned()))
    });
    assert!(asked(&r, json!({"kind": "menu", "run": "select"})));
    // the conversation under the files (all changes): its review drawn, the field's ⌘⏎ posts a
    // comment on the PR, its spaces kept
    v.wait_until("the conversation drawn", |v| {
        v.pump();
        v.cx.debug_bounds("pr-conversation-0").is_some()
    });
    assert!(v.cx.debug_bounds("pr-say-field").is_some(), "its field");
    let say = ws.read_with(&v.cx, |ws, cx| {
        let r = ws.git().read(cx).review().read(cx);
        gpui_kit::Focusable::focus_handle(r.say_field().read(cx), cx)
    });
    v.cx.update(|window, cx| window.focus(&say, cx));
    v.keystrokes("O k space t h e n");
    v.key("super+enter");
    v.wait_until("the comment asked", |_| {
        asked(&r, json!({"kind": "say", "body": "Ok then"}))
    });
    // the checks chip: the PR's runs
    let checks =
        v.cx.debug_bounds("pr-chip-checks")
            .expect("the checks chip")
            .center();
    v.click(MouseButton::Left, checks);
    v.wait_until("the runs asked", |_| {
        asked(&r, json!({"kind": "menu", "run": "checks"}))
    });
    // a double-click is ⏎ on its row: a.ts's first change in the diff
    let at = row(&mut v, 1);
    for n in 1..=2 {
        use gpui_kit::{Modifiers, MouseDownEvent, MouseUpEvent};
        v.cx.simulate_event(MouseDownEvent {
            button: MouseButton::Left,
            position: at,
            modifiers: Modifiers::default(),
            click_count: n,
            first_mouse: false,
        });
        v.cx.simulate_event(MouseUpEvent {
            button: MouseButton::Left,
            position: at,
            modifiers: Modifiers::default(),
            click_count: n,
        });
    }
    wait_diff_of(&mut v, &ws, "src/a.ts");
    assert!(asked(&r, json!({"kind": "at", "line": 1, "open": true})));
}
