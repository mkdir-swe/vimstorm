/**
 * A repo's id and a moved repo's folders on this Mac (core's `repo-moves.ts` has the rule): the id
 * in the main checkout's `.abe/id`, where serve last saw each id (`<state>/repos.json`), the moved
 * repo's card worktrees linked to it again (`git worktree repair`, their session hooks' folder
 * with it), and its main checkout's Claude Code conversations moved to the folder Claude Code
 * reads for it now. Never a guess: a folder is the repo only when it holds the id.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ID_PATH, RepoId, rehomed } from '@abe/core';
import { z } from 'zod';
import { type Env } from '../mac/locations';
import { gitEnv as gitEnvOf, runProcess, said } from '../mac/process';
import { excludeInstalled } from './exclude-block';

/** The id in `main`'s `.abe/id`; undefined: none, or not one. */
export const readRepoId = (main: string): string | undefined => {
  try {
    return RepoId.safeParse(readFileSync(join(main, REPO_ID_PATH), 'utf8').trim()).data;
  } catch {
    return undefined;
  }
};

/** `main`'s id kept out of git: in Abe's block of its `info/exclude`, never `.gitignore`. */
export const excludeRepoId = (main: string): void => {
  excludeInstalled(main, [REPO_ID_PATH]);
};

/** A new id written into `main`'s `.abe/id`, kept out of git: the id. */
export const mintRepoId = (main: string): string => {
  const id = randomBytes(8).toString('hex');

  excludeRepoId(main);
  mkdirSync(join(main, dirname(REPO_ID_PATH)), { recursive: true });
  writeFileSync(join(main, REPO_ID_PATH), `${id}\n`);

  return id;
};

const Seen = z.object({ v: z.literal(1), repos: z.record(z.string(), z.string()) });

/** Where serve last saw each repo id: `<state>/repos.json`, written whole. */
export const repoRegistry = (stateDir: string) => {
  const file = join(stateDir, 'repos.json');
  const read = (): Record<string, string> => {
    try {
      return Seen.safeParse(JSON.parse(readFileSync(file, 'utf8'))).data?.repos ?? {};
    } catch {
      return {};
    }
  };

  return {
    /** The folder `id` was last seen at; none: never. */
    at: (id: string): string | undefined => read()[id],
    /** The id last seen at `path`; none: none there. */
    idAt: (path: string): string | undefined =>
      Object.entries(read()).find(([, at]) => at === path)?.[0],
    /** `id` seen at `path`: another id last seen there (a repo gone from it) forgotten. */
    seen: (id: string, path: string) => {
      const repos = {
        ...Object.fromEntries(Object.entries(read()).filter(([, at]) => at !== path)),
        [id]: path,
      };

      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, repos }, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    },
  };
};
export type RepoRegistry = ReturnType<typeof repoRegistry>;

/**
 * Where the repo `id`, last seen at `gone`, is now: a folder beside where it was (a rename, the
 * usual move) holding the same id; undefined: none there.
 */
export const movedRepoBeside = (gone: string, id: string): string | undefined => {
  const parent = dirname(gone);
  let names: string[];

  try {
    names = readdirSync(parent);
  } catch {
    return undefined;
  }

  return names.map((n) => join(parent, n)).find((p) => p !== gone && readRepoId(p) === id);
};

/** What linking a moved repo's worktrees again did. */
export type WorktreesRepaired = { repaired: string[]; problems: string[] };

/**
 * The card worktrees of the repo now at `to` (moved from `from`) linked to it again: git's own
 * `worktree repair` run in it, then each worktree's session hooks' folder (`core.hooksPath`, in
 * the old git folder) set to the new one. Each worktree git still cannot read is a problem, with
 * git's words.
 */
export const repairMovedWorktrees = async (
  env: Env,
  from: string,
  to: string,
): Promise<WorktreesRepaired> => {
  const gitEnv = gitEnvOf(env);
  const gitBin = Bun.which('git', { PATH: gitEnv.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  const git = (cwd: string, ...args: string[]) => runProcess([gitBin, '-C', cwd, ...args], gitEnv);
  const problems: string[] = [];
  const repair = await git(to, 'worktree', 'repair');

  if (repair.exit !== 0) problems.push(`git worktree repair: ${said(repair, 'git')}`);
  const list = await git(to, 'worktree', 'list', '--porcelain');
  const paths = list.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => p !== to && existsSync(p));
  const repaired: string[] = [];

  for (const path of paths) {
    const reads = await git(path, 'rev-parse', '--git-dir');

    if (reads.exit !== 0) {
      problems.push(`${path}: ${said(reads, 'git')}`);
      continue;
    }
    const hooks = (
      await git(path, 'config', '--worktree', '--get', 'core.hooksPath')
    ).stdout.trim();
    const moved = hooks === '' ? hooks : rehomed(hooks, from, to);

    if (moved !== hooks) {
      const set = await git(path, 'config', '--worktree', 'core.hooksPath', moved);

      if (set.exit !== 0) problems.push(`${path}: its session hooks: ${said(set, 'git')}`);
    }
    repaired.push(path);
  }

  return { repaired, problems };
};

/** Claude Code's folder for a working folder (core's `claudeSessionFile`'s). */
const claudeProject = (home: string, cwd: string) =>
  join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/**
 * The conversations Claude Code kept for `from` moved to where it reads them for `to` (its Abe
 * chat's, resumed there): each file not there already. Whether all went; none to move: true.
 */
export const moveClaudeConversations = (home: string, from: string, to: string): boolean => {
  const was = claudeProject(home, from);
  const now = claudeProject(home, to);

  if (!existsSync(was)) return true;
  try {
    if (!existsSync(now)) {
      mkdirSync(dirname(now), { recursive: true });
      renameSync(was, now);

      return true;
    }
    for (const name of readdirSync(was))
      if (!existsSync(join(now, name))) renameSync(join(was, name), join(now, name));

    return true;
  } catch {
    return false;
  }
};

/** Claude Code's file for a conversation, as it moved from `from`'s folder to `to`'s. */
export const movedConversationPath = (home: string, path: string, from: string, to: string) =>
  rehomed(path, claudeProject(home, from), claudeProject(home, to));
