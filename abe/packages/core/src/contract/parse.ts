/** argv → which command and its raw arguments, by the command table alone. */
import {
  type ArgSpec,
  argsSchema,
  type ArgsSpec,
  flagKey,
  flagName,
  GLOBAL_FLAGS,
} from '../command';
import { splitOn } from '../box';
import { type CommandId, commandIds, COMMANDS, isCommandId } from './commands';

/** The global flags; `on`, the box `--on` names (its `serve` answers instead of this one). */
export type Global = { json: boolean; noStart: boolean; help: boolean; on?: string };

export type Parsed =
  | { ok: true; id: CommandId; args: Record<string, unknown>; global: Global }
  | {
      ok: false;
      /** The command the arguments were for, when the noun (and verb) were known. */
      id: CommandId | undefined;
      code: 'usage' | 'unknown-command';
      message: string;
      global: Global;
    };

const NO_GLOBAL: Global = { json: false, noStart: false, help: false };

/** The global flags as typed anywhere, for a failure before the command is known. */
const scanGlobal = (argv: readonly string[]): Global => ({
  json: argv.includes('--json'),
  noStart: argv.includes('--no-start'),
  help: argv.includes('--help'),
});

const route = (argv: readonly string[]): { id: CommandId; rest: string[] } | undefined => {
  const [noun, verb, sub] = argv;

  if (noun === undefined || noun.startsWith('-')) return { id: 'help', rest: [...argv] };
  const both = `${noun} ${verb ?? ''}`;
  // A verb of two words (`prototype change add`).
  const three = `${both} ${sub ?? ''}`;

  if (sub !== undefined && isCommandId(three)) return { id: three, rest: argv.slice(3) };
  if (verb !== undefined && isCommandId(both)) return { id: both, rest: argv.slice(2) };
  if (isCommandId(noun)) return { id: noun, rest: argv.slice(1) };
  // A noun with no command of its own (`abe factory`, `abe factory --help`): its commands.
  if (isNoun(noun) && (verb === undefined || isFlag(verb)))
    return { id: 'help', rest: [noun, ...argv.slice(1).filter((t) => t !== '--help')] };

  return undefined;
};

const isNoun = (word: string) => commandIds().some((id) => COMMANDS[id].noun === word);

/** `--name`, `-x` or `--` itself; a dash-led value (`- a` a markdown list item, `-1`) is no flag. */
const isFlag = (token: string) => token === '--' || /^--?[A-Za-z]/.test(token);

const display = (key: string, arg: ArgSpec) => (arg.kind === 'flag' ? `--${flagName(key)}` : key);

type Tokens =
  | { ok: true; raw: Record<string, unknown>; global: Global }
  | { ok: false; message: string; global: Global };

const tokenize = (spec: ArgsSpec, rest: readonly string[]): Tokens => {
  const global: Global = { ...NO_GLOBAL };
  const raw: Record<string, unknown> = {};
  const positional = Object.entries(spec).filter(([, arg]) => arg.kind === 'positional');
  const loose: string[] = [];
  let literal = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';

    if (literal || !isFlag(token)) {
      loose.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (!token.startsWith('--')) return { ok: false, message: `unknown flag ${token}`, global };
    const eq = token.indexOf('=');
    const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
    const inline = eq < 0 ? undefined : token.slice(eq + 1);
    const key = flagKey(name);

    if (Object.hasOwn(GLOBAL_FLAGS, key) && !Object.hasOwn(spec, key)) {
      if (inline !== undefined) return { ok: false, message: `--${name} takes no value`, global };
      if (key === 'json') global.json = true;
      if (key === 'noStart') global.noStart = true;
      if (key === 'help') global.help = true;
      continue;
    }
    const arg = Object.hasOwn(spec, key) ? spec[key] : undefined;

    if (arg?.kind !== 'flag') return { ok: false, message: `unknown flag --${name}`, global };
    if (Object.hasOwn(raw, key) && arg.repeats !== true)
      return { ok: false, message: `--${name} is given twice`, global };
    if (arg.type === 'boolean') {
      if (inline !== undefined) return { ok: false, message: `--${name} takes no value`, global };
      raw[key] = true;
      continue;
    }
    const value = inline ?? rest[i + 1];

    if (value === undefined || (inline === undefined && isFlag(value)))
      return { ok: false, message: `--${name} needs a value`, global };
    if (inline === undefined) i += 1;
    const before: unknown = raw[key];
    const earlier: readonly unknown[] = Array.isArray(before) ? before : [];

    raw[key] = arg.repeats === true ? [...earlier, value] : value;
  }

  for (const [key, arg] of positional) {
    if (arg.repeats === true) raw[key] = loose.splice(0);
    else if (loose.length > 0) raw[key] = loose.shift();
  }
  const [extra] = loose;

  if (extra !== undefined) return { ok: false, message: `unexpected argument ${extra}`, global };

  return { ok: true, raw, global };
};

const validate = (spec: ArgsSpec, raw: Record<string, unknown>): string | undefined => {
  for (const [key, arg] of Object.entries(spec)) {
    const value = raw[key];
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);

    if (arg.required === true && empty)
      return arg.kind === 'flag' ? `--${flagName(key)} is required` : `missing ${key}`;
  }
  const checked = argsSchema(spec).safeParse(raw);

  if (checked.success) return undefined;
  const [issue] = checked.error.issues;
  const key = String(issue?.path[0] ?? '');
  const arg = Object.hasOwn(spec, key) ? spec[key] : undefined;

  return `${arg === undefined ? key : display(key, arg)}: ${issue?.message ?? 'invalid'}`;
};

/** argv without `--on` against the table. */
const parseRest = (argv: readonly string[]): Parsed => {
  const routed = route(argv);

  if (routed === undefined) {
    const typed = argv
      .slice(0, 2)
      .filter((t) => !isFlag(t))
      .join(' ');

    return {
      ok: false,
      id: undefined,
      code: 'unknown-command',
      message: `unknown command: ${typed}`,
      global: scanGlobal(argv),
    };
  }
  const spec = COMMANDS[routed.id].args;
  const tokens = tokenize(spec, routed.rest);

  if (!tokens.ok) {
    return {
      ok: false,
      id: routed.id,
      code: 'usage',
      message: tokens.message,
      global: scanGlobal(argv),
    };
  }
  const invalid = tokens.global.help ? undefined : validate(spec, tokens.raw);

  if (invalid !== undefined)
    return { ok: false, id: routed.id, code: 'usage', message: invalid, global: tokens.global };

  return { ok: true, id: routed.id, args: tokens.raw, global: tokens.global };
};

/**
 * Reads argv against the table: the command, its arguments (checked by the row's schema) and the
 * global flags. A bare `abe` is `abe help`. `--on <box>` (anywhere before `--`) is taken out
 * first: `global.on`, and the rest is read as the command.
 */
export const parse = (typed: readonly string[]): Parsed => {
  const split = splitOn(typed);

  if (!split.ok)
    return {
      ok: false,
      id: undefined,
      code: 'usage',
      message: split.message,
      global: scanGlobal(typed),
    };
  const { argv } = split;
  const on = split.on === undefined ? {} : { on: split.on };
  const parsed = parseRest(argv);

  return { ...parsed, global: { ...parsed.global, ...on } };
};
