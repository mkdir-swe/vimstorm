/**
 * A workflow file's shape (#15): `workflows/<id>.yaml` in a Layer, plain YAML. The JSON Schema
 * yaml-language-server completes and checks it with (`schema/workflow.schema.json`) is generated
 * from these (`workflowJsonSchema`); the load check (`load.ts`) says the rest.
 */
import { z } from 'zod';
import { ENDS_THEN, WORKFLOW_LAYERS } from './kinds';

const Name = z.string().min(1);

/**
 * A condition: exactly one of `check:` (a fact a step reports, compared: Abe evaluates it) or
 * `judge:` (a yes/no question the step's own agent answers, with what it `sees:`).
 */
export const ConditionFile = z.xor([
  z
    .strictObject({
      check: Name.describe(
        'An expression over the facts the steps report: > < >= <= == != and or not. Abe evaluates it, no model.',
      ),
    })
    .describe('check: a fact a step reports, compared'),
  z
    .strictObject({
      judge: Name.describe("One yes/no question, ending in ?, the step's own agent answers."),
      sees: z.array(Name).min(1).describe('What the agent looks at to answer: facts or evidence.'),
    })
    .describe("judge: a yes/no question the step's own agent answers"),
]);
export type ConditionFile = z.infer<typeof ConditionFile>;

/**
 * A step's way out of the run (`ends:`): when its condition holds once the step is done (none:
 * always), the run ends there with the step's report (`then: report`).
 */
export const EndsFile = z
  .strictObject({
    check: Name.optional().describe(
      'A fact the step reports, compared: the run ends when it holds.',
    ),
    judge: Name.optional().describe('One yes/no question, ending in ?: the run ends on yes.'),
    sees: z.array(Name).min(1).optional().describe("What the judge's call looks at."),
    then: z.enum(ENDS_THEN).describe("report: the run ends with the step's report (its Run page)."),
  })
  .describe(
    'The run ends after this step, with its report: always, or when check: or judge: says.',
  );
export type EndsFile = z.infer<typeof EndsFile>;

export const StepOptions = z
  .strictObject({
    skill: Name.optional().describe(
      "The step's one main skill (Abe's, the repo's or yours); every other skill is there by its description. checks has none: serve runs them.",
    ),
    fresh: z
      .union([z.boolean(), z.literal('loop')])
      .optional()
      .describe(
        'true: a fresh subagent with only the card, the spec, the diff and the findings carried to it. loop: fresh on each loop back to it.',
      ),
    when: ConditionFile.optional().describe(
      'A gate: the step runs only when it holds (check:) or its one yes/no call says yes (judge:, with what it sees: card, spec, diff); else it is skipped.',
    ),
    ends: EndsFile.optional(),
    pin: z
      .enum(WORKFLOW_LAYERS)
      .optional()
      .describe('A Layer that pins this step: a nearer copy keeps it, in order.'),
    reviewers: z.array(Name).optional().describe('Who reviews what this step makes.'),
    reports: z
      .array(Name)
      .optional()
      .describe("Facts this step reports, beside a built-in step's own."),
    done_when: ConditionFile.optional().describe(
      'When the step is done: exactly one of check: or judge:.',
    ),
    into: Name.optional().describe(
      "pr only: a text fact an earlier step reports (its reports:), naming the branch its pull request goes into, like a teammate's pull request's head. The card branch starts from it once reported; nothing is pushed onto it. None: the repo's default branch.",
    ),
  })
  .describe("A step's options.");
export type StepOptions = z.infer<typeof StepOptions>;

/** A step: a skill's name, or `<step>: { skill, fresh, when, ends, pin, reviewers, reports, done_when, into }`. */
export const StepFile = z.union([
  Name.describe(
    'A skill, or a built-in step: create-specification, reproduce, build, checks, review, verify, pr.',
  ),
  z
    .record(Name, StepOptions)
    .refine((r) => Object.keys(r).length === 1, 'a step is one skill: `- name: { … }`')
    .describe('One skill with its options.'),
]);
export type StepFile = z.infer<typeof StepFile>;

export const LoopFile = z
  .strictObject({
    from: Name.describe('The step it goes back from.'),
    to: Name.describe('The step it goes back to: before from, or the same step.'),
    when: ConditionFile.describe('When it goes back: exactly one of check: or judge:.'),
    carries: z.array(Name).optional().describe("What goes back: facts, or the step's evidence."),
    max: z
      .number()
      .int()
      .positive()
      .describe('Required: how many times it may go back; past it the run stops at Needs you.'),
  })
  .describe('A loop back to an earlier step.');
export type LoopFile = z.infer<typeof LoopFile>;

export const OnFile = z.union([
  Name.describe('A card type (bug), or default: a card no other workflow takes.'),
  z.strictObject({
    type: z
      .union([Name, z.array(Name)])
      .optional()
      .describe('Card types it takes.'),
    tags: z.array(Name).optional().describe('Tags a card has, any of them.'),
  }),
]);
export type OnFile = z.infer<typeof OnFile>;

export const WorkflowFile = z
  .strictObject({
    name: Name.describe("The workflow's name, as the Editor's preview and the Launch box show it."),
    description: z.string().optional().describe('One line: what it is for.'),
    on: OnFile.optional().describe(
      'Which cards it is preselected for; none: offered at launch, never preselected.',
    ),
    branch: z.string().optional().describe('The branch a run works on: card/<card>.'),
    steps: z.array(StepFile).min(1).describe('The steps, in order.'),
    loops: z.array(LoopFile).optional().describe('Loops back to earlier steps.'),
  })
  .describe('An Abe workflow: steps in order and the loops back between them.');
export type WorkflowFile = z.infer<typeof WorkflowFile>;

/** The JSON Schema of a workflow file, as `schema/workflow.schema.json` holds it. */
export const workflowJsonSchema = (): Record<string, unknown> => ({
  ...z.toJSONSchema(WorkflowFile, { target: 'draft-07', io: 'input' }),
  $id: 'https://vimstorm.dev/abe/workflow.schema.json',
  title: 'Abe workflow',
});
