/** Local mode in serve: a handler for each of core's rows, and what the process folder starts. */
import { type LOCAL_MODE_COMMANDS, type HandlersFor } from '@abe/core';
import { localHandlers, type LocalCtx } from './local-mode';

export { openDatabases } from './databases';
export { localApps, type LocalApps } from './local-apps';
export { startLocalBrowsers, type LocalBrowserOptions, type LocalBrowsers } from './local-browsers';
export {
  cardRoutedBoard,
  type CardCheckout,
  openLocalMode,
  type LocalCtx,
  type LocalMode,
  type RepoPortsCtx,
} from './local-mode';
export { openPortBases } from './port-bases';

export const LOCAL_MODE_HANDLERS: HandlersFor<typeof LOCAL_MODE_COMMANDS, LocalCtx> = {
  ...localHandlers(),
};
