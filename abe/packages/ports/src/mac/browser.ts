/**
 * Headless Chromium through a shell where it runs: on a box, `docker exec` in the workspace
 * container (`execIn`). Shell scripts in, DevTools' JSON read with zod; no rules here. A
 * profile's sign-ins go in through its DevTools, reached on the container's own loopback through
 * `docker exec … socat` (`dockerDevtools`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { type Answered, type Browser, type BrowserProbe, type Docker, type Ran } from '@abe/core';
import { z } from 'zod';
import { restoreState } from './browser-devtools';
import { type Env } from './locations';

/** Runs `argv` where the browser lives and answers how it ended. */
export type Exec = (argv: readonly string[]) => Promise<Ran>;

/** `exec` inside a running container, as its user. */
export const execIn =
  (docker: Docker, container: string): Exec =>
  (argv) =>
    docker.exec(container, argv);

/** Exit codes of the start script. */
const EXITED = 4;
const NO_ANSWER = 5;

/**
 * Stops the browser `$dir`'s pid file names, only when that process is a Chromium on this very
 * profile (a stale pid file must not take another process group down): TERM to its process
 * group, KILL after 5 s, then waits until it is gone so the port is free again.
 */
const STOP_OLD = `stop_old() {
  pid=$(cat "$dir/chromium.pid" 2>/dev/null) || return 0
  if ps -o args= -p "$pid" 2>/dev/null | grep -qF -- "--user-data-dir=$dir/profile"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done
  fi
  rm -f "$dir/chromium.pid"
}`;

/**
 * `$1` the browser's dir, `$2` its port, the rest its argv. Whatever an earlier start left is
 * stopped, the profile made anew, Chromium started in its own session (so a stop takes its whole
 * process group) with its pid file written; then waits up to 15 s for DevTools.
 */
const START = `set -e
dir=$1; port=$2; shift 2
${STOP_OLD}
stop_old
mkdir -p "$dir"
rm -rf "$dir/profile"
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" </dev/null >"$dir/chromium.log" 2>&1 &
else
  "$@" </dev/null >"$dir/chromium.log" 2>&1 &
fi
pid=$!
echo "$pid" >"$dir/chromium.pid"
i=0
while [ "$i" -lt 150 ]; do
  if curl -sf -m 1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; then echo "$pid"; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then tail -n 5 "$dir/chromium.log" >&2; rm -f "$dir/chromium.pid"; exit ${EXITED}; fi
  sleep 0.1
  i=$((i + 1))
done
tail -n 5 "$dir/chromium.log" >&2
stop_old
exit ${NO_ANSWER}`;

/**
 * `$1` the dir, `$2` the port: DevTools' version and pages, then the clients connected to the
 * port (established sockets whose local port it is), then the pid file, each after a marker line.
 */
const PROBE = `dir=$1; port=$2
v=$(curl -sf -m 2 "http://127.0.0.1:$port/json/version") || exit 3
l=$(curl -sf -m 2 "http://127.0.0.1:$port/json/list") || exit 3
hex=$(printf ':%04X' "$port")
c=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p="$hex" '$4 == "01" && substr($2, length($2) - 4) == p' | wc -l)
printf '%s\\n' '--version--' "$v" '--list--' "$l" '--clients--' "$c" '--pid--'
cat "$dir/chromium.pid" 2>/dev/null || true`;

/** `$1` the dir. */
const STOP = `dir=$1
${STOP_OLD}
stop_old`;

const Version = z.object({ Browser: z.string(), webSocketDebuggerUrl: z.string() });

const Targets = z.array(
  z.object({ id: z.string(), type: z.string(), url: z.string(), title: z.string() }),
);

const sections = (stdout: string): Map<string, string> => {
  const out = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];

  for (const line of stdout.split('\n')) {
    const marker = /^--([a-z]+)--$/.exec(line);

    if (marker !== null) {
      if (name !== undefined) out.set(name, lines.join('\n'));
      name = marker[1];
      lines = [];
    } else lines.push(line);
  }
  if (name !== undefined) out.set(name, lines.join('\n'));

  return out;
};

const json = (text: string | undefined): unknown => {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
};

const tail = (text: string) => text.trim().split('\n').slice(-5).join('\n');

/**
 * DevTools on `port` of where the browser runs, as an HTTP endpoint here, until `close`: the
 * WebSocket `/json/version` names is reached on that endpoint's own host and port.
 */
export type DevtoolsReach = (port: number) => Promise<{ http: string; close: () => void }>;

/** The browser runs here (tests, a local Chromium): its own loopback port. */
export const directDevtools: DevtoolsReach = (port) =>
  Promise.resolve({ http: `http://127.0.0.1:${String(port)}`, close: () => undefined });

/**
 * The browser runs in `container`, whose DevTools listens on the container's own loopback: a
 * listener on this host's loopback (a port the system picks) where each connection is
 * `docker exec -i <container> socat STDIO TCP:127.0.0.1:<port>`, bytes piped both ways. `close`
 * stops the listener and every `docker exec` it started.
 */
export const dockerDevtools =
  (o: { bin?: string; env: Env; container: string }): DevtoolsReach =>
  (port) => {
    const env = Object.fromEntries(
      Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const children = new Set<ChildProcess>();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      const child = spawn(
        o.bin ?? 'docker',
        ['exec', '--interactive', o.container, 'socat', 'STDIO', `TCP:127.0.0.1:${String(port)}`],
        { env, stdio: ['pipe', 'pipe', 'ignore'] },
      );

      children.add(child);
      sockets.add(socket);
      const end = () => {
        children.delete(child);
        sockets.delete(socket);
        socket.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      };

      child.once('error', end);
      child.once('exit', end);
      socket.once('close', end);
      socket.on('error', end);
      child.stdin.on('error', end);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        // Up: a later error of the listener ends only its connections, never serve.
        server.on('error', () => undefined);
        const address = server.address();
        const local = typeof address === 'object' && address !== null ? address.port : 0;

        resolve({
          http: `http://127.0.0.1:${String(local)}`,
          close: () => {
            server.close();
            for (const s of sockets) s.destroy();
            for (const c of children) c.kill('SIGKILL');
          },
        });
      });
    });
  };

export const chromiumBrowser = (exec: Exec, devtools: DevtoolsReach): Browser => {
  const sh = (script: string, ...args: string[]) => exec(['sh', '-c', script, 'sh', ...args]);

  return {
    start: async ({ dir, port, argv }): Promise<Answered<{ pid: number }>> => {
      const ran = await sh(START, dir, String(port), ...argv);
      const pid = Number(ran.stdout.trim().split('\n').at(-1));

      if (ran.exit === 0 && Number.isInteger(pid) && pid > 0) return { ok: true, data: { pid } };
      const why =
        ran.exit === NO_ANSWER
          ? `Chromium's DevTools did not answer on port ${port}`
          : 'Chromium exited at its start';

      return {
        ok: false,
        error: {
          code: 'browser-failed',
          message: [why, tail(ran.stderr)].filter((t) => t !== '').join(': '),
        },
      };
    },
    probe: async ({ dir, port }): Promise<BrowserProbe | undefined> => {
      const ran = await sh(PROBE, dir, String(port));

      if (ran.exit !== 0) return undefined;
      const part = sections(ran.stdout);
      const version = Version.safeParse(json(part.get('version')));
      const targets = Targets.safeParse(json(part.get('list')));

      if (!version.success || !targets.success) return undefined;
      const clients = Number(part.get('clients')?.trim());
      const pid = Number(part.get('pid')?.trim());

      return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        version: version.data.Browser,
        webSocket: version.data.webSocketDebuggerUrl,
        pages: targets.data
          .filter((t) => t.type === 'page')
          .map((t) => ({ id: t.id, url: t.url, title: t.title })),
        clients: Number.isInteger(clients) ? clients : 0,
      };
    },
    stop: async ({ dir }) => {
      const ran = await sh(STOP, dir);

      if (ran.exit !== 0)
        throw new Error(tail(ran.stderr) || `the browser's stop exited ${ran.exit}`);
    },
    restore: async ({ port, state }) => {
      let reach: Awaited<ReturnType<DevtoolsReach>>;

      try {
        reach = await devtools(port);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'devtools-failed',
            message: `DevTools on port ${String(port)} is out of reach: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
      try {
        return await restoreState(reach.http, state);
      } finally {
        reach.close();
      }
    },
  };
};
