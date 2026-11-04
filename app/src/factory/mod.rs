//! The Factory view: Abe 2.0's screens, drawn from TypeScript (ADR 0013 T3). Rust
//! only draws, spawns and forwards; every decision is the bridge's.
//!
//! The shell bridge contract:
//! - The process: `abe ui bridge` (`$ABE_BIN`, else the `abe` beside this executable;
//!   [`BridgeCommand`]), started when the view is first shown, restarted once if it dies.
//! - Its stdio: newline-delimited JSON frames, `v` 1 ([`protocol`]). App → bridge: `hello`
//!   {size, version}, `open` {screen, params}, `input` {key in nvim notation | click on a node id
//!   | text: a ⌘V paste}, `resize`. Bridge → app: `tree` {screen, rev, tree} (drawn when its rev
//!   is newer; the bridge may open another screen itself), `layer` {rev, tree | null} (the top
//!   layer, [`layers`], drawn over whichever view is shown), `shell` {view | open-project |
//!   balloon | widgets | status | cmdline | …} (run by [`crate::shell::effects`]; the status bar
//!   reads them), `error` (logged once).
//! - The tree: the closed component set of `abe/packages/ui/src/runtime/components.ts`, `{kind, id?,
//!   props, children?}`; the JSON schema and one fixture per screen state are
//!   `abe/packages/ui/contract/` (written by `bun run contract`), which `tests/contract.rs` reads.
//!   A kind this build doesn't know draws a dim `needs component: <kind>` box, logged once.
//! - Terminals (Chat, [`terminal`]): a `Terminal` node's argv runs in a PTY kept per key
//!   (10 minutes after the last tree that held it, or until `drop-terminal`); its keys go to the
//!   program but its `screenKeys` and ⌘ keys, its exit goes back as an `exit` frame. The tree's
//!   `focused` terminal gets the keyboard while the view has it and no layer is up.
//! - The shown project's folder ([`FactoryView::set_root`], from `Projects`): `hello`'s `root`,
//!   then a `project` frame when another project is shown; the bridge runs commands there.
//!   The card dialog (`CardDialog`, [`dialog`]) is a layer too, centred in the view; `open-url`
//!   opens a card in the browser.
//! - The popup slot (a Board card's Card page, [`dialog::card_popup`]): its tree drawn over the
//!   main one, centred, the Board dimmed; main's keys and clicks reach it through the bridge.
//!   `closed` takes it away; the view leaving the Board sends `close` ([`FactoryView::close_popup`]).
//! - The Launch box ([`launch`]): a layer as the CommentBox, its ⏎ handed back to the screen.
//! - The CommentBox ([`comment`]): a card's Comment…, a layer like the card dialog.
//! - Settings ([`settings`]): ⌘, ([`FactoryView::open_settings`]) sends `open settings`;
//!   the bridge answers with its Settings layer, drawn 1040 × 700 over the whole window and
//!   modal (no `blur` on a focus change). With no bridge the contract's serve-down tree is drawn
//!   and keyed here (Esc closes, Retry starts the bridge); a restarted bridge gets the open again.
//! - Adding a component: its kind in `components.ts` (zod schema + type), `bun run contract`,
//!   then a [`protocol::Node`] variant and a draw function in [`draw`], and a fixture test.
//!
//! ⌘⌥A toggles the Editor and this view (`Projects`); while it has the keyboard every key goes
//! to the bridge except the window's own (⌘⌥A, Cmd+<, Cmd+Q …, taken by `Projects` first).
//! The bridge starts at launch (`Projects::follow_factory`), so its widgets (`Factory ◆ N`)
//! show on the Editor; widgets are drawn by `view` and `place`, a click is `widget:<id>`.
//! Shown from the Editor, the screen is opened again with `from: editor`
//! ([`FactoryView::shown_from_editor`]) and lands where TypeScript says.
//!
//! Command mode: `:` in this view, and the Editor's `:` once an `abe` 2.0 is there
//! ([`BridgeCommand::available`]; else a line naming `./install.sh`), goes to the bridge, which answers with a
//! `layer`. Over the Editor the view is placed but draws only that layer, and has the keyboard
//! until the layer closes; `cmdline` (`::`) is Neovim's own command line.

mod anchor;
mod board;
mod bridge;
mod browser;
mod cards;
mod chat;
mod chat_target;
mod comment;
mod composer;
mod dialog;
mod diff_card;
mod draw;
mod feel;
mod field;
mod glide;
mod install;
mod launch;
mod layers;
mod linked;
mod local;
mod memory;
/// The BrowserView's pages (Sheet pages): a native web page over a slot, reaching only its
/// own URL.
pub mod pages;
mod pipelines;
mod protocol;
mod prototype;
mod review;
mod run;
mod select;
mod settings;
mod slot;
mod status;
mod story;
mod table;
mod terminal;
mod transcript;
mod workspaces;

pub use board::Segment;
pub use bridge::BridgeCommand;
pub use chat::{BoxState, cloud_svg};
pub use chat_target::ChatTarget;
pub use dialog::extent_lines;
pub use draw::{Drawn, hue};
pub use feel::{AutoSave, Decorations, Feel, FeelName, KeyBind, vscode};
pub(crate) use feel::{ChatFeel, TabsFeel, TreeFeel, stock_keys};
pub use glide::enable as enable_glides;
pub use layers::{TOP as LAYER_TOP, WIDTH as LAYER_WIDTH};
pub(crate) use pipelines::steps_back;
pub(crate) use protocol::{
    AppAction, EditorHere, JumpFrom, JumpPlace, JumpTo, ShowPlace, log_once,
};
pub use protocol::{
    AppFrame, BridgeFrame, Caret, Chip, CloudState, Hue, KINDS, Lines, Node, PrototypeLook,
    PrototypeState, ShellEffect, Slot, StripeDot, StripeDotOf, StripeGear, StripeGroup, StripeItem,
    Tone, UserInput, VERSION, ViewName, Widget, WidgetPlace, WorkspaceLook, WorkspaceState,
    read_line,
};
/// A slot's tree as a keyed patch of the one before, and how it is applied.
pub use protocol::{Op, Patch, Patchable, Said, apply, read_said};
pub use review::{
    Badge, Hue as ReviewHue, PaneLine, PickRow, Saved, Scope, Side, Thread, Tone as ReviewTone,
    Verdict,
};
pub(crate) use review::{
    ConversationItem, DiffFile, DiffPr, Drafted, Lifecycle, NodeKind, ReviewAsk, ReviewPaneProps,
    Strip,
};
pub use slot::SlotView;
pub use table::filtering;
pub use workspaces::{
    ContextLine, RepoNames, ShownWorkspaces, TabParts, WorkspaceFeed, badge, cloud, context_line,
};
pub(crate) use workspaces::{
    Resolver, cloud_color, feed_state_of, look_of, story_of_branch, tab_rail,
};

use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, Global,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, Window, div, prelude::FluentBuilder as _,
    px,
};

use bridge::{BridgeEvent, Heard, Landing};
use chat_target::{ChatAt, Modes, Selected};
use protocol::ViewSize;

use crate::look;

/// How long `:` waits for the bridge's layer before the keyboard goes back.
const AWAIT_LAYER: std::time::Duration = std::time::Duration::from_secs(3);

/// The first screen the view opens: the Factory overview.
pub const FIRST_SCREEN: &str = "factory";

/// The Run place's screen: a card's run in the main slot.
pub const RUN_SCREEN: &str = "run";

/// The Card page's screen: the story as a page in the main slot (a workspace's ⌃3), or in the
/// popup slot over the Board (⏎ on a card).
pub const CARD_SCREEN: &str = "card";

/// The Chat slot's screen: Chat pinned to the shown workspace.
pub const CHAT_SCREEN: &str = "chat";

/// What the status bar shows of the Factory: whether it is the shown view (`ABE · BOARD`) and
/// the bridge's widgets (shown on both views).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FactoryShell {
    pub shown: bool,
    pub widgets: Vec<Widget>,
    /// A command's one line (Command mode's `status`), on the status line of both views.
    pub status: Option<String>,
    /// The Settings dialog is up: modal over every view, the pane's own dialogs wait.
    pub settings: bool,
    /// The stripe's items (`stripe`), the whole set in order.
    pub stripe: Vec<StripeItem>,
    /// Settings' gear on the toolbar (`stripe`'s).
    pub gear: StripeGear,
    /// The dots other screens sent (`stripe-dot`: Pipelines'), by item id.
    pub stripe_dots: Vec<StripeDotOf>,
}

/// Whether the Settings dialog is up over the window.
pub fn settings_up(cx: &App) -> bool {
    cx.try_global::<FactoryShell>().is_some_and(|s| s.settings)
}

impl Global for FactoryShell {}

/// Set by the app's `main` (never by tests): the projects window starts the bridge at launch, so
/// the Editor's `Factory ◆ N` follows `abe watch` before the view was ever shown.
pub struct FollowAtLaunch;

impl Global for FollowAtLaunch {}

/// The bridge's widgets for the shown view (the Editor, or the Factory view) at `place`.
pub fn shown_widgets(cx: &App, place: WidgetPlace) -> Vec<Widget> {
    let Some(shell) = cx.try_global::<FactoryShell>() else {
        return Vec::new();
    };
    let view = if shell.shown {
        ViewName::Factory
    } else {
        ViewName::Editor
    };
    shell
        .widgets
        .iter()
        .filter(|w| w.place == place && w.view.is_none_or(|v| v == view))
        .cloned()
        .collect()
}

/// The bridge's widgets as the status bar draws them at `place` (beside the mode badge, or at
/// its right end); a click is the bridge's `click` on `widget:<id>`, the keyboard staying put.
pub fn status_widgets(cx: &App, place: WidgetPlace) -> Vec<AnyElement> {
    use gpui_kit::{
        CursorStyle, MouseButton, StatefulInteractiveElement as _, prelude::FluentBuilder as _,
    };
    shown_widgets(cx, place)
        .into_iter()
        .map(|w| {
            let id = w.id.clone();
            let click = format!("widget:{}", w.id);
            let el = div()
                .id(SharedString::from(format!("factory-widget-{id}")))
                .debug_selector(move || format!("factory-widget-{id}"))
                .flex_none()
                .h_full()
                .px(px(look::STATUS_BAR_WIDGET_PAD_X))
                .flex()
                .items_center()
                .cursor(CursorStyle::PointingHand)
                .hover(|s| s.bg(look::STATUS_BAR_HOVER_BG))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    crate::shell::projects::factory_click(click.clone(), window, cx);
                })
                .text_color(w.hue.map_or(look::STATUS_BAR_TEXT.rgba(), draw::hue))
                .when_some(w.cloud, |d, c| {
                    let color = match (w.hue, c) {
                        (Some(h), _) => draw::hue(h),
                        (None, CloudState::Asleep) => look::TEXT_DIM.rgba(),
                        (None, _) => look::ABE_ACCENT.rgba(),
                    };
                    d.gap(px(4.)).child(
                        div()
                            .debug_selector(move || format!("factory-widget-cloud-{c:?}"))
                            .flex_none()
                            .size(px(12.))
                            .child(workspaces::cloud(c, 12., color)),
                    )
                })
                .child(SharedString::from(w.text));
            match w.tooltip {
                Some(tip) => el
                    .tooltip(crate::kit::tooltip(tip, None))
                    .into_any_element(),
                None => el.into_any_element(),
            }
        })
        .collect()
}

/// What only the shell does, for the view's host (`Projects`).
#[derive(Clone, Debug, PartialEq)]
// (an event, emitted now and then and never stored: the effect's size is no cost)
#[allow(clippy::large_enum_variant)]
pub enum FactoryEvent {
    Shell(ShellEffect),
    /// A layer came up (true) or the last one closed (false).
    Layer(bool),
}

/// The Factory view: the open screen's latest tree, the bridge process behind it.
pub struct FactoryView {
    focus: FocusHandle,
    /// How the bridge is started (its terminals run the same `abe`); None until it was.
    command: Option<BridgeCommand>,
    /// The bridge process and all the bridge is to know ([`bridge::Session`]).
    bridge: bridge::Session,
    /// The main slot's screen as drawn (the bridge opens screens itself too).
    screen: String,
    /// Each slot's latest tree (main's the open screen's): the bridge process's generation,
    /// the tree's rev. Shared: a render borrows it, a slot's view holds it while it draws.
    trees: HashMap<Slot, (u64, u64, std::rc::Rc<Node>)>,
    /// The text the mouse selects in the main slot's screen ([`select`]).
    text: std::rc::Rc<select::TextSel>,
    /// What the main slot's, the popup's and the layers' parts keep between frames.
    memory: std::rc::Rc<memory::Memory>,
    /// The text the mouse selects in Settings, a layer over it.
    settings_text: std::rc::Rc<select::TextSel>,
    /// The slot with the keyboard (the bridge hears it once no layer is up).
    focused_slot: Option<Slot>,
    /// The stripe's place, told with the window.
    place: Option<String>,
    /// Whether the window is active, as its activation and the last frame said.
    window_active: bool,
    /// The shown project ([`ShownProject`]).
    project: Option<ShownProject>,
    /// The caret waiting out the debounce ([`CARET_DEBOUNCE`]).
    _caret: Option<Task<()>>,
    /// What Chat is on ([`chat_target`]).
    chat_target: ChatTarget,
    /// The `chat` screen's `chat-session` since Chat last moved between the card and the
    /// workspace (None: not said since).
    chat_session: Option<Option<String>>,
    /// The session Chat was on at the last quit in the next shown workspace
    /// ([`Self::restore_chat`]).
    chat_restore_next: Option<String>,
    /// The Factory screen's selected card (`selected`).
    selected: Option<Selected>,
    /// The Board said what it selects since the view started (a null then is no card, its ring
    /// on an empty column; before it, Chat is on the shown workspace).
    said_selected: bool,
    /// Chat was opened on the Board's new card: the main tree waits for Chat's answer, so the
    /// ring and Chat change in one frame ([`CHAT_SYNC`]).
    _chat_sync: Option<Task<()>>,
    /// Opens Chat in Terminal mode on the selected card once it rested [`CARD_REST`].
    _card_rest: Option<Task<()>>,
    /// The pointer is over the view: moved over it since it last left, was hidden or the
    /// window went to the back.
    pointer_in: bool,
    /// The wheel over the Board, counted into whole steps: down a column, and sideways.
    wheel: board::Wheels,
    /// A key or a click was sent within [`INPUT_ANSWER`]: the trees answering it are never held.
    answering: bool,
    _answering: Option<Task<()>>,
    /// Where the view was last drawn: the pointer still inside it is over the view, whatever
    /// GPUI's hover says (a key press clears the hover with the pointer where it was).
    drawn_at: std::rc::Rc<std::cell::Cell<Option<gpui_kit::Bounds<gpui_kit::Pixels>>>>,
    /// The main slot's newest tree (generation, rev, screen, tree), held back while it moves the
    /// Board's cards under the pointer ([`HOLD`]).
    held: Option<(u64, u64, String, Node)>,
    _hold: Option<Task<()>>,
    /// The top layer, as [`Self::tree`].
    layer: Option<(u64, u64, Node)>,
    /// No bridge answers: the dialog drawn from the contract's serve-down tree, keyed here.
    settings_fallback: bool,
    /// `:` was sent and its layer hasn't come yet: the view keeps the keyboard meanwhile.
    awaiting_layer: bool,
    /// Gives the keyboard back when no layer comes ([`AWAIT_LAYER`]).
    _await: Option<Task<()>>,
    /// The view is the shown view (else only its layer is drawn, over the Editor). A view of
    /// its own (tests) is.
    pub shown: bool,
    /// px the host's chrome takes from the window's height (toolbar + status bar).
    pub chrome_height: f32,
    /// px the host takes from the window's width (the Factory view's Chat column).
    pub chrome_width: f32,
    /// px the host takes from the Board's width as it is drawn, or would be while the Editor is
    /// shown: the bridge lays the Board out for that width whichever view is shown, so its column
    /// count is the Board's width's alone (else a Board shown again drew the columns laid
    /// out for the whole window until the bridge answered).
    pub board_room: f32,
    drawn: Drawn,
    /// The card dialog's markdown and scroll ([`dialog`]).
    dialog: dialog::DialogDraw,
    /// The Card page's, kept apart from the dialog's ([`dialog::card_page`]).
    page: dialog::DialogDraw,
    /// The shown project's folder, told the bridge (`hello`, then `project` as it changes).
    root: Option<String>,
    /// The tree's terminals ([`terminal`]), their output and exits on one channel.
    terms: terminal::Terms,
    pty_tx: mpsc::UnboundedSender<crate::terminal::PtyEvent>,
    /// Per slot, the key of the terminal its tree gives the keyboard.
    want_terminal: HashMap<Slot, String>,
    /// The layer's focused terminal (the Settings dialog's fix strip): it has the keyboard.
    layer_terminal: Option<String>,
    /// The tree's BrowserViews' pages ([`crate::factory::pages`]), their events on one channel.
    browsers: crate::factory::pages::Browsers,
    /// The key of the page the tree gives the keyboard.
    want_page: Option<String>,
    /// Something of the host is drawn over the view (a balloon, a popup, a picker): no page shows.
    covered: bool,
    /// The page given the keyboard last (the tree's, while the view has it, no layer up).
    applied_page: Option<String>,
    _pages: Task<()>,
    _ptys: Task<()>,
    _sweep: Task<()>,
    _events: Task<()>,
    /// Redraws as the keyboard or the window's activation comes and goes (the selection's look).
    _focus: [gpui_kit::Subscription; 5],
}

/// What a slot's view draws of the [`FactoryView`] ([`FactoryView::slot_stamp`]).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SlotStamp {
    tree: Option<(u64, u64)>,
    stopped: bool,
    layer_up: bool,
    focused: Option<Slot>,
    terminal: Option<String>,
    terms: Vec<gpui_kit::EntityId>,
}

/// The project the window shows, as the Chat slot follows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShownProject {
    /// Its folder as opened: its Editor's caret and branch are found by it ([`Editors`]).
    pub dir: std::path::PathBuf,
    /// Where the bridge runs commands (`--repo`, a session's worktree is compared with it): the
    /// folder with links resolved; None for a cloud workspace (the last local folder stays).
    pub root: Option<String>,
    /// A cloud workspace's box (its attach's `box.name`).
    pub box_: Option<String>,
}

/// How long the caret rests before the bridge hears of it.
pub const CARET_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

/// How long the Factory view's selection rests before Chat in Terminal mode follows the card
/// (moving fast through cards attaches only the last one's session). Chat mode follows
/// at once (its header and body change with the Board).
pub const CARD_REST: std::time::Duration = std::time::Duration::from_millis(300);

/// How long the Board's tree waits for Chat's answer to following its card (the ring and
/// Chat's header and body change in one frame); a slower Chat lets the Board show alone.
pub const CHAT_SYNC: std::time::Duration = std::time::Duration::from_millis(120);

/// How long a tree that moves the Board's cards waits while the pointer is over the view
/// (a card moved under the pointer as it was clicked, the click landed on the next one). The
/// pointer leaving, a key or a click shows it at once.
pub const HOLD: std::time::Duration = std::time::Duration::from_millis(1500);

/// After a key or a click, how long the trees that come are taken as its answer (drawn at once,
/// never held).
pub const INPUT_ANSWER: std::time::Duration = std::time::Duration::from_millis(1000);

/// The Board's tab as drawn (`mine`, `team`): its header's selected `tab:<name>`.
fn board_tab(n: &Node) -> Option<String> {
    if let Node::BoardHeader { props, .. } = n {
        return props
            .selected
            .as_deref()
            .and_then(|t| t.strip_prefix("tab:"))
            .map(str::to_owned);
    }
    n.children().iter().find_map(board_tab)
}

/// The Board's cards as drawn: column by column (`col:New` → `card:4`, `card:7`) and the selected
/// one. What a hold compares.
#[derive(Default)]
struct CardLayout {
    columns: Vec<(String, Vec<String>)>,
    selected: Option<String>,
}

impl CardLayout {
    fn of(n: &Node) -> Self {
        fn walk(n: &Node, out: &mut CardLayout) {
            if n.kind() == "BoardColumn" {
                let mut cards = Vec::new();
                for c in n.children() {
                    if let Node::BoardCard { id, props, .. } = c {
                        let id = id.clone().unwrap_or_default();
                        if props.selection != board::Selection::Default {
                            out.selected = Some(id.clone());
                        }
                        cards.push(id);
                    }
                }
                out.columns
                    .push((n.id().unwrap_or_default().to_owned(), cards));
                return;
            }
            for c in n.children() {
                walk(c, out);
            }
        }
        let mut out = CardLayout::default();
        walk(n, &mut out);
        out
    }

    /// A card drawn here is elsewhere in `next` (another column, another place in its column)
    /// or gone. New cards below the drawn ones, or in an empty column, move nothing.
    fn moved_in(&self, next: &CardLayout) -> bool {
        let at: HashMap<&str, (&str, usize)> = next
            .columns
            .iter()
            .flat_map(|(col, cards)| {
                cards
                    .iter()
                    .enumerate()
                    .map(move |(i, c)| (c.as_str(), (col.as_str(), i)))
            })
            .collect();
        self.columns.iter().any(|(col, cards)| {
            cards
                .iter()
                .enumerate()
                .any(|(i, c)| at.get(c.as_str()) != Some(&(col.as_str(), i)))
        })
    }
}

/// What a project's Editor last said (its status bar's parts): the caret ([`Caret`],
/// relative to the project's folder) and the checked-out branch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EditorAt {
    pub caret: Option<Caret>,
    pub branch: Option<String>,
}

/// Every open project's [`EditorAt`], by its folder; the Factory view tells the bridge the shown
/// project's.
#[derive(Clone, Debug, Default)]
pub struct Editors(pub HashMap<std::path::PathBuf, EditorAt>);

impl Global for Editors {}

/// A project's Editor said where its caret is and what branch it is on.
pub fn set_editor_at(project: &std::path::Path, at: EditorAt, cx: &mut App) {
    let mut all = cx.try_global::<Editors>().cloned().unwrap_or_default();
    if all.0.get(project) == Some(&at) {
        return;
    }
    all.0.insert(project.to_path_buf(), at);
    cx.set_global(all);
}

impl EventEmitter<FactoryEvent> for FactoryView {}

impl FactoryView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, mut rx) = mpsc::unbounded::<BridgeEvent>();
        let events = cx.spawn(async move |this, cx| {
            while let Some(ev) = rx.next().await {
                if this.update(cx, |v, cx| v.on_bridge(ev, cx)).is_err() {
                    break;
                }
            }
        });
        let (pty_tx, mut pty_rx) = mpsc::unbounded::<crate::terminal::PtyEvent>();
        let ptys = cx.spawn(async move |this, cx| {
            while let Some(ev) = pty_rx.next().await {
                if this.update(cx, |v, cx| v.on_pty(ev, cx)).is_err() {
                    break;
                }
            }
        });
        let (page_tx, mut page_rx) =
            mpsc::unbounded::<(String, crate::factory::pages::BrowserEvent)>();
        let pages = cx.spawn(async move |this, cx| {
            while let Some((key, ev)) = page_rx.next().await {
                if this.update(cx, |v, cx| v.on_page(key, ev, cx)).is_err() {
                    break;
                }
            }
        });
        // terminals and pages no tree holds go after their time even when no tree comes
        let sweep = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(30))
                    .await;
                if this
                    .update(cx, |v, cx| {
                        v.terms.sweep(cx);
                        v.browsers.sweep();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        // the Run page's images are probed off the UI thread: drawn again once they were
        run::probe_in(cx);
        let focus = cx.focus_handle();
        let mut bridge = bridge::Session::new(tx);
        bridge.screen_is(Slot::Main, FIRST_SCREEN);
        FactoryView {
            focus: focus.clone(),
            command: None,
            bridge,
            screen: FIRST_SCREEN.into(),
            trees: HashMap::new(),
            text: std::rc::Rc::default(),
            memory: std::rc::Rc::default(),
            settings_text: std::rc::Rc::default(),
            focused_slot: None,
            place: None,
            window_active: false,
            project: None,
            _caret: None,
            chat_target: ChatTarget::default(),
            chat_session: None,
            chat_restore_next: None,
            selected: None,
            said_selected: false,
            _chat_sync: None,
            _card_rest: None,
            pointer_in: false,
            wheel: board::Wheels::default(),
            answering: false,
            _answering: None,
            drawn_at: Default::default(),
            held: None,
            _hold: None,
            layer: None,
            settings_fallback: false,
            awaiting_layer: false,
            _await: None,
            shown: true,
            chrome_height: 0.,
            chrome_width: 0.,
            board_room: 0.,
            drawn: Drawn::default(),
            dialog: dialog::DialogDraw::default(),
            page: dialog::DialogDraw::default(),
            root: None,
            terms: terminal::Terms::default(),
            pty_tx,
            want_terminal: HashMap::new(),
            layer_terminal: None,
            browsers: crate::factory::pages::Browsers::new(page_tx),
            want_page: None,
            applied_page: None,
            covered: false,
            _pages: pages,
            _ptys: ptys,
            _sweep: sweep,
            _events: events,
            _focus: [
                cx.on_focus_in(&focus, window, |v, _, cx| {
                    if v.shown {
                        v.slot_focus(Slot::Main, true, cx);
                    }
                    cx.notify();
                }),
                // the keyboard went elsewhere (a click on the Editor, the view hidden): no layer
                // stays up without it
                cx.on_focus_out(&focus, window, |v, _, _, cx| {
                    v.blur_layer(cx);
                    v.slot_focus(Slot::Main, false, cx);
                    cx.notify();
                }),
                cx.observe_window_activation(window, |v, window, cx| {
                    // gone to the back: the pointer is not over the view as far as it knows
                    if !window.is_window_active() {
                        v.pointer(false, cx);
                    }
                    // told here too: the view is not drawn while the Editor is shown
                    v.window_active = crate::editor::window_active(window);
                    v.tell_window();
                    cx.notify()
                }),
                // the shown Editor's caret and branch, as its status bar hears them
                cx.observe_global::<Editors>(|v, cx| v.editor_moved(cx)),
                // the Factory view's column mode: the `chat` screen told with its params
                cx.observe_global::<crate::shell::ColumnState>(|v, cx| v.column_moved(cx)),
            ],
        }
    }

    /// The shown project's folder: where the bridge runs the screens' commands (`--repo` too).
    /// Told in `hello`, and as a `project` frame when it changes while the bridge runs.
    pub fn set_root(&mut self, root: Option<String>) {
        if root == self.root {
            return;
        }
        self.root = root;
        let branch = self.bridge.project().branch.clone();
        self.tell_project(branch);
    }

    /// The shown project: the Chat slot's `chat` screen is opened again on it (`open chat
    /// {root, box?, branch?}`), so Chat follows the shown workspace; its box goes with `project`.
    pub fn set_shown_project(&mut self, shown: Option<ShownProject>, cx: &mut Context<Self>) {
        if shown == self.project {
            self.chat_restore_next = None;
            return;
        }
        if let Some(root) = shown.as_ref().and_then(|s| s.root.clone()) {
            self.root = Some(root);
        }
        let moved = |p: &Option<ShownProject>| p.as_ref().map(|s| (s.root.clone(), s.box_.clone()));
        if moved(&shown) != moved(&self.project) {
            // the stripe's dots were the other workspace's (Pipelines'): gone until its own read;
            // the status line's notice too (another repo's `Local changes discarded`)
            if let Some(mut shell) = cx.try_global::<FactoryShell>().cloned()
                && (!shell.stripe_dots.is_empty() || shell.status.is_some())
            {
                shell.stripe_dots.clear();
                shell.status = None;
                cx.set_global(shell);
            }
        }
        if moved(&shown) == moved(&self.project) {
            self.chat_restore_next = None;
        } else {
            self.chat_target.shown_moved(self.chat_restore_next.take());
        }
        self.project = shown;
        // another workspace's terminal: its Claude Code tab told anew once Chat says
        self.chat_session = None;
        self.bridge.forget_caret();
        let branch = self.shown_editor(cx).and_then(|e| e.branch);
        self.tell_project(branch);
        self.open_chat(cx);
        self.editor_moved(cx);
    }

    /// The next shown workspace (another than the shown one) is one Chat was on `session` in at
    /// the last quit: Chat opens on it there again ([`ChatTarget::Restored`]).
    pub fn restore_chat(&mut self, session: String) {
        self.chat_restore_next = Some(session);
    }

    /// What the shown project's Editor last said.
    fn shown_editor(&self, cx: &App) -> Option<EditorAt> {
        let dir = &self.project.as_ref()?.dir;
        cx.try_global::<Editors>()?.0.get(dir).cloned()
    }

    /// The shown project {root, box, branch} as the bridge is to know it (`project` as it
    /// changes, once there is a root).
    fn tell_project(&mut self, branch: Option<String>) {
        let box_ = self.project.as_ref().and_then(|s| s.box_.clone());
        self.bridge.want_project(bridge::Project {
            root: self.root.clone(),
            box_,
            branch,
        });
    }

    /// The Chat slot's `chat` screen opened again on the shown workspace (it keeps its state and
    /// gets the `open` input), once a [`SlotView`] asked for it.
    fn open_chat(&mut self, cx: &mut Context<Self>) {
        if self
            .bridge
            .opened(Slot::Chat)
            .is_some_and(|o| o.screen == CHAT_SCREEN)
        {
            let params = self.chat_params(cx);
            self.open_in(Slot::Chat, CHAT_SCREEN, params, cx);
        }
    }

    /// The window's column changed: the `chat` screen opened again when its params changed with
    /// it (the Factory view's Terminal mode).
    fn column_moved(&mut self, cx: &mut Context<Self>) {
        self.reopen_chat(cx);
    }

    /// Chat follows the selected card (the Factory view shown) or the shown workspace
    /// (the Editor): opened again at once on what this view pins.
    pub fn set_chat_on_card(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.chat_target.on_card(on) {
            self.chat_moved(cx);
        }
    }

    /// Chat on the repo's Abe chat, `root` its main checkout (Boxes, Pipelines), wherever you
    /// came from: opened again at once on it.
    pub fn set_chat_on_abe(&mut self, root: String, cx: &mut Context<Self>) {
        if self.chat_target.on_abe(root) {
            self.chat_moved(cx);
        }
    }

    /// Chat on `session` (a prototype's tile: its own session), whatever the Board selects:
    /// opened again at once on it.
    pub fn set_chat_on_session(&mut self, session: String, cx: &mut Context<Self>) {
        if self.chat_target.on_prototype(session) {
            self.chat_moved(cx);
        }
    }

    /// What Chat is on moved: opened again at once on it, what it said gone.
    fn chat_moved(&mut self, cx: &mut Context<Self>) {
        self.chat_session = None;
        self._card_rest = None;
        self.open_chat(cx);
    }

    /// The Factory screen's selected card, as its `selected` last said.
    pub fn selected(&self) -> Option<u64> {
        self.selected.as_ref().map(|s| s.card)
    }

    /// The screen's `selected` (while Chat follows the card, unless it is on it already): Chat
    /// opens on the card, or on none, at once in Chat mode with the Board's tree waiting for its
    /// answer; in Terminal mode on a card once it rested [`CARD_REST`].
    fn select(&mut self, selected: Option<Selected>, cx: &mut Context<Self>) {
        self.selected = selected;
        self.said_selected = true;
        self._card_rest = None;
        // Chat back on its last quit's session: the Board's first selection since is not followed
        let card = self.selected.as_ref().map(|s| s.card);
        if self.chat_target.selected(card) {
            return;
        }
        if !self.follows_card() {
            return;
        }
        // Terminal mode attaches each card's session: only the one it rests on
        if self.selected.is_none() || !self.chat_params(cx).contains_key("mode") {
            if self.reopen_chat(cx) {
                self._chat_sync = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(CHAT_SYNC).await;
                    let _ = this.update(cx, |v, cx| v.chat_synced(cx));
                }));
            }
            return;
        }
        self._card_rest = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CARD_REST).await;
            let _ = this.update(cx, |v, cx| v.reopen_chat(cx));
        }));
    }

    /// Chat follows the Board's selected card: the Factory view shown, not on the Run place (the
    /// shown workspace's run: Chat on that workspace, as in the Editor), nor on the Abe chat.
    fn follows_card(&self) -> bool {
        self.chat_target.follows_card(self.screen == RUN_SCREEN)
    }

    /// The main slot's screen is `screen` now: Chat opened again when that moved it between the
    /// card and the workspace.
    fn main_screen_is(&mut self, screen: &str, cx: &mut Context<Self>) {
        let was = self.follows_card();
        // another screen: what was selected on the last one is gone
        if self.screen != screen {
            self.text.clear();
        }
        screen.clone_into(&mut self.screen);
        if was != self.follows_card() {
            self.reopen_chat(cx);
        }
    }

    /// The open `chat` screen opened again when its params changed; whether it was.
    fn reopen_chat(&mut self, cx: &mut Context<Self>) -> bool {
        let params = self.chat_params(cx);
        let on = self.bridge.opened(Slot::Chat);
        if on.is_some_and(|o| o.screen == CHAT_SCREEN && o.params != params) {
            self.open_in(Slot::Chat, CHAT_SCREEN, params, cx);
            return true;
        }
        false
    }

    /// Chat answered following the card (or [`CHAT_SYNC`] passed): the Board's tree it waited
    /// for drawn with it.
    fn chat_synced(&mut self, cx: &mut Context<Self>) {
        if self._chat_sync.take().is_some() {
            self.release_hold(cx);
        }
    }

    /// The `chat` screen's params ([`chat_target::open_params`]).
    fn chat_params(&self, cx: &App) -> BTreeMap<String, String> {
        let column = crate::shell::column_state(cx);
        let terminal = crate::shell::ColumnMode::Terminal;
        let project = self.project.as_ref();
        let branch = self.shown_editor(cx).and_then(|e| e.branch);
        let at = ChatAt {
            selected: self.selected.as_ref(),
            said_selected: self.said_selected,
            on_run: self.screen == RUN_SCREEN,
            modes: Modes {
                factory_shown: column.factory_shown,
                factory_terminal: column.factory_mode == terminal,
                terminal_now: column.mode_now() == terminal,
            },
            root: self.root.as_deref(),
            box_: project.and_then(|p| p.box_.as_deref()),
            branch: branch.as_deref(),
        };
        chat_target::open_params(&self.chat_target, &at)
    }

    /// The shown Editor's caret or branch moved: the branch goes with `project`, the caret as a
    /// `caret` frame once it rested [`CARET_DEBOUNCE`].
    fn editor_moved(&mut self, cx: &mut Context<Self>) {
        let at = self.shown_editor(cx).unwrap_or_default();
        self.tell_project(at.branch);
        let Some(caret) = at.caret else {
            // no file open: the Chat's implicit context clears (once)
            self._caret = None;
            self.bridge.want_caret(None);
            return;
        };
        if self.bridge.caret() == Some(Some(&caret)) {
            self._caret = None;
            return;
        }
        self._caret = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CARET_DEBOUNCE).await;
            let _ = this.update(cx, |v, _| v.bridge.want_caret(Some(caret)));
        }));
    }

    /// The main slot's screen (`factory`, the Board's; `run`, the Run place's: the stripe picks).
    pub fn main_screen(&self) -> &str {
        &self.screen
    }

    /// Opens `screen` in `slot` (main: in place of the open screen): sent now, and again
    /// when the bridge starts anew. The screen already open there gets the `open` input.
    pub fn open_in(
        &mut self,
        slot: Slot,
        screen: &str,
        params: BTreeMap<String, String>,
        cx: &mut Context<Self>,
    ) {
        if slot == Slot::Main {
            self.main_screen_is(screen, cx);
        }
        self.bridge.open(slot, screen, params);
    }

    /// `screen` opened in `slot` once, not again when the bridge starts anew (the Git Log's PR
    /// pick: what the slot holds stays as it was opened before).
    pub fn open_once(&mut self, slot: Slot, screen: &str, params: BTreeMap<String, String>) {
        self.bridge.open_once(slot, screen, params);
    }

    /// `abe <argv> --json` for the shell itself (Create Draft PR), run by the bridge in the shown
    /// folder: its `{ok, data}` or `{ok, error}` document once answered; None without a bridge (a
    /// bridge gone before it answered drops the sender, which the receiver hears as cancelled).
    pub fn run(&mut self, argv: Vec<String>) -> Option<futures::channel::oneshot::Receiver<Value>> {
        self.bridge.run(argv)
    }

    /// The bottom pane's tab picked: `screen` opened in the `pane` slot unless it is the
    /// one there under the same view; `shown`: the pane shown anew, opened again all the same
    /// (Sessions selects the shown workspace's row).
    pub fn open_pane(&mut self, screen: &str, shown: bool, cx: &mut Context<Self>) {
        let params = self.pane_params();
        let same = self
            .bridge
            .opened(Slot::Pane)
            .is_some_and(|o| o.screen == screen && o.params == params);
        if shown || !same {
            self.open_in(Slot::Pane, screen, params, cx);
        }
    }

    /// The pane's screens' `view` param: `factory` while the Factory view is shown, else
    /// `editor` (Sessions' ⏎ keeps the Editor there and selects no hidden Board card).
    fn pane_params(&self) -> BTreeMap<String, String> {
        let view = if self.shown { "factory" } else { "editor" };
        BTreeMap::from([("view".to_owned(), view.to_owned())])
    }

    /// The pane's screen opened again under the view now shown, if it was opened under another.
    fn reopen_pane(&mut self, cx: &mut Context<Self>) {
        let params = self.pane_params();
        let Some(was) = self.bridge.opened(Slot::Pane).cloned() else {
            return;
        };
        if was.params.get("view") != params.get("view") {
            self.open_in(Slot::Pane, &was.screen, params, cx);
        }
    }

    /// A [`SlotView`] drawing `slot`'s tree; for the Chat slot the `chat` screen is opened on
    /// the shown workspace unless a screen was opened there.
    pub fn slot_view(
        &mut self,
        slot: Slot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Entity<SlotView> {
        if slot == Slot::Chat && self.bridge.opened(Slot::Chat).is_none() {
            let params = self.chat_params(cx);
            self.open_in(Slot::Chat, CHAT_SCREEN, params, cx);
        }
        let factory = cx.entity();
        cx.new(|cx| SlotView::new(factory, slot, window, cx))
    }

    /// The bridge runs and has drawn `slot`'s screen (its keys reach something).
    pub fn slot_up(&self, slot: Slot) -> bool {
        self.bridge.up() && self.trees.contains_key(&slot)
    }

    /// `slot`'s latest tree.
    pub fn slot_tree(&self, slot: Slot) -> Option<&Node> {
        self.trees.get(&slot).map(|(_, _, n)| &**n)
    }

    /// `slot`'s latest tree, shared (a slot's view draws it while this view is not borrowed).
    pub(crate) fn shared_tree(&self, slot: Slot) -> Option<std::rc::Rc<Node>> {
        self.trees.get(&slot).map(|(_, _, n)| n.clone())
    }

    /// What `slot`'s view draws of this view: it draws again only when this changes (another
    /// slot's tree, the Board's, never redraws it).
    pub(crate) fn slot_stamp(&self, slot: Slot) -> SlotStamp {
        let terminal = if self.layer_up() {
            self.layer_terminal.clone().filter(|_| slot == Slot::Main)
        } else {
            self.want_terminal.get(&slot).cloned()
        };
        let mut terms: Vec<gpui_kit::EntityId> =
            self.terms.views().map(|v| v.entity_id()).collect();
        terms.sort();
        SlotStamp {
            tree: self.trees.get(&slot).map(|(g, rev, _)| (*g, *rev)),
            stopped: self.bridge.stopped().is_some(),
            layer_up: self.layer_up(),
            focused: self.focused_slot,
            terminal,
            terms,
        }
    }

    /// The focus handle of the terminal `slot`'s tree gives the keyboard (no layer up), or the
    /// layer's own focused terminal while one is up (the main slot's).
    pub(crate) fn wanted_terminal(&self, slot: Slot, cx: &App) -> Option<FocusHandle> {
        let key = if self.layer_up() {
            self.layer_terminal
                .as_ref()
                .filter(|_| slot == Slot::Main)?
        } else {
            self.want_terminal.get(&slot)?
        };
        self.terms
            .get(key)
            .map(|t| t.read(cx).focus_handle().clone())
    }

    /// The terminals by key, for a drawn tree.
    pub(crate) fn term_views(
        &self,
        cx: &App,
    ) -> HashMap<String, gpui_kit::Entity<terminal::TermView>> {
        self.terms
            .views()
            .map(|v| (v.read(cx).key.clone(), v.clone()))
            .collect()
    }

    /// A slot's view was measured: `resize {slot}` when it changed.
    pub(crate) fn resize_slot(&mut self, slot: Slot, size: ViewSize) {
        self.bridge.want_slot_size(slot, size);
    }

    /// A slot's view got (or lost) the keyboard: `focus {slot | null}` once the change settled
    /// (the keyboard going from one slot to another is one frame, no null between).
    pub(crate) fn slot_focus(&mut self, slot: Slot, has: bool, cx: &mut Context<Self>) {
        if has {
            self.focused_slot = Some(slot);
        } else if self.focused_slot == Some(slot) {
            self.focused_slot = None;
        }
        let this = cx.weak_entity();
        cx.defer(move |cx| {
            let _ = this.update(cx, |v, _| v.tell_focus());
        });
    }

    /// Tells the bridge where the keyboard went, never while a layer is up: the bridge gives
    /// the keys to the layer then, and the keyboard the app moves to draw it over the Editor
    /// must not read as the slot under it losing them (a list keeps its held order under
    /// a menu). The frame after it closes tells where they settled.
    fn tell_focus(&mut self) {
        if !self.layer_up() {
            self.bridge.want_focus(self.focused_slot);
        }
    }

    /// A move landed with the keys in Chat while its slot had them already (the Board to Boxes):
    /// the bridge hears them leave and come back, so Chat's screen puts them in its composer as
    /// on any landing, never on a card that took them meanwhile.
    pub(crate) fn chat_landed(&mut self) {
        if self.focused_slot != Some(Slot::Chat)
            || self.bridge.focus() != Some(Slot::Chat)
            || self.layer_up()
        {
            return;
        }
        self.bridge.refocus();
    }

    /// The view shown and whether the window is active, told once each time either
    /// changes: the bridge keeps the Board's outside data fresh while it is shown.
    fn tell_window(&mut self) {
        let view = if self.shown {
            ViewName::Factory
        } else {
            ViewName::Editor
        };
        self.bridge.want_window(bridge::WindowAt {
            view,
            active: self.window_active,
            place: self.place.clone(),
        });
    }

    /// The stripe's place in the main area: told the bridge with the window, on a change.
    pub fn set_place(&mut self, place: &str) {
        if self.place.as_deref() != Some(place) {
            self.place = Some(place.to_string());
            self.tell_window();
        }
    }

    /// The slot with the keyboard (tests).
    pub fn focused_slot(&self) -> Option<Slot> {
        self.focused_slot
    }

    /// The card dialog's draw state (tests: how far it scrolled).
    pub fn dialog_draw(&self) -> &dialog::DialogDraw {
        &self.dialog
    }

    /// The Card page's draw state (tests: how far it scrolled).
    pub fn page_draw(&self) -> &dialog::DialogDraw {
        &self.page
    }

    /// Starts the bridge (once) and opens the first screen, sized to the window.
    pub fn start(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.bridge.started() {
            return;
        }
        let command = self.bridge_command(cx);
        self.command = Some(command.clone());
        let size = self.board_size_in(window);
        self.bridge.want_size(size);
        self.begin();
        let landing = self.landing();
        if let Err(why) = self.bridge.start(Box::new(command), landing) {
            self.spawn_failed(why, cx);
        }
        cx.notify();
    }

    fn size_in(&self, window: &Window) -> ViewSize {
        let v = window.viewport_size();
        ViewSize {
            width: (f32::from(v.width) - self.chrome_width).max(0.),
            height: (f32::from(v.height) - self.chrome_height).max(0.),
        }
    }

    /// The size the bridge lays the main screen out for: the Board's, shown or not.
    fn board_size_in(&self, window: &Window) -> ViewSize {
        ViewSize {
            width: (f32::from(window.viewport_size().width) - self.board_room).max(0.),
            ..self.size_in(window)
        }
    }

    /// The command the bridge runs: the test's global, else `$ABE_BIN`'s / the bundled `abe`.
    fn bridge_command(&self, cx: &App) -> BridgeCommand {
        self.command
            .clone()
            .or_else(|| cx.try_global::<BridgeCommand>().cloned())
            .unwrap_or_else(BridgeCommand::from_env)
    }

    /// The bridge could not start (`why` names its program): gone as one that died.
    fn spawn_failed(&mut self, why: String, cx: &mut Context<Self>) {
        protocol::log_once("spawn", &format!("can't start {why}"));
        self.died(why, cx);
    }

    /// A new bridge is starting: the other slots' trees were the dead one's (their screens are
    /// opened anew).
    fn begin(&mut self) {
        self.trees.retain(|slot, _| *slot == Slot::Main);
    }

    /// The screens a new bridge opens in place of the kept ones: the Board on the card the
    /// dead one had selected (not its first card on open), on the tab it was drawn on; Chat on
    /// the session picked there since it was opened (Sessions, a Retry; none picked since: the
    /// older one it was opened on is not brought back).
    fn landing(&self) -> Landing {
        let mut slots = Vec::new();
        if self.screen == FIRST_SCREEN {
            let mut params = BTreeMap::new();
            if let Some(Selected { card, .. }) = &self.selected {
                params.insert("card".to_owned(), card.to_string());
                if let Some(tab) = self
                    .trees
                    .get(&Slot::Main)
                    .and_then(|(_, _, t)| board_tab(t))
                {
                    params.insert("tab".to_owned(), tab);
                }
            }
            slots.push((Slot::Main, params));
        }
        if let Some(chat) = self
            .bridge
            .opened(Slot::Chat)
            .filter(|o| o.screen == CHAT_SCREEN)
            && let Some(picked) = &self.chat_session
        {
            let mut params = chat.params.clone();
            match picked {
                Some(session) => params.insert("session".to_owned(), session.clone()),
                None => params.remove("session"),
            };
            slots.push((Slot::Chat, params));
        }
        Landing { slots }
    }

    /// The bridge is gone: once it starts again, after that the view says it stopped.
    fn died(&mut self, why: String, cx: &mut Context<Self>) {
        // the shell's own commands it held go unanswered: their waiters hear it now
        self.bridge.lost();
        let settings = self.bridge.settings().cloned();
        self.set_layer(None, cx);
        self.bridge.set_settings(settings);
        self.begin();
        let landing = self.landing();
        match self.bridge.restart(why, landing) {
            Ok(()) => cx.notify(),
            Err(_) => self.stopped_now(cx),
        }
    }

    /// No bridge any more: the header says so, the Settings dialog stays up as the contract's
    /// serve-down tree.
    fn stopped_now(&mut self, cx: &mut Context<Self>) {
        let mut feed = cx
            .try_global::<workspaces::WorkspaceFeed>()
            .cloned()
            .unwrap_or_default();
        feed.bridge_down = true;
        cx.set_global(feed);
        if self.bridge.settings().is_some() {
            self.settings_without_bridge(cx);
        }
        cx.notify();
    }

    /// A slot's newest tree drawn (the bridge opens screens itself too, `:factory`: the newest
    /// tree is the screen).
    fn apply_tree(
        &mut self,
        slot: Slot,
        generation: u64,
        rev: u64,
        screen: String,
        tree: Node,
        cx: &mut Context<Self>,
    ) {
        if slot == Slot::Main {
            self.sync_pages(&tree);
            self.main_screen_is(&screen, cx);
        }
        self.bridge.screen_is(slot, &screen);
        self.trees
            .insert(slot, (generation, rev, std::rc::Rc::new(tree)));
        self.sweep_memory();
        self.sync_terms(cx);
        cx.notify();
    }

    /// What the parts of the trees this view draws (main's, the popup's, the layer) keep, swept
    /// after each.
    fn sweep_memory(&self) {
        let trees: Vec<&Node> = [Slot::Main, Slot::Popup]
            .iter()
            .filter_map(|s| self.trees.get(s).map(|(_, _, n)| &**n))
            .chain(self.layer.as_ref().map(|(_, _, n)| n))
            .collect();
        self.memory.sweep(&trees);
    }

    /// How many parts of the trees it draws keep something (tests: it stays flat).
    pub fn memory_len(&self) -> usize {
        self.memory.len()
    }

    /// The main tree is held back: the pointer is over the view, no layer is up, no key
    /// or click is being answered, and on the same screen with the same card selected it moves
    /// a drawn card on the Board (Chat follows `selected`: a tree selecting another card is
    /// never held).
    fn holds(&self, generation: u64, screen: &str, tree: &Node) -> bool {
        if !self.pointer_in || self.answering || self.layer_up() || screen != self.screen {
            return false;
        }
        let Some((g, _, drawn)) = self.trees.get(&Slot::Main) else {
            return false;
        };
        let (was, next) = (CardLayout::of(drawn), CardLayout::of(tree));
        *g == generation
            && !was.columns.is_empty()
            && !next.columns.is_empty()
            && was.selected == next.selected
            && was.moved_in(&next)
    }

    /// A key or a click went to the bridge: what comes in [`INPUT_ANSWER`] shows at once.
    fn answer_input(&mut self, cx: &mut Context<Self>) {
        self.answering = true;
        self._answering = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(INPUT_ANSWER).await;
            let _ = this.update(cx, |v, _| {
                v.answering = false;
                v._answering = None;
            });
        }));
    }

    fn start_hold(&mut self, cx: &mut Context<Self>) {
        if self._hold.is_some() {
            return;
        }
        self._hold = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(HOLD).await;
            let _ = this.update(cx, |v, cx| v.release_hold(cx));
        }));
    }

    /// The held tree drawn at once (the pointer left, a key, a click, the hold's time).
    fn release_hold(&mut self, cx: &mut Context<Self>) {
        self._hold = None;
        // (a dead bridge's tree is never drawn over its successor's)
        if let Some((generation, rev, screen, tree)) = self.held.take()
            && generation == self.bridge.generation()
        {
            self.apply_tree(Slot::Main, generation, rev, screen, tree, cx);
        }
    }

    /// The pointer moved over the view, or left it (which shows a held tree).
    fn pointer(&mut self, inside: bool, cx: &mut Context<Self>) {
        self.pointer_in = inside;
        if !inside {
            self.release_hold(cx);
        }
    }

    /// Whether a tree is held back from the main slot (tests).
    pub fn holding(&self) -> bool {
        self.held.is_some()
    }

    /// What a bridge said, decoded on its reader thread: the session keeps what counts.
    fn on_bridge(&mut self, ev: BridgeEvent, cx: &mut Context<Self>) {
        #[cfg(feature = "shots")]
        if let BridgeEvent::Frame { line, .. } = &ev {
            crate::devtools::tap(line, cx);
        }
        match self.bridge.take(ev) {
            Some(Heard::Frame(frame)) => self.on_frame(*frame, cx),
            Some(Heard::Exited) => self.died("abe ui bridge exited".into(), cx),
            // another contract version: stopped, the header says why
            Some(Heard::Refused) => self.stopped_now(cx),
            None => {}
        }
    }

    /// One line from the bridge decoded here (tests hand fixture frames in; the bridge's own are
    /// decoded off the UI thread, [`bridge::read`]).
    pub fn receive_line(&mut self, line: &str, cx: &mut Context<Self>) {
        #[cfg(feature = "shots")]
        crate::devtools::tap(line, cx);
        if let Some(frame) = protocol::read_line(line) {
            self.receive_frame(frame, cx);
        }
    }

    /// A frame decoded elsewhere, as the current bridge's (tests: the UI thread's share of a
    /// frame, what [`Self::on_bridge`] does with one its reader thread decoded).
    pub fn receive_frame(&mut self, frame: BridgeFrame, cx: &mut Context<Self>) {
        let stopped = self.bridge.stopped().is_some();
        if let Some(frame) = self.bridge.accept(frame) {
            self.on_frame(*frame, cx);
        } else if !stopped && self.bridge.stopped().is_some() {
            self.stopped_now(cx);
        }
    }

    /// A frame of the current bridge that counts ([`bridge::Session::accept`]).
    fn on_frame(&mut self, frame: BridgeFrame, cx: &mut Context<Self>) {
        match frame {
            BridgeFrame::Tree {
                screen,
                rev,
                tree,
                slot,
                ..
            } => {
                let slot = slot.unwrap_or_default();
                let generation = self.bridge.generation();
                if slot == Slot::Main && self._chat_sync.is_some() {
                    // Chat follows its card: the Board waits for its answer
                    self.held = Some((generation, rev, screen, tree));
                } else if slot == Slot::Main && self.holds(generation, &screen, &tree) {
                    self.held = Some((generation, rev, screen, tree));
                    self.start_hold(cx);
                } else {
                    if slot == Slot::Main {
                        self.held = None;
                        self._hold = None;
                    }
                    self.apply_tree(slot, generation, rev, screen, tree, cx);
                    if slot == Slot::Chat {
                        self.chat_synced(cx);
                    }
                }
            }
            BridgeFrame::Closed { slot, .. } => {
                if self.trees.remove(&slot).is_some() {
                    self.popup_gone();
                    cx.notify();
                }
            }
            BridgeFrame::Layer { rev, tree, .. } => {
                let generation = self.bridge.generation();
                self.settings_fallback = false;
                self.set_layer(tree.map(|t| (generation, rev, t)), cx);
            }
            // the window shell's executor applies it (`crate::shell::effects`)
            BridgeFrame::Shell { effect, .. } => cx.emit(FactoryEvent::Shell(effect)),
            // the session answered its waiter / logged it
            BridgeFrame::Answer { .. } | BridgeFrame::Error { .. } => {}
        }
    }

    /// The slots' trees' terminals: started, kept or let go ([`terminal::Terms::sync`]).
    fn sync_terms(&mut self, cx: &mut Context<Self>) {
        self.want_terminal.clear();
        for (slot, (_, _, tree)) in &self.trees {
            let mut found = Vec::new();
            terminal::terminals(tree, &mut found);
            if let Some((_, p)) = found.iter().find(|(_, p)| p.focused) {
                self.want_terminal.insert(*slot, p.key.clone());
            }
        }
        let command = self
            .command
            .clone()
            .or_else(|| cx.try_global::<BridgeCommand>().cloned())
            .unwrap_or_else(BridgeCommand::from_env);
        let launch = terminal::Launch {
            abe: command.program,
            env: command.env,
        };
        let host = cx.weak_entity();
        // the layer's terminals too (the Settings dialog's fix strip), its keys the top layer's
        self.layer_terminal = self.layer.as_ref().and_then(|(_, _, n)| {
            let mut found = Vec::new();
            terminal::terminals(n, &mut found);
            found
                .into_iter()
                .find(|(_, p)| p.focused)
                .map(|(_, p)| p.key)
        });
        let trees: Vec<(Slot, &Node)> = self
            .trees
            .iter()
            .map(|(s, (_, _, n))| (*s, &**n))
            .chain(self.layer.as_ref().map(|(_, _, n)| (Slot::Main, n)))
            .collect();
        self.terms.sync(&trees, &launch, &self.pty_tx, host, cx);
    }

    /// A new tree's BrowserViews: their pages kept, loaded or let go ([`crate::factory::pages::Browsers`]).
    fn sync_pages(&mut self, tree: &Node) {
        let mut found = Vec::new();
        browser_views(tree, &mut found);
        self.want_page = found.iter().find(|p| p.focused).map(|p| p.key.clone());
        let pages: Vec<crate::factory::pages::Page> = found
            .into_iter()
            .map(|p| crate::factory::pages::Page {
                key: p.key,
                url: p.url,
                mode: p.mode,
                reload: p.reload,
            })
            .collect();
        self.browsers.sync(&pages);
    }

    /// A page told something: the bridge is told (a focus change first follows here).
    fn on_page(
        &mut self,
        key: String,
        ev: crate::factory::pages::BrowserEvent,
        cx: &mut Context<Self>,
    ) {
        if let crate::factory::pages::BrowserEvent::Focus { focused } = ev {
            self.browsers.told_focus(&key, focused);
        }
        self.bridge.send(AppFrame::Browser {
            v: VERSION,
            key,
            event: ev,
        });
        cx.notify();
    }

    /// The pages' keys (tests).
    pub fn page_keys(&self) -> Vec<String> {
        self.browsers.keys()
    }

    /// Shown in place of the project's body, or not (`Projects`): hidden, its pages are too.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.shown = shown;
        // the bridge keeps the Board fresh only while it is shown
        self.tell_window();
        self.reopen_pane(cx);
        if !shown {
            self.browsers.hide_all();
            self.pointer(false, cx);
            // the Board left: its card's popup goes with it
            self.close_popup(cx);
            // nor are its keys there: hidden, the view draws no frame to say so, and a window
            // that sends no focus events (an offscreen one) would leave the bridge on main
            if self.focused_slot == Some(Slot::Main) {
                self.slot_focus(Slot::Main, false, cx);
            }
        }
        cx.notify();
    }

    /// The Board's card popup is up (the `popup` slot's tree).
    pub fn popup_open(&self) -> bool {
        self.trees.contains_key(&Slot::Popup)
    }

    /// The popup over the Board closed as the Board is left (the rail moved): taken away now,
    /// the bridge told (main's screen has the keys again).
    pub fn close_popup(&mut self, cx: &mut Context<Self>) {
        if self.trees.remove(&Slot::Popup).is_none() {
            return;
        }
        self.bridge.close(Slot::Popup);
        self.popup_gone();
        cx.notify();
    }

    /// The popup's page is gone: what was selected on it, its extent told.
    fn popup_gone(&mut self) {
        self.text.clear();
        self.page.forget_extent();
    }

    /// The host draws something over the view (`Projects`: its balloons, popups, pickers): a
    /// native page would hide it, so the pages hide meanwhile.
    pub fn set_covered(&mut self, covered: bool, cx: &mut Context<Self>) {
        if covered != self.covered {
            self.covered = covered;
            if covered {
                self.browsers.hide_all();
            }
            cx.notify();
        }
    }

    /// A terminal's output came (drawn again) or its program exited (the bridge told).
    fn on_pty(&mut self, ev: crate::terminal::PtyEvent, cx: &mut Context<Self>) {
        use crate::terminal::PtyEvent;
        match ev {
            PtyEvent::Wakeup(id) => {
                if let Some(view) = self.terms.key_of(id).and_then(|k| self.terms.get(k)) {
                    view.update(cx, |t, cx| {
                        if t.take_dirty() {
                            cx.notify();
                        }
                    });
                }
            }
            PtyEvent::Exit(id) => {
                if let Some(key) = self.terms.key_of(id).map(str::to_owned) {
                    let code = self.terms.exit_code(id, cx);
                    self.bridge.send(AppFrame::Exit {
                        v: VERSION,
                        key,
                        code,
                    });
                    cx.notify();
                }
            }
            _ => {}
        }
    }

    /// The terminal under a key (tests).
    pub fn terminal(&self, key: &str) -> Option<&gpui_kit::Entity<terminal::TermView>> {
        self.terms.get(key)
    }

    /// The keys of the terminals held (tests).
    pub fn terminal_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.terms.keys().map(str::to_owned).collect();
        keys.sort();
        keys
    }

    /// How long a terminal no tree holds is kept (tests shorten [`terminal::KEEP`]).
    pub fn set_terminal_keep(&mut self, keep: std::time::Duration) {
        self.terms.keep = Some(keep);
    }

    /// The keyboard where the tree says: its focused terminal, else the view; a layer always
    /// the view. Only while the view (or one of its terminals) has it.
    fn place_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // the page the tree gives the keyboard takes it while the view has it and no layer is up
        let page = self.want_page.clone().filter(|_| {
            self.shown
                && !self.layer_up()
                && !self.covered
                && self.focus.contains_focused(window, cx)
        });
        // only as that changes: a click in a page takes the keyboard before the tree says so
        if page != self.applied_page {
            if let Some(had) = self.applied_page.take() {
                self.browsers.focus(&had, false);
            }
            if let Some(key) = &page {
                self.browsers.focus(key, true);
            }
            self.applied_page = page.clone();
        }
        if page.is_some() {
            return;
        }
        if !self.focus.contains_focused(window, cx) {
            return;
        }
        let want = self.wanted_terminal(Slot::Main, cx);
        match want {
            Some(f) if !f.is_focused(window) => window.focus(&f, cx),
            Some(_) => {}
            None if !self.focus.is_focused(window) => window.focus(&self.focus, cx),
            None => {}
        }
    }

    fn set_layer(&mut self, layer: Option<(u64, u64, Node)>, cx: &mut Context<Self>) {
        let was = self.layer_up();
        let dialog = layer
            .as_ref()
            .is_some_and(|(_, _, n)| settings::is_dialog(n));
        if !dialog {
            self.bridge.set_settings(None);
            self.settings_fallback = false;
        } else if self.bridge.settings().is_none() {
            self.bridge.set_settings(Some(Default::default()));
        }
        // a dialog drawn anew tells its page's extent again: the layer that keeps it may be new
        if !matches!(&layer, Some((_, _, Node::CardDialog { .. }))) {
            self.dialog.forget_extent();
        }
        self.layer = layer;
        self.sweep_memory();
        self.awaiting_layer = false;
        self.sync_terms(cx);
        let mut shell = cx.try_global::<FactoryShell>().cloned().unwrap_or_default();
        if shell.settings != dialog {
            shell.settings = dialog;
            cx.set_global(shell);
        }
        if was != self.layer_up() {
            cx.emit(FactoryEvent::Layer(!was));
        }
        cx.notify();
    }

    /// The view shown from the Editor (⌘⌥A, `Factory ◆ N`'s click): the bridge started when it
    /// isn't, then its Factory overview opened again with `from: editor`, which lands it where
    /// TypeScript says (the oldest waiting run, else the last selection).
    pub fn shown_from_editor(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.start(window, cx);
        self.main_screen_is(FIRST_SCREEN, cx);
        // (a restart lands on the Board's selection: [`Self::landing`])
        self.bridge.open(
            Slot::Main,
            FIRST_SCREEN,
            [("from".to_owned(), "editor".to_owned())].into(),
        );
    }

    /// How far the card dialog `id`'s page scrolls as drawn: its keys scroll within it.
    pub fn send_extent(&mut self, id: String, lines: u32) {
        self.bridge.send(AppFrame::Extent {
            v: VERSION,
            id,
            lines,
        });
    }

    /// Sends what the person did on the main view to the bridge.
    pub fn send_input(&mut self, input: UserInput, cx: &mut Context<Self>) {
        self.send_slot_input(Slot::Main, input, cx);
    }

    /// The wheel over the Board: `id` scrolled by `delta`, `step` px a step on `axis`; whole
    /// steps go to the bridge as `scroll`.
    pub fn board_wheel(
        &mut self,
        slot: Slot,
        id: String,
        axis: board::Axis,
        delta: gpui_kit::ScrollDelta,
        step: f32,
        cx: &mut Context<Self>,
    ) {
        let n = self.wheel.steps(&id, axis, delta, step);
        if n == 0 {
            return;
        }
        let (x, y) = match axis {
            board::Axis::X => (n, 0),
            board::Axis::Y => (0, n),
        };
        self.send_slot_input(slot, UserInput::Scroll { id, x, y }, cx);
    }

    /// Sends what the person did in `slot` to the bridge (`input {slot}`).
    pub fn send_slot_input(&mut self, slot: Slot, input: UserInput, cx: &mut Context<Self>) {
        // the serve-down dialog's own buttons: Rust's, no bridge to tell
        if self.settings_fallback {
            if let UserInput::Click { id } = &input {
                match id.as_str() {
                    "settings:retry" => self.retry_bridge(cx),
                    "settings:close" => self.set_layer(None, cx),
                    _ => {}
                }
            }
            return;
        }
        let browse = matches!(&input, UserInput::Click { id } if settings::is_browse(id));
        self.bridge.send(AppFrame::Input {
            v: VERSION,
            input,
            slot: slot.named(),
        });
        if browse {
            self.choose_folder(cx);
        }
        // what was clicked was what is drawn; after it, or a key, the Board shows as it is
        if slot == Slot::Main {
            self.answer_input(cx);
            self.release_hold(cx);
        }
    }

    /// ⌃L: the jump told the bridge, with what had the keyboard; false without one running.
    /// What it opens comes back as a layer (Linked) or an effect (the Card page).
    pub fn jump(&mut self, to: protocol::JumpTo, from: protocol::JumpFrom) -> bool {
        self.bridge.send(AppFrame::Jump {
            v: VERSION,
            to,
            from,
        })
    }

    /// Where the keyboard is in this view's slots: the Factory view's body (or a terminal its
    /// tree holds), a slot's view (the Chat column's Chat), or none of them.
    pub fn keyboard_slot(&self, window: &Window, cx: &App) -> Option<Slot> {
        if self.focus.contains_focused(window, cx) {
            return Some(Slot::Main);
        }
        self.focused_slot
    }

    /// A terminal this view's trees hold has the keyboard (Chat's Terminal node, a PTY): ⌃L is
    /// its program's there.
    pub fn pty_focused(&self, window: &Window, cx: &App) -> bool {
        self.terms
            .views()
            .any(|t| t.read(cx).focus_handle().contains_focused(window, cx))
    }

    /// `:` from the Editor: Command mode asked of the bridge; false without one running.
    /// `:` to the bridge, `here` (the Editor's) just before it.
    pub fn open_command_mode(
        &mut self,
        here: Option<crate::factory::protocol::EditorHere>,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.bridge.up() {
            return false;
        }
        if let Some(here) = here {
            self.bridge.send(AppFrame::EditorHere { v: VERSION, here });
        }
        self.send_input(UserInput::Key { key: ":".into() }, cx);
        if self.layer.is_none() {
            self.awaiting_layer = true;
            // a bridge that answers `:` with no layer (an older one) never keeps the keyboard
            self._await = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(AWAIT_LAYER).await;
                let _ = this.update(cx, |v, cx| {
                    if v.awaiting_layer && v.layer.is_none() {
                        protocol::log_once("no-layer", "the bridge answered `:` with no layer");
                        v.set_layer(None, cx);
                    }
                });
            }));
        }
        true
    }

    /// The Settings dialog is up (or ⌘, asked for it).
    pub fn settings_open(&self) -> bool {
        self.bridge.settings().is_some()
    }

    /// ⌘, (and Open Settings anywhere): the Settings dialog, on `page` when given (a refusal's
    /// row: its page), over whichever view is shown. The bridge's when it runs (started here
    /// when it isn't); else the contract's serve-down tree, Retry starting the bridge again.
    pub fn open_settings(&mut self, page: Option<&str>, window: &Window, cx: &mut Context<Self>) {
        let params: std::collections::BTreeMap<String, String> = page
            .map(|p| [("page".to_owned(), p.to_owned())].into())
            .unwrap_or_default();
        // no `abe` 2.0 here: the dialog says serve is not answering, nothing is started
        if self.bridge.up() || BridgeCommand::available(cx) {
            self.start(window, cx);
        }
        if self.bridge.up() {
            self.settings_fallback = false;
            self.bridge.open_settings(params);
            if self.layer.is_none() {
                self.awaiting_layer = true;
                // a bridge that answers with no layer (an older one): the serve-down dialog
                self._await = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(AWAIT_LAYER).await;
                    let _ = this.update(cx, |v, cx| {
                        if v.awaiting_layer && v.layer.is_none() && v.settings_open() {
                            protocol::log_once(
                                "no-settings",
                                "the bridge answered `open settings` with no layer",
                            );
                            v.settings_without_bridge(cx);
                        }
                    });
                }));
            }
        } else {
            self.bridge.set_settings(Some(params));
            self.settings_without_bridge(cx);
        }
        cx.notify();
    }

    /// The dialog with no bridge: the contract's serve-down tree, keyed by Rust.
    fn settings_without_bridge(&mut self, cx: &mut Context<Self>) {
        let Some(tree) = settings::fallback() else {
            return;
        };
        let params = self.bridge.settings().cloned();
        self.set_layer(Some((self.bridge.generation(), 0, tree)), cx);
        self.bridge.set_settings(Some(params.unwrap_or_default()));
        self.settings_fallback = true;
    }

    /// A key on the serve-down dialog: Esc closes it, ⏎ (Retry) starts the bridge again.
    fn fallback_key(&mut self, key: &str, cx: &mut Context<Self>) {
        match settings::fallback_key(key) {
            settings::Fallback::Close => self.set_layer(None, cx),
            settings::Fallback::Retry => self.retry_bridge(cx),
            settings::Fallback::Nothing => {}
        }
    }

    /// Retry on the serve-down dialog: the bridge started anew, the dialog opened on it.
    fn retry_bridge(&mut self, cx: &mut Context<Self>) {
        if self.bridge.up() {
            return;
        }
        let command = self.bridge_command(cx);
        self.command = Some(command.clone());
        self.begin();
        let landing = self.landing();
        if let Err(why) = self.bridge.retry(|| Box::new(command), landing) {
            self.spawn_failed(why, cx);
        }
        cx.notify();
    }

    /// Keys Neovim held after the Editor's `:` (its typeahead), in nvim notation.
    pub fn type_keys(&mut self, keys: Vec<String>, cx: &mut Context<Self>) {
        for key in keys {
            self.send_input(UserInput::Key { key }, cx);
        }
    }

    /// A key the window hands over (the Settings dialog is modal: its keys wherever the keyboard
    /// went); the view has the keyboard first.
    pub fn key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.on_key_down(ev, window, cx);
    }

    fn on_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // a terminal has the keyboard: what it passed on is its IME's text
        if !self.focus.is_focused(window) {
            return;
        }
        let Some(key) = crate::kit::notation(ev) else {
            return;
        };
        // a page has the keyboard: its ⌘C / ⌘V / ⌘A are the page's (WebKit takes what GPUI
        // doesn't); ⌘⏎ stays the screen's
        if self
            .want_page
            .as_deref()
            .is_some_and(|k| self.browsers.focused(k))
            && key.starts_with("<D-")
            && key != "<D-CR>"
        {
            return;
        }
        cx.stop_propagation();
        if self.settings_fallback {
            self.fallback_key(&key, cx);
            return;
        }
        // ⌘C / ⌘A / Esc on selected text: copied, all of it, let go here (the Card page's
        // composer keeps its ⌘A and Esc); Settings' own while it is up
        let view = if self.settings_open() {
            self.settings_text.clone()
        } else {
            self.text.clone()
        };
        if (key == "<D-c>" || !self.card_composing()) && select::selection_key(&key, &view, cx) {
            cx.notify();
            return;
        }
        // any other key: the screen's, what was selected on it let go (Esc's anywhere: the Card
        // page's composer has it)
        if view.clear() || (key == "<Esc>" && select::let_go(cx)) {
            window.refresh();
        }
        // ⌘V: the clipboard's text, as text (the screen decides where it goes)
        if key == "<D-v>"
            && let Some(text) = cx.read_from_clipboard().and_then(|c| c.text())
        {
            self.send_input(UserInput::Text { text }, cx);
            return;
        }
        // the Run page's scroll keys move the step shown, here
        if !self.layer_up()
            && let Some((_, _, tree)) = self.trees.get(&Slot::Main)
            && run::scroll_key(&key, &self.memory, tree)
        {
            cx.notify();
            return;
        }
        // ⌘O on a Settings folder row: its Choose…, the system's folder panel
        if let Some((_, _, layer)) = &self.layer
            && let Some(id) = settings::browse_key(layer, &key)
        {
            self.send_input(UserInput::Click { id }, cx);
            return;
        }
        self.send_input(UserInput::Key { key }, cx);
    }

    /// Settings' Choose…: the system's folder panel, off the UI thread; its pick typed into the
    /// field the click opened and ⏎, or Esc when it is cancelled.
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Choose".into()),
        });
        cx.spawn(async move |this, cx| {
            let picked = rx
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .and_then(|p| p.into_iter().next());
            let _ = this.update(cx, |v, cx| match picked {
                Some(dir) => {
                    let text = dir.display().to_string();
                    v.send_input(UserInput::Text { text }, cx);
                    v.send_input(UserInput::Key { key: "<CR>".into() }, cx);
                }
                None => v.send_input(
                    UserInput::Key {
                        key: "<Esc>".into(),
                    },
                    cx,
                ),
            });
        })
        .detach();
    }

    /// The main screen's texts its selection holds in another order than they are laid out
    /// (tests: copying reads them in the order they were drawn).
    pub fn misordered_texts(&self) -> Vec<String> {
        self.text.misordered()
    }

    /// The Card page's composer has the keys (the main slot's page or the popup's).
    fn card_composing(&self) -> bool {
        [Slot::Popup, Slot::Main].iter().any(|slot| {
            matches!(
                self.trees.get(slot).map(|(_, _, n)| &**n),
                Some(Node::CardPage { props, .. }) if props.composer.focused
            )
        })
    }

    /// A layer is up, or `:` asked for one (it has the keyboard).
    pub fn layer_up(&self) -> bool {
        self.layer.is_some() || self.awaiting_layer
    }

    /// A layer is up with the keyboard: the view's own (its keys go to the layer) or the layer's
    /// terminal's.
    pub fn layer_has_keys(&self, window: &Window, cx: &App) -> bool {
        self.layer_up()
            && (self.focus.is_focused(window)
                || self
                    .wanted_terminal(Slot::Main, cx)
                    .is_some_and(|f| f.is_focused(window)))
    }

    /// The layer closes as when the keyboard leaves it, the bridge told (`blur`); the Settings
    /// dialog is modal: it stays (its changes staged) until closed.
    pub fn blur_layer(&mut self, cx: &mut Context<Self>) {
        if self.layer_up() && !self.settings_open() {
            self.send_input(UserInput::Blur, cx);
            self.set_layer(None, cx);
        }
    }

    /// What the last render drew, a transcript's in place (tests).
    pub fn drawn(&self) -> Drawn {
        self.drawn.merged()
    }

    /// The open screen's tree's rev, once one came.
    pub fn rev(&self) -> Option<u64> {
        self.trees.get(&Slot::Main).map(|(_, rev, _)| *rev)
    }

    /// What Chat is on.
    pub fn chat_target(&self) -> &ChatTarget {
        &self.chat_target
    }

    /// The `chat` screen's params as Chat's target says them now ([`chat_target::open_params`]).
    pub fn chat_open_params(&self, cx: &App) -> BTreeMap<String, String> {
        self.chat_params(cx)
    }

    /// The session Chat last said it is on (`chat-session`): None not said yet, `Some(None)` none.
    pub fn chat_session(&self) -> Option<Option<&str>> {
        self.chat_session.as_ref().map(Option::as_deref)
    }

    /// The session the Chat slot says it is on (`chat-session`). Another than the one it was on at
    /// the last quit, before that one: that one is gone, Chat opened as without it.
    pub(crate) fn set_chat_session(&mut self, session: Option<String>, cx: &mut Context<Self>) {
        if self.chat_target.chat_said(session.as_deref()) {
            self.reopen_chat(cx);
        }
        self.chat_session = Some(session);
    }

    /// A terminal let go at once (`drop-terminal`), even while a tree holds it.
    pub(crate) fn drop_terminal(&mut self, key: &str, cx: &mut Context<Self>) {
        self.terms.drop_key(key, cx);
        cx.notify();
    }

    /// The screen's `selected`: its card and the session Chat pins with its context.
    pub(crate) fn selected_said(
        &mut self,
        card: Option<u64>,
        owner: Option<String>,
        title: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.select(card.map(|card| Selected { card, owner, title }), cx);
    }

    /// How many times the bridge was started (1, or 2 after its restart).
    pub fn starts(&self) -> u64 {
        self.bridge.generation()
    }

    pub fn stopped(&self) -> Option<&str> {
        self.bridge.stopped()
    }
}

impl FactoryView {
    /// The top layer over the view: the Settings dialog centred in the whole window, the others
    /// in the view ([`layers::over`]).
    fn over(
        &self,
        layer: &Node,
        size: (f32, f32),
        drawn: &mut Drawn,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let v = window.viewport_size();
        let viewport = (f32::from(v.width), f32::from(v.height));
        // the view starts under the toolbar in the projects window, at the top on its own
        let top = if self.chrome_height > 0. {
            look::TOOLBAR_HEIGHT.get()
        } else {
            0.
        };
        // its texts select as the screen's do, in a selection of its own
        if settings::is_dialog(layer) {
            let text = self.settings_text.clone();
            text.begin();
            return Some(select::drawing_in(&text, || {
                settings::over(layer, viewport, top, &text, drawn, cx)
            }));
        }
        // Linked: Search Everywhere's place, 48 px from the top of the window
        if let Node::LinkedLayer { props, .. } = layer {
            return Some(linked::over(props, viewport, top, drawn));
        }
        layers::over(layer, size, &self.dialog, drawn, window, cx)
    }
}

impl Focusable for FactoryView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FactoryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.bridge.started() {
            let size = self.board_size_in(window);
            self.bridge.want_size(size);
        }
        let size = {
            let s = self.size_in(window);
            (s.width, s.height)
        };
        self.place_focus(window, cx);
        // what is shown and whether the window is in front, as this frame draws them
        self.window_active = crate::editor::window_active(window);
        self.tell_window();
        let focused =
            self.focus.contains_focused(window, cx) && crate::editor::window_active(window);
        // the bridge hears what this frame draws, not only what focus events said: none come in
        // a window that is not active, a shot's (one thing has the keys)
        if (self.focused_slot == Some(Slot::Main)) != (focused && self.shown) {
            self.slot_focus(Slot::Main, focused && self.shown, cx);
        }
        // the keyboard moved while a layer was up (not told then): told once it is down
        if !self.layer_up() && self.bridge.focus() != self.focused_slot {
            cx.defer_in(window, |v, _, _| v.tell_focus());
        }
        // a native page is drawn over everything GPUI draws: none while a layer is up
        let pages_shown = self.shown
            && !self.layer_up()
            && !self.covered
            && !self.popup_open()
            && self.bridge.stopped().is_none();
        if !pages_shown {
            self.browsers.hide_all();
        }
        if !self.shown {
            // over the Editor: only the layer
            let mut drawn = Drawn {
                focused,
                sink: Some(draw::Sink {
                    view: cx.weak_entity(),
                    slot: Slot::Main,
                    focus: Some(self.focus.clone()),
                }),
                memory: self.memory.clone(),
                ..Drawn::default()
            };
            let el = self
                .layer
                .as_ref()
                .and_then(|(_, _, n)| self.over(n, size, &mut drawn, window, cx));
            self.drawn = drawn;
            return div()
                .id("factory")
                .debug_selector(|| "factory-layer-host".into())
                .key_context("Factory")
                .track_focus(&self.focus)
                .on_key_down(cx.listener(Self::on_key_down))
                .relative()
                .size_full()
                .font_family(crate::render::UI_FONT)
                .text_size(px(look::UI_FONT_SIZE))
                .text_color(look::TEXT)
                .children(el);
        }
        let shown = match (self.bridge.stopped(), self.trees.get(&Slot::Main)) {
            (Some(why), _) => std::rc::Rc::new(placeholder("abe ui bridge stopped", why)),
            (None, Some((_, _, tree))) => tree.clone(),
            (None, None) => std::rc::Rc::new(placeholder(
                "Starting abe ui bridge",
                "Abe's screens show once it answers.",
            )),
        };
        let mut drawn = Drawn {
            focused,
            terms: self.term_views(cx),
            pages: self.browsers.slots(),
            pages_shown,
            sink: Some(draw::Sink {
                view: cx.weak_entity(),
                slot: Slot::Main,
                focus: Some(self.focus.clone()),
            }),
            memory: self.memory.clone(),
            tree: Some(shown.clone()),
            ..Drawn::default()
        };
        // the Card page is the whole main slot, its markdown laid out for the window; the
        // screen's texts take part in its selection
        let text = self.text.clone();
        text.begin();
        let content = select::drawing_in(&text, || match &*shown {
            Node::CardPage { id, props } => dialog::card_page(
                id.as_deref(),
                props,
                &self.page,
                size,
                &mut drawn,
                window,
                cx,
            ),
            _ => draw::root(&shown, &mut drawn, cx),
        });
        // the Board's card popup over it, its words in the same selection
        let popup = match self.trees.get(&Slot::Popup).map(|(_, _, n)| &**n) {
            Some(Node::CardPage { id, props }) => Some(select::drawing_in(&text, || {
                dialog::card_popup(
                    id.as_deref(),
                    props,
                    &self.page,
                    size,
                    &mut drawn,
                    window,
                    cx,
                )
            })),
            _ => None,
        };
        let selects = !self.layer_up();
        let over = self
            .layer
            .as_ref()
            .and_then(|(_, _, n)| self.over(n, size, &mut drawn, window, cx));
        self.drawn = drawn;
        div()
            .id("factory")
            .debug_selector(|| "factory-view".into())
            .key_context("Factory")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_move(cx.listener(|v, _: &gpui_kit::MouseMoveEvent, _, cx| {
                if !v.pointer_in {
                    v.pointer(true, cx);
                }
            }))
            .on_hover(cx.listener(|v, hovered: &bool, window, cx| {
                let inside = v
                    .drawn_at
                    .get()
                    .is_some_and(|b| b.contains(&window.mouse_position()));
                if !*hovered && !inside {
                    v.pointer(false, cx);
                }
            }))
            .relative()
            .size_full()
            .child({
                let at = self.drawn_at.clone();
                gpui_kit::canvas(move |b, _, _| at.set(Some(b)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
            })
            .when(selects, |d| select::region(d, &text))
            .child(content)
            .children(popup)
            .child(select::settled(&text))
            .children(over)
    }
}

/// The BrowserView nodes of a tree, in order.
fn browser_views(n: &Node, out: &mut Vec<protocol::BrowserViewProps>) {
    if let Node::BrowserView { props, .. } = n {
        out.push(props.clone());
    }
    for c in n.children() {
        browser_views(c, out);
    }
}

/// An island with one Empty: what shows while there is no tree.
fn placeholder(title: &str, line: &str) -> Node {
    Node::Island {
        id: None,
        children: vec![Node::Empty {
            id: None,
            props: protocol::EmptyProps {
                title: title.into(),
                line: line.into(),
                head: false,
                actions: Vec::new(),
            },
        }],
    }
}
