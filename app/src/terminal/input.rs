//! The terminal's keyboard, mouse, scrolling and IME (see the module doc of [`super`]).

use std::ops::Range;

use alacritty_terminal::grid::{Dimensions as _, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use gpui_kit::{
    Bounds, ClipboardItem, Context, EntityInputHandler, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, ScrollDelta, ScrollWheelEvent, TouchPhase,
    UTF16Selection, Window, point, px, size,
};

use super::keys::{self, MouseKind};
use super::{LUA, Press, TerminalView, text};
use crate::kit::Anchor;
use crate::kit::notation;

/// Cmd keys that only mean something in the editor: nothing in the terminal (webstorm.lua's
/// terminal-mode `<Nop>`s; they'd edit the host's scratch buffer in nvim).
/// How long a Ctrl+\\ waits for a Ctrl+N (nvim's terminal-mode escape) before it goes to the shell.
const PREFIX_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);

/// Keys typed right after a global shortcut went to nvim wait for nvim's answer (its next flush,
/// the keyboard moving to a picker it opened) at most this long, then go where the keyboard is:
/// Cmd+O + "ab" in one burst lands in Go to File's field, not in the shell (the editor's path
/// holds such keys as nvim typeahead).
const HOLD_MAX: std::time::Duration = std::time::Duration::from_millis(300);

/// A held key, or text committed straight through the IME meanwhile (kept in order).
enum Held {
    Key(gpui_kit::Keystroke),
    Text(String),
}

/// Keys held after a global shortcut (see [`HOLD_MAX`]).
pub(super) struct Hold {
    /// nvim's flushes when the shortcut went.
    flushes: u64,
    keys: Vec<Held>,
    _timer: gpui_kit::Task<()>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl TerminalView {
    /// Keys while the view (or its find bar) has the keyboard.
    pub(super) fn on_key_down(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.find_focused(window, cx) {
            if self.find_key(ev, window, cx) {
                cx.stop_propagation();
            }
            return;
        }
        if !self.focus.is_focused(window) {
            return;
        }
        if self.term_key(ev, window, cx) {
            cx.stop_propagation();
        }
    }

    /// A key for the shell; true: handled (stop it).
    fn term_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let k = &ev.keystroke;
        let m = k.modifiers;
        if !m.platform
            && let Some(h) = self.hold.as_mut()
        {
            h.keys.push(Held::Key(k.clone()));
            return true;
        }
        let note = notation(ev).unwrap_or_default();
        match note.as_str() {
            "<D-c>" => {
                self.copy(cx);
                return true;
            }
            "<D-v>" => {
                self.paste_clipboard(window, cx);
                return true;
            }
            "<D-f>" => {
                self.open_find(window, cx);
                return true;
            }
            "<D-CR>" => {
                let at = self
                    .caret_bounds()
                    .map_or(Anchor::Point(point(px(0.), px(0.))), Anchor::Below);
                self.open_menu(at, window, cx);
                return true;
            }
            "<M-D-Left>" => {
                self.cycle(-1, cx);
                return true;
            }
            "<M-D-Right>" => {
                self.cycle(1, cx);
                return true;
            }
            _ => {}
        }
        // the switcher
        if m.control && k.key == "tab" {
            return false;
        }
        // the Feel's own Ctrl keys (vscode's Ctrl+Shift+G): nvim's
        if crate::editor::input::feel_ctrl_key(k, cx) {
            return false;
        }
        // Ctrl+\ Ctrl+N (nvim's terminal-mode escape the Lua terminal had): the scroll view. A
        // Ctrl+\ waits for the next key (PREFIX_WAIT at most) before it reaches the shell.
        if self.ctrl_bslash.take().is_some() {
            if note == "<C-n>" {
                self.scroll_view = true;
                cx.notify();
                return true;
            }
            self.send_typed(vec![0x1c], window, cx);
        }
        if note == "<C-Bslash>" {
            self.hold_ctrl_bslash(cx);
            return true;
        }
        // the scroll view: `i` / Esc go back to typing (Lua: Normal mode -> Terminal mode)
        let plain = !m.control && !m.alt && !m.platform && !m.shift;
        if self.scroll_view
            && ((plain && k.key == "i") || (note == "<Esc>" && self.selection().is_none()))
        {
            self.back_to_prompt(cx);
            return true;
        }
        if self.scroll_view {
            let lines = match note.as_str() {
                "<Up>" => Some(-1.),
                "<Down>" => Some(1.),
                "<S-Up>" => Some(-0.5),
                "<S-Down>" => Some(0.5),
                _ => None,
            };
            if let Some(d) = lines {
                self.scroll_keys(d, cx);
                return true;
            }
        }
        match note.as_str() {
            "<S-PageUp>" => {
                self.scroll_rows(self.page() as i32, cx);
                return true;
            }
            "<S-PageDown>" => {
                self.scroll_rows(-(self.page() as i32), cx);
                return true;
            }
            "<Esc>" if self.selection().is_some() => {
                self.clear_selection(cx);
                return true;
            }
            _ => {}
        }
        let mode = self
            .pty()
            .map_or(TermMode::empty(), |p| *p.term.lock().mode());
        if let Some(bytes) = keys::encode_in(k, mode) {
            self.send_typed(bytes, window, cx);
            return true;
        }
        if m.platform {
            // an editor action (Cmd+Z, Cmd+D ...): nothing (it would edit the buffer behind)
            if !crate::editor::input::global_cmd(k, cx) {
                return true;
            }
            // a global shortcut: nvim's; what's typed next waits for its answer
            self.start_hold(window, cx);
            return false;
        }
        // Ctrl + a key without a control code: nothing; plain text goes to the IME (not stopped)
        m.control
    }

    fn start_hold(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.hold.is_some() {
            return;
        }
        let editor = self
            .scx
            .workspace
            .upgrade()
            .map(|ws| ws.read(cx).editor().clone());
        let flushes = editor.as_ref().map_or(0, |e| e.read(cx).ui().flushes);
        let mut subs = vec![cx.on_focus_out(&self.focus, window, |v, _, window, cx| {
            v.release_hold(window, cx)
        })];
        if let Some(e) = editor {
            // nvim answered (a picker it opened has taken the keyboard by the deferred check)
            subs.push(cx.observe_in(&e, window, |v, e, window, cx| {
                if v.hold
                    .as_ref()
                    .is_some_and(|h| e.read(cx).ui().flushes > h.flushes)
                {
                    v.release_hold_soon(window, cx);
                }
            }));
        }
        let timer = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(HOLD_MAX).await;
            let _ = this.update_in(cx, |v, window, cx| v.release_hold(window, cx));
        });
        self.hold = Some(Hold {
            flushes,
            keys: Vec::new(),
            _timer: timer,
            _subs: subs,
        });
    }

    /// Lua answered (a bridge event, a flush): release once what it started (a picker taking the
    /// keyboard) is done.
    pub(super) fn release_hold_soon(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.hold.is_none() {
            return;
        }
        let this = cx.entity().downgrade();
        window.defer(cx, move |window, cx| {
            let _ = this.update(cx, |v, cx| v.release_hold(window, cx));
        });
    }

    /// The held keys go to whatever has the keyboard now (the shell when it's still this view).
    pub(super) fn release_hold(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(h) = self.hold.take() else {
            return;
        };
        if h.keys.is_empty() {
            return;
        }
        let this = cx.entity().downgrade();
        window.defer(cx, move |window, cx| {
            for item in h.keys {
                match item {
                    Held::Key(k) => {
                        window.dispatch_keystroke(k, cx);
                    }
                    // (only the shell takes text that skipped the key path)
                    Held::Text(t) => {
                        let _ = this.update(cx, |v, cx| v.send_typed(t.into_bytes(), window, cx));
                    }
                }
            }
        });
    }

    /// A Ctrl+\\ waiting for its Ctrl+N; on its own it goes to the shell after PREFIX_WAIT.
    fn hold_ctrl_bslash(&mut self, cx: &mut Context<Self>) {
        self.ctrl_bslash = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PREFIX_WAIT).await;
            let _ = this.update(cx, |v, _| {
                if v.ctrl_bslash.take().is_some()
                    && let Some(p) = v.pty()
                {
                    p.write(vec![0x1c]);
                }
            });
        }));
    }

    /// Bytes typed for the shell: the view goes back to the prompt.
    fn send_typed(&mut self, bytes: Vec<u8>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pty) = self.active_pty(window, cx) else {
            return;
        };
        // a held Ctrl+\ goes first
        if self.ctrl_bslash.take().is_some() && !self.in_float(window, cx) {
            pty.write(vec![0x1c]);
        }
        if self.float.is_none() || !self.in_float(window, cx) {
            self.back_to_prompt(cx);
        }
        if crate::app::timing_enabled() {
            self.key_at = Some(std::time::Instant::now());
        }
        pty.write(bytes);
    }

    fn in_float(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        self.float
            .as_ref()
            .is_some_and(|f| f.focus.contains_focused(window, cx))
    }

    /// Typing: no selection, scrolled back to the bottom, out of the scroll view.
    pub(super) fn back_to_prompt(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = self.pty() {
            let mut term = p.term.lock();
            term.selection = None;
            term.scroll_display(Scroll::Bottom);
        }
        self.scroll_view = false;
        self.scroll_px = 0.;
        cx.notify();
    }

    /// Rows on screen.
    fn page(&self) -> usize {
        self.grid_layout().map_or(24, |l| l.rows)
    }

    /// The scroll view's keys: `d` lines (|d| < 1: pages); down stops with the newest line at the
    /// bottom (Lua's M.scroll).
    fn scroll_keys(&mut self, d: f32, cx: &mut Context<Self>) {
        let n = if d.abs() < 1. {
            ((self.page() as f32 * d.abs()).floor() as i32).max(1)
        } else {
            d.abs() as i32
        };
        self.scroll_rows(if d < 0. { n } else { -n }, cx);
        // (at the bottom: still the scroll view)
        self.scroll_view = true;
    }

    /// Scrolls the scrollback `rows` up (negative: down); the scroll view while scrolled back.
    fn scroll_rows(&mut self, rows: i32, cx: &mut Context<Self>) {
        if let Some(p) = self.pty().cloned() {
            let mut term = p.term.lock();
            term.scroll_display(Scroll::Delta(rows));
            if term.grid().display_offset() > 0 {
                self.scroll_view = true;
            }
        }
        cx.notify();
    }

    /// Cmd+C / menu Copy: the selection to the clipboard, cleared; the view stays where it is
    /// (typing goes on; the scroll view stays the scroll view).
    pub(super) fn copy(&mut self, cx: &mut Context<Self>) {
        let Some(text) = self.selection() else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.clear_selection(cx);
    }

    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        if let Some(p) = self.pty() {
            p.term.lock().selection = None;
        }
        cx.notify();
    }

    /// Cmd+V / menu Paste / middle click: the clipboard into the shell (bracketed when it asked),
    /// also over a selection (which goes).
    pub(super) fn paste_clipboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) else {
            return;
        };
        self.paste_text(&text, window, cx);
    }

    pub(super) fn paste_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pty) = self.active_pty(window, cx) else {
            return;
        };
        let bracketed = pty.term.lock().mode().contains(TermMode::BRACKETED_PASTE);
        if !self.in_float(window, cx) {
            self.back_to_prompt(cx);
        }
        pty.write(keys::paste(text, bracketed));
    }

    /// The caret cell in window coordinates.
    fn caret_bounds(&self) -> Option<Bounds<Pixels>> {
        let layout = self.grid_layout()?;
        let p = self.pty()?;
        let term = p.term.lock();
        let c = term.grid().cursor.point;
        let row = c.line.0 + term.grid().display_offset() as i32;
        if row < 0 || row as usize >= layout.rows {
            return None;
        }
        Some(Bounds::new(
            layout.cell_origin(row as usize, c.column.0),
            size(layout.metrics.cell_width, layout.metrics.row_height),
        ))
    }

    // Mouse ----------------------------------------------------------------------------------

    /// Any press inside (capture): the host becomes nvim's current window; the find bar closes
    /// on a press outside it.
    pub(super) fn on_any_mouse_down(
        &mut self,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.float.is_some() {
            return;
        }
        if self.hosted.is_open() && !self.hosted.is_current() {
            self.hosted.clicked();
            self.scx.navigate(LUA, "enter", vec![]);
        }
        if self.find.is_some() && !self.find_contains(ev.position) {
            self.close_find(false, window, cx);
        }
    }

    /// Grid point (and side: a press at a cell's center starts before it, a drag ending there ends
    /// after it) under a window position.
    fn grid_point(
        &self,
        pos: gpui_kit::Point<Pixels>,
        press: bool,
    ) -> Option<(GridPoint, Side, usize, usize)> {
        let layout = self.grid_layout()?;
        let (row, col, frac) = layout.cell_at(pos);
        let right = if press { frac > 0.5 } else { frac >= 0.5 };
        let offset = self.display_offset() as i32;
        Some((
            GridPoint::new(Line(row as i32 - offset), Column(col)),
            if right { Side::Right } else { Side::Left },
            row,
            col,
        ))
    }

    /// The TUI asked for mouse reports (Shift bypasses them: select / menu as usual).
    fn reporting(&self, m: gpui_kit::Modifiers) -> Option<TermMode> {
        if m.shift {
            return None;
        }
        let mode = *self.pty()?.term.lock().mode();
        mode.intersects(TermMode::MOUSE_MODE).then_some(mode)
    }

    fn report_mouse(
        &mut self,
        button: keys::MouseButton,
        kind: MouseKind,
        pos: gpui_kit::Point<Pixels>,
        m: gpui_kit::Modifiers,
        mode: TermMode,
    ) {
        let Some((_, _, row, col)) = self.grid_point(pos, true) else {
            return;
        };
        if let Some(bytes) = keys::mouse_report(
            button,
            kind,
            col,
            row,
            m,
            mode.contains(TermMode::SGR_MOUSE),
            mode.contains(TermMode::UTF8_MOUSE),
        ) && let Some(p) = self.pty()
        {
            p.write(bytes);
        }
    }

    pub(super) fn body_mouse_down(
        &mut self,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.find_contains(ev.position) {
            return;
        }
        cx.stop_propagation();
        self.take_keyboard(window, cx);
        let button = match ev.button {
            MouseButton::Left => keys::MouseButton::Left,
            MouseButton::Middle => keys::MouseButton::Middle,
            MouseButton::Right => keys::MouseButton::Right,
            _ => return,
        };
        if let Some(mode) = self.reporting(ev.modifiers) {
            self.reported = Some(button);
            self.report_mouse(button, MouseKind::Press, ev.position, ev.modifiers, mode);
            return;
        }
        match ev.button {
            MouseButton::Right => {
                // the menu; a selection stays (its Copy)
                self.press = None;
                self.open_menu(Anchor::Point(ev.position), window, cx);
            }
            // WS: paste on middle click
            MouseButton::Middle => self.paste_clipboard(window, cx),
            MouseButton::Left => {
                let Some((point, side, _, _)) = self.grid_point(ev.position, true) else {
                    return;
                };
                let Some(p) = self.pty().cloned() else {
                    return;
                };
                let mut term = p.term.lock();
                match ev.click_count {
                    2 => {
                        term.selection = text::word_at(&*term, point).map(|(a, b)| {
                            let mut s = Selection::new(SelectionType::Simple, a, Side::Left);
                            s.update(b, Side::Right);
                            s
                        });
                        self.press = None;
                    }
                    n if n >= 3 => {
                        term.selection = Some(Selection::new(SelectionType::Lines, point, side));
                        self.press = None;
                    }
                    _ => {
                        term.selection = None;
                        self.press = Some(Press {
                            point,
                            side,
                            dragged: false,
                        });
                    }
                }
                drop(term);
                cx.notify();
            }
            _ => {}
        }
    }

    /// Mouse moves anywhere in the window (the grid element listens at the window, so a drag
    /// that leaves the body goes on): TUI motion reports, drag selection with auto-scroll into
    /// the scrollback past the top / bottom edge.
    pub(super) fn grid_mouse_move(
        &mut self,
        ev: &MouseMoveEvent,
        inside: bool,
        cx: &mut Context<Self>,
    ) {
        if let Some(mode) = self.reporting(ev.modifiers) {
            let button = match ev.pressed_button {
                Some(MouseButton::Left) => Some(keys::MouseButton::Left),
                Some(MouseButton::Middle) => Some(keys::MouseButton::Middle),
                Some(MouseButton::Right) => Some(keys::MouseButton::Right),
                _ => None,
            };
            let wants = match button {
                // a drag started in the grid is reported wherever it goes (clamped to the grid)
                Some(_) => {
                    self.reported.is_some()
                        && mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION)
                }
                None => inside && mode.contains(TermMode::MOUSE_MOTION),
            };
            if wants {
                self.report_mouse(
                    button.unwrap_or(keys::MouseButton::None),
                    MouseKind::Motion,
                    ev.position,
                    ev.modifiers,
                    mode,
                );
            }
            return;
        }
        if ev.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some(press) = self.press else {
            return;
        };
        let Some(layout) = self.grid_layout() else {
            return;
        };
        let Some(p) = self.pty().cloned() else {
            return;
        };
        // past the top / bottom: the view scrolls (a row per row of distance, at most 3 a move)
        let top = layout.origin.y;
        let bottom = layout.origin.y + layout.metrics.row_height * layout.rows as f32;
        let row_h = layout.metrics.row_height;
        let scroll = if ev.position.y < top {
            ((top - ev.position.y) / row_h).ceil().min(3.) as i32
        } else if ev.position.y >= bottom {
            -(((ev.position.y - bottom) / row_h).floor() + 1.).min(3.) as i32
        } else {
            0
        };
        if scroll != 0 && press.dragged {
            let mut term = p.term.lock();
            term.scroll_display(Scroll::Delta(scroll));
            if term.grid().display_offset() > 0 {
                self.scroll_view = true;
            }
        }
        let Some((point, side, _, _)) = self.grid_point(ev.position, false) else {
            return;
        };
        if !press.dragged && point == press.point && side == press.side {
            return;
        }
        let mut term = p.term.lock();
        if !press.dragged {
            term.selection = Some(Selection::new(
                SelectionType::Simple,
                press.point,
                press.side,
            ));
            self.press = Some(Press {
                dragged: true,
                ..press
            });
        }
        if let Some(s) = term.selection.as_mut() {
            s.update(point, side);
        }
        drop(term);
        cx.notify();
    }

    /// Button releases anywhere in the window: the TUI hears the release of a button it got
    /// the press of; a left click (no drag) ends.
    pub(super) fn grid_mouse_up(&mut self, ev: &MouseUpEvent, _cx: &mut Context<Self>) {
        if let Some(button) = self.reported.take() {
            if let Some(mode) = self.reporting(ev.modifiers) {
                self.report_mouse(button, MouseKind::Release, ev.position, ev.modifiers, mode);
            }
            return;
        }
        if ev.button != MouseButton::Left {
            return;
        }
        // a click (no drag): typing goes on (the scroll view stays the scroll view)
        self.press = None;
    }

    pub(super) fn body_scroll(
        &mut self,
        ev: &ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        let Some(layout) = self.grid_layout() else {
            return;
        };
        let row = layout.metrics.row_height.as_f32();
        let dy = match ev.delta {
            ScrollDelta::Pixels(p) => p.y.as_f32(),
            // a mouse wheel line: 3 rows (nvim's mousescroll default the Lua terminal had)
            ScrollDelta::Lines(l) => l.y * row * 3.,
        };
        let Some(p) = self.pty().cloned() else {
            return;
        };
        let mode = *p.term.lock().mode();
        // TUIs: wheel reports, or arrows in the alternate screen
        if !ev.modifiers.shift
            && (mode.intersects(TermMode::MOUSE_MODE)
                || mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL))
        {
            // trackpad pixels accumulate into wheel steps (a slow scroll's small events add up)
            let steps = wheel_steps(&mut self.wheel_px, dy, row, ev.touch_phase);
            for _ in 0..steps.unsigned_abs() {
                let up = steps > 0;
                if mode.intersects(TermMode::MOUSE_MODE) {
                    let b = if up {
                        keys::MouseButton::WheelUp
                    } else {
                        keys::MouseButton::WheelDown
                    };
                    self.report_mouse(b, MouseKind::Press, ev.position, ev.modifiers, mode);
                } else {
                    let app = mode.contains(TermMode::APP_CURSOR);
                    let seq: &[u8] = match (up, app) {
                        (true, true) => b"\x1bOA",
                        (true, false) => b"\x1b[A",
                        (false, true) => b"\x1bOB",
                        (false, false) => b"\x1b[B",
                    };
                    p.write(seq.to_vec());
                }
            }
            return;
        }
        // the scrollback: whole rows scroll the display, the rest is drawn as an offset
        let mut term = p.term.lock();
        let history = term.history_size() as i32;
        let mut px_total = self.scroll_px + dy;
        let steps = (px_total / row).floor() as i32;
        let before = term.grid().display_offset() as i32;
        if steps != 0 {
            term.scroll_display(Scroll::Delta(steps));
        }
        px_total -= steps as f32 * row;
        let offset = term.grid().display_offset() as i32;
        // clamped at the top / bottom: no partial row past it
        if offset - before != steps || offset >= history {
            px_total = 0.;
        }
        if matches!(ev.touch_phase, TouchPhase::Ended) || matches!(ev.delta, ScrollDelta::Lines(_))
        {
            if px_total > row / 2. && offset < history {
                term.scroll_display(Scroll::Delta(1));
            }
            px_total = 0.;
        }
        self.scroll_px = px_total.max(0.);
        let offset = term.grid().display_offset();
        drop(term);
        if offset > 0 || self.scroll_px > 0. {
            self.scroll_view = true;
        } else if dy < 0. {
            // back at the bottom: the shell has the arrows again (WS)
            self.scroll_view = false;
        }
        cx.notify();
    }

    /// The shown tab got output: find re-searches (coalesced).
    pub(super) fn output_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find_output_changed(window, cx);
    }
}

/// Whole wheel steps in `px` more pixels (+ = up), the remainder kept for the next event; a new
/// gesture starts from zero.
pub(super) fn wheel_steps(acc: &mut f32, px: f32, step: f32, phase: TouchPhase) -> i32 {
    if matches!(phase, TouchPhase::Started) || acc.signum() * px.signum() < 0. {
        *acc = 0.;
    }
    *acc += px;
    let steps = (*acc / step).trunc() as i32;
    *acc -= steps as f32 * step;
    steps
}

impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let marked = self.preedit.clone().unwrap_or_default();
        let units: Vec<u16> = marked.encode_utf16().collect();
        let r = range.start.min(units.len())..range.end.min(units.len());
        *adjusted = Some(r.clone());
        Some(String::from_utf16_lossy(&units[r]))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self
            .preedit
            .as_ref()
            .map_or(0, |m| m.encode_utf16().count());
        Some(UTF16Selection {
            range: end..end,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.preedit.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.preedit = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.preedit = None;
        if text.is_empty() {
            cx.notify();
            return;
        }
        if let Some(h) = self.hold.as_mut() {
            h.keys.push(Held::Text(text.to_owned()));
            return;
        }
        self.send_typed(text.as_bytes().to_vec(), window, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.preedit = (!new_text.is_empty()).then(|| new_text.to_owned());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        self.caret_bounds()
    }

    fn character_index_for_point(
        &mut self,
        _point: gpui_kit::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}
