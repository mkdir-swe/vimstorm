/**
 * A repo's worktree recipe applied to a real git worktree of a fixture repo: env files linked, a
 * folder copied, one of an environment off skipped, a listed file the checkout lacks said, the
 * script run last as serve; its failure the run's Needs you. The install's check makes and
 * removes a throwaway worktree of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recipeCopies, setupReason, type WorktreeCopy } from '@abe/core';
import { prepareWorktree } from './worktree-setup';
import { localInstallRepo } from '../git/install-repo';

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

const write = (path: string, text: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
};

const SCRIPT = 'abe/scripts/worktree-setup';

describe("a new worktree made ready by the repo's recipe", () => {
  let root: string;
  let main: string;
  let n = 0;
  // the demo shop's recipe: its env files linked, its editor settings copied, prod's left out
  const copy = (): WorktreeCopy[] =>
    recipeCopies(
      {
        link: ['backend/.env', 'backend/.env.prod', 'frontend/.env.missing'],
        copy: ['.vscode'],
      },
      [
        { path: 'backend/.env', to: ['dev', 'test'] },
        { path: 'backend/.env.prod', to: ['prod'] },
      ],
      ['dev', 'test'],
    );
  const worktree = () => {
    const wt = join(root, `wt-${++n}`);

    git(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');

    return wt;
  };
  const prepare = (wt: string, run: string | null) =>
    prepareWorktree({
      checkout: main,
      worktree: wt,
      setup: null,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      copy: copy(),
      tracked: [],
      timeoutMs: 30_000,
      run,
      card: '1234',
    });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-recipe-')));
    main = join(root, 'shop');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    write(join(main, '.gitignore'), '.env*\n.vscode/\n');
    write(join(main, 'backend', 'index.js'), 'module.exports = 1;\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'shop');
    write(join(main, 'backend', '.env'), 'API_URL=http://localhost\n');
    write(join(main, 'backend', '.env.prod'), 'API_URL=https://shop.example\n');
    write(join(main, '.vscode', 'launch.json'), '{}\n');
    write(
      join(main, SCRIPT),
      '#!/bin/sh\necho "made from $MAIN_CHECKOUT for $CARD" > made.txt\necho set up\n',
      0o755,
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('links, copies, skips prod with why, says the missing one; the script runs last, in the worktree', async () => {
    const wt = worktree();
    const ran = await prepare(wt, SCRIPT);

    expect(lstatSync(join(wt, 'backend', '.env')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(wt, 'backend', '.env'), 'utf8')).toBe('API_URL=http://localhost\n');
    expect(lstatSync(join(wt, '.vscode', 'launch.json')).isFile()).toBe(true);
    expect(existsSync(join(wt, 'backend', '.env.prod'))).toBe(false);
    expect(readFileSync(join(wt, 'made.txt'), 'utf8')).toBe(`made from ${main} for 1234\n`);
    expect(ran).toMatchObject({
      how: 'none',
      copied: ['.vscode'],
      links: ['backend/.env'],
      skipped: { 'backend/.env.prod': 'feeds only prod, off for agents' },
      missing: ['frontend/.env.missing'],
      script: { run: SCRIPT, exit: 0, output: 'set up\n' },
    });
    expect(ran === null ? 'none' : setupReason(ran)).toBeNull();
  });

  test("a failing script: the run's reason, with its last lines and where it is fixed", async () => {
    write(join(main, 'abe/scripts/broken'), '#!/bin/sh\necho no token\nexit 3\n', 0o755);
    const ran = await prepare(worktree(), 'abe/scripts/broken');

    expect(ran?.script?.exit).toBe(3);
    expect(ran === null ? null : setupReason(ran)).toBe(
      "the repo's worktree script `abe/scripts/broken` failed (exit 3) in the new worktree:\nno token\nThe script and abe.yaml's worktree: are the repo's: fix them there, or ask the Abe chat.",
    );
  });

  test("the install's check: a throwaway worktree of HEAD, the recipe applied, nothing left behind", async () => {
    const before = git(main, 'worktree', 'list');
    const tried = await localInstallRepo({ env: { ...GIT_ENV, HOME: root } }).tryWorktree?.(main, {
      copy: copy(),
      run: SCRIPT,
    });

    expect(tried?.ok).toBe(true);
    if (tried?.ok !== true) return;
    expect(tried.data.absent).toEqual([]);
    expect(tried.data.ran).toMatchObject({
      links: ['backend/.env'],
      missing: ['frontend/.env.missing'],
      script: { exit: 0 },
    });
    expect(git(main, 'worktree', 'list')).toBe(before);
  });
});
