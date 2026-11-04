/**
 * A run's tree read for its logs and its report count, on this machine's disk and inside a
 * workspace container (its `docker exec` here a plain process on this machine, as the stand-in
 * workspace runs it): the same answers from both.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LogSources, type Ran } from '@abe/core';
import { containerRunTree, localRunTree } from './run-tree';
import { type ContainerExec } from '../docker/workspace-runner';

const root = mkdtempSync(join(tmpdir(), 'abe-run-tree-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `docker exec` as a process here: what `containerRunTree` runs, run on this machine. */
const execHere: ContainerExec = async (argv, o) => {
  const child = Bun.spawn([...argv], {
    env: { PATH: '/usr/bin:/bin' },
    stdin: o?.stdin === undefined ? 'ignore' : new TextEncoder().encode(o.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exit, stdout, stderr } satisfies Ran;
};

const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** A home with a transcript and a worktree with the card's checks, reports and Evidence. */
const planted = (name: string) => {
  const home = join(root, name, 'home');
  const worktree = join(root, name, 'repo');
  const projects = join(home, '.claude', 'projects');
  const scratch = join(worktree, '.scratch', '4');

  write(join(projects, '-repo', 'u-1.jsonl'), '{"type":"user"}\n');
  write(join(home, '.netrc'), 'machine x password y\n');
  write(join(scratch, 'checks.md'), '# Checks\n');
  write(join(scratch, 'review', '1-review.md'), 'clean\n');
  write(join(scratch, 'verify', '1-after.md'), 'After: pass\n');
  write(
    join(scratch, 'verify', 'evidence', 'after-1.png'),
    new Uint8Array([0x89, 0x50, 0xff, 0xfe]),
  );
  write(join(scratch, 'verify', 'evidence', 'after-1.txt'), 'In stock\n');
  // A link out of the worktree: never followed.
  symlinkSync(join(home, '.netrc'), join(scratch, 'review', '2-review.md'));

  const sources: LogSources = {
    files: [
      {
        name: 'transcript.jsonl',
        path: join(projects, '-repo', 'u-1.jsonl'),
        within: projects,
      },
      { name: 'checks.md', path: join(scratch, 'checks.md'), within: worktree },
      { name: 'linked.md', path: join(scratch, 'review', '2-review.md'), within: worktree },
      { name: 'gone.md', path: join(scratch, 'gone.md'), within: worktree },
      // A path out of its folder, as a session's hooks could name one.
      { name: 'netrc', path: join(projects, '..', '..', '.netrc'), within: projects },
    ],
    dirs: [
      { name: 'review', path: join(scratch, 'review'), within: worktree },
      { name: 'verify', path: join(scratch, 'verify'), within: worktree },
      { name: 'none', path: join(scratch, 'none'), within: worktree },
    ],
  };

  return { scratch, sources };
};

describe.each([
  ['on this machine', localRunTree({ PATH: '/usr/bin:/bin' })],
  ['in the workspace container', containerRunTree(execHere)],
])('a run tree %s', (where, tree) => {
  const slug = where.replace(/ /g, '-');

  test('its logs: text inside each folder; a link left out, other folders and binary files skipped', async () => {
    const { sources } = planted(slug);
    const read = await tree.logs(sources);

    expect(read.files).toEqual([
      { name: 'transcript.jsonl', text: '{"type":"user"}\n' },
      { name: 'checks.md', text: '# Checks\n' },
      { name: 'review/1-review.md', text: 'clean\n' },
      { name: 'verify/1-after.md', text: 'After: pass\n' },
      { name: 'verify/evidence/after-1.txt', text: 'In stock\n' },
    ]);
    // The link in review/ is no file of the folder: never listed, never followed.
    expect(read.skipped.map((x) => x.name)).toEqual([
      'linked.md',
      'netrc',
      'verify/evidence/after-1.png',
    ]);
    expect(read.skipped[0]?.why).toBe('a link');
    expect(read.skipped[1]?.why).toStartWith('outside ');
    expect(read.skipped[2]?.why).toBe('not UTF-8 text');
  });

  test("its report count: the folder's own files, never its Evidence folder", async () => {
    const { scratch } = planted(`${slug}-count`);

    expect(await tree.count(join(scratch, 'verify'))).toBe(1);
    expect(await tree.count(join(scratch, 'none'))).toBe(0);
  });

  test("its branch's commits since the merge base, oldest first: short sha and subject", async () => {
    const repo = join(root, `${slug}-commits`);
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });

    mkdirSync(repo, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'First');
    git('checkout', '-q', '-b', 'card/4-cart');
    git('commit', '-q', '--allow-empty', '-m', 'Cart total counts each quantity');
    git('commit', '-q', '--allow-empty', '-m', 'Cart: a test for two of one item');
    const read = await tree.commits(repo);

    expect(read.ok && read.data.map((c) => c.subject)).toEqual([
      'Cart total counts each quantity',
      'Cart: a test for two of one item',
    ]);
    expect(read.ok && read.data.every((c) => /^[0-9a-f]{7,}$/.test(c.sha))).toBe(true);
  });
});

describe("a check in the workspace container, with the agent's writer worktrees in .claude (#67)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd,
    });

    if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());

    return ran.stdout.toString().trim();
  };

  test('a merged writer worktree is removed first; one not merged stays, its Claude Code write folder readable', async () => {
    const repo = join(root, 'writers', 'repo');

    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'card/7-x');
    write(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'a');
    // A writer's work, merged into the card's branch (--no-ff).
    git(repo, 'worktree', 'add', '-q', '-b', 'w-merged', '.claude/worktrees/agent-merged');
    write(join(repo, '.claude/worktrees/agent-merged/b.txt'), 'b\n');
    git(join(repo, '.claude/worktrees/agent-merged'), 'add', '.');
    git(join(repo, '.claude/worktrees/agent-merged'), 'commit', '-qm', 'b');
    git(repo, 'merge', '-q', '--no-ff', 'w-merged', '-m', 'merge b');
    // A writer still at work: its commit is not on the card's branch.
    git(repo, 'worktree', 'add', '-q', '-b', 'w-open', '.claude/worktrees/agent-open');
    write(join(repo, '.claude/worktrees/agent-open/c.txt'), 'c\n');
    git(join(repo, '.claude/worktrees/agent-open'), 'add', '.');
    git(join(repo, '.claude/worktrees/agent-open'), 'commit', '-qm', 'c');
    // Claude Code's settings write folder in it, as Claude Code makes it.
    mkdirSync(join(repo, '.claude/worktrees/agent-open/.claude/.cc-writes'), {
      recursive: true,
      mode: 0o700,
    });

    const ran = await containerRunTree(execHere).shell({
      run: 'ls .claude/worktrees',
      cwd: repo,
      timeoutMs: 10_000,
    });

    expect(ran).toMatchObject({ exit: 0, output: 'agent-open\n' });
    expect(git(repo, 'branch', '--list', 'w-merged')).toBe('w-merged');
    expect(
      statSync(join(repo, '.claude/worktrees/agent-open/.claude/.cc-writes')).mode & 0o777,
    ).toBe(0o755);
  });
});
