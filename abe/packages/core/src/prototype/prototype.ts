/**
 * Prototypes (ADR 0018): a prototype session's app, run from its throwaway worktree by the
 * Verification pack's start script, with the prototype proxy in front of it. The proxy forwards
 * only to that app; nothing goes to the repo. The rules: ids, the default branch, the start
 * script's answer, the proxy's routing and the prototype's record.
 */
import { z } from 'zod';
import { DEFAULT_HOOKS } from '../repo-hooks';

export const PROTOTYPE_STATES = ['starting', 'live', 'failed', 'stopped'] as const;
export type PrototypeState = (typeof PROTOTYPE_STATES)[number];

/*
 * A prototype's start script is the repo's `prototype-start` hook (`abe/scripts/prototype-start`
 * unless `abe.yaml`'s `hooks` say): it starts the app in the background on `ABE_PORT_BASE`, waits
 * until it answers and prints the URL to open as its last line. Where a checkout has it, a
 * prototype starts by it, with the values of the Abe env file its `# abe-env:` line names; else by
 * the pack's `start` hook. Its stop is `prototype-stop`, for when stopping needs more than ending
 * what the start left running.
 */

/** How many of a start script's first lines are read for its `# abe-…:` lines. */
const SAYS_LINES = 20;

/**
 * What a prototype start script says of itself in its first lines: `# abe-env: dev|test` (the Abe
 * env file whose values it gets; dev when none) and `# abe-login: <KEY>…` (the env file's keys
 * naming the account a prototype signs in as, names only; none: no login).
 */
export const prototypeStartSays = (text: string): { env: 'dev' | 'test'; login: string[] } => {
  const lines = text.split('\n').slice(0, SAYS_LINES);
  const said = (name: string) =>
    lines
      .map((l) => new RegExp(`^#\\s*abe-${name}:\\s*(.*?)\\s*$`).exec(l)?.[1])
      .find((v) => v !== undefined);
  const login = (said('login') ?? '')
    .split(/[\s,]+/)
    .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));

  return { env: said('env') === 'test' ? 'test' : 'dev', login };
};

/** How many of the start script's last lines a failed start shows. */
export const FAILED_LINES = 20;

/**
 * What every HTML answer of the proxy carries in place of the app's own policy: the page reaches
 * only the proxy (its origin is the page's `'self'`), and the prototype's inline code runs.
 */
export const PROTOTYPE_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "form-action 'self'; base-uri 'self'; frame-ancestors *";

/**
 * The variables a start script gets from `serve`'s environment, and only these: where tools are,
 * who you are, the locale and the terminal. No token, no credentials, and never `serve`'s own
 * `DATABASE_URL` (#349): each prototype and session gets a database of its own.
 */
export const APP_ENV = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
] as const;

/** A start script's environment: `APP_ENV` of `serve`'s, then the prototype's own. */
export const appEnv = (
  env: Readonly<Record<string, string | undefined>>,
  own: Readonly<Record<string, string>>,
): Record<string, string> => {
  const picked: Record<string, string> = {};

  for (const name of APP_ENV) {
    const value = env[name];

    if (value !== undefined) picked[name] = value;
  }

  return { ...picked, ...own };
};

const Count = z.number().int().positive();
const At = z.iso.datetime();
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const PrototypeId = z.string().regex(/^proto-[0-9a-f]{6}$/);

/** A new prototype's id from 3 random bytes as hex. */
export const prototypeId = (suffix: string): string => `proto-${suffix}`;

// ---------------------------------------------------------------------------------------------
// The default branch and the app's address

/**
 * The refs tried for the default branch's newest commit, in order: what `origin/HEAD` points at
 * (as the checkout last heard it; nothing is fetched), then a local `main`, then `master`.
 */
export const defaultRefs = (originHead: string | null): string[] => [
  ...(originHead === null ? [] : [originHead]),
  'main',
  'master',
];

/** `origin/main` → `main`: the branch a ref names. */
export const refBranch = (ref: string): string => ref.replace(/^(refs\/remotes\/)?origin\//, '');

/** The last `n` non-empty lines of `text`. */
export const lastLines = (text: string, n = FAILED_LINES): string[] =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(-n);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const ORIGIN = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i;
const DEFAULT_PORT: Readonly<Record<string, string>> = { http: '80', https: '443' };

/** An http(s) URL's origin (`http://127.0.0.1:5173`) and its host (`127.0.0.1:5173`). */
export const originOf = (
  url: string,
): { origin: string; host: string; hostname: string } | undefined => {
  const m = ORIGIN.exec(url.trim());

  if (m === null) return undefined;
  const scheme = (m[1] ?? '').toLowerCase();
  const hostname = (m[2] ?? '').toLowerCase();
  const port =
    m[3] === undefined || m[3] === DEFAULT_PORT[scheme] ? '' : `:${String(Number(m[3]))}`;

  return { origin: `${scheme}://${hostname}${port}`, host: `${hostname}${port}`, hostname };
};

/** The app's origin from one line of the start script: `http://127.0.0.1:5173` or a bare port. */
export const appOrigin = (
  line: string,
): { ok: true; origin: string } | { ok: false; why: string } => {
  const text = line.trim();
  const parsed = originOf(/^\d{1,5}$/.test(text) ? `http://127.0.0.1:${text}` : text);

  if (parsed === undefined)
    return {
      ok: false,
      why: `its last line is no http(s) URL or port: ${text === '' ? '(empty)' : text}`,
    };
  // Never the real site (PT1): the app runs in your environment, on its loopback.
  if (!LOOPBACK.has(parsed.hostname))
    return { ok: false, why: `${text} is not on this machine (127.0.0.1, localhost)` };

  return { ok: true, origin: parsed.origin };
};

/**
 * A start script's run: its exit and output; `timedOut` when it was killed for taking too long;
 * `ms` how long it ran.
 */
export type StartRun = {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  ms?: number;
};

/** How long a start script may take: a first `npm ci` and a dev server's first build. */
export const START_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a start script has to end once its stdout's last line is its app's address: one that
 * goes on (a `wait` on its server) is killed then, never left starting until `START_TIMEOUT_MS`.
 */
export const PRINTED_GRACE_MS = 20_000;

/** Whether a start's stdout so far ends in its app's address (`startAnswer`'s). */
export const printedAddress = (stdout: string): boolean =>
  appOrigin(lastLines(stdout, 1)[0] ?? '').ok;

/** Why a start script killed for not ending fails. */
export const startTimeoutWhy = (ms: number): string =>
  `must print its URL and exit; it ran ${String(Math.round(ms / 1000))}s`;

/**
 * What a start script's run means: the app's origin (its stdout's last line), or why the start
 * failed with the script's last lines.
 */
export const startAnswer = (
  ran: StartRun,
  script: string = DEFAULT_HOOKS['prototype-start'],
): { ok: true; origin: string } | { ok: false; message: string } => {
  const tail = lastLines(`${ran.stdout}\n${ran.stderr}`);
  const failed = (why: string) => ({
    ok: false as const,
    message: `${script} ${why}${tail.length === 0 ? '' : `; its last lines:\n${tail.join('\n')}`}`,
  });

  if (ran.timedOut === true) return failed(startTimeoutWhy(ran.ms ?? START_TIMEOUT_MS));
  if (ran.exit !== 0) return failed(`exited ${ran.exit}`);
  const origin = appOrigin(lastLines(ran.stdout, 1)[0] ?? '');

  return origin.ok ? origin : failed(`printed no app address: ${origin.why}`);
};

// ---------------------------------------------------------------------------------------------
// Screenshots

/**
 * A screenshot of the prototype kept with it (#82): a PNG in `<id>/screenshots/<file>` and what
 * it shows. Make card uploads them with the card's reference.
 */
export const Screenshot = z.object({
  n: Count,
  /** Its file in the prototype's `screenshots` folder: `<n>.png`. */
  file: z.string().regex(/^[0-9]+\.png$/),
  what: z.string().min(1),
  at: At,
});
export type Screenshot = z.infer<typeof Screenshot>;

/** A screenshot's file name. */
export const screenshotFile = (n: number): string => `${n}.png`;

/** PNG's first eight bytes: what a screenshot file starts with. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (bytes: Uint8Array): boolean => PNG.every((b, i) => bytes[i] === b);

// ---------------------------------------------------------------------------------------------
// A prototype session's

/**
 * A prototype in real code (`abe prototype start`): its Claude Code session, its throwaway
 * worktree on `proto/<card or id>-<slug>` (no upstream, a pre-push hook that refuses) and what
 * make-card did (`spec`: a spec issue opened before #351). The app runs from the worktree; there
 * are no numbered changes or versions.
 */
export const CodePrototype = z.object({
  session: z.string(),
  branch: z.string(),
  worktree: z.string(),
  /**
   * The box it runs on (`serve.target` cloud): its workspace keyed by the prototype's id, its app
   * reached through a port forward to this Mac; null: on this Mac.
   */
  box: z.string().nullable().default(null),
  spec: z.object({ repo: z.string(), number: Count, url: z.string() }).nullable().default(null),
  /** The card's version make-card kept in the org store, once it did: a retry makes no other. */
  stored: Count.nullable().default(null),
  /** Before 3.3: the card's comment naming the prototype was written. */
  commented: z.boolean().default(false),
  /** Before 3.3: the card's run To the Factory launched. */
  sent: z.string().nullable().default(null),
  /** The card make-card made, once it did: a retry makes no other. */
  made: Count.nullable().default(null),
  /** Done with: discarded, or superseded by a new session on its worktree. */
  ended: z.boolean().default(false),
});
export type CodePrototype = z.infer<typeof CodePrototype>;

// ---------------------------------------------------------------------------------------------
// The prototype as kept

/**
 * A prototype's database (#349): its name, whether its repo's hook or Abe's Mac database gave it,
 * and whether Abe seeded it (the repo's `seed` hook on a database just made). Kept while it is
 * stopped; dropped when it is discarded.
 */
export const PrototypeDatabase = z.object({
  name: z.string(),
  by: z.enum(['hook', 'mac']),
  seeded: z.boolean(),
});
export type PrototypeDatabase = z.infer<typeof PrototypeDatabase>;

/** Where a start is (#349): its database (seeded when just made), then the start script. */
export const PROTOTYPE_STEPS = ['database', 'start'] as const;
export type PrototypeStep = (typeof PROTOTYPE_STEPS)[number];

/** `<state>/prototypes/<id>/meta.json`. */
export const PrototypeMeta = z.object({
  id: PrototypeId,
  card: Count.nullable(),
  /** The checkout's top folder. */
  repo: z.string(),
  /** Its `origin` remote: the org store names the repo by it. */
  remote: z.string().nullable(),
  branch: z.string(),
  commit: Sha,
  state: z.enum(PROTOTYPE_STATES),
  since: At,
  /** The proxy: what a browser opens. */
  url: z.string().nullable(),
  /** The app behind it. */
  app: z.string().nullable(),
  /** Why the last start failed (`failed`); null otherwise. */
  reason: z.string().nullable().default(null),
  /** Its screenshots, by number (#82). */
  screenshots: z.array(Screenshot).default([]),
  /** Its session and worktree; null for one of injected changes from before 3.3. */
  code: CodePrototype.nullable().default(null),
  /** Its database, once it had one (#349); null for a repo that needs none. */
  database: PrototypeDatabase.nullable().default(null),
  /** Its port base (`ABE_PORT_BASE`), asked for again on its next start (#349). */
  portBase: z.number().int().positive().nullable().default(null),
  /** While `starting`: the step it is at (#349). */
  step: z.enum(PROTOTYPE_STEPS).nullable().default(null),
  /**
   * The repo's fixed ports its app holds while it runs (ADR 0039: started the normal way on them,
   * no proxy); empty: behind the proxy, or none held.
   */
  ports: z.array(z.number().int().positive()).default([]),
});
export type PrototypeMeta = z.infer<typeof PrototypeMeta>;

// ---------------------------------------------------------------------------------------------
// The proxy

/** Whether an answer's content type is HTML (the ones the proxy gives its policy). */
export const isHtml = (contentType: string | null): boolean =>
  contentType !== null && /^\s*text\/html\b/i.test(contentType);

/** A request as the proxy got it: `host` is the one it was sent to (Host, or an absolute URL's). */
export type ProxyRequest = { method: string; host: string; path: string };

export type ProxyRoute = { kind: 'forward'; url: string } | { kind: 'refuse'; reason: string };

/**
 * Where a request goes. Only two hosts are served: the proxy's own (`own`, as a browser types it)
 * and the app's (a browser using the proxy as its HTTP proxy). Anything else, and every tunnel,
 * is refused (403).
 */
export const routeRequest = (
  req: ProxyRequest,
  p: { own: readonly string[]; app: string },
): ProxyRoute => {
  const host = req.host.toLowerCase();
  const app = originOf(p.app) ?? { origin: p.app, host: '' };

  if (req.method.toUpperCase() === 'CONNECT')
    return { kind: 'refuse', reason: `a tunnel to ${host} (only the app is served)` };
  if (!p.own.includes(host) && host !== app.host)
    return { kind: 'refuse', reason: `${host === '' ? 'no host' : host} is not the app` };
  return { kind: 'forward', url: `${app.origin}${req.path}` };
};

/**
 * What the proxy does with an app's redirect: one within the app stays on the proxy (rewritten
 * to it), a relative one is kept, one to anywhere else is refused (the browser would follow it
 * outside the proxy).
 */
export const redirectOf = (
  location: string,
  p: { app: string; own: string },
):
  { kind: 'keep' } | { kind: 'rewrite'; location: string } | { kind: 'refuse'; reason: string } => {
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(location)) return { kind: 'keep' };
  const full = location.trim().startsWith('//') ? `http:${location.trim()}` : location.trim();
  const target = originOf(full);
  const app = originOf(p.app);

  if (target === undefined || target.origin !== app?.origin)
    return { kind: 'refuse', reason: `the app redirects to ${location}, which is not the app` };
  const rest = full.replace(/^[a-z]+:\/\/[^/?#]+/i, '');

  return { kind: 'rewrite', location: `${p.own}${rest}` };
};

/** One refused request, as `refused.jsonl` and `prototype.refused` keep it. */
export type RefusedRequest = { method: string; host: string; path: string; reason: string };

// ---------------------------------------------------------------------------------------------
// The commands' results

export const PrototypeData = z.object({
  id: PrototypeId,
  card: Count.nullable(),
  repo: z.string(),
  branch: z.string(),
  commit: Sha,
  state: z.enum(PROTOTYPE_STATES),
  since: At,
  /** The proxy, what a browser opens; `null` while it does not run. */
  url: z.string().nullable(),
  app: z.string().nullable(),
  /** Why its start failed, while `failed`. */
  reason: z.string().nullable().default(null),
  /** A developer's prototype in real code (#83): its session and worktree; null otherwise. */
  code: CodePrototype.nullable().default(null),
  /** Its database (#349): name, from the hook or the Mac database, seeded; null for none. */
  database: PrototypeDatabase.nullable().default(null),
  /** While `starting`: the step it is at (#349); null otherwise. */
  step: z.enum(PROTOTYPE_STEPS).nullable().default(null),
  /** What it tries, in its words (its session's title without `Prototype · `); null: not known. */
  title: z.string().nullable().default(null),
  /** Its newest screenshot's file (absolute): a stopped one's Preview shows it; null: none. */
  shot: z.string().nullable().default(null),
  /**
   * The repo's fixed ports its app holds while it runs (ADR 0039: no proxy, `url` the app's own);
   * empty: behind the proxy, on a box, or none held. The Preview opens such an app as a browser
   * would (ADR 0041).
   */
  ports: z.array(z.number().int().positive()).default([]),
});
export type PrototypeData = z.infer<typeof PrototypeData>;

export const prototypeData = (
  m: PrototypeMeta,
  more: { title?: string | null; shot?: string | null } = {},
): PrototypeData => ({
  id: m.id,
  card: m.card,
  repo: m.repo,
  branch: m.branch,
  commit: m.commit,
  state: m.state,
  since: m.since,
  url: m.url,
  app: m.app,
  reason: m.state === 'failed' ? m.reason : null,
  code: m.code,
  database: m.database,
  step: m.state === 'starting' ? m.step : null,
  title: more.title ?? null,
  shot: more.shot ?? null,
  ports: m.ports,
});

/** A session title's words: `Prototype · cart badge` → `cart badge`; a card's (`#4`) → null. */
export const prototypeWords = (title: string | null | undefined): string | null => {
  const words = (title ?? '').replace(/^Prototype · /, '').trim();

  return words === '' || /^#\d+$/.test(words) ? null : words;
};

/** The newest screenshot kept, by number. */
export const newestShot = (shots: readonly Screenshot[]): Screenshot | undefined =>
  shots.reduce<Screenshot | undefined>((a, b) => (a === undefined || b.n > a.n ? b : a), undefined);

/** How many of the app's log lines `prototype show` gives. */
export const LOG_LINES = 400;

/**
 * `prototype show`: what a prototype's Code and Logs pages draw. Its diff by file (paths relative
 * to the worktree, `cut` files past the cap only counted), its screenshots (files absolute), the
 * app's output (the start script's, its last `LOG_LINES`) and what the proxy refused.
 */
export const PrototypeShowData = z.object({
  id: PrototypeId,
  files: z.array(
    z.object({
      path: z.string(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      /** Its hunks' lines, a `@@` line before each hunk's. */
      lines: z.array(z.string()),
    }),
  ),
  cut: z.number().int().nonnegative(),
  /** Why there is no diff (a box's not reached); null: read. */
  noDiff: z.string().nullable(),
  screenshots: z.array(z.object({ n: Count, what: z.string(), path: z.string() })),
  log: z.array(z.string()),
  refused: z.array(
    z.object({ at: z.string(), method: z.string(), host: z.string(), reason: z.string() }),
  ),
});
export type PrototypeShowData = z.infer<typeof PrototypeShowData>;

export const prototypeShowText = (d: PrototypeShowData): string =>
  [
    `${d.id}: ${d.files.length + d.cut} files changed`,
    ...d.files.map((f) => `  ${f.path} +${f.added} −${f.removed}`),
    `${d.screenshots.length} screenshots, ${d.refused.length} refused`,
    ...(d.log.length === 0 ? [] : ['', ...d.log]),
    '',
  ].join('\n');

export const PrototypeListData = z.object({ prototypes: z.array(PrototypeData) });
export type PrototypeListData = z.infer<typeof PrototypeListData>;

const short = (sha: string) => sha.slice(0, 7);

export const prototypeText = (p: PrototypeData): string => {
  const where = p.url === null ? '' : ` at ${p.url}`;
  const why = p.state === 'failed' && p.reason !== null ? `: ${p.reason}` : '';

  const what =
    p.code === null
      ? 'from before 3.3'
      : `real code in ${p.code.branch}, session ${p.code.session}`;

  return `${p.id} ${p.state}${where} (${p.branch} ${short(p.commit)}; ${what})${why}\n`;
};

export const prototypeListText = (l: PrototypeListData): string =>
  l.prototypes.length === 0 ? 'no prototypes\n' : l.prototypes.map(prototypeText).join('');

/** `prototype screenshot add`: the screenshot kept, and every screenshot the prototype has. */
export const ScreenshotData = z.object({
  id: PrototypeId,
  screenshot: Screenshot,
  screenshots: z.array(Screenshot),
  /** Its file in your environment. */
  path: z.string(),
});
export type ScreenshotData = z.infer<typeof ScreenshotData>;

export const screenshotAddText = (d: ScreenshotData): string =>
  `screenshot ${d.screenshot.n} on ${d.id}: ${d.screenshot.what}\n${d.path}\n`;
