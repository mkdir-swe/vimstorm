/**
 * One `abe serve` per state folder: an exclusive lock on a file beside its socket (`serve.lock`
 * for `serve.sock`), taken before anything touches the socket and held while it listens. The
 * kernel's own lock (`flock`, `O_EXLOCK` on macOS), so a serve that dies, SIGKILL too, holds
 * nothing. The file says who holds it (`<pid>`, then `<pid> listening`); a serve that holds it,
 * says it listens and has answered on nothing for `deadMs` (or never got to listen in
 * `startingMs`) is ended so the one asking takes over.
 */
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ask } from './socket';

const LOCK_EX = 2;
const LOCK_NB = 4;
/** macOS's `open(2)` flags Node does not name. */
const DARWIN = { exlock: 0x20, cloexec: 0x1000000 };
const LINUX_CLOEXEC = 0o2000000;

export type Held = {
  /** Says in the file that the holder listens now. */
  listening: () => void;
  /** Lets go of the lock (idempotent). */
  release: () => void;
};

/** The lock file of a socket: `serve.sock` → `serve.lock`. */
export const lockPathOf = (socket: string): string =>
  join(dirname(socket), `${basename(socket).replace(/\.sock$/, '')}.lock`);

type Flock = (fd: number, op: number) => number;

let flocker: Promise<Flock | null> | undefined;

/** `flock(2)` through Bun's FFI, where `open` cannot lock (Linux); null without FFI. */
const flockOf = (): Promise<Flock | null> =>
  (flocker ??= import('bun:ffi')
    .then(
      ({ dlopen, FFIType }) => {
        const lib = dlopen('libc.so.6', {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });

        return (fd: number, op: number) => lib.symbols.flock(fd, op);
      },
      () => null,
    )
    .catch(() => null));

const codeOf = (err: unknown) =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

/** The open file, locked; undefined when another holds it. */
const openLocked = async (path: string): Promise<number | undefined> => {
  const base = constants.O_RDWR | constants.O_CREAT;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  if (process.platform === 'darwin')
    try {
      return openSync(path, base | DARWIN.exlock | DARWIN.cloexec | constants.O_NONBLOCK, 0o600);
    } catch (err) {
      if (codeOf(err) === 'EAGAIN' || codeOf(err) === 'EWOULDBLOCK') return undefined;
      throw err;
    }
  const flock = await flockOf();
  const fd = openSync(path, base | LINUX_CLOEXEC, 0o600);

  // no lock to take here (no FFI): the socket's own checks are all there is
  if (flock === null || flock(fd, LOCK_EX | LOCK_NB) === 0) return fd;
  closeSync(fd);

  return undefined;
};

const write = (fd: number, text: string) => {
  ftruncateSync(fd, 0);
  writeSync(fd, text, 0);
};

/** Takes the lock at `path` now: what lets it go, or undefined when another process holds it. */
export const tryLock = async (path: string): Promise<Held | undefined> => {
  const fd = await openLocked(path);

  if (fd === undefined) return undefined;
  let open = true;

  write(fd, `${process.pid}\n`);

  return {
    listening: () => {
      if (open) write(fd, `${process.pid} listening\n`);
    },
    release: () => {
      if (!open) return;
      open = false;
      // the next holder writes its own: an empty file names nobody
      ftruncateSync(fd, 0);
      closeSync(fd);
    },
  };
};

export type Holder = { pid: number; listening: boolean; sinceMs: number };

/** Who the lock file names, as it last said (its holder may have gone since). */
export const holderOf = (path: string): Holder | undefined => {
  try {
    const [pid, state] = readFileSync(path, 'utf8').trim().split(' ');
    const n = Number(pid);

    return Number.isInteger(n) && n > 0
      ? { pid: n, listening: state === 'listening', sinceMs: statSync(path).mtimeMs }
      : undefined;
  } catch {
    return undefined;
  }
};

export type Locked = { ok: true; held: Held } | { ok: false; holder: number | undefined };

export type TakeLockOptions = {
  /** Listening and unreachable this long: ended (default 10 s, twice the socket's own check). */
  deadMs?: number;
  /** Not listening this long after it took the lock: ended (default 60 s). */
  startingMs?: number;
  /** After SIGTERM, how long before SIGKILL (default 5 s). */
  graceMs?: number;
  everyMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
};

const killing = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
  try {
    process.kill(pid, signal);
  } catch {
    // gone already
  }
};

/**
 * The lock of the serve on `socket`. Held by a serve that answers there, or one still starting:
 * not ok, it runs. Held by one that says it listens but nothing answers (its socket gone, or it
 * hangs) for `deadMs`: that one is ended (SIGTERM, then SIGKILL) and the lock taken. A holder
 * that is leaving lets go meanwhile, and the lock is taken then.
 */
export const takeLock = async (socket: string, o: TakeLockOptions = {}): Promise<Locked> => {
  const path = lockPathOf(socket);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const kill = o.kill ?? killing;
  const deadMs = o.deadMs ?? 10_000;
  const startingMs = o.startingMs ?? 60_000;
  const graceMs = o.graceMs ?? 5_000;
  const everyMs = o.everyMs ?? 200;
  let unreachableSince: number | undefined;
  let blank = 0;
  /** The hung holder being ended, and when it was sent SIGTERM. */
  let ending: { pid: number; at: number; killed: boolean } | undefined;

  for (;;) {
    const held = await tryLock(path);

    if (held !== undefined) return { ok: true, held };
    const holder = holderOf(path);

    // held, and named nowhere: one taking it or letting it go, a moment
    if (holder === undefined) {
      blank += 1;
      if (blank * everyMs > graceMs) return { ok: false, holder: undefined };
      await sleep(everyMs);
      continue;
    }
    // a holder in this process (a test's other serve) is never ended
    if (holder.pid === process.pid) return { ok: false, holder: holder.pid };
    if (ending === undefined) {
      const probe = await ask(socket, '{}', 2_000);

      if (probe.ok || !probe.unreachable) return { ok: false, holder: holder.pid };
      const at = now();

      unreachableSince ??= at;
      const hung = holder.listening
        ? at - unreachableSince >= deadMs
        : Date.now() - holder.sinceMs >= startingMs;

      // still starting: it answers soon, and the client waits for it
      if (!holder.listening && !hung) return { ok: false, holder: holder.pid };
      if (hung) {
        kill(holder.pid, 'SIGTERM');
        ending = { pid: holder.pid, at, killed: false };
      }
    } else {
      // another start took the lock once it was let go: that one runs
      if (holder.pid !== ending.pid) return { ok: false, holder: holder.pid };
      if (!ending.killed && now() - ending.at >= graceMs) {
        kill(ending.pid, 'SIGKILL');
        ending.killed = true;
      } else if (now() - ending.at >= graceMs * 2) return { ok: false, holder: holder.pid };
    }
    await sleep(everyMs);
  }
};
