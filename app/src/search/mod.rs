//! Pickers: Search Everywhere (All / Files / Symbols tabs; Go to File = its Files tab), Recent
//! Files (the switcher's recent mode), Open Files, Recent Projects, Find in Files, the usages popup
//! (Show Usages / Choose Declaration) and the Ctrl+Tab switcher, drawn natively. Replaces the
//! snacks picker windows of the terminal config, `config/usages.lua`'s menu popup and
//! `config/switcher.lua`'s float in the app; the Lua side is `nvim/lua/config/app/pickers.lua`.
//!
//! - Rust lists the project's files ([`index`], `ignore` crate, [`crate::search::scope`] rules), matches
//!   them ([`rank`], nucleo, off the UI thread) and runs ripgrep ([`grep`], streamed).
//! - Lua gives what only nvim knows: open / recent files with each open, LSP workspace symbols
//!   (`symbols(id, query)` -> `{event = "symbols", id, ..}`; older ids are dropped), usages /
//!   declarations (`{event = "usages", ..}`), the switcher's rows. Picks go back to Lua
//!   (`open_file`, `usage_pick`, `switcher_pick`), which opens them in the editor.
//! - Keys like today's snacks pickers: the query field always takes text; Up / Down, Ctrl+N / P,
//!   Ctrl+J / K move, Ctrl+D / U, PageUp / PageDown page, Enter opens, Ctrl+V / Ctrl+S open in a
//!   split, Alt+P toggles Search Everywhere's preview, Tab / Shift+Tab switch its tabs, Esc
//!   closes. The usages popup and the switcher are lists (the usages: arrows, typing searches;
//!   the switcher: l / ö / arrows, `/` searches); the switcher opens its selection when Ctrl is
//!   released.

mod everywhere;
mod find;
mod grep;
mod index;
mod json;
mod preview;
mod rank;
mod rows;
mod scope;
mod switcher;
mod symbol_icons;
mod usages;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyDownEvent, Keystroke, ModifiersChangedEvent, ParentElement as _, Render,
    Styled as _, Subscription, Task, Window, div,
};
use rmpv::Value;
use serde::Deserialize;

use crate::git::GitStatus;
use crate::kit;
use crate::nvim::lua;

use crate::shell::{Surface, SurfaceCx};
pub use everywhere::Kind;
pub(crate) use everywhere::WIDTH;
pub use grep::Batch;
pub use scope::{Exclusions, NEVER};
pub(crate) use scope::{LIBRARY_ROOT, walker};
pub use symbol_icons::icon;

/// Longest wait for nvim's typeahead answer before keys typed into a picker go to it anyway.
const AWAIT_MAX: Duration = Duration::from_secs(1);

/// `vimstorm.pickers` payloads (config/app/pickers.lua, config/usages.lua, config/switcher.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum PickerEvent {
    /// Lua's `require("config.app").focus("pickers")`.
    Focus,
    /// A picker shortcut: `kind` = all / files / symbols / grep / recent / buffers / projects.
    Open {
        kind: String,
        #[serde(default)]
        query: Option<String>,
        /// Open file buffers, most recent first (absolute paths).
        #[serde(default)]
        open: Vec<String>,
        /// Recent files of the project (absolute paths).
        #[serde(default)]
        recent: Vec<String>,
        /// Find in Folder: search only these dirs.
        #[serde(default)]
        dirs: Vec<String>,
        /// Find in Files: the current file's folder (the Directory scope).
        #[serde(default)]
        folder: Option<String>,
        /// The query history per picker kind (Lua keeps it on disk).
        #[serde(default)]
        history: Option<History>,
    },
    /// Shift Shift: Search Everywhere on its All tab (an open one switches to it, text kept).
    DoubleShift {
        #[serde(default)]
        open: Vec<String>,
        #[serde(default)]
        recent: Vec<String>,
        #[serde(default)]
        history: Option<History>,
    },
    /// Workspace symbols for request `id`.
    Symbols {
        id: u64,
        #[serde(default)]
        items: Vec<everywhere::SymbolItem>,
    },
    /// The usages / Choose Declaration popup at the caret.
    Usages {
        token: i64,
        title: String,
        #[serde(default)]
        right: String,
        items: Vec<usages::UsageItem>,
    },
    /// Ctrl+Tab.
    Switcher {
        token: i64,
        #[serde(default)]
        files: Vec<switcher::SwitchFile>,
        #[serde(default)]
        tools: Vec<switcher::SwitchTool>,
        #[serde(default)]
        back: bool,
        #[serde(default)]
        wait: bool,
        #[serde(default)]
        current_on_top: bool,
        /// Recent Files: the switcher's recent mode (speed search, "Show edited only").
        #[serde(default)]
        recent: bool,
        #[serde(default)]
        edited_only: bool,
    },
    /// Ctrl+Tab again before the switcher had the keyboard (it went through nvim).
    SwitcherStep {
        token: i64,
        #[serde(default)]
        back: bool,
    },
    /// nvim has read every key queued before the app asked (`switcher_sync`): a Ctrl release
    /// seen then opens the switcher's selection, after any Ctrl+Tab still in flight moved it.
    SwitcherSync { token: i64 },
    /// Keys typed after a picker shortcut before the picker had the keyboard (nvim notation).
    /// `token`: the answer to `focused(token)` (nvim read every key sent before it); none from
    /// Lua's fallback timer.
    Typeahead {
        keys: Vec<String>,
        #[serde(default)]
        token: Option<u64>,
    },
    /// Syntax colors of a previewed file (request `id`): (line, start byte, end byte, rgb, bold,
    /// italic).
    Highlights {
        id: u64,
        #[serde(default)]
        spans: Vec<(u32, usize, usize, u32, bool, bool)>,
    },
}

/// Confirmed queries per picker kind, oldest first.
type History = HashMap<String, Vec<String>>;

/// Queries kept per picker kind (snacks' history limit).
const HISTORY_MAX: usize = 100;

/// The open popup.
pub(crate) enum Popup {
    Search(everywhere::SearchPopup),
    Find(find::FindPopup),
    Usages(usages::UsagesPopup),
    Switcher(switcher::SwitcherPopup),
}

/// What tests (and screenshots) can see of the open popup.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PickerState {
    /// "all" / "files" / "symbols" / "recent" / "buffers" / "projects" / "grep" / "usages" /
    /// "switcher".
    pub kind: String,
    pub query: String,
    /// The rows' main labels (file names, code lines, symbol names), in order.
    pub rows: Vec<String>,
    /// The rows' secondary labels (dirs, "file.ts 12", container...).
    pub details: Vec<String>,
    pub cursor: Option<usize>,
    /// First results for the current query are in (files matched, ripgrep finished, symbols
    /// answered).
    pub settled: bool,
    /// The preview pane is shown.
    pub preview: bool,
    /// The popup title (the switcher: its selected column, "tools" / "files").
    pub title: String,
    /// The code lines the preview shows (empty: none / not read yet).
    pub preview_lines: Vec<String>,
    /// The header's grayed text on the right (usages: "4 usages in Project Files"; Find in Files:
    /// its scope and the filters on, "In Project regex"; else empty).
    pub right: String,
    /// Search Everywhere / the switcher: each row's git file status ("Modified", "Unversioned"...;
    /// "" unchanged), as its name color shows.
    pub statuses: Vec<String>,
    /// Find in Files: the match ranges marked in the preview's shown lines.
    pub preview_marks: usize,
    /// The header checkbox is checked (Search Everywhere: "Include non-project items"; Recent
    /// Files: "Show edited only").
    pub checked: bool,
    /// Search Everywhere: a "… more" row follows `rows` (results not listed yet).
    pub more: bool,
}

pub struct PickersView {
    scx: SurfaceCx,
    focus: FocusHandle,
    popup: Option<Popup>,
    /// The project's files (relative paths), once walked.
    index: Option<Arc<Vec<String>>>,
    index_task: Option<Task<()>>,
    /// The project scope's `.idea` excludes (Find in Files' rg globs), read again on every
    /// Find in Files open (None until the first read).
    scope: Option<Arc<Exclusions>>,
    scope_task: Option<Task<()>>,
    previews: preview::Cache,
    /// Where the keyboard was when the popup opened (the tree, the editor): Esc goes back there.
    return_focus: Option<FocusHandle>,
    /// Queries confirmed per picker kind, oldest first (snacks' Ctrl+Up / Ctrl+Down history).
    /// Lua keeps it on disk (`config/app/pickers.lua` `remember`) and sends it with every open.
    history: History,
    /// Find in Files' toggles / file mask, for the next one of the session.
    find_remembered: find::Remembered,
    /// Position in the history while stepping through it.
    hist_pos: Option<usize>,
    /// Last `focused(token)` sent to Lua.
    focus_token: u64,
    /// The `focused` token whose typeahead answer hasn't come yet: keys typed into the field
    /// meanwhile wait in `queued`, so they come after the keys nvim still holds.
    awaiting: Option<u64>,
    queued: Vec<Keystroke>,
    /// Releases `queued` if nvim never answers.
    await_task: Option<Task<()>>,
    /// The last switcher closed (its token) until another opens: see `PickerEvent::SwitcherStep`.
    closed_switcher: Option<i64>,
    _subs: Vec<Subscription>,
}

impl Surface for PickersView {
    const NAME: &'static str = "pickers";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        // the keyboard went elsewhere (a click in the tree / editor): close, like WebStorm's popups
        let subs = vec![cx.on_focus_out(&focus, window, |this, _, _window, cx| {
            if let Some(p) = this.popup.take() {
                this.dropped(&p, cx);
                cx.notify();
            }
        })];
        let mut view = PickersView {
            scx,
            focus,
            popup: None,
            index: None,
            index_task: None,
            scope: None,
            scope_task: None,
            previews: preview::Cache::default(),
            return_focus: None,
            history: HashMap::new(),
            find_remembered: find::Remembered::default(),
            hist_pos: None,
            focus_token: 0,
            awaiting: None,
            queued: Vec::new(),
            await_task: None,
            closed_switcher: None,
            _subs: subs,
        };
        // walk the project now, so the first Go to File finds the index ready (and the scope
        // for the first Find in Files)
        view.reindex(cx);
        view.rescope(cx);
        view
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<PickerEvent>(Self::NAME, payload) else {
            return;
        };
        // a hidden project's picker (Lua asked in the background, e.g. a usages answer after a
        // switch): never shown over the shown project
        if !self.scx.active()
            && matches!(
                ev,
                PickerEvent::Focus
                    | PickerEvent::Open { .. }
                    | PickerEvent::DoubleShift { .. }
                    | PickerEvent::Usages { .. }
                    | PickerEvent::Switcher { .. }
            )
        {
            return;
        }
        match ev {
            PickerEvent::Focus => self.take_focus(window, cx),
            PickerEvent::Open {
                kind,
                query,
                open,
                recent,
                dirs,
                folder,
                history,
            } => {
                if let Some(h) = history {
                    self.history = h;
                }
                let folder = folder.filter(|f| !f.is_empty()).map(PathBuf::from);
                self.open(&kind, query, open, recent, dirs, folder, window, cx)
            }
            PickerEvent::DoubleShift {
                open,
                recent,
                history,
            } => match &mut self.popup {
                Some(Popup::Search(s)) if s.kind.is_tab() => {
                    if s.kind != Kind::All {
                        s.set_kind(Kind::All, &self.scx, window, cx);
                    }
                    self.focused(window, cx);
                    cx.notify();
                }
                _ => {
                    if let Some(h) = history {
                        self.history = h;
                    }
                    self.open("all", None, open, recent, Vec::new(), None, window, cx)
                }
            },
            PickerEvent::Symbols { id, items } => {
                if let Some(Popup::Search(s)) = &mut self.popup {
                    s.symbols_answer(id, items, cx);
                    cx.notify();
                }
            }
            PickerEvent::Usages {
                token,
                title,
                right,
                items,
            } => {
                let caret = self.scx.geometry().caret;
                self.remember_focus(window, cx);
                self.replace_popup(
                    Popup::Usages(usages::UsagesPopup::new(
                        token,
                        self.scx.project.clone(),
                        title,
                        right,
                        items,
                        caret,
                    )),
                    cx,
                );
                self.take_focus(window, cx);
            }
            PickerEvent::Switcher {
                token,
                files,
                tools,
                back,
                wait,
                current_on_top,
                recent,
                edited_only,
            } => {
                if let Some(Popup::Switcher(s)) = &mut self.popup
                    && !recent
                    && !s.recent
                {
                    // Ctrl+Tab again while open (it went through nvim): the rows Lua has now
                    // (its token: the pick must match), then move
                    s.replace(token, files, tools);
                    s.step(if back { -1 } else { 1 });
                    cx.notify();
                    return;
                }
                self.closed_switcher = None;
                let sw = switcher::SwitcherPopup::new(
                    token,
                    files,
                    tools,
                    switcher::Mode {
                        back,
                        wait,
                        current_on_top,
                        recent,
                        edited_only,
                    },
                );
                self.remember_focus(window, cx);
                self.replace_popup(Popup::Switcher(sw), cx);
                self.take_focus(window, cx);
                // Ctrl already released (a quick Ctrl+Tab): open the selection once nvim has read
                // what was typed meanwhile (more Ctrl+Tabs move it first)
                if wait && !window.modifiers().control {
                    self.switcher_release();
                }
            }
            PickerEvent::SwitcherStep { token, back } => {
                if let Some(Popup::Switcher(s)) = &mut self.popup
                    && s.token() == token
                {
                    s.step(if back { -1 } else { 1 });
                    cx.notify();
                } else if self.closed_switcher == Some(token) {
                    // a Ctrl+Tab nvim read before our pick / close of that switcher: keys overtake
                    // queued notifications (nvim reads typeahead first), so Lua still had it open.
                    // Lua opens a new one after the pick it hasn't run yet (WS: the picked file on
                    // top), one per Ctrl+Tab (the next ones move it)
                    self.scx.call(
                        "config.app.pickers",
                        "switcher_reopen",
                        vec![Value::from(back)],
                    );
                }
            }
            PickerEvent::SwitcherSync { token } => {
                if let Some(Popup::Switcher(s)) = &self.popup
                    && s.token() == token
                    && s.release_pending
                {
                    self.switcher_confirm(window, cx);
                }
            }
            PickerEvent::Typeahead { keys, token } => self.typeahead(keys, token, window, cx),
            PickerEvent::Highlights { id, spans } => {
                self.previews.set_colors(id, spans);
                cx.notify();
            }
        }
    }
}

impl PickersView {
    /// A picker popup is open (Search Everywhere, Find in Files, usages, the switcher).
    pub fn is_open(&self) -> bool {
        self.popup.is_some()
    }

    /// The open popup's state (tests, screenshots); None when closed.
    pub fn state(&self, cx: &App) -> Option<PickerState> {
        let (mut st, shown) = match self.popup.as_ref()? {
            Popup::Search(s) => (s.state(cx), s.preview_target()),
            Popup::Find(f) => (f.state(cx), f.preview_target()),
            Popup::Usages(u) => (u.state(), None),
            Popup::Switcher(s) => (s.state(), None),
        };
        if let Some((path, line, rows, scroll)) = shown {
            if let (Some(Popup::Find(f)), Some(len)) = (&self.popup, self.previews.len(&path)) {
                st.preview_marks = f.preview_marks(preview::window(line, rows, len, scroll));
            }
            st.preview_lines = self
                .previews
                .shown(&path, line, rows, scroll)
                .unwrap_or_default();
        }
        Some(st)
    }

    /// The project's file index (None until the first walk is done).
    pub fn index(&self) -> Option<Arc<Vec<String>>> {
        self.index.clone()
    }

    /// Search Everywhere on its All tab with `query` typed.
    pub fn open_search(
        &mut self,
        query: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open(
            "all",
            query,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            window,
            cx,
        );
    }

    /// Walks the project off the UI thread (a cloud workspace's: one call to its box); an
    /// open picker re-matches once it's in. A box that did not answer keeps the last list.
    fn reindex(&mut self, cx: &mut Context<Self>) {
        let root = self.scx.project.clone();
        let walk = crate::shell::remote::background(&root, cx, {
            let root = root.clone();
            move || index::list(&root, false, false)
        });
        self.index_task = Some(cx.spawn(async move |this, cx| {
            let files = match walk.await.flatten() {
                Some(files) => Arc::new(files),
                None => {
                    // never listed: an open Go to File settles empty, the next open asks again
                    let _ = this.update(cx, |this, cx| {
                        if this.index.is_none()
                            && let Some(Popup::Search(s)) = &mut this.popup
                        {
                            s.index_changed(Arc::new(Vec::new()), cx);
                            cx.notify();
                        }
                    });
                    return;
                }
            };
            let _ = this.update(cx, |this, cx| {
                // unchanged (the usual re-walk on open): nothing to re-match
                if this.index.as_deref() == Some(&*files) {
                    return;
                }
                this.index = Some(files.clone());
                if let Some(Popup::Search(s)) = &mut this.popup {
                    s.index_changed(files, cx);
                }
                cx.notify();
            });
        }));
    }

    /// Reads the project scope off the UI thread; an open Find in Files searches again when it
    /// changed. On demand only (no polling: a hidden project costs nothing).
    fn rescope(&mut self, cx: &mut Context<Self>) {
        let root = self.scx.project.clone();
        self.scope_task = Some(cx.spawn(async move |this, cx| {
            let ex = cx
                .background_spawn(async move { Exclusions::read(&root) })
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.scope.as_deref() != Some(&ex) {
                    this.scope = Some(Arc::new(ex));
                }
                if let (Some(Popup::Find(f)), Some(ex)) = (&mut this.popup, &this.scope) {
                    f.set_scope(ex, cx);
                    cx.notify();
                }
            });
        }));
    }

    /// The Project tree's git status (file name colors), as last read by the tree.
    fn git_status(&self, cx: &App) -> Option<Arc<GitStatus>> {
        let ws = self.scx.workspace.upgrade()?;
        let tree = ws.read(cx).tree().clone();
        Some(Arc::new(tree.read(cx).git().clone()))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the bridge `open` event's fields, passed straight through"
    )]
    fn open(
        &mut self,
        kind: &str,
        query: Option<String>,
        open: Vec<String>,
        recent: Vec<String>,
        dirs: Vec<String>,
        folder: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let project = self.scx.project.clone();
        // the shortcut again while its picker is open closes it (today's snacks toggle)
        let same = match &self.popup {
            Some(Popup::Find(f)) => kind == "grep" && dirs.is_empty() && !f.in_folder(),
            Some(Popup::Search(s)) => Kind::parse(kind) == Some(s.kind) && kind != "all",
            _ => false,
        };
        if same && query.is_none() {
            self.focused(window, cx);
            self.close(window, cx);
            return;
        }
        self.remember_focus(window, cx);
        self.hist_pos = None;
        if kind == "grep" {
            let dirs = dirs.into_iter().map(PathBuf::from).collect();
            // an open Find in Files leaves its toggles first
            if let Some(Popup::Find(f)) = &self.popup {
                self.find_remembered = f.remembered(cx);
            }
            let f = find::FindPopup::new(
                project,
                query,
                dirs,
                folder,
                &self.find_remembered,
                self.scope.as_deref(),
                window,
                cx,
            );
            self.replace_popup(Popup::Find(f), cx);
            // the `.idea` excludes may have changed since: read again behind the open popup
            self.rescope(cx);
        } else {
            let Some(kind) = Kind::parse(kind) else {
                lua::log_once(Self::NAME, &Value::Nil, "unknown picker kind");
                // Lua holds the keys typed after the shortcut: end that
                self.focused(window, cx);
                return;
            };
            // another Search Everywhere tab: same popup, text kept
            if let Some(Popup::Search(s)) = &mut self.popup
                && s.kind.is_tab()
                && kind.is_tab()
            {
                s.set_sources(open, recent);
                s.set_kind(kind, &self.scx, window, cx);
                if let Some(q) = query {
                    s.set_query(&q, &self.scx, window, cx);
                }
                self.focused(window, cx);
                cx.notify();
                return;
            }
            let git = self.git_status(cx);
            let s = everywhere::SearchPopup::new(
                kind,
                project,
                query,
                open,
                recent,
                self.index.clone(),
                git,
                &self.scx,
                window,
                cx,
            );
            self.replace_popup(Popup::Search(s), cx);
            // files may have changed since the last walk: refresh behind the open popup
            if kind.uses_index() {
                self.reindex(cx);
            }
        }
        self.take_focus(window, cx);
    }

    /// Gives the keyboard to the open popup (its field, or the list) and tells Lua.
    fn take_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.popup {
            Some(Popup::Search(s)) => {
                let h = s.field.read(cx).focus_handle(cx);
                window.focus(&h, cx)
            }
            Some(Popup::Find(f)) => {
                let h = f.field.read(cx).focus_handle(cx);
                window.focus(&h, cx)
            }
            Some(_) => window.focus(&self.focus, cx),
            None => return,
        }
        self.focused(window, cx);
        cx.notify();
    }

    /// Lua stops holding typeahead once the picker has the keyboard. Until it answers, keys typed
    /// into the field wait ([`Self::on_capture_key`]): nvim may still hold earlier ones.
    fn focused(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_token += 1;
        let token = self.focus_token;
        self.awaiting = Some(token);
        // keys held before (a refocused popup: Shift Shift on another tab) go where the caret is
        match &mut self.popup {
            Some(Popup::Search(s)) if s.typeahead_at.is_none() => {
                s.typeahead_at = Some(s.field.read(cx).text().len())
            }
            Some(Popup::Find(f)) if f.typeahead_at.is_none() => {
                f.typeahead_at = Some(f.field.read(cx).text().len())
            }
            _ => {}
        }
        self.scx
            .call("config.app.pickers", "focused", vec![Value::from(token)]);
        // nvim busy or gone: don't keep the keyboard waiting
        self.await_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(AWAIT_MAX).await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.awaiting == Some(token) {
                    this.release_keys(window, cx);
                }
            });
        }));
    }

    /// nvim answered (or took too long): the keys typed into the field meanwhile go to it now.
    fn release_keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.awaiting = None;
        self.await_task = None;
        let keys = std::mem::take(&mut self.queued);
        if !keys.is_empty() {
            // dispatched again as typed (field, list keys), after this update
            window.defer(cx, move |window, cx| {
                for k in keys {
                    window.dispatch_keystroke(k, cx);
                }
            });
        }
    }

    /// Closes the popup; the keyboard goes back where it was before (the tree, the editor) when
    /// the popup had it.
    pub(crate) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_to(false, window, cx);
    }

    /// [`Self::close`]; `editor`: the keyboard goes to the editor (a file opens there).
    fn close_to(&mut self, editor: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.popup.take() else {
            return;
        };
        self.dropped(&p, cx);
        if self.focus.contains_focused(window, cx) {
            match self.return_focus.take().filter(|_| !editor) {
                Some(h) => window.focus(&h, cx),
                None => self.scx.focus_editor(window, cx),
            }
        }
        self.return_focus = None;
        cx.notify();
    }

    /// A popup is gone: Lua forgets the switcher it opened; Find in Files leaves its toggles for
    /// the next one; a cloud workspace's previews are read again by it.
    fn dropped(&mut self, popup: &Popup, cx: &App) {
        self.previews.forget_remote();
        match popup {
            Popup::Switcher(s) => {
                self.closed_switcher = Some(s.token());
                self.scx.call(
                    "config.app.pickers",
                    "switcher_done",
                    vec![Value::from(s.token())],
                )
            }
            Popup::Find(f) => self.find_remembered = f.remembered(cx),
            _ => {}
        }
    }

    /// A new popup replaces the open one.
    fn replace_popup(&mut self, popup: Popup, cx: &App) {
        if let Some(old) = self.popup.replace(popup) {
            self.dropped(&old, cx);
        }
    }

    /// Keeps where the keyboard is before a popup takes it (not when a popup already has it).
    fn remember_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.contains_focused(window, cx) {
            self.return_focus = window.focused(cx);
        }
    }

    /// Keys typed before the picker had the keyboard: they go before anything typed into it
    /// since (they were typed first).
    fn typeahead(
        &mut self,
        keys: Vec<String>,
        token: Option<u64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.insert_typeahead(keys, window, cx);
        if token.is_some() && token == self.awaiting {
            self.release_keys(window, cx);
        }
    }

    fn insert_typeahead(&mut self, keys: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        if keys.is_empty() {
            return;
        }
        let (field, at) = match &mut self.popup {
            Some(Popup::Search(s)) => (s.field.clone(), s.typeahead_at.take()),
            Some(Popup::Find(f)) => (f.field.clone(), f.typeahead_at.take()),
            _ => return,
        };
        let Some(at) = at else { return };
        let mut text = String::new();
        let mut after = Vec::new();
        // each entry is what nvim read at once ("ist" for a burst): split it into keys
        for k in keys.iter().flat_map(|k| split_keys(k)) {
            match k.as_str() {
                "<BS>" => {
                    text.pop();
                }
                "<Space>" => text.push(' '),
                "<lt>" => text.push('<'),
                "<CR>" | "<Esc>" | "<Tab>" | "<S-Tab>" | "<Down>" | "<Up>" => after.push(k),
                _ if k.chars().count() == 1 => text.push_str(&k),
                _ => {}
            }
        }
        if !text.is_empty() {
            field.update(cx, |f, cx| {
                let mut all = f.text().to_string();
                let at = at.min(all.len());
                all.insert_str(at, &text);
                f.set_text(all, cx);
            });
            self.query_changed(window, cx);
        }
        for k in after {
            self.key(&k, window, cx);
        }
    }

    /// The field's text changed.
    fn query_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &mut self.popup {
            Some(Popup::Search(s)) => s.requery(&self.scx, window, cx),
            Some(Popup::Find(f)) => f.requery(cx),
            _ => {}
        }
        cx.notify();
    }

    // Keys ---------------------------------------------------------------------------------------

    /// Before the field sees a key: Cmd+C with nothing selected copies the whole query (like
    /// today's `editing.in_field()`).
    fn on_capture_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // nvim may still hold keys typed before these: keep them until it answers
        if self.awaiting.is_some() && matches!(self.popup, Some(Popup::Search(_) | Popup::Find(_)))
        {
            self.queued.push(ev.keystroke.clone());
            cx.stop_propagation();
            return;
        }
        // Alt+letter: snacks' toggles (Alt+H hidden, Alt+P preview...), not the Option char the
        // field would type
        let k = &ev.keystroke;
        if k.modifiers.alt
            && !k.modifiers.platform
            && !k.modifiers.control
            && k.key.chars().count() == 1
            && k.key.chars().all(|c| c.is_ascii_alphabetic())
        {
            let key = format!("<M-{}>", k.key.to_ascii_lowercase());
            if self.key(&key, window, cx) {
                cx.stop_propagation();
                return;
            }
        }
        let field = match &self.popup {
            Some(Popup::Search(s)) => &s.field,
            Some(Popup::Find(f)) => &f.field,
            _ => return,
        };
        if kit::notation(ev).as_deref() == Some("<D-c>") {
            let f = field.read(cx);
            if f.selection().is_empty() && !f.text().is_empty() {
                let text = f.text().to_string();
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                cx.stop_propagation();
            }
        }
    }

    /// Keys the field didn't use (they bubble here), or every key of the list popups.
    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        let typed = kit::typed_text(ev);
        if self.key_typed(&key, typed.as_deref(), window, cx) {
            cx.stop_propagation();
        }
    }

    fn key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.key_typed(key, None, window, cx)
    }

    /// One key (nvim notation); true when a popup used it.
    fn key_typed(
        &mut self,
        key: &str,
        typed: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if matches!(key, "<C-Up>" | "<C-Down>") && self.history_step(key == "<C-Up>", window, cx) {
            return true;
        }
        let action = match &mut self.popup {
            None => return false,
            Some(Popup::Search(s)) => s.key(key, self.index.clone(), &self.scx, window, cx),
            Some(Popup::Find(f)) => f.key(key, cx),
            Some(Popup::Usages(u)) => u.key(key, typed),
            Some(Popup::Switcher(s)) => s.key(key, typed),
        };
        let used = self.apply(action, window, cx);
        self.prefetch_preview(cx);
        used
    }

    /// Starts reading the selected result's file for the preview (rendering would too, but the
    /// window may not be drawing: screenshots).
    pub(crate) fn prefetch_preview(&mut self, cx: &mut Context<Self>) {
        let path = match &self.popup {
            Some(Popup::Find(f)) => f.selected_path(),
            Some(Popup::Search(s)) => s.selected_path(),
            _ => None,
        };
        if let Some(p) = path {
            self.previews.get(&p, cx);
            let scx = &self.scx;
            self.previews.colors(&p, |id, path| {
                let path = path.to_string_lossy().into_owned();
                scx.call(
                    "config.app.pickers",
                    "highlights",
                    vec![Value::from(id), Value::from(path)],
                );
            });
        }
    }

    /// Carries out what a popup asked for; false for [`Action::Ignored`].
    pub(crate) fn apply(
        &mut self,
        action: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        match action {
            Action::Ignored => return false,
            Action::Handled => {}
            Action::Close => self.close(window, cx),
            Action::Open { targets, how } => {
                self.remember_query(cx);
                self.close_to(true, window, cx);
                let args = match targets.as_slice() {
                    [t] => vec![
                        Value::from(t.path.to_string_lossy().into_owned()),
                        t.line.map_or(Value::Nil, Value::from),
                        t.col.map_or(Value::Nil, Value::from),
                        Value::from(how),
                        t.enc.clone().map_or(Value::Nil, Value::from),
                    ],
                    _ => vec![
                        Value::Array(targets.iter().map(Target::to_value).collect()),
                        Value::from(how),
                    ],
                };
                let func = if targets.len() == 1 {
                    "open_file"
                } else {
                    "open_files"
                };
                self.scx.navigate("config.app.pickers", func, args);
            }
            Action::Quickfix { title, targets } => {
                self.remember_query(cx);
                self.close_to(true, window, cx);
                let items = Value::Array(targets.iter().map(Target::to_value).collect());
                self.scx
                    .navigate("config.app.pickers", "qflist", vec![title.into(), items]);
            }
            // a pick (the switcher's, a usage's): in Normal mode, as an Open's
            Action::Lua { func, args } => {
                self.close_to(true, window, cx);
                self.scx.navigate("config.app.pickers", func, args);
            }
            Action::Call { func, args } => self.scx.call("config.app.pickers", func, args),
            Action::Project { dir, alongside } => {
                self.remember_query(cx);
                self.close_to(true, window, cx);
                everywhere::open_project(&dir, alongside, &self.scx, window, cx);
            }
            Action::Reveal(dir) => {
                self.remember_query(cx);
                self.close_to(true, window, cx);
                let ws = self.scx.workspace.clone();
                let payload = Value::Map(vec![
                    ("event".into(), "reveal".into()),
                    ("file".into(), dir.to_string_lossy().into_owned().into()),
                    ("focus".into(), true.into()),
                ]);
                // after this update (a typeahead Enter arrives while the workspace is being updated)
                window.defer(cx, move |window, cx| {
                    let Some(ws) = ws.upgrade() else { return };
                    let tree = ws.read(cx).tree().clone();
                    tree.update(cx, |t, cx| t.on_lua(payload, window, cx));
                });
            }
            Action::Column(mode) => {
                self.close_to(true, window, cx);
                let ws = self.scx.workspace.clone();
                window.defer(cx, move |window, cx| {
                    let Some(ws) = ws.upgrade() else { return };
                    let column = ws.read(cx).column().clone();
                    column.update(cx, |c, cx| c.show(mode, true, window, cx));
                });
            }
        }
        cx.notify();
        true
    }

    /// Ctrl released while the switcher waits for it: open its selection (after nvim read what
    /// was typed before: [`Self::switcher_release`]); Ctrl down again keeps it open.
    fn on_modifiers(
        &mut self,
        ev: &ModifiersChangedEvent,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        if let Some(Popup::Switcher(s)) = &mut self.popup
            && s.wait
        {
            if ev.modifiers.control {
                s.release_pending = false;
            } else if !s.release_pending {
                self.switcher_release();
            }
        }
    }

    /// Ctrl is up: ask nvim to answer once it has read the keys already sent to it (a Ctrl+Tab
    /// typed before the switcher had the keyboard moves it first), then open the selection.
    fn switcher_release(&mut self) {
        if let Some(Popup::Switcher(s)) = &mut self.popup {
            s.release_pending = true;
            let token = s.token();
            self.scx.call(
                "config.app.pickers",
                "switcher_sync",
                vec![Value::from(token)],
            );
        }
    }

    fn switcher_confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Popup::Switcher(s)) = &self.popup {
            let action = s.confirm();
            self.apply(action, window, cx);
        }
    }

    /// Remembers the open picker's query for Ctrl+Up / Ctrl+Down (a pick confirmed it).
    fn remember_query(&mut self, cx: &App) {
        let (kind, q) = match &self.popup {
            Some(Popup::Search(s)) => (
                s.kind.name().to_string(),
                s.field.read(cx).text().to_string(),
            ),
            Some(Popup::Find(f)) => ("grep".to_string(), f.field.read(cx).text().to_string()),
            _ => return,
        };
        if q.is_empty() {
            return;
        }
        let h = self.history.entry(kind.clone()).or_default();
        h.retain(|x| *x != q);
        h.push(q.clone());
        if h.len() > HISTORY_MAX {
            h.remove(0);
        }
        // Lua writes it to disk (the next open, any project's, reads it back)
        self.scx.call(
            "config.app.pickers",
            "remember",
            vec![Value::from(kind), Value::from(q)],
        );
    }

    /// Ctrl+Up (older) / Ctrl+Down (newer): the picker's earlier queries.
    fn history_step(&mut self, older: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let (kind, field) = match &self.popup {
            Some(Popup::Search(s)) => (s.kind.name(), s.field.clone()),
            Some(Popup::Find(f)) => ("grep", f.field.clone()),
            _ => return false,
        };
        let Some(h) = self.history.get(kind).filter(|h| !h.is_empty()) else {
            return true;
        };
        let pos = match (self.hist_pos, older) {
            (None, true) => h.len() - 1,
            (None, false) => return true,
            (Some(p), true) => p.saturating_sub(1),
            (Some(p), false) if p + 1 < h.len() => p + 1,
            (Some(_), false) => {
                self.hist_pos = None;
                field.update(cx, |f, cx| f.set_text("", cx));
                self.query_changed(window, cx);
                return true;
            }
        };
        self.hist_pos = Some(pos);
        let q = h[pos].clone();
        field.update(cx, |f, cx| f.set_text(q, cx));
        self.query_changed(window, cx);
        true
    }
}

/// Keys in nvim notation ("ab<CR>c") one by one: `<...>` names and single chars.
pub(crate) fn split_keys(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if c == '<'
            && let Some(end) = rest.find('>')
            && end > 1
            && !rest[1..end].contains('<')
        {
            out.push(rest[..=end].to_string());
            rest = &rest[end + 1..];
            continue;
        }
        out.push(c.to_string());
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// A file to open (1-based line / col; `enc`: the col counts this LSP encoding's units, not
/// bytes).
#[derive(Clone, Debug, Default)]
pub(crate) struct Target {
    pub path: PathBuf,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub enc: Option<String>,
    /// The quickfix text (the match's line).
    pub text: String,
}

impl Target {
    pub fn file(path: PathBuf) -> Self {
        Self {
            path,
            ..Default::default()
        }
    }

    fn to_value(&self) -> Value {
        let mut m = vec![(
            Value::from("path"),
            Value::from(self.path.to_string_lossy().into_owned()),
        )];
        if let Some(l) = self.line {
            m.push(("line".into(), l.into()));
        }
        if let Some(c) = self.col {
            m.push(("col".into(), c.into()));
        }
        if let Some(e) = &self.enc {
            m.push(("enc".into(), e.clone().into()));
        }
        m.push(("text".into(), self.text.clone().into()));
        Value::Map(m)
    }
}

/// What a key / click in a popup asks the view to do.
pub(crate) enum Action {
    /// Not a key of this popup.
    Ignored,
    /// Used (state changed): re-render.
    Handled,
    Close,
    /// Close, then open the files in the editor (`how`: edit / vsplit / split / pick: the
    /// window picker, Shift+Enter).
    Open {
        targets: Vec<Target>,
        how: &'static str,
    },
    /// Close, then put them in the quickfix list (snacks' Ctrl+Q).
    Quickfix {
        title: String,
        targets: Vec<Target>,
    },
    /// Close, then `require("config.app.pickers").<func>(args...)`: a pick, run in Normal mode
    /// ([`crate::nvim::lua::navigate`]).
    Lua {
        func: &'static str,
        args: Vec<Value>,
    },
    /// `require("config.app.pickers").<func>(args...)`, the popup stays.
    Call {
        func: &'static str,
        args: Vec<Value>,
    },
    /// Close, then open this project: in place of this one, or alongside it.
    Project {
        dir: PathBuf,
        alongside: bool,
    },
    /// Close, then show this folder selected in the Project tree, which takes the keyboard (the
    /// tree's own Select In).
    Reveal(PathBuf),
    /// Close, then show the Chat column in this mode with the keyboard (the switcher's Chat:
    /// never hides it).
    Column(crate::shell::ColumnMode),
}

impl Focusable for PickersView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for PickersView {
    /// Overlay: the open popup over everything, placed in window coordinates.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let root = div()
            .id("pickers")
            .key_context("VimStormPickers")
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::on_capture_key))
            .on_key_down(cx.listener(Self::on_key_down))
            .on_modifiers_changed(cx.listener(Self::on_modifiers))
            // no size: a focus-tracking element takes the keyboard on a click inside it, and
            // clicks outside the popup must reach what's under them (popups are absolute,
            // in window coordinates from here)
            .absolute()
            .top_0()
            .left_0();
        let viewport = window.viewport_size();
        let popup = match &mut self.popup {
            None => return root,
            Some(Popup::Search(s)) => s.render(viewport, &mut self.previews, window, cx),
            Some(Popup::Find(f)) => f.render(viewport, &mut self.previews, window, cx),
            Some(Popup::Usages(u)) => u.render(viewport, window, cx),
            Some(Popup::Switcher(s)) => s.render(viewport, window, cx),
        };
        root.child(popup)
    }
}

#[cfg(test)]
mod tests {
    use super::split_keys;

    #[test]
    fn typeahead_chunks_split_into_keys() {
        assert_eq!(split_keys("ist"), ["i", "s", "t"]);
        assert_eq!(split_keys("a<CR>b<lt>"), ["a", "<CR>", "b", "<lt>"]);
        assert_eq!(split_keys("<"), ["<"]);
        assert_eq!(split_keys("åä"), ["å", "ä"]);
    }
}
