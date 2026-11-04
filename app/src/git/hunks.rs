//! A file's changed line ranges against HEAD or the index (the editor's change gutter, the diff
//! scrollbar marks): `git diff -U0` of the saved file, or of the buffer's unsaved text against
//! the base's version (`git diff --no-index` on temp files).

use std::path::Path;

use super::cli;
use super::ops::TempFile;
use super::show;

/// What the gutter marks a range as (WS: added green, modified blue, deleted gray triangle).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HunkKind {
    Added,
    Modified,
    Deleted,
}

/// One change: `old_count` lines at `old_start` became `new_count` lines at `new_start` (1-based;
/// a deletion's `new_start` is the line after which lines were removed, 0 = before line 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
}

impl Hunk {
    pub fn kind(&self) -> HunkKind {
        if self.old_count == 0 {
            HunkKind::Added
        } else if self.new_count == 0 {
            HunkKind::Deleted
        } else {
            HunkKind::Modified
        }
    }
}

/// What to compare the file with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base {
    Head,
    Index,
}

/// `@@ -a,b +c,d @@` headers of a unified diff -> hunks.
pub fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let range = |s: &str| -> (u32, u32) {
        let s = &s[1..];
        match s.split_once(',') {
            Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
            None => (s.parse().unwrap_or(0), 1),
        }
    };
    diff.lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("@@ ")?;
            let mut w = rest.split(' ');
            let (old_start, old_count) = range(w.next()?);
            let (new_start, new_count) = range(w.next()?);
            Some(Hunk {
                old_start,
                old_count,
                new_start,
                new_count,
            })
        })
        .collect()
}

/// The hunks of `path` (repo-relative) against `base`; `contents`: the buffer's unsaved text
/// (else the file on disk). A file not in the base: one Added hunk over all of it. Blocking.
pub fn hunks_blocking(
    dir: &Path,
    path: &str,
    base: Base,
    contents: Option<&str>,
) -> anyhow::Result<Vec<Hunk>> {
    let Some(contents) = contents else {
        let mut args = vec!["diff", "-U0", "--no-color", "--no-ext-diff"];
        if base == Base::Head {
            args.push("HEAD");
        }
        args.extend(["--", path]);
        let out = cli::run_blocking(dir, &args)?.into_result()?;
        if out.is_empty() && !tracked_in(dir, path, base) {
            let text = std::fs::read_to_string(dir.join(path)).unwrap_or_default();
            return Ok(all_added(&text));
        }
        return Ok(parse_hunks(&out));
    };
    let rev = match base {
        Base::Head => "HEAD",
        Base::Index => "",
    };
    let Some(old) = show::file_at_blocking(dir, rev, path) else {
        return Ok(all_added(contents));
    };
    let a = TempFile::new(&old)?;
    let b = TempFile::new(contents)?;
    let out = cli::run_blocking(
        dir,
        [
            "diff",
            "--no-index",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            &a.path_str(),
            &b.path_str(),
        ],
    )?;
    // --no-index: exit 1 = differences
    if out.code != Some(0) && out.code != Some(1) {
        anyhow::bail!("{}", cli::error_text(&out));
    }
    Ok(parse_hunks(&out.stdout))
}

fn tracked_in(dir: &Path, path: &str, base: Base) -> bool {
    let rev = match base {
        Base::Head => "HEAD",
        Base::Index => "",
    };
    cli::run_blocking(dir, ["cat-file", "-e", &format!("{rev}:{path}")]).is_ok_and(|o| o.ok())
}

fn all_added(text: &str) -> Vec<Hunk> {
    let n = text.lines().count() as u32;
    if n == 0 {
        return Vec::new();
    }
    vec![Hunk {
        old_start: 0,
        old_count: 0,
        new_start: 1,
        new_count: n,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_headers() {
        let d = "diff --git a/x b/x\n@@ -2 +2 @@\n-two\n+TWO\n@@ -4,0 +5,2 @@ fn x\n+a\n+b\n@@ -7,3 +8,0 @@\n";
        let h = parse_hunks(d);
        assert_eq!(h.len(), 3);
        assert_eq!(h[0].kind(), HunkKind::Modified);
        assert_eq!((h[0].old_count, h[0].new_count), (1, 1));
        assert_eq!(h[1].kind(), HunkKind::Added);
        assert_eq!((h[1].new_start, h[1].new_count), (5, 2));
        assert_eq!(h[2].kind(), HunkKind::Deleted);
        assert_eq!(all_added("a\nb\n")[0].new_count, 2);
    }
}
