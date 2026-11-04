import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempState } from '@abe/testing';
import { gitMirrors } from './mirrors';

const git = (cwd: string, ...args: string[]) => {
  const out = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin:/opt/homebrew/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

  if (out.exitCode !== 0) throw new Error(out.stderr.toString());

  return out.stdout.toString().trim();
};

/** A repo on disk standing in for GitHub, with a session Dockerfile. */
const origin = (dir: string) => {
  const src = join(dir, 'origin');

  mkdirSync(join(src, '.abe', 'session'), { recursive: true });
  writeFileSync(join(src, '.abe', 'session', 'Dockerfile'), 'FROM abe-base:latest\n');
  writeFileSync(join(src, 'package.json'), '{}\n');
  git(dir, 'init', '-q', '-b', 'main', src);
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'one');

  return src;
};

describe('git mirrors', () => {
  test('clone once, fetch after; the session tree, and a snapshot of the head', async () => {
    const state = tempState();
    const src = origin(state.dir);
    const mirrors = gitMirrors({
      dir: join(state.dir, 'box'),
      env: { PATH: process.env.PATH, HOME: state.dir, GH_TOKEN: 'never-used' },
      url: () => src,
    });
    const path = await mirrors.sync('mkdir-swe/demo-shop');

    expect(path).toBe(join(state.dir, 'box', 'repos', 'mkdir-swe', 'demo-shop.git'));
    // The box's other helpers dropped, then gh's: the person's login, never a stored token.
    expect(git(path, 'config', '--local', '--get-regexp', '^credential').split('\n')).toEqual([
      'credential.helper ',
      'credential.helper !gh auth git-credential',
    ]);
    const first = await mirrors.tree('mkdir-swe/demo-shop', '.abe/session');

    expect(first).toBe(git(src, 'rev-parse', 'HEAD:.abe/session'));
    expect(await mirrors.tree('mkdir-swe/demo-shop', 'no/such')).toBeUndefined();

    writeFileSync(join(src, '.abe', 'session', 'Dockerfile'), 'FROM abe-base:latest\nRUN true\n');
    git(src, 'commit', '-q', '-am', 'two');
    await mirrors.sync('mkdir-swe/demo-shop');
    const second = await mirrors.tree('mkdir-swe/demo-shop', '.abe/session');

    expect(second).not.toBe(first);
    const snap = await mirrors.snapshot('mkdir-swe/demo-shop');

    expect(readFileSync(join(snap, '.abe', 'session', 'Dockerfile'), 'utf8')).toContain('RUN true');
    expect(existsSync(join(snap, '.git'))).toBe(false);
    state.remove();
  });

  test("the box's checkout: the default branch's files in a worktree of the mirror, moved on with it", async () => {
    const state = tempState();
    const src = origin(state.dir);
    const repo = 'mkdir-swe/demo-shop';
    const mirrors = gitMirrors({
      dir: join(state.dir, 'box'),
      env: { PATH: process.env.PATH, HOME: state.dir },
      url: () => src,
    });

    writeFileSync(join(src, 'abe.yaml'), 'checks: [tests]\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'settings');
    await mirrors.sync(repo);
    const dir = await mirrors.checkout(repo);

    expect(dir).toBe(join(state.dir, 'box', 'checkouts', 'mkdir-swe', 'demo-shop'));
    expect(readFileSync(join(dir, 'abe.yaml'), 'utf8')).toBe('checks: [tests]\n');
    // A git checkout, so its repo Layer is read as one.
    expect(existsSync(join(dir, '.git'))).toBe(true);
    writeFileSync(join(src, 'abe.yaml'), 'checks: [lint]\n');
    git(src, 'commit', '-q', '-am', 'lint');
    writeFileSync(join(dir, 'abe.yaml'), 'changed here\n');
    await mirrors.sync(repo);

    expect(await mirrors.checkout(repo)).toBe(dir);
    expect(readFileSync(join(dir, 'abe.yaml'), 'utf8')).toBe('checks: [lint]\n');
    // Removed by hand: made again, its stale record dropped.
    rmSync(dir, { recursive: true, force: true });
    expect(await mirrors.checkout(repo)).toBe(dir);
    expect(readFileSync(join(dir, 'abe.yaml'), 'utf8')).toBe('checks: [lint]\n');
    state.remove();
  });

  test('a clone that fails leaves no mirror behind', async () => {
    const state = tempState();
    const mirrors = gitMirrors({
      dir: join(state.dir, 'box'),
      env: { PATH: process.env.PATH, HOME: state.dir },
      url: () => join(state.dir, 'nothing-here'),
    });

    expect(mirrors.sync('a/b')).rejects.toThrow('git clone failed');
    await Bun.sleep(0);
    expect(existsSync(join(state.dir, 'box', 'repos', 'a', 'b.git'))).toBe(false);
    state.remove();
  });
});
