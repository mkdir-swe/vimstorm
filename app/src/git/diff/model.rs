//! The viewer description Lua sends (`config/app/diff.lua`, `vimstorm.diff`).

use rmpv::Value;
use serde::{Deserialize, Deserializer};

/// `vimstorm.diff` events.
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DiffEvent {
    /// The open viewer, whenever something shown changed.
    Viewer(Box<Viewer>),
    /// No viewer anymore.
    Close,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerKind {
    #[default]
    Diff,
    Merge,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Viewer {
    /// Description number: gutter actions carry it back (Lua drops a click on a stale one).
    #[serde(rename = "gen")]
    pub generation: i64,
    pub viewer: ViewerKind,
    /// Left to right.
    #[serde(deserialize_with = "seq")]
    pub panes: Vec<Pane>,
    /// `dividers[i]`: the changes between panes i and i + 1.
    #[serde(deserialize_with = "seq_of_seq")]
    pub dividers: Vec<Vec<Change>>,
    pub toolbar: Toolbar,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Pane {
    pub win: i64,
    pub title: Title,
    /// The buffer's line count.
    pub lines: i64,
    /// A PR diff: the lines with a review comment drafted, a comment mark each.
    #[serde(default, deserialize_with = "seq")]
    pub drafts: Vec<Drafted>,
    /// A PR diff: the review cards under their lines (G15 / G22), the rows Lua keeps for each.
    #[serde(default, deserialize_with = "seq")]
    pub cards: Vec<CardSlot>,
}

/// A review card's place: under `line`, `rows` blank rows kept for it (the other pane keeps as
/// many where the line maps). A posted thread names its `id`, a draft its `seq`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct CardSlot {
    /// `thread`, `draft`, `outdated` or `writing` (G21: the card a comment is written in).
    pub kind: String,
    pub line: i64,
    pub rows: i64,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub seq: Option<u64>,
    /// The writing card's token (`config/app/review.lua`'s, answered with `done`).
    #[serde(default)]
    pub token: Option<u64>,
}

/// A line with a review comment drafted on it: the gutter's comment mark, its body the tooltip.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Drafted {
    pub line: i64,
    #[serde(default)]
    pub body: String,
}

/// A pane's header: lock + 8-char hash + path, or a text ("Current version", "Result", ...).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Title {
    #[serde(default)]
    pub lock: bool,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// Buffer lines `[s, e)`, 1-based; `s == e`: none, the boundary above line `s`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Lines {
    pub s: i64,
    pub e: i64,
}

impl Lines {
    pub fn is_empty(&self) -> bool {
        self.e <= self.s
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// Lines only on the right side.
    Inserted,
    /// Lines only on the left side.
    Deleted,
    #[default]
    Modified,
    Conflict,
}

/// One change between two neighbouring panes: its lines on the left (`a`) and right (`b`) side.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Change {
    pub a: Lines,
    pub b: Lines,
    pub kind: ChangeKind,
    #[serde(default, deserialize_with = "seq")]
    pub actions: Vec<Action>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GutterIcon {
    /// » on the left side: its text to the right (revert / accept yours).
    Revert,
    AcceptLeft,
    /// « on the right side.
    AcceptRight,
    /// × ignore.
    Ignore,
    /// Magic wand: resolve automatically.
    Magic,
    /// A PR diff's drafted review comment (not from Lua's actions: the panes' `drafts`).
    Comment,
}

/// A gutter icon of a change: drawn in pane `pane` (1-based) at its side's lines; a click calls
/// Lua's `action(gen, action, args...)`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Action {
    pub pane: usize,
    pub icon: GutterIcon,
    pub action: String,
    #[serde(default, deserialize_with = "seq")]
    pub args: Vec<Value>,
    #[serde(default)]
    pub tip: String,
}

/// Toolbar state (diff fields / merge fields).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct Toolbar {
    /// Diff: (index, count) of the files it steps through.
    #[serde(default)]
    pub files: Option<(i64, i64)>,
    #[serde(default)]
    pub differences: Option<i64>,
    #[serde(default)]
    pub ignore: String,
    #[serde(default)]
    pub highlight: String,
    /// Merge: unresolved conflicts, all conflicts, ones "Resolve simple conflicts" can do.
    #[serde(default)]
    pub conflicts: Option<i64>,
    #[serde(default)]
    pub total: Option<i64>,
    #[serde(default)]
    pub simple: Option<i64>,
    /// Merge: changes not yet applied that aren't conflicts (Lua applies them itself: 0).
    #[serde(default)]
    pub changes: Option<i64>,
    /// Unchanged code folded (Collapse Unchanged Fragments).
    #[serde(default)]
    pub collapsed: bool,
    /// The panes scroll together (Synchronize Scrolling).
    #[serde(default)]
    pub synced: bool,
    /// A PR diff (1.0, G25): the PR and the file shown; the toolbar adds `#n`, the scope switch
    /// and Reviewed.
    #[serde(default)]
    pub review: Option<ReviewBar>,
}

/// A PR diff's toolbar part, as Lua names it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ReviewBar {
    pub pr: u64,
    pub path: String,
}

/// A Lua list: an array, or `{}` (an empty table may arrive as an empty map).
fn seq<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SeqOrMap<T> {
        Seq(Vec<T>),
        Map(std::collections::BTreeMap<String, Value>),
    }
    match SeqOrMap::<T>::deserialize(d)? {
        SeqOrMap::Seq(v) => Ok(v),
        SeqOrMap::Map(m) if m.is_empty() => Ok(Vec::new()),
        SeqOrMap::Map(_) => Err(serde::de::Error::custom("expected a list")),
    }
}

fn seq_of_seq<'de, D>(d: D) -> Result<Vec<Vec<Change>>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    struct Inner(#[serde(deserialize_with = "seq")] Vec<Change>);
    Ok(seq::<D, Inner>(d)?.into_iter().map(|i| i.0).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: Vec<(&str, Value)>) -> Value {
        Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    fn lines(s: i64, e: i64) -> Value {
        map(vec![("s", s.into()), ("e", e.into())])
    }

    #[test]
    fn decodes_a_diff_description_with_empty_lua_tables() {
        let pane = |win: i64| {
            map(vec![
                ("win", win.into()),
                (
                    "title",
                    map(vec![("lock", true.into()), ("hash", "c9e3a627".into())]),
                ),
                ("lines", 6.into()),
            ])
        };
        let change = map(vec![
            ("a", lines(2, 3)),
            ("b", lines(2, 3)),
            ("kind", "modified".into()),
            (
                "actions",
                Value::Array(vec![map(vec![
                    ("pane", 1.into()),
                    ("icon", "revert".into()),
                    ("action", "revert".into()),
                    ("args", Value::Array(vec![1.into()])),
                    ("tip", "Revert".into()),
                ])]),
            ),
        ]);
        let payload = map(vec![
            ("event", "viewer".into()),
            ("gen", 3.into()),
            ("viewer", "diff".into()),
            ("panes", Value::Array(vec![pane(1000), pane(1001)])),
            (
                "dividers",
                Value::Array(vec![Value::Array(vec![change]), Value::Map(vec![])]),
            ),
            (
                "toolbar",
                map(vec![
                    ("files", Value::Array(vec![2.into(), 4.into()])),
                    ("differences", 3.into()),
                    ("ignore", "Do not ignore".into()),
                    ("highlight", "Highlight words".into()),
                ]),
            ),
        ]);
        let Some(DiffEvent::Viewer(v)) = crate::nvim::lua::decode::<DiffEvent>("diff", payload)
        else {
            panic!("not decoded");
        };
        assert_eq!(v.generation, 3);
        assert_eq!(v.panes.len(), 2);
        assert_eq!(v.panes[0].title.hash.as_deref(), Some("c9e3a627"));
        assert_eq!(v.dividers.len(), 2);
        assert!(v.dividers[1].is_empty());
        let c = &v.dividers[0][0];
        assert_eq!((c.a.s, c.a.e, c.kind), (2, 3, ChangeKind::Modified));
        assert_eq!(c.actions[0].icon, GutterIcon::Revert);
        assert_eq!(v.toolbar.files, Some((2, 4)));
        let close = map(vec![("event", "close".into())]);
        assert!(matches!(
            crate::nvim::lua::decode::<DiffEvent>("diff", close),
            Some(DiffEvent::Close)
        ));
    }
}
