/**
 * `session list` never waits on a box (#213 C7): in your environment it answers from what each
 * box last said at once and asks them again behind it, each box on its own; what that finds shows
 * in the next read, and a session it finds new or moved on a box not followed is said on the
 * watch (`session.state`, cause `listed`; a followed box's stream says its own). Through a real `serve` in this process with a fake `Boxes` and a fake `BoxLink`
 * (as `cloud-refresh`'s) whose boxes' `session list` answers at once, or not until a test lets it
 * (an ssh that hangs), and whose `watch` stream a test writes lines into.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Box,
  type Boxes,
  type BoxLink,
  type Ran,
  type SessionData,
  SessionListData,
} from '@abe/core';
import { heldEvents, scenario, type ServeScenario, session, tempState, until } from '@abe/testing';
import { z } from 'zod';

const A = 'demo-shop-1';
const B = 'demo-shop-2';
const SINCE = '2026-10-01T09:01:00.000Z';
const LATER = '2026-10-01T09:05:00.000Z';

const boxOf = (name: string, state: Box['state'] = 'running'): Box => {
  const card = Number(name.split('-').at(-1));

  return {
    id: `i-${String(card).padStart(17, '0')}`,
    name,
    owner: 'octocat',
    state,
    size: 'm8g.large',
    zone: 'eu-west-1a',
    privateIp: `10.0.0.${card}`,
    vpc: null,
    subnet: null,
    repo: 'mkdir-swe/demo-shop',
    card,
  };
};

/** Box `name`'s session id: its card's. */
const idOf = (name: string) => `${name.split('-').at(-1) ?? ''}-a1b2`;

const nothing = () => Promise.reject(new Error('not in this test'));

/** The box's `session list --json` answer with its one session in `state` since `since`. */
const listing = (name: string, state: SessionData['state'], since = SINCE): Ran => {
  const card = Number(name.split('-').at(-1));

  return {
    exit: 0,
    stdout: `${JSON.stringify({ ok: true, data: { sessions: [{ ...session(idOf(name), state, card), since }] } })}\n`,
    stderr: '',
  };
};

const worlds: { w: ServeScenario; free: () => void }[] = [];

afterEach(async () => {
  for (const { w, free } of worlds.splice(0)) {
    free();
    await w.close();
  }
});

type Box1 = { now: Ran | undefined; held: ((ran: Ran) => void)[]; line?: (text: string) => void };

/**
 * A Mac's serve with running boxes, each starting as given (`hang`: holding every call). `answer`
 * sets what a box's `session list` says and lets each call it holds answer that; `hang` holds its
 * calls from now on; `stream` writes an event line into its followed `watch`; `down` puts it to
 * sleep on EC2.
 */
const world = async (start: Record<string, SessionData['state'] | 'hang'>) => {
  const boxes = new Map<string, Box1>(
    Object.entries(start).map(([name, s]) => [
      name,
      { now: s === 'hang' ? undefined : listing(name, s), held: [] },
    ]),
  );
  const asleep = new Set<string>();
  const at = (name: string): Box1 => {
    const b = boxes.get(name);

    if (b === undefined) throw new Error(`no box ${name}`);

    return b;
  };
  const link: BoxLink = {
    run: (name, argv) => {
      if (argv.join(' ') !== 'session list --json') return nothing();
      const b = at(name);

      if (b.now !== undefined) return Promise.resolve(b.now);

      return new Promise<Ran>((resolve) => b.held.push(resolve));
    },
    follow: (name, _argv, onLine) => {
      at(name).line = onLine;

      return { stop: () => undefined, ended: new Promise<number>(() => undefined) };
    },
    attach: () => [],
    forward: nothing,
  };
  const all = () => [...boxes.keys()].map((n) => boxOf(n, asleep.has(n) ? 'stopped' : 'running'));
  const ec2: Boxes = {
    list: () => Promise.resolve({ ok: true, data: all() }),
    status: (name) =>
      Promise.resolve({ ok: true, data: all().find((b) => b.name === name) ?? null }),
    up: nothing,
    start: nothing,
    stop: nothing,
    resize: nothing,
    terminate: nothing,
  };
  const state = tempState();

  // your environment, set (ADR 0042: this Mac is the default)
  mkdirSync(join(state.dir, '.config', 'abe'), { recursive: true });
  writeFileSync(join(state.dir, '.config', 'abe', 'settings.yaml'), 'serve.target: cloud\n');
  const w = await scenario({
    state,
    cloud: { boxes: ec2, link, self: ['abe'], sleep: (ms) => Bun.sleep(ms) },
  });
  const answer = (name: string, s: SessionData['state'], since = SINCE) => {
    const b = at(name);

    b.now = listing(name, s, since);
    for (const resolve of b.held.splice(0)) resolve(listing(name, s, since));
  };
  let seq = 0;

  worlds.push({
    w,
    free: () => {
      for (const name of boxes.keys()) answer(name, 'ended');
    },
  });

  return {
    w,
    answer,
    /** Its next call answers `s`, the calls held now still held. */
    next: (name: string, s: SessionData['state'], since = SINCE) => {
      at(name).now = listing(name, s, since);
    },
    hang: (name: string) => {
      at(name).now = undefined;
    },
    held: (name: string) => at(name).held.length,
    stream: (name: string, s: SessionData['state'], since: string) => {
      seq += 1;
      const card = Number(name.split('-').at(-1));

      at(name).line?.(
        JSON.stringify({
          seq,
          at: since,
          type: 'session.state',
          data: { id: idOf(name), card, state: s, since, cause: 'Stop' },
        }),
      );
    },
    down: (name: string) => {
      asleep.add(name);
    },
  };
};

/** `session list --json` and how long it took, in ms. */
const listed = async (w: ServeScenario) => {
  const t0 = performance.now();
  const reply = await w.request('session', 'list', '--json');
  const took = performance.now() - t0;
  const doc = z
    .object({ ok: z.literal(true), data: SessionListData })
    .parse(JSON.parse(reply.stdout));

  return {
    rows: doc.data.sessions.map((s) => [s.box, s.state]),
    boxes: doc.data.boxes,
    took,
  };
};

const Moved = z.object({ id: z.string(), state: z.string(), cause: z.string() });

/** The `session.state` events a box's list said (cause `listed`): `[box, state]`. */
const pushed = async (w: ServeScenario) =>
  (await heldEvents(w.state.socket)).flatMap((e) => {
    if (e.type !== 'session.state') return [];
    const d = Moved.parse(e.data);

    return d.cause === 'listed' ? [[e.box, d.state]] : [];
  });

const pushedOnce = (w: ServeScenario) =>
  until('a list pushed', async () => {
    const got = await pushed(w);

    return got.length > 0 ? got : undefined;
  });

test("a box whose ssh hangs: session list answers at once with its last rows, then the box's new state", async () => {
  const f = await world({ [A]: 'working' });

  expect((await listed(f.w)).rows).toEqual([[A, 'working']]);
  // Its ssh hangs from now on: the list does not wait on it.
  f.hang(A);
  const again = await listed(f.w);

  expect(again.took).toBeLessThan(250);
  expect(again.rows).toEqual([[A, 'working']]);
  expect(f.held(A)).toBe(1);
  // Read again while that ask is out: answered at once, the box not asked twice.
  expect((await listed(f.w)).rows).toEqual([[A, 'working']]);
  expect(f.held(A)).toBe(1);

  // The box answers at last, its session waiting: in the next read (its stream says it itself).
  f.answer(A, 'waiting', LATER);
  await until('the answer held', async () =>
    JSON.stringify((await listed(f.w)).rows).includes('waiting') ? true : undefined,
  );
  expect((await listed(f.w)).rows).toEqual([[A, 'waiting']]);
  expect(await pushed(f.w)).toEqual([]);
});

test('a box followed for nothing: a session it now holds open is said on the watch as found', async () => {
  const f = await world({ [A]: 'ended' });

  expect((await listed(f.w)).rows).toEqual([[A, 'ended']]);
  f.next(A, 'working', LATER);
  await listed(f.w);
  expect(await pushedOnce(f.w)).toEqual([[A, 'working']]);
  expect((await listed(f.w)).rows).toEqual([[A, 'working']]);
});

test('the first list, nothing heard from a box that hangs: answered within a second, its rows once it answers', async () => {
  const f = await world({ [A]: 'hang' });
  const first = await listed(f.w);

  expect(first.took).toBeLessThan(1000);
  expect(first.rows).toEqual([]);
  expect(first.boxes).toContain('your boxes are being asked');

  f.answer(A, 'working');
  // Said on the watch as found: a session the list did not have.
  expect(await pushedOnce(f.w)).toEqual([[A, 'working']]);
  const next = await listed(f.w);

  expect(next.rows).toEqual([[A, 'working']]);
  expect(next.boxes).toBeUndefined();
});

test('one box hanging holds back no other: the other is asked again and its move shows', async () => {
  const f = await world({ [A]: 'working', [B]: 'working' });

  expect((await listed(f.w)).rows).toEqual([
    [A, 'working'],
    [B, 'working'],
  ]);
  f.hang(A);
  await listed(f.w);
  f.next(B, 'waiting', LATER);
  await listed(f.w);
  const rows = await until('B moved', async () => {
    const got = (await listed(f.w)).rows;

    return JSON.stringify(got).includes('waiting') ? got : undefined;
  });

  expect(rows).toEqual([
    [A, 'working'],
    [B, 'waiting'],
  ]);
  expect(f.held(A)).toBe(1);
});

test("a box's stream moving its session while an older answer is out: the older answer never undoes it", async () => {
  const f = await world({ [A]: 'working' });

  await listed(f.w);
  f.hang(A);
  await listed(f.w);
  // Its stream says waiting; then the ask out answers what the box said before that.
  f.stream(A, 'waiting', LATER);
  await until('the stream merged', async () =>
    JSON.stringify((await listed(f.w)).rows).includes('waiting') ? true : undefined,
  );
  f.answer(A, 'working', SINCE);
  await Bun.sleep(100);
  expect((await listed(f.w)).rows).toEqual([[A, 'waiting']]);
  expect(await pushed(f.w)).toEqual([]);
});

test('a box gone to sleep: its rows go with it, and a fan-out that finds what the list said pushes nothing', async () => {
  const f = await world({ [A]: 'working', [B]: 'ended' });

  await listed(f.w);
  await listed(f.w);
  expect(await pushed(f.w)).toEqual([]);
  f.down(A);
  const rows = await until('A let go of', async () => {
    const got = (await listed(f.w)).rows;

    return got.length === 1 ? got : undefined;
  });

  expect(rows).toEqual([[B, 'ended']]);
});
