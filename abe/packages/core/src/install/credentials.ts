/**
 * Abe env files and credentials (ADR 0028, superseding ADR 0027's credentials part): three files
 * in the main checkout, `.abe/abe.dev.env`, `.abe/abe.test.env` and `.abe/abe.prod.env`, hold the
 * values a repo's checks and `abe run` get per environment; each environment's aws profile, kept
 * in your own Layer's block for the main checkout (`checkouts: { <main>: { credentials } }`, ADR
 * 0025), adds its short-lived keys. Every value in the three files is redacted from what Abe hands
 * on: session logs, check output, run output.
 */
import { z } from 'zod';
import { isEnvFileName, parseEnvFile } from './install-gate';

/** An environment's name, as the repo's evidence names it: `local`, `test`, `prod`, `stage`. */
export const EnvironmentName = z
  .string()
  .regex(/^[a-z][\w.-]*$/, 'an environment name, like local, test or prod');

/** An aws profile's name, as `aws configure list-profiles` says it. */
export const AwsProfileName = z
  .string()
  .regex(/^[\w.+@-]+$/, 'an aws profile name, like shop-test');

/**
 * An env file: a path in the main checkout (`.env.test`) or from / (`/home/me/shop.env`).
 * Never `..` out of the checkout.
 */
export const EnvFilePath = z
  .string()
  .min(1)
  .refine((p) => !p.split('/').includes('..'), 'an env file in the checkout, or from /');

/** One environment's pick: an aws profile, an env file, both, or neither (none). */
export const EnvironmentCredentials = z.strictObject({
  awsProfile: AwsProfileName.nullable().optional(),
  envFile: EnvFilePath.nullable().optional(),
});
export type EnvironmentCredentials = z.infer<typeof EnvironmentCredentials>;

/** Every environment's pick, by name. */
export const Credentials = z.record(EnvironmentName, EnvironmentCredentials);
export type Credentials = z.infer<typeof Credentials>;

/**
 * The environments a repo's Abe env files are for (ADR 0028): `dev` (this Mac's app), `test` (the
 * checks' and the test systems') and `prod`; agents reach only those on for them (ADR 0029).
 */
export const ABE_ENVS = ['dev', 'test', 'prod'] as const;
export const AbeEnv = z.enum(ABE_ENVS);
export type AbeEnv = z.infer<typeof AbeEnv>;

/** An environment's Abe env file, from the main checkout's top. */
export const abeEnvFile = (env: AbeEnv): string => `.abe/abe.${env}.env`;

/** What every Abe env file matches, for git's exclude. */
export const ABE_ENV_GLOB = '.abe/abe.*.env';

/** Whether a path (from the top) is an Abe env file. */
export const isAbeEnvFile = (path: string): boolean => ABE_ENVS.some((e) => path === abeEnvFile(e));

/**
 * The checks' environment when the install recorded none (its Checks stage judges it): they get
 * its Abe env file's values and its aws profile's short-lived keys, as `abe run --env` does.
 */
export const DEFAULT_CHECKS_ENV: AbeEnv = 'dev';

/**
 * An Abe env file as the Env files stage first writes it: a header alone, no value. The person
 * fills it in the editor; serve never writes over one that is there.
 */
export const abeEnvHeader = (env: AbeEnv): string =>
  [
    `# Abe env file: ${env}. One KEY=value per line.`,
    `# abe run --env ${env} gets exactly these values, plus the short-lived keys of the aws profile picked for ${env}; the checks too when Checks picked ${env}.`,
    '# Kept out of git, linked into every card worktree; its values never appear in logs.',
    '',
  ].join('\n');

/**
 * What a card's or an install's session is told of the Abe env files that are there (`envs`): where
 * they are, and that their values stay out of what it writes. Locally they are the main checkout's,
 * linked into its worktree; on a box (`box`) the Mac's, synced read-only into its clone (3.2.1).
 * None when none is there: it is never told of files it has not got.
 */
export const abeEnvLine = (envs: readonly AbeEnv[], where: 'local' | 'box'): string | null => {
  const files = ABE_ENVS.filter((e) => envs.includes(e)).map(abeEnvFile);

  if (files.length === 0) return null;
  const hold = `Abe env files: ${files.join(', ')} ${files.length === 1 ? 'holds' : 'hold'} this repo's values per environment`;
  const never = "Never print, quote or commit a value; a missing key is the person's to add there.";

  return where === 'box'
    ? `${hold}, synced read-only from the person's Mac into this clone (the Mac's copy is the one to change). ${never}`
    : `${hold}, in the main checkout and linked into this worktree. abe run hands a script dev's (abe run <script> --env test for test's; prod not yet), the checks the environment abe.yaml's \`checksEnv\` names (the install writes it at Checks; dev when unset), each with its aws profile's short-lived keys. ${never}`;
};

/**
 * An env file Read found, at the top or in a workspace: its key names (never a value), whether
 * git tracks it, whether it is an example, and what today's rules say of it.
 */
export const EnvFileFound = z.object({
  path: z.string(),
  keys: z.array(z.string()),
  tracked: z.boolean(),
  /** `.env.example`, `.env.sample`: no value of the person's. */
  example: z.boolean(),
  /** Why it holds cloud credentials (`cloudCredentialsWhy`); null: it does not look so. */
  credential: z.string().nullable(),
  /** Every key is public config (`publicEnvOnly`, the repo's vite prefixes too). */
  publicOnly: z.boolean(),
  /**
   * Every key name is in the env example beside it (its folder's, else the top's): CI runs with
   * those values. Unsaid in a record from before: false.
   */
  inExample: z.boolean().optional(),
  /** Who copies the example to it (`cp .env.example .env`): CI or a package script; unsaid: none. */
  copiedBy: z.enum(['ci', 'script']).optional(),
});
export type EnvFileFound = z.infer<typeof EnvFileFound>;

/** An env example's name (`.env.example`, `backend/.env.sample`): an env file's, but no real one. */
export const isEnvExampleName = (name: string): boolean =>
  /^(\.env(\.[\w.-]+)?|[\w.-]+\.env(\.[\w-]+)?)$/.test(name) &&
  !isEnvFileName(name) &&
  /(example|sample|template|dist)/i.test(name);

/** The keys an aws profile becomes for the app and the checks: short-lived, never the aws folder. */
export const AWS_SESSION_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

const Exported = z.looseObject({
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1).optional(),
});

/**
 * `aws configure export-credentials --format process`'s answer as the keys a process gets; null:
 * none (a login expired, a profile with no credentials).
 */
export const awsSessionEnv = (text: string): Record<string, string> | null => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const r = Exported.safeParse(doc);

  if (!r.success) return null;

  return {
    AWS_ACCESS_KEY_ID: r.data.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: r.data.SecretAccessKey,
    ...(r.data.SessionToken === undefined ? {} : { AWS_SESSION_TOKEN: r.data.SessionToken }),
  };
};

/**
 * An aws profile's region (`aws configure get region`'s answer) as a process gets it beside the
 * short-lived keys (ADR 0029: no profile of `~/.aws` is read there): `AWS_REGION` and
 * `AWS_DEFAULT_REGION`; none when it names none.
 */
export const awsRegionEnv = (text: string): Record<string, string> => {
  const region = text.trim();

  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)
    ? { AWS_REGION: region, AWS_DEFAULT_REGION: region }
    : {};
};

/** The names injected that are no secret: a region, said in logs as it is. */
const NOT_SECRET = new Set(['AWS_REGION', 'AWS_DEFAULT_REGION']);

/**
 * The values injected into a process as secrets to redact (ADR 0028): each by its key's name,
 * from whatever Abe hands a session of that process (its output, its logs, a check's report).
 */
export const injectedSecrets = (
  env: Readonly<Record<string, string>>,
): { kind: string; value: string }[] =>
  Object.entries(env)
    .filter(([k, v]) => v.trim() !== '' && !NOT_SECRET.has(k))
    .map(([kind, value]) => ({ kind, value }));

/**
 * Every value in a checkout's Abe env files (each file's text by environment) as secrets to
 * redact, each by its key's name: all three, whichever one a process got, so no environment's
 * value shows in a session log, a check's output or a run's.
 */
export const abeEnvSecrets = (
  texts: Readonly<Partial<Record<AbeEnv, string>>>,
): { kind: string; value: string }[] =>
  ABE_ENVS.flatMap((e) => injectedSecrets(Object.fromEntries(parseEnvFile(texts[e] ?? ''))));
