/**
 * A box's relays into its workspaces (#16): a listener on the box's own 127.0.0.1 whose every
 * connection runs `docker exec -i <container> abe port pipe <port>` and pipes bytes both ways, so
 * a server bound to the workspace's own loopback is reached too. The connection ending stops the
 * pipe; the pipe ending closes the connection.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { type RelayHeld, type WorkspaceRelays } from '@abe/core';

export type WorkspaceRelaysOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** Docker's binary (default `docker` on `PATH`). */
  bin?: string;
  /** What runs per connection (default `<bin> exec -i <container> abe port pipe <port>`). */
  command?: (container: string, port: number) => readonly string[];
};

export const pipeCommand = (bin: string, container: string, port: number): string[] => [
  bin,
  'exec',
  '-i',
  container,
  'abe',
  'port',
  'pipe',
  String(port),
];

/** One connection piped through its own child: either side ending ends the other. */
const relayOne = (sock: Socket, argv: readonly string[], env: Record<string, string>) => {
  const [cmd, ...args] = argv;

  if (cmd === undefined) {
    sock.destroy();

    return undefined;
  }
  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const end = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    sock.destroy();
  };

  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  sock.on('error', end);
  sock.on('close', end);
  child.on('error', end);
  child.on('exit', () => {
    // What the pipe printed goes out first, then the connection closes.
    if (child.stdout.readableEnded) sock.end();
    else child.stdout.once('end', () => sock.end());
  });
  sock.pipe(child.stdin);
  child.stdout.pipe(sock, { end: false });

  return child;
};

export const workspaceRelays = (o: WorkspaceRelaysOptions): WorkspaceRelays => {
  const bin = o.bin ?? 'docker';
  const env = Object.fromEntries(
    Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const command = o.command ?? ((container, port) => pipeCommand(bin, container, port));

  return {
    open: (container, port) =>
      new Promise<RelayHeld>((resolve, reject) => {
        const live = new Set<{ sock: Socket; child: ChildProcess | undefined }>();
        const server = createServer((sock) => {
          const held = { sock, child: relayOne(sock, command(container, port), env) };

          live.add(held);
          sock.on('close', () => live.delete(held));
        });

        server.once('error', reject);
        server.listen({ port: 0, host: '127.0.0.1' }, () => {
          const at = server.address();

          if (at === null || typeof at === 'string') {
            server.close();
            reject(new Error('the relay has no port'));

            return;
          }
          resolve({
            port: at.port,
            close: () =>
              new Promise<void>((done) => {
                for (const l of live) {
                  l.child?.kill();
                  l.sock.destroy();
                }
                live.clear();
                server.close(() => {
                  done();
                });
              }),
          });
        });
      }),
  };
};
