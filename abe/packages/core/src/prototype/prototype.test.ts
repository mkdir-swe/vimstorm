import { describe, expect, test } from 'bun:test';
import {
  appEnv,
  appOrigin,
  defaultRefs,
  type ProxyRoute,
  redirectOf,
  routeRequest,
  startAnswer,
} from './prototype';

const said = (r: ProxyRoute) => {
  if (r.kind === 'forward') return `forward ${r.url}`;

  return `refuse ${r.reason}`;
};

describe('the proxy routes', () => {
  const p = {
    own: ['127.0.0.1:4000', 'localhost:4000'],
    app: 'http://127.0.0.1:5173',
  };

  test.each<[string, string, string, string, string]>([
    [
      'its own host forwards to the app',
      'GET',
      '127.0.0.1:4000',
      '/cart?x=1',
      'forward http://127.0.0.1:5173/cart?x=1',
    ],
    ['localhost too', 'GET', 'LOCALHOST:4000', '/', 'forward http://127.0.0.1:5173/'],
    ['the app as an HTTP proxy', 'GET', '127.0.0.1:5173', '/', 'forward http://127.0.0.1:5173/'],
    [
      'another host is refused',
      'GET',
      'api.example.com',
      '/api/products',
      'refuse api.example.com is not the app',
    ],
    [
      'another port of loopback too',
      'GET',
      '127.0.0.1:5432',
      '/',
      'refuse 127.0.0.1:5432 is not the app',
    ],
    [
      'a tunnel is refused',
      'CONNECT',
      '127.0.0.1:5173',
      '',
      'refuse a tunnel to 127.0.0.1:5173 (only the app is served)',
    ],
  ])('%s', (_, method, host, path, want) => {
    expect(said(routeRequest({ method, host, path }, p))).toBe(want);
  });

  test.each<[string, string, string]>([
    ['/cart', 'keep', '/cart'],
    ['http://127.0.0.1:5173/cart?x=1', 'rewrite', 'http://127.0.0.1:4000/cart?x=1'],
    ['//127.0.0.1:5173/', 'rewrite', 'http://127.0.0.1:4000/'],
    [
      'http://127.0.0.1:51730/x',
      'refuse',
      'the app redirects to http://127.0.0.1:51730/x, which is not the app',
    ],
    [
      'https://shop.example.com/',
      'refuse',
      'the app redirects to https://shop.example.com/, which is not the app',
    ],
  ])('a redirect to %s: %s', (location, kind, want) => {
    const r = redirectOf(location, { app: 'http://127.0.0.1:5173', own: 'http://127.0.0.1:4000' });
    const said = {
      keep: location,
      rewrite: r.kind === 'rewrite' ? r.location : '',
      refuse: r.kind === 'refuse' ? r.reason : '',
    };

    expect([r.kind, said[r.kind]]).toEqual([kind, want]);
  });
});

describe('the start script', () => {
  test.each<[string, string, string | undefined]>([
    ['a URL', 'http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['a path is dropped', 'http://localhost:3000/shop', 'http://localhost:3000'],
    ['a bare port', '5173', 'http://127.0.0.1:5173'],
    ['the real site never', 'https://shop.example.com', undefined],
    ['words', 'started!', undefined],
    ['ftp', 'ftp://127.0.0.1/', undefined],
  ])('%s', (_, line, want) => {
    const o = appOrigin(line);

    expect(o.ok ? o.origin : undefined).toBe(want);
  });

  test('its last stdout line is the app', () => {
    expect(
      startAnswer({ exit: 0, stdout: 'ready\nhttp://127.0.0.1:5173\n\n', stderr: 'log' }),
    ).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:5173',
    });
  });

  test('a failure shows its last lines', () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const failed = startAnswer({ exit: 1, stdout: '', stderr });

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.message.split('\n')[0]).toBe(
      'abe/scripts/prototype-start exited 1; its last lines:',
    );
    expect(failed.message.split('\n').slice(1)).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${i + 11}`),
    );
  });

  test('exit 0 with no address is a failure too', () => {
    const failed = startAnswer({ exit: 0, stdout: 'done\n', stderr: '' });

    expect(failed).toEqual({
      ok: false,
      message:
        'abe/scripts/prototype-start printed no app address: its last line is no http(s) URL or port: done; its last lines:\ndone',
    });
  });

  test.each<[string | null, string[]]>([
    [null, ['main', 'master']],
    ['origin/trunk', ['origin/trunk', 'main', 'master']],
  ])('the default branch from origin/HEAD %p', (head, want) => {
    expect(defaultRefs(head)).toEqual(want);
  });

  test("a start script gets only APP_ENV of serve's environment, and its own: never serve's DATABASE_URL (#349)", () => {
    expect(
      appEnv(
        {
          HOME: '/h',
          PATH: '/bin',
          GH_TOKEN: 'x',
          AWS_SECRET_ACCESS_KEY: 'y',
          DATABASE_URL: 'pg://',
        },
        { ABE_PROTOTYPE: 'proto-abc123' },
      ),
    ).toEqual({ HOME: '/h', PATH: '/bin', ABE_PROTOTYPE: 'proto-abc123' });
  });

  test('a start script that took too long says so', () => {
    const r = startAnswer({ exit: 137, stdout: '', stderr: 'waiting', timedOut: true });

    expect(r.ok ? '' : r.message).toBe(
      'abe/scripts/prototype-start must print its URL and exit; it ran 300s; its last lines:\nwaiting',
    );
  });
});
