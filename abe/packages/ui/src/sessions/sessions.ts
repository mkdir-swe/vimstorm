/**
 * The Sessions tab (#107 S4, board F-Sessions): the bottom pane's `sessions` screen, a Table of your
 * sessions on the sprint's stories, one 30 px row each (live ones, ended ones whose run is not
 * cleared, and a plain one you stopped while it stands for its card, #332). It reads `session
 * list`, `factory status` and `card list` once on open; after that `session.state`,
 * `session.subagent`, `session.moved`, `factory.stage` and `box.state` change rows in place (an
 * unknown session is read by its id, an unknown run by its card), and the clock's `tick` moves the
 * times.
 *
 * Selection follows the Factory view's card: the `open` param `card` selects its row. A row you
 * move onto browses the window to it (`workspace-page` with `browse`: its workspace's page, Chat on
 * it, the keys staying here). ⏎ is Chat on the
 * row's session (`chat {card, session}` in the chat slot, the `focus` effect giving it the keys)
 * beside its workspace's page (`workspace-page`), ⌘⏎ its actions (Open card its card).
 */
import { type ShortRuns, withShortAsk } from '../board/launch-short';
import {
  hasCard,
  sameRepo,
  SESSION_COLUMNS,
  sessionCells,
  type SessionRow,
  sessionRows,
} from '../board/session-rows';
import type { CardData, Event, FactoryRunData, RepoHere, SessionData } from '@abe/core';
import {
  BOX_SLEPT_WAITING,
  type CardStanding,
  endRow,
  notReproducedRow,
  relaunchAnswer,
  reopenCard,
  reopenDim,
  RETRY_RUN,
  retriesRun,
  retryCard,
  sessionReopens,
  sleptWhileWaiting,
  stopCard,
} from '../board/card-actions';
import { type BoxMoves, type Facts, type LiveRead } from '../live';
import { type Node, type Table, island } from '../runtime/components';
import { launchTicking, isDone, matches, NEVER_PLACED } from '../board/flow';
import { jumpCommands } from '../board/jumps';
import { type ViewSize } from '../runtime/protocol';
import {
  type Answer,
  type Command,
  type Input,
  type MenuRow,
  type Refused,
  type Screen,
  type Here,
} from '../runtime/runtime';
import {
  filterNote,
  fits,
  listClick,
  listKey,
  listScroll,
  selectOn,
  type ListOf,
  type ListPlace,
  listText,
  released,
  reopened,
  selectedRow as listSelected,
  settle as settleList,
  shownRows as listShown,
  windowed,
} from '../runtime/table-list';

/** Which view the pane is under: what ⏎ and a selection do (the host's `open` param `view`). */
export type PaneView = 'factory' | 'editor';

export type SessionsState = ListPlace & {
  /** Retry runs and Reopens asked, their argv until answered (`launch-short.ts`, #9). */
  shortRuns?: ShortRuns | undefined;
  /** The live facts last handed: the sessions, runs and boxes' moves are theirs. */
  facts?: Facts | undefined;
  /** Another repo's project shown: the live lists held are the one before's until read here. */
  foreign?: readonly LiveRead[] | undefined;
  opened: boolean;
  view: PaneView;
  root?: string;
  size?: ViewSize;
  now?: string;
  sessions?: SessionData[];
  /** `session list`'s `boxes`, or a `boxes.unread` event's message: box sessions not read. */
  boxesUnread?: string;
  runs?: FactoryRunData[];
  /**
   * The repo `session list` / `factory status` were read in (#256): the rows are that repo's
   * sessions, the sprint's cards being its board's (another repo's may have the same number).
   */
  here?: RepoHere | undefined;
  cards?: CardData[];
  sprint?: string | null;
  /** Why a read failed, by what was read; cleared when it reads again. */
  failed: Partial<Record<'sessions' | 'runs' | 'cards', string>>;
  /** Boxes' last `box.state` moves, by name. */
  boxes: BoxMoves;
  /** The Factory view's card (the `card` param): its row is selected once rows come. */
  card?: number;
};

type Out = { state: SessionsState; commands: Command[] };

const INIT: SessionsState = {
  opened: false,
  view: 'factory',
  failed: {},
  boxes: {},
  top: 0,
  g: false,
};

/** The sprint's cards (live's team list, its open ones): the stories whose sessions show. */
const CARDS_READ: Command = { kind: 'live', reads: ['cards:team'] };

/** The Board's reads: its cards, and the live runs again (`Board not read · …` while one failed). */
const BOARD_READS: readonly Command[] = [{ kind: 'live', reads: ['cards:team', 'runs'] }];

/** The footer's keys, each on the selected session's row. */
const FOOT = [
  { keys: '⏎', label: 'chat' },
  { keys: '⌘⏎', label: 'actions' },
];

/**
 * The rows wait for the runs too (#315): a row's stage, state and place come from its run, so rows
 * drawn before would show `—`, miss ended ones and move under the keys once the runs are in. A
 * runs read that failed shows them as the sessions say.
 */
const runsUnread = (s: SessionsState): boolean =>
  s.runs === undefined && s.failed.runs === undefined;

const filterText = (s: SessionsState): string => s.filter?.text ?? '';

/** The boxes' note, a row a line: why they were not read, or each box that did not answer. */
const boxNotes = (s: SessionsState): string[] =>
  s.boxesUnread === undefined ? [] : s.boxesUnread.split('\n');

/** The rows' room: what fits, less the unread boxes' note row. */
const roomOf = (s: SessionsState): number => Math.max(1, fits(s.size) - boxNotes(s).length);

/** The rows as the list sees them (`table-list.ts`): a row is its session. */
const listOf = (s: SessionsState): ListOf<SessionRow> => ({
  // none until the runs are in too (#315)
  all: runsUnread(s) ? [] : sessionRows(s),
  keyOf: (r) => r.session.id,
  matches: (r, f) => matches({ card: r.card, title: r.title }, f),
  room: roomOf(s),
});

/** The rows the filter leaves, in the list's order. */
const shownRows = (s: SessionsState): SessionRow[] => listShown(s, listOf(s));

/** The selected row: by its session while it shows, else the first. */
const selectedRow = (s: SessionsState): SessionRow | undefined => listSelected(s, listOf(s));

/** The selection on the row of `card` (the first in order), if it has one. */
const onCard = (s: SessionsState, card: number | undefined): SessionsState => {
  if (card === undefined) return s;
  // a row of that card already selected (the Board told of a card it selected from here) stays
  const row =
    selectedRow(s)?.card === card ? selectedRow(s) : shownRows(s).find((r) => r.card === card);

  if (row === undefined) return s;
  // placed: the Board's card waits no more (later reads keep what you select)
  const next: SessionsState = selectOn(s, row.session.id);

  delete next.card;

  return next;
};

/** The state with its selection settled: a row that went away gives way to its neighbour. */
const settle = (s: SessionsState): SessionsState => settleList(s, listOf(s));

/**
 * Moving onto a row browses to it, the keys staying here (`workspace-page` with `browse`): the
 * shell shows the session's workspace on the page it last had, Chat pinned on the session; with
 * none open, Chat on it alone (the Board selecting its card), and says so.
 */
const browse = (row: SessionRow | undefined): Command[] =>
  row === undefined
    ? []
    : [
        {
          kind: 'shell',
          effect: {
            kind: 'workspace-page',
            path: row.session.worktree,
            ...(hasCard(row) ? { card: row.card } : {}),
            session: row.session.id,
            browse: true,
          },
        },
      ];

/** After a person's input: the window browses to the selected row once it is another one. */
const selecting = (before: SessionsState, after: SessionsState): Out => {
  const next = settle(after);
  const was = selectedRow(settle(before));
  const now = selectedRow(next);

  return { state: next, commands: was?.session.id === now?.session.id ? [] : browse(now) };
};

/**
 * ⏎: Chat on the row's session with the keys; the main area its workspace's page (`workspace-page`:
 * the shell knows the page it last had there), else the Factory view on its card. Unpinned (a
 * Retry: Chat on the card): on the Factory view its card is selected; on the Editor its own
 * workspace keeps the Editor, another's shows the Factory view on its card.
 */
const chatOn = (s: SessionsState, row: SessionRow, pin = true): Command[] => {
  // a chat: Chat pinned on it, shown, wherever you are
  if (row.chat === true)
    return [
      { kind: 'open', screen: 'chat', params: { session: row.session.id }, slot: 'chat' },
      { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
    ];
  const chat: Command = {
    kind: 'open',
    screen: 'chat',
    params: pin ? { card: String(row.card), session: row.session.id } : { card: String(row.card) },
    slot: 'chat',
  };
  const keys: Command = { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } };

  if (pin)
    return [
      {
        kind: 'shell',
        effect: { kind: 'workspace-page', path: row.session.worktree, card: row.card },
      },
      chat,
      keys,
    ];
  const here = s.root?.replace(/\/+$/, '') === row.session.worktree.replace(/\/+$/, '');

  if (s.view === 'editor' && here) return [chat, keys];

  return [
    ...(s.view === 'editor'
      ? [{ kind: 'shell' as const, effect: { kind: 'view' as const, view: 'factory' as const } }]
      : []),
    { kind: 'open', screen: 'factory', params: { card: String(row.card) }, slot: 'main' },
    chat,
    keys,
  ];
};

const live = (x: SessionData) => x.state !== 'ended';

/**
 * ⌘⏎: the session's actions, as Chat's menu (#113, #219): first Chat on a live one, or Reopen an
 * ended one (#343: the same session and conversation, ⏎ too), then Retry run on a run not over (a
 * new session from decide); Stop… while it runs; a Factory run's End: can't reproduce and End
 * run… (#184); the jumps.
 */
export const sessionMenu = (s: SessionsState, row: SessionRow): Command => {
  const x = row.session;

  if (row.chat === true) return chatMenu(row);
  const first: MenuRow[] = live(x)
    ? [{ id: 'resume', text: 'Open Chat', dim: 'Chat on it', key: '⏎', does: { kind: 'back' } }]
    : [
        {
          id: 'reopen',
          text: 'Reopen',
          dim: reopenDim(x.since, s.now),
          key: '⏎',
          // a session goes on and spends: never where the menu rests (#313)
          costly: true,
          ...(sessionReopens(x)
            ? {}
            : {
                reason: x.neverPlaced === true ? NEVER_PLACED : 'no conversation to go back into',
              }),
          does: { kind: 'back' },
        },
        ...(row.run === undefined || !retriesRun(row.run)
          ? []
          : [
              {
                id: 'retry',
                text: RETRY_RUN,
                dim: 'a new session from decide, same worktree',
                costly: true,
                // a box that slept while it waited goes on in the cloud (#192), the run's Launch
                // note and workflow again (#347): the card actions' Retry run
                does: { kind: 'back' as const },
              },
            ]),
      ];

  return {
    kind: 'menu',
    id: `session:${x.id}`,
    title: `#${row.card} ${row.title}`,
    // the safe next step first, where the menu opens and ⏎ goes (#278); Stop… never there
    rows: [
      ...first,
      {
        id: 'stop',
        text: 'Stop…',
        ...(live(x) ? {} : { reason: 'no session running' }),
        // asked first, then stopped: the card actions' Stop…
        does: { kind: 'back' },
      },
      ...(row.run === undefined
        ? []
        : [...notReproducedRow(row.card, row.run), endRow(row.card, row.run)]),
      {
        id: 'workspace',
        text: 'Open workspace',
        // one that never got a box has none (#246)
        ...(x.neverPlaced === true ? { reason: NEVER_PLACED } : {}),
        does: { kind: 'back' },
      },
      { id: 'story', text: 'Open card', does: { kind: 'back' } },
      { id: 'linked', text: 'Linked', key: '⌃L', does: { kind: 'back' } },
    ],
  };
};

/** A chat's ⌘⏎: Open Chat (on it), Stop…, its card's story rows when it has one. */
const chatMenu = (row: SessionRow): Command => {
  const x = row.session;
  const card = hasCard(row) ? row.card : undefined;

  return {
    kind: 'menu',
    id: `session:${x.id}`,
    title: row.title,
    rows: [
      { id: 'resume', text: 'Open Chat', dim: 'Chat on it', key: '⏎', does: { kind: 'back' } },
      {
        id: 'stop',
        text: 'Stop…',
        does: {
          kind: 'run',
          argv: ['session', 'stop', x.id],
          risky: true,
          confirm: {
            question: `Stop ${row.title}?`,
            details: ['Its Claude Code stops; its conversation is kept.'],
            yes: 'Stop',
          },
          done: `Stopped ${row.title}`,
        },
      },
      ...(card === undefined
        ? []
        : [
            { id: 'story', text: 'Open card', does: { kind: 'back' as const } },
            { id: 'linked', text: 'Linked', key: '⌃L', does: { kind: 'back' as const } },
          ]),
    ],
  };
};

/**
 * ⏎ on a row (#343): Chat on a live session; an ended one of a card is reopened, this row's own
 * (an older one too: picked here), Chat on it.
 */
const reopenOf = (s: SessionsState, row: SessionRow): Command[] =>
  sessionReopens(row.session) ? [...reopenCard(cardOf(row)), ...chatOn(s, row)] : chatOn(s, row);

/** A row's card as the card actions see it: a session here is yours. */
const cardOf = (row: SessionRow): CardStanding => ({
  card: { id: row.card, assignee: null },
  run: row.run,
  session: row.session,
  mine: true,
});

const onKey = (s0: SessionsState, raw: string): Out => {
  // the moves and the `/` filter are the list's (`table-list.ts`), its order held from here
  const { state: s, key } = listKey(s0, raw, listOf(s0));
  const row = selectedRow(s);

  if (key === undefined) return selecting(s0, s);
  // Esc with no filter is the pane's: the keys go back (#116)
  if (row === undefined || key === '<Esc>') return { state: s, commands: [] };
  // an ended one reopens (#343): its box slept while it waited, ⏎ wakes it there too
  if (key === '<CR>') return { state: s, commands: reopenOf(s, row) };

  return key === '<D-CR>'
    ? { state: s, commands: [sessionMenu(s, row)] }
    : { state: s, commands: [] };
};

const SESSION_ROW = 'session:';

const onClick = (s: SessionsState, id: string): Out => {
  if (!id.startsWith(SESSION_ROW)) return { state: s, commands: [] };

  return selecting(s, listClick(s, id.slice(SESSION_ROW.length), listOf(s)));
};

/** A row of the session menu, handed back by Command mode. */
const onChoice = (s: SessionsState, menu: string, choice: string): Out => {
  const of = menu.startsWith(SESSION_ROW) ? menu.slice(SESSION_ROW.length) : undefined;
  const row = sessionRows(s).find((r) => r.session.id === of);

  if (row === undefined) return { state: s, commands: [] };
  if (choice === 'resume') return { state: s, commands: chatOn(s, row) };
  if (choice === 'reopen') return { state: s, commands: reopenOf(s, row) };
  if (choice === 'retry') return { state: s, commands: retryCard(cardOf(row), s.root) };
  if (choice === 'stop') return { state: s, commands: stopCard(row.card, row.session) };
  // the jumps' rows (as Boxes' rows)
  if (choice === 'workspace' || choice === 'story' || choice === 'linked')
    return { state: s, commands: jumpCommands(choice, row.card) };

  return { state: s, commands: [] };
};

const onResult = (s: SessionsState, input: Answer | Refused): Out => {
  const id = input.id;

  // A Reopen or Retry run (#343): refused, its one line, never a read that failed
  if (id.startsWith('reopen:') || id.startsWith('retry:'))
    return { state: s, commands: relaunchAnswer(input) };

  return { state: s, commands: [] };
};

const onEvent = (s: SessionsState, event: Event): Out => {
  switch (event.type) {
    default:
      // (the sessions, runs and cards are live's: read again there after a break)
      return onBoardEvent(s, event);
  }
};

/** The live facts handed: the rows' sessions and runs, the boxes' moves, what failed of them. */
const onFacts = (s: SessionsState, f: Facts): Out => {
  const foreign = (s.foreign ?? []).filter((r) => f.read[r].root !== s.root);
  // the live reads' failures as live's
  const team = f.read['cards:team'].failed;
  const failed: SessionsState['failed'] = {
    ...(team === undefined ? {} : { cards: team.message }),
    ...(f.read.sessions.failed === undefined ? {} : { sessions: f.read.sessions.failed.message }),
    ...(f.read.runs.failed === undefined ? {} : { runs: f.read.runs.failed.message }),
  };
  const next: SessionsState = { ...s, facts: f, boxes: f.boxMoves, failed };

  if (foreign.length === 0) delete next.foreign;
  else next.foreign = foreign;
  for (const r of ['sessions', 'runs'] as const) {
    if (foreign.includes(r)) continue;
    if (r === 'sessions') {
      if (f.sessions === undefined) delete next.sessions;
      else next.sessions = f.sessions;
    } else if (f.runs === undefined) delete next.runs;
    else next.runs = f.runs;
  }
  if (foreign.length === 0 && f.here !== undefined) next.here = f.here;
  // the sprint's open cards (the team's list has its done ones too)
  if (f.team !== undefined && f.team !== s.facts?.team) {
    next.cards = f.team.cards.filter((c) => !isDone(c.state));
    next.sprint = f.team.sprint;
  }
  if (f.boxesUnread === undefined) delete next.boxesUnread;
  else next.boxesUnread = f.boxesUnread;
  // a new session on a card the sprint read has not (one just made): the cards read again, so
  // its row shows now, not on the next open
  const had = new Set((s.sessions ?? []).map((x) => x.id));
  const unknown =
    s.sessions !== undefined &&
    next.cards !== undefined &&
    (next.sessions ?? []).some(
      (x) =>
        !had.has(x.id) &&
        x.kind === 'card' &&
        x.card !== null &&
        !(next.cards ?? []).some((c) => c.id === x.card),
    );

  return { state: settle(onCard(next, next.card)), commands: unknown ? [CARDS_READ] : [] };
};

const onBoardEvent = (s: SessionsState, event: Event): Out => {
  const none = { state: s, commands: [] };

  switch (event.type) {
    // the board in the settings (an install wrote it to abe.yaml, M3): the Board read again, so
    // its note goes once it reads; another change or an install's move, while a read had failed
    case 'settings.changed':
    case 'install.changed':
      return (event.type === 'settings.changed' && event.data.keys.includes('board')) ||
        s.failed.cards !== undefined ||
        s.failed.runs !== undefined
        ? { state: s, commands: [...BOARD_READS] }
        : none;
    default:
      return none;
  }
};

/** The view an open names (`editor`, else `factory`); one that names none keeps `was`. */
const viewOf = (named: string | undefined, was: PaneView): PaneView => {
  if (named === undefined) return was;

  return named === 'editor' ? 'editor' : 'factory';
};

const onOpen = (s: SessionsState, input: Extract<Input, { kind: 'open' }>): Out => {
  const p = input.params;
  const card = p.card === undefined ? undefined : Number(p.card);
  const next: SessionsState = {
    ...s,
    opened: true,
    size: input.size,
    // the host's; an open that names none (the Board's `ifOpen`) keeps the one it had (#137)
    view: viewOf(p.view, s.view),
    ...(p.root === undefined ? {} : { root: p.root }),
  };

  if (card === undefined || !Number.isInteger(card)) delete next.card;
  else next.card = card;
  const placed = onCard(next, next.card);
  // under the Editor with no card named: the shown workspace's row
  const shown = settle(
    next.card === undefined && next.view === 'editor' ? onRoot(placed, next.root) : placed,
  );

  // opened again (the Board's card, the view): what it holds stays, abe watch keeps it current
  return { state: shown, commands: [] };
};

const bare = (path: string) => path.replace(/\/+$/, '');

/**
 * The shown workspace's row selected (under the Editor the list follows it): a session in `root`,
 * in the main checkout its newest Abe chat conversation; a row of it already selected stays.
 */
const onRoot = (s: SessionsState, root: string | undefined): SessionsState => {
  if (root === undefined) return s;
  const of = (r: SessionRow) =>
    bare(r.session.worktree) === bare(root) ||
    (r.session.kind === 'abe' && bare(r.session.abe?.repo ?? '') === bare(root));

  const selected = selectedRow(s);

  if (selected !== undefined && of(selected)) return s;
  const rows = shownRows(s).filter(of);
  const newest = (a: SessionRow, b: SessionRow) =>
    Date.parse(b.session.startedAt) > Date.parse(a.session.startedAt) ? b : a;
  const abe = rows.filter((r) => r.session.kind === 'abe');
  const row = abe.length > 0 ? abe.reduce(newest) : rows[0];

  return row === undefined ? s : selectOn(s, row.session.id);
};

const stepSessions = (s: SessionsState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return onOpen(s, input);
    case 'resize':
      return { state: settle({ ...s, size: input.size }), commands: [] };
    case 'root': {
      // another project: its sessions, runs and board (#256), read again there
      if (input.root === s.root) return { state: s, commands: [] };
      const next: SessionsState = { ...s, root: input.root };

      // another checkout of the same repo (browsing its sessions): the rows stay while read again,
      // under the Editor the shown workspace's selected
      if (sameRepo(s, input.root))
        return {
          state: next.view === 'editor' ? settle(onRoot(next, input.root)) : next,
          commands: [],
        };

      delete next.here;
      // the other project's rows go (#315): none until this one's sessions and runs are in
      delete next.sessions;
      delete next.runs;
      next.foreign = ['sessions', 'runs'];

      return { state: settle(next), commands: [] };
    }
    case 'tick':
      return { state: { ...s, now: input.at }, commands: [] };
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    // the wheel over the Table moves its rows, not the selection (#323)
    case 'scroll':
      return {
        state: input.id === 'sessions-table' ? listScroll(s, input.y, listOf(s)) : s,
        commands: [],
      };
    case 'text': {
      const typed = listText(s, input.text, listOf(s));

      return typed === undefined ? { state: s, commands: [] } : selecting(s, typed);
    }
    // the list lost the keyboard: its rows sorted afresh; not to a layer opened over it (#264)
    case 'focus':
      return {
        state: input.focused || input.layer === true ? s : settle(released(s)),
        commands: [],
      };
    case 'choice':
      return onChoice(s, input.menu, input.row);
    case 'result':
      return onResult(s, input);
    case 'live':
      return onFacts(s, input.facts);
    case 'event':
      return onEvent(s, input.event);
    default:
      return { state: s, commands: [] };
  }
};

const sprintName = (s: SessionsState) => s.sprint ?? 'this sprint';

const emptyOf = (s: SessionsState): { title: string; line: string } => {
  if (s.failed.sessions !== undefined && s.sessions === undefined)
    return { title: 'abe serve not answering', line: s.failed.sessions };
  if (s.sessions === undefined || runsUnread(s))
    return { title: 'Asking abe serve', line: 'Your sessions, a moment' };
  if (filterText(s) !== '')
    return { title: `No sessions match “${filterText(s)}”`, line: 'Esc clears the filter' };

  return { title: `No sessions in ${sprintName(s)}`, line: '⌘⏎ on a card: Launch agent' };
};

const noteOf = (s: SessionsState): string | undefined => {
  const filter = filterNote(s, listOf(s));

  if (filter !== undefined) return filter;
  const why = s.failed.cards ?? s.failed.runs;

  return why === undefined ? undefined : `Board not read · ${why}`;
};

/** The screen's Table: the rows that fit, from `top`, and the unread boxes' note row. */
export const sessionsTable = (s: SessionsState): Table => {
  const { rows, selected } = windowed(s, listOf(s));
  const unread = boxNotes(s).map((line) => ({
    cells: [{ text: `Box sessions not read: ${line}`, hue: 'dim' as const }],
  }));
  const note = noteOf(s);

  return {
    kind: 'Table',
    id: 'sessions-table',
    props: {
      columns: SESSION_COLUMNS,
      rows: [
        ...rows.map((r) => ({ id: `${SESSION_ROW}${r.session.id}`, cells: sessionCells(s, r) })),
        ...(rows.length === 0 && unread.length === 0 ? [] : unread),
      ],
      ...(selected === undefined ? {} : { selected: `${SESSION_ROW}${selected.session.id}` }),
      ...(note === undefined ? {} : { note }),
      // Esc clears it before it gives the keys back (#263)
      ...(s.filter === undefined ? {} : { filter: s.filter.text }),
      ...(rows.length === 0 && unread.length === 0 ? { empty: emptyOf(s) } : {}),
      // each key acts on a session's row: none, no footer (#294)
      ...(rows.length === 0 ? {} : { foot: FOOT }),
    },
  };
};

/**
 * Another tab took the pane (#156): opened again it draws the rows it last read at once, and reads
 * them anew (`opened` false), the selection and scroll kept; the filter, the failures, the boxes'
 * looks and what it heard go.
 */
const keepSessions = (s: SessionsState): SessionsState => {
  // the boxes' looks are `box.state`'s, heard only while open: the session's own say meanwhile
  const kept: SessionsState = { ...reopened(s), opened: false, failed: {}, boxes: {} };

  delete kept.facts;
  delete kept.card;

  return kept;
};

/** How `Tell …'s session` says where it stands (#346). */
const tellDim = (x: SessionData): string => {
  if (x.state === 'working') return 'it is working';

  return x.state === 'waiting' ? 'it waits on you' : 'it is starting';
};

/**
 * Where the Sessions list's keys are (#346): the selected row as the Subject (its ⌘⏎ rows, an
 * Ask about its card and session, `Tell #N's session` while it runs), the list's keys for `?`.
 */
const sessionsHere = (s: SessionsState): Here => {
  const row = selectedRow(s);
  const menu = row === undefined ? undefined : sessionMenu(s, row);

  if (row === undefined || menu?.kind !== 'menu') return { keys: 'sessions' };
  const x = row.session;

  // a chat: about its session (and its card, if it has one); Tell is its own words in it
  if (row.chat === true)
    return {
      keys: 'sessions',
      subject: {
        caption: row.title,
        label: row.title,
        ask: [...(hasCard(row) ? ['--card', String(row.card)] : []), '--session', x.id],
        menu,
        tell: { session: x.id, whose: row.title, dim: tellDim(x) },
      },
    };

  return {
    keys: 'sessions',
    subject: {
      caption: `#${row.card} ${row.title}`,
      label: `#${row.card}`,
      ask: ['--card', String(row.card), '--session', x.id],
      menu,
      ...(live(x)
        ? { tell: { session: x.id, whose: `#${row.card}`, dim: tellDim(x), card: row.card } }
        : {}),
    },
  };
};

/** The watch's events it takes: the board in the settings (the sessions, runs and cards are live's); any other never re-views it. */
const SESSIONS_EVENTS: ReadonlySet<Event['type']> = new Set([
  'settings.changed',
  'install.changed',
]);

export const sessionsScreen: Screen<SessionsState> = {
  events: SESSIONS_EVENTS,
  name: 'sessions',
  here: sessionsHere,
  init: INIT,
  step: withShortAsk(stepSessions),
  follows: () => ['sessions', 'runs', 'cards:team'],
  keep: keepSessions,
  view: (s): Node => island([sessionsTable(s)], 'sessions'),
  // ⌃L (#106), Open card and Open workspace jump along the selected row's story; `/` types into the filter
  linked: (s) => selectedRow(s)?.card,
  typing: (s) => s.filter?.typing === true,
  // a cloud launch's clock by the second (#142)
  seconds: (s) => launchTicking(s.sessions),
  // the pane's Sessions picked: on the Board's selected card unless the app named one (#107)
  opensOnMainCard: true,
};

export { BOX_SLEPT_WAITING, sleptWhileWaiting };
