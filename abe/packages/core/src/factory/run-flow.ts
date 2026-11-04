/**
 * What the Run page reads of a run's workflow with no core code behind it
 * (`@abe/core/run-flow`, zod-free): what a judge decides, and Feature's steps as a run carries
 * them (a run from an older serve names none). `run-flow.test.ts` holds Feature's to the run's
 * `FEATURE_WORKFLOW`.
 */
import type { FactoryRunData, JudgeKind, Judging } from './factory';

/** What a judge decides (`Judging.kind`, or as a run before 3.3 said it). */
export const judgeKindOf = (j: Pick<Judging, 'kind' | 'loop'>): JudgeKind =>
  j.kind ?? (j.loop === null ? 'done' : 'loop');

/** A step of a run's workflow, as the run carries it. */
export type RunFlowStep = NonNullable<FactoryRunData['workflow']>['steps'][number];

/** Feature's steps (`workflows/feature.yaml`), as a run carries them. */
export const FEATURE_FLOW: readonly RunFlowStep[] = [
  {
    name: 'create-specification',
    kind: 'spec',
    skill: 'create-specification',
    fresh: 'never',
    gated: false,
    ends: false,
  },
  {
    name: 'to-tickets',
    kind: 'step',
    skill: 'to-tickets',
    fresh: 'never',
    gated: false,
    ends: false,
  },
  { name: 'build', kind: 'build', skill: 'implement', fresh: 'loop', gated: false, ends: false },
  { name: 'checks', kind: 'checks', skill: null, fresh: 'never', gated: false, ends: false },
  {
    name: 'review',
    kind: 'review',
    skill: 'code-review',
    fresh: 'always',
    gated: false,
    ends: false,
  },
  { name: 'verify', kind: 'verify', skill: 'verify', fresh: 'always', gated: false, ends: false },
  { name: 'playbook', kind: 'step', skill: 'playbook', fresh: 'never', gated: true, ends: false },
  { name: 'pr', kind: 'pr', skill: 'pr', fresh: 'always', gated: false, ends: false },
];
