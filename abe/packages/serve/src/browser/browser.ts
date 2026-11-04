/**
 * The workspace's browser (#66), run by the box's `serve` through the Browser port: started on
 * demand, one per workspace, read for activity every `every` ms and stopped after
 * `BROWSER.idleMs` with none, by `abe browser stop`, or by verification's end (`stop('verified')`,
 * for the verify flow's command). A start in a browser profile other than `default` (#103) reads
 * its stored sign-ins first and sets them into the fresh Chromium through DevTools before it
 * answers; Chromium's own profile is still made anew every start.
 */
import {
  activityOf,
  agoText,
  BROWSER,
  type Browser,
  type ByCard,
  type BrowserData,
  type BrowserProbe,
  type BrowserStopReason,
  chromiumArgv,
  type Clock,
  endpointOf,
  type EventData,
  type Handlers,
  isIdle,
  type Outcome,
  DEFAULT_PROFILE,
  ProfileName,
  type ProfileStore,
  profileOf,
  readState,
  refused,
  startProfile,
  storeHint,
} from '@abe/core';
import { type Factory } from '../factory/factory';
import { type LocalBrowsers } from '../local-mode/local-browsers';
import { type Sessions } from '../session/sessions';
import { type Box, requestCard } from '../box/workspace';

export type BrowserServiceOptions = {
  browser: Browser;
  clock: Clock;
  /** How often DevTools is read for activity while a browser runs. */
  every: number;
  started: (data: EventData<'browser.started'>) => void;
  stopped: (data: EventData<'browser.stopped'>) => void;
  /** Whether a browser can start now: the workspace runs. A refusal says why not. */
  ready: () => Promise<Outcome<undefined>>;
  /** Your profiles' stored sign-ins (#103); without it only `default` starts. */
  profiles?: ProfileStore | undefined;
  /**
   * A local session's browser (#182): its own folder and port, the Mac's Chrome, and the MCP
   * config its session was launched with; default the workspace's (`BROWSER`).
   */
  local?: {
    dir: string;
    port: number;
    argv: (dir: string, port: number) => string[];
    mcpConfig: string;
  };
};

export type BrowserService = {
  /** Starts it in `profile` (default `default`); one running in another profile starts again. */
  start: (profile?: string) => Promise<Outcome<BrowserData>>;
  stop: (reason: BrowserStopReason) => Promise<Outcome<BrowserData>>;
  status: () => Promise<Outcome<BrowserData>>;
  /** When this service started watching (#319): stops before it are ones it never saw. */
  watchedSince: string;
  close: () => void;
};

/**
 * What this `serve` knows of the running browser beyond what DevTools says: its profile and when
 * the copy restored into it was stored (`null` for one it did not start: adopted).
 */
type Held = {
  pid: number | null;
  startedAt: number | null;
  lastActivity: number;
  seen: string;
  profile: string | null;
  storedAt: string | null;
};

/** DevTools not answering this many readings in a row is a browser gone (`exited`). */
const MISSES = 2;

const iso = (ms: number) => new Date(ms).toISOString();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The service reads DevTools every `every` ms from the start, so a browser left running by a
 * `serve` before this one (the box's serve restarted) is adopted and idle-stopped all the same.
 */
export const startBrowserService = (o: BrowserServiceOptions): BrowserService => {
  const where = { dir: o.local?.dir ?? BROWSER.dir, port: o.local?.port ?? BROWSER.port };
  let held: Held | undefined;
  let lastStop: BrowserData['stopped'] = null;
  let misses = 0;
  let closed = false;
  let polling = false;
  const holding = () => held;
  const watchedSince = iso(o.clock.now());

  // Start, stop and the activity reading one at a time: never two browsers, never a stop mid-start.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);

    queue = next.catch(() => undefined);

    return next;
  };

  const gone = (reason: BrowserStopReason) => {
    if (held !== undefined) {
      lastStop = { at: iso(o.clock.now()), reason };
      o.stopped({ reason });
    }
    held = undefined;
    misses = 0;
  };

  const dataOf = (p: BrowserProbe | undefined): BrowserData => ({
    state: p === undefined ? 'stopped' : 'running',
    endpoint: p === undefined ? null : endpointOf(where.port),
    webSocket: p?.webSocket ?? null,
    browser: p?.version ?? null,
    pid: p === undefined ? null : (p.pid ?? held?.pid ?? null),
    pages: p?.pages.length ?? 0,
    clients: p?.clients ?? 0,
    port: where.port,
    profile: profileOf(where.dir),
    mcpConfig: o.local?.mcpConfig ?? BROWSER.mcpConfig,
    startedAt: held === undefined || held.startedAt === null ? null : iso(held.startedAt),
    lastActivityAt: held === undefined ? null : iso(held.lastActivity),
    idleStopAt: held === undefined ? null : iso(held.lastActivity + BROWSER.idleMs),
    stopped: lastStop,
    browserProfile: p === undefined ? null : (held?.profile ?? null),
    signIns:
      p === undefined || held?.storedAt === undefined || held.storedAt === null
        ? null
        : { storedAt: held.storedAt, ago: agoText(held.storedAt, o.clock.now()) },
  });

  /** A browser this `serve` did not start, as DevTools shows it. */
  const adopt = (p: BrowserProbe, seen: string): Held => ({
    pid: p.pid,
    startedAt: null,
    lastActivity: o.clock.now(),
    seen,
    profile: null,
    storedAt: null,
  });

  /**
   * DevTools' answer, squared with what this `serve` holds: a browser it did not start is adopted,
   * a change of pages or clients is activity. A held browser not answering `MISSES` readings in a
   * row is gone (`exited`): what is left of it is stopped, so a slow answer never leaves two.
   */
  const read = async (): Promise<BrowserProbe | undefined> => {
    const p = await o.browser.probe(where);

    if (p === undefined) {
      misses += 1;
      if (held !== undefined && misses >= MISSES) {
        await o.browser.stop({ dir: where.dir });
        gone('exited');
      }

      return p;
    }
    misses = 0;
    const seen = activityOf(p);

    if (held === undefined) held = adopt(p, seen);
    else if (seen !== held.seen) held = { ...held, seen, lastActivity: o.clock.now() };

    return p;
  };

  const guarded = async (run: () => Promise<Outcome<BrowserData>>) => {
    try {
      return await run();
    } catch (err) {
      return refused('docker-failed', message(err));
    }
  };

  /** Refused once closed or while the workspace does not run. */
  const ready = async (): Promise<Outcome<undefined>> =>
    closed ? refused('serve-stopping', 'this abe serve is stopping') : o.ready();

  /**
   * The profile's stored sign-ins, read before anything starts: `default` has none; a profile
   * with nothing stored, or a secret that cannot be read, is refused, never started empty.
   */
  const signInsOf = async (profile: string) => {
    if (profile === DEFAULT_PROFILE) return { ok: true as const, data: undefined };
    if (o.profiles === undefined)
      return refused(
        'profile-unreadable',
        `this abe serve reads no stored sign-ins, so ${profile} cannot start`,
      );
    const read = await o.profiles.read(profile);

    if (!read.ok) return refused('profile-unreadable', read.error.message);
    if (read.data === null)
      return refused(
        'profile-not-stored',
        `${profile} has no stored sign-ins: ${storeHint(profile)}`,
      );
    const state = readState(read.data.text);

    return state === undefined
      ? refused('profile-unreadable', `${read.data.secret} holds no browser state Abe reads`)
      : { ok: true as const, data: state };
  };

  const start = (profile: string = DEFAULT_PROFILE) =>
    serial(() =>
      guarded(async () => {
        const isReady = await ready();

        if (!isReady.ok) return isReady;
        const running = await read();

        // One per workspace: a running browser in this profile is the one. One adopted (a serve
        // before this one started it, its profile unknown) is taken for an empty start, as
        // 2.0's; a named profile starts afresh.
        const own = held?.profile ?? null;

        if (
          running !== undefined &&
          (own === profile || (own === null && profile === DEFAULT_PROFILE))
        )
          return { ok: true, data: dataOf(running) };
        const signIns = await signInsOf(profile);

        if (!signIns.ok) return signIns;
        // Another profile: the running one goes first, so no sign-in carries over.
        if (running !== undefined) {
          await o.browser.stop({ dir: where.dir });
          gone('stop');
        }
        // The start script stops whatever its pid file still names first.
        const argv =
          o.local?.argv(where.dir, where.port) ??
          chromiumArgv(BROWSER.executable, where.dir, where.port);
        const ran = await o.browser.start({ ...where, argv });

        if (!ran.ok) {
          gone('exited');

          return refused(ran.error.code, ran.error.message);
        }
        if (signIns.data !== undefined) {
          const restored = await o.browser.restore({ port: where.port, state: signIns.data });

          // Never left running empty in its place: nothing held, so a stop that fails leaves a
          // browser the next start does not take for this profile.
          if (!restored.ok) {
            held = undefined;
            misses = 0;
            await o.browser.stop({ dir: where.dir });

            return refused(
              'profile-restore-failed',
              `${profile}'s sign-ins did not go into the browser: ${restored.error.message}`,
            );
          }
        }
        const now = o.clock.now();

        held = {
          pid: ran.data.pid,
          startedAt: now,
          lastActivity: now,
          seen: '',
          profile,
          storedAt: signIns.data?.storedAt ?? null,
        };
        misses = 0;
        o.started({ pid: ran.data.pid, endpoint: endpointOf(where.port) });
        const p = await read();

        return p === undefined
          ? refused('browser-failed', "Chromium's DevTools stopped answering right after its start")
          : { ok: true, data: dataOf(p) };
      }),
    );

  const stop = (reason: BrowserStopReason) =>
    serial(() =>
      guarded(async () => {
        const isReady = await ready();

        if (!isReady.ok) return isReady;
        const p = await o.browser.probe(where);

        if (p === undefined) {
          // Nothing answers: whatever is left goes; one held is recorded as gone on its own.
          await o.browser.stop({ dir: where.dir });
          gone('exited');

          return { ok: true, data: dataOf(undefined) };
        }
        held ??= adopt(p, activityOf(p));
        await o.browser.stop({ dir: where.dir });
        gone(reason);

        return { ok: true, data: dataOf(undefined) };
      }),
    );

  const status = () =>
    serial(() =>
      guarded(async () => {
        const isReady = await ready();

        if (!isReady.ok) return isReady;

        return { ok: true, data: dataOf(await read()) };
      }),
    );

  /** One activity reading; a tick while one is still waiting (Docker slow) is skipped. */
  const poll = () => {
    if (polling || closed) return;
    polling = true;
    void serial(async () => {
      try {
        if ((await o.ready()).ok) {
          await read();
          const h = holding();

          if (h !== undefined && isIdle(h.lastActivity, o.clock.now())) {
            await o.browser.stop({ dir: where.dir });
            gone('idle');
          }
        }
      } catch {
        // Docker not answering this once: the next reading tries again.
      } finally {
        polling = false;
      }
    });
  };
  const timer = setInterval(poll, o.every);

  return {
    start,
    stop,
    status,
    watchedSince,
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
};

export type BrowserCtx = {
  /** On a box, the card whose workspace's socket the request came in on. */
  insideCard: string | undefined;
  /** The session the request came in on: its launch named the profile its browser starts in. */
  session: string | undefined;
  serve: {
    /** On a box: its workspaces (the one a request from none of them is about). */
    box: Box | undefined;
    /** On a box: each card's workspace's own browser (ADR 0022). */
    browser: ByCard<BrowserService> | undefined;
    /** The Mac's serve: each local Factory run's session has its own (#182). */
    localBrowsers: LocalBrowsers | undefined;
    sessions: Sessions | undefined;
    factory: Factory | undefined;
  };
};

const NOT_A_WORKSPACE = refused(
  'not-a-box',
  "this abe serve runs no workspace, so no browser (a box starts it with ABE_BOX set); a local Factory run's session has its own",
);

const NO_LOCAL_BROWSER = refused(
  'no-browser',
  'this session was launched without a browser: only a local Factory run gets one, when Google Chrome is installed and npx is on its PATH',
);

/**
 * The browser a request drives: on a box its card's workspace's (the box's only one for a
 * request from no workspace or session), else its local session's own.
 */
const browserOf = async (ctx: BrowserCtx): Promise<Outcome<BrowserService>> => {
  if (ctx.serve.browser !== undefined) {
    const only = async () => {
      const all = (await ctx.serve.box?.list().catch(() => [])) ?? [];

      return all.length === 1 ? all[0]?.card : undefined;
    };
    const card = requestCard(ctx) ?? (await only());

    return card === undefined
      ? refused(
          'no-workspace',
          "abe browser drives a card's workspace's browser: from its session, on a box with one",
        )
      : { ok: true, data: ctx.serve.browser(card) };
  }
  const own =
    ctx.session === undefined || ctx.serve.sessions?.metaOf(ctx.session) === undefined
      ? undefined
      : ctx.serve.localBrowsers?.of(ctx.session);

  if (own !== undefined) return { ok: true, data: own };

  return ctx.session === undefined || ctx.serve.localBrowsers === undefined
    ? NOT_A_WORKSPACE
    : NO_LOCAL_BROWSER;
};

/**
 * `abe browser start [--profile]` in a session: its own profile unless another is named; while
 * its run verifies (Before, then After) only its own, so both run in the same one.
 */
const startIn = (browser: BrowserService, ctx: BrowserCtx, asked: string | undefined) => {
  if (asked !== undefined && asked !== DEFAULT_PROFILE && !ProfileName.safeParse(asked).success)
    return Promise.resolve(refused('usage', `--profile ${asked} is no browser profile name`, 2));
  const id = ctx.session;
  const meta = id === undefined ? undefined : ctx.serve.sessions?.metaOf(id);
  const run = id === undefined ? undefined : ctx.serve.factory?.get(id);
  const chosen = startProfile({
    asked,
    session: meta?.browserProfile,
    verifying: run?.stage === 'verify',
  });

  if (!chosen.ok) return Promise.resolve(refused(chosen.code, chosen.message));

  return browser.start(chosen.profile);
};

export const browserHandlers = <C extends BrowserCtx>() =>
  ({
    'browser start': async (args, ctx) => {
      const b = await browserOf(ctx);

      return b.ok ? startIn(b.data, ctx, args.profile) : b;
    },
    'browser stop': async (_, ctx) => {
      const b = await browserOf(ctx);

      return b.ok ? b.data.stop('stop') : b;
    },
    'browser status': async (_, ctx) => {
      const b = await browserOf(ctx);

      return b.ok ? b.data.status() : b;
    },
  }) satisfies Partial<Handlers<C>>;
