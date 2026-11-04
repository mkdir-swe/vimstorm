/**
 * `abe box attach` (#91): this terminal on a box over EC2 Instance Connect SSH, in a reconnect
 * loop. The loop runs ssh again at once when its connection drops (ssh's exit 255: keepalives
 * gave up, the network went, the endpoint's 1 h cap), then every 0.5 s while it fails, so after
 * a dropped network or a sleep the terminal is back without the person doing anything; tmux on
 * the box keeps what ran. It stops on the remote's own exit (a detach, the shell's `exit`), on a
 * refusal the tunnel says is final, or after `giveUpMs` without a connection.
 *
 * A `--` command without a terminal (VimStorm's ⌃W exec, Download locally) is one connection:
 * tried again only while it has not started, so it never runs twice: the box first writes a mark
 * line on stderr (taken out again here), and once it came, or stdin went to that ssh, a 255 (ssh's
 * exit for a drop and for a remote killed by a signal alike) is the end. With `--shared` (#93,
 * VimStorm's tree listings and git) it is a channel on the box's shared connection
 * (`EiceLink.shared`): a round trip; a master that went is made again by the try after.
 */
import type { Answered } from '@abe/core';
import { type AttachWhat, BEGAN, remoteOf, wakingLine } from './attach-words';
import { type EiceLink, fatalOf, mendable, UP_MS } from './eice-link';

export type { AttachWhat } from './attach-words';

export type AttachLoopOptions = {
  link: EiceLink;
  box: string;
  what: AttachWhat;
  /** Whether stdin is a terminal (a `--` command gets one only then). */
  tty: boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A line for the person (stderr). */
  say: (line: string) => void;
  /** Wakes a stopped box (`Boxes.start`, then running). */
  wake?: (box: string) => Promise<Answered<null>>;
  /** No connection for this long: give up (default 5 min). */
  giveUpMs?: number;
  /** Set when the person leaves (SIGINT before ssh owns the terminal, SIGTERM, SIGHUP). */
  leaving?: AbortSignal;
};

/** ssh's stderr piped on, the box's first line taken out when it is the mark (`began`). */
const pumpErr = async (from: ReadableStream<Uint8Array>, began: () => void) => {
  const err = Bun.stderr.writer();
  let head: Uint8Array | null = new Uint8Array(0);

  for await (const chunk of from) {
    if (head === null) {
      void err.write(chunk);
      void err.flush();
      continue;
    }
    const all: Uint8Array = new Uint8Array([...head, ...chunk]);
    const nl = all.indexOf(10);

    if (nl < 0) {
      head = all;
      continue;
    }
    const first = new TextDecoder().decode(all.subarray(0, nl));

    head = null;
    if (first === BEGAN) began();
    void err.write(first === BEGAN ? all.subarray(nl + 1) : all);
    void err.flush();
  }
  if (head !== null && head.length > 0) void err.write(head);
  await err.flush();
};

/** The child's stdout piped on, counting what came back. */
const pump = async (
  from: ReadableStream<Uint8Array>,
  to: (b: Uint8Array) => void,
  seen: () => void,
) => {
  for await (const chunk of from) {
    seen();
    to(chunk);
  }
};

type Sink = { write: (b: Uint8Array) => unknown; flush: () => unknown; end: () => unknown };

/**
 * This process's stdin, read once for the whole loop and handed to each connection's ssh in turn:
 * what comes while no ssh runs waits for the next. `into` answers whether that ssh got any.
 */
const stdinFeed = () => {
  const held: Uint8Array[] = [];
  const feed: { sink: Sink | undefined; gave: boolean; ended: boolean; reading: boolean } = {
    sink: undefined,
    gave: false,
    ended: false,
    reading: false,
  };
  const read = async () => {
    for await (const chunk of Bun.stdin.stream()) {
      if (feed.sink === undefined) held.push(chunk);
      else {
        feed.gave = true;
        feed.sink.write(chunk);
        void feed.sink.flush();
      }
    }
    feed.ended = true;
    void feed.sink?.end();
  };

  return {
    into: (sink: Sink): (() => boolean) => {
      feed.sink = sink;
      feed.gave = false;
      for (const chunk of held.splice(0)) {
        feed.gave = true;
        sink.write(chunk);
      }
      void sink.flush();
      if (feed.ended) void sink.end();
      if (!feed.reading) {
        feed.reading = true;
        read().catch(() => undefined);
      }

      return () => {
        feed.sink = undefined;

        return feed.gave;
      };
    },
  };
};

export const attachLoop = async (o: AttachLoopOptions): Promise<number> => {
  const giveUpMs = o.giveUpMs ?? 5 * 60_000;
  const tty = 'command' in o.what ? o.tty : true;
  const remote = remoteOf(o.what, tty);
  const shared = 'command' in o.what && o.what.shared === true && !tty;
  let lostAt: number | undefined;
  let tries = 0;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const left = () => o.leaving?.aborted === true;
  const input = stdinFeed();

  o.leaving?.addEventListener('abort', () => {
    child?.kill();
  });
  for (;;) {
    if (left()) return 130;
    const call = shared
      ? await o.link.shared(o.box, remote)
      : await o.link.connection(o.box, { tty, remote });

    if (!call.ok && call.error.code === 'box-stopped' && o.wake !== undefined) {
      o.say(wakingLine(o.box, call.error.message));
      const woke = await o.wake(o.box);

      if (!woke.ok) {
        o.say(`abe: ${woke.error.message}`);

        return 1;
      }
      // Its address read anew (running now), and ssh tried until its sshd is up.
      o.link.forget(o.box);
      lostAt ??= o.now();
      continue;
    }
    if (!call.ok) {
      if (mendable(call.error.code) && lostAt !== undefined && o.now() - lostAt < giveUpMs) {
        await o.sleep(500);
        continue;
      }
      o.say(`abe: ${call.error.message}`);

      return 1;
    }
    const started = o.now();
    let exit: number;
    // Whether the box may have seen this connection's command: no retry then.
    let began: boolean;

    if (tty) {
      child = Bun.spawn(call.data.argv, {
        env: call.data.env,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      exit = await child.exited;
      began = false;
    } else {
      const seen = { back: false, began: false };
      const ran = Bun.spawn(call.data.argv, {
        env: call.data.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const errs = pumpErr(ran.stderr, () => {
        seen.began = true;
      });

      child = ran;
      const out = Bun.stdout.writer();
      const piped = pump(
        ran.stdout,
        (b) => {
          void out.write(b);
          void out.flush();
        },
        () => {
          seen.back = true;
        },
      );
      const given = input.into(ran.stdin);

      exit = await ran.exited;
      await Promise.all([piped, errs]);
      await out.flush();
      began = seen.began || seen.back || given();
    }
    child = undefined;
    if (left()) return exit === 255 ? 130 : exit;
    if (exit !== 255) return exit;
    const why = fatalOf(call.data.status);

    if (why !== undefined) {
      o.say(`abe: ${why}`);

      return 1;
    }
    // A command that started is not run again: its input may be half sent.
    if (!tty && began) return 255;
    const now = o.now();

    if (lostAt === undefined || now - started >= UP_MS) {
      lostAt = now;
      tries = 0;
      if (tty) o.say(`\r\nabe: the connection to ${o.box} dropped, reconnecting…\r`);
    }
    if (now - lostAt >= giveUpMs) {
      o.say(`abe: no connection to ${o.box} for ${Math.round(giveUpMs / 1000)} s, giving up`);

      return 255;
    }
    tries += 1;
    // At once the first time, then every half second.
    if (tries > 1) await o.sleep(500);
  }
};
