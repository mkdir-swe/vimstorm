//! Status bar (bottom strip), like WebStorm's New UI status bar with VimStorm's mode segment:
//! mode segment saying where the keys go ("VIMSTORM · NORMAL" for the editor, Git and terminals;
//! "ABE · <mode>" while an Abe surface has them: the Factory view, a flow dialog, Settings), Abe's widgets, navigation path "project › dirs › icon file › members" (the declarations around
//! the caret; leading folders folded into "…" when it doesn't fit), then line:col (+ selection size), line ending, encoding, indent, a lock
//! for read-only files and the git branch. Always about the last focused split; dims while the
//! window is in the background. Only the mode segment is clickable (the Lua status line had no
//! clicks).
//!
//! The content is `config/statusline.lua`'s (`parts()`), sent by `config/app/status.lua` when it
//! changes: cursor moves, mode, buffer / window changes, options, the branch.
//!
//! Per view: on the Editor a story workspace's path starts with its story
//! (`#2 cart total ignores quantity › api › src › cart.ts`, the bridge's crumb in the folder's
//! place) and its right end is the editor's own, then a box's `☁ demo-shop-102`, then the branch;
//! on the Factory view `ABE · BOARD` · `demo-shop · Sprint 1` and only the bridge's widgets
//! (`◆ 1 needs you · ● 2 running`): never a workspace's branch.

use gpui_kit::{
    AnyElement, App, Context, FocusHandle, Focusable, Font, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Rgba, SharedString, Styled as _, Window, div, font,
    px,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::tabs::seq;
use crate::kit::{self, Icon, IconName};
use crate::look;
use crate::nvim::lua;
use crate::render::UI_FONT;

/// What the status bar shows (`config/statusline.lua` StatusParts).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Status {
    /// Badge letter: N, I, V, S, R, C.
    pub mode: String,
    /// "Normal" | "Insert" | "Visual" | "Replace" | "Command".
    pub mode_kind: String,
    /// Register being recorded into ("" when not).
    #[serde(default)]
    pub recording: String,
    /// Project and folders of the file.
    #[serde(default, deserialize_with = "seq")]
    pub crumbs: Vec<String>,
    /// File name ("" without a file).
    #[serde(default)]
    pub file: String,
    /// line:col, line ending, encoding, indent.
    #[serde(default, deserialize_with = "seq")]
    pub right: Vec<String>,
    #[serde(default)]
    pub readonly: bool,
    /// Git branch ("" outside a repo).
    #[serde(default)]
    pub branch: String,
    /// The declarations around the caret, outermost first (WebStorm's navigation path members:
    /// "report.get.ts › handler").
    #[serde(default, deserialize_with = "seq")]
    pub symbols: Vec<Symbol>,
    /// The caret in a file: Chat's implicit context; none without a file.
    #[serde(default)]
    pub caret: Option<StatusCaret>,
}

/// The caret as `statusline.lua` says it: the file relative to the project, the 1-based line,
/// the selected lines in Visual mode.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct StatusCaret {
    pub file: String,
    pub line: u32,
    #[serde(default)]
    pub from: Option<u32>,
    #[serde(default)]
    pub to: Option<u32>,
}

impl Status {
    /// What the Factory's bridge hears of this Editor: its caret and branch.
    fn editor_at(&self) -> crate::factory::EditorAt {
        use crate::factory::{Caret, Lines};
        crate::factory::EditorAt {
            caret: self
                .caret
                .as_ref()
                .filter(|c| c.line > 0 && !c.file.is_empty())
                .map(|c| Caret {
                    file: c.file.clone(),
                    line: c.line,
                    selection: c.from.zip(c.to).map(|(from, to)| Lines { from, to }),
                }),
            branch: (!self.branch.is_empty()).then(|| self.branch.clone()),
        }
    }
}

/// A declaration in the navigation path: its name and LSP SymbolKind name (the icon).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Symbol {
    pub name: String,
    #[serde(default)]
    pub kind: String,
}

/// `vimstorm.statusbar` (config/app/status.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum StatusEvent {
    Status(Box<Status>),
    Focus,
}

/// Feel vscode: the file's path and symbols are breadcrumbs under the editor's tabs, not
/// on the status bar.
fn crumbs_under_tabs(cx: &App) -> bool {
    crate::factory::vscode(cx)
}

/// Vim mode is on (the Feel's `editor.vim`; on until the bridge says).
fn vim_mode(cx: &App) -> bool {
    cx.try_global::<crate::factory::Feel>()
        .is_none_or(|f| f.editor.vim)
}

/// The mode badge's colors (fg, bg) per mode: muted New UI colors (own: Insert the selection blue,
/// Visual a muted purple, Replace a muted red, Command the field border grey; no nvim group).
pub fn mode_colors(kind: &str) -> (Rgba, Rgba) {
    match kind {
        "Insert" => (look::MODE_INSERT_FG.rgba(), look::MODE_INSERT_BG.rgba()),
        "Visual" => (look::MODE_VISUAL_FG.rgba(), look::MODE_VISUAL_BG.rgba()),
        "Replace" => (look::MODE_REPLACE_FG.rgba(), look::MODE_REPLACE_BG.rgba()),
        "Command" => (look::MODE_COMMAND_FG.rgba(), look::MODE_COMMAND_BG.rgba()),
        _ => (look::MODE_NORMAL_FG.rgba(), look::MODE_NORMAL_BG.rgba()),
    }
}

/// The folded-away folders' mark.
pub const ELLIPSIS: &str = "…";

/// Folds the navigation path's leading folders into "…" until it fits `room` (`config/statusline.lua`
/// rule: the project stays, then "…", then as many of the last folders as fit). `width` measures
/// one part; `fixed` is the rest of the path's width (the file, separators are added per part).
pub fn fold(
    parts: &[String],
    fixed: f32,
    sep: f32,
    room: f32,
    width: impl Fn(&str) -> f32,
) -> Vec<String> {
    let len = |list: &[String]| fixed + list.iter().map(|p| width(p) + sep).sum::<f32>();
    let mut out = parts.to_vec();
    while out.len() > 2 && len(&out) > room {
        let i = if out[1] == ELLIPSIS { 2 } else { 1 };
        if i >= out.len() {
            break;
        }
        out.remove(i);
        if out[1] != ELLIPSIS {
            out.insert(1, ELLIPSIS.to_owned());
        }
    }
    out
}

/// The badge's size.
const BADGE_H: f32 = 16.;
const BADGE_PAD_X: f32 = 5.;
/// Navigation path separator (chevron icon) width.
const SEP_W: f32 = look::ICON_SIZE;

/// What the bar drew last (tests): the path's crumbs (the file not among them) and the right
/// end's words, left to right.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StatusDrawn {
    pub crumbs: Vec<String>,
    pub right: Vec<String>,
}

pub struct StatusbarView {
    scx: crate::shell::SurfaceCx,
    focus: FocusHandle,
    status: Status,
    /// The story crumb in the project folder's place: the bridge's, else the story a cloud
    /// workspace's branch names; set as the bar draws.
    story: Option<String>,
    drawn: StatusDrawn,
    /// The text color of the last render (tests: dimmed while the window is inactive).
    text_color: gpui_kit::Rgba,
    _activation: gpui_kit::Subscription,
    /// The header's feed: the story crumb, the box's cloud.
    _header: [gpui_kit::Subscription; 3],
    /// The Factory view: `ABE · BOARD` while shown (`ABE · PROTOTYPE` in Prototype
    /// mode), its bridge's widgets.
    _factory: gpui_kit::Subscription,
    /// The project's popups: a flow dialog (Stop agent, Instructions…) is an Abe surface.
    popups: Option<gpui_kit::WeakEntity<crate::popups::PopupsView>>,
    _popups: Option<gpui_kit::Subscription>,
}

impl StatusbarView {
    pub fn status(&self) -> &Status {
        &self.status
    }

    /// What the bar drew last.
    pub fn drawn(&self) -> &StatusDrawn {
        &self.drawn
    }

    /// The story crumb for this project: the feed's, else (a cloud workspace not known yet) the
    /// story its branch names.
    fn story_crumb(&self, cx: &App) -> Option<String> {
        if let Some(look) = crate::factory::look_of(&self.scx.project, cx) {
            return Some(look.crumb.clone());
        }
        let remote = self
            .scx
            .workspace
            .upgrade()
            .is_some_and(|ws| ws.read(cx).remote().is_some());
        remote
            .then(|| crate::factory::story_of_branch(&self.status.branch))
            .flatten()
    }

    /// The path's parts: Lua's crumbs, the project folder replaced by the story's.
    fn path_parts(&self) -> Vec<String> {
        let mut parts = self.status.crumbs.clone();
        if let (Some(story), Some(first)) = (&self.story, parts.first_mut()) {
            first.clone_from(story);
        }
        parts
    }

    /// The text color the bar was last drawn with.
    pub fn text_color(&self) -> gpui_kit::Rgba {
        self.text_color
    }

    fn text_width(window: &Window, text: &str, f: Font) -> f32 {
        crate::kit::width(window, text, f, px(look::UI_SMALL_FONT_SIZE)).as_f32()
    }

    /// The navigation path, folded to `room`.
    pub fn crumbs(&self, room: f32, window: &Window) -> Vec<String> {
        let s = &self.status;
        let ui = font(UI_FONT);
        let file = if s.file.is_empty() {
            0.
        } else {
            look::ICON_SIZE + look::TAB_ICON_GAP + Self::text_width(window, &s.file, ui.clone())
        };
        // the members after the file stay (WS shrinks the folders first)
        let members: f32 = s
            .symbols
            .iter()
            .map(|m| {
                SEP_W
                    + look::ICON_SIZE
                    + look::TAB_ICON_GAP
                    + Self::text_width(window, &m.name, ui.clone())
            })
            .sum();
        let file = file + members;
        fold(&self.path_parts(), file, SEP_W, room, |p| {
            Self::text_width(window, p, ui.clone())
        })
    }

    /// The editor's own (line:col, line ending, encoding, indent, the lock), then a box's cloud,
    /// then the branch.
    fn right_items(&self, text: Rgba, cloud: Option<AnyElement>) -> Vec<AnyElement> {
        let s = &self.status;
        let pad = px(look::STATUS_BAR_WIDGET_PAD_X);
        let widget = || div().h_full().px(pad).flex().items_center().gap(px(4.));
        let mut out: Vec<AnyElement> = Vec::new();
        out.extend(s.right.iter().map(|t| {
            widget()
                .child(SharedString::from(t.clone()))
                .into_any_element()
        }));
        if s.readonly {
            // WebStorm's lock (a Cloud workspace's files while the cloud agent writes, K-19)
            out.push(
                widget()
                    .debug_selector(|| "status-readonly".into())
                    .child(Icon::new(IconName::Locked))
                    .into_any_element(),
            );
        }
        if let Some(cloud) = cloud {
            out.push(cloud);
        }
        if !s.branch.is_empty() {
            out.push(
                widget()
                    .debug_selector(|| "status-branch".into())
                    .child(Icon::new(IconName::Branch))
                    .child(
                        div()
                            .text_color(text)
                            .child(SharedString::from(s.branch.clone())),
                    )
                    .into_any_element(),
            );
        }
        out
    }

    /// The project's popups, followed: a flow dialog open says ABE (its keys are Abe's).
    pub fn follow_popups(
        &mut self,
        popups: &gpui_kit::Entity<crate::popups::PopupsView>,
        cx: &mut Context<Self>,
    ) {
        self.popups = Some(popups.downgrade());
        self._popups = Some(cx.observe(popups, |_, _, cx| cx.notify()));
    }

    /// Abe's mode while a flow dialog or the Settings dialog is up (NORMAL: its own keys, 1.0
    /// design W-31 / W-35..37).
    fn abe_mode(&self, cx: &App) -> Option<&'static str> {
        if self
            .popups
            .as_ref()
            .and_then(|p| p.upgrade())
            .is_some_and(|p| p.read(cx).dialog().is_some())
        {
            return Some("NORMAL");
        }
        // the Settings dialog is an Abe surface wherever it was opened from
        crate::factory::settings_up(cx).then_some("NORMAL")
    }

    /// A cloud workspace's one sign (V5-08): its box's cloud and name
    /// (`☁ demo-shop-102`), quiet; while it wakes or connects its progress, after a failed connect
    /// in red. Hover: its box, region, round trip.
    fn cloud_widget(&self, cx: &App) -> Option<AnyElement> {
        use gpui_kit::StatefulInteractiveElement as _;
        let ws = self.scx.workspace.upgrade()?;
        let link = ws.read(cx).remote()?;
        let color = if link.failed() {
            look::ABE_BAD.rgba()
        } else if link.attached() {
            self.text_color
        } else {
            look::ABE_WARN.rgba()
        };
        let el = div()
            .id("status-cloud")
            .debug_selector(|| "status-cloud".into())
            .flex_none()
            .h_full()
            .px(px(look::STATUS_BAR_WIDGET_PAD_X))
            .flex()
            .items_center()
            .gap(px(look::TAB_ICON_GAP))
            .text_color(color)
            .tooltip(crate::kit::tooltip(link.hover(), None));
        Some(if link.attached() {
            // the box's cloud in its hue (the feed's, else running), then its name
            let look = crate::factory::look_of(&self.scx.project, cx);
            let state = look
                .and_then(|l| l.cloud)
                .unwrap_or(crate::factory::CloudState::Running);
            el.child(crate::factory::cloud(
                state,
                12.,
                crate::factory::cloud_color(look.and_then(|l| l.cloud_hue)),
            ))
            .child(SharedString::from(link.attach.box_.name.clone()))
            .into_any_element()
        } else {
            el.child(SharedString::from(
                link.status_text(std::time::Instant::now()),
            ))
            .into_any_element()
        })
    }

    /// The mode segment's text: where the keys go. "ABE · " and Abe's mode while an Abe surface
    /// has them, else "VIMSTORM · " and the vim mode ("NORMAL", "INSERT" ...).
    pub fn segment_text(&self, cx: &App) -> String {
        if factory_shown(cx) {
            let word = cx
                .try_global::<crate::shell::projects::rail::RailPlace>()
                .map_or("BOARD", |p| p.word);
            return format!("ABE · {word}");
        }
        if let Some(mode) = self.abe_mode(cx) {
            return format!("ABE · {mode}");
        }
        // Vim mode off: no modes to name, as WebStorm or VS Code
        if !vim_mode(cx) {
            return "VIMSTORM".to_owned();
        }
        let kind = if self.status.mode_kind.is_empty() {
            "Normal"
        } else {
            &self.status.mode_kind
        };
        format!("VIMSTORM · {}", kind.to_uppercase())
    }
}

impl crate::shell::Surface for StatusbarView {
    const NAME: &'static str = "statusbar";

    fn new(scx: crate::shell::SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        // dims with the window
        let activation = cx.observe_window_activation(window, |_, _, cx| cx.notify());
        let factory = cx.observe_global::<crate::factory::FactoryShell>(|_, cx| cx.notify());
        let header = [
            cx.observe_global::<crate::factory::ShownWorkspaces>(|_, cx| cx.notify()),
            cx.observe_global::<crate::factory::WorkspaceFeed>(|_, cx| cx.notify()),
            // Vim mode and the breadcrumbs' place
            cx.observe_global::<crate::factory::Feel>(|_, cx| cx.notify()),
        ];
        StatusbarView {
            scx,
            focus: cx.focus_handle(),
            status: Status {
                mode: "N".into(),
                mode_kind: "Normal".into(),
                ..Default::default()
            },
            story: None,
            drawn: StatusDrawn::default(),
            text_color: look::STATUS_BAR_TEXT.rgba(),
            _header: header,
            _activation: activation,
            _factory: factory,
            popups: None,
            _popups: None,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        match lua::decode::<StatusEvent>(Self::NAME, payload) {
            Some(StatusEvent::Status(s)) => {
                if *s != self.status {
                    crate::factory::set_editor_at(&self.scx.project, s.editor_at(), cx);
                    self.status = *s;
                    cx.notify();
                }
            }
            // nothing here takes keys: nvim keeps them
            Some(StatusEvent::Focus) => self.scx.focus_editor(window, cx),
            None => {}
        }
    }
}

impl Focusable for StatusbarView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for StatusbarView {
    /// Mounted in the status strip (`Geometry::layout.frame.status`).
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let text = if crate::editor::window_active(window) {
            look::STATUS_BAR_TEXT
        } else {
            look::STATUS_BAR_TEXT_INACTIVE
        };
        self.text_color = text.rgba();
        // the Factory view's bar is the Factory's: its crumb and widgets, no workspace's parts
        let factory = factory_shown(cx);
        self.story = if factory { None } else { self.story_crumb(cx) };
        let s = if factory {
            Status {
                mode: self.status.mode.clone(),
                mode_kind: self.status.mode_kind.clone(),
                crumbs: cx
                    .try_global::<crate::factory::WorkspaceFeed>()
                    .map(|f| f.factory.crumb.clone())
                    .filter(|c| !c.is_empty())
                    .into_iter()
                    .collect(),
                ..Default::default()
            }
        } else {
            let mut s = self.status.clone();
            // Feel vscode: the path is the breadcrumbs under the editor's tabs
            if crumbs_under_tabs(cx) {
                s.crumbs.clear();
                s.file.clear();
                s.symbols.clear();
            }
            s
        };
        let ui = font(UI_FONT);
        let pad = look::STATUS_BAR_WIDGET_PAD_X;
        // room for the path: the strip minus the badge, recording note and right side
        let width = window.viewport_size().width.as_f32();
        let segment = self.segment_text(cx);
        let kind = if factory_shown(cx) || self.abe_mode(cx).is_some() || !vim_mode(cx) {
            "Normal".to_owned()
        } else {
            s.mode_kind.clone()
        };
        let badge_w =
            (Self::text_width(window, &segment, ui.clone()) + 2. * BADGE_PAD_X).max(BADGE_H);
        let rec = (!s.recording.is_empty()).then(|| format!("recording @{}", s.recording));
        let rec_w = rec
            .as_ref()
            .map_or(0., |r| Self::text_width(window, r, ui.clone()) + pad);
        let mut right_w: f32 = s
            .right
            .iter()
            .map(|t| Self::text_width(window, t, ui.clone()) + 2. * pad)
            .sum();
        if s.readonly {
            right_w += 2. * pad + look::ICON_SIZE;
        }
        if !s.branch.is_empty() {
            right_w +=
                2. * pad + look::ICON_SIZE + 4. + Self::text_width(window, &s.branch, ui.clone());
        }
        let start_w: f32 = crate::factory::shown_widgets(cx, crate::factory::WidgetPlace::Start)
            .iter()
            .map(|w| Self::text_width(window, &w.text, ui.clone()) + 3. * pad)
            .sum();
        let room = width - pad - badge_w - pad - rec_w - start_w - right_w - pad;
        let crumbs = if factory || crumbs_under_tabs(cx) {
            s.crumbs.clone()
        } else {
            self.crumbs(room, window)
        };
        let cloud = if factory { None } else { self.cloud_widget(cx) };
        self.drawn = StatusDrawn {
            crumbs: crumbs.clone(),
            right: if factory {
                crate::factory::shown_widgets(cx, crate::factory::WidgetPlace::End)
                    .into_iter()
                    .map(|w| w.text)
                    .collect()
            } else {
                shell_widget_texts(cx)
            }
            .into_iter()
            .chain(s.right.iter().cloned())
            .chain(
                cloud
                    .is_some()
                    .then(|| {
                        self.scx
                            .workspace
                            .upgrade()
                            .and_then(|ws| ws.read(cx).remote().map(|l| l.attach.box_.name.clone()))
                    })
                    .flatten(),
            )
            .chain((!s.branch.is_empty()).then(|| s.branch.clone()))
            .collect(),
        };

        let mut path = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .overflow_hidden()
            .whitespace_nowrap();
        // Abe 2.0 Command mode's answer: a command's one line, a rule between it and the path
        if let Some(line) = cx
            .try_global::<crate::factory::FactoryShell>()
            .and_then(|f| f.status.clone())
        {
            path = path.child(
                div()
                    .debug_selector(|| "factory-status".into())
                    .flex_none()
                    .pr(px(pad))
                    .child(SharedString::from(line)),
            );
            if !crumbs.is_empty() || !s.file.is_empty() {
                path = path.child(rule(text));
            }
        }
        for (i, c) in crumbs.iter().enumerate() {
            if i > 0 {
                path = path.child(separator());
            }
            path = path.child(SharedString::from(c.clone()));
        }
        if !s.file.is_empty() {
            if !crumbs.is_empty() {
                path = path.child(separator());
            }
            path = path.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(look::TAB_ICON_GAP))
                    .child(Icon::new(kit::for_file(&s.file)))
                    .child(SharedString::from(s.file.clone())),
            );
            for m in &s.symbols {
                path = path.child(separator()).child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(look::TAB_ICON_GAP))
                        .child(crate::search::icon(&m.kind, cx))
                        .child(SharedString::from(m.name.clone())),
                );
            }
        }

        let mut left = div()
            .flex()
            .items_center()
            .h_full()
            .pl(px(pad))
            .gap(px(pad))
            .child(mode_segment(segment, &kind));
        if let Some(r) = rec {
            left = left.child(SharedString::from(r));
        }
        // Abe 2.0's widgets beside the badge (the Editor's `Factory ◆ N`)
        left = left.children(crate::factory::status_widgets(
            cx,
            crate::factory::WidgetPlace::Start,
        ));

        // (no track_focus: a click on the bar would take the keyboard from nvim)
        div()
            .debug_selector(|| "status-bar".into())
            .size_full()
            .bg(look::STATUS_BAR_BG)
            .flex()
            .items_center()
            .font(ui)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(text)
            .child(left)
            .child(div().w(px(pad)).flex_none())
            .child(path)
            .child(
                div()
                    .flex_none()
                    .h_full()
                    .pr(px(pad))
                    .flex()
                    .items_center()
                    // the error history's `⚠ N`, then Abe's widgets, on every view
                    // (B15); then the editor's own
                    .children(crate::popups::widget(cx))
                    .children(if factory {
                        crate::factory::status_widgets(cx, crate::factory::WidgetPlace::End)
                    } else {
                        shell_widgets(cx)
                    })
                    .children(if factory {
                        Vec::new()
                    } else {
                        self.right_items(text.rgba(), cloud)
                    }),
            )
    }
}

/// The widgets every view's status bar shows (story 3): Abe 3.x's. It counts no one who needs
/// you: the rail's tiles say that.
pub fn shell_widgets(cx: &App) -> Vec<AnyElement> {
    crate::factory::status_widgets(cx, crate::factory::WidgetPlace::End)
}

/// [`shell_widgets`]' words, as drawn (tests read them through [`StatusbarView::drawn`]).
fn shell_widget_texts(cx: &App) -> Vec<String> {
    crate::factory::shown_widgets(cx, crate::factory::WidgetPlace::End)
        .into_iter()
        .map(|w| w.text)
        .collect()
}

/// The Factory view is the shown view.
fn factory_shown(cx: &App) -> bool {
    cx.try_global::<crate::factory::FactoryShell>()
        .is_some_and(|f| f.shown)
}

/// The mode segment at the status bar's left end: where the keys go (VimStorm or Abe) and the
/// mode, as a badge in the vim mode's colors. Not a focus target.
pub fn mode_segment(label: impl Into<SharedString>, kind: &str) -> AnyElement {
    let (fg, bg) = mode_colors(kind);
    div()
        .id("mode-segment")
        .flex_none()
        .h(px(BADGE_H))
        .min_w(px(BADGE_H))
        .px(px(BADGE_PAD_X))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(BADGE_H / 2.))
        .bg(bg)
        .text_color(fg)
        .font_weight(FontWeight::BOLD)
        .whitespace_nowrap()
        .child(label.into())
        .into_any_element()
}

/// A dim upright rule between Command mode's line and the path (a "›" would read as the path's).
fn rule(color: look::Tok) -> AnyElement {
    div()
        .debug_selector(|| "factory-status-rule".into())
        .flex_none()
        .w(px(1.))
        .h(px(look::UI_SMALL_FONT_SIZE))
        .mr(px(look::STATUS_BAR_WIDGET_PAD_X))
        .bg(color)
        .opacity(0.6)
        .into_any_element()
}

/// "›" between path parts (WebStorm: a chevron icon, dimmed; the editor's breadcrumbs too).
pub(crate) fn separator() -> AnyElement {
    div()
        .flex_none()
        .opacity(0.6)
        .child(Icon::new(IconName::ChevronRight))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn leading_folders_fold_into_an_ellipsis_until_the_path_fits() {
        let path = parts(&["proj", "frontend", "apps", "admin", "routes"]);
        // every part 10 wide + 2 separator: 60 for all
        let w = |p: &str| if p == ELLIPSIS { 4. } else { 10. };
        assert_eq!(fold(&path, 0., 2., 60., w), path, "fits: unchanged");
        assert_eq!(
            fold(&path, 0., 2., 55., w),
            parts(&["proj", "…", "apps", "admin", "routes"])
        );
        assert_eq!(
            fold(&path, 0., 2., 30., w),
            parts(&["proj", "…", "routes"]),
            "the project and the last folder always stay"
        );
        assert_eq!(fold(&parts(&["proj"]), 100., 2., 10., w), parts(&["proj"]));
    }
}
