/**
 * The test seam's `$ABE_SERVE_OWNER_PID`: the serve belongs to that process and ends once it is
 * gone, so a test run that fails, times out or is killed (SIGKILL too) leaves nothing
 * running. The serve polls the pid itself from its first line on, while it still starts too, and
 * exits even when its stop never settles: a stop that hangs or a handle left open keeps no orphan.
 */

/** The owner's pid, when this serve has one. */
export const ownerOf = (env: Record<string, string | undefined>): number | undefined => {
  const pid = Number(env.ABE_SERVE_OWNER_PID ?? '');

  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/** Whether `pid` runs: EPERM is there, someone else's. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
};

export type OwnerWatchOptions = {
  pid: number;
  alive: (pid: number) => boolean;
  /** Ends what the serve runs (its sessions' tmux server, the serve itself). */
  gone: () => Promise<void>;
  /** Ends the process: once `gone` settled, or after `graceMs` when it does not. */
  exit: () => void;
  everyMs?: number;
  graceMs?: number;
};

/** Polls the owner; returns what stops the polling. */
export const watchOwner = (o: OwnerWatchOptions): (() => void) => {
  const timer = setInterval(() => {
    if (o.alive(o.pid)) return;
    clearInterval(timer);
    let ended = false;
    const exit = () => {
      if (ended) return;
      ended = true;
      o.exit();
    };
    const deadline = setTimeout(exit, o.graceMs ?? 5_000);
    let ending: Promise<void>;

    try {
      ending = o.gone();
    } catch (err) {
      ending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    void ending
      .catch(() => undefined)
      .then(() => {
        clearTimeout(deadline);
        exit();
      });
  }, o.everyMs ?? 500);

  return () => {
    clearInterval(timer);
  };
};
