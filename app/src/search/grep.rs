//! Find in Files over ripgrep, streamed off the UI thread.
//!
//! Native: the project scope's globs ([`crate::search::scope`] `rg_globs`) + own flags (`rg --json
//! --smart-case --no-hidden --glob=!.git --glob=!.bare -- <pattern>`, cwd = project root). Results arrive in batches on an async channel;
//! dropping the [`Search`] kills rg. A cloud workspace's rg runs on its box through
//! [`crate::shell::remote::rg`], ended by its input closing.

use std::io::{BufRead, BufReader, Read};
use std::ops::Range;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use parking_lot::Mutex;

use super::json::{self, Json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrepMatch {
    /// Relative to the project root, `/`-separated.
    pub path: Arc<str>,
    /// 1-based.
    pub line: u32,
    /// The line without its trailing `\r\n`; cut to ~[`MAX_LINE_CHARS`] around the first match.
    pub text: String,
    /// Byte ranges of the submatches in `text`.
    pub ranges: Vec<Range<usize>>,
    /// Byte offset of the first submatch in the whole line (`text` may be cut: long lines), for
    /// putting the caret there.
    pub col: usize,
}

#[derive(Debug)]
pub enum Batch {
    Matches(Vec<GrepMatch>),
    /// Always the last message. `error` is rg's first stderr line when it exited with 2 (e.g. a bad
    /// regex); matches found before an error (e.g. an unreadable file) were still sent.
    Done {
        total: usize,
        truncated: bool,
        error: Option<String>,
    },
}

/// A running search. Dropping it kills rg; the worker threads then exit on their own.
pub struct Search {
    pub rx: UnboundedReceiver<Batch>,
    child: Arc<Mutex<Option<Child>>>,
    #[cfg(test)]
    exited: Arc<AtomicBool>,
}

impl Drop for Search {
    fn drop(&mut self) {
        // the reader then hits EOF on stdout and reaps the child itself (no wait on the UI thread)
        if let Some(child) = self.child.lock().as_mut() {
            end(child);
        }
    }
}

/// Ends rg: a cloud workspace's first by closing its input (what ends it on the box).
fn end(child: &mut Child) {
    drop(child.stdin.take());
    let _ = child.kill();
}

/// Lines longer than this (in chars) are cut to a window around the first match.
pub const MAX_LINE_CHARS: usize = 500;
/// Chars kept before the first match when a line is cut.
const LEAD_CHARS: usize = 100;
const BATCH_LEN: usize = 64;
const BATCH_INTERVAL: Duration = Duration::from_millis(16);

/// The Find in Files toggles: WebStorm's Cc / W / .* and snacks' Alt+H / Alt+I / Alt+F. Default =
/// the M4 snacks grep: smart case, regex, no hidden / ignored files, symlinks not followed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Options {
    /// Match case (Cc); off = smart case.
    pub case: bool,
    /// Whole words (W).
    pub words: bool,
    /// Regex (.*); off = the text as is.
    pub regex: bool,
    /// Hidden files too (snacks `hidden`).
    pub hidden: bool,
    /// Ignored files too (snacks `ignored`).
    pub ignored: bool,
    /// Follow symlinks (snacks `follow`).
    pub follow: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            case: false,
            words: false,
            regex: true,
            hidden: false,
            ignored: false,
            follow: false,
        }
    }
}

#[cfg(test)]
pub fn search(root: &Path, pattern: &str, max: usize) -> Search {
    search_with(root, pattern, max, Options::default(), &[], &[], &[])
}

/// [`search`] with the toggles, in `dirs` only when given (Find in Folder; relative to `root` or
/// absolute). `mask` = Find in Files' file mask as rg args (`--glob=*.ts`), kept with `ignored`;
/// `excludes` = the project scope's rg globs ([`crate::search::scope::Exclusions::rg_globs`]), dropped
/// with `ignored` (Alt+I) like the ignore files.
pub fn search_with(
    root: &Path,
    pattern: &str,
    max: usize,
    opts: Options,
    dirs: &[std::path::PathBuf],
    mask: &[String],
    excludes: &[String],
) -> Search {
    let (tx, rx) = unbounded();
    let child = Arc::new(Mutex::new(None));
    let exited = Arc::new(AtomicBool::new(false));
    let search = Search {
        rx,
        child: child.clone(),
        #[cfg(test)]
        exited: exited.clone(),
    };
    let done = |error: Option<String>| Batch::Done {
        total: 0,
        truncated: false,
        error,
    };
    if pattern.is_empty() {
        let _ = tx.unbounded_send(done(None));
        exited.store(true, Ordering::Release);
        return search;
    }

    let mut args: Vec<&str> = vec![
        "--json",
        if opts.case {
            "--case-sensitive"
        } else {
            "--smart-case"
        },
        if opts.hidden {
            "--hidden"
        } else {
            "--no-hidden"
        },
        // rg block-buffers a pipe: without this the first results wait for 8 KiB of output
        "--line-buffered",
    ];
    let never = crate::search::scope::rg_never();
    args.extend(never.iter().map(String::as_str));
    // before the excludes: a later glob wins, so an excluded folder stays out of a `*.ts` mask
    args.extend(mask.iter().map(String::as_str));
    if opts.words {
        args.push("--word-regexp");
    }
    if !opts.regex {
        args.push("--fixed-strings");
    }
    if opts.ignored {
        args.push("--no-ignore");
    } else {
        // one glob per exclusion: a few dozen at most in real `.iml`s, far below ARG_MAX (1 MiB)
        args.extend(excludes.iter().map(String::as_str));
    }
    if opts.follow {
        args.push("-L");
    }
    args.extend(["--", pattern]);
    let spawned = match crate::shell::remote::exec_for(root) {
        // a cloud workspace's on its box: its folder is no folder here
        Some(exec) => {
            let mut argv: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
            argv.extend(dirs.iter().map(|d| d.display().to_string()));
            crate::shell::remote::rg(&exec, root, !opts.ignored, &argv)
                .ok_or_else(|| std::io::Error::other("no exec prefix"))
                .and_then(|mut c| c.spawn())
        }
        None => Command::new("rg")
            .args(args)
            .args(dirs)
            .current_dir(root)
            // rg searches stdin instead of cwd when stdin is a readable pipe/file
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn(),
    };
    let mut proc = match spawned {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.unbounded_send(done(Some(format!("rg: {e}"))));
            exited.store(true, Ordering::Release);
            return search;
        }
    };
    let (Some(stdout), Some(stderr)) = (proc.stdout.take(), proc.stderr.take()) else {
        unreachable!("stdout and stderr are piped");
    };
    *child.lock() = Some(proc);

    // stderr drains on its own thread so a chatty rg can never block on a full pipe
    let stderr_thread = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr)
            .take(64 * 1024)
            .read_to_string(&mut text);
        text.lines()
            .find(|l| !l.trim().is_empty())
            .map(str::to_owned)
    });

    // reader -> batcher: the batcher can flush on a timer while the reader blocks on the pipe
    let (mtx, mrx) = mpsc::channel::<Msg>();
    thread::spawn(move || batcher(mrx, tx));
    thread::spawn(move || {
        let (total, truncated) = read_matches(stdout, max, &mtx, &child);
        // after EOF rg has exited or is about to: reap it (fast), then report
        let taken = child.lock().take();
        let status = taken.and_then(|mut c| c.wait().ok());
        let first_err = stderr_thread.join().ok().flatten();
        let error = match status.and_then(|s| s.code()) {
            // 255: a cloud workspace's box was not reached (ssh's code)
            Some(2 | 255) if !truncated => Some(first_err.unwrap_or_else(|| "rg failed".into())),
            _ => None,
        };
        let _ = mtx.send(Msg::Done {
            total,
            truncated,
            error,
        });
        exited.store(true, Ordering::Release);
    });
    search
}

enum Msg {
    Match(GrepMatch),
    Done {
        total: usize,
        truncated: bool,
        error: Option<String>,
    },
}

/// Parses rg's JSON lines until EOF, `max + 1` matches (kills rg: truncated) or the batcher is gone
/// (the `Search` was dropped). Returns (matches sent, truncated).
fn read_matches(
    stdout: impl Read,
    max: usize,
    out: &mpsc::Sender<Msg>,
    child: &Mutex<Option<Child>>,
) -> (usize, bool) {
    let kill = || {
        if let Some(c) = child.lock().as_mut() {
            end(c);
        }
    };
    let mut total = 0;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return (total, false),
            Ok(_) => {}
        }
        // cheap prefilter: skip begin/end/context/summary lines without parsing them
        if !line.starts_with(r#"{"type":"match""#) {
            continue;
        }
        let Some(m) = json::parse(line.trim_end())
            .ok()
            .and_then(|v| parse_match(&v))
        else {
            continue;
        };
        if total == max {
            kill();
            return (total, true);
        }
        if out.send(Msg::Match(m)).is_err() {
            kill();
            return (total, false);
        }
        total += 1;
    }
}

/// Forwards matches in batches: the first one at once (first paint), then every `BATCH_LEN`
/// matches or `BATCH_INTERVAL`, whichever comes first.
fn batcher(rx: mpsc::Receiver<Msg>, tx: UnboundedSender<Batch>) {
    let mut pending = Vec::new();
    let mut sent_any = false;
    let mut last_send = Instant::now();
    loop {
        let msg = if pending.is_empty() {
            rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        } else {
            rx.recv_timeout(BATCH_INTERVAL.saturating_sub(last_send.elapsed()))
        };
        let flush = match msg {
            Ok(Msg::Match(m)) => {
                pending.push(m);
                !sent_any || pending.len() >= BATCH_LEN || last_send.elapsed() >= BATCH_INTERVAL
            }
            Ok(Msg::Done {
                total,
                truncated,
                error,
            }) => {
                if !pending.is_empty() {
                    let _ = tx.unbounded_send(Batch::Matches(std::mem::take(&mut pending)));
                }
                let _ = tx.unbounded_send(Batch::Done {
                    total,
                    truncated,
                    error,
                });
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => true,
            // reader died without Done (panic): nothing more will come
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        if flush && !pending.is_empty() {
            if tx
                .unbounded_send(Batch::Matches(std::mem::take(&mut pending)))
                .is_err()
            {
                // receiver dropped: returning drops `rx`, so the reader's next send fails and it
                // kills rg
                return;
            }
            sent_any = true;
            last_send = Instant::now();
        }
    }
}

/// `{"text": ..}` or `{"bytes": base64}`; bytes that aren't UTF-8 are skipped (can't be shown or
/// opened by path faithfully).
fn text_or_bytes(v: &Json) -> Option<String> {
    if let Some(t) = v.get("text").and_then(Json::as_str) {
        return Some(t.to_owned());
    }
    let bytes = base64_decode(v.get("bytes")?.as_str()?)?;
    String::from_utf8(bytes).ok()
}

fn parse_match(v: &Json) -> Option<GrepMatch> {
    let data = v.get("data")?;
    let path = text_or_bytes(data.get("path")?)?;
    let path = path.strip_prefix("./").unwrap_or(&path).replace('\\', "/");
    let mut text = text_or_bytes(data.get("lines")?)?;
    let line = data.get("line_number")?.as_f64()? as u32;
    if text.ends_with('\n') {
        text.pop();
    }
    if text.ends_with('\r') {
        text.pop();
    }
    let mut ranges: Vec<Range<usize>> = data
        .get("submatches")?
        .as_array()?
        .iter()
        .filter_map(|sm| {
            let start = sm.get("start")?.as_f64()? as usize;
            let end = (sm.get("end")?.as_f64()? as usize).min(text.len());
            (start < end && text.is_char_boundary(start) && text.is_char_boundary(end))
                .then_some(start..end)
        })
        .collect();
    let col = ranges.first().map_or(0, |r| r.start);
    clip_long_line(&mut text, &mut ranges);
    Some(GrepMatch {
        path: path.into(),
        line,
        text,
        ranges,
        col,
    })
}

/// Keeps at most `MAX_LINE_CHARS` chars of a long line, starting `LEAD_CHARS` before the first
/// match, so minified files don't flood the list; ranges are shifted and clipped to the window.
fn clip_long_line(text: &mut String, ranges: &mut Vec<Range<usize>>) {
    // bytes >= chars, so a short byte length means nothing to do (the common case)
    if text.len() <= MAX_LINE_CHARS || text.chars().count() <= MAX_LINE_CHARS {
        return;
    }
    let first = ranges.first().map_or(0, |r| r.start);
    let start = text[..first]
        .char_indices()
        .rev()
        .nth(LEAD_CHARS - 1)
        .map_or(0, |(i, _)| i);
    let end = text[start..]
        .char_indices()
        .nth(MAX_LINE_CHARS)
        .map_or(text.len(), |(i, _)| start + i);
    text.truncate(end);
    text.drain(..start);
    ranges.retain_mut(|r| {
        r.start = r.start.max(start) - start;
        r.end = r.end.min(end).saturating_sub(start);
        r.start < r.end
    });
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        match chunk.len() {
            4 => out.extend_from_slice(&bytes[1..4]),
            3 => out.extend_from_slice(&bytes[1..3]),
            2 => out.push(bytes[1]),
            _ => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use futures::executor::block_on;
    use std::fs;

    fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, body) in files {
            let p = dir.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        dir
    }

    /// All matches (sorted by path, line: rg's order is per-thread) and the Done fields.
    fn collect(mut s: Search) -> (Vec<GrepMatch>, usize, bool, Option<String>) {
        block_on(async {
            let mut all = Vec::new();
            while let Some(b) = s.rx.next().await {
                match b {
                    Batch::Matches(ms) => all.extend(ms),
                    Batch::Done {
                        total,
                        truncated,
                        error,
                    } => {
                        all.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
                        return (all, total, truncated, error);
                    }
                }
            }
            panic!("channel closed without Done");
        })
    }

    #[test]
    fn matches_lines_and_ranges() {
        let dir = project(&[
            ("src/a.rs", "fn main() {}\r\nlet x = main + main;\n"),
            ("b.txt", "nothing here\n"),
            ("c/ö.txt", "åäö main\n"),
        ]);
        let (ms, total, truncated, error) = collect(search(dir.path(), "main", 100));
        assert_eq!((total, truncated, error), (3, false, None));
        let got: Vec<String> = ms
            .iter()
            .map(|m| format!("{}:{}:{}:{:?}", m.path, m.line, m.text, m.ranges))
            .collect();
        assert_eq!(
            got,
            [
                "c/ö.txt:1:åäö main:[7..11]",
                "src/a.rs:1:fn main() {}:[3..7]",
                "src/a.rs:2:let x = main + main;:[8..12, 15..19]",
            ]
        );
    }

    const DEFAULT: Options = Options {
        case: false,
        words: false,
        regex: true,
        hidden: false,
        ignored: false,
        follow: false,
    };

    struct Find {
        name: &'static str,
        files: &'static [(&'static str, &'static str)],
        /// `git init` first, so rg reads `.gitignore`.
        git: bool,
        /// Pass the project scope's globs.
        scope: bool,
        opts: Options,
        pattern: &'static str,
        /// `path:line` of each match.
        want: &'static [&'static str],
        error: bool,
    }

    const SCOPED: &[(&str, &str)] = &[
        ("src/a.txt", "needle\n"),
        ("dist/b.txt", "needle\n"),
        ("node_modules/p/c.txt", "needle\n"),
        (
            ".idea/w.iml",
            "<excludeFolder url=\"file://$MODULE_DIR$/dist\" />\n",
        ),
    ];

    const FIND: &[Find] = &[
        Find {
            name: "a lower-case pattern ignores case",
            files: &[("a.txt", "Foo\nfoo\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "foo",
            want: &["a.txt:1", "a.txt:2"],
            error: false,
        },
        Find {
            name: "a capital makes it case-sensitive",
            files: &[("a.txt", "Foo\nfoo\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "Foo",
            want: &["a.txt:1"],
            error: false,
        },
        Find {
            name: "the pattern is a regex",
            files: &[("a.txt", "Foo\nfoo\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "^F.o$",
            want: &["a.txt:1"],
            error: false,
        },
        Find {
            name: "gitignored and hidden files are skipped",
            files: &[
                ("keep.txt", "needle\n"),
                ("ignored.txt", "needle\n"),
                (".hidden/x.txt", "needle\n"),
                (".dot.txt", "needle\n"),
                (".gitignore", "ignored.txt\n"),
            ],
            git: true,
            scope: false,
            opts: DEFAULT,
            pattern: "needle",
            want: &["keep.txt:1"],
            error: false,
        },
        Find {
            name: "the root .fdignore applies like in Go to File",
            files: &[
                ("a.txt", "needle\n"),
                ("b.tmp", "needle\n"),
                (".fdignore", "*.tmp\n"),
            ],
            git: false,
            scope: true,
            opts: DEFAULT,
            pattern: "needle",
            want: &["a.txt:1"],
            error: false,
        },
        Find {
            name: "the scope leaves out .iml excluded folders and node_modules",
            files: SCOPED,
            git: false,
            scope: true,
            opts: DEFAULT,
            pattern: "needle",
            want: &["src/a.txt:1"],
            error: false,
        },
        Find {
            name: "ignored files on: the scope's folders are searched too",
            files: SCOPED,
            git: false,
            scope: true,
            opts: Options {
                ignored: true,
                ..DEFAULT
            },
            pattern: "needle",
            want: &["dist/b.txt:1", "node_modules/p/c.txt:1", "src/a.txt:1"],
            error: false,
        },
        Find {
            name: "a bad regex is an error",
            files: &[("a.txt", "x\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "(unclosed",
            want: &[],
            error: true,
        },
        Find {
            name: "no match is no error",
            files: &[("a.txt", "x\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "zzz",
            want: &[],
            error: false,
        },
        Find {
            name: "an empty pattern finds nothing",
            files: &[("a.txt", "x\n")],
            git: false,
            scope: false,
            opts: DEFAULT,
            pattern: "",
            want: &[],
            error: false,
        },
    ];

    #[test]
    fn search_finds_the_lines_its_options_allow() {
        for row in FIND {
            let dir = project(row.files);
            if row.git {
                std::process::Command::new("git")
                    .args(["init", "-q"])
                    .current_dir(dir.path())
                    .status()
                    .unwrap();
            }
            let globs = if row.scope {
                crate::search::scope::Exclusions::read(dir.path()).rg_globs()
            } else {
                Vec::new()
            };
            let s = search_with(dir.path(), row.pattern, 10, row.opts, &[], &[], &globs);
            let (ms, total, _, error) = collect(s);
            let got: Vec<String> = ms
                .iter()
                .map(|m| format!("{}:{}", m.path, m.line))
                .collect();
            assert_eq!(got, row.want, "{}", row.name);
            assert_eq!(total, row.want.len(), "{}: total", row.name);
            assert_eq!(
                error.as_ref().is_some_and(|e| !e.is_empty()),
                row.error,
                "{}: error {error:?}",
                row.name
            );
        }
    }

    #[test]
    fn more_than_max_matches_truncates() {
        let body = "hit\n".repeat(500);
        let dir = project(&[("a.txt", &body), ("b.txt", &body)]);
        let (ms, total, truncated, error) = collect(search(dir.path(), "hit", 300));
        assert_eq!((ms.len(), total, truncated, error), (300, 300, true, None));
        // exactly max: not truncated
        let dir = project(&[("a.txt", "hit\nhit\n")]);
        let (_, total, truncated, _) = collect(search(dir.path(), "hit", 2));
        assert_eq!((total, truncated), (2, false));
    }

    #[test]
    fn long_lines_are_clipped_around_first_match() {
        let line = format!("{}NEEDLE{}", "é".repeat(1000), "b".repeat(1000));
        let dir = project(&[("a.txt", &format!("{line}\n"))]);
        let (ms, ..) = collect(search(dir.path(), "NEEDLE", 10));
        let m = &ms[0];
        assert_eq!(m.text.chars().count(), MAX_LINE_CHARS);
        assert_eq!(m.ranges.len(), 1);
        assert_eq!(&m.text[m.ranges[0].clone()], "NEEDLE");
        assert_eq!(m.text[..m.ranges[0].start].chars().count(), LEAD_CHARS);
    }

    #[test]
    fn drop_kills_rg() {
        // enough output that rg is still writing when we drop
        let body = "hit\n".repeat(20_000);
        let files: Vec<(String, &str)> = (0..20)
            .map(|i| (format!("f{i}.txt"), body.as_str()))
            .collect();
        let files: Vec<(&str, &str)> = files.iter().map(|(p, b)| (p.as_str(), *b)).collect();
        let dir = project(&files);
        let mut s = search(dir.path(), "hit", usize::MAX);
        let first = block_on(s.rx.next());
        assert!(matches!(first, Some(Batch::Matches(_))));
        let exited = s.exited.clone();
        drop(s);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !exited.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "reader thread did not exit");
            thread::yield_now();
        }
    }

    #[test]
    fn base64_paths_decode_and_bad_utf8_is_skipped() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert!(base64_decode("a").is_none());
        assert!(base64_decode("a$==").is_none());
        let v = json::parse(r#"{"bytes":"c3JjL2EucnM="}"#).unwrap();
        assert_eq!(text_or_bytes(&v).as_deref(), Some("src/a.rs"));
        // invalid UTF-8 bytes: skipped
        let v = json::parse(r#"{"bytes":"/w=="}"#).unwrap();
        assert_eq!(text_or_bytes(&v), None);
    }
}
