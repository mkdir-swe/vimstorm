/** Each result's human text: what `abe <command>` prints without `--json`. */
import { boxIdleText } from '../box';
import { type ArgInfo, localWhen, type TextAt } from '../command';
import {
  type CommandInfo,
  type HelpData,
  type ServeData,
  type StatusData,
  type StopData,
} from './contract';

const table = (rows: readonly (readonly [string, string])[], indent = '  '): string => {
  const width = Math.max(0, ...rows.map(([left]) => left.length));

  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join('\n');
};

const argRows = (args: readonly ArgInfo[]) =>
  args.map((arg): [string, string] => [
    arg.kind === 'flag' ? `--${arg.name}` : arg.name,
    arg.values === undefined ? arg.summary : `${arg.summary} (${arg.values.join(', ')})`,
  ]);

const named = (c: CommandInfo) => (c.verb === null ? c.noun : `${c.noun} ${c.verb}`);

const oneCommand = (c: CommandInfo, flags: readonly ArgInfo[]): string =>
  [
    `usage: ${c.usage}`,
    '',
    c.summary,
    ...(c.args.length === 0 ? [] : ['', 'arguments:', table(argRows(c.args))]),
    '',
    'every command also takes:',
    table(argRows(flags)),
    ...(c.inSession ? [] : ['', 'not available from inside a session.']),
    ...(c.only === 'session' ? ['', 'only from inside a session.'] : []),
  ].join('\n');

export const helpText = (help: HelpData): string => {
  const [only] = help.commands;

  if (help.commands.length === 1 && only !== undefined)
    return `${oneCommand(only, help.globalFlags)}\n`;

  return `${[
    'abe: the command line every Abe client uses (VimStorm, agents, scripts)',
    '',
    'usage: abe <noun> [verb] [arguments] [--json]',
    '',
    'commands:',
    table(help.commands.map((c): [string, string] => [named(c), c.summary])),
    '',
    ...(help.personal === undefined || help.personal.length === 0
      ? []
      : [
          'your own commands (commands.yaml):',
          table(
            help.personal.map((c): [string, string] => [
              c.name,
              `abe ${c.argv.join(' ')}${c.summary === null ? '' : `: ${c.summary}`}`,
            ]),
          ),
          '',
        ]),
    'every command also takes:',
    table(argRows(help.globalFlags)),
    '',
    '`abe help <command>` describes one command.',
  ].join('\n')}\n`;
};

export const statusText = (s: StatusData, at?: TextAt): string =>
  `${[
    `abe serve ${s.version}, pid ${s.pid}, started ${localWhen(s.startedAt, at?.now)}`,
    table(
      [
        ...(s.installed === undefined ? [] : [['installed', `abe ${s.installed}`] as const]),
        ['socket', s.socket],
        ['sessions', String(s.sessions)],
        ['workspaces', String(s.workspaces)],
        ...(s.idle === undefined ? [] : [['idle stop', boxIdleText(s.idle, at)] as const]),
      ],
      '',
    ),
  ].join('\n')}\n`;

export const serveText = (s: ServeData): string =>
  `abe serve ${s.version} listening on ${s.socket} (pid ${s.pid})\n`;

export const stopText = (s: StopData): string =>
  s.stopped ? `stopped abe serve (pid ${s.pid ?? '?'})\n` : 'no abe serve was running\n';
