//! The header's one feed (B Signal): the bridge's `workspaces` effect, every story
//! workspace's look as TypeScript decided it (`abe/packages/ui/src/board/workspaces.ts`), drawn by the
//! strip's tabs (state dot, `#id short title`, the cloud, the StageRail), the toolbar's context
//! line (badges), the tree's root row, the status bar's crumb and the empty editor's caption.
//! Rust only matches its open projects to the looks (a cloud workspace by its box, a local one by
//! its folder: [`resolve`]) and draws; a project no look names is the main checkout (or one whose
//! session is not known yet): its folder's name, or the story its branch names
//! ([`story_of_branch`]), no dot, no rail.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Bounds, Global, IntoElement, ParentElement as _, PathBuilder, Pixels, Rgba,
    SharedString, Styled as _, Window, canvas, div, point, px,
};

use super::board::Segment;
use super::draw;
use super::protocol::{Chip, CloudState, FactoryLine, Hue, WorkspaceLook, WorkspaceState};
use crate::look;

/// What the bridge last said of the workspaces; absent until it first spoke (no `abe` 2.0: the
/// toolbar keeps the window title).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkspaceFeed {
    pub workspaces: Vec<WorkspaceLook>,
    pub factory: FactoryLine,
    /// `serve` answers the screen's reads.
    pub answering: bool,
    /// The main checkouts whose Abe chat waits on you (the Abe tile's teal dot).
    pub abe_needs_you: Vec<String>,
    /// Every prototype not done with, in the bridge's order: the rail's prototype tiles.
    pub prototypes: Vec<super::protocol::PrototypeLook>,
    /// The bridge died after its one restart: nothing it said is current.
    pub bridge_down: bool,
}

impl Global for WorkspaceFeed {}

impl WorkspaceFeed {
    /// The toolbar says `abe serve not answering` (dim) in the context line's place.
    pub fn down(&self) -> bool {
        self.bridge_down || !self.answering
    }
}

/// The open main checkouts whose folder's name another open repo's shares, by folder: the name
/// that tells them apart (`b/repo`), set by the projects window ([`plain_line`]).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RepoNames(pub HashMap<PathBuf, String>);

impl Global for RepoNames {}

/// The open projects' looks by their folder, resolved from the feed by the projects window as
/// either changes: what every surface of a project reads ([`look_of`]).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShownWorkspaces(pub HashMap<PathBuf, WorkspaceLook>);

impl Global for ShownWorkspaces {}

/// Each open project's look: a cloud one (`box`) the look on its box, a local one the look whose
/// folder it is; none for the rest.
pub fn resolve(
    looks: &[WorkspaceLook],
    open: &[(PathBuf, Option<String>)],
) -> HashMap<PathBuf, WorkspaceLook> {
    // each folder's links resolved once (not per look and project): the same folder either way
    let roots: Vec<Option<PathBuf>> = looks
        .iter()
        .map(|l| {
            l.box_
                .is_none()
                .then(|| crate::shell::real_path(Path::new(&l.root)))
        })
        .collect();
    open.iter()
        .filter_map(|(dir, box_)| {
            let real = box_.is_none().then(|| crate::shell::real_path(dir));
            let found = looks.iter().zip(&roots).find_map(|(l, root)| {
                let same = match (box_, root) {
                    (Some(b), _) => l.box_.as_deref() == Some(b.as_str()),
                    (None, Some(root)) => Path::new(&l.root) == dir || real.as_ref() == Some(root),
                    (None, None) => false,
                };
                same.then_some(l)
            })?;
            Some((dir.clone(), found.clone()))
        })
        .collect()
}

/// The look of the open project at `dir`, if the feed names it.
pub fn look_of<'a>(dir: &Path, cx: &'a App) -> Option<&'a WorkspaceLook> {
    cx.try_global::<ShownWorkspaces>()?.0.get(dir)
}

/// The state the feed says for the project at `dir` (a cloud one by its `box_`), read from the
/// feed itself: a project opened this frame is in [`ShownWorkspaces`] only once the window drew.
pub fn feed_state_of(dir: &Path, box_: Option<&str>, cx: &App) -> Option<WorkspaceState> {
    if let Some(l) = look_of(dir, cx) {
        return Some(l.state);
    }
    let feed = cx.try_global::<WorkspaceFeed>().filter(|f| !f.down())?;
    resolve(
        &feed.workspaces,
        &[(dir.to_path_buf(), box_.map(str::to_owned))],
    )
    .remove(dir)
    .map(|l| l.state)
}

/// The story a branch names (`card/2-the-cart-total-ignores-quantity` →
/// `#2 cart total ignores quantity`): a workspace's tab while its session is not known yet.
pub fn story_of_branch(branch: &str) -> Option<String> {
    let rest = branch.strip_prefix("card/")?;
    let (id, slug) = rest.split_once('-')?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut words: Vec<&str> = slug.split('-').filter(|w| !w.is_empty()).collect();
    if words.len() > 1 && matches!(words[0], "the" | "a" | "an") {
        words.remove(0);
    }
    (!words.is_empty()).then(|| format!("#{id} {}", words.join(" ")))
}

/// A cloud's colour by the hue the bridge gave it (the accent when it gave none).
pub fn cloud_color(hue: Option<Hue>) -> Rgba {
    hue.map_or(look::ABE_ACCENT.rgba(), draw::hue)
}

/// The cloud glyph (the boards' 12-unit path), filled while its box runs, an outline asleep,
/// dashed while it starts, in `color`.
pub fn cloud(state: CloudState, size: f32, color: Rgba) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |b: Bounds<Pixels>, _, window: &mut Window, _| {
            let s = size / 12.;
            let o = b.origin;
            let p = |x: f32, y: f32| point(o.x + px(x * s), o.y + px(y * s));
            let shape = |mut pb: PathBuilder| {
                pb.move_to(p(3.15, 9.5));
                pb.arc_to(
                    point(px(2.25 * s), px(2.25 * s)),
                    px(0.),
                    false,
                    true,
                    p(2.95, 5.01),
                );
                pb.arc_to(
                    point(px(3. * s), px(3. * s)),
                    px(0.),
                    false,
                    true,
                    p(8.55, 4.15),
                );
                pb.arc_to(
                    point(px(2.35 * s), px(2.35 * s)),
                    px(0.),
                    false,
                    true,
                    p(8.65, 9.5),
                );
                pb.close();
                pb
            };
            let stroke = px(1.5 * s);
            if state == CloudState::Running
                && let Ok(path) = shape(PathBuilder::fill()).build()
            {
                window.paint_path(path, color);
            }
            let line = match state {
                CloudState::Starting => {
                    PathBuilder::stroke(stroke).dash_array(&[px(2. * s), px(1.6 * s)])
                }
                _ => PathBuilder::stroke(stroke),
            };
            if let Ok(path) = shape(line).build() {
                window.paint_path(path, color);
            }
        },
    )
    .flex_none()
    .w(px(size))
    .h(px(size))
    .into_any_element()
}

/// The 2 px StageRail under a tab's name: its segments share the width, 2 px apart.
pub fn tab_rail(segments: &[Segment]) -> gpui_kit::Div {
    div()
        .flex_none()
        .w_full()
        .h(px(2.))
        .flex()
        .gap(px(2.))
        .children(segments.iter().map(|s| {
            div()
                .flex_1()
                .h(px(2.))
                .rounded(px(1.))
                .bg(super::board::segment_color(*s))
        }))
}

/// One context line badge: 20 high, its hue's words on the hue at 16 %, radius 4, a box's cloud
/// before the words. Local mode's (LM-Board): no wash, dashed in the path hue, its words in
/// it after the house mark.
pub fn badge(chip: &Chip) -> gpui_kit::Div {
    if chip.local {
        return div()
            .flex_none()
            .h(px(20.))
            .px(px(5.))
            .flex()
            .items_center()
            .gap(px(super::local::HOUSE_GAP))
            .rounded(px(look::TAB_ARC.get()))
            .border_1()
            .border_dashed()
            .border_color(look::ABE_PATH)
            .text_color(look::ABE_PATH)
            .text_size(px(look::TAB_FONT_SIZE.get()))
            .whitespace_nowrap()
            .child(super::local::house(
                super::local::HOUSE,
                look::ABE_PATH.rgba(),
            ))
            .child(SharedString::from(chip.text.clone()));
    }
    let color = draw::hue(chip.hue);
    div()
        .flex_none()
        .h(px(20.))
        .px(px(5.))
        .flex()
        .items_center()
        .gap(px(5.))
        .rounded(px(look::TAB_ARC.get()))
        .bg(look::abe_badge_bg(color))
        .text_color(color)
        .text_size(px(look::TAB_FONT_SIZE.get()))
        .whitespace_nowrap()
        .when_some(chip.cloud, |d, c| d.child(cloud(c, 12., color)))
        .child(SharedString::from(chip.text.clone()))
}

/// What the toolbar's centre says.
#[derive(Clone, Debug, PartialEq)]
pub enum ContextLine {
    /// No `abe` 2.0 spoke: the window title, as before.
    Title,
    /// The bridge or `serve` is down: `abe serve not answering`, dim.
    Down,
    /// The Factory view's: `Factory` then its badges.
    Factory(FactoryLine),
    /// A workspace's badges and how they read whole.
    Badges { chips: Vec<Chip>, label: String },
}

/// Whether `dir` is a linked worktree (its `.git` a file), read once per checkout (the toolbar
/// asks every frame; a checkout stays what it is): a dir with no `.git` yet is read again.
fn linked(dir: &Path) -> bool {
    thread_local! {
        static LINKED: std::cell::RefCell<std::collections::HashMap<std::path::PathBuf, bool>> =
            std::cell::RefCell::default();
    }
    if let Some(known) = LINKED.with_borrow(|l| l.get(dir).copied()) {
        return known;
    }
    let git = dir.join(".git");
    let linked = git.is_file();
    if linked || git.is_dir() {
        LINKED.with_borrow_mut(|l| l.insert(dir.to_path_buf(), linked));
    }
    linked
}

/// The name of a project no look names: a linked worktree's or a box's the story its branch
/// names, else (the main checkout) its folder's.
pub fn plain_name(dir: &Path, branch: &str, remote: bool) -> String {
    let story = (remote || linked(dir))
        .then(|| story_of_branch(branch))
        .flatten();
    story.unwrap_or_else(|| {
        dir.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    })
}

/// The words of a line no look names: the main checkout's `demo-shop · main` (the folder's name,
/// or `named` that tells two open repos apart, in the accent, the branch dim), or the story a
/// worktree's branch names.
pub fn plain_line(
    dir: &Path,
    branch: &str,
    remote: bool,
    named: Option<&str>,
) -> (Vec<Chip>, String) {
    let chip = |text: String, hue| Chip {
        text,
        hue,
        cloud: None,
        id: None,
        local: false,
    };
    let name = named.map_or_else(|| plain_name(dir, branch, remote), str::to_owned);
    let mut chips = vec![chip(name.clone(), Hue::Accent)];
    if !branch.is_empty() {
        chips.push(chip(branch.to_owned(), Hue::Dim));
    }
    let label = if branch.is_empty() {
        format!("Linked: {name}")
    } else {
        format!("Linked: {name}, {branch}")
    };
    (chips, label)
}

/// The toolbar's centre for the project at `dir` (`branch` its checked-out branch, as the status
/// line knows it), `factory` while the Factory view is shown.
pub fn context_line(
    dir: &Path,
    branch: &str,
    remote: bool,
    factory: bool,
    cx: &App,
) -> ContextLine {
    let Some(feed) = cx.try_global::<WorkspaceFeed>() else {
        return ContextLine::Title;
    };
    if feed.down() {
        return ContextLine::Down;
    }
    if factory {
        return ContextLine::Factory(feed.factory.clone());
    }
    match look_of(dir, cx) {
        Some(look) => ContextLine::Badges {
            chips: look.line.clone(),
            label: look.label.clone(),
        },
        None => {
            let named = cx.try_global::<RepoNames>().and_then(|n| n.0.get(dir));
            let (chips, label) = plain_line(dir, branch, remote, named.map(String::as_str));
            ContextLine::Badges { chips, label }
        }
    }
}

/// What a workspace tab of the strip draws: its words and hover, then (a story's) the dot, the
/// rail, the cloud and the selected tint's state.
#[derive(Clone, Debug, PartialEq)]
pub struct TabParts {
    pub name: String,
    pub tooltip: String,
    pub state: Option<WorkspaceState>,
    /// The dot's mark and hue (the tint's too).
    pub dot: Option<(String, Hue)>,
    pub rail: Vec<Segment>,
    pub cloud: Option<(CloudState, Option<Hue>)>,
}

impl TabParts {
    /// A look's tab, else a plain one: `fallback` (the folder's name or its branch's story), no
    /// dot, no rail (Behaviour 9: a session not known yet).
    pub fn of(look: Option<&WorkspaceLook>, fallback: String) -> Self {
        match look {
            Some(l) => TabParts {
                name: l.tab.clone(),
                tooltip: l.tooltip.clone(),
                state: Some(l.state),
                dot: Some((l.dot.mark.clone(), l.dot.hue)),
                rail: l.rail.clone(),
                cloud: l.cloud.map(|c| (c, l.cloud_hue)),
            },
            None => TabParts {
                tooltip: fallback.clone(),
                name: fallback,
                state: None,
                dot: None,
                rail: Vec::new(),
                cloud: None,
            },
        }
    }
}

/// Each open project's folder and, a cloud workspace's, its box.
pub type OpenProjects = Vec<(PathBuf, Option<String>)>;

/// Keeps [`ShownWorkspaces`] and the empty editor's [`crate::editor::tabs::StoryLines`] in step with the
/// feed and the open projects (the projects window's, synced as it draws). While the bridge or
/// `serve` is down nothing it said counts: no look, no dot (Behaviour 9).
#[derive(Default)]
pub struct Resolver {
    seen: Option<(Option<WorkspaceFeed>, OpenProjects)>,
}

impl Resolver {
    /// `open`: each open project's folder and, a cloud workspace's, its box.
    pub fn sync(&mut self, open: OpenProjects, cx: &mut App) {
        // drawn each frame: the feed cloned only when it changed
        let feed = cx.try_global::<WorkspaceFeed>();
        if self
            .seen
            .as_ref()
            .is_some_and(|(f, o)| f.as_ref() == feed && *o == open)
        {
            return;
        }
        let now = (feed.cloned(), open);
        let (feed, open) = &now;
        let shown = ShownWorkspaces(
            feed.as_ref()
                .filter(|f| !f.down())
                .map(|f| resolve(&f.workspaces, open))
                .unwrap_or_default(),
        );
        let lines = crate::editor::tabs::StoryLines(
            shown
                .0
                .iter()
                .map(|(dir, l)| {
                    let spans = l
                        .caption
                        .iter()
                        .map(|s| crate::editor::tabs::LineSpan {
                            text: s.text.clone(),
                            hue: s.hue.map(draw::hue),
                        })
                        .collect();
                    (dir.clone(), spans)
                })
                .collect(),
        );
        if cx.try_global::<ShownWorkspaces>() != Some(&shown) {
            cx.set_global(shown);
        }
        if cx.try_global::<crate::editor::tabs::StoryLines>() != Some(&lines) {
            cx.set_global(lines);
        }
        self.seen = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_story_branch_names_its_story() {
        assert_eq!(
            story_of_branch("card/2-the-cart-total-ignores-quantity").as_deref(),
            Some("#2 cart total ignores quantity")
        );
        assert_eq!(
            story_of_branch("card/3-pin-the-node-version").as_deref(),
            Some("#3 pin the node version")
        );
        assert_eq!(story_of_branch("main"), None);
        assert_eq!(story_of_branch("card/x-y"), None);
    }

    #[test]
    fn a_main_checkout_s_line_is_its_folder_or_the_name_that_tells_two_repos_apart() {
        let words = |named| {
            let (chips, label) = plain_line(Path::new("/y/repo"), "main", false, named);
            let texts: Vec<String> = chips.into_iter().map(|c| c.text).collect();
            (texts, label)
        };
        assert_eq!(
            words(None),
            (
                vec!["repo".into(), "main".into()],
                "Linked: repo, main".into()
            )
        );
        assert_eq!(
            words(Some("y/repo")),
            (
                vec!["y/repo".into(), "main".into()],
                "Linked: y/repo, main".into()
            )
        );
    }

    #[test]
    fn a_badge_is_local_modes_only_when_it_says_so() {
        for (json, local) in [
            (
                r#"{"text":"Local mode · nothing written","hue":"dim","local":true}"#,
                true,
            ),
            (r#"{"text":"demo-shop","hue":"accent"}"#, false),
        ] {
            let chip: Chip = serde_json::from_str(json).unwrap();
            assert_eq!(chip.local, local, "{json}");
        }
    }
}
