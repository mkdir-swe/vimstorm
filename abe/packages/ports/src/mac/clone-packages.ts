/**
 * A prototype's packages (ADR 0039): each `node_modules` of the main checkout that lies in no other
 * one cloned into the prototype's worktree at the same place, copy on write (APFS `clonefile(2)`
 * of the whole folder, else `cp -cR`, else a plain `cp -R` where the disk clones nothing). A clone
 * keeps every link as it is, so a workspace's relative link (`node_modules/@shop/ui` →
 * `../../packages/ui`) resolves inside the worktree, and nothing in it is the main checkout's: the
 * worktree's tools write their own caches. Then, when the worktree's manifests (each tracked
 * `package.json` and the lockfiles beside them) are not the bytes its `node_modules` were made
 * for, the lockfile's install runs there (`installCommand`); what they were made for is kept in
 * the worktree's own git folder (`abe-packages`), so a later change in the prototype installs
 * again. IO only: which folders and files are core's (`nodeModulesTops`, `manifestPaths`).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installCommand, LOCKFILES, manifestPaths, nodeModulesTops } from '@abe/core';
import { runProcess } from './process';

const GIT_TIMEOUT_MS = 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;
const SYSTEM = '/usr/lib/libSystem.B.dylib';

type CloneFile = (from: string, to: string) => boolean;

/** `clonefile(2)` through Bun's FFI on macOS; undefined where there is none (Linux, no FFI). */
const systemClone = async (): Promise<CloneFile | undefined> => {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { dlopen, FFIType } = await import('bun:ffi');
    const lib = dlopen(SYSTEM, {
      clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    const c = (s: string) => Buffer.from(`${s}\0`);

    return (from, to) => lib.symbols.clonefile(c(from), c(to), 0) === 0;
  } catch {
    return undefined;
  }
};

let cloner: Promise<CloneFile | undefined> | undefined;

/** How a folder was copied: one APFS clone, `cp -cR`, or a plain copy. */
export type CopiedBy = 'clonefile' | 'cp -c' | 'cp';

/**
 * `from` (a folder) copied to `to` (not there yet), copy on write when the disk can: how, or
 * undefined when no copy took (said in the throw's words by the caller).
 */
export const cloneFolder = async (from: string, to: string): Promise<CopiedBy | undefined> => {
  mkdirSync(dirname(to), { recursive: true });
  cloner ??= systemClone();
  const clone = await cloner;

  if (clone?.(from, to) === true) return 'clonefile';
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
  const tries: readonly [CopiedBy, string[]][] = [
    ['cp -c', ['/bin/cp', '-cR', from, to]],
    ['cp', ['/bin/cp', '-R', from, to]],
  ];

  for (const [by, argv] of tries) {
    const ran = await runProcess(argv, env, undefined, COPY_TIMEOUT_MS);

    if (ran.exit === 0) return by;
    // a clone refused part way leaves a part behind: the next try starts clean
    await runProcess(['/bin/rm', '-rf', to], env);
  }

  return undefined;
};

const lstatOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

const gitOut = async (cwd: string, env: Record<string, string>, ...args: string[]) => {
  const ran = await runProcess(['git', '-C', cwd, ...args], env, undefined, GIT_TIMEOUT_MS);

  return ran.exit === 0 ? ran.stdout : undefined;
};

/** The bytes of `paths` in `dir`, one hash: a missing file counts as missing. */
const manifestsHash = (dir: string, paths: readonly string[]): string => {
  const h = createHash('sha256');

  for (const p of paths) {
    h.update(`${p}\0`);
    try {
      h.update(readFileSync(join(dir, p)));
    } catch {
      h.update('\0missing\0');
    }
  }

  return h.digest('hex');
};

export type PackagesReady = {
  /** The `node_modules` folders cloned now, from the top, and how. */
  cloned: { path: string; by: CopiedBy }[];
  /** Those the checkout has that could not be copied, each with why. */
  notCloned: Record<string, string>;
  /** The install run because the manifests differ; null: none needed. */
  installed: { run: string; exit: number | null; output: string } | null;
};

/**
 * The prototype's worktree's packages made ready: the main checkout's `node_modules` cloned where
 * it has none, then the install when its manifests differ from what they were made for (the main
 * checkout's, at first). `install` runs the command in the worktree (the caller's network rule).
 */
export const readyPackages = async (o: {
  checkout: string;
  worktree: string;
  env: Record<string, string>;
  install: (run: string) => Promise<{ run: string; exit: number | null; output: string }>;
}): Promise<PackagesReady> => {
  const env = { PATH: o.env.PATH ?? '/usr/bin:/bin', HOME: o.env.HOME ?? '/' };
  const ignored = await gitOut(
    o.checkout,
    env,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  );
  const cloned: PackagesReady['cloned'] = [];
  const notCloned: Record<string, string> = {};

  for (const path of nodeModulesTops((ignored ?? '').split('\n'))) {
    const from = join(o.checkout, path);
    const to = join(o.worktree, path);

    if (lstatOf(from)?.isDirectory() !== true || lstatOf(to) !== undefined) continue;
    // a workspace the prototype's commit lacks gets none
    if (!existsSync(dirname(to))) continue;
    const by = await cloneFolder(from, to);

    if (by === undefined) notCloned[path] = 'neither clonefile nor cp could copy it';
    else cloned.push({ path, by });
  }
  const tracked = (
    (await gitOut(o.worktree, env, 'ls-files', '--', 'package.json', '*/package.json')) ?? ''
  )
    .split('\n')
    .filter((l) => l !== '');
  const paths = manifestPaths(tracked);
  const gitDir = (await gitOut(o.worktree, env, 'rev-parse', '--absolute-git-dir'))?.trim();
  const mark = gitDir === undefined || gitDir === '' ? undefined : join(gitDir, 'abe-packages');
  const want = manifestsHash(o.worktree, paths);
  let had: string | undefined;

  try {
    had = mark === undefined ? undefined : readFileSync(mark, 'utf8').trim();
  } catch {
    had = undefined;
  }
  // first time: its node_modules are the main checkout's, made for the checkout's manifests
  had ??= manifestsHash(o.checkout, paths);
  const keep = (hash: string) => {
    if (mark !== undefined) writeFileSync(mark, `${hash}\n`);
  };
  const lock = LOCKFILES.find((f) => existsSync(join(o.worktree, f)));

  if (had === want || lock === undefined) {
    keep(want);

    return { cloned, notCloned, installed: null };
  }
  const installed = await o.install(
    installCommand(lock, existsSync(join(o.checkout, '.yarnrc.yml'))),
  );

  if (installed.exit === 0) keep(want);

  return { cloned, notCloned, installed };
};
