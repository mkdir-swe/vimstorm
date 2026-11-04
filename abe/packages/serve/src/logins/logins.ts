/**
 * StoredLogins stored once (#55): `serve` keeps the person's GitHub, Claude Code and `az` logins in
 * their one secret. With a secret named (`$ABE_LOGINS_SECRET`, set by the box's service), it
 * restores them where their tools read them when it starts, and every `every` ms writes back a
 * login a tool refreshed (one tool at a time, read-modify-write, so another box's other logins
 * stay). `abe login <tool>` stores the login the tool's own login just wrote; `abe login status`
 * works anywhere. No value is ever put in an event, a reply or an error.
 */
import {
  claudeProbe,
  claudeTokenOf,
  githubTokenOf,
  LOGIN_MARK,
  MACHINE_LOGINS,
  type Logins,
  type Clock,
  type Journal,
  LOGIN_SYNC_EVERY_MS,
  LOGIN_TOOLS,
  type LoginData,
  type LoginDoc,
  loginDocText,
  type LoginRestoreData,
  loginState,
  type LoginStatusData,
  type LoginStore,
  type LoginTool,
  type LoginTools,
  awsProfileOf,
  type AzFolderFact,
  type AzLoginFolder,
  loginNeeds,
  type Outcome,
  repoLogins,
  type RepoLogins,
  repoLoginsReason,
  readLoginDoc,
  restorable,
  refused,
  restorePlan,
  seedSecret,
  seedToken,
  SETUP_TOKEN_MS,
  type StoreCause,
  type StoredLogin,
  syncWay,
  withLogin,
  type Handlers,
  githubAccountOf,
} from '@abe/core';
import { homedIn, type LocalLogin, loginHash, loginHome, mainCheckout } from '@abe/ports';
import { basename, resolve } from 'node:path';
import { azureFolderAt, type SettingsService } from '../layer/settings';

export type StoredLoginsOptions = {
  /** The person's secret (name or ARN); `null`: this serve keeps no logins (the Mac). */
  secret: string | null;
  store: LoginStore;
  tools: LoginTools;
  /** Where the tools keep their logins: serve's `HOME`, the person's on the box. */
  home: string;
  /** Where az keeps its login when not `home`'s `.azure` (`$AZURE_CONFIG_DIR`, your Layer's). */
  azureConfigDir?: string;
  /** Where aws's restored login lives, apart from Reach's `~/.aws` (`AWS_LOGIN_HOME`; a box). */
  awsHome?: string;
  /** How often refreshed logins are looked for (default `LOGIN_SYNC_EVERY_MS`). */
  every?: number;
};

export type StoredLogins = {
  /** Every machine login's state, and aws's for `awsProfile` when one is named. */
  status: (o?: {
    awsProfile?: string | null;
    /** az's login folder and the gh login in force at the checkout asked for (ADR 0025). */
    azureFolder?: AzFolderFact;
    githubAccount?: string | null;
  }) => Promise<LoginStatusData>;
  /** `azureFolder`: az's login folder in force at the checkout it was typed in (ADR 0030). */
  store: (
    tool: LoginTool,
    cause: StoreCause,
    azureFolder?: AzFolderFact,
  ) => Promise<Outcome<LoginData>>;
  restore: () => Promise<Outcome<LoginRestoreData>>;
  /** Resolves once the start's restore (if any) is done. */
  started: Promise<void>;
  /**
   * A box session's tokens (#63's `Logins`) from the logins restored here: Claude Code's
   * credentials file and `gh`'s `hosts.yml`. `undefined` where no secret is named.
   */
  boxLogins: Logins | undefined;
  close: () => Promise<void>;
};

/** How many looks apart every login is compared with the stored ones (20 s × 15: 5 min). */
const RECONCILE_LOOKS = 15;

const NO_SECRET =
  "this abe serve keeps no logins: no $ABE_LOGINS_SECRET (a box's service sets it to your secret)";

export const startStoredLogins = (
  o: StoredLoginsOptions & { clock: Clock; emit: Journal['emit'] },
): StoredLogins => {
  const home = loginHome(o.home, o.azureConfigDir, o.awsHome);
  /** Each tool's files as last restored or stored: a different hash is a refresh to write back. */
  const synced = new Map<LoginTool, string>();
  /** A restore has worked: only then are logins written back. */
  let restored = false;
  let looks = 0;
  // One write at a time: each reads the secret anew and replaces only its own tool.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);

    chain = next.catch(() => undefined);

    return next;
  };
  const failed = (tool: LoginTool | null, code: string, message: string) => {
    o.emit('login.failed', { tool, code, message });
  };

  const readDoc = async (secret: string): Promise<Outcome<LoginDoc>> => {
    const read = await o.store.read(secret);

    if (!read.ok) return refused(read.error.code, read.error.message);
    const doc = readLoginDoc(read.data?.text ?? null);

    return doc.ok
      ? { ok: true, data: doc.doc }
      : refused('bad-login-secret', `${secret}: ${doc.message}`);
  };

  /** Writes `tool`'s login here into the secret, read anew; only its own entry changes. */
  const putLogin = async (
    secret: string,
    doc: LoginDoc,
    tool: LoginTool,
    local: LocalLogin,
    cause: StoreCause,
  ): Promise<Outcome<LoginData>> => {
    const text = loginDocText(
      withLogin(doc, tool, local.files, new Date(o.clock.now()).toISOString()),
    );

    if (!text.ok) return refused('login-too-large', text.message);
    const written = await o.store.write(secret, text.text);

    if (!written.ok) return refused(written.error.code, written.error.message);
    synced.set(tool, loginHash(local));
    o.emit('login.stored', { tool, secret, cause });

    return { ok: true, data: { tool, secret, files: Object.keys(local.files) } };
  };

  /** The stored login put here (a newer one another box stored). */
  const pull = (tool: LoginTool, stored: StoredLogin) => {
    home.write(restorable(tool, stored.files), stored.storedAt);
    synced.set(tool, loginHash(home.read(tool)));
  };

  /**
   * `login` and `seeded` store what is here. `refreshed` (the looks) first compares with what is
   * stored: the newer wins, so an old login on a box started again never overwrites a newer one
   * another box stored; it is pulled instead.
   */
  const storeNow = async (
    tool: LoginTool,
    cause: StoreCause,
    azureFolder?: AzFolderFact,
  ): Promise<Outcome<LoginData>> => {
    const secret = o.secret;

    if (secret === null) return refused('no-logins-secret', NO_SECRET);
    // az's login read from the folder az wrote it in, the checkout's when one is in force there
    const from =
      azureFolder === undefined || azureFolder.from === 'none'
        ? home
        : loginHome(o.home, homedIn(o.home, azureFolder.dir), o.awsHome);
    const local = from.read(tool);
    const files = Object.keys(local.files);

    if (files.length === 0)
      return refused('no-login', `no ${tool} login here to store (abe login ${tool})`);
    const doc = await readDoc(secret);

    if (!doc.ok) return doc;
    if (cause === 'refreshed') {
      const stored = doc.data.logins[tool];
      const way = syncWay({
        stored,
        localMtimeMs: local.mtimeMs ?? 0,
        same:
          stored !== undefined &&
          loginHash({ files: stored.files, mtimeMs: null }) === loginHash(local),
      });

      if (way !== 'store') {
        if (way === 'pull' && stored !== undefined) pull(tool, stored);
        else synced.set(tool, loginHash(local));

        return { ok: true, data: { tool, secret, files } };
      }
    }

    return putLogin(secret, doc.data, tool, local, cause);
  };

  const seed = async (secret: string, tool: LoginTool): Promise<boolean> => {
    const name = seedSecret(secret, tool);

    if (name === undefined) return false;
    const read = await o.store.read(name);

    if (!read.ok) {
      failed(tool, read.error.code, read.error.message);

      return false;
    }
    if (read.data === null) return false;
    const value = seedToken(read.data.text);

    if (tool === 'github') {
      const done = await o.tools.githubToken(value);

      if (!done.ok) {
        failed(tool, done.error.code, done.error.message);

        return false;
      }
    } else {
      // A setup-token lasts a year from when it was put in its seed.
      const made = Date.parse(read.data.createdAt);

      home.writeClaudeToken(value, (Number.isNaN(made) ? o.clock.now() : made) + SETUP_TOKEN_MS);
    }
    const stored = await storeNow(tool, 'seeded');

    if (!stored.ok) failed(tool, stored.error.code, stored.error.message);

    return true;
  };

  const restoreNow = async (): Promise<Outcome<LoginRestoreData>> => {
    const secret = o.secret;

    if (secret === null) return refused('no-logins-secret', NO_SECRET);
    const doc = await readDoc(secret);

    if (!doc.ok) return doc;
    const plan = restorePlan(
      doc.data,
      Object.fromEntries(LOGIN_TOOLS.map((t) => [t, home.read(t).mtimeMs] as const)),
    );

    for (const tool of plan.write) {
      const stored = doc.data.logins[tool];

      if (stored !== undefined) pull(tool, stored);
    }
    const seeded: LoginTool[] = [];

    for (const tool of plan.seed) if (await seed(secret, tool)) seeded.push(tool);
    // A login newer here goes back now, not at the next look.
    for (const tool of plan.keep) {
      const stored = await storeNow(tool, 'refreshed');

      if (!stored.ok) failed(tool, stored.error.code, stored.error.message);
    }
    const data: LoginRestoreData = {
      secret,
      restored: plan.write,
      seeded,
      kept: plan.keep,
      missing: LOGIN_TOOLS.filter(
        (t) => !plan.write.includes(t) && !plan.keep.includes(t) && !seeded.includes(t),
      ),
    };

    restored = true;
    o.emit('login.restored', data);

    return { ok: true, data };
  };

  /**
   * Writes back each login whose files changed since they were last synced; every
   * `RECONCILE_LOOKS`th look compares every login with the stored ones, so one lost to another
   * box's write at the same moment goes back, and a newer one stored by another box comes here.
   * Until a restore has worked (the secret unreachable at start) a look tries the restore again
   * and writes nothing back.
   */
  const look = async () => {
    if (!restored) {
      const r = await restoreNow();

      if (!r.ok) failed(null, r.error.code, r.error.message);

      return;
    }
    looks += 1;
    const all = looks % RECONCILE_LOOKS === 0;

    for (const tool of LOGIN_TOOLS) {
      const local = home.read(tool);

      if (Object.keys(local.files).length === 0) continue;
      if (!all && synced.get(tool) === loginHash(local)) continue;
      const stored = await storeNow(tool, 'refreshed');

      if (!stored.ok) failed(tool, stored.error.code, stored.error.message);
    }
  };

  const started =
    o.secret === null
      ? Promise.resolve()
      : serial(async () => {
          const r = await restoreNow();

          if (!r.ok) failed(null, r.error.code, r.error.message);
        });
  let looking = false;
  const timer =
    o.secret === null
      ? undefined
      : setInterval(() => {
          if (looking) return;
          looking = true;
          void serial(look).finally(() => {
            looking = false;
          });
        }, o.every ?? LOGIN_SYNC_EVERY_MS);

  return {
    status: async (asked) => {
      // What the box holds once its start's restore is done.
      await started;
      const now = o.clock.now();
      const unchecked: Partial<Record<LoginTool, string>> = {};
      const blocked: Partial<Record<LoginTool, string>> = {};
      const who: Partial<Record<LoginTool, string>> = {};
      const said: Partial<Record<LoginTool, string>> = {};
      const awsProfile = asked?.awsProfile ?? null;
      const folder = asked?.azureFolder;
      // the folder az was checked in, as a path here (a fix's `AZURE_CONFIG_DIR=` takes no `~`)
      const azureConfigDir: AzLoginFolder | undefined =
        folder === undefined || folder.from === 'none'
          ? undefined
          : { from: folder.from, dir: homedIn(o.home, folder.dir) };
      const tools: LoginTool[] = [
        ...MACHINE_LOGINS,
        ...(awsProfile === null ? [] : ['aws' as const]),
      ];
      const states = await Promise.all(
        tools.map(async (tool) => {
          const claudeFile = tool === 'claude' ? home.claudeFile() : undefined;
          const check = await o.tools.check(tool, checkFor(tool, asked));
          const state = loginState(tool, {
            present: Object.keys(home.read(tool).files).length > 0,
            check,
            claude: claudeFile === undefined ? undefined : claudeProbe(claudeFile),
            now,
          });

          if (state === 'unchecked' && 'cannot' in check) unchecked[tool] = check.cannot;
          if (state !== 'ok' && 'blocked' in check) blocked[tool] = check.blocked;
          if (state === 'ok' && 'works' in check && check.who !== undefined) who[tool] = check.who;
          if (state !== 'ok' && 'said' in check) said[tool] = check.said;

          return state;
        }),
      );
      const [github = 'missing', claude = 'missing', az = 'missing', aws] = states;

      return {
        secret: o.secret,
        logins: { github, claude, az, ...(aws === undefined ? {} : { aws }) },
        ...(awsProfile === null ? {} : { awsProfile }),
        ...(Object.keys(unchecked).length === 0 ? {} : { unchecked }),
        ...(Object.keys(blocked).length === 0 ? {} : { blocked }),
        ...(Object.keys(who).length === 0 ? {} : { who }),
        ...(Object.keys(said).length === 0 ? {} : { said }),
        ...(azureConfigDir === undefined ? {} : { azureConfigDir }),
      };
    },
    store: (tool, cause, azureFolder) => serial(() => storeNow(tool, cause, azureFolder)),
    restore: () => serial(restoreNow),
    started,
    boxLogins:
      o.secret === null
        ? undefined
        : {
            read: async () => {
              await started;
              const claudeText = home.text(LOGIN_MARK.claude);
              const githubText = home.text(LOGIN_MARK.github);
              const claude = claudeText === undefined ? undefined : claudeTokenOf(claudeText);
              const github = githubText === undefined ? undefined : githubTokenOf(githubText);

              if (claude === undefined || github === undefined) {
                const lacking = [
                  ...(claude === undefined ? ['claude'] : []),
                  ...(github === undefined ? ['github'] : []),
                ];

                return {
                  ok: false,
                  error: {
                    code: 'no-login',
                    message: `no ${lacking.join(' or ')} login on this box: ${lacking.map((t) => `abe login ${t}`).join(', ')}`,
                  },
                };
              }

              return { ok: true, data: { claude, github } };
            },
          },
    close: async () => {
      clearInterval(timer);
      await chain;
    },
  };
};

export type StoredLoginsCtx = {
  serve: {
    storedLogins: StoredLogins | undefined;
  };
};

/** What a repo's logins are read with: its settings (the Layers in force there) and the logins here. */
/** What a tool's check is asked about: aws's profile, az's folder, the gh login (ADR 0025). */
const checkFor = (
  tool: LoginTool,
  asked: Parameters<StoredLogins['status']>[0],
): { profile?: string; azureConfigDir?: string; githubAccount?: string } | undefined => {
  const aws = asked?.awsProfile ?? null;
  const az = asked?.azureFolder;
  const gh = asked?.githubAccount ?? null;

  if (tool === 'aws' && aws !== null) return { profile: aws };
  // serve's own $AZURE_CONFIG_DIR is in its checks' environment already
  if (tool === 'az' && az?.from === 'checkout') return { azureConfigDir: az.dir };
  if (tool === 'github' && gh !== null) return { githubAccount: gh };

  return undefined;
};

/** az's login folder in force at `dir` (ADR 0025), when serve reads the settings. */
const azFolderAt = (
  settings: SettingsService | undefined,
  dir: string,
): { azureFolder?: AzFolderFact } =>
  settings === undefined ? {} : { azureFolder: azureFolderAt(settings, dir) };

export type RepoLoginsCtx = {
  settings?: SettingsService | undefined;
  serve: {
    storedLogins?: StoredLogins | undefined;
  };
};

const none = () => refused('no-logins', 'this abe serve was started without its logins');

/**
 * The checkout's `logins:`, then each tool of `also` it does not name (what a Factory install's
 * Read found the repo needs, #22), as a plain need; an aws one naming no profile on `awsProfile`
 * (Just this Mac's install: the repo's `box.profile`) when one is given.
 */
const needsOf = (
  ctx: RepoLoginsCtx,
  repo: string,
  also: readonly LoginTool[],
  awsProfile: string | null,
) => {
  const named = loginNeeds(ctx.settings?.at(repo).values.logins ?? []);

  return [
    ...named,
    ...also
      .filter((t) => !named.some((n) => n.tool === t))
      .map((tool) => ({ tool, name: tool, profile: null, tenant: null })),
  ].map((n) => (n.tool === 'aws' && n.profile === null ? { ...n, profile: awsProfile } : n));
};

/**
 * The logins `repo` (a checkout) needs by its `logins:` and their state here, with the full
 * status they were read from: aws checked for the profile its `logins:` names.
 */
const repoStatus = async (
  ctx: RepoLoginsCtx,
  repo: string,
  also: readonly LoginTool[] = [],
  awsProfile: string | null = null,
): Promise<Outcome<LoginStatusData & { repo: RepoLogins }>> => {
  if (ctx.serve.storedLogins === undefined) return none();
  const needs = needsOf(ctx, repo, also, awsProfile);
  const values = ctx.settings?.at(repo).values;
  const status = await ctx.serve.storedLogins.status({
    awsProfile: awsProfileOf(needs),
    ...azFolderAt(ctx.settings, repo),
    githubAccount: githubAccountOf(values),
  });

  return { ok: true, data: { ...status, repo: repoLogins(basename(repo), needs, status) } };
};

/**
 * Which logins the checkout `repo` needs (its `logins:`) and which are missing here: the one
 * place a card's launch and a Factory install ask. `ready` when all are ok; a repo with no
 * `logins:` needs none (and runs no check). `awsProfile`: aws's when `logins:` names none.
 */
export const repoLoginStatus = async (
  ctx: RepoLoginsCtx,
  repo: string,
  also: readonly LoginTool[] = [],
  awsProfile: string | null = null,
): Promise<Outcome<RepoLogins>> => {
  if (needsOf(ctx, repo, also, awsProfile).length === 0)
    return { ok: true, data: repoLogins(basename(repo), [], { secret: null, logins: NO_STATES }) };
  const read = await repoStatus(ctx, repo, also, awsProfile);

  return read.ok ? { ok: true, data: read.data.repo } : read;
};

/** Why a launch in `repo` stops at Needs you over its logins (`repoLoginsReason`), or null. */
export const repoLoginsNeedsYou = async (
  ctx: RepoLoginsCtx,
  repo: string,
): Promise<string | null> => {
  const read = await repoLoginStatus(ctx, repo);

  // serve keeping no logins at all is no reason to stop a run: nothing could be checked.
  return read.ok ? repoLoginsReason(read.data) : null;
};

const NO_STATES = { github: 'unchecked', claude: 'unchecked', az: 'unchecked' } as const;

export const loginHandlers = <Ctx extends StoredLoginsCtx & RepoLoginsCtx & { cwd: string }>() =>
  ({
    login: async (args, ctx) =>
      ctx.serve.storedLogins === undefined
        ? none()
        : ctx.serve.storedLogins.store(
            args.tool,
            'login',
            azFolderAt(ctx.settings, resolve(ctx.cwd)).azureFolder,
          ),
    'login status': async (args, ctx) => {
      if (args.repo !== undefined) return repoStatus(ctx, resolve(ctx.cwd, args.repo));

      if (ctx.serve.storedLogins === undefined) return none();
      const status = await ctx.serve.storedLogins.status(
        azFolderAt(ctx.settings, resolve(ctx.cwd)),
      );

      // outside a checkout no checkout's az folder is in force: its words name none
      return {
        ok: true,
        data: mainCheckout(resolve(ctx.cwd)) === undefined ? { ...status, outside: true } : status,
      };
    },
    'login restore': async (_, ctx) =>
      ctx.serve.storedLogins === undefined ? none() : ctx.serve.storedLogins.restore(),
  }) satisfies Partial<Handlers<Ctx>>;
