//! The Log's filter bar (WS VcsLogClassicFilterUi, 30.png): the "Text or hash" field with `.*` /
//! `Cc` (and a × while a text filter is applied), the Branch / User / Date / Paths chips (Lines
//! during Show History for Selection) and the right-side icon toolbar (Refresh, Cherry-Pick, View
//! Options, Go to Hash/Branch/Tag). Behaviour of the M4 Lua bar (`git/log.lua` `draw_bar`,
//! `git/init.lua` filters):
//!
//! - Field: `/` focuses it with the applied text selected (typing replaces it); Enter applies
//!   (empty: no text filter) and gives the keyboard back to the table; Esc goes back to the
//!   table, the applied text stays; a click focuses it. `.*` / `Cc` (click, Alt+X / Alt+C)
//!   reload only when a text filter is applied (Lua `toggle_search_option`).
//! - Chips: a click opens the filter's popup ([`super::filter_popup`]) under the chip, the ×
//!   clears just that filter, right-click: "Filter by <X>…" + "Clear Filter".
//! - Narrow: Lua's FITS rule, see [`FITS`]: every set filter keeps its ×.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, AppContext as _, Bounds, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, ParentElement as _, Pixels,
    Styled as _, Subscription, Task, WeakEntity, Window, canvas, div, prelude::FluentBuilder as _,
    px,
};

use super::filter_popup::{ALL, Choices, Done, OpenPopup};
use super::{LogTab, Reload};
use crate::git::branches::FilterRefs;
use crate::git::log::{BranchFilter, DateFilter, LogFilters};
use crate::kit;
use crate::kit::Anchor;
use crate::kit::FilterChip;
use crate::kit::IconName;
use crate::kit::{Axis, IconButton, toolbar};
use crate::kit::{SearchField, SearchFieldEvent};
use crate::look;
use crate::popups::{self, Input, Menu, MenuEntry, MenuItem};
use crate::render::ui_font;

/// A filter chip / popup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FilterKind {
    Branch,
    User,
    Date,
    Paths,
}

impl FilterKind {
    /// The chip's name.
    pub fn name(self) -> &'static str {
        match self {
            FilterKind::Branch => "Branch",
            FilterKind::User => "User",
            FilterKind::Date => "Date",
            FilterKind::Paths => "Paths",
        }
    }

    /// The log key that opens its popup.
    pub fn key(self) -> &'static str {
        match self {
            FilterKind::Branch => "b",
            FilterKind::User => "u",
            FilterKind::Date => "d",
            FilterKind::Paths => "p",
        }
    }

    /// The popup's title (Lua's picker titles).
    fn title(self) -> &'static str {
        match self {
            FilterKind::Branch => "Branch",
            FilterKind::User => "User (Tab selects several)",
            FilterKind::Date => "Date",
            FilterKind::Paths => "Paths (Tab selects several)",
        }
    }

    /// The chip's element id (debug selectors `chip-<id>`, `chip-clear-<id>`).
    pub fn id(self) -> &'static str {
        match self {
            FilterKind::Branch => "branch",
            FilterKind::User => "user",
            FilterKind::Date => "date",
            FilterKind::Paths => "paths",
        }
    }

    fn spot(self) -> &'static str {
        match self {
            FilterKind::Branch => "chip-branch",
            FilterKind::User => "chip-user",
            FilterKind::Date => "chip-date",
            FilterKind::Paths => "chip-paths",
        }
    }
}

/// The Date popup's custom range row.
pub const DATE_SELECT: &str = "Select…";

/// The field's width in 30.png (315 px / 1.4405); [`field_min_width`] when narrow.
const FIELD_WIDTH: f32 = 219.0;
/// The field's placeholder.
const PLACEHOLDER: &str = "Text or hash";

/// The narrow field: WS's minimum ([`look::SEARCH_FIELD_MIN_WIDTH`]), or wide enough for the
/// placeholder whole beside the magnifier and the `.*` / `Cc` toggles (150 px cut it to
/// "Text or ha").
fn field_min_width(window: &Window) -> f32 {
    // border, pad, magnifier, its gap (the text's own left padding in it), the text's right
    // padding, the toggles, pad
    let chrome = 2.
        + look::SEARCH_FIELD_PAD_LEFT
        + look::ICON_SIZE
        + look::SEARCH_FIELD_ICON_GAP
        + look::FIELD_PADDING_X
        + 2. * look::SEARCH_FIELD_TOGGLE_SIZE
        + look::SEARCH_FIELD_TOGGLE_GAP
        + look::SEARCH_FIELD_PAD_RIGHT;
    look::SEARCH_FIELD_MIN_WIDTH.max((chrome + text_width(window, PLACEHOLDER)).ceil())
}
/// The field shrunk to its magnifier: border + pads + icon.
const FIELD_COMPACT: f32 = 2. + look::SEARCH_FIELD_PAD_LEFT + 16. + look::SEARCH_FIELD_PAD_RIGHT;
/// Toolbar: Refresh, Cherry-Pick, View Options, Go to (WS's Resume Indexing has no equivalent).
const TOOLBAR_BUTTONS: f32 = 4.;
/// The toolbar's right inset (kit_gallery's 30.png assembly).
fn toolbar_pad_right() -> f32 {
    look::ACTION_TOOLBAR_PAD_X + 2.
}
/// Space kept between the chips and the toolbar.
const MIN_SPACER: f32 = 8.;

/// How much of the bar shows (Lua `GitFilterBarFit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fit {
    /// Characters of a chip's value.
    pub value: usize,
    /// Chips without a value shown.
    pub unset: bool,
    /// Set chips keep their name ("User: ").
    pub label: bool,
    /// The field shows its text and toggles (else just the magnifier and its ×).
    pub field: bool,
}

/// Narrower and narrower until the bar fits: shorter values, then the unset chips go, then the
/// set ones lose their name, then the field shrinks to its magnifier (Lua `FITS`).
pub const FITS: [Fit; 30] = fits();

const fn fits() -> [Fit; 30] {
    const STAGES: [(bool, bool, bool, usize); 4] = [
        (true, true, true, 12),
        (false, true, true, 8),
        (false, false, true, 4),
        (false, false, false, 4),
    ];
    const VALUES: [usize; 9] = [24, 20, 16, 14, 12, 10, 8, 6, 4];
    let mut out = [Fit {
        value: 0,
        unset: false,
        label: false,
        field: false,
    }; 30];
    let mut n = 0;
    let mut s = 0;
    while s < STAGES.len() {
        let (unset, label, field, min) = STAGES[s];
        let mut v = 0;
        while v < VALUES.len() {
            if VALUES[v] >= min {
                out[n] = Fit {
                    value: VALUES[v],
                    unset,
                    label,
                    field,
                };
                n += 1;
            }
            v += 1;
        }
        s += 1;
    }
    out
}

/// Bounds of the bar's parts from the last paint (chips, toolbar buttons): popups open under them.
type Spots = Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>;

pub struct FilterUi {
    pub search: Entity<SearchField>,
    /// The open chip popup.
    pub(super) popup: Option<OpenPopup>,
    /// Opened from the files tree / the Branches pane: the keyboard goes back there (Lua's
    /// pickers went back to the window they came from).
    return_to: Option<gpui_kit::FocusHandle>,
    /// The User popup's names (by commit count, you first), refreshed in the background.
    authors: Option<Rc<Vec<String>>>,
    /// The Paths popup's folders + files.
    paths: Option<Rc<Vec<String>>>,
    /// Loads running (dropped = cancelled).
    loads: HashMap<FilterKind, Task<()>>,
    spots: Spots,
    /// The bar's width at the last paint (0: not painted yet).
    width: Rc<Cell<f32>>,
    /// What the last render showed, as text ("Text or hash .* Cc", "Branch: HEAD ×", "User ⌄").
    shown: Vec<String>,
    /// Applied text filters, newest first (the magnifier ▾'s popup; kept in the session).
    pub(super) text_history: Vec<String>,
    _subs: Vec<Subscription>,
}

/// Text filters the history keeps (WS SearchTextField history size).
pub const TEXT_HISTORY_MAX: usize = 10;

impl FilterUi {
    pub fn new(window: &mut Window, cx: &mut Context<LogTab>) -> Self {
        // WS: the search-with-history magnifier (recent filters on its ▾)
        let search = cx.new(|cx| SearchField::new(PLACEHOLDER, cx).with_history());
        let subs = vec![cx.subscribe_in(
            &search,
            window,
            |t: &mut LogTab, _, ev: &SearchFieldEvent, w, cx| t.on_search_event(ev, w, cx),
        )];
        FilterUi {
            search,
            popup: None,
            return_to: None,
            authors: None,
            paths: None,
            loads: HashMap::new(),
            spots: Rc::default(),
            width: Rc::default(),
            shown: Vec::new(),
            text_history: Vec::new(),
            _subs: subs,
        }
    }
}

/// Width of `text` in the UI font (13 px).
pub(super) fn text_width(window: &Window, text: &str) -> f32 {
    crate::kit::width(window, text, ui_font(), px(look::UI_FONT_SIZE)).as_f32()
}

/// `s` cut to `max` characters with "…" (Lua `ui.fit`).
pub fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// "Ada Example", "Ada Example +1" (Lua `chip` list).
fn list_value(items: &[String], max: usize) -> Option<String> {
    let first = items.first()?;
    let more = if items.len() > 1 {
        format!(" +{}", items.len() - 1)
    } else {
        String::new()
    };
    Some(cut(first, max) + &more)
}

/// A chip's value at `max` characters (None: not set). Lines: Show History for Selection's.
pub fn chip_value(
    f: &LogFilters,
    kind: Option<FilterKind>,
    lines: Option<&str>,
    max: usize,
) -> Option<String> {
    match kind {
        None => {
            let l = f.lines.as_ref()?;
            let label = lines.map(str::to_owned).unwrap_or_else(|| {
                let base = l.path.rsplit('/').next().unwrap_or(&l.path);
                format!("{base}:{}-{}", l.from, l.to)
            });
            Some(cut(&label, max + 8))
        }
        // a PR's commits stand in for the branch: its chip is unset while the PR filter is (G-10)
        Some(FilterKind::Branch) => {
            (f.branch != BranchFilter::All && f.pr.is_none()).then(|| cut(f.branch.arg(), max))
        }
        Some(FilterKind::User) => list_value(&f.authors, max),
        Some(FilterKind::Date) => f.date.as_ref().map(|d| cut(&d.label(), max)),
        Some(FilterKind::Paths) => list_value(&f.paths, max),
    }
}

/// A chip's width (FilterChip: pads, "Name: ", value, gap, × / chevron).
fn chip_width(window: &Window, name: &str, value: Option<&str>, label: bool) -> f32 {
    let text = match value {
        Some(v) if label => text_width(window, &format!("{name}: ")) + text_width(window, v),
        Some(v) => text_width(window, v),
        None => text_width(window, name),
    };
    2. * look::FILTER_CHIP_PAD + text + look::FILTER_CHIP_ICON_GAP + look::ICON_SIZE
}

impl LogTab {
    // ---- the bar ---------------------------------------------------------------------------

    /// The chips shown: the four filters, Lines instead of Paths during Show History for
    /// Selection.
    fn chip_kinds(&self) -> [Option<FilterKind>; 4] {
        let last = if self.filters.lines.is_some() {
            None
        } else {
            Some(FilterKind::Paths)
        };
        [
            Some(FilterKind::Branch),
            Some(FilterKind::User),
            Some(FilterKind::Date),
            last,
        ]
    }

    /// The first [`FITS`] entry whose bar fits the width (the field keeps its text while it has
    /// the keyboard).
    fn choose_fit(&self, window: &Window, field_focused: bool) -> Fit {
        let width = self.filter_ui.width.get();
        if width <= 0. {
            return FITS[0];
        }
        // (+ the IntelliSort toggle after the chips)
        let sort = if self.shows_intellisort() {
            look::ACTION_BUTTON_SIZE + look::ACTION_BUTTON_GAP
        } else {
            0.
        };
        let toolbar = TOOLBAR_BUTTONS * look::ACTION_BUTTON_SIZE
            + (TOOLBAR_BUTTONS - 1.) * look::ACTION_BUTTON_GAP
            + toolbar_pad_right()
            + sort;
        let has_text = self.filters.text.is_some();
        let lines = self.history.label();
        let narrow = field_min_width(window);
        let mut widths: HashMap<(usize, bool, bool), f32> = HashMap::new();
        let mut last = FITS[0];
        for fit in FITS {
            if field_focused && !fit.field {
                break;
            }
            last = fit;
            let field = if fit.field {
                if fit.value >= 14 { FIELD_WIDTH } else { narrow }
            } else {
                FIELD_COMPACT
                    + if has_text {
                        look::ICON_SIZE + look::SEARCH_FIELD_TOGGLE_GAP
                    } else {
                        0.
                    }
            };
            let chips = *widths
                .entry((fit.value, fit.unset, fit.label))
                .or_insert_with(|| {
                    self.chip_kinds()
                        .into_iter()
                        .filter_map(|k| {
                            let name = k.map_or("Lines", FilterKind::name);
                            let v = chip_value(&self.filters, k, lines, fit.value);
                            (v.is_some() || fit.unset)
                                .then(|| chip_width(window, name, v.as_deref(), fit.label))
                        })
                        .sum::<f32>()
                        + {
                            // the PR chip (G26)
                            let v = self.filters.pr.as_ref().map(|p| format!("#{}", p.number));
                            if v.is_some() || fit.unset {
                                chip_width(window, "PR", v.as_deref(), fit.label)
                            } else {
                                0.
                            }
                        }
                });
            let total = look::VCS_LOG_FILTER_BAR_PAD_X
                + field
                + look::VCS_LOG_FILTER_FIELD_GAP
                + chips
                + MIN_SPACER
                + toolbar;
            if total <= width {
                return fit;
            }
        }
        last
    }

    /// The field follows the applied filter while it doesn't have the keyboard (Esc / a click
    /// elsewhere leave the applied text), its toggles always.
    fn sync_search(&mut self, focused: bool, fit: Fit, cx: &mut Context<Self>) {
        let want = self.filters.text.clone().unwrap_or_default();
        let (regex, case, clear) = (
            self.filters.regex,
            self.filters.match_case,
            self.filters.text.is_some(),
        );
        self.filter_ui.search.update(cx, |s, cx| {
            if !focused && s.text(cx) != want {
                s.set_text(want, cx);
            }
            if s.regex() != regex {
                s.set_regex(regex, cx);
            }
            if s.match_case() != case {
                s.set_match_case(case, cx);
            }
            s.set_clear(clear, cx);
            s.set_compact(!fit.field, cx);
        });
    }

    pub(super) fn render_filter_bar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let field_focused = self
            .filter_ui
            .search
            .focus_handle(cx)
            .contains_focused(window, cx);
        let fit = self.choose_fit(window, field_focused);
        self.sync_search(field_focused, fit, cx);
        let this = cx.entity().downgrade();

        let field_w = if !fit.field {
            FIELD_COMPACT
                + if self.filters.text.is_some() {
                    look::ICON_SIZE + look::SEARCH_FIELD_TOGGLE_GAP
                } else {
                    0.
                }
        } else if fit.value >= 14 {
            FIELD_WIDTH
        } else {
            field_min_width(window)
        };
        let field = div()
            .id("git-log-text-filter")
            .flex_none()
            .w(px(field_w))
            .child(spot(&self.filter_ui.spots, "field"))
            .on_key_down(cx.listener(Self::on_field_key))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|t, ev: &MouseDownEvent, w, cx| {
                    t.text_filter_menu(Anchor::Point(ev.position), w, cx)
                }),
            )
            .child(self.filter_ui.search.clone());

        let open_kind = self.filter_ui.popup.as_ref().map(|p| p.kind);
        let lines = self.history.label().map(str::to_owned);
        let mut shown = vec![{
            let text = self.filter_ui.search.read(cx).text(cx);
            let mut s = if !fit.field {
                "⌕".to_owned()
            } else if text.is_empty() {
                PLACEHOLDER.to_owned()
            } else {
                text.to_owned()
            };
            if self.filters.text.is_some() {
                s.push_str(" ×");
            }
            if fit.field {
                s.push_str(" .* Cc");
            }
            s
        }];
        let mut chips = self
            .chip_kinds()
            .into_iter()
            .filter_map(|kind| {
                let value = chip_value(&self.filters, kind, lines.as_deref(), fit.value);
                if value.is_none() && !fit.unset {
                    return None;
                }
                let name = kind.map_or("Lines", FilterKind::name);
                shown.push(match &value {
                    Some(v) if fit.label => format!("{name}: {v} ×"),
                    Some(v) => format!("{v} ×"),
                    None => format!("{name} ⌄"),
                });
                Some(self.render_chip(kind, value, fit.label, open_kind, &this, cx))
            })
            .collect::<Vec<_>>();
        // PR review's chip after Branch (G26): set while a PR is under review, else its pick
        let pr = self.pr_number(cx);
        if pr.is_some() || fit.unset {
            shown.insert(
                2.min(shown.len()),
                match pr {
                    Some(n) if fit.label => format!("PR: #{n} ×"),
                    Some(n) => format!("#{n} ×"),
                    None => "PR ⌄".to_owned(),
                },
            );
            let chip = self.render_pr_chip(fit.label, cx);
            chips.insert(1.min(chips.len()), chip);
        }

        self.filter_ui.shown = shown;
        let width = self.filter_ui.width.clone();
        let w2 = this.clone();
        let measure = canvas(
            move |b, _, cx| {
                let now = b.size.width.as_f32();
                if (now - width.get()).abs() > 0.5 {
                    width.set(now);
                    // the fit follows the new width (next frame)
                    let _ = w2.update(cx, |_, cx| cx.notify());
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        let popup = self.filter_ui.popup.as_ref().map(|p| {
            let weak = this.clone();
            let cancel: Done = Rc::new(move |_, w, cx| {
                let _ = weak.update(cx, |t, cx| t.close_filter_popup(w, cx));
            });
            p.render(cancel, cx)
        });

        div()
            .id("git-log-filter-bar")
            .debug_selector(|| "git-log-filter-bar".into())
            .relative()
            .flex_none()
            .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
            .w_full()
            .min_w(px(0.))
            .overflow_hidden()
            .flex()
            .items_center()
            .pl(px(look::VCS_LOG_FILTER_BAR_PAD_X))
            .child(measure)
            .child(field)
            .child(div().flex_none().w(px(look::VCS_LOG_FILTER_FIELD_GAP)))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(look::FILTER_CHIP_GAP))
                    .children(chips),
            )
            // WS's IntelliSort toggle right of the chips (30.png x 803-825)
            .when(self.shows_intellisort(), |d| {
                d.child(
                    div()
                        .flex_none()
                        .ml(px(look::ACTION_BUTTON_GAP))
                        .child(self.render_intellisort(&this)),
                )
            })
            .child(div().flex_1().min_w(px(0.)))
            .child(self.render_toolbar(&this))
            .children(popup)
            .into_any_element()
    }

    fn render_chip(
        &self,
        kind: Option<FilterKind>,
        value: Option<String>,
        label: bool,
        open_kind: Option<FilterKind>,
        this: &WeakEntity<Self>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (id, name, spot_key) = match kind {
            Some(k) => (k.id(), k.name(), k.spot()),
            None => ("lines", "Lines", "chip-lines"),
        };
        let set = value.is_some();
        let mut chip = FilterChip::new(id, name)
            .value(value)
            .show_name(label)
            .open(kind.is_some() && open_kind == kind);
        if let Some(k) = kind {
            let weak = this.clone();
            chip = chip.on_open(move |bounds, w, cx| {
                let _ = weak.update(cx, |t, cx| t.open_filter(k, Some(bounds), w, cx));
            });
        }
        let weak = this.clone();
        chip = chip.on_clear(move |w, cx| {
            let _ = weak.update(cx, |t, cx| t.clear_filter(kind, w, cx));
        });
        div()
            .relative()
            .flex_none()
            .child(spot(&self.filter_ui.spots, spot_key))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |t, ev: &MouseDownEvent, w, cx| {
                    t.chip_menu(kind, set, Anchor::Point(ev.position), w, cx)
                }),
            )
            .child(chip)
            .into_any_element()
    }

    /// Not for Show History for Selection (a list of the lines' commits, no graph to sort).
    fn shows_intellisort(&self) -> bool {
        self.filters.lines.is_none()
    }

    fn render_intellisort(&self, this: &WeakEntity<Self>) -> IconButton {
        let w = this.clone();
        IconButton::new("log-intellisort", IconName::IntelliSort)
            .tooltip("IntelliSort", None)
            .toggled(self.intellisort)
            .on_click(move |_, _, cx| {
                let _ = w.update(cx, |t, cx| t.toggle_intellisort(cx));
            })
    }

    /// IntelliSort on / off: the log reloads in the other order.
    pub fn toggle_intellisort(&mut self, cx: &mut Context<Self>) {
        self.intellisort = !self.intellisort;
        self.reload(Reload::Refresh, cx);
        self.save_state(cx);
    }

    fn render_toolbar(&self, this: &WeakEntity<Self>) -> AnyElement {
        let spots = &self.filter_ui.spots;
        let no_commit = self.model.current().is_none() && !self.model.has_selection();
        let w = this.clone();
        let refresh = IconButton::new("log-refresh", IconName::Refresh)
            .tooltip("Refresh", Some("R"))
            .on_click(move |_, _, cx| {
                let _ = w.update(cx, |t, cx| t.refresh_now(cx));
            });
        let w = this.clone();
        let pick = IconButton::new("log-cherry-pick", IconName::CherryPick)
            .tooltip("Cherry-Pick", None)
            .disabled(no_commit)
            .on_click(move |_, win, cx| {
                let _ = w.update(cx, |t, cx| t.cherry_pick_selected(win, cx));
            });
        let w = this.clone();
        let s = spots.clone();
        let view = IconButton::new("log-view-options", IconName::Show)
            .tooltip("View Options", None)
            .dropdown(true)
            .on_click(move |ev, win, cx| {
                let anchor = below(&s, "log-view-options", ev.position());
                let _ = w.update(cx, |t, cx| t.view_options_menu(anchor, win, cx));
            });
        let w = this.clone();
        let s = spots.clone();
        let go = IconButton::new("log-go-to", IconName::Search)
            .tooltip("Go to Hash/Branch/Tag", None)
            .on_click(move |ev, win, cx| {
                let anchor = below(&s, "log-go-to", ev.position());
                let _ = w.update(cx, |t, cx| t.go_to_ref_popup(anchor, win, cx));
            });
        toolbar(Axis::Horizontal)
            .pr(px(toolbar_pad_right()))
            .child(refresh)
            .child(pick)
            .child(
                div()
                    .relative()
                    .child(spot(spots, "log-view-options"))
                    .child(view),
            )
            .child(div().relative().child(spot(spots, "log-go-to")).child(go))
            .into_any_element()
    }

    // ---- text field ------------------------------------------------------------------------

    /// `/`: the text field takes the keyboard with its text selected.
    pub fn focus_text_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_popup_quietly(cx);
        let text = self.filters.text.clone().unwrap_or_default();
        self.filter_ui.search.update(cx, |s, cx| {
            s.set_text(text, cx);
            s.field().update(cx, |f, cx| f.select_all(cx));
            s.focus(window, cx);
        });
        cx.notify();
    }

    /// Keys in the text field (before they bubble to the tool window): Enter applies, Esc
    /// keeps the applied text; both give the keyboard back to the table.
    fn on_field_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = kit::notation(ev) else {
            return;
        };
        match key.as_str() {
            "<CR>" => {
                let text = self.filter_ui.search.read(cx).text(cx).trim().to_owned();
                self.apply_text_filter(text, cx);
                self.leave_field(window, cx);
            }
            "<Esc>" => self.leave_field(window, cx),
            // the tool window would take it as its leader key: typed here
            "," => {
                self.filter_ui.search.update(cx, |s, cx| {
                    s.field().update(cx, |f, cx| f.insert(",", cx));
                });
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    /// Applies a text filter (empty: none) and remembers it in the history.
    fn apply_text_filter(&mut self, text: String, cx: &mut Context<Self>) {
        if !text.is_empty() {
            let h = &mut self.filter_ui.text_history;
            h.retain(|t| *t != text);
            h.insert(0, text.clone());
            h.truncate(TEXT_HISTORY_MAX);
        }
        let before = self.filters.clone();
        self.update_filters(|f| f.text = (!text.is_empty()).then_some(text), cx);
        if self.filters == before {
            // same filter, the history may have changed
            self.save_state(cx);
        }
    }

    /// The magnifier's ▾: the recent text filters; picking one applies it.
    fn text_history_menu(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let history = self.filter_ui.text_history.clone();
        let entries: Vec<MenuEntry> = if history.is_empty() {
            vec![MenuEntry::Info("No recent searches".into())]
        } else {
            history
                .iter()
                .map(|t| MenuItem::new(t.clone()).into())
                .collect()
        };
        let this = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, Anchor::Below(bounds)).title("Recent Searches"),
            window,
            cx,
            move |choice, w, cx| {
                let Some(text) = choice.and_then(|i| history.get(i).cloned()) else {
                    return;
                };
                let _ = this.update(cx, |t, cx| {
                    t.apply_text_filter(text, cx);
                    t.leave_field(w, cx);
                });
            },
        );
    }

    fn leave_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.filters.text.clone().unwrap_or_default();
        self.filter_ui
            .search
            .update(cx, |s, cx| s.set_text(text, cx));
        self.focus_table(window, cx);
        cx.notify();
    }

    fn on_search_event(
        &mut self,
        ev: &SearchFieldEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            SearchFieldEvent::OptionsChanged => {
                let s = self.filter_ui.search.read(cx);
                let (regex, case) = (s.regex(), s.match_case());
                self.toggle_search_options(regex, case, cx);
            }
            SearchFieldEvent::Clear => {
                self.update_filters(|f| f.text = None, cx);
                let focused = self
                    .filter_ui
                    .search
                    .focus_handle(cx)
                    .contains_focused(window, cx);
                if focused {
                    self.filter_ui.search.update(cx, |s, cx| s.set_text("", cx));
                }
            }
            SearchFieldEvent::History(bounds) => self.text_history_menu(*bounds, window, cx),
            SearchFieldEvent::Changed => {}
        }
    }

    /// `.*` / `Cc`: the log reloads only when a text filter is applied; else just the flags
    /// change (and the session keeps them), as Lua's `toggle_search_option`.
    fn toggle_search_options(&mut self, regex: bool, case: bool, cx: &mut Context<Self>) {
        if self.filters.text.is_some() {
            self.update_filters(
                |f| {
                    f.regex = regex;
                    f.match_case = case;
                },
                cx,
            );
        } else if self.filters.regex != regex || self.filters.match_case != case {
            self.filters.regex = regex;
            self.filters.match_case = case;
            self.save_state(cx);
            cx.notify();
        }
    }

    /// Right-click on the text field.
    fn text_filter_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let check = |on: bool, label: &str| {
            let item = MenuItem::new(label.to_owned());
            if on {
                item.icon(IconName::Checked)
            } else {
                item
            }
        };
        let entries: Vec<MenuEntry> = vec![
            MenuItem::new("Filter by Text or Hash…")
                .shortcut("/")
                .into(),
            MenuItem::new("Clear Filter")
                .enabled(self.filters.text.is_some())
                .into(),
            MenuEntry::Separator,
            check(self.filters.regex, "Regex").shortcut("⌥X").into(),
            check(self.filters.match_case, "Match Case")
                .shortcut("⌥C")
                .into(),
        ];
        let this = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, w, cx| {
                let _ = this.update(cx, |t, cx| match choice {
                    Some(0) => t.focus_text_filter(w, cx),
                    Some(1) => t.update_filters(|f| f.text = None, cx),
                    Some(3) => t.toggle_search_options(!t.filters.regex, t.filters.match_case, cx),
                    Some(4) => t.toggle_search_options(t.filters.regex, !t.filters.match_case, cx),
                    _ => {}
                });
            },
        );
    }

    // ---- chips -----------------------------------------------------------------------------

    /// A chip's ×, the menu's Clear Filter: just that filter goes (Lines: the history closes).
    fn clear_filter(
        &mut self,
        kind: Option<FilterKind>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            None => self.close_selection_history(window, cx),
            Some(FilterKind::Branch) => self.update_filters(|f| f.branch = BranchFilter::All, cx),
            Some(FilterKind::User) => self.update_filters(|f| f.authors.clear(), cx),
            Some(FilterKind::Date) => self.update_filters(|f| f.date = None, cx),
            Some(FilterKind::Paths) => self.update_filters(
                |f| {
                    f.paths.clear();
                    f.follow = false;
                },
                cx,
            ),
        }
    }

    /// Right-click on a chip: "Filter by <X>…" (its key), "Clear Filter" (when set).
    fn chip_menu(
        &mut self,
        kind: Option<FilterKind>,
        set: bool,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut entries: Vec<MenuEntry> = Vec::new();
        if let Some(k) = kind {
            entries.push(
                MenuItem::new(format!("Filter by {}…", k.name()))
                    .shortcut(k.key())
                    .into(),
            );
        }
        entries.push(MenuItem::new("Clear Filter").enabled(set).into());
        let has_open = kind.is_some();
        let this = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, w, cx| {
                let _ = this.update(cx, |t, cx| match (choice, kind) {
                    (Some(0), Some(k)) if has_open => t.open_filter(k, None, w, cx),
                    (Some(_), _) => t.clear_filter(kind, w, cx),
                    _ => {}
                });
            },
        );
    }

    // ---- popups ----------------------------------------------------------------------------

    /// The open filter popup (tests).
    pub fn filter_popup(&self) -> Option<&OpenPopup> {
        self.filter_ui.popup.as_ref()
    }

    /// The filter bar as the last frame drew it: the field, then the chips ("Branch: HEAD ×",
    /// "User ⌄"; tests).
    pub fn filter_bar_text(&self) -> &[String] {
        &self.filter_ui.shown
    }

    /// The "Text or hash" field.
    pub fn text_field(&self) -> &Entity<SearchField> {
        &self.filter_ui.search
    }

    /// b / u / d / p, a chip click (`anchor`: the chip's bounds): the filter's popup.
    pub fn open_filter(
        &mut self,
        kind: FilterKind,
        anchor: Option<Bounds<Pixels>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Show History for Selection: the Lines chip stands where Paths was
        if kind == FilterKind::Paths && self.filters.lines.is_some() {
            return;
        }
        let anchor = match anchor.or_else(|| self.spot(kind.spot())) {
            Some(b) => Anchor::Below(b),
            None => match self.spot("field") {
                Some(b) => Anchor::Below(b),
                None => self.cursor_anchor(window),
            },
        };
        let choices = self.choices(kind);
        let loading = choices.loading;
        self.filter_ui.return_to = (self.details.read(cx).is_focused(window, cx)
            || self.branches_focused(window, cx))
        .then(|| window.focused(cx))
        .flatten();
        let this = cx.entity().downgrade();
        let done: Done = Rc::new(move |choice, w, cx| {
            let _ = this.update(cx, |t, cx| t.filter_popup_done(kind, choice, w, cx));
        });
        self.filter_ui.popup = Some(OpenPopup::new(
            kind,
            kind.title(),
            choices,
            anchor,
            done,
            window,
            cx,
        ));
        // missing choices load now; cached ones refresh for the next time (new commits)
        if loading || matches!(kind, FilterKind::User | FilterKind::Paths) {
            self.load_choices(kind, window, cx);
        }
        cx.notify();
    }

    fn spot(&self, key: &str) -> Option<Bounds<Pixels>> {
        self.filter_ui
            .spots
            .borrow()
            .get(key)
            .copied()
            .filter(|b| b.size.width > px(0.))
    }

    /// What a popup lists now (None: still to load).
    fn choices(&self, kind: FilterKind) -> Choices {
        let f = &self.filters;
        let (items, current, loading) = match kind {
            FilterKind::Branch => {
                let current = match &f.branch {
                    BranchFilter::All => ALL.to_owned(),
                    b => b.arg().to_owned(),
                };
                match &self.branches.refs {
                    Some(r) => (branch_items(r), Some(current), false),
                    None => (vec!["HEAD".to_owned()], Some(current), true),
                }
            }
            FilterKind::User => match &self.filter_ui.authors {
                Some(a) => (a.to_vec(), f.authors.first().cloned(), false),
                None => (Vec::new(), f.authors.first().cloned(), true),
            },
            FilterKind::Date => {
                let mut items: Vec<String> =
                    DateFilter::PRESETS.iter().map(DateFilter::label).collect();
                items.push(DATE_SELECT.to_owned());
                let current = f.date.as_ref().map(|d| match d {
                    DateFilter::Range { .. } => DATE_SELECT.to_owned(),
                    d => d.label(),
                });
                (items, current, false)
            }
            FilterKind::Paths => match &self.filter_ui.paths {
                Some(p) => (p.to_vec(), f.paths.first().cloned(), false),
                None => (Vec::new(), f.paths.first().cloned(), true),
            },
        };
        Choices {
            items,
            current,
            loading,
        }
    }

    /// Loads a popup's choices off the UI thread; an open popup of that kind gets them.
    fn load_choices(&mut self, kind: FilterKind, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.gcx.root() else {
            return;
        };
        if self.filter_ui.loads.contains_key(&kind) {
            return;
        }
        enum Loaded {
            Refs(FilterRefs),
            Authors(Vec<String>),
            Paths(Vec<String>),
        }
        let job = crate::git::job::spawn(cx, move || match kind {
            FilterKind::Branch => {
                crate::git::branches::filter_refs_blocking(&root).map(Loaded::Refs)
            }
            FilterKind::User => crate::git::log::authors_blocking(&root).map(Loaded::Authors),
            FilterKind::Paths => crate::git::log::path_choices_blocking(&root).map(Loaded::Paths),
            FilterKind::Date => Ok(Loaded::Paths(Vec::new())),
        });
        let task = cx.spawn_in(window, async move |this, cx| {
            let loaded = job.await;
            let _ = this.update_in(cx, |t, window, cx| {
                t.filter_ui.loads.remove(&kind);
                match loaded {
                    Ok(Loaded::Refs(r)) => t.branches.refs = Some(Rc::new(r)),
                    Ok(Loaded::Authors(a)) => t.filter_ui.authors = Some(Rc::new(a)),
                    Ok(Loaded::Paths(p)) if kind == FilterKind::Paths => {
                        t.filter_ui.paths = Some(Rc::new(p))
                    }
                    Ok(Loaded::Paths(_)) => {}
                    // git failed: the popup stays with "All" (nothing better to show)
                    Err(_) => {}
                }
                let choices = t.choices(kind);
                if let Some(p) = t.filter_ui.popup.as_mut().filter(|p| p.kind == kind)
                    && p.loading(cx)
                {
                    p.set_items(choices.items, choices.current.as_deref(), window, cx);
                }
                cx.notify();
            });
        });
        self.filter_ui.loads.insert(kind, task);
    }

    /// Esc / a click outside the popup: nothing changes, the keyboard back to the table.
    fn close_filter_popup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.filter_ui.popup.take().is_some() {
            match self.filter_ui.return_to.take() {
                Some(h) => window.focus(&h, cx),
                None => self.focus_table(window, cx),
            }
            cx.notify();
        }
    }

    /// Another surface takes over (`/`): the popup goes without moving the keyboard.
    fn close_popup_quietly(&mut self, cx: &mut Context<Self>) {
        if self.filter_ui.popup.take().is_some() {
            cx.notify();
        }
    }

    /// The popup answered: the filter changes (Lua's pickers' `on_done`), the keyboard is back
    /// in the table.
    fn filter_popup_done(
        &mut self,
        kind: FilterKind,
        choice: Option<Vec<String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.filter_ui.popup.as_ref().is_none_or(|p| p.kind != kind) {
            return;
        }
        self.close_filter_popup(window, cx);
        let Some(sel) = choice else {
            return;
        };
        let all = sel.iter().any(|s| s == ALL);
        match kind {
            FilterKind::Branch => {
                let b = match sel[0].as_str() {
                    ALL => BranchFilter::All,
                    "HEAD" => BranchFilter::Head,
                    r => BranchFilter::Ref(r.to_owned()),
                };
                self.update_filters(|f| f.branch = b, cx);
            }
            FilterKind::User => {
                let authors = if all { Vec::new() } else { sel };
                self.update_filters(|f| f.authors = authors, cx);
            }
            FilterKind::Date => {
                if sel[0] == DATE_SELECT {
                    self.date_range_input(window, cx);
                    return;
                }
                let date = DateFilter::PRESETS
                    .into_iter()
                    .find(|d| d.label() == sel[0]);
                self.update_filters(|f| f.date = date, cx);
            }
            FilterKind::Paths => {
                let paths = if all { Vec::new() } else { sel };
                self.update_filters(
                    |f| {
                        f.paths = paths;
                        f.follow = false;
                    },
                    cx,
                );
            }
        }
    }

    /// Date > Select…: since, then until (git date strings; empty: open-ended).
    fn date_range_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let anchor = match self.spot(FilterKind::Date.spot()) {
            Some(b) => Anchor::Below(b),
            None => self.cursor_anchor(window),
        };
        let (since0, until0) = match &self.filters.date {
            Some(DateFilter::Range { since, until }) => (
                since.clone().unwrap_or_default(),
                until.clone().unwrap_or_default(),
            ),
            _ => (String::new(), String::new()),
        };
        let this = cx.entity().downgrade();
        let input = Input::new(
            "Since (2026-01-31, 2 weeks ago; empty: any)",
            since0,
            anchor,
        );
        popups::open_input(input, window, cx, move |since, w, cx| {
            let Some(since) = since else {
                return;
            };
            let input = Input::new("Until (empty: now)", until0, anchor);
            popups::open_input(input, w, cx, move |until, _, cx| {
                let Some(until) = until else {
                    return;
                };
                let some = |s: String| {
                    let s = s.trim().to_owned();
                    (!s.is_empty()).then_some(s)
                };
                let (since, until) = (some(since), some(until));
                let date = (since.is_some() || until.is_some())
                    .then_some(DateFilter::Range { since, until });
                let _ = this.update(cx, |t, cx| t.update_filters(|f| f.date = date, cx));
            });
        });
    }

    // ---- toolbar ---------------------------------------------------------------------------

    /// The eye: View Options (Show Long Edges, Show Changed Files and Details).
    fn view_options_menu(&mut self, anchor: Anchor, window: &mut Window, cx: &mut Context<Self>) {
        let check = |on: bool, label: &'static str| {
            let item = MenuItem::new(label);
            if on {
                item.icon(IconName::Checked)
            } else {
                item
            }
        };
        let entries: Vec<MenuEntry> = vec![
            check(self.graph_opts.show_long_edges, "Show Long Edges").into(),
            check(self.details_shown, "Show Changed Files and Details").into(),
        ];
        let this = cx.entity().downgrade();
        popups::open_menu(
            Menu::new(entries, anchor),
            window,
            cx,
            move |choice, _, cx| {
                let _ = this.update(cx, |t, cx| match choice {
                    Some(0) => {
                        t.graph_opts.show_long_edges = !t.graph_opts.show_long_edges;
                        t.reload(Reload::Refresh, cx);
                    }
                    Some(1) => {
                        t.details_shown = !t.details_shown;
                        cx.notify();
                    }
                    _ => {}
                });
            },
        );
    }
}

/// The Branch popup after "All": HEAD, local, remote branches, tags.
fn branch_items(r: &FilterRefs) -> Vec<String> {
    std::iter::once("HEAD".to_owned()).chain(r.list()).collect()
}

/// Records an element's bounds (an absolute canvas over its parent) under `key`.
fn spot(spots: &Spots, key: &'static str) -> impl IntoElement {
    let spots = spots.clone();
    canvas(
        move |b, _, _| {
            spots.borrow_mut().insert(key, b);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_full()
}

/// Below a toolbar button (its painted bounds), else at the click.
fn below(spots: &Spots, key: &str, at: gpui_kit::Point<Pixels>) -> Anchor {
    match spots.borrow().get(key) {
        Some(b) => Anchor::Below(*b),
        None => Anchor::Point(at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::log::LineRange;

    #[test]
    fn chip_values_like_luas() {
        let f = LogFilters {
            authors: vec!["Ada Example".into(), "Max".into()],
            date: Some(DateFilter::Last7Days),
            paths: vec!["backend/scripts/".into()],
            ..Default::default()
        };
        let v = |k| chip_value(&f, Some(k), None, 24);
        assert_eq!(v(FilterKind::Branch).as_deref(), Some("HEAD"));
        assert_eq!(v(FilterKind::User).as_deref(), Some("Ada Example +1"));
        assert_eq!(v(FilterKind::Date).as_deref(), Some("Last 7 Days"));
        assert_eq!(v(FilterKind::Paths).as_deref(), Some("backend/scripts/"));
        assert_eq!(
            chip_value(&f, Some(FilterKind::Paths), None, 8).as_deref(),
            Some("backend…")
        );
        let all = LogFilters {
            branch: BranchFilter::All,
            ..Default::default()
        };
        assert_eq!(chip_value(&all, Some(FilterKind::Branch), None, 24), None);
        assert_eq!(chip_value(&all, Some(FilterKind::User), None, 24), None);
        let lines = LogFilters {
            lines: Some(LineRange {
                path: "src/blame.ts".into(),
                from: 3,
                to: 4,
            }),
            ..Default::default()
        };
        assert_eq!(
            chip_value(&lines, None, None, 24).as_deref(),
            Some("blame.ts:3-4")
        );
        assert_eq!(
            chip_value(&lines, None, Some("blame.ts:2-3"), 24).as_deref(),
            Some("blame.ts:2-3")
        );
    }

    #[test]
    fn cut_keeps_short_text() {
        assert_eq!(cut("abc", 3), "abc");
        assert_eq!(cut("abcd", 3), "ab…");
        assert_eq!(cut("åäöü", 3), "åä…");
    }
}
