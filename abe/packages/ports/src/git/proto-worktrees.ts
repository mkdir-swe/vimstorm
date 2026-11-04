/**
 * A developer's prototype's worktree (#83): `proto/<card>-<slug>` made off the default branch's
 * commit with no upstream, beside the checkout (core's `worktreePath`), and a `pre-push` hook that
 * refuses every push. The hook is the worktree's own: `core.hooksPath` in its `config.worktree`
 * (git's `extensions.worktreeConfig`) points at a folder under the repository's `hooks/`, which a
 * local session's sandbox never writes, and the session's settings keep `config.worktree` from it
 * too (`denied`). `push.default nothing` there as well, so a bare `git push` names nothing. The
 * main checkout keeps its own hooks and push; its config gains only `extensions.worktreeConfig`
 * (kept: other worktrees may use it) and its `hooks/` the prototype's folder. IO only: the
 * branch's name and the hook's words are core's. One repository's are made one at a time, and a
 * lock another git holds is waited out (#301, `repo-lock.ts`).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Answered, PRE_PUSH_HOOK, worktreePath } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, gitEnv, runProcess, said } from '../mac/process';
import { oneAtATime, retryLocked } from './repo-lock';

/** The folder under the repository's `hooks/` that a prototype worktree's `core.hooksPath` names. */
export const PROTOTYPE_HOOKS = 'abe-prototype';

export type ProtoWorktree = {
  path: string;
  /** Files the session may never write: the worktree's `config.worktree`. */
  denied: string[];
  /** Made now (false: the one on the branch already, reused). */
  made: boolean;
};

export type ProtoWorktrees = {
  /** The worktree on `branch` at `commit` with no upstream and the refusing hook; reused when there. */
  make: (repo: string, branch: string, commit: string) => Promise<Answered<ProtoWorktree>>;
  /** How many files are changed or new in it (ignored ones are not work); null when it is gone. */
  uncommitted: (worktree: string) => Promise<Answered<number | null>>;
  /** Removes the worktree (`force`: with its changes) and, with `branch`, deletes that branch. */
  remove: (
    repo: string,
    worktree: string,
    o: { force: boolean; branch?: string },
  ) => Promise<Answered<null>>;
};

export const protoWorktrees = (env: Env): ProtoWorktrees => {
  const gEnv = gitEnv(env);
  const gitBin = Bun.which('git', { PATH: gEnv.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  const git = (cwd: string, ...args: string[]) => runProcess([gitBin, '-C', cwd, ...args], gEnv);
  const write = (cwd: string, ...args: string[]) => retryLocked(() => git(cwd, ...args));

  /** The repository's common git folder and its main checkout, also from a worktree. */
  const common = async (repo: string): Promise<Answered<{ git: string; root: string }>> => {
    const dir = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');

    if (dir.exit !== 0)
      return failed('not-a-repo', `${repo} is not a git checkout: ${said(dir, 'git')}`);
    const gitDir = dir.stdout.trim();

    return { ok: true, data: { git: gitDir, root: dirname(gitDir) } };
  };

  return {
    make: async (repo, branch, commit) => {
      const c = await common(repo);

      if (!c.ok) return c;
      const { git: gitDir, root } = c.data;

      return oneAtATime(root, async () => {
        const path = worktreePath(root, branch);
        const listed = await git(root, 'worktree', 'list', '--porcelain');
        const held = listed.stdout
          .split('\n\n')
          .find((b) => b.split('\n').includes(`branch refs/heads/${branch}`));
        const heldPath = held
          ?.split('\n')
          .find((l) => l.startsWith('worktree '))
          ?.slice('worktree '.length);
        let made = false;

        if (heldPath !== undefined && heldPath !== path)
          return failed('worktree-taken', `${branch} is checked out at ${heldPath}, not ${path}`);
        if (heldPath === undefined) {
          if (existsSync(path))
            return failed('worktree-taken', `${path} exists and is not on ${branch}`);
          const known = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
          const added =
            known.exit === 0
              ? await write(root, 'worktree', 'add', path, branch)
              : await write(root, 'worktree', 'add', '--no-track', '-b', branch, path, commit);

          if (added.exit !== 0)
            return failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);
          made = true;
        }
        // No upstream, whatever made the branch.
        await write(path, 'branch', '--unset-upstream');
        const hooks = join(gitDir, 'hooks', PROTOTYPE_HOOKS);

        mkdirSync(hooks, { recursive: true });
        writeFileSync(join(hooks, 'pre-push'), PRE_PUSH_HOOK, { mode: 0o755 });
        chmodSync(join(hooks, 'pre-push'), 0o755);
        const shared = await git(
          root,
          'config',
          '--type=bool',
          '--get',
          'extensions.worktreeConfig',
        );
        // The shared config is written only the first time: every prototype after reads it.
        const steps = [
          ...(shared.stdout.trim() === 'true'
            ? []
            : [[root, 'config', 'extensions.worktreeConfig', 'true'] as const]),
          [path, 'config', '--worktree', 'core.hooksPath', hooks] as const,
          [path, 'config', '--worktree', 'push.default', 'nothing'] as const,
        ];

        for (const [cwd, ...args] of steps) {
          const ran = await write(cwd, ...args);

          if (ran.exit !== 0)
            return failed('worktree-failed', `git ${args.join(' ')}: ${said(ran, 'git')}`);
        }
        const own = await git(path, 'rev-parse', '--absolute-git-dir');

        if (own.exit !== 0) return failed('worktree-failed', `git rev-parse: ${said(own, 'git')}`);

        return {
          ok: true,
          data: { path, denied: [join(own.stdout.trim(), 'config.worktree')], made },
        };
      });
    },
    uncommitted: async (worktree) => {
      if (!existsSync(worktree)) return { ok: true, data: null };
      const status = await git(worktree, 'status', '--porcelain', '--untracked-files=all');

      if (status.exit !== 0) return failed('git-failed', `git status: ${said(status, 'git')}`);

      return { ok: true, data: status.stdout.split('\n').filter((l) => l !== '').length };
    },
    remove: async (repo, worktree, o) => {
      const c = await common(repo);

      if (!c.ok) return c;
      const { root } = c.data;

      if (existsSync(worktree)) {
        const removed = await git(
          root,
          'worktree',
          'remove',
          ...(o.force ? ['--force'] : []),
          worktree,
        );

        if (removed.exit !== 0)
          return failed(
            'git-failed',
            `git worktree remove ${basename(worktree)}: ${said(removed, 'git')}`,
          );
      } else await git(root, 'worktree', 'prune');
      if (o.branch !== undefined) {
        const known = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${o.branch}`);

        if (known.exit === 0) {
          const deleted = await git(root, 'branch', '-D', o.branch);

          if (deleted.exit !== 0)
            return failed('git-failed', `git branch -D ${o.branch}: ${said(deleted, 'git')}`);
        }
      }

      return { ok: true, data: null };
    },
  };
};
