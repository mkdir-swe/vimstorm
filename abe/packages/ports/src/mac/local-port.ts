/**
 * A port on this Mac's 127.0.0.1 for a forward (#16): the first of the candidates nothing holds.
 * Held means something answers there (on 127.0.0.1 or ::1, where a browser's `localhost` may go)
 * or it cannot be bound; a port bound only to the wildcard still answers on loopback, so it is
 * found taken too.
 */
import { createServer } from 'node:net';

const answers = async (hostname: string, port: number): Promise<boolean> => {
  try {
    const s = await Bun.connect({ hostname, port, socket: { data: () => undefined } });

    s.end();

    return true;
  } catch {
    return false;
  }
};

const binds = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();

    s.once('error', () => {
      resolve(false);
    });
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      s.close(() => {
        resolve(true);
      });
    });
  });

/** Whether nothing holds `port` on this Mac's loopback. */
export const localPortFree = async (port: number): Promise<boolean> =>
  !(await answers('127.0.0.1', port)) && !(await answers('::1', port)) && (await binds(port));

/** The first free candidate, in order; none free: `undefined`. */
export const freeLocalPort = async (candidates: readonly number[]): Promise<number | undefined> => {
  for (const port of candidates) if (await localPortFree(port)) return port;

  return undefined;
};
