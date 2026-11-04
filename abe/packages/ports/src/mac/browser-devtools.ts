/**
 * A browser's sign-ins through Chrome DevTools (#103 S3), IO only: a small client on the browser's
 * own WebSocket (flat sessions), reading every cookie and the local storage of the origins core's
 * `stateOrigins` names, and setting them into another browser. Local storage needs a frame of its
 * origin, so each origin gets a setup tab whose request DevTools answers itself
 * (`Fetch.fulfillRequest`, a blank page): nothing reaches the site and none of its code runs
 * (`.scratch/2.1/t103/report.md`). No message ever carries a cookie's or an item's value.
 */
import {
  type Answered,
  cookieParam,
  type SignIns,
  StateCookie,
  type StateOrigin,
  stateOrigins,
  type StorageState,
} from '@abe/core';
import { z } from 'zod';

/** How long one DevTools call may take, and a whole read or restore. */
const CALL_MS = 10_000;
const WHOLE_MS = 120_000;
/** Setup tabs open at once. */
const TABS_AT_ONCE = 4;

const Version = z.object({ webSocketDebuggerUrl: z.string() });

const Message = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  sessionId: z.string().optional(),
});

type Listener = (params: unknown, sessionId: string | undefined) => void;

/** One browser's DevTools: a call answers its result, refused with DevTools' own words. */
export type Devtools = {
  call: <T>(
    schema: z.ZodType<T>,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<T>;
  /** Every `method` event from now on; the answer stops listening. */
  on: (method: string, listener: Listener) => () => void;
  close: () => void;
};

class DevtoolsError extends Error {}

/**
 * Connects to the browser behind `http` (DevTools' HTTP endpoint): its `/json/version` names the
 * browser's WebSocket, reached on `http`'s own host and port, as through a tunnel.
 */
export const connectDevtools = async (http: string, callMs = CALL_MS): Promise<Devtools> => {
  let version: unknown;

  try {
    const res = await fetch(`${http}/json/version`, { signal: AbortSignal.timeout(callMs) });

    version = await res.json();
  } catch (err) {
    throw new DevtoolsError(`DevTools did not answer on ${http}: ${why(err)}`);
  }
  const v = Version.safeParse(version);

  if (!v.success) throw new DevtoolsError(`${http}/json/version names no browser WebSocket`);
  const url = new URL(v.data.webSocketDebuggerUrl);
  const base = new URL(http);

  url.host = base.host;
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url.toString());

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new DevtoolsError(`DevTools' WebSocket on ${http} did not open`));
    }, callMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      ws.close();
      reject(new DevtoolsError(`DevTools' WebSocket on ${http} refused the connection`));
    });
  });

  let next = 0;
  const waiting = new Map<
    number,
    { method: string; done: (m: z.infer<typeof Message>) => void; fail: (e: Error) => void }
  >();
  const listeners = new Map<string, Set<Listener>>();

  ws.addEventListener('message', (ev) => {
    let raw: unknown;

    try {
      raw = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    const m = Message.safeParse(raw);

    if (!m.success) return;
    if (m.data.id !== undefined) {
      const w = waiting.get(m.data.id);

      waiting.delete(m.data.id);
      w?.done(m.data);
    } else if (m.data.method !== undefined)
      for (const l of listeners.get(m.data.method) ?? []) l(m.data.params, m.data.sessionId);
  });
  ws.addEventListener('close', () => {
    for (const w of waiting.values()) w.fail(new DevtoolsError(`${w.method}: DevTools closed`));
    waiting.clear();
  });

  return {
    call: <T>(
      schema: z.ZodType<T>,
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      new Promise<T>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new DevtoolsError(`${method}: DevTools closed`));

          return;
        }
        next += 1;
        const id = next;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new DevtoolsError(`${method}: no answer in ${callMs / 1000} s`));
        }, callMs);

        waiting.set(id, {
          method,
          done: (m) => {
            clearTimeout(timer);
            if (m.error !== undefined) {
              reject(new DevtoolsError(`${method}: ${m.error.message}`));

              return;
            }
            const r = schema.safeParse(m.result ?? {});

            if (r.success) resolve(r.data);
            else
              reject(
                new DevtoolsError(
                  `${method} answered an unexpected shape (${r.error.issues
                    .map((i) => i.path.join('.') || 'its answer')
                    .slice(0, 3)
                    .join(', ')})`,
                ),
              );
          },
          fail: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    on: (method, listener) => {
      const set = listeners.get(method) ?? new Set<Listener>();

      set.add(listener);
      listeners.set(method, set);

      return () => set.delete(listener);
    },
    close: () => {
      ws.close();
    },
  };
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

const Empty = z.object({});
const Cookies = z.object({ cookies: z.array(StateCookie) });
const Targets = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
});
const Created = z.object({ targetId: z.string() });
const Attached = z.object({ sessionId: z.string() });
const Navigated = z.object({ errorText: z.string().optional() });
const Paused = z.object({ requestId: z.string() });
const Items = z.object({ entries: z.array(z.array(z.string())) });

const BLANK = Buffer.from('<!doctype html><title>abe</title>').toString('base64');

/**
 * A tab at `origin` whose requests DevTools answers with a blank page, for `use` to read or set
 * its local storage on; closed after, whatever `use` did.
 */
const setupTab = async <T>(
  dt: Devtools,
  origin: string,
  use: (sessionId: string, storageId: { storageKey: string; isLocalStorage: true }) => Promise<T>,
  o: { background: boolean },
): Promise<T> => {
  const { targetId } = await dt.call(Created, 'Target.createTarget', {
    url: 'about:blank',
    ...(o.background ? { background: true } : {}),
  });
  const stops: (() => void)[] = [];

  try {
    const { sessionId } = await dt.call(Attached, 'Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    stops.push(
      dt.on('Fetch.requestPaused', (params, s) => {
        const p = Paused.safeParse(params);

        if (s !== sessionId || !p.success) return;
        dt.call(
          Empty,
          'Fetch.fulfillRequest',
          {
            requestId: p.data.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
            body: BLANK,
          },
          sessionId,
        ).catch(() => undefined);
      }),
    );
    await dt.call(Empty, 'Fetch.enable', { patterns: [{ urlPattern: `${origin}/*` }] }, sessionId);
    await dt.call(Empty, 'Page.enable', {}, sessionId);
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DevtoolsError(`the setup tab of ${origin} did not load`));
      }, CALL_MS);

      stops.push(
        dt.on('Page.loadEventFired', (_p, s) => {
          if (s !== sessionId) return;
          clearTimeout(timer);
          resolve();
        }),
        () => {
          clearTimeout(timer);
        },
      );
    });

    loaded.catch(() => undefined);
    const nav = await dt.call(Navigated, 'Page.navigate', { url: `${origin}/` }, sessionId);

    if (nav.errorText !== undefined && nav.errorText !== '')
      throw new DevtoolsError(`the setup tab of ${origin}: ${nav.errorText}`);
    await loaded;
    await dt.call(Empty, 'DOMStorage.enable', {}, sessionId);

    return await use(sessionId, { storageKey: `${origin}/`, isLocalStorage: true });
  } finally {
    for (const stop of stops) stop();
    await dt.call(Empty, 'Target.closeTarget', { targetId }).catch(() => undefined);
  }
};

/** `work` over `items`, at most `n` at once, answers in order. */
const pooled = async <A, B>(items: readonly A[], n: number, work: (a: A) => Promise<B>) => {
  const out: B[] = new Array<B>(items.length);
  let at = 0;
  const lane = async () => {
    for (let i = at; i < items.length; i = at) {
      at += 1;
      const item = items[i];

      if (item !== undefined) out[i] = await work(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));

  return out;
};

/** `text` with every one of `values` (a cookie's, an item's) blanked out. */
const scrubbed = (text: string, values: ReadonlySet<string>) => {
  let out = text;

  for (const v of values) if (v.length >= 4) out = out.split(v).join('…');

  return out;
};

/**
 * Runs `work` on the browser behind `http`, closed after; any failure is `devtools-failed`, its
 * message with `secrets` (and every value `work` added to it) blanked out.
 */
const withDevtools = async <T>(
  http: string,
  secrets: Set<string>,
  work: (dt: Devtools) => Promise<T>,
  wholeMs = WHOLE_MS,
): Promise<Answered<T>> => {
  let dt: Devtools | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    dt = await connectDevtools(http);
    const open = dt;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DevtoolsError(`DevTools on ${http} took more than ${wholeMs / 1000} s`));
      }, wholeMs);
    });

    return { ok: true, data: await Promise.race([work(open), late]) };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'devtools-failed', message: scrubbed(why(err), secrets) },
    };
  } finally {
    clearTimeout(timer);
    dt?.close();
  }
};

/**
 * The sign-ins of the browser behind `http`: every cookie of its default context, and the local
 * storage of the cookies' origins and its open tabs' (each through a setup tab behind the others).
 * `cookiesOnly`: the cookies alone, no tab opened.
 */
export const readSignIns = (
  http: string,
  o: { cookiesOnly?: boolean } = {},
): Promise<Answered<SignIns>> => {
  const secrets = new Set<string>();

  return withDevtools(http, secrets, async (dt) => {
    const { cookies } = await dt.call(Cookies, 'Storage.getCookies');

    for (const c of cookies) secrets.add(c.value);
    if (o.cookiesOnly === true) return { cookies, origins: [] };
    const { targetInfos } = await dt.call(Targets, 'Target.getTargets');
    const tabs = targetInfos.filter((t) => t.type === 'page').map((t) => t.url);
    const origins = await pooled(
      stateOrigins(cookies, tabs),
      TABS_AT_ONCE,
      (origin): Promise<StateOrigin> =>
        setupTab(
          dt,
          origin,
          async (sessionId, storageId) => {
            const { entries } = await dt.call(
              Items,
              'DOMStorage.getDOMStorageItems',
              { storageId },
              sessionId,
            );
            const localStorage = entries.flatMap(([name, value]) =>
              name === undefined || value === undefined ? [] : [{ name, value }],
            );

            for (const item of localStorage) secrets.add(item.value);

            return { origin, localStorage };
          },
          { background: true },
        ),
    );

    return { cookies, origins };
  });
};

/**
 * `state` set into the browser behind `http`: its cookies into the default context, then each
 * origin's local storage through a setup tab. Answers how many cookies and origins went in.
 */
export const restoreState = (
  http: string,
  state: StorageState,
): Promise<Answered<{ cookies: number; origins: number }>> => {
  const secrets = new Set<string>([
    ...state.cookies.map((c) => c.value),
    ...state.origins.flatMap((o) => o.localStorage.map((i) => i.value)),
  ]);
  const origins = state.origins.filter((o) => o.localStorage.length > 0);

  return withDevtools(http, secrets, async (dt) => {
    if (state.cookies.length > 0)
      await dt.call(Empty, 'Storage.setCookies', { cookies: state.cookies.map(cookieParam) });
    await pooled(origins, TABS_AT_ONCE, (o) =>
      setupTab(
        dt,
        o.origin,
        async (sessionId, storageId) => {
          for (const { name, value } of o.localStorage)
            await dt.call(
              Empty,
              'DOMStorage.setDOMStorageItem',
              { storageId, key: name, value },
              sessionId,
            );
        },
        { background: false },
      ),
    );

    return { cookies: state.cookies.length, origins: origins.length };
  });
};
