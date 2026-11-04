/** The local prototype apps port on a real repository: what a start says when it cannot start. */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPrototypeApps } from './prototype-apps';

const ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};
const root = mkdtempSync(join(tmpdir(), 'abe-proto-apps-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(['git', '-C', cwd, ...args], { env: ENV })
    .stdout.toString()
    .trim();

test('a repo with no start script: what to add, never a temp path or jargon (#288)', async () => {
  const repo = join(root, 'repo');

  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo], { env: ENV });
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const apps = localPrototypeApps({ dir: join(root, 'prototypes'), env: ENV });
  const started = await apps.start({ id: 'p1', repo, commit, env: {} });

  expect(started).toEqual({
    ok: false,
    error: {
      code: 'prototype-start-failed',
      message: `The repo has no abe/scripts/prototype-start (nor .claude/skills/run-app/scripts/start) at ${commit.slice(0, 7)}: add one that starts the app (the install's Prototype part writes it)`,
    },
  });
});

test("the checkout's run-app scripts not committed yet (the install's change) are copied in before the start script is looked for", async () => {
  const repo = join(root, 'excluded');

  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo], { env: ENV });
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  mkdirSync(join(repo, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, '.claude', 'skills', 'run-app', 'scripts', 'start'),
    '#!/bin/sh\necho started here\n',
    {
      mode: 0o755,
    },
  );
  const commit = git(repo, 'rev-parse', 'HEAD');
  const apps = localPrototypeApps({ dir: join(root, 'prototypes'), env: ENV });

  const status = '?? .claude/skills/run-app/scripts/start';

  // the checkout has it, the commit does not
  expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(status);
  // copied only into a folder there: the commit has no .claude/, so all of it
  const started = await apps.start({
    id: 'p2',
    repo,
    commit,
    env: {},
    copy: [{ path: '.claude' }],
  });

  expect(started.ok ? started.data.ran.stdout : started.error.message).toBe('started here\n');
  expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(status);
  await apps.stop({ id: 'p2', repo });
  expect(existsSync(join(root, 'prototypes', 'p2', 'app'))).toBe(false);
});

test('a folder of its own (a developer prototype) gets them too; its own there is kept', async () => {
  const repo = join(root, 'excluded');
  const own = join(root, 'own');

  git(repo, 'worktree', 'add', '-q', '--detach', own, 'HEAD');
  const RUN_APP = '.claude/skills/run-app';

  mkdirSync(join(own, RUN_APP), { recursive: true });
  writeFileSync(join(own, RUN_APP, 'SKILL.md'), 'mine\n');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const apps = localPrototypeApps({ dir: join(root, 'prototypes'), env: ENV });
  const started = await apps.start({
    id: 'p3',
    repo,
    commit,
    env: {},
    dir: own,
    copy: [{ path: RUN_APP }],
  });

  // its own run-app there already: copied only when absent, so the start script is still missing
  expect(started.ok ? '' : started.error.message).toBe(
    `The repo has no abe/scripts/prototype-start (nor .claude/skills/run-app/scripts/start) at ${commit.slice(0, 7)}: add one that starts the app (the install's Prototype part writes it)`,
  );
  rmSync(join(own, RUN_APP), { recursive: true, force: true });
  const again = await apps.start({
    id: 'p3',
    repo,
    commit,
    env: {},
    dir: own,
    copy: [{ path: RUN_APP }],
  });

  expect(again.ok ? again.data.ran.stdout : again.error.message).toBe('started here\n');
  await apps.stop({ id: 'p3', repo });
  expect(existsSync(join(own, '.claude', 'skills', 'run-app', 'scripts', 'start'))).toBe(true);
});

test("abe/scripts/prototype-start, the install's change not committed yet, is the start over the pack's; the pack's stop is not run after it", async () => {
  const repo = join(root, 'excluded');
  const marks = join(root, 'marks');
  const commit = git(repo, 'rev-parse', 'HEAD');

  mkdirSync(join(repo, 'abe', 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, 'abe', 'scripts', 'prototype-start'),
    '#!/bin/sh\necho "prototype on $ABE_PORT_BASE with $SHOP_KEY"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(repo, '.claude', 'skills', 'run-app', 'scripts', 'stop'),
    `#!/bin/sh\necho pack-stop >>"${marks}"\n`,
    { mode: 0o755 },
  );
  const apps = localPrototypeApps({ dir: join(root, 'prototypes'), env: ENV });
  const started = await apps.start({
    id: 'p4',
    repo,
    commit,
    env: { ABE_PORT_BASE: '41200', SHOP_KEY: 'k' },
    copy: [{ path: '.claude' }, { path: 'abe/scripts', over: true }],
  });

  expect(
    started.ok ? [started.data.script, started.data.ran.stdout] : started.error.message,
  ).toEqual(['abe/scripts/prototype-start', 'prototype on 41200 with k\n']);
  expect(apps.log?.('p4')).toBe(join(root, 'prototypes', 'p4', 'start.out'));
  await apps.stop({ id: 'p4', repo });
  expect(existsSync(marks)).toBe(false);
  rmSync(join(repo, 'abe'), { recursive: true, force: true });
  rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'stop'), { force: true });
});

test("stop signals the kept start group only while it is still the start's: a reused number is left alone", async () => {
  const dir = join(root, 'kept');
  const apps = localPrototypeApps({ dir, env: ENV });
  const group = () => Bun.spawn(['/bin/sleep', '30'], { detached: true });
  const lstart = (pid: number) =>
    Bun.spawnSync(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
      .stdout.toString()
      .trim();
  const stopWith = async (id: string, pgid: number, since: string) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'start.pgid'), `${String(pgid)}\n${since}\n`);
    await apps.stop({ id, repo: root });
  };
  // its number taken by a group whose leader started at another time than the start's
  const someoneElse = group();
  const ours = group();

  await stopWith('p2', someoneElse.pid, 'Thu Jan  1 00:00:00 1970');
  await stopWith('p3', ours.pid, lstart(ours.pid));
  expect(await ours.exited).not.toBe(0);
  expect(() => process.kill(someoneElse.pid, 0)).not.toThrow();
  someoneElse.kill('SIGKILL');
});
