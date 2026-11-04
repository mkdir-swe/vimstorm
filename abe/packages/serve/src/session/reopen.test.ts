/**
 * `abe session reopen` (#343) on a real `serve` in this process (its requests as the client sends
 * them), the fake Azure DevOps for the cards through the real board port, a real git checkout,
 * and the fake `claude` in a real `tmux` (its `abe` this checkout's, as a process), which
 * resumes only a conversation it kept (`--resume <id>` with no transcript fails as Claude Code's
 * does). The same session id goes on in the same worktree, made again from its branch when it
 * was cleared; a run not over goes on at its stage, a run over is a plain conversation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRASHED,
  FACTORY_RUN_INSTRUCTIONS,
  FactoryRunData,
  FactoryStatusData,
  PLAIN_SESSION_INSTRUCTIONS,
  REOPENED_PROMPT,
  RUN_OVER_INSTRUCTIONS,
  SessionData,
  SessionListData,
} from '@abe/core';
import { adoBoardFrom } from '@abe/ports';
import {
  claudeOutput,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  heldEvents,
  scriptClaude,
  served,
  type ServedCli,
  stuckClaude,
  tempState,
  type TempState,
  tmuxPath,
  until,
} from '@abe/testing';
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

/** `before`: what is on disk in the state directory before serve starts. */
const world = async (before?: (state: TempState, repo: string) => void): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-r-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\nenvironments: {}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  const state = tempState();
  const layers = { ABE_CONFIG_DIR: join(root, 'mine') };
  const path = `${claude.dir}:${az.dir}:/usr/bin:/bin`;

  before?.(state, repo);
  const abe = await served({
    state,
    cwd: repo,
    env: layers,
    // The Mac's board: the fake Azure DevOps with az's token, as `ABE_ADO_BASE_URL` makes it.
    board: adoBoardFrom({ PATH: path, ...ado.env }, join(state.dir, 'images')),
    sessions: { env: { PATH: path, ABE_TMUX: tmuxPath(), ...layers, ...ado.env } },
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

const launch = async (abe: ServedCli, repo: string, card: string) => {
  const out = await abe.json(SessionData, 'session', 'launch', '--card', card, '--repo', repo);

  if (!out.doc.ok) throw new Error(`launch refused: ${JSON.stringify(out.doc.error)}`);

  return out.doc.data;
};

const show = async (abe: ServedCli, id: string) => {
  const out = await abe.json(SessionData, 'session', 'show', id);

  if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

  return out.doc.data;
};

/** `id` once it stands at `state`. */
const reaches = (abe: ServedCli, id: string, state: string) =>
  until(
    () => `${id} ${state}`,
    async () => {
      const s = await show(abe, id);

      return s.state === state ? s : undefined;
    },
  );

const reopen = (abe: ServedCli, id: string, ...more: string[]) =>
  abe.json(SessionData, 'session', 'reopen', id, ...more);

const argvOf = (worktree: string) => z.array(z.string()).parse(claudeOutput(worktree).argv);

const typedIn = (worktree: string) => claudeOutput(worktree).typed;

const Reopened = z.object({
  type: z.literal('session.reopened'),
  data: z.object({ id: z.string(), worktree: z.string(), recreated: z.boolean() }),
});

/** The `session.reopened` event of `id`, once serve holds it. */
const reopenedEvent = (abe: ServedCli, id: string) =>
  until(
    () => `${id} reopened`,
    async () =>
      (await heldEvents(abe.state.socket))
        .map((line) => Reopened.safeParse(line))
        .find((e) => e.success && e.data.data.id === id)?.data?.data,
  );

describe('Reopen a plain session (#343)', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    scriptClaude(w.abe.state.dir, [{ say: 'Built the sign-in form.' }]);
  }, 30_000);
  afterAll(async () => {
    await done(w);
  });

  test(
    'stopped, then reopened: the same id, worktree and Claude Code conversation, waiting for you',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '4');
      const waited = await reaches(w.abe, first.id, 'waiting');
      const claudeId = /\/([0-9a-f-]{36})\.jsonl$/.exec(waited.transcriptPath ?? '')?.[1];

      expect(claudeId).toBeDefined();
      expect((await w.abe.run('session', 'stop', first.id)).exit).toBe(0);
      await reaches(w.abe, first.id, 'ended');

      const opened = await reopen(w.abe, first.id);

      expect(opened.doc).toMatchObject({
        ok: true,
        data: { id: first.id, worktree: first.worktree, branch: first.branch, stopped: false },
      });
      expect(await reopenedEvent(w.abe, first.id)).toMatchObject({
        worktree: first.worktree,
        recreated: false,
      });
      // Its conversation waits for you: no prompt, no Stop, waiting on you all the same.
      const back = await reaches(w.abe, first.id, 'waiting');

      expect(back.reopened).toHaveLength(1);
      expect(back.startedAt).toBe(first.startedAt);
      expect(back.transcriptPath).toBe(waited.transcriptPath);
      const argv = argvOf(first.worktree);

      expect(argv[argv.indexOf('--resume') + 1]).toBe(claudeId ?? '');
      expect(argv).not.toContain('--session-id');
      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toStartWith(
        PLAIN_SESSION_INSTRUCTIONS,
      );
      // No prompt after the instructions: the launch prompt is never sent again.
      expect(argv.at(-2)).toBe('--append-system-prompt');
      // One row in Sessions, not two.
      const listed = await w.abe.json(SessionListData, 'session', 'list');

      expect(listed.doc.ok && listed.doc.data.sessions.filter((s) => s.card === 4)).toHaveLength(1);
      // A message goes in as to any session waiting on you.
      expect((await w.abe.run('session', 'send', first.id, 'why this helper?')).exit).toBe(0);
      await until(
        () => 'the message typed in',
        () => (typedIn(first.worktree).includes('why this helper?') ? true : undefined),
      );
    },
  );

  test(
    'reopened with --message: that is its first prompt; a running one is refused',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '5');

      await reaches(w.abe, first.id, 'waiting');
      expect((await reopen(w.abe, first.id)).doc).toMatchObject({
        ok: false,
        error: { code: 'not-ended' },
      });
      await w.abe.run('session', 'stop', first.id);
      await reaches(w.abe, first.id, 'ended');
      const opened = await reopen(w.abe, first.id, '--message', 'why did you pick this helper?');

      expect(opened.doc.ok).toBe(true);
      await until(
        () => 'its first prompt',
        () =>
          argvOf(first.worktree).at(-1) === 'why did you pick this helper?' ? true : undefined,
      );
      await reaches(w.abe, first.id, 'waiting');
    },
  );

  test(
    'refused while a newer session of the card runs: stop it first; unknown ids say so',
    { timeout: 30_000 },
    async () => {
      const old = await launch(w.abe, w.repo, '6');

      await reaches(w.abe, old.id, 'waiting');
      await w.abe.run('session', 'stop', old.id);
      await reaches(w.abe, old.id, 'ended');
      const newer = await launch(w.abe, w.repo, '6');

      await reaches(w.abe, newer.id, 'waiting');
      expect((await reopen(w.abe, old.id)).doc).toEqual({
        ok: false,
        error: {
          code: 'card-has-session',
          message: `AB#6 has a running session ${newer.id}: stop it first`,
        },
      });
      expect((await reopen(w.abe, '6-ffff')).doc).toMatchObject({
        ok: false,
        error: { code: 'no-session' },
      });
      await w.abe.run('session', 'stop', newer.id);
    },
  );

  test(
    'reopened twice at once (⏎ twice): one claude goes on, the other is refused',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '11');

      await reaches(w.abe, first.id, 'waiting');
      await w.abe.run('session', 'stop', first.id);
      await reaches(w.abe, first.id, 'ended');
      const both = await Promise.all([reopen(w.abe, first.id), reopen(w.abe, first.id)]);

      expect(both.map((r) => r.doc.ok).sort()).toEqual([false, true]);
      expect(both.find((r) => !r.doc.ok)?.doc).toMatchObject({ error: { code: 'not-ended' } });
      await reaches(w.abe, first.id, 'waiting');
      expect((await show(w.abe, first.id)).reopened).toHaveLength(1);
      await w.abe.run('session', 'stop', first.id);
    },
  );

  test(
    'its worktree cleared, its branch there: made again at the same path and the conversation goes on',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '7');

      await reaches(w.abe, first.id, 'waiting');
      await w.abe.run('session', 'stop', first.id);
      await reaches(w.abe, first.id, 'ended');
      git(w.repo, 'worktree', 'remove', '--force', first.worktree);
      expect(existsSync(first.worktree)).toBe(false);

      expect((await reopen(w.abe, first.id)).doc).toMatchObject({
        ok: true,
        data: { worktree: first.worktree },
      });
      expect(await reopenedEvent(w.abe, first.id)).toMatchObject({ recreated: true });
      await reaches(w.abe, first.id, 'waiting');
      expect(argvOf(first.worktree)).toContain('--resume');
    },
  );

  test(
    'its worktree and branch gone: refused worktree-gone, the session left as it ended',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '8');

      await reaches(w.abe, first.id, 'waiting');
      await w.abe.run('session', 'stop', first.id);
      await reaches(w.abe, first.id, 'ended');
      git(w.repo, 'worktree', 'remove', '--force', first.worktree);
      git(w.repo, 'branch', '-D', first.branch);
      const before = await show(w.abe, first.id);

      expect((await reopen(w.abe, first.id)).doc).toEqual({
        ok: false,
        error: {
          code: 'worktree-gone',
          message: `its worktree and branch ${first.branch} are gone: Launch new agent… starts fresh`,
        },
      });
      // A reopen that did not start leaves its record as it was.
      expect(await show(w.abe, first.id)).toEqual(before);
    },
  );

  test(
    'its claude never ran a hook: refused no-conversation with the way on, the session left as it ended',
    { timeout: 30_000 },
    async () => {
      stuckClaude(w.abe.state.dir, 'Settings error: fix it and start again');
      const first = await launch(w.abe, w.repo, '10');

      await w.abe.run('session', 'stop', first.id);
      const ended = await reaches(w.abe, first.id, 'ended');

      expect(ended.transcriptPath).toBeNull();
      // said with the way on (#355): a plain session has no run to retry
      expect((await reopen(w.abe, first.id)).doc).toEqual({
        ok: false,
        error: {
          code: 'no-conversation',
          message: `session ${first.id} never started a conversation (its claude ran no hook): Launch new agent… starts fresh`,
        },
      });
      expect(await show(w.abe, first.id)).toEqual(ended);
      scriptClaude(w.abe.state.dir, [{ say: 'Built the sign-in form.' }]);
    },
  );

  test(
    'its claude gone with no SessionEnd: ended Crashed, and Reopen goes on',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '9');

      await reaches(w.abe, first.id, 'waiting');
      const killed = Bun.spawnSync([
        tmuxPath(),
        '-S',
        join(w.abe.state.dir, 'tmux.sock'),
        'kill-session',
        '-t',
        `=abe-${first.id}`,
      ]);

      expect(killed.exitCode).toBe(0);
      expect(await reaches(w.abe, first.id, 'ended')).toMatchObject({
        reason: CRASHED,
        stopped: false,
      });
      expect((await reopen(w.abe, first.id)).doc.ok).toBe(true);
      expect(await reaches(w.abe, first.id, 'waiting')).toMatchObject({ reason: null });
    },
  );

  test(
    'ended by its own SessionEnd (its socket still listened on): Reopen goes on, never stuck starting',
    { timeout: 30_000 },
    async () => {
      const first = await launch(w.abe, w.repo, '10');

      await reaches(w.abe, first.id, 'waiting');
      expect((await w.abe.run('session', 'send', first.id, '/exit')).exit).toBe(0);
      await reaches(w.abe, first.id, 'ended');
      expect((await reopen(w.abe, first.id)).doc).toMatchObject({ ok: true });
      expect(await reaches(w.abe, first.id, 'waiting')).toMatchObject({ reason: null });
      const listed = await w.abe.json(SessionListData, 'session', 'list');

      expect(listed.doc.ok && listed.doc.data.sessions.map((s) => s.id)).toContain(first.id);
    },
  );
});

const status = async (abe: ServedCli, card: string) => {
  const out = await abe.json(FactoryStatusData, 'factory', 'status', card);

  if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

  return out.doc.data.runs;
};

const factoryRan = (worktree: string) =>
  claudeOutput(worktree).abe.map((line) => {
    const r = z.object({ exit: z.number(), stdout: z.string() }).parse(line);
    const doc = z
      .object({ ok: z.boolean(), error: z.object({ code: z.string() }).optional() })
      .parse(JSON.parse(r.stdout));

    return doc.error?.code ?? 'ok';
  });

describe('Reopen a Factory run (#343)', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    scriptClaude(
      w.abe.state.dir,
      [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'needs-you', '--reason', 'which test account?', '--json'] },
        { say: 'Which test account?' },
      ],
      {
        [REOPENED_PROMPT]: [{ say: 'Going on in build.' }],
        'one more thing': [{ abe: ['factory', 'stage-done', 'build', '--json'] }],
      },
    );
  }, 30_000);
  afterAll(async () => {
    await done(w);
  });

  test(
    'a run not over (Stopped at Needs you): Reopen answers it and the run goes on at its stage',
    { timeout: 40_000 },
    async () => {
      const ran = await w.abe.json(FactoryRunData, 'factory', 'run', '4', '--repo', w.repo);

      if (!ran.doc.ok) throw new Error(JSON.stringify(ran.doc.error));
      const run = ran.doc.data;

      await until(
        () => 'needs you',
        async () => ((await status(w.abe, '4'))[0]?.state === 'needs-you' ? true : undefined),
      );
      await w.abe.run('session', 'stop', run.session);
      await reaches(w.abe, run.session, 'ended');

      expect((await reopen(w.abe, run.session)).doc.ok).toBe(true);
      await until(
        () => 'running in build again',
        async () => {
          const [now] = await status(w.abe, '4');

          return now?.state === 'running' && now.stage === 'build' && now.reason === null
            ? true
            : undefined;
        },
      );
      // The run says running from the reopen on; its claude starts a moment later.
      const argv = await until(
        () => 'claude started again',
        () => {
          const now = argvOf(run.worktree);

          return now.at(-1) === REOPENED_PROMPT ? now : undefined;
        },
      );

      expect(argv.at(-1)).toBe(REOPENED_PROMPT);
      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toStartWith(
        FACTORY_RUN_INSTRUCTIONS,
      );
      // The same run: one row in status, the same session.
      expect((await status(w.abe, '4')).map((r) => r.session)).toEqual([run.session]);
    },
  );

  test(
    'a run over (ended done): a plain conversation, and abe factory is refused run-over',
    { timeout: 40_000 },
    async () => {
      const [run] = await status(w.abe, '4');

      if (run === undefined) throw new Error('no run');
      expect(
        (await w.abe.run('factory', 'end', '4', '--as', 'done', '--reason', 'shipped by hand'))
          .exit,
      ).toBe(0);
      await reaches(w.abe, run.session, 'ended');
      const before = claudeOutput(run.worktree).abe.length;

      expect((await reopen(w.abe, run.session)).doc.ok).toBe(true);
      await reaches(w.abe, run.session, 'waiting');
      const argv = argvOf(run.worktree);

      expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain(RUN_OVER_INSTRUCTIONS);
      expect(argv.at(-2)).toBe('--append-system-prompt');
      await w.abe.run('session', 'send', run.session, 'one more thing');
      await until(
        () => 'the stage-done refused',
        () => (claudeOutput(run.worktree).abe.length > before ? true : undefined),
      );
      expect(factoryRan(run.worktree).at(-1)).toBe('run-over');
    },
  );
});

describe("Reopen reads a session's kind from what it is on (#213 D2)", () => {
  let w: World;

  /** A meta.json as serve wrote it before it kept `kind`: none in the file. */
  const oldMeta = (state: TempState, repo: string, id: string, on: Record<string, unknown>) => {
    const dir = join(state.dir, 'sessions', id);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        v: 1,
        id,
        card: null,
        title: 'Old',
        repo,
        worktree: join(repo, '..', id),
        branch: '',
        state: 'ended',
        since: '2026-10-24T10:00:00.000Z',
        startedAt: '2026-10-24T10:00:00.000Z',
        transcriptPath: null,
        lastAssistantMessage: null,
        claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
        socket: join(dir, 'session.sock'),
        ...on,
      }),
    );
  };

  beforeAll(async () => {
    // Written before serve starts: it reads them as it comes up.
    w = await world((state, repo) => {
      oldMeta(state, repo, 'retro-ab12', { retro: { retro: 'r1', scope: 'me', team: 'web' } });
      oldMeta(state, repo, '4-cd34', {
        card: 4,
        prototype: { id: 'proto-1a2b3c', card: 4 },
        kind: 'card',
      });
    });
  }, 30_000);
  afterAll(async () => {
    await done(w);
  });

  test('an old retro chat (a kind 3.3 has no more) is no session; a prototype session is refused as what it is', async () => {
    expect((await reopen(w.abe, 'retro-ab12')).doc).toEqual({
      ok: false,
      error: { code: 'no-session', message: 'no session retro-ab12' },
    });
    expect((await reopen(w.abe, '4-cd34')).doc).toEqual({
      ok: false,
      error: {
        code: 'not-reopenable',
        message:
          "session 4-cd34 is a card's prototype session: abe prototype start --card 4 opens it again, in the same worktree",
      },
    });
    expect(await show(w.abe, '4-cd34')).toMatchObject({ kind: 'prototype' });
  });
});
