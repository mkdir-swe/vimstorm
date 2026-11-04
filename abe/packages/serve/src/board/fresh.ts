/**
 * Fresh data in `serve` (#236, decision #352): `abe fresh` looks at once, `abe fresh --follow`
 * holds a checkout for as long as its connection stays (the Factory view while it is shown), and
 * every `FRESH_EVERY_MS` while one holds it. A look is one cheap changed-since read per outside
 * system: Azure DevOps' cards after the last look's newest change (`Board.changes`, only the
 * changed cards read), GitHub's pull requests changed last (`recentPrs`), the newest runs of the
 * pipelines provider in force (`Pipelines.runs`, GitHub Actions or Azure Pipelines). What changed
 * is an event, `board.changed` / `github.changed` / `pipelines.changed`; a quiet look says nothing.
 */
import {
  argsSchema,
  type Board,
  type BoardRef,
  changedSince,
  type Clock,
  commandRan,
  COMMANDS,
  EXIT,
  type EventType,
  FRESH_AGAIN_MS,
  FRESH_EVERY_MS,
  FRESH_PAGE,
  type FreshData,
  type Handlers,
  type Journal,
  parse,
  type Pipelines,
  type PipelineSource,
  PROTOCOL,
  refused,
  type Repo,
  runsMoved,
  type RunsSeen,
  type Seen,
  type Tracking,
  type WatchFrame,
} from '@abe/core';
import { type Answer } from '@abe/ports';

export type FreshOptions = {
  board: Board;
  tracking: Tracking;
  /** GitHub as your gh login at a checkout (`logins.gh`); none: `tracking`. */
  trackingAt?: (checkout: string) => Tracking;
  /** The board in force at a checkout (its merged `board` setting), none when it names none. */
  boardAt: (checkout: string) => BoardRef | undefined;
  /** The GitHub repo a checkout's origin names, none when it is not GitHub's. */
  repoAt: (checkout: string) => Promise<Repo | undefined>;
  /** GitHub Actions and Azure Pipelines; none: no runs looked at. */
  pipelines?: Pipelines;
  /** The Pipelines as your gh login and az folder at a checkout (ADR 0025); none: `pipelines`. */
  pipelinesAt?: (checkout: string) => Pipelines | undefined;
  /** Where a checkout's runs live by its `pipelines` setting, and their words; none: not known. */
  sourceAt: (checkout: string) => Promise<{ source: PipelineSource; text: string } | undefined>;
  emit: Journal['emit'];
  clock: Clock;
  /** How often a held checkout is looked at (default `FRESH_EVERY_MS`). */
  everyMs?: number;
};

export type Fresh = {
  /** A look now at the checkout's board and repo (one just answered: its answer). */
  look: (checkout: string) => Promise<FreshData>;
  /** Looked at once, then every `everyMs` until each hold is let go. */
  hold: (checkout: string) => () => void;
  stop: () => void;
};

const keyOf = (b: BoardRef) => JSON.stringify([b.organization, b.project, b.team, b.types]);

export const startFresh = (o: FreshOptions): Fresh => {
  const every = o.everyMs ?? FRESH_EVERY_MS;
  /** Each board's next `since` (Azure DevOps' clock), from its last look. */
  const boards = new Map<string, string>();
  /** Each repo's pull requests as last seen. */
  const repos = new Map<string, Seen>();
  /** Each pipelines source's newest runs as last seen. */
  const sources = new Map<string, RunsSeen>();
  /** Each checkout's look under way, and its last answer with when. */
  const looks = new Map<
    string,
    { running?: Promise<FreshData>; done?: { at: number; data: FreshData } }
  >();
  const holds = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();
  /**
   * One part's look after the one before it of the same board or repo (two checkouts of one):
   * each starts where the last ended, so a change is said once.
   */
  const queues = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, part: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(part);

    queues.set(
      key,
      next.catch(() => undefined),
    );

    return next;
  };

  const boardPart = async (b: BoardRef) => {
    const key = keyOf(b);
    const since = boards.get(key);
    const read = await o.board.changes(b, since ?? null);

    if (!read.ok) return { ok: false as const, message: read.error.message };
    // no time yet (a board with no cards): the next look is a first one again
    const at = read.data.at ?? since;

    if (at !== undefined) boards.set(key, at);
    const { cards, gone } = read.data;

    if (since !== undefined && (cards.length > 0 || gone.length > 0))
      o.emit('board.changed', {
        board: { organization: b.organization, project: b.project, team: b.team },
        cards,
        gone,
      });

    return {
      ok: true as const,
      first: since === undefined,
      data: { project: b.project, team: b.team, cards: cards.length, gone: gone.length },
    };
  };

  const githubPart = async (repo: Repo, checkout: string) => {
    const prs = await (o.trackingAt?.(checkout) ?? o.tracking).recentPrs(repo);

    if (!prs.ok) return { ok: false as const, message: prs.error.message };
    const was = repos.get(repo);
    const p = changedSince(was, prs.data, (x) => ({ key: String(x.number), at: x.updatedAt }));

    repos.set(repo, p.seen);
    if (p.changed.length > 0) o.emit('github.changed', { repo, prs: p.changed });

    return {
      ok: true as const,
      first: was === undefined,
      data: { repo, prs: p.changed.length },
    };
  };

  const pipelinesPart = async (p: Pipelines, at: { source: PipelineSource; text: string }) => {
    const key = JSON.stringify(at.source);
    const runs = await p.runs(at.source, FRESH_PAGE);

    if (!runs.ok) return { ok: false as const, message: runs.error.message };
    const was = sources.get(key);
    const moved = runsMoved(was, runs.data);

    sources.set(key, moved.seen);
    if (moved.changed.length > 0)
      o.emit('pipelines.changed', { source: at.text, runs: moved.changed });

    return {
      ok: true as const,
      first: was === undefined,
      data: { source: at.text, runs: moved.changed.length },
    };
  };

  const run = async (checkout: string): Promise<FreshData> => {
    const b = o.boardAt(checkout);
    const [repo, at] = await Promise.all([
      o.repoAt(checkout),
      o.pipelines === undefined ? undefined : o.sourceAt(checkout),
    ]);
    const p = o.pipelinesAt?.(checkout) ?? o.pipelines;
    const [board, github, pipelines] = await Promise.all([
      b === undefined ? undefined : inTurn(`board:${keyOf(b)}`, () => boardPart(b)),
      repo === undefined ? undefined : inTurn(`repo:${repo}`, () => githubPart(repo, checkout)),
      p === undefined || at === undefined
        ? undefined
        : inTurn(`runs:${JSON.stringify(at.source)}`, () => pipelinesPart(p, at)),
    ]);
    const failed = (
      part: FreshData['failed'][number]['part'],
      r: { ok: true } | { ok: false; message: string } | undefined,
    ) => (r?.ok === false ? [{ part, message: r.message }] : []);
    const firsts = [board, github, pipelines].flatMap((r) => (r?.ok === true ? [r.first] : []));

    return {
      board: board?.ok === true ? board.data : null,
      github: github?.ok === true ? github.data : null,
      pipelines: pipelines?.ok === true ? pipelines.data : null,
      failed: [
        ...failed('board', board),
        ...failed('github', github),
        ...failed('pipelines', pipelines),
      ],
      first: firsts.length > 0 && firsts.every(Boolean),
    };
  };

  /** `clocked`: the hold's clock, never within `FRESH_AGAIN_MS` of another (a short `every`). */
  const look = (checkout: string, clocked = false): Promise<FreshData> => {
    const held = looks.get(checkout) ?? {};

    if (held.running !== undefined) return held.running;
    if (!clocked && held.done !== undefined && o.clock.now() - held.done.at < FRESH_AGAIN_MS)
      return Promise.resolve(held.done.data);
    const running = (async () => {
      try {
        const data = await run(checkout);

        held.done = { at: o.clock.now(), data };

        return data;
      } finally {
        delete held.running;
      }
    })();

    held.running = running;
    looks.set(checkout, held);

    return running;
  };

  // a failed look is said by its answer (the next one tries again); the clock's go unheard
  const quietly = (checkout: string, clocked = false) => {
    look(checkout, clocked).catch(() => undefined);
  };

  return {
    look: (checkout) => look(checkout),
    hold: (checkout) => {
      const had = holds.get(checkout);

      // a look at once, also for a hold that comes before the last one went (a view shown again)
      quietly(checkout);
      if (had === undefined) {
        holds.set(checkout, {
          count: 1,
          timer: setInterval(() => {
            quietly(checkout, true);
          }, every),
        });
      } else had.count += 1;
      let released = false;

      return () => {
        const h = holds.get(checkout);

        if (released || h === undefined) return;
        released = true;
        h.count -= 1;
        if (h.count > 0) return;
        clearInterval(h.timer);
        holds.delete(checkout);
      };
    },
    stop: () => {
      for (const h of holds.values()) clearInterval(h.timer);
      holds.clear();
    },
  };
};

export type FreshCtx = {
  cwd: string;
  serve: {
    fresh: Fresh | undefined;
  };
};

/** The events a fresh look says: what `abe fresh --follow` prints. */
const FRESH_EVENTS = new Set<EventType>(['board.changed', 'github.changed', 'pipelines.changed']);

export const freshHandlers = () =>
  ({
    fresh: async (args, ctx) => {
      // `startServe` streams `--follow` before dispatch; a reply cannot carry a stream.
      if (args.follow)
        return refused('fresh-streams', 'abe fresh --follow is answered as a stream');
      if (ctx.serve.fresh === undefined)
        return refused('no-fresh', 'this abe serve looks at nothing outside');

      return { ok: true, data: await ctx.serve.fresh.look(ctx.cwd) };
    },
  }) satisfies Partial<Handlers<FreshCtx>>;

/**
 * The streamed answer to `abe fresh --follow` (#236), or `undefined` for any other request: the
 * checkout held while the connection stays, each `board.changed` / `github.changed` /
 * `pipelines.changed` sent as a
 * `watch` frame. `stopping` says the stream ends because `serve` does.
 */
export const freshAnswer = (
  fresh: Fresh | undefined,
  events: Journal,
  request: { argv: readonly string[]; cwd: string },
  stopping: () => boolean,
): Answer | undefined => {
  const parsed = parse(request.argv);

  if (!parsed.ok || parsed.id !== 'fresh' || parsed.global.help || fresh === undefined)
    return undefined;
  if (!argsSchema(COMMANDS.fresh.args).parse(parsed.args).follow) return undefined;

  return {
    stream: (out) => {
      const unwatch = events.watch(undefined, (event) => {
        if (!FRESH_EVENTS.has(event.type)) return;
        const frame: WatchFrame = { v: PROTOCOL, event };

        if (!out.send(JSON.stringify(frame))) throw new Error('the follower is gone');
      });
      const release = fresh.hold(request.cwd);

      out.onClose(() => {
        release();
        unwatch();
        if (!stopping()) commandRan(events, request.argv, out.cut() ? EXIT.failed : EXIT.ok);
      });
    },
  };
};
