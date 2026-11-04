/**
 * A session's worktree through `git`: the pr stage's push, a fetch for a conflicting pull request
 * (#199) and Done's clearing (#48). Git asks `gh` for the person's login when it pushes or fetches
 * over https (`gh auth git-credential`), so no token is ever in an environment, a URL or a file of
 * ours. The last of Abe's worktrees removed takes its card block out of `info/exclude`. No rules here: what counts as work kept is core's (`workKept`).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Git, type Ran } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, gitEnv, killedAtTimeout, runProcess, said } from '../mac/process';
import { CARD_EXCLUDE, writeBlock } from './exclude-block';
import { retryLocked } from './repo-lock';
import { type ContainerExec } from '../docker/workspace-runner';

/** Only `gh` answers for credentials: the person's keyring login. */
const CREDENTIALS = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

/**
 * How long a fetch of origin may take before what asked goes on without it: a card's launch
 * (#198) within #157's launch budget, a pull request's poll (#199).
 */
export const FETCH_TIMEOUT_MS = 8_000;

/** How long a push may take by default: the repo's pre-push hook (its tests) runs inside it. */
export const PUSH_TIMEOUT_MS = 15 * 60_000;

/** A push stopped at its timeout: almost always the repo's pre-push hook, and how to give it more. */
export const pushTimeoutMessage = (timeoutMs: number): string =>
  `git push was stopped after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`}: the repo's pre-push hook (what it runs before every push, often tests) is what's slow. Give it longer with pr.pushTimeout (minutes) in abe.yaml, or make the hook faster`;

/** `git fetch` of origin, asking `gh` for the login over https, every serve fetch's arguments. */
export const FETCH_ORIGIN = [...CREDENTIALS, 'fetch', '--quiet', '--no-tags', 'origin'];

/** git's environment for a fetch: it never waits on a prompt nobody sees (ssh in batch mode). */
export const fetchEnv = (env: Record<string, string>): Record<string, string> => ({
  ...env,
  GIT_TERMINAL_PROMPT: '0',
  ...(env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}),
});

/** `git -C <cwd> <args>` where the worktree is, and whether a path is there. */
type GitIn = {
  git: (cwd: string, args: readonly string[], timeoutMs?: number) => Promise<Ran>;
  exists: (path: string) => Promise<boolean>;
};

export const cardGit = (o: { env: Env }): Git => {
  // A parent git's variables would point every command at its repo, and no token may leak.
  const env = fetchEnv(gitEnv(o.env));
  const bin = Bun.which('git', { PATH: env.PATH ?? '/usr/bin:/bin' }) ?? 'git';

  return gitIn({
    git: (cwd, args, timeoutMs) => runProcess([bin, '-C', cwd, ...args], env, undefined, timeoutMs),
    exists: (path) => Promise.resolve(existsSync(path)),
  });
};

/**
 * A box's run worktree, the workspace's clone (#67): git inside the workspace container, as its
 * user, so the push goes out with the login the session's `gh` has there.
 */
export const workspaceGit = (exec: ContainerExec): Git =>
  gitIn({
    git: (cwd, args, timeoutMs) =>
      exec(
        [
          'env',
          'GIT_TERMINAL_PROMPT=0',
          'git',
          // The clone is the agent's: none of its hooks or fsmonitor run as serve's git.
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-C',
          cwd,
          ...args,
        ],
        { timeoutMs: timeoutMs ?? 120_000 },
      ),
    exists: async (path) => (await exec(['test', '-e', path])).exit === 0,
  });

/** Claude Code's branch for a subagent's worktree (`isolation: worktree`). */
const WRITER_BRANCH = 'worktree-agent-';

/**
 * Where Claude Code puts a subagent's worktree: under the main checkout (#218), where every
 * session of the repo puts its writers, or under the session's own worktree.
 */
const WRITERS_DIR = '/.claude/worktrees/';

/** `git worktree list --porcelain`'s entries: each one's path and branch. */
const worktreeList = (porcelain: string) =>
  porcelain
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      const branch = lines
        .find((l) => l.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length);
      // git's own words for a record whose folder is gone, and for one locked against pruning
      const prunable = lines.some((l) => l === 'prunable' || l.startsWith('prunable '));
      const locked = lines.some((l) => l === 'locked' || l.startsWith('locked '));

      return { path, branch, prunable, locked };
    })
    .filter(
      (w): w is { path: string; branch: string | undefined; prunable: boolean; locked: boolean } =>
        w.path !== undefined,
    );

const gitIn = ({ git, exists }: GitIn): Git => {
  // serve's own git in the agent's tree: none of its hooks or fsmonitor run.
  const own = (cwd: string, args: readonly string[]) =>
    git(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]);

  return {
    tidyWriters: async ({ worktree, repo, branch, agents }) => {
      // From the main checkout once the card's worktree is gone (Done's clearing removed it).
      const cwd = (await exists(worktree)) ? worktree : repo;
      const head = await own(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]);

      if (head.exit !== 0) return { ok: true, data: { removed: [], deleted: [] } };
      const at = head.stdout.trim();
      const listed = await own(cwd, ['worktree', 'list', '--porcelain']);

      if (listed.exit !== 0)
        return failed('git-failed', `git worktree list: ${said(listed, 'git worktree list')}`);
      // git names a worktree by its real path: the card's and the checkout's as git sees them.
      const where = await own(cwd, [
        'rev-parse',
        '--show-toplevel',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const [top, common] = where.exit === 0 ? where.stdout.trim().split('\n') : [];
      const reals = {
        [worktree]: cwd === worktree ? top : undefined,
        [repo]: common?.endsWith('/.git') === true ? common.slice(0, -'/.git'.length) : undefined,
      };
      // A card's worktree gone (Done's clearing): by its last two folders, as git still lists it.
      const tail = `/${worktree.split('/').slice(-2).join('/')}`;
      const named = (path: string, dir: string) =>
        path === dir ||
        path === reals[dir] ||
        (dir === worktree && reals[dir] === undefined && path.endsWith(tail));
      const writerOf = (w: { path: string; branch: string | undefined }) => {
        const at = w.path.indexOf(WRITERS_DIR);

        if (at === -1) return false;
        const folder = w.path.slice(w.path.lastIndexOf('/') + 1);
        const parent = w.path.slice(0, at);

        // In the card's worktree: Claude Code's writers only, an `agent-*` folder or a
        // `worktree-agent-*` branch.
        if (named(parent, worktree))
          return (w.branch?.startsWith(WRITER_BRANCH) ?? false) || folder.startsWith('agent-');

        // In the main checkout, beside other sessions' writers: this session's own alone (#218).
        return (
          named(parent, repo) &&
          agents.some((id) => folder === `agent-${id}` || w.branch === `${WRITER_BRANCH}${id}`)
        );
      };
      const writers = worktreeList(listed.stdout).filter(writerOf);
      const holds = async (rev: string) =>
        (await own(cwd, ['merge-base', '--is-ancestor', rev, at])).exit === 0;
      const removed: string[] = [];

      for (const w of writers) {
        if (!(await exists(w.path))) {
          // Gone from disk (removed in the sandbox): its record goes once the card branch holds
          // its branch, which goes below; till then both stay, so a later tidy still finds it.
          // Never `git worktree prune`, which forgets every such writer's branch, others' too.
          if (w.branch !== undefined && (await holds(`refs/heads/${w.branch}`)))
            await own(cwd, ['worktree', 'remove', '--force', w.path]);
          continue;
        }
        const its = await own(w.path, ['rev-parse', '-q', '--verify', 'HEAD']);

        if (its.exit !== 0 || !(await holds(its.stdout.trim()))) continue;
        if ((await own(cwd, ['worktree', 'remove', w.path])).exit === 0) {
          removed.push(w.path);
          continue;
        }
        // The agent's own `git worktree remove` in the sandbox deletes what it may and is refused
        // the rest (#218): with only deletions of what its head holds left, nothing is lost.
        const left = await own(w.path, ['status', '--porcelain', '--untracked-files=all']);
        const deletionsOnly =
          left.exit === 0 &&
          left.stdout
            .split('\n')
            .filter((l) => l !== '')
            .every((l) => /^(?: D|D |DD)/.test(l));

        if (deletionsOnly && (await own(cwd, ['worktree', 'remove', '--force', w.path])).exit === 0)
          removed.push(w.path);
      }
      // Every other record whose folder is gone, as `git worktree prune` would, but never a
      // writer's (anyone's: its record is how a later tidy finds its branch) nor a locked one.
      for (const w of worktreeList(listed.stdout))
        if (
          w.prunable &&
          !w.locked &&
          !w.path.includes(WRITERS_DIR) &&
          w.branch?.startsWith(WRITER_BRANCH) !== true
        )
          await own(cwd, ['worktree', 'remove', '--force', w.path]);
      const after = await own(cwd, ['worktree', 'list', '--porcelain']);
      const checkedOut = new Set(
        worktreeList(after.stdout).flatMap((w) => (w.branch === undefined ? [] : [w.branch])),
      );
      const candidates = [
        ...new Set([
          ...writers.flatMap((w) => (w.branch === undefined ? [] : [w.branch])),
          ...agents.map((id) => `${WRITER_BRANCH}${id}`),
        ]),
      ].filter((b) => b.startsWith(WRITER_BRANCH) && !checkedOut.has(b));
      const deleted: string[] = [];

      for (const b of candidates) {
        const ref = `refs/heads/${b}`;

        if ((await own(cwd, ['rev-parse', '-q', '--verify', ref])).exit !== 0) continue;
        if (!(await holds(ref))) continue;
        if ((await own(cwd, ['branch', '-D', b])).exit === 0) deleted.push(b);
      }

      return { ok: true, data: { removed, deleted: deleted.sort() } };
    },
    origin: async (worktree) => {
      const url = await git(worktree, ['config', '--get', 'remote.origin.url']);

      if (url.exit !== 0) return failed('no-origin', `${worktree} has no origin remote`);
      const head = await git(worktree, [...CREDENTIALS, 'ls-remote', '--symref', 'origin', 'HEAD']);

      if (head.exit !== 0)
        return failed('git-failed', `git ls-remote: ${said(head, 'git ls-remote')}`);
      const [, branch] = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.stdout) ?? [];

      return branch === undefined
        ? failed('git-failed', `origin names no default branch: ${head.stdout.trim()}`)
        : { ok: true, data: { url: url.stdout.trim(), defaultBranch: branch } };
    },
    push: async (worktree, branch, timeoutMs = PUSH_TIMEOUT_MS) => {
      // `--set-upstream` writes the shared config: a lock another git holds is waited out (#301)
      const pushed = await retryLocked(() =>
        git(
          worktree,
          [
            ...CREDENTIALS,
            'push',
            '--quiet',
            '--set-upstream',
            'origin',
            `refs/heads/${branch}:refs/heads/${branch}`,
          ],
          timeoutMs,
        ),
      );

      if (pushed.exit === 0) return { ok: true, data: null };

      return killedAtTimeout(pushed)
        ? failed('push-timeout', pushTimeoutMessage(timeoutMs))
        : failed('push-failed', `git push: ${said(pushed, 'git push')}`);
    },
    fetchOrigin: async (worktree) => {
      const fetched = await retryLocked(() => git(worktree, FETCH_ORIGIN, FETCH_TIMEOUT_MS));

      return fetched.exit === 0
        ? { ok: true, data: null }
        : failed('fetch-failed', `git fetch: ${said(fetched, 'git fetch')}`);
    },
    onOrigin: async (worktree, branch) => {
      const listed = await git(worktree, [
        ...CREDENTIALS,
        'ls-remote',
        '--exit-code',
        '--heads',
        'origin',
        `refs/heads/${branch}`,
      ]);

      // --exit-code: 2 is no such ref
      if (listed.exit === 0) return { ok: true, data: true };

      return listed.exit === 2
        ? { ok: true, data: false }
        : failed('git-failed', `git ls-remote: ${said(listed, 'git ls-remote')}`);
    },
    startAt: async (worktree, { from, base }) => {
      const there = `refs/remotes/origin/${from}`;
      const fetched = await retryLocked(() =>
        git(
          worktree,
          [
            ...CREDENTIALS,
            'fetch',
            '--quiet',
            '--no-tags',
            'origin',
            `+refs/heads/${from}:${there}`,
            `+refs/heads/${base}:refs/remotes/origin/${base}`,
          ],
          FETCH_TIMEOUT_MS,
        ),
      );

      if (fetched.exit !== 0)
        return failed('fetch-failed', `git fetch: ${said(fetched, 'git fetch')}`);
      // holding their head already (started there, or built on it): as it is
      if ((await own(worktree, ['merge-base', '--is-ancestor', there, 'HEAD'])).exit === 0)
        return { ok: true, data: { moved: false } };
      const changed = await own(worktree, ['status', '--porcelain', '--untracked-files=no']);
      const ahead = await own(worktree, [
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        `refs/remotes/origin/${base}`,
      ]);

      if (changed.exit !== 0 || ahead.exit !== 0)
        return failed(
          'git-failed',
          `git status: ${said(changed.exit !== 0 ? changed : ahead, 'git')}`,
        );
      if (changed.stdout.trim() !== '' || Number(ahead.stdout.trim()) > 0)
        return failed(
          'own-work',
          `the branch holds work of its own (changed files or commits ${base} lacks): it is not moved onto ${from}`,
        );
      const reset = await own(worktree, ['reset', '--quiet', '--keep', there]);

      return reset.exit === 0
        ? { ok: true, data: { moved: true } }
        : failed('git-failed', `git reset: ${said(reset, 'git reset')}`);
    },
    work: async (worktree) => {
      if (!(await exists(worktree))) return { ok: true, data: null };
      const status = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);

      if (status.exit !== 0)
        return failed('git-failed', `git status: ${said(status, 'git status')}`);
      const unpushed = await git(worktree, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);

      if (unpushed.exit !== 0)
        return failed('git-failed', `git rev-list: ${said(unpushed, 'git rev-list')}`);

      const head = await git(worktree, ['rev-parse', 'HEAD']);

      if (head.exit !== 0)
        return failed('git-failed', `git rev-parse: ${said(head, 'git rev-parse')}`);

      return {
        ok: true,
        data: {
          uncommitted: status.stdout.split('\n').filter((l) => l !== '').length,
          unpushed: Number(unpushed.stdout.trim()),
          head: head.stdout.trim(),
        },
      };
    },
    remove: async (worktree, how) => {
      const common = await git(worktree, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);

      if (common.exit !== 0)
        return failed('git-failed', `git rev-parse: ${said(common, 'git rev-parse')}`);
      // From the main checkout: a worktree is not removed from inside itself.
      const root = dirname(common.stdout.trim());
      const removed = await git(root, [
        'worktree',
        'remove',
        ...(how?.force === true ? ['--force'] : []),
        worktree,
      ]);

      if (removed.exit !== 0)
        return failed('git-failed', `git worktree remove: ${said(removed, 'git worktree remove')}`);
      // The last of Abe's worktrees gone (a card's, a PR checked out for review): its card block
      // leaves `info/exclude`.
      const left = await git(root, ['worktree', 'list', '--porcelain']);
      const ours = [`worktree ${root}-wt/`, `worktree ${root}-pr-`];

      if (
        left.exit === 0 &&
        !left.stdout.split('\n').some((l) => ours.some((o) => l.startsWith(o)))
      )
        writeBlock(join(common.stdout.trim(), 'info', 'exclude'), CARD_EXCLUDE, []);

      return { ok: true, data: null };
    },
  };
};
