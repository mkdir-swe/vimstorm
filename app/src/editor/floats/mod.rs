//! LSP floats drawn natively: the completion menu (+ its documentation panel), signature help
//! (parameter info), the hover / error popup (gh, ,e, the mouse tooltip) and the Quick Definition
//! popup's chrome (its code stays a Neovim float window: caret moves, Tab, Enter jump there).
//!
//! Lua (`nvim/lua/config/app/floats.lua`) stays the engine: blink.cmp's windows are virtual there
//! and send their content here; `config/gutter.lua` sends the hover sections; `config/peek.lua`
//! the peek window + header. Open / close rules stay in Lua (caret moves, Esc, typing); this side
//! places, draws, scrolls, selects / copies, and reports clicks (accept an item) and its own closes
//! (Esc in the focused hover) back. See the surface contract in `crate::shell`.

mod kinds;
mod markdown;
mod place;
mod style;

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, Context, CursorStyle, Entity, FocusHandle, Focusable, FontStyle,
    FontWeight, HighlightStyle, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, Point, Render, ScrollHandle,
    ScrollWheelEvent, SharedString, Size, StatefulInteractiveElement as _, StrikethroughStyle,
    Styled as _, StyledText, Subscription, TextLayout, Window, div, point,
    prelude::FluentBuilder as _, px, size,
};
use rmpv::Value;
use serde::Deserialize;

use crate::editor::EditorView;
use crate::kit::{self, Icon, IconName};
use crate::look;
use crate::nvim::lua;
use crate::popups::{MenuEntry, MenuItem};
use crate::render::{EDITOR_FONT, UI_FONT};
use crate::shell::Geometry;
use crate::shell::{Surface, SurfaceCx};
use markdown::{Block, CodeLook, Inline, Severity, SpanStyle, TextKind};

const LUA: &str = "config.app.floats";

// Bridge payloads --------------------------------------------------------------------------------

/// A buffer position's cell in its window's grid (`config/app/floats.lua` `anchor`).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct AnchorIn {
    pub win: i64,
    pub row: i64,
    pub col: i64,
}

/// A code color span from Lua: start, end, fg (-1 none), 1 bold + 2 italic.
type SpanIn = (usize, usize, i64, u8);

#[derive(Clone, Debug, Deserialize)]
struct SectionIn {
    kind: String,
    text: String,
    #[serde(default)]
    code: Vec<Vec<SpanIn>>,
}

#[derive(Clone, Debug, Deserialize)]
struct ItemIn {
    label: String,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    kind: u32,
    #[serde(default)]
    deprecated: bool,
    #[serde(default)]
    matched: Vec<usize>,
}

/// Quick Definition header (`config/peek.lua`).
#[derive(Clone, Debug, Deserialize)]
pub struct PeekHeader {
    pub file: String,
    pub path: String,
    pub right: String,
    #[serde(default)]
    pub bg: u32,
    /// The file's git status word ("Modified", ...; "" unchanged): the name's color.
    #[serde(default)]
    pub status: String,
    /// Definitions to step through (◀ ▶ when > 1).
    #[serde(default)]
    pub count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum FloatsEvent {
    /// `require("config.app").focus("floats")`: into the hover popup when one is open.
    Focus,
    Hover {
        id: u64,
        kind: String,
        sections: Vec<SectionIn>,
        anchor: AnchorIn,
    },
    HoverFocus {
        id: u64,
    },
    HoverClose {
        id: u64,
    },
    /// The hovered symbol's definition file (the location label; Edit Source goes there).
    HoverLocation {
        id: u64,
        file: String,
        text: String,
    },
    /// The first quick fix for the hovered problem ("" none).
    HoverFix {
        id: u64,
        title: String,
    },
    Menu {
        selected: usize,
        #[serde(default)]
        items: Option<Vec<ItemIn>>,
        #[serde(default)]
        anchor: Option<AnchorIn>,
        /// The user moved the selection (WebStorm's focused lookup: blue, else gray).
        #[serde(default)]
        focused: bool,
    },
    MenuClose,
    MenuDoc {
        section: SectionIn,
    },
    MenuDocClose,
    MenuDocScroll {
        rows: i64,
    },
    Signature {
        labels: Vec<String>,
        active: usize,
        #[serde(default)]
        param: Vec<usize>,
        #[serde(default)]
        anchor: Option<AnchorIn>,
    },
    SignatureClose,
    Peek {
        win: i64,
        header: PeekHeader,
        #[serde(default)]
        above: bool,
    },
    PeekClose,
}

/// Lua sections -> blocks, a rule between sections.
fn blocks_of(sections: &[SectionIn]) -> Vec<Block> {
    let mut out = Vec::new();
    for s in sections {
        let blocks = match s.kind.as_str() {
            "markdown" => {
                let colors: Vec<Vec<(Range<usize>, CodeLook)>> = s
                    .code
                    .iter()
                    .map(|c| c.iter().copied().map(markdown::code_span).collect())
                    .collect();
                markdown::parse(&s.text, &colors)
            }
            "error" => markdown::problem(&s.text, Severity::Error),
            "warning" => markdown::problem(&s.text, Severity::Warning),
            "hint" => markdown::problem(&s.text, Severity::Hint),
            _ => markdown::problem(&s.text, Severity::Info),
        };
        if blocks.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(Block::Rule);
        }
        out.extend(blocks);
    }
    out
}

// State ------------------------------------------------------------------------------------------

/// A selection point: (block, byte).
type Pos = (usize, usize);

type Layouts = Rc<RefCell<Vec<Option<TextLayout>>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    /// gh / ,e: at the caret; gh / ,e again focuses it.
    Hover,
    /// Mouse resting on code.
    Tooltip,
}

struct Doc {
    id: u64,
    kind: DocKind,
    blocks: Vec<Block>,
    anchor: AnchorIn,
    scroll: ScrollHandle,
    /// The blocks' text runs (computed once).
    prepared: Vec<Option<Prepared>>,
    sel: Option<(Pos, Pos)>,
    dragging: bool,
    /// The blocks' text layouts as last painted (mouse -> text; tests).
    layouts: Layouts,
    /// The definition's file (icon) and location text, once Lua has it.
    location: Option<(String, SharedString)>,
    /// The first quick fix's title, once Lua has it.
    fix: Option<SharedString>,
    /// Longest code line (chars) and whether a boxed code block has it (the popup's width).
    code_width: (usize, bool),
}

struct Item {
    label: SharedString,
    detail: SharedString,
    description: SharedString,
    kind: u32,
    deprecated: bool,
    matched: Vec<usize>,
}

struct Menu {
    items: Vec<Item>,
    /// 1-based, 0: none.
    selected: usize,
    /// First shown row.
    top: usize,
    anchor: Option<AnchorIn>,
    /// Widest row text seen since it opened: WebStorm's lookup grows, never shrinks.
    width: Pixels,
    /// The user moved the selection (blue); before that the auto-popup's gray.
    focused: bool,
    /// The advertiser hint shown (picked when it opens) and its text width (measured once).
    ad: usize,
    ad_width: Option<Pixels>,
}

struct MenuDoc {
    blocks: Vec<Block>,
    prepared: Vec<Option<Prepared>>,
    scroll: ScrollHandle,
}

struct Signature {
    labels: Vec<String>,
    active: usize,
    param: Option<Range<usize>>,
    anchor: Option<AnchorIn>,
}

struct Peek {
    win: i64,
    header: PeekHeader,
    /// Above the caret line: no frame below the code (it'd cover that line).
    above: bool,
}

pub struct FloatsView {
    scx: SurfaceCx,
    focus: FocusHandle,
    hover: Option<Doc>,
    menu: Option<Menu>,
    menu_doc: Option<MenuDoc>,
    signature: Option<Signature>,
    peek: Option<Peek>,
    /// The hover popup that has the keyboard (its id).
    focused: Option<u64>,
    /// `g` typed in the focused hover (`gg`).
    pending_g: bool,
    /// The mouse was last over one of nvim's grids (leaving them closes the tooltip).
    mouse_on_grid: bool,
    /// The hover popup as last placed (window coordinates).
    hover_bounds: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    /// Completion menus opened so far (the advertiser hint rotates).
    menus_opened: usize,
    /// The problem popup's actions row (its ⋮ "Show Quick Fixes"; WebStorm's setting, per session).
    show_fixes: bool,
    /// One of the floats' ⋮ menus is open: its focus move closes nothing.
    own_menu: bool,
    /// The completion's documentation popup shows by itself (blink's auto_show; its ⋮ toggles it).
    menu_doc_auto: bool,
    editor: Option<Entity<EditorView>>,
    _subs: Vec<Subscription>,
}

impl Surface for FloatsView {
    const NAME: &'static str = "floats";

    fn new(scx: SurfaceCx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        // a click elsewhere (any focus move) closes the focused hover, like leaving its window
        let blur = cx.on_blur(&focus, window, |this, window, cx| {
            // (its own ⋮ menu: the keyboard comes back on close)
            if this.own_menu {
                return;
            }
            let focused = this.focused.take();
            if focused.is_some() && this.hover.as_ref().map(|h| h.id) == focused {
                this.close_hover(true, window, cx);
            }
        });
        FloatsView {
            scx,
            focus,
            hover: None,
            menu: None,
            menu_doc: None,
            signature: None,
            peek: None,
            focused: None,
            pending_g: false,
            mouse_on_grid: false,
            hover_bounds: Rc::default(),
            menus_opened: 0,
            show_fixes: true,
            own_menu: false,
            menu_doc_auto: true,
            editor: None,
            _subs: vec![blur],
        }
    }

    fn on_lua(&mut self, payload: Value, window: &mut Window, cx: &mut Context<Self>) {
        self.observe_editor(cx);
        let Some(ev) = lua::decode::<FloatsEvent>(Self::NAME, payload) else {
            return;
        };
        match ev {
            FloatsEvent::Focus => {
                if self.hover.is_some() {
                    self.focus_hover(window, cx);
                } else {
                    self.scx.focus_editor(window, cx);
                }
            }
            FloatsEvent::Hover {
                id,
                kind,
                sections,
                anchor,
            } => {
                // a new popup (gh again elsewhere): the keyboard back to the code first (the
                // blur that follows is about the old one: `focused` no longer names it)
                if self.focus.is_focused(window) {
                    self.focused = None;
                    self.hover = None;
                    self.scx.focus_editor(window, cx);
                }
                let blocks = blocks_of(&sections);
                self.hover = Some(Doc {
                    id,
                    kind: if kind == "tooltip" {
                        DocKind::Tooltip
                    } else {
                        DocKind::Hover
                    },
                    prepared: prepare_blocks(&blocks),
                    code_width: code_width(&blocks),
                    blocks,
                    anchor,
                    scroll: ScrollHandle::new(),
                    sel: None,
                    dragging: false,
                    layouts: Rc::default(),
                    location: None,
                    fix: None,
                });
            }
            FloatsEvent::HoverFocus { id } => {
                if self.hover.as_ref().is_some_and(|h| h.id == id) {
                    self.focus_hover(window, cx);
                }
            }
            FloatsEvent::HoverClose { id } => {
                if self.hover.as_ref().is_some_and(|h| h.id == id) {
                    self.close_hover(false, window, cx);
                }
            }
            FloatsEvent::HoverLocation { id, file, text } => {
                if let Some(h) = self.hover.as_mut().filter(|h| h.id == id) {
                    h.location = Some((file, text.into()));
                }
            }
            FloatsEvent::HoverFix { id, title } => {
                if let Some(h) = self.hover.as_mut().filter(|h| h.id == id) {
                    h.fix = (!title.is_empty()).then(|| title.into());
                }
            }
            FloatsEvent::Menu {
                selected,
                items,
                anchor,
                focused,
            } => {
                if self.menu.is_none() {
                    self.menus_opened += 1;
                }
                let ad = self.menus_opened;
                let menu = self.menu.get_or_insert_with(|| Menu {
                    items: Vec::new(),
                    selected: 0,
                    top: 0,
                    anchor: None,
                    width: px(0.),
                    focused: false,
                    ad: (ad - 1) % MENU_ADS.len(),
                    ad_width: None,
                });
                menu.focused = focused;
                if let Some(items) = items {
                    menu.items = items
                        .into_iter()
                        .map(|i| Item {
                            label: i.label.into(),
                            detail: i.detail.into(),
                            description: i.description.into(),
                            kind: i.kind,
                            deprecated: i.deprecated,
                            matched: i.matched,
                        })
                        .collect();
                    menu.top = 0;
                }
                if anchor.is_some() {
                    menu.anchor = anchor;
                }
                menu.selected = selected.min(menu.items.len());
                menu.reveal();
                self.menu_to_editor(true, cx);
            }
            FloatsEvent::MenuClose => {
                self.menu = None;
                self.menu_doc = None;
                self.menu_to_editor(false, cx);
            }
            FloatsEvent::MenuDoc { section } => {
                let blocks = blocks_of(std::slice::from_ref(&section));
                self.menu_doc = Some(MenuDoc {
                    prepared: prepare_blocks(&blocks),
                    blocks,
                    scroll: ScrollHandle::new(),
                });
            }
            FloatsEvent::MenuDocClose => self.menu_doc = None,
            FloatsEvent::MenuDocScroll { rows } => {
                if let Some(d) = &self.menu_doc {
                    scroll_by(&d.scroll, rows as f32 * style::MENU_ROW_HEIGHT);
                }
            }
            FloatsEvent::Signature {
                labels,
                active,
                param,
                anchor,
            } => {
                let param = match param.as_slice() {
                    [s, e] if s <= e => Some(*s..*e),
                    _ => None,
                };
                self.signature = Some(Signature {
                    labels,
                    active,
                    param,
                    anchor,
                });
            }
            FloatsEvent::SignatureClose => self.signature = None,
            FloatsEvent::Peek { win, header, above } => {
                self.peek = Some(Peek { win, header, above })
            }
            FloatsEvent::PeekClose => self.peek = None,
        }
        cx.notify();
    }
}

impl Menu {
    /// Scrolls so the selected row shows.
    fn reveal(&mut self) {
        let rows = style::MENU_MAX_ROWS;
        if self.selected > 0 {
            let ix = self.selected - 1;
            if ix < self.top {
                self.top = ix;
            } else if ix >= self.top + rows {
                self.top = ix + 1 - rows;
            }
        }
        self.top = self.top.min(self.items.len().saturating_sub(rows));
    }

    fn visible(&self) -> Range<usize> {
        self.top..(self.top + style::MENU_MAX_ROWS).min(self.items.len())
    }

    /// The advertiser strip shows (not under the command line's completion: its keys differ).
    fn has_ad(&self) -> bool {
        self.anchor.is_some_and(|a| a.win != -1)
    }
}

/// The completion advertiser's hints (one per lookup, rotating like WebStorm's tips; our keys).
const MENU_ADS: [&str; 2] = [
    "Press ⏎ or ⇥ to insert the selected suggestion",
    "Press ⌃B or ⌃F to scroll the documentation",
];

/// Under several signatures (CodeInsightBundle "parameter.info.switch.overload.shortcuts").
const SIGNATURE_HINT: &str = "Switch with ⌃↑ or ⌃↓";

/// Scrolls a popup's content by `dy` px (+ = down), within its range.
fn scroll_by(handle: &ScrollHandle, dy: f32) {
    let max = handle.max_offset().y;
    let off = handle.offset();
    let y = (off.y - px(dy)).min(px(0.)).max(-max);
    handle.set_offset(point(off.x, y));
}

/// What's shown (tests / introspection).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shown {
    pub hover: Option<(DocKind, String)>,
    pub hover_focused: bool,
    pub menu: Option<Vec<String>>,
    /// 1-based, 0: none.
    pub menu_selected: usize,
    /// The selection is blue (the user moved it), not the auto-popup's gray.
    pub menu_focused: bool,
    /// The advertiser hint under the rows.
    pub menu_ad: Option<String>,
    pub menu_doc: Option<String>,
    /// The hover's location label text.
    pub hover_location: Option<String>,
    /// The hover's quick fix link (shown: the actions row is on).
    pub hover_fix: Option<String>,
    /// The active signature.
    pub signature: Option<String>,
    /// Its current parameter (drawn bold).
    pub signature_param: Option<String>,
    /// "Switch with ⌃↑ or ⌃↓" under several signatures.
    pub signature_hint: Option<String>,
    /// Peek header: (path, right text).
    pub peek: Option<(String, String)>,
}

impl FloatsView {
    /// Re-renders with the editor (popups follow the grids: caret moves, inlay hints, scrolling).
    fn observe_editor(&mut self, cx: &mut Context<Self>) {
        if self.editor.is_some() {
            return;
        }
        let Some(ws) = self.scx.workspace.upgrade() else {
            return;
        };
        let editor = ws.read(cx).editor().clone();
        self._subs.push(cx.observe(&editor, |this, _, cx| {
            if this.any_open() {
                cx.notify();
            }
        }));
        self.editor = Some(editor);
    }

    /// The editor's local echo predicts nothing while the completion menu is open.
    fn menu_to_editor(&self, open: bool, cx: &mut Context<Self>) {
        if let Some(editor) = &self.editor {
            editor.update(cx, |e, _| e.set_completion_menu(open));
        }
    }

    fn any_open(&self) -> bool {
        self.hover.is_some()
            || self.menu.is_some()
            || self.signature.is_some()
            || self.peek.is_some()
    }

    /// What's open and its text.
    pub fn shown(&self, window: &Window) -> Shown {
        let text = |blocks: &[Block]| {
            markdown::selected_text(blocks, (0, 0), (blocks.len().saturating_sub(1), usize::MAX))
        };
        Shown {
            hover: self.hover.as_ref().map(|h| (h.kind, text(&h.blocks))),
            hover_focused: self.focus.is_focused(window),
            menu: self
                .menu
                .as_ref()
                .map(|m| m.items.iter().map(|i| i.label.to_string()).collect()),
            menu_selected: self.menu.as_ref().map_or(0, |m| m.selected),
            menu_focused: self.menu.as_ref().is_some_and(|m| m.focused),
            menu_ad: self
                .menu
                .as_ref()
                .filter(|m| m.has_ad())
                .map(|m| MENU_ADS[m.ad].to_owned()),
            menu_doc: self.menu_doc.as_ref().map(|d| text(&d.blocks)),
            hover_location: self
                .hover
                .as_ref()
                .and_then(|h| h.location.as_ref())
                .filter(|l| !l.0.is_empty())
                .map(|l| l.1.to_string()),
            hover_fix: self
                .hover
                .as_ref()
                .filter(|_| self.show_fixes)
                .and_then(|h| h.fix.as_ref())
                .map(|f| f.to_string()),
            signature: self
                .signature
                .as_ref()
                .and_then(|s| s.labels.get(s.active.saturating_sub(1)).cloned()),
            signature_param: self.signature.as_ref().and_then(|s| {
                let label = s.labels.get(s.active.saturating_sub(1))?;
                label.get(s.param.clone()?).map(str::to_owned)
            }),
            signature_hint: self
                .signature
                .as_ref()
                .filter(|s| s.labels.len() > 1)
                .map(|_| SIGNATURE_HINT.to_owned()),
            peek: self
                .peek
                .as_ref()
                .map(|p| (p.header.path.clone(), p.header.right.clone())),
        }
    }

    /// How far the hover popup's content is scrolled down (tests).
    pub fn hover_scroll(&self) -> Option<(Pixels, Pixels)> {
        let h = self.hover.as_ref()?;
        Some((-h.scroll.offset().y, h.scroll.max_offset().y))
    }

    /// Where byte `byte` of hover block `block` was painted (tests: mouse selection).
    pub fn hover_text_position(&self, block: usize, byte: usize) -> Option<Point<Pixels>> {
        let h = self.hover.as_ref()?;
        let layouts = h.layouts.borrow();
        layouts.get(block)?.as_ref()?.position_for_index(byte)
    }

    /// Bounds of completion item `ix` (0-based) as drawn, if it's in view (tests: clicks).
    pub fn menu_row_bounds(&self, ix: usize, cx: &App) -> Option<Bounds<Pixels>> {
        let menu = self.menu.as_ref()?;
        let frame = self.menu_frame(menu, &self.scx.geometry(), cx)?;
        let row = ix.checked_sub(menu.top)?;
        (row < menu.visible().len()).then(|| {
            Bounds::new(
                point(
                    frame.origin.x + px(1. + style::MENU_INSET_X),
                    frame.origin.y
                        + px(1. + style::MENU_PAD_Y + style::MENU_ROW_HEIGHT * row as f32),
                ),
                size(
                    frame.size.width - px(2. + 2. * style::MENU_INSET_X),
                    px(style::MENU_ROW_HEIGHT.get()),
                ),
            )
        })
    }

    /// Where the completion menu is drawn and where its first label starts (tests: alignment).
    pub fn menu_label_x(&self, cx: &App) -> Option<(Bounds<Pixels>, Pixels)> {
        let menu = self.menu.as_ref()?;
        let frame = self.menu_frame(menu, &self.scx.geometry(), cx)?;
        Some((frame, frame.origin.x + px(menu_lead())))
    }

    fn close_hover(&mut self, tell_lua: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(h) = self.hover.take() else { return };
        self.focused = None;
        self.hover_bounds.set(None);
        if self.focus.is_focused(window) {
            self.scx.focus_editor(window, cx);
        }
        if tell_lua {
            self.scx.call(LUA, "closed", vec![Value::from(h.id)]);
        }
        cx.notify();
    }

    /// The grid a Neovim window is drawn on (splits and floats).
    fn grid_of(&self, win: i64, cx: &App) -> Option<u64> {
        let editor = self.editor.as_ref()?;
        editor
            .read(cx)
            .ui()
            .windows
            .iter()
            .find(|(_, w)| w.win == win && !w.hidden)
            .map(|(g, _)| *g)
    }

    /// Window-coordinate bounds of an anchor's cell.
    fn anchor_cell(&self, a: &AnchorIn, cx: &App) -> Option<Bounds<Pixels>> {
        let geo = self.scx.geometry();
        if a.win == -1 {
            // the command line: the message grid's last row
            let p = geo
                .places
                .iter()
                .rev()
                .find(|p| p.kind == crate::shell::PlaceKind::Message)?;
            let row = p.cells.1.saturating_sub(1);
            return geo.cell_bounds(p.grid, row, a.col.max(0) as usize, 1);
        }
        let grid = self.grid_of(a.win, cx)?;
        geo.place(grid)?;
        geo.cell_bounds(grid, a.row.max(0) as usize, a.col.max(0) as usize, 1)
    }

    // Keys / mouse ---------------------------------------------------------------------------------

    /// Keys while the hover popup has the keyboard (gh / ,e twice, a click in it): like its Neovim
    /// window in the terminal config, scrolling (ö / l / arrows, Ctrl+D / U / F / B, Space,
    /// gg / G), copying (Cmd+C / y: the selection, else everything; Cmd+A), Esc / q close.
    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(h) = self.hover.as_mut() else {
            return;
        };
        let ks = &ev.keystroke;
        let key = if ks.modifiers.platform && !ks.modifiers.control && !ks.modifiers.alt {
            match ks.key.as_str() {
                "c" => "y".to_owned(),
                "a" => "<D-a>".to_owned(),
                // other Cmd keys: global shortcuts (nvim)
                _ => return,
            }
        } else {
            let Some(key) = crate::kit::notation(ev) else {
                return;
            };
            key
        };
        let g = std::mem::take(&mut self.pending_g);
        let row = style::MENU_ROW_HEIGHT;
        let page = (h.scroll.bounds().size.height.as_f32() - row).max(row.get());
        match key.as_str() {
            "<Esc>" | "q" => {
                self.close_hover(true, window, cx);
                cx.stop_propagation();
                return;
            }
            "ö" | "<Down>" | "<C-e>" => scroll_by(&h.scroll, row.get()),
            "l" | "<Up>" | "<C-y>" => scroll_by(&h.scroll, -row),
            "<C-d>" => scroll_by(&h.scroll, page / 2.),
            "<C-u>" => scroll_by(&h.scroll, -page / 2.),
            "<PageDown>" | "<C-f>" | " " => scroll_by(&h.scroll, page),
            "<PageUp>" | "<C-b>" => scroll_by(&h.scroll, -page),
            "g" if g => scroll_by(&h.scroll, -1e6),
            "g" => self.pending_g = true,
            "<Home>" => scroll_by(&h.scroll, -1e6),
            "G" | "<End>" => scroll_by(&h.scroll, 1e6),
            "y" | "Y" => {
                let all = ((0, 0), (h.blocks.len().saturating_sub(1), usize::MAX));
                let (a, b) = h.sel.filter(|(a, b)| a != b).unwrap_or(all);
                let text = markdown::selected_text(&h.blocks, a, b);
                self.scx.call(LUA, "copy", vec![Value::from(text)]);
            }
            "<D-a>" => {
                let last = h.blocks.len().saturating_sub(1);
                let end = h.blocks.last().and_then(Block::text).map_or(0, str::len);
                h.sel = Some(((0, 0), (last, end)));
            }
            _ => {}
        }
        cx.stop_propagation();
        cx.notify();
    }

    /// The mouse moved (anywhere in the window): off nvim's grids (and the popup) tells Lua once.
    fn mouse_moved(&mut self, pos: Point<Pixels>) {
        let geo = self.scx.geometry();
        let on =
            geo.grid_at(pos).is_some() || self.hover_bounds.get().is_some_and(|b| b.contains(&pos));
        if self.mouse_on_grid && !on {
            self.scx.call(LUA, "mouse_left", vec![]);
        }
        self.mouse_on_grid = on;
    }

    /// The hover popup takes the keyboard.
    fn focus_hover(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(h) = &self.hover else { return };
        self.focused = Some(h.id);
        self.pending_g = false;
        window.focus(&self.focus, cx);
    }

    /// A hover popup action in Lua (`edit_source`, `fix`, `more_actions`) for the open popup.
    fn hover_call(&mut self, func: &str) {
        if let Some(h) = &self.hover {
            self.scx.call(LUA, func, vec![Value::from(h.id)]);
        }
    }

    /// The hover's Edit Source: the source in the editor, in Normal mode.
    fn edit_source(&mut self) {
        if let Some(h) = &self.hover {
            self.scx
                .navigate(LUA, "edit_source", vec![Value::from(h.id)]);
        }
    }

    /// Opens one of the floats' ⋮ menus under `at`; `on_choose` gets the chosen entry. The popup it
    /// belongs to stays open meanwhile (Lua's focus rules know it's ours).
    fn open_more(
        &mut self,
        entries: Vec<MenuEntry>,
        at: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
        on_choose: impl FnOnce(&mut FloatsView, usize, &mut Context<FloatsView>) + 'static,
    ) {
        self.own_menu = true;
        self.scx.call(LUA, "own_menu", vec![Value::from(true)]);
        let weak = cx.entity().downgrade();
        let menu = crate::popups::Menu::new(entries, crate::kit::Anchor::Below(at));
        crate::popups::open_menu(menu, window, cx, move |choice, _, cx| {
            let _ = weak.update(cx, |this, cx| {
                this.own_menu = false;
                this.scx.call(LUA, "own_menu", vec![Value::from(false)]);
                if let Some(ix) = choice {
                    on_choose(this, ix, cx);
                }
                cx.notify();
            });
        });
    }

    /// The completion strip's ⋮: the documentation popup on / off (WebStorm's lookup menu).
    fn completion_more(&mut self, at: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let mut item = MenuItem::new("Show Documentation Popup");
        if self.menu_doc_auto {
            item = item.icon(IconName::Checked);
        }
        self.open_more(vec![item.into()], at, window, cx, |this, _, _| {
            this.menu_doc_auto = !this.menu_doc_auto;
            let on = this.menu_doc_auto;
            this.scx.call(LUA, "docs_auto", vec![Value::from(on)]);
        });
    }

    /// The doc popup's ⋮ (DocumentationPopupUI gear actions we have).
    fn doc_more(&mut self, at: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let entries = vec![
            MenuItem::new("Edit Source").icon(IconName::Edit).into(),
            MenuItem::new("Copy").shortcut("⌘C").into(),
        ];
        self.open_more(entries, at, window, cx, |this, ix, _| match ix {
            0 => this.edit_source(),
            _ => {
                if let Some(h) = &this.hover {
                    let all = ((0, 0), (h.blocks.len().saturating_sub(1), usize::MAX));
                    let text = markdown::selected_text(&h.blocks, all.0, all.1);
                    this.scx.call(LUA, "copy", vec![Value::from(text)]);
                }
            }
        });
    }

    /// The problems' ⋮: the quick fix row on / off (DaemonTooltipWithActionRenderer settings).
    fn problem_more(&mut self, at: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let mut item = MenuItem::new("Show Quick Fixes");
        if self.show_fixes {
            item = item.icon(IconName::Checked);
        }
        self.open_more(vec![item.into()], at, window, cx, |this, _, _| {
            this.show_fixes = !this.show_fixes;
        });
    }

    /// Quick Definition's ⋮ (ImplementationViewComponent gear: Edit Source).
    fn peek_more(&mut self, at: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let entries = vec![
            MenuItem::new("Edit Source")
                .icon(IconName::Edit)
                .shortcut("⏎")
                .into(),
        ];
        self.open_more(entries, at, window, cx, |this, _, _| {
            this.scx.navigate("config.peek", "edit_source", vec![]);
        });
    }

    /// Mouse on hover block `ix` at byte `at`: starts (or with `extend` moves the end of) the
    /// selection.
    fn select(&mut self, ix: usize, at: usize, extend: bool, cx: &mut Context<Self>) {
        let Some(h) = self.hover.as_mut() else { return };
        match h.sel {
            Some((a, _)) if extend => h.sel = Some((a, (ix, at))),
            _ => {
                h.sel = Some(((ix, at), (ix, at)));
                h.dragging = true;
            }
        }
        cx.notify();
    }

    // Rendering ------------------------------------------------------------------------------------

    /// The completion menu's frame (window coordinates): its labels' first letter under the typed
    /// word's first letter, below the line (above when there's no room).
    fn menu_frame(&self, menu: &Menu, geo: &Geometry, cx: &App) -> Option<Bounds<Pixels>> {
        let cell = self.anchor_cell(menu.anchor.as_ref()?, cx)?;
        Some(menu_frame(
            cell,
            menu.visible().len(),
            menu.width,
            menu.has_ad().then(|| menu.ad_width.unwrap_or_default()),
            geo.layout.frame.viewport,
        ))
    }

    fn render_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let geo = self.scx.geometry();
        let cw = geo.metrics.cell_width;
        {
            let menu = self.menu.as_mut()?;
            let mut width = menu.width;
            for i in &menu.items[menu.visible()] {
                width = width.max(row_width(i, cw));
            }
            menu.width = width;
            // the hint's width once per lookup (it widens a narrow list, WebStorm's LookupUi)
            if menu.has_ad() && menu.ad_width.is_none() {
                menu.ad_width = Some(text_width(
                    MENU_ADS[menu.ad],
                    UI_FONT.name(),
                    px(style::MENU_AD_FONT_SIZE),
                    window,
                ));
            }
        }
        let menu = self.menu.as_ref()?;
        if menu.items.is_empty() {
            return None;
        }
        let frame = self.menu_frame(menu, &geo, cx)?;
        let rows: Vec<AnyElement> = menu
            .visible()
            .map(|ix| {
                menu_row(
                    &menu.items[ix],
                    ix,
                    ix + 1 == menu.selected,
                    menu.focused,
                    cx,
                )
            })
            .collect();
        let ad = menu.has_ad().then(|| {
            div()
                .id("floats-menu-ad")
                .debug_selector(|| "floats-menu-ad".into())
                .flex_none()
                .h(px(style::MENU_AD_HEIGHT))
                .pl(px(style::MENU_AD_PAD_L))
                .pr(px(style::MENU_AD_PAD_R))
                .flex()
                .items_center()
                .bg(style::MENU_AD_BG)
                .font_family(UI_FONT)
                .text_size(px(style::MENU_AD_FONT_SIZE))
                .text_color(style::MENU_AD_FG)
                .cursor(CursorStyle::Arrow)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        // the (hidden) hint button's room before the ⋮, as LookupBottomLayout
                        .mr(px(style::MENU_AD_BUTTON))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(MENU_ADS[menu.ad]),
                )
                .child(icon_button(
                    "floats-menu-ad-more",
                    IconName::MoreVertical,
                    style::MENU_AD_BUTTON,
                    cx,
                    |this, at, window, cx| this.completion_more(at, window, cx),
                ))
        });
        let pad_bottom = if ad.is_some() {
            style::MENU_PAD_BOTTOM_AD
        } else {
            style::MENU_PAD_Y
        };
        let list = div()
            .id("floats-menu")
            .debug_selector(|| "floats-menu".into())
            .absolute()
            .left(frame.origin.x)
            .top(frame.origin.y)
            .w(frame.size.width)
            .h(frame.size.height)
            .occlude()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(style::MENU_BG)
            .border_1()
            .border_color(style::MENU_BORDER)
            .rounded(px(look::POPUP_ARC))
            .shadow(crate::kit::shadow())
            .font_family(EDITOR_FONT)
            .font_features(crate::render::editor_features())
            .text_size(px(style::EDITOR_FONT_SIZE))
            .text_color(style::MENU_FG)
            .cursor(CursorStyle::PointingHand)
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _, cx| {
                let Some(m) = this.menu.as_mut() else { return };
                let dy = ev.delta.pixel_delta(px(style::MENU_ROW_HEIGHT.get())).y;
                let steps = (-dy.as_f32() / style::MENU_ROW_HEIGHT).round() as i64;
                let max = m.items.len().saturating_sub(style::MENU_MAX_ROWS) as i64;
                m.top = (m.top as i64 + steps).clamp(0, max) as usize;
                cx.notify();
                cx.stop_propagation();
            }))
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .pt(px(style::MENU_PAD_Y))
                    .pb(px(pad_bottom))
                    .children(rows),
            )
            .children(ad);
        let mut out = div().child(list);
        if let Some(doc) = &self.menu_doc {
            let gap = px(crate::kit::ANCHOR_GAP);
            let (left, right, top) = (frame.left(), frame.right(), frame.top());
            let panel = doc_frame("floats-menu-doc")
                .w(px(style::DOC_LOOKUP_WIDTH))
                .min_h(px(style::DOC_LOOKUP_MIN_HEIGHT))
                .child(
                    doc_scroll("floats-menu-doc-scroll", &doc.scroll).child(doc_body(
                        &doc.blocks,
                        &doc.prepared,
                        None,
                        None,
                        None,
                        cx,
                    )),
                );
            out = out.child(place::at(
                move |s: Size<Pixels>, vp: Size<Pixels>| {
                    let m = px(look::POPUP_WINDOW_MARGIN);
                    let x = if right + gap + s.width <= vp.width - m || left - gap - s.width < m {
                        right + gap
                    } else {
                        left - gap - s.width
                    };
                    point(x, top.min(vp.height - m - s.height).max(m))
                },
                panel,
            ));
        }
        Some(out.into_any_element())
    }

    /// Parameter info: the signatures above the caret line (below when the completion menu is
    /// above, or there's no room), the current one's current parameter bold.
    fn render_signature(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sig = self.signature.as_ref()?;
        let cell = self.anchor_cell(sig.anchor.as_ref()?, cx)?;
        let menu_above = self
            .menu
            .as_ref()
            .and_then(|m| self.menu_frame(m, &self.scx.geometry(), cx))
            .is_some_and(|f| f.top() < cell.top());
        let several = sig.labels.len() > 1;
        let lines: Vec<gpui_kit::Div> = sig
            .labels
            .iter()
            .enumerate()
            .map(|(ix, label)| {
                let active = ix + 1 == sig.active;
                let mut inline = Inline::plain(label.clone());
                if active && let Some(p) = sig.param.clone() {
                    inline = with_bold(inline, p);
                }
                let line = div()
                    .px(px(style::SIGNATURE_ROW_PAD_X))
                    .py(px(style::SIGNATURE_ROW_PAD_Y))
                    .rounded(px(style::SIGNATURE_ARC))
                    .child(styled(&inline, None, true));
                if active && several {
                    line.bg(style::SIGNATURE_ACTIVE_BG)
                } else {
                    line
                }
            })
            .collect();
        let body = div()
            .id("floats-signature")
            .occlude()
            .px(px(style::SIGNATURE_PAD_X - style::SIGNATURE_ROW_PAD_X))
            .py(px(style::SIGNATURE_PAD_Y - style::SIGNATURE_ROW_PAD_Y))
            .bg(style::SIGNATURE_BG)
            .border_1()
            .border_color(style::SIGNATURE_BORDER)
            .rounded(px(style::SIGNATURE_ARC))
            .shadow(crate::kit::shadow())
            .font_family(UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(style::SIGNATURE_FG)
            .max_w(px(style::DOC_MAX_WIDTH * 2.))
            .children(lines)
            .when(several, |d| {
                d.child(
                    div()
                        .debug_selector(|| "floats-signature-hint".into())
                        .pt(px(style::SIGNATURE_HINT_GAP))
                        .px(px(style::SIGNATURE_ROW_PAD_X))
                        .text_color(style::SIGNATURE_HINT_FG)
                        .child(SIGNATURE_HINT),
                )
            });
        Some(
            place::at(
                move |s: Size<Pixels>, vp: Size<Pixels>| {
                    let m = px(look::POPUP_WINDOW_MARGIN);
                    let gap = px(crate::kit::ANCHOR_GAP);
                    let above = cell.top() - gap - s.height;
                    let below = cell.bottom() + gap;
                    let y = if (!menu_above && above >= m) || below + s.height > vp.height - m {
                        above.max(m)
                    } else {
                        below
                    };
                    point(cell.left().min(vp.width - m - s.width).max(m), y)
                },
                body,
            )
            .into_any_element(),
        )
    }

    fn render_hover(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let h = self.hover.as_ref()?;
        let cell = self.anchor_cell(&h.anchor, cx)?;
        let has_docs = h.blocks.iter().any(|b| {
            !matches!(
                b,
                Block::Text {
                    kind: TextKind::Problem(_),
                    ..
                }
            )
        });
        let extras = HoverExtras {
            fix: h.fix.clone().filter(|_| self.show_fixes),
            location: has_docs.then(|| h.location.clone()),
        };
        let body = doc_body(
            &h.blocks,
            &h.prepared,
            h.sel,
            Some(h.layouts.clone()),
            Some(extras),
            cx,
        );
        let stop_drag = |this: &mut FloatsView| {
            if let Some(h) = this.hover.as_mut() {
                h.dragging = false;
            }
        };
        // wide code blocks widen it, up to WebStorm's 900
        let (chars, boxed) = h.code_width;
        let code = self.scx.geometry().metrics.cell_width * chars as f32
            + px(2. + 2. * style::DOC_PAD_X)
            + if boxed {
                px(2. + 2. * style::DOC_CODE_PAD_X)
            } else {
                px(0.)
            };
        let max_w = code
            .max(px(style::DOC_MAX_WIDTH))
            .min(px(style::DOC_WIDE_MAX_WIDTH));
        // the corner toolbar (Edit Source, ⋮) over the docs' bottom-right corner
        let corner = has_docs.then(|| {
            div()
                .absolute()
                .right(px(style::DOC_CORNER_RIGHT))
                .bottom(px(style::DOC_CORNER_BOTTOM))
                .flex()
                .cursor(CursorStyle::Arrow)
                .child(icon_button(
                    "floats-doc-edit",
                    IconName::Edit,
                    style::DOC_CORNER_BUTTON,
                    cx,
                    |this, _, _, _| this.edit_source(),
                ))
                .child(icon_button(
                    "floats-doc-more",
                    IconName::MoreVertical,
                    style::DOC_CORNER_BUTTON,
                    cx,
                    |this, at, window, cx| this.doc_more(at, window, cx),
                ))
        });
        let panel = doc_frame("floats-hover")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .min_w(px(style::DOC_MIN_WIDTH))
            .max_w(max_w)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, _, _, _| stop_drag(this)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(move |this, _, _, _| stop_drag(this)),
            )
            .child(doc_scroll("floats-hover-scroll", &h.scroll).child(body))
            .children(corner);
        let placed = self.hover_bounds.clone();
        Some(
            place::at(
                move |s, vp| {
                    let at = crate::kit::place(crate::kit::Anchor::Below(cell), s, vp);
                    placed.set(Some(Bounds::new(at, s)));
                    at
                },
                panel,
            )
            .into_any_element(),
        )
    }

    /// Quick Definition: a header above the peek window's grid and a frame around it (the grid
    /// itself stays visible in between).
    fn render_peek(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let peek = self.peek.as_ref()?;
        let grid = self.grid_of(peek.win, cx)?;
        let geo = self.scx.geometry();
        let place = geo.place(grid)?;
        let m = geo.metrics;
        let grid_rect = Bounds::new(
            place.origin,
            size(
                m.cell_width * place.cells.0 as f32,
                m.row_height * place.cells.1 as f32,
            ),
        );
        let pad = px(style::PEEK_PAD);
        // above the caret: its bottom sits on the caret line, no frame below (it'd cover that line)
        let below = if peek.above {
            px(0.)
        } else {
            px(style::PEEK_PAD_Y)
        };
        // config/peek.lua leaves two rows above the code: the 30 px header, then the code's top
        // padding (WebStorm 12) in the rest, so the caret line stays visible
        let head = m.row_height * 2.;
        let header_h = px(style::PEEK_HEADER_HEIGHT).min(head);
        let frame = Bounds::new(
            point(grid_rect.left() - pad, grid_rect.top() - head),
            size(
                grid_rect.size.width + pad * 2.,
                grid_rect.size.height + head + below,
            ),
        );
        let bg = look::hex(peek.header.bg);
        let font = px(look::UI_FONT_SIZE);
        let several = peek.header.count > 1;
        let buttons = if several { 3. } else { 1. };
        // the path shortened from the left to what fits next to the right part and the buttons
        let fixed = px(style::PEEK_HEADER_PAD_X
            + style::PEEK_HEADER_PAD_R
            + look::ICON_SIZE
            + 2. * style::PEEK_HEADER_GAP
            + buttons * style::PEEK_BUTTON
            + style::PEEK_HEADER_GAP);
        let right_w = text_width(&peek.header.right, UI_FONT.name(), font, window);
        let path = fit_path(&peek.header.path, frame.size.width - fixed - right_w, |s| {
            text_width(s, UI_FONT.name(), font, window)
        });
        let name_fg = match peek.header.status.as_str() {
            "" => style::PEEK_HEADER_FG.rgba(),
            status => crate::editor::tabs::status_color(status),
        };
        let peek_call = |func: &'static str| {
            move |this: &mut FloatsView,
                  _: Bounds<Pixels>,
                  _: &mut Window,
                  _: &mut Context<FloatsView>| {
                this.scx.call("config.peek", func, vec![]);
            }
        };
        let header = div()
            .id("floats-peek-header")
            .debug_selector(|| "floats-peek-header".into())
            .occlude()
            .absolute()
            .left(px(0.))
            .top(px(0.))
            .w(frame.size.width)
            .h(header_h)
            .pl(px(style::PEEK_HEADER_PAD_X))
            .pr(px(style::PEEK_HEADER_PAD_R))
            .flex()
            .items_center()
            .gap(px(style::PEEK_HEADER_GAP))
            .bg(style::PEEK_HEADER_BG)
            .font_family(UI_FONT)
            .text_size(font)
            .child(Icon::new(kit::for_file(&peek.header.file)))
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_color(name_fg)
                    .child(path),
            )
            .child(
                div()
                    .flex_none()
                    .text_color(style::PEEK_HEADER_DIM)
                    .child(SharedString::from(peek.header.right.clone())),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .when(several, |d| {
                        d.child(icon_button(
                            "floats-peek-prev",
                            IconName::PreviousFile,
                            style::PEEK_BUTTON,
                            cx,
                            peek_call("prev"),
                        ))
                        .child(icon_button(
                            "floats-peek-next",
                            IconName::NextFile,
                            style::PEEK_BUTTON,
                            cx,
                            peek_call("next"),
                        ))
                    })
                    .child(icon_button(
                        "floats-peek-more",
                        IconName::MoreVertical,
                        style::PEEK_BUTTON,
                        cx,
                        |this, at, window, cx| this.peek_more(at, window, cx),
                    )),
            );
        // the code's top padding (the rows between the header and the grid)
        let top_pad = Bounds::new(
            point(frame.left(), frame.top() + header_h),
            size(frame.size.width, head - header_h),
        );
        // the body's sides in the popup color (the grid in between stays visible)
        let side = |b: Bounds<Pixels>| {
            div()
                .absolute()
                .left(b.origin.x - frame.origin.x)
                .top(b.origin.y - frame.origin.y)
                .w(b.size.width)
                .h(b.size.height)
                .bg(bg)
        };
        let chrome = div()
            .absolute()
            .left(frame.origin.x)
            .top(frame.origin.y)
            .w(frame.size.width)
            .h(frame.size.height)
            .rounded(px(look::POPUP_ARC))
            .overflow_hidden()
            .child(header)
            .child(side(top_pad))
            .child(side(Bounds::new(
                point(frame.left(), grid_rect.top()),
                size(pad, grid_rect.size.height + below),
            )))
            .child(side(Bounds::new(
                point(grid_rect.right(), grid_rect.top()),
                size(pad, grid_rect.size.height + below),
            )))
            .child(side(Bounds::new(
                point(grid_rect.left(), grid_rect.bottom()),
                size(grid_rect.size.width, below),
            )))
            .child(
                div()
                    .absolute()
                    .top(px(0.))
                    .left(px(0.))
                    .size_full()
                    .rounded(px(look::POPUP_ARC))
                    .border_1()
                    .border_color(style::DOC_BORDER),
            );
        Some(chrome.into_any_element())
    }
}

/// Popup edge -> first label letter in a completion row (WebStorm's `textIndent` 32 + border).
fn menu_lead() -> f32 {
    1. + style::MENU_INSET_X + style::MENU_PAD_X + style::MENU_ICON + style::MENU_ICON_GAP
}

/// A completion row's text width: label + tail, then the type text after a gap (editor font: a
/// cell per char).
fn row_width(i: &Item, cell_width: Pixels) -> Pixels {
    let n = i.label.chars().count() + i.detail.chars().count();
    let w = cell_width * n as f32;
    match i.description.chars().count() {
        0 => w,
        right => w + px(style::MENU_TYPE_GAP) + cell_width * right as f32,
    }
}

/// The completion menu's frame for `rows` rows of `text` width, its labels at `cell`'s x: below
/// the cell, above it when it doesn't fit below; kept inside the window.
/// `ad`: the advertiser strip's hint width (it shows under the rows and may widen the list).
fn menu_frame(
    cell: Bounds<Pixels>,
    rows: usize,
    text: Pixels,
    ad: Option<Pixels>,
    viewport: Size<Pixels>,
) -> Bounds<Pixels> {
    let lead = menu_lead();
    let m = px(look::POPUP_WINDOW_MARGIN);
    let list = px(lead + style::MENU_PAD_RIGHT + style::MENU_INSET_X + 1.) + text;
    let strip = ad.map_or(px(0.), |w| {
        w + px(2. + style::MENU_AD_PAD_L + style::MENU_AD_PAD_R + 2. * style::MENU_AD_BUTTON)
    });
    let w = list
        .max(strip)
        .min(px(style::MENU_MAX_WIDTH))
        .min(viewport.width - m * 2.);
    let body = match ad {
        Some(_) => style::MENU_PAD_Y + style::MENU_PAD_BOTTOM_AD + style::MENU_AD_HEIGHT,
        None => 2. * style::MENU_PAD_Y,
    };
    let h = px(2. + body + style::MENU_ROW_HEIGHT * rows.max(1) as f32);
    let x = (cell.origin.x - px(lead))
        .min(viewport.width - w - m)
        .max(px(0.));
    let below = cell.bottom();
    let above = cell.top() - h;
    // directly under the caret line (WebStorm), above it when it doesn't fit
    let y = if below + h > viewport.height - m && above >= m {
        above
    } else {
        below
    };
    Bounds::new(point(x, y), size(w, h))
}

/// Shortens `path` from the left until it fits `max` ("…/b/c.ts", then "…c.ts"), like the Lua
/// header did.
fn fit_path(path: &str, max: Pixels, width: impl Fn(&str) -> Pixels) -> String {
    if width(path) <= max {
        return path.to_owned();
    }
    let parts: Vec<&str> = path.split('/').collect();
    for i in 1..parts.len() {
        let s = format!("…/{}", parts[i..].join("/"));
        if width(&s) <= max {
            return s;
        }
    }
    let name: Vec<char> = parts.last().copied().unwrap_or(path).chars().collect();
    for skip in 1..name.len() {
        let s = format!("…{}", name[skip..].iter().collect::<String>());
        if width(&s) <= max {
            return s;
        }
    }
    "…".to_owned()
}

fn text_width(text: &str, family: &'static str, font_size: Pixels, window: &Window) -> Pixels {
    crate::kit::width(window, text, gpui_kit::font(family), font_size)
}

/// `inline` with `range` bold on top of its spans.
fn with_bold(inline: Inline, range: Range<usize>) -> Inline {
    let mut out = Inline::plain(inline.text.clone());
    for (r, mut style) in segments(&inline, Some(&range)) {
        if range.start <= r.start && r.end <= range.end {
            style.bold = true;
        }
        if style != SpanStyle::default() {
            out.spans.push(markdown::Span { range: r, style });
        }
    }
    out
}

/// The text cut at every span (and `extra`) boundary: each piece with its span's style.
fn segments(inline: &Inline, extra: Option<&Range<usize>>) -> Vec<(Range<usize>, SpanStyle)> {
    let text = &inline.text;
    let mut cuts = vec![0, text.len()];
    for s in &inline.spans {
        cuts.push(s.range.start);
        cuts.push(s.range.end);
    }
    if let Some(r) = extra {
        cuts.push(r.start);
        cuts.push(r.end);
    }
    cuts.retain(|c| *c <= text.len() && text.is_char_boundary(*c));
    cuts.sort_unstable();
    cuts.dedup();
    // spans are sorted and don't overlap: one pass
    let mut spans = inline.spans.iter().peekable();
    cuts.windows(2)
        .map(|w| {
            let r = w[0]..w[1];
            while spans.peek().is_some_and(|s| s.range.end <= r.start) {
                spans.next();
            }
            let style = spans
                .peek()
                .filter(|s| s.range.start <= r.start && r.end <= s.range.end)
                .map_or_else(SpanStyle::default, |s| s.style);
            (r, style)
        })
        .collect()
}

/// A text block's GPUI text runs, computed once per content (a popup re-renders with the editor:
/// every caret move / flush while it's open).
#[derive(Clone)]
struct Prepared {
    text: SharedString,
    highlights: Rc<[(Range<usize>, HighlightStyle)]>,
    fonts: Rc<[(Range<usize>, SharedString)]>,
}

impl Prepared {
    fn element(&self) -> StyledText {
        StyledText::new(self.text.clone())
            .with_highlights(self.highlights.iter().cloned())
            .with_font_family_overrides(self.fonts.iter().cloned())
    }
}

/// The blocks' runs without a selection.
fn prepare_blocks(blocks: &[Block]) -> Vec<Option<Prepared>> {
    blocks
        .iter()
        .map(|b| match b {
            Block::Code { inline } => Some(prepare(inline, None, true)),
            Block::Text { inline, .. } => Some(prepare(inline, None, false)),
            Block::Rule => None,
        })
        .collect()
}

/// A text block as a GPUI element: its spans (+ the selected range) as highlights, inline code in
/// the editor font on its tint. `code`: the whole block is code (its font set by the parent).
fn styled(inline: &Inline, sel: Option<Range<usize>>, code: bool) -> StyledText {
    prepare(inline, sel, code).element()
}

fn prepare(inline: &Inline, sel: Option<Range<usize>>, code: bool) -> Prepared {
    let mut highlights = Vec::new();
    let mut fonts = Vec::new();
    for (r, span) in segments(inline, sel.as_ref()) {
        let mut h = HighlightStyle::default();
        if let Some(fg) = span.fg {
            h.color = Some(look::hsla(look::hex(fg)));
        }
        if span.bold {
            h.font_weight = Some(FontWeight::BOLD);
        }
        if span.italic {
            h.font_style = Some(FontStyle::Italic);
        }
        if span.strike {
            h.strikethrough = Some(StrikethroughStyle {
                thickness: px(1.),
                color: None,
            });
        }
        if span.link {
            h.color = Some(look::hsla(style::DOC_LINK.rgba()));
        }
        if span.code && !code {
            h.color = h.color.or(Some(look::hsla(style::CODE_FG.rgba())));
            h.background_color = Some(look::hsla(style::DOC_INLINE_CODE_BG.rgba()));
            fonts.push((r.clone(), SharedString::from(EDITOR_FONT)));
        }
        if sel
            .as_ref()
            .is_some_and(|s| s.start <= r.start && r.end <= s.end && s.start < s.end)
        {
            h.background_color = Some(look::hsla(style::DOC_SELECTION_BG.rgba()));
        }
        if h != HighlightStyle::default() {
            highlights.push((r, h));
        }
    }
    Prepared {
        text: SharedString::from(inline.text.clone()),
        highlights: highlights.into(),
        fonts: fonts.into(),
    }
}

/// The documentation popup frame (its content in a [`doc_scroll`]; the corner toolbar over it).
fn doc_frame(id: &'static str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .occlude()
        .relative()
        .flex()
        .flex_col()
        .overflow_hidden()
        .bg(style::DOC_BG)
        .border_1()
        .border_color(style::DOC_BORDER)
        .rounded(px(look::POPUP_ARC))
        .shadow(crate::kit::shadow())
        .font_family(UI_FONT)
        .text_size(px(look::UI_FONT_SIZE))
        .line_height(gpui_kit::relative(style::DOC_LINE_HEIGHT))
        .text_color(style::DOC_FG)
}

/// A doc popup's scrolling content, at most WebStorm's doc popup height.
fn doc_scroll(id: &'static str, scroll: &ScrollHandle) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .max_h(px(style::DOC_MAX_HEIGHT - 2.))
        .overflow_y_scroll()
        .track_scroll(scroll)
        .cursor(CursorStyle::IBeam)
}

/// The hover popup's parts beyond the text: the quick fix row under the problems, the location
/// label under the docs (`Some(None)`: its room kept until Lua sends it; an empty file: none).
struct HoverExtras {
    fix: Option<SharedString>,
    location: Option<Option<(String, SharedString)>>,
}

/// A small action button (20 / 22 px, hover bg). `on_click` gets its bounds (menus open under it).
fn icon_button(
    id: &'static str,
    icon: IconName,
    size_px: f32,
    cx: &mut Context<FloatsView>,
    on_click: impl Fn(&mut FloatsView, Bounds<Pixels>, &mut Window, &mut Context<FloatsView>) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let at: Rc<std::cell::Cell<Option<Bounds<Pixels>>>> = Rc::default();
    let rec = at.clone();
    div()
        .id(id)
        .debug_selector(move || id.into())
        .relative()
        .flex_none()
        .size(px(size_px))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(look::ACTION_BUTTON_ARC))
        .cursor(CursorStyle::Arrow)
        .hover(|s| s.bg(look::ACTION_BUTTON_HOVER_BG))
        .child(Icon::new(icon))
        .child(
            gpui_kit::canvas(move |b, _, _| rec.set(Some(b)), |_, _, _, _| {})
                .absolute()
                .size_full(),
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                let b = at
                    .get()
                    .unwrap_or_else(|| Bounds::new(ev.position, size(px(0.), px(0.))));
                on_click(this, b, window, cx);
                cx.stop_propagation();
            }),
        )
}

/// The longest code line (chars) and whether it's in a boxed block (not the definition on top).
fn code_width(blocks: &[Block]) -> (usize, bool) {
    let mut out = (0, false);
    let mut section_start = true;
    for b in blocks {
        match b {
            Block::Rule => section_start = true,
            Block::Code { inline } => {
                let n = inline
                    .text
                    .lines()
                    .map(|l| l.chars().count())
                    .max()
                    .unwrap_or(0);
                if n > out.0 {
                    out = (n, !section_start);
                }
                section_start = false;
            }
            Block::Text { .. } => section_start = false,
        }
    }
    out
}

/// A 1 px separator across the popup.
fn rule() -> gpui_kit::Div {
    div().flex_none().h(px(1.)).w_full().bg(style::DOC_RULE)
}

/// The blocks of a doc popup: the code problems in their band on top, a separator, the docs (the
/// definition on top in the editor's colors, code blocks boxed). With `layouts`, the text is
/// selectable: mouse down / drag select, the selection drawn, the layouts kept for hit testing.
/// With `extras` (the hover popup): the problems' ⋮ + quick fix row, the docs' location label.
fn doc_body(
    blocks: &[Block],
    prepared: &[Option<Prepared>],
    sel: Option<(Pos, Pos)>,
    layouts: Option<Layouts>,
    extras: Option<HoverExtras>,
    cx: &mut Context<FloatsView>,
) -> gpui_kit::Div {
    let ordered = sel.map(|(a, b)| if a <= b { (a, b) } else { (b, a) });
    if let Some(l) = &layouts {
        let mut l = l.borrow_mut();
        l.clear();
        l.resize(blocks.len(), None);
    }
    let problems = blocks
        .iter()
        .take_while(|b| {
            matches!(
                b,
                Block::Text {
                    kind: TextKind::Problem(_),
                    ..
                }
            )
        })
        .count();
    let mut out = div().flex().flex_col();
    let fix = extras.as_ref().and_then(|e| e.fix.clone());
    let mut band = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(style::DOC_BLOCK_GAP))
        .pl(px(style::DOC_PROBLEM_PAD_L))
        .pr(px(style::DOC_PROBLEM_PAD_R))
        .pt(px(style::DOC_PROBLEM_PAD_TOP))
        .pb(px(if fix.is_some() {
            style::DOC_PROBLEM_PAD_BOTTOM_ACTIONS
        } else {
            style::DOC_PROBLEM_PAD_BOTTOM
        }));
    let mut docs = div()
        .flex()
        .flex_col()
        .gap(px(style::DOC_BLOCK_GAP))
        .px(px(style::DOC_PAD_X))
        .pt(px(style::DOC_PAD_TOP))
        .pb(px(style::DOC_PAD_BOTTOM));
    let mut has_docs = false;
    // the first code block of a section is the definition (no box)
    let mut section_start = true;
    for (ix, block) in blocks.iter().enumerate() {
        let len = block.text().map_or(0, str::len);
        let range = ordered
            .filter(|(a, b)| a.0 <= ix && ix <= b.0)
            .map(|(a, b)| {
                let s = if ix == a.0 { a.1.min(len) } else { 0 };
                let e = if ix == b.0 { b.1.min(len) } else { len };
                s..e.max(s)
            });
        if ix < problems {
            band = band.child(text_el(
                block_inline(block),
                prepared.get(ix).cloned().flatten(),
                range,
                false,
                ix,
                &layouts,
                cx,
            ));
            continue;
        }
        let el = match block {
            Block::Rule => {
                section_start = true;
                if ix == problems {
                    continue; // drawn between the band and the docs
                }
                rule().mx(px(-style::DOC_PAD_X))
            }
            Block::Code { inline } => {
                let code = div()
                    .font_family(EDITOR_FONT)
                    .font_features(crate::render::editor_features())
                    .text_size(px(style::EDITOR_FONT_SIZE))
                    .line_height(gpui_kit::relative(style::DOC_CODE_LINE_HEIGHT))
                    .text_color(style::CODE_FG)
                    .child(text_el(
                        inline,
                        prepared.get(ix).cloned().flatten(),
                        range,
                        true,
                        ix,
                        &layouts,
                        cx,
                    ));
                if section_start {
                    code
                } else {
                    code.bg(style::DOC_CODE_BG)
                        .border_1()
                        .border_color(style::DOC_CODE_BORDER)
                        .rounded(px(style::DOC_CODE_ARC))
                        .px(px(style::DOC_CODE_PAD_X))
                        .py(px(style::DOC_CODE_PAD_Y))
                }
            }
            Block::Text { kind, inline } => {
                let text = text_el(
                    inline,
                    prepared.get(ix).cloned().flatten(),
                    range,
                    false,
                    ix,
                    &layouts,
                    cx,
                );
                match kind {
                    TextKind::Heading(n) => div()
                        .text_size(px(style::DOC_HEADING_SIZES[(*n as usize).clamp(1, 6) - 1]))
                        .font_weight(FontWeight::BOLD)
                        .child(text),
                    TextKind::ListItem { depth, marker } => {
                        let indent = if marker.ends_with('.') {
                            style::DOC_OL_INDENT
                        } else {
                            style::DOC_UL_INDENT
                        };
                        div()
                            .flex()
                            .pl(px(*depth as f32 * indent))
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(style::DOC_LIST_MARKER))
                                    .pr(px(4.))
                                    .child(SharedString::from(marker.clone())),
                            )
                            .child(div().flex_1().child(text))
                    }
                    TextKind::Quote => div()
                        .pl(px(10.))
                        .border_l_2()
                        .border_color(style::DOC_RULE)
                        .text_color(style::DOC_DIM_FG)
                        .child(text),
                    TextKind::Problem(_) | TextKind::Paragraph => div().child(text),
                }
            }
        };
        if !matches!(block, Block::Rule) {
            section_start = false;
        }
        has_docs = true;
        docs = docs.child(el);
    }
    if problems > 0 {
        // a plain information hint has no ⋮ (nothing to configure)
        let hint = blocks[..problems].iter().all(|b| {
            matches!(
                b,
                Block::Text {
                    kind: TextKind::Problem(Severity::Hint),
                    ..
                }
            )
        });
        let more = (extras.is_some() && !hint).then(|| {
            div()
                .flex_none()
                .pt(px(style::DOC_PROBLEM_MORE_TOP))
                .pl(px(style::DOC_PROBLEM_MORE_L))
                .pr(px(style::DOC_PROBLEM_MORE_R))
                .child(icon_button(
                    "floats-problem-more",
                    IconName::MoreVertical,
                    style::DOC_PROBLEM_MORE,
                    cx,
                    |this, at, window, cx| this.problem_more(at, window, cx),
                ))
        });
        let row = div().flex().child(band).children(more);
        out = out.child(
            div()
                .flex()
                .flex_col()
                .bg(style::DOC_PROBLEM_BG)
                .text_color(style::DOC_PROBLEM_FG)
                .child(row)
                .children(fix.map(|fix| actions_row(fix, cx))),
        );
        if has_docs {
            out = out.child(rule());
        }
    }
    let location = extras.and_then(|e| e.location).filter(|_| has_docs);
    // no definition to show: no label row; the corner toolbar beside the text instead
    // (DocumentationPopupUI.updatePaddings' right border)
    let missing = matches!(&location, Some(Some((file, _))) if file.is_empty());
    if has_docs {
        if missing {
            docs = docs
                .pr(px(
                    2. * style::DOC_CORNER_BUTTON + 2. * style::DOC_CORNER_RIGHT
                ))
                .min_h(px(style::DOC_CORNER_BUTTON
                    + style::DOC_CORNER_BOTTOM
                    + style::DOC_PAD_TOP));
        } else if location.is_some() {
            docs = docs.pb(px(style::DOC_BLOCK_GAP / 2.));
        }
        out = out.child(docs);
    }
    if let Some(loc) = location.filter(|_| !missing) {
        out = out.child(location_row(loc));
    }
    out
}

/// "<fix>"  "More actions…" ⌥⏎ under the problems (DaemonTooltipWithActionRenderer).
fn actions_row(fix: SharedString, cx: &mut Context<FloatsView>) -> gpui_kit::Div {
    let link =
        |id: &'static str, text: SharedString, func: &'static str, cx: &mut Context<FloatsView>| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .flex_none()
                .text_color(style::DOC_ACTIONS_LINK)
                .cursor(CursorStyle::PointingHand)
                .child(text)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                        this.hover_call(func);
                        cx.stop_propagation();
                    }),
                )
        };
    div()
        .flex()
        .items_center()
        .pl(px(style::DOC_ACTIONS_PAD_L))
        .pt(px(style::DOC_ACTIONS_PAD_TOP))
        .pb(px(style::DOC_ACTIONS_PAD_BOTTOM))
        .text_size(px(style::DOC_ACTIONS_FONT_SIZE))
        .whitespace_nowrap()
        .child(link("floats-fix", fix, "fix", cx))
        .child(
            link(
                "floats-more-actions",
                "More actions…".into(),
                "more_actions",
                cx,
            )
            .ml(px(style::DOC_ACTIONS_GAP)),
        )
        .child(
            div()
                .flex_none()
                .ml(px(style::DOC_ACTIONS_KEY_GAP))
                .text_color(style::DOC_ACTIONS_KEY_FG)
                .child("⌥⏎"),
        )
}

/// The definition's file under the docs (icon + name; its room kept until it arrives), left of the
/// corner toolbar.
fn location_row(loc: Option<(String, SharedString)>) -> gpui_kit::Div {
    let toolbar = 2. * style::DOC_CORNER_BUTTON + style::DOC_CORNER_RIGHT;
    div()
        .debug_selector(|| "floats-doc-location".into())
        .flex()
        .items_center()
        .gap(px(style::DOC_LOCATION_GAP))
        .min_h(px(style::DOC_LOCATION_PAD_TOP
            + look::ICON_SIZE
            + style::DOC_LOCATION_PAD_BOTTOM))
        .pl(px(style::DOC_LOCATION_PAD_L))
        .pr(px(2. + toolbar))
        .pt(px(style::DOC_LOCATION_PAD_TOP))
        .pb(px(style::DOC_LOCATION_PAD_BOTTOM))
        .text_color(style::DOC_DIM_FG)
        .whitespace_nowrap()
        .children(loc.map(|(file, text)| {
            div()
                .flex()
                .items_center()
                .gap(px(style::DOC_LOCATION_GAP))
                .min_w_0()
                .child(Icon::new(kit::for_file(&file)))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(text),
                )
        }))
}

/// A text block's inline (problems are always text).
fn block_inline(block: &Block) -> &Inline {
    static EMPTY: std::sync::OnceLock<Inline> = std::sync::OnceLock::new();
    match block {
        Block::Text { inline, .. } | Block::Code { inline } => inline,
        Block::Rule => EMPTY.get_or_init(Inline::default),
    }
}

/// One block's text, selectable when `layouts` is given.
fn text_el(
    inline: &Inline,
    prepared: Option<Prepared>,
    sel: Option<Range<usize>>,
    code: bool,
    ix: usize,
    layouts: &Option<Layouts>,
    cx: &mut Context<FloatsView>,
) -> AnyElement {
    let text = match (sel.filter(|r| r.start < r.end), prepared) {
        (None, Some(p)) => p.element(),
        (sel, _) => styled(inline, sel, code),
    };
    let Some(layouts) = layouts else {
        return text.into_any_element();
    };
    let layout = text.layout().clone();
    layouts.borrow_mut()[ix] = Some(layout.clone());
    let down = layout.clone();
    fn index(l: &TextLayout, p: Point<Pixels>) -> usize {
        match l.index_for_position(p) {
            Ok(i) | Err(i) => i,
        }
    }
    div()
        .id(("floats-block", ix))
        .child(text)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, ev: &MouseDownEvent, window, cx| {
                let at = index(&down, ev.position);
                this.select(ix, at, ev.modifiers.shift, cx);
                // a click in the popup gives it the keyboard (Cmd+C, Esc, scrolling)
                this.focus_hover(window, cx);
                cx.stop_propagation();
            }),
        )
        .on_mouse_move(cx.listener(move |this, ev: &MouseMoveEvent, _, cx| {
            let dragging = this.hover.as_ref().is_some_and(|h| h.dragging);
            if dragging && ev.pressed_button == Some(MouseButton::Left) {
                let at = index(&layout, ev.position);
                this.select(ix, at, true, cx);
            }
        }))
        .into_any_element()
}

/// One completion row: kind icon, label (typed letters highlighted, keywords bold) + grayed
/// tail, the type text right-aligned.
/// `focused`: the user moved the selection (blue), else WebStorm's semi-focused gray.
fn menu_row(
    item: &Item,
    ix: usize,
    selected: bool,
    focused: bool,
    cx: &mut Context<FloatsView>,
) -> AnyElement {
    let mut label = Inline::plain(format!("{}{}", item.label, item.detail));
    let label_len = item.label.len();
    let mut matched: Vec<usize> = item
        .matched
        .iter()
        .copied()
        .filter(|&i| i < label_len && item.label.is_char_boundary(i))
        .collect();
    matched.sort_unstable();
    matched.dedup();
    let base = SpanStyle {
        strike: item.deprecated,
        bold: item.kind == kinds::KEYWORD,
        ..SpanStyle::default()
    };
    let match_fg = rgb_u32(if selected {
        style::MENU_MATCH_SELECTED_FG.rgba()
    } else {
        style::MENU_MATCH_FG.rgba()
    });
    let push = |label: &mut Inline, range: Range<usize>, style: SpanStyle| {
        if range.start < range.end && style != SpanStyle::default() {
            label.spans.push(markdown::Span { range, style });
        }
    };
    let mut at = 0;
    for i in matched {
        let end = item.label[i..]
            .chars()
            .next()
            .map_or(i + 1, |c| i + c.len_utf8());
        push(&mut label, at..i, base);
        push(
            &mut label,
            i..end,
            SpanStyle {
                fg: Some(match_fg),
                ..base
            },
        );
        at = end;
    }
    push(&mut label, at..label_len, base);
    let len = label.text.len();
    push(
        &mut label,
        label_len..len,
        SpanStyle {
            fg: Some(rgb_u32(style::MENU_DIM_FG.rgba())),
            bold: false,
            ..base
        },
    );
    let icon = kinds::icon(item.kind, px(style::MENU_ICON), cx);
    let mut row = div()
        .id(("floats-menu-row", ix))
        .flex_none()
        .mx(px(style::MENU_INSET_X))
        .h(px(style::MENU_ROW_HEIGHT.get()))
        .pl(px(style::MENU_PAD_X))
        .pr(px(style::MENU_PAD_RIGHT))
        .flex()
        .items_center()
        .rounded(px(style::MENU_SELECTION_ARC))
        .child(div().flex_none().mr(px(style::MENU_ICON_GAP)).child(icon))
        .child(
            div()
                .flex_1()
                .overflow_hidden()
                .whitespace_nowrap()
                .child(styled(&label, None, true)),
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _: &MouseDownEvent, _, cx| {
                this.scx
                    .call(LUA, "accept", vec![Value::from(ix as u64 + 1)]);
                cx.stop_propagation();
            }),
        );
    if !item.description.is_empty() {
        row = row.child(
            div()
                .flex_none()
                .pl(px(style::MENU_TYPE_GAP))
                .whitespace_nowrap()
                .text_color(style::MENU_DIM_FG)
                .child(item.description.clone()),
        );
    }
    if selected {
        row = row.bg(if focused {
            style::MENU_SELECTION_BG
        } else {
            style::MENU_SELECTION_SEMI_BG
        });
    }
    row.into_any_element()
}

fn rgb_u32(c: gpui_kit::Rgba) -> u32 {
    let b = |v: f32| (v * 255.).round() as u32;
    (b(c.r) << 16) | (b(c.g) << 8) | b(c.b)
}

impl Focusable for FloatsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FloatsView {
    /// Overlay: mounted in a full-window layer, placed from `scx.geometry()`.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let peek = self.render_peek(window, cx);
        let signature = self.render_signature(cx);
        let menu = self.render_menu(window, cx);
        let hover = self.render_hover(window, cx);
        // every mouse move (no hitbox: it blocks nothing): leaving nvim's grids for the app's
        // chrome closes the mouse tooltip, as moving onto other cells did in the terminal
        let weak = cx.entity().downgrade();
        let watcher = gpui_kit::canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let weak = weak.clone();
                window.on_mouse_event(move |ev: &MouseMoveEvent, phase, _, cx| {
                    if phase == gpui_kit::DispatchPhase::Bubble {
                        let _ = weak.update(cx, |this, _| this.mouse_moved(ev.position));
                    }
                });
            },
        )
        .absolute()
        .size_full();
        // no size, no focus tracking here: a full-window focus-tracking root would take the
        // keyboard on any click (only the open hover popup tracks the focus)
        div()
            .child(watcher)
            .children(peek)
            .children(signature)
            .children(menu)
            .children(hover)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_below_the_word_or_above_near_the_bottom() {
        let vp = size(px(1000.), px(800.));
        let cw = px(7.8);
        let cell = Bounds::new(point(px(300.), px(100.)), size(cw, px(22.)));
        let f = menu_frame(cell, 5, cw * 30., None, vp);
        assert_eq!(f.origin.x, px(300. - menu_lead()), "labels under the word");
        assert_eq!(f.top(), cell.bottom(), "right under the caret line");
        let low = Bounds::new(point(px(300.), px(760.)), size(cw, px(22.)));
        let f = menu_frame(low, 5, cw * 30., None, vp);
        assert!(f.bottom() <= low.top(), "above the line near the bottom");
        // a long item never makes it wider than the max / the window
        let f = menu_frame(cell, 1, cw * 1000., None, vp);
        assert!(f.right() <= vp.width);
        // the advertiser strip: 4 + rows + 3 + 24, and a wide hint widens a narrow list
        let f = menu_frame(cell, 5, cw * 5., Some(px(300.)), vp);
        assert_eq!(f.size.height, px(2. + 4. + 22. * 5. + 3. + 24.));
        assert_eq!(f.size.width, px(300. + 2. + 12. + 8. + 40.));
    }

    #[test]
    fn path_shortened_from_the_left() {
        let w = |s: &str| px(s.chars().count() as f32 * 10.);
        assert_eq!(fit_path("a/b/c.ts", px(100.), w), "a/b/c.ts");
        assert_eq!(fit_path("aaaa/bbbb/c.ts", px(110.), w), "…/bbbb/c.ts");
        assert_eq!(fit_path("aaaa/bbbb/c.ts", px(100.), w), "…/c.ts");
        assert_eq!(
            fit_path("aaaa/bbbb/cccccccccccc.ts", px(100.), w),
            "…cccccc.ts"
        );
    }

    #[test]
    fn bold_parameter_keeps_colors() {
        let inline = markdown::code(
            "f(a: number)",
            &[(
                5..11,
                CodeLook {
                    fg: Some(0xcc7832),
                    ..CodeLook::default()
                },
            )],
        );
        let b = with_bold(inline, 2..11);
        let bold: Vec<_> = b.spans.iter().filter(|s| s.style.bold).collect();
        assert_eq!(bold.first().map(|s| s.range.start), Some(2));
        assert!(
            b.spans
                .iter()
                .any(|s| s.style.bold && s.style.fg == Some(0xcc7832))
        );
    }
}
