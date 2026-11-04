/**
 * `abe browser start|stop|status` (#66) on a box's `serve` with a fake Chromium behind the Browser
 * port: from inside the workspace (the real `abe` on the workspace's socket, as a session runs
 * it), one browser per workspace, the stops (`stop`, verification's end, idle, exited), two boxes
 * side by side, and the session's MCP config.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER,
  BrowserData,
  type BrowserStopReason,
  Event,
  readEnvelope,
  type Reply,
} from '@abe/core';
import {
  cli,
  type Cli,
  fakeBrowser,
  fakeClock,
  fakeProfileStore,
  type FakeProfileStore,
  scenario,
  type ServeScenario,
  T0,
} from '@abe/testing';
import { startBrowserService } from './browser';

const REPO = 'mkdir-swe/demo-shop';
const MIN = 60_000;

const data = (reply: Reply): BrowserData => {
  const doc = readEnvelope(BrowserData, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const errorOf = (reply: Reply) => {
  const doc = readEnvelope(BrowserData, JSON.parse(reply.stdout));

  if (doc.ok) throw new Error(`expected a refusal, got ${reply.stdout}`);

  return doc.error.code;
};

const withWorkspace = async (o: { browserPollMs?: number; profiles?: FakeProfileStore } = {}) => {
  const { profiles, ...rest } = o;
  const s = await scenario({
    box: true,
    ...rest,
    ...(profiles === undefined ? {} : { browserProfiles: { store: profiles } }),
  });

  s.box.mirrors.trees.set(REPO, 'tree1');
  const up = await s.request('workspace', 'up', '--repo', REPO, '--card', '101', '--json');

  if (up.exit !== 0) throw new Error(up.stdout);

  return s;
};

const inside = (s: ServeScenario, ...argv: string[]) => s.requestInside(...argv, '--json');

/** Waits until `ok()` holds, polling; fails after 2 s. */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400; i += 1) {
    if (ok()) return;
    await Bun.sleep(5);
  }
  throw new Error('timed out');
};

const clis: Cli[] = [];

afterEach(async () => {
  for (const c of clis.splice(0)) await c.close();
});

describe('abe browser start', () => {
  test('from inside the workspace: headless Chromium, its own profile and port, the endpoint', async () => {
    await using s = await withWorkspace();
    // The real abe in the workspace container: ABE_WORKSPACE set, the mounted socket.
    const session = cli({
      env: {
        ABE_WORKSPACE: '101',
        ABE_SOCKET: join(s.state.dir, 'workspaces', '101', 'serve.sock'),
      },
    });

    clis.push(session);
    const started = await session.json(BrowserData, 'browser', 'start');

    expect(started.exit).toBe(0);
    if (!started.doc.ok) throw new Error(started.doc.error.message);
    expect(started.doc.data).toMatchObject({
      state: 'running',
      endpoint: 'http://127.0.0.1:9222',
      webSocket: 'ws://127.0.0.1:9222/devtools/browser/fake-4101',
      browser: 'Chrome/156.0.8078.47',
      pid: 4101,
      pages: 1,
      port: 9222,
      profile: '/home/abe/.cache/abe/browser/profile',
      mcpConfig: '/run/abe/mcp.json',
      startedAt: new Date(T0).toISOString(),
      idleStopAt: new Date(T0 + 10 * MIN).toISOString(),
      stopped: null,
      // No profile named anywhere: the built-in empty one, exactly 2.0's (#103).
      browserProfile: 'default',
      signIns: null,
    });
    expect(s.box.browser.restored).toEqual([]);
    const [run] = s.box.browser.starts;

    expect(run?.dir).toBe(BROWSER.dir);
    expect(run?.argv[0]).toBe('/usr/bin/chromium');
    expect(run?.argv).toContain('--headless');
    expect(run?.argv).toContain('--remote-debugging-port=9222');
    expect(run?.argv).toContain('--user-data-dir=/home/abe/.cache/abe/browser/profile');
    // Its sandbox stays on: the workspace's seccomp profile allows it.
    expect(run?.argv).not.toContain('--no-sandbox');
    const text = await session.run('browser', 'status');

    expect(text.stdout).toBe(
      'Chrome/156.0.8078.47 running at http://127.0.0.1:9222 (pid 4101, 1 page), idle stop at 09:10 UTC\n',
    );
  });

  test('one per workspace: a second start answers the running one', async () => {
    await using s = await withWorkspace();
    const first = data(await inside(s, 'browser', 'start'));
    const again = data(await inside(s, 'browser', 'start'));

    expect(again.pid).toBe(first.pid);
    expect(s.box.browser.starts).toHaveLength(1);
  });

  test('a browser this serve did not start (serve started again) is adopted, not doubled', async () => {
    const s = await withWorkspace();

    await inside(s, 'browser', 'start');
    await s.serve.stop();
    await using again = await scenario({ state: s.state, box: s.box });

    expect(data(await inside(again, 'browser', 'status'))).toMatchObject({
      state: 'running',
      pid: 4101,
      startedAt: null,
    });
    expect(data(await inside(again, 'browser', 'start')).pid).toBe(4101);
    expect(again.box.browser.starts).toHaveLength(1);
  });

  test('Chromium failing to start is browser-failed', async () => {
    await using s = await withWorkspace();

    s.box.browser.failStart = 'No usable sandbox!';
    const reply = await inside(s, 'browser', 'start');

    expect(reply.exit).toBe(1);
    expect(errorOf(reply)).toBe('browser-failed');
  });

  test('no workspace, a stopped one, or no box: refused', async () => {
    await using bare = await scenario({ box: true });

    expect(errorOf(await bare.request('browser', 'start', '--json'))).toBe('no-workspace');
    await using s = await withWorkspace();

    s.box.docker.boxStop();
    expect(errorOf(await s.request('browser', 'start', '--json'))).toBe('workspace-stopped');
    expect(s.box.browser.starts).toHaveLength(0);
    await using mac = await scenario();

    expect(errorOf(await mac.request('browser', 'status', '--json'))).toBe('not-a-box');
  });
});

describe('abe browser status', () => {
  test('stopped before any start; the endpoint while it runs', async () => {
    await using s = await withWorkspace();

    expect(data(await inside(s, 'browser', 'status'))).toMatchObject({
      state: 'stopped',
      endpoint: null,
      pid: null,
      stopped: null,
    });
    expect((await s.requestInside('browser', 'status')).stdout).toBe('no browser running\n');
    await inside(s, 'browser', 'start');
    expect(data(await inside(s, 'browser', 'status')).endpoint).toBe('http://127.0.0.1:9222');
  });

  test('a browser that died on its own is stopped: exited', async () => {
    await using s = await withWorkspace();

    await inside(s, 'browser', 'start');
    s.box.browser.exit();
    // One reading without an answer may be a slow DevTools: the second is the browser gone.
    expect(data(await inside(s, 'browser', 'status'))).toMatchObject({
      state: 'stopped',
      stopped: null,
    });
    expect(data(await inside(s, 'browser', 'status'))).toMatchObject({
      state: 'stopped',
      stopped: { at: new Date(T0).toISOString(), reason: 'exited' },
    });
  });
});

describe('abe browser stop', () => {
  test('stops it; stopping again changes nothing', async () => {
    await using s = await withWorkspace();

    await inside(s, 'browser', 'start');
    s.clock.tick(MIN);
    const stopped = data(await inside(s, 'browser', 'stop'));

    expect(stopped).toMatchObject({
      state: 'stopped',
      endpoint: null,
      stopped: { at: new Date(T0 + MIN).toISOString(), reason: 'stop' },
    });
    expect(s.box.browser.running).toBeUndefined();
    expect(data(await inside(s, 'browser', 'stop')).stopped?.reason).toBe('stop');
    expect((await s.requestInside('browser', 'status')).stdout).toBe(
      'no browser running (stopped 09:01 UTC: stop)\n',
    );
  });
});

describe('the idle stop', () => {
  test('ten minutes with the same pages and clients stop it; activity puts it off', async () => {
    await using s = await withWorkspace({ browserPollMs: 5 });
    const b = s.box.browser;
    const polled = async () => {
      const n = b.probes;

      await until(() => b.probes > n + 1);
    };

    await inside(s, 'browser', 'start');
    s.clock.tick(9 * MIN);
    // chrome-devtools-mcp connects and opens the shop: activity.
    b.connect();
    b.navigate('http://127.0.0.1:5173/', 'Leaf & Kettle');
    await polled();
    s.clock.tick(9 * MIN);
    await polled();
    expect(b.running).toBeDefined();
    expect(data(await inside(s, 'browser', 'status'))).toMatchObject({
      clients: 1,
      lastActivityAt: new Date(T0 + 9 * MIN).toISOString(),
      idleStopAt: new Date(T0 + 19 * MIN).toISOString(),
    });
    // Still connected, nothing changes for ten minutes: idle all the same.
    s.clock.tick(MIN);
    await until(() => b.running === undefined);
    expect(data(await inside(s, 'browser', 'status')).stopped).toEqual({
      at: new Date(T0 + 19 * MIN).toISOString(),
      reason: 'idle',
    });
  });
});

describe('the idle stop after a restart', () => {
  test('a browser left by the serve before is adopted and idle-stopped with no command run', async () => {
    const s = await withWorkspace();

    await inside(s, 'browser', 'start');
    await s.serve.stop();
    await using again = await scenario({ state: s.state, box: s.box, browserPollMs: 5 });
    const b = again.box.browser;
    const probes = b.probes;

    await until(() => b.probes > probes + 1);
    again.clock.tick(10 * MIN);
    await until(() => b.running === undefined);
    expect(data(await inside(again, 'browser', 'status')).stopped?.reason).toBe('idle');
  });
});

describe('verification ending', () => {
  test("the verify flow's stop is recorded as verified", async () => {
    const reasons: BrowserStopReason[] = [];
    const browser = fakeBrowser();
    const service = startBrowserService({
      browser,
      clock: fakeClock(),
      every: 3_600_000,
      started: () => undefined,
      stopped: (d) => reasons.push(d.reason),
      ready: () => Promise.resolve({ ok: true, data: undefined }),
    });

    await service.start();
    const stopped = await service.stop('verified');

    service.close();
    expect(stopped.ok && stopped.data.stopped?.reason).toBe('verified');
    expect(browser.running).toBeUndefined();
    expect(reasons).toEqual(['verified']);
  });
});

describe('browser events', () => {
  test('abe watch streams browser.started and browser.stopped', async () => {
    await using s = await withWorkspace();
    const mine = cli({ env: { ABE_SOCKET: s.state.socket } });

    clis.push(mine);
    const w = mine.spawn('watch', '--json', '--since', '0', '--no-start');

    await inside(s, 'browser', 'start');
    await inside(s, 'browser', 'stop');
    const seen: unknown[] = [];

    while (seen.length < 2) {
      const e = Event.parse(JSON.parse(await w.next()));

      if (e.type.startsWith('browser.')) seen.push({ type: e.type, data: e.data });
    }
    w.signal('SIGKILL');
    expect(seen).toEqual([
      { type: 'browser.started', data: { pid: 4101, endpoint: 'http://127.0.0.1:9222' } },
      { type: 'browser.stopped', data: { reason: 'stop' } },
    ]);
  });
});

/** A stored copy of `work-admin`'s sign-ins, as `abe browser store` wrote it two days before T0. */
const STORED_AT = new Date(T0 - 2 * 24 * 60 * MIN).toISOString();
const STATE = {
  v: 1 as const,
  storedAt: STORED_AT,
  cookies: [
    {
      name: 'sid',
      value: 'cookie-value-never-printed',
      domain: 'app.example.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      session: true,
    },
  ],
  origins: [
    {
      origin: 'https://app.example.test',
      localStorage: [{ name: 'token', value: 'storage-value-never-printed' }],
    },
  ],
};

const storedProfiles = () => {
  const store = fakeProfileStore();

  store.stored.set('work-admin', { text: JSON.stringify(STATE), storedAt: STORED_AT });

  return store;
};

describe('abe browser start --profile (#103)', () => {
  test('a stored profile: a fresh Chromium, its sign-ins set before the answer', async () => {
    await using s = await withWorkspace({ profiles: storedProfiles() });
    const reply = await inside(s, 'browser', 'start', '--profile', 'work-admin');
    const started = data(reply);
    const [run] = s.box.browser.starts;

    // Chromium's own profile is still made anew: the same argv as an empty start.
    expect(run?.argv).toContain('--user-data-dir=/home/abe/.cache/abe/browser/profile');
    expect(s.box.browser.restored).toEqual([{ pid: started.pid ?? 0, state: STATE }]);
    expect(started).toMatchObject({
      state: 'running',
      browserProfile: 'work-admin',
      signIns: { storedAt: STORED_AT, ago: '2 days ago' },
    });
    // No value in the reply.
    expect(reply.stdout).not.toContain('never-printed');
    expect((await s.requestInside('browser', 'status')).stdout).toEndWith(
      'work-admin · signed in from a copy stored 2 days ago (cookies and local storage only)\n',
    );
  });

  test('started again in another profile: the running one goes, the new one is fresh', async () => {
    await using s = await withWorkspace({ profiles: storedProfiles() });

    await inside(s, 'browser', 'start');
    const again = data(await inside(s, 'browser', 'start', '--profile', 'work-admin'));

    expect(s.box.browser.starts).toHaveLength(2);
    expect(s.box.browser.stops).toBe(1);
    expect(again.browserProfile).toBe('work-admin');
    // The same profile again answers the running one.
    data(await inside(s, 'browser', 'start', '--profile', 'work-admin'));
    expect(s.box.browser.starts).toHaveLength(2);
  });

  test('nothing stored: refused profile-not-stored with the fix, never started empty', async () => {
    await using s = await withWorkspace({ profiles: storedProfiles() });
    const reply = await inside(s, 'browser', 'start', '--profile', 'po-review');
    const doc = readEnvelope(BrowserData, JSON.parse(reply.stdout));

    expect(doc.ok ? '' : `${doc.error.code}: ${doc.error.message}`).toBe(
      'profile-not-stored: po-review has no stored sign-ins: abe browser store po-review locally',
    );
    expect(s.box.browser.starts).toHaveLength(0);
  });

  test('a secret that cannot be read: profile-unreadable naming the secret, never its value', async () => {
    const store = storedProfiles();

    store.unreadable.add('work-admin');
    await using s = await withWorkspace({ profiles: store });
    const reply = await inside(s, 'browser', 'start', '--profile', 'work-admin');

    expect(errorOf(reply)).toBe('profile-unreadable');
    expect(reply.stdout).toContain('abe/ada/browser/work-admin');
    expect(reply.stdout).not.toContain('never-printed');
    expect(s.box.browser.starts).toHaveLength(0);
  });

  test('a restore that fails stops the browser: never left running empty', async () => {
    await using s = await withWorkspace({ profiles: storedProfiles() });

    s.box.browser.failRestore = 'DOMStorage.setDOMStorageItem: Frame not found';
    const reply = await inside(s, 'browser', 'start', '--profile', 'work-admin');

    expect(errorOf(reply)).toBe('profile-restore-failed');
    expect(s.box.browser.running).toBeUndefined();
    // Nothing held of it: the next start restores afresh.
    data(await inside(s, 'browser', 'start', '--profile', 'work-admin'));
    expect(s.box.browser.restored).toHaveLength(1);
    expect(s.box.browser.starts).toHaveLength(2);
  });

  test('a browser a serve before this one started: kept for an empty start, a named one starts afresh', async () => {
    const s = await withWorkspace({ profiles: storedProfiles() });

    await inside(s, 'browser', 'start');
    await s.serve.stop();
    await using again = await scenario({
      state: s.state,
      box: s.box,
      browserProfiles: { store: storedProfiles() },
    });

    expect(data(await inside(again, 'browser', 'start')).pid).toBe(4101);
    expect(data(await inside(again, 'browser', 'start', '--profile', 'work-admin')).pid).toBe(4102);
    expect(again.box.browser.restored).toHaveLength(1);
  });

  test('a --profile that is no profile name is a usage error', async () => {
    await using s = await withWorkspace({ profiles: storedProfiles() });

    expect((await inside(s, 'browser', 'start', '--profile', 'Not/A Name')).exit).toBe(2);
  });
});

describe('two workspaces', () => {
  test('each box runs its own browser; stopping one leaves the other', async () => {
    await using a = await withWorkspace();
    await using b = await withWorkspace();

    await inside(a, 'browser', 'start');
    await inside(b, 'browser', 'start');
    expect(a.box.browser.running).toBeDefined();
    expect(b.box.browser.running).toBeDefined();
    await inside(a, 'browser', 'stop');
    expect(a.box.browser.running).toBeUndefined();
    expect(data(await inside(b, 'browser', 'status')).state).toBe('running');
  });
});

describe("the session's MCP config", () => {
  test('chrome-devtools-mcp on this workspace browser, beside the socket', async () => {
    await using s = await withWorkspace();
    const path = join(s.state.dir, 'workspaces', '101', 'mcp.json');
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'));

    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(config).toEqual({
      mcpServers: {
        'chrome-devtools': {
          type: 'stdio',
          command: 'chrome-devtools-mcp',
          args: [
            '--browserUrl=http://127.0.0.1:9222',
            '--no-page-id-routing',
            '--usageStatistics=false',
            '--performanceCrux=false',
            '--workspace=/workspace',
          ],
          env: {
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
            CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
          },
        },
      },
    });
  });
});
