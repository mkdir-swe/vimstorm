/** The checks' IO on real temporary git repos: the diff against the merge base, the exclude, a command. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, parseNameStatus } from '@abe/core';
import { baseDiff, runShell } from './checks';

const env = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  // A parent git's would point git elsewhere: the port drops it.
  GIT_DIR: '/nowhere',
};

const root = mkdtempSync(join(tmpdir(), 'abe-checks-port-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const rest = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'GIT_DIR'));
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...rest, HOME: root } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const write = (dir: string, path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};

/** A main checkout with tests, and a worktree on a card branch from it. */
const repoWithWorktree = (name: string) => {
  const repo = join(root, name);

  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/cart.ts', 'export const cart = 1;\n');
  write(repo, 'src/cart.test.ts', "test('cart', () => {});\n");
  write(repo, 'tests/old.ts', 'old\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const worktree = join(root, `${name}-wt`);

  git(repo, 'worktree', 'add', '-q', '-b', 'card/4-x', worktree, 'HEAD');

  return { repo, worktree };
};

describe('the diff against the merge base', () => {
  test('committed, staged and untracked changes; renames found; ignored files left out', async () => {
    const { repo, worktree } = repoWithWorktree('diff');

    // main moves on after the branch: none of it is the branch's change.
    write(repo, 'src/later.ts', '// @ts-ignore on main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'later');
    git(worktree, 'rm', '-q', 'src/cart.test.ts');
    git(worktree, 'commit', '-q', '-m', 'drop a test');
    git(worktree, 'mv', 'tests/old.ts', 'src/old.ts');
    write(worktree, 'src/cart.ts', 'export const cart = 1;\n// @ts-expect-error staged\n');
    git(worktree, 'add', 'src/cart.ts');
    write(worktree, 'src/new.ts', "describe.only('new', () => {});\n");
    write(worktree, '.gitignore', 'dist/\n');
    write(worktree, 'dist/out.js', '// eslint-disable\n');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.scratch/\n');
    write(worktree, '.scratch/4/checks.md', '// biome-ignore\n');
    const before = git(worktree, 'status', '--porcelain');

    const diff = await baseDiff(env, worktree);

    if (!diff.ok) throw new Error(diff.message);
    expect(diff.base).toBe('main');
    expect(diff.mergeBase).toBe(git(repo, 'rev-parse', 'HEAD~1'));
    expect(parseNameStatus(diff.nameStatus)).toEqual([
      { status: 'A', path: '.gitignore', to: null },
      { status: 'D', path: 'src/cart.test.ts', to: null },
      { status: 'M', path: 'src/cart.ts', to: null },
      { status: 'A', path: 'src/new.ts', to: null },
      { status: 'R', path: 'tests/old.ts', to: 'src/old.ts' },
    ]);
    expect(addedLines(diff.patch).map((l) => `${l.file}:${l.line} ${l.text}`)).toEqual([
      '.gitignore:1 dist/',
      'src/cart.ts:2 // @ts-expect-error staged',
      "src/new.ts:1 describe.only('new', () => {});",
    ]);
    // The worktree's own index is as it was.
    expect(git(worktree, 'status', '--porcelain')).toBe(before);
  });

  test('no default branch: no diff', async () => {
    const { repo, worktree } = repoWithWorktree('nodefault');

    git(repo, 'branch', '-q', '-m', 'main', 'trunk');

    expect(await baseDiff(env, worktree)).toEqual({
      ok: false,
      message:
        'no default branch (refs/remotes/origin/HEAD, refs/heads/main, refs/heads/master, refs/remotes/origin/main, refs/remotes/origin/master)',
    });
  });
});

describe('a check’s command', () => {
  const cwd = mkdtempSync(join(root, 'sh-'));

  test('stdout and stderr together, its exit, exactly its environment', async () => {
    expect(
      await runShell({
        run: 'echo out; echo err >&2; echo "$HOME $SECRET"; exit 3',
        cwd,
        env: { PATH: '/usr/bin:/bin', HOME: '/h' },
        timeoutMs: 10_000,
      }),
    ).toEqual({ exit: 3, output: 'out\nerr\n/h \n', timedOut: false });
  });

  test('killed when its time runs out, with what it left running', async () => {
    const started = Date.now();
    const ran = await runShell({
      run: 'echo begun; sleep 30 & sleep 30',
      cwd,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 300,
    });

    expect(ran).toEqual({ exit: null, output: 'begun\n\n[killed after 0s]\n', timedOut: true });
    // Far under the 30 s its sleeps would take: killed, not waited for.
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});
