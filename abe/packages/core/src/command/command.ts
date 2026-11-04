/**
 * A row of the command table: what a noun folder writes for each `abe <noun> [verb]`. Help, usage
 * and argument checks follow from the row.
 */
import { type z } from 'zod';
import { type ArgsSpec } from './args';
import { type TextAt } from './when';

export type CommandDef<S extends ArgsSpec = ArgsSpec, R extends z.ZodType = z.ZodType> = {
  readonly noun: string;
  /** `undefined` for a bare noun (`abe status`). */
  readonly verb?: string;
  readonly summary: string;
  /** Whether an agent may run it from inside its session (on the workspace socket). */
  readonly inSession: boolean;
  /**
   * Where else it may not run: `session` only from inside a session (a run's own steps, `hook`);
   * `client` answered by the `abe` client in a terminal, never as a reply of `serve` (`serve`,
   * `watch`, `ui …`); `shell` VimStorm's own, its Git Log's PR review and Create Draft PR (over
   * the bridge). VimStorm's Command mode lists none of them.
   */
  readonly only?: 'session' | 'client' | 'shell';
  /**
   * What a box's workspace answers on its own socket: `socket` with no session behind it (help, its
   * status, its browser), `session` for a session in it too. Not every `inSession` row: some act on
   * the box itself, outside the container and its sandbox (a prototype's app, a triage launch).
   */
  readonly inWorkspace?: 'socket' | 'session';
  /** It stops or merges something: Command mode asks first (a ConfirmLayer, No the default). */
  readonly risky?: true;
  readonly args: S;
  /** What `--json` prints as `data`; `dispatch` checks every answer against it. */
  readonly result: R;
  /**
   * The human text of a result, as of `at` (the answering serve's clock; absent: no clock). Left
   * out, the text is the field `says` names, as a line, or nothing.
   */
  text?(data: z.output<R>, at?: TextAt): string;
  /** The string field of the result that is its whole human text (`said`, `path`). */
  readonly says?: string;
  /** A line beside the human text, on stderr: what the result could not cover (never with `--json`). */
  note?(data: z.output<R>, at?: TextAt): string;
  /**
   * Whether an answer says a failure it recorded (`abe install check` on a part that fails): exit
   * 1, its document still `ok`. Left out: an answer exits 0.
   */
  fails?(data: z.output<R>): boolean;
  /**
   * What a slow answer waits on (`EC2 for your boxes`): a terminal is told after 2 s without one
   * and a command without it says it waits on abe serve.
   */
  readonly waits?: string;
};

/** The keys of `T` whose values are strings. */
type StringKey<T> = T extends object
  ? { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T] & string
  : never;

/** A row, typed by its arguments and result; `says` names one of the result's string fields. */
export const command = <const S extends ArgsSpec, R extends z.ZodType>(
  def: CommandDef<S, R> & { readonly says?: StringKey<z.output<R>> },
) => def;

/** What `abe <command>` prints without `--json`: the row's text, else its `says` field as a line. */
export const textOf = (def: CommandDef, data: unknown, at?: TextAt): string => {
  if (def.text !== undefined) return def.text(data, at);
  if (def.says === undefined || typeof data !== 'object' || data === null) return '';
  const said: unknown = new Map(Object.entries(data)).get(def.says);

  if (typeof said !== 'string' || said === '') return '';

  return said.endsWith('\n') ? said : `${said}\n`;
};

/** Flags every command takes. `--no-start` is read by the client, `--help` prints usage. */
export const GLOBAL_FLAGS = {
  json: {
    kind: 'flag',
    type: 'boolean',
    summary: 'print exactly one JSON document: {"ok":true,"data":…} or {"ok":false,"error":…}',
  },
  noStart: {
    kind: 'flag',
    type: 'boolean',
    summary: 'never start abe serve; exit 3 when none answers',
  },
  help: { kind: 'flag', type: 'boolean', summary: "print the command's usage" },
  on: {
    kind: 'flag',
    type: 'string',
    summary:
      "run the command on that box's abe serve, through this one (waking the box first): its answer and exit code unchanged",
  },
} as const satisfies ArgsSpec;
