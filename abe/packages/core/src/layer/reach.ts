/**
 * Reach (ADR 0010, spec #37): the repo's environments and grants turned into exactly the
 * `ABE_*` variables a session gets, the AWS profiles behind its AWS names, the role a profile's
 * credentials come from, and `abe reach check`, which refuses a Reach set up wrong. The names and
 * the `environments` shape are `settings/reach.ts`; the Override rule is the Layers' own.
 */
import { z } from 'zod';
import {
  type Environment,
  type Environments,
  isWriteName,
  type LayerSource,
  type Merged,
  mergeSettings,
  NAME_SHAPES,
  parseReachName,
  type ReachAccess,
  type ReachName,
  reachName,
  readLayer,
  type SecretSource,
} from './settings';

/** Where a session runs: write names exist only in your cloud environment (ADR 0016). */
export const REACH_TARGETS = ['cloud', 'local'] as const;
export type ReachTarget = (typeof REACH_TARGETS)[number];

/** What the settings in force grant: the repo's environments and the write names granted. */
export type Reach = { environments: Environments; writes: readonly string[] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/**
 * The Reach in force: the repo's environments, and each write name an Override (with its reason)
 * in the repo's file grants (ADR 0010, 0030). A plain write is refused by the merge; your own
 * Override never grants a write.
 */
export const reachOf = (merged: Merged): Reach => {
  const steps = merged
    .explain('reach')
    .layers.filter((s) => s.entry === 'override' && s.applied && s.layer === 'repo');

  return {
    environments: merged.values.environments,
    writes: [...new Set(steps.flatMap((s) => strings(s.written).filter(isWriteName)))],
  };
};

/** One variable a session gets: an AWS name's profile, or where a database name's value is kept. */
export type ReachVar = ReachName &
  (
    | { kind: 'profile'; profile: string; region: string | null }
    | { kind: 'secret'; source: SecretSource; region: string | null }
  );

/** The AWS profile behind an AWS name: `abe-read-test`. */
export const profileName = (access: ReachAccess, environment: string) =>
  `abe-${access}-${environment}`;

/** Whether a profile name is one of Reach's (whose credentials come from `abe reach creds`). */
export const isReachProfile = (profile: string): boolean =>
  /^abe-(read|write)-[a-z][a-z0-9]*$/.test(profile);

const ACCESS: readonly ReachAccess[] = ['read', 'write'];

const sorted = (envs: Environments) =>
  Object.entries(envs).sort(([a], [b]) => (a < b ? -1 : Number(a > b)));

const varsOf = (environment: string, env: Environment, allowed: (name: string) => boolean) => {
  const region = env.region ?? null;
  const aws = ACCESS.map((access): ReachVar => ({
    name: reachName('aws', access, environment),
    service: 'aws',
    access,
    environment,
    kind: 'profile',
    profile: profileName(access, environment),
    region,
  }));
  const db = ACCESS.flatMap((access): ReachVar[] => {
    const source = env.db?.[access];

    return source === undefined
      ? []
      : [
          {
            name: reachName('db', access, environment),
            service: 'db',
            access,
            environment,
            kind: 'secret',
            source,
            region,
          },
        ];
  });

  return [...aws, ...db].filter((v) => allowed(v.name));
};

/**
 * The names a session gets, environment by environment: every read name (a database's where the
 * repo keeps its URL), and the granted write names, only in the cloud.
 */
export const reachVars = (reach: Reach, target: ReachTarget): ReachVar[] => {
  const writes = new Set(target === 'cloud' ? reach.writes : []);

  return sorted(reach.environments).flatMap(([name, env]) =>
    varsOf(name, env, (n) => !isWriteName(n) || writes.has(n)),
  );
};

/**
 * The session's `ABE_*` variables: each AWS name's profile, each database name's URL from the
 * secrets read (`secret id → value`). A secret not read is named, never handed on empty.
 */
export const reachEnv = (
  vars: readonly ReachVar[],
  secrets: Readonly<Record<string, string>>,
): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] } => {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const v of vars) {
    if (v.kind === 'profile') env[v.name] = v.profile;
    else if (Object.hasOwn(secrets, v.source.secret)) env[v.name] = secrets[v.source.secret] ?? '';
    else missing.push(v.source.secret);
  }

  return missing.length === 0 ? { ok: true, env } : { ok: false, missing: [...new Set(missing)] };
};

export const AwsProfile = z.object({
  profile: z.string(),
  name: z.string(),
  environment: z.string(),
  access: z.enum(ACCESS),
  credentialProcess: z.string(),
  region: z.string().nullable(),
});
export type AwsProfile = z.infer<typeof AwsProfile>;

/** One AWS profile per AWS name; its credentials come from `abe reach creds`. */
export const awsProfiles = (vars: readonly ReachVar[]): AwsProfile[] =>
  vars.flatMap((v) =>
    v.kind === 'profile'
      ? [
          {
            profile: v.profile,
            name: v.name,
            environment: v.environment,
            access: v.access,
            credentialProcess: `abe reach creds ${v.environment} ${v.access}`,
            region: v.region,
          },
        ]
      : [],
  );

/** The profiles as AWS config text (`~/.aws/config`'s format). */
export const awsConfigText = (profiles: readonly AwsProfile[]): string =>
  profiles
    .map((p) =>
      [
        `[profile ${p.profile}]`,
        `credential_process = ${p.credentialProcess}`,
        ...(p.region === null ? [] : [`region = ${p.region}`]),
        '',
      ].join('\n'),
    )
    .join('\n');

/** The roles every environment account holds (ADR 0016). */
export const ROLES: Readonly<Record<ReachAccess, string>> = {
  read: 'abe-read',
  write: 'abe-write',
};

/** Credentials last an hour. */
export const CREDS_SECONDS = 3600;

export type CredsPlan = {
  environment: string;
  access: ReachAccess;
  roleArn: string;
  region: string | null;
  durationSeconds: number;
};

const listed = (envs: Environments) => {
  const names = Object.keys(envs).sort();

  return names.length === 0 ? 'none' : names.join(', ');
};

/**
 * The one AssumeRole behind `abe reach creds <env> <access>`, or why there is none: an
 * environment the repo does not list, or a write not granted or asked for off a box (refused
 * before any AWS call).
 */
export const credsPlan = (
  reach: Reach,
  environment: string,
  access: ReachAccess,
  /** Where this `serve` runs: write credentials exist only in your cloud environment. */
  where: ReachTarget,
):
  | { ok: true; plan: CredsPlan }
  | { ok: false; code: 'unknown-environment' | 'no-reach'; message: string } => {
  const env = Object.hasOwn(reach.environments, environment)
    ? reach.environments[environment]
    : undefined;

  if (env === undefined)
    return {
      ok: false,
      code: 'unknown-environment',
      message: `${environment} is not an environment the repo lists (${listed(reach.environments)})`,
    };
  const name = reachName('aws', access, environment);

  if (access === 'write' && !reach.writes.includes(name))
    return { ok: false, code: 'no-reach', message: `${name} is not granted in this repo` };
  if (access === 'write' && where === 'local')
    return {
      ok: false,
      code: 'no-reach',
      message: `${name} is never given locally: only in your cloud environment`,
    };

  return {
    ok: true,
    plan: {
      environment,
      access,
      roleArn: `arn:aws:iam::${env.account}:role/${ROLES[access]}`,
      region: env.region ?? null,
      durationSeconds: CREDS_SECONDS,
    },
  };
};

/** The assumed role's session name: `abe-<login>`, within AWS's 64 characters. */
export const sessionName = (login: string): string => `abe-${login}`.slice(0, 64);

/** `abe reach creds`: what a `credential_process` prints (AWS's Version 1 shape). */
export const ReachCredsData = z.object({
  Version: z.literal(1),
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1),
  Expiration: z.string().min(1),
});
export type ReachCredsData = z.infer<typeof ReachCredsData>;

/** `abe reach env`: the names a session gets and their values, for this repo. */
export const ReachEnvData = z.object({
  target: z.enum(REACH_TARGETS),
  env: z.record(z.string(), z.string()),
});
export type ReachEnvData = z.infer<typeof ReachEnvData>;

/** `abe reach profiles`: one profile per AWS name, and the AWS config text holding them. */
export const ReachProfilesData = z.object({
  target: z.enum(REACH_TARGETS),
  profiles: z.array(AwsProfile),
  config: z.string(),
});
export type ReachProfilesData = z.infer<typeof ReachProfilesData>;

/** `abe reach check`: the files checked, all clean (any problem exits 1). */
export const ReachCheckData = z.object({ files: z.array(z.string()) });
export type ReachCheckData = z.infer<typeof ReachCheckData>;

/** Something wrong with a Reach: the file, where in it (`reach[2]`), and why. */
export type ReachProblem = { code: string; file: string; path: string; reason: string };

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where a Layers problem sits in its file. */
const pathOf = (code: string, key: string | null) => {
  if (key === null) return '(file)';

  return code === 'reason-required' || code === 'invalid-override'
    ? `overrides.${key}${code === 'reason-required' ? '.reason' : ''}`
    : key;
};

/** The Layers' own problems that are Reach's: the Override rule, and the environments' shape. */
const KEPT: Readonly<Record<string, readonly string[] | 'all'>> = {
  reach: ['reason-required', 'invalid-override'],
  environments: 'all',
};

const layerProblems = (src: LayerSource): ReachProblem[] =>
  readLayer(src).problems.flatMap((p) => {
    const kept = p.key === null ? 'all' : KEPT[p.key];

    return kept === 'all' || kept?.includes(p.code) === true
      ? [{ code: p.code, file: p.file, path: pathOf(p.code, p.key), reason: p.message }]
      : [];
  });

const SHAPES = NAME_SHAPES.join(', ');

const nameProblem = (
  envs: Environments,
  raw: unknown,
  plain: boolean,
): Omit<ReachProblem, 'file' | 'path'> | undefined => {
  const name = typeof raw === 'string' ? parseReachName(raw) : undefined;

  if (name === undefined)
    return { code: 'unknown-name', reason: `${JSON.stringify(raw)} is not one of ${SHAPES}` };
  const env = Object.hasOwn(envs, name.environment) ? envs[name.environment] : undefined;

  if (env === undefined)
    return {
      code: 'unknown-environment',
      reason: `${name.environment.toUpperCase()} is not an environment the repo lists (${listed(envs)})`,
    };
  if (name.access === 'write' && plain)
    return {
      code: 'override-required',
      reason: `${name.name} is a write: it is granted only by an Override with a reason`,
    };
  if (name.service === 'db' && env.db?.[name.access] === undefined)
    return {
      code: 'no-source',
      reason: `the repo keeps no ${name.access} database URL for ${name.environment} (environments.${name.environment}.db.${name.access})`,
    };

  return undefined;
};

const namesProblems = (src: LayerSource, envs: Environments): ReachProblem[] => {
  if (!('doc' in src) || !isMap(src.doc)) return [];
  const { reach, overrides } = src.doc;
  const override = isMap(overrides) ? overrides.reach : undefined;
  const lists: [string, unknown][] = [
    ['reach', reach],
    ['overrides.reach.value', isMap(override) ? override.value : undefined],
  ];

  return lists.flatMap(([path, list]): ReachProblem[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list))
      return [
        {
          code: 'invalid-setting',
          file: src.file,
          path,
          reason: `${path} is a list of ABE_* names`,
        },
      ];

    return list.flatMap((raw: unknown, i) => {
      const problem = nameProblem(envs, raw, path === 'reach');

      return problem === undefined ? [] : [{ ...problem, file: src.file, path: `${path}[${i}]` }];
    });
  });
};

/**
 * `abe reach check`: the repo's file (ADR 0030). Every name is one of the four shapes, for an
 * environment the repo lists, with a database URL it keeps; a write only by an Override with a
 * reason.
 */
export const checkReach = (sources: readonly LayerSource[]): ReachProblem[] => {
  const repo = sources.find((s) => s.place === 'repo');
  const envs = repo === undefined ? {} : mergeSettings([repo]).values.environments;

  return sources.flatMap((src) => [...layerProblems(src), ...namesProblems(src, envs)]);
};

/** A refusal's message: one line per problem. */
export const reachProblemList = (problems: readonly ReachProblem[]): string =>
  problems.map((p) => `${p.file}: ${p.path}: ${p.reason}`).join('\n');

/** A value as an env file line holds it: as is when plain, else single-quoted. */
const shellValue = (v: string) =>
  /^[\w@%+=:,./-]*$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;

export const reachEnvText = (d: ReachEnvData): string =>
  Object.entries(d.env)
    .map(([name, value]) => `${name}=${shellValue(value)}\n`)
    .join('');

export const reachCheckText = (d: ReachCheckData): string =>
  `${d.files.length} file${d.files.length === 1 ? '' : 's'}: Reach clean\n`;

/** Exactly the JSON a `credential_process` must print. */
export const reachCredsText = (d: ReachCredsData): string => `${JSON.stringify(d)}\n`;
