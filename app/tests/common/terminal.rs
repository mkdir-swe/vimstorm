//! Native terminal helpers: the TerminalView behind the workspace, its shell's screen, typing
//! (named keys as keystrokes, text through the view's IME handler as AppKit commits it), mouse
//! on its cells, the find bar.

use std::time::{Duration, Instant};

use gpui_kit::{
    App, ElementInputHandler, Entity, InputHandler as _, Modifiers, MouseButton, MouseDownEvent,
    MouseUpEvent, Pixels, Point, point, px,
};
use vimstorm::terminal::TerminalView;

use super::view::View;

pub const NONE: Modifiers = Modifiers {
    control: false,
    alt: false,
    shift: false,
    platform: false,
    function: false,
};

pub fn term(v: &mut View) -> Entity<TerminalView> {
    v.read_ws(|ws, _| ws.terminal().clone())
}

pub fn read<R>(v: &mut View, f: impl FnOnce(&TerminalView, &App) -> R) -> R {
    let t = term(v);
    v.pump();
    t.read_with(&v.cx, f)
}

pub fn target(v: &View) -> String {
    v.lua("return require('config.focus').target()")
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// The view (not its find field) has the keyboard (focus.target() == "terminal"), and keys go to the shell (not the scroll view).
pub fn typing(v: &mut View) -> bool {
    let t = term(v);
    v.pump();
    let view_focused =
        v.cx.update(|window, cx| t.read(cx).keyboard().is_focused(window));
    view_focused && !read(v, |t, _| t.in_scroll_view()) && target(v) == "terminal"
}

pub fn wait_typing(v: &mut View) {
    v.wait_until("typing in the terminal", typing);
}

pub fn screen(v: &mut View) -> Vec<String> {
    read(v, |t, _| t.screen())
}

pub fn all_lines(v: &mut View) -> Vec<String> {
    read(v, |t, _| t.all_lines())
}

/// Waits until a row on screen satisfies `pred`.
pub fn wait_row(v: &mut View, label: &str, pred: impl Fn(&str) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let s = screen(v);
        if s.iter().any(|l| pred(l)) {
            return;
        }
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for: {label}\n--- terminal ---\n{}",
                s.join("\n")
            );
        }
        v.wait_until("a moment", |_| true);
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Waits until `pred` holds on the terminal's screen (rows); the screen on a timeout.
pub fn wait_term(v: &mut View, label: &str, pred: impl Fn(&[String]) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let s = screen(v);
        if pred(&s) {
            return;
        }
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for: {label}\n--- terminal ---\n{}",
                s.join("\n")
            );
        }
        v.wait_until("a moment", |_| true);
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Waits for `needle` on the terminal's screen (a row, or rows a long line wrapped onto: the
/// Chat column's terminal is ~80 columns).
pub fn wait_screen(v: &mut View, needle: &str) {
    wait_term(v, &format!("terminal shows {needle:?}"), |rows| {
        rows.iter().any(|l| l.contains(needle))
            || rows
                .iter()
                .map(|l| l.trim_end())
                .collect::<String>()
                .contains(needle)
    });
}

/// A row that is exactly `text` (trimmed).
pub fn wait_line(v: &mut View, text: &str) {
    wait_row(v, &format!("a terminal row {text:?}"), |l| l.trim() == text);
}

pub fn shows(v: &mut View, needle: &str) -> bool {
    screen(v).iter().any(|l| l.contains(needle))
}

/// Waits until the shell drew its prompt (a non-blank row, and quiet).
pub fn wait_prompt(v: &mut View) {
    wait_row(v, "shell prompt", |l| !l.trim().is_empty());
    settle(v);
}

/// Waits until the terminal's screen hasn't changed for 150 ms (max 3 s).
pub fn settle(v: &mut View) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut last = (screen(v), Instant::now());
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        let now = screen(v);
        if now != last.0 {
            last = (now, Instant::now());
        } else if last.1.elapsed() >= Duration::from_millis(150) {
            return;
        }
    }
}

/// Text as AppKit's input context commits it (printable keys, pastes of the IME).
pub fn type_text(v: &mut View, text: &str) {
    let t = term(v);
    let bounds = read(v, |t, _| t.grid_layout().map(|l| l.bounds)).unwrap_or_default();
    v.cx.update(|window, cx| {
        let mut h = ElementInputHandler::new(bounds, t.clone());
        h.replace_text_in_range(None, text, window, cx);
    });
    v.pump();
}

/// A command line + Enter.
pub fn run(v: &mut View, cmd: &str) {
    type_text(v, cmd);
    v.keystrokes("enter");
}

/// Cmd+T (the bottom pane's Terminal), typing in a shell that drew its prompt.
pub fn open(v: &mut View) {
    v.keystrokes("cmd-t");
    wait_typing(v);
    wait_prompt(v);
}

/// The Terminal's host window's island in the bottom pane while it is laid out.
pub fn term_rect(v: &mut View) -> Option<gpui_kit::Bounds<Pixels>> {
    v.read(|e| {
        e.geometry()
            .role_rect(vimstorm::shell::Role::Terminal)
            .map(|r| r.island)
    })
}

/// Window position of `needle`'s first cell (+ `dc` cells).
pub fn cell_of(v: &mut View, needle: &str, dc: i32) -> Point<Pixels> {
    let p = read(v, |t, _| t.cell_of(needle))
        .unwrap_or_else(|| panic!("{needle:?} not on the terminal's screen"));
    let w = read(v, |t, _| t.grid_layout().unwrap().metrics.cell_width);
    // (a hair right of a later cell's center: f32 sums of the 7.8 px cells land either side of it)
    let nudge = if dc > 0 { px(0.01) } else { px(0.) };
    point(p.x + w * dc as f32 + nudge, p.y)
}

pub fn mouse(v: &mut View, at: Point<Pixels>, button: MouseButton, count: usize) {
    v.cx.simulate_event(MouseDownEvent {
        position: at,
        modifiers: NONE,
        button,
        click_count: count,
        first_mouse: false,
    });
    v.cx.simulate_event(MouseUpEvent {
        position: at,
        modifiers: NONE,
        button,
        click_count: count,
    });
}

/// A left drag: press, a few motion steps, release.
pub fn drag(v: &mut View, from: Point<Pixels>, to: Point<Pixels>) {
    v.cx.simulate_mouse_down(from, MouseButton::Left, NONE);
    for i in 1..=4 {
        let f = i as f32 / 4.;
        let p = point(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f);
        v.cx.simulate_mouse_move(p, MouseButton::Left, NONE);
    }
    v.cx.simulate_event(MouseUpEvent {
        position: to,
        modifiers: NONE,
        button: MouseButton::Left,
        click_count: 1,
    });
}

pub fn selection(v: &mut View) -> Option<String> {
    read(v, |t, _| t.selection())
}

pub fn set_clipboard(v: &mut View, text: &str) {
    v.cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text.to_owned()));
}

pub fn tab_names(v: &mut View) -> String {
    read(v, |t, _| t.tab_names()).join(",")
}

pub fn selected(v: &mut View) -> String {
    read(v, |t, _| {
        t.tab_names()[t.current().min(t.tab_names().len().saturating_sub(1))].clone()
    })
}

pub fn open_tool(v: &mut View) -> bool {
    read(v, |t, _| t.shown())
}

/// Center of tab `ix` in the header, or of its ×.
pub fn tab_pos(v: &mut View, ix: usize, on_x: bool) -> Point<Pixels> {
    let b = read(v, |t, cx| t.tab_bounds(ix, cx)).expect("tab drawn");
    if on_x {
        point(b.right() - px(12.), b.center().y)
    } else {
        point(b.left() + px(12.), b.center().y)
    }
}

/// Center of header action `id`, once drawn over the Terminal's island (or over the body,
/// maximized).
pub fn action_pos(v: &mut View, id: &str) -> Point<Pixels> {
    let placed = |v: &mut View| -> Option<Point<Pixels>> {
        let c = read(v, |t, cx| t.action_bounds(id, cx))?.center();
        let area = read(v, |t, _| t.view_bounds())?;
        area.contains(&c).then_some(c)
    };
    v.wait_until(&format!("action {id} drawn in the Terminal"), |v| {
        placed(v).is_some()
    });
    placed(v).expect("placed")
}

/// The find bar's count label ("3/12", "No matches"), None while closed.
pub fn find_label(v: &mut View) -> Option<String> {
    read(v, |t, _| t.find_label())
}

pub fn wait_label(v: &mut View, want: &str) {
    v.wait_until(&format!("find count {want}"), |v| {
        find_label(v).as_deref() == Some(want)
    });
}

/// The Terminal's island maximized over the body (⌥⌘⏎).
pub fn maximized(v: &mut View) -> bool {
    v.pump();
    matches!(
        v.read_ws(|ws, cx| ws.maximized(cx)),
        Some(vimstorm::shell::Island::Bottom(_))
    )
}

/// The terminal fills the body (its width, down to the body's bottom).
pub fn covers(v: &mut View) -> bool {
    let body = v.read(|e| e.geometry().maximized_rect());
    let drawn = read(v, |t, _| t.view_bounds());
    maximized(v)
        && drawn.is_some_and(|b| {
            (b.size.width - body.size.width).abs() < px(4.)
                && (b.bottom() - body.bottom()).abs() < px(4.)
                && b.top() - body.top() < px(80.)
        })
}

/// nvim's windows that aren't floats: "row,col:WxH:file", sorted.
pub fn splits(v: &View) -> String {
    v.lua(
        "local t = {} for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do \
         if vim.api.nvim_win_get_config(w).relative == '' then local p = vim.api.nvim_win_get_position(w) \
         t[#t + 1] = ('%d,%d:%dx%d:%s'):format(p[1], p[2], vim.api.nvim_win_get_width(w), vim.api.nvim_win_get_height(w), \
         vim.fn.fnamemodify(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)), ':t')) end end \
         table.sort(t) return table.concat(t, ' ')",
    )
    .as_str()
    .unwrap_or_default()
    .to_owned()
}

/// The shell's prompt line: the last non-blank row of the terminal's screen.
pub fn prompt(v: &mut View) -> String {
    screen(v)
        .into_iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default()
}
