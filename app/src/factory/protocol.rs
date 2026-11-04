//! `abe ui bridge`'s frames and the component tree, as serde types: the Rust half of
//! `abe/packages/ui/src/runtime/{components,protocol}.ts` (schema: `abe/packages/ui/contract/schema.json`).
//! A kind this build doesn't know decodes as [`Node::Unknown`] (drawn as `needs component: <kind>`),
//! so a newer bridge never breaks the frame; any other bad frame is logged once.

use std::collections::HashSet;

use parking_lot::Mutex;

use super::board::{BoardCardProps, BoardHeaderProps, ColumnProps, ColumnsProps};
use super::chat::{ChatHeaderProps, TerminalProps};
use serde::de::Error as _;
use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// The contract version both sides speak (`UI_CONTRACT`): 2 since a slot's tree can come as a
/// keyed patch of the one before ([`Patch`]).
pub const VERSION: u32 = 2;

/// A status hue (5-states.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Hue {
    Good,
    Warn,
    NeedsYou,
    Bad,
    Accent,
    Dim,
}

/// A child's size along its Stack: its content's, fixed px, a share of the rest, or its
/// content's up to a part of the Stack (`fit`, 0–1).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Size {
    Fixed {
        fixed: f32,
    },
    Flex {
        flex: f32,
    },
    Fit {
        fit: f32,
    },
    /// `"auto"` (any other word reads as auto too).
    Auto(#[serde(deserialize_with = "word")] ()),
}

fn word<'de, D: Deserializer<'de>>(d: D) -> Result<(), D::Error> {
    String::deserialize(d).map(|_| ())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    #[default]
    Column,
}

/// Across a Stack's direction: centred (a row's default) or stretched to the Stack.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Center,
    Stretch,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct StackProps {
    #[serde(default)]
    pub direction: Direction,
    #[serde(default)]
    pub gap: f32,
    #[serde(default)]
    pub sizes: Vec<Size>,
    #[serde(default)]
    pub align: Align,
    /// px inside: top, right, bottom, left.
    pub pad: Option<[f32; 4]>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Tab {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct HeaderProps {
    pub title: String,
    pub count: Option<u64>,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    pub selected: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RowState {
    #[default]
    Default,
    Selected,
    SelectedInactive,
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
pub struct RowProps {
    pub text: String,
    pub dim: Option<String>,
    pub note: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub state: RowState,
    pub reason: Option<String>,
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BadgeProps {
    pub text: String,
    pub hue: Hue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HintContext {
    Row,
    Footer,
    Button,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct KeyHintProps {
    pub keys: String,
    pub label: Option<String>,
    pub context: HintContext,
    #[serde(default)]
    pub dim: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentState {
    Starting,
    Running,
    NeedsYou,
    Idle,
    Ready,
    Failed,
    Ended,
    Merged,
    OnTest,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct AgentProps {
    pub state: AgentState,
    pub word: String,
    /// Why (Failed): dim, after the word.
    pub reason: Option<String>,
    pub connection: Option<String>,
    pub env: Option<String>,
    pub dot: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct EmptyProps {
    pub title: String,
    pub line: String,
    /// Abe's head (32 px) above the title (W-NoSession).
    #[serde(default)]
    pub head: bool,
    /// One row centred under the title: the primary a button, the rest dim key hints.
    #[serde(default)]
    pub actions: Vec<EmptyAction>,
}

/// An Empty's way on (`components.ts` `EmptyAction`): a click names its id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct EmptyAction {
    pub id: String,
    pub label: String,
    pub keys: String,
    #[serde(default)]
    pub primary: bool,
}

/// A pick's row (`layers.ts` `PickRow`): a `reason` greys it out; `separator` draws a line above;
/// `risky` draws its title and key in bad (Terminate…).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PickRow {
    pub id: String,
    pub text: String,
    pub dim: Option<String>,
    pub note: Option<String>,
    pub reason: Option<String>,
    #[serde(default)]
    pub separator: bool,
    #[serde(default)]
    pub risky: bool,
    /// A group's dim heading above the row (Command mode's groups).
    pub section: Option<String>,
    /// Dim, monospace, in a column of its own before the text (Held writes' `09:41`).
    pub lead: Option<String>,
}

/// A pick's window over its rows (`layers.ts` `scroll`): the first shown's index, how many.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct PickScroll {
    pub top: usize,
    pub total: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickState {
    Loading,
    Error,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PickProps {
    pub title: String,
    /// The filter row's text; None: no filter row.
    pub filter: Option<String>,
    /// The filter's caret in characters; None: at its end.
    pub caret: Option<usize>,
    /// The filter's dim words while nothing is typed.
    pub placeholder: Option<String>,
    pub rows: Vec<PickRow>,
    pub selected: Option<String>,
    /// More rows than shown: where the window is, for the scrollbar.
    pub scroll: Option<PickScroll>,
    pub state: Option<PickState>,
    pub message: Option<String>,
    pub hint: Option<String>,
    /// Dim after the title (`demo-shop · nothing left this Mac`).
    pub caption: Option<String>,
    /// 820 px wide, not 480: a list whose rows say a lot (Held writes).
    #[serde(default)]
    pub wide: bool,
    /// The house mark before the title, in the path hue (local mode).
    #[serde(default)]
    pub local: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PromptProps {
    pub title: String,
    pub text: String,
    /// The text's caret in characters; None: at its end.
    pub caret: Option<usize>,
    pub hint: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Risky {
    pub label: String,
    pub letter: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConfirmFocus {
    Risky,
    #[default]
    No,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ConfirmProps {
    pub question: String,
    #[serde(default)]
    pub details: Vec<String>,
    pub risky: Risky,
    pub no: Option<String>,
    #[serde(default)]
    pub danger: bool,
    #[serde(default)]
    pub focus: ConfirmFocus,
}

/// A card dialog's section: its heading (a dim note after it) and its markdown.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DialogSection {
    pub title: String,
    pub note: Option<String>,
    pub markdown: String,
}

/// A dialog's footer button: its key at 70 % after the label; a `reason` greys it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DialogButton {
    pub id: String,
    pub label: String,
    pub keys: Option<String>,
    #[serde(default)]
    pub primary: bool,
    pub reason: Option<String>,
}

/// The card dialog (`layers.ts` `CardDialog`, DS StoryTab).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardDialogProps {
    pub kicker: String,
    pub card: u64,
    pub state: String,
    pub title: String,
    #[serde(default)]
    pub meta: Vec<String>,
    /// The story look's facts line word by word in its colours, drawn for `meta` when
    /// given.
    #[serde(default)]
    pub facts: Vec<DialogFact>,
    #[serde(default)]
    pub sections: Vec<DialogSection>,
    /// Lines scrolled down; kept within the page.
    #[serde(default)]
    pub scroll: u32,
    #[serde(default)]
    pub buttons: Vec<DialogButton>,
    /// The card's Sheets section, once the screen gives one.
    #[serde(default)]
    pub sheets: Option<DialogSheets>,
    /// The story look (board F-Story): this dim cap and a close button over `#id`
    /// and the title, `meta` as the facts line; no kicker row or state badge.
    #[serde(default)]
    pub heading: Option<String>,
    /// The Linked block at the dialog's end: a chip per row (Run · Session · PR · Box).
    #[serde(default)]
    pub linked: Vec<DialogLink>,
    /// Dim words before the footer's buttons (`⌘⏎ more`); a click on them is `dialog:menu`.
    #[serde(default)]
    pub hint: Option<String>,
    /// Why the last write was refused (New card's): red on the footer's left, for the
    /// primary's grey reason.
    #[serde(default)]
    pub error: Option<String>,
    /// The story look's Comments after the sections: the card's thread oldest first.
    #[serde(default)]
    pub comments: Option<super::comment::Thread>,
    /// The button the keys are on (← → Tab), drawn as the default; none: the primary.
    #[serde(default)]
    pub focus: Option<String>,
}

/// The Card page (`layers.ts` `CardPage`, the `card` screen): the card dialog's look as a page
/// filling the main slot, with the comment composer over its footer.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct CardPageProps {
    #[serde(flatten)]
    pub dialog: CardDialogProps,
    pub composer: PageComposer,
}

/// The Card page's comment composer: the draft with its caret where the bridge says, the
/// placeholder while empty; `focused` the keys are in it; a post going (`posting`: Sending…) or
/// refused (`failed`, why in `error`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PageComposer {
    pub text: String,
    pub caret: Option<usize>,
    pub placeholder: String,
    #[serde(default)]
    pub focused: bool,
    pub state: super::comment::BoxState,
    pub error: Option<String>,
}

/// One word of the story's facts line: dim with no `tone`, a dim `label` before it (`tags`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DialogFact {
    pub text: String,
    pub tone: Option<FactTone>,
    pub label: Option<String>,
}

/// A fact's colour (F-Story): `--abe-bug`, `--abe-story`, `--abe-points`, `--abe-tags`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FactTone {
    Bug,
    Story,
    Points,
    Tags,
}

/// One chip of the dialog's Linked block: `label words state`, the state (`● Running`) in `hue`,
/// else the words; a `dim` chip is not there yet and takes no click, any other names its `id`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DialogLink {
    pub id: String,
    pub label: String,
    pub words: String,
    pub state: Option<String>,
    pub hue: Option<Hue>,
    #[serde(default)]
    pub dim: bool,
}

/// The card dialog's Sheets: its rows, or loading / why not; the row the keys are on.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct DialogSheets {
    #[serde(default)]
    pub rows: Vec<SheetRow>,
    pub state: Option<PickState>,
    pub message: Option<String>,
    pub selected: Option<String>,
    /// The keys are in the rows.
    #[serde(default)]
    pub focused: bool,
}

/// One of a card's Sheets: a click names its id.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SheetRow {
    pub id: String,
    pub title: String,
    pub dim: Option<String>,
}

/// A BrowserView's ⌘⏎ note: its keys and words.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BrowserAction {
    pub keys: String,
    pub label: String,
}

/// A BrowserView (`browser.ts`): the page [`crate::factory::pages`] keeps per key, under its bar.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BrowserViewProps {
    pub key: String,
    pub url: String,
    pub title: String,
    pub sub: Option<String>,
    pub address: Option<String>,
    pub version: Option<u32>,
    #[serde(default)]
    pub badges: Vec<String>,
    pub action: Option<BrowserAction>,
    #[serde(default)]
    pub focused: bool,
    /// `sheet` (its URL alone, the default) or `app` (its origin: a prototype's proxy).
    #[serde(default)]
    pub mode: crate::factory::pages::Mode,
    /// No bar drawn: the Prototype page draws its own URL bar over it.
    #[serde(default)]
    pub bare: bool,
    /// A change loads the same URL again (the Preview's reload).
    #[serde(default)]
    pub reload: u64,
}

/// One node of the closed set (`components.ts`), or a kind this build doesn't draw.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Island {
        id: Option<String>,
        children: Vec<Node>,
    },
    Stack {
        id: Option<String>,
        props: StackProps,
        children: Vec<Node>,
    },
    ToolWindowHeader {
        id: Option<String>,
        props: HeaderProps,
    },
    ListRow {
        id: Option<String>,
        props: RowProps,
        children: Vec<Node>,
    },
    Badge {
        id: Option<String>,
        props: BadgeProps,
    },
    KeyHint {
        id: Option<String>,
        props: KeyHintProps,
    },
    AgentStatus {
        id: Option<String>,
        props: AgentProps,
    },
    Empty {
        id: Option<String>,
        props: EmptyProps,
    },
    BoardHeader {
        id: Option<String>,
        props: BoardHeaderProps,
    },
    BoardColumns {
        id: Option<String>,
        props: ColumnsProps,
        children: Vec<Node>,
    },
    BoardColumn {
        id: Option<String>,
        props: ColumnProps,
        children: Vec<Node>,
    },
    BoardCard {
        id: Option<String>,
        props: BoardCardProps,
    },
    /// The layers (`layers.ts`): sent as the bridge's `layer` frame, drawn over the view.
    PickLayer {
        id: Option<String>,
        props: PickProps,
    },
    PromptLayer {
        id: Option<String>,
        props: PromptProps,
    },
    ConfirmLayer {
        id: Option<String>,
        props: ConfirmProps,
    },
    CardDialog {
        id: Option<String>,
        props: CardDialogProps,
    },
    /// A card's comment box: a layer, Command mode's.
    CommentBox {
        id: Option<String>,
        props: super::comment::CommentBoxProps,
    },
    /// The Launch box: a layer, Command mode's.
    LaunchBox {
        id: Option<String>,
        props: super::launch::LaunchBoxProps,
    },
    /// The Card page: the `card` screen's tree, the main slot's whole page.
    CardPage {
        id: Option<String>,
        props: Box<CardPageProps>,
    },
    /// Chat's (`terminal.ts`): a program in a PTY the shell keeps per key, and the header over it.
    Terminal {
        id: Option<String>,
        props: TerminalProps,
    },
    ChatHeader {
        id: Option<String>,
        /// Boxed: 2.1's header made it the set's largest.
        props: Box<ChatHeaderProps>,
    },
    /// A web page drawn natively over its slot (`browser.ts`).
    BrowserView {
        id: Option<String>,
        props: BrowserViewProps,
    },
    /// The rendered Chat's parts (`chat-components.ts`): one variant for the set, its
    /// kind in [`super::transcript::Part`]; a Transcript's and a Turn's parts are `children`.
    ChatPart {
        id: Option<String>,
        part: Box<super::transcript::Part>,
        children: Vec<Node>,
    },
    /// Chat's cards (`cards.ts`): one variant for the set, its kind in
    /// [`super::cards::Card`]; a GrillRound's cards are `children`.
    Card {
        id: Option<String>,
        card: Box<super::cards::Card>,
        children: Vec<Node>,
    },
    /// Chat's composer (`composer.ts`): one variant for the set, its kind in
    /// [`super::composer::Part`]; a Composer's chip and menu are `children`.
    Composer {
        id: Option<String>,
        part: Box<super::composer::Part>,
        children: Vec<Node>,
    },
    /// The Settings dialog's components (`settings-components.ts`): one variant for
    /// the set, its kind in [`super::settings::Part`]; a dialog's, page's and group's children.
    Settings {
        id: Option<String>,
        part: Box<super::settings::Part>,
        children: Vec<Node>,
    },
    /// A header of columns over rows of cells (`Table`: Sessions, Boxes).
    Table {
        id: Option<String>,
        props: Box<super::table::TableProps>,
    },
    /// ⌃L's Linked popup (`linked-layer.ts`): a layer, Command mode's.
    LinkedLayer {
        id: Option<String>,
        props: Box<super::linked::LinkedProps>,
    },
    /// The Git Log's PR review (`review-components.ts`): the Git tool window draws it, never a
    /// generic slot.
    ReviewPane {
        id: Option<String>,
        props: Box<super::review::ReviewPaneProps>,
    },
    /// The Pipelines tab's components (`pipeline-components.ts`): one variant for the set, its
    /// kind in [`super::pipelines::Part`].
    Pipeline {
        id: Option<String>,
        part: Box<super::pipelines::Part>,
    },
    /// Local mode's band over the Board (`local-components.ts`).
    LocalBand {
        id: Option<String>,
        props: super::local::BandProps,
    },
    /// A local pull request (`#L3`) in the Board's place.
    LocalPullRequest {
        id: Option<String>,
        props: Box<super::local::PullRequestProps>,
    },
    /// The Run place's components (`run-components.ts`): one variant for the set, its
    /// kind in [`super::run::Part`].
    Run {
        id: Option<String>,
        part: Box<super::run::Part>,
    },
    /// The install's strip atop its Chat (`install-parts.ts`): one variant for the set,
    /// its kind in [`super::install::Part`].
    Install {
        id: Option<String>,
        part: Box<super::install::Part>,
    },
    /// A prototype's page (`prototype-components.ts`): Preview, Code or Logs; its BrowserView
    /// (the live app) is its child.
    PrototypePage {
        id: Option<String>,
        props: Box<super::prototype::Props>,
        children: Vec<Node>,
    },
    /// A kind outside this build's set: drawn as a dim `needs component: <kind>` box.
    Unknown { kind: String, id: Option<String> },
}

/// The kinds this build draws (`KINDS` in `components.ts`).
pub const KINDS: &[&str] = &[
    "Island",
    "Stack",
    "ToolWindowHeader",
    "ListRow",
    "Badge",
    "KeyHint",
    "AgentStatus",
    "Empty",
    "BoardHeader",
    "BoardColumns",
    "BoardColumn",
    "BoardCard",
    "PickLayer",
    "PromptLayer",
    "ConfirmLayer",
    "CardDialog",
    "CommentBox",
    "LaunchBox",
    "CardPage",
    "Terminal",
    "ChatHeader",
    "BrowserView",
    // the rendered Chat's parts (`super::transcript::KINDS`)
    "Transcript",
    "Turn",
    "ChatMessage",
    "ChangesBar",
    "DiffCard",
    "StepRow",
    "StepsFold",
    "Prose",
    "StageDivider",
    "NewBelow",
    "QueuedMessage",
    // the Settings dialog's (`super::settings::KINDS`)
    "SettingsDialog",
    "SettingsTree",
    "SettingsPage",
    "SettingsGroup",
    "SettingRow",
    "ProblemRow",
    "SettingsNote",
    "SettingsEmpty",
    "SettingsPropose",
    "CheckRow",
    "SettingsFix",
    "Table",
    // Chat's cards (`super::cards::KINDS`)
    "QuestionCard",
    "CardLine",
    "GrillRound",
    "OverrideCard",
    "DeferredPill",
    // Chat's composer (`super::composer::KINDS`)
    "Composer",
    "ContextChip",
    "SlashMenu",
    "AttachChip",
    "ChatStatus",
    "LinkedLayer",
    // the Git Log's PR review (`super::review`)
    "ReviewPane",
    // the Pipelines tab's (`super::pipelines::KINDS`)
    "PipelinesBar",
    "RunSummary",
    "RunHead",
    "RunGraph",
    "JobPanel",
    "JobLog",
    // local mode's (`super::local`)
    "LocalBand",
    "LocalPullRequest",
    // the Run place's (`super::run::KINDS`)
    "RunBar",
    "RunSteps",
    "RunFocus",
    "RunSpecPane",
    // the install's strip (`super::install::KINDS`)
    "InstallParts",
    // a prototype's page (`super::prototype`)
    "PrototypePage",
];

impl Node {
    pub fn kind(&self) -> &str {
        match self {
            Node::Island { .. } => "Island",
            Node::Stack { .. } => "Stack",
            Node::ToolWindowHeader { .. } => "ToolWindowHeader",
            Node::ListRow { .. } => "ListRow",
            Node::Badge { .. } => "Badge",
            Node::KeyHint { .. } => "KeyHint",
            Node::AgentStatus { .. } => "AgentStatus",
            Node::Empty { .. } => "Empty",
            Node::BoardHeader { .. } => "BoardHeader",
            Node::BoardColumns { .. } => "BoardColumns",
            Node::BoardColumn { .. } => "BoardColumn",
            Node::BoardCard { .. } => "BoardCard",
            Node::PickLayer { .. } => "PickLayer",
            Node::PromptLayer { .. } => "PromptLayer",
            Node::ConfirmLayer { .. } => "ConfirmLayer",
            Node::CardDialog { .. } => "CardDialog",
            Node::CommentBox { .. } => "CommentBox",
            Node::LaunchBox { .. } => "LaunchBox",
            Node::CardPage { .. } => "CardPage",
            Node::Terminal { .. } => "Terminal",
            Node::ChatHeader { .. } => "ChatHeader",
            Node::BrowserView { .. } => "BrowserView",
            Node::ChatPart { part, .. } => part.kind(),
            Node::Card { card, .. } => card.kind(),
            Node::Composer { part, .. } => part.kind(),
            Node::Settings { part, .. } => part.kind(),
            Node::Table { .. } => "Table",
            Node::LinkedLayer { .. } => "LinkedLayer",
            Node::ReviewPane { .. } => "ReviewPane",
            Node::Pipeline { part, .. } => part.kind(),
            Node::LocalBand { .. } => "LocalBand",
            Node::LocalPullRequest { .. } => "LocalPullRequest",
            Node::Run { part, .. } => part.kind(),
            Node::Install { part, .. } => part.kind(),
            Node::PrototypePage { .. } => "PrototypePage",
            Node::Unknown { kind, .. } => kind,
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Node::Island { id, .. }
            | Node::Stack { id, .. }
            | Node::ToolWindowHeader { id, .. }
            | Node::ListRow { id, .. }
            | Node::Badge { id, .. }
            | Node::KeyHint { id, .. }
            | Node::AgentStatus { id, .. }
            | Node::Empty { id, .. }
            | Node::BoardHeader { id, .. }
            | Node::BoardColumns { id, .. }
            | Node::BoardColumn { id, .. }
            | Node::BoardCard { id, .. }
            | Node::PickLayer { id, .. }
            | Node::PromptLayer { id, .. }
            | Node::ConfirmLayer { id, .. }
            | Node::CardDialog { id, .. }
            | Node::CommentBox { id, .. }
            | Node::LaunchBox { id, .. }
            | Node::CardPage { id, .. }
            | Node::Terminal { id, .. }
            | Node::ChatHeader { id, .. }
            | Node::BrowserView { id, .. }
            | Node::ChatPart { id, .. }
            | Node::Card { id, .. }
            | Node::Composer { id, .. }
            | Node::Settings { id, .. }
            | Node::Table { id, .. }
            | Node::LinkedLayer { id, .. }
            | Node::ReviewPane { id, .. }
            | Node::Pipeline { id, .. }
            | Node::LocalBand { id, .. }
            | Node::LocalPullRequest { id, .. }
            | Node::Run { id, .. }
            | Node::Install { id, .. }
            | Node::PrototypePage { id, .. }
            | Node::Unknown { id, .. } => id.as_deref(),
        }
    }

    pub fn children(&self) -> &[Node] {
        match self {
            Node::Island { children, .. }
            | Node::Stack { children, .. }
            | Node::ListRow { children, .. }
            | Node::BoardColumns { children, .. }
            | Node::BoardColumn { children, .. }
            | Node::ChatPart { children, .. }
            | Node::Card { children, .. }
            | Node::Composer { children, .. }
            | Node::Settings { children, .. }
            | Node::PrototypePage { children, .. } => children,
            _ => &[],
        }
    }

    /// Its children to change in place; None for a kind that has none ([`Self::children`]).
    pub fn children_mut(&mut self) -> Option<&mut Vec<Node>> {
        match self {
            Node::Island { children, .. }
            | Node::Stack { children, .. }
            | Node::ListRow { children, .. }
            | Node::BoardColumns { children, .. }
            | Node::BoardColumn { children, .. }
            | Node::ChatPart { children, .. }
            | Node::Card { children, .. }
            | Node::Composer { children, .. }
            | Node::Settings { children, .. }
            | Node::PrototypePage { children, .. } => Some(children),
            _ => None,
        }
    }
}

/// A node's own fields as they come, in any order: `kind` first (the bridge writes it first)
/// lets `props` decode straight into its kind's type; `props` before `kind` is held as a
/// [`Value`] until the kind is known. `children` decode as nodes in place: no node's subtree is
/// ever held as a `Value` (that was a copy per level, O(depth × size)).
impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(NodeVisitor)
    }
}

/// A node's keys; any other is skipped.
#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "lowercase")]
enum NodeKey {
    Kind,
    Id,
    Props,
    Children,
    #[serde(other)]
    Other,
}

struct NodeVisitor;

impl<'de> serde::de::Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a component node")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut kind: Option<String> = None;
        let mut id: Option<String> = None;
        let mut children: Vec<Node> = Vec::new();
        let mut node: Option<Node> = None;
        let mut held: Option<Value> = None;
        while let Some(key) = map.next_key::<NodeKey>()? {
            match key {
                NodeKey::Kind => kind = Some(map.next_value()?),
                NodeKey::Id => id = map.next_value()?,
                NodeKey::Children => children = map.next_value()?,
                NodeKey::Props => match &kind {
                    Some(k) => node = Some(map.next_value_seed(KindSeed(k))?),
                    None => held = Some(map.next_value()?),
                },
                NodeKey::Other => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let kind = kind.ok_or_else(|| A::Error::custom("a node without a kind"))?;
        let mut node = match node {
            Some(n) => n,
            None => decode_kind(&kind, held.unwrap_or(Value::Null)).map_err(A::Error::custom)?,
        };
        node.fill(id, children);
        Ok(node)
    }
}

/// `props` decoded as its kind's.
struct KindSeed<'a>(&'a str);

impl<'de> serde::de::DeserializeSeed<'de> for KindSeed<'_> {
    type Value = Node;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Node, D::Error> {
        decode_kind(self.0, d)
    }
}

/// The node of `kind` from its `props`, without its id and children yet ([`Node::fill`]).
fn decode_kind<'de, D: Deserializer<'de>>(kind: &str, props: D) -> Result<Node, D::Error> {
    Ok(match kind {
        "Island" => {
            IgnoredAny::deserialize(props)?;
            Node::Island {
                id: None,
                children: Vec::new(),
            }
        }
        "Stack" => Node::Stack {
            id: None,
            props: Deserialize::deserialize(props)?,
            children: Vec::new(),
        },
        "ToolWindowHeader" => Node::ToolWindowHeader {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "ListRow" => Node::ListRow {
            id: None,
            props: Deserialize::deserialize(props)?,
            children: Vec::new(),
        },
        "Badge" => Node::Badge {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "KeyHint" => Node::KeyHint {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "AgentStatus" => Node::AgentStatus {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "Empty" => Node::Empty {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "BoardHeader" => Node::BoardHeader {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "BoardColumns" => Node::BoardColumns {
            id: None,
            props: Deserialize::deserialize(props)?,
            children: Vec::new(),
        },
        "BoardColumn" => Node::BoardColumn {
            id: None,
            props: Deserialize::deserialize(props)?,
            children: Vec::new(),
        },
        "BoardCard" => Node::BoardCard {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "PickLayer" => Node::PickLayer {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "PromptLayer" => Node::PromptLayer {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "ConfirmLayer" => Node::ConfirmLayer {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "CardDialog" => Node::CardDialog {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "CommentBox" => Node::CommentBox {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "LaunchBox" => Node::LaunchBox {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "CardPage" => Node::CardPage {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "Terminal" => Node::Terminal {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "ChatHeader" => Node::ChatHeader {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "BrowserView" => Node::BrowserView {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "PrototypePage" => Node::PrototypePage {
            id: None,
            props: Box::new(Deserialize::deserialize(props)?),
            children: Vec::new(),
        },
        "Table" => Node::Table {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "LinkedLayer" => Node::LinkedLayer {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "ReviewPane" => Node::ReviewPane {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "LocalBand" => Node::LocalBand {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        "LocalPullRequest" => Node::LocalPullRequest {
            id: None,
            props: Deserialize::deserialize(props)?,
        },
        k if super::install::KINDS.contains(&k) => Node::Install {
            id: None,
            part: Box::new(super::install::Part::decode(k, props)?),
        },
        k if super::run::KINDS.contains(&k) => Node::Run {
            id: None,
            part: Box::new(super::run::Part::decode(k, props)?),
        },
        k if super::pipelines::KINDS.contains(&k) => Node::Pipeline {
            id: None,
            part: Box::new(super::pipelines::Part::decode(k, props)?),
        },
        k if super::composer::KINDS.contains(&k) => Node::Composer {
            id: None,
            part: Box::new(super::composer::Part::decode(k, props)?),
            children: Vec::new(),
        },
        k if super::cards::KINDS.contains(&k) => Node::Card {
            id: None,
            card: Box::new(super::cards::Card::decode(k, props)?),
            children: Vec::new(),
        },
        k if super::transcript::KINDS.contains(&k) => Node::ChatPart {
            id: None,
            part: Box::new(super::transcript::Part::decode(k, props)?),
            children: Vec::new(),
        },
        k if super::settings::KINDS.contains(&k) => Node::Settings {
            id: None,
            part: Box::new(super::settings::Part::decode(k, props)?),
            children: Vec::new(),
        },
        _ => {
            IgnoredAny::deserialize(props)?;
            Node::Unknown {
                id: None,
                kind: kind.to_owned(),
            }
        }
    })
}

impl Node {
    /// The id and children decoded beside the props (a kind without children drops them).
    fn fill(&mut self, new_id: Option<String>, new_children: Vec<Node>) {
        match self {
            Node::Island { id, .. }
            | Node::Stack { id, .. }
            | Node::ToolWindowHeader { id, .. }
            | Node::ListRow { id, .. }
            | Node::Badge { id, .. }
            | Node::KeyHint { id, .. }
            | Node::AgentStatus { id, .. }
            | Node::Empty { id, .. }
            | Node::BoardHeader { id, .. }
            | Node::BoardColumns { id, .. }
            | Node::BoardColumn { id, .. }
            | Node::BoardCard { id, .. }
            | Node::PickLayer { id, .. }
            | Node::PromptLayer { id, .. }
            | Node::ConfirmLayer { id, .. }
            | Node::CardDialog { id, .. }
            | Node::CommentBox { id, .. }
            | Node::LaunchBox { id, .. }
            | Node::CardPage { id, .. }
            | Node::Terminal { id, .. }
            | Node::ChatHeader { id, .. }
            | Node::BrowserView { id, .. }
            | Node::ChatPart { id, .. }
            | Node::Card { id, .. }
            | Node::Composer { id, .. }
            | Node::Settings { id, .. }
            | Node::Table { id, .. }
            | Node::LinkedLayer { id, .. }
            | Node::ReviewPane { id, .. }
            | Node::Pipeline { id, .. }
            | Node::LocalBand { id, .. }
            | Node::LocalPullRequest { id, .. }
            | Node::Run { id, .. }
            | Node::Install { id, .. }
            | Node::PrototypePage { id, .. }
            | Node::Unknown { id, .. } => *id = new_id,
        }
        match self {
            Node::Island { children, .. }
            | Node::Stack { children, .. }
            | Node::ListRow { children, .. }
            | Node::BoardColumns { children, .. }
            | Node::BoardColumn { children, .. }
            | Node::ChatPart { children, .. }
            | Node::Card { children, .. }
            | Node::Composer { children, .. }
            | Node::Settings { children, .. }
            | Node::PrototypePage { children, .. } => *children = new_children,
            _ => {}
        }
    }
}

/// A status bar widget; a click on it is a `click` on `widget:<id>`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Widget {
    pub id: String,
    pub text: String,
    pub hue: Option<Hue>,
    /// A box's cloud before the words (the boxes widget): the accent while one runs, dim
    /// asleep; in the widget's hue when it has one.
    #[serde(default)]
    pub cloud: Option<CloudState>,
    /// Said on hover.
    #[serde(default)]
    pub tooltip: Option<String>,
    /// Shown only while this view is (none: on both).
    #[serde(default)]
    pub view: Option<ViewName>,
    /// Where on the status bar: beside the mode badge, or at the right (the default).
    #[serde(default)]
    pub place: WidgetPlace,
}

/// A stripe item's group: the top one's places, the bottom one's tool windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StripeGroup {
    Top,
    Bottom,
}

/// A stripe dot: news, never a count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StripeDot {
    NeedsYou,
    Failed,
    Running,
}

/// One item of the stripe (the bridge's `stripe.ts`): WebStorm's tool window stripe at the
/// window's left edge. A click on it is the bridge's `click` on `widget:stripe:<id>` too.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StripeItem {
    pub id: String,
    pub label: String,
    /// The icon's name (`project`, `board`, `run-path`, `history`, `archive`, `run`,
    /// `preview`, `terminal`, `vcs`).
    pub icon: String,
    pub group: StripeGroup,
    /// Only inside a workspace (Run, Terminal, Git): left out on the Board.
    #[serde(default)]
    pub workspace_only: bool,
    /// Hidden by your View tweak (the menu unticks it).
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub dot: Option<StripeDot>,
    /// Its name, key and what its dot means.
    pub tooltip: String,
}

/// Settings, the toolbar's gear: its tooltip, a dot while it lists problems.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct StripeGear {
    pub tooltip: String,
    #[serde(default)]
    pub dot: Option<StripeDot>,
}

/// One stripe item's dot from another screen than the Board's (Pipelines', once its runs were
/// read); none clears it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct StripeDotOf {
    pub id: String,
    #[serde(default)]
    pub dot: Option<StripeDot>,
    #[serde(default)]
    pub words: Option<String>,
}

/// A widget's place on the status bar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WidgetPlace {
    /// Beside the mode badge, at the left.
    Start,
    #[default]
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewName {
    Editor,
    Factory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Info,
    Warning,
    Error,
}

/// The window's own actions Command mode's Anywhere rows run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppAction {
    /// Search Everywhere's All tab (⇧⇧).
    SearchEverywhere,
    /// Recent Projects (⌘⇧O).
    RecentProjects,
    /// Open… (Welcome's ⌘O): a folder picked and opened as a project.
    Open,
    /// New Project… (Welcome): a new folder named, made and opened as a project.
    NewProject,
    /// `:workflows`: the Project tree on the repo's `abe/workflows/`, open and selected.
    Workflows,
}

/// Something only the shell can do.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ShellEffect {
    View {
        view: ViewName,
    },
    /// A folder as a project; with `attach`, a cloud session's workspace. `chat`: ⌃W's
    /// landing, the Chat column shown beside it and the keyboard in its last split.
    OpenProject {
        path: String,
        #[serde(default)]
        attach: Option<crate::shell::remote::Attach>,
        #[serde(default)]
        chat: bool,
        /// Welcome's ⏎ on a card: the project shown in the Factory view on this card.
        #[serde(default)]
        card: Option<u64>,
    },
    /// The Chat column, or the bottom pane on one of its tabs, shown; the keyboard stays where
    /// it is (Linked's Sessions, Pipelines and Box rows).
    Show {
        place: ShowPlace,
    },
    /// A stripe item opened as its click opens it (Command mode's Go to).
    #[serde(rename = "stripe-open")]
    StripeOpen {
        id: String,
    },
    /// Sessions ⏎ on a card's session: its workspace at `path` on the page it last had, when
    /// open and shown before; else the Factory view on `card` (the bridge pins Chat itself).
    /// `browse` (the selection moved onto a row): after a short rest, any open workspace at
    /// `path` on its page, Chat pinned on `session`, the keys staying in the Sessions list.
    /// `page` (⏎ on a Board card): the workspace opened or shown on that page (`code`, `run`,
    /// `terminal`, `git`, `card`).
    WorkspacePage {
        path: String,
        #[serde(default)]
        card: Option<u64>,
        #[serde(default)]
        session: Option<String>,
        #[serde(default)]
        browse: bool,
        #[serde(default)]
        page: Option<String>,
    },
    /// A new Terminal mode tab in the shown workspace's Chat column running `argv` (`abe`: the
    /// bridge's own), named `title`, with the keyboard (⏎ on a box attaches to it).
    TerminalTab {
        argv: Vec<String>,
        title: String,
    },
    /// The session the Chat slot's `chat` screen is pinned to, unless it ended: the
    /// Editor's Terminal mode has a pinned first tab **Claude Code** on it, the screen's
    /// `mode: terminal` Terminal; None: no such tab. Whole-state, said on every `open` too.
    ChatSession {
        session: Option<String>,
    },
    /// A balloon (the bridge's `errors.ts`): an error fades after its reading time or at
    /// the next key or click, unless it `stays` (it needs you).
    Balloon {
        tone: Tone,
        text: String,
        /// What it is about: the same key again replaces it, `drop-balloon` closes it.
        #[serde(default)]
        key: Option<String>,
        /// It needs you: it stays until closed, its action taken or its cause gone.
        #[serde(default)]
        stays: bool,
        /// Its action's link (`Log in…`, `Retry`): a click is the bridge's `balloon:<key>`.
        #[serde(default)]
        action: Option<String>,
        /// Where it was said (the screen), for the error history.
        #[serde(default, rename = "where")]
        said_in: Option<String>,
    },
    /// The balloon with this key closes now: its cause is gone.
    DropBalloon {
        key: String,
    },
    /// A repo moved on this Mac (Abe followed it): Recent Projects names it at `to`, not `from`.
    RepoMoved {
        from: String,
        to: String,
    },
    Widgets {
        widgets: Vec<Widget>,
    },
    /// The stripe's items, the whole set in order, and Settings' gear.
    Stripe {
        items: Vec<StripeItem>,
        gear: StripeGear,
    },
    /// One stripe item's dot (Pipelines').
    StripeDot {
        #[serde(flatten)]
        dot: StripeDotOf,
    },
    /// One line on the status line; empty clears it.
    Status {
        text: String,
    },
    /// `text` on the clipboard (the transcript's `y`).
    Clipboard {
        text: String,
    },
    /// Neovim's own command line (`::`).
    Cmdline,
    /// `Run in Neovim`: the Editor shown, `text` run on Neovim's own command line.
    Ex {
        text: String,
    },
    /// One of the Editor caret's context menu items chosen in `:`: Lua runs item `index`
    /// of the ones it sent with the `:`.
    EditorItem {
        index: u32,
    },
    /// One of the window's own actions (`:`'s Anywhere rows).
    App {
        action: AppAction,
    },
    /// Welcome's Remove from list: the project leaves the recent list.
    ForgetProject {
        path: String,
    },
    /// Welcome's own chrome: the Dock badge's ◆ count (0: none), the status bar's board
    /// crumb (empty: none).
    Welcome {
        #[serde(rename = "needsYou")]
        needs_you: u32,
        crumb: String,
        /// The page shown: `board`, `projects`, `sessions` or `boxes`, the stripe's pick.
        #[serde(default)]
        page: Option<String>,
    },
    /// Welcome's Clone…: `git clone <url>` into `~/projects/<name>`, then opened.
    CloneProject {
        url: String,
    },
    /// The terminal under this key dropped now ([`super::terminal`]).
    DropTerminal {
        key: String,
    },
    /// Open this URL in the browser (a card on Azure Boards).
    OpenUrl {
        url: String,
    },
    /// A prototype's tile, on its Preview (Board's Prototype…, New prototype…'s answer).
    OpenPrototype {
        id: String,
    },
    /// The Run bar's expand: as ⌥⌘⏎ on the main area, maximized or back.
    Expand,
    /// A file opened in the Editor. Without a line, in the shown project's (Linked's Spec: the
    /// spec the run wrote); with one (absolute, 1-based), in the workspace holding it at that line
    /// (⏎ on a Chat diff card, Open all).
    OpenFile {
        path: String,
        #[serde(default)]
        line: Option<u64>,
    },
    /// The header's one feed (`workspaces.ts`): every story workspace's look, the Factory
    /// view's line, whether `serve` answers. Kept whole in [`super::workspaces::WorkspaceFeed`].
    Workspaces {
        workspaces: Vec<WorkspaceLook>,
        factory: FactoryLine,
        answering: bool,
        /// The main checkouts whose Abe chat waits on you (the Abe tile's teal dot).
        #[serde(default, rename = "abeNeedsYou")]
        abe_needs_you: Vec<String>,
        /// Every prototype not done with: a tile each in the rail's workspace group.
        #[serde(default)]
        prototypes: Vec<PrototypeLook>,
    },
    /// Give this slot the keyboard (⏎ on a Sessions row, Chat on its session).
    Focus {
        slot: Slot,
    },
    /// The Factory view's selected card: Chat opens on it while the Factory view is
    /// shown, at once in Chat mode, once it rested ([`super::CARD_REST`]) in Terminal mode;
    /// `owner` names a teammate whose card it is (Chat read-only), `title` is the card's title as
    /// the Board has it (Chat's header names it with its body). Whole-state.
    Selected {
        card: Option<u64>,
        owner: Option<String>,
        title: Option<String>,
    },
    /// A key this slot's screen did not take (Esc with nothing of its own open, so the
    /// Chat column gives the keyboard back to the code).
    Unhandled {
        slot: Slot,
        key: String,
    },
    /// What the window draws with: the theme's tokens, the density, the fonts
    /// ([`crate::look::apply`]). Whole-state.
    Look {
        look: crate::look::Look,
    },
    /// The Feel's behaviour switches in force; kept in [`super::feel::Feel`].
    Feel {
        feel: super::feel::Feel,
    },
    /// The PR review's ⏎: VimStorm's diff viewer on `files` at `index` (1-based), `base` left,
    /// `head` right, scrolled to `line`, in the checkout at `root`.
    ShowDiff {
        root: String,
        files: Vec<super::review::DiffFile>,
        index: usize,
        base: String,
        head: String,
        line: u32,
        pr: super::review::DiffPr,
    },
    /// The answer to the diff's `,i` key, as a balloon in the diff of the review at `root`.
    ReviewSaid {
        root: String,
        text: String,
        tone: super::review::Tone,
    },
    /// The PR picked in the Git Log was checked out at `path` (or not: `unchecked` says why, the
    /// main checkout): open it as a project and review PR `number` there.
    ReviewOpen {
        path: String,
        repo: String,
        number: u64,
        unchecked: Option<String>,
    },
    /// The Git Log's `PR ⌄` pick for the checkout at `root`: its repo's open PRs.
    PrPick {
        root: String,
        repo: String,
        rows: Vec<super::review::PickRow>,
    },
}

/// What a `show` effect shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShowPlace {
    Chat,
    Sessions,
    Boxes,
    Pipelines,
    /// The bottom panel's Git (the Editor's `:` row, as ⌘3).
    Git,
}

/// Where a jump goes: the linked story's workspace, the story (no key either), Linked (⌃L).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JumpTo {
    Workspace,
    Story,
    Linked,
}

/// What had the keyboard when a jump key was pressed: a slot's screen, or a
/// surface of the shown workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JumpPlace {
    Main,
    Chat,
    Pane,
    Editor,
    Tree,
    Git,
    Toolbar,
    Other,
}

impl From<Slot> for JumpPlace {
    fn from(slot: Slot) -> Self {
        match slot {
            Slot::Main | Slot::Popup => JumpPlace::Main,
            Slot::Chat => JumpPlace::Chat,
            Slot::Pane => JumpPlace::Pane,
            Slot::Review => JumpPlace::Git,
        }
    }
}

/// A jump's `from`: the place, and the view shown (on the Factory view what is not a slot's is
/// the Board's).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct JumpFrom {
    pub place: JumpPlace,
    pub view: ViewName,
}

/// Where a workspace's story stands, as its tab's dot says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceState {
    Idle,
    Running,
    NeedsYou,
    Done,
    Failed,
    Starting,
}

/// A box's cloud: filled while it runs, an outline asleep, dashed while it starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudState {
    Running,
    Asleep,
    Starting,
}

/// One badge of a context line: words in a hue (its wash at 16 %), a box's cloud before them.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Chip {
    pub text: String,
    pub hue: Hue,
    #[serde(default)]
    pub cloud: Option<CloudState>,
    /// A click on it names this id (else the line's `toolbar:linked`).
    #[serde(default)]
    pub id: Option<String>,
    /// Local mode's badge: dashed in the path hue with the house mark, `hue` unused.
    #[serde(default)]
    pub local: bool,
}

/// A run of words in a line; a state mark's in its hue (else dim).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Span {
    pub text: String,
    #[serde(default)]
    pub hue: Option<Hue>,
}

/// A state's mark in its hue.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Dot {
    pub mark: String,
    pub hue: Hue,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Story {
    pub id: u64,
    pub short: String,
    pub title: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Checks {
    None,
    Pending,
    Success,
    Failure,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct WorkspacePr {
    pub n: u64,
    pub checks: Checks,
}

/// Where a prototype's app stands (`workspaces.ts` `PrototypeLook.state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrototypeState {
    Running,
    Starting,
    Failed,
    Stopped,
}

impl PrototypeState {
    /// Its word, as the header and the hover say it.
    pub fn word(self) -> &'static str {
        match self {
            PrototypeState::Running => "Running",
            PrototypeState::Starting => "Starting",
            PrototypeState::Failed => "Failed",
            PrototypeState::Stopped => "Stopped",
        }
    }
}

/// One prototype as the rail draws its tile (`workspaces.ts` `PrototypeLook`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrototypeLook {
    pub id: String,
    /// Its words, or its card's title.
    pub title: String,
    pub card: Option<u64>,
    pub state: PrototypeState,
    pub session: Option<String>,
    pub branch: String,
    /// `Local`, `☁ demo-shop-1`.
    #[serde(rename = "where")]
    pub place: String,
    pub since: String,
    pub url: Option<String>,
    #[serde(default)]
    pub needs_you: bool,
}

/// One story workspace as the header draws it (`workspaces.ts` `WorkspaceLook`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct WorkspaceLook {
    /// A local workspace's folder (the session's worktree).
    pub root: String,
    /// A cloud workspace's box: its attached project matches by it.
    #[serde(default, rename = "box")]
    pub box_: Option<String>,
    pub story: Story,
    pub state: WorkspaceState,
    /// The tab's dot and its hue (the selected tab's tint too).
    pub dot: Dot,
    pub stage: Option<String>,
    pub rail: Vec<super::board::Segment>,
    pub since: String,
    pub cloud: Option<CloudState>,
    /// The cloud's hue (accent, dim asleep); None for a local one.
    #[serde(rename = "cloudHue")]
    pub cloud_hue: Option<Hue>,
    pub pr: Option<WorkspacePr>,
    pub branch: String,
    /// The strip tab's words and hover.
    pub tab: String,
    pub tooltip: String,
    /// The toolbar's context line (badges) and how it reads whole.
    pub line: Vec<Chip>,
    pub label: String,
    /// The status bar's first crumb.
    pub crumb: String,
    /// The empty editor's line under Abe's face.
    pub caption: Vec<Span>,
    /// Its box runs and its workspace is being built there: the launch's step as Chat
    /// says it. RemoteState waits on it, no attach try spent, until it is gone.
    #[serde(default)]
    pub building: Option<String>,
}

/// The Factory view's context line, its whole reading, the status bar's crumb.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct FactoryLine {
    pub line: Vec<Chip>,
    pub label: String,
    pub crumb: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// Where a screen is mounted: the Factory view's body, the Chat column, the bottom pane's
/// tab, the popup over the body. One screen per slot; a frame naming none is about [`Slot::Main`].
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    #[default]
    Main,
    Chat,
    Pane,
    /// The Git Log's PR review: its pane the Git tool window draws.
    Review,
    /// A screen over main's, centred, main dimmed behind it (a Board card's Card page): main's
    /// keys and clicks are its while it is open (the bridge's); `closed` takes it away.
    Popup,
}

impl Slot {
    /// `None` for [`Slot::Main`]: a frame about main names no slot (as before slots).
    pub fn named(self) -> Option<Slot> {
        (self != Slot::Main).then_some(self)
    }
}

/// The Editor's caret: its file relative to the shown project's folder, its 1-based line,
/// the selected lines while there is a selection.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Caret {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Lines>,
}

/// Where the Editor's keys are when its `:` is pressed (`config/app/colon.lua`): Neovim's
/// Ex command names, the caret, the caret's context menu items.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct EditorHere {
    #[serde(default)]
    pub ex: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caret: Option<Caret>,
    #[serde(default)]
    pub items: Vec<EditorItem>,
}

/// One item of the caret's context menu: its label, its shortcut, grey when it can't run now.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct EditorItem {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default = "enabled", skip_serializing_if = "is_enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

fn is_enabled(on: &bool) -> bool {
    *on
}

/// Selected lines, 1-based, `from` ≤ `to`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Lines {
    pub from: u32,
    pub to: u32,
}

/// Bridge → app ([`read_line`]).
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeFrame {
    /// A slot's screen's tree (`slot` absent: main's).
    Tree {
        v: u32,
        screen: String,
        rev: u64,
        tree: Node,
        slot: Option<Slot>,
    },
    /// The popup slot's screen closed: drawn no more.
    Closed {
        v: u32,
        slot: Slot,
    },
    /// The top layer over whatever view is shown; None: no layer.
    Layer {
        v: u32,
        rev: u64,
        tree: Option<Node>,
    },
    Shell {
        v: u32,
        effect: ShellEffect,
    },
    /// The `--json` document a `run` frame's command answered (`{ok, data}` or `{ok, error}`).
    Answer {
        v: u32,
        id: String,
        reply: Value,
    },
    Error {
        v: u32,
        error: ErrorBody,
    },
}

/// Logical px of the view the screen fills.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewSize {
    pub width: f32,
    pub height: f32,
}

/// What the person did on a drawn screen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UserInput {
    /// A key in nvim notation (`r`, `<CR>`, `<D-CR>`).
    Key {
        key: String,
    },
    /// A click on the node (or header tab) with this id.
    Click {
        id: String,
    },
    Text {
        text: String,
    },
    /// The slot's own text field (Chat's composer) typed or its caret moved: its whole text, this
    /// change's number, counting up, and the caret in characters (None: at the end).
    Draft {
        text: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caret: Option<usize>,
    },
    /// Files pasted or dropped on the composer (a pasted image saved to a file first).
    Attach {
        paths: Vec<String>,
    },
    /// The view lost the keyboard while a layer was up: the layer closes.
    Blur,
    /// The wheel or the trackpad over the node `id`, in whole steps: `y` down (+) or up
    /// (−), `x` right (+) or left (−) ([`super::board::Wheels`] counts them).
    Scroll {
        id: String,
        x: i32,
        y: i32,
    },
    /// What the PR review's diff keys, strip and files pane ask (the `review` slot's).
    Review {
        ask: super::review::ReviewAsk,
    },
}

/// App → bridge.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AppFrame {
    /// `root`: the shown project's folder, where the screens' commands run.
    Hello {
        v: u32,
        size: ViewSize,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    /// Another project is shown: its folder; its box when it is a cloud workspace (root then the
    /// last local folder), the branch checked out there.
    Project {
        v: u32,
        root: String,
        #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
        box_: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    /// Open a screen in a slot (None: main).
    Open {
        v: u32,
        screen: String,
        #[serde(default)]
        params: std::collections::BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slot: Option<Slot>,
    },
    /// Close the popup slot's screen (the Board left): main's has the keys again.
    Close { v: u32, slot: Slot },
    Input {
        v: u32,
        input: UserInput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slot: Option<Slot>,
    },
    Resize {
        v: u32,
        size: ViewSize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slot: Option<Slot>,
    },
    /// Which slot has the keyboard (None: none of them).
    Focus { v: u32, slot: Option<Slot> },
    /// The view the window shows and whether it is the active window: while the Factory
    /// view is shown the bridge keeps outside data fresh, and looks at once as the window comes
    /// to the front.
    Window {
        v: u32,
        view: ViewName,
        active: bool,
        /// The stripe's place in the main area (Command mode's Go to leaves it out).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        place: Option<String>,
    },
    /// The Editor's caret moved (debounced): the Chat slot's implicit context.
    Caret {
        v: u32,
        #[serde(flatten)]
        caret: Caret,
    },
    /// No file open in the Editor: the Chat slot's implicit context clears.
    #[serde(rename = "no-caret")]
    NoCaret { v: u32 },
    /// `:` in the Editor, just before its `:` key: what `config/app/colon.lua` said of it
    /// (Neovim's Ex command names, the caret, its context menu's items), handed on as it is.
    #[serde(rename = "editor-here")]
    EditorHere {
        v: u32,
        #[serde(flatten)]
        here: EditorHere,
    },
    /// How far the card dialog with this node id scrolls as drawn, in `l` / `ö` steps.
    Extent { v: u32, id: String, lines: u32 },
    /// A Terminal's program exited: its key, its exit code (None: a signal).
    Exit {
        v: u32,
        key: String,
        code: Option<i32>,
    },
    /// A BrowserView's page told something (`loaded`, `blocked`, `focus`, `failed`).
    Browser {
        v: u32,
        key: String,
        event: crate::factory::pages::BrowserEvent,
    },
    /// ⌃L (or ⌃⌥L) pressed: never sent from an nvim split or a PTY for the plain key.
    Jump { v: u32, to: JumpTo, from: JumpFrom },
    /// `abe <argv> --json` run for the shell itself (Create Draft PR), answered by `answer`.
    Run {
        v: u32,
        id: String,
        argv: Vec<String>,
    },
    /// A slot's patch could not be applied (its base is not the tree held): the bridge forgets
    /// what it sent there and sends the whole tree next.
    Again { v: u32, slot: Slot },
}

impl AppFrame {
    /// The frame as the one JSON line the bridge reads.
    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// A frame's `type`, read first: a tree's and a layer's then decode straight from the line (a
/// tagged enum would copy the whole frame into serde's buffer before its tree decoded).
#[derive(Deserialize)]
struct Head<'a> {
    #[serde(rename = "type", borrow)]
    kind: std::borrow::Cow<'a, str>,
}

#[derive(Deserialize)]
struct TreeBody {
    v: u32,
    screen: String,
    rev: u64,
    tree: Node,
    #[serde(default)]
    slot: Option<Slot>,
}

#[derive(Deserialize)]
struct LayerBody {
    v: u32,
    rev: u64,
    tree: Option<Node>,
}

/// The frames without a tree.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Small {
    Closed { v: u32, slot: Slot },
    Shell { v: u32, effect: ShellEffect },
    Answer { v: u32, id: String, reply: Value },
    Error { v: u32, error: ErrorBody },
}

// ---------------------------------------------------------------- patches

/// A tree the patch ops change in place: the typed [`Node`] the window draws, or the
/// [`Value`] the drive socket's tap keeps.
pub trait Patchable: Sized {
    /// Its children; None when it has none to index (a kind this build gives no children).
    fn kids(&mut self) -> Option<&mut Vec<Self>>;
}

impl Patchable for Node {
    fn kids(&mut self) -> Option<&mut Vec<Node>> {
        self.children_mut()
    }
}

impl Patchable for Value {
    fn kids(&mut self) -> Option<&mut Vec<Value>> {
        let node = self.as_object_mut()?;
        node.entry("children")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
    }
}

/// One change of a patch, at `path` (indexes into `children` from the root, as the ops before it
/// left the tree; `[]` the root): the node there replaced, or its children spliced.
#[derive(Clone, Debug, PartialEq)]
pub enum Op<N> {
    Replace {
        path: Vec<usize>,
        node: N,
    },
    /// `remove` children from `from` taken out, `add` put there.
    Splice {
        path: Vec<usize>,
        from: usize,
        remove: usize,
        add: Vec<N>,
    },
}

/// An op as it comes: `{path, node}` or `{path, splice: [from, remove], add}`.
#[derive(Deserialize)]
#[serde(bound = "N: Deserialize<'de>")]
struct RawOp<N> {
    path: Vec<usize>,
    #[serde(default)]
    node: Option<N>,
    #[serde(default)]
    splice: Option<(usize, usize)>,
    #[serde(default = "Vec::new")]
    add: Vec<N>,
}

impl<'de, N: Deserialize<'de>> Deserialize<'de> for Op<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = RawOp::<N>::deserialize(d)?;
        match (raw.node, raw.splice) {
            (Some(node), None) => Ok(Op::Replace {
                path: raw.path,
                node,
            }),
            (None, Some((from, remove))) => Ok(Op::Splice {
                path: raw.path,
                from,
                remove,
                add: raw.add,
            }),
            _ => Err(D::Error::custom("an op is a node or a splice")),
        }
    }
}

/// A slot's tree as a keyed patch of the one before (`type: patch`): `base` is the rev of the
/// frame that last set that slot's tree; only the ops' nodes are decoded.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(bound = "N: Deserialize<'de>")]
pub struct Patch<N> {
    pub v: u32,
    pub screen: String,
    pub rev: u64,
    pub base: u64,
    #[serde(default)]
    pub slot: Option<Slot>,
    pub ops: Vec<Op<N>>,
}

/// `ops` applied to `root` in order. Err (the tree half changed: drop it) when a path or a
/// splice is outside the tree.
pub fn apply<N: Patchable>(root: &mut N, ops: Vec<Op<N>>) -> Result<(), String> {
    fn at<'a, N: Patchable>(root: &'a mut N, path: &[usize]) -> Result<&'a mut N, String> {
        let mut node = root;
        for (depth, &i) in path.iter().enumerate() {
            node = node
                .kids()
                .and_then(|kids| kids.get_mut(i))
                .ok_or_else(|| format!("no child {i} at depth {depth} of {path:?}"))?;
        }
        Ok(node)
    }
    for op in ops {
        match op {
            Op::Replace { path, node } => *at(root, &path)? = node,
            Op::Splice {
                path,
                from,
                remove,
                add,
            } => {
                let kids = at(root, &path)?
                    .kids()
                    .ok_or_else(|| format!("no children at {path:?}"))?;
                let to = from
                    .checked_add(remove)
                    .filter(|to| *to <= kids.len())
                    .ok_or_else(|| {
                        format!("splice {from}+{remove} past {} children", kids.len())
                    })?;
                kids.splice(from..to, add);
            }
        }
    }
    Ok(())
}

/// A bridge line: a frame, or a slot's patch (the reader thread applies it, [`super::bridge`]).
#[derive(Debug)]
pub enum Said {
    Frame(Box<BridgeFrame>),
    Patch(Patch<Node>),
}

/// A line from the bridge as a frame or a patch; a bad one is logged once per reason and gives
/// None.
pub fn read_said(line: &str) -> Option<Said> {
    let decoded = match serde_json::from_str::<Head>(line) {
        Ok(head) if head.kind == "patch" => serde_json::from_str(line).map(Said::Patch),
        Ok(_) => decode_frame(line).map(|f| Said::Frame(Box::new(f))),
        Err(e) => Err(e),
    };
    match decoded {
        Ok(said) => Some(said),
        Err(e) => {
            log_once("frame", &format!("bad bridge frame ({e}): {line}"));
            None
        }
    }
}

fn decode_frame(line: &str) -> serde_json::Result<BridgeFrame> {
    let head: Head = serde_json::from_str(line)?;
    Ok(match head.kind.as_ref() {
        "tree" => {
            let t: TreeBody = serde_json::from_str(line)?;
            BridgeFrame::Tree {
                v: t.v,
                screen: t.screen,
                rev: t.rev,
                tree: t.tree,
                slot: t.slot,
            }
        }
        "layer" => {
            let l: LayerBody = serde_json::from_str(line)?;
            BridgeFrame::Layer {
                v: l.v,
                rev: l.rev,
                tree: l.tree,
            }
        }
        _ => match serde_json::from_str(line)? {
            Small::Closed { v, slot } => BridgeFrame::Closed { v, slot },
            Small::Shell { v, effect } => BridgeFrame::Shell { v, effect },
            Small::Answer { v, id, reply } => BridgeFrame::Answer { v, id, reply },
            Small::Error { v, error } => BridgeFrame::Error { v, error },
        },
    })
}

/// A line from the bridge as a frame; a bad one is logged once per reason and gives None.
pub fn read_line(line: &str) -> Option<BridgeFrame> {
    match decode_frame(line) {
        Ok(frame) => Some(frame),
        Err(e) => {
            log_once("frame", &format!("bad bridge frame ({e}): {line}"));
            None
        }
    }
}

/// Logs `what` to stderr once per `key` (never a flood).
pub fn log_once(key: &str, what: &str) {
    static SEEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let mut seen = SEEN.lock();
    if seen.get_or_insert_with(HashSet::new).insert(key.to_owned()) {
        eprintln!("[vimstorm] factory: {what}");
    }
}
