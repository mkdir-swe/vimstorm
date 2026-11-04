/**
 * The Chromium adapter's scripts against a fake Chromium as a real process (here on the Mac's own
 * shell; on a box the same scripts run through `docker exec`): start, probe, stop, a start that
 * exits, and a second browser on its own dir and port; a profile's sign-ins restored through its
 * DevTools, directly and through the `docker exec … socat` reach (a fake `docker` piping to it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumArgv, type Ran, type StorageState } from '@abe/core';
import { fakeChromiumArgv } from '@abe/testing';
import { z } from 'zod';
import { chromiumBrowser, directDevtools, dockerDevtools, type Exec } from './browser';

const local: Exec = async (argv) => {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exit, stdout, stderr } satisfies Ran;
};

const freePort = () => {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
  const { port } = l;

  l.stop(true);

  return port;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const dirs: string[] = [];
const browser = chromiumBrowser(local, directDevtools);

const launch = (extra: string[] = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-browser-'));
  const port = freePort();

  dirs.push(dir);

  return {
    dir,
    port,
    argv: [...fakeChromiumArgv(), ...chromiumArgv('chromium', dir, port).slice(1), ...extra],
  };
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await browser.stop({ dir });
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the Chromium adapter', () => {
  test('starts it, reads DevTools, stops it', async () => {
    const l = launch();
    const started = await browser.start(l);

    if (!started.ok) throw new Error(started.error.message);
    const { pid } = started.data;

    expect(readFileSync(join(l.dir, 'chromium.pid'), 'utf8').trim()).toBe(String(pid));
    expect(existsSync(join(l.dir, 'profile'))).toBe(true);
    expect(await browser.probe(l)).toEqual({
      pid,
      version: 'Chrome/156.0.0.0',
      webSocket: `ws://127.0.0.1:${l.port}/devtools/browser/fake-${pid}`,
      // Pages only: a service worker is no page.
      pages: [{ id: 'P1', url: 'about:blank', title: 'about:blank' }],
      // No /proc/net/tcp on a Mac; inside the container it counts the established clients.
      clients: 0,
    });
    await browser.stop(l);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(l.dir, 'chromium.pid'))).toBe(false);
    expect(await browser.probe(l)).toBeUndefined();
  });

  test('a Chromium that exits at its start is browser-failed, with its last words', async () => {
    const l = launch(['--exit-at-once']);
    const started = await browser.start(l);

    if (started.ok) throw new Error('expected a refusal');
    expect(started.error.code).toBe('browser-failed');
    expect(started.error.message).toContain('Chromium exited at its start');
    expect(started.error.message).toContain('No usable sandbox!');
  });

  test('two browsers, each on its own profile and port', async () => {
    const a = launch();
    const b = launch();

    expect((await browser.start(a)).ok).toBe(true);
    expect((await browser.start(b)).ok).toBe(true);
    const [pa, pb] = [await browser.probe(a), await browser.probe(b)];

    expect(pa?.webSocket).not.toBe(pb?.webSocket);
    await browser.stop(a);
    expect(await browser.probe(a)).toBeUndefined();
    expect((await browser.probe(b))?.pid).toBe(pb?.pid ?? -1);
  });

  test('a start stops what an earlier start left, so never two', async () => {
    const l = launch();
    const first = await browser.start(l);
    const second = await browser.start(l);

    if (!first.ok || !second.ok) throw new Error('a start failed');
    expect(alive(first.data.pid)).toBe(false);
    expect((await browser.probe(l))?.pid).toBe(second.data.pid);
  });

  test('a stale pid file naming another process leaves that process alone', async () => {
    const l = launch();
    const other = Bun.spawn(['sleep', '30'], { stdin: 'ignore' });

    try {
      writeFileSync(join(l.dir, 'chromium.pid'), `${other.pid}\n`);
      await browser.stop(l);
      expect(alive(other.pid)).toBe(true);
      expect(existsSync(join(l.dir, 'chromium.pid'))).toBe(false);
    } finally {
      other.kill();
    }
  });

  test('stopping when nothing runs is fine', async () => {
    const l = launch();

    await browser.stop(l);
    expect(await browser.probe(l)).toBeUndefined();
  });
});

const FakeState = z.object({
  cookies: z.array(z.looseObject({ name: z.string(), value: z.string(), domain: z.string() })),
  localStorage: z.record(z.string(), z.record(z.string(), z.string())),
  siteHits: z.number(),
});

const fakeState = async (port: number) =>
  FakeState.parse(await (await fetch(`http://127.0.0.1:${port}/fake/state`)).json());

const STATE: StorageState = {
  v: 1,
  storedAt: '2026-10-24T08:00:00.000Z',
  cookies: [
    {
      name: 'sid',
      value: 'cookie-value-sid',
      domain: 'app.example.test',
      path: '/',
      expires: 1_900_000_000,
      httpOnly: true,
      secure: true,
      session: false,
      sameSite: 'Lax',
    },
    {
      name: 'pref',
      value: 'cookie-value-pref',
      domain: '.example.test',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      session: true,
    },
  ],
  origins: [
    {
      origin: 'https://app.example.test',
      localStorage: [
        { name: 'token', value: 'storage-value-token' },
        { name: 'user', value: '{"id":7}' },
      ],
    },
    {
      origin: 'http://localhost:4300',
      localStorage: [{ name: 'dev', value: 'storage-value-dev' }],
    },
    { origin: 'https://empty.example.test', localStorage: [] },
  ],
};

describe('restoring sign-ins', () => {
  test('cookies into the jar, local storage under its origin, nothing reaching a site', async () => {
    const l = launch();

    expect((await browser.start(l)).ok).toBe(true);
    expect(await browser.restore({ port: l.port, state: STATE })).toEqual({
      ok: true,
      data: { cookies: 2, origins: 2 },
    });
    const after = await fakeState(l.port);

    expect(after.cookies.map((c) => [c.name, c.value, c.domain, c.expires, c.session])).toEqual([
      ['sid', 'cookie-value-sid', 'app.example.test', 1_900_000_000, false],
      ['pref', 'cookie-value-pref', '.example.test', -1, true],
    ]);
    expect(after.localStorage).toEqual({
      'https://app.example.test': { token: 'storage-value-token', user: '{"id":7}' },
      'http://localhost:4300': { dev: 'storage-value-dev' },
    });
    expect(after.siteHits).toBe(0);
    // The setup tabs are closed again.
    expect((await browser.probe(l))?.pages.map((p) => p.id)).toEqual(['P1']);
  });

  test('nothing answering is devtools-failed, with no value in its words', async () => {
    const restored = await browser.restore({ port: freePort(), state: STATE });

    if (restored.ok) throw new Error('expected a refusal');
    expect(restored.error.code).toBe('devtools-failed');
    expect(restored.error.message).not.toContain('value');
  });

  test('through docker exec … socat: the reach pipes DevTools both ways and closes', async () => {
    const l = launch();
    const bin = mkdtempSync(join(tmpdir(), 'abe-docker-'));
    const docker = join(bin, 'docker');
    const argvFile = join(bin, 'argv');

    dirs.push(bin);
    // A fake docker: keeps its argv, then is socat STDIO TCP:<host>:<port> on this host.
    writeFileSync(
      docker,
      [
        `#!${process.execPath}`,
        "import { connect } from 'node:net';",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
        "const [host, port] = (process.argv.at(-1) ?? '').replace('TCP:', '').split(':');",
        'const s = connect(Number(port), host);',
        'process.stdin.pipe(s);',
        's.pipe(process.stdout);',
        "s.on('close', () => process.exit(0));",
        '',
      ].join('\n'),
    );
    chmodSync(docker, 0o755);
    expect((await browser.start(l)).ok).toBe(true);
    const reach = dockerDevtools({ bin: docker, env: { PATH: '/usr/bin:/bin' }, container: 'ws' });
    const viaDocker = chromiumBrowser(local, reach);

    expect(await viaDocker.restore({ port: l.port, state: STATE })).toEqual({
      ok: true,
      data: { cookies: 2, origins: 2 },
    });
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual([
      'exec',
      '--interactive',
      'ws',
      'socat',
      'STDIO',
      `TCP:127.0.0.1:${l.port}`,
    ]);
    const after = await fakeState(l.port);

    expect(after.localStorage['https://app.example.test']).toEqual({
      token: 'storage-value-token',
      user: '{"id":7}',
    });
    expect(after.siteHits).toBe(0);
    // Closed after the restore: its listener no longer answers.
    const opened = await reach(l.port);

    opened.close();
    expect(
      await fetch(`${opened.http}/json/version`).then(
        () => 'answered',
        () => 'refused',
      ),
    ).toBe('refused');
  });
});
