//! Fuzzy ranking for Go to File / Search Everywhere (paths) and plain lists (symbols, projects).
//!
//! Paths: nucleo's path scoring plus a frecency-style bonus, like the Lua config's snacks setup
//! ("typed text ranks recently used files higher"): open and recent files get a fixed bonus, and a
//! query found verbatim in the file name gets another one.
//!
//! Folders (paths ending with `/`, from the index) are ranked by their name like files; a query
//! ending with `/` (`src/`) puts the matching folders first. An empty query lists no folders
//! (the recent files first, as before).

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::Arc;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Matcher, Utf32Str};

/// Where a candidate came from; also the tie-break order (open < recent < project).
#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord)]
pub enum Source {
    Open,
    Recent,
    Project,
}

// nucleo scores 16 per matched char, up to +16 for the first char on a boundary and ~+8 per
// consecutive / boundary char, minus 3 to open a gap and 1 per extra gap char. Measured: "main" ->
// `src/main.rs` 109 (+24 name bonus = 133), `a/main/x.rs` 109, `docs/my_animation_input.md` 91
// (scattered, but on word starts). So a clean name hit leads scattered chars by ~40.

/// ~2 matched chars: an open file wins over a project file of similar quality.
pub const OPEN_BONUS: u32 = 32;
/// ~1.5 matched chars: a recent file wins near-ties, but an exact filename in the project still
/// beats scattered chars in a recent file (91 + 24 < 133 above).
pub const RECENT_BONUS: u32 = 24;
/// Query (lowercased, no `/`, no spaces) is a substring of the file name: the user typed the
/// name, so prefer it over the same chars spread over dir names.
pub const NAME_SUBSTRING_BONUS: u32 = 24;

/// The file name starts with the query (on top of [`NAME_SUBSTRING_BONUS`]): `te` -> `terminal.lua`
/// before `lsp_test.lua`.
pub const NAME_PREFIX_BONUS: u32 = 16;

pub fn source_bonus(source: Source) -> u32 {
    match source {
        Source::Open => OPEN_BONUS,
        Source::Recent => RECENT_BONUS,
        Source::Project => 0,
    }
}

/// One ranked candidate. `name` / `dir` are matched char indices (nucleo's units: chars, with
/// grapheme clusters collapsed) inside the file name and inside the dir part (before the last `/`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub ix: usize,
    pub score: u32,
    pub name: Vec<u32>,
    pub dir: Vec<u32>,
}

/// A folder candidate (the index lists folders with a trailing `/`).
pub fn is_dir(path: &str) -> bool {
    path.ends_with('/')
}

/// Concatenates the candidate lists, keeping each path's first (highest-priority) occurrence.
pub fn merge(open: &[String], recent: &[String], index: &[String]) -> (Vec<Arc<str>>, Vec<Source>) {
    let total = open.len() + recent.len() + index.len();
    let mut seen: HashSet<&str> = HashSet::with_capacity(total);
    let mut paths = Vec::with_capacity(total);
    let mut sources = Vec::with_capacity(total);
    for (list, source) in [
        (open, Source::Open),
        (recent, Source::Recent),
        (index, Source::Project),
    ] {
        for p in list {
            if seen.insert(p) {
                paths.push(Arc::from(p.as_str()));
                sources.push(source);
            }
        }
    }
    (paths, sources)
}

fn pattern(query: &str) -> Pattern {
    Pattern::parse(query, CaseMatching::Smart, Normalization::Smart)
}

/// Top `limit` candidates for `query`, best first. Empty query: the first `limit` in input order.
pub fn rank(
    query: &str,
    paths: &[Arc<str>],
    sources: &[Source],
    limit: usize,
    matcher: &mut Matcher,
) -> Vec<Hit> {
    debug_assert_eq!(paths.len(), sources.len());
    if query.trim().is_empty() {
        return (0..paths.len())
            .filter(|&ix| !is_dir(&paths[ix]))
            .take(limit)
            .map(|ix| Hit {
                ix,
                score: 0,
                name: Vec::new(),
                dir: Vec::new(),
            })
            .collect();
    }
    let pat = pattern(query);
    let needle = query.trim().to_lowercase();
    // `name/`: the user wants a folder
    let dir_query = needle.ends_with('/');
    // like WebStorm's Go to File: without a `/` the file name is what's matched; dirs only when
    // the name doesn't match (those come after every name match)
    let name_needle =
        (!needle.contains('/') && !needle.contains(char::is_whitespace)).then_some(needle);

    let mut buf = Vec::new();
    // Groups: folders for a `name/` query, name matches, path-only matches.
    let mut found: Vec<Found> = Vec::new();
    for (ix, path) in paths.iter().enumerate() {
        let source = sources.get(ix).copied().unwrap_or(Source::Project);
        let name = file_name(path);
        let on_name = name_needle
            .as_ref()
            .and_then(|_| pat.score(Utf32Str::new(name, &mut buf), matcher));
        // nucleo is lenient ("tree" in "triage-labels"); WebStorm's matcher isn't: keep a match
        // only if it reads as fragments starting at word starts (the first one anywhere)
        let on_name = on_name.filter(|_| fragments_ok(name, &pat, matcher, &mut buf));
        let (path_only, mut score) = match on_name {
            Some(s) => (false, s),
            None => match pat.score(Utf32Str::new(path, &mut buf), matcher) {
                Some(s) if fragments_ok(path, &pat, matcher, &mut buf) => (true, s),
                _ => continue,
            },
        };
        score += source_bonus(source);
        if let Some(n) = &name_needle
            && contains_lower(name, n)
        {
            score += NAME_SUBSTRING_BONUS;
            if starts_with_lower(name, n) {
                score += NAME_PREFIX_BONUS;
            }
        }
        let group = if dir_query && is_dir(path) {
            0
        } else if path_only {
            2
        } else {
            1
        };
        found.push((
            group,
            score,
            is_dir(path),
            source,
            path.len(),
            ix,
            path_only,
        ));
    }

    let cmp = |a: &Found, b: &Found| {
        a.0.cmp(&b.0)
            .then(b.1.cmp(&a.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
            .then(a.4.cmp(&b.4))
            .then(a.5.cmp(&b.5))
    };
    top_k(&mut found, limit, cmp);

    // indices only for the survivors: they cost a second, slower matching pass
    let mut indices = Vec::new();
    found
        .into_iter()
        .map(|(_, score, _, _, _, ix, path_only)| {
            indices.clear();
            if !path_only {
                pat.indices(
                    Utf32Str::new(file_name(&paths[ix]), &mut buf),
                    matcher,
                    &mut indices,
                );
                indices.sort_unstable();
                indices.dedup();
                return Hit {
                    ix,
                    score,
                    name: indices.clone(),
                    dir: Vec::new(),
                };
            }
            let hay = Utf32Str::new(&paths[ix], &mut buf);
            pat.indices(hay, matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            // last '/' in nucleo's char units, so the split matches the indices (a folder's
            // trailing one isn't a split: its name is before it, a match on it isn't shown)
            let end = hay.len() - usize::from(is_dir(&paths[ix]));
            let slash = hay
                .chars()
                .take(end)
                .enumerate()
                .filter(|&(_, c)| c == '/')
                .map(|(i, _)| i)
                .last();
            let (mut name, mut dir) = (Vec::new(), Vec::new());
            for &i in &indices {
                if i as usize >= end {
                    continue;
                }
                match slash {
                    Some(s) if (i as usize) < s => dir.push(i),
                    Some(s) if i as usize == s => {}
                    Some(s) => name.push(i - s as u32 - 1),
                    None => name.push(i),
                }
            }
            Hit {
                ix,
                score,
                name,
                dir,
            }
        })
        .collect()
}

/// Generic ranking for non-path lists: all matches as `(index, score, matched char indices)`, by
/// score desc then index. Empty query: everything in input order with no indices.
pub fn rank_plain(
    query: &str,
    texts: &[&str],
    matcher: &mut Matcher,
) -> Vec<(usize, u32, Vec<u32>)> {
    if query.trim().is_empty() {
        return (0..texts.len()).map(|ix| (ix, 0, Vec::new())).collect();
    }
    let pat = pattern(query);
    let mut buf = Vec::new();
    let mut out: Vec<(usize, u32, Vec<u32>)> = texts
        .iter()
        .enumerate()
        .filter_map(|(ix, text)| {
            let mut indices = Vec::new();
            let score = pat.indices(Utf32Str::new(text, &mut buf), matcher, &mut indices)?;
            indices.sort_unstable();
            indices.dedup();
            Some((ix, score, indices))
        })
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// Sorts the best `k` items to the front and drops the rest; O(n + k log k).
fn top_k<T>(items: &mut Vec<T>, k: usize, cmp: impl Fn(&T, &T) -> Ordering) {
    if k == 0 {
        items.clear();
        return;
    }
    if items.len() > k {
        items.select_nth_unstable_by(k - 1, &cmp);
        items.truncate(k);
    }
    items.sort_unstable_by(cmp);
}

/// WebStorm-style match shape (`MinusculeMatcher` with a leading `*`, as Go to File uses): every
/// run of matched chars after the first starts at a word start (after a separator, a camel hump,
/// a digit run).
fn fragments_ok(text: &str, pat: &Pattern, matcher: &mut Matcher, buf: &mut Vec<char>) -> bool {
    let mut indices = Vec::new();
    let hay = Utf32Str::new(text, buf);
    if pat.indices(hay, matcher, &mut indices).is_none() {
        return false;
    }
    indices.sort_unstable();
    indices.dedup();
    let chars: Vec<char> = hay.chars().collect();
    let mut prev: Option<u32> = None;
    for &i in &indices {
        let continues = prev.is_some_and(|p| p + 1 == i);
        if prev.is_some() && !continues && !word_start(&chars, i as usize) {
            return false;
        }
        prev = Some(i);
    }
    true
}

fn word_start(chars: &[char], i: usize) -> bool {
    let Some(&c) = chars.get(i) else { return false };
    let Some(&before) = i.checked_sub(1).and_then(|j| chars.get(j)) else {
        return true;
    };
    !before.is_alphanumeric()
        || (c.is_uppercase() && !before.is_uppercase())
        || (c.is_ascii_digit() != before.is_ascii_digit())
}

/// A match in [`rank`]: (group, score, folder, source, path len, ix) is the sort key (a file
/// before a folder of the same score), then whether only the whole path matched (how the
/// indices are taken).
type Found = (u8, u32, bool, Source, usize, usize, bool);

/// The last path part (a folder's name without its trailing `/`).
fn file_name(path: &str) -> &str {
    let p = path.strip_suffix('/').unwrap_or(path);
    p.rsplit('/').next().unwrap_or(p)
}

/// `needle` is already lowercase.
fn starts_with_lower(hay: &str, needle: &str) -> bool {
    hay.len() >= needle.len()
        && hay
            .get(..needle.len())
            .is_some_and(|h| h.to_lowercase() == needle)
}

/// `needle` is already lowercase. ASCII fast path avoids allocating per candidate.
fn contains_lower(hay: &str, needle: &str) -> bool {
    if hay.is_ascii() && needle.is_ascii() {
        let (h, n) = (hay.as_bytes(), needle.as_bytes());
        n.is_empty()
            || h.windows(n.len())
                .any(|w| w.iter().zip(n).all(|(a, b)| a.to_ascii_lowercase() == *b))
    } else {
        hay.to_lowercase().contains(needle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleo_matcher::Config;
    use std::time::Instant;

    fn matcher() -> Matcher {
        Matcher::new(Config::DEFAULT.match_paths())
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn ranked(query: &str, open: &[&str], recent: &[&str], index: &[&str]) -> Vec<String> {
        let (paths, sources) = merge(&strings(open), &strings(recent), &strings(index));
        rank(query, &paths, &sources, 50, &mut matcher())
            .into_iter()
            .map(|h| paths[h.ix].to_string())
            .collect()
    }

    struct Order {
        name: &'static str,
        query: &'static str,
        open: &'static [&'static str],
        recent: &'static [&'static str],
        index: &'static [&'static str],
        /// The ranked paths: all of them when `whole`, else the top ones.
        want: &'static [&'static str],
        whole: bool,
    }

    const STORE: &[&str] = &[
        "lib/x.ts",
        "src/store/",
        "src/store/index.ts",
        "src/app/store.ts",
    ];

    const ORDER: &[Order] = &[
        Order {
            name: "file names first, a name prefix on top",
            query: "te",
            open: &[],
            recent: &[],
            index: &[
                "tests/lsp_test.lua",
                "nvim/lua/config/terminal.lua",
                "tests/a.lua",
                "x/rate.ts",
            ],
            want: &[
                "nvim/lua/config/terminal.lua",
                "tests/lsp_test.lua",
                "x/rate.ts",
                "tests/a.lua",
            ],
            whole: true,
        },
        Order {
            name: "chars scattered off word starts are no match",
            query: "tree",
            open: &[],
            recent: &[],
            index: &[
                "docs/triage-labels.md",
                "nvim/filetree.lua",
                "src/tree/mod.rs",
                "a/TreeView.ts",
            ],
            want: &["a/TreeView.ts", "nvim/filetree.lua", "src/tree/mod.rs"],
            whole: true,
        },
        Order {
            name: "a slash matches the whole path",
            query: "tests/a",
            open: &[],
            recent: &[],
            index: &["a.lua", "tests/a.lua"],
            want: &["tests/a.lua"],
            whole: false,
        },
        Order {
            name: "recent beats project on a similar match",
            query: "button",
            open: &[],
            recent: &["src/components/Button.tsx"],
            index: &["src/ui/button.tsx", "src/components/Button.tsx"],
            want: &["src/components/Button.tsx"],
            whole: false,
        },
        Order {
            name: "open beats recent on equal paths",
            query: "app",
            open: &["b/app.ts"],
            recent: &["a/app.ts"],
            index: &[],
            want: &["b/app.ts", "a/app.ts"],
            whole: true,
        },
        Order {
            name: "a much better project match beats recent",
            query: "main",
            open: &[],
            recent: &["docs/my_animation_input.md"],
            index: &["src/main.rs", "docs/my_animation_input.md"],
            want: &["src/main.rs"],
            whole: false,
        },
        Order {
            name: "the file name beats a dir",
            query: "store",
            open: &[],
            recent: &[],
            index: &["src/store/index.ts", "src/app/store.ts"],
            want: &["src/app/store.ts"],
            whole: false,
        },
        Order {
            name: "folders match by name, files first on ties",
            query: "store",
            open: &[],
            recent: &[],
            index: STORE,
            want: &["src/app/store.ts", "src/store/"],
            whole: false,
        },
        Order {
            name: "a trailing slash puts the folder first",
            query: "store/",
            open: &[],
            recent: &[],
            index: STORE,
            want: &["src/store/"],
            whole: false,
        },
        Order {
            name: "an empty query lists files only",
            query: "",
            open: &[],
            recent: &[],
            index: STORE,
            want: &["lib/x.ts", "src/store/index.ts", "src/app/store.ts"],
            whole: true,
        },
        Order {
            name: "ties go to the shorter path, then the index",
            query: "foo",
            open: &[],
            recent: &[],
            index: &["x/long/foo.rs", "y/foo.rs", "z/foo.rs"],
            want: &["y/foo.rs", "z/foo.rs", "x/long/foo.rs"],
            whole: true,
        },
        Order {
            name: "an upper-case query matches case",
            query: "Foo",
            open: &[],
            recent: &[],
            index: &["a/foo.rs", "a/Foo.rs"],
            want: &["a/Foo.rs"],
            whole: true,
        },
    ];

    #[test]
    fn paths_rank_in_order() {
        for row in ORDER {
            let got = ranked(row.query, row.open, row.recent, row.index);
            let got = if row.whole {
                &got[..]
            } else {
                &got[..row.want.len().min(got.len())]
            };
            assert_eq!(got, row.want, "{}", row.name);
        }
    }

    struct Marks {
        name: &'static str,
        path: &'static str,
        query: &'static str,
        name_ix: &'static [u32],
        dir_ix: &'static [u32],
    }

    const MARKS: &[Marks] = &[
        Marks {
            name: "dir and name parts split at the last slash",
            path: "src/editor/main.rs",
            query: "edmain",
            name_ix: &[0, 1, 2, 3],
            dir_ix: &[4, 5],
        },
        Marks {
            name: "no slash: all of it is the name",
            path: "MakeFile",
            query: "mf",
            name_ix: &[0, 4],
            dir_ix: &[],
        },
        Marks {
            name: "a folder's name leaves out its trailing slash",
            path: "src/store/",
            query: "sto",
            name_ix: &[0, 1, 2],
            dir_ix: &[],
        },
        Marks {
            name: "a folder's trailing slash is not marked",
            path: "src/store/",
            query: "src/store/",
            name_ix: &[0, 1, 2, 3, 4],
            dir_ix: &[0, 1, 2],
        },
    ];

    #[test]
    fn hits_mark_chars_in_the_name_and_the_dir() {
        for row in MARKS {
            let (paths, sources) = merge(&[], &[], &strings(&[row.path]));
            let hits = rank(row.query, &paths, &sources, 10, &mut matcher());
            assert_eq!(hits.len(), 1, "{}", row.name);
            assert_eq!(hits[0].name, row.name_ix, "{}: name", row.name);
            assert_eq!(hits[0].dir, row.dir_ix, "{}: dir", row.name);
        }
    }

    #[test]
    fn merge_keeps_each_path_once_from_its_first_list() {
        let (paths, sources) = merge(
            &strings(&["a", "b"]),
            &strings(&["b", "c"]),
            &strings(&["a", "c", "d"]),
        );
        let paths: Vec<&str> = paths.iter().map(|p| &**p).collect();
        assert_eq!(paths, ["a", "b", "c", "d"]);
        assert_eq!(
            sources,
            [Source::Open, Source::Open, Source::Recent, Source::Project]
        );
    }

    #[test]
    fn rank_keeps_at_most_the_limit() {
        // An empty query keeps the input order and marks nothing.
        let (paths, sources) = merge(&[], &strings(&["z", "y"]), &strings(&["x", "w"]));
        let hits = rank("  ", &paths, &sources, 3, &mut matcher());
        assert_eq!(hits.iter().map(|h| h.ix).collect::<Vec<_>>(), [0, 1, 2]);
        assert!(hits.iter().all(|h| h.name.is_empty() && h.dir.is_empty()));
        let (paths, sources) = merge(&[], &[], &strings(&["a1", "a2", "a3", "a4"]));
        assert_eq!(rank("a", &paths, &sources, 2, &mut matcher()).len(), 2);
        assert!(rank("a", &paths, &sources, 0, &mut matcher()).is_empty());
    }

    #[test]
    fn plain_ranks_by_score_then_index() {
        let texts = ["fooBar", "xfxoxo", "foo", "bar"];
        let r = rank_plain("foo", &texts, &mut Matcher::new(Config::DEFAULT));
        let ixs: Vec<usize> = r.iter().map(|h| h.0).collect();
        assert_eq!(ixs.len(), 3);
        assert_eq!(*ixs.last().unwrap(), 1); // scattered last
        assert_eq!(r[0].2, [0, 1, 2]);
        let all = rank_plain("", &texts, &mut Matcher::new(Config::DEFAULT));
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn perf_10k_paths() {
        let mut index = Vec::new();
        for d in 0..100 {
            for f in 0..100 {
                index.push(format!("src/dir{d}/sub/file{f}.ts"));
            }
        }
        let recent: Vec<String> = index.iter().step_by(500).cloned().collect();
        let (paths, sources) = merge(&[], &recent, &index);
        let mut m = matcher();
        let queries = [
            "f", "fi", "fil", "file", "file4", "file42", "d", "di", "dir", "dir9", "sub2", "d9f",
            "s", "su", "ts", "x", "zz", "sdsft", "dsft", "dir12f",
        ];
        let mut times = Vec::new();
        for _ in 0..3 {
            for q in queries {
                let t = Instant::now();
                std::hint::black_box(rank(q, &paths, &sources, 100, &mut m));
                times.push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        times.sort_by(f64::total_cmp);
        let median = times[times.len() / 2];
        let p95 = times[times.len() * 95 / 100];
        println!("rank 10k paths: median {median:.2} ms, p95 {p95:.2} ms");
        if !cfg!(debug_assertions) {
            assert!(median < 50.0);
        }
    }
}
