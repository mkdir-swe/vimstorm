/**
 * The prototype proxy on 127.0.0.1: one origin per prototype in front of its app. Every request
 * goes where core's `routeRequest` says: the app (HTML answers with `PROTOTYPE_CSP`, a redirect
 * by `redirectOf`), or 403. IO only; the rules
 * are core's. A WebSocket routed to the app (a dev server's live reload) is passed through: the
 * app's socket is opened first, with the protocols the page asked, and the page's answered with
 * the one the app chose.
 */
import {
  isHtml,
  type PrototypeProxy,
  PROTOTYPE_CSP,
  redirectOf,
  type RefusedRequest,
  routeRequest,
} from '@abe/core';

/** Headers that belong to one hop, never passed on. */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Dropped from the app's answers: fetch has decoded the body, and its length may change. */
const DECODED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const NO_BODY = new Set([101, 204, 205, 304]);

type Route = { app: string };

/** One page socket's other end: the app's, and what it said before the page's socket opened. */
type Pipe = { app: WebSocket; early: (string | ArrayBuffer)[] };

/** A close code one end saw as one the other may be sent (1005, 1006, 1015 are never sent). */
const sendable = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;

const isUpgrade = (req: Request) => req.headers.get('upgrade')?.toLowerCase() === 'websocket';

/** The app's socket at `url` (`http` → `ws`), open, or why not (within 10 s). */
const openAppSocket = (url: string, protocols: string[]): Promise<Pipe | string> =>
  new Promise((done) => {
    const app = new WebSocket(url.replace(/^http/i, 'ws'), protocols);
    const early: (string | ArrayBuffer)[] = [];
    const late = setTimeout(() => {
      done('the app did not answer the WebSocket');
      app.close();
    }, 10_000);

    app.binaryType = 'arraybuffer';
    app.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      early.push(e.data);
    };
    app.onopen = () => {
      clearTimeout(late);
      done({ app, early });
    };
    app.onerror = () => {
      clearTimeout(late);
      done('the app refused the WebSocket');
    };
  });

/** `state.route` is read on every request, so a `set` takes effect on the next one. */
type Open = { url: string; state: { route: Route }; stop: () => Promise<void> };

const requestHeaders = (from: Headers) => {
  const headers = new Headers();

  // And the ones `Connection` names as this hop's.
  const named = new Set(
    (from.get('connection') ?? '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== ''),
  );

  for (const [name, value] of from)
    if (!HOP.has(name) && !named.has(name)) headers.set(name, value);
  // Plain bodies, so an HTML answer can be read and changed.
  headers.set('accept-encoding', 'identity');

  return headers;
};

const answerHeaders = (from: Headers) => {
  const headers = new Headers();

  for (const [name, value] of from) if (!DECODED.has(name)) headers.append(name, value);

  return headers;
};

const refusedAnswer = (reason: string) =>
  new Response(`refused by the prototype proxy: ${reason}\n`, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

export const localPrototypeProxy = (): PrototypeProxy => {
  const open = new Map<string, Open>();

  const start = (first: Route, refused: (r: RefusedRequest) => void): Open => {
    const state: { route: Route } = { route: first };
    const server = Bun.serve<Pipe>({
      hostname: '127.0.0.1',
      port: 0,
      websocket: {
        open: (page) => {
          const { app, early } = page.data;

          for (const m of early.splice(0)) page.send(m);
          if (app.readyState !== WebSocket.OPEN) {
            page.close();

            return;
          }
          // Each end's messages to the other, and a close of the app's closes the page's.
          app.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
            page.send(e.data);
          };
          app.onclose = (e) => {
            page.close(sendable(e.code), e.reason);
          };
        },
        message: (page, m) => {
          if (page.data.app.readyState === WebSocket.OPEN) page.data.app.send(m);
        },
        close: (page, code, reason) => {
          const { app } = page.data;

          if (app.readyState === WebSocket.OPEN || app.readyState === WebSocket.CONNECTING)
            app.close(sendable(code), reason);
        },
      },
      fetch: async (req) => {
        const own = `127.0.0.1:${String(server.port)}`;
        const { app } = state.route;
        let url: URL;

        try {
          url = new URL(req.url);
        } catch {
          url = new URL(`http://${req.headers.get('host') ?? 'invalid'}/`);
        }
        // The request-target's authority, which Bun builds from Host only for an origin-form one
        // (RFC 9112 §3.2.2): an absolute URL to elsewhere is refused whatever its Host says.
        const host = url.host;
        const path = req.method === 'CONNECT' ? '' : `${url.pathname}${url.search}`;
        const route = routeRequest(
          { method: req.method, host, path },
          { own: [own, `localhost:${String(server.port)}`], app },
        );

        if (route.kind === 'refuse') {
          refused({ method: req.method, host, path, reason: route.reason });

          return refusedAnswer(route.reason);
        }
        if (isUpgrade(req)) {
          const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p !== '');
          const pipe = await openAppSocket(route.url, protocols);

          if (typeof pipe === 'string')
            return new Response(`${pipe}\n`, {
              status: 502,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            });
          const chosen = pipe.app.protocol;
          const upgraded = server.upgrade(req, {
            data: pipe,
            ...(chosen === '' ? {} : { headers: { 'sec-websocket-protocol': chosen } }),
          });

          if (upgraded) return undefined;
          pipe.app.close();

          return new Response('not a WebSocket request\n', { status: 400 });
        }
        let answer: Response;

        try {
          answer = await fetch(route.url, {
            method: req.method,
            headers: requestHeaders(req.headers),
            ...(req.method === 'GET' || req.method === 'HEAD'
              ? {}
              : { body: await req.arrayBuffer() }),
            redirect: 'manual',
          });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);

          return new Response(`the app does not answer: ${why}\n`, {
            status: 502,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
        const headers = answerHeaders(answer.headers);
        const location = headers.get('location');

        if (location !== null) {
          const redirect = redirectOf(location, { app, own: `http://${own}` });

          if (redirect.kind === 'refuse') {
            refused({ method: req.method, host, path, reason: redirect.reason });

            return refusedAnswer(redirect.reason);
          }
          // A redirect within the app stays on the proxy.
          if (redirect.kind === 'rewrite') headers.set('location', redirect.location);
        }

        if (!isHtml(answer.headers.get('content-type')) || req.method === 'HEAD')
          return new Response(NO_BODY.has(answer.status) ? null : answer.body, {
            status: answer.status,
            headers,
          });
        const html = await answer.text();

        headers.set('content-security-policy', PROTOTYPE_CSP);
        headers.delete('content-security-policy-report-only');
        headers.delete('etag');
        headers.delete('last-modified');
        headers.set('cache-control', 'no-store');

        return new Response(html, { status: answer.status, headers });
      },
    });

    return {
      url: `http://127.0.0.1:${String(server.port)}`,
      state,
      stop: () => server.stop(true),
    };
  };

  return {
    open: (p) => {
      const known = open.get(p.id);

      if (known !== undefined) {
        known.state.route = { app: p.app };

        return Promise.resolve({ url: known.url });
      }
      const started = start({ app: p.app }, p.refused);

      open.set(p.id, started);

      return Promise.resolve({ url: started.url });
    },
    close: async (id) => {
      const known = open.get(id);

      open.delete(id);
      await known?.stop();
    },
  };
};
