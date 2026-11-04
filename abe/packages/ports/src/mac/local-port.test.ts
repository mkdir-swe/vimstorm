import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { freeLocalPort } from './local-port';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) =>
          s.close(() => {
            resolve();
          }),
        ),
    ),
  );
});

/** Something of this Mac listening on `host`, on a port the OS gives. */
const hold = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();

    s.once('error', reject);
    s.listen(0, host, () => {
      const a = s.address();

      servers.push(s);
      resolve(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });

/** A port nothing holds now (taken by the OS, then let go). */
const loose = async (): Promise<number> => {
  const port = await hold('127.0.0.1');
  const s = servers.pop();

  await new Promise<void>((resolve) =>
    s?.close(() => {
      resolve();
    }),
  );

  return port;
};

describe('a forward takes the first wanted port nothing holds here', () => {
  const rows: {
    rule: string;
    held: '127.0.0.1' | '0.0.0.0' | '::1' | null;
    want: 'first' | 'second';
  }[] = [
    { rule: 'free: the first', held: null, want: 'first' },
    { rule: 'held on 127.0.0.1: the next', held: '127.0.0.1', want: 'second' },
    { rule: 'held on every address: the next', held: '0.0.0.0', want: 'second' },
    { rule: "held on ::1 (a browser's localhost): the next", held: '::1', want: 'second' },
  ];

  for (const r of rows)
    test(r.rule, async () => {
      const first = r.held === null ? await loose() : await hold(r.held);
      const second = await loose();

      expect(await freeLocalPort([first, second])).toBe(r.want === 'first' ? first : second);
    });

  test('none free: none', async () => {
    expect(await freeLocalPort([await hold('127.0.0.1')])).toBeUndefined();
  });
});
