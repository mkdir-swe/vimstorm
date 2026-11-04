/**
 * A repo moved or renamed on this Mac is known again by its id, never by guessing from its path.
 * serve mints the id once, the first time it meets a main checkout with `.abe/` (`REPO_ID_PATH`,
 * yours alone and out of git, ADR 0031), and keeps where each id was last seen. A main checkout
 * whose id was last seen at another folder, gone or holding another id now, is that repo moved:
 * serve follows it (its worktrees repaired, every record's path rewritten) and says so once.
 */
import { z } from 'zod';

/** The repo's id, in the main checkout: moves with the folder, never cloned. */
export const REPO_ID_PATH = '.abe/id';

/** An id as minted: 16 lower-case hex digits. */
export const RepoId = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * What a main checkout's id means as serve meets it at `at`: known there already, new (no id yet,
 * or one never seen: registered here), `moved` from the folder it was last seen at, or a `copy`
 * of a repo still there (a new id for this one: two folders never share one).
 */
export type Sighting =
  { kind: 'known' } | { kind: 'new' } | { kind: 'copy' } | { kind: 'moved'; from: string };

/**
 * The one rule: `seen` is where the id was last seen (none: never), `stillThere` whether that
 * folder holds the same id now.
 */
export const sighting = (o: {
  at: string;
  id: string | undefined;
  seen: string | undefined;
  stillThere: boolean;
}): Sighting => {
  if (o.id === undefined || o.seen === undefined) return { kind: 'new' };
  if (o.seen === o.at) return { kind: 'known' };

  return o.stillThere ? { kind: 'copy' } : { kind: 'moved', from: o.seen };
};

/**
 * `path` as it reads once the folder `from` moved to `to`: `from` itself or a path inside it moved,
 * anything else (a card worktree beside it, `<from>-wt/…`) as it was.
 */
export const rehomed = (path: string, from: string, to: string): string => {
  if (path === from) return to;

  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
};

/** What following a moved repo did, or why it could not be followed. */
export const RepoMoved = z.object({
  /** Where the repo was. */
  from: z.string(),
  /** Where it is now; null: not found (a worktree of it opened, the repo itself not yet). */
  to: z.string().nullable(),
  /** The folder it was met at: the repo, or one of its card worktrees. */
  seenAt: z.string(),
  /** Its install record followed it. */
  install: z.boolean(),
  sessions: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  /** Its card worktrees whose link to it git repaired. */
  worktrees: z.array(z.string()),
  /** What did not follow, each with why: said to the person, never dropped. */
  problems: z.array(z.string()),
});
export type RepoMoved = z.infer<typeof RepoMoved>;

const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The move as the person reads it: what followed, then what did not. */
export const repoMovedText = (m: RepoMoved): string => {
  if (m.to === null)
    return `${m.seenAt} belongs to ${m.from}, which is gone: open the repo where it is now and Abe repairs it`;
  const followed = [
    ...(m.install ? ['its install'] : []),
    ...(m.sessions > 0 ? [counted(m.sessions, 'session')] : []),
    ...(m.runs > 0 ? [counted(m.runs, 'run')] : []),
    ...(m.worktrees.length > 0 ? [counted(m.worktrees.length, 'worktree')] : []),
  ];
  const head = `${m.from} moved to ${m.to}${followed.length === 0 ? '' : `: ${followed.join(', ')} followed`}`;

  return m.problems.length === 0 ? head : `${head}; not followed: ${m.problems.join('; ')}`;
};
