//! VS Code's minimap (`editor.minimap`; on with Feel vscode): a full-window layer drawing,
//! right of each code split's grid ([`crate::shell::WinRect::minimap`], the room the
//! layout leaves), the file's lines in small coloured as the editor colours them, the visible
//! part as a slider while the pointer is over it. A click off the slider centres the clicked line,
//! dragging the slider scrolls by its ratio, the wheel over it scrolls the split (VS Code's).
//!
//! - Data: where the slider is and which lines the minimap shows come from nvim's own
//!   `win_viewport` (the redraw state, [`model::layout`]), so they never wait for Lua; the lines
//!   themselves from `config/app/minimap.lua`: Rust asks for the span a window's minimap shows
//!   when what it has doesn't cover it (`want`), Lua answers `lines` (one byte a column,
//!   [`model::Shapes`]) and sends them again after an edit once typing rests. Rust tells it on /
//!   off (`enable`) and scrolls through it (`scroll`, the window's topline).
//! - Cheap: Lua keeps the lines it made for the buffer's text as it is (a scroll makes only the
//!   new ones); a window's picture (its runs, [`model::runs`], as one image in device pixels, as
//!   VS Code's canvas) is made again only when its lines came anew or the minimap scrolled to
//!   other lines; a frame paints the one image and the slider.

mod model;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    App, Bounds, Context, Corners, DispatchPhase, FocusHandle, Focusable, Hitbox, HitboxBehavior,
    Hsla, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement as _, Pixels, Point, Render, RenderImage, Rgba, ScrollWheelEvent, Styled as _,
    Task, WeakEntity, Window, canvas, div, fill, point, px, size,
};
use rmpv::Value;
use serde::Deserialize;

use crate::factory::Feel;
use crate::look;
use crate::nvim::lua;
use crate::shell::{Surface, SurfaceCx};

use model::{CHAR_W, Layout, Run, Shapes};
pub use model::{LINE_H, layout, top_for_drag};

/// Lua's module.
const LUA: &str = "config.app.minimap";
/// VS Code hides the slider this long after the pointer left the minimap (`_hideSoon`).
const HIDE_AFTER: Duration = Duration::from_millis(500);
/// A minimap character's ink: VS Code's prerendered glyphs cover about three of a line's four
/// device rows at about this strength.
const INK_HEIGHT: f32 = LINE_H * 0.75;
const INK_ALPHA: f32 = 0.75;

/// VS Code's slider colours (`minimapSlider.*`: the scrollbar slider's at half): dark themes'
/// `#797979` 40 % / `#646464` 70 % / `#BFBFBF` 40 %, light themes' `#646464` 40 % / 70 % /
/// `#000000` 60 %.
fn slider_color(state: Slider) -> Hsla {
    let bg = look::EDITOR_BG.rgba();
    let dark = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b < 0.5;
    let (rgb, a) = match (dark, state) {
        (true, Slider::Shown) => (0x797979, 0.4),
        (true, Slider::Hovered) => (0x646464, 0.7),
        (true, Slider::Dragged) => (0xbfbfbf, 0.4),
        (false, Slider::Shown) => (0x646464, 0.4),
        (false, Slider::Hovered) => (0x646464, 0.7),
        (false, Slider::Dragged) => (0x000000, 0.6),
    };
    with_alpha(rgb, a * 0.5)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slider {
    Shown,
    Hovered,
    Dragged,
}

fn with_alpha(rgb: u32, a: f32) -> Hsla {
    let mut c: Hsla = gpui_kit::rgb(rgb).into();
    c.a = a;
    c
}

/// The Feel's `editor.minimap` (off until the bridge says): the editor's layout leaves the room,
/// this layer draws in it.
pub fn wanted(cx: &App) -> bool {
    cx.try_global::<Feel>().is_some_and(|f| f.editor.minimap)
}

/// Lua -> Rust (`config/app/minimap.lua`).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event {
    Lines {
        win: i64,
        buf: i64,
        tick: i64,
        total: usize,
        from: usize,
        lines: Vec<String>,
        palette: Vec<u32>,
    },
}

/// A window's lines and the number they came with (a cache key).
struct Data {
    generation: u64,
    shapes: Shapes,
    colors: Vec<Rgba>,
}

/// What a picture was made of: the lines' generation, the span, the columns, the scale.
#[derive(Clone, Copy, Debug, PartialEq)]
struct PictureKey {
    generation: u64,
    start: usize,
    end: usize,
    cols: usize,
    /// Device pixels a px.
    scale: f32,
}

/// A window's picture of one span of lines: its runs, painted as one image.
struct Picture {
    key: PictureKey,
    runs: Vec<Run>,
    colors: Vec<Rgba>,
    image: Option<Arc<RenderImage>>,
    /// The image's size in px.
    size: (f32, f32),
}

impl Picture {
    fn new(key: PictureKey, runs: Vec<Run>, colors: Vec<Rgba>) -> Picture {
        let size = (
            key.cols as f32 * CHAR_W,
            (key.end - key.start) as f32 * LINE_H,
        );
        let image = paint_runs(&runs, &colors, size, key.scale.max(1.));
        Picture {
            key,
            runs,
            colors,
            image,
            size,
        }
    }
}

/// The runs in device pixels (straight BGRA, GPUI's image format): each one `INK_HEIGHT` of its
/// line, the colour at [`INK_ALPHA`].
fn paint_runs(
    runs: &[Run],
    colors: &[Rgba],
    size: (f32, f32),
    scale: f32,
) -> Option<Arc<RenderImage>> {
    let (w, h) = (
        (size.0 * scale).ceil() as u32,
        (size.1 * scale).ceil() as u32,
    );
    if w == 0 || h == 0 {
        return None;
    }
    let mut buf = image::RgbaImage::new(w, h);
    let stride = w as usize * 4;
    let raw: &mut [u8] = &mut buf;
    for r in runs {
        let Some(c) = colors.get(r.color as usize) else {
            continue;
        };
        let px = [
            (c.b * 255.) as u8,
            (c.g * 255.) as u8,
            (c.r * 255.) as u8,
            (INK_ALPHA * 255.) as u8,
        ];
        let x0 = ((r.col as f32 * CHAR_W * scale) as usize).min(w as usize);
        let x1 = (((r.col + r.len) as f32 * CHAR_W * scale) as usize).min(w as usize);
        let y0 = (r.row as f32 * LINE_H * scale) as usize;
        let y1 = ((r.row as f32 * LINE_H + INK_HEIGHT) * scale) as usize;
        for y in y0..y1.min(h as usize) {
            for p in raw[y * stride + x0 * 4..y * stride + x1 * 4]
                .as_chunks_mut::<4>()
                .0
            {
                p.copy_from_slice(&px);
            }
        }
    }
    Some(Arc::new(RenderImage::new([image::Frame::new(buf)])))
}

/// One minimap as this frame draws it.
#[derive(Clone)]
struct Drawn {
    win: i64,
    rect: Bounds<Pixels>,
    /// The split's text area (a wheel over the minimap scrolls it).
    grid_area: Bounds<Pixels>,
    layout: Layout,
    top: usize,
    rows: usize,
    total: usize,
    picture: Option<Rc<Picture>>,
}

/// A slider drag: where it started.
#[derive(Clone, Copy, Debug)]
struct Drag {
    win: i64,
    y0: Pixels,
    top0: usize,
    layout: Layout,
    total: usize,
    /// The top line last asked for.
    asked: usize,
}

pub struct MinimapView {
    scx: SurfaceCx,
    focus: FocusHandle,
    data: HashMap<i64, Data>,
    generation: u64,
    pictures: RefCell<HashMap<i64, Rc<Picture>>>,
    /// Pictures' images no longer drawn: out of the window's atlas at the next paint.
    retired: RefCell<Vec<Arc<RenderImage>>>,
    frame: Rc<RefCell<Vec<Drawn>>>,
    /// What Lua was told last: on / off.
    told: Option<bool>,
    /// The span asked of Lua per window (first, end, line count) until lines covering it came.
    asked: HashMap<i64, (usize, usize, usize)>,
    /// The minimap whose slider shows (the pointer over it, or until [`HIDE_AFTER`]).
    shown: Option<i64>,
    /// The pointer is over the shown slider.
    on_slider: bool,
    hide: Option<Task<()>>,
    drag: Option<Drag>,
    _subs: Vec<gpui_kit::Subscription>,
}

impl MinimapView {
    /// Lines reported for `win` (tests).
    pub fn shapes(&self, win: i64) -> Option<&Shapes> {
        self.data.get(&win).map(|d| &d.shapes)
    }

    /// The windows drawn with a minimap last frame and their first / end lines (tests).
    pub fn drawn(&self) -> Vec<(i64, Bounds<Pixels>, usize, usize)> {
        self.frame
            .borrow()
            .iter()
            .map(|d| (d.win, d.rect, d.layout.start, d.layout.end))
            .collect()
    }

    /// Where `win`'s slider is drawn (window coordinates; tests).
    pub fn slider(&self, win: i64) -> Option<Bounds<Pixels>> {
        self.frame
            .borrow()
            .iter()
            .find(|d| d.win == win)
            .map(slider_bounds)
    }

    /// The runs `win`'s minimap paints last frame (tests).
    pub fn runs(&self, win: i64) -> Vec<(Run, Hsla)> {
        self.frame
            .borrow()
            .iter()
            .find(|d| d.win == win)
            .and_then(|d| d.picture.clone())
            .map(|p| {
                p.runs
                    .iter()
                    .map(|r| (*r, p.colors[r.color as usize].into()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether the slider shows on `win` now (tests).
    pub fn slider_shown(&self, win: i64) -> bool {
        self.shown == Some(win) || self.drag.is_some_and(|d| d.win == win)
    }

    /// Tells Lua on / off when that changed.
    fn tell(&mut self, cx: &App) {
        let on = wanted(cx);
        if self.told == Some(on) {
            return;
        }
        if !on {
            self.data.clear();
            let mut pictures = self.pictures.borrow_mut();
            let images = pictures.drain().filter_map(|(_, p)| p.image.clone());
            self.retired.borrow_mut().extend(images);
        }
        self.asked.clear();
        self.told = Some(on);
        self.scx.call(LUA, "enable", vec![on.into()]);
    }

    /// Asks Lua for the lines each minimap shows, half a minimap more each side (a scroll stays
    /// covered for a while), where what it sent doesn't cover them.
    fn ask(&mut self, frame: &[Drawn]) {
        for d in frame {
            let span = (d.layout.start, d.layout.end, d.total);
            let covered = self.data.get(&d.win).is_some_and(|data| {
                let s = &data.shapes;
                s.total == d.total && s.from <= span.0 && s.from + s.lines.len() >= span.1
            });
            if covered {
                self.asked.remove(&d.win);
            } else if self.asked.get(&d.win) != Some(&span) {
                self.asked.insert(d.win, span);
                let margin = (span.1 - span.0) / 2;
                let (from, to) = (
                    span.0.saturating_sub(margin),
                    (span.1 + margin).min(d.total),
                );
                self.scx.call(
                    LUA,
                    "want",
                    vec![d.win.into(), (from as u64).into(), (to as u64).into()],
                );
            }
        }
    }

    /// This frame's minimaps: the layout's rects, nvim's viewports, Lua's lines.
    fn build(&self, scale: f32, cx: &App) -> Vec<Drawn> {
        let Some(ws) = self.scx.workspace.upgrade() else {
            return Vec::new();
        };
        let editor = ws.read(cx).editor().read(cx);
        let ui = editor.ui();
        let geo = self.scx.geometry();
        let mut out = Vec::new();
        for w in &geo.layout.wins {
            let (Some(rect), None) = (w.minimap, w.role) else {
                continue;
            };
            let (Some(win), Some(grid)) = (ui.windows.get(&w.grid), ui.grids.get(&w.grid)) else {
                continue;
            };
            let Some(vp) = win.viewport else { continue };
            let total = vp.line_count.max(1) as usize;
            let top = vp.topline.max(0) as usize;
            // the buffer lines on screen (closed folds show more than their rows); at the end
            // of the file the rows (VS Code's viewport height with `scrollBeyondLastLine`)
            let rows = if (vp.botline as usize) < total {
                (vp.botline - vp.topline).max(1) as usize
            } else {
                win.text_rows(grid.height).len()
            };
            let layout = model::layout(rect.size.height.as_f32(), top, rows, total);
            let picture = self.data.get(&w.win).map(|d| {
                let cols = (rect.size.width.as_f32() / CHAR_W).floor() as usize;
                let key = PictureKey {
                    generation: d.generation,
                    start: layout.start,
                    end: layout.end,
                    cols,
                    scale,
                };
                let mut pictures = self.pictures.borrow_mut();
                match pictures.get(&w.win) {
                    Some(p) if p.key == key => p.clone(),
                    _ => {
                        let runs = model::runs(&d.shapes, &layout, cols);
                        let p = Rc::new(Picture::new(key, runs, d.colors.clone()));
                        if let Some(old) = pictures.insert(w.win, p.clone())
                            && let Some(image) = old.image.clone()
                        {
                            self.retired.borrow_mut().push(image);
                        }
                        p
                    }
                }
            });
            out.push(Drawn {
                win: w.win,
                rect,
                grid_area: w.grid_area,
                layout,
                top,
                rows,
                total,
                picture,
            });
        }
        out
    }

    fn mouse_down(&mut self, ev: &MouseDownEvent, reachable: bool, cx: &mut Context<Self>) -> bool {
        if !reachable || ev.button != MouseButton::Left {
            return false;
        }
        let Some(d) = self.at(ev.position) else {
            return false;
        };
        let y = (ev.position.y - d.rect.top()).as_f32();
        if d.layout.on_slider(y) {
            self.drag = Some(Drag {
                win: d.win,
                y0: ev.position.y,
                top0: d.top,
                layout: d.layout,
                total: d.total,
                asked: d.top,
            });
        } else {
            let top = model::top_for_click(&d.layout, y, d.rows, d.total);
            self.scroll(d.win, top);
        }
        cx.notify();
        true
    }

    fn mouse_moved(&mut self, ev: &MouseMoveEvent, reachable: bool, cx: &mut Context<Self>) {
        if let Some(mut drag) = self.drag {
            if ev.pressed_button != Some(MouseButton::Left) {
                // released outside the window: no mouse up came
                self.end_drag(cx);
                return;
            }
            let dy = (ev.position.y - drag.y0).as_f32();
            let top = model::top_for_drag(&drag.layout, drag.top0, dy, drag.total);
            if top != drag.asked {
                drag.asked = top;
                self.drag = Some(drag);
                self.scroll(drag.win, top);
            }
            return;
        }
        let over = reachable.then(|| self.at(ev.position)).flatten();
        let win = over.as_ref().map(|d| d.win);
        let on_slider = over
            .as_ref()
            .is_some_and(|d| d.layout.on_slider((ev.position.y - d.rect.top()).as_f32()));
        if win.is_some() {
            self.hide = None;
            if self.shown != win || self.on_slider != on_slider {
                self.shown = win;
                self.on_slider = on_slider;
                cx.notify();
            }
        } else if self.shown.is_some() && self.hide.is_none() {
            if std::mem::take(&mut self.on_slider) {
                cx.notify();
            }
            self.hide_soon(cx);
        }
    }

    fn hide_soon(&mut self, cx: &mut Context<Self>) {
        self.hide = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HIDE_AFTER).await;
            let _ = this.update(cx, |v, cx| {
                v.hide = None;
                v.shown = None;
                cx.notify();
            });
        }));
    }

    /// The slider stays shown on its minimap: the next pointer move off it hides it.
    fn end_drag(&mut self, cx: &mut Context<Self>) {
        if let Some(d) = self.drag.take() {
            self.shown = Some(d.win);
            cx.notify();
        }
    }

    /// A wheel over a minimap scrolls its split: the editor gets it over the split's text.
    fn wheel(&mut self, ev: &ScrollWheelEvent, reachable: bool, cx: &mut Context<Self>) -> bool {
        let Some(d) = reachable.then(|| self.at(ev.position)).flatten() else {
            return false;
        };
        let Some(ws) = self.scx.workspace.upgrade() else {
            return false;
        };
        let mut moved = ev.clone();
        let x = d.grid_area.left() + d.grid_area.size.width / 2.;
        let y = ev
            .position
            .y
            .clamp(d.grid_area.top(), d.grid_area.bottom() - px(1.));
        moved.position = point(x, y);
        let editor = ws.read(cx).editor().clone();
        editor.update(cx, |e, cx| e.on_scroll(&moved, cx));
        true
    }

    fn at(&self, pos: Point<Pixels>) -> Option<Drawn> {
        self.frame
            .borrow()
            .iter()
            .find(|d| d.rect.contains(&pos))
            .cloned()
    }

    fn scroll(&self, win: i64, top: usize) {
        self.scx
            .call(LUA, "scroll", vec![win.into(), (top as u64).into()]);
    }

    fn slider_state(&self, win: i64) -> Option<Slider> {
        if self.drag.is_some_and(|d| d.win == win) {
            return Some(Slider::Dragged);
        }
        (self.shown == Some(win)).then_some(if self.on_slider {
            Slider::Hovered
        } else {
            Slider::Shown
        })
    }
}

fn slider_bounds(d: &Drawn) -> Bounds<Pixels> {
    let top = d.rect.top() + px(d.layout.slider_top);
    let bottom = (top + px(d.layout.slider_height)).min(d.rect.bottom());
    Bounds::new(
        point(d.rect.left(), top),
        size(d.rect.size.width, (bottom - top).max(px(0.))),
    )
}

impl Surface for MinimapView {
    const NAME: &'static str = "minimap";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let feel = cx.observe_global::<Feel>(|v: &mut Self, cx| {
            v.tell(cx);
            cx.notify();
        });
        MinimapView {
            scx,
            focus: cx.focus_handle(),
            data: HashMap::new(),
            generation: 0,
            pictures: RefCell::default(),
            retired: RefCell::default(),
            frame: Rc::default(),
            told: None,
            asked: HashMap::new(),
            shown: None,
            on_slider: false,
            hide: None,
            drag: None,
            _subs: vec![feel],
        }
    }

    fn on_lua(&mut self, payload: Value, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(Event::Lines {
            win,
            buf,
            tick,
            total,
            from,
            lines,
            palette,
        }) = lua::decode::<Event>(Self::NAME, payload)
        else {
            return;
        };
        if !wanted(cx) {
            return;
        }
        self.generation += 1;
        let colors = palette.iter().map(|c| gpui_kit::rgb(*c)).collect();
        self.data.insert(
            win,
            Data {
                generation: self.generation,
                shapes: Shapes {
                    buf,
                    tick,
                    total,
                    from,
                    lines: lines
                        .into_iter()
                        .map(|l| l.into_bytes().into_boxed_slice())
                        .collect(),
                    palette,
                },
                colors,
            },
        );
        cx.notify();
    }
}

impl Focusable for MinimapView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for MinimapView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.tell(cx);
        // windows gone: their lines go too
        let geo = self.scx.geometry();
        self.data
            .retain(|win, _| geo.layout.wins.iter().any(|w| w.win == *win));
        {
            let (mut pictures, mut retired) =
                (self.pictures.borrow_mut(), self.retired.borrow_mut());
            pictures.retain(|win, p| {
                let keep = self.data.contains_key(win);
                if !keep && let Some(image) = p.image.clone() {
                    retired.push(image);
                }
                keep
            });
        }
        self.asked
            .retain(|win, _| geo.layout.wins.iter().any(|w| w.win == *win));
        let drawn = self.build(window.scale_factor(), cx);
        self.ask(&drawn);
        *self.frame.borrow_mut() = drawn;
        let weak: WeakEntity<Self> = cx.entity().downgrade();
        let (w1, w2) = (weak.clone(), weak);
        let layer = canvas(
            move |_, window, cx| {
                let Some(this) = w1.upgrade() else {
                    return Vec::<Hitbox>::new();
                };
                let v = this.read(cx);
                v.frame
                    .borrow()
                    .iter()
                    .map(|d| window.insert_hitbox(d.rect, HitboxBehavior::Normal))
                    .collect()
            },
            move |_, hits, window, cx| {
                let Some(this) = w2.upgrade() else { return };
                {
                    let v = this.read(cx);
                    for image in v.retired.borrow_mut().drain(..) {
                        let _ = window.drop_image(image);
                    }
                    for d in v.frame.borrow().iter() {
                        paint(d, v.slider_state(d.win), window);
                    }
                }
                let weak = this.downgrade();
                // popups / menus / floats above occlude: what's under them isn't hovered or clicked
                let hits = Rc::new(hits);
                let reachable = move |pos: Point<Pixels>, window: &Window| {
                    hits.iter().any(|h| h.is_hovered_at(pos, window))
                };
                let reachable = Rc::new(reachable);
                window.on_mouse_event({
                    let (weak, reachable) = (weak.clone(), reachable.clone());
                    move |ev: &MouseDownEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble {
                            let r = reachable(ev.position, window);
                            if weak
                                .update(cx, |v, cx| v.mouse_down(ev, r, cx))
                                .unwrap_or(false)
                            {
                                cx.stop_propagation();
                            }
                        }
                    }
                });
                window.on_mouse_event({
                    let (weak, reachable) = (weak.clone(), reachable.clone());
                    move |ev: &MouseMoveEvent, phase, window, cx| {
                        if phase == DispatchPhase::Bubble {
                            let r = reachable(ev.position, window);
                            let _ = weak.update(cx, |v, cx| v.mouse_moved(ev, r, cx));
                        }
                    }
                });
                window.on_mouse_event({
                    let weak = weak.clone();
                    move |_: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Bubble
                            && weak
                                .update(cx, |v, cx| {
                                    let dragging = v.drag.is_some();
                                    v.end_drag(cx);
                                    dragging
                                })
                                .unwrap_or(false)
                        {
                            cx.stop_propagation();
                        }
                    }
                });
                window.on_mouse_event(move |ev: &ScrollWheelEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble {
                        let r = reachable(ev.position, window);
                        if weak.update(cx, |v, cx| v.wheel(ev, r, cx)).unwrap_or(false) {
                            cx.stop_propagation();
                        }
                    }
                });
            },
        )
        .absolute()
        .size_full();
        div().absolute().size_full().child(layer)
    }
}

fn paint(d: &Drawn, slider: Option<Slider>, window: &mut Window) {
    window.with_content_mask(Some(gpui_kit::ContentMask { bounds: d.rect }), |window| {
        if let Some(p) = &d.picture
            && let Some(image) = &p.image
        {
            let b = Bounds::new(d.rect.origin, size(px(p.size.0), px(p.size.1)));
            let _ = window.paint_image(b, b, Corners::default(), image.clone(), 0, false);
        }
        if let Some(state) = slider {
            window.paint_quad(fill(slider_bounds(d), slider_color(state)));
        }
    });
}
