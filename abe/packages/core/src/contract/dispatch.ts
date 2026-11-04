/**
 * argv → what to print: parse by the table, refuse what the caller may not run, run the handler,
 * check its answer against the row's result schema and render it as text or one JSON document.
 */
import { type z } from 'zod';
import {
  type ArgsOf,
  argsSchema,
  type CommandDef,
  EXIT,
  type Outcome,
  type Printed,
  type TextAt,
  textOf,
} from '../command';
import { type CommandId, commandIds, type Commands, COMMANDS } from './commands';
import { usageText } from './help';
import { parse } from './parse';

export type Handler<C extends CommandDef, Ctx> = (
  args: ArgsOf<C['args']>,
  ctx: Ctx,
) => Promise<Outcome<z.output<C['result']>>>;

/** One handler per row; a client that answers some commands itself passes only those. */
export type Handlers<Ctx> = { readonly [K in CommandId]: Handler<Commands[K], Ctx> };

/** One handler per row of `Rows`: a noun's own, its ids taken from its rows. */
export type HandlersFor<Rows, Ctx> = Pick<Handlers<Ctx>, keyof Rows & CommandId>;

/** Who sent the command: the person (any socket of theirs) or an agent inside its session. */
export type Caller = 'user' | 'session';

const line = (doc: unknown) => `${JSON.stringify(doc)}\n`;

/** A failure, printed: one JSON document with `--json`, else `abe: <message>` on stderr. */
export const printFailure = (
  error: { code: string; message: string },
  exit: Exclude<Printed['exit'], 0>,
  json: boolean,
  after = '',
): Printed =>
  json
    ? { exit, stdout: line({ ok: false, error }), stderr: after }
    : { exit, stdout: '', stderr: `abe: ${error.message}\n${after === '' ? '' : `\n${after}`}` };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const run = async <C extends CommandDef, Ctx>(
  def: C,
  handler: Handler<C, Ctx>,
  raw: Record<string, unknown>,
  ctx: Ctx,
  json: boolean,
  usage: string,
  at: TextAt | undefined,
): Promise<Printed> => {
  const args = argsSchema<C['args']>(def.args).safeParse(raw);

  // parse() validated these already; this read is for their types.
  if (!args.success)
    return printFailure({ code: 'usage', message: args.error.message }, EXIT.usage, json, usage);
  let outcome: Outcome<z.output<C['result']>>;

  try {
    outcome = await handler(args.data, ctx);
  } catch (err) {
    return printFailure({ code: 'failed', message: message(err) }, EXIT.failed, json);
  }
  if (!outcome.ok) {
    const exit = outcome.exit ?? EXIT.failed;

    return printFailure(outcome.error, exit, json, exit === EXIT.usage ? usage : '');
  }
  const data = def.result.safeParse(outcome.data);

  if (!data.success) {
    const why = `the answer does not match the contract: ${data.error.message}`;

    return printFailure({ code: 'bad-result', message: why }, EXIT.failed, json);
  }

  const exit = def.fails?.(data.data) === true ? EXIT.failed : EXIT.ok;

  return json
    ? { exit, stdout: line({ ok: true, data: data.data }), stderr: '' }
    : {
        exit,
        stdout: textOf(def, data.data, at),
        stderr: def.note?.(data.data, at) ?? '',
      };
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- K ties COMMANDS[id] to handlers[id], so run() sees one command, not a union
const runId = <K extends CommandId, Ctx>(
  id: K,
  handlers: Partial<Handlers<Ctx>>,
  raw: Record<string, unknown>,
  ctx: Ctx,
  json: boolean,
  at: TextAt | undefined,
): Promise<Printed> | undefined => {
  const handler = handlers[id];

  return handler === undefined
    ? undefined
    : run(COMMANDS[id], handler, raw, ctx, json, usageText(id), at);
};

export const dispatch = async <Ctx>(
  argv: readonly string[],
  handlers: Partial<Handlers<Ctx>>,
  ctx: Ctx,
  caller: Caller = 'user',
  /** The clock the text is rendered at (times as of now, in local time). */
  at?: TextAt,
): Promise<Printed> => {
  const parsed = parse(argv);

  if (!parsed.ok)
    return printFailure(
      { code: parsed.code, message: parsed.message },
      EXIT.usage,
      parsed.global.json,
      usageText(parsed.id),
    );
  const { id, global } = parsed;

  if (global.help) return { exit: EXIT.ok, stdout: usageText(id), stderr: '' };
  if (caller === 'session' && (!COMMANDS[id].inSession || global.on !== undefined)) {
    const why = `abe ${global.on === undefined ? '' : '--on '}${id} cannot be run from inside a session`;

    return printFailure({ code: 'not-in-session', message: why }, EXIT.failed, global.json);
  }
  // A `serve` that fronts boxes forwards `--on` before dispatch; any other has none to send to.
  if (global.on !== undefined && id !== 'help') {
    const why = `abe --on ${global.on}: this abe serve reaches no boxes`;

    return printFailure({ code: 'no-boxes', message: why }, EXIT.failed, global.json);
  }
  const printed = runId(id, handlers, parsed.args, ctx, global.json, at);

  return (
    (await printed) ??
    printFailure(
      { code: 'not-here', message: `abe ${id} is not answered here` },
      EXIT.failed,
      global.json,
    )
  );
};

/**
 * Claude Code permission rules for every command a session may run (`inSession`), so a session's
 * `abe` never waits on a permission prompt; the session's socket refuses every other row anyway.
 * `hook` is Claude Code's own, never the agent's.
 */
export const inSessionRules = (): string[] =>
  commandIds()
    .filter((id) => COMMANDS[id].inSession && id !== 'hook')
    .map((id) => `Bash(abe ${id}:*)`);
