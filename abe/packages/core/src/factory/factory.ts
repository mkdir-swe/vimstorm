/**
 * A run (spec #35, ADR 0008): one run per session carries its card through its workflow's steps
 * (Feature: create-specification → to-tickets → build → checks → review → verify → playbook
 * (gated) → pr → done). The session's own model moves it, with `abe factory stage-done | review | verify | judge |
 * needs-you` from inside the session; nothing outside the session moves it for it. Every move is
 * a row of a table here or a line of the run's workflow:
 *
 * - The workflow's steps in order: a finished step goes on to the next; its loops (`check:` over
 *   the facts it reported, or a `judge:`) send it back; a gate (`when:`) skips a step it does not
 *   hold for; an `ends:` ends the run after its step with that step's report.
 * - The pr stage is not done by the agent: `abe factory pr` opens the pull request, and its merge
 *   and the merge commit's deploy to test (`DEPLOYED`) move it to done (`factory-pr.ts`, #48).
 * - `CHECKS`: where checks' result goes (#46 runs them on entering `checks`). Checks that ran
 *   nothing (no check with a command in force, #159) go on to review like green ones, but the run
 *   keeps `noChecks`: its pull request says so on its Verified line and is never merged by serve.
 * - `reviewed`: a review round's findings (#47): none on, some back to build, the third round in a
 *   row with findings stops at Needs you.
 * - `VERIFIED`: a verification result by phase (#47): a bug's Before on the merge base (its
 *   reproduce step, or verify's own when it picks Before+after), then After.
 * - Needs you holds: while it is set the agent's `stage-done`, `review`, `verify` and `pr` are
 *   refused `needs-you`; only the person (`answered`) clears it.
 * - `stepContext`: what the step's subagent is given; a fresh one only the card, the spec, the diff
 *   and the findings carried to it.
 *
 * Where a run stands (running, needs you, queued, done) follows from the run and its session's
 * hook state (`runState`); the transcript is never read for it.
 */
import { z } from 'zod';
import { judgeKindOf } from './run-flow';
import { FeatureResult } from './verification-pack';
import {
  Clearing,
  datedWait,
  DONE_ENVIRONMENT,
  doneAtMerge,
  FactoryPrData,
  MERGED_IS_DONE,
  prData,
  prLine,
  type PrSeen,
  prWaitReason,
  RunPr,
} from './factory-pr';
import { checksFailures, hardReasons } from '../improve/hard-session';
import { RepoHere } from '../board/here';
import { type SessionState } from '../session/session';
import { PersonalOverride } from '../layer/settings/personal';
import { LaunchNote, noteLines, StandingNote } from './launch-note';
import { checkHolds, type FactValue } from '../skills/workflow/expr';
import { FRESH_MODES } from '../skills/workflow/kinds';
import { FEATURE_WORKFLOW, type RunLoop, RunWorkflow } from '../skills/workflow/run';
import { PlaybookKept } from './playbook';
import { RunBrief, StepSummary } from './run-brief';
import { ChecksKept } from './checks';
import { MadeCommit, MadeKept, type StepMade } from './step-made';
import { FindingAgain, ReviewFinding, ReviewRisk } from './review-findings';

export const STAGES = [
  // the spec before the work (create-specification)
  'spec',
  // a bug's Before on the merge base
  'reproduce',
  'build',
  'checks',
  'review',
  'verify',
  'pr',
  // #15: a plain step, any skill the run's workflow names that is no built-in (done → next).
  'step',
  'done',
] as const;
export type Stage = (typeof STAGES)[number];

/** A stage as a run written before 3.3 may hold it: decide and grill read as plain steps. */
const legacyStage = (v: unknown): unknown => (v === 'decide' || v === 'grill' ? 'step' : v);

/** A stage read from a run or a box's serve, either from before 3.3 or now. */
export const StageField = z.preprocess(legacyStage, z.enum(STAGES));

/**
 * Where `factory run --target` puts the session over `serve.target`: this Mac in Claude Code's
 * sandbox, or your environment. `local`, unsandboxed, is named only to be refused (ADR 0020 CC6).
 */
export const LAUNCH_TARGETS = ['local-sandbox', 'local', 'cloud'] as const;
export type LaunchTarget = (typeof LAUNCH_TARGETS)[number];

/** Queued is a cloud launch waiting for a box (#57); a local run is never queued. */
export const RUN_STATES = ['running', 'needs-you', 'queued', 'done'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Verification's two phases: Before on the merge base (a bug's reproduce step), then After. */
export const PHASES = ['before', 'after'] as const;
export type Phase = (typeof PHASES)[number];
/** A phase's result; `not-reproduced` is Before's only: the bug did not show on the merge base. */
export const RESULTS = ['pass', 'fail', 'not-reproduced'] as const;
export type VerifyResult = (typeof RESULTS)[number];

/** Review rounds with findings in a row before the run stops at Needs you. */
export const MAX_REVIEW_ROUNDS = 3;
export const NOT_CONVERGED = 'review did not converge';
export const NOT_REPRODUCED = 'the bug did not reproduce on the merge base';
export const BEFORE_FAILED = 'verification could not run on the merge base';

/**
 * How a person ends a run that cannot go on by itself (#184): done (a deploy that failed or never
 * comes, accepted), a bug that does not reproduce, or work given up. Always with a reason.
 */
export const ENDINGS = ['done', 'not-reproduced', 'abandoned'] as const;
export type Ending = (typeof ENDINGS)[number];

/**
 * How a run ended: carried to done (or ended done by a person), ended by a step's `ends:` with its
 * report, or ended by a person as not reproduced or abandoned.
 */
export const OUTCOMES = ['done', 'reported', 'not-reproduced', 'abandoned'] as const;

/** An outcome as a run written before 3.3 may hold it: a question answered was its report. */
const OutcomeField = z.preprocess((v) => (v === 'question' ? 'reported' : v), z.enum(OUTCOMES));

/** A person's end of a run (`abe factory end`): how, why, when, and the stage it was in. */
export const RunEnd = z.object({
  as: z.enum(ENDINGS),
  reason: z.string().min(1),
  at: z.iso.datetime(),
  from: StageField,
});
export type RunEnd = z.infer<typeof RunEnd>;

/** One finished stay in a stage. A rewind visits a stage again: a new visit. */
export const Visit = z.object({
  stage: StageField,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  /** The `--report` its `stage-done` named, as kept in the session's folder. */
  report: z.string().nullable(),
  /** A plain step's name in the run's workflow (#15); absent for a built-in step. */
  step: z.string().optional(),
  /** Its Step summary, once the pass after it ended wrote one. */
  summary: StepSummary.optional(),
});
export type Visit = z.infer<typeof Visit>;

/**
 * One `abe factory review`: its findings, the round it was (0 for none found), its report and the
 * regression tests it named (when it judged the work risky and no verify names them).
 */
export const Review = z.object({
  at: z.iso.datetime(),
  findings: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  report: z.string().nullable(),
  regression: z.array(z.string()).default([]),
  /** Its findings as its `--findings-file` gave them (file:line, what, fix, severity); empty: none given. */
  items: z.array(ReviewFinding).optional(),
  /** The earlier round's findings it looked at again: fixed or still open, by id. */
  earlier: z.array(FindingAgain).optional(),
  /** Its judgement of the change's risk; absent or null when its file gave none. */
  risk: ReviewRisk.nullable().optional(),
});
export type Review = z.infer<typeof Review>;

/** One `abe factory verify`: phase, result, report, the regression tests it named. */
export const Verification = z.object({
  at: z.iso.datetime(),
  phase: z.enum(PHASES),
  result: z.enum(RESULTS),
  report: z.string(),
  regression: z.array(z.string()),
  /** An After pass's verdict per mapped feature, from its report's `## Features`. */
  features: z.array(FeatureResult).optional(),
  /** Serve's sanitised copy of its HTML report (`verify-html.ts`), beside `report`. */
  html: z.string().optional(),
});
export type Verification = z.infer<typeof Verification>;

/**
 * A run's last move of its card on the board (`cardMoveOf`): the column, the state written, and
 * why it was not (a failed move never holds the run up).
 */
export const CardMove = z.object({
  // `new`: an abandoned run's card goes back for someone to pick up (#184).
  column: z.enum(['active', 'done', 'new']),
  state: z.string(),
  at: z.iso.datetime(),
  error: z.string().nullable(),
});
export type CardMove = z.infer<typeof CardMove>;

/** `prototype://demo-shop/4/v3`: a version in the org store (`prototypeAddress`). */
const STORE_URL = /^prototype:\/\/[^/\s]+\/[1-9][0-9]*\/v[1-9][0-9]*$/;

/**
 * Which prototype a run builds from, told apart by `kind`: a Make card version in the org store
 * (#82), or a developer's code prototype by its branch and short commit (#83).
 */
export const PrototypeRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('store'), url: z.string().regex(STORE_URL) }),
  z.object({
    kind: z.literal('code'),
    branch: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{7}$/),
  }),
]);
export type PrototypeRef = z.infer<typeof PrototypeRef>;

/** A run written before the kinds kept its store version as the bare `prototype://` link. */
const storeLinkOf = (value: unknown): unknown =>
  typeof value === 'string' && STORE_URL.test(value) ? { kind: 'store', url: value } : value;

/**
 * The prototype a run's card has in the org store (#82, #351; ADR 0023), from Make card or To the
 * Factory, copied into `dir` for every stage to read. A question, not a spec: Spec still runs.
 */
export const RunReference = z.object({
  /** A spec issue Make card opened before #351 (`o/shop#88`); none since. */
  spec: z.string().nullable().default(null),
  prototype: z.preprocess(storeLinkOf, PrototypeRef),
  dir: z.string(),
});
export type RunReference = z.infer<typeof RunReference>;

/**
 * What the person set up in the Launch box before a run starts: their Launch note and the
 * standing notes in force (#347), the workflow.
 */
export type LaunchSetup = {
  note?: LaunchNote | null;
  standing?: readonly StandingNote[];
  /** The workflow it runs, as the launch picked it (`--workflow`) or the card's `on:` did. */
  workflow?: RunWorkflow | undefined;
};

/**
 * What a judge decides: a loop going back, a step's `done_when:`, a step's gate (`when:`: run it
 * or skip it) or its `ends:` (end the run with its report).
 */
export const JUDGE_KINDS = ['loop', 'done', 'gate', 'ends'] as const;
export type JudgeKind = (typeof JUDGE_KINDS)[number];

/**
 * A `judge:` waiting on the step's own agent (#15): a loop's (its id) or the step's `done_when:`
 * (loop null), its question and what it sees.
 */
export const Judging = z.object({
  step: z.string(),
  loop: z.string().nullable(),
  /** What it decides; absent from a run before 3.3: a loop's, or the step's `done_when:` (loop null). */
  kind: z.enum(JUDGE_KINDS).optional(),
  question: z.string(),
  sees: z.array(z.string()),
  since: z.iso.datetime(),
  /** The report the step finished with, kept while the judge waits. */
  report: z.string().nullable().optional(),
});
export type Judging = z.infer<typeof Judging>;

export { judgeKindOf };

/** A judge answered: the question, yes or no, and the agent's reason. */
export const Judgement = Judging.omit({ since: true, report: true }).extend({
  at: z.iso.datetime(),
  answer: z.boolean(),
  reason: z.string(),
});
export type Judgement = z.infer<typeof Judgement>;

/** What a loop back carried: from which step to which, the facts and evidence named. */
export const Carried = z.object({
  loop: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(z.string()),
  facts: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
  at: z.iso.datetime(),
});
export type Carried = z.infer<typeof Carried>;

/**
 * A run ended by a step's `ends:`: the step, and its report the card got. `done`: its card moves
 * to Done (an investigation answered); a bug that did not reproduce stays where it is for a
 * person to decide.
 */
export const RunReported = z.object({
  step: z.string(),
  report: z.string().nullable(),
  at: z.iso.datetime(),
  done: z.boolean().default(true),
  /** The spike serve pushed with the report (`pushSpike`): its branch and commits; null: none. */
  spike: z
    .object({ branch: z.string(), commits: z.array(MadeCommit), pushed: z.boolean() })
    .nullable()
    .default(null),
});
export type RunReported = z.infer<typeof RunReported>;

/** A run's end as its Layers said at its start (`Run.pinned`, #9). */
export const RunPinned = z.object({ autoMerge: z.boolean(), done: z.string().min(1) });
export type RunPinned = z.infer<typeof RunPinned>;

export const Run = z.object({
  v: z.literal(1),
  session: z.string(),
  card: z.number().int().positive(),
  title: z.string(),
  repo: z.string(),
  worktree: z.string(),
  startedAt: z.iso.datetime(),
  stage: StageField,
  /** When the current stage began: time in stage. */
  since: z.iso.datetime(),
  visits: z.array(Visit),
  /**
   * Why the run waits on the person (the agent's `needs-you`, or a review or verification that
   * stopped), until the person answers.
   */
  needsYou: z
    .object({
      reason: z.string(),
      since: z.iso.datetime(),
      /** The answers the agent offered with it (`--option`), in order; absent: none (#213 B3). */
      options: z.array(z.string()).optional(),
    })
    .nullable(),
  outcome: OutcomeField.nullable(),
  /** The pull request `abe factory pr` opened, while the run is in pr or done after it. */
  pr: RunPr.nullable().default(null),
  /** Set when a Done run cleared (after the next local midnight): no longer in status. */
  cleared: Clearing.nullable().default(null),
  /** Review rounds with findings in a row; a clean review or a rewind to build sets it to 0. */
  round: z.number().int().nonnegative().default(0),
  /** Every review, in order. */
  reviews: z.array(Review).default([]),
  /** Every verification, in order. */
  verifications: z.array(Verification).default([]),
  /** Its card's last move on the board, once one was tried. */
  board: CardMove.nullable().default(null),
  /** The settings an Override set in its checkout when it launched (the hard-session rule). */
  overrides: z.array(z.string()).default([]),
  /** Of those, yours (#168): shown on Chat's header and the story's Session row. */
  personal: z.array(PersonalOverride).default([]),
  /** Its card's prototype (#82, #351): every stage reads it. */
  reference: RunReference.nullable().default(null),
  /**
   * A developer's prototype (#83): real code in a throwaway worktree. It starts in Build and stays
   * there (`PROTOTYPE_TAKES`): no checks, review or pull request.
   */
  prototype: z.boolean().default(false),
  /**
   * No check with a command is in force in its checkout (#159): set at launch from the settings,
   * then by each run of its checks (`none` sets it, a check with a command that ran clears it).
   */
  noChecks: z.boolean().default(false),
  /**
   * The spec issue and its slices the run's session opened (#200), as `<owner/repo>#<n>`: its pull
   * request closes them (`withClosesLine`), and triage never offers them as work.
   */
  specIssues: z.array(z.string()).default([]),
  /** How a person ended it (#184), when one did. */
  ended: RunEnd.nullable().default(null),
  /** Your Launch note (#347): Retry run carries it. */
  note: LaunchNote.nullable().default(null),
  /** The standing notes in force at launch, each with its Layer (#347). */
  standing: z.array(StandingNote).default([]),
  /**
   * Its workflow's steps and loops (#15), copied at launch: the built-in Feature for a run
   * written before workflows.
   */
  workflow: RunWorkflow.default(FEATURE_WORKFLOW),
  /**
   * What ends it, read once from its checkout's Layers as it starts (#9): auto merge and
   * `factory.done`. A later launch on its box (another card, another Layer handed) never changes
   * them. Null: a run from before, read live.
   */
  pinned: RunPinned.nullable().default(null),
  /** The step it is in, by its name in the workflow; null: the step of its stage (or done). */
  step: z.string().nullable().default(null),
  /** The facts its steps reported last (#15): what a loop's `check:` reads. */
  facts: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  /** Each loop's times in a row back (by its id); past its `max:` the run stops at Needs you. */
  looped: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** A `judge:` its step's agent is to answer (`abe factory judge`), while one waits. */
  judging: Judging.nullable().default(null),
  /** Every judge answered (#15): decision steps on the Run page. */
  judgements: z.array(Judgement).default([]),
  /** What the last loop back handed to the step it went back to. */
  carried: Carried.nullable().default(null),
  /** The Playbook its playbook step wrote, as serve read it; null: none written. */
  playbook: PlaybookKept.nullable().default(null),
  /** Its Run brief: written as its first step ends, again as its spec ends. */
  brief: RunBrief.optional(),
  /** Ended by a step's `ends:`: that step and its report, which the card got. */
  reported: RunReported.nullable().default(null),
  /** What its steps made, as their skills wrote it (`stage-done --made`): build's lanes, the tickets. */
  made: z.array(MadeKept).default([]),
  /** Every run of its checks (after build, or on demand), each result's output cut to its tail. */
  checks: z.array(ChecksKept).default([]),
});
export type Run = z.infer<typeof Run>;

export const newRun = ({
  at,
  ...o
}: {
  session: string;
  card: number;
  title: string;
  repo: string;
  worktree: string;
  at: string;
  overrides?: readonly string[];
  /** Your Overrides in force in its checkout at launch (#168). */
  personal?: readonly PersonalOverride[];
  reference?: RunReference | null;
  /** A developer's prototype (#83): in Build from the start. */
  prototype?: boolean;
  /** No check with a command in force in its checkout (#159). */
  noChecks?: boolean;
  /** Your Launch note and the standing notes at launch (#347). */
  note?: LaunchNote | null;
  standing?: readonly StandingNote[];
  /** Its workflow (#15): the card's, as the Layers' load check left it; default Feature. */
  workflow?: RunWorkflow;
  /** Its end as its Layers say at the start (#9); default none: read live. */
  pinned?: RunPinned | null;
}): Run => {
  const workflow = o.workflow ?? FEATURE_WORKFLOW;
  const firstAt = o.prototype === true ? workflow.steps.findIndex((s) => s.kind === 'build') : 0;
  const first = workflow.steps[Math.max(0, firstAt)];
  const run: Run = {
    v: 1,
    ...o,
    workflow,
    overrides: [...(o.overrides ?? [])],
    personal: [...(o.personal ?? [])],
    reference: o.reference ?? null,
    prototype: o.prototype ?? false,
    noChecks: o.noChecks ?? false,
    pinned: o.pinned ?? null,
    note: o.note ?? null,
    standing: [...(o.standing ?? [])],
    specIssues: [],
    startedAt: at,
    stage: first?.kind ?? 'build',
    step: first?.name ?? null,
    facts: {},
    looped: {},
    judging: null,
    judgements: [],
    carried: null,
    playbook: null,
    since: at,
    visits: [],
    needsYou: null,
    outcome: null,
    pr: null,
    cleared: null,
    round: 0,
    reviews: [],
    verifications: [],
    board: null,
    ended: null,
    reported: null,
    made: [],
    checks: [],
  };

  // A prototype sits in Build, never gated; any other run's first step is entered as every one.
  return run.prototype ? run : entered(run, at);
};

/** What moves a run: the agent's commands, checks' result (serve's), the person answering in Chat. */
export type Move =
  // `stage`: the step's name in the run's workflow, or its built-in kind; `facts` it reports (#15).
  | {
      type: 'stage-done';
      stage: string;
      report: string | null;
      facts?: Readonly<Record<string, FactValue>>;
      /** The playbook step's Playbook as serve read it (null: none); unset for any other step. */
      playbook?: PlaybookKept | null;
      /** What it made, as its `--made` file said (build's lanes, the tickets); unset: none given. */
      made?: StepMade;
    }
  // The step's own agent answers its `judge:` (#15, `abe factory judge`): a loop's, its done_when's,
  // its gate's or its ends'.
  | { type: 'judge'; answer: boolean; reason: string }
  // `none`: no check with a command ran (#159); on to review, the run marked `noChecks`.
  | { type: 'checks'; green: boolean; none?: boolean }
  | {
      type: 'review';
      findings: number;
      report: string | null;
      regression: readonly string[];
      /** Its `--findings-file`: the findings, the earlier ones looked at again, the risk. */
      items?: readonly ReviewFinding[];
      earlier?: readonly FindingAgain[];
      risk?: ReviewRisk | null;
    }
  // A run of its checks, after build or on demand (serve's): kept on the run, nothing moved.
  | { type: 'checks-ran'; kept: ChecksKept }
  // The spike serve pushed with a step's report (`pushSpike`): kept on what the run reported.
  | { type: 'spike'; spike: NonNullable<RunReported['spike']> }
  | {
      type: 'verify';
      phase: Phase;
      result: VerifyResult;
      report: string;
      regression: readonly string[];
      features?: readonly FeatureResult[];
      html?: string;
      /** Whether the session's browser ran during the run; unset when the session has none (#319). */
      browserRan?: boolean;
    }
  | { type: 'needs-you'; reason: string; browserRan?: boolean; options?: readonly string[] }
  | { type: 'answered' }
  // The pr stage (#48): serve's, once the agent hands the body to `abe factory pr`.
  | { type: 'pr-opened'; pr: RunPr }
  | { type: 'pr-seen'; pr: PrSeen }
  | { type: 'deployed'; state: NonNullable<RunPr['deploy']>['state']; url: string | null }
  | { type: 'cleared'; cleared: Clearing }
  // serve's move of the card on the board, written or not: it holds nothing up.
  | { type: 'card-moved'; board: CardMove }
  // A prototype run's end (#83): sent on or discarded, its session stopped.
  | { type: 'prototype-dropped'; cleared: Clearing }
  // An issue the run's session opened (#200): kept when it is the spec's (`isSpecIssue`).
  | { type: 'issue-made'; issue: MadeIssue }
  // A person ends it (#184, `abe factory end`), wherever it stands: done, never at Needs you.
  | { type: 'end'; as: Ending; reason: string };

/** An issue a run's session opened with `abe issue create`. */
export type MadeIssue = {
  repo: string;
  number: number;
  labels: readonly string[];
  parent: number | null;
};

/** The label core's create-specification skill gives a spec issue. */
export const SPEC_LABEL = 'spec';

/**
 * Whether an issue the run's session opened is its spec's (#200): labelled `spec` (the spec
 * issue), or a sub-issue of one it holds (its slices). Any other (a bug it found, in the spec or
 * while building) is not, and stays open.
 */
export const isSpecIssue = (run: Pick<Run, 'specIssues'>, issue: MadeIssue): boolean =>
  issue.labels.some((l) => l.toLowerCase() === SPEC_LABEL) ||
  (issue.parent !== null &&
    run.specIssues.some((r) => r.toLowerCase() === `${issue.repo}#${issue.parent}`.toLowerCase()));

export type Refusal = { ok: false; code: string; message: string };
export type Stepped = { ok: true; run: Run } | Refusal;

/** Stages the agent does not finish with `stage-done`, and what moves them instead. */
const NOT_DONE_BY_AGENT: Readonly<
  Partial<Record<Stage, { code: string; message: (run: Run) => string }>>
> = {
  reproduce: {
    code: 'reproduce-with-verify',
    message: () =>
      'reproducing ends with abe factory verify --phase before --result pass|not-reproduced|fail --report …',
  },
  checks: {
    code: 'checks-by-serve',
    message: () => 'checks are run for the session, not finished by it',
  },
  pr: {
    code: 'pr-by-serve',
    // What Done is comes with the pull request (`factory.done`, #184); before it, the default.
    message: (run) =>
      (run.pr?.done ?? DONE_ENVIRONMENT) === MERGED_IS_DONE
        ? "hand the body to abe factory pr: the run is done once its pull request is merged; a merge that never comes is the person's, or theirs to end the run (abe factory end)"
        : `hand the body to abe factory pr: the run is done once its pull request is merged and deployed to ${run.pr?.done ?? DONE_ENVIRONMENT}; a deploy that fails or never comes is the person's to re-run, or to end the run (abe factory end)`,
  },
  review: {
    code: 'review-with-review',
    message: () => 'a review round ends with abe factory review --findings <n>',
  },
  verify: {
    code: 'verify-with-verify',
    message: () => 'verification ends with abe factory verify --phase … --result … --report …',
  },
};

/** Where the merge commit's deploy to test sends the run: success is Done. */
export const DEPLOYED: Readonly<Record<'success', Stage>> = { success: 'done' };

/** Where a review round sends the run: the finished stage's next, back to build, or nowhere. */
export type Reviewed =
  { to: 'next' | 'build'; round: number } | { to: 'stay'; round: number; needsYou: string };

/**
 * A review round with `findings` after `round` rounds with findings in a row: none found goes on
 * (round 0); findings go back to build and count up, and the third in a row stays in review at
 * Needs you. Until the person answers that no review is taken (`step`); after, the count starts
 * again.
 */
export const reviewed = (findings: number, round: number): Reviewed => {
  if (findings === 0) return { to: 'next', round: 0 };
  const next = (round >= MAX_REVIEW_ROUNDS ? 0 : round) + 1;

  return next >= MAX_REVIEW_ROUNDS
    ? { to: 'stay', round: next, needsYou: NOT_CONVERGED }
    : { to: 'build', round: next };
};

/** What a verification result does: stays for After, on to the next stage, back to build. */
export type Verified =
  | { ok: true; to: 'after' | 'next' | 'build' }
  | { ok: true; to: 'stay'; needsYou: string }
  | Refusal;

/**
 * Each phase's result in verify. Before (when verify picks Before+after) reproduces on the merge
 * base: reproduced (`pass`) goes on to After in verify; one that does not reproduce, or cannot
 * run, stops at Needs you. After passes on to the next stage or fails back to build.
 */
export const VERIFIED: Readonly<Record<`${Phase} ${VerifyResult}`, Verified>> = {
  'before pass': { ok: true, to: 'after' },
  'before fail': { ok: true, to: 'stay', needsYou: BEFORE_FAILED },
  'before not-reproduced': { ok: true, to: 'stay', needsYou: NOT_REPRODUCED },
  'after pass': { ok: true, to: 'next' },
  'after fail': { ok: true, to: 'build' },
  'after not-reproduced': {
    ok: false,
    code: 'before-only',
    message: 'not-reproduced is a Before result; After passes or fails',
  },
};

/**
 * Whether a verification result ends verification for now, so the workspace's browser stops
 * (#66): every After, and a Before that leaves the run waiting on you; a Before that reproduced
 * goes on to After with the same browser.
 */
export const endsVerification = (phase: Phase, result: VerifyResult): boolean => {
  const v = VERIFIED[`${phase} ${result}`];

  return v.ok && v.to !== 'after';
};

/** Whether the latest Before reproduced the bug. */
export const beforePassed = (run: Run): boolean =>
  run.verifications.findLast((v) => v.phase === 'before')?.result === 'pass';

/**
 * The regression tests a pull request carries (#48): the last After pass's, else the last clean
 * review's (review judged the work risky, and no verify named them).
 */
export const regressionOf = (run: Run): string[] => {
  const after = run.verifications.findLast((v) => v.phase === 'after' && v.result === 'pass');

  return after !== undefined && after.regression.length > 0
    ? after.regression
    : (run.reviews.findLast((r) => r.findings === 0)?.regression ?? []);
};

/** Where checks' result sends the run: green on to review, red back to build with the output. */
export const CHECKS: Readonly<Record<'green' | 'red', Stage>> = { green: 'review', red: 'build' };

/**
 * A run whose checkout has no check with a command (#159), as its status says it: to the person
 * and to the agent, who reads it in `stage-done build`'s answer.
 */
export const NO_CHECKS_RUN =
  "no checks configured: nothing runs after build (give tests, types and lint a command in the repo's abe.yaml); run them yourself, the pull request says nothing was run and a person merges it";

/**
 * Where a run is in its workflow's steps (#15): a step's index, the steps' count for done. A run
 * written before workflows names its stage only: the step of that kind.
 */
type Pos = number;

const stepsOf = (run: Pick<Run, 'workflow'>) => run.workflow.steps;

const posOf = (run: Pick<Run, 'workflow' | 'stage' | 'step'>): Pos => {
  const steps = stepsOf(run);

  if (run.stage === 'done') return steps.length;
  const named = run.step === null ? -1 : steps.findIndex((s) => s.name === run.step);
  const i = named === -1 ? steps.findIndex((s) => s.kind === run.stage) : named;

  return i === -1 ? 0 : i;
};

const kindAt = (run: Pick<Run, 'workflow'>, i: Pos): Stage => stepsOf(run)[i]?.kind ?? 'done';

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });

/** Leaves the current step for step `to` at `at`; the same step is no move. */
const moveTo = (run: Run, to: Pos, at: string, report: string | null = null): Run => {
  if (to === posOf(run) && run.stage === kindAt(run, to)) return run;
  const stage = kindAt(run, to);
  const step = stepsOf(run)[to]?.name ?? null;
  const visit: Visit = { stage: run.stage, startedAt: run.since, endedAt: at, report };

  return {
    ...run,
    stage,
    step,
    since: at,
    visits:
      run.stage === 'done'
        ? run.visits
        : [
            ...run.visits,
            run.stage === 'step' && run.step !== null ? { ...visit, step: run.step } : visit,
          ],
  };
};

/** A judge answered, kept as a decision step on the Run page. */
const judged = (
  run: Run,
  j: Omit<Judging, 'since' | 'report'>,
  answer: boolean,
  reason: string,
  at: string,
): Run => ({
  ...run,
  judging: null,
  judgements: [...run.judgements, { ...j, at, answer, reason }],
});

/**
 * The step the run just entered, through its gate (`when:`): a check holding, or no gate, runs
 * it; a check not holding skips it (kept as a decision: "skipped"), on to the next; a judge waits
 * for its one yes/no call (`judging`, kind gate). A loop back to it (`looped`) always runs it: what
 * the loop carries is its work, so its gate is for its first pass only.
 */
const entered = (run: Run, at: string, looped = false): Run => {
  if (run.outcome !== null) return run;
  const i = posOf(run);
  const here = stepsOf(run)[i];
  const gate = here?.when ?? null;

  if (here === undefined || gate === null || looped) return run;
  if ('judge' in gate)
    return {
      ...run,
      judging: {
        step: here.name,
        loop: null,
        kind: 'gate',
        question: gate.judge,
        sees: gate.sees,
        since: at,
      },
    };
  const holds = checkHolds(gate.check, run.facts);
  const kept = judged(
    run,
    { step: here.name, loop: null, kind: 'gate', question: gate.check, sees: [] },
    holds,
    holds ? `${gate.check} holds` : `${gate.check} does not hold: skipped`,
    at,
  );

  return holds ? kept : skipped(kept, i, at);
};

/** A gated step skipped: on to the next, entered as every step is. */
const skipped = (run: Run, i: Pos, at: string): Run =>
  moveOn({ ...run, stage: kindAt(run, i), step: stepsOf(run)[i]?.name ?? null }, i + 1, at, null, {
    visit: false,
  });

/**
 * Moves the run to `to`, done (outcome done) when that is past its last step, and enters it
 * through its gate. `visit: false`: the step left was never worked (a gate skipped it).
 * `looped`: a loop took it there, past its gate.
 */
const moveOn = (
  run: Run,
  to: Pos,
  at: string,
  report: string | null = null,
  o: { visit?: boolean; looped?: boolean } = {},
): Run => {
  const moved =
    o.visit === false
      ? {
          ...run,
          stage: kindAt(run, to),
          step: stepsOf(run)[to]?.name ?? null,
          since: at,
        }
      : moveTo(run, to, at, report);
  const done = to >= stepsOf(run).length;

  return done
    ? { ...moved, outcome: 'done' }
    : entered({ ...moved, outcome: null }, at, o.looped === true);
};

/** The facts a step reported, over the run's: its own reported ones replaced. */
const withFacts = (run: Run, i: Pos, facts: Readonly<Record<string, FactValue>>): Run => {
  const own = new Set([...(stepsOf(run)[i]?.reports ?? []), ...Object.keys(facts)]);
  const kept = Object.fromEntries(Object.entries(run.facts).filter(([k]) => !own.has(k)));

  return { ...run, facts: { ...kept, ...facts } };
};

/** A loop past its `max:`: review's words as before workflows, any other's its own. */
const notConverged = (run: Run, loop: RunLoop): string =>
  kindAt(run, posOf(run)) === 'review'
    ? NOT_CONVERGED
    : `${loop.from} did not converge: back to ${loop.to} ${loop.max} times`;

/** The review rounds a run counts: its review step's first loop's (shown as `round`). */
const isReviewLoop = (run: Run, loop: RunLoop) =>
  stepsOf(run).find((s) => s.name === loop.from)?.kind === 'review';

/** A loop's step that did not run when the loop went back to it: no progress, so no round more. */
export const loopNotRun = (loop: Pick<RunLoop, 'from' | 'to'>): string =>
  `${loop.from} went back to ${loop.to}, but ${loop.to} did not run: stopped rather than loop again`;

/**
 * A loop fires (#15): back to its `to` and counted, or, past its `max:`, Needs you (the count
 * starts over once the person answered). From checks, which serve runs, it goes back to `to` and
 * waits there; any other step waits where it is. What it carries is handed to `to` alone, which
 * runs whatever its gate says (`entered`); a `to` the run is not in after all stops at Needs you
 * where the loop fired, never another round with nothing done.
 */
const fire = (run: Run, loop: RunLoop, at: string, report: string | null): Run => {
  const was = run.looped[loop.id] ?? 0;
  const count = (was > loop.max ? 0 : was) + 1;
  const counted = {
    ...run,
    looped: { ...run.looped, [loop.id]: count },
    ...(isReviewLoop(run, loop) ? { round: count } : {}),
  };
  const to = stepsOf(run).findIndex((s) => s.name === loop.to);
  const carried: Carried = {
    loop: loop.id,
    from: loop.from,
    to: loop.to,
    items: loop.carries,
    facts: Object.fromEntries(
      loop.carries.flatMap((c) => (c in run.facts ? [[c, run.facts[c] ?? '']] : [])),
    ),
    at,
  };

  if (count > loop.max) {
    const waits = { ...counted, needsYou: { reason: notConverged(run, loop), since: at } };

    return kindAt(run, posOf(run)) === 'checks' && to !== -1
      ? { ...moveOn(waits, to, at, report, { looped: true }), carried }
      : waits;
  }
  const back = to === -1 ? posOf(run) : to;
  const moved = moveOn(counted, back, at, report, { looped: true });

  return moved.outcome === null && posOf(moved) === back
    ? { ...moved, carried }
    : { ...counted, needsYou: { reason: loopNotRun(loop), since: at } };
};

/** The run ended by its step's `ends:`: past its last step, with that step's report for the card. */
const endWithReport = (run: Run, at: string, report: string | null): Run => {
  const here = stepsOf(run)[posOf(run)];

  return {
    ...moveTo(run, stepsOf(run).length, at, report),
    outcome: 'reported',
    judging: null,
    reported: {
      step: here?.name ?? run.stage,
      report,
      at,
      // a bug's Before that did not reproduce: its card stays for a person to decide
      done: here?.kind !== 'reproduce',
      spike: null,
    },
  };
};

/**
 * A step finished with its facts (#15): its loops in the workflow's order, the first whose `when:`
 * holds fires; a `judge:` waits for the step's agent (`judging`), then goes on from that loop with
 * its answer. None holds: each one's count is 0 again; then its `ends:` (none, or not holding: on
 * to the next step, the findings carried to this one spent).
 */
const afterStep = (
  run: Run,
  at: string,
  report: string | null,
  judgedLoop?: { loop: string; yes: boolean },
): Run => {
  const i = posOf(run);
  const here = stepsOf(run)[i];
  const name = here?.name;
  const loops = run.workflow.loops.filter((l) => l.from === name);
  const start = judgedLoop === undefined ? 0 : loops.findIndex((l) => l.id === judgedLoop.loop);
  let next = run;

  for (const loop of loops.slice(Math.max(0, start))) {
    const checked = 'check' in loop.when ? checkHolds(loop.when.check, next.facts) : undefined;
    const holds = judgedLoop?.loop === loop.id ? judgedLoop.yes : checked;

    if (holds === undefined && 'judge' in loop.when)
      return {
        ...next,
        judging: {
          step: name ?? '',
          loop: loop.id,
          kind: 'loop',
          question: loop.when.judge,
          sees: loop.when.sees,
          since: at,
          report,
        },
      };
    if (holds === true) return fire(next, loop, at, report);
    next = {
      ...next,
      looped: { ...next.looped, [loop.id]: 0 },
      ...(isReviewLoop(next, loop) ? { round: 0 } : {}),
    };
  }

  return afterLoops(next, at, report);
};

/** A step past its loops: its `ends:` (`endsAfter`), else on to the next step. */
const afterLoops = (run: Run, at: string, report: string | null): Run => {
  const i = posOf(run);
  const here = stepsOf(run)[i];
  const ends = here?.ends ?? null;
  const on = () => moveOn({ ...run, carried: null }, i + 1, at, report);

  if (here === undefined || ends === null) return on();
  if (ends.when === null) return endWithReport(run, at, report);
  if ('judge' in ends.when)
    return {
      ...run,
      judging: {
        step: here.name,
        loop: null,
        kind: 'ends',
        question: ends.when.judge,
        sees: ends.when.sees,
        since: at,
        report,
      },
    };

  return checkHolds(ends.when.check, run.facts) ? endWithReport(run, at, report) : on();
};

/** What the agent is told while a judge waits on it. */
export const judgeText = (j: Judging): string =>
  `${judgeKindOf(j) === 'gate' ? 'gate' : 'judge'}: ${j.question} (sees ${j.sees.join(', ')}): answer with abe factory judge --answer yes|no --reason <why>`;

const judgeFirst = (run: Run): Refusal | undefined =>
  run.judging === null ? undefined : refuse('judge-first', judgeText(run.judging));

/** Where the run is, in words: its plain step's name (`playbook`), else its stage. */
const whereText = (run: Run) => (run.stage === 'step' && run.step !== null ? run.step : run.stage);

/** A review or verify move's run: not done, in one of `stages`; else why not. */
const inStage = (run: Run, ...stages: readonly Stage[]): Refusal | undefined => {
  if (run.outcome !== null) return refuse('run-done', `AB#${run.card}'s run is done`);
  if (!stages.includes(run.stage))
    return refuse('not-this-stage', `the run is in ${whereText(run)}, not ${stages.join(' or ')}`);

  return undefined;
};

/** Why the agent's own move waits: the run needs the person first, or undefined. */
const waitsOnYou = (run: Run): Refusal | undefined =>
  run.needsYou === null
    ? undefined
    : refuse(
        'needs-you',
        `AB#${run.card}'s run waits on the person (${run.needsYou.reason}): it goes on once they answer in Chat`,
      );

/** A review round: on, back to build, or Needs you (`reviewed`). */
const review = (run: Run, move: Extract<Move, { type: 'review' }>, at: string): Stepped => {
  const not = inStage(run, 'review') ?? waitsOnYou(run) ?? judgeFirst(run);

  if (not !== undefined) return not;
  // #15: its findings are the facts its loops read (Feature's: findings → build, 3 rounds).
  const moved = afterStep(
    withFacts(run, posOf(run), {
      'review.findings': move.findings,
      'review.findings.high': move.findings,
    }),
    at,
    move.report,
  );

  return {
    ok: true,
    run: {
      ...moved,
      reviews: [
        ...run.reviews,
        {
          at,
          findings: move.findings,
          round: moved.round,
          report: move.report,
          regression: [...move.regression],
          items: [...(move.items ?? [])],
          earlier: [...(move.earlier ?? [])],
          risk: move.risk ?? null,
        },
      ],
    },
  };
};

/** What the agent is told when a bug does not reproduce outside its reproduce or verify step (#184). */
const NOT_REPRODUCED_EARLY =
  "not-reproduced outside reproduce and verify: say so with abe factory needs-you --reason 'not reproduced: <what you saw>'; the person ends the run (abe factory end <card> --as not-reproduced)";

/** The run with a verification kept, as `move` reports it. */
const withVerification = (run: Run, move: Extract<Move, { type: 'verify' }>, at: string): Run => ({
  ...run,
  verifications: [
    ...run.verifications,
    {
      at,
      phase: move.phase,
      result: move.result,
      report: move.report,
      regression: [...move.regression],
      ...(move.features === undefined ? {} : { features: [...move.features] }),
      ...(move.html === undefined ? {} : { html: move.html }),
    },
  ],
});

/** A not-reproduced's Needs you: inconclusive when the session's browser never ran (#319). */
const notReproducedReason = (move: Extract<Move, { type: 'verify' }>, reason: string) =>
  move.result === 'not-reproduced' && move.browserRan === false ? withoutBrowser(reason) : reason;

/**
 * A bug's Before in its reproduce step: reproduced (`pass`) reports `bug.reproduced` 1 and goes
 * on; not reproduced reports 0 and its `ends:` ends the run with the report (no
 * `ends:`, or the browser never ran: Needs you); one that cannot run stops at Needs you.
 */
const reproduced = (run: Run, move: Extract<Move, { type: 'verify' }>, at: string): Stepped => {
  if (move.phase !== 'before')
    return refuse(
      'before-only-here',
      'reproduce records Before on the merge base: --phase before; After is the verify step',
    );
  const kept = withVerification(run, move, at);
  const here = stepsOf(run)[posOf(run)];

  if (move.result === 'fail')
    return { ok: true, run: { ...kept, needsYou: { reason: BEFORE_FAILED, since: at } } };
  if (
    move.result === 'not-reproduced' &&
    ((here?.ends ?? null) === null || move.browserRan === false)
  )
    return {
      ok: true,
      run: { ...kept, needsYou: { reason: notReproducedReason(move, NOT_REPRODUCED), since: at } },
    };
  const facts = { 'bug.reproduced': move.result === 'pass' ? 1 : 0 };

  return { ok: true, run: afterStep(withFacts(kept, posOf(kept), facts), at, move.report) };
};

/** A verification result: a bug's Before in reproduce, else verify's phases (`VERIFIED`). */
const verify = (run: Run, move: Extract<Move, { type: 'verify' }>, at: string): Stepped => {
  if (
    move.result === 'not-reproduced' &&
    run.outcome === null &&
    run.stage !== 'verify' &&
    run.stage !== 'reproduce'
  )
    return refuse('not-this-stage', NOT_REPRODUCED_EARLY);
  const not = inStage(run, 'verify', 'reproduce') ?? waitsOnYou(run) ?? judgeFirst(run);

  if (not !== undefined) return not;
  if (run.stage === 'reproduce') return reproduced(run, move, at);
  const v = VERIFIED[`${move.phase} ${move.result}`];

  if (!v.ok) return refuse(v.code, v.message);
  const kept = withVerification(run, move, at);

  if (v.to === 'stay')
    return {
      ok: true,
      run: { ...kept, needsYou: { reason: notReproducedReason(move, v.needsYou), since: at } },
    };
  if (v.to === 'after') return { ok: true, run: kept };
  // #15: the After pass's result is the fact its loops read (Feature's: fail → build).
  const failed = { 'criteria.failed': move.result === 'fail' ? 1 : 0 };

  return { ok: true, run: afterStep(withFacts(kept, posOf(kept), failed), at, move.report) };
};

/**
 * Why `abe factory pr` cannot open the pull request now, or undefined: the run is in pr, its pull
 * request not merged, not waiting on the person.
 */
export const prRefusal = (run: Run): Refusal | undefined => {
  if (run.prototype) return neverShips(run);
  if (run.outcome !== null) return refuse('run-done', `AB#${run.card}'s run is done`);
  if (run.stage !== 'pr')
    return refuse('not-this-stage', `the run is in ${whereText(run)}, not pr`);
  if (run.pr?.state === 'merged') return refuse('pr-merged', `${run.pr.url} is merged already`);

  return waitsOnYou(run);
};

/** Why a prototype run refuses a move (#83): it never ships. */
export const PROTOTYPE_NEVER_SHIPS = 'prototype-never-ships';

/**
 * The moves a developer's prototype run takes (#83): the person's Needs you and its answer, the
 * board's note and its end. Everything that would move it on (`stage-done build`, checks, review,
 * verify, a pull request) is refused `prototype-never-ships`: it sits in Build.
 */
export const PROTOTYPE_TAKES: ReadonlySet<Move['type']> = new Set([
  'needs-you',
  'answered',
  'card-moved',
  'prototype-dropped',
]);

const neverShips = (run: Run): Refusal =>
  refuse(
    PROTOTYPE_NEVER_SHIPS,
    `AB#${run.card}'s prototype never ships: it stays in Build, with no checks, review or pull request; abe prototype make-card makes a card of it, built for real by its own run`,
  );

/**
 * The run with its pull request as now known; where the merge is Done (`factory.done: merged`,
 * #184) and it is merged, done: no deploy is waited for. Also when it was merged as it opened.
 */
const withPr = (run: Run, pr: RunPr, at: string): Stepped =>
  doneAtMerge(pr)
    ? {
        ok: true,
        run: { ...moveTo(run, stepsOf(run).length, at), pr, needsYou: null, outcome: 'done' },
      }
    : { ok: true, run: { ...run, pr } };

/** The steps the agent finishes with `stage-done` (#15: a plain step too). */
const BY_STAGE_DONE: ReadonlySet<Stage> = new Set(['spec', 'build', 'step']);

const isStage = (s: string): s is Stage => STAGES.some((x) => x === s);

/**
 * `stage-done <step>`: the step the run is in, named by its name in the workflow or its built-in
 * kind, finished with the facts it reports; its `done_when:` holding (a check) or asked (a judge);
 * then its loops and its `ends:`, else on (`afterStep`).
 */
const stageDone = (run: Run, move: Extract<Move, { type: 'stage-done' }>, at: string): Stepped => {
  if (run.outcome !== null) return refuse('run-done', `AB#${run.card}'s run is done`);
  const steps = stepsOf(run);
  const named = steps.find((s) => s.name === move.stage);
  const kind = named?.kind ?? (isStage(move.stage) ? move.stage : undefined);

  if (kind === undefined)
    return refuse(
      'not-this-stage',
      `${move.stage} is no step of this run's workflow (${steps.map((s) => s.name).join(', ')})`,
    );
  const not = NOT_DONE_BY_AGENT[kind];

  if (not !== undefined) return refuse(not.code, not.message(run));
  const i = posOf(run);
  const here = steps[i];
  const isHere = named === undefined ? kind === run.stage : here?.name === named.name;

  if (!isHere || here === undefined)
    return refuse('not-this-stage', `the run is in ${whereText(run)}, not ${move.stage}`);
  if (!BY_STAGE_DONE.has(kind))
    return refuse('not-this-stage', `${move.stage} is not finished with stage-done`);
  const waits = waitsOnYou(run) ?? judgeFirst(run);

  if (waits !== undefined) return waits;
  const facts = move.facts ?? {};
  const unknown = Object.keys(facts).filter((f) => !here.reports.includes(f));

  if (unknown.length > 0)
    return refuse(
      'unknown-fact',
      `${here.name} reports ${here.reports.length === 0 ? 'no facts' : here.reports.join(', ')}, not ${unknown.join(', ')}`,
    );
  const reported = withFacts(run, i, facts);
  const when = here.doneWhen;

  if (when !== null && 'check' in when && !checkHolds(when.check, reported.facts))
    return refuse(
      'not-done',
      `${here.name} is not done: its done_when (${when.check}) does not hold; report its facts with --fact name=value`,
    );
  const pb = move.playbook === undefined ? reported : { ...reported, playbook: move.playbook };
  const kept =
    move.made === undefined
      ? pb
      : { ...pb, made: [...pb.made, { step: here.name, at, made: move.made }] };

  if (when !== null && 'judge' in when)
    return {
      ok: true,
      run: {
        ...kept,
        judging: {
          step: here.name,
          loop: null,
          kind: 'done',
          question: when.judge,
          sees: when.sees,
          since: at,
          report: move.report,
        },
      },
    };

  return { ok: true, run: afterStep(kept, at, move.report) };
};

/**
 * The judge waiting on the run answered (#15), with its reason, kept as a decision: a loop's yes
 * fires it, no goes on to the next loop; a `done_when:`'s yes finishes the step, no keeps it
 * working; a gate's yes runs its step, no skips it; an `ends:`'s yes ends the run with the step's
 * report, no goes on.
 */
const judge = (run: Run, move: Extract<Move, { type: 'judge' }>, at: string): Stepped => {
  if (run.outcome !== null) return refuse('run-done', `AB#${run.card}'s run is done`);
  const j = run.judging;

  if (j === null)
    return refuse(
      'nothing-to-judge',
      `no judge waits on AB#${run.card}'s run in ${whereText(run)}`,
    );
  const reason = move.reason.trim();

  if (reason === '')
    return refuse('reason-required', 'a judge answers with a reason: --reason <why>');
  const kind = judgeKindOf(j);
  const kept = judged(
    run,
    { step: j.step, loop: j.loop, kind, question: j.question, sees: j.sees },
    move.answer,
    reason,
    at,
  );
  const report = j.report ?? null;

  switch (kind) {
    case 'gate':
      return { ok: true, run: move.answer ? kept : skipped(kept, posOf(kept), at) };
    case 'ends':
      return {
        ok: true,
        run: move.answer
          ? endWithReport(kept, at, report)
          : moveOn({ ...kept, carried: null }, posOf(kept) + 1, at, report),
      };
    case 'done':
      return { ok: true, run: move.answer ? afterStep(kept, at, report) : kept };
    case 'loop':
      return {
        ok: true,
        run: afterStep(kept, at, report, { loop: j.loop ?? '', yes: move.answer }),
      };
  }
};

/** What one move does to a run at `at` (RFC 3339), or why it is refused. */
export const step = (run: Run, move: Move, at: string): Stepped => {
  const done = run.outcome !== null;

  if (run.prototype && !PROTOTYPE_TAKES.has(move.type)) return neverShips(run);
  switch (move.type) {
    case 'stage-done':
      return stageDone(run, move, at);
    case 'judge':
      return judge(run, move, at);
    case 'checks': {
      if (run.stage !== 'checks')
        return refuse('not-this-stage', `the run is in ${whereText(run)}, not checks`);
      // #15: the result is the fact checks' loops read (Feature's: red → build).
      const red = !move.green && move.none !== true;
      const moved = afterStep(
        withFacts(run, posOf(run), { 'checks.failed': red ? 1 : 0 }),
        at,
        null,
      );

      if (move.none === true) return { ok: true, run: { ...moved, noChecks: true } };

      return { ok: true, run: red ? moved : { ...moved, noChecks: false } };
    }
    case 'review':
      return review(run, move, at);
    case 'verify':
      return verify(run, move, at);
    case 'needs-you':
      if (done) return refuse('run-done', `AB#${run.card}'s run is done`);

      return {
        ok: true,
        run: {
          ...run,
          needsYou: {
            reason:
              move.browserRan === false && NOT_REPRODUCED_SAID.test(move.reason)
                ? withoutBrowser(move.reason)
                : move.reason,
            since: at,
            ...(move.options === undefined || move.options.length === 0
              ? {}
              : { options: [...move.options] }),
          },
        },
      };
    case 'answered':
      return { ok: true, run: { ...run, needsYou: null } };
    case 'checks-ran':
      return { ok: true, run: { ...run, checks: [...run.checks, move.kept] } };
    case 'spike':
      return run.reported === null
        ? refuse('not-reported', `AB#${run.card}'s run reported nothing`)
        : { ok: true, run: { ...run, reported: { ...run.reported, spike: move.spike } } };
    case 'pr-opened': {
      const not = prRefusal(run);

      return not ?? withPr(run, datedWait(run.pr, move.pr, run.noChecks, at), at);
    }
    case 'pr-seen': {
      if (run.stage !== 'pr' || run.pr === null)
        return refuse('no-pr', `AB#${run.card}'s run has no pull request open`);

      return withPr(run, datedWait(run.pr, { ...run.pr, ...move.pr }, run.noChecks, at), at);
    }
    case 'deployed': {
      if (run.stage !== 'pr' || run.pr?.state !== 'merged')
        return refuse('not-merged', `AB#${run.card}'s pull request is not merged`);
      const pr = datedWait(
        run.pr,
        { ...run.pr, deploy: { state: move.state, url: move.url } },
        run.noChecks,
        at,
      );

      if (move.state !== 'success') return { ok: true, run: { ...run, pr } };

      return {
        ok: true,
        run: { ...moveTo(run, stepsOf(run).length, at), pr, needsYou: null, outcome: 'done' },
      };
    }
    case 'cleared':
      if (!done) return refuse('not-done', `AB#${run.card}'s run is not done`);

      return { ok: true, run: { ...run, cleared: move.cleared } };
    case 'card-moved':
      return { ok: true, run: { ...run, board: move.board } };
    case 'issue-made': {
      const ref = `${move.issue.repo}#${move.issue.number}`;

      return isSpecIssue(run, move.issue) && !run.specIssues.includes(ref)
        ? { ok: true, run: { ...run, specIssues: [...run.specIssues, ref] } }
        : { ok: true, run };
    }
    case 'prototype-dropped':
      if (!run.prototype) return refuse('not-a-prototype', `AB#${run.card}'s run is no prototype`);

      return { ok: true, run: { ...run, cleared: move.cleared } };
    case 'end': {
      if (done) return refuse('run-done', `AB#${run.card}'s run is done already`);
      const reason = move.reason.trim();

      if (reason === '')
        return refuse('reason-required', 'a run is ended with a reason: --reason <why>');

      return {
        ok: true,
        run: {
          ...moveTo(run, stepsOf(run).length, at),
          needsYou: null,
          judging: null,
          outcome: move.as === 'done' ? 'done' : move.as,
          ended: { as: move.as, reason, at, from: run.stage },
        },
      };
    }
  }
};

/**
 * What the step the run is in hands its subagent: its one main skill, and whether it starts
 * fresh (`fresh: always`, or `loop` when a loop carried findings back to it), given only the
 * card, the spec (a spec step before it), the diff (a build before it, or its own on a loop back)
 * and the findings carried to it. Not fresh, it also gets what the steps before it left.
 */
export const StepContext = z.object({
  step: z.string(),
  skill: z.string().nullable(),
  fresh: z.boolean(),
  /** What its subagent is given: `card`, `spec`, `diff`, `findings`, and `earlier` (not fresh). */
  gets: z.array(z.string()),
  /** The findings a loop back carried to this step; null: none. */
  carried: Carried.nullable(),
});
export type StepContext = z.infer<typeof StepContext>;

export const stepContext = (
  run: Pick<Run, 'workflow' | 'stage' | 'step' | 'carried' | 'outcome'>,
): StepContext | null => {
  if (run.outcome !== null || run.stage === 'done') return null;
  const steps = stepsOf(run);
  const i = posOf(run);
  const here = steps[i];

  if (here === undefined) return null;
  const carried = run.carried?.to === here.name ? run.carried : null;
  const fresh = here.fresh === 'always' || (here.fresh === 'loop' && carried !== null);
  const before = steps.slice(0, i);
  const diff =
    before.some((s) => s.kind === 'build') || (here.kind === 'build' && carried !== null);

  return {
    step: here.name,
    skill: here.skill,
    fresh,
    gets: [
      'card',
      ...(before.some((s) => s.kind === 'spec') ? ['spec'] : []),
      ...(diff ? ['diff'] : []),
      ...(carried === null ? [] : ['findings']),
      ...(fresh ? [] : ['earlier']),
    ],
    carried,
  };
};

/** The board column a run's outcome moves its card to (a report's: by `RunReported.done`). */
const OUTCOME_COLUMNS: Readonly<Record<NonNullable<Run['outcome']>, 'done' | 'new' | null>> = {
  done: 'done',
  // Ended with its report: an investigation is Done (`outcomeColumn`).
  reported: 'done',
  // A bug that does not reproduce leaves nothing to fix: Done, with the evidence in its report.
  'not-reproduced': 'done',
  // Work given up goes back for someone to pick up.
  abandoned: 'new',
};

/** The stages before the work: the card stays where it is until the run leaves them. */
const BEFORE_WORK: readonly Stage[] = ['spec'];

/**
 * Where a run's card goes as it launches: Active, unless it starts in its spec (the card moves
 * once the work starts, `cardMoveOf`).
 */
export const launchColumnOf = (run: Pick<Run, 'stage' | 'prototype'>): 'active' | null =>
  run.prototype || BEFORE_WORK.includes(run.stage) || run.stage === 'done' ? null : 'active';

/** Where an outcome moves the card: `OUTCOME_COLUMNS`', but a report that keeps it, nowhere. */
const outcomeColumn = (
  next: Pick<Run, 'outcome'> & { reported?: Run['reported'] },
): 'done' | 'new' | null => {
  if (next.outcome === null) return null;

  return next.outcome === 'reported' && next.reported?.done === false
    ? null
    : OUTCOME_COLUMNS[next.outcome];
};

/**
 * Where a step moves the run's card on the board (`BoardColumns`): `active` when it starts the
 * work (off its spec); at its outcome `OUTCOME_COLUMNS`' (Done when carried through, ended done
 * or not reproduced, or reported by an investigation; New when abandoned; a bug that did not
 * reproduce stays); else null.
 */
export const cardMoveOf = (
  was: Pick<Run, 'stage' | 'outcome'>,
  next: Pick<Run, 'stage' | 'outcome'> & { reported?: Run['reported'] },
): 'active' | 'done' | 'new' | null => {
  // Off its spec onto the work (build, or a workflow's plain step, #15).
  if (!BEFORE_WORK.includes(next.stage) && next.stage !== 'done' && BEFORE_WORK.includes(was.stage))
    return 'active';
  if (next.outcome !== null && was.outcome === null) return outcomeColumn(next);

  return null;
};

/** The words for a run waiting on the person because of its session. */
const SESSION_REASONS: Readonly<Record<SessionState, string | null>> = {
  // A session in your environment before its first hook: queued at the box limit, or starting.
  queued: null,
  starting: null,
  working: null,
  waiting: 'waiting on you in Chat',
  ended: 'its session ended',
};

/**
 * Where a run stands: done once it has an outcome; needs you when the agent said so; with its
 * pull request open, as that stands (`prWaitReason`); else needs you when its session waits on
 * you or ended first; else running. A run's turn ended with no step done and no Needs you said
 * still needs you (nothing else moves it on); a prototype's run never moves on, so its session's
 * own look says whether it waits on you (`waitsOnYou`) or idles at your turn.
 */
export const runState = (
  run: Run,
  session: SessionState | undefined,
): { state: RunState; reason: string | null } => {
  if (run.outcome !== null) return { state: 'done', reason: null };
  if (run.needsYou !== null) return { state: 'needs-you', reason: run.needsYou.reason };
  // Its pull request open, the run waits on GitHub or the person, not on its session.
  if (run.stage === 'pr' && run.pr !== null) {
    const waits = prWaitReason(run.pr, run.noChecks);

    return waits === null
      ? { state: 'running', reason: null }
      : { state: 'needs-you', reason: waits };
  }
  if (run.prototype && session === 'waiting') return { state: 'running', reason: null };
  const reason = SESSION_REASONS[session ?? 'ended'];

  return reason === null ? { state: 'running', reason: null } : { state: 'needs-you', reason };
};

/** A Needs you the agent wrote saying the bug does not reproduce (#184), in its own words. */
const NOT_REPRODUCED_SAID =
  /\b(not|never|cannot|can['’]t|doesn['’]t|does not|didn['’]t|did not|won['’]t)\s+(be\s+)?reproduc/i;

/** How a not-reproduced said with the session's browser never run starts (#319). */
export const INCONCLUSIVE = 'inconclusive, the browser never ran';

/**
 * A not-reproduced said while the session's browser never ran in the run (#319): no verdict, the
 * page was never looked at. The run waits on the person saying so, and how the agent gets one.
 */
export const withoutBrowser = (reason: string): string =>
  `${INCONCLUSIVE} (abe browser start): ${reason}`;

/**
 * Whether a run waits on the person because its bug does not reproduce: Before said so on the
 * merge base, or the agent did in its Needs you, with the session's browser run when it has one.
 * Its way out is `abe factory end --as not-reproduced` (the Board's End: can't reproduce).
 */
export const notReproduced = (r: Pick<FactoryRunData, 'state' | 'reason'>): boolean =>
  r.state === 'needs-you' &&
  r.reason !== null &&
  !r.reason.startsWith(INCONCLUSIVE) &&
  (r.reason === NOT_REPRODUCED || NOT_REPRODUCED_SAID.test(r.reason));

/**
 * The person's way out of a run that cannot go on by itself (#184), as `factory status` says it:
 * a failed deploy re-run or the run ended; a merged one waiting on a deploy that may never come;
 * a closed pull request; a bug that does not reproduce; its session ended. Null for a run that
 * goes on, or that the person moves on by answering in Chat.
 */
export const nextStepOf = (r: FactoryRunData): string | null => {
  if (r.state === 'done' || r.prototype) return null;
  const end = (as: string) => `abe factory end ${r.card} --as ${as} --reason <why>`;
  const pr = r.pr;

  if (pr?.state === 'merged')
    return pr.deploy === 'failure'
      ? `re-run the deploy and Done follows, or end the run: ${end('done|abandoned')}`
      : `waits for the deploy to ${pr.done ?? DONE_ENVIRONMENT}; none coming? set factory.done to merged for this repo, or ${end('done')}`;
  if (r.state !== 'needs-you') return null;
  if (pr?.state === 'closed')
    return `reopen the pull request, or end the run: ${end('abandoned|done')}`;
  if (notReproduced(r)) return `answer in Chat to go on, or end the run: ${end('not-reproduced')}`;
  if (r.reason === SESSION_REASONS.ended)
    return `reopen it (Reopen), or end the run: ${end('done|not-reproduced|abandoned')}`;

  return null;
};

/** Parses `--regression a,b`: names split on commas, blanks dropped, each once. */
export const namesOf = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r !== ''),
  ),
];

export const FactoryStageData = z.object({
  stage: StageField,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  report: z.string().nullable(),
  /** A plain step's name in the run's workflow; absent for a built-in step (its kind names it). */
  step: z.string().optional(),
  /** What it did and decided, with its Evidence; null until its pass wrote it. */
  summary: StepSummary.nullable().optional(),
});

/** What `abe factory` prints about one run. */
export const FactoryRunData = z.object({
  /** Its launch's answer only: its branch shared with another checkout (`SessionRecord`'s). */
  branchShared: z.string().optional(),
  card: z.number().int().positive(),
  title: z.string(),
  session: z.string(),
  repo: z.string(),
  worktree: z.string(),
  startedAt: z.iso.datetime(),
  stage: StageField,
  state: z.enum(RUN_STATES),
  /** When the current stage began. */
  since: z.iso.datetime(),
  /** Why it needs you; null unless it does. */
  reason: z.string().nullable(),
  /** When the agent, a review or a verification put it at Needs you (#187); null otherwise. */
  needsYouSince: z.iso.datetime().nullable().default(null),
  /** The answers the agent offered with its Needs you (`--option`, #213): empty, none or not waiting. */
  options: z.array(z.string()).default([]),
  outcome: OutcomeField.nullable(),
  /** Each finished stage, in order, with how long it took. */
  stages: z.array(FactoryStageData),
  /** Its pull request, once `abe factory pr` opened it. */
  pr: FactoryPrData.nullable(),
  /** Review rounds with findings in a row, and every review. */
  round: z.number().int().nonnegative(),
  reviews: z.array(Review),
  /** Every verification. */
  verifications: z.array(Verification),
  /** The regression tests the last After pass (or clean review) named, for the pull request. */
  regression: z.array(z.string()),
  /** Its card's last move on the board, or why it was not written. */
  board: CardMove.nullable(),
  /** Why it was a hard one (`hardReasons`): empty, it was not. */
  hard: z.array(z.string()).default([]),
  /** Its card's prototype (#82, #351): every stage's reference; null without. */
  reference: RunReference.nullable().default(null),
  /** A developer's prototype (#83): it sits in Build, its card's rail row saying `Prototype`. */
  prototype: z.boolean().default(false),
  /** No check with a command in force in its checkout (#159): its checks run nothing. */
  noChecks: z.boolean().default(false),
  /** How a person ended it (#184); null unless one did. */
  ended: RunEnd.nullable().default(null),
  /** Your Overrides in force in its checkout when it launched (#168). */
  personal: z.array(PersonalOverride).default([]),
  /** Your Launch note (#347); null without. Retry run launches with it again. */
  note: LaunchNote.nullable().default(null),
  /** The standing notes in force at launch, each with its Layer (#347). */
  standing: z.array(StandingNote).default([]),
  /** The step it is in by its workflow's name for it (#15); null: done, or a box's older serve. */
  step: z.string().nullable().default(null),
  /** Its workflow (#15): which, from which Layer, its steps in order; null from an older serve. */
  workflow: z
    .object({
      id: z.string(),
      /** Its `name:` (`Quick fix`); null from a run written before names. */
      name: z.string().nullable().default(null),
      layer: RunWorkflow.shape.layer,
      steps: z.array(
        z.object({
          name: z.string(),
          kind: StageField,
          /** Its one main skill; null: checks (or an older serve). */
          skill: z.string().nullable().default(null),
          fresh: z.enum(FRESH_MODES).default('never'),
          /** It has a gate (`when:`). */
          gated: z.boolean().default(false),
          /** It may end the run with its report (`ends:`). */
          ends: z.boolean().default(false),
        }),
      ),
      /** Its loops: from which step back to which, when, at most how often, what each carries. */
      loops: z
        .array(
          z.object({
            id: z.string(),
            from: z.string(),
            to: z.string(),
            /** `checks.failed > 0`, or the judge's question. */
            when: z.string(),
            max: z.number().int().positive(),
            carries: z.array(z.string()),
          }),
        )
        .optional(),
    })
    .nullable()
    .default(null),
  /** What the step it is in hands its subagent (`stepContext`); null: done, or an older serve. */
  context: StepContext.nullable().default(null),
  /** Ended by a step's `ends:`: the step and its report; null otherwise. */
  reported: RunReported.nullable().default(null),
  /** The judge waiting on its step's agent (#15), when one does. */
  judging: Judging.nullable().default(null),
  /** Every judge answered: decision steps (#15, #21). */
  judgements: z.array(Judgement).default([]),
  /** The Playbook its playbook step wrote; null: none (or an older serve). */
  playbook: PlaybookKept.nullable().default(null),
  /** Its Run brief; null before its first step's pass wrote one. */
  brief: RunBrief.nullable().default(null),
  /** What its steps made (`stage-done --made`): build's lanes, the tickets; absent: none kept. */
  made: z.array(MadeKept).optional(),
  /** Every run of its checks, each result's output cut to its tail; absent: none kept. */
  checks: z.array(ChecksKept).optional(),
});
export type FactoryRunData = z.infer<typeof FactoryRunData>;

export const FactoryStatusData = z.object({
  runs: z.array(FactoryRunData),
  /** The repo it was read in (#256): which of the runs are the shown repo's. */
  here: RepoHere.optional(),
});
export type FactoryStatusData = z.infer<typeof FactoryStatusData>;

/** `abe factory base-worktree`: a worktree at the merge base, for Before. */
export const FactoryBaseWorktreeData = z.object({
  path: z.string(),
  /** The merge base's commit. */
  base: z.string(),
  /** The card's branch and the default branch it was taken against. */
  branch: z.string(),
  against: z.string(),
  /** Why `against` may be stale: origin not reached at this call (#198). */
  note: z.string().optional(),
});
export type FactoryBaseWorktreeData = z.infer<typeof FactoryBaseWorktreeData>;

export const factoryBaseWorktreeText = (d: FactoryBaseWorktreeData): string =>
  `${d.path}\n  merge base ${d.base.slice(0, 12)} of ${d.branch} and ${d.against}\n${d.note === undefined ? '' : `  ${d.note}\n`}`;

/**
 * Where a run's review and verification reports are kept: the card's `.scratch/<card>/<kind>/` in
 * its worktree (`name` empty: the folder itself).
 */
export const reportPath = (
  worktree: string,
  card: number,
  kind: 'review' | 'verify',
  name: string,
): string =>
  `${worktree.replace(/\/+$/, '')}/.scratch/${card}/${kind}${name === '' ? '' : `/${name}`}`;

/** Since when it has needed you: the agent's Needs you, else its pull request's wait (#187). */
const needsYouSinceOf = (run: Run, state: RunState): string | null =>
  run.needsYou?.since ??
  (state === 'needs-you' && run.stage === 'pr' ? (run.pr?.waitSince ?? null) : null);

export const runData = (run: Run, session: SessionState | undefined): FactoryRunData => ({
  card: run.card,
  title: run.title,
  session: run.session,
  repo: run.repo,
  worktree: run.worktree,
  startedAt: run.startedAt,
  stage: run.stage,
  ...runState(run, session),
  since: run.since,
  needsYouSince: needsYouSinceOf(run, runState(run, session).state),
  options: (run.outcome === null ? run.needsYou?.options : undefined) ?? [],
  outcome: run.outcome,
  stages: run.visits.map((v) => ({
    ...v,
    durationMs: Math.max(0, Date.parse(v.endedAt) - Date.parse(v.startedAt)),
    summary: v.summary ?? null,
  })),
  pr: run.pr === null ? null : prData(run.pr),
  round: run.round,
  reviews: run.reviews,
  verifications: run.verifications,
  regression: regressionOf(run),
  board: run.board,
  reference: run.reference,
  prototype: run.prototype,
  noChecks: run.noChecks,
  ended: run.ended,
  personal: run.personal,
  note: run.note,
  standing: run.standing,
  step: run.stage === 'done' ? null : (stepsOf(run)[posOf(run)]?.name ?? null),
  workflow: {
    id: run.workflow.id,
    name: run.workflow.name ?? null,
    layer: run.workflow.layer,
    steps: run.workflow.steps.map((s) => ({
      name: s.name,
      kind: s.kind,
      skill: s.skill,
      fresh: s.fresh,
      gated: s.when !== null,
      ends: s.ends !== null,
    })),
    loops: run.workflow.loops.map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      when: 'check' in l.when ? l.when.check : l.when.judge,
      max: l.max,
      carries: [...l.carries],
    })),
  },
  context: stepContext(run),
  reported: run.reported,
  judging: run.judging,
  judgements: run.judgements,
  playbook: run.playbook,
  brief: run.brief ?? null,
  made: run.made,
  checks: run.checks,
  hard: hardReasons({
    reviewRounds: run.reviews.length,
    checksFailed: checksFailures(run.visits, run.stage),
    overrides: run.overrides,
    deployFailed: run.pr?.deploy?.state === 'failure',
  }),
});

/**
 * A run on a box that is not there yet (#67): its launch Queued on the Mac, or its box coming up.
 * It stands at its workflow's first step, as the box's run will (a Quick fix's Build, not Spec).
 */
export const pendingRunData = ({
  workflow,
  ...o
}: {
  session: string;
  card: number;
  title: string;
  repo: string;
  worktree: string;
  at: string;
  queued: boolean;
  /** The launch's workflow; none known: Feature's. */
  workflow?: RunWorkflow | null;
}): FactoryRunData => ({
  ...runData(
    newRun({ ...o, ...(workflow === null || workflow === undefined ? {} : { workflow }) }),
    'working',
  ),
  state: o.queued ? 'queued' : 'running',
});

const STATE_WORDS: Readonly<Record<RunState, string>> = {
  running: 'running',
  'needs-you': 'needs you',
  queued: 'queued',
  done: 'done',
};

/** `1h 2m`, `2m 5s`, `40s`. */
export const durationText = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;

  return `${s}s`;
};

/**
 * A verification in words (#320): Before passes when the bug shows on the merge base, so it says
 * so; "before pass" read as "no bug".
 */
const VERIFIED_WORDS: Readonly<Record<`${Phase} ${VerifyResult}`, string>> = {
  'before pass': 'before: bug reproduced',
  'before fail': 'before: could not run',
  'before not-reproduced': 'before: not reproduced',
  'after pass': 'after: pass',
  'after fail': 'after: fail',
  'after not-reproduced': 'after: not reproduced',
};

const reviewLines = (r: FactoryRunData) => {
  const last = r.reviews.at(-1);

  return [
    ...(last === undefined
      ? []
      : [
          `  reviewed  ${last.findings === 0 ? 'no findings' : `${last.findings} finding${last.findings === 1 ? '' : 's'}, round ${last.round} of ${MAX_REVIEW_ROUNDS}`}`,
        ]),
    ...(r.verifications.length === 0
      ? []
      : [
          `  verified  ${r.verifications.map((v) => VERIFIED_WORDS[`${v.phase} ${v.result}`]).join(' · ')}`,
        ]),
    ...(r.regression.length === 0 ? [] : [`  regression ${r.regression.join(', ')}`]),
  ];
};

/** Since when it stands as it does: Needs you from when it started needing you (#187). */
const sinceOf = (r: FactoryRunData) =>
  r.state === 'needs-you' && r.needsYouSince !== null ? r.needsYouSince : r.since;

/** The workflow it runs, always: its name, id and source, its steps (`?` a gated one). */
const workflowLines = (r: FactoryRunData) =>
  r.workflow === null
    ? []
    : [
        `  workflow  ${r.workflow.name === null || r.workflow.name === r.workflow.id ? '' : `${r.workflow.name} · `}${r.workflow.id} (${r.workflow.layer}): ${r.workflow.steps.map((s) => `${s.name}${s.gated ? '?' : ''}`).join(' → ')}`,
      ];

/** The step it is in: its main skill, and what its subagent gets (fresh or not). */
const contextLines = (r: FactoryRunData) => {
  const c = r.context;

  if (c === null || r.state === 'done') return [];
  const carried =
    c.carried === null ? '' : ` (carried from ${c.carried.from}: ${c.carried.items.join(', ')})`;

  return [
    `  step      ${c.step}${c.skill === null ? '' : ` · skill ${c.skill}`} · ${c.fresh ? 'fresh subagent' : 'subagent'} gets ${c.gets.join(', ')}${carried}`,
  ];
};

/**
 * Its state as the Board says it: one whose open pull request waits for a person's merge (its
 * checks not failed) is ready for review, not needs you.
 */
const stateWords = (r: FactoryRunData): string =>
  r.state === 'needs-you' &&
  r.pr?.state === 'open' &&
  r.pr.merge === 'person' &&
  r.pr.checks !== 'failure'
    ? READY_FOR_REVIEW
    : STATE_WORDS[r.state];

const READY_FOR_REVIEW = 'ready for review';

const runLines = (r: FactoryRunData) => [
  `AB#${r.card}  ${r.stage === 'step' && r.step !== null ? r.step : r.stage}${r.prototype ? ' (prototype)' : ''}  ${stateWords(r)} since ${sinceOf(r)}  ${r.session}`,
  `  ${r.title}`,
  ...(r.reason === null
    ? []
    : [`  ${stateWords(r) === READY_FOR_REVIEW ? READY_FOR_REVIEW : 'needs you'}: ${r.reason}`]),
  ...(r.options.length === 0
    ? []
    : [`  options:  ${r.options.map((o, i) => `${i + 1} ${o}`).join(' · ')}`]),
  ...(r.noChecks && !r.prototype ? [`  checks    ${NO_CHECKS_RUN}`] : []),
  ...workflowLines(r),
  ...contextLines(r),
  ...(r.judging === null ? [] : [`  ${judgeText(r.judging)}`]),
  ...noteLines(r.note, r.standing),
  ...(r.pr === null ? [] : [`  pr        ${prLine(r.pr)}`]),
  ...(r.outcome === null ? [] : [`  outcome   ${r.outcome}`]),
  ...(r.reported === null
    ? []
    : [
        `  reported  by ${r.reported.step}${r.reported.report === null ? '' : `: ${r.reported.report}`}`,
      ]),
  ...(r.ended === null
    ? []
    : [`  ended     ${r.ended.as} by a person in ${r.ended.from}: ${r.ended.reason}`]),
  ...(r.board === null ? [] : [`  board     ${cardMoveText(r.board)}`]),
  ...reviewLines(r),
  ...((next) => (next === null ? [] : [`  next      ${next}`]))(nextStepOf(r)),
  ...r.stages.map((s) => `  ${s.stage.padEnd(8)}  ${durationText(s.durationMs)}`),
];

const cardMoveText = (m: CardMove) =>
  m.error === null ? m.state : `not moved to ${m.state}: ${m.error}`;

/** The `factory.card` event's data: a run's card moved on the board, or why it was not. */
export const FactoryCardEvent = z.object({
  card: z.number().int().positive(),
  session: z.string(),
  column: CardMove.shape.column,
  state: z.string(),
  error: z.string().nullable(),
});
export type FactoryCardEvent = z.infer<typeof FactoryCardEvent>;

export const factoryCardText = (d: FactoryCardEvent): string =>
  `AB#${d.card} ${d.error === null ? `moved to ${d.state}` : `not moved to ${d.state}: ${d.error}`} (${d.column})`;

export const factoryRunText = (r: FactoryRunData): string => `${runLines(r).join('\n')}\n`;

export const factoryStatusText = (s: FactoryStatusData): string =>
  s.runs.length === 0
    ? 'no Factory runs\n'
    : `${s.runs.map((r) => runLines(r).join('\n')).join('\n\n')}\n`;

/** The `factory.stage` event's data: where a run is after a move or a change of state. */
export const FactoryStageEvent = z.object({
  card: z.number().int().positive(),
  session: z.string(),
  stage: StageField,
  /** The stage it left; null when only its state changed (or it just started). */
  from: StageField.nullable(),
  state: z.enum(RUN_STATES),
  /** Why it needs you; null unless it does. */
  reason: z.string().nullable().default(null),
  since: z.iso.datetime(),
  /**
   * `run`, `stage-done`, `judge`, `checks`, `review`, `verify`, `needs-you`, `pr` (opened),
   * `pr-seen`, `merged` (serve's own merge), `deployed`, `cleared`, or the session hook that
   * changed it.
   */
  cause: z.string(),
  outcome: OutcomeField.nullable(),
  /**
   * Its pull request as the move left it (#228), so a screen holding the run says what a full read
   * would (Ready for review, not the bare `needs-you`); absent from a box's older serve.
   */
  pr: FactoryPrData.nullable().optional(),
  /**
   * How a person ended it (#230), so a screen holding the run keeps an abandoned one on the stage
   * it was given up in, not Done; absent from a box's older serve.
   */
  ended: RunEnd.nullable().optional(),
  /**
   * The answers the agent offered with its Needs you (as `factory status` has them), so a screen
   * holding the run shows them, not the ones of an earlier wait; absent from a box's older serve.
   */
  options: z.array(z.string()).optional(),
});
export type FactoryStageEvent = z.infer<typeof FactoryStageEvent>;

/**
 * The `factory.stage` event a step from `was` to `next` sends, or null when it moved nothing a
 * client shows: its stage, its state (`runState`, with each one's session state) or its pull
 * request's state, checks, merge (auto or a person) or deploy (clients read the run on those). It carries the pull request
 * as `factory status` would say it (#228).
 */
export const stageEventOf = (
  was: Run,
  wasSession: SessionState | undefined,
  next: Run,
  nextSession: SessionState | undefined,
  cause: string,
): FactoryStageEvent | null => {
  const before = runState(was, wasSession).state;
  const now = runState(next, nextSession);
  const prMoved =
    was.pr?.state !== next.pr?.state ||
    was.pr?.checks !== next.pr?.checks ||
    was.pr?.autoMerge !== next.pr?.autoMerge ||
    was.pr?.deploy?.state !== next.pr?.deploy?.state;

  if (was.stage === next.stage && before === now.state && !prMoved) return null;

  return {
    card: next.card,
    session: next.session,
    stage: next.stage,
    from: was.stage === next.stage ? null : was.stage,
    state: now.state,
    reason: now.reason,
    since: next.since,
    cause,
    outcome: next.outcome,
    pr: next.pr === null ? null : prData(next.pr),
    ended: next.ended,
    options: (next.outcome === null ? next.needsYou?.options : undefined) ?? [],
  };
};

export const factoryStageText = (d: FactoryStageEvent): string =>
  `AB#${d.card} ${d.from === null ? d.stage : `${d.from} → ${d.stage}`} ${STATE_WORDS[d.state]} (${d.cause})`;
