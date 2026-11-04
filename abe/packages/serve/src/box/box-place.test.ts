/**
 * `abe box place` (#57): the Mac's serve in this test as `abe serve` builds it (`macServed`; one
 * contract test through the real `abe`, `cli()`), its boxes on the fake EC2 (a fake `aws`, reached
 * by the real `ec2Boxes` port as the person) and a fake ssh-like link (`ABE_BOX_LINK=exec:…`) whose
 * every box's `abe serve` answers `status`. Commands are typed in the checkout `shop`; yours for it
 * (`.abe/settings.local.yaml`) sets `limits.maxBoxesPerPerson`, and a test changes it there as the
 * person would.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoxData, BoxPlaceData, boxName, EventLine, type StatusData } from '@abe/core';
import {
  cli,
  type Cli,
  fakeEc2,
  type FakeEc2,
  fakeTool,
  type FakeTool,
  git,
  macServed,
  type ServedCli,
  type Watching,
} from '@abe/testing';
import { z } from 'zod';

// Boxes made and woken, each aws call a process: seconds, not the default 5.
setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const BOX = boxName(REPO);

const STATUS: StatusData = {
  version: '2.0.0-test',
  pid: 4242,
  startedAt: '2026-10-23T09:00:00.000Z',
  socket: '/run/abe/serve.sock',
  sessions: 0,
  workspaces: 0,
};

/** The Mac: its serve in this test (`macServed`), or the real `abe` for the command's contract. */
type Mac = Pick<Cli, 'state' | 'run' | 'json' | 'close'> & Partial<Pick<ServedCli, 'watch'>>;

type World = { root: string; ec2: FakeEc2; link: FakeTool; mac: Mac };

/** Yours for the checkout `shop`: its `.abe/settings.local.yaml`. */
const local = (root: string, text: string) => {
  writeFileSync(join(root, 'shop', '.abe', 'settings.local.yaml'), text);
};

const limitOf = (root: string, limit: number) => {
  local(root, `limits.maxBoxesPerPerson: ${limit}\n`);
};

const world = async (limit: number, listLagMs = 0, real = false): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-p-'));
  const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300, listLagMs });
  const link = fakeTool('box-ssh', { stderr: 'ssh: no route to box', exit: 255 }, [
    ["'status' '--json'", { json: { ok: true, data: STATUS } }],
  ]);

  const shop = join(root, 'shop');

  for (const dir of ['mine', 'shop/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
  git(shop, 'init', '-q', '-b', 'main');
  writeFileSync(join(shop, 'abe.yaml'), 'environments: {}\n');
  // yours for the shop, never committed
  writeFileSync(join(shop, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  limitOf(root, limit);
  const env = {
    PATH: `${ec2.dir}:${link.dir}:/usr/bin:/bin`,
    ABE_CONFIG_DIR: join(root, 'mine'),
    ABE_OWNER: ec2.owner,
    ABE_BOX_LINK: `exec:${join(link.dir, 'box-ssh')}`,
    ABE_CLOUD_POLL_MS: '100',
  };
  const mac = real ? cli({ env, cwd: shop }) : await macServed(env, { cwd: shop });

  return { root, ec2, link, mac };
};

const done = async (w: World) => {
  await w.mac.close();
  w.ec2.remove();
  w.link.remove();
  rmSync(w.root, { recursive: true, force: true });
};

/** The Mac's watch (its serve in this test). */
const watchOf = (w: World) => {
  if (w.mac.watch === undefined) throw new Error('watch: the local machine in this test only');

  return w.mac.watch;
};

const place = (w: World, card: number, ...flags: string[]) =>
  w.mac.json(BoxPlaceData, 'box', 'place', String(card), '--repo', REPO, ...flags);

/** Another repo: its own box (ADR 0022: a box per repo). */
const other = (n: number) => `mkdir-swe/basket-${n}`;

/** `abe box place` of a card of another repo. */
const placeIn = (w: World, card: number, repo: string, ...flags: string[]) =>
  w.mac.json(BoxPlaceData, 'box', 'place', String(card), '--repo', repo, ...flags);

/** Every box made on the fake EC2 so far (`run-instances`). */
const made = (w: World) => w.ec2.calls().filter((c) => c.startsWith('ec2 run-instances')).length;

/** How many times EC2's instances were read so far (the queue reads them each look). */
const describes = (w: { ec2: { calls: () => string[] } }) =>
  w.ec2.calls().filter((c) => c.includes('describe-instances')).length;

const live = (w: World) =>
  w.ec2
    .instances()
    .filter((i) => i.State !== 'terminated')
    .map((i) => [i.Tags.find((t) => t.Key === 'abe:box')?.Value ?? '', i.State]);

const BoxEvent = z.object({
  type: z.literal('box.state'),
  data: z.object({ box: z.string(), state: z.string(), cause: z.string() }),
});

/** `[box, state, cause]` of each `box.state` on the watch until `last` says stop. */
const boxStates = async (s: Watching, last: (state: string) => boolean) => {
  const seen: [string, string, string][] = [];

  for (;;) {
    const e = BoxEvent.safeParse(EventLine.parse(JSON.parse(await s.next(15_000))));

    if (!e.success) continue;
    seen.push([e.data.data.box, e.data.data.state, e.data.data.cause]);
    if (last(e.data.data.state)) return seen;
  }
};

describe('abe box place: use, wake, create, Queued at the limit', () => {
  test('without --apply it only answers: create, nothing made', async () => {
    const w = await world(2);

    try {
      const out = await place(w, 4);

      expect(out.doc).toEqual({
        ok: true,
        data: { box: BOX, action: 'create', applied: false, boxes: 0, limit: 2 },
      });
      expect(made(w)).toBe(0);
    } finally {
      await done(w);
    }
  });

  test("its box running is used, by another card of the repo too; another repo's card is Queued at the limit; a stopped box not counted", async () => {
    const w = await world(2);

    w.ec2.put({ name: BOX, repo: REPO });
    w.ec2.put({ name: 'other-8', repo: 'mkdir-swe/other-8' });
    w.ec2.put({ name: 'other-9', repo: 'mkdir-swe/other-9', state: 'stopped' });
    try {
      expect((await place(w, 4, '--apply')).doc).toMatchObject({
        ok: true,
        data: { box: BOX, action: 'use', boxes: 2 },
      });
      // ADR 0022: one box per repo, a workspace per card on it.
      expect((await place(w, 5)).doc).toMatchObject({
        ok: true,
        data: { box: BOX, action: 'use', boxes: 2 },
      });
      expect((await placeIn(w, 6, other(6))).doc).toMatchObject({
        ok: true,
        data: { box: boxName(other(6)), action: 'queue', boxes: 2, limit: 2 },
      });
      expect(made(w)).toBe(0);
    } finally {
      await done(w);
    }
  });

  test('--apply wakes its sleeping box, which counts once it starts: box.state starting, then running', async () => {
    const w = await world(1);

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    try {
      await w.mac.run('status');
      const watch = watchOf(w)('--json');
      const out = await place(w, 4, '--apply');

      expect(out.doc).toMatchObject({ ok: true, data: { box: BOX, action: 'wake', boxes: 0 } });
      expect(await boxStates(watch, (s) => s === 'running')).toEqual([
        [BOX, 'starting', 'start'],
        [BOX, 'running', 'start'],
      ]);
      watch.close();
      expect(live(w)).toEqual([[BOX, 'running']]);
      expect(made(w)).toBe(0);
      // Awake, it counts: another repo's card is Queued at the limit of 1.
      expect((await placeIn(w, 5, other(5))).doc).toMatchObject({
        data: { action: 'queue', boxes: 1 },
      });
    } finally {
      await done(w);
    }
  });

  test('two wakes at once at a limit of 1: one woken, the other Queued (a wake counts from its decision)', async () => {
    const w = await world(1);
    const five = boxName(other(5));

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    w.ec2.put({ name: five, repo: other(5), state: 'stopped' });
    try {
      await w.mac.run('status');
      const answers = await Promise.all([
        place(w, 4, '--apply'),
        placeIn(w, 5, other(5), '--apply'),
      ]);

      expect(
        answers.map((a) => (a.doc.ok ? a.doc.data.action : a.doc.error.code)).toSorted(),
      ).toEqual(['queue', 'wake']);
      expect(live(w).filter(([, state]) => state === 'running')).toHaveLength(1);
    } finally {
      await done(w);
    }
  });

  test('--apply on its box still stopping waits for the stop, then wakes it', async () => {
    const w = await world(1);

    w.ec2.put({ name: BOX, repo: REPO });
    w.ec2.set(BOX, 'stopping');
    try {
      const out = await place(w, 4, '--apply');

      expect(out.doc).toMatchObject({ ok: true, data: { box: BOX, action: 'wake' } });
      expect(w.ec2.instance(BOX)?.State).toBe('running');
    } finally {
      await done(w);
    }
  });

  test("--apply under the limit makes the repo's box from the template, tagged with its repo, no card (ADR 0022)", async () => {
    const w = await world(2);

    try {
      const out = await place(w, 4, '--apply', '--title', 'Sign in with email');

      expect(out.doc).toMatchObject({ ok: true, data: { box: BOX, action: 'create' } });
      const tags = Object.fromEntries(
        (w.ec2.instance(BOX)?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );

      expect(tags).toMatchObject({ 'abe:box': BOX, 'abe:repo': REPO });
      expect(tags['abe:team']).toBeUndefined();
      expect(tags['abe:card']).toBeUndefined();
      expect(tags['abe:title']).toBeUndefined();
      expect(w.ec2.instance(BOX)?.State).toBe('running');
    } finally {
      await done(w);
    }
  });
});

describe('a box per repo (ADR 0022): never a second for one repo, a clash named apart', () => {
  test('a second card of the repo while EC2 does not list the new box yet: that box, never another', async () => {
    const w = await world(3, 1_500);

    try {
      // at once: the second is placed while the first's box is made but not listed yet
      const [first, second] = await Promise.all([place(w, 4, '--apply'), place(w, 5, '--apply')]);

      expect([first.doc, second.doc]).toMatchObject([
        { ok: true, data: { box: BOX } },
        { ok: true, data: { box: BOX } },
      ]);
      expect(made(w)).toBe(1);
    } finally {
      await done(w);
    }
  });

  test("another repo's box of the repo's name: a new box with the repo's 4 hex, tagged with its repo", async () => {
    const w = await world(3);

    w.ec2.put({ name: BOX, repo: 'octo/demo-shop', state: 'running' });
    try {
      const out = await place(w, 4, '--apply');

      expect(out.doc).toMatchObject({
        ok: true,
        data: { box: boxName(REPO, true), action: 'create' },
      });
      const tags = Object.fromEntries(
        (w.ec2.instance(boxName(REPO, true))?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );

      expect(tags).toMatchObject({ 'abe:box': boxName(REPO, true), 'abe:repo': REPO });
    } finally {
      await done(w);
    }
  });
});

describe("a repo box's size (#344): box.size on its make, and on a wake below it", () => {
  const sized = (w: World, size: string) => {
    local(w.root, `limits.maxBoxesPerPerson: 2\nbox.size: ${size}\n`);
  };

  test('made at box.size (default m8g.xlarge), never past limits.maxBoxSize', async () => {
    const w = await world(2);

    try {
      expect((await place(w, 4, '--apply')).doc).toMatchObject({ data: { action: 'create' } });
      expect(w.ec2.instance(BOX)?.InstanceType).toBe('m8g.xlarge');
      sized(w, 'm8g.4xlarge');
      expect((await placeIn(w, 5, other(5), '--apply')).doc).toMatchObject({
        data: { action: 'create' },
      });
      // limits.maxBoxSize (m8g.2xlarge, its default) wins
      expect(w.ec2.instance(boxName(other(5)))?.InstanceType).toBe('m8g.2xlarge');
    } finally {
      await done(w);
    }
  });

  test('a box asleep below box.size is resized as it wakes; one at it or larger as it is', async () => {
    const w = await world(2);

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped', size: 'm8g.large' });
    w.ec2.put({
      name: boxName(other(5)),
      repo: other(5),
      state: 'stopped',
      size: 'm8g.2xlarge',
    });
    try {
      expect((await place(w, 4, '--apply')).doc).toMatchObject({ data: { action: 'wake' } });
      expect(w.ec2.instance(BOX)).toMatchObject({ State: 'running', InstanceType: 'm8g.xlarge' });
      expect((await placeIn(w, 5, other(5), '--apply')).doc).toMatchObject({
        data: { action: 'wake' },
      });
      expect(w.ec2.instance(boxName(other(5)))?.InstanceType).toBe('m8g.2xlarge');
    } finally {
      await done(w);
    }
  });
});

describe('the queue: held by the Mac serve in order, answered when a box stops or is deleted or the limit rises', () => {
  test('Queued at the limit, made once the limit rises', async () => {
    const w = await world(2);

    w.ec2.put({ name: 'shop-101', repo: 'mkdir-swe/shop-101' });
    w.ec2.put({ name: 'shop-192', repo: 'mkdir-swe/shop-192' });
    w.ec2.put({ name: 'shop-193', repo: 'mkdir-swe/shop-193', state: 'stopped' });
    try {
      await w.mac.run('status');
      const watch = watchOf(w)('--json');
      const out = await place(w, 4, '--apply');

      expect(out.doc).toMatchObject({ ok: true, data: { box: BOX, action: 'queue', boxes: 2 } });
      expect(await boxStates(watch, (s) => s === 'queued')).toEqual([[BOX, 'queued', 'place']]);
      expect(made(w)).toBe(0);
      // Asked again, it stays where it is in the queue.
      expect((await place(w, 4, '--apply')).doc).toMatchObject({ data: { action: 'queue' } });
      limitOf(w.root, 3);
      expect(await boxStates(watch, (s) => s === 'running')).toEqual([
        [BOX, 'starting', 'up'],
        [BOX, 'running', 'up'],
      ]);
      watch.close();
      expect(made(w)).toBe(1);
      expect(w.ec2.instance(BOX)?.State).toBe('running');
      // Answered: no longer held in the serve's state.
      expect(
        readdirSync(join(w.mac.state.dir, 'cloud')).filter((f) => f.startsWith('place-')),
      ).toEqual([]);
      expect((await place(w, 4)).doc).toMatchObject({ data: { action: 'use', boxes: 3 } });
    } finally {
      await done(w);
    }
  });

  test('in order: a deleted box answers the oldest only; the next waits on', async () => {
    const w = await world(1);

    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      // Each another repo's, so each its own box (ADR 0022).
      expect((await placeIn(w, 5, other(5), '--apply')).doc).toMatchObject({
        data: { action: 'queue' },
      });
      expect((await placeIn(w, 6, other(6), '--apply')).doc).toMatchObject({
        data: { action: 'queue' },
      });
      // A launch-to-be for card 7 waits behind both, though nothing is said of it yet.
      expect((await placeIn(w, 7, other(7))).doc).toMatchObject({ data: { action: 'queue' } });
      w.ec2.set('shop-9', 'terminated');
      await until('card 5 made', () =>
        w.ec2.instance(boxName(other(5))) === undefined ? undefined : true,
      );
      // The queue looked at EC2 twice more since: card 6 still waits.
      const looked = describes(w);

      await until('the queue looked again', () => (describes(w) >= looked + 2 ? true : undefined));
      expect(live(w).map(([name]) => name)).toEqual([boxName(other(5))]);
      expect((await placeIn(w, 6, other(6))).doc).toMatchObject({
        data: { action: 'queue', boxes: 1 },
      });
    } finally {
      await done(w);
    }
  });

  test('a wake at the limit is Queued, and woken once another box stops', async () => {
    const w = await world(1);

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      expect((await place(w, 4, '--apply')).doc).toMatchObject({
        data: { box: BOX, action: 'queue', boxes: 1 },
      });
      expect(w.ec2.instance(BOX)?.State).toBe('stopped');
      w.ec2.set('shop-9', 'stopped');
      await until('card 4 woken', () =>
        w.ec2.instance(BOX)?.State === 'running' ? true : undefined,
      );
      expect(made(w)).toBe(0);
    } finally {
      await done(w);
    }
  });

  test('abe box up counts the same boxes: refused at the limit, an asleep one not counted', async () => {
    const w = await world(1);

    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      const out = await w.mac.json(BoxData, 'box', 'up', REPO, '4');

      expect(out.doc).toMatchObject({ ok: false, error: { code: 'box-limit' } });
      expect(out.doc.ok ? '' : out.doc.error.message).toContain('1 running or starting');
      expect(made(w)).toBe(0);
      w.ec2.set('shop-9', 'stopped');
      expect((await w.mac.json(BoxData, 'box', 'up', REPO, '4')).doc).toMatchObject({ ok: true });
      expect(made(w)).toBe(1);
    } finally {
      await done(w);
    }
  });
});

describe('a wake by name counts as a launch’s wake (#191): box start, --on, box keep', () => {
  /** Every EC2 start asked so far (`start-instances`). */
  const starts = (w: World) => w.ec2.calls().filter((c) => c.includes('start-instances')).length;

  test('box start at the limit: refused box-limit with the count and the way on; started once another stops', async () => {
    const w = await world(1);

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      const out = await w.mac.json(BoxData, 'box', 'start', BOX);

      expect(out.doc).toMatchObject({ ok: false, error: { code: 'box-limit' } });
      expect(out.doc.ok ? '' : out.doc.error.message).toBe(
        // A repo's box holds no one card to queue (ADR 0022): the way on is a stop.
        'no room under limits.maxBoxesPerPerson 1: you have 1 running or starting (stopped ones do not count) and Queued requests go first; stop one first, then start it',
      );
      expect(starts(w)).toBe(0);
      expect(w.ec2.instance(BOX)?.State).toBe('stopped');
      w.ec2.set('shop-9', 'stopped');
      expect((await w.mac.json(BoxData, 'box', 'start', BOX)).doc).toMatchObject({
        ok: true,
        data: { name: BOX, state: 'running' },
      });
    } finally {
      await done(w);
    }
  });

  // the CLI contract: exit 1 and the --json error through the real `abe`
  test('--on and box keep wake it too: refused at the limit, the box left asleep', async () => {
    const w = await world(1, 0, true);

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      const on = await w.mac.run('--on', BOX, 'status', '--json');

      expect(on.exit).toBe(1);
      expect(JSON.parse(on.stdout)).toMatchObject({ ok: false, error: { code: 'box-limit' } });
      expect((await w.mac.json(BoxData, 'box', 'keep', BOX)).doc).toMatchObject({
        ok: false,
        error: { code: 'box-limit' },
      });
      expect(starts(w)).toBe(0);
    } finally {
      await done(w);
    }
  });

  test('a box running at the limit is used as it is; one a placement is waking is not counted twice', async () => {
    const w = await world(1);

    w.ec2.put({ name: BOX, repo: REPO });
    try {
      expect((await w.mac.json(BoxData, 'box', 'start', BOX)).doc).toMatchObject({
        ok: true,
        data: { name: BOX, state: 'running' },
      });
      w.ec2.set(BOX, 'stopped');
      // The placement's wake counts from its decision; box start of the same box is no second one.
      expect((await place(w, 4, '--apply')).doc).toMatchObject({
        data: { box: BOX, action: 'wake' },
      });
      expect((await w.mac.json(BoxData, 'box', 'start', BOX)).doc).toMatchObject({
        ok: true,
        data: { name: BOX, state: 'running' },
      });
    } finally {
      await done(w);
    }
  });
});

const until = async <T>(what: string, check: () => T | undefined, ms = 15_000) => {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = check();

    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(40);
  }
};
