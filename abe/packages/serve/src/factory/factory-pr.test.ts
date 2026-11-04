/**
 * The pr stage and Done (#48) in a real `serve` in this test, with the fake `claude` in a real
 * `tmux`, the fake `gh` for GitHub, an in-memory board, a fake clock, and real git: a bare
 * remote stands in for GitHub (origin is GitHub's URL, rewritten to it by `insteadOf`), so the
 * push is real. Each run is carried to pr by its session; `abe factory pr` then comes from the
 * fake (the first) or through its session's socket, exactly as the agent's `abe` sends it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FactoryEndData,
  FactoryRunData,
  FactoryStatusData,
  NOT_COMMENTED,
  type Reply,
  Run,
  SessionData,
  SessionListData,
} from '@abe/core';
import { ghTrackingFrom, sessionDir } from '@abe/ports';
import {
  card,
  claudeOutput,
  fakeBoard,
  type FakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  ghDeployment,
  ghDeploymentStatus,
  ghChecks,
  ghIssueComment,
  GH_PR_HEAD as HEAD_SHA,
  ghIssue,
  ghPrView,
  ghPull,
  NOT_FOUND,
  ghWorkflowRun,
  type GhAnswer,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { z } from 'zod';

const REPO = 'acme/demo';
const ORIGIN = `https://github.com/${REPO}.git`;
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

  return ran.stdout.toString().trim();
};

const DAY = 86_400_000;
/** Done runs clear at the next midnight UTC here, whatever this machine's time zone. */
const nextUtcMidnight = (ms: number) => (Math.floor(ms / DAY) + 1) * DAY;

/** A check with a command, so these runs' checks run one (#159). */
const CHECKS = 'checks:\n  - name: tests\n    run: "true"\n';

const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };

const GOOD = [
  'Sign in with email.',
  '',
  '**Verified:** signed in on test with a new account (After).',
  '',
  '## Notes',
  '',
  '- The session cookie is now SameSite=Lax.',
  '',
].join('\n');

/** `read` again until `ok` holds of what it read: that. */
const readUntil = async <T>(what: string, read: () => Promise<T>, ok: (t: T) => boolean) => {
  let last: T | undefined;

  return until(
    () => `${what}: still ${JSON.stringify(last)}`,
    async () => {
      last = await read();

      return ok(last) ? last : undefined;
    },
    { ms: 15_000, every: 25 },
  );
};

const doc = <T extends z.ZodType>(schema: T, reply: Reply) =>
  z
    .union([
      z.object({ ok: z.literal(true), data: schema }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout));

describe('the pr stage and Done', () => {
  let root: string;
  let remote: string;
  let repo: string;
  /** The repo's `abe.yaml`, kept out of git (Just this Mac). */
  let repoFile: string;
  let gh: FakeGh;
  let board: FakeBoard;
  let claude: FakeClaude;
  let s: ServeScenario;
  /** The fake `gh`'s answers, newest first: an earlier run's keep answering while later ones are added. */
  let answers: (readonly [string, GhAnswer])[] = [];
  const say = (...more: (readonly [string, GhAnswer])[]) => {
    answers = [...more, ...answers];
    gh.answer(answers);
  };
  /** The repo's settings: `lines` (the board by default), and a check with a command unless not. */
  const writeRepo = (lines: string[] = [`board: ${JSON.stringify(BOARD)}`], checks = true) => {
    writeFileSync(repoFile, `environments: {}\n${checks ? CHECKS : ''}${lines.join('\n')}\n`);
  };

  const status = async (card?: number) => {
    const reply = await s.request(
      'factory',
      'status',
      ...(card === undefined ? [] : [String(card)]),
      '--json',
    );
    const read = doc(FactoryStatusData, reply);

    if (!read.ok) throw new Error(JSON.stringify(read.error));

    return read.data.runs;
  };
  const runOf = async (id: number) => (await status(id))[0];

  /**
   * A run on card `id` carried to pr by its session: specified, built, checked, reviewed,
   * verified, its playbook's gate answered no. With `playbook`, yes: it stops at the playbook
   * step before pr.
   */
  const toPr = async (
    id: number,
    replies: Parameters<typeof scriptClaude>[2] = {},
    o: { playbook?: boolean } = {},
  ) => {
    scriptClaude(
      s.state.dir,
      [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'stage-done', 'build', '--json'] },
        { abe: ['factory', 'review', '--findings', '0', '--json'] },
        { write: { path: `.scratch/${id}/verify-after.md`, text: '# Verify after\n' } },
        {
          abe: [
            ...['factory', 'verify', '--phase', 'after', '--result', 'pass'],
            ...['--report', `.scratch/${id}/verify-after.md`, '--json'],
          ],
        },
        {
          abe: [
            ...['factory', 'judge', '--answer', o.playbook === true ? 'yes' : 'no'],
            ...['--reason', o.playbook === true ? 'a migration' : 'nothing by hand', '--json'],
          ],
        },
      ],
      replies,
    );
    const launched = doc(
      FactoryRunData,
      await s.request('factory', 'run', String(id), '--repo', repo, '--json'),
    );

    if (!launched.ok) throw new Error(JSON.stringify(launched.error));
    await readUntil(
      `AB#${id} in ${o.playbook === true ? 'playbook' : 'pr'}`,
      () => runOf(id),
      (r) =>
        o.playbook === true ? r?.step === 'playbook' && r.judging === null : r?.stage === 'pr',
    );
    const session = doc(
      SessionData,
      await s.request('session', 'show', launched.data.session, '--json'),
    );

    if (!session.ok) throw new Error(JSON.stringify(session.error));

    return {
      id: launched.data.session,
      worktree: launched.data.worktree,
      branch: session.data.branch,
    };
  };

  /**
   * `abe factory pr` from inside the run's session, the body written to a file first: in its
   * worktree, where a session's files are read from.
   */
  const pr = async (run: { id: string; worktree: string }, body: string, title = 'Sign in') => {
    const file = join(run.worktree, '.scratch', `body-${run.id}.md`);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);

    return doc(
      FactoryRunData,
      await s.requestAs(
        run.id,
        run.worktree,
        'factory',
        'pr',
        '--title',
        title,
        '--body-file',
        file,
        '--json',
      ),
    );
  };

  /** The card's state on the board now. */
  const stateOf = (id: number) => board.cards().find((c) => c.id === id)?.state;

  const calls = (part: string) => gh.calls().filter((c) => c.argv.join(' ').includes(part));

  /** GitHub's answers for a run's pull request `n` on `branch`, not yet merged. */
  const openOn = (n: number, branch: string) => {
    say(
      [`head=acme:${branch}`, { json: [] }],
      [`-X POST repos/${REPO}/pulls --input`, { json: ghPull(REPO, n) }],
      [`pr view ${n} -R`, { json: ghPrView(REPO, n, { head: branch }) }],
    );
  };

  /** The person merged `n`: GitHub shows it merged as `sha`; its deploy to test is `state`. */
  const merged = (n: number, branch: string, sha: string, head?: string) => {
    say([
      `pr view ${n} -R`,
      {
        json: ghPrView(REPO, n, {
          head: branch,
          state: 'MERGED',
          mergeCommit: sha,
          ...(head === undefined ? {} : { sha: head }),
        }),
      },
    ]);
  };
  const deploy = (sha: string, id: number, state: string) => {
    say(
      [`sha=${sha}`, { json: [ghDeployment(REPO, id, sha, 'test', '2026-10-01T09:05:00Z')] }],
      [
        `deployments/${id}/statuses`,
        { json: [ghDeploymentStatus(id * 10, state, '2026-10-01T09:06:00Z')] },
      ],
    );
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-pr-'));
    remote = join(root, 'remote.git');
    repo = join(root, 'demo');
    mkdirSync(join(root, 'mine'));
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    // The fake claude's own folder is no work of the card's.
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', ORIGIN);
    git(repo, 'config', `url.${remote}.insteadOf`, ORIGIN);
    git(repo, 'push', '-q', 'origin', 'main');
    // The repo's settings and yours for it, neither in git; card 9's repo has no check.
    mkdirSync(join(repo, '.abe'));
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'abe.yaml\n.abe/settings.local.yaml\n');
    repoFile = join(repo, 'abe.yaml');
    writeRepo();
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    gh = fakeGh();
    claude = fakeClaude();
    board = fakeBoard(
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27].map(
        (id) => card(id, `Sign in with email ${id}`),
      ),
    );
    s = await scenario({
      tracking: ghTrackingFrom({ PATH: gh.path }),
      board,
      factoryPollMs: 20,
      midnightAfter: nextUtcMidnight,
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    gh.remove();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'refused bodies name what is wrong; nothing is pushed or opened',
    { timeout: 30_000 },
    async () => {
      const run = await toPr(4);
      const refusals = [];

      for (const body of [
        'Just a summary.\n',
        GOOD.replace('## Notes', '**Verified:** twice\n\n## Notes'),
        `${GOOD}${['- two', '- three', '- four', '- five', '- six'].join('\n')}\n`,
      ]) {
        const out = await pr(run, body);

        refusals.push(out.ok ? 'opened' : [out.error.code, out.error.message]);
      }
      expect(refusals).toEqual([
        [
          'bad-pr-body',
          'the pull request body is refused: no line starts with **Verified:**: the body needs exactly one verification line; no ## Notes section',
        ],
        [
          'bad-pr-body',
          'the pull request body is refused: 2 lines start with **Verified:**: exactly one is allowed',
        ],
        ['bad-pr-body', 'the pull request body is refused: ## Notes has 6 bullets: at most 5'],
      ]);
      // The pr stage is not finished with stage-done.
      const done = doc(
        FactoryRunData,
        await s.requestAs(run.id, run.worktree, 'factory', 'stage-done', 'pr', '--json'),
      );

      expect(done.ok ? 'moved' : done.error.code).toBe('pr-by-serve');
      expect(gh.calls()).toEqual([]);
      expect(git(remote, 'branch', '--list', run.branch)).toBe('');
      expect(await runOf(4)).toMatchObject({ stage: 'pr', pr: null });
    },
  );

  let five: { id: string; worktree: string; branch: string };
  /** Five's merge base worktree (`factory base-worktree`). */
  let fiveBase = '';

  test(
    'a good body: pushed, the pull request opened with the card line, nothing commented on the card',
    { timeout: 30_000 },
    async () => {
      // This run's session hands the body over itself, through its own `abe`, from its worktree.
      const file = join('.scratch', 'body-5.md');

      five = await toPr(5, {
        'open the pull request': [
          {
            abe: ['factory', 'pr', '--title', 'Sign in with email', '--body-file', file, '--json'],
          },
        ],
      });
      // It started building: its card moved to the board's active column, Active by default.
      await readUntil(
        'AB#5 Active',
        () => Promise.resolve(stateOf(5)),
        (state) => state === 'Active',
      );
      expect((await runOf(5))?.board).toMatchObject({
        column: 'active',
        state: 'Active',
        error: null,
      });
      openOn(52, five.branch);
      mkdirSync(join(five.worktree, '.scratch'), { recursive: true });
      writeFileSync(join(five.worktree, file), GOOD);
      // An Override the agent writes in its own worktree turns no auto merge on.
      const own = join(five.worktree, '.abe');

      mkdirSync(own);
      writeFileSync(
        join(own, 'settings.yaml'),
        'overrides:\n  autoMerge: { value: true, reason: the agent says so }\n',
      );
      await s.request('session', 'send', five.id, 'open the pull request');
      const opened = await readUntil(
        'AB#5 opened',
        () => runOf(5),
        (r) => r?.pr !== null,
      );
      const sent = `${GOOD.trimEnd()}\n\nCard: AB#5\n`;

      // the body as it was sent, and when it was first opened
      expect(opened?.pr?.body).toBe(sent);
      const openedAt = opened?.pr?.openedAt;

      expect(typeof openedAt).toBe('string');

      expect(opened).toMatchObject({
        stage: 'pr',
        state: 'needs-you',
        reason: 'merge waits for a person',
        pr: {
          repo: REPO,
          number: 52,
          url: `https://github.com/${REPO}/pull/52`,
          state: 'open',
          merge: 'person',
        },
      });
      const ran = claudeOutput(five.worktree).abe.at(-1);

      expect(z.object({ exit: z.number() }).parse(ran).exit).toBe(0);
      expect(git(remote, 'rev-parse', five.branch)).toBe(git(five.worktree, 'rev-parse', 'HEAD'));
      const [create] = calls(`-X POST repos/${REPO}/pulls`);

      expect(JSON.parse(create?.stdin ?? '')).toEqual({
        head: five.branch,
        base: 'main',
        title: 'Sign in with email',
        body: `${GOOD.trimEnd()}\n\nCard: AB#5\n`,
        draft: false,
      });
      const comments = () =>
        board
          .cards()
          .find((c) => c.id === 5)
          ?.comments.map((c) => c.text);

      // Abe leaves the card's comments to the person: the board port wrote none.
      expect(comments()).toEqual([]);
      // Again: the open pull request on the branch is updated.
      say(
        [`head=acme:${five.branch}`, { json: [ghPull(REPO, 52)] }],
        [`pulls/52 --input`, { json: ghPull(REPO, 52) }],
      );
      expect(await pr(five, GOOD, 'Sign in with email, better')).toMatchObject({ ok: true });
      expect(calls(`-X POST repos/${REPO}/pulls`)).toHaveLength(1);
      expect(JSON.parse(calls('-X PATCH')[0]?.stdin ?? '')).toEqual({
        body: `${GOOD.trimEnd()}\n\nCard: AB#5\n`,
        title: 'Sign in with email, better',
      });
      expect(comments()).toEqual([]);
      expect(await runOf(5)).toMatchObject({ pr: { merge: 'person', body: sent, openedAt } });
      // its reviewers, as the next read of it says them
      say([
        `pr view 52 -R`,
        {
          json: ghPrView(REPO, 52, {
            head: five.branch,
            requested: ['shop-dev'],
            reviews: [['shop-lead', 'CHANGES_REQUESTED']],
          }),
        },
      ]);
      const reviewed = await readUntil(
        'AB#5 reviewers',
        () => runOf(5),
        (r) => (r?.pr?.reviewers ?? []).length > 0,
      );

      expect(reviewed?.pr?.reviewers).toEqual([
        { login: 'shop-dev', state: 'requested' },
        { login: 'shop-lead', state: 'changes-requested' },
      ]);
      rmSync(own, { recursive: true });
    },
  );

  test(
    'merged by a person: it moves on, and the deploy to test is Done',
    { timeout: 30_000 },
    async () => {
      // The agent's commit, pushed as abe factory pr pushes it, is what the person merges.
      writeFileSync(join(five.worktree, 'signin.txt'), 'email\n');
      git(five.worktree, 'add', 'signin.txt');
      git(five.worktree, 'commit', '-q', '-m', 'sign in');
      git(five.worktree, 'push', '-q', 'origin', five.branch);
      // Its merge base worktree, made from its session while it runs (Done stops it, #304).
      const made = await s.requestAs(five.id, five.worktree, 'factory', 'base-worktree', '--json');

      fiveBase = z
        .object({ ok: z.literal(true), data: z.object({ path: z.string() }) })
        .parse(JSON.parse(made.stdout)).data.path;
      merged(52, five.branch, 'sha-five', git(five.worktree, 'rev-parse', 'HEAD'));
      deploy('sha-five', 501, 'in_progress');
      const deploying = await readUntil(
        'AB#5 merged',
        () => runOf(5),
        (r) => r?.pr?.deploy === 'pending',
      );

      expect(deploying).toMatchObject({ stage: 'pr', state: 'running', reason: null });
      deploy('sha-five', 501, 'success');
      const done = await readUntil(
        'AB#5 done',
        () => runOf(5),
        (r) => r?.stage === 'done',
      );

      expect(done).toMatchObject({
        state: 'done',
        outcome: 'done',
        pr: { state: 'merged', mergeCommit: 'sha-five', deploy: 'success' },
      });
      expect(done?.stages.at(-1)?.stage).toBe('pr');
      // #304: its session, idle at its prompt since the pull request, waits on nobody now: it is
      // stopped, so nothing reads it as waiting on you and its box sleeps as any idle box.
      const session = await readUntil(
        'AB#5 session ended',
        async () => doc(SessionData, await s.request('session', 'show', five.id, '--json')),
        (r) => r.ok && r.data.state === 'ended',
      );

      expect(session).toMatchObject({ ok: true, data: { state: 'ended' } });
      // Done: its card at the board's done column, Closed by default.
      await readUntil(
        'AB#5 Closed',
        () => Promise.resolve(stateOf(5)),
        (state) => state === 'Closed',
      );
      expect((await runOf(5))?.board).toMatchObject({
        column: 'done',
        state: 'Closed',
        error: null,
      });
      // A person merged it: serve never did.
      expect(calls('/merge')).toEqual([]);
      expect(calls('deployments -f sha=sha-five -f environment=test')).not.toHaveLength(0);
    },
  );

  let six: { id: string; worktree: string; branch: string };

  test('a failed deploy needs you with its link', { timeout: 30_000 }, async () => {
    six = await toPr(6);
    openOn(63, six.branch);
    expect(await pr(six, GOOD)).toMatchObject({ ok: true });
    merged(63, six.branch, 'sha-six');
    deploy('sha-six', 601, 'failure');
    const failed = await readUntil(
      'AB#6 failed',
      () => runOf(6),
      (r) => r?.pr?.deploy === 'failure',
    );

    expect(failed).toMatchObject({
      stage: 'pr',
      state: 'needs-you',
      reason: 'the deploy to test failed: https://github.com/o/r/actions/runs/6010',
    });
    // Deployed again, it is Done.
    deploy('sha-six', 602, 'success');
    expect(
      await readUntil(
        'AB#6 done',
        () => runOf(6),
        (r) => r?.stage === 'done',
      ),
    ).toMatchObject({
      outcome: 'done',
    });
  });

  let seven: { id: string; worktree: string; branch: string };

  test(
    'auto merge lowered by an Override with a reason: serve merges once the checks are green',
    { timeout: 30_000 },
    async () => {
      writeRepo([
        // The repo's board names its own done column.
        `board: ${JSON.stringify({ ...BOARD, done: 'Resolved' })}`,
        'overrides:',
        '  autoMerge: { value: true, reason: demo shop merges on green }',
      ]);
      seven = await toPr(7);
      // Just opened, GitHub lists no checks yet: the run waits on them, nobody is asked.
      openOn(74, seven.branch);
      expect(await pr(seven, GOOD)).toMatchObject({
        ok: true,
        data: { state: 'running', reason: null, pr: { merge: 'auto' } },
      });
      const pending = [ghWorkflowRun('ci', 'in_progress', null)];

      // Still none after NO_CHECKS_READS polls of that head: now it needs you.
      await readUntil(
        'no checks needs you',
        () => runOf(7),
        (r) => r?.reason === 'auto merge waits for green checks: the pull request has none',
      );
      say(
        [`pr view 74 -R`, { json: ghPrView(REPO, 74, { head: seven.branch }) }],
        ...ghChecks(HEAD_SHA, pending),
      );
      await readUntil(
        'checks came: running again',
        () => runOf(7),
        (r) => r?.state === 'running',
      );
      // Two polls have read it pending since: neither merged.
      const read = calls('pr view 74 -R').length;

      await until('two more reads of #74', () =>
        calls('pr view 74 -R').length >= read + 2 ? true : undefined,
      );
      expect(calls('pulls/74/merge')).toEqual([]);
      const green = [ghWorkflowRun('ci', 'completed', 'success')];

      say(
        [`pr view 74 -R`, { json: ghPrView(REPO, 74, { head: seven.branch }) }],
        ...ghChecks(HEAD_SHA, green),
        [
          `pulls/74/merge`,
          { json: { sha: 'sha-seven', merged: true, message: 'Pull Request successfully merged' } },
        ],
        [`-X DELETE repos/${REPO}/git/refs/heads/`, { stdout: '' }],
      );
      deploy('sha-seven', 701, 'success');
      const done = await readUntil(
        'AB#7 done',
        () => runOf(7),
        (r) => r?.stage === 'done',
      );

      expect(done?.pr).toMatchObject({
        // its title as GitHub has it, for the story dialog's PR row (#135)
        title: 'Pull 74',
        state: 'merged',
        mergeCommit: 'sha-seven',
        merge: 'auto',
      });
      await readUntil(
        'AB#7 Resolved',
        () => Promise.resolve(stateOf(7)),
        (state) => state === 'Resolved',
      );
      const [merge] = calls('pulls/74/merge');

      expect(JSON.parse(merge?.stdin ?? '')).toEqual({
        merge_method: 'squash',
        sha: '6378c0009ba02dd15f0af334b9902a58b260913f',
      });
      // Its worktree held nothing past the merged head: the card's branch went from origin.
      expect(calls('-X DELETE').map((c) => c.argv)).toEqual([
        ['api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${seven.branch}`],
      ]);
      expect(done?.pr?.branch).toEqual({ deleted: true, why: null });
      writeRepo();
    },
  );

  test(
    'Done runs clear after the next local midnight: a clean worktree removed, one with work kept',
    { timeout: 30_000 },
    async () => {
      // Five reproduced on its merge base (left changed there); six has a file nobody committed;
      // seven a commit nobody pushed.
      const base = fiveBase;

      // Made by the merge test: without it the write would land in the package's own folder
      expect(base).not.toBe('');
      writeFileSync(join(base, 'README.md'), '# tried\n');
      writeFileSync(join(six.worktree, 'notes.txt'), 'later\n');
      writeFileSync(join(seven.worktree, 'more.txt'), 'more\n');
      git(seven.worktree, 'add', 'more.txt');
      git(seven.worktree, 'commit', '-q', '-m', 'more');
      // GitHub deleted five's branch after its squash merge, and a fetch pruned it here: its
      // commit is on no remote now, yet it is the head its pull request merged.
      git(remote, 'branch', '-D', five.branch);
      git(repo, 'update-ref', '-d', `refs/remotes/origin/${five.branch}`);
      s.clock.tick(30 * 60_000);
      expect((await status()).map((r) => r.card)).toEqual([4, 5, 6, 7]);
      s.clock.tick(25 * 3_600_000);
      // The run still in pr stays.
      expect((await status()).map((r) => r.card)).toEqual([4]);
      // History: the cleared runs, read with --cleared.
      const history = doc(
        FactoryStatusData,
        await s.request('factory', 'status', '--cleared', '--json'),
      );

      expect(history.ok && history.data.runs.map((r) => [r.card, r.state])).toEqual([
        [5, 'done'],
        [6, 'done'],
        [7, 'done'],
      ]);
      expect([base, five.worktree, six.worktree, seven.worktree].map((p) => existsSync(p))).toEqual(
        [false, false, true, true],
      );
      const cleared = (id: string) =>
        Run.parse(JSON.parse(readFileSync(join(sessionDir(s.state.dir, id), 'run.json'), 'utf8')))
          .cleared;

      expect([cleared(five.id), cleared(six.id), cleared(seven.id)]).toMatchObject([
        { worktree: 'removed', why: null },
        { worktree: 'kept', why: '1 uncommitted' },
        { worktree: 'kept', why: '1 unpushed commit' },
      ]);
      // The branch of the removed one stays, and its sessions are stopped.
      expect(git(repo, 'branch', '--list', five.branch)).toContain(five.branch);
      const sessions = doc(SessionListData, await s.request('session', 'list', '--json'));

      expect(
        sessions.ok &&
          sessions.data.sessions
            .filter((x) => [five.id, six.id, seven.id].includes(x.id))
            .map((x) => x.state),
      ).toEqual(['ended', 'ended', 'ended']);
    },
  );

  test(
    "auto merge with work in the worktree past the merged head: the card's branch stays on origin",
    { timeout: 30_000 },
    async () => {
      writeRepo([
        `board: ${JSON.stringify(BOARD)}`,
        'overrides:',
        '  autoMerge: { value: true, reason: demo shop merges on green }',
      ]);
      const eight = await toPr(8);
      const green = [ghWorkflowRun('ci', 'completed', 'success')];

      openOn(85, eight.branch);
      expect(await pr(eight, GOOD)).toMatchObject({ ok: true });
      // Then a commit nobody pushed: the branch on origin is where it would go.
      writeFileSync(join(eight.worktree, 'later.txt'), 'later\n');
      git(eight.worktree, 'add', 'later.txt');
      git(eight.worktree, 'commit', '-q', '-m', 'later');
      const before = calls('-X DELETE').length;

      say(
        [`pr view 85 -R`, { json: ghPrView(REPO, 85, { head: eight.branch }) }],
        ...ghChecks(HEAD_SHA, green),
        [
          `pulls/85/merge`,
          { json: { sha: 'sha-eight', merged: true, message: 'Pull Request successfully merged' } },
        ],
      );
      const merged = await readUntil(
        'AB#8 merged',
        () => runOf(8),
        (r) => r?.pr?.state === 'merged',
      );

      expect(merged?.pr?.branch).toEqual({
        deleted: false,
        why: 'the worktree holds work: 1 unpushed commit',
      });
      expect(calls('-X DELETE')).toHaveLength(before);
      writeRepo();
    },
  );

  test(
    'a repo with no check that has a command (#159): its Verified line says nothing was run, and auto merge never merges it',
    { timeout: 30_000 },
    async () => {
      writeRepo(
        [
          `board: ${JSON.stringify(BOARD)}`,
          'overrides:',
          '  autoMerge: { value: true, reason: demo shop merges on green }',
        ],
        false,
      );
      const nine = await toPr(9);

      expect(await runOf(9)).toMatchObject({ noChecks: true });
      openOn(96, nine.branch);
      expect(await pr(nine, GOOD)).toMatchObject({
        ok: true,
        data: {
          state: 'needs-you',
          reason: 'no checks configured, nothing was run: a person reviews and merges',
          pr: { merge: 'person' },
        },
      });
      const [create] = calls(`-X POST repos/${REPO}/pulls`).filter((c) =>
        c.stdin.includes(nine.branch),
      );

      expect(z.object({ body: z.string() }).parse(JSON.parse(create?.stdin ?? '')).body).toContain(
        '**Verified:** no checks configured: nothing was run. signed in on test with a new account (After).',
      );
      // Its checks green on GitHub: serve still never merges it.
      say(
        [`pr view 96 -R`, { json: ghPrView(REPO, 96, { head: nine.branch }) }],
        ...ghChecks(HEAD_SHA, [ghWorkflowRun('ci', 'completed', 'success')]),
      );
      await readUntil(
        'AB#9 read green',
        () => runOf(9),
        (r) => r?.pr?.checks === 'success',
      );
      expect(calls('pulls/96/merge')).toEqual([]);
      writeRepo();
    },
  );

  test(
    "a run's branch starts at origin/main fetched at launch, not the checkout's stale main (#198)",
    { timeout: 30_000 },
    async () => {
      // A pull request merged on GitHub since the checkout last pulled.
      const teammate = join(root, 'teammate');

      git(root, 'clone', '-q', remote, teammate);
      writeFileSync(join(teammate, 'merged.txt'), 'merged on GitHub\n');
      git(teammate, 'add', 'merged.txt');
      git(teammate, 'commit', '-q', '-m', 'a merged pull request');
      git(teammate, 'push', '-q', 'origin', 'main');
      const merged = git(teammate, 'rev-parse', 'HEAD');

      expect(git(repo, 'rev-parse', 'main')).not.toBe(merged);
      const ten = await toPr(10);

      expect(git(ten.worktree, 'merge-base', 'HEAD', merged)).toBe(merged);
      const session = doc(SessionData, await s.request('session', 'show', ten.id, '--json'));

      expect(session).toMatchObject({
        ok: true,
        data: { base: { from: 'origin/main', commit: merged, note: null } },
      });
    },
  );

  test(
    'a conflicting pull request needs you as a conflict, and its session is told to merge the base in (#199)',
    { timeout: 30_000 },
    async () => {
      const eleven = await toPr(11);

      openOn(111, eleven.branch);
      expect(await pr(eleven, GOOD)).toMatchObject({ ok: true });
      // GitHub cannot merge it, so it runs no checks on it.
      say([
        `pr view 111 -R`,
        { json: ghPrView(REPO, 111, { head: eleven.branch, mergeable: 'CONFLICTING' }) },
      ]);
      const conflicting = await readUntil(
        'AB#11 conflicting',
        () => runOf(11),
        (r) => r?.reason !== 'merge waits for a person',
      );

      expect(conflicting).toMatchObject({
        state: 'needs-you',
        reason: 'PR #111 conflicts with main: bring the branch up to date',
      });
      const told = await until('the conflict typed into its session', () =>
        claudeOutput(eleven.worktree).typed.find(
          (t) => typeof t === 'string' && t.includes('conflicts with main'),
        ),
      );

      expect(told).toContain('origin is fetched: merge origin/main into your branch');
      expect(told).toContain('run abe factory pr again');
      // Read again with the same head, through GitHub's unknown while it works it out: told once.
      const twoMoreReads = async () => {
        const read = calls('pr view 111 -R').length;

        await until('two more reads of #111', () =>
          calls('pr view 111 -R').length >= read + 2 ? true : undefined,
        );
      };

      await twoMoreReads();
      say([
        `pr view 111 -R`,
        { json: ghPrView(REPO, 111, { head: eleven.branch, mergeable: 'UNKNOWN' }) },
      ]);
      await twoMoreReads();
      expect(await runOf(11)).toMatchObject({
        reason: 'PR #111 conflicts with main: bring the branch up to date',
      });
      say([
        `pr view 111 -R`,
        { json: ghPrView(REPO, 111, { head: eleven.branch, mergeable: 'CONFLICTING' }) },
      ]);
      await twoMoreReads();
      expect(
        claudeOutput(eleven.worktree).typed.filter(
          (t) => typeof t === 'string' && t.includes('conflicts with main'),
        ),
      ).toHaveLength(1);
      // The base brought in: mergeable again, it waits on its checks and the person, not on a conflict.
      say([`pr view 111 -R`, { json: ghPrView(REPO, 111, { head: eleven.branch }) }]);
      expect(
        await readUntil(
          'AB#11 mergeable again',
          () => runOf(11),
          (r) => r?.reason !== 'PR #111 conflicts with main: bring the branch up to date',
        ),
      ).toMatchObject({ reason: 'merge waits for a person' });
    },
  );

  test(
    "a spec'd run's pull request closes its spec issue and slices; an issue it opens later stays open (#200)",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'Specifying.' }]);
      const launched = doc(
        FactoryRunData,
        await s.request('factory', 'run', '12', '--repo', repo, '--json'),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      await readUntil(
        'AB#12 in spec',
        () => runOf(12),
        (r) => r?.stage === 'spec',
      );
      const twelve = { id: launched.data.session, worktree: launched.data.worktree };
      const shown = doc(SessionData, await s.request('session', 'show', twelve.id, '--json'));

      if (!shown.ok) throw new Error(JSON.stringify(shown.error));
      const branch = shown.data.branch;
      const as = (...argv: string[]) => s.requestAs(twelve.id, twelve.worktree, ...argv);
      const issue = async (n: number, ...more: string[]) => {
        const body = join(twelve.worktree, '.scratch', `issue-${n}.md`);

        mkdirSync(dirname(body), { recursive: true });
        writeFileSync(body, `Issue ${n}.\n`);
        say(
          [`-X POST repos/${REPO}/issues --input`, { json: ghIssue(REPO, n) }],
          [`issues/${n}/sub_issues`, { json: [] }],
          [`issues/${n}/parent`, NOT_FOUND],
          [`repos/${REPO}/issues/${n}`, { json: ghIssue(REPO, n) }],
        );
        const made = await as(
          'issue',
          'create',
          '--repo',
          REPO,
          '--title',
          `Issue ${n}`,
          '--body-file',
          body,
          ...more,
          '--json',
        );

        expect(JSON.parse(made.stdout)).toMatchObject({ ok: true, data: { number: n } });
      };

      // The spec stage: the spec issue; to-tickets: its slices as sub-issues. Meanwhile origin
      // names GitHub as it is (a session's issue goes only to its origin's repo, read rewritten).
      git(repo, 'config', '--unset', `url.${remote}.insteadOf`);
      await issue(121, '--label', 'spec');
      expect(
        doc(FactoryRunData, await as('factory', 'stage-done', 'spec', '--json')),
      ).toMatchObject({ ok: true, data: { stage: 'step', step: 'to-tickets' } });
      await issue(122, '--parent', '121');
      await issue(123, '--parent', '121');
      expect(
        doc(FactoryRunData, await as('factory', 'stage-done', 'to-tickets', '--json')),
      ).toMatchObject({ ok: true, data: { stage: 'build' } });
      // A bug it finds while building is no part of the spec.
      await issue(124);
      git(repo, 'config', `url.${remote}.insteadOf`, ORIGIN);
      expect(
        doc(FactoryRunData, await as('factory', 'stage-done', 'build', '--json')),
      ).toMatchObject({ ok: true });
      await readUntil(
        'AB#12 in review',
        () => runOf(12),
        (r) => r?.stage === 'review',
      );
      expect(
        doc(FactoryRunData, await as('factory', 'review', '--findings', '0', '--json')),
      ).toMatchObject({ ok: true, data: { stage: 'verify' } });
      writeFileSync(join(twelve.worktree, '.scratch', 'verify-12.md'), '# Verify after\n');
      expect(
        doc(
          FactoryRunData,
          await as(
            ...['factory', 'verify', '--phase', 'after', '--result', 'pass'],
            ...['--report', join(twelve.worktree, '.scratch', 'verify-12.md'), '--json'],
          ),
        ),
      ).toMatchObject({ ok: true, data: { stage: 'step', step: 'playbook' } });
      expect(
        doc(
          FactoryRunData,
          await as('factory', 'judge', '--answer', 'no', '--reason', 'nothing by hand', '--json'),
        ),
      ).toMatchObject({ ok: true, data: { stage: 'pr' } });
      openOn(125, branch);
      expect(await pr({ id: twelve.id, worktree: twelve.worktree }, GOOD)).toMatchObject({
        ok: true,
      });
      const [create] = calls(`-X POST repos/${REPO}/pulls`).filter((c) => c.stdin.includes(branch));
      const body = z.object({ body: z.string() }).parse(JSON.parse(create?.stdin ?? '')).body;

      expect(body).toEndWith('\n\nCloses #121, closes #122, closes #123\n\nCard: AB#12\n');
      expect(body).not.toContain('#124');
    },
  );
  /** `abe factory end` as the person types it, read as its answer. */
  const end = async (id: number, as: string, reason: string) =>
    doc(
      FactoryEndData,
      await s.request('factory', 'end', String(id), '--as', as, '--reason', reason, '--json'),
    );
  const sessionState = async (id: string) => {
    const shown = doc(SessionData, await s.request('session', 'show', id, '--json'));

    return shown.ok ? shown.data.state : undefined;
  };
  const comments = (id: number) =>
    board
      .cards()
      .find((c) => c.id === id)
      ?.comments.map((c) => c.text) ?? [];

  test(
    'a failed deploy nobody can fix here (#184): the person ends the run as done, the pull request gets why (the card no comment), the card goes to Done, its session stops',
    { timeout: 30_000 },
    async () => {
      const fourteen = await toPr(14);

      openOn(141, fourteen.branch);
      expect(await pr(fourteen, GOOD)).toMatchObject({ ok: true });
      merged(141, fourteen.branch, 'sha-fourteen');
      deploy('sha-fourteen', 1401, 'failure');
      await readUntil(
        'AB#14 deploy failed',
        () => runOf(14),
        (r) => r?.pr?.deploy === 'failure',
      );
      // Its status names the way out.
      expect((await s.request('factory', 'status', '14')).stdout).toContain(
        '\n  next      re-run the deploy and Done follows, or end the run: abe factory end 14 --as done|abandoned --reason <why>\n',
      );
      say([`repos/${REPO}/issues/141/comments`, { json: ghIssueComment(REPO, 141, 5, 'x') }]);
      const ended = await end(14, 'done', 'the throwaway repo has no AWS: deployed by hand');

      expect(ended).toMatchObject({
        ok: true,
        data: {
          card: 14,
          as: 'done',
          comment: NOT_COMMENTED,
          pr: `commented on https://github.com/${REPO}/pull/141`,
          session: `${fourteen.id} stopped`,
          run: {
            stage: 'done',
            state: 'done',
            outcome: 'done',
            reason: null,
            ended: {
              as: 'done',
              from: 'pr',
              reason: 'the throwaway repo has no AWS: deployed by hand',
            },
          },
        },
      });
      const said = [
        '**Factory run ended: done.** the throwaway repo has no AWS: deployed by hand',
        '',
        `Ended by a person in pr (session ${fourteen.id}, \`abe factory end\`). It waited on: the deploy to test failed: https://github.com/o/r/actions/runs/14010`,
      ].join('\n');

      expect(comments(14)).toEqual([]);
      const [posted] = calls('issues/141/comments');

      expect(z.object({ body: z.string() }).parse(JSON.parse(posted?.stdin ?? '')).body).toBe(said);
      expect(await sessionState(fourteen.id)).toBe('ended');
      await readUntil(
        'AB#14 Closed',
        () => Promise.resolve(stateOf(14)),
        (state) => state === 'Closed',
      );
      // Ended once: again is refused, and nothing more is written.
      expect(await end(14, 'abandoned', 'again')).toMatchObject({
        ok: false,
        error: { code: 'run-done' },
      });
      expect(comments(14)).toEqual([]);
    },
  );

  test(
    "a bug that does not reproduce, said in build (#184): ended not-reproduced with the agent's words; abandoned work goes back to New",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        {
          abe: ['factory', 'needs-you', '--reason', 'Not reproduced on main (939433b)', '--json'],
        },
      ]);
      const launched = doc(
        FactoryRunData,
        await s.request('factory', 'run', '15', '--repo', repo, '--json'),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      await readUntil(
        'AB#15 needs you',
        () => runOf(15),
        (r) => r?.reason === 'Not reproduced on main (939433b)',
      );
      expect((await s.request('factory', 'status', '15')).stdout).toContain(
        '\n  next      answer in Chat to go on, or end the run: abe factory end 15 --as not-reproduced --reason <why>\n',
      );
      // asked in another repo's checkout: its #15 is not this one, nothing ends (#256)
      const other = join(root, 'other-shop');

      git(root, 'init', '-q', '-b', 'main', other);
      git(other, 'remote', 'add', 'origin', 'https://github.com/mkdir-swe/other-shop.git');
      const elsewhere = await s.requestIn(
        other,
        ...['factory', 'end', '15', '--as', 'abandoned', '--reason', 'wrong repo', '--json'],
      );

      expect(JSON.parse(elsewhere.stdout)).toMatchObject({ ok: false, error: { code: 'no-run' } });
      expect(await runOf(15)).toMatchObject({ outcome: null });
      expect(await end(15, 'not-reproduced', 'fixed on main already')).toMatchObject({
        ok: true,
        data: {
          pr: null,
          session: `${launched.data.session} stopped`,
          run: { outcome: 'not-reproduced' },
        },
      });
      expect(comments(15)).toEqual([]);
      await readUntil(
        'AB#15 Closed',
        () => Promise.resolve(stateOf(15)),
        (state) => state === 'Closed',
      );

      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
      ]);
      const twelve = doc(
        FactoryRunData,
        await s.request('factory', 'run', '16', '--repo', repo, '--json'),
      );

      if (!twelve.ok) throw new Error(JSON.stringify(twelve.error));
      await readUntil(
        'AB#16 Active',
        () => Promise.resolve(stateOf(16)),
        (state) => state === 'Active',
      );
      expect(await end(16, 'abandoned', 'the team dropped it')).toMatchObject({
        ok: true,
        data: { run: { outcome: 'abandoned', state: 'done' } },
      });
      await readUntil(
        'AB#16 New',
        () => Promise.resolve(stateOf(16)),
        (state) => state === 'New',
      );
    },
  );

  test(
    'factory end on a card with several runs ends its live one, its checkout named through a symlink (#336, #337)',
    { timeout: 30_000 },
    async () => {
      const waitOnYou = (reason: string) => {
        scriptClaude(s.state.dir, [
          {
            abe: ['factory', 'stage-done', 'create-specification', '--json'],
          },
          { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
          { abe: ['factory', 'needs-you', '--reason', reason, '--json'] },
        ]);
      };
      const runIn = async (checkout: string, reason: string) => {
        waitOnYou(reason);
        const ran = doc(
          FactoryRunData,
          await s.request('factory', 'run', '18', '--repo', checkout, '--json'),
        );

        if (!ran.ok) throw new Error(JSON.stringify(ran.error));
        await readUntil(
          `AB#18 ${reason}`,
          () => status(18),
          (runs) => runs.some((r) => r.session === ran.data.session && r.reason === reason),
        );

        return ran.data;
      };
      // a symlink to the checkout's folder (macOS: tmpdir's /var is /private/var's too)
      const link = join(root, 'link');
      const real = realpathSync(repo);

      symlinkSync(root, link);
      const first = await runIn(real, 'first');

      expect(await end(18, 'abandoned', 'the first go')).toMatchObject({
        ok: true,
        data: { session: `${first.session} stopped` },
      });
      const second = await runIn(join(link, 'demo'), 'second');

      // stored as the checkout's real path, as git and every other read name it
      expect(second.repo).toBe(real);
      const ended = await s.requestIn(
        real,
        ...['factory', 'end', '18', '--as', 'abandoned', '--reason', 'the second go', '--json'],
      );

      expect(JSON.parse(ended.stdout)).toMatchObject({
        ok: true,
        data: { session: `${second.session} stopped`, run: { outcome: 'abandoned' } },
      });
    },
  );

  test(
    'factory.done merged (#184): a repo with no deploy to wait for is Done at its merge',
    { timeout: 30_000 },
    async () => {
      writeRepo([`board: ${JSON.stringify(BOARD)}`, 'factory.done: merged']);
      const seventeen = await toPr(17);

      openOn(171, seventeen.branch);
      expect(await pr(seventeen, GOOD)).toMatchObject({ ok: true });
      merged(171, seventeen.branch, 'sha-seventeen');
      expect(
        await readUntil(
          'AB#17 done',
          () => runOf(17),
          (r) => r?.stage === 'done',
        ),
      ).toMatchObject({ outcome: 'done', pr: { state: 'merged', deploy: null, done: 'merged' } });
      expect(calls('sha=sha-seventeen')).toEqual([]);
      writeRepo();
    },
  );

  test(
    "a run keeps the end its Layers said at its start (#9): another launch's Layer on its box changes none of it",
    { timeout: 30_000 },
    async () => {
      writeRepo([`board: ${JSON.stringify(BOARD)}`, 'factory.done: merged']);
      const twentyTwo = await toPr(22);

      // The Layer changes mid-run (a later launch handing another one): Done is still the merge.
      writeRepo();
      openOn(221, twentyTwo.branch);
      expect(await pr(twentyTwo, GOOD)).toMatchObject({ ok: true });
      merged(221, twentyTwo.branch, 'sha-twenty-two');
      expect(
        await readUntil(
          'AB#22 done',
          () => runOf(22),
          (r) => r?.stage === 'done',
        ),
      ).toMatchObject({ outcome: 'done', pr: { state: 'merged', deploy: null, done: 'merged' } });
      expect(calls('sha=sha-twenty-two')).toEqual([]);
    },
  );

  test(
    'a Done run reopened (#343): its conversation is never stopped for the run, nor cleared at midnight while open',
    { timeout: 40_000 },
    async () => {
      writeRepo([`board: ${JSON.stringify(BOARD)}`, 'factory.done: merged']);
      const toDone = async (card: number, n: number) => {
        const run = await toPr(card);

        openOn(n, run.branch);
        expect(await pr(run, GOOD)).toMatchObject({ ok: true });
        merged(n, run.branch, `sha-${card}`);
        await readUntil(
          `AB#${card} done`,
          () => runOf(card),
          (r) => r?.stage === 'done',
        );

        return run;
      };
      // Nineteen is Done and left alone: its clearing says a midnight sweep ran.
      const nineteen = await toDone(19, 191);
      const twenty = await toDone(20, 201);
      const show = async () =>
        doc(SessionData, await s.request('session', 'show', twenty.id, '--json'));

      // #304 stops it at Done; Reopen brings its conversation back, waiting for you.
      await readUntil('AB#20 session ended', show, (r) => r.ok && r.data.state === 'ended');
      expect(
        doc(SessionData, await s.request('session', 'reopen', twenty.id, '--json')),
      ).toMatchObject({ ok: true, data: { id: twenty.id } });
      await readUntil('AB#20 reopened', show, (r) => r.ok && r.data.state === 'waiting');
      // Past midnight: nineteen cleared; twenty, still open, stays with its worktree, and Done
      // never stopped it again meanwhile.
      s.clock.tick(25 * 3_600_000);
      await readUntil(
        'AB#19 cleared',
        () => status(),
        (runs) => runs.every((r) => r.card !== 19),
      );
      expect(existsSync(nineteen.worktree)).toBe(false);
      expect(await runOf(20)).toMatchObject({ state: 'done' });
      expect(existsSync(twenty.worktree)).toBe(true);
      expect(await show()).toMatchObject({ ok: true, data: { state: 'waiting' } });
      // Once you stop it, the next sweep clears it as any Done run.
      expect((await s.request('session', 'stop', twenty.id)).exit).toBe(0);
      await readUntil(
        'AB#20 cleared',
        () => status(),
        (runs) => runs.every((r) => r.card !== 20),
      );
      writeRepo();
    },
  );

  test(
    'Investigate: its spike pushed as a pull request’s branch is and kept with its report, nothing commented on the card, the card Done',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [{ say: 'Looking into it.' }]);
      const launched = doc(
        FactoryRunData,
        await s.request(
          ...['factory', 'run', '25', '--repo', repo, '--workflow', 'investigate', '--json'],
        ),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      const run = launched.data;
      const shown = doc(SessionData, await s.request('session', 'show', run.session, '--json'));

      if (!shown.ok) throw new Error(JSON.stringify(shown.error));
      const branch = shown.data.branch;

      git(repo, 'config', `url.${remote}.insteadOf`, ORIGIN);
      // the spike: throwaway code committed on the card branch
      writeFileSync(join(run.worktree, 'spike.txt'), 'tried a cache\n');
      git(run.worktree, 'add', 'spike.txt');
      git(run.worktree, 'commit', '-q', '-m', 'spike');
      const report = join(run.worktree, '.scratch', 'report-25.md');

      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, '# Why is sign-in slow?\n\n**Answer:** the cache misses.\n');
      const ended = doc(
        FactoryRunData,
        await s.requestAs(
          run.session,
          run.worktree,
          ...['factory', 'stage-done', 'investigate', '--report', report, '--json'],
        ),
      );

      expect(ended).toMatchObject({
        ok: true,
        data: { outcome: 'reported', reported: { step: 'investigate', done: true } },
      });
      // kept on what the run reported: the spike's branch and its commits since the merge base
      const kept = await readUntil(
        'AB#25 spike kept',
        () => runOf(25),
        (r) => (r?.reported?.spike ?? null) !== null,
      );

      expect(git(remote, 'branch', '--list', branch)).toContain(branch);
      expect(kept?.reported?.spike).toMatchObject({
        branch,
        pushed: true,
        commits: [{ subject: 'spike' }],
      });
      await readUntil(
        'AB#25 Closed',
        () => Promise.resolve(stateOf(25)),
        (state) => state === 'Closed',
      );
      // the report stays with the run: the board port wrote no comment
      expect(comments(25)).toEqual([]);
    },
  );

  test(
    "what each step made and each review found, kept on the run; its checks with their env's names only",
    { timeout: 30_000 },
    async () => {
      const tickets = {
        kind: 'tickets',
        parent: `${REPO}#40`,
        tickets: [
          { id: 'T1', ref: '#41', title: 'Sign-in tokens', from: ['story-1', 'criterion-2'] },
        ],
      };
      const lanes = {
        kind: 'build',
        lanes: [
          {
            ticket: 'T1',
            ref: '#41',
            title: 'Sign-in tokens',
            worktree: '26-t1',
            commits: [{ sha: 'a1f20c3', subject: 'Sign-in tokens' }],
            tests: [{ name: 'typecheck', ok: true }],
            tookMs: 240_000,
          },
        ],
      };
      const found = {
        findings: [
          {
            id: 'F1',
            axis: 'standards',
            file: 'auth/token.ts',
            line: 58,
            text: 'The expiry is a bare 900000',
            fix: 'name it LINK_WINDOW_MS',
          },
          {
            id: 'F2',
            axis: 'spec',
            file: 'auth/link.ts',
            line: 12,
            text: 'The link text differs from the spec',
            severity: 'noted',
          },
        ],
        risk: { risky: true, why: 'authentication: a new sign-in path' },
      };
      const file = (name: string, doc: unknown) => ({
        write: { path: `.scratch/26/${name}`, text: JSON.stringify(doc) },
      });

      scriptClaude(s.state.dir, [
        { abe: ['factory', 'stage-done', 'create-specification', '--json'] },
        file('tickets.json', tickets),
        {
          abe: [
            'factory',
            'stage-done',
            'to-tickets',
            '--made',
            '.scratch/26/tickets.json',
            '--json',
          ],
        },
        file('build.json', { kind: 'build' }),
        { abe: ['factory', 'stage-done', 'build', '--made', '.scratch/26/build.json', '--json'] },
        file('build.json', lanes),
        { abe: ['factory', 'stage-done', 'build', '--made', '.scratch/26/build.json', '--json'] },
        file('review.json', found),
        {
          abe: [
            ...['factory', 'review', '--findings', '2'],
            ...['--findings-file', '.scratch/26/review.json', '--json'],
          ],
        },
        {
          abe: [
            ...['factory', 'review', '--findings', '1'],
            ...['--findings-file', '.scratch/26/review.json', '--json'],
          ],
        },
      ]);
      const launched = doc(
        FactoryRunData,
        await s.request('factory', 'run', '26', '--repo', repo, '--json'),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      const run = await readUntil(
        'AB#26 reviewed',
        () => runOf(26),
        (r) => (r?.reviews.length ?? 0) > 0,
      );
      // a file that does not hold, and a count the file does not have: refused, naming why
      const refusals = claudeOutput(launched.data.worktree)
        .abe.map((a) => z.object({ stdout: z.string() }).parse(a).stdout)
        .flatMap((out) => {
          const said = z
            .object({ ok: z.literal(false), error: z.object({ code: z.string() }) })
            .safeParse(JSON.parse(out));

          return said.success ? [said.data.error.code] : [];
        });

      expect(refusals).toEqual(['bad-made', 'bad-findings']);
      expect(run?.made?.map((m) => m.made)).toMatchObject([
        { kind: 'tickets', tickets: [{ id: 'T1', from: ['story-1', 'criterion-2'] }] },
        { kind: 'build', lanes: [{ ticket: 'T1', worktree: '26-t1', merged: true }] },
      ]);
      expect(run?.reviews.at(-1)).toMatchObject({
        findings: 1,
        items: [
          { id: 'F1', line: 58, severity: 'must' },
          { id: 'F2', severity: 'noted' },
        ],
        risk: { risky: true },
      });
      // the checks after build, kept with the names they ran with, never a value
      const [kept] = run?.checks ?? [];

      expect(kept).toMatchObject({ cause: 'checks', verdict: 'green', env: { name: null } });
      const named = ['CI', 'PATH', 'USER'];

      expect(kept?.env?.keys.filter((k) => named.includes(k))).toEqual(named);
      expect(JSON.stringify(run?.checks)).not.toContain(claude.path);
      expect(JSON.stringify(run?.checks)).not.toContain('tester');
    },
  );

  test(
    "into: a teammate's branch: the card branch starts on it, the pull request goes into it, never pushed onto it; refused while origin lacks it",
    { timeout: 30_000 },
    async () => {
      // The teammate's pull request's head, on origin with a commit main lacks.
      const theirs = 'feature/cart-badge';
      const mate = join(root, 'mate');

      git(root, 'clone', '-q', remote, mate);
      git(mate, 'switch', '-q', '-c', theirs);
      writeFileSync(join(mate, 'badge.txt'), 'cart badge\n');
      git(mate, 'add', 'badge.txt');
      git(mate, 'commit', '-q', '-m', 'cart badge');
      git(mate, 'push', '-q', 'origin', theirs);
      const head = git(remote, 'rev-parse', theirs);

      mkdirSync(join(repo, '.abe', 'workflows'), { recursive: true });
      writeFileSync(
        join(repo, '.abe', 'workflows', 'review-pr.local.yaml'),
        [
          'name: Review PR',
          'steps:',
          '  - audit: { skill: code-review, reports: [audit.head] }',
          '  - pr: { skill: pr, fresh: true, into: audit.head }',
          '',
        ].join('\n'),
      );
      scriptClaude(s.state.dir, [
        {
          abe: [...['factory', 'stage-done', 'audit', '--fact', `audit.head=${theirs}`, '--json']],
        },
      ]);
      const launched = doc(
        FactoryRunData,
        await s.request(
          ...['factory', 'run', '27', '--repo', repo, '--workflow', 'review-pr', '--json'],
        ),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      await readUntil(
        'AB#27 in pr',
        () => runOf(27),
        (r) => r?.stage === 'pr',
      );
      const run = { id: launched.data.session, worktree: launched.data.worktree };
      const branch = git(run.worktree, 'branch', '--show-current');

      // the card branch holds their commit: what is built lands on their work
      expect(git(run.worktree, 'rev-parse', 'HEAD')).toBe(head);
      writeFileSync(join(run.worktree, 'badge.txt'), 'cart badge, fixed\n');
      git(run.worktree, 'commit', '-q', '-am', 'fix the badge');
      // their branch gone from origin: refused before anything is pushed or opened
      git(remote, 'branch', '-D', theirs);
      const gone = await pr(run, GOOD);

      expect(gone.ok ? 'opened' : gone.error.code).toBe('no-into-branch');
      expect(git(remote, 'branch', '--list', branch)).toBe('');
      expect(calls(`-X POST repos/${REPO}/pulls`).filter((c) => c.stdin.includes(branch))).toEqual(
        [],
      );
      // back on origin: the pull request goes from the card branch into theirs, naming theirs
      git(mate, 'push', '-q', 'origin', theirs);
      openOn(271, branch);
      say(
        [`head=acme:${theirs}`, { json: [ghPull(REPO, 41)] }],
        [`pr view 41 -R`, { json: ghPrView(REPO, 41, { head: theirs }) }],
      );
      expect(await pr(run, GOOD)).toMatchObject({ ok: true });
      const create = calls(`-X POST repos/${REPO}/pulls`).find((c) => c.stdin.includes(branch));
      const sent = z
        .object({ head: z.string(), base: z.string(), body: z.string() })
        .parse(JSON.parse(create?.stdin ?? ''));

      expect([sent.head, sent.base]).toEqual([branch, theirs]);
      expect(sent.body.startsWith(`Fixes onto \`${theirs}\` (#41).\n\n`)).toBe(true);
      // their branch is as they pushed it; the fix is on the card branch, on top of theirs
      expect(git(remote, 'rev-parse', theirs)).toBe(head);
      expect(git(remote, 'rev-parse', `${branch}~1`)).toBe(head);
      expect(await runOf(27)).toMatchObject({ pr: { number: 271, merge: 'person' } });
    },
  );

  test('factory end: a card with no run, no reason, an unknown way', async () => {
    expect(await end(99, 'done', 'x')).toMatchObject({ ok: false, error: { code: 'no-run' } });
    const blank = await s.request('factory', 'end', '4', '--as', 'done', '--reason', ' ', '--json');

    expect(JSON.parse(blank.stdout)).toMatchObject({
      ok: false,
      error: { code: 'reason-required' },
    });
    expect((await s.request('factory', 'end', '4', '--as', 'gone', '--reason', 'x')).exit).toBe(2);
  });

  describe('the playbook step: serve reads the Playbook the session wrote', () => {
    const playbookDone = (run: { id: string; worktree: string }) =>
      s
        .requestAs(run.id, run.worktree, 'factory', 'stage-done', 'playbook', '--json')
        .then((r) => doc(FactoryRunData, r));
    const write = (run: { worktree: string }, card: number, who: string) => {
      const file = join(run.worktree, '.abe', 'playbooks', `${card}.md`);

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          '# Sign in: playbook',
          '',
          'Done when: a person signs in with email on prod',
          '',
          '## 1. Add the mail secret on test',
          '',
          'Who: Abe',
          'Where: test',
          'Runnable: no',
          '',
          'Check: test sends the sign-in mail',
          '',
          '## 2. Deploy to prod',
          '',
          `Who: ${who}`,
          'Where: prod',
          'Runnable: yes',
          '',
          '```sh',
          'npm run deploy:prod',
          '```',
          '',
          'Check: prod sends the sign-in mail',
          '',
        ].join('\n'),
      );
    };

    test(
      'a change that needs none: no file, no Playbook, on to pr',
      { timeout: 30_000 },
      async () => {
        const run = await toPr(23, {}, { playbook: true });
        const done = await playbookDone(run);

        expect(done.ok && [done.data.stage, done.data.playbook]).toEqual(['pr', null]);
      },
    );

    test(
      "one that needs steps: a prod step handed to Abe is refused; marked the person's, it is kept",
      { timeout: 30_000 },
      async () => {
        const run = await toPr(24, {}, { playbook: true });

        write(run, 24, 'Abe');
        const refused = await playbookDone(run);

        expect(refused).toMatchObject({ ok: false, error: { code: 'bad-playbook' } });
        expect(refused.ok ? '' : refused.error.message).toContain(
          "step 2 is the person's (prod is not enabled for agents in this repo)",
        );
        expect((await runOf(24))?.step).toBe('playbook');
        write(run, 24, 'you');
        const done = await playbookDone(run);

        expect(done.ok && done.data.stage).toBe('pr');
        expect((await runOf(24))?.playbook).toEqual({
          path: '.abe/playbooks/24.md',
          title: 'Sign in',
          doneWhen: 'a person signs in with email on prod',
          steps: [
            {
              n: 1,
              title: 'Add the mail secret on test',
              by: 'abe',
              where: 'test',
              runnable: false,
              theirs: null,
              command: null,
              check: 'test sends the sign-in mail',
              undo: null,
            },
            {
              n: 2,
              title: 'Deploy to prod',
              by: 'you',
              where: 'prod',
              runnable: true,
              theirs: 'prod is not enabled for agents in this repo',
              command: 'npm run deploy:prod',
              check: 'prod sends the sign-in mail',
              undo: null,
            },
          ],
        });
      },
    );
  });
});
