/**
 * Verification's end stops the workspace's browser (#66, #64): a box's `serve` with a fake
 * Chromium and a Factory run whose session (the fake `claude` in a real `tmux`) is carried to
 * verify; `abe factory verify` then comes through its session's socket, as the agent's `abe`
 * sends it, and the browser is read from inside the workspace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserData,
  FactoryRunData,
  FactoryStatusData,
  NOT_REPRODUCED,
  readEnvelope,
  type Reply,
  SessionData,
  withoutBrowser,
} from '@abe/core';
import {
  card,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeProfileStore,
  type FakeProfileStore,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { type z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

const read = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const doc = readEnvelope(schema, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

describe("verification's end stops the workspace's browser", () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let s: ServeScenario;
  let profiles: FakeProfileStore;

  /** The run's card's workspace's browser (ADR 0022: one per card on the box). */
  const browser = async (run: FactoryRunData) =>
    read(BrowserData, await s.requestInsideOf(String(run.card), 'browser', 'status', '--json'));

  /** A run on card `id` carried to verify by its session. */
  const toVerify = async (id: number, launch: readonly string[] = []) => {
    scriptClaude(s.state.dir, [
      {
        abe: ['factory', 'stage-done', 'create-specification', '--json'],
      },
      { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
      { abe: ['factory', 'stage-done', 'build', '--json'] },
      { abe: ['factory', 'review', '--findings', '0', '--json'] },
    ]);
    const run = read(
      FactoryRunData,
      await s.request('factory', 'run', String(id), '--repo', repo, ...launch, '--json'),
    );

    await until(
      `AB#${id} in verify`,
      async () =>
        read(FactoryStatusData, await s.request('factory', 'status', String(id), '--json')).runs[0]
          ?.stage === 'verify'
          ? true
          : undefined,
      { ms: 15_000, every: 25 },
    );

    return run;
  };

  const verify = async (run: FactoryRunData, phase: string, result: string) => {
    // In its worktree, where a session's files are read from.
    const file = join(run.worktree, '.scratch', `verify-${run.session}-${phase}.md`);

    mkdirSync(join(run.worktree, '.scratch'), { recursive: true });
    writeFileSync(file, `# Verify ${phase}\n\nResult: ${result}\n`);

    return read(
      FactoryRunData,
      await s.requestAs(
        run.session,
        run.worktree,
        'factory',
        'verify',
        '--phase',
        phase,
        '--result',
        result,
        '--report',
        file,
        '--json',
      ),
    );
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-vb-'));
    repo = join(root, 'demo');
    for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    writeFileSync(
      join(repo, 'abe.yaml'),
      'board: {organization: "https://dev.azure.com/demo-org", project: Shop, team: Web}\nenvironments: {}\nbrowser:\n  profiles:\n    - { name: work, purpose: app user }\n    - { name: work-admin, purpose: admin }\n',
    );
    git(repo, 'init', '-q', '-b', 'main');
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    claude = fakeClaude();
    profiles = fakeProfileStore();
    for (const name of ['work', 'work-admin'])
      profiles.stored.set(name, {
        text: JSON.stringify({
          v: 1,
          storedAt: '2026-10-23T09:00:00.000Z',
          cookies: [],
          origins: [],
        }),
        storedAt: '2026-10-23T09:00:00.000Z',
      });
    s = await scenario({
      box: true,
      board: fakeBoard([4, 5, 6, 7, 8, 9].map((id) => card(id, `Cart total ${id}`))),
      browserProfiles: { store: profiles },
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
    s.box.mirrors.trees.set('mkdir-swe/demo-shop', 'tree1');
    // Each run's card's workspace on the box (ADR 0022).
    for (const card of ['4', '5', '6', '7', '8', '9']) {
      const up = await s.request(
        'workspace',
        'up',
        '--repo',
        'mkdir-swe/demo-shop',
        '--card',
        card,
        '--json',
      );

      if (up.exit !== 0) throw new Error(up.stdout);
    }
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'a Before that reproduced keeps it for After; the After pass stops it as verified',
    { timeout: 30_000 },
    async () => {
      const run = await toVerify(4);

      read(BrowserData, await s.requestInsideOf('4', 'browser', 'start', '--json'));
      expect((await verify(run, 'before', 'pass')).stage).toBe('verify');
      expect((await browser(run)).state).toBe('running');
      // on to the playbook's gate
      expect((await verify(run, 'after', 'pass')).stage).toBe('step');
      expect(await browser(run)).toMatchObject({
        state: 'stopped',
        stopped: { reason: 'verified' },
      });
    },
  );

  test('a Before that did not reproduce stops it too', { timeout: 30_000 }, async () => {
    const run = await toVerify(5);

    read(BrowserData, await s.requestInsideOf('5', 'browser', 'start', '--json'));
    const before = await verify(run, 'before', 'not-reproduced');

    // The browser ran: the bug's verdict, as Before said it.
    expect([before.state, before.reason]).toEqual(['needs-you', NOT_REPRODUCED]);
    expect(await browser(run)).toMatchObject({ state: 'stopped', stopped: { reason: 'verified' } });
  });

  test(
    'a Before not reproduced with the browser never started is inconclusive (#319)',
    { timeout: 30_000 },
    async () => {
      // Past the earlier tests' stops: this run's own browser never ran.
      s.clock.tick(60_000);
      const run = await toVerify(8);
      const before = await verify(run, 'before', 'not-reproduced');

      expect([before.state, before.reason]).toEqual(['needs-you', withoutBrowser(NOT_REPRODUCED)]);
    },
  );

  test(
    "build's not reproduced: inconclusive with the browser never started, the verdict once it ran (#319)",
    { timeout: 30_000 },
    async () => {
      s.clock.tick(60_000);
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
      ]);
      const run = read(
        FactoryRunData,
        await s.request('factory', 'run', '9', '--repo', repo, '--json'),
      );

      await until(
        'AB#9 in build',
        async () =>
          read(FactoryStatusData, await s.request('factory', 'status', '9', '--json')).runs[0]
            ?.stage === 'build'
            ? true
            : undefined,
        { ms: 15_000, every: 25 },
      );
      const said = 'not reproduced: every price goes through formatPrice';
      const needsYou = async () =>
        read(
          FactoryRunData,
          await s.requestAs(
            run.session,
            run.worktree,
            'factory',
            'needs-you',
            '--reason',
            said,
            '--json',
          ),
        );

      expect((await needsYou()).reason).toBe(withoutBrowser(said));
      read(BrowserData, await s.requestAs(run.session, run.worktree, 'browser', 'start', '--json'));
      expect((await needsYou()).reason).toBe(said);
      await s.requestAs(run.session, run.worktree, 'browser', 'stop', '--json');
    },
  );
  test(
    'a run in work-admin: another profile is refused while it verifies; the report names it',
    { timeout: 30_000 },
    async () => {
      const run = await toVerify(6, ['--profile', 'work-admin']);
      const other = await s.requestAs(
        run.session,
        run.worktree,
        'browser',
        'start',
        '--profile',
        'work',
        '--json',
      );
      const doc = readEnvelope(BrowserData, JSON.parse(other.stdout));

      expect(doc.ok ? '' : doc.error.code).toBe('profile-differs-from-before');
      expect(s.box.browser.running).toBeUndefined();
      const own = read(
        BrowserData,
        await s.requestAs(run.session, run.worktree, 'browser', 'start', '--json'),
      );

      expect(own.browserProfile).toBe('work-admin');
      const after = await verify(run, 'after', 'pass');
      const kept = after.verifications.at(-1)?.report ?? '';
      // Kept in the run's worktree in the workspace container: what its write was handed (this
      // fake container reads the agent's report as empty; the title case is core's table).
      const written = s.box.docker.execs.findLast(
        (e) => e.argv.includes(kept) && (e.stdin ?? '') !== '',
      );

      expect(written?.stdin).toStartWith('Browser profile: work-admin\n');
    },
  );

  test('a profile with nothing stored is refused at launch, with the fix', async () => {
    profiles.stored.delete('work');
    const reply = await s.request(
      'factory',
      'run',
      '7',
      '--repo',
      repo,
      '--profile',
      'work',
      '--json',
    );
    const doc = readEnvelope(FactoryRunData, JSON.parse(reply.stdout));

    expect(doc.ok ? '' : `${doc.error.code}: ${doc.error.message}`).toBe(
      'profile-not-stored: work has no stored sign-ins: abe browser store work locally',
    );
    const none = read(FactoryStatusData, await s.request('factory', 'status', '7', '--json'));

    expect(none.runs).toEqual([]);
  });
  test('session launch --profile keeps it on the session; an unknown one is refused', async () => {
    const unknown = await s.request(
      'session',
      'launch',
      '--card',
      '7',
      '--repo',
      repo,
      '--profile',
      'nope',
      '--json',
    );

    expect(readEnvelope(SessionData, JSON.parse(unknown.stdout))).toMatchObject({
      ok: false,
      error: { code: 'no-profile' },
    });
    const launched = read(
      SessionData,
      await s.request(
        'session',
        'launch',
        '--card',
        '7',
        '--repo',
        repo,
        '--profile',
        'work-admin',
        '--json',
      ),
    );

    expect(launched.browserProfile).toBe('work-admin');
    await s.request('session', 'stop', launched.id, '--json');
  });
});
