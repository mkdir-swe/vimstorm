/**
 * Welcome (#212, board W-Welcome): the window's content when no project is open. Your cards by
 * state and your recent projects; VimStorm stays up when the last project closes and shows this
 * instead.
 *
 * - **The stripe** (#3, #20) is a project window's, drawn by the shell at the window's left edge
 *   from this screen's `stripe` effect: Project (your recent projects), Board; Sessions
 *   and Boxes (no code to sit under: they take the Board's place). Run, Pipelines, Prototype,
 *   Terminal and Git are a workspace's, greyed in its menu. Dots, never counts; Settings is the
 *   gear in Welcome's title bar.
 *
 * - **Its reads** are the Board's, run from home (no repo: the board in force there is the team
 *   Layer's): `card list --mine`, `card list` (Team), `factory status`, `session list`. The
 *   projects come from the app (`projects` open param: `src/projects.rs`' recent list, as JSON).
 * - **The Board island** is a list grouped by state, never Azure columns: Needs you · Needs
 *   someone (Team: a teammate's ask, ◇ dim) · Failed · Running · Ready for review · On test ·
 *   Not started. A row: `#id` · title · repo (dim, hidden with one repo) · stage rail · state ·
 *   time in state. Needs you never folds; the longest other group folds first into `N more…`
 *   (⏎ unfolds it: it then folds last).
 * - **One cursor** runs through the cards and on into the projects (ö past the last card); `/`
 *   filters both. Mine by default, Team on Tab / ⇧Tab.
 * - **⏎** on a card opens its project in the Factory view on that card, launching nothing: its
 *   live session's worktree, a box's workspace (`workspace attach-spec`), the checkout it ran in;
 *   with none, the one recent project at once, else a pick of them. ⏎ / ⇧⏎ on a project opens it.
 *   ⌘⏎ is the row's menu: Open worktree on a local session's card; rows that need the project
 *   dim with `— open the project first`.
 * - Nothing here can be lost, so nothing asks; errors say themselves on the Board's note line
 *   (Welcome has no project to hold balloons).
 */
import type {
  AttachSpec,
  BoardMember,
  BoxData,
  CardData,
  Event,
  FactoryRunData,
  SessionData,
} from '@abe/core';
import { BOXES_OFF } from '@abe/core/box-text';
import { z } from 'zod';
import { cardMenu as sharedCardMenu } from '../board/card-actions';
import {
  assigned,
  assignOn,
  type AssignState,
  isAssignRun,
  keyed,
  NO_ASSIGNS,
  undoAssign,
} from '../board/assign';
import { type RailRow, type RailSegment } from '../board/board';
import {
  type Hue,
  island,
  type Node,
  stack,
  type Table,
  type TableCell,
  type TableRow,
  type ToolWindowHeader,
} from '../runtime/components';
import { type Field, fieldInsert, fieldKey, fieldOf, typedChar } from '../runtime/field';
import {
  cardSession,
  COLUMNS,
  isDone,
  isTheirs,
  initials,
  type Look,
  lookOf,
  RAIL_STAGES,
  railRow,
  sessionOnlyLook,
  sessionRailRow,
  type Standing,
  standing,
} from '../board/flow';
import { workspaceLanding } from '../board/jumps';
import { listMove, movedRow } from '../runtime/list-moves';
import { type NewCardOn } from '../command/new-card';
import { boxesBadge as stripeBoxes } from '../live/box-feed';
import type { Facts, LiveRead } from '../live';
import { type ShellEffect, type StripeItem, type ViewSize } from '../runtime/protocol';
import {
  STRIPE_CLICK,
  STRIPE_MENU,
  stripeAt,
  stripeChangeOf,
  type StripeDrawn,
  stripeGear,
  stripeItems,
  stripeMenu,
  stripeTweaks,
} from '../shell/stripe';
import { type ViewTweak } from '@abe/core';
import {
  type Answer,
  type Command,
  type Here,
  type Input,
  type Menu,
  type MenuRow,
  type Refused,
  type Screen,
  type Word,
} from '../runtime/runtime';
import { storyDialog } from '../board/story';
import { boxRows, liveSessions, MARK_HUES, sessionRow, sessionsCounts } from './welcome-pages';

export const WELCOME_SCREEN = 'welcome';

/** A recent project as the app names it (`projects` open param). */
export const WelcomeProject = z.object({
  name: z.string().min(1),
  /** Its folder, absolute: what ⏎ opens. */
  path: z.string().min(1),
  /** The folder as shown: `~/projects/demo-shop`. */
  shown: z.string(),
  /** Two-letter avatar initials (WebStorm's RecentProjects). */
  initials: z.string(),
  branch: z.string().optional(),
  /** Its folder is gone: a dim row. */
  gone: z.boolean().optional(),
});
export type WelcomeProject = z.infer<typeof WelcomeProject>;

/** The open param the app puts its recent projects in (JSON, most recent first). */
export const PROJECTS_PARAM = 'projects';

/** How many recent projects the Board page lists under the cards (the Projects page has all). */
export const BOARD_PROJECTS = 4;

export const GROUPS = [
  'needs-you',
  'needs-someone',
  'failed',
  'running',
  'ready',
  'on-test',
  'not-started',
] as const;
export type Group = (typeof GROUPS)[number];

/** Each group's caption (5-states.md words). */
export const GROUP_WORDS: Readonly<Record<Group, string>> = {
  'needs-you': 'Needs you',
  'needs-someone': 'Needs someone',
  failed: 'Failed',
  running: 'Running',
  ready: 'Ready for review',
  'on-test': 'On test',
  'not-started': 'Not started',
};

type Tab = 'mine' | 'team';
export type WelcomePage = 'board' | 'projects' | 'sessions' | 'boxes';
type Page = WelcomePage;

const PAGES: readonly Page[] = ['board', 'projects', 'sessions', 'boxes'];

/** A card read refused: `no-board` (no team yet) says Set up Abe; any other, why. */
type Refusal = { code: string; message: string };

export type WelcomeState = {
  size: ViewSize;
  now?: string | undefined;
  tab: Tab;
  page: Page;
  mine?: CardData[] | undefined;
  team?: CardData[] | undefined;
  /** The board's crumb: its project and sprint, once a card list answered. */
  crumb?: string | undefined;
  runs?: FactoryRunData[] | undefined;
  sessions?: SessionData[] | undefined;
  /** The board's team (`card members`): Assign…'s pick beside Me. */
  members?: readonly BoardMember[] | undefined;
  /** Assign…'s writes out and the undo `u` runs now (`assign.ts`). */
  assigns: AssignState;
  /** `box list`: your boxes (none read, or no AWS: no Boxes badge). */
  boxes?: BoxData[] | undefined;
  /**
   * The Sessions and Boxes pages' read refused (serve.target local: `boxes-off`): their empty
   * state says why instead of reading on.
   */
  unread?: { sessions?: Refusal | undefined; boxes?: Refusal | undefined } | undefined;
  /** The board's key, card types and sprint (`card list`): New card's dialog. */
  board?: { key: string; types: readonly string[]; sprint: string | null } | undefined;
  /** What the window was last told (`welcome` effect): `<needs you>|<crumb>|<page>`. */
  told?: string | undefined;
  /** The stripe the window was last sent (`stripe` effect), as JSON. */
  striped?: string | undefined;
  /** Every screen's view tweaks (`views`): the stripe's are the `factory` screen's (#20). */
  views?: readonly ViewTweak[] | undefined;
  /** How many problems Settings lists first (`settings problems`): the gear's dot. */
  problems?: number | undefined;
  refused?: Refusal | undefined;
  projects: WelcomeProject[];
  /**
   * The selected row's key: `card:<id>`, `more:<group>`, `project:<path>`; on the Sessions and
   * Boxes pages `session:<id>`, `box:<name>`.
   */
  selected?: string | undefined;
  /** The `/` filter: its field, and whether keys still type into it. */
  filter?: { field: Field; typing: boolean } | undefined;
  /** A group ⏎ unfolded on its `N more…` row: it folds last, after Needs you never. */
  unfolded?: Group | undefined;
  /** A `g` pressed: the next `g` is `gg`. */
  g: boolean;
  /** You moved or clicked: the selection stays on its row; before, it is the first row. */
  touched?: boolean | undefined;
  /** Reads asked and not answered yet, and those asked again meanwhile. */
  reading: readonly string[];
  again: readonly string[];
  /** The last thing that went wrong, on the Board's note line until the next key. */
  said?: string | undefined;
  /** The live facts last handed: the cards, runs, sessions and boxes above are theirs. */
  facts?: Facts | undefined;
};

type Out = { state: WelcomeState; commands: Command[] };

/** Its own reads (the cards, runs, sessions and boxes are live's: `FOLLOWS`). */
const READS: Readonly<Record<string, readonly string[]>> = {
  members: ['card', 'members'],
  problems: ['settings', 'problems'],
};

/** The live facts Welcome shows: your cards and the team's, their runs and sessions, your boxes. */
const FOLLOWS: readonly LiveRead[] = ['cards:mine', 'cards:team', 'runs', 'sessions', 'boxes'];
const ALL_READS = Object.keys(READS);

/** Asks for `ids`: one in flight is asked again once it answers, never twice at once. */
const read = (s: WelcomeState, ids: readonly string[]): Out => {
  const now = ids.filter((id) => !s.reading.includes(id));
  const later = ids.filter((id) => s.reading.includes(id) && !s.again.includes(id));

  return {
    state: { ...s, reading: [...s.reading, ...now], again: [...s.again, ...later] },
    commands: now.map((id) => ({ kind: 'run', id, argv: [...(READS[id] ?? [])] })),
  };
};

const shell = (effect: ShellEffect): Command => ({ kind: 'shell', effect });

// ---------------------------------------------------------------------------------------------
// The rows

/** A card's row, worked out. */
export type CardRow = {
  card: CardData;
  group: Group;
  rail: RailSegment[];
  mark: string;
  word: string;
  hue: Hue;
  time?: string | undefined;
  /** The repo its run or session is in, short (`demo-shop`). */
  repo?: string | undefined;
  /** Team: whose it is (initials), when it is someone's. */
  who?: string | undefined;
  stands?: Standing | undefined;
};

const groupOf = (l: Look | undefined, theirs: boolean): Group => {
  switch (l?.state) {
    case 'needs-you':
      return theirs ? 'needs-someone' : 'needs-you';
    case 'failed':
      return 'failed';
    case 'starting':
    case 'running':
      return 'running';
    case 'ready':
      return 'ready';
    case 'on-test':
    case 'merged':
      return l.givenUp === true ? 'not-started' : 'on-test';
    default:
      return 'not-started';
  }
};

const shortRepo = (repo: string): string => repo.replace(/\/+$/, '').split('/').at(-1) ?? repo;

/** What a card stands for, as its rail row says it: its run's, else its session's alone. */
const lookAndRail = (
  st: Standing | undefined,
  now: string | undefined,
): { look?: Look | undefined; rail?: RailRow | undefined } => {
  if (st?.run !== undefined) {
    const look = lookOf(st.run, st.session, now);

    return { look, rail: railRow(st.run, look, { now, session: st.session }) };
  }
  if (st?.session === undefined) return {};
  const look = sessionOnlyLook(st.session, now);

  return look === undefined ? {} : { look, rail: sessionRailRow(st.session, look, { now }) };
};

/** Every card of the tab, worked out, in the card list's order. */
export const cardRows = (s: WelcomeState): CardRow[] => {
  const cards = (s.tab === 'mine' ? s.mine : s.team) ?? [];
  const stands = standing(s.runs ?? [], s.sessions ?? []);

  return cards.map((card): CardRow => {
    const st = stands.get(card.id);
    const theirs = isTheirs(card, s.tab, s.mine ?? []);
    const { look, rail } = lookAndRail(st, s.now);
    const group = groupOf(look, theirs);
    const repo = st?.run?.repo ?? st?.session?.repo;
    const who =
      s.tab === 'team' && card.assignee !== null ? initials(card.assignee.name) : undefined;

    return {
      card,
      group,
      rail: rail?.segments ?? RAIL_STAGES.map((): RailSegment => 'todo'),
      mark: group === 'needs-someone' ? '◇' : (rail?.glyph ?? '○'),
      word: group === 'needs-someone' ? 'Needs someone' : (rail?.word ?? 'Not started'),
      hue: group === 'needs-someone' ? 'dim' : (MARK_HUES[rail?.state ?? 'idle'] ?? 'dim'),
      ...(rail?.time === undefined ? {} : { time: rail.time }),
      ...(repo === undefined ? {} : { repo: shortRepo(repo) }),
      ...(who === undefined ? {} : { who }),
      ...(st === undefined ? {} : { stands: st }),
    };
  });
};

const filterText = (s: WelcomeState): string => s.filter?.field.text.trim().toLowerCase() ?? '';

const cardMatches = (r: CardRow, f: string): boolean =>
  f === '' ||
  r.card.title.toLowerCase().includes(f) ||
  `#${r.card.id}`.includes(f) ||
  `ab#${r.card.id}`.includes(f) ||
  (r.repo?.toLowerCase().includes(f) ?? false);

const projectMatches = (p: WelcomeProject, f: string): boolean =>
  f === '' || p.name.toLowerCase().includes(f) || p.shown.toLowerCase().includes(f);

/** A group's rows as shown: all, or the first `shown` and a `N more…` row. */
export type ShownGroup = { group: Group; rows: CardRow[]; more: number };

/**
 * The groups that fit `room` rows (a caption and its rows each one row): Needs you whole, then
 * the longest of the others folds first, a row at a time, into its `N more…` row; `unfolded` folds
 * only once no other group has a row left to give. Empty groups are left out.
 */
export const foldGroups = (
  rows: readonly CardRow[],
  room: number,
  unfolded?: Group,
): ShownGroup[] => {
  const groups = GROUPS.flatMap((group) => {
    const of = rows.filter((r) => r.group === group);

    return of.length === 0 ? [] : [{ group, all: of, shown: of.length }];
  });
  const cost = () => groups.reduce((n, g) => n + 1 + g.shown + (g.shown < g.all.length ? 1 : 0), 0);
  const foldable = (g: (typeof groups)[number]) => g.group !== 'needs-you' && g.shown > 0;

  while (cost() > room) {
    const others = groups.filter((g) => foldable(g) && g.group !== unfolded);
    const pool = others.length > 0 ? others : groups.filter(foldable);
    const longest = pool.reduce<(typeof groups)[number] | undefined>(
      (a, g) => (a === undefined || g.shown > a.shown ? g : a),
      undefined,
    );

    if (longest === undefined) break;
    longest.shown -= 1;
  }

  return groups.map((g) => ({
    group: g.group,
    rows: g.all.slice(0, g.shown),
    more: g.all.length - g.shown,
  }));
};

/** px: the Board island's header, the Table's column labels and its key line; a row. */
const HEADER_H = 40;
const HEAD_H = 28;
const FOOT_H = 24;
const ROW_H = 30;
/** px between the islands and around them. */
const GAP = 8;

/** How many rows the Board's Table holds: what the Projects island and the chrome leave. */
const boardRoom = (s: WelcomeState): number => {
  const projects = Math.min(BOARD_PROJECTS, Math.max(1, s.projects.length));
  const projectsH = HEADER_H + HEAD_H + projects * ROW_H;
  const free = s.size.height - 2 * GAP - GAP - projectsH - HEADER_H - HEAD_H - FOOT_H;

  return Math.max(3, Math.floor(free / ROW_H));
};

const shownProjects = (s: WelcomeState): WelcomeProject[] => {
  const f = filterText(s);
  const all = s.projects.filter((p) => projectMatches(p, f));

  return s.page === 'board' && f === '' ? all.slice(0, BOARD_PROJECTS) : all;
};

const shownGroups = (s: WelcomeState): ShownGroup[] => {
  const f = filterText(s);

  return foldGroups(
    cardRows(s).filter((r) => cardMatches(r, f)),
    // filtered: every match shows (the list is short)
    f === '' ? boardRoom(s) : Number.MAX_SAFE_INTEGER,
    s.unfolded,
  );
};

/** Every row the cursor stops on, in order: the cards (and `N more…`), then the projects. */
export const cursorKeys = (s: WelcomeState): string[] => {
  if (s.page === 'sessions')
    return liveSessions(s.sessions ?? [], s.now, filterText(s)).map(
      (l) => `session:${l.session.id}`,
    );
  if (s.page === 'boxes') return boxRows(s.boxes ?? [], filterText(s)).flatMap((r) => r.id ?? []);

  return [
    ...(s.page === 'board'
      ? shownGroups(s).flatMap((g) => [
          ...g.rows.map((r) => `card:${r.card.id}`),
          ...(g.more > 0 ? [`more:${g.group}`] : []),
        ])
      : []),
    ...shownProjects(s).map((p) => `project:${p.path}`),
  ];
};

/** The selection on a row that shows: kept while it does, else the first. */
const settled = (s: WelcomeState): WelcomeState => {
  const keys = cursorKeys(s);

  if (s.touched === true && s.selected !== undefined && keys.includes(s.selected)) return s;

  return { ...s, selected: keys[0] };
};

const selectedCard = (s: WelcomeState): CardRow | undefined => {
  const id = s.selected?.startsWith('card:') === true ? Number(s.selected.slice(5)) : undefined;

  return id === undefined ? undefined : cardRows(s).find((r) => r.card.id === id);
};

const selectedProject = (s: WelcomeState): WelcomeProject | undefined =>
  s.selected?.startsWith('project:') === true
    ? s.projects.find((p) => `project:${p.path}` === s.selected)
    : undefined;

// ---------------------------------------------------------------------------------------------
// ⏎ and ⌘⏎

const OPEN_CARD = 'welcome-open:';

/** The folder ⏎ on a card opens, when a session or run of it says where (local only). */
export const cardFolder = (
  r: CardRow,
  s: Pick<WelcomeState, 'runs' | 'sessions'>,
): { path: string } | { session: string } | undefined => {
  const on = cardSession(s.runs ?? [], s.sessions ?? [], r.card.id);

  if (on === undefined) return undefined;
  const session = on.session;

  if (session?.box !== undefined && session.neverPlaced !== true) return { session: on.id };
  const live = session !== undefined && session.state !== 'ended';
  const worktree = session?.worktree ?? on.run?.worktree;
  const repo = session?.repo ?? on.run?.repo;

  if (live && worktree !== undefined) return { path: worktree };
  // the checkout it ran in (a local one's `repo` is its folder)
  if (repo?.startsWith('/') === true) return { path: repo };

  return worktree === undefined ? undefined : { path: worktree };
};

const openProject = (path: string, card?: number): Command =>
  shell({ kind: 'open-project', path, ...(card === undefined ? {} : { card }) });

/** The pick of the recent projects to open a card in (one: at once; none: said). */
const pickProject = (s: WelcomeState, r: CardRow): Out => {
  const live = s.projects.filter((p) => p.gone !== true);
  const only = live[0];

  if (live.length === 0)
    return {
      state: {
        ...s,
        said: `#${r.card.id} has no checkout on this machine: open or clone its repo first`,
      },
      commands: [],
    };
  if (live.length === 1 && only !== undefined)
    return { state: s, commands: [openProject(only.path, r.card.id)] };
  const menu: Menu = {
    kind: 'menu',
    id: `welcome-pick:${r.card.id}`,
    title: `Open #${r.card.id} in`,
    rows: live.map((p): MenuRow => ({
      id: `pick:${p.path}`,
      text: p.name,
      dim: p.shown,
      does: { kind: 'shell', effect: { kind: 'open-project', path: p.path, card: r.card.id } },
    })),
  };

  return { state: s, commands: [menu] };
};

const openCard = (s: WelcomeState, r: CardRow): Out => {
  const where = cardFolder(r, s);

  if (where === undefined) return pickProject(s, r);
  if ('session' in where)
    return {
      state: s,
      commands: [
        {
          kind: 'run',
          id: `${OPEN_CARD}${r.card.id}:${where.session}`,
          argv: ['workspace', 'attach-spec', where.session],
        },
      ],
    };

  return { state: s, commands: [openProject(where.path, r.card.id)] };
};

const selectedSession = (s: WelcomeState): SessionData | undefined =>
  s.selected?.startsWith('session:') === true
    ? s.sessions?.find((x) => `session:${x.id}` === s.selected)
    : undefined;

/** ⏎ on a session (Sessions page): its workspace, on its card when it has one. */
const openSession = (s: WelcomeState, x: SessionData): Out => {
  if (x.box !== undefined && x.neverPlaced !== true)
    return {
      state: s,
      commands: [
        {
          kind: 'run',
          id: `${OPEN_CARD}${x.card ?? 0}:${x.id}`,
          argv: ['workspace', 'attach-spec', x.id],
        },
      ],
    };
  const path = x.worktree.startsWith('/') ? x.worktree : x.repo;

  if (!path.startsWith('/'))
    return { state: { ...s, said: `${x.title} has no folder on this machine` }, commands: [] };

  return { state: s, commands: [openProject(path, x.card ?? undefined)] };
};

/** What ⏎ does on the selected row, in the footer's words: `open demo-shop on this card`. */
const enterWords = (s: WelcomeState): string | undefined => {
  const card = selectedCard(s);

  if (card !== undefined) {
    const where = cardFolder(card, s);
    const live = s.projects.filter((p) => p.gone !== true);
    const only = live.length === 1 ? live[0]?.name : undefined;
    const named = where !== undefined && 'path' in where ? shortRepo(where.path) : undefined;
    const name = where === undefined ? only : (card.repo ?? named);

    return name === undefined ? 'open a project on this card' : `open ${name} on this card`;
  }
  const project = selectedProject(s);

  if (project !== undefined) return project.gone === true ? undefined : `open ${project.name}`;
  if (s.selected?.startsWith('more:') === true) return 'show them all';
  const session = selectedSession(s);

  if (session !== undefined)
    return session.card === null ? 'open its workspace' : `open its workspace on #${session.card}`;

  return undefined;
};

const FIRST = '— open the project first';

/** What the Board's menu and the story know of a card on Welcome. */
const facts = (s: WelcomeState, r: CardRow) => ({
  card: r.card,
  mine: (s.mine ?? []).some((c) => c.id === r.card.id),
  members: s.members ?? [],
  ...(r.stands?.run === undefined ? {} : { run: r.stands.run }),
  ...(r.stands?.session === undefined ? {} : { session: r.stands.session }),
});

/** Open story: the card's story dialog, its text as `card list` read it. */
const storyOf = (s: WelcomeState, r: CardRow): Command => {
  const { dialog, lines } = storyDialog({ ...facts(s, r), sprint: s.board?.sprint ?? null });

  return { kind: 'dialog', id: dialog.id ?? `dialog:${r.card.id}`, dialog, lines };
};

/** New card's dialog on the team's board (`card list`'s), as the Board opens it. */
const newCardOn = (s: WelcomeState, title?: string): NewCardOn | undefined =>
  s.board === undefined
    ? undefined
    : {
        kind: 'newcard',
        board: s.board.key,
        types: s.board.types,
        columns: COLUMNS.filter((c) => !isDone(c)),
        sprint: s.board.sprint,
        ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }),
      };

const newCardRow = (s: WelcomeState): MenuRow[] => {
  const on = newCardOn(s);

  return on === undefined
    ? []
    : [
        {
          id: 'new-card',
          text: 'New card…',
          dim: 'on the team’s board',
          does: { kind: 'do', commands: [on] },
        },
      ];
};

/** A card's ⌘⏎ menu on Welcome: what works without its project, the rest dim and saying why. */
export const cardMenu = (s: WelcomeState, r: CardRow): Menu => {
  const dim = (id: string, text: string): MenuRow => ({
    id,
    text,
    reason: FIRST,
    does: { kind: 'do', commands: [] },
  });
  const open: MenuRow = {
    id: 'open',
    text: enterWords(s)?.replace(/^open/, 'Open') ?? 'Open a project on this card',
    key: '⏎',
    does: { kind: 'back' },
  };

  // Open worktree: a local session's worktree as a project, as the Board's; a box's or a
  // teammate's needs `card checkout` in the project, so it is not here
  const local = cardSession(s.runs ?? [], s.sessions ?? [], r.card.id)?.session;
  const worktree: MenuRow[] =
    local === undefined ||
    local.box !== undefined ||
    local.neverPlaced === true ||
    !local.worktree.startsWith('/')
      ? []
      : [
          {
            id: 'worktree',
            text: 'Open worktree',
            dim: 'local',
            does: { kind: 'shell', effect: { kind: 'open-project', path: local.worktree } },
          },
        ];

  return {
    kind: 'menu',
    id: `welcome-card:${r.card.id}`,
    title: `#${r.card.id} ${r.card.title}`,
    rows: [
      open,
      ...worktree,
      {
        id: 'story',
        text: 'Open story',
        does: { kind: 'do', commands: [storyOf(s, r)] },
      },
      // Assign… and Move… as the Board's menu has them (they run from home: the board in force)
      ...sharedCardMenu(facts(s, r)).rows.filter((x) => x.id === 'assign' || x.id === 'move'),
      {
        id: 'comment',
        text: 'Comment…',
        does: {
          kind: 'do',
          commands: [
            {
              kind: 'comment',
              card: r.card.id,
              title: r.card.title,
              placeholder: 'Your comment, as markdown',
            },
          ],
        },
      },
      ...(r.card.url === ''
        ? []
        : [
            {
              id: 'browser',
              text: 'Open in browser',
              does: { kind: 'shell', effect: { kind: 'open-url', url: r.card.url } },
            } satisfies MenuRow,
          ]),
      ...newCardRow(s),
      { ...dim('answer', 'Answer'), separator: true },
      dim('stop', 'Stop…'),
      dim('launch', 'Launch agent'),
    ],
  };
};

/** A project's ⌘⏎ menu: open it, or show its folder. */
export const projectMenu = (p: WelcomeProject): Menu => ({
  kind: 'menu',
  id: `welcome-project:${p.path}`,
  title: p.name,
  rows: [
    {
      id: 'open',
      text: 'Open',
      key: '⏎',
      ...(p.gone === true ? { reason: 'its folder is gone' } : {}),
      does: { kind: 'shell', effect: { kind: 'open-project', path: p.path } },
    },
    {
      id: 'finder',
      text: 'Show in Finder',
      ...(p.gone === true ? { reason: 'its folder is gone' } : {}),
      does: {
        kind: 'shell',
        effect: {
          kind: 'open-url',
          url: `file://${p.path.split('/').map(encodeURIComponent).join('/')}`,
        },
      },
    },
    {
      id: 'forget',
      text: 'Remove from list',
      separator: true,
      does: { kind: 'shell', effect: { kind: 'forget-project', path: p.path } },
    },
  ],
});

/** The window's Open… (⌘O) and New Project…: a folder picked in the system's panel. */
const OPEN: Command = shell({ kind: 'app', action: 'open' });
const NEW_PROJECT: Command = shell({ kind: 'app', action: 'new-project' });

/** Settings › Board & you: the no-board empty state's way on. */
const SETUP: Command = { kind: 'open', screen: 'settings', params: { page: 'board-team' } };

const enter = (s: WelcomeState): Out => {
  // no board yet: ⏎ is Set up Abe until you move into the projects
  if (s.refused?.code === 'no-board' && s.touched !== true) return { state: s, commands: [SETUP] };
  const card = selectedCard(s);

  if (card !== undefined) return openCard(s, card);
  const project = selectedProject(s);

  if (project !== undefined)
    return project.gone === true
      ? { state: { ...s, said: `${project.shown} is gone` }, commands: [] }
      : { state: s, commands: [openProject(project.path)] };
  if (s.selected?.startsWith('more:') === true) {
    const group = GROUPS.find((g) => `more:${g}` === s.selected);

    return { state: settled({ ...s, unfolded: group }), commands: [] };
  }
  const session = selectedSession(s);

  return session === undefined ? { state: s, commands: [] } : openSession(s, session);
};

const menuOf = (s: WelcomeState): Out => {
  const card = selectedCard(s);

  if (card !== undefined) return { state: s, commands: [cardMenu(s, card)] };
  const project = selectedProject(s);

  return { state: s, commands: project === undefined ? [] : [projectMenu(project)] };
};

// ---------------------------------------------------------------------------------------------
// Keys

const move = (s: WelcomeState, key: string): Out | undefined => {
  const m = listMove(key, boardRoom(s));

  if (m === undefined) return undefined;
  const keys = cursorKeys(s);
  const at = keys.indexOf(s.selected ?? '');

  return {
    state: { ...s, g: false, touched: true, selected: keys[movedRow(m, at, keys.length)] },
    commands: [],
  };
};

const typing = (s: WelcomeState): boolean => s.filter?.typing === true;

const filterKey = (s: WelcomeState, key: string): Out => {
  const f = s.filter;

  if (f === undefined) return { state: s, commands: [] };
  if (key === '<Esc>') {
    const next = { ...s };

    delete next.filter;

    return { state: settled(next), commands: [] };
  }
  if (key === '<CR>' || key === '<S-CR>') return enter({ ...s, filter: { ...f, typing: false } });
  if (key === '<Up>' || key === '<Down>') return move(s, key) ?? { state: s, commands: [] };
  const edited = fieldKey(f.field, key);

  if (edited !== undefined)
    return { state: settled({ ...s, filter: { ...f, field: edited } }), commands: [] };
  const typed = typedChar(key);

  if (typed === undefined) return { state: s, commands: [] };

  return {
    state: settled({ ...s, filter: { ...f, field: fieldInsert(f.field, typed) } }),
    commands: [],
  };
};

const tabTo = (s: WelcomeState, tab: Tab): WelcomeState => settled({ ...s, tab, page: 'board' });

const onKey = (s0: WelcomeState, key: string): Out => {
  // a `g` waits only for the next key
  const s: WelcomeState = {
    ...s0,
    said: undefined,
    g: key === 'g' ? s0.g : false,
    // the undo is the very next key's only
    assigns: key === 'u' ? s0.assigns : keyed(s0.assigns),
  };

  if (typing(s)) return filterKey(s, key);
  if (key === 'u' && s.assigns.undo !== undefined) {
    const out = undoAssign(s.assigns);

    return { state: { ...s, assigns: out.state }, commands: out.commands };
  }
  if (key === 'g')
    return s.g
      ? (move({ ...s, g: false }, 'gg') ?? { state: s, commands: [] })
      : { state: { ...s, g: true }, commands: [] };
  const moved = move(s, key);

  if (moved !== undefined) return moved;
  switch (key) {
    case '<CR>':
    case '<S-CR>':
      return enter(s);
    case '<D-CR>':
      return menuOf(s);
    case '<Tab>':
      return { state: tabTo(s, 'team'), commands: [] };
    case '<S-Tab>':
      return { state: tabTo(s, 'mine'), commands: [] };
    case '/':
      return {
        state: { ...s, filter: { field: fieldOf(s.filter?.field.text ?? ''), typing: true } },
        commands: [],
      };
    case '<D-S-o>':
      return { state: settled({ ...s, page: 'projects' }), commands: [] };
    case '<D-5>':
      return { state: settled({ ...s, page: 'sessions' }), commands: [] };
    case '<D-6>':
      return { state: settled({ ...s, page: 'boxes' }), commands: [] };
    case '<Esc>': {
      if (s.filter !== undefined) {
        const next = { ...s };

        delete next.filter;

        return { state: settled(next), commands: [] };
      }

      return { state: settled({ ...s, page: 'board' }), commands: [] };
    }
    case 'r':
      return read(s, ALL_READS);
    default:
      return { state: { ...s, g: false }, commands: [] };
  }
};

const onClick = (s0: WelcomeState, id: string): Out => {
  const s: WelcomeState = { ...s0, said: undefined };

  if (id === 'open') return { state: s, commands: [OPEN] };
  if (id === 'clone') return { state: s, commands: [CLONE] };
  if (id.startsWith(STRIPE_MENU)) return stripeChanged(s, id);
  if (id.startsWith(STRIPE_AT)) {
    const at = id.slice(STRIPE_AT.length);

    return { state: s, commands: [welcomeStripeMenu(s, at === '' ? undefined : at)] };
  }
  if (id === `${STRIPE_CLICK}settings`)
    return {
      state: s,
      commands: [{ kind: 'open', screen: 'settings', params: { page: 'problems' } }],
    };
  if (id.startsWith(STRIPE_CLICK)) {
    const to = stripePage(s, id.slice(STRIPE_CLICK.length));

    return to === undefined
      ? { state: s, commands: [] }
      : { state: settled({ ...s, page: to }), commands: [] };
  }
  if (id === 'new-project') return { state: s, commands: [NEW_PROJECT] };
  if (id === 'tab:mine') return { state: tabTo(s, 'mine'), commands: [] };
  if (id === 'tab:team') return { state: tabTo(s, 'team'), commands: [] };
  if (id === 'setup') return { state: s, commands: [SETUP] };
  if (/^(card|project|more|session|box):/.test(id)) {
    // a click selects; on the selected row it opens, as a double click would
    if (s.selected === id) return enter(s);

    return { state: { ...s, selected: id, touched: true }, commands: [] };
  }

  return { state: s, commands: [] };
};

// ---------------------------------------------------------------------------------------------
// Answers and events

const onResult = (s0: WelcomeState, input: Answer | Refused): Out => {
  const id = input.id;

  if (id.startsWith(OPEN_CARD)) {
    if (!input.reply.ok) return { state: { ...s0, said: input.reply.error.message }, commands: [] };
    if (input.command !== 'workspace attach-spec') return { state: s0, commands: [] };
    const rest = id.slice(OPEN_CARD.length);
    const at = rest.indexOf(':');
    const card = rest.slice(0, at);
    const session = rest.slice(at + 1);
    const spec: AttachSpec = input.reply.data;
    const landing = workspaceLanding(spec, `download:${session}`);

    if (landing.kind !== 'open-project') return { state: s0, commands: [] };
    // the Factory view on the card, not ⌃W's Chat column beside the Editor
    return {
      state: s0,
      commands: [
        shell({
          kind: 'open-project',
          path: landing.path,
          ...(landing.attach === undefined ? {} : { attach: landing.attach }),
          ...(Number(card) > 0 ? { card: Number(card) } : {}),
        }),
      ],
    };
  }
  if (isAssignRun(id)) {
    const out = assigned(s0.assigns, input);
    // no status line or balloons on Welcome: its words go on the Board's note line
    const words = out.commands.flatMap((c) =>
      c.kind === 'shell' && (c.effect.kind === 'status' || c.effect.kind === 'balloon')
        ? [c.effect.text]
        : [],
    );

    return {
      state: { ...s0, assigns: out.state, ...(words[0] === undefined ? {} : { said: words[0] }) },
      commands: out.commands.filter((c) => c.kind !== 'shell'),
    };
  }
  const answered: WelcomeState = { ...s0, reading: s0.reading.filter((r) => r !== id) };
  const again = s0.again.includes(id);
  const s: WelcomeState = { ...answered, again: answered.again.filter((r) => r !== id) };
  const then = (next: WelcomeState): Out => {
    const settledNext = settled(next);

    return again ? read(settledNext, [id]) : { state: settledNext, commands: [] };
  };

  if (!input.reply.ok) return then(s);
  switch (input.command) {
    case 'card members':
      return then({ ...s, members: input.reply.data.members });
    case 'settings problems':
      return then({
        ...s,
        problems: input.reply.data.problems.filter((p) => p.kind !== 'override').length,
      });
    default:
      return then(s);
  }
};

/** A read's failure as a page says it. */
const refusalOf = (f: Facts, r: LiveRead): Refusal | undefined => f.read[r].failed;

/**
 * The live facts handed: the open cards (the lists have the sprint's done ones too) and the
 * board's crumb, the runs, the sessions, the boxes; what failed of them, for the pages to say.
 */
const onFacts = (s: WelcomeState, f: Facts): WelcomeState => {
  const list = f.team ?? f.mine;
  const open = (cards: readonly CardData[] | undefined) => cards?.filter((c) => !isDone(c.state));
  const crumb =
    list === undefined
      ? s.crumb
      : [list.board.project, list.sprint]
          .filter((x): x is string => x !== null && x !== '')
          .join(' · ');
  const refused = refusalOf(f, 'cards:mine') ?? refusalOf(f, 'cards:team');

  return settled({
    ...s,
    mine: f.mine === s.facts?.mine ? s.mine : open(f.mine?.cards),
    team: f.team === s.facts?.team ? s.team : open(f.team?.cards),
    crumb,
    refused: list !== undefined && refused === undefined ? undefined : (refused ?? s.refused),
    ...(list === undefined
      ? {}
      : {
          board: {
            key: `${list.board.organization}/${list.board.project}/${list.board.team}`,
            types: list.board.types ?? [],
            sprint: list.sprint,
          },
        }),
    runs: f.runs,
    sessions: f.sessions,
    boxes: f.boxList?.boxes,
    unread: { sessions: refusalOf(f, 'sessions'), boxes: refusalOf(f, 'boxes') },
    facts: f,
  });
};

/** Which reads an event says are stale. */
export const readsFor = (event: Event): readonly string[] => {
  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      // (the cards, runs, sessions and boxes are live's: read again there)
      return ALL_READS;
    case 'settings.changed':
      return ['problems'];
    default:
      return [];
  }
};

/** The watch's events Welcome takes; the rest move only the live facts it is handed. */
const WELCOME_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'settings.changed',
]);

const projectsOf = (raw: string | undefined): WelcomeProject[] | undefined => {
  if (raw === undefined) return undefined;
  try {
    const parsed = z.array(WelcomeProject).safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

const stepWelcome = (s: WelcomeState, input: Input): Out => {
  switch (input.kind) {
    case 'open': {
      const projects = projectsOf(input.params[PROJECTS_PARAM]);
      const opened: WelcomeState = {
        ...s,
        size: input.size,
        ...(projects === undefined ? {} : { projects }),
        page: PAGES.find((p) => p === input.params.page) ?? s.page,
      };

      return read(settled(opened), ALL_READS);
    }
    case 'resize':
      return { state: settled({ ...s, size: input.size }), commands: [] };
    case 'tick':
      return { state: { ...s, now: input.at }, commands: [] };
    case 'key':
      return onKey(s, input.key);
    case 'text':
      return typing(s) && s.filter !== undefined
        ? {
            state: settled({
              ...s,
              filter: { ...s.filter, field: fieldInsert(s.filter.field, input.text) },
            }),
            commands: [],
          }
        : { state: s, commands: [] };
    case 'click':
      return onClick(s, input.id);
    case 'choice': {
      // the card menu's Open row, `:`'s pages, handed back
      if (input.row === 'open') return enter(s);
      if (input.row === 'assign') return assignChosen(s, input.menu, input.values?.[0]);
      if (input.menu === STRIPE_MENU_ID) return stripeChanged(s, input.row);
      const url = input.values?.[0]?.trim();

      if (input.row === 'clone')
        return url === undefined || url === ''
          ? { state: s, commands: [] }
          : { state: s, commands: [shell({ kind: 'clone-project', url })] };
      const page = PAGES.find((p) => input.row === `page:${p}`);

      return page === undefined
        ? { state: s, commands: [] }
        : { state: settled({ ...s, page, said: undefined }), commands: [] };
    }
    case 'views':
      return { state: { ...s, views: input.all ?? s.views }, commands: [] };
    case 'result':
      return onResult(s, input);
    case 'event':
      return read(s, readsFor(input.event));
    case 'live':
      return { state: onFacts(s, input.facts), commands: [] };
    default:
      return { state: s, commands: [] };
  }
};

// ---------------------------------------------------------------------------------------------
// The tree

/** Mine's Needs you count: the Dock badge's, the Board's dot on the stripe. */
export const needsYouCount = (s: WelcomeState): number =>
  cardRows({ ...s, tab: 'mine' }).filter((r) => r.group === 'needs-you').length;

/** A repo's tool windows: with no project open, greyed in the stripe's menu with the workspace's. */
const PROJECT_ONLY: readonly string[] = ['pipelines'];

/**
 * Welcome's stripe (#3): a project window's items, Board's and Sessions' dots from your cards and
 * sessions, Boxes' as in a project, your stripe tweaks (the `factory` screen's); Pipelines and
 * Prototype say `workspaceOnly`, so they leave it with Run, Terminal and Git.
 */
export const welcomeStripe = (s: WelcomeState): StripeItem[] => {
  const sessions = sessionsCounts(s.sessions, s.now);
  const at = s.now === undefined ? Number.NaN : Date.parse(s.now);
  const boxes = stripeBoxes(
    { boxes: [...(s.boxes ?? [])], queued: [] },
    Number.isNaN(at) ? undefined : at,
  );
  const waiting = cardRows({ ...s, tab: 'mine' })
    .filter((r) => r.group === 'needs-you')
    .map((r) => ({ card: r.card.id, title: r.card.title }));

  const facts = {
    boxes,
    problems: s.problems,
    tweaks: (s.views ?? []).filter((t) => t.screen === 'factory'),
  };
  // Board's dot from your cards, Sessions' from the sessions (a teammate's ask is not yours)
  const bySessions = stripeItems({ ...facts, counts: sessions });

  return stripeItems({
    ...facts,
    counts: { needsYou: waiting.length, running: 0, failed: 0 },
    waiting,
  }).map((i) => {
    if (i.id === 'sessions') return bySessions.find((x) => x.id === 'sessions') ?? i;
    if (i.id === 'project') return { ...i, tooltip: 'Project · ⌘⇧O · your recent projects' };

    return PROJECT_ONLY.includes(i.id) ? { ...i, workspaceOnly: true as const } : i;
  });
};

/** The stripe item a Welcome page picks: Project is your recent projects there. */
const PICKS: Readonly<Record<Page, string>> = {
  board: 'board',
  projects: 'project',
  sessions: 'sessions',
  boxes: 'boxes',
};

/**
 * What the shell draws on Welcome (the contract's `stripe/welcome-*.json`): the stripe as off a
 * workspace, the page's item the one picked (Sessions and Boxes take the Board's place there).
 */
export const welcomeStripeAt = (
  items: readonly StripeItem[],
  page: Page,
): ReturnType<typeof stripeAt> => {
  const drawn = stripeAt(items, { place: 'board' });
  const pick = (d: StripeDrawn): StripeDrawn => ({
    id: d.id,
    icon: d.icon,
    ...(d.id === PICKS[page] ? { picked: true as const } : {}),
    ...(d.dot === undefined ? {} : { dot: d.dot }),
    tooltip: d.tooltip,
  });

  return { top: drawn.top.map(pick), bottom: drawn.bottom.map(pick) };
};

/** The page a stripe item shows on Welcome: Sessions or Boxes again goes back to the Board. */
const stripePage = (s: WelcomeState, id: string): Page | undefined => {
  switch (id) {
    case 'board':
      return 'board';
    case 'project':
      return 'projects';
    case 'sessions':
    case 'boxes':
      return s.page === id ? 'board' : id;
    default:
      return undefined;
  }
};

/** A choice in the stripe's menu (#20): your `views` with it, written as in a project window. */
const stripeChanged = (s: WelcomeState, click: string): Out => {
  const change = stripeChangeOf(click);

  if (change === undefined) return { state: s, commands: [] };
  const views = stripeTweaks(s.views ?? [], change);

  return {
    state: { ...s, views },
    commands: [
      {
        kind: 'run',
        id: 'stripe:views',
        argv: ['settings', 'set', 'views', JSON.stringify(views)],
      },
    ],
  };
};

/**
 * The stripe's right-click menu on Welcome (#3), in Command mode (Welcome has no project to hold
 * a native menu): its rows as a project window's off a workspace, the workspace's grey with why.
 * The shell names the item clicked (`widget:stripe-at:<id>`; none: ⋯ or the empty room).
 */
export const STRIPE_AT = 'widget:stripe-at:';
const STRIPE_MENU_ID = 'welcome-stripe';

export const welcomeStripeMenu = (s: WelcomeState, at: string | undefined): Menu => {
  const rows: MenuRow[] = [];
  let gap = false;

  for (const r of stripeMenu(welcomeStripe(s), false, at)) {
    if (r.kind === 'separator' || r.kind === 'info') {
      gap = rows.length > 0;
      continue;
    }
    const id =
      r.kind === 'toggle'
        ? `${STRIPE_MENU}toggle:${r.id}`
        : `${STRIPE_MENU}${r.action}${r.id === undefined ? '' : `:${r.id}`}`;
    const text = r.label;

    rows.push({
      id,
      text,
      ...(r.kind === 'toggle' ? { dim: r.on ? 'shown' : 'hidden' } : {}),
      ...(r.kind === 'toggle' && !r.enabled ? { reason: 'Only in a workspace' } : {}),
      ...(gap ? { separator: true } : {}),
      does: { kind: 'back' },
    });
    gap = false;
  }

  return { kind: 'menu', id: STRIPE_MENU_ID, title: 'Stripe', rows };
};

/** Clone…'s row (#3): its URL asked in Command mode, handed back as `clone`. */
const CLONE_MENU = 'welcome-clone';
const cloneRow: MenuRow = {
  id: 'clone',
  text: 'Clone…',
  dim: 'into ~/projects',
  does: {
    kind: 'back',
    ask: [
      {
        name: 'url',
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: false,
        summary: 'git clone <url> into ~/projects/<name>, then open it',
        title: 'Repository URL',
      },
    ],
  },
};
const CLONE: Command = { kind: 'menu', id: CLONE_MENU, title: 'Clone', rows: [cloneRow] };

/** `:clone <url>` (3.0): Clone…'s in one line, cloned into ~/projects and opened. */
const WELCOME_WORDS: readonly Word[] = [
  {
    word: 'clone',
    summary: 'git clone <url> into ~/projects/<name>, then open it',
    ask: [
      {
        name: 'url',
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: false,
        summary: 'the repository URL',
      },
    ],
    commands: ([url = '']) =>
      url.trim() === '' ? [] : [shell({ kind: 'clone-project', url: url.trim() })],
  },
];

const repoShown = (rows: readonly CardRow[]): boolean =>
  new Set(rows.flatMap((r) => (r.repo === undefined ? [] : [r.repo]))).size > 1;

const cardCells = (r: CardRow, o: { repo: boolean; who: boolean }): TableCell[] => [
  { accent: `#${r.card.id}` },
  { text: r.card.title, tooltip: r.card.title },
  ...(o.repo ? [{ text: r.repo ?? '', hue: 'dim' as const }] : []),
  ...(o.who ? [{ text: r.who ?? '', hue: 'dim' as const }] : []),
  { rail: r.rail },
  { mark: r.mark, text: r.word, hue: r.hue },
  { text: r.time ?? '', hue: 'dim' },
];

const boardEmpty = (s: WelcomeState): { title: string; line: string } => {
  if (s.refused?.code === 'no-board')
    return { title: 'No board yet', line: 'Set up Abe ⏎ · your team and its board' };
  if (s.refused !== undefined) return { title: 'Abe isn’t answering', line: s.refused.message };
  if ((s.tab === 'mine' ? s.mine : s.team) === undefined)
    return { title: 'Reading your cards…', line: '' };
  if (filterText(s) !== '')
    return {
      title: `No cards match “${s.filter?.field.text ?? ''}”`,
      line: 'Esc clears the filter',
    };

  return s.tab === 'mine'
    ? { title: 'Nothing needs you', line: 'Tab · Team' }
    : { title: 'No cards on the board', line: '⇧Tab · Mine' };
};

const boardTable = (s: WelcomeState): Table => {
  const groups = shownGroups(s);
  const all = groups.flatMap((g) => g.rows);
  const repo = repoShown(cardRows(s));
  const who = s.tab === 'team';
  const columns: Table['props']['columns'] = [
    { label: 'Card', width: { fixed: 64 } },
    { label: 'Title', width: { flex: 1 } },
    ...(repo ? [{ label: 'Repo', width: { fixed: 110 } }] : []),
    ...(who ? [{ label: 'Who', width: { fixed: 40 } }] : []),
    { label: 'Stage', width: { fixed: 70 } },
    { label: 'State', width: { fixed: 150 } },
    { label: 'Time', width: { fixed: 72 }, align: 'end' },
  ];
  const rows: TableRow[] = groups.flatMap((g) => [
    {
      cells: [
        {
          text: `${GROUP_WORDS[g.group].toUpperCase()} · ${g.rows.length + g.more}`,
          hue: g.group === 'needs-you' ? 'needs-you' : 'dim',
        },
      ],
    },
    ...g.rows.map((r): TableRow => ({
      id: `card:${r.card.id}`,
      cells: cardCells(r, { repo, who }),
    })),
    ...(g.more > 0
      ? [{ id: `more:${g.group}`, cells: [{ text: `${g.more} more…`, hue: 'dim' as const }] }]
      : []),
  ]);
  const words = enterWords(s);
  const selected = s.selected?.startsWith('project:') === true ? undefined : s.selected;

  return {
    kind: 'Table',
    id: 'welcome-cards',
    props: {
      columns,
      rows: all.length === 0 ? [] : rows,
      ...(selected === undefined ? {} : { selected }),
      ...(s.said === undefined ? {} : { note: s.said }),
      ...(s.filter === undefined ? {} : { filter: s.filter.field.text }),
      ...(all.length === 0 ? { empty: boardEmpty(s) } : {}),
      ...(words === undefined || selected === undefined
        ? {}
        : { foot: [{ keys: '⏎', label: words }] }),
    },
  };
};

const projectsTable = (s: WelcomeState, all: boolean): Table => {
  const projects = shownProjects(s);
  const selected = s.selected?.startsWith('project:') === true ? s.selected : undefined;
  const words = enterWords(s);

  return {
    kind: 'Table',
    id: 'welcome-projects',
    props: {
      columns: [
        { label: '', width: { fixed: 36 } },
        { label: 'Project', width: { fixed: 180 } },
        { label: 'Folder', width: { flex: 1 } },
        { label: 'Branch', width: { fixed: 140 } },
      ],
      rows: projects.map((p): TableRow => ({
        id: `project:${p.path}`,
        cells: [
          { accent: p.initials },
          {
            text: p.name,
            ...(p.gone === true ? { hue: 'dim' as const, tooltip: 'Its folder is gone' } : {}),
          },
          { text: p.shown, hue: 'dim' },
          { text: p.branch ?? '', hue: 'dim' },
        ],
      })),
      ...(selected === undefined ? {} : { selected }),
      ...(all && s.filter !== undefined ? { filter: s.filter.field.text } : {}),
      ...(projects.length === 0
        ? {
            empty: {
              title: s.projects.length === 0 ? 'No recent projects' : 'No projects match',
              line: '',
            },
          }
        : {}),
      ...(all && words !== undefined && selected !== undefined
        ? { foot: [{ keys: '⏎', label: words }] }
        : {}),
    },
  };
};

/** The Sessions and Boxes pages' Table. */
const listTable = (s: WelcomeState, page: 'sessions' | 'boxes'): Table => {
  const f = filterText(s);
  const rows =
    page === 'sessions'
      ? liveSessions(s.sessions ?? [], s.now, f).map((l) => sessionRow(l, s.now))
      : boxRows(s.boxes ?? [], f);
  const words = enterWords(s);
  const read = page === 'sessions' ? s.sessions : s.boxes;
  const refused = s.unread?.[page];
  const empty = (): { title: string; line: string } => {
    if (read === undefined && refused?.code === BOXES_OFF.code)
      return { title: BOXES_OFF.title, line: BOXES_OFF.line };
    if (read === undefined && refused !== undefined)
      return {
        title: page === 'sessions' ? 'Sessions not read' : 'Boxes not read',
        line: refused.message,
      };
    if (read === undefined)
      return {
        title: page === 'sessions' ? 'Reading your sessions…' : 'Reading your boxes…',
        line: '',
      };
    if (f !== '') return { title: 'Nothing matches', line: 'Esc clears the filter' };

    return page === 'sessions'
      ? { title: 'No session running', line: '' }
      : { title: 'No boxes', line: '' };
  };

  return {
    kind: 'Table',
    id: `welcome-${page}`,
    props: {
      columns:
        page === 'sessions'
          ? [
              { label: 'Card', width: { fixed: 64 } },
              { label: 'Title', width: { flex: 1 } },
              { label: 'Where', width: { fixed: 140 } },
              { label: 'State', width: { fixed: 150 } },
              { label: 'Time', width: { fixed: 72 }, align: 'end' },
            ]
          : [
              { label: 'Box', width: { fixed: 180 } },
              { label: 'Card', width: { fixed: 64 } },
              { label: 'Title', width: { flex: 1 } },
              { label: 'State', width: { fixed: 150 } },
              { label: 'Size', width: { fixed: 90 } },
            ],
      rows,
      ...(s.selected === undefined || rows.length === 0 ? {} : { selected: s.selected }),
      ...(s.said === undefined ? {} : { note: s.said }),
      ...(s.filter === undefined ? {} : { filter: s.filter.field.text }),
      ...(rows.length === 0 ? { empty: empty() } : {}),
      ...(words === undefined || rows.length === 0 ? {} : { foot: [{ keys: '⏎', label: words }] }),
    },
  };
};

/** The Projects island's header: its count or All projects, and the window's New Project… / Open…. */
const PROJECT_ACTIONS = [
  { id: 'new-project', label: 'New Project…' },
  { id: 'open', label: 'Open… ⌘O' },
  { id: 'clone', label: 'Clone…' },
];

const header = (title: string, o: Partial<ToolWindowHeader['props']> = {}): ToolWindowHeader => ({
  kind: 'ToolWindowHeader',
  props: { title, ...o },
});

/** The Sessions or Boxes page: its island. */
const listIsland = (s: WelcomeState, page: 'sessions' | 'boxes'): Node =>
  island(
    [
      stack(
        'column',
        [
          header(page === 'sessions' ? 'Sessions' : 'Boxes', { note: 'Esc · Board' }),
          listTable(s, page),
        ],
        { sizes: ['auto', { flex: 1 }] },
      ),
    ],
    `welcome-${page}-page`,
  );

/** The Board page (the cards over the projects) or the Projects page. */
const mainContent = (s: WelcomeState): Node =>
  s.page === 'projects'
    ? island(
        [
          stack(
            'column',
            [
              header('Projects', {
                count: s.projects.length,
                tabs: PROJECT_ACTIONS,
                note: 'Esc · Board',
              }),
              projectsTable(s, true),
            ],
            {
              sizes: ['auto', { flex: 1 }],
            },
          ),
        ],
        'welcome-projects-page',
      )
    : stack(
        'column',
        [
          island(
            [
              stack(
                'column',
                [
                  header('Board', {
                    tabs: [
                      { id: 'tab:mine', label: 'Mine' },
                      { id: 'tab:team', label: 'Team' },
                    ],
                    selected: `tab:${s.tab}`,
                    ...(s.crumb === undefined ? {} : { note: s.crumb }),
                  }),
                  boardTable(s),
                ],
                { sizes: ['auto', { flex: 1 }] },
              ),
            ],
            'welcome-board',
          ),
          island(
            [
              stack(
                'column',
                [
                  header('Projects', {
                    tabs: PROJECT_ACTIONS,
                    note: `All projects · ${s.projects.length} ⌘⇧O`,
                  }),
                  projectsTable(s, false),
                ],
                { sizes: ['auto', { flex: 1 }] },
              ),
            ],
            'welcome-projects',
          ),
        ],
        {
          gap: GAP,
          sizes: [
            { flex: 1 },
            {
              fixed:
                HEADER_H +
                HEAD_H +
                Math.min(BOARD_PROJECTS, Math.max(1, s.projects.length)) * ROW_H,
            },
          ],
        },
      );

const viewWelcome = (s: WelcomeState): Node => {
  const listPage = s.page === 'sessions' || s.page === 'boxes' ? s.page : undefined;
  const content = listPage === undefined ? mainContent(s) : listIsland(s, listPage);

  return {
    ...stack('row', [content], {
      sizes: [{ flex: 1 }],
      align: 'stretch',
      pad: [GAP, GAP, GAP, GAP],
    }),
    id: 'welcome',
  };
};

/** What `:` and `?` start from on Welcome (#346): the card row as the Subject, its menu. */
const hereOf = (s: WelcomeState): Here => {
  const card = selectedCard(s);

  const go = (id: string, text: string, does: MenuRow['does'], key?: string): MenuRow => ({
    id,
    text,
    does,
    ...(key === undefined ? {} : { key }),
  });
  const view: Menu = {
    kind: 'menu',
    id: 'welcome-view',
    title: 'Welcome',
    rows: [
      ...newCardRow(s),
      go('open', 'Open…', { kind: 'do', commands: [OPEN] }, '⌘O'),
      go('new-project', 'New Project…', { kind: 'do', commands: [NEW_PROJECT] }),
      cloneRow,
      go('page:projects', 'Projects', { kind: 'back' }, '⌘⇧O'),
      go('page:sessions', 'Sessions', { kind: 'back' }, '⌘5'),
      go('page:boxes', 'Boxes', { kind: 'back' }, '⌘6'),
    ],
  };

  return {
    keys: 'welcome',
    view: { title: 'Welcome', menu: view },
    ...(s.crumb === undefined ? {} : { board: true }),
    ...(card === undefined
      ? {}
      : {
          subject: {
            caption: `#${card.card.id} ${card.card.title}`,
            label: `#${card.card.id}`,
            ask: ['--card', String(card.card.id)],
            menu: cardMenu(s, card),
          },
        }),
  };
};

/** Assign… picked on a card's menu (`welcome-card:<id>`): `card assign`, `u` to undo it. */
const assignChosen = (s: WelcomeState, menu: string, who: string | undefined): Out => {
  const id = Number(menu.slice('welcome-card:'.length));
  const r = cardRows(s).find((x) => x.card.id === id);

  if (r === undefined || who === undefined) return { state: s, commands: [] };
  const out = assignOn(s.assigns, r.card, who, {
    mine: (s.mine ?? []).some((c) => c.id === id),
    members: s.members ?? [],
  });

  return { state: { ...s, assigns: out.state }, commands: out.commands };
};

/**
 * The window told what its chrome shows whenever it changed: the `welcome` effect (the Dock
 * badge, the crumb, the page the stripe picks) and the `stripe` effect (its items, the gear).
 */
const stepTold = (s: WelcomeState, input: Input): Out => {
  const out = stepWelcome(s, input);
  const needsYou = needsYouCount(out.state);
  const crumb = out.state.crumb ?? '';
  const page = out.state.page;
  const told = `${needsYou}|${crumb}|${page}`;
  const stripe = shell({
    kind: 'stripe',
    items: welcomeStripe(out.state),
    gear: stripeGear(out.state.problems),
  });
  const striped = JSON.stringify(stripe);
  const commands = [
    ...out.commands,
    ...(out.state.told === told ? [] : [shell({ kind: 'welcome', needsYou, crumb, page })]),
    ...(out.state.striped === striped ? [] : [stripe]),
  ];

  return commands.length === out.commands.length
    ? out
    : { state: { ...out.state, told, striped }, commands };
};

export const welcomeScreen: Screen<WelcomeState> = {
  name: WELCOME_SCREEN,
  init: {
    size: { width: 1000, height: 640 },
    tab: 'mine',
    page: 'board',
    projects: [],
    assigns: NO_ASSIGNS,
    g: false,
    reading: [],
    again: [],
  },
  step: stepTold,
  view: viewWelcome,
  words: WELCOME_WORDS,
  typing,
  here: hereOf,
  linked: (s) => selectedCard(s)?.card.id,
  follows: () => FOLLOWS,
  events: WELCOME_EVENTS,
};
