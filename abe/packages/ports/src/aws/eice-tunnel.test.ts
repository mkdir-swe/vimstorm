/**
 * abe's EC2 Instance Connect tunnel (#91) in this process against the fake endpoint: how a
 * refused handshake reads (its status only: Bun's error text carries the signed URL and its
 * session token), when it is final, and that a tunnel whose far side went silent still ends
 * once ssh closed its side.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_KEYS, fakeEice } from '@abe/testing';
import { eiceBase, runTunnel, type TunnelOptions, tunnelArgs, tunnelMain } from './eice-tunnel';

const INSTANCE = 'i-0fa4e0000000000b1';
const IP = '10.9.0.17';
const eice = fakeEice({ instance: INSTANCE, ip: IP, env: { PATH: '/usr/bin:/bin' }, cwd: '/' });

afterAll(() => {
  eice.stop();
});

/** A stdin that ends at once (ssh closed its side), or never. */
const stdin = (ends: boolean) =>
  new ReadableStream<Uint8Array>({
    start: (c) => {
      if (ends) c.close();
    },
  });

const tunnel = (base: string, ends = true) => {
  const said: { log: string[]; fatal: string[] } = { log: [], fatal: [] };
  const o: TunnelOptions = {
    target: {
      instance: INSTANCE,
      endpoint: 'eice-0fake',
      dns: 'x',
      ip: IP,
      port: 22,
      region: 'eu-west-1',
    },
    keys: FAKE_KEYS,
    now: () => new Date(),
    base,
    stdin: stdin(ends),
    write: () => undefined,
    fatal: (m) => said.fatal.push(m),
    log: (m) => said.log.push(m),
  };

  return { o, said };
};

describe('a refused handshake', () => {
  test.each([
    [401, true],
    [403, true],
    [400, false],
    [503, false],
  ])('HTTP %d: final %p, said by its status only', async (status, final) => {
    eice.refuseTunnels(status);
    const { o, said } = tunnel(eice.url, false);

    expect(await runTunnel(o)).toBe(1);
    eice.refuseTunnels(null);
    expect(said.log[0]).toStartWith(`open-tunnel: handshake refused (HTTP ${status})`);
    expect(said.fatal.length).toBe(final ? 1 : 0);
    const all = [...said.log, ...said.fatal].join('\n');

    expect(all).not.toContain(FAKE_KEYS.sessionToken);
    expect(all).not.toContain('X-Amz');
    expect(all).not.toContain('openTunnel');
  });

  test('no answer at all is not final', async () => {
    const { o, said } = tunnel('http://127.0.0.1:9', false);

    expect(await runTunnel(o)).toBe(1);
    expect(said.log[0]).toStartWith('open-tunnel: handshake failed');
    expect(said.fatal).toEqual([]);
  });
});

/** A WebSocket server that upgrades and then never answers anything, not even a close. */
const silent = () =>
  Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (s, d) => {
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(d.toString())?.[1];

        if (key === undefined) return;
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');

        s.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      },
    },
  });

test('ssh closing its side ends the tunnel within 2 s even when the far side went silent', async () => {
  const server = silent();
  const { o } = tunnel(`http://127.0.0.1:${server.port}`);
  const started = Date.now();

  expect(await runTunnel(o)).toBe(0);
  expect(Date.now() - started).toBeLessThan(3_000);
  server.stop(true);
});

test('the tunnel takes only a port it can reach', () => {
  const words = ['--instance', 'i', '--endpoint', 'e', '--dns', 'd', '--ip', 'p', '--region', 'r'];

  expect(tunnelArgs([...words, '--port', '22'])).toMatchObject({ target: { port: 22 } });
  for (const bad of ['x', '0', '70000', '2.5'])
    expect(tunnelArgs([...words, '--port', bad])).toBe(`bad --port ${bad}`);
  expect(tunnelArgs([...words, '--max-seconds', 'soon'])).toBe('bad --max-seconds soon');
});

describe('$ABE_EICE_URL: a fake endpoint on this machine only', () => {
  test.each([
    'http://127.0.0.1:4566',
    'http://127.0.0.1:4566/',
    'https://127.0.0.1',
    'http://localhost:9000',
    'https://localhost',
  ])('%s is taken', (base) => {
    expect(eiceBase(base)).toBe(base);
  });

  test.each([
    'https://ec2-instance-connect.eu-west-1.amazonaws.com',
    'http://attacker.example',
    'http://127.0.0.1.attacker.example',
    'http://localhost@attacker.example',
    'http://localhost.attacker.example:80',
    'http://10.0.0.5:8080',
    'ws://127.0.0.1:4566',
    'ftp://localhost',
    'not a url',
  ])('%s is refused', (base) => {
    expect(eiceBase(base)).toBeUndefined();
  });

  test('another base: abe box tunnel exits 1 before any signing, the status says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eice-'));
    const status = join(dir, 'status');
    const key = join(dir, 'key.pub');

    writeFileSync(key, 'ssh-ed25519 AAAA test\n');
    try {
      const words = ['--instance', INSTANCE, '--endpoint', 'e', '--dns', 'd', '--ip', IP];
      const exit = await tunnelMain(
        [
          ...words,
          '--region',
          'eu-west-1',
          '--push',
          key,
          '--user',
          'ec2-user',
          '--status',
          status,
        ],
        {
          AWS_ACCESS_KEY_ID: FAKE_KEYS.accessKeyId,
          AWS_SECRET_ACCESS_KEY: FAKE_KEYS.secretAccessKey,
          AWS_SESSION_TOKEN: FAKE_KEYS.sessionToken,
          // a public name for this machine's 127.0.0.1: the fake would hear a push sent there
          ABE_EICE_URL: eice.url.replace('127.0.0.1', '127.0.0.1.nip.io'),
        },
      );

      expect(exit).toBe(1);
      expect(readFileSync(status, 'utf8')).toStartWith(
        'ABE_EICE_URL must be http(s)://127.0.0.1 or localhost',
      );
      expect(eice.pushes()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
