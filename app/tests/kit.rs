//! The shared widgets (`vimstorm::kit`) driven like the app drives them: real GPUI key / mouse /
//! IME events through a test window (Swedish layout keystrokes from `input::swedish`). No nvim.
// GPUI records debug selectors (`debug_bounds`, which these tests use to find what's drawn) only
// with debug assertions: `cargo test --release` builds none of this file.
#![cfg(debug_assertions)]

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, AppContext as _, Bounds, Context, ElementInputHandler, Entity, Focusable as _,
    InputHandler as _, InteractiveElement as _, IntoElement, KeyDownEvent, Modifiers, MouseButton,
    MouseDownEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render, SharedString,
    Styled as _, TestAppContext, TestDispatcher, VisualTestContext, Window, div, px, size,
};
use vimstorm::editor::input;
use vimstorm::kit;
use vimstorm::kit::{FieldEvent, TextField};
use vimstorm::kit::{
    ListDelegate, ListOptions, ListSource, ListView, RowState, SearchMode, match_text,
};
use vimstorm::look;

type Log = Rc<RefCell<Vec<String>>>;

/// Rows with names; logs confirm / cancel and which rows were rendered.
struct Names {
    items: Vec<SharedString>,
    opts: ListOptions,
    log: Log,
    rendered: Rc<RefCell<Vec<usize>>>,
}

impl ListSource for Names {
    fn len(&self) -> usize {
        self.items.len()
    }
    fn text(&self, ix: usize) -> SharedString {
        self.items[ix].clone()
    }
    fn selectable(&self, ix: usize) -> bool {
        self.items[ix] != "-"
    }
}

impl ListDelegate for Names {
    fn options(&self) -> ListOptions {
        self.opts
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _: &mut Window,
        _: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        self.rendered.borrow_mut().push(ix);
        div()
            .child(match_text(self.items[ix].clone(), row.matches))
            .into_any_element()
    }

    fn confirm(
        &mut self,
        ix: usize,
        state: &vimstorm::kit::ListState,
        _: &mut Window,
        _: &mut Context<ListView<Self>>,
    ) {
        self.log
            .borrow_mut()
            .push(format!("confirm {ix} {:?}", state.selection()));
    }

    fn cancel(&mut self, _: &mut Window, _: &mut Context<ListView<Self>>) {
        self.log.borrow_mut().push("cancel".into());
    }
}

/// A field over a list, like a picker; logs keys the widgets let through.
struct Harness {
    field: Entity<TextField>,
    list: Entity<ListView<Names>>,
    log: Log,
}

impl Render for Harness {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, _| {
                if let Some(k) = kit::notation(ev) {
                    this.log.borrow_mut().push(format!("parent {k}"));
                }
            }))
            .child(div().w(px(300.)).child(self.field.clone()))
            .child(div().flex_1().child(self.list.clone()))
    }
}

struct Kit {
    cx: VisualTestContext,
    field: Entity<TextField>,
    list: Entity<ListView<Names>>,
    log: Log,
    rendered: Rc<RefCell<Vec<usize>>>,
    changes: Rc<RefCell<usize>>,
}

impl Kit {
    fn open(items: Vec<String>, opts: ListOptions) -> Kit {
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        let log: Log = Rc::default();
        let rendered: Rc<RefCell<Vec<usize>>> = Rc::default();
        let changes: Rc<RefCell<usize>> = Rc::default();
        let (log2, rendered2, changes2) = (log.clone(), rendered.clone(), changes.clone());
        let window = app.open_window(size(px(400.), px(600.)), move |_, cx| {
            let field = cx.new(|cx| TextField::new(cx).placeholder("Search").search());
            cx.subscribe(&field, move |_, _, ev: &FieldEvent, _| {
                if *ev == FieldEvent::Changed {
                    *changes2.borrow_mut() += 1;
                }
            })
            .detach();
            let delegate = Names {
                items: items.into_iter().map(Into::into).collect(),
                opts,
                log: log2.clone(),
                rendered: rendered2,
            };
            let list = cx.new(|cx| ListView::new(delegate, cx));
            Harness {
                field,
                list,
                log: log2,
            }
        });
        let root = window.root(&mut app).unwrap();
        let cx = VisualTestContext::from_window(window.into(), &app);
        let (field, list) = root.read_with(&cx, |h, _| (h.field.clone(), h.list.clone()));
        cx.run_until_parked();
        let mut kit = Kit {
            cx,
            field,
            list,
            log,
            rendered,
            changes,
        };
        kit.focus_list();
        kit
    }

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("item{i}")).collect()
    }

    fn focus_list(&mut self) {
        let list = self.list.clone();
        self.cx
            .update(|window, cx| window.focus(&list.focus_handle(cx), cx));
        self.cx.run_until_parked();
    }

    fn focus_field(&mut self) {
        let field = self.field.clone();
        self.cx
            .update(|window, cx| window.focus(&field.focus_handle(cx), cx));
        self.cx.run_until_parked();
    }

    /// Swedish-layout keys, space separated (`ö shift+digit_7 super+a`).
    fn keys(&mut self, triggers: &str) {
        for t in triggers.split(' ') {
            let ks = input::keystroke(t).unwrap_or_else(|| panic!("no key {t}"));
            self.cx
                .update(|window, cx| window.dispatch_keystroke(ks, cx));
            self.cx.run_until_parked();
        }
    }

    fn cursor(&mut self) -> Option<usize> {
        self.list.read_with(&self.cx, |l, _| l.state.cursor())
    }

    fn selection(&mut self) -> Vec<usize> {
        self.list.read_with(&self.cx, |l, _| l.state.selection())
    }

    fn query(&mut self) -> Option<String> {
        self.list
            .read_with(&self.cx, |l, _| l.state.query().map(str::to_owned))
    }

    fn rows_shown(&mut self) -> usize {
        self.list.read_with(&self.cx, |l, _| l.state.row_count())
    }

    fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut *self.log.borrow_mut())
    }

    fn row(&mut self, ix: usize) -> Bounds<Pixels> {
        self.cx
            .debug_bounds(Box::leak(format!("list-row-{ix}").into_boxed_str()))
            .unwrap_or_else(|| panic!("row {ix} not drawn"))
    }

    fn click(&mut self, ix: usize, modifiers: Modifiers, count: usize, button: MouseButton) {
        let at = self.row(ix).center();
        self.cx.simulate_event(MouseDownEvent {
            position: at,
            modifiers,
            button,
            click_count: count,
            first_mouse: false,
        });
        self.cx.simulate_event(MouseUpEvent {
            position: at,
            modifiers,
            button,
            click_count: count,
        });
    }

    fn text(&mut self) -> String {
        self.field.read_with(&self.cx, |f, _| f.text().to_owned())
    }

    fn field_sel(&mut self) -> std::ops::Range<usize> {
        self.field.read_with(&self.cx, |f, _| f.selection())
    }
}

fn mods(shift: bool, cmd: bool, alt: bool) -> Modifiers {
    Modifiers {
        shift,
        platform: cmd,
        alt,
        ..Default::default()
    }
}

#[test]
fn list_moves_with_his_keys_arrows_pages() {
    let mut k = Kit::open(Kit::names(50), ListOptions::default());
    k.keys("ö ö ö");
    assert_eq!(k.cursor(), Some(2));
    k.keys("l");
    assert_eq!(k.cursor(), Some(1));
    k.keys("arrow_down arrow_down");
    assert_eq!(k.cursor(), Some(3));
    k.keys("shift+ö");
    assert_eq!(k.cursor(), Some(8));
    k.keys("end");
    assert_eq!(k.cursor(), Some(49));
    k.keys("home");
    assert_eq!(k.cursor(), Some(0));
    k.keys("page_down");
    let page = k.cursor().unwrap();
    assert!(page >= 5, "a page is the visible rows: {page}");
    k.keys("page_up");
    assert_eq!(k.cursor(), Some(0));
    // other letters do nothing (and reach the parent)
    k.take_log();
    k.keys("x k ä");
    assert_eq!(k.cursor(), Some(0));
    assert_eq!(k.take_log(), ["parent x", "parent k", "parent ä"]);
    k.keys("enter");
    assert_eq!(k.take_log(), ["confirm 0 [0]"]);
    k.keys("escape");
    assert_eq!(k.take_log(), ["cancel"]);
}

#[test]
fn list_searches_only_after_slash() {
    let items = ["alpha", "beta", "gamma", "delta", "-", "lambda", "über"]
        .map(String::from)
        .to_vec();
    let mut k = Kit::open(items, ListOptions::default());
    k.keys("d e");
    assert_eq!(k.query(), None, "letters never search");
    assert_eq!(k.rows_shown(), 7);
    assert!(k.cx.debug_bounds("list-search").is_none());
    // `/` is Shift+7 on his layout
    k.keys("shift+digit_7 l t");
    assert_eq!(k.query().as_deref(), Some("lt"));
    assert!(
        k.cx.debug_bounds("list-search").is_some(),
        "search row shown"
    );
    assert_eq!(k.rows_shown(), 1);
    assert_eq!(k.cursor(), Some(3));
    // l / ö type while searching (no match: nothing shown); arrows move through results
    k.keys("backspace backspace ö");
    assert_eq!(k.query().as_deref(), Some("ö"));
    assert_eq!(k.rows_shown(), 0);
    k.keys("backspace a");
    assert_eq!(k.query().as_deref(), Some("a"));
    assert_eq!(k.cursor(), Some(0));
    k.keys("arrow_down arrow_down");
    assert_eq!(k.cursor(), Some(2));
    // escape closes the search, keeps the selected row
    k.keys("escape");
    assert_eq!(k.query(), None);
    assert_eq!(k.rows_shown(), 7);
    assert!(k.cx.debug_bounds("list-search").is_none());
    k.keys("enter");
    let log = k.take_log();
    assert_eq!(
        log.last().map(String::as_str),
        Some("confirm 2 [2]"),
        "{log:?}"
    );
}

/// Dropdowns type every letter into their filter (k / l / ö / ä too); arrows and Ctrl-n / Ctrl-p
/// move.
#[test]
fn list_dropdown_filters_on_typing() {
    let items = ["alpha", "beta", "gamma", "delta", "-", "omega", "Lambda 2"]
        .map(String::from)
        .to_vec();
    let mut k = Kit::open(items, ListOptions::menu());
    k.keys("arrow_down arrow_down arrow_up");
    assert_eq!(k.cursor(), Some(0));
    k.keys("ctrl+n");
    assert_eq!(k.cursor(), Some(1));
    k.keys("ctrl+p");
    assert_eq!(k.cursor(), Some(0));
    k.keys("k l ö ä");
    assert_eq!(k.query().as_deref(), Some("klöä"), "his moves type too");
    k.keys("escape");
    assert_eq!(k.query(), None);
    k.keys("d e");
    assert_eq!(k.query().as_deref(), Some("de"), "no `/` needed");
    assert!(k.cx.debug_bounds("list-search").is_some(), "the search row");
    assert_eq!(k.rows_shown(), 1);
    assert_eq!(k.cursor(), Some(3));
    k.keys("backspace");
    assert_eq!(k.query().as_deref(), Some("d"));
    k.keys("backspace backspace a");
    assert_eq!(k.query().as_deref(), Some("a"));
    k.keys("ö ö");
    assert_eq!((k.query().as_deref(), k.cursor()), (Some("aöö"), None));
    k.keys("backspace backspace");
    assert_eq!(k.query().as_deref(), Some("a"));
    // Arrow navigation remains available while the visible filter owns text input.
    k.keys("arrow_down arrow_down");
    assert_eq!((k.query().as_deref(), k.cursor()), (Some("a"), Some(2)));
    k.keys("arrow_up");
    assert_eq!(k.cursor(), Some(1));
    // upper case (L too), space, digits type
    k.keys("backspace shift+l space digit_2");
    assert_eq!(k.query().as_deref(), Some("L 2"));
    assert_eq!(k.cursor(), Some(6));
    // Esc: the search (item kept), then the list
    k.keys("escape");
    assert_eq!(k.query(), None);
    assert_eq!((k.rows_shown(), k.cursor()), (7, Some(6)));
    k.take_log();
    k.keys("escape");
    assert_eq!(k.take_log(), ["cancel"]);
}

#[test]
fn list_mouse_selects_multi_selects_and_confirms() {
    let mut k = Kit::open(Kit::names(10), ListOptions::tree());
    k.click(2, Modifiers::default(), 1, MouseButton::Left);
    assert_eq!(k.selection(), [2]);
    k.click(5, mods(true, false, false), 1, MouseButton::Left);
    assert_eq!(k.selection(), [2, 3, 4, 5]);
    k.click(3, mods(false, true, false), 1, MouseButton::Left);
    assert_eq!(k.selection(), [2, 4, 5]);
    k.click(7, mods(false, false, true), 1, MouseButton::Left);
    assert_eq!(k.selection(), [2, 4, 5, 7]);
    // Shift+arrows extend from the anchor
    k.click(1, Modifiers::default(), 1, MouseButton::Left);
    k.keys("shift+arrow_down shift+arrow_down");
    assert_eq!(k.selection(), [1, 2, 3]);
    // right-click inside the selection keeps it
    k.click(2, Modifiers::default(), 1, MouseButton::Right);
    assert_eq!(k.selection(), [1, 2, 3]);
    k.keys("enter");
    assert_eq!(k.take_log(), ["confirm 3 [1, 2, 3]"]);
    // Esc clears the multi-selection first
    k.keys("escape");
    assert_eq!(k.selection(), [3]);
    // double-click confirms
    k.click(6, Modifiers::default(), 1, MouseButton::Left);
    k.click(6, Modifiers::default(), 2, MouseButton::Left);
    assert_eq!(k.take_log(), ["confirm 6 [6]"]);
}

/// `drag_select`: a press dragged over rows selects them; past the top / bottom edge the list
/// keeps going a row per tick; the release ends it (C's changes trees turn it on).
#[test]
fn list_drag_select_with_edge_scroll() {
    let opts = ListOptions {
        drag_select: true,
        ..ListOptions::tree()
    };
    let mut k = Kit::open(Kit::names(100), opts);
    let start = k.row(2).center();
    let mv = |k: &mut Kit, at: Point<Pixels>| {
        k.cx.simulate_mouse_move(at, Some(MouseButton::Left), Modifiers::default());
        k.cx.run_until_parked();
    };
    k.cx.simulate_event(MouseDownEvent {
        position: start,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
        first_mouse: false,
    });
    k.cx.run_until_parked();
    let to = k.row(5).center();
    mv(&mut k, to);
    assert_eq!(k.selection(), [2, 3, 4, 5]);
    assert_eq!(k.cursor(), Some(5));
    // back over the anchor: just it
    mv(&mut k, start);
    assert_eq!(k.selection(), [2]);
    // above the list: a row per tick up to the first
    let top = k.row(0).top();
    mv(&mut k, gpui_kit::point(start.x, top - px(30.)));
    for _ in 0..5 {
        k.cx.executor()
            .advance_clock(std::time::Duration::from_millis(50));
        k.cx.run_until_parked();
    }
    assert_eq!(k.selection(), [0, 1, 2]);
    // below the window: scrolls down past the visible rows
    mv(&mut k, gpui_kit::point(start.x, px(700.)));
    for _ in 0..60 {
        k.cx.executor()
            .advance_clock(std::time::Duration::from_millis(50));
        k.cx.run_until_parked();
    }
    let c = k.cursor().unwrap();
    assert!(c > 40, "auto-scrolled down to {c}");
    assert_eq!(k.selection(), (2..=c).collect::<Vec<_>>());
    // the release ends it: later moves select nothing
    k.cx.simulate_event(MouseUpEvent {
        position: gpui_kit::point(start.x, px(700.)),
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
    });
    k.cx.run_until_parked();
    let after = k.selection();
    mv(&mut k, start);
    assert_eq!(k.selection(), after);
    // without the option a drag selects nothing more
    let mut k = Kit::open(Kit::names(10), ListOptions::tree());
    let start = k.row(2).center();
    k.cx.simulate_event(MouseDownEvent {
        position: start,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 1,
        first_mouse: false,
    });
    let to = k.row(5).center();
    k.cx.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    k.cx.run_until_parked();
    assert_eq!(k.selection(), [2]);
}

#[test]
fn list_hover_and_menu_hover_selects() {
    let mut k = Kit::open(Kit::names(5), ListOptions::menu());
    let at = k.row(3).center();
    k.cx.simulate_mouse_move(at, None, Modifiers::default());
    assert_eq!(k.cursor(), Some(3));
    k.list
        .read_with(&k.cx, |l, _| assert_eq!(l.state.hovered(), Some(3)));
    // menus wrap
    k.keys("arrow_down arrow_down");
    assert_eq!(k.cursor(), Some(0));
}

/// The selection is an inset rounded rect, in the focused color only while the list has focus.
#[test]
fn list_selection_is_an_inset_rounded_rect() {
    let mut k = Kit::open(Kit::names(5), ListOptions::tree());
    k.keys("ö ö");
    let row = k.row(1);
    let scale = 2.; // the test window's scale factor
    let sel_quad = |k: &mut Kit, color: gpui_kit::Rgba| {
        let want = look::hsla(color);
        k.cx.update(|window, _| {
            window
                .painted_quads()
                .into_iter()
                .find(|q| q.background.as_solid() == Some(want))
        })
    };
    let q = sel_quad(&mut k, look::SELECTION_BG.rgba()).expect("focused selection painted");
    let inset = look::SELECTION_INSET_X * scale;
    assert_eq!(q.bounds.origin.x.0, row.origin.x.as_f32() * scale + inset);
    assert_eq!(
        q.bounds.size.width.0,
        row.size.width.as_f32() * scale - 2. * inset
    );
    assert_eq!(q.bounds.size.height.0, row.size.height.as_f32() * scale);
    assert_eq!(q.corner_radii.top_left.0, look::SELECTION_ARC * scale);
    // focus elsewhere: the unfocused selection color
    k.focus_field();
    assert!(sel_quad(&mut k, look::SELECTION_BG.rgba()).is_none());
    assert!(sel_quad(&mut k, look::SELECTION_BG_INACTIVE.rgba()).is_some());
}

#[test]
fn list_of_ten_thousand_rows_draws_only_whats_visible() {
    let mut k = Kit::open(Kit::names(10_000), ListOptions::tree());
    k.rendered.borrow_mut().clear();
    k.keys("end");
    assert_eq!(k.cursor(), Some(9_999));
    let rendered = std::mem::take(&mut *k.rendered.borrow_mut());
    assert!(rendered.contains(&9_999), "scrolled to the end");
    assert!(rendered.len() < 200, "{} rows rendered", rendered.len());
    // search over all of them
    k.keys("shift+digit_7 digit_9 digit_9 digit_9 digit_8");
    assert_eq!(k.rows_shown(), 1);
    assert_eq!(k.cursor(), Some(9_998));
}

#[test]
fn highlight_search_keeps_rows_and_jumps() {
    let opts = ListOptions {
        search: SearchMode::Highlight,
        ..ListOptions::default()
    };
    let items = ["one", "two", "three", "twelve"].map(String::from).to_vec();
    let mut k = Kit::open(items, opts);
    k.keys("shift+digit_7 t w");
    assert_eq!(k.rows_shown(), 4);
    assert_eq!(k.cursor(), Some(1));
    k.keys("arrow_down");
    assert_eq!(k.cursor(), Some(3));
}

#[test]
fn field_edits_with_mac_keys() {
    let mut k = Kit::open(Kit::names(3), ListOptions::default());
    k.focus_field();
    k.cx.simulate_input("hej på dig");
    assert_eq!(k.text(), "hej på dig");
    assert!(*k.changes.borrow() > 0);
    // Swedish letters typed as keys go through the IME handler
    k.keys("space ö");
    assert_eq!(k.text(), "hej på dig ö");
    // byte offsets: å and ö are two bytes
    k.cx.simulate_keystrokes("alt-left");
    assert_eq!(k.field_sel(), 12..12);
    k.cx.simulate_keystrokes("alt-left alt-shift-right");
    assert_eq!(k.field_sel(), 8..11);
    k.cx.simulate_keystrokes("cmd-c cmd-right cmd-v");
    assert_eq!(k.text(), "hej på dig ödig");
    k.cx.simulate_keystrokes("alt-backspace");
    assert_eq!(k.text(), "hej på dig ");
    k.cx.simulate_keystrokes("backspace cmd-left delete");
    assert_eq!(k.text(), "ej på dig");
    k.cx.simulate_keystrokes("cmd-a cmd-x");
    assert_eq!(k.text(), "");
    k.cx.simulate_keystrokes("cmd-v");
    assert_eq!(k.text(), "ej på dig");
    k.cx.simulate_keystrokes("cmd-backspace");
    assert_eq!(k.text(), "");
    // keys the field doesn't use reach the parent
    k.take_log();
    k.cx.simulate_keystrokes("enter escape down");
    assert_eq!(
        k.take_log(),
        ["parent <CR>", "parent <Esc>", "parent <Down>"]
    );
}

#[test]
fn field_composes_dead_keys_through_the_ime() {
    let mut k = Kit::open(Kit::names(3), ListOptions::default());
    k.focus_field();
    k.cx.simulate_input("m");
    let bounds = k.cx.debug_bounds("text-field").unwrap();
    let mut ime = ElementInputHandler::new(bounds, k.field.clone());
    // ¨ then u: AppKit marks the accent, then commits ü in its place
    k.cx.update(|window, cx| ime.replace_and_mark_text_in_range(None, "¨", Some(1..1), window, cx));
    assert_eq!(k.text(), "m¨");
    k.cx.update(|window, cx| ime.replace_text_in_range(None, "ü", window, cx));
    assert_eq!(k.text(), "mü");
    assert_eq!(k.field_sel(), 3..3);
}

#[test]
fn field_mouse_places_caret_and_selects_words() {
    let mut k = Kit::open(Kit::names(3), ListOptions::default());
    k.focus_field();
    k.cx.simulate_input("alpha beta");
    let b = k.cx.debug_bounds("text-field").unwrap();
    // far right of the field: caret at the end; double-click a word selects it
    let right = Point::new(b.right() - px(4.), b.center().y);
    k.cx.simulate_click(right, Modifiers::default());
    assert_eq!(k.field_sel(), 10..10);
    k.cx.simulate_event(MouseDownEvent {
        position: right,
        modifiers: Modifiers::default(),
        button: MouseButton::Left,
        click_count: 2,
        first_mouse: false,
    });
    assert_eq!(k.field_sel(), 6..10);
}

#[test]
fn field_placeholder_and_set_text() {
    let mut k = Kit::open(Kit::names(1), ListOptions::default());
    let field = k.field.clone();
    k.cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("x", cx)));
    assert_eq!(k.text(), "x");
    assert_eq!(k.field_sel(), 1..1);
    let _: Bounds<Pixels> = k.cx.debug_bounds("text-field").unwrap();
}

// ================================================================ widgets

mod widgets {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::time::Duration;

    use gpui_kit::{
        AnyElement, AppContext as _, Bounds, Context, Entity, Focusable as _,
        InteractiveElement as _, IntoElement, Modifiers, MouseButton, MouseDownEvent,
        MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render, Styled as _,
        TestAppContext, TestDispatcher, VisualTestContext, Window, div, point, px, size,
    };
    use vimstorm::editor::input;
    use vimstorm::kit;
    use vimstorm::kit::FilterChip;
    use vimstorm::kit::IconName;
    use vimstorm::kit::ListView;
    use vimstorm::kit::{Axis, IconButton, TextButton, toolbar, toolbar_separator};
    use vimstorm::kit::{ChangeFile, ChangeGroup, ChangeStatus, ChangesTree, ChangesTreeEvent};
    use vimstorm::kit::{CheckState, Checkbox};
    use vimstorm::kit::{CollapsedStripe, VerticalLabel};
    use vimstorm::kit::{Fixed, SplitAxis, SplitEvent, SplitState, split};
    use vimstorm::kit::{SearchField, SearchFieldEvent};
    use vimstorm::kit::{ToolTab, ToolTabs, ToolTabsEvent};
    use vimstorm::look;

    type Log = Rc<RefCell<Vec<String>>>;
    type Build = Rc<dyn Fn(&Log, &mut Window, &mut Context<Host>) -> AnyElement>;

    /// A view that draws whatever a test builds (RenderOnce widgets need a parent view) and logs
    /// the keys that bubble to it.
    struct Host {
        build: Build,
        log: Log,
    }

    impl Render for Host {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let build = self.build.clone();
            let log = self.log.clone();
            div()
                .size_full()
                .on_key_down(cx.listener(|this, ev: &gpui_kit::KeyDownEvent, _, _| {
                    if let Some(k) = kit::notation(ev) {
                        this.log.borrow_mut().push(format!("parent {k}"));
                    }
                }))
                .child(build(&log, window, cx))
        }
    }

    struct T {
        cx: VisualTestContext,
        host: Entity<Host>,
        log: Log,
    }

    impl T {
        fn open(
            w: f32,
            h: f32,
            build: impl Fn(&Log, &mut Window, &mut Context<Host>) -> AnyElement + 'static,
        ) -> T {
            let mut app = TestAppContext::build(TestDispatcher::new(0), None);
            let log: Log = Rc::default();
            let l2 = log.clone();
            let build: Build = Rc::new(build);
            let window = app.open_window(size(px(w), px(h)), move |_, _| Host {
                build: build.clone(),
                log: l2.clone(),
            });
            let host = window.root(&mut app).unwrap();
            let mut cx = VisualTestContext::from_window(window.into(), &app);
            cx.update(|window, _| window.activate_window());
            cx.run_until_parked();
            T { cx, host, log }
        }

        fn take(&mut self) -> Vec<String> {
            std::mem::take(&mut *self.log.borrow_mut())
        }

        fn bounds(&mut self, sel: &str) -> Bounds<Pixels> {
            self.cx
                .debug_bounds(Box::leak(sel.to_string().into_boxed_str()))
                .unwrap_or_else(|| panic!("{sel} not drawn"))
        }

        fn has(&mut self, sel: &str) -> bool {
            self.cx
                .debug_bounds(Box::leak(sel.to_string().into_boxed_str()))
                .is_some()
        }

        fn click_at(&mut self, at: Point<Pixels>, button: MouseButton, count: usize) {
            self.cx.simulate_event(MouseDownEvent {
                position: at,
                modifiers: Modifiers::default(),
                button,
                click_count: count,
                first_mouse: false,
            });
            self.cx.simulate_event(MouseUpEvent {
                position: at,
                modifiers: Modifiers::default(),
                button,
                click_count: count,
            });
            self.cx.run_until_parked();
        }

        fn click(&mut self, sel: &str) {
            let at = self.bounds(sel).center();
            self.click_at(at, MouseButton::Left, 1);
        }

        fn keys(&mut self, triggers: &str) {
            for t in triggers.split(' ') {
                let ks = input::keystroke(t).unwrap_or_else(|| panic!("no key {t}"));
                self.cx
                    .update(|window, cx| window.dispatch_keystroke(ks, cx));
                self.cx.run_until_parked();
            }
        }

        fn focus(&mut self, h: gpui_kit::FocusHandle) {
            self.cx.update(|window, cx| window.focus(&h, cx));
            self.cx.run_until_parked();
        }

        fn redraw(&mut self) {
            let host = self.host.clone();
            self.cx.update(|_, cx| host.update(cx, |_, cx| cx.notify()));
            self.cx.run_until_parked();
        }

        /// Quads painted in a color (device px).
        fn quads(&mut self, color: gpui_kit::Rgba) -> Vec<Bounds<gpui_kit::ScaledPixels>> {
            let want = look::hsla(color);
            self.cx.update(|window, _| {
                window
                    .painted_quads()
                    .into_iter()
                    .filter(|q| q.background.as_solid() == Some(want))
                    .map(|q| q.bounds)
                    .collect()
            })
        }
    }

    fn log(l: &Log, s: impl Into<String>) {
        l.borrow_mut().push(s.into());
    }

    // ------------------------------------------------------------ tool window tabs

    fn git_tabs() -> Vec<ToolTab> {
        vec![
            ToolTab::new("Local Changes"),
            ToolTab::new("Console"),
            ToolTab::new("Log: HEAD").closable(true),
        ]
    }

    fn tabs_host(width: f32) -> (T, Entity<ToolTabs>) {
        let tabs: Rc<RefCell<Option<Entity<ToolTabs>>>> = Rc::default();
        let t2 = tabs.clone();
        let mut t = T::open(width, 100., move |l, _, cx| {
            let e = t2
                .borrow_mut()
                .get_or_insert_with(|| {
                    let e = cx.new(|_| ToolTabs::new("Git", git_tabs()));
                    let l = l.clone();
                    cx.subscribe(&e, move |_, _, ev: &ToolTabsEvent, _| {
                        log(&l, format!("{ev:?}"))
                    })
                    .detach();
                    e
                })
                .clone();
            div().w_full().child(e).into_any_element()
        });
        t.redraw();
        let e = tabs.borrow().clone().unwrap();
        (t, e)
    }

    #[test]
    fn tool_tabs_select_close_and_box_colors() {
        let (mut t, tabs) = tabs_host(800.);
        assert!(!t.has("tool-tabs-overflow"), "all fit");
        t.click("tool-tab-1");
        assert_eq!(t.take(), ["Select(1)"]);
        assert_eq!(tabs.read_with(&t.cx, |e, _| e.selected()), 1);
        // the × closes (no select)
        t.click("tool-tab-close-2");
        assert_eq!(t.take(), ["Close(2)"]);
        // middle click closes a closable tab, not the others
        let at = t.bounds("tool-tab-2").center();
        t.click_at(at, MouseButton::Middle, 1);
        let at = t.bounds("tool-tab-0").center();
        t.click_at(at, MouseButton::Middle, 1);
        assert_eq!(t.take(), ["Close(2)"]);
        // selected box: gray while the tool window is inactive, blue when active
        let sel = t.bounds("tool-tab-1");
        let gray = t.quads(look::TOOLWINDOW_TAB_SELECTED_INACTIVE_BG.rgba());
        assert!(
            gray.iter()
                .any(|q| (q.size.height.0 / 2. - sel.size.height.as_f32()).abs() < 0.6)
        );
        assert!(t.quads(look::TOOLWINDOW_TAB_SELECTED_BG.rgba()).is_empty());
        t.cx.update(|_, cx| tabs.update(cx, |e, cx| e.set_active(true, cx)));
        t.cx.run_until_parked();
        assert!(!t.quads(look::TOOLWINDOW_TAB_SELECTED_BG.rgba()).is_empty());
        assert_eq!(sel.size.height, px(look::TOOLWINDOW_TAB_HEIGHT));
        // title + labels 1.5 px below centre (30.png), the boxes stay centred in the header
        // (layout snaps to device px: within 0.25)
        let header = t.bounds("tool-tabs");
        let label = t.bounds("tool-tab-label-1");
        let title = t.bounds("tool-tabs-title");
        let dy = look::TOOLWINDOW_TEXT_DY;
        assert!(
            (label.center().y - sel.center().y - px(dy)).abs() <= px(0.25),
            "{label:?} in {sel:?}"
        );
        // the header's 1 px bottom line isn't part of the centred row
        let row = header.origin.y + (header.size.height - px(1.)) / 2.;
        assert!(
            (sel.center().y - row).abs() <= px(0.25),
            "{sel:?} in {header:?}"
        );
        assert!(
            (title.center().y - row - px(dy)).abs() <= px(0.25),
            "{title:?}"
        );
    }

    #[test]
    fn tool_tabs_overflow_hides_tabs_but_not_the_selected() {
        let (mut t, tabs) = tabs_host(230.);
        t.cx.update(|_, cx| tabs.update(cx, |e, cx| e.select(2, cx)));
        t.redraw();
        assert!(t.has("tool-tabs-overflow"));
        assert!(t.has("tool-tab-2"), "the selected tab stays");
        assert!(!t.has("tool-tab-1"));
        t.click("tool-tabs-overflow");
        let ev = t.take();
        assert!(ev[0].starts_with("ShowHidden([0, 1]"), "{ev:?}");
    }

    // ------------------------------------------------------------ icon buttons

    #[test]
    fn icon_buttons_click_toggle_disable_and_tooltip() {
        let toggled = Rc::new(Cell::new(false));
        let tg = toggled.clone();
        let mut t = T::open(300., 100., move |l, _, _| {
            let (l1, l2, tg2) = (l.clone(), l.clone(), tg.clone());
            toolbar(Axis::Horizontal)
                .child(
                    IconButton::new("refresh", IconName::Refresh)
                        .tooltip("Refresh", Some("⌘R"))
                        .on_click(move |_, _, _| log(&l1, "refresh")),
                )
                .child(toolbar_separator(Axis::Horizontal))
                .child(
                    IconButton::new("pick", IconName::CherryPick)
                        .disabled(true)
                        .on_click(move |_, _, _| log(&l2, "pick")),
                )
                .child(
                    IconButton::new("eye", IconName::Show)
                        .dropdown(true)
                        .toggled(tg2.get())
                        .on_click(move |_, _, _| tg2.set(!tg2.get())),
                )
                .into_any_element()
        });
        t.click("button-refresh");
        t.click("button-pick");
        assert_eq!(t.take(), ["refresh"], "disabled buttons ignore clicks");
        let b = t.bounds("button-refresh");
        assert_eq!(b.size.width, px(look::ACTION_BUTTON_SIZE));
        assert!(t.has("toolbar-separator"));
        // toggled background
        assert!(t.quads(look::ACTION_BUTTON_TOGGLED_BG.rgba()).is_empty());
        t.click("button-eye");
        // (pointer away: hover would paint over the toggled background)
        t.cx.simulate_mouse_move(point(px(290.), px(90.)), None, Modifiers::default());
        t.redraw();
        assert!(toggled.get());
        assert!(!t.quads(look::ACTION_BUTTON_TOGGLED_BG.rgba()).is_empty());
        // hover: background + tooltip after the delay
        let at = t.bounds("button-refresh").center();
        t.cx.simulate_mouse_move(at, None, Modifiers::default());
        t.cx.executor().advance_clock(Duration::from_secs(2));
        t.cx.run_until_parked();
        assert!(t.has("tooltip"), "tooltip shown");
        // Islands: MID "*.hoverBackground" (#393B40) beats EXP's translucent ActionButton hover
        assert_eq!(look::ACTION_BUTTON_HOVER_BG.rgba(), gpui_kit::rgb(0x393B40));
        assert!(!t.quads(look::ACTION_BUTTON_HOVER_BG.rgba()).is_empty());
    }

    #[test]
    fn text_buttons_click_unless_disabled() {
        let mut t = T::open(400., 100., move |l, _, _| {
            let (l1, l2) = (l.clone(), l.clone());
            div()
                .flex()
                .child(
                    TextButton::new("commit", "Commit")
                        .primary(true)
                        .on_click(move |_, _, _| log(&l1, "commit")),
                )
                .child(
                    TextButton::new("push", "Commit and Push…")
                        .disabled(true)
                        .on_click(move |_, _, _| log(&l2, "push")),
                )
                .into_any_element()
        });
        t.click("button-commit");
        t.click("button-push");
        assert_eq!(t.take(), ["commit"]);
        assert_eq!(
            t.bounds("button-commit").size.height,
            px(look::BUTTON_HEIGHT)
        );
        assert!(!t.quads(look::BUTTON_PRIMARY_BG.rgba()).is_empty());
    }

    // ------------------------------------------------------------ search field

    #[test]
    fn search_field_types_toggles_and_lets_keys_through() {
        let field: Rc<RefCell<Option<Entity<SearchField>>>> = Rc::default();
        let f2 = field.clone();
        let mut t = T::open(400., 100., move |l, _, cx| {
            let e = f2
                .borrow_mut()
                .get_or_insert_with(|| {
                    let e = cx.new(|cx| SearchField::new("Text or hash", cx).with_history());
                    let l = l.clone();
                    cx.subscribe(&e, move |_, _, ev: &SearchFieldEvent, _| {
                        let s = match ev {
                            SearchFieldEvent::History(_) => "History".to_string(),
                            other => format!("{other:?}"),
                        };
                        log(&l, s)
                    })
                    .detach();
                    e
                })
                .clone();
            div().w(px(320.)).child(e).into_any_element()
        });
        let field = field.borrow().clone().unwrap();
        let h = field.read_with(&t.cx, |f, cx| f.focus_handle(cx));
        t.focus(h.clone());
        t.cx.simulate_input("fix");
        assert_eq!(
            field.read_with(&t.cx, |f, cx| f.text(cx).to_string()),
            "fix"
        );
        // (typed keys also bubble, like the plain field's: owners ignore text keys)
        let ev: Vec<String> = t
            .take()
            .into_iter()
            .filter(|e| !e.starts_with("parent"))
            .collect();
        assert_eq!(ev, ["Changed", "Changed", "Changed"]);
        // Alt+X regex, Alt+C match case (not Option chars in the text)
        t.keys("alt+x alt+c");
        assert_eq!(t.take(), ["OptionsChanged", "OptionsChanged"]);
        assert!(field.read_with(&t.cx, |f, _| f.regex() && f.match_case()));
        assert_eq!(
            field.read_with(&t.cx, |f, cx| f.text(cx).to_string()),
            "fix"
        );
        // clicking a toggle flips it and the text keeps the keyboard
        t.click("search-field-case");
        assert!(!field.read_with(&t.cx, |f, _| f.match_case()));
        assert!(t.cx.update(|window, _| h.is_focused(window)));
        assert!(
            !t.quads(look::SEARCH_FIELD_TOGGLE_ON_BG.rgba()).is_empty(),
            "regex still on"
        );
        t.take();
        // Enter / Esc / Down reach the owner
        t.keys("enter escape arrow_down");
        assert_eq!(t.take(), ["parent <CR>", "parent <Esc>", "parent <Down>"]);
        // the history magnifier
        t.click("search-field-icon");
        assert_eq!(t.take(), ["History"]);
        // the frame is blue while focused
        assert_eq!(
            t.bounds("search-field").size.height,
            px(look::SEARCH_FIELD_HEIGHT)
        );
    }

    fn field_host(case_first: bool) -> (T, Entity<SearchField>) {
        let field: Rc<RefCell<Option<Entity<SearchField>>>> = Rc::default();
        let f2 = field.clone();
        let t = T::open(400., 100., move |_, _, cx| {
            let e = f2
                .borrow_mut()
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let f = SearchField::new("Text or hash", cx);
                        if case_first { f.case_first() } else { f }
                    })
                })
                .clone();
            div().w(px(320.)).child(e).into_any_element()
        });
        let e = field.borrow().clone().unwrap();
        (t, e)
    }

    #[test]
    fn search_field_focus_ring_and_case_first_order() {
        // the VCS log keeps `.*` first (30.png); WS's editor-style find: Cc first
        let (mut t, _) = field_host(true);
        assert!(t.bounds("search-field-case").left() < t.bounds("search-field-regex").left());
        let (mut t, field) = field_host(false);
        assert!(t.bounds("search-field-regex").left() < t.bounds("search-field-case").left());
        // focused: a 2 px Blue6 ring drawn inward, the icon doesn't move
        let ring = |t: &mut T| {
            t.cx.update(|window, _| {
                window
                    .painted_quads()
                    .into_iter()
                    .find(|q| q.border_color == look::hsla(look::FOCUS_BORDER.rgba()))
                    .map(|q| q.border_widths.left.0 / window.scale_factor())
            })
        };
        let icon = t.bounds("search-field-icon");
        assert_eq!(ring(&mut t), None);
        let h = field.read_with(&t.cx, |f, cx| f.focus_handle(cx));
        t.focus(h);
        assert_eq!(ring(&mut t), Some(2.));
        assert_eq!(t.bounds("search-field-icon"), icon);
    }

    // ------------------------------------------------------------ chips, checkbox, stripe

    #[test]
    fn filter_chips_open_and_clear() {
        let mut t = T::open(500., 100., move |l, _, _| {
            let (l1, l2, l3) = (l.clone(), l.clone(), l.clone());
            div()
                .flex()
                .child(
                    FilterChip::new("branch", "Branch")
                        .value(Some("HEAD"))
                        .on_open(move |b, _, _| {
                            log(&l1, format!("open branch {}", b.size.width > px(0.)))
                        })
                        .on_clear(move |_, _| log(&l2, "clear branch")),
                )
                .child(
                    FilterChip::new("user", "User")
                        .value(None::<&str>)
                        .on_open(move |_, _, _| log(&l3, "open user")),
                )
                .into_any_element()
        });
        t.click("chip-branch");
        t.click("chip-clear-branch");
        t.click("chip-user");
        assert_eq!(t.take(), ["open branch true", "clear branch", "open user"]);
        assert!(!t.has("chip-clear-user"), "no × without a value");
    }

    #[test]
    fn checkbox_and_stripe_click() {
        let state = Rc::new(Cell::new(CheckState::Mixed));
        let s2 = state.clone();
        let mut t = T::open(300., 300., move |l, _, _| {
            let (s3, l2) = (s2.clone(), l.clone());
            div()
                .flex()
                .h_full()
                .child(
                    CollapsedStripe::new("branches", VerticalLabel::Branches)
                        .on_expand(move |_, _, _| log(&l2, "expand")),
                )
                .child(
                    Checkbox::new("amend", s2.get())
                        .label("Amend")
                        .on_toggle(move |next, _, _| s3.set(next)),
                )
                .into_any_element()
        });
        t.click("stripe-branches");
        assert_eq!(t.take(), ["expand"]);
        assert_eq!(
            t.bounds("stripe-branches").size.width,
            px(look::STRIPE_WIDTH)
        );
        let b = t.bounds("stripe-branches");
        t.cx.simulate_click(b.center() + point(px(0.), px(40.)), Modifiers::default());
        assert_eq!(t.take(), ["expand"], "the label area expands too");
        // Mixed -> Checked -> Unchecked
        let at =
            t.cx.debug_bounds("stripe-branches")
                .map(|b| point(b.right() + px(20.), px(10.)))
                .unwrap();
        t.click_at(at, MouseButton::Left, 1);
        assert_eq!(state.get(), CheckState::Checked);
        t.redraw();
        t.click_at(at, MouseButton::Left, 1);
        assert_eq!(state.get(), CheckState::Unchecked);
    }

    // ------------------------------------------------------------ splitter

    #[test]
    fn splitter_drags_and_clamps() {
        let state: Rc<RefCell<Option<Entity<SplitState>>>> = Rc::default();
        let s2 = state.clone();
        let mut t = T::open(600., 200., move |l, _, cx| {
            let e = s2
                .borrow_mut()
                .get_or_insert_with(|| {
                    let e = cx.new(|_| {
                        SplitState::new(SplitAxis::Horizontal, Fixed::Second, px(200.))
                            .with_min(px(100.), px(80.))
                    });
                    let l = l.clone();
                    cx.subscribe(&e, move |_, _, ev: &SplitEvent, _| {
                        log(&l, format!("resized {}", ev.size.as_f32()))
                    })
                    .detach();
                    e
                })
                .clone();
            split(
                "split",
                &e,
                div().size_full().debug_selector(|| "pane-a".into()),
                div().size_full().debug_selector(|| "pane-b".into()),
                cx,
            )
        });
        t.redraw();
        assert_eq!(t.bounds("pane-b").size.width, px(200.));
        assert_eq!(t.bounds("pane-a").size.width, px(399.));
        // drag the divider 50 px left: the fixed (second) pane grows
        let d = t.bounds("split-divider").center();
        t.cx.simulate_event(MouseDownEvent {
            position: d,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 1,
            first_mouse: false,
        });
        t.cx.run_until_parked();
        t.cx.simulate_event(MouseMoveEvent {
            position: d - point(px(50.), px(0.)),
            modifiers: Modifiers::default(),
            pressed_button: Some(MouseButton::Left),
        });
        t.cx.run_until_parked();
        assert_eq!(t.bounds("pane-b").size.width, px(250.));
        // far right: the second pane keeps its minimum
        t.cx.simulate_event(MouseMoveEvent {
            position: point(px(599.), d.y),
            modifiers: Modifiers::default(),
            pressed_button: Some(MouseButton::Left),
        });
        t.cx.run_until_parked();
        assert_eq!(t.bounds("pane-b").size.width, px(80.));
        t.cx.simulate_event(MouseUpEvent {
            position: point(px(599.), d.y),
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 1,
        });
        t.cx.run_until_parked();
        assert_eq!(t.take(), ["resized 80"]);
        let sz = state
            .borrow()
            .clone()
            .unwrap()
            .read_with(&t.cx, |s, _| s.size());
        assert_eq!(sz, px(80.));
    }

    // ------------------------------------------------------------ changes tree

    fn changes() -> Vec<ChangeGroup> {
        use ChangeStatus::*;
        vec![
            ChangeGroup::changelist(
                "changes",
                "Changes",
                vec![
                    ChangeFile::new("src/services/api/client.ts", Modified),
                    ChangeFile::new("src/services/api/auth.ts", Added),
                    ChangeFile::new("README.md", Modified),
                ],
            ),
            ChangeGroup::unversioned(vec![ChangeFile::new("notes.txt", Unversioned)]),
        ]
    }

    fn tree_host(checkboxes: bool) -> (T, Entity<ListView<ChangesTree>>) {
        let tree: Rc<RefCell<Option<Entity<ListView<ChangesTree>>>>> = Rc::default();
        let t2 = tree.clone();
        let mut t = T::open(400., 400., move |l, _, cx| {
            let e = t2
                .borrow_mut()
                .get_or_insert_with(|| {
                    let e = cx.new(|cx| {
                        let mut d = ChangesTree::new().with_root("/repo");
                        if checkboxes {
                            d = d.with_checkboxes();
                        }
                        let mut v = ListView::new(d, cx);
                        let ListView {
                            delegate, state, ..
                        } = &mut v;
                        delegate.set_groups(changes(), state);
                        v
                    });
                    let l = l.clone();
                    cx.subscribe(&e, move |_, _, ev: &ChangesTreeEvent, _| {
                        let s = match ev {
                            ChangesTreeEvent::Open(files) => format!(
                                "open {}",
                                files
                                    .iter()
                                    .map(|f| f.path.as_str())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            ),
                            ChangesTreeEvent::ContextMenu(_) => "menu".into(),
                            other => format!("{other:?}"),
                        };
                        log(&l, s)
                    })
                    .detach();
                    e
                })
                .clone();
            div().size_full().child(e).into_any_element()
        });
        t.redraw();
        let e = tree.borrow().clone().unwrap();
        let h = e.read_with(&t.cx, |v, cx| v.focus_handle(cx));
        t.focus(h);
        (t, e)
    }

    fn labels(t: &mut T, tree: &Entity<ListView<ChangesTree>>) -> Vec<String> {
        tree.read_with(&t.cx, |v, _| {
            use vimstorm::kit::ListSource as _;
            (0..v.delegate.len())
                .map(|i| {
                    let r = &v.delegate.rows()[i];
                    format!("{}{}", "  ".repeat(r.depth), v.delegate.text(i))
                })
                .collect()
        })
    }

    fn cursor(t: &mut T, tree: &Entity<ListView<ChangesTree>>) -> Option<usize> {
        tree.read_with(&t.cx, |v, _| v.state.cursor())
    }

    #[test]
    fn changes_tree_keys_fold_move_and_open() {
        let (mut t, tree) = tree_host(false);
        assert_eq!(
            labels(&mut t, &tree),
            [
                "Changes",
                "  src/services/api",
                "    auth.ts",
                "    client.ts",
                "  README.md",
                "Unversioned Files",
                "  notes.txt"
            ]
        );
        // ö ö ö: client.ts? no: rows 0,1,2
        t.keys("ö ö ö");
        assert_eq!(cursor(&mut t, &tree), Some(2));
        // k: to the folder; k again folds it
        t.keys("k");
        assert_eq!(cursor(&mut t, &tree), Some(1));
        t.keys("k");
        assert_eq!(labels(&mut t, &tree).len(), 5);
        // ä unfolds, ä again steps in
        t.keys("ä ä");
        assert_eq!(cursor(&mut t, &tree), Some(2));
        t.take();
        // Enter on a file opens it; Shift+Down + Enter: both
        t.keys("enter");
        assert_eq!(t.take(), ["open src/services/api/auth.ts"]);
        t.keys("shift+arrow_down enter");
        let ev = t.take();
        assert_eq!(
            ev.last().map(String::as_str),
            Some("open src/services/api/auth.ts,src/services/api/client.ts"),
            "{ev:?}"
        );
        // Enter on a folder folds it (no open)
        t.keys("escape l l enter");
        assert_eq!(
            labels(&mut t, &tree)[1..3],
            ["  src/services/api", "  README.md"]
        );
        assert!(!t.take().iter().any(|e| e.starts_with("open")));
        // Cmd+C: the selected rows' paths
        t.keys("super+c");
        let clip = t.cx.read_from_clipboard().and_then(|c| c.text());
        assert_eq!(clip.as_deref(), Some("/repo/src/services/api"));
        // letters don't search; `/` does (highlight: rows stay)
        t.keys("shift+digit_7 n o t");
        assert_eq!(
            cursor(&mut t, &tree),
            Some(4),
            "{:?}",
            labels(&mut t, &tree)
        );
        assert_eq!(labels(&mut t, &tree).len(), 5);
        t.keys("escape escape");
        assert_eq!(t.take().last().map(String::as_str), Some("Cancel"));
    }

    #[test]
    fn changes_tree_mouse_chevrons_checkboxes_double_click() {
        let (mut t, tree) = tree_host(true);
        // the chevron folds without selecting
        t.click("changes-chevron-1");
        assert_eq!(labels(&mut t, &tree).len(), 5);
        assert_eq!(cursor(&mut t, &tree), None);
        t.click("changes-chevron-1");
        assert_eq!(labels(&mut t, &tree).len(), 7);
        // a folder's checkbox includes its files; the group's box is then partly checked
        t.click("changes-check-1");
        assert_eq!(t.take(), ["IncludedChanged"]);
        let inc = |t: &mut T| {
            tree.read_with(&t.cx, |v, _| {
                let mut v: Vec<String> = v.delegate.included().unwrap().iter().cloned().collect();
                v.sort();
                v
            })
        };
        assert_eq!(
            inc(&mut t),
            ["src/services/api/auth.ts", "src/services/api/client.ts"]
        );
        assert_eq!(
            tree.read_with(&t.cx, |v, _| v.delegate.check_state(0)),
            CheckState::Mixed
        );
        // Space on a selected file toggles it
        let row = t.cx.debug_bounds("list-row-4").unwrap().center();
        t.click_at(row, MouseButton::Left, 1);
        t.keys("space");
        assert_eq!(inc(&mut t).len(), 3);
        assert_eq!(
            tree.read_with(&t.cx, |v, _| v.delegate.check_state(0)),
            CheckState::Checked
        );
        t.take();
        // double-click on a file opens it, on a folder folds it
        t.click_at(row, MouseButton::Left, 2);
        assert_eq!(t.take(), ["open README.md"]);
        let folder = t.cx.debug_bounds("list-row-1").unwrap().center();
        t.click_at(folder, MouseButton::Left, 1);
        t.click_at(folder, MouseButton::Left, 2);
        assert_eq!(labels(&mut t, &tree).len(), 5);
        // right-click: menu
        t.take();
        t.click_at(folder, MouseButton::Right, 1);
        assert!(t.take().contains(&"menu".to_string()));
    }
}
