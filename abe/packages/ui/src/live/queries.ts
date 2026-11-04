/**
 * The reads a screen asks kept (`run` with `keep`), as a host holds them for every screen it
 * mounts: the rule of a query cache, stale while it revalidates. A read is one query by its argv
 * in its folder (`queryKey`). Asked again (another workspace shown and back, the screen opened
 * anew), the last answer held of it comes at once, marked `cached`, while it is read anew. One
 * asked while the same read is out joins it, never a second read; it is read once more after
 * that one lands, so what changed since it went out is in, and the joiner is handed the first
 * landing as `cached` too. Only an ok answer is held: a failure goes to the ones waiting, the held
 * one stays (a refresh never blanks a page). The least recently asked past `QUERIES_KEPT` are let
 * go, never one out. A break forgets every held answer (they may be another serve's).
 *
 * Pure: `(queries, …) → { queries, … }`; `W` is the host's waiter (a screen and its read's id).
 */

/** A query's key: its argv in the folder it runs in. */
export type QueryKey = string;

export const queryKey = (argv: readonly string[], root: string | undefined): QueryKey =>
  JSON.stringify([root ?? null, ...argv]);

/** The queries held at most; the least recently asked go first. */
export const QUERIES_KEPT = 32;

type Query<A, W> = {
  /** The last ok answer. */
  held?: A | undefined;
  /** A read is out. */
  out: boolean;
  /** Who the read out answers. */
  waiting: readonly W[];
  /** Who asked after it went out: read once more for them once it lands. */
  next: readonly W[];
  /** When it was last asked, by the asks' count. */
  used: number;
};

export type Queries<A, W> = {
  readonly byKey: Readonly<Record<QueryKey, Query<A, W>>>;
  /** Asks so far: the clock `used` goes by. */
  readonly asks: number;
};

export const noQueries = <A, W>(): Queries<A, W> => ({ byKey: {}, asks: 0 });

/** Past `max`, the least recently asked of those not out let go. */
const trimmed = <A, W>(
  byKey: Readonly<Record<QueryKey, Query<A, W>>>,
  max: number,
): Record<QueryKey, Query<A, W>> => {
  const over = Object.keys(byKey).length - max;

  if (over <= 0) return byKey;
  const gone = new Set(
    Object.entries(byKey)
      .filter(([, q]) => !q.out)
      .sort(([, a], [, b]) => a.used - b.used)
      .slice(0, over)
      .map(([key]) => key),
  );

  return Object.fromEntries(Object.entries(byKey).filter(([key]) => !gone.has(key)));
};

/** The query `key` asked by `waiter` at `used`: a new read, one joined, or the held one read anew. */
const asked = <A, W>(was: Query<A, W> | undefined, waiter: W, used: number): Query<A, W> => {
  if (was === undefined) return { out: true, waiting: [waiter], next: [], used };
  if (was.out) return { ...was, next: [...was.next, waiter], used };

  return { ...was, out: true, waiting: [waiter], used };
};

/**
 * `waiter` asks `key`: the answer held of it (undefined: none yet), and whether the host reads it
 * now (`read`; false: it joined the read out).
 */
export const askQuery = <A, W>(
  q: Queries<A, W>,
  key: QueryKey,
  waiter: W,
  max = QUERIES_KEPT,
): { queries: Queries<A, W>; held: A | undefined; read: boolean } => {
  const asks = q.asks + 1;
  const was = q.byKey[key];

  return {
    queries: { asks, byKey: trimmed({ ...q.byKey, [key]: asked(was, waiter, asks) }, max) },
    held: was?.held,
    read: !(was?.out ?? false),
  };
};

/**
 * The read out of `key` answered: `held` the answer to hold (undefined: it failed, the held one
 * stays). Who it answers (`waiting`), who asked meanwhile and is handed it as held (`joined`, an ok
 * answer only), and whether it is read again for them (`again`).
 */
export const answerQuery = <A, W>(
  q: Queries<A, W>,
  key: QueryKey,
  held: A | undefined,
): {
  queries: Queries<A, W>;
  waiting: readonly W[];
  joined: readonly W[];
  again: boolean;
} => {
  const was = q.byKey[key];

  if (was === undefined) return { queries: q, waiting: [], joined: [], again: false };
  const again = was.next.length > 0;
  const now: Query<A, W> = {
    held: held ?? was.held,
    out: again,
    waiting: was.next,
    next: [],
    used: was.used,
  };

  return {
    queries: { ...q, byKey: { ...q.byKey, [key]: now } },
    waiting: was.waiting,
    // a failure is no answer to show while the next read is out: they keep what they hold
    joined: held === undefined ? [] : was.next,
    again,
  };
};

/** A break: every held answer forgotten (another serve's, maybe); the reads out stay out. */
export const forgetQueries = <A, W>(q: Queries<A, W>): Queries<A, W> => ({
  ...q,
  byKey: Object.fromEntries(
    Object.entries(q.byKey)
      .filter(([, x]) => x.out)
      .map(([key, x]) => [key, { ...x, held: undefined }]),
  ),
});
