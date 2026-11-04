/**
 * `abe ui bridge`'s frames: newline-delimited JSON on stdio, one frame per line, `v` 2
 * (`UI_CONTRACT`). The app (VimStorm) writes `AppFrame`s to the bridge's stdin and reads
 * `BridgeFrame`s from its stdout; a frame with any other `v` is answered `unsupported-version`, a
 * line that is no frame `bad-request`.
 */
import { z } from 'zod';
import { BrowserEvent } from './browser';
import { FeelSwitches } from './feel';
import { Look } from './shell-look';
import { Hue, Node, NodeId, UI_CONTRACT } from './components';
import { PatchOp } from './patch';
import { CLOUD_STATES } from '../live';
import { FactoryLine, WorkspaceLook } from '../board/workspaces';
import { PrPickRow, ReviewAsk } from '../review/review-asks';

const v = z.literal(UI_CONTRACT);

/**
 * Where a screen is mounted (#119): `main` the Factory view's body, `chat` the Chat column beside
 * the Editor (and the Factory view), `pane` the bottom pane's tab, `review` the Git Log's PR
 * review (its strip and files pane, which VimStorm's Git tool window draws), `popup` a screen
 * over `main`'s, centred, `main` dimmed behind it (a Board card's Card page): while it is open
 * `main`'s keys and clicks are its, and an `open` in `main` closes it. One mounted screen per
 * slot; a frame without `slot` is about `main`.
 */
export const SLOTS = ['main', 'chat', 'pane', 'review', 'popup'] as const;
export const Slot = z.enum(SLOTS);
export type Slot = z.infer<typeof Slot>;

/**
 * The Editor's caret (#119): its file relative to the shown project's folder, its 1-based line,
 * and the selected lines while there is a selection. The Chat slot's implicit context.
 */
export const Caret = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().positive(),
  selection: z
    .strictObject({ from: z.number().int().positive(), to: z.number().int().positive() })
    .optional(),
});
export type Caret = z.infer<typeof Caret>;

/**
 * What the Editor says of itself before its `:` (#346, `config/app/colon.lua`): Neovim's Ex
 * command names, the caret, its context menu's items (`enabled: false` grey).
 */
export const EditorHereData = z.strictObject({
  ex: z.array(z.string()),
  caret: Caret.optional(),
  items: z.array(
    z.strictObject({
      text: z.string(),
      key: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  ),
});
export type EditorHereData = z.infer<typeof EditorHereData>;

/** Logical px of the view the screen fills. */
export const ViewSize = z.strictObject({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type ViewSize = z.infer<typeof ViewSize>;

/**
 * A status bar widget: its words in a hue. A click on it is a `click` on `widget:<id>`, sent to
 * the open screen whichever view is shown.
 */
export const Widget = z.strictObject({
  id: NodeId,
  text: z.string(),
  hue: Hue.optional(),
  /**
   * A box's cloud before the words (#104's `☁ 3 boxes`): filled in the accent while a box runs,
   * an outline dim when all sleep; in the widget's hue when it has one.
   */
  cloud: z.enum(CLOUD_STATES).optional(),
  /** Said on hover. */
  tooltip: z.string().optional(),
  /** Shown only while this view is (absent: on both). */
  view: z.enum(['editor', 'factory']).optional(),
  /** `start`: beside the mode badge at the status bar's left; `end` (the default): at its right. */
  place: z.enum(['start', 'end']).optional(),
});
export type Widget = z.infer<typeof Widget>;

/** A stripe item's group (#20): the top one's places, the bottom one's tool windows. */
export const StripeGroup = z.enum(['top', 'bottom']);
export type StripeGroup = z.infer<typeof StripeGroup>;

/** A stripe dot: news, never a count (needs you teal, failed red, running amber). */
export const StripeDot = z.enum(['needs-you', 'failed', 'running']);
export type StripeDot = z.infer<typeof StripeDot>;

/**
 * One item of the stripe (#20, `stripe.ts`): WebStorm's tool window stripe at the window's left
 * edge. A click is a `click` on `widget:stripe:<id>` too (the shell opens it itself). `hidden`
 * and the group it is in are your View tweaks; `workspaceOnly` ones (Run, Terminal, Git) leave the
 * stripe outside a workspace (the Board).
 */
export const StripeItem = z.strictObject({
  id: NodeId,
  label: z.string().min(1),
  /** The icon's name as the shell draws it: `project`, `board`, `book`, `run-path`, `history`, … */
  icon: z.string().min(1),
  group: StripeGroup,
  workspaceOnly: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  /** Its key (`⌘5`), for the menu; the tooltip says it too. */
  key: z.string().min(1).optional(),
  dot: StripeDot.optional(),
  /** Its name, key and what its dot means: `Sessions · ⌘5 · 1 needs you · 2 running`. */
  tooltip: z.string().min(1),
});
export type StripeItem = z.infer<typeof StripeItem>;

/** Settings, the toolbar's gear (#20): its tooltip, a dot while it lists problems. */
export const StripeGear = z.strictObject({
  tooltip: z.string().min(1),
  dot: StripeDot.optional(),
});
export type StripeGear = z.infer<typeof StripeGear>;

/** One stripe item's dot from the screen that read it (Pipelines'): none clears it. */
export const StripeDotEffect = z.strictObject({
  kind: z.literal('stripe-dot'),
  id: NodeId,
  dot: StripeDot.optional(),
  /** The dot in words, for the tooltip. */
  words: z.string().optional(),
});
export type StripeDotEffect = z.infer<typeof StripeDotEffect>;

/** A workspace's pages, its header's ⌃1 … ⌃3: the code (its bottom panel: Terminal · Git · Problems), Run, the card. */
export const WORKSPACE_PAGES = ['code', 'run', 'card'] as const;
export type WorkspacePage = (typeof WORKSPACE_PAGES)[number];

/** A prototype's tile as the rail draws it (the `workspaces` effect's `prototypes`). */
export const PrototypeLook = z.strictObject({
  id: z.string().min(1),
  /** What it tries, in its words, or its card's title. */
  title: z.string(),
  card: z.number().int().positive().nullable(),
  state: z.enum(['running', 'starting', 'failed', 'stopped']),
  /** Its prototype session; null: none known. */
  session: z.string().min(1).nullable(),
  branch: z.string(),
  /** `Local`, or `☁ <box>`. */
  where: z.string(),
  /** When it last changed state (RFC 3339). */
  since: z.string(),
  /** Its preview link while it runs. */
  url: z.string().nullable(),
  /** Its session waits on you: the tile's teal dot. */
  needsYou: z.boolean(),
});
export type PrototypeLook = z.infer<typeof PrototypeLook>;

/** Something only the shell can do. */
export const ShellEffect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view'), view: z.enum(['editor', 'factory']) }),
  /**
   * Open a folder as a project; with `attach` a cloud session's workspace (#74): the Editor's
   * Neovim, its terminal tabs and its tree's and git's reads run through those argv
   * (`abe workspace attach-spec`), the folder being the box's.
   */
  z.strictObject({
    kind: z.literal('open-project'),
    path: z.string(),
    attach: z
      .strictObject({
        /** Starts an embedded Neovim on stdio; the shell adds its `--cmd` and files. */
        nvim: z.array(z.string()).min(1),
        /** Starts a terminal tab's shell. */
        shell: z.array(z.string()).min(1),
        /** Put before a command (`git …`, a folder's listing). */
        exec: z.array(z.string()).min(1),
        /** The status bar's hover: the Workspace's box and its region. */
        box: z.strictObject({ name: z.string(), region: z.string().nullable() }),
        /** The box is not known to run: RemoteState says Waking until Neovim answers. */
        waking: z.boolean(),
        /** What RemoteState's Download locally (⌘⏎) clicks once connecting failed (#88). */
        download: z.string().optional(),
      })
      .optional(),
    /**
     * Open workspace's landing (#105 Behaviour 7): the Chat column shown beside it (pinned on its
     * session) with the keys, the project already shown or not.
     */
    chat: z.boolean().optional(),
    /**
     * Welcome's ⏎ on a card (#212): the project opened in the Factory view with this card
     * selected (its Chat on it), launching nothing.
     */
    card: z.number().int().positive().optional(),
  }),
  /**
   * The Chat column (`chat`) shown, the keyboard staying where it is; or the bottom pane on one of
   * its tabs, which takes the keyboard. What it shows is the slot's screen (an `open` command
   * names it).
   */
  z.strictObject({
    kind: z.literal('show'),
    place: z.enum(['chat', 'sessions', 'boxes', 'pipelines', 'git']),
  }),
  /** A stripe item opened as its click opens it (#11: `:`'s Go to, #20). */
  z.strictObject({ kind: z.literal('stripe-open'), id: z.string().min(1) }),
  /**
   * Sessions ⏎ on a card's session: its workspace at `path` on the page it last had there (the
   * code, Run, the Board on `card`, Workflows) once it was shown; else the Factory view on `card`.
   * The shown workspace keeps its page (the Board selects `card`); the screen pins Chat itself. With `browse` (the selection
   * moved onto the row): the shell does so after a short rest (~100 ms), any open workspace at
   * `path` shown on its page, Chat pinned on `session`, the keys staying in the Sessions list;
   * none open, Chat on `session` alone (the Board on `card`) and the status line says so. With
   * `page` (⏎ on a Board card): the workspace opened or shown on that page.
   */
  z.strictObject({
    kind: z.literal('workspace-page'),
    path: z.string(),
    card: z.number().int().positive().optional(),
    session: z.string().min(1).optional(),
    browse: z.literal(true).optional(),
    page: z.enum(WORKSPACE_PAGES).optional(),
  }),
  /**
   * A new tab in the Chat column's Terminal mode running `argv` (`abe` is the bridge's own), named
   * `title`, shown with the keyboard (#104: ⏎ on a box attaches to it). The Factory view has no
   * Terminal mode of its own yet: the Editor is shown with it.
   */
  z.strictObject({
    kind: z.literal('terminal-tab'),
    argv: z.array(z.string().min(1)).min(1),
    title: z.string().min(1),
  }),
  /**
   * The session the Chat slot's `chat` screen is pinned to (#340), unless it ended: the Editor's
   * Terminal mode has a pinned first tab **Claude Code** on it (the screen's `mode: terminal`
   * Terminal, `abe session attach <id>` / `abe box attach <box> --session <id>`), shells beside
   * it; null: no such tab. Sent on every `open` once the sessions are read and when it changed.
   */
  z.strictObject({ kind: z.literal('chat-session'), session: z.string().min(1).nullable() }),
  /**
   * A balloon (#348, `errors.ts`): an error fades after its reading time or at the next key or
   * click, unless it `stays` (it needs you: closed by a click, its action or its cause gone).
   */
  z.strictObject({
    kind: z.literal('balloon'),
    tone: z.enum(['info', 'warning', 'error']),
    text: z.string(),
    /** What it is about (a run's argv): the same key again replaces it, `drop-balloon` closes it. */
    key: z.string().min(1).optional(),
    /** It needs you: no fade. */
    stays: z.boolean().optional(),
    /** Its action's link (`Log in…`, `Retry`): a click is a `click` on `balloon:<key>`. */
    action: z.string().min(1).optional(),
    /** Where it was said (the screen), for the history (the status bar's `⚠ N`). */
    where: z.string().min(1).optional(),
  }),
  /** The balloon with this key closes now: its cause is gone (#348: the run answered ok). */
  z.strictObject({ kind: z.literal('drop-balloon'), key: z.string().min(1) }),
  /** A repo moved on this Mac (serve followed it): Recent Projects names it at `to`, not `from`. */
  z.strictObject({ kind: z.literal('repo-moved'), from: z.string(), to: z.string() }),
  /** The whole set: an empty list clears them. */
  z.strictObject({ kind: z.literal('widgets'), widgets: z.array(Widget) }),
  /**
   * The stripe's items (#20, `stripe.ts`), the whole set in order, and Settings' gear.
   * Whole-state: sent only when it changed.
   */
  z.strictObject({ kind: z.literal('stripe'), items: z.array(StripeItem), gear: StripeGear }),
  /** One stripe item's dot from the screen that read it (Pipelines'). Sent only when it changed. */
  StripeDotEffect,
  /** One line on the status line (a command's answer); empty clears it. */
  z.strictObject({ kind: z.literal('status'), text: z.string() }),
  /** `text` on the clipboard (the transcript's `y`). */
  z.strictObject({ kind: z.literal('clipboard'), text: z.string() }),
  /** Neovim's own command line (`::`): the Editor shown, its `:` typed. */
  z.strictObject({ kind: z.literal('cmdline') }),
  /**
   * `Run in Neovim` (#346): the Editor shown, `text` run on Neovim's own command line as if typed
   * after its `:` (`w`, `%s/a/b/g`, `42`), its message on Neovim's message line.
   */
  z.strictObject({ kind: z.literal('ex'), text: z.string().min(1) }),
  /**
   * One of the caret's context menu items (#346, `config/menu.lua`'s, what ⌘⏎ and a right-click
   * show there), chosen in `:`: the Editor shown, Lua runs item `index` of the ones it sent.
   */
  z.strictObject({ kind: z.literal('editor-item'), index: z.number().int().nonnegative() }),
  /**
   * One of the window's own actions, from `:`'s Anywhere rows (#346): Search Everywhere's All tab,
   * Recent Projects (⌘⇧O); Welcome's Open… (⌘O) and New Project… (#212), a folder picked in
   * the system's panel and opened as a project; Workflows (`:workflows`), the Project tree's Abe
   * node revealed (the workflows and skills in force, each opened in the Editor).
   */
  z.strictObject({
    kind: z.literal('app'),
    action: z.enum(['search-everywhere', 'recent-projects', 'open', 'new-project', 'workflows']),
  }),
  /** Welcome's Remove from list (#212): the project leaves the recent list, read anew. */
  z.strictObject({ kind: z.literal('forget-project'), path: z.string().min(1) }),
  /**
   * Welcome's chrome (#212): Mine's Needs you count on the Dock icon (0: none), the board's crumb
   * on the status bar (empty: none). Sent whenever either changes.
   */
  z.strictObject({
    kind: z.literal('welcome'),
    needsYou: z.number().int().nonnegative(),
    crumb: z.string(),
    /** The page shown (#3): the stripe picks Board, Project (`projects`), Sessions or Boxes. */
    page: z.enum(['board', 'projects', 'sessions', 'boxes']).optional(),
  }),
  /**
   * Welcome's Clone… (#3): `git clone <url>` into `~/projects/<name>` off the UI thread, then the
   * project opened (a folder already there opens as is); the status bar says it and any failure.
   */
  z.strictObject({ kind: z.literal('clone-project'), url: z.string().min(1) }),
  /** The terminal under this key is dropped now, its program hung up (`terminal.ts`). */
  z.strictObject({ kind: z.literal('drop-terminal'), key: z.string().min(1) }),
  /**
   * The Factory view's selected card (#105 S3): the app opens the Chat slot's `chat` screen on it
   * (`{card, whose?, title?}`) while the Factory view is shown, at once in Chat mode (#309), once
   * it rested 300 ms in Terminal mode (each card attaches its session); `owner`: the assignee's
   * name when the card is a teammate's (Chat read-only); `title`: the card's title as the Board
   * has it, so Chat's header names it in the same frame as its body (#309). Null: no card
   * selected (the ring on an empty column: Chat on none). Not sent before the cards are read.
   * Whole-state: sent only when it changed.
   */
  z.strictObject({
    kind: z.literal('selected'),
    card: z.number().int().positive().nullable(),
    owner: z.string().min(1).nullable(),
    title: z.string().min(1).optional(),
  }),
  /** Open this URL in the browser (a card on Azure Boards). */
  z.strictObject({ kind: z.literal('open-url'), url: z.url() }),
  /**
   * The Run bar's expand button (3.0 #21): as ⌥⌘⏎ on the main area, maximized (Chat and the pane
   * not drawn), or back when it is. Esc, unhandled there, restores it as ever.
   */
  z.strictObject({ kind: z.literal('expand') }),
  /**
   * A file opened in the Editor, which is shown. Without a line, in the shown project's (Linked's
   * Spec: the spec the run wrote); with one (absolute, 1-based), in the workspace holding it at
   * that line, that workspace opened if needed (#113: ⏎ on a Chat diff card, Open all).
   */
  z.strictObject({
    kind: z.literal('open-file'),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  }),
  /**
   * The header's one feed (#116, `workspaces.ts`): every story workspace's tab, context line, tree
   * root, crumb and caption, the Factory view's line and crumb, and whether `serve` answers.
   * Whole-state: sent only when it changed.
   */
  z.strictObject({
    kind: z.literal('workspaces'),
    workspaces: z.array(WorkspaceLook),
    factory: FactoryLine,
    answering: z.boolean(),
    /** The main checkouts whose Abe chat waits on you: the Abe tile's teal dot. */
    abeNeedsYou: z.array(z.string().min(1)).optional(),
    /**
     * Every prototype not done with (`prototype list`): a dashed tile each after the card
     * workspaces, kept in the order the shell first saw them.
     */
    prototypes: z.array(PrototypeLook).optional(),
  }),
  /** Go to this prototype's tile, on its Preview (New prototype…, a card's Prototype…). */
  z.strictObject({ kind: z.literal('open-prototype'), id: z.string().min(1) }),
  /**
   * What the window draws with (#108 S4, `abe theme look`): the theme's every colour token, light
   * or dark, the density and the fonts. Sent by the bridge at start, on `settings.changed` (a theme
   * file's change too) and while a Settings screen stages a change (the `look` command).
   * Whole-state: sent only when it changed.
   */
  z.strictObject({ kind: z.literal('look'), look: Look }),
  /**
   * Give this slot the keyboard (#107: ⏎ on a Sessions row puts Chat on its session with the
   * keys). The host moves it (#105); the app answers with `focus`.
   */
  z.strictObject({ kind: z.literal('focus'), slot: Slot }),
  /**
   * The Feel in force (#121, `abe settings feel`): the behaviour switches the shell honours (the
   * tree's reveal, click and marks, the tabs' limit, dot and preview, auto-save). Sent by the
   * bridge once serve answers, on `project` and on `settings.changed`. Whole-state: sent only
   * when it changed.
   */
  z.strictObject({ kind: z.literal('feel'), feel: FeelSwitches }),
  /**
   * A key this slot's screen did not take (#119): with no layer, menu or card of its own open,
   * Esc in the Chat column gives the keyboard back to the code (the app's, after it sent the key).
   */
  z.strictObject({ kind: z.literal('unhandled'), slot: Slot, key: z.string().min(1) }),
  /**
   * The PR review's ⏎ (the `review` slot): VimStorm's diff viewer on `files` (the pane's walk),
   * at `index` (1-based), `base` left and `head` right, scrolled to `line`, in the checkout at
   * `root`; `pr` the PR under review (its head read: the right side's title says so).
   */
  z.strictObject({
    kind: z.literal('show-diff'),
    root: z.string().min(1),
    files: z.array(
      z.strictObject({
        path: z.string(),
        oldPath: z.string().optional(),
        status: z.enum(['A', 'M', 'D', 'R']),
      }),
    ),
    index: z.number().int().positive(),
    base: z.string(),
    head: z.string(),
    line: z.number().int().positive(),
    pr: z.strictObject({ number: z.number().int().positive(), head: z.string() }),
  }),
  /** The answer to the diff's `,i` key, as a balloon in the diff (the review in `root`). */
  z.strictObject({
    kind: z.literal('review-said'),
    root: z.string(),
    text: z.string(),
    tone: z.enum(['info', 'ok', 'warn', 'error']),
  }),
  /**
   * The PR picked in the Git Log's `PR ⌄` was checked out (or not: `unchecked` says why, `path`
   * the main checkout): the shell opens `path` as a project and reviews PR `number` there.
   */
  z.strictObject({
    kind: z.literal('review-open'),
    path: z.string().min(1),
    repo: z.string(),
    number: z.number().int().positive(),
    unchecked: z.string().nullable(),
  }),
  /**
   * The Git Log's `PR ⌄` pick: the repo's open PRs, Mine then Others, for the checkout at `root`;
   * a pick is the `review` slot's `pick` ask. Empty: none open.
   */
  z.strictObject({
    kind: z.literal('pr-pick'),
    root: z.string(),
    repo: z.string(),
    rows: z.array(PrPickRow),
  }),
]);
export type ShellEffect = z.infer<typeof ShellEffect>;

/** What the person did on a drawn screen. */
export const UserInput = z.discriminatedUnion('kind', [
  /** A key in the app's nvim notation: `r`, `<CR>`, `<Esc>`, `<D-CR>`, `<S-Tab>`. */
  z.strictObject({ kind: z.literal('key'), key: z.string().min(1) }),
  /** The view lost the keyboard (a click elsewhere, the view hidden): a layer closes. */
  z.strictObject({ kind: z.literal('blur') }),
  /** A click on the node (or header tab) with this id. */
  z.strictObject({ kind: z.literal('click'), id: NodeId }),
  /**
   * Text the keys do not carry: a paste (⌘V), IME composition done. A typed character is a `key`
   * (`a`, `ö`, `<Space>`); the screen decides whether it types or moves.
   */
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  /**
   * The app's own text field (Chat's composer, a native text area) typed or its caret moved: its
   * whole text now, the number of this change, counting up (the screen echoes the last it took as
   * `seq`), and the caret in characters (absent: the text's end).
   */
  z.strictObject({
    kind: z.literal('draft'),
    text: z.string(),
    seq: z.number().int().nonnegative(),
    caret: z.number().int().nonnegative().optional(),
  }),
  /** Files pasted or dropped on the app's field (an image saved to a file first): absolute paths. */
  z.strictObject({ kind: z.literal('attach'), paths: z.array(z.string().min(1)).min(1) }),
  /**
   * The wheel or the trackpad over the node with this id (#247), in whole steps the shell counted:
   * `y` down (+) or up (−), `x` right (+) or left (−). A Board column scrolls by cards, the
   * Board's columns (`columns`) sideways by columns; the selection stays.
   */
  z.strictObject({
    kind: z.literal('scroll'),
    id: NodeId,
    x: z.number().int(),
    y: z.number().int(),
  }),
  /** What the PR review's diff keys, its strip and its files pane ask (the `review` slot's). */
  z.strictObject({ kind: z.literal('review'), ask: ReviewAsk }),
]);
export type UserInput = z.infer<typeof UserInput>;

/**
 * Where a jump goes (#106): the story's workspace (Open workspace), the story itself (Open card),
 * Linked (⌃L).
 */
export const JUMP_TOS = ['workspace', 'story', 'linked'] as const;
export type JumpTo = (typeof JUMP_TOS)[number];

/**
 * What had the keyboard when a jump key was pressed (#106 Behaviour 4): a slot's screen, or a
 * surface of the shown workspace (the Editor's splits, the Project tree, Git, the toolbar).
 */
export const JUMP_PLACES = [
  'main',
  'chat',
  'pane',
  'editor',
  'tree',
  'git',
  'toolbar',
  'other',
] as const;
export const JumpFrom = z.strictObject({
  place: z.enum(JUMP_PLACES),
  /** The view shown: on the Factory view what is not a slot's is the Board's. */
  view: z.enum(['editor', 'factory']),
});
export type JumpFrom = z.infer<typeof JumpFrom>;

/** App → bridge. */
export const AppFrame = z.discriminatedUnion('type', [
  /** `root`: the shown project's folder, where the screens' commands run (`--repo` too). */
  z.strictObject({
    v,
    type: z.literal('hello'),
    size: ViewSize,
    version: z.string(),
    root: z.string().min(1).optional(),
  }),
  /**
   * Another project is shown: its folder, as `hello`'s `root`; `box` the cloud workspace's box
   * when the shown project is one (its attach's `box.name`; `root` then stays the last local
   * folder), `branch` the branch checked out there (#119: Chat pins by them).
   */
  z.strictObject({
    v,
    type: z.literal('project'),
    root: z.string().min(1),
    box: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  /**
   * Open a screen in a slot (absent: `main`). The screen already open there is not opened anew:
   * it gets the `open` input on the state it holds (`params.from: 'editor'`: the Factory view was
   * just shown from the Editor).
   */
  z.strictObject({
    v,
    type: z.literal('open'),
    screen: z.string(),
    params: z.record(z.string(), z.string()).optional(),
    slot: Slot.optional(),
  }),
  /** Close the `popup` slot's screen (the rail moved off the Board): `main`'s has the keys again. */
  z.strictObject({ v, type: z.literal('close'), slot: z.literal('popup') }),
  /**
   * To the slot's screen (absent: `main`; `main`'s to the `popup` over it while one is open); a
   * layer up takes it first, whichever slot.
   */
  z.strictObject({ v, type: z.literal('input'), input: UserInput, slot: Slot.optional() }),
  z.strictObject({ v, type: z.literal('resize'), size: ViewSize, slot: Slot.optional() }),
  /** Which slot has the keyboard now (null: none, the Editor or another surface has it). */
  z.strictObject({ v, type: z.literal('focus'), slot: Slot.nullable() }),
  /**
   * The window (#236): the view it shows and whether it is the active window, sent at the start
   * and whenever either changes. While the Factory view is shown the bridge holds `abe fresh
   * --follow` (serve looks at once and every 2 min); the window coming to the front on it asks
   * `abe fresh` at once.
   */
  z.strictObject({
    v,
    type: z.literal('window'),
    view: z.enum(['editor', 'factory']),
    active: z.boolean(),
    /** The stripe's place in the main area (#11: `:`'s Go to leaves it out). */
    place: z.string().min(1).optional(),
  }),
  /** The Editor's caret moved (#119), debounced: given to the `chat` slot's screen. */
  z.strictObject({ v, type: z.literal('caret'), ...Caret.shape }),
  /** No file open in the Editor (#119): the `chat` slot's implicit context clears. */
  z.strictObject({ v, type: z.literal('no-caret') }),
  /**
   * `:` pressed in the Editor (#346), just before its `:` key: Neovim's Ex command names, the file
   * at the caret (relative to the shown folder), its line and selection, and the caret's context
   * menu items (`text`, its `key`): Command mode's Subject there, and `Run in Neovim`.
   */
  z.strictObject({ v, type: z.literal('editor-here'), ...EditorHereData.shape }),
  /**
   * How far the card dialog with this node id scrolls as drawn, in `l` / `ö` steps (#253): sent
   * once its page is laid out and again when that changes (the window resized, Sheets came). Its
   * keys scroll within it; the source's line count was only an estimate.
   */
  z.strictObject({
    v,
    type: z.literal('extent'),
    id: NodeId,
    lines: z.number().int().nonnegative(),
  }),
  /** A Terminal's program exited (`terminal.ts`): its key, its exit code (null: a signal). */
  z.strictObject({
    v,
    type: z.literal('exit'),
    key: z.string().min(1),
    code: z.number().int().nullable(),
  }),
  /** What a BrowserView's page did (`browser.ts`): loaded, blocked, focus, failed. */
  z.strictObject({ v, type: z.literal('browser'), key: z.string().min(1), event: BrowserEvent }),
  /**
   * ⌃L (or ⌃⌥L) pressed (#106): jump to Linked, from what had the keyboard. The shell never sends
   * one from an nvim split or a PTY for the plain key: it stays theirs.
   */
  z.strictObject({ v, type: z.literal('jump'), to: z.enum(JUMP_TOS), from: JumpFrom }),
  /**
   * `abe <argv> --json` run for the shell itself (Create Draft PR's reads and its write), in the
   * shown folder; answered by an `answer` frame with this id.
   */
  z.strictObject({
    v,
    type: z.literal('run'),
    id: z.string().min(1),
    argv: z.array(z.string()).min(1),
  }),
  /**
   * A `patch` the app could not apply (its base not the tree it holds): the slot's whole tree is
   * sent again as a `tree`, the patches after built on it.
   */
  z.strictObject({ v, type: z.literal('again'), slot: Slot }),
]);
export type AppFrame = z.infer<typeof AppFrame>;

/** Bridge → app. `rev` rises by one per tree the bridge sends. */
export const BridgeFrame = z.discriminatedUnion('type', [
  /** A slot's screen's tree (`slot` absent: `main`'s). */
  z.strictObject({
    v,
    type: z.literal('tree'),
    screen: z.string(),
    rev: z.number().int().positive(),
    tree: Node,
    slot: Slot.optional(),
  }),
  /**
   * A slot's tree as keyed patches of the one the app holds (ADR 0036): `base` the rev of the
   * `tree` or `patch` that gave it that tree, `ops` applied in order (`patch.ts`). Another base:
   * the app asks `again`.
   */
  z.strictObject({
    v,
    type: z.literal('patch'),
    screen: z.string(),
    rev: z.number().int().positive(),
    base: z.number().int().positive(),
    ops: z.array(PatchOp).min(1),
    slot: Slot.optional(),
  }),
  /** The `popup` slot's screen closed: the app draws it no more. */
  z.strictObject({ v, type: z.literal('closed'), slot: z.literal('popup') }),
  /**
   * The top layer (`layers.ts`) over whatever view is shown, the Editor too; `null`: none. While
   * one is up every key and click goes to it. Its `rev` counts with the trees'.
   */
  z.strictObject({
    v,
    type: z.literal('layer'),
    rev: z.number().int().positive(),
    tree: Node.nullable(),
  }),
  z.strictObject({ v, type: z.literal('shell'), effect: ShellEffect }),
  /** The `--json` document a `run` frame's command answered (`{ok, data}` or `{ok, error}`). */
  z.strictObject({
    v,
    type: z.literal('answer'),
    id: z.string().min(1),
    reply: z.union([
      z.strictObject({ ok: z.literal(true), data: z.unknown() }),
      z.strictObject({
        ok: z.literal(false),
        error: z.strictObject({ code: z.string(), message: z.string() }),
      }),
    ]),
  }),
  /** A refused frame: `unsupported-version`, `bad-request`, `unknown-screen`. */
  z.strictObject({
    v,
    type: z.literal('error'),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export type BridgeFrame = z.infer<typeof BridgeFrame>;

/** What a line from the app is: a frame, or why it is refused (the error frame to answer). */
export const readAppLine = (
  line: string,
): { ok: true; frame: AppFrame } | { ok: false; error: { code: string; message: string } } => {
  let doc: unknown;

  try {
    doc = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: 'bad-request', message: 'a line that is not JSON' } };
  }
  const version = z.object({ v: z.unknown() }).safeParse(doc);

  if (version.success && version.data.v !== undefined && version.data.v !== UI_CONTRACT)
    return {
      ok: false,
      error: {
        code: 'unsupported-version',
        message: `this abe ui bridge speaks v${UI_CONTRACT}, the app v${JSON.stringify(version.data.v)}: VimStorm and Abe are of different releases, update both`,
      },
    };
  const frame = AppFrame.safeParse(doc);

  return frame.success
    ? { ok: true, frame: frame.data }
    : { ok: false, error: { code: 'bad-request', message: z.prettifyError(frame.error) } };
};
