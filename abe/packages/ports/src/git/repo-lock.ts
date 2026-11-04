/**
 * Launches in one repository at once (#301): git takes a lock file for every write to the shared
 * `.git/config` (and its refs, `worktrees/`), and a second writer fails at once with `could not
 * lock config file .git/config: File exists` rather than wait. Within this process the steps that
 * make and guard a worktree run one repository at a time (`oneAtATime`); against a git outside it
 * (the person's own, another serve) a write that met a held lock is tried again (`retryLocked`).
 */
import { realpathSync } from 'node:fs';
import { type Ran } from '@abe/core';

const queues = new Map<string, Promise<unknown>>();
const fetches = new Map<string, Promise<string | null>>();

/** One key however the repository was reached (`/tmp` and `/private/tmp`, a symlink). */
const canonical = (repo: string): string => {
  try {
    return realpathSync(repo);
  } catch {
    return repo;
  }
};

/**
 * `fetch` of `repo`'s origin, or the one already under way there: launches at once fetch once,
 * outside the queue, so a slow origin never holds up the worktrees made after it.
 */
export const sharedFetch = (
  repo: string,
  fetch: () => Promise<string | null>,
): Promise<string | null> => {
  const key = canonical(repo);
  const going = fetches.get(key);

  if (going !== undefined) return going;
  const mine = fetch().finally(() => fetches.delete(key));

  fetches.set(key, mine);

  return mine;
};

/** `work` once every earlier `work` on `key` (a repository's main checkout) has settled. */
export const oneAtATime = <T>(repo: string, work: () => Promise<T>): Promise<T> => {
  const key = canonical(repo);
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );

  queues.set(key, settled);
  // The last one out leaves no entry behind.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });

  return mine;
};

/** git's words for a lock file another git holds. */
const LOCKED =
  /could not lock config file [^\n]*: File exists|Unable to create '[^']*\.lock': File exists/;

export const RETRY_LOCKED_MS = [50, 100, 200, 400, 800, 1600] as const;

/** `run` again while git says another git holds the lock it needs: about 3 s in all. */
export const retryLocked = async (
  run: () => Promise<Ran>,
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<Ran> => {
  let ran = await run();

  for (const ms of RETRY_LOCKED_MS) {
    if (ran.exit === 0 || !LOCKED.test(ran.stderr)) return ran;
    await wait(ms);
    ran = await run();
  }

  return ran;
};
