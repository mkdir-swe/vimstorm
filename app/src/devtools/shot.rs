//! Offscreen screenshots (`--features shots`), for milestone shots without Screen Recording
//! permission.

use std::time::Duration;

use gpui_kit::{
    Context, InputEvent as _, InputHandler as _, Modifiers, ScrollDelta, ScrollWheelEvent,
    TouchPhase, Window, point,
};

use crate::editor::EditorView;

/// A shot never touches the user's state: before anything starts, `VIMSTORM_SHOT` runs get their
/// own `XDG_STATE_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` under `VIMSTORM_SHOT_STATE=<dir>`
/// (default: a fresh `$TMPDIR/vimstorm-shot-<pid>`), so sessions and Recent Projects don't leak
/// into the user's lists or from one shot into the next. The data dir links the real app data
/// (plugins, parsers, Mason) minus `snacks/` (picker history), like the tests' `data_home`.
/// Call first thing in `main`, while the process has one thread.
pub fn isolate_state() {
    if std::env::var_os("VIMSTORM_SHOT").is_none() {
        return;
    }
    let root = std::env::var_os("VIMSTORM_SHOT_STATE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("vimstorm-shot-{}", std::process::id()))
        });
    let data = root.join("data");
    let links = data.join("vimstorm");
    let _ = std::fs::create_dir_all(&links);
    let _ = std::fs::create_dir_all(root.join("state"));
    let _ = std::fs::create_dir_all(root.join("cache"));
    if let Some(home) = std::env::var_os("HOME") {
        let real = std::path::Path::new(&home).join(".local/share/vimstorm");
        for entry in std::fs::read_dir(&real).into_iter().flatten().flatten() {
            let to = links.join(entry.file_name());
            if entry.file_name() != "snacks" && !to.exists() {
                let _ = std::os::unix::fs::symlink(entry.path(), to);
            }
        }
    }
    for (var, dir) in [
        ("VIMSTORM_CONFIG_HOME", root.join("config")),
        ("XDG_STATE_HOME", root.join("state")),
        ("XDG_CACHE_HOME", root.join("cache")),
        ("XDG_DATA_HOME", data),
    ] {
        // SAFETY: called at the top of main before any thread exists (no concurrent env access)
        unsafe { std::env::set_var(var, dir) };
    }
}

/// `--features shots`: `VIMSTORM_SHOT=<png>` renders the window offscreen once the screen is up
/// (+ `VIMSTORM_SHOT_DELAY_MS`, default 3000), optionally after typing `VIMSTORM_SHOT_KEYS`
/// (see [`Step`]: nvim keys, GPUI keystrokes, Lua, waits), then quits. `VIMSTORM_SHOT_PREEDIT=<text>`: IME marked text at the caret;
/// `VIMSTORM_SHOT_SCROLL_PX=<px>`: a trackpad scroll at the window's center just before the shot
/// (negative = fingers up), so the sub-row offset shows.
///
/// Film mode: `VIMSTORM_SHOT_FRAMES=<n>` with `VIMSTORM_SHOT_EVERY_MS=<ms>` (default 100) also
/// captures n frames, one every ms from the moment the keys start, while they play
/// (`<shot>-0001.png` …; the final shot waits for the last). `{shot:<label>}` in the keys takes
/// one frame `<shot>-<label>.png` there. `<shot>-frames.tsv` lists each frame's file, its ms since
/// the keys started and its label, and every step played with its ms (`step`), for a flipbook.
/// The hidden window draws only when a frame is taken (two draws each, as the final shot), so work
/// that waits for a frame runs at the film's pace, not 60 fps.
#[cfg(feature = "shots")]
pub fn schedule(window: &mut Window, cx: &mut Context<EditorView>) {
    // a driven app (`VIMSTORM_DRIVE`) is a shot that stays up and takes its steps over a socket
    if super::drive::socket().is_some() {
        let editor = cx.entity().downgrade();
        super::drive::schedule(window, cx, Some(editor), |v| v.ui().flushes > 0);
        return;
    }
    let Some(path) = std::env::var_os("VIMSTORM_SHOT") else {
        return;
    };
    let delay = std::env::var("VIMSTORM_SHOT_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let keys = std::env::var("VIMSTORM_SHOT_KEYS").ok();
    let preedit = std::env::var("VIMSTORM_SHOT_PREEDIT").ok();
    let scroll: Option<f32> = std::env::var("VIMSTORM_SHOT_SCROLL_PX")
        .ok()
        .and_then(|v| v.parse().ok());
    let film = Film::from_env(std::path::Path::new(&path));
    if let Some(bad) = keys
        .as_deref()
        .map(|k| unknown_keys(&steps(k)))
        .filter(|b| !b.is_empty())
    {
        eprintln!("[vimstorm] shot: {}", unknown_key_message(&bad));
        std::process::exit(2);
    }
    cx.spawn_in(window, async move |this, cx| {
        let exec = cx.background_executor().clone();
        let wait = |ms| exec.timer(Duration::from_millis(ms));
        let log = std::rc::Rc::new(std::cell::RefCell::new(FilmLog::default()));
        while this.update(cx, |v, _| v.ui().flushes == 0).unwrap_or(false) {
            wait(20).await;
        }
        let debug = std::env::var_os("VIMSTORM_SHOT_DEBUG").is_some();
        if debug {
            eprintln!("[vimstorm] shot: first flush");
        }
        wait(delay).await;
        if debug {
            eprintln!("[vimstorm] shot: delay over");
        }
        let start = std::time::Instant::now();
        // frames start with the keys, or at `{film}` when the keys have one
        let marked = keys
            .as_deref()
            .is_some_and(|k| steps(k).contains(&Step::Film));
        let mut reel = match &film {
            Some(film) if !marked => Some(roll(cx, film.clone(), log.clone(), start)),
            _ => None,
        };
        let mut pointer: Option<(f32, f32)> = None;
        if let Some(keys) = keys {
            for step in steps(&keys) {
                log.borrow_mut().step(&step, start.elapsed());
                match step {
                    Step::Shot(label) => {
                        let file = film_file(std::path::Path::new(&path), &label);
                        let at = start.elapsed();
                        if let Some(save) = capture(cx, &file, &exec, true).await {
                            log.borrow_mut().frame(&file, at, &label);
                            save.await;
                        }
                    }
                    Step::Film => {
                        if let (Some(film), None) = (&film, &reel) {
                            reel = Some(roll(cx, film.clone(), log.clone(), start));
                        }
                    }
                    step => play(step, Some(&this), cx, &mut pointer).await,
                }
            }
            wait(delay).await;
        }
        if let Some(reel) = reel {
            reel.await;
        }
        if film.is_some() || log.borrow().has_frames() {
            log.borrow().write(&film_list(std::path::Path::new(&path)));
        }
        if let Some(text) = preedit {
            let _ = this.update_in(cx, |v, window, cx| {
                let mut h = v.ime_handler();
                let end = text.encode_utf16().count();
                // the sink updates the view: run it outside this update
                window.defer(cx, move |window, cx| {
                    h.replace_and_mark_text_in_range(None, &text, Some(end..end), window, cx)
                });
            });
        }
        let _ = this.update_in(cx, |_, window, _| window.refresh());
        wait(100).await;
        if let Some(px) = scroll {
            let _ = this.update_in(cx, |_, window, cx| {
                let size = window.viewport_size();
                let event = ScrollWheelEvent {
                    position: point(size.width / 2., size.height / 2.),
                    delta: ScrollDelta::Pixels(point(gpui_kit::px(0.), gpui_kit::px(px))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                };
                window.defer(cx, move |window, cx| {
                    window.dispatch_event(event.to_platform_input(), cx);
                });
            });
            // nvim applies the steps; the settle animation starts only after 120 ms
            wait(60).await;
        }
        if std::env::var_os("VIMSTORM_SHOT_DEBUG").is_some() {
            let _ = this.update(cx, |v, _| {
                let g = v.geometry();
                eprintln!(
                    "[vimstorm] shot: {} islands, {} grids placed, screen {:?}, flushes {}",
                    g.layout.wins.len(),
                    g.places.len(),
                    v.ui().screen_size(),
                    v.ui().flushes
                );
            });
        }
        // Occluded windows get no frames. Two draws preserve measured layout; a bounded
        // opt-in warmup also lets asynchronous image decoding complete before visual QA.
        let frames = std::env::var("VIMSTORM_SHOT_WARM_FRAMES")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(2)
            .clamp(2, 16);
        for _ in 1..frames {
            let _ = cx.update(|window, cx| window.draw(cx).clear(cx));
            wait(50).await;
        }
        // a native page (BrowserView) is no part of GPUI's scene: WebKit's snapshot of it
        #[cfg(target_os = "macos")]
        let pages = crate::factory::pages::shown_snapshots().await;
        let _ = cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            let shot = window.render_to_image();
            #[cfg(target_os = "macos")]
            let shot = shot.map(|mut img| {
                overlay_pages(&mut img, &pages, window.scale_factor());
                img
            });
            match shot {
                Ok(img) => match img.save(&path) {
                    Ok(()) => eprintln!("[vimstorm] shot saved: {}", path.to_string_lossy()),
                    Err(e) => eprintln!("[vimstorm] saving shot: {e}"),
                },
                Err(e) => eprintln!("[vimstorm] render_to_image: {e:#}"),
            }
            cx.quit();
        });
    })
    .detach();
}

/// Plays one step of the keys and waits for it to land (each step's effects before the next:
/// nvim and the views answer async); `{shot:}` and `{film}` are the caller's (a no-op here).
/// `pointer`: where the mouse last went (a scroll goes there). The shot and the drive socket
/// (`super::drive`) both play keys through this.
#[cfg(feature = "shots")]
pub(crate) async fn play(
    step: Step,
    this: Option<&gpui_kit::WeakEntity<EditorView>>,
    cx: &mut gpui_kit::AsyncWindowContext,
    pointer: &mut Option<(f32, f32)>,
) {
    let exec = cx.background_executor().clone();
    let wait = |ms| exec.timer(Duration::from_millis(ms));
    match step {
        Step::Nvim(k) => {
            if let Some(v) = shown_editor(this, cx) {
                let _ = cx.update(|_, cx| v.read(cx).rpc().input(&k));
            }
        }
        Step::Lua(code) => {
            if let Some(v) = shown_editor(this, cx) {
                let _ = cx.update(|_, cx| v.read(cx).rpc().exec_lua(&code, Vec::new()));
            }
        }
        Step::Click(x, y) => {
            *pointer = Some((x, y));
            let _ = cx.update(|window, cx| mouse(window, cx, x, y, 1));
        }
        Step::DoubleClick(x, y) => {
            *pointer = Some((x, y));
            let _ = cx.update(|window, cx| mouse(window, cx, x, y, 2));
        }
        Step::Move(x, y) => {
            *pointer = Some((x, y));
            let _ = cx.update(|window, cx| mouse(window, cx, x, y, 0));
        }
        Step::Drag(x, y, x2, y2) => {
            // as a hand does it: pressed, the views answer (nvim takes a separator's press
            // async), the pointer moves there in steps, let go
            *pointer = Some((x2, y2));
            let _ = cx.update(|window, cx| press(window, cx, (x, y)));
            wait(DRAG_STEP_MS * 3).await;
            for i in 1..=DRAG_STEPS {
                let t = i as f32 / DRAG_STEPS as f32;
                let at = (x + (x2 - x) * t, y + (y2 - y) * t);
                let _ = cx.update(|window, cx| held_move(window, cx, at));
                wait(DRAG_STEP_MS).await;
            }
            wait(DRAG_STEP_MS * 3).await;
            let _ = cx.update(|window, cx| release(window, cx, (x2, y2)));
        }
        Step::Scroll(dx, dy) => {
            let at = *pointer;
            let _ = cx.update(|window, cx| {
                let size = window.viewport_size();
                let position = at
                    .map(|(x, y)| point(gpui_kit::px(x), gpui_kit::px(y)))
                    .unwrap_or(point(size.width / 2., size.height / 2.));
                let event = ScrollWheelEvent {
                    position,
                    delta: ScrollDelta::Pixels(point(gpui_kit::px(dx), gpui_kit::px(dy))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                };
                window.dispatch_event(event.to_platform_input(), cx);
            });
        }
        Step::Type(text) => {
            for c in text.chars() {
                let _ = cx.update(|window, cx| {
                    window.defer(cx, move |window, cx| typed_char(c, window, cx));
                });
                wait(GPUI_STEP_MS).await;
            }
            return;
        }
        Step::Wait(ms) => {
            wait(ms).await;
            return;
        }
        Step::Gpui(key) => {
            let _ = cx.update(|window, cx| {
                window.defer(cx, move |window, cx| gpui_key(&key, window, cx));
            });
            // short: two Shift taps must stay a double Shift
            wait(GPUI_STEP_MS).await;
            return;
        }
        Step::Shot(_) | Step::Film => return,
    }
    wait(STEP_MS).await;
}

/// The editor nvim keys and Lua go to: the shown project's, else the one the shot started on
/// (keys, text and the mouse go to the window, so they also reach Welcome, where no
/// project and no editor is left).
#[cfg(feature = "shots")]
fn shown_editor(
    this: Option<&gpui_kit::WeakEntity<EditorView>>,
    cx: &mut gpui_kit::AsyncWindowContext,
) -> Option<gpui_kit::Entity<EditorView>> {
    cx.update(|_, cx| {
        crate::shell::projects::active_workspace(cx)
            .map(|ws| ws.read(cx).editor().clone())
            .or_else(|| this.and_then(gpui_kit::WeakEntity::upgrade))
    })
    .ok()
    .flatten()
}

/// Each page's snapshot over its frame (points from the top left) in the shot.
#[cfg(all(feature = "shots", target_os = "macos"))]
fn overlay_pages(
    img: &mut image::RgbaImage,
    pages: &[crate::factory::pages::PageShot],
    scale: f32,
) {
    for ((x, y, w, h), png) in pages {
        let Ok(page) = image::load_from_memory(png) else {
            continue;
        };
        let s = f64::from(scale);
        let (pw, ph) = ((w * s).round() as u32, (h * s).round() as u32);
        if pw == 0 || ph == 0 {
            continue;
        }
        let page = image::imageops::resize(
            &page.to_rgba8(),
            pw,
            ph,
            image::imageops::FilterType::Triangle,
        );
        image::imageops::overlay(img, &page, (x * s).round() as i64, (y * s).round() as i64);
    }
}

/// Pause after each [`Step`] (a GPUI key: [`GPUI_STEP_MS`]; it lands at once).
#[cfg(feature = "shots")]
const STEP_MS: u64 = 400;
#[cfg(feature = "shots")]
const GPUI_STEP_MS: u64 = 60;

/// One part of `VIMSTORM_SHOT_KEYS`: plain text is nvim input (`nvim_input`, nvim notation);
/// `{@trigger}` a GPUI keystroke as the macOS backend reports it on the Swedish layout
/// (`{@super+o}`, `{@ctrl+tab}`; for Rust-owned keys: pickers, fields, the tree), `{@shift}` a
/// Shift tap (two = double Shift), `{@hold ctrl}` / `{@release}` modifiers held / let go;
/// `{lua:<code>:lua}` `nvim_exec_lua` (no typeahead: `<Cmd>…<CR>` lets a picker take the `<CR>`);
/// `{wait:<ms>}` a pause; the mouse: `{@click x,y}` (or `{click:x,y}`) a left click,
/// `{@dblclick x,y}` a double click (click counts 1 then 2), `{@drag x,y x2,y2}` the left button
/// pressed at x,y, moved to x2,y2 in steps and let go there (a text selected, a divider dragged), `{@move x,y}` the pointer
/// moved there (hover), `{@scroll dy}` / `{@scroll dy dx=<px>}` / `{@scroll dx,dy}` a trackpad scroll of dy
/// (and dx) px where the pointer last went (default the window's centre; negative = fingers up),
/// in logical px from the window's top left; `{type:<text>}` each char as a GPUI keystroke (text into a Rust-owned field
/// or the Factory view); `{shot:<label>}` one frame `<shot>-<label>.png` (film mode); `{film}`
/// where the film's frames start (default: with the first step).
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Nvim(String),
    Gpui(String),
    Lua(String),
    Wait(u64),
    Click(f32, f32),
    DoubleClick(f32, f32),
    /// From (x, y) to (x2, y2), the left button held.
    Drag(f32, f32, f32, f32),
    Move(f32, f32),
    /// (dx, dy)
    Scroll(f32, f32),
    Shot(String),
    Type(String),
    Film,
}

/// Splits `VIMSTORM_SHOT_KEYS` into [`Step`]s.
pub fn steps(keys: &str) -> Vec<Step> {
    let mut out = Vec::new();
    let mut rest = keys;
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<Step>| {
        if !text.is_empty() {
            out.push(Step::Nvim(std::mem::take(text)));
        }
    };
    while !rest.is_empty() {
        let (step, len) = if let Some(r) = rest.strip_prefix("{lua:") {
            match r.find(":lua}") {
                Some(end) => (Some(Step::Lua(r[..end].to_string())), 5 + end + 5),
                None => (None, 0),
            }
        } else if let Some((step, len)) = mouse_step(rest) {
            (Some(step), len)
        } else if let Some(r) = rest.strip_prefix("{shot:") {
            match r.find('}').filter(|&e| e > 0) {
                Some(end) => (Some(Step::Shot(r[..end].to_string())), 6 + end + 1),
                None => (None, 0),
            }
        } else if rest.starts_with("{film}") {
            (Some(Step::Film), 6)
        } else if let Some(r) = rest.strip_prefix("{type:") {
            match r.find('}') {
                Some(end) => (Some(Step::Type(r[..end].to_string())), 6 + end + 1),
                None => (None, 0),
            }
        } else if let Some(r) = rest.strip_prefix("{@") {
            match r.find('}') {
                Some(end) => (Some(Step::Gpui(r[..end].to_string())), 2 + end + 1),
                None => (None, 0),
            }
        } else if let Some(r) = rest.strip_prefix("{click:") {
            match r.find('}').and_then(|end| {
                let (x, y) = r[..end].split_once(',')?;
                Some((x.parse().ok()?, y.parse().ok()?, end))
            }) {
                Some((x, y, end)) => (Some(Step::Click(x, y)), 7 + end + 1),
                None => (None, 0),
            }
        } else if let Some(r) = rest.strip_prefix("{wait:") {
            match r.find('}').and_then(|e| Some((r[..e].parse().ok()?, e))) {
                Some((ms, end)) => (Some(Step::Wait(ms)), 6 + end + 1),
                None => (None, 0),
            }
        } else {
            (None, 0)
        };
        match step {
            Some(step) => {
                flush(&mut text, &mut out);
                out.push(step);
                rest = &rest[len..];
            }
            None => {
                let c = rest.chars().next().unwrap_or_default();
                text.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    flush(&mut text, &mut out);
    out
}

/// `{@click x,y}`, `{@dblclick x,y}`, `{@move x,y}`, `{@scroll …}` and the step's length in bytes.
fn mouse_step(rest: &str) -> Option<(Step, usize)> {
    let pair = |r: &str| -> Option<(f32, f32)> {
        let (x, y) = r.split_once(',')?;
        Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
    };
    // `dy`, `dy dx=<px>` or `dx,dy`
    let scroll = |r: &str| -> Option<Step> {
        if let Some((dx, dy)) = pair(r) {
            return Some(Step::Scroll(dx, dy));
        }
        let mut words = r.split_whitespace();
        let dy = words.next()?.parse().ok()?;
        let dx = match words.next() {
            Some(w) => w.strip_prefix("dx=")?.parse().ok()?,
            None => 0.,
        };
        words.next().is_none().then_some(Step::Scroll(dx, dy))
    };
    for (prefix, kind) in [
        ("{@click ", 0),
        ("{@move ", 1),
        ("{@scroll ", 2),
        ("{@dblclick ", 3),
        ("{@drag ", 4),
    ] {
        let Some(r) = rest.strip_prefix(prefix) else {
            continue;
        };
        let end = r.find('}')?;
        let arg = &r[..end];
        let step = match kind {
            0 => pair(arg).map(|(x, y)| Step::Click(x, y)),
            1 => pair(arg).map(|(x, y)| Step::Move(x, y)),
            2 => scroll(arg),
            3 => pair(arg).map(|(x, y)| Step::DoubleClick(x, y)),
            _ => arg.split_once(' ').and_then(|(a, b)| {
                let ((x, y), (x2, y2)) = (pair(a)?, pair(b.trim())?);
                Some(Step::Drag(x, y, x2, y2))
            }),
        }?;
        return Some((step, prefix.len() + end + 1));
    }
    None
}

/// Whether a `{@…}` step names something `gpui_key` can send: the modifier taps, a held
/// modifier, one char, or a key (with modifiers) on the Swedish layout.
pub fn gpui_key_known(key: &str) -> bool {
    const HELD: [&str; 5] = ["ctrl", "shift", "alt", "super", "cmd"];
    key == "shift"
        || key == "release"
        || key.strip_prefix("hold ").is_some_and(|m| HELD.contains(&m))
        || (key.chars().next().is_some() && key.chars().nth(1).is_none())
        || known_mods(key)
            .and_then(|k| crate::editor::input::keystroke(&k))
            .is_some()
}

/// What the shot refuses before it starts: the `{@…}` keys that name nothing (a typo like
/// `{@pagedown}` would otherwise be skipped and the film show a screen nobody drove).
pub fn unknown_keys(steps: &[Step]) -> Vec<String> {
    steps
        .iter()
        .filter_map(|s| match s {
            Step::Gpui(k) if !gpui_key_known(k) => Some(k.clone()),
            _ => None,
        })
        .collect()
}

/// What a refused `{@…}` key is told: the unknown names and the valid ones.
pub fn unknown_key_message(bad: &[String]) -> String {
    format!(
        "unknown key {{@{}}}; valid: {}, one plain char, f1..f12, hold ctrl|shift|alt|super|cmd, release, shift (taps), modifiers super+ ctrl+ alt+ shift+ (cmd+ opt+) before a key",
        bad.join("}, {@"),
        crate::editor::input::named_keys().join(", ")
    )
}

/// `VIMSTORM_SHOT_FRAMES` / `VIMSTORM_SHOT_EVERY_MS`: the frames a film takes and where.
#[derive(Clone, Debug, PartialEq)]
pub struct Film {
    pub frames: u32,
    pub every: u64,
    shot: std::path::PathBuf,
}

impl Film {
    #[cfg(feature = "shots")]
    fn from_env(shot: &std::path::Path) -> Option<Film> {
        Film::of(
            std::env::var("VIMSTORM_SHOT_FRAMES").ok().as_deref(),
            std::env::var("VIMSTORM_SHOT_EVERY_MS").ok().as_deref(),
            shot,
        )
    }

    /// None without a frame count above 0; every defaults to 100 ms, at least 10.
    pub fn of(frames: Option<&str>, every: Option<&str>, shot: &std::path::Path) -> Option<Film> {
        let frames = frames?.trim().parse::<u32>().ok().filter(|&n| n > 0)?;
        let every = every
            .and_then(|e| e.trim().parse::<u64>().ok())
            .unwrap_or(100)
            .max(10);
        Some(Film {
            frames,
            every,
            shot: shot.to_path_buf(),
        })
    }

    /// `<shot>-0001.png` for frame 1.
    pub fn frame(&self, n: u32) -> std::path::PathBuf {
        film_file(&self.shot, &format!("{n:04}"))
    }
}

/// `<dir>/<stem>-<label>.png` beside the shot `<dir>/<stem>.png` (a label's `/` and spaces as `_`).
pub fn film_file(shot: &std::path::Path, label: &str) -> std::path::PathBuf {
    let stem = shot.file_stem().unwrap_or_default().to_string_lossy();
    let label: String = label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    shot.with_file_name(format!("{stem}-{label}.png"))
}

/// `<dir>/<stem>-frames.tsv`.
pub fn film_list(shot: &std::path::Path) -> std::path::PathBuf {
    let stem = shot.file_stem().unwrap_or_default().to_string_lossy();
    shot.with_file_name(format!("{stem}-frames.tsv"))
}

/// What a film took and played, in order: `frame\t<file name>\t<ms>\t<label>` and
/// `step\t<ms>\t<step>` lines.
#[derive(Default, Debug)]
pub struct FilmLog {
    lines: Vec<String>,
    frames: usize,
}

impl FilmLog {
    pub fn frame(&mut self, file: &std::path::Path, at: Duration, label: &str) {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        self.frames += 1;
        self.lines
            .push(format!("frame\t{name}\t{}\t{label}", at.as_millis()));
    }

    pub fn step(&mut self, step: &Step, at: Duration) {
        let text = format!("{step:?}").replace(['\t', '\n'], " ");
        self.lines.push(format!("step\t{}\t{text}", at.as_millis()));
    }

    pub fn has_frames(&self) -> bool {
        self.frames > 0
    }

    pub fn text(&self) -> String {
        let mut out = self.lines.join("\n");
        out.push('\n');
        out
    }

    pub(crate) fn write(&self, to: &std::path::Path) {
        if let Err(e) = std::fs::write(to, self.text()) {
            eprintln!("[vimstorm] shot: writing {}: {e}", to.display());
        }
    }
}

/// Film's frames from now, one every `film.every` ms, each saved on a background thread; the
/// task ends once the last is on disk. Times in the log are from `keys` (the keys' start).
#[cfg(feature = "shots")]
pub(crate) fn roll(
    cx: &mut gpui_kit::AsyncWindowContext,
    film: Film,
    log: std::rc::Rc<std::cell::RefCell<FilmLog>>,
    keys: std::time::Instant,
) -> gpui_kit::Task<()> {
    let start = std::time::Instant::now();
    cx.spawn(async move |cx| {
        let exec = cx.background_executor().clone();
        let mut saves = Vec::new();
        for i in 0..film.frames {
            let at = Duration::from_millis(film.every * u64::from(i));
            if let Some(rest) = at.checked_sub(start.elapsed()) {
                exec.timer(rest).await;
            }
            let file = film.frame(i + 1);
            let taken = keys.elapsed();
            if let Some(save) = capture(cx, &file, &exec, false).await {
                log.borrow_mut().frame(&file, taken, "");
                saves.push(save);
            }
        }
        for save in saves {
            save.await;
        }
    })
}

/// Draws the window now and saves it to `file` on a background thread (the returned task).
/// `pages`: the shown BrowserViews' pages drawn in (WebKit's snapshots, which GPUI's render
/// cannot see; it takes a moment), for a single shot; a film's frames go without, at its pace.
#[cfg(feature = "shots")]
pub(crate) async fn capture(
    cx: &mut gpui_kit::AsyncWindowContext,
    file: &std::path::Path,
    exec: &gpui_kit::BackgroundExecutor,
    pages: bool,
) -> Option<gpui_kit::Task<()>> {
    #[cfg(target_os = "macos")]
    let pages = if pages {
        crate::factory::pages::shown_snapshots().await
    } else {
        Vec::new()
    };
    #[cfg(not(target_os = "macos"))]
    let _ = pages;
    let img = cx
        .update(|window, cx| {
            // two draws, as the final shot: the second lays out with the first's measurements
            window.draw(cx).clear(cx);
            window.draw(cx).clear(cx);
            let img = window.render_to_image();
            #[cfg(target_os = "macos")]
            let img = img.map(|mut img| {
                overlay_pages(&mut img, &pages, window.scale_factor());
                img
            });
            img
        })
        .ok()?;
    let img = match img {
        Ok(img) => img,
        Err(e) => {
            eprintln!("[vimstorm] render_to_image: {e:#}");
            return None;
        }
    };
    let file = file.to_path_buf();
    Some(exec.spawn(async move {
        match img.save(&file) {
            Ok(()) => eprintln!("[vimstorm] frame saved: {}", file.display()),
            Err(e) => eprintln!("[vimstorm] saving frame {}: {e}", file.display()),
        }
    }))
}

/// The pointer moved to (x, y), then `clicks` left clicks there (click counts 1, 2, …).
#[cfg(feature = "shots")]
fn mouse(window: &mut Window, cx: &mut gpui_kit::App, x: f32, y: f32, clicks: u8) {
    use gpui_kit::{MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent};
    let position = point(gpui_kit::px(x), gpui_kit::px(y));
    window.dispatch_event(
        MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }
        .to_platform_input(),
        cx,
    );
    for n in 1..=clicks {
        window.dispatch_event(
            MouseDownEvent {
                position,
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
                click_count: n as usize,
                first_mouse: false,
            }
            .to_platform_input(),
            cx,
        );
        window.dispatch_event(
            MouseUpEvent {
                position,
                button: MouseButton::Left,
                modifiers: Modifiers::default(),
                click_count: n as usize,
            }
            .to_platform_input(),
            cx,
        );
    }
}

/// A `{@drag}`'s moves with the button held, and the pause between them (ms).
#[cfg(feature = "shots")]
const DRAG_STEPS: u32 = 8;
#[cfg(feature = "shots")]
const DRAG_STEP_MS: u64 = 40;

#[cfg(feature = "shots")]
fn at((x, y): (f32, f32)) -> gpui_kit::Point<gpui_kit::Pixels> {
    point(gpui_kit::px(x), gpui_kit::px(y))
}

/// The pointer moved to `from`, the left button pressed there (a `{@drag}`'s start).
#[cfg(feature = "shots")]
fn press(window: &mut Window, cx: &mut gpui_kit::App, from: (f32, f32)) {
    use gpui_kit::{MouseButton, MouseDownEvent};
    mouse(window, cx, from.0, from.1, 0);
    window.dispatch_event(
        MouseDownEvent {
            position: at(from),
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }
        .to_platform_input(),
        cx,
    );
}

/// The pointer moved to `to` with the left button held.
#[cfg(feature = "shots")]
fn held_move(window: &mut Window, cx: &mut gpui_kit::App, to: (f32, f32)) {
    use gpui_kit::{MouseButton, MouseMoveEvent};
    window.dispatch_event(
        MouseMoveEvent {
            position: at(to),
            pressed_button: Some(MouseButton::Left),
            modifiers: Modifiers::default(),
        }
        .to_platform_input(),
        cx,
    );
}

/// The left button let go at `to`.
#[cfg(feature = "shots")]
fn release(window: &mut Window, cx: &mut gpui_kit::App, to: (f32, f32)) {
    use gpui_kit::{MouseButton, MouseUpEvent};
    window.dispatch_event(
        MouseUpEvent {
            position: at(to),
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: 1,
        }
        .to_platform_input(),
        cx,
    );
}

/// One typed char as the platform would send it: the layout's key when there is one, else the
/// char itself.
#[cfg(feature = "shots")]
fn typed_char(c: char, window: &mut Window, cx: &mut gpui_kit::App) {
    let s = c.to_string();
    let ks = crate::editor::input::typed(c)
        .and_then(|t| crate::editor::input::keystroke(&t))
        .unwrap_or(gpui_kit::Keystroke {
            modifiers: Modifiers::default(),
            key: s.clone(),
            key_char: Some(s),
        });
    window.dispatch_keystroke(ks, cx);
}

/// The trigger with `cmd` / `opt` / `option` as the layout's names, None with another modifier
/// (the layout's parser panics on one).
fn known_mods(key: &str) -> Option<String> {
    let (mods, last) = match key.strip_suffix("++") {
        Some(mods) => (mods, "+"),
        None if key == "+" => ("", "+"),
        None => key.rsplit_once('+').unwrap_or(("", key)),
    };
    let mut out = String::new();
    for m in mods.split('+').filter(|m| !m.is_empty()) {
        let m = match m {
            "cmd" => "super",
            "opt" | "option" => "alt",
            "super" | "ctrl" | "alt" | "shift" => m,
            _ => return None,
        };
        out.push_str(m);
        out.push('+');
    }
    out.push_str(last);
    Some(out)
}

/// Sends a `{@…}` step to the window as the platform would.
#[cfg(feature = "shots")]
fn gpui_key(key: &str, window: &mut Window, cx: &mut gpui_kit::App) {
    use gpui_kit::{Capslock, ModifiersChangedEvent};
    let mods = |window: &mut Window, cx: &mut gpui_kit::App, modifiers: Modifiers| {
        let ev = ModifiersChangedEvent {
            modifiers,
            capslock: Capslock { on: false },
        };
        window.dispatch_event(ev.to_platform_input(), cx);
    };
    let held = |name: &str| match name {
        "ctrl" => Some(Modifiers::control()),
        "shift" => Some(Modifiers::shift()),
        "alt" => Some(Modifiers::alt()),
        "super" | "cmd" => Some(Modifiers::command()),
        _ => None,
    };
    if key == "shift" {
        mods(window, cx, Modifiers::shift());
        mods(window, cx, Modifiers::default());
    } else if key == "release" {
        mods(window, cx, Modifiers::default());
    } else if let Some(m) = key.strip_prefix("hold ").and_then(held) {
        mods(window, cx, m);
    } else if let (Some(c), None) = (key.chars().next(), key.chars().nth(1)) {
        // one plain char (`{@:}`, `{@?}`, `{@K}`): the key that types it here
        typed_char(c, window, cx);
    } else if let Some(ks) = known_mods(key).and_then(|k| crate::editor::input::keystroke(&k)) {
        window.dispatch_keystroke(ks, cx);
    } else {
        eprintln!("[vimstorm] shot: unknown key {key}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Film, FilmLog, Step, film_file, film_list, gpui_key_known, known_mods, steps, unknown_keys,
    };
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn a_key_string_splits_into_its_steps() {
        let rows: &[(&str, &str, Vec<Step>)] = &[
            (
                "nvim keys, gpui keys, a wait and lua",
                "ihello<Esc>{@super+o}{wait:200}{lua:require('x').y({a=1}):lua}gg{",
                vec![
                    Step::Nvim("ihello<Esc>".into()),
                    Step::Gpui("super+o".into()),
                    Step::Wait(200),
                    Step::Lua("require('x').y({a=1})".into()),
                    Step::Nvim("gg{".into()),
                ],
            ),
            (
                "a key twice is two steps",
                "{@shift}{@shift}",
                vec![Step::Gpui("shift".into()), Step::Gpui("shift".into())],
            ),
            (
                "a wait without a number is nvim's",
                "a{wait:x}",
                vec![Step::Nvim("a{wait:x}".into())],
            ),
            (
                "mouse, shot, type and film steps",
                "{@click 120,40.5}{@move 3, 4}{@scroll -80}{shot:card up}{type:Hi /x}{film}k",
                vec![
                    Step::Click(120., 40.5),
                    Step::Move(3., 4.),
                    Step::Scroll(0., -80.),
                    Step::Shot("card up".into()),
                    Step::Type("Hi /x".into()),
                    Step::Film,
                    Step::Nvim("k".into()),
                ],
            ),
            ("the click: form", "{click:1,2}", vec![Step::Click(1., 2.)]),
            (
                "double click, drag and scroll forms",
                "{@dblclick 5,6}{@drag 1,2 30,4.5}{@scroll 10,-20}{@scroll -80 dx=30}{@scroll 7}",
                vec![
                    Step::DoubleClick(5., 6.),
                    Step::Drag(1., 2., 30., 4.5),
                    Step::Scroll(10., -20.),
                    Step::Scroll(30., -80.),
                    Step::Scroll(0., 7.),
                ],
            ),
            (
                "not a mouse step stays a gpui key, said unknown later",
                "{@click x}",
                vec![Step::Gpui("click x".into())],
            ),
            (
                "a shot without a name is nvim's",
                "{shot:}",
                vec![Step::Nvim("{shot:}".into())],
            ),
        ];
        for (name, keys, want) in rows {
            assert_eq!(&steps(keys), want, "{name}");
        }
    }

    const GPUI_KEYS: &[(&str, bool)] = &[
        ("tab", true),
        ("super+o", true),
        ("arrow_down", true),
        ("page_down", true),
        ("k", true),
        ("shift", true),
        ("hold ctrl", true),
        ("f5", true),
        ("cmd+opt+a", true),
        ("super++", true),
        ("+", true),
        ("down", false),
        ("pagedown", false),
        ("hold hyper", false),
        ("hyper+a", false),
        ("click x", false),
    ];

    #[test]
    fn unknown_gpui_keys_are_found_before_the_shot_starts() {
        for (key, known) in GPUI_KEYS {
            assert_eq!(gpui_key_known(key), *known, "{key}");
        }
        // cmd and opt are sent as super and alt
        assert_eq!(known_mods("cmd+opt+a").as_deref(), Some("super+alt+a"));
        assert_eq!(
            unknown_keys(&steps("{@tab}{@pagedown}ab{@down}{@k}")),
            ["pagedown", "down"]
        );
    }

    #[test]
    fn film_takes_its_frames_beside_the_shot() {
        let shot = Path::new("/qr/a/shots/board.png");
        assert_eq!(Film::of(None, Some("80"), shot), None);
        assert_eq!(Film::of(Some("0"), None, shot), None);
        let film = Film::of(Some("38"), Some("80"), shot).unwrap();
        assert_eq!((film.frames, film.every), (38, 80));
        assert_eq!(Film::of(Some("2"), None, shot).unwrap().every, 100);
        assert_eq!(Film::of(Some("2"), Some("1"), shot).unwrap().every, 10);
        assert_eq!(film.frame(7), Path::new("/qr/a/shots/board-0007.png"));
        assert_eq!(
            film_file(shot, "card up/2"),
            Path::new("/qr/a/shots/board-card_up_2.png")
        );
        assert_eq!(film_list(shot), Path::new("/qr/a/shots/board-frames.tsv"));
    }

    #[test]
    fn film_log_lists_frames_and_steps_in_order() {
        let mut log = FilmLog::default();
        assert!(!log.has_frames());
        log.step(&Step::Gpui("tab".into()), Duration::from_millis(5));
        log.frame(Path::new("/x/b-0001.png"), Duration::from_millis(81), "");
        log.frame(Path::new("/x/b-q.png"), Duration::from_millis(90), "q");
        assert!(log.has_frames());
        assert_eq!(
            log.text(),
            "step\t5\tGpui(\"tab\")\nframe\tb-0001.png\t81\t\nframe\tb-q.png\t90\tq\n"
        );
    }
}
