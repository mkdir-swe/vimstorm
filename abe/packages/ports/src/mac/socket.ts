/**
 * Newline-delimited JSON on a unix socket, as text: one line in, then one line out per
 * connection, or a stream of lines (`abe watch`). The frames' meaning is core's (`readRequest`,
 * `Reply`, `WatchFrame`); this only moves lines.
 */
import { chmod, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

/** macOS refuses a unix socket path longer than 103 bytes. */
const MAX_PATH = 103;
const MAX_LINE = 1024 * 1024;
/** A stream reader this far behind is cut off, so a stalled one cannot fill `serve`'s memory. */
const MAX_BEHIND = 8 * 1024 * 1024;
/** How long an ended stream gets to flush before it is cut, so a reader that stopped reading cannot hold up `close()`. */
const FLUSH_MS = 1000;

export type Asked =
  | { ok: true; line: string }
  /** Nothing listens there: the request was never delivered, so it is safe to send again. */
  | { ok: false; unreachable: true; message: string }
  | { ok: false; unreachable: false; message: string };

const codeOf = (err: unknown) =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;

const NOT_LISTENING = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES', 'ECONNRESET']);

/**
 * Sends one line and reads the answer line. Never throws. With `timeoutMs`, a connection with no
 * answer by then is closed (not `unreachable`: the request may have been delivered).
 */
export const ask = (path: string, line: string, timeoutMs?: number): Promise<Asked> =>
  new Promise((resolve) => {
    let answer = '';
    let connected = false;
    const conn = createConnection(path);

    if (timeoutMs !== undefined)
      conn.setTimeout(timeoutMs, () => {
        conn.destroy();
        resolve({ ok: false, unreachable: false, message: `no answer in ${timeoutMs} ms` });
      });

    conn.setEncoding('utf8');
    conn.on('connect', () => {
      connected = true;
      conn.write(`${line}\n`);
    });
    conn.on('data', (chunk: string) => {
      answer += chunk;
    });
    conn.on('end', () => {
      const nl = answer.indexOf('\n');

      resolve(
        nl < 0
          ? {
              ok: false,
              unreachable: false,
              message: 'abe serve closed the connection without an answer',
            }
          : { ok: true, line: answer.slice(0, nl) },
      );
    });
    conn.on('error', (err) => {
      const code = codeOf(err);

      resolve({
        ok: false,
        unreachable: !connected && code !== undefined && NOT_LISTENING.has(code),
        message: err.message,
      });
    });
  });

/** How a followed stream ended: the other side ended it, `close()` did, or the connection broke. */
export type Ended = { by: 'them' } | { by: 'us' } | { by: 'error'; message: string };

export type Following = { done: Promise<Ended>; close: () => void };

/**
 * Sends one line and hands each line of the answer to `see` as it comes, until either side ends
 * the connection. Resolves once connected (or with why not, as `ask`). Never throws.
 */
export const follow = (
  path: string,
  line: string,
  see: (line: string) => void,
): Promise<{ ok: true; following: Following } | Exclude<Asked, { ok: true }>> =>
  new Promise((resolve) => {
    let text = '';
    let connected = false;
    let closing = false;
    const ended = Promise.withResolvers<Ended>();
    const conn = createConnection(path);

    conn.setEncoding('utf8');
    conn.on('connect', () => {
      connected = true;
      conn.write(`${line}\n`);
      resolve({
        ok: true,
        following: {
          done: ended.promise,
          close: () => {
            closing = true;
            conn.destroy();
          },
        },
      });
    });
    conn.on('data', (chunk: string) => {
      text += chunk;
      let nl = text.indexOf('\n');

      while (nl >= 0) {
        see(text.slice(0, nl));
        text = text.slice(nl + 1);
        nl = text.indexOf('\n');
      }
      if (text.length > MAX_LINE) conn.destroy(new Error('a line longer than 1 MiB'));
    });
    conn.on('close', () => {
      ended.resolve(closing ? { by: 'us' } : { by: 'them' });
    });
    conn.on('error', (err) => {
      if (!connected) {
        const code = codeOf(err);

        resolve({
          ok: false,
          unreachable: code !== undefined && NOT_LISTENING.has(code),
          message: err.message,
        });

        return;
      }
      if (!closing) ended.resolve({ by: 'error', message: err.message });
    });
  });

export type Listener = { close: () => Promise<void> };

/** The open end of a streamed answer. */
export type Outgoing = {
  /** Writes one line; false once the connection is gone (or cut off for falling behind). */
  send: (line: string) => boolean;
  /** Ends the stream from this side: what was sent gets `FLUSH_MS` to arrive, then it is cut. */
  end: () => void;
  /** Whether it was cut off for falling `MAX_BEHIND` behind. */
  cut: () => boolean;
  /** Runs once when the connection closes, from either side. */
  onClose: (fn: () => void) => void;
};

/** One line back and close, or keep the connection and stream lines on it. */
export type Answer =
  | {
      line: string;
      after?: () => void;
      /** Runs when its client had gone before the line was written: nobody reads it. */
      gone?: () => void;
    }
  | { stream: (out: Outgoing) => void };

const outgoing = (conn: Socket): Outgoing => {
  let cut = false;
  const send = (line: string) => {
    if (conn.destroyed || conn.writableEnded) return false;
    if (conn.writableLength > MAX_BEHIND) {
      cut = true;
      conn.destroy();

      return false;
    }
    conn.write(`${line}\n`);

    return true;
  };

  return {
    send,
    end: () => {
      if (conn.writableEnded) return;
      const timer = setTimeout(() => conn.destroy(), FLUSH_MS);

      conn.once('close', () => {
        clearTimeout(timer);
      });
      conn.end(() => conn.destroy());
    },
    cut: () => cut,
    onClose: (fn) => {
      if (conn.destroyed) fn();
      else conn.once('close', fn);
    },
  };
};

export class SocketInUse extends Error {}

const bind = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

export type ListenOptions = {
  /**
   * How often the socket file is checked to still be this listener's; one gone or replaced by a
   * dead one is bound again. Off by default (serve's own socket checks it).
   */
  checkMs?: number;
  /** Something else answers on `path` now: this listener stopped there (the check's). */
  lost?: () => void;
  /** Runs once `path` is no longer this listener's: closed, or lost. */
  unlisted?: () => void;
};

type Bound = { server: Server; dev: number; ino: number };

const sameFile = (a: { dev: number; ino: number } | undefined, b: { dev: number; ino: number }) =>
  a?.dev === b.dev && a.ino === b.ino;

const statOf = (path: string) => stat(path).catch(() => undefined);

const probeTimeoutMs = 2_000;

/** Whether nothing listens on `path`: a socket file there is stale. */
const unanswered = async (path: string) => {
  const probe = await ask(path, '{}', probeTimeoutMs);

  return !probe.ok && probe.unreachable;
};

let binds = 0;

/**
 * Listens on `path`, answering each connection's first line with `answer(line)`; `after` runs once
 * the answer is written. A socket file nobody answers on is stale and replaced; one that answers
 * is `SocketInUse`. The socket is bound beside `path` and moved onto it, so it replaces a stale
 * one in one step, and its close removes `path` only while that is still this socket (Bun's own
 * close removes the path it bound, whoever's it is by then).
 */
export const listen = async (
  path: string,
  answer: (line: string) => Promise<Answer>,
  /** The owner's alone by default; a workspace's is `0o666` (its container's uid may differ). */
  mode = 0o600,
  o: ListenOptions = {},
): Promise<Listener> => {
  if (Buffer.byteLength(path) > MAX_PATH)
    throw new Error(`the socket path is longer than ${MAX_PATH} bytes: ${path}`);
  const streams = new Set<Outgoing>();
  let closing = false;
  const onConnection = (conn: Socket) => {
    let text = '';

    conn.setEncoding('utf8');
    conn.on('error', () => undefined);
    const onData = (chunk: string) => {
      text += chunk;
      const nl = text.indexOf('\n');

      if (nl < 0) {
        if (text.length > MAX_LINE) conn.destroy();

        return;
      }
      conn.off('data', onData);
      answer(text.slice(0, nl)).then(
        (out) => {
          if ('line' in out) {
            if (conn.destroyed) out.gone?.();
            conn.end(`${out.line}\n`, () => out.after?.());

            return;
          }
          const open = outgoing(conn);

          streams.add(open);
          open.onClose(() => streams.delete(open));
          out.stream(open);
          // Asked for while closing: closed streams already, so end this one too.
          if (closing) open.end();
        },
        // A throw has no answer to give: close, so the client hears it at once.
        () => conn.destroy(),
      );
    };

    conn.on('data', onData);
  };
  /** A new socket at a name of this process's beside `path`, then moved onto `path`. */
  const bindOnto = async (): Promise<Bound> => {
    binds += 1;
    const short = `.${process.pid.toString(36)}-${binds.toString(36)}`;
    const aside = join(dirname(path), short);

    if (Buffer.byteLength(aside) > MAX_PATH)
      throw new Error(`the socket path is longer than ${MAX_PATH} bytes: ${aside}`);
    // the state folder removed under a running serve is made again
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await unlink(aside).catch(() => undefined);
    const server = createServer(onConnection);

    await bind(server, aside);
    try {
      await chmod(aside, mode);
      const { dev, ino } = await stat(aside);

      await rename(aside, path);

      return { server, dev, ino };
    } catch (err) {
      server.close();
      throw err;
    }
  };

  if ((await statOf(path)) !== undefined && !(await unanswered(path)))
    throw new SocketInUse(`something answers on ${path}`);
  let bound = await bindOnto();
  let unlisted = false;
  const unlist = () => {
    if (unlisted) return;
    unlisted = true;
    o.unlisted?.();
  };
  let checking: Promise<void> | undefined;
  /** `path` is still this socket; a gone or dead one is bound again, a live other one is lost. */
  const check = async () => {
    const now = await statOf(path);

    if (closing || sameFile(now, bound)) return;
    if (now !== undefined && !(await unanswered(path))) {
      clearInterval(timer);
      bound.server.close();
      unlist();
      o.lost?.();

      return;
    }
    const was = bound;

    bound = await bindOnto();
    was.server.close();
  };
  const timer =
    o.checkMs === undefined
      ? undefined
      : setInterval(() => {
          // a failed bind is tried again next time
          checking ??= check()
            .catch(() => undefined)
            .finally(() => {
              checking = undefined;
            });
        }, o.checkMs);

  timer?.unref();

  return {
    close: async () => {
      // A stream stays open until one side ends it: end them, or close() would wait forever.
      closing = true;
      clearInterval(timer);
      await checking;
      for (const open of streams) open.end();
      if (sameFile(await statOf(path), bound)) await unlink(path).catch(() => undefined);
      const closed = new Promise<void>((resolve) => {
        bound.server.close(() => {
          resolve();
        });
      });

      unlist();
      await closed;
    },
  };
};
