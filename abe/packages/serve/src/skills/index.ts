/** Workflows in serve: a handler for each of core's rows, and what the process folder starts. */
import { type WORKFLOW_COMMANDS, type HandlersFor } from '@abe/core';
import { workflowEditHandlers, type WorkflowEditCtx } from './workflow-edit';
import { workflowHandlers, type WorkflowCtx } from './workflows';

export { type WorkflowEditCtx } from './workflow-edit';
export { loadedWorkflows, type WorkflowCtx } from './workflows';

export const WORKFLOW_HANDLERS: HandlersFor<
  typeof WORKFLOW_COMMANDS,
  WorkflowCtx & WorkflowEditCtx
> = {
  ...workflowHandlers(),
  ...workflowEditHandlers(),
};
