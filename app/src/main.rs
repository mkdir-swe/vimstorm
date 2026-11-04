//! `vimstorm [path]`: one window with the embedded nvim on `path` (a project dir or a file).
//! `VIMSTORM_LISTEN=<addr>`: nvim also listens there (`--listen`; tests, debugging).
//! `VIMSTORM_WINDOW_SIZE=<w>x<h>`: initial window size in logical px.
//! `VIMSTORM_BACKGROUND=1`: the window doesn't take focus / bring the app to the front.
//! No path from LaunchServices (Dock, Finder; cwd `/`): the paths AppKit hands over, else the
//! projects open at the last quit (`workspace::projects::SavedSet`).

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use futures::channel::mpsc;
use futures::future::{Either, select};
use gpui_kit::{
    App, AppContext as _, Bounds, TitlebarOptions, WindowBounds, WindowOptions, point, px, size,
};
use vimstorm::nvim::{Nvim, NvimConfig, NvimEvent, QUIT_TIMEOUT};
use vimstorm::shell::TOOLBAR_HEIGHT;
use vimstorm::shell::projects::{Projects, Start, launch_start};
use vimstorm::shell::toolbar::{Launcher, OpenNvims};
use vimstorm::{app, render};

fn main() -> anyhow::Result<()> {
    // the cargo tests' one real page (src/factory/pages/probe.rs), before anything of the app
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some("--browser-probe") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(vimstorm::factory::pages::run_probe(&args));
    }
    // a driven app (`VIMSTORM_DRIVE`) is an offscreen shot: before anything reads VIMSTORM_SHOT
    #[cfg(feature = "shots")]
    vimstorm::devtools::prepare();
    // `--remote <path>` (the `vimstorm` script): hands the path to a running app and exits
    if let Some(code) = app::remote_main() {
        std::process::exit(code);
    }
    // the app from here: what it prints and why it exits go to its log
    app::init_log();
    if let Err(e) = app_main() {
        app::launch_failed(&e);
        std::process::exit(1);
    }
    Ok(())
}

/// The app.
fn app_main() -> anyhow::Result<()> {
    // a Dock / Finder launch has no locale: nvim and the terminal's shells inherit this one
    if let Some(lang) = app::locale_fallback(|k| std::env::var(k).ok()) {
        // SAFETY: first thing in main, before any thread exists that could read the env.
        unsafe { std::env::set_var("LANG", lang) };
    }
    #[cfg(feature = "shots")]
    vimstorm::devtools::isolate_state();
    app::start_timing();
    app::mark("process start");

    // single instance (src/app/instance.rs): a running app takes the path and this process exits
    let arg = app::launch_args(&std::env::args_os().collect::<Vec<_>>());
    let server = match app::startup(arg.as_deref()) {
        app::Startup::Exit(code) => {
            // (a shell run said so itself, or the hand-off is what it asked for)
            if !app::stderr_is_tty() {
                app::quitting(match code {
                    0 => "the running VimStorm took the launch (single instance)".to_owned(),
                    _ => format!("the running VimStorm refused the launch (exit {code})"),
                });
            }
            std::process::exit(code)
        }
        app::Startup::App(server) => server,
    };
    app::mark("single instance checked");

    // A launch without a path from LaunchServices (Dock, Finder, `open -a VimStorm`: cwd `/`)
    // waits for the paths AppKit delivers (`open -a VimStorm <dir>`) before it starts anything,
    // then opens those, else reopens the projects open at the last quit. A bare `vimstorm` in a
    // shell opens the cwd, like `nvim` (and hands it to a running app).
    let launch_services =
        arg.is_none() && std::env::current_dir().is_ok_and(|d| d == std::path::Path::new("/"));
    let mut template = NvimConfig::new(std::env::current_dir().unwrap_or_default())?;
    if let Some(addr) = std::env::var_os("VIMSTORM_LISTEN") {
        template.args = vec!["--listen".into(), addr.to_string_lossy().into_owned()];
    }
    let nvims = OpenNvims::default();
    // with a path, nvim boots while GPUI starts; it waits for nvim_ui_attach before sourcing the
    // config
    let early = if launch_services {
        None
    } else {
        // project = the dir (or a file's git work tree / dir, opening the file)
        let (project, file) = app::startup_project(arg.as_deref()).context("project path")?;
        Some(start_first(&template, &nvims, Start::One(project, file))?)
    };
    quit_on_signals(nvims.clone())?;

    let app = gpui_kit::application();
    // `open -a VimStorm <path>`, Finder "Open With", dock drops, dock click
    let inbox = app::platform_hooks(&app);
    let mut server = server;
    let mut inbox = Some(inbox);
    let mut early = early;
    app.run(move |cx| {
        app::mark("GPUI app running");
        // Any app quit (AppKit terminate, cx.quit) saves all and quits every project's nvim
        // first, in parallel; a no-op for those already gone (the last project's nvim exiting is
        // what quit the app). Blocking is fine here: GPUI is shutting down.
        let quitting = nvims.clone();
        cx.on_app_quit(move |_| {
            // the one exit line: the reason the app gave, else macOS's (Dock Quit, logout)
            app::quit_asked();
            let _ = quitting.quit_all(QUIT_TIMEOUT);
            async {}
        })
        .detach();
        cx.set_global(Launcher {
            template: template.clone(),
            nvims: nvims.clone(),
            on_event: Some(Arc::new(|ev| {
                if matches!(ev, NvimEvent::Redraw(_)) {
                    app::redraw_received();
                }
            })),
            on_open: None,
        });
        // No gpui_kit::init (components / theme, ~150 ms): the editor draws no components. Later milestones
        // that do should init after the first frame.
        if let Err(e) = render::load_fonts(cx) {
            eprintln!("[vimstorm] loading fonts: {e:#}");
        }
        render::warm_up(cx);
        app::mark("fonts loaded");
        vimstorm::app::init_menu(cx);
        let server = server.take();
        let Some(mut inbox) = inbox.take() else {
            return;
        };
        if let Some(first) = early.take() {
            open_window(first, cx);
            serve(server, inbox, Vec::new(), cx);
            return;
        }
        // AppKit hands launch documents over around didFinishLaunching: take what came, else
        // wait a moment for it
        let (template, nvims) = (template.clone(), nvims.clone());
        cx.spawn(async move |cx| {
            let mut paths = inbox.drain();
            if paths.is_empty() {
                let wait = cx.background_executor().timer(LAUNCH_URLS_WAIT);
                if let Either::Left((Some(p), _)) = select(Box::pin(inbox.next()), wait).await {
                    paths = p;
                }
            }
            app::mark("launch paths checked");
            // (disk + git: off the UI thread)
            let first = (!paths.is_empty()).then(|| paths.remove(0));
            let welcome = cx.update(|cx| vimstorm::factory::BridgeCommand::available(cx));
            let start = cx
                .background_executor()
                .spawn(async move { launch_start(first, None, welcome) })
                .await;
            cx.update(|cx| match start_first(&template, &nvims, start) {
                Ok(first) => {
                    open_window(first, cx);
                    serve(server, inbox, paths, cx);
                }
                Err(e) => {
                    app::launch_failed(&e.context("starting nvim"));
                    cx.quit();
                }
            });
        })
        .detach();
    });
    Ok(())
}

/// How long a LaunchServices launch without a path waits for the paths AppKit delivers
/// (`open -a VimStorm <dir>`) before reopening the last projects.
const LAUNCH_URLS_WAIT: Duration = Duration::from_millis(50);

/// The first project's running nvim (and what the window shows); none on Welcome.
struct First {
    nvim: Option<(Nvim, mpsc::UnboundedReceiver<NvimEvent>)>,
    start: Start,
}

/// Starts the nvim of the project shown first (`template` + its dir and file).
fn start_first(template: &NvimConfig, nvims: &OpenNvims, start: Start) -> anyhow::Result<First> {
    let (dir, file) = match &start {
        Start::One(dir, file) => (dir.clone(), file.clone()),
        Start::Restore(set) => (
            set.active.clone().unwrap_or_else(|| set.open[0].clone()),
            None,
        ),
        Start::Welcome => return Ok(First { nvim: None, start }),
    };
    let mut cfg = template.clone();
    cfg.project = dir.clone();
    cfg.args.extend(file.map(|f| f.display().to_string()));
    let (tx, events) = mpsc::unbounded();
    let mut nvim = Nvim::start(&cfg, move |ev| {
        if matches!(ev, NvimEvent::Redraw(_)) {
            app::redraw_received();
        }
        let _ = tx.unbounded_send(ev);
    })?;
    app::mark("nvim spawned");
    // nvim sources its config only once a UI is attached: now, at the size the window will have
    // (the transparent titlebar: content = the whole window), not when the window exists
    let (w, h) = window_size();
    vimstorm::editor::attach_early(&mut nvim, size(px(w), px(h)));
    // every open project's nvim, saved and quit on exit (the window adds / removes projects)
    nvims.insert(dir, nvim.quitter());
    Ok(First {
        nvim: Some((nvim, events)),
        start,
    })
}

/// The projects window around the first project.
fn open_window(first: First, cx: &mut App) {
    // Abe 2.0's bridge from the start: the Editor's `Factory ◆ N`
    cx.set_global(vimstorm::factory::FollowAtLaunch);
    // Chat's parts glide where they move by themselves (2.2 re-feel)
    vimstorm::factory::enable_glides(cx);
    let (w, h) = window_size();
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(w), px(h)),
            cx,
        ))),
        // the main toolbar is the titlebar (WebStorm New UI): traffic lights inside it,
        // vertically centered; the toolbar's empty area moves the window
        titlebar: Some(TitlebarOptions {
            title: Some("VimStorm".into()),
            appears_transparent: true,
            // x 13: WebStorm's (measured)
            traffic_light_position: Some(point(px(13.), px((TOOLBAR_HEIGHT - 16.) / 2.))),
        }),
        app_owns_titlebar_drag: true,
        focus: !background(),
        // offscreen shots (`--features shots`) never show the window: nothing appears under the
        // user's mouse / over their work; the shot draws the scene itself
        show: !shot(),
        ..Default::default()
    };
    let mut first = Some(first);
    let opened = cx.open_window(options, |window, cx| {
        let First { nvim, start } = first.take().expect("open_window builds the root view once");
        cx.new(|cx| match (start, nvim) {
            (Start::One(dir, _), Some((nvim, events))) => {
                Projects::launched(nvim, events, dir, window, cx)
            }
            (Start::Restore(set), Some((nvim, events))) => {
                Projects::restore(nvim, events, set, window, cx)
            }
            _ => Projects::welcome(window, cx),
        })
    });
    if let Err(e) = opened {
        app::launch_failed(&e.context("opening the window"));
        cx.quit();
    }
    if !background() && !shot() {
        cx.activate(true);
    }
}

/// An offscreen shot run (`--features shots`, `VIMSTORM_SHOT`).
fn shot() -> bool {
    cfg!(feature = "shots") && std::env::var_os("VIMSTORM_SHOT").is_some()
}

/// `VIMSTORM_BACKGROUND=1`: the window opens without taking focus or bringing the app to the
/// front (tests / measurements running a real window while you work).
fn background() -> bool {
    std::env::var_os("VIMSTORM_BACKGROUND").is_some()
}

/// Paths handed over from now on (socket, platform; `queued`: launch paths after the first)
/// open in the window.
fn serve(
    server: Option<app::Server>,
    inbox: app::UrlInbox,
    queued: Vec<std::path::PathBuf>,
    cx: &mut App,
) {
    if let Some(server) = server {
        app::serve(server, cx);
    }
    cx.spawn(async move |cx| {
        for path in queued {
            match app::locate(path, cx).await {
                Ok((target, git)) => {
                    cx.update(|cx| app::open(app::Incoming::local(target, git), cx));
                }
                Err(e) => eprintln!("[vimstorm] open: {e}"),
            }
        }
    })
    .detach();
    inbox.serve(cx);
}

/// Initial window size: `VIMSTORM_WINDOW_SIZE=<w>x<h>` (logical px; same-size comparison shots
/// with WebStorm), else 1400x900.
fn window_size() -> (f32, f32) {
    std::env::var("VIMSTORM_WINDOW_SIZE")
        .ok()
        .and_then(|s| {
            let (w, h) = s.split_once('x')?;
            Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
        })
        .unwrap_or((1400.0, 900.0))
}

/// SIGTERM / SIGINT / SIGHUP (those not ignored at launch: `app::quit_signals`): save all
/// and quit every nvim on a watcher thread; the last one's exit then quits the app through the
/// window's event pump.
fn quit_on_signals(nvims: OpenNvims) -> anyhow::Result<()> {
    let mut signals = signal_hook::iterator::Signals::new(app::quit_signals())?;
    std::thread::Builder::new()
        .name("signals".into())
        .spawn(move || {
            let Some(sig) = signals.forever().next() else {
                return;
            };
            app::quitting(format!("signal {}", signal_name(sig)));
            // Welcome: no nvim whose exit quits the app, nothing to save
            if nvims.quit_all(QUIT_TIMEOUT) == 0 {
                std::process::exit(0);
            }
            // Fallback when the UI can't quit (no window yet, hung): exit as the signal would have.
            std::thread::sleep(Duration::from_secs(2));
            app::line("the window didn't quit within 2 s of the signal: exiting");
            std::process::exit(128 + sig);
        })?;
    Ok(())
}

/// `SIGTERM` for 15 (the quit signals; else the number).
fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGHUP => "SIGHUP".into(),
        n => format!("{n}"),
    }
}
