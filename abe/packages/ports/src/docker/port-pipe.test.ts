/**
 * `abe port pipe <port>` for real (#16): this checkout's `abe` spawned as the box's relay runs it
 * in a workspace, its stdio piped to a TCP server on this machine's loopback.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '..', '..', '..', 'serve', 'src', 'main.ts');

/** A TCP server on `hostname` that echoes what it gets, upper-cased, and closes when the other side does. */
const echoServer = (hostname: string) =>
  Bun.listen({
    hostname,
    port: 0,
    socket: {
      data: (s, d) => {
        s.write(d.toString().toUpperCase());
      },
      end: (s) => {
        s.end();
      },
    },
  });

/** `abe port pipe <port>` with `input` on its stdin: its exit and what it printed. */
const pipe = async (port: number, input: string) => {
  const child = Bun.spawn([process.execPath, MAIN, 'port', 'pipe', String(port)], {
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exit, stdout, stderr };
};

describe('abe port pipe reaches the server listening in the workspace', () => {
  test.each([['127.0.0.1'], ['::1']])('bound to %s only', async (hostname) => {
    const server = echoServer(hostname);

    try {
      expect(await pipe(server.port, 'get / http/1.1\n')).toEqual({
        exit: 0,
        stdout: 'GET / HTTP/1.1\n',
        stderr: '',
      });
    } finally {
      server.stop(true);
    }
  });

  test('a server closing the connection ends the pipe, what it said printed', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: (s) => {
          s.end('bye\n');
        },
        data: () => undefined,
      },
    });

    try {
      const child = Bun.spawn([process.execPath, MAIN, 'port', 'pipe', String(server.port)], {
        stdin: 'pipe',
        stdout: 'pipe',
      });

      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe('bye\n');
    } finally {
      server.stop(true);
    }
  });
});

test('nothing listening: exit 1, said on stderr', async () => {
  const server = echoServer('127.0.0.1');
  const port = server.port;

  server.stop(true);
  const ran = await pipe(port, 'x');

  expect(ran.exit).toBe(1);
  expect(ran.stdout).toBe('');
  expect(ran.stderr).toStartWith(`abe port pipe: nothing listens on port ${port} here`);
});
