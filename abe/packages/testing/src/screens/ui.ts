/** Samples for `ui`'s screens: a `serve`'s status, sessions, and their answers as a screen gets them. */
import type {
  ArgInfo,
  BoxData,
  BoxListData,
  Event,
  CardData,
  CardSheet,
  CommandInfo,
  PrototypeData,
  QueuedBoxData,
  SheetOpenData,
  SheetSummary,
  FactoryRunData,
  HelpData,
  RepoHere,
  SessionData,
  StatusData,
} from '@abe/core';
import { commandInfo } from '@abe/core';
import { type Answer, type Command, type Facts, type Input, LIVE_READS, mountLive } from '@abe/ui';

export const STATUS: StatusData = {
  version: '2.0.0',
  pid: 4242,
  startedAt: '2026-10-01T09:00:00.000Z',
  socket: '/state/abe/serve.sock',
  sessions: 2,
  workspaces: 0,
};

export const session = (id: string, state: SessionData['state'], card = 12): SessionData => ({
  id,
  card,
  prototype: null,
  kind: 'card',
  title: `Card ${card}`,
  repo: 'mkdir-swe/demo-shop',
  worktree: `/wt/${id}`,
  branch: `card/${card}-x`,
  state,
  since: '2026-10-01T09:01:00.000Z',
  startedAt: '2026-10-01T09:01:00.000Z',
  // a hook named its transcript once its claude ran, and Reopen needs one
  transcriptPath:
    state === 'starting' || state === 'queued' ? null : `/home/.claude/projects/wt/${id}.jsonl`,
  lastAssistantMessage: null,
  models: null,
  subagents: [],
  reason: null,
  stopped: false,
  setup: null,
  skillsOnTop: false,
  browserProfile: 'default',
  overrides: [],
  queue: [],
  model: null,
  effort: null,
  launch: null,
  reopened: [],
  rounds: 0,
  waitingOn: null,
});

export const statusAnswer = (data: StatusData = STATUS): Answer => ({
  kind: 'result',
  id: 'status',
  command: 'status',
  reply: { ok: true, data },
});
/**
 * The live facts after these answers and events, as the bridge hands them to a screen: every
 * live read followed, then each input in turn.
 */
export const liveFacts = (...inputs: Input[]): Facts => {
  const live = mountLive();

  live.send({ kind: 'follow', reads: LIVE_READS });
  for (const input of inputs) live.send(input);

  return live.facts;
};

/** The `live` input with `liveFacts(...inputs)`: a screen handed them by the bridge. */
export const factsInput = (...inputs: Input[]): Input => ({
  kind: 'live',
  facts: liveFacts(...inputs),
});

export const sessionsAnswer = (sessions: SessionData[], here?: RepoHere): Answer => ({
  kind: 'result',
  id: 'sessions',
  command: 'session list',
  reply: { ok: true, data: { sessions, ...(here === undefined ? {} : { here }) } },
});

/** The demo repo as `session list` and `factory status` name where they were read. */
export const DEMO_HERE: RepoHere = {
  root: '/p/demo-shop',
  checkouts: ['/p/demo-shop'],
  github: 'mkdir-swe/demo-shop',
};

const arg = (name: string, o: Partial<ArgInfo> = {}): ArgInfo => ({
  name,
  kind: 'positional',
  type: 'string',
  required: true,
  repeats: false,
  summary: `the ${name}`,
  ...o,
});

const row = (name: string, summary: string, o: Partial<CommandInfo> = {}): CommandInfo => {
  const [noun = name, ...verb] = name.split(' ');

  return {
    noun,
    verb: verb.length === 0 ? null : verb.join(' '),
    usage: `abe ${name} [--json]`,
    summary,
    inSession: true,
    only: null,
    risky: false,
    args: [],
    ...o,
  };
};

/** A small command table as `abe help --json` lists it, for Command mode's tests and fixtures. */
export const HELP: HelpData = {
  commands: [
    row('status', 'what this abe serve holds'),
    row('card list', "the Board's cards", {
      args: [arg('mine', { kind: 'flag', type: 'boolean', required: false })],
    }),
    row('card show', 'one card in full', { args: [arg('card')] }),
    row('card move', 'move a card to a column', {
      args: [arg('card'), arg('column', { kind: 'flag', type: 'enum', values: ['Doing', 'Done'] })],
    }),
    row('session stop', "stop a session's claude", { args: [arg('id')], risky: true }),
    row('factory decide', "from inside the run's session only", { only: 'session' }),
    row('watch', 'every event as it happens', { only: 'client' }),
  ],
  globalFlags: [],
  personal: [{ name: 'mine', argv: ['card', 'list', '--mine'], summary: 'my cards' }],
};

/** HELP with `abe improve`'s commands as the real table lists them, for `:improve`. */
export const IMPROVE_HELP: HelpData = {
  ...HELP,
  commands: [
    ...HELP.commands,
    commandInfo('improve'),
    commandInfo('improve apply'),
    commandInfo('improve undo'),
  ],
};

export const helpAnswer = (help: HelpData = HELP): Answer => ({
  kind: 'result',
  id: 'help',
  command: 'help',
  reply: { ok: true, data: help },
});

/** When the factory samples start. Runs move from here, and the clock reads later. */
export const AT = '2026-10-01T09:00:00.000Z';

/** A minute after `AT`, `n` times. */
export const minutes = (n: number): string => new Date(Date.parse(AT) + n * 60_000).toISOString();

/** A card of `abe card list`, in a Board column, assigned to `who` (null: no one). */
export const listCard = (
  id: number,
  title: string,
  state: string,
  who: string | null = 'Alex Example',
  rest: Partial<CardData> = {},
): CardData => ({
  id,
  title,
  state,
  type: 'User Story',
  tags: [],
  assignee:
    who === null
      ? null
      : { name: who, email: `${who.split(' ')[0]?.toLowerCase() ?? 'x'}@example.test` },
  description: '',
  acceptanceCriteria: '',
  url: `https://dev.azure.com/demo-org/Sandbox/_workitems/edit/${id}`,
  points: null,
  createdBy: null,
  ...rest,
});

/** A run of `abe factory status` on `card` in `stage`, its session `session`. */
export const factoryRun = (
  card: number,
  title: string,
  stage: FactoryRunData['stage'],
  state: FactoryRunData['state'] = 'running',
  rest: Partial<FactoryRunData> = {},
): FactoryRunData => ({
  card,
  title,
  session: `s${card}`,
  repo: 'mkdir-swe/demo-shop',
  worktree: `/wt/s${card}`,
  startedAt: AT,
  stage,
  state,
  since: AT,
  reason: state === 'needs-you' ? 'waiting on you in Chat' : null,
  needsYouSince: null,
  options: [],
  outcome: state === 'done' ? 'done' : null,
  stages: [],
  pr: null,
  round: 0,
  reviews: [],
  verifications: [],
  regression: [],
  board: null,
  hard: [],
  reference: null,
  prototype: false,
  noChecks: false,
  ended: null,
  personal: [],
  note: null,
  standing: [],
  step: null,
  workflow: null,
  context: null,
  reported: null,
  judging: null,
  judgements: [],
  playbook: null,
  brief: null,
  ...rest,
});

/** `abe card list` (`--mine` with `mine`) answering these cards. */
export const cardsAnswer = (
  cards: CardData[],
  mine: boolean,
  sprint: string | null = 'Sprint 14',
  /** The board's: Azure's, or a board on this machine's `this machine`. */
  organization = 'https://dev.azure.com/demo-org',
): Answer => ({
  kind: 'result',
  id: mine ? 'cards:mine' : 'cards:team',
  command: 'card list',
  reply: {
    ok: true,
    data: {
      board: {
        organization,
        project: 'Sandbox',
        team: 'Sandbox',
        types: ['User Story', 'Bug'],
      },
      mine,
      cards,
      sprint,
    },
  },
});

/**
 * A teammate's story as the `chat` screen learns it: your Mine without the card, then the card
 * assigned to `who`.
 */
export const theirsAnswers = (card: number, who: string, title = 'The cart total'): Answer[] => [
  { ...cardsAnswer([], true), id: 'mine' },
  { ...cardShowAnswer(listCard(card, title, 'Active', who), []), id: `card:${card}` },
];

/** `abe factory status` (`id` `runs`, `cleared`, or `run:<card>`) answering these runs. */
export const runsAnswer = (runs: FactoryRunData[], id = 'runs', here?: RepoHere): Answer => ({
  kind: 'result',
  id,
  command: 'factory status',
  reply: { ok: true, data: { runs, ...(here === undefined ? {} : { here }) } },
});

/** A Sheet as `abe sheet list` / `find` lists it (yours, unless `attached`). */
export const sheetSummary = (
  id: string,
  title: string,
  o: Partial<SheetSummary> = {},
): SheetSummary => ({
  id,
  title,
  card: null,
  session: null,
  version: 1,
  at: minutes(5),
  attached: [],
  address: `sheet://${id}`,
  ...o,
});

/** `abe sheet find <query>` (the screen's `sheet:find:<n>`) answering these Sheets. */
export const sheetFindAnswer = (
  query: string,
  sheets: SheetSummary[],
  context: { card?: number; session?: string } = {},
  /** Which of the screen's asks it answers (`sheet:find:<n>`). */
  n = 1,
): Answer => ({
  kind: 'result',
  id: `sheet:find:${n}`,
  command: 'sheet find',
  reply: {
    ok: true,
    data: { query, card: context.card ?? null, session: context.session ?? null, sheets },
  },
});

/** `abe sheet open` (the screen's `sheet:open:<n>`) with its local URL. `card` is a card's. */
export const sheetOpenAnswer = (
  id: string,
  title: string,
  o: { card?: number; version?: number; n?: number } = {},
): Answer => {
  const data: SheetOpenData = {
    id,
    title,
    version: o.version ?? 1,
    card: o.card ?? null,
    address: o.card === undefined ? `sheet://${id}` : `sheet://${o.card}/${id}`,
    url: 'http://127.0.0.1:50123/s/9f2c4e1a',
    csp: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  };

  return {
    kind: 'result',
    id: `sheet:open:${o.n ?? 1}`,
    command: 'sheet open',
    reply: { ok: true, data },
  };
};

/** A card's attached Sheet as `abe card show` lists it. */
export const cardSheet = (
  card: number,
  id: string,
  title: string,
  o: Partial<CardSheet> = {},
): CardSheet => ({
  id,
  title,
  version: 1,
  at: minutes(5),
  address: `sheet://${card}/${id}`,
  ...o,
});

/** `abe card show <card>` (the card dialog's `dialog-card:<card>`) with the card and its Sheets. */
export const cardShowAnswer = (card: CardData, sheets: CardSheet[]): Answer => ({
  kind: 'result',
  id: `dialog-card:${card.id}`,
  command: 'card show',
  reply: { ok: true, data: { ...card, comments: [], sheets } },
});
/** `abe settings get <key>` (as the screen's read `id`) answering `value`, from your own Layer. */
export const settingAnswer = (
  id: string,
  key: string,
  value: string | string[] | boolean,
): Answer => ({
  kind: 'result',
  id,
  command: 'settings get',
  reply: {
    ok: true,
    data: { key, value, layer: 'individual', lowered: null, problems: [] },
  },
});

// ---------------------------------------------------------------- Prototypes

/** A prototype of card 1234 at the demo shop's main, `state`. */
export const prototype = (
  state: PrototypeData['state'],
  rest: Partial<PrototypeData> = {},
): PrototypeData => ({
  id: 'proto-1a2b3c',
  card: 1234,
  repo: '/home/me/projects/demo-shop',
  branch: 'main',
  commit: 'c0ffee0123456789abcdef0123456789abcdef01',
  state,
  since: AT,
  url: state === 'live' ? 'http://127.0.0.1:50321' : null,
  app: state === 'live' ? 'http://127.0.0.1:5173' : null,
  reason: null,
  code: null,
  database: null,
  step: null,
  title: null,
  shot: null,
  ports: [],
  ...rest,
});

/**
 * A prototype session on `card`'s prototype `proto-1a2b3c` (null: none), as `session list` has
 * it: no card session of its own; its folder is its own, so Chat pins it by its id.
 */
export const prototypeSession = (
  state: SessionData['state'] = 'working',
  card: number | null = 1234,
  id = 'prototype-a1b2',
): SessionData => ({
  ...session(id, state, 0),
  card: null,
  kind: 'prototype',
  prototype: { id: 'proto-1a2b3c', card },
  title: card === null ? 'Prototype' : `Prototype · #${card}`,
  worktree: '/cache/abe/prototype-chats/proto-1a2b3c',
  branch: '',
});

/** `prototype list` answering these prototypes. */
export const prototypeListAnswer = (prototypes: PrototypeData[]): Answer => ({
  kind: 'result',
  id: 'proto:list',
  command: 'prototype list',
  reply: { ok: true, data: { prototypes } },
});

/**
 * Board F-Sessions' sprint. Card 1 needs you on its box. Card 2 runs locally in Build with two
 * subagents. Card 3 is on test, and its session ended. The board's clock is `AT` + 1 h 30 min.
 */
export const F_SESSIONS = (() => {
  const s1: SessionData = {
    ...session('s1', 'waiting', 1),
    title: 'Show stock on a product card',
    box: 'demo-shop-1',
    since: minutes(22),
    subagents: [
      {
        id: 'a1',
        name: 'abe:reader',
        task: null,
        model: null,
        state: 'running',
        startedAt: minutes(80),
        endedAt: null,
        result: null,
      },
    ],
  };
  const s2: SessionData = {
    ...session('s2', 'working', 2),
    title: 'The cart total ignores quantity',
    worktree: '/p/demo-shop-wt/2-cart-total',
    subagents: ['a2', 'a3'].map((id) => ({
      id,
      name: 'Explore',
      task: null,
      model: null,
      state: 'running' as const,
      startedAt: minutes(80),
      endedAt: null,
      result: null,
    })),
  };
  const s3: SessionData = { ...session('s3', 'ended', 3), title: 'Pin the Node version' };

  return {
    now: minutes(90),
    sessions: [s2, s3, s1],
    runs: [
      factoryRun(1, 'Show stock on a product card', 'spec', 'needs-you', {
        session: 's1',
        since: minutes(22),
      }),
      factoryRun(2, 'The cart total ignores quantity', 'build', 'running', {
        session: 's2',
        since: minutes(69),
      }),
      factoryRun(3, 'Pin the Node version', 'done', 'done', { session: 's3', since: minutes(59) }),
    ],
    cards: [
      listCard(1, 'Show stock on a product card', 'New'),
      listCard(2, 'The cart total ignores quantity', 'Active', 'Alex Example', { type: 'Bug' }),
      listCard(3, 'Pin the Node version', 'Resolved'),
    ],
  };
})();

/**
 * The header's demo, as boards H-EditorB and H-States draw it, with `demo-shop`'s three story
 * workspaces. Card 2 is local in Build, running 21 min. Card 3 is done and on test, with its box
 * `demo-shop-3` asleep. Card 1 is in Spec on box `demo-shop-102`, waiting on you. `HEADER_NOW` is
 * 21 minutes after card 2's Build began.
 */
export const HEADER_NOW = '2026-10-01T09:21:00.000Z';
export const headerDemo = (): { runs: FactoryRunData[]; sessions: SessionData[] } => ({
  runs: [
    factoryRun(2, 'The cart total ignores quantity', 'build', 'running', {
      worktree: '/home/me/projects/demo-shop-wt/2-cart-total',
    }),
    factoryRun(3, 'Pin the Node version', 'done', 'done', {
      worktree: '/workspace/repo',
      since: '2026-10-01T08:50:00.000Z',
    }),
    factoryRun(1, 'Show stock on a product card', 'spec', 'needs-you', {
      worktree: '/workspace/repo',
    }),
  ],
  sessions: [
    {
      ...session('s2', 'working', 2),
      title: 'The cart total ignores quantity',
      worktree: '/home/me/projects/demo-shop-wt/2-cart-total',
      branch: 'card/2-the-cart-total-ignores-quantity',
    },
    {
      ...session('s3', 'ended', 3),
      title: 'Pin the Node version',
      worktree: '/workspace/repo',
      branch: 'card/3-pin-the-node-version',
      box: 'demo-shop-3',
    },
    {
      ...session('s1', 'waiting', 1),
      title: 'Show stock on a product card',
      worktree: '/workspace/repo',
      branch: 'card/1-show-stock-on-a-product-card',
      box: 'demo-shop-102',
      since: '2026-10-01T09:13:00.000Z',
    },
  ],
});

/**
 * Chat on a card with the keys. The window's Chat column opens on it (or on one of its sessions)
 * and then takes the keys, as a screen asks for them.
 */
export const chatOpened = (card: number, session?: string): Command[] => [
  {
    kind: 'open',
    screen: 'chat',
    params: session === undefined ? { card: String(card) } : { card: String(card), session },
    slot: 'chat',
  },
  { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
];

/** The commands that open the Chat column or give it the keys, in order. */
export const chatCommands = (commands: readonly Command[]): Command[] =>
  commands.filter(
    (c) =>
      (c.kind === 'open' && c.screen === 'chat') ||
      (c.kind === 'shell' && c.effect.kind === 'focus' && c.effect.slot === 'chat'),
  );

/**
 * Board X-Boxes' boxes. Their times are built on the local clock so `stops at 10:30` reads the
 * same in every time zone, and `now` is 10:00 local on 1 Oct 2026. Each is a box of the repo with
 * no card tag (ADR 0022), and `ws` makes a workspace to put on one. demo-shop-1 runs (up 1 h
 * 12 min, $0.12, stops at 10:30). demo-shop-3 sleeps ($0.84 today). demo-shop-2 is stuck starting
 * (6 min). demo-shop-4 runs with its serve silent. demo-shop-5 is Queued for card 5. `old` is a
 * box from an older release, made for card 9 and tagged with it. `titles` are the board's titles
 * of the cards.
 */
export const X_BOXES = (() => {
  const local = (h: number, m: number) => new Date(2026, 9, 1, h, m).toISOString();
  const now = local(10, 0);
  const box = (name: string, o: Partial<BoxData> = {}): BoxData => ({
    name,
    state: 'running',
    size: 'm8g.large',
    launchedAt: local(8, 48),
    release: 11,
    repo: 'mkdir-swe/demo-shop',
    card: null,
    title: null,
    costToday: { usd: 0.12, minutes: 72, hourly: 0.10004, at: now },
    serve: 'answers',
    workspace: null,
    ...o,
  });
  const idle = (
    stopsAt: string | null,
    keptBy: ('awake' | 'attached' | 'working' | 'pr')[] = [],
  ) => ({
    minutes: 30,
    activeAt: local(10, 0),
    stopsAt,
    keptBy,
  });
  /** A card's box workspace on `repo`'s box, as its `abe status` lists it. */
  const ws = (card: number, repo: string, state: 'running' | 'stopped' = 'running') => ({
    repo,
    card: String(card),
    branch: `card/${card}`,
    state,
    container: `abe-ws-${card}`,
    image: `abe-workspace-${repo.replace('/', '-')}:latest`,
    database: `ws_${card}`,
    imageCurrent: true,
  });
  const running = box('demo-shop-1', {
    repo: 'mkdir-swe/demo-shop',
    idle: idle(local(10, 30)),
  });
  const asleep = box('demo-shop-3', {
    state: 'stopped',
    repo: 'mkdir-swe/demo-shop',
    launchedAt: local(1, 0),
    costToday: { usd: 0.84, minutes: 504, hourly: 0.10004, at: now },
    serve: null,
  });
  const stuck = box('demo-shop-2', {
    state: 'pending',
    repo: 'mkdir-swe/demo-shop',
    launchedAt: local(9, 54),
    costToday: { usd: 0.01, minutes: 6, hourly: 0.10004, at: now },
    serve: null,
  });
  const silent = box('demo-shop-4', {
    repo: 'mkdir-swe/demo-shop',
    serve: 'silent',
  });
  const queued: QueuedBoxData = {
    box: 'demo-shop-5',
    repo: 'mkdir-swe/demo-shop',
    card: 5,
    title: 'Show delivery dates',
    since: local(9, 40),
  };
  /** A box from an older release, made for card 9 alone. Nothing launches on it. */
  const old = box('demo-shop-9', {
    state: 'stopped',
    repo: 'mkdir-swe/demo-shop',
    card: 9,
    title: 'Saved carts',
    costToday: { usd: 0, minutes: 0, hourly: 0.10004, at: now },
    serve: null,
  });
  /** The board's titles of the cards the boxes' workspaces hold. */
  const titles: Record<number, string> = {
    1: 'Show stock on a product card',
    2: 'The cart total ignores quantity',
    3: 'Pin the Node version',
    4: 'Sort products by price',
  };

  return { now, local, box, ws, idle, running, asleep, stuck, silent, queued, old, titles };
})();

/** `box list`'s answer, as the Boxes tab gets it. */
export const boxesAnswer = (
  boxes: BoxData[],
  queued: QueuedBoxData[] = [],
  id = 'boxes',
  here?: RepoHere,
): Answer => {
  const data: BoxListData = { boxes, queued, ...(here === undefined ? {} : { here }) };

  return { kind: 'result', id, command: 'box list', reply: { ok: true, data } };
};

/** An event without its `seq` and `at`, typed per row of the table (an `Omit` of each member). */
export type EventBody = Event extends infer E
  ? E extends Event
    ? Omit<E, 'seq' | 'at'>
    : never
  : never;

/**
 * The `event` input a screen gets from `abe watch`. It has `e`'s type and data as the table types
 * them, at `at` (else `e.at`), numbered `seq`.
 */
export const eventInput = (
  e: EventBody & { at?: string; seq?: number },
  at = '2026-10-01T09:00:00.000Z',
): Input => {
  const { at: own, seq, ...body } = e;
  const event: Event = { ...body, seq: seq ?? 1, at: own ?? at };

  return { kind: 'event', event };
};
