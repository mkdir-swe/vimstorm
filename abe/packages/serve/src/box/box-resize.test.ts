/**
 * `abe box resize` (#59, #90): the Mac's serve in this test as `abe serve` builds it (`macServed`;
 * one contract test through the real `abe`, `cli()`), the fake EC2 (a fake `aws` on disk, reached
 * by the real `ec2Boxes` port as the person) and a fake ssh-like command as the link
 * (`ABE_BOX_LINK=exec:…`), answering the box's `abe session list`. Commands are typed in the
 * checkout `shop`: the repo's `limits.maxBoxSize` is `m8g.2xlarge`; yours for it
 * (`.abe/settings.local.yaml`) tries `m8g.4xlarge`, which only lowers it could.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoxResizeData, boxName, type SessionData } from '@abe/core';
import {
  cli,
  type Cli,
  fakeEc2,
  type FakeEc2,
  fakeTool,
  type FakeTool,
  git,
  macServed,
  type ToolAnswer,
} from '@abe/testing';

// A box stopped and started again, twice, each aws call a process: seconds, not the default 5.
setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const BOX = boxName(REPO);

/** One session as the box's `abe session list --json` lists it. */
const session = (id: string, state: SessionData['state']): SessionData => ({
  id,
  card: 4,
  prototype: null,
  kind: 'card',
  title: 'As a visitor I can sign in with email',
  repo: REPO,
  worktree: '/workspace',
  branch: 'card/4-as-a-visitor-i-can',
  state,
  since: '2026-10-23T09:00:00.000Z',
  startedAt: '2026-10-23T09:00:00.000Z',
  transcriptPath: null,
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

/** `<link> <box> -- abe session list --json`, its words quoted for the box's shell. */
const LIST = "'session' 'list' '--json'";

/** The box's answer to `abe session list --json` over the fake link. */
const listing = (sessions: SessionData[]): ToolAnswer => ({
  json: { ok: true, data: { sessions } },
});

/** The Mac: its serve in this test (`macServed`), or the real `abe` for the command's contract. */
type World = {
  root: string;
  ec2: FakeEc2;
  tunnel: FakeTool;
  mac: Pick<Cli, 'state' | 'run' | 'json' | 'close'>;
};

/**
 * The Mac's `abe`: the fake `aws` and the fake link on its PATH, the person's login as owner.
 * `iam`: whose login the fake EC2's IAM sees the caller as (default the owner's).
 */
const world = async (
  o: { iam?: string; owner?: string; limit?: number; real?: true } = {},
): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-r-'));
  const owner = o.owner ?? 'octocat';
  const ec2 = fakeEc2({ owner: o.iam ?? owner, bootMs: 300, stopMs: 300 });
  const tunnel = fakeTool('box-ssh', { stderr: 'ssh: no route to box', exit: 255 });

  const shop = join(root, 'shop');

  for (const dir of ['mine', 'shop/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
  git(shop, 'init', '-q', '-b', 'main');
  writeFileSync(join(shop, 'abe.yaml'), 'limits:\n  maxBoxSize: m8g.2xlarge\n');
  // yours for the shop, never committed
  writeFileSync(join(shop, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(
    join(shop, '.abe', 'settings.local.yaml'),
    `limits:\n  maxBoxSize: m8g.4xlarge\n${o.limit === undefined ? '' : `  maxBoxesPerPerson: ${o.limit}\n`}`,
  );
  const env = {
    PATH: `${ec2.dir}:${tunnel.dir}:/usr/bin:/bin`,
    ABE_CONFIG_DIR: join(root, 'mine'),
    ABE_OWNER: owner,
    ABE_BOX_LINK: `exec:${join(tunnel.dir, 'box-ssh')}`,
    ABE_CLOUD_POLL_MS: '100',
  };
  const mac = o.real === true ? cli({ env, cwd: shop }) : await macServed(env, { cwd: shop });

  return { root, ec2, tunnel, mac };
};

const done = async (w: World) => {
  await w.mac.close();
  w.ec2.remove();
  w.tunnel.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const resize = (w: World, ...argv: string[]) => w.mac.json(BoxResizeData, 'box', 'resize', ...argv);

/** What the Mac asked EC2 to do with the box so far: `stop`, `resize m8g.xlarge`, `start`. */
const moves = (w: World) =>
  w.ec2.calls().flatMap((c) => {
    const [, op = ''] = c.split(' ');

    if (op === 'stop-instances') return ['stop'];
    if (op === 'start-instances') return ['start'];
    if (op === 'modify-instance-attribute')
      return [`resize ${/--instance-type Value=(\S+)/.exec(c)?.[1] ?? '?'}`];

    return [];
  });

const box = (w: World) => w.ec2.instance(BOX);
const tagsOf = (w: World) => Object.fromEntries((box(w)?.Tags ?? []).map((t) => [t.Key, t.Value]));

describe('abe box resize of a sleeping box starts it: counted as a wake (#191)', () => {
  test('at limits.maxBoxesPerPerson: box-limit, nothing asked of EC2', async () => {
    const w = await world({ limit: 1 });

    w.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
    w.ec2.put({ name: 'shop-9', repo: 'mkdir-swe/shop-9' });
    try {
      expect((await resize(w, BOX, 'm8g.xlarge')).doc).toMatchObject({
        ok: false,
        error: { code: 'box-limit' },
      });
      expect(moves(w)).toEqual([]);
      expect(box(w)?.State).toBe('stopped');
    } finally {
      await done(w);
    }
  });
});

describe("abe box resize: within the repo's maximum, asked first while sessions run", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    w.ec2.put({ name: BOX, repo: REPO, size: 'm8g.large' });
  });
  afterAll(async () => {
    await done(w);
  });

  test("a size over the repo's maximum is size-over-team-max, and nothing is asked of EC2", async () => {
    w.tunnel.answer([[LIST, listing([])]]);
    const out = await resize(w, BOX, 'm8g.4xlarge', '--yes');

    expect(out.exit).not.toBe(0);
    expect(out.doc).toEqual({
      ok: false,
      error: {
        code: 'size-over-team-max',
        message:
          'm8g.4xlarge is bigger than the repo allows: its largest box size is m8g.2xlarge · pick m8g.2xlarge or smaller, or raise it in abe.yaml',
      },
    });
    expect(moves(w)).toEqual([]);
  });

  test('a size that is no box size is size-unknown', async () => {
    const out = await resize(w, BOX, 'huge');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'size-unknown' } });
    expect(moves(w)).toEqual([]);
  });

  test('a box that is not there is no-box', async () => {
    const out = await resize(w, 'demo-shop-99', 'm8g.xlarge');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-box' } });
  });

  test('sessions running on the box: sessions-running without --yes, nothing stopped', async () => {
    w.tunnel.answer([[LIST, listing([session('4-a1b2', 'working'), session('4-c3d4', 'ended')])]]);
    const out = await resize(w, BOX, 'm8g.xlarge');

    expect(out.doc).toEqual({
      ok: false,
      error: {
        code: 'sessions-running',
        message: '1 session runs on the box; resizing stops it: --yes to resize anyway',
      },
    });
    expect(moves(w)).toEqual([]);
    // It asked the box itself, over the link.
    expect(w.tunnel.calls().at(-1)?.argv).toEqual([BOX, '--', 'abe', ...LIST.split(' ')]);
  });

  test('a box whose sessions cannot be read is refused without --yes', async () => {
    w.tunnel.answer([]);
    const out = await resize(w, BOX, 'm8g.xlarge');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'box-unreachable' } });
    expect(moves(w)).toEqual([]);
  });

  test('with --yes: stopped, its instance type changed, started', async () => {
    w.tunnel.answer([[LIST, listing([session('4-a1b2', 'working')])]]);
    const out = await resize(w, BOX, 'm8g.xlarge', '--yes');

    expect(out.doc).toEqual({
      ok: true,
      data: { box: BOX, from: 'm8g.large', to: 'm8g.xlarge', changed: true, status: 'running' },
    });
    expect(moves(w)).toEqual(['stop', 'resize m8g.xlarge', 'start']);
    expect(box(w)).toMatchObject({ InstanceType: 'm8g.xlarge', State: 'running' });
    // Its tags stay: the same box, the repo's (ADR 0022: no card tag).
    expect(tagsOf(w)).toMatchObject({
      'abe:owner': 'octocat',
      'abe:box': BOX,
      'abe:repo': REPO,
    });
  });

  test('the size it has already: nothing asked of EC2', async () => {
    const out = await resize(w, BOX, 'm8g.xlarge');

    expect(out.doc).toMatchObject({ ok: true, data: { changed: false, to: 'm8g.xlarge' } });
    expect(moves(w)).toHaveLength(3);
  });

  test('back down with no sessions: no --yes needed', async () => {
    w.tunnel.answer([[LIST, listing([session('4-a1b2', 'ended')])]]);
    const out = await resize(w, BOX, 'm8g.large');

    expect(out.doc).toMatchObject({
      ok: true,
      data: { from: 'm8g.xlarge', to: 'm8g.large', changed: true, status: 'running' },
    });
    expect(moves(w).slice(3)).toEqual(['stop', 'resize m8g.large', 'start']);
  });

  test('a sleeping box asks nothing of its sessions and comes up at its new size', async () => {
    // The person stopped it (or it stopped itself, idle).
    w.ec2.set(BOX, 'stopped');
    const asked = w.tunnel.calls().length;
    const out = await resize(w, BOX, 'm8g.xlarge');

    expect(out.doc).toMatchObject({ ok: true, data: { changed: true, status: 'running' } });
    expect(w.tunnel.calls()).toHaveLength(asked);
    expect(moves(w).slice(6)).toEqual(['resize m8g.xlarge', 'start']);
    expect(box(w)).toMatchObject({ InstanceType: 'm8g.xlarge', State: 'running' });
  });

  test('the text says the change', async () => {
    const out = await w.mac.run('box', 'resize', BOX, 'm8g.large', '--yes');

    expect(out.stdout).toBe(`box ${BOX}: m8g.xlarge → m8g.large (running)\n`);
  });
});

describe('refused by AWS', () => {
  // the CLI contract: a failing exit and the --json error through the real `abe`
  test("IAM refuses a box that is not the caller's: aws-refused, the box left as it was", async () => {
    // The Mac names octocat as its owner and the box is tagged so, but IAM knows the caller as hubot.
    const w = await world({ owner: 'octocat', iam: 'hubot', real: true });

    try {
      w.ec2.put({ name: BOX, owner: 'octocat', repo: REPO, size: 'm8g.large' });
      const out = await resize(w, BOX, 'm8g.xlarge', '--yes');

      expect(out.exit).not.toBe(0);
      expect(out.doc).toMatchObject({ ok: false, error: { code: 'aws-refused' } });
      expect(out.doc.ok ? '' : out.doc.error.message).toContain('UnauthorizedOperation');
      // The stop was asked and refused; nothing after it.
      expect(moves(w)).toEqual(['stop']);
      expect(box(w)).toMatchObject({ InstanceType: 'm8g.large', State: 'running' });
    } finally {
      await done(w);
    }
  });

  test('an expired AWS login says to log in: aws-auth, nothing stopped', async () => {
    const w = await world();

    try {
      w.ec2.put({ name: BOX, repo: REPO });
      w.ec2.expire(true);
      const out = await resize(w, BOX, 'm8g.xlarge', '--yes');

      expect(out.doc).toMatchObject({ ok: false, error: { code: 'aws-auth' } });
      expect(out.doc.ok ? '' : out.doc.error.message).toContain('aws sso login');
      expect(moves(w)).toEqual([]);
    } finally {
      await done(w);
    }
  });
});
