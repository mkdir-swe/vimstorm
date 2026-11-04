/**
 * A person's end of a Factory run (#184, `abe factory end <card> --as … --reason …`): a run that
 * cannot go on by itself (its deploy failed or never comes, its bug does not reproduce, its work
 * is given up) is ended with a reason. `step`'s `end` move carries it to done; this is what its
 * pull request is told (its card is not: `NOT_COMMENTED`), and the command's answer.
 */
import { z } from 'zod';
import { type Ending, ENDINGS, FactoryRunData, type RunEnd, type Verification } from './factory';

/** How an ending reads in words. */
export const ENDING_WORDS: Readonly<Record<Ending, string>> = {
  done: 'done',
  'not-reproduced': 'not reproduced',
  abandoned: 'abandoned',
};

/**
 * The most of Before's report the comment quotes. The worktree's copy goes with the worktree when
 * the ended run is swept, so the comment says it was cut rather than where the rest is.
 */
const MAX_QUOTE = 3_000;

/** Markdown quoted, one `>` per line. */
const quoted = (text: string) =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');

/** A report's path from its `.scratch/` on: where it is in the worktree. */
const inWorktree = (path: string) => {
  const at = path.indexOf('.scratch/');

  return at === -1 ? path : path.slice(at);
};

/**
 * The comment the run's pull request gets when a person ends the run: how, why, by
 * whom and in which stage, what it waited on, and for a bug that does not reproduce Before's
 * verdict with its report quoted (`report`, as read from the worktree; cut at `MAX_QUOTE`).
 */
export const runEndComment = (o: {
  card: number;
  session: string;
  ended: RunEnd;
  /** Why it waited on the person, as it stood when it was ended. */
  needsYou: string | null;
  verifications: readonly Verification[];
  report: string | null;
}): string => {
  const last = o.verifications.findLast((v) => v.phase === 'before');
  const cut = o.report !== null && o.report.length > MAX_QUOTE;
  const quote =
    o.report === null
      ? []
      : [
          '',
          quoted(cut ? o.report.slice(0, MAX_QUOTE) : o.report),
          ...(cut ? [`> …(cut at ${MAX_QUOTE.toLocaleString('en-US')} characters)`] : []),
        ];
  const evidence =
    o.ended.as === 'not-reproduced' && last?.result === 'not-reproduced'
      ? [
          '',
          `**Evidence:** Before on the merge base did not reproduce it (${inWorktree(last.report)})${quote.length === 0 ? '.' : ':'}`,
          ...quote,
        ]
      : [];

  return [
    `**Factory run ended: ${ENDING_WORDS[o.ended.as]}.** ${o.ended.reason}`,
    '',
    `Ended by a person in ${o.ended.from} (session ${o.session}, \`abe factory end\`).${o.needsYou === null ? '' : ` It waited on: ${o.needsYou}`}`,
    ...evidence,
  ].join('\n');
};

/** `abe factory end`: the run as it now stands, and what its pull request and session got. */
export const FactoryEndData = z.object({
  card: z.number().int().positive(),
  as: z.enum(ENDINGS),
  reason: z.string(),
  /** The card's comment: never written (`NOT_COMMENTED`); its move to its column follows. */
  comment: z.string(),
  /** The pull request's comment, or why not; null when the run opened none. */
  pr: z.string().nullable(),
  /** Its session: stopped, ended already, or why it was not stopped. */
  session: z.string(),
  run: FactoryRunData,
});
export type FactoryEndData = z.infer<typeof FactoryEndData>;

export const factoryEndText = (d: Omit<FactoryEndData, 'run'>): string =>
  `${[
    `AB#${d.card} ended: ${ENDING_WORDS[d.as]} · ${d.reason}`,
    `  card      ${d.comment}`,
    ...(d.pr === null ? [] : [`  pr        ${d.pr}`]),
    `  session   ${d.session}`,
  ].join('\n')}\n`;
