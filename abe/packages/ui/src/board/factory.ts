/**
 * The `factory` screen: the Factory view's Board, full width. It holds what it draws: the cards
 * (`abe card list`, Mine and Team, the sprint's done ones in Closed), their runs (`abe factory
 * status`), the sessions (`abe session list`) and the boxes (`abe box list`). `abe watch` keeps
 * them current in place, so it reads again only a run it has never seen, or one whose pull request
 * moved. It also holds which mode (`mode.ts`) is in the Board's place until Esc. The selected card
 * is the screen's `selected` output, which the window's Chat column follows; the screen draws no
 * Chat of its own.
 */
import type {
  BoardChangedEvent,
  BoardMember,
  BoxIdleData,
  BoxListData,
  CardData,
  CardListData,
  Event,
  FactoryRunData,
  PrototypeData,
  SessionData,
  ViewTweak,
  RepoHere,
} from '@abe/core';
import { prototypeLooks } from '../prototype';
import { boxBusyKey, boxBusyText } from '@abe/core/box-text';
import { isHere } from '@abe/core/here';
import { hasPrototype } from '@abe/core/prototype-tag';

import { launchLook } from './launch';
import { LAUNCH_SHORT, type ShortRuns, withShortAsk } from './launch-short';
import {
  type Answer,
  caretProp,
  type Choice,
  type Command,
  dropHeld,
  type Field,
  fieldInsert,
  fieldKey,
  fieldOf,
  filterMove,
  filterNote,
  fits,
  type Here,
  type Hold,
  holdPress,
  type Input,
  island,
  isListMove,
  type Jump,
  listClick,
  listKey,
  listMove,
  type ListOf,
  type ListPlace,
  listScroll,
  listSelected,
  listShown,
  listText,
  type MenuRow,
  movedRow,
  NEW_CARD_MENU,
  type NewCardOn,
  type Node,
  readingWords,
  type Refused,
  released,
  type Screen,
  selectOn,
  settleHeld,
  stack,
  statusLine,
  type Table,
  type ViewRows,
  type ViewSize,
  windowed,
  withCaret,
  type Word,
} from '../runtime/runtime';
import {
  balloon,
  type BoardTask,
  type Mode,
  type ModeOut,
  refusedBalloon,
  routeOf,
  type Under,
} from './mode';
import { localPrMode, type LocalPrShown } from './local-pr';
import { findSheet, openSheet, sheetAnswer, type SheetAsks, sheetMode } from './sheet-mode';
import {
  type ActionsAt,
  actionAnswer,
  actionKey,
  actionsMoved,
  assignCard as assignOnCard,
  type CardActions,
  isActionAnswer,
  launchFromBox,
  launchGoing as cardLaunchGoing,
  launchOnCard,
  NO_CARD_ACTIONS,
  relaunchAnswer,
  reopenCard,
  retryCard,
  shortChoice,
  stopCard,
} from './card-actions';
import {
  assignsToLaunch,
  type CardFacts,
  cardMenu,
  cardSubject,
  LAUNCH_BOX,
  LAUNCH_BOX_ROW,
  launchBox,
  isYours,
  launchRefusal,
  replacing,
} from './card-actions';
import { linkCommands, storyLink } from './story';
import { CARD_SCREEN } from './card-page';
import {
  type BoardCard,
  type BoardColumn,
  type BoardHeader,
  columnLayout,
  columnsOutOfView,
  columnsProps,
  firstShown,
  type RailRow,
  type Selection,
} from './board';
import {
  boxesBadge,
  type BoxMoves,
  cardBoxName,
  type Facts,
  type LiveRead,
  sleepsSoon,
  sleepsSoonText,
} from '../live';
import {
  boxMarkOf,
  COLUMNS,
  countsOf,
  readyWidgets,
  initials,
  isDone,
  isTheirs,
  type Look,
  launchTicking,
  lookOf,
  matches,
  OTHER,
  placedBox,
  pointsText,
  RAIL_STAGES,
  railRow,
  sessionOnlyLook,
  sessionRailRow,
  standing,
  type Standing,
  typeBadge,
} from './flow';
import {
  sameRepo,
  SESSION_COLUMNS,
  sessionCells,
  type SessionRow,
  sessionRows,
  waitingRows,
} from './session-rows';
import { cardOfBranch } from './branch';
import {
  arranged,
  STRIPE_CLICK,
  STRIPE_MENU,
  stripeChangeOf,
  stripeGear,
  stripeItems,
  stripeTweaks,
} from '../shell';
import {
  type NavColumn,
  type Places,
  type Ring,
  ringAt,
  ringBeside,
  ringReading,
  ringReadingEdge,
  ringOn,
  ringPaged,
  scrolled,
  settlePlaces,
  startOf,
  windowOf,
} from './board-nav';
import { type SheetContext, type SheetTab } from './sheet';
import { LINE_NEEDS_YOU, workspacesOf } from './workspaces';
import { JUMP_WORKSPACE, workspaceJump, workspaceLanding, workspaceSession } from './jumps';
import {
  BAND_HEIGHT,
  bandShown,
  boardChanges,
  boardName,
  cardLocal,
  discardLocalConfirm,
  heldOnBoard,
  LOCAL_HELD_MENU,
  heldMenu,
  heldOfRow,
  LOCAL_ARGV,
  LOCAL_BADGE_CLICK,
  LOCAL_DISCARD_CLICK,
  LOCAL_HELD_CLICK,
  LOCAL_READ,
  LOCAL_SETTINGS_CLICK,
  localBand,
  localDiscarded,
  localHeld,
  localOn,
  localPrMoved,
  localPrOf,
  localPrOfRun,
  localRead,
  type LocalState,
  readOnlyAlone,
  THIS_MAC,
  withLocal,
} from './local-view';
import { cardName } from '@abe/core/local-names';

/** The Board's tabs, in Tab's order: your cards, the team's, the sessions on them (to read). */
export const TABS = ['mine', 'team', 'sessions'] as const;
export type Tab = (typeof TABS)[number];

/** The cards a tab draws: Mine's, else Team's (the Sessions tab draws none). */
const cardsTab = (tab: Tab): 'mine' | 'team' => (tab === 'team' ? 'team' : 'mine');

/**
 * A read the screen asks for, by its id: one of `ARGV`'s, `run:<card>` (one card's runs) or
 * `session:<id>` (one session).
 */
type ReadId = string;

const ARGV: Readonly<Record<string, readonly string[]>> = {
  /** Where Launch agent goes (the Action menu says so). */
  target: ['settings', 'get', 'serve.target'],
  /** What Settings lists first: the toolbar gear's dot. */
  problems: ['settings', 'problems'],
  /** The board's team: whom Assign… offers. */
  members: ['card', 'members'],
  /** Whether the repo is in the Factory: the Board offers `:install` to one that is not. */
  install: ['install', 'status'],
  /** Local mode here: on or off, the held writes, the local pull requests, cards' states. */
  [LOCAL_READ]: [...LOCAL_ARGV],
};

/** The reads of the settings this screen follows. */
const SETTINGS_READS: readonly ReadId[] = ['target', 'problems'];

const ALL: readonly ReadId[] = ['members', 'install', LOCAL_READ, ...SETTINGS_READS];

const argvOf = (id: ReadId): string[] => [...(ARGV[id] ?? [])];

/**
 * The live facts the Board shows: its card lists (the sprint's done cards too, for the Closed
 * column), their runs and sessions, the boxes (the status bar, a card's mark), the prototypes (the
 * rail's tiles).
 */
const FOLLOWS: readonly LiveRead[] = [
  'cards:mine',
  'cards:team',
  'sessions',
  'runs',
  'boxes',
  'prototypes',
];

/** The live facts read again (`r`, a Retry's answer): these, or all the Board follows. */
const reread = (reads?: readonly LiveRead[], ran?: FactoryRunData): Command => ({
  kind: 'live',
  ...(reads === undefined ? {} : { reads }),
  ...(ran === undefined ? {} : { ran }),
});

export type FactoryState = {
  /** Retry runs and Reopens asked, their argv until answered (`launch-short.ts`). */
  shortRuns?: ShortRuns | undefined;
  /** The repo has no Factory install (`install status`: `no-install`): the Board offers one. */
  notInFactory?: boolean;
  /** The repo's install is going on (`install status`: not done): the Board says so. */
  installing?: boolean;
  /** How many problems Settings lists first (`settings problems`; infos not counted). */
  problems?: number;
  /** The live facts last handed: the runs, sessions, boxes and prototypes below are theirs. */
  facts?: Facts | undefined;
  /**
   * Another repo's project shown: the live runs and sessions held were read in the one before,
   * so they are not taken until read here.
   */
  foreign?: readonly LiveRead[] | undefined;
  size: ViewSize;
  now?: string;
  tab: Tab;
  /** The Sessions tab's list: its selection, its window, its `/` filter. */
  list: ListPlace;
  mine?: CardData[];
  team?: CardData[];
  sprint?: string | null;
  /** The board the card lists are of: another board's `board.changed` is not this one's. */
  board?: BoardChangedEvent['board'];
  /** The board's card types, the first a New card's default, and its key: from `card list`. */
  types?: readonly string[];
  boardKey?: string;
  runs?: FactoryRunData[];
  sessions?: SessionData[];
  /**
   * The repo `factory status` / `session list` were read in: a card's run, session and box are only
   * that repo's (another repo's board may have the same card number).
   */
  here?: RepoHere | undefined;
  /**
   * Each box's last `box.state` since `box list` last named it, by its name (the box mark on its
   * card's rail row; a session's box the list does not name too).
   */
  boxes?: BoxMoves;
  /** `box list`, changed in place by `box.state` / `box.idle` since. */
  boxList?: BoxListData;
  /** `prototype list`: the rail's prototype tiles. */
  prototypes?: PrototypeData[];
  /** `box list` refused as boxes off (`serve.target` local, no box profile named). */
  boxesOff?: boolean;
  /** The busy balloons said (`boxBusyKey`: a box and a day), so each box says it once a day. */
  busySaid?: string[];
  /** Each box's idle stop from its last `box.idle`: the card menu's Keep box awake. */
  idles?: Readonly<Record<string, BoxIdleData>>;
  /** The boxes said to sleep soon (`box.idle`), so each is said once until it is kept awake. */
  sleepSaid?: readonly string[];
  /** Why a read failed, by its id; kept until it succeeds. */
  failed: Readonly<Record<string, string>>;
  /** Reads asked and not answered, and those asked again meanwhile. */
  pending: readonly ReadId[];
  again: readonly ReadId[];
  /** The selected card: its id, else where it was. */
  card: Ring;
  /**
   * Opened on a card (`factory {card}`, a restarted bridge's last selection): once both tabs are
   * read, a card only on Team shows Team.
   */
  seek?: number;
  /** The leftmost column shown while the columns scroll sideways. */
  first: number;
  /** Where each column is scrolled, by tab and column: kept while the ring is elsewhere. */
  places: Places;
  /**
   * The screen's output: the card under the cursor, once the cards are read (the Chat column
   * follows it once it rests). Set after every step.
   */
  selected?: number;
  /** `g` typed, waiting for its second `g` (`gg`; `g` has no other jumps). */
  g: boolean;
  /** A count typed, waiting for its move (`3ö`). */
  count?: number;
  /** Its slot lost the keyboard (`focus`: the Chat column has it): the Board is drawn grey. */
  away?: boolean;
  /**
   * The `/` filter: its text, whether it is being typed, and the ring and the columns' places
   * before it (Esc while typing puts both back; the filter off, the places).
   */
  filter?: {
    text: string;
    /** Its caret while typed (`field.ts`); absent: at its end. */
    caret?: number | undefined;
    typing: boolean;
    before: { card: Ring; places: Places };
  };
  /** The mode in the Board's place until Esc: a Sheet or a local pull request. */
  mode?: Shown;
  /** The mode it opened over, back once it closes. */
  under?: Shown;
  /** The shown project's folder (the bridge's `root`): `factory run`'s `--repo`. */
  root?: string;
  /** `serve.target` there, once read. */
  target?: string;
  /** Launch, retry, reopen, stop and assign-then-launch on its cards (`card-actions.ts`). */
  actions: CardActions;
  /**
   * Launches heard going (`launch.started`), by card, from any screen or the CLI: its checkout,
   * and its session once answered; the card is Launching… until that session is listed.
   */
  launchesHeard?: Readonly<Record<number, { repo: string; session: string | null }>> | undefined;
  /** Its reads were asked: an `open` again (the view shown anew) reads nothing whole again. */
  opened: boolean;
  /**
   * Shown from the Editor: it lands on the oldest waiting run (`landing.ts`) once the runs and the
   * sessions are read.
   */
  land?: boolean;
  /** A Sheet's find and open out, before its tab takes the Board's place. */
  sheets?: SheetAsks | undefined;
  /** Your view tweaks (`views`): the keys walk hidden or moved columns as drawn. */
  tweaks?: readonly ViewTweak[];
  /** Every screen's tweaks, as read: what the stripe's menu writes back with its change. */
  views?: readonly ViewTweak[];
  /** Open workspace asked before the sessions were read: that story's workspace once they are. */
  jumpAfter?: number;
  /**
   * The whole runs and sessions lists answered since the project was shown: until both are, a card
   * with none says `Reading…`, never `No session`, and its menu waits for them.
   */
  wholeRead?: readonly ReadId[];
  /** ⌘⏎ pressed before the runs and sessions were read: that card's menu once they are. */
  menuAfter?: number;
  /** Open card off the Board before the runs and sessions were read: where it goes once they are. */
  storyAfter?: number;
  /** The board's team (`card members`, you first), once read: Assign…'s pick. */
  members?: BoardMember[];
  /** Local mode here: `local status` kept current, a local pull request in the Board's place. */
  local?: LocalState | undefined;
};

/** The mode in the Board's place, by the tag its runs and menus carry. */
type Shown = { tag: 'sheet'; m: SheetTab } | { tag: 'local-pr'; m: LocalPrShown };

/** Each mode's step, by its tag: `f` gets the mode, its state and how to put it back. */
const onMode = <R>(shown: Shown, f: <M>(mode: Mode<M>, m: M, wrap: (m: M) => Shown) => R): R => {
  switch (shown.tag) {
    case 'sheet':
      return f(sheetMode, shown.m, (m) => ({ tag: 'sheet', m }));
    case 'local-pr':
      return f(localPrMode, shown.m, (m) => ({ tag: 'local-pr', m }));
  }
};

/** px: the view's inset, a header, a column's header and pad, a card's pitch. */
const EDGE = 4;
const HEADER = 31;
const COLUMN_HEADER = 30;
const COLUMN_PAD = 8;
/** A card at its tallest (padding 8, `#id` line 16, a two-line title 36, the rail row 16, gaps 4, border) and the gap under it. */
const CARD_PITCH = 94 + 6;

/** The board is On this Mac (`board.provider: local`): its cards are its own, never held. */
const onThisMac = (s: Pick<FactoryState, 'board'>): boolean => s.board?.organization === THIS_MAC;

/** The band over the Board: local mode on, or the board read-only alone (not On this Mac). */
const bandOver = (s: Pick<FactoryState, 'local' | 'board'>): boolean =>
  bandShown(s.local) && !(readOnlyAlone(s.local?.view) && onThisMac(s));

/** The Board's size for its columns: less the band while it shows. */
const boardSize = (s: Pick<FactoryState, 'size' | 'local' | 'board'>): ViewSize =>
  bandOver(s) ? { ...s.size, height: Math.max(0, s.size.height - BAND_HEIGHT) } : s.size;

/** Cards a column shows at once. */
export const columnRows = (size: ViewSize): number =>
  Math.max(
    1,
    Math.floor((size.height - 2 * EDGE - HEADER - COLUMN_HEADER - COLUMN_PAD + 6) / CARD_PITCH),
  );

// ---------------------------------------------------------------- what the screen holds, laid out

/** A card, its newest run (else its live session with no run) and its look. */
type CardItem = {
  card: CardData;
  run?: FactoryRunData;
  session?: SessionData;
  look?: Look;
  theirs: boolean;
};
type Column = { name: string; cards: CardItem[] };

/**
 * A launch's session starting on a card whose run is not held: its run read too. A cloud launch's
 * `factory run` answers only once the whole launch is up, but `factory status` lists its run from
 * the start, so the card's rail says the launch's step and clock while its box boots.
 */
const sessionsById = (s: FactoryState) => new Map((s.sessions ?? []).map((x) => [x.id, x]));

/** The shown repo's runs: a card's match by repo and card, never by its number alone. */
const runsHere = (s: FactoryState): FactoryRunData[] =>
  (s.runs ?? []).filter((r) => isHere(s.here, r.repo));

/** The shown repo's boxes and placements: a card's box by its `abe:repo` and `abe:card`. */
const boxesHere = (s: FactoryState): BoxListData | undefined =>
  s.boxList === undefined
    ? undefined
    : {
        boxes: s.boxList.boxes.filter((b) => isHere(s.here, b.repo)),
        queued: s.boxList.queued.filter((q) => isHere(s.here, q.repo)),
      };

/** What each card of the shown repo stands for, as Chat pins it and Sessions says: `standing`. */
const standingHere = (s: FactoryState): Map<number, Standing> =>
  standing(
    runsHere(s),
    (s.sessions ?? []).filter((x) => isHere(s.here, x.repo)),
  );

/** The whole reads a card's run and session come from. */
const FACT_READS: readonly ReadId[] = ['runs', 'sessions'];

/** `r`: every read again, the Board's own and the live facts it follows. */
const readAgain = (s: FactoryState): Out => {
  const asked = ask(s, ALL);

  return { state: asked.state, commands: [...asked.commands, reread()] };
};

/**
 * How far the runs and the sessions are read: `reading` until both whole lists answered once,
 * `failed` when one failed and is not asked again, else `read`. Until then a card's run, session
 * and box are not known to be absent.
 */
const factsRead = (s: FactoryState): 'read' | 'reading' | 'failed' => {
  const unread = FACT_READS.filter((id) => !(s.wholeRead ?? []).includes(id));

  if (unread.length === 0) return 'read';

  return unread.some((id) => s.failed[id] !== undefined && !s.pending.includes(id))
    ? 'failed'
    : 'reading';
};

const filterText = (s: FactoryState) => s.filter?.text ?? '';

const columnsOf = (s: FactoryState): Column[] => {
  const cards = tabCards(s) ?? [];
  const mine = s.mine ?? [];
  const stands = standingHere(s);
  const item = (card: CardData): CardItem => {
    const { run, session: own } = stands.get(card.id) ?? {};
    const session = run === undefined ? own : undefined;
    const look = session === undefined ? undefined : sessionOnlyLook(session, s.now);

    return {
      card,
      theirs: isTheirs(card, cardsTab(s.tab), mine),
      // a run this serve holds waits on you, whoever the card is assigned to
      ...(run === undefined ? {} : { run, look: lookOf(run, own, s.now) }),
      ...(session === undefined || look === undefined ? {} : { session, look }),
    };
  };
  const shown = cards.filter((c) => matches({ card: c.id, title: c.title }, filterText(s)));
  const known = new Set<string>(COLUMNS);
  const columns: Column[] = COLUMNS.map((name) => ({
    name,
    cards: shown.filter((c) => c.state === name).map(item),
  }));
  const other = shown.filter((c) => !known.has(c.state));
  const all = other.length === 0 ? columns : [...columns, { name: OTHER, cards: other.map(item) }];

  return arranged(all, (c) => `col:${c.name}`, s.tweaks ?? []);
};

/** The columns as navigation sees them (`board-nav.ts`): each one's key on this tab and its cards. */
const navOf = (s: FactoryState, cols: readonly Column[]): NavColumn[] =>
  cols.map((c) => ({ key: `${s.tab}:${c.name}`, cards: c.cards.map((x) => x.card.id) }));

/** Another tab shown; the Sessions tab's list sorted afresh. */
const tabbed = (s: FactoryState, tab: FactoryState['tab']): FactoryState => ({
  ...unseek(s),
  tab,
  list: released(s.list),
});

/** Tab (`by` 1) or ⇧Tab (-1): the next tab round Mine · Team · Sessions. */
const nextTab = (s: FactoryState, by: 1 | -1): FactoryState =>
  tabbed(s, TABS[(TABS.indexOf(s.tab) + by + TABS.length) % TABS.length] ?? 'mine');

/** Where the selected card is: by its id while it shows, else where it was. */
const cardAt = (s: FactoryState, cols: readonly Column[]) => ringAt(s.card, navOf(s, cols));

const selectCard = (s: FactoryState, cols: readonly Column[], col: number, row: number) => ({
  ...s,
  card: ringOn(s.card, navOf(s, cols), col, row),
});

// ---------------------------------------------------------------- reads

const ask = (
  s: FactoryState,
  ids: readonly ReadId[],
): { state: FactoryState; commands: Command[] } => {
  // the card lists are live's: read again there
  const cards = LIVE_CARDS.filter((id) => ids.includes(id));
  const own = ids.filter((id) => !LIVE_CARDS.some((c) => c === id));
  // (a read with nothing to run, a prototype read with no prototype yet: dropped)
  const fresh = own.filter((id) => !s.pending.includes(id) && argvOf(id).length > 0);
  const busy = own.filter((id) => s.pending.includes(id) && !s.again.includes(id));

  return {
    state: {
      ...s,
      pending: [...s.pending, ...fresh],
      again: [...s.again, ...busy],
    },
    commands: [
      ...(cards.length === 0 ? [] : [reread(cards)]),
      ...fresh.map((id): Command => ({ kind: 'run', id, argv: argvOf(id) })),
    ],
  };
};

/** The Sessions tab's rows: what the widgets count, as that tab shows them. */
const sessionRowsOf = (s: FactoryState) =>
  sessionRows({
    sessions: s.sessions,
    runs: runsHere(s),
    here: s.here,
    cards: s.team,
    now: s.now,
  });

/** A row's click id on the Board's Sessions tab: `session:<id>`. */
const SESSION_ROW = 'session:';

/** The Sessions tab's Table: its wheel scrolls its rows. */
const SESSIONS_TABLE = 'board-sessions';

/**
 * The Sessions tab's rows as its list sees them (`table-list.ts`): none until the runs are in too,
 * as the pane's Sessions waits for them; as many as fit under the Board's header.
 */
const sessionsList = (s: FactoryState): ListOf<SessionRow> => ({
  all: s.runs === undefined && s.failed.runs === undefined ? [] : sessionRowsOf(s),
  keyOf: (r) => r.session.id,
  matches: (r, f) => matches({ card: r.card, title: r.title }, f),
  room: fits({ width: s.size.width, height: boardSize(s).height - 2 * EDGE - HEADER }),
});

/** The Sessions tab's selected row, if any. */
const sessionRowAt = (s: FactoryState): SessionRow | undefined =>
  listSelected(s.list, sessionsList(s));

/** The Sessions tab's selection on `card`'s first row, when it has one. */
const sessionsOnCard = (s: FactoryState, card: number): FactoryState => {
  const row = listShown(s.list, sessionsList(s)).find((r) => r.card === card);

  return row === undefined ? s : { ...s, list: selectOn(s.list, row.session.id) };
};

/**
 * ⏎ on a Sessions row: Chat on its session with the keys, an Abe chat's on it alone. Only to read:
 * the window shows no other workspace.
 */
const sessionChat = (row: SessionRow): Command[] =>
  row.chat === true && row.card <= 0
    ? [
        { kind: 'open', screen: 'chat', params: { session: row.session.id }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
        { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
      ]
    : chatOn(row.card, row.session.id);

/**
 * A key on the Sessions tab: the list's moves and its `/` filter (`table-list.ts`), Tab ⇧Tab the
 * tabs, ⏎ Chat on the row's session, `r` read again, Esc the window's. Never a workspace.
 */
const sessionsKey = (s0: FactoryState, raw: string): Out => {
  const l = sessionsList(s0);
  const { state: list, key } = listKey(s0.list, raw, l);
  const s: FactoryState = { ...s0, list };
  const row = listSelected(list, l);

  switch (key) {
    case undefined:
      return { state: s, commands: [] };
    case '<Tab>':
      return { state: nextTab(s, 1), commands: [] };
    case '<S-Tab>':
      return { state: nextTab(s, -1), commands: [] };
    case 'r':
      return readAgain(s);
    case '<Esc>':
      return { state: s, commands: [UNHANDLED_ESC] };
    case '<CR>':
      return { state: s, commands: row === undefined ? [] : sessionChat(row) };
    default:
      return { state: s, commands: [] };
  }
};

/** The sessions' counts as the Sessions tab's rows say them. */
const countsWithAsked = (s: FactoryState) => countsOf(sessionRowsOf(s));

/** The header's feed: sent every step, the bridge passes it on only when it changed. */
const workspacesEffect = (s: FactoryState): Command => {
  const prototypes = prototypeLooks(s.prototypes, s.sessions, cardTitles(s));

  return {
    kind: 'shell',
    effect: {
      kind: 'workspaces',
      // local mode's dashed badge
      ...withLocal(
        workspacesOf({
          runs: s.runs,
          sessions: s.sessions,
          now: s.now,
          root: s.root,
          sprint: s.sprint,
          counts: countsWithAsked(s),
          answering: s.failed.runs === undefined && s.failed.sessions === undefined,
        }),
        s.local?.view,
      ),
      // the rail's prototype tiles (none: the field left out, as before them)
      ...(prototypes.length === 0 ? {} : { prototypes }),
    },
  };
};

/** The cards' titles by id, Mine's over Team's: a card prototype's tile names its card. */
const cardTitles = (s: Pick<FactoryState, 'mine' | 'team'>): Record<number, string> =>
  Object.fromEntries([...(s.team ?? []), ...(s.mine ?? [])].map((c) => [c.id, c.title]));

/** The tick's time in ms; undefined before the first. */
const nowMs = (s: Pick<FactoryState, 'now'>): number | undefined =>
  s.now === undefined ? undefined : Date.parse(s.now);

/** The status bar's `☁ N boxes`, at the screen's clock. */
const boxesBadgeOf = (s: FactoryState) => boxesBadge(s.boxList, nowMs(s));

/** The card lists, live's reads. */
const LIVE_CARDS = ['cards:mine', 'cards:team'] as const satisfies readonly LiveRead[];
const CARD_LISTS: readonly ReadId[] = LIVE_CARDS;

/** The card lists that failed and are not asked now: what a read again asks. */
const idleFailedCards = (s: FactoryState): ReadId[] =>
  CARD_LISTS.filter((id) => s.failed[id] !== undefined && !s.pending.includes(id));

/**
 * The clock moved: the widgets go when the boxes' changed (a box stuck starting turns it red). A
 * card list that failed is live's to read again on its backoff.
 */
const ticked = (s: FactoryState, at: string): Out => {
  const next = { ...s, now: at };

  return JSON.stringify(boxesBadgeOf(next)) === JSON.stringify(boxesBadgeOf(s))
    ? { state: next, commands: [] }
    : { state: next, commands: feedsOf(next) };
};

/**
 * The status bar's widgets and the stripe: who needs you, what runs and the boxes are the stripe's
 * dots (no counts twice); the status bar keeps ready for review.
 */
const feedsOf = (s: FactoryState): Command[] => {
  const widgets = readyWidgets(countsWithAsked(s));

  return [
    {
      kind: 'shell',
      effect: { kind: 'widgets', widgets },
    },
    {
      kind: 'shell',
      effect: { kind: 'stripe', items: stripeOf(s), gear: stripeGear(s.problems) },
    },
  ];
};

/** The stripe's items from what the screen holds. */
const stripeOf = (s: FactoryState) =>
  stripeItems({
    counts: countsWithAsked(s),
    waiting: waitingRows(sessionRowsOf(s)),
    boxes: boxesBadgeOf(s),
    problems: s.problems,
    tweaks: s.tweaks,
  });

const failed = (s: FactoryState, id: string, message: string): FactoryState => ({
  ...s,
  failed: { ...s.failed, [id]: message },
});

const succeeded = (s: FactoryState, id: string): FactoryState => ({
  ...s,
  failed: Object.fromEntries(Object.entries(s.failed).filter(([k]) => k !== id)),
});

/** No tab sought any more: the person chose one, or a card list failed. */
const unseek = (s: FactoryState): FactoryState => {
  const rest = { ...s };

  delete rest.seek;

  return rest;
};

/** The tab holding the card opened on (`seek`), once both are read: Team when only it does. */
const seekTab = (s: FactoryState): FactoryState => {
  const { seek, ...rest } = s;

  if (seek === undefined || s.mine === undefined || s.team === undefined) return s;
  const onlyTeam = !s.mine.some((c) => c.id === seek) && s.team.some((c) => c.id === seek);

  return onlyTeam ? { ...rest, tab: 'team' } : rest;
};

/**
 * A card list read again in the order the Board shows: the board lists the newest change first, so
 * a card assigned or commented would jump to its column's top from under the mouse; the cards shown
 * keep their places in their columns. A card new to the list, or new to its column (moved), comes
 * first, as the board has it.
 */
const keptOrder = (held: readonly CardData[] | undefined, read: CardData[]): CardData[] => {
  if (held === undefined) return read;
  const was = new Map(held.map((c, i) => [c.id, { i, state: c.state }]));
  const kept = (c: CardData) => was.get(c.id)?.state === c.state;
  const place = (c: CardData) => was.get(c.id)?.i ?? -1;

  return [
    ...read.filter((c) => !kept(c)),
    ...read.filter(kept).sort((a, b) => place(a) - place(b)),
  ];
};

const answered = (s: FactoryState, input: Answer): FactoryState => {
  // only `no-install` offers one: any other refusal (a worktree, an install going on) says nothing;
  // a join no Abe chat has run for (a teammate's repo, its personal parts checked here or not yet)
  // is no install going on
  if (input.command === 'install status')
    return {
      ...s,
      notInFactory: !input.reply.ok && input.reply.error.code === 'no-install',
      installing:
        input.reply.ok &&
        !input.reply.data.done &&
        !(input.reply.data.join && input.reply.data.session === null),
    };
  if (!input.reply.ok) return failed(s, input.id, input.reply.error.message);
  const ok = succeeded(s, input.id);

  switch (input.command) {
    case 'card members':
      return { ...ok, members: input.reply.data.members };
    case 'local status':
      return { ...ok, local: localRead(ok.local, input.reply.data) };
    case 'settings problems':
      return {
        ...ok,
        problems: input.reply.data.problems.filter((p) => p.kind !== 'override').length,
      };
    case 'settings get': {
      const value = input.reply.data.value;

      return typeof value === 'string' ? { ...ok, target: value } : ok;
    }
    default:
      return ok;
  }
};

/**
 * A box busy at its last load read (ADR 0022): one balloon a day a box, with the size a Resize…
 * would take it to (`demo-shop is busy · Resize to m8g.2xlarge…`).
 */
const busyBalloons = (s: FactoryState, list: BoxListData): Out => {
  const at = nowMs(s);

  if (at === undefined) return { state: s, commands: [] };
  const said = new Set(s.busySaid ?? []);
  const busy = list.boxes.flatMap((b) =>
    b.busy === undefined || said.has(boxBusyKey(b.name, at)) ? [] : [{ b, next: b.busy.next }],
  );

  if (busy.length === 0) return { state: s, commands: [] };

  return {
    state: { ...s, busySaid: [...said, ...busy.map(({ b }) => boxBusyKey(b.name, at))] },
    commands: busy.map(({ b, next }) => balloon('info', boxBusyText(b.name, next))),
  };
};

const result = (s: FactoryState, input: Answer): { state: FactoryState; commands: Command[] } => {
  const id = input.id;
  const done: FactoryState = {
    ...answered(s, input),
    pending: s.pending.filter((p) => p !== id),
    again: s.again.filter((p) => p !== id),
  };
  const retry = s.again.includes(id) ? [id] : [];
  const more = retry.length > 0 ? ask(done, retry) : { state: done, commands: [] };
  const jumped = afterSessions(more.state);

  return {
    state: jumped.state,
    commands: [...feedsOf(jumped.state), ...more.commands, ...jumped.commands],
  };
};

/**
 * A card list live moved: the board's sprint, key and types from it, its cards in the order the
 * Board shows (`keptOrder`), the tab sought once both are in.
 */
const cardsMoved = (s: FactoryState, tab: 'mine' | 'team', l: CardListData): FactoryState => {
  const { organization, project, team, types } = l.board;
  const read: FactoryState = {
    ...s,
    sprint: l.sprint,
    board: { organization, project, team },
    boardKey: `${organization}/${project}/${team}`,
    ...(types === undefined ? {} : { types }),
  };

  return seekTab(
    tab === 'mine'
      ? { ...read, mine: keptOrder(s.mine, l.cards) }
      : { ...read, team: keptOrder(s.team, l.cards) },
  );
};

/** A whole live read in and read in the project shown: `factsRead` counts it. */
const wholly = (s: FactoryState, f: Facts, id: 'runs' | 'sessions'): FactoryState =>
  f.read[id].answers > 0 &&
  (s.facts?.read[id].answers ?? 0) < f.read[id].answers &&
  !(s.wholeRead ?? []).includes(id)
    ? { ...s, wholeRead: [...(s.wholeRead ?? []), id] }
    : s;

/**
 * The live facts handed: the runs, sessions, boxes, prototypes and launches the Board draws, its
 * reads' standing (`pending`, `failed`) as live's; a box list newly read says who is busy.
 */
const onFacts = (s0: FactoryState, f: Facts): Out => {
  const foreign = (s0.foreign ?? []).filter((r) => f.read[r].root !== s0.root);
  const takes = (r: 'runs' | 'sessions') => !foreign.includes(r);
  const readId = (r: LiveRead): ReadId => r;
  const reading = FOLLOWS.filter((r) => f.read[r].reading).map(readId);
  const failures = Object.fromEntries(
    FOLLOWS.flatMap((r) => {
      const why = f.read[r].failed;

      return why === undefined ? [] : [[r, why.message]];
    }),
  );
  const live = (id: string) => FOLLOWS.some((r) => r === id);
  const own = (keys: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(keys).filter(([k]) => !live(k)));
  let s: FactoryState = {
    ...s0,
    pending: [...s0.pending.filter((p) => !live(p)), ...reading],
    failed: { ...own(s0.failed), ...failures },
    launchesHeard: f.launches,
    boxes: f.boxMoves,
    idles: f.idles,
    foreign: foreign.length === 0 ? undefined : foreign,
  };

  if (takes('runs')) {
    s = wholly(s, f, 'runs');
    if (f.runs === undefined) delete s.runs;
    else s.runs = f.runs;
  }
  if (takes('sessions')) {
    s = wholly(s, f, 'sessions');
    if (f.sessions === undefined) delete s.sessions;
    else s.sessions = f.sessions;
  }
  if (takes('runs') && takes('sessions')) {
    if (f.here === undefined) delete s.here;
    else s.here = f.here;
  }
  if (f.boxList === undefined) delete s.boxList;
  else s.boxList = f.boxList;
  if (f.boxesOff === true) s.boxesOff = true;
  else delete s.boxesOff;
  if (f.prototypes === undefined) delete s.prototypes;
  else s.prototypes = f.prototypes;
  if (f.mine !== undefined && f.mine !== s0.facts?.mine) s = cardsMoved(s, 'mine', f.mine);
  if (f.team !== undefined && f.team !== s0.facts?.team) s = cardsMoved(s, 'team', f.team);
  // a card list that failed seeks no tab later
  if (
    LIVE_CARDS.some(
      (r) => f.read[r].failed !== undefined && f.read[r].failed !== s0.facts?.read[r].failed,
    )
  )
    s = unseek(s);
  s.facts = f;
  const listed =
    f.read.boxes.answers > (s0.facts?.read.boxes.answers ?? 0) && f.boxList !== undefined;
  const busy =
    listed && f.boxList !== undefined ? busyBalloons(s, f.boxList) : { state: s, commands: [] };
  const jumped = afterSessions(busy.state);

  const after = jumped.state;
  // the widgets and the stripe go by these alone (the bridge sends a whole-state effect only
  // when it changed, but a step that moved none of them says none)
  const fed =
    after.sessions !== s0.sessions ||
    after.runs !== s0.runs ||
    after.mine !== s0.mine ||
    after.team !== s0.team ||
    after.here !== s0.here ||
    after.boxList !== s0.boxList ||
    after.launchesHeard !== s0.launchesHeard ||
    after.failed.runs !== s0.failed.runs ||
    after.failed.sessions !== s0.failed.sessions;

  return {
    state: after,
    commands: [...(fed ? feedsOf(after) : []), ...busy.commands, ...jumped.commands],
  };
};

// ---------------------------------------------------------------- events

const onEvent = (s: FactoryState, event: Event): { state: FactoryState; commands: Command[] } => {
  // the mode up takes what is its: its Sheet
  const taken =
    s.mode === undefined
      ? undefined
      : onMode(s.mode, (mode, m, wrap) => {
          const out = mode.event(m, event, underOf(s));

          return out === undefined ? undefined : withFeeds(shownBy(s, wrap, out));
        });

  if (taken !== undefined) return taken;
  const changed = (next: FactoryState, reads: ReadId[] = []) => {
    const asked = ask(next, reads);

    return { state: asked.state, commands: [...feedsOf(asked.state), ...asked.commands] };
  };

  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      // (the runs, sessions and launches are live's: read again there)
      return ask(s, ALL);
    case 'settings.changed':
      // `localMode` among them: the band and the badge follow `abe local on|off`
      return ask(s, [...SETTINGS_READS, LOCAL_READ]);
    // an install started (here or in its Chat): no longer offered
    case 'install.changed':
      return changed({ ...s, notInFactory: false }, ['install']);
    case 'local.held':
      // a held card made or written, a held tag: the Board lists them, so read again
      return changed(
        { ...s, local: localHeld(s.local, event.data) },
        heldOnBoard(event.data) ? [...CARD_LISTS] : [],
      );
    case 'local.pr':
      return changed({ ...s, local: localPrMoved(s.local, event.data) });
    case 'local.discarded': {
      // Discard local changes here: the board as it is, so `local status` and the cards again
      const d = localDiscarded(s.local, event.data);

      return changed({ ...s, local: d.state }, d.ours ? [LOCAL_READ, ...CARD_LISTS] : []);
    }
    case 'box.idle': {
      // (its idle stop in the card menu is live's) About to sleep with a session waiting on you:
      // said once, with how to keep it
      const box = event.data.box;
      const soon = sleepsSoon({ state: 'running', idle: event.data.idle });
      const was = (s.sleepSaid ?? []).includes(box);
      const others = (s.sleepSaid ?? []).filter((b) => b !== box);
      const next: FactoryState = {
        ...s,
        sleepSaid: soon === undefined ? others : [...others, box],
      };
      const said =
        soon !== undefined && !was
          ? [
              {
                kind: 'shell' as const,
                effect: {
                  kind: 'balloon' as const,
                  tone: 'warning' as const,
                  text: `${sleepsSoonText(event.data.box, soon, event.at)} · a click on Boxes keeps it awake (abe box keep ${event.data.box})`,
                },
              },
            ]
          : [];

      return { state: next, commands: [...feedsOf(next), ...said] };
    }
    default:
      return { state: s, commands: [] };
  }
};

// ---------------------------------------------------------------- keys

const LEFT = new Set(['k', '<Left>']);
const RIGHT = new Set(['ä', '<Right>']);

/**
 * A move, `count` times when typed before it (`3ö`; `5G` / `5gg` the fifth card, `3⌃D` three cards
 * as Vim's), the ring's column's view following it (`board-nav.ts`); `l ö` and the rest are every
 * list's (`list-moves.ts`, Home / End as `gg` / `G`), `k ä` the columns.
 */
const moveCards = (s: FactoryState, key: string, count?: number): FactoryState => {
  const cols = columnsOf(s);
  const at = cardAt(s, cols);
  const nav = navOf(s, cols);
  const rows = columnRows(boardSize(s));
  const n = count ?? 1;

  if (LEFT.has(key)) return { ...s, card: ringBeside(s.card, s.places, nav, -n, rows) };
  if (RIGHT.has(key)) return { ...s, card: ringBeside(s.card, s.places, nav, n, rows) };
  const move = listMove(key, rows, count);

  if (move === undefined) return s;
  if (move.kind === 'page') {
    const paged = ringPaged(s.card, s.places, nav, move.rows, rows);

    return { ...s, card: paged.ring, places: paged.places };
  }
  const length = cols[at.col]?.cards.length ?? 0;

  return selectCard(s, cols, at.col, movedRow(move, at.row, Math.max(1, length)));
};

/** No count or `g` waiting. */
const withoutCount = (s: FactoryState): FactoryState => {
  const next: FactoryState = { ...s, g: false };

  delete next.count;

  return next;
};

/** The filter off: the columns scrolled as before it, the ring on the card it is on. */
const withoutFilter = (s: FactoryState): FactoryState => {
  const next = { ...s, ...(s.filter === undefined ? {} : { places: s.filter.before.places }) };

  delete next.filter;

  return next;
};

/** The filter given up while typing (Esc): the ring back where it was too. */
const filterCancelled = (s: FactoryState): FactoryState =>
  s.filter === undefined ? s : { ...withoutFilter(s), card: s.filter.before.card };

/**
 * The filter's text changed: the ring stays on its card while that matches, else goes to the first
 * card shown (WebStorm's speed search); an empty field puts the ring and the columns back as before
 * `/`.
 */
const filtered = (s: FactoryState, f: Field): FactoryState => {
  if (s.filter === undefined) return s;
  const text = f.text;
  const next: FactoryState = { ...s, filter: { ...s.filter, text, caret: caretProp(f) } };

  if (text === s.filter.text) return next;

  if (text === '') return { ...next, card: s.filter.before.card, places: s.filter.before.places };
  const cols = columnsOf(next);
  const first = cols.findIndex((c) => c.cards.length > 0);
  const kept = cols.some((c) => c.cards.some((x) => x.card.id === s.card.id));

  return kept || first < 0 ? next : selectCard(next, cols, first, 0);
};

/** Esc the Board did not take: the window restores a maximized Board. */
const UNHANDLED_ESC: Command = {
  kind: 'shell',
  effect: { kind: 'unhandled', slot: 'main', key: '<Esc>' },
};

const onKey = (s0: FactoryState, raw: string): { state: FactoryState; commands: Command[] } => {
  const none = (state: FactoryState) => ({ state, commands: [] });

  // `u` right after an assign answered (`· u undo`): it is undone; any other key drops the offer
  if (s0.actions.assigns.undo !== undefined) {
    const typed = s0.mode !== undefined || s0.filter?.typing === true;
    const out = actionKey(s0.actions, typed ? '' : raw);

    return out.taken
      ? { state: { ...s0, actions: out.actions }, commands: out.commands }
      : onKey({ ...s0, actions: out.actions }, raw);
  }

  if (s0.mode !== undefined) {
    // `gg` put together for every mode: the second `g`
    if (raw === 'g' && !s0.g) return none({ ...s0, g: true });
    const key = s0.g && raw === 'g' ? 'gg' : raw;
    const s: FactoryState = { ...s0, g: false };

    return onMode(s0.mode, (mode, m, wrap) => shownBy(s, wrap, mode.key(m, key, underOf(s))));
  }
  if (raw === '<D-CR>') {
    const column = emptyColumnAt(s0);

    return column === undefined
      ? menuOf(withoutCount(s0), selectedCard(s0))
      : { state: withoutCount(s0), commands: [columnMenu(s0, column)] };
  }

  if (s0.tab === 'sessions') return sessionsKey(s0, raw);
  if (s0.filter?.typing === true) {
    const f = s0.filter;

    // ⏎ opens the card at once (WebStorm's speed search), the filter kept
    if (raw === '<CR>') {
      const done: FactoryState = { ...s0, filter: { ...f, typing: false } };
      const card = selectedCard(done);

      return card === undefined ? none(done) : enterCard(done, card);
    }
    if (raw === '<Esc>') return none(filterCancelled(s0));
    const move = filterMove(raw, columnRows(boardSize(s0)));

    // ↑ ↓ through the matches in reading order, crossing columns; Home / End the first
    // and last match; the pages the column's
    if (move?.kind === 'by') {
      const cols = columnsOf(s0);

      return none({ ...s0, card: ringReading(s0.card, navOf(s0, cols), move.rows) });
    }
    if (move?.kind === 'to') {
      const cols = columnsOf(s0);

      return none({ ...s0, card: ringReadingEdge(s0.card, navOf(s0, cols), move.row === 'last') });
    }
    if (move !== undefined) return none(moveCards(s0, raw));
    // a macOS field's keys (`field.ts`): ← → ⌥← ⌘← move the caret, ⌫ ⌥⌫ ⌘⌫ at it, text typed there
    const next = fieldKey(fieldOf(f.text, f.caret), raw);

    return next === undefined ? none(s0) : none(filtered(s0, next));
  }
  // a count before a move: digits, a leading 0 not one (Vim's)
  if (/^[1-9]$/.test(raw) || (raw === '0' && s0.count !== undefined))
    return none({ ...s0, g: false, count: Math.min(9999, (s0.count ?? 0) * 10 + Number(raw)) });
  // Esc drops a waiting count or `g` and nothing else
  if (raw === '<Esc>' && (s0.g || s0.count !== undefined)) return none(withoutCount(s0));
  // `gg`: the second `g`; any other key drops a waiting `g` (the `g` jumps are gone)
  const key = s0.g && raw === 'g' ? 'gg' : raw;
  const count = s0.count;

  if (key === 'g') return none({ ...s0, g: true });
  const s: FactoryState = withoutCount(s0);
  if (key === '/')
    return none({
      ...s,
      filter: {
        text: '',
        typing: true,
        before: s.filter?.before ?? { card: s.card, places: s.places },
      },
    });
  // nothing of its own open: `unhandled`, so a maximized Board restores
  if (key === '<Esc>')
    return s.filter === undefined
      ? { state: s, commands: [UNHANDLED_ESC] }
      : none(withoutFilter(s));
  if (key === '<Tab>' || key === '<S-Tab>') return none(nextTab(s, key === '<Tab>' ? 1 : -1));
  // (a card list's wait, grown while it failed, starts anew in live)
  if (key === 'r') return readAgain(s);
  if (key === '<CR>') {
    if (installHint(s)?.enter === true) return { state: s, commands: [...INSTALL_COMMANDS] };
    const card = selectedCard(s);
    const column = card === undefined ? emptyColumnAt(s) : undefined;

    // the ring on an empty column: New card in it
    if (column !== undefined) return newCard(s, { column });

    return card === undefined ? none(s) : enterCard(s, card);
  }

  return none(moveCards(s, key, count));
};

/**
 * A click on the stripe: Board the Factory view landed as ⌘⌥A, Project the last workspace, Settings
 * (the toolbar's gear) on its Problems; on a tool window (the shell opens it) only Boxes does more.
 * Run is a place the shell shows itself (its screen is its to open here).
 */
const stripeClick = (s: FactoryState, id: string): Out => {
  switch (id) {
    case 'board':
      return {
        state: { ...s, land: true },
        commands: [{ kind: 'shell', effect: { kind: 'view', view: 'factory' } }],
      };
    case 'project':
      return { state: s, commands: [{ kind: 'shell', effect: { kind: 'view', view: 'editor' } }] };
    case 'settings':
      return {
        state: s,
        commands: [{ kind: 'open', screen: 'settings', params: { page: 'problems' } }],
      };
    // Boxes (the shell opens its tab): a box about to sleep on a session waiting on you is kept
    // awake by the same click
    case 'boxes': {
      const sleepy = s.boxList?.boxes.find((b) => sleepsSoon(b) !== undefined);

      return sleepy === undefined
        ? { state: s, commands: [] }
        : {
            state: s,
            commands: [
              {
                kind: 'run',
                id: `${KEEP_AWAKE}${sleepy.name}`,
                argv: ['box', 'keep', sleepy.name],
              },
            ],
          };
    }
    // the Run place: the shell opens the `run` screen in the main slot itself (`Projects::show_run`)
    case 'run':
      return { state: s, commands: [] };
    default:
      return { state: s, commands: [] };
  }
};

/**
 * A choice in the stripe's menu: your `views` with it, written to your Layer (a personal View
 * tweak) and drawn at once.
 */
const stripeChanged = (s: FactoryState, click: string): Out => {
  const change = stripeChangeOf(click);

  if (change === undefined) return { state: s, commands: [] };
  const views = stripeTweaks(s.views ?? s.tweaks ?? [], change);
  const next: FactoryState = {
    ...s,
    views,
    tweaks: views.filter((t) => t.screen === 'factory'),
  };

  return {
    state: next,
    commands: [
      ...feedsOf(next),
      {
        kind: 'run',
        id: STRIPE_WRITE,
        argv: ['settings', 'set', 'views', JSON.stringify(views)],
      },
    ],
  };
};

/** The rail's + (sent once the Board is shown): the New card dialog. */
export const NEW_CARD_WIDGET = 'widget:new-card';

/** The rail's + menu's New prototype…: its words asked, then `prototype start`. */
export const NEW_PROTOTYPE_WIDGET = 'widget:new-prototype';

/** The stripe menu's write of your `views`. */
const STRIPE_WRITE = 'stripe:views';

const onClick = (s0: FactoryState, id: string): { state: FactoryState; commands: Command[] } => {
  const none = (state: FactoryState) => ({ state, commands: [] });
  // `Show <title>` in a terminal's rows (⌘-click): that Sheet, its title exactly first
  if (id.startsWith('show:')) return sheetFound(s0, id.slice('show:'.length), true);
  // an empty column's `＋ New card`
  if (id.startsWith(`${NEW_CARD_MENU}:`))
    return newCard(s0, { column: id.slice(NEW_CARD_MENU.length + 1) });
  const clicked =
    s0.mode === undefined
      ? undefined
      : onMode(s0.mode, (mode, m, wrap) => {
          const out = mode.click(m, id, underOf(s0));

          return out === undefined ? undefined : shownBy(s0, wrap, out);
        });

  if (clicked !== undefined) return clicked;
  // `Factory ◆ N` on the Editor (or `◆ N needs you` here): the Factory view, landed as ⌘⌥A does
  if (id === 'widget:factory' || id === 'widget:needs-you' || id === LINE_NEEDS_YOU)
    return {
      state: { ...s0, land: true },
      commands: [
        { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
        // `◆ needs you`: the cards left for later on Chat's session shown again, with the keys
        ...(id === 'widget:factory'
          ? []
          : [
              { kind: 'shell' as const, effect: { kind: 'focus' as const, slot: 'chat' as const } },
              { kind: 'choice' as const, menu: 'cards', row: 'reopen', slot: 'chat' as const },
            ]),
      ],
    };
  // the rail's +: New card on the Board
  if (id === NEW_CARD_WIDGET) return newCard(s0, {});
  if (id === NEW_PROTOTYPE_WIDGET) return newPrototype(s0);
  // the stripe's menu: an item shown or hidden, moved to a group, the stripe reset
  if (id.startsWith(STRIPE_MENU)) return stripeChanged(s0, id);
  // the stripe's items: Board, Project, Settings, Boxes
  if (id.startsWith(STRIPE_CLICK)) return stripeClick(s0, id.slice(STRIPE_CLICK.length));
  // RemoteState's Download locally (⌘⏎) on a cloud workspace that couldn't connect
  if (id.startsWith(DOWNLOAD)) return downloadFrom(s0, id.slice(DOWNLOAD.length));
  // local mode: the band's links and the toolbar's badge, a local pull request's buttons
  if (id === LOCAL_HELD_CLICK || id === LOCAL_BADGE_CLICK) return heldList(s0);
  if (id === LOCAL_DISCARD_CLICK) return discardLocal(s0);
  if (id === LOCAL_SETTINGS_CLICK)
    return {
      state: s0,
      commands: [{ kind: 'open', screen: 'settings', params: { page: 'local-mode' } }],
    };
  const s = s0;

  const tab = TABS.find((t) => id === `tab:${t}`);

  if (tab !== undefined) return none(tabbed(s, tab));
  // a row of the Sessions tab: selected, to read
  if (id.startsWith(SESSION_ROW) && s.tab === 'sessions')
    return none({ ...s, list: listClick(s.list, id.slice(SESSION_ROW.length), sessionsList(s)) });
  if (id.startsWith('card:')) {
    const card = Number(id.slice('card:'.length));

    if (card === s.selected) return { state: s, commands: [chatShown(s, card)] };

    return none({ ...s, card: { ...s.card, id: card } });
  }
  // a right-click on a card: it is selected and its menu opens, as ⌘⏎ on it
  if (id.startsWith(`${CARD_MENU}card:`)) {
    const card = Number(id.slice(`${CARD_MENU}card:`.length));
    const selected = { ...s, card: { ...s.card, id: card } };

    return Number.isInteger(card) ? menuOf(selected, card) : none(s);
  }
  // a double-click on a card: it is selected and its Card page opens, as ⏎ on it
  if (id.startsWith(`${CARD_OPEN}card:`)) {
    const card = Number(id.slice(`${CARD_OPEN}card:`.length));

    return Number.isInteger(card)
      ? enterCard({ ...s, card: { ...s.card, id: card } }, card)
      : none(s);
  }

  return none(s);
};

// ---------------------------------------------------------------- Chat (the window's column)

type Out = { state: FactoryState; commands: Command[] };

// ---------------------------------------------------------------- the mode up

/** What a mode reads of the Board under it. */
const underOf = (s: FactoryState): Under => ({
  size: s.size,
  away: s.away === true,
  root: s.root,
  title: (card) => cardFacts(s, card)?.card.title,
  sessions: s.sessions,
  runs: () => runsHere(s),
  local: s.local?.view,
});

/** The mode up closed: the one it opened over comes back, else the Board. */
const withoutMode = (s: FactoryState): FactoryState => {
  const next = { ...s };

  delete next.mode;
  delete next.under;
  if (s.under !== undefined) next.mode = s.under;

  return next;
};

/** `shown` in the Board's place. Another mode up stays under it until Esc. */
const withMode = (s: FactoryState, shown: Shown): FactoryState =>
  s.mode === undefined || s.mode.tag === shown.tag
    ? { ...s, mode: shown }
    : { ...s, mode: shown, under: s.mode };

/** What a mode asked of the Board, done. */
const boardTask = (s: FactoryState, t: BoardTask): Out => {
  switch (t.kind) {
    case 'read': {
      return { state: s, commands: [...feedsOf(s), reread(['runs', 'sessions'])] };
    }
    case 'story':
      return enterCard(s, t.card);
  }
};

/** A mode's step on the Board: the mode as it is now (none: the Board again), then its tasks. */
const shownBy = <M>(s: FactoryState, wrap: (m: M) => Shown, out: ModeOut<M>): Out =>
  (out.board ?? []).reduce<Out>(
    (done, t) => {
      const next = boardTask(done.state, t);

      return { state: next.state, commands: [...done.commands, ...next.commands] };
    },
    {
      state: out.mode === undefined ? withoutMode(s) : withMode(s, wrap(out.mode)),
      commands: out.commands,
    },
  );

/** The widgets and the stripe drawn again after a mode moved, its version and state with them. */
const withFeeds = (out: Out): Out => ({
  state: out.state,
  commands: [...out.commands, ...feedsOf(out.state)],
});

/** Where `:show` and a link look first: the selected card and its session. */
const sheetContext = (s: FactoryState): SheetContext => {
  const card = selectedCard(s);
  const session = selectedSession(s);

  return {
    ...(card === undefined ? {} : { card }),
    ...(session === undefined ? {} : { session }),
  };
};

/** `abe sheet find`: its best match opens as a tab. `exact`: a link's title. */
const sheetFound = (s: FactoryState, text: string, exact: boolean): Out => {
  const out = findSheet(s.sheets, text, exact, sheetContext(s));

  return { state: { ...s, sheets: out.asks }, commands: out.commands };
};

/** `abe sheet open <ref>` for a card's Sheet: the tab once it answers. */
const sheetOpened = (s: FactoryState, ref: string, ctx: SheetContext): Out => {
  const out = openSheet(s.sheets, ref, { ctx });

  return { state: { ...s, sheets: out.asks }, commands: out.commands };
};

/**
 * A mode's run answered: a Sheet's find or open (the tab then up), else the mode's own while it
 * is up. A mode closed meanwhile gets nothing.
 */
const modeAnswer = (s: FactoryState, input: Answer | Refused): Out => {
  const route = routeOf(input.id);

  if (route === undefined) return { state: s, commands: [] };
  if (route.tag === 'sheet') {
    const out = sheetAnswer(s.sheets, route.ask, input);
    const next: FactoryState = { ...s, sheets: out.asks };

    return out.tab === undefined
      ? { state: next, commands: out.commands }
      : {
          state: { ...withMode(next, { tag: 'sheet', m: out.tab }), g: false },
          commands: out.commands,
        };
  }
  if (s.mode?.tag !== route.tag) return { state: s, commands: [] };

  return onMode(s.mode, (mode, m, wrap) =>
    withFeeds(shownBy(s, wrap, mode.answer(m, route.ask, input, underOf(s)))),
  );
};

/**
 * Chat on the card with the keys: the window's Chat column (the Chat slot's `chat` screen) opened
 * on the card, or on a chosen session of it, then the keys there. The Factory view draws no Chat of
 * its own.
 */
const chatOn = (card: number, session?: string): Command[] => [
  {
    kind: 'open',
    screen: 'chat',
    params: session === undefined ? { card: String(card) } : { card: String(card), session },
    slot: 'chat',
  },
  { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
];

// ---------------------------------------------------------------- launch, the Action menu, the card dialog

/** What a card's actions are worked out from, once it is read. */
const cardFacts = (s: FactoryState, card: number | undefined): CardFacts | undefined => {
  if (card === undefined) return undefined;
  const data =
    (s.mine ?? []).find((c) => c.id === card) ?? (s.team ?? []).find((c) => c.id === card);

  if (data === undefined) return undefined;
  // what the card shows: its menu acts on that run, or that session with none
  const { run, session } = standingHere(s).get(card) ?? {};
  // its box as the card mark finds it: the session's, else the one tagged with the card
  const boxes = boxesHere(s);
  const box = placedBox(session) ?? (boxes === undefined ? undefined : cardBoxName(boxes, card));
  const idle =
    box === undefined
      ? undefined
      : (s.idles?.[box] ?? s.boxList?.boxes.find((b) => b.name === box)?.idle);

  return {
    card: data,
    run,
    session,
    ...(box === undefined ? {} : { box }),
    ...(idle === undefined ? {} : { idle }),
    mine: (s.mine ?? []).some((c) => c.id === card),
    ...(s.members === undefined ? {} : { members: s.members }),
    ...(s.failed.members === undefined ? {} : { membersFailed: true }),
    root: s.root,
    target: s.target,
    ...(s.boxesOff === true ? { boxesOff: true } : {}),
    ...(readOnlyAlone(s.local?.view) ? { readOnly: true } : {}),
  };
};

/** What the card actions go by on the Board: the launches heard in the repo shown. */
const actionsAt = (s: FactoryState): ActionsAt => ({ launches: s.launchesHeard, here: s.here });

/** A launch on `card` going (`card-actions.ts`): `live`, the card's session as the Board has it. */
const launchGoing = (s: FactoryState, card: number, live?: SessionData): boolean =>
  cardLaunchGoing(s.actions, actionsAt(s), card, live);

/**
 * The Launch box on a card you may launch (or assign and launch), `runs` picked; its ⏎ comes back
 * to `launch`.
 */
const launchBoxOn = (s: FactoryState, card: number, runs?: string): Out => {
  const f = cardFacts(s, card);

  // no one's card: Assign to me and launch, yours once its box's ⏎ launched (`launchOnCard`)
  if (f === undefined || (launchRefusal(f) !== undefined && !assignsToLaunch(f)))
    return { state: s, commands: [] };
  const box = launchBox(f.card, s.target, replacing(f));

  // empty unless you drafted on it and pressed Esc (a launch forgets the draft)
  return { state: s, commands: [runs === undefined ? box : { ...box, draft: { note: '', runs } }] };
};

/**
 * ⏎ on a card (a double-click, ⏎ while the `/` filter types): its Card page as a popup over the
 * Board (the `popup` slot), never a launch, also when its workspace is on this machine (the page's
 * Session chip and ⌃W go there). Esc closes it back to the Board on the card.
 */
const enterCard = (s: FactoryState, card: number): Out => ({
  state: s,
  commands: [
    {
      kind: 'open',
      screen: CARD_SCREEN,
      params: { card: String(card), from: 'board' },
      slot: 'popup',
    },
  ],
});

/**
 * Open card off the Board (a workspace's, Chat's menu): a card whose session has a worktree here
 * shows that workspace on its Card page (`workspace-page`); any other (no session, or one in the
 * cloud) opens the Board's popup on it. Asked before the runs and sessions are in, it goes once
 * they are.
 */
const storyJump = (s: FactoryState, card: number): Out => {
  if (factsRead(s) === 'reading') return holdPress(HELD_STORY, s, card, readingWords(card));
  const root = localRoot(workspaceSession(runsHere(s), sessionsHere(s), card)?.session);

  return root === undefined
    ? enterCard(s, card)
    : {
        state: s,
        commands: [
          { kind: 'shell', effect: { kind: 'workspace-page', path: root, card, page: 'card' } },
        ],
      };
};

/** A card session's worktree on this machine: none for a cloud one or one that never got a box. */
const localRoot = (x: SessionData | undefined): string | undefined =>
  x?.kind === 'card' && x.box === undefined && x.neverPlaced !== true ? x.worktree : undefined;

/** The early Open card held (`held.ts`): where it goes once the runs and sessions are in. */
const HELD_STORY: Hold<FactoryState, number> = {
  held: (s) => s.storyAfter,
  hold: (s, card) => {
    const next = { ...s };

    if (card === undefined) delete next.storyAfter;
    else next.storyAfter = card;

    return next;
  },
  ready: (s) => factsRead(s) !== 'reading',
  act: (s, card) => storyJump(s, card),
};

/** The shown repo's sessions. */
const sessionsHere = (s: FactoryState): SessionData[] =>
  (s.sessions ?? []).filter((x) => isHere(s.here, x.repo));

/** A right-click on a card: `menu:` before the card's id (`menu:card:2`). */
const CARD_MENU = 'menu:';
/** A double-click's prefix on a card's id: its Card page, as ⏎. */
const CARD_OPEN = 'open:';

/** `card checkout`'s run id: `checkout:<card>`. */
const CHECKOUT = 'checkout:';

/**
 * Open worktree: a local session's worktree as a plain project in the Editor; any other card's (a
 * box story, a teammate's) its branch from origin checked out here first (`card checkout`).
 */
const openWorktree = (s: FactoryState, card: number): Out => {
  const session = cardFacts(s, card)?.session;

  if (session?.neverPlaced === true) return { state: s, commands: [] };
  if (session !== undefined && session.box === undefined)
    return {
      state: s,
      commands: [{ kind: 'shell', effect: { kind: 'open-project', path: session.worktree } }],
    };

  return {
    state: s,
    commands: [
      {
        kind: 'run',
        id: `${CHECKOUT}${card}`,
        argv: [
          'card',
          'checkout',
          String(card),
          ...(s.root === undefined ? [] : ['--repo', s.root]),
        ],
      },
    ],
  };
};

/** Checked out: the worktree opens as a project, said on the status line; a refusal said there. */
const onCheckedOut = (s: FactoryState, input: Answer | Refused): Out => {
  if (!input.reply.ok) return { state: s, commands: [statusLine(input.reply.error.message)] };
  if (input.command !== 'card checkout') return { state: s, commands: [] };
  const d = input.reply.data;

  return {
    state: s,
    commands: [
      { kind: 'shell', effect: { kind: 'open-project', path: d.worktree } },
      statusLine(`${d.made ? 'Checked out' : 'Opened'} ${d.branch}`),
    ],
  };
};

/**
 * Reopen: the card's ended session goes on, the same id, worktree and Claude Code conversation
 * (`abe session reopen`), Chat on it; a running one is Chat on it with the keys.
 */
const reopenOn = (s: FactoryState, card: number): Out => {
  const f = cardFacts(s, card);

  if (f?.session === undefined) return { state: s, commands: [] };
  if (f.session.state !== 'ended') return { state: s, commands: chatOn(card, f.session.id) };
  const asked = reopenCard(f);
  const going = asked.some((c) => c.kind === 'run');

  return { state: s, commands: [...asked, ...(going ? chatOn(card, f.session.id) : [])] };
};

/**
 * Retry run (⌘⏎ only): a new session on the card and its worktree, the Factory from decide (`abe
 * factory run`), on its box when it ended with it; only on a run not over.
 */
const retryRun = (s: FactoryState, card: number): Out => {
  const f = cardFacts(s, card);
  const asked = f === undefined ? [] : retryCard(f, s.root);

  return { state: s, commands: asked.length === 0 ? [] : [...asked, ...chatOn(card)] };
};

/** Stop…: asked in Command mode's ConfirmLayer (No the default), then `abe session stop`. */
const stopOn = (s: FactoryState, card: number): Out => ({
  state: s,
  commands: stopCard(card, cardFacts(s, card)?.session),
});

/**
 * ⌘⏎ (or a right-click on the card): the card's Action menu, in Command mode. Asked before the runs
 * and sessions are in, it opens once they are (`settleMenu`), never greyed or acting on what is not
 * read yet.
 */
const menuOf = (s: FactoryState, card: number | undefined): Out => {
  const f = cardFacts(s, card);

  if (f === undefined || card === undefined) return { state: s, commands: [] };
  if (factsRead(s) === 'reading') return holdPress(HELD_MENU, s, card, readingWords(card));

  return { state: s, commands: [cardMenu(f)] };
};

/** The early ⌘⏎ held (`held.ts`): the card's menu once the runs and sessions are in. */
const HELD_MENU: Hold<FactoryState, number> = {
  held: (s) => s.menuAfter,
  hold: (s, card) => {
    const next = { ...s };

    if (card === undefined) delete next.menuAfter;
    else next.menuAfter = card;

    return next;
  },
  ready: (s) => factsRead(s) !== 'reading',
  act: (s, card) => {
    const f = cardFacts(s, card);

    return { state: s, commands: f === undefined ? [] : [cardMenu(f)] };
  },
};

/**
 * Once the runs and sessions are in: a card menu or an Open card asked meanwhile goes; one the person
 * moved on from clears its status line.
 */
const settleMenu = (before: FactoryState, s: FactoryState): Out => {
  const menu = settleHeld(HELD_MENU, before, s);
  const story = settleHeld(HELD_STORY, before, menu.state);

  return { state: story.state, commands: [...menu.commands, ...story.commands] };
};

/** A row of the card's menu, or a button of its dialog, handed back by Command mode. */
// ---------------------------------------------------------------- local mode

/** The Held writes list, in Command mode; read first when it is not yet. */
const heldList = (s: FactoryState): Out => {
  const view = s.local?.view;

  return view === undefined
    ? { state: s, commands: [statusLine('Reading local mode…')] }
    : { state: s, commands: [heldMenu(view, s.now)] };
};

/** Discard local changes (the band, `:`, `:discard-local`): asked first; none held, said. */
const discardLocal = (s: FactoryState): Out => {
  const view = s.local?.view;

  if (view === undefined) return { state: s, commands: [statusLine('Reading local mode…')] };

  return boardChanges(view).length === 0
    ? { state: s, commands: [statusLine('No local changes to the board here')] }
    : { state: s, commands: [discardLocalConfirm(view)] };
};

/** A local pull request in the Board's place. */
const openLocalPr = (s: FactoryState, number: number): Out =>
  localPrOf(s.local, number) === undefined
    ? { state: s, commands: [statusLine('That local pull request is not in this checkout')] }
    : { state: withMode(s, { tag: 'local-pr', m: { number, focus: 'merge' } }), commands: [] };

/** ⏎ on a held write: the local pull request, what it would have sent (a file), or its card. */
const openHeld = (s: FactoryState, row: string): Out => {
  const w = heldOfRow(s.local?.view, row);
  const open = w?.open ?? null;

  if (open === null) return { state: s, commands: [statusLine('Nothing to open: only a record')] };
  switch (open.kind) {
    case 'local-pr':
      return openLocalPr(s, open.number);
    case 'file':
      return {
        state: s,
        commands: [{ kind: 'shell', effect: { kind: 'open-file', path: open.path } }],
      };
    case 'card':
      return enterCard(s.mode?.tag === 'local-pr' ? withoutMode(s) : s, open.id);
  }
};

const onChoice = (s: FactoryState, c: Choice): Out => {
  // a row of a mode's menu or dialog goes to that mode, while it is up
  const route = routeOf(c.menu);

  if (route !== undefined)
    return s.mode?.tag === route.tag
      ? onMode(s.mode, (mode, m, wrap) =>
          shownBy(s, wrap, mode.choice(m, route.ask, c.row, underOf(s))),
        )
      : { state: s, commands: [] };
  if (c.menu === NEW_PROTO_MENU) return startPrototype(s, (c.values ?? []).join(' '));
  // `:`'s tabs (Mine, Team, Sessions); New card…
  if (c.menu === BOARD_VIEW_MENU) {
    if (c.row === 'new-card') return newCard(s, {});
    if (c.row === 'local-held') return heldList(s);
    if (c.row === 'local-discard') return discardLocal(s);
    if (c.row === 'local-off')
      return {
        state: s,
        commands: [{ kind: 'open', screen: 'settings', params: { page: 'local-mode' } }],
      };

    const tab = TABS.find((t) => c.row === `tab:${t}`);

    if (tab !== undefined) return { state: tabbed(s, tab), commands: [] };

    return c.row === 'tab' ? onKey(s, '<Tab>') : { state: s, commands: [] };
  }
  // New card: opened on words (`:new …`, `New card “…”`) or a column; then made
  if (c.menu === NEW_CARD_MENU || c.menu === `${NEW_CARD_MENU}:column`) {
    if (c.row === 'open') return newCard(s, { title: c.values?.join(' ') ?? '' });
    if (c.row.startsWith('column:')) return newCard(s, { column: c.row.slice('column:'.length) });
    // an Ask's `New card from this chat`: its question the title, its chat what the agent drafts from
    if (c.row.startsWith('chat:'))
      return newCard(s, { title: c.values?.join(' ') ?? '', session: c.row.slice('chat:'.length) });

    return c.row.startsWith('made:') ? madeCard(s, c.row) : { state: s, commands: [] };
  }
  // local mode: `:held`, and ⏎ on a held write
  if (c.menu === 'local' && c.row === 'held') return heldList(s);
  if (c.menu === 'local' && c.row === 'discard') return discardLocal(s);
  if (c.menu === LOCAL_HELD_MENU) return openHeld(s, c.row);
  // `:show <name>`
  if (c.menu === 'show') return sheetFound(s, c.row, false);
  if (c.menu.startsWith(LAUNCH_SHORT)) {
    const out = shortChoice(s.actions, Number(c.menu.slice(LAUNCH_SHORT.length)), c.row);

    return { state: { ...s, actions: out.actions }, commands: out.commands };
  }
  // the Launch box's ⏎: the launch with its note and Grill choice
  if (c.menu.startsWith(LAUNCH_BOX)) {
    const card = Number(c.menu.slice(LAUNCH_BOX.length));
    const f = Number.isInteger(card) ? cardFacts(s, card) : undefined;

    if (f === undefined) return { state: s, commands: [] };
    const out = launchFromBox(
      s.actions,
      actionsAt(s),
      launchOnCard(f),
      launchBox(f.card, s.target, replacing(f)),
      c.values,
    );

    return { state: { ...s, actions: out.actions }, commands: out.commands };
  }
  const [what, id] = c.menu.split(':');
  const card = Number(id);

  if (!Number.isInteger(card)) return { state: s, commands: [] };
  if (what === 'card' && c.row === 'assign') return assignCard(s, card, c.values?.[0]);

  return what === 'card' ? onCardRow(s, card, c.row) : { state: s, commands: [] };
};

/** Assign… › who: `card assign` run, its words and undo kept (`assign.ts`). */
const assignCard = (s: FactoryState, card: number, who: string | undefined): Out => {
  const f = cardFacts(s, card);

  if (f === undefined || who === undefined) return { state: s, commands: [] };
  const out = assignOnCard(s.actions, f.card, who, {
    mine: isYours(f),
    members: s.members ?? [],
  });

  return { state: { ...s, actions: out.actions }, commands: out.commands };
};

/** A row of the card's menu (`STEP_ROWS`' ids too, the dialog's primary): what it does here. */
const onCardRow = (s: FactoryState, card: number, row: string): Out => {
  switch (row) {
    case 'pull-request': {
      // a local pull request: shown in the Board's place
      const local = localPrOfRun(cardFacts(s, card)?.run);

      if (local !== undefined) return openLocalPr(s, local);
      const f = cardFacts(s, card);

      return { state: s, commands: f === undefined ? [] : linkCommands(storyLink(f, 'pr')) };
    }
    // Launch agent: always the Launch box, its workflow preselected; its ⏎ launches
    case 'launch':
    case LAUNCH_BOX_ROW:
      return launchBoxOn(s, card);
    case 'launch-local-sandbox':
      return launchBoxOn(s, card, 'local-sandbox');
    case 'worktree':
      return openWorktree(s, card);
    case 'workspace':
      return { state: s, commands: workspaceOf(s, card) };
    case 'reopen':
      return reopenOn(s, card);
    case 'retry':
      return retryRun(s, card);
    case 'stop':
      return stopOn(s, card);
    case 'prototype':
      return prototypeOn(s, card);
    default:
      return { state: s, commands: [] };
  }
};

/**
 * Prototype…: a prototype session on the card (`abe prototype start --card`), real code in a
 * throwaway worktree, its app run from it; its answer opens Chat on that session.
 */
const prototypeOn = (s: FactoryState, card: number): Out => ({
  state: s,
  commands: [
    {
      kind: 'run',
      id: `${PROTO_START}${card}`,
      argv: [
        'prototype',
        'start',
        '--card',
        String(card),
        ...(s.root === undefined ? [] : ['--repo', s.root]),
      ],
    },
  ],
});

const PROTO_START = 'prototype-start:';

/** New prototype…'s words, asked in Command mode (a menu row handed back with them). */
const NEW_PROTO_MENU = 'new-prototype';

const newPrototype = (s: FactoryState): Out => ({
  state: s,
  commands: [
    {
      kind: 'menu',
      id: NEW_PROTO_MENU,
      title: 'New prototype',
      chosen: 'words',
      rows: [
        {
          id: 'words',
          text: 'New prototype',
          does: {
            kind: 'back',
            ask: [
              {
                name: 'words',
                kind: 'positional',
                type: 'string',
                required: true,
                repeats: true,
                summary: 'proto/… · never pushed · runs where cards run',
                title: 'What do you want to try?',
              },
            ],
          },
        },
      ],
    },
  ],
});

/** New prototype…'s words: `prototype start <words>` in the shown repo. */
const startPrototype = (s: FactoryState, words: string): Out =>
  words.trim() === ''
    ? { state: s, commands: [] }
    : {
        state: s,
        commands: [
          statusLine(`Starting a prototype · ${words.trim()}…`),
          {
            kind: 'run',
            id: `${PROTO_START}new`,
            argv: [
              'prototype',
              'start',
              ...words.trim().split(/\s+/),
              ...(s.root === undefined ? [] : ['--repo', s.root]),
            ],
          },
        ],
      };

/** Prototype…'s (or New prototype…'s) answer: its tile, on its Preview, or why not. */
const onPrototype = (s: FactoryState, input: Answer | Refused): Out => {
  if (!input.reply.ok || input.command !== 'prototype start')
    return { state: s, commands: [statusLine(''), ...refusedBalloon(input)] };
  return {
    state: s,
    commands: [
      statusLine(''),
      reread(['prototypes']),
      { kind: 'shell', effect: { kind: 'open-prototype', id: input.reply.data.id } },
    ],
  };
};

/** `factory run`'s answer (`card-actions.ts`): launched, the run on its card, the card selected, Chat on its session. */
const onLaunched = (s: FactoryState, input: Answer | Refused): Out => {
  const out = actionAnswer(s.actions, input);
  const next = { ...s, actions: out.actions };
  const l = out.launched;

  if (l === undefined) return { state: next, commands: out.commands };
  const shown: FactoryState = {
    ...next,
    runs: [...(next.runs ?? []).filter((r) => r.session !== l.run.session), l.run],
    card: { ...next.card, id: l.card },
  };

  return {
    state: shown,
    commands: [
      ...out.commands,
      ...feedsOf(shown),
      // live holds the run it answered with at once, and reads the runs and sessions again
      reread(['runs', 'sessions'], l.run),
      ...chatOn(l.card, l.run.session),
    ],
  };
};

/** The card under the cursor: where it is drawn (nothing chosen yet is the first card). */
const selectedCard = (s: FactoryState): number | undefined => {
  if (s.tab === 'sessions') {
    const card = sessionRowAt(s)?.card;

    return card === undefined || card <= 0 ? undefined : card;
  }
  const cols = columnsOf(s);
  const at = cardAt(s, cols);

  return cols[at.col]?.cards[at.row]?.card.id;
};

// ---------------------------------------------------------------- New card

/** Why the Board can make no card yet: no board configured, it did not answer, or it is read. */
/**
 * The Board's one hint for a repo not in the Factory. ⏎ runs `:install` while the board is not
 * read (no card, no New card to make); else ⏎ stays the card's and the hint names the word.
 */
const installHint = (s: FactoryState): { text: string; enter: boolean } | undefined => {
  if (s.notInFactory !== true && s.installing !== true) return undefined;
  const enter = noBoard(s) !== undefined && selectedCard(s) === undefined;

  // an install going on: ⏎ goes back to its chat
  if (s.notInFactory !== true)
    return { text: `Install in progress · ${enter ? '⏎' : ':install'}`, enter };

  return { text: `Not set up for Abe yet · ${enter ? 'Install ⏎' : ':install'}`, enter };
};

const noBoard = (s: FactoryState): string | undefined => {
  if (s.team !== undefined || s.mine !== undefined) return undefined;
  const failed = s.failed['cards:team'] ?? s.failed['cards:mine'];

  if (failed === undefined) return 'reading the board';

  return /board/i.test(failed) ? 'no board · Settings › Board & you' : 'the board did not answer';
};

/** The dialog as the Board opens it: its board's types and sprint, the title and column given. */
const newCardOn = (
  s: FactoryState,
  o: { title?: string; column?: string; session?: string },
): NewCardOn => ({
  kind: 'newcard',
  board: s.boardKey ?? 'board',
  types: s.types ?? [],
  // a card is not made done
  columns: COLUMNS.filter((c) => !isDone(c)),
  sprint: s.sprint ?? null,
  ...(onThisMac(s) ? { onThisMachine: true } : {}),
  ...(o.title === undefined || o.title.trim() === '' ? {} : { title: o.title.trim() }),
  ...(o.column === undefined ? {} : { column: o.column }),
  ...(o.session === undefined ? {} : { session: o.session }),
});

/** `:new <title>`, `New card “…”`, the Board's New card…, an empty column: the dialog in Command mode. */
const newCard = (
  s: FactoryState,
  o: { title?: string; column?: string; session?: string },
): Out => {
  const reason = noBoard(s);

  return reason === undefined
    ? { state: s, commands: [newCardOn(s, o)] }
    : { state: s, commands: [balloon('info', `New card: ${reason}`)] };
};

/** A card made (`made:<id>:<me|none>`): both lists read again, the ring on it, Mine when yours. */
const madeCard = (s: FactoryState, row: string): Out => {
  const [, id, who] = row.split(':');
  const card = Number(id);

  if (!Number.isInteger(card) || card <= 0) return { state: s, commands: [] };

  return ask(
    unseek({
      ...withoutFilter(s),
      tab: who === 'me' ? 'mine' : 'team',
      card: { ...s.card, id: card },
    }),
    CARD_LISTS,
  );
};

/** The column the ring is on while it is on no card (an empty column), by name. */
const emptyColumnAt = (s: FactoryState): string | undefined => {
  // a column the `/` filter empties is not an empty one; the Sessions tab shows none
  if (s.tab === 'sessions' || selectedCard(s) !== undefined || filterText(s) !== '')
    return undefined;
  const cols = columnsOf(s);
  const at = cardAt(s, cols);
  const col = cols[at.col];

  return col === undefined || col.name === OTHER || isDone(col.name) || col.cards.length > 0
    ? undefined
    : col.name;
};

/** ⌘⏎ on an empty column: its menu, New card in it. */
const columnMenu = (s: FactoryState, column: string): Command => {
  const reason = noBoard(s);

  return {
    kind: 'menu',
    id: `${NEW_CARD_MENU}:column`,
    title: column,
    rows: [
      {
        id: `column:${column}`,
        text: `New card in ${column}`,
        ...(reason === undefined ? {} : { reason }),
        does: { kind: 'back' },
      },
    ],
  };
};

// ---------------------------------------------------------------- the jumps and the workspace

/** The session of the selected card: the one it stands for, its run's or one with no run. */
const selectedSession = (s: FactoryState): string | undefined => {
  const card = selectedCard(s);
  const stands = card === undefined ? undefined : standingHere(s).get(card);

  return stands?.session?.id ?? stands?.run?.session;
};

/** The ear's Keep awake on a box about to sleep: `keep-awake:<box>`. */
const KEEP_AWAKE = 'keep-awake:';

/** RemoteState's click (`download:<session>`), sent with the `open-project` that attached it. */
const DOWNLOAD = 'download:';

/** Download locally from RemoteState: the session copied to this Mac, from the shown project. */
const downloadFrom = (s: FactoryState, session: string): Out => ({
  state: s,
  commands: [
    {
      kind: 'run',
      id: `${DOWNLOAD}${session}`,
      argv: ['session', 'download', session, ...(s.root === undefined ? [] : ['--repo', s.root])],
    },
  ],
});

/** Downloaded: its worktree opens in the Editor as a plain project, the copy said on the status line. */
const onDownloaded = (s: FactoryState, input: Answer | Refused): Out => {
  if (!input.reply.ok)
    return {
      state: s,
      commands: [balloon('error', `${input.reply.error.message} (${input.reply.error.code})`)],
    };
  if (input.command !== 'session download') return { state: s, commands: [] };

  return {
    state: s,
    commands: [
      { kind: 'shell', effect: { kind: 'open-project', path: input.reply.data.worktree } },
      {
        kind: 'shell',
        effect: { kind: 'status', text: input.text?.split('\n')[0] ?? 'downloaded' },
      },
    ],
  };
};

/**
 * Open workspace's attach-spec: the workspace in the Editor with Chat shown beside it on the
 * session (`jumps.ts` `workspaceLanding`), or why it cannot open (a queued session's refusal).
 */
const onJumpWorkspace = (s: FactoryState, input: Answer | Refused): Out => {
  if (!input.reply.ok)
    return {
      state: s,
      commands: [balloon('error', `${input.reply.error.message} (${input.reply.error.code})`)],
    };
  if (input.command !== 'workspace attach-spec') return { state: s, commands: [] };
  const session = input.id.slice(JUMP_WORKSPACE.length);
  const spec = input.reply.data;

  return {
    state: s,
    commands: [
      // a box not known to run: Chat says Waking until it does
      ...(spec.waking && spec.box !== null
        ? [
            {
              kind: 'open' as const,
              screen: 'chat',
              params: { session, waking: spec.box.name },
              slot: 'chat' as const,
            },
          ]
        : []),
      { kind: 'shell', effect: workspaceLanding(spec, `${DOWNLOAD}${session}`) },
    ],
  };
};

/** Open workspace on `story`: the launch hint only on a story of yours. */
const workspaceOf = (s: FactoryState, story: number): Command[] =>
  workspaceJump(
    runsHere(s),
    (s.sessions ?? []).filter((x) => isHere(s.here, x.repo)),
    story,
    cardFacts(s, story)?.mine !== false,
  );

/**
 * The runs and the sessions read (the runs too, since a run may stand): an Open workspace waiting
 * goes on.
 */
const afterSessions = (s: FactoryState): Out => {
  if (s.jumpAfter === undefined || !jumpReady(s)) return { state: s, commands: [] };
  const next = { ...s };

  delete next.jumpAfter;

  return { state: next, commands: workspaceOf(s, s.jumpAfter) };
};

/**
 * Open workspace can go: the sessions read, and the whole runs read once or its last ask failed
 * (one card's `run:<card>` answer is not the card's runs; a failure from another project shown is
 * asked again).
 */
const jumpReady = (s: FactoryState): boolean =>
  s.sessions !== undefined &&
  ((s.wholeRead ?? []).includes('runs') ||
    (s.failed.runs !== undefined && !s.pending.includes('runs')));

/**
 * A jump the bridge handed on: Open card the story's Card page (`storyJump`), Open workspace its
 * workspace.
 */
const onJump = (s: FactoryState, jump: Jump): Out => {
  // the runs and sessions not read yet: once they are
  if (jump.to === 'workspace' && !jumpReady(s))
    return { state: { ...s, jumpAfter: jump.story }, commands: [] };
  if (jump.to === 'workspace') return { state: s, commands: workspaceOf(s, jump.story) };

  return jump.to === 'story' ? storyJump(s, jump.story) : { state: s, commands: [] };
};

/**
 * The story what has the Factory view's keyboard belongs to: the Sheet tab's,
 * else the selected card (or session card).
 */
export const factoryLinked = (s: FactoryState): number | undefined =>
  s.mode === undefined
    ? selectedCard(s)
    : onMode(s.mode, (mode, m) => (mode.linked === undefined ? selectedCard(s) : mode.linked(m)));

/** A Retry run's or a Reopen's answer: both read the runs and sessions again. */
const relaunched = (id: string): boolean => id.startsWith('retry:') || id.startsWith('reopen:');

/** `abe factory run` from Retry run, or a Reopen: the runs and sessions read again, or why it was refused. */
const onRetry = (s: FactoryState, input: Answer | Refused): Out => ({
  state: s,
  commands: relaunchAnswer(input),
});

/**
 * The selected card for the window's Chat column: the app opens Chat on it. `owner` is the assignee's name on a teammate's card (on
 * Team, once Mine is read, and not while it is read again, since a card just assigned to you with
 * Team read first is yours); `title` is its title as the Board has it, so Chat's header names it in
 * the same frame as its body.
 */
const selectedEffect = (s: FactoryState): Command => {
  const { card, owner, title } = selectedOf(s);

  return {
    kind: 'shell',
    effect: {
      kind: 'selected',
      card: card ?? null,
      owner,
      ...(title === undefined ? {} : { title }),
    },
  };
};

/** The selected card, its teammate owner and its title, as `selected` says them. */
const selectedOf = (
  s: FactoryState,
): { card: number | undefined; owner: string | null; title: string | undefined } => {
  const card = s.selected;
  const data = card === undefined ? undefined : (s.team ?? []).find((c) => c.id === card);
  const title =
    card === undefined ? undefined : (data ?? (s.mine ?? []).find((c) => c.id === card))?.title;
  const owner =
    data !== undefined &&
    s.mine !== undefined &&
    !s.pending.includes('cards:mine') &&
    isTheirs(data, cardsTab(s.tab), s.mine)
      ? (data.assignee?.name ?? null)
      : null;

  return {
    card,
    owner: owner === '' ? null : owner,
    title: title === undefined || title === '' ? undefined : title,
  };
};

/**
 * A click on the selected card (M5): Chat shown on it, as the app opens it on a selection, off the
 * Abe chat or a session chosen there (`picked`); the keys stay on the Board.
 */
const chatShown = (s: FactoryState, card: number): Command => {
  const { owner, title } = selectedOf(s);

  return {
    kind: 'open',
    screen: 'chat',
    params: {
      card: String(card),
      picked: '1',
      ...(owner === null ? {} : { whose: owner }),
      ...(title === undefined ? {} : { title }),
    },
    slot: 'chat',
    ifOpen: true,
  };
};

// ---------------------------------------------------------------- landing

/**
 * A landing asked (`land`) once the runs and sessions are in: the oldest waiting run's card
 * selected (the filter closed, so it shows) and Chat on it with the keys (the window's column);
 * with none waiting, nothing moves. A read that failed lands nowhere.
 */
const settleLanding = (s: FactoryState): Out => {
  if (s.land !== true || factsRead(s) === 'reading') return { state: s, commands: [] };
  const done: FactoryState = { ...s };

  delete done.land;
  if (s.runs === undefined || s.sessions === undefined) return { state: done, commands: [] };
  // the oldest the Sessions tab and the widgets say needs you
  const to = waitingRows(sessionRowsOf(s))[0];

  if (to === undefined) return { state: done, commands: [] };
  const shown: FactoryState = { ...withoutFilter(done), g: false };

  // (a card not on the tab shown: Chat all the same, the selection where it was)
  return { state: { ...shown, card: { ...shown.card, id: to.card } }, commands: chatOn(to.card) };
};

/**
 * The first card on open, once the shown tab's cards, the runs and the sessions are in (a read that
 * failed counts as in): the oldest one that needs you, else the first of yours in board order, else
 * the first card. Chosen once; after that the keys choose.
 */
const settleFirstCard = (s: FactoryState): FactoryState => {
  const cards = tabRead(s);

  if (s.card.id !== undefined || factsRead(s) === 'reading' || s.pending.includes(cards)) return s;
  const shown = columnsOf(s).flatMap((c) => c.cards.map((x) => x.card));

  if (shown.length === 0) return s;
  const on = new Set(shown.map((c) => c.id));
  const mine = new Set((s.mine ?? []).map((c) => c.id));
  const waiting = waitingRows(sessionRowsOf(s)).find((w) => on.has(w.card));
  const id = waiting?.card ?? shown.find((c) => mine.has(c.id))?.id ?? shown[0]?.id;

  return id === undefined ? s : { ...s, card: { ...s.card, id } };
};

/** The screen's `selected` output: the card under the cursor, kept in the state after every step. */
const settleSelected = (s: FactoryState): FactoryState => {
  const card = s.mine === undefined && s.team === undefined ? undefined : selectedCard(s);

  // a Sessions row of no card (an Abe chat): Chat stays on the card it was on
  if (card === undefined && s.tab === 'sessions') return s;

  if (card === s.selected) return s;
  const next: FactoryState = { ...s };

  if (card === undefined) delete next.selected;
  else next.selected = card;

  return next;
};

/**
 * The Board's selected card selects its row in the pane's Sessions, while Sessions is the pane's
 * screen (`ifOpen`): on every change of it (a key, a click, Linked, a jump, a read), except the
 * `factory {card, from: sessions}` Sessions itself sent.
 */
const toSessions = (before: FactoryState, after: FactoryState, input: Input): Command[] =>
  after.selected !== undefined &&
  after.selected !== before.selected &&
  !(input.kind === 'open' && input.params.from === 'sessions')
    ? [
        {
          kind: 'open',
          screen: 'sessions',
          params: { card: String(after.selected) },
          slot: 'pane',
          ifOpen: true,
        },
      ]
    : [];

/**
 * In a card's workspace (its branch `card/<n>-…`) the Board selects that card, the tab holding it;
 * elsewhere (the main checkout) the selection stays.
 */
const onWorkspaceCard = (s: FactoryState, branch: string | undefined): FactoryState => {
  const card = cardOfBranch(branch);

  return card === undefined || card === s.card.id
    ? s
    : seekTab({ ...s, card: { ...s.card, id: card }, seek: card });
};

const stepFactory = (s: FactoryState, input: Input): Out => {
  // the person going on (`held.ts`): a menu waiting for the reads gives way to it
  const stepped = stepOverview(dropHeld(HELD_STORY, dropHeld(HELD_MENU, s, input), input), input);
  const menu = settleMenu(s, stepped.state);
  // (its status line cleared before what the step says, which may set it again)
  const overview = { state: menu.state, commands: [...menu.commands, ...stepped.commands] };
  const landed = settleLanding(overview.state);
  const chosen = settleFirstCard(landed.state);
  // the view follows the ring when it moved, a move key was pressed, the filter changed, or the
  // view changed size or was shown; never for the wheel, a count, `g`, a read or the clock
  const follow =
    input.kind === 'resize' ||
    input.kind === 'open' ||
    (input.kind === 'key' && (isMove(input.key) || (input.key === 'g' && s.g))) ||
    filterText(s) !== filterText(chosen) ||
    (input.kind !== 'scroll' && ringKey(s) !== ringKey(chosen));
  const settled = {
    state: settleSelected(settleScroll(chosen, follow)),
    commands: [...overview.commands, ...landed.commands],
  };

  return {
    state: settled.state,
    commands: [
      ...settled.commands,
      ...toSessions(s, settled.state, input),
      // the Chat column follows it (sent only when it changed), once the cards are
      // read: a null before would put Chat on no card while the Board reads
      ...(settled.state.mine === undefined && settled.state.team === undefined
        ? []
        : [selectedEffect(settled.state)]),
      workspacesEffect(settled.state),
    ],
  };
};

/**
 * What the person does besides a key (`onKey` drops it itself): a click, a menu's choice, text,
 * another project; after it `u` undoes no assign.
 */
const DROPS_UNDO: ReadonlySet<Input['kind']> = new Set(['click', 'choice', 'text', 'root', 'open']);

const stepOverview = (s0: FactoryState, input: Input): Out => {
  const s =
    DROPS_UNDO.has(input.kind) && s0.actions.assigns.undo !== undefined
      ? { ...s0, actions: actionsMoved(s0.actions) }
      : s0;

  switch (input.kind) {
    case 'open': {
      const root = input.params.root;
      // opened again (the view shown anew): what it holds stays, abe watch keeps it current
      const sized: FactoryState = {
        ...s,
        size: input.size,
        opened: true,
        ...(root === undefined ? {} : { root }),
      };
      // a card list that failed is read at once though: the view is looked at again
      const asked = s.opened ? ask(sized, idleFailedCards(sized)) : ask(sized, ALL);
      const card = Number(input.params.card);

      // `factory {card}` (the Sessions tab's row, Linked's Run row): select that card, what the
      // Board's place shows stays; with `sheet` (Linked's Sheets row) that Sheet's tab on it
      if (input.params.card !== undefined && Number.isInteger(card) && card > 0) {
        // a restarted bridge is told the tab it was on (`tab: team`); else the tab holding it
        const selected =
          input.params.tab === 'team' || input.params.tab === 'mine'
            ? unseek({
                ...asked.state,
                card: { ...asked.state.card, id: card },
                tab: input.params.tab,
              })
            : seekTab({
                // on the Sessions tab: its row of the card too
                ...(asked.state.tab === 'sessions'
                  ? sessionsOnCard(asked.state, card)
                  : asked.state),
                card: { ...asked.state.card, id: card },
                seek: card,
              });

        if (input.params.sheet === undefined) return { state: selected, commands: asked.commands };
        const sheet = sheetOpened(selected, input.params.sheet, { card });

        return { state: sheet.state, commands: [...asked.commands, ...sheet.commands] };
      }
      // shown in a card's workspace: on its card; elsewhere ⌘⌥A from the Editor lands
      const own = cardOfBranch(input.params.branch);
      const shown = { ...asked, state: onWorkspaceCard(asked.state, input.params.branch) };

      return input.params.from === 'editor' && own === undefined
        ? { state: { ...shown.state, land: true }, commands: shown.commands }
        : shown;
    }
    case 'root': {
      // another project shown: its board, runs and serve.target read anew there; on its card
      // when it is a card's workspace
      const next = onWorkspaceCard({ ...s, root: input.root }, input.branch);
      // another checkout of the same repo: its runs and sessions stay while read again (the
      // strip and the cards keep them, as Sessions' rows do)
      const same = sameRepo(s, input.root);

      // the other project's team: Assign… offers this board's once it is read
      delete next.members;
      // a local pull request was the other project's
      if (next.under?.tag === 'local-pr') delete next.under;
      if (next.mode?.tag === 'local-pr') {
        delete next.mode;
        if (next.under !== undefined) next.mode = next.under;
        delete next.under;
      }
      if (!same) {
        // the repo the lists were read in was the other project's: the reads say this one's
        delete next.here;
        // its runs and sessions too: its cards say `Reading…` until this one's are in
        delete next.runs;
        delete next.sessions;
        delete next.wholeRead;
        next.foreign = ['runs', 'sessions'];
      }
      delete next.menuAfter;
      // local mode is per checkout, and so is the Factory install
      delete next.local;
      delete next.notInFactory;

      return ask(next, ALL);
    }
    case 'views': {
      const next: FactoryState = {
        ...s,
        tweaks: input.tweaks,
        ...(input.all === undefined ? {} : { views: input.all }),
      };

      // the stripe drawn with them (an item hidden or moved)
      return { state: next, commands: feedsOf(next) };
    }
    case 'choice':
      return onChoice(s, input);
    case 'resize':
      return { state: { ...s, size: input.size }, commands: [] };
    case 'tick':
      return ticked(s, input.at);
    case 'focus':
      return { state: { ...s, away: !input.focused }, commands: [] };
    case 'key':
      return onKey(s, input.key);
    case 'scroll':
      return { state: onScroll(s, input.id, input.x, input.y), commands: [] };
    case 'click':
      return onClick(s, input.id);
    case 'text': {
      const typed =
        s.tab === 'sessions' ? listText(s.list, input.text, sessionsList(s)) : undefined;

      if (typed !== undefined) return { state: { ...s, list: typed }, commands: [] };

      return s.filter?.typing === true
        ? {
            state: filtered(s, fieldInsert(fieldOf(s.filter.text, s.filter.caret), input.text)),
            commands: [],
          }
        : { state: s, commands: [] };
    }
    case 'result':
      // a mode's runs carry its tag: they go to it alone
      if (routeOf(input.id) !== undefined) return modeAnswer(s, input);
      // its own reads are always commands of the table: a refused argv is only Retry's to say
      if (input.id.startsWith(JUMP_WORKSPACE)) return onJumpWorkspace(s, input);
      if (input.id.startsWith(DOWNLOAD)) return onDownloaded(s, input);
      if (input.id.startsWith(CHECKOUT)) return onCheckedOut(s, input);
      if (isActionAnswer(input.id)) return onLaunched(s, input);
      if (input.id.startsWith(PROTO_START)) return onPrototype(s, input);
      // the ear's Keep awake: said, and the box's box.idle moves the badge back
      if (input.id.startsWith(KEEP_AWAKE))
        return {
          state: s,
          commands: [
            input.reply.ok
              ? balloon(
                  'info',
                  `${input.id.slice(KEEP_AWAKE.length)} kept awake until abe box sleep`,
                )
              : balloon('error', input.reply.error.message),
          ],
        };
      if (input.command === null)
        return relaunched(input.id) ? onRetry(s, input) : { state: s, commands: [] };

      return relaunched(input.id) ? onRetry(s, input) : result(s, input);
    case 'event':
      return onEvent(s, input.event);
    case 'live':
      return onFacts(s, input.facts);
    case 'browser':
      return s.mode === undefined
        ? { state: s, commands: [] }
        : (onMode(s.mode, (mode, m, wrap) => {
            const out = mode.browser(m, input.key, input.event, underOf(s));

            return out === undefined ? undefined : shownBy(s, wrap, out);
          }) ?? { state: s, commands: [] });
    case 'exit':
    case 'blur':
    case 'confirm':
    case 'menu':
    case 'dialog':
    case 'ask':
    case 'comment':
    case 'launch':
    case 'newcard':
    case 'caret':
    case 'no-caret':
    case 'extent':
    case 'review':
    case 'here':
    case 'draft':
    case 'attach':
      return { state: s, commands: [] };
    case 'jump':
      return onJump(s, input);
  }
};

/** The cards the shown tab draws: Team's or Mine's. */
const tabCards = (s: FactoryState): CardData[] | undefined =>
  cardsTab(s.tab) === 'team' ? s.team : s.mine;

// ---------------------------------------------------------------- the tree

/** A selection's look: blue while the Board has the keys, grey while Chat or a layer has them. */
const selection = (selected: boolean, active: boolean): Selection => {
  if (!selected) return 'default';

  return active ? 'selected' : 'selected-inactive';
};

/** A card's last row while its run and session are read. */
const READING = 'Reading…';

/** A done card's last row with no run. */
const DONE_NOTE = '✓ Done';

/** A card launched here before its session starts: no stage, in the starting hue. */
const LAUNCHING_ROW: RailRow = {
  segments: RAIL_STAGES.map(() => 'todo'),
  glyph: '●',
  word: 'Launching…',
  state: 'starting',
};

/**
 * The card's last row: its run's rail row; `Reading…` until the runs and sessions are in; a live
 * session's, else `No session` (`✓ Done` on a done card).
 */
const cardRow = (c: CardItem, s: FactoryState): Pick<BoardCard['props'], 'rail' | 'note'> => {
  const list = boxesHere(s);
  const live = c.run === undefined ? c.session : sessionsById(s).get(c.run.session);

  // its launch sent (here or anywhere), no session of it yet: Launching, never its last run's row
  if (launchGoing(s, c.card.id, live) && (live === undefined || live.state === 'ended'))
    return { rail: LAUNCHING_ROW };
  if (c.run !== undefined && c.look !== undefined) {
    const own = live;

    const box = boxMarkOf(own, s.boxes ?? {}, { card: c.card.id, list, now: nowMs(s) });

    return { rail: railRow(c.run, c.look, { now: s.now, session: own, box }) };
  }
  // the runs or sessions not in yet: not known to have none, nor which box is its
  const facts = factsRead(s);

  if (facts !== 'read') return { note: { text: facts === 'reading' ? READING : 'Not read' } };
  // no run, a live session: its state, as Chat's header and Sessions say it
  if (c.session !== undefined && c.look !== undefined) {
    const box = boxMarkOf(c.session, s.boxes ?? {}, { card: c.card.id, list, now: nowMs(s) });

    return { rail: sessionRailRow(c.session, c.look, { now: s.now, box }) };
  }

  // no run: still its box's mark when a box is tagged with the card
  const box = boxMarkOf(undefined, s.boxes ?? {}, { card: c.card.id, list, now: nowMs(s) });
  const mark = box === undefined ? {} : { box };

  // a done card with no run (closed by hand): done, not waiting on a session
  return { note: { text: isDone(c.card.state) ? DONE_NOTE : 'No session', ...mark } };
};

const cardNode = (c: CardItem, s: FactoryState, sel: Selection): BoardCard => {
  const reason = c.run?.reason ?? null;
  // a cloud launch: its whole step and, once late, what is late
  const own = c.run === undefined ? c.session : sessionsById(s).get(c.run.session);
  const launch =
    own?.state === 'starting' && own.launch !== null && s.now !== undefined
      ? launchLook(own.launch, s.now)
      : undefined;
  // a board On this Mac: its cards are its own, never dashed
  const local = onThisMac(s)
    ? undefined
    : cardLocal(s.local?.view, c.card, boardName(s.board?.organization));
  const tooltip = [
    `#${cardName(c.card.id)} ${c.card.title}`,
    ...[launch?.line ?? c.look?.word].filter((w) => w !== undefined),
    ...(launch?.note === undefined ? [] : [launch.note]),
    ...(reason === null ? [] : [reason]),
  ].join(' · ');

  return {
    kind: 'BoardCard',
    id: `card:${c.card.id}`,
    props: {
      card: c.card.id,
      // its prototype's mark, also once launched
      ...(hasPrototype(c.card) ? { prototype: true } : {}),
      type: typeBadge(c.card.type),
      ...(c.card.type === 'Bug' ? { bug: true } : {}),
      ...(c.card.assignee === null ? {} : { initials: initials(c.card.assignee.name) }),
      ...(c.card.points === null ? {} : { points: pointsText(c.card.points) }),
      title: c.card.title,
      ...cardRow(c, s),
      emphasis: c.look?.emphasis ?? 'normal',
      ...(c.theirs ? { theirs: true } : {}),
      ...(isDone(c.card.state) ? { closed: true } : {}),
      selection: sel,
      // local mode: its state here over the board's, dashed
      ...(local === undefined ? {} : { local }),
      tooltip: local === undefined ? tooltip : `${tooltip} · ${local}`,
      ...(reason === null ? {} : { tipAdds: true }),
    },
  };
};

/** The Board's width for its columns: the view's (or slot's), less the pads. */
const columnsWidth = (s: FactoryState): number => s.size.width - 2 * EDGE - 2 * COLUMN_PAD;

/**
 * Each column's scroll and the leftmost column shown (the Board scrolled sideways), within what
 * they can show; with `follow` moved as little as shows the ring. The wheel scrolls without moving
 * the ring, so only a key, a click, a new size or the ring moved follow it.
 */
const settleScroll = (s: FactoryState, follow: boolean): FactoryState => {
  const cols = columnsOf(s);
  const l = columnLayout(columnsWidth(s), cols.length);
  const places = settlePlaces(s.card, s.places, navOf(s, cols), columnRows(boardSize(s)), follow);
  let first = 0;

  if (l.scrolled)
    first = follow
      ? firstShown(s.first, cardAt(s, cols).col, l.fits, cols.length)
      : Math.max(0, Math.min(s.first, cols.length - l.fits));

  return { ...s, places, first };
};

/** The ring as the view follows it: its tab, its column and its card (its row while it has none). */
const ringKey = (s: FactoryState): string => {
  const at = cardAt(s, columnsOf(s));

  return `${s.tab} ${at.col} ${s.card.id ?? `row ${at.row}`}`;
};

/** Keys that bring the ring into view even where it cannot move (ö on the last card). */
const isMove = (key: string): boolean => LEFT.has(key) || RIGHT.has(key) || isListMove(key);

/** The wheel over a column, or over the columns sideways: the view moves, the ring stays. */
const onScroll = (s: FactoryState, id: string, x: number, y: number): FactoryState => {
  // the Board hidden under a mode stays as it was
  if (s.mode !== undefined) return s;
  if (id === SESSIONS_TABLE) return { ...s, list: listScroll(s.list, y, sessionsList(s)) };
  const cols = columnsOf(s);

  if (id === 'columns') return { ...s, first: s.first + x };
  if (!id.startsWith('col:')) return s;
  const key = `${s.tab}:${id.slice('col:'.length)}`;

  return { ...s, places: scrolled(s.places, navOf(s, cols), key, y, columnRows(boardSize(s))) };
};

/** The card list the shown tab draws. */
const tabRead = (s: FactoryState): ReadId =>
  cardsTab(s.tab) === 'mine' ? 'cards:mine' : 'cards:team';

/** Each tab's name, and what it shows in `:`'s rows. */
const TAB_WORDS: Readonly<Record<Tab, { label: string; dim: string }>> = {
  mine: { label: 'Mine', dim: 'your cards' },
  team: { label: 'Team', dim: "the team's cards" },
  sessions: { label: 'Sessions', dim: 'your sessions on the sprint and the Abe chats, to read' },
};

/** The Board's header: `Board`, Mine · Team · Sessions, `Sprint 1 · 3 cards`; the filter, a read going on or why it is not read. */
const boardHeader = (s: FactoryState, active: boolean): BoardHeader => {
  if (s.tab === 'sessions') return sessionsHeader(s, active);
  const read = tabCards(s);
  const cards = read ?? [];
  const failure = s.failed[tabRead(s)];
  const sprint = s.sprint === null || s.sprint === undefined ? [] : [s.sprint];
  let note: string | undefined;

  // read again (r, the clock after a failure): said until it answers; a first read says
  // so in its first column instead
  const again = s.pending.includes(tabRead(s)) && (read !== undefined || failure !== undefined);
  const typed = (f: NonNullable<FactoryState['filter']>) =>
    f.typing ? withCaret(fieldOf(f.text, f.caret)) : f.text;

  const hint = installHint(s);

  if (s.filter !== undefined) note = `/${typed(s.filter)}${again ? ' · Reading…' : ''}`;
  else if (again) note = 'Reading…';
  // a repo not in the Factory: its board not read is why, so the hint says it in its place
  else if (hint !== undefined) note = hint.text;
  else if (failure !== undefined) note = `Board not read · ${failure}`;
  const cols = columnsOf(s);
  const l = columnLayout(columnsWidth(s), cols.length);
  // scrolled sideways: the columns out of view named at the right
  const more = l.scrolled
    ? columnsOutOfView(
        cols.map((c) => ({
          name: c.name,
          ...(read === undefined ? {} : { count: c.cards.length }),
        })),
        s.first,
        l.fits,
      )
    : undefined;

  return {
    kind: 'BoardHeader',
    id: 'board-head',
    props: {
      title: 'Board',
      tabs: TABS.map((t) => ({ id: `tab:${t}`, label: TAB_WORDS[t].label })),
      selected: `tab:${s.tab}`,
      active,
      // Until the board answers it counts nothing.
      counts:
        read === undefined
          ? []
          : [
              {
                text: [...sprint, `${cards.length} card${cards.length === 1 ? '' : 's'}`].join(
                  ' · ',
                ),
                hue: 'dim',
              },
            ],
      ...(note === undefined ? {} : { note }),
      ...(more === undefined ? {} : { more }),
    },
  };
};

/** The Sessions tab's header: its count, a read going on, why the sessions were not read. */
const sessionsHeader = (s: FactoryState, active: boolean): BoardHeader => {
  const rows = sessionsList(s).all.length;
  const reading = s.pending.includes('sessions') && s.sessions !== undefined;
  const failure = s.failed.sessions;
  let note: string | undefined;

  if (reading) note = 'Reading…';
  else if (failure !== undefined) note = `Sessions not read · ${failure}`;

  return {
    kind: 'BoardHeader',
    id: 'board-head',
    props: {
      title: 'Board',
      tabs: TABS.map((t) => ({ id: `tab:${t}`, label: TAB_WORDS[t].label })),
      selected: 'tab:sessions',
      active,
      counts:
        s.sessions === undefined
          ? []
          : [{ text: `${rows} session${rows === 1 ? '' : 's'}`, hue: 'dim' }],
      ...(note === undefined ? {} : { note }),
    },
  };
};

/** What the Sessions tab says with no row to show: being read, none matching, none at all. */
const sessionsEmpty = (s: FactoryState): { title: string; line: string } => {
  if (s.sessions === undefined || (s.runs === undefined && s.failed.runs === undefined))
    return { title: 'Asking abe serve', line: 'Your sessions, a moment' };
  const typed = s.list.filter?.text.trim() ?? '';

  if (typed !== '') return { title: `No sessions match “${typed}”`, line: 'Esc clears the filter' };

  return {
    title: `No sessions in ${s.sprint ?? 'this sprint'}`,
    line: '⌘⏎ on a card: Launch agent',
  };
};

/**
 * The Sessions tab's Table: your sessions on the sprint's stories and the Abe chats, as the pane's
 * Sessions lists them, the rows that fit from its window; to read (⏎ Chat on one), never a
 * workspace.
 */
const sessionsTable = (s: FactoryState): Table => {
  const l = sessionsList(s);
  const { rows, selected } = windowed(s.list, l);
  const note = filterNote(s.list, l);

  return {
    kind: 'Table',
    id: SESSIONS_TABLE,
    props: {
      columns: SESSION_COLUMNS,
      rows: rows.map((r) => ({
        id: `${SESSION_ROW}${r.session.id}`,
        cells: sessionCells(
          { boxes: s.boxes ?? {}, ...(s.now === undefined ? {} : { now: s.now }) },
          r,
        ),
      })),
      ...(selected === undefined ? {} : { selected: `${SESSION_ROW}${selected.session.id}` }),
      ...(note === undefined ? {} : { note }),
      ...(s.list.filter === undefined ? {} : { filter: s.list.filter.text }),
      ...(rows.length === 0
        ? { empty: sessionsEmpty(s) }
        : {
            foot: [
              { keys: '⏎', label: 'chat' },
              { keys: '⌘⏎', label: 'actions' },
            ],
          }),
    },
  };
};

const boardIsland = (s: FactoryState): Node => {
  if (s.tab === 'sessions')
    return island(
      [
        stack('column', [boardHeader(s, s.away !== true), sessionsTable(s)], {
          sizes: ['auto', { flex: 1 }],
        }),
      ],
      'board',
    );
  const cols = columnsOf(s);
  const at = cardAt(s, cols);
  const active = s.away !== true;
  const read = tabCards(s);
  const rows = columnRows(boardSize(s));
  // an empty sprint says so in its first column, a filter that hides every card, and a
  // first read going on: never four empty columns that look like an empty sprint
  const hidden = filterText(s) !== '' && cols.every((c) => c.cards.length === 0);
  const reading =
    read === undefined && s.pending.includes(tabRead(s)) && s.failed[tabRead(s)] === undefined;
  let none: string | undefined;

  // a board on this machine has no sprints
  if (read?.length === 0)
    none = onThisMac(s) ? 'No cards yet' : `No stories in ${s.sprint ?? 'this sprint'}`;
  else if (reading) none = 'Reading the board…';
  else if (hidden) none = 'No cards match';
  const nav = navOf(s, cols);
  const newable = noBoard(s) === undefined && filterText(s) === '';
  const columns = cols.map((c, i): BoardColumn => {
    const w = windowOf(c.cards.length, startOf(s.places, nav[i], rows), rows);

    return {
      kind: 'BoardColumn',
      id: `col:${c.name}`,
      props: {
        name: c.name,
        // a column not read counts nothing
        ...(read === undefined ? {} : { count: c.cards.length }),
        ...(w.note === '' ? {} : { note: w.note }),
        ...(active && i === at.col ? { focused: true } : {}),
        ...(i === 0 && none !== undefined ? { empty: none } : {}),
        // read, empty, and not done: a column a card is made in
        ...(read !== undefined &&
        c.cards.length === 0 &&
        c.name !== OTHER &&
        !isDone(c.name) &&
        newable
          ? { add: '＋ New card' }
          : {}),
      },
      children: c.cards
        .slice(w.start, w.end)
        .map((x, j) => cardNode(x, s, selection(i === at.col && j + w.start === at.row, active))),
    };
  });
  const body: Node = {
    kind: 'BoardColumns',
    id: 'columns',
    props: columnsProps(columnsWidth(s), cols.length, s.first),
    children: columns,
  };

  const board = island(
    // grey while its slot has not the keys (the Chat column has them)
    [stack('column', [boardHeader(s, active), body], { sizes: ['auto', { flex: 1 }] })],
    'board',
  );
  const view = s.local?.view;

  // local mode, or the board read-only alone: the band over it
  return view !== undefined && bandOver(s)
    ? stack('column', [localBand(view), board], { sizes: ['auto', { flex: 1 }], gap: 6 })
    : board;
};

/** The Factory view's main area: the Board, or in its place a Sheet as a tab or a local pull request. */
const mainSlot = (s: FactoryState): Node =>
  (s.mode === undefined ? undefined : onMode(s.mode, (mode, m) => mode.view(m, underOf(s)))) ??
  boardIsland(s);

/** The Factory view: its main slot only; Chat is the window's column. */
export const viewFactory = (s: FactoryState): Node => mainSlot(s);

export const FACTORY_INIT: FactoryState = {
  size: { width: 0, height: 0 },
  tab: 'mine',
  list: { top: 0, g: false },
  failed: {},
  pending: [],
  again: [],
  card: { col: 0, row: 0 },
  first: 0,
  places: {},
  g: false,
  actions: NO_CARD_ACTIONS,
  opened: false,
};

/**
 * `:install`'s commands: Chat on the repo's Abe chat, the install's parts beside it, with the keys;
 * Chat asks `abe install` (the `install` open param), which opens the Abe chat on `/abe:install`.
 */
export const INSTALL_COMMANDS: readonly Command[] = [
  { kind: 'open', screen: 'chat', params: { install: '1' }, slot: 'chat' },
  { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
  // the person types there next
  { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
];

/** The Board's words in Command mode: `:install`, `:board`, `:show`. */
const FACTORY_WORDS: readonly Word[] = [
  {
    word: 'install',
    summary:
      'set this repo up for Abe: the Abe chat follows /abe:install, checking each part, its parts beside it until the install is Done',
    commands: INSTALL_COMMANDS,
  },
  {
    word: 'board',
    summary: 'the Board',
    commands: [
      { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
      { kind: 'open', screen: 'factory' },
    ],
  },
  {
    word: 'show',
    summary: "open a Sheet as a tab: the current card's and session's first",
    ask: [
      {
        name: 'name',
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the Sheet, as words (`cart totals`)',
      },
    ],
    commands: (values) => [
      { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
      { kind: 'choice', menu: 'show', row: values.join(' ').trim() },
    ],
  },
  {
    word: 'held',
    summary: 'Held writes: what local mode kept on this machine instead of sending (⏎ opens one)',
    commands: [
      { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
      { kind: 'choice', menu: 'local', row: 'held' },
    ],
  },
  {
    word: 'discard-local',
    summary:
      'Discard local changes: the board changes held on this machine dropped (asked first); nothing is sent',
    commands: [
      { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
      { kind: 'choice', menu: 'local', row: 'discard' },
    ],
  },
];

/** The Board's own rows in `:`: handed back to it as choices of this menu. */
export const BOARD_VIEW_MENU = 'board:view';

/** The Board's rows in `:`'s view group: New card…, the other tabs. */
const boardView = (s: FactoryState): ViewRows => ({
  title: 'Board',
  menu: {
    kind: 'menu',
    id: BOARD_VIEW_MENU,
    title: 'Board',
    rows: [
      {
        id: 'new-card',
        text: 'New card…',
        dim: s.sprint === undefined || s.sprint === null ? 'on the board' : `in ${s.sprint}`,
        ...(noBoard(s) === undefined ? {} : { reason: noBoard(s) }),
        does: { kind: 'back' },
      },
      // the other tabs, Tab's next first
      ...[1, 2].map((by): MenuRow => {
        const t = TABS[(TABS.indexOf(s.tab) + by) % TABS.length] ?? 'mine';

        return {
          id: `tab:${t}`,
          text: TAB_WORDS[t].label,
          dim: TAB_WORDS[t].dim,
          ...(by === 1 ? { key: 'Tab' } : {}),
          does: { kind: 'back' },
        };
      }),
      ...localRows(s),
    ],
  },
});

/** Held writes' (local changes') count in `:`'s row: never sent. */
const heldWords = (n: number, one = 'write'): string =>
  n === 0 ? 'none yet' : `${n} ${n === 1 ? one : `${one}s`} on this machine, never sent`;

/** A `:` row handed back to the Board. */
const BACK = { kind: 'back' } as const;

/**
 * `:`'s local rows: while local mode is on, or the board read-only alone, its held writes (the
 * board's local changes), Discard local changes… while any is held, local mode's way out.
 */
const localRows = (s: FactoryState): MenuRow[] => {
  const view = s.local?.view;

  if (view === undefined || !bandOver(s)) return [];
  const on = localOn(s.local);
  const changes = boardChanges(view).length;

  return [
    on
      ? { id: 'local-held', text: 'Held writes', dim: heldWords(view.held.length), does: BACK }
      : { id: 'local-held', text: 'Local changes', dim: heldWords(changes, 'change'), does: BACK },
    ...(changes === 0
      ? []
      : [
          {
            id: 'local-discard',
            text: 'Discard local changes…',
            dim: 'the board as it is; nothing is sent',
            does: BACK,
          },
        ]),
    ...(on
      ? [
          {
            id: 'local-off',
            text: 'Local mode off…',
            dim: 'Settings › Local mode; nothing held is sent',
            does: BACK,
          },
        ]
      : []),
  ];
};

/**
 * Where the Board's keys are, for `:` and `?`: the selected card as the Subject (its Action menu),
 * the Board's own rows; a board is in force. A Sheet has the keys: no Subject.
 */
const factoryHere = (s: FactoryState): Here => {
  const f = s.mode !== undefined ? undefined : cardFacts(s, selectedCard(s));

  return {
    keys: 'view',
    // `New card “…”` only where the board was read
    board: noBoard(s) === undefined,
    view: boardView(s),
    ...(f === undefined ? {} : { subject: cardSubject(f) }),
  };
};

/** The watch's events it takes: its own reads' moves, Local mode's, a box about to sleep, a Sheet attached; any other never re-views it. */
const FACTORY_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'settings.changed',
  'install.changed',
  'local.held',
  'local.pr',
  'local.discarded',
  'box.idle',
  'sheet.attached',
]);

export const factoryScreen: Screen<FactoryState> = {
  events: FACTORY_EVENTS,
  name: 'factory',
  init: FACTORY_INIT,
  step: withShortAsk(stepFactory),
  view: viewFactory,
  linked: factoryLinked,
  follows: () => FOLLOWS,
  // the `/` filter takes every key, `?` too
  typing: (s) =>
    s.filter?.typing === true || (s.tab === 'sessions' && s.list.filter?.typing === true),
  // a cloud launch's clock by the second
  seconds: (s) => launchTicking(s.sessions),
  words: FACTORY_WORDS,
  here: factoryHere,
};
