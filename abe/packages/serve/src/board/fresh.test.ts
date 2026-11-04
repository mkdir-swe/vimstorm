/**
 * Fresh data in serve (#236): a look's changed-since reads on the fake board and a fake GitHub,
 * what it says as events, and the clock a hold runs.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BoardRef,
  type Event,
  EventLine,
  FreshData,
  type UiNode,
  journal,
  type PrTouch,
  Repo,
  type PipelineRun,
  type PipelineSource,
  type Tracked,
  type Tracking,
} from '@abe/core';
import {
  card,
  cli,
  fakeAdo,
  fakeAz,
  fakeBoard,
  fakeGh,
  fakePipelines,
  ghListedPull,
  pipelineRun,
  refusingTracking,
} from '@abe/testing';
import { asTrees, BridgeFrame } from '@abe/ui';
import { startFresh } from './fresh';

const REF: BoardRef = {
  organization: 'https://dev.azure.com/demo-org',
  project: 'Shop',
  team: 'Web',
  types: ['User Story'],
};
const REPO = Repo.parse('acme/shop');
const ME = { name: 'Alex', email: 'alex@example.test' };

const pr = (number: number, updatedAt: string, state: PrTouch['state'] = 'open'): PrTouch => ({
  number,
  title: `Change ${number}`,
  state,
  branch: `card/${number}`,
  updatedAt,
});
const SOURCE: PipelineSource = {
  provider: 'azure-pipelines',
  organization: REF.organization,
  project: 'Shop',
};
const run = (id: string, more: Partial<PipelineRun> = {}): PipelineRun =>
  pipelineRun(id, 'ci', 'Sign in', 'card/4-sign-in', '10:00', null, { status: 'running', ...more });

const world = (
  o: { repo?: boolean; board?: boolean; prsFail?: boolean; runsFail?: boolean } = {},
) => {
  let now = Date.parse('2026-10-25T12:00:00Z');
  const clock = { now: () => now };
  const events = journal(clock);
  const seen: Event[] = [];

  events.watch(undefined, (e) => seen.push(e));
  const board = fakeBoard(
    [card(4, 'Sign in', { state: 'Active', assignee: ME }), card(5, 'Reset password')],
    { me: ME },
  );
  const calls: string[] = [];
  const github = { prs: [pr(41, '2026-10-25T10:00:00Z')] };
  const runs = [run('9001')];
  const fake = fakePipelines({ runs });
  const pipelines = {
    ...fake,
    runs: (s: PipelineSource, limit: number) => {
      calls.push(`runs ${limit}`);

      return o.runsFail === true
        ? Promise.resolve({
            ok: false as const,
            error: { code: 'auth', message: 'az is not logged in' },
          })
        : fake.runs(s, limit);
    },
  };
  const tracking: Tracking = {
    ...refusingTracking(),
    recentPrs: () => {
      calls.push('recentPrs');

      return Promise.resolve<Tracked<PrTouch[]>>(
        o.prsFail === true
          ? { ok: false, error: { code: 'auth', message: 'gh is not logged in' } }
          : { ok: true, data: github.prs },
      );
    },
  };
  const changes = board.changes;

  board.changes = (b, since) => {
    calls.push(`changes ${since ?? 'null'}`);

    return changes(b, since);
  };
  const fresh = startFresh({
    board,
    tracking,
    boardAt: () => (o.board === false ? undefined : REF),
    repoAt: () => Promise.resolve(o.repo === false ? undefined : REPO),
    pipelines,
    sourceAt: () =>
      Promise.resolve(o.repo === false ? undefined : { source: SOURCE, text: 'demo-org/Shop' }),
    emit: events.emit,
    clock,
    everyMs: 40,
  });
  const later = (ms: number) => {
    now += ms;
  };

  return { fresh, board, github, runs, calls, seen, later };
};

const kinds = (seen: readonly Event[]) => seen.map((e) => e.type);

describe('a look', () => {
  test('the first finds where to start and says nothing; a quiet one reads one query each and says nothing', async () => {
    const w = world();

    expect(await w.fresh.look('/repo')).toEqual({
      board: { project: 'Shop', team: 'Web', cards: 0, gone: 0 },
      github: { repo: 'acme/shop', prs: 0 },
      pipelines: { source: 'demo-org/Shop', runs: 0 },
      failed: [],
      first: true,
    });
    w.later(10_000);
    expect(await w.fresh.look('/repo')).toMatchObject({ first: false, board: { cards: 0 } });
    expect(kinds(w.seen)).toEqual([]);
    expect(w.calls).toEqual([
      'changes null',
      'recentPrs',
      'runs 30',
      'changes 2026-10-23T00:00:00.000Z',
      'recentPrs',
      'runs 30',
    ]);
  });

  test('a card a teammate moved is board.changed with the card as the board lists it; one taken off the board is gone', async () => {
    const w = world();

    await w.fresh.look('/repo');
    w.board.outside(5, { state: 'Active', assignee: ME });
    w.board.outside(4, { state: 'Removed' });
    w.later(10_000);
    expect(await w.fresh.look('/repo')).toMatchObject({ board: { cards: 1, gone: 1 } });
    expect(w.seen.map((e) => [e.type, e.data])).toMatchObject([
      [
        'board.changed',
        {
          board: { organization: REF.organization, project: 'Shop', team: 'Web' },
          cards: [{ card: { id: 5, state: 'Active' }, mine: true }],
          gone: [4],
        },
      ],
    ]);
    // read once: the next look starts after it
    w.later(10_000);
    await w.fresh.look('/repo');
    expect(w.seen).toHaveLength(1);
  });

  test('a pull request reviewed is github.changed, once', async () => {
    const w = world();

    await w.fresh.look('/repo');
    w.github.prs = [pr(41, '2026-10-25T11:00:00Z'), pr(40, '2026-10-24T09:00:00Z', 'merged')];
    w.later(10_000);
    expect(await w.fresh.look('/repo')).toMatchObject({ github: { prs: 1 } });
    expect(w.seen.map((e) => [e.type, e.data])).toEqual([
      ['github.changed', { repo: 'acme/shop', prs: [pr(41, '2026-10-25T11:00:00Z')] }],
    ]);
    w.later(10_000);
    await w.fresh.look('/repo');
    expect(w.seen).toHaveLength(1);
  });

  test('a run started and one finished on the provider in force are pipelines.changed, once', async () => {
    const w = world();

    await w.fresh.look('/repo');
    const done = run('9001', { status: 'passed', finishedAt: '2026-10-01T10:04:00Z' });

    w.runs.splice(0, w.runs.length, run('9002'), done);
    w.later(10_000);
    expect(await w.fresh.look('/repo')).toMatchObject({ pipelines: { runs: 2 } });
    expect(w.seen.map((e) => [e.type, e.data])).toEqual([
      ['pipelines.changed', { source: 'demo-org/Shop', runs: [run('9002'), done] }],
    ]);
    w.later(10_000);
    await w.fresh.look('/repo');
    expect(w.seen).toHaveLength(1);
  });

  test('looks asked together are one; one asked within 5 s gets that answer', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.fresh.look('/repo'), w.fresh.look('/repo')]);

    expect(a).toBe(b);
    w.later(1_000);
    expect(await w.fresh.look('/repo')).toBe(a);
    expect(w.calls.filter((c) => c.startsWith('changes'))).toHaveLength(1);
  });

  test('what is not here is null; a part that fails says why and the other is read', async () => {
    const none = world({ board: false, repo: false });

    expect(await none.fresh.look('/repo')).toEqual({
      board: null,
      github: null,
      pipelines: null,
      failed: [],
      first: false,
    });
    const failing = world({ prsFail: true });

    expect(await failing.fresh.look('/repo')).toMatchObject({
      board: { cards: 0 },
      github: null,
      pipelines: { runs: 0 },
      failed: [{ part: 'github', message: 'gh is not logged in' }],
    });
    // runs that cannot be read leave the pull requests read
    const noRuns = world({ runsFail: true });

    expect(await noRuns.fresh.look('/repo')).toMatchObject({
      github: { prs: 0 },
      pipelines: null,
      failed: [{ part: 'pipelines', message: 'az is not logged in' }],
    });
  });
});

describe('a hold', () => {
  test('looks at once, then on the clock until let go', async () => {
    const w = world();
    const release = w.fresh.hold('/repo');
    const looks = () => w.calls.filter((c) => c.startsWith('changes')).length;

    await Bun.sleep(5);
    expect(looks()).toBe(1);
    // the clock looks again though the last look is not 5 s old
    await Bun.sleep(60);
    expect(looks()).toBeGreaterThanOrEqual(2);
    release();
    release();
    const after = looks();

    w.later(10_000);
    await Bun.sleep(100);
    expect(looks()).toBe(after);
  });

  test('two holds of one checkout share its clock; it stops when both are let go', async () => {
    const w = world();
    const one = w.fresh.hold('/repo');
    const two = w.fresh.hold('/repo');
    const looks = () => w.calls.filter((c) => c.startsWith('changes')).length;

    await Bun.sleep(5);
    expect(looks()).toBe(1);
    one();
    w.later(10_000);
    await Bun.sleep(60);
    expect(looks()).toBeGreaterThanOrEqual(2);
    two();
    const after = looks();

    w.later(10_000);
    await Bun.sleep(100);
    expect(looks()).toBe(after);
  });
});

describe('abe fresh through the CLI seam (the real serve, the fake Azure DevOps, a fake gh)', () => {
  const git = (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: cwd },
    });

    if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
  };
  /** Someone else's write on the board, straight to Azure DevOps. */
  const outside = (url: string, id: number, state: string) =>
    fetch(`${url}/demo-org/Sandbox/_apis/wit/workitems/${id}?api-version=7.1`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer token-one', 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/fields/System.State', value: state }]),
    });
  const PULLS = 'pulls?state=all&sort=updated&direction=desc&per_page=30';
  const RUNS = 'actions/runs?per_page=30';

  /** The real abe with its serve on the fake Azure DevOps and a fake gh; a checkout on GitHub. */
  const world = async (freshMs: string) => {
    const root = mkdtempSync(join(tmpdir(), 'abe-fresh-'));
    const repo = join(root, 'shop');
    const ado = await fakeAdo();
    const az = fakeAz({ tokens: ['token-one'] });
    const gh = fakeGh([
      [PULLS, { json: [ghListedPull('acme/shop', 41, { updatedAt: '2026-10-25T10:00:00Z' })] }],
      [RUNS, { json: { total_count: 0, workflow_runs: [] } }],
    ]);

    for (const dir of ['mine', 'shop/.abe']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    writeFileSync(
      join(repo, 'abe.yaml'),
      `board: ${JSON.stringify(ado.board)}\nenvironments: {}\n`,
    );
    // yours for the shop, never committed
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    const abe = cli({
      env: {
        PATH: `${gh.dir}:${az.dir}:/usr/bin:/bin`,
        ABE_CONFIG_DIR: join(root, 'mine'),
        ABE_FRESH_MS: freshMs,
        ...ado.env,
      },
      cwd: repo,
    });

    return {
      repo,
      ado,
      gh,
      abe,
      close: async () => {
        await abe.close();
        await ado.stop();
        az.remove();
        gh.remove();
        rmSync(root, { recursive: true, force: true });
      },
    };
  };

  test('abe fresh: the first look, then a teammate’s move and review found and said as events', async () => {
    const { repo, ado, gh, abe, close } = await world('300');

    try {
      const first = await abe.jsonWith({ cwd: repo }, FreshData, 'fresh');

      expect(first.doc).toEqual({
        ok: true,
        data: {
          board: { project: 'Sandbox', team: 'Sandbox', cards: 0, gone: 0 },
          github: { repo: 'acme/shop', prs: 0 },
          pipelines: { source: 'acme/shop', runs: 0 },
          failed: [],
          first: true,
        },
      });
      const watch = abe.spawn('watch', '--json');

      await abe.run('status');
      await outside(ado.url, 5, 'Active');
      gh.answer([
        [PULLS, { json: [ghListedPull('acme/shop', 41, { updatedAt: '2026-10-25T11:00:00Z' })] }],
        [RUNS, { json: { total_count: 0, workflow_runs: [] } }],
      ]);
      await Bun.sleep(5_100);
      const again = await abe.runWith({ cwd: repo }, 'fresh');

      expect(again.stdout).toBe(
        'Sandbox / Sandbox: 1 card changed · acme/shop: 1 pull request changed · acme/shop: 0 runs moved\n',
      );
      const said: { type: string; data: unknown }[] = [];

      while (said.length < 2) {
        const e = EventLine.parse(JSON.parse(await watch.next(5_000)));

        if (e.type === 'board.changed' || e.type === 'github.changed') said.push(e);
      }
      expect(said).toMatchObject([
        {
          type: 'board.changed',
          data: { cards: [{ card: { id: 5, state: 'Active' }, mine: false }], gone: [] },
        },
        { type: 'github.changed', data: { repo: 'acme/shop', prs: [{ number: 41 }] } },
      ]);
      watch.signal('SIGKILL');

      // --follow: held while it runs, its clock finds the next move by itself
      const follow = abe.spawn('fresh', '--follow', '--json');

      await Bun.sleep(500);
      await outside(ado.url, 13, 'Active');
      const moved = EventLine.parse(JSON.parse(await follow.next(5_000)));

      expect(moved).toMatchObject({
        type: 'board.changed',
        data: { cards: [{ card: { id: 13, state: 'Active' } }] },
      });
      follow.signal('SIGINT');
      expect((await follow.exited).exit).toBe(0);
    } finally {
      await close();
    }
  }, 40_000);

  test('abe ui bridge: the Board shown holds it, a teammate’s move shows without a key; the Editor shown lets go', async () => {
    const { repo, ado, abe, close } = await world('400');
    const bridge = abe.spawn('ui', 'bridge');
    /** Its frames as the window takes them: a patch as the tree it gives. */
    const trees = asTrees();
    const send = (frame: unknown) => {
      bridge.write(`${JSON.stringify(frame)}\n`);
    };
    const walk = (n: UiNode, out: UiNode[] = []): UiNode[] => {
      out.push(n);
      for (const c of n.children ?? []) walk(c, out);

      return out;
    };
    const columnOf = (t: UiNode, card: string) =>
      walk(t).find((n) => (n.id ?? '').startsWith('col:') && walk(n).some((k) => k.id === card))
        ?.id;
    const until = async (match: (t: UiNode) => boolean, ms = 10_000) => {
      const end = Date.now() + ms;

      for (;;) {
        const f = trees(
          BridgeFrame.parse(JSON.parse(await bridge.next(Math.max(1, end - Date.now())))),
        );

        if (f.type === 'tree' && f.slot === undefined && match(f.tree)) return f.tree;
      }
    };
    const wiql = () => ado.requests().filter((r) => r.includes('/_apis/wit/wiql')).length;

    try {
      send({
        v: 2,
        type: 'hello',
        size: { width: 1440, height: 846 },
        version: 'test',
        root: repo,
      });
      send({ v: 2, type: 'window', view: 'factory', active: true });
      send({ v: 2, type: 'open', screen: 'factory' });
      send({ v: 2, type: 'input', input: { kind: 'key', key: '<Tab>' } });
      await until((t) => columnOf(t, 'card:5') === 'col:New');
      await outside(ado.url, 5, 'Active');
      // no key: serve's clock finds it, the Board moves it
      await until((t) => columnOf(t, 'card:5') === 'col:Active');
      // the Editor shown: nothing looked at any more (past the 5 s a look answers for)
      send({ v: 2, type: 'window', view: 'editor', active: true });
      await Bun.sleep(600);
      const before = wiql();

      await Bun.sleep(5_000);
      expect(wiql()).toBe(before);
      // the window to the front on the Editor: one look
      send({ v: 2, type: 'window', view: 'editor', active: false });
      send({ v: 2, type: 'window', view: 'editor', active: true });
      for (let i = 0; i < 50 && wiql() === before; i += 1) await Bun.sleep(50);
      expect(wiql()).toBe(before + 1);
      // back on the Factory view: what moved meanwhile shows at once
      await Bun.sleep(5_000);
      await outside(ado.url, 5, 'Resolved');
      send({ v: 2, type: 'window', view: 'factory', active: true });
      await until((t) => columnOf(t, 'card:5') === 'col:Resolved', 5_000);
    } finally {
      bridge.signal('SIGKILL');
      await close();
    }
  }, 60_000);
});
