/**
 * `abe factory`: a real `serve` in this process, the fake Azure DevOps for the cards, a real git
 * checkout, and the fake `claude` in a real `tmux`, scripted to decide, change its mind when told
 * to in Chat, and move its run through every stage from inside its session with the real `abe`;
 * a second session's socket is refused another's run. Your environment is one EC2 never answers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  type Boxes,
  type BoxLink,
  cardBranch,
  EventLine,
  FACTORY_RUN_INSTRUCTIONS,
  agentEnvsLine,
  FactoryBaseWorktreeData,
  PLAIN_SESSION_INSTRUCTIONS,
  FactoryRunData,
  FactoryStatusData,
  NO_CHECKS_RUN,
  SessionData,
} from '@abe/core';
import {
  claudeOutput,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  type FakeStep,
  scriptClaude,
  served,
  type ServedCli,
  until,
  watching,
  type Watching,
} from '@abe/testing';
import { adoBoardFrom, ghTrackingFrom } from '@abe/ports';
import { z } from 'zod';

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

type World = {
  root: string;
  repo: string;
  ado: FakeAdo;
  az: FakeAz;
  claude: FakeClaude;
  abe: ServedCli;
};

/** EC2 and the link to a box with no `aws` to run: every ask fails, as on a Mac without it. */
const noAws = <T>(): Promise<Answered<T>> =>
  Promise.resolve({ ok: false, error: { code: 'aws-failed', message: 'no aws in this test' } });
const unreachable: Boxes = {
  list: noAws,
  status: noAws,
  up: noAws,
  start: noAws,
  stop: noAws,
  resize: noAws,
  terminate: noAws,
};
const noLink: BoxLink = {
  run: () => Promise.resolve({ exit: 3, stdout: '', stderr: 'no aws in this test' }),
  follow: () => ({ stop: () => undefined, ended: Promise.resolve(3) }),
  attach: () => [],
  forward: noAws,
};

/** `mine`: yours on this Mac (default: sessions on this Mac). Commands are typed in `demo`. */
const world = async (o: { mine?: string } = {}): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-f-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), o.mine ?? 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\nenvironments: {}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  const env = { PATH: `${claude.dir}:${az.dir}:/usr/bin:/bin`, ...ado.env };
  // As the real serve wires it (app.ts): the board through az, tracking through gh, your boxes.
  const abe = await served({
    cwd: repo,
    env: { ABE_CONFIG_DIR: join(root, 'mine') },
    sessions: { env },
    board: adoBoardFrom({ ...ado.env, PATH: `${az.dir}:/usr/bin:/bin` }, join(root, 'images')),
    tracking: ghTrackingFrom(env),
    cloud: { boxes: unreachable, link: noLink, self: ['abe'], sleep: (ms) => Bun.sleep(ms) },
  });

  return { root, repo, ado, az, claude, abe };
};

const done = async (w: World) => {
  await w.abe.close();
  await w.ado.stop();
  w.az.remove();
  w.claude.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const StageEvent = z.object({
  type: z.literal('factory.stage'),
  data: z.object({
    session: z.string(),
    stage: z.string(),
    from: z.string().nullable(),
    state: z.string(),
    cause: z.string(),
  }),
});

type Seen = [from: string | null, stage: string, state: string, cause: string];

/** `id`'s `factory.stage` events read from a watch until `last` says stop. */
const stagesUntil = async (w: Watching, id: string, last: (e: Seen) => boolean) => {
  const seen: Seen[] = [];

  for (;;) {
    const event = StageEvent.safeParse(EventLine.parse(JSON.parse(await w.next(10_000))));

    if (!event.success || event.data.data.session !== id) continue;
    const d = event.data.data;
    const e: Seen = [d.from, d.stage, d.state, d.cause];

    seen.push(e);
    if (last(e)) return seen;
  }
};

const run = async (abe: ServedCli, card: string, repo: string) => {
  const out = await abe.json(FactoryRunData, 'factory', 'run', card, '--repo', repo);

  if (!out.doc.ok) throw new Error(`factory run refused: ${JSON.stringify(out.doc.error)}`);

  return out.doc.data;
};

const status = async (abe: ServedCli, card: string) => {
  const out = await abe.json(FactoryStatusData, 'factory', 'status', card);

  if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

  return out.doc.data.runs;
};

const factory = (...argv: string[]): FakeStep => ({ abe: ['factory', ...argv, '--json'] });

/** What the fake's `abe` runs printed, in order: exit code and the error code or the stage. */
const ran = (worktree: string) =>
  claudeOutput(worktree).abe.map((line) => {
    const r = z.object({ exit: z.number(), stdout: z.string() }).parse(line);
    const doc = z
      .object({ ok: z.boolean(), data: z.object({ stage: z.string().optional() }).optional() })
      .extend({ error: z.object({ code: z.string() }).optional() })
      .parse(JSON.parse(r.stdout));

    return [r.exit, doc.data?.stage ?? doc.error?.code];
  });

/** `ran`, once the fake has logged `n` `abe` runs (it logs each after its answer). */
const ranAll = async (worktree: string, n: number) => {
  await until(
    () => `${n} abe runs, not ${JSON.stringify(ran(worktree))}`,
    () => (claudeOutput(worktree).abe.length >= n ? true : undefined),
  );

  return ran(worktree);
};

describe('a Feature run: every step, a gate, Needs you', () => {
  let w: World;
  let first: z.infer<typeof FactoryRunData>;
  let watch: Watching;
  const turns: Seen[][] = [];

  beforeAll(async () => {
    w = await world();
    // Claude Code's own config, as the person has it: Abe adds only its worktree's trust.
    writeFileSync(
      join(w.abe.state.dir, '.claude.json'),
      JSON.stringify({ numStartups: 7, projects: { '/elsewhere': { allowedTools: ['Bash'] } } }),
    );
    scriptClaude(
      w.abe.state.dir,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        factory('stage-done', 'build', '--report', 'README.md'),
        { say: 'Specified, built; checks passed; in review.' },
      ],
      {
        'go on': [
          factory('review', '--findings', '0'),
          factory(
            'needs-you',
            '--reason',
            'which test account?',
            '--option',
            'the demo account',
            '--option',
            'a new one',
          ),
          { say: 'Which test account should verification sign in with?' },
        ],
        'use the demo account': [
          factory('verify', '--phase', 'after', '--result', 'pass', '--report', 'README.md'),
          // the playbook's gate: one yes/no call on the diff
          factory('judge', '--answer', 'no', '--reason', 'nothing to do by hand'),
          factory('stage-done', 'pr'),
        ],
      },
    );
    watch = watching(w.abe.state.socket);
    first = await run(w.abe, '4', w.repo);
    const stop = (e: Seen) => e[3] === 'Stop';

    turns.push(await stagesUntil(watch, first.session, stop));
    for (const [line, last] of [
      // Already needs you when its turn stops: the Stop changes nothing.
      ['go on', (e: Seen) => e[3] === 'needs-you'],
      // The pr stage is serve's: stage-done pr is refused, and the turn stops in pr.
      ['use the demo account', stop],
    ] as const) {
      await w.abe.run('session', 'send', first.session, line);
      turns.push(await stagesUntil(watch, first.session, last));
    }
  }, 60_000);
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  test('factory run --json: a session on the card and its run at its first step', async () => {
    expect(first).toMatchObject({
      card: 4,
      title: 'As a visitor I can sign in with email',
      // by its real path, as git names its worktree (#337)
      repo: realpathSync(w.repo),
      stage: 'spec',
      step: 'create-specification',
      state: 'running',
      workflow: { id: 'feature', layer: 'built-in' },
      context: { step: 'create-specification', skill: 'create-specification', fresh: false },
      stages: [],
    });
    const session = await w.abe.json(SessionData, 'session', 'show', first.session);

    expect(session.doc.ok && session.doc.data.worktree).toBe(first.worktree);
    const argv = z.array(z.string()).parse(claudeOutput(first.worktree).argv);

    // A repo that needs no database: no note of one (#349; Docker's absence is local-verify's).
    // and which environments it reaches (ADR 0029)
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(
      `${FACTORY_RUN_INSTRUCTIONS}\n\n${agentEnvsLine(['dev', 'test'])}`,
    );
    // The launch prompt invokes core's factory skill on the card.
    expect(argv.at(-1)).toStartWith('/abe:factory Work on card AB#4: As a visitor I can sign in');
  });

  test("the worktree Abe made is trusted in Claude Code's config: no trust dialog", () => {
    expect(claudeOutput(first.worktree).trust).toEqual({ asked: false });
    const config: unknown = JSON.parse(readFileSync(join(w.abe.state.dir, '.claude.json'), 'utf8'));

    expect(config).toMatchObject({
      numStartups: 7,
      projects: {
        '/elsewhere': { allowedTools: ['Bash'] },
        [first.worktree]: { hasTrustDialogAccepted: true },
      },
    });
  });

  test('the spec hands over to to-tickets, to-tickets to build, build to checks, checks pass to review', () => {
    expect(turns[0]).toEqual([
      [null, 'spec', 'running', 'run'],
      ['spec', 'step', 'running', 'stage-done'],
      ['step', 'build', 'running', 'stage-done'],
      ['build', 'checks', 'running', 'stage-done'],
      ['checks', 'review', 'running', 'checks'],
      [null, 'review', 'needs-you', 'Stop'],
    ]);
  });

  test('needs you, said by the agent, holds until the person answers; the gate says no', async () => {
    expect(turns[1]).toEqual([
      [null, 'review', 'running', 'UserPromptSubmit'],
      ['review', 'verify', 'running', 'review'],
      [null, 'verify', 'needs-you', 'needs-you'],
    ]);
    expect(turns[2]).toEqual([
      [null, 'verify', 'running', 'UserPromptSubmit'],
      ['verify', 'step', 'running', 'verify'],
      ['step', 'pr', 'running', 'judge'],
      [null, 'pr', 'needs-you', 'Stop'],
    ]);
    // Every command it ran from inside its session was answered.
    expect(await ranAll(first.worktree, 8)).toEqual([
      [0, 'step'],
      [0, 'build'],
      [0, 'review'],
      [0, 'verify'],
      [0, 'verify'],
      [0, 'step'],
      [0, 'pr'],
      [1, 'pr-by-serve'],
    ]);
  });

  test("status: stage, state, since and each finished stage's duration", async () => {
    const [now] = await status(w.abe, 'AB#4');

    expect(now).toMatchObject({
      stage: 'pr',
      state: 'needs-you',
      outcome: null,
      reason: 'waiting on you in Chat',
      judgements: [{ step: 'playbook', kind: 'gate', answer: false }],
      // #159: demo has no pack, so no check has a command: its checks ran nothing (and typed
      // nothing in: the turns above have no extra one), on to review all the same.
      noChecks: true,
    });
    // the playbook its gate skipped was never worked: no stage of it
    expect(now?.stages.map((s) => s.stage)).toEqual([
      'spec',
      'step',
      'build',
      'checks',
      'review',
      'verify',
    ]);
    for (const s of now?.stages ?? [])
      expect(s.durationMs).toBe(Date.parse(s.endedAt) - Date.parse(s.startedAt));
    expect(Date.parse(now?.since ?? '')).toBe(Date.parse(now?.stages.at(-1)?.endedAt ?? ''));
    const report = now?.stages[2]?.report ?? '';

    expect(report).toStartWith(join(w.abe.state.dir, 'sessions', first.session, 'reports'));
    expect(readFileSync(report, 'utf8')).toBe('# demo\n');
    const text = await w.abe.run('factory', 'status', '4');

    expect(text.stdout).toStartWith(
      `AB#4  pr  needs you since ${now?.since ?? ''}  ${first.session}`,
    );
    expect(text.stdout).toContain(`\n  checks    ${NO_CHECKS_RUN}\n`);
    const md = readFileSync(join(first.worktree, '.scratch', '4', 'checks.md'), 'utf8');

    expect(md).toContain('No checks configured, nothing was run, at ');
    expect(md).toContain('## tests · not configured');
  });

  test('from outside a session the agent commands exit 1 with not-in-session', async () => {
    for (const argv of [
      ['factory', 'stage-done', 'build'],
      ['factory', 'needs-you', '--reason', 'x'],
      ['factory', 'judge', '--answer', 'yes', '--reason', 'x'],
    ]) {
      const out = await w.abe.json(z.unknown(), ...argv);

      expect([out.exit, out.doc]).toMatchObject([
        1,
        { ok: false, error: { code: 'not-in-session' } },
      ]);
    }
  });

  test("a refused move: the wrong stage, and pr's end, which is serve's", async () => {
    for (const [argv, code] of [
      [['factory', 'stage-done', 'build'], 'not-this-stage'],
      [['factory', 'stage-done', 'pr'], 'pr-by-serve'],
      [['factory', 'judge', '--answer', 'yes', '--reason', 'x'], 'nothing-to-judge'],
      [['factory', 'run', '5', '--repo', w.repo], 'not-in-session'],
    ] as const) {
      // On the session's own socket, as its agent asks.
      const out = await w.abe.scenario.requestAs(first.session, w.abe.state.dir, ...argv, '--json');

      expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: { code } });
    }
  });

  test(
    "a second session's socket: its own run only, never another's",
    { timeout: 20_000 },
    async () => {
      scriptClaude(w.abe.state.dir, [
        factory('status', '4'),
        factory('stage-done', 'build'),
        factory('stage-done', 'investigate', '--report', 'README.md'),
        { say: 'That is a question: the answer is on the card.' },
      ]);
      // Investigate, picked: no on: preselects it
      const picked = await w.abe.json(
        FactoryRunData,
        ...['factory', 'run', '5', '--repo', w.repo, '--workflow', 'investigate'],
      );

      if (!picked.doc.ok) throw new Error(JSON.stringify(picked.doc.error));
      const second = picked.doc.data;
      const seen = await stagesUntil(watch, second.session, (e) => e[2] === 'done');

      expect(seen).toEqual([
        [null, 'step', 'running', 'run'],
        ['step', 'done', 'done', 'stage-done'],
      ]);
      expect(await ranAll(second.worktree, 3)).toEqual([
        [1, 'not-your-session'],
        [1, 'not-this-stage'],
        [0, 'done'],
      ]);
      const [q] = await status(w.abe, '5');

      // its ends: the run ended with its report
      expect(q).toMatchObject({
        state: 'done',
        outcome: 'reported',
        workflow: { id: 'investigate', name: 'Investigate' },
        reported: { step: 'investigate' },
        stages: [{ stage: 'step' }],
      });
      // Run 4 is as it was.
      expect((await status(w.abe, '4'))[0]?.stages).toHaveLength(6);
      const all = await w.abe.json(FactoryStatusData, 'factory', 'status');

      expect(all.doc.ok && all.doc.data.runs.map((r) => r.card)).toEqual([4, 5]);
    },
  );

  test(
    "a plain session (#186): told there is no run, and each factory command's refusal says so",
    { timeout: 20_000 },
    async () => {
      scriptClaude(w.abe.state.dir, [
        factory('stage-done', 'create-specification'),
        factory('status', '6'),
        factory('status'),
        factory('status', '4'),
        factory('checks', '6'),
        factory('stage-done', 'build'),
      ]);
      const plain = await w.abe.json(
        SessionData,
        'session',
        'launch',
        '--card',
        '6',
        '--repo',
        w.repo,
      );

      if (!plain.doc.ok) throw new Error(JSON.stringify(plain.doc.error));
      const { id, worktree } = plain.doc.data;
      expect(await ranAll(worktree, 6)).toEqual(Array.from({ length: 6 }, () => [1, 'no-run']));
      const argv = z.array(z.string()).parse(claudeOutput(worktree).argv);

      // Its instructions say there is no run here; its prompt is the card's, no factory skill.
      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(
        `${PLAIN_SESSION_INSTRUCTIONS}\n\n${agentEnvsLine(['dev', 'test'])}`,
      );
      expect(argv.at(-1)).toStartWith('Work on card AB#6: ');
      const says = (n: number) => {
        const line = z.object({ stdout: z.string() }).parse(claudeOutput(worktree).abe[n]);

        return z.object({ error: z.object({ message: z.string() }) }).parse(JSON.parse(line.stdout))
          .error.message;
      };
      const plainly = `session ${id} is not a Factory run: do the card's work here without \`abe factory\`. A person starts a run with \`abe factory run 6\`.`;

      expect(says(0)).toBe(plainly);
      // Its own card, which no session runs: no run on it, not "only its own run".
      expect(says(1)).toBe(`no run on AB#6: ${plainly}`);
      expect(says(2)).toBe(plainly);
      // Card 4 has a run, in another session: never named to a plain session.
      expect(says(3)).toBe(plainly);
      expect(says(4)).toBe(`no run on AB#6: ${plainly}`);
      expect(says(5)).toBe(plainly);
    },
  );

  test(
    'ended as Abandoned (#230): its factory.stage says how and the stage it was given up in',
    { timeout: 20_000 },
    async () => {
      const ended = await w.abe.run(
        'factory',
        'end',
        '4',
        '--as',
        'abandoned',
        '--reason',
        'not needed',
      );

      expect(ended.exit).toBe(0);
      const Ended = z.object({
        type: z.literal('factory.stage'),
        data: z.object({
          session: z.literal(first.session),
          outcome: z.string().nullable(),
          ended: FactoryRunData.shape.ended.optional(),
        }),
      });

      for (;;) {
        const event = Ended.safeParse(EventLine.parse(JSON.parse(await watch.next(10_000))));

        if (!event.success || event.data.data.outcome === null) continue;
        expect(event.data.data).toMatchObject({
          outcome: 'abandoned',
          ended: { as: 'abandoned', reason: 'not needed', from: 'pr' },
        });

        return;
      }
    },
  );
});

describe('factory run --target: where the session runs, over serve.target', () => {
  let w: World;
  /** A second checkout of the same board. No checkout here has a GitHub origin. */
  let cloudy: string;

  beforeAll(async () => {
    // yours on this Mac sends sessions to your environment
    w = await world({ mine: 'serve.target: cloud\n' });
    cloudy = join(w.root, 'cloudy');
    mkdirSync(join(cloudy, '.abe'), { recursive: true });
    git(cloudy, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(cloudy, 'abe.yaml'),
      `board: ${JSON.stringify(w.ado.board)}\nenvironments: {}\n`,
    );
    writeFileSync(join(cloudy, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
    writeFileSync(join(cloudy, '.abe', 'settings.local.yaml'), '');
    git(cloudy, 'add', '.');
    git(cloudy, 'commit', '-q', '-m', 'first');
    scriptClaude(w.abe.state.dir, [{ say: 'Deciding.' }]);
  }, 30_000);
  afterAll(async () => {
    await done(w);
  });

  test('no --target: serve.target decides, here your environment, refused for want of an origin', async () => {
    const out = await w.abe.json(FactoryRunData, 'factory', 'run', '5', '--repo', cloudy);

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-github-repo' } });
  });

  test('--target local-sandbox: on this Mac, whatever serve.target says', async () => {
    const out = await w.abe.json(
      FactoryRunData,
      'factory',
      'run',
      '5',
      '--repo',
      cloudy,
      '--target',
      'local-sandbox',
    );

    expect(out.exit).toBe(0);
    expect(out.doc).toMatchObject({
      ok: true,
      data: { card: 5, repo: realpathSync(cloudy), stage: 'spec' },
    });
  });

  test('--target cloud: your environment, whatever serve.target says (so: no origin)', async () => {
    const out = await w.abe.json(
      FactoryRunData,
      'factory',
      'run',
      '6',
      '--repo',
      w.repo,
      '--target',
      'cloud',
    );

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-github-repo' } });
  });

  test("--target local: refused, a local session runs in Claude Code's sandbox only", async () => {
    const out = await w.abe.json(
      FactoryRunData,
      'factory',
      'run',
      '6',
      '--repo',
      w.repo,
      '--target',
      'local',
    );

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-unsandboxed' } });
    if (!out.doc.ok) expect(out.doc.error.message).toContain('--target local-sandbox');
  });

  test('a target outside the list is a usage error', async () => {
    const out = await w.abe.json(FactoryRunData, 'factory', 'run', '6', '--target', 'moon');

    expect(out.exit).toBe(2);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'usage' } });
  });
});

describe('review rounds and Verification levels, from inside the session', () => {
  let w: World;
  let watch: Watching;
  const runs = new Map<number, z.infer<typeof FactoryRunData>>();
  const seen = new Map<number, Seen[]>();
  /** The repo's first commit: card 8's branch starts there, and main moves on after it. */
  let first = '';

  const report = (worktree: string, card: number, kind: string, name: string) =>
    join(worktree, '.scratch', String(card), kind, name);

  /** Runs `card` with `steps` as the fake's first turn; its events until `last`. */
  const runCard = async (card: number, steps: FakeStep[], last: (e: Seen) => boolean) => {
    scriptClaude(w.abe.state.dir, steps);
    const r = await run(w.abe, String(card), w.repo);

    runs.set(card, r);
    seen.set(card, await stagesUntil(watch, r.session, last));
  };

  const BUILT = ['stage-done', 'build'];

  beforeAll(async () => {
    w = await world();
    first = git(w.repo, 'rev-parse', 'HEAD');
    git(w.repo, 'branch', cardBranch('8', 'Sign-in button overlaps the logo on narrow screens'));
    writeFileSync(join(w.repo, 'later.txt'), 'main moved on\n');
    git(w.repo, 'add', '.');
    git(w.repo, 'commit', '-q', '-m', 'later');
    watch = watching(w.abe.state.socket);
    const needsYou = (cause: string) => (e: Seen) => e[2] === 'needs-you' && e[3] === cause;

    await runCard(
      7,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        factory(...BUILT),
        factory('review', '--findings', '2', '--report', 'README.md'),
        factory(...BUILT),
        factory('review', '--findings', '1', '--report', 'README.md'),
        factory(...BUILT),
        factory('review', '--findings', '1', '--report', 'README.md'),
        // While it needs you no clean review is taken, however often asked.
        factory('review', '--findings', '0'),
        factory('review', '--findings', '0'),
        factory('review', '--findings', '0'),
        { say: 'Review keeps finding things.' },
      ],
      needsYou('review'),
    );
    // A Bug card: Bug, preselected by its type, reproduces it first
    await runCard(
      8,
      [
        factory('base-worktree'),
        factory('verify', '--phase', 'after', '--result', 'pass', '--report', 'README.md'),
        factory(
          'verify',
          '--phase',
          'before',
          '--result',
          'not-reproduced',
          '--report',
          'README.md',
        ),
        { say: 'The bug does not show on the merge base.' },
      ],
      (e) => e[1] === 'done',
    );
    await runCard(
      5,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        factory(...BUILT),
        factory('review', '--findings', '0', '--report', 'README.md'),
        factory('verify', '--phase', 'after', '--result', 'pass', '--report', 'README.md'),
        // the playbook's gate says yes: the step runs, and writes none after all
        factory('judge', '--answer', 'yes', '--reason', 'a migration'),
        factory('stage-done', 'playbook'),
        factory('stage-done', 'pr'),
      ],
      (e) => e[0] === 'step' && e[1] === 'pr',
    );
    await runCard(
      13,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        factory(...BUILT),
        factory('review', '--findings', '0'),
        factory(
          'verify',
          '--phase',
          'after',
          '--result',
          'pass',
          '--report',
          'README.md',
          '--regression',
          'checkout.spec, cart.spec',
        ),
        { say: 'Verified, regression tests named.' },
      ],
      (e) => e[1] === 'step',
    );
  }, 90_000);
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  const runOf = (card: number) => {
    const r = runs.get(card);

    if (r === undefined) throw new Error(`no run for AB#${card}`);

    return r;
  };

  test('findings go back to build twice; the third round stops at Needs you', async () => {
    const r = runOf(7);

    // No clean review moves it on: only the person does.
    expect((await ranAll(r.worktree, 10)).slice(-4)).toEqual([
      [0, 'review'],
      [1, 'needs-you'],
      [1, 'needs-you'],
      [1, 'needs-you'],
    ]);

    expect(seen.get(7)).toEqual([
      [null, 'spec', 'running', 'run'],
      ['spec', 'step', 'running', 'stage-done'],
      ['step', 'build', 'running', 'stage-done'],
      ['build', 'checks', 'running', 'stage-done'],
      ['checks', 'review', 'running', 'checks'],
      ['review', 'build', 'running', 'review'],
      ['build', 'checks', 'running', 'stage-done'],
      ['checks', 'review', 'running', 'checks'],
      ['review', 'build', 'running', 'review'],
      ['build', 'checks', 'running', 'stage-done'],
      ['checks', 'review', 'running', 'checks'],
      [null, 'review', 'needs-you', 'review'],
    ]);
    const [now] = await status(w.abe, '7');

    expect(now).toMatchObject({
      stage: 'review',
      state: 'needs-you',
      reason: 'review did not converge',
      round: 3,
    });
    expect(now?.reviews.map((v) => [v.findings, v.round])).toEqual([
      [2, 1],
      [1, 2],
      [1, 3],
    ]);
    for (const n of [1, 2, 3])
      expect(readFileSync(report(r.worktree, 7, 'review', `${n}.md`), 'utf8')).toBe('# demo\n');
    expect(now?.reviews[0]?.report).toBe(report(r.worktree, 7, 'review', '1.md'));
    // Evidence never in a commit: the worktree ignores `.scratch/`.
    expect(git(r.worktree, 'check-ignore', report(r.worktree, 7, 'review', '1.md'))).toBe(
      report(r.worktree, 7, 'review', '1.md'),
    );
  });

  test('Bug: base-worktree at the merge base; a bug that does not reproduce ends the run with its report', async () => {
    const r = runOf(8);

    expect(seen.get(8)).toEqual([
      [null, 'reproduce', 'running', 'run'],
      ['reproduce', 'done', 'done', 'verify'],
    ]);
    const lines = claudeOutput(r.worktree).abe.map((l) =>
      z.object({ argv: z.array(z.string()), exit: z.number(), stdout: z.string() }).parse(l),
    );
    const base = lines.find((l) => l.argv[1] === 'base-worktree');
    const doc = z
      .object({ ok: z.literal(true), data: FactoryBaseWorktreeData })
      .parse(JSON.parse(base?.stdout ?? ''));
    const branch = cardBranch('8', 'Sign-in button overlaps the logo on narrow screens');

    expect(doc.data).toEqual({
      // Beside the card's own worktree, as Abe's worktrees are.
      path: `${r.worktree}-base`,
      base: first,
      branch,
      against: 'main',
      // The fixture has no origin, so Before is taken against the checkout's main, said so (#198).
      note: "no origin remote: the checkout's own main",
    });
    expect(git(doc.data.path, 'rev-parse', 'HEAD')).toBe(first);
    expect(existsSync(join(doc.data.path, 'later.txt'))).toBe(false);
    expect(await ranAll(r.worktree, 3)).toEqual([
      [0, undefined],
      [1, 'before-only-here'],
      [0, 'done'],
    ]);
    const [now] = await status(w.abe, '8');

    expect(now).toMatchObject({
      state: 'done',
      outcome: 'reported',
      workflow: { id: 'bug', name: 'Bug' },
      reported: { step: 'reproduce', report: report(r.worktree, 8, 'verify', '1-before.md') },
    });
    // The refused after kept no report; the before is the only verification.
    expect(now?.verifications.map((v) => [v.phase, v.result, v.report])).toEqual([
      ['before', 'not-reproduced', report(r.worktree, 8, 'verify', '1-before.md')],
    ]);
    expect(existsSync(report(r.worktree, 8, 'verify', '1-after.md'))).toBe(false);
    // The kept copy's header names the browser profile it ran in (#103).
    expect(readFileSync(report(r.worktree, 8, 'verify', '1-before.md'), 'utf8')).toBe(
      '# demo\n\nBrowser profile: default\n',
    );
    // The report stays with the run: no comment posted on the card.
    expect(w.ado.requests().filter((l) => /^POST .*workitems\/8\/comments/i.test(l))).toEqual([]);
  });

  test("the playbook's gate says yes: its step runs, none written, on to pr", async () => {
    const r = runOf(5);

    expect(seen.get(5)?.slice(-2)).toEqual([
      ['verify', 'step', 'running', 'verify'],
      ['step', 'pr', 'running', 'stage-done'],
    ]);
    expect(await ranAll(r.worktree, 8)).toEqual([
      [0, 'step'],
      [0, 'build'],
      [0, 'review'],
      [0, 'verify'],
      [0, 'step'],
      [0, 'step'],
      [0, 'pr'],
      [1, 'pr-by-serve'],
    ]);
    const [now] = await status(w.abe, '5');

    expect(now?.judgements).toMatchObject([
      { step: 'playbook', kind: 'gate', answer: true, reason: 'a migration' },
    ]);
    expect([now?.stages.map((s) => s.stage).at(-1), now?.playbook]).toEqual(['step', null]);
    expect(existsSync(report(r.worktree, 5, 'review', '1.md'))).toBe(true);
  });

  test('the regression tests an after pass names ride the run, its gate waiting', async () => {
    const r = runOf(13);

    expect(await ranAll(r.worktree, 5)).toEqual([
      [0, 'step'],
      [0, 'build'],
      [0, 'review'],
      [0, 'verify'],
      [0, 'step'],
    ]);
    const [now] = await status(w.abe, '13');

    expect(now).toMatchObject({
      stage: 'step',
      step: 'playbook',
      judging: { kind: 'gate' },
      regression: ['checkout.spec', 'cart.spec'],
    });
    const text = await w.abe.run('factory', 'status', '13');

    expect(text.stdout).toContain('  regression checkout.spec, cart.spec\n');
  });

  test('from outside a session review, verify and base-worktree exit 1 not-in-session', async () => {
    for (const argv of [
      ['factory', 'review', '--findings', '0'],
      ['factory', 'verify', '--phase', 'after', '--result', 'pass', '--report', 'README.md'],
      ['factory', 'base-worktree'],
    ]) {
      const out = await w.abe.json(z.unknown(), ...argv);

      expect([out.exit, out.doc]).toMatchObject([
        1,
        { ok: false, error: { code: 'not-in-session' } },
      ]);
    }
  });
});
