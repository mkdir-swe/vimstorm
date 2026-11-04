//! The `git` CLI runner every git feature shares (tree status colors, status bar
//! branch, branch popup, ...): `git -C
//! <dir> <args>` off the UI thread, output captured.

use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use gpui_kit::{App, AppContext as _, Task};
use parking_lot::Mutex;

/// What a git command printed and how it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    /// Exit code; None when killed by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout when the command succeeded, else an error with git's stderr.
    pub fn into_result(self) -> anyhow::Result<String> {
        if self.ok() {
            Ok(self.stdout)
        } else {
            Err(anyhow::anyhow!(
                "git exited with {:?}: {}",
                self.code,
                self.stderr.trim()
            ))
        }
    }
}

/// The command: `git -C <dir> -c core.quotepath=false <args>`, no pager / prompts, and no
/// optional locks so reads (status) never block a commit running in a terminal. In a cloud
/// workspace ([`crate::shell::remote`]) it runs on the box, after its exec prefix.
pub fn command<I, S>(dir: &Path, args: I) -> io::Result<Command>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<_> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    // a cloud workspace's: the same command on its box, its variables given there
    if let Some(mut cmd) =
        crate::shell::remote::exec_for(dir).and_then(|e| crate::shell::remote::command(&e))
    {
        cmd.args([
            "env",
            "GIT_OPTIONAL_LOCKS=0",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_PAGER=cat",
            "git",
            "-C",
        ])
        .arg(dir)
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .stdin(Stdio::null());
        return Ok(cmd);
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null());
    Ok(cmd)
}

/// Runs git and waits (a background thread / task only: never call this on the UI thread).
pub fn run_blocking<I, S>(dir: &Path, args: I) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = command(dir, args)?.output()?;
    Ok(Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs git off the UI thread (GPUI's background executor; a cloud workspace's on a thread of
/// its own); await the task from the UI (`cx.spawn`).
pub fn run<I, S>(dir: impl Into<PathBuf>, args: I, cx: &App) -> Task<io::Result<Output>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let dir = dir.into();
    let args: Vec<_> = args
        .into_iter()
        .map(|a| a.as_ref().to_os_string())
        .collect();
    let job = crate::shell::remote::background(&dir.clone(), cx, move || run_blocking(&dir, args));
    cx.background_spawn(async move {
        job.await
            .unwrap_or_else(|| Err(io::Error::other("git's thread ended without an answer")))
    })
}

/// The work tree's root for `dir` (`rev-parse --show-toplevel`), None outside a repo. Blocking.
pub fn repo_root_blocking(dir: &Path) -> Option<PathBuf> {
    let out = run_blocking(dir, ["rev-parse", "--show-toplevel"]).ok()?;
    out.ok().then(|| PathBuf::from(out.stdout.trim_end()))
}

/// Stops git commands started with it: `cancel()` kills the running ones (their output ends,
/// they return `Interrupted`) and makes later ones fail at once. Clones share the state. A load
/// gets one; the UI cancels it when a newer load replaces it (or just drops the result).
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    running: Mutex<Vec<(u64, Child)>>,
    next_id: AtomicU64,
}

/// A spawned child's pipes; the child itself stays in its [`Cancel`] (killable) until `finish`.
struct Spawned {
    id: u64,
    stdout: ChildStdout,
    stderr: ChildStderr,
    stdin: Option<ChildStdin>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        for (_, child) in self.0.running.lock().iter_mut() {
            let _ = child.kill();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    fn interrupted() -> io::Error {
        io::Error::new(io::ErrorKind::Interrupted, "cancelled")
    }

    fn spawn(&self, mut cmd: Command, stdin: bool) -> io::Result<Spawned> {
        let mut running = self.0.running.lock();
        if self.is_cancelled() {
            return Err(Self::interrupted());
        }
        if stdin {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let s = Spawned {
            id: self.0.next_id.fetch_add(1, Ordering::SeqCst),
            stdout: child.stdout.take().expect("piped stdout"),
            stderr: child.stderr.take().expect("piped stderr"),
            stdin: child.stdin.take(),
        };
        running.push((s.id, child));
        Ok(s)
    }

    fn kill(&self, id: u64) {
        if let Some((_, c)) = self.0.running.lock().iter_mut().find(|(c, _)| *c == id) {
            let _ = c.kill();
        }
    }

    /// Waits for child `id` (pipes drained first); Interrupted when cancelled meanwhile.
    fn finish(&self, id: u64) -> io::Result<Option<i32>> {
        let child = {
            let mut running = self.0.running.lock();
            let i = running.iter().position(|(cid, _)| *cid == id);
            i.map(|i| running.swap_remove(i).1)
        };
        let status = match child {
            Some(mut c) => c.wait()?,
            None => return Err(Self::interrupted()),
        };
        if self.is_cancelled() {
            return Err(Self::interrupted());
        }
        Ok(status.code())
    }
}

/// Reads a pipe to the end on its own thread (stderr while stdout is read: neither fills up).
fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    })
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// [`run_blocking`] that `cancel` can stop (git is killed), with optional `stdin` text
/// (`blame --contents -`). Blocking: background tasks only.
pub fn run_cancellable<I, S>(
    dir: &Path,
    args: I,
    stdin: Option<&str>,
    cancel: &Cancel,
) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let Spawned {
        id,
        mut stdout,
        stderr,
        stdin: pipe,
    } = cancel.spawn(command(dir, args)?, stdin.is_some())?;
    let writer = match (pipe, stdin) {
        (Some(mut pipe), Some(input)) => {
            let input = input.to_owned();
            Some(std::thread::spawn(move || {
                let _ = pipe.write_all(input.as_bytes());
            }))
        }
        _ => None,
    };
    let err = drain(stderr);
    let mut out = Vec::new();
    let _ = stdout.read_to_end(&mut out);
    let err = err.join().unwrap_or_default();
    if let Some(w) = writer {
        let _ = w.join();
    }
    let code = cancel.finish(id)?;
    Ok(Output {
        code,
        stdout: text(&out),
        stderr: text(&err),
    })
}

/// Runs git and hands each stdout line (without its `\n`) to `line` as it arrives (the log's
/// first screen shows while git still walks history); `line` returns false to stop early (git
/// is killed, the result is Ok with code None). `cancel` stops it too (Err Interrupted).
/// Returns the exit code and stderr.
pub fn run_lines<I, S>(
    dir: &Path,
    args: I,
    cancel: &Cancel,
    mut line: impl FnMut(&str) -> bool,
) -> io::Result<(Option<i32>, String)>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let s = cancel.spawn(command(dir, args)?, false)?;
    let err = drain(s.stderr);
    let mut reader = BufReader::with_capacity(1 << 16, s.stdout);
    let mut buf = Vec::with_capacity(256);
    let mut stopped = false;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        if cancel.is_cancelled() || !line(&String::from_utf8_lossy(&buf)) {
            stopped = true;
            break;
        }
    }
    if stopped {
        cancel.kill(s.id);
    }
    drop(reader);
    let stderr = text(&err.join().unwrap_or_default());
    match cancel.finish(s.id) {
        Ok(code) => Ok((if stopped { None } else { code }, stderr)),
        Err(e) => Err(e),
    }
}

/// Runs git (push / pull / fetch with `--progress`) and hands each progress line of stderr
/// ("Receiving objects:  45% (9/20)", split at `\r` / `\n`) to `progress` as it comes.
pub fn run_with_progress<I, S>(
    dir: &Path,
    args: I,
    cancel: &Cancel,
    mut progress: impl FnMut(&str),
) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let s = cancel.spawn(command(dir, args)?, false)?;
    let out = drain(s.stdout);
    let mut err = s.stderr;
    let mut stderr = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut line = Vec::new();
    loop {
        let n = match err.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        stderr.extend_from_slice(&chunk[..n]);
        for &b in &chunk[..n] {
            if b == b'\r' || b == b'\n' {
                let l = String::from_utf8_lossy(&line);
                if !l.trim().is_empty() {
                    progress(l.trim());
                }
                line.clear();
            } else {
                line.push(b);
            }
        }
    }
    let stdout = out.join().unwrap_or_default();
    let code = cancel.finish(s.id)?;
    Ok(Output {
        code,
        stdout: text(&stdout),
        // each progress line's last state only (git redraws them with \r)
        stderr: clean_progress(&text(&stderr)),
    })
}

/// stderr with `\r`-redrawn progress lines reduced to their last state.
pub fn clean_progress(s: &str) -> String {
    s.split('\n')
        .map(|l| l.rsplit('\r').find(|p| !p.trim().is_empty()).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The user-facing error of a failed command (`git/cli.lua` act: stderr, else stdout, trimmed).
pub fn error_text(out: &Output) -> String {
    let err = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    err.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
        ] {
            assert!(run_blocking(dir.path(), args).unwrap().ok());
        }
        dir
    }

    #[test]
    fn captures_stdout_stderr_and_status() {
        let dir = repo();
        std::fs::write(dir.path().join("ä.txt"), "x").unwrap();
        let out = run_blocking(dir.path(), ["status", "--porcelain"]).unwrap();
        assert!(out.ok());
        // core.quotepath=false: non-ASCII names come through as is
        assert_eq!(out.stdout, "?? ä.txt\n");

        let out = run_blocking(dir.path(), ["checkout", "nope"]).unwrap();
        assert!(!out.ok());
        assert!(out.stderr.contains("nope"), "{out:?}");
        assert!(out.into_result().is_err());
    }

    #[test]
    fn repo_root() {
        let dir = repo();
        let sub = dir.path().join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        let root = repo_root_blocking(&sub).unwrap();
        assert_eq!(
            root.canonicalize().unwrap(),
            dir.path().canonicalize().unwrap()
        );
        let outside = tempfile::tempdir().unwrap();
        assert_eq!(repo_root_blocking(outside.path()), None);
    }

    #[test]
    fn streams_lines_and_stops_early() {
        let dir = repo();
        for i in 0..5 {
            std::fs::write(dir.path().join("f"), i.to_string()).unwrap();
            run_blocking(dir.path(), ["add", "f"]).unwrap();
            run_blocking(dir.path(), ["commit", "-q", "-m", &format!("c{i}")]).unwrap();
        }
        let cancel = Cancel::new();
        let mut got = Vec::new();
        let (code, _) = run_lines(dir.path(), ["log", "--format=%s"], &cancel, |l| {
            got.push(l.to_owned());
            true
        })
        .unwrap();
        assert_eq!(code, Some(0));
        assert_eq!(got, ["c4", "c3", "c2", "c1", "c0"]);
        let mut n = 0;
        let (code, _) = run_lines(dir.path(), ["log", "--format=%s"], &cancel, |_| {
            n += 1;
            n < 2
        })
        .unwrap();
        assert_eq!((code, n), (None, 2));
        // stdin, then a cancelled token refuses to run
        let out =
            run_cancellable(dir.path(), ["hash-object", "--stdin"], Some("x\n"), &cancel).unwrap();
        assert_eq!(
            out.stdout.trim(),
            "587be6b4c3f93f93c489c0111bba5596147a26cb"
        );
        cancel.cancel();
        let err = run_cancellable(dir.path(), ["status"], None, &cancel).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
        assert!(run_lines(dir.path(), ["log"], &cancel, |_| true).is_err());
    }

    #[test]
    fn progress_lines() {
        assert_eq!(
            clean_progress("Counting: 1%\rCounting: 100%, done.\nTo x\n"),
            "Counting: 100%, done.\nTo x\n"
        );
        let out = Output {
            code: Some(1),
            stdout: "out".into(),
            stderr: " \n".into(),
        };
        assert_eq!(error_text(&out), "out");
    }

    #[test]
    fn runs_on_the_background_executor() {
        let dir = repo();
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(0), None);
        let task = cx.update(|cx| run(dir.path(), ["branch", "--show-current"], cx));
        // the test dispatcher runs background work when parked
        cx.run_until_parked();
        let out = futures::FutureExt::now_or_never(task)
            .expect("git finished")
            .unwrap();
        assert_eq!(out.stdout.trim(), "main");
    }
}
