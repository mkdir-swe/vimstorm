//! `g w` on a cloud session: the bridge's `open-project` with an `attach` opens a project on the
//! box's folder, its Neovim, terminal tabs, tree listings and git each started through the
//! attach's argv. Here the "box" is this Mac behind wrapper scripts that log every call and read
//! the box's folder (`…/box/workspace/repo`, no folder here) as a local repo: the tree showing its
//! files and git's status prove every read went through them. The status bar's `☁` sign, ⌘⌥A back
//! to the Factory with the workspace kept, RemoteState after a failed connect, its Retry ⏎ and its
//! Download locally ⌘⏎ (a click the bridge runs); the tree's first walk is one call to the box, and
//! a slow box never holds the window. Go to File lists the box's files from one `rg --files`, Find
//! in Files streams `rg --json` from there (a new query ends the old rg by closing its channel's
//! input, as ssh's channel close does) and the tree's speed search uses the listed rows, with no
//! call.
#![cfg(debug_assertions)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use vimstorm::search::PickerState;
use vimstorm::shell::Workspace;

use crate::common::bridge::{fake, log};
use crate::common::view::View;

/// A wrapper `wrap <log> <argv…>`: notes the call in `<log>`, reads `root` as `real` in every word,
/// runs it in `real`, as `abe box attach <box> -- …` would on the box.
pub(crate) fn wrapper(dir: &Path, root: &Path, real: &Path) -> PathBuf {
    slow_wrapper(dir, root, real, 0)
}

/// [`wrapper`] whose listings and git (`sh …`, `env … git …`) each take `secs` first, as a call
/// to a box that is still connecting.
fn slow_wrapper(dir: &Path, root: &Path, real: &Path, secs: u32) -> PathBuf {
    let path = dir.join("wrap.sh");
    std::fs::write(
        &path,
        format!(
            "#!/bin/bash\nlog=\"$1\"; shift\nprintf '%s\\n' \"$*\" >> \"$log\"\ncase \"$1\" in sh|env) sleep {secs};; esac\nroot='{root}'; real='{real}'\nargs=(\"${{@//$root/$real}}\")\ncd \"$real\" && exec \"${{args[@]}}\"\n",
            root = root.display(),
            real = real.display(),
        ),
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", path.to_str().unwrap()])
        .status()
        .unwrap();
    path
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `open-project` shell frame the bridge answers `g w` with.
pub(crate) fn frame(
    dir: &Path,
    name: &str,
    root: &Path,
    nvim: Vec<String>,
    shell: Vec<String>,
    exec: Vec<String>,
) -> PathBuf {
    let path = dir.join(name);
    let v = json!({
        "v": 2, "type": "shell",
        "effect": {
            "kind": "open-project",
            "path": root,
            "attach": {
                "nvim": nvim, "shell": shell, "exec": exec,
                "box": { "name": "shop-4", "region": "eu-west-1" },
                "waking": false,
                "download": "download:4-ab12",
            },
        },
    });
    std::fs::write(&path, v.to_string()).unwrap();
    path
}

fn shown_dir(v: &mut View) -> PathBuf {
    let ws = v.active_project();
    ws.read_with(&v.cx, |ws, _| ws.project().clone())
}

#[test]
fn g_w_attaches_the_editor_its_terminal_tree_and_git_through_the_attach() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    // the box's clone, as a local git repo with a change
    let real = base.join("clone");
    std::fs::create_dir_all(real.join("src")).unwrap();
    std::fs::write(real.join("src/cart.ts"), "export const total = 1;\n").unwrap();
    git(&real, &["init", "-q", "-b", "main"]);
    git(&real, &["add", "."]);
    git(
        &real,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "one",
        ],
    );
    std::fs::write(real.join("src/cart.ts"), "export const total = 2;\n").unwrap();
    let root = base.join("box/workspace/repo");
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let log_of = |n: &str| base.join(n).display().to_string();
    let nvim = vec![
        wrap.clone(),
        log_of("nvim.log"),
        "nvim".into(),
        "--embed".into(),
    ];
    let shell = vec![
        wrap.clone(),
        log_of("shell.log"),
        "/bin/sh".into(),
        "-c".into(),
        "echo remote-shell-in \"$PWD\"; exec /bin/sh".into(),
    ];
    let exec = vec![wrap.clone(), log_of("exec.log")];
    let open = frame(&base, "open.json", &root, nvim, shell, exec);

    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));

    // g w on the overview: the bridge answers with the attach
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");
    v.key("w");
    v.wait_until("the workspace shown on the box's folder", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown()) && shown_dir(v) == root
    });
    assert!(log(&base).iter().any(|l| l.contains(r#""key":"w""#)));
    let ws: gpui_kit::Entity<Workspace> = v.active_project();
    v.use_project(&ws);
    v.wait_until("attached: Neovim drew", |v| {
        v.read_ws(|ws, _| ws.remote().is_some_and(|r| r.attached()))
    });
    // its Neovim started through the attach: `--embed` there, the app's --cmd after it
    let started = lines(&base.join("nvim.log"));
    assert_eq!(started.len(), 1, "{started:?}");
    assert!(
        started[0].starts_with("nvim --embed --cmd let g:vimstorm_app = 1"),
        "{started:?}"
    );
    assert_eq!(
        v.lua("return vim.fn.getcwd()").as_str(),
        Some(real.to_str().unwrap())
    );

    // the one sign: ☁ and its box's name (never `your environment`), its hover the box
    v.wait_until("☁ shop-4", |v| {
        v.cx.debug_bounds("status-cloud").is_some()
    });
    let hover = v.read_ws(|ws, _| {
        ws.remote()
            .map(|r| (r.status_text(std::time::Instant::now()), r.hover()))
    });
    let (text, hover) = hover.unwrap();
    assert_eq!(text, "☁ shop-4");
    assert!(
        hover.starts_with("Attached to your cloud environment · shop-4 · eu-west-1"),
        "{hover}"
    );
    assert!(v.cx.debug_bounds("remote-state").is_none());

    // the tree lists the box's folder (no folder here): only through the exec prefix
    let tree = v.read_ws(|ws, _| ws.tree().clone());
    v.wait_until("the tree shows the clone's files", |v| {
        tree.read_with(&v.cx, |t, _| t.row_paths())
            .iter()
            .any(|r| r == "src")
    });
    let exec_log = lines(&base.join("exec.log"));
    assert!(
        // (the listing's script spans lines: its last one ends with the tree's walk of its folder)
        exec_log.iter().any(|l| l.starts_with("sh -c limit=$1"))
            && exec_log
                .iter()
                .any(|l| l.ends_with(&format!(" sh 2000 walk 50000 {}", root.display()))),
        "{exec_log:?}"
    );
    // git's status for the tree's colours: on the box too
    v.wait_until("git status through the exec prefix", |_| {
        lines(&base.join("exec.log")).iter().any(|l| {
            l.contains(&format!(
                "git -C {} -c core.quotepath=false status",
                root.display()
            ))
        })
    });
    v.wait_until("the change coloured from git's answer", |v| {
        tree.read_with(&v.cx, |t, _| {
            t.git().status(Path::new("src/cart.ts"), false).is_some()
        })
    });

    // a terminal tab: the attach's shell
    crate::common::terminal::open(&mut v);
    crate::common::terminal::wait_screen(&mut v, &format!("remote-shell-in {}", real.display()));
    assert_eq!(lines(&base.join("shell.log")).len(), 1);

    // ⌘⌥A: the overview again, the workspace kept open (hidden)
    v.key("super+alt+a");
    v.wait_until("the Factory view again", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    let dirs = projects.read_with(&v.cx, |p, _| p.dirs());
    assert!(dirs.contains(&root), "{dirs:?}");
    // never saved for the next launch: the box's folder is no folder here
    let saved = std::fs::read_to_string(v.state_home().join("vimstorm/open-projects.json"))
        .unwrap_or_default();
    assert!(!saved.contains("box/workspace/repo"), "{saved}");
}

#[test]
fn a_failed_connect_shows_remote_state_and_retry_starts_it_again() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let real = base.join("clone");
    std::fs::create_dir_all(&real).unwrap();
    let root = base.join("box/workspace/repo");
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let log = base.join("nvim.log").display().to_string();
    // the "box" does not answer: the attach ends at once, saying a long why
    let nvim = vec![
        wrap.clone(),
        log.clone(),
        "/bin/sh".into(),
        "-c".into(),
        "echo 'abe: The config profile (abe-tooling) could not be found on this Mac, so the tunnel \
         to the box never opened' >&2; exit 1"
            .into(),
    ];
    let other = base.join("other.log").display().to_string();
    let open = frame(
        &base,
        "open.json",
        &root,
        nvim,
        vec![wrap.clone(), other.clone(), "/bin/sh".into()],
        vec![wrap, other],
    );

    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");
    v.key("w");
    // (tried again after each end's back-off, on GPUI's test clock)
    v.wait_until("RemoteState: couldn't connect", |v| {
        v.advance(Duration::from_millis(500));
        shown_dir(v) == root && v.cx.debug_bounds("remote-state").is_some() && {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.remote().is_some_and(|r| r.failed()))
        }
    });
    let tries = lines(&base.join("nvim.log")).len();
    assert_eq!(tries, vimstorm::shell::remote::TRIES as usize);
    assert!(v.cx.debug_bounds("remote-retry").is_some());
    assert!(v.cx.debug_bounds("remote-download").is_some());
    // every step line wraps inside the card, the long why too
    let card = v.cx.debug_bounds("remote-state").unwrap();
    let steps: Vec<_> = ["remote-step-0", "remote-step-1", "remote-step-2"]
        .into_iter()
        .filter_map(|s| v.cx.debug_bounds(s))
        .collect();
    assert_eq!(steps.len(), 2, "the failed attach and where it ended");
    // (inside the card's 20 px padding)
    for s in &steps {
        assert!(
            s.right() <= card.right() - gpui_kit::px(20.),
            "{s:?} runs past {card:?}"
        );
    }
    let ws = v.active_project();
    let text = ws.read_with(&v.cx, |ws, _| {
        ws.remote()
            .map(|r| r.status_text(std::time::Instant::now()))
    });
    assert_eq!(text.as_deref(), Some("✗ couldn't connect"));
    // RemoteState names the box, never `your environment`
    let title = ws.read_with(&v.cx, |ws, _| {
        ws.remote().map(|r| r.title(std::time::Instant::now()))
    });
    assert_eq!(title.as_deref(), Some("Couldn't connect to shop-4"));
    // the project stays open
    assert!(projects.read_with(&v.cx, |p, _| p.dirs()).contains(&root));

    // Retry ⏎: started again through the same attach
    v.key("enter");
    v.wait_until("started again", |_| {
        lines(&base.join("nvim.log")).len() > tries
    });
    v.wait_until("still RemoteState, the project still open", |v| {
        shown_dir(v) == root && v.cx.debug_bounds("remote-state").is_some()
    });
    v.wait_until("failed again", |v| {
        v.advance(Duration::from_millis(500));
        let ws = v.active_project();
        ws.read_with(&v.cx, |ws, _| ws.remote().is_some_and(|r| r.failed()))
    });

    // Download locally ⌘⏎: the attach's click goes to the bridge, which downloads it
    v.key("super+enter");
    v.wait_until("the download click in the bridge", |_| {
        crate::common::bridge::log(&base)
            .iter()
            .any(|l| l.contains("\"click\"") && l.contains("download:4-ab12"))
    });
}

/// The listing calls in an exec log (the script's first line starts each).
fn listings(log: &Path) -> usize {
    lines(log)
        .iter()
        .filter(|l| l.starts_with("sh -c limit=$1"))
        .count()
}

#[test]
fn the_trees_first_walk_is_one_call_and_a_slow_box_never_holds_the_window() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    // the box's clone: folders in folders, a node_modules
    let real = base.join("clone");
    for d in ["src/a/b", "src/c", "docs", "node_modules/left-pad"] {
        std::fs::create_dir_all(real.join(d)).unwrap();
    }
    for f in ["src/a/b/deep.ts", "src/c/c.ts", "docs/x.md", "README.md"] {
        std::fs::write(real.join(f), "x\n").unwrap();
    }
    git(&real, &["init", "-q", "-b", "main"]);
    let root = base.join("box/workspace/repo");
    // each listing and git call takes 2 s, as on a box still connecting
    let wrap = slow_wrapper(&base, &root, &real, 2).display().to_string();
    let log_of = |n: &str| base.join(n).display().to_string();
    let nvim = vec![
        wrap.clone(),
        log_of("nvim.log"),
        "nvim".into(),
        "--embed".into(),
    ];
    let shell = vec![wrap.clone(), log_of("shell.log"), "/bin/sh".into()];
    let exec = vec![wrap.clone(), log_of("exec.log")];
    let open = frame(&base, "open.json", &root, nvim, shell, exec);
    let exec_log = base.join("exec.log");

    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");

    // from `w` on, while the box takes its time, the window goes on: no pump (each runs what
    // GPUI's executors have ready, on this thread) waits for a call to the box
    let mut slowest = Duration::ZERO;
    let t = Instant::now();
    v.key("w");
    slowest = slowest.max(t.elapsed());
    let t0 = Instant::now();
    let mut tree = None;
    loop {
        let t = Instant::now();
        v.pump();
        slowest = slowest.max(t.elapsed());
        let shown = projects.read_with(&v.cx, |p, _| {
            p.active().cloned().filter(|_| !p.factory_shown())
        });
        if let Some(ws) = shown.filter(|ws| ws.read_with(&v.cx, |ws, _| ws.project() == &root)) {
            let t = tree.get_or_insert_with(|| ws.read_with(&v.cx, |ws, _| ws.tree().clone()));
            let rows = t.read_with(&v.cx, |t, _| t.row_paths());
            if ["src", "docs", "node_modules"]
                .iter()
                .all(|r| rows.iter().any(|x| x == r))
            {
                v.use_project(&ws);
                break;
            }
        }
        assert!(
            t0.elapsed() < Duration::from_secs(30),
            "the tree never showed the clone\n{:?}",
            lines(&exec_log)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let tree = tree.unwrap();
    assert!(
        slowest < Duration::from_millis(1000),
        "a pump waited {slowest:?} for the box"
    );

    // the whole tree came in that one call: every folder's chevron known, none asked on its own
    let chevron = |v: &mut View, rel: &str| {
        tree.read_with(&v.cx, |t, _| {
            let ix = t
                .row_index(rel)
                .unwrap_or_else(|| panic!("{rel} not shown"));
            t.has_chevron(ix)
        })
    };
    v.settle();
    assert!(chevron(&mut v, "src") && chevron(&mut v, "node_modules"));
    // open src, then src/a: drawn from the walk at once
    for (rel, shows) in [("src", "src/a"), ("src/a", "src/a/b")] {
        let at = tree.read_with(&v.cx, |t, _| {
            t.chevron_point(t.row_index(rel).unwrap()).unwrap()
        });
        v.click(gpui_kit::MouseButton::Left, at);
        v.wait_until(&format!("{shows} shown"), |v| {
            tree.read_with(&v.cx, |t, _| t.row_paths())
                .iter()
                .any(|r| r == shows)
        });
    }
    assert!(chevron(&mut v, "src/a/b") && chevron(&mut v, "src/c"));
    v.settle();
    assert_eq!(
        listings(&exec_log),
        1,
        "one walk, no folder on its own: {:?}",
        lines(&exec_log)
    );
}

/// A wrapper whose first `fails` calls end before Neovim answers, as the attach to a busy box did
/// (the ssh, `docker exec` or nvim ending first, saying why on stderr), then go on as
/// [`wrapper`] does.
fn flaky_wrapper(
    dir: &Path,
    root: &Path,
    real: &Path,
    fails: u32,
    stderr: &str,
    code: u8,
) -> PathBuf {
    let inner = wrapper(dir, root, real);
    let path = dir.join("flaky.sh");
    std::fs::write(
        &path,
        format!(
            "#!/bin/bash\nn=$(cat '{count}' 2>/dev/null || echo 0); echo $((n + 1)) > '{count}'\nif [ \"$n\" -lt {fails} ]; then printf '%s\\n' \"$1\" >> '{tries}'; echo '{stderr}' >&2; exit {code}; fi\nexec '{inner}' \"$@\"\n",
            count = dir.join("flaky.count").display(),
            tries = dir.join("flaky.tries").display(),
            inner = inner.display(),
        ),
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", path.to_str().unwrap()])
        .status()
        .unwrap();
    path
}

/// `g w` with the bridge answering `open`.
fn open_workspace(
    base: &Path,
    open: &Path,
) -> (View, gpui_kit::Entity<vimstorm::shell::projects::Projects>) {
    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");
    v.key("w");
    (v, projects)
}

#[test]
fn an_attach_that_ends_before_it_answers_is_tried_again_before_it_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let real = base.join("clone");
    std::fs::create_dir_all(&real).unwrap();
    let root = base.join("box/workspace/repo");
    // a busy box: the first two attaches end (ssh's keepalives gave up), the third answers
    let flaky = flaky_wrapper(
        &base,
        &root,
        &real,
        2,
        "Timeout, server 10.0.1.5 not responding.",
        255,
    )
    .display()
    .to_string();
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let log_of = |n: &str| base.join(n).display().to_string();
    let nvim = vec![flaky, log_of("nvim.log"), "nvim".into(), "--embed".into()];
    let other = log_of("other.log");
    let open = frame(
        &base,
        "open.json",
        &root,
        nvim,
        vec![wrap.clone(), other.clone(), "/bin/sh".into()],
        vec![wrap, other],
    );
    let (mut v, _projects) = open_workspace(&base, &open);
    // while it tries again: RemoteState says which try and where the last one ended
    v.wait_until("a second try, saying where the first ended", |v| {
        v.advance(Duration::from_millis(500));
        shown_dir(v) == root && {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| {
                ws.remote().is_some_and(|r| {
                    r.tries == 2
                        && r.line(Instant::now()).contains("the files fill in")
                        && !r.failed()
                        && r.ended()
                            .is_some_and(|e| e.detail().contains("not responding"))
                })
            })
        }
    });
    v.wait_until("attached on the third try", |v| {
        v.advance(Duration::from_millis(500));
        let ws = v.active_project();
        ws.read_with(&v.cx, |ws, _| {
            ws.project() == &root && ws.remote().is_some_and(|r| r.attached())
        })
    });
    assert_eq!(lines(&base.join("flaky.tries")).len(), 2);
    assert_eq!(lines(&base.join("nvim.log")).len(), 1);
    assert!(v.cx.debug_bounds("remote-state").is_none());
}

#[test]
fn an_attach_that_keeps_ending_fails_naming_the_step_and_its_stderr() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let real = base.join("clone");
    std::fs::create_dir_all(&real).unwrap();
    let root = base.join("box/workspace/repo");
    let flaky = flaky_wrapper(
        &base,
        &root,
        &real,
        99,
        "Error response from daemon: container abe-workspace is not running",
        125,
    )
    .display()
    .to_string();
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let other = base.join("other.log").display().to_string();
    let open = frame(
        &base,
        "open.json",
        &root,
        vec![flaky, other.clone(), "nvim".into(), "--embed".into()],
        vec![wrap.clone(), other.clone(), "/bin/sh".into()],
        vec![wrap, other],
    );
    let (mut v, _projects) = open_workspace(&base, &open);
    v.wait_until("RemoteState: couldn't connect", |v| {
        v.advance(Duration::from_millis(500));
        shown_dir(v) == root && {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.remote().is_some_and(|r| r.failed()))
        }
    });
    // a few tries, then the error: where it ended and what it said
    let tries = lines(&base.join("flaky.tries")).len();
    assert_eq!(tries, 4, "tried {tries} times");
    let ws = v.active_project();
    let (line, detail) = ws.read_with(&v.cx, |ws, _| {
        let r = ws.remote().unwrap();
        (r.line(Instant::now()), r.ended().map(|e| e.detail()))
    });
    assert!(
        line.starts_with("It ended at docker exec before it answered"),
        "{line}"
    );
    assert!(
        detail.is_some_and(|d| d.contains("container abe-workspace is not running")),
        "the stderr shown"
    );
    assert!(v.cx.debug_bounds("remote-retry").is_some());
}

/// The header's feed as the bridge says it of `box_` (the contract's look of a box, moved onto it):
/// `building` its workspace or not.
fn feed_building(v: &mut View, box_: &str, root: &Path, building: Option<&str>) {
    use vimstorm::factory::WorkspaceFeed;
    use vimstorm::factory::WorkspaceLook;
    let frame: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(crate::common::bridge::fixture(
            "frames/bridge-shell-workspaces.json",
        ))
        .unwrap(),
    )
    .unwrap();
    let mut look = frame["effect"]["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l.get("box").is_some())
        .unwrap()
        .clone();
    look["box"] = json!(box_);
    look["root"] = json!(root);
    if let Some(b) = building {
        look["building"] = json!(b);
    }
    let look: WorkspaceLook = serde_json::from_value(look).unwrap();
    v.cx.update(|_, cx| {
        cx.set_global(WorkspaceFeed {
            workspaces: vec![look],
            factory: Default::default(),
            answering: true,
            abe_needs_you: Vec::new(),
            prototypes: Vec::new(),
            bridge_down: false,
        })
    });
}

#[test]
fn an_attach_while_the_box_builds_its_workspace_waits_on_the_build_and_spends_no_try() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let real = base.join("clone");
    std::fs::create_dir_all(&real).unwrap();
    let root = base.join("box/workspace/repo");
    // a fresh box building its workspace image: no container yet, then (once built) it answers
    let flaky = flaky_wrapper(
        &base,
        &root,
        &real,
        1,
        "Error response from daemon: No such container: abe-workspace",
        1,
    )
    .display()
    .to_string();
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let nvim_log = base.join("nvim.log").display().to_string();
    let other = base.join("other.log").display().to_string();
    let open = frame(
        &base,
        "open.json",
        &root,
        vec![flaky, nvim_log, "nvim".into(), "--embed".into()],
        vec![wrap.clone(), other.clone(), "/bin/sh".into()],
        vec![wrap, other],
    );
    let step = "Building the workspace image (first time on this box, ~3 min) · step 14/27";
    let mut v = View::start_projects("proj", &["a.txt"]);
    feed_building(&mut v, "shop-4", &root, Some(step));
    let projects = v.projects.clone().unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");
    v.key("w");
    let said = |v: &mut View| {
        let ws = v.active_project();
        ws.read_with(&v.cx, |ws, _| {
            ws.remote().map(|r| {
                (
                    r.title(Instant::now()),
                    r.line(Instant::now()),
                    r.tries,
                    r.failed(),
                )
            })
        })
    };
    v.wait_until(
        "RemoteState: building, the try that ended not counted",
        |v| {
            v.advance(Duration::from_millis(500));
            shown_dir(v) == root
                && lines(&base.join("flaky.tries")).len() == 1
                && said(v).is_some_and(|(title, _, tries, _)| {
                    title == "Building the workspace on shop-4" && tries == 1
                })
        },
    );
    // it waits on the build: no next try however long it takes, never `slept`, never failed
    for _ in 0..20 {
        v.advance(Duration::from_secs(1));
    }
    let (title, line, tries, failed) = said(&mut v).unwrap();
    assert_eq!(title, "Building the workspace on shop-4");
    assert!(!line.contains("slept"), "{line}");
    assert_eq!((tries, failed), (1, false));
    assert_eq!(lines(&base.join("flaky.tries")).len(), 1);
    assert!(v.cx.debug_bounds("remote-state").is_some());
    // built: the attach starts again and answers, its first try still
    feed_building(&mut v, "shop-4", &root, None);
    v.wait_until("attached once the workspace is up", |v| {
        v.advance(Duration::from_millis(500));
        let ws = v.active_project();
        ws.read_with(&v.cx, |ws, _| {
            ws.project() == &root && ws.remote().is_some_and(|r| r.attached() && r.tries == 1)
        })
    });
    assert_eq!(lines(&base.join("flaky.tries")).len(), 1);
    assert_eq!(lines(&base.join("nvim.log")).len(), 1);
    assert!(v.cx.debug_bounds("remote-state").is_none());
}

// ---- Go to File, Find in Files and speed search on the box -------------------------------------

/// The box's exec: `chan <log> <argv…>` notes the call, reads `root` as `real`, puts `bin` first
/// on PATH (the box's `rg`) and runs the command in the background, its input this one's: a
/// SIGKILL of this process (the Mac's `abe box attach`) doesn't end it, its input closing does.
fn channel(dir: &Path, root: &Path, real: &Path, bin: &Path) -> PathBuf {
    let path = dir.join("chan.sh");
    std::fs::write(
        &path,
        format!(
            "#!/bin/bash\nlog=\"$1\"; shift\nprintf '%s\\n' \"$*\" >> \"$log\"\nroot='{root}'; real='{real}'\nargs=(\"${{@//$root/$real}}\")\nexport PATH='{bin}':\"$PATH\"\ncd \"$real\" || exit 1\n\"${{args[@]}}\" <&0 &\nwait $!\n",
            root = root.display(),
            real = real.display(),
            bin = bin.display(),
        ),
    )
    .unwrap();
    chmod_x(&path);
    path
}

fn chmod_x(path: &Path) {
    std::process::Command::new("chmod")
        .args(["+x", path.to_str().unwrap()])
        .status()
        .unwrap();
}

/// The box's `rg`: the real one, but a search for `slowq` notes its pid in `slow.pid` and never
/// ends (a search still running when the query changes); one for `streamq` gives a match, notes
/// its pid in `stream.pid` and goes on.
fn box_rg(base: &Path) -> PathBuf {
    let bin = base.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let out = std::process::Command::new("sh")
        .args(["-c", "command -v rg"])
        .output()
        .unwrap();
    let real_rg = String::from_utf8(out.stdout).unwrap().trim().to_owned();
    assert!(!real_rg.is_empty(), "rg on PATH");
    let rg = bin.join("rg");
    std::fs::write(
        &rg,
        format!(
            "#!/bin/sh\nfor a; do\n  if [ \"$a\" = slowq ]; then echo $$ > '{pid}'; exec sleep 600; fi\n  if [ \"$a\" = streamq ]; then printf '%s\\n' '{hit}'; echo $$ > '{stream}'; exec sleep 600; fi\ndone\nexec '{real_rg}' \"$@\"\n",
            pid = base.join("slow.pid").display(),
            stream = base.join("stream.pid").display(),
            hit = r#"{"type":"match","data":{"path":{"text":"src/cart.ts"},"lines":{"text":"streamq here\n"},"line_number":3,"absolute_offset":0,"submatches":[{"match":{"text":"streamq"},"start":0,"end":7}]}}"#,
        ),
    )
    .unwrap();
    chmod_x(&rg);
    bin
}

/// `_tmp` holds the box's folder: bind it (a `..` drops it at once).
struct Remote {
    v: View,
    base: PathBuf,
    root: PathBuf,
    exec_log: PathBuf,
    _tmp: tempfile::TempDir,
}

/// `g w` on a cloud session whose box holds `files` (a git repo): the workspace shown, attached,
/// its tree listed.
fn attach(files: &[(&str, &str)]) -> Remote {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let real = base.join("clone");
    for (rel, body) in files {
        let p = real.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    git(&real, &["init", "-q", "-b", "main"]);
    let root = base.join("box/workspace/repo");
    let wrap = wrapper(&base, &root, &real).display().to_string();
    let chan = channel(&base, &root, &real, &box_rg(&base))
        .display()
        .to_string();
    let log_of = |n: &str| base.join(n).display().to_string();
    let nvim = vec![
        wrap.clone(),
        log_of("nvim.log"),
        "nvim".into(),
        "--embed".into(),
    ];
    let shell = vec![wrap, log_of("shell.log"), "/bin/sh".into()];
    let exec = vec![chan, log_of("exec.log")];
    let open = frame(&base, "open.json", &root, nvim, shell, exec);

    let mut v = View::start_projects("proj", &["a.txt"]);
    let projects = v.projects.clone().unwrap();
    let mut command = fake(&base, &["frames/bridge-tree.json"], None);
    command.env.push((
        "FAKE_BRIDGE_ON".into(),
        format!("\"key\":\"w\"={}", open.display()),
    ));
    v.cx.update(|_, cx| cx.set_global(command));
    v.key("super+alt+a");
    v.wait_until("the Factory view", |v| {
        projects.read_with(&v.cx, |p, _| p.factory_shown())
    });
    v.key("g");
    v.key("w");
    v.wait_until("the workspace shown on the box's folder", |v| {
        !projects.read_with(&v.cx, |p, _| p.factory_shown()) && {
            let ws = v.active_project();
            ws.read_with(&v.cx, |ws, _| ws.project() == &root)
        }
    });
    let ws = v.active_project();
    v.use_project(&ws);
    v.wait_until("attached: Neovim drew", |v| {
        v.read_ws(|ws, _| ws.remote().is_some_and(|r| r.attached()))
    });
    v.wait_until("the tree lists the box's files", |v| {
        v.read_ws(|ws, cx| ws.tree().read(cx).row_paths())
            .iter()
            .any(|r| r == "src")
    });
    Remote {
        v,
        exec_log: base.join("exec.log"),
        base,
        root,
        _tmp: tmp,
    }
}

fn picker(v: &mut View) -> Option<PickerState> {
    v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
}

fn wait_picker(v: &mut View, label: &str, pred: impl Fn(&PickerState) -> bool) {
    v.wait_until(label, |v| picker(v).is_some_and(|s| pred(&s)));
}

fn type_text(v: &mut View, text: &str) {
    for c in text.chars() {
        let k = if c.is_uppercase() {
            format!("shift+{}", c.to_lowercase())
        } else {
            c.to_string()
        };
        v.key(&k);
    }
}

/// The exec calls that ran `rg` with `word` among its arguments (the rg script's last line ends
/// with them).
fn rg_calls(log: &Path, word: &str) -> usize {
    lines(log)
        .iter()
        .filter(|l| l.starts_with("exit \"$s\" sh "))
        .filter(|l| l.split(' ').any(|w| w == word))
        .count()
}

const FILES: &[(&str, &str)] = &[
    ("src/cart.ts", "export const total = 1;\n"),
    ("src/deep/basket.ts", "export const items = [];\n"),
    ("README.md", "# shop\n"),
    (
        "node_modules/left-pad/index.js",
        "export const total = 0;\n",
    ),
];

#[test]
fn go_to_file_lists_the_box_files_from_one_rg_and_opens_the_pick() {
    let Remote {
        mut v,
        root,
        exec_log,
        _tmp,
        ..
    } = attach(FILES);
    v.key("super+o");
    wait_picker(&mut v, "Go to File settled", |s| {
        s.kind == "files" && s.settled
    });
    v.wait_until("the box's files indexed", |v| {
        v.read_ws(|ws, cx| ws.pickers().read(cx).index())
            .is_some_and(|i| i.iter().any(|p| p == "src/deep/basket.ts"))
    });
    let index = v.read_ws(|ws, cx| ws.pickers().read(cx).index()).unwrap();
    // its folders from the files' paths; node_modules left out (the project scope)
    assert!(index.iter().any(|p| p == "src/deep/"), "{index:?}");
    assert!(
        !index.iter().any(|p| p.starts_with("node_modules")),
        "{index:?}"
    );
    type_text(&mut v, "basket");
    wait_picker(&mut v, "basket matched", |s| {
        s.query == "basket" && s.settled && s.rows.first().map(String::as_str) == Some("basket.ts")
    });
    v.key("enter");
    v.wait_until("closed", |v| picker(v).is_none());
    let want = root.join("src/deep/basket.ts").display().to_string();
    v.wait_lua(
        "the box's file open in its Neovim",
        &format!("return vim.api.nvim_buf_get_name(0) == '{want}'"),
    );
    // the index was one call to the box per open, no listing of the folders
    // (one as the project opened, one as Go to File did)
    assert_eq!(rg_calls(&exec_log, "--files"), 2, "{:?}", lines(&exec_log));
}

#[test]
fn find_in_files_streams_the_box_matches_and_a_new_query_ends_the_old_rg() {
    let Remote {
        mut v,
        base,
        exec_log,
        _tmp,
        ..
    } = attach(FILES);
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files", |s| s.kind == "grep");
    // a search that is still running on the box
    type_text(&mut v, "slowq");
    let pid_file = base.join("slow.pid");
    v.wait_until("the slow rg running on the box", |_| pid_file.exists());
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .to_owned();
    let alive = |pid: &str| {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    };
    assert!(alive(&pid));
    // a new query: the old rg ends on the box (its channel's input closed)
    for _ in 0..5 {
        v.key("backspace");
    }
    type_text(&mut v, "total");
    let t = Instant::now();
    v.wait_until("the old rg ended", |_| !alive(&pid));
    assert!(t.elapsed() < Duration::from_secs(10));
    wait_picker(&mut v, "the box's match shown", |s| {
        s.query == "total" && s.settled && !s.rows.is_empty()
    });
    let st = picker(&mut v).unwrap();
    assert_eq!(st.rows, ["export const total = 1;"], "{st:#?}");
    assert_eq!(st.details, ["cart.ts 1"], "{st:#?}");
    assert_eq!(rg_calls(&exec_log, "total"), 1, "{:?}", lines(&exec_log));
    // the preview shows the box's file, read there in one call
    wait_picker(&mut v, "the box file's preview", |s| {
        s.preview_lines == ["export const total = 1;"]
    });
    let reads = |log: &Path| {
        lines(log)
            .iter()
            .filter(|l| l.starts_with("head -c ") && l.ends_with("src/cart.ts"))
            .count()
    };
    assert_eq!(reads(&exec_log), 1, "{:?}", lines(&exec_log));

    // streamed: a match shows while the box's rg goes on; Esc ends it there
    for _ in 0..5 {
        v.key("backspace");
    }
    type_text(&mut v, "streamq");
    wait_picker(&mut v, "the first match while rg runs", |s| {
        s.query == "streamq" && !s.settled && s.rows == ["streamq here"]
    });
    let stream = std::fs::read_to_string(base.join("stream.pid")).unwrap();
    assert!(alive(stream.trim()));
    v.key("escape");
    v.wait_until("closed", |v| picker(v).is_none());
    v.wait_until("the streaming rg ended", |_| !alive(stream.trim()));

    // the next popup reads the box's file again (it is not stat'ed while shown)
    v.key("super+shift+f");
    wait_picker(&mut v, "Find in Files again", |s| {
        s.kind == "grep" && s.query.is_empty()
    });
    type_text(&mut v, "total");
    wait_picker(&mut v, "the preview again", |s| {
        s.query == "total" && s.preview_lines == ["export const total = 1;"]
    });
    v.wait_until("read again", |_| reads(&exec_log) == 2);
}

#[test]
fn speed_search_in_the_tree_finds_the_listed_rows_without_a_call() {
    let Remote {
        mut v,
        exec_log,
        _tmp,
        ..
    } = attach(FILES);
    v.settle();
    if v.lua("return require('config.focus').target()").as_str() != Some("tree") {
        v.key("super+digit_1");
    }
    v.wait_lua(
        "the tree has the keyboard",
        "return require('config.focus').target() == 'tree'",
    );
    let before = lines(&exec_log).len();
    v.key("shift+digit_7");
    type_text(&mut v, "basket");
    v.wait_until("the speed search's results", |v| {
        v.read_ws(|ws, cx| {
            let t = ws.tree().read(cx);
            t.results_query() == Some("basket")
                && t.row_paths().iter().any(|r| r == "src/deep/basket.ts")
        })
    });
    let count = v.read_ws(|ws, cx| ws.tree().read(cx).match_count());
    assert_eq!(count, Some(1));
    // node_modules (excluded) not searched
    let rows = v.read_ws(|ws, cx| ws.tree().read(cx).row_paths());
    assert!(
        !rows.iter().any(|r| r.starts_with("node_modules")),
        "{rows:?}"
    );
    // no call to the box but git's
    let after = lines(&exec_log);
    assert!(
        after[before..].iter().all(|l| l.contains("git ")),
        "{:?}",
        &after[before..]
    );
}
