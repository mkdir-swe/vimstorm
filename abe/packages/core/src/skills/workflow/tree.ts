/**
 * The Project tree's Abe folder (ADR 0033): in a repo's main checkout the real `abe/` folder is
 * shown first, with Abe's face, and each workflow file there and in `.abe/workflows/` carries a
 * dim tag after its name: whose it is and what it takes (`Repo’s · on type Bug`), red with its
 * problem count when it fails the load check. `abe workflow tree` answers it; the words are
 * decided here, the app draws them.
 */
import { z } from 'zod';
import { SOURCE_WORDS } from './launch-pick';
import { type WorkflowsData, type WorkflowView } from './load';
import { takesWords } from './preview';

/** A file's tag in the tree. */
export const TreeTag = z.object({
  path: z.string(),
  tag: z.string(),
  /** It fails the load check: the tag in red. */
  bad: z.boolean(),
});
export type TreeTag = z.infer<typeof TreeTag>;

/** `abe workflow tree`: the `abe/` folder to show first and the files' tags; none outside a main checkout. */
export const WorkflowTreeData = z.object({
  main: z.boolean(),
  /** The repo's `abe/` folder; null when it has none (not installed). */
  dir: z.string().nullable(),
  tags: z.array(TreeTag),
});
export type WorkflowTreeData = z.infer<typeof WorkflowTreeData>;

export const workflowTreeText = (d: WorkflowTreeData): string =>
  d.main
    ? `${d.dir ?? 'no abe/ folder'}\n${d.tags.map((t) => `  ${t.path}  ${t.tag}\n`).join('')}`
    : "not a repo's main checkout\n";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A workflow file's tag: its source and what it takes, or its problem count. */
const tagOf = (w: WorkflowView): TreeTag => ({
  path: w.file,
  tag: w.ok
    ? `${SOURCE_WORDS[w.layer]} · ${takesWords(w)}${w.inForce ? '' : ' · yours wins'}`
    : `${SOURCE_WORDS[w.layer]} · ${plural(w.problems.length, 'problem')}`,
  bad: !w.ok,
});

/** Each workflow file of yours and the repo's, tagged (Abe's own are no file in the tree). */
export const treeTags = (d: Pick<WorkflowsData, 'workflows'>): TreeTag[] =>
  d.workflows.filter((w) => w.layer !== 'built-in').map(tagOf);
