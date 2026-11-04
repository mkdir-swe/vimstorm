/**
 * `abe factory end <card> --as done|not-reproduced|abandoned --reason <why>` (#184): a person ends
 * a card's Factory run that cannot go on by itself. Core's `end` move carries it to done (its card
 * moved as every outcome moves it: Done, or New when abandoned); the run's pull request gets the
 * reason (a bug that does not reproduce: with Before's report as its evidence), the card no
 * comment (`NOT_COMMENTED`); its session is stopped. Never from inside a session: the agent says
 * Needs you, the person ends. A run on one of your boxes is ended there (#67); one still Queued
 * for a box is ended on the Mac, its placement cancelled (#234).
 */
import {
  cardMoveOf,
  type Ending,
  type FactoryEndData,
  type Outcome,
  parseCardId,
  parseRepo,
  refused,
  type Run,
  runData,
  runEndComment,
  isHere,
  type Handlers,
  NOT_COMMENTED,
} from '@abe/core';
import { type EndedHere } from '../box/cloud';
import { repoHere } from '../contract/here';
import { type Factory, type FactoryCtx, severalRuns } from './factory';

/** Before's report of a bug that did not reproduce, read from the worktree; null without. */
const beforeReport = async (f: Factory, run: Run): Promise<string | null> => {
  const last = run.verifications.findLast((v) => v.phase === 'before');

  if (last?.result !== 'not-reproduced' || run.worktree === '') return null;
  const read = await f.tree(run.card).report(run.worktree, last.report);

  return read.ok ? read.data : null;
};

/** The run's pull request's comment, or why not; null when it opened none. */
const commentPr = async (ctx: FactoryCtx, run: Run, text: string): Promise<string | null> => {
  if (run.pr === null) return null;
  const repo = parseRepo(run.pr.repo);

  if (repo === undefined) return `not commented: not a repo on GitHub: ${run.pr.repo}`;
  const made = await ctx.ports.tracking.issueComment({ repo, number: run.pr.number }, text);

  return made.ok ? `commented on ${run.pr.url}` : `not commented: ${made.error.message}`;
};

/** Its session stopped, unless it ended already; or why not. */
const stopSession = async (ctx: FactoryCtx, run: Run): Promise<string> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined || sessions.peek(run.session) === 'ended')
    return `${run.session} ended already`;
  const stopped = await sessions.stop(run.session);

  return stopped.ok
    ? `${run.session} stopped`
    : `${run.session} not stopped: ${stopped.error.message}`;
};

/** The run ended with `as` and `reason`, then its pull request and session told. */
const endRun = async (
  ctx: FactoryCtx,
  f: Factory,
  run: Run,
  as: Ending,
  reason: string,
): Promise<Outcome<FactoryEndData>> => {
  // What it waited on as it stood, before the end clears it: the comment says so.
  const waited = f.data(run).reason;
  const report = await beforeReport(f, run);
  const moved = await f.apply(run.session, { type: 'end', as, reason }, 'end');

  if (!moved.ok) return moved;
  const ended = moved.data.ended;

  if (ended === null) return refused('not-ended', `AB#${run.card}'s run did not end`);
  const text = runEndComment({
    card: run.card,
    session: run.session,
    ended,
    needsYou: waited,
    verifications: run.verifications,
    report,
  });
  const pr = await commentPr(ctx, run, text);
  const session = await stopSession(ctx, run);

  return {
    ok: true,
    data: {
      card: run.card,
      as,
      reason: ended.reason,
      comment: NOT_COMMENTED,
      pr,
      session,
      run: f.data(f.get(run.session) ?? moved.data),
    },
  };
};

/** A run ended on the Mac before any box had it (#234): its card moved, as every end's. */
const endedHere = async (ctx: FactoryCtx, here: EndedHere): Promise<Outcome<FactoryEndData>> => {
  const { run, session } = here;

  if (run.ended === null) return refused('not-ended', `AB#${run.card}'s run did not end`);
  // Its card to its outcome's column, as every end moves it (New when abandoned).
  const column = cardMoveOf({ stage: run.ended.from, outcome: null }, run);
  const board =
    column === null ? null : ((await ctx.serve.factory?.moveBoard(run, column, ctx.cwd)) ?? null);

  return {
    ok: true,
    data: {
      card: run.card,
      as: run.ended.as,
      reason: run.ended.reason,
      comment: NOT_COMMENTED,
      pr: null,
      session,
      run: runData({ ...run, board }, 'ended'),
    },
  };
};

export const endHandlers = () =>
  ({
    'factory end': async (args, ctx) => {
      const { factory } = ctx.serve;

      if (factory === undefined)
        return refused('no-sessions', 'this abe serve was started without a session runner');
      const card = parseCardId(args.card);

      if (card === undefined) return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);
      // only the card of the repo it is asked in: never another repo's of the same number (#256)
      const { here } = await repoHere(ctx.cwd);
      const runs = factory.all().filter((r) => r.card === card && isHere(here, r.repo));
      // An ended run not cleared yet never hides a newer one on a box.
      const open = runs.filter((r) => r.outcome === null);
      const several = severalRuns(open, card, here);

      if (several !== undefined) return several;
      const live = open.at(-1);

      if (live !== undefined) return endRun(ctx, factory, live, args.as, args.reason);
      // A run on one of your boxes: ended there (#67); one no box has yet (Queued): here (#234).
      const boxed = await ctx.serve.cloud?.end(card, args.as, args.reason, here);

      if (boxed?.on === 'box') return boxed.ended;
      if (boxed?.on === 'mac')
        return boxed.ended.ok ? endedHere(ctx, boxed.ended.data) : boxed.ended;
      const ended = runs.at(-1);

      return ended === undefined
        ? refused('no-run', `AB#${card} has no Factory run`)
        : refused('run-done', `AB#${card}'s run is done already`);
    },
  }) satisfies Partial<Handlers<FactoryCtx>>;
