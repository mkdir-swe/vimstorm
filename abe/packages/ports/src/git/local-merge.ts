/**
 * Local mode's merge (#24): a local pull request squashed into the local base with git's own
 * plumbing (`merge-tree --write-tree`, `commit-tree`), so no checkout is switched. Where the base
 * is checked out (the main checkout, usually) its tree moves along by a fast-forward, refused
 * while it holds changes; elsewhere the branch ref moves. Nothing is pushed or fetched.
 */
import { type LocalMerge, type LocalPrFile } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, gitEnv, runProcess, said } from '../mac/process';

/** The worktree that has `branch` checked out, from `git worktree list --porcelain`. */
const checkedOutAt = (porcelain: string, branch: string): string | undefined =>
  porcelain
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines.includes(`branch refs/heads/${branch}`))
    ?.find((l) => l.startsWith('worktree '))
    ?.slice('worktree '.length);

/** `git diff --name-status -z -M` and `--numstat -z -M`, base to head, as the files they say. */
export const diffFiles = (nameStatus: string, numstat: string): LocalPrFile[] => {
  const counts = new Map<string, { added: number; removed: number }>();
  const nums = numstat.split('\0');

  for (let i = 0; i < nums.length; i += 1) {
    const [added = '', removed = '', path = ''] = (nums[i] ?? '').split('\t');

    if (added === '') continue;
    // a rename: its paths follow, the old then the new
    const at = path === '' ? (nums[(i += 2)] ?? '') : path;
    const n = (t: string) => (/^[0-9]+$/.test(t) ? Number(t) : 0);

    counts.set(at, { added: n(added), removed: n(removed) });
  }
  const files: LocalPrFile[] = [];
  const parts = nameStatus.split('\0');

  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i]?.charAt(0) ?? '';

    if (code === '') continue;
    const renamed = code === 'R' || code === 'C';
    const oldPath = renamed ? (parts[(i += 1)] ?? '') : undefined;
    const path = parts[(i += 1)] ?? '';
    const kept: LocalPrFile['status'] = code === 'A' || code === 'D' ? code : 'M';
    const status = renamed ? 'R' : kept;

    files.push({
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status,
      ...(counts.get(path) ?? { added: 0, removed: 0 }),
    });
  }

  return files;
};

export const localMerge = (o: { env: Env }): LocalMerge => {
  const env = gitEnv(o.env);
  const bin = Bun.which('git', { PATH: env.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  const git = (cwd: string, args: readonly string[]) =>
    runProcess(
      [bin, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      env,
    );
  const head = async (checkout: string, branch: string) => {
    const at = await git(checkout, [
      'rev-parse',
      '-q',
      '--verify',
      `refs/heads/${branch}^{commit}`,
    ]);

    return at.exit === 0
      ? { ok: true as const, data: at.stdout.trim() }
      : failed('no-branch', `${checkout} has no branch ${branch}`);
  };

  return {
    head,
    changes: async (checkout, { head: branch, base }) => {
      const from = await head(checkout, branch);

      if (!from.ok) return from;
      const onto = await head(checkout, base);

      if (!onto.ok) return onto;
      const fork = await git(checkout, ['merge-base', onto.data, from.data]);

      if (fork.exit !== 0)
        return failed('git-failed', `git merge-base: ${said(fork, 'git merge-base')}`);
      const baseSha = fork.stdout.trim();
      const range = [baseSha, from.data];
      const [names, nums, log] = await Promise.all([
        git(checkout, ['diff', '--name-status', '-z', '-M', ...range]),
        git(checkout, ['diff', '--numstat', '-z', '-M', ...range]),
        git(checkout, ['log', '--reverse', '--format=%H%x09%s', `${baseSha}..${from.data}`]),
      ]);
      const bad = [names, nums, log].find((r) => r.exit !== 0);

      if (bad !== undefined) return failed('git-failed', `git: ${said(bad, 'git diff')}`);

      return {
        ok: true,
        data: {
          baseSha,
          files: diffFiles(names.stdout, nums.stdout),
          commits: log.stdout
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => {
              const tab = l.indexOf('\t');

              return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
            }),
        },
      };
    },
    squash: async (checkout, { head: branch, base, message }) => {
      const from = await head(checkout, branch);

      if (!from.ok) return from;
      const onto = await head(checkout, base);

      if (!onto.ok) return onto;
      const tree = await git(checkout, ['merge-tree', '--write-tree', onto.data, from.data]);

      if (tree.exit === 1)
        return failed(
          'conflicting',
          `${branch} conflicts with ${base}: bring the branch up to date`,
        );
      if (tree.exit !== 0)
        return failed('git-failed', `git merge-tree: ${said(tree, 'git merge-tree')}`);
      const [treeSha] = tree.stdout.trim().split('\n');

      if (treeSha === undefined || treeSha === '')
        return failed('git-failed', 'git merge-tree wrote no tree');
      const made = await git(checkout, ['commit-tree', treeSha, '-p', onto.data, '-m', message]);

      if (made.exit !== 0)
        return failed('git-failed', `git commit-tree: ${said(made, 'git commit-tree')}`);
      const sha = made.stdout.trim();
      const listed = await git(checkout, ['worktree', 'list', '--porcelain']);
      const at = listed.exit === 0 ? checkedOutAt(listed.stdout, base) : undefined;

      if (at !== undefined) {
        const status = await git(at, ['status', '--porcelain', '--untracked-files=no']);

        if (status.exit !== 0 || status.stdout.trim() !== '')
          return failed(
            'base-dirty',
            `${base} is checked out in ${at} with changes: commit or stash them, then merge again`,
          );
        const moved = await git(at, ['merge', '--ff-only', '--quiet', sha]);

        return moved.exit === 0
          ? { ok: true, data: { sha } }
          : failed('git-failed', `git merge --ff-only: ${said(moved, 'git merge')}`);
      }
      const moved = await git(checkout, ['update-ref', `refs/heads/${base}`, sha, onto.data]);

      return moved.exit === 0
        ? { ok: true, data: { sha } }
        : failed('git-failed', `git update-ref: ${said(moved, 'git update-ref')}`);
    },
  };
};
