/**
 * A local session's apps and database (#182, #146, #349), by the Mac's `serve`, outside the
 * session's sandbox: `abe run <script>` from a session runs the Verification pack's script in its
 * worktree (or Before's, `<worktree>-base`) as a box's `abe run` does in its workspace, with
 * `APP_ENV` of `serve`'s environment (no token, as a check's, never `serve`'s own `DATABASE_URL`),
 * the session's own database and its port base (`ABE_PORT_BASE`); the database is the repo's hook
 * (`db start`, its `db` hook point) or the session's own in Abe's Mac database (`abe_<session>`), had at
 * the launch (idempotent: asked again by a `serve` started again, and for the run's checks); `end`
 * stops what the session left running, then stops its hook's database or drops its own. A Factory
 * install's scripts read none of its never-read files, as its session reads none. A script that
 * may run docker compose gets its card's own project, on the local Docker only (core's
 * `compose.ts`), and the session's end takes the projects it was handed down. One runner per
 * session: a second `abe run` while one runs is refused `one-runner` (`stop` always runs).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  appEnv,
  awsOffEnv,
  baseComposeProject,
  awsKeysOnlyEnv,
  awsHome,
  baseWorktreePath,
  type Compose,
  COMPOSE_NOT_LOCAL,
  COMPOSE_PROJECT,
  composeFilesOf,
  composeNotLocal,
  composeProject,
  fixedHostPorts,
  fixedHostPortsWarning,
  DOCKER_KEYS,
  dotEnvDocker,
  mayRunCompose,
  DB_NAME,
  dbEnv,
  dbFailureWords,
  macDbName,
  NO_DOCKER,
  type Outcome,
  PACK_SCRIPT_TIMEOUT_MS,
  runScriptIn,
  runScriptsWords,
  refused,
  type RunData,
  type SessionApps,
  type SessionMeta,
  sessionAppEnv,
  takesOwnDatabase,
  injectedSecrets,
  type KnownSecret,
  redactText,
  type AbeEnv,
  envNotEnabled,
  withOwnReach,
} from '@abe/core';
import { committedHooks, type Env, realPath, sessionDir } from '@abe/ports';
import { z } from 'zod';
import { awsOffFile } from '../install/aws-off';
import { type Databases, type RunScript } from './databases';
import { realPathAt } from '../contract/here';
import { type PortBases } from './port-bases';

export type LocalApps = {
  /** `abe run <path> <args…> [--env <env>]` from the session `meta` (`dev` when none). */
  run: (
    meta: SessionMeta,
    path: string,
    args: readonly string[],
    env?: string,
  ) => Promise<Outcome<RunData>>;
  /**
   * The session's database URL, once per `serve`: its repo's `db` hook's (`db start` in
   * its checkout, `repo`) or its own in the Mac database; undefined when the repo needs none.
   * Refused in words when it cannot be had: `no-docker` (Docker down or missing), else
   * `no-database` (the hook failed, or the Mac database did).
   */
  database: (o: {
    id: string;
    repo: string;
    /** A Factory install's session: aws off as its install says. */
    install?: boolean;
  }) => Promise<Outcome<string | undefined>>;
  /** The hook's `stop`, or its Mac database dropped; what it did. */
  stopDatabase: (o: { id: string; repo: string; install?: boolean }) => Promise<string | undefined>;
  /** Sessions with kept apps or a database started, as on disk: one ended may have left them. */
  leftBehind: () => string[];
  /** The session ended: what it left running stopped, its database stopped; what was done. */
  end: (meta: SessionMeta) => Promise<string[]>;
  /**
   * Prototype `by`'s app takes `repo`'s fixed ports (ADR 0039): a session's app holding them (the
   * main checkout's, the Abe chat's `abe run start`, or a card's) stopped by its `stop`, kept to
   * start again, and the ports held by `by` until `givePorts`: a session's `start` meanwhile is
   * refused `ports-held`, naming it. What it did, in words (null: nothing held them); refused
   * when the stop could not run.
   */
  takePorts: (repo: string, by: string) => Promise<Outcome<string | null>>;
  /**
   * Prototype `by` hands `repo`'s fixed ports back: the app `takePorts` stopped started again, as
   * its start ran (its script, arguments and environment), while its session runs. What it did.
   */
  givePorts: (repo: string, by: string) => Promise<string | null>;
};

/** What a session was handed for compose: its project and the `DOCKER_*` it ran with. */
const ComposeRecords = z.array(
  z.object({ project: z.string(), docker: z.record(z.string(), z.string()) }),
);
type ComposeRecord = z.infer<typeof ComposeRecords>[number];

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const dockerOf = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    DOCKER_KEYS.flatMap((k) => ((env[k] ?? '') === '' ? [] : [[k, env[k] ?? '']])),
  );

/** How a session's app was started: what `givePorts` starts again. */
type StartedBy = { named: string; args: readonly string[]; env: string };

/**
 * What holds a repo's fixed ports, since when: a session's app (and how it started), or a
 * prototype's (ADR 0039).
 */
type PortsHolder =
  | { kind: 'session'; id: string; card: number | null; since: string; start: StartedBy }
  | { kind: 'prototype'; id: string; since: string };

/** Why a second app of the repo can't start: its fixed ports, and the session or prototype holding them. */
export const portsHeldText = (ports: readonly number[], h: PortsHolder): string =>
  h.kind === 'prototype'
    ? `the repo's app takes fixed ports (${ports.join(', ')}), held by prototype ${h.id} since ${h.since}: its app runs on them. Wait until it stops (abe prototype stop --id ${h.id}, or Discard); the app it stopped starts again then`
    : `the repo's app takes fixed ports (${ports.join(', ')}), held by session ${h.id}${h.card === null ? '' : ` (card ${h.card})`} since ${h.since}: its verify runs first. Wait until it runs abe run stop or ends, then start again`;

export const localApps = (o: {
  apps: SessionApps;
  env: Env;
  stateDir: string;
  databases: Databases;
  ports?: PortBases;
  /**
   * Whether aws is off for a session's scripts and database hook in `repo` (a Factory install's,
   * `install`, or a local-mode card session's): they run with aws failing closed (`awsOffEnv`).
   * None: never.
   */
  awsOff?: (at: { repo: string; install: boolean }) => Promise<boolean>;
  /**
   * The environments `repo`'s agents reach (ADR 0029, `agents.<env>`): `abe run --env` in another
   * is refused before anything is read or run. None: dev and test.
   */
  agentEnvs?: (repo: string) => readonly AbeEnv[];
  /**
   * The ports `repo`'s app always takes (`ports.fixed` in its abe.yaml, and what its install read
   * fixed: an auth redirect registered for one port): two sessions' apps can't both run, so a
   * second `start` while one holds them is refused, naming the holder. None: no fixed ports.
   */
  fixedPorts?: (repo: string) => Promise<readonly number[]>;
  /**
   * What a pack script in `repo` runs with besides Abe's own (ADR 0028): the environment `env`'s
   * Abe env file and its aws profile's short-lived keys, their values, or why not (an expired aws
   * login). None: nothing.
   */
  injected?: (repo: string, env: string) => Promise<Outcome<Record<string, string>>>;
  /**
   * The values to redact from what a script says besides those it got: every Abe env file's in
   * `repo`, whichever environment it ran in. None: only its own.
   */
  redacted?: (repo: string) => Promise<readonly KnownSecret[]>;
  /** Docker compose on the local machine. None: scripts get no compose project, and none is taken down. */
  compose?: Compose;
  /** A session as serve knows it now (`Sessions.metaOf`), for `takePorts` and `givePorts`. None: none known. */
  metaOf?: (id: string) => SessionMeta | undefined;
}): LocalApps => {
  /**
   * A script's environment: aws failing closed when it is off for the session, else only the
   * short-lived keys it was handed (`keys`, ADR 0029): never a profile of `~/.aws`.
   */
  const offEnv = async (
    at: { repo: string; install: boolean },
    env: Record<string, string>,
    keys: Readonly<Record<string, string>> = {},
  ) =>
    (await o.awsOff?.(at)) === true
      ? awsOffEnv(env, awsOffFile(o.stateDir))
      : awsKeysOnlyEnv(env, awsOffFile(o.stateDir), keys);
  const scriptEnv = (
    meta: SessionMeta,
    env: Record<string, string>,
    keys: Readonly<Record<string, string>> = {},
  ) => offEnv({ repo: meta.repo, install: meta.kind === 'abe' }, env, keys);
  // Its database had, said on disk with where it came from: a serve started again ends it too.
  const dbMark = (id: string) => join(sessionDir(o.stateDir, id), 'apps', 'db.started');
  // Its port base, kept on disk: a serve started again hands the same one on when it is free.
  const baseFile = (id: string) => join(sessionDir(o.stateDir, id), 'apps', 'port.base');
  const portOf = (id: string): number | undefined => {
    if (o.ports === undefined) return undefined;
    let want: number | undefined;

    try {
      const n = Number(readFileSync(baseFile(id), 'utf8').trim());

      want = Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      want = undefined;
    }
    const base = o.ports.take(id, want);

    if (base !== undefined && base !== want) {
      mkdirSync(dirname(baseFile(id)), { recursive: true, mode: 0o700 });
      writeFileSync(baseFile(id), String(base));
    }

    return base;
  };
  // The compose projects it was handed, kept on disk: a serve started again takes them down too.
  const composeFile = (id: string) => join(sessionDir(o.stateDir, id), 'apps', 'compose.json');
  const composeRecords = (id: string): ComposeRecord[] => {
    try {
      return ComposeRecords.parse(JSON.parse(readText(composeFile(id)) ?? '[]'));
    } catch {
      return [];
    }
  };
  /** Why compose with `docker` (its `DOCKER_*`) would not run locally, or null. */
  const notLocal = async (compose: Compose, docker: Record<string, string>) => {
    const env = appEnv(o.env, docker);

    return composeNotLocal(
      env,
      (env.DOCKER_HOST ?? '') !== '' ? null : await compose.endpoint(env),
    );
  };
  /** Each project down on the local Docker; what was done, and those still up. */
  const downAll = async (records: readonly ComposeRecord[]) => {
    const said: string[] = [];
    const left: ComposeRecord[] = [];

    if (o.compose === undefined) return { said, left };
    for (const r of records) {
      const why = await notLocal(o.compose, r.docker);

      if (why !== null) {
        said.push(`compose ${r.project} not taken down: ${why}`);
        continue;
      }
      const ran = await o.compose.down({ project: r.project, env: appEnv(o.env, r.docker) });

      if (ran.exit === 0) said.push(`compose ${r.project} down`);
      else {
        left.push(r);
        said.push(
          `compose ${r.project} not taken down: ${ran.stderr.trim() === '' ? `exit ${ran.exit}` : ran.stderr.trim().split('\n').at(-1)}`,
        );
      }
    }

    return { said, left };
  };
  /**
   * What a pack script in `at` runs compose with when it may run it (`mayRunCompose`): its card's
   * own project (Before's beside it); refused `compose-not-local` when Docker is not local, before
   * it runs. Nothing when it runs none.
   */
  const composeEnv = async (
    meta: SessionMeta,
    at: { cwd: string; script: string; base: boolean },
    env: Readonly<Record<string, string>>,
  ): Promise<Outcome<{ env: Record<string, string>; warning: string | null }>> => {
    const text = readText(join(at.cwd, at.script)) ?? '';
    const found = composeFilesOf(text).filter((path) => existsSync(join(at.cwd, path)));

    if (!mayRunCompose(text, found)) return { ok: true, data: { env: {}, warning: null } };
    // a host port the compose file publishes as a number: two cards at once clash on it
    const warning = fixedHostPortsWarning(
      found.flatMap((path) => fixedHostPorts(path, readText(join(at.cwd, path)) ?? '')),
    );

    if (o.compose === undefined) return { ok: true, data: { env: {}, warning } };
    // compose takes `DOCKER_*` from a `.env` beside its file when the environment has none
    const docker = { ...dockerOf(env) };

    for (const dir of [...new Set(['.', ...found.map((f) => dirname(f))])])
      Object.assign(
        docker,
        dotEnvDocker({ ...env, ...docker }, readText(join(at.cwd, dir, '.env'))),
      );
    const why = await notLocal(o.compose, docker);

    if (why !== null) return refused(COMPOSE_NOT_LOCAL, `${at.script} not run: ${why}`);
    const own = composeProject(meta.repo, meta.card ?? meta.id);
    const project = at.base ? baseComposeProject(own) : own;
    const had = composeRecords(meta.id).filter((r) => r.project !== project);

    mkdirSync(dirname(composeFile(meta.id)), { recursive: true, mode: 0o700 });
    writeFileSync(composeFile(meta.id), JSON.stringify([...had, { project, docker }]));

    return { ok: true, data: { env: { [COMPOSE_PROJECT]: project }, warning } };
  };
  // The sessions with an `abe run` running: one runner per run, never two.
  const running = new Set<string>();
  // by session: the last `abe run` still reading its hooks and ports; the next waits, so the first called wins
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = <T>(id: string, step: () => Promise<T>): Promise<T> => {
    const next = (turns.get(id) ?? Promise.resolve()).then(step, step);

    turns.set(id, next);
    void next.finally(() => turns.get(id) === next && turns.delete(id)).catch(() => undefined);

    return next;
  };
  // by repo: the session or prototype whose app holds its fixed ports
  const held = new Map<string, PortsHolder>();
  // by repo: the session's app a prototype's took the ports from, to start again
  const yielded = new Map<string, Extract<PortsHolder, { kind: 'session' }>>();
  const urls = new Map<string, string>();
  const names = (id: string) => ({ mac: macDbName.session(id), hook: DB_NAME(id) });
  /** The hook run as before: a one-off of the session's, its output in its apps folder. */
  const runOf =
    (id: string): RunScript =>
    (r) =>
      o.apps.run({ id, ...r, keep: false });
  const byOf = (id: string): 'hook' | 'mac' | undefined => {
    try {
      const text = readFileSync(dbMark(id), 'utf8').trim();

      return text === 'mac' ? 'mac' : 'hook';
    } catch {
      return undefined;
    }
  };

  const database: LocalApps['database'] = async ({ id, repo, install = false }) => {
    const known = urls.get(id);

    if (known !== undefined) return { ok: true, data: known };
    const got = await o.databases.ensure({
      dir: repo,
      repo: basename(repo),
      ...names(id),
      env: await offEnv({ repo, install }, dbEnv(o.env, id, portOf(id))),
      // A session's agent seeds as its pack says (`abe run seed`): never in the person's checkout.
      seed: false,
      run: runOf(id),
    });

    if (!got.ok) {
      // an install's session is on this machine only: no cloud target to offer
      const words = install
        ? dbFailureWords(got.failure)
        : `${dbFailureWords(got.failure)}, or launch on the cloud target (--target cloud), whose workspace has one`;

      // Only Docker's absence lets a session run without one; any other failure refuses it.
      const docker = got.failure.kind === 'docker-down' || got.failure.kind === 'no-docker';

      return refused(docker ? NO_DOCKER : 'no-database', words);
    }
    if (got.db === undefined) return { ok: true, data: undefined };
    urls.set(id, got.db.url);
    mkdirSync(dirname(dbMark(id)), { recursive: true, mode: 0o700 });
    writeFileSync(dbMark(id), got.db.by);

    return { ok: true, data: got.db.url };
  };

  const stopDatabase: LocalApps['stopDatabase'] = async ({ id, repo, install = false }) => {
    urls.delete(id);
    const by = byOf(id);
    const released = await o.databases.release({
      dir: repo,
      ...names(id),
      env: await offEnv({ repo, install }, dbEnv(o.env, id, portOf(id))),
      by,
      run: runOf(id),
    });

    // Kept until it is gone: a serve started again tries again (`leftBehind`).
    if (released === undefined || released.done) rmSync(dbMark(id), { force: true });
    // Its port base goes with it (a launch that failed after its database was had holds none).
    o.ports?.release(id);
    rmSync(baseFile(id), { force: true });

    return released?.said;
  };

  /** Its own database, or none when it cannot be had now (the script then runs without). */
  const urlOf = async (meta: SessionMeta) => {
    const db = await database({
      id: meta.id,
      repo: meta.repo,
      install: meta.kind === 'abe',
    });

    return db.ok ? db.data : undefined;
  };

  /** A pack script run to its end, with the person's credentials, Abe's own and its compose project. */
  const runScript = async (
    meta: SessionMeta,
    at: { cwd: string; script: string; stop: string },
    args: readonly string[],
    envName: string,
    workdir: string,
  ): Promise<Outcome<RunData>> => {
    // the person's credentials for the app first, Abe's own over them (its port, its database)
    const injected = (await o.injected?.(meta.repo, envName)) ?? {
      ok: true as const,
      data: {},
    };

    if (!injected.ok) return injected;
    // in dev its own over dev's file's; against another environment that one's file's, never this machine's
    const env = await scriptEnv(
      meta,
      {
        ...injected.data,
        ...sessionAppEnv(
          o.env,
          meta.id,
          takesOwnDatabase(envName) ? await urlOf(meta) : undefined,
          portOf(meta.id),
        ),
      },
      injected.data,
    );
    const base = at.cwd !== workdir && at.cwd !== realPath(workdir);
    const compose = await composeEnv(meta, { ...at, base }, env);

    if (!compose.ok) return compose;
    const ran = await o.apps.run({
      id: meta.id,
      cwd: at.cwd,
      script: at.script,
      args,
      env: { ...env, ...compose.data.env },
      timeoutMs: PACK_SCRIPT_TIMEOUT_MS,
      keep: true,
      stop: at.stop,
      // run outside the sandbox, it still reads no profile of ~/.aws (ADR 0029)
      denyRead: [awsHome(o.env.HOME ?? '/')],
    });
    // what the session reads back: no value it was given, nor any Abe env file's
    const secrets = [...injectedSecrets(injected.data), ...((await o.redacted?.(meta.repo)) ?? [])];

    return {
      ok: true,
      data: {
        script: at.script,
        cwd: at.cwd,
        ...ran,
        stdout: redactText(ran.stdout, secrets),
        stderr: redactText(ran.stderr, secrets),
        ...(compose.data.warning === null ? {} : { warning: compose.data.warning }),
      },
    };
  };

  const apps: Omit<LocalApps, 'takePorts' | 'givePorts'> = {
    database,
    stopDatabase,
    leftBehind: () => {
      const dir = join(o.stateDir, 'sessions');

      return existsSync(dir)
        ? readdirSync(dir).filter((id) =>
            ['apps.jsonl', 'db.started', 'compose.json'].some((f) =>
              existsSync(join(dir, id, 'apps', f)),
            ),
          )
        : [];
    },
    run: async (meta, named, args, envName = 'dev') => {
      const taken = await inTurn(meta.id, async () => {
        // Before's script by its absolute path, as its worktree is named: through any symlink (#337)
        const path = isAbsolute(named) ? realPathAt('/', named) : named;
        const trees = { workdir: meta.worktree, base: baseWorktreePath(meta.repo, meta.branch) };
        // what an agent may run: the main checkout's committed abe.yaml's, as a box is handed
        const hooks = await committedHooks(meta.repo);
        const at =
          runScriptIn(hooks, trees, path) ??
          runScriptIn(
            hooks,
            { workdir: realPath(trees.workdir), base: realPath(trees.base) },
            path,
          );

        if (meta.worktree === '' || at === undefined)
          return refused(
            'not-a-pack-script',
            `${path} is no Verification pack script: ${runScriptsWords(hooks)}, in ${trees.workdir} or ${trees.base}`,
            2,
          );
        // an environment off for agents: never its values, its aws keys or its hosts (ADR 0029)
        const off = (['dev', 'test', 'prod'] as const).find(
          (e) =>
            e === envName &&
            !withOwnReach(
              o.agentEnvs?.(meta.repo) ?? ['dev', 'test'],
              meta.prodOn === true,
            ).includes(e),
        );

        if (off !== undefined) return refused('env-off', envNotEnabled(off), 2);
        // one runner per run: a script beside one still running is refused (stop always runs)
        const mine = at.role !== 'stop';

        if (mine && running.has(meta.id))
          return refused(
            'one-runner',
            `${at.script} not run: another abe run of this session is still running; one runner drives at a time, so wait for it to end`,
          );
        const starts = at.role === 'start' || basename(at.script) === 'start';
        const fixed = starts ? ((await o.fixedPorts?.(meta.repo)) ?? []) : [];
        const holder = held.get(meta.repo);

        if (
          fixed.length > 0 &&
          holder !== undefined &&
          (holder.kind === 'prototype' || holder.id !== meta.id)
        )
          return refused('ports-held', portsHeldText(fixed, holder));
        if (mine) running.add(meta.id);

        return { ok: 'taken' as const, at, hooks, trees, fixed, holder, mine };
      });

      if (taken.ok !== 'taken') return taken;
      const { at, hooks, trees, fixed, holder, mine } = taken;
      const start: StartedBy = { named, args, env: envName };

      try {
        const ran = await runScript(
          meta,
          { ...at, stop: hooks.stop },
          args,
          envName,
          trees.workdir,
        );

        // its app holds the repo's fixed ports from a good start until its stop or its end
        if (fixed.length > 0 && ran.ok && ran.data.exit === 0)
          held.set(meta.repo, {
            kind: 'session',
            id: meta.id,
            card: meta.card,
            since: new Date().toISOString(),
            start,
          });
        if (at.role === 'stop' && holder?.kind === 'session' && holder.id === meta.id)
          held.delete(meta.repo);

        return ran;
      } finally {
        if (mine) running.delete(meta.id);
      }
    },
    end: async (meta) => {
      const url = urls.get(meta.id);
      const said = await o.apps.end({
        id: meta.id,
        socket: meta.socket,
        env: await scriptEnv(meta, sessionAppEnv(o.env, meta.id, url, portOf(meta.id))),
      });

      // the compose projects it was handed, after its stop script had its say
      const composed = await downAll(composeRecords(meta.id));

      if (composed.left.length === 0) rmSync(composeFile(meta.id), { force: true });
      else writeFileSync(composeFile(meta.id), JSON.stringify(composed.left));
      // a card's, and an install's once its abe run or a check had one
      const install = meta.kind === 'abe';
      const db =
        meta.card === null && !(install && existsSync(dbMark(meta.id)))
          ? undefined
          : await stopDatabase({ id: meta.id, repo: meta.repo, install });

      o.ports?.release(meta.id);
      const h = held.get(meta.repo);

      if (h?.kind === 'session' && h.id === meta.id) held.delete(meta.repo);
      // ended: nothing of it to start again
      if (yielded.get(meta.repo)?.id === meta.id) yielded.delete(meta.repo);
      rmSync(baseFile(meta.id), { force: true });

      return [...said, ...composed.said, ...(db === undefined ? [] : [db])];
    },
  };
  const live = (id: string) => {
    const meta = o.metaOf?.(id);

    return meta === undefined || meta.state === 'ended' ? undefined : meta;
  };
  const since = () => new Date().toISOString();

  return {
    ...apps,
    takePorts: async (repo, by) => {
      const h = held.get(repo);

      // another prototype's: the prototypes stop its app themselves, the ports pass on
      if (h?.kind !== 'session') {
        held.set(repo, { kind: 'prototype', id: by, since: since() });

        return { ok: true, data: null };
      }
      const meta = live(h.id);
      const said: string[] = [];

      if (meta !== undefined) {
        const stopped = await apps.run(meta, 'stop', [], h.start.env);

        if (!stopped.ok) return stopped;
        yielded.set(repo, h);
        said.push(
          `stopped session ${h.id}'s app${h.card === null ? ' (the main checkout)' : ` (card ${h.card})`} for prototype ${by}${stopped.data.exit === 0 ? '' : ` (its stop exit ${String(stopped.data.exit)})`}`,
        );
      }
      held.set(repo, { kind: 'prototype', id: by, since: since() });

      return { ok: true, data: said.length === 0 ? null : said.join('; ') };
    },
    givePorts: async (repo, by) => {
      const h = held.get(repo);

      if (h?.kind !== 'prototype' || h.id !== by) return null;
      held.delete(repo);
      const was = yielded.get(repo);

      yielded.delete(repo);
      const meta = was === undefined ? undefined : live(was.id);

      if (was === undefined || meta === undefined) return null;
      const again = await apps.run(meta, was.start.named, was.start.args, was.start.env);

      return again.ok && again.data.exit === 0
        ? `started session ${was.id}'s app again`
        : `session ${was.id}'s app did not start again: ${again.ok ? `exit ${String(again.data.exit)}` : again.error.message}`;
    },
  };
};
