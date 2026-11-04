/**
 * The Mac's runs on your boxes read in one go (#327): `runs` asks every running box holding a run
 * of ours for its `factory status` at once (at most 8 at a time), each on its own timeout, through
 * `startCloud` with a fake `Boxes` and a fake `BoxLink` whose boxes answer after different times
 * (one never). The read takes about the slowest answer within the timeout, not their sum; a box
 * that does not answer keeps its runs as last heard, the others' show as they answered.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Box, type BoxLink, type FactoryRunData, pendingRunData, type Ran } from '@abe/core';
import { writeCloudRecord } from '@abe/ports';
import { fakeClock } from '@abe/testing';
import { type BoxFront } from './boxes';
import { startCloud } from './cloud';

const REPO = 'mkdir-swe/demo-shop';
const AT = new Date(0).toISOString();
const NEVER = Number.POSITIVE_INFINITY;

const boxOf = (card: number): Box => ({
  id: `i-${String(card).padStart(17, '0')}`,
  name: `demo-shop-${card}`,
  owner: 'octocat',
  state: 'running',
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: `10.0.0.${card}`,
  vpc: null,
  subnet: null,
  repo: REPO,
  card,
});

/** Card `card`'s run as this Mac last heard it: at Decide. */
const heard = (card: number): FactoryRunData =>
  pendingRunData({
    session: `${card}-a1b2`,
    card,
    title: `Card ${card}`,
    repo: REPO,
    worktree: `/w/${card}`,
    at: AT,
    queued: false,
  });

/** Its box's answer now: moved on to Build. */
const moved = (card: number): FactoryRunData => ({ ...heard(card), stage: 'build' });

/** A Factory run of ours on card `card`'s box, its session over, its run carried there. */
const record = (card: number) => ({
  v: 1,
  id: `${card}-a1b2`,
  card,
  kind: 'card',
  title: `Card ${card}`,
  repo: REPO,
  worktree: `/w/${card}`,
  branch: `card/${card}`,
  box: `demo-shop-${card}`,
  state: 'ended',
  since: AT,
  startedAt: AT,
  transcriptPath: null,
  lastAssistantMessage: null,
  models: { coordinator: 'sonnet', reader: 'sonnet', writer: 'sonnet' },
  description: '',
  factory: true,
  run: heard(card),
});

const nothing = () => Promise.reject(new Error('not in this test'));

/** A `BoxFront` the refresh only keeps and lets go of boxes on. */
const front: BoxFront = {
  off: () => false,
  busy: () => 0,
  list: nothing,
  status: nothing,
  up: nothing,
  start: nothing,
  stop: nothing,
  keepAwake: nothing,
  terminate: nothing,
  wake: nothing,
  made: nothing,
  said: () => undefined,
  booting: (_, wait) => wait(),
  runs: () => Promise.resolve(true),
  stoppedHere: () => false,
  forward: nothing,
  sessions: nothing,
  discover: () => Promise.resolve(),
  keep: () => undefined,
  release: () => undefined,
  onEvent: () => undefined,
  close: () => undefined,
};

const dirs: string[] = [];
const clouds: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const c of clouds.splice(0)) await c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Your boxes, one per card, each answering `factory status` after its time in `ms` (`NEVER`:
 * no answer at all); `asked` counts each box's asks, `most` the most out at once, `argvs` what
 * each was asked.
 */
const world = (ms: Record<number, number>, statusTimeoutMs: number) => {
  const state = mkdtempSync(join(tmpdir(), 'abe-cr-'));
  const cards = Object.keys(ms).map(Number);
  const asked = new Map<string, number>();
  const argvs: string[][] = [];
  let out = 0;
  let most = 0;

  dirs.push(state);
  mkdirSync(join(state, 'cloud'));
  for (const card of cards) writeCloudRecord(state, `${card}-a1b2`, record(card));
  const link: BoxLink = {
    run: async (box, argv) => {
      argvs.push([...argv]);
      const card = Number(box.split('-').at(-1));
      const wait = ms[card] ?? NEVER;

      asked.set(box, (asked.get(box) ?? 0) + 1);
      out += 1;
      most = Math.max(most, out);
      if (wait === NEVER) return new Promise<Ran>(() => undefined);
      await Bun.sleep(wait);
      out -= 1;

      return {
        exit: 0,
        stdout: `${JSON.stringify({ ok: true, data: { runs: [moved(card)] } })}\n`,
        stderr: '',
      };
    },
    follow: () => ({ stop: () => undefined, ended: new Promise<number>(() => undefined) }),
    attach: () => [],
    forward: nothing,
  };
  const all = cards.map(boxOf);
  const cloud = startCloud({
    stateDir: state,
    boxes: {
      list: () => Promise.resolve({ ok: true, data: all }),
      status: nothing,
      up: nothing,
      start: nothing,
      stop: nothing,
      resize: nothing,
      terminate: nothing,
    },
    limitAt: () => 3,
    link,
    self: ['abe'],
    clock: fakeClock(),
    sleep: (n) => Bun.sleep(n),
    emit: () => undefined,
    front,
    mover: {
      reach: nothing,
      diff: nothing,
      list: nothing,
      pack: nothing,
      unpack: nothing,
      put: nothing,
      get: nothing,
      worktree: nothing,
      dropWorktree: nothing,
    },
    statusTimeoutMs,
  });

  clouds.push(cloud);

  return { cloud, asked, argvs, most: () => most };
};

/** `f`'s answer and how long it took, in ms. */
const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await f();

  return [v, performance.now() - t0];
};

const stages = (runs: readonly FactoryRunData[]) =>
  Object.fromEntries(runs.map((r) => [r.card, r.stage]));

test('the boxes are asked at once: the read takes the slowest answer, not their sum', async () => {
  const w = world({ 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600, 7: 700 }, 2000);
  const [runs, took] = await timed(() => w.cloud.runs());

  // In series it was 2800 ms.
  expect(took).toBeGreaterThanOrEqual(690);
  expect(took).toBeLessThan(1200);
  expect(stages(runs)).toEqual({
    1: 'build',
    2: 'build',
    3: 'build',
    4: 'build',
    5: 'build',
    6: 'build',
    7: 'build',
  });
  console.log(`7 boxes, 100–700 ms each: ${Math.round(took)} ms`);
});

test('a box that never answers holds the read only its timeout; its run reads as last heard', async () => {
  const w = world({ 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600, 7: NEVER }, 1000);
  const [runs, took] = await timed(() => w.cloud.runs());

  expect(took).toBeGreaterThanOrEqual(990);
  expect(took).toBeLessThan(1500);
  expect(stages(runs)).toEqual({
    1: 'build',
    2: 'build',
    3: 'build',
    4: 'build',
    5: 'build',
    6: 'build',
    7: 'spec',
  });
  console.log(`6 boxes 100–600 ms, 1 silent, 1 s timeout: ${Math.round(took)} ms`);

  expect(new Set(w.argvs.map((a) => a.join(' ')))).toEqual(new Set(['factory status --json']));
});

test("a silent box's ask is joined, not repeated, and asked anew once it is long out", async () => {
  const w = world({ 1: 20, 2: NEVER }, 100);
  const [first, took] = await timed(() => w.cloud.runs());

  expect(took).toBeGreaterThanOrEqual(90);
  expect(stages(first)).toEqual({ 1: 'build', 2: 'spec' });

  // Read again at once: its ask is still out and past its timeout, so the read does not wait on it.
  const [again, took2] = await timed(() => w.cloud.runs());

  expect(took2).toBeLessThan(80);
  expect(w.asked.get('demo-shop-2')).toBe(1);
  expect(w.asked.get('demo-shop-1')).toBe(2);
  expect(stages(again)).toEqual({ 1: 'build', 2: 'spec' });

  // Eight timeouts on, it is given up on: the box is asked anew.
  await Bun.sleep(800);
  const [later, took3] = await timed(() => w.cloud.runs());

  expect(took3).toBeGreaterThanOrEqual(90);
  expect(w.asked.get('demo-shop-2')).toBe(2);
  expect(stages(later)[2]).toBe('spec');
});

test('a box answering after its timeout is asked again by the next read', async () => {
  const w = world({ 1: 300 }, 100);
  const [first] = await timed(() => w.cloud.runs());

  expect(stages(first)).toEqual({ 1: 'spec' });
  // Its late answer came; the next read asks it again and waits for it anew.
  await Bun.sleep(300);
  await w.cloud.runs();
  expect(w.asked.get('demo-shop-1')).toBe(2);
});

test('at most 8 boxes are asked at once', async () => {
  const ms = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 200]));
  const w = world(ms, 2000);
  const [runs, took] = await timed(() => w.cloud.runs());

  expect(w.most()).toBe(8);
  expect(runs.every((r) => r.stage === 'build')).toBe(true);
  // Two rounds of 200 ms, not twelve.
  expect(took).toBeGreaterThanOrEqual(390);
  expect(took).toBeLessThan(900);
  console.log(`12 boxes, 200 ms each, 8 at once: ${Math.round(took)} ms`);
});
