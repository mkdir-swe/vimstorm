/** Workflows' rows of the command table: `abe workflow`. */
import { command } from '../command';
import { WorkflowUpdateData, workflowUpdateText } from '../shipped';
import {
  WorkflowChangeData,
  WorkflowCopyData,
  WorkflowProposeData,
  WorkflowRetroData,
  workflowChangeText,
  workflowCopyText,
  workflowProposeText,
  workflowRetroText,
} from './workflow/ai';
import { WorkflowReadData, workflowReadText } from './workflow/edit';
import { WorkflowPathData, WorkflowsData, workflowsText } from './workflow/load';
import { WorkflowTreeData, workflowTreeText } from './workflow/tree';

export const WORKFLOW_COMMANDS = {
  'workflow list': command({
    noun: 'workflow',
    verb: 'list',
    summary:
      "every Layer's workflows (yours, the repo's, built-in) through the load check: steps, loops, which is in force, each problem with its file and line",
    inSession: true,
    args: {
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowsData,
    text: workflowsText,
  }),
  'workflow path': command({
    noun: 'workflow',
    verb: 'path',
    summary:
      "the path to open a file `workflow list` names at (a workflow's file, a skill's folder/file, the guide): a Layer's as it is, a built-in one written out read-only under abe's state",
    inSession: true,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: 'the file as `workflow list` names it (`built-in/…` for a built-in one)',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowPathData,
    says: 'path',
  }),
  'workflow tree': command({
    noun: 'workflow',
    verb: 'tree',
    summary:
      "the Project tree's Abe folder in a repo's main checkout: the abe/ folder shown first, and each workflow file's tag (its source and on:, or its problems)",
    inSession: false,
    args: {
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowTreeData,
    text: workflowTreeText,
  }),
  'workflow update': command({
    noun: 'workflow',
    verb: 'update',
    summary:
      "Abe's newer workflows and skills against the repo's copies in abe/: each file's three-way update (Abe's as copied, the repo's copy, Abe's now), nothing written (--write: written, and each file's base moved in abe/installed.json)",
    inSession: false,
    args: {
      name: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: 'the workflows and skills to update, by name (default: every newer one)',
      },
      write: {
        kind: 'flag',
        type: 'boolean',
        summary: 'write the files and move their base',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary: 'the checkout whose abe/ is updated, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowUpdateData,
    text: workflowUpdateText,
  }),
  // a Layer's file opened, changed, copied, proposed, looked back on (#15 stories 24, 26–28, 36)
  'workflow read': command({
    noun: 'workflow',
    verb: 'read',
    summary:
      "a Layer's workflow or skill file as the Editor opens it: its readable side (markdown), whether it is read-only here (a farther Layer's: your copy changes), its problems with their ⌥⏎ fixes",
    inSession: true,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          'the file as `workflow list` names it, or its path (a built-in one as written out)',
      },
      text: {
        kind: 'flag',
        type: 'string',
        summary: "the file's text as the Editor has it now (default: as saved)",
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowReadData,
    text: workflowReadText,
  }),
  'workflow copy': command({
    noun: 'workflow',
    verb: 'copy',
    summary:
      "Edit my copy: a farther Layer's workflow (or a skill's whole folder) copied into your Layer, where it wins for you; one you have already is answered",
    inSession: false,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          'the file as `workflow list` names it, or its path (a built-in one as written out)',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowCopyData,
    text: workflowCopyText,
  }),
  'workflow propose': command({
    noun: 'workflow',
    verb: 'propose',
    summary:
      "your copy of the repo's workflow or skill as one pull request on the repo, for it to review; an open one is updated",
    inSession: false,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          'the file as `workflow list` names it, or its path (a built-in one as written out)',
      },
      why: {
        kind: 'flag',
        type: 'string',
        required: true,
        summary: 'why: the pull request opens with it',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowProposeData,
    text: workflowProposeText,
  }),
  'workflow change': command({
    noun: 'workflow',
    verb: 'change',
    summary:
      "Change with AI: a one-shot changes one workflow or skill file as you ask; answers the whole file after it, nothing written (--write: written, a farther Layer's into your copy)",
    inSession: false,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          'the file as `workflow list` names it, or its path (a built-in one as written out)',
      },
      wish: {
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'what to change, in your words',
      },
      text: {
        kind: 'flag',
        type: 'string',
        summary: "the file's text as the Editor has it now (default: as saved)",
      },
      write: {
        kind: 'flag',
        type: 'boolean',
        summary: "write it (your copy of a farther Layer's)",
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowChangeData,
    text: workflowChangeText,
  }),
  'workflow retro': command({
    noun: 'workflow',
    verb: 'retro',
    summary:
      "Retro on a file: a one-shot reads this machine's runs of a workflow (or of those running a skill) and answers findings, each a fix in the file when it is one; kept as the file's last retro, shown on its readable side",
    inSession: false,
    args: {
      file: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary:
          'the file as `workflow list` names it, or its path (a built-in one as written out)',
      },
      repo: {
        kind: 'flag',
        type: 'string',
        summary:
          'the checkout whose repo Layer is read, relative to where abe runs (default: here)',
      },
    },
    result: WorkflowRetroData,
    text: workflowRetroText,
  }),
};
