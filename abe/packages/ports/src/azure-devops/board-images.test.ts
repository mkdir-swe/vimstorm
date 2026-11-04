/**
 * A card's images through the Board port (#238), on the fake Azure DevOps: only the board org's
 * attachments are read, with the token, into the images folder, each once.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdo, type FakeAdo } from '@abe/testing';
import { adoBoard } from './board';

const IMAGE =
  'https://dev.azure.com/demo-org/Sandbox/_apis/wit/attachments/5e0c7a3b-6d1f-4b8e-9a2c-0f4d3b2a1c90?fileName=narrow.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let ado: FakeAdo;
let dir: string;
const board = () => ({ ...ado.board, types: ['User Story', 'Bug'] });
const tokenCalls: (string | undefined)[] = [];
const tokens = (given: string[]) => {
  let i = 0;

  return {
    get: (stale?: string) => {
      tokenCalls.push(stale);
      const token = given[Math.min(i, given.length - 1)] ?? 'none';

      i += 1;

      return Promise.resolve({ ok: true as const, token });
    },
  };
};
const attachmentReads = () => ado.requests().filter((r) => r.includes('/_apis/wit/attachments/'));

beforeAll(async () => {
  ado = await fakeAdo({ expired: ['stale'] });
  dir = mkdtempSync(join(tmpdir(), 'abe-images-'));
});
afterAll(async () => {
  await ado.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the org’s attachment: read with the token into the folder, private, and kept', async () => {
  const images = join(dir, 'kept');
  const port = adoBoard({ tokens: tokens(['stale', 'fresh']), base: ado.url, images });
  const first = await port.image(board(), IMAGE);

  if (!first.ok) throw new Error(first.error.message);
  expect(first.data.startsWith(`${images}/`)).toBe(true);
  expect(first.data.endsWith('.png')).toBe(true);
  expect(readFileSync(first.data).subarray(0, 4)).toEqual(PNG);
  expect(statSync(first.data).mode & 0o777).toBe(0o600);
  // a 401 renewed the token once
  expect(tokenCalls.slice(-2)).toEqual([undefined, 'stale']);
  const reads = attachmentReads().length;

  // read again: the kept file, not Azure DevOps
  expect(await port.image(board(), IMAGE)).toEqual({ ok: true, data: first.data });
  expect(attachmentReads()).toHaveLength(reads);
  expect(readdirSync(images)).toHaveLength(1);
});

test('another org’s image, another host, or the org’s other API: refused, never read', async () => {
  const before = ado.requests().length;
  const port = adoBoard({ tokens: tokens(['fresh']), base: ado.url, images: join(dir, 'other') });

  for (const src of [
    IMAGE.replace('demo-org', 'other-org'),
    'https://img.example/narrow.png',
    'https://dev.azure.com/demo-org/_apis/connectionData',
  ])
    expect(await port.image(board(), src)).toMatchObject({
      ok: false,
      error: { code: 'rejected' },
    });
  expect(ado.requests()).toHaveLength(before);
});

test('an attachment that is no image Abe draws is refused, nothing kept', async () => {
  const images = join(dir, 'text');
  const port = adoBoard({ tokens: tokens(['fresh']), base: ado.url, images });
  const read = await port.image(
    board(),
    'https://dev.azure.com/demo-org/Sandbox/_apis/wit/attachments/0b1d2e3f-4a5b-4c6d-8e7f-001122334455?fileName=notes.txt',
  );

  expect(read).toMatchObject({ ok: false, error: { code: 'rejected' } });
  expect(existsSync(images) ? readdirSync(images) : []).toEqual([]);
});

test('a redirect is not followed: the token never goes where it points', async () => {
  let elsewhere = 0;
  const other = Bun.serve({
    // 127.0.0.1, as fetched: a port 0 on the default [::] may answer nothing there (a hang)
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      elsewhere += 1;

      return new Response('');
    },
  });
  const org = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 302,
        headers: { Location: `http://127.0.0.1:${other.port}/blob.png` },
      }),
  });

  try {
    const port = adoBoard({
      tokens: tokens(['fresh']),
      base: `http://127.0.0.1:${org.port}`,
      images: join(dir, 'moved'),
    });

    expect(await port.image(board(), IMAGE)).toMatchObject({ ok: false });
    expect(elsewhere).toBe(0);
  } finally {
    await org.stop(true);
    await other.stop(true);
  }
});

test('an attachment that is not there says so', async () => {
  const port = adoBoard({ tokens: tokens(['fresh']), base: ado.url, images: join(dir, 'gone') });
  const read = await port.image(board(), IMAGE.replace('5e0c7a3b', '00000000'));

  expect(read).toMatchObject({ ok: false, error: { code: 'not-found' } });
});

test('an answer cut off midway says the org cannot be reached, nothing kept', async () => {
  // a raw socket: the headers promise more than it sends, then it closes
  const org = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket) => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000\r\n\r\n',
        );
        socket.write(new Uint8Array(PNG));
        socket.end();
      },
    },
  });
  const images = join(dir, 'cut');

  try {
    const port = adoBoard({
      tokens: tokens(['fresh']),
      base: `http://127.0.0.1:${org.port}`,
      images,
    });

    expect(await port.image(board(), IMAGE)).toMatchObject({
      ok: false,
      error: { code: 'offline' },
    });
    expect(existsSync(images) ? readdirSync(images) : []).toEqual([]);
  } finally {
    org.stop(true);
  }
});
