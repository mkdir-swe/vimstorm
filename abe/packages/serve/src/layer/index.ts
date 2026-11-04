/** The Layers in serve: settings, their import, Reach and Overrides: a handler for each of core's rows, and what the process folder starts. */
import { type LAYER_COMMANDS, type IMPORT_COMMANDS, type HandlersFor } from '@abe/core';
import { overrideHandlers, type OverrideCtx } from './override';
import { reachHandlers, type ReachCtx } from './reach';
import { settingsHandlers, type ProblemsCtx, type SettingsCtx } from './settings';
import { settingsImportHandlers } from './settings-import';

export { askOneShot, type OneShotCtx, type OneShotOptions } from './one-shot';
export { type OverrideCtx } from './override';
export { type CredsCache, type ReachCtx } from './reach';
export {
  azureFolderAt,
  checkoutOf,
  loadSettings,
  serveTargetIn,
  type SettingsService,
  setRepoAt,
  setYoursAt,
  startSettings,
  yourHandedLayer,
  yourOwnSettings,
  type SettingsCtx,
} from './settings';

export const LAYER_HANDLERS: HandlersFor<
  typeof LAYER_COMMANDS & typeof IMPORT_COMMANDS,
  ProblemsCtx & SettingsCtx & ReachCtx & OverrideCtx
> = {
  ...settingsHandlers(),
  ...settingsImportHandlers(),
  ...reachHandlers(),
  ...overrideHandlers(),
};
