/**
 * The worktree git port on real repositories: a bare remote standing in for GitHub (origin's URL
 * is GitHub's, rewritten to the bare one by `insteadOf`), a checkout and a worktree beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_DROPPED } from '../github/gh';
import { cardGit, workspaceGit } from './git';
import { type ContainerExec } from '../docker/workspace-runner';

const ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

describe('a worktree through git', () => {
  let root: string;
  let remote: string;
  let repo: string;
  const port = () => cardGit({ env: { ...ENV, HOME: root } });
  const worktree = (name: string) => {
    const path = join(root, `demo-wt-${name}`);

    git(repo, 'worktree', 'add', '-q', '-b', `card/${name}`, path, 'HEAD');

    return path;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-git-'));
    remote = join(root, 'remote.git');
    repo = join(root, 'demo');
    git(root, 'init', '-q', '--bare', '-b', 'trunk', remote);
    git(root, 'init', '-q', '-b', 'trunk', repo);
    writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    git(repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/acme/demo.git');
    git(repo, 'push', '-q', 'origin', 'trunk');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("origin: GitHub's URL as written, and the remote's default branch", async () => {
    const wt = worktree('1-origin');

    expect(await port().origin(wt)).toEqual({
      ok: true,
      data: { url: 'https://github.com/acme/demo.git', defaultBranch: 'trunk' },
    });
  });

  test("onOrigin and startAt: the card branch starts from a teammate's head on origin, never over work", async () => {
    const theirs = worktree('3-theirs');

    writeFileSync(join(theirs, 'theirs.txt'), 'theirs\n');
    git(theirs, 'add', '.');
    git(theirs, 'commit', '-q', '-m', 'theirs');
    git(theirs, 'push', '-q', 'origin', 'card/3-theirs:feature/theirs');
    const head = git(theirs, 'rev-parse', 'HEAD');
    const wt = worktree('3-fixes');

    expect(await port().onOrigin(wt, 'feature/theirs')).toEqual({ ok: true, data: true });
    expect(await port().onOrigin(wt, 'feature/gone')).toEqual({ ok: true, data: false });
    expect(await port().startAt(wt, { from: 'feature/theirs', base: 'trunk' })).toEqual({
      ok: true,
      data: { moved: true },
    });
    expect([git(wt, 'rev-parse', 'HEAD'), git(wt, 'branch', '--show-current')]).toEqual([
      head,
      'card/3-fixes',
    ]);
    // built on it since: as it is
    writeFileSync(join(wt, 'fix.txt'), 'fix\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'fix');
    expect(await port().startAt(wt, { from: 'feature/theirs', base: 'trunk' })).toEqual({
      ok: true,
      data: { moved: false },
    });
    // their branch on origin is never written
    expect(git(remote, 'rev-parse', 'feature/theirs')).toBe(head);
    const own = worktree('3-own');

    writeFileSync(join(own, 'own.txt'), 'own\n');
    git(own, 'add', '.');
    git(own, 'commit', '-q', '-m', 'own');
    const kept = git(own, 'rev-parse', 'HEAD');

    expect(await port().startAt(own, { from: 'feature/theirs', base: 'trunk' })).toMatchObject({
      ok: false,
      error: { code: 'own-work' },
    });
    const dirty = worktree('3-dirty');

    writeFileSync(join(dirty, 'README.md'), '# changed\n');
    expect(await port().startAt(dirty, { from: 'feature/theirs', base: 'trunk' })).toMatchObject({
      ok: false,
      error: { code: 'own-work' },
    });
    expect(git(own, 'rev-parse', 'HEAD')).toBe(kept);
  });

  test('push: the branch on the remote, its upstream set; then no unpushed commits', async () => {
    const wt = worktree('2-push');

    writeFileSync(join(wt, 'a.txt'), 'a\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'a');
    expect(await port().work(wt)).toMatchObject({
      ok: true,
      data: { uncommitted: 0, unpushed: 1 },
    });
    expect(await port().push(wt, 'card/2-push')).toEqual({ ok: true, data: null });
    expect(git(remote, 'rev-parse', 'card/2-push')).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(git(wt, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/card/2-push');
    expect(await port().work(wt)).toEqual({
      ok: true,
      data: { uncommitted: 0, unpushed: 0, head: git(wt, 'rev-parse', 'HEAD') },
    });
  });

  test("push: a pre-push hook slower than the timeout stops it, and the answer says it's the hook", async () => {
    const wt = worktree('2-slow-hook');
    const hooks = join(root, 'slow-hooks');

    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', hooks);
    try {
      const pushed = await port().push(wt, 'card/2-slow-hook', 300);

      expect(pushed).toMatchObject({ ok: false, error: { code: 'push-timeout' } });
      expect(pushed.ok ? '' : pushed.error.message).toContain('pre-push hook');
      expect(pushed.ok ? '' : pushed.error.message).toContain('pr.pushTimeout');
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath');
    }
  });

  test('work: changed and untracked files count, ignored ones do not', async () => {
    const wt = worktree('3-work');

    writeFileSync(join(wt, 'README.md'), '# changed\n');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    mkdirSync(join(wt, '.scratch'));
    writeFileSync(join(wt, '.scratch', 'report.md'), 'evidence\n');
    expect(await port().work(wt)).toMatchObject({
      ok: true,
      data: { uncommitted: 2, unpushed: 0 },
    });
  });

  test("work: a nested repo's own config runs nothing in serve's git (#181: written past the sandbox)", async () => {
    const wt = worktree('6-nested');
    const sub = join(wt, 'vendor');
    const mark = join(root, 'fsmonitor-ran');
    const monitor = join(root, 'fsmonitor.sh');

    writeFileSync(monitor, `#!/bin/sh\ntouch '${mark}'\n`, { mode: 0o755 });
    git(wt, 'init', '-q', '-b', 'main', 'vendor');
    writeFileSync(join(sub, 'lib.txt'), 'lib\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 'lib');
    // What a session's shell can write: the nested repo's config (no .git of the checkout's).
    git(sub, 'config', 'core.fsmonitor', monitor);
    git(wt, 'add', 'vendor');
    expect(await port().work(wt)).toMatchObject({ ok: true });
    expect(existsSync(mark)).toBe(false);
  });

  test('remove: a clean worktree goes, its branch stays; one with changes is refused', async () => {
    const clean = worktree('4-clean');
    const dirty = worktree('5-dirty');

    mkdirSync(join(clean, '.scratch'));
    writeFileSync(join(clean, '.scratch', 'shot.txt'), 'evidence\n');
    writeFileSync(join(dirty, 'README.md'), '# changed\n');
    expect(await port().remove(clean)).toEqual({ ok: true, data: null });
    expect(existsSync(clean)).toBe(false);
    expect(git(repo, 'branch', '--list', 'card/4-clean')).toContain('card/4-clean');
    expect(await port().work(clean)).toEqual({ ok: true, data: null });
    const refused = await port().remove(dirty);

    expect(refused.ok ? 'removed' : refused.error.code).toBe('git-failed');
    expect(existsSync(join(dirty, 'README.md'))).toBe(true);
  });

  test("tidyWriters: a writer's worktree record and branch go once the card branch holds its work (#183)", async () => {
    const card = worktree('tidy');
    const writer = (id: string) => {
      const path = join(card, '.claude', 'worktrees', `agent-${id}`);

      git(card, 'worktree', 'add', '-q', '-b', `worktree-agent-${id}`, path, 'HEAD');
      writeFileSync(join(path, `${id}.txt`), `${id}\n`);
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', id);

      return path;
    };
    // a1: merged, its folder removed in the sandbox (prunable). a2: merged, folder still there.
    // a3: not merged. a4: merged, its record gone already, only its branch left.
    const a1 = writer('a1');
    const a2 = writer('a2');

    writer('a3');
    writer('a4');
    for (const id of ['a1', 'a2', 'a4'])
      git(card, 'merge', '-q', '--no-ff', '-m', `merge ${id}`, `worktree-agent-${id}`);
    rmSync(a1, { recursive: true, force: true });
    git(card, 'worktree', 'remove', '--force', join(card, '.claude', 'worktrees', 'agent-a4'));
    // Another card's writer, merged nowhere near this one: never touched.
    const other = worktree('other');

    git(other, 'branch', 'worktree-agent-b1');

    // The agent's own Before worktree there, at the merge base: no writer's, never touched.
    const before = join(card, '.claude', 'worktrees', 'verify-before-102');

    git(card, 'worktree', 'add', '-q', '--detach', before, 'trunk');
    const tidy = () =>
      port().tidyWriters({ worktree: card, repo, branch: 'card/tidy', agents: ['a4'] });
    const tidied = await tidy();

    expect(tidied).toEqual({
      ok: true,
      data: {
        removed: [join(realpathSync(card), '.claude', 'worktrees', 'agent-a2')],
        deleted: ['worktree-agent-a1', 'worktree-agent-a2', 'worktree-agent-a4'],
      },
    });
    expect(existsSync(a2)).toBe(false);
    const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n');

    expect(branches.filter((b) => b.startsWith('worktree-agent-')).sort()).toEqual([
      'worktree-agent-a3',
      'worktree-agent-b1',
    ]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
    expect(existsSync(before)).toBe(true);
    // Nothing left to do: a second time does nothing.
    expect(await tidy()).toEqual({ ok: true, data: { removed: [], deleted: [] } });
    expect(existsSync(before)).toBe(true);
  });

  test("tidyWriters: a writer's folder gone before the card branch holds its work keeps its record and branch until it does; other stale records are pruned", async () => {
    const card = worktree('pruned');
    const path = join(card, '.claude', 'worktrees', 'agent-p1');

    git(card, 'worktree', 'add', '-q', '-b', 'worktree-agent-p1', path, 'HEAD');
    writeFileSync(join(path, 'p1.txt'), 'p1\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'p1');
    // removed in the sandbox before its merge, its id unknown to the session (no hooks of it)
    rmSync(path, { recursive: true, force: true });
    // another session's writer in the main checkout, its folder gone too: never pruned
    const theirs = join(repo, '.claude', 'worktrees', 'agent-p9');

    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-p9', theirs, 'HEAD');
    rmSync(theirs, { recursive: true, force: true });
    // a worktree that is no writer, removed by hand: its stale record goes; a locked one stays
    const stale = worktree('pruned-stale');
    const locked = worktree('pruned-locked');

    git(repo, 'worktree', 'lock', locked);
    for (const p of [stale, locked]) rmSync(p, { recursive: true, force: true });
    const tidy = () =>
      port().tidyWriters({ worktree: card, repo, branch: 'card/pruned', agents: [] });
    const listed = () => git(repo, 'worktree', 'list', '--porcelain');

    expect(await tidy()).toEqual({ ok: true, data: { removed: [], deleted: [] } });
    expect(git(repo, 'branch', '--list', 'worktree-agent-p1')).toContain('worktree-agent-p1');
    expect(
      ['agent-p1', 'agent-p9', 'demo-wt-pruned-stale\n', 'demo-wt-pruned-locked\n'].map((p) =>
        listed().includes(p),
      ),
    ).toEqual([true, true, false, true]);
    expect(git(repo, 'branch', '--list', 'card/pruned-stale')).toContain('card/pruned-stale');
    git(repo, 'worktree', 'unlock', locked);
    git(card, 'merge', '-q', '--no-ff', '-m', 'merge p1', 'worktree-agent-p1');
    expect(await tidy()).toEqual({
      ok: true,
      data: { removed: [], deleted: ['worktree-agent-p1'] },
    });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('agent-p1');
  });

  test("tidyWriters: a writer in the main checkout's .claude/worktrees, where Claude Code puts it (#218)", async () => {
    const card = worktree('main-writers');
    // Claude Code makes a writer's worktree in the main checkout, branched from the card branch.
    const writer = (id: string, commit: boolean) => {
      const path = join(repo, '.claude', 'worktrees', `agent-${id}`);

      git(card, 'worktree', 'add', '-q', '-b', `worktree-agent-${id}`, path, 'card/main-writers');
      if (commit) {
        writeFileSync(join(path, `${id}.txt`), `${id}\n`);
        git(path, 'add', '.');
        git(path, 'commit', '-q', '-m', id);
      }

      return path;
    };
    const m1 = writer('m1', true);
    // m3: merged, then the agent's own `git worktree remove` in the sandbox deleted what it
    // could and was refused the rest (its `.git`, a read-only CLAUDE.md): only deletions left.
    const m3 = writer('m3', true);

    rmSync(join(m3, 'm3.txt'));
    rmSync(join(m3, '.gitignore'));
    // Another session's writer there, just started: its head the card branch holds too, but it
    // is not this session's, so never touched.
    const m2 = writer('m2', false);

    for (const id of ['m1', 'm3'])
      git(card, 'merge', '-q', '--no-ff', '-m', `merge ${id}`, `worktree-agent-${id}`);
    // m4: this session's too, its work not merged, a file of it deleted: kept, deletion and all.
    const m4 = writer('m4', true);

    rmSync(join(m4, 'm4.txt'));

    expect(
      await port().tidyWriters({
        worktree: card,
        repo,
        branch: 'card/main-writers',
        agents: ['m1', 'm3', 'm4'],
      }),
    ).toEqual({
      ok: true,
      data: {
        removed: ['m1', 'm3'].map((id) =>
          join(realpathSync(repo), '.claude', 'worktrees', `agent-${id}`),
        ),
        deleted: ['worktree-agent-m1', 'worktree-agent-m3'],
      },
    });
    expect([m1, m3].some(existsSync)).toBe(false);
    expect(existsSync(join(m4, '.git'))).toBe(true);
    expect(existsSync(m2)).toBe(true);
    expect(git(repo, 'branch', '--list', 'worktree-agent-m2')).toContain('worktree-agent-m2');
  });

  test('tidyWriters removes only a writer with no uncommitted change whose commits the card branch holds, or that has none', async () => {
    const card = worktree('rule');
    const writer = (id: string) => {
      const path = join(card, '.claude', 'worktrees', `agent-${id}`);

      git(card, 'worktree', 'add', '-q', '-b', `worktree-agent-${id}`, path, 'HEAD');

      return path;
    };
    const commit = (path: string, id: string) => {
      writeFileSync(join(path, `${id}.txt`), `${id}\n`);
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', id);
    };
    // r1: no commits of its own. r2: merged, then an edit left uncommitted. r3: a commit not merged.
    const r1 = writer('r1');
    const r2 = writer('r2');
    const r3 = writer('r3');

    commit(r2, 'r2');
    git(card, 'merge', '-q', '--no-ff', '-m', 'merge r2', 'worktree-agent-r2');
    writeFileSync(join(r2, 'r2.txt'), 'edited\n');
    commit(r3, 'r3');

    expect(
      await port().tidyWriters({ worktree: card, repo, branch: 'card/rule', agents: [] }),
    ).toEqual({
      ok: true,
      data: {
        removed: [join(realpathSync(card), '.claude', 'worktrees', 'agent-r1')],
        deleted: ['worktree-agent-r1'],
      },
    });
    expect([existsSync(r1), existsSync(r2), existsSync(r3)]).toEqual([false, true, true]);
  });

  test("tidyWriters once the card's worktree is gone: from the checkout, on the card branch (#183)", async () => {
    const card = worktree('cleared');
    const path = join(card, '.claude', 'worktrees', 'agent-c1');

    git(card, 'worktree', 'add', '-q', '-b', 'worktree-agent-c1', path, 'HEAD');
    writeFileSync(join(path, 'c1.txt'), 'c1\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'c1');
    git(card, 'merge', '-q', '--no-ff', '-m', 'merge c1', 'worktree-agent-c1');
    // Done's clearing removed the card's worktree, and with it the writer's folder.
    rmSync(card, { recursive: true, force: true });

    expect(
      await port().tidyWriters({ worktree: card, repo, branch: 'card/cleared', agents: [] }),
    ).toEqual({
      ok: true,
      data: { removed: [], deleted: ['worktree-agent-c1'] },
    });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('agent-c1');
  });

  test("a box's: git in the workspace container (here a stand-in exec), the push and the work", async () => {
    const wt = worktree('7-box');
    const argvs: (readonly string[])[] = [];
    // The container's exec, standing in: what runs there runs here, with the container's own env.
    const exec: ContainerExec = async (argv) => {
      argvs.push(argv);
      const child = Bun.spawn([...argv], {
        env: { ...ENV, HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { exit, stdout, stderr };
    };
    const box = workspaceGit(exec);

    writeFileSync(join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'b');
    expect((await box.work(wt)).ok && (await box.work(wt))).toMatchObject({
      data: { uncommitted: 0, unpushed: 1 },
    });
    expect(await box.push(wt, 'card/7-box')).toEqual({ ok: true, data: null });
    expect(git(remote, 'rev-parse', 'card/7-box')).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(argvs.every((a) => a[0] === 'env' || a[0] === 'test')).toBe(true);
    expect(await box.work(join(root, 'no-such'))).toEqual({ ok: true, data: null });
  });

  test('a push the remote refuses, and a checkout with no origin', async () => {
    const wt = worktree('6-refused');
    const lone = join(root, 'lone');

    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const pushed = await port().push(wt, 'card/6-refused');

    expect(pushed.ok ? 'pushed' : pushed.error.code).toBe('push-failed');
    rmSync(join(remote, 'hooks', 'pre-receive'));
    git(root, 'init', '-q', lone);
    const origin = await port().origin(lone);

    expect(origin.ok ? 'found' : origin.error.code).toBe('no-origin');
  });
});

test("git's environment, and so its credential helper `gh auth git-credential`'s, has none of gh's dropped names", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-git-env-'));
  const seen = join(dir, 'env');

  // A git that writes the environment it was given and fails, as git's helper would inherit it.
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n/usr/bin/env > '${seen}'\nexit 1\n`, { mode: 0o755 });
  const port = cardGit({
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: dir,
      KEPT: 'yes',
      ...Object.fromEntries(GH_DROPPED.map((name) => [name, 'leaked'])),
    },
  });

  await port.origin(dir);
  const names = readFileSync(seen, 'utf8')
    .split('\n')
    .map((line) => line.split('=')[0]);

  expect(GH_DROPPED.filter((name) => names.includes(name))).toEqual([]);
  expect(names).toContain('KEPT');
  rmSync(dir, { recursive: true, force: true });
});
