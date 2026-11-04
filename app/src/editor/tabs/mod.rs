//! Editor tab bars (one per editor split, in its island's tab bar slot) and the empty editor's
//! Abe face (Abraham's head, 128 px at 12 %, one dim line under it saying where the shown
//! story stands, [`StoryLines`]; no key tips), like WebStorm's New UI (Islands): Inter, file icon per tab, labels colored by git status
//! (dimmed on unselected tabs), a red wavy underline for files with errors, the selected tab a
//! rounded outlined box (blue in the split with the keyboard, gray in the others), close button
//! on the selected / hovered tab, a hidden tabs button when they don't all fit.
//!
//! The tabs are Lua's (`config/editor_tabs.lua`): `config/app/tabs.lua` sends every split's bar
//! when something it shows changed (never per keystroke). Mouse: click activates, × / middle-click
//! closes, right-click opens the tab menu (`config/context.lua`, through the menu surface), the
//! hidden tabs button lists the hidden tabs; all call back into `config/app/tabs.lua`. Keys stay
//! Lua's (tab cycling, closing): Rust only redraws.
//!
//! Slots: `scx.geometry().slots()` (window coordinates, re-read every render: they move with
//! every layout).

mod layout;

use std::collections::HashMap;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Bounds, Context, FocusHandle, Focusable, Font, InteractiveElement as _,
    IntoElement, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Render, Rgba,
    SharedString, StatefulInteractiveElement as _, Styled as _, StyledText, TextRun,
    UnderlineStyle, Window, div, font, point, px, size,
};
use rmpv::Value;
use serde::{Deserialize, Deserializer};

use crate::kit::{self, Icon, IconName};
use crate::look;
use crate::nvim::lua;
use crate::render::UI_FONT;
use crate::shell::{EditorSlot, ISLAND_RADIUS};
use crate::shell::{Surface, SurfaceCx};

/// Lua's module the bars call back into.
const LUA: &str = "config.app.tabs";

/// A tab of a split (`config/app/tabs.lua` AppTab).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Tab {
    pub buf: i64,
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// Git file status word ("Modified", "Added", ...; "" unchanged).
    #[serde(default)]
    pub status: String,
    /// Compiler errors in the file.
    #[serde(default)]
    pub error: bool,
    /// Read-only: WebStorm's lock over the icon (a Cloud workspace's files while the cloud agent
    /// drives, K-19).
    #[serde(default)]
    pub readonly: bool,
    /// Edited, not saved: the Feel's `tabs.dirtyDot` draws ● in the ×'s place.
    #[serde(default)]
    pub modified: bool,
    /// VS Code's preview tab (`tabs.preview`): italic, replaced by the next single-click open.
    #[serde(default)]
    pub preview: bool,
}

/// What a tab draws in its close button's place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseMark {
    None,
    Close,
    /// `tabs.dirtyDot` (VS Code): a modified tab not under the mouse.
    Dirty,
}

/// The close button's mark: × on a lit tab (selected or hovered); with `dirty_dot` a modified
/// tab's ● whenever the mouse isn't on it (VS Code), selected or not.
pub fn close_mark(tab: &Tab, lit: bool, hovered: bool, dirty_dot: bool) -> CloseMark {
    if dirty_dot && tab.modified && !hovered {
        CloseMark::Dirty
    } else if lit {
        CloseMark::Close
    } else {
        CloseMark::None
    }
}

/// A split's tab bar (`config/app/tabs.lua` AppTabBar).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Bar {
    pub win: i64,
    #[serde(default, deserialize_with = "seq")]
    pub tabs: Vec<Tab>,
    /// Buffer of the active tab.
    #[serde(default)]
    pub active: Option<i64>,
    /// The split has the keyboard (selected tab blue, else gray).
    #[serde(default)]
    pub focused: bool,
    /// Feel vscode's breadcrumbs: the active file's folders, name and the symbols around
    /// its caret, drawn in the strip the layout keeps under the bar.
    #[serde(default)]
    pub crumbs: Option<Crumbs>,
}

/// A split's breadcrumbs (`config/statusline.lua` `breadcrumbs(win)`): the file's folders from the
/// project down, its name, the declarations around the split's caret (outermost first).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Crumbs {
    #[serde(default, deserialize_with = "seq")]
    pub folders: Vec<String>,
    #[serde(default)]
    pub file: String,
    #[serde(default, deserialize_with = "seq")]
    pub symbols: Vec<crate::editor::statusbar::Symbol>,
}

impl Crumbs {
    /// The parts as drawn, left to right.
    pub fn parts(&self) -> Vec<String> {
        let mut v = self.folders.clone();
        if !self.file.is_empty() {
            v.push(self.file.clone());
        }
        v.extend(self.symbols.iter().map(|s| s.name.clone()));
        v
    }
}

/// One run of a story line: its words and, for a state mark (`●`), its hue (else dim).
#[derive(Clone, Debug, PartialEq)]
pub struct LineSpan {
    pub text: String,
    pub hue: Option<Rgba>,
}

/// Where each workspace's story stands, one line (`cart total ignores quantity · Build ● Running`,
/// the dot in its state's hue), by its root: what the empty editor says under Abe's face. Set by
/// whoever knows the stories (the bridge's workspace list); none for a plain project.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StoryLines(pub HashMap<std::path::PathBuf, Vec<LineSpan>>);

impl gpui_kit::Global for StoryLines {}

/// The story line of the workspace at `root`, if it has one.
pub fn story_line(root: &std::path::Path, cx: &App) -> Option<Vec<LineSpan>> {
    cx.try_global::<StoryLines>()
        .and_then(|l| l.0.get(root).cloned())
        .filter(|l| l.iter().any(|s| !s.text.trim().is_empty()))
}

/// `vimstorm.tabs` (config/app/tabs.lua).
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum TabsEvent {
    Bars {
        #[serde(deserialize_with = "seq")]
        bars: Vec<Bar>,
    },
    Focus,
}

/// A list Lua may send as an empty table (msgpack: an empty map).
pub(crate) fn seq<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Seq<T> {
        List(Vec<T>),
        Empty {},
    }
    Ok(match Seq::<T>::deserialize(d)? {
        Seq::List(v) => v,
        Seq::Empty {} => Vec::new(),
    })
}

/// The hidden tabs button's side insets.
const MORE_PAD: f32 = 6.;

/// A drawn tab (window coordinates): what tests click and the press handler hit-tests.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabRects {
    pub win: i64,
    pub buf: i64,
    /// The tab (outer: hover / click area).
    pub tab: Bounds<Pixels>,
    /// The close button's 16 px box.
    pub close: Bounds<Pixels>,
}

/// Look of one tab.
#[derive(Clone, Copy)]
struct TabLook {
    selected: bool,
    focused: bool,
    hovered: bool,
    box_y: f32,
    box_h: f32,
    strip_h: f32,
}

pub struct TabsView {
    scx: SurfaceCx,
    focus: FocusHandle,
    bars: HashMap<i64, Bar>,
    /// (win, buf) of the tab under the mouse.
    hover: Option<(i64, i64)>,
    /// The mouse is on the hovered tab's ×.
    hover_close: bool,
    /// Label widths by label (the font never changes).
    widths: HashMap<SharedString, f32>,
    /// What the last render drew.
    drawn: Vec<TabRects>,
    more: HashMap<i64, Bounds<Pixels>>,
    /// Px kept free at a bar's right end, by window (the markdown mode toolbar).
    reserved: HashMap<i64, f32>,
    /// What the project's folder is (read once): the face's caption without a story line.
    checkout: Checkout,
}

/// What a project's folder is, by its `.git`: a main checkout (a folder), a worktree (a file),
/// or neither.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checkout {
    Main,
    Worktree,
    Plain,
}

impl Checkout {
    pub fn of(root: &std::path::Path) -> Checkout {
        match std::fs::metadata(root.join(".git")) {
            Ok(m) if m.is_dir() => Checkout::Main,
            Ok(m) if m.is_file() => Checkout::Worktree,
            _ => Checkout::Plain,
        }
    }

    /// The face's caption with no story line: a worktree has no session (a story's
    /// workspace says its own line), the main checkout says so, a plain folder nothing.
    pub fn caption(self) -> Option<&'static str> {
        match self {
            Checkout::Main => Some("Main checkout"),
            Checkout::Worktree => Some("No session"),
            Checkout::Plain => None,
        }
    }
}

/// What the empty editor's face draws in an island of `w` × `h`: the head and its
/// caption; under 200×200 the caption only; under 80 tall nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaceFit {
    Whole,
    CaptionOnly,
    Nothing,
}

pub fn face_fit(w: f32, h: f32) -> FaceFit {
    if h < look::EMPTY_FACE_MIN_HEIGHT {
        FaceFit::Nothing
    } else if w < look::EMPTY_FACE_ROOM || h < look::EMPTY_FACE_ROOM {
        FaceFit::CaptionOnly
    } else {
        FaceFit::Whole
    }
}

/// A git status word's label color (`config/app/tabs.lua`; the tree's colors).
pub fn status_color(status: &str) -> Rgba {
    crate::git::FileStatus::from_word(status)
        .map_or(look::TAB_TEXT.rgba(), crate::git::FileStatus::color)
}

/// An unselected tab's label color: WebStorm blends it into the strip
/// (`ColorUtil.blendColorsInRgb(bg, fg, EditorTabs.unselectedBlend 0.7)`: per channel
/// sqrt(bg²·0.3 + fg²·0.7)).
pub fn unselected(fg: Rgba) -> Rgba {
    let bg = look::TAB_STRIP_BG;
    let mix = |b: f32, f: f32| (b * b * 0.3 + f * f * 0.7).sqrt();
    Rgba {
        r: mix(bg.r, fg.r),
        g: mix(bg.g, fg.g),
        b: mix(bg.b, fg.b),
        a: 1.,
    }
}

fn ui_font() -> Font {
    font(UI_FONT)
}

impl TabsView {
    /// The editor splits' slots of the current layout.
    pub fn slots(&self) -> Vec<EditorSlot> {
        self.scx.geometry().slots()
    }

    /// The bars Lua sent, by window.
    pub fn bars(&self) -> &HashMap<i64, Bar> {
        &self.bars
    }

    /// The Feel's tab switches (VimStorm's until the bridge says).
    fn feel(&self, cx: &App) -> crate::factory::TabsFeel {
        cx.try_global::<crate::factory::Feel>()
            .map(|f| f.tabs)
            .unwrap_or_default()
    }

    /// What buffer `buf`'s tab in window `win` draws in its ×'s place now (tests).
    pub fn close_mark_of(&self, win: i64, buf: i64, cx: &App) -> Option<CloseMark> {
        let bar = self.bars.get(&win)?;
        let tab = bar.tabs.iter().find(|t| t.buf == buf)?;
        let hovered = self.hover == Some((win, buf));
        let lit = bar.active == Some(buf) || hovered;
        Some(close_mark(tab, lit, hovered, self.feel(cx).dirty_dot))
    }

    /// The line under the empty editor's face: where the shown story stands, if it is one; else
    /// `No session` in a worktree, `Main checkout` in the main one ([`Checkout::caption`]).
    pub fn face_caption(&self, cx: &App) -> Option<Vec<LineSpan>> {
        story_line(&self.scx.project, cx).or_else(|| {
            self.checkout.caption().map(|text| {
                vec![LineSpan {
                    text: text.to_owned(),
                    hue: None,
                }]
            })
        })
    }

    /// Keeps `px` free at the right end of window `win`'s bar (another surface's buttons there:
    /// the markdown mode toolbar); replaces the previous reservations.
    pub fn set_reserved(&mut self, reserved: HashMap<i64, f32>, cx: &mut Context<Self>) {
        if reserved != self.reserved {
            self.reserved = reserved;
            cx.notify();
        }
    }

    /// The tabs drawn by the last render (window coordinates), left to right per bar.
    pub fn drawn(&self) -> &[TabRects] {
        &self.drawn
    }

    /// The hidden tabs button of a split's bar, if drawn.
    pub fn more_button(&self, win: i64) -> Option<Bounds<Pixels>> {
        self.more.get(&win).copied()
    }

    /// The tab under the mouse.
    pub fn hovered(&self) -> Option<(i64, i64)> {
        self.hover
    }

    /// Tabs of a split that the last render left out (too many for the bar), in tab order.
    pub fn hidden(&self, win: i64) -> Vec<i64> {
        let Some(bar) = self.bars.get(&win) else {
            return Vec::new();
        };
        bar.tabs
            .iter()
            .filter(|t| !self.drawn.iter().any(|d| d.win == win && d.buf == t.buf))
            .map(|t| t.buf)
            .collect()
    }

    fn label_width(&mut self, label: &str, window: &Window) -> f32 {
        if let Some(&w) = self.widths.get(label) {
            return w;
        }
        let w = crate::kit::width(window, label, ui_font(), px(look::TAB_FONT_SIZE.get())).as_f32();
        self.widths.insert(label.to_owned().into(), w);
        w
    }

    /// Every tab click moves the editor: in Normal mode, after an open `/` or a pending `d`.
    fn call(&self, func: &str, win: i64, buf: i64) {
        self.scx.navigate(LUA, func, vec![win.into(), buf.into()]);
    }

    /// A press on a tab: left activates (on the ×: closes), middle closes, right opens the tab
    /// menu.
    fn press(
        &mut self,
        win: i64,
        buf: i64,
        ev: &MouseDownEvent,
        window: &mut Window,
        cx: &mut App,
    ) {
        let on_close = self
            .drawn
            .iter()
            .any(|d| d.win == win && d.buf == buf && d.close.contains(&ev.position));
        let selected = self.bars.get(&win).and_then(|b| b.active) == Some(buf);
        let hovered = self.hover == Some((win, buf));
        match ev.button {
            // the × shows on the selected / hovered tab
            MouseButton::Left if on_close && (selected || hovered) => self.call("close", win, buf),
            MouseButton::Left => self.call("activate", win, buf),
            MouseButton::Middle => self.call("close", win, buf),
            // the tab menu's top-left at the mouse
            MouseButton::Right => self.scx.navigate(
                LUA,
                "menu",
                vec![
                    win.into(),
                    buf.into(),
                    ev.position.x.as_f32().into(),
                    ev.position.y.as_f32().into(),
                ],
            ),
            _ => return,
        }
        // the keyboard goes back to nvim (the tree or a popup may have had it); the Chat column
        // keeps it
        let column = self
            .scx
            .workspace
            .upgrade()
            .is_some_and(|ws| ws.read(cx).native_focus() == Some(crate::shell::CHAT));
        if !column {
            self.scx.focus_editor(window, cx);
        }
    }

    fn render_bar(
        &mut self,
        slot: &EditorSlot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let b = slot.tab_bar;
        let bar = self.bars.get(&slot.win).cloned().unwrap_or(Bar {
            win: slot.win,
            ..Default::default()
        });
        // no tabs (the empty editor): no strip, the island is plain like WebStorm's empty frame
        if bar.tabs.is_empty() {
            return div().into_any_element();
        }
        let widths: Vec<f32> = bar
            .tabs
            .iter()
            .map(|t| layout::tab_width(self.label_width(&t.name, window)))
            .collect();
        let active = bar
            .active
            .and_then(|a| bar.tabs.iter().position(|t| t.buf == a));
        let more_w = |n: usize, this: &mut Self| {
            MORE_PAD * 2. + look::ICON_SIZE + this.label_width(&n.to_string(), window).ceil()
        };
        // the button's width depends on the count, the count on the room: room for the widest
        let probe = more_w(bar.tabs.len(), self);
        let room = b.size.width.as_f32() - self.reserved.get(&slot.win).copied().unwrap_or(0.);
        let placed = layout::layout(&widths, active, room, probe);

        let strip_h = b.size.height.as_f32() - 1.; // above the bottom line
        let box_h = look::TAB_BOX_HEIGHT.get().min(strip_h);
        let box_y = layout::BOX_TOP.min(strip_h - box_h).max(0.);

        let mut el = div()
            .id(SharedString::from(format!("tabbar-{}", slot.win)))
            .absolute()
            .left(b.origin.x)
            .top(b.origin.y)
            .w(b.size.width)
            .h(b.size.height)
            .bg(look::TAB_STRIP_BG)
            .rounded_tl(px(ISLAND_RADIUS.get()))
            .rounded_tr(px(ISLAND_RADIUS.get()))
            .border_b(px(1.))
            .border_color(look::TAB_STRIP_BORDER)
            .overflow_hidden()
            .font(ui_font())
            .text_size(px(look::TAB_FONT_SIZE.get()))
            // the strip's empty part: focuses that split (the Lua winbar's click did); no click
            // through to nvim
            .on_mouse_down(MouseButton::Left, {
                let win = slot.win;
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.scx.navigate(LUA, "focus_split", vec![win.into()]);
                    this.scx.focus_editor(window, cx);
                })
            })
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Middle, |_, _, cx| cx.stop_propagation());

        for p in &placed.tabs {
            let tab = &bar.tabs[p.index];
            let look = TabLook {
                selected: Some(tab.buf) == bar.active,
                focused: bar.focused,
                hovered: self.hover == Some((slot.win, tab.buf)),
                box_y,
                box_h,
                strip_h,
            };
            self.drawn.push(TabRects {
                win: slot.win,
                buf: tab.buf,
                tab: Bounds::new(
                    point(b.origin.x + px(p.x), b.origin.y),
                    size(px(p.width), px(strip_h)),
                ),
                close: Bounds::new(
                    point(
                        b.origin.x + px(close_x(p)),
                        b.origin.y + px(box_y + (box_h - look::TAB_CLOSE_SIZE) / 2.),
                    ),
                    size(px(look::TAB_CLOSE_SIZE), px(look::TAB_CLOSE_SIZE)),
                ),
            });
            el = el.child(self.render_tab(slot.win, tab, p, look, cx));
        }

        if let Some(x) = placed.more_x {
            let n = placed.hidden.len();
            let w = more_w(n, self);
            let bufs: Vec<Value> = placed
                .hidden
                .iter()
                .map(|&i| bar.tabs[i].buf.into())
                .collect();
            let button = Bounds::new(
                point(b.origin.x + px(x), b.origin.y + px(box_y)),
                size(px(w), px(box_h)),
            );
            self.more.insert(slot.win, button);
            // the list under the button, left-aligned with it
            let (lx, ly) = (button.origin.x.as_f32(), button.bottom().as_f32() + 2.);
            let win = slot.win;
            el = el.child(
                div()
                    .id(SharedString::from(format!("tabs-more-{win}")))
                    .absolute()
                    .left(px(x))
                    .top(px(box_y))
                    .h(px(box_h))
                    .w(px(w))
                    .px(px(MORE_PAD))
                    .flex()
                    .items_center()
                    .rounded(px(look::TAB_ARC.get()))
                    .text_color(look::TAB_TEXT_INACTIVE)
                    .hover(|s| s.bg(look::TAB_HOVER_BG))
                    .cursor_pointer()
                    .child(SharedString::from(n.to_string()))
                    .child(Icon::new(IconName::ChevronDown))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.scx.navigate(
                                LUA,
                                "hidden",
                                vec![win.into(), Value::Array(bufs.clone()), lx.into(), ly.into()],
                            );
                            this.scx.focus_editor(window, cx);
                        }),
                    ),
            );
        }
        el.into_any_element()
    }

    fn render_tab(
        &self,
        win: i64,
        tab: &Tab,
        p: &layout::Placed,
        look: TabLook,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let buf = tab.buf;
        let TabLook {
            selected,
            focused,
            hovered,
            box_y,
            box_h,
            strip_h,
        } = look;
        let inset = look::TAB_BOX_INSET_X;
        // the box: selected = outlined (blue / gray), hovered = plain
        let mut boxed = div()
            .absolute()
            .left(px(inset.get()))
            .top(px(box_y))
            .w(px(p.width - 2. * inset))
            .h(px(box_h))
            .rounded(px(look::TAB_ARC.get()));
        if selected {
            let (bg, border) = if focused {
                (look::TAB_SELECTED_BG, look::TAB_SELECTED_BORDER)
            } else {
                (
                    look::TAB_SELECTED_INACTIVE_BG,
                    look::TAB_SELECTED_INACTIVE_BORDER,
                )
            };
            boxed = boxed
                .bg(bg)
                .border(px(look::TAB_BORDER_WIDTH))
                .border_color(border);
        } else if hovered {
            boxed = boxed.bg(look::TAB_HOVER_BG);
        }

        let lit = selected || hovered;
        let fg = status_color(&tab.status);
        let fg = if lit { fg } else { unselected(fg) };
        let name: SharedString = tab.name.clone().into();
        let label = if tab.error {
            StyledText::new(name.clone())
                .with_runs(vec![TextRun {
                    len: name.len(),
                    font: if tab.preview {
                        ui_font().italic()
                    } else {
                        ui_font()
                    },
                    color: fg.into(),
                    background_color: None,
                    underline: Some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(look::TAB_ERROR_UNDERLINE.into()),
                        wavy: true,
                    }),
                    strikethrough: None,
                }])
                .into_any_element()
        } else {
            div().text_color(fg).child(name).into_any_element()
        };
        let label = div()
            .relative()
            .top(px(layout::LABEL_DROP))
            .when(tab.preview, |d| d.italic())
            .child(label);
        let icon = div()
            .flex_none()
            .relative()
            .when(!lit, |d| d.opacity(look::TAB_ICON_ALPHA_INACTIVE))
            .child(Icon::new(kit::for_file(file_name(tab))))
            .when(tab.readonly, |d| {
                // WebStorm's locked overlay, bottom-left at 11 px on the frame colour
                d.child(
                    div()
                        .debug_selector(move || format!("tab-lock-{buf}"))
                        .absolute()
                        .left(px(-look::TAB_LOCK_OFFSET))
                        .bottom(px(-look::TAB_LOCK_OFFSET))
                        .size(px(look::TAB_LOCK_SIZE))
                        .rounded(px(look::BUTTON_ARC))
                        .bg(look::FRAME_BG)
                        .child(Icon::new(IconName::Locked).size(px(look::TAB_LOCK_SIZE))),
                )
            });

        let close_icon = if self.hover_close && hovered {
            IconName::CloseSmallHovered
        } else {
            IconName::CloseSmall
        };
        let mark = close_mark(tab, lit, hovered, self.feel(cx).dirty_dot);
        let close = div()
            .id(SharedString::from(format!("tab-close-{win}-{buf}")))
            .absolute()
            .left(px(close_x(p) - p.x))
            .top(px(box_y + (box_h - look::TAB_CLOSE_SIZE) / 2.))
            .size(px(look::TAB_CLOSE_SIZE))
            .when(mark == CloseMark::Close, |d| d.child(Icon::new(close_icon)))
            .when(mark == CloseMark::Dirty, |d| {
                d.debug_selector(move || format!("tab-dirty-{buf}"))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(fg)
                    .child("●")
            })
            .on_hover(cx.listener(move |this, on: &bool, _, cx| {
                if this.hover_close != *on {
                    this.hover_close = *on;
                    cx.notify();
                }
            }));

        let pressed = move |this: &mut Self,
                            ev: &MouseDownEvent,
                            window: &mut Window,
                            cx: &mut Context<Self>| {
            cx.stop_propagation();
            this.press(win, buf, ev, window, cx);
        };
        div()
            .id(SharedString::from(format!("tab-{win}-{buf}")))
            .absolute()
            .left(px(p.x))
            .top_0()
            .w(px(p.width))
            .h(px(strip_h))
            .cursor_pointer()
            .child(boxed)
            .child(
                div()
                    .absolute()
                    .left(px(look::TAB_PADDING_LEFT))
                    .top(px(box_y))
                    .h(px(box_h))
                    .flex()
                    .items_center()
                    .gap(px(layout::ICON_GAP))
                    .whitespace_nowrap()
                    .child(icon)
                    .child(label),
            )
            .child(close)
            .on_hover(cx.listener(move |this, on: &bool, _, cx| {
                let now = if *on {
                    Some((win, buf))
                } else if this.hover == Some((win, buf)) {
                    None
                } else {
                    this.hover
                };
                if now != this.hover {
                    this.hover = now;
                    if now.is_none() {
                        this.hover_close = false;
                    }
                    cx.notify();
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(pressed))
            .on_mouse_down(MouseButton::Middle, cx.listener(pressed))
            .on_mouse_down(MouseButton::Right, cx.listener(pressed))
            .into_any_element()
    }

    /// The empty editor: Abe's face centred in the split's island (no tab strip there), faint, and
    /// one dim line under it saying where the shown story stands (W-Empty, W-Faces).
    fn render_face(&self, slot: &EditorSlot, cx: &mut Context<Self>) -> AnyElement {
        let fit = face_fit(
            f32::from(slot.island.size.width),
            f32::from(slot.island.size.height),
        );
        if fit == FaceFit::Nothing {
            return div().into_any_element();
        }
        let caption = self.face_caption(cx);
        div()
            .absolute()
            .left(slot.island.origin.x)
            .top(slot.island.origin.y)
            .w(slot.island.size.width)
            .h(slot.island.size.height)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(look::EMPTY_FACE_GAP))
            .overflow_hidden()
            .font(ui_font())
            .text_size(px(look::UI_FONT_SIZE))
            .whitespace_nowrap()
            .when(fit == FaceFit::Whole, |d| {
                d.child(
                    div()
                        .debug_selector(|| "empty-editor-face".to_owned())
                        .child(crate::kit::head(
                            look::EMPTY_FACE_SIZE,
                            look::EMPTY_FACE_ALPHA,
                            cx,
                        )),
                )
            })
            .when_some(caption, |d, line| {
                d.child(
                    div()
                        .debug_selector(|| "empty-editor-caption".to_owned())
                        .flex()
                        .text_size(px(look::EMPTY_FACE_CAPTION_SIZE))
                        .text_color(look::TEXT_DIM)
                        .children(line.into_iter().map(|span| {
                            div()
                                .when_some(span.hue, |d, hue| d.text_color(hue))
                                .child(SharedString::from(span.text))
                        })),
                )
            })
            .into_any_element()
    }
}

/// A tab's file name (the label may be "parent/name"): what its icon goes by.
pub fn file_name(tab: &Tab) -> &str {
    let name = tab.name.rsplit('/').next().unwrap_or(&tab.name);
    if tab.path.is_empty() {
        return name;
    }
    tab.path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or(name)
}

/// A placed tab's close button x (from the bar's left).
fn close_x(p: &layout::Placed) -> f32 {
    p.x + p.width - look::TAB_PADDING_RIGHT - look::TAB_CLOSE_SIZE
}

impl Surface for TabsView {
    const NAME: &'static str = "tabs";

    fn new(scx: SurfaceCx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        // `tabs.dirtyDot` drawn as soon as the Feel says
        cx.observe_global::<crate::factory::Feel>(|_, cx| cx.notify())
            .detach();
        let checkout = Checkout::of(&scx.project);
        TabsView {
            scx,
            focus: cx.focus_handle(),
            bars: HashMap::new(),
            hover: None,
            hover_close: false,
            widths: HashMap::new(),
            drawn: Vec::new(),
            more: HashMap::new(),
            reserved: HashMap::new(),
            checkout,
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        match lua::decode::<TabsEvent>(Self::NAME, payload) {
            Some(TabsEvent::Bars { bars }) => {
                let bars: HashMap<i64, Bar> = bars.into_iter().map(|b| (b.win, b)).collect();
                if bars != self.bars {
                    self.bars = bars;
                    cx.notify();
                }
            }
            // Lua's `require("config.app").focus(NAME)`: the bars take no keys, nvim keeps them
            Some(TabsEvent::Focus) => self.scx.focus_editor(window, cx),
            None => {}
        }
    }
}

impl Focusable for TabsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TabsView {
    /// The breadcrumbs a split shows in its strip under the tab bar (tests; None: no strip).
    pub fn crumbs_of(&self, win: i64) -> Option<Vec<String>> {
        let slot = self.slots().into_iter().find(|s| s.win == win)?;
        slot.crumbs?;
        Some(self.bars.get(&win)?.crumbs.as_ref()?.parts())
    }

    /// Feel vscode's breadcrumbs (VS Code's `breadcrumbs` bar): the file's folders, its icon
    /// and name, the declarations around the caret, `›` between, in the 22 px strip the layout keeps
    /// under the split's tab bar (`config/app/layout.lua` asks for it under Feel vscode).
    fn render_crumbs(&self, slot: &EditorSlot, cx: &mut App) -> Option<AnyElement> {
        let c = slot.crumbs?;
        let crumbs = self.bars.get(&slot.win)?.crumbs.clone().unwrap_or_default();
        let mut row = div()
            .id(SharedString::from(format!("editor-crumbs-{}", slot.win)))
            .debug_selector(|| "editor-crumbs".into())
            .absolute()
            .left(c.origin.x)
            .top(c.origin.y)
            .w(c.size.width)
            .h(c.size.height)
            .px(px(look::CRUMBS_PAD_X))
            .flex()
            .items_center()
            .gap(px(look::TAB_ICON_GAP))
            .bg(look::EDITOR_BG)
            .overflow_hidden()
            .whitespace_nowrap()
            .font(ui_font())
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .text_color(look::TEXT_DIM);
        for (i, f) in crumbs.folders.iter().enumerate() {
            if i > 0 {
                row = row.child(crate::editor::statusbar::separator());
            }
            row = row.child(div().flex_none().child(SharedString::from(f.clone())));
        }
        if !crumbs.file.is_empty() {
            if !crumbs.folders.is_empty() {
                row = row.child(crate::editor::statusbar::separator());
            }
            row = row.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(look::TAB_ICON_GAP))
                    .child(Icon::new(kit::for_file(&crumbs.file)))
                    .child(SharedString::from(crumbs.file.clone())),
            );
        }
        for m in &crumbs.symbols {
            row = row.child(crate::editor::statusbar::separator()).child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(look::TAB_ICON_GAP))
                    .child(crate::search::icon(&m.kind, cx))
                    .child(SharedString::from(m.name.clone())),
            );
        }
        Some(row.into_any_element())
    }
}

impl Render for TabsView {
    /// Mounted in a full-window layer: each tab bar at its slot's `tab_bar` bounds, the hints in
    /// empty splits.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.drawn.clear();
        self.more.clear();
        let slots = self.slots();
        // (no track_focus: GPUI would give this surface the keyboard on any click in the window)
        let mut root = div();
        for slot in &slots {
            root = root.child(self.render_bar(slot, window, cx));
            if let Some(crumbs) = self.render_crumbs(slot, cx) {
                root = root.child(crumbs);
            }
            if slot.empty {
                root = root.child(self.render_face(slot, cx));
            }
        }
        // a relayout moved the hovered tab away
        if let Some((w, b)) = self.hover
            && !self.drawn.iter().any(|d| d.win == w && d.buf == b)
        {
            self.hover = None;
            self.hover_close = false;
        }
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_face_fits_its_island_head_and_caption_then_the_caption_then_nothing() {
        assert_eq!(face_fit(420., 300.), FaceFit::Whole);
        assert_eq!(face_fit(200., 200.), FaceFit::Whole);
        assert_eq!(face_fit(199., 600.), FaceFit::CaptionOnly);
        assert_eq!(face_fit(600., 120.), FaceFit::CaptionOnly);
        assert_eq!(face_fit(600., 80.), FaceFit::CaptionOnly);
        assert_eq!(face_fit(600., 79.), FaceFit::Nothing);
    }

    #[test]
    fn the_caption_without_a_story_says_what_the_folder_is() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Checkout::of(dir.path()), Checkout::Plain);
        assert_eq!(Checkout::Plain.caption(), None);
        std::fs::write(dir.path().join(".git"), "gitdir: /x/.git/worktrees/w\n").unwrap();
        assert_eq!(Checkout::of(dir.path()), Checkout::Worktree);
        assert_eq!(Checkout::Worktree.caption(), Some("No session"));
        std::fs::remove_file(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        assert_eq!(Checkout::of(dir.path()), Checkout::Main);
        assert_eq!(Checkout::Main.caption(), Some("Main checkout"));
    }

    fn decode(v: Value) -> Option<TabsEvent> {
        lua::decode::<TabsEvent>("tabs", v)
    }

    fn map(pairs: Vec<(&str, Value)>) -> Value {
        Value::Map(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    #[test]
    fn bars_decode_with_empty_tables_and_missing_active() {
        let tab = map(vec![
            ("buf", 3.into()),
            ("name", "a.ts".into()),
            ("path", "/p/a.ts".into()),
            ("status", "Modified".into()),
            ("error", true.into()),
        ]);
        let bars = Value::Array(vec![
            map(vec![
                ("win", 1000.into()),
                ("tabs", Value::Array(vec![tab])),
                ("active", 3.into()),
                ("focused", true.into()),
            ]),
            // the empty editor: Lua's {} is an empty map
            map(vec![
                ("win", 1001.into()),
                ("tabs", Value::Map(vec![])),
                ("focused", false.into()),
            ]),
        ]);
        let Some(TabsEvent::Bars { bars }) =
            decode(map(vec![("event", "bars".into()), ("bars", bars)]))
        else {
            panic!("bars didn't decode");
        };
        assert_eq!(bars[0].tabs[0].status, "Modified");
        assert!(bars[0].tabs[0].error && bars[0].focused);
        assert_eq!(bars[0].active, Some(3));
        assert!(bars[1].tabs.is_empty() && bars[1].active.is_none());
    }

    #[test]
    fn icons_go_by_the_file_name_not_the_label() {
        let tab = |name: &str, path: &str| Tab {
            name: name.into(),
            path: path.into(),
            ..Default::default()
        };
        assert_eq!(
            file_name(&tab("app/package.json", "/p/app/package.json")),
            "package.json"
        );
        assert_eq!(file_name(&tab("app/package.json", "")), "package.json");
        assert_eq!(file_name(&tab("untitled", "")), "untitled");
        assert_eq!(
            kit::for_file(file_name(&tab("app/package.json", "/p/app/package.json"))),
            kit::for_file("package.json")
        );
    }

    #[test]
    fn unselected_labels_blend_like_webstorm() {
        // EditorTabs.unselectedBlend over the strip: plain text gives the measured 0xAFB1B6
        let c = unselected(look::TAB_TEXT.rgba());
        let byte = |f: f32| (f * 255.).round() as u32;
        assert_eq!((byte(c.r), byte(c.g), byte(c.b)), (0xAF, 0xB1, 0xB6));
        assert_eq!(status_color("Modified"), look::GIT_MODIFIED.rgba());
        assert_eq!(status_color(""), look::TAB_TEXT.rgba());
    }
}
