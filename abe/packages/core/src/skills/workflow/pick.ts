/**
 * The workflow a launch runs: an id given (`--workflow <id>`) checked, refused with its problems
 * when it does not load; else the one the card's `on:` takes (`launch-pick.ts`), else Feature.
 */
import { type Outcome, refused } from '../../command';
import { cardWorkflows, type CardKind, preselected } from './launch-pick';
import { runWorkflowOf, type WorkflowsData, type WorkflowView } from './load';
import { FEATURE_WORKFLOW, type RunWorkflow } from './run';

/**
 * The workflow a card runs with no pick, as a run carries it: `preselected`, else the built-in
 * Feature.
 */
export const workflowFor = (
  card: CardKind,
  loaded: Pick<WorkflowsData, 'workflows'>,
): RunWorkflow => {
  const picked = preselected(card, loaded);

  return picked === undefined ? FEATURE_WORKFLOW : runWorkflowOf(picked);
};

/** A workflow id's problems in one line: the first, with how many more. */
const problemsLine = (w: WorkflowView): string => {
  const [first] = w.problems;

  if (first === undefined) return '';
  const more = w.problems.length - 1;

  return `${first.file}${first.line === null ? '' : `:${first.line}`}: ${first.text}${more === 0 ? '' : ` (and ${more} more)`}`;
};

/**
 * `--workflow <id>` checked: the nearest file of that id as a run carries it, whatever its `on:`
 * says (none: offered, never preselected). Refused when no source has it (`unknown-workflow`,
 * naming the workflows) or when it fails the load check (`workflow-problems`, with its problems).
 */
export const pickedWorkflow = (
  id: string,
  loaded: Pick<WorkflowsData, 'workflows'>,
): Outcome<RunWorkflow> => {
  const nearest = loaded.workflows.find((w) => w.id === id);
  const offered = cardWorkflows(loaded).map((w) => w.id);
  const names = offered.length === 0 ? 'none' : offered.join(', ');

  if (nearest === undefined)
    return refused('unknown-workflow', `no workflow ${id} here: the workflows are ${names}`);
  if (!nearest.ok)
    return refused(
      'workflow-problems',
      `${id} does not load (${nearest.problems.length} problem${nearest.problems.length === 1 ? '' : 's'}): ${problemsLine(nearest)}`,
    );
  return { ok: true, data: runWorkflowOf(nearest) };
};
