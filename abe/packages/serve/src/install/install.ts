/**
 * `abe install`: Factory install's commands over core's parts (`core/src/install/install.ts`).
 * serve changes each main checkout's record through its one owner (`record.ts`), reads the local
 * files (`InstallRepo`), asks the logins (the logins service), runs the gate, reads the connection
 * live, checks each part on request (`abe install check`, one table of each part's reads and
 * core's verdict on them) and says every change as `install.changed` with the install's status.
 * Its session is the repo's Abe chat (unjailed, the person there) following `/abe:install`. No
 * env value is ever in a reply, an event or the record: only keys and hosts. The team's files
 * (`abe.yaml`, `.claude/skills/`) are ordinary files the person commits; `.abe/` is theirs alone,
 * always kept out of git.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  LOCAL_DIR,
  type CardsRun,
  isCloudTarget,
  LOCAL_PATH,
  REPO_SKILLS_DIR,
  ranLocally,
  donePart,
  type BoardReads,
  boardKept,
  boardPart,
  boardRecorded,
  sourceSettled,
  verifyPart,
  type VerifyReads,
  type PrototypeTry,
  abeUpdatesWords,
  REPO_ABE_DIR,
  workflowsPart,
  type WorktreeCopy,
  composePaths,
  cloudCredentialsWhy,
  sandboxWorkarounds,
  type WrittenCheck,
  ABE_ENVS,
  type AbeEnv,
  agentEnvKey,
  envNotEnabled,
  abeEnvFile,
  abeEnvSecrets,
  checksEnvOf,
  type KnownSecret,
  awsProfileOf,
  withOriginHint,
  type Board,
  type BoardRef,
  boardFact,
  boardOf,
  boardOfSetting,
  type BoardWhere,
  DEFAULT_CARD_TYPES,
  cloudFact,
  type ConnectionFact,
  githubFact,
  githubRepoOf,
  sourceFact,
  type Tracking,
  type GhAccounts,
  type GithubReadable,
  type Repo,
  type Clock,
  ENV_FILES,
  type EnvFileSeen,
  beforeRunWarning,
  checkCommandWhyNot,
  checkTail,
  type InstallCheckRun,
  CHECK_TIMEOUT_MS,
  ciNodeOptions,
  injectedSecrets,
  redactText,
  withoutAnsi,
  gate,
  type GateResult,
  codeImports,
  isEnvFileName,
  runEntries,
  type NotUsed,
  PORT_BASE,
  WORKSPACE_DATABASE,
  takesOwnDatabase,
  loadedValues,
  type StartLoad,
  startLoads,
  type Install,
  type InstallMove,
  type InstallRepo,
  type InstallVersions,
  serveVersionNote,
  INSTALL_SKILL,
  installView,
  type InstallView,
  LOGIN_TOOLS,
  loginNeeds,
  loginsWithBoard,
  type LoginTool,
  type Outcome,
  parseEnvFile,
  SOURCE_VALUES_PATH,
  sourceReferences,
  readCheckout,
  refused,
  addedSources,
  sourcesToCheck,
  credentialsFact,
  newInstall,
  type Journal,
  type Merged,
  placeOfFile,
  repoFile,
  sourceAccountModel,
  installSignInPrompt,
  installSignedInPrompt,
  signInRefusalWords,
  type SourcesData,
  sourceStatus,
  type McpState,
  type SourceProbeRead,
  RepoKind,
  type RepoKindSaid,
  REPO_KINDS,
  unlistedChecks,
  notACheckLines,
  featuresOf,
  INSTALL_PROOF_DIR,
  installProofFindings,
  nothingToRun,
  packFindings,
  packPaths,
  packRefusal,
  packSurface,
  featureSurfaces,
  type Handlers,
  type InstallBy,
  INSTALL_PARTS,
  type InstallPart,
  installDone,
  partChecked,
  partFailed,
  prototypePart,
  type PartVerdict,
  failedOf,
  loginsPart,
  sourcesPart,
  envFilesPart,
  envFilesPlaced,
  unmetTypes,
  worktreePart,
  type WorktreeTried,
  checksPart,
  moveInstall,
  REPO_PATH,
  installRepoName,
  DEFAULT_HOOKS,
  hasHeading,
  type RepoHooks,
  repoHooksIn,
  RUN_ROLES,
  runAppSkill,
  syncTeamPaths,
  testingSkills,
  skillsPart,
  type SkillsReads,
  AGENT_NOTES,
  verifySkill,
  type InstallSourcesData,
  SourceEntry,
  sourceName,
  sourceRows,
  withSource,
  sourceOffer,
  githubAccountOf,
  AGENT_NOTE_FILES,
  recipeCopies,
  recipeWithMap,
  type SettingKey,
  type Settings,
  type WorktreeRecipe,
} from '@abe/core';
import {
  abeFilesIn,
  abeUpdatesIn,
  copyAbeFiles,
  parseYaml,
  readYamlFile,
  writeYamlFile,
} from '@abe/ports';
import {
  azureFolderAt,
  serveTargetIn,
  type SettingsCtx,
  type SettingsService,
  setYoursAt,
  setRepoAt,
} from '../layer';
import { type LocalApps, type LocalCtx } from '../local-mode';
import { repoLoginStatus, type StoredLoginsCtx } from '../logins';
import { answerQuestions, openHub, type Sessions } from '../session';
import { loadedWorkflows } from '../skills';
import { type Prototypes, TRY_ID, tryPrototype } from '../prototype';
import { envMapChanged, prefillAbeEnvFiles } from './env-prefill';
import { type Changed, type InstallRecord, type InstallRecords } from './record';

export type InstallCtx = SettingsCtx &
  StoredLoginsCtx &
  LocalCtx & {
    /** The Abe chat a request came from (it runs as the person: `session` is undefined then). */
    hub?: string | undefined;
    ports: {
      /** The Connection check's reads: the board and GitHub, as the person. */
      board: Board;
      tracking: Tracking;
      /**
       * GitHub as your gh login at a checkout (`logins.gh`), as another of your logins, and
       * the logins gh has: the Connection check's GitHub fix names the one that reads the repo.
       */
      github?: {
        at: (dir: string) => Tracking;
        as: (account: string) => Tracking | undefined;
        accounts?: () => Promise<GhAccounts>;
      };
    };
    /** The session a request came from; none: the person (the page, a Terminal). */
    session: string | undefined;
    serve: {
      /** Where the Abe chat is launched (the install's Chat); none: the install runs without one. */
      sessions: Sessions | undefined;
      emit: Journal['emit'];
      clock: Clock;
      /** The checkout's reads and each checkout's record; none: `abe install` is refused. */
      install: InstallRecords | undefined;
      /**
       * Local sessions' databases: the install session's own for a check in dev, as its `abe run`
       * gets it. None: a check gets the Abe env file's alone.
       */
      localApps?: Pick<LocalApps, 'database'> | undefined;
      /** Where the Prototype check starts the app as a prototype's; none: it is refused. */
      prototypes?: Prototypes | undefined;
      /** This serve's abe version. */
      version: string;
      /** The abe installed on this Mac now, its version; none: not known. */
      installed: () => string | undefined;
    };
  };

/** The checkout, its record and its Abe chat's session id now (null: none yet). */
type Here = {
  repo: InstallRepo;
  record: InstallRecord;
  top: string;
  hub: () => string | null;
  /** The repo's hook points as its `abe.yaml` declares them: the checks read the map. */
  hooks: RepoHooks;
};

const at = (ctx: InstallCtx) => new Date(ctx.serve.clock.now()).toISOString();

/**
 * Who moved: the person (the page, a Terminal, the Abe chat, which runs for them while they
 * are there: its "only you" refusals lifted) or a session.
 */
const byOf = (ctx: InstallCtx): InstallBy => (ctx.session === undefined ? 'person' : 'session');

/** The main checkout the command names (default: where it was typed). */
const here = async (ctx: InstallCtx, repo: string | undefined): Promise<Outcome<Here>> => {
  if (ctx.serve.install === undefined)
    return refused('no-install', 'this abe serve was started without Factory install');
  const dir = resolve(ctx.cwd, repo ?? '.');
  const c = await ctx.serve.install.repo.checkout(dir);

  if (c === undefined) return refused('not-a-checkout', `${dir} is no git checkout`);
  if (!c.main)
    return refused(
      'not-main-checkout',
      `${c.top} is a worktree: run the install in the repo's main checkout`,
    );

  const sessions = ctx.serve.sessions;

  return {
    ok: true,
    data: {
      repo: ctx.serve.install.repo,
      record: ctx.serve.install.at(c.top),
      top: c.top,
      hub: () => sessions?.hub(c.top)?.id ?? null,
      hooks: repoHooksIn(ctx.settings?.at(c.top).values ?? {}),
    },
  };
};

/**
 * The main checkout for a source's command: the one the command names, or the main checkout of
 * the card worktree it was typed in (git's common dir's), as if run there.
 */
const sourcesHere = async (ctx: InstallCtx, repo: string | undefined): Promise<Outcome<Here>> => {
  const h = await here(ctx, repo);

  if (h.ok || h.error.code !== 'not-main-checkout' || ctx.serve.install === undefined) return h;
  const c = await ctx.serve.install.repo.checkout(resolve(ctx.cwd, repo ?? '.'));

  return c?.mainTop === undefined ? h : here({ ...ctx, cwd: c.mainTop }, undefined);
};

/** A record, its session the repo's Abe chat now. */
const withHub = (h: Here, i: Install | undefined): Install | undefined =>
  i === undefined ? undefined : { ...i, session: h.hub() };

/** The record as kept now, its session the repo's Abe chat now. */
const load = async (h: Here): Promise<Install | undefined> => withHub(h, await h.record.read());

/** The install's status, with its session's state now. */
const viewOf = (ctx: { serve: Pick<InstallCtx['serve'], 'sessions'> }, i: Install): InstallView =>
  installView(
    i,
    i.session === null ? null : (ctx.serve.sessions?.metaOf(i.session)?.state ?? null),
  );

/** serve's version and the installed abe's (install.sh may have replaced it since serve started). */
const versionsOf = (ctx: {
  serve: Pick<InstallCtx['serve'], 'version' | 'installed'>;
}): InstallVersions => ({
  serve: ctx.serve.version,
  installed: ctx.serve.installed() ?? null,
});

/**
 * A session's cards moved (asked, answered, gone at its turn's end): when it is a repo's Abe chat
 * with an install, the install's status is said again, its session's state with it.
 */
export const installSessionAsked = async (
  ctx: { serve: Pick<InstallCtx['serve'], 'sessions' | 'install' | 'emit'> },
  id: string,
): Promise<void> => {
  const of = ctx.serve.sessions?.metaOf(id)?.abe;

  if (of === undefined || of === null || ctx.serve.install === undefined) return;
  const i = await ctx.serve.install.at(of.repo).read();

  if (i !== undefined && ctx.serve.sessions?.hub(of.repo)?.id === id)
    ctx.serve.emit('install.changed', viewOf(ctx, { ...i, session: id }));
};

/**
 * The Layer that names the board: the repo's when its `board` entry says where it is (a provider,
 * an organization or a project). Yours never names one: your `board` holds your az folder, so it
 * winning the merge leaves the repo's board named (Read and Board agree).
 */
const boardLayer = (merged: Merged): string => {
  const naming = merged
    .explain('board')
    .layers.filter((l) => {
      const w = l.written;
      const shared = l.layer === 'repo';

      if (!l.applied || !shared || typeof w !== 'object' || w === null || Array.isArray(w))
        return false;

      return ['provider', 'organization', 'project'].some((k) => Object.hasOwn(w, k));
    })
    .at(-1);

  return naming?.layer ?? merged.explain('board').winner;
};

/** The board the `board` setting in force names, from the repo's file; null: none. */
const boardInForce = (ctx: InstallCtx, top: string): BoardWhere | null => {
  const merged = ctx.settings?.at(top);

  return merged === undefined
    ? null
    : boardOfSetting({ value: merged.values.board, layer: boardLayer(merged) });
};

/**
 * The `autoMerge` the repo's own Layer writes and that applies (a plain entry, or an Override
 * lowering an upper one); null: it writes none, or one the merge refused (ADR 0026).
 */
const repoAutoMerge = (ctx: InstallCtx, top: string): boolean | null => {
  const step = ctx.settings
    ?.at(top)
    .explain('autoMerge')
    .layers.find((l) => l.layer === 'repo' && l.applied);

  return typeof step?.written === 'boolean' ? step.written : null;
};

/** Read: the local files (a monorepo's workspaces too) and the `board` setting in force. */
const readMove = async (
  ctx: InstallCtx,
  h: Here,
  said?: RepoKindSaid | null,
): Promise<InstallMove> => ({
  kind: 'read',
  findings: await readWith(ctx, h, said),
});

/**
 * The repo's kind as the person said it: `abe.yaml`'s `kind:` (the team's, ADR 0040), else the
 * one an older install kept on the record (`kindSaid`, read from its `shapeSaid` too).
 */
const kindSaidAt = (ctx: InstallCtx, top: string, i: Install | undefined): RepoKindSaid | null =>
  ctx.settings?.at(top).values.kind ?? i?.kindSaid ?? null;

/** Read's findings, with the kind the person said it is over the files'. */
const readWith = async (ctx: InstallCtx, h: Here, said?: RepoKindSaid | null) => {
  const merged = ctx.settings?.at(h.top);
  const findings = await readCheckout(
    {
      read: (path) => h.repo.read(h.top, path),
      list: (dir) => h.repo.list(h.top, dir),
      grep: (pattern, max) => h.repo.grep(h.top, pattern, max),
      ignored: (path) => h.repo.ignored(h.top, path),
      tracked: (path) => h.repo.tracked(h.top, path),
      originOnly: (path) => h.repo.originOnly(h.top, path),
      runChecks: (commands) => h.repo.runChecks(h.top, commands),
      // an env file's key names alone: its values never leave serve
      envKeys: async (path) => {
        const text = await h.repo.read(h.top, path);

        return text === undefined ? undefined : [...parseEnvFile(text).keys()];
      },
    },
    merged === undefined ? undefined : { value: merged.values.board, layer: boardLayer(merged) },
    said ?? null,
  );
  // an Azure DevOps origin names the org (and project) itself, before any doc does
  return { ...findings, boards: withOriginHint(findings.boards, await h.repo.origin(h.top)) };
};

/**
 * The `box.profile` yours for this repo (`.abe/settings.local.yaml`, ADR 0030): never the one
 * yours on this Mac gives everywhere.
 */
const checkoutBoxProfile = (ctx: InstallCtx, top: string): string | null => {
  const step = ctx.settings
    ?.at(top)
    .explain('box.profile')
    .layers.find((l) => l.applied && l.file !== null && placeOfFile(l.file) === 'local');

  return typeof step?.written === 'string' ? step.written : null;
};

/**
 * The aws profile the app's login is checked on when `logins:` names none: the checkout's
 * `box.profile`, else dev's (`abe install env-profile dev`). None: aws is not checked.
 */
const macAwsProfile = (ctx: InstallCtx, top: string, i: Install): string | null =>
  checkoutBoxProfile(ctx, top) ?? i.envFiles?.profiles.dev ?? null;

/**
 * Where the repo's cards run (`serve.target`): on this machine, or on cloud boxes. What the cloud
 * and GitHub reads judge by.
 */
const cardsRunAt = (ctx: InstallCtx, top: string): CardsRun =>
  isCloudTarget(serveTargetIn(ctx.settings, top, false)) ? 'cloud' : 'local';

/**
 * Logins: the repo's `logins:` and what Read and the board say it needs, as the logins
 * service answers it for a card's launch too (`repoLoginStatus`): each one's state and its sign-in.
 * aws is skipped on this machine unless Read found the repo uses it and a profile is said for it.
 */
const loginsMove = async (ctx: InstallCtx, h: Here, i: Install): Promise<Outcome<InstallMove>> => {
  const top = h.top;
  // what Read found, and az once the board in force is Azure
  const found = loginsWithBoard(i.read?.logins ?? [], i.board, i.read?.azureCi ?? false).flatMap(
    (t): LoginTool[] => {
      const tool = LOGIN_TOOLS.find((x) => x === t);

      return tool === undefined ? [] : [tool];
    },
  );
  // cards on cloud boxes: aws is the boxes' login, the box.profile in force (yours on this Mac
  // everywhere too, the one a box starts with); on this machine, the app's
  const cloud = cardsRunAt(ctx, top) === 'cloud';
  const profile =
    (cloud ? ctx.settings?.at(top).values['box.profile'] : undefined) ?? macAwsProfile(ctx, top, i);
  const r = await repoLoginStatus(ctx, top, found, profile);

  if (!r.ok) return r;
  const named = awsProfileOf(loginNeeds(ctx.settings?.at(top).values.logins ?? []));
  // aws on this machine only when Read found the repo uses it and a profile is said for it; on
  // cloud boxes, the boxes' own
  const skip =
    cloud || ((i.read?.logins ?? []).includes('aws') && (named !== null || profile !== null))
      ? []
      : ['aws'];

  return {
    ok: true,
    data: {
      kind: 'logins',
      logins: {
        needs: r.data.needs.map((n) => n.tool),
        missing: r.data.missing,
        unchecked: r.data.unchecked,
        ready: r.data.ready,
        fixes: Object.fromEntries(r.data.needs.map((n) => [n.tool, n.fix])),
        notes: Object.fromEntries(r.data.needs.map((n) => [n.tool, n.note])),
      },
      skip,
    },
  };
};

/**
 * The cards open on a shared board without its area, tag and what it leaves out (lanes, a tag);
 * undefined: it has none of these, or the read failed.
 */
const openWithout = async (ctx: InstallCtx, board: BoardRef): Promise<number | undefined> => {
  if (
    board.area === undefined &&
    board.tag === undefined &&
    board.excludeLanes === undefined &&
    board.notTag === undefined
  )
    return undefined;
  const whole: BoardRef = {
    ...(board.provider === undefined ? {} : { provider: board.provider }),
    ...(board.repo === undefined ? {} : { repo: board.repo }),
    ...(board.githubAccount === undefined ? {} : { githubAccount: board.githubAccount }),
    organization: board.organization,
    project: board.project,
    team: board.team,
    types: board.types,
    ...(board.azureConfigDir === undefined ? {} : { azureConfigDir: board.azureConfigDir }),
  };
  const all = await ctx.ports.board.list(whole, { mine: false });

  return all.ok ? all.data.length : undefined;
};

/**
 * The Connection check (spec 3.0.1), read live: the board in force (its newest cards, its
 * sprint), GitHub (origin's repo, gh's account, its pull requests), the cloud (Connected: the
 * Layer's abe-* box.profile and box.region, the profile's account) and each added source (its
 * MCP server and, connected, its account).
 */
const connectionMove = async (ctx: InstallCtx, h: Here, i: Install): Promise<InstallMove> => {
  const values = ctx.settings?.at(h.top).values;
  const ref = boardOf(values?.board);
  const [cards, sprint] = ref.ok
    ? await Promise.all([
        ctx.ports.board.list(ref.board, { mine: false }),
        ctx.ports.board.currentSprint(ref.board),
      ])
    : [undefined, undefined];
  // an area, tag or what it leaves out left no card: how many the board has open without them
  const openWithoutFilter =
    ref.ok && cards?.ok === true && cards.data.length === 0 && ref.board.provider !== 'local'
      ? await openWithout(ctx, ref.board)
      : undefined;
  const origin = await h.repo.origin(h.top);
  const repo = origin === undefined ? undefined : githubRepoOf(origin);
  const gh = await githubRead(ctx, h.top, repo, githubAccountOf(values));
  const kind = cardsRunAt(ctx, h.top);
  const profile = values?.['box.profile'] ?? null;
  const region = values?.['box.region'] ?? null;
  // Just this Mac: the app's aws login, its profile the one `logins:` names, else the checkout's
  // box.profile, else the one the person answered, when the repo uses aws
  const needs = kind === 'local' ? (i.read?.aws ?? []) : [];
  const appProfile = awsProfileOf(loginNeeds(values?.logins ?? [])) ?? macAwsProfile(ctx, h.top, i);
  const boxAsked = region === null ? null : profile;
  const appAsked = needs.length > 0 ? appProfile : null;
  const asked = kind === 'cloud' ? boxAsked : appAsked;
  // only an abe-* profile is ever asked who it is
  const account = asked?.startsWith('abe-') === true ? await h.repo.awsAccount(asked) : undefined;
  const model = sourceAccountModel(values?.allowedModels ?? []);
  // each added source and each the repo's sources: names (ADR 0027, 0031): its server's state
  // and, connected, its one read and the account it told
  const sources: ConnectionFact[] = await Promise.all(
    sourcesToCheck(i, teamSources(ctx, h).map(sourceName)).map(async (s) => {
      const state = await h.repo.mcp(h.top, s.server);
      const probe =
        state === 'connected' && model !== undefined
          ? await h.repo.sourceAccount(h.top, s.server, model)
          : undefined;

      return sourceFact({
        id: s.id,
        name: s.name,
        mcp: s.server,
        state,
        ...(probe === undefined ? {} : { account: probe.account, probe: probe.read }),
        signIn: i.sourceChecks[s.id]?.signIn === true,
      });
    }),
  );
  // each environment's credentials: its aws profile (an expired login said) and Abe env file
  const credentials: ConnectionFact[] =
    i.envFiles === null
      ? []
      : await Promise.all(
          ABE_ENVS.map(async (env) => {
            const profile = i.envFiles?.profiles[env] ?? null;
            const keys = profile === null ? undefined : await h.repo.awsCredentials(profile);
            // the account it is, whatever its name: read only, its id alone; none said if aws can't
            const who =
              profile !== null && keys?.ok === true ? await h.repo.awsAccount(profile) : undefined;
            const told = who !== undefined && 'account' in who ? { account: who } : {};
            const account =
              keys !== undefined && !keys.ok ? { account: { cannot: keys.why } } : told;
            const text = await h.repo.read(h.top, abeEnvFile(env));
            const named = [...parseEnvFile(text ?? '').keys()];

            // an environment with neither a profile nor a key: nothing to check
            return profile === null && named.length === 0
              ? []
              : [
                  credentialsFact({
                    env,
                    profile,
                    ...account,
                    envFile: named.length === 0 ? null : { file: abeEnvFile(env), keys: named },
                  }),
                ];
          }),
        ).then((f) => f.flat());

  return {
    kind: 'connection',
    facts: [
      boardFact({
        where: i.board,
        board: ref.ok ? ref : { ok: false, error: ref.error },
        ...(cards === undefined ? {} : { cards }),
        ...(openWithoutFilter === undefined ? {} : { openWithoutFilter }),
        ...(sprint === undefined ? {} : { sprint }),
        readOnly: ctx.serve.localMode?.boardHeldAt(h.top) !== undefined,
        ...(ctx.settings === undefined ? {} : { az: azureFolderAt(ctx.settings, h.top) }),
      }),
      githubFact({ origin, repo, ...gh, kind }),
      cloudFact({
        kind,
        profile: kind === 'local' ? appProfile : profile,
        region,
        ...(account === undefined ? {} : { account }),
        needs,
        login: i.logins?.find((l) => l.tool === 'aws') ?? null,
      }),
      ...sources,
      ...credentials,
    ],
  };
};

/**
 * A signed-in gh login other than `as` whose token reads `repo`'s pull requests (each read on its
 * own token, gh's active login never switched), and gh's active one; else every login tried.
 */
const otherLogin = async (
  ctx: InstallCtx,
  repo: Repo,
  as: string | null,
): Promise<{ readable?: GithubReadable; tried: string[] }> => {
  const accounts = await ctx.ports.github?.accounts?.();

  if (accounts === undefined) return { tried: [] };
  const read = as ?? accounts.active;

  for (const login of accounts.signedIn.filter((l) => l !== read)) {
    const prs = await ctx.ports.github?.as(login)?.recentPrs(repo);

    if (prs?.ok === true) return { readable: { login, active: accounts.active }, tried: [] };
  }

  return { tried: accounts.signedIn };
};

/**
 * GitHub as the Connection check reads it: as your gh login for this checkout (`logins.gh`),
 * else gh's active one. When that one can't read the repo and another signed-in login can, the
 * install sets it as this checkout's `logins.gh` itself (yours for this repo, as `--mine` does) and
 * reads as it; when none can, every login tried is said.
 */
const githubRead = async (
  ctx: InstallCtx,
  top: string,
  repo: Repo | undefined,
  account: string | null,
): Promise<Omit<Parameters<typeof githubFact>[0], 'origin' | 'repo' | 'kind'>> => {
  const tracking = ctx.ports.github?.at(top) ?? ctx.ports.tracking;
  const me = repo === undefined ? undefined : await tracking.me();
  const prs = me?.ok === true && repo !== undefined ? await tracking.recentPrs(repo) : undefined;
  const read = {
    ...(me === undefined ? {} : { me }),
    ...(prs === undefined ? {} : { prs }),
    account,
  };

  if (repo === undefined || prs?.ok === true) return read;
  const was = me?.ok === true ? me.data.login : account;
  const other = await otherLogin(ctx, repo, was);
  const login = other.readable?.login;
  const as = login === undefined ? undefined : ctx.ports.github?.as(login);

  const named = {
    ...read,
    ...(other.readable === undefined ? {} : { readable: other.readable }),
    ...(other.tried.length === 0 ? {} : { tried: other.tried }),
  };

  if (login === undefined || as === undefined || ctx.settings === undefined) return named;
  // the fix named when your Layer can't be written: the person sets it
  if (!setYoursAt({ ...ctx, settings: ctx.settings }, top, 'logins.gh', login).ok) return named;
  const [meAs, prsAs] = await Promise.all([as.me(), as.recentPrs(repo)]);

  return {
    me: meAs,
    prs: prsAs,
    account: login,
    ...(was === null ? {} : { setFrom: was }),
  };
};

/** A `sources:` entry's name as the file has it: a bare name, or a definition's `name`. */
const nameOfListed = (x: unknown): string => {
  const e = SourceEntry.safeParse(x);

  return e.success ? sourceName(e.data) : '';
};

/**
 * The sources the person skipped, taken out of the repo Layer's `sources:` (Board wrote the added
 * ones there): a source skipped at the Connection check is read by no session. The rest of the
 * file stays as it is; an empty list goes.
 */
const unlistSkipped = (ctx: InstallCtx, h: Here, was: Install, now: Install) => {
  const skipped = Object.entries(now.sources)
    .filter(([id, a]) => a === 'skip' && was.sources[id] !== 'skip')
    .map(([id]) => id);

  if (skipped.length === 0) return;
  const file = repoFile(h.top);
  const read = readYamlFile(file);
  const doc = 'doc' in read ? read.doc : undefined;

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return;
  const layer: Record<string, unknown> = { ...doc };
  const listed: unknown = layer.sources;

  if (!Array.isArray(listed)) return;
  const kept = listed.filter((x) => !skipped.includes(nameOfListed(x)));

  if (kept.length === listed.length) return;
  if (kept.length === 0) delete layer.sources;
  else layer.sources = kept;
  writeYamlFile(file, layer);
  ctx.settings?.poll();
};

/**
 * A source's server's state where a session here loads it and, connected, its probe's one read
 * (ADR 0027): connected with no model to ask with, nothing to probe it on, taken as read. Its
 * server told an account: it has a sign-in.
 */
const sourceRead = async (
  ctx: InstallCtx,
  h: Here,
  server: string,
): Promise<{ mcp: McpState; probe: SourceProbeRead | null; signIn?: boolean }> => {
  const model = sourceAccountModel(ctx.settings?.at(h.top).values.allowedModels ?? []);
  const mcp = await h.repo.mcp(h.top, server);

  if (mcp !== 'connected') return { mcp, probe: null };
  if (model === undefined) return { mcp, probe: 'ok' };
  const probe = await h.repo.sourceAccount(h.top, server, model);

  return { mcp, probe: probe.read, signIn: Object.keys(probe.account).length > 0 };
};

type SignedIn = Extract<InstallMove, { kind: 'signed-in' }>;

/**
 * A source's sign-in, run by serve itself (ADR 0028), outside any sandbox: Claude Code's headless
 * MCP sign-in in the person's browser (`signInMcp`), then its server's state and one read, each
 * recorded on the source's row (`signed-in`) while the record still has it signing in. Signed in
 * and read: the install's session, when it runs, started again on the new sign-in, its
 * conversation resumed (`--resume`). In the background: the request that started it has its
 * answer, and the install goes on meanwhile. One at a time per source (the record's sign-ins).
 */
const signInLater = (ctx: InstallCtx, h: Here, id: string): void => {
  void h.record.startSignIn(id, async () => {
    await signInNow(ctx, h, id);

    return undefined;
  });
};

const signInNow = async (ctx: InstallCtx, h: Here, id: string): Promise<void> => {
  const was = await load(h);
  const source = was === undefined ? undefined : addedSources(was).find((s) => s.id === id);

  if (source === undefined) return;
  const r = await signInOf(h, source.server);
  const read = await sourceRead(ctx, h, source.server);
  const ended: SignedIn = { kind: 'signed-in', id, ...read, ...(r.signedIn ? {} : { why: r.why }) };
  // recorded on its row, Settings' row told too; one skipped since (or a record reset) keeps none
  const saved = await commit(ctx, h, (i) =>
    i.signingIn.includes(id) ? moveInstall(i, ended, at(ctx)) : { ok: true, data: i },
  );

  if (!saved.ok) return;
  ctx.serve.emit('sources.changed', await sourcesOf(ctx, h));
  if (read.mcp !== 'connected' || read.probe !== 'ok') return;
  const now = await load(h);
  const session = now === undefined ? undefined : await runningSession(ctx, now);

  if (session !== undefined)
    await restartSession(ctx, h, session, installSignedInPrompt(source.name));
};

/** Whether the install runs in the checkout: a record, not done. */
const installing = (i: Install | undefined): i is Install => i !== undefined && !installDone(i);

/**
 * A checkout's sources: those its install added (their servers), then the rest the repo's
 * `sources:` names (a server of the same name).
 */
const checkoutSources = (
  ctx: InstallCtx,
  h: Here,
  i: Install | undefined,
): { id: string; server: string }[] => {
  const added = i === undefined ? [] : addedSources(i);
  const named = teamSources(ctx, h).map(sourceName);

  return [
    ...added.map((a) => ({ id: a.id, server: a.server })),
    ...named.filter((n) => !added.some((a) => a.id === n)).map((n) => ({ id: n, server: n })),
  ];
};

/** The repo's `sources:` in the main checkout (ADR 0031): the team's, as its settings read them. */
const teamSources = (ctx: InstallCtx, h: Here): SourceEntry[] =>
  ctx.settings?.at(h.top).values.sources ?? [];

/** `abe install sources`: the repo's `sources:`, then what your Claude Code has that it does not define. */
const sourceListOf = async (ctx: InstallCtx, h: Here): Promise<InstallSourcesData> => ({
  repo: h.top,
  sources: sourceRows({ sources: teamSources(ctx, h), found: await h.repo.mcpFound(h.top) }),
});

/**
 * Each of a checkout's sources as its row says it: while it installs, an added one as the
 * install has it; else its server's state now, with its one read and why when a sign-in serve ran
 * from Settings ended on that state, or Signing in… while one runs.
 */
const sourcesOf = async (ctx: InstallCtx, h: Here): Promise<SourcesData> => {
  const i = await load(h);
  const sources = await Promise.all(
    checkoutSources(ctx, h, i).map(async (s) => {
      const signing = installing(i) && i.signingIn.includes(s.id);
      const c = installing(i) ? i.sourceChecks[s.id] : undefined;

      if (installing(i) && i.sources[s.id] === 'add' && (signing || c !== undefined))
        return sourceStatus({ ...s, check: c, signing });
      const had = h.record.signIn(s.id);

      if (had === 'signing-in') return sourceStatus({ ...s, check: undefined, signing: true });
      const mcp = await h.repo.mcp(h.top, s.server);
      // whether it has a sign-in, as its install's check found: one with none is not signed in
      const kept = i?.sourceChecks[s.id];
      const check =
        had?.mcp === mcp
          ? had
          : { mcp, probe: null, why: null, ...(kept === undefined ? {} : { signIn: kept.signIn }) };

      return sourceStatus({ ...s, check, signing: false });
    }),
  );

  return { repo: h.top, sources };
};

/**
 * A source's sign-in from Settings (ADR 0028): the install's runner, outside any sandbox, in the
 * person's browser, then its server's state and one read, kept by the checkout's record for its
 * row and said (`sources.changed`). No session to resume. One at a time per source.
 */
const settingsSignIn = (ctx: InstallCtx, h: Here, s: { id: string; server: string }): void => {
  void h.record
    .startSignIn(s.id, async () => {
      const r = await signInOf(h, s.server);
      const read = await sourceRead(ctx, h, s.server);

      return { ...read, why: r.signedIn ? null : r.why };
    })
    // told once kept: its row reads it
    ?.then(async () => {
      ctx.serve.emit('sources.changed', await sourcesOf(ctx, h));
    })
    .catch(() => undefined);
};

/** A source's sign-in through the auth adapter; one that throws ended unsigned, said why. */
const signInOf = (h: Here, server: string) =>
  h.repo.signInMcp(h.top, server).catch((e: unknown) => ({
    signedIn: false as const,
    why: e instanceof Error ? e.message : 'the sign-in stopped',
    fallback: false,
  }));

/** The install's session when it runs; none: it has none, or it ended. */
const runningSession = async (ctx: InstallCtx, i: Install): Promise<string | undefined> => {
  if (ctx.serve.sessions === undefined || i.session === null) return undefined;
  const had = await ctx.serve.sessions.get(i.session);

  return had.ok && had.data.state !== 'ended' ? i.session : undefined;
};

/** The Abe env files' texts in the checkout `top`, by environment; one not there unsaid. */
export const abeEnvTexts = async (
  repo: Pick<InstallRepo, 'read'>,
  top: string,
): Promise<Partial<Record<AbeEnv, string>>> => {
  const out: Partial<Record<AbeEnv, string>> = {};

  for (const env of ABE_ENVS) {
    const text = await repo.read(top, abeEnvFile(env));

    if (text !== undefined) out[env] = text;
  }

  return out;
};

/** Which of `envs` (default all three) the checkout `top` has an Abe env file of. */
export const hasAbeEnvFiles = async (
  repo: Pick<InstallRepo, 'read'>,
  top: string,
  envs: readonly AbeEnv[] = ABE_ENVS,
): Promise<AbeEnv[]> => {
  const texts = await abeEnvTexts(repo, top);

  return envs.filter((env) => texts[env] !== undefined);
};

/**
 * Every value of the Abe env files in the checkout `top` (ADR 0028), to redact from what a check
 * or a script says: all three, whichever environment it ran in; and the source values.
 */
export const abeEnvRedacted = async (
  repo: Pick<InstallRepo, 'read'>,
  top: string,
): Promise<KnownSecret[]> => [
  ...abeEnvSecrets(await abeEnvTexts(repo, top)),
  // the person's source values too: a server's error may echo one
  ...injectedSecrets(
    Object.fromEntries(parseEnvFile((await repo.read(top, SOURCE_VALUES_PATH)) ?? '')),
  ),
];

/**
 * Every value of the Abe env files in the checkout `top`, for a session's log redaction, each by
 * its environment and key (`TEST_API_KEY`): never in its environment.
 */
export const abeEnvValues = async (
  repo: Pick<InstallRepo, 'read'>,
  top: string,
): Promise<Record<string, string>> => {
  const texts = await abeEnvTexts(repo, top);

  return Object.fromEntries(
    ABE_ENVS.flatMap((env) =>
      [...parseEnvFile(texts[env] ?? '')].map(([k, v]) => [`${env.toUpperCase()}_${k}`, v]),
    ),
  );
};

/**
 * What an environment's app and checks get in the checkout `top` (ADR 0028): exactly the values
 * of its Abe env file (`.abe/abe.<env>.env`) and its aws profile's short-lived keys, the profile as
 * your Layer's block for the checkout names it, and their key names. Refused when the environment
 * is none of dev, test and prod (`unknown-env`), or a profile gives no keys (its login expired),
 * naming its sign-in. The values never leave serve but into the process it starts.
 */
export const credentialsInjection = async (
  repo: InstallRepo,
  settings: Pick<SettingsService, 'at'> | undefined,
  top: string,
  env = 'dev',
): Promise<Outcome<{ env: Record<string, string>; keys: string[] }>> => {
  const known = ABE_ENVS.find((e) => e === env);

  if (known === undefined)
    return refused('unknown-env', `${env} is none of the environments: ${ABE_ENVS.join(', ')}`);
  // an environment off for agents: never its values nor its aws keys (ADR 0029)
  if (!(settings?.at(top).values[agentEnvKey(known)] ?? known !== 'prod'))
    return refused('env-off', envNotEnabled(known));
  const values = Object.fromEntries(parseEnvFile((await repo.read(top, abeEnvFile(known))) ?? ''));
  const profile = settings?.at(top).values.credentials[known]?.awsProfile ?? null;
  const aws = profile === null ? undefined : await repo.awsCredentials(profile);

  if (aws !== undefined && !aws.ok) return refused('aws-login-expired', aws.why);
  const out = { ...values, ...(aws?.ok === true ? aws.env : {}) };

  return { ok: true, data: { env: out, keys: Object.keys(out) } };
};

/**
 * Each environment's aws profile as your Layer keeps it for the checkout (ADR 0028), names only;
 * the Abe env files' paths are fixed, never kept there.
 */
const layerCredentials = (i: Install): Record<string, { awsProfile: string }> => {
  const out: Record<string, { awsProfile: string }> = {};

  for (const env of ABE_ENVS) {
    const profile = i.envFiles?.profiles[env] ?? null;

    if (profile !== null) out[env] = { awsProfile: profile };
  }

  return out;
};

/**
 * What `abe.yaml` gives a key above yours (core's default, then the repo's entry): the value a
 * team write starts from, never one of yours copied into the team's file.
 */
const teamValue = <K extends SettingKey>(
  ctx: InstallCtx,
  top: string,
  key: K,
): Settings[K] | undefined => ctx.settings?.at(top).without('individual').values[key];

/**
 * A team fact written into `abe.yaml` (ADR 0040) when it changes what is there: the install keeps
 * what it judged from the repo in the team's file, so a teammate's install reads it rather than
 * judging again. Refused writes (no settings, a file that does not parse) are said, never thrown.
 */
const writeTeam = <K extends SettingKey>(
  ctx: InstallCtx,
  top: string,
  key: K,
  next: Settings[K],
): Outcome<null> => {
  if (ctx.settings === undefined) return { ok: true, data: null };
  if (JSON.stringify(teamValue(ctx, top, key)) === JSON.stringify(next))
    return { ok: true, data: null };
  const wrote = setRepoAt({ ...ctx, settings: ctx.settings }, top, key, next);

  return wrote.ok ? { ok: true, data: null } : wrote;
};

/**
 * The team facts a move judged, into `abe.yaml` (ADR 0040): the env map as the worktree recipe's
 * groups and its not-used files as `env.notUsed`, the checks' environment, the kind the person
 * said, and the fixed ports Read found.
 */
const teamFactsOf = (
  ctx: InstallCtx,
  h: Here,
  now: Install,
  m: InstallMove | undefined,
): Outcome<null> => {
  const writes: Outcome<null>[] = [];
  const map = now.envFiles?.mapping ?? null;

  if (m?.kind === 'env-map' && map !== null) {
    writes.push(
      writeTeam(
        ctx,
        h.top,
        'worktree',
        recipeWithMap(teamValue(ctx, h.top, 'worktree'), map.files),
      ),
    );
    const unused = map.files.flatMap((f) =>
      f.to === 'not-used' ? [{ key: f.path, why: f.why }] : [],
    );

    writes.push(
      writeTeam(
        ctx,
        h.top,
        'env.notUsed',
        notUsedWith(teamValue(ctx, h.top, 'env.notUsed'), unused),
      ),
    );
  }
  if (m?.kind === 'checks-env' && now.checksEnv !== null)
    writes.push(writeTeam(ctx, h.top, 'checksEnv', now.checksEnv.env));
  if (m?.kind === 'repo-kind') writes.push(writeTeam(ctx, h.top, 'kind', m.said));
  const ports = now.read?.fixedPorts ?? [];

  if (m?.kind === 'read' || m?.kind === 'repo-kind') {
    const fixed = teamValue(ctx, h.top, 'ports.fixed') ?? [];
    const more = ports.filter((p) => !fixed.includes(p));

    if (more.length > 0) writes.push(writeTeam(ctx, h.top, 'ports.fixed', [...fixed, ...more]));
  }

  return writes.find((w) => !w.ok) ?? { ok: true, data: null };
};

/** `abe.yaml`'s places for env files (ADR 0040): its worktree recipe and its `env.notUsed`. */
const teamPlaces = (
  ctx: InstallCtx,
  top: string,
): { recipe: WorktreeRecipe | undefined; notUsed: readonly { key: string; why: string }[] } => {
  const values = ctx.settings?.at(top).values;

  return { recipe: values?.worktree, notUsed: values?.['env.notUsed'] ?? [] };
};

/** `env.notUsed` with `said` over it, by key: a key said again takes its new evidence. */
const notUsedWith = (
  was: readonly { key: string; why: string }[] | undefined,
  said: readonly { key: string; why: string }[],
): { key: string; why: string }[] => [
  ...(was ?? []).filter((n) => !said.some((s) => s.key === n.key)),
  ...said,
];

/**
 * A change to the checkout's record, in turn with every other (`InstallRecord.change`): `step` on
 * the record as kept now (none kept: `join`, the record of a join not begun here), then its IO:
 * the Abe env files written and prefilled once the mapping changed, a skipped source out of
 * `sources:`, an environment's aws profile into yours for the checkout (`m` an env-profile move);
 * saved, said, and each sign-in it opened started.
 */
const commit = async (
  ctx: InstallCtx,
  h: Here,
  step: (i: Install) => Outcome<Install>,
  o: { m?: InstallMove; join?: Install | undefined } = {},
): Promise<Outcome<InstallView>> => {
  const m = o.m;
  const r = await h.record.change(
    async (kept): Promise<Changed<Outcome<{ view: InstallView; opened: string[] }>>> => {
      const was = withHub(h, kept) ?? o.join;

      if (was === undefined)
        return { out: refused('no-install', `${h.top} has no install: abe install starts one`) };
      const moved = step(was);

      if (!moved.ok) return { out: moved };
      const now = moved.data;
      // what it judged of the repo goes into abe.yaml, the team's (ADR 0040)
      const team = teamFactsOf(ctx, h, now, m);

      if (!team.ok) return { out: team };
      // the mapping judged (ADR 0028): the three Abe env files written where missing (`.abe/` is
      // kept out of git) and prefilled from abe.yaml's groups, then it; the person's own lines kept
      if (envMapChanged(was, now))
        await prefillAbeEnvFiles(h.repo, h.top, now, teamPlaces(ctx, h.top));
      // an environment's aws profile: yours for this checkout, what its app and checks get keys from
      if (m?.kind === 'env-profile' && ctx.settings !== undefined)
        setYoursAt({ ...ctx, settings: ctx.settings }, h.top, 'credentials', layerCredentials(now));
      unlistSkipped(ctx, h, was, now);
      const view = viewOf(ctx, now);

      return {
        save: now,
        // said in turn, so the last said is the last saved
        saved: () => ctx.serve.emit('install.changed', view),
        out: {
          ok: true,
          data: {
            view,
            // a sign-in started: serve runs it once the record says so
            opened: now.signingIn.filter(
              (id) => !was.signingIn.includes(id) || (m?.kind === 'sign-in' && m.id === id),
            ),
          },
        },
      };
    },
  );

  if (!r.ok) return r;
  for (const id of r.data.opened) signInLater(ctx, h, id);

  return { ok: true, data: r.data.view };
};

/** One move on the record as kept now, with its IO (`commit`). */
const move = (
  ctx: InstallCtx,
  h: Here,
  m: InstallMove,
  join?: Install,
): Promise<Outcome<InstallView>> => commit(ctx, h, (i) => moveInstall(i, m, at(ctx)), { m, join });

/**
 * The board the repo's settings name (`board`, the one in force), read once with the board login
 * when az is signed in: refused (401, 403), it is no board this login reads. One the person gave
 * and one On this Mac are never read here; null: it reads it, or it was not read.
 */
const layerBoardRefused = async (
  ctx: InstallCtx,
  h: Here,
  board: BoardWhere,
  logins: Install['logins'],
): Promise<{ organization: string; why: string } | null> => {
  const az = logins?.find((l) => l.tool === 'az')?.state === 'ok';

  if (board.from !== 'repo' || !az || board.provider !== 'azure-boards') return null;
  const ref = boardOf(ctx.settings?.at(h.top).values.board);

  // only an Azure board is read with az
  if (!ref.ok || ref.board.provider !== undefined) return null;
  const read = await ctx.ports.board.list(ref.board, { mine: false });

  return read.ok || read.error.code !== 'auth'
    ? null
    : { organization: ref.board.organization, why: read.error.message };
};

/**
 * What a card's new worktree gets copied in from the main checkout (`top`): the team's files its
 * branch tracks (`abe.yaml`, `.claude/skills`, the agent notes `CLAUDE.md` and `AGENTS.md`) as the
 * main checkout's working copy, held out of its commits (`WorktreeCopy.over`); yours for the repo
 * (`.abe/settings.local.yaml`) and the Abe env files of the environments on for agents (`enabled`,
 * ADR 0029; linked, never copied: `copyAbsent`); then the repo's worktree recipe's files
 * (`recipe`, abe.yaml's `worktree:`: linked or copied, an env file of environments off for agents
 * skipped, `recipeCopies`). Nothing else: a file the recipe leaves out is the recipe's to add.
 */
export const worktreeCopies = async (
  repo: InstallRepo,
  top: string,
  i: Install | undefined,
  enabled: readonly AbeEnv[] = ['dev', 'test'],
  recipe?: WorktreeRecipe,
  hooks: RepoHooks = DEFAULT_HOOKS,
): Promise<WorktreeCopy[]> => [
  // the team's files as the main checkout has them (its hook scripts' folders among them), held
  // out of the card's commits (3.2.1), yours for the repo, then its Abe env files, each linked
  ...[...syncTeamPaths(hooks), ...AGENT_NOTE_FILES].map((path) => ({ path, over: true as const })),
  ...((await repo.read(top, LOCAL_PATH)) === undefined ? [] : [{ path: LOCAL_PATH }]),
  ...ABE_ENVS.filter((env) => enabled.includes(env)).map((env) => ({ path: abeEnvFile(env) })),
  ...recipeCopies(recipe, i?.envFiles?.mapping?.files ?? [], enabled),
];

/**
 * The Abe chat stopped and opened again, its conversation resumed, `prompt` its first message
 * there (a source signed in: its server loaded). Not stopped: it goes on as it is.
 */
const restartSession = async (
  ctx: InstallCtx,
  h: Here,
  id: string,
  prompt: string,
): Promise<void> => {
  if (ctx.serve.sessions === undefined || !(await ctx.serve.sessions.stop(id)).ok) return;
  await openHub(ctx, h.top, { say: prompt });
};

/**
 * The Abe chat is at something already: a turn running (or starting), or its turn over on a
 * question or dialog it waits on you for. `/abe:install` would cut into it: it is only opened.
 */
const hubBusy = (ctx: { serve: Pick<InstallCtx['serve'], 'sessions'> }, top: string): boolean => {
  const hub = ctx.serve.sessions?.hub(top);

  if (hub === undefined || hub.state === 'ended') return false;

  return hub.state !== 'waiting' || hub.waitingOn === 'dialog' || hub.asks.length > 0;
};

/**
 * The install's session is the repo's Abe chat: `abe install` opens it (the one running, the one
 * it had reopened, or a new one) and, while the install is not Done and it is not busy, says
 * `/abe:install` to it
 * (with the note that serve and the installed abe differ, when they do). A launch that fails
 * leaves the install as it is, without a session.
 */
const withSession = async (ctx: InstallCtx, h: Here, i: Install): Promise<Install> => {
  const note = serveVersionNote(versionsOf(ctx));
  const opened = await openHub(ctx, h.top, {
    ...(installDone(i) || hubBusy(ctx, h.top)
      ? {}
      : {
          say: [
            `/abe:${INSTALL_SKILL}`,
            ...(note === null
              ? []
              : [
                  `abe serve here is ${ctx.serve.version}, the installed abe is ${ctx.serve.installed() ?? ''}: ${note}. Tell me so in one line at your start; never stop it yourself.`,
                ]),
          ].join('\n\n'),
        }),
  });

  return opened.ok ? { ...i, session: opened.data.id } : i;
};

/** The install's session, when it runs, told this as the person's message. */
const tell = async (ctx: InstallCtx, i: Install, said: string) => {
  if (ctx.serve.sessions === undefined || i.session === null) return;
  const had = await ctx.serve.sessions.get(i.session);

  if (!had.ok || had.data.state === 'ended') return;
  // a question it asked in Chat is closed by this, at once; else it is a message to it
  if (await answerQuestions(ctx, i.session, said)) return;
  await ctx.serve.sessions.message(i.session, said, null);
};

/**
 * The checkout's install, by its record. A repo set up before this Mac kept a record (a teammate's
 * `abe.yaml`, an older abe's) is a join: `join` reads it as one not begun, its personal parts
 * todo (status, checks and logins); anything else is the join's own, `/abe:install`'s.
 */
const started = async (
  ctx: InstallCtx,
  repo: string | undefined,
  join = false,
): Promise<Outcome<{ h: Here; i: Install; join: Install | undefined }>> => {
  const h = await here(ctx, repo);

  if (!h.ok) return h;
  const i = await load(h.data);

  if (i !== undefined) return { ok: true, data: { h: h.data, i, join: undefined } };
  if ((await h.data.repo.read(h.data.top, REPO_PATH)) === undefined)
    return refused('no-install', `${h.data.top} has no install: abe install starts one`);

  const joined = newInstall(h.data.top, at(ctx), true);

  return join
    ? { ok: true, data: { h: h.data, i: joined, join: joined } }
    : refused(
        'installed',
        `${h.data.top} is set up for Abe (${REPO_PATH}), not yet on this Mac: /abe:install in its Abe chat joins it`,
      );
};

/** The compose files a script that runs docker compose reads its `env_file:` from. */
const composeFiles = async (h: Here, text: string) => {
  const out: { dir: string; text: string }[] = [];

  for (const c of composePaths(text)) {
    const read = await h.repo.read(h.top, c.path);

    if (read !== undefined) out.push({ dir: c.dir, text: read });
  }

  return out;
};

/** The commands the Layers in force at the checkout give its checks, and its setup. */
const writtenChecks = (ctx: InstallCtx, top: string): WrittenCheck[] => {
  const v = ctx.settings?.at(top).values;

  return [
    ...(v?.checks ?? []).flatMap((c) =>
      typeof c === 'string' || c.run === undefined ? [] : [{ name: c.name, run: c.run }],
    ),
    ...(v?.setup === undefined || v.setup === null ? [] : [{ name: 'setup', run: v.setup }]),
  ];
};

/** The written files that name the checks besides the repo's skills: the agent files. */
const CHECK_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

/**
 * Verify's Verification pack as written (`verification-pack.ts`): `verify-<app>` whole and its
 * Feature map, then one mapped feature proven end to end, its screenshot and recording kept in
 * `.scratch/install/verify/<feature>/` past cleanup. Nothing runs here: the skill alone (it says
 * the static checks). The app not run (Go on without running it): the pack, no proof.
 */
const packRefused = async (h: Here, i: Install): Promise<PartVerdict | null> => {
  const p = packPaths(h.top, h.hooks);
  const map = await h.repo.read(h.top, p.map);
  const ids = map === undefined ? [] : featuresOf(map);
  const features = new Map<string, string | undefined>();
  const proofs = new Map<string, string[]>();

  for (const id of ids) {
    features.set(id, await h.repo.read(h.top, `${p.features}/${id}.md`));
    proofs.set(id, await h.repo.list(h.top, `${INSTALL_PROOF_DIR}/${id}`));
  }
  const skill = await h.repo.read(h.top, p.skill);
  const found = packFindings({
    repo: h.top,
    skill,
    map,
    features,
    listed: await h.repo.list(h.top, p.features),
  });
  const said =
    nothingToRun(i.read?.kind) !== null
      ? packRefusal(found.filter((f) => f.code === 'no-verify-skill'))
      : packRefusal([
          ...found,
          ...(i.notRun !== null
            ? []
            : installProofFindings({
                features: ids,
                proofs,
                surface: packSurface(skill),
                surfaces: featureSurfaces(features, packSurface(skill)),
              })),
        ]);

  return said === null ? null : partFailed(said.code, said.message);
};

/**
 * The checks the written files name that settings.yaml's `checks:` does not list (the one list),
 * the person's own tracked `CLAUDE.md` too: each said in the check as "Not a check yet:
 * `<command>` (<why>)", the why from what Checks saw of it, unless a file says so already. A note,
 * never a refusal, and no file written.
 */
const unlistedLines = async (ctx: InstallCtx, h: Here, i: Install): Promise<string[]> => {
  const files = new Map<string, string>();
  const skills = testingSkills(h.hooks, await h.repo.list(h.top, REPO_SKILLS_DIR));
  const paths = [
    ...CHECK_FILES,
    packPaths(h.top, h.hooks).skill,
    ...skills.map((n) => `${REPO_SKILLS_DIR}/${n}/SKILL.md`),
  ];

  for (const path of paths) {
    const text = await h.repo.read(h.top, path);

    if (text !== undefined) files.set(path, text);
  }
  const unlisted = unlistedChecks({
    listed: writtenChecks(ctx, h.top),
    scripts: i.read?.scripts ?? {},
    ci: (i.read?.ci ?? []).flatMap((c) => c.commands),
    files,
  });
  return notACheckLines(unlisted, i.checkRuns);
};

/**
 * What a check serve runs for the install gets (`abe install check`): the checks' environment
 * (`checksEnvOf`: `abe.yaml`'s `checksEnv`, else the one an older install recorded, else dev) as `abe run --env` gets it (`credentialsInjection`) and CI's `NODE_OPTIONS` (read
 * from the CI files Read found), and the values redacted from what it says: the injected ones,
 * every Abe env file's and every env file's in the checkout. Values stay in serve.
 */
const checkEnv = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<
  Outcome<{ env: Record<string, string>; secrets: { kind: string; value: string }[] }>
> => {
  const injected = await credentialsInjection(
    h.repo,
    ctx.settings,
    h.top,
    checksEnvOf(i, ctx.settings?.at(h.top).values.checksEnv),
  );

  if (!injected.ok) return injected;
  const ci = await Promise.all(
    (i.read?.ci ?? []).map(async (c) => ({
      path: c.file,
      text: (await h.repo.read(h.top, c.file)) ?? '',
    })),
  );
  const nodeOptions = ciNodeOptions(ci);
  const files = await Promise.all(
    (i.read?.envFiles ?? []).map(async (f) =>
      parseEnvFile((await h.repo.read(h.top, f.path)) ?? ''),
    ),
  );
  const values = Object.fromEntries(files.flatMap((f) => [...f]));

  return {
    ok: true,
    data: {
      env: { ...injected.data.env, ...(nodeOptions === null ? {} : { NODE_OPTIONS: nodeOptions }) },
      secrets: [
        ...injectedSecrets(values),
        ...injectedSecrets(injected.data.env),
        ...(await abeEnvRedacted(h.repo, h.top)),
      ],
    },
  };
};

/**
 * The database a check gets in dev (`takesOwnDatabase`): the install session's own, as its `abe
 * run` gets it (the repo's hook's or Abe's local one, by the rule a card's session has), over dev's
 * Abe env file's `DATABASE_URL`; `said` why none when one could not be had (Docker not running).
 * In test or prod, or with no session, nothing: that environment's file's alone.
 */
const checkDatabase = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<{ url?: string; said?: string }> => {
  if (
    !takesOwnDatabase(checksEnvOf(i, ctx.settings?.at(h.top).values.checksEnv)) ||
    i.session === null ||
    ctx.serve.localApps === undefined
  )
    return {};
  const db = await ctx.serve.localApps.database({ id: i.session, repo: h.top, install: true });

  if (!db.ok) return { said: db.error.message };

  return db.data === undefined ? {} : { url: db.data };
};

/** Each check run by serve in the main checkout, in order: how it ended, its tail redacted. */
const runChecksHere = async (
  ctx: InstallCtx,
  h: Here,
  picked: readonly { name: string | null; run: string }[],
  env: { env: Record<string, string>; secrets: { kind: string; value: string }[] },
): Promise<InstallCheckRun[]> => {
  const runs: InstallCheckRun[] = [];

  for (const c of picked) {
    const started = ctx.serve.clock.now();
    const ran = await h.repo.runCheck(h.top, {
      run: c.run,
      env: env.env,
      timeoutMs: CHECK_TIMEOUT_MS,
    });

    runs.push({
      name: c.name,
      run: c.run,
      ok: ran.exit === 0 && !ran.timedOut,
      exit: ran.exit,
      timedOut: ran.timedOut,
      durationMs: Math.max(0, Math.round(ctx.serve.clock.now() - started)),
      tail: checkTail(redactText(withoutAnsi(ran.output), env.secrets)),
    });
  }

  return runs;
};

/**
 * The repo's testing skill as Skills writes it (the `testing` hook, else any `<name>-testing`
 * among the repo's skills); undefined: none.
 */
const testingSkill = async (h: Here): Promise<string | undefined> => {
  for (const name of testingSkills(h.hooks, await h.repo.list(h.top, REPO_SKILLS_DIR)))
    if ((await h.repo.read(h.top, `${REPO_SKILLS_DIR}/${name}/SKILL.md`)) !== undefined)
      return `${REPO_SKILLS_DIR}/${name}/SKILL.md`;

  return undefined;
};

/** The checks `checks:` lists (the setup aside), run by serve now: each one's end. */
const runListed = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<Outcome<{ listed: { name: string; run: string }[]; runs: InstallCheckRun[] }>> => {
  const listed = writtenChecks(ctx, h.top).filter((c) => c.name !== 'setup');

  if (listed.length === 0) return { ok: true, data: { listed, runs: [] } };
  const env = await checkEnv(ctx, h, i);

  if (!env.ok) return env;
  const db = await checkDatabase(ctx, h, i);
  const own = db.url === undefined ? {} : { [WORKSPACE_DATABASE]: db.url };
  const runs = await runChecksHere(ctx, h, listed, {
    env: { ...env.data.env, ...own },
    secrets: [...env.data.secrets, ...injectedSecrets(own)],
  });

  return { ok: true, data: { listed, runs } };
};

/** The checks' ends recorded; none ran: the record as it is. */
const checksRecorded = (i: Install, runs: readonly InstallCheckRun[], now: string): Install =>
  runs.length === 0 ? i : moved(i, { kind: 'check-ran', runs: [...runs] }, now);

/** A move's record, or the record as it was when the move is refused. */
const moved = (i: Install, m: InstallMove, now: string): Install => {
  const r = moveInstall(i, m, now);

  return r.ok ? r.data : i;
};

/**
 * The Board check's reads: the `board` setting in force and its problem, the board login's read
 * of the board the repo's Layer names, who merges and where specs go as the repo's Layer writes
 * them, and the workflows the board's card types never preselect.
 */
const boardReads = async (ctx: InstallCtx, h: Here, i: Install): Promise<Outcome<BoardReads>> => {
  const merged = ctx.settings?.at(h.top);
  const problem = merged?.problems.find((p) => p.key === 'board');
  const inForce = boardInForce(ctx, h.top);
  const board = boardKept(i.board, inForce);
  const named =
    problem === undefined &&
    board !== null &&
    board.provider !== 'github-projects' &&
    board.provider !== 'jira';
  const specs = merged
    ?.explain('spec.where')
    .layers.find((l) => l.layer === 'repo' && l.applied && l.written !== null);
  const ref = boardOf(merged?.values.board);

  return {
    ok: true,
    data: {
      problem: problem === undefined ? null : { file: problem.file, message: problem.message },
      inForce,
      unreadable: named ? await layerBoardRefused(ctx, h, board, i.logins) : null,
      merges: repoAutoMerge(ctx, h.top),
      specWritten: merged === undefined || specs !== undefined,
      specWhere: merged?.values['spec.where'] ?? 'issue',
      // the workflows whose `on: type` the board's card types (`board.types`) lack
      unmet: unmetTypes(
        loadedWorkflows(ctx.settings, h.top),
        ref.ok ? ref.board.types : DEFAULT_CARD_TYPES,
      ),
    },
  };
};

/** The Skills check's reads: the testing skill, `CLAUDE.md`, and the checks `checks:` lacks. */
const skillsReads = async (ctx: InstallCtx, h: Here, i: Install): Promise<SkillsReads> => ({
  skill: (await testingSkill(h)) ?? null,
  notes: (await h.repo.read(h.top, AGENT_NOTES)) ?? null,
  unlisted: await unlistedLines(ctx, h, i),
  hooks: h.hooks,
  app: installRepoName(h.top),
});

/**
 * The run-app skill's `SKILL.md` documents its `read-data` heading (`## Read data`: the person
 * said there is a database): the `query` hook's script there, the agents' way to the app's data.
 */
const queryRefused = async (h: Here): Promise<PartVerdict | null> => {
  const file = runAppSkill(h.hooks).skill;
  const skill = await h.repo.read(h.top, file);

  if (skill === undefined || !hasHeading(h.hooks, 'read-data', skill)) return null;
  const query = h.hooks.query;

  return (await h.repo.read(h.top, query)) === undefined
    ? partFailed(
        'no-query-script',
        `${file} says ${h.hooks['read-data']}, but ${query} is not there: write it (one read-only statement a file, the database's own read-only session)`,
      )
    : null;
};

/**
 * The Verify check's reads, each once the one before it passed: the app run locally (the gate
 * passed, nothing runs here, or it can't run here as the person chose), the query script
 * run-app's `## Read data` names, the repo's Verification pack, then the checks run again after
 * it is written (QA N2).
 */
const verifyReads = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<Outcome<VerifyReads & { runs: InstallCheckRun[] }>> => {
  const none = {
    query: null,
    pack: null,
    listed: [],
    runs: [],
    skill: verifySkill(h.hooks, h.top),
  };
  const ran = ranLocally(i);

  if (ran.state !== 'pass') return { ok: true, data: { ...none, ran } };
  const query = await queryRefused(h);

  if (query !== null) return { ok: true, data: { ...none, ran, query } };
  const pack = await packRefused(h, i);

  if (pack !== null) return { ok: true, data: { ...none, ran, pack } };
  const again = await runListed(ctx, h, i);

  if (!again.ok) return again;

  // passing again, a check the files name that the checks: list lacks is said by Skills' check
  return { ok: true, data: { ...none, ran, ...again.data } };
};

/** The repo's skills' folders, from the top. */
const repoSkills = async (h: Here): Promise<string[]> =>
  (await h.repo.list(h.top, REPO_SKILLS_DIR)).map((n) => `${REPO_SKILLS_DIR}/${n}`);

/** Of `paths` (files or folders from the top), those there and changed or new as git has them. */
const changedOf = async (h: Here, paths: readonly string[]): Promise<string[]> => {
  const changed = await h.repo.changed(h.top);
  const out: string[] = [];

  for (const path of paths) {
    const there =
      (await h.repo.read(h.top, path)) !== undefined || (await h.repo.list(h.top, path)).length > 0;
    const moved = changed.some((c) => c === path || c.startsWith(`${path}/`));

    if (there && (moved || !(await h.repo.tracked(h.top, path)))) out.push(path);
  }

  return out;
};

/**
 * The team's files the person commits and pushes, as git has them: `abe.yaml` and each repo skill,
 * changed or new. Abe never commits them.
 */
const toCommit = async (h: Here): Promise<string[]> =>
  changedOf(h, [REPO_PATH, REPO_ABE_DIR, ...(await repoSkills(h))]);

/**
 * The files the install wrote, for Chat's install strip to open: the team's changed or new
 * (`abe.yaml`, `CLAUDE.md`, `AGENTS.md`, the prototype-start hook, a repo skill's `SKILL.md`), then the person's `.abe/`
 * files there. Paths alone, never a value.
 */
const installFiles = async (h: Here): Promise<string[]> => {
  const team = await changedOf(h, [
    REPO_PATH,
    AGENT_NOTES,
    'AGENTS.md',
    h.hooks['prototype-start'],
    ...(await repoSkills(h)),
  ]);
  const out: string[] = [];

  for (const path of [
    ...team.map((p) => (p.startsWith(`${REPO_SKILLS_DIR}/`) ? `${p}/SKILL.md` : p)),
    ...ABE_ENVS.map(abeEnvFile),
    LOCAL_PATH,
  ])
    if ((await h.repo.read(h.top, path)) !== undefined) out.push(path);

  return out;
};

/**
 * The Worktree check's reads: whether `abe.yaml` has a `worktree:` and whether the settings dropped
 * it (no worktree tried then), a throwaway worktree made ready by the recipe (`tryWorktree`) with
 * what a card's gets (`worktreeCopies`), and the env files placed (abe.yaml's groups, then the env map) in an environment on
 * for agents that no copy covers.
 */
const tryRecipe = async (ctx: InstallCtx, h: Here, i: Install): Promise<WorktreeTried> => {
  const text = await h.repo.read(h.top, REPO_PATH);
  const doc = text === undefined ? undefined : parseYaml(text);
  const top = doc !== undefined && 'doc' in doc ? doc.doc : undefined;
  const written =
    typeof top === 'object' &&
    top !== null &&
    !Array.isArray(top) &&
    Object.hasOwn(top, 'worktree');
  const merged = ctx.settings?.at(h.top);
  // abe.yaml's own entry dropped by the settings (said by `abe settings problems`): none of it in force
  const dropped = merged?.problems.find(
    (p) => p.key === 'worktree' && p.layer === 'repo' && p.code !== 'duplicate-setting',
  );

  if (written && dropped !== undefined)
    return {
      written,
      dropped: `${dropped.file}: worktree: ${dropped.message}`,
      tried: { ok: false, why: dropped.message },
      uncovered: [],
    };
  const values = merged?.values;
  const enabled = ABE_ENVS.filter((e) => values?.[agentEnvKey(e)] ?? e !== 'prod');
  const copy = await worktreeCopies(h.repo, h.top, i, enabled, values?.worktree, h.hooks);
  const covered = (p: string) =>
    copy.some((c) => c.skip === undefined && (c.path === p || p.startsWith(`${c.path}/`)));
  const uncovered: string[] = [];

  for (const f of envFilesPlaced(i, values?.worktree, values?.['env.notUsed']))
    if (
      typeof f.to !== 'string' &&
      f.to.some((e) => enabled.includes(e)) &&
      !covered(f.path) &&
      (await h.repo.read(h.top, f.path)) !== undefined &&
      !(await h.repo.tracked(h.top, f.path))
    )
      uncovered.push(f.path);
  const tried = (await h.repo.tryWorktree?.(h.top, { copy, run: h.hooks['worktree-setup'] })) ?? {
    ok: false,
    error: {
      code: 'no-worktree',
      message: 'this serve cannot make a worktree to try the recipe in',
    },
  };

  return {
    written,
    tried: tried.ok ? { ok: true, ...tried.data } : { ok: false, why: tried.error.message },
    uncovered,
  };
};

/**
 * The Prototype check's reads: nothing runs here, or the repo's `prototype-start` hook
 * tried as a prototype's start, step by step (`tryPrototype`), the try kept on the record.
 */
const prototypeReads = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<Outcome<{ tried: PrototypeTry | null; nothing: string | null }>> => {
  const nothing = nothingToRun(i.read?.kind);

  if (nothing !== null) return ok({ tried: null, nothing });
  if (ctx.serve.prototypes === undefined)
    return refused(
      'no-prototypes',
      'this abe serve runs no prototypes, so it cannot try the start',
    );
  const p = ctx.serve.prototypes;

  await p.ready;
  // one try at a time: they share their place
  const tried = await p.serial(TRY_ID, () =>
    tryPrototype(p, {
      repo: h.top,
      at: at(ctx),
      keysOf: async (env) => [
        ...parseEnvFile((await h.repo.read(h.top, abeEnvFile(env))) ?? '').keys(),
      ],
    }),
  );

  return ok({ tried, nothing: null });
};

/**
 * A part's check as one row: its reads, serve's (IO on the record as it was read, never a write to
 * it), then what they record and the verdict on them, core's (the reads passed in as data, on
 * the record as it is kept when the check saves). A read refused fails the part, nothing recorded.
 */
type PartRow<R> = {
  read: (ctx: InstallCtx, h: Here, i: Install) => Promise<Outcome<R>>;
  /** The reads recorded (core's moves); none: nothing but the verdict. */
  record?: (i: Install, r: R, now: string) => Install;
  /** The connection read live once the reads are recorded, for the facts its verdict judges. */
  live?: true;
  verdict: (i: Install, r: R) => PartVerdict;
};

/** A part checked: its reads done, and what records them and its verdict on any record. */
type PartStep = (i: Install) => Install;

type PartCheck = (
  ctx: InstallCtx,
  h: Here,
  i: Install,
  part: InstallPart,
  now: string,
) => Promise<PartStep>;

const row =
  <R>(r: PartRow<R>): PartCheck =>
  async (ctx, h, i, part, now) => {
    const read = await r.read(ctx, h, i);

    if (!read.ok) return (on) => partChecked(on, part, failedOf(read), now);
    const recorded = (on: Install) => r.record?.(on, read.data, now) ?? on;
    // the connection read live on the record as these reads leave it
    const live = r.live === true ? await connectionMove(ctx, h, recorded(i)) : undefined;

    return (on) => {
      const after = live === undefined ? recorded(on) : moved(recorded(on), live, now);

      return partChecked(after, part, r.verdict(after, read.data), now);
    };
  };

const ok = <T>(data: T): Outcome<T> => ({ ok: true, data });

/**
 * Each part's check: its reads beside core's verdict on them. Logins, Board and Sources read the
 * connection live too (`LIVE_READS`).
 */
const PART_CHECKS: Readonly<Record<InstallPart, PartCheck>> = {
  logins: row({
    read: loginsMove,
    record: (i, m, now) => moved(i, m, now),
    live: true,
    verdict: (i) => loginsPart(i),
  }),
  board: row({ read: boardReads, record: boardRecorded, live: true, verdict: boardPart }),
  sources: row({
    // the repo's sources: are the team's servers a session here loads (ADR 0031); each added one
    // and each the team's whose check has not passed, not signing in: its server's state and,
    // connected, its probe's one read, recorded under its name (`checkedSourceServers`)
    read: async (ctx, h, i) => {
      const team = teamSources(ctx, h).map(sourceName);
      const have = [...(await h.repo.ownMcpServers(h.top)), ...team];
      const looked = moved(i, { kind: 'sources', have }, at(ctx));
      const checks: Extract<InstallMove, { kind: 'source-check' }>[] = [];

      for (const s of sourcesToCheck(looked, team))
        if (!sourceSettled(looked, s.id))
          checks.push({ kind: 'source-check', id: s.id, ...(await sourceRead(ctx, h, s.server)) });
      // a reference with no value of the person's: its server starts without it
      const values = parseEnvFile((await h.repo.read(h.top, SOURCE_VALUES_PATH)) ?? '');
      const unvalued = sourceReferences(teamSources(ctx, h)).filter(
        (v) => (values.get(v) ?? '') === '',
      );

      return ok({ team, have, checks, unvalued });
    },
    // a source settled since it was read (signed in, its sign-in started) keeps what it has
    record: (i, r, now) =>
      r.checks.reduce(
        (on, c) => (sourceSettled(on, c.id) ? on : moved(on, c, now)),
        moved(i, { kind: 'sources', have: r.have }, now),
      ),
    live: true,
    verdict: (i, r) => sourcesPart(i, r.team, r.unvalued),
  }),
  'env-files': row({
    read: async (ctx, h, i) => {
      const team = teamPlaces(ctx, h.top);
      const placed = envFilesPlaced(i, team.recipe, team.notUsed);
      const absent = async () => {
        const missing: AbeEnv[] = [];

        for (const env of ABE_ENVS)
          if ((await h.repo.read(h.top, abeEnvFile(env))) === undefined) missing.push(env);

        return missing;
      };

      // abe.yaml places the env files already (a teammate's install): the Abe env files are
      // prefilled from it, with no env map to judge here
      if ((await absent()).length > 0 && placed.some((f) => f.from === 'recipe'))
        await prefillAbeEnvFiles(h.repo, h.top, i, team);

      return ok({
        missing: await absent(),
        unplaced: placed.filter((f) => f.from === 'record').map((f) => f.path),
      });
    },
    verdict: (i, r) => envFilesPart(i, r.missing, r.unplaced),
  }),
  worktree: row({
    read: async (ctx, h, i) => ok(await tryRecipe(ctx, h, i)),
    verdict: (_, w) => worktreePart(w),
  }),
  checks: row({
    read: async (ctx, h, i) => {
      const workarounds = sandboxWorkarounds(
        writtenChecks(ctx, h.top),
        (i.read?.ci ?? []).flatMap((c) => c.commands),
      );

      if (workarounds.length > 0) return ok({ workarounds, listed: [], runs: [] });
      const ran = await runListed(ctx, h, i);

      return ran.ok ? ok({ workarounds, ...ran.data }) : ran;
    },
    record: (i, r, now) => checksRecorded(i, r.runs, now),
    verdict: (i, r) => checksPart(i, r.listed, r.workarounds),
  }),
  workflows: row({
    // Abe's workflows and skills into abe/ once, the repo's from then on; a newer Abe's said
    read: (ctx, h) => {
      const copied = copyAbeFiles(h.top, ctx.serve.version);

      return Promise.resolve(
        ok({
          there: abeFilesIn(h.top),
          copied: copied.copied ? copied : null,
          updates: abeUpdatesWords(ctx.serve.version, abeUpdatesIn(h.top)),
        }),
      );
    },
    verdict: (_, r) => workflowsPart(r),
  }),
  skills: row({
    read: async (ctx, h, i) => ok(await skillsReads(ctx, h, i)),
    verdict: (_, r) => skillsPart(r),
  }),
  verify: row({
    read: verifyReads,
    record: (i, r, now) => checksRecorded(i, r.runs, now),
    verdict: verifyPart,
  }),
  prototype: row({
    read: prototypeReads,
    record: (i, r) => (r.tried === null ? i : { ...i, prototypeTry: r.tried }),
    verdict: (_, r) => prototypePart(r.tried, r.nothing),
  }),
  done: row({ read: async (_, h) => ok(await toCommit(h)), verdict: donePart }),
};

/**
 * `abe install`: a new record Read first (local files only), a join when the repo has an
 * `abe.yaml` already (a teammate's); `.abe/` kept out of git; the session launched, or reopened.
 */
const begin = async (ctx: InstallCtx, h: Here): Promise<Outcome<InstallView>> => {
  const before = await load(h);
  const fresh =
    before ?? newInstall(h.top, at(ctx), (await h.repo.read(h.top, REPO_PATH)) !== undefined);

  // `.abe/` is the person's alone (their env files, their settings): never in git
  await h.repo.exclude(h.top, [LOCAL_DIR], true);
  const read =
    fresh.read === null ? await readMove(ctx, h, kindSaidAt(ctx, h.top, fresh)) : undefined;
  // Read once: a record Read since keeps its findings
  const saved = await commit(
    ctx,
    h,
    (i) => (read === undefined || i.read !== null ? ok(i) : moveInstall(i, read, at(ctx))),
    { ...(read === undefined ? {} : { m: read }), join: fresh },
  );
  const now = saved.ok ? await load(h) : undefined;

  // the session starts on what Read found, so its first status already has it
  if (now === undefined) return saved;
  const sessioned = await withSession(ctx, h, now);

  return { ok: true, data: viewOf(ctx, sessioned) };
};

/** At most this many files the start script loads are read. */
const START_LOADS_READ = 10;

/** At most this many code files are read for dotenv: entry files and what they import. */
const CODE_READ = 20;

/** How an import names a file: as written, or without its extension or as a folder. */
const CODE_TRIES = ['', '.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];

/** A path from a folder (`.` the top), from the top; null: out of the checkout. */
const joinedPath = (dir: string, path: string): string | null => {
  const parts = dir === '.' ? [] : dir.split('/');

  for (const p of path.split('/'))
    if (p === '..') {
      if (parts.pop() === undefined) return null;
    } else if (p !== '' && p !== '.') parts.push(p);

  return parts.length === 0 ? null : parts.join('/');
};

/** A path's folder from the checkout's top (`.` for the top's own). */
const dirOfPath = (path: string): string => {
  const at = path.lastIndexOf('/');

  return at === -1 ? '.' : path.slice(0, at);
};

/**
 * The Abe env file of the checks' environment (`checksEnvOf`, dev when none said) as `abe run`
 * hands it to the app: none when that environment is off for agents or the file is not there.
 */
const gateAbeFile = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
): Promise<{ abe?: { path: string; values: ReadonlyMap<string, string> } }> => {
  const env = checksEnvOf(i, ctx.settings?.at(h.top).values.checksEnv);

  if (!(ctx.settings?.at(h.top).values[agentEnvKey(env)] ?? env !== 'prod')) return {};
  const text = await h.repo.read(h.top, abeEnvFile(env));

  return text === undefined ? {} : { abe: { path: abeEnvFile(env), values: parseEnvFile(text) } };
};

/** Only a URL on this Mac is ever asked: the gate never touches anything remote. */
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.[0-9.]+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

/**
 * The gate on what the checkout's files say now: with `url`, the app's too; without, before the
 * run (`abe run start` asks it first). Just this Mac's (no kind yet too) refuses a run that loads
 * cloud credentials. Values never leave serve.
 */
const gateRead = async (
  ctx: InstallCtx,
  h: Here,
  i: Install,
  url: string | undefined,
  testHosts: readonly string[],
  notUsed: readonly NotUsed[],
  /** The pack script judged; the gate's is the `start` hook. */
  script: string = h.hooks.start,
  readOnlyHosts: readonly string[] = [],
): Promise<{ result: GateResult }> => {
  // every env file in the checkout and its workspaces, each folder's example first: read here,
  // their values never leaving serve
  const workspaces = i.read?.workspaces ?? [];
  const examples = [i.read?.envExample ?? null, ...workspaces.map((w) => w.envExample)].filter(
    (e) => e !== null,
  );
  const files: (EnvFileSeen & { values: ReadonlyMap<string, string> })[] = [];
  const byItself: readonly string[] = ENV_FILES;
  const order = (n: string) => {
    const at = byItself.indexOf(n);

    return at === -1 ? byItself.length : at;
  };

  for (const dir of [...new Set(['.', ...workspaces.map((w) => w.dir)])]) {
    const at = (n: string) => (dir === '.' ? n : `${dir}/${n}`);
    const own = (await h.repo.list(h.top, dir))
      .filter(isEnvFileName)
      .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
      .map(at);

    for (const path of [...examples.filter((e) => dirOfPath(e) === dir), ...own]) {
      const text = await h.repo.read(h.top, path);

      if (text === undefined) continue;
      const example = examples.includes(path);

      files.push({
        path,
        example,
        ignored: example ? false : await h.repo.ignored(h.top, path),
        tracked: example ? false : await h.repo.tracked(h.top, path),
        values: parseEnvFile(text),
      });
    }
  }
  const merged = ctx.settings?.at(h.top);
  // the person's answers: abe.yaml's (gate.*, env.notUsed: the team's, ADR 0040), what is given
  // now, and an older install's on this Mac
  const hosts = [
    ...new Set([...(merged?.values['gate.testHosts'] ?? []), ...testHosts, ...i.testHosts]),
  ];
  const readOnly = [
    ...new Set([
      ...(merged?.values['gate.readOnlyHosts'] ?? []),
      ...readOnlyHosts,
      ...i.readOnlyHosts,
    ]),
  ];
  const start = await h.repo.read(h.top, script);
  // what start loads besides those env files, read from the top or a folder it changes into;
  // one outside the checkout (or with a variable in its path) is unread
  const loads = startLoads(start ?? '');
  const loaded: StartLoad[] = [];

  for (const named of loads.paths.slice(0, START_LOADS_READ)) {
    const p = named.replace(/^\.\//, '');
    const paths = [p, ...loads.dirs.map((d) => `${d.replace(/\/+$/, '')}/${p}`)];

    let read: StartLoad | undefined;

    for (const path of paths) {
      const text = await h.repo.read(h.top, path);

      if (text !== undefined) {
        read = { path, values: loadedValues(path, text) };
        break;
      }
    }
    loaded.push(read ?? { path: named, values: null });
  }

  const unused = notUsedWith(notUsedWith(i.notUsed, merged?.values['env.notUsed'] ?? []), notUsed);
  const scripts = [
    { dir: '.', scripts: i.read?.scripts ?? {} },
    ...workspaces.map((w) => ({ dir: w.dir, scripts: w.scripts })),
  ];
  // the app's entry files start runs, and what they import, bounded: where code loads dotenv
  const code: { dir: string; path: string; text: string }[] = [];
  const readCode = async (dir: string, path: string) => {
    if (code.length >= CODE_READ || code.some((c) => c.path === path)) return undefined;
    for (const at of CODE_TRIES.map((t) => `${path}${t}`)) {
      const text = await h.repo.read(h.top, at);

      if (text !== undefined) {
        code.push({ dir, path: at, text });

        return { path: at, text };
      }
    }

    return undefined;
  };

  for (const e of runEntries({ start: start ?? '', scripts })) {
    const read = await readCode(e.dir, e.path);

    for (const imported of read === undefined ? [] : codeImports(read.text)) {
      const at = joinedPath(dirOfPath(read?.path ?? ''), imported);

      if (at !== null) await readCode(e.dir, at);
    }
  }

  return {
    result: gate({
      ...(url === undefined ? {} : { url }),
      answered: url !== undefined && LOOPBACK_URL.test(url) && (await h.repo.answers(url)),
      local: cardsRunAt(ctx, h.top) === 'local',
      script,
      files,
      prod: merged?.values.prodEnvironments ?? [],
      testHosts: hosts,
      readOnlyHosts: readOnly,
      start,
      scripts,
      loaded,
      code,
      // what Abe hands every run: its own database and its port base
      given: [WORKSPACE_DATABASE, PORT_BASE],
      // and the checks' environment's Abe env file, as abe run gets it (when on for agents)
      ...(await gateAbeFile(ctx, h, i)),
      notUsed: unused,
      // the env files with cloud credentials, as Read found them and by their key names now
      credentials: [
        ...new Map(
          [
            ...(i.read?.cloudCredentials ?? []),
            ...files.flatMap((f) => {
              const why = f.example ? undefined : cloudCredentialsWhy(f.path, [...f.values.keys()]);

              return why === undefined ? [] : [{ path: f.path, why }];
            }),
          ].map((c) => [c.path, c]),
        ).values(),
      ],
      compose: await composeFiles(h, start ?? ''),
    }),
  };
};

/**
 * `abe run <script>` from a local session: what the pack script loads is judged first (`gate`
 * without a URL, on its own text in the main checkout; names and hosts only), and what the gate
 * would not pass is its warning (`beforeRunWarning`, the credential warning first), never a
 * refusal. An install's session tells its install (`before-run`: Just this Mac's Run locally at
 * Needs you, `beforeRunAsks`); a card's session is judged on its checkout's install, which it
 * never moves. `stop` is never judged: it only ends what start left running. Undefined: nothing
 * to warn of, or no install to judge by.
 */
export const runWarning = async (
  ctx: InstallCtx,
  script: string,
): Promise<Outcome<string | undefined>> => {
  const meta = ctx.session === undefined ? undefined : ctx.serve.sessions?.metaOf(ctx.session);
  // the Abe chat's own checkout (its requests are the person's)
  const own = ctx.hub === undefined ? undefined : ctx.serve.sessions?.metaOf(ctx.hub)?.abe?.repo;
  const repo = own ?? (meta?.card === null ? undefined : meta?.repo);
  const name = basename(script);
  const role = RUN_ROLES.find((r) => r === name);

  if (repo === undefined || name === 'stop') return { ok: true, data: undefined };
  // a card's checkout with no install has nothing to judge by: nothing read in it
  if (own === undefined && (await ctx.serve.install?.store.read(repo)) === undefined)
    return { ok: true, data: undefined };
  const s = await started(ctx, repo);

  if (!s.ok) return own === undefined ? { ok: true, data: undefined } : s;
  const { h, i } = s.data;
  // a role's script by its role, else the run-app skill's helper of that name
  const judged = role === undefined ? `${runAppSkill(h.hooks).scripts}/${name}` : h.hooks[role];
  const read = await gateRead(ctx, h, i, undefined, [], [], judged);

  if (own !== undefined) {
    const moved = await move(ctx, h, { kind: 'before-run', result: read.result });

    if (!moved.ok) return moved;
  }

  return { ok: true, data: beforeRunWarning(read.result) ?? undefined };
};

/**
 * `rel` under the checkout deleted where git tracks nothing in it (yours: untracked or ignored);
 * a folder that holds tracked files is gone through, its tracked files left as they are.
 */
const removeUntracked = async (h: Here, rel: string): Promise<void> => {
  const path = join(h.top, rel);

  if (!(await h.repo.tracked(h.top, rel))) {
    rmSync(path, { recursive: true, force: true });

    return;
  }
  if (!lstatSync(path).isDirectory()) return;
  for (const name of readdirSync(path)) await removeUntracked(h, join(rel, name));
};

export const installHandlers = <Ctx extends InstallCtx>() =>
  ({
    install: async (args, ctx) => {
      const h = await here(ctx, args.repo);

      return h.ok ? begin(ctx, h.data) : h;
    },
    'install status': async (args, ctx) => {
      const s = await started(ctx, args.repo, true);

      return s.ok ? { ok: true, data: viewOf(ctx, s.data.i) } : s;
    },
    // a clean start: `.abe/`'s untracked files deleted, the record aside; the team's files never touched
    'install reset': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      const { h } = s.data;
      // the Abe chat is the person's: it goes on (it may be the one asking)
      const stopped = null;
      const abe = join(h.top, LOCAL_DIR);
      const removed = existsSync(abe);

      // what the repo commits there (its old scripts, settings) is the team's, never deleted
      if (removed) await removeUntracked(h, LOCAL_DIR);
      const aside = await h.record.aside(at(ctx));

      return aside === undefined
        ? refused('no-install', `${h.top} has no install: abe install starts one`)
        : { ok: true, data: { repo: h.top, stopped, removed, aside: aside.record } };
    },
    'install check': async (args, ctx) => {
      const s = await started(ctx, args.repo, true);

      if (!s.ok) return s;
      const { h } = s.data;
      const part = INSTALL_PARTS.find((p) => p === args.part);

      if (args.all === (part !== undefined))
        return refused('usage', `give a part (${INSTALL_PARTS.join(', ')}) or --all`, 2);
      const parts = part === undefined ? [...INSTALL_PARTS] : [part];
      const now = at(ctx);
      const steps: PartStep[] = [];
      let i = s.data.i;

      // each part read on the record as the ones before it left it, then all recorded at once on
      // the record as kept then: a change saved meanwhile stays
      for (const p of parts) {
        const step = await PART_CHECKS[p](ctx, h, i, p, now);

        steps.push(step);
        i = step(i);
      }
      const files = await installFiles(h);
      const saved = await commit(
        ctx,
        h,
        (on) => ok({ ...steps.reduce((x, step) => step(x), on), files }),
        { join: s.data.join },
      );

      return saved.ok ? { ok: true, data: { ...saved.data, checked: parts } } : saved;
    },
    'install logins': async (args, ctx) => {
      const s = await started(ctx, args.repo, true);

      if (!s.ok) return s;
      const l = await loginsMove(ctx, s.data.h, s.data.i);

      return l.ok ? move(ctx, s.data.h, l.data, s.data.join) : l;
    },
    'install sources': async (args, ctx) => {
      const h = await sourcesHere(ctx, args.repo);

      return h.ok ? { ok: true, data: await sourceListOf(ctx, h.data) } : h;
    },
    'install source': async (args, ctx) => {
      const h = await sourcesHere(ctx, args.repo);

      if (!h.ok) return h;
      const i = await load(h.data);

      // the team's file: by you, or the install's session (ADR 0031), never another session
      if (ctx.session !== undefined && i?.session !== ctx.session)
        return refused(
          'only-you',
          "adding or skipping a source is the person's or the install's session's: abe install source <name> in Terminal, never another session",
        );
      if (args.skip) {
        if (args.url !== undefined || args.command !== undefined)
          return refused('usage', 'give --url <its server> to add it, or --skip, not both', 2);
        if (i === undefined)
          return refused('no-install', `${h.data.top} has no install: abe install starts one`);
        const skipped = await move(ctx, h.data, { kind: 'source-skip', id: args.name.trim() });

        return skipped.ok ? { ok: true, data: await sourceListOf(ctx, h.data) } : skipped;
      }
      if (ctx.settings === undefined)
        return refused('no-settings', 'this abe serve reads no settings');
      const sources = teamSources(ctx, h.data);
      const found = await h.data.repo.mcpFound(h.data.top);
      const name = args.name.trim();
      // a source Read found, named alone: on the server known for it, or the one its repo config names
      const read = i?.read?.sources.find((f) => f.id === name);
      const offer =
        args.url === undefined &&
        args.command === undefined &&
        read !== undefined &&
        !sources.some((e) => sourceName(e) === name) &&
        !found.some((f) => f.name === name)
          ? sourceOffer(read)
          : null;
      const next = withSource({
        asked: {
          name,
          url: args.url ?? offer?.url,
          transport: args.transport ?? offer?.transport,
          command: args.command,
          args: args.arg,
          env: args.env,
          headers: args.header,
        },
        sources,
        found,
      });

      if (!next.ok) return next;
      if (JSON.stringify(next.data) !== JSON.stringify(sources)) {
        const wrote = setRepoAt(
          { ...ctx, settings: ctx.settings },
          h.data.top,
          'sources',
          next.data,
        );

        if (!wrote.ok) return wrote;
      }

      return { ok: true, data: await sourceListOf(ctx, h.data) };
    },
    'install checks-env': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;

      return move(ctx, s.data.h, {
        kind: 'checks-env',
        env: args.env.trim(),
        ...(args.why === undefined ? {} : { why: args.why }),
        by: byOf(ctx),
      });
    },
    'install env-profile': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      const profile = args.profile.trim() === 'none' ? null : args.profile.trim();
      const mine = profile === null ? [] : await s.data.h.repo.awsProfiles();

      if (profile !== null && !mine.includes(profile))
        return refused(
          'no-profile',
          `${profile} is none of this machine's aws profiles (${mine.join(', ') || 'none'}): abe login aws --profile ${profile} makes it`,
        );

      return move(ctx, s.data.h, {
        kind: 'env-profile',
        env: args.env,
        profile,
        by: byOf(ctx),
      });
    },
    'install env-map': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;

      return move(ctx, s.data.h, {
        kind: 'env-map',
        files: args.file,
        ciKeys: args.ciKey,
        ...(args.ci === undefined ? {} : { ciEvidence: args.ci }),
        by: byOf(ctx),
      });
    },
    'install kind': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      const kind = RepoKind.safeParse(args.kind.trim().toLowerCase());

      if (!kind.success)
        return refused('usage', `${args.kind} is none of: ${REPO_KINDS.join(', ')}`, 2);
      const part = args.part?.trim().replace(/^\.\//, '').replace(/\/+$/, '');

      if (
        part !== undefined &&
        (part === '' || part.startsWith('/') || part.split('/').includes('..'))
      )
        return refused('usage', `--part ${args.part ?? ''}: a part's folder from the top`, 2);
      // one part's kind joins what is said of the others; the whole repo's replaces it
      const was = kindSaidAt(ctx, s.data.h.top, s.data.i);
      const said: RepoKindSaid =
        part === undefined
          ? kind.data
          : { ...(typeof was === 'object' && was !== null ? was : {}), [part]: kind.data };

      return move(ctx, s.data.h, {
        kind: 'repo-kind',
        said,
        findings: await readWith(ctx, s.data.h, said),
        by: byOf(ctx),
      });
    },
    'source status': async (args, ctx) => {
      const h = await sourcesHere(ctx, args.repo);

      return h.ok ? { ok: true, data: await sourcesOf(ctx, h.data) } : h;
    },
    'source sign-in': async (args, ctx) => {
      const h = await sourcesHere(ctx, args.repo);

      if (!h.ok) return h;
      const i = await load(h.data);
      const by: InstallBy =
        ctx.session === undefined || ctx.session === i?.session ? 'person' : 'session';
      // while it installs, an added source's sign-in is the install's: on its record, resumed on
      const added = installing(i) ? addedSources(i).find((x) => x.id === args.source) : undefined;

      if (i !== undefined && added !== undefined) {
        const signing = await move(ctx, h.data, { kind: 'sign-in', id: args.source, by });

        if (!signing.ok) return signing;
        // the session goes on meanwhile: told when the person started it
        if (ctx.hub === undefined) await tell(ctx, i, installSignInPrompt(added.name));
      } else {
        // after the install (or a source it did not add): Settings', no session to resume
        if (by === 'session')
          return refused('only-you', signInRefusalWords(args.source, 'settings'));
        const source = checkoutSources(ctx, h.data, i).find((x) => x.id === args.source);

        if (source === undefined)
          return refused(
            'not-a-source',
            `${args.source} is none of this checkout's sources: ${
              checkoutSources(ctx, h.data, i)
                .map((x) => x.id)
                .join(', ') || 'none'
            }`,
          );
        settingsSignIn(ctx, h.data, source);
      }
      const data = await sourcesOf(ctx, h.data);

      ctx.serve.emit('sources.changed', data);

      return { ok: true, data };
    },
    'install gate': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      if (
        [args.url !== undefined, args.cannotRun !== undefined, args.beforeRun].filter(Boolean)
          .length !== 1
      )
        return refused(
          'usage',
          "give --url <what the start script printed>, --before-run before abe run start, or --cannot-run <why> once the person chose the app can't run here",
          2,
        );
      if (args.cannotRun !== undefined) {
        const moved = await move(ctx, s.data.h, {
          kind: 'cannot-run',
          why: args.cannotRun,
        });

        return moved.ok ? { ok: true, data: { ...moved.data, gate: null } } : moved;
      }
      const notUsed: NotUsed[] = [];

      for (const said of args.notUsed) {
        const at = said.indexOf(':');
        const key = at === -1 ? '' : said.slice(0, at).trim();
        const why = at === -1 ? '' : said.slice(at + 1).trim();

        if (key === '' || why === '')
          return refused(
            'usage',
            `--not-used "<key or env file>: <how you know the app never reads it>", not ${said}`,
            2,
          );
        notUsed.push({ key, why });
      }

      const { h } = s.data;
      // the person's answers are the team's: every run of the repo reads them (ADR 0040)
      const hosts = (key: 'gate.testHosts' | 'gate.readOnlyHosts', given: readonly string[]) => {
        const was = teamValue(ctx, h.top, key) ?? [];
        const more = given
          .map((g) => g.trim().toLowerCase())
          .filter((g) => g !== '' && !was.includes(g));

        return more.length === 0 ? ok(null) : writeTeam(ctx, h.top, key, [...was, ...more]);
      };
      const wrote = [
        hosts('gate.testHosts', args.testHost),
        hosts('gate.readOnlyHosts', args.readOnlyHost),
        notUsed.length === 0
          ? ok(null)
          : writeTeam(
              ctx,
              h.top,
              'env.notUsed',
              notUsedWith(teamValue(ctx, h.top, 'env.notUsed'), notUsed),
            ),
      ].find((w) => !w.ok);

      if (wrote !== undefined) return wrote;
      const read = await gateRead(
        ctx,
        h,
        s.data.i,
        args.url,
        args.testHost,
        notUsed,
        h.hooks.start,
        args.readOnlyHost,
      );

      const moved = await move(ctx, h, {
        kind: args.beforeRun ? 'before-run' : 'gate',
        result: read.result,
      });

      // its own result first: the status's parts may still say the last check's
      return moved.ok ? { ok: true, data: { ...moved.data, gate: read.result } } : moved;
    },
    // serve runs a check: in the main checkout, with what abe run gets
    'install try': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      const { h, i } = s.data;

      if (
        [args.name !== undefined, args.all, args.command !== undefined].filter(Boolean).length !== 1
      )
        return refused('usage', 'give a check by its name, --all, or --command "<command>"', 2);
      const listed = writtenChecks(ctx, h.top).filter((c) => c.name !== 'setup');
      const lists = listed.map((c) => c.name).join(', ') || 'none';
      const named = args.all ? listed : listed.filter((c) => c.name === args.name).slice(0, 1);
      const picked: { name: string | null; run: string }[] =
        args.command === undefined ? named : [{ name: null, run: args.command }];

      if (picked.length === 0)
        return refused(
          'no-check',
          args.all
            ? `${REPO_PATH} lists no checks: try one with --command "<command>"`
            : `${args.name ?? ''} is not in ${REPO_PATH}'s checks: (it lists: ${lists})`,
        );
      for (const c of picked) {
        const why = checkCommandWhyNot(c.run, i.read);

        if (why !== null)
          return refused(
            'not-a-check',
            `serve does not run ${c.run}: ${why}. abe install try runs checks only; to start the app for the gate, run abe run start (the start hook: abe run start), then abe install gate --url <what it printed>`,
          );
      }
      const env = await checkEnv(ctx, h, i);

      if (!env.ok) return env;
      const db = await checkDatabase(ctx, h, i);
      const own = db.url === undefined ? {} : { [WORKSPACE_DATABASE]: db.url };
      const runs = await runChecksHere(ctx, h, picked, {
        env: { ...env.data.env, ...own },
        secrets: [...env.data.secrets, ...injectedSecrets(own)],
      });
      const ran = await move(ctx, h, { kind: 'check-ran', runs });

      return ran.ok
        ? {
            ok: true,
            data: { repo: h.top, runs, ...(db.said === undefined ? {} : { noDatabase: db.said }) },
          }
        : ran;
    },
    'install connection': async (args, ctx) => {
      const s = await started(ctx, args.repo);

      if (!s.ok) return s;
      return move(ctx, s.data.h, await connectionMove(ctx, s.data.h, s.data.i));
    },
  }) satisfies Partial<Handlers<Ctx>>;
