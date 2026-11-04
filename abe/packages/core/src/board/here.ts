/**
 * The repo a list was read in (#256), so a session, run or box is matched to a card by repo and
 * card, never by the card's number alone: two repos' boards may both have a #101.
 */
import { z } from 'zod';

/**
 * Where `session list` / `factory status` were read: the folder and the repo's other checkouts
 * (its main checkout and its worktrees: a local session's or run's `repo` is the one it was
 * launched from), and its GitHub repo (a cloud one's `repo`, a box's `abe:repo`), null when its
 * origin is not on GitHub.
 */
export const RepoHere = z.object({
  root: z.string(),
  checkouts: z.array(z.string()).default([]),
  github: z.string().nullable(),
});
export type RepoHere = z.infer<typeof RepoHere>;

const bare = (path: string) => path.replace(/\/+$/, '');

/**
 * Whether a session, run or box (its `repo`: a local one's checkout folder, a cloud one's
 * `owner/repo`) is the repo `here` names. Not known yet (no answer naming it): every one is. A box
 * with no `abe:repo` tag (`repo` null) is no repo's once it is known.
 */
export const isHere = (here: RepoHere | undefined, repo: string | null): boolean => {
  if (here === undefined) return true;
  if (repo === null) return false;

  return (
    (here.github !== null && repo.toLowerCase() === here.github.toLowerCase()) ||
    [here.root, ...here.checkouts].some((folder) => bare(folder) === bare(repo))
  );
};

/**
 * The repo an answer says it was read in, as a screen's state holds it, in place of what an
 * earlier answer said: none when it names none (read outside any checkout).
 */
export const hereOf = (data: { here?: RepoHere | undefined }): { here: RepoHere | undefined } => ({
  here: data.here,
});

/** Whether two sessions or runs are on the same repo's card (#256). */
export const sameCard = (
  a: { card: number | null; repo: string },
  b: { card: number | null; repo: string },
): boolean => a.card !== null && a.card === b.card && a.repo === b.repo;
