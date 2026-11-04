//! A card tile's face on the rail (README "Layout"): two letters from its card's title on the
//! card's own colour, and the stage bar under them. Pure: the rail draws what these pick.
//!
//! Letters ([`letters`]): a leading `As a … I can` and the small words skipped, the first letters
//! of the first two words left (one word: its first two letters). Two open tiles never share
//! them: the later one takes its first word's first two letters, then its first letter and the
//! next consonant. Colour ([`hues`]): one of [`HUES`], none a state's (teal, amber, green, red);
//! a card keeps the one it has while its tile is open (kept in [`super::memory`]), a new one
//! takes the first no open tile has. A repo ([`repo_names`]): its main checkout's folder's
//! name, its parent folder's too when another open repo's folder has the same name.

use std::path::Path;

use gpui_kit::Rgba;

use crate::factory::{Segment, WorkspaceState};
use crate::look;

/// The cards' colours and their tints (the letters'), in the order they are given out.
pub const HUES: [(Rgba, Rgba); 7] = [
    (look::hex(0x8f7cf7), look::hex(0xc7bdff)),
    (look::hex(0x5c9df6), look::hex(0xb3d1ff)),
    (look::hex(0xec74b5), look::hex(0xffc0e1)),
    (look::hex(0x62b8e8), look::hex(0xbfe6ff)),
    (look::hex(0xef8f7d), look::hex(0xffc9be)),
    (look::hex(0x9aa6c2), look::hex(0xd6dced)),
    (look::hex(0xc56ee0), look::hex(0xecc2fa)),
];

/// A prototype of an idea (no card): the grey of [`HUES`].
pub const IDEA_HUE: usize = 5;

/// Abe's tile: its own grey under the face.
pub const ABE_HUE: Rgba = look::hex(0x6c7387);

/// The selected tile's letters, its pill, the hover card's swatch letters.
pub const WHITE: Rgba = look::hex(0xffffff);

/// The `?` on the teal needs-you circle.
pub const ASK_INK: Rgba = look::hex(0x10302a);

/// The words a tile's letters skip.
const SMALL: [&str; 11] = [
    "in", "with", "an", "the", "a", "of", "to", "for", "on", "and", "my",
];

/// `c` over `ground` at `alpha` (the tile's ground: its colour at 20 %, selected 55 %).
pub fn over(c: Rgba, alpha: f32, ground: Rgba) -> Rgba {
    let mix = |a: f32, b: f32| a * alpha + b * (1. - alpha);
    Rgba {
        r: mix(c.r, ground.r),
        g: mix(c.g, ground.g),
        b: mix(c.b, ground.b),
        a: 1.,
    }
}

/// `c` at `alpha`.
pub fn faded(c: Rgba, alpha: f32) -> Rgba {
    Rgba { a: alpha, ..c }
}

/// The title's words that count: a leading `#id` and `As a … I can` gone, small words skipped
/// (all of them when nothing else is left).
fn words(title: &str) -> Vec<String> {
    let all: Vec<String> = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect();
    let mut rest: &[String] = &all;
    // `#2 cart total…`: the number is not a word
    if title.trim_start().starts_with('#')
        && rest
            .first()
            .is_some_and(|w| w.chars().all(|c| c.is_ascii_digit()))
    {
        rest = &rest[1..];
    }
    let lower: Vec<String> = rest.iter().map(|w| w.to_lowercase()).collect();
    if lower.first().is_some_and(|w| w == "as")
        && let Some(i) = lower.windows(2).position(|p| p[0] == "i" && p[1] == "can")
        && i + 2 < rest.len()
    {
        rest = &rest[i + 2..];
    }
    let kept: Vec<String> = rest
        .iter()
        .filter(|w| !SMALL.contains(&w.to_lowercase().as_str()))
        .cloned()
        .collect();
    if kept.is_empty() { rest.to_vec() } else { kept }
}

/// A title's letters, best first: the first letters of its first two words (one word: its first
/// two letters), its first word's first two letters, then its first letter and each consonant
/// after it.
pub fn letter_choices(title: &str) -> Vec<String> {
    let words = words(title);
    let Some(first) = words.first() else {
        return vec!["?".into()];
    };
    let chars: Vec<char> = first.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        let s = s.to_uppercase();
        if !out.contains(&s) {
            out.push(s);
        }
    };
    match words.get(1).and_then(|w| w.chars().next()) {
        Some(second) => push(format!("{}{second}", chars[0])),
        None => push(chars.iter().take(2).collect()),
    }
    push(chars.iter().take(2).collect());
    for c in chars.iter().skip(1) {
        if c.is_alphabetic() && !"aeiouyåäöAEIOUYÅÄÖ".contains(*c) {
            push(format!("{}{c}", chars[0]));
        }
    }
    out
}

/// Each open card tile's letters, in open order: its best choice no tile before it has (all
/// taken: its best).
pub fn letters(titles: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in titles {
        let choices = letter_choices(t);
        let pick = choices
            .iter()
            .find(|c| !out.contains(c))
            .unwrap_or(&choices[0])
            .clone();
        out.push(pick);
    }
    out
}

/// Each open repo's name, by its main checkout's folder (`mains`, in open order): the folder's
/// name; two open repos whose folders share it say their parent folder too (`b/repo`).
pub fn repo_names(mains: &[&Path]) -> Vec<String> {
    let name = |p: &Path| {
        p.file_name().map_or_else(
            || p.display().to_string(),
            |n| n.to_string_lossy().into_owned(),
        )
    };
    mains
        .iter()
        .map(|m| {
            let own = name(m);
            let shared = mains.iter().any(|o| o != m && name(o) == own);
            match m.parent().and_then(Path::file_name) {
                Some(parent) if shared => format!("{}/{own}", parent.to_string_lossy()),
                _ => own,
            }
        })
        .collect()
}

/// Each open card tile's colour (an index into [`HUES`]), by its key in open order: the one it
/// kept while open, unless a tile before it has that one; else the first no open tile has (all
/// taken: the one fewest have).
pub fn hues<K>(keys: &[K], kept: impl Fn(&K) -> Option<usize>) -> Vec<usize> {
    let mut out: Vec<Option<usize>> = Vec::with_capacity(keys.len());
    for k in keys {
        let mine = kept(k).filter(|h| *h < HUES.len() && !out.contains(&Some(*h)));
        out.push(mine);
    }
    let mut count = [0usize; HUES.len()];
    for h in out.iter().flatten() {
        count[*h] += 1;
    }
    out.into_iter()
        .map(|h| {
            h.unwrap_or_else(|| {
                let least = (0..HUES.len()).min_by_key(|&i| (count[i], i)).unwrap_or(0);
                count[least] += 1;
                least
            })
        })
        .collect()
}

/// The stage bar's five colours (Spec · Build · Review · PR · Done, as the StageRail): the
/// stages done in the tint, the one it is on in its state's colour (idle: the tint, dimmer),
/// the rest faint; a done card all green. No stage yet: its state on the first; no look: all
/// faint.
pub fn bar(state: Option<WorkspaceState>, rail: &[Segment], tint: Rgba) -> [Rgba; 5] {
    bar_in(
        state,
        rail,
        [faded(tint, 0.7), faded(tint, 0.22), faded(tint, 0.45)],
    )
}

/// The hover card's stage bar: the stages done green, the rest faint, idle dim.
pub fn tip_bar(state: Option<WorkspaceState>, rail: &[Segment]) -> [Rgba; 5] {
    bar_in(
        state,
        rail,
        [
            look::ABE_GOOD.rgba(),
            faded(look::TEXT_DIM.rgba(), 0.35),
            look::TEXT_DIM.rgba(),
        ],
    )
}

/// The bar with `[done, to do, idle]` for the stages that are not in a state's colour.
fn bar_in(
    state: Option<WorkspaceState>,
    rail: &[Segment],
    [done, todo, idle]: [Rgba; 3],
) -> [Rgba; 5] {
    use WorkspaceState as W;
    if state == Some(W::Done) {
        return [look::ABE_GOOD.rgba(); 5];
    }
    let now = match state {
        Some(W::NeedsYou) => look::ABE_NEEDS_YOU.rgba(),
        Some(W::Running) => look::ABE_WARN.rgba(),
        Some(W::Failed) => look::ABE_BAD.rgba(),
        Some(W::Starting) => look::ABE_ACCENT.rgba(),
        _ => idle,
    };
    let mut out = [todo; 5];
    for (i, s) in rail.iter().take(5).enumerate() {
        out[i] = match s {
            Segment::Todo => todo,
            Segment::Done => done,
            _ => now,
        };
    }
    // no stage yet (a plain session, a queued run): the state on the first
    if state.is_some() && rail.iter().all(|s| *s == Segment::Todo) {
        out[0] = now;
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn a_tile_s_letters_come_from_its_title_never_twice_on_the_rail() {
        for (title, want) in [
            ("As a visitor I can reset my password", "RP"),
            ("Sign in with an email link", "SE"),
            ("Cart total ignores quantity", "CT"),
            ("#2 The cart total ignores quantity", "CT"),
            ("Refactor", "RE"),
            ("the", "TH"),
            ("", "?"),
        ] {
            assert_eq!(letter_choices(title)[0], want, "{title}");
        }
        // the later one gives way: its first word's two letters, then a consonant after
        assert_eq!(
            letters(&[
                "Saved carts survive sign-out",
                "Show stock on a product page",
                "Shipping stops",
                "Shout"
            ]),
            ["SC", "SS", "SH", "ST"]
        );
        assert_eq!(letters(&["Shout", "Sh"]), ["SH", "SH"]);
    }

    #[test]
    fn a_repo_is_its_folder_s_name_with_its_parent_s_when_another_open_one_shares_it() {
        for (mains, want) in [
            (vec!["/p/demo-shop"], vec!["demo-shop"]),
            (vec!["/p/demo-shop", "/q/kiosk"], vec!["demo-shop", "kiosk"]),
            (
                vec!["/x/repo", "/q/kiosk", "/y/repo"],
                vec!["x/repo", "kiosk", "y/repo"],
            ),
        ] {
            let mains: Vec<&Path> = mains.iter().map(Path::new).collect();
            assert_eq!(repo_names(&mains), want, "{mains:?}");
        }
        // the rail's face: two letters from the name, never two repos alike
        assert_eq!(letters(&["x/repo", "kiosk", "y/repo"]), ["XR", "KI", "YR"]);
    }

    #[test]
    fn a_card_keeps_its_colour_a_new_one_takes_the_first_free() {
        let k = |s: &str| s.to_owned();
        let kept = HashMap::from([(k("/b"), 0), (k("/c"), 0), (k("/d"), 9)]);
        // /a new takes 1 (0 is /b's); /c's 0 is /b's already, so /c takes 2; /d's is no colour
        assert_eq!(
            hues(&[k("/a"), k("/b"), k("/c"), k("/d")], |k| kept
                .get(k)
                .copied()),
            [1, 0, 2, 3]
        );
        // all seven taken: the one fewest have
        let eight: Vec<String> = (0..9).map(|i| format!("/{i}")).collect();
        assert_eq!(hues(&eight, |_| None), [0, 1, 2, 3, 4, 5, 6, 0, 1]);
    }

    #[test]
    fn the_stage_bar_shows_where_the_run_is_in_its_state_s_colour() {
        use Segment::{Done, Need, Now, Todo};
        let tint = HUES[0].1;
        let faint = faded(tint, 0.22);
        let done = faded(tint, 0.7);
        let rail = [Done, Now, Todo, Todo, Todo];
        let warn = look::ABE_WARN.rgba();
        assert_eq!(
            bar(Some(WorkspaceState::Running), &rail, tint),
            [done, warn, faint, faint, faint]
        );
        let teal = look::ABE_NEEDS_YOU.rgba();
        assert_eq!(
            bar(
                Some(WorkspaceState::NeedsYou),
                &[Need, Todo, Todo, Todo, Todo],
                tint
            )[0],
            teal
        );
        assert_eq!(
            bar(Some(WorkspaceState::Done), &[Done; 5], tint),
            [look::ABE_GOOD.rgba(); 5]
        );
        assert_eq!(bar(None, &[], tint), [faint; 5]);
        // no stage yet: the state on the first
        assert_eq!(
            bar(Some(WorkspaceState::Running), &[Todo; 5], tint),
            [warn, faint, faint, faint, faint]
        );
    }
}
