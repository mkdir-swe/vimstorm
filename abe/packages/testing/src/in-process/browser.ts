/**
 * A fake Chromium behind the Browser port. It runs one process at a time. The test sets its pages
 * and DevTools clients with `navigate` and `connect`, and `exit()` kills the process as if it
 * died on its own. `starts`, `stops` and `probes` count what `serve` asked.
 */
import {
  type Answered,
  type Browser,
  type BrowserProbe,
  type Chrome,
  type ProfileStore,
  type SignIns,
  type StorageState,
  type StoredProfile,
} from '@abe/core';

export type FakeBrowserProcess = {
  pid: number;
  dir: string;
  port: number;
  argv: readonly string[];
};

export type FakeBrowser = Browser & {
  /** The running process, or `undefined`. */
  running: FakeBrowserProcess | undefined;
  starts: FakeBrowserProcess[];
  stops: number;
  probes: number;
  /** Makes the next start fail with this message, as when Chromium exits at once. */
  failStart: string | undefined;
  /** Sends the open page to `url`, which counts as activity. */
  navigate: (url: string, title?: string) => void;
  /** Connects a DevTools client, as chrome-devtools-mcp's first tool call does. */
  connect: () => void;
  disconnect: () => void;
  /** Kills the process as if it died on its own. */
  exit: () => void;
  /** Every state restored, with the pid of the browser it went into. */
  restored: { pid: number; state: StorageState }[];
  /** Makes the next restore fail with this message. */
  failRestore: string | undefined;
};

export const fakeBrowser = (firstPid = 4100): FakeBrowser => {
  let pid = firstPid;
  let pages: BrowserProbe['pages'] = [];
  let clients = 0;

  const b: FakeBrowser = {
    running: undefined,
    starts: [],
    stops: 0,
    probes: 0,
    failStart: undefined,
    restored: [],
    failRestore: undefined,
    navigate: (url, title = url) => {
      pages = [{ id: 'P1', url, title }];
    },
    connect: () => {
      clients += 1;
    },
    disconnect: () => {
      clients = Math.max(0, clients - 1);
    },
    exit: () => {
      b.running = undefined;
      clients = 0;
    },
    start: ({ dir, port, argv }): Promise<Answered<{ pid: number }>> => {
      if (b.failStart !== undefined) {
        const message = b.failStart;

        b.failStart = undefined;

        return Promise.resolve({ ok: false, error: { code: 'browser-failed', message } });
      }
      pid += 1;
      b.running = { pid, dir, port, argv };
      b.starts.push(b.running);
      pages = [{ id: 'P1', url: 'about:blank', title: 'about:blank' }];
      clients = 0;

      return Promise.resolve({ ok: true, data: { pid } });
    },
    probe: ({ port }) => {
      b.probes += 1;
      const r = b.running;

      return Promise.resolve(
        r?.port !== port
          ? undefined
          : {
              pid: r.pid,
              version: 'Chrome/156.0.8078.47',
              webSocket: `ws://127.0.0.1:${port}/devtools/browser/fake-${r.pid}`,
              pages,
              clients,
            },
      );
    },
    restore: ({ port, state }) => {
      const r = b.running;

      if (r?.port !== port)
        return Promise.resolve({
          ok: false,
          error: { code: 'devtools-failed', message: `nothing answers on port ${port}` },
        });
      if (b.failRestore !== undefined) {
        const message = b.failRestore;

        b.failRestore = undefined;

        return Promise.resolve({ ok: false, error: { code: 'devtools-failed', message } });
      }
      b.restored.push({ pid: r.pid, state });

      return Promise.resolve({
        ok: true,
        data: { cookies: state.cookies.length, origins: state.origins.length },
      });
    },
    stop: () => {
      b.stops += 1;
      b.running = undefined;
      clients = 0;

      return Promise.resolve();
    },
  };

  return b;
};

/**
 * Secrets Manager standing in for your profiles' sign-ins. It maps each profile to its text and
 * keeps each write in `writes`. A profile in `unreadable` fails to read, like a secret you may not
 * read.
 */
export type FakeProfileStore = ProfileStore & {
  stored: Map<string, { text: string; storedAt: string }>;
  writes: { name: string; text: string }[];
  removed: string[];
  unreadable: Set<string>;
};

export const fakeProfileStore = (
  person = 'ada',
  now: () => string = () => new Date().toISOString(),
): FakeProfileStore => {
  const secret = (name: string) => `abe/${person}/browser/${name}`;
  const s: FakeProfileStore = {
    stored: new Map(),
    writes: [],
    removed: [],
    unreadable: new Set(),
    list: () =>
      Promise.resolve({
        ok: true,
        data: [...s.stored.entries()].map(([name, v]): StoredProfile => ({
          name,
          secret: secret(name),
          storedAt: v.storedAt,
        })),
      }),
    read: (name) => {
      if (s.unreadable.has(name))
        return Promise.resolve({
          ok: false,
          error: {
            code: 'profile-unreadable',
            message: `${secret(name)}: AccessDeniedException (this fake)`,
          },
        });
      const v = s.stored.get(name);

      return Promise.resolve({
        ok: true,
        data: v === undefined ? null : { secret: secret(name), ...v },
      });
    },
    write: (name, text) => {
      s.writes.push({ name, text });
      s.stored.set(name, { text, storedAt: now() });

      return Promise.resolve({ ok: true, data: { secret: secret(name) } });
    },
    remove: (name) => {
      s.removed.push(name);
      s.stored.delete(name);

      return Promise.resolve({ ok: true, data: null });
    },
  };

  return s;
};

/**
 * A stand-in for the Mac's Chrome. `signIns` holds what DevTools would read in each folder. `open`
 * marks a folder's Chrome running and keeps the call in `opened`; `front` keeps its folder in
 * `fronted`; each full read (local storage too, its setup tabs) counts in `fullReads`, each cookies-only
 * one in `cookieReads`. A folder
 * taken out of `runningOn` is that Chrome quit.
 */
export type FakeChrome = Chrome & {
  runningOn: Set<string>;
  opened: { dir: string; urls: readonly string[]; front?: boolean }[];
  fronted: string[];
  fullReads: number;
  cookieReads: number;
  signIns: Map<string, SignIns>;
};

export const fakeChrome = (): FakeChrome => {
  const endpointOf = (dir: string) => `http://127.0.0.1:9${String(dir.length).padStart(3, '0')}`;
  const c: FakeChrome = {
    runningOn: new Set(),
    opened: [],
    fronted: [],
    fullReads: 0,
    cookieReads: 0,
    signIns: new Map(),
    open: ({ dir, urls, front }) => {
      const started = !c.runningOn.has(dir);

      c.opened.push({ dir, urls, ...(front === undefined ? {} : { front }) });
      c.runningOn.add(dir);

      return Promise.resolve({ ok: true, data: { endpoint: endpointOf(dir), started } });
    },
    front: ({ dir }) => {
      c.fronted.push(dir);

      return Promise.resolve({ ok: true, data: null });
    },
    running: (dir) => Promise.resolve(c.runningOn.has(dir) ? endpointOf(dir) : undefined),
    read: (endpoint, o) => {
      const dir = [...c.runningOn].find((d) => endpointOf(d) === endpoint);

      if (dir === undefined)
        return Promise.resolve({
          ok: false,
          error: { code: 'devtools-failed', message: `DevTools did not answer on ${endpoint}` },
        });
      const found = c.signIns.get(dir) ?? { cookies: [], origins: [] };

      if (o?.cookiesOnly === true) {
        c.cookieReads += 1;

        return Promise.resolve({ ok: true, data: { cookies: found.cookies, origins: [] } });
      }
      c.fullReads += 1;

      return Promise.resolve({ ok: true, data: found } satisfies Answered<SignIns>);
    },
  };

  return c;
};
