/**
 * What a local session runs outside its sandbox, and what it leaves (#182, #146): `abe run`'s
 * Verification pack scripts, run by `serve` in the session's worktree or Before's with `APP_ENV`
 * of `serve`'s environment (no token, as a check's), marked with the session's id so whatever
 * they leave running is found again when the session ends; and the repo's `db` hook (`hooks`),
 * `db start` (idempotent; its last stdout line is the session's `DATABASE_URL`) at the launch,
 * `db stop` at the end. Rules only: the processes are the `SessionApps` port's.
 */
import { ENV_EXAMPLES } from '../install/install-read';
import { abeEnvFile } from '../install/credentials';
import { REPO_PATH } from '../layer/settings/places';
import { packScriptEnv } from './mac-database';

/** The variable a local session's pack scripts carry: the session's id (`ps -E` finds it). */
export const APP_OF = 'ABE_APP_OF';

/** The name the hook gets for the session's own database (`ABE_DB_NAME`). */
export const DB_NAME = (id: string): string => `abe-db-${id}`;

/**
 * A pack script's environment: `APP_ENV` of `serve`'s (never its `DATABASE_URL`, #349), the
 * session's mark, its own database and its port base (`ABE_PORT_BASE`).
 */
export const sessionAppEnv = (
  serve: Readonly<Record<string, string | undefined>>,
  id: string,
  database: string | undefined,
  portBase?: number,
): Record<string, string> => packScriptEnv(serve, { [APP_OF]: id }, { database, portBase });

/**
 * The database hook's environment: a pack script's (its port base too), plus the database's name, never the
 * session's mark: a database it leaves running is stopped by its own `stop`, not with the apps.
 */
export const dbEnv = (
  serve: Readonly<Record<string, string | undefined>>,
  id: string,
  portBase?: number,
): Record<string, string> => {
  const env = Object.fromEntries(
    Object.entries(sessionAppEnv(serve, id, undefined, portBase)).filter(
      ([name]) => name !== APP_OF,
    ),
  );

  return { ...env, ABE_DB_NAME: DB_NAME(id) };
};

const lineEnds = (line: string, at: number) => at === line.length || line[at] === ' ';

/**
 * The processes a session left running, from `ps -axwwE -o pid=,pgid=,command=` (each line the
 * pid, its group, the command and, for a process of this user, its environment): those whose
 * environment holds the session's own `ABE_SOCKET` (what its agent started in the sandbox) or its
 * `APP_OF` mark (what its pack scripts started; the mark alone with no `socket`), never `self`,
 * with their groups. Never by
 * folder: VimStorm's own shells sit in the worktree too. A kept group is the session's only
 * while one of these is in it (a group number is reused once its group is gone).
 */
export const leftovers = (
  ps: string,
  o: { socket?: string; id: string; self: number },
): { pids: number[]; groups: number[] } => {
  const marks = [
    ...(o.socket === undefined ? [] : [` ABE_SOCKET=${o.socket}`]),
    ` ${APP_OF}=${o.id}`,
  ];
  const found = ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    const pid = Number(m?.[1]);
    const pgid = Number(m?.[2]);
    const rest = m?.[3] ?? '';

    if (m === null || !Number.isInteger(pid) || pid <= 1 || pid === o.self) return [];
    const held = marks.some((mark) => {
      for (let at = rest.indexOf(mark); at !== -1; at = rest.indexOf(mark, at + 1))
        if (lineEnds(rest, at + mark.length)) return true;

      return false;
    });

    return held ? [{ pid, pgid }] : [];
  });

  return {
    pids: found.map((f) => f.pid),
    groups: [...new Set(found.map((f) => f.pgid))].filter((g) => g > 1),
  };
};

const URL_LINE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** The database hook's URL: its last non-empty stdout line, when that is one. */
export const databaseUrlOf = (stdout: string): string | undefined => {
  const last = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);

  return last !== undefined && URL_LINE.test(last) ? last : undefined;
};

/**
 * The files besides its Verification pack's skill (the `verify` hook's `SKILL.md`) and its CI
 * files (`CI_FILES`), which serve lists, that say whether a repo's app, tests and verify need a
 * database: its settings, its env example (the one Factory install's Read takes keys from, there
 * before any pack file) and dev's Abe env file (this machine's app's, filled at Env files).
 */
export const DB_PACK_FILES = [REPO_PATH, ...ENV_EXAMPLES, abeEnvFile('dev')] as const;

/**
 * Said to a local session with no database (no `db` hook script, and Docker gives no Mac
 * database, #349): a step that needs one is not run, never a person asked for a URL or password.
 */
export const NO_DATABASE_NOTE =
  "This session has no database: Docker isn't running on this machine, so Abe's local database could not give it one, and the repo has no database script (its `db` hook) to start one. A test or a verify step that needs a database does not run here: report it as not run, with that reason, and go on; never ask the person for a database URL or a password. A run on the cloud target has one.";

/** The refusal code of a local session's database when Docker gives none (#349). */
export const NO_DOCKER = 'no-docker';
