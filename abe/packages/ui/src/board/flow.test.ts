/** The Factory view's rules as tables: rail stages, looks, what stands out, rail rows. */
import { describe, expect, test } from 'bun:test';
import type { BoxData, BoxListData, FactoryPrData, LaunchProgress, Stage } from '@abe/core';
import { factoryRun, listCard, session, X_BOXES } from '@abe/testing';
import { CRASHED as CORE_CRASHED } from '@abe/core';
import {
  boxMarkOf,
  CRASHED,
  countsOf,
  readyWidgets,
  initials,
  isTheirs,
  launchTicking,
  lookOf,
  matches,
  minutesIn,
  railRow,
  railSegments,
  railStageOf,
  railWord,
  RAIL_STAGE_OF,
  type RailStage,
  sessionOnlyLook,
  shownState,
  standing,
  standsAlone,
  timeIn,
  typeBadge,
  type RailSegment,
} from './index';

/** A box's mark and the moves heard, as `boxMarkOf` takes and gives them. */
type BoxMoves = Parameters<typeof boxMarkOf>[1];
type BoxMark = NonNullable<ReturnType<typeof boxMarkOf>>;

/** How a person abandoned a run in pr. */
const ABANDONED = {
  as: 'abandoned',
  reason: 'not needed after all',
  at: '2026-10-01T09:21:00.000Z',
  from: 'pr',
} as const;

const pr = (o: Partial<FactoryPrData> = {}): FactoryPrData => ({
  repo: 'mkdir-swe/demo-shop',
  number: 61,
  url: 'https://github.com/mkdir-swe/demo-shop/pull/61',
  state: 'open',
  merge: 'person',
  checks: 'success',
  mergeCommit: null,
  deploy: null,
  branch: null,
  ...o,
});

describe('the rail stage a stage is on', () => {
  test.each<[Stage, RailStage]>([
    ['spec', 'Spec'],
    ['reproduce', 'Spec'],
    ['build', 'Build'],
    ['checks', 'Build'],
    ['review', 'Review'],
    ['verify', 'Review'],
    ['pr', 'PR'],
    ['done', 'Done'],
  ])('%s → %s', (stage, lane) => {
    expect(RAIL_STAGE_OF[stage]).toBe(lane);
  });
});

type Row = [
  what: string,
  run: Parameters<typeof lookOf>[0],
  session: Parameters<typeof lookOf>[1],
  state: string,
  word: string,
  glyph: string,
  emphasis: string,
  counted: string,
];

const run = (
  stage: Stage,
  state: 'running' | 'needs-you' | 'queued' | 'done' = 'running',
  o = {},
) => factoryRun(4, 'Cart total', stage, state, o);

describe('the look of a run', () => {
  test.each<Row>([
    [
      'building',
      run('build'),
      { state: 'working' },
      'running',
      'Running',
      '●',
      'normal',
      'running',
    ],
    [
      'writing the spec',
      run('spec'),
      { state: 'working' },
      'running',
      'Writing spec',
      '●',
      'normal',
      'running',
    ],
    [
      'checking',
      run('checks'),
      { state: 'working' },
      'running',
      'Checking',
      '●',
      'normal',
      'running',
    ],
    [
      'reviewing',
      run('review'),
      { state: 'working' },
      'running',
      'Reviewing',
      '●',
      'normal',
      'running',
    ],
    [
      'verifying',
      run('verify'),
      { state: 'working' },
      'running',
      'Verifying',
      '●',
      'normal',
      'running',
    ],
    [
      'needs you',
      run('build', 'needs-you'),
      { state: 'waiting' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'the agent asked, still working',
      run('verify', 'needs-you'),
      { state: 'working' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'its session ended first',
      run('build', 'needs-you'),
      { state: 'ended' },
      'failed',
      'Failed',
      '✗',
      'failed',
      'failed',
    ],
    [
      'you stopped its session (#205)',
      run('build', 'needs-you'),
      { state: 'ended', stopped: true },
      'idle',
      'Stopped',
      '○',
      'normal',
      'none',
    ],
    [
      'you stopped it while it worked (#205)',
      run('verify'),
      { state: 'ended', stopped: true },
      'idle',
      'Stopped',
      '○',
      'normal',
      'none',
    ],
    [
      'a box still starting',
      run('spec'),
      { state: 'starting' },
      'starting',
      'Starting',
      '●',
      'normal',
      'running',
    ],
    [
      'past the box limit',
      run('spec', 'queued'),
      { state: 'queued' },
      'idle',
      'Queued',
      '○',
      'normal',
      'none',
    ],
    [
      'queued, its session not read yet',
      run('spec', 'queued'),
      undefined,
      'idle',
      'Queued',
      '○',
      'normal',
      'none',
    ],
    [
      'quiet with nothing asked',
      run('build'),
      { state: 'waiting' },
      'idle',
      'Idle',
      '○',
      'normal',
      'none',
    ],
    [
      'on test',
      run('done', 'done'),
      { state: 'ended' },
      'on-test',
      'On test',
      '✓',
      'normal',
      'none',
    ],
    [
      'ended with its report',
      run('done', 'done', { outcome: 'reported' }),
      { state: 'ended' },
      'ended',
      'Reported',
      '✓',
      'normal',
      'none',
    ],
    [
      'pr: checks running',
      run('pr', 'running', { pr: pr({ checks: 'pending' }) }),
      { state: 'ended' },
      'running',
      'Checks running',
      '●',
      'normal',
      'running',
    ],
    [
      'pr: ready for a person',
      run('pr', 'needs-you', { pr: pr() }),
      { state: 'ended' },
      'ready',
      'Ready for review',
      '●',
      'normal',
      'ready',
    ],
    [
      'pr: a person merges, its checks last read pending: ready, as its run says',
      run('pr', 'needs-you', { pr: pr({ checks: 'pending' }) }),
      { state: 'ended' },
      'ready',
      'Ready for review',
      '●',
      'normal',
      'ready',
    ],
    [
      'pr: no checks, a person merges',
      run('pr', 'needs-you', { pr: pr({ checks: 'none' }) }),
      { state: 'ended' },
      'ready',
      'Ready for review',
      '●',
      'normal',
      'ready',
    ],
    [
      'pr: checks failed',
      run('pr', 'needs-you', { pr: pr({ checks: 'failure' }) }),
      { state: 'ended' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'pr: closed',
      run('pr', 'needs-you', { pr: pr({ state: 'closed' }) }),
      { state: 'ended' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'pr: auto merge on its way',
      run('pr', 'running', { pr: pr({ merge: 'auto' }) }),
      { state: 'ended' },
      'running',
      'Merging',
      '●',
      'normal',
      'running',
    ],
    [
      'pr: auto merge failed',
      run('pr', 'needs-you', { pr: pr({ merge: 'auto' }) }),
      { state: 'ended' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'pr: merged, deploying',
      run('pr', 'running', { pr: pr({ state: 'merged', deploy: 'pending' }) }),
      { state: 'ended' },
      'running',
      'Deploying to test',
      '●',
      'normal',
      'running',
    ],
    [
      'pr: merged, deploying to its Done environment (#184)',
      run('pr', 'running', { pr: pr({ state: 'merged', deploy: 'pending', done: 'staging' }) }),
      { state: 'ended' },
      'running',
      'Deploying to staging',
      '●',
      'normal',
      'running',
    ],
    [
      'done on another Done environment',
      run('done', 'done', { pr: pr({ state: 'merged', deploy: 'success', done: 'staging' }) }),
      { state: 'ended' },
      'on-test',
      'On staging',
      '✓',
      'normal',
      'none',
    ],
    [
      'done at the merge (factory.done: merged)',
      run('done', 'done', { pr: pr({ state: 'merged', done: 'merged' }) }),
      { state: 'ended' },
      'on-test',
      'Merged',
      '✓',
      'normal',
      'none',
    ],
    [
      'ended done by a person',
      run('done', 'done', {
        outcome: 'done',
        ended: {
          as: 'done',
          reason: 'deploy re-run by hand',
          at: '2026-10-01T09:21:00.000Z',
          from: 'pr',
        },
      }),
      { state: 'ended' },
      'on-test',
      'Done',
      '✓',
      'normal',
      'none',
    ],
    [
      'ended as not reproduced: nothing shipped, no ✓ (#320)',
      run('done', 'done', { outcome: 'not-reproduced' }),
      { state: 'ended' },
      'ended',
      'Not reproduced',
      '○',
      'normal',
      'none',
    ],
    [
      'ended as abandoned',
      run('done', 'done', { outcome: 'abandoned' }),
      { state: 'ended' },
      'ended',
      'Abandoned',
      '○',
      'normal',
      'none',
    ],
    [
      'pr: the deploy failed',
      run('pr', 'needs-you', { pr: pr({ state: 'merged', deploy: 'failure' }) }),
      { state: 'ended' },
      'needs-you',
      'Needs you',
      '◆',
      'needs-you',
      'needs-you',
    ],
    [
      'pr: not opened yet',
      run('pr'),
      { state: 'working' },
      'running',
      'Opening PR',
      '●',
      'normal',
      'running',
    ],
  ])('%s', (_, r, session, state, word, glyph, emphasis, counted) => {
    expect(lookOf(r, session)).toMatchObject({ state, word, glyph, emphasis, counted });
  });

  test('stands out: only Needs you and Failed; a running card looks as any card', () => {
    expect(lookOf(run('build', 'needs-you'), { state: 'waiting' }).emphasis).toBe('needs-you');
    expect(lookOf(run('build', 'needs-you'), { state: 'ended' }).emphasis).toBe('failed');
    expect(lookOf(run('build'), { state: 'working' }).emphasis).toBe('normal');
    expect(lookOf(run('done', 'done'), undefined).emphasis).toBe('normal');
  });

  test('a run whose box stopped under its session reads Box asleep, never Failed', () => {
    const box = 'qa2-e-85a7-105';
    const ended = {
      state: 'ended' as const,
      box,
      reason: `its box ${box} stopped · abe session reopen 105-a1b2 wakes it`,
    };
    const slept = {
      ...ended,
      reason: 'its box went to sleep while it waited on you (qa2-e-85a7-105, idle) · abe …',
    };

    for (const s of [ended, slept])
      expect(lookOf(run('pr', 'needs-you'), s)).toMatchObject({
        state: 'needs-you',
        word: 'Box asleep',
        glyph: '◆',
        emphasis: 'needs-you',
        counted: 'needs-you',
      });
    // its own end, with no box in its reason: still Failed
    expect(lookOf(run('pr', 'needs-you'), { state: 'ended', box, reason: null }).word).toBe(
      'Failed',
    );
  });

  test('a session whose Claude Code exited without ending it reads ✗ Crashed', () => {
    // serve's own words: the two never part
    expect(CRASHED).toBe(CORE_CRASHED);
    const gone = { state: 'ended' as const, reason: CRASHED };

    expect(lookOf(run('build', 'needs-you'), gone)).toMatchObject({
      state: 'failed',
      word: 'Crashed',
      glyph: '✗',
      emphasis: 'failed',
      counted: 'failed',
    });
    // a plain session that crashed stands for its card, as one you stopped does
    expect(sessionOnlyLook({ ...gone, reason: CRASHED })).toMatchObject({ word: 'Crashed' });
    expect(standsAlone(gone)).toBe(true);
    expect(standsAlone({ ...gone, factory: true })).toBe(false);
    expect(standsAlone({ state: 'ended', reason: null })).toBe(false);
  });

  test.each([
    ['turn', 'Idle', 'none'],
    ['question', 'Needs you', 'needs-you'],
    ['dialog', 'Needs you', 'needs-you'],
  ] as const)('waiting on its %s: %s (a chat, a prototype’s run)', (waitingOn, word, counted) => {
    const waiting = { state: 'waiting', waitingOn } as const;

    expect(sessionOnlyLook(waiting)).toMatchObject({ word, counted });
    expect(lookOf(run('build', 'running', { prototype: true }), waiting)).toMatchObject({
      word,
      counted,
    });
  });

  test('a session you stopped reads Stopped even while its run is still held as Queued', () => {
    // Stop… on a Queued run: its session's end can come before the run's own move
    expect(lookOf(run('spec', 'queued'), { state: 'ended', stopped: true }).word).toBe('Stopped');
    expect(lookOf(run('spec', 'queued'), { state: 'queued' }).word).toBe('Queued');
  });

  test('one word while a run works, on the rail row as in Chat: the step word', () => {
    expect(lookOf(run('spec'), { state: 'working' }).word).toBe('Writing spec');
    expect(lookOf(run('review'), { state: 'working' }).word).toBe('Reviewing');
    expect(lookOf(run('pr', 'running', { pr: pr({ checks: 'pending' }) }), undefined).word).toBe(
      'Checks running',
    );
  });
});

describe('a run in its spec asking questions: one rule, the same word everywhere', () => {
  test.each<[string, Parameters<typeof lookOf>[1], string | undefined, string, string]>([
    [
      'an open round waits on you',
      { state: 'waiting', rounds: 2 },
      undefined,
      '◆',
      'Needs you · Question round 2',
    ],
    [
      'a teammate’s waits on them',
      { state: 'waiting', rounds: 2 },
      'Ana Example',
      '◆',
      'Needs Ana · Question round 2',
    ],
    ['between rounds: writing', { state: 'working', rounds: 1 }, undefined, '●', 'Writing spec'],
    [
      'stopped by you: as any run',
      { state: 'ended', stopped: true, rounds: 2 },
      undefined,
      '○',
      'Stopped',
    ],
  ])('%s', (_, ses, whose, glyph, word) => {
    const state = ses?.state === 'waiting' ? 'needs-you' : 'running';
    const l = lookOf(run('spec', state), ses, undefined, whose);

    expect([l.glyph, l.word]).toEqual([glyph, word]);
  });

  test('no question asked yet: as any run waiting', () => {
    expect(lookOf(run('spec'), { state: 'waiting', rounds: 0 }).word).toBe('Idle');
  });
});

describe('the stage rail', () => {
  const visit = (stage: Stage) => ({
    stage,
    startedAt: '2026-10-01T09:00:00.000Z',
    endedAt: '2026-10-01T09:01:00.000Z',
    durationMs: 60_000,
    report: null,
  });

  test.each<[Stage, RailSegment, RailSegment[], Stage[]]>([
    ['spec', 'now', ['now', 'todo', 'todo', 'todo', 'todo'], []],
    ['build', 'need', ['done', 'need', 'todo', 'todo', 'todo'], []],
    ['verify', 'now', ['done', 'done', 'now', 'todo', 'todo'], []],
    ['pr', 'ready', ['done', 'done', 'done', 'ready', 'todo'], []],
    ['done', 'done', ['done', 'done', 'done', 'done', 'done'], []],
    // a plain step stays on the stage before it: to-tickets on Spec, playbook on Review
    ['step', 'now', ['now', 'todo', 'todo', 'todo', 'todo'], ['spec']],
    ['step', 'need', ['done', 'done', 'need', 'todo', 'todo'], ['build', 'review', 'verify']],
    ['step', 'now', ['done', 'now', 'todo', 'todo', 'todo'], []],
  ])('%s, its own segment %s', (stage, own, segments, before) => {
    expect(railSegments({ stage, outcome: null, stages: before.map(visit) }, own)).toEqual(
      segments,
    );
  });

  test.each<[Stage, string]>([
    ['reproduce', 'Reproduce'],
    ['build', 'Build'],
    ['checks', 'Checks'],
    ['review', 'Review'],
    ['verify', 'Verify'],
    ['pr', 'PR'],
  ])('%s: the word names its own stage, as its step word does', (stage, word) => {
    expect(railWord({ stage, outcome: null, stages: [] })).toBe(word);
  });

  test('an abandoned run stays where it was given up, its segment dim: no Done', () => {
    const r = run('done', 'done', { outcome: 'abandoned', ended: ABANDONED });

    expect(railStageOf(r)).toBe('PR');
    expect(railSegments(r, lookOf(r, undefined).segment)).toEqual([
      'done',
      'done',
      'done',
      'wait',
      'todo',
    ]);
    // ended done: Done, as carried through
    expect(
      railStageOf(run('done', 'done', { outcome: 'done', ended: { ...ABANDONED, as: 'done' } })),
    ).toBe('Done');
  });

  test('a run ended as not reproduced stays on the stage it was ended in, dim: never all green', () => {
    const r = run('done', 'done', {
      outcome: 'not-reproduced',
      ended: { ...ABANDONED, as: 'not-reproduced', from: 'build' },
    });

    expect(railStageOf(r)).toBe('Build');
    expect(railSegments(r, lookOf(r, undefined).segment)).toEqual([
      'done',
      'wait',
      'todo',
      'todo',
      'todo',
    ]);
  });

  const NOW = '2026-10-01T09:21:00.000Z';
  const since = { since: '2026-10-01T09:00:00.000Z' };

  test.each<[string, Parameters<typeof railRow>[0], Partial<ReturnType<typeof railRow>>]>([
    [
      'running in Build',
      run('build', 'running', since),
      { stage: 'Build', glyph: '●', word: 'Running', state: 'running', time: '21 min' },
    ],
    [
      'needs you in Build',
      run('build', 'needs-you', since),
      { stage: 'Build', glyph: '◆', word: 'Needs you', state: 'needs-you', time: '21 min' },
    ],
    [
      'done: no stage word',
      run('done', 'done', since),
      { glyph: '✓', word: 'On test', state: 'on-test', time: '21 min' },
    ],
    [
      'abandoned: the stage it was given up in, no Done (#229)',
      run('done', 'done', { ...since, outcome: 'abandoned', ended: ABANDONED }),
      {
        stage: 'PR',
        segments: ['done', 'done', 'done', 'wait', 'todo'],
        glyph: '○',
        word: 'Abandoned',
      },
    ],
    [
      "a developer's prototype",
      run('build', 'running', { ...since, prototype: true }),
      { stage: 'Prototype', word: 'Running' },
    ],
  ])('%s', (_, r, row) => {
    const got = railRow(r, lookOf(r, { state: 'working' }), { now: NOW, session: undefined });

    expect(got).toMatchObject(row);
    if (row.stage === undefined) expect(got.stage).toBeUndefined();
  });

  test('a failed run: ✗ Failed in bad; the box mark rides along', () => {
    const r = run('build', 'needs-you', since);

    expect(
      railRow(r, lookOf(r, { state: 'ended' }), { now: NOW, session: undefined, box: 'asleep' }),
    ).toEqual({
      segments: ['done', 'fail', 'todo', 'todo', 'todo'],
      stage: 'Build',
      glyph: '✗',
      word: 'Failed',
      state: 'failed',
      time: '21 min',
      box: 'asleep',
    });
  });
});

describe('a cloud launch on its card: its step, by the second, amber once late', () => {
  const T0 = '2026-10-24T10:55:46.000Z';
  const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();
  const launch = (o: Partial<LaunchProgress> = {}): LaunchProgress => ({
    step: 'box-booting',
    since: at(7),
    startedAt: T0,
    box: 'demo-shop-901',
    how: 'new',
    detail: null,
    told: false,
    done: [{ step: 'box-starting', ms: 7000 }],
    ...o,
  });
  const starting = (l: LaunchProgress) => ({ state: 'starting' as const, since: T0, launch: l });
  const r = run('spec', 'running', { since: T0 });

  test("the rail says the step and the launch's clock to the second", () => {
    const s = starting(launch());

    expect(railRow(r, lookOf(r, s, at(45)), { now: at(45), session: s })).toMatchObject({
      word: 'Box booting',
      state: 'starting',
      glyph: '●',
      time: '0:45',
    });
  });

  test('past its budget the word turns amber; near the give-up red', () => {
    const image = launch({ step: 'base-image', since: at(87), detail: 'step 14/27', told: true });

    const slow = lookOf(r, starting(image), at(87 + 370));
    const stuck = lookOf(r, starting(image), at(13 * 60));

    // still starting (no Retry, no Running): only the hue it is drawn in says it is late
    expect([slow.state, slow.tone, shownState(slow)]).toEqual(['starting', 'slow', 'running']);
    expect([stuck.state, stuck.tone, shownState(stuck)]).toEqual(['starting', 'stuck', 'failed']);
    expect(railRow(r, stuck, { now: at(13 * 60), session: starting(image) }).state).toBe('failed');
    expect(lookOf(r, starting(image), at(130)).word).toBe('Building image');
  });

  test('no launch steps (a local session) or no clock yet: Starting, to the minute', () => {
    const local = { state: 'starting' as const, since: T0, launch: null };

    expect(lookOf(r, local, at(45)).word).toBe('Starting');
    expect(lookOf(r, starting(launch())).word).toBe('Starting');
    expect(railRow(r, lookOf(r, local, at(45)), { now: at(45), session: local }).time).toBe(
      '<1 min',
    );
  });

  test('a screen ticks by the second only while a launch starts', () => {
    expect(launchTicking([starting(launch())])).toBe(true);
    expect(launchTicking([{ state: 'starting', launch: null }, { state: 'working' }])).toBe(false);
    expect(launchTicking(undefined)).toBe(false);
  });
});

describe('cards', () => {
  const mine = [listCard(4, 'a', 'New', 'Alex Example')];

  test.each<[string, Parameters<typeof isTheirs>[0], 'mine' | 'team', boolean]>([
    ['yours on Team', listCard(4, 'a', 'New'), 'team', false],
    // a card made after Mine was read, assigned to you: yours, by whom Mine names
    ['yours, newer than Mine', listCard(7, 'd', 'New', 'Alex Example'), 'team', false],
    [
      'yours by name where one has no email',
      listCard(8, 'e', 'New', 'Alex Example', { assignee: { name: 'alex example', email: '' } }),
      'team',
      false,
    ],
    [
      'a namesake with another email: theirs',
      listCard(9, 'f', 'New', 'Alex Example', {
        assignee: { name: 'Alex Example', email: 'alex@other.test' },
      }),
      'team',
      true,
    ],
    ['a teammate’s on Team', listCard(5, 'b', 'New', 'Sam Sample'), 'team', true],
    ['no one’s on Team', listCard(6, 'c', 'New', null), 'team', false],
    ['anything on Mine', listCard(5, 'b', 'New', 'Sam Sample'), 'mine', false],
  ])('%s: theirs %s', (_, card, tab, theirs) => {
    expect(isTheirs(card, tab, mine)).toBe(theirs);
  });

  test.each([
    ['User Story', 'US'],
    ['Bug', 'Bug'],
    ['Product Backlog Item', 'PBI'],
    ['task', 'tas'],
  ])('type %s → %s', (type, badge) => {
    expect(typeBadge(type)).toBe(badge);
  });

  test.each([
    ['Alex Example', 'AE'],
    ['Sam', 'S'],
    ['Ann Marie Lind', 'AL'],
  ])('initials of %s: %s', (name, short) => {
    expect(initials(name)).toBe(short);
  });

  test.each([
    ['cart', true],
    ['#4', true],
    ['AB#4', true],
    ['shipping', false],
    ['', true],
  ])('the filter %s matches card 4 Cart total: %s', (filter, hit) => {
    expect(matches({ card: 4, title: 'Cart total' }, filter)).toBe(hit);
  });
});

describe('counts and time', () => {
  const looks = [
    lookOf(run('build'), { state: 'working' }),
    lookOf(run('build', 'needs-you'), { state: 'waiting' }),
    lookOf(run('verify'), { state: 'working' }),
    lookOf(run('build', 'needs-you'), { state: 'ended' }),
    lookOf(run('spec', 'queued'), { state: 'queued' }),
  ];

  test('the status bar keeps only ready for review: who needs you and what runs are the ear’s', () => {
    expect(readyWidgets(countsOf(looks))).toEqual([]);
    expect(readyWidgets(countsOf([]))).toEqual([]);
  });

  test('Ready for review counts as itself, never running: the chip says what the card says', () => {
    const ready = lookOf(run('pr', 'needs-you', { pr: pr() }), { state: 'waiting' });

    expect(ready.word).toBe('Ready for review');
    expect(countsOf([ready])).toEqual({ running: 0, needsYou: 0, failed: 0, ready: 1 });
    expect(readyWidgets(countsOf([ready, ...looks.slice(0, 1)]))).toEqual([
      { id: 'ready', text: '● 1 ready for review', hue: 'good', view: 'factory' },
    ]);
  });

  test.each([
    ['2026-10-01T09:00:09.000Z', '9 s'],
    ['2026-10-01T09:04:30.000Z', '4 min'],
    ['2026-10-01T10:00:00.000Z', '1 h'],
    ['2026-10-01T11:05:00.000Z', '2 h 5 min'],
  ])('time in stage at %s: %s', (now, text) => {
    expect(timeIn('2026-10-01T09:00:00.000Z', now)).toBe(text);
  });

  test('no clock yet: no time', () => {
    expect(timeIn('2026-10-01T09:00:00.000Z', undefined)).toBe('');
    expect(minutesIn('2026-10-01T09:00:00.000Z', undefined)).toBe('');
  });

  test.each([
    ['2026-10-01T09:00:09.000Z', '<1 min'],
    ['2026-10-01T09:21:30.000Z', '21 min'],
    ['2026-10-01T10:08:00.000Z', '1 h 8 min'],
  ])('a rail row ticks by the minute, at %s: %s', (now, text) => {
    expect(minutesIn('2026-10-01T09:00:00.000Z', now)).toBe(text);
  });
});

describe('the box mark', () => {
  test.each<[string, Parameters<typeof boxMarkOf>[0], BoxMoves, BoxMark | undefined]>([
    ['a local session: none', { state: 'working' }, {}, undefined],
    ['no session: none', undefined, {}, undefined],
    ['a box running', { box: 'demo-1', state: 'working' }, {}, 'running'],
    ['a box starting', { box: 'demo-1', state: 'starting' }, {}, 'starting'],
    ['queued', { box: 'demo-1', state: 'queued' }, {}, 'queued'],
    ['an ended session: asleep', { box: 'demo-1', state: 'ended' }, {}, 'asleep'],
    [
      'box.state stopped wins',
      { box: 'demo-1', state: 'working' },
      { 'demo-1': 'stopped' },
      'asleep',
    ],
    [
      'box.state starting wins',
      { box: 'demo-1', state: 'ended' },
      { 'demo-1': 'starting' },
      'starting',
    ],
    ['another box moved', { box: 'demo-1', state: 'working' }, { 'demo-2': 'stopped' }, 'running'],
  ])('%s', (_, session, moves, mark) => {
    expect(boxMarkOf(session, moves)).toBe(mark);
  });
  const listed = (state: BoxData['state']): BoxListData => ({
    boxes: [X_BOXES.box('demo-3', { state, card: 3 })],
    queued: [],
  });
  const QUEUED: BoxListData = {
    boxes: [],
    queued: [{ ...X_BOXES.queued, box: 'demo-3', card: 3 }],
  };

  test.each<[string, BoxListData, BoxMoves, BoxMark | undefined]>([
    ['its box asleep, by abe:card', listed('stopped'), {}, 'asleep'],
    ['its box running', listed('running'), {}, 'running'],
    ['its box starting', listed('pending'), {}, 'starting'],
    ['its box stopping: asleep', listed('stopping'), {}, 'asleep'],
    ['a gone box: none', listed('terminated'), {}, undefined],
    ['Queued for a box', QUEUED, {}, 'queued'],
    [
      'a placement Queued for another card: none',
      { boxes: [], queued: [{ ...X_BOXES.queued, box: 'demo-3', card: 9 }] },
      {},
      undefined,
    ],
    ['a box.state since the list wins', listed('stopped'), { 'demo-3': 'starting' }, 'starting'],
    ['no box tagged with the card: none', { boxes: [], queued: [] }, {}, undefined],
  ])('a card with no box session: %s', (_, list, moves, mark) => {
    expect(boxMarkOf({ state: 'working' }, moves, { card: 3, list })).toBe(mark);
  });

  test('a placement Queued under the session box’s name for another card is not this card’s', () => {
    const list: BoxListData = {
      boxes: [],
      queued: [{ ...X_BOXES.queued, box: 'demo-3', card: 9 }],
    };

    expect(boxMarkOf({ box: 'demo-3', state: 'working' }, {}, { card: 3, list })).toBe('running');
    expect(boxMarkOf({ box: 'demo-3', state: 'working' }, {}, { card: 9, list })).toBe('queued');
  });
});

describe('what a card stands for: one rule for its Board card, Chat and Sessions', () => {
  const at = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
  const run = (id: string, minute: number, state: 'running' | 'needs-you' | 'done') =>
    factoryRun(6, 'Greeted by time of day', state === 'done' ? 'done' : 'build', state, {
      session: id,
      startedAt: at(minute),
      ...(state === 'done' ? { outcome: 'not-reproduced' as const } : {}),
    });
  const ses = (
    id: string,
    minute: number,
    state: 'working' | 'ended',
    o: { stopped?: true; factory?: true } = {},
  ) => ({ ...session(id, state, 6), startedAt: at(minute), stopped: o.stopped === true, ...o });
  // a done run's session, stopped as its end stops it
  const over = () => ses('r1', 1, 'ended', { stopped: true, factory: true });

  test.each([
    [
      'a done run, a newer live plain session: the session',
      [run('r1', 1, 'done')],
      [over(), ses('p2', 2, 'working')],
      'p2',
    ],
    [
      'a done run, a newer plain session ended on its own: the run again',
      [run('r1', 1, 'done')],
      [over(), ses('p2', 2, 'ended')],
      'r1',
    ],
    [
      'a done run, a newer plain session you stopped: that session',
      [run('r1', 1, 'done')],
      [over(), ses('p2', 2, 'ended', { stopped: true })],
      'p2',
    ],
    [
      'a plain session you stopped, a newer done run: the run',
      [run('r2', 2, 'done')],
      [
        ses('p1', 1, 'ended', { stopped: true }),
        ses('r2', 2, 'ended', { stopped: true, factory: true }),
      ],
      'r2',
    ],
    [
      'a live run, an older live plain session: the newest live, the run',
      [run('r2', 2, 'running')],
      [ses('p1', 1, 'working'), ses('r2', 2, 'working', { factory: true })],
      'r2',
    ],
    [
      'a failed run waiting on you, an older live plain session: the run, it needs you',
      [run('r2', 2, 'needs-you')],
      [ses('p1', 1, 'working'), ses('r2', 2, 'ended', { factory: true })],
      'r2',
    ],
    [
      'a run waiting on you, its session not listed, a newer stopped plain one: the run',
      [run('r1', 1, 'needs-you')],
      [ses('p2', 2, 'ended', { stopped: true })],
      'r1',
    ],
    [
      'an older live run, a newer done one: the live one',
      [run('r1', 1, 'running'), run('r2', 2, 'done')],
      [ses('r1', 1, 'working', { factory: true }), ses('r2', 2, 'ended', { factory: true })],
      'r1',
    ],
    [
      'a run whose session is not listed yet, an older ended one: the run',
      [run('r2', 2, 'running')],
      [ses('p1', 1, 'ended', { stopped: true })],
      'r2',
    ],
    [
      'a stopped plain session, a newer one ended on its own, no run: nothing',
      [],
      [ses('p1', 1, 'ended', { stopped: true }), ses('p2', 2, 'ended')],
      undefined,
    ],
    [
      "a cleared run's session alone: nothing",
      [],
      [ses('r1', 1, 'ended', { stopped: true, factory: true })],
      undefined,
    ],
    [
      "a developer's prototype run: the run with its session; a live prototype alone: nothing",
      [run('r1', 1, 'running')],
      [
        { ...ses('r1', 1, 'working'), kind: 'prototype' },
        { ...ses('x2', 2, 'working'), kind: 'prototype' },
      ],
      'r1',
    ],
  ] as const)('%s', (_, runs, sessions, id) => {
    const stands = standing(runs, sessions).get(6);

    expect(stands?.session?.id ?? stands?.run?.session).toBe(id);
    // a run's session is the run's own
    if (stands?.run !== undefined && stands.session !== undefined)
      expect(stands.session.id).toBe(stands.run.session);
  });
});
