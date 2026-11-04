/** Abe's own rows of the command table: `abe help`, `serve`, `status`, `watch` and `ui`. */
import { command } from '../command';
import { HelpData, ServeData, StatusData, StopData } from './contract';
import { Event, eventText } from './events';
import { helpText, serveText, statusText, stopText } from './text';
import { SCREEN_NAMES, SETTINGS_DIALOG, UiBridgeData, UiRenderData, uiRenderText } from './ui';

export const CONTRACT_COMMANDS = {
  help: command({
    noun: 'help',
    summary: 'list every command, or one command and its arguments',
    inSession: true,
    inWorkspace: 'socket',
    args: {
      command: {
        kind: 'positional',
        type: 'string',
        repeats: true,
        summary: 'the command to describe, as typed (`serve stop`)',
      },
    },
    result: HelpData,
    text: helpText,
  }),
  serve: command({
    noun: 'serve',
    summary: 'run abe serve in the foreground (every other command starts it when none answers)',
    inSession: false,
    only: 'client',
    args: {},
    result: ServeData,
    text: serveText,
  }),
  'serve stop': command({
    noun: 'serve',
    verb: 'stop',
    summary: 'stop the running abe serve',
    inSession: false,
    risky: true,
    args: {},
    result: StopData,
    text: stopText,
  }),
  status: command({
    noun: 'status',
    summary: 'what this abe serve holds: version, pid, start time, sessions and workspaces',
    inSession: true,
    inWorkspace: 'socket',
    args: {},
    result: StatusData,
    text: statusText,
  }),
  watch: command({
    noun: 'watch',
    summary: 'stream what this abe serve does as numbered events, one line each, until Ctrl-C',
    // A session sees only its own events once sessions exist; until then, none.
    inSession: false,
    only: 'client',
    args: {
      since: {
        kind: 'flag',
        type: 'number',
        summary: 'first replay the held events after this number (the last one you saw)',
      },
    },
    // Each line, not one document: `--json` prints every event as its own line.
    result: Event,
    text: eventText,
  }),
  'ui render': command({
    noun: 'ui',
    verb: 'render',
    summary:
      "a screen's component tree for abe serve's current state, as an outline; or the Settings dialog's",
    inSession: false,
    only: 'client',
    args: {
      screen: {
        kind: 'positional',
        type: 'string',
        required: true,
        summary: `the screen: ${SCREEN_NAMES.map((n) => `\`${n}\``).join(', ')}, or \`${SETTINGS_DIALOG}\` (the Settings dialog)`,
      },
      page: {
        kind: 'flag',
        type: 'string',
        summary: `the Settings page to open (\`problems\`, \`logins-tools\`), with \`${SETTINGS_DIALOG}\``,
      },
    },
    result: UiRenderData,
    text: uiRenderText,
  }),
  'ui bridge': command({
    noun: 'ui',
    verb: 'bridge',
    summary: "VimStorm's bridge: screens as component trees over stdio, newline-delimited JSON",
    inSession: false,
    only: 'client',
    args: {},
    // Its stdout is the bridge's frames, never one document.
    result: UiBridgeData,
  }),
};
