/**
 * A local session's apps (#182, #146), run by `serve` outside the session's sandbox: `abe run`'s
 * pack scripts and the database hook, each to its end in a process group of its own
 * (`runInGroup`), their output in `<state>/sessions/<id>/apps/`. A kept script's group and
 * worktree go in `apps.jsonl` there, so the pack's stop script run through `abe run` is followed
 * by those groups of its worktree stopped here (a session's own shell may signal none of them),
 * and `end` (when the session ends, by a `serve` started again too) runs the pack's stop script
 * in each worktree, stops each group, then whatever is still running with the session's socket or
 * mark in its environment (`ps -E`). IO only: which processes are the session's is core's
 * `leftovers`.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_HOOKS, leftovers, type SessionApps } from '@abe/core';
import { keptTail } from './checks';
import { runProcess } from './process';
import { alive, executable, groupAlive, runInGroup, signal, signalGroup } from './process-group';
import { realPath } from './locations';
import { sessionDir } from './sessions';

const STOP_TIMEOUT_MS = 30_000;
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** A path as a sandbox profile's string. */
const profileString = (path: string) => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * `argv` run so that it and every process it starts can read nothing at `denyRead` (each a file
 * or a folder, its real path): `sandbox-exec` with a profile that allows all else.
 */
const readDenied = (argv: readonly string[], denyRead: readonly string[]): string[] => {
  if (denyRead.length === 0) return [...argv];
  const rules = denyRead.flatMap((p) => {
    const path = profileString(realPath(p));

    return [`(deny file-read* (literal ${path}))`, `(deny file-read* (subpath ${path}))`];
  });

  return [SANDBOX_EXEC, '-p', ['(version 1)', '(allow default)', ...rules].join(' '), ...argv];
};
/** How long a TERM has before the KILL. */
const GRACE_MS = 5_000;
const PS = '/bin/ps';

/** TERM to each, then KILL to what is left after `GRACE_MS`. */
const stopAll = async (
  ids: readonly number[],
  send: (id: number, s: 'SIGTERM' | 'SIGKILL') => void,
  running: (id: number) => boolean,
) => {
  for (const id of ids) send(id, 'SIGTERM');
  const until = Date.now() + GRACE_MS;

  while (ids.some(running) && Date.now() < until) await Bun.sleep(50);
  const left = ids.filter(running);

  for (const id of left) send(id, 'SIGKILL');

  return left.length;
};

// `stop`: the repo's stop hook as the run had it; none (an older serve's): today's place
const Kept = z.object({
  pgid: z.number().int().gt(1),
  cwd: z.string(),
  stop: z.string().optional(),
});
type Kept = z.infer<typeof Kept>;

const keptOf = (file: string): Kept[] => {
  if (!existsSync(file)) return [];

  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const k = Kept.safeParse(JSON.parse(line));

        return k.success ? [k.data] : [];
      } catch {
        return [];
      }
    });
};

const ended = (ran: { exit: number; timedOut: boolean } | undefined) => {
  if (ran === undefined) return 'did not run';

  return ran.timedOut ? 'killed' : `exit ${ran.exit}`;
};

/**
 * What is still running with the session's mark (and its socket, when given) in its environment,
 * by `ps -E` (serve's own, outside any sandbox).
 */
const marked = async (o: { id: string; socket?: string }) => {
  const ps = await runProcess([PS, '-axwwE', '-o', 'pid=,pgid=,command='], {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
  }).catch(() => undefined);

  return ps?.exit === 0
    ? leftovers(ps.stdout, { ...o, self: process.pid })
    : { pids: [], groups: [] };
};

/** Of the kept groups, those a process with the session's mark is still in. */
const oursOf = (kept: readonly Kept[], left: { groups: readonly number[] }) => {
  const ours = new Set(left.groups);

  return [...new Set(kept.map((k) => k.pgid))].filter(
    (g) => ours.has(g) && g !== process.pid && groupAlive(g),
  );
};

export const localSessionApps = (o: { stateDir: string }): SessionApps => {
  const dirOf = (id: string) => join(sessionDir(o.stateDir, id), 'apps');
  let n = 0;

  /** The pack's stop script ran in `cwd`: the groups kept for it stopped, and no longer kept. */
  const stopped = async (id: string, cwd: string) => {
    const file = join(dirOf(id), 'apps.jsonl');
    const kept = keptOf(file);
    const here = kept.filter((k) => k.cwd === cwd);

    if (here.length === 0) return;
    const groups = oursOf(here, await marked({ id }));

    if (groups.length > 0) await stopAll(groups, signalGroup, groupAlive);
    const rest = kept.filter((k) => k.cwd !== cwd);

    writeFileSync(file, rest.map((k) => `${JSON.stringify(k)}\n`).join(''));
  };

  return {
    run: async (r) => {
      const dir = dirOf(r.id);
      const path = join(r.cwd, r.script);

      if (!existsSync(path))
        return { exit: 127, stdout: '', stderr: `no script ${r.script} in ${r.cwd}\n` };
      if (!executable(path))
        return {
          exit: 126,
          stdout: '',
          stderr: `${r.script} in ${r.cwd} is not executable (git update-index --chmod=+x)\n`,
        };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      n += 1;
      const ran = await runInGroup(readDenied([path, ...r.args], r.denyRead ?? []), {
        cwd: r.cwd,
        env: r.env,
        ms: r.timeoutMs,
        out: join(dir, `${Date.now()}-${n}`),
      });

      const stop = r.stop ?? DEFAULT_HOOKS.stop;

      if (r.keep && r.script === stop) await stopped(r.id, r.cwd);
      else if (r.keep)
        appendFileSync(
          join(dir, 'apps.jsonl'),
          `${JSON.stringify({ pgid: ran.pgid, cwd: r.cwd, stop })}\n`,
        );

      return {
        exit: ran.timedOut ? null : ran.exit,
        stdout: keptTail(ran.stdout),
        stderr: keptTail(ran.stderr),
      };
    },
    end: async (e) => {
      const dir = dirOf(e.id);
      const file = join(dir, 'apps.jsonl');
      const kept = keptOf(file);
      const said: string[] = [];

      const stops = new Map(kept.map((k) => [k.cwd, k.stop ?? DEFAULT_HOOKS.stop]));

      for (const [cwd, script] of stops) {
        const stop = join(cwd, script);

        if (!existsSync(stop) || !executable(stop)) continue;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const ran = await runInGroup([stop], {
          cwd,
          env: e.env,
          ms: STOP_TIMEOUT_MS,
          out: join(dir, `stop-${Date.now()}`),
        }).catch(() => undefined);

        said.push(`${script} in ${cwd}: ${ended(ran)}`);
      }
      // Only a kept group one of the session's marked processes is still in: its number may
      // belong to someone else's group by now (reused, a reboot).
      const left = await marked({ id: e.id, socket: e.socket });
      const groups = oursOf(kept, left);

      if (groups.length > 0) {
        const killed = await stopAll(groups, signalGroup, groupAlive);

        said.push(
          `stopped ${groups.length} process group(s)${killed > 0 ? `, ${killed} killed` : ''}`,
        );
      }
      const pids = left.pids.filter(alive);

      if (pids.length > 0) {
        const killed = await stopAll(pids, signal, alive);

        said.push(
          `stopped ${pids.length} process(es) the session left${killed > 0 ? `, ${killed} killed` : ''}`,
        );
      }
      rmSync(file, { force: true });

      return said;
    },
  };
};
