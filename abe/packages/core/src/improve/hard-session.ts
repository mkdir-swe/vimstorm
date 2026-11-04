/**
 * The hard-session rule (ticket #87, spec #36 story 57): after a hard session the Factory
 * suggests a personal retro, quietly. A run was hard when it took three review rounds, its checks
 * failed twice, an Override was in force where it ran, or its deploy failed. The rule is a table
 * over the run's facts; what it changes is one dim line in that session's Chat header (`ui`).
 */

/** What a Factory run went through, as the rule reads it. */
export type HardFacts = {
  /** Reviews it had (`abe factory review`), each a round. */
  reviewRounds: number;
  /** Times its checks were red and sent it back to build. */
  checksFailed: number;
  /** The settings an Override set in its checkout when it launched. */
  overrides: readonly string[];
  /** Its pull request's deploy failed. */
  deployFailed: boolean;
};

/** Review rounds that make a run hard. */
export const HARD_REVIEW_ROUNDS = 3;
/** Red checks that make a run hard. */
export const HARD_CHECK_FAILURES = 2;

/** The rule, one row per way a run is hard: its words when it holds. */
export const HARD_RULES: readonly ((f: HardFacts) => string | undefined)[] = [
  (f) => (f.reviewRounds >= HARD_REVIEW_ROUNDS ? `${f.reviewRounds} review rounds` : undefined),
  (f) =>
    f.checksFailed >= HARD_CHECK_FAILURES ? `checks failed ${f.checksFailed} times` : undefined,
  (f) => (f.overrides.length > 0 ? `an Override (${f.overrides.join(', ')})` : undefined),
  (f) => (f.deployFailed ? 'a failed deploy' : undefined),
];

/** Why the run was hard, in the rule's order; empty: it was not. */
export const hardReasons = (f: HardFacts): string[] =>
  HARD_RULES.flatMap((rule) => {
    const why = rule(f);

    return why === undefined ? [] : [why];
  });

/**
 * Times the checks sent a run back: each checks visit whose next stay (or the stage it is in now)
 * is build.
 */
export const checksFailures = (visits: readonly { stage: string }[], stage: string): number =>
  visits.filter((v, i) => v.stage === 'checks' && (visits[i + 1]?.stage ?? stage) === 'build')
    .length;
