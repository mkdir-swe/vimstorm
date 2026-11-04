/**
 * Starting processes: a detached `abe serve`, how this very program is run again, and a child run
 * to its end (git, tmux).
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Answered, type Ran } from '@abe/core';
import { type Env } from './locations';
import { withoutGhDropped } from '../github/gh';

const TIMEOUT_MS = 30_000;

/**
 * Runs `argv` to its end (killed after `timeoutMs`, default 30 s) with exactly `env`. A killed
 * child answers as soon as it is gone (exit 137), not when its own children (git's
 * `git-remote-https`, `ssh`) let go of its output.
 */
export const runProcess = async (
  argv: readonly string[],
  env: Record<string, string>,
  cwd?: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Ran> => {
  const child = Bun.spawn([...argv], {
    env,
    ...(cwd === undefined ? {} : { cwd }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killed = new Promise<Ran>((resolve) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      void child.exited.then((exit) => {
        resolve({ exit, stdout: '', stderr: `killed after ${timeoutMs / 1000} s` });
      });
    }, timeoutMs);
  });
  const ran = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, exit]): Ran => ({ exit, stdout, stderr }));

  return Promise.race([ran, killed]).finally(() => {
    clearTimeout(timer);
  });
};

/**
 * Runs `argv` to its end in serve's own environment, `input` on its stdin: its exit and stdout
 * (stderr dropped; 127 when it is not found). A quick git call on a request's path, never
 * blocking serve's loop.
 */
export const runOwn = async (
  argv: readonly string[],
  input?: string,
): Promise<{ exit: number; stdout: string }> => {
  try {
    const child = Bun.spawn([...argv], {
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return { exit, stdout };
  } catch {
    // not on PATH: as a failed run
    return { exit: 127, stdout: '' };
  }
};

/** Whether `runProcess` killed it at its timeout. */
export const killedAtTimeout = (r: Ran): boolean =>
  r.stdout === '' && /^killed after [\d.]+ s$/.test(r.stderr);

export const failed = (code: string, message: string): Answered<never> => ({
  ok: false,
  error: { code, message },
});

export const said = (r: Ran, what: string): string =>
  r.stderr.trim() || r.stdout.trim() || `${what} exited ${r.exit}`;

/** The names a serve the client starts is given as they are. */
const SERVE_NAMES = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'TERM',
  'LANG',
  'TZ',
  'SSH_AUTH_SOCK',
  'DATABASE_URL',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AZURE_CONFIG_DIR',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GIT_SSH_COMMAND',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'VOLTA_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].flatMap((n) => [n, n.toLowerCase()]),
]);

/** The prefixes a serve the client starts is given: Abe's, the state folders, the locale, the editor's. */
const SERVE_PREFIXES = ['ABE_', 'XDG_', 'LC_', 'VIMSTORM_'];

/**
 * What a serve the client starts runs with: the client's environment on an allowlist (who you are,
 * your tools, Abe's own, the profile and folders your logins use, the network's proxy). Nothing
 * else: no cloud keys, nor a checkout's env file a shell loaded where abe was typed.
 */
export const serveEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value !== undefined &&
      (SERVE_NAMES.has(name) || SERVE_PREFIXES.some((p) => name.startsWith(p)))
        ? [[name, value]]
        : [],
    ),
  );

/** Starts `argv` in its own session, its output appended to `log`; returns its pid. */
export const startDetached = (
  argv: readonly string[],
  env: Env,
  log: string,
): number | undefined => {
  const [file, ...args] = argv;

  if (file === undefined) throw new Error('no command to start');
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const out = openSync(log, 'a', 0o600);

  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...env },
    });

    // A failed start shows as no answer; the client then names the log.
    child.on('error', () => undefined);
    child.unref();

    return child.pid;
  } finally {
    closeSync(out);
  }
};

/**
 * The argv that runs this program with `args`: the binary itself once compiled, else Bun on the
 * entry script.
 */
export const selfArgv = (args: readonly string[]): string[] => {
  const script = process.argv[1];
  const compiled =
    script === undefined || script.startsWith('/$bunfs/') || script.startsWith('B:/~BUN/');

  return compiled ? [process.execPath, ...args] : [process.execPath, script, ...args];
};

/**
 * Config every git of ours runs with, above every file (#181): a session's shell writes a nested
 * repository's config in its worktree (a submodule's), whose `core.fsmonitor` command git runs
 * from a `status` in the worktree, outside the sandbox; nor does a `status` or a fetch go into
 * submodules at all.
 */
export const SAFE_GIT_CONFIG = [
  ['core.fsmonitor', 'false'],
  ['diff.ignoreSubmodules', 'all'],
  ['fetch.recurseSubmodules', 'false'],
] as const;

/** `env` with `SAFE_GIT_CONFIG` after any `GIT_CONFIG_COUNT` pairs it has (git's own env config). */
const withSafeConfig = (env: Record<string, string>): Record<string, string> => {
  const had = Number(env.GIT_CONFIG_COUNT ?? '0');
  const from = Number.isInteger(had) && had > 0 ? had : 0;

  return {
    ...env,
    ...Object.fromEntries(
      SAFE_GIT_CONFIG.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${from + i}`, key],
        [`GIT_CONFIG_VALUE_${from + i}`, value],
      ]),
    ),
    GIT_CONFIG_COUNT: String(from + SAFE_GIT_CONFIG.length),
  };
};

/**
 * What `git` runs with: `env` less a parent git's variables (they would point it at another
 * repository) and the GitHub tokens (`GH_DROPPED`), which no git or hook of ours is handed, and
 * `SAFE_GIT_CONFIG`.
 */
export const gitEnv = (env: Env): Record<string, string> => withSafeConfig(withoutGhDropped(env));
