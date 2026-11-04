#!/usr/bin/env bun
/**
 * A fake Chromium as a real process. It takes Chromium's `--remote-debugging-port` and
 * `--user-data-dir`, makes the profile and answers DevTools' `/json/version` and `/json/list`
 * until it is stopped. `--exit-at-once` exits 1 first, as Chromium does with no usable sandbox.
 *
 * It speaks enough DevTools on its browser WebSocket (`/devtools/browser/<id>`) for a browser
 * profile's sign-ins. It has an in-memory cookie jar (`Storage.*`), page targets with flat
 * sessions (`Target.*`) and `Page.navigate` with `Fetch` interception. It keeps local storage per
 * origin (`DOMStorage.*`), and as in Chromium only a session whose page is at that origin may touch
 * it. A navigation nothing intercepted counts as a site hit. `--remote-debugging-port=0` picks a
 * free port, and it writes `<user-data-dir>/DevToolsActivePort` as Chrome does. Started again on a
 * folder whose fake answers, it hands its URLs to that one and exits, like Chrome's process
 * singleton. `--fake-state=<json file>` preloads `{cookies, localStorage: {origin: {key: value}}}`.
 * `/json/activate/<id>` counts the activation (`activated`). Test endpoints are `GET /fake/state`,
 * which returns `{cookies, localStorage, siteHits, activated, tabsMade}`, and
 * `GET /fake/quit`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ServerWebSocket } from 'bun';

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv.includes('--exit-at-once')) {
  process.stderr.write('[0:0:ERROR:zygote_host_impl_linux.cc] No usable sandbox!\n');
  process.exit(1);
}
const asked = Number(flag('remote-debugging-port') ?? '0');
const profile = flag('user-data-dir');
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const activePort = profile === undefined ? undefined : join(profile, 'DevToolsActivePort');

type Json = Record<string, unknown>;

const record = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};

const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

// Like Chrome's process singleton, a second start on a folder hands its URLs to the one running.
if (activePort !== undefined && existsSync(activePort)) {
  const port = Number(readFileSync(activePort, 'utf8').split('\n')[0]);
  const running = await fetch(`http://127.0.0.1:${port}/json/version`).then(
    (r) => r.ok,
    () => false,
  );

  if (running) {
    for (const url of urls)
      await fetch(`http://127.0.0.1:${port}/fake/open?url=${encodeURIComponent(url)}`);
    process.exit(0);
  }
}

if (profile !== undefined) mkdirSync(profile, { recursive: true });
const id = `fake-${process.pid}`;

type Ws = ServerWebSocket;
type Target = { targetId: string; url: string; origin: string | undefined };
type Session = { targetId: string; fetch: RegExp[]; page: boolean };

const jar: Json[] = [];
const storage = new Map<string, Map<string, string>>();
const targets = new Map<string, Target>();
const sessions = new Map<string, Session>();
const paused = new Map<string, () => void>();
let siteHits = 0;
/** Tabs activated through `/json/activate`, and tabs DevTools made (`Target.createTarget`). */
const activated: string[] = [];
let tabsMade = 0;
let counter = 0;
const nextId = (prefix: string) => {
  counter += 1;

  return `${prefix}${counter}`;
};

const originOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);

    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

const preload = flag('fake-state');

if (preload !== undefined) {
  const state = record(JSON.parse(readFileSync(preload, 'utf8')));

  if (Array.isArray(state.cookies)) for (const c of state.cookies) jar.push(record(c));
  for (const [origin, items] of Object.entries(record(state.localStorage)))
    storage.set(
      origin,
      new Map(Object.entries(record(items)).map(([k, v]) => [k, text(v)] as const)),
    );
}

/** A tab opened at `url` as Chrome would load it. Any http(s) URL reaches its site. */
const openTab = (url: string, targetId = nextId('P')) => {
  const origin = originOf(url);

  if (origin !== undefined) siteHits += 1;
  targets.set(targetId, { targetId, url, origin });

  return targetId;
};

if (urls.length === 0) openTab('about:blank', 'P1');
else urls.forEach((u, i) => openTab(u, i === 0 ? 'P1' : nextId('P')));

const cookieKey = (c: Json) =>
  JSON.stringify([c.name, c.domain, c.path, JSON.stringify(c.partitionKey ?? null)]);

/** A cookie as `Storage.setCookies` takes it, kept as `Storage.getCookies` answers it. */
const setCookie = (input: Json) => {
  const session = typeof input.expires !== 'number';
  const c: Json = {
    name: text(input.name),
    value: text(input.value),
    domain: text(input.domain),
    path: text(input.path, '/'),
    expires: session ? -1 : input.expires,
    size: text(input.name).length + text(input.value).length,
    httpOnly: input.httpOnly === true,
    secure: input.secure === true,
    session,
    ...(input.sameSite === undefined ? {} : { sameSite: input.sameSite }),
    priority: input.priority ?? 'Medium',
    sourceScheme: input.sourceScheme ?? (input.secure === true ? 'Secure' : 'NonSecure'),
    sourcePort: input.sourcePort ?? (input.secure === true ? 443 : 80),
    ...(input.partitionKey === undefined ? {} : { partitionKey: input.partitionKey }),
  };
  const at = jar.findIndex((o) => cookieKey(o) === cookieKey(c));

  if (at === -1) jar.push(c);
  else jar[at] = c;
};

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);

class Refused extends Error {}

const event = (ws: Ws, method: string, params: Json, sessionId?: string) => {
  ws.send(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
};

/** The local storage `params.storageId` names. Like Chromium, it refuses a page elsewhere. */
const storageOf = (session: Session, params: Json): Map<string, string> => {
  const origin = text(record(params.storageId).storageKey).replace(/\/$/, '');

  if (targets.get(session.targetId)?.origin !== origin)
    throw new Refused('Frame not found for the given storage id');
  const items = storage.get(origin) ?? new Map<string, string>();

  storage.set(origin, items);

  return items;
};

const handle = async (
  ws: Ws,
  method: string,
  params: Json,
  sessionId: string | undefined,
): Promise<Json> => {
  const session = sessionId === undefined ? undefined : sessions.get(sessionId);

  if (sessionId !== undefined && session === undefined)
    throw new Refused('Session with given id not found.');
  const onPage = (): Session => {
    if (session === undefined) throw new Refused(`'${method}' wasn't found`);

    return session;
  };

  switch (method) {
    case 'Browser.getVersion':
      return { product: 'Chrome/156.0.0.0' };
    case 'Browser.close':
      setTimeout(() => process.exit(0), 10);

      return {};
    case 'Storage.getCookies':
      return { cookies: jar };
    case 'Storage.setCookies':
      for (const c of Array.isArray(params.cookies) ? params.cookies : []) setCookie(record(c));

      return {};
    case 'Target.getTargets':
      return {
        targetInfos: [...targets.values()].map((t) => ({
          targetId: t.targetId,
          type: 'page',
          title: t.url,
          url: t.url,
          attached: [...sessions.values()].some((s) => s.targetId === t.targetId),
          canAccessOpener: false,
        })),
      };
    case 'Target.createTarget':
      tabsMade += 1;

      return { targetId: openTab(text(params.url, 'about:blank'), nextId('T')) };
    case 'Target.attachToTarget': {
      const targetId = text(params.targetId);

      if (!targets.has(targetId)) throw new Refused('No target with given id found');
      if (params.flatten !== true) throw new Refused('this fake speaks flat sessions only');
      const s = nextId('S');

      sessions.set(s, { targetId, fetch: [], page: false });

      return { sessionId: s };
    }
    case 'Target.closeTarget': {
      const targetId = text(params.targetId);

      if (!targets.delete(targetId)) throw new Refused('No target with given id found');
      for (const [s, v] of sessions) if (v.targetId === targetId) sessions.delete(s);

      return { success: true };
    }
    case 'Page.enable':
      onPage().page = true;

      return {};
    case 'Fetch.enable':
      onPage().fetch = (Array.isArray(params.patterns) ? params.patterns : []).map((p) =>
        glob(text(record(p).urlPattern, '*')),
      );

      return {};
    case 'Fetch.disable':
      onPage().fetch = [];

      return {};
    case 'Fetch.fulfillRequest': {
      const requestId = text(params.requestId);
      const done = paused.get(requestId);

      if (done === undefined) throw new Refused('Invalid InterceptionId.');
      paused.delete(requestId);
      done();

      return {};
    }
    case 'Page.navigate': {
      const s = onPage();
      const url = text(params.url);
      const target = targets.get(s.targetId);

      if (target === undefined) throw new Refused('No target with given id found');
      if (s.fetch.some((p) => p.test(url))) {
        const requestId = nextId('interception-job-');
        const answered = new Promise<void>((resolve) => paused.set(requestId, resolve));

        event(
          ws,
          'Fetch.requestPaused',
          {
            requestId,
            request: { url, method: 'GET', headers: {} },
            frameId: s.targetId,
            resourceType: 'Document',
          },
          sessionId,
        );
        await answered;
      } else if (originOf(url) !== undefined) siteHits += 1;
      target.url = url;
      target.origin = originOf(url);
      setTimeout(() => {
        if (s.page && sessionId !== undefined && sessions.has(sessionId))
          event(ws, 'Page.loadEventFired', { timestamp: performance.now() / 1000 }, sessionId);
      }, 5);

      return { frameId: s.targetId, loaderId: nextId('L') };
    }
    case 'DOMStorage.enable':
      onPage();

      return {};
    case 'DOMStorage.getDOMStorageItems':
      return { entries: [...storageOf(onPage(), params).entries()] };
    case 'DOMStorage.setDOMStorageItem':
      storageOf(onPage(), params).set(text(params.key), text(params.value));

      return {};
    default:
      throw new Refused(`'${method}' wasn't found`);
  }
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: asked,
  fetch: (req, srv) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === `/devtools/browser/${id}`)
      return srv.upgrade(req) ? undefined : new Response('no upgrade', { status: 400 });
    if (path === '/json/version')
      return Response.json({
        Browser: 'Chrome/156.0.0.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/${id}`,
      });
    if (path === '/json/list')
      return Response.json([
        ...[...targets.values()].map((t) => ({
          id: t.targetId,
          type: 'page',
          url: t.url,
          title: t.url,
        })),
        { id: 'W1', type: 'service_worker', url: 'http://x/sw.js', title: 'sw' },
      ]);
    if (path === '/fake/state')
      return Response.json({
        cookies: jar,
        localStorage: Object.fromEntries(
          [...storage.entries()]
            .filter(([, items]) => items.size > 0)
            .map(([o, items]) => [o, Object.fromEntries(items)]),
        ),
        siteHits,
        activated,
        tabsMade,
      });
    if (path.startsWith('/json/activate/')) {
      const target = decodeURIComponent(path.slice('/json/activate/'.length));

      if (!targets.has(target)) return new Response('No such target id', { status: 404 });
      activated.push(target);

      return new Response('Target activated');
    }
    if (path === '/fake/open') {
      openTab(url.searchParams.get('url') ?? 'about:blank');

      return Response.json({});
    }
    if (path === '/fake/quit') {
      setTimeout(() => process.exit(0), 10);

      return Response.json({});
    }

    return new Response('not found', { status: 404 });
  },
  websocket: {
    message: (ws, data) => {
      const m = record(JSON.parse(typeof data === 'string' ? data : data.toString()));
      const sessionId = typeof m.sessionId === 'string' ? m.sessionId : undefined;
      const reply = (body: Json) => {
        ws.send(
          JSON.stringify({ id: m.id, ...body, ...(sessionId === undefined ? {} : { sessionId }) }),
        );
      };

      handle(ws, text(m.method), record(m.params), sessionId).then(
        (result) => {
          reply({ result });
        },
        (err: unknown) => {
          reply({
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        },
      );
    },
  },
});

if (activePort !== undefined)
  writeFileSync(activePort, `${String(server.port)}\n/devtools/browser/${id}\n`);
process.stdout.write(
  `DevTools listening on ws://127.0.0.1:${String(server.port)}/devtools/browser/${id}\n`,
);
