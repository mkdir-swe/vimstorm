/** Boxes in serve: a handler for each of core's rows, and what the process folder starts. */
import { type BOX_COMMANDS, type HandlersFor } from '@abe/core';
import { clientHandlers } from './box-attach';
import { boxPlaceHandlers, type BoxPlaceCtx } from './box-place';
import { boxHandlers, type BoxCtx } from './box-resize';
import { boxSessionHandlers, type BoxSessionCtx } from './box-sessions';
import { boxesHandlers, type BoxesCtx } from './boxes';
import { portHandlers, type PortsCtx } from './port-forwards';
import { workspaceHandlers, type WorkspaceCtx } from './workspace';
import { workspacePortsHandlers, type WorkspacePortsCtx } from './workspace-ports';

export { clientOnly, runBoxAttach, runBoxForward } from './box-attach';
export { anyWorkspaceExec, byContainer, routedRunner } from './box-routes';
export { versionedLink } from './box-version';
export { startBoxFront, withRoom, type BoxFront, type BoxesCtx } from './boxes';
export { startCloud, type CloudSessions } from './cloud';
export { boxSyncer, type BoxSyncer, type BuiltSync } from './box-sync';
export { startIdleStop, type IdleHeld, type IdleStop } from './idle';
export { onBoxAnswer } from './on-box';
export { startPortForwards, type PortsCtx } from './port-forwards';
export {
  openBox,
  requestCard,
  workspaceDirectory,
  type Box,
  type BoxOptions,
  type WorkspaceCtx,
  type WorkspaceDirectory,
} from './workspace';
export {
  startWorkspacePorts,
  type WorkspacePortsCtx,
  type WorkspacePortsService,
} from './workspace-ports';

export const BOX_HANDLERS: HandlersFor<
  typeof BOX_COMMANDS,
  WorkspaceCtx & WorkspacePortsCtx & PortsCtx & BoxSessionCtx & BoxCtx & BoxesCtx & BoxPlaceCtx
> = {
  ...workspaceHandlers(),
  ...workspacePortsHandlers(),
  ...portHandlers(),
  ...boxSessionHandlers(),
  ...boxHandlers(),
  ...boxesHandlers(),
  ...boxPlaceHandlers(),
  ...clientHandlers,
};
