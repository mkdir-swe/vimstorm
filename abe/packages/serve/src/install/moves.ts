/**
 * A repo moved or renamed on this Mac, followed (core's `repo-moves.ts` has the rule): every
 * request's folder is looked at once (`seen`), its main checkout known by the id in its `.abe/`.
 * Met at a new folder, or at one of its card worktrees with the repo found beside where it was,
 * the repo is followed in turn with every other move: its worktrees linked to it again, its install
 * record, its sessions, runs and held writes kept for the new folder, your Layer's local-mode lists
 * with them, and its Abe chat's conversations where Claude Code reads them now. What followed and
 * what did not is said once (`repo.moved`); a worktree whose repo is not found says so too.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type InstallStore, type RepoMoved, rehomed, sighting } from '@abe/core';
import {
  type Env,
  excludeRepoId,
  mainCheckout,
  mintRepoId,
  moveClaudeConversations,
  movedConversationPath,
  movedRepoBeside,
  readRepoId,
  repairMovedWorktrees,
  repoRegistry,
} from '@abe/ports';
import { type Sessions } from '../session';
import { type InstallRecords } from './record';

/** What a move rewrites, as serve holds it when the request comes. */
export type MoveTargets = {
  sessions: Pick<Sessions, 'list' | 'metaOf' | 'amend'> | undefined;
  /** The Factory's runs kept for the new folder: how many. */
  runs: ((from: string, to: string) => number) | undefined;
  /** Local mode's held records and your Layer's lists: how many records, and why not. */
  local: (from: string, to: string) => { records: number; problem?: string };
};

export type RepoMovesOptions = {
  /** serve's state: where each repo id was last seen (`repos.json`). */
  stateDir: string;
  /** git's environment. */
  env: Env;
  /** The sessions' `HOME`: where Claude Code keeps their conversations. */
  home: string | undefined;
  store: InstallStore;
  records: InstallRecords;
  emit: (m: RepoMoved) => void;
};

export type RepoMoves = {
  /** `dir` (a real path) looked at, its repo followed first when it moved. */
  seen: (dir: string, targets: MoveTargets) => Promise<void>;
};

/** Whether `main`'s `.git` is a folder: a main checkout, not a worktree or a submodule. */
const isGitFolder = (main: string): boolean => {
  try {
    return statSync(join(main, '.git')).isDirectory();
  } catch {
    return false;
  }
};

export const repoMoves = (o: RepoMovesOptions): RepoMoves => {
  const registry = repoRegistry(o.stateDir);
  /** Each folder looked at, and the main checkout it is in (its own folder: none). */
  const looked = new Map<string, string>();
  /** The gone repos a worktree of was met, said once each. */
  const lost = new Set<string>();
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = (f: () => Promise<void>): Promise<void> => {
    const run = last.then(f);

    last = run.catch(() => undefined);

    return run;
  };

  const sessionsOf = async (t: MoveTargets, from: string, to: string): Promise<number> => {
    const listed = await t.sessions?.list();

    if (listed?.ok !== true) return 0;
    let n = 0;

    for (const { id } of listed.data) {
      const m = t.sessions?.metaOf(id);

      if (m === undefined) continue;
      const repo = rehomed(m.repo, from, to);
      const worktree = rehomed(m.worktree, from, to);
      const abe =
        m.abe === null || m.abe === undefined
          ? m.abe
          : { ...m.abe, repo: rehomed(m.abe.repo, from, to) };
      const transcriptPath =
        m.transcriptPath === null || o.home === undefined
          ? m.transcriptPath
          : movedConversationPath(o.home, m.transcriptPath, from, to);

      if (
        repo === m.repo &&
        worktree === m.worktree &&
        abe?.repo === m.abe?.repo &&
        transcriptPath === m.transcriptPath
      )
        continue;
      t.sessions?.amend(id, (was) => ({ ...was, repo, worktree, abe, transcriptPath }));
      n += 1;
    }

    return n;
  };

  const follow = async (id: string, from: string, to: string, seenAt: string, t: MoveTargets) => {
    const problems: string[] = [];
    const worktrees = await repairMovedWorktrees(o.env, from, to);

    problems.push(...worktrees.problems);
    const install = await o.store.move(from, to);

    if (install)
      await o.records
        .at(to)
        .change((i) =>
          Promise.resolve(
            i === undefined ? { out: null } : { out: null, save: { ...i, repo: to } },
          ),
        );
    else if ((await o.store.read(from)) !== undefined)
      problems.push(`its install record stays at ${from}: ${to} has one of its own`);
    const sessions = await sessionsOf(t, from, to);

    if (o.home !== undefined && !moveClaudeConversations(o.home, from, to))
      problems.push(
        `its Abe chat's conversations could not move from ${from}'s Claude Code folder`,
      );
    const runs = t.runs?.(from, to) ?? 0;
    const local = t.local(from, to);

    if (local.problem !== undefined)
      problems.push(`local mode still names ${from}: ${local.problem}`);
    registry.seen(id, to);
    o.emit({
      from,
      to,
      seenAt,
      install,
      sessions,
      runs,
      worktrees: worktrees.repaired,
      problems,
    });
  };

  const look = async (dir: string, t: MoveTargets) => {
    const main = mainCheckout(dir);

    if (main === undefined) {
      looked.set(dir, dir);

      return;
    }
    // a card worktree whose repo is gone: found beside where it was by its id, else said
    if (!existsSync(main)) {
      const id = registry.idAt(main);
      const found = id === undefined ? undefined : movedRepoBeside(main, id);

      if (id !== undefined && found !== undefined) {
        await follow(id, main, found, dir, t);
        looked.set(dir, found);
      } else if (id !== undefined && !lost.has(main)) {
        lost.add(main);
        o.emit({
          from: main,
          to: null,
          seenAt: dir,
          install: false,
          sessions: 0,
          runs: 0,
          worktrees: [],
          problems: [],
        });
      }

      return;
    }
    looked.set(dir, main);
    // not Abe's, or no main checkout of its own (a `.git` file): nothing kept, nothing to follow
    if (!existsSync(join(main, '.abe')) || !isGitFolder(main)) return;
    const id = readRepoId(main);

    // one minted before, or carried over: never in git status
    if (id !== undefined) excludeRepoId(main);
    const was = id === undefined ? undefined : registry.at(id);
    const s = sighting({
      at: main,
      id,
      seen: was,
      stillThere: was !== undefined && readRepoId(was) === id,
    });

    if (s.kind === 'moved' && id !== undefined) await follow(id, s.from, main, dir, t);
    else if (s.kind === 'copy') registry.seen(mintRepoId(main), main);
    else if (s.kind === 'new') registry.seen(id ?? mintRepoId(main), main);
  };

  return {
    seen: (dir, t) => {
      const fresh = () => existsSync(looked.get(dir) ?? '');

      return fresh()
        ? Promise.resolve()
        : inTurn(() => (fresh() ? Promise.resolve() : look(dir, t)));
    },
  };
};
