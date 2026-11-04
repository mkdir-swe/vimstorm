/**
 * The Mac database (#349): Abe's own Postgres on the Mac, one Docker container `abe-pg` (the
 * boxes' image, `POSTGRES_IMAGE`) on its own volume, on 127.0.0.1 at a port `serve` picks once and
 * keeps (a label on the container), with a role and database of their own per local session
 * (`abe_<session>`) and per prototype (`abe_proto_<hex>`), each closed to the others as a box's
 * workspace database is. A repo's database hook (its `db` hook point) is used instead when it has
 * one. Every pack script run also gets `ABE_PORT_BASE`, the first of `PORT_SPAN` free loopback
 * ports held for it. Rules only: the container and the ports are the ports package's.
 */
import { appEnv } from '../prototype/prototype';
import { type ContainerSpec } from '../ports';
import { parseEnvFile } from '../install/install-gate';
import { ENV_EXAMPLES } from '../install/install-read';
import { abeEnvFile } from '../install/credentials';
import { CI_FILES } from './setup';
import { DEFAULT_HOOKS } from '../repo-hooks';
import { WORKSPACE_DATABASE } from './session';
import { POSTGRES_IMAGE } from '../box/workspace';

/** The Mac database's container, its data volume and the labels that find it again. */
export const MAC_DB = {
  container: 'abe-pg',
  volume: 'abe-pg-data',
  label: 'abe.role',
  role: 'mac-postgres',
  /** The host port it was published on, kept with the container. */
  portLabel: 'abe.pg.port',
} as const;

/** The variable every pack script run gets: the first of its `PORT_SPAN` loopback ports. */
export const PORT_BASE = 'ABE_PORT_BASE';
export const PORT_SPAN = 10;
/** Where port bases are looked for: above the usual dev ports, below the OS's ephemeral range. */
export const PORT_RANGE = { first: 41000, last: 48990 } as const;

const IDENT = /^abe_[a-z0-9_]{1,59}$/;

const ident = (raw: string): string => {
  const name = `abe_${raw.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

  if (!IDENT.test(name)) throw new Error(`no database name for ${raw}`);

  return name;
};

/** A local session's database (`abe_4_a1b2`) and a prototype's (`abe_proto_3fa2c1`). */
export const macDbName = {
  session: (id: string): string => ident(id),
  prototype: (id: string): string => ident(id),
};

const checked = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`not a local database name: ${name}`);

  return name;
};

/** A value that is Postgres': another engine's is the hook's to give. */
const POSTGRES = /^postgres(ql)?:\/\//i;

/** A CI line that sets `DATABASE_URL` to a Postgres URL (YAML's `KEY: value` or a shell's `KEY=value`). */
const CI_POSTGRES = new RegExp(
  `^[^#\\n]*\\b${WORKSPACE_DATABASE}\\s*[:=]\\s*["']?postgres(ql)?:\\/\\/`,
  'im',
);

/**
 * Whether a file names the database: `DATABASE_URL` as a word; in an env example or dev's Abe env
 * file (this machine's app's), a `DATABASE_URL` that is empty or Postgres; in a CI file, one set
 * to a Postgres URL (its checks run on one; a secret's names no engine).
 */
const namesDatabase = (f: { path: string; text: string }): boolean => {
  if (CI_FILES.some((re) => re.test(f.path))) return CI_POSTGRES.test(f.text);
  if (!ENV_EXAMPLES.some((e) => e === f.path) && f.path !== abeEnvFile('dev'))
    return new RegExp(`\\b${WORKSPACE_DATABASE}\\b`).test(f.text);
  const value = parseEnvFile(f.text).get(WORKSPACE_DATABASE);

  return value !== undefined && (value === '' || POSTGRES.test(value));
};

/**
 * Where a repo's database comes from: its `db` hook, Abe's Mac database when one of
 * its files (its Verification pack's skill, `DB_PACK_FILES` and its CI files, path and text) names
 * `DATABASE_URL` (`said`: the first that does), or none.
 */
export const dbNeed = (o: {
  hook: boolean;
  files: readonly { path: string; text: string }[];
}): { by: 'hook' } | { by: 'mac'; said: string } | { by: 'none' } => {
  if (o.hook) return { by: 'hook' };
  const said = o.files.find(namesDatabase)?.path;

  return said === undefined ? { by: 'none' } : { by: 'mac', said };
};

/**
 * The role and database `name`, made when missing (psql's `\gexec`), the role's password set to
 * `password`, the database closed to every other role and the maintenance databases closed to it.
 * Its first answer line says whether the database was `new` or `had` (`madeOf`).
 */
export const macDatabaseSql = (name: string, password: string): string => {
  const db = checked(name);

  if (!/^[0-9a-f]{16,}$/.test(password)) throw new Error('a database password is hex');

  return [
    `SELECT CASE WHEN EXISTS (SELECT FROM pg_database WHERE datname = '${db}') THEN 'had' ELSE 'new' END;`,
    `SELECT 'CREATE ROLE ${db} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${db}')\\gexec`,
    `ALTER ROLE ${db} LOGIN PASSWORD '${password}';`,
    `SELECT 'CREATE DATABASE ${db} OWNER ${db}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\\gexec`,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;',
    'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;',
  ].join('\n');
};

/** Whether `macDatabaseSql`'s answer says the database was just made. */
export const madeOf = (stdout: string): boolean => stdout.trim().split('\n')[0]?.trim() === 'new';

/** The database dropped with whatever is still connected, then its role. */
export const macDropSql = (name: string): string => {
  const db = checked(name);

  return [`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`, `DROP ROLE IF EXISTS ${db};`].join('\n');
};

/**
 * Who reaches the Mac database (`pg_hba.conf`, written whenever `serve` starts it): its superuser
 * only by peer inside its container (`docker exec --user postgres`), each role only the database
 * of its own name with its password, no one else.
 */
export const MAC_PG_HBA = [
  '# Written by abe serve (#349).',
  'local all postgres peer',
  'local all all reject',
  'host sameuser all all scram-sha-256',
  'host all all all reject',
  '',
].join('\n');

/** A Mac database's URL, on the container's loopback port. */
export const macDatabaseUrl = (name: string, password: string, port: number): string =>
  `postgresql://${checked(name)}:${password}@127.0.0.1:${port}/${name}`;

/** The Mac database's container: published on loopback only, back after a crash or Docker's start. */
export const macPostgresSpec = (o: {
  password: string;
  port: number;
  names?: { container: string; volume: string };
}): ContainerSpec => ({
  name: o.names?.container ?? MAC_DB.container,
  image: POSTGRES_IMAGE,
  labels: { [MAC_DB.label]: MAC_DB.role, [MAC_DB.portLabel]: String(o.port) },
  // Only for the image's first start; serve speaks to it as postgres by peer, inside.
  env: { POSTGRES_PASSWORD: o.password },
  mounts: [
    {
      type: 'volume',
      source: o.names?.volume ?? MAC_DB.volume,
      target: '/var/lib/postgresql/data',
    },
  ],
  network: 'bridge',
  publish: [{ host: '127.0.0.1', port: o.port, target: 5432 }],
  limits: { memory: '1g', pids: 1024, shm: '256m' },
  restart: 'unless-stopped',
});

/**
 * A pack script's environment (a prototype's start, stop and seed, `abe run`): `APP_ENV` of
 * `serve`'s (never its `DATABASE_URL`: each gets its own), then `own`, then its database and port
 * base.
 */
export const packScriptEnv = (
  serve: Readonly<Record<string, string | undefined>>,
  own: Readonly<Record<string, string>>,
  o: { database?: string | undefined; portBase?: number | undefined },
): Record<string, string> => ({
  ...appEnv(serve, own),
  ...(o.database === undefined ? {} : { [WORKSPACE_DATABASE]: o.database }),
  ...(o.portBase === undefined ? {} : { [PORT_BASE]: String(o.portBase) }),
});

/**
 * Whether a check or a pack script run in environment `env` gets its session's own database (the
 * repo's hook's or Abe's local one) over that environment's Abe env file's `DATABASE_URL`: in dev
 * only, this machine's app (ADR 0028), so each session has its own and none shares one. In test
 * or prod (on for agents, ADR 0029) that file's is the one, never this machine's.
 */
export const takesOwnDatabase = (env: string): boolean => env === 'dev';

/** Why a database could not be had, for its words. */
export type DbFailure =
  | { kind: 'docker-down' | 'no-docker'; repo: string }
  | {
      kind: 'hook' | 'seed';
      exit: number | null;
      said: string;
      /** The script that ran (the `db` or `seed` hook's path); none: today's place. */
      script?: string;
    }
  | { kind: 'mac'; said: string };

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);

const ran = (script: string, exit: number | null, said: string, ok: string) => {
  const last = lastLine(said);
  const exited = exit === 0 ? `${script} ${ok}` : `${script} exited ${exit ?? ''}`;
  const what = exit === null ? `${script} took too long` : exited;

  return last === undefined ? what : `${what} (last line: "${last}")`;
};

/**
 * What a prototype or a local session says when it has no database, in words with the fix (the
 * screen adds `· Retry ⏎`): never the start's raw `DATABASE_URL is not set`.
 */
export const dbFailureWords = (f: DbFailure): string => {
  switch (f.kind) {
    case 'docker-down':
      return `${f.repo} needs a database and Docker isn't running.\nStart Docker (Docker Desktop, OrbStack or colima)`;
    case 'no-docker':
      return `${f.repo} needs a database and Docker isn't installed.\nInstall Docker Desktop, OrbStack or colima`;
    case 'hook':
      return `The repo's database hook failed: ${ran(`${f.script ?? DEFAULT_HOOKS.db} start`, f.exit, f.said, 'printed no database URL as its last line')}.\nFix the hook`;
    case 'seed':
      return `The new database was made but ${ran(f.script ?? DEFAULT_HOOKS.seed, f.exit, f.said, 'printed no error')}.\nFix the seed`;
    case 'mac':
      return `Abe's local database (${MAC_DB.container}) did not start: ${lastLine(f.said) ?? 'no answer'}.\nCheck Docker`;
  }
};

/** What `ensure` answered: the database's URL and whether it was just made, or why not. */
export type MacDbAnswer =
  | { ok: true; url: string; made: boolean }
  | { ok: false; failure: Extract<DbFailure, { kind: 'docker-down' | 'no-docker' | 'mac' }> };

/**
 * Abe's Mac database (the ports package's `macDatabase`): `ensure` makes the container on first
 * need and the database `name` when missing; `drop` removes the database and its role (gone
 * already is fine); `docker` says whether Docker answers.
 */
export type MacDatabase = {
  ensure: (name: string, repo: string) => Promise<MacDbAnswer>;
  drop: (name: string) => Promise<{ ok: true } | { ok: false; said: string }>;
  docker: () => Promise<'up' | 'down' | 'missing'>;
};
