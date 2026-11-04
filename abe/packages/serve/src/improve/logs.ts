/**
 * `abe log` and the shipping of session logs (ticket #49, ADR 0019): each session's files read
 * where they are (core's `logSourcesOf`), redacted by core (`redactLog`, with the session's
 * `ABE_*` values) and written whole to the log store under `<repo>/<github-login>/<session>/`.
 * `serve` ships every running session every five minutes and once more when it ends; `abe log
 * ship` ships one now. Each shipment is a `log.shipped` event; one on its own that fails is a
 * `log.failed`.
 */
import {
  type EventData,
  abeSecrets,
  type KnownSecret,
  logContentType,
  logKey,
  logListPrefix,
  type LogOwner,
  logPrefix,
  logSessions,
  type LogShipData,
  logSourcesOf,
  type LogStore,
  type Outcome,
  redactLog,
  type ByCard,
  type RunTree,
  refused,
  type ShipReason,
  type Handlers,
} from '@abe/core';
import { readLogSources, sessionDir } from '@abe/ports';
import { type ReachCtx, sessionReach } from '../layer/reach';
import { githubOf } from '../layer/settings';
import { type Sessions } from '../session/sessions';

/** An Improve retro chat's refusal: its log is no card session's (#87). */
const NOT_A_CARD_SESSION = 'not-a-card-session';

const NO_LOG_STORE = 'no-log-store';
const noStoreRefusal = () =>
  refused(
    NO_LOG_STORE,
    "this abe serve has no log store, so no session's logs were kept to look back over (a local install sets none). Keep them on this machine: abe settings set stores.logs file://<a folder> (or s3://<bucket>; $ABE_LOG_STORE wins), then abe serve stop once no session is live: the sessions after that are kept",
  );

export type LogShipperOptions = {
  /** The log store (`$ABE_LOG_STORE`); none: only local mode's sessions are shipped. */
  store: LogStore | undefined;
  /**
   * Where a session of `repo` is shipped instead (local mode, #24: a folder on this Mac, never
   * the log store); none: `store`.
   */
  storeFor?: (repo: string) => LogStore | undefined;
  stateDir: string;
  /** Sessions' `HOME` (a box's: the container's): their transcripts are read only from its `.claude/projects/`. */
  home: string;
  /**
   * Where a session's transcript and worktree are read, by its card: this machine's disk, or on
   * a box its workspace's container (their paths are the container's). None: no sessions.
   */
  tree: ByCard<RunTree> | undefined;
  /** `serve`'s own `DATABASE_URL`: what `sessionEnv` hands every local session, redacted too. */
  database: string | undefined;
  /** How often every running session is shipped (core's `LOG_SHIP_EVERY_MS`). */
  every: number;
  /** Resolves once `serve` has read its sessions back. */
  sessions: Promise<Sessions | undefined>;
  /** What a session's login and Reach are read with: the settings and ports of `serve`. */
  reach: Omit<ReachCtx, 'cwd'>;
  /**
   * The AWS a session's Reach is read with in its checkout (the `box.profile` in force there, ADR
   * 0025); none, or none given: `reach`'s.
   */
  reachAt?: (repo: string) => Partial<Pick<ReachCtx['ports'], 'aws' | 'secrets'>>;
  shipped: (data: EventData<'log.shipped'>) => void;
  failed: (data: EventData<'log.failed'>) => void;
};

export type LogShipper = {
  /**
   * The store `dir`'s sessions are shipped to and read from: local mode's folder on this Mac
   * where `dir` is in it, else the log store; none: neither.
   */
  storeAt: (dir: string) => LogStore | undefined;
  /** Ships the session's logs now, after any shipment of it still running. */
  ship: (id: string, reason: ShipReason) => Promise<Outcome<LogShipData>>;
  /** The session ended: its last shipment, on its own. */
  ended: (id: string) => void;
  /** Stops the five-minute shipping and waits for shipments under way. */
  close: () => Promise<void>;
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const startLogShipper = (o: LogShipperOptions): LogShipper => {
  /** Each session's latest shipment: the next one starts after it, so `end` comes last. */
  const queue = new Map<string, Promise<unknown>>();
  let login: string | undefined;

  const storeAt = (dir: string) => o.storeFor?.(dir) ?? o.store;
  const me = async (): Promise<Outcome<string>> => {
    if (login !== undefined) return { ok: true, data: login };
    const answered = await o.reach.ports.tracking.me();

    if (!answered.ok)
      return refused('no-login', `your GitHub login, for the log store: ${answered.error.message}`);
    login = answered.data.login;

    return { ok: true, data: login };
  };

  /**
   * The values to take out: its `ABE_*` values and `DATABASE_URL` as launched (when this serve
   * did), the Reach and serve's `DATABASE_URL` now, its socket, and every AWS credential this serve
   * handed out (`abe reach creds`).
   */
  const knownSecrets = async (
    id: string,
    repo: string,
    socket: string,
  ): Promise<Outcome<KnownSecret[]>> => {
    const launched = (await o.sessions)?.launchedWith(id);
    const now = await sessionReach(
      { ...o.reach, ports: { ...o.reach.ports, ...o.reachAt?.(repo) }, cwd: repo },
      'local',
    );

    if (!now.ok && launched === undefined)
      return refused(
        'reach-unknown',
        `the session's ABE_* values, to redact, cannot be read: ${now.error.message}`,
      );

    const minted = [...o.reach.serve.creds.values()].flatMap((c) => [
      { kind: 'aws-access-key', value: c.accessKeyId },
      { kind: 'aws-secret-key', value: c.secretAccessKey },
      { kind: 'aws-session-token', value: c.sessionToken },
    ]);

    return {
      ok: true,
      data: [
        ...abeSecrets({
          ...(now.ok ? now.data.env : {}),
          // A session launched by an earlier serve: the database this serve hands sessions.
          ...(o.database === undefined || o.database === '' ? {} : { DATABASE_URL: o.database }),
          ...launched,
          ABE_SOCKET: socket,
        }),
        ...minted,
      ],
    };
  };

  const shipNow = async (id: string, reason: ShipReason): Promise<Outcome<LogShipData>> => {
    const meta = (await o.sessions)?.metaOf(id);

    if (meta === undefined) return refused('no-session', `no session ${id}`);
    // An Improve retro chat (#87) talks about logs already shipped: its own is not a card's log.
    if (meta.card === null)
      return refused(NOT_A_CARD_SESSION, `session ${id} is an Improve retro chat: no card's log`);
    const card = meta.card;
    const store = storeAt(meta.repo);

    if (store === undefined) return noStoreRefusal();
    // a box's session names its repo as GitHub does (`owner/name`); a Mac's, by its checkout
    const repo = /^[\w.-]+\/[\w.-]+$/.test(meta.repo)
      ? { ok: true as const, data: meta.repo }
      : await githubOf(meta.repo);

    if (!repo.ok) return repo;
    const user = await me();

    if (!user.ok) return user;
    const known = await knownSecrets(id, meta.repo, meta.socket);

    if (!known.ok) return known;
    const owner: LogOwner = { repo: repo.data, login: user.data, session: id };
    // Each file on its own: one that cannot be read or stored is skipped, the rest still go.
    const sources = logSourcesOf({
      sessionDir: sessionDir(o.stateDir, id),
      transcriptPath: meta.transcriptPath,
      home: o.home,
      claudeSession: meta.claudeSession,
      worktree: meta.worktree,
      card,
    });
    const own = await readLogSources(sources.serve);
    const where = (await o.tree?.(meta.card).logs(sources.session)) ?? { files: [], skipped: [] };
    const files: LogShipData['files'] = [];
    const skipped = [...own.skipped, ...where.skipped];

    for (const file of [...own.files, ...where.files]) {
      const clean = redactLog(file.name, file.text, known.data);
      const key = logKey(owner, file.name);
      const body = new TextEncoder().encode(clean.text);
      const put = await store.put(key, body, logContentType(file.name));

      if (put.ok)
        files.push({ name: file.name, key, bytes: body.byteLength, redacted: clean.redacted });
      else if (put.error.code === 'bad-key')
        skipped.push({ name: file.name, why: put.error.message });
      // The store itself failing: nothing more goes now; the next shipment writes it all again.
      else return refused(put.error.code, put.error.message);
    }
    const data: LogShipData = {
      session: id,
      card,
      prefix: logPrefix(owner),
      reason,
      files,
      skipped,
    };

    o.shipped({
      session: id,
      card,
      prefix: data.prefix,
      reason,
      files: files.length,
      redacted: files.reduce((n, f) => n + f.redacted, 0),
    });

    return { ok: true, data };
  };

  const ship = (id: string, reason: ShipReason): Promise<Outcome<LogShipData>> => {
    const next = (queue.get(id) ?? Promise.resolve()).then(() => shipNow(id, reason));
    const settled = next.catch(() => undefined);

    queue.set(id, settled);
    void settled.then(() => {
      if (queue.get(id) === settled) queue.delete(id);
    });

    return next;
  };

  /** A shipment nobody asked for: a refusal is a `log.failed` event. */
  const onItsOwn = (id: string, reason: ShipReason) => {
    void ship(id, reason)
      .catch((err: unknown) => refused('ship-failed', why(err)))
      .then((out) => {
        // an Improve retro chat has no card's log to ship, a repo no store to ship to: nothing failed
        if (!out.ok && out.error.code !== NOT_A_CARD_SESSION && out.error.code !== NO_LOG_STORE)
          o.failed({ session: id, reason, code: out.error.code, message: out.error.message });
      });
  };

  const timer = setInterval(() => {
    void o.sessions.then(async (sessions) => {
      const listed = await sessions?.list();

      if (listed?.ok === true)
        for (const s of listed.data)
          // One still under way (a big transcript, a slow store) is not queued again.
          if (s.state !== 'ended' && s.card !== null && !queue.has(s.id))
            onItsOwn(s.id, 'interval');
    });
  }, o.every);

  return {
    storeAt,
    ship,
    ended: (id) => {
      onItsOwn(id, 'end');
    },
    close: async () => {
      clearInterval(timer);
      await Promise.all([...queue.values()]);
    },
  };
};

export type LogsCtx = {
  cwd: string;
  serve: {
    logs: LogShipper | undefined;
  };
};

const noStore = () => Promise.resolve(noStoreRefusal());

export const logHandlers = <Ctx extends LogsCtx>() =>
  ({
    'log ship': (args, ctx) =>
      ctx.serve.logs === undefined ? noStore() : ctx.serve.logs.ship(args.id, 'now'),
    'log list': async (args, ctx) => {
      const store = ctx.serve.logs?.storeAt(ctx.cwd);

      if (store === undefined) return noStore();
      // a repo's prefix ends at its `/`: only its own sessions are listed
      const listed = await store.list(logListPrefix(args.repo));

      if (!listed.ok) return refused(listed.error.code, listed.error.message);

      return {
        ok: true,
        data: {
          sessions: logSessions(listed.data).filter(
            (s) => args.user === undefined || s.user === args.user,
          ),
        },
      };
    },
  }) satisfies Partial<Handlers<Ctx>>;
