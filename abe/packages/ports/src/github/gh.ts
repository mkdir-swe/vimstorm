/**
 * `gh` as a child process, always on its own keyring login: the token variables that would win
 * over it and a parent git's variables that would point it at another repo are removed.
 */
import { type GhAccounts, ghErrorCode, type Tracked, type TrackingError } from '@abe/core';
import { type z } from 'zod';
import { type Env } from '../mac/locations';
import { type ContainerExec } from '../docker/workspace-runner';

/**
 * Never handed to `gh`, nor to a `git` whose credential helper is `gh auth git-credential`: tokens
 * beat `gh auth login`, git's would pick another repository.
 */
export const GH_DROPPED = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
] as const;

const DROPPED = new Set<string>(GH_DROPPED);

/** The given environment less `GH_DROPPED` and its unset names. */
export const withoutGhDropped = (env: Env): Record<string, string> => {
  const kept: Record<string, string> = {};

  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !DROPPED.has(name)) kept[name] = value;

  return kept;
};

/** What `gh` runs with: the given environment less `GH_DROPPED`, never prompting. */
export const ghEnv = (env: Env): Record<string, string> => ({
  ...withoutGhDropped(env),
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
});

export type GhResult = { ok: true; stdout: string } | { ok: false; error: TrackingError };

/** `gh <args>` to its end: its stdout, or its failure as a Tracking error with `gh`'s message. */
export type Gh = (args: readonly string[], stdin?: string) => Promise<GhResult>;

const TIMEOUT_MS = 60_000;

/**
 * A gh login's token for Abe's own calls as it (`logins.gh`, ADR 0025): read from gh's
 * keyring, held in this process alone, never printed, logged or written.
 */
export type GhToken = () => Promise<Tracked<string>>;

/**
 * `gh <args>` on gh's active login; with `token`, as the login it reads (`GH_TOKEN` set for that
 * call only: gh's active login is never switched).
 */
export const ghRunner = (env: Env, timeoutMs = TIMEOUT_MS, token?: GhToken): Gh => {
  const base = ghEnv(env);

  return async (args, stdin) => {
    const bin = Bun.which('gh', { PATH: base.PATH ?? '' });

    if (bin === null)
      return {
        ok: false,
        error: { code: 'gh-failed', message: 'gh is not installed (not on PATH)' },
      };
    const as = token === undefined ? undefined : await token();

    if (as?.ok === false) return { ok: false, error: as.error };
    const childEnv = as === undefined ? base : { ...base, GH_TOKEN: as.data };
    const child = Bun.spawn([bin, ...args], {
      env: childEnv,
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const late = { killed: false };
    const timer = setTimeout(() => {
      late.killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => {
      clearTimeout(timer);
    });

    if (late.killed)
      return {
        ok: false,
        error: {
          code: 'gh-failed',
          message: `gh ${args[0] ?? ''} gave no answer in ${timeoutMs / 1000} s`,
        },
      };
    if (exit === 0) return { ok: true, stdout };
    const message = stderr.trim() === '' ? `gh exited ${exit}` : stderr.trim();

    return { ok: false, error: { code: ghErrorCode(message), message } };
  };
};

/** How long a login's token is kept before gh's keyring is read again. */
const TOKEN_KEPT_MS = 10 * 60_000;

/**
 * Each gh login's token by its name (`gh auth token --user`), kept in this process for
 * `keptMs`: a login gh does not have is refused with the sign-in that adds it.
 */
export const ghTokens = (
  env: Env,
  o: { keptMs?: number; now?: () => number } = {},
): ((account: string) => GhToken) => {
  const gh = ghRunner(env);
  const now = o.now ?? Date.now;
  const kept = new Map<string, { token: string; at: number }>();

  return (account) => async () => {
    const was = kept.get(account);

    if (was !== undefined && now() - was.at < (o.keptMs ?? TOKEN_KEPT_MS))
      return { ok: true, data: was.token };
    const read = await gh(['auth', 'token', '--hostname', 'github.com', '--user', account]);
    const token = read.ok ? read.stdout.trim() : '';

    if (token === '')
      return {
        ok: false,
        error: {
          code: 'auth',
          message: `gh is not signed in as ${account} (logins.gh): gh auth login, as ${account}`,
        },
      };
    kept.set(account, { token, at: now() });

    return { ok: true, data: token };
  };
};

/**
 * `gh auth status`'s logins, by name only: its token column is masked, and is never read. A
 * login whose token gh can no longer use is not signed in.
 */
export const readGhAccounts = (text: string): GhAccounts => {
  const signedIn: string[] = [];
  let active: string | null = null;
  let last: string | null = null;

  for (const line of text.split('\n')) {
    const login = /Logged in to github\.com (?:account|as) (\S+)/.exec(line)?.[1];

    if (login !== undefined) {
      signedIn.push(login);
      last = login;
      // gh before multi-account: one login, the active one
      if (signedIn.length === 1) active = login;
      continue;
    }
    if (line.includes('Failed to log in to github.com')) last = null;
    const flag = /Active account: (true|false)/.exec(line)?.[1];

    if (flag === 'true' && last !== null) active = last;
    if (flag === 'false' && last !== null && active === last) active = null;
  }

  return { active, signedIn };
};

/** gh's logins for github.com now (`gh auth status`, its output only, either stream). */
export const ghAccountsFrom =
  (env: Env): (() => Promise<GhAccounts>) =>
  async () => {
    const childEnv = ghEnv(env);
    const bin = Bun.which('gh', { PATH: childEnv.PATH ?? '' });

    if (bin === null) return { active: null, signedIn: [] };
    const child = Bun.spawn([bin, 'auth', 'status', '--hostname', 'github.com'], {
      env: childEnv,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => {
      clearTimeout(timer);
    });

    return readGhAccounts(`${stdout}\n${stderr}`);
  };

/** `gh`'s stdout as JSON of `schema`; anything else is `gh-failed`. */
export const readGh = <T extends z.ZodType>(schema: T, stdout: string): Tracked<z.output<T>> => {
  let json: unknown;

  try {
    json = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: { code: 'gh-failed', message: `gh answered no JSON: ${stdout.slice(0, 200)}` },
    };
  }
  const parsed = schema.safeParse(json);

  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        error: {
          code: 'gh-failed',
          message: `gh answered a shape Abe does not read: ${parsed.error.message}`,
        },
      };
};

/**
 * `gh` inside a box's workspace container (#67), on the login its sessions have there (restored
 * from the person's Secrets Manager token at each launch): a box's pr stage and deploy poll.
 */
export const workspaceGh =
  (exec: ContainerExec, timeoutMs = TIMEOUT_MS): Gh =>
  async (args, stdin) => {
    const ran = await exec(
      ['env', 'GH_PROMPT_DISABLED=1', 'GH_NO_UPDATE_NOTIFIER=1', 'NO_COLOR=1', 'gh', ...args],
      { ...(stdin === undefined ? {} : { stdin }), timeoutMs },
    );

    if (ran.exit === 0) return { ok: true, stdout: ran.stdout };
    const message = ran.stderr.trim() === '' ? `gh exited ${ran.exit}` : ran.stderr.trim();

    return { ok: false, error: { code: ghErrorCode(message), message } };
  };
