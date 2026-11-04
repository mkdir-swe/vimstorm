/**
 * `abe port pipe <port>` (#16), in a box workspace: what the box's relay runs per connection
 * (`docker exec -i`). It reaches `127.0.0.1:<port>` there (`::1` when that refuses), its stdin to
 * the socket and the socket to its stdout. Its stdin ending half-closes the socket; the server
 * closing it ends the pipe: exit 0. Nothing listening: exit 1, said on stderr.
 */
import { connect, type Socket } from 'node:net';

export type PipeIo = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: (line: string) => void;
};

const reach = (host: string, port: number): Promise<Socket | Error> =>
  new Promise((resolve) => {
    const sock = connect({ host, port });
    const failed = (err: Error) => {
      resolve(err);
    };

    sock.once('error', failed);
    sock.once('connect', () => {
      sock.off('error', failed);
      resolve(sock);
    });
  });

const portOf = (word: string | undefined): number | undefined => {
  const port = Number(word);

  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
};

/** `abe port pipe <port>` on these streams: its exit. */
export const pipeMain = async (
  argv: readonly string[],
  io: PipeIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (line) => process.stderr.write(line),
  },
): Promise<number> => {
  const port = portOf(argv.find((a) => !a.startsWith('-')));

  if (port === undefined) {
    io.stderr('abe port pipe: usage: abe port pipe <port>\n');

    return 2;
  }
  const v4 = await reach('127.0.0.1', port);
  const sock = v4 instanceof Error ? await reach('::1', port) : v4;

  if (sock instanceof Error) {
    io.stderr(`abe port pipe: nothing listens on port ${String(port)} here (${sock.message})\n`);

    return 1;
  }

  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      io.stdin.unpipe(sock);
      io.stdin.pause();
      // What came from the server is written out before the exit.
      io.stdout.write('', () => {
        resolve(code);
      });
    };

    sock.on('data', (chunk: Buffer) => {
      if (!io.stdout.write(chunk)) {
        sock.pause();
        io.stdout.once('drain', () => sock.resume());
      }
    });
    sock.on('close', () => {
      finish(0);
    });
    sock.on('error', () => {
      finish(0);
    });
    io.stdin.on('error', () => sock.end());
    io.stdin.pipe(sock);
  });
};
