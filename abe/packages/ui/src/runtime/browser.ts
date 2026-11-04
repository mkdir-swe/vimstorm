/**
 * The browser view (ticket #79; DS 2.0 BrowserView, its sheet state): a native WKWebView the
 * shell places in the node's slot, under a bar with its title, address, version and badges. Its
 * type and schema live here; `components.ts` adds it to the closed set.
 *
 * The shell's rule for it (`app/src/factory/pages`): one web view per `key`, kept across trees
 * while one holds it, loading `url` and nothing else. In `sheet` mode (the default) every request
 * and navigation but that URL itself is blocked (a content rule list and a navigation-policy
 * delegate, beside the page's own CSP); in `app` mode (a prototype's proxy) everything but that
 * URL's origin and its WebSockets (a dev server's live reload). `open` mode (ADR 0041: the person's
 * own app on its fixed ports, never an agent's page) is a browser: no rule list, any http(s)
 * navigation (its backend on another port, its sign-in provider and back), its cookies kept on
 * disk per origin (signed in once), a popup loaded in the same page. Keys go to the page only while
 * `focused`; Esc in the page gives them back to the screen. What the page did comes back as
 * `browser` frames (`BrowserEvent`): loaded, blocked, focus, failed.
 */
import { z } from 'zod';
import type { Node } from './components';

export type BrowserMode = 'sheet' | 'app' | 'open';

export type BrowserView = {
  kind: 'BrowserView';
  id?: string | undefined;
  props: {
    /** One web view per key: the same key across trees is the same page. */
    key: string;
    /** What the view loads (`abe sheet open`'s URL). */
    url: string;
    /**
     * `sheet` (absent): only that URL; `app`: that URL's origin (a prototype's proxy); `open`:
     * anywhere over http(s), as a browser (a prototype's app on its fixed ports).
     */
    mode?: BrowserMode | undefined;
    /** No bar: the screen draws its own (the prototype's Preview, its URL bar). */
    bare?: boolean | undefined;
    /** A change loads the same URL again (Reload). */
    reload?: number | undefined;
    /** The bar's first word: `Sheet`. */
    title: string;
    /** The page's title. */
    sub?: string | undefined;
    /** `sheet://4/cart-totals-a1b2c3`. */
    address?: string | undefined;
    /** ` · v2` after the address. */
    version?: number | undefined;
    /** Drawn joined with ` · `: `yours`, `sandboxed`, `no network`, `attached`. */
    badges?: string[] | undefined;
    /** After the badges: `⌘⏎ Attach to card`. */
    action?: { keys: string; label: string } | undefined;
    /** The page has the keyboard. */
    focused?: boolean | undefined;
  };
};

export type BrowserNode = BrowserView;

export const BROWSER_KINDS = ['BrowserView'] as const;

/** What the page did, as the shell tells it (the app's `browser` frame). */
export const BrowserEvent = z.discriminatedUnion('kind', [
  /** The page finished loading. */
  z.strictObject({ kind: z.literal('loaded'), url: z.string() }),
  /** A request or navigation the shell blocked: what it was (`fetch`, `img`, `navigation` …). */
  z.strictObject({ kind: z.literal('blocked'), url: z.string(), what: z.string() }),
  /** The page took the keyboard (a click in it) or gave it back (Esc). */
  z.strictObject({ kind: z.literal('focus'), focused: z.boolean() }),
  /** It could not load (its rules did not compile, its origin is gone). */
  z.strictObject({ kind: z.literal('failed'), message: z.string() }),
]);
export type BrowserEvent = z.infer<typeof BrowserEvent>;

/** The schema, built on the set's own primitives (`components.ts` calls this). */
export const browserSchemas = (d: { nodeId: z.ZodString }) =>
  [
    z.strictObject({
      kind: z.literal('BrowserView'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        key: z.string().min(1),
        url: z.url(),
        mode: z.enum(['sheet', 'app', 'open']).optional(),
        bare: z.boolean().optional(),
        reload: z.number().int().nonnegative().optional(),
        title: z.string(),
        sub: z.string().optional(),
        address: z.string().optional(),
        version: z.number().int().positive().optional(),
        badges: z.array(z.string()).optional(),
        action: z.strictObject({ keys: z.string(), label: z.string() }).optional(),
        focused: z.boolean().optional(),
      }),
    }),
  ] as const;

export const isBrowserView = (n: Node): n is BrowserView => n.kind === 'BrowserView';
