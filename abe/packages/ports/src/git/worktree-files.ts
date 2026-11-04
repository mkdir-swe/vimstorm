/**
 * A new worktree's local-only files and node_modules, as 1.x's git port gave its worktrees (abe's
 * `systems/git/localFiles.ts`, `nodeModules.ts`): the main checkout's AGENTS.md, CLAUDE.md,
 * GLOSSARY.md, CONTEXT.md, `docs/agents`, `docs/adr` and `.scratch` copied in (excluded from git
 * there, in Abe's card block; a path the worktree tracks is left to git; a symlink is linked again; Abe's own state and
 * skills left out) with its ignored `.env*` files; and the main checkout's install linked in when
 * the worktree's package-lock asks for what it holds (npm's record, `node_modules/.package-lock.json`):
 * each node_modules folder (the root's and each workspace's) a folder of its own, a package linked
 * to the main checkout's, a workspace's link kept as it is, `.bin` and `@scope` folders of links,
 * caches left out.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { addToBlock, CARD_EXCLUDE } from './exclude-block';

/** The checkout's own files a new worktree gets, excluded from git there. */
export const COPIED = [
  'AGENTS.md',
  'CLAUDE.md',
  'GLOSSARY.md',
  'CONTEXT.md',
  'docs/agents',
  'docs/adr',
  '.scratch',
] as const;

/** Abe's state stays in the main checkout; its skills are copied in afresh for each session. */
const OWN = ['.scratch/abe', '.agents/skills'] as const;

/** git in a folder: its stdout, or null when it failed. */
export type GitIn = (cwd: string, args: readonly string[]) => Promise<string | null>;

const under = (path: string, folders: readonly string[]) =>
  folders.some((f) => path === f || path.startsWith(`${f}/`) || path.includes(`/${f}/`));

/** A `.env*` file anywhere (not a folder). */
export const isEnvFile = (path: string): boolean =>
  !path.endsWith('/') && (path.split('/').at(-1) ?? path).startsWith('.env');

const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/** Copies `from` to `to`, folders whole, symlinks as links; `rel` (from the main checkout) skipped when Abe's own. */
const copyTree = (from: string, to: string, rel: string): void => {
  if (under(rel, OWN)) return;
  const s = lstatSync(from);

  if (s.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (s.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from))
      copyTree(join(from, name), join(to, name), `${rel}/${name}`);
  } else copyFileSync(from, to);
};

/**
 * Adds patterns to the repository's `info/exclude` (shared by every worktree) once each, in Abe's
 * card block, which the last of Abe's worktrees removed takes out (`Git.remove`).
 */
const exclude = async (git: GitIn, cwd: string, patterns: readonly string[]) => {
  if (patterns.length === 0) return;
  const file = (
    await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  )?.trim();

  if (file === undefined || file === '') throw new Error('no info/exclude');
  addToBlock(file, CARD_EXCLUDE, patterns);
};

/** The main checkout's local-only files copied into a new worktree (see the module doc). */
export const copyLocalFiles = async (git: GitIn, main: string, worktree: string): Promise<void> => {
  const copied: string[] = [];

  for (const path of COPIED) {
    if (stat(join(main, path)) === undefined) continue;
    const tracked = await git(worktree, ['ls-files', '--', path]);

    if (tracked === null) throw new Error(`git ls-files ${path}`);
    if (tracked.trim() !== '') continue;
    const target = join(worktree, path);

    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    copyTree(join(main, path), target, path);
    copied.push(path);
  }
  await exclude(git, worktree, copied);
  // an ignored folder (node_modules) comes as one entry ending in /: none inside it is copied
  const ignored = await git(main, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);

  for (const path of (ignored ?? '').split('\0').filter(isEnvFile)) {
    const target = join(worktree, path);

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(main, path), target);
  }
};

const Entry = z.looseObject({
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  link: z.boolean().optional(),
  optional: z.boolean().optional(),
});
type Entry = z.infer<typeof Entry>;
const Lock = z.looseObject({ packages: z.record(z.string(), Entry) });

const packagesIn = (file: string): Map<string, Entry> | undefined => {
  try {
    const lock = Lock.safeParse(JSON.parse(readFileSync(file, 'utf8')));

    return lock.success ? new Map(Object.entries(lock.data.packages)) : undefined;
  } catch {
    return undefined;
  }
};

/** A key under a node_modules folder is an installed package; the others are the root and the workspaces. */
const installed = (key: string) => key.includes('node_modules/');

const same = (a: Entry, b: Entry) =>
  a.version === b.version &&
  a.resolved === b.resolved &&
  a.integrity === b.integrity &&
  (a.link ?? false) === (b.link ?? false);

/** An install holds what a lock asks for: each package it has is the lock's, and the lock's it lacks are optional. */
const holds = (install: Map<string, Entry>, lock: Map<string, Entry>) =>
  [...install].every(([k, e]) => {
    const want = lock.get(k);

    return !installed(k) || (want !== undefined && same(e, want));
  }) && [...lock].every(([k, e]) => !installed(k) || install.has(k) || e.optional === true);

/** Dot entries other than `.bin` are caches and npm's own record. */
const kept = (name: string) => !name.startsWith('.') || name === '.bin';

const names = (dir: string) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** A link there is copied as it is (a workspace's relative link finds the worktree's own package); anything else links to the main checkout's. */
const link = (from: string, to: string): void => {
  symlinkSync(lstatSync(from).isSymbolicLink() ? readlinkSync(from) : from, to);
};

const linkAll = (main: string, worktree: string, folders: readonly string[], made: string[]) => {
  for (const folder of folders) {
    const from = join(main, folder, 'node_modules');
    const to = join(worktree, folder, 'node_modules');
    const list = stat(from)?.isDirectory() === true ? names(from).filter(kept) : [];

    if (list.length === 0 || !existsSync(join(worktree, folder))) continue;
    mkdirSync(to);
    made.push(to);
    for (const name of list) {
      if (name !== '.bin' && !name.startsWith('@')) {
        link(join(from, name), join(to, name));
        continue;
      }
      mkdirSync(join(to, name));
      for (const child of names(join(from, name)))
        link(join(from, name, child), join(to, name, child));
    }
  }
};

/**
 * Gives a new worktree the main checkout's install as links (see the module doc): `linked`;
 * `missing` when the main checkout has no such install; null for a checkout without a
 * package-lock or with node_modules already.
 */
export const linkModules = (main: string, worktree: string): 'linked' | 'missing' | null => {
  const lock = packagesIn(join(worktree, 'package-lock.json'));

  if (lock === undefined) return null;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };

  if (real(main) === real(worktree) || stat(join(worktree, 'node_modules')) !== undefined)
    return null;
  const install = packagesIn(join(main, 'node_modules', '.package-lock.json'));

  if (install === undefined || !holds(install, lock)) return 'missing';
  const folders = ['', ...[...lock.keys()].filter((k) => k !== '' && !installed(k))];
  const made: string[] = [];

  try {
    linkAll(main, worktree, folders, made);
  } catch {
    // rmSync never follows a link: the main checkout's install stays as it is
    for (const folder of made) rmSync(folder, { recursive: true, force: true });

    return 'missing';
  }

  return 'linked';
};
