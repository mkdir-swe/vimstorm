/**
 * Fresh data (#236, decision #352): one rule for all outside data, run by `serve`. A cheap
 * changed-since look every `FRESH_EVERY_MS` while a view holds `abe fresh --follow`, and at once
 * on `abe fresh` (the window focused, a view opened): Azure DevOps' cards changed since the last
 * look's newest change, read by their ids, GitHub's pull requests changed since, and the runs of
 * the pipelines provider in force (GitHub Actions or Azure Pipelines) that moved. Each change is an
 * event (`board.changed`, `github.changed`, `pipelines.changed`); nothing is said while nothing
 * changed. No Service Hooks.
 */
import { z } from 'zod';
import { PipelineRun } from './pipelines';

/** How often `serve` looks while a view holds it (#236): every 2 min. */
export const FRESH_EVERY_MS = 2 * 60_000;

/** A look asked this soon after one answered gets that one's answer (focus and open together). */
export const FRESH_AGAIN_MS = 5_000;

/**
 * Where a look at a list ordered by change stopped (#236): the newest change seen, and the items
 * changed at that very moment (GitHub's times are to the second, so two can share one).
 */
export type Seen = { since: string; keys: readonly string[] };

/**
 * The items of a list newer than `seen` and where the next look starts. The first look (`seen`
 * undefined) changes nothing: it only finds where to start; at an empty list, before anything
 * (never this machine's clock: the outside system's times are its own).
 */
export const changedSince = <T>(
  seen: Seen | undefined,
  items: readonly T[],
  of: (item: T) => { key: string; at: string },
): { seen: Seen; changed: T[] } => {
  const newest = items.reduce<string | undefined>((max, item) => {
    const { at } = of(item);

    return max === undefined || at > max ? at : max;
  }, undefined);
  const keysAt = (at: string) => items.filter((i) => of(i).at === at).map((i) => of(i).key);

  if (seen === undefined)
    return {
      seen:
        newest === undefined ? { since: '', keys: [] } : { since: newest, keys: keysAt(newest) },
      changed: [],
    };
  const changed = items.filter((item) => {
    const { key, at } = of(item);

    return at > seen.since || (at === seen.since && !seen.keys.includes(key));
  });

  if (newest === undefined || newest < seen.since) return { seen, changed };

  return {
    seen: {
      since: newest,
      keys:
        newest === seen.since ? [...new Set([...seen.keys, ...keysAt(newest)])] : keysAt(newest),
    },
    changed,
  };
};

/** Where a run stands, as far as a look can tell it moved: run again, a status, finished. */
const runMark = (r: PipelineRun) => `${r.attempt}:${r.status}:${r.finishedAt ?? ''}`;

/** Each run of the last look by its id, and where it stood then. */
export type RunsSeen = ReadonlyMap<string, string>;

/**
 * The runs of the newest page that are new or moved since `seen`, and what the next look compares
 * with. The first look (`seen` undefined) changes nothing: it only finds where to start.
 */
export const runsMoved = (
  seen: RunsSeen | undefined,
  runs: readonly PipelineRun[],
): { seen: RunsSeen; changed: PipelineRun[] } => {
  const next = new Map(runs.map((r) => [r.id, runMark(r)]));

  return {
    seen: next,
    changed: seen === undefined ? [] : runs.filter((r) => seen.get(r.id) !== runMark(r)),
  };
};

/**
 * `pipelines.changed` (#236): runs that started or moved on since the last look, from the
 * provider in force (`source`: `owner/name`, or `<org>/<project>` on Azure Pipelines).
 */
export const PipelinesChangedEvent = z.object({
  source: z.string(),
  runs: z.array(PipelineRun),
});
export type PipelinesChangedEvent = z.infer<typeof PipelinesChangedEvent>;

export const pipelinesChangedText = (d: PipelinesChangedEvent): string =>
  `${d.source}: ${d.runs.map((r) => `${r.pipeline} on ${r.branch} ${r.status}`).join(', ')}`;

/** `abe fresh`: what the look found, by part; a part not here (no board, no GitHub origin) is null. */
export const FreshData = z.object({
  board: z
    .object({
      project: z.string(),
      team: z.string(),
      cards: z.number().int().nonnegative(),
      gone: z.number().int().nonnegative(),
    })
    .nullable(),
  github: z.object({ repo: z.string(), prs: z.number().int().nonnegative() }).nullable(),
  /** The runs of the pipelines provider in force (`pipelines` setting). */
  pipelines: z.object({ source: z.string(), runs: z.number().int().nonnegative() }).nullable(),
  /** A part that could not be read, and why: the next look tries again. */
  failed: z.array(
    z.object({ part: z.enum(['board', 'github', 'pipelines']), message: z.string() }),
  ),
  /** The first look here: it only found where the next one starts. */
  first: z.boolean(),
});
export type FreshData = z.infer<typeof FreshData>;

const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

export const freshText = (d: FreshData): string => {
  const parts = [
    ...(d.board === null
      ? []
      : [
          `${d.board.project} / ${d.board.team}: ${many(d.board.cards, 'card')} changed${d.board.gone === 0 ? '' : `, ${many(d.board.gone, 'other')} not on the board`}`,
        ]),
    ...(d.github === null
      ? []
      : [`${d.github.repo}: ${many(d.github.prs, 'pull request')} changed`]),
    ...(d.pipelines === null
      ? []
      : [`${d.pipelines.source}: ${many(d.pipelines.runs, 'run')} moved`]),
    ...d.failed.map((f) => `${f.part} not read: ${f.message}`),
  ];

  if (parts.length === 0)
    return 'nothing to look at here: no board, no GitHub origin and no pipelines\n';

  return `${d.first ? 'first look (where the next one starts) · ' : ''}${parts.join(' · ')}\n`;
};
