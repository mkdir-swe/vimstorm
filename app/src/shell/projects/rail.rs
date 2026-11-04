//! The rail (README "Layout"): the window's left edge, one tile per open workspace and the
//! repo's places. Abe (the repo's main checkout) is first, each card's workspace below it in the
//! order it opened (its state lights a tile, never moves it), then the places: Board, Boxes,
//! Pipelines. ⌘↑ / ⌘↓ walk the group the tile is in, round again from either end ([`step`]): the
//! workspaces, or the places. ⌘← goes down to the places (the Board), ⌘→ back up to the workspaces.
//!
//! Abe's face is an `A`; while several repos are open each main checkout's says its repo's
//! letters, and the hovers, the header and the window title name the repo ([`tiles::repo_names`]).
//!
//! A card's tile shows two letters from its title on the card's own colour ([`super::tiles`]) and
//! under them the stage bar: Spec · Build · Review · PR · Done, the stages done in the tint, the
//! one it is on in its state's colour (amber running, teal needs you, red failed, dim idle; a done
//! card all green; pulsing while it launches); needs you also puts a teal dot on its top right
//! corner (Abe's while its Abe chat asks you something), a ☁ on its top left when it runs on a box.
//! Nothing blinks. The selected tile has a white pill at the rail's left edge (a short one on
//! hover). The hover card says its letters, `#id`, its title, the stage bar with the stage and
//! state word, where it runs and the page it is on. A click moves to it; a right-click (⌘⏎ over
//! it) is its menu: Story, Open in Finder, Stop the session…, Delete Working Files…, Close the
//! workspace. `+` makes a new one: the Board on New card. Too many to fit: the cards scroll by the
//! selected one, Abe and the places stay, and a line says `N below` (a teal `?` before it when one
//! out of view needs you).
//!
//! Every move ([`Projects::go`]) lands with the tile's Chat as it was left and the keys where they
//! were as it was left ([`super::memory`]): in Chat's composer (Claude Code's terminal in that
//! mode), or on the page (the Board's, Boxes' or Pipelines' list, Run, the Card page, the code
//! where nvim had them), a workspace's by its page. A first visit's: Chat's (the page's when Chat
//! is hidden there). The header's row right of
//! the rail names the tile and, on a workspace, its pages ([`super::pages`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, App, Context, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    Keystroke, MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div, prelude::FluentBuilder as _, px,
};

use super::Projects;
use super::pages::{CARD_SCREEN, Page};
use super::tiles;
use crate::factory::{RUN_SCREEN, WorkspaceState};
use crate::kit::Anchor;
use crate::look;
use crate::popups::{self, Menu};
use crate::shell::column;
use crate::shell::layout::FRAME_BG;
use crate::shell::pane::PaneTab;

/// The rail's width at the window's left edge: the islands start right of it.
pub const RAIL_WIDTH: f32 = 52.;

/// A tile on the rail.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Tile {
    /// An open workspace, by its real folder (Abe: the repo's main checkout).
    Workspace(PathBuf),
    /// A prototype not done with, by its id ([`super::protos`]): in the workspaces' group.
    Prototype(String),
    Board,
    Boxes,
    Pipelines,
}

/// The repo's places at the rail's foot, in order.
pub const PLACES: [Tile; 3] = [Tile::Board, Tile::Boxes, Tile::Pipelines];

impl Tile {
    /// Its key in the kept memory ([`super::memory`]): a workspace's real folder, a place's name.
    pub fn key(&self) -> String {
        match self {
            Tile::Workspace(real) => real.display().to_string(),
            Tile::Prototype(id) => format!("proto:{id}"),
            Tile::Board => "board".into(),
            Tile::Boxes => "boxes".into(),
            Tile::Pipelines => "pipelines".into(),
        }
    }

    /// The tile [`Self::key`] is the key of.
    pub fn from_key(key: &str) -> Tile {
        match key {
            "board" => Tile::Board,
            "boxes" => Tile::Boxes,
            "pipelines" => Tile::Pipelines,
            k => match k.strip_prefix("proto:") {
                Some(id) => Tile::Prototype(id.to_owned()),
                None => Tile::Workspace(PathBuf::from(k)),
            },
        }
    }

    /// A repo place (Board, Boxes, Pipelines), not a workspace or a prototype.
    pub fn is_place(&self) -> bool {
        !matches!(self, Tile::Workspace(_) | Tile::Prototype(_))
    }

    /// Its name on the header and in the hover.
    pub fn place_name(&self) -> Option<&'static str> {
        match self {
            Tile::Workspace(_) | Tile::Prototype(_) => None,
            Tile::Board => Some("Board"),
            Tile::Boxes => Some("Boxes"),
            Tile::Pipelines => Some("Pipelines"),
        }
    }
}

/// The rail top to bottom for the open workspaces (`(real folder, is the main checkout)`, in open
/// order) and the prototypes (their ids, in their tiles' order): the first main checkout (Abe),
/// the others as they opened, the prototypes, then [`PLACES`].
pub fn ring(open: &[(PathBuf, bool)], prototypes: &[String]) -> Vec<Tile> {
    let main = open.iter().position(|(_, m)| *m);
    main.into_iter()
        .chain((0..open.len()).filter(|&i| Some(i) != main))
        .map(|i| Tile::Workspace(open[i].0.clone()))
        .chain(prototypes.iter().cloned().map(Tile::Prototype))
        .chain(PLACES)
        .collect()
}

/// The tile `by` from `at` on `ring` (−1 the one above) in `at`'s own group, round again past
/// either end: from a place the places (Board, Boxes, Pipelines), else the workspaces; from a
/// workspace not among them (one just closed), ↓ is the first and ↑ the last.
pub fn step(ring: &[Tile], at: &Tile, by: isize) -> Option<Tile> {
    let place = at.is_place();
    let ws: Vec<&Tile> = ring.iter().filter(|t| t.is_place() == place).collect();
    let n = ws.len() as isize;
    if n == 0 {
        return None;
    }
    let from = match ws.iter().position(|t| *t == at) {
        Some(i) => i as isize,
        None if by > 0 => -1,
        None => 0,
    };
    Some(ws[(from + by).rem_euclid(n) as usize].clone())
}

/// ⌘§ from `at`: Abe (`abe`), or from Abe back to `back` (the tile it came from), when that is
/// still on the rail and not Abe itself.
pub fn abe_key(at: &Tile, abe: Option<&Tile>, back: Option<&Tile>, ring: &[Tile]) -> Option<Tile> {
    let abe = abe?;
    if at != abe {
        return Some(abe.clone());
    }
    back.filter(|b| *b != abe && ring.contains(b)).cloned()
}

/// What the middle shows, for the chrome (the status bar's mode, the toolbar's line): its word,
/// and whether it is the repo's (Board, Boxes, Pipelines) rather than a workspace's page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RailPlace {
    pub word: &'static str,
    pub repo: bool,
}

impl gpui_kit::Global for RailPlace {}

/// A tile's square: a card's (and Abe's), a place's.
const TILE: f32 = 36.;
const SMALL: f32 = 30.;
const TILE_GAP: f32 = 8.;
/// The rail's room that is not the cards' (Abe, +, the line, the places, the gaps).
const FIXED: f32 = 10. + TILE + 13. + TILE + TILE_GAP + 14. + 13. + 3. * (SMALL + 6.) + 8.;
/// The selection's pill at the rail's left edge, and the hover's.
const PILL_H: f32 = 22.;
const PILL_HOVER_H: f32 = 8.;
/// The tile's ground: its colour over the panel at this much (hovered, selected).
const GROUND: f32 = 0.2;
const GROUND_HOVER: f32 = 0.32;
const GROUND_SELECTED: f32 = 0.55;

/// How many card tiles fit a rail `height` px tall (at least one).
pub fn capacity(height: f32) -> usize {
    (((height - FIXED) / (TILE + TILE_GAP)).floor() as isize).max(1) as usize
}

/// The cards drawn of `n`, `capacity` at most, the one at `selected` among them: their range.
pub fn shown_range(n: usize, capacity: usize, selected: Option<usize>) -> std::ops::Range<usize> {
    if n <= capacity {
        return 0..n;
    }
    let start = selected.map_or(0, |s| (s + 1).saturating_sub(capacity));
    start..start + capacity
}

/// A state's word in the header and the hover card.
fn state_word(state: WorkspaceState) -> &'static str {
    use WorkspaceState as W;
    match state {
        W::NeedsYou => "Needs you",
        W::Running => "Running",
        W::Starting => "Launching…",
        W::Idle => "Idle",
        W::Done => "Done",
        W::Failed => "Failed",
    }
}

/// A state's colour in words (the hover card's, the header's).
fn state_color(state: WorkspaceState) -> gpui_kit::Rgba {
    use WorkspaceState as W;
    match state {
        W::NeedsYou => look::ABE_NEEDS_YOU.rgba(),
        W::Running => look::ABE_WARN.rgba(),
        W::Starting => look::ABE_ACCENT.rgba(),
        W::Done => look::ABE_GOOD.rgba(),
        W::Failed => look::ABE_BAD.rgba(),
        W::Idle => look::TEXT_DIM.rgba(),
    }
}

/// Needs you's mark, where the rail and its hover say it: a teal circle with a `?` (never ◆).
pub fn ask_mark(size: f32) -> gpui_kit::Div {
    div()
        .flex_none()
        .w(px(size))
        .h(px(size))
        .rounded_full()
        .bg(look::ABE_NEEDS_YOU)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.72))
        .line_height(px(size))
        .font_weight(FontWeight::BOLD)
        .text_color(tiles::ASK_INK)
        .child("?")
}

/// A state's mark before its word: the `?` circle for needs you, else its glyph.
fn state_mark(state: WorkspaceState, glyph: &str) -> AnyElement {
    if state == WorkspaceState::NeedsYou {
        return ask_mark(13.).into_any_element();
    }
    div()
        .text_color(state_color(state))
        .child(SharedString::from(glyph.to_owned()))
        .into_any_element()
}

/// A tile's square on its ground (`hue`'s colour over the panel, its tint the letters'; a
/// place's none), the pill at the rail's left edge when selected, a short one on hover.
fn tile_box(
    id: SharedString,
    selected: bool,
    size: f32,
    hue: Option<(gpui_kit::Rgba, gpui_kit::Rgba)>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let panel = look::PANEL_BG.rgba();
    let group = SharedString::from(format!("{id}-group"));
    let edge = (RAIL_WIDTH - size) / 2.;
    let pill = div()
        .absolute()
        .left(px(-edge))
        .w(px(4.))
        .rounded_r(px(3.))
        .bg(tiles::WHITE)
        .map(|d| {
            if selected {
                d.top(px((size - PILL_H) / 2.)).h(px(PILL_H))
            } else {
                d.top(px((size - PILL_HOVER_H) / 2.))
                    .h_0()
                    .group_hover(group.clone(), |s| s.h(px(PILL_HOVER_H)))
            }
        });
    div()
        .id(id)
        .group(group)
        .relative()
        .flex_none()
        .w(px(size))
        .h(px(size))
        .rounded(px(if size == TILE { 10. } else { 8. }))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::SEMIBOLD)
        .text_size(px(13.))
        .map(|d| match (hue, selected) {
            (Some((h, _)), true) => d
                .bg(tiles::over(h, GROUND_SELECTED, panel))
                .text_color(tiles::WHITE),
            (Some((h, tint)), false) => d
                .bg(tiles::over(h, GROUND, panel))
                .text_color(tint)
                .hover(move |s| s.bg(tiles::over(h, GROUND_HOVER, panel))),
            (None, true) => d.bg(look::TAB_HOVER_BG).text_color(look::TEXT),
            (None, false) => d
                .text_color(look::TEXT_DIM)
                .hover(|s| s.bg(look::TAB_HOVER_BG).text_color(look::TEXT)),
        })
        .child(pill)
}

/// Abe's face: `letters` (an `A`, or its repo's while several are open) on a small square.
fn face(size: f32, letters: String) -> gpui_kit::Div {
    let text = if letters.chars().count() > 1 {
        size * 0.42
    } else {
        size / 2.
    };
    div()
        .w(px(size))
        .h(px(size))
        .rounded(px(size / 3.5))
        .bg(look::TAB_SELECTED_BORDER)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(text))
        .font_weight(FontWeight::BOLD)
        .text_color(look::TEXT)
        .child(letters)
}

/// The stage bar's five bars, `w` × `h` px each, `gap` apart.
fn stage_bars(colors: [gpui_kit::Rgba; 5], w: f32, h: f32, gap: f32) -> gpui_kit::Div {
    div().flex_none().flex().gap(px(gap)).children(
        colors
            .into_iter()
            .map(move |c| div().flex_none().w(px(w)).h(px(h)).rounded(px(1.)).bg(c)),
    )
}

/// A card tile's hover card: its swatch with the letters, `#id`, the title, the stage bar with
/// its stage and state word, where it runs and the page it is on.
#[derive(Clone)]
struct TileTip {
    letters: String,
    hue: gpui_kit::Rgba,
    id: Option<u64>,
    title: String,
    state: Option<WorkspaceState>,
    /// The state's glyph (the look's dot), its word with its time, where it runs: from the look.
    glyph: String,
    word: String,
    place: String,
    stage: Option<String>,
    bars: [gpui_kit::Rgba; 5],
    page: &'static str,
    /// Its repo's name while several are open.
    repo: Option<String>,
}

impl gpui_kit::Render for TileTip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let dim = |t: String| div().text_color(look::TEXT_DIM).child(t);
        let mut foot: Vec<String> = self.repo.iter().cloned().collect();
        if !self.place.is_empty() {
            foot.push(self.place.clone());
        }
        foot.push(format!("on {}", self.page));
        foot.push("right-click for its menu".into());
        crate::kit::tooltip_frame()
            .debug_selector(|| "rail-tip".into())
            .mt(px(look::TOOLTIP_OFFSET_Y))
            .w(px(300.))
            .flex()
            .flex_col()
            .gap(px(5.))
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_none()
                            .w(px(22.))
                            .h(px(22.))
                            .rounded(px(6.))
                            .bg(self.hue)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(10.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tiles::WHITE)
                            .child(self.letters.clone()),
                    )
                    .children(self.id.map(|id| {
                        div()
                            .font_family(crate::render::EDITOR_FONT)
                            .text_color(look::ABE_ACCENT)
                            .child(format!("#{id}"))
                    })),
            )
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(look::TEXT)
                    .child(self.title.clone()),
            )
            .child(
                div()
                    .debug_selector(|| "rail-tip-stage".into())
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.))
                    .child(stage_bars(self.bars, 14., 4., 2.))
                    .children(self.stage.clone().map(dim))
                    .children(self.state.map(|s| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_color(state_color(s))
                            .child(state_mark(s, &self.glyph))
                            .child(if self.word.is_empty() {
                                state_word(s).to_owned()
                            } else {
                                self.word.clone()
                            })
                    }))
                    .when(self.state.is_none(), |d| {
                        d.child(dim("No session yet".into()))
                    }),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(look::TEXT_DIM)
                    .child(foot.join(" · ")),
            )
    }
}

/// A prototype's one bar: green running, amber starting, red failed, dim stopped.
fn proto_color(state: crate::factory::PrototypeState) -> gpui_kit::Rgba {
    use crate::factory::PrototypeState as S;
    match state {
        S::Running => look::ABE_GOOD.rgba(),
        S::Starting => look::ABE_WARN.rgba(),
        S::Failed => look::ABE_BAD.rgba(),
        S::Stopped => look::TEXT_DIM.rgba(),
    }
}

/// Needs you's steady teal dot on a tile's top right corner.
fn need_dot(key: &str) -> gpui_kit::Div {
    let sel = format!("rail-need-{key}");
    div()
        .debug_selector(move || sel.clone())
        .absolute()
        .right(px(-4.))
        .top(px(-4.))
        .w(px(10.))
        .h(px(10.))
        .rounded_full()
        .bg(look::ABE_NEEDS_YOU)
        .border_2()
        .border_color(FRAME_BG)
}

/// A thin line across the rail.
fn separator() -> gpui_kit::Div {
    div().flex_none().w(px(24.)).h(px(1.)).bg(look::SEPARATOR)
}

impl Projects {
    /// The rail as it is now: the open workspaces, then the places.
    pub fn ring_now(&self) -> Vec<Tile> {
        let open: Vec<(PathBuf, bool)> = self
            .open
            .iter()
            .map(|o| (o.real.clone(), o.is_main()))
            .collect();
        ring(&open, &self.protos.order)
    }

    /// The tile shown: the shown workspace (on any page), or the place the middle shows.
    pub fn tile_now(&self, cx: &App) -> Tile {
        let ws = || {
            self.open
                .get(self.active)
                .map_or(Tile::Board, |o| Tile::Workspace(o.real.clone()))
        };
        if !self.factory_shown {
            return ws();
        }
        match self.pane_place {
            Some(PaneTab::Boxes) => return Tile::Boxes,
            Some(PaneTab::Pipelines) => return Tile::Pipelines,
            _ => {}
        }
        if let Some(id) = self.prototype_shown(cx) {
            return Tile::Prototype(id);
        }
        match self.factory().map(|f| f.read(cx).main_screen()) {
            Some(RUN_SCREEN) => ws(),
            Some(CARD_SCREEN) if self.card_page => ws(),
            _ => Tile::Board,
        }
    }

    /// The card of open project `ix`: its look's story, else the one its branch names.
    pub(super) fn card_of(&self, ix: usize, cx: &App) -> Option<u64> {
        let o = self.open.get(ix)?;
        if let Some(l) = crate::factory::look_of(&o.dir, cx) {
            return Some(l.story.id);
        }
        if o.is_main() {
            return None;
        }
        let name = self.tab_parts(ix, cx).name;
        name.strip_prefix('#')?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    }

    /// Abe's tile (the first main checkout open), if any.
    fn abe_tile(&self) -> Option<Tile> {
        self.open
            .iter()
            .find(|o| o.is_main())
            .map(|o| Tile::Workspace(o.real.clone()))
    }

    /// The open repos in open order: each one's main checkout (a worktree's by its `.git`, else
    /// the project's own folder; a cloud workspace's none) and its name ([`tiles::repo_names`]).
    fn repos(&self) -> Vec<(PathBuf, String)> {
        let mut mains: Vec<&Path> = Vec::new();
        for o in self.open.iter().filter(|o| o.remote.is_none()) {
            let main = o.of_main.as_deref().unwrap_or(&o.real);
            if !mains.contains(&main) {
                mains.push(main);
            }
        }
        let names = tiles::repo_names(&mains);
        mains
            .into_iter()
            .map(Path::to_path_buf)
            .zip(names)
            .collect()
    }

    /// The name of open project `ix`'s repo (in `repos`, [`Self::repos`]); a cloud workspace's
    /// none.
    fn repo_of(&self, ix: usize, repos: &[(PathBuf, String)]) -> Option<String> {
        let o = self.open.get(ix).filter(|o| o.remote.is_none())?;
        let main = o.of_main.as_ref().unwrap_or(&o.real);
        repos
            .iter()
            .find(|(m, _)| m == main)
            .map(|(_, n)| n.clone())
    }

    /// The letters on main checkout `ix`'s face: Abe's `A` while one repo is open, else its
    /// repo's ([`tiles::letters`] over the open repos' names, never two alike).
    fn face_letters(&self, ix: usize) -> String {
        let repos = self.repos();
        if repos.len() < 2 {
            return "A".into();
        }
        let names: Vec<&str> = repos.iter().map(|(_, n)| n.as_str()).collect();
        let main = &self.open[ix].real;
        repos
            .iter()
            .zip(tiles::letters(&names))
            .find(|((m, _), _)| m == main)
            .map_or_else(|| "A".into(), |(_, l)| l)
    }

    /// Each running project's nvim names its repo in the window title (`config/statusline.lua`
    /// `set_name`): a main checkout whose folder's name another open repo's shares says its
    /// parent folder too (`b/repo`), a worktree its repo before its folder while several repos
    /// are open (`demo-shop › 7-filter-orders`); else (an empty name) its folder's. Told once
    /// per change; the toolbar's line names such a main checkout the same
    /// ([`crate::factory::RepoNames`]).
    pub(super) fn name_titles(&mut self, cx: &mut App) {
        let repos = self.repos();
        let mut told = std::mem::take(&mut self.titled);
        let mut now = HashMap::new();
        for (ix, o) in self.open.iter().enumerate() {
            let Some(ws) = o.ws() else {
                continue;
            };
            let folder = o.real.file_name().map(|n| n.to_string_lossy().into_owned());
            let name = match (self.repo_of(ix, &repos), folder) {
                (Some(repo), Some(folder)) if o.of_main.is_some() && repos.len() > 1 => {
                    format!("{repo} › {folder}")
                }
                (Some(repo), Some(folder)) if o.of_main.is_none() && repo != folder => repo,
                _ => String::new(),
            };
            let id = ws.entity_id();
            if told.remove(&id).unwrap_or_default() != name {
                crate::nvim::lua::call(
                    ws.read(cx).rpc(),
                    "config.statusline",
                    "set_name",
                    vec![name.clone().into()],
                );
            }
            now.insert(id, name);
        }
        self.titled = now;
        // the toolbar's line says it too
        let named = crate::factory::RepoNames(
            self.open
                .iter()
                .enumerate()
                .filter(|(_, o)| o.is_main())
                .filter_map(|(ix, o)| {
                    let repo = self.repo_of(ix, &repos)?;
                    let folder = o.real.file_name()?.to_string_lossy();
                    (repo != folder)
                        .then(|| [(o.dir.clone(), repo.clone()), (o.real.clone(), repo)])
                })
                .flatten()
                .collect(),
        );
        if cx.try_global::<crate::factory::RepoNames>() != Some(&named) {
            cx.set_global(named);
        }
    }

    /// Moves to `to`: the tile left keeps its Chat and page, `to` shows its own (a workspace its
    /// page, the Board the card of the workspace you were in, Boxes or Pipelines their list),
    /// the keys where they were there ([`Self::land_keys`]).
    pub(super) fn go(&mut self, to: Tile, window: &mut Window, cx: &mut Context<Self>) {
        if self.open.is_empty() {
            return;
        }
        let from = self.tile_now(cx);
        if from == to {
            self.rail_chat_keys(window, cx);
            return;
        }
        self.remember_chat(&from, window, cx);
        self.note_page(cx);
        match &to {
            Tile::Workspace(real) => {
                let Some(ix) = self.open.iter().position(|o| &o.real == real) else {
                    return;
                };
                // a launch's workspace before its worktree is there: the Board on its card
                if !self.open[ix].dir.exists() {
                    let card = self.card_of(ix, cx);
                    self.board_on(card, window, cx);
                    let it = card.map_or_else(|| "it".to_owned(), |c| format!("#{c}"));
                    self.say_browsed(
                        Some(format!("Launching {it}… its workspace is on the way")),
                        cx,
                    );
                    self.arrived(&Tile::Board, window, cx);
                    return;
                }
                if ix != self.active {
                    // (its show may wait on a resize: it lands there, [`Self::show`])
                    self.arrive = Some(to.clone());
                    self.activate(ix, window, cx);
                    return;
                }
                let page = self.page_of(ix, cx);
                self.show_page(page, window, cx);
            }
            Tile::Board => {
                let card = match &from {
                    // a card's prototype: the Board on its card
                    Tile::Prototype(id) => self.prototype(id, cx).and_then(|p| p.card),
                    t if !t.is_place() => self.card_of(self.active, cx),
                    _ => None,
                };
                self.board_on(card, window, cx);
            }
            Tile::Prototype(id) => self.show_prototype(id, window, cx),
            Tile::Boxes => self.place_on(PaneTab::Boxes, window, cx),
            Tile::Pipelines => self.place_on(PaneTab::Pipelines, window, cx),
        }
        self.arrived(&to, window, cx);
    }

    /// A move landed on `tile`: its Chat as it was left, the keys where they were then (a first
    /// visit's: Chat's composer, the page's when Chat is hidden there).
    pub(super) fn arrived(&mut self, tile: &Tile, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_chat(tile, window, cx);
        self.land_keys(tile, window, cx);
        cx.notify();
    }

    /// The keys to Chat's composer in the mode the tile's Chat is in (Claude Code keeps its
    /// own), or to the page while Chat is hidden.
    pub(super) fn rail_chat_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let s = column::state(cx);
        if !s.shown() {
            return self.page_keys(window, cx);
        }
        let mode = s.mode_now();
        crate::shell::hosted::keys_moved(cx);
        if let Some(ws) = self.active().cloned() {
            let column = ws.read(cx).column().clone();
            column.update(cx, |c, cx| c.show(mode, true, window, cx));
        }
        if mode == column::ColumnMode::Chat
            && let Some(view) = self.factory().cloned()
        {
            view.update(cx, |v, _| v.chat_landed());
        }
    }

    /// Boxes or Pipelines in the middle: the Factory view's pane on its list, filling it; Chat
    /// beside it the repo's Abe chat, wherever you came from.
    fn place_on(&mut self, tab: PaneTab, window: &mut Window, cx: &mut Context<Self>) {
        let view = self.ensure_factory(window, cx);
        // the Board left: its card's popup goes with it
        view.update(cx, |v, cx| {
            v.start(window, cx);
            v.close_popup(cx);
        });
        if !self.factory_shown {
            self.set_factory_shown_as(true, false, window, cx);
        }
        let abe = self
            .open
            .iter()
            .find(|o| o.is_main())
            .map(|o| o.real.to_string_lossy().into_owned());
        view.update(cx, |v, cx| match abe {
            Some(root) => v.set_chat_on_abe(root, cx),
            None => v.set_chat_on_card(true, cx),
        });
        self.card_page = false;
        self.pane_place = Some(tab);
        // the bridge hears it as the old click (Boxes keeps a box about to sleep awake)
        crate::shell::pane::tab_clicked(tab, window, cx);
        self.show_factory_pane(tab, window, cx);
        // Esc in Chat gives the keys back to the list, not the Board under it
        let pane = self.factory_pane(window, cx).focus_handle(cx);
        cx.set_global(crate::shell::column::BoardFocus(pane));
        cx.notify();
    }

    /// ⌘↑ (−1) / ⌘↓: the tile above or below in its group, round again past either end: on a
    /// workspace the workspaces, on the Board, Boxes or Pipelines (⌘←) those three.
    pub(super) fn walk(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let ring = self.ring_now();
        if let Some(to) = step(&ring, &self.tile_now(cx), by) {
            self.go(to, window, cx);
        }
    }

    /// ⌘→ on a place: up to the workspaces, from the Board the selected card's, else (Boxes,
    /// Pipelines, no open workspace is that card's) the one you were in. On a workspace not taken
    /// (false): the surface's own ⌘→.
    fn go_into_card(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let at = self.tile_now(cx);
        if !at.is_place() {
            return false;
        }
        let card = (at == Tile::Board)
            .then(|| self.factory().and_then(|f| f.read(cx).selected()))
            .flatten();
        let ix = card
            .and_then(|c| (0..self.open.len()).find(|&ix| self.card_of(ix, cx) == Some(c)))
            .unwrap_or(self.active);
        if let Some(o) = self.open.get(ix) {
            let to = Tile::Workspace(o.real.clone());
            self.go(to, window, cx);
        }
        true
    }

    /// ⌘§: Abe; on Abe, back to the tile you came from. With no main checkout open, the Chat
    /// column's own ⌘§ (the repo's Abe chat in it, again back).
    fn abe_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.tile_now(cx);
        let ring = self.ring_now();
        let abe = self.abe_tile();
        if abe.is_none() {
            if let Some(ws) = self.active().cloned() {
                ws.update(cx, |ws, cx| {
                    ws.column_key(column::ColumnKey::Abe, window, cx)
                });
            }
            return;
        }
        match abe_key(&at, abe.as_ref(), self.abe_back.as_ref(), &ring) {
            Some(to) => {
                if abe.as_ref() != Some(&at) {
                    self.abe_back = Some(at);
                }
                self.go(to, window, cx);
            }
            None => self.rail_chat_keys(window, cx),
        }
    }

    /// The rail's keys (the window's capture, before any surface): ⌘↑ ⌘↓ ⌘← ⌘→ ⌘§, ⌃1–⌃3,
    /// ⌘⇧2 ⌘⌥2. True when taken.
    pub(super) fn rail_key(
        &mut self,
        k: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        // a prototype's tile: Preview, Code, Logs
        if let Some(page) = super::protos::ProtoPage::of_key(k)
            && matches!(self.tile_now(cx), Tile::Prototype(_))
        {
            self.proto_page_key(page, window, cx);
            return true;
        }
        if let Some(page) = Page::of_key(k) {
            self.page_key(page, window, cx);
            return true;
        }
        let m = k.modifiers;
        if !m.platform || m.control || m.function {
            return false;
        }
        match (k.key.as_str(), m.shift, m.alt) {
            ("up", false, false) => self.walk(-1, window, cx),
            ("down", false, false) => self.walk(1, window, cx),
            // ⌘← down to the places, on the Board; on one already, it stays
            ("left", false, false) => {
                if !self.tile_now(cx).is_place() {
                    self.go(Tile::Board, window, cx);
                }
            }
            ("right", false, false) => return self.go_into_card(window, cx),
            ("§", false, false) => self.abe_key(window, cx),
            // ⌘⇧2: Shift stays only on letters, the shifted char comes (`"` Swedish, `@` US)
            ("2", true, false) | ("\"" | "@", false, false) => self.chat_size_key(true, window, cx),
            ("2", false, true) => self.chat_size_key(false, window, cx),
            _ => return false,
        }
        true
    }

    /// Command mode's Go to `id` (the stripe's ids before the rail): a tile or a page.
    pub(in crate::shell) fn open_place(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match id {
            "board" | "sessions" => self.go(Tile::Board, window, cx),
            "boxes" => self.go(Tile::Boxes, window, cx),
            "pipelines" => self.go(Tile::Pipelines, window, cx),
            "project" => self.page_key(Page::Code, window, cx),
            "terminal" => self.panel_on(crate::shell::PanelTab::Terminal, window, cx),
            "git" => self.panel_on(crate::shell::PanelTab::Git, window, cx),
            other => {
                if let Some(page) = Page::parse(other) {
                    self.page_key(page, window, cx);
                }
            }
        }
    }

    /// ⌘⌥A: the Board, again back to the workspace you were in.
    pub(super) fn board_toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tile_now(cx) == Tile::Board {
            if let Some(o) = self.open.get(self.active) {
                let to = Tile::Workspace(o.real.clone());
                self.go(to, window, cx);
            }
        } else {
            self.go(Tile::Board, window, cx);
        }
    }

    /// `+` on the rail: the Board on its New card dialog; without an `abe` 2.x, the line that
    /// says so (the keys stay).
    pub(super) fn new_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::factory::BridgeCommand::available(cx) {
            popups::notify(popups::Balloon::info("", super::NO_ABE), window, cx);
            return;
        }
        self.go(Tile::Board, window, cx);
        super::factory_click("widget:new-card".into(), window, cx);
    }

    /// The menu of the tile of open project `ix` (a right-click, ⌘⏎ over it).
    pub(super) fn tile_menu(
        &mut self,
        ix: usize,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(open) = self.open.get(ix) else {
            return;
        };
        let path = open.dir.clone();
        let real = open.real.clone();
        let main = open.is_main();
        let session = self
            .memory
            .session(&Tile::Workspace(real.clone()))
            .map(str::to_owned)
            .filter(|_| !main);
        let card = self.card_of(ix, cx).filter(|_| !main);
        let name = self.tab_parts(ix, cx).name;
        let entries = crate::shell::lifecycle::tile_menu(card.is_some(), session.is_some(), !main);
        let root = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let Some(what) = choice.and_then(crate::shell::lifecycle::tile_menu_choice) else {
                    return;
                };
                let _ = root.update(cx, |p, cx| match what {
                    "Story" => {
                        p.go(Tile::Workspace(real.clone()), window, cx);
                        p.page_key(Page::Card, window, cx);
                    }
                    "Open in Finder" => {
                        let _ = std::process::Command::new("open")
                            .arg("-R")
                            .arg(&path)
                            .spawn();
                    }
                    "Stop the session…" => {
                        if let Some(session) = session.clone() {
                            p.stop_session(session, &name, window, cx);
                        }
                    }
                    "Delete Working Files…" => {
                        p.delete_workspace_files(path.clone(), anchor, window, cx)
                    }
                    "Close the workspace" => {
                        if let Some(ix) = p.index_of(&path) {
                            p.close(ix, None, window, cx);
                        }
                    }
                    _ => {}
                });
            },
        );
    }

    /// Stop the session? asked (Cancel the default); yes: `abe session stop`, the workspace
    /// staying.
    fn stop_session(
        &mut self,
        session: String,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = self.ensure_factory(window, cx);
        view.update(cx, |v, cx| v.start(window, cx));
        let dialog = crate::shell::lifecycle::stop_dialog(name);
        popups::open_dialog(dialog, window, cx, move |answer, _, cx| {
            if answer.is_some_and(|a| a.id == "stop") {
                view.update(cx, |v, _| {
                    let _ = v.run(vec!["session".into(), "stop".into(), session]);
                });
            }
        });
    }

    /// ⌘⏎ over a tile (the rail never has the keys): its menu. False when the pointer is over
    /// none.
    pub(super) fn tile_menu_key(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        // at the tile under the pointer, beside the rail
        let at = gpui_kit::point(px(RAIL_WIDTH), window.mouse_position().y);
        let real = match self.rail_hover.clone() {
            Some(Tile::Workspace(real)) => real,
            Some(Tile::Prototype(id)) => {
                self.proto_menu(id, Anchor::Point(at), window, cx);
                return true;
            }
            _ => return false,
        };
        let Some(ix) = self.open.iter().position(|o| o.real == real) else {
            return false;
        };
        self.tile_menu(ix, Anchor::Point(at), window, cx);
        true
    }

    /// The rail at the window's left edge, from the toolbar to the status bar.
    pub(super) fn rail_element(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let at = self.tile_now(cx);
        let place = match &at {
            Tile::Workspace(_) => RailPlace {
                word: match self.page_now(cx) {
                    Page::Code => "CODE",
                    Page::Run => "RUN",
                    Page::Card => "CARD",
                },
                repo: false,
            },
            // `ABE · PREVIEW`, `· CODE`, `· LOGS`: the prototype's page
            Tile::Prototype(_) => RailPlace {
                word: self.proto_page_now().word(),
                repo: false,
            },
            Tile::Board => RailPlace {
                word: "BOARD",
                repo: true,
            },
            Tile::Boxes => RailPlace {
                word: "BOXES",
                repo: true,
            },
            Tile::Pipelines => RailPlace {
                word: "PIPELINES",
                repo: true,
            },
        };
        if cx.try_global::<RailPlace>() != Some(&place) {
            cx.set_global(place);
        }
        // the bridge knows the place for Command mode's Go to (the stripe's ids)
        if let Some(view) = self.factory().cloned() {
            let id = match (&at, place.word) {
                (Tile::Board, _) => "board",
                (Tile::Boxes, _) => "boxes",
                (Tile::Pipelines, _) => "pipelines",
                (Tile::Prototype(_), _) => "prototype",
                (_, "RUN") => "run",
                _ => "project",
            };
            view.update(cx, |v, _| v.set_place(id));
        }
        let ring = self.ring_now();
        let height = f32::from(window.viewport_size().height)
            - look::TOOLBAR_HEIGHT.get()
            - look::STATUS_BAR_HEIGHT.get();
        let abe = self.abe_tile();
        let cards: Vec<Tile> = ring
            .iter()
            .filter(|t| !t.is_place() && Some(*t) != abe.as_ref())
            .cloned()
            .collect();
        let faces = self.faces(&cards, cx);
        let selected = cards.iter().position(|t| *t == at);
        let shown = shown_range(cards.len(), capacity(height), selected);
        let state_of = |p: &Projects, t: &Tile, cx: &App| match t {
            Tile::Workspace(real) => p
                .open
                .iter()
                .position(|o| &o.real == real)
                .and_then(|ix| p.tab_parts(ix, cx).state),
            _ => None,
        };
        let needs_below = cards[shown.end..]
            .iter()
            .filter(|t| state_of(self, t, cx) == Some(WorkspaceState::NeedsYou))
            .count();
        let below = cards.len() - shown.end;
        self.drawn_rail = abe
            .iter()
            .chain(&cards[shown.clone()])
            .cloned()
            .chain(super::rail::PLACES)
            .collect();
        let tiles: Vec<AnyElement> = cards[shown.clone()]
            .iter()
            .zip(&faces[shown])
            .map(|(t, f)| self.tile_element(t, *t == at, Some(f), window, cx))
            .collect();
        let me = cx.entity().downgrade();
        let new = tile_box("rail-new".into(), false, TILE, None)
            .debug_selector(|| "rail-new".into())
            .border_2()
            .border_dashed()
            .border_color(look::SEPARATOR)
            .bg(gpui_kit::transparent_black())
            .text_size(px(18.))
            .font_weight(FontWeight::NORMAL)
            .tooltip(crate::kit::tooltip("New card or prototype", None))
            .child("+")
            .on_mouse_down(MouseButton::Left, move |ev, window, cx| {
                cx.stop_propagation();
                let at = Anchor::Point(ev.position);
                let _ = me.update(cx, |p, cx| p.new_menu(at, window, cx));
            });
        // a teal `?` before it when one out of view needs you
        let more = match (needs_below, below) {
            (0, 0) => None,
            (0, n) => Some((format!("{n} below"), false)),
            (n, _) => Some((format!("{n} below"), true)),
        };
        div()
            .id("rail")
            .debug_selector(|| "rail".into())
            .absolute()
            .left_0()
            .top(px(look::TOOLBAR_HEIGHT.get()))
            .bottom(px(look::STATUS_BAR_HEIGHT.get()))
            .w(px(RAIL_WIDTH))
            .bg(FRAME_BG)
            .occlude()
            .flex()
            .flex_col()
            .items_center()
            .pt(px(10.))
            .pb(px(8.))
            .gap(px(6.))
            .font_family(crate::render::UI_FONT)
            .children(abe.map(|t| self.tile_element(&t, t == at, None, window, cx)))
            .child(separator())
            .child(
                div()
                    .debug_selector(|| "rail-cards".into())
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(TILE_GAP))
                    .pt(px(2.))
                    .children(tiles)
                    .child(new),
            )
            .children(more.map(|(text, needs)| {
                div()
                    .debug_selector(|| "rail-more".into())
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(3.))
                    .text_size(px(10.5))
                    .text_color(if needs {
                        look::ABE_NEEDS_YOU
                    } else {
                        look::TEXT_DIM
                    })
                    .when(needs, |d| d.child(ask_mark(11.)))
                    .child(text)
            }))
            .child(separator())
            .children(
                super::rail::PLACES
                    .iter()
                    .map(|t| self.tile_element(t, *t == at, None, window, cx)),
            )
            .into_any_element()
    }

    /// Each card tile's face (its letters, its colour in [`tiles::HUES`]), in `cards`' order:
    /// a colour new to the rail kept while the tile is open.
    fn faces(&mut self, cards: &[Tile], cx: &mut Context<Self>) -> Vec<(String, usize)> {
        let titles: Vec<String> = cards
            .iter()
            .map(|t| match t {
                Tile::Workspace(real) => self
                    .open
                    .iter()
                    .position(|o| &o.real == real)
                    .map(|ix| self.card_title(ix, cx))
                    .unwrap_or_default(),
                Tile::Prototype(id) => self.prototype(id, cx).map(|p| p.title).unwrap_or_default(),
                _ => String::new(),
            })
            .collect();
        // a prototype's colour is its card's (its workspace's when open), an idea's grey: never
        // one given out
        let given: Vec<&Tile> = cards
            .iter()
            .filter(|t| matches!(t, Tile::Workspace(_)))
            .collect();
        let (given_hues, changed) = self.memory.give_hues(&given);
        if changed {
            self.save_set(cx);
        }
        let mut given_hues = given_hues.into_iter();
        let hues: Vec<usize> = cards
            .iter()
            .map(|t| match t {
                Tile::Prototype(id) => self.prototype_hue(id, cx),
                _ => given_hues.next().unwrap_or(0),
            })
            .collect();
        let titles: Vec<&str> = titles.iter().map(String::as_str).collect();
        tiles::letters(&titles).into_iter().zip(hues).collect()
    }

    /// A prototype tile's colour ([`tiles::HUES`]): its card's workspace's when that is open, a
    /// card's by its number else; an idea's the grey.
    fn prototype_hue(&self, id: &str, cx: &App) -> usize {
        let Some(card) = self.prototype(id, cx).and_then(|p| p.card) else {
            return tiles::IDEA_HUE;
        };
        (0..self.open.len())
            .find(|&ix| self.card_of(ix, cx) == Some(card))
            .and_then(|ix| {
                self.memory
                    .hue(&Tile::Workspace(self.open[ix].real.clone()))
            })
            .unwrap_or(card as usize % tiles::HUES.len())
    }

    /// The title open project `ix`'s tile takes its letters from: its card's, else its name
    /// (the story its branch names, the folder's).
    fn card_title(&self, ix: usize, cx: &App) -> String {
        match crate::factory::look_of(&self.open[ix].dir, cx) {
            Some(l) => l.story.title.clone(),
            None => self.tab_parts(ix, cx).name,
        }
    }

    /// One tile: a card's letters on its colour (`face`) over its stage bar, Abe's face, or a
    /// place's icon.
    fn tile_element(
        &self,
        tile: &Tile,
        selected: bool,
        card_face: Option<&(String, usize)>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let _ = window;
        let key = tile.key();
        let selector = match tile {
            Tile::Workspace(_) | Tile::Prototype(_) => format!("rail-tile-{key}"),
            place => format!("rail-{}", place.key()),
        };
        let me = cx.entity().downgrade();
        let menu_me = me.clone();
        let hover_me = me.clone();
        let click = tile.clone();
        let hovered = tile.clone();
        let size = if matches!(tile, Tile::Workspace(_)) {
            TILE
        } else {
            SMALL
        };
        let main = matches!(tile, Tile::Workspace(r) if self.open.iter().any(|o| &o.real == r && o.is_main()));
        let (hue, tint) = match (card_face, main) {
            (Some((_, h)), _) => (Some(tiles::HUES[*h].0), tiles::HUES[*h].1),
            (None, true) => (Some(tiles::ABE_HUE), look::TEXT.rgba()),
            (None, false) => (None, look::TEXT_DIM.rgba()),
        };
        let el = tile_box(
            SharedString::from(selector.clone()),
            selected,
            size,
            hue.map(|h| (h, tint)),
        )
        .debug_selector({
            let s = selector.clone();
            move || s.clone()
        })
        .when(selected, |d| {
            d.child(
                div()
                    .debug_selector(|| "rail-selected".into())
                    .absolute()
                    .size_0(),
            )
        })
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            let to = click.clone();
            let _ = me.update(cx, |p, cx| p.go(to, window, cx));
        })
        .on_hover(move |on: &bool, _, cx| {
            let t = on.then(|| hovered.clone());
            let _ = hover_me.update(cx, |p, _| {
                if *on || p.rail_hover.as_ref() == Some(&hovered) {
                    p.rail_hover = t;
                }
            });
        });
        match tile {
            Tile::Prototype(id) => {
                let Some(p) = self.prototype(id, cx) else {
                    return div().into_any_element();
                };
                let (letters, _) = card_face.cloned().unwrap_or_else(|| ("?".into(), 0));
                let menu_id = id.clone();
                let bar_sel = format!("rail-proto-bar-{id}");
                let bar = div()
                    .debug_selector(move || bar_sel.clone())
                    .flex_none()
                    .w(px(14.))
                    .h(px(3.))
                    .rounded(px(1.))
                    .bg(proto_color(p.state));
                let bar = if p.state == crate::factory::PrototypeState::Starting {
                    crate::kit::pulsing(SharedString::from(format!("rail-pulse-{key}")), bar)
                } else {
                    bar.into_any_element()
                };
                let tip = [
                    format!("Prototype · {}", p.title),
                    p.branch.clone(),
                    format!("{} · {}", p.state.word(), p.place),
                    "right-click for its menu".to_owned(),
                ]
                .join(" · ");
                el.on_mouse_down(MouseButton::Right, move |ev, window, cx| {
                    cx.stop_propagation();
                    let at = Anchor::Point(ev.position);
                    let id = menu_id.clone();
                    let _ = menu_me.update(cx, |p, cx| p.proto_menu(id, at, window, cx));
                })
                // throwaway, never pushed: a dashed edge
                .border_1()
                .border_dashed()
                .border_color(tint)
                .tooltip(crate::kit::tooltip(tip, None))
                .gap(px(3.))
                .text_size(px(11.))
                .child(
                    div()
                        .debug_selector({
                            let s = format!("rail-letters-{key}-{letters}");
                            move || s.clone()
                        })
                        .line_height(px(11.))
                        .child(letters),
                )
                .child(bar)
                .when(p.needs_you, |d| d.child(need_dot(&key)))
                .into_any_element()
            }
            Tile::Workspace(real) => {
                let Some(ix) = self.open.iter().position(|o| &o.real == real) else {
                    return div().into_any_element();
                };
                let parts = self.tab_parts(ix, cx);
                let page = self.memory.page(tile).unwrap_or_default();
                let ix_menu = ix;
                let el = el.on_mouse_down(MouseButton::Right, move |ev, window, cx| {
                    cx.stop_propagation();
                    let at = Anchor::Point(ev.position);
                    let _ = menu_me.update(cx, |p, cx| p.tile_menu(ix_menu, at, window, cx));
                });
                if main {
                    let repo = self.repo_of(ix, &self.repos()).unwrap_or_default();
                    // ⌘§ goes to the first main checkout's
                    let section = if self.abe_tile().as_ref() == Some(tile) {
                        " · ⌘§"
                    } else {
                        ""
                    };
                    let hover =
                        format!("Abe · {repo} · main checkout · on {}{section}", page.name());
                    let letters = self.face_letters(ix);
                    let face_sel = format!("rail-letters-{key}-{letters}");
                    // its Abe chat asking you something: the cards' teal dot
                    let o = &self.open[ix];
                    let needs = cx
                        .try_global::<crate::factory::WorkspaceFeed>()
                        .filter(|f| !f.down())
                        .is_some_and(|f| {
                            f.abe_needs_you.iter().any(|r| {
                                let r = Path::new(r.trim_end_matches('/'));
                                r == o.real || r == o.dir
                            })
                        });
                    return el
                        .tooltip(crate::kit::tooltip(hover, None))
                        .child(face(22., letters).debug_selector(move || face_sel.clone()))
                        .when(needs, |d| d.child(need_dot(&key)))
                        .into_any_element();
                }
                let (letters, hue_ix) = card_face.cloned().unwrap_or_else(|| ("?".into(), 0));
                let bars = tiles::bar(parts.state, &parts.rail, tint);
                let bars_sel = format!("rail-stages-{key}");
                let bar_el = stage_bars(bars, 4., 3., 1.5).debug_selector(move || bars_sel.clone());
                // a launch keeps its pulse
                let bar_el = if parts.state == Some(WorkspaceState::Starting) {
                    crate::kit::pulsing(SharedString::from(format!("rail-pulse-{key}")), bar_el)
                } else {
                    bar_el.into_any_element()
                };
                let look_ = crate::factory::look_of(&self.open[ix].dir, cx);
                // the look's hover reads `#id title · [stage ·] word time · where`
                let mut tail = parts.tooltip.rsplitn(3, " · ");
                let (place, word) = match parts.state {
                    Some(_) => (
                        tail.next().unwrap_or_default().to_owned(),
                        tail.next().unwrap_or_default().to_owned(),
                    ),
                    None => (String::new(), String::new()),
                };
                let words = self.card_title(ix, cx);
                let title = match words.split_once(' ') {
                    Some((n, w)) if n.starts_with('#') && look_.is_none() => w.to_owned(),
                    _ => words,
                };
                let tip = TileTip {
                    letters: letters.clone(),
                    hue: tiles::HUES[hue_ix].0,
                    id: self.card_of(ix, cx),
                    title,
                    state: parts.state,
                    glyph: parts.dot.as_ref().map(|d| d.0.clone()).unwrap_or_default(),
                    word,
                    place,
                    stage: look_.and_then(|l| l.stage.clone()),
                    bars: tiles::tip_bar(parts.state, &parts.rail),
                    page: page.name(),
                    repo: {
                        let repos = self.repos();
                        (repos.len() > 1)
                            .then(|| self.repo_of(ix, &repos))
                            .flatten()
                    },
                };
                let needs = parts.state == Some(WorkspaceState::NeedsYou);
                el.tooltip(move |_, cx| {
                    let tip = tip.clone();
                    gpui_kit::AppContext::new(cx, |_| tip).into()
                })
                .gap(px(4.))
                .pt(px(2.))
                .child(
                    div()
                        .debug_selector({
                            let s = format!("rail-letters-{key}-{letters}");
                            move || s.clone()
                        })
                        .line_height(px(13.))
                        .child(letters),
                )
                .child(bar_el)
                .when(needs, |d| d.child(need_dot(&key)))
                .when_some(parts.cloud, |d, (c, hue)| {
                    let sel = format!("rail-cloud-{key}");
                    d.child(
                        div()
                            .debug_selector(move || sel.clone())
                            .absolute()
                            .left(px(-3.))
                            .top(px(-5.))
                            .child(crate::factory::cloud(
                                c,
                                10.,
                                crate::factory::cloud_color(hue),
                            )),
                    )
                })
                .into_any_element()
            }
            place => {
                let name = place.place_name().unwrap_or_default();
                let glyph: AnyElement = match place {
                    Tile::Board => {
                        crate::kit::Icon::new(crate::kit::IconName::StripeBoard).into_any_element()
                    }
                    Tile::Boxes => crate::factory::cloud(
                        crate::factory::CloudState::Asleep,
                        15.,
                        look::TEXT_DIM.rgba(),
                    ),
                    _ => crate::kit::Icon::new(crate::kit::IconName::StripeRunPath)
                        .into_any_element(),
                };
                el.tooltip(crate::kit::tooltip(name, None))
                    .child(glyph)
                    .into_any_element()
            }
        }
    }

    /// The header's row right of the rail: the tile's name and, on a workspace, its pages
    /// (Abe's Run and Card dim: it has no card).
    pub(super) fn header_element(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let at = self.tile_now(cx);
        let page = self.page_now(cx);
        let row = div()
            .id("rail-header")
            .debug_selector(|| "rail-header".into())
            .absolute()
            .left(px(RAIL_WIDTH))
            .right_0()
            .top(px(look::TOOLBAR_HEIGHT.get()))
            .h(px(look::TAB_HEIGHT))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(12.))
            .bg(FRAME_BG)
            .occlude()
            .font_family(crate::render::UI_FONT)
            .text_size(px(13.))
            .text_color(look::TEXT);
        let dim = |text: String| {
            div()
                .flex_none()
                .text_size(px(12.))
                .text_color(look::TEXT_DIM)
                .whitespace_nowrap()
                .child(text)
        };
        if let Tile::Prototype(id) = &at {
            return self.proto_header(row, id, cx);
        }
        let Tile::Workspace(real) = &at else {
            let repo = self
                .repo_of(self.active, &self.repos())
                .or_else(|| {
                    self.main_checkout()
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                })
                .unwrap_or_default();
            return row
                .child(
                    div()
                        .debug_selector(|| "rail-header-title".into())
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(at.place_name().unwrap_or_default()),
                )
                .child(dim(repo))
                .into_any_element();
        };
        let Some(ix) = self.open.iter().position(|o| &o.real == real) else {
            return row.into_any_element();
        };
        let main = self.open[ix].is_main();
        let parts = self.tab_parts(ix, cx);
        let branch = self.open[ix]
            .ws()
            .map(|ws| ws.read(cx).statusbar().read(cx).status().branch.clone())
            .unwrap_or_default();
        let look_ = crate::factory::look_of(&self.open[ix].dir, cx).cloned();
        let title: AnyElement = if main {
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(face(20., self.face_letters(ix)))
                .child(div().font_weight(FontWeight::SEMIBOLD).child("Abe"))
                .child(dim(format!(
                    "{} · main checkout · {branch}",
                    self.repo_of(ix, &self.repos()).unwrap_or_default()
                )))
                .into_any_element()
        } else {
            let (num, words) = match &look_ {
                Some(l) => (format!("#{}", l.story.id), l.story.title.clone()),
                None => match parts.name.split_once(' ') {
                    Some((n, w)) if n.starts_with('#') => (n.to_owned(), w.to_owned()),
                    _ => (String::new(), parts.name.clone()),
                },
            };
            // `Build ● Running`; needs you's mark the teal `?`
            let state = look_.as_ref().map(|l| {
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .text_size(px(12.))
                    .text_color(look::TEXT_DIM)
                    .whitespace_nowrap()
                    .children(l.stage.clone())
                    .child(state_mark(l.state, &l.dot.mark))
                    .child(state_word(l.state))
            });
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .text_color(look::ABE_ACCENT)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(num),
                )
                .child(
                    div()
                        .debug_selector(|| "rail-header-title".into())
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(words),
                )
                .when(!parts.rail.is_empty(), |d| {
                    d.child(
                        crate::factory::tab_rail(&parts.rail)
                            .debug_selector(|| "rail-header-stages".into())
                            .w(px(88.)),
                    )
                })
                .children(state)
                .into_any_element()
        };
        let me = cx.entity().downgrade();
        let pages = div()
            .ml_auto()
            .flex_none()
            .flex()
            .gap(px(2.))
            .p(px(2.))
            .rounded(px(7.))
            .bg(look::PANEL_BG)
            .children(Page::ALL.into_iter().map(|p| {
                let off = main && !p.on_main();
                let on = p == page;
                let me = me.clone();
                div()
                    .id(SharedString::from(format!("rail-page-{}", p.slug())))
                    .debug_selector(move || format!("rail-page-{}", p.slug()))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(2.))
                    .rounded(px(5.))
                    .text_size(px(12.5))
                    .text_color(if on { look::TEXT } else { look::TEXT_DIM })
                    .when(on, |d| {
                        d.bg(look::TAB_HOVER_BG).child(
                            div()
                                .debug_selector(move || format!("rail-page-on-{}", p.slug()))
                                .absolute()
                                .size_0(),
                        )
                    })
                    .when(off, |d| d.opacity(0.35))
                    .when(!off && !on, |d| d.hover(|s| s.text_color(look::TEXT)))
                    .child(p.name())
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(look::TEXT_DIM)
                            .child(p.key()),
                    )
                    .when(!off, |d| {
                        d.on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            let _ = me.update(cx, |p_, cx| p_.page_key(p, window, cx));
                        })
                    })
            }));
        row.child(title).child(pages).into_any_element()
    }

    /// A prototype's header row: its words, branch and state, its pages (Preview ⌃1 · Code ⌃2 ·
    /// Logs ⌃3), and its actions as buttons (each a click its screen does).
    fn proto_header(
        &mut self,
        row: gpui_kit::Stateful<gpui_kit::Div>,
        id: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(p) = self.prototype(id, cx) else {
            return row.into_any_element();
        };
        let page = self.proto_page_now();
        let me = cx.entity().downgrade();
        let dim = |text: String| {
            div()
                .flex_none()
                .text_size(px(12.))
                .text_color(look::TEXT_DIM)
                .whitespace_nowrap()
                .child(text)
        };
        let title = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_w_0()
            .child(
                div()
                    .debug_selector(|| "rail-header-title".into())
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(p.title.clone()),
            )
            .child(dim(p.branch.clone()).font_family(crate::render::EDITOR_FONT))
            .child(
                div()
                    .debug_selector(|| "rail-header-proto-state".into())
                    .flex_none()
                    .text_size(px(12.))
                    .text_color(proto_color(p.state))
                    .whitespace_nowrap()
                    .child(format!("● {} · {}", p.state.word(), p.place)),
            );
        let pages = div()
            .flex_none()
            .flex()
            .gap(px(2.))
            .p(px(2.))
            .rounded(px(7.))
            .bg(look::PANEL_BG)
            .children(super::protos::ProtoPage::ALL.into_iter().map(|pg| {
                let on = pg == page;
                let me = me.clone();
                div()
                    .id(SharedString::from(format!("rail-page-{}", pg.slug())))
                    .debug_selector(move || format!("rail-page-{}", pg.slug()))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(2.))
                    .rounded(px(5.))
                    .text_size(px(12.5))
                    .text_color(if on { look::TEXT } else { look::TEXT_DIM })
                    .when(on, |d| {
                        d.bg(look::TAB_HOVER_BG).child(
                            div()
                                .debug_selector(move || format!("rail-page-on-{}", pg.slug()))
                                .absolute()
                                .size_0(),
                        )
                    })
                    .when(!on, |d| d.hover(|s| s.text_color(look::TEXT)))
                    .child(pg.name())
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(look::TEXT_DIM)
                            .child(pg.key()),
                    )
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        cx.stop_propagation();
                        let _ = me.update(cx, |p_, cx| p_.proto_page_key(pg, window, cx));
                    })
            }));
        let buttons = super::protos::BUTTONS.iter().map(|(label, verb)| {
            let me = me.clone();
            let id = id.to_owned();
            crate::kit::TextButton::new(SharedString::from(format!("rail-proto-{verb}")), *label)
                .small(22.)
                .danger(*verb == "discard")
                .on_click(move |_, window, cx| {
                    let id = id.clone();
                    let _ = me.update(cx, |p_, cx| p_.proto_action(&id, verb, window, cx));
                })
        });
        row.child(title)
            .child(
                div()
                    .ml_auto()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .children(buttons),
            )
            .child(pages)
            .into_any_element()
    }

    /// The workspace tiles' looks as last drawn, top to bottom (tests).
    pub fn rail_parts(&self, cx: &App) -> Vec<crate::factory::TabParts> {
        self.drawn_rail
            .iter()
            .filter_map(|t| match t {
                Tile::Workspace(real) => self
                    .open
                    .iter()
                    .position(|o| &o.real == real)
                    .map(|ix| self.tab_parts(ix, cx)),
                _ => None,
            })
            .collect()
    }

    /// The tiles as last drawn, top to bottom (tests).
    pub fn rail_drawn(&self) -> &[Tile] {
        &self.drawn_rail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(p: &str) -> Tile {
        Tile::Workspace(PathBuf::from(p))
    }

    fn proto(id: &str) -> Tile {
        Tile::Prototype(id.to_owned())
    }

    #[test]
    fn the_ring_is_abe_the_cards_in_open_order_the_prototypes_then_the_places() {
        let open = [
            (PathBuf::from("/wt/5"), false),
            (PathBuf::from("/repo"), true),
            (PathBuf::from("/wt/4"), false),
        ];
        let protos = ["proto-aa0001".to_owned(), "proto-bb0002".to_owned()];
        assert_eq!(
            ring(&open, &protos),
            vec![
                ws("/repo"),
                ws("/wt/5"),
                ws("/wt/4"),
                proto("proto-aa0001"),
                proto("proto-bb0002"),
                Tile::Board,
                Tile::Boxes,
                Tile::Pipelines
            ]
        );
        // no main checkout open: the workspaces as they opened
        assert_eq!(ring(&open[..1], &[])[0], ws("/wt/5"));
        // a prototype's tile is no place, and keeps its first-seen place as states change
        assert!(!proto("proto-aa0001").is_place());
        let look = |id: &str| crate::factory::PrototypeLook {
            id: id.into(),
            title: "cart badge".into(),
            card: None,
            state: crate::factory::PrototypeState::Running,
            session: None,
            branch: "proto/p7-cart-badge".into(),
            place: "Local".into(),
            since: "2026-10-31T10:00:00Z".into(),
            url: None,
            needs_you: false,
        };
        let mut order = vec!["proto-bb0002".to_owned(), "proto-gone00".to_owned()];
        super::super::protos::ordered(&mut order, &[look("proto-cc0003"), look("proto-bb0002")]);
        assert_eq!(order, ["proto-bb0002", "proto-cc0003"]);
    }

    #[test]
    fn the_walk_goes_round_the_workspaces_from_either_end() {
        let r = ring(
            &[
                (PathBuf::from("/repo"), true),
                (PathBuf::from("/wt/4"), false),
                (PathBuf::from("/wt/5"), false),
            ],
            &["proto-aa0001".to_owned()],
        );
        for (at, by, to) in [
            (ws("/repo"), 1, ws("/wt/4")),
            (ws("/wt/4"), 1, ws("/wt/5")),
            // the prototypes after the cards, then round again, never a place
            (ws("/wt/5"), 1, proto("proto-aa0001")),
            (proto("proto-aa0001"), 1, ws("/repo")),
            (ws("/repo"), -1, proto("proto-aa0001")),
            (proto("proto-aa0001"), -1, ws("/wt/5")),
            (ws("/wt/4"), -1, ws("/repo")),
            // from a place the places, round again, never a workspace
            (Tile::Board, 1, Tile::Boxes),
            (Tile::Boxes, 1, Tile::Pipelines),
            (Tile::Pipelines, 1, Tile::Board),
            (Tile::Board, -1, Tile::Pipelines),
            // a workspace gone from the rail: ↓ the first, ↑ the last
            (ws("/gone"), 1, ws("/repo")),
            (ws("/gone"), -1, proto("proto-aa0001")),
        ] {
            assert_eq!(step(&r, &at, by), Some(to), "{at:?} by {by}");
        }
        // only Abe: it stays
        let abe = ring(&[(PathBuf::from("/repo"), true)], &[]);
        assert_eq!(step(&abe, &ws("/repo"), 1), Some(ws("/repo")));
        assert_eq!(step(&PLACES, &ws("/repo"), 1), None);
        assert_eq!(step(&[], &Tile::Board, 1), None);
    }

    #[test]
    fn the_cards_drawn_keep_the_selected_one_in_view() {
        for (n, cap, sel, range) in [
            (3, 5, Some(2), 0..3),
            (8, 5, None, 0..5),
            (8, 5, Some(4), 0..5),
            (8, 5, Some(5), 1..6),
            (8, 5, Some(7), 3..8),
        ] {
            assert_eq!(shown_range(n, cap, sel), range, "{n} {cap} {sel:?}");
        }
        assert_eq!(capacity(0.), 1);
        assert!(capacity(900.) >= 8);
    }

    #[test]
    fn section_goes_to_abe_and_again_back() {
        let r = ring(
            &[
                (PathBuf::from("/repo"), true),
                (PathBuf::from("/wt/4"), false),
            ],
            &[],
        );
        let abe = ws("/repo");
        for (at, back, to) in [
            (ws("/wt/4"), None, Some(abe.clone())),
            (Tile::Board, Some(ws("/wt/4")), Some(abe.clone())),
            (abe.clone(), Some(ws("/wt/4")), Some(ws("/wt/4"))),
            (abe.clone(), Some(Tile::Boxes), Some(Tile::Boxes)),
            // nowhere to go back to (closed since, or never left)
            (abe.clone(), Some(ws("/gone")), None),
            (abe.clone(), None, None),
        ] {
            assert_eq!(abe_key(&at, Some(&abe), back.as_ref(), &r), to, "{at:?}");
        }
        assert_eq!(abe_key(&Tile::Board, None, None, &r), None);
    }
}
