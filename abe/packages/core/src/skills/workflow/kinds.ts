/**
 * What a workflow's steps are made of (#15): the Layers a file can live in, the built-in steps
 * that keep their jumps in code, how fresh a step's subagent starts, what a gate sees, and the
 * facts steps report for `check:`, `done_when:`, gates and `ends:`.
 */
import { VENDORED_SKILLS } from '../../shipped';

/** The Layers a workflow or skill lives in, nearest first: the nearest of a name wins. */
export const WORKFLOW_LAYERS = ['yours', 'repo', 'built-in'] as const;
export type WorkflowLayer = (typeof WORKFLOW_LAYERS)[number];

/** How near a Layer is: 0 for yours, 2 for built-in. */
export const nearness = (layer: WorkflowLayer): number => WORKFLOW_LAYERS.indexOf(layer);

/**
 * A step's kind: one of the built-in steps (their jumps are code: the spec before the work, a
 * bug's Before, checks run by serve, review rounds, verify's phases, serve's pull request), or
 * `step`, any other skill (done → next).
 */
export const STEP_KINDS = [
  'spec',
  'reproduce',
  'build',
  'checks',
  'review',
  'verify',
  'pr',
  'step',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** A built-in step: its kind, the skill it runs (none for checks: serve runs them), its jump. */
export type BuiltInStep = {
  kind: Exclude<StepKind, 'step'>;
  skill: string | null;
  jump: string | null;
};

/**
 * Built-in steps by the name a workflow gives them; a skill's name is the same step. Their
 * default skill; a step's `skill:` names another.
 */
export const BUILT_IN_STEPS: Readonly<Record<string, BuiltInStep>> = {
  'create-specification': { kind: 'spec', skill: 'create-specification', jump: null },
  spec: { kind: 'spec', skill: 'create-specification', jump: null },
  reproduce: { kind: 'reproduce', skill: 'reproduce', jump: 'Before on the merge base' },
  build: { kind: 'build', skill: 'implement', jump: null },
  implement: { kind: 'build', skill: 'implement', jump: null },
  checks: { kind: 'checks', skill: null, jump: 'red → build' },
  review: { kind: 'review', skill: 'code-review', jump: 'findings → build' },
  'code-review': { kind: 'review', skill: 'code-review', jump: 'findings → build' },
  verify: { kind: 'verify', skill: 'verify', jump: 'fail → build' },
  pr: { kind: 'pr', skill: 'pr', jump: 'serve opens it' },
};

export const builtInStep = (name: string): BuiltInStep | undefined =>
  Object.hasOwn(BUILT_IN_STEPS, name) ? BUILT_IN_STEPS[name] : undefined;

/** The skills core ships (`packages/core/skills/`): the built-in Layer's, the vendored ones last. */
export const BUILT_IN_SKILLS: readonly string[] = [
  'abe',
  'code-review',
  'create-specification',
  'factory',
  'implement',
  'improve',
  'investigate',
  'make-card',
  'playbook',
  'pr',
  'prototype',
  'reproduce',
  'retro',
  'tdd',
  'to-tickets',
  'triage',
  'verify',
  ...VENDORED_SKILLS,
];

/** A fact's type: a count a `check:` compares, or text only `carries:` hands back. */
export type FactType = 'count' | 'text';

export type FactDef = { about: string; type: FactType; by: readonly StepKind[] };

/** The facts the built-in steps report, by name (the guide's table). */
export const FACTS: Readonly<Record<string, FactDef>> = {
  'checks.failed': { about: 'checks that failed', type: 'count', by: ['build', 'checks'] },
  'checks.output': { about: 'the failing output', type: 'text', by: ['build', 'checks'] },
  'review.findings': { about: 'every finding to fix', type: 'count', by: ['review'] },
  'review.findings.high': {
    about: 'findings rated high or critical',
    type: 'count',
    by: ['review'],
  },
  'criteria.failed': { about: 'acceptance criteria not proven', type: 'count', by: ['verify'] },
  'bug.reproduced': {
    about: 'the bug showed on the merge base (1) or not (0)',
    type: 'count',
    by: ['reproduce'],
  },
  'pr.checks.failed': { about: "the PR's failed checks", type: 'count', by: ['pr'] },
  'pr.comments.open': { about: 'review comments not resolved', type: 'count', by: ['pr'] },
  'spec.questions.open': { about: 'open questions in the spec', type: 'count', by: ['spec'] },
};

/** The facts a built-in kind reports. */
export const factsOfKind = (kind: StepKind): string[] =>
  Object.entries(FACTS)
    .filter(([, f]) => f.by.includes(kind))
    .map(([name]) => name);

/** The kinds a run starts its building from: checks, review and verify go back to the nearest. */
export const isBuild = (kind: StepKind): boolean => kind === 'build';

/** The kinds that need a build step before them. */
export const AFTER_BUILD: readonly StepKind[] = ['checks', 'review', 'verify'];

/**
 * How fresh a step's subagent starts: `never` (it gets what the steps before left), `always`
 * (only the card, the spec, the diff and the findings carried to it) or `loop` (fresh on each
 * loop back to it, with only the findings carried; its first visit as `never`).
 */
export const FRESH_MODES = ['never', 'always', 'loop'] as const;
export type FreshMode = (typeof FRESH_MODES)[number];

/** What a fresh step's subagent, or a gate's one yes/no call, may be given. */
export const SEES = ['card', 'spec', 'diff'] as const;
export type Sees = (typeof SEES)[number];

/** How a step's `ends:` ends the run: with its report. */
export const ENDS_THEN = ['report'] as const;
