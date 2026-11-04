/**
 * Checks through the CLI seam: the real `abe` and its `serve`, the fake Azure DevOps for the
 * cards, a real git checkout with a fixture repo pack, and the fake `claude` in a real `tmux`
 * that builds, says it is done, and is sent back with what failed: a failing test command, a
 * deleted test file, an added `@ts-ignore`. All green moves on to review. Each result is a
 * `factory.checks` event and `.scratch/<card>/checks.md`, which git never sees.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventLine,
  FactoryChecksData,
  FactoryChecksEvent,
  FactoryRunData,
  mergeSettings,
  newRun,
  type Outcome,
} from '@abe/core';
import { localRunTree } from '@abe/ports';
import { repoChecks } from './checks';
import {
  claudeOutput,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  scriptClaude,
  type Streaming,
  tmuxPath,
  until,
  installDone,
} from '@abe/testing';
import { z } from 'zod';

const gitEnv = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...gitEnv, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

/** The repo pack: tests fail while a FAIL file is there. */
const PACK = `checks:
  - name: tests
    run: sh scripts/test.sh
  - name: types
    run: echo "types ok $NODE_OPTIONS"
`;

const TEST_SH = `if [ -f FAIL ]; then
  echo "src/cart.test.ts:"
  # vitest's colours (#187): kept out of checks.md and what the session is told
  printf '\\033[1m\\033[31m(fail)\\033[39m\\033[22m cart > adds an item: expected 2, got 3\\n' >&2
  exit 1
fi
echo "1 pass"
`;

type World = { root: string; repo: string; ado: FakeAdo; az: FakeAz; claude: FakeClaude; abe: Cli };

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-checks-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe', 'demo/src', 'demo/scripts'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(repo, 'abe.yaml'),
    `${PACK}  - name: audit\n    run: echo audited by the repo\nboard: ${JSON.stringify(ado.board)}\n`,
  );
  writeFileSync(join(repo, 'scripts', 'test.sh'), TEST_SH);
  // the memory CI gives its tests: the checks get it too
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo, '.github', 'workflows', 'ci.yml'),
    'env:\n  NODE_OPTIONS: --max-old-space-size=8192\n',
  );
  writeFileSync(join(repo, 'src', 'cart.ts'), 'export const add = (n: number) => n + 1;\n');
  writeFileSync(join(repo, 'src', 'cart.test.ts'), "test('adds an item', () => {});\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // The repo's audit, which yours for this repo may not swap for `true` without an Override.
  writeFileSync(
    join(repo, '.abe', 'settings.local.yaml'),
    'checks:\n  - name: audit\n    run: "true"\n',
  );
  const abe = cli({
    env: {
      PATH: `${claude.dir}:${az.dir}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_TMUX: tmuxPath(),
      ...ado.env,
    },
  });

  // the Mac's serve starts a card only where the install is done
  await installDone(abe.state.dir, repo);

  return { root, repo, ado, az, claude, abe };
};

const factory = (...argv: string[]) => ({ abe: ['factory', ...argv, '--json'] });

const ChecksEvent = z.object({ type: z.literal('factory.checks'), data: FactoryChecksEvent });
const StageEvent = z.object({
  type: z.literal('factory.stage'),
  data: z.object({ session: z.string(), stage: z.string(), from: z.string().nullable() }),
});

/** Reads events off the watch until `stop` says so; the ones it read. */
const eventsUntil = async (watch: Streaming, stop: (e: EventLine) => boolean) => {
  const seen: EventLine[] = [];

  for (;;) {
    const e = EventLine.parse(JSON.parse(await watch.next(20_000)));

    seen.push(e);
    if (stop(e)) return seen;
  }
};

/** The run's move out of checks to `stage`. */
const isStage = (session: string, stage: string) => (e: EventLine) => {
  const s = StageEvent.safeParse(e);

  return (
    s.success &&
    s.data.data.session === session &&
    s.data.data.stage === stage &&
    s.data.data.from === 'checks'
  );
};

const checksOf = (seen: EventLine[], session: string) =>
  seen.flatMap((e) => {
    const c = ChecksEvent.safeParse(e);

    return c.success && c.data.data.session === session ? [c.data.data] : [];
  });

/** A turn that ended (`Stop`) for the session: the fake waits for its next line. */
const stopped = (session: string) => (e: EventLine) => {
  const s = z
    .object({
      type: z.literal('session.state'),
      data: z.object({ id: z.string(), cause: z.string() }),
    })
    .safeParse(e);

  return s.success && s.data.data.id === session && s.data.data.cause === 'Stop';
};

const statuses = (e: FactoryChecksEvent | undefined) =>
  Object.fromEntries((e?.results ?? []).map((r) => [r.name, r.status]));

describe('checks after build', () => {
  let w: World;
  let watch: Streaming;

  /**
   * A run on `card` that decides and builds; `change` edits its worktree; then it says build is
   * done. The events until checks have sent it on (or back), and the run.
   */
  const build = async (card: string, change: (worktree: string) => void) => {
    scriptClaude(
      w.abe.state.dir,
      [
        factory('stage-done', 'create-specification'),
        factory('stage-done', 'to-tickets'),
        { say: 'Building.' },
      ],
      {
        'build is done': [factory('stage-done', 'build'), { say: 'Done building.' }],
      },
    );
    const out = await w.abe.json(FactoryRunData, 'factory', 'run', card, '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    const run = out.doc.data;

    await eventsUntil(watch, stopped(run.session));
    change(run.worktree);
    await w.abe.run('session', 'send', run.session, 'build is done');
    const seen = await eventsUntil(
      watch,
      (e) => isStage(run.session, 'review')(e) || isStage(run.session, 'build')(e),
    );

    return { run, seen, checks: checksOf(seen, run.session) };
  };

  const typed = (worktree: string, part: string) =>
    until(`${part} typed into the session`, () =>
      z
        .array(z.string())
        .parse(claudeOutput(worktree).typed)
        .find((t) => t.includes(part)),
    );

  beforeAll(async () => {
    w = await world();
    await w.abe.run('status');
    watch = w.abe.spawn('watch', '--json');
  }, 30_000);
  afterAll(async () => {
    watch.signal('SIGKILL');
    await w.abe.close();
    await w.ado.stop();
    w.az.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('all green: each command and the built-ins, on to review', { timeout: 30_000 }, async () => {
    const { run, seen, checks } = await build('4', () => undefined);

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ card: 4, green: true, cause: 'checks' });
    expect(statuses(checks[0])).toEqual({
      tests: 'green',
      types: 'green',
      audit: 'green',
      lint: 'not-configured',
      'no-deleted-tests': 'green',
      'no-new-suppressions': 'green',
    });
    expect(checks[0]?.results.map((r) => r.name)).toEqual([
      'tests',
      'types',
      'lint',
      'audit',
      'no-deleted-tests',
      'no-new-suppressions',
    ]);
    expect(seen.find(isStage(run.session, 'review'))?.data).toMatchObject({ from: 'checks' });
    const md = readFileSync(join(run.worktree, '.scratch', '4', 'checks.md'), 'utf8');

    expect(md).toStartWith('# Checks · AB#4\n\nGreen at ');
    expect(md).toContain('## tests · green (exit 0, ');
    expect(md).toContain('```text\n1 pass\n```');
    expect(md).toContain('```text\ntypes ok --max-old-space-size=8192\n```');
    // The repo's audit ran, not your `true`: changing it takes an Override.
    expect(md).toContain('audited by the repo');
    expect(md).toContain('checks changes the command of the check audit above without an Override');
    // Evidence is in the repo's own exclude, so git never sees it; .gitignore is untouched.
    expect(readFileSync(join(w.repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.scratch/\n');
    expect(git(run.worktree, 'status', '--porcelain')).toBe('');
  });

  test(
    'a failing test command: back to build, its output typed into the session and kept',
    { timeout: 30_000 },
    async () => {
      const { run, seen, checks } = await build('5', (wt) => {
        writeFileSync(join(wt, 'FAIL'), '');
      });

      expect(seen.find(isStage(run.session, 'build'))?.data).toMatchObject({ from: 'checks' });
      expect(checks[0]).toMatchObject({ green: false });
      expect(statuses(checks[0])).toMatchObject({ tests: 'red', types: 'green' });
      expect(checks[0]?.results[0]).toMatchObject({ exit: 1 });
      const said = await typed(run.worktree, 'Checks failed');

      expect(said).toBe(
        [
          'Checks failed, so the run is back in build: tests. Fix what they say, then run abe factory stage-done build again. All of it is in .scratch/5/checks.md.',
          '',
          '## tests (sh scripts/test.sh): exit 1',
          'src/cart.test.ts:',
          '(fail) cart > adds an item: expected 2, got 3',
        ].join('\n'),
      );
      const md = readFileSync(join(run.worktree, '.scratch', '5', 'checks.md'), 'utf8');

      expect(md).toContain('## tests · red (exit 1, ');
      expect(md).toContain('(fail) cart > adds an item');
      expect(md).not.toContain('\u001b');
      // The agent's stage-done was answered: the run is back in build.
      const ran = z.object({ stdout: z.string() }).parse(claudeOutput(run.worktree).abe.at(-1));

      expect(JSON.parse(ran.stdout)).toMatchObject({ ok: true, data: { stage: 'build' } });
    },
  );

  test('a deleted test file: no-deleted-tests is red', { timeout: 30_000 }, async () => {
    const { run, checks } = await build('6', (wt) => {
      git(wt, 'rm', '-q', 'src/cart.test.ts');
      git(wt, 'commit', '-q', '-m', 'drop the test');
    });

    expect(statuses(checks[0])).toMatchObject({ tests: 'green', 'no-deleted-tests': 'red' });
    expect(await typed(run.worktree, 'deleted: src/cart.test.ts')).toContain(
      '## no-deleted-tests: red\ntest files gone against the merge base',
    );
  });

  test('an added @ts-ignore: no-new-suppressions is red', { timeout: 30_000 }, async () => {
    const { run, checks } = await build('7', (wt) => {
      writeFileSync(
        join(wt, 'src', 'cart.ts'),
        '// @ts-ignore\nexport const add = (n: number) => n + 1;\n',
      );
    });

    expect(statuses(checks[0])).toMatchObject({
      'no-deleted-tests': 'green',
      'no-new-suppressions': 'red',
    });
    expect(await typed(run.worktree, 'src/cart.ts:1: @ts-ignore: // @ts-ignore')).toBeDefined();

    // Fixed, and run again on demand: green, and the run stays where it is.
    unlinkSync(join(run.worktree, 'src', 'cart.ts'));
    git(run.worktree, 'checkout', '--', 'src/cart.ts');
    const again = await w.abe.json(FactoryChecksData, 'factory', 'checks', 'AB#7');

    expect([again.exit, again.doc.ok && again.doc.data.green]).toEqual([0, true]);
    expect(again.doc.ok && again.doc.data).toMatchObject({
      card: 7,
      cause: 'on-demand',
      file: join(run.worktree, '.scratch', '7', 'checks.md'),
    });
    const [ondemand] = checksOf(
      await eventsUntil(watch, (e) => ChecksEvent.safeParse(e).success),
      run.session,
    );

    expect(ondemand).toMatchObject({ green: true, cause: 'on-demand' });
    const status = await w.abe.json(
      z.object({ runs: z.array(FactoryRunData) }),
      'factory',
      'status',
      '7',
    );

    expect(status.doc.ok && status.doc.data.runs[0]?.stage).toBe('build');
    const text = await w.abe.run('factory', 'checks', '7');

    expect(text.stdout).toStartWith(
      `AB#7 checks green  ${join(run.worktree, '.scratch', '7', 'checks.md')}\n`,
    );
    expect(text.stdout).toContain('\n  no-new-suppressions   green\n');

    // From a session's socket: its own run only.
    const env = { ABE_SOCKET: join(w.abe.state.dir, 'sessions', run.session, 'session.sock') };
    const other = await w.abe.runWith({ env }, 'factory', 'checks', '4', '--json');

    expect(JSON.parse(other.stdout)).toMatchObject({
      ok: false,
      error: { code: 'not-your-session' },
    });
  });

  test(
    "the worktree's own settings change no check: they are read in the run's checkout",
    { timeout: 30_000 },
    async () => {
      const { run, checks } = await build('13', (wt) => {
        // The agent edits its worktree's Layer: an Override emptying checks, no test files, and
        // tests swapped for `true`; then fails a test and deletes one.
        writeFileSync(
          join(wt, 'abe.yaml'),
          [
            'checks:',
            '  - name: tests',
            '    run: "true"',
            'testFiles: []',
            'overrides:',
            '  checks: { value: [], reason: the agent says so }',
            '  testFiles: { value: [], reason: the agent says so }',
            '',
          ].join('\n'),
        );
        writeFileSync(join(wt, 'FAIL'), '');
        git(wt, 'rm', '-q', 'src/cart.test.ts');
      });

      expect(checks[0]?.green).toBe(false);
      expect(checks[0]?.results.map((r) => [r.name, r.status])).toEqual([
        ['tests', 'red'],
        ['types', 'green'],
        ['lint', 'not-configured'],
        ['audit', 'green'],
        ['no-deleted-tests', 'red'],
        ['no-new-suppressions', 'green'],
      ]);
      const md = readFileSync(join(run.worktree, '.scratch', '13', 'checks.md'), 'utf8');

      // The checkout's tests command ran, and no Override of the worktree's is in force.
      expect(md).toContain('sh scripts/test.sh');
      expect(md).not.toContain('the agent says so');
    },
  );

  test('a card with no run: no-run', async () => {
    const out = await w.abe.json(z.unknown(), 'factory', 'checks', '12');

    expect([out.exit, out.doc]).toMatchObject([1, { ok: false, error: { code: 'no-run' } }]);
  });
});

// ADR 0028: the checks get the checkout's test Abe env file and profile keys, and what they print
// never carries a value of any Abe env file; an expired aws login runs none
describe("a run's checks with the person's credentials", () => {
  test.each<[string, Outcome<Record<string, string>>, string | null]>([
    [
      'its keys in the command, their values redacted from its output',
      { ok: true, data: { API_KEY: 'fake-key-3141' } },
      null,
    ],
    [
      'an expired aws login: no check run, its sign-in named',
      {
        ok: false,
        error: {
          code: 'aws-login-expired',
          message:
            'shop-dev gave no credentials (its login expired?): abe login aws --profile shop-dev',
        },
      },
      'aws-login-expired',
    ],
  ])('%s', async (_, injected, refusal) => {
    const wt = mkdtempSync(join(tmpdir(), 'abe-cred-checks-'));
    const merged = mergeSettings([
      {
        place: 'repo',
        file: join(wt, 'abe.yaml'),
        // the command says the key, and that it had it
        doc: {
          checks: [{ name: 'tests', run: 'echo "the key was $API_KEY, prod fake-prod-token-7"' }],
        },
      },
    ]);
    const run = newRun({
      session: '9-ab',
      card: 9,
      title: 'Cart',
      repo: wt,
      worktree: wt,
      at: '2026-10-27T09:00:00.000Z',
    });
    const checks = repoChecks({
      settings: { at: () => merged },
      tree: () => localRunTree({ PATH: '/usr/bin:/bin', HOME: wt }),
      clock: { now: () => 0 },
      emit: () => undefined,
      injected: () => Promise.resolve(injected),
      envName: () => Promise.resolve('test'),
      redacted: () => Promise.resolve([{ kind: 'PROD_TOKEN', value: 'fake-prod-token-7' }]),
    });

    try {
      const r = await checks(run, 'on-demand');

      if (refusal !== null) {
        expect(r.ok ? '' : r.error.code).toBe(refusal);

        return;
      }
      const tests = r.ok ? r.data.results.find((x) => x.name === 'tests') : undefined;

      expect([tests?.status, tests?.output.trim()]).toEqual([
        'green',
        'the key was [redacted:API_KEY], prod [redacted:PROD_TOKEN]',
      ]);
      // what the run keeps of the env it ran with: the names, never a value
      const env = r.ok ? r.data.env : null;

      expect(env).toMatchObject({ name: 'test' });
      const named = ['API_KEY', 'CI', 'HOME', 'PATH'];

      expect(env?.keys.filter((k) => named.includes(k))).toEqual(named);
      expect(JSON.stringify(env)).not.toContain('fake-key-3141');
      expect(JSON.stringify(env)).not.toContain(wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
