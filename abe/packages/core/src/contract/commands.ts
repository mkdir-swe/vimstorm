/**
 * The command table: every `abe <noun> [verb]` is one row, and each noun's folder holds its own
 * rows. The table only gathers them. `abe help`, VimStorm's `:` mode and argument checks read it.
 */
import { BOARD_COMMANDS } from '../board';
import { BOX_COMMANDS } from '../box';
import { BROWSER_COMMANDS } from '../browser';
import { DEMO_COMMANDS } from '../demo';
import { FACTORY_COMMANDS } from '../factory';
import { IMPORT_COMMANDS } from '../import';
import { IMPROVE_COMMANDS } from '../improve';
import { INSTALL_COMMANDS } from '../install';
import { LAYER_COMMANDS } from '../layer';
import { LOCAL_MODE_COMMANDS } from '../local-mode';
import { LOGIN_COMMANDS } from '../logins';
import { PROTOTYPE_COMMANDS } from '../prototype';
import { REVIEW_COMMANDS } from '../review';
import { SESSION_COMMANDS } from '../session';
import { SHEET_COMMANDS } from '../sheets';
import { WORKFLOW_COMMANDS } from '../skills';
import { THEME_COMMANDS } from '../theme';
import { TRIAGE_COMMANDS } from '../triage';
import { CONTRACT_COMMANDS } from './rows';

/** Keyed by the command as typed: the noun, then the verb after a space. */
export const COMMANDS = {
  ...CONTRACT_COMMANDS,
  ...LAYER_COMMANDS,
  ...WORKFLOW_COMMANDS,
  ...IMPORT_COMMANDS,
  ...INSTALL_COMMANDS,
  ...DEMO_COMMANDS,
  ...THEME_COMMANDS,
  ...BOARD_COMMANDS,
  ...LOCAL_MODE_COMMANDS,
  ...SHEET_COMMANDS,
  ...BOX_COMMANDS,
  ...SESSION_COMMANDS,
  ...BROWSER_COMMANDS,
  ...FACTORY_COMMANDS,
  ...PROTOTYPE_COMMANDS,
  ...TRIAGE_COMMANDS,
  ...IMPROVE_COMMANDS,
  ...LOGIN_COMMANDS,
  ...REVIEW_COMMANDS,
};

export type Commands = typeof COMMANDS;
export type CommandId = keyof Commands;

/** A row's own key only: `constructor` or `toString` is no command. */
export const isCommandId = (id: string): id is CommandId => Object.hasOwn(COMMANDS, id);

export const commandIds = (): CommandId[] => Object.keys(COMMANDS).filter(isCommandId);
