/** `--on <box>` read from argv, the box commands' text, and a box's events tagged in the stream (#56). */
import { describe, expect, test } from 'bun:test';
import {
  boxCostAt,
  boxCostText,
  boxCostToday,
  workspaceShares,
  type BoxData,
  boxListText,
  type BoxReach,
  boxReachOf,
  boxReachText,
  boxReachWords,
  byBoxName,
  boxReleaseText,
  boxText,
  boxStuckMinutes,
  boxUpMinutes,
  boxUpText,
  minutesUp,
  splitOn,
  boxStopRefusal,
} from './box';
import { BOX_HOURLY_USD, hourlyPrice } from './box-sizes';
import { localClock, localWhen } from '../command';
import { dispatch } from '../contract/dispatch';
import { eventText } from '../contract/events';
import { journal } from '../contract/journal';
import { parse } from '../contract/parse';

describe('splitOn', () => {
  test.each([
    ['in front', ['--on', 'shop-4', 'status', '--json'], 'shop-4', ['status', '--json']],
    ['with =', ['--on=shop-4', 'session', 'list'], 'shop-4', ['session', 'list']],
    [
      'after the command',
      ['session', 'show', '4-ab', '--on', 'shop-4'],
      'shop-4',
      ['session', 'show', '4-ab'],
    ],
    ['none', ['status'], undefined, ['status']],
    [
      'after --, a word',
      ['session', 'send', '4-ab', '--', '--on', 'x'],
      undefined,
      ['session', 'send', '4-ab', '--', '--on', 'x'],
    ],
  ] as const)('%s', (_, argv, on, rest) => {
    expect(splitOn(argv)).toEqual({ ok: true, on, argv: [...rest] });
  });

  test.each([
    [['--on'], '--on needs a box'],
    [['--on', '--json', 'status'], '--on needs a box'],
    [['--on', 'a', '--on', 'b', 'status'], '--on is given twice'],
  ])('%j is refused', (argv, message) => {
    expect(splitOn(argv)).toEqual({ ok: false, message });
  });
});

describe('parse', () => {
  test('--on is a global flag: the command is read without it', () => {
    expect(parse(['--on', 'shop-4', 'session', 'show', '4-ab', '--json'])).toMatchObject({
      ok: true,
      id: 'session show',
      args: { id: '4-ab' },
      global: { json: true, on: 'shop-4' },
    });
  });

  test('a bad --on is a usage error', () => {
    expect(parse(['--on'])).toMatchObject({
      ok: false,
      code: 'usage',
      message: '--on needs a box',
    });
  });

  test('a serve fronting no boxes refuses --on; a session may not use it', async () => {
    const out = await dispatch(['--on', 'shop-4', 'status', '--json'], {}, null);

    expect(out.exit).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code: 'no-boxes' } });
    const inside = await dispatch(
      ['--on', 'shop-4', 'session', 'list', '--json'],
      {},
      null,
      'session',
    );

    expect(JSON.parse(inside.stdout)).toMatchObject({
      ok: false,
      error: { code: 'not-in-session' },
    });
  });
});

describe('box events', () => {
  test("a box's event keeps its box in the stream, and says it in its line", () => {
    const events = journal({ now: () => Date.parse('2026-10-24T10:00:00.000Z') });
    const own = events.emit('box.state', { box: 'shop-4', state: 'starting', cause: 'wake' });
    const theirs = events.emit(
      'session.state',
      {
        id: '4-ab',
        card: 4,
        state: 'working',
        since: '2026-10-24T10:00:00.000Z',
        cause: 'UserPromptSubmit',
      },
      'shop-4',
    );

    expect(own).not.toHaveProperty('box');
    expect(theirs).toMatchObject({ seq: 2, box: 'shop-4' });
    expect(eventText(own)).toBe('1 2026-10-24T10:00:00.000Z box.state shop-4 starting (wake)\n');
    expect(eventText(theirs)).toBe(
      '2 2026-10-24T10:00:00.000Z session.state 4-ab AB#4 working (UserPromptSubmit)  on shop-4\n',
    );
  });
});

test('box list in words', () => {
  expect(
    boxListText({
      boxes: [
        {
          ...bare('shop-4', 'running'),
          workspace: {
            repo: 'mkdir-swe/demo-shop',
            card: '4',
            branch: 'card/4-x',
            state: 'running',
            container: 'abe-workspace',
            image: 'i',
            database: 'card_4',
            imageCurrent: true,
          },
        },
        { ...bare('shop-5', 'stopped'), size: null },
      ],
      queued: [],
    }),
  ).toBe('shop-4  running  m8g.large  mkdir-swe/demo-shop card 4\nshop-5  stopped\n');
  expect(boxListText({ boxes: [], queued: [] })).toBe('no boxes\n');
  expect(
    boxListText({ boxes: [], queued: [], unlisted: ['abe-work: its boxes not listed: why'] }),
  ).toBe('no boxes\nabe-work: its boxes not listed: why\n');
});

describe('box list in words, as a person reads them (#194)', () => {
  const NOON = Date.parse('2026-10-24T12:00:00.000Z');
  const workspace = {
    repo: 'mkdir-swe/demo-shop',
    card: '1',
    branch: 'card/1-x',
    state: 'running',
    container: 'abe-workspace',
    image: 'i',
    database: 'card_1',
    imageCurrent: true,
  } as const;

  test("the session's state, not the workspace container's; a stopped container says so", () => {
    const b: BoxData = {
      ...bare('demo-shop-1', 'running'),
      workspace,
      session: { id: '1-a82d', state: 'waiting', since: iso(NOON - 15 * MIN) },
      readAt: iso(NOON),
    };

    expect(boxText(b)).toBe(
      `demo-shop-1  running  m8g.large  mkdir-swe/demo-shop card 1  session 1-a82d waiting on you since ${localClock(NOON - 15 * MIN)}\n`,
    );
    expect(
      boxText({ ...b, workspace: { ...workspace, state: 'stopped' }, session: undefined }),
    ).toBe('demo-shop-1  running  m8g.large  mkdir-swe/demo-shop card 1 (workspace stopped)\n');
  });

  test("EC2's pending is starting; an idle stop whose time passed never shows that time", () => {
    expect(boxText({ ...bare('demo-shop-3', 'pending'), readAt: iso(NOON) })).toStartWith(
      'demo-shop-3  starting  m8g.large\n  box demo-shop-3 is starting',
    );
    const idle = {
      minutes: 3,
      activeAt: iso(NOON - 4 * MIN),
      stopsAt: iso(NOON - MIN),
      keptBy: [],
    };

    expect(boxText({ ...bare('demo-shop-3', 'running'), idle, readAt: iso(NOON) })).toBe(
      'demo-shop-3  running  m8g.large  going to sleep now (idle 3 min) · abe box keep demo-shop-3 keeps it awake\n',
    );
    expect(
      boxText({
        ...bare('demo-shop-3', 'running'),
        idle: { ...idle, stopsAt: iso(NOON + 2 * MIN) },
        readAt: iso(NOON),
      }),
    ).toBe(
      `demo-shop-3  running  m8g.large  sleeps at ${localClock(NOON + 2 * MIN)} if still idle (3 min) · in 2 min\n`,
    );
  });
});

const MIN = 60_000;
const H = 60 * MIN;
const MIDNIGHT = Date.parse('2026-10-24T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A box with only its name and state said. */
const bare = (name: string, state: BoxData['state']): BoxData => ({
  name,
  state,
  size: 'm8g.large',
  launchedAt: null,
  release: null,
  repo: null,
  card: null,
  title: null,
  costToday: null,
  serve: null,
  workspace: null,
});

test('box list in words: its release, its cost today, and the Queued placements after', () => {
  const cost = { usd: 0.21, minutes: 126, hourly: 0.10004, at: iso(MIDNIGHT + 10 * H) };

  expect(
    boxListText({
      boxes: [
        { ...bare('shop-4', 'running'), release: 11, costToday: cost },
        { ...bare('shop-5', 'stopped'), release: 11, costToday: { ...cost, usd: 0.84 } },
      ],
      queued: [
        {
          box: 'shop-9',
          repo: 'mkdir-swe/demo-shop',
          card: 9,
          title: 'Pay by card',
          since: iso(MIDNIGHT),
        },
      ],
    }),
  ).toBe(
    [
      'shop-4  running  m8g.large  v11  $0.21 today',
      'shop-5  stopped  m8g.large  v11  $0.84 today',
      `shop-9  queued since ${localWhen(MIDNIGHT)}  mkdir-swe/demo-shop card 9  (starts when one of yours stops)`,
      '',
    ].join('\n'),
  );
  expect(boxListText({ boxes: [], queued: [] })).toBe('no boxes\n');
  expect(
    boxListText({ boxes: [], queued: [], unlisted: ['abe-work: its boxes not listed: why'] }),
  ).toBe('no boxes\nabe-work: its boxes not listed: why\n');
});

test("box list in words: each running box's abe; one on another release says what to do (#188)", () => {
  const skew = 'shop-4 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: commands newer …';

  expect(
    boxListText({
      boxes: [
        { ...bare('shop-4', 'running'), release: 11, abe: '2.0.0-alpha.0', skew },
        { ...bare('shop-5', 'running'), release: 11, abe: '2.2.0-1a2b3c4d' },
      ],
      queued: [],
    }),
  ).toBe(
    [
      'shop-4  running  m8g.large  v11  abe 2.0.0-alpha.0',
      `  ${skew}`,
      'shop-5  running  m8g.large  v11  abe 2.2.0-1a2b3c4d',
      '',
    ].join('\n'),
  );
});

describe('the price table: eu-west-1 on-demand, per BOX_SIZES size', () => {
  test('every box size has an hourly price, and each size up costs twice the one below', () => {
    expect(hourlyPrice('m8g.large')).toBe(0.10004);
    expect(hourlyPrice('m8g.xlarge')).toBe(0.20008);
    expect(hourlyPrice('t3.micro')).toBeNull();
    expect(Object.keys(BOX_HOURLY_USD)).toHaveLength(7);
  });
});

describe('cost today: minutes up since local midnight from the uptime log, times the hourly price', () => {
  test.each<[string, { up: boolean; at: number }[], number, number]>([
    // [case, moves, now (ms after midnight), minutes up]
    ['never up', [], 10 * H, 0],
    ['up since 08:00', [{ up: true, at: MIDNIGHT + 8 * H }], 10 * H, 120],
    ['up since yesterday: from midnight only', [{ up: true, at: MIDNIGHT - 5 * H }], 2 * H, 120],
    [
      'up 1 h, down, up again 30 min',
      [
        { up: true, at: MIDNIGHT + 1 * H },
        { up: false, at: MIDNIGHT + 2 * H },
        { up: true, at: MIDNIGHT + 3 * H },
      ],
      3 * H + 30 * MIN,
      90,
    ],
    [
      'stopped yesterday: nothing today',
      [
        { up: true, at: MIDNIGHT - 5 * H },
        { up: false, at: MIDNIGHT - 1 * H },
      ],
      10 * H,
      0,
    ],
    [
      'a repeated move counts once',
      [
        { up: true, at: MIDNIGHT + 1 * H },
        { up: true, at: MIDNIGHT + 2 * H },
        { up: false, at: MIDNIGHT + 3 * H },
        { up: false, at: MIDNIGHT + 4 * H },
      ],
      5 * H,
      120,
    ],
  ])('%s', (_, moves, now, minutes) => {
    expect(minutesUp(moves, MIDNIGHT, MIDNIGHT + now)).toBe(minutes);
  });

  test("the size's price and its disk's: two hours of m8g.large, its 60 GB since first seen; a size with no price is none", () => {
    const moves = [{ up: true, at: MIDNIGHT + 8 * H }];
    // 60 GB of gp3 at $0.088 a GB-month (730 h): about $0.0072 an hour
    const diskHourly = (60 * 0.088) / 730;

    expect(
      boxCostToday({ moves, size: 'm8g.large', dayStart: MIDNIGHT, now: MIDNIGHT + 10 * H }),
    ).toEqual({
      usd: 0.2145,
      minutes: 120,
      hourly: 0.10004,
      diskHourly,
      at: iso(MIDNIGHT + 10 * H),
    });
    // asleep since before midnight, its disk grown to 120 GB: the disk alone, all day
    expect(
      boxCostToday({
        moves: [{ up: false, at: MIDNIGHT - 5 * H }],
        size: 'm8g.large',
        dayStart: MIDNIGHT,
        now: MIDNIGHT + 10 * H,
        diskGb: 120,
      }),
    ).toMatchObject({ usd: 0.1447, minutes: 0 });
    expect(
      boxCostToday({ moves, size: 'x9.huge', dayStart: MIDNIGHT, now: MIDNIGHT + 10 * H }),
    ).toBeNull();
  });

  test("from the clock: a running box's grows, a stopped one's holds, a new day starts at none", () => {
    const cost = { usd: 0.2, minutes: 120, hourly: 0.1, at: iso(MIDNIGHT + 10 * H) };
    const later = MIDNIGHT + 11 * H;

    expect(boxCostAt(cost, true, later, MIDNIGHT)).toBeCloseTo(0.3, 6);
    expect(boxCostAt(cost, false, later, MIDNIGHT)).toBe(0.2);
    // Past midnight: today's is what it ran since then.
    const tomorrow = MIDNIGHT + 24 * H;

    expect(boxCostAt(cost, true, tomorrow + 30 * MIN, tomorrow)).toBeCloseTo(0.05, 6);
    expect(boxCostAt(cost, false, tomorrow + 30 * MIN, tomorrow)).toBeNull();
    expect(boxCostAt({ ...cost, usd: 0, minutes: 0 }, false, later, MIDNIGHT)).toBeNull();
    // its disk priced: asleep it still grows, at the disk's price alone (ADR 0022)
    const disk = { ...cost, diskHourly: 0.01 };

    expect(boxCostAt(disk, true, later, MIDNIGHT)).toBeCloseTo(0.31, 6);
    expect(boxCostAt(disk, false, later, MIDNIGHT)).toBeCloseTo(0.21, 6);
    expect(boxCostAt(disk, false, tomorrow + 30 * MIN, tomorrow)).toBeCloseTo(0.005, 6);
  });

  test.each<[string, number | null, [string, number][], [string, number][]]>([
    [
      'split by busy minutes',
      0.3,
      [
        ['101', 40],
        ['102', 20],
      ],
      [
        ['101', 0.2],
        ['102', 0.1],
      ],
    ],
    [
      'one never busy: no share',
      0.3,
      [
        ['101', 30],
        ['102', 0],
      ],
      [
        ['101', 0.3],
        ['102', 0],
      ],
    ],
    ['none busy yet: no shares', 0.3, [['101', 0]], []],
    ['no cost: no shares', null, [['101', 30]], []],
  ])("a workspace's share of its box's cost (ADR 0022): %s", (_, usd, busy, shares) => {
    expect([
      ...workspaceShares(
        usd,
        busy.map(([card, minutes]) => ({ card, minutes })),
      ),
    ]).toEqual(shares);
  });

  test.each<[string, number | null, string]>([
    ['running', 0.2149, '$0.21 today'],
    ['stopped: the same words (#194)', 0.84, '$0.84 today'],
    ['nothing yet', null, '—'],
    ['running, a cent at most', 0.001, '$0.00 today'],
  ])('%s: %p', (_, usd, text) => {
    expect(boxCostText(usd)).toBe(text);
  });
});

describe('Up, Release and stuck starting', () => {
  const launched = (state: BoxData['state'], ago: number): BoxData => ({
    ...bare('shop-4', state),
    launchedAt: iso(MIDNIGHT + 10 * H - ago),
  });
  const now = MIDNIGHT + 10 * H;

  test.each<[string, BoxData, number | null, string]>([
    ['running 72 min', launched('running', 72 * MIN), 72, '1 h 12 min'],
    ['just starting', launched('pending', 20_000), 0, '0 min'],
    ['two hours', launched('running', 2 * H), 120, '2 h'],
    ['asleep: its last LaunchTime is no uptime', launched('stopped', 3 * H), null, '—'],
    ['EC2 said no LaunchTime', bare('shop-4', 'running'), null, '—'],
  ])('%s', (_, box, minutes, text) => {
    expect(boxUpMinutes(box, now)).toBe(minutes);
    expect(boxUpText(boxUpMinutes(box, now))).toBe(text);
  });

  test('release: the launch template version as v11; unknown is —', () => {
    expect(boxReleaseText(11)).toBe('v11');
    expect(boxReleaseText(null)).toBe('—');
  });

  test('stuck: starting over 5 min, said in minutes; running, or starting 5 min, is not', () => {
    expect(boxStuckMinutes(launched('pending', 6 * MIN), now)).toBe(6);
    expect(boxStuckMinutes(launched('pending', 5 * MIN), now)).toBeNull();
    expect(boxStuckMinutes(launched('running', 60 * MIN), now)).toBeNull();
  });
});

describe('where a box stands for a command (#143): what is true, and the next step', () => {
  const NOW = MIDNIGHT + 10 * H;
  const since = iso(NOW - 2 * MIN);

  test.each([
    [
      'asleep',
      { kind: 'asleep', state: 'stopped' },
      'stopped',
      'box shop-4 is stopped · abe box start shop-4 wakes it',
    ],
    [
      'on its way to sleep',
      { kind: 'asleep', state: 'stopping' },
      'stopping',
      'box shop-4 is stopping · abe box start shop-4 wakes it once it has stopped',
    ],
    [
      'starting',
      { kind: 'starting', since },
      'starting · 2 min',
      'box shop-4 is starting · 2 min · try again in a minute; abe box status shop-4 says when it runs',
    ],
    [
      'running, its serve not answering yet',
      { kind: 'silent', since },
      'running · serve not answering · 2 min',
      'box shop-4 is running · serve not answering · 2 min · still booting? try again in a minute; abe box status shop-4 says when it answers',
    ],
    [
      'running, its serve silent past booting',
      { kind: 'silent', since: iso(NOW - 40 * MIN) },
      'running · serve not answering · 40 min',
      'box shop-4 is running · serve not answering · 40 min · abe box attach shop-4 -- journalctl -u abe-serve says why; abe box stop shop-4, then abe box start shop-4 boots it again',
    ],
    [
      'running, its serve gone after it had answered',
      { kind: 'silent', since, stopped: true },
      'running · serve not answering · 2 min',
      'box shop-4 is running · serve not answering · 2 min · abe box attach shop-4 -- journalctl -u abe-serve says why; abe box stop shop-4, then abe box start shop-4 boots it again',
    ],
    [
      'running, the link not there',
      { kind: 'unreachable', why: 'no route to host' },
      'running · cannot be reached',
      'box shop-4 is running · cannot be reached: no route to host · try again; abe box status shop-4 says whether it answers',
    ],
    ['gone', { kind: 'gone' }, 'terminated', 'box shop-4 is terminated · abe box list names yours'],
  ] satisfies [string, BoxReach, string, string][])('%s', (_, reach, words, text) => {
    expect(boxReachWords(reach, NOW)).toBe(words);
    expect(boxReachText('shop-4', reach, NOW)).toBe(text);
    // The State column's words are the sentence's: the same in every place.
    expect(text).toContain(words);
  });

  test('a running box is never told to wake', () => {
    for (const reach of [
      { kind: 'silent', since },
      { kind: 'silent', since: null },
      { kind: 'unreachable', why: 'x' },
    ] satisfies BoxReach[])
      expect(boxReachText('shop-4', reach, NOW)).not.toContain('wakes');
  });

  test("a listed box's reach: EC2's state first, then whether its serve answered", () => {
    const at = { ...bare('shop-4', 'running'), launchedAt: since };

    expect(boxReachOf({ ...at, serve: 'answers' })).toBeUndefined();
    expect(boxReachOf({ ...at, serve: 'silent' })).toEqual({ kind: 'silent', since });
    expect(
      boxReachOf({ ...at, serve: 'silent', reach: { kind: 'unreachable', why: 'no route' } }),
    ).toEqual({ kind: 'unreachable', why: 'no route' });
    // Moved on since (a screen's box.state): its old reach is not its state now.
    expect(
      boxReachOf({ ...at, state: 'stopped', reach: { kind: 'unreachable', why: 'no route' } }),
    ).toEqual({ kind: 'asleep', state: 'stopped' });
    expect(boxReachOf({ ...at, state: 'pending' })).toEqual({ kind: 'starting', since });
  });

  test('box status in words: a box in trouble says so on a line of its own', () => {
    const silent: BoxData = {
      ...bare('shop-4', 'running'),
      launchedAt: since,
      serve: 'silent',
      readAt: iso(NOW),
    };

    expect(boxText(silent)).toBe(
      'shop-4  booting · serve not answering yet  m8g.large\n  box shop-4 is running · serve not answering · 2 min · still booting? try again in a minute; abe box status shop-4 says when it answers\n',
    );
    // Asleep is no trouble: its state says it.
    expect(boxText({ ...bare('shop-5', 'stopped'), readAt: iso(NOW) })).toBe(
      'shop-5  stopped  m8g.large\n',
    );
    expect(boxText({ ...silent, serve: 'answers' })).toBe('shop-4  running  m8g.large\n');
  });
});

describe('box names in order (#272)', () => {
  test('numbers as numbers: demo-shop-2 before demo-shop-10, card 98 before 102', () => {
    const names = ['demo-shop-10', 'demo-shop-2', 'demo-shop-1', 'shop-102', 'shop-98'];

    expect(
      names
        .map((name) => ({ name }))
        .sort(byBoxName)
        .map((b) => b.name),
    ).toEqual(['demo-shop-1', 'demo-shop-2', 'demo-shop-10', 'shop-98', 'shop-102']);
  });
});

describe('box stop with a session working there asks first (#316)', () => {
  test.each([
    ['working', true],
    ['starting', true],
    ['waiting', false],
    ['ended', false],
  ] as const)('a session %s: asks %p', (state, asks) => {
    expect(boxStopRefusal('shop-4', { id: '4-ab12', state }) !== undefined).toBe(asks);
  });

  test('none on it: no question; the words say what is lost, what stays and the way on', () => {
    expect(boxStopRefusal('shop-4', undefined)).toBeUndefined();
    expect(boxStopRefusal('shop-4', { id: '4-ab12', state: 'working' })).toBe(
      'session 4-ab12 is working on box shop-4: stopping the box ends it mid-turn (its branch and files stay on the box; a Retry starts a new session there). abe box stop shop-4 --yes stops it anyway',
    );
  });
});
