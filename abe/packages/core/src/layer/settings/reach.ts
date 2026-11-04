/**
 * The Reach names a setting may hold (ADR 0010) and the repo's environments behind them: the
 * fixed `ABE_*` names, read and written back, and the `environments` setting's shape. The rules
 * that turn them into a session's variables are `core/src/layer/reach.ts`.
 */
import { z } from 'zod';

/** What a Reach name opens: an AWS role, or a database. */
export type ReachService = 'aws' | 'db';
/** Every session reads; a write is granted only by an Override with a reason. */
export type ReachAccess = 'read' | 'write';

/** One Reach name read: `ABE_DB_WRITE_URL_TEST` → db, write, `test`. */
export type ReachName = {
  name: string;
  service: ReachService;
  access: ReachAccess;
  environment: string;
};

/** An environment's name in the org file: `test`, `prod`; `TEST` in its names. */
export const ENVIRONMENT_NAME = /^[a-z][a-z0-9]*$/;

/** The four shapes, nothing else (ADR 0010, spec #37). */
export const NAME_SHAPES = [
  'ABE_AWS_READ_<ENV>',
  'ABE_AWS_WRITE_<ENV>',
  'ABE_DB_READ_URL_<ENV>',
  'ABE_DB_WRITE_URL_<ENV>',
] as const;

const NAME = /^ABE_(AWS|DB)_(READ|WRITE)(_URL)?_([A-Z][A-Z0-9]*)$/;

/** A name's service, access and environment; `undefined` for any name outside `NAME_SHAPES`. */
export const parseReachName = (name: string): ReachName | undefined => {
  const [, service, access, url, env] = NAME.exec(name) ?? [];

  if (service === undefined || access === undefined || env === undefined) return undefined;
  // AWS names carry no `_URL`, database names always do.
  if ((service === 'DB') !== (url !== undefined)) return undefined;

  return {
    name,
    service: service === 'AWS' ? 'aws' : 'db',
    access: access === 'READ' ? 'read' : 'write',
    environment: env.toLowerCase(),
  };
};

/** The name for an environment: `reachName('db', 'read', 'test')` → `ABE_DB_READ_URL_TEST`. */
export const reachName = (service: ReachService, access: ReachAccess, environment: string) =>
  `ABE_${service.toUpperCase()}_${access.toUpperCase()}${service === 'db' ? '_URL' : ''}_${environment.toUpperCase()}`;

/** A Reach name granting writes (`ABE_AWS_WRITE_PROD`, `ABE_DB_WRITE_URL_TEST`). */
export const isWriteName = (name: string): boolean => /^ABE_(.+_)?WRITE(_.+)?$/.test(name);

/** Where a database URL's value is kept: a Secrets Manager secret (never the layer file). */
export const SecretSource = z.strictObject({ secret: z.string().min(1) });
export type SecretSource = z.infer<typeof SecretSource>;

/**
 * The IAM policy file `abe-write` gets in an environment: a JSON file named from the top of the
 * checkout Terraform applies (`policies/test-write.json`). None named, abe-write
 * can change nothing.
 */
export const WritePolicy = z
  .string()
  .regex(
    /^(?!\/)(?!(.*\/)?\.\.\/)[\w./-]+\.json$/,
    'a JSON file named from the top of its checkout (policies/test-write.json)',
  );

/**
 * One environment the org lists: its AWS account, the write policy behind its `abe-write` role,
 * and the sources behind its database names.
 */
export const Environment = z.strictObject({
  account: z
    .string({ error: 'a 12-digit AWS account id, quoted ("111111111111") so YAML keeps it text' })
    .regex(/^\d{12}$/, 'a 12-digit AWS account id'),
  region: z.string().min(1).optional(),
  writePolicy: WritePolicy.optional(),
  db: z.strictObject({ read: SecretSource.optional(), write: SecretSource.optional() }).optional(),
});
export type Environment = z.infer<typeof Environment>;

/** The org file's `environments`: name → environment. */
export const Environments = z.record(
  z.string().regex(ENVIRONMENT_NAME, 'an environment name (lowercase letters and digits)'),
  Environment,
);
export type Environments = z.infer<typeof Environments>;
