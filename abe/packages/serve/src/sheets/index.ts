/** Sheets in serve: a handler for each of core's rows, and what the process folder starts. */
import { type SHEET_COMMANDS, type HandlersFor } from '@abe/core';
import { sheetsHandlers, type SheetsCtx } from './sheets';

export { openSheets, type SheetsCtx, type SheetsOptions } from './sheets';

export const SHEET_HANDLERS: HandlersFor<typeof SHEET_COMMANDS, SheetsCtx> = {
  ...sheetsHandlers(),
};
