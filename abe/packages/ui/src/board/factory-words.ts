/**
 * Core's Factory words that screens show (what Done is, how a run ends, a bug that does not
 * reproduce), redeclared here because ui reads only core's types.
 * `factory-words.test.ts` keeps them equal to core's.
 */
import type { Ending, FactoryRunData } from '@abe/core';

/** The environment whose deployment of the merge commit is Done, unless `factory.done` says another. */
export const DONE_ENVIRONMENT = 'test';

/** `factory.done`'s value for a repo with no deploy to wait for: the merge itself is Done. */
export const MERGED_IS_DONE = 'merged';

/** How a person ends a run that cannot go on by itself: done, not reproduced, or given up. */
export const ENDINGS: readonly Ending[] = ['done', 'not-reproduced', 'abandoned'];

const NOT_REPRODUCED = 'the bug did not reproduce on the merge base';

/** A Needs you the agent wrote saying the bug does not reproduce, in its own words. */
const NOT_REPRODUCED_SAID =
  /\b(not|never|cannot|can['’]t|doesn['’]t|does not|didn['’]t|did not|won['’]t)\s+(be\s+)?reproduc/i;

/** How a not-reproduced said with the session's browser never run starts: no verdict. */
const INCONCLUSIVE = 'inconclusive, the browser never ran';

/** Whether a run waits on the person because its bug does not reproduce (Before or the agent said so). */
export const notReproduced = (r: Pick<FactoryRunData, 'state' | 'reason'>): boolean =>
  r.state === 'needs-you' &&
  r.reason !== null &&
  !r.reason.startsWith(INCONCLUSIVE) &&
  (r.reason === NOT_REPRODUCED || NOT_REPRODUCED_SAID.test(r.reason));
