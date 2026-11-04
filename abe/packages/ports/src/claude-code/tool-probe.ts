/** `ToolProbe` (#108): a tool's check on serve's own PATH, as a session would find the tool. */
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ToolProbe, type ToolRan } from '@abe/core';
import { type Env, realPath } from '../mac/locations';
import { runProcess } from '../mac/process';
import { foundManagers } from '../mac/serve-path';

/** A check that takes longer is killed and reads as failed (`az version` is the slow one). */
const CHECK_MS = 15_000;

const defined = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/** One found tool's check: where it is (and the file a link there is), its exit and output. */
const runAt = async (
  found: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<ToolRan> => {
  // Whose node it is goes by the file the link resolves to (Homebrew's Cellar, fnm's versions).
  const real = realPath(found);
  const where = real === found ? { at: found } : { at: found, real };

  try {
    return {
      found: true,
      ...where,
      ...(await runProcess([found, ...args], env, undefined, CHECK_MS)),
    };
  } catch (e) {
    return {
      found: true,
      ...where,
      exit: 1,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
};

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);

    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Every copy of `bin` on `path`, in PATH order, each file once (links to one file are one). */
export const eachOnPath = (bin: string, path: string): string[] => {
  const seen = new Set<string>();

  return path.split(':').flatMap((dir) => {
    const at = dir === '' ? '' : join(dir, bin);

    if (at === '' || !executable(at) || seen.has(realPath(at))) return [];
    seen.add(realPath(at));

    return [at];
  });
};

/** A check run with every copy of its tool on `env`'s PATH, in order (#179). */
export const runEachOnPath = async (argv: readonly string[], env: Env): Promise<ToolRan[]> => {
  const [bin, ...args] = argv;

  if (bin === undefined) return [];
  const runEnv = defined(env);

  return Promise.all(eachOnPath(bin, env.PATH ?? '').map((at) => runAt(at, args, runEnv)));
};

/** Each claude's `--version` by its file and when it changed: a launch asks again only after an update. */
const versions = new Map<string, ToolRan>();

/**
 * `claude --version` of every claude on a session's PATH, in order (#179): what
 * `claudeForSession` picks from. Each file's answer is kept until the file changes.
 */
export const claudeVersions = async (env: Env): Promise<ToolRan[]> => {
  const runEnv = defined(env);

  return Promise.all(
    eachOnPath('claude', env.PATH ?? '').map(async (at) => {
      const real = realPath(at);
      const key = `${at}\0${real}\0${String(statSync(real).mtimeMs)}`;
      const kept = versions.get(key);

      if (kept !== undefined) return kept;
      const ran = await runAt(at, ['--version'], runEnv);

      if (ran.found && ran.exit === 0) versions.set(key, ran);

      return ran;
    }),
  );
};

/**
 * Runs each check with serve's own environment `env`, found on its `PATH`; the node managers are
 * looked for under `home` (#145) each time, so one installed since serve started counts.
 */
export const pathToolProbe = (o: { env: Env; home: string }): ToolProbe => ({
  managers: () => Promise.resolve(foundManagers(o.env, o.home)),
  run: async (argv) => {
    const [bin, ...args] = argv;
    const found = bin === undefined ? null : Bun.which(bin, { PATH: o.env.PATH ?? '' });

    return found === null ? { found: false } : runAt(found, args, defined(o.env));
  },
  runEach: (argv) => runEachOnPath(argv, o.env),
});
