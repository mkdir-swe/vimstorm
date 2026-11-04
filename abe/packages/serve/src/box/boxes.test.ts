/**
 * Your environment from the Mac (#56, #90; ADR 0021): the Mac's serve in this test as `abe serve`
 * builds it (`macServed`; the refusals' exit codes through the real `abe`, `cli()`), its boxes a
 * fake EC2 (a fake `aws` with IAM's ABAC in front) reached by the real `ec2Boxes` as the person
 * `octocat`, and its link a fake ssh-like box shell (`ABE_BOX_LINK=exec:`), which runs the box's
 * `abe` against a second local `serve` standing in for each box, and only while the fake EC2 says
 * that box runs. Boxes A and C each hold a workspace and a session started on the box itself (the
 * Mac did not launch them); box B is asleep. A second Mac with `serve.target` local asks no box.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  BoxData,
  BoxKeepData,
  BoxListData,
  EventLine,
  type LoginSet,
  type Secrets,
  SessionAttachData,
  SessionData,
  SessionListData,
  StatusData,
} from '@abe/core';
import {
  cli,
  fakeBoxShell,
  type FakeBoxShell,
  fakeDocker,
  fakeEc2,
  type FakeEc2,
  fakeGh,
  type FakeGh,
  fakeMirrors,
  git,
  macServed,
  scenario,
  type ServedCli,
  type ServeScenario,
  type StandIn,
  standInWorkspace,
  type Watching,
  T0,
  tempState,
  until as waitUntil,
  watching,
} from '@abe/testing';
import { awsFrom, awsRunner, boxAwsReach, boxLinkFrom, ec2BoxesFrom } from '@abe/ports';
import { z } from 'zod';
import { answerOf } from './boxes';

setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const A = 'demo-shop-4';
const B = 'demo-shop-5';
const SESSION = '4-a1b2';
const C = 'demo-shop-7';
const SESSION_C = '7-c3d4';

/**
 * A checkout at `dir` (ADR 0030): the repo's `abe.yaml` and yours for it,
 * `.abe/settings.local.yaml`, kept out of git.
 */
const checkoutAt = (dir: string, repo: string, local = '') => {
  mkdirSync(join(dir, '.abe'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'abe.yaml'), repo);
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(dir, '.abe', 'settings.local.yaml'), local);
};

const secrets: Secrets = {
  read: () => Promise.resolve({ ok: true, data: 'postgres://reader:r@test-db:5432/shop' }),
};
const logins = {
  read: (): Promise<Answered<LoginSet>> =>
    Promise.resolve({ ok: true, data: { claude: 'fake-claude-login', github: 'fake-gh-login' } }),
};

type World = {
  root: string;
  ec2: FakeEc2;
  shell: FakeBoxShell;
  gh: FakeGh;
  a: SessionBox;
  b: ServeScenario;
  c: SessionBox;
  mac: ServedCli;
};

const until = <T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 15_000) =>
  waitUntil(what, check, { ms, every: 40 });

const data = <T extends z.ZodType>(schema: T, stdout: string): z.output<T> =>
  schema.parse(z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(stdout)).data);

/** A box's `serve` holding a workspace and a session started on the box itself. */
type SessionBox = ServeScenario & { standIn: StandIn };

const sessionBox = async (o: {
  gh: FakeGh;
  name: string;
  card: number;
  session: string;
  title: string;
  idle?: boolean;
}): Promise<SessionBox> => {
  const docker = fakeDocker();
  const mirrors = fakeMirrors();

  mirrors.trees.set(REPO, 'tree1');
  const state = tempState();
  const standIn = standInWorkspace({
    docker,
    stateDir: state.dir,
    path: [o.gh.dir],
  });
  const box = await scenario({
    state,
    box: { docker, mirrors },
    sessions: { runner: standIn.runner },
    logins,
    secrets,
    reachTarget: 'cloud',
    // Its idle stop (#92), never due here: nobody on it, the clock never moves.
    ...(o.idle === true
      ? {
          idle: {
            name: o.name,
            host: {
              shutdown: () => Promise.resolve({ ok: true as const, data: null }),
              attached: () => Promise.resolve(false),
            },
            everyMs: 3_600_000,
          },
        }
      : {}),
  });
  const card = String(o.card);
  const up = await box.request(
    'workspace',
    'up',
    '--repo',
    REPO,
    '--card',
    card,
    '--title',
    o.title,
    '--json',
  );

  if (up.exit !== 0) throw new Error(up.stdout + up.stderr);
  const text = JSON.stringify({ title: o.title, description: '', acceptanceCriteria: '' });
  const ran = await box.request(
    'session',
    'run',
    '--id',
    o.session,
    '--repo',
    REPO,
    '--card',
    card,
    '--text',
    text,
    '--json',
  );

  if (ran.exit !== 0) throw new Error(ran.stdout + ran.stderr);
  await until(`${o.session} waiting`, async () => {
    const shown = await box.request('session', 'show', o.session, '--json');

    return data(SessionData, shown.stdout).state === 'waiting' ? true : undefined;
  });

  return { ...box, standIn };
};

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-b-'));
  const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
  const shell = fakeBoxShell(ec2);
  const gh = fakeGh([['auth', { stdout: '' }]]);

  for (const dir of ['mine', 'local']) mkdirSync(join(root, dir), { recursive: true });
  // The Mac's own setting: your environment (set: ADR 0042); a second Mac that says local.
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
  writeFileSync(join(root, 'local', 'settings.yaml'), 'serve.target: local\n');
  // Workspaces and sessions on boxes A and C, started there: the Mac knows nothing of them.
  const [a, c] = await Promise.all([
    sessionBox({ gh, name: A, card: 4, session: SESSION, title: 'Sign in', idle: true }),
    sessionBox({ gh, name: C, card: 7, session: SESSION_C, title: 'Basket' }),
  ]);
  const b = await scenario({ box: true });

  ec2.put({ name: A, size: 'm8g.large', repo: REPO, card: 4, release: 11 });
  ec2.put({
    name: B,
    size: 'm8g.xlarge',
    repo: REPO,
    card: 5,
    state: 'stopped',
    title: 'Pay by card',
  });
  ec2.put({ name: C, size: 'm8g.large', repo: REPO, card: 7 });
  // Another person's box, in the same account: never shown, never reachable as ours.
  ec2.put({ name: 'demo-shop-8', owner: 'hubot', repo: REPO, card: 8 });
  shell.box(A, a.state.socket);
  shell.box(B, b.state.socket);
  shell.box(C, c.state.socket);
  const mac = await macServed({
    PATH: ec2.path,
    ABE_OWNER: ec2.owner,
    ABE_BOX_LINK: `exec:${shell.path}`,
    ABE_CONFIG_DIR: join(root, 'mine'),
    ABE_CLOUD_POLL_MS: '40',
  });

  return { root, ec2, shell, gh, a, b, c, mac };
};

const done = async (w: World) => {
  await w.mac.close();
  await w.a.close();
  await w.b.close();
  await w.c.close();
  await w.a.standIn.remove();
  await w.c.standIn.remove();
  w.shell.remove();
  w.ec2.remove();
  w.gh.remove();
  rmSync(w.root, { recursive: true, force: true });
};

/** The Mac's watch: every event line it printed so far, kept as they come. */
const collect = (watch: Pick<Watching, 'next'>) => {
  const seen: EventLine[] = [];

  void (async () => {
    for (;;) {
      const line = await watch.next(60_000).catch(() => undefined);

      if (line === undefined) return;
      seen.push(EventLine.parse(JSON.parse(line)));
    }
  })();

  return seen;
};

const States = z.object({ id: z.string(), state: z.string(), cause: z.string() });

/** `[cause, state]` of `session` as the Mac's watch merged it, tagged with `box`. */
const statesOf = (seen: readonly EventLine[], box = A, session = SESSION) =>
  seen
    .filter((e) => e.type === 'session.state' && e.box === box)
    .map((e) => States.parse(e.data))
    .filter((d) => d.id === session)
    .map((d) => [d.cause, d.state]);

/**
 * Turns of `session` on `box` until one reaches the Mac's watch: the box's own `watch` has
 * connected to its serve by then (the link's command starts before it does). How many states
 * of it the Mac holds then.
 */
const followedNow = async (
  seen: readonly EventLine[],
  on: ServeScenario,
  box: string,
  session: string,
) => {
  for (let tries = 1; ; tries += 1) {
    const before = statesOf(seen, box, session).length;
    const sent = await on.request('session', 'send', session, 'are you there', '--json');

    expect(sent.exit).toBe(0);
    try {
      await until(
        `${box} followed`,
        () => {
          const now = statesOf(seen, box, session);

          return now.length > before && now.at(-1)?.[1] === 'waiting' ? true : undefined;
        },
        3000,
      );
    } catch (err) {
      if (tries >= 5) throw err;
      continue;
    }
    // An earlier try's turn may still be on its way: settled once nothing more comes.
    for (;;) {
      const held = statesOf(seen, box, session).length;

      await Bun.sleep(300);
      if (statesOf(seen, box, session).length === held) return held;
    }
  }
};

describe('your boxes from the Mac', () => {
  let w: World;
  let watch: Watching | undefined;
  let seen: EventLine[];

  beforeAll(async () => {
    w = await world();
    await w.mac.run('status');
  });
  afterAll(async () => {
    watch?.close();
    await done(w);
  });

  test("abe box list: each box's state and size, a running one's workspace from its own status", async () => {
    const out = await w.mac.json(BoxListData, 'box', 'list');

    expect(out.doc).toMatchObject({
      ok: true,
      data: {
        boxes: [
          {
            name: A,
            state: 'running',
            size: 'm8g.large',
            workspace: { repo: REPO, card: '4', state: 'running' },
            idle: { minutes: 30, stopsAt: new Date(T0 + 30 * 60_000).toISOString(), keptBy: [] },
            release: 11,
            repo: REPO,
            card: 4,
            serve: 'answers',
            costToday: { hourly: 0.10004 },
          },
          {
            name: B,
            state: 'stopped',
            size: 'm8g.xlarge',
            workspace: null,
            release: null,
            card: 5,
            title: 'Pay by card',
            serve: null,
            // asleep, its root disk still costs (ADR 0022): the launch template's 60 GB of gp3
            costToday: { hourly: 0.20008, diskHourly: (60 * 0.088) / 730 },
          },
          {
            name: C,
            state: 'running',
            size: 'm8g.large',
            workspace: { repo: REPO, card: '7', state: 'running' },
          },
        ],
        queued: [],
      },
    });
    // asked in no checkout: no repo of its own to put first (#262)
    expect(out.doc.ok ? out.doc.data.here : 'refused').toBeUndefined();
    const listed = out.doc.ok ? out.doc.data.boxes : [];

    // Up since its LaunchTime, which the fake set when it was put a moment ago.
    expect(Date.now() - Date.parse(listed[0]?.launchedAt ?? '')).toBeLessThan(5 * 60_000);
    // Only the person's own boxes, by EC2's tag filter: hubot's demo-shop-8 is not there.
    expect(
      w.ec2
        .calls()
        .some((c) => c.includes('describe-instances --filters Name=tag:abe:owner,Values=octocat')),
    ).toBe(true);
    // The sleeping box is not asked: only the running ones' status went over the link.
    expect(w.shell.calls().toSorted()).toEqual([
      `${A} -- abe 'status' '--json'`,
      `${C} -- abe 'status' '--json'`,
    ]);
  });

  test('abe box list asked in a checkout names its GitHub repo, so its boxes come first (#262)', async () => {
    const repo = join(w.root, 'local', 'shop');

    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', repo], { env: { PATH: '/usr/bin:/bin' } });
    Bun.spawnSync(['git', '-C', repo, 'remote', 'add', 'origin', `git@github.com:${REPO}.git`], {
      env: { PATH: '/usr/bin:/bin' },
    });
    const out = await w.mac.jsonWith({ cwd: repo }, BoxListData, 'box', 'list');

    expect(out.doc.ok ? out.doc.data.here?.github : undefined).toBe(REPO);
  });

  test("abe --on: the box's serve answers, exactly as it printed it, exit code included", async () => {
    const cases = [
      ['status', '--json'],
      ['session', 'show', SESSION, '--json'],
      ['session', 'show', '4-0000', '--json'],
      ['session', 'show'],
      ['no-such', 'thing'],
    ];

    for (const argv of cases) {
      const there = await w.a.request(...argv);
      const here = await w.mac.run('--on', A, ...argv);

      // The fake's `abe` is a client of the box's serve, as on a real box.
      expect([argv, here.exit, here.stdout, here.stderr]).toEqual([
        argv,
        there.exit,
        there.stdout,
        there.stderr,
      ]);
    }
    expect(data(StatusData, (await w.mac.run('--on', A, 'status', '--json')).stdout).socket).toBe(
      w.a.state.socket,
    );
  });

  test("a tunnel that fails is said as box-unreachable, never as the box's answer", async () => {
    // A box EC2 runs that the link cannot reach (the fake shell has no serve for it).
    w.ec2.put({ name: 'demo-shop-6', repo: REPO, card: 6 });
    const out = await w.mac.run('--on', 'demo-shop-6', 'status', '--json');

    expect(out.exit).toBe(3);
    const error = z
      .object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
      .parse(JSON.parse(out.stdout)).error;

    expect(error.code).toBe('box-unreachable');
    expect(error.message).toContain('no route to box demo-shop-6');
    w.ec2.set('demo-shop-6', 'terminated');
  });

  test('a box that runs with its serve not answering yet: said so with the next step, never told to wake (#143)', async () => {
    // EC2 runs it; the box shell reaches it, but nothing answers on its serve's socket.
    w.ec2.put({ name: 'demo-shop-9', repo: REPO, card: 9 });
    w.shell.box('demo-shop-9', join(w.root, 'no-serve.sock'));
    const said =
      /^box demo-shop-9 is running · serve not answering · 0 min · still booting\? try again in a minute; abe box status demo-shop-9 says when it answers$/;
    const on = await w.mac.run('--on', 'demo-shop-9', 'session', 'list');

    expect(on.exit).toBe(3);
    expect(on.stderr.replace(/^abe: /, '').trim()).toMatch(said);
    const status = await w.mac.run('box', 'status', 'demo-shop-9');

    expect(status.stdout.split('\n')[1]?.trim()).toMatch(said);
    const json = await w.mac.json(BoxData, 'box', 'status', 'demo-shop-9');

    expect(json.doc.ok && json.doc.data).toMatchObject({
      serve: 'silent',
      reach: { kind: 'silent' },
    });
    w.ec2.set('demo-shop-9', 'terminated');
  });

  test('abe --on <box> session attach: abe box attach, the way in (ADR 0021)', async () => {
    const out = await w.mac.json(SessionAttachData, '--on', A, 'session', 'attach', SESSION);

    expect(out.doc.ok && out.doc.data.argv.slice(-5)).toEqual([
      'box',
      'attach',
      A,
      '--session',
      SESSION,
    ]);
  });

  test('abe session list in your environment: every running box asked, each session tagged', async () => {
    // The first list waits for the boxes only so long (#213 C7): a later one has their answers.
    const rows = await until('both boxes answered', async () => {
      const out = await w.mac.json(SessionListData, 'session', 'list');
      const got = out.doc.ok ? out.doc.data.sessions.map((s) => [s.id, s.box, s.state]) : [];

      return got.length === 2 ? got : undefined;
    });

    expect(rows).toEqual([
      [SESSION, A, 'waiting'],
      [SESSION_C, C, 'waiting'],
    ]);
  });

  test('with serve.target local: session list and watch stay on this Mac, no box asked', async () => {
    const local = await macServed({
      PATH: w.ec2.path,
      ABE_OWNER: w.ec2.owner,
      ABE_BOX_LINK: `exec:${w.shell.path}`,
      ABE_CONFIG_DIR: join(w.root, 'local'),
      ABE_CLOUD_POLL_MS: '40',
    });
    // The Mac in your environment follows A and C since its session list: their calls are in.
    await until('A and C followed', () =>
      [A, C].every((box) => w.shell.calls().includes(`${box} -- abe 'watch' '--json'`))
        ? true
        : undefined,
    );
    // The other Mac's last list asks its boxes behind its answer (#213 C7): that done first.
    const before = await until('the boxes asked no more', async () => {
      const n = w.shell.calls().length;

      await Bun.sleep(300);

      return w.shell.calls().length === n ? n : undefined;
    });

    await local.run('status');
    const theirs = local.watch('--json', '--since', '0');
    const seen = collect(theirs);

    try {
      // The watch on (its first frame): in your environment it would have looked for boxes by now.
      await until('the watch on', () => (seen.length > 0 ? true : undefined));
      const out = await local.json(SessionListData, 'session', 'list');

      expect(out.doc).toEqual({ ok: true, data: { sessions: [] } });
      // Its list seen by the watch: whatever the list and the watch asked of a box came before.
      await until('the list seen', () =>
        seen.some(
          (e) =>
            e.type === 'command.ran' &&
            z.object({ noun: z.string(), verb: z.string().nullable() }).parse(e.data).verb ===
              'list',
        )
          ? true
          : undefined,
      );
      expect(w.shell.calls().slice(before)).toEqual([]);
    } finally {
      theirs.close();
      await local.close();
    }
  });

  test("abe watch merges the box's events, tagged; a dropped tunnel reconnects with --since and loses none", async () => {
    watch = w.mac.watch('--json');
    seen = collect(watch);
    // The watch looked for boxes holding a session: A's and C's events are followed.
    await until('A and C followed', () =>
      [A, C].every((box) => w.shell.calls().includes(`${box} -- abe 'watch' '--json'`))
        ? true
        : undefined,
    );
    const fromA = await followedNow(seen, w.a, A, SESSION);
    const fromC = await followedNow(seen, w.c, C, SESSION_C);
    const turn = async (on: ServeScenario, session: string, text: string) => {
      const sent = await on.request('session', 'send', session, text, '--json');

      expect(sent.exit).toBe(0);
    };

    await turn(w.a, SESSION, 'first');
    await turn(w.c, SESSION_C, 'first');
    await until('the first turns merged', () =>
      statesOf(seen).length >= fromA + 2 && statesOf(seen, C, SESSION_C).length >= fromC + 2
        ? true
        : undefined,
    );
    expect(w.shell.drop(A, 'watch')).toBe(1);
    // While the tunnel is down: the box goes on without the Mac.
    await turn(w.a, SESSION, 'second');
    await until('the second turn merged', () =>
      statesOf(seen).length >= fromA + 4 ? true : undefined,
    );
    // Each box's own, tagged with it: none lost across the drop, none twice.
    expect(statesOf(seen).slice(fromA)).toEqual([
      ['UserPromptSubmit', 'working'],
      ['Stop', 'waiting'],
      ['UserPromptSubmit', 'working'],
      ['Stop', 'waiting'],
    ]);
    expect(statesOf(seen, C, SESSION_C).slice(fromC)).toEqual([
      ['UserPromptSubmit', 'working'],
      ['Stop', 'waiting'],
    ]);
    const again = w.shell.calls().filter((c) => c.includes("'watch'") && c.includes("'--since'"));

    expect(again.length).toBeGreaterThanOrEqual(1);
    // Numbered by the Mac's serve, one after another.
    const seqs = seen.map((e) => e.seq);

    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  test('a command to a sleeping box wakes it first: box.state starting, then running', async () => {
    const out = await w.mac.json(StatusData, '--on', B, 'status');

    expect(out.doc.ok && out.doc.data.socket).toBe(w.b.state.socket);
    const states = await until('B running said', () => {
      const said = seen
        .filter((e) => e.type === 'box.state')
        .map((e) =>
          z.object({ box: z.string(), state: z.string(), cause: z.string() }).parse(e.data),
        )
        .filter((d) => d.box === B);

      return said.some((d) => d.state === 'running') ? said : undefined;
    });

    expect(states.map((d) => [d.state, d.cause])).toEqual([
      ['starting', 'wake'],
      ['running', 'wake'],
    ]);
    // Between them, EC2 running and its serve waited for: the progress line's step (#193).
    expect(seen.filter((e) => e.type === 'box.step').map((e) => e.data)).toContainEqual({
      box: B,
      step: 'booting',
    });
    expect(w.ec2.instance(B)?.State).toBe('running');
  });

  test('abe --on <box> watch on a sleeping box: woken, then its own events, again after a drop with --since', async () => {
    // Stopped as a person in the console would (or its own idle stop).
    w.ec2.set(B, 'stopped');
    const theirs = watching(w.mac.state.socket, ['--on', B, 'watch', '--json']);
    const lines = collect(theirs);
    const ran = (n: number) =>
      until(`${n} of B's commands`, () =>
        lines.filter((e) => e.type === 'command.ran' && e.box === B).length >= n ? true : undefined,
      );

    try {
      await until('B followed', () =>
        w.shell.calls().some((c) => c.startsWith(`${B} -- abe 'watch'`)) ? true : undefined,
      );
      // Until one reaches the Mac: B's own watch has connected to its serve by then.
      for (let tries = 1; ; tries += 1) {
        await w.b.request('status');
        try {
          await until(
            "B's first command",
            () => (lines.some((e) => e.type === 'command.ran' && e.box === B) ? true : undefined),
            3000,
          );
          break;
        } catch (err) {
          if (tries >= 5) throw err;
        }
      }
      const first = lines.filter((e) => e.type === 'command.ran' && e.box === B).length;
      expect(w.shell.drop(B, 'watch')).toBe(1);
      await w.b.request('status');
      await ran(first + 1);
      expect(w.shell.calls().some((c) => c.startsWith(`${B} -- abe 'watch' '--since'`))).toBe(true);
    } finally {
      theirs.close();
    }
  });

  test('abe box stop and start: answered once EC2 says it is done', async () => {
    const stopped = await w.mac.json(BoxData, 'box', 'stop', B);

    expect(stopped.doc).toMatchObject({
      ok: true,
      data: { name: B, state: 'stopped', size: 'm8g.xlarge', workspace: null, serve: null },
    });
    const started = await w.mac.json(BoxData, 'box', 'start', B);

    expect(started.doc).toMatchObject({ ok: true, data: { name: B, state: 'running' } });
    const unknown = await w.mac.json(BoxData, 'box', 'start', 'nope-1');

    expect(unknown.exit).toBe(1);
    expect(unknown.doc).toMatchObject({ ok: false, error: { code: 'no-box' } });
  });

  test('abe box keep and sleep on a followed box: set on its own serve, its box.idle merged once', async () => {
    const idles = () => seen.filter((e) => e.type === 'box.idle');
    const before = idles().length;
    const kept = await w.mac.json(BoxKeepData, 'box', 'keep', A);

    expect(kept.doc).toMatchObject({
      ok: true,
      data: { box: A, idle: { stopsAt: null, keptBy: ['awake'] } },
    });
    // In the box's own state file, so its serve started again keeps it.
    expect(JSON.parse(readFileSync(join(w.a.state.dir, 'box-keep.json'), 'utf8'))).toMatchObject({
      awake: true,
    });
    const merged = await until('A box.idle merged', () => idles().slice(before).at(0));

    expect(merged).toMatchObject({ box: A, data: { box: A, idle: { keptBy: ['awake'] } } });
    const listed = await w.mac.json(BoxListData, 'box', 'list');

    expect(listed.doc.ok && listed.doc.data.boxes.find((b) => b.name === A)?.idle).toMatchObject({
      stopsAt: null,
      keptBy: ['awake'],
    });
    const slept = await w.mac.json(BoxKeepData, 'box', 'sleep', A);

    expect(slept.doc).toMatchObject({ ok: true, data: { box: A, idle: { keptBy: [] } } });
    expect(slept.doc.ok && slept.doc.data.idle.stopsAt).not.toBeNull();
    await until('both merged', () => (idles().length - before >= 2 ? true : undefined));
    await Bun.sleep(300);
    // Said by the box only: the Mac said none of its own (an untagged one) for a followed box.
    expect(
      idles()
        .slice(before)
        .map((e) => e.box),
    ).toEqual([A, A]);
  });
});

describe('keep awake, Stop now, terminate, the Queued rows and the uptime log (#104)', () => {
  const D = 'demo-shop-21';
  const F = 'demo-shop-22';

  test('the whole round on a box nothing follows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abe-k-'));
    const ec2 = fakeEc2({ owner: 'octocat', bootMs: 200, stopMs: 200 });
    const shell = fakeBoxShell(ec2);
    const host = {
      shutdown: () => Promise.resolve({ ok: true as const, data: null }),
      attached: () => Promise.resolve(false),
    };
    const box = await scenario({ box: true, idle: { name: D, host, everyMs: 3_600_000 } });

    const shop = join(root, 'shop');

    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
    // the repo's cap, in the checkout its commands are typed in
    checkoutAt(shop, 'limits.maxBoxesPerPerson: 2\n');
    ec2.put({ name: D, repo: REPO, card: 21, release: 11, launchedAt: Date.now() - 60_000 });
    // A box whose serve never answers (no box shell reaches it).
    ec2.put({ name: F, repo: REPO, card: 22, release: 11 });
    shell.box(D, box.state.socket);
    const mac = await macServed(
      {
        PATH: ec2.path,
        ABE_OWNER: ec2.owner,
        ABE_BOX_LINK: `exec:${shell.path}`,
        ABE_CONFIG_DIR: join(root, 'mine'),
        ABE_CLOUD_POLL_MS: '40',
      },
      { cwd: shop },
    );
    const keepFile = join(box.state.dir, 'box-keep.json');
    const uptime = join(mac.state.dir, 'box-uptime.jsonl');

    try {
      await mac.run('status');
      const watch = mac.watch('--json', '--since', '0');
      const seen = collect(watch);
      const states = () =>
        seen
          .filter((e) => e.type === 'box.state')
          .map((e) => z.object({ box: z.string(), state: z.string() }).parse(e.data))
          .filter((d) => d.box === D)
          .map((d) => d.state);

      try {
        await until('the watch on', () => (seen.length > 0 ? true : undefined));
        // Running, serve silent; today's cost counted from its LaunchTime.
        const first = await mac.json(BoxListData, 'box', 'list');
        const shownOf = (name: string) =>
          first.doc.ok ? first.doc.data.boxes.find((b) => b.name === name) : undefined;

        expect(shownOf(F)).toMatchObject({ state: 'running', serve: 'silent', release: 11 });
        expect(shownOf(D)).toMatchObject({
          serve: 'answers',
          costToday: { hourly: 0.10004 },
        });
        expect(shownOf(D)?.costToday?.minutes).toBeLessThanOrEqual(2);

        // Keep awake: on D's own serve, said by the Mac (D is not followed).
        const kept = await mac.json(BoxKeepData, 'box', 'keep', D);

        expect(kept.doc).toMatchObject({
          ok: true,
          data: { box: D, idle: { stopsAt: null, keptBy: ['awake'] } },
        });
        const said = await until('box.idle said', () => seen.find((e) => e.type === 'box.idle'));

        expect(said).toMatchObject({ data: { box: D, idle: { keptBy: ['awake'] } } });
        expect(said.box).toBeUndefined();
        expect(JSON.parse(readFileSync(keepFile, 'utf8'))).toMatchObject({ awake: true });

        // Stop now: the keep taken off first, then the box asleep.
        const stopped = await mac.json(BoxData, 'box', 'stop', D);

        expect(stopped.doc).toMatchObject({ ok: true, data: { name: D, state: 'stopped' } });
        expect(JSON.parse(readFileSync(keepFile, 'utf8'))).toMatchObject({ awake: false });
        const sleeps = shell
          .calls()
          .findIndex((c) => c === `${D} -- abe 'box' 'sleep' '${D}' '--json'`);

        expect(sleeps).toBeGreaterThanOrEqual(0);
        // Let sleep on a sleeping box: nothing to take off.
        const asleep = await mac.json(BoxKeepData, 'box', 'sleep', D);

        expect(asleep.doc).toMatchObject({ ok: false, error: { code: 'box-asleep' } });

        // Keep awake on a sleeping box: woken first, then kept.
        const woke = await mac.json(BoxKeepData, 'box', 'keep', D);

        expect(woke.doc).toMatchObject({ ok: true, data: { idle: { keptBy: ['awake'] } } });
        expect(states()).toEqual(['stopping', 'stopped', 'starting', 'running']);

        // The uptime log: up from its LaunchTime, down at the stop, up again at the wake.
        const lines = readFileSync(uptime, 'utf8')
          .trim()
          .split('\n')
          .map((l) => z.object({ box: z.string(), up: z.boolean() }).parse(JSON.parse(l)))
          .filter((l) => l.box === D)
          .map((l) => l.up);

        expect(lines).toEqual([true, false, true]);

        // At the limit (D and F run): a placement is Queued (the repo's box, ADR 0022), a row of box list.
        const placed = await mac.run(
          'box',
          'place',
          '23',
          '--repo',
          REPO,
          '--title',
          'Gift cards',
          '--apply',
        );

        expect(placed.exit).toBe(0);
        const queued = await mac.json(BoxListData, 'box', 'list');

        expect(queued.doc.ok && queued.doc.data.queued).toMatchObject([
          { box: 'demo-shop', repo: REPO, card: 23, title: 'Gift cards' },
        ]);
        expect((await mac.run('box', 'list')).stdout).toMatch(
          new RegExp(
            `demo-shop  queued since [^ ]+( UTC)?  ${REPO} card 23  \\(starts when one of yours stops\\)`,
          ),
        );

        // Terminate: asked first; IAM keeps it to a lead; as a lead, gone.
        const unasked = await mac.json(BoxData, 'box', 'terminate', D);

        expect(unasked.doc).toMatchObject({ ok: false, error: { code: 'confirm' } });
        const refusedAsDev = await mac.json(BoxData, 'box', 'terminate', D, '--yes');

        expect(refusedAsDev.exit).toBe(1);
        expect(refusedAsDev.doc).toEqual({
          ok: false,
          error: {
            code: 'terminate-refused',
            message: 'Terminate refused: only your lead can terminate boxes',
          },
        });
        expect(ec2.instance(D)?.State).toBe('running');
        ec2.lead(true);
        const ended = await mac.json(BoxData, 'box', 'terminate', D, '--yes');

        expect(ended.doc).toMatchObject({ ok: true, data: { name: D, state: 'shutting-down' } });
        await until('terminated said', () => (states().includes('terminated') ? true : undefined));
        // Gone from the list; and its room goes to the Queued placement, made then: on every list
        // meanwhile a Queued row or its box (starting until EC2 lists it), never neither.
        const after = await until('the Queued one made', async () => {
          const listed = await mac.json(BoxListData, 'box', 'list');

          if (!listed.doc.ok) return undefined;
          const { boxes, queued: rows } = listed.doc.data;

          expect([...rows.map((q) => q.box), ...boxes.map((b) => b.name)]).toContain('demo-shop');

          return rows.length === 0 ? listed.doc.data : undefined;
        });

        expect(after.boxes.map((b) => b.name)).toEqual(['demo-shop', F]);
      } finally {
        watch.close();
      }
    } finally {
      await mac.close();
      await box.close();
      shell.remove();
      ec2.remove();
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
  });
});

describe('abe box up, status and refusals', () => {
  test("abe box up: the repo's box made from the launch template at box.size, box.state starting then running once its serve answers", async () => {
    const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
    const shell = fakeBoxShell(ec2);
    const box = await scenario({ box: true });
    // ADR 0022: the repo's box, named for it
    const name = 'demo-shop';
    const mac = await macServed({
      PATH: ec2.path,
      ABE_OWNER: ec2.owner,
      ABE_BOX_LINK: `exec:${shell.path}`,
      ABE_CLOUD_POLL_MS: '40',
    });

    shell.box(name, box.state.socket);
    try {
      await mac.run('status');
      // From the first event on: its first frame (the status above) says it is on before box up.
      const watch = mac.watch('--json', '--since', '0');
      const seen = collect(watch);

      try {
        await until('the watch on', () => (seen.length > 0 ? true : undefined));
        const up = await mac.json(BoxData, 'box', 'up', REPO, 'AB#12', '--title', 'Pay by card');

        expect(up.doc).toMatchObject({
          ok: true,
          data: { name, state: 'running', size: 'm8g.xlarge', workspace: null },
        });
        const made = ec2.instance(name);
        const tag = (key: string) => made?.Tags.find((t) => t.Key === key)?.Value;

        expect([
          tag('abe:owner'),
          tag('abe:box'),
          tag('abe:repo'),
          tag('abe:card'),
          tag('abe:title'),
        ]).toEqual(['octocat', name, REPO, undefined, undefined]);
        expect(made?.profile).toBe('abe-box-octocat-boxes');
        // Running once its serve answered: its status over the link came before `running`.
        expect(shell.calls()).toContain(`${name} -- abe 'status' '--json'`);
        const states = await until('running said', () => {
          const said = seen
            .filter((e) => e.type === 'box.state')
            .map((e) =>
              z.object({ box: z.string(), state: z.string(), cause: z.string() }).parse(e.data),
            );

          return said.some((d) => d.state === 'running') ? said : undefined;
        });

        expect(states.map((d) => [d.box, d.state, d.cause])).toEqual([
          [name, 'starting', 'up'],
          [name, 'running', 'up'],
        ]);
        // Between them, EC2 running and its serve waited for: the progress line's step (#320)
        expect(seen.filter((e) => e.type === 'box.step').map((e) => e.data)).toContainEqual({
          box: name,
          step: 'booting',
        });
        // Up again: the same box, nothing made.
        const again = await mac.json(BoxData, 'box', 'up', REPO, '12');

        expect(again.doc).toMatchObject({ ok: true, data: { name, state: 'running' } });
        expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(1);
        const status = await mac.json(BoxData, 'box', 'status', name);

        expect(status.doc).toMatchObject({ ok: true, data: { name, state: 'running' } });
        const stopped = await mac.json(BoxData, 'box', 'stop', name);

        expect(stopped.doc).toMatchObject({ ok: true, data: { name, state: 'stopped' } });
        // Woken by up: started, not made again; its disk was kept.
        const woken = await mac.json(BoxData, 'box', 'up', REPO, '12');

        expect(woken.doc).toMatchObject({ ok: true, data: { name, state: 'running' } });
        expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(1);
        expect(ec2.calls().filter((c) => c.startsWith('ec2 start-instances'))).toHaveLength(1);
      } finally {
        watch.close();
      }
    } finally {
      await mac.close();
      await box.close();
      shell.remove();
      ec2.remove();
    }
  });

  test("abe box up in a checkout whose box.profile is another: made, listed and stopped on that profile's EC2", async () => {
    const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
    const work = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
    const shell = fakeBoxShell(work);
    const box = await scenario({ box: true });
    const root = mkdtempSync(join(tmpdir(), 'abe-profiles-'));
    const checkout = join(root, 'shop');
    const name = 'demo-shop';

    mkdirSync(join(root, 'mine'));
    writeFileSync(
      join(root, 'mine', 'settings.yaml'),
      'serve.target: cloud\nbox:\n  profile: abe-home\n',
    );
    // yours for the checkout names another profile: it wins there
    checkoutAt(checkout, '', 'box.profile: abe-work\n');
    const asked: string[] = [];
    const env = { PATH: ec2.path, ABE_OWNER: ec2.owner, ABE_CLOUD_POLL_MS: '40' };
    const mac = await macServed(
      { ...env, ABE_CONFIG_DIR: join(root, 'mine') },
      {
        boxProfile: { own: 'abe-home', pinned: false },
        // the work profile's AWS: its own EC2 and box shell
        awsAs: (profile) => {
          asked.push(profile);
          const as = { ...env, AWS_PROFILE: profile, PATH: work.path };
          const boxes = ec2BoxesFrom(as);

          return {
            ...awsFrom(as),
            reach: () => boxAwsReach(as, root),
            cloud: {
              boxes,
              link: boxLinkFrom({ ...as, ABE_BOX_LINK: `exec:${shell.path}` }, [], {
                aws: awsRunner(as),
                boxes,
              }),
            },
          };
        },
      },
    );

    shell.box(name, box.state.socket);
    try {
      const up = await mac.jsonWith({ cwd: checkout }, BoxData, 'box', 'up', REPO, '12');

      expect(up.doc).toMatchObject({ ok: true, data: { name, state: 'running' } });
      expect(asked).toEqual(['abe-work']);
      expect(work.instance(name)).toBeDefined();
      expect(ec2.instance(name)).toBeUndefined();
      // listed anywhere, with serve's own; stopped on its own profile's EC2
      const listed = await mac.json(BoxListData, 'box', 'list');

      expect(listed.doc.ok && listed.doc.data.boxes.map((b) => b.name)).toEqual([name]);
      // found by name, anywhere: the profile box attach and forward reach it on
      const found = await mac.json(BoxData, 'box', 'status', name);

      expect(found.doc.ok && found.doc.data.aws).toEqual({ profile: 'abe-work', region: null });
      const stopped = await mac.json(BoxData, 'box', 'stop', name);

      expect(stopped.doc).toMatchObject({ ok: true, data: { name, state: 'stopped' } });
      expect(work.calls().filter((c) => c.startsWith('ec2 stop-instances'))).toHaveLength(1);
      expect(ec2.calls().filter((c) => c.startsWith('ec2 stop-instances'))).toHaveLength(0);
      // its SSO login expired: box list says so, never drops its boxes silently
      work.expire(true);
      const text = await mac.run('box', 'list');

      const said = text.stdout.split('\n').filter((l) => l.startsWith('abe-work:'));

      expect(said).toHaveLength(1);
      expect(said[0]).toStartWith('abe-work: its boxes not listed: not logged in to AWS (');
      expect(said[0]).toEndWith('run `aws sso login --profile abe-work`');
    } finally {
      await mac.close();
      await box.close();
      shell.remove();
      work.remove();
      ec2.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no AWS login with serve.target cloud: session list shows this Mac's, says why once, and EC2 is asked once a scan", async () => {
    const ec2 = fakeEc2({ owner: 'octocat' });
    const mine = mkdtempSync(join(tmpdir(), 'abe-mine-'));

    writeFileSync(join(mine, 'settings.yaml'), 'serve.target: cloud\n');
    const mac = await macServed({
      PATH: ec2.path,
      ABE_OWNER: ec2.owner,
      AWS_PROFILE: 'abe-tooling',
      ABE_BOX_LINK: 'exec:/nonexistent',
      ABE_CONFIG_DIR: mine,
    });

    ec2.expire(true);
    try {
      const text = await mac.run('session', 'list');

      expect([text.exit, text.stdout]).toEqual([0, 'no sessions\n']);
      expect(text.stderr).toContain('your boxes were not read');
      expect(text.stderr).toContain('aws sso login --profile abe-tooling');
      expect(text.stderr).toContain('serve.target: local');
      const asked = ec2.calls().filter((c) => c.includes('describe-instances')).length;
      const json = await mac.json(SessionListData, 'session', 'list');

      expect(json.doc).toMatchObject({ ok: true, data: { sessions: [] } });
      expect(json.doc.ok && json.doc.data.boxes).toContain('aws sso login --profile abe-tooling');
      // A failed read is kept for the scan: the second list asked EC2 nothing.
      expect(ec2.calls().filter((c) => c.includes('describe-instances')).length).toBe(asked);
      // A watcher is told once, however often the boxes were not read.
      const watch = mac.watch('--json', '--since', '0');
      const seen = collect(watch);

      try {
        await until('both lists seen by the watch', () =>
          seen.filter((e) => e.type === 'command.ran').length >= 2 ? true : undefined,
        );
        expect(seen.filter((e) => e.type === 'boxes.unread')).toMatchObject([
          { data: { code: 'aws-auth', profile: 'abe-tooling' } },
        ]);
      } finally {
        watch.close();
      }
    } finally {
      await mac.close();
      ec2.remove();
      rmSync(mine, { recursive: true, force: true });
    }
  });

  test("a profile with an IAM user's keys: boxes listed, refused keys said with aws configure", async () => {
    const ec2 = fakeEc2({ owner: 'octocat', keys: true });
    const mine = mkdtempSync(join(tmpdir(), 'abe-mine-'));

    writeFileSync(join(mine, 'settings.yaml'), 'serve.target: cloud\n');
    const mac = cli({
      env: {
        PATH: ec2.path,
        ABE_OWNER: ec2.owner,
        AWS_PROFILE: 'own',
        ABE_BOX_LINK: 'exec:/nonexistent',
        ABE_CONFIG_DIR: mine,
      },
    });

    mkdirSync(join(mac.state.dir, '.aws'), { recursive: true });
    writeFileSync(join(mac.state.dir, '.aws', 'config'), '[profile own]\nregion = eu-west-1\n');
    writeFileSync(
      join(mac.state.dir, '.aws', 'credentials'),
      '[own]\naws_access_key_id = AKIAFAKEFAKEFAKE\naws_secret_access_key = fake\n',
    );
    ec2.put({ name: 'shop-1', repo: 'o/shop', card: 1 });
    try {
      const listed = await mac.json(BoxListData, 'box', 'list');

      expect(listed.doc.ok && listed.doc.data.boxes.map((b) => b.name)).toEqual(['shop-1']);
      ec2.expire(true);
      const refused = await mac.json(BoxListData, 'box', 'list');

      expect(refused.doc).toMatchObject({
        ok: false,
        error: { code: 'aws-auth', profile: 'own', keys: true },
      });
      expect(refused.doc.ok ? '' : refused.doc.error.message).toEndWith(
        'run `aws configure --profile own`',
      );
    } finally {
      await mac.close();
      ec2.remove();
      rmSync(mine, { recursive: true, force: true });
    }
  });

  test("refusals: another owner's box, the limit, IAM, an expired login", async () => {
    const root = mkdtempSync(join(tmpdir(), 'abe-b-'));
    const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });

    const shop = join(root, 'shop');

    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
    // yours for the checkout lowers the cap to one box
    checkoutAt(shop, '', 'limits.maxBoxesPerPerson: 1\n');
    ec2.put({ name: 'shop-1', repo: 'o/shop', card: 1 });
    ec2.put({ name: 'shop-8', owner: 'hubot', repo: 'o/shop', card: 8 });
    const env = {
      PATH: ec2.path,
      ABE_BOX_LINK: 'exec:/nonexistent',
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_CLOUD_POLL_MS: '40',
    };
    const mac = cli({ env: { ...env, ABE_OWNER: 'octocat' }, cwd: shop });
    // Someone naming hubot's login: they see hubot's boxes, but IAM knows who they are.
    const posing = cli({ env: { ...env, ABE_OWNER: 'hubot' }, cwd: shop });

    try {
      // Another owner's box is not yours: not listed, not found.
      const listed = await mac.json(BoxListData, 'box', 'list');

      expect(listed.doc).toMatchObject({ ok: true });
      expect(listed.doc.ok && listed.doc.data.boxes.map((b) => b.name)).toEqual(['shop-1']);
      for (const verb of ['status', 'stop', 'start']) {
        const out = await mac.json(BoxData, 'box', verb, 'shop-8');

        expect([verb, out.exit, out.doc]).toMatchObject([
          verb,
          1,
          { ok: false, error: { code: 'no-box' } },
        ]);
      }
      // A repo or card abe cannot read is a usage error, as box place says it.
      for (const [repo, card] of [
        ['shop', '2'],
        ['o/shop', 'x'],
      ] as const) {
        const bad = await mac.json(BoxData, 'box', 'up', repo, card);

        expect([repo, card, bad.exit, bad.doc]).toMatchObject([
          repo,
          card,
          2,
          { ok: false, error: { code: 'usage' } },
        ]);
      }
      // At your limit (one box up): a second card's box is refused, nothing made.
      const over = await mac.json(BoxData, 'box', 'up', 'o/shop', '2');

      expect(over.doc).toMatchObject({ ok: false, error: { code: 'box-limit' } });
      expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toHaveLength(0);
      // IAM: hubot's box stopped by someone who is not hubot.
      const refused = await posing.json(BoxData, 'box', 'stop', 'shop-8');

      expect(refused.doc).toMatchObject({ ok: false, error: { code: 'aws-refused' } });
      expect(ec2.instance('shop-8')?.State).toBe('running');
      // The SSO login ran out: say how to log in again.
      ec2.expire(true);
      const expired = await mac.json(BoxListData, 'box', 'list');

      expect(expired.doc).toMatchObject({ ok: false, error: { code: 'aws-auth' } });
      const on = await mac.run('--on', 'shop-1', 'status', '--json');

      expect(on.exit).toBe(1);
      expect(JSON.parse(on.stdout)).toMatchObject({ ok: false, error: { code: 'aws-auth' } });
    } finally {
      await mac.close();
      await posing.close();
      ec2.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a box answer the link never got (#194)', () => {
  test('an expired AWS login says only that, never that the box answered', () => {
    const login = 'not logged in to AWS (token expired): run `aws sso login --profile abe-tooling`';
    const out = answerOf(StatusData, { exit: 255, stdout: '', stderr: `${login}\n` });

    expect(out).toEqual({ ok: false, error: { code: 'box-unreachable', message: login } });
  });

  test('a box that ran something other than abe still says so', () => {
    const out = answerOf(StatusData, { exit: 1, stdout: 'bash: abe: not found', stderr: '' });

    expect(!out.ok && out.error.message).toBe(
      'the box answered no abe reply: bash: abe: not found',
    );
  });
});
