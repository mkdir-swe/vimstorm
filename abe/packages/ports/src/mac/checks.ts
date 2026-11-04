/**
 * What a Factory run's checks need from this machine (ticket #46): a check's command run in the
 * worktree and git's diff against the merge base for the built-in checks (`localRunTree`; a box's
 * are `containerRunTree`'s). IO only: what the output means is core's (`core/src/factory/checks.ts`).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  type BaseDiff,
  DEFAULT_BRANCH_REFS,
  type MadeCommit,
  type ShellRan,
} from '@abe/core';
import { type Env } from './locations';
import { gitEnv, runProcess } from './process';

/** The most of a command's output kept: its end, where failures are. */
const KEEP_BYTES = 256 * 1024;

/** The end of `text` within `KEEP_BYTES`, cut at a line so no character is split. */
export const keptTail = (text: string): string => {
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= KEEP_BYTES) return text;
  const cut = bytes.indexOf(10, bytes.length - KEEP_BYTES);

  return bytes.subarray(cut === -1 ? bytes.length - KEEP_BYTES : cut + 1).toString('utf8');
};

/**
 * `run` through `/bin/sh -c` in `cwd` with exactly `env`, stdout and stderr together, in a process
 * group of its own: killed whole when its time runs out, and anything it left running is killed
 * once it exits.
 */
export const runShell = (o: {
  run: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** What runs the shell (`sandbox-exec -p <profile>`); none: it runs as it is. */
  wrap?: readonly string[];
}): Promise<ShellRan> =>
  new Promise((resolve) => {
    const [bin, ...pre] = o.wrap ?? [];
    const child = spawn(
      bin ?? '/bin/sh',
      [...pre, ...(bin === undefined ? [] : ['/bin/sh']), '-c', `exec 2>&1\n${o.run}`],
      {
        cwd: o.cwd,
        env: o.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let kept = Buffer.alloc(0);
    let timedOut = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, o.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > KEEP_BYTES) {
        // Cut at a line, so no character is split.
        const cut = kept.indexOf(10, kept.length - KEEP_BYTES);

        kept = kept.subarray(cut === -1 ? kept.length - KEEP_BYTES : cut + 1);
      }
    });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const settle = (exit: number | null, said: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit, output: `${kept.toString('utf8')}${said}`, timedOut });
    };

    child.on('error', (err) => {
      killGroup();
      settle(127, `${err.message}\n`);
    });
    // Once it exits, what it left running goes too, so the pipe closes.
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      killGroup();
    });
    // Everything it printed has been read once the pipe is closed.
    child.stdout.on('close', () => {
      if (timedOut) settle(null, `\n[killed after ${Math.round(o.timeoutMs / 1000)}s]\n`);
      else if (exited !== undefined)
        settle(exited.code, exited.signal === null ? '' : `\n[killed by ${exited.signal}]\n`);
      else
        child.once('exit', (code, signal) => {
          settle(code, signal === null ? '' : `\n[killed by ${signal}]\n`);
        });
    });
  });

const git = (env: Env, cwd: string, ...args: string[]) =>
  runProcess(['git', '-C', cwd, ...args], { ...gitEnv(env), GIT_TERMINAL_PROMPT: '0' });

/** `git add -A` hashes every changed file: a large worktree takes a while. */
const DIFF_TIMEOUT_MS = 5 * 60_000;

const out = (r: { stdout: string }) => r.stdout.trim();

/**
 * What the run's branch is measured against: the default branch, as Before's worktree takes it
 * (`DEFAULT_BRANCH_REFS`: origin's `HEAD`, else `main` / `master`), by its short name.
 */
const baseOf = async (env: Env, worktree: string): Promise<string | undefined> => {
  for (const ref of DEFAULT_BRANCH_REFS) {
    const found = await git(
      env,
      worktree,
      'rev-parse',
      '--verify',
      '--quiet',
      '--symbolic-full-name',
      ref,
    );

    if (found.exit === 0 && out(found) !== '')
      return out(found).replace(/^refs\/(heads|remotes)\//, '');
  }

  return undefined;
};

/** `git log --format='%h %s'`'s lines as commits: the sha, then the subject. */
export const commitsOf = (text: string): MadeCommit[] =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const at = l.indexOf(' ');

      return at === -1
        ? { sha: l, subject: '' }
        : { sha: l.slice(0, at), subject: l.slice(at + 1) };
    });

/** The worktree's branch's commits since its merge base with the default branch, oldest first. */
export const baseCommits = async (env: Env, worktree: string): Promise<Answered<MadeCommit[]>> => {
  const base = await baseOf(env, worktree);

  if (base === undefined)
    return {
      ok: false,
      error: { code: 'no-base', message: `no default branch (${DEFAULT_BRANCH_REFS.join(', ')})` },
    };
  const mergeBase = await git(env, worktree, 'merge-base', 'HEAD', base);

  if (mergeBase.exit !== 0)
    return { ok: false, error: { code: 'no-base', message: `no merge base with ${base}` } };
  const log = await git(
    env,
    worktree,
    'log',
    '--reverse',
    '--no-color',
    '--format=%h %s',
    `${out(mergeBase)}..HEAD`,
  );

  return log.exit === 0
    ? { ok: true, data: commitsOf(log.stdout) }
    : { ok: false, error: { code: 'git-failed', message: log.stderr.trim() || 'git log failed' } };
};

/**
 * The worktree as it is now (committed or not, new files included, ignored ones not) against
 * its merge base: name-status and the patch, renames found. Read through a copy of the index, so
 * the worktree's own index is never touched.
 */
export const baseDiff = async (env: Env, worktree: string): Promise<BaseDiff> => {
  const base = await baseOf(env, worktree);

  if (base === undefined)
    return { ok: false, message: `no default branch (${DEFAULT_BRANCH_REFS.join(', ')})` };
  const mergeBase = await git(env, worktree, 'merge-base', 'HEAD', base);

  if (mergeBase.exit !== 0) return { ok: false, message: `no merge base with ${base}` };
  const indexPath = await git(
    env,
    worktree,
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  );
  const dir = mkdtempSync(join(tmpdir(), 'abe-checks-'));
  const index = join(dir, 'index');

  try {
    if (indexPath.exit === 0 && existsSync(out(indexPath))) copyFileSync(out(indexPath), index);
    const tempGit = (...args: string[]) =>
      runProcess(
        ['git', '-C', worktree, ...args],
        { ...gitEnv(env), GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' },
        undefined,
        DIFF_TIMEOUT_MS,
      );

    if (!existsSync(index)) await tempGit('read-tree', 'HEAD');
    const added = await tempGit('add', '-A');

    if (added.exit !== 0) return { ok: false, message: `git add: ${added.stderr.trim()}` };
    const at = out(mergeBase);
    const names = await tempGit('diff', '--cached', '-M', '--name-status', '-z', at);
    const patch = await tempGit(
      '-c',
      'core.quotePath=false',
      'diff',
      '--cached',
      '-M',
      '-U0',
      '--no-color',
      '--no-ext-diff',
      at,
    );

    if (names.exit !== 0 || patch.exit !== 0)
      return { ok: false, message: `git diff: ${(names.stderr || patch.stderr).trim()}` };

    return { ok: true, base, mergeBase: at, nameStatus: names.stdout, patch: patch.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
