/** The install in serve: a handler for each of core's rows, and what the process folder starts. */
import { type INSTALL_COMMANDS, type HandlersFor } from '@abe/core';
import { checkFilesHandlers, type CheckCtx } from './check-files';
import { installHandlers, type InstallCtx } from './install';
import { toolsHandlers, type ToolsCtx } from './tools';

export { checkFilesHandlers } from './check-files';
export {
  abeEnvRedacted,
  abeEnvValues,
  credentialsInjection,
  hasAbeEnvFiles,
  type InstallCtx,
  installSessionAsked,
  runWarning,
  worktreeCopies,
} from './install';
export { type MoveTargets, repoMoves, type RepoMoves } from './moves';
export { installRecords, type InstallPorts } from './record';
export { type ToolsCtx } from './tools';

export const INSTALL_HANDLERS: HandlersFor<
  typeof INSTALL_COMMANDS,
  InstallCtx & CheckCtx & ToolsCtx
> = {
  ...installHandlers(),
  ...checkFilesHandlers(),
  ...toolsHandlers(),
};
