/**
 * The install's Prototype check (`abe install check prototype`), as serve runs it: the repo's
 * `prototype-start` hook started as a prototype's is (a throwaway worktree of the default
 * branch with what a card's gets, its own port base and database, its env file's values), step by
 * step (core's `PROTOTYPE_TRY_STEPS`), then stopped and everything it had let go. The app's log
 * and the screenshot stay in `<prototypes>/install-check/` until the next try.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  appOrigin,
  DB_NAME,
  DEFAULT_HOOKS,
  dbFailureWords,
  injectedSecrets,
  lastLines,
  macDbName,
  originOf,
  PORT_BASE,
  PORT_SPAN,
  START_TIMEOUT_MS,
  startTimeoutWhy,
  prototypeStartSays,
  type PrototypeTry,
  type PrototypeTryRefusal,
  type PrototypeTryStep,
  redactText,
  WORKSPACE_DATABASE,
} from '@abe/core';
import { type RunScript } from '../local-mode/databases';
import { type Prototypes, startValues } from './prototypes';

/** The check's place among the prototypes: never a prototype's id (`proto-<hex>`). */
export const TRY_ID = 'install-check';

/** How long the app has to answer on its port once the script printed its URL. */
const READY_MS = 20_000;
/** How long the page has to load. */
const PAGE_MS = 15_000;
/** The screenshot's viewport: the preview's 1280 × 800. */
const VIEW = { width: 1280, height: 800 } as const;

/** A sign-in page: redirected to one by its path, or a password field in it. */
const SIGN_IN_PATH = /\/(log[-_]?in|sign[-_]?in|auth)(\/|$|\?)/i;
const PASSWORD_FIELD = /<input[^>]*type\s*=\s*["']?password/i;

const runnable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The first answer from `url` within `ms`, or why none came. */
const answered = async (
  url: string,
  ms: number,
): Promise<{ ok: true; res: Response; body: string } | { ok: false; why: string }> => {
  const until = Date.now() + ms;
  let why = 'no answer';

  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });

      return { ok: true, res, body: await res.text() };
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }

  return { ok: false, why };
};

export type TryOptions = {
  /** The main checkout's top. */
  repo: string;
  /** Now, for the record. */
  at: string;
  /** The Abe env file's keys, by environment, names only: an `# abe-login:` key must be one. */
  keysOf: (env: 'dev' | 'test') => Promise<readonly string[]>;
};

/**
 * The repo's prototype start tried step by step: each step runs once the one before passed; a
 * refused one ends the try with its code. Never left running: stopped, its port base and its
 * database let go, whatever happened.
 */
export const tryPrototype = async (p: Prototypes, o: TryOptions): Promise<PrototypeTry> => {
  const began = Date.now();
  const steps: PrototypeTryStep[] = [];
  const dir = join(p.dir, TRY_ID);
  const log = p.apps.log?.(TRY_ID) ?? null;
  let env: PrototypeTry['env'] = null;
  let portBase: number | null = null;
  let url: string | null = null;
  let screenshot: string | null = null;
  const passed = (step: PrototypeTryStep['step'], line: string) => {
    steps.push({ step, ok: true, line });
  };
  const refused = (step: PrototypeTryStep['step'], why: PrototypeTryRefusal, line: string) => {
    steps.push({ step, ok: false, why, line });
  };
  const done = (): PrototypeTry => ({
    at: o.at,
    steps,
    env,
    portBase,
    url,
    log,
    screenshot,
    durationMs: Math.max(0, Math.round(Date.now() - began)),
  });

  // script: there, runnable, its login keys in its env file
  const hooks = p.hooks?.(o.repo) ?? DEFAULT_HOOKS;
  const script = hooks['prototype-start'];
  const file = join(o.repo, script);

  if (!existsSync(file)) {
    refused('script', 'no-start-script', `${script} is not there`);

    return done();
  }
  if (!runnable(file)) {
    refused('script', 'start-script-not-executable', `${script} is not executable`);

    return done();
  }
  const says = prototypeStartSays(readFileSync(file, 'utf8'));

  env = says.env;
  const keys = await o.keysOf(says.env);
  const lacking = says.login.filter((k) => !keys.includes(k));

  if (lacking.length > 0) {
    refused(
      'script',
      'login-key-missing',
      `# abe-login: names ${lacking.join(', ')}, not in .abe/abe.${says.env}.env`,
    );

    return done();
  }
  passed(
    'script',
    `${script} · ${says.env} env${says.login.length === 0 ? '' : ` · login ${says.login.join(', ')}`}`,
  );

  // start: as a prototype's, in a throwaway worktree of the default branch
  const head = await p.apps.head(o.repo);

  if (!head.ok) {
    refused('start', 'start-failed', head.error.message);

    return done();
  }
  const valued = await startValues(p, o.repo, o.repo);

  if (!valued.ok) {
    refused('start', 'env-not-ready', valued.error.message);

    return done();
  }
  const secrets = injectedSecrets(valued.data.values);
  const said = (text: string) => redactText(text, secrets);

  portBase = p.ports?.take(TRY_ID) ?? null;
  const own: Record<string, string> = {
    ABE_PROTOTYPE: TRY_ID,
    ...(portBase === null ? {} : { [PORT_BASE]: String(portBase) }),
  };
  const names = { mac: macDbName.prototype(TRY_ID), hook: DB_NAME(TRY_ID) };
  let db: 'hook' | 'mac' | undefined;
  // the database hook's and the seed's runs, logged beside the start's
  const run: RunScript = (r) =>
    p.apps.script({
      id: TRY_ID,
      dir: r.cwd,
      script: r.script,
      args: r.args,
      env: r.env,
      timeoutMs: r.timeoutMs,
    });
  const shotFile = join(dir, 'screenshot.png');

  // the last try's screenshot goes; its worktree is the start's to remove
  mkdirSync(dir, { recursive: true });
  rmSync(shotFile, { force: true });
  try {
    const started = await p.apps.start({
      id: TRY_ID,
      repo: o.repo,
      commit: head.data.commit,
      env: { ...valued.data.values, ...own },
      copy: (await p.worktreeCopies?.(o.repo)) ?? [],
      hooks,
      prepare: async (at) => {
        if (p.databases === undefined) return { ok: true, env: {} };
        const got = await p.databases.ensure({
          dir: at,
          repo: basename(o.repo),
          ...names,
          env: own,
          seed: true,
          run,
        });

        if (!got.ok) return { ok: false, message: dbFailureWords(got.failure) };
        db = got.db?.by;

        return { ok: true, env: got.db === undefined ? {} : { [WORKSPACE_DATABASE]: got.db.url } };
      },
    });

    if (!started.ok) {
      refused('start', 'start-failed', said(started.error.message));

      return done();
    }
    const ran = started.data.ran;
    const tail = lastLines(`${ran.stdout}\n${ran.stderr}`, 5).join(' ⏎ ');

    if (ran.timedOut === true) {
      refused(
        'start',
        'start-timeout',
        said(`${startTimeoutWhy(ran.ms ?? START_TIMEOUT_MS)}: ${tail}`),
      );

      return done();
    }
    if (ran.exit !== 0) {
      refused('start', 'start-failed', said(`exit ${ran.exit}${tail === '' ? '' : `: ${tail}`}`));

      return done();
    }
    const printed = lastLines(ran.stdout, 1)[0] ?? '';
    const origin = appOrigin(printed);

    if (!origin.ok) {
      refused('start', 'no-url', said(origin.why));

      return done();
    }
    url = /^\d{1,5}$/.test(printed.trim()) ? origin.origin : printed.trim();
    passed('start', `ran · printed ${url}`);

    // ready: on its port base, answering
    const port = Number(/:(\d+)$/.exec(originOf(origin.origin)?.host ?? '')?.[1] ?? '80');

    if (portBase !== null && (port < portBase || port >= portBase + PORT_SPAN)) {
      refused(
        'ready',
        'port-not-base',
        `it listens on ${port}, not on $${PORT_BASE} (${portBase}–${portBase + PORT_SPAN - 1})`,
      );

      return done();
    }
    const ready = await answered(origin.origin, READY_MS);

    if (!ready.ok) {
      refused('ready', 'not-ready', `nothing on ${origin.origin} after ${READY_MS / 1000} s`);

      return done();
    }
    passed('ready', `${origin.origin} answers`);

    // page: the URL it printed, 2xx
    const page = await answered(url, PAGE_MS);

    if (!page.ok || !page.res.ok) {
      refused(
        'page',
        'no-page',
        page.ok ? `${url} answered ${page.res.status}` : `${url}: ${page.why}`,
      );

      return done();
    }
    const landed = page.res.url === '' ? url : page.res.url;

    passed('page', `${new URL(landed).pathname} ${page.res.status}`);

    // login: signed in when it says so, never a sign-in page
    if (says.login.length === 0) passed('login', 'no login');
    else if (SIGN_IN_PATH.test(new URL(landed).pathname) || PASSWORD_FIELD.test(page.body)) {
      refused('login', 'login-failed', `${new URL(landed).pathname} is a sign-in page`);

      return done();
    } else passed('login', `signed in (${says.login.join(', ')})`);

    // screenshot: kept beside the log
    const shot =
      p.shot === undefined
        ? { ok: false as const, why: 'this serve takes no screenshots' }
        : await p.shot({ url, file: shotFile, ...VIEW });

    if (shot.ok && existsSync(shotFile)) {
      screenshot = shotFile;
      passed('screenshot', 'kept · stopped again');
    } else refused('screenshot', 'no-screenshot', shot.ok ? 'no file written' : shot.why);

    return done();
  } finally {
    await p.apps
      .stop({
        id: TRY_ID,
        repo: o.repo,
        env: portBase === null ? {} : { [PORT_BASE]: String(portBase) },
      })
      .catch(() => undefined);
    p.ports?.release(TRY_ID);
    if (p.databases !== undefined && db !== undefined)
      await p.databases
        .release({
          dir: o.repo,
          ...names,
          env: own,
          by: db,
          run,
        })
        .catch(() => undefined);
  }
};
