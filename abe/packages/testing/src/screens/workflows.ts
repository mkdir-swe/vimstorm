/**
 * Workflow samples for the screens that read `abe workflow list` (the Launch box): demo-shop's
 * card workflows (the repo's Quick fix and Docs only, your Spike, Abe's Feature, Quick fix, Bug
 * and Investigate) and the skills they run, through core's real load check.
 */
import { loadWorkflows, type SkillSource, type WorkflowsData } from '@abe/core';
import { builtInWorkflowSources, workflowSource } from '@abe/ports';
import { type Answer } from '@abe/ui';

const CHECKOUT = '/home/kim/src/demo-shop';
const YOURS = '/home/kim/.config/abe';
const REPO = `${CHECKOUT}/.abe`;

/** A workflow's file: the repo's `abe/workflows/<id>.yaml`, yours `.abe/workflows/<id>.local.yaml`. */
const file = (dir: string, id: string) =>
  dir === YOURS ? `${REPO}/workflows/${id}.local.yaml` : `${CHECKOUT}/abe/workflows/${id}.yaml`;

const QUICK_FIX = [
  'name: Quick fix',
  'description: A bug, reproduced first; no spec, one review.',
  'on: bug',
  'steps:',
  '  - reproduce',
  '  - build',
  '  - checks',
  '  - review',
  '  - verify-demo-shop',
  '  - pr',
  'loops:',
  '  - from: review',
  '    to: build',
  '    when: { check: review.findings > 0 }',
  '    carries: [review.findings]',
  '    max: 1',
  '',
].join('\n');

/** Each source's workflow files, as YAML text. */
const FILES: readonly { layer: SkillSource['layer']; dir: string; id: string; text: string }[] = [
  { layer: 'repo', dir: REPO, id: 'quick-fix', text: QUICK_FIX },
  {
    layer: 'repo',
    dir: REPO,
    id: 'docs-only',
    text: [
      'name: Docs only',
      'description: Docs changes; no verify, one review round.',
      'on: { tags: [docs] }',
      'steps:',
      '  - create-specification',
      '  - build',
      '  - checks',
      '  - review',
      '  - pr',
      '',
    ].join('\n'),
  },
  {
    layer: 'yours',
    dir: YOURS,
    id: 'spike',
    text: [
      'name: Spike',
      'description: Try it; a draft PR.',
      'on: { tags: [spike] }',
      'steps:',
      '  - investigate',
      '  - build',
      '  - pr',
      '',
    ].join('\n'),
  },
];

/** The repo's and your skill folders, with their files. */
export const SAMPLE_SKILLS: readonly SkillSource[] = [
  {
    name: 'verify-demo-shop',
    layer: 'repo',
    dir: `${CHECKOUT}/.claude/skills/verify-demo-shop`,
    description: 'Drives demo-shop the way a person does and keeps the evidence.',
    files: ['SKILL.md', 'scripts/launch.sh'],
  },
  {
    name: 'seed-carts',
    layer: 'yours',
    dir: `${YOURS}/skills/seed-carts`,
    description: "Fills the shop with a bug's carts.",
    files: ['SKILL.md'],
  },
];

/** Abe's skills the sample lists, their files core's own. */
const BUILT_IN: readonly string[] = [
  'code-review',
  'create-specification',
  'implement',
  'investigate',
  'install',
  'playbook',
  'pr',
  'principle-fix-root-causes',
  'principle-prove-it-works',
  'reproduce',
  'tdd',
  'triage',
  'unslop',
  'verify',
];

/**
 * The sample sources loaded: every workflow above, Abe's own and the skills. With `broken`, the
 * repo's Quick fix runs `verify-demo-shop` and no source has it.
 */
export const sampleWorkflows = (o: { broken?: boolean } = {}): WorkflowsData => {
  const skills: SkillSource[] = [
    ...SAMPLE_SKILLS.filter((k) => o.broken !== true || k.name !== 'verify-demo-shop'),
    ...BUILT_IN.map((name) => ({
      name,
      layer: 'built-in' as const,
      dir: `built-in/skills/${name}`,
      description: '',
      files: ['SKILL.md'],
    })),
  ];
  const loaded = loadWorkflows({
    sources: [
      ...FILES.map((f) => workflowSource(f.layer, file(f.dir, f.id), f.id, f.text)),
      ...builtInWorkflowSources(),
    ],
    skills,
  });
  return {
    ...loaded,
    layers: [
      { layer: 'yours', name: null, dir: YOURS },
      { layer: 'repo', name: 'demo-shop', dir: REPO },
      { layer: 'built-in', name: null, dir: null },
    ],
    recent: [],
  };
};

/** `abe workflow list`'s answer as a screen gets it. */
export const workflowsAnswer = (data: WorkflowsData, id: string): Answer => ({
  kind: 'result',
  id,
  command: 'workflow list',
  reply: { ok: true, data },
});
