/**
 * The built-in Layer's workflows and the guide (#15), as text: core reads no file, and the
 * compiled `abe` carries them. The ports parse them as any Layer's (`ports/src/mac/workflows.ts`).
 */
import { SHIPPED_FILES } from '../../shipped';
import guide from '../../../workflows/workflow-yaml.md' with { type: 'text' };
import { BUILT_IN_SKILL_FILES } from './built-in-skills';

/** Each built-in workflow by its id, as its file holds it. */
export const BUILT_IN_WORKFLOWS: readonly { id: string; text: string }[] = SHIPPED_FILES.flatMap(
  (f) => {
    const id = /^workflows\/([^/]+)\.yaml$/.exec(f.path)?.[1];

    return id === undefined ? [] : [{ id, text: f.text }];
  },
);

/** The guide's file name, as the tree's Abe node lists it beside the workflows. */
export const WORKFLOW_GUIDE_FILE = 'workflow-yaml.md';

/** The workflow YAML guide (⌘B from any `check:` or `judge:`). */
export const WORKFLOW_GUIDE: string = guide;

/**
 * A built-in file's text by the name `abe workflow list` gives it (`built-in/workflows/<id>.yaml`,
 * `built-in/skills/<name>/<file>`, `built-in/workflow-yaml.md`); undefined for any other.
 */
export const builtInFile = (file: string): string | undefined => {
  if (file === `built-in/${WORKFLOW_GUIDE_FILE}`) return WORKFLOW_GUIDE;
  const workflow = /^built-in\/workflows\/([^/]+)\.yaml$/.exec(file)?.[1];

  if (workflow !== undefined) return BUILT_IN_WORKFLOWS.find((w) => w.id === workflow)?.text;

  return file.startsWith('built-in/skills/')
    ? BUILT_IN_SKILL_FILES.find((f) => f.path === file.slice('built-in/'.length))?.text
    : undefined;
};
