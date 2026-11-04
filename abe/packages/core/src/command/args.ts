/**
 * A command's arguments as data: what `abe help` lists, what the argv tokenizer reads and what
 * the zod schema validates. One spec, so help and validation cannot disagree.
 */
import { z } from 'zod';

/** One argument of a command, as `abe help --json` lists it. */
export const ArgInfo = z.object({
  name: z.string(),
  kind: z.enum(['positional', 'flag']),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  values: z.array(z.string()).optional(),
  required: z.boolean(),
  repeats: z.boolean(),
  summary: z.string(),
});
export type ArgInfo = z.infer<typeof ArgInfo>;

export type ArgSpec = {
  readonly kind: 'positional' | 'flag';
  readonly type: 'string' | 'number' | 'boolean';
  /** The allowed values, for an enum. */
  readonly values?: readonly [string, ...string[]];
  /** A boolean flag is never required; it is `false` when absent. */
  readonly required?: boolean;
  /** A positional that takes every remaining argument (the last one only), or a flag given again for more. */
  readonly repeats?: boolean;
  /** A string taken word for word: an empty one too (a command's argv after `--`). */
  readonly verbatim?: boolean;
  readonly summary: string;
};

/** Argument name → spec, positionals in order. A flag `--dry-run` is the key `dryRun`. */
export type ArgsSpec = Readonly<Record<string, ArgSpec>>;

type ValueOf<A extends ArgSpec> = A['values'] extends readonly (infer V)[]
  ? V
  : A['type'] extends 'number'
    ? number
    : A['type'] extends 'boolean'
      ? boolean
      : string;

type Always<A extends ArgSpec> = A['repeats'] extends true
  ? true
  : A['type'] extends 'boolean'
    ? true
    : A['required'] extends true
      ? true
      : false;

type Value<A extends ArgSpec> = A['repeats'] extends true ? ValueOf<A>[] : ValueOf<A>;

/** The parsed arguments a handler gets: repeats are arrays, booleans always set. */
export type ArgsOf<S extends ArgsSpec> = {
  -readonly [K in keyof S as Always<S[K]> extends true ? K : never]: Value<S[K]>;
} & {
  -readonly [K in keyof S as Always<S[K]> extends true ? never : K]?: Value<S[K]>;
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export const flagName = kebab;
export const flagKey = camel;

const valueSchema = (arg: ArgSpec): z.ZodType => {
  if (arg.values !== undefined) return z.enum(arg.values);
  if (arg.type === 'number') return z.coerce.number();
  if (arg.type === 'boolean') return z.boolean();

  return arg.verbatim === true ? z.string() : z.string().min(1);
};

/** The zod schema of a spec: strict, so an argument the spec does not name is refused. */
export const argsSchema = <S extends ArgsSpec>(spec: S): z.ZodType<ArgsOf<S>> => {
  const shape: Record<string, z.ZodType> = {};

  for (const [key, arg] of Object.entries(spec)) {
    const one = valueSchema(arg);

    if (arg.repeats === true)
      shape[key] = arg.required === true ? z.array(one).min(1) : z.array(one).default([]);
    else if (arg.type === 'boolean') shape[key] = z.boolean().default(false);
    else shape[key] = arg.required === true ? one : one.optional();
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- built key by key from the spec ArgsOf<S> maps; args.test.ts checks the two agree
  return z.strictObject(shape) as unknown as z.ZodType<ArgsOf<S>>;
};

/** `abe help --json`'s view of one argument. */
export const argInfo = (key: string, arg: ArgSpec): ArgInfo => ({
  name: arg.kind === 'flag' ? kebab(key) : key,
  kind: arg.kind,
  type: arg.values === undefined ? arg.type : 'enum',
  ...(arg.values === undefined ? {} : { values: [...arg.values] }),
  required: arg.required === true,
  repeats: arg.repeats === true,
  summary: arg.summary,
});
