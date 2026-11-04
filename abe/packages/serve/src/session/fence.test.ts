/**
 * A local session's fence (#181) in a real `serve`: the fake `claude` in a real `tmux` runs its
 * PreToolUse hooks through the real `abe hook`, in auto mode. A file tool writing outside the
 * worktree and a WebFetch to a host the session does not reach are denied with serve's reason;
 * a write in the worktree and a fetch from GitHub are left to Claude Code; a `network <host>`
 * Override lets that host's WebFetch through from then on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cardBranch,
  FENCE_ENV,
  type Reply,
  SessionData,
  type SessionRunner,
  worktreePath,
} from '@abe/core';
import { sessionSocket } from '@abe/ports';
import {
  card,
  claudeOutput,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  scenario,
  scriptClaude,
  type ServeScenario,
  tempState,
  until,
} from '@abe/testing';
import { z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};
const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

/** The repo's `abe.yaml` with its board, and yours for it (empty). */
const repoSettings = (repo: string) => {
  mkdirSync(join(repo, '.abe'));
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(BOARD)}\nenvironments: {}\n`);
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
};

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const read = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .safeParse(JSON.parse(reply.stdout));

  if (!read.success) throw new Error(reply.stdout);

  return schema.parse(read.data.data);
};

const Hooks = z.array(z.object({ event: z.string(), stdout: z.string() }));

/** What each PreToolUse hook printed for Claude Code, in order: a deny's reason, or null. */
const preToolAnswers = (worktree: string): (string | null)[] =>
  Hooks.parse(claudeOutput(worktree).hooks)
    .filter((h) => h.event === 'PreToolUse')
    .map((h) =>
      h.stdout.trim() === ''
        ? null
        : z
            .object({
              hookSpecificOutput: z.object({
                hookEventName: z.literal('PreToolUse'),
                permissionDecision: z.literal('deny'),
                permissionDecisionReason: z.string(),
              }),
            })
            .parse(JSON.parse(h.stdout)).hookSpecificOutput.permissionDecisionReason,
    );

const pre = (tool: string, input: Record<string, unknown>) => ({
  hook: 'PreToolUse',
  payload: { tool_name: tool, tool_input: input, permission_mode: 'auto' },
});

describe("a local session's fence, through the real hook (#181)", () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let s: ServeScenario;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-')));
    repo = join(root, 'demo');
    for (const dir of ['mine', 'Desktop']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '-b', 'main', repo);
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    repoSettings(repo);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    claude = fakeClaude();
    s = await scenario({
      board: fakeBoard([2].map((id) => card(id, `Cart total ${id}`))),
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
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'outside writes are denied in auto mode; any host is reached (ADR 0029), no network Override to ask',
    { timeout: 40_000 },
    async () => {
      const desktop = join(root, 'Desktop', 'probe.txt');
      // Its card's Before worktree (#182), and a file in the worktree hard linked to one outside.
      const before = `${worktreePath(repo, cardBranch('2', 'Cart total 2'))}-base`;
      const outside = join(root, 'Desktop', 'zshrc');

      writeFileSync(outside, 'x');
      scriptClaude(
        s.state.dir,
        [
          pre('Write', { file_path: 'src/cart.ts', content: 'x' }),
          pre('Write', { file_path: desktop, content: 'x' }),
          pre('Edit', { file_path: join(repo, 'README.md'), old_string: '#', new_string: '##' }),
          pre('WebFetch', { url: 'https://github.com/octo/shop', prompt: 'read' }),
          pre('WebFetch', { url: 'https://example.com/', prompt: 'read' }),
          pre('WebFetch', { url: 'https://docs.vendor.io/api', prompt: 'read' }),
          pre('Write', { file_path: join(before, 'src', 'cart.ts'), content: 'x' }),
        ],
        {
          'go on': [
            pre('WebFetch', { url: 'https://docs.vendor.io/api', prompt: 'read' }),
            pre('Edit', { file_path: 'rc', old_string: 'x', new_string: 'y' }),
            pre('Skill', { skill: 'web:deploy' }),
          ],
        },
      );
      const session = data(
        SessionData,
        await s.request('session', 'launch', '--card', '2', '--repo', repo, '--json'),
      );
      const first = await until('the first turn', () => {
        const answers = preToolAnswers(session.worktree);

        return answers.length >= 7 ? answers : undefined;
      });
      const worktree = realpathSync(session.worktree);

      linkSync(outside, join(worktree, 'rc'));
      // A skill in a folder of the worktree (moved in past the sandbox): its hooks would run outside.
      mkdirSync(join(worktree, 'web', '.claude', 'skills', 'deploy'), { recursive: true });

      expect(first).toEqual([
        null,
        `Write refused: outside this session's worktree (${worktree}), the only place its tools write: ${desktop}. Write inside the worktree, or tell the person what to change there.`,
        `Edit refused: outside this session's worktree (${worktree}), the only place its tools write: ${join(repo, 'README.md')}. Write inside the worktree, or tell the person what to change there.`,
        null,
        // the network is open (ADR 0029): no host is refused, GitHub's or another's
        null,
        null,
        null,
      ]);
      await until('waiting', async () =>
        data(SessionData, await s.request('session', 'show', session.id, '--json')).state ===
        'waiting'
          ? true
          : undefined,
      );
      const overridden = await s.request(
        'session',
        'override',
        session.id,
        '--what',
        'network docs.vendor.io',
        '--reason',
        'the vendor API docs',
        '--json',
      );

      // Nothing was shut, so there is nothing to open: said so, nothing recorded.
      expect(JSON.parse(overridden.stdout)).toMatchObject({
        ok: false,
        error: { code: 'not-an-area' },
      });
      expect(overridden.stdout).toContain(
        "network docs.vendor.io: a session's network is open (ADR 0029)",
      );
      expect((await s.request('session', 'send', session.id, 'go on', '--json')).exit).toBe(0);
      const after = await until('the next turn', () => {
        const answers = preToolAnswers(session.worktree);

        return answers.length >= 10 ? answers : undefined;
      });

      expect(after[7]).toBeNull();
      expect(after[8]).toBe(
        `Edit refused: ${join(worktree, 'rc')} is a hard link (2 names), so the write would land outside this session's worktree too. Write a new file instead.`,
      );
      expect(after[9]).toBe(
        `Skill refused: web:deploy is a skill in ${join(worktree, 'web', '.claude', 'skills', 'deploy')}, inside this session's worktree, where its hooks would run outside the sandbox. Tell the person about it instead.`,
      );
    },
  );
});

describe("a local session's fence while it starts: serve answers its hook before the launch returns (#181)", () => {
  test('a Write outside, heard while the launch is still under way: denied, never let through', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-fence-start-')));
    const repo = join(root, 'demo');
    const state = tempState();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launching: string | undefined;
    let fenceMark: string | undefined;
    const runner: SessionRunner = {
      abe: 'abe',
      bin: join(root, 'bin'),
      plugins: join(root, 'plugins'),
      socket: (id) => ({
        listen: sessionSocket(state.dir, id),
        session: sessionSocket(state.dir, id),
        mode: 0o600,
      }),
      launch: async (spec) => {
        launching = spec.id;
        fenceMark = spec.env[FENCE_ENV];
        await gate;

        return { ok: true, data: { worktree: repo, setup: null, trusted: false } };
      },
      baseWorktree: () => Promise.resolve({ ok: false, error: { code: 'no', message: 'no' } }),
      send: () => Promise.resolve({ ok: true, data: null }),
      keys: () => Promise.resolve({ ok: true, data: null }),
      screen: () => Promise.resolve({ ok: true, data: '' }),
      attach: () => [],
      stop: () => Promise.resolve({ ok: true, data: null }),
      running: () => Promise.resolve({ ok: true, data: [] }),
    };

    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '-b', 'main', repo);
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    repoSettings(repo);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    await using s = await scenario({
      state,
      board: fakeBoard([card(2, 'Cart total 2')]),
      sessions: {
        runner,
        env: { ...GIT_ENV, ABE_CONFIG_DIR: join(root, 'mine') },
      },
    });

    try {
      const launched = s.request('session', 'launch', '--card', '2', '--repo', repo, '--json');
      const id = await until('the launch under way', () => launching);
      const write = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'Desktop', 'x.txt'), content: 'x' },
        cwd: repo,
        permission_mode: 'auto',
      });
      const heard = await s.requestAs(id, repo, 'hook', 'PreToolUse', '--payload', write, '--json');

      expect(JSON.parse(heard.stdout)).toMatchObject({
        ok: true,
        data: { answer: { hookSpecificOutput: { permissionDecision: 'deny' } } },
      });
      release();
      expect((await launched).exit).toBe(0);
      // Its claude runs with the mark: the hook refuses a fenced tool serve does not answer.
      expect(fenceMark).toBe('1');
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
