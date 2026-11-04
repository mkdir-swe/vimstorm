/**
 * The fake `claude`, `fake-claude/claude.ts`, as an executable first on `PATH`. Also what it wrote
 * in a session's worktree: its environment, its argv, the hooks it ran, the `abe` commands it ran
 * and what was typed into it. `tmux` is the real one, found by `tmuxPath()`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const IMPL = join(import.meta.dir, 'fake-claude', 'claude.ts');

export type FakeClaude = {
  dir: string;
  /** `PATH` with the fake first and only the system's tools after it. */
  path: string;
  remove: () => void;
};

/**
 * A `claude` whose shebang is this Bun, so nothing on the session's `PATH` needs to find Bun.
 * `managed` is where it reads managed settings, such as a workspace's in a test's stand-in
 * container.
 */
export const fakeClaude = (o: { managed?: string } = {}): FakeClaude => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-'));

  writeFileSync(join(dir, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(IMPL)};\n`, {
    mode: 0o755,
  });
  if (o.managed !== undefined) writeFileSync(join(dir, 'managed-settings-path'), o.managed);

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type FakeStep =
  | { hook: string; payload?: Record<string, unknown> }
  | { abe: string[] }
  /** A file written in the folder it runs in. */
  | { write: { path: string; text: string } }
  | { say: string }
  | { sleep: number }
  /** Esc mid-turn: the turn stops with Claude Code's interrupt line, no hook. */
  | { interrupt: true }
  | { subagent: { type: string; task?: string; model?: string; result: string } };

/**
 * The fake's first turn, for every session started with this `HOME` from now on. `replies` holds
 * the turns a line typed into it starts, keyed by the exact line.
 */
export const scriptClaude = (
  home: string,
  steps: readonly FakeStep[],
  replies: Readonly<Record<string, readonly FakeStep[]>> = {},
): void => {
  writeFileSync(join(home, 'fake-claude.json'), JSON.stringify({ steps, replies }));
};

/**
 * Every session started with this `HOME` from now on shows `dialog` and never starts, so no hook
 * runs.
 */
export const stuckClaude = (home: string, dialog: string): void => {
  writeFileSync(join(home, 'fake-claude.json'), JSON.stringify({ steps: [], replies: {}, dialog }));
};

/**
 * What the fake answers as a one-shot, `claude -p`, for every call with this `HOME` from now on.
 * The n-th call gets `answers[n]`, and later calls get the last one again. Each exits `exit` after
 * `sleep` ms.
 */
export const scriptOneShot = (
  home: string,
  o: { answers: readonly string[]; exit?: number; sleep?: number },
): void => {
  writeFileSync(join(home, 'fake-claude-p.json'), JSON.stringify(o));
};

/** Each one-shot call the fake answered with this `HOME`, with its argv, env, cwd and prompt. */
export const oneShotCalls = (
  home: string,
): { argv: string[]; env: Record<string, string>; cwd: string; prompt: string }[] =>
  lines(join(home, 'fake-claude-p.jsonl')).map((l) => OneShotCall.parse(l));

const OneShotCall = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string(),
  prompt: z.string(),
});

const lines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l): unknown => JSON.parse(l))
    : [];

/** What the fake wrote in `worktree`, read now. */
export const claudeOutput = (worktree: string) => {
  const dir = join(worktree, '.fake-claude');
  const doc = (file: string): unknown =>
    existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : undefined;

  return {
    env: doc('env.json'),
    argv: doc('argv.json'),
    hooks: lines(join(dir, 'hooks.jsonl')),
    abe: lines(join(dir, 'abe.jsonl')),
    typed: lines(join(dir, 'typed.jsonl')),
    /** The keys pressed in its `/model` picker. */
    keys: lines(join(dir, 'keys.jsonl')),
    /** `{ asked: boolean }`, whether it showed the trust dialog. */
    trust: doc('trust.json'),
  };
};

/** The `tmux` tests run, from `$ABE_TMUX` or `PATH` or Homebrew's place. */
export const tmuxPath = (): string => {
  const found =
    process.env.ABE_TMUX ??
    Bun.which('tmux', { PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` });

  if (found === null) throw new Error('these tests need tmux (brew install tmux)');

  return found;
};

/** Ends the `tmux` server a test's `serve` started in `stateDir`, and so its sessions. */
export const killTmux = async (stateDir: string): Promise<void> => {
  const socket = join(stateDir, 'tmux.sock');

  if (!existsSync(socket)) return;
  await Bun.spawn([tmuxPath(), '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' })
    .exited;
};
