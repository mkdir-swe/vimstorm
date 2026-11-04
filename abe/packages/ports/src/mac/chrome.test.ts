/**
 * The Mac's Chrome adapter against the fake Chromium as a real process, started apart as `open`
 * would: its argv, a start waited for through `DevToolsActivePort`, a second open handed to the
 * one running, and the sign-ins read through DevTools from cookies shaped as a real Chrome's
 * `Storage.getCookies` answers them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StateCookie } from '@abe/core';
import { fakeChromiumArgv } from '@abe/testing';
import { z } from 'zod';
import { chromeArgv, macChrome } from './chrome';

/** As a real Chrome's `Storage.getCookies` answered (values made up). */
const COOKIES: StateCookie[] = [
  {
    name: '__Host-sid',
    value: 'cookie-value-sid',
    domain: 'app.example.test',
    path: '/',
    expires: 1_793_000_000.123_456,
    size: 26,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: 'Lax',
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
  },
  {
    name: 'csrf',
    value: 'cookie-value-csrf',
    domain: '.example.test',
    path: '/',
    expires: -1,
    size: 21,
    httpOnly: false,
    secure: false,
    session: true,
    priority: 'Medium',
    sourceScheme: 'NonSecure',
    sourcePort: 80,
  },
  {
    name: 'embed',
    value: 'cookie-value-embed',
    domain: 'widget.example.test',
    path: '/',
    expires: 1_793_000_000,
    size: 23,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: 'None',
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
    partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: true },
  },
];

const dirs: string[] = [];
const endpoints: string[] = [];

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-chrome-'));

  dirs.push(dir);

  return dir;
};

afterEach(async () => {
  for (const e of endpoints.splice(0)) await fetch(`${e}/fake/quit`).catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const Hits = z.object({ siteHits: z.number() });
const Seen = z.object({ activated: z.array(z.string()), tabsMade: z.number() });

describe('chromeArgv', () => {
  test('open hands Chrome to launchd, behind the window in front unless asked', () => {
    const tail = [
      '--user-data-dir=/p/work',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      'https://app.example.test/',
    ];

    expect(chromeArgv('/p/work', ['https://app.example.test/'])).toEqual([
      'open',
      '-n',
      '-g',
      '-a',
      '/Applications/Google Chrome.app',
      '--args',
      ...tail,
    ]);
    expect(chromeArgv('/p/work', ['https://app.example.test/'], { front: true })).toEqual([
      'open',
      '-n',
      '-a',
      '/Applications/Google Chrome.app',
      '--args',
      ...tail,
    ]);
    expect(chromeArgv('/p/work', [], { command: ['chrome'] })).toEqual([
      'chrome',
      ...tail.slice(0, 4),
    ]);
  });
});

describe('macChrome', () => {
  test('starts on a folder, waits for it, hands a second open to it and reads its sign-ins', async () => {
    const dir = temp();
    const preload = join(temp(), 'state.json');

    writeFileSync(
      preload,
      JSON.stringify({
        cookies: COOKIES,
        localStorage: {
          'https://app.example.test': { token: 'storage-value-token' },
          'http://localhost:4300': { dev: 'storage-value-dev' },
        },
      }),
    );
    const chrome = macChrome({ command: [...fakeChromiumArgv(), `--fake-state=${preload}`] });

    expect(await chrome.running(dir)).toBeUndefined();
    const first = await chrome.open({ dir, urls: [] });

    if (!first.ok) throw new Error(first.error.message);
    endpoints.push(first.data.endpoint);
    expect(first.data.started).toBe(true);
    const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];

    expect(first.data.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(await chrome.running(dir)).toBe(first.data.endpoint);

    const second = await chrome.open({ dir, urls: ['http://localhost:4300/board'] });

    expect(second).toEqual({ ok: true, data: { endpoint: first.data.endpoint, started: false } });
    // The running one opens the tab (the hand-off is apart from this process: wait for it).
    for (let i = 0; i < 50; i++) {
      const hits = Hits.parse(await (await fetch(`${first.data.endpoint}/fake/state`)).json());

      if (hits.siteHits === 1) break;
      await Bun.sleep(50);
    }

    const read = await chrome.read(first.data.endpoint);

    if (!read.ok) throw new Error(read.error.message);
    // Every cookie as Chrome answered it: HttpOnly, session, Secure and partitioned ones.
    expect(read.data.cookies).toEqual(COOKIES);
    expect(read.data.origins).toEqual([
      { origin: 'http://example.test', localStorage: [] },
      {
        origin: 'http://localhost:4300',
        localStorage: [{ name: 'dev', value: 'storage-value-dev' }],
      },
      {
        origin: 'https://app.example.test',
        localStorage: [{ name: 'token', value: 'storage-value-token' }],
      },
      { origin: 'https://example.test', localStorage: [] },
      { origin: 'https://widget.example.test', localStorage: [] },
    ]);
    // Reading reached no site: only the tab the second open asked for did.
    const after = Hits.parse(await (await fetch(`${first.data.endpoint}/fake/state`)).json());

    expect(after.siteHits).toBe(1);
    // The cookies alone open no tab; front activates the open tab, never a second Chrome.
    const made = Seen.parse(await (await fetch(`${first.data.endpoint}/fake/state`)).json());
    const cookies = await chrome.read(first.data.endpoint, { cookiesOnly: true });

    expect(cookies).toEqual({ ok: true, data: { cookies: COOKIES, origins: [] } });
    expect(await chrome.front({ dir, endpoint: first.data.endpoint })).toEqual({
      ok: true,
      data: null,
    });
    const seen = Seen.parse(await (await fetch(`${first.data.endpoint}/fake/state`)).json());

    expect(seen.tabsMade).toBe(made.tabsMade);
    expect(seen.activated).toHaveLength(1);
  });

  test('a Chrome that never answers is chrome-failed; a stale DevToolsActivePort is removed', async () => {
    const dir = temp();

    writeFileSync(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/old\n');
    const chrome = macChrome({ command: ['/usr/bin/true'], startMs: 300, pollMs: 50 });
    const opened = await chrome.open({ dir, urls: [] });

    expect(opened).toEqual({
      ok: false,
      error: { code: 'chrome-failed', message: `Chrome did not start for ${dir}` },
    });
    expect(existsSync(join(dir, 'DevToolsActivePort'))).toBe(false);
  });

  test('a command that is not there is chrome-failed', async () => {
    const chrome = macChrome({ command: ['/no/such/chrome'], startMs: 300, pollMs: 50 });
    const opened = await chrome.open({ dir: join(temp(), 'work'), urls: [] });

    if (opened.ok) throw new Error('expected a refusal');
    expect(opened.error.code).toBe('chrome-failed');
    expect(opened.error.message).toContain('did not start');
  });

  test('reading a Chrome that is gone is devtools-failed', async () => {
    const read = await macChrome().read('http://127.0.0.1:1');

    if (read.ok) throw new Error('expected a refusal');
    expect(read.error.code).toBe('devtools-failed');
  });
});
