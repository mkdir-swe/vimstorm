//! One annotated buffer's data: the blame (Rust `git blame`, off the UI thread), per commit its
//! WS texts ("2026-10-15" / "Today", "Example"), ORDER-mode color and whether it's the file's
//! latest revision, and the commit tooltip (git4idea `GitFileAnnotation.getToolTip`).

use std::path::{Path, PathBuf};

use crate::git::blame::{self, Blame, BlameCommit};
use crate::git::dates::{self, Zone};

/// (hash, the file's path in it, the path in its parent).
pub type CommitRef = (String, String, Option<String>);

pub struct Annotation {
    pub buf: i64,
    /// The file (absolute) and the directory git runs in.
    pub path: PathBuf,
    pub dir: PathBuf,
    pub blame: Blame,
    /// Per commit: background (WS ORDER mode), None = none (uncommitted, single revision).
    pub colors: Vec<Option<u32>>,
    /// Per commit: (date, author); empty for uncommitted lines.
    pub texts: Vec<(String, String)>,
    /// The file's latest revision (its lines' text is brighter).
    pub last: Option<usize>,
    /// The file's repo-relative path (tooltips name another one: lines moved from it).
    pub rel: Option<String>,
}

impl Annotation {
    pub fn new(
        buf: i64,
        dir: PathBuf,
        path: PathBuf,
        root: Option<&Path>,
        blame: Blame,
        now: i64,
        zone: &Zone,
    ) -> Self {
        let rel = root
            .and_then(|r| path.strip_prefix(r).ok())
            .map(|p| p.to_string_lossy().into_owned());
        let texts = blame
            .commits
            .iter()
            .map(|c| {
                if c.uncommitted {
                    Default::default()
                } else {
                    (
                        dates::format_pretty_date(c.author_time.unix, now, zone),
                        blame::short_author(&c.author),
                    )
                }
            })
            .collect();
        Annotation {
            buf,
            dir,
            path,
            colors: blame.order_colors(),
            last: blame.last_commit(),
            rel,
            texts,
            blame,
        }
    }

    /// Commit index of buffer line `lnum` (1-based); None past the blamed text.
    pub fn commit_of(&self, lnum: u32) -> Option<usize> {
        self.blame
            .lines
            .get((lnum as usize).checked_sub(1)?)
            .map(|l| l.commit)
    }

    pub fn commit(&self, i: usize) -> &BlameCommit {
        &self.blame.commits[i]
    }

    /// Commits (hash, path in it, path in its parent) + per line the 1-based index into them
    /// (Lua keeps them for Enter / menus).
    pub fn line_table(&self) -> (Vec<CommitRef>, Vec<u32>) {
        let hashes = self
            .blame
            .commits
            .iter()
            .map(|c| {
                let prev = c.previous.as_ref().map(|(_, p)| p.clone());
                (c.hash.clone(), c.filename.clone(), prev)
            })
            .collect();
        let lines = self
            .blame
            .lines
            .iter()
            .map(|l| l.commit as u32 + 1)
            .collect();
        (hashes, lines)
    }
}

/// The commit tooltip: "Commit <hash>", "Author: Name <email>", "Date: 2026-10-15, 11:56", the
/// path when the line came from another one (renames), then the message (`message` = the full
/// one when loaded, else the subject + "...", as WS before its commit cache has it).
pub fn tooltip(
    c: &BlameCommit,
    rel_path: Option<&str>,
    message: Option<&str>,
    zone: &Zone,
) -> String {
    let mut s = format!("Commit {}\nAuthor: {}", c.hash, exact_person(&c.author));
    s.push_str(&format!(
        "\nDate: {}",
        dates::format_date_time(c.author_time.unix, zone)
    ));
    if rel_path.is_some_and(|p| !c.filename.is_empty() && p != c.filename) {
        s.push_str(&format!("\nPath: {}", c.filename));
    }
    let message = match message {
        Some(m) => m.trim_end().to_owned(),
        None => format!("{}\n...", c.summary),
    };
    s.push_str("\n\n");
    s.push_str(&message);
    s
}

/// `VcsUserUtil.toExactString`: "Name <email>".
fn exact_person(p: &crate::git::log::Person) -> String {
    match (p.name.is_empty(), p.email.is_empty()) {
        (false, false) => format!("{} <{}>", p.name, p.email),
        (false, true) => p.name.clone(),
        _ => p.email.clone(),
    }
}

/// The directory to run git in for `file`.
pub fn dir_of(file: &Path) -> PathBuf {
    file.parent().map(Path::to_path_buf).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::blame::parse_porcelain;

    const OUT: &str = "\
1111111111111111111111111111111111111111 1 1 1
author Aaron Sample
author-mail <a@x.se>
author-time 1736503200
author-tz +0100
committer Aaron Sample
committer-mail <a@x.se>
committer-time 1736503200
committer-tz +0100
summary AB#100 Initial setup
filename old.ts
\tline one
2222222222222222222222222222222222222222 2 2 1
author Max
author-mail <m@x.se>
author-time 1760000000
author-tz +0200
committer Max
committer-mail <m@x.se>
committer-time 1760000000
committer-tz +0200
summary AB#1236 Recent blame line
filename blame.ts
\tline 3 recent
0000000000000000000000000000000000000000 3 3 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1760100000
author-tz +0200
committer Not Committed Yet
committer-mail <not.committed.yet>
committer-time 1760100000
committer-tz +0200
summary Version of blame.ts from blame.ts
filename blame.ts
\tlocal
";

    fn ann() -> Annotation {
        Annotation::new(
            3,
            "/r".into(),
            "/r/blame.ts".into(),
            Some(Path::new("/r")),
            parse_porcelain(OUT),
            1760000000 + 3600,
            &Zone::fixed(7200),
        )
    }

    #[test]
    fn texts_colors_and_lines() {
        let a = ann();
        assert_eq!(a.texts[0], ("2025-01-10".to_owned(), "Sample".to_owned()));
        assert_eq!(a.texts[1].1, "Max");
        assert_eq!(a.texts[1].0, "Today");
        assert_eq!(a.texts[2], Default::default(), "uncommitted: blank");
        assert_eq!(a.colors[2], None);
        assert!(a.colors[0].is_some() && a.colors[1].is_some() && a.colors[0] != a.colors[1]);
        assert_eq!(a.last, Some(1));
        assert_eq!(a.commit_of(2), Some(1));
        assert_eq!(a.commit_of(4), None);
        assert_eq!(a.commit_of(0), None);
        let (hashes, lines) = a.line_table();
        assert_eq!(lines, vec![1, 2, 3]);
        assert_eq!(hashes[2].0, "0".repeat(40));
        assert_eq!(hashes[1].1, "blame.ts");
    }

    #[test]
    fn tooltip_like_ws() {
        let a = ann();
        let zone = Zone::fixed(3600);
        assert_eq!(a.rel.as_deref(), Some("blame.ts"));
        let t = tooltip(a.commit(0), a.rel.as_deref(), None, &zone);
        assert_eq!(
            t,
            "Commit 1111111111111111111111111111111111111111\nAuthor: Aaron Sample <a@x.se>\n\
             Date: 2025-01-10, 11:00\nPath: old.ts\n\nAB#100 Initial setup\n..."
        );
        let t = tooltip(
            a.commit(1),
            Some("blame.ts"),
            Some("Subject\n\nBody.\n"),
            &zone,
        );
        assert!(
            t.ends_with("Max <m@x.se>\nDate: 2025-10-09, 09:53\n\nSubject\n\nBody."),
            "{t}"
        );
    }
}
