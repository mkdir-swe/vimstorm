/**
 * The Board's own rules, through the shared driver as the bridge drives it: its reads answered
 * from a `BoardWorld`, `abe watch` events, the clock, keys and clicks, Command mode over it. Local
 * mode's band, Held writes and local pull request are in `local-view.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { BoxData, CardData, Event, FactoryRunData, SessionData } from '@abe/core';
import { installView, newInstall, screenClock } from '@abe/core';
import {
  type Answer,
  AT,
  BOARD_MINE,
  BOARD_RUNS,
  BOARD_SESSIONS,
  BOARD_TEAM,
  type BoardWorld,
  boardReplies,
  boxesAnswer,
  chatCommands,
  chatOpened,
  type Command,
  DEMO_HERE,
  type DriveOptions,
  driveBoard,
  driveScreen,
  eventInput,
  factoryRun,
  type Input,
  listCard,
  minutes,
  type Node,
  nodeById,
  nodesOf,
  type Replies,
  repliesBy,
  runsAnswer,
  session,
  sessionsAnswer,
  type ShellEffect,
  X_BOXES,
} from '@abe/testing';
import { BOXES_OFF } from '@abe/core/box-text';
import { BOX_SLEPT_WAITING, cardScreen } from './index';

type Board = ReturnType<typeof driveBoard>;

/** The clock the Board opens on: the sample runs began 1 and 2 minutes after `AT`. */
const NOW = minutes(6);

/** The Board on `world`, its reads answered, at `NOW`. */
const board = (world: BoardWorld = {}, o: Omit<DriveOptions, 'replies'> = {}): Board =>
  driveBoard({ now: NOW, world, ...o });

/** The Board with nothing answered yet, for what it shows while it reads. */
const unread = (o: Omit<DriveOptions, 'replies'> = {}): Board =>
  driveBoard({ now: NOW, replies: () => undefined, ...o });

/** `d` with what it did so far put aside, so a test reads what the next input does. */
const fresh = (d: Board): Board => {
  d.take();

  return d;
};

/** Only the reads `commands` names, answered from `replies`. */
const only =
  (replies: Replies, ...commands: string[]): Replies =>
  (asked) =>
    commands.some((c) => asked.argv.join(' ').startsWith(c)) ? replies(asked) : undefined;

/** `replies` for one answer only, so a read asked again stays out for the test to see. */
const once = (replies: Replies): Replies => {
  let used = false;

  return (asked) => {
    const reply = used ? undefined : replies(asked);

    if (reply !== undefined) used = true;

    return reply;
  };
};

const props = (tree: Node | undefined, id: string): Record<string, unknown> =>
  nodeById(tree, id).props;

/** The ids under a node, of one kind, in order. */
const ids = (tree: Node, id: string, kind: Node['kind']): string[] =>
  nodesOf(nodeById(tree, id))
    .filter((n) => n.kind === kind)
    .map((n) => n.id ?? '');

/** Which node draws a selection, and how: `card:4 selected`. */
const selected = (tree: Node): string[] =>
  nodesOf(tree).flatMap((n) => {
    const p: Record<string, unknown> = n.props;
    const look = p.selection ?? (n.kind === 'ListRow' ? p.state : undefined);

    return look === 'selected' || look === 'selected-inactive' ? [`${n.id ?? ''} ${look}`] : [];
  });

/** The column the ring is on. */
const focusedColumn = (tree: Node): string | undefined =>
  nodesOf(tree).find((n) => n.kind === 'BoardColumn' && props(tree, n.id ?? '').focused === true)
    ?.id;

/** The reads still out, as `abe` argv. */
const reads = (d: Board): string[] => d.asked.map((a) => a.argv.join(' '));

/** The shell effects of one kind, in order. */
const effects = <K extends ShellEffect['kind']>(
  d: Board,
  kind: K,
): Extract<ShellEffect, { kind: K }>[] =>
  d.effects.filter((e): e is Extract<ShellEffect, { kind: K }> => e.kind === kind);

/** The stripe's items the Board sent last. */
const stripe = (d: Board) => effects(d, 'stripe').at(-1)?.items ?? [];
type StripeItem = ReturnType<typeof stripe>[number];

/** The status bar's widgets, every one sent. */
const widgets = (d: Board) => effects(d, 'widgets').flatMap((e) => e.widgets);

const menuOf = (d: Board) => {
  const m = d.commands.find((c) => c.kind === 'menu');

  if (m?.kind !== 'menu') throw new Error('no menu asked');

  return m;
};

/** A card's menu, as a right-click opens it. */
const cardMenu = (d: Board, card: number) => menuOf(fresh(d).click(`menu:card:${card}`));

/** A row of a card's menu, picked in Command mode, after what it did so far is put aside. */
const pick = (d: Board, card: number, row: string): Board =>
  fresh(d).click(`menu:card:${card}`).click(row);

const tick = (at: string): Input => ({ kind: 'tick', at });

const refused = (
  command: 'card list' | 'session list' | 'box list',
  code: string,
  message: string,
): Answer => ({
  kind: 'result',
  id: '',
  command,
  reply: { ok: false, error: { code, message } },
});

const stage = (
  card: number,
  from: FactoryRunData['stage'] | null,
  to: FactoryRunData['stage'],
  state: FactoryRunData['state'],
  cause: string,
  at: string,
  more: Partial<Extract<Event, { type: 'factory.stage' }>['data']> = {},
): Input =>
  eventInput(
    {
      type: 'factory.stage',
      seq: 10,
      data: {
        card,
        session: `s${card}`,
        stage: to,
        from,
        state,
        reason: state === 'needs-you' ? 'which test account?' : null,
        since: at,
        cause,
        outcome: null,
        ...more,
      },
    },
    at,
  );

const sessionState = (
  id: string,
  card: number,
  state: SessionData['state'],
  cause: string,
  at = minutes(8),
): Input =>
  eventInput({ type: 'session.state', seq: 12, data: { id, card, state, since: at, cause } }, at);

const boxState = (box: string, state: 'running' | 'stopped' | 'starting' | 'queued', at = 8) =>
  eventInput({ type: 'box.state', seq: 20, data: { box, state, cause: 'x' } }, minutes(at));

const cardMoved = (card: number, column: 'active' | 'done', state: string): Input =>
  eventInput(
    {
      type: 'factory.card',
      seq: 13,
      data: { card, session: `s${card}`, column, state, error: null },
    },
    minutes(7),
  );

const commandRan = (noun: string, verb: string): Input =>
  eventInput({ type: 'command.ran', seq: 9, data: { noun, verb, exit: 0 } }, AT);

describe('the Board on open', () => {
  test('reads both card lists, the runs, the sessions, your boxes, the team, the install, local mode, the settings it draws by and Settings’ problems', () => {
    expect(reads(unread())).toEqual([
      // the board's team, for Assign…
      'card members',
      // a repo not in the Factory yet is offered :install
      'install status',
      // local mode here: the band, the badge, the dashed cards, Held writes
      'local status',
      'settings get serve.target',
      // what Settings lists first: the ear's Settings ⚠ N
      'settings problems',
      // the live facts it follows, read once for every screen open
      'session list',
      'factory status',
      'box list',
      // your prototypes: a tile each on the rail
      'prototype list',
      // the card lists, live's too: the sprint's done cards with them
      'card list --mine --closed',
      'card list --closed',
    ]);
  });

  test('the Board alone: its header, the Azure columns with their cards; no bands, lanes, History or session cards', () => {
    const { tree } = board();

    expect(ids(tree, 'board', 'BoardColumn')).toEqual([
      'col:New',
      'col:Active',
      'col:Resolved',
      'col:Closed',
    ]);
    expect(ids(tree, 'col:New', 'BoardCard')).toEqual(['card:5', 'card:6']);
    expect(props(tree, 'col:Closed')).toMatchObject({ name: 'Closed', count: 0 });
    expect(props(tree, 'board-head')).toMatchObject({
      title: 'Board',
      tabs: [
        { id: 'tab:mine', label: 'Mine' },
        { id: 'tab:team', label: 'Team' },
        { id: 'tab:sessions', label: 'Sessions' },
      ],
      selected: 'tab:mine',
      counts: [{ text: 'Sprint 14 · 4 cards', hue: 'dim' }],
    });
    expect(nodesOf(tree).some((n) => n.kind === 'ListRow')).toBe(false);
    expect(
      nodesOf(tree)
        .map((n) => n.id ?? '')
        .filter((id) => /^(flow|cards|history|lane:|run:)/.test(id)),
    ).toEqual([]);
  });

  const CLOSED = [
    listCard(8, 'Order history paginates', 'Closed', 'Alex Example'),
    listCard(10, 'Guest checkout', 'Closed'),
  ];
  const MERGED = factoryRun(8, 'Order history paginates', 'done', 'done', { since: minutes(1) });
  const DONE = factoryRun(7, 'Friendly greeting with no name', 'done', 'done', {
    since: minutes(1),
  });

  test.each<[string, BoardWorld, number, Record<string, unknown>, string[]]>([
    [
      'a running card on a box: segments, stage, the state in its hue, the time, its box, its points',
      {},
      4,
      {
        type: 'US',
        initials: 'AE',
        points: '3 pt',
        title: 'Cart total includes shipping',
        rail: {
          segments: ['done', 'now', 'todo', 'todo', 'todo'],
          stage: 'Build',
          glyph: '●',
          word: 'Running',
          state: 'running',
          time: '4 min',
          box: 'running',
        },
        emphasis: 'normal',
      },
      [],
    ],
    [
      'a card that needs you, run locally: no box mark',
      {},
      5,
      {
        rail: {
          segments: ['done', 'done', 'need', 'todo', 'todo'],
          stage: 'Verify',
          glyph: '◆',
          word: 'Needs you',
          state: 'needs-you',
          time: '5 min',
        },
        emphasis: 'needs-you',
      },
      ['rail.box', 'points'],
    ],
    [
      'a bug with no run: No session, no rail',
      {},
      6,
      { type: 'Bug', bug: true, emphasis: 'normal', note: { text: 'No session' } },
      ['rail', 'closed'],
    ],
    ['a card with no reason: its tooltip adds nothing', {}, 7, {}, ['tipAdds']],
    [
      'Done: ✓ On test and its time, no stage word',
      { runs: [DONE] },
      7,
      {
        rail: {
          segments: ['done', 'done', 'done', 'done', 'done'],
          glyph: '✓',
          word: 'On test',
          state: 'on-test',
          time: '5 min',
        },
      },
      ['rail.stage'],
    ],
    [
      "the sprint's done card in Closed, dim: its run's outcome",
      {
        mine: [...BOARD_MINE, ...CLOSED],
        team: [...BOARD_TEAM, ...CLOSED],
        runs: [...BOARD_RUNS, MERGED],
      },
      8,
      { closed: true, rail: { glyph: '✓', word: 'On test' } },
      [],
    ],
    [
      "the sprint's done card with no run: ✓ Done",
      { mine: [...BOARD_MINE, ...CLOSED], team: [...BOARD_TEAM, ...CLOSED] },
      10,
      { closed: true, note: { text: '✓ Done' } },
      [],
    ],
  ])("a card's line: %s", (_, world, card, want, absent) => {
    const p = props(board(world).tree, `card:${card}`);

    expect(p).toMatchObject(want);
    for (const key of absent) expect(p).not.toHaveProperty(key);
  });

  test("the sprint's done cards sit in Closed, counted", () => {
    const { tree } = board({ mine: [...BOARD_MINE, ...CLOSED], team: [...BOARD_TEAM, ...CLOSED] });

    expect(ids(tree, 'col:Closed', 'BoardCard')).toEqual(['card:8', 'card:10']);
    expect(props(tree, 'col:Closed')).toMatchObject({ count: 2 });
  });
});

describe('the stripe and the status bar', () => {
  test('Sessions and Board dotted needs you; the status bar counts nothing twice', () => {
    const d = board();

    expect(stripe(d).find((i) => i.id === 'sessions')).toEqual({
      id: 'sessions',
      label: 'Sessions',
      icon: 'history',
      group: 'bottom',
      key: '⌘5',
      dot: 'needs-you',
      tooltip: 'Sessions · ⌘5 · #5 Saved carts survive sign-out needs you · 1 running',
    });
    expect(stripe(d).find((i) => i.id === 'board')).toMatchObject({
      dot: 'needs-you',
      tooltip: 'Board · ⌘⌥A · #5 Saved carts survive sign-out needs you',
    });
    expect(
      effects(d, 'widgets')
        .at(-1)
        ?.widgets.map((w) => w.id),
    ).toEqual([]);
  });

  // card 4 a Factory run, card 5 a plain session nobody assigned: both run, as the Sessions tab shows
  const PLAIN = session('s5', 'working', 5);

  test.each<[string, BoardWorld, string[], string]>([
    [
      'a run and a plain session with no run, both working: two running',
      {
        runs: [factoryRun(4, 'Cart total includes shipping', 'build', 'running')],
        sessions: [{ ...session('s4', 'working', 4), box: 'alex-1' }, PLAIN],
      },
      ['sessions Sessions · ⌘5 · 2 running'],
      '2 running',
    ],
    [
      'the run waits on you, the plain session works: Sessions says who needs you, Board carries it',
      {
        runs: [factoryRun(4, 'Cart total includes shipping', 'verify', 'needs-you')],
        sessions: [session('s4', 'waiting', 4), PLAIN],
      },
      [
        'board Board · ⌘⌥A · #4 Cart total includes shipping needs you',
        'sessions Sessions · ⌘5 · #4 Cart total includes shipping needs you · 1 running',
      ],
      '1 needs you, 1 running',
    ],
  ])('the pill and the stripe count what the Sessions tab shows: %s', (_, world, bar, pill) => {
    const d = board(world);

    expect(stripe(d).flatMap((i) => (i.dot === undefined ? [] : [`${i.id} ${i.tooltip}`]))).toEqual(
      bar,
    );
    expect(effects(d, 'workspaces').at(-1)?.factory.label).toContain(pill);
  });
});

describe('the board read', () => {
  const NO_BOARD = refused('card list', 'no-board', 'no board in the settings');
  const noBoard: Replies = repliesBy({ 'card list': NO_BOARD });
  const CUT = refused(
    'card list',
    'board-unreachable',
    'Azure DevOps cannot be reached at 127.0.0.1:7466: connection refused',
  );
  const cut: Replies = repliesBy({ 'card list': CUT });

  test.each<[string, () => Board, string | undefined, number]>([
    [
      'refused on open: says why in the header, the columns drawn',
      () => unread().answer(noBoard),
      'Board not read · no board in the settings',
      0,
    ],
    [
      'refused when read again: its last cards stay',
      () => fresh(board()).keys('r').answer(noBoard),
      'Board not read · no board in the settings',
      4,
    ],
    ['r: Reading… at the header’s right, its cards kept', () => board().keys('r'), 'Reading…', 4],
    ['answered after r: the note goes', () => board().keys('r').answer(), undefined, 4],
    [
      'a filter kept while it is read again: both',
      // ⏎ in the filter opens the card's page, the filter kept
      () => board().keys('/', 'c', 'a', 'r', 't', '<CR>', 'r'),
      '/cart · Reading…',
      2,
    ],
    [
      'refused, then read again: Reading… in place of why',
      () => unread().answer(noBoard).keys('r'),
      'Reading…',
      0,
    ],
    [
      'refused, read again and refused: why again',
      () => unread().answer(noBoard).keys('r').answer(noBoard),
      'Board not read · no board in the settings',
      0,
    ],
  ])('the header says how the board read: %s', (_, at, note, cards) => {
    const { tree } = at();

    expect(props(tree, 'board-head').note).toBe(note);
    expect(ids(tree, 'board', 'BoardColumn')).toHaveLength(4);
    expect(ids(tree, 'board', 'BoardCard')).toHaveLength(cards);
  });

  test.each<[string, () => Board, Record<string, unknown>]>([
    [
      'being read: says so, counts nothing, never an empty sprint',
      () => unread(),
      { empty: 'Reading the board…' },
    ],
    [
      'a filter typed during the first read: the read wins',
      () => unread().keys('/', 'z'),
      { empty: 'Reading the board…' },
    ],
    [
      'an empty sprint: says so',
      () => board({ mine: [], team: [], sprint: 'Sprint 1', runs: [] }),
      { count: 0, empty: 'No stories in Sprint 1' },
    ],
    [
      'a board on this machine, empty: no sprint to name',
      () => board({ mine: [], team: [], sprint: null, organization: 'this machine', runs: [] }),
      { count: 0, empty: 'No cards yet' },
    ],
    ['refused: no word there, the header says why', () => unread().answer(noBoard), {}],
  ])('the first column: %s', (name, at, want) => {
    const { tree } = at();

    expect(props(tree, 'col:New')).toMatchObject(want);
    if (!('empty' in want)) expect(props(tree, 'col:New').empty).toBeUndefined();
    expect(props(tree, 'col:Active').empty).toBeUndefined();
    if (name.startsWith('being')) {
      for (const c of ['col:New', 'col:Active', 'col:Resolved', 'col:Closed'])
        expect(props(tree, c).count).toBeUndefined();
      expect(props(tree, 'board-head')).toMatchObject({ counts: [] });
      expect(props(tree, 'board-head').note).toBeUndefined();
    }
  });

  /** `install status` of an install going on (its record, at Env files), or a join not begun. */
  const status = (join: boolean): Replies =>
    repliesBy({
      'install status': {
        kind: 'result',
        id: '',
        command: 'install status',
        reply: {
          ok: true,
          data: installView(newInstall('/r/demo-shop', '2026-10-28T06:00:00.000Z', join)),
        },
      },
    });
  const installing = status(false);

  /** `install status` as serve answers a repo: `no-install`, or a worktree's. */
  const install = (code: string): Replies =>
    repliesBy({
      'install status': {
        kind: 'result',
        id: '',
        command: 'install status',
        reply: { ok: false, error: { code, message: code } },
      },
    });

  test.each<[string, BoardWorld, string | undefined, boolean]>([
    [
      'not in the Factory, no board: the hint, ⏎ installs',
      { more: (a) => install('no-install')(a) ?? noBoard(a) },
      'Not set up for Abe yet · Install ⏎',
      true,
    ],
    [
      'not in the Factory, its board read: ⏎ stays the card’s, the hint names the word',
      { more: install('no-install') },
      'Not set up for Abe yet · :install',
      false,
    ],
    [
      'an install going on, no board yet: it says so, ⏎ back to it',
      { more: (a) => installing(a) ?? noBoard(a) },
      'Install in progress · ⏎',
      true,
    ],
    [
      'a teammate’s, not joined on this machine: the board’s own note',
      { more: (a) => status(true)(a) ?? noBoard(a) },
      'Board not read · no board in the settings',
      false,
    ],
    [
      'a worktree: nothing offered',
      { more: (a) => install('not-main-checkout')(a) ?? noBoard(a) },
      'Board not read · no board in the settings',
      false,
    ],
  ])(':install offered on the Board: %s', (_, world, note, installs) => {
    const d = board(world);

    expect(props(d.tree, 'board-head').note).toBe(note);
    fresh(d).keys('<CR>');
    expect(d.commands.some((c) => c.kind === 'open' && c.params?.install === '1')).toBe(installs);
  });

  /** `s` seconds after `NOW`. */
  const later = (s: number): Input => tick(new Date(Date.parse(NOW) + s * 1000).toISOString());
  const cardReads = (d: Board) => reads(d).filter((r) => r.startsWith('card '));

  // (read again by the clock while it fails, on a backoff: live's, its table's rows)
  test('a board that did not answer is read again at once when the view is shown again; one that answers is not', () => {
    const shown: Input = {
      kind: 'open',
      params: { from: 'editor' },
      size: { width: 1440, height: 846 },
    };
    const d = fresh(board()).keys('r').answer(cut).send(later(15));

    expect(cardReads(fresh(d).send(shown))).toEqual([
      'card list --mine --closed',
      'card list --closed',
    ]);
    d.answer();
    expect(cardReads(fresh(d).send(shown))).toEqual([]);
  });
});

const k = (...keys: string[]): Input[] => keys.map((key): Input => ({ kind: 'key', key }));
const click = (id: string): Input => ({ kind: 'click', id });
const resize = (width: number): Input => ({ kind: 'resize', size: { width, height: 846 } });
const SIZE = { width: 1440, height: 846 };
const opened = (params: Readonly<Record<string, string>>): Input => ({
  kind: 'open',
  params,
  size: SIZE,
});

/** Card 5 in New and card 7 in Resolved: Active and Closed empty between and after them. */
const TWO: BoardWorld = {
  mine: [
    listCard(5, 'Saved carts survive sign-out', 'New'),
    listCard(7, 'Friendly greeting with no name', 'Resolved'),
  ],
  team: [
    listCard(5, 'Saved carts survive sign-out', 'New'),
    listCard(7, 'Friendly greeting with no name', 'Resolved'),
    listCard(9, 'Coupon field accepts spaces', 'Active', 'Sam Sample'),
  ],
  runs: [],
};

/** The column the card sits in on the tab shown. */
const columnOf = (tree: Node, card: number): string | undefined =>
  nodesOf(tree).find(
    (n) => n.kind === 'BoardColumn' && ids(tree, n.id ?? '', 'BoardCard').includes(`card:${card}`),
  )?.id;

/** The `selected` effects, the cards Chat follows. */
const told = (d: Board) => effects(d, 'selected');

describe('the columns', () => {
  test.each<
    [
      string,
      BoardWorld,
      number,
      Input[],
      { scroll?: unknown; more?: string; ring?: string; selected?: string[] },
    ]
  >([
    [
      'under 200 px a column: three in view fill the Board whole, none cut at the edge',
      {},
      780,
      [],
      { scroll: { width: 248, offset: 0, view: 756 }, more: 'Closed 0 ›' },
    ],
    [
      'a card in view selected: not scrolled',
      {},
      780,
      k('ä', 'ä'),
      { scroll: { width: 248, offset: 0, view: 756 }, selected: ['card:7 selected'] },
    ],
    [
      'narrowed: scrolled sideways to keep the selected one in view',
      {},
      780,
      [...k('ä', 'ä'), resize(600)],
      { scroll: { width: 285, offset: 291, view: 576 }, more: '‹ New 2 · Closed 0 ›' },
    ],
    [
      'k back: scrolled back',
      {},
      780,
      [...k('ä', 'ä'), resize(600), ...k('k', 'k')],
      { scroll: { width: 285, offset: 0, view: 576 }, more: 'Resolved 1 · Closed 0 ›' },
    ],
    [
      'ä past the last card: only the empty Closed further, it stays, not scrolled',
      {},
      780,
      k('ä', 'ä', 'ä'),
      {
        scroll: { width: 248, offset: 0, view: 756 },
        more: 'Closed 0 ›',
        ring: 'col:Resolved',
        selected: ['card:7 selected'],
      },
    ],
    [
      'k on back to the first: scrolled to the start',
      {},
      780,
      k('ä', 'ä', 'ä', 'k', 'k', 'k'),
      { scroll: { width: 248, offset: 0, view: 756 } },
    ],
    ['the ones out of view named', TWO, 400, [], { more: 'Active 0 · Resolved 1 · Closed 0 ›' }],
    [
      'ä over an empty column scrolls the next with cards into view',
      TWO,
      400,
      k('ä'),
      { scroll: { offset: 764 }, more: '‹ New 1 · Active 0 · Closed 0 ›', ring: 'col:Resolved' },
    ],
    [
      'a count past the last with cards, narrowed: that card stays in view',
      TWO,
      1440,
      [...k('3', 'ä'), resize(600)],
      { scroll: { width: 285, offset: 291, view: 576 }, ring: 'col:Resolved' },
    ],
    [
      'k back over the empty column between: scrolled to the start in one press',
      TWO,
      1440,
      [...k('3', 'ä'), resize(600), ...k('k')],
      {
        scroll: { width: 285, offset: 0, view: 576 },
        more: 'Resolved 1 · Closed 0 ›',
        ring: 'col:New',
      },
    ],
  ])('%s', (_, world, width, inputs, want) => {
    const { tree } = board(world, { size: { width, height: 846 } }).send(...inputs);

    expect({
      scroll: props(tree, 'columns').scroll,
      more: props(tree, 'board-head').more,
      ring: focusedColumn(tree),
      selected: selected(tree),
    }).toMatchObject(want);
  });

  test.each<[string, number, Input[], Record<string, unknown>, string[]]>([
    [
      'wide enough: equal shares, nothing scrolled, before or after',
      1440,
      [],
      { columns: {}, count: 1 },
      ['card:5 selected'],
    ],
    [
      'the selected card: the Board follows it, filled to its right edge, New named at the left',
      780,
      k('ä', 'ä'),
      // no blank band at the right: four of 248 and three gaps less 254 is the 756 in view
      { columns: { scroll: { width: 248, offset: 254, view: 756 } }, more: '‹ New 2' },
      ['card:7 selected'],
    ],
  ])('a card serve moved into Closed: %s', (_, width, before, want, picked) => {
    const d = board({}, { size: { width, height: 846 } }).send(...before);
    const wide = props(d.tree, 'columns');

    d.send(cardMoved(7, 'done', 'Closed'));
    if (width === 1440) expect(wide).toEqual({});
    expect({
      columns: props(d.tree, 'columns'),
      count: props(d.tree, 'col:Closed').count,
      more: props(d.tree, 'board-head').more,
    }).toMatchObject(want);
    expect(selected(d.tree)).toEqual(picked);
  });
});

describe('keys and clicks', () => {
  test.each<[string, BoardWorld, Input[], string[], string | undefined]>([
    ['on open: the first card', {}, [], ['card:5 selected'], 'col:New'],
    ['ö the next card in the column', {}, k('ö'), ['card:6 selected'], 'col:New'],
    ['ö past the last card: it stays', {}, k('ö', 'ö'), ['card:6 selected'], 'col:New'],
    ['ä the next column', {}, k('ö', 'ä'), ['card:4 selected'], 'col:Active'],
    ['ä again', {}, k('ö', 'ä', 'ä'), ['card:7 selected'], 'col:Resolved'],
    [
      'ä past the last card: only the empty Closed further, it stays',
      {},
      k('ö', 'ä', 'ä', 'ä'),
      ['card:7 selected'],
      'col:Resolved',
    ],
    [
      'k back and l up',
      {},
      k('ö', 'ä', 'ä', 'ä', 'k', 'k', 'k', 'l'),
      ['card:5 selected'],
      'col:New',
    ],
    ['G the last of a column', {}, k('G'), ['card:6 selected'], 'col:New'],
    ['gg the first', {}, k('G', 'g', 'g'), ['card:5 selected'], 'col:New'],
    ['a click selects', {}, [click('card:7')], ['card:7 selected'], 'col:Resolved'],
    [
      'ä over an empty column between cards: the next card',
      TWO,
      k('ä'),
      ['card:7 selected'],
      'col:Resolved',
    ],
    [
      'ä on: only the empty Closed further, it stays',
      TWO,
      k('ä', 'ä'),
      ['card:7 selected'],
      'col:Resolved',
    ],
    ['k back over it too', TWO, k('ä', 'k'), ['card:5 selected'], 'col:New'],
    [
      'a count moves that many columns with cards',
      {},
      k('2', 'ä'),
      ['card:7 selected'],
      'col:Resolved',
    ],
    ['a count back', {}, k('2', 'ä', '2', 'k'), ['card:5 selected'], 'col:New'],
    [
      'a count past the last with cards: as far as there are',
      TWO,
      k('3', 'ä'),
      ['card:7 selected'],
      'col:Resolved',
    ],
  ])('%s', (_, world, inputs, picked, ring) => {
    const { tree } = board(world).send(...inputs);

    expect(selected(tree)).toEqual(picked);
    expect(focusedColumn(tree)).toBe(ring);
  });

  test.each<[string, BoardWorld, Input[], Extract<ShellEffect, { kind: 'selected' }>]>([
    [
      'the first card read',
      {},
      [],
      { kind: 'selected', card: 5, owner: null, title: 'Saved carts survive sign-out' },
    ],
    [
      'a key',
      {},
      k('ö'),
      { kind: 'selected', card: 6, owner: null, title: 'Greeted by time of day' },
    ],
    [
      'a Team card assigned to someone else: their name, Chat read-only',
      {},
      [...k('<Tab>'), click('card:9')],
      { kind: 'selected', card: 9, owner: 'Sam Sample', title: 'Coupon field accepts spaces' },
    ],
    [
      'yours on Team is yours',
      {},
      [...k('<Tab>'), click('card:9'), click('card:4')],
      { kind: 'selected', card: 4, owner: null, title: 'Cart total includes shipping' },
    ],
  ])(
    'the selection is the `selected` shell effect, Chat follows it: %s',
    (_, world, inputs, want) => {
      expect(told(board(world).send(...inputs)).at(-1)).toEqual(want);
    },
  );

  test('a click on the selected card shows its Chat (off the Abe chat); on another, it is selected (M5)', () => {
    const d = board().click('card:5');

    expect(d.commands).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { card: '5', picked: '1', title: 'Saved carts survive sign-out' },
      slot: 'chat',
      ifOpen: true,
    });
    fresh(d).click('card:4');
    expect(d.commands.some((c) => c.kind === 'open' && c.screen === 'chat')).toBe(false);
    expect(told(d).at(-1)).toMatchObject({ card: 4 });
  });

  test('nothing read yet: no `selected` said, so Chat is never put on no card while the Board reads', () => {
    expect(told(unread())).toEqual([]);
  });

  test('a card just assigned to you is never a teammate’s while Mine is read again', () => {
    const d = board().keys('<Tab>').click('card:9');
    const assigned = listCard(9, 'Coupon field accepts spaces', 'New', 'Alex Example');
    const after = boardReplies({
      mine: [...BOARD_MINE, assigned],
      team: [...BOARD_MINE, assigned],
    });

    expect(told(d).at(-1)).toMatchObject({ card: 9, owner: 'Sam Sample' });
    // Assign › Me: Team answers first with you on it, Mine still the old one
    fresh(d).send(commandRan('card', 'assign')).answer(only(after, 'card list --closed'));
    expect(told(d).at(-1)).toMatchObject({ card: 9, owner: null });
    d.answer(after);
    expect(told(d).map((e) => e.owner)).not.toContain('Sam Sample');
    expect(told(d).at(-1)).toEqual({
      kind: 'selected',
      card: 9,
      owner: null,
      title: 'Coupon field accepts spaces',
    });
  });

  test('Tab: Mine → Team → Sessions → Mine, ⇧Tab back; teammates’ cards are greyed; a click on a tab switches it', () => {
    const d = board().keys('<Tab>');
    const tab = () => props(d.tree, 'board-head').selected;

    expect(tab()).toBe('tab:team');
    expect(ids(d.tree, 'col:New', 'BoardCard')).toEqual(['card:5', 'card:6', 'card:9']);
    expect(props(d.tree, 'col:New')).toMatchObject({ count: 3 });
    expect(props(d.tree, 'card:5').theirs).toBeUndefined();
    expect(props(d.tree, 'card:9').theirs).toBe(true);
    d.keys('<Tab>');
    expect(tab()).toBe('tab:sessions');
    d.keys('<Tab>');
    expect(tab()).toBe('tab:mine');
    d.keys('<S-Tab>');
    expect(tab()).toBe('tab:sessions');
    d.keys('<S-Tab>');
    expect(tab()).toBe('tab:team');
    d.click('tab:sessions');
    expect(tab()).toBe('tab:sessions');
    d.click('tab:mine');
    expect(tab()).toBe('tab:mine');
    // `:`'s rows: the other two tabs, Tab's next first
    expect(
      d.here?.view?.menu.rows.filter((r) => r.id.startsWith('tab:')).map((r) => r.text),
    ).toEqual(['Team', 'Sessions']);
    d.send({ kind: 'choice', menu: 'board:view', row: 'tab:sessions' });
    expect(tab()).toBe('tab:sessions');
  });

  test('a column holding more cards than fit shows a window around the selected one', () => {
    const many = Array.from({ length: 12 }, (_, i) => listCard(20 + i, `Card ${i}`, 'New'));
    const d = board({ mine: many, runs: [], sessions: [] });

    expect(props(d.tree, 'col:New')).toMatchObject({ count: 12, note: '+5 below' });
    d.keys('G');
    expect(props(d.tree, 'col:New').note).toBe('5 above');
    expect(selected(d.tree)).toEqual(['card:31 selected']);
  });

  test('/ filters the cards; ⏎ opens the selected match’s page, the filter kept; Esc clears it', () => {
    const d = board().keys('/', 'c', 'a', 'r', 't');

    expect(props(d.tree, 'board-head').note).toBe('/cart▏');
    expect(ids(d.tree, 'board', 'BoardCard')).toEqual(['card:5', 'card:4']);
    d.keys('<BS>', '<BS>', '<BS>', '<BS>', 'G', 'r', 'e', 'e', 't', '<CR>');
    expect(ids(d.tree, 'board', 'BoardCard')).toEqual(['card:6', 'card:7']);
    expect(d.commands.find((c) => c.kind === 'open' && c.screen === 'card')).toMatchObject({
      params: { card: '6', from: 'board' },
    });
    // typing done: keys move again (over Active, no match there: a stop)
    d.keys('ä', 'ä');
    expect(selected(d.tree)).toEqual(['card:7 selected']);
    d.keys('<Esc>');
    expect(props(d.tree, 'board-head').note).toBeUndefined();
    expect(ids(d.tree, 'board', 'BoardCard')).toHaveLength(4);
  });

  test('Esc with nothing open is unhandled, so a maximized Board restores; a filter takes it first', () => {
    const unhandled: Command = {
      kind: 'shell',
      effect: { kind: 'unhandled', slot: 'main', key: '<Esc>' },
    };
    const d = fresh(board()).keys('/', 'c', '<Esc>');

    expect(d.commands).not.toContainEqual(unhandled);
    expect(props(d.tree, 'board-head').note).toBeUndefined();
    expect(fresh(d).keys('<Esc>').commands).toContainEqual(unhandled);
  });

  test('`◆ N needs you` shows the Factory view and the cards left for later in Chat, with the keys; the Editor’s `Factory ◆ N` only lands', () => {
    const d = fresh(unread()).click('widget:needs-you');

    expect(d.commands.slice(0, 3)).toEqual([
      { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
      { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
      { kind: 'choice', menu: 'cards', row: 'reopen', slot: 'chat' },
    ]);
    expect(
      fresh(d)
        .click('widget:factory')
        .commands.filter((c) => c.kind === 'choice'),
    ).toEqual([]);
  });
});

describe('the first card on open', () => {
  const coupon = listCard(9, 'Coupon', 'New', 'Sam Sample');

  test.each<[string, BoardWorld, (d: Board) => Board, string]>([
    [
      'the oldest one that needs you',
      {
        runs: [
          factoryRun(4, 'Cart total includes shipping', 'build', 'needs-you', {
            since: minutes(1),
          }),
          factoryRun(7, 'Friendly greeting with no name', 'build', 'needs-you', {
            since: minutes(0),
          }),
        ],
        sessions: [
          { ...session('s4', 'waiting', 4), since: minutes(1) },
          { ...session('s7', 'waiting', 7), since: minutes(0) },
        ],
      },
      (d) => d,
      'card:7',
    ],
    [
      'a session with no run that waits on you counts too, as the Sessions tab shows it',
      { runs: [], sessions: [session('s6', 'waiting', 6)] },
      (d) => d,
      'card:6',
    ],
    [
      'none needs you: the first card of yours in board order, #9 first on the Board but Sam’s',
      {
        team: [coupon, ...BOARD_MINE.slice(0, 1)],
        mine: BOARD_MINE.slice(0, 1),
        runs: [],
        sessions: [],
      },
      (d) => d.keys('<Tab>'),
      'card:4',
    ],
    [
      'none of yours: the first card',
      { team: [coupon, ...BOARD_MINE.slice(0, 1)], mine: [], runs: [], sessions: [] },
      (d) => d.keys('<Tab>'),
      'card:9',
    ],
  ])('%s', (_, world, before, card) => {
    // Tab before the lists are read: the Board seeks the first card on the tab it is on
    const d = before(unread()).answer(boardReplies(world));

    expect(selected(d.tree)).toEqual([`${card} selected`]);
    expect(d.here?.subject?.label).toBe(`#${card.slice('card:'.length)}`);
  });

  test('chosen once: after that the keys choose, a run that comes to need you later too', () => {
    const d = board().keys('ö');

    fresh(d)
      .send(stage(7, null, 'build', 'needs-you', 'needs-you', minutes(7)))
      .answer(
        repliesBy({
          'factory status 7': runsAnswer([
            factoryRun(7, 'Friendly greeting with no name', 'build', 'needs-you', {
              since: minutes(0),
            }),
          ]),
        }),
      );
    expect(selected(d.tree)).toEqual(['card:6 selected']);
  });
});

describe('the selection follows its card, by id', () => {
  test('a card moved to another column, or above the selected one, keeps the selection on the card', () => {
    const d = board().click('card:5');

    expect(selected(d.tree)).toEqual(['card:5 selected']);
    // card 5 moves New → Active, and a new card lands above it in New where it was
    fresh(d)
      .send(commandRan('card', 'move'))
      .answer(
        only(
          boardReplies({
            mine: [
              listCard(8, 'Coupon field accepts spaces', 'New'),
              listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example'),
              listCard(5, 'Saved carts survive sign-out', 'Active'),
              ...BOARD_MINE.slice(2),
            ],
          }),
          'card list --mine',
        ),
      );
    // moved: first in its new column, as the board lists it
    expect(ids(d.tree, 'col:Active', 'BoardCard')).toEqual(['card:5', 'card:4']);
    expect(selected(d.tree)).toEqual(['card:5 selected']);
    // Chat stays on it
    expect([...new Set(told(d).map((e) => e.card))]).toEqual([5]);
  });

  test('a card read again on top (assigned: the board lists its newest change first) keeps its place in its column, the selection with it', () => {
    const d = board().keys('<Tab>').click('card:9');
    const assigned = listCard(9, 'Coupon field accepts spaces', 'New', 'Me');

    expect(ids(d.tree, 'col:New', 'BoardCard')).toEqual(['card:5', 'card:6', 'card:9']);
    fresh(d)
      .send(commandRan('card', 'assign'))
      .answer(
        only(
          boardReplies({ mine: [assigned, ...BOARD_MINE], team: [assigned, ...BOARD_MINE] }),
          'card list',
        ),
      );
    expect(ids(d.tree, 'col:New', 'BoardCard')).toEqual(['card:5', 'card:6', 'card:9']);
    expect(selected(d.tree)).toEqual(['card:9 selected']);
  });

  test('a run that starts to need you elsewhere never takes the selection', () => {
    const d = board()
      .click('card:7')
      .send(stage(4, 'build', 'build', 'needs-you', 'needs-you', minutes(7)));

    expect(selected(d.tree)).toEqual(['card:7 selected']);
  });

  test('the Board losing the keys (the Chat column or the window has them) greys the card; back, it keeps the card and Chat on it', () => {
    const d = board().click('card:7');

    fresh(d).send({ kind: 'focus', focused: false });
    expect(selected(d.tree)).toEqual(['card:7 selected-inactive']);
    expect(told(d).map((e) => e.card)).toEqual([7]);
    fresh(d).send({ kind: 'focus', focused: true });
    expect(selected(d.tree)).toEqual(['card:7 selected']);
    expect(told(d).map((e) => e.card)).toEqual([7]);
    // the view shown anew (not from the Editor): the same card, nothing read again
    fresh(d).send(opened({}));
    expect(selected(d.tree)).toEqual(['card:7 selected']);
    expect(reads(d)).toEqual([]);
  });

  test.each<
    [
      string,
      Readonly<Record<string, string>>,
      Input[],
      string | undefined,
      'tab:mine' | 'tab:team',
      number | undefined,
    ]
  >([
    [
      'a restarted bridge opened on the card the shell last had selected: on it, not on the one that needs you',
      { card: '7' },
      [],
      'card:7',
      'tab:mine',
      7,
    ],
    [
      "a restarted bridge opened on a teammate's card: on Team",
      { card: '9' },
      [],
      'card:9',
      'tab:team',
      9,
    ],
    [
      'the tab it was on, when the shell says it: your own card on Team stays on Team',
      { card: '7', tab: 'team' },
      [],
      'card:7',
      'tab:team',
      7,
    ],
    [
      '`factory {card}` (a Sessions row, Linked) on the Board: that card',
      {},
      [opened({ card: '7' })],
      'card:7',
      'tab:mine',
      7,
    ],
    [
      "Sessions' ⏎ on a teammate's card: on Team, Board and Chat on it",
      {},
      [opened({ card: '9', from: 'sessions' })],
      'card:9',
      'tab:team',
      9,
    ],
  ])('an open naming a card selects it: %s', (_, params, inputs, card, tab, chat) => {
    const d = board({}, { params }).send(...inputs);

    expect(selected(d.tree)).toEqual(card === undefined ? [] : [`${card} selected`]);
    expect(props(d.tree, 'board-head').selected).toBe(tab);
    expect(told(d).at(-1)?.card).toBe(chat);
  });

  test('Tab before the lists are read, or a failed list, seeks no tab later', () => {
    const d = unread({ params: { card: '9' } })
      .keys('<Tab>', '<Tab>', '<Tab>')
      .answer(boardReplies());

    expect(props(d.tree, 'board-head').selected).toBe('tab:mine');
  });

  test.each<[string, Input[], Input[], Command[], string]>([
    [
      'a click on a card',
      [],
      [click('card:7')],
      [{ kind: 'open', screen: 'sessions', params: { card: '7' }, slot: 'pane', ifOpen: true }],
      'card:7',
    ],
    ['the same card again: nothing', [click('card:7')], [click('card:7')], [], 'card:7'],
    [
      'an `open` naming a card (Linked, Search Everywhere)',
      [],
      [opened({ card: '4' })],
      [{ kind: 'open', screen: 'sessions', params: { card: '4' }, slot: 'pane', ifOpen: true }],
      'card:4',
    ],
    [
      "Sessions' own `factory {card, from: sessions}`: never sent back",
      [],
      [opened({ card: '6', from: 'sessions' })],
      [],
      'card:6',
    ],
  ])(
    "the selected card selects its row in the pane's Sessions: %s",
    (_, before, inputs, opens, card) => {
      const d = fresh(board().send(...before)).send(...inputs);

      expect(d.commands.filter((c) => c.kind === 'open' && c.screen === 'sessions')).toEqual(opens);
      expect(selected(d.tree)).toEqual([`${card} selected`]);
    },
  );
});

describe('abe watch moves a card in place', () => {
  const at = minutes;
  const QUEUED: BoardWorld = {
    runs: [
      BOARD_RUNS[0] ?? factoryRun(4, 'x', 'build', 'running'),
      factoryRun(5, 'Saved carts survive sign-out', 'spec', 'queued', { since: minutes(1) }),
    ],
    sessions: [
      { ...session('s4', 'working', 4), box: 'alex-1' },
      { ...session('s5', 'queued', 5), box: 'demo-5' },
    ],
  };
  /** Card 4's box in the box list, so its box.state is a box the Board knows. */
  const ALEX: BoardWorld = { boxes: [X_BOXES.box('alex-1')] };
  const abandoned = (card: number, from: 'build' | 'spec', at_: string): Input =>
    stage(card, from, 'done', 'done', 'end', at_, {
      outcome: 'abandoned',
      ended: { as: 'abandoned', reason: 'not needed', at: at_, from },
    });

  test.each<[string, BoardWorld, Input[], number, Record<string, unknown>]>([
    [
      'build → checks: its own stage and the step word, as Chat’s header says them',
      {},
      [stage(4, 'build', 'checks', 'running', 'stage-done', at(7))],
      4,
      { rail: { stage: 'Checks', word: 'Checking' } },
    ],
    [
      'checks → review',
      {},
      [
        stage(4, 'build', 'checks', 'running', 'stage-done', at(7)),
        stage(4, 'checks', 'review', 'running', 'checks', at(8)),
      ],
      4,
      {
        rail: { segments: ['done', 'done', 'now', 'todo', 'todo'], stage: 'Review' },
        emphasis: 'normal',
      },
    ],
    [
      'needing you: ◆, its reason in the tooltip',
      {},
      [
        stage(4, 'checks', 'review', 'running', 'checks', at(8)),
        stage(4, null, 'review', 'needs-you', 'needs-you', at(9)),
      ],
      4,
      {
        rail: { glyph: '◆', word: 'Needs you', state: 'needs-you' },
        emphasis: 'needs-you',
        tooltip: '#4 Cart total includes shipping · Needs you · which test account?',
        tipAdds: true,
      },
    ],
    [
      'answered in Chat: the person’s prompt, the run works on, the ◆ cleared',
      {},
      [
        stage(4, 'checks', 'review', 'running', 'checks', at(8)),
        stage(4, null, 'review', 'needs-you', 'needs-you', at(9)),
        stage(4, null, 'review', 'running', 'UserPromptSubmit', at(10)),
      ],
      4,
      { rail: { word: 'Reviewing', time: '<1 min' }, emphasis: 'normal' },
    ],
    [
      'the clock follows its stay on the rail stage: checks are Build’s, the stay that began at 2 goes on',
      {},
      [stage(4, 'build', 'checks', 'running', 'stage-done', at(7)), tick(at(9))],
      4,
      { rail: { stage: 'Checks', time: '7 min' } },
    ],
    [
      'Review: a stay of its own',
      {},
      [
        stage(4, 'build', 'checks', 'running', 'stage-done', at(7)),
        stage(4, 'checks', 'review', 'running', 'checks', at(8)),
        tick(at(10)),
      ],
      4,
      { rail: { stage: 'Review', time: '2 min' } },
    ],
    [
      'a cleared run (its session stopped first): No session',
      {},
      [sessionState('s4', 4, 'ended', 'stop'), stage(4, 'done', 'done', 'done', 'cleared', at(8))],
      4,
      { note: { text: 'No session' } },
    ],
    [
      'session.state',
      {},
      [sessionState('s4', 4, 'starting', 'start')],
      4,
      { rail: { glyph: '●', word: 'Starting', state: 'starting', box: 'starting' } },
    ],
    [
      'a session you stopped: Stopped, dim',
      {},
      [
        stage(4, 'build', 'build', 'needs-you', 'Stop', at(7)),
        sessionState('s4', 4, 'ended', 'stop'),
      ],
      4,
      { rail: { glyph: '○', word: 'Stopped', state: 'idle' }, emphasis: 'normal' },
    ],
    [
      'a session that ended on its own: Failed',
      {},
      [
        stage(4, 'build', 'build', 'needs-you', 'Stop', at(7)),
        sessionState('s4', 4, 'ended', 'gone'),
      ],
      4,
      { rail: { glyph: '✗', word: 'Failed', state: 'failed' } },
    ],
    [
      'box.state stopped: its box asleep',
      ALEX,
      [boxState('alex-1', 'stopped')],
      4,
      { rail: { box: 'asleep' } },
    ],
    [
      'a card serve moved on the board: in its column',
      {},
      [cardMoved(5, 'active', 'Active')],
      5,
      { column: 'col:Active' },
    ],
    [
      'a run ended as Abandoned: on the stage it was given up in, dim ○ Abandoned',
      {},
      [abandoned(4, 'build', at(7))],
      4,
      {
        rail: {
          segments: ['done', 'wait', 'todo', 'todo', 'todo'],
          stage: 'Build',
          glyph: '○',
          word: 'Abandoned',
        },
      },
    ],
    ['a Queued run', QUEUED, [], 5, { rail: { word: 'Queued' } }],
    [
      'a Queued run’s Stop…: its session ended by you, its run no longer Queued: Stopped',
      QUEUED,
      [
        sessionState('s5', 5, 'ended', 'stop', at(5)),
        stage(5, null, 'spec', 'needs-you', 'stop', at(5)),
      ],
      5,
      { rail: { glyph: '○', word: 'Stopped' } },
    ],
    [
      'a Queued run’s End run… › Abandoned: ○ Abandoned on decide',
      QUEUED,
      [sessionState('s5', 5, 'ended', 'stop', at(5)), abandoned(5, 'spec', at(5))],
      5,
      { rail: { glyph: '○', word: 'Abandoned' } },
    ],
  ])('%s, nothing read', (_, world, inputs, card, want) => {
    const d = fresh(board(world)).send(...inputs);

    expect({ ...props(d.tree, `card:${card}`), column: columnOf(d.tree, card) }).toMatchObject(
      want,
    );
    expect(reads(d)).toEqual([]);
  });

  test.each<[string, Input[], string]>([
    ['stopped', [boxState('alex-1', 'stopped')], 'asleep'],
    ['queued', [boxState('alex-1', 'queued')], 'queued'],
    ['running again', [boxState('alex-1', 'queued'), boxState('alex-1', 'running')], 'running'],
  ])('box.state changes the box mark in place: %s', (_, inputs, mark) => {
    expect(props(board(ALEX).send(...inputs).tree, 'card:4').rail).toMatchObject({ box: mark });
  });

  test.each<[string, BoardWorld, Input[], string[]]>([
    [
      'a run it has never seen: by its card only',
      {},
      [stage(7, null, 'spec', 'running', 'run', at(7))],
      ['factory status 7'],
    ],
    [
      'a pull request that moved: by its card only',
      {},
      [stage(4, 'verify', 'pr', 'running', 'pr', at(8))],
      ['factory status 4'],
    ],
    [
      'an older box’s end with no `ended`: by its card only',
      {},
      [stage(4, 'build', 'done', 'done', 'end', at(7), { outcome: 'abandoned' })],
      ['factory status 4'],
    ],
    [
      'a session not known yet: by its id, never the whole list',
      {},
      [sessionState('s9', 6, 'working', 'hook')],
      ['session show s9'],
    ],
    [
      'a launch’s session on a card with no run yet: the session and the card’s run',
      {},
      [sessionState('s9', 6, 'starting', 'launch')],
      ['session show s9', 'factory status 6'],
    ],
    [
      'a card written elsewhere: the card lists',
      {},
      [commandRan('card', 'move')],
      ['card list --mine --closed', 'card list --closed'],
    ],
    [
      'a card made elsewhere (abe card create): the card lists',
      {},
      [commandRan('card', 'create')],
      ['card list --mine --closed', 'card list --closed'],
    ],
  ])('what abe watch reads: %s', (_, world, inputs, asked) => {
    expect(reads(fresh(board(world)).send(...inputs))).toEqual(asked);
  });

  test('a run read by its card shows on the card', () => {
    const d = fresh(board())
      .send(stage(7, null, 'spec', 'running', 'run', at(7)))
      .answer(repliesBy({ 'factory status 7': runsAnswer([factoryRun(7, 'New one', 'spec')]) }));

    expect(props(d.tree, 'card:7').rail).toMatchObject({ stage: 'Spec' });
  });

  test('a session read by its id joins the sessions once; one that does not show by its id reads the whole list', () => {
    const s9 = session('s9', 'working', 6);
    const d = fresh(board())
      .send(sessionState('s9', 6, 'working', 'hook'))
      .answer(
        repliesBy({
          'session show s9': {
            kind: 'result',
            id: '',
            command: 'session show',
            reply: { ok: true, data: s9 },
          },
        }),
      );

    expect(reads(d)).toEqual([]);
    expect(props(d.tree, 'card:6').rail).toMatchObject({ word: 'Running' });
    // s4 and s9 at work, once each
    expect(stripe(d).find((i) => i.id === 'sessions')?.tooltip).toContain('· 2 running');
    // a followed box's serve does not show by its id: the whole list after all
    fresh(d)
      .send(sessionState('s10', 7, 'working', 'hook'))
      .answer(
        repliesBy({
          'session show s10': {
            kind: 'result',
            id: '',
            command: 'session show',
            reply: { ok: false, error: { code: 'no-session', message: 'no session s10' } },
          },
        }),
      );
    expect(reads(d)).toEqual(['session list']);
  });

  test("a cold cloud launch's card says its step and ticking clock while its box boots, before factory run answers", () => {
    const begun = minutes(8);
    const sec = (n: number) => new Date(Date.parse(begun) + n * 1000).toISOString();
    const s9: SessionData = {
      ...session('s9', 'starting', 6),
      box: 'demo-shop-6',
      since: begun,
      startedAt: begun,
      launch: {
        step: 'box-booting',
        since: sec(7),
        startedAt: begun,
        box: 'demo-shop-6',
        how: 'new',
        detail: null,
        told: false,
        done: [{ step: 'box-starting', ms: 7000 }],
      },
    };
    const d = board()
      .send(sessionState('s9', 6, 'starting', 'launch', begun))
      .answer(
        repliesBy({
          'session show s9': {
            kind: 'result',
            id: '',
            command: 'session show',
            reply: { ok: true, data: s9 },
          },
          'factory status 6': runsAnswer([
            factoryRun(6, 'Greeted by time of day', 'spec', 'running', {
              session: 's9',
              since: begun,
            }),
          ]),
        }),
      )
      .send(tick(sec(45)));

    expect(props(d.tree, 'card:6').rail).toMatchObject({
      word: 'Box booting',
      state: 'starting',
      time: '0:45',
    });
    expect(props(d.tree, 'card:6').note).toBeUndefined();
    d.send(tick(sec(46)));
    expect(props(d.tree, 'card:6').rail).toMatchObject({ time: '0:46' });
  });
});

describe('the card’s menu: ⌘⏎ or a right-click on a card', () => {
  test('⌘⏎ on a card that needs you: Open workspace first, its local worktree', () => {
    expect(menuOf(fresh(board()).keys('<D-CR>')).rows[0]).toMatchObject({
      id: 'workspace',
      text: 'Open workspace',
      dim: 'local worktree',
    });
  });

  test('a right-click selects the card and opens its menu, as ⌘⏎ on it', () => {
    const d = board();
    const m = cardMenu(d, 4);

    // Command mode over the Board has the keys
    expect(selected(d.tree)).toEqual(['card:4 selected-inactive']);
    expect(m.id).toBe('card:4');
    expect(m.rows[0]).toMatchObject({ id: 'workspace', dim: 'alex-1' });
    expect(d.layer?.kind).toBe('PickLayer');
  });

  test('Open workspace, from the menu or the bridge’s jump: the session’s workspace, as attach-spec says', () => {
    const d = pick(board(), 4, 'workspace');

    expect(reads(d)).toEqual(['workspace attach-spec s4']);
    expect(reads(fresh(d).send({ kind: 'jump', to: 'workspace', story: 5 }))).toEqual([
      'workspace attach-spec s5',
    ]);
  });

  test('Open workspace on a failed run waiting on you, an older live plain session: the run’s, as its menu; it waits for the runs', () => {
    const world: BoardWorld = {
      runs: [
        factoryRun(5, 'Cart total', 'build', 'needs-you', { session: 'r5', startedAt: minutes(3) }),
      ],
      sessions: [
        { ...session('p5', 'working', 5), startedAt: minutes(1) },
        { ...session('r5', 'ended', 5), startedAt: minutes(3), factory: true },
      ],
    };
    const d = unread()
      .answer(only(boardReplies(world), 'card list', 'session list'))
      .send({ kind: 'jump', to: 'workspace', story: 5 });

    // the runs not read yet: it waits for them, a run may stand
    expect(reads(d).filter((r) => r.startsWith('workspace'))).toEqual([]);
    d.answer(only(boardReplies(world), 'factory status'));
    expect(reads(d).filter((r) => r.startsWith('workspace'))).toEqual(['workspace attach-spec r5']);
    expect(reads(pick(d, 5, 'workspace'))).toEqual(['workspace attach-spec r5']);
  });

  // a local session's worktree as it is; any other card's branch from origin first
  test.each<[string, number, Input[], Answer | undefined, string | undefined, string | undefined]>([
    ['a local session’s worktree', 5, [], undefined, '/wt/s5', undefined],
    [
      'a box story: its branch from origin, then that worktree',
      4,
      [],
      {
        kind: 'result',
        id: '',
        command: 'card checkout',
        reply: { ok: true, data: { worktree: '/wt/4-cart', branch: 'card/4-cart', made: true } },
      },
      '/wt/4-cart',
      'Checked out card/4-cart',
    ],
    [
      'a teammate’s card, checked out here already',
      9,
      k('<Tab>'),
      {
        kind: 'result',
        id: '',
        command: 'card checkout',
        reply: { ok: true, data: { worktree: '/wt/9-c', branch: 'card/9-c', made: false } },
      },
      '/wt/9-c',
      'Opened card/9-c',
    ],
    [
      'nothing pushed for it: said on the status line, nothing opens',
      9,
      k('<Tab>'),
      {
        kind: 'result',
        id: '',
        command: 'card checkout',
        reply: {
          ok: false,
          error: {
            code: 'no-branch',
            message: 'origin has no card/9 branch: nothing pushed for it yet',
          },
        },
      },
      undefined,
      'origin has no card/9 branch: nothing pushed for it yet',
    ],
  ])('Open worktree: %s', (_, card, before, answer, opens, status) => {
    const d = pick(board().send(...before), card, 'worktree');

    expect(reads(d)).toEqual(answer === undefined ? [] : [`card checkout ${card}`]);
    if (answer !== undefined) d.answer(repliesBy({ 'card checkout': answer }));
    expect(effects(d, 'open-project')).toEqual(
      opens === undefined ? [] : [{ kind: 'open-project', path: opens }],
    );
    expect(effects(d, 'status')).toEqual(
      status === undefined ? [] : [{ kind: 'status', text: status }],
    );
  });

  test.each<[string, SessionData, string[], Command[]]>([
    [
      'a running session: Chat on it with the keys',
      session('s5', 'waiting', 5),
      [],
      chatOpened(5, 's5'),
    ],
    [
      'an ended one goes on, the same session',
      session('s5', 'ended', 5),
      ['session reopen s5'],
      chatOpened(5, 's5'),
    ],
  ])('Reopen: %s', (_, s5, asked, chat) => {
    const d = pick(
      board({ sessions: [BOARD_SESSIONS[0] ?? session('s4', 'working', 4), s5] }),
      5,
      'reopen',
    );

    expect(reads(d)).toEqual(asked);
    expect(chatCommands(d.commands)).toEqual(chat);
  });

  test('Reopen on a session whose claude never started (no transcript): grey with why; chosen anyway, nothing asked, the status line says why', () => {
    const why = 'its claude never started a conversation: Retry run starts its card again';
    const d = board({
      sessions: [
        BOARD_SESSIONS[0] ?? session('s4', 'working', 4),
        { ...session('s5', 'ended', 5), transcriptPath: null },
      ],
    });

    expect(cardMenu(d, 5).rows.find((r) => r.id === 'reopen')?.reason).toBe(why);
    expect(reads(d.click('reopen'))).toEqual([]);
    fresh(d).send({ kind: 'choice', menu: 'card:5', row: 'reopen' });
    expect(reads(d)).toEqual([]);
    expect(effects(d, 'status')).toContainEqual({ kind: 'status', text: why });
  });

  test.each<[string, SessionData, string]>([
    ['a failed run', session('s5', 'ended', 5), 'factory run 5 --repo mkdir-swe/demo-shop'],
    [
      'a stopped run',
      { ...session('s5', 'ended', 5), stopped: true },
      'factory run 5 --repo mkdir-swe/demo-shop',
    ],
    [
      'its box slept while it waited on you: the cloud, as Sessions’ ⏎ and ⌘⏎ Retry',
      { ...session('s5', 'ended', 5), box: 'demo-shop-5', reason: `${BOX_SLEPT_WAITING} · x` },
      'factory run 5 --repo mkdir-swe/demo-shop --target cloud',
    ],
  ])('Retry: %s launches as ⏎ does', (_, s5, launch) => {
    const failed = factoryRun(5, 'Saved carts survive sign-out', 'build', 'needs-you', {
      session: 's5',
    });
    const d = pick(board({ runs: [failed], sessions: [s5] }), 5, 'retry');

    expect(reads(d)).toEqual([launch]);
    expect(chatCommands(d.commands)).toEqual(chatOpened(5));
  });

  test('Stop… asks first, then session stop', () => {
    const d = pick(board(), 4, 'stop');

    expect(d.commands.filter((c) => c.kind === 'confirm')).toEqual([
      {
        kind: 'confirm',
        argv: ['session', 'stop', 's4'],
        question: "Stop #4's session?",
        details: ['Its Claude Code stops; its worktree and its branch stay: card/4-x'],
        yes: 'Stop',
        done: "Stopped #4's session",
      },
    ]);
    expect(d.layer?.kind).toBe('ConfirmLayer');
  });

  const keepRow = (d: Board, card: number) => cardMenu(d, card).rows.find((r) => r.id === 'keep');
  const idle = (keptBy: ('awake' | 'working')[]): Input =>
    eventInput(
      {
        type: 'box.idle',
        seq: 20,
        data: { box: 'alex-1', idle: { minutes: 30, activeAt: minutes(7), stopsAt: null, keptBy } },
      },
      minutes(7),
    );
  const tagged = (keptBy: 'awake'[]): BoardWorld => ({
    boxes: [
      X_BOXES.box('demo-6', {
        card: 6,
        idle: { minutes: 30, activeAt: minutes(5), stopsAt: null, keptBy },
      }),
    ],
  });

  test.each<[string, BoardWorld, Input[], number, Record<string, unknown>]>([
    [
      'a session’s box: its idle stop waits',
      {},
      [],
      4,
      { text: 'Keep box awake', dim: 'its idle stop waits' },
    ],
    [
      'box.idle says it kept awake: Let box sleep',
      {},
      [idle(['awake'])],
      4,
      {
        text: 'Let box sleep',
        dim: 'kept awake',
        does: { kind: 'run', argv: ['box', 'sleep', 'alex-1'] },
      },
    ],
    ['no box, no session', {}, [], 6, { reason: 'no box yet' }],
    [
      'a box tagged with the card, from the box feed, no session needed',
      tagged([]),
      [],
      6,
      { text: 'Keep box awake', does: { kind: 'run', argv: ['box', 'keep', 'demo-6'] } },
    ],
    [
      'that box kept awake',
      tagged(['awake']),
      [],
      6,
      {
        text: 'Let box sleep',
        dim: 'kept awake',
        does: { kind: 'run', argv: ['box', 'sleep', 'demo-6'] },
      },
    ],
  ])('Keep box awake: %s', (_, world, inputs, card, want) => {
    expect(keepRow(board(world).send(...inputs), card)).toMatchObject(want);
  });

  const boxesOff = repliesBy({
    'box list': refused('box list', BOXES_OFF.code, BOXES_OFF.message),
  });

  test.each<[string, BoardWorld, boolean]>([
    ['your boxes listed: Move to cloud', {}, true],
    [
      'your boxes off (serve.target local, no box profile): no cloud to move to',
      { more: boxesOff },
      false,
    ],
  ])('a local session’s menu: %s', (_, o, offered) => {
    const d = board({ sessions: [{ ...session('s4', 'working', 4), factory: true }], ...o });

    expect(cardMenu(d, 4).rows.some((r) => r.id === 'move-to-cloud')).toBe(offered);
  });
});

describe('the Sessions tab: your sessions on the sprint and the Abe chats, to read', () => {
  const sessions = (world: BoardWorld = {}) => board(world).click('tab:sessions');
  const rows = (d: Board) => {
    const t = nodeById(d.tree, 'board-sessions');

    return t.kind === 'Table' ? t.props.rows.map((r) => r.id ?? '') : [];
  };
  const tableOf = (d: Board) => {
    const t = nodeById(d.tree, 'board-sessions');

    if (t.kind !== 'Table') throw new Error('no Sessions table');

    return t.props;
  };

  test('its rows as the pane’s Sessions lists them, the one that needs you first; no columns', () => {
    const d = sessions();

    expect(rows(d)).toEqual(['session:s5', 'session:s4']);
    expect(tableOf(d).selected).toBe('session:s5');
    expect(nodesOf(d.tree).some((n) => n.kind === 'BoardColumns')).toBe(false);
    expect(props(d.tree, 'board-head')).toMatchObject({
      selected: 'tab:sessions',
      counts: [{ text: '2 sessions', hue: 'dim' }],
    });
  });

  test('moving the selection moves Chat to its card, as a card does; never a workspace', () => {
    const d = fresh(sessions()).keys('ö');

    expect(tableOf(d).selected).toBe('session:s4');
    expect(effects(d, 'selected').at(-1)).toMatchObject({ card: 4 });
    expect(effects(d, 'workspace-page')).toEqual([]);
    // ⏎: Chat on its session with the keys, the window where it is
    fresh(d).keys('<CR>');
    expect(chatCommands(d.commands)).toEqual(chatOpened(4, 's4'));
    expect(effects(d, 'workspace-page')).toEqual([]);
    expect(d.commands.filter((c) => c.kind === 'open' && c.slot === 'main')).toEqual([]);
  });

  test('/ filters its rows; a click selects one; ⌘⏎ its card’s menu', () => {
    const d = sessions().keys('/', 't', 'o', 't', 'a', 'l');

    expect(rows(d)).toEqual(['session:s4']);
    expect(tableOf(d).note).toContain('/total');
    d.keys('<Esc>', '<Esc>').click('session:s4');
    expect(tableOf(d).selected).toBe('session:s4');
    d.keys('<D-CR>');
    expect(d.layer?.kind).toBe('PickLayer');
    expect(d.layer?.props).toMatchObject({ title: '#4 Cart total includes shipping' });
  });
});

describe('⏎ on a card: its Card page, a popup over the Board', () => {
  /** What ⏎ opened: the card's workspace on its Card page, or the `card` screen. */
  const opened = (d: Board): Command[] =>
    d.commands.filter(
      (c) =>
        (c.kind === 'open' && c.screen === 'card') ||
        (c.kind === 'shell' && c.effect.kind === 'workspace-page'),
    );
  const popup = (card: number): Command => ({
    kind: 'open',
    screen: 'card',
    params: { card: String(card), from: 'board' },
    slot: 'popup',
  });
  const workspace = (card: number, path: string): Command => ({
    kind: 'shell',
    effect: { kind: 'workspace-page', path, card, page: 'card' },
  });
  const ENDED_5: SessionData = { ...session('s5', 'ended', 5), factory: true };

  test.each<[string, BoardWorld, (d: Board) => Board, Command[]]>([
    [
      'its session’s worktree on this machine: the popup all the same, never its workspace',
      {},
      (d) => d.click('card:5').keys('<CR>'),
      [popup(5)],
    ],
    [
      'its session ended there: the popup',
      { sessions: [BOARD_SESSIONS[0] ?? ENDED_5, ENDED_5] },
      (d) => d.click('card:5').keys('<CR>'),
      [popup(5)],
    ],
    ['its session on a box: the popup', {}, (d) => d.click('card:4').keys('<CR>'), [popup(4)]],
    ['no session: the popup', {}, (d) => d.click('card:6').keys('<CR>'), [popup(6)]],
    ['a double-click, as ⏎', {}, (d) => d.click('open:card:6'), [popup(6)]],
    [
      'Open card off the Board (a workspace, Chat): its workspace on its Card page when it is here',
      {},
      (d) => d.click('card:5').jump('story'),
      [workspace(5, '/wt/s5')],
    ],
    [
      'Open card off the Board on a card with no workspace here: the popup',
      {},
      (d) => d.click('card:6').jump('story'),
      [popup(6)],
    ],
    [
      'a teammate’s card: its popup too',
      {},
      (d) => d.keys('<Tab>').click('card:9').keys('<CR>'),
      [popup(9)],
    ],
  ])('%s; no dialog, nothing launched', (_, world, act, want) => {
    const d = act(fresh(board(world)));

    expect(opened(d)).toEqual(want);
    expect(d.layer).toBeUndefined();
    expect(reads(d).filter((r) => r.startsWith('factory run'))).toEqual([]);
  });

  test('⏎ on a card with its workspace here: the popup, not the workspace; Esc there back to the Board on the card', () => {
    const d = fresh(board()).click('card:5').keys('<CR>');
    const open = opened(d)[0];

    expect(open).toEqual(popup(5));
    expect(effects(d, 'workspace-page')).toEqual([]);
    if (open?.kind !== 'open') throw new Error('no popup');
    // the popup's page, as the bridge opens it there: its Esc is the Board again on the card
    const page = driveScreen(cardScreen, {
      params: open.params ?? {},
      now: NOW,
      focused: true,
      replies: () => undefined,
    });
    const back = page.keys('<Esc>').commands.filter((c) => c.kind === 'open');

    expect(back).toEqual([
      { kind: 'open', screen: 'factory', params: { card: '5' }, slot: 'main' },
    ]);
    d.send({ kind: 'open', params: { card: '5' }, size: { width: 1440, height: 846 } });
    expect(selected(d.tree)).toEqual(['card:5 selected']);
  });

  test('Open card off the Board before the runs and sessions are read: it waits, said, then goes', () => {
    // (their reads stay asked: the driver answers them below)
    const d = driveBoard({ now: NOW, replies: only(boardReplies(), 'card list') })
      .click('card:5')
      .jump('story');

    expect(opened(d)).toEqual([]);
    expect(effects(d, 'status').at(-1)?.text).toBe("Reading #5's run and session…");
    d.answer(boardReplies());
    expect(opened(d)).toEqual([workspace(5, '/wt/s5')]);
  });

  test('⏎ before the runs and sessions are read: the popup at once (the page reads its own)', () => {
    const d = driveBoard({ now: NOW, replies: only(boardReplies(), 'card list') })
      .click('card:5')
      .keys('<CR>');

    expect(opened(d)).toEqual([popup(5)]);
  });

  test('the rail’s + (widget:new-card): the New card dialog, as the Board’s New card…', () => {
    const d = fresh(board()).click('widget:new-card');

    expect(d.layer?.kind).toBe('CardDialog');
    expect(d.commands.find((c) => c.kind === 'newcard')).toMatchObject({ kind: 'newcard' });
  });
});

describe('your boxes: the stripe’s Boxes item and the card marks', () => {
  /** A box as `box list` gives it, up since `up` minutes after AT. */
  const box = (name: string, o: Partial<BoxData> = {}, up = 0): BoxData =>
    X_BOXES.box(name, { launchedAt: minutes(up), costToday: null, ...o });
  const running = box('demo-1', { card: 6 });
  const asleep = box('demo-5', { state: 'stopped', card: 5, serve: null });
  const boxItem = (d: Board) => stripe(d).find((w) => w.id === 'boxes');
  /** The Boxes item's dot and its count in words (`2 boxes, 1 running`). */
  const boxSays = (d: Board) => {
    const i = boxItem(d);

    return i === undefined ? undefined : { dot: i.dot, says: i.tooltip.split(' · ')[2] };
  };
  const boxList = (boxes: BoxData[], queued: Parameters<typeof boxesAnswer>[1] = []): Replies =>
    repliesBy({ 'box list': boxesAnswer(boxes, queued) });
  const step = (name: string, at: number, stepped: 'booting' | 'workspace' = 'booting'): Input =>
    eventInput({ type: 'box.step', seq: 21, data: { box: name, step: stepped } }, minutes(at));
  const mark = (d: Board, card = 5): unknown => {
    const rail = props(d.tree, `card:${card}`).rail;

    return typeof rail === 'object' && rail !== null && 'box' in rail ? rail.box : undefined;
  };

  test.each<[string, BoxData[], Partial<StripeItem>]>([
    [
      'Boxes N · M running, each box named on hover',
      [running, asleep],
      {
        id: 'boxes',
        label: 'Boxes',
        icon: 'archive',
        group: 'bottom',
        key: '⌘6',
        tooltip: 'Boxes · ⌘6 · 2 boxes, 1 running · demo-1 running · demo-5 asleep',
      },
    ],
    [
      'a zero running count left out',
      [asleep],
      { id: 'boxes', tooltip: 'Boxes · ⌘6 · 1 box · demo-5 asleep' },
    ],
    ['none: no badge', [], { id: 'boxes', tooltip: 'Boxes · ⌘6' }],
  ])("the stripe's Boxes item: %s; the status bar has no boxes widget", (_, boxes, want) => {
    const d = board({ boxes });

    expect(boxItem(d)).toMatchObject(want);
    if (boxes.length > 0) expect(boxItem(d)?.dot).toBeUndefined();
    expect(widgets(d).some((w) => w.id === 'boxes')).toBe(false);
  });

  test('red while a box is stuck starting over 5 min, said once the clock passes it', () => {
    const d = board({ boxes: [box('demo-2', { state: 'pending', serve: null }, 5)] });

    expect(boxSays(d)).toEqual({ dot: undefined, says: '1 box' });
    // 5 min starting is not yet stuck: the tick sends nothing
    expect(effects(fresh(d).send(tick(minutes(10))), 'stripe')).toEqual([]);
    fresh(d).send(tick(minutes(11)));
    expect(boxItem(d)).toMatchObject({
      dot: 'failed',
      tooltip: 'Boxes · ⌘6 · 1 box · demo-2 starting · 6 min',
    });
    // running at last: no longer red
    fresh(d).send(boxState('demo-2', 'running', 11));
    expect(boxSays(d)).toEqual({ dot: undefined, says: '1 box, 1 running' });
  });

  test.each<[string, number, StripeItem['dot'], string]>([
    [
      'up 6 min, its serve not answering since its boot: a normal boot, booting',
      0,
      undefined,
      'Boxes · ⌘6 · 2 boxes, 1 running · demo-1 running · demo-4 booting',
    ],
    [
      'past its boot: red',
      -20,
      'failed',
      'Boxes · ⌘6 · 2 boxes, 2 running · demo-4 running · serve not answering · 26 min',
    ],
  ])("a running box's serve that does not answer: %s", (_, up, dot, tooltip) => {
    const item = boxItem(board({ boxes: [box('demo-4', { serve: 'silent' }, up), running] }));

    expect(item?.dot).toBe(dot);
    expect(item?.tooltip).toContain(
      tooltip.slice('Boxes · ⌘6 · '.length).split(' · ').slice(1).join(' · '),
    );
    if (dot !== undefined) expect(item?.tooltip).toBe(tooltip);
  });

  test('a click on Boxes (the shell opens the tab) runs nothing when no box is about to sleep', () => {
    expect(
      fresh(board())
        .click('widget:stripe:boxes')
        .commands.filter((c) => c.kind !== 'shell'),
    ).toEqual([]);
  });

  const balloons = (d: Board) => effects(d, 'balloon').map((b) => ({ tone: b.tone, text: b.text }));

  test('a box busy at its load read: one balloon a day, with the size a Resize… takes it to', () => {
    const busy = box('demo-shop', { busy: { next: 'm8g.2xlarge' } });
    const d = board({ boxes: [busy, box('big-shop', { busy: { next: null } }), running] });

    expect(balloons(d)).toEqual([
      { tone: 'info', text: 'demo-shop is busy · Resize to m8g.2xlarge…' },
      { tone: 'info', text: 'big-shop is busy' },
    ]);
    // read again the same day (5 min later): said already
    fresh(d)
      .send(tick(minutes(11)))
      .answer(boxList([busy]));
    expect(balloons(d)).toEqual([]);
  });

  test('a box about to sleep while its session waits on you: a balloon once, the widget says when, a click keeps it awake', () => {
    const idle = (soon: boolean, at = 9) =>
      eventInput(
        {
          type: 'box.idle',
          seq: 30 + at,
          data: {
            box: 'demo-1',
            idle: {
              minutes: 30,
              activeAt: minutes(0),
              stopsAt: minutes(120),
              keptBy: [],
              waitingSince: minutes(0),
              waitingMinutes: 120,
              soon,
            },
          },
        },
        minutes(at),
      );
    const d = board({ boxes: [running, asleep] });

    expect(balloons(fresh(d).send(idle(false)))).toEqual([]);
    expect(balloons(fresh(d).send(idle(true, 115)))).toEqual([
      {
        tone: 'warning',
        text: `demo-1 sleeps at ${screenClock(minutes(120))}: its session waits on you since ${screenClock(minutes(0))} · a click on Boxes keeps it awake (abe box keep demo-1)`,
      },
    ]);
    expect(boxSays(d)).toEqual({ dot: 'needs-you', says: '2 boxes, 1 running' });
    // said once, not again on the next look
    expect(balloons(fresh(d).send(idle(true, 116)))).toEqual([]);
    // one click on Boxes: kept awake
    expect(reads(fresh(d).click('widget:stripe:boxes'))).toEqual(['box keep demo-1']);
    d.answer(
      repliesBy({
        'box keep': {
          kind: 'result',
          id: '',
          command: 'box keep',
          reply: {
            ok: true,
            data: {
              box: 'demo-1',
              idle: { minutes: 30, activeAt: minutes(116), stopsAt: null, keptBy: ['awake'] },
            },
          },
        },
      }),
    );
    expect(balloons(d)).toEqual([{ tone: 'info', text: 'demo-1 kept awake until abe box sleep' }]);
  });

  test('box.state changes the list in place; a box not known reads it again', () => {
    const d = fresh(board({ boxes: [running, asleep] })).send(boxState('demo-1', 'stopped'));

    expect(reads(d)).toEqual([]);
    expect(boxSays(d)).toMatchObject({ says: '2 boxes' });
    expect(reads(fresh(d).send(boxState('demo-9', 'running')))).toEqual(['box list']);
  });

  test('a box.state said while box list is out is newer than its answer', () => {
    const d = fresh(board({ boxes: [running, asleep] })).send(tick(minutes(20)));

    expect(reads(d)).toEqual(['box list']);
    // demo-5 wakes while the read is out; the answer still says asleep
    d.send(boxState('demo-5', 'running', 20)).answer();
    expect(boxSays(d)).toMatchObject({ says: '2 boxes, 2 running' });
    expect(mark(d)).toBe('running');
  });

  test('read again quietly 5 min after it was', () => {
    const d = fresh(board({ boxes: [running] }));

    expect(reads(d.send(tick(minutes(10))))).toEqual([]);
    expect(reads(d.send(tick(minutes(11))))).toEqual(['box list']);
  });

  const QUEUED_5 = [{ ...X_BOXES.queued, box: 'demo-5', card: 5 }];

  // card 5 runs locally (session s5), its box tagged with the card
  test.each<[string, BoardWorld, Input[], unknown]>([
    ['no box', {}, [], undefined],
    ['asleep', { boxes: [asleep] }, [], 'asleep'],
    ['starting', { boxes: [asleep] }, [boxState('demo-5', 'starting')], 'starting'],
    [
      'running',
      { boxes: [asleep] },
      [boxState('demo-5', 'starting'), boxState('demo-5', 'running')],
      'running',
    ],
    ['Queued', { more: boxList([], QUEUED_5) }, [], 'queued'],
    [
      'a placement Queued for its sleeping box: Queued',
      { more: boxList([asleep], QUEUED_5) },
      [],
      'queued',
    ],
  ])("a card's box mark by its abe:card tag: %s", (_, world, inputs, want) => {
    expect(mark(board(world).send(...inputs))).toBe(want);
  });

  test('a card with no run still shows its box’s mark beside No session', () => {
    const d = board({ boxes: [box('demo-7', { state: 'stopped', card: 7 })] });

    expect(props(d.tree, 'card:7').note).toEqual({ text: 'No session', box: 'asleep' });
    expect(props(d.tree, 'card:6').note).toEqual({ text: 'No session' });
  });

  test('box.step booting: booting as the Boxes tab says it, never stuck starting past 5 min', () => {
    const d = board({ boxes: [running, asleep] });

    // woken: starting, then EC2 runs it while its serve does not answer yet
    fresh(d).send(boxState('demo-5', 'starting', 6), step('demo-5', 7));
    expect(boxItem(d)?.dot).toBe(undefined);
    expect(boxItem(d)?.tooltip).toContain('demo-1 running · demo-5 booting');
    expect(mark(d)).toBe('starting');
    // a first boot past 5 min: still booting, not red (the Boxes tab's `booting`)
    expect(effects(fresh(d).send(tick(minutes(13))), 'stripe')).toEqual([]);
    // the other steps, and a box it does not list: nothing
    d.answer();
    fresh(d).send(step('demo-5', 13, 'workspace'), step('demo-9', 13));
    expect(effects(d, 'stripe')).toEqual([]);
    expect(reads(d)).toEqual([]);
    // its serve answers: running
    fresh(d).send(boxState('demo-5', 'running', 14));
    expect(boxSays(d)).toMatchObject({ says: '2 boxes, 2 running' });
    expect(mark(d)).toBe('running');
  });

  test.each<[string, (world: BoardWorld) => Board]>([
    [
      'booting while box list is out: that answer, asked before, is read again',
      (world) =>
        fresh(board(world))
          .send(tick(minutes(20)), step('demo-5', 20))
          .answer(once(only(boardReplies(world), 'box list'))),
    ],
    [
      'booting before the first box list is in: that answer is read again',
      (world) =>
        unread()
          .answer(only(boardReplies(world), 'card list', 'factory status', 'session list'))
          .send(step('demo-5', 6))
          .answer(once(only(boardReplies(world), 'box list'))),
    ],
  ])('%s', (_, at) => {
    expect(reads(at({ boxes: [running, asleep] })).filter((r) => r === 'box list')).toEqual([
      'box list',
    ]);
  });
});

describe('a Queued run ended before it got a box: the card names no box', () => {
  const world: BoardWorld = {
    runs: [factoryRun(5, 'Saved carts survive sign-out', 'spec', 'queued', { since: minutes(1) })],
    sessions: [{ ...session('s5', 'queued', 5), box: 'demo-5' }],
  };
  const ended = sessionState('s5', 5, 'ended', 'stop', minutes(5));

  test('heard ended from Queued: Open workspace, Keep box awake, Download locally grey', () => {
    const d = board(world).send(ended, stage(5, null, 'spec', 'needs-you', 'stop', minutes(5)));
    const rows = cardMenu(d, 5).rows;
    const of = (id: string) => rows.find((r) => r.id === id)?.reason;

    expect([of('workspace'), of('keep'), of('download')]).toEqual([
      'never got a box',
      'never got a box',
      'never got a box',
    ]);
  });

  test('Open workspace says it never got one: no attach-spec asked', () => {
    const d = fresh(board(world)).send(ended, { kind: 'jump', to: 'workspace', story: 5 });

    expect(effects(d, 'balloon')).toContainEqual({
      kind: 'balloon',
      tone: 'info',
      text: '#5’s run never got a box: no workspace to open',
    });
    expect(reads(d)).toEqual([]);
  });
});

describe('a card’s run, session and box are its repo’s', () => {
  const OTHER = 'mkdir-swe/qa2-e-85a7';
  const otherRun = factoryRun(6, 'Another repo’s #6', 'build', 'needs-you', {
    session: 'q6',
    repo: OTHER,
    since: minutes(2),
  });
  const otherSession: SessionData = {
    ...session('q6', 'waiting', 6),
    repo: OTHER,
    box: 'qa2-e-85a7-6',
  };
  /** serve's runs and sessions, here in `demo-shop`, with these of another repo among them. */
  const here = (runs: FactoryRunData[], sessions: SessionData[]): BoardWorld => ({
    boxes: [X_BOXES.box('qa2-e-85a7-6', { repo: OTHER, card: 6, state: 'stopped' })],
    more: repliesBy({
      'factory status': runsAnswer(runs, 'runs', DEMO_HERE),
      'session list': sessionsAnswer(sessions, DEMO_HERE),
    }),
  });

  test('another repo’s run, session and box on the same card number never show on the card', () => {
    const { tree } = board(here([...BOARD_RUNS, otherRun], [...BOARD_SESSIONS, otherSession]));

    expect(props(tree, 'card:6').note).toEqual({ text: 'No session' });
    expect(props(tree, 'card:6').rail).toBeUndefined();
    expect(props(tree, 'card:6').emphasis).toBe('normal');
    // this repo's runs still show
    expect(props(tree, 'card:5').rail).toMatchObject({ word: 'Needs you' });
  });

  test('the landing from the Editor never chooses another repo’s waiting run', () => {
    const d = board(here([otherRun], [otherSession]), { params: { from: 'editor' } });

    expect(d.commands.some((c) => c.kind === 'open' && c.screen === 'chat')).toBe(false);
  });
});

describe('a card with a session and no run says the session’s state', () => {
  test('a cloud session waiting on you with no run: ◆ Needs you on the card, as Chat and Sessions; its menu acts on that session', () => {
    const waiting: SessionData = {
      ...session('6-ca4e', 'waiting', 6),
      box: 'demo-shop-6',
      since: minutes(1),
    };
    const d = board({
      more: repliesBy({
        'factory status': runsAnswer(BOARD_RUNS, 'runs', DEMO_HERE),
        'session list': sessionsAnswer([...BOARD_SESSIONS, waiting], DEMO_HERE),
      }),
    });

    expect(props(d.tree, 'card:6')).toMatchObject({
      rail: { glyph: '◆', word: 'Needs you', state: 'needs-you', time: '5 min' },
      emphasis: 'needs-you',
    });
    expect(props(d.tree, 'card:6').note).toBeUndefined();
    // a new launch stops it first; Resume and Stop… there
    const rows = cardMenu(d, 6).rows;
    const row = (id: string) => rows.find((r) => r.id === id);

    expect(row('launch')?.reason).toBeUndefined();
    expect(row('launch')?.dim).toEndWith(' · stops 6-ca4e first');
    expect(row('resume')?.reason).toBeUndefined();
    expect(row('stop')?.reason).toBeUndefined();
  });

  const stopped: SessionData = { ...session('6-stop', 'ended', 6), stopped: true };

  test.each<[string, SessionData[], Record<string, unknown>]>([
    [
      'an ended session with no run: still No session',
      [session('6-old', 'ended', 6)],
      { note: { text: 'No session' } },
    ],
    [
      'a plain session you stopped: ○ Stopped on the card, as Chat and Sessions',
      [stopped],
      {
        rail: {
          segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
          glyph: '○',
          word: 'Stopped',
          state: 'idle',
        },
      },
    ],
    [
      'a stopped plain session gives way to a newer session on its card, and one ended on its own is no Stopped',
      [stopped, { ...session('6-new', 'ended', 6), startedAt: '2026-10-01T09:30:00.000Z' }],
      { note: { text: 'No session' } },
    ],
  ])('%s', (_, sessions, want) => {
    const p = props(board({ sessions: [...BOARD_SESSIONS, ...sessions] }).tree, 'card:6');

    expect(p).toMatchObject(want);
    if (!('note' in want)) expect(p.note).toBeUndefined();
  });

  test('a plain session you stopped: its menu reopens it, as Chat’s ⏎ Reopen does', () => {
    const d = board({ sessions: [...BOARD_SESSIONS, stopped] });
    const rows = cardMenu(d, 6).rows;

    expect(rows[0]?.id).toBe('reopen');
    expect(rows[0]?.reason).toBeUndefined();
    expect(rows.find((r) => r.id === 'stop')?.reason).toBe('no session running');
    expect(rows.find((r) => r.id === 'launch')?.text).toBe('Launch new agent…');
    expect(reads(d.click('reopen'))).toContain('session reopen 6-stop');
  });

  test('a live plain session: its menu’s Reopen is Chat on it', () => {
    const d = pick(
      board({ sessions: [...BOARD_SESSIONS, session('6-live', 'working', 6)] }),
      6,
      'reopen',
    );

    expect(d.commands).toContainEqual({ kind: 'shell', effect: { kind: 'focus', slot: 'chat' } });
  });
});

describe('a card with a done run and a newer session: what Chat pins, the card shows', () => {
  const over = factoryRun(6, 'Greeted by time of day', 'done', 'done', {
    session: 's6',
    outcome: 'not-reproduced',
  });
  const ran: SessionData = { ...session('s6', 'ended', 6), stopped: true, factory: true };
  const later = (state: SessionData['state'], stopped = false): SessionData => ({
    ...session('6-new', state, 6),
    startedAt: '2026-10-01T09:30:00.000Z',
    stopped,
  });
  const after = (newer: SessionData) =>
    board({ runs: [...BOARD_RUNS, over], sessions: [...BOARD_SESSIONS, ran, newer] });

  test.each<[string, SessionData, Record<string, unknown>]>([
    [
      'a live plain session launched after End run: the card reads it',
      later('working'),
      { word: 'Running' },
    ],
    ['that session stopped: ○ Stopped', later('ended', true), { glyph: '○', word: 'Stopped' }],
    ['ended on its own: the run reads again', later('ended'), { word: 'Not reproduced' }],
  ])('%s', (_, newer, rail) => {
    expect(props(after(newer).tree, 'card:6').rail).toMatchObject(rail);
  });

  test('its menu acts on the newer session', () => {
    expect(pick(after(later('working')), 6, 'reopen').commands).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { card: '6', session: '6-new' },
      slot: 'chat',
    });
  });
});

describe('the cards before the runs and sessions are read', () => {
  const cards = (world: BoardWorld = {}) => unread().answer(only(boardReplies(world), 'card list'));
  const note = (d: Board, card: number) => props(d.tree, `card:${card}`).note;

  test('a card says Reading…, never No session or a box it may not have, until both are in', () => {
    const world: BoardWorld = {
      boxes: [X_BOXES.box('demo-7', { state: 'stopped', card: 7, costToday: null })],
    };
    const d = cards(world).answer(only(boardReplies(world), 'box list'));

    expect(note(d, 6)).toEqual({ text: 'Reading…' });
    // its tagged box may be an old one: the session names the box it has
    expect(note(d, 7)).toEqual({ text: 'Reading…' });
    d.answer(only(boardReplies(world), 'factory status'));
    expect(note(d, 6)).toEqual({ text: 'Reading…' });
    // a card whose run is read says it at once
    expect(props(d.tree, 'card:4').rail).toMatchObject({ stage: 'Build' });
    d.answer(only(boardReplies(world), 'session list'));
    expect(note(d, 6)).toEqual({ text: 'No session' });
    expect(note(d, 7)).toEqual({ text: 'No session', box: 'asleep' });
  });

  test('a live session with no run waits for the runs: no `Running` that the run would change', () => {
    const world: BoardWorld = { sessions: [...BOARD_SESSIONS, session('s6', 'working', 6)] };
    const d = cards(world).answer(only(boardReplies(world), 'session list'));

    expect(note(d, 6)).toEqual({ text: 'Reading…' });
    d.answer(only(boardReplies(world), 'factory status'));
    expect(props(d.tree, 'card:6').rail).toMatchObject({ word: 'Running' });
  });

  test('a read that failed: Not read, not No session', () => {
    const d = cards()
      .answer(only(boardReplies(), 'factory status'))
      .answer(
        repliesBy({
          'session list': refused('session list', 'serve-unreachable', 'abe serve is not up'),
        }),
      );

    expect(note(d, 6)).toEqual({ text: 'Not read' });
  });

  test('another project shown: its cards read again say Reading… until its runs are in', () => {
    const d = fresh(board())
      .send({ kind: 'root', root: '/p/demo-api' })
      .answer(only(boardReplies(), 'card list'));

    expect(note(d, 4)).toEqual({ text: 'Reading…' });
  });

  test('another checkout of the same repo shown: its cards keep their runs and sessions while read again; a card’s workspace selects its card', () => {
    const d = fresh(board()).send({ kind: 'root', root: '/wt/s5', branch: 'card/5-x' });

    expect(note(d, 4)).not.toEqual({ text: 'Reading…' });
    expect(selected(d.tree)).toEqual(['card:5 selected']);
    // the main checkout (no card's branch): the selection stays
    d.send({ kind: 'root', root: '/p/demo-shop', branch: 'main' });
    expect(selected(d.tree)).toEqual(['card:5 selected']);
    // the Board opened again in a card's workspace: on its card
    d.send({ kind: 'open', params: { root: '/wt/s4', branch: 'card/4-x' }, size: SIZE });
    expect(selected(d.tree)).toEqual(['card:4 selected']);
    // from the Editor (⌘⌥A) too: its card, no landing elsewhere
    const e = fresh(board());

    e.send({
      kind: 'open',
      params: { from: 'editor', root: '/wt/s5', branch: 'card/5-x' },
      size: SIZE,
    });
    expect(selected(e.tree)).toEqual(['card:5 selected']);
  });

  test('another project shown while the first reads are out: their late answers count for nothing', () => {
    const d = cards().send({ kind: 'root', root: '/p/demo-api' });

    // the old project's answers: each asked again here, still Reading…
    for (const read of ['factory status', 'session list']) {
      d.answer(once(only(boardReplies(), read)));
      expect(reads(d).filter((r) => r === read)).toEqual([read]);
    }
    expect(note(d, 4)).toEqual({ text: 'Reading…' });
    d.answer(boardReplies({ runs: [], sessions: [] }));
    expect(note(d, 4)).toEqual({ text: 'No session' });
  });
});

describe('fresh data: a teammate’s change on Azure DevOps, read by serve', () => {
  const BOARD = {
    organization: 'https://dev.azure.com/demo-org',
    project: 'Sandbox',
    team: 'Sandbox',
  };
  const changed = (
    cards: { card: CardData; mine: boolean }[],
    gone: number[],
    board_ = BOARD,
  ): Input =>
    eventInput(
      { type: 'board.changed', seq: 20, data: { board: board_, cards, gone } },
      minutes(7),
    );
  const team = (id: number): CardData => {
    const card = BOARD_TEAM.find((c) => c.id === id);

    if (card === undefined) throw new Error(`no card ${id}`);

    return card;
  };
  const columns = (d: Board) => ({
    active: ids(d.tree, 'col:Active', 'BoardCard'),
    new: ids(d.tree, 'col:New', 'BoardCard'),
  });

  test('a moved card goes on top of its new column on both tabs, with no read; one off the board goes', () => {
    const d = fresh(board()).send(
      changed([{ card: { ...team(5), state: 'Active' }, mine: true }], [9]),
    );

    expect(reads(d)).toEqual([]);
    expect(columns(d)).toEqual({ active: ['card:5', 'card:4'], new: ['card:6'] });
    d.keys('<Tab>');
    expect(columns(d)).toEqual({ active: ['card:5', 'card:4'], new: ['card:6'] });
  });

  test('a card assigned away leaves Mine and stays on Team, in its place; one new to the board comes on top', () => {
    const d = board().send(
      changed(
        [
          {
            card: { ...team(6), assignee: { name: 'Sam Sample', email: 'sam@example.test' } },
            mine: false,
          },
          { card: listCard(20, 'Wishlist', 'New', 'Sam Sample'), mine: false },
        ],
        [],
      ),
    );

    expect(columns(d).new).toEqual(['card:5']);
    d.keys('<Tab>');
    expect(columns(d).new).toEqual(['card:20', 'card:5', 'card:6', 'card:9']);
  });

  test('another board’s change is not this one’s', () => {
    const d = board();
    const before = columns(d);

    d.send(changed([], [5], { ...BOARD, team: 'Other' }));
    expect(columns(d)).toEqual(before);
  });
});
