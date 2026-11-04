/**
 * Where the Factory overview lands when it is shown from the Editor (⌘⌥A, or a click
 * on the Editor's `Factory ◆ N`): on the run that has waited for you longest, its Chat holding
 * the keys; with none waiting, wherever you left it. Pure, a table in `landing.test.ts`.
 */
import type { FactoryRunData, SessionData } from '@abe/core';
import { clockSince, lookOf } from './flow';

/** A run waiting for you, and since when. */
export type Waiting = { card: number; title: string; session: string; since: string };

export type Landing =
  /** The oldest waiting run: its card selected, Chat on it with the keys. */
  | { to: 'run'; card: number; session: string }
  /** Nothing waits: the selection, the Board's tab and Chat as they were. */
  | { to: 'last' };

/**
 * The runs that need you (what the Flow header and `Factory ◆ N` count), oldest first; a tie by
 * card number.
 */
export const waitingRuns = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
): Waiting[] => {
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return runs
    .flatMap((run) => {
      const session = byId.get(run.session);

      return lookOf(run, session).counted === 'needs-you'
        ? [
            {
              card: run.card,
              title: run.title,
              session: run.session,
              since: clockSince(run, session),
            },
          ]
        : [];
    })
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.card - b.card);
};

/** The landing: the oldest waiting run, else the last selection. */
export const landing = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
): Landing => {
  const first = waitingRuns(runs, sessions)[0];

  return first === undefined
    ? { to: 'last' }
    : { to: 'run', card: first.card, session: first.session };
};
