/**
 * `abe prototype`: a prototype's app (`PrototypeApps`), run from its session's worktree, the
 * prototype proxy in front of it (`PrototypeProxy`, its url the preview link), its records and
 * screenshots kept in `serve`'s state directory. The rules are core's (`prototype.ts`); the
 * session and its worktree are `code-prototype.ts`'s.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import {
  type Clock,
  DB_NAME,
  DEFAULT_HOOKS,
  dbFailureWords,
  injectedSecrets,
  macDbName,
  type PageShot,
  prototypeStartSays,
  type RepoHooks,
  redactText,
  PORT_BASE,
  type PrototypeStep,
  WORKSPACE_DATABASE,
  type Handlers,
  type Journal,
  type Outcome,
  type PrototypeApps,
  isPng,
  screenshotFile,
  type OrgStore,
  type PrototypeHead,
  type PrototypeData,
  newestShot,
  prototypeData,
  prototypeWords,
  prototypeId,
  type PrototypeMeta,
  type PrototypeProxy,
  type PrototypeState,
  refused,
  startAnswer,
  type WorktreeCopy,
} from '@abe/core';
import { type LocalPrototypes, localPrototypes, type ProtoWorktrees } from '@abe/ports';
import { type Databases, type RunScript } from '../local-mode/databases';
import { type LocalApps } from '../local-mode/local-apps';
import { type LocalMode } from '../local-mode/local-mode';
import { type PortBases } from '../local-mode/port-bases';
import { type PortsCtx } from '../box/port-forwards';
import { type OwnCtx, ownPath } from '../session/own';
import { type SessionCtx, type Sessions } from '../session/sessions';

export type PrototypesOptions = {
  /** `prototypes` in `serve`'s state directory. */
  dir: string;
  apps: PrototypeApps;
  proxy: PrototypeProxy;
  /** A developer's prototypes' worktrees (#83); without them `prototype start --code` is refused. */
  worktrees?: ProtoWorktrees;
  /** A page's screenshot by this machine's headless browser (the install's Prototype check). */
  shot?: PageShot;
};

/** What a serve gives its prototypes beside their options (#349). */
export type PrototypesShared = {
  clock: Clock;
  emit: Journal['emit'];
  /** Each prototype's database; without them a prototype gets none. */
  databases?: Databases;
  /** Each running prototype's port base (`ABE_PORT_BASE`); without them none. */
  ports?: PortBases;
  /**
   * What a card's new worktree gets copied in from its checkout (`worktreeCopies`): the app's
   * place gets it too, before its start script is looked for. Without it nothing is copied.
   */
  worktreeCopies?: (repo: string) => Promise<readonly WorktreeCopy[]>;
  /**
   * The repo's hook points (its main checkout's abe.yaml): the start and stop scripts, the
   * `worktree-setup` run in the app's place. None: today's places, no worktree script.
   */
  hooks?: (repo: string) => RepoHooks;
  /**
   * The values the `prototype-start` hook gets (ADR 0028): the checkout's Abe env file its
   * `# abe-env:` line names and its aws profile's keys, as `abe run --env` hands them; refused in
   * words (an environment off for agents, an aws login expired). None: no values.
   */
  appValues?: (repo: string, env: 'dev' | 'test') => Promise<Outcome<Record<string, string>>>;
  /**
   * The ports `repo`'s app always takes (`ports.fixed`, what its install read fixed): a
   * prototype's app on this Mac then starts the normal way on them, by the `start` hook, with no
   * proxy, one prototype at a time (ADR 0039). None: none.
   */
  fixedPorts?: (repo: string) => Promise<readonly number[]>;
  /**
   * The sessions' apps on the fixed ports (`LocalApps.takePorts`, `givePorts`): the main
   * checkout's stopped for a prototype's and started again when the last one stops. None:
   * nothing of Abe's holds them.
   */
  hand?: Pick<LocalApps, 'takePorts' | 'givePorts'>;
  /** Whether something answers on loopback port `port` (default: a TCP connect). */
  portBusy?: (port: number) => Promise<boolean>;
  /** How long a stopped app has to let go of the fixed ports (default `PORTS_FREE_MS`). */
  portsFreeMs?: number;
};

export type Prototypes = {
  local: LocalPrototypes;
  apps: PrototypeApps;
  proxy: PrototypeProxy;
  worktrees: ProtoWorktrees | undefined;
  clock: Clock;
  emit: Journal['emit'];
  databases: Databases | undefined;
  ports: PortBases | undefined;
  worktreeCopies: ((repo: string) => Promise<readonly WorktreeCopy[]>) | undefined;
  hooks: ((repo: string) => RepoHooks) | undefined;
  appValues: PrototypesShared['appValues'];
  fixedPorts: PrototypesShared['fixedPorts'];
  hand: PrototypesShared['hand'];
  portBusy: (port: number) => Promise<boolean>;
  portsFreeMs: number;
  shot: PageShot | undefined;
  /** `prototypes` in `serve`'s state directory. */
  dir: string;
  /** Runs one prototype's commands one at a time; other prototypes are not held up. */
  serial: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  /** Prototypes a `serve` before this one left running, stopped (their proxy went with it). */
  ready: Promise<void>;
  /** Stops every running prototype (`serve` stopping). */
  close: () => Promise<void>;
};

/** What the flows below use. */
type Parts = Pick<
  Prototypes,
  | 'local'
  | 'apps'
  | 'proxy'
  | 'clock'
  | 'emit'
  | 'databases'
  | 'ports'
  | 'worktreeCopies'
  | 'hooks'
  | 'appValues'
  | 'fixedPorts'
  | 'hand'
  | 'portBusy'
  | 'portsFreeMs'
  | 'serial'
>;

export type PrototypesCtx = OwnCtx &
  Pick<SessionCtx, 'settings'> & {
    cwd: string;
    serve: {
      prototypes: Prototypes | undefined;
      /** Where Show prototype reads a card's prototype from (#82). */
      org: OrgStore | undefined;
      /** Local mode (#24): a repo in it keeps its prototypes in this Mac's own store. */
      localMode?: LocalMode | undefined;
      /** Where a prototype session runs on this Mac. */
      sessions: Sessions | undefined;
    };
  } & { serve: Partial<PortsCtx['serve']> };

const usage = (message: string) => refused('usage', message, 2);

const NO_PROTOTYPES = refused(
  'no-prototypes',
  'this abe serve runs no prototypes (on a box the workspace will, #81)',
);

export const RUNNING: readonly PrototypeState[] = ['starting', 'live'];

/**
 * A prototype on a box whose app listens now: its port forwarded to this Mac (`port open`, its
 * workspace keyed by the prototype's id) and kept as its url, live. One on this Mac, done with,
 * or with a url already: as it is.
 */
const forwarded = async (
  ctx: { serve: Partial<PortsCtx['serve']> },
  p: Parts,
  m: PrototypeMeta,
): Promise<PrototypeMeta> => {
  const box = m.code?.box ?? null;

  if (box === null || m.code?.ended !== false || m.url !== null || ctx.serve.forwards === undefined)
    return m;
  const listed = await ctx.serve.forwards.list(box);

  if (!listed.ok) return m;
  const held = listed.data.forwards.find((f) => f.card === m.id && f.state === 'open');
  const offer = listed.data.offered
    .filter((o) => o.card === m.id)
    .sort((a, b) => a.port - b.port)[0];
  const opened =
    held === undefined && offer !== undefined
      ? await ctx.serve.forwards.open({ box, card: m.id, port: offer.port })
      : undefined;
  const local = held?.local ?? (opened?.ok === true ? opened.data.local : undefined);

  if (local === undefined) return m;
  const url = `http://127.0.0.1:${String(local)}`;
  const live: PrototypeMeta = { ...m, state: 'live', since: now(p), url, app: url };

  await p.local.write(live);

  return live;
};

export const now = (p: Pick<Parts, 'clock'>): string => new Date(p.clock.now()).toISOString();

/** The prototype kept in its new state, and `prototype.state` told. */
const moved = async (
  p: Parts,
  meta: PrototypeMeta,
  change: {
    state: PrototypeState;
    url: string | null;
    app: string | null;
    reason?: string;
    step?: PrototypeStep;
  },
  cause: string,
) => {
  const next: PrototypeMeta = {
    ...meta,
    ...change,
    reason: change.reason ?? null,
    step: change.step ?? null,
    since: now(p),
  };

  await p.local.write(next);
  p.emit('prototype.state', {
    id: next.id,
    card: next.card,
    state: next.state,
    url: next.url,
    cause,
    reason: next.reason,
  });

  return next;
};

/** A prototype's names for its database: the Mac database's and its hook's (#349). */
const dbNames = (id: string) => ({ mac: macDbName.prototype(id), hook: DB_NAME(id) });

/** Its port base, for its stop script as its start had it. */
const portEnv = (meta: PrototypeMeta): Record<string, string> =>
  meta.portBase === null ? {} : { [PORT_BASE]: String(meta.portBase) };

/** A pack script of the prototype's, run by its apps where it is (its output kept beside it). */
const scriptRun =
  (p: Parts, id: string): RunScript =>
  (r) =>
    p.apps.script({
      id,
      dir: r.cwd,
      script: r.script,
      args: r.args,
      env: r.env,
      timeoutMs: r.timeoutMs,
    });

/** A repo's hook points as the prototypes have them. */
const hooksOf = (p: Pick<Parts, 'hooks'>, repo: string): RepoHooks =>
  p.hooks?.(repo) ?? DEFAULT_HOOKS;

/**
 * What the `prototype-start` hook gets beside Abe's own: the values of the Abe env file its
 * `# abe-env:` line names (dev when none), the script read in `at` (a developer prototype's
 * worktree, else the checkout). The pack's start gets none, as before it.
 */
export const startValues = async (
  p: Pick<Parts, 'appValues' | 'hooks'>,
  repo: string,
  at: string,
): Promise<Outcome<{ env: 'dev' | 'test' | null; values: Record<string, string> }>> => {
  const script = hooksOf(p, repo)['prototype-start'];
  const text = await readFile(join(at, script), 'utf8').catch(() => undefined);

  if (text === undefined) return { ok: true, data: { env: null, values: {} } };
  const { env } = prototypeStartSays(text);
  const got =
    p.appValues === undefined ? { ok: true as const, data: {} } : await p.appValues(repo, env);

  return got.ok ? { ok: true, data: { env, values: got.data } } : got;
};

/** How long a stopped app has to let go of the fixed ports before a start on them is refused. */
const PORTS_FREE_MS = 10_000;

/** Whether something answers a TCP connect on loopback `port` (IPv4, then IPv6). */
export const portAnswers = (port: number): Promise<boolean> => {
  const one = (host: string) =>
    new Promise<boolean>((done) => {
      const socket = createConnection({ host, port });
      const end = (answered: boolean) => {
        socket.destroy();
        done(answered);
      };

      socket.setTimeout(500, () => {
        end(false);
      });
      socket.once('connect', () => {
        end(true);
      });
      socket.once('error', () => {
        end(false);
      });
    });

  return one('127.0.0.1').then((v4) => v4 || one('::1'));
};

/** Of `ports`, those still answering once `ms` is up (none: all let go before). */
const stillBusy = async (p: Pick<Parts, 'portBusy' | 'portsFreeMs'>, ports: readonly number[]) => {
  const until = Date.now() + p.portsFreeMs;

  for (;;) {
    const busy: number[] = [];

    for (const port of ports) if (await p.portBusy(port)) busy.push(port);
    if (busy.length === 0 || Date.now() >= until) return busy;
    await Bun.sleep(100);
  }
};

/** The queue of a repo's fixed ports: one start or stop on them at a time. */
const portsQueue = (repo: string) => `ports:${repo}`;

/**
 * The fixed ports a prototype's app takes (ADR 0039): its repo's, for a prototype session's on
 * this Mac; none on a box, or for one of injected changes.
 */
const fixedOf = async (p: Pick<Parts, 'fixedPorts'>, meta: PrototypeMeta) =>
  meta.code?.box !== null ? [] : ((await p.fixedPorts?.(meta.repo)) ?? []);

/** The others of the repo whose apps hold its fixed ports now. */
const onThePorts = async (p: Pick<Parts, 'local'>, meta: PrototypeMeta) =>
  (await p.local.all()).filter(
    (m) =>
      m.id !== meta.id && m.repo === meta.repo && m.ports.length > 0 && RUNNING.includes(m.state),
  );

/**
 * The app at `meta.commit` started: live, or failed and why. A repo whose app takes fixed ports
 * (ADR 0039) on its ports' queue: the prototype on them now stopped (kept), the session's app on
 * them stopped (`takePorts`, the main checkout's), then the `start` hook the normal way with
 * dev's values, its own URL the preview link, no proxy; a failure hands them back. Any other
 * behind the proxy, as below.
 */
export const launch = async (
  p: Parts,
  meta: PrototypeMeta,
  cause: string,
): Promise<Outcome<PrototypeData>> => {
  const fixed = await fixedOf(p, meta);

  return fixed.length === 0
    ? startApp(p, meta, cause, [])
    : p.serial(portsQueue(meta.repo), async () =>
        startApp(p, (await fresh(p, meta.id)) ?? meta, cause, fixed),
      );
};

/**
 * The app started, the proxy put in front of it unless it takes `fixed` ports. In order (#349):
 * its port base held, a card worktree's copies brought in, its database had (its repo's hook's
 * or its own in the Mac database; seeded once when just made), then the start script (the
 * `prototype-start` hook with its env file's values, else the `start`; on fixed ports the
 * `start` alone, with dev's) with `DATABASE_URL` and `ABE_PORT_BASE`; what it said, its values
 * redacted.
 */
const startApp = async (
  p: Parts,
  meta: PrototypeMeta,
  cause: string,
  fixed: readonly number[],
): Promise<Outcome<PrototypeData>> => {
  const direct = fixed.length > 0;
  const portBase = p.ports?.take(meta.id, meta.portBase ?? undefined) ?? meta.portBase;
  const own: Record<string, string> = {
    ABE_PROTOTYPE: meta.id,
    ...(portBase === null ? {} : { [PORT_BASE]: String(portBase) }),
  };
  const starting = await moved(
    p,
    { ...meta, portBase, ports: [] },
    { state: 'starting', url: meta.url, app: null, step: 'database' },
    cause,
  );
  let kept = starting;
  const fail = async (message: string) => {
    // never a value the start was handed
    const said = redactText(message, secrets);

    await p.proxy.close(meta.id);
    p.ports?.release(meta.id);
    // the ports back to the app they were taken from
    if (direct) await p.hand?.givePorts(meta.repo, meta.id);
    await moved(p, kept, { state: 'failed', url: null, app: null, reason: said }, 'start-failed');

    return refused('prototype-start-failed', said);
  };
  const hooks = hooksOf(p, meta.repo);
  const valued = direct
    ? await devValues(p, meta.repo)
    : await startValues(p, meta.repo, meta.code?.worktree ?? meta.repo);
  const secrets = valued.ok ? injectedSecrets(valued.data.values) : [];

  if (!valued.ok)
    return fail(
      `${direct ? hooks.start : hooks['prototype-start']}'s env file: ${valued.error.message}`,
    );
  if (direct) {
    // one prototype on the ports at a time: the one there now stopped, its worktree, chat and
    // database kept
    for (const other of await onThePorts(p, meta))
      await stopApp(p, other, 'ports-taken', false).catch(() => undefined);
    const took = (await p.hand?.takePorts(meta.repo, meta.id)) ?? { ok: true as const, data: null };

    if (!took.ok)
      return fail(`the app on ${portsWords(fixed)} did not stop: ${took.error.message}`);
    const busy = await stillBusy(p, fixed);

    if (busy.length > 0)
      return fail(
        `${portsWords(busy)} ${busy.length === 1 ? 'is' : 'are'} in use by an app Abe did not start (a terminal's dev server?): stop it (lsof -nP -iTCP:${String(busy[0])} -sTCP:LISTEN names it), then start the prototype again`,
      );
  }
  /** The database step done (had, or none to have): the start's step next. */
  const toStart = async (change: Partial<PrototypeMeta> = {}) => {
    kept = await moved(
      p,
      { ...kept, ...change },
      { state: 'starting', url: meta.url, app: null, step: 'start' },
      'database',
    );
  };
  const prepare = async (dir: string) => {
    const databases = p.databases;

    if (databases === undefined) {
      await toStart();

      return { ok: true as const, env: {} };
    }
    const got = await databases.ensure({
      dir,
      repo: basename(meta.repo),
      ...dbNames(meta.id),
      env: own,
      seed: true,
      run: scriptRun(p, meta.id),
    });

    if (!got.ok) return { ok: false as const, message: dbFailureWords(got.failure) };
    if (got.db === undefined) {
      await toStart();

      return { ok: true as const, env: {} };
    }
    const database = {
      name: got.db.name,
      by: got.db.by,
      seeded: got.db.seeded || (kept.database?.seeded ?? false),
    };

    await toStart({ database });

    return { ok: true as const, env: { [WORKSPACE_DATABASE]: got.db.url } };
  };
  let started: Awaited<ReturnType<PrototypeApps['start']>>;

  try {
    // A card worktree's copies (an untracked `.abe/` among them), so its start script is there,
    // and the repo's worktree recipe (its env files) and its worktree-setup hook.
    const copy = (await p.worktreeCopies?.(meta.repo)) ?? [];

    started = await p.apps.start({
      id: meta.id,
      repo: meta.repo,
      commit: meta.commit,
      // the env file's values first, Abe's own over them (its port, its database)
      env: { ...valued.data.values, ...own },
      copy,
      hooks,
      prepare,
      // A developer's prototype (#83) runs from its own worktree, as its session writes it.
      ...(meta.code === null ? {} : { dir: meta.code.worktree }),
      ...(direct ? { script: 'start' as const } : {}),
    });
  } catch (err) {
    // Never left `starting`, nor a worktree behind.
    await p.apps
      .stop({ id: meta.id, repo: meta.repo, env: portEnv(kept), hooks })
      .catch(() => undefined);

    return fail(err instanceof Error ? err.message : String(err));
  }

  if (!started.ok) return fail(started.error.message);
  const answer = startAnswer(started.data.ran, started.data.script);

  if (!answer.ok) {
    await p.apps.stop({ id: meta.id, repo: meta.repo, env: portEnv(kept), hooks });

    return fail(answer.message);
  }
  // on fixed ports the app's own URL, so its sign-in comes back to it; else the proxy's
  const { url } = direct
    ? { url: answer.origin }
    : await p.proxy.open({
        id: meta.id,
        app: answer.origin,
        refused: (r) => {
          // The log is evidence, never a reason to fail the answer.
          void p.local.refused(meta.id, now(p), r).catch(() => undefined);
          p.emit('prototype.refused', { id: meta.id, ...r });
        },
      });
  const live = await moved(
    p,
    { ...kept, ports: [...fixed] },
    { state: 'live', url, app: answer.origin },
    cause,
  );

  return { ok: true, data: prototypeData(live) };
};

/** `:4000`, `:4000 and :4001`: ports as words. */
const portsWords = (ports: readonly number[]) => ports.map((n) => `:${String(n)}`).join(' and ');

/** What a start on fixed ports gets, as `abe run start` does: dev's Abe env file's values. */
const devValues = async (
  p: Pick<Parts, 'appValues'>,
  repo: string,
): Promise<Outcome<{ env: 'dev'; values: Record<string, string> }>> => {
  const got =
    p.appValues === undefined ? { ok: true as const, data: {} } : await p.appValues(repo, 'dev');

  return got.ok ? { ok: true, data: { env: 'dev', values: got.data } } : got;
};

/**
 * Stops the app and the proxy; the prototype, its worktree and session stay. One on the fixed
 * ports (ADR 0039) on their queue, and the last of the repo's there hands them back (`givePorts`:
 * the main checkout's app started again) unless `handBack` is false (a restart, another
 * prototype taking them, serve stopping).
 */
export const halt = (
  p: Parts,
  meta: PrototypeMeta,
  cause: string,
  o: { handBack?: boolean } = {},
): Promise<PrototypeMeta> =>
  meta.ports.length === 0
    ? stopApp(p, meta, cause, false)
    : p.serial(portsQueue(meta.repo), async () =>
        stopApp(p, (await fresh(p, meta.id)) ?? meta, cause, o.handBack ?? true),
      );

/** `halt` on its queue already: stopped, the ports handed back when `handBack` and none holds them. */
const stopApp = async (p: Parts, meta: PrototypeMeta, cause: string, handBack: boolean) => {
  let failure: Error | undefined;

  try {
    await p.proxy.close(meta.id);
    await p.apps.stop({
      id: meta.id,
      repo: meta.repo,
      env: portEnv(meta),
      hooks: hooksOf(p, meta.repo),
    });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }
  // Its port base goes; its database stays for its next start (#349).
  p.ports?.release(meta.id);
  // Stopped whatever went wrong on the way: nothing serves it any more.
  const stopped = await moved(
    p,
    { ...meta, ports: [] },
    { state: 'stopped', url: null, app: null },
    cause,
  );

  // the last on the fixed ports: the app they were taken from back on them
  if (handBack && meta.ports.length > 0 && (await onThePorts(p, meta)).length === 0) {
    await stillBusy(p, meta.ports);
    await p.hand?.givePorts(meta.repo, meta.id);
  }
  if (failure !== undefined) throw failure;

  return stopped;
};

/**
 * Its database's end (#349), once it is discarded or done with: its hook's `stop`, or its own in
 * the Mac database dropped, in its checkout (a developer's prototype's worktree). Kept with none
 * after only once it is gone; what was done, in words.
 */
export const dropDatabase = async (p: Parts, meta: PrototypeMeta): Promise<string | undefined> => {
  const db = meta.database;

  if (db === null || p.databases === undefined) return undefined;
  const worktree = meta.code?.worktree;
  const released = await p.databases.release({
    // Its hook as its worktree has it, while that is there; else the repo's.
    dir:
      worktree !== undefined && existsSync(join(worktree, hooksOf(p, meta.repo).db))
        ? worktree
        : meta.repo,
    ...dbNames(meta.id),
    env: { ABE_PROTOTYPE: meta.id, ...portEnv(meta) },
    by: db.by,
    run: scriptRun(p, meta.id),
  });
  if (released?.done !== false) {
    const now0 = (await fresh(p, meta.id)) ?? meta;

    await p.local.write({ ...now0, database: null });
  }

  return released?.said;
};

/** The same prototype read again inside its queue: another change may have come first. */
export const fresh = async (p: Pick<Parts, 'local'>, id: string) =>
  (await p.local.all()).find((m) => m.id === id);

export const openPrototypes = (o: PrototypesOptions & PrototypesShared): Prototypes => {
  const queues = new Map<string, Promise<unknown>>();
  const parts: Parts = {
    local: localPrototypes(o.dir),
    apps: o.apps,
    proxy: o.proxy,
    clock: o.clock,
    emit: o.emit,
    databases: o.databases,
    ports: o.ports,
    worktreeCopies: o.worktreeCopies,
    hooks: o.hooks,
    appValues: o.appValues,
    fixedPorts: o.fixedPorts,
    hand: o.hand,
    portBusy: o.portBusy ?? portAnswers,
    portsFreeMs: o.portsFreeMs ?? PORTS_FREE_MS,
    serial: <T>(id: string, run: () => Promise<T>) => serial(id, run),
  };
  const serial = <T>(id: string, run: () => Promise<T>) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(run, run);

    queues.set(
      id,
      next.catch(() => undefined),
    );

    return next;
  };
  const running = async () => (await parts.local.all()).filter((m) => RUNNING.includes(m.state));
  const ready = running()
    .then(async (left) => {
      // One that fails to stop does not keep the others running.
      for (const meta of left)
        await halt(parts, meta, 'serve-restarted', { handBack: false }).catch(() => undefined);
      // Done with while its database could not be dropped (Docker down): dropped now (#349).
      const undropped = (await parts.local.all()).filter(
        (m) => m.code?.ended === true && m.database !== null,
      );

      for (const meta of undropped)
        await serial(meta.id, () => dropDatabase(parts, meta)).catch(() => undefined);
    })
    .catch(() => undefined);

  return {
    ...parts,
    worktrees: o.worktrees,
    shot: o.shot,
    dir: o.dir,
    serial,
    ready,
    close: async () => {
      await ready;
      await Promise.all(
        (await running()).map((meta) =>
          serial(meta.id, async () =>
            halt(parts, (await fresh(parts, meta.id)) ?? meta, 'serve-stopped', {
              handBack: false,
            }).catch(() => undefined),
          ),
        ),
      );
    },
  };
};

export const withPrototypes = async <T>(
  ctx: PrototypesCtx,
  then: (p: Prototypes) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  if (ctx.serve.prototypes === undefined) return NO_PROTOTYPES;
  await ctx.serve.prototypes.ready;

  return then(ctx.serve.prototypes);
};

/** The prototype a prototype session is on; undefined for anyone else. */
const chatOf = (ctx: OwnCtx) =>
  ctx.session === undefined
    ? undefined
    : (ctx.serve.sessions?.metaOf(ctx.session)?.prototype ?? undefined);

/**
 * The prototype `--id` names, else the one that runs. A prototype session acts only on its own
 * prototype, named or not.
 */
const which = async (
  p: Prototypes,
  named: string | undefined,
  ctx: OwnCtx,
): Promise<Outcome<PrototypeMeta>> => {
  const chat = chatOf(ctx);

  if (chat !== undefined && named !== undefined && named !== chat.id)
    return refused(
      'not-your-session',
      `session ${ctx.session ?? ''} is the prototype session of ${chat.id}: it may not act on ${named}`,
    );
  const id = chat?.id ?? named;
  const all = await p.local.all();

  if (id !== undefined) {
    const meta = all.find((m) => m.id === id);

    return meta === undefined
      ? refused('not-found', `no prototype is ${id}`)
      : { ok: true, data: meta };
  }
  const running = all.filter((m) => RUNNING.includes(m.state));
  const [only] = running;

  if (only === undefined)
    return refused(
      'no-prototype',
      'no prototype runs: abe prototype start --repo <checkout> (or name one with --id)',
    );
  if (running.length > 1)
    return refused(
      'which-prototype',
      `${running.length} prototypes run (${running.map((m) => m.id).join(', ')}): name one with --id`,
    );

  return { ok: true, data: only };
};

/**
 * `run` on the prototype `--id` names (else the one that runs), inside its queue, with it read
 * again there: another change may have come first.
 */
export const queued = async <T>(
  p: Prototypes,
  id: string | undefined,
  ctx: OwnCtx,
  run: (meta: PrototypeMeta) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const target = await which(p, id, ctx);

  if (!target.ok) return target;

  return p.serial(target.data.id, async () => run((await fresh(p, target.data.id)) ?? target.data));
};

/**
 * `run` on prototype `id` in its queue, a start of it under way ended first (its script's group
 * killed): a restart never waits behind a start that does not end.
 */
export const restartPrototype = <T>(
  p: Prototypes,
  id: string,
  run: (meta: PrototypeMeta) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  p.apps.cancel?.(id);

  return p.serial(id, async () => {
    const meta = await fresh(p, id);

    return meta === undefined ? refused('no-prototype', `no prototype ${id}`) : run(meta);
  });
};

/** A new prototype at `head` for `card`, not yet started (nothing written). */
export const newMeta = async (
  p: Prototypes,
  head: PrototypeHead,
  card: number | null,
): Promise<PrototypeMeta> => {
  const taken = new Set((await p.local.all()).map((m) => m.id));
  let id = prototypeId(randomBytes(3).toString('hex'));

  while (taken.has(id)) id = prototypeId(randomBytes(3).toString('hex'));

  return {
    id,
    card,
    ...head,
    state: 'starting',
    since: now(p),
    url: null,
    app: null,
    reason: null,
    screenshots: [],
    code: null,
    database: null,
    portBase: null,
    step: null,
    ports: [],
  };
};

export const prototypeHandlers = <C extends PrototypesCtx>() =>
  ({
    'prototype screenshot add': (args, ctx) =>
      withPrototypes(ctx, async (p) => {
        if (args.what.trim() === '') return usage('--what says what the screenshot shows');
        const own = await ownPath(ctx, args.file);

        if (!own.ok) return own;
        let png: Uint8Array;

        try {
          png = new Uint8Array(await readFile(own.data));
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);

          return refused('unreadable-file', `cannot read ${own.data}: ${why}`);
        }
        if (!isPng(png)) return refused('not-png', `${own.data} is not a PNG`);

        return queued(p, args.id, ctx, async (meta) => {
          const n = Math.max(0, ...meta.screenshots.map((x) => x.n)) + 1;
          const screenshot = { n, file: screenshotFile(n), what: args.what.trim(), at: now(p) };
          const path = await p.local.writeScreenshot(meta.id, screenshot.file, png);
          const next = { ...meta, screenshots: [...meta.screenshots, screenshot] };

          await p.local.write(next);

          return {
            ok: true,
            data: { id: meta.id, screenshot, screenshots: next.screenshots, path },
          };
        });
      }),
    'prototype stop': (args, ctx) =>
      withPrototypes(ctx, (p) =>
        queued(p, args.id, ctx, async (meta) => ({
          ok: true,
          data: prototypeData(await halt(p, meta, 'stop')),
        })),
      ),
    'prototype restart': (args, ctx) =>
      withPrototypes(ctx, async (p) => {
        const target = await which(p, args.id, ctx);

        if (!target.ok) return target;

        return restartPrototype(p, target.data.id, async (meta) => {
          if (meta.code?.ended === true)
            return refused(
              'prototype-ended',
              `prototype ${meta.id} is done with (discarded): abe prototype start starts another`,
            );
          if (meta.code !== null && meta.code.box !== null)
            return refused(
              'prototype-on-box',
              `prototype ${meta.id} runs on ${meta.code.box}: its session starts its app there (ask it in Chat)`,
            );
          // its ports kept for its own start again
          const stopped = RUNNING.includes(meta.state)
            ? await halt(p, meta, 'restart', { handBack: false })
            : meta;

          return launch(p, stopped, 'restart');
        });
      }),
    'prototype list': (_, ctx) =>
      withPrototypes(ctx, async (p) => {
        const all = await Promise.all((await p.local.all()).map((m) => forwarded(ctx, p, m)));
        const more = (m: PrototypeMeta) => {
          const shot = newestShot(m.screenshots);

          return {
            title: prototypeWords(ctx.serve.sessions?.metaOf(m.code?.session ?? '')?.title),
            shot: shot === undefined ? null : p.local.screenshotPath(m.id, shot.file),
          };
        };

        return {
          ok: true,
          data: {
            prototypes: all
              .sort((a, b) => b.since.localeCompare(a.since))
              .map((m) => prototypeData(m, more(m))),
          },
        };
      }),
  }) satisfies Partial<Handlers<C>>;
