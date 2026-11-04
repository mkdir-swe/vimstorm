/**
 * One database rule for the Mac (#349), for prototypes, developer prototypes, local sessions and
 * local Factory runs: a checkout whose repo has the database hook (its `db` hook point) gets the
 * hook's (`start` with `ABE_DB_NAME`, the URL its last line; `stop` to end it); one whose pack
 * names `DATABASE_URL` (or its env example, dev's Abe env file or CI a Postgres one) gets its own
 * database in Abe's Mac database (`abe-pg`); any other none.
 * A database just made is seeded once with the repo's `seed` hook, when it has one.
 * `serve`'s own `DATABASE_URL` is never handed on. The rules are core's (`mac-database.ts`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  databaseUrlOf,
  DB_PACK_FILES,
  DEFAULT_HOOKS,
  type DbFailure,
  dbNeed,
  type MacDatabase,
  PACK_SCRIPT_TIMEOUT_MS,
  REPO_SKILLS_DIR,
  type RepoHooks,
  type ScriptRan,
} from '@abe/core';
import { ciFiles } from '@abe/ports';

/** How long the database hook's `stop` may take. */
const DB_STOP_MS = 60_000;

/** A pack script run to its end in `cwd` with exactly `env`. */
export type RunScript = (o: {
  cwd: string;
  script: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) => Promise<ScriptRan>;

/** A database had: its URL, where it came from, its name, and whether it was just made. */
export type HadDb = {
  url: string;
  by: 'hook' | 'mac';
  name: string;
  made: boolean;
  seeded: boolean;
};

export type DbAnswer = { ok: true; db: HadDb | undefined } | { ok: false; failure: DbFailure };

export type Databases = {
  /** Where `dir`'s database comes from: the hook, the Mac database or none. */
  need: (dir: string) => ReturnType<typeof dbNeed>;
  /**
   * The database of `dir` (a checkout): `mac` names its database in the Mac database, `hook` the
   * name its hook gets (`ABE_DB_NAME`); `env` is a pack script's (the hook's and the seed's).
   */
  ensure: (o: {
    dir: string;
    /** The repo's name, for the words when there is none. */
    repo: string;
    mac: string;
    hook: string;
    env: Readonly<Record<string, string>>;
    /** Seed a database just made (the `seed` hook, when the repo has one). */
    seed: boolean;
    /** How the hook and the seed run (logged where their prototype's or session's are). */
    run: RunScript;
  }) => Promise<DbAnswer>;
  /**
   * Its end: the hook's `stop`, or the Mac database dropped (only with `drop`: a stopped
   * prototype keeps its data). What was done, in words, and whether it is gone (`done`: a hook's
   * `stop` exited 0, the database dropped); undefined when there was nothing to end.
   */
  release: (o: {
    dir: string;
    mac: string;
    hook: string;
    env: Readonly<Record<string, string>>;
    by: 'hook' | 'mac' | undefined;
    run: RunScript;
  }) => Promise<Released | undefined>;
};

/** A database's end: what was done, and whether it is gone (else it is still to end). */
export type Released = { done: boolean; said: string };

/** The repo's Verification pack skills (the `verify` hook's, else `verify-*`), by their files. */
const verifySkills = (dir: string, h: RepoHooks): string[] => {
  try {
    return readdirSync(join(dir, REPO_SKILLS_DIR))
      .filter((n) => (h.verify === null ? n.startsWith('verify-') : n === h.verify))
      .sort()
      .map((n) => `${REPO_SKILLS_DIR}/${n}/SKILL.md`);
  } catch {
    return [];
  }
};

/**
 * The files that may say `DATABASE_URL`: its Verification pack's skill first, then its settings,
 * env example and dev's Abe env file, then its CI files (a first install's Checks has no pack yet).
 */
const packFiles = (dir: string, h: RepoHooks) => [
  ...[...verifySkills(dir, h), ...DB_PACK_FILES].flatMap((path) => {
    try {
      return [{ path, text: readFileSync(join(dir, path), 'utf8') }];
    } catch {
      return [];
    }
  }),
  ...ciFiles(dir),
];

const said = (ran: ScriptRan) => `${ran.stdout}\n${ran.stderr}`;

export const openDatabases = (o: {
  /** Abe's Mac database; none on a box (its workspace has the box's). */
  mac: MacDatabase | undefined;
  /** A checkout's hook points (its `db` and `seed`); none: today's places. */
  hooks?: (dir: string) => RepoHooks;
}): Databases => {
  const hooksOf = (dir: string) => o.hooks?.(dir) ?? DEFAULT_HOOKS;
  const need: Databases['need'] = (dir) => {
    const h = hooksOf(dir);

    return dbNeed({ hook: existsSync(join(dir, h.db)), files: packFiles(dir, h) });
  };

  return {
    need,
    ensure: async ({ dir, repo, mac, hook, env, seed, run }) => {
      const by = need(dir);
      const h = hooksOf(dir);
      let had: HadDb;

      if (by.by === 'none') return { ok: true, db: undefined };
      if (by.by === 'hook') {
        const ran = await run({
          cwd: dir,
          script: h.db,
          args: ['start'],
          env: { ...env, ABE_DB_NAME: hook },
          timeoutMs: PACK_SCRIPT_TIMEOUT_MS,
        });
        const url = ran.exit === 0 ? databaseUrlOf(ran.stdout) : undefined;

        if (url === undefined)
          return {
            ok: false,
            failure: { kind: 'hook', exit: ran.exit, said: said(ran), script: h.db },
          };
        // A hook says nothing of a database just made: never seeded by Abe.
        had = { url, by: 'hook', name: hook, made: false, seeded: false };
      } else {
        if (o.mac === undefined)
          return { ok: false, failure: { kind: 'mac', said: 'this serve has no local database' } };
        const got = await o.mac.ensure(mac, repo);

        if (!got.ok) return { ok: false, failure: got.failure };
        had = { url: got.url, by: 'mac', name: mac, made: got.made, seeded: false };
      }
      if (!seed || !had.made || !existsSync(join(dir, h.seed))) return { ok: true, db: had };
      const seeded = await run({
        cwd: dir,
        script: h.seed,
        args: [],
        env: { ...env, DATABASE_URL: had.url },
        timeoutMs: PACK_SCRIPT_TIMEOUT_MS,
      });

      if (seeded.exit !== 0) {
        // Made again (and seeded again) next time.
        if (had.by === 'mac') await o.mac?.drop(mac);

        return {
          ok: false,
          failure: { kind: 'seed', exit: seeded.exit, said: said(seeded), script: h.seed },
        };
      }

      return { ok: true, db: { ...had, seeded: true } };
    },
    release: async ({ dir, mac, hook, env, by, run }) => {
      const db = hooksOf(dir).db;
      const hookThere = existsSync(join(dir, db));

      if (by === 'hook' || (by === undefined && hookThere)) {
        // Its hook gone from the checkout: still to stop, by a checkout that has it.
        if (!hookThere) return { done: false, said: `${db} stop: no ${db} in ${dir}` };
        const ran = await run({
          cwd: dir,
          script: db,
          args: ['stop'],
          env: { ...env, ABE_DB_NAME: hook },
          timeoutMs: DB_STOP_MS,
        });

        return {
          done: ran.exit === 0,
          said: `${db} stop: ${ran.exit === null ? 'killed' : `exit ${ran.exit}`}`,
        };
      }
      if (by !== 'mac' || o.mac === undefined) return undefined;
      const dropped = await o.mac.drop(mac);

      return dropped.ok
        ? { done: true, said: `database ${mac} dropped` }
        : { done: false, said: `database ${mac} not dropped: ${dropped.said}` };
    },
  };
};
