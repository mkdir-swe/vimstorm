/**
 * Git worktrees for sessions: the card's own on its branch (made beside the checkout, or the one
 * the branch is already checked out in), and Before's at the merge base of the card's branch and
 * the default branch. A new branch starts from origin's default branch as fetched at that moment,
 * never the checkout's `HEAD` (#198); Before's merge base is taken against it, fetched too. With
 * origin not reached it is origin's as last fetched, and without an origin the checkout's own
 * default branch, each said in a note. git runs with `serve`'s environment, less a parent git's
 * variables, and never prompts.
 * Evidence stays out of commits: `.scratch/` is in the repository's `info/exclude` (Abe's card
 * block) once Abe made a worktree of it, as on a box, until the last one is removed (`Git.remove`). A worktree of Abe's runs core's session hooks (#196,
 * `session-hooks.ts`): a push to the default branch refused, the repository's own hooks run as
 * before; the main checkout's config gains only `extensions.worktreeConfig` (kept: other worktrees
 * may use it) and its `hooks/` the session hooks' folder. Launches at once in one repository make
 * and guard theirs one after the other, and a lock another git holds is waited out (#301).
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type Answered,
  BRANCH_BASE_REFS,
  type BranchBase,
  baseWorktreePath,
  type CardCheckout,
  SESSION_HOOK_NAMES,
  SESSION_HOOKS,
  sessionHookScript,
  worktreePath,
} from '@abe/core';
import { FETCH_ORIGIN, FETCH_TIMEOUT_MS, fetchEnv } from './git';
import { type Env } from '../mac/locations';
import { failed, gitEnv as gitEnvOf, runProcess, said } from '../mac/process';
import { addToBlock, CARD_EXCLUDE } from './exclude-block';
import { oneAtATime, retryLocked, sharedFetch } from './repo-lock';

export type Worktrees = {
  /**
   * The worktree on `branch`: the one it is already checked out in, else a new one beside the
   * checkout; `ours` when it is at Abe's place for the branch. `setupMark`: for one of ours, the
   * file in its own git folder that says the repo pack's setup passed there (null: none of ours).
   */
  onBranch: (
    repo: string,
    branch: string,
    /** A branch not there yet made from the first of these that is a commit (default: `branchBase`'s). */
    from?: readonly string[],
    /** Only a branch there already (a reopen, #343): one gone is refused `worktree-gone`. */
    existing?: boolean,
  ) => Promise<
    Answered<{
      path: string;
      ours: boolean;
      setupMark: string | null;
      /** Where the branch was made from, when it was made now (#198). */
      base?: BranchBase;
    }>
  >;
  /**
   * Before's worktree at the merge base of `branch` and the default branch, detached; `note` when
   * origin was not reached, so the default branch is as last fetched.
   */
  atMergeBase: (
    repo: string,
    branch: string,
  ) => Promise<Answered<{ path: string; base: string; against: string; note?: string }>>;
  /**
   * The card's branch as origin has it (B1, #4), for the person to read or run on this Mac: origin
   * fetched, then `card/<card>` or `card/<card>-*` there (the newest commit), the worktree it is
   * checked out in already, else a new one at `worktreePath` tracking origin's. A local branch of
   * that name moves on to origin's when that is a fast-forward, else stays as it is.
   */
  fromOrigin: CardCheckout;
};

/** `refs/remotes/origin/main` as `origin/main`, `refs/heads/main` as `main`. */
const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');

const NO_ORIGIN = 'no origin remote';

/** Why a branch starts from the checkout's own ref, and which. */
const localNote = (unfetched: string | null, what: string) =>
  unfetched === NO_ORIGIN
    ? `${NO_ORIGIN}: ${what}`
    : `${unfetched ?? 'origin has no default branch'}: ${what}, maybe behind origin`;

export const gitWorktrees = (env: Env): Worktrees => {
  // A parent git's variables would point git at another repository; no token goes to git.
  const gitEnv = gitEnvOf(env);
  const gitBin = Bun.which('git', { PATH: gitEnv.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  const git = (cwd: string, ...args: string[]) => runProcess([gitBin, '-C', cwd, ...args], gitEnv);
  /** A write to what the repository's worktrees share: tried again while another git holds it. */
  const write = (cwd: string, ...args: string[]) => retryLocked(() => git(cwd, ...args));
  // A fetch asks gh for the login and never waits on a prompt nobody sees.
  const fetching = fetchEnv(gitEnv);

  /** origin fetched now: null when it was, else why not (no origin, git's first line). */
  const fetchNow = async (root: string): Promise<string | null> => {
    const origin = await git(root, 'remote', 'get-url', 'origin');

    if (origin.exit !== 0) return NO_ORIGIN;
    const fetched = await runProcess(
      [gitBin, '-C', root, ...FETCH_ORIGIN],
      fetching,
      undefined,
      FETCH_TIMEOUT_MS,
    );

    if (fetched.exit === 0) return null;
    const why = said(fetched, 'git fetch').split('\n')[0];

    // Killed at its time (SIGKILL): nothing git said explains it.
    return `origin not reached (${fetched.exit === 137 ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : why})`;
  };

  /** `fetchNow`, or the fetch another launch in this repository has under way (#301). */
  const fetchOrigin = (root: string) => sharedFetch(root, () => fetchNow(root));

  /** The first of `BRANCH_BASE_REFS` there is, by its full name, with its commit. */
  const baseRef = async (root: string): Promise<{ ref: string; commit: string } | undefined> => {
    for (const ref of BRANCH_BASE_REFS) {
      const name = await git(root, 'rev-parse', '--verify', '--quiet', '--symbolic-full-name', ref);
      const commit = await git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);

      if (name.exit === 0 && name.stdout.trim() !== '' && commit.exit === 0)
        return { ref: name.stdout.trim(), commit: commit.stdout.trim() };
    }

    return undefined;
  };

  /** Why `ref`, the base found, may be behind origin; null when it is origin's as fetched now. */
  const baseNote = (unfetched: string | null, ref: string): string | null => {
    const from = shortRef(ref);

    if (!ref.startsWith('refs/remotes/')) return localNote(unfetched, `the checkout's own ${from}`);

    return unfetched === null ? null : `${unfetched}: ${from} as last fetched`;
  };

  /**
   * Where a new branch starts (#198): origin fetched, then its default branch; else the
   * checkout's own default branch, else its `HEAD`, each with a note saying so. `unfetched`:
   * `fetchOrigin`'s answer.
   */
  const branchBase = async (
    root: string,
    unfetched: string | null,
  ): Promise<BranchBase | undefined> => {
    const found = await baseRef(root);

    if (found !== undefined)
      return {
        from: shortRef(found.ref),
        commit: found.commit,
        note: baseNote(unfetched, found.ref),
      };
    const head = await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');

    if (head.exit !== 0) return undefined;

    return {
      from: 'HEAD',
      commit: head.stdout.trim(),
      note: localNote(unfetched, "the checkout's HEAD"),
    };
  };

  /** The first of `from` that is a commit here (a fix's failed revision), with the fetch's note. */
  const givenBase = async (
    root: string,
    from: readonly string[],
    unfetched: string | null,
  ): Promise<BranchBase | undefined> => {
    for (const ref of from) {
      const commit = await git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);

      if (commit.exit === 0 && commit.stdout.trim() !== '')
        return { from: shortRef(ref), commit: commit.stdout.trim(), note: unfetched };
    }

    return undefined;
  };

  /** The main checkout, also when `repo` is a worktree: new worktrees never nest. */
  const mainCheckout = async (repo: string): Promise<Answered<string>> => {
    const top = await git(repo, 'rev-parse', '--show-toplevel');

    if (top.exit !== 0)
      return failed('not-a-repo', `${repo} is not a git checkout: ${said(top, 'git')}`);
    const common = await git(
      top.stdout.trim(),
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    );

    return {
      ok: true,
      data: common.exit === 0 ? dirname(common.stdout.trim()) : top.stdout.trim(),
    };
  };

  /** `abe-setup` in the worktree's own git folder (`.git/worktrees/<name>/`); null if git cannot say. */
  const setupMark = async (path: string) => {
    const dir = await git(path, 'rev-parse', '--absolute-git-dir');

    return dir.exit === 0 ? join(dir.stdout.trim(), 'abe-setup') : null;
  };

  /** Each worktree's path and branch (`null` when detached). */
  const listed = async (root: string) => {
    const list = await git(root, 'worktree', 'list', '--porcelain');

    return list.stdout
      .split('\n\n')
      .map((block) => {
        const lines = block.split('\n');
        const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
        const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);

        return { path, branch: branch ?? null };
      })
      .filter((w): w is { path: string; branch: string | null } => w.path !== undefined);
  };

  /**
   * `.scratch/` in the repository's `info/exclude` (shared by its worktrees), in Abe's card block
   * (`CARD_EXCLUDE`, which the last of Abe's worktrees removed takes out); once, and never beside
   * a `.scratch/` line there already.
   */
  const excludeScratch = async (root: string) => {
    const where = await git(root, 'rev-parse', '--git-path', 'info/exclude');

    if (where.exit !== 0) return;
    addToBlock(resolve(root, where.stdout.trim()), CARD_EXCLUDE, ['.scratch/']);
  };

  /**
   * A hook as `script`, executable: left as it is when it is so already, else written beside it
   * and renamed over (git, mid-push in another worktree, never runs half of one).
   */
  const putHook = (path: string, script: string) => {
    try {
      if ((statSync(path).mode & 0o777) === 0o755 && readFileSync(path, 'utf8') === script) return;
    } catch {
      // Not there yet.
    }
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;

    try {
      writeFileSync(temp, script, { mode: 0o755 });
      chmodSync(temp, 0o755);
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  };

  /** The default branch's name (`main`), from `baseRef`'s; null when there is none. */
  const defaultName = async (root: string): Promise<string | null> => {
    const found = await baseRef(root);

    return found === undefined ? null : found.ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, '');
  };

  /**
   * The session hooks in the repository's `hooks/`, and the worktree's `core.hooksPath` on them;
   * a worktree with hooks of its own already (a developer prototype's, which refuse every push)
   * keeps those.
   */
  const guard = async (root: string, path: string): Promise<Answered<null>> => {
    const common = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');

    if (common.exit !== 0)
      return failed('worktree-failed', `git rev-parse: ${said(common, 'git')}`);
    const hooks = join(common.stdout.trim(), 'hooks', SESSION_HOOKS);
    const scoped = await git(path, 'config', '--show-scope', '--get-all', 'core.hooksPath');
    const own = scoped.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree\t'))
      .map((line) => line.slice('worktree\t'.length));

    if (own.some((dir) => dir !== hooks)) return { ok: true, data: null };
    const script = sessionHookScript(await defaultName(root));

    mkdirSync(hooks, { recursive: true });
    for (const name of SESSION_HOOK_NAMES) putHook(join(hooks, name), script);
    const shared = await git(root, 'config', '--type=bool', '--get', 'extensions.worktreeConfig');
    // The shared config is written only the first time: every launch after reads it.
    const steps = [
      ...(shared.stdout.trim() === 'true'
        ? []
        : [[root, 'config', 'extensions.worktreeConfig', 'true'] as const]),
      [path, 'config', '--worktree', 'core.hooksPath', hooks] as const,
    ];

    for (const [cwd, ...args] of steps) {
      const ran = await write(cwd, ...args);

      if (ran.exit !== 0)
        return failed('worktree-failed', `git ${args.join(' ')}: ${said(ran, 'git')}`);
    }

    return { ok: true, data: null };
  };

  return {
    onBranch: async (repo, branch, from, existing = false) => {
      const main = await mainCheckout(repo);

      if (!main.ok) return main;
      const root = main.data;
      const has = (b: string) => git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`);

      if (existing && (await has(branch)).exit !== 0)
        return failed('worktree-gone', `its worktree and branch ${branch} are gone`);
      // A new branch's origin fetched before the queue: a slow one holds up no other launch.
      const fetched = (await has(branch)).exit === 0 ? undefined : await fetchOrigin(root);

      return oneAtATime(root, async () => {
        await excludeScratch(root);
        const heldPath = (await listed(root)).find(
          (w) => w.branch === `refs/heads/${branch}`,
        )?.path;
        const path = worktreePath(root, branch);

        // One the person made elsewhere on the branch keeps its own hooks and config.
        if (heldPath !== undefined && heldPath !== path)
          return { ok: true, data: { path: heldPath, ours: false, setupMark: null } };
        let base: BranchBase | undefined;

        if (heldPath === undefined) {
          if (existsSync(path))
            return failed('worktree-taken', `${path} exists and is not on ${branch}`);
          if ((await has(branch)).exit === 0) {
            const added = await write(root, 'worktree', 'add', path, branch);

            if (added.exit !== 0)
              return failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);
          } else {
            const unfetched = fetched ?? (await fetchOrigin(root));

            base =
              from === undefined
                ? await branchBase(root, unfetched)
                : await givenBase(root, from, unfetched);
            if (base === undefined)
              return failed(
                'no-commit',
                from === undefined
                  ? `${root} has no commit to branch from`
                  : `${root} has none of ${from.join(', ')} to branch ${branch} from, fetched too`,
              );
            // No upstream: the branch is pushed to its own name later (`--set-upstream`).
            const added = await write(
              root,
              'worktree',
              'add',
              '--no-track',
              '-b',
              branch,
              path,
              base.commit,
            );

            if (added.exit !== 0)
              return failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);
          }
        }
        // Each launch, so a worktree made before #196 gets them too.
        const guarded = await guard(root, path);

        if (!guarded.ok) return guarded;

        return {
          ok: true,
          data: {
            path,
            ours: true,
            setupMark: await setupMark(path),
            ...(base === undefined ? {} : { base }),
          },
        };
      });
    },
    atMergeBase: async (repo, branch) => {
      const main = await mainCheckout(repo);

      if (!main.ok) return main;
      const root = main.data;

      // Against origin's default branch as it is now, not as the checkout last saw it (#198).
      const unfetched = await fetchOrigin(root);
      const found = await baseRef(root);

      if (found === undefined)
        return failed(
          'no-default-branch',
          `${root} has no default branch (${BRANCH_BASE_REFS.join(', ')})`,
        );
      const against = found.ref;
      const short = shortRef(against);
      const note = baseNote(unfetched, against);
      const stale = note === null ? {} : { note };
      const merged = await git(root, 'merge-base', `refs/heads/${branch}`, against);

      if (merged.exit !== 0)
        return failed(
          'no-merge-base',
          `${branch} and ${against}: ${said(merged, 'git merge-base')}`,
        );
      const base = merged.stdout.trim();

      return oneAtATime(root, async () => {
        await excludeScratch(root);
        const path = baseWorktreePath(root, branch);
        const ours = (await listed(root)).some((w) => w.path === path);

        if (ours) {
          const head = await git(path, 'rev-parse', 'HEAD');

          if (head.exit === 0 && head.stdout.trim() === base)
            return { ok: true, data: { path, base, against: short, ...stale } };
          // An earlier Before's edits go: Before runs on the merge base as it is.
          const moved = await git(path, 'checkout', '--quiet', '--force', '--detach', base);

          if (moved.exit !== 0)
            return failed('worktree-failed', `git checkout ${base}: ${said(moved, 'git')}`);
        } else {
          if (existsSync(path))
            return failed('worktree-taken', `${path} exists and is no worktree`);
          const added = await write(root, 'worktree', 'add', '--detach', path, base);

          if (added.exit !== 0)
            return failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);
        }
        // A session writes here too (#182): its pushes to the default branch refused as in its own.
        const guarded = await guard(root, path);

        return guarded.ok ? { ok: true, data: { path, base, against: short, ...stale } } : guarded;
      });
    },
    fromOrigin: async (repo, card) => {
      const main = await mainCheckout(repo);

      if (!main.ok) return main;
      const root = main.data;
      const unfetched = await fetchOrigin(root);

      if (unfetched === NO_ORIGIN) return failed('no-origin', `${root} has no origin remote`);
      const own = `refs/remotes/origin/card/${card}`;
      const refs = await git(
        root,
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)',
        'refs/remotes/origin/card/',
      );
      const ref = refs.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((r) => r === own || r.startsWith(`${own}-`));

      if (ref === undefined)
        return failed(
          'no-branch',
          `origin has no card/${card} branch: nothing pushed for it yet${unfetched === null ? '' : ` (${unfetched})`}`,
        );
      const branch = ref.slice('refs/remotes/origin/'.length);
      const tracked = `origin/${branch}`;

      return oneAtATime(root, async () => {
        const held = (await listed(root)).find((w) => w.branch === `refs/heads/${branch}`)?.path;

        if (held !== undefined) return { ok: true, data: { path: held, branch, made: false } };
        const path = worktreePath(root, branch);

        if (existsSync(path))
          return failed('worktree-taken', `${path} exists and is not on ${branch}`);
        const local = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);

        if (local.exit === 0) {
          const behind = await git(root, 'merge-base', '--is-ancestor', branch, tracked);

          if (behind.exit === 0) {
            const moved = await write(root, 'branch', '--force', branch, tracked);

            if (moved.exit !== 0)
              return failed('worktree-failed', `git branch --force: ${said(moved, 'git')}`);
          }
        }
        const added =
          local.exit === 0
            ? await write(root, 'worktree', 'add', path, branch)
            : await write(root, 'worktree', 'add', '--track', '-b', branch, path, tracked);

        if (added.exit !== 0)
          return failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);

        return { ok: true, data: { path, branch, made: true } };
      });
    },
  };
};
