/**
 * A box stops itself when idle (#92): the idle stop on a fake clock with a fake box host, and a
 * box's real `serve` (fake ports) whose `abe status` says when it stops and whose `abe watch`
 * streams `box.state` `stopping` before it shuts the box down.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  type BoxHost,
  type BoxKeepData,
  type EventData,
  EventLine,
  type IdleKeep,
  readEnvelope,
  type Reply,
  localClock,
  StatusData,
} from '@abe/core';
import { cli, type Cli, fakeClock, scenario, T0 } from '@abe/testing';
import { startIdleStop } from './idle';

const MIN = 60_000;
const BOX = 'demo-shop-101';

type FakeHost = BoxHost & { shutdowns: number; terminal: boolean };

const fakeHost = (answer: Answered<null> = { ok: true, data: null }): FakeHost => {
  const host: FakeHost = {
    shutdowns: 0,
    terminal: false,
    shutdown: () => {
      host.shutdowns += 1;

      return Promise.resolve(answer);
    },
    attached: () => Promise.resolve(host.terminal),
  };

  return host;
};

const world = (
  o: {
    minutes?: number;
    waitingMinutes?: number;
    host?: FakeHost;
    keep?: { file: string; boot: string | null };
    clock?: ReturnType<typeof fakeClock>;
  } = {},
) => {
  const clock = o.clock ?? fakeClock();
  const idles: BoxKeepData[] = [];
  const host = o.host ?? fakeHost();
  const said: string[] = [];
  const order: string[] = [];
  const keeps: { now: IdleKeep[] } = { now: [] };
  const waiting: { since: number | null } = { since: null };
  const minutes = { now: o.minutes ?? 30 };
  const idle = startIdleStop({
    name: BOX,
    clock,
    everyMs: 3_600_000,
    minutes: () => minutes.now,
    waitingMinutes: () => o.waitingMinutes ?? 120,
    keeps: () => Promise.resolve({ keptBy: keeps.now, waitingSince: waiting.since }),
    host: {
      ...host,
      shutdown: () => {
        order.push('shutdown');

        return host.shutdown();
      },
    },
    emit: (d: EventData<'box.state'>) => {
      order.push(`${d.box} ${d.state} (${d.cause})`);
    },
    log: (m) => said.push(m),
    ...(o.keep === undefined ? {} : { keep: o.keep }),
    said: (d) => idles.push(d),
  });

  return { clock, host, said, order, keeps, waiting, minutes, idle, idles };
};

const worlds: { idle: { stop: () => void } }[] = [];
const made = (o: Parameters<typeof world>[0] = {}) => {
  const w = world(o);

  worlds.push(w);

  return w;
};

afterEach(() => {
  for (const w of worlds.splice(0)) w.idle.stop();
});

describe('the idle stop', () => {
  test('nothing for box.idleMinutes: box.state stopping, then the box is shut down', async () => {
    const w = made();

    w.clock.tick(29 * MIN);
    await w.idle.tick();
    expect(w.order).toEqual([]);
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    expect(w.order).toEqual([`${BOX} stopping (idle)`, 'shutdown']);
    expect(w.said).toEqual([`${BOX}: idle for 30 min, shutting down`]);
    // Once under way, never again.
    w.clock.tick(60 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
  });

  test('a hook starts the idle time again', async () => {
    const w = made();

    w.clock.tick(20 * MIN);
    w.idle.heard();
    w.clock.tick(29 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    expect(w.idle.look().stopsAt).toBe(new Date(T0 + 50 * MIN).toISOString());
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
  });

  test('attached or a session working keeps it up; the idle time counts from when it ends', async () => {
    const w = made();

    w.keeps.now = ['attached'];
    w.clock.tick(40 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    expect(w.idle.look()).toMatchObject({ stopsAt: null, keptBy: ['attached'] });
    w.keeps.now = ['working'];
    w.clock.tick(40 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    w.keeps.now = [];
    w.clock.tick(29 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
  });

  test('a session waiting on you holds the box box.waitingMinutes after it began to wait, and says so 5 min before (#192)', async () => {
    const w = made({ waitingMinutes: 120 });
    const said = () =>
      w.idles.map((d) => `${d.idle.stopsAt ?? '-'}${d.idle.soon === true ? ' soon' : ''}`);

    // Its question came with the Stop hook: the last activity, and since then it waits on you.
    w.waiting.since = T0;
    w.clock.tick(31 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    expect(w.idle.look()).toMatchObject({
      stopsAt: new Date(T0 + 120 * MIN).toISOString(),
      waitingSince: new Date(T0).toISOString(),
      soon: false,
    });
    w.clock.tick(83 * MIN);
    await w.idle.tick();
    expect(w.idles.some((d) => d.idle.soon === true)).toBe(false);
    // 5 min before: said once as near, with how long it waited.
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    await w.idle.tick();
    expect(said().filter((x) => x.endsWith('soon'))).toEqual([
      `${new Date(T0 + 120 * MIN).toISOString()} soon`,
    ]);
    expect(w.order).toEqual([]);
    w.clock.tick(5 * MIN);
    await w.idle.tick();
    expect(w.order).toEqual([`${BOX} stopping (idle)`, 'shutdown']);
  });

  test('the person answers: the wait is over, so is its hold', async () => {
    const w = made({ waitingMinutes: 120 });

    w.waiting.since = T0;
    w.clock.tick(60 * MIN);
    await w.idle.tick();
    // The answer runs the session: a hook, then working, then waiting again with a new question.
    w.idle.heard();
    w.keeps.now = ['working'];
    await w.idle.tick();
    w.keeps.now = [];
    w.waiting.since = T0 + 60 * MIN;
    await w.idle.tick();
    expect(w.idle.look().stopsAt).toBe(new Date(T0 + 180 * MIN).toISOString());
  });

  test('a lowered box.waitingMinutes, never under box.idleMinutes after the last hook', async () => {
    const w = made({ waitingMinutes: 10 });

    w.waiting.since = T0;
    await w.idle.tick();
    expect(w.idle.look().stopsAt).toBe(new Date(T0 + 30 * MIN).toISOString());
  });

  test('box.idleMinutes is read on every look: lowered, it stops sooner', async () => {
    const w = made();

    w.clock.tick(3 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    w.minutes.now = 2;
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
  });

  test('a look that cannot read what keeps it up stops nothing', async () => {
    const w = made();

    w.clock.tick(40 * MIN);
    const failing = startIdleStop({
      name: BOX,
      clock: w.clock,
      everyMs: 3_600_000,
      minutes: () => 30,
      keeps: () => Promise.reject(new Error('session list: docker is not answering')),
      host: w.host,
      emit: () => undefined,
      log: (m) => w.said.push(m),
    });

    worlds.push({ idle: failing });
    w.clock.tick(40 * MIN);
    await failing.tick();
    expect(w.host.shutdowns).toBe(0);
    expect(w.said).toEqual([`${BOX}: idle look skipped: session list: docker is not answering`]);
  });

  test('a shutdown that fails is said, and tried again after another idle time', async () => {
    const w = made({ host: fakeHost({ ok: false, error: { code: 'sudo', message: 'no' } }) });

    w.clock.tick(30 * MIN);
    await w.idle.tick();
    expect(w.order).toEqual([
      `${BOX} stopping (idle)`,
      'shutdown',
      `${BOX} running (shutdown-failed)`,
    ]);
    expect(w.said.at(-1)).toBe(`${BOX}: shutdown failed: sudo: no`);
    w.clock.tick(29 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(2);
  });
});

describe('kept awake (#104)', () => {
  const dirs: string[] = [];
  const keepFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'keep-'));

    dirs.push(dir);

    return join(dir, 'box-keep.json');
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('keep: kept awake at once, never stopped however long; sleep: the idle time counts from then', async () => {
    const w = made();

    expect(w.idle.keep(true)).toMatchObject({ stopsAt: null, keptBy: ['awake'] });
    w.clock.tick(300 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    expect(w.idle.look()).toMatchObject({ stopsAt: null, keptBy: ['awake'] });
    // Beside what else keeps it: awake first.
    w.keeps.now = ['attached'];
    await w.idle.tick();
    expect(w.idle.look().keptBy).toEqual(['awake', 'attached']);
    w.keeps.now = [];
    await w.idle.tick();
    w.clock.tick(5 * MIN);
    expect(w.idle.keep(false)).toMatchObject({
      stopsAt: new Date(T0 + 335 * MIN).toISOString(),
      keptBy: [],
    });
    w.clock.tick(29 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(0);
    w.clock.tick(1 * MIN);
    await w.idle.tick();
    expect(w.host.shutdowns).toBe(1);
  });

  test('box.idle is said when stopsAt or keptBy changes, never for a look that changes neither', async () => {
    const w = made();
    const words = () => w.idles.map((d) => `${d.box} ${d.idle.stopsAt ?? d.idle.keptBy.join('+')}`);

    await w.idle.tick();
    expect(words()).toEqual([]);
    w.idle.keep(true);
    await w.idle.tick();
    expect(words()).toEqual([`${BOX} awake`]);
    w.keeps.now = ['attached'];
    await w.idle.tick();
    await w.idle.tick();
    expect(words()).toEqual([`${BOX} awake`, `${BOX} awake+attached`]);
    w.keeps.now = [];
    await w.idle.tick();
    w.idle.keep(false);
    expect(words().slice(2)).toEqual([
      `${BOX} awake`,
      `${BOX} ${new Date(T0 + 30 * MIN).toISOString()}`,
    ]);
    // A hook moves stopsAt: said on the next look.
    w.clock.tick(10 * MIN);
    w.idle.heard();
    await w.idle.tick();
    expect(words().at(-1)).toBe(`${BOX} ${new Date(T0 + 40 * MIN).toISOString()}`);
    expect(w.idles).toHaveLength(5);
  });

  test("kept in the box's state file: a serve started again keeps it; a new boot (stopped, woken) does not", async () => {
    const file = keepFile();
    const first = made({ keep: { file, boot: 'boot-1' } });

    first.idle.keep(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ awake: true, boot: 'boot-1' });
    first.idle.stop();
    const again = made({ keep: { file, boot: 'boot-1' } });

    expect(again.idle.look().keptBy).toEqual(['awake']);
    again.clock.tick(300 * MIN);
    await again.idle.tick();
    expect(again.host.shutdowns).toBe(0);
    again.idle.stop();
    const woken = made({ keep: { file, boot: 'boot-2' } });

    expect(woken.idle.look()).toMatchObject({ keptBy: [] });
    // Let sleep is kept too.
    const slept = made({ keep: { file, boot: 'boot-1' } });

    slept.idle.keep(false);
    expect(made({ keep: { file, boot: 'boot-1' } }).idle.look().keptBy).toEqual([]);
  });
});

const status = (reply: Reply): StatusData => {
  const doc = readEnvelope(StatusData, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const clis: Cli[] = [];

afterEach(async () => {
  await Promise.all(clis.splice(0).map((c) => c.close()));
});

describe("a box's serve", () => {
  test('abe status says when it stops; lowered by an Override it stops itself', async () => {
    const host = fakeHost();
    const clock = fakeClock();

    await using s = await scenario({ box: true, clock, idle: { name: BOX, host, everyMs: 20 } });

    const idle = status(await s.request('status', '--json')).idle;

    expect(idle).toEqual({
      minutes: 30,
      activeAt: new Date(T0).toISOString(),
      stopsAt: new Date(T0 + 30 * MIN).toISOString(),
      keptBy: [],
      waitingSince: null,
      waitingMinutes: 120,
      soon: false,
    });
    expect((await s.request('status')).stdout).toContain(
      `idle stop   sleeps at ${localClock(T0 + 30 * MIN)} if still idle (30 min) · in 30 min`,
    );
    // Someone on the box: kept up however long.
    host.terminal = true;
    clock.tick(60 * MIN);
    for (let i = 0; i < 200; i += 1) {
      const kept = status(await s.request('status', '--json')).idle?.keptBy ?? [];

      if (kept.includes('attached')) break;
      await Bun.sleep(10);
    }
    expect(status(await s.request('status', '--json')).idle).toMatchObject({
      stopsAt: null,
      keptBy: ['attached'],
    });
    expect(host.shutdowns).toBe(0);
    host.terminal = false;
    const mine = cli({ env: { ABE_SOCKET: s.state.socket } });

    clis.push(mine);
    const w = mine.spawn('watch', '--json', '--since', '0', '--no-start');
    // yours on this Mac, the box's own (ADR 0030): read in its home, no checkout there
    const set = await s.request(
      'settings',
      'set',
      'box.idleMinutes',
      '2',
      '--override',
      '--reason',
      'checking the idle stop',
      '--json',
    );

    expect(set.exit).toBe(0);
    clock.tick(2 * MIN);
    for (;;) {
      const e = EventLine.parse(JSON.parse(await w.next()));

      if (e.type !== 'box.state') continue;
      expect(e.data).toEqual({ box: BOX, state: 'stopping', cause: 'idle' });
      break;
    }
    for (let i = 0; i < 100 && host.shutdowns === 0; i += 1) await Bun.sleep(10);
    expect(host.shutdowns).toBe(1);
  });

  test('a Mac serve (no box) has no idle stop', async () => {
    await using s = await scenario({});

    expect(status(await s.request('status', '--json')).idle).toBeUndefined();
  });
});
