/**
 * The fake `ssh` (`fakeSsh`). It reads ssh's own argv, runs its `ProxyCommand`, which is abe's
 * real tunnel, and speaks `wire.ts` through it to the fake box. Like ssh it exits with the remote
 * command's exit, or 255 when the connection fails or drops. Each call's argv is one JSON line in
 * `$FAKE_SSH_LOG`. `-N -L` listens and opens one tunnel per connection made to it.
 *
 * ControlMaster works as in OpenSSH. `-M -N -f -S <socket> -o ControlPersist=<s>` logs in once
 * through the ProxyCommand. Then a copy of itself (`$FAKE_SSH_MASTER`) goes to the background and
 * serves the socket. `-S <socket> … <command>` runs the command as a channel on it. When the socket
 * answers nothing, it connects on its own as ssh does. `-O check` and `-O exit` ask the master.
 * The master leaves when its connection ends, after ControlPersist seconds with no channel, or on
 * `-O exit`, and removes its socket. A SIGKILL leaves the socket behind, as ssh's does.
 */
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { type ChannelOpen, chan, FRAME, frame, type Hello, reader, unchan } from './wire';

const argv = process.argv.slice(2);
const log = process.env.FAKE_SSH_LOG ?? '';
/** This process is a master gone to the background (`-f`). */
const daemon = process.env.FAKE_SSH_MASTER === '1';

if (log !== '' && !daemon) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const VALUED = new Set([
  '-o',
  '-i',
  '-L',
  '-p',
  '-F',
  '-l',
  '-E',
  '-S',
  '-W',
  '-b',
  '-c',
  '-D',
  '-R',
  '-O',
]);
const options = new Map<string, string>();
let key = '';
let tty = false;
let none = false;
let forward: { local: number; remote: number } | undefined;
let master = false;
let fork = false;
let socketPath = '';
let control = '';
let at = 0;

for (; at < argv.length; at += 1) {
  const a = argv[at] ?? '';

  if (!a.startsWith('-')) break;
  if (VALUED.has(a)) {
    const v = argv[at + 1] ?? '';

    at += 1;
    if (a === '-o') {
      const eq = v.indexOf('=');

      options.set(v.slice(0, eq).toLowerCase(), v.slice(eq + 1));
    }
    if (a === '-i') key = v;
    if (a === '-S') socketPath = v;
    if (a === '-O') control = v;
    if (a === '-L') {
      const parts = v.split(':');

      forward = { local: Number(parts[1]), remote: Number(parts[3]) };
    }
    continue;
  }
  if (a.includes('t')) tty = true;
  if (a.includes('N')) none = true;
  if (a.includes('M')) master = true;
  if (a.includes('f')) fork = true;
}
if (socketPath === '') socketPath = options.get('controlpath') ?? '';
if (['yes', 'auto'].includes(options.get('controlmaster') ?? '')) master = true;
const persistText = options.get('controlpersist') ?? 'no';
/** ControlPersist in seconds. Null means for as long as the connection lasts. */
const persist = persistText === 'yes' ? null : Number(persistText) || 0;
const target = argv[at] ?? '';
const words = argv.slice(at + 1);
const [user, host] = target.includes('@') ? target.split('@') : ['', target];
const proxy = (options.get('proxycommand') ?? '')
  .replaceAll('%h', host ?? '')
  .replaceAll('%p', '22');

const fail = (why: string): never => {
  process.stderr.write(`${why}\n`);
  process.exit(255);
};

/** The key ssh offers, read only when it connects on its own. A master's channel offers none. */
const offeredKey = (): string => {
  if (proxy === '') fail('fake ssh: no ProxyCommand');
  const ran = Bun.spawnSync(['ssh-keygen', '-y', '-f', key]);

  return ran.exitCode === 0
    ? ran.stdout.toString().trim().split(' ').slice(0, 2).join(' ')
    : fail(`fake ssh: no key at ${key}`);
};

/** One connection through a fresh ProxyCommand. It sends `hello` and hands frames to `onFrame`. */
const connect = (hello: Hello, onFrame: (type: number, payload: Uint8Array) => void) => {
  /** A `-L` connection goes raw once the box says ready. A master's connection stays framed. */
  const mode = { raw: false };
  const child = Bun.spawn(['/bin/sh', '-c', `exec ${proxy}`], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
  });

  void child.stdin.write(frame(FRAME.hello, JSON.stringify(hello)));
  void child.stdin.flush();
  const read = reader((type, payload) => {
    if (type === FRAME.ready && hello.mux !== true) mode.raw = true;
    onFrame(type, payload);
  });
  const done = (async () => {
    for await (const chunk of child.stdout) {
      if (mode.raw) onFrame(FRAME.out, chunk);
      else read(chunk);
    }
    await child.exited;
  })();

  return {
    child,
    done,
    raw: () => mode.raw,
  };
};

const hello = (command: string | null, port?: number): Hello => ({
  key: offeredKey(),
  user: user ?? '',
  command,
  tty,
  ...(port === undefined ? {} : { forward: port }),
});

/** What a client asks a master on its socket, in its first frame, a `hello`. */
type Ask = { op: 'open' | 'check' | 'exit' } & ChannelOpen;
const AskDoc = z.object({
  op: z.enum(['open', 'check', 'exit']),
  command: z.string().nullable(),
  tty: z.boolean(),
});

const encode = (v: unknown) => JSON.stringify(v);

/** The master logs in once, then runs each client's command as a channel on that connection. */
const runMaster = async (): Promise<never> => {
  if (existsSync(socketPath))
    fail(`ControlSocket ${socketPath} already exists, disabling multiplexing`);
  type Client = { ch: number; read: (chunk: Uint8Array) => void };
  const clients = new Map<number, { write: (b: Uint8Array) => number; end: () => void }>();
  const state: { next: number; idle?: ReturnType<typeof setTimeout>; listening: boolean } = {
    next: 1,
    listening: false,
  };
  let stop: () => void = () => undefined;
  const quit = (code: number): never => {
    stop();
    rmSync(socketPath, { force: true });
    for (const c of clients.values()) c.end();
    process.exit(code);
  };
  const arm = () => {
    clearTimeout(state.idle);
    if (clients.size === 0 && persist !== null)
      state.idle = setTimeout(() => quit(0), persist * 1000);
  };
  const conn = connect({ ...hello(null), mux: true }, (type, payload) => {
    if (type === FRAME.err) process.stderr.write(payload);
    if (type === FRAME.ready && !state.listening) {
      state.listening = true;
      const server = Bun.listen<Client>({
        unix: socketPath,
        socket: {
          open: (s) => {
            s.data = {
              ch: 0,
              read: reader((t, body) => {
                if (t === FRAME.hello && s.data.ch === 0) {
                  const ask: Ask = AskDoc.parse(JSON.parse(new TextDecoder().decode(body)));

                  if (ask.op === 'check') {
                    s.write(frame(FRAME.err, `Master running (pid=${process.pid})\r\n`));
                    s.write(frame(FRAME.exit, new Uint8Array([0])));
                    s.end();
                  } else if (ask.op === 'exit') {
                    s.write(frame(FRAME.err, 'Exit request sent.\r\n'));
                    s.write(frame(FRAME.exit, new Uint8Array([0])));
                    s.end();
                    setTimeout(() => quit(0), 20);
                  } else {
                    const ch = state.next;

                    state.next += 1;
                    s.data.ch = ch;
                    clients.set(ch, s);
                    clearTimeout(state.idle);
                    void conn.child.stdin.write(
                      chan(ch, FRAME.hello, encode({ command: ask.command, tty: ask.tty })),
                    );
                    void conn.child.stdin.flush();
                  }
                } else if (t === FRAME.input && s.data.ch !== 0) {
                  void conn.child.stdin.write(chan(s.data.ch, FRAME.input, body));
                  void conn.child.stdin.flush();
                }
              }),
            };
          },
          data: (s, d) => {
            s.data.read(new Uint8Array(d));
          },
          close: (s) => {
            const ch = s.data.ch;

            if (ch !== 0 && clients.delete(ch)) {
              void conn.child.stdin.write(chan(ch, FRAME.close, ''));
              void conn.child.stdin.flush();
              arm();
            }
          },
        },
      });

      stop = () => {
        server.stop(true);
      };
      arm();
      // Logged in, so the parent (`-f`) may go.
      process.stdout.write('ready\n');
    }
    if (type === FRAME.chan) {
      const { ch, type: t, body } = unchan(payload);
      const c = clients.get(ch);

      c?.write(frame(t, body));
      if (t === FRAME.exit) {
        clients.delete(ch);
        c?.end();
        arm();
      }
    }
  });

  await conn.done;

  return quit(255);
};

/** Sends `ask` to the master at the socket, then stdin as input when it opens a channel. Null means no master answers there. */
const viaMaster = async (ask: Ask, input: boolean): Promise<number | null> => {
  const ended: { exit?: number; done?: () => void } = {};
  const closed = new Promise<void>((resolve) => {
    ended.done = resolve;
  });
  const read = reader((type, payload) => {
    if (type === FRAME.out) process.stdout.write(payload);
    if (type === FRAME.err) process.stderr.write(payload);
    if (type === FRAME.exit) ended.exit = payload[0] ?? 0;
  });
  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data: (_s, d) => {
        read(new Uint8Array(d));
      },
      close: () => {
        ended.done?.();
      },
      error: () => {
        ended.done?.();
      },
    },
  }).catch(() => undefined);

  if (sock === undefined) return null;
  sock.write(frame(FRAME.hello, encode(ask)));
  if (input)
    void (async () => {
      for await (const chunk of Bun.stdin.stream()) sock.write(frame(FRAME.input, chunk));
      sock.write(frame(FRAME.input, new Uint8Array(0)));
    })();
  await closed;

  return ended.exit ?? 255;
};

const refused = () =>
  `Control socket connect(${socketPath}): ${existsSync(socketPath) ? 'Connection refused' : 'No such file or directory'}`;

if (control !== '') {
  const op =
    control === 'check' || control === 'exit' ? control : fail(`fake ssh: no -O ${control}`);
  const exit = await viaMaster({ op, command: null, tty: false }, false);

  process.exit(exit ?? fail(refused()));
}
if (master && socketPath !== '') {
  if (daemon) await runMaster();
  if (!fork) await runMaster();
  // `-f` goes to the background once logged in, as ssh forks after its authentication.
  const child = Bun.spawn([process.execPath, import.meta.path, ...argv], {
    env: { ...process.env, FAKE_SSH_MASTER: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  let said = '';

  for await (const chunk of child.stdout) {
    said += new TextDecoder().decode(chunk);
    if (said.includes('ready\n')) {
      child.unref();
      process.exit(0);
    }
  }
  await child.exited;
  process.exit(255);
}
if (socketPath !== '') {
  const exit = await viaMaster(
    { op: 'open', command: words.length === 0 ? null : words.join(' '), tty },
    true,
  );

  if (exit !== null) process.exit(exit);
  // No master there, so it connects on its own as ssh does.
  // ssh reports ECONNREFUSED but not a missing socket.
  if (existsSync(socketPath)) process.stderr.write(`${refused()}\r\n`);
}

if (none && forward !== undefined) {
  const f = forward;
  // The connection itself checks the key and stays open. When it ends, ssh ends.
  const main = connect(hello('exec sleep 86400'), (type, payload) => {
    if (type === FRAME.err) process.stderr.write(payload);
  });
  const conns = new WeakMap<object, { c: ReturnType<typeof connect>; held: Uint8Array[] }>();

  Bun.listen({
    hostname: '127.0.0.1',
    port: f.local,
    socket: {
      open: (s) => {
        const held: Uint8Array[] = [];
        const c = connect(hello(null, f.remote), (type, payload) => {
          if (type === FRAME.ready) {
            // What the local side sent while the box connected, now in order.
            for (const d of held.splice(0)) void c.child.stdin.write(d);
            void c.child.stdin.flush();
          } else if (type === FRAME.out) s.write(payload);
        });

        conns.set(s, { c, held });
        void c.done.then(() => s.end());
      },
      data: (s, d) => {
        const one = conns.get(s);

        if (one === undefined) return;
        if (!one.c.raw()) one.held.push(new Uint8Array(d));
        else {
          void one.c.child.stdin.write(d);
          void one.c.child.stdin.flush();
        }
      },
      close: (s) => {
        conns.get(s)?.c.child.kill();
      },
    },
  });
  await main.done;
  process.exit(255);
}

let exit: number | undefined;
const c = connect(hello(words.length === 0 ? null : words.join(' ')), (type, payload) => {
  if (type === FRAME.out) process.stdout.write(payload);
  if (type === FRAME.err) process.stderr.write(payload);
  if (type === FRAME.exit) exit = payload[0] ?? 0;
});

void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    void c.child.stdin.write(frame(FRAME.input, chunk));
    void c.child.stdin.flush();
  }
  void c.child.stdin.write(frame(FRAME.input, new Uint8Array(0)));
  void c.child.stdin.flush();
})();
await c.done;
process.exit(exit ?? 255);
