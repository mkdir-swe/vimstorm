//! `,G` in the app: lazygit in a native floating terminal, placed like snacks' lazygit float (90 %
//! of the body, centered, the rest dimmed: snacks' backdrop 60) in a popup frame. It has the
//! keyboard while it's up: every key goes to lazygit (Esc too); Cmd combos stay global shortcuts
//! (Cmd+V pastes). The mouse reaches lazygit (its mouse mode); clicks on the backdrop do nothing.
//! It closes when lazygit exits; the keyboard goes back where it was.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use alacritty_terminal::term::TermMode;
use gpui_kit::{
    AnyElement, Bounds, Context, FocusHandle, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels,
    ScrollDelta, ScrollWheelEvent, Styled as _, Window, anchored, deferred, div, point, px, size,
};

use super::element::{PAD_BOTTOM, PAD_LEFT, PAD_TOP, Shared, TermElement};
use super::keys::{self, MouseKind};
use super::pty::Pty;
use super::{LUA, TerminalView, colors};
use crate::kit;
use crate::kit::notation;
use crate::popups;

/// snacks' float: 90 % of the editor area.
const SHARE: f32 = 0.9;

pub struct Float {
    pub pty: Arc<Pty>,
    pub focus: FocusHandle,
    shared: Rc<Shared>,
    /// A button reported to lazygit (its release goes there too).
    reported: Option<keys::MouseButton>,
    /// Trackpad pixels toward the next wheel step.
    wheel_px: f32,
}

impl TerminalView {
    /// The lazygit float is up.
    pub fn float_open(&self) -> bool {
        self.float.is_some()
    }

    /// The float's rows on screen (tests).
    pub fn float_screen(&self) -> Vec<String> {
        self.float
            .as_ref()
            .map(|f| super::text::screen_lines(&*f.pty.term.lock()))
            .unwrap_or_default()
    }

    /// The float's frame (window coordinates).
    pub fn float_bounds(&self, window: &Window) -> Bounds<Pixels> {
        let body = self.scx.geometry().maximized_rect();
        let body = if body.size.width > px(0.) {
            body
        } else {
            Bounds::new(point(px(0.), px(0.)), window.viewport_size())
        };
        let w = body.size.width * SHARE;
        let h = body.size.height * SHARE;
        Bounds::new(
            point(
                body.origin.x + (body.size.width - w) / 2.,
                body.origin.y + (body.size.height - h) / 2.,
            ),
            size(w, h),
        )
    }

    pub(super) fn open_float(
        &mut self,
        cmd: Vec<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        osc: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.float.is_some() || cmd.is_empty() {
            return;
        }
        let metrics = self.metrics(window, cx);
        let b = self.float_bounds(window);
        let cols = ((b.size.width - px(PAD_LEFT + 2.)) / metrics.cell_width).floor() as u16;
        let rows =
            ((b.size.height - px(PAD_TOP + PAD_BOTTOM + 2.)) / metrics.row_height).floor() as u16;
        let mut env_all = self.env.clone();
        env_all.extend(env.unwrap_or_default());
        let mut cmd = cmd.into_iter();
        let program = cmd.next().unwrap_or_default();
        let args: Vec<String> = cmd.collect();
        let spec = self.spawn_spec(
            Some((program, args)),
            cwd,
            &env_all,
            (cols.max(2), rows.max(1)),
            metrics,
        );
        let id = self.next_id;
        self.next_id += 1;
        match Pty::spawn(id, spec, self.tx.clone()) {
            Ok(pty) => {
                if let Some(osc) = osc.filter(|o| !o.is_empty()) {
                    // as if the terminal had received them (OSC 4: palette entries)
                    let mut parser: alacritty_terminal::vte::ansi::Processor =
                        alacritty_terminal::vte::ansi::Processor::new();
                    parser.advance(&mut *pty.term.lock(), osc.as_bytes());
                }
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                self.float = Some(Float {
                    pty: Arc::new(pty),
                    focus,
                    shared: Rc::default(),
                    reported: None,
                    wheel_px: 0.,
                });
                self.scx.call(LUA, "float", vec![true.into()]);
                cx.notify();
            }
            Err(e) => popups::notify(
                popups::Balloon::error("lazygit", format!("Can't start lazygit: {e}")),
                window,
                cx,
            ),
        }
    }

    /// Bytes for the float's program (Lua: the `q` lazygit's nvim-remote edit sends to nvim).
    pub(super) fn float_send(&mut self, text: String) {
        if let Some(f) = &self.float {
            f.pty.write(text.into_bytes());
        }
    }

    /// lazygit exited: the float goes, the keyboard back to where nvim is.
    pub(super) fn close_float(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.float.take() else {
            return;
        };
        let had = f.focus.contains_focused(window, cx);
        self.scx.call(LUA, "float", vec![false.into()]);
        if had {
            self.scx.focus_editor(window, cx);
        }
        cx.notify();
    }

    fn float_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.float.as_ref() else {
            return;
        };
        let note = notation(ev).unwrap_or_default();
        if note == "<D-v>" {
            self.paste_clipboard(window, cx);
            cx.stop_propagation();
            return;
        }
        let k = &ev.keystroke;
        if k.modifiers.control && k.key == "tab" {
            return;
        }
        let mode = *f.pty.term.lock().mode();
        if let Some(bytes) = keys::encode_in(k, mode) {
            f.pty.write(bytes);
            cx.stop_propagation();
        } else if k.modifiers.control {
            cx.stop_propagation();
        }
    }

    fn float_mouse(
        &mut self,
        button: Option<keys::MouseButton>,
        kind: MouseKind,
        pos: gpui_kit::Point<Pixels>,
        m: gpui_kit::Modifiers,
    ) {
        let Some(f) = self.float.as_mut() else {
            return;
        };
        let mode = *f.pty.term.lock().mode();
        if !mode.intersects(TermMode::MOUSE_MODE) {
            return;
        }
        let Some(layout) = f.shared.layout.get() else {
            return;
        };
        let (row, col, _) = layout.cell_at(pos);
        let button = match (kind, button) {
            (MouseKind::Press, Some(b)) => {
                f.reported = Some(b);
                b
            }
            (MouseKind::Release, _) => match f.reported.take() {
                Some(b) => b,
                None => return,
            },
            (MouseKind::Motion, b) => {
                // a drag lazygit got the press of goes on outside the frame
                let wants = match b {
                    Some(_) => {
                        f.reported.is_some()
                            && mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION)
                    }
                    None => mode.contains(TermMode::MOUSE_MOTION),
                };
                if !wants {
                    return;
                }
                b.unwrap_or(keys::MouseButton::None)
            }
            (MouseKind::Press, None) => return,
        };
        if let Some(bytes) = keys::mouse_report(
            button,
            kind,
            col,
            row,
            m,
            mode.contains(TermMode::SGR_MOUSE),
            mode.contains(TermMode::UTF8_MOUSE),
        ) {
            f.pty.write(bytes);
        }
    }

    /// Moves anywhere in the window (the float's grid element listens at the window).
    pub(super) fn float_mouse_move(
        &mut self,
        ev: &MouseMoveEvent,
        inside: bool,
        _cx: &mut Context<Self>,
    ) {
        let button = ev.pressed_button.and_then(report_button);
        if button.is_none() && !inside {
            return;
        }
        self.float_mouse(button, MouseKind::Motion, ev.position, ev.modifiers);
    }

    /// Releases anywhere in the window: lazygit hears the release of a press it got.
    pub(super) fn float_mouse_up(&mut self, ev: &MouseUpEvent, _cx: &mut Context<Self>) {
        self.float_mouse(
            report_button(ev.button),
            MouseKind::Release,
            ev.position,
            ev.modifiers,
        );
    }

    pub(super) fn render_float(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        self.float.as_ref()?;
        let metrics = self.metrics(window, cx);
        let b = self.float_bounds(window);
        let f = self.float.as_ref()?;
        let vp = window.viewport_size();
        let focused = f.focus.is_focused(window);
        let grid = TermElement {
            pty: f.pty.clone(),
            view: Some(cx.entity()),
            input_focus: f.focus.clone(),
            focused,
            metrics,
            scroll_px: 0.,
            matches: Rc::default(),
            current: None,
            preedit: if focused { self.preedit.clone() } else { None },
            shared: f.shared.clone(),
            float: true,
        };
        let mut frame = kit::popup_frame()
            .id("terminal-float")
            .debug_selector(|| "terminal-float".into())
            .track_focus(&f.focus)
            .absolute()
            .left(b.origin.x)
            .top(b.origin.y)
            .w(b.size.width)
            .h(b.size.height)
            .bg(gpui_kit::rgb(colors::palette().background))
            .on_key_down(cx.listener(Self::float_key))
            .on_scroll_wheel(cx.listener(move |v, ev: &ScrollWheelEvent, _, cx| {
                // trackpad pixels accumulate into wheel steps (slow scrolls add up)
                let dy = match ev.delta {
                    ScrollDelta::Lines(l) => l.y * ROW * 3.,
                    ScrollDelta::Pixels(p) => p.y.as_f32(),
                };
                let Some(f) = v.float.as_mut() else {
                    return;
                };
                let lines = super::input::wheel_steps(&mut f.wheel_px, dy, ROW, ev.touch_phase);
                let b = if lines > 0 {
                    keys::MouseButton::WheelUp
                } else {
                    keys::MouseButton::WheelDown
                };
                for _ in 0..lines.unsigned_abs() {
                    v.float_mouse(Some(b), MouseKind::Press, ev.position, ev.modifiers);
                    if let Some(f) = v.float.as_mut() {
                        f.reported = None;
                    }
                }
                cx.stop_propagation();
            }))
            .child(grid);
        for mb in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
            frame = frame.on_mouse_down(
                mb,
                cx.listener(move |v, ev: &MouseDownEvent, window, cx| {
                    if let Some(f) = v.float.as_ref() {
                        window.focus(&f.focus.clone(), cx);
                    }
                    v.float_mouse(
                        report_button(ev.button),
                        MouseKind::Press,
                        ev.position,
                        ev.modifiers,
                    );
                    cx.stop_propagation();
                }),
            );
        }
        Some(
            deferred(
                anchored().position(point(px(0.), px(0.))).child(
                    div()
                        .id("terminal-float-backdrop")
                        .relative()
                        .w(vp.width)
                        .h(vp.height)
                        .bg(gpui_kit::rgba(colors::palette().backdrop))
                        .occlude()
                        .on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, _, cx| {
                            cx.stop_propagation()
                        })
                        .child(frame),
                ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

fn report_button(b: MouseButton) -> Option<keys::MouseButton> {
    match b {
        MouseButton::Left => Some(keys::MouseButton::Left),
        MouseButton::Middle => Some(keys::MouseButton::Middle),
        MouseButton::Right => Some(keys::MouseButton::Right),
        _ => None,
    }
}

/// Trackpad pixels per wheel step in the float.
const ROW: f32 = 18.;
