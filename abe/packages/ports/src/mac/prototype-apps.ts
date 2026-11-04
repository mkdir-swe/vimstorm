/**
 * A prototype's app on this machine: a detached worktree of the checkout at the commit, in
 * `<dir>/<id>/app` (`serve`'s state directory), the checkout's untracked files it is given put
 * in (`putFiles`: the repo's worktree recipe's too, then its `worktree-setup` hook), with the
 * repo's `prototype-start` hook run there (its `start` where it has none). Detached, with no git
 * hooks run, it adds no branch, commit or remote and leaves the checkout's status as it was;
 * `stop` runs the `prototype-stop` hook (the `stop` after the `start`), ends
 * what the start left running and removes the worktree. The start's output is the app's log,
 * `<dir>/<id>/start.out` and `.err`.
 * IO only: which ref is the default branch and what the script's output means are core's.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  appEnv,
  defaultRefs,
  DEFAULT_HOOKS,
  type PrototypeApps,
  refBranch,
  PRINTED_GRACE_MS,
  printedAddress,
  START_TIMEOUT_MS,
  type StartRun,
  tail,
} from '@abe/core';
import { type Env } from './locations';
import { failed, gitEnv, runProcess, said } from './process';
import { executable, runInGroup, signalGroup } from './process-group';
import { prototypePackages, putFiles, runWorktreeScript } from './worktree-setup';

const STOP_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** A pack script run to its end in a process group of its own (`runInGroup`). */
const script = (
  path: string,
  o: Parameters<typeof runInGroup>[1] & { env: Record<string, string> },
): Promise<StartRun & { pgid: number }> => runInGroup([path], o);

/** When process `pid` started (`ps -o lstart`); undefined: none runs. */
const startedAt = async (pid: number): Promise<string | undefined> => {
  const ps = await runProcess(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
  }).catch(() => undefined);
  const at = ps?.exit === 0 ? ps.stdout.trim() : '';

  return at === '' ? undefined : at;
};

/** A kept start group: its number and when its leader started. */
const groupLine = (pgid: number, since: string | undefined) => `${String(pgid)}\n${since ?? ''}\n`;

export type LocalPrototypeAppsOptions = {
  /** `prototypes` in `serve`'s state directory. */
  dir: string;
  /** `serve`'s environment: where git is found. */
  env: Env;
  /** How long a start has to end once it printed its address (core's `PRINTED_GRACE_MS`). */
  printedGraceMs?: number;
};

export const localPrototypeApps = (o: LocalPrototypeAppsOptions): PrototypeApps => {
  const env = gitEnv(o.env);
  const gitBin = Bun.which('git', { PATH: env.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  // No hook of the checkout's runs for a prototype's worktree.
  const git = (cwd: string, ...args: string[]) =>
    runProcess(
      [gitBin, '-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args],
      env,
      undefined,
      GIT_TIMEOUT_MS,
    );
  /** Where a start's `dir` (a developer prototype's worktree, #83) is kept: `stop` runs there. */
  const givenFile = (id: string) => join(o.dir, id, 'app.dir');
  const given = (id: string): string | undefined => {
    try {
      const text = readFileSync(givenFile(id), 'utf8').trim();

      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  };
  const place = (id: string) => given(id) ?? join(o.dir, id, 'app');
  /** The start script's process group, kept so `stop` can end what it left running. */
  const groupFile = (id: string) => join(o.dir, id, 'start.pgid');
  /** Each start under way: its group, while its script runs. */
  const inFlight = new Map<string, number>();

  const remove = async (id: string, repo: string) => {
    // A folder the start was given is not the prototype's to remove.
    if (given(id) !== undefined) return;
    const path = place(id);

    if (!existsSync(path)) return;
    const removed = await git(repo, 'worktree', 'remove', '--force', path);

    if (removed.exit !== 0) {
      rmSync(path, { recursive: true, force: true });
      await git(repo, 'worktree', 'prune');
    }
  };

  const stop: PrototypeApps['stop'] = async ({ id, repo, env: own, hooks = DEFAULT_HOOKS }) => {
    const path = place(id);
    // its own stop; the pack's only for an app the pack's start started
    const ownStart = existsSync(join(path, hooks['prototype-start']));
    const ownStop = existsSync(join(path, hooks['prototype-stop']));
    const stopScript = join(path, ownStop ? hooks['prototype-stop'] : hooks.stop);
    const stops = !ownStart || ownStop;

    try {
      if (stops && existsSync(stopScript) && executable(stopScript))
        await script(stopScript, {
          cwd: path,
          env: appEnv(o.env, { ...own, ABE_PROTOTYPE: id }),
          ms: STOP_TIMEOUT_MS,
          out: join(o.dir, id, 'stop'),
        });
    } finally {
      // Whatever the start script left in its group, stop script or not (a start under way too),
      // while the group is still its: its leader gone (its children hold it) or the same one.
      // A process of that number started at another time leads someone else's group.
      const [kept = '', since = ''] = (await readFile(groupFile(id), 'utf8').catch(() => '')).split(
        '\n',
      );
      const pgid = inFlight.get(id) ?? Number(kept);
      const ours =
        inFlight.has(id) || since === '' || [undefined, since].includes(await startedAt(pgid));

      if (Number.isInteger(pgid) && pgid > 1 && ours) signalGroup(pgid, 'SIGTERM');
      rmSync(groupFile(id), { force: true });
      await remove(id, repo);
      rmSync(givenFile(id), { force: true });
    }
  };

  return {
    head: async (repo) => {
      const top = await git(repo, 'rev-parse', '--show-toplevel');

      if (top.exit !== 0)
        return failed('not-a-repo', `${repo} is not a git checkout: ${said(top, 'git rev-parse')}`);
      const root = top.stdout.trim();
      const origin = await git(root, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD');
      const originHead =
        origin.exit === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : null;
      const url = await git(root, 'remote', 'get-url', 'origin');
      const remote = url.exit === 0 ? url.stdout.trim() : null;

      for (const ref of defaultRefs(originHead)) {
        const commit = await git(root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);

        if (commit.exit === 0)
          return {
            ok: true,
            data: { repo: root, remote, branch: refBranch(ref), commit: commit.stdout.trim() },
          };
      }

      return failed(
        'no-default-branch',
        `${root} has no default branch to start from (${defaultRefs(originHead).join(', ')})`,
      );
    },
    start: async ({
      id,
      repo,
      commit,
      env,
      dir,
      copy,
      hooks = DEFAULT_HOOKS,
      prepare,
      script: only,
    }) => {
      const known = await git(repo, 'cat-file', '-e', `${commit}^{commit}`);

      if (known.exit !== 0)
        return failed('unknown-commit', `${repo} has no commit ${commit} (fetch it first)`);
      await stop({ id, repo, env, hooks });
      mkdirSync(join(o.dir, id), { recursive: true });
      if (dir === undefined) {
        const added = await git(repo, 'worktree', 'add', '--detach', '--quiet', place(id), commit);

        if (added.exit !== 0)
          return failed('prototype-start-failed', `git worktree add: ${said(added, 'git')}`);
      } else writeFileSync(givenFile(id), `${dir}\n`);
      const path = place(id);

      // What git leaves out (an untracked `.abe/`, the recipe's env files), from the checkout,
      // before its start is looked for; the commit's own files stay the commit's. A team path
      // whose folder the commit lacks (an `abe/scripts/` not committed yet) gets its folder.
      for (const c of copy ?? [])
        if (c.over === true && existsSync(join(repo, c.path)))
          mkdirSync(dirname(join(path, c.path)), { recursive: true });
      await putFiles(
        repo,
        path,
        (copy ?? []).map((c) => (c.over === true ? { path: c.path } : c)),
      );
      // the prototype's own start where the place has it, else the pack's; a fixed-port repo's
      // the pack's alone (ADR 0039)
      const own = hooks['prototype-start'];
      const startScript = only === undefined && existsSync(join(path, own)) ? own : hooks.start;
      const run = hooks['worktree-setup'];
      const start = join(path, startScript);

      const refuse = async (why: string) => {
        await remove(id, repo);

        return failed('prototype-start-failed', why);
      };

      // the recipe's script, in a place made now (a developer's own worktree had it already)
      if (dir === undefined && run !== null) {
        const ran = await runWorktreeScript({
          run,
          checkout: repo,
          worktree: path,
          card: null,
          env: appEnv(o.env, env),
        });

        if (ran.exit !== 0)
          return refuse(
            `the repo's worktree script ${run} failed (${ran.exit === null ? 'killed at its time' : `exit ${ran.exit}`}):\n${tail(ran.output, 20, 4000)}\nThe script and abe.yaml's hooks.worktree-setup are the repo's: fix them there, or ask the Abe chat.`,
          );
      }

      // a developer's worktree: its packages cloned from the checkout, installed when changed
      if (dir !== undefined) {
        const ready = await prototypePackages({
          checkout: repo,
          worktree: path,
          env: appEnv(o.env, env),
          timeoutMs: INSTALL_TIMEOUT_MS,
        });
        const installed = ready?.installed ?? null;

        if (installed !== null && installed.exit !== 0)
          return refuse(
            `\`${installed.run}\` failed (${installed.exit === null ? 'killed at its time' : `exit ${installed.exit}`}) in the prototype's worktree: its package.json or lockfile changed from the main checkout's:\n${tail(installed.output, 20, 4000)}`,
          );
      }
      if (!existsSync(start))
        return refuse(
          `The repo has no ${own} (nor ${hooks.start}) at ${commit.slice(0, 7)}: add one that starts the app (the install's Prototype part writes it)`,
        );
      if (!executable(start))
        return refuse(
          `${startScript} at ${commit.slice(0, 7)} is not executable (git update-index --chmod=+x)`,
        );
      const prepared = prepare === undefined ? { ok: true as const, env: {} } : await prepare(path);

      if (!prepared.ok) return refuse(prepared.message);
      let since: Promise<string | undefined> = Promise.resolve(undefined);

      try {
        const { pgid, ...ran } = await script(start, {
          cwd: path,
          env: appEnv(o.env, { ...env, ...prepared.env }),
          ms: START_TIMEOUT_MS,
          out: join(o.dir, id, 'start'),
          // known while it runs: a stop or a restart ends a start that never does
          started: (g) => {
            inFlight.set(id, g);
            writeFileSync(groupFile(id), groupLine(g, undefined));
            since = startedAt(g);
          },
          printed: { done: printedAddress, graceMs: o.printedGraceMs ?? PRINTED_GRACE_MS },
        }).finally(() => inFlight.delete(id));

        await writeFile(groupFile(id), groupLine(pgid, await since));

        return { ok: true, data: { dir: path, ran, script: startScript } };
      } catch (err) {
        return refuse(
          `${startScript} did not run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    stop,
    cancel: (id) => {
      const pgid = inFlight.get(id);

      if (pgid !== undefined) signalGroup(pgid, 'SIGKILL');
    },
    log: (id) => join(o.dir, id, 'start.out'),
    script: async (r) => {
      const path = join(r.dir, r.script);

      if (!existsSync(path))
        return { exit: 127, stdout: '', stderr: `no script ${r.script} in ${r.dir}\n` };
      if (!executable(path))
        return {
          exit: 126,
          stdout: '',
          stderr: `${r.script} in ${r.dir} is not executable (git update-index --chmod=+x)\n`,
        };
      mkdirSync(join(o.dir, r.id), { recursive: true });
      const ran = await runInGroup([path, ...r.args], {
        cwd: r.dir,
        env: appEnv(o.env, r.env),
        ms: r.timeoutMs,
        out: join(o.dir, r.id, basename(r.script)),
      });

      return { exit: ran.timedOut ? null : ran.exit, stdout: ran.stdout, stderr: ran.stderr };
    },
  };
};
