//! Main toolbar (WebStorm New UI, compact density): room for the traffic lights and the window
//! title ("project – file", nvim's `titlestring` from `config/statusline.lua`) centered in the
//! window. No project widget (the user removed it: the project is in the title; Recent Projects
//! Cmd+Shift+O, the app menu and the editor menu's items open projects), no branch widget (the
//! branch is in the status bar), no Run / Debug widgets; at the right end the Search Everywhere
//! magnifier. The menu items' popups open under the toolbar in the window's middle: Recent
//! Projects… (open projects first in bold; Enter opens in place of this project, Shift+Enter
//! alongside ([`crate::shell::projects`]); Close Project ⌘Q below the list), Branches… / New
//! Branch… (new branch; a branch's submenu: Checkout, New Branch from…, Compare with Current
//! (the Git Log on `current..branch`), Rename…, Delete… (asked first in the flow dialog)). The
//! empty area moves the window (the workspace's).
//!
//! Bridge (`config/app/toolbar.lua`): Lua sends `open` (menu items: "branches" / "new_branch" /
//! "projects"), `open_project` (alongside), `close_project` and `cycle_project {by}` (Close
//! Project, Down / Up the Rail); Rust calls `git_done(ok, message)` after a checkout /
//! new branch (balloon, buffers reload, git views).

mod branch_popup;
mod context;
mod new_branch;
mod project_popup;
mod switch;
mod widgets;

use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TextAlign, Window, canvas, deferred, div, prelude::FluentBuilder as _, px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::git::{self, Target};
use crate::kit::ListView;
use crate::kit::{self, Anchor};
use crate::look;
use crate::nvim::lua;
use crate::popups::Balloon;
use crate::shell::recent;
use crate::shell::{Surface, SurfaceCx};
use branch_popup::{BranchAction, BranchList};
use new_branch::{FormMode, NewBranchForm};
use project_popup::ProjectList;
use widgets::BoundsCell;

pub use branch_popup::{BranchAction as BranchMenuAction, BranchRow, actions as branch_actions};
pub(crate) use switch::{CLOSE_QUIT_TIMEOUT, Losses, Quitting};
pub use switch::{Launcher, OpenNvims, close_dialog, quitting};
pub(crate) use widgets::project_icon;

/// `vimstorm.toolbar` payloads (config/app/toolbar.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ToolbarEvent {
    /// `require("config.app").focus("toolbar")`: the branch popup.
    Focus,
    /// A menu item: "branches", "new_branch" or "projects".
    Open { what: String },
    /// Open a project alongside this one (shown if it's open).
    OpenProject { path: String },
    /// Close Project (the shown one; asks when work would be lost).
    CloseProject,
    /// Next (`by` 1) / Previous (-1) Project Window.
    CycleProject { by: isize },
    /// `:` in the editor, or ⌘⇧A / ⌘⇧P (config/app/colon.lua): Abe's Command mode; `key`: the
    /// `:` key itself.
    Colon {
        #[serde(default)]
        key: bool,
        /// Where the Editor's keys are: handed to the bridge before the `:`; decoded on
        /// its own, so a bad one loses only the Subject, never the `:`.
        #[serde(default)]
        here: Option<serde_json::Value>,
    },
    /// The keys typed after `:` before Command mode had the keyboard
    /// (config/app/typeahead.lua's answer for the surface "toolbar").
    Typeahead {
        #[serde(default)]
        keys: Vec<String>,
    },
}

/// Which popup is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PopupKind {
    Projects,
    Branches,
    NewBranch,
}

enum Popup {
    Projects(Entity<ListView<ProjectList>>),
    Branches(Entity<ListView<BranchList>>),
    NewBranch(Entity<NewBranchForm>),
}

impl Popup {
    fn kind(&self) -> PopupKind {
        match self {
            Popup::Projects(_) => PopupKind::Projects,
            Popup::Branches(_) => PopupKind::Branches,
            Popup::NewBranch(_) => PopupKind::NewBranch,
        }
    }

    fn focus_handle(&self, cx: &App) -> FocusHandle {
        match self {
            Popup::Projects(l) => l.focus_handle(cx),
            Popup::Branches(l) => l.focus_handle(cx),
            Popup::NewBranch(f) => f.focus_handle(cx),
        }
    }
}

/// The git balloon's id ("Checking out…", then the result).
const GIT_BALLOON: &str = "toolbar-git";
/// Git work shorter than this shows no "Checking out…".
const BUSY_AFTER: std::time::Duration = std::time::Duration::from_millis(500);

/// Popup widths.
const BRANCHES_WIDTH: f32 = 360.;
const PROJECTS_WIDTH: f32 = 420.;
/// At most this many rows show before the list scrolls.
const MAX_ROWS: f32 = 20.;

pub struct ToolbarView {
    scx: SurfaceCx,
    focus: FocusHandle,
    project_name: SharedString,
    project_color: usize,
    popup: Option<Popup>,
    /// Where the popups open (under the toolbar, centered; set when drawn).
    popup_bounds: BoundsCell,
    /// The widgets' row (the title keeps clear of it).
    widgets_bounds: BoundsCell,
    /// The title as drawn last (tests).
    title: SharedString,
    /// The context line in the title's place, as drawn last.
    line: crate::factory::ContextLine,
    /// A popup whose data is being read (another click doesn't start a second read).
    loading: Option<PopupKind>,
    /// Shows "Checking out…" when a git command takes a while.
    busy: Option<Task<()>>,
    /// A branch's submenu is open over the Branches… popup: the popup stays while it has the
    /// keyboard and its clicks.
    submenu: bool,
    _subs: Vec<Subscription>,
}

impl Surface for ToolbarView {
    const NAME: &'static str = "toolbar";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let project_name: SharedString = scx
            .project
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| scx.project.display().to_string())
            .into();
        let focus = cx.focus_handle();
        // a click elsewhere took the keyboard: the popup goes
        let subs = vec![
            cx.on_focus_out(&focus, window, |t, _, _, cx| {
                if !t.submenu && t.popup.take().is_some() {
                    cx.notify();
                }
            }),
            // the Factory view's Chat button
            cx.observe_global::<crate::factory::FactoryShell>(|_, cx| cx.notify()),
            // the context line
            cx.observe_global::<crate::factory::WorkspaceFeed>(|_, cx| cx.notify()),
            cx.observe_global::<crate::factory::ShownWorkspaces>(|_, cx| cx.notify()),
        ];
        // WebStorm's color for the project if it knows it, else a hash of the path
        let home = recent::home();
        let project = scx.project.clone();
        let colors = cx
            .background_executor()
            .spawn(async move { recent::webstorm_colors(&home) });
        cx.spawn(async move |this, cx| {
            let colors = colors.await;
            let _ = this.update(cx, |t, cx| {
                if let Some(&c) = colors.get(&project) {
                    t.project_color = c;
                    cx.notify();
                }
            });
        })
        .detach();
        ToolbarView {
            project_color: recent::color_index(&scx.project),
            scx,
            focus,
            project_name,
            popup: None,
            popup_bounds: Rc::default(),
            widgets_bounds: Rc::default(),
            title: SharedString::default(),
            line: crate::factory::ContextLine::Title,
            loading: None,
            busy: None,
            submenu: false,
            _subs: subs,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ev) = lua::decode::<ToolbarEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            ToolbarEvent::Focus => self.open_branches(window, cx),
            ToolbarEvent::Open { what } => match what.as_str() {
                "branches" => self.open_branches(window, cx),
                "new_branch" => self.open_new_branch(window, cx),
                "projects" => self.open_projects(window, cx),
                _ => lua::log_once(Self::NAME, &Value::from(what), "unknown popup"),
            },
            ToolbarEvent::OpenProject { path } => {
                self.open_project(PathBuf::from(path), true, window, cx)
            }
            ToolbarEvent::CloseProject => self.close_project(window, cx),
            ToolbarEvent::CycleProject { by } => crate::shell::projects::cycle(by, window, cx),
            // Command mode, else the line saying why; a bare workspace (no projects window)
            // has neither: Neovim's command line
            ToolbarEvent::Colon { key, here } => {
                let here = here.and_then(|h| {
                    serde_json::from_value::<crate::factory::EditorHere>(h)
                        .map_err(|e| {
                            crate::factory::log_once(
                                "editor-here",
                                &format!("the Editor's `:` here does not read: {e}"),
                            )
                        })
                        .ok()
                });
                let from = if key {
                    crate::shell::projects::ColonFrom::EditorKey
                } else {
                    crate::shell::projects::ColonFrom::EditorAction
                };
                if !crate::shell::projects::colon_at(from, here, cx) {
                    self.scx.call("config.app.colon", "cmdline", vec![]);
                }
            }
            ToolbarEvent::Typeahead { keys } => {
                if !keys.is_empty() {
                    crate::shell::projects::command_typeahead(keys, cx);
                }
            }
        }
    }
}

impl ToolbarView {
    pub fn popup_kind(&self) -> Option<PopupKind> {
        self.popup.as_ref().map(Popup::kind)
    }

    /// The branch popup's rows (tests).
    pub fn branch_rows(&self, cx: &App) -> Vec<BranchRow> {
        match &self.popup {
            Some(Popup::Branches(l)) => l.read(cx).delegate.rows.clone(),
            _ => Vec::new(),
        }
    }

    /// The branch popup's selected row (tests).
    pub fn branch_cursor(&self, cx: &App) -> Option<BranchRow> {
        match &self.popup {
            Some(Popup::Branches(l)) => {
                let l = l.read(cx);
                l.state.cursor().map(|ix| l.delegate.rows[ix].clone())
            }
            _ => None,
        }
    }

    /// The branch popup's rows shown now (a search filters them; tests).
    pub fn branch_rows_shown(&self, cx: &App) -> Vec<BranchRow> {
        match &self.popup {
            Some(Popup::Branches(l)) => {
                let l = l.read(cx);
                (0..l.state.row_count())
                    .filter_map(|r| l.state.item_at(r))
                    .map(|ix| l.delegate.rows[ix].clone())
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    /// The project popup's projects (tests).
    pub fn project_rows(&self, cx: &App) -> Vec<recent::RecentProject> {
        match &self.popup {
            Some(Popup::Projects(l)) => l.read(cx).delegate.items.clone(),
            _ => Vec::new(),
        }
    }

    /// The project popup's rows shown now (a search filters them; tests).
    pub fn project_rows_shown(&self, cx: &App) -> Vec<recent::RecentProject> {
        match &self.popup {
            Some(Popup::Projects(l)) => {
                let l = l.read(cx);
                (0..l.state.row_count())
                    .filter_map(|r| l.state.item_at(r))
                    .map(|ix| l.delegate.items[ix].clone())
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    /// The new-branch form's error line (tests).
    pub fn new_branch_error(&self, cx: &App) -> Option<String> {
        match &self.popup {
            Some(Popup::NewBranch(f)) => f.read(cx).error.clone(),
            _ => None,
        }
    }

    /// The window title as last drawn.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// The context line drawn in the title's place; `Title` while no bridge spoke.
    pub fn context_line(&self) -> &crate::factory::ContextLine {
        &self.line
    }

    fn show(&mut self, popup: Popup, window: &mut Window, cx: &mut Context<Self>) {
        let focus = popup.focus_handle(cx);
        self.popup = Some(popup);
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Closes the popup and gives the keyboard back to nvim.
    pub fn close_popup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.popup.take().is_some() {
            self.scx.focus_editor(window, cx);
            cx.notify();
        }
    }

    /// The branch popup, once the branches are read.
    pub fn open_branches(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading.replace(PopupKind::Branches).is_some() {
            return;
        }
        let dir = self.scx.project.clone();
        let task = cx.background_executor().spawn(async move {
            let head = git::head_blocking(&dir);
            (git::load_branches_blocking(&dir), head)
        });
        let toolbar = cx.entity().downgrade();
        cx.spawn_in(window, async move |this, cx| {
            let (loaded, head) = task.await;
            let _ = this.update_in(cx, |t, window, cx| {
                t.loading = None;
                let b = loaded.unwrap_or_else(|e| {
                    eprintln!("[vimstorm] branches: {e:#}");
                    Default::default()
                });
                let rows = branch_popup::rows(&b, &head);
                let list = cx.new(|cx| {
                    let mut l = ListView::new(
                        BranchList {
                            rows,
                            local: b.local.clone(),
                            head: head.clone(),
                            toolbar,
                        },
                        cx,
                    );
                    // on the current branch, like WebStorm (else the first row)
                    let current = l
                        .delegate
                        .rows
                        .iter()
                        .position(|r| matches!(r, BranchRow::Branch { current: true, .. }));
                    l.state.set_cursor(current.or(Some(0)));
                    l
                });
                t.show(Popup::Branches(list), window, cx);
            });
        })
        .detach();
    }

    /// The recent projects popup (without this project).
    pub fn open_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading.replace(PopupKind::Projects).is_some() {
            return;
        }
        let current = self.scx.project.clone();
        // the open projects on top (this one first, selected (WS): a stray Enter changes nothing)
        let task = recent::recent_open_first(current.clone(), cx);
        let (name, color) = (self.project_name.to_string(), self.project_color);
        let toolbar = cx.entity().downgrade();
        cx.spawn_in(window, async move |this, cx| {
            let mut items = task.await;
            if let Some(first) = items.first_mut().filter(|p| p.path == current) {
                first.name = name;
                first.color = color;
            }
            let _ = this.update_in(cx, |t, window, cx| {
                t.loading = None;
                let list = cx.new(|cx| {
                    let mut l = ListView::new(ProjectList { items, toolbar }, cx);
                    l.state.set_cursor(Some(0));
                    l
                });
                t.show(Popup::Projects(list), window, cx);
            });
        })
        .detach();
    }

    /// The "New Branch…" form (needs the local branch names to check the name against).
    pub fn open_new_branch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_branch_form(FormMode::New, window, cx);
    }

    /// The branch name form: a new branch (from HEAD or a branch) or a rename.
    fn open_branch_form(&mut self, mode: FormMode, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading.replace(PopupKind::NewBranch).is_some() {
            return;
        }
        let dir = self.scx.project.clone();
        let local = match &self.popup {
            Some(Popup::Branches(l)) => Some(l.read(cx).delegate.local.clone()),
            _ => None,
        };
        let task = cx.background_executor().spawn(async move {
            let local = local
                .unwrap_or_else(|| git::load_branches_blocking(&dir).unwrap_or_default().local);
            (dir, local)
        });
        let toolbar = cx.entity().downgrade();
        cx.spawn_in(window, async move |this, cx| {
            let (dir, local) = task.await;
            let _ = this.update_in(cx, |t, window, cx| {
                t.loading = None;
                let form = cx.new(|cx| NewBranchForm::new(mode, dir, local, toolbar, cx));
                t.show(Popup::NewBranch(form), window, cx);
            });
        })
        .detach();
    }

    /// Checks out a branch (the popup closes at once; git runs in the background).
    pub fn checkout(
        &mut self,
        target: Target,
        local: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_popup(window, cx);
        let label = match &target {
            Target::Local(n) | Target::Remote(n) => format!("Checking out {n}…"),
        };
        self.show_busy(label, window, cx);
        let dir = self.scx.project.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::checkout_blocking(&dir, &target, &local) });
        cx.spawn_in(window, async move |this, cx| {
            let res = task.await;
            let _ = this.update_in(cx, |t, window, cx| t.git_done(res, window, cx));
        })
        .detach();
    }

    /// A branch row's submenu (⏎, → / ä, a click): WebStorm's actions for it ([`branch_popup::actions`]),
    /// at the row's right edge over the popup.
    pub fn branch_actions(
        &mut self,
        ix: usize,
        target: Target,
        current: bool,
        local: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Popup::Branches(list)) = &self.popup else {
            return;
        };
        let (row, offset, head) = {
            let l = list.read(cx);
            let offset = l.state.scroll_handle().0.borrow().base_handle.offset().y;
            (
                l.state.row_of(ix).unwrap_or(0),
                offset,
                l.delegate.head.clone(),
            )
        };
        let frame = self.popup_bounds.get();
        // the popup's top is the toolbar's bottom; its rows start under the border and padding
        let top = frame.bottom()
            + px(look::POPUP_BORDER_WIDTH + look::POPUP_PADDING_Y)
            + px(look::LIST_ROW_HEIGHT.get()) * row as f32
            + offset;
        let anchor = Anchor::Point(gpui_kit::point(frame.right() - px(4.), top));
        let name = git::target_name(&target).to_owned();
        let actions = branch_popup::actions(&target, current);
        let entries: Vec<crate::popups::MenuEntry> = actions
            .iter()
            .map(|a| crate::popups::MenuItem::new(a.label(&name)).into())
            .collect();
        self.submenu = true;
        let this = cx.entity().downgrade();
        crate::popups::open_menu(
            crate::popups::Menu::new(entries, anchor),
            window,
            cx,
            move |choice, window, cx| {
                let _ = this.update(cx, |t, cx| {
                    t.submenu = false;
                    let Some(action) = choice.and_then(|i| actions.get(i).copied()) else {
                        // Esc: back to the branches (the keyboard went back there)
                        return;
                    };
                    t.branch_action(action, target, head, local, window, cx);
                });
            },
        );
    }

    fn branch_action(
        &mut self,
        action: BranchAction,
        target: Target,
        head: git::Head,
        local: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = git::target_name(&target).to_owned();
        match action {
            BranchAction::Checkout => self.checkout(target, local, window, cx),
            BranchAction::NewFrom => self.open_branch_form(FormMode::From(name), window, cx),
            BranchAction::Rename => self.open_branch_form(FormMode::Rename(name), window, cx),
            BranchAction::Compare => {
                self.close_popup(window, cx);
                let range = git::compare_range(&head, &target);
                self.scx
                    .call("config.app.git", "show_range", vec![range.into()]);
            }
            BranchAction::Delete => self.confirm_delete(target, window, cx),
        }
    }

    /// Delete…: asked first in the flow dialog (Cancel the default, Delete outlined with `d`),
    /// saying the commits the current branch lacks are lost.
    fn confirm_delete(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        self.close_popup(window, cx);
        let dir = self.scx.project.clone();
        let reading = target.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::unmerged_blocking(&dir, &reading) });
        cx.spawn_in(window, async move |this, cx| {
            let unmerged = task.await;
            let _ = this.update_in(cx, |_, window, cx| {
                let this = cx.entity().downgrade();
                crate::popups::open_dialog(
                    delete_dialog(&target, unmerged),
                    window,
                    cx,
                    move |answer, window, cx| {
                        if answer.is_some_and(|a| a.id == "delete") {
                            let _ = this.update(cx, |t, cx| t.delete_branch(target, window, cx));
                        }
                    },
                );
            });
        })
        .detach();
    }

    fn delete_branch(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        self.show_busy(
            format!("Deleting {}…", git::target_name(&target)),
            window,
            cx,
        );
        let dir = self.scx.project.clone();
        let task = cx
            .background_executor()
            .spawn(async move { git::delete_blocking(&dir, &target) });
        cx.spawn_in(window, async move |this, cx| {
            let res = task.await;
            let _ = this.update_in(cx, |t, window, cx| t.git_done(res, window, cx));
        })
        .detach();
    }

    /// A balloon saying what git is doing, when it takes longer than half a second (hooks, big
    /// checkouts; like `git/cli.lua` `act`). The result replaces it.
    fn show_busy(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let scx = self.scx.clone();
        self.busy = Some(cx.spawn_in(window, async move |_, cx| {
            cx.background_executor().timer(BUSY_AFTER).await;
            let _ = cx.update(|window, cx| {
                let b = Balloon {
                    id: Some(GIT_BALLOON.into()),
                    timeout: None,
                    ..Balloon::info("Git", text)
                };
                scx.notify(b, window, cx);
            });
        }));
    }

    /// The name form's Enter: creates and checks out a branch (from HEAD or a branch), or renames
    /// one; a git error stays in the form.
    pub fn branch_form_done(
        &mut self,
        mode: FormMode,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let busy = match &mode {
            FormMode::Rename(old) => format!("Renaming {old}…"),
            _ => format!("Creating {name}…"),
        };
        self.show_busy(busy, window, cx);
        let dir = self.scx.project.clone();
        let task = cx.background_executor().spawn(async move {
            match mode {
                FormMode::New => git::create_blocking(&dir, &name),
                FormMode::From(from) => git::create_from_blocking(&dir, &name, &from),
                FormMode::Rename(old) => git::rename_blocking(&dir, &old, &name),
            }
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = task.await;
            let _ = this.update_in(cx, |t, window, cx| match res {
                Ok(msg) => {
                    t.close_popup(window, cx);
                    t.git_done(Ok(msg), window, cx);
                }
                Err(e) => match &t.popup {
                    Some(Popup::NewBranch(f)) => {
                        t.busy = None;
                        f.update(cx, |f, cx| {
                            f.error = Some(e);
                            cx.notify();
                        })
                    }
                    _ => t.git_done(Err(e), window, cx),
                },
            });
        })
        .detach();
    }

    /// After a git command: the widget's branch, the result balloon (replacing "Checking out…"),
    /// then Lua (buffers reload, git views).
    fn git_done(
        &mut self,
        res: Result<String, String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.busy = None;
        let (ok, msg) = match res {
            Ok(m) => (true, m),
            Err(e) => (false, e),
        };
        let b = if ok {
            Balloon::info("Git", msg)
        } else {
            Balloon::error("Git", msg)
        };
        self.scx.notify(
            Balloon {
                id: Some(GIT_BALLOON.into()),
                ..b
            },
            window,
            cx,
        );
        self.scx
            .call("config.app.toolbar", "git_done", vec![ok.into()]);
    }

    /// Shows `dir` in this window: an open one at once; else in place of this project (it closes
    /// like Close Project, asking when work would be lost), or `alongside` it (never asks).
    pub fn open_project(
        &mut self,
        dir: PathBuf,
        alongside: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_popup(window, cx);
        if dir == self.scx.project {
            return;
        }
        if alongside {
            crate::shell::projects::switch_to(dir, window, cx);
        } else {
            let anchor = Anchor::Below(self.popup_bounds.get());
            crate::shell::projects::open_in_place(dir, Some(anchor), window, cx);
        }
    }

    /// The magnifier: Search Everywhere, as double Shift (Lua decides from the focus).
    pub fn search_everywhere(&self) {
        self.scx.call("config.app", "double_shift", vec![]);
    }

    /// Close Project: the shown one (asking under the toolbar when work would be lost).
    pub fn close_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_popup(window, cx);
        let anchor = Anchor::Below(self.centered_bounds(PROJECTS_WIDTH, window));
        crate::shell::projects::close_active(Some(anchor), window, cx);
    }

    // Rendering ----------------------------------------------------------------------------------

    fn render_popup(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let popup = self.popup.as_ref()?;
        let kind = popup.kind();
        let (content, width) = match popup {
            Popup::Projects(l) => {
                let v = l.read(cx);
                let with_branch = v.delegate.items.iter().any(|p| p.branch.is_some());
                let rows = v.state.row_count().max(1) as f32;
                let row = project_popup::row_height(with_branch);
                let searching = v.state.searching();
                // the separator, "Close Project" row and the hint stay under the list
                let below =
                    look::POPUP_SEPARATOR_HEIGHT + look::LIST_ROW_HEIGHT + look::POPUP_AD_HEIGHT
                        - look::POPUP_PADDING_Y;
                let list = list_box(
                    l.clone().into_any_element(),
                    rows,
                    row,
                    searching,
                    below,
                    window,
                );
                (
                    div()
                        .flex()
                        .flex_col()
                        .child(list)
                        .child(kit::popup_separator())
                        .child(self.close_project_row(cx))
                        // WS ListPopup's ad text: what Enter / Shift+Enter do
                        .child(
                            kit::ad_text(project_popup::HINT)
                                .mt(px(look::POPUP_PADDING_Y))
                                .debug_selector(|| "toolbar-projects-hint".into()),
                        )
                        .into_any_element(),
                    PROJECTS_WIDTH,
                )
            }
            Popup::Branches(l) => {
                let v = l.read(cx);
                let rows = v.state.row_count().max(1) as f32;
                let searching = v.state.searching();
                (
                    list_box(
                        l.clone().into_any_element(),
                        rows,
                        look::LIST_ROW_HEIGHT.get(),
                        searching,
                        0.,
                        window,
                    ),
                    BRANCHES_WIDTH,
                )
            }
            Popup::NewBranch(f) => (f.clone().into_any_element(), new_branch::WIDTH),
        };
        // menu items, no widgets: under the toolbar in the window's middle
        self.popup_bounds.set(self.centered_bounds(width, window));
        let anchor = self.popup_bounds.clone();
        let (pad_top, pad_bottom) = match kind {
            PopupKind::NewBranch => (0., 0.),
            // (the ad text ends it)
            PopupKind::Projects => (look::POPUP_PADDING_Y, 0.),
            PopupKind::Branches => (look::POPUP_PADDING_Y, look::POPUP_PADDING_Y),
        };
        let frame = kit::popup_frame()
            .id("toolbar-popup")
            .debug_selector(|| "toolbar-popup".into())
            .w(px(width))
            .pt(px(pad_top))
            .pb(px(pad_bottom))
            // the popup's own events stay here (the workspace would hand them to nvim)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_mouse_up(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_move(|_, _, cx| cx.stop_propagation())
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            // a click outside closes it (not one on a branch's submenu)
            .on_mouse_down_out(cx.listener(|t, ev: &MouseDownEvent, window, cx| {
                if t.submenu && t.on_submenu(ev.position, cx) {
                    return;
                }
                t.close_popup(window, cx)
            }))
            .child(content);
        Some(
            deferred(widgets::below_widget(&anchor, frame))
                .with_priority(1)
                .into_any_element(),
        )
    }

    /// Whether `at` is on the open branch submenu (the popups' menu).
    fn on_submenu(&self, at: gpui_kit::Point<Pixels>, cx: &App) -> bool {
        self.scx.workspace.upgrade().is_some_and(|ws| {
            ws.read(cx)
                .popups()
                .read(cx)
                .menu_bounds()
                .is_some_and(|b| b.contains(&at))
        })
    }

    /// Where a popup `width` wide opens: under the toolbar, centered in the window.
    fn centered_bounds(&self, width: f32, window: &Window) -> Bounds<Pixels> {
        let vw = window.viewport_size().width;
        let x = ((vw - px(width)) / 2.).max(px(0.));
        Bounds::new(
            gpui_kit::point(x, px(0.)),
            gpui_kit::size(px(width), px(look::TOOLBAR_HEIGHT.get())),
        )
    }

    /// The project popup's "Close Project" row below the projects (a menu row; the editor's
    /// context menu has it too).
    fn close_project_row(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("toolbar-close-project")
            .debug_selector(|| "toolbar-close-project".into())
            .px(px(look::LIST_ROW_INSET_X))
            .child(
                div()
                    .h(px(look::LIST_ROW_HEIGHT.get()))
                    .px(px(look::LIST_ROW_INSET_X))
                    .flex()
                    .items_center()
                    .rounded(px(look::LIST_SELECTION_ARC))
                    .text_size(px(look::UI_FONT_SIZE))
                    .text_color(look::TEXT)
                    .hover(|d| d.bg(look::HOVER_BG))
                    .cursor(gpui_kit::CursorStyle::PointingHand)
                    .child("Close Project"),
            )
            .on_click(cx.listener(|t, _, window, cx| t.close_project(window, cx)))
            .into_any_element()
    }

    /// The window title, centered in the window when there's room beside the widgets, else in the
    /// room right of them; ellipsized. Once Abe's bridge spoke, the context line in its place
    /// (never a bare folder name like `repo`).
    fn render_title(&mut self, window: &Window, cx: &App) -> AnyElement {
        let title = self
            .scx
            .workspace
            .upgrade()
            .map(|ws| ws.read(cx).editor().read(cx).ui().title.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| self.project_name.to_string());
        self.title = title.into();
        let width = window.viewport_size().width;
        let gap = px(look::TOOLBAR_LAYOUT_GAP);
        let left = self.widgets_bounds.get().right() + gap;
        let half = width / 2. - left;
        let (x, w) = if half >= px(MIN_CENTERED_HALF) {
            (left, half * 2.)
        } else {
            (left, (width - left - gap).max(px(0.)))
        };
        // the repo's places (Board, Boxes, Pipelines) say Abe's line; a workspace's pages (Run
        // and Card too) its own
        let factory = cx
            .try_global::<crate::factory::FactoryShell>()
            .is_some_and(|f| f.shown)
            && cx
                .try_global::<crate::shell::projects::rail::RailPlace>()
                .is_none_or(|p| p.repo);
        let branch = self
            .scx
            .workspace
            .upgrade()
            .map(|ws| ws.read(cx).statusbar().read(cx).status().branch.clone())
            .unwrap_or_default();
        let remote = self
            .scx
            .workspace
            .upgrade()
            .is_some_and(|ws| ws.read(cx).remote().is_some());
        self.line = crate::factory::context_line(&self.scx.project, &branch, remote, factory, cx);
        let centre = div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(x)
            .w(w)
            .flex()
            .items_center()
            .justify_center();
        if let Some(line) = context::line(&self.line) {
            return centre.child(line).into_any_element();
        }
        centre
            .child(
                div()
                    .debug_selector(|| "toolbar-title".into())
                    .min_w_0()
                    .max_w_full()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_align(TextAlign::Center)
                    .text_size(px(look::UI_FONT_SIZE))
                    .text_color(look::TOOLBAR_TITLE_FG)
                    .child(self.title.clone()),
            )
            .into_any_element()
    }
}

/// Below this much room on each side of the window's middle the title moves right of the widgets.
const MIN_CENTERED_HALF: f32 = 80.;

/// A popup list's box: as many rows as it has, at most [`MAX_ROWS`] and what fits under the
/// toolbar with `below` px of fixed rows under it (else `kit::place` would push the frame up
/// over its widget); the search row on top while searching.
fn list_box(
    list: AnyElement,
    rows: f32,
    row: f32,
    searching: bool,
    below: f32,
    window: &Window,
) -> AnyElement {
    let room = window.viewport_size().height.as_f32()
        - look::TOOLBAR_HEIGHT
        - 2. * look::POPUP_WINDOW_MARGIN
        - 2. * look::POPUP_PADDING_Y
        - 2. // the frame's border
        - below;
    let search = if searching {
        look::LIST_ROW_HEIGHT.get()
    } else {
        0.
    };
    let h = (rows.min(MAX_ROWS) * row + search).min(room.max(row));
    div().h(px(h)).w_full().child(list).into_any_element()
}

impl Focusable for ToolbarView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ToolbarView {
    /// Mounted in the toolbar strip at the window's top (`Geometry::layout.frame.toolbar`); its
    /// empty area moves the window (the workspace's).
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let widgets_bounds = self.widgets_bounds.clone();
        let widgets = div()
            .relative()
            .flex_none()
            .h_full()
            .flex()
            .items_center()
            .pl(px(look::TOOLBAR_LEFT_INSET))
            .child(
                // the widgets' right edge for the title; a change draws once more
                canvas(
                    move |b: Bounds<Pixels>, window, _| {
                        if widgets_bounds.get() != b {
                            widgets_bounds.set(b);
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        let title = self.render_title(window, cx);
        let popup = self.render_popup(window, cx);
        let settings = settings_gear(cx);
        // the right group: Search Everywhere (WS New UI's magnifier; no Run widgets), Settings
        let right = div()
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(look::TOOLBAR_RIGHT_PAD))
            .flex()
            .items_center()
            .gap(px(4.))
            .child(
                widgets::icon_button(
                    "toolbar-search",
                    crate::kit::IconName::Search,
                    "Search Everywhere",
                    Some("Double ⇧"),
                )
                // not a window drag (the workspace's)
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|t, _, _, _| t.search_everywhere())),
            )
            .child(settings);
        #[cfg(feature = "shots")]
        let lights = widgets::traffic_lights();
        #[cfg(not(feature = "shots"))]
        let lights: Option<AnyElement> = None;
        div()
            .id("toolbar")
            .track_focus(&self.focus)
            .relative()
            .size_full()
            .flex()
            .items_center()
            .bg(look::TOOLBAR_BG)
            .font_family(crate::render::UI_FONT)
            .text_size(px(look::TOOLBAR_FONT_SIZE.get()))
            .text_color(look::TOOLBAR_FG)
            .children(lights)
            .child(title)
            .child(widgets)
            .child(right)
            .children(popup)
    }
}

/// Delete…'s question (RULES 18: Cancel is the default, the risky Delete outlined with `d`).
fn delete_dialog(target: &Target, unmerged: usize) -> crate::popups::Dialog {
    use crate::popups::{Button, Dialog, Look, Row, Section};
    let name = git::target_name(target).to_owned();
    let (row, meta) = match target {
        Target::Local(_) if unmerged > 0 => (
            name.clone(),
            format!(
                "{} the current branch lacks: lost",
                crate::kit::plural(unmerged, "commit")
            ),
        ),
        Target::Local(_) => (name.clone(), "merged into the current branch".to_owned()),
        Target::Remote(_) => (name.clone(), "on the remote, for everyone".to_owned()),
    };
    Dialog {
        id: "delete-branch",
        title: "Delete branch?".into(),
        subtitle: Some(name.into()),
        width: look::FLOW_WIDTH_CONFIRM,
        sections: vec![Section {
            heading: "What goes".into(),
            rows: vec![Row {
                name: row.into(),
                mono: true,
                meta: Some(meta.into()),
                end: Some(("deleted".into(), None)),
                ..Default::default()
            }],
            ..Default::default()
        }],
        buttons: vec![
            Button::new("delete", "Delete", Look::Danger).key("d"),
            Button::new("cancel", "Cancel", Look::Primary).key("⏎"),
        ],
        ..Default::default()
    }
}

/// Settings' gear (it stays the toolbar's, the stripe has no Settings; Welcome's title bar
/// has it too): a dot while Settings lists problems; a click opens Settings as ⌘, does.
pub fn settings_gear(cx: &gpui_kit::App) -> gpui_kit::Stateful<gpui_kit::Div> {
    let gear = cx
        .try_global::<crate::factory::FactoryShell>()
        .map(|s| s.gear.clone())
        .unwrap_or_default();
    let gear_tip = if gear.tooltip.is_empty() {
        "Settings · ⌘,".to_string()
    } else {
        gear.tooltip.clone()
    };
    div()
        .id("toolbar-settings")
        .debug_selector(|| "toolbar-settings".into())
        .relative()
        .flex_none()
        .size(px(look::TOOLBAR_BUTTON_SIZE.get()))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(look::TOOLBAR_BUTTON_ARC.get()))
        .cursor_pointer()
        .hover(|s| s.bg(look::TOOLBAR_BUTTON_HOVER_BG))
        .active(|s| s.bg(look::TOOLBAR_BUTTON_PRESSED_BG))
        .tooltip(crate::kit::tooltip(gear_tip, None))
        .child(crate::kit::Icon::new(crate::kit::IconName::Settings))
        .when_some(gear.dot, |d: gpui_kit::Stateful<gpui_kit::Div>, dot| {
            d.child(
                div()
                    .debug_selector(|| "toolbar-settings-dot".into())
                    .absolute()
                    .top(px(2.))
                    .right(px(2.))
                    .w(px(7.))
                    .h(px(7.))
                    .rounded(px(3.5))
                    .bg(crate::shell::projects::dot_color(dot)),
            )
        })
        // not a window drag (the workspace's)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(|_, window, cx| crate::shell::projects::settings_from_toolbar(window, cx))
}
