/**
 * `abe watch` as a client: one request, then each event frame printed as it comes (its JSON line
 * with `--json`, else its readable line) until Ctrl-C (exit 0) or `serve` ends the stream (exit 3).
 * A refused watch gets an ordinary reply, printed as any command's.
 */
import {
  EXIT,
  type ExitCode,
  eventText,
  PROTOCOL,
  printFailure,
  Reply,
  WatchFrame,
} from '@abe/core';
import { follow, type Following } from '@abe/ports';
import { type ClientOptions, withServe } from './client';

export type WatchIo = {
  write: (stdout: string, stderr: string) => void;
  /** Resolves on Ctrl-C (SIGINT) or SIGTERM. */
  interrupted: Promise<void>;
};

type Connected = { ok: true; following: Following } | { ok: false; exit: ExitCode };

export const runWatch = async (
  argv: readonly string[],
  json: boolean,
  start: boolean,
  o: ClientOptions,
  io: WatchIo,
): Promise<ExitCode> => {
  /** Set by the frames as they come: the reply of a refused watch, or why the stream broke. */
  const got: {
    replied?: ExitCode;
    broken?: string;
    following?: Following;
    interrupted?: boolean;
  } = {};
  /**
   * A failure once streaming: on stderr only, since stdout carries events. (Before any event,
   * `withServe` prints it as any command's, a `--json` document included.)
   */
  const fail = (code: string, message: string, exit: 1 | 3): ExitCode => {
    io.write('', printFailure({ code, message }, exit, false).stderr);

    return exit;
  };
  const breaks = (why: string) => {
    got.broken = why;
    got.following?.close();
  };

  const see = (line: string) => {
    if (got.broken !== undefined || got.replied !== undefined) return;
    let doc: unknown;

    try {
      doc = JSON.parse(line);
    } catch {
      breaks('abe serve sent something that is not JSON');

      return;
    }
    const frame = WatchFrame.safeParse(doc);

    if (frame.success) {
      const { event } = frame.data;

      io.write(json ? `${JSON.stringify(event)}\n` : eventText(event), '');

      return;
    }
    const reply = Reply.safeParse(doc);

    if (reply.success) {
      io.write(reply.data.stdout, reply.data.stderr);
      got.replied = reply.data.exit;
    } else breaks(`abe serve sent a frame that is not a v${PROTOCOL} event or reply`);
  };

  const request = JSON.stringify({ v: PROTOCOL, argv, cwd: o.cwd });
  const connect = async (): Promise<Connected> => {
    const reached = await withServe(
      async () => {
        const one = await follow(o.where.socket, request, see);

        return one.ok ? { ok: true, value: one.following } : one;
      },
      json,
      start,
      o,
    );

    if (reached.ok) return { ok: true, following: reached.value };
    io.write(reached.printed.stdout, reached.printed.stderr);

    return { ok: false, exit: reached.printed.exit };
  };

  const connected = await connect();

  if (!connected.ok) return connected.exit;
  const { following } = connected;

  got.following = following;
  if (got.broken !== undefined) following.close();

  void io.interrupted.then(() => {
    got.interrupted = true;
    following.close();
  });
  const ended = await following.done;

  if (got.replied !== undefined) return got.replied;
  if (got.broken !== undefined) return fail('failed', got.broken, EXIT.failed);
  if (got.interrupted === true || ended.by === 'us') return EXIT.ok;
  const why =
    ended.by === 'error'
      ? `the stream from abe serve broke: ${ended.message}`
      : 'abe serve ended the stream (it stopped or is gone)';

  return fail('serve-gone', why, EXIT.unreachable);
};
