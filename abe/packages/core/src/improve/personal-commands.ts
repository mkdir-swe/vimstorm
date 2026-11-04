/**
 * Personal commands (spec #36 I1, ticket #84): a file in your personal Layer, `commands.yaml`,
 * naming your own commands, each a word for an `abe` argv. `abe help --json` lists them beside the
 * table (VimStorm's Command mode reads it), and `abe <word> [more…]` runs `abe <argv…> [more…]`.
 * A word a command of the table has is never yours, and a personal command runs a command of the
 * table, never another personal one.
 *
 *     mine: [card, list]
 *     standup: { argv: [factory, status], summary: my runs and where they stand }
 */
import { z } from 'zod';

/** The file in your personal Layer's folder. */
export const COMMANDS_FILE = 'commands.yaml';

const NAME = /^[a-z][a-z0-9-]*$/;

const Argv = z.array(z.string().min(1)).min(1);

/** One personal command as `abe help --json` lists it. */
export const PersonalCommand = z.object({
  name: z.string().regex(NAME),
  argv: Argv,
  summary: z.string().nullable(),
});
export type PersonalCommand = z.infer<typeof PersonalCommand>;

const Entry = z.union([
  Argv,
  z.strictObject({ argv: Argv, summary: z.string().min(1).optional() }),
]);
const File = z.record(z.string().regex(NAME, 'a command word: lower case, digits and -'), Entry);

/** `commands.yaml`'s document (`undefined`: no file) as your commands, or why it does not read. */
export const personalCommandsOf = (
  doc: unknown,
): { ok: true; commands: PersonalCommand[] } | { ok: false; message: string } => {
  if (doc === undefined || doc === null) return { ok: true, commands: [] };
  if (Array.isArray(doc))
    return { ok: false, message: 'commands.yaml is a map: a word → an abe argv' };
  const read = File.safeParse(doc);

  if (!read.success)
    return {
      ok: false,
      message: read.error.issues
        .map((i) => `${i.path.length === 0 ? '(top)' : i.path.join('.')}: ${i.message}`)
        .join('; '),
    };

  return {
    ok: true,
    commands: Object.entries(read.data).map(([name, entry]) =>
      Array.isArray(entry)
        ? { name, argv: entry, summary: null }
        : { name, argv: entry.argv, summary: entry.summary ?? null },
    ),
  };
};

/** Why a personal command is refused next to the table's `nouns`, or `undefined` when it is not. */
export const personalCommandProblem = (
  c: PersonalCommand,
  nouns: ReadonlySet<string>,
): string | undefined => {
  if (nouns.has(c.name)) return `${c.name} is abe's own command`;
  const [first] = c.argv;

  return first !== undefined && nouns.has(first)
    ? undefined
    : `${c.name} runs ${first ?? '(nothing)'}, which is no abe command`;
};

/**
 * `argv` with its first word, when it names a personal command, put back as that command's argv
 * (the rest after it); `undefined` when the word is the table's or no fitting personal command's.
 */
export const expandPersonal = (
  argv: readonly string[],
  commands: readonly PersonalCommand[],
  nouns: ReadonlySet<string>,
): string[] | undefined => {
  const [word, ...rest] = argv;
  const found = commands.find((c) => c.name === word);

  if (found === undefined || personalCommandProblem(found, nouns) !== undefined) return undefined;

  return [...found.argv, ...rest];
};
