//! The shell-effect executor runs every `shell` frame the Factory's bridge sends, in one match.
//! The Factory view only decodes a frame and emits it, and [`Projects`] hands it here. This module
//! sets the globals the window shell holds (the status bar's [`FactoryShell`], the workspace feed,
//! the feel) and hands the Factory view back its own state. Opening and showing a project stay in
//! Projects. What Abe decided is applied as said; the only choices made here are the window's own,
//! such as what Welcome leaves out (ADR 0013).

use std::path::PathBuf;

use gpui_kit::{App, Context, Entity, Window};

use super::projects::{
    Projects, factory_click, open_file_at, open_review, search_everywhere_later,
};
use crate::factory::{
    AppAction, FactoryShell, FactoryView, Feel, ShellEffect, Slot, Tone, ViewName, WorkspaceFeed,
};
use crate::nvim::lua;
use crate::popups::{self, Balloon};

/// The status bar's state as the bridge last said it, changed by `f` (set only when it changed).
fn shell_state(cx: &mut App, f: impl FnOnce(&mut FactoryShell)) {
    let before = cx.try_global::<FactoryShell>().cloned().unwrap_or_default();
    let mut after = before.clone();
    f(&mut after);
    if after != before {
        cx.set_global(after);
    }
}

/// A global set only when it changed (its observers run once per real change).
fn set_changed<G: gpui_kit::Global + PartialEq>(value: G, cx: &mut App) {
    if cx.try_global::<G>() != Some(&value) {
        cx.set_global(value);
    }
}

/// Hands the Factory view the effects that change only its own state: a terminal dropped, Chat's session and the selected card. A test window with no Projects calls this too,
/// so the view gets them the same way there. Any other effect is not the view's, and it stays put.
pub fn give_back(view: &Entity<FactoryView>, effect: ShellEffect, cx: &mut App) {
    view.update(cx, |v, cx| match effect {
        ShellEffect::ChatSession { session } => v.set_chat_session(session, cx),
        ShellEffect::DropTerminal { key } => v.drop_terminal(&key, cx),
        ShellEffect::Selected { card, owner, title } => v.selected_said(card, owner, title, cx),
        ShellEffect::Clipboard { text } => {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text))
        }
        _ => {}
    });
}

/// Runs `effect` in the window `p` roots; `view` is the Factory view that sent it.
pub fn run(
    p: &mut Projects,
    view: &Entity<FactoryView>,
    effect: ShellEffect,
    window: &mut Window,
    cx: &mut Context<Projects>,
) {
    let welcome = p.on_welcome();
    match effect {
        // the Factory view's own state
        own @ (ShellEffect::ChatSession { .. }
        | ShellEffect::DropTerminal { .. }
        | ShellEffect::Selected { .. }
        | ShellEffect::Clipboard { .. }) => {
            if let ShellEffect::ChatSession { session } = &own {
                p.chat_said(session.as_deref(), cx);
            }
            give_back(view, own, cx)
        }
        // the status bar's, read by both views
        ShellEffect::Status { text } => {
            shell_state(cx, |s| s.status = (!text.is_empty()).then_some(text));
        }
        ShellEffect::Stripe { items, gear } => shell_state(cx, |s| {
            s.stripe = items;
            s.gear = gear;
        }),
        ShellEffect::StripeDot { dot } => shell_state(cx, |s| {
            if !s.stripe_dots.contains(&dot) {
                s.stripe_dots.retain(|b| b.id != dot.id);
                s.stripe_dots.push(dot);
            }
        }),
        ShellEffect::Widgets { widgets } => shell_state(cx, |s| s.widgets = widgets),
        ShellEffect::Workspaces {
            workspaces,
            factory,
            answering,
            abe_needs_you,
            prototypes,
        } => set_changed(
            WorkspaceFeed {
                workspaces,
                factory,
                answering,
                abe_needs_you,
                prototypes,
                bridge_down: false,
            },
            cx,
        ),
        // the tree and tabs read it; Projects observes it into every project's nvim
        ShellEffect::Feel { feel } => set_changed::<Feel>(feel, cx),
        // only a project opening leaves Welcome, since a view, a file, an Ex command or a pane
        // belongs to a project
        ShellEffect::View { .. }
        | ShellEffect::OpenFile { .. }
        | ShellEffect::Cmdline
        | ShellEffect::Ex { .. }
        | ShellEffect::EditorItem { .. }
        | ShellEffect::TerminalTab { .. }
        | ShellEffect::Show { .. }
        | ShellEffect::StripeOpen { .. }
        | ShellEffect::WorkspacePage { .. }
            if welcome => {}
        // Welcome has no project's popups, so its words go on the status bar
        ShellEffect::Balloon { text, .. } if welcome => p.welcome_note(text, cx),
        ShellEffect::View { view } => p.set_factory_shown(view == ViewName::Factory, window, cx),
        ShellEffect::OpenProject {
            path,
            attach,
            chat,
            card,
        } => p.open_from_bridge(PathBuf::from(path), attach, chat, card, window, cx),
        ShellEffect::OpenFile { path, line: None } => {
            p.open_in_shown(PathBuf::from(path), window, cx)
        }
        // a Chat diff card's ⏎ opens the file at the change, in the open workspace holding it or
        // else in its git work tree's
        ShellEffect::OpenFile {
            path,
            line: Some(line),
        } => {
            p.editor_now(window, cx);
            // real paths, as the open projects' folders and git's root are (`/tmp` →
            // `/private/tmp`); a file not there yet stays as given
            let given = PathBuf::from(path);
            let file = given.canonicalize().unwrap_or(given);
            let git = crate::app::git_root(&file);
            let dirs = p.dirs();
            // a file no workspace or git work tree holds (a subagent's transcript under
            // `~/.claude`) opens in the shown workspace, never as a workspace of its own folder
            let held = dirs.iter().any(|d| file.starts_with(d) && file != *d) || git.is_some();
            let dir = match p.shown_dir() {
                Some(shown) if !held => shown,
                _ => crate::app::project_for_file(&file, &dirs, git.as_deref()),
            };
            open_file_at(dir, file, line.max(1), window, cx);
        }
        ShellEffect::Show { place } => p.show_place(place, window, cx),
        ShellEffect::WorkspacePage {
            path,
            card,
            session,
            browse,
            page,
        } => {
            // a browse (a Sessions row the selection moved onto) moves nothing: Sessions is for
            // reading
            let _ = session;
            if let (false, Some(card)) = (browse, card) {
                let page = page.as_deref().and_then(super::projects::Page::parse);
                p.workspace_page(&PathBuf::from(path), card, page, window, cx);
            }
        }
        // Command mode's Go to: the place or page it names
        ShellEffect::StripeOpen { id } => p.open_place(&id, window, cx),
        ShellEffect::TerminalTab { argv, title } => p.terminal_tab(argv, title, window, cx),
        ShellEffect::Balloon {
            tone,
            text,
            key,
            stays,
            action,
            said_in,
        } => balloon(tone, text, key, stays, action, said_in, window, cx),
        // the moved repo's session goes with it: Recent Projects lists it where it is now
        ShellEffect::RepoMoved { from, to } => crate::shell::recent::moved(
            super::projects::state_home(cx).as_deref(),
            std::path::Path::new(&from),
            std::path::Path::new(&to),
        ),
        // its cause is gone, so it closes in whichever project shows it
        ShellEffect::DropBalloon { key } => {
            let id = format!("abe:{key}");
            for ws in p.workspaces() {
                let popups = ws.read(cx).popups().clone();
                popups.update(cx, |p, cx| p.hide_balloon(&id, cx));
            }
        }
        // a slot asks for the keyboard (Chat on a Sessions row, a launch, `:chat`), so the column
        // shows in this view on Chat with the keys
        ShellEffect::Focus { slot: Slot::Chat } => p.chat_keys(window, cx),
        ShellEffect::Focus { .. } => {}
        // Esc that a maximized Board's or Chat's screen did not take restores it, and the keys stay
        ShellEffect::Unhandled { slot, key }
            if key == "<Esc>" && p.factory_esc_unhandled(slot, cx) => {}
        // Esc that the Chat's screen did not take (no menu, card or pick of its own) gives the
        // keyboard back to the code
        ShellEffect::Unhandled {
            slot: Slot::Chat,
            key,
        } if key == "<Esc>" => {
            if let Some(ws) = p.active().cloned() {
                let column = ws.read(cx).column().clone();
                column.update(cx, |c, cx| c.esc_not_taken(window, cx));
            }
        }
        ShellEffect::Unhandled { .. } => {}
        ShellEffect::OpenUrl { url } => cx.open_url(&url),
        ShellEffect::OpenPrototype { id } => p.open_prototype(id, window, cx),
        ShellEffect::Expand => p.factory_expand(cx),
        ShellEffect::Look { look } => p.apply_look(look, cx),
        // the PR review's effects land in the Git window of the project under review
        ShellEffect::ShowDiff {
            root,
            files,
            index,
            base,
            head,
            line,
            pr,
        } => {
            if let Some(ws) = p.workspace_at(&root, cx) {
                let review = ws.read(cx).git().read(cx).review().clone();
                review.update(cx, |r, _| {
                    r.show_diff(root, files, index, base, head, line, pr)
                });
            }
        }
        ShellEffect::ReviewSaid { root, text, tone } => {
            if let Some(ws) = p.workspace_at(&root, cx) {
                let review = ws.read(cx).git().read(cx).review().clone();
                review.update(cx, |r, _| r.said(&text, tone));
            }
        }
        ShellEffect::PrPick { root, repo, rows } => {
            if let Some(ws) = p.workspace_at(&root, cx) {
                let log = ws.read(cx).git().read(cx).log().clone();
                log.update(cx, |l, cx| l.show_pr_pick(repo, rows, window, cx));
            }
        }
        ShellEffect::ReviewOpen {
            path,
            repo,
            number,
            unchecked,
        } => {
            let dir = PathBuf::from(&path);
            open_review(
                dir.clone(),
                crate::git::window::ReviewOpen {
                    repo,
                    number,
                    path: dir,
                    unchecked,
                },
                cx,
            );
        }
        // `Run in Neovim` puts the text on Neovim's own command line
        ShellEffect::Ex { text } => in_editor(p, "ex", vec![text.into()], window, cx),
        // a caret menu item chosen in `:` runs in Lua, in the Editor
        ShellEffect::EditorItem { index } => in_editor(p, "item", vec![index.into()], window, cx),
        // `::` opens Neovim's own command line, past the `:` map
        ShellEffect::Cmdline => in_editor(p, "cmdline", vec![], window, cx),
        ShellEffect::App { action } => match action {
            AppAction::SearchEverywhere => search_everywhere_later(cx),
            AppAction::RecentProjects => crate::app::replay_key("cmd-shift-o", cx),
            AppAction::Open => p.pick_project(false, window, cx),
            AppAction::NewProject => p.pick_project(true, window, cx),
            AppAction::Workflows => in_editor(p, "workflows", vec![], window, cx),
        },
        ShellEffect::ForgetProject { path } => {
            p.forget_project(std::path::Path::new(&path), window, cx)
        }
        ShellEffect::Welcome {
            needs_you,
            crumb,
            page,
        } => p.welcome_said(needs_you, crumb, page, cx),
        ShellEffect::CloneProject { url } => p.clone_project(url, window, cx),
    }
}

/// The Editor shown with the keyboard, then `colon.<f>(args)` run in its nvim.
fn in_editor(
    p: &mut Projects,
    f: &str,
    args: Vec<rmpv::Value>,
    window: &mut Window,
    cx: &mut Context<Projects>,
) {
    p.editor_now(window, cx);
    if let Some(ws) = p.active().cloned() {
        ws.update(cx, |w, cx| w.focus_editor(window, cx));
        lua::call(ws.read(cx).rpc(), "config.app.colon", f, args);
    }
}

/// Shows the bridge's balloon in the shown project.
#[allow(clippy::too_many_arguments)]
fn balloon(
    tone: Tone,
    text: String,
    key: Option<String>,
    stays: bool,
    action: Option<String>,
    said_in: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    let level = match tone {
        Tone::Info => popups::Level::Info,
        Tone::Warning => popups::Level::Warning,
        Tone::Error => popups::Level::Error,
    };
    // up as long as its words take to read (an error 8 s on top), one that needs you until
    // closed; the same key (else the same words) again replaces the one up, so nothing piles up
    let id = format!("abe:{}", key.as_deref().unwrap_or(&text));
    let timeout = if stays {
        None
    } else {
        popups::reading_time(level, "Abe", &text)
    };
    // its action goes to the bridge as a click on `balloon:<key>`
    let action = action.zip(key).map(|(label, key)| popups::BalloonAction {
        label: label.into(),
        run: std::rc::Rc::new(move |window: &mut Window, cx: &mut App| {
            factory_click(format!("balloon:{key}"), window, cx);
        }),
    });
    let source = said_in.map_or_else(|| "Abe".to_owned(), |w| format!("Abe · {w}"));
    popups::notify(
        Balloon {
            id: Some(id),
            timeout,
            action,
            source: Some(source.into()),
            ..Balloon::new(level, "Abe", text)
        },
        window,
        cx,
    );
}
