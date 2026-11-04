//! Search Everywhere (All / Files / Symbols tabs; Go to File is its Files tab) and the plain file
//! lists that look like it: Recent Files, Open Files, Recent Projects.
//!
//! Look: WebStorm's Search Everywhere (`BigPopupUI`, `SENewUIHeaderView`): 670 wide, tabs with a
//! 3 px underline on the selected one and the tab's toolbar on the right ("Include non-project
//! items", the preview toggle), the borderless search field over a line inset 12, rows "icon name
//! dir" (the name in its git status color, the dir grayed right after it; symbols: the file on
//! the right; files outside the project on the yellow file color), no hover look, a hint bar at
//! the bottom; with the preview the list gets a third and the preview the rest. An empty query
//! with no results shows only the header and the field (`ViewType.SHORT`). Placed centred, at a
//! quarter of the window's height (`calcPositionAndShow`).

use std::collections::BTreeSet;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    SharedString, Size, Styled as _, Subscription, Task, Window, div, prelude::FluentBuilder as _,
    px, uniform_list,
};
use nucleo_matcher::{Config, Matcher};
use rmpv::Value;
use serde::Deserialize;

use super::find::{FIELD_INPUT_PAD_X, FIELD_INSET_X, FIELD_ROW};
use super::preview;
use super::rank::{self, Hit, Source};
use super::rows::{self, absolute, display_path, split_path};
use super::{Action, PickerState, PickersView, Popup, Target};
use crate::git::{FileStatus, GitStatus};
use crate::kit::{self, Icon, IconName};
use crate::kit::{CheckState, Checkbox};
use crate::kit::{FieldEvent, TextField};
use crate::kit::{ListSource, ListState};
use crate::look;
use crate::shell::SurfaceCx;

// WebStorm metrics (compact density), see the module doc; sources in the comments.
/// `BigPopupUI` results pane width.
pub(crate) const WIDTH: f32 = 670.;
/// `TabbedPaneHeader` tab height (DAR `TabbedPane.tabHeight.compact` 36; default 40).
pub(crate) const TAB_HEIGHT: f32 = 36.;
/// Tab insets 0,12 (`TabbedPane.tabInsets`).
pub(crate) const TAB_PAD_X: f32 = 12.;
/// `TabbedPane.tabSelectionHeight` 3, arc 4, `TabbedPane.underlineColor` = Blue6.
pub(crate) const TAB_UNDERLINE: f32 = 3.;
pub(crate) const TAB_UNDERLINE_COLOR: crate::look::Tok = look::FOCUS_BORDER;
/// MID `SearchEverywhere.Header.insets` 2,4,0,9 (top, left, bottom, right).
pub(crate) const HEADER_PAD_TOP: f32 = 2.;
pub(crate) const HEADER_PAD_LEFT: f32 = 4.;
/// `HeaderTabbedPaneUI.getTabLabelShiftY`: the label 1 px lower.
pub(crate) const TAB_LABEL_SHIFT_Y: f32 = 1.;
/// The header toolbar (`SENewUIHeaderView` toolbar border 2,18,2,9): right inset 9.
const TOOLBAR_PAD_R: f32 = 9.;
/// Results pane max height (`BigPopupUI` 600 incl. header / field).
pub(crate) const MAX_HEIGHT: f32 = 600.;
/// Hint bar: `SearchEverywhere.Advertiser.background` resolves to MID `*.background`.
pub(crate) const AD_BG: crate::look::Tok = look::PANEL_BG;
/// Icon -> name gap in SE rows (`SimpleColoredComponent` default iconTextGap 2).
const ICON_GAP: f32 = 2.;
/// Recent Projects: `RecentProjectIconHelper` popup icons 20 px; the row grows to fit them
/// (ListPopup cell insets 2,8).
const PROJECT_ROW: f32 = 24.;
/// Its icon -> name gap (`ActionsList.elementIconGap` 6).
const PROJECT_ICON_GAP: f32 = 6.;
/// Rows shown at most (the rest scrolls); matching keeps this many.
const LIMIT: usize = 500;
/// WS `SearchEverywhereUI` MULTIPLE_CONTRIBUTORS_ELEMENTS_LIMIT (All) / SINGLE_CONTRIBUTOR_
/// ELEMENTS_LIMIT (one tab): results listed before the "… more" row, which lists that many more.
const MORE_ALL: usize = 15;
const MORE_TAB: usize = 30;
/// The "… more" row: `SEResultsListFactory.createMoreRenderer` (`search.everywhere.points.more`,
/// SMALL_LABEL_ATTRS at FontSize.SMALL).
const MORE_TEXT: &str = "\u{2026} more";
/// Its font: UIUtil FontSize.SMALL (11).
const MORE_FONT_SIZE: f32 = look::STRIPE_FONT_SIZE;
/// Preview (Alt+P): `SearchEverywhereUI` splitter proportion 0.33 for the list, the preview at
/// least 10 lines (`PREVIEW_MIN_LINES`).
const PREVIEW_SHARE: f32 = 0.33;
const PREVIEW_MIN_LINES: usize = 10;
/// The preview's whole popup height (list + preview): WS's preview popup is a tall one.
const PREVIEW_BODY_MAX: f32 = 640.;

/// What a Search Everywhere-like popup lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Search Everywhere's All tab: the files (recent first, like snacks' smart source), then
    /// the workspace symbols, each group under its title when both have results.
    All,
    /// Files tab (Go to File, Cmd+O).
    Files,
    /// Symbols tab: LSP workspace symbols.
    Symbols,
    /// Recent Files.
    Recent,
    /// Open Files (buffers).
    Buffers,
    /// Recent Projects (Cmd+Shift+O).
    Projects,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "all" => Kind::All,
            "files" => Kind::Files,
            "symbols" => Kind::Symbols,
            "recent" => Kind::Recent,
            "buffers" => Kind::Buffers,
            "projects" => Kind::Projects,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::All => "all",
            Kind::Files => "files",
            Kind::Symbols => "symbols",
            Kind::Recent => "recent",
            Kind::Buffers => "buffers",
            Kind::Projects => "projects",
        }
    }

    /// One of Search Everywhere's tabs.
    pub fn is_tab(self) -> bool {
        matches!(self, Kind::All | Kind::Files | Kind::Symbols)
    }

    /// Search Everywhere's results per "… more" step (None: everything listed).
    fn chunk(self) -> Option<usize> {
        match self {
            Kind::All => Some(MORE_ALL),
            Kind::Files | Kind::Symbols => Some(MORE_TAB),
            Kind::Recent | Kind::Buffers | Kind::Projects => None,
        }
    }

    /// Lists the project's files.
    pub fn uses_index(self) -> bool {
        matches!(self, Kind::All | Kind::Files)
    }

    fn title(self) -> &'static str {
        match self {
            Kind::All | Kind::Files | Kind::Symbols => "Search Everywhere",
            Kind::Recent => "Recent Files",
            Kind::Buffers => "Open Files",
            Kind::Projects => "Recent Projects",
        }
    }
}

const TABS: [(Kind, &str); 3] = [
    (Kind::All, "All"),
    (Kind::Files, "Files"),
    (Kind::Symbols, "Symbols"),
];

/// A workspace symbol from Lua (`config/app/pickers.lua` `symbols`).
#[derive(Clone, Debug, Deserialize)]
pub struct SymbolItem {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub container: String,
    pub file: String,
    /// The file as shown (relative to the project, else `~/...`).
    #[serde(default)]
    pub rel: String,
    #[serde(default)]
    pub line: u32,
    /// LSP `character` + 1 (in `enc` units, not bytes).
    #[serde(default)]
    pub col: u32,
    /// The server's offset encoding ("utf-16"...).
    #[serde(default)]
    pub enc: Option<String>,
}

/// Candidates to merge: open files, recent files, the project's files (shown paths).
type Pending = (Vec<String>, Vec<String>, Arc<Vec<String>>);

/// A results group: All lists the files, then the symbols (WS's contributors); the other kinds
/// one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Group {
    Files,
    Symbols,
}

impl Group {
    fn ix(self) -> usize {
        match self {
            Group::Files => 0,
            Group::Symbols => 1,
        }
    }

    /// Its title row (All with both groups: WS's group separator).
    fn title(self) -> &'static str {
        match self {
            Group::Files => "Files",
            Group::Symbols => "Symbols",
        }
    }
}

/// A list row: a group's title, a result (`hits[i]` / `sym_rows[i]`) or a group's "… more".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Row {
    Title(Group),
    File(usize),
    Symbol(usize),
    More(Group),
}

/// The rows for [`ListState`]: titles take no cursor (no speed search here: the field is the
/// search).
struct Rows<'a>(&'a [Row]);

impl ListSource for Rows<'_> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn text(&self, _: usize) -> SharedString {
        SharedString::default()
    }
    fn selectable(&self, ix: usize) -> bool {
        !matches!(self.0.get(ix), Some(Row::Title(_)))
    }
}

pub struct SearchPopup {
    pub kind: Kind,
    pub field: Entity<TextField>,
    project: PathBuf,
    /// Open files / recent files from Lua (absolute).
    open: Vec<String>,
    recent: Vec<String>,
    index: Option<Arc<Vec<String>>>,
    /// Recent Projects' rows (`crate::shell`).
    projects: Vec<crate::shell::RecentProject>,
    /// Snacks' Alt+H / Alt+I on the file tabs: hidden / ignored files too (this popup's own walk).
    hidden: bool,
    ignored: bool,
    /// The candidates to merge off the UI thread at the next match (open, recent, index).
    pending: Option<Pending>,
    /// Candidates (shown paths) and where each came from.
    cands: Arc<Vec<Arc<str>>>,
    sources: Arc<Vec<Source>>,
    hits: Vec<Hit>,
    symbols: Vec<SymbolItem>,
    /// Symbols in shown order with their matched chars.
    sym_rows: Vec<(usize, Vec<u32>)>,
    /// The list's rows (titles, results, "… more"), from `hits` / `sym_rows` and `pages`.
    layout: Vec<Row>,
    list: ListState,
    /// The Project tree's git status when the popup opened (name colors).
    git: Option<Arc<GitStatus>>,
    /// Snacks' Tab multi-selection (rows; not on Search Everywhere's tabs, where Tab switches).
    selected: BTreeSet<usize>,
    /// Lines the preview is scrolled from its default (Ctrl+F / Ctrl+B, the wheel).
    pub preview_scroll: f32,
    /// Code lines the preview had at the last render.
    preview_rows: usize,
    /// Bumped per query; answers for older ones are dropped.
    seq: u64,
    /// Bumped per symbols request (All asks beside its file match); older answers are dropped.
    sym_seq: u64,
    /// Results for `seq` are in.
    settled: bool,
    /// "… more" steps taken per group for these results (1: the first chunk).
    pages: [usize; 2],
    match_task: Option<Task<()>>,
    /// Where keys typed before the popup had the keyboard go (the caret when it opened).
    pub typeahead_at: Option<usize>,
    preview: bool,
    _sub: Subscription,
}

impl SearchPopup {
    #[allow(
        clippy::too_many_arguments,
        reason = "Lua's open payload + what the picker caches, passed straight through"
    )]
    pub fn new(
        kind: Kind,
        project: PathBuf,
        query: Option<String>,
        open: Vec<String>,
        recent: Vec<String>,
        index: Option<Arc<Vec<String>>>,
        git: Option<Arc<GitStatus>>,
        scx: &SurfaceCx,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> Self {
        let field = cx.new(|cx| {
            let mut f = TextField::new(cx)
                .search()
                .borderless()
                .pad_x(FIELD_INPUT_PAD_X)
                .height(FIELD_ROW);
            if let Some(q) = &query {
                f.set_text(q.clone(), cx);
                // like snacks' `pattern`: the text there, selected so typing replaces it
                f.select_all(cx);
            }
            f
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |this: &mut PickersView, _, ev, window, cx| {
                if *ev == FieldEvent::Changed {
                    this.query_changed(window, cx);
                }
            },
        );
        let at = field.read(cx).text().len();
        let mut s = SearchPopup {
            kind,
            field,
            project,
            open,
            recent,
            index,
            hidden: false,
            ignored: false,
            pending: None,
            // read off the UI thread (below)
            projects: Vec::new(),
            cands: Arc::default(),
            sources: Arc::default(),
            hits: Vec::new(),
            symbols: Vec::new(),
            sym_rows: Vec::new(),
            layout: Vec::new(),
            list: ListState::new(),
            git,
            selected: BTreeSet::new(),
            preview_scroll: 0.,
            preview_rows: PREVIEW_MIN_LINES,
            seq: 0,
            sym_seq: 0,
            settled: false,
            pages: [1, 1],
            match_task: None,
            typeahead_at: Some(at),
            preview: false,
            _sub: sub,
        };
        s.rebuild();
        s.requery(scx, window, cx);
        if kind == Kind::Projects {
            // the open projects on top, this one first
            let task = crate::shell::recent_open_first(scx.project.clone(), cx);
            cx.spawn(async move |this, cx| {
                let list = task.await;
                let _ = this.update(cx, |p, cx| {
                    if let Some(super::Popup::Search(s)) = &mut p.popup {
                        s.set_projects(list, cx);
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        s
    }

    pub fn set_sources(&mut self, open: Vec<String>, recent: Vec<String>) {
        self.open = open;
        self.recent = recent;
    }

    /// Switches tabs, keeping the text (one popup: never blank).
    pub fn set_kind(
        &mut self,
        kind: Kind,
        scx: &SurfaceCx,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) {
        if self.kind == kind {
            return;
        }
        self.kind = kind;
        self.relayout();
        self.rebuild();
        self.requery(scx, window, cx);
    }

    pub fn set_query(
        &mut self,
        q: &str,
        scx: &SurfaceCx,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) {
        self.field.update(cx, |f, cx| f.set_text(q.to_string(), cx));
        self.requery(scx, window, cx);
    }

    /// The recent projects were read (Recent Projects).
    pub fn set_projects(
        &mut self,
        projects: Vec<crate::shell::RecentProject>,
        cx: &mut Context<PickersView>,
    ) {
        self.projects = projects;
        if self.kind == Kind::Projects {
            self.rebuild();
            self.rematch(cx);
        }
    }

    /// The project was walked (again).
    pub fn index_changed(&mut self, index: Arc<Vec<String>>, cx: &mut Context<PickersView>) {
        if self.hidden || self.ignored {
            return; // its own walk (Alt+H / Alt+I)
        }
        self.index = Some(index);
        if self.kind.uses_index() {
            self.rebuild();
            self.rematch(cx);
        }
    }

    /// Candidates for the kind: open files, recent files, then the project's files (deduped). The
    /// file tabs' (10k+ paths) are merged off the UI thread at the next match.
    fn rebuild(&mut self) {
        let shown = |paths: &[String]| -> Vec<String> {
            paths
                .iter()
                .map(|p| display_path(&self.project, Path::new(p)))
                .collect()
        };
        let (open, recent, index) = match self.kind {
            Kind::All | Kind::Files => (
                shown(&self.open),
                shown(&self.recent),
                self.index.clone().unwrap_or_default(),
            ),
            Kind::Recent | Kind::Buffers => (Vec::new(), shown(&self.recent), Arc::default()),
            Kind::Projects => (
                Vec::new(),
                Vec::new(),
                Arc::new(
                    self.projects
                        .iter()
                        .map(|p| crate::shell::display_path(&p.path))
                        .collect(),
                ),
            ),
            Kind::Symbols => (Vec::new(), Vec::new(), Arc::default()),
        };
        // merged with the next match, so rows and candidates always change together
        self.pending = Some((open, recent, index));
    }

    fn query(&self, cx: &gpui_kit::App) -> String {
        self.field.read(cx).text().to_string()
    }

    /// The text changed: match again (files off the UI thread; symbols: ask Lua).
    pub fn requery(
        &mut self,
        scx: &SurfaceCx,
        _window: &mut Window,
        cx: &mut Context<PickersView>,
    ) {
        if self.kind == Kind::Symbols {
            // a file match still running from All / Files never lands here
            self.seq += 1;
            self.match_task = None;
            self.settled = false;
            self.ask_symbols(scx, cx);
            self.rank_symbols(cx);
            return;
        }
        if self.kind == Kind::All {
            self.ask_symbols(scx, cx);
            // the symbols held drop what no longer matches until the server answers
            self.rank_symbols(cx);
        }
        self.rematch(cx);
    }

    /// Asks Lua for the query's workspace symbols ([`Self::symbols_answer`]); All with nothing
    /// typed lists none.
    fn ask_symbols(&mut self, scx: &SurfaceCx, cx: &mut Context<PickersView>) {
        self.sym_seq += 1;
        let q = self.query(cx);
        if self.kind == Kind::All && q.is_empty() {
            self.symbols.clear();
            self.sym_rows.clear();
            // no row may point at the symbols dropped
            self.relayout();
            return;
        }
        scx.call(
            "config.app.pickers",
            "symbols",
            vec![Value::from(self.sym_seq), Value::from(q)],
        );
    }

    fn rematch(&mut self, cx: &mut Context<PickersView>) {
        self.seq += 1;
        let seq = self.seq;
        self.settled = false;
        let query = self.query(cx);
        // kept until a match built from it lands (a newer query may outrun this one)
        let pending = self.pending.clone();
        let (cands, sources) = (self.cands.clone(), self.sources.clone());
        let task = cx.background_spawn(async move {
            let (cands, sources) = match pending {
                Some((open, recent, index)) => {
                    let (c, s) = rank::merge(&open, &recent, &index);
                    (Arc::new(c), Arc::new(s))
                }
                None => (cands, sources),
            };
            let mut m = Matcher::new(Config::DEFAULT.match_paths());
            let hits = rank::rank(&query, &cands, &sources, LIMIT, &mut m);
            (cands, sources, hits)
        });
        self.match_task = Some(cx.spawn(async move |this, cx| {
            let (cands, sources, hits) = task.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(Popup::Search(s)) = &mut this.popup
                    && s.seq == seq
                {
                    s.cands = cands;
                    s.sources = sources;
                    s.pending = None;
                    s.hits = hits;
                    // the project's files still being walked: more results to come
                    s.settled = s.index.is_some() || !s.kind.uses_index();
                    s.selected.clear();
                    s.preview_scroll = 0.;
                    s.pages = [1, 1];
                    s.relayout();
                    s.list.set_cursor(s.first_result());
                    this.prefetch_preview(cx);
                    cx.notify();
                }
            });
        }));
    }

    /// Alt+H / Alt+I: walks the project again with hidden / ignored files for this popup.
    fn rewalk(&mut self, index: Option<Arc<Vec<String>>>, cx: &mut Context<PickersView>) {
        if !self.hidden && !self.ignored {
            // back to the shared index
            self.index = index;
            self.rebuild();
            self.rematch(cx);
            return;
        }
        let (root, hidden, ignored) = (self.project.clone(), self.hidden, self.ignored);
        let walk = crate::shell::remote::background(&self.project, cx, move || {
            super::index::list(&root, hidden, ignored)
        });
        self.match_task = Some(cx.spawn(async move |this, cx| {
            let files = walk.await.flatten();
            let _ = this.update(cx, |this, cx| {
                if let Some(Popup::Search(s)) = &mut this.popup
                    && (s.hidden, s.ignored) == (hidden, ignored)
                {
                    // a box that did not answer: the list as it was
                    if let Some(files) = files {
                        s.index = Some(Arc::new(files));
                    }
                    s.rebuild();
                    s.rematch(cx);
                }
            });
        }));
    }

    /// Lua's answer to a symbols request (the Symbols tab's, or All's beside its files).
    pub fn symbols_answer(
        &mut self,
        id: u64,
        items: Vec<SymbolItem>,
        cx: &mut Context<PickersView>,
    ) {
        if !matches!(self.kind, Kind::Symbols | Kind::All) || id != self.sym_seq {
            return;
        }
        self.symbols = items;
        if self.kind == Kind::Symbols {
            self.settled = true;
        }
        self.rank_symbols(cx);
    }

    /// Orders the symbols by match quality (matched chars highlighted); on the Symbols tab the
    /// server's own fuzzy hits nucleo doesn't see stay, after them (All lists only the matches:
    /// its files come first).
    fn rank_symbols(&mut self, cx: &mut Context<PickersView>) {
        let q = self.query(cx);
        let names: Vec<&str> = self.symbols.iter().map(|s| s.name.as_str()).collect();
        let mut m = Matcher::new(Config::DEFAULT);
        let mut rows: Vec<(usize, Vec<u32>)> = rank::rank_plain(&q, &names, &mut m)
            .into_iter()
            .map(|(ix, _, m)| (ix, m))
            .collect();
        if self.kind == Kind::Symbols {
            let mut seen = vec![false; names.len()];
            for (ix, _) in &rows {
                seen[*ix] = true;
            }
            rows.extend(
                (0..names.len())
                    .filter(|i| !seen[*i])
                    .map(|i| (i, Vec::new())),
            );
        }
        self.sym_rows = rows;
        self.pages[Group::Symbols.ix()] = 1;
        if self.kind == Kind::Symbols {
            self.relayout();
            self.list.set_cursor(self.first_result());
        } else {
            // the files listed first keep the selection
            self.relayout();
        }
    }

    /// The kind's groups, in list order.
    fn groups(&self) -> &'static [Group] {
        match self.kind {
            Kind::All => &[Group::Files, Group::Symbols],
            Kind::Symbols => &[Group::Symbols],
            Kind::Files | Kind::Recent | Kind::Buffers | Kind::Projects => &[Group::Files],
        }
    }

    /// A group's results, listed or not.
    fn group_total(&self, g: Group) -> usize {
        match g {
            Group::Files => self.hits.len(),
            Group::Symbols => self.sym_rows.len(),
        }
    }

    /// Lays the rows out again: each group with results, a chunk per "… more" step on Search
    /// Everywhere's tabs, under its title when more than one group has results. The selected
    /// row stays selected while it is still listed, else the first result is.
    fn relayout(&mut self) {
        let kept = self.list.cursor().and_then(|c| self.layout.get(c).copied());
        let groups = self.groups();
        let titled = groups.iter().filter(|g| self.group_total(**g) > 0).count() > 1;
        let mut rows = Vec::new();
        for &g in groups {
            let total = self.group_total(g);
            if total == 0 {
                continue;
            }
            if titled {
                rows.push(Row::Title(g));
            }
            let shown = self
                .kind
                .chunk()
                .map_or(total, |c| total.min(c * self.pages[g.ix()]));
            rows.extend((0..shown).map(|i| match g {
                Group::Files => Row::File(i),
                Group::Symbols => Row::Symbol(i),
            }));
            if shown < total {
                rows.push(Row::More(g));
            }
        }
        self.layout = rows;
        self.list.refresh(&Rows(&self.layout));
        let at = kept
            .and_then(|k| self.layout.iter().position(|r| *r == k))
            .or_else(|| self.first_result());
        if at != self.list.cursor() {
            self.list.set_cursor(at);
        }
    }

    /// The first result's row (not a title).
    fn first_result(&self) -> Option<usize> {
        self.layout
            .iter()
            .position(|r| matches!(r, Row::File(_) | Row::Symbol(_)))
    }

    /// List rows: titles, the listed results and the "… more" rows.
    fn row_count(&self) -> usize {
        self.layout.len()
    }

    /// Whether a row's result is still there (a row laid out before its group changed is not).
    fn listed(&self, row: Row) -> bool {
        match row {
            Row::File(i) => self.hits.get(i).is_some(),
            Row::Symbol(i) => self
                .sym_rows
                .get(i)
                .is_some_and(|(ix, _)| *ix < self.symbols.len()),
            Row::Title(_) | Row::More(_) => true,
        }
    }

    /// The group whose "… more" row has the cursor.
    fn more_at_cursor(&self) -> Option<Group> {
        match self.list.cursor().and_then(|r| self.row(r)) {
            Some(Row::More(g)) => Some(g),
            _ => None,
        }
    }

    fn row(&self, row: usize) -> Option<Row> {
        self.layout.get(row).copied()
    }

    /// The file match listed on `row`.
    fn hit_at(&self, row: usize) -> Option<&Hit> {
        match self.row(row)? {
            Row::File(i) => self.hits.get(i),
            _ => None,
        }
    }

    /// The symbol listed on `row`.
    fn symbol_at(&self, row: usize) -> Option<&SymbolItem> {
        match self.row(row)? {
            Row::Symbol(i) => self.symbols.get(self.sym_rows.get(i)?.0),
            _ => None,
        }
    }

    /// A group's "… more" row picked (Enter, a click): its next chunk, the selection on the
    /// first new result (WS `showMoreElements`).
    fn show_more(&mut self, g: Group) {
        let Some(first) = self.layout.iter().position(|r| *r == Row::More(g)) else {
            return;
        };
        self.pages[g.ix()] += 1;
        self.relayout();
        self.list.set_cursor(Some(first));
    }

    /// Keys the field let through.
    pub fn key(
        &mut self,
        key: &str,
        shared_index: Option<Arc<Vec<String>>>,
        scx: &SurfaceCx,
        window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> Action {
        let page = 10isize;
        let mv = |s: &mut Self, k: &str| {
            s.list.key(k, None, &Rows(&s.layout), &Default::default());
            Action::Handled
        };
        let multi = !self.kind.is_tab() && self.kind != Kind::Projects;
        let action = match key {
            "<Tab>" | "<S-Tab>" if self.kind.is_tab() => {
                let i = TABS.iter().position(|(k, _)| *k == self.kind).unwrap_or(0) as isize;
                let d = if key == "<Tab>" { 1 } else { -1 };
                let next = TABS[(i + d).rem_euclid(TABS.len() as isize) as usize].0;
                self.set_kind(next, scx, window, cx);
                Action::Handled
            }
            // snacks' select_and_next / select_and_prev
            "<Tab>" | "<S-Tab>" if multi => {
                if let Some(row) = self.list.cursor()
                    && !self.selected.remove(&row)
                {
                    self.selected.insert(row);
                }
                mv(self, if key == "<Tab>" { "<Down>" } else { "<Up>" })
            }
            "<Down>" | "<C-n>" | "<C-j>" => mv(self, "<Down>"),
            "<Up>" | "<C-p>" | "<C-k>" => mv(self, "<Up>"),
            "<PageDown>" | "<C-d>" => {
                self.list.set_page_rows(page as usize);
                mv(self, "<PageDown>")
            }
            "<PageUp>" | "<C-u>" => {
                self.list.set_page_rows(page as usize);
                mv(self, "<PageUp>")
            }
            "<M-p>" => {
                self.preview = !self.preview;
                Action::Handled
            }
            "<C-f>" | "<C-b>" if self.preview => {
                let half = (self.preview_rows / 2) as f32;
                self.preview_scroll += if key == "<C-f>" { half } else { -half };
                return Action::Handled;
            }
            "<M-h>" | "<M-i>" if self.kind.uses_index() => {
                if key == "<M-h>" {
                    self.hidden = !self.hidden;
                } else {
                    self.ignored = !self.ignored;
                }
                self.rewalk(shared_index, cx);
                Action::Handled
            }
            "<C-x>" if self.kind == Kind::Buffers => self.delete_buffer(cx),
            "<C-q>" if multi => self.quickfix(),
            "<CR>" | "<S-CR>" | "<C-v>" | "<C-s>" if let Some(g) = self.more_at_cursor() => {
                self.show_more(g);
                Action::Handled
            }
            "<CR>" => self.confirm(self.list.cursor(), "edit"),
            "<S-CR>" => self.confirm(self.list.cursor(), "pick"),
            "<C-v>" => self.confirm(self.list.cursor(), "vsplit"),
            "<C-s>" => self.confirm(self.list.cursor(), "split"),
            "<Esc>" | "<C-c>" => Action::Close,
            _ => Action::Ignored,
        };
        if !matches!(action, Action::Ignored) {
            self.preview_scroll = 0.;
        }
        action
    }

    /// Ctrl+X in Open Files: closes the buffer, the row goes (snacks' bufdelete).
    fn delete_buffer(&mut self, cx: &mut Context<PickersView>) -> Action {
        let Some(hit) = self.list.cursor().and_then(|r| self.hit_at(r)) else {
            return Action::Handled;
        };
        let path = absolute(&self.project, &self.cands[hit.ix]);
        let p = path.to_string_lossy().into_owned();
        self.recent.retain(|r| *r != p);
        self.rebuild();
        self.rematch(cx);
        Action::Call {
            func: "bufdelete",
            args: vec![Value::from(p)],
        }
    }

    /// The rows Enter / Ctrl+Q act on: the Tab selection, else the cursor's.
    fn targets(&self, row: Option<usize>) -> Vec<Target> {
        let rows: Vec<usize> = if self.selected.is_empty() {
            row.into_iter().collect()
        } else {
            self.selected.iter().copied().collect()
        };
        rows.into_iter().filter_map(|r| self.target(r)).collect()
    }

    /// A row's file to open (none for a folder row).
    fn target(&self, row: usize) -> Option<Target> {
        if self.folder_at(row).is_some() {
            return None;
        }
        if let Some(s) = self.symbol_at(row) {
            return Some(Target {
                path: PathBuf::from(&s.file),
                line: Some(s.line),
                col: Some(s.col),
                enc: s.enc.clone(),
                text: s.name.clone(),
            });
        }
        let hit = self.hit_at(row)?;
        Some(Target::file(absolute(&self.project, &self.cands[hit.ix])))
    }

    /// Ctrl+Q: the selection (else every row) into the quickfix list.
    fn quickfix(&self) -> Action {
        let targets = if self.selected.is_empty() {
            (0..self.row_count())
                .filter_map(|r| self.target(r))
                .collect()
        } else {
            self.targets(None)
        };
        Action::Quickfix {
            title: self.kind.title().to_string(),
            targets,
        }
    }

    /// The row's folder (absolute, no trailing `/`), when it's a folder row.
    fn folder_at(&self, row: usize) -> Option<PathBuf> {
        let path = &self.cands[self.hit_at(row)?.ix];
        let dir = path.strip_suffix('/')?;
        Some(absolute(&self.project, dir))
    }

    /// Opens the row (or the Tab selection); nothing yet: the popup stays. A folder is revealed in
    /// the Project tree (WebStorm's Go to File on a directory).
    fn confirm(&self, row: Option<usize>, how: &'static str) -> Action {
        if self.selected.is_empty()
            && let Some(dir) = row.and_then(|r| self.folder_at(r))
        {
            return Action::Reveal(dir);
        }
        let targets = self.targets(row);
        if targets.is_empty() {
            return Action::Handled;
        }
        if self.kind == Kind::Projects {
            // Enter / a click: in place of this project; Shift: alongside it
            return Action::Project {
                dir: targets[0].path.clone(),
                alongside: how == "pick",
            };
        }
        Action::Open { targets, how }
    }

    /// What the preview shows: (file, line, rows, scroll).
    pub fn preview_target(&self) -> Option<(PathBuf, u32, usize, isize)> {
        let path = self.selected_path()?;
        let line = self
            .symbol_at(self.list.cursor()?)
            .map_or(1, |s| s.line.max(1));
        Some((
            path,
            line,
            self.preview_rows,
            self.preview_scroll.round() as isize,
        ))
    }

    /// The selected row's file, while the preview is shown.
    pub fn selected_path(&self) -> Option<PathBuf> {
        if !self.preview {
            return None;
        }
        let row = self.list.cursor()?;
        if let Some(s) = self.symbol_at(row) {
            return Some(PathBuf::from(&s.file));
        }
        let hit = self.hit_at(row)?;
        let path = &self.cands[hit.ix];
        // a folder has nothing to preview
        (!rank::is_dir(path)).then(|| absolute(&self.project, path))
    }

    /// "Include non-project items": hidden and ignored files too (snacks' Alt+H + Alt+I).
    fn non_project(&self) -> bool {
        self.hidden && self.ignored
    }

    /// A file row's git status (None: unchanged, a folder row, outside the project).
    fn status(&self, shown: &str) -> Option<FileStatus> {
        let git = self.git.as_ref()?;
        if rank::is_dir(shown) || shown.starts_with('/') || shown.starts_with("~/") {
            return None;
        }
        git.status(Path::new(shown), false)
    }

    /// The rows as tests see them: titles by name, results by label; a "… more" row ending the
    /// list only as `more` (one between groups as its text).
    pub fn state(&self, cx: &gpui_kit::App) -> PickerState {
        let last_more = matches!(self.layout.last(), Some(Row::More(_)));
        let listed = &self.layout[..self.layout.len() - usize::from(last_more)];
        let (mut rows, mut details, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
        for row in listed {
            if !self.listed(*row) {
                continue;
            }
            let (name, detail, status) = match *row {
                Row::Title(g) => (g.title().to_string(), String::new(), String::new()),
                Row::More(_) => (MORE_TEXT.to_string(), String::new(), String::new()),
                Row::File(i) => {
                    let shown = &self.cands[self.hits[i].ix];
                    let (dir, name) = split_entry(shown);
                    let status = self
                        .status(shown)
                        .map_or(String::new(), |s| format!("{s:?}"));
                    (name.to_string(), dir.to_string(), status)
                }
                Row::Symbol(i) => {
                    let s = &self.symbols[self.sym_rows[i].0];
                    (s.name.clone(), s.rel.clone(), String::new())
                }
            };
            rows.push(name);
            details.push(detail);
            statuses.push(status);
        }
        if self.kind == Kind::Symbols {
            statuses.clear();
        }
        PickerState {
            kind: self.kind.name().into(),
            query: self.field.read(cx).text().to_string(),
            rows,
            details,
            cursor: self.list.cursor(),
            settled: self.settled,
            preview: self.preview,
            title: self.kind.title().into(),
            statuses,
            checked: self.non_project(),
            more: last_more,
            ..Default::default()
        }
    }

    // Render -------------------------------------------------------------------------------------

    pub fn render(
        &mut self,
        viewport: Size<Pixels>,
        previews: &mut preview::Cache,
        _window: &mut Window,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        let margin = look::POPUP_WINDOW_MARGIN;
        let width = WIDTH.min(viewport.width.as_f32() - 2. * margin);
        let header_h = if self.kind.is_tab() {
            HEADER_PAD_TOP + TAB_HEIGHT + 1.
        } else {
            look::COMPLEX_HEADER_HEIGHT + 1.
        };
        let short = header_h + FIELD_ROW + 1.;
        // WebStorm: centred, the short popup's middle at a quarter of the window height
        let top = (viewport.height.as_f32() / 4. - short / 2.).max(margin);
        let x = kit::centered(width, viewport.width.as_f32());
        let ad_h = look::POPUP_AD_HEIGHT;
        let n = self.row_count();
        let row_h = self.row_height();
        let query_empty = self.query(cx).is_empty();
        // ViewType.SHORT: nothing typed, nothing listed: the header and the field only
        let collapsed = n == 0 && query_empty;
        let empty = n == 0 && (self.settled || !query_empty);
        let below = viewport.height.as_f32() - top - margin - short - ad_h;
        let (list_h, page) = if self.preview {
            // a splitter: the list a third, the preview the rest (at least 10 lines)
            let body = below.min(PREVIEW_BODY_MAX);
            let preview_fixed = 1. + preview::TITLE_HEIGHT;
            let mut list_rows = ((body * PREVIEW_SHARE) / row_h).floor().max(1.);
            let min_preview = preview_fixed + PREVIEW_MIN_LINES as f32 * preview::LINE_HEIGHT;
            if body - list_rows * row_h < min_preview {
                list_rows = ((body - min_preview) / row_h).floor().max(1.);
            }
            let list_h = list_rows * row_h;
            self.preview_rows = (((body - list_h - preview_fixed) / preview::LINE_HEIGHT).floor()
                as usize)
                .max(PREVIEW_MIN_LINES);
            (list_h, list_rows as usize)
        } else {
            let room = below.min(MAX_HEIGHT - short);
            let fit_rows = (room / row_h).floor().max(1.) as usize;
            let shown_rows = if empty { 2 } else { n.min(fit_rows) };
            (shown_rows as f32 * row_h, fit_rows)
        };
        self.list.set_page_rows(page.saturating_sub(1).max(1));

        let header = if self.kind.is_tab() {
            self.render_tabs(cx)
        } else {
            kit::complex_header(self.kind.title(), None).into_any_element()
        };
        let field_row = div()
            .id("se-field-row")
            .debug_selector(|| "se-field-row".into())
            .h(px(FIELD_ROW))
            .flex_none()
            .px(px(FIELD_INSET_X))
            .flex()
            .items_center()
            .cursor_text()
            .child(div().flex_1().child(self.field.clone()));
        let list: AnyElement = if empty {
            rows::empty_message("Nothing found")
        } else {
            uniform_list(
                "search-rows",
                n,
                cx.processor(
                    |this: &mut PickersView, range: Range<usize>, _window, cx| match &this.popup {
                        Some(Popup::Search(s)) => s.render_rows(range, cx),
                        _ => Vec::new(),
                    },
                ),
            )
            .track_scroll(self.list.scroll_handle())
            .size_full()
            .into_any_element()
        };
        let preview = (self.preview && !collapsed).then(|| self.render_preview(previews, cx));
        let ad = kit::ad_text(self.hint()).h(px(ad_h)).bg(AD_BG);
        let frame = kit::popup_frame()
            .id("search-everywhere")
            .debug_selector(|| "search-everywhere".into())
            .absolute()
            .left(px(x))
            .top(px(top))
            .w(px(width))
            // clicks inside stay inside (the workspace would hand them to nvim)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.close(window, cx);
            }))
            .child(header)
            .child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            .child(field_row)
            // the line under the field, inside the field border's 0,12 insets
            .child(
                div()
                    .h(px(1.))
                    .flex_none()
                    .mx(px(FIELD_INSET_X))
                    .bg(look::SEPARATOR),
            )
            .when(!collapsed, |d| {
                d.child(
                    div()
                        .id("se-list")
                        .debug_selector(|| "se-list".into())
                        .h(px(list_h))
                        .flex_none()
                        .child(list),
                )
                .children(preview)
                .child(ad)
            });
        frame.into_any_element()
    }

    /// Row height: 22, Recent Projects' rows with their 20 px icons a bit more.
    fn row_height(&self) -> f32 {
        if self.kind == Kind::Projects {
            PROJECT_ROW
        } else {
            look::LIST_ROW_HEIGHT.get()
        }
    }

    fn hint(&self) -> &'static str {
        match self.kind {
            Kind::All | Kind::Files => {
                "Press ⌃V to open in a split, ⌥P to preview, ⇥ for the next tab"
            }
            Kind::Symbols => "Press ⌃V to open in a split, ⇥ for the next tab",
            Kind::Projects => "Press ↩ to open in this window, ⇧↩ to open alongside",
            Kind::Recent | Kind::Buffers => "Press ⌃V to open in a split, ⌥P to preview",
        }
    }

    fn render_tabs(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let tabs = TABS.iter().map(|&(kind, label)| {
            let selected = kind == self.kind;
            div()
                .id(("se-tab", kind as usize))
                .debug_selector(move || format!("se-tab-{label}"))
                .h_full()
                .px(px(TAB_PAD_X))
                .relative()
                .flex()
                .items_center()
                .cursor_pointer()
                .hover(|d| d.bg(look::HOVER_BG))
                .child(
                    div()
                        .relative()
                        .top(px(TAB_LABEL_SHIFT_Y))
                        .child(SharedString::from(label)),
                )
                .when(selected, |d| {
                    d.child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom_0()
                            .h(px(TAB_UNDERLINE))
                            // TabbedPane.tabSelectionArc 4 on every corner
                            .rounded(px(2.))
                            .bg(TAB_UNDERLINE_COLOR),
                    )
                })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        let scx = this.scx.clone();
                        if let Some(Popup::Search(s)) = &mut this.popup {
                            s.set_kind(kind, &scx, window, cx);
                            let h = s.field.read(cx).focus_handle(cx);
                            window.focus(&h, cx);
                        }
                        cx.notify();
                    }),
                )
        });
        div()
            .id("se-header")
            .debug_selector(|| "se-header".into())
            .h(px(HEADER_PAD_TOP + TAB_HEIGHT))
            .flex_none()
            .pt(px(HEADER_PAD_TOP))
            .pl(px(HEADER_PAD_LEFT))
            .pr(px(TOOLBAR_PAD_R))
            .flex()
            .child(div().h_full().flex().items_end().children(tabs))
            .child(div().flex_1())
            .child(self.render_toolbar(cx))
            .into_any_element()
    }

    /// The tab's toolbar: "Include non-project items" (the file tabs) and the preview toggle.
    fn render_toolbar(&self, cx: &mut Context<PickersView>) -> AnyElement {
        let entity = cx.entity().downgrade();
        let state = if self.non_project() {
            CheckState::Checked
        } else {
            CheckState::Unchecked
        };
        let check = self.kind.uses_index().then(|| {
            div().debug_selector(|| "se-non-project".into()).child(
                Checkbox::new("se-non-project", state)
                    .label("Include non-project items")
                    .on_toggle(move |st, window, cx| {
                        let _ = entity.update(cx, |this, cx| {
                            let shared = this.index.clone();
                            if let Some(Popup::Search(s)) = &mut this.popup {
                                let on = st == CheckState::Checked;
                                s.hidden = on;
                                s.ignored = on;
                                s.rewalk(shared, cx);
                                let h = s.field.read(cx).focus_handle(cx);
                                window.focus(&h, cx);
                            }
                            cx.notify();
                        });
                    }),
            )
        });
        let on = self.preview;
        let preview = div()
            .id("se-preview-toggle")
            .debug_selector(|| "se-preview-toggle".into())
            .size(px(look::ACTION_BUTTON_SIZE))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(look::ACTION_BUTTON_ARC))
            .cursor_pointer()
            .when(on, |d| d.bg(look::ACTION_BUTTON_TOGGLED_BG))
            .when(!on, |d| d.hover(|d| d.bg(look::ACTION_BUTTON_HOVER_BG)))
            .child(Icon::new(IconName::EditorPreview))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    if let Some(Popup::Search(s)) = &mut this.popup {
                        s.preview = !s.preview;
                        s.preview_scroll = 0.;
                        let h = s.field.read(cx).focus_handle(cx);
                        window.focus(&h, cx);
                    }
                    this.prefetch_preview(cx);
                    cx.notify();
                }),
            );
        div()
            .h_full()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(8.))
            .children(check)
            .child(preview)
            .into_any_element()
    }

    fn render_rows(&self, range: Range<usize>, cx: &mut Context<PickersView>) -> Vec<AnyElement> {
        let row_h = self.row_height();
        range
            .filter_map(|row| {
                let selected = self.list.cursor() == Some(row) || self.selected.contains(&row);
                let (content, outside) = match self.row(row)? {
                    Row::Title(g) => return Some(self.title_row(row, g)),
                    Row::More(g) => return Some(self.more_row_element(row, g, selected, cx)),
                    Row::Symbol(i) => {
                        let (ix, m) = self.sym_rows.get(i)?;
                        (self.symbol_row(&self.symbols[*ix], m, selected, cx), false)
                    }
                    Row::File(i) => {
                        let hit = self.hits.get(i)?;
                        let shown = &self.cands[hit.ix];
                        let outside = self.kind != Kind::Projects
                            && (shown.starts_with('/') || shown.starts_with("~/"));
                        (self.file_row(hit, selected), outside)
                    }
                };
                // no hover look: WS's Search Everywhere list paints only the selection
                Some(
                    rows::row_tinted(
                        ("search-row", row),
                        px(row_h),
                        selected,
                        false,
                        // WS file colors: a file outside the project on "Non-Project Files"
                        outside.then_some(look::EXCLUDED_ROW_BG.rgba()),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            let Some(Popup::Search(s)) = &mut this.popup else {
                                return;
                            };
                            let h = s.field.read(cx).focus_handle(cx);
                            window.focus(&h, cx);
                            // click selects, double-click opens (today's snacks lists)
                            if ev.click_count >= 2 && s.list.cursor() == Some(row) {
                                // (Shift: Recent Projects opens alongside)
                                let how = if ev.modifiers.shift { "pick" } else { "edit" };
                                let action = s.confirm(Some(row), how);
                                this.apply(action, window, cx);
                            } else {
                                s.list.set_cursor(Some(row));
                                s.preview_scroll = 0.;
                                this.prefetch_preview(cx);
                                cx.notify();
                            }
                        }),
                    )
                    .child(content)
                    .into_any_element(),
                )
            })
            .collect()
    }

    /// A group's title (All with files and symbols): WS's group separator, its name grayed in the
    /// small font over a line (none above the first group); takes no cursor or click.
    fn title_row(&self, row: usize, g: Group) -> AnyElement {
        div()
            .id(("search-row", row))
            .debug_selector(move || format!("search-title-{}", g.title()))
            .h(px(self.row_height()))
            .flex_none()
            .px(px(look::LIST_ROW_INSET_X))
            .flex()
            .flex_col()
            .justify_end()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .when(row > 0, |d| {
                d.child(div().h(px(1.)).flex_none().bg(look::SEPARATOR))
            })
            .child(
                rows::row_content()
                    .flex_1()
                    .text_size(px(MORE_FONT_SIZE))
                    .text_color(rows::dim_fg(false))
                    .child(g.title()),
            )
            .into_any_element()
    }

    /// "… more": a click lists the group's next chunk.
    fn more_row_element(
        &self,
        row: usize,
        g: Group,
        selected: bool,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        rows::row_tinted(
            ("search-row", row),
            px(self.row_height()),
            selected,
            false,
            None,
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                let Some(Popup::Search(s)) = &mut this.popup else {
                    return;
                };
                let h = s.field.read(cx).focus_handle(cx);
                window.focus(&h, cx);
                s.show_more(g);
                cx.notify();
            }),
        )
        .debug_selector(|| "search-row-more".into())
        .child(
            rows::row_content()
                .text_size(px(MORE_FONT_SIZE))
                .text_color(rows::dim_fg(selected))
                .child(MORE_TEXT),
        )
        .into_any_element()
    }

    /// "icon name dir": the name in its git status color, `" " + dir` grayed (WS appends the
    /// container text after a space).
    fn file_row(&self, hit: &Hit, selected: bool) -> AnyElement {
        let path = &self.cands[hit.ix];
        let (dir, name) = split_entry(path);
        if self.kind == Kind::Projects {
            let (color, open) = self
                .projects
                .get(hit.ix)
                .map_or((0, false), |p| (p.color, p.open));
            return project_row(name, path, color, open, &hit.name, selected);
        }
        let icon = if rank::is_dir(path) {
            IconName::Folder
        } else {
            kit::for_file(name)
        };
        let color = self.status(path).map(FileStatus::color);
        // the dir's matched chars move one right with the leading space
        let dir_matches: Vec<u32> = hit.dir.iter().map(|c| c + 1).collect();
        rows::row_content()
            .gap(px(ICON_GAP))
            .child(Icon::new(icon))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex_none()
                            .when_some(color, |d, c| d.text_color(c))
                            .child(rows::matched(name.to_string(), &hit.name)),
                    )
                    .when(!dir.is_empty(), |d| {
                        d.child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .text_color(rows::dim_fg(selected))
                                .child(rows::matched(format!(" {dir}"), &dir_matches)),
                        )
                    }),
            )
            .into_any_element()
    }

    fn symbol_row(
        &self,
        s: &SymbolItem,
        matches: &[u32],
        selected: bool,
        cx: &mut gpui_kit::App,
    ) -> AnyElement {
        let (_, file) = split_path(&s.rel);
        let dim = rows::dim_fg(selected);
        rows::row_content()
            .gap(px(ICON_GAP))
            .child(super::symbol_icons::icon(&s.kind, cx))
            .child(
                div()
                    .flex_none()
                    .whitespace_nowrap()
                    .child(rows::matched(s.name.clone(), matches)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(dim)
                    .when(!s.container.is_empty(), |d| {
                        d.child(SharedString::from(format!(" {}", s.container)))
                    }),
            )
            // the location: its text left of its icon
            .child(
                div()
                    .flex_none()
                    .max_w(px(260.))
                    .pl(px(8.))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(dim)
                    .child(SharedString::from(s.rel.clone())),
            )
            .child(div().pl(px(4.)).child(Icon::new(kit::for_file(file))))
            .into_any_element()
    }

    /// Alt+P / the toolbar's toggle: the selected file (or symbol's file) under the list.
    fn render_preview(
        &self,
        previews: &mut preview::Cache,
        cx: &mut Context<PickersView>,
    ) -> AnyElement {
        let rows = self.preview_rows;
        let target = self.list.cursor().and_then(|row| {
            if let Some(s) = self.symbol_at(row) {
                Some((PathBuf::from(&s.file), s.rel.clone(), s.line.max(1)))
            } else {
                let hit = self.hit_at(row)?;
                let shown = self.cands[hit.ix].to_string();
                Some((absolute(&self.project, &shown), shown, 1))
            }
        });
        let Some((path, shown, line)) = target else {
            return div()
                .h(px(rows as f32 * preview::LINE_HEIGHT
                    + preview::TITLE_HEIGHT
                    + 1.))
                .flex_none()
                .into_any_element();
        };
        let lines = previews.get(&path, cx);
        let colors = previews.peek_colors(&path);
        div()
            .id("se-preview")
            .debug_selector(|| "se-preview".into())
            .flex_none()
            .flex()
            .flex_col()
            .on_scroll_wheel(cx.listener(|this, ev: &gpui_kit::ScrollWheelEvent, _, cx| {
                if let Some(Popup::Search(s)) = &mut this.popup {
                    s.preview_scroll += preview::wheel_lines(ev);
                    cx.notify();
                }
            }))
            // the splitter's 1 px divider (Separator color)
            .child(div().h(px(1.)).bg(look::SEPARATOR))
            .child(preview::render(
                &shown,
                lines.as_ref().map(|l| l.as_slice()),
                colors.as_deref(),
                line,
                &preview::Marks::new(),
                rows,
                self.preview_scroll.round() as isize,
            ))
            .into_any_element()
    }
}

/// [`split_path`] for a candidate: a folder (trailing `/`) splits into its parent and its name.
fn split_entry(path: &str) -> (&str, &str) {
    split_path(path.strip_suffix('/').unwrap_or(path))
}

/// A Recent Projects row: WebStorm's project icon (initials on the palette gradient, like WS's
/// project widget), the name (bold while the project is open in the window), `~/path`
/// grayed.
fn project_row(
    name: &str,
    path: &str,
    color: usize,
    open: bool,
    matches: &[u32],
    selected: bool,
) -> AnyElement {
    let icon = crate::shell::toolbar::project_icon(name, color, look::PROJECT_ICON_SIZE_POPUP);
    rows::row_content()
        .gap(px(PROJECT_ICON_GAP))
        .child(icon)
        .child(
            div()
                .flex_none()
                .whitespace_nowrap()
                .when(open, |d| d.font_weight(FontWeight::BOLD))
                .child(rows::matched(name.to_string(), matches)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_color(rows::dim_fg(selected))
                .child(SharedString::from(path.to_string())),
        )
        .into_any_element()
}

/// Opens a project picked in Recent Projects ([`crate::shell::projects`]): an open one is
/// shown; else in place of this one (it closes like Close Project, asking when work would be
/// lost), or `alongside` it (Shift: both stay open).
pub fn open_project(
    dir: &Path,
    alongside: bool,
    scx: &SurfaceCx,
    window: &mut Window,
    cx: &mut gpui_kit::App,
) {
    if dir == scx.project {
        return;
    }
    if alongside {
        crate::shell::projects::switch_to(dir.to_path_buf(), window, cx);
    } else {
        crate::shell::projects::open_in_place(dir.to_path_buf(), None, window, cx);
    }
}
