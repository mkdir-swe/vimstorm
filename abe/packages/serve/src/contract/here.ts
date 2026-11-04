/** The repo a request was made in: `session list` and `factory status` name it. */
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoFile, type RepoHere } from '@abe/core';
import { originRepo, realPath, repoCheckouts } from '@abe/ports';

/**
 * The request's folder, its repo's checkouts (main and worktrees) and the GitHub repo its
 * `origin` names (null: none, or not GitHub's), as an answer's `here`; nothing when the folder is
 * in no checkout (read there, every repo's sessions and runs are listed as before).
 */
export const repoHere = async (cwd: string): Promise<{ here?: RepoHere }> => {
  const [checkouts, github] = await Promise.all([
    repoCheckouts(cwd).catch(() => []),
    originRepo(cwd).catch(() => undefined),
  ]);

  return checkouts.length === 0 && github === undefined
    ? {}
    : { here: { root: cwd, checkouts, github: github ?? null } };
};

/**
 * A path as git and every read name it: `text` resolved against `cwd` with its symlinks
 * followed (macOS's /tmp is /private/tmp), so a session's or run's `repo` and a request's `here`
 * match whichever path named the checkout. Resolved once where a path comes in (a request's cwd,
 * a `--repo`, the app's folder, a script named by its path), never at a comparison. What is not
 * there yet keeps its name past the part that is.
 */
export const realPathAt = (cwd: string, text = '.'): string => realPath(resolve(cwd, text));

/**
 * The shown folder's checkout for `:`: the repo's main one (`.git` a folder) or a worktree
 * (`.git` a file), and whether the Factory install wrote its settings there; none: no repo top.
 */
export const checkoutAt = (root: string): { main: boolean; installed: boolean } | undefined => {
  const git = statSync(join(root, '.git'), { throwIfNoEntry: false });

  if (git === undefined) return undefined;

  return {
    main: git.isDirectory(),
    installed: statSync(repoFile(root), { throwIfNoEntry: false })?.isFile() === true,
  };
};
