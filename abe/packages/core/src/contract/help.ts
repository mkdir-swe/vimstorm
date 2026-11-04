/** `abe help` and every usage message, from the command table alone. */
import {
  argInfo,
  type ArgsSpec,
  type CommandDef,
  flagName,
  GLOBAL_FLAGS,
  type Outcome,
} from '../command';
import { type PersonalCommand } from '../improve';
import { type CommandId, commandIds, COMMANDS, isCommandId } from './commands';
import { type CommandInfo, type HelpData } from './contract';
import { helpText } from './text';

/** `abe serve stop [--json]`: positionals as `<name>` / `[name…]`, flags as `[--name <name>]`. */
export const usageLine = (id: CommandId): string => {
  const args: ArgsSpec = COMMANDS[id].args;
  const parts = Object.entries(args).map(([key, arg]) => {
    if (arg.kind === 'positional') {
      const name = `${key}${arg.repeats === true ? '…' : ''}`;

      return arg.required === true ? `<${name}>` : `[${name}]`;
    }
    const flag = `--${flagName(key)}`;
    const value = arg.values?.join('|') ?? `<${flagName(key)}>`;
    const whole =
      arg.type === 'boolean' ? flag : `${flag} ${value}${arg.repeats === true ? '…' : ''}`;

    return arg.required === true ? whole : `[${whole}]`;
  });

  return ['abe', id, ...parts, '[--json]'].join(' ');
};

export const commandInfo = (id: CommandId): CommandInfo => {
  const def: CommandDef = COMMANDS[id];

  return {
    noun: def.noun,
    verb: def.verb ?? null,
    usage: usageLine(id),
    summary: def.summary,
    inSession: def.inSession,
    only: def.only ?? null,
    risky: def.risky === true,
    args: Object.entries(def.args).map(([key, arg]) => argInfo(key, arg)),
  };
};

const globalFlags = () => Object.entries(GLOBAL_FLAGS).map(([key, arg]) => argInfo(key, arg));

/**
 * Every command (and your `personal` ones, when given), the one `path` names (`['serve', 'stop']`),
 * or every command of a noun with none of its own (`['factory']`).
 */
export const help = (
  path: readonly string[],
  personal?: readonly PersonalCommand[],
): Outcome<HelpData> => {
  if (path.length === 0)
    return {
      ok: true,
      data: {
        commands: commandIds().map(commandInfo),
        globalFlags: globalFlags(),
        ...(personal === undefined ? {} : { personal: [...personal] }),
      },
    };
  const id = path.join(' ');
  // A noun alone (`factory`): every command of it.
  const ofNoun = path.length === 1 ? commandIds().filter((c) => COMMANDS[c].noun === id) : [];

  if (!isCommandId(id) && ofNoun.length > 0)
    return { ok: true, data: { commands: ofNoun.map(commandInfo), globalFlags: globalFlags() } };
  if (!isCommandId(id))
    return {
      ok: false,
      error: { code: 'unknown-command', message: `unknown command: ${id}` },
      exit: 2,
    };

  return { ok: true, data: { commands: [commandInfo(id)], globalFlags: globalFlags() } };
};

/** What a usage failure prints after its message: the command's usage, or the overview. */
export const usageText = (id: CommandId | undefined): string => {
  const shown = help(id === undefined ? [] : [id]);

  if (!shown.ok) return '';
  const others =
    id === undefined
      ? []
      : commandIds().filter((other) => other !== id && COMMANDS[other].noun === COMMANDS[id].noun);

  return `${helpText(shown.data)}${others.map((other) => `also: ${usageLine(other)}\n`).join('')}`;
};

/** The nouns of the table: words a personal command may not take, and the ones it may run. */
export const commandNouns = (): Set<string> => new Set(commandIds().map((id) => COMMANDS[id].noun));
