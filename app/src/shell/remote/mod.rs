//! A cloud session's workspace in the Editor (ADR 0021): ⌃W on the Factory overview opens
//! a project whose Neovim, terminal tabs, tree listings and git run where the session's Workspace
//! is, through the argv `abe workspace attach-spec` gave (the bridge's `open-project` `attach`).
//! Rust only changes how it spawns, never decides where. One seam each:
//!
//! - Neovim: [`crate::nvim::NvimConfig::launch`] in place of the local `nvim --embed`.
//! - Terminal tabs: [`crate::terminal`]'s spawn takes [`Attach::shell`] (a program of its own goes
//!   through [`Attach::exec`]).
//! - Git: [`crate::git::command`], the one function every git run goes through.
//! - The Project tree's listing: [`list_dir`] behind [`crate::shell::tree`]'s.
//! - The pickers' preview: [`read_head`] behind [`crate::search::preview`]'s file read.
//!
//! The project's folder is the box's (`/workspace/repo`): a folder registered here ([`register`])
//! sends every read under it through its attach.
//!
//! Its link (`link.rs`): the editor slot's state while its Neovim wakes or connects, and what the
//! status bar says of it.

mod link;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};

use gpui_kit::{App, AppContext as _, Task};

pub use link::{Ended, TRIES};
pub(crate) use link::{LinkState, ROUND_TRIP_EVERY, RemoteLink, Tried, remote_state};
use serde::Deserialize;

/// What runs a cloud workspace (the `open-project` effect's `attach`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Attach {
    /// Starts an embedded Neovim on stdio; the app adds its `--cmd` and the files to open.
    pub nvim: Vec<String>,
    /// Starts a terminal tab's shell.
    pub shell: Vec<String>,
    /// Put before a command (`git …`, a folder's listing) to run it on the box.
    pub exec: Vec<String>,
    /// The Workspace's box, for the status bar's hover.
    #[serde(rename = "box")]
    pub box_: BoxInfo,
    /// The box is not known to run: RemoteState says Waking until Neovim answers.
    pub waking: bool,
    /// What RemoteState's Download locally (⌘⏎) clicks in the bridge once connecting failed
    /// (`abe session download`); none, the button is grey.
    #[serde(default)]
    pub download: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct BoxInfo {
    pub name: String,
    pub region: Option<String>,
}

static ROOTS: RwLock<Vec<(PathBuf, Arc<Attach>)>> = RwLock::new(Vec::new());

/// Every read under `root` goes through `attach` from now on.
pub fn register(root: &Path, attach: Arc<Attach>) {
    let mut roots = ROOTS.write().unwrap_or_else(|e| e.into_inner());
    roots.retain(|(r, _)| r != root);
    roots.push((root.to_path_buf(), attach));
}

/// `root` is a plain local folder again (its project closed).
pub fn unregister(root: &Path) {
    ROOTS
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(r, _)| r != root);
}

/// The registered root `path` lies in, with its attach.
pub fn attach_for(path: &Path) -> Option<(PathBuf, Arc<Attach>)> {
    ROOTS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(r, _)| path.starts_with(r))
        .max_by_key(|(r, _)| r.as_os_str().len())
        .cloned()
}

/// The exec prefix for a command about `path`, when it lies in a cloud workspace.
pub fn exec_for(path: &Path) -> Option<Vec<String>> {
    attach_for(path).map(|(_, a)| a.exec.clone())
}

/// `argv` as a command (its first word the program).
pub fn command(argv: &[String]) -> Option<Command> {
    let (program, args) = argv.split_first()?;
    let mut cmd = Command::new(program);
    cmd.args(args);
    Some(cmd)
}

/// Folders' entries as `sh` sees them there, in one call (each call is a round trip to the
/// box): `$1` how many folders at most, `$2` `walk` (each folder's subfolders listed after it,
/// breadth first; `node_modules` listed but not entered, `.git` neither) or `only`, `$3` how
/// many entries at most (no folder is begun past it), then the folders. Per folder `P <n> <path>\0` (the `n`th folder given, the path below it) then
/// `<kind> <name>\0` each, kind `d` folder, `f` file, `D` a link to a folder, `L` any other link;
/// `X <n> <path>\0` when it is no folder there. Its queue is a file read as it grows (`+` a
/// folder to enter, `-` one only listed).
const LIST: &str = r#"limit=$1 mode=$2 cap=$3
shift 3
q=$(mktemp) || exit 1
trap 'rm -f "$q"' EXIT
nl='
'
if [ "$mode" = walk ]; then go=+; else go=-; fi
i=0
for d in "$@"; do i=$((i + 1)); printf '%s%s \n' "$go" "$i"; done > "$q"
n=0 m=0
while [ "$n" -lt "$limit" ] && [ "$m" -lt "$cap" ] && IFS= read -r e; do
  n=$((n + 1))
  k=${e#?}; c=${e%"$k"}; i=${k%% *}; r=${k#* }
  eval "s=\${$i}"
  if ! cd -- "$s${r:+/$r}" 2>/dev/null; then printf 'X %s %s\0' "$i" "$r"; continue; fi
  printf 'P %s %s\0' "$i" "$r"
  for f in * .[!.]* ..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ]; then if [ -d "$f" ]; then t=D; else t=L; fi
    elif [ -d "$f" ]; then
      t=d
      if [ "$c" = + ]; then
        case $f in
          .git|*"$nl"*) ;;
          node_modules) printf -- '-%s %s\n' "$i" "${r:+$r/}$f" >> "$q" ;;
          *) printf '+%s %s\n' "$i" "${r:+$r/}$f" >> "$q" ;;
        esac
      fi
    else t=f; fi
    printf '%s %s\0' "$t" "$f"
    m=$((m + 1))
  done
done < "$q""#;

/// `rg` in a folder there: `$1` the folder, `$2` `scoped` (the root's `.fdignore` read too,
/// as [`crate::search`]'s walk does) or `all`, then rg's arguments. rg runs until it ends or this
/// script's input closes, which is how the Mac ends it: killing the Mac's process closes the ssh
/// channel, whose end here is only seen as the input closing (no signal reaches a command in
/// `docker exec` through it), so a reader of the input kills rg then. Exits with rg's code.
const RG: &str = r#"cd -- "$1" || exit 2
f=
if [ "$2" = scoped ] && [ -f .fdignore ]; then f=--ignore-file=.fdignore; fi
shift 2
exec 3<&0
rg $f "$@" </dev/null 3<&- &
p=$!
(while read -r _; do :; done; kill "$p" 2>/dev/null) <&3 >/dev/null 2>&1 &
w=$!
exec 3<&-
wait "$p"
s=$?
kill "$w" 2>/dev/null
exit "$s""#;

/// `rg <args>` in `dir` through `exec`, stdin, stdout and stderr piped. rg ends when it is
/// done or when the command's stdin closes (dropped, or the process killed): hold the stdin until
/// the output is read. `scoped`: the root's `.fdignore` applies (Alt+I off).
pub fn rg(exec: &[String], dir: &Path, scoped: bool, args: &[String]) -> Option<Command> {
    let mut argv = exec.to_vec();
    argv.extend([
        "sh".into(),
        "-c".into(),
        RG.into(),
        "sh".into(),
        dir.display().to_string(),
        if scoped { "scoped" } else { "all" }.into(),
    ]);
    argv.extend(args.iter().cloned());
    let mut cmd = command(&argv)?;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Some(cmd)
}

/// The first `limit` bytes of the file `path` there, in one call (blocking); None when it is no
/// readable file there or the box can't say.
pub fn read_head(exec: &[String], path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut argv = exec.to_vec();
    argv.extend([
        "head".into(),
        "-c".into(),
        limit.to_string(),
        "--".into(),
        path.display().to_string(),
    ]);
    output(&argv)
}

/// `argv`'s stdout once it ended well (blocking; no input, stderr dropped).
fn output(argv: &[String]) -> Option<Vec<u8>> {
    let out = command(argv)?
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// A listing call's entries at most: a walk that reached a `target/` or a `dist/` stops there.
const ENTRY_CAP: usize = 50_000;

/// A listed entry: its name, a folder (a link to one too), a link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    pub dir: bool,
    pub link: bool,
}

/// A folder's entries there; None: it is no folder there.
pub type Listing = (PathBuf, Option<Vec<Listed>>);

/// How [`list_dirs`] goes on from the folders it is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// Only those folders.
    Only,
    /// Their subfolders after them, breadth first, up to the limit (the tree's first walk).
    Walk,
}

/// Lists `dirs` through `exec` in one call (blocking), at most `limit` folders; None when the
/// box can't say (no answer, the call failed).
pub fn list_dirs(
    exec: &[String],
    dirs: &[PathBuf],
    reach: Reach,
    limit: usize,
) -> Option<Vec<Listing>> {
    let mut argv = exec.to_vec();
    argv.extend([
        "sh".into(),
        "-c".into(),
        LIST.into(),
        "sh".into(),
        limit.to_string(),
        match reach {
            Reach::Only => "only".into(),
            Reach::Walk => "walk".into(),
        },
        ENTRY_CAP.to_string(),
    ]);
    argv.extend(dirs.iter().map(|d| d.display().to_string()));
    Some(parse_listings(&output(&argv)?, dirs))
}

/// Lists `dir` through `exec` (blocking); None when it is no folder there or the box can't say.
pub fn list_dir(exec: &[String], dir: &Path) -> Option<Vec<Listed>> {
    list_dirs(exec, &[dir.to_path_buf()], Reach::Only, 1)?
        .into_iter()
        .next()
        .and_then(|(_, v)| v)
}

/// The script's records, each folder named below the folder of `dirs` it came from (never by
/// what the box printed of it: a path there is read as given here).
fn parse_listings(bytes: &[u8], dirs: &[PathBuf]) -> Vec<Listing> {
    let mut out: Vec<Listing> = Vec::new();
    let folder = |rest: &str| {
        let (n, below) = rest.split_once(' ')?;
        let start = dirs.get(n.parse::<usize>().ok()?.checked_sub(1)?)?;
        Some(if below.is_empty() {
            start.clone()
        } else {
            start.join(below)
        })
    };
    // entries go to the folder record before them (none after one that names no folder here)
    let mut into = false;
    for rec in bytes.split(|b| *b == 0) {
        let rec = String::from_utf8_lossy(rec);
        let Some((kind, name)) = rec.split_once(' ') else {
            continue;
        };
        let (dir, link) = match kind {
            "P" | "X" => {
                let d = folder(name);
                into = kind == "P" && d.is_some();
                if let Some(d) = d {
                    out.push((d, (kind == "P").then(Vec::new)));
                }
                continue;
            }
            "d" => (true, false),
            "f" => (false, false),
            "D" => (true, true),
            "L" => (false, true),
            _ => continue,
        };
        if let Some((_, Some(entries))) = out.last_mut().filter(|_| into) {
            entries.push(Listed {
                name: name.to_owned(),
                dir,
                link,
            });
        }
    }
    out
}

/// Runs `job` off the UI thread. A cloud workspace's (a round trip to its box, seconds
/// while it connects) on a thread of its own: GPUI's background executor runs its tasks on the
/// UI's own thread in a test window (inside `run_until_parked`), where one such call held the
/// window for its whole length, and in the app it would hold one of the executor's threads. A
/// plain folder's on the background executor. A thread per job: calls to a box are a handful at
/// a time. None: `job` panicked.
pub fn background<R: Send + 'static>(
    path: &Path,
    cx: &App,
    job: impl FnOnce() -> R + Send + 'static,
) -> Task<Option<R>> {
    if attach_for(path).is_none() {
        return cx.background_spawn(async move { Some(job()) });
    }
    on_thread(cx, job)
}

/// [`background`] for a job that names no folder (the Git tool window's): on a thread of its own
/// while any cloud workspace is open, as it may be that one's.
pub fn background_any<R: Send + 'static>(
    cx: &App,
    job: impl FnOnce() -> R + Send + 'static,
) -> Task<Option<R>> {
    let any = !ROOTS.read().unwrap_or_else(|e| e.into_inner()).is_empty();
    if !any {
        return cx.background_spawn(async move { Some(job()) });
    }
    on_thread(cx, job)
}

fn on_thread<R: Send + 'static>(
    cx: &App,
    job: impl FnOnce() -> R + Send + 'static,
) -> Task<Option<R>> {
    let (tx, rx) = futures::channel::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("remote-exec".into())
        .spawn(move || {
            let _ = tx.send(job());
        });
    if spawned.is_err() {
        return Task::ready(None);
    }
    cx.background_spawn(async move { rx.await.ok() })
}

/// The status bar's words for the link, and its hover.
pub fn hover(a: &Attach, round_trip: Option<std::time::Duration>) -> String {
    let mut parts = vec![
        "Attached to your cloud environment".to_owned(),
        a.box_.name.clone(),
    ];
    if let Some(r) = &a.box_.region {
        parts.push(r.clone());
    }
    if let Some(t) = round_trip {
        parts.push(format!("{} ms round trip", t.as_millis()));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_reads_kinds_and_names_with_spaces() {
        let got = parse_listings(
            b"P 1 \0d src\0f a b.ts\0D .scratch\0L x\0X 1 gone\0P 1 src\0P 9 nope\0f lost\0",
            &[PathBuf::from("/r")],
        );
        assert_eq!(got.len(), 3);
        assert_eq!(got[1], (PathBuf::from("/r/gone"), None));
        assert_eq!(got[2], (PathBuf::from("/r/src"), Some(vec![])));
        assert_eq!(got[0].0, PathBuf::from("/r"));
        assert_eq!(
            got[0].1.clone().unwrap(),
            vec![
                Listed {
                    name: "src".into(),
                    dir: true,
                    link: false
                },
                Listed {
                    name: "a b.ts".into(),
                    dir: false,
                    link: false
                },
                Listed {
                    name: ".scratch".into(),
                    dir: true,
                    link: true
                },
                Listed {
                    name: "x".into(),
                    dir: false,
                    link: true
                },
            ]
        );
    }

    #[test]
    fn the_listing_script_walks_breadth_first_up_to_its_limit_or_lists_the_folders_given() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        for f in ["src/a/b", "src/c", "docs", "node_modules/x", ".git/objects"] {
            std::fs::create_dir_all(r.join(f)).unwrap();
        }
        std::fs::write(r.join("src/a/b/deep.ts"), "").unwrap();
        std::fs::write(r.join("README.md"), "").unwrap();
        let walked = list_dirs(&[], std::slice::from_ref(&r), Reach::Walk, 100).unwrap();
        let dirs: Vec<_> = walked
            .iter()
            .map(|(p, _)| p.strip_prefix(&r).unwrap().display().to_string())
            .collect();
        // breadth first; node_modules listed but not entered, .git neither
        assert_eq!(
            dirs,
            [
                "",
                "docs",
                "node_modules",
                "src",
                "src/a",
                "src/c",
                "src/a/b"
            ]
        );
        let modules = walked[2].1.as_ref().unwrap();
        assert_eq!(modules[0].name, "x");
        let root: Vec<_> = walked[0]
            .1
            .as_ref()
            .unwrap()
            .iter()
            .map(|l| l.name.as_str())
            .collect();
        assert!(root.contains(&"node_modules") && root.contains(&".git"));
        assert_eq!(
            walked[6].1.as_ref().unwrap()[0].name,
            "deep.ts",
            "{walked:?}"
        );
        // the limit: the nearest folders first
        let some = list_dirs(&[], std::slice::from_ref(&r), Reach::Walk, 3).unwrap();
        assert_eq!(some.len(), 3);
        // only the folders given, a gone one said so
        let only = list_dirs(&[], &[r.join("src"), r.join("nope")], Reach::Only, 9).unwrap();
        assert_eq!(only.len(), 2);
        assert_eq!(only[1], (r.join("nope"), None));
        assert_eq!(only[0].1.as_ref().unwrap().len(), 2);
        // one folder: kinds, a link to a folder and names with spaces, from the script run here
        let one = tempfile::tempdir().unwrap();
        std::fs::create_dir(one.path().join("src")).unwrap();
        std::fs::write(one.path().join(".env"), "").unwrap();
        std::fs::write(one.path().join("a b.ts"), "").unwrap();
        std::os::unix::fs::symlink("src", one.path().join("lnk")).unwrap();
        let mut got = list_dir(&[], one.path()).unwrap();
        got.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<_> = got
            .iter()
            .map(|l| (l.name.as_str(), l.dir, l.link))
            .collect();
        assert_eq!(
            names,
            [
                (".env", false, false),
                ("a b.ts", false, false),
                ("lnk", true, true),
                ("src", true, false)
            ]
        );
        assert_eq!(list_dir(&[], &one.path().join("nope")), None);
    }

    #[test]
    fn rg_there_ends_when_its_input_closes_and_keeps_its_exit_code() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("repo");
        std::fs::create_dir(&r).unwrap();
        std::fs::write(r.join("a.txt"), "needle\n").unwrap();
        std::fs::write(r.join("b.tmp"), "needle\n").unwrap();
        std::fs::write(r.join(".fdignore"), "*.tmp\n").unwrap();
        // the box's rg that would go on (a search still running)
        let bin = d.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let pid = d.path().join("rg.pid");
        std::fs::write(
            bin.join("rg"),
            format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n", pid.display()),
        )
        .unwrap();
        Command::new("chmod")
            .arg("+x")
            .arg(bin.join("rg"))
            .status()
            .unwrap();
        let path = std::env::var("PATH").unwrap();
        // this Mac's sh (bash), and dash (a Linux box's sh) where there is one
        let mut shells = vec![None];
        if Path::new("/bin/dash").exists() {
            let dash = d.path().join("dash");
            std::fs::create_dir(&dash).unwrap();
            std::os::unix::fs::symlink("/bin/dash", dash.join("sh")).unwrap();
            shells.push(Some(dash));
        }
        for shell in shells {
            let via = |extra: Option<&Path>| {
                let dirs: Vec<String> = [shell.as_deref(), extra]
                    .into_iter()
                    .flatten()
                    .map(|p| p.display().to_string())
                    .chain([path.clone()])
                    .collect();
                vec!["env".to_owned(), format!("PATH={}", dirs.join(":"))]
            };
            let run = |scoped: bool, args: &[&str]| {
                let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
                let mut child = rg(&via(None), &r, scoped, &args).unwrap().spawn().unwrap();
                // held while it runs: its closing ends rg
                let input = child.stdin.take();
                let out = child.wait_with_output().unwrap();
                drop(input);
                out
            };
            let out = run(true, &["--files"]);
            assert_eq!(String::from_utf8_lossy(&out.stdout), "a.txt\n", "{shell:?}");
            let out = run(false, &["--files", "--sort=path"]);
            assert_eq!(String::from_utf8_lossy(&out.stdout), "a.txt\nb.tmp\n");
            assert_eq!(run(true, &["zzz"]).status.code(), Some(1));
            assert_eq!(run(true, &["(x"]).status.code(), Some(2));
            // its input closed: rg is gone and the script ends
            let _ = std::fs::remove_file(&pid);
            let mut child = rg(&via(Some(&bin)), &r, true, &["x".into()])
                .unwrap()
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let t = std::time::Instant::now();
            while std::fs::read_to_string(&pid).map_or(true, |p| p.trim().is_empty()) {
                assert!(
                    t.elapsed() < std::time::Duration::from_secs(5),
                    "rg started"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            drop(child.stdin.take());
            let t = std::time::Instant::now();
            let status = child.wait().unwrap();
            assert!(t.elapsed() < std::time::Duration::from_secs(5));
            assert!(!status.success());
            let rg_pid = std::fs::read_to_string(&pid).unwrap();
            let alive = Command::new("kill")
                .args(["-0", rg_pid.trim()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(!alive, "rg killed ({shell:?})");
        }
    }

    #[test]
    fn a_path_finds_the_root_it_lies_in() {
        let a = Arc::new(Attach {
            nvim: vec!["x".into()],
            shell: vec!["x".into()],
            exec: vec!["via".into()],
            box_: BoxInfo {
                name: "b".into(),
                region: None,
            },
            waking: false,
            download: None,
        });
        let root = Path::new("/remote-test/registry/repo");
        register(root, a);
        assert_eq!(
            exec_for(&root.join("src/x.ts")),
            Some(vec!["via".to_owned()])
        );
        assert_eq!(exec_for(Path::new("/remote-test/registry/repo2")), None);
        unregister(root);
        assert_eq!(exec_for(root), None);
    }
}
