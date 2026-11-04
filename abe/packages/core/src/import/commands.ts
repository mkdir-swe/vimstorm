/** Settings import's row of the command table: `abe settings import`. */
import { command } from '../command';
import { IMPORT_SOURCES, SettingsImportData, settingsImportText } from './contract';

export const IMPORT_COMMANDS = {
  'settings import': command({
    noun: 'settings',
    verb: 'import',
    summary:
      "bring VS Code's, WebStorm's or Vim's settings into your Layer and their keys into your keys.json: each one as the setting or Keymap action it becomes here (ticked) or no match here; only your Layer is written",
    inSession: false,
    args: {
      source: {
        kind: 'positional',
        type: 'string',
        values: IMPORT_SOURCES,
        required: true,
        summary: 'where from: vscode, webstorm or vim',
      },
      dryRun: { kind: 'flag', type: 'boolean', summary: 'list what it would write; write nothing' },
      only: {
        kind: 'flag',
        type: 'string',
        summary:
          'only these settings, comma separated (ui.feel,tabs.limit); key:<the key> for a key binding (key:⌘Y)',
      },
    },
    result: SettingsImportData,
    text: settingsImportText,
  }),
};
