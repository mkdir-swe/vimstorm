/** A checkout's `origin` remote, read with git on no config of the person's. */
import { githubRepoOf, type Repo } from '@abe/core';

/** What git prints in `dir`, trimmed, on no config of the person's; `undefined` when it fails. */
const gitText = async (dir: string, args: readonly string[]): Promise<string | undefined> => {
  const git = Bun.which('git', { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' });

  if (git === null) return undefined;
  const child = Bun.spawn([git, '-C', dir, ...args], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  return exit === 0 && stdout.trim() !== '' ? stdout.trim() : undefined;
};

/** The `origin` remote's URL of the checkout at `dir`, or `undefined` when it has none. */
export const originUrl = (dir: string): Promise<string | undefined> =>
  gitText(dir, ['remote', 'get-url', 'origin']);

/**
 * Whether origin had `branch` at the checkout's last fetch (`refs/remotes/origin/<branch>`): read
 * here, never asked of origin.
 */
export const originHadBranch = async (dir: string, branch: string): Promise<boolean> =>
  (await gitText(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])) !==
  undefined;

/**
 * Every checkout of the repo at `dir` (#256): its main checkout and its worktrees, as `git
 * worktree list` names them; none when `dir` is in no checkout.
 */
export const repoCheckouts = async (dir: string): Promise<string[]> => {
  const listed = await gitText(dir, ['worktree', 'list', '--porcelain']);

  return (listed ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
};

/** The GitHub repo the checkout's `origin` names; `undefined` when it has none or it is not GitHub's. */
export const originRepo = async (dir: string): Promise<Repo | undefined> => {
  const url = await originUrl(dir);

  return url === undefined ? undefined : githubRepoOf(url);
};

/** The branch checked out at `dir`; `undefined` when detached or not a checkout. */
export const currentBranch = (dir: string): Promise<string | undefined> =>
  gitText(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);

/** The checkout's default branch as origin's HEAD names it (`main`); `undefined` when not known. */
export const originHead = async (dir: string): Promise<string | undefined> => {
  const head = await gitText(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);

  return head?.replace(/^origin\//, '');
};

/**
 * The `origin` remote's URL as the checkout's config writes it, before any `insteadOf` rewrite:
 * which GitHub repo the checkout is, whatever mirror git fetches it from.
 */
export const originConfigUrl = (dir: string): Promise<string | undefined> =>
  gitText(dir, ['config', '--get', 'remote.origin.url']);

/**
 * The person's git user (`user.name`) in the checkout at `dir`, read with their own config (it is
 * theirs to name): who a Launch note is from (#347); `undefined` when git names none.
 */
export const gitUserName = async (dir: string): Promise<string | undefined> => {
  const git = Bun.which('git', { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' });

  if (git === null) return undefined;
  const child = Bun.spawn([git, '-C', dir, 'config', 'user.name'], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  return exit === 0 && stdout.trim() !== '' ? stdout.trim() : undefined;
};

/**
 * The `origin` remote's URL as a git config's text writes it (`[remote "origin"]`'s `url`), read
 * with no git: the settings read it as a file, so a change to it is seen like theirs.
 */
export const originOfGitConfig = (text: string | undefined): string | undefined => {
  let inOrigin = false;

  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();

    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const url = inOrigin ? /^url\s*=\s*(.+)$/.exec(line)?.[1] : undefined;

    if (url !== undefined) return url.trim().replace(/^"(.*)"$/, '$1');
  }

  return undefined;
};
