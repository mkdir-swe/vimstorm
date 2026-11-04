/** Rule tables for a box's idle stop (#92, ADR 0021): when the box's own serve shuts it down. */
import { describe, expect, test } from 'bun:test';
import {
  boxIdleText,
  coreDefaults,
  type IdleKeep,
  idleKeepsOf,
  idleLook,
  type LayerSource,
  localClock,
  mergeSettings,
  type SessionState,
  waitingSinceOf,
} from '../index';

const MIN = 60_000;
const now = Date.parse('2026-10-24T10:00:00Z');
const at = (ms: number) => new Date(now + ms).toISOString();

describe('idleLook: idle is no hook and no one attached for box.idleMinutes', () => {
  test.each<[string, number, readonly IdleKeep[], string | null, boolean]>([
    // [case, last active (ms before now), kept by, stops at, stop now]
    ['just active', 0, [], at(30 * MIN), false],
    ['a hook 29 min ago', 29 * MIN, [], at(1 * MIN), false],
    ['nothing for 30 min', 30 * MIN, [], at(0), true],
    ['nothing for hours', 300 * MIN, [], at(-270 * MIN), true],
    ['attached long after the last hook', 300 * MIN, ['attached'], null, false],
    ['a session working without hooks', 300 * MIN, ['working'], null, false],
    ['a Factory run waiting on its pull request', 300 * MIN, ['pr'], null, false],
    ['kept awake by you, nothing else on it', 300 * MIN, ['awake'], null, false],
  ])('%s', (_, ago, keptBy, stopsAt, stop) => {
    const look = idleLook({ now, minutes: 30, activeAt: now - ago, keptBy });

    expect([look.stopsAt, look.stop]).toEqual([stopsAt, stop]);
  });

  test('kept up: the idle time counts again from the last moment it was kept', () => {
    const kept = idleLook({ now, minutes: 30, activeAt: now - 300 * MIN, keptBy: ['attached'] });

    expect(kept.activeAt).toBe(at(0));
    const left = idleLook({
      now: now + 10 * MIN,
      minutes: 30,
      activeAt: Date.parse(kept.activeAt),
      keptBy: [],
    });

    expect([left.stopsAt, left.stop]).toEqual([at(30 * MIN), false]);
  });

  test('let sleep: awake taken off, the idle clock starts from that moment', () => {
    const awake = idleLook({ now, minutes: 30, activeAt: now - 300 * MIN, keptBy: ['awake'] });

    expect([awake.stopsAt, awake.keptBy]).toEqual([null, ['awake']]);
    // `abe box sleep` 2 h on: the last moment it was kept is then.
    const slept = idleLook({
      now: now + 120 * MIN,
      minutes: 30,
      activeAt: now + 120 * MIN,
      keptBy: [],
    });

    expect([slept.stopsAt, slept.stop]).toEqual([at(150 * MIN), false]);
  });

  test('a lowered idle time applies at once to the time already idle', () => {
    expect(idleLook({ now, minutes: 5, activeAt: now - 6 * MIN, keptBy: [] }).stop).toBe(true);
  });
});

describe('idleKeepsOf: what keeps a box up', () => {
  test('kept awake: awake first, beside whatever else keeps it', () => {
    expect(idleKeepsOf({ attached: true, sessions: [], carried: false, awake: true })).toEqual([
      'awake',
      'attached',
    ]);
    expect(idleKeepsOf({ attached: false, sessions: [], carried: false, awake: false })).toEqual(
      [],
    );
  });

  test.each<[string, boolean, SessionState[], boolean, IdleKeep[]]>([
    ['nothing on it', false, [], false, []],
    ['someone attached', true, [], false, ['attached']],
    ['a session starting', false, ['starting'], false, ['working']],
    ['a session working', false, ['ended', 'working'], false, ['working']],
    ['a session waiting on you, nobody attached: not kept', false, ['waiting'], false, []],
    ['a launch queued: not kept', false, ['queued'], false, []],
    ['a Factory run on its pull request', false, ['ended'], true, ['pr']],
    ['all of them', true, ['working'], true, ['attached', 'working', 'pr']],
  ])('%s', (_, attached, sessions, carried, keeps) => {
    expect(idleKeepsOf({ attached, sessions, carried })).toEqual(keeps);
  });
});

describe('a session waiting on you (#192): the box sleeps no sooner than box.waitingMinutes after it began to wait', () => {
  const waiting = (ago: number) => ({ since: now - ago, minutes: 120 });

  test.each<[string, number, number | null, string, boolean, boolean]>([
    // [case, last hook (ms before now), began to wait (ms before now), stops at, soon, stop now]
    [
      'no session waits: box.idleMinutes after the last hook',
      31 * MIN,
      null,
      at(-1 * MIN),
      true,
      true,
    ],
    [
      'waiting 31 min, its Stop hook the last: held for 2 h',
      31 * MIN,
      31 * MIN,
      at(89 * MIN),
      false,
      false,
    ],
    [
      'waiting 1 h 54 min: 6 min left, not yet near',
      114 * MIN,
      114 * MIN,
      at(6 * MIN),
      false,
      false,
    ],
    [
      'waiting 1 h 55 min: 5 min left, said as near',
      115 * MIN,
      115 * MIN,
      at(5 * MIN),
      true,
      false,
    ],
    ['waiting 2 h: it sleeps', 120 * MIN, 120 * MIN, at(0), true, true],
    [
      'waiting 10 min after a hook 25 min ago: the later of both',
      25 * MIN,
      10 * MIN,
      at(110 * MIN),
      false,
      false,
    ],
  ])('%s', (_, hookAgo, waitAgo, stopsAt, soon, stop) => {
    const look = idleLook({
      now,
      minutes: 30,
      activeAt: now - hookAgo,
      keptBy: [],
      waiting: { since: waitAgo === null ? null : now - waitAgo, minutes: 120 },
    });

    expect([look.stopsAt, look.soon, look.stop]).toEqual([stopsAt, soon, stop]);
  });

  test('kept up (attached, working) beats waiting: no stop, never near', () => {
    expect(
      idleLook({
        now,
        minutes: 30,
        activeAt: now,
        keptBy: ['attached'],
        waiting: waiting(600 * MIN),
      }),
    ).toMatchObject({ stopsAt: null, soon: false, stop: false, waitingSince: at(-600 * MIN) });
  });

  test('waitingSinceOf: the oldest session waiting on you; working or ended ones do not count', () => {
    expect(
      waitingSinceOf([
        { state: 'working', since: at(-90 * MIN) },
        { state: 'waiting', since: at(-20 * MIN) },
        { state: 'waiting', since: at(-40 * MIN) },
        { state: 'ended', since: at(-300 * MIN) },
      ]),
    ).toBe(now - 40 * MIN);
    expect(waitingSinceOf([{ state: 'working', since: at(0) }])).toBeNull();
  });
});

describe('boxIdleText: what abe status and abe box list say, in local time (#194)', () => {
  const idle = { minutes: 30, activeAt: at(0), stopsAt: at(30 * MIN), keptBy: [] };

  test.each<[string, Parameters<typeof boxIdleText>, string]>([
    ['counting down', [idle], `sleeps at ${localClock(at(30 * MIN))} if still idle (30 min)`],
    [
      'counting down, as of now',
      [idle, { now: now + 18 * MIN }],
      `sleeps at ${localClock(at(30 * MIN))} if still idle (30 min) · in 12 min`,
    ],
    [
      'past its stop time: never a time that has passed',
      [idle, { now: now + 31 * MIN }, 'demo-shop-3'],
      'going to sleep now (idle 30 min) · abe box keep demo-shop-3 keeps it awake',
    ],
    [
      'held for a session waiting on you, near: how to keep it',
      [
        {
          ...idle,
          stopsAt: at(120 * MIN),
          waitingSince: at(0),
          waitingMinutes: 120,
          soon: true,
        },
        { now: now + 116 * MIN },
        'demo-shop-1',
      ],
      `sleeps at ${localClock(at(120 * MIN))} if you have not answered (a session waits on you since ${localClock(at(0))}) · in 4 min · abe box keep demo-shop-1 keeps it awake`,
    ],
    [
      'kept up',
      [{ ...idle, stopsAt: null, keptBy: ['attached', 'working'] }],
      'kept up: attached, a session working (sleeps 30 min after)',
    ],
    [
      'kept by a run',
      [{ minutes: 5, activeAt: at(0), stopsAt: null, keptBy: ['pr'] }],
      'kept up: a Factory run on its pull request (sleeps 5 min after)',
    ],
    [
      'kept awake (#244: kept said once)',
      [{ ...idle, stopsAt: null, keptBy: ['awake'] }],
      'kept awake until abe box sleep (sleeps 30 min after)',
    ],
    [
      'kept awake and attached',
      [{ ...idle, stopsAt: null, keptBy: ['awake', 'attached'] }],
      'kept awake until abe box sleep, also attached (sleeps 30 min after)',
    ],
  ])('%s', (_, args, text) => {
    expect(boxIdleText(...args)).toBe(text);
    expect(text).not.toContain('Z');
  });
});

/** Yours on this Mac (ADR 0030): a box's own, handed to it, read without a checkout. */
const machine = (doc: unknown): LayerSource => ({
  place: 'machine',
  file: '/home/.config/abe/settings.yaml',
  doc,
});
const repo = (doc: unknown): LayerSource => ({
  place: 'repo',
  file: '/repo/abe.yaml',
  doc,
});
const mine = (doc: unknown): LayerSource => ({
  place: 'local',
  file: '/repo/.abe/settings.local.yaml',
  doc,
});

describe('box.waitingMinutes: yours on this Mac (#192)', () => {
  test('core: 2 h; yours shortens it, lengthens it only by an Override', () => {
    expect(coreDefaults()['box.waitingMinutes']).toBe(120);
    expect(mergeSettings([machine({ box: { waitingMinutes: 60 } })]).values).toMatchObject({
      'box.waitingMinutes': 60,
    });
    const raised = mergeSettings([machine({ box: { waitingMinutes: 600 } })]);

    expect(raised.values['box.waitingMinutes']).toBe(120);
    expect(raised.problems.map((p) => p.code)).toEqual(['override-required']);
  });

  test("a repo's files never set it: said, not read", () => {
    const read = mergeSettings([
      repo({ box: { waitingMinutes: 60 } }),
      mine({ box: { waitingMinutes: 30 } }),
    ]);

    expect(read.values['box.waitingMinutes']).toBe(120);
    expect(read.problems.map((p) => [p.code, p.key])).toEqual([
      ['not-in-repo', 'box.waitingMinutes'],
      ['not-in-repo', 'box.waitingMinutes'],
    ]);
  });
});

describe('box.idleMinutes: yours on this Mac', () => {
  test('core: 30 minutes', () => {
    expect(coreDefaults()['box.idleMinutes']).toBe(30);
  });

  test('yours lowers it; raising it takes an Override', () => {
    const lowered = mergeSettings([machine({ box: { idleMinutes: 5 } })]);

    expect(lowered.values['box.idleMinutes']).toBe(5);
    expect(lowered.problems).toEqual([]);
    const raised = mergeSettings([machine({ box: { idleMinutes: 90 } })]);

    expect(raised.values['box.idleMinutes']).toBe(30);
    expect(raised.problems.map((p) => p.code)).toEqual(['override-required']);
    const overridden = mergeSettings([
      machine({ overrides: { 'box.idleMinutes': { value: 90, reason: 'a long build' } } }),
    ]);

    expect(overridden.values['box.idleMinutes']).toBe(90);
    expect(overridden.problems).toEqual([]);
  });

  test("a repo's files never set it: said, not read", () => {
    const read = mergeSettings([
      repo({ box: { idleMinutes: 20 } }),
      mine({ box: { idleMinutes: 5 } }),
    ]);

    expect(read.values['box.idleMinutes']).toBe(30);
    expect(read.problems.map((p) => [p.code, p.key])).toEqual([
      ['not-in-repo', 'box.idleMinutes'],
      ['not-in-repo', 'box.idleMinutes'],
    ]);
  });

  test.each<[string, unknown]>([
    ['zero', 0],
    ['a fraction', 1.5],
    ['words', 'soon'],
    ['over a day', 1441],
  ])('%s is a problem', (_, idleMinutes) => {
    expect(mergeSettings([machine({ box: { idleMinutes } })]).problems).not.toEqual([]);
  });
});
