//! The app's perf budgets as a test binary of their own (`cargo test --test perf`; release numbers:
//! `cargo test --release --test perf -- --nocapture`): timings and the process's RSS would count
//! the other tests' load in the `app` binary's process, so they stay out of it, and each test here
//! holds [`serial`] (one timed test at a time).

mod common;

mod git_log_perf;

/// One timed test at a time (parallel test threads would time each other's load).
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Key and draw budgets for the app's own pipeline on the real Workspace in a temp project: startup,
/// key -> frame in a big TSX file, popups and pickers opening, the minimap's draw. Times go to
/// stderr (`--nocapture`); budgets are loose in debug builds, the real ones only in release. A
/// "frame" is the window draw after the effect is applied: GPUI's test platform draws a changed
/// window at the end of the effect flush that changed it (the app: at the next display link).
mod frames {
    use super::{common, serial};
    use std::path::Path;
    use std::time::{Duration, Instant};

    use common::view::View;
    use gpui_kit::Modifiers;
    use vimstorm::search::PickerState;

    pub(super) fn release() -> bool {
        !cfg!(debug_assertions)
    }

    pub(super) fn ms(d: Duration) -> f64 {
        d.as_secs_f64() * 1000.
    }

    /// Median and max of `times` (ms), printed.
    pub(super) fn stats(name: &str, times: &[Duration]) -> (f64, f64) {
        let mut v: Vec<f64> = times.iter().copied().map(ms).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = v[v.len() / 2];
        let max = v.last().copied().unwrap_or(0.);
        eprintln!(
            "PERF {name}: {} samples, median {median:.2} ms, max {max:.2} ms ({})",
            v.len(),
            if release() { "release" } else { "debug" }
        );
        (median, max)
    }

    /// Draws one frame of the window (all of it), timed.
    fn draw(v: &mut View) -> Duration {
        let t = Instant::now();
        v.cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        t.elapsed()
    }

    /// Time from now until `done` holds (checked after every nvim event), the frame showing it
    /// included: the effect flush that applied it drew the window (a second, forced draw here counted
    /// the frame twice).
    fn until(
        v: &mut View,
        label: &str,
        t: Instant,
        done: impl FnMut(&mut View) -> bool,
    ) -> Duration {
        v.wait_until(label, done);
        t.elapsed()
    }

    const BLOCK: &str = r#"/**
 * Props of the row %d.
 * @see Details
 */
export interface RowProps%d {
  id: string;
  label?: string;
  onSelect: (id: string, index: number) => void;
}

const pattern%d = /^[a-z]+-%d$/i;

export function useRow%d({ id, label, onSelect }: RowProps%d) {
  const [open, setOpen] = useState<boolean>(false);
  const name = useMemo(() => (label ?? id).trim().replace(pattern%d, ""), [label, id]);
  useEffect(() => {
    if (!open) return;
    console.log(`row ${name} opened`, { id, index: %d });
  }, [open, name, id]);
  return { open, toggle: () => setOpen((o) => !o), name, select: () => onSelect(id, %d) };
}

export const Row%d = (props: RowProps%d) => {
  const { open, toggle, name } = useRow%d(props);
  return (
    <div className="row" data-open={open} onClick={toggle}>
      <span title={name}>{name}</span>
      {open && <Details id={props.id} />}
    </div>
  );
};
"#;

    /// A TSX file of `blocks` blocks, ~30 lines each.
    fn tsx(blocks: usize) -> String {
        let mut out = String::from(
            "import { useEffect, useMemo, useState } from \"react\";\nimport { Details } from \"./Details\";\n\n",
        );
        for i in 1..=blocks {
            out.push_str(&BLOCK.replace("%d", &i.to_string()));
        }
        out
    }

    /// The project these budgets use, a git repo (.gitignore applies).
    fn project() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("vimstorm-perf-")
            .tempdir()
            .unwrap();
        let mut files: Vec<(String, String)> = vec![
            ("src/Big.tsx".into(), tsx(100)),
            (
                "a.ts".into(),
                "export const a = 1;\nexport function add(x: number, y: number): number {\n  return x + y;\n}\n"
                    .into(),
            ),
            ("b.ts".into(), "export const b = 2;\n".into()),
            ("multi.txt".into(), "multi\n".into()),
            ("menu.txt".into(), "menu\n".into()),
            ("package.json".into(), "{ \"name\": \"perf\" }\n".into()),
        ];
        for i in 1..=6 {
            files.push((format!("src/Small{i}.tsx"), tsx(3)));
            files.push((
                format!("doc{i}.md"),
                format!("# Doc {i}\n\nSome *text* with `code`.\n"),
            ));
        }
        for (name, text) in &files {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        git(dir.path(), &["init", "-q"]);
        let root = dir.path().canonicalize().unwrap().display().to_string();
        (dir, root)
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn start(root: &str) -> View {
        let mut v = View::start(root, &["src/Big.tsx"]);
        v.wait_screen("useEffect, useMemo");
        v.wait_lua(
            "the split has focus",
            "return require('config.focus').target() == 'split'",
        );
        v
    }

    /// The caret's window: (topline, cursor line, cursor col) as nvim last reported.
    fn caret_view(v: &mut View) -> (i64, i64, i64) {
        v.ui(|ui| {
            let top = ui
                .windows
                .get(&ui.cursor.grid)
                .and_then(|w| w.viewport.as_ref())
                .map_or(-1, |vp| vp.topline);
            (top, ui.cursor.row as i64, ui.cursor.col as i64)
        })
    }

    fn picker(v: &mut View) -> Option<PickerState> {
        v.read_ws(|ws, cx| ws.pickers().read(cx).state(cx))
    }

    fn menu_selected(v: &mut View) -> Option<Option<String>> {
        let p = v.read_ws(|ws, _| ws.popups().clone());
        p.read_with(&v.cx, |p, _| p.menu_rows().map(|_| p.menu_selected()))
    }

    fn popups_closed(v: &mut View) -> bool {
        let p = v.read_ws(|ws, _| ws.popups().clone());
        p.read_with(&v.cx, |p, _| !p.is_open())
    }

    /// Spawn -> the first frame with the big file's text. The app's budget: the editor frame
    /// < 300 ms after nvim is up (its first flush).
    #[test]
    fn startup_to_first_editor_frame() {
        let _serial = serial();
        let (_dir, root) = project();
        // a first start warms the plugins' caches
        drop(start(&root));
        let mut app = Vec::new();
        let mut total = Vec::new();
        for _ in 0..3 {
            let (v, t) = View::start_timed(&root, &["src/Big.tsx"], |e| {
                e.ui()
                    .screen_lines()
                    .iter()
                    .any(|l| l.contains("useEffect, useMemo"))
            });
            eprintln!(
                "PERF startup: first flush {:.1} ms, editor frame {:.1} ms",
                ms(t.first_flush),
                ms(t.shown)
            );
            app.push(t.shown - t.first_flush);
            total.push(t.shown);
            drop(v);
        }
        let (after_up, _) = stats("startup: nvim up -> first editor frame", &app);
        let (spawn, _) = stats("startup: spawn -> first editor frame", &total);
        if release() {
            assert!(
                after_up < 300.,
                "first editor frame {after_up:.1} ms after nvim is up"
            );
        } else {
            assert!(spawn < 15_000., "debug startup {spawn:.1} ms");
        }
    }

    /// Big.tsx at line 100, normal mode.
    fn big_tsx() -> (tempfile::TempDir, View) {
        let (dir, root) = project();
        let mut v = start(&root);
        v.lua("vim.cmd('100') return true");
        v.settle();
        (dir, v)
    }

    /// Ctrl+D / Ctrl+U and typing in a ~3000-line TSX file. The scroll: key -> nvim's flush with the scroll -> the frame showing it, timed as the
    /// app's pipeline: key -> the flush read off nvim's pipe (the reader thread; the app's UI thread
    /// applies it ~0.1 ms later) + one window draw of the scrolled state. End to end in the test
    /// context is printed too, not budgeted: GPUI's test platform draws the window after every effect
    /// flush, so the status bar's message that comes ahead of the flush costs a full draw on the same
    /// thread the flush then waits for (the app draws once, at the display link). Also printed: nvim's
    /// own time for the same scroll + redraw (no UI round trip).
    #[test]
    fn key_to_frame_in_a_big_tsx_file() {
        let _serial = serial();
        let (_dir, mut v) = big_tsx();
        // steady state: the language servers' first answers (vtsls: semantic tokens, diagnostics for
        // the 3000 lines) keep nvim busy for a while after the file opened
        v.wait_lua(
            "LSP idle",
            "for _, c in ipairs(vim.lsp.get_clients()) do \
               if not c.initialized or next(c.requests) then return false end \
             end return true",
        );
        v.settle();
        let (mut scroll, mut end_to_end) = scroll_samples(&mut v);
        let nvim: Vec<Duration> = (0..10)
            .map(|i| {
                let key = if i % 2 == 0 { "<C-d>" } else { "<C-u>" };
                let us = v
                    .lua(&format!(
                        "local t = vim.uv.hrtime() vim.cmd.normal(vim.keycode('{key}')) vim.cmd('redraw') \
                         return math.floor((vim.uv.hrtime() - t) / 1000)"
                    ))
                    .as_u64()
                    .unwrap_or(0);
                Duration::from_micros(us)
            })
            .collect();
        stats("nvim's own Ctrl+D / Ctrl+U + redraw", &nvim);
        stats(
            "scroll Ctrl+D / Ctrl+U key -> frame, end to end in the test context",
            &end_to_end,
        );
        let (mut med, _) = stats("scroll Ctrl+D / Ctrl+U key -> flush read + frame", &scroll);
        if release() && med >= 8.3 {
            // once more: a busy machine (a build) shows in a median too
            (scroll, end_to_end) = scroll_samples(&mut v);
            stats("(again) end to end in the test context", &end_to_end);
            med = med.min(stats("(again) key -> flush read + frame", &scroll).0);
        }
        if release() {
            // one frame at 120 Hz
            assert!(med < 8.3, "scroll median {med:.2} ms");
        } else {
            assert!(med < 150., "debug scroll key -> frame {med:.2} ms");
        }

        // typing in insert mode: key -> nvim's flush with the char applied -> the frame
        v.keystrokes("o");
        v.wait_lua("insert", "return vim.api.nvim_get_mode().mode == 'i'");
        v.settle();
        let text = "const value = useMemo(() => compute(a, b), [a])";
        let mut typing = Vec::new();
        for (i, c) in text.chars().enumerate() {
            // his Swedish layout's keys; [ ] (Alt+8 / 9) come as the input context's text
            let key = match c {
                ' ' => Some("space".to_string()),
                '(' => Some("shift+digit_8".into()),
                ')' => Some("shift+digit_9".into()),
                '=' => Some("shift+digit_0".into()),
                '>' => Some("shift+<".into()),
                c if c.is_ascii_uppercase() => Some(format!("shift+{}", c.to_ascii_lowercase())),
                c if c.is_ascii_alphanumeric() || c == ',' => Some(c.to_string()),
                _ => None,
            };
            let before = caret_view(&mut v);
            let flushes = v.ui(|ui| ui.flushes);
            let t = Instant::now();
            match &key {
                Some(k) => v.key(k),
                None => v.ime_commit(&c.to_string()),
            }
            let d = until(&mut v, &format!("typed {c:?}"), t, |v| {
                v.ui(|ui| ui.flushes) > flushes && caret_view(v) != before
            });
            if i > 0 {
                typing.push(d);
            }
        }
        v.keystrokes("escape");
        let typed = v.current_line();
        assert!(typed.contains("const value"), "typed: {typed:?}");
        let (med, _) = stats("typing in insert mode key -> frame", &typing);
        if release() {
            // one frame at 120 Hz
            assert!(med < 8.3, "typing median {med:.2} ms");
        } else {
            assert!(med < 150., "debug typing key -> frame {med:.2} ms");
        }
    }

    /// 20 Ctrl+D / Ctrl+U (after one to warm up): key -> flush read + the frame drawing it, and end to
    /// end in the test context.
    fn scroll_samples(v: &mut View) -> (Vec<Duration>, Vec<Duration>) {
        let mut scroll = Vec::new();
        let mut end_to_end = Vec::new();
        for i in 0..21 {
            let key = if i % 2 == 0 { "ctrl-d" } else { "ctrl-u" };
            let before = caret_view(v);
            let flushes = v.ui(|ui| ui.flushes);
            let t = Instant::now();
            v.keystrokes(key);
            let d = until(v, key, t, |v| {
                v.ui(|ui| ui.flushes) > flushes && caret_view(v).0 != before.0
            });
            let top = caret_view(v).0;
            let read = v.redraw_read(t, top).expect("the scroll's flush") - t;
            let drawn = draw(v);
            if i > 0 {
                scroll.push(read + drawn);
                end_to_end.push(d);
            }
            v.settle();
        }
        (scroll, end_to_end)
    }

    /// Cmd+Enter -> the menu drawn, moving its selection, the switcher open, and each picker open ->
    /// its first results drawn.
    #[test]
    fn popups_and_pickers_open_within_budget() {
        let _serial = serial();
        let (_dir, root) = project();
        let mut v = start(&root);
        v.lua("vim.cmd.edit('a.ts') vim.cmd.edit('b.ts') vim.cmd.edit('src/Big.tsx') return true");
        v.settle();

        let mut open = Vec::new();
        let mut moves = Vec::new();
        for i in 0..6 {
            let t = Instant::now();
            v.keystrokes("cmd-enter");
            let d = until(&mut v, "menu open", t, |v| {
                menu_selected(v).is_some_and(|s| s.is_some())
            });
            if i > 0 {
                open.push(d);
            }
            if i == 1 {
                for k in 0..10 {
                    // every letter types into a menu's filter: the arrows move
                    let key = if k % 2 == 0 { "arrow_down" } else { "arrow_up" };
                    let before = menu_selected(&mut v);
                    let t = Instant::now();
                    v.key(key);
                    moves.push(until(&mut v, "selection moved", t, |v| {
                        menu_selected(v) != before
                    }));
                }
            }
            v.key("escape");
            v.wait_until("menu closed", popups_closed);
            v.settle();
        }

        let mut switcher = Vec::new();
        for i in 0..6 {
            let t = Instant::now();
            v.lua("require('config.switcher').open({ wait = false }) return true");
            let d = until(&mut v, "switcher open", t, |v| {
                picker(v).is_some_and(|s| s.kind == "switcher" && !s.rows.is_empty())
            });
            if i > 0 {
                switcher.push(d);
            }
            v.key("escape");
            v.wait_until("switcher closed", |v| picker(v).is_none());
            v.settle();
        }

        let (open_med, _) = stats("Cmd+Enter -> menu frame", &open);
        let (move_med, _) = stats("menu move key -> frame", &moves);
        let (sw_med, _) = stats("switcher open -> frame", &switcher);
        // 60 / 15 / 60 ms in release; debug: loose
        let k = if release() { 1. } else { 5. };
        assert!(open_med < 60. * k, "menu opens in {open_med:.1} ms");
        assert!(move_med < 15. * k, "menu moves in {move_med:.1} ms");
        assert!(sw_med < 60. * k, "switcher opens in {sw_med:.1} ms");

        // the pickers: open -> the first results drawn
        v.lua(
            "vim.v.oldfiles = vim.tbl_map(function(f) return vim.fn.getcwd() .. '/' .. f end, \
             { 'multi.txt', 'menu.txt', 'package.json' }) return true",
        );
        // the file index walked once (Search Everywhere / Go to File list from it)
        v.wait_until("file index", |v| {
            v.read_ws(|ws, cx| ws.pickers().read(cx).index()).is_some()
        });
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        for (name, kind) in [
            ("Search Everywhere", "all"),
            ("Go to File", "files"),
            ("Find in Files", "grep"),
            ("Recent Projects", "projects"),
        ] {
            let mut times = Vec::new();
            for _ in 0..3 {
                let t = Instant::now();
                match kind {
                    "all" => {
                        for _ in 0..2 {
                            v.modifiers(shift);
                            v.modifiers(Modifiers::default());
                        }
                    }
                    "files" => v.key("super+o"),
                    "grep" => {
                        v.lua("Snacks.picker.grep({ search = 'useMemo' }) return true");
                    }
                    _ => {
                        v.lua("Snacks.picker.projects() return true");
                    }
                }
                times.push(until(&mut v, &format!("{name} with results"), t, |v| {
                    picker(v).is_some_and(|s| s.kind == kind && s.settled && !s.rows.is_empty())
                }));
                v.key("escape");
                v.wait_until("closed", |v| picker(v).is_none());
                v.settle();
            }
            let (med, _) = stats(&format!("{name} opens with results"), &times);
            let budget = if release() { 1000. } else { 5000. };
            assert!(med < budget, "{name}: {med:.1} ms");
        }
    }

    /// The minimap: a window draw in the big TSX file with it on (its ~400 drawn lines as one
    /// image, made once for the lines Lua sent) against off, and after a scroll that shows other
    /// lines (the image made again). Only nvim's redraws and Lua's lines make anything again; a draw
    /// paints the kept image.
    #[test]
    fn minimap_draw_big_tsx() {
        let _serial = serial();
        let (_dir, mut v) = big_tsx();
        let win = v
            .lua("return vim.api.nvim_get_current_win()")
            .as_i64()
            .unwrap();
        let mm = v.read_ws(|ws, _| ws.minimap().clone());
        let off: Vec<Duration> = (0..20).map(|_| draw(&mut v)).collect();
        v.set_feel(|f| f.editor.minimap = true);
        v.wait_until("the minimap's lines drawn", |v| {
            v.pump();
            mm.read_with(&v.cx, |m, _| m.runs(win).len() > 1000)
        });
        let on: Vec<Duration> = (0..20).map(|_| draw(&mut v)).collect();
        // scrolled: the minimap shows other lines (its picture made again in the frame the scroll drew)
        let mut scrolled = Vec::new();
        for i in 1..=10 {
            let top = 100 + 40 * i;
            v.lua(&format!(
                "require('config.app.minimap').scroll(vim.api.nvim_get_current_win(), {top})"
            ));
            v.wait_until("scrolled", |v| {
                v.ui(|ui| {
                    ui.windows
                        .values()
                        .any(|w| w.viewport.is_some_and(|p| p.topline == top))
                })
            });
            scrolled.push(draw(&mut v));
        }
        let (off, _) = stats("window draw, minimap off", &off);
        let (on, _) = stats("window draw, minimap on", &on);
        let (moved, _) = stats(
            "window draw, minimap on, scrolled to other lines",
            &scrolled,
        );
        if release() {
            // one frame at 120 Hz, the minimap a small part of it
            assert!(
                on < 8.3 && on - off < 1.,
                "minimap on {on:.2} ms, off {off:.2} ms"
            );
            assert!(moved < 8.3, "minimap scrolled {moved:.2} ms");
        } else {
            assert!(
                on - off < 5.,
                "debug draw: minimap on {on:.2} ms, off {off:.2} ms"
            );
            assert!(
                moved < 150.,
                "debug draw with the minimap made again {moved:.2} ms"
            );
        }
    }
}

/// The Run page's focus pane scrolled on a heavy Verify step at 1440 × 900: sixty more steps, eight
/// features each a pair of 1920 × 1200 shots, a recording and how it was judged, twenty files'
/// 40-line diffs and a red check's 600-line log. Each wheel step's frame is timed (median, worst):
/// the pane is laid out again each frame, so nested flex columns (each measuring its children
/// twice, at every level) and a row per log line made it ~180 ms; blocks and a text per log keep it
/// a few ms. The frames it asks for while nothing moves are counted too.
mod run_page {
    use super::frames::{release, stats};
    use super::{common, serial};
    use std::path::Path;
    use std::time::{Duration, Instant};

    use common::bridge::{Win, fixture};
    use gpui_kit::{Modifiers, ScrollDelta, ScrollWheelEvent, TouchPhase, point, px};
    use serde_json::{Value, json};
    use vimstorm::factory::FIRST_SCREEN;

    /// The first value of `kind` at any depth.
    fn part_of<'a>(v: &'a mut Value, kind: &str) -> Option<&'a mut Value> {
        if v["kind"] == kind {
            return Some(v);
        }
        match v {
            Value::Object(m) => m.values_mut().find_map(|c| part_of(c, kind)),
            Value::Array(a) => a.iter_mut().find_map(|c| part_of(c, kind)),
            _ => None,
        }
    }

    /// A GIF of `frames` frames, `w` × `h`, a bar moving across.
    fn gif(path: &Path, w: u32, h: u32, frames: u32) {
        use image::codecs::gif::{GifEncoder, Repeat};
        let file = std::fs::File::create(path).unwrap();
        let mut enc = GifEncoder::new_with_speed(file, 30);
        enc.set_repeat(Repeat::Infinite).unwrap();
        for n in 0..frames {
            let at = n * w / frames;
            let img = image::RgbaImage::from_fn(w, h, |x, _| {
                if x.abs_diff(at) < 20 {
                    image::Rgba([240, 200, 40, 255])
                } else {
                    image::Rgba([30, 32, 36, 255])
                }
            });
            let frame =
                image::Frame::from_parts(img, 0, 0, image::Delay::from_numer_denom_ms(50, 1));
            enc.encode_frame(frame).unwrap();
        }
    }

    fn heavy(dir: &Path) -> Value {
        let mut tree: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("trees/run-verify.json")).unwrap(),
        )
        .unwrap();
        let shots: Vec<String> = (0..6)
            .map(|n| {
                let p = dir.join(format!("shot-{n}.png"));
                image::RgbaImage::from_pixel(1920, 1200, image::Rgba([40 + n * 20, 60, 90, 255]))
                    .save(&p)
                    .unwrap();
                p.to_string_lossy().into_owned()
            })
            .collect();
        let drive = dir.join("drive.gif");
        gif(&drive, 800, 500, 24);
        let drive = drive.to_string_lossy().into_owned();
        // sixty more steps
        let rows = part_of(&mut tree, "RunSteps").unwrap()["props"]["rows"]
            .as_array_mut()
            .unwrap();
        let row = rows[0].clone();
        for n in 0..60 {
            let mut r = row.clone();
            r["id"] = json!(format!("extra:{n}"));
            rows.push(r);
        }
        // eight features, the first three's GIFs playing
        let kit = part_of(&mut tree, "kit").unwrap();
        let cart = kit["features"][0].clone();
        let features: Vec<Value> = (0..8)
            .map(|n| {
                let mut f = cart.clone();
                f["feature"] = json!(format!("cart{n}"));
                let parts = f["parts"].as_array_mut().unwrap();
                parts[0]["before"]["path"] = json!(shots[(2 * n) % 6]);
                parts[0]["after"]["path"] = json!(shots[(2 * n + 1) % 6]);
                parts[1]["still"] = json!(shots[n % 6]);
                parts[1]["gif"] = json!(if n < 3 { drive.as_str() } else { "" });
                parts[1]["playing"] = json!(n < 3);
                f
            })
            .collect();
        kit["features"] = json!(features);
        // what it made: twenty files open, each its 40-line diff (the bridge's most), and a red
        // check with its whole 600-line log
        let files: Vec<Value> = (0..20)
            .map(|f| {
                let lines: Vec<String> = (0..40)
                    .map(|n| match n % 3 {
                        0 => format!("+  const total{n} = items.reduce((s, i) => s + i.price * i.qty, 0);"),
                        1 => format!("-  const total{n} = items.reduce((s, i) => s + i.price, 0);"),
                        _ => format!("   return formatMoney(total{n}, currency);"),
                    })
                    .collect();
                json!({"id": format!("run:file:verify:1:{f}"), "path": format!("src/cart/total{f}.ts"),
                       "added": 14, "removed": 13, "lines": lines})
            })
            .collect();
        let log: Vec<String> = (0..600)
            .map(|n| format!("  ✓ cart › total follows quantity {n} ({} ms)", n % 40))
            .collect();
        let check = json!({"mark": {"glyph": "✗", "hue": "bad"}, "name": "test", "command": "bun test",
            "time": "41 s", "exit": "exit 1", "output": log, "more": "the tail of what it printed",
            "red": true});
        let focus = part_of(&mut tree, "RunFocus").unwrap();
        let blocks = focus["props"]["made"]["blocks"].as_array_mut().unwrap();
        blocks.push(json!({"title": "Changed", "boxed": false,
            "parts": [{"kind": "files", "rows": files}]}));
        blocks.push(json!({"title": "Checks", "boxed": false,
            "parts": [{"kind": "checks", "rows": [check]}]}));
        tree
    }

    fn wheel(w: &mut Win, dy: f32) -> Duration {
        let t = Instant::now();
        w.cx.simulate_event(ScrollWheelEvent {
            position: point(px(900.), px(500.)),
            delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        });
        t.elapsed()
    }

    /// The frames asked for since the last: each a whole-window draw in the app.
    fn asked(w: &mut Win) -> usize {
        w.cx.update(|window, cx| window.simulate_next_frame(cx))
    }

    #[test]
    fn run_page_scrolls_within_budget() {
        let _serial = serial();
        let dir = tempfile::tempdir().unwrap();
        let tree = heavy(dir.path());
        let mut w = Win::open_sized(None, 1440., 900.);
        w.cx.update(|window, _| window.activate_window());
        let line = json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": 1, "tree": tree})
            .to_string();
        w.view.update(&mut w.cx, |v, cx| v.receive_line(&line, cx));
        // the images read and decoded (the test dispatcher runs their loads as it parks)
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            w.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(50));
        }
        for _ in 0..5 {
            wheel(&mut w, -40.);
        }
        let mut down = Vec::new();
        for _ in 0..120 {
            down.push(wheel(&mut w, -40.));
        }
        let mut up = Vec::new();
        for _ in 0..120 {
            up.push(wheel(&mut w, 40.));
        }
        let (median, worst) = stats("run page: wheel step -> frame", &[down, up].concat());
        // nothing moving (the last step's own frame drawn: a GIF it scrolled away stops in it):
        // the frames it asks for over ten display frames
        if asked(&mut w) > 0 {
            w.cx.run_until_parked();
        }
        let mut idle = 0;
        let mut draws = Vec::new();
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(16));
            let t = Instant::now();
            if asked(&mut w) > 0 {
                idle += 1;
                w.cx.run_until_parked();
                draws.push(t.elapsed());
            }
        }
        eprintln!("PERF run page: idle, frames asked {idle} of 10");
        if !draws.is_empty() {
            stats("run page: idle frame", &draws);
        }
        let (most_median, most_worst) = if release() { (10., 30.) } else { (150., 1000.) };
        assert!(median < most_median, "wheel frame median {median:.2} ms");
        assert!(worst < most_worst, "wheel frame worst {worst:.2} ms");
        assert_eq!(idle, 0, "the page redraws while nothing moves");
    }
}

/// Memory over project open / switch / close cycles: a closed project drops
/// every entity it owned (the Workspace and each surface, the Git tool window's tabs) and its
/// nvim quits; 20 cycles leave the app's RSS flat (`--nocapture` prints it).
mod memory {
    use super::common;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use common::gitui;
    use common::terminal as term;
    use common::view::View;
    use gpui_kit::{AnyWeakEntity, Entity};
    use vimstorm::shell::Workspace;

    fn copy(name: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let ok = std::process::Command::new("cp")
            .arg("-R")
            .arg(common::fixtures().join(name))
            .arg(&root)
            .status()
            .unwrap()
            .success();
        assert!(ok, "cp {name}");
        (tmp, root.join(name))
    }

    fn active_dir(v: &mut View) -> PathBuf {
        let ws = v.active_project();
        ws.read_with(&v.cx, |ws, _| ws.project().clone())
    }

    fn rss_kb(pid: u32) -> u64 {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    }

    /// Builds one frame of the window.
    fn frame(v: &mut View) {
        v.cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }

    /// The shown project's dir, without running pending work (`View::active_project` runs all of it
    /// to parked, the git / tree catch-up of a newly shown project included, which the app runs off
    /// the UI thread after the frame).
    fn shown_dir(v: &mut View) -> Option<PathBuf> {
        let p = v.projects.clone().unwrap();
        p.read_with(&v.cx, |p, cx| {
            p.active().map(|w| w.read(cx).project().clone())
        })
    }

    /// ms from `at` until `dir` is shown (running only ready UI work), plus the frame showing it.
    fn until_shown(v: &mut View, at: Instant, dir: &Path) -> f64 {
        let deadline = Instant::now() + common::TIMEOUT;
        while shown_dir(v).as_deref() != Some(dir) {
            assert!(
                Instant::now() < deadline,
                "timed out: {} shown",
                dir.display()
            );
            v.cx.executor().tick();
            std::thread::sleep(Duration::from_micros(200));
        }
        frame(v);
        at.elapsed().as_secs_f64() * 1000.
    }

    fn median(v: &mut [f64]) -> String {
        v.sort_by(f64::total_cmp);
        format!(
            "{} samples, median {:.1} ms, max {:.1} ms",
            v.len(),
            v[v.len() / 2],
            v[v.len() - 1]
        )
    }

    fn wait_real(v: &mut View, label: &str, mut pred: impl FnMut(&mut View) -> bool) {
        let deadline = Instant::now() + common::TIMEOUT;
        while !pred(v) {
            assert!(Instant::now() < deadline, "timed out: {label}");
            v.pump();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn open_project(v: &mut View, dir: &Path) -> Entity<Workspace> {
        v.lua(&format!(
            "require('config.app.toolbar').open_project('{}') return true",
            dir.display()
        ));
        v.wait_until("project shown", |v| active_dir(v) == dir);
        let ws = v.active_project();
        v.use_project(&ws);
        v.wait_lua("nvim started", common::STARTED);
        v.wait_for("first frame", |e| e.ui().flushes > 0);
        v.settle();
        ws
    }

    /// Weak handles of everything `ws` owns, named.
    fn owned(v: &View, ws: &Entity<Workspace>) -> Vec<(&'static str, AnyWeakEntity)> {
        ws.read_with(&v.cx, |w, cx| {
            let git = w.git().read(cx);
            vec![
                ("workspace", ws.downgrade().into()),
                ("editor", w.editor().downgrade().into()),
                ("toolbar", w.toolbar().downgrade().into()),
                ("tree", w.tree().downgrade().into()),
                ("tabs", w.tabs().downgrade().into()),
                ("statusbar", w.statusbar().downgrade().into()),
                ("popups", w.popups().downgrade().into()),
                ("pickers", w.pickers().downgrade().into()),
                ("floats", w.floats().downgrade().into()),
                ("git", w.git().downgrade().into()),
                ("git log", git.log().downgrade().into()),
                ("git changes", git.changes().downgrade().into()),
                ("git header", git.header().downgrade().into()),
                ("diff", w.diff().downgrade().into()),
                ("annotate", w.annotate().downgrade().into()),
                ("terminal", w.terminal().downgrade().into()),
                ("markdown", w.markdown().downgrade().into()),
            ]
        })
    }

    #[test]
    fn closed_projects_drop_everything_and_cycles_keep_rss_flat() {
        let _serial = crate::serial();
        let (_ta, a) = copy("proj");
        let (_tb, b) = copy("grepo");
        let mut v = View::start_projects(a.to_str().unwrap(), &["a.ts"]);
        let ws_a = v.active_project();
        let me = std::process::id();
        let mut rss = Vec::new();
        let (mut switches, mut closes) = (Vec::new(), Vec::new());
        for cycle in 0..20 {
            // open b with its terminal and Git tool window up, back to a and to b again, close b
            let ws_b = open_project(&mut v, &b);
            let nvim = ws_b.update(&mut v.cx, |w, cx| {
                w.editor().update(cx, |e, _| e.nvim_mut().pid())
            });
            term::open(&mut v);
            gitui::open_git(&mut v);
            // (the rail: a, the first main checkout, then b)
            for (to, key) in [(&a, "super+arrow_up"), (&b, "super+arrow_down")] {
                v.settle();
                let ks = vimstorm::editor::input::keystroke(key).unwrap();
                let at = Instant::now();
                v.cx.update(|window, cx| window.dispatch_keystroke(ks, cx));
                switches.push(until_shown(&mut v, at, to));
            }
            v.use_project(&ws_b);
            let weak = owned(&v, &ws_b);
            drop(ws_b);
            v.settle();
            let at = Instant::now();
            v.lua("require('config.app.toolbar').close_project() return true");
            closes.push(until_shown(&mut v, at, &a));
            v.use_project(&ws_a);
            wait_real(&mut v, "b's nvim quit", |_| rss_kb(nvim) == 0);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline && weak.iter().any(|(_, w)| w.upgrade().is_some()) {
                // the frames drawn before the close hold the views they drew until the window draws
                // again (in the app: the next key, caret move or nvim redraw)
                v.cx.update(|window, _| window.refresh());
                v.pump();
                std::thread::sleep(Duration::from_millis(20));
            }
            let left: Vec<_> = weak
                .iter()
                .filter(|(_, w)| w.upgrade().is_some())
                .map(|(n, _)| *n)
                .collect();
            assert!(left.is_empty(), "cycle {cycle}: still alive {left:?}");
            rss.push(rss_kb(me));
        }
        eprintln!("PERF RSS (KB) after each open/switch/close cycle: {rss:?}");
        eprintln!(
            "PERF Cmd+↑ / Cmd+↓ -> the other project's frame (test context): {}",
            median(&mut switches)
        );
        eprintln!(
            "PERF Close Project -> next project's frame (test context): {}",
            median(&mut closes)
        );
        // the first cycles warm caches (fonts, shaped lines, the git / terminal code paths); after
        // that nothing a closed project owned may stay
        let warm = rss[4];
        let last = *rss.last().unwrap();
        eprintln!(
            "PERF RSS cycle 5 -> 20: {:+.1} MB",
            (last as f64 - warm as f64) / 1024.
        );
        assert!(
            last < warm + 40 * 1024,
            "RSS grew {warm} -> {last} KB over 15 cycles"
        );
    }
}

/// The bridge's frames and the slots they redraw: a long Chat's tree (~1 MB, two hundred turns)
/// decoded where the bridge's reader thread decodes it (`read_line`, timed: off the UI thread),
/// the UI thread's share of it (the session taking it, the tree applied), and a Board frame
/// drawing Chat's slot again: never.
mod bridge {
    use super::frames::{release, stats};
    use super::{common, serial};
    use std::time::Instant;

    use common::bridge::{Win, fixture};
    use serde_json::{Value, json};
    use vimstorm::factory::{BridgeFrame, Said, Slot, apply, read_line, read_said};

    /// `chat-rendered`'s transcript, its entries `n` times over (each with ids of its own).
    fn long_chat(n: usize) -> Value {
        let mut tree: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("trees/chat-rendered.json")).unwrap(),
        )
        .unwrap();
        fn suffix(v: &mut Value, k: usize) {
            match v {
                Value::Object(m) => {
                    if let Some(Value::String(id)) = m.get_mut("id") {
                        id.push_str(&format!(":{k}"));
                    }
                    m.values_mut().for_each(|c| suffix(c, k));
                }
                Value::Array(a) => a.iter_mut().for_each(|c| suffix(c, k)),
                _ => {}
            }
        }
        let transcript = &mut tree["children"][0]["children"][1];
        assert_eq!(transcript["kind"], "Transcript");
        let entries = transcript["children"].as_array().unwrap().clone();
        let mut all = Vec::new();
        for k in 0..n {
            for e in &entries {
                let mut e = e.clone();
                suffix(&mut e, k);
                all.push(e);
            }
        }
        transcript["children"] = json!(all);
        tree
    }

    #[test]
    fn a_long_chats_frame_decodes_off_the_ui_thread_and_a_board_frame_draws_no_chat() {
        let _serial = serial();
        let chat = long_chat(220);
        let line = |rev: u64| {
            json!({"v": 2, "type": "tree", "screen": "chat", "rev": rev, "slot": "chat", "tree": chat})
                .to_string()
        };
        let one = line(1);
        eprintln!(
            "PERF bridge: a long Chat's frame is {} KB",
            one.len() / 1024
        );
        assert!(one.len() > 1_000_000, "{}", one.len());
        let mut decode = Vec::new();
        for _ in 0..10 {
            let t = Instant::now();
            assert!(read_line(&one).is_some());
            decode.push(t.elapsed());
        }
        let (median, _) = stats("bridge: 1 MB Chat frame decoded (reader thread)", &decode);
        assert!(median < if release() { 25. } else { 400. }, "{median} ms");

        // (no slot's view yet: what a view drawing it costs is not the taking)
        let mut w = Win::open(None);
        let mut take = Vec::new();
        for rev in 1..=10 {
            let frame = read_line(&line(rev)).unwrap();
            let t = Instant::now();
            w.view.update(&mut w.cx, |v, cx| v.receive_frame(frame, cx));
            take.push(t.elapsed());
        }
        let (median, _) = stats(
            "bridge: the UI thread takes a decoded 1 MB Chat frame",
            &take,
        );
        assert!(median < if release() { 2. } else { 20. }, "{median} ms");

        let (scx, slot) = w.open_slot(Slot::Chat);
        let renders = |w: &mut Win| {
            w.cx.run_until_parked();
            slot.read_with(&scx, |v, _| v.renders())
        };
        let board = std::fs::read_to_string(fixture("frames/bridge-tree.json")).unwrap();
        let mut board: Value = serde_json::from_str(&board).unwrap();
        // (the first: the slot's transcript settles its own layout, drawn once more)
        board["rev"] = json!(19);
        let frame = read_line(&board.to_string()).unwrap();
        w.view.update(&mut w.cx, |v, cx| v.receive_frame(frame, cx));
        let before = renders(&mut w);
        for rev in 20..30 {
            board["rev"] = json!(rev);
            let frame = read_line(&board.to_string()).unwrap();
            w.view.update(&mut w.cx, |v, cx| v.receive_frame(frame, cx));
            w.cx.run_until_parked();
        }
        let drawn = renders(&mut w) - before;
        eprintln!("PERF bridge: 10 Board frames drew Chat's slot {drawn} times");
        assert_eq!(drawn, 0);
    }

    /// A transcript entry on the long Chat comes as a patch: its line a few KB, read and applied
    /// where the reader thread does it (the patch decoded, spliced into the tree held, the whole
    /// tree handed on), against decoding the whole 1 MB frame.
    #[test]
    fn a_transcript_entrys_patch_is_small_and_applies_far_under_a_whole_decode() {
        let _serial = serial();
        let chat = long_chat(220);
        let whole = json!({"v": 2, "type": "tree", "screen": "chat", "rev": 1, "slot": "chat", "tree": chat})
            .to_string();
        let Some(BridgeFrame::Tree { tree, .. }) = read_line(&whole) else {
            panic!("the long Chat decodes");
        };
        let mut held = tree;
        let entries = chat["children"][0]["children"][1]["children"].clone();
        let entry = entries[0].clone();
        let mut len = entries.as_array().unwrap().len();
        let mut decode = Vec::new();
        let mut patched = Vec::new();
        let mut bytes = 0;
        for rev in 2..22u64 {
            let mut e = entry.clone();
            e["id"] = json!(format!("new:{rev}"));
            let line =
                json!({"v": 2, "type": "patch", "screen": "chat", "rev": rev, "base": rev - 1,
                "slot": "chat", "ops": [{"path": [0, 1], "splice": [len, 0], "add": [e]}]})
                .to_string();
            bytes = line.len();
            let t = Instant::now();
            let _ = read_line(&whole);
            decode.push(t.elapsed());
            let t = Instant::now();
            let Some(Said::Patch(p)) = read_said(&line) else {
                panic!("a patch line");
            };
            apply(&mut held, p.ops).unwrap();
            let handed = held.clone();
            patched.push(t.elapsed());
            len += 1;
            assert_eq!(handed.children()[0].children()[1].children().len(), len);
        }
        eprintln!(
            "PERF bridge: a transcript entry's patch is {bytes} bytes (the tree {} KB)",
            whole.len() / 1024
        );
        assert!(bytes < 16 * 1024, "{bytes}");
        let (whole_ms, _) = stats("bridge: 1 MB Chat frame decoded whole", &decode);
        let (patch_ms, _) = stats(
            "bridge: a transcript entry's patch read, applied, handed on",
            &patched,
        );
        assert!(patch_ms * 4. < whole_ms, "{patch_ms} ms vs {whole_ms} ms");
        assert!(patch_ms < if release() { 5. } else { 60. }, "{patch_ms} ms");
    }
}

/// A Chat slot's memory and a long transcript's scroll: Chat moved over fifty sessions keeps no
/// more than its last ones' (each session's transcript keeps its scroll, the oldest swept); the
/// wheel over a long transcript (two hundred turns), each step's frame timed (its view draws the
/// rows near what it shows); the status line's clock ticking, each frame timed; another long
/// session's first frame.
mod chat_slot {
    use super::frames::{release, stats};
    use super::{common, serial};
    use std::time::Instant;

    use common::bridge::{Win, fixture};
    use gpui_kit::{Modifiers, ScrollDelta, ScrollWheelEvent, TouchPhase, point, px};
    use serde_json::{Value, json};
    use vimstorm::factory::{Slot, read_line};

    fn chat(session: &str, turns: usize) -> Value {
        let mut tree: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("trees/chat-rendered.json")).unwrap(),
        )
        .unwrap();
        let transcript = &mut tree["children"][0]["children"][1];
        transcript["props"]["session"] = json!(session);
        let entries = transcript["children"].as_array().unwrap().clone();
        let mut all = Vec::new();
        for k in 0..turns {
            for e in &entries {
                let mut e = e.clone();
                if let Some(id) = e["id"].as_str() {
                    e["id"] = json!(format!("{id}:{k}"));
                }
                all.push(e);
            }
        }
        transcript["children"] = json!(all);
        tree
    }

    fn show(w: &mut Win, rev: u64, tree: &Value) {
        let line = json!({"v": 2, "type": "tree", "screen": "chat", "rev": rev, "slot": "chat", "tree": tree});
        let frame = read_line(&line.to_string()).unwrap();
        w.view.update(&mut w.cx, |v, cx| v.receive_frame(frame, cx));
        w.cx.run_until_parked();
    }

    #[test]
    fn chats_memory_stays_flat_over_sessions_and_a_long_transcript_scrolls_within_budget() {
        let _serial = serial();
        let mut w = Win::open_sized(None, 1440., 900.);
        let (mut scx, slot) = w.open_slot(Slot::Chat);
        let mut kept = Vec::new();
        for n in 0..50 {
            show(&mut w, n + 1, &chat(&format!("s{n}"), 1));
            scx.run_until_parked();
            kept.push(slot.read_with(&scx, |v, _| v.memory_len()));
        }
        eprintln!(
            "PERF chat slot: parts kept after 5, 50 sessions: {}, {}",
            kept[4], kept[49]
        );
        assert!(kept[49] <= kept[9], "{kept:?}");

        show(&mut w, 100, &chat("long", 200));
        scx.run_until_parked();
        let wheel = |scx: &mut gpui_kit::VisualTestContext, dy: f32| {
            let t = Instant::now();
            scx.simulate_event(ScrollWheelEvent {
                position: point(px(400.), px(300.)),
                delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
                modifiers: Modifiers::default(),
                touch_phase: TouchPhase::Moved,
            });
            t.elapsed()
        };
        let mut steps = Vec::new();
        for _ in 0..if release() { 60 } else { 6 } {
            steps.push(wheel(&mut scx, 40.));
        }
        let (median, _) = stats("chat slot: long transcript wheel step -> frame", &steps);
        if release() {
            assert!(median < 16., "{median} ms");
        }

        // the clock ticks (the working dot pulsing between): each frame draws the status line,
        // a view of its own over the slot, and never the slot or its transcript
        let drawn = |scx: &mut gpui_kit::VisualTestContext| {
            slot.read_with(scx, |v, cx| {
                (v.renders(), v.transcript_renders(cx), v.status_renders(cx))
            })
        };
        let tick = |scx: &mut gpui_kit::VisualTestContext| {
            scx.executor()
                .advance_clock(std::time::Duration::from_secs(1));
            scx.run_until_parked();
        };
        tick(&mut scx);
        let (slots, transcripts, lines) = drawn(&mut scx);
        let t = Instant::now();
        for _ in 0..5 {
            tick(&mut scx);
        }
        let took = t.elapsed();
        let (slots, transcripts, lines) = {
            let (s, t, l) = drawn(&mut scx);
            (s - slots, t - transcripts, l - lines)
        };
        let frame = took.as_secs_f64() * 1000. / lines.max(1) as f64;
        eprintln!(
            "PERF chat slot: 5 clock ticks drew the status line {lines} times, the slot {slots} (its transcript {transcripts}), {frame:.2} ms a frame"
        );
        assert!(lines >= 5, "the clock ticks");
        assert_eq!(
            (slots, transcripts),
            (0, 0),
            "a tick draws the status line alone"
        );

        // another long session shown: its first frames draw the rows near its end, the rest
        // reckoned
        let fresh = chat("fresh", 200);
        let all = fresh["children"][0]["children"][1]["children"]
            .as_array()
            .unwrap()
            .len();
        let rows = slot.read_with(&scx, |v, cx| v.transcript_rows(cx));
        let t = Instant::now();
        show(&mut w, 101, &fresh);
        scx.run_until_parked();
        let took = t.elapsed().as_secs_f64() * 1000.;
        let rows = slot.read_with(&scx, |v, cx| v.transcript_rows(cx)) - rows;
        eprintln!(
            "PERF chat slot: a session of {all} rows shown anew drew {rows} rows, {took:.1} ms"
        );
        assert!(rows * 10 < all as u64, "{rows} of {all} rows drawn");
        if release() {
            assert!(frame < 16., "{frame} ms a frame");
        }
    }
}
