/**
 * Sheets served on 127.0.0.1: one origin (port) per page, answering that page at one secret path
 * with the headers core gives, and 404 for everything else. Opening the same key again answers
 * the same URL. IO only; the policy is core's (`SHEET_HEADERS`).
 */
import { randomBytes } from 'node:crypto';
import { type SheetHost } from '@abe/core';

type Hosted = { url: string; stop: () => Promise<void> };

export const localSheetHost = (): SheetHost => {
  const hosted = new Map<string, Promise<Hosted>>();

  const start = (html: Uint8Array, headers: Readonly<Record<string, string>>): Hosted => {
    const path = `/${randomBytes(16).toString('hex')}`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        const ok =
          url.pathname === path &&
          url.search === '' &&
          (req.method === 'GET' || req.method === 'HEAD');

        return ok
          ? new Response(req.method === 'HEAD' ? null : html, {
              headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
            })
          : new Response(null, { status: 404, headers });
      },
    });

    return {
      url: `http://127.0.0.1:${server.port}${path}`,
      stop: () => server.stop(true),
    };
  };

  return {
    open: async (page) => {
      let h = hosted.get(page.key);

      if (h === undefined) {
        h = Promise.resolve(start(page.html, page.headers));
        hosted.set(page.key, h);
      }

      return { url: (await h).url };
    },
    close: async () => {
      const all = [...hosted.values()];

      hosted.clear();
      await Promise.all(all.map(async (h) => (await h).stop()));
    },
  };
};
