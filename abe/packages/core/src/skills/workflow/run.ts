/**
 * The workflow a run carries (#15): its steps and loops as the load check left them, copied into
 * the run at launch so a later change to the file never moves a run already going. A run written
 * before workflows carries the built-in Feature's (`FEATURE_WORKFLOW`).
 */
import { z } from 'zod';
import { ENDS_THEN, FRESH_MODES, STEP_KINDS, WORKFLOW_LAYERS } from './kinds';

/** A condition as a run holds it: exactly one of a check or a judge. */
export const Condition = z.union([
  z.object({ check: z.string().min(1) }),
  z.object({ judge: z.string().min(1), sees: z.array(z.string()) }),
]);
export type Condition = z.infer<typeof Condition>;

/** A step's `ends:` as a run holds it: its condition (null: always) and what it ends with. */
export const RunEnds = z.object({
  when: Condition.nullable(),
  then: z.enum(ENDS_THEN),
});
export type RunEnds = z.infer<typeof RunEnds>;

/** A step kind a run written before 3.3 may hold: its decide and grill read as plain steps. */
const stepKind = z.preprocess(
  (v) => (v === 'decide' || v === 'grill' ? 'step' : v),
  z.enum(STEP_KINDS),
);

export const RunStep = z.object({
  name: z.string().min(1),
  kind: stepKind,
  /** Its one main skill; null for checks (serve runs them). */
  skill: z.string().nullable().default(null),
  /** How fresh its subagent starts. */
  fresh: z.enum(FRESH_MODES).default('never'),
  /** Its gate: it runs only when this holds (a check) or its yes/no call says yes (a judge). */
  when: Condition.nullable().default(null),
  /** Its way out of the run, with its report. */
  ends: RunEnds.nullable().default(null),
  /** The facts it reports (a built-in's own and its `reports:`). */
  reports: z.array(z.string()).default([]),
  doneWhen: Condition.nullable().default(null),
  /** A pr step's `into:`: the text fact naming the branch its pull request goes into; null: the default branch. */
  into: z.string().nullable().default(null),
});
export type RunStep = z.infer<typeof RunStep>;

export const RunLoop = z.object({
  /** Its number in the workflow (1, 2, …): the Map's arc, the run's count. */
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  when: Condition,
  carries: z.array(z.string()).default([]),
  max: z.number().int().positive(),
});
export type RunLoop = z.infer<typeof RunLoop>;

export const RunWorkflow = z.object({
  /** Its file's name (`feature` for `feature.yaml`). */
  id: z.string().min(1),
  /** Its `name:` (`Quick fix`); a run written before names carries none. */
  name: z.string().optional(),
  layer: z.enum(WORKFLOW_LAYERS),
  steps: z.array(RunStep).min(1),
  loops: z.array(RunLoop),
});
export type RunWorkflow = z.infer<typeof RunWorkflow>;

/** The review loop's limit in the built-in workflows: two rounds back to build, the third stops. */
export const FACTORY_REVIEW_MAX = 2;
/** Checks and verify going back to build before the run stops at Needs you. */
export const FACTORY_LOOP_MAX = 10;

/** The playbook gate's question in the built-in workflows. */
export const PLAYBOOK_GATE = 'Does the diff need manual steps after merge?';

const plain = {
  skill: null,
  fresh: 'never',
  when: null,
  ends: null,
  reports: [],
  doneWhen: null,
  into: null,
} as const satisfies Partial<RunStep>;

/**
 * The built-in Feature (`workflows/feature.yaml`) as a run carries it: the workflow a run written
 * before workflows ran, and the one a card runs when no workflow is in force.
 */
export const FEATURE_WORKFLOW: RunWorkflow = {
  id: 'feature',
  name: 'Feature',
  layer: 'built-in',
  steps: [
    {
      ...plain,
      name: 'create-specification',
      kind: 'spec',
      skill: 'create-specification',
      reports: ['spec.questions.open'],
    },
    { ...plain, name: 'to-tickets', kind: 'step', skill: 'to-tickets' },
    {
      ...plain,
      name: 'build',
      kind: 'build',
      skill: 'implement',
      fresh: 'loop',
      reports: ['checks.failed', 'checks.output'],
    },
    { ...plain, name: 'checks', kind: 'checks', reports: ['checks.failed', 'checks.output'] },
    {
      ...plain,
      name: 'review',
      kind: 'review',
      skill: 'code-review',
      fresh: 'always',
      reports: ['review.findings', 'review.findings.high'],
    },
    {
      ...plain,
      name: 'verify',
      kind: 'verify',
      skill: 'verify',
      fresh: 'always',
      reports: ['criteria.failed'],
    },
    {
      ...plain,
      name: 'playbook',
      kind: 'step',
      skill: 'playbook',
      when: { judge: PLAYBOOK_GATE, sees: ['diff'] },
    },
    {
      ...plain,
      name: 'pr',
      kind: 'pr',
      skill: 'pr',
      fresh: 'always',
      reports: ['pr.checks.failed', 'pr.comments.open'],
    },
  ],
  loops: [
    {
      id: '1',
      from: 'checks',
      to: 'build',
      when: { check: 'checks.failed > 0' },
      carries: ['checks.output'],
      max: FACTORY_LOOP_MAX,
    },
    {
      id: '2',
      from: 'review',
      to: 'build',
      when: { check: 'review.findings > 0' },
      carries: ['review.findings'],
      max: FACTORY_REVIEW_MAX,
    },
    {
      id: '3',
      from: 'verify',
      to: 'build',
      when: { check: 'criteria.failed > 0' },
      carries: ['criterion', 'evidence'],
      max: FACTORY_LOOP_MAX,
    },
  ],
};
