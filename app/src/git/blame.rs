//! Annotate (blame) data: `git blame --porcelain` of a file, optionally of the buffer's unsaved
//! text (`--contents -`, like `nvim/lua/git/blame.lua`), per line the commit, author, time,
//! summary and original line; uncommitted lines; WS's annotation colors and texts.
//!
//! WS colors (IntelliJ Community, Apache-2.0, see app/NOTICE): `AnnotationsSettings` (5 anchor
//! colors VCS_ANNOTATIONS_COLOR_1..5, 4 steps between each = 21) in the default ORDER mode
//! (`AnnotateToggleAction.computeBgColors` + git4idea `GitRevisionsOrderProvider`): revisions
//! grouped by distinct committer date, newest first, `palette[21 * index / count]`; no colors
//! when that gives just one revision. Lua's blame.lua had 5 levels by age from today
//! (7 / 30 / 180 / 365 days), kept as [`lua_age_level`].

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use super::cli::{self, Cancel};
use super::dates::{self, Zone};
use super::log::{Person, Time};

/// The 21 annotation backgrounds, newest first (Islands Dark `IslandSchemeDark.xml`
/// VCS_ANNOTATIONS_COLOR_1..5 = 2F5194 2D416B 283754 242D42 22252E, interpolated like
/// `ColorGenerator.generateLinearColorSequence`).
pub const ANNOTATION_COLORS: [u32; 21] = [
    0x2F5194, 0x2E4D8B, 0x2E4A83, 0x2D477B, 0x2D4473, 0x2D416B, 0x2C3F66, 0x2B3D61, 0x2A3B5D,
    0x293958, 0x283754, 0x273550, 0x26334C, 0x253149, 0x242F45, 0x242D42, 0x232B3E, 0x23293A,
    0x222836, 0x222632, 0x22252E,
];

/// A commit that blamed lines come from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlameCommit {
    pub hash: String,
    pub author: Person,
    pub author_time: Time,
    pub committer: Person,
    pub commit_time: Time,
    pub summary: String,
    /// The file's path in that commit.
    pub filename: String,
    /// The commit before it and the file's path there (`previous`).
    pub previous: Option<(String, String)>,
    /// Not committed yet (all-zero hash: unsaved / uncommitted lines).
    pub uncommitted: bool,
}

/// One line of the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlameLine {
    /// Index into [`Blame::commits`].
    pub commit: usize,
    /// The line's number in that commit's version (1-based).
    pub orig_line: u32,
}

/// A file's blame.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// One per line of the blamed text (index 0 = line 1).
    pub lines: Vec<BlameLine>,
}

impl Blame {
    pub fn line(&self, lnum: usize) -> Option<(&BlameLine, &BlameCommit)> {
        let l = self.lines.get(lnum.checked_sub(1)?)?;
        Some((l, &self.commits[l.commit]))
    }

    /// WS ORDER-mode background per commit (index into [`Blame::commits`] -> 0xRRGGBB); None for
    /// uncommitted lines, or for every line when there's only one revision.
    pub fn order_colors(&self) -> Vec<Option<u32>> {
        let mut by_date: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
        for (i, c) in self.commits.iter().enumerate() {
            if !c.uncommitted {
                by_date.entry(c.commit_time.unix).or_default().push(i);
            }
        }
        let mut colors = vec![None; self.commits.len()];
        let count = by_date.len();
        if count < 2 {
            return colors;
        }
        for (index, (_, commits)) in by_date.iter().rev().enumerate() {
            let color = ANNOTATION_COLORS[ANNOTATION_COLORS.len() * index / count];
            for &c in commits {
                colors[c] = Some(color);
            }
        }
        colors
    }

    /// The file's latest revision (its lines are drawn bold): the newest commit by commit date.
    pub fn last_commit(&self) -> Option<usize> {
        self.commits
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.uncommitted)
            .max_by_key(|(_, c)| c.commit_time.unix)
            .map(|(i, _)| i)
    }
}

/// Parses `git blame --porcelain` output.
pub fn parse_porcelain(out: &str) -> Blame {
    let mut b = Blame::default();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut cur: Option<(usize, u32)> = None; // (commit, orig line) of the header being read
    for l in out.lines() {
        if let Some(_text) = l.strip_prefix('\t') {
            if let Some((commit, orig_line)) = cur.take() {
                b.lines.push(BlameLine { commit, orig_line });
            }
            continue;
        }
        let mut words = l.split(' ');
        let first = words.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|c| c.is_ascii_hexdigit()) {
            let orig: u32 = words.next().and_then(|w| w.parse().ok()).unwrap_or(0);
            let i = *index.entry(first.to_owned()).or_insert_with(|| {
                b.commits.push(BlameCommit {
                    hash: first.to_owned(),
                    uncommitted: first.bytes().all(|c| c == b'0'),
                    ..Default::default()
                });
                b.commits.len() - 1
            });
            cur = Some((i, orig));
            continue;
        }
        let Some((i, _)) = cur else { continue };
        let c = &mut b.commits[i];
        let val = l.split_once(' ').map_or("", |(_, v)| v);
        let mail = |v: &str| v.trim_start_matches('<').trim_end_matches('>').to_owned();
        match first {
            "author" => c.author.name = val.to_owned(),
            "author-mail" => c.author.email = mail(val),
            "author-time" => c.author_time.unix = val.parse().unwrap_or(0),
            "author-tz" => c.author_time.offset_min = tz_minutes(val),
            "committer" => c.committer.name = val.to_owned(),
            "committer-mail" => c.committer.email = mail(val),
            "committer-time" => c.commit_time.unix = val.parse().unwrap_or(0),
            "committer-tz" => c.commit_time.offset_min = tz_minutes(val),
            "summary" => c.summary = val.to_owned(),
            "filename" => c.filename = val.to_owned(),
            "previous" => {
                c.previous = val
                    .split_once(' ')
                    .map(|(h, p)| (h.to_owned(), p.to_owned()))
            }
            _ => {}
        }
    }
    b
}

/// `+0200` -> 120.
fn tz_minutes(tz: &str) -> i32 {
    let sign = if tz.starts_with('-') { -1 } else { 1 };
    let d = tz.trim_start_matches(['+', '-']);
    let h: i32 = d.get(..2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i32 = d.get(2..4).and_then(|s| s.parse().ok()).unwrap_or(0);
    sign * (h * 60 + m)
}

/// Blames `path` (repo-relative or absolute) in the repo at `dir`; `contents`: the buffer's
/// unsaved text (lines it has that the file doesn't are uncommitted). Blocking; cancellable
/// (blame of a big file takes a while: cancel it when the buffer changes again).
pub fn blame_blocking(
    dir: &Path,
    path: &str,
    contents: Option<&str>,
    cancel: &Cancel,
) -> anyhow::Result<Blame> {
    let mut args = vec!["blame", "--porcelain"];
    if contents.is_some() {
        args.extend(["--contents", "-"]);
    }
    args.extend(["--", path]);
    let out = cli::run_cancellable(dir, &args, contents, cancel)?.into_result()?;
    Ok(parse_porcelain(&out))
}

/// Annotate's author (WS default "Last Name": `ShortNameType.LASTNAME`): the last word of the
/// name (`<email>` stripped); a bare email: the last part of its local part, capitalized.
pub fn short_author(p: &Person) -> String {
    let name = p.name.split('<').next().unwrap_or("").trim();
    if !name.is_empty() && !name.contains('@') {
        return name.split_whitespace().last().unwrap_or(name).to_owned();
    }
    let email = if name.is_empty() { &p.email } else { name };
    let local = email.split('@').next().unwrap_or(email);
    let last = local
        .split(['.', ',', '<', '>', '(', ')', '"', ':', '_', '-'])
        .rfind(|s| !s.is_empty())
        .unwrap_or(local);
    let mut c = last.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// Annotate's text for a line: "2026-10-15 Example" (date by `formatPrettyDate`: "Today",
/// "Yesterday", else the date); "" for uncommitted lines.
pub fn annotation_text(c: &BlameCommit, now: i64, zone: &Zone) -> String {
    if c.uncommitted {
        return String::new();
    }
    format!(
        "{} {}",
        dates::format_pretty_date(c.author_time.unix, now, zone),
        short_author(&c.author)
    )
}

/// Lua blame.lua's age level: 1 (newer than 7 days, brightest) .. 5 (a year or older).
#[cfg(test)]
pub fn lua_age_level(time: i64, now: i64) -> u8 {
    let days = (now - time) as f64 / 86_400.0;
    [7.0, 30.0, 180.0, 365.0]
        .iter()
        .position(|&limit| days < limit)
        .map_or(5, |i| i as u8 + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const Z: &str = "0000000000000000000000000000000000000000";

    fn porcelain() -> String {
        format!(
            "{A} 1 1 2\nauthor Ada Example\nauthor-mail <ada@x.se>\nauthor-time 100\nauthor-tz +0200\n\
             committer Ada Example\ncommitter-mail <ada@x.se>\ncommitter-time 100\ncommitter-tz +0200\n\
             summary first\nboundary\nfilename blame.ts\n\tline one\n\
             {A} 2 2\n\tline two\n\
             {B} 2 3 1\nauthor Max\nauthor-mail <m@x.se>\nauthor-time 200\nauthor-tz -0130\n\
             committer Max\ncommitter-mail <m@x.se>\ncommitter-time 200\ncommitter-tz -0130\n\
             summary second\nprevious {A} old.ts\nfilename blame.ts\n\tline 3\n\
             {Z} 4 4 1\nauthor Not Committed Yet\nauthor-mail <not.committed.yet>\nauthor-time 300\n\
             author-tz +0000\ncommitter Not Committed Yet\ncommitter-mail <not.committed.yet>\n\
             committer-time 300\ncommitter-tz +0000\nsummary Version of blame.ts from blame.ts\n\
             filename blame.ts\n\tunsaved\n"
        )
    }

    #[test]
    fn parses_porcelain() {
        let b = parse_porcelain(&porcelain());
        assert_eq!(b.lines.len(), 4);
        assert_eq!(b.commits.len(), 3);
        let (l, c) = b.line(2).unwrap();
        assert_eq!(l.orig_line, 2);
        assert_eq!(c.summary, "first");
        assert_eq!(c.author.email, "ada@x.se");
        assert_eq!(c.author_time.offset_min, 120);
        let (l, c) = b.line(3).unwrap();
        assert_eq!(l.orig_line, 2);
        assert_eq!(c.author_time.offset_min, -90);
        assert_eq!(c.previous, Some((A.to_owned(), "old.ts".to_owned())));
        assert!(b.line(4).unwrap().1.uncommitted);
        assert!(b.line(5).is_none());
        assert_eq!(b.last_commit(), Some(1));
        // two revisions: newest COLOR_1, the other palette[21*1/2] = index 10
        let colors = b.order_colors();
        assert_eq!(colors[1], Some(ANNOTATION_COLORS[0]));
        assert_eq!(colors[0], Some(ANNOTATION_COLORS[10]));
        assert_eq!(colors[2], None);
        // one revision: no colours
        let one = Blame {
            commits: vec![BlameCommit::default()],
            lines: vec![BlameLine {
                commit: 0,
                orig_line: 1,
            }],
        };
        assert_eq!(one.order_colors(), [None]);
    }

    #[test]
    fn short_names_and_texts() {
        let p = |n: &str, e: &str| Person {
            name: n.into(),
            email: e.into(),
        };
        assert_eq!(short_author(&p("Ada Example", "i@x")), "Example");
        assert_eq!(short_author(&p("Max", "m@x")), "Max");
        assert_eq!(short_author(&p("", "john.doe@x.se")), "Doe");
        assert_eq!(short_author(&p("jane_smith@x", "")), "Smith");
        let now = 1_792_238_400;
        let z = Zone::fixed(0);
        let c = BlameCommit {
            author: p("Ada Example", ""),
            author_time: Time {
                unix: now - 3 * 86_400,
                offset_min: 0,
            },
            ..Default::default()
        };
        assert_eq!(annotation_text(&c, now, &z), "2026-10-14 Example");
        assert_eq!(
            annotation_text(
                &BlameCommit {
                    uncommitted: true,
                    ..c
                },
                now,
                &z
            ),
            ""
        );
        assert_eq!(lua_age_level(now - 86_400, now), 1);
        assert_eq!(lua_age_level(now - 100 * 86_400, now), 3);
        assert_eq!(lua_age_level(now - 400 * 86_400, now), 5);
    }
}
