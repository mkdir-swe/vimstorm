/**
 * Factory install's gate (#22, story 42): the app answers on localhost from the checkout, and
 * every backend it is pointed at is local, a shared test environment or a provider's sandbox,
 * never prod. Pure rules: each env key's value is classified here; serve reads the files and
 * asks the URL. A value never leaves serve: what the gate keeps of one is its host.
 */
import { z } from 'zod';
import { runLoads } from './install-run-loads';
import { DEFAULT_HOOKS } from '../repo-hooks';

export { codeImports, ENV_FILES, runEntries } from './install-run-loads';

/** What an env key points the app at. `none`: no backend (a flag, a name, a port). */
export const TARGET_CLASSES = [
  'local',
  'test',
  'sandbox',
  'prod',
  /** Prod, and the person said the app only reads from it (`--read-only-host`). */
  'read-only',
  'unknown',
  'missing',
  'none',
] as const;
export const TargetClass = z.enum(TARGET_CLASSES);
export type TargetClass = z.infer<typeof TargetClass>;

/** How a backend the gate lets through is reached, as the install page lists it (story 43). */
export const REACHED: Readonly<Record<'local' | 'test' | 'sandbox' | 'read-only', string>> = {
  local: 'on this machine',
  test: 'a shared test environment',
  sandbox: "a provider's sandbox",
  'read-only': 'prod, read-only use',
};

/** Why a host the person answered for passes: a test backend, or prod read only. */
const SAID_TEST = 'you said it is a test backend';
const SAID_READ_ONLY = 'you said the app only reads from it';

export const Backend = z.object({
  key: z.string(),
  /** The host the value names (no user, password or path), or a key's kind (`stripe key`). */
  target: z.string(),
  class: TargetClass,
  /** Why it is that class, in words. */
  why: z.string(),
  /** Which file gave the value: the example, or the person's own gitignored env file. */
  from: z.string(),
});
export type Backend = z.infer<typeof Backend>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);
const PROD_WORDS = ['prod', 'production', 'prd', 'live'];
const TEST_WORDS = ['test', 'testing', 'staging', 'stage', 'stg', 'dev', 'qa', 'uat', 'preview'];
const SANDBOX_WORDS = ['sandbox'];

/** Keys whose value is a host even without a scheme. */
const HOST_KEY = /(^|_)(HOST|HOSTNAME|SERVER|ENDPOINT|DOMAIN)$/;

/** Provider keys whose prefix says the mode (Stripe's and the like). */
const KEY_PREFIXES: readonly { re: RegExp; class: 'prod' | 'sandbox'; target: string }[] = [
  { re: /^(sk|pk|rk)_live_/, class: 'prod', target: 'stripe live key' },
  { re: /^(sk|pk|rk)_test_/, class: 'sandbox', target: 'stripe test key' },
  { re: /^whsec_live_/, class: 'prod', target: 'stripe live webhook secret' },
];

/** `scheme://[user[:pass]@]host[:port][/path]`, or a bare `host[:port]`. */
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*)(?::\d+)?([^?#]*)/i;
const HOST_RE = /^(\[[^\]]+\]|[a-z0-9.-]+)(?::\d+)?$/i;

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');

const hits = (words: readonly string[], ts: readonly string[]) => ts.find((t) => words.includes(t));

/**
 * Whether a name says prod (`prod`, `shop-production`, `prod-readonly`): a prod word, or an
 * environment `prodEnvironments` names, as one of its words.
 */
export const namesProd = (name: string, prod: readonly string[] = []): boolean =>
  hits([...PROD_WORDS, ...prod.map((p) => p.toLowerCase())], tokens(name)) !== undefined;

const bareHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '');

/** This Mac itself: where the app must answer. */
const isLoopback = (host: string): boolean => {
  const h = bareHost(host);

  return LOCAL_HOSTS.has(h) || h.startsWith('127.') || h.endsWith('.localhost');
};

/** This Mac or a container beside the app. */
const isLocalHost = (host: string): boolean => {
  const h = bareHost(host);

  return (
    isLoopback(h) ||
    h.endsWith('.local') ||
    // a compose service (`db`, `redis`): one label, no dot
    /^[a-z][a-z0-9-]*$/.test(h)
  );
};

export type Classified = { class: TargetClass; target: string; why: string };

/**
 * One env value's class. A host on this Mac is local whatever it is named; then the person's own
 * answer, whatever the host's words say: `readOnlyHosts` (`--read-only-host`, the repo's
 * `gate.readOnlyHosts`) is `read-only`, `testHosts` (`--test-host`, `gate.testHosts`) `test`.
 * Else `prod` wins over anything that says test: a prod word in the host, the path (`shop_prod`)
 * or the key, or an environment `prodEnvironments` names.
 */
export const classifyValue = (
  key: string,
  value: string | undefined,
  o: {
    prod?: readonly string[];
    testHosts?: readonly string[];
    readOnlyHosts?: readonly string[];
  } = {},
): Classified => {
  const v = value?.trim() ?? '';

  if (v === '') return { class: 'missing', target: '', why: 'no value in any env file' };
  const prodWords = [...PROD_WORDS, ...(o.prod ?? []).map((p) => p.toLowerCase())];
  const keyed = KEY_PREFIXES.find((p) => p.re.test(v));

  if (keyed !== undefined)
    return {
      class: keyed.class,
      target: keyed.target,
      why: `the key's prefix says ${keyed.class}`,
    };
  const file = /^(file|sqlite):/i.exec(v)?.[1]?.toLowerCase();

  if (file !== undefined)
    return { class: 'local', target: `${file} file`, why: 'a file on this machine' };
  const url = URL_RE.exec(v);
  const bare = url === null && HOST_KEY.test(key) ? HOST_RE.exec(v) : null;

  if (url === null && bare === null) return { class: 'none', target: '', why: 'not a backend' };
  const host = (url?.[2] ?? bare?.[1] ?? '').toLowerCase();
  const path = url?.[3] ?? '';

  if (host === '') return { class: 'none', target: '', why: 'not a backend' };
  if (isLocalHost(host)) return { class: 'local', target: host, why: 'a host on this machine' };
  // the person's own answer beats what the host's words suggest
  if ((o.readOnlyHosts ?? []).map((h) => h.toLowerCase()).includes(host))
    return { class: 'read-only', target: host, why: SAID_READ_ONLY };
  if ((o.testHosts ?? []).map((h) => h.toLowerCase()).includes(host))
    return { class: 'test', target: host, why: SAID_TEST };
  // `live` in a key is no prod (LIVE_RELOAD_URL); in a host or path it is
  const prod =
    hits(prodWords, [...tokens(host), ...tokens(path)]) ??
    hits(
      prodWords.filter((w) => w !== 'live'),
      tokens(key),
    );

  if (prod !== undefined) return { class: 'prod', target: host, why: `"${prod}" names prod` };
  const sandbox = hits(SANDBOX_WORDS, tokens(host));

  if (sandbox !== undefined)
    return { class: 'sandbox', target: host, why: `"${sandbox}" names a sandbox` };
  const test = hits(TEST_WORDS, [...tokens(host), ...tokens(path)]);

  if (test !== undefined) return { class: 'test', target: host, why: `"${test}" names a test one` };

  return { class: 'unknown', target: host, why: 'nothing says whether it is test or prod' };
};

/**
 * An env file the gate read, whether git ignores it (the person's own must be) and whether git
 * tracks it (the repo's own, a test's fixture: it is committed already).
 */
export type EnvFileSeen = { path: string; example: boolean; ignored: boolean; tracked?: boolean };

const EXAMPLE_WORDS = ['example', 'sample', 'template', 'dist'];

/**
 * A real env file's name (`.env`, `.env.prod.real`, `backend.env`), the person's own: never an
 * example (`.env.example`, `.env.dev.sample`).
 */
export const isEnvFileName = (name: string): boolean =>
  /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/.test(name) &&
  hits(EXAMPLE_WORDS, tokens(name)) === undefined;

const fileName = (path: string): string => path.split('/').at(-1) ?? path;

const dirOf = (path: string): string => {
  const at = path.lastIndexOf('/');

  return at === -1 ? '.' : path.slice(0, at);
};

/** A dotenv file's keys and values: `KEY=value`, `export KEY=value`, quotes taken off. */
export const parseEnvFile = (text: string): Map<string, string> => {
  const out = new Map<string, string>();

  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);

    if (m === null) continue;
    const [, key = '', rest = ''] = m;
    const quoted = /^(['"])(.*)\1$/.exec(rest);

    out.set(key, quoted === null ? rest.replace(/\s+#.*$/, '') : (quoted[2] ?? ''));
  }

  return out;
};

/** The prefixes a bundler puts in the page for anyone to read: a key with one is public config. */
export const PUBLIC_ENV_PREFIXES = [
  'VITE_',
  'NEXT_PUBLIC_',
  'PUBLIC_',
  'REACT_APP_',
  'EXPO_PUBLIC_',
] as const;

/**
 * Whether an env file of these keys (names only) holds public config alone: then it is no secret
 * and stays readable, to the session and its checks. `prefixes`: the repo's own (`viteEnvPrefixes`).
 * One key without such a prefix: never read.
 */
export const publicEnvOnly = (keys: readonly string[], prefixes: readonly string[] = []): boolean =>
  keys.every((k) => [...PUBLIC_ENV_PREFIXES, ...prefixes].some((p) => k.startsWith(p)));

/** The config files vite reads, in a folder. */
export const VITE_CONFIGS = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const;

/**
 * The `envPrefix` a vite config declares, read from its text and never run: a quoted string, or
 * an array of them. Anything computed is not read; an empty prefix (vite refuses one) is none.
 */
export const viteEnvPrefixes = (text: string): string[] => {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const m = /(?:^|[\s{,])["'`]?envPrefix["'`]?\s*:\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/.exec(code);

  if (m === null) return [];

  return [...(m[1] ?? '').matchAll(/["'`]([^"'`]*)["'`]/g)]
    .map((q) => q[1] ?? '')
    .filter((p) => p !== '');
};

/**
 * The `envPrefix` in force for an env file in `dir` (from the top, `.` the top): the first vite
 * config there declares it, else the top's; read through `read`, never run.
 */
export const viteEnvPrefixesAt = async (
  read: (path: string) => Promise<string | undefined>,
  dir: string,
): Promise<string[]> => {
  for (const at of [...new Set([dir, '.'])])
    for (const name of VITE_CONFIGS) {
      const text = await read(at === '.' ? name : `${at}/${name}`);

      if (text !== undefined) return viteEnvPrefixes(text);
    }

  return [];
};

/** A key or env file the person said the app never uses, and their evidence. */
export const NotUsed = z.object({ key: z.string(), why: z.string() });
export type NotUsed = z.infer<typeof NotUsed>;

export const GateResult = z.object({
  passed: z.boolean(),
  /** The URL the repo's start script (`hooks.start`) printed. */
  url: z.string(),
  answered: z.boolean(),
  backends: z.array(Backend),
  /** Why it failed, one line each; empty when it passed. */
  reasons: z.array(z.string()),
  /** What the person can do about each reason (Needs you's picks). */
  options: z.array(z.string()),
  /** The env files nothing the start script runs loads: not judged. */
  unloaded: z.array(z.string()).default([]),
  /** The keys and env files the person said the app never uses, and how they know. */
  notUsed: z.array(NotUsed).default([]),
  /** What it passes with a warning: cloud credentials the run loads from a file, each named. */
  warnings: z.array(z.string()).default([]),
});
export type GateResult = z.infer<typeof GateResult>;

/** The pack script the gate judges unless told another: a repo's start that declares none. */
const START = DEFAULT_HOOKS.start;

const urlHost = (url: string): string | undefined => {
  const m = URL_RE.exec(url);

  return m === null || !/^https?$/i.test(m[1] ?? '') ? undefined : (m[2] ?? '');
};

type GateFile = EnvFileSeen & { values: ReadonlyMap<string, string> };

/** A file the start script loads besides the env files (a config JSON); `values` null: unread. */
export type StartLoad = { path: string; values: ReadonlyMap<string, string> | null };

/** A config file's name. */
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|conf)$/;

/** Words in a sourced file's name that say it holds values. */
const VALUE_WORDS = ['env', 'secret', 'secrets', 'creds', 'credentials', 'config', 'settings'];

/** Files a start script names that are no config of the app's own build. */
const NOT_CONFIG = /(^|\/)(package(-lock)?\.json|tsconfig[\w.-]*\.json|composer\.json)$/;

/**
 * What a start script loads besides the env files it names: the files it sources
 * (`source ./secrets.sh`, `. ./.env`) and the configs it names or writes (`config.generated.json`,
 * `-c config.yaml`), each path as written, and the folders it changes into (`cd backend`), where
 * a path may be read from too.
 */
export const startLoads = (start: string): { paths: string[]; dirs: string[] } => {
  // a sourced file that holds values (`.env`, `env.sh`, `secrets`), never a tool's own (`nvm.sh`)
  const sourced = [...start.matchAll(/(?:^|[;&|(\s])(?:source|\.)\s+["']?([^\s;&|"')]+)/g)]
    .map((m) => m[1] ?? '')
    .filter(
      (p) =>
        isEnvFileName(fileName(p)) ||
        hits(VALUE_WORDS, tokens(fileName(p))) !== undefined ||
        CONFIG_FILE.test(p),
    );
  const configs = [...start.matchAll(/[\w$./{}-]+\.(?:json|ya?ml|toml|ini|conf)(?![\w.-])/g)]
    .map((m) => m[0])
    .filter((p) => !NOT_CONFIG.test(p));
  const dirs = [...start.matchAll(/(?:^|[;&|(\s])cd\s+["']?([\w./-]+)/g)].map((m) => m[1] ?? '');

  return {
    paths: [...new Set([...sourced, ...configs])].filter((p) => p !== '' && !NOT_CONFIG.test(p)),
    dirs: [...new Set(dirs)].filter((d) => d !== '' && d !== '.'),
  };
};

const leaves = (value: unknown, key: string, out: Map<string, string>) => {
  if (typeof value === 'string') out.set(key, value);
  else if (Array.isArray(value))
    value.forEach((v, n) => {
      leaves(v, `${key}_${n}`, out);
    });
  else if (typeof value === 'object' && value !== null)
    for (const [k, v] of Object.entries(value)) leaves(v, key === '' ? k : `${key}_${k}`, out);
};

/**
 * A loaded file's values by key: a JSON's string leaves (`auth0.domain` as `AUTH0_DOMAIN`), a
 * YAML's `key: value` lines, else its `KEY=value` lines. Keys upper-cased, so `DOMAIN` and
 * `HOST` say a host.
 */
export const loadedValues = (path: string, text: string): Map<string, string> => {
  const raw = new Map<string, string>();

  if (path.endsWith('.json'))
    try {
      leaves(JSON.parse(text), '', raw);
    } catch {
      // not JSON after all: its lines below
    }
  if (raw.size === 0 && /\.ya?ml$/.test(path))
    for (const m of text.matchAll(/^\s*-?\s*([\w.-]+)\s*:\s*["']?([^"'#\n]*?)["']?\s*(?:#.*)?$/gm))
      if ((m[2] ?? '') !== '') raw.set(m[1] ?? '', m[2] ?? '');
  if (raw.size === 0) for (const [k, v] of parseEnvFile(text)) raw.set(k, v);

  return new Map([...raw].map(([k, v]) => [k.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), v]));
};

/**
 * A shell script without its comments: a `#` that starts a word outside quotes, to its line's end.
 * What a comment names is never loaded.
 */
export const uncommented = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      let quote: string | null = null;

      for (let n = 0; n < line.length; n += 1) {
        const c = line.charAt(n);

        if (quote !== null) {
          if (c === quote) quote = null;
          else if (c === '\\' && quote === '"') n += 1;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === '\\') n += 1;
        else if (c === '#' && (n === 0 || /\s/.test(line.charAt(n - 1))))
          return line.slice(0, n).trimEnd();
      }

      return line;
    })
    .join('\n');

/** The start script's own values: its `KEY=value` lines, and each URL it names. */
const startValues = (start: string): [string, string][] => [
  ...parseEnvFile(start),
  ...[...start.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)`]+/gi)].map((m): [string, string] => [
    'a URL',
    m[0],
  ]),
];

/**
 * The gate. It judges only what the start script's processes load (`runLoads`): the env files
 * they name, take by a dotenv cascade or load as a framework does, each folder's example for the
 * keys, the env Abe gives them (`given`: its value wins), and what the start script sets, sources
 * and the configs it names (`loaded`). An env file nothing loads is not judged (`unloaded`), but
 * one pointing at prod beside a run the gate can't see into refuses it. Passes only when the URL
 * is http(s) on a local host and answered, every env file is gitignored, and no backend judged is
 * prod, unknown or missing its value; a host the start script itself sets or loads passes only on
 * this Mac or when the person said it is a test backend. A key the person said the app never uses
 * (`notUsed`, with how they know) is not judged.
 */
export const gate = (o: {
  /** What the start script printed; none: before the run (`abe run start` asks first). */
  url?: string;
  answered: boolean;
  /**
   * Just this Mac: a run that loads cloud credentials fails, its warning the first reason, and an
   * env file not gitignored is kept out of git on this Mac (`.git/info/exclude`), never `.gitignore`.
   */
  local?: boolean;
  files: readonly GateFile[];
  prod?: readonly string[];
  testHosts?: readonly string[];
  readOnlyHosts?: readonly string[];
  /** The start script's text (or `script`'s); none: not written yet. */
  start?: string | undefined;
  /** The pack script judged, before it runs (`abe run seed`); default the start (`hooks.start`). */
  script?: string;
  /** Each folder's package.json scripts, which the start script's package runs are followed into. */
  scripts?: readonly { dir: string; scripts: Readonly<Record<string, string>> }[];
  /** What the start script loads besides the env files (`startLoads`), read. */
  loaded?: readonly StartLoad[];
  /** The app's entry files the start script runs and their imports (`runEntries`), read. */
  code?: readonly { dir: string; path: string; text: string }[];
  /** The keys Abe gives the run (its own database, its port base). */
  given?: readonly string[];
  /**
   * The Abe env file of the checks' environment (ADR 0028), as `abe run` hands it to the app: a
   * key it fills is the run's, beside the repo's own files (their empty one filled, one of its
   * own judged too).
   */
  abe?: { path: string; values: ReadonlyMap<string, string> };
  notUsed?: readonly NotUsed[];
  /** The env files that hold cloud credentials (`cloudCredentialsWhy`), and the compose files start runs. */
  credentials?: readonly CloudCredentials[];
  compose?: readonly { dir: string; text: string }[];
}): GateResult => {
  const reasons: string[] = [];
  const options: string[] = [];
  const script = o.script ?? START;
  const url = o.url ?? '';
  const again =
    o.url === undefined ? 'abe install gate --before-run' : `abe install gate --url ${o.url}`;
  const notUsed = o.notUsed ?? [];
  const unused = (key: string) => notUsed.some((n) => n.key === key);
  const sayUnused = (key: string) =>
    `Not used by the app: ${again} --not-used "${key}: <how you know the app never reads it>"`;
  const sayTest = (target: string) =>
    `A test backend, only if it truly is one: ${again} --test-host ${target} (written to abe.yaml's gate.testHosts, for every run of the repo)`;
  const sayReadOnly = (target: string) =>
    `Prod, but the app only reads from it: ${again} --read-only-host ${target} (written to abe.yaml's gate.readOnlyHosts, for every run of the repo)`;
  const start = uncommented(o.start ?? '');
  // cloud credentials the run loads from a file: Connected may, but it reaches a real cloud account
  const warnings = credentialsLoaded({
    text: start,
    scripts: o.scripts ?? [],
    code: o.code ?? [],
    compose: o.compose ?? [],
    credentials: o.credentials ?? [],
  }).map((c) => credentialsWarning(script, c));

  if (o.local === true)
    for (const w of warnings) {
      reasons.push(
        `${w}, and a Local only install's gate passes no run against a real cloud account`,
      );
      options.push(
        `Change it: have ${script} load no env file with cloud credentials, or say why the app cannot start without one (--cannot-run)`,
      );
    }
  if (o.url !== undefined) {
    const host = urlHost(o.url);

    if (host === undefined)
      reasons.push(`${o.url} is no http(s) URL: ${script} must print the app's URL`);
    else if (!isLoopback(host)) reasons.push(`the app must answer on localhost, not ${host}`);
    else if (!o.answered) {
      reasons.push(`${o.url} did not answer`);
      options.push(`Look at what ${script} printed, fix it, then run the gate again`);
    }
  }
  for (const f of o.files)
    if (!f.example && !f.ignored && f.tracked !== true) {
      reasons.push(`${f.path} is not gitignored: your env file must never be committed`);
      options.push(
        o.local === true
          ? `Keep it out of git on this machine: add ${f.path} to .git/info/exclude`
          : `Add ${f.path} to .gitignore`,
      );
    }
  if (o.start === undefined) {
    reasons.push(`no ${script}: the gate judges what it loads`);
    options.push(`Write ${script}, run it (abe run ${fileName(script)}), then run the gate again`);
  }
  const classify = (key: string, value: string) =>
    classifyValue(key, value, {
      ...(o.prod === undefined ? {} : { prod: o.prod }),
      ...(o.testHosts === undefined ? {} : { testHosts: o.testHosts }),
      ...(o.readOnlyHosts === undefined ? {} : { readOnlyHosts: o.readOnlyHosts }),
    });
  const real = o.files.filter((f) => !f.example);
  const run = runLoads({
    start,
    files: real.map((f) => f.path),
    scripts: o.scripts ?? [],
    code: o.code ?? [],
  });
  const loaded = real.filter((f) => run.loads.has(f.path));
  const unloaded = real.filter((f) => !run.loads.has(f.path));
  const where = (dir: string) => (dir === '.' ? 'the top' : dir);
  // pointing at prod: by its name, else by its keys' values (only their names said)
  const prodWhy = (f: GateFile): string | undefined => {
    if (namesProd(fileName(f.path), o.prod)) return 'its name says prod';
    const keys = [...f.values].filter(([k, v]) => classify(k, v).class === 'prod').map(([k]) => k);

    return keys.length === 0
      ? undefined
      : `${keys.join(', ')} ${keys.length === 1 ? 'points' : 'point'} at prod`;
  };

  for (const f of unloaded) {
    const dir = dirOf(f.path);
    const why = prodWhy(f);

    if (why === undefined || unused(f.path) || !run.runs.has(dir) || run.seen.has(dir)) continue;
    reasons.push(
      `${f.path} points at prod (${why}) and what ${script} runs in ${where(dir)} names no env file: nothing proves it does not load it`,
    );
    options.push(
      sayUnused(f.path),
      `Change it: have ${script} load its env files by name (dotenv -e <file>), none of them a prod one`,
    );
  }
  const judged = loaded.filter((f) => {
    if (!namesProd(fileName(f.path), o.prod)) return true;
    reasons.push(`the run loads ${f.path}, which points at prod (its name says prod)`);
    options.push(`Change it: point ${script} at a test env file, not ${f.path}`);

    return false;
  });
  const dirs = new Set([...run.seen, ...judged.map((f) => dirOf(f.path))]);
  // each folder's example gives its keys where the run loads env files
  const read = o.files.filter((f) => judged.includes(f) || (f.example && dirs.has(dirOf(f.path))));
  const keys = new Map<string, { key: string; value: string; from: string }>();

  for (const f of read)
    for (const [key, value] of f.values) {
      const at = `${dirOf(f.path)}\0${key}`;

      if (value !== '' || !keys.has(at)) keys.set(at, { key, value, from: f.path });
    }
  // what the Abe env file fills, the run gets: an empty key of the repo's, or one of its own
  for (const [key, value] of o.abe?.values ?? []) {
    if (value === '') continue;
    const empty = [...keys.entries()].filter(([, k]) => k.key === key && k.value === '');

    for (const [at] of empty) keys.set(at, { key, value, from: o.abe?.path ?? '' });
    if (![...keys.values()].some((k) => k.key === key))
      keys.set(`.\0${key}`, { key, value, from: o.abe?.path ?? '' });
  }
  const backends: Backend[] = [];
  const given = o.given ?? [];

  for (const { key, value, from } of keys.values()) {
    if (unused(key)) continue;
    if (given.includes(key)) {
      if (!backends.some((b) => b.key === key && b.from === 'Abe'))
        backends.push({
          key,
          target: 'this machine',
          class: 'local',
          why: 'Abe gives it',
          from: 'Abe',
        });
      continue;
    }
    const c = classify(key, value);

    if (c.class === 'none') continue;
    backends.push({ key, target: c.target, class: c.class, why: c.why, from });
    if (c.class === 'prod') {
      reasons.push(`${key} points at prod (${c.target}): ${c.why}`);
      options.push(
        sayUnused(key),
        sayReadOnly(c.target),
        `Change it: point ${key} at a test backend or a sandbox in your gitignored env file`,
      );
    } else if (c.class === 'unknown') {
      reasons.push(`${key} points at ${c.target}: ${c.why}`);
      options.push(
        sayUnused(key),
        sayTest(c.target),
        `Change it: point ${key} at a backend on this machine or a test one`,
      );
    } else if (c.class === 'missing') {
      reasons.push(`${key} has no value`);
      options.push(
        sayUnused(key),
        `Change it: add ${key} to your gitignored env file (.env.local), then run the gate again`,
      );
    }
  }

  // What the start script sets, sources (an env file too) and the configs it names: only a host
  // on this Mac, or one the person said is a test backend, passes; one it can't read refuses it
  const strict: { key: string; value: string; from: string }[] = [
    ...startValues(start).map(([key, value]) => ({ key, value, from: script })),
  ];

  for (const l of o.loaded ?? []) {
    if (l.values === null) {
      reasons.push(
        `${script} loads ${l.path}, which the gate can't read: nothing proves what it points at`,
      );
      options.push(`Change it: have ${script} load only files in the checkout, not ${l.path}`);
      continue;
    }
    for (const [key, value] of l.values) strict.push({ key, value, from: l.path });
  }
  const seenHosts = new Set<string>();

  for (const { key, value, from } of strict) {
    const c = classify(key, value);

    if (
      unused(key) ||
      c.class === 'none' ||
      c.class === 'missing' ||
      seenHosts.has(`${from}\0${c.target}`)
    )
      continue;
    seenHosts.add(`${from}\0${c.target}`);
    const said = c.why === SAID_TEST || c.why === SAID_READ_ONLY;
    const listed = backends.some((b) => b.key === key && b.from === from && b.target === c.target);

    // the start script's own local URLs are the app's
    if (!listed && (c.class !== 'local' || from !== script))
      backends.push({ key, target: c.target, class: c.class, why: c.why, from });
    if (c.class === 'local' || said) continue;
    if (c.class === 'prod') {
      reasons.push(`${from} points at prod (${c.target}, ${key}): ${c.why}`);
      options.push(
        sayUnused(key),
        sayReadOnly(c.target),
        `Change it: point ${key} in ${from} at a stand-in on this machine`,
      );
    } else {
      reasons.push(`${from} talks to ${c.target} (${key}): the gate can't prove it local`);
      options.push(
        sayUnused(key),
        sayTest(c.target),
        `Change it: point ${key} in ${from} at a stand-in on this machine`,
      );
    }
  }

  return {
    passed: reasons.length === 0,
    url,
    answered: o.answered,
    backends,
    reasons,
    options: [...new Set(options)],
    unloaded: unloaded.map((f) => f.path),
    notUsed: [...notUsed],
    warnings,
  };
};

/** A check Checks wrote: its name and the command it runs. */
export type WrittenCheck = { name: string; run: string };

/**
 * What a check needs only in Abe's sandbox, never in CI: a way past its temp folder. The session
 * has a writable one of its own (`TMPDIR`, `TMP`, `TEMP`), so none belongs in the repo's check.
 */
const SANDBOX_ONLY: readonly { flag: RegExp; said: string; why: string }[] = [
  {
    flag: /--env-mode(?:=|\s+)loose\b/,
    said: '--env-mode=loose',
    why: "turbo's loose env mode, a way past the sandbox's temp folder",
  },
  ...['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
    flag: new RegExp(`(?:^|[\\s;&|(])${name}=`),
    said: `${name}=`,
    why: "a temp folder of its own, a way past the sandbox's",
  })),
];

/**
 * The checks written with a flag CI's commands (`ci`) never have and only Abe's sandbox needs
 * (`--env-mode=loose`): one line each, naming the check, its command and the flag.
 */
export const sandboxWorkarounds = (
  checks: readonly WrittenCheck[],
  ci: readonly string[],
): string[] =>
  checks.flatMap((c) =>
    SANDBOX_ONLY.filter((f) => f.flag.test(c.run) && !ci.some((line) => f.flag.test(line))).map(
      (f) => `${c.name} (${c.run}) has ${f.said}, which CI's command has not: ${f.why}`,
    ),
  );

/** The key names that say an env file holds aws credentials (exported, or a profile's own). */
export const AWS_CREDENTIAL_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/** An env file in the checkout that holds cloud credentials, and why it is said to (names only). */
export const CloudCredentials = z.object({ path: z.string(), why: z.string() });
export type CloudCredentials = z.infer<typeof CloudCredentials>;

/**
 * Why an env file (`path`, from the top) holds cloud credentials, from its key names (`keys`,
 * never a value) or its name; none: it does not, or it is an example.
 */
export const cloudCredentialsWhy = (path: string, keys: readonly string[]): string | undefined => {
  const name = fileName(path);

  if (!isEnvFileName(name)) return undefined;
  const held = AWS_CREDENTIAL_KEYS.filter((k) => keys.includes(k));

  if (held.length > 0) return `it holds ${held.join(', ')}`;

  return tokens(name).includes('aws') ? 'its name says aws' : undefined;
};

/** A compose file's `env_file:` entries, one value or a list, from the top. */
const composeEnvFiles = (dir: string, text: string): string[] => {
  const out: string[] = [];
  const lines = text.split('\n');

  for (const [n, line] of lines.entries()) {
    const m = /^(\s*)env_file\s*:\s*(.*?)\s*$/.exec(line);

    if (m === null) continue;
    const one = (m[2] ?? '').replace(/^["']|["']$/g, '');
    const listed: string[] = [];

    for (const next of lines.slice(n + 1)) {
      const item = /^\s*-\s*(?:path\s*:\s*)?["']?([^"'#\s]+)/.exec(next);

      if (item === null) break;
      listed.push(item[1] ?? '');
    }
    for (const p of one === '' ? listed : [one])
      out.push(dir === '.' ? p.replace(/^\.\//, '') : `${dir}/${p.replace(/^\.\//, '')}`);
  }

  return out;
};

/** A command that starts docker compose: it loads the compose file's `env_file:`. */
const COMPOSE = /(?:^|[\s;&|(])docker(?:-compose|\s+compose)\b/;

/** The files `docker compose` reads where it runs: the one list of their names. */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/**
 * The compose files a script that runs docker compose may read (`credentialsLoaded`'s
 * `compose`): in the top and each folder it changes into, from the top. None when it runs none.
 */
export const composePaths = (text: string): { dir: string; path: string }[] =>
  COMPOSE.test(text)
    ? ['.', ...startLoads(text).dirs.map((d) => d.replace(/\/+$/, ''))].flatMap((dir) =>
        COMPOSE_FILES.map((name) => ({ dir, path: dir === '.' ? name : `${dir}/${name}` })),
      )
    : [];

/**
 * The cloud credentials a script loads (`text`: the start script), its package scripts followed: an env file it names (`dotenv -e`, `source`,
 * `--env-file`), one a dotenv cascade, a framework or the app's code takes, or a compose file's
 * `env_file:` when it runs docker compose.
 */
export const credentialsLoaded = (o: {
  text: string;
  scripts?: readonly { dir: string; scripts: Readonly<Record<string, string>> }[];
  code?: readonly { dir: string; path: string; text: string }[];
  compose?: readonly { dir: string; text: string }[];
  credentials: readonly CloudCredentials[];
}): CloudCredentials[] => {
  const text = uncommented(o.text);
  const run = runLoads({
    start: text,
    files: o.credentials.map((c) => c.path),
    scripts: o.scripts ?? [],
    code: o.code ?? [],
  });
  const composed = COMPOSE.test(text)
    ? (o.compose ?? []).flatMap((c) => composeEnvFiles(c.dir, c.text))
    : [];

  return o.credentials.filter((c) => run.loads.has(c.path) || composed.includes(c.path));
};

/** A script that loads cloud credentials from a file, the file and why: a real cloud account reached. */
export const credentialsWarning = (script: string, c: CloudCredentials): string =>
  `${script} loads ${c.path} (${c.why}): the app reaches a real cloud account with those keys`;
