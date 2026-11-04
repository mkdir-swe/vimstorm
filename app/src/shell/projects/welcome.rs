//! Welcome (board W-Welcome): the window's content when no project is open. Closing the last
//! project (Close Project, ⌘Q on it, the red button, `:qa`, its nvim dying) no longer quits
//! VimStorm: the window shrinks to its own Welcome frame and shows the bridge's `welcome` screen
//! (your cards by state, your recent projects), run from home. Opening a project from it (⏎, the
//! Dock, `vimstorm <dir>`) puts the project's frame back and shows the normal window.
//!
//! - **Frames**: Welcome keeps its own, `<state>/vimstorm/welcome-frame.json` (AppKit screen
//!   coordinates), the first time 1000 × 680 centred on the screen the window is on; the project
//!   frame it replaced is held in memory and put back when a project opens.
//! - **Keys**: ⌘Q quits at once (nothing can be lost), ⌘W and the red button close the window and
//!   the app stays (hidden: a Dock click, `vimstorm` / `abe` from a terminal bring it back), ⌘,
//!   Settings; the rest is the screen's.
//! - **The stripe** at the window's left edge, the bridge's items as a project
//!   window's off a workspace: the screen's page picks Board, Project (its recent projects),
//!   Sessions or Boxes. Settings is the gear in its title bar. Clone… (`clone-project`) clones into `~/projects/<name>` and opens it.
//! - Without an `abe` 2.x there is no Welcome: the last project closing quits as before.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gpui_kit::{
    AnyElement, Context, Focusable as _, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, ParentElement as _, SharedString, Styled as _, Window, div, px,
};

use super::{Projects, state_home};
use crate::factory::{FIRST_SCREEN, Slot};
use crate::look;
use crate::shell::projects::stripe::{self, Place, STRIPE_WIDTH};

/// Where Clone… clones into: `~/projects`, else this folder (tests).
#[derive(Clone, Debug)]
pub struct ClonesDir(pub PathBuf);

impl gpui_kit::Global for ClonesDir {}

/// The folder `url` clones into under `parent`: its last segment without `.git`; none when the
/// URL names nothing (`/`, `.`, `..`).
pub fn clone_target(parent: &Path, url: &str) -> Option<PathBuf> {
    let last = url
        .trim()
        .trim_end_matches('/')
        .rsplit(['/', ':', '\\'])
        .next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty() && name != "." && name != "..").then(|| parent.join(name))
}

/// What Welcome's stripe draws on `page` (`welcome.ts` `welcomeStripeAt`, the contract's
/// `stripe/welcome-*.json`): the stripe off a workspace, the page's item picked (Project for its
/// recent projects).
pub fn welcome_shown(items: &[crate::factory::StripeItem], page: &str) -> stripe::Shown {
    let pick = match page {
        "projects" => "project",
        "sessions" => "sessions",
        "boxes" => "boxes",
        _ => "board",
    };
    let mut shown = stripe::shown(items, Place::Board, None);
    for d in shown.top.iter_mut().chain(shown.bottom.iter_mut()) {
        d.picked = d.id == pick;
    }
    shown
}

/// The `welcome` screen's name (`abe/packages/ui/src/welcome/welcome.ts`).
pub const WELCOME_SCREEN: &str = "welcome";

/// Welcome's first frame, logical px (W-Welcome frame 1).
pub const WELCOME_SIZE: (f64, f64) = (1000., 680.);

/// A window frame in AppKit screen coordinates (origin bottom left of the main screen).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Frame {
    fn overlaps(&self, o: &Frame) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

/// `size` centred in `screen` (its visible frame), never bigger than it.
pub fn centred(screen: Frame, size: (f64, f64)) -> Frame {
    let (w, h) = (size.0.min(screen.w), size.1.min(screen.h));
    Frame {
        x: (screen.x + (screen.w - w) / 2.).round(),
        y: (screen.y + (screen.h - h) / 2.).round(),
        w,
        h,
    }
}

/// Where Welcome goes: its saved frame while it is still on one of `screens`, else
/// [`WELCOME_SIZE`] centred on `on` (the screen the window is on).
pub fn welcome_frame(saved: Option<Frame>, screens: &[Frame], on: Frame) -> Frame {
    match saved {
        Some(f) if f.w >= 200. && f.h >= 200. && screens.iter().any(|s| s.overlaps(&f)) => f,
        _ => centred(on, WELCOME_SIZE),
    }
}

/// The file Welcome's frame is kept in.
pub fn frame_path(state_home: Option<&Path>) -> PathBuf {
    crate::shell::recent::state_dir(state_home).join("welcome-frame.json")
}

pub fn load_frame(state_home: Option<&Path>) -> Option<Frame> {
    let text = std::fs::read_to_string(frame_path(state_home)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_frame(state_home: Option<&Path>, f: Frame) {
    let path = frame_path(state_home);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&f) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// The window's native frame, its screen's visible frame and every screen's (macOS); None where
/// there is no AppKit window (tests).
#[cfg(target_os = "macos")]
mod native {
    use super::Frame;
    use gpui_kit::Window;
    use objc2_app_kit::{NSScreen, NSView, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    fn ns_window(window: &Window) -> Option<objc2::rc::Retained<NSWindow>> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        objc2::MainThreadMarker::new()?;
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return None;
        };
        // SAFETY: GPUI's live NSView for this window, on the main thread.
        let view: &NSView = unsafe { h.ns_view.cast().as_ref() };
        view.window()
    }

    fn frame_of(r: NSRect) -> Frame {
        Frame {
            x: r.origin.x,
            y: r.origin.y,
            w: r.size.width,
            h: r.size.height,
        }
    }

    pub fn current(window: &Window) -> Option<Frame> {
        Some(frame_of(ns_window(window)?.frame()))
    }

    pub fn screens(window: &Window) -> Option<(Frame, Vec<Frame>)> {
        let mtm = objc2::MainThreadMarker::new()?;
        let w = ns_window(window)?;
        let on = w.screen().map(|s| frame_of(s.visibleFrame()))?;
        let all = NSScreen::screens(mtm)
            .iter()
            .map(|s| frame_of(s.visibleFrame()))
            .collect();
        Some((on, all))
    }

    /// The Dock icon's badge: `n` (0: none).
    pub fn badge(n: u32) {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let tile = objc2_app_kit::NSApplication::sharedApplication(mtm).dockTile();
        let label = (n > 0).then(|| objc2_foundation::NSString::from_str(&n.to_string()));
        tile.setBadgeLabel(label.as_deref());
    }

    pub fn set(window: &Window, f: Frame) -> bool {
        let Some(w) = ns_window(window) else {
            return false;
        };
        let rect = NSRect::new(NSPoint::new(f.x, f.y), NSSize::new(f.w, f.h));
        w.setFrame_display_animate(rect, true, true);
        true
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::Frame;
    use gpui_kit::Window;

    pub fn current(_: &Window) -> Option<Frame> {
        None
    }

    pub fn screens(_: &Window) -> Option<(Frame, Vec<Frame>)> {
        None
    }

    pub fn set(_: &Window, _: Frame) -> bool {
        false
    }

    pub fn badge(_: u32) {}
}

/// The window's frame now: native, else its GPUI bounds (tests).
fn current_frame(window: &Window) -> Frame {
    native::current(window).unwrap_or_else(|| {
        let b = window.bounds();
        Frame {
            x: f64::from(f32::from(b.origin.x)),
            y: f64::from(f32::from(b.origin.y)),
            w: f64::from(f32::from(b.size.width)),
            h: f64::from(f32::from(b.size.height)),
        }
    })
}

/// The window moved to `f` (animated); where there is no native window, only its size.
fn set_frame(window: &mut Window, f: Frame) {
    if !native::set(window, f) {
        window.resize(gpui_kit::size(px(f.w as f32), px(f.h as f32)));
    }
}

/// Welcome shown: the frame of the project it replaced, put back when a project opens.
pub(super) struct Welcome {
    project_frame: Frame,
    /// The screen's word (`welcome` effect): Mine's Needs you count (the Dock badge), the
    /// board's crumb (the status bar).
    needs_you: u32,
    crumb: String,
    /// The page shown (`welcome` effect): the stripe's pick.
    page: String,
    /// The screen's last `balloon` words (a project's balloons need a project's popups): on the
    /// status bar, until the next; its `status` line wins.
    note: String,
    /// The status bar redrawn on the screen's `status` line (`FactoryShell`).
    _status: gpui_kit::Subscription,
}

/// A recent project as the `welcome` screen's `projects` param has it.
#[derive(serde::Serialize)]
struct ProjectRow {
    name: String,
    path: String,
    shown: String,
    initials: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    /// Its folder is gone (its session kept): a dim row, Remove from list.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    gone: bool,
}

/// The recent projects as the screen's `projects` param (JSON): every project, most recent first,
/// then the ones whose folder is gone.
fn projects_param(state_home: Option<&Path>) -> String {
    let row = |path: &Path, name: String, branch: Option<String>, gone: bool| ProjectRow {
        initials: crate::shell::recent::initials(&name),
        shown: crate::shell::recent::display_path(path),
        path: path.to_string_lossy().into_owned(),
        name,
        branch,
        gone,
    };
    let mut rows: Vec<ProjectRow> = crate::shell::recent::recent_with(state_home)
        .into_iter()
        .map(|p| row(&p.path, p.name, p.branch, false))
        .collect();
    rows.extend(
        crate::shell::recent::gone_with(state_home)
            .into_iter()
            .map(|p| {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.display().to_string());
                row(&p, name, None, true)
            }),
    );
    serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
}

impl Projects {
    /// Whether Welcome is shown (no project open).
    pub fn welcome_shown(&self) -> bool {
        self.welcome.is_some()
    }

    /// Whether the last project closing shows Welcome rather than quitting: an `abe` 2.x is there
    /// to draw it.
    pub(super) fn can_welcome(cx: &gpui_kit::App) -> bool {
        crate::factory::BridgeCommand::available(cx)
    }

    /// No project open any more (the last one closed, or a launch with nothing to reopen): the
    /// window takes Welcome's frame and shows the `welcome` screen, run from home, with the
    /// keyboard.
    pub(super) fn enter_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // (a project handed over before a launch's Welcome came: it stays)
        if self.welcome.is_some() || !self.open.is_empty() {
            return;
        }
        crate::app::line("welcome: no project open");
        let project_frame = current_frame(window);
        self.welcome = Some(Welcome {
            project_frame,
            needs_you: 0,
            crumb: String::new(),
            page: "board".into(),
            note: String::new(),
            _status: cx.observe_global::<crate::factory::FactoryShell>(|_, cx| cx.notify()),
        });
        // the Factory view's own state is a project's: none of it holds on Welcome
        self.factory_shown = false;
        self.factory_return = None;
        let mut shell = cx
            .try_global::<crate::factory::FactoryShell>()
            .cloned()
            .unwrap_or_default();
        shell.shown = false;
        // a project's status line is not Welcome's
        shell.status = None;
        cx.set_global(shell);
        crate::shell::column::set_state(cx, |s| s.factory_shown = false);
        let home = crate::shell::recent::home();
        let view = self.ensure_factory(window, cx);
        // no project shown: Chat leaves the closed one, a project opened again is told anew
        self.tell_factory_root(cx);
        view.update(cx, |v, cx| {
            v.chrome_height = look::TOOLBAR_HEIGHT + look::STATUS_BAR_HEIGHT;
            v.chrome_width = 0.;
            v.board_room = 0.;
            v.set_root(Some(home.to_string_lossy().into_owned()));
            v.set_shown(true, cx);
            v.start(window, cx);
        });
        window.focus(&view.focus_handle(cx), cx);
        self.read_welcome_projects(window, cx);
        // the red button closes the window; the app stays (WebStorm's Welcome on a Mac)
        window.on_window_should_close(cx, |window, cx| {
            hide_welcome(window, cx);
            false
        });
        window.set_window_title("Welcome to VimStorm");
        let saved = load_frame(state_home(cx).as_deref());
        let target = match native::screens(window) {
            Some((on, all)) => welcome_frame(saved, &all, on),
            None => saved.unwrap_or_else(|| {
                centred(
                    Frame {
                        x: 0.,
                        y: 0.,
                        w: WELCOME_SIZE.0,
                        h: WELCOME_SIZE.1,
                    },
                    WELCOME_SIZE,
                )
            }),
        };
        set_frame(window, target);
        cx.notify();
    }

    /// The recent projects read off the UI thread, then the `welcome` screen opened on them (the
    /// screen already open keeps its state and reads them anew).
    pub(super) fn read_welcome_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = state_home(cx);
        let read = cx
            .background_executor()
            .spawn(async move { projects_param(state.as_deref()) });
        cx.spawn_in(window, async move |this, cx| {
            let projects = read.await;
            let _ = this.update(cx, |p, cx| {
                if p.welcome.is_none() {
                    return;
                }
                if let Some(view) = p.factory().cloned() {
                    view.update(cx, |v, cx| {
                        v.open_in(
                            Slot::Main,
                            WELCOME_SCREEN,
                            BTreeMap::from([("projects".to_owned(), projects)]),
                            cx,
                        );
                    });
                }
            });
        })
        .detach();
    }

    /// Welcome's Remove from list: the project leaves the recent list, the screen reads it anew.
    pub(in crate::shell) fn forget_project(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        crate::shell::recent::forget(state_home(cx).as_deref(), path);
        self.read_welcome_projects(window, cx);
    }

    /// The screen's word on Welcome (`welcome` effect): the Dock badge and the status bar's crumb.
    pub(in crate::shell) fn welcome_said(
        &mut self,
        needs_you: u32,
        crumb: String,
        page: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(w) = self.welcome.as_mut() else {
            return;
        };
        if w.needs_you != needs_you {
            native::badge(needs_you);
        }
        w.needs_you = needs_you;
        w.crumb = crumb;
        if let Some(page) = page {
            w.page = page;
        }
        cx.notify();
    }

    /// The page Welcome shows (`welcome` effect), the stripe's pick: `board` until told.
    pub fn welcome_page(&self) -> Option<&str> {
        self.welcome.as_ref().map(|w| w.page.as_str())
    }

    /// Clone… on Welcome: `git clone <url>` into `~/projects/<name>` off the UI thread (no
    /// prompt: a URL that needs one fails), its words on the status bar, then the project opened.
    /// A folder already there opens as it is.
    pub(in crate::shell) fn clone_project(
        &mut self,
        url: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let parent = cx
            .try_global::<ClonesDir>()
            .map(|d| d.0.clone())
            .unwrap_or_else(|| crate::shell::recent::home().join("projects"));
        let Some(dir) = clone_target(&parent, &url) else {
            self.welcome_note(format!("Nothing to clone in {url}"), cx);
            return;
        };
        let shown = crate::shell::recent::display_path(&dir);
        if dir.exists() {
            self.welcome_note(format!("{shown} is there already"), cx);
            self.open_or_tell(dir, window, cx);
            return;
        }
        self.welcome_note(format!("Cloning into {shown}…"), cx);
        let target = dir.clone();
        let run = cx.background_executor().spawn(async move {
            std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
            let out = std::process::Command::new("git")
                .args(["clone", "--quiet", "--", &url])
                .arg(&target)
                .env("GIT_TERMINAL_PROMPT", "0")
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                return Ok(());
            }
            let err = String::from_utf8_lossy(&out.stderr);
            Err(err
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("git clone failed")
                .trim()
                .to_string())
        });
        cx.spawn_in(window, async move |this, cx| {
            let done = run.await;
            let _ = this.update_in(cx, |p, window, cx| match done {
                Ok(()) => {
                    crate::app::line(&format!("welcome: cloned {}", dir.display()));
                    p.welcome_note(String::new(), cx);
                    p.open_or_tell(dir, window, cx);
                }
                Err(e) => p.welcome_note(format!("Couldn't clone: {e}"), cx),
            });
        })
        .detach();
    }

    /// Welcome's stripe: the bridge's items off a workspace, the page's item picked.
    fn welcome_stripe(&self, cx: &mut Context<Self>) -> AnyElement {
        let items = super::stripe::items(cx);
        let page = self.welcome.as_ref().map_or("board", |w| w.page.as_str());
        let shown = welcome_shown(&items, page);
        let me = cx.entity().downgrade();
        let el = stripe::render(
            &shown,
            move |id, _, window, cx| {
                let id = id.to_string();
                let _ = me.update(cx, |p, cx| p.welcome_stripe_click(&id, window, cx));
            },
            // the menu is Command mode's (Welcome has no project's popups): the screen's
            move |id, _, window, cx| {
                super::factory_click(format!("widget:stripe-at:{}", id.unwrap_or("")), window, cx)
            },
        );
        div()
            .debug_selector(|| "welcome-stripe".into())
            .absolute()
            .left_0()
            .top(px(look::TOOLBAR_HEIGHT.get()))
            .bottom(px(look::STATUS_BAR_HEIGHT.get()))
            .w(px(STRIPE_WIDTH))
            .child(el)
            .into_any_element()
    }

    /// A click on Welcome's stripe: ⋯ its menu (the screen's, in Command mode); the rest the
    /// screen's (`widget:stripe:<id>`: the page it shows).
    fn welcome_stripe_click(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if id == "more" {
            return super::factory_click("widget:stripe-at:".into(), window, cx);
        }
        super::factory_click(format!("widget:stripe:{id}"), window, cx);
        cx.notify();
    }

    /// The screen's `balloon` words on Welcome: on the status bar.
    pub(in crate::shell) fn welcome_note(&mut self, text: String, cx: &mut Context<Self>) {
        if let Some(w) = self.welcome.as_mut()
            && w.note != text
        {
            w.note = text;
            cx.notify();
        }
    }

    /// Open… (⌘O on Welcome) and New Project…: a folder picked (or named and made) in the
    /// system's panel, then opened as a project.
    pub(in crate::shell) fn pick_project(
        &mut self,
        new: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let picked = if new {
            let dir = crate::shell::recent::home().join("projects");
            let rx = cx.prompt_for_new_path(&dir, Some("untitled"));
            cx.background_executor()
                .spawn(async move { rx.await.ok().and_then(Result::ok).flatten() })
        } else {
            let rx = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
                files: false,
                directories: true,
                multiple: false,
                prompt: Some("Open".into()),
            });
            cx.background_executor().spawn(async move {
                rx.await
                    .ok()
                    .and_then(Result::ok)
                    .flatten()
                    .and_then(|p| p.into_iter().next())
            })
        };
        cx.spawn_in(window, async move |this, cx| {
            let Some(dir) = picked.await else {
                return;
            };
            if new {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    crate::app::line(&format!("new project {}: {e}", dir.display()));
                    return;
                }
                // a repo: a project the recent list finds again once it is closed
                let init = std::process::Command::new("git")
                    .arg("init")
                    .arg("-q")
                    .current_dir(&dir)
                    .status();
                if !init.is_ok_and(|s| s.success()) {
                    crate::app::line(&format!("new project {}: git init failed", dir.display()));
                }
            }
            let _ = this.update_in(cx, |p, window, cx| p.open_or_tell(dir, window, cx));
        })
        .detach();
    }

    /// A project opens on Welcome: Welcome's frame kept for next time, the project's put back,
    /// the Board's own screen back in the Factory view's place (hidden: the Editor shows).
    pub(super) fn leave_welcome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(w) = self.welcome.take() else {
            return;
        };
        crate::app::line("welcome: a project opened");
        save_frame(state_home(cx).as_deref(), current_frame(window));
        set_frame(window, w.project_frame);
        if w.needs_you != 0 {
            native::badge(0);
        }
        if let Some(view) = self.factory().cloned() {
            view.update(cx, |v, cx| {
                v.set_shown(false, cx);
                v.open_in(Slot::Main, FIRST_SCREEN, BTreeMap::new(), cx);
            });
        }
    }

    /// The window's keys on Welcome, before the screen's: ⌘Q quits, ⌘W closes the window, ⌘,
    /// Settings. True when taken.
    pub(super) fn welcome_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let k = &ev.keystroke;
        let m = k.modifiers;
        if !m.platform || m.control || m.alt || m.shift {
            return false;
        }
        match k.key.as_str() {
            "q" if !ev.is_held => {
                save_frame(state_home(cx).as_deref(), current_frame(window));
                crate::app::quitting("Quit VimStorm on Welcome");
                self.quitting = true;
                cx.quit();
                true
            }
            "q" => true,
            "w" => {
                save_frame(state_home(cx).as_deref(), current_frame(window));
                hide_welcome(window, cx);
                true
            }
            "o" if !ev.is_held => {
                self.pick_project(false, window, cx);
                true
            }
            _ => false,
        }
    }

    /// The window on Welcome: the toolbar's row (the lights, a drag area), the `welcome` screen,
    /// the status bar's `ABE · WELCOME`.
    pub(super) fn render_welcome(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let toolbar = look::TOOLBAR_HEIGHT.get();
        let status = look::STATUS_BAR_HEIGHT.get();
        let view = self.factory().cloned();
        if let Some(v) = &view {
            v.update(cx, |v, _| {
                v.chrome_height = toolbar + status;
                v.chrome_width = STRIPE_WIDTH;
                v.board_room = 0.;
            });
        }
        let stripe_el = self.welcome_stripe(cx);
        let gear = crate::shell::toolbar::settings_gear(cx);
        let focused = window.is_window_active();
        let said = |f: fn(&Welcome) -> &String| {
            self.welcome
                .as_ref()
                .map(|w| f(w).clone())
                .filter(|c| !c.is_empty())
        };
        let line = cx
            .try_global::<crate::factory::FactoryShell>()
            .and_then(|s| s.status.clone());
        let (crumb, note) = (said(|w| &w.crumb), line.or_else(|| said(|w| &w.note)));
        div()
            .id("projects")
            .debug_selector(|| "welcome".into())
            .relative()
            .size_full()
            .bg(crate::shell::layout::FRAME_BG)
            .capture_key_down(cx.listener(Self::on_key_down))
            .child(
                div()
                    .id("welcome-toolbar")
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(toolbar))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(look::UI_FONT_SIZE))
                    .text_color(if focused {
                        look::TEXT
                    } else {
                        look::STATUS_BAR_TEXT_INACTIVE
                    })
                    .child("Welcome to VimStorm")
                    .on_mouse_down(MouseButton::Left, |ev, window, _| {
                        if ev.click_count == 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    })
                    // Settings' gear at the right, as the toolbar's
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .right(px(look::TOOLBAR_RIGHT_PAD))
                            .flex()
                            .items_center()
                            .child(gear),
                    ),
            )
            .children(view.map(|v| {
                div()
                    .absolute()
                    .left(px(STRIPE_WIDTH))
                    .right_0()
                    .top(px(toolbar))
                    .bottom(px(status))
                    .child(v)
            }))
            .child(stripe_el)
            .child(
                div()
                    .debug_selector(|| "welcome-status".into())
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(status))
                    .bg(look::STATUS_BAR_BG)
                    .flex()
                    .items_center()
                    .px(px(look::STATUS_BAR_WIDGET_PAD_X))
                    .text_size(px(look::UI_SMALL_FONT_SIZE))
                    .text_color(look::STATUS_BAR_TEXT)
                    .child(crate::editor::statusbar::mode_segment(
                        SharedString::from("ABE · WELCOME"),
                        "Normal",
                    ))
                    .children(crumb.map(|c| {
                        div()
                            .debug_selector(|| "welcome-crumb".into())
                            .pl(px(look::STATUS_BAR_WIDGET_PAD_X))
                            .child(SharedString::from(c))
                    }))
                    .children(note.map(|n| {
                        div()
                            .debug_selector(|| "welcome-note".into())
                            .ml_auto()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(SharedString::from(n))
                    })),
            )
            .into_any_element()
    }
}

/// The window closed on Welcome: the app hides and stays up (Dock, menu bar); a Dock click or a
/// path handed over shows it again at Welcome's frame. Only a real AppKit window hides (tests'
/// windows have none).
fn hide_welcome(window: &Window, cx: &mut gpui_kit::App) {
    crate::app::line("welcome: the window closed, the app stays");
    if native::current(window).is_some() {
        cx.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Frame = Frame {
        x: 0.,
        y: 0.,
        w: 1728.,
        h: 1080.,
    };

    const fn frame(x: f64, y: f64, w: f64, h: f64) -> Frame {
        Frame { x, y, w, h }
    }

    const SAVED: Frame = frame(40., 60., 900., 600.);
    const SMALL: Frame = frame(0., 0., 800., 600.);
    const CENTRED: Frame = frame(364., 200., 1000., 680.);

    /// (name, saved frame, the screen, where Welcome goes)
    const FRAMES: &[(&str, Option<Frame>, Frame, Frame)] = &[
        ("the first time: 1000 by 680 centred", None, MAIN, CENTRED),
        ("a saved frame on a screen", Some(SAVED), MAIN, SAVED),
        (
            "a saved frame on no screen",
            Some(frame(5000., 60., 900., 600.)),
            MAIN,
            CENTRED,
        ),
        ("a small screen holds the whole frame", None, SMALL, SMALL),
    ];

    #[test]
    fn welcome_goes_to_its_saved_frame_while_on_a_screen_else_centred() {
        for (name, saved, screen, want) in FRAMES {
            assert_eq!(welcome_frame(*saved, &[*screen], *screen), *want, "{name}");
        }
    }

    #[test]
    fn clone_target_is_the_url_s_last_segment_without_git() {
        let p = Path::new("/home/me/projects");
        for (url, want) in [
            ("git@github.com:demo/demo-shop.git", Some("demo-shop")),
            ("https://github.com/demo/demo-shop", Some("demo-shop")),
            ("https://github.com/demo/demo-shop.git/", Some("demo-shop")),
            ("  /tmp/fixtures/grepo  ", Some("grepo")),
            ("git@host:shop.git", Some("shop")),
            ("/", None),
            ("..", None),
            (".git", None),
        ] {
            assert_eq!(clone_target(p, url), want.map(|n| p.join(n)), "{url}");
        }
    }

    #[test]
    fn the_frame_round_trips_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let f = Frame {
            x: 1.,
            y: 2.,
            w: 1000.,
            h: 680.,
        };
        save_frame(Some(tmp.path()), f);
        assert_eq!(load_frame(Some(tmp.path())), Some(f));
    }
}
