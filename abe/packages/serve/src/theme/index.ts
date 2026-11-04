/** The theme in serve: a handler for each of core's rows, and what the process folder starts. */
import { type THEME_COMMANDS, type HandlersFor } from '@abe/core';
import { type SettingsCtx } from '../layer/settings';
import { themeHandlers } from './theme';

export { startThemeWatch } from './theme';

export const THEME_HANDLERS: HandlersFor<typeof THEME_COMMANDS, SettingsCtx> = {
  ...themeHandlers(),
};
