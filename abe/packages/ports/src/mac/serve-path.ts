/**
 * serve's PATH on the Mac (#145): its person's login shell read once at start (`$SHELL -lic`, as
 * a terminal starts it: `.zprofile` and `.zshrc`, where Volta, nvm, fnm, asdf and mise put their
 * node), and the node managers found on disk. The merge and the managers' places are
 * `core/src/install/serve-path.ts`'.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FoundManager, LOCALE, nodePlaces, nvmBin, servePath } from '@abe/core';
import { type Env } from './locations';
import { runProcess } from './process';

/** How long `node --version` may take at a launch. */
const NODE_CHECK_MS = 10_000;

/** How long the login shell may take: the client waits 5 s for a serve it started to answer. */
export const LOGIN_SHELL_MS = 2_000;

/** The PATH a login shell starts from: the system's, before `path_helper` and the person's files. */
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The script every shell runs (sh, zsh, bash, fish): the PATH to a file, nothing on a pipe. */
const PRINT_PATH = 'printf %s "$PATH" > "$ABE_PATH_OUT"';

/** Kills a process group; one already gone is fine. */
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // gone already
  }
};

/** The person's shell: `$SHELL`, else zsh (macOS's own). */
const loginShell = (env: Env) =>
  env.SHELL === undefined || env.SHELL === '' ? '/bin/zsh' : env.SHELL;

const seconds = (ms: number) => `${String(Math.round(ms / 100) / 10)} s`;

/**
 * The PATH the person's login shell (`$SHELL`, else zsh) ends up with, started from a clean
 * environment (who they are, the locale, the system's PATH: none of serve's own, no token). It
 * writes the PATH to a file, so nothing it starts in the background holds serve up on a pipe.
 */
export const loginShellPath = async (o: {
  env: Env;
  timeoutMs?: number;
}): Promise<{ ok: true; path: string } | { ok: false; why: string }> => {
  const timeoutMs = o.timeoutMs ?? LOGIN_SHELL_MS;
  const shell = loginShell(o.env);
  const dir = mkdtempSync(join(tmpdir(), 'abe-path-'));
  const out = join(dir, 'path');
  const env: Record<string, string> = {
    PATH: BASE_PATH,
    SHELL: shell,
    TERM: 'dumb',
    ABE_PATH_OUT: out,
  };

  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', ...LOCALE]) {
    const value = o.env[name];

    if (value !== undefined && value !== '') env[name] = value;
  }
  try {
    const child = Bun.spawn([shell, '-lic', PRINT_PATH], {
      env,
      cwd: env.HOME !== undefined && existsSync(env.HOME) ? env.HOME : '/',
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      // Its own process group, without the terminal a foreground serve runs in: what an
      // interactive shell starts (a prompt's daemon, a hung rc's child) goes with it.
      detached: true,
    });
    const given = { up: false };
    const timer = setTimeout(() => {
      given.up = true;
      killGroup(child.pid);
    }, timeoutMs);
    const exit = await child.exited.finally(() => {
      clearTimeout(timer);
      killGroup(child.pid);
    });
    const path = existsSync(out) ? readFileSync(out, 'utf8').trim() : '';

    if (path !== '') return { ok: true, path };
    if (given.up)
      return { ok: false, why: `${shell} -lic did not answer within ${seconds(timeoutMs)}` };

    return { ok: false, why: `${shell} -lic printed no PATH (exit ${String(exit)})` };
  } catch (e) {
    return { ok: false, why: `${shell}: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Homebrew's nvm script, Apple silicon's then Intel's. */
const BREW_NVM = ['/opt/homebrew/opt/nvm/nvm.sh', '/usr/local/opt/nvm/nvm.sh'];

/**
 * A manager's own command on disk, for its fix: Volta's binary in its home (a Homebrew Volta has
 * only shims there: none, called by name), nvm's `nvm.sh` in its home else Homebrew's.
 */
const toolOf = (manager: FoundManager['manager'], home: string): string | undefined => {
  const candidates: Partial<Record<FoundManager['manager'], string[]>> = {
    Volta: [join(home, 'bin', 'volta')],
    nvm: [join(home, 'nvm.sh'), ...BREW_NVM],
  };

  return (candidates[manager] ?? []).find((c) => existsSync(c));
};

/** The node managers on this Mac: each one whose home folder is there, with its own command. */
export const foundManagers = (env: Env, home: string): FoundManager[] =>
  nodePlaces(env, home).flatMap((p) => {
    const at = p.homes.find((h) => existsSync(h));
    const tool = at === undefined ? undefined : toolOf(p.manager, at);

    return at === undefined
      ? []
      : [{ manager: p.manager, home: at, ...(tool === undefined ? {} : { tool }) }];
  });

/**
 * The node a session would run on `env`'s PATH: where it is when `node --version` answers (a
 * manager's shim with no node set does not), else `null`.
 */
export const nodeThatRuns = async (
  env: Readonly<Record<string, string>>,
): Promise<string | null> => {
  const node = Bun.which('node', { PATH: env.PATH ?? '' });

  if (node === null) return null;
  try {
    const ran = await runProcess([node, '--version'], { ...env }, undefined, NODE_CHECK_MS);

    return ran.exit === 0 ? node : null;
  } catch {
    return null;
  }
};

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** Each found manager's node folder that is there (nvm's: its default alias's version). */
export const managerBins = (env: Env, home: string): string[] => {
  const places = nodePlaces(env, home);

  return foundManagers(env, home).flatMap((m) => {
    const bin = places.find((p) => p.manager === m.manager)?.bin ?? null;
    const dir =
      bin === null
        ? nvmBin(
            m.home,
            read(join(m.home, 'alias', 'default')),
            list(join(m.home, 'versions', 'node')),
          )
        : join(m.home, bin);

    return dir !== null && existsSync(dir) ? [dir] : [];
  });
};

/**
 * serve's PATH, read once at its start: the login shell's first, then the PATH serve was started
 * with, then the managers' node folders; and what serve says of it in its log.
 */
export const resolveServePath = async (o: {
  env: Env;
  home: string;
  timeoutMs?: number;
}): Promise<{ path: string; said: string }> => {
  const login = await loginShellPath({
    env: o.env,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });
  const bins = managerBins(o.env, o.home);
  const found = foundManagers(o.env, o.home)
    .filter((m) => bins.some((b) => b.startsWith(`${m.home}/`)))
    .map((m) => `${m.manager}'s`);
  const shell = loginShell(o.env);
  const from = login.ok
    ? `PATH from your login shell (${shell})`
    : `PATH as serve was started (${login.why})`;

  return {
    path: servePath({
      login: login.ok ? login.path : null,
      inherited: o.env.PATH ?? '',
      managers: bins,
    }),
    said: found.length === 0 ? from : `${from}, with ${found.join(', ')} node`,
  };
};
