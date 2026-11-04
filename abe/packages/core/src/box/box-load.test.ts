import { describe, expect, test } from 'bun:test';
import { cardOfWorkspace } from './workspace';
import {
  BOX_DISK_STEP_GB,
  type BoxLoad,
  boxLoadOf,
  diskGrowth,
  launchShort,
  launchShortAsk,
  launchShortText,
  nextBoxSize,
} from './box-load';

const GB = 1024 ** 3;
const at = '2026-10-25T10:00:00.000Z';

const load = (o: Partial<BoxLoad> = {}): BoxLoad => ({
  at,
  memory: { availableMb: 9000, totalMb: 16_000 },
  cpuPercent: 20,
  disk: { freeGb: 30, totalGb: 60 },
  workspaces: [],
  ...o,
});

describe("a box's load from what its host and Docker say", () => {
  test('memory, CPU between two reads, the root disk, each workspace volume by card', () => {
    expect(
      boxLoadOf(
        {
          memAvailableKb: 1_433_600,
          memTotalKb: 16_000_000,
          cpu: { busy: 1600, total: 10_000 },
          disk: { freeBytes: 29 * GB, totalBytes: 60 * GB },
          volumes: { 'abe-ws-101': 4.1 * GB, 'abe-ws-102': 3.84 * GB, 'abe-pg-data': GB },
        },
        { busy: 1000, total: 6000 },
        at,
        cardOfWorkspace,
      ),
    ).toEqual({
      at,
      memory: { availableMb: 1400, totalMb: 15_625 },
      // (1600 - 1000) / (10000 - 6000): the CPU between the two reads
      cpuPercent: 15,
      disk: { freeGb: 29, totalGb: 60 },
      workspaces: [
        { card: '101', diskGb: 4.1 },
        { card: '102', diskGb: 3.8 },
      ],
    });
  });

  test("a first read's CPU is since the box's boot; an old box's volume is its one card's", () => {
    const read = boxLoadOf(
      {
        memAvailableKb: 8_000_000,
        memTotalKb: 8_000_000,
        cpu: { busy: 50, total: 1000 },
        disk: { freeBytes: 10 * GB, totalBytes: 40 * GB },
        volumes: { 'abe-workspace': 2 * GB },
      },
      undefined,
      at,
      (v) => (v === 'abe-workspace' ? '101' : cardOfWorkspace(v)),
    );

    expect(read.cpuPercent).toBe(5);
    expect(read.workspaces).toEqual([{ card: '101', diskGb: 2 }]);
  });
});

describe('the next size up, within the limit', () => {
  test.each([
    ['m8g.large', 'm8g.2xlarge', 'm8g.xlarge'],
    ['m8g.xlarge', 'm8g.2xlarge', 'm8g.2xlarge'],
    ['m8g.2xlarge', 'm8g.2xlarge', null],
    ['m8g.xlarge', 'm8g.large', null],
    ['t3.micro', 'm8g.2xlarge', null],
  ])('%s under %s: %s', (size, max, next) => {
    expect(nextBoxSize(size, max)).toBe(next);
  });
});

describe('a launch onto a box short of memory or disk asks first (never Queued, ADR 0022)', () => {
  test.each<[string, Partial<BoxLoad>, { short: 'memory' | 'disk'; line: string } | undefined]>([
    ['room enough', {}, undefined],
    [
      'under 3 GB of memory',
      { memory: { availableMb: 1434, totalMb: 16_000 } },
      {
        short: 'memory',
        line: 'demo-shop is short of memory: 1.4 GB free, 3 workspaces (#101 working)',
      },
    ],
    [
      'under 10 GB of disk',
      { disk: { freeGb: 6, totalGb: 60 } },
      {
        short: 'disk',
        line: 'demo-shop is short of disk: 6 GB free of 60 GB, 3 workspaces (#101 working)',
      },
    ],
  ])('%s', (_, o, asked) => {
    expect(launchShort(load(o), { box: 'demo-shop', workspaces: 3, working: ['101'] })).toEqual(
      asked,
    );
  });

  test('memory first when both are short; none working is not said', () => {
    expect(
      launchShort(
        load({ memory: { availableMb: 900, totalMb: 8000 }, disk: { freeGb: 2, totalGb: 40 } }),
        { box: 'api', workspaces: 1, working: [] },
      ),
    ).toEqual({ short: 'memory', line: 'api is short of memory: 0.9 GB free, 1 workspace' });
  });
});

describe("the launch's question: Resize (the next size, within the limit), Launch anyway, Cancel", () => {
  const SHORT_MEMORY = { memory: { availableMb: 1434, totalMb: 16_000 } };
  const SHORT_DISK = { disk: { freeGb: 6, totalGb: 60 } };
  const on = (size: string, max: string, working: string[]) => ({
    box: 'demo-shop',
    size,
    max,
    workspaces: 3,
    working,
  });

  test.each<[string, Partial<BoxLoad>, ReturnType<typeof on>, string | null, string[]]>([
    [
      'short of memory: Resize recommended, saying who ends mid-turn',
      SHORT_MEMORY,
      on('m8g.large', 'm8g.2xlarge', ['101']),
      'm8g.xlarge',
      [
        'resize Resize to m8g.xlarge (stops the box ~2 min: #101 ends mid-turn) recommended',
        'anyway Launch anyway (they share memory; a build may be killed)',
        'cancel Cancel',
      ],
    ],
    [
      'none working: none said to end',
      SHORT_MEMORY,
      on('m8g.xlarge', 'm8g.2xlarge', []),
      'm8g.2xlarge',
      [
        'resize Resize to m8g.2xlarge (stops the box ~2 min) recommended',
        'anyway Launch anyway (they share memory; a build may be killed)',
        'cancel Cancel',
      ],
    ],
    [
      'two working',
      SHORT_MEMORY,
      on('m8g.large', 'm8g.2xlarge', ['101', '102']),
      'm8g.xlarge',
      [
        'resize Resize to m8g.xlarge (stops the box ~2 min: #101, #102 end mid-turn) recommended',
        'anyway Launch anyway (they share memory; a build may be killed)',
        'cancel Cancel',
      ],
    ],
    [
      'at limits.maxBoxSize: no Resize',
      SHORT_MEMORY,
      on('m8g.2xlarge', 'm8g.2xlarge', ['101']),
      null,
      ['anyway Launch anyway (they share memory; a build may be killed)', 'cancel Cancel'],
    ],
    [
      'short of disk: no Resize (a larger box has the same disk)',
      SHORT_DISK,
      on('m8g.large', 'm8g.2xlarge', ['101']),
      null,
      [
        'anyway Launch anyway (they share the disk; it grows by itself up to limits.maxBoxDisk)',
        'cancel Cancel',
      ],
    ],
  ])('%s', (_, o, at, resize, choices) => {
    const ask = launchShortAsk(load(o), at);

    expect(ask?.resize).toBe(resize);
    expect(
      ask?.choices.map((c) =>
        [
          c.answer,
          c.label,
          c.note === undefined ? '' : `(${c.note})`,
          c.recommended === true ? 'recommended' : '',
        ]
          .filter((w) => w !== '')
          .join(' '),
      ),
    ).toEqual(choices);
  });

  test('room enough: no question', () => {
    expect(launchShortAsk(load(), on('m8g.large', 'm8g.2xlarge', []))).toBeUndefined();
  });

  test('as a refusal: the line, then each answer with its flag', () => {
    const ask = launchShortAsk(load(SHORT_MEMORY), on('m8g.large', 'm8g.2xlarge', ['101']));

    expect(ask === undefined ? '' : launchShortText(ask)).toBe(
      'demo-shop is short of memory: 1.4 GB free, 3 workspaces (#101 working) · --short resize: Resize to m8g.xlarge (stops the box ~2 min: #101 ends mid-turn) · --short anyway: Launch anyway (they share memory; a build may be killed)',
    );
  });
});

describe('the root disk grows by itself (+20 GB under 20 % free, up to limits.maxBoxDisk)', () => {
  const now = Date.parse(at);
  const hours = (h: number) => new Date(now - h * 3_600_000).toISOString();

  test.each<[string, Partial<BoxLoad>, number, string | null, number | undefined]>([
    ['with 20 % free or more: not', { disk: { freeGb: 12, totalGb: 60 } }, 200, null, undefined],
    ['under 20 % free: +20 GB', { disk: { freeGb: 11, totalGb: 60 } }, 200, null, 80],
    ['up to the limit only', { disk: { freeGb: 10, totalGb: 190 } }, 200, null, 200],
    ['at the limit: not', { disk: { freeGb: 10, totalGb: 200 } }, 200, null, undefined],
    [
      'grown under 6 h ago (AWS allows one change per 6 h): not',
      { disk: { freeGb: 5, totalGb: 60 } },
      200,
      hours(5),
      undefined,
    ],
    ['grown 6 h ago: again', { disk: { freeGb: 5, totalGb: 60 } }, 200, hours(6), 80],
  ])('%s', (_, o, max, lastGrownAt, toGb) => {
    expect(diskGrowth(load(o), { maxGb: max, lastGrownAt, now })).toEqual(
      toGb === undefined ? undefined : { toGb },
    );
  });

  test('a step is 20 GB', () => {
    expect(BOX_DISK_STEP_GB).toBe(20);
  });
});
