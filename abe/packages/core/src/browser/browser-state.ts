/**
 * A browser profile's sign-ins as they travel (#103 S3): a DevTools storage state (cookies, and
 * the local storage of the origins they belong to), read from the Mac's Chrome on the profile's
 * folder by `abe browser store`, kept as one secret of yours beside the logins
 * (`abe/<person>/browser/<name>`), and set into a fresh Chromium by `abe browser start` on a box
 * before it answers. Never the Chrome folder: macOS Chrome encrypts its cookies with the Keychain
 * (`.scratch/2.1/t103/report.md`). Carried: every cookie (HttpOnly, Secure, session ones) and
 * local storage; not sessionStorage, IndexedDB or anything bound to the device.
 */
import { z } from 'zod';
import { DEFAULT_PROFILE } from './browser-profiles';
import { utf8Bytes } from '../logins/logins';

/** A cookie as DevTools' `Storage.getCookies` answers it (fields beyond these kept as read). */
export const StateCookie = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  /** Seconds since the epoch; -1 (with `session`) for a session cookie. */
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  session: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']).optional(),
  sourcePort: z.number().int().optional(),
  partitionKey: z
    .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() })
    .optional(),
});
export type StateCookie = z.infer<typeof StateCookie>;

export const StateOrigin = z.object({
  /** `https://app.example.test` (scheme, host and a port other than the scheme's). */
  origin: z.string(),
  localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
});
export type StateOrigin = z.infer<typeof StateOrigin>;

/** What DevTools gave of a Chrome's sign-ins. */
export type SignIns = { cookies: StateCookie[]; origins: StateOrigin[] };

export const StorageState = z.object({
  v: z.literal(1),
  storedAt: z.iso.datetime(),
  cookies: z.array(StateCookie),
  origins: z.array(StateOrigin),
});
export type StorageState = z.infer<typeof StorageState>;

/** The most a stored state may be: Secrets Manager holds 64 KB, the rest is the margin. */
export const STATE_MAX_BYTES = 60_000;

/** A profile's secret, a sibling of the logins: `abe/<person>/browser/<name>`. */
export const browserSecret = (person: string, name: string): string =>
  `abe/${person}/browser/${name}`;

/** The prefix every browser secret of `person` starts with (Secrets Manager's name filter). */
export const browserSecretPrefix = (person: string): string => `abe/${person}/browser/`;

/** The `<person>` of a logins secret's name or ARN (`abe/ada/logins` → `ada`). */
export const personOfLogins = (secret: string): string | undefined => {
  const name = secret.startsWith('arn:')
    ? secret
        .replace(/^arn:[^:]+:secretsmanager:[^:]+:\d+:secret:/, '')
        .replace(/-[A-Za-z0-9]{6}$/, '')
    : secret;

  return /^abe\/([^/]+)\/logins$/.exec(name)?.[1];
};

/** `scheme://host[:port]` of an http(s) URL; `undefined` for anything else (about:, chrome:). */
export const webOrigin = (url: string): string | undefined => {
  const m = /^(https?):\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(url);

  if (m === null) return undefined;
  const scheme = (m[1] ?? '').toLowerCase();
  const host = (m[2] ?? '').toLowerCase();
  const plain = scheme === 'https' ? ':443' : ':80';

  return `${scheme}://${host.endsWith(plain) ? host.slice(0, -plain.length) : host}`;
};

/**
 * The origins whose local storage is read: each stored cookie's domain (`https://<domain>`, and
 * `http://` too when the cookie is not Secure) and every open tab's. DevTools cannot list every
 * origin holding local storage, so these are the ones a sign-in is likely to use.
 */
export const stateOrigins = (
  cookies: readonly Pick<StateCookie, 'domain' | 'secure'>[],
  tabs: readonly string[],
): string[] => {
  const out = new Set<string>();

  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '');

    if (host === '') continue;
    out.add(`https://${host}`);
    if (!c.secure) out.add(`http://${host}`);
  }
  for (const t of tabs) {
    const o = webOrigin(t);

    if (o !== undefined) out.add(o);
  }

  return [...out].sort();
};

/** The state as stored, dated `at`; origins with no local storage are left out. */
export const storageState = (signIns: SignIns, at: string): StorageState => ({
  v: 1,
  storedAt: at,
  cookies: signIns.cookies,
  origins: signIns.origins.filter((o) => o.localStorage.length > 0),
});

/** The state's text, or why it cannot be stored: too large, naming the biggest origins. */
export const stateText = (
  state: StorageState,
): { ok: true; text: string } | { ok: false; message: string } => {
  const text = JSON.stringify(state);
  const size = utf8Bytes(text);

  if (size <= STATE_MAX_BYTES) return { ok: true, text };
  const weight = new Map<string, number>();
  const add = (origin: string, n: number) => weight.set(origin, (weight.get(origin) ?? 0) + n);

  for (const c of state.cookies)
    add(`cookies of ${c.domain.replace(/^\./, '')}`, utf8Bytes(JSON.stringify(c)));
  for (const o of state.origins) add(`local storage of ${o.origin}`, utf8Bytes(JSON.stringify(o)));
  const biggest = [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([what, n]) => `${what} ${kb(n)}`);

  return {
    ok: false,
    message: `the sign-ins are ${kb(size)}, more than a secret holds (${kb(STATE_MAX_BYTES)}): ${biggest.join(', ')}`,
  };
};

const kb = (n: number) => `${Math.ceil(n / 1000)} KB`;

/** The state read back from its secret's text, or `undefined` when it is not one. */
export const readState = (text: string): StorageState | undefined => {
  try {
    const read = StorageState.safeParse(JSON.parse(text));

    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
};

/** A cookie as DevTools' `Storage.setCookies` takes it: a session cookie has no `expires`. */
export const cookieParam = (c: StateCookie): Record<string, unknown> => {
  const session = c.session === true || c.expires <= 0;

  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(session ? {} : { expires: c.expires }),
    ...(c.sameSite === undefined ? {} : { sameSite: c.sameSite }),
    ...(c.priority === undefined ? {} : { priority: c.priority }),
    ...(c.sourceScheme === undefined ? {} : { sourceScheme: c.sourceScheme }),
    ...(c.sourcePort === undefined ? {} : { sourcePort: c.sourcePort }),
    ...(c.partitionKey === undefined ? {} : { partitionKey: c.partitionKey }),
  };
};

/** `2 days ago`, `3 hours ago`, `just now`: how old a stored copy is. */
export const agoText = (at: string, now: number): string => {
  const ms = Math.max(0, now - Date.parse(at));
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];

  for (const [size, unit] of units) {
    const n = Math.floor(ms / size);

    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }

  return 'just now';
};

/** How to fix a profile with nothing stored: what the refusal names. */
export const storeHint = (name: string): string => `abe browser store ${name} locally`;

/**
 * Which profile a start in a session uses: the one asked for, else the session's (its run's, by
 * `--profile` at launch or `browser.default`). While its run verifies, Before and After use the
 * same one, so another is refused.
 */
export const startProfile = (o: {
  asked: string | undefined;
  session: string | undefined;
  verifying: boolean;
}): { ok: true; profile: string } | { ok: false; code: string; message: string } => {
  const own = o.session ?? DEFAULT_PROFILE;

  if (o.asked === undefined || o.asked === own) return { ok: true, profile: own };
  if (o.verifying)
    return {
      ok: false,
      code: 'profile-differs-from-before',
      message: `this run verifies in ${own}: Before and After use the same profile (abe browser start --profile ${own}, or none)`,
    };

  return { ok: true, profile: o.asked };
};

/** The verify report with its header naming the profile: `Browser profile: <name>` under its title. */
export const withProfileLine = (report: string, profile: string): string => {
  // An earlier line goes, with the blank line after it.
  const lines = report
    .split('\n')
    .filter(
      (l, i, all) =>
        !l.startsWith('Browser profile:') &&
        !(l === '' && all[i - 1]?.startsWith('Browser profile:')),
    );
  const title = lines.findIndex((l) => l.startsWith('# '));
  const line = `Browser profile: ${profile}`;

  if (title === -1) return [line, '', ...lines].join('\n');
  const rest = lines.slice(title + 1);

  return [...lines.slice(0, title + 1), '', line, ...(rest[0] === '' ? rest : ['', ...rest])].join(
    '\n',
  );
};

/** `abe browser open <name>`: the profile's Chrome on its folder, where you sign in. */
export const BrowserOpenData = z.object({
  name: z.string(),
  folder: z.string(),
  /** DevTools' HTTP endpoint on this Mac. */
  endpoint: z.string(),
  /** Started now (else the running one got the URLs). */
  started: z.boolean(),
  /** `--front` on a running one: brought to the front, no second window. */
  fronted: z.boolean().default(false),
});
export type BrowserOpenData = z.infer<typeof BrowserOpenData>;

const openedAs = (d: BrowserOpenData) => {
  if (d.started) return 'open';

  return d.fronted ? 'in front' : 'open already';
};

export const browserOpenText = (d: BrowserOpenData): string =>
  `${d.name}'s Chrome is ${openedAs(d)} on ${d.folder}: sign in, then abe browser store ${d.name}\n`;

/** `abe browser store <name>`: what was stored, never a value. */
export const BrowserStoreData = z.object({
  name: z.string(),
  secret: z.string(),
  storedAt: z.iso.datetime(),
  cookies: z.number().int().nonnegative(),
  /** The origins whose local storage was stored. */
  origins: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
});
export type BrowserStoreData = z.infer<typeof BrowserStoreData>;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const browserStoreText = (d: BrowserStoreData): string =>
  `stored ${d.name}'s sign-ins in ${d.secret}: ${plural(d.cookies, 'cookie')}, local storage of ${plural(d.origins.length, 'origin')} (${Math.ceil(d.bytes / 1000)} KB)\n`;

/** A page `abe browser open` takes: http, https or file (or a file's path), as 1.0's. */
export const isPageUrl = (url: string): boolean => /^(https?:\/\/|file:\/\/|\/)\S*$/.test(url);

/**
 * The profile a launch runs in: the one named (`--profile`), else `browser.default`, else the
 * built-in empty `default`. One no Layer has is refused, a default naming one too: never started
 * empty in its place.
 */
export const runProfile = (o: {
  profiles: readonly { name: string }[];
  fallback: string | null;
  asked: string | undefined;
}): { ok: true; name: string } | { ok: false; code: string; message: string } => {
  const name = o.asked ?? o.fallback ?? DEFAULT_PROFILE;

  if (name === DEFAULT_PROFILE || o.profiles.some((p) => p.name === name))
    return { ok: true, name };

  return {
    ok: false,
    code: 'no-profile',
    message:
      o.asked === undefined
        ? `browser.default names ${name}, which no Layer has: abe browser add ${name} --purpose …, or abe browser default none`
        : `${name} is no browser profile: abe browser list names them`,
  };
};
