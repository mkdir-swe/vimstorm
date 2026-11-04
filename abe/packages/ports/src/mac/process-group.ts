/**
 * A script run to its end in a process group of its own, outside any sandbox: what it leaves
 * running in the background stays in that group unless it makes its own, so the group can be
 * stopped later. Its output goes into files rather than pipes: a server it leaves running keeps
 * whatever it inherited, and a pipe would never close.
 */
import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** How often a run watched for its printed line reads its output. */
const PRINTED_POLL_MS = 250;

/** Signals a process group; one already gone is fine. */
export const signalGroup = (pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Gone already.
  }
};

/** Whether anything of the group still runs. */
export const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Whether `path` may be run. */
export const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

/** Whether the process still runs. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Signals a process; one already gone is fine. */
export const signal = (pid: number, s: 'SIGTERM' | 'SIGKILL'): void => {
  try {
    process.kill(pid, s);
  } catch {
    // Gone already.
  }
};

/**
 * `argv` in `cwd` with exactly `env`, to its end; after `ms` the whole group is killed. `started`
 * hears its group as soon as it runs. With `printed`, once its stdout so far passes `printed.done`
 * it has `printed.graceMs` more to end, else the group is killed too (`timedOut`). `ms` back: how
 * long it ran.
 */
export const runInGroup = async (
  argv: readonly string[],
  o: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    ms: number;
    out: string;
    started?: (pgid: number) => void;
    printed?: { done: (stdout: string) => boolean; graceMs: number };
  },
): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  pgid: number;
  ms: number;
}> => {
  const began = Date.now();
  const stdout = `${o.out}.out`;
  const stderr = `${o.out}.err`;
  const child = Bun.spawn([...argv], {
    cwd: o.cwd,
    env: { ...o.env },
    detached: true,
    stdin: 'ignore',
    stdout: Bun.file(stdout),
    stderr: Bun.file(stderr),
  });
  let timedOut = false;
  const kill = () => {
    timedOut = true;
    signalGroup(child.pid, 'SIGKILL');
  };
  const read = (p: string) => readFile(p, 'utf8').catch(() => '');

  o.started?.(child.pid);
  const timer = setTimeout(kill, o.ms);
  let grace: ReturnType<typeof setTimeout> | undefined;
  // never a kill once it ended: its group's number may be someone else's by then
  let ended = false;
  const printed = o.printed;
  const watch =
    printed === undefined
      ? undefined
      : setInterval(() => {
          void read(stdout).then((text) => {
            if (ended || grace !== undefined || !printed.done(text)) return;
            grace = setTimeout(kill, printed.graceMs);
          });
        }, PRINTED_POLL_MS);
  const exit = await child.exited.finally(() => {
    ended = true;
    clearTimeout(timer);
    clearTimeout(grace);
    clearInterval(watch);
  });

  return {
    exit,
    stdout: await read(stdout),
    stderr: await read(stderr),
    timedOut,
    pgid: child.pid,
    ms: Date.now() - began,
  };
};
