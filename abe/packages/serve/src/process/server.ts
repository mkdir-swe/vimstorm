/** The long-running `abe serve`: one socket, every command answered by `core`'s table. */
import { chmod, chown, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type Aws,
  repoHooksIn,
  type Board,
  Install,
  installAwsOff,
  checksEnvOf,
  localModeGuards,
  type CardCheckout,
  type LocalMerge,
  boardOf,
  SUMMARY_SYSTEM,
  isWorkspaceSessionSocket,
  type ByCard,
  cardOfSession,
  LEGACY_NAMES,
  workspaceNames,
  type Run,
  sessionDirAccess,
  type BoxHost,
  type BoxLink,
  type BoxSyncPort,
  coreDefaults,
  LOCAL_TARGET,
  idleKeepsOf,
  waitingSinceOf,
  BROWSER,
  type Boxes,
  type Logins,
  type Clock,
  commandRan,
  dispatch,
  EXIT,
  type Git,
  type CONTRACT_COMMANDS,
  type Handlers,
  type HandlersFor,
  help,
  isCloudTarget,
  type LayerPulls,
  type MacDatabase,
  LOG_SHIP_EVERY_MS,
  type LogStore,
  type RetroPulls,
  journal,
  parse,
  PR_POLL_MS,
  printFailure,
  readRequest,
  splitOn,
  type ReachTarget,
  refused,
  cardInstallRefusal,
  checkedSourceServers,
  ciNodeOptions,
  type Mover,
  type OneShot,
  type RunTree,
  type Secrets,
  type SessionApps,
  type Compose,
  subagentRunning,
  tidyAgents,
  type SessionRunner,
  waitsOnPr,
  toReply,
  type ToolProbe,
  type DemoShop,
  type Pipelines,
  type Tracking,
  type ReviewPort,
  type Chrome,
  type ProfileStore,
  type BoxAws,
  type GhAccounts,
  commandIds,
  COMMANDS,
  ABE_ENVS,
  offRepoEnvFiles,
  envPlacement,
  takesOwnDatabase,
  type AbeEnv,
} from '@abe/core';
import {
  type Env,
  type GhToken,
  type GithubAs,
  boxesByProfile,
  type ProfileBoxes,
  listen,
  type Held,
  SocketInUse,
  takeLock,
  mainCheckout,
  ciFiles,
  type PipelinesWho,
  nextLocalMidnight,
  originRepo,
  type SettingsPlaces,
  shellMover,
} from '@abe/ports';
import {
  askOneShot,
  checkoutOf,
  type CredsCache,
  LAYER_HANDLERS,
  type OverrideCtx,
  type ReachCtx,
  serveTargetIn,
  type SettingsCtx,
  startSettings,
  yourHandedLayer,
} from '../layer';
import {
  BOARD_HANDLERS,
  type BoardCtx,
  type CheckoutCtx,
  freshAnswer,
  type FreshCtx,
  type LinkedCtx,
  type PipelinesCtx,
  sourceAt,
  sourceText,
  startFresh,
  type TrackingCtx,
} from '../board';
import {
  IMPROVE_HANDLERS,
  type ImproveCtx,
  type LogsCtx,
  type LogShipper,
  recentCommandsOf,
  type RetroCtx,
  startLogShipper,
} from '../improve';
import {
  LOGIN_HANDLERS,
  startStoredLogins,
  type StoredLogins,
  type StoredLoginsCtx,
  type StoredLoginsOptions,
} from '../logins';
import {
  BROWSER_HANDLERS,
  type BrowserCtx,
  type BrowserService,
  type BrowserStoreCtx,
  PROFILE_WATCH_MS,
  startBrowserService,
  startProfileWatch,
} from '../browser';
import {
  type Checks,
  type Factory,
  FACTORY_HANDLERS,
  type PrCtx,
  type PrStage,
  recordParts,
  type RecordParts,
  repoChecks,
  runReportText,
  startFactory,
  startPrStage,
  stepSummarizer,
} from '../factory';
import { WORKFLOW_HANDLERS, type WorkflowCtx, type WorkflowEditCtx } from '../skills';
import {
  INSTALL_HANDLERS,
  type InstallCtx,
  type InstallPorts,
  installRecords,
  repoMoves,
  installSessionAsked,
  runWarning,
  worktreeCopies,
  type ToolsCtx,
  credentialsInjection,
  abeEnvRedacted,
  abeEnvValues,
  hasAbeEnvFiles,
} from '../install';
import {
  type AskCtx,
  launchSettings,
  type MoveCtx,
  type SkillsCtx,
  moveLocks,
  SESSION_HANDLERS,
  type Sessions,
  startHolds,
  startSessions,
  startTranscripts,
  type Transcripts,
} from '../session';
import {
  LOCAL_MODE_HANDLERS,
  localApps,
  type LocalApps,
  type LocalBrowserOptions,
  type LocalBrowsers,
  type LocalCtx,
  type LocalMode,
  openDatabases,
  openLocalMode,
  openPortBases,
  type RepoPortsCtx,
  startLocalBrowsers,
} from '../local-mode';
import { type AwsAs, openRouting, type PortsAt } from '../routing';
import {
  type Box,
  BOX_HANDLERS,
  type BoxesCtx,
  type BoxFront,
  type BoxOptions,
  type CloudSessions,
  type IdleHeld,
  type IdleStop,
  onBoxAnswer,
  openBox,
  type PortsCtx,
  requestCard,
  startBoxFront,
  startCloud,
  boxSyncer,
  startIdleStop,
  startPortForwards,
  startWorkspacePorts,
  versionedLink,
  withRoom,
  type WorkspaceCtx,
  workspaceDirectory,
  type WorkspacePortsCtx,
  type WorkspacePortsService,
  clientOnly,
} from '../box';
import { realPathAt } from '../contract';
import { startThemeWatch, THEME_HANDLERS } from '../theme';
import { DEMO_HANDLERS, type DemoCtx } from '../demo';
import { openSheets, SHEET_HANDLERS, type SheetsCtx, type SheetsOptions } from '../sheets';
import {
  openPrototypes,
  PROTOTYPE_HANDLERS,
  type Prototypes,
  type PrototypesCtx,
  type PrototypesOptions,
} from '../prototype';
import { REVIEW_HANDLERS, type ReviewCtx } from '../review';
import { TRIAGE_HANDLERS, type TriageCtx } from '../triage';
import { watchAnswer } from './watch';
import { withProgress } from './progress';
import { installedAbe, VERSION } from './version';

export { VERSION };

export type ServeOptions = {
  socket: string;
  clock: Clock;
  pid: number;
  version?: string;
  /** The abe installed on this Mac now, its version (default `installedAbe`); none: not known. */
  installed?: () => string | undefined;
  /** GitHub, as the person: `gh` on its own login. */
  tracking: Tracking;
  /**
   * On a box: GitHub through each card's own workspace's `gh` (ADR 0022), for what a card's
   * session or run reads and merges (no other card's container answers for it); `tracking`
   * serves the rest.
   */
  trackingOf?: ByCard<Tracking>;
  /**
   * The Mac's GitHub as one of your gh logins (`logins.gh` in force at a checkout, ADR
   * 0025): each call on that login's token, gh's active login never switched. None: gh's own.
   */
  githubAs?: (account: string) => GithubAs;
  /** A gh login's token for a session's gh as it (never printed or logged); none: not handed. */
  githubToken?: (account: string) => GhToken;
  /** The logins gh has, for the Connection check's fix; none: not asked. */
  githubAccounts?: () => Promise<GhAccounts>;
  /**
   * The Pipelines as your gh login and in your az folder in force at a checkout (ADR 0025); none:
   * `pipelines` everywhere.
   */
  pipelinesAs?: (who: PipelinesWho) => Pipelines;
  /**
   * VimStorm's PR review and Create Draft PR (the Mac's serve): git in the PR's checkout, GitHub
   * through `gh`; without it `abe review` is refused.
   */
  review?: ReviewPort;
  /** AWS on serve's own credentials: Reach's AssumeRoles. */
  aws: Aws;
  /** Where the secrets behind database names are read. */
  secrets: Secrets;
  /** `cloud` for the `serve` on a box (write names are given only there); default `local`. */
  reachTarget?: ReachTarget;
  /**
   * The Mac's AWS profile and region boxes are reached on: Settings' Problems says when
   * `serve.target: cloud` has neither; without it not checked.
   */
  awsReach?: () => BoxAws;
  /**
   * Your AWS on another profile (`box.profile` in force at a checkout, ADR 0025): Reach's AWS and
   * secrets, the profile and region boxes are reached on, your boxes there. None: serve's own
   * everywhere.
   */
  awsAs?: (profile: string) => AwsAs;
  /**
   * The box profile serve started on (`null`: aws's own) and whether its environment pinned it
   * (`$ABE_BOX_PROFILE`, which overrides the Layers); none: never another.
   */
  boxProfile?: { own: string | null; pinned: boolean };
  /** Azure DevOps Boards, as the person: `az`'s login. */
  board: Board;
  /**
   * Local mode's pull requests: their heads and squash merges on this Mac; none: merges refused.
   */
  localMerge?: LocalMerge;
  /** `card checkout`: a card's branch from origin as a worktree on this Mac; none on a box. */
  checkout?: CardCheckout;
  /** The Pipelines tab's runs (GitHub Actions, Azure Pipelines), as the person; none: refused. */
  pipelines?: Pipelines;
  /** How many recent events `abe watch --since` can replay (default `RING`). */
  ring?: number;
  /** Where the Layers' files are; without them `abe settings` is refused and nothing is watched. */
  settings?: SettingsPlaces;
  /** How often the Layers' files are read for `settings.changed` (default 500 ms). */
  settingsPollMs?: number;
  /**
   * The environment serve was started with, before the Layers filled your environment in:
   * what `settings explain` names as overriding a personal key.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /** On a box: its one workspace (the Docker and Mirrors ports). */
  box?: BoxOptions;
  /** Your Sheets: kept in its folder, served by its host, attached into its org store. Without it `abe sheet` is refused. */
  sheets?: SheetsOptions;
  /**
   * Where sessions run and where they are kept (`<stateDir>/sessions`); without it `abe session`
   * is refused. `env` is serve's own: a session's `HOME`, `USER`, `PATH` and locale. `git`: the
   * sessions' worktrees, pushed in the pr stage and removed when a Done card clears. `tree`: where
   * a session's worktree and home are read (a Factory run's checks and reports, its logs): this
   * machine's disk, or on a box the workspace container (`containerRunTree`). `byCard`: on a box
   * with a workspace per card (ADR 0022), each card's own in place of `git` and `tree`.
   */
  sessions?: {
    stateDir: string;
    /** The default state folders besides `stateDir`: hidden from sessions too. */
    defaultStates?: readonly string[];
    /** Your own Layer's folder: never written by a session. */
    configDir?: string;
    runner: SessionRunner;
    env: Env;
    git: Git;
    tree: RunTree;
    byCard?: { git: ByCard<Git>; tree: ByCard<RunTree> };
  };
  /**
   * The Mac's serve: what its local sessions run outside their sandbox (`abe run`,
   * the repo pack's database hook), stopped when each session ends. None on a box.
   */
  local?: {
    apps: SessionApps;
    browser?: LocalBrowserOptions;
    /** Docker compose on the local machine for its scripts; none: no compose project, none taken down. */
    compose?: Compose;
  };
  /** Abe's Mac database: a database per local session and prototype; none on a box. */
  mac?: MacDatabase;
  /** How often a Factory run's open pull request and its deploy are read (default a minute). */
  factoryPollMs?: number;
  /**
   * Whether a card starts (a Factory run, a card's session) only in a checkout whose install is
   * done: the Mac's serve. Default off.
   */
  cardsNeedInstall?: boolean;
  /** How often a checkout `abe fresh --follow` holds is looked at (default 2 min). */
  freshMs?: number;
  /** When a run done at `ms` clears from status (default: the next local midnight). */
  midnightAfter?: (ms: number) => number;
  /** A Factory run's checks, run on entering `checks`; default: the repo's (`repoChecks`). */
  checks?: Checks;
  /**
   * Where session logs are shipped, redacted (`$ABE_LOG_STORE`); without it `abe log` is refused
   * and nothing is shipped. `every`: how often running sessions are (default five minutes).
   */
  logs?: { store: LogStore; every?: number };
  /** Prototypes: where their apps run, the proxy, their folder. Without it `abe prototype` is refused. */
  prototypes?: PrototypesOptions;
  /**
   * One-shots (`claude -p`), run in a session's clean environment (from `sessions`: its `env` and
   * its runner's `bin`); without it, or without `sessions`, `abe triage` is refused.
   */
  oneShot?: OneShot;
  /** Download locally and Move to cloud's copy; default the shell's, over `sessions.env`. */
  mover?: Mover;
  /**
   * Your environment (the Mac's serve): your boxes on EC2 and the link to their `serve`s. With
   * `serve.target: cloud`, `abe session launch` goes there. Timings default to real ones.
   */
  cloud?: {
    boxes: Boxes;
    /** Your boxes as `session list` and `watch` read them: on a short timeout (default `boxes.list`). */
    scanList?: Boxes['list'];
    link: BoxLink;
    /** How this `abe` is run (`selfArgv([])`): a cloud session's attach is its `box attach`. */
    self: readonly string[];
    /** `abe box attach` (ADR 0021); default `<self> box attach` (`$ABE_BOX_ATTACH`: a fake's). */
    boxAttach?: readonly string[];
    /** The boxes' AWS region, said in the status bar's hover (null: aws's own). */
    region?: string | null;
    /**
     * A box profile is named, by a Layer's `box.profile` or the environment: your boxes
     * are read even with `serve.target: local`; without one they are off there.
     */
    profileNamed?: boolean;
    sleep: (ms: number) => Promise<void>;
    pollMs?: number;
    bootMs?: number;
    queuePollMs?: number;
    followRetryMs?: number;
    /**
     * Box parity (3.2.1): Claude Code's store read and a sync sent into a workspace. Without it,
     * or without settings and the install's ports, a box gets nothing of this Mac's but its Layer.
     */
    boxSync?: BoxSyncPort;
  };
  /** On a box: where its owner's logins are read for a session. */
  logins?: Logins;
  /**
   * On a box: it shuts itself down after `box.idleMinutes` (read in `cwd`, the box's home)
   * with no hook and nothing keeping it up; `name` is the box's own (`ABE_BOX_NAME`).
   */
  idle?: { name: string; host: BoxHost; cwd: string; everyMs?: number };
  /**
   * A Layer's repo on GitHub (`gh`), where `abe improve retro make`
   * open their pull requests; without it those are refused.
   */
  layerPulls?: LayerPulls;
  /** Improve retro's GitHub reads (`gh`): pull request comments, earlier fixes. */
  retroPulls?: RetroPulls;
  /**
   * The person's logins: their secret, the tools, where the tools keep them. With a secret
   * named they are restored on start and refreshed ones written back; without it `abe login`
   * is refused.
   */
  storedLogins?: StoredLoginsOptions;
  /** How `abe tools check` and Settings' Problems run a tool's check; without it refused. */
  toolProbe?: ToolProbe;
  /** `abe demo new`: the bundled demo, git and GitHub as the person (the Mac's serve); none: refused. */
  demo?: DemoShop;
  /** Factory install: the checkout's local reads and where records are kept; none: refused. */
  install?: InstallPorts;
  /**
   * Browser profiles' sign-ins: where they are stored (your secrets beside the logins;
   * a box reads them at a start) and, on the Mac, Chrome on a profile's folder.
   */
  browserProfiles?: {
    store?: ProfileStore;
    chrome?: Chrome;
    /** How often an open profile's Chrome is read (`PROFILE_WATCH_MS`). */
    watchMs?: number;
  };
  /** What serve says of a failure nobody waits on (a detached serve's `serve.log`); default stderr. */
  log?: (message: string) => void;
  /** How often its socket file is checked to be its own (default 5 s). */
  socketCheckMs?: number;
};

export type Serve = {
  socket: string;
  /** Stops listening and removes the socket; resolves once it has. */
  stop: () => Promise<void>;
  /** Resolves when the `serve` stopped, by `stop()` or by `abe serve stop`. */
  stopped: Promise<void>;
  /**
   * Reads the settings files now, as the poll does: a test harness's, so an edit it made by hand
   * is in force for the request it sends next.
   */
  pollSettings: () => void;
};

/**
 * A request's context: its facts (where it was typed, its checkout's settings, its session and
 * socket), its ports as routed at its checkout (`ports`) and serve's own modules (`serve`).
 */
type Ctx = TrackingCtx & {
  serve: {
    logins: Logins | undefined;
  };
} & ReviewCtx &
  RepoPortsCtx &
  SettingsCtx &
  ReachCtx &
  BoardCtx &
  BrowserCtx &
  BrowserStoreCtx &
  SheetsCtx &
  PrCtx &
  LogsCtx &
  PrototypesCtx &
  TriageCtx &
  ImproveCtx &
  RetroCtx &
  StoredLoginsCtx &
  ToolsCtx &
  DemoCtx &
  BoxesCtx &
  MoveCtx &
  SkillsCtx &
  CheckoutCtx &
  AskCtx &
  OverrideCtx &
  FreshCtx &
  PipelinesCtx &
  WorkspaceCtx &
  WorkspacePortsCtx &
  LinkedCtx &
  WorkflowCtx &
  WorkflowEditCtx &
  InstallCtx &
  PortsCtx &
  LocalCtx & {
    socket: string;
    /** Stop once this request's answer is written. */
    stopAfterReply: () => void;
    /** Tracking, Board, Git, Pipelines, Review and AWS as routed at the request's checkout. */
    ports: PortsAt;
    serve: {
      pid: number;
      startedAt: string;
      /** The Run record's outside parts held between reads (`factory record`). */
      recordParts: RecordParts;
      /** On a box: its idle stop. */
      idle: IdleStop | undefined;
      /** The Mac database's facts for Problems; none on a box. */
      macDatabase:
        | {
            needs: (dir: string) => boolean;
            docker: () => Promise<'up' | 'down' | 'missing'>;
            served: boolean;
          }
        | undefined;
    };
  };

/**
 * What this `serve` holds: its open sessions and, on a box, its workspaces (ADR 0022: one per
 * card), the first also as `workspace` for a Mac from before.
 */
const holds = async (ctx: Ctx) => {
  const sessions = ctx.serve.sessions?.open() ?? 0;
  // Docker not answering is no reason for status to fail: it then names no workspace.
  const listed = (await ctx.serve.box?.list().catch(() => [])) ?? [];
  // Asked from inside a workspace: its own only, never another card's names.
  const mine = ctx.inside ? requestCard(ctx) : undefined;
  const all = ctx.inside ? listed.filter((w) => w.card === mine) : listed;
  const first = all[0];
  const load = await ctx.serve.box?.load().catch(() => undefined);

  return {
    sessions,
    workspaces: all.length,
    ...(first === undefined ? {} : { workspace: first, boxWorkspaces: all }),
    ...(load === undefined || ctx.inside ? {} : { load }),
  };
};

/** Abe's own rows: help, serve, status, watch and ui. */
const contractHandlers: HandlersFor<typeof CONTRACT_COMMANDS, Ctx> = {
  help: (args) => Promise.resolve(help(args.command)),
  serve: (_, ctx) =>
    Promise.resolve(
      refused(
        'serve-running',
        `abe serve is already running (pid ${ctx.serve.pid}) on ${ctx.socket}`,
      ),
    ),
  'serve stop': (_, ctx) => {
    ctx.stopAfterReply();

    return Promise.resolve({ ok: true, data: { stopped: true, pid: ctx.serve.pid } });
  },
  status: async (_, ctx) => ({
    ok: true,
    data: {
      version: ctx.serve.version,
      ...(ctx.serve.installed() === undefined ? {} : { installed: ctx.serve.installed() }),
      pid: ctx.serve.pid,
      startedAt: ctx.serve.startedAt,
      socket: ctx.socket,
      ...(await holds(ctx)),
      ...(ctx.serve.idle === undefined ? {} : { idle: ctx.serve.idle.look() }),
      ...(ctx.ports.awsReach === undefined ? {} : { boxAws: ctx.ports.awsReach() }),
    },
  }),
  // `startServe` streams `abe watch` before dispatch; a reply cannot carry a stream
  watch: () =>
    Promise.resolve(refused('watch-streams', 'abe watch is answered as a stream, not a reply')),
  // a client of serve like any other tool: the `abe` client runs both (`bridge.ts` here)
  'ui render': () => clientOnly('ui render'),
  'ui bridge': () => clientOnly('ui bridge'),
};

const handlers: Handlers<Ctx> = {
  ...contractHandlers,
  ...BOARD_HANDLERS,
  ...BOX_HANDLERS,
  ...BROWSER_HANDLERS,
  ...FACTORY_HANDLERS,
  ...IMPROVE_HANDLERS,
  ...INSTALL_HANDLERS,
  ...DEMO_HANDLERS,
  ...LAYER_HANDLERS,
  ...LOCAL_MODE_HANDLERS,
  ...LOGIN_HANDLERS,
  ...PROTOTYPE_HANDLERS,
  ...REVIEW_HANDLERS,
  ...SESSION_HANDLERS,
  ...SHEET_HANDLERS,
  ...WORKFLOW_HANDLERS,
  ...THEME_HANDLERS,
  ...TRIAGE_HANDLERS,
  // a local session's app starts once what it loads is judged: the gate's words its warning
  run: async (args, ctx) => {
    const warned = await runWarning(ctx, args.script);

    if (!warned.ok) return warned;
    const ran = await BOX_HANDLERS.run(args, ctx);

    // the gate's words first, then what the run itself warns of (fixed compose host ports)
    const warning = [warned.data, ran.ok ? ran.data.warning : undefined].filter(
      (w) => w !== undefined,
    );

    return ran.ok && warning.length > 0
      ? { ok: true, data: { ...ran.data, warning: warning.join('\n') } }
      : ran;
  },
};

/** The rows a box's workspace answers on its own socket, with no session behind it or for one. */
/**
 * Whether a local session is the Abe chat, which runs as the person (every abe command theirs,
 * `settings set` and prod-on too); every other session is a session.
 */
export const isHub = (sessions: Pick<Sessions, 'metaOf'> | undefined, id: string): boolean =>
  sessions?.metaOf(id)?.kind === 'abe';

const inWorkspace = (session: boolean) =>
  new Set(
    commandIds().filter((id) => {
      const where = COMMANDS[id].inWorkspace;

      return where === 'socket' || (session && where === 'session');
    }),
  );

const INSIDE: ReadonlySet<string> = inWorkspace(false);

/**
 * What a session in the workspace may run on its own socket: its hooks, itself, the credentials
 * behind its AWS profiles (`credential_process`), its Reach, its Sheets, its own card and its
 * spec's issues (a body file read in the container), its Factory run's own commands (the run lives
 * in this box's serve; its worktree is reached in the workspace container, never on the box's
 * disk) and the Verification pack's scripts, which serve runs in the container as its script user.
 */
const INSIDE_SESSION: ReadonlySet<string> = inWorkspace(true);

const insideRefusal = (argv: readonly string[], session: boolean) => {
  const parsed = parse(argv);

  if (!parsed.ok || (session ? INSIDE_SESSION : INSIDE).has(parsed.id)) return undefined;

  return printFailure(
    {
      code: 'not-in-session',
      message: `abe ${parsed.id} cannot be run from inside a workspace`,
    },
    EXIT.failed,
    parsed.global.json,
  );
};

/**
 * What keeps a box up now: a terminal on the box or a tmux client in its workspace, a
 * session starting or working, a Factory run waiting on its pull request (the box reads it on).
 */
const idleKeeps = async (o: {
  host: BoxHost;
  runner: SessionRunner | undefined;
  sessions: Sessions | undefined;
  factory: Factory | undefined;
}): Promise<IdleHeld> => {
  const [onBox, inWorkspace, listed] = await Promise.all([
    o.host.attached(),
    o.runner?.attached?.() ?? false,
    o.sessions?.list(),
  ]);

  // Not known is no reason to stop: this look is skipped.
  if (listed?.ok === false) throw new Error(`session list: ${listed.error.message}`);
  const held = listed?.data ?? [];

  return {
    keptBy: idleKeepsOf({
      attached: onBox || inWorkspace,
      sessions: held.map((x) => x.state),
      carried: o.factory?.all().some((r) => waitsOnPr(r) && r.cleared === null) ?? false,
    }),
    waitingSince: waitingSinceOf(held),
  };
};

/** The checkout a command names with `--path <dir>` (the PR review's), resolved where it was typed. */
const pathFlag = (argv: readonly string[], cwd: string): string | undefined => {
  const at = argv.indexOf('--path');
  const path = at === -1 ? undefined : argv[at + 1];

  return path === undefined ? undefined : realPathAt(cwd, path);
};

export { type AwsAs };

/** How often serve checks its socket file is still its own (bound again when not). */
const SOCKET_CHECK_MS = 5_000;

/**
 * Listens on `socket` (a stale one is replaced; a live one throws `SocketInUse`). Its lock is
 * taken first (`serve.lock`): a second serve on the same state stops before it touches anything.
 */
export const startServe = async (o: ServeOptions): Promise<Serve> => {
  const locked = await takeLock(o.socket);

  if (!locked.ok) {
    const pid = locked.holder === undefined ? '' : ` (pid ${locked.holder})`;

    throw new SocketInUse(`abe serve is already running${pid} on ${o.socket}`);
  }
  try {
    return await startLocked(o, locked.held);
  } catch (err) {
    locked.held.release();
    throw err;
  }
};

const startLocked = async (o: ServeOptions, lock: Held): Promise<Serve> => {
  const startedAt = new Date(o.clock.now()).toISOString();
  // the abe installed now, as against this serve's build: install.sh may replace it while it runs
  const installed = o.installed ?? installedAbe();
  const { promise: stopped, resolve: signal } = Promise.withResolvers<undefined>();
  let closing: Promise<void> | undefined;
  const events = journal(o.clock, o.ring);
  // the Run record's outside parts, held between reads; a card's events let its parts go
  const records = recordParts(o.clock);

  events.watch(undefined, records.hear);
  // each checkout's install record, one owner per checkout for as long as this serve runs
  const installs = o.install === undefined ? undefined : installRecords(o.install);
  // a repo moved on this Mac followed as a request first comes from it (never on a box)
  const repoMoved =
    installs === undefined || o.sessions === undefined || o.box !== undefined
      ? undefined
      : repoMoves({
          stateDir: o.sessions.stateDir,
          env: o.sessions.env,
          home: o.sessions.runner.home ?? o.sessions.env.HOME,
          store: installs.store,
          records: installs,
          emit: (m) => {
            // what a checkout reads is its main checkout's files where they are now
            settings?.poll();
            events.emit('repo.moved', m);
          },
        });
  const log = o.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const creds: CredsCache = new Map();
  // Permission prompts held under an Override for their card.
  const holds = startHolds({ clock: o.clock });

  // Before listening, so it is number 1 even when a waiting client's request lands at once.
  events.emit('serve.started', { version: o.version ?? VERSION, pid: o.pid, socket: o.socket });
  // Your boxes on every profile your repos name (ADR 0025, 0030), serve's own first.
  const routed = (() => {
    if (o.cloud === undefined) return undefined;
    const own: ProfileBoxes = {
      boxes: o.cloud.boxes,
      link: o.cloud.link,
      ...(o.cloud.scanList === undefined ? {} : { scanList: o.cloud.scanList }),
    };

    return boxesByProfile({
      own,
      ownProfile: o.boxProfile?.own ?? null,
      // the profiles the repos worked in so far name (box.profile is yours per repo, ADR 0030)
      profiles: () => routing.profiles(),
      as: (profile) => routing.awsOf(profile)?.cloud ?? own,
    });
  })();
  // The boxes' link, a box on another abe said as that.
  const link = routed === undefined ? undefined : versionedLink(routed.link, o.version ?? VERSION);
  /** The cloud queue looks for room when `limits.maxBoxesPerPerson` changed; set below. */
  const queue: { nudge: (() => void) | undefined } = { nudge: undefined };
  const settings =
    o.settings === undefined
      ? undefined
      : startSettings({
          places: o.settings,
          every: o.settingsPollMs ?? 500,
          ...(o.environment === undefined ? {} : { environment: o.environment }),
          emit: (data) => {
            events.emit('settings.changed', data);
            if (data.keys.includes('limits.maxBoxesPerPerson')) queue.nudge?.();
            // what agents reach (ADR 0029), a checkout's block too: each live session on the old
            // ones is told to hand off (each compares its own; none changed, none told)
            void sessions?.envsChanged();
          },
        });
  /** The box's checkout of each repo its sessions name as `owner/name`, made once (ADR 0030). */
  const boxCheckouts = new Map<string, string>();
  const boxCheckoutOf = async (repo: string): Promise<string> => {
    if (o.box === undefined) return repo;
    const kept = boxCheckouts.get(repo);

    if (kept !== undefined) return kept;
    const made = await o.box.mirrors.checkout(repo).catch(() => undefined);

    if (made !== undefined) boxCheckouts.set(repo, made);

    return made ?? repo;
  };
  // A theme file changed: the look the bridge sends is read again.
  const themes =
    settings === undefined
      ? undefined
      : startThemeWatch({
          places: settings.places,
          every: o.settingsPollMs ?? 500,
          emit: (files) => events.emit('settings.changed', { keys: [], repo: null, files }),
        });
  // Local mode: where your Layer lists the checkout, every write is held here; where it
  // lists it read-only (`boardReadOnly`), the board's writes.
  const localMode: LocalMode = openLocalMode({
    stateDir: o.sessions?.stateDir ?? dirname(o.socket),
    clock: o.clock,
    settings,
    merge: o.localMerge,
    emitHeld: (w) => events.emit('local.held', w),
    emitPr: (p) => events.emit('local.pr', p),
    emitDiscarded: (d) => events.emit('local.discarded', d),
  });
  // Fresh data: Azure DevOps', GitHub's and the pipelines' changes looked for while a view
  // holds it.
  const fresh = startFresh({
    board: o.board,
    tracking: o.tracking,
    trackingAt: (checkout) => routing.githubAt(checkout)?.tracking ?? o.tracking,
    boardAt: (checkout) => {
      if (settings === undefined) return undefined;
      const board = boardOf(settings.at(checkout).values.board);

      return board.ok ? board.board : undefined;
    },
    repoAt: originRepo,
    ...(o.pipelines === undefined ? {} : { pipelines: o.pipelines }),
    pipelinesAt: (checkout) => routing.pipelinesFor(checkout),
    sourceAt: async (checkout) => {
      // an origin that cannot be read leaves the board and pull requests looked at
      const at = await sourceAt({ settings }, checkout).catch(() => undefined);

      return at?.ok === true ? { source: at.data, text: sourceText(at.data) } : undefined;
    },
    emit: events.emit,
    clock: o.clock,
    ...(o.freshMs === undefined ? {} : { everyMs: o.freshMs }),
  });
  let box: Box | undefined;
  /** On a box: what listens in its workspaces, and its relays into them. */
  let workspacePorts: WorkspacePortsService | undefined;
  // The repo's hook points, as the main checkout's abe.yaml declares them (ADR 0035)
  const hooksAt = (repo: string) =>
    repoHooksIn(settings?.at(mainCheckout(repo) ?? repo).values ?? {});
  // One database rule and one set of port bases for the Mac's prototypes and sessions.
  const databases = openDatabases({ mac: o.mac, hooks: hooksAt });
  const portBases = openPortBases();
  const mac = o.mac;
  const macFacts =
    mac === undefined
      ? undefined
      : {
          needs: (dir: string) => databases.need(dir).by === 'mac',
          docker: () => mac.docker(),
          served: (o.sessions?.env.DATABASE_URL ?? '') !== '',
        };
  // The environments a checkout's agents reach (ADR 0029): yours, per checkout
  const agentEnvsAt = (repo: string): AbeEnv[] =>
    settings === undefined
      ? ABE_ENVS.filter((e) => e !== 'prod')
      : [...settings.facts(realPathAt('/', repo)).agentEnvs];
  // A checkout's install record, by its path as given, its real one or its main checkout's (a
  // card's worktree: a card launched from another card's workspace); none: no install
  const recordAt = async (repo: string): Promise<Install | undefined> => {
    const main = mainCheckout(repo);

    for (const at of [
      ...new Set([repo, realPathAt('/', repo), ...(main === undefined ? [] : [main])]),
    ]) {
      const record = Install.safeParse(await o.install?.store.read(at)).data;

      if (record !== undefined) return record;
    }

    return undefined;
  };
  // as cards and sessions take it
  const installAt = recordAt;
  // the team's settings of a repo, as its main checkout's abe.yaml has them (ADR 0040: the env
  // map's groups, env.notUsed, checksEnv), never a worktree's copy an agent writes
  const teamAt = (repo: string) => settings?.at(mainCheckout(repo) ?? repo).values;
  // the environment a repo's checks run with: abe.yaml's, else its install's record, else dev
  const checksEnvAt = async (repo: string) =>
    checksEnvOf(await installAt(repo), teamAt(repo)?.checksEnv);
  // What a card's new worktree, and a prototype's app, gets copied in from its checkout (a card's
  // worktree given: its main checkout's)
  const copiesAt = async (repo: string, enabled: readonly AbeEnv[] = agentEnvsAt(repo)) =>
    o.install === undefined
      ? []
      : worktreeCopies(
          o.install.repo,
          mainCheckout(repo) ?? repo,
          await installAt(repo),
          enabled,
          launchSettings({ settings }, repo).worktree,
          hooksAt(repo),
        );
  // A repo's fixed ports: its own (abe.yaml's ports.fixed) and what its install read fixed
  const fixedPortsAt = async (repo: string): Promise<number[]> => [
    ...new Set([
      ...(settings?.at(realPathAt('/', repo)).values['ports.fixed'] ?? []),
      ...((await installAt(repo))?.read?.fixedPorts ?? []),
    ]),
  ];
  // A local session's apps and database: the Mac's serve only.
  const local: LocalApps | undefined =
    o.local === undefined || o.box !== undefined || o.sessions === undefined
      ? undefined
      : localApps({
          apps: o.local.apps,
          ...(o.local.compose === undefined ? {} : { compose: o.local.compose }),
          env: o.sessions.env,
          stateDir: o.sessions.stateDir,
          databases,
          ports: portBases,
          // a Factory install's scripts and database hook: aws off until its Logins checked it
          // (no record: off); a local-mode card session's while its checkout's install never did
          awsOff: async ({ repo, install }) =>
            install
              ? installAwsOff(await recordAt(repo)) !== null
              : localMode.at(repo) !== undefined && localModeGuards(await installAt(repo)).awsOff,
          // the app's credentials (ADR 0028): the checkout's Abe env file for `--env` (dev when
          // none) and its aws profile's keys, values handed to it alone
          injected: async (repo, env) => {
            if (o.install === undefined) return { ok: true, data: {} };
            const r = await credentialsInjection(
              o.install.repo,
              settings,
              realPathAt('/', repo),
              env,
            );

            return r.ok ? { ok: true, data: r.data.env } : r;
          },
          // every Abe env file's value, whichever environment the script ran in
          redacted: (repo) =>
            o.install === undefined
              ? Promise.resolve([])
              : abeEnvRedacted(o.install.repo, realPathAt('/', repo)),
          // abe run --env in an environment off for agents: refused (ADR 0029)
          agentEnvs: agentEnvsAt,
          fixedPorts: fixedPortsAt,
          // the holder of a repo's fixed ports, stopped for a prototype and started again after
          metaOf: (id) => sessions?.metaOf(id),
        });
  // Each local Factory run's own browser: the Mac's serve only.
  const localBrowsers: LocalBrowsers | undefined =
    local === undefined || o.local?.browser === undefined || o.sessions === undefined
      ? undefined
      : startLocalBrowsers({
          ...o.local.browser,
          stateDir: o.sessions.stateDir,
          clock: o.clock,
          profiles: o.browserProfiles?.store,
          started: (data) => events.emit('browser.started', data),
          stopped: (data) => events.emit('browser.stopped', data),
        });
  // Which container each card's workspace is (ADR 0022): the box's and its routers' alike.
  const directory =
    o.box === undefined ? undefined : (o.box.directory ?? workspaceDirectory(o.box.docker));
  // the Mac's profile Chromes, stored on their own when they close (none on a box)
  const chromeOfProfiles = o.box === undefined ? o.browserProfiles?.chrome : undefined;
  const profileWatch =
    chromeOfProfiles === undefined
      ? undefined
      : startProfileWatch({
          chrome: chromeOfProfiles,
          store: o.browserProfiles?.store,
          clock: o.clock,
          every: o.browserProfiles?.watchMs ?? PROFILE_WATCH_MS,
          emit: (data) => events.emit('browser.profile', data),
        });
  /** Each card's workspace's browser on a box, made on its first use. */
  const browsers = new Map<string, BrowserService>();
  const browserOf = o.box?.browserOf;
  const browser: ByCard<BrowserService> | undefined =
    browserOf === undefined || directory === undefined || o.box === undefined
      ? undefined
      : (asked: number | string | null) => {
          const card = String(asked);
          const had = browsers.get(card);

          if (had !== undefined) return had;
          const made = startBrowserService({
            browser: browserOf(directory.namesOf(card).container),
            clock: o.clock,
            every: o.box?.browserPollMs ?? BROWSER.pollMs,
            profiles: o.browserProfiles?.store,
            started: (data) => events.emit('browser.started', data),
            stopped: (data) => events.emit('browser.stopped', data),
            ready: async () => {
              const w = await box?.get(card);

              if (w === undefined)
                return refused(
                  'no-workspace',
                  `this box has no workspace for card ${card} yet: abe workspace up`,
                );
              if (w.state !== 'running')
                return refused('workspace-stopped', `card ${card}'s workspace is ${w.state}`);

              return { ok: true, data: undefined };
            },
          });

          browsers.set(card, made);

          return made;
        };
  const ran = o.sessions;
  const noSessions = () => new Error('this abe serve runs no sessions');
  /** Each card's git and run tree: its workspace's on a box, else the one there is. */
  const gitOf: ByCard<Git> =
    ran?.byCard?.git ??
    ((): Git => {
      if (ran === undefined) throw noSessions();

      return ran.git;
    });
  const treeOf: ByCard<RunTree> =
    ran?.byCard?.tree ??
    ((): RunTree => {
      if (ran === undefined) throw noSessions();

      return ran.tree;
    });
  // The ports a command gets at its checkout: your logins there and Local mode's holds.
  const routing = openRouting({
    settings,
    localMode,
    tracking: o.tracking,
    trackingOf: o.trackingOf,
    githubAs: o.githubAs,
    githubAccounts: o.githubAccounts,
    review: o.review,
    board: o.board,
    pipelines: o.pipelines,
    pipelinesAs: o.pipelinesAs,
    layerPulls: o.layerPulls,
    retroPulls: o.retroPulls,
    aws: o.aws,
    secrets: o.secrets,
    awsReach: o.awsReach,
    awsAs: o.awsAs,
    boxProfile: o.boxProfile,
    boxProfileOf: (name) => routed?.profileOf(name) ?? null,
    gitOf: ran === undefined ? undefined : gitOf,
    runs: () => factory?.all() ?? [],
  });
  const sheets = o.sheets === undefined ? undefined : openSheets(o.sheets);
  const storedLogins: StoredLogins | undefined =
    o.storedLogins === undefined
      ? undefined
      : startStoredLogins({ ...o.storedLogins, clock: o.clock, emit: events.emit });
  // A box's session tokens: from the stored logins once a secret is named, else as given.
  const boxLogins = storedLogins?.boxLogins ?? o.logins;
  const prototypes: Prototypes | undefined =
    o.prototypes === undefined
      ? undefined
      : openPrototypes({
          ...o.prototypes,
          clock: o.clock,
          emit: events.emit,
          databases,
          ports: portBases,
          worktreeCopies: copiesAt,
          hooks: hooksAt,
          // on this Mac (ADR 0039): a fixed-port repo's prototype on its ports, the main
          // checkout's app stopped for it and started again after
          ...(local === undefined ? {} : { fixedPorts: fixedPortsAt, hand: local }),
          // the prototype-start hook's values: its env file's, as abe run --env hands them
          appValues: async (repo, env) => {
            if (o.install === undefined) return { ok: true, data: {} };
            const r = await credentialsInjection(
              o.install.repo,
              settings,
              realPathAt('/', repo),
              env,
            );

            return r.ok ? { ok: true, data: r.data.env } : r;
          },
        });

  // The sessions (and their Factory runs) once read back: a request that comes before waits.
  const ready = Promise.withResolvers<
    { sessions: Sessions; factory: Factory; clearing: PrStage } | undefined
  >();
  // Without a log store the Mac's sessions in local mode are still kept here, for the retro.
  const logs: LogShipper | undefined =
    o.logs === undefined && (o.sessions === undefined || o.box !== undefined)
      ? undefined
      : startLogShipper({
          store: o.logs?.store,
          // Local mode: a session there is kept on this Mac, never shipped.
          storeFor: (repo) => localMode.logs(repo),
          stateDir: o.sessions?.stateDir ?? '',
          // A box's sessions' home is the container's; their transcripts are read there.
          home: o.sessions?.runner.home ?? o.sessions?.env.HOME ?? '/',
          tree: o.sessions === undefined ? undefined : treeOf,
          database: o.sessions?.env.DATABASE_URL,
          every: o.logs?.every ?? LOG_SHIP_EVERY_MS,
          sessions: ready.promise.then((r) => r?.sessions),
          reach: {
            settings,
            ports: { tracking: o.tracking, aws: o.aws, secrets: o.secrets },
            serve: { clock: o.clock, creds, where: o.reachTarget ?? 'local' },
          },
          // each session's checkout's AWS (ADR 0025)
          reachAt: (repo) => {
            const as = routing.awsAt(repo);

            return as === undefined ? {} : { aws: as.aws, secrets: as.secrets };
          },
          shipped: (data) => events.emit('log.shipped', data),
          failed: (data) => events.emit('log.failed', data),
        });

  let sessions: Sessions | undefined;
  // The install page follows its session's cards and turns: what it waits on is Needs you there
  // until it goes.
  events.watch(undefined, (e) => {
    if (
      (e.type === 'session.ask' || e.type === 'session.answered' || e.type === 'session.state') &&
      e.box === undefined
    )
      void installSessionAsked(
        { serve: { sessions, install: installs, emit: events.emit } },
        e.data.id,
      );
  });
  // Chat's transcripts: read where the sessions run, by the serve that runs them.
  const transcripts: Transcripts | undefined =
    o.sessions === undefined
      ? undefined
      : startTranscripts({
          stateDir: o.sessions.stateDir,
          files: (card) => treeOf(card).transcript,
          home: o.sessions.runner.home ?? o.sessions.env.HOME ?? '/',
          meta: (id) => sessions?.metaOf(id),
          clock: o.clock,
          emit: (data) => events.emit('session.transcript', data),
          interrupted: (id, at) => sessions?.interrupted(id, at),
          log,
        });
  let factory: Factory | undefined;
  let prStage: PrStage | undefined;
  /**
   * A session's merged writers tidied at each turn's end and the session's end: serve's
   * git, outside the sandbox the session's own `git worktree prune` cannot leave. Never while the
   * session works or a subagent runs (a writer just started has nothing past the card branch
   * yet). One at a time per session.
   */
  const tidying = new Map<string, Promise<void>>();

  /** A card's workspace's browser stopped once none of its sessions is open (ADR 0022). */
  const lastOfCard = async (card: string) => {
    const listed = await sessions?.list();

    if (listed?.ok !== true) return;
    if (listed.data.some((x) => String(x.card) === card && x.state !== 'ended')) return;
    await browsers.get(card)?.stop('session-ended');
  };
  /**
   * A session's merged writers tidied: at its turn's end, its own, and a run's step or the run
   * ending (`stepEnded`: the session still working, but no subagent of it running).
   */
  const tidyWriters = (id: string, stepEnded = false) => {
    const git = o.sessions === undefined ? undefined : gitOf;

    if (git === undefined) return;
    const next = (tidying.get(id) ?? Promise.resolve()).then(async () => {
      const meta = sessions?.metaOf(id);

      if (meta === undefined || meta.card === null || meta.worktree === '') return;
      if (meta.state === 'ended') tidying.delete(id);
      else if (
        (meta.state !== 'waiting' && !stepEnded) ||
        subagentRunning(meta.subagents, new Date(o.clock.now()).toISOString())
      )
        return;
      const tidied = await git(meta.card).tidyWriters({
        worktree: meta.worktree,
        repo: meta.repo,
        branch: meta.branch,
        agents: tidyAgents(meta),
      });

      if (tidied.ok && tidied.data.removed.length + tidied.data.deleted.length > 0)
        log(
          `session ${id}: merged writers tidied (${[...tidied.data.removed, ...tidied.data.deleted].join(', ')})`,
        );
    });

    tidying.set(
      id,
      next.catch(() => undefined),
    );
  };

  /** What a local session left running and its database, stopped once it ended. */
  const endLocal = async (id: string) => {
    const meta = sessions?.metaOf(id);

    if (local === undefined || meta === undefined) return;
    const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

    // Each step on its own: a browser that will not stop never keeps the apps running.
    try {
      await localBrowsers?.end(id);
    } catch (err) {
      log(`session ${id} ended, its browser not stopped: ${why(err)}`);
    }
    try {
      const said = await local.end(meta);

      if (said.length > 0) log(`session ${id} ended: ${said.join('; ')}`);
    } catch (err) {
      log(`session ${id} ended, its apps not stopped: ${why(err)}`);
    }
  };

  /**
   * Sessions that ended while no serve ran (read back ended before `sessions` was set): what
   * they left (kept apps, a browser, a database) stopped once this serve holds them.
   */
  const endLeftBehind = async () => {
    if (local === undefined || o.sessions === undefined) return;
    const left = new Set([
      ...local.leftBehind(),
      ...(localBrowsers === undefined ? [] : localBrowsers.leftBehind()),
    ]);

    for (const id of left) if (sessions?.metaOf(id)?.state === 'ended') await endLocal(id);
  };
  let idle: IdleStop | undefined;

  /** Each workspace's socket's card (ADR 0022): a request on it is that card's workspace's. */
  const insideCards = new Map<string, string>();
  /**
   * Answers a request on `socket`: the person's, or (`inside`) the workspace's, where the caller
   * is the workspace's session and nothing in the request can widen it, or a local session's own
   * (`session`, its id), where commands act on that session only.
   */
  const answer = (socket: string, inside: boolean, session?: string) => async (line: string) => {
    const insideCard = insideCards.get(socket);
    // the Abe chat runs as the person: every abe command theirs, prod-on too; no other session
    const hub = session !== undefined && isHub(sessions, session) ? session : undefined;
    const caller = inside || (session !== undefined && hub === undefined) ? 'session' : 'user';
    const heardAt = performance.now();
    const read = readRequest(line);

    if (!read.ok) return { line: JSON.stringify(read.reply) };
    // `--on <box>`: that box's serve answers, through this one (a session's is refused by dispatch).
    const on = splitOn(read.request.argv);

    if (
      on.ok &&
      on.on !== undefined &&
      caller === 'user' &&
      boxes !== undefined &&
      o.cloud !== undefined &&
      link !== undefined
    ) {
      // Local mode where it was typed: no box is woken for it.
      const local = localMode.at(realPathAt(read.request.cwd));

      if (local !== undefined)
        return {
          line: JSON.stringify(
            toReply(
              printFailure(
                {
                  code: 'local-mode',
                  message: `local mode is on in ${local}: no box for it (abe local off first)`,
                },
                EXIT.failed,
                on.argv.includes('--json'),
              ),
            ),
          ),
        };

      return onBoxAnswer(
        withRoom(boxes, cloud?.wakeRoom(read.request.cwd)),
        link,
        o.cloud.boxAttach ?? [...o.cloud.self, 'box', 'attach'],
        on.on,
        on.argv,
        {
          retryMs: o.cloud.followRetryMs ?? 1000,
          sleep: o.cloud.sleep,
        },
      );
    }
    // A session sees no stream until watch is scoped to its own events (`watch` is inSession: false).
    const watching =
      caller === 'session'
        ? undefined
        : watchAnswer(events, read.request.argv, () => closing !== undefined);

    // `abe fresh --follow`: the checkout held while the connection stays.
    const following =
      caller === 'session'
        ? undefined
        : freshAnswer(
            fresh,
            events,
            { argv: read.request.argv, cwd: realPathAt(read.request.cwd) },
            () => closing !== undefined,
          );

    if (following !== undefined) return following;
    if (watching !== undefined) {
      // In your environment the stream is every box's too: those holding a session are followed.
      if (boxes !== undefined && isCloudTarget(targetAt(read.request.cwd)))
        void boxes.discover().catch(() => undefined);

      return watching;
    }
    if (inside) {
      const refusal = insideRefusal(read.request.argv, session !== undefined);

      if (refusal !== undefined) return { line: JSON.stringify(toReply(refusal)) };
    }
    const after: { stop: boolean } = { stop: false };
    const held = (await ready.promise) ?? {
      sessions: undefined,
      factory: undefined,
      clearing: undefined,
    };
    // a repo moved since it was last seen: followed before anything reads it
    if (!inside)
      await repoMoved?.seen(realPathAt(read.request.cwd), {
        sessions: held.sessions,
        runs: held.factory?.rehome,
        local: localMode.rehome,
      });
    // From a session, the settings in force are its own checkout's, wherever it typed the command:
    // its run's, else the one it was launched on; a box's (`owner/name`): the box's checkout of it.
    const ran =
      session === undefined
        ? undefined
        : (held.factory?.get(session) ?? held.sessions?.metaOf(session));
    const onBox = ran !== undefined && !isAbsolute(ran.repo) && o.box !== undefined;
    const checkout = onBox ? await boxCheckoutOf(ran.repo) : ran && checkoutOf(ran);
    // Local mode: the ports a request writes through held where its checkout is in it.
    const here = inside ? undefined : (checkout ?? realPathAt(read.request.cwd));
    const ctx: Ctx = {
      settings:
        settings === undefined || checkout === undefined
          ? settings
          : { ...settings, at: () => settings.at(checkout), facts: () => settings.facts(checkout) },
      socket,
      // Inside, the container's paths mean nothing on the box: pin it to the socket's own dir.
      cwd: inside ? dirname(socket) : realPathAt(read.request.cwd),
      inside,
      insideCard,
      // the Abe chat's commands are the person's: its own socket names it only for its hooks
      session: hub !== undefined && read.request.argv[0] !== 'hook' ? undefined : session,
      hub,
      stopAfterReply: () => {
        after.stop = true;
      },
      // Tracking, Board, Git, Pipelines, Review and AWS as routed at the request's checkout
      ports: routing.at({
        here,
        card: insideCard ?? (session === undefined ? undefined : cardOfSession(session)),
        // a review names its checkout (`--path`): local mode is that checkout's, its gh login too
        reviewAt: pathFlag(read.request.argv, read.request.cwd),
      }),
      // serve's own: the same for every request, but a wake's room where it was typed
      serve: {
        version: o.version ?? VERSION,
        installed,
        pid: o.pid,
        startedAt,
        unlisted: () => routed?.unlisted() ?? [],
        clock: o.clock,
        creds,
        where: o.reachTarget ?? 'local',
        org: o.sheets?.org,
        sheets,
        prototypes,
        emit: events.emit,
        holds,
        idle,
        box,
        workspacePorts,
        onBox: box !== undefined,
        localApps: local,
        localBrowsers,
        // a run's checkout's environments on for agents (ADR 0029): a Playbook step on another is yours
        agentEnvs: agentEnvsAt,
        // what a card's worktree got from its checkout: never counted as the run's changes
        worktreeCopies: (checkout: string) => copiesAt(checkout),
        recordParts: records,
        // an enabled environment's aws login read at launch: the Mac's serve, whose keys a box gets
        awsLogin:
          o.install === undefined || box !== undefined ? undefined : o.install.repo.awsCredentials,
        macDatabase: macFacts,
        browser,
        profileStore: o.browserProfiles?.store,
        cardInstall:
          o.cardsNeedInstall === true && box === undefined
            ? async (dir: string) => {
                const top = mainCheckout(dir);
                const notDone = top === undefined ? null : cardInstallRefusal(await installAt(top));

                return notDone === null
                  ? { ok: true as const, data: null }
                  : refused(notDone.code, notDone.message);
              }
            : undefined,
        chrome: o.browserProfiles?.chrome,
        profileWatch,
        localMode,
        ...held,
        cloud,
        forwards: ports,
        // A wake by name counts under the limit where it was typed.
        boxes: boxes === undefined ? undefined : withRoom(boxes, cloud?.wakeRoom(read.request.cwd)),
        transcripts,
        // the sessions' HOME: yours `.claude/skills` (`session skills`)
        sessionsHome: o.sessions?.runner.home ?? o.sessions?.env.HOME,
        logins: boxLogins,
        logs,
        oneShot:
          o.oneShot === undefined || o.sessions === undefined
            ? undefined
            : { port: o.oneShot, env: o.sessions.env, bin: o.sessions.runner.bin },
        triageDir: o.sessions?.stateDir,
        improveDir: o.sessions?.stateDir,
        recentCommands: recentCommandsOf(events),
        lastEvent: events.last,
        retroDir: o.sessions?.stateDir,
        storedLogins,
        toolProbe: o.toolProbe,
        demo: o.demo,
        install: installs,
        mover,
        moves,
        moveDir: o.sessions === undefined ? undefined : join(o.sessions.stateDir, 'moves'),
        workflowState: o.sessions?.stateDir ?? dirname(o.socket),
        checkout: o.checkout,
        fresh,
      },
    };
    const printed = await dispatch(read.request.argv, handlers, ctx, caller, {
      now: o.clock.now(),
    });

    commandRan(events, read.request.argv, printed.exit, read.request.tag);
    const [command, event] = read.request.argv;

    return {
      line: JSON.stringify({ ...toReply(printed), version: o.version ?? VERSION }),
      ...(after.stop ? { after: () => void stop() } : {}),
      // a hook whose `abe hook` gave up before serve answered: Claude Code went on without it
      ...(command === 'hook' && session !== undefined
        ? {
            gone: () => {
              log(
                `session ${session}: its ${event ?? ''} hook was answered after its abe hook gave up (${Math.round(performance.now() - heardAt)} ms in serve): Claude Code went on without the answer`,
              );
            },
          }
        : {}),
    };
  };
  /** `serve.target` where a command was typed: your environment only when it says `cloud`. */
  const targetAt = (cwd: string) => serveTargetIn(settings, cwd, box !== undefined);
  const mover = o.mover ?? shellMover(o.sessions?.env ?? {});
  const moves = moveLocks();
  const boxes: BoxFront | undefined =
    o.cloud === undefined || link === undefined
      ? undefined
      : startBoxFront({
          boxes: routed?.boxes ?? o.cloud.boxes,
          link,
          version: o.version ?? VERSION,
          clock: o.clock,
          sleep: o.cloud.sleep,
          emit: events.emit,
          ...(routed?.scanList === undefined ? {} : { scanList: routed.scanList }),
          ...(o.cloud.pollMs === undefined ? {} : { pollMs: o.cloud.pollMs }),
          ...(o.cloud.bootMs === undefined ? {} : { bootMs: o.cloud.bootMs }),
          ...(o.cloud.followRetryMs === undefined ? {} : { followRetryMs: o.cloud.followRetryMs }),
          uptimeFile: join(o.sessions?.stateDir ?? dirname(o.socket), 'box-uptime.jsonl'),
          // Off where serve.target is local and no box profile is named, there either.
          off: (cwd) =>
            o.cloud?.profileNamed !== true &&
            routing.profileAt(cwd) === null &&
            serveTargetIn(settings, cwd, false) === LOCAL_TARGET,
        });
  // A dev server on a box forwarded here: one forward per workspace and port.
  const ports =
    boxes === undefined || link === undefined
      ? undefined
      : startPortForwards({
          front: boxes,
          link,
          clock: o.clock,
          emit: (data) => events.emit('port.forward', data),
          watch: (see) => events.watch(undefined, see),
        });
  const cloud: CloudSessions | undefined =
    o.cloud === undefined || boxes === undefined || link === undefined
      ? undefined
      : startCloud({
          ...o.cloud,
          ...(routed === undefined
            ? {}
            : {
                boxes: routed.boxes,
                ...(routed.scanList === undefined ? {} : { scanList: routed.scanList }),
              }),
          link,
          version: o.version ?? VERSION,
          // a new box on the box profile in force where it was launched (ADR 0025)
          profileAt: routing.profileAt,
          front: boxes,
          mover,
          movedBack: (id) => sessions?.unmove(id),
          stateDir: o.sessions?.stateDir ?? dirname(o.socket),
          clock: o.clock,
          limitAt: (where) =>
            settings?.at(where ?? process.cwd()).values['limits.maxBoxesPerPerson'] ??
            coreDefaults()['limits.maxBoxesPerPerson'],
          // A new repo box's size, within the largest allowed.
          sizeAt: (where) => {
            const values = settings?.at(where ?? process.cwd()).values ?? coreDefaults();

            return { size: values['box.size'], max: values['limits.maxBoxSize'] };
          },
          emit: (data, box) => events.emit('session.state', data, box),
          emitStage: (data, box) => events.emit('factory.stage', data, box),
          step: (data) => events.emit('box.step', data),
          emitStep: (data, box) => events.emit('session.step', data, box),
          ...(settings === undefined
            ? {}
            : { layer: (where) => yourHandedLayer(settings.places, where) }),
          ...(o.cloud.boxSync === undefined || settings === undefined || o.install === undefined
            ? {}
            : {
                sync: boxSyncer({
                  port: o.cloud.boxSync,
                  settings,
                  repo: o.install.repo,
                  checked: async (main) => checkedSourceServers(await installAt(main)),
                  home: o.sessions?.env.HOME,
                  // abe.yaml's groups first (recipeCopies), then the install's env map
                  envMap: async (main) => (await installAt(main))?.envFiles?.mapping?.files ?? [],
                  now: () => o.clock.now(),
                  log,
                }),
              }),
          log,
        });
  queue.nudge = cloud?.nudge;
  // Another serve listens (two starts at once): what this one started stops, or its timers keep
  // the process running unwatched, an orphan.
  /** `stop`, once there is one: the socket's `lost` may come before. */
  const stopping: { stop?: () => Promise<void> } = {};
  const listener = await listen(o.socket, withProgress(events, answer(o.socket, false)), 0o600, {
    checkMs: o.socketCheckMs ?? SOCKET_CHECK_MS,
    // the lock goes with the socket: a serve started next takes both
    unlisted: () => {
      lock.release();
    },
    lost: () => {
      log(`abe serve: another process answers on ${o.socket} now; this one stops`);
      void stopping.stop?.();
    },
  }).catch(async (err: unknown) => {
    holds.close();
    settings?.stop();
    themes?.stop();
    fresh.stop();
    for (const b of browsers.values()) b.close();
    localBrowsers?.close();
    profileWatch?.close();
    boxes?.close();
    // a close that fails hides no SocketInUse
    await Promise.allSettled([
      transcripts?.close(),
      logs?.close(),
      prototypes?.close(),
      cloud?.close(),
      storedLogins?.close(),
    ]);
    o.cloud?.link.close?.();
    await sheets?.host.close().catch(() => undefined);
    throw err;
  });

  lock.listening();
  try {
    // After listening: a serve that failed to start (another one listens) never stops the box.
    const idleAt = o.idle;
    // The awake keep is the box's boot's: one set before the box stopped is gone.
    const boot = (await idleAt?.host.boot?.().catch(() => null)) ?? null;

    idle =
      idleAt === undefined
        ? undefined
        : startIdleStop({
            name: idleAt.name,
            clock: o.clock,
            ...(idleAt.everyMs === undefined ? {} : { everyMs: idleAt.everyMs }),
            minutes: () =>
              settings?.at(idleAt.cwd).values['box.idleMinutes'] ??
              coreDefaults()['box.idleMinutes'],
            waitingMinutes: () =>
              settings?.at(idleAt.cwd).values['box.waitingMinutes'] ??
              coreDefaults()['box.waitingMinutes'],
            keeps: () =>
              idleKeeps({ host: idleAt.host, runner: o.sessions?.runner, sessions, factory }),
            host: idleAt.host,
            emit: (data) => events.emit('box.state', data),
            log,
            keep: {
              file: join(o.sessions?.stateDir ?? dirname(o.socket), 'box-keep.json'),
              boot,
            },
            said: (data) => events.emit('box.idle', data),
          });
    sessions =
      o.sessions === undefined
        ? undefined
        : await startSessions({
            ...o.sessions,
            ...(local === undefined
              ? {}
              : { database: { start: local.database, stop: local.stopDatabase } }),
            ...(localBrowsers === undefined ? {} : { browsers: localBrowsers }),
            serveSocket: o.socket,
            ...(settings === undefined ? {} : { facts: (repo: string) => settings.facts(repo) }),
            localGuards: async (repo) => localModeGuards(await installAt(repo)),
            // what no session reads (ADR 0029): repo env files of environments off, other
            // checkouts' Abe env files, your az folder
            offRepoEnvFiles: async (repo, enabled) =>
              offRepoEnvFiles(
                envPlacement(
                  teamAt(repo)?.worktree,
                  (await installAt(repo))?.envFiles?.mapping?.files ?? [],
                  teamAt(repo)?.['env.notUsed'] ?? [],
                ),
                enabled,
              ),
            credentialValues: (repo) =>
              o.install === undefined
                ? Promise.resolve({})
                : abeEnvValues(o.install.repo, realPathAt('/', repo)),
            abeEnvFiles: (repo, envs) =>
              o.install === undefined
                ? Promise.resolve([])
                : hasAbeEnvFiles(o.install.repo, realPathAt('/', repo), envs),
            checkedSources: async (repo) => checkedSourceServers(await installAt(repo)),
            worktreeCopies: copiesAt,
            hooks: hooksAt,
            nodeOptions: (repo) => ciNodeOptions(ciFiles(repo)),
            githubToken: (repo) => {
              const account = routing.accountAt(repo);

              return account === null || o.githubToken === undefined
                ? undefined
                : o.githubToken(account)();
            },
            clock: o.clock,
            log,
            emit: (data) => {
              events.emit('session.state', data);
              // A run's state follows its session's (none before the runs are read back).
              factory?.sessionMoved(data);
              // Its last shipment: it starts after this step, once the change is in its meta.json.
              if (data.state === 'ended') logs?.ended(data.id);
              // The box workspace it ran in (ADR 0022: its card's).
              const card = String(sessions?.metaOf(data.id)?.card ?? cardOfSession(data.id) ?? '');
              // A worktree its subagents removed in the sandbox but git still lists.
              if (data.state === 'ended' && card !== '') void box?.prune(card);
              // A local session's apps and database: stopped with it.
              if (data.state === 'ended') void endLocal(data.id);
              // Its merged writers' worktrees and branches, at a turn's end and its own.
              if (data.state === 'waiting' || data.state === 'ended') tidyWriters(data.id);
              // A workspace's browser is its sessions': it goes when the card's last one ends.
              if (data.state === 'ended' && browsers.has(card)) void lastOfCard(card);
            },
            emitSubagent: (data) => events.emit('session.subagent', data),
            emitQueued: (data) => events.emit('session.queued', data),
            emitModel: (data) => events.emit('session.model', data),
            emitTitled: (data) => events.emit('session.titled', data),
            emitAnswered: (data) => events.emit('session.answered', data),
            emitAsk: (data) => events.emit('session.ask', data),
            heard: () => idle?.heard(),
            listen: async (socket, id, mode) => {
              // A container's session (another uid) must get through its folder to its socket, and
              // the workspace's script user never: the folder is the session user's own.
              if (mode !== 0o600) {
                const access = sessionDirAccess(process.getuid?.() ?? -1);

                await mkdir(dirname(socket), { recursive: true, mode: 0o755 });
                await chmod(dirname(dirname(socket)), 0o755);
                if (access.chown !== undefined)
                  await chown(dirname(socket), access.chown[0], access.chown[1]);
                await chmod(dirname(socket), access.mode);
              }

              // In a workspace container: the workspace's narrower set; else a local session's.
              const card = cardOfSession(id);
              const inWorkspace =
                o.box !== undefined &&
                [LEGACY_NAMES, ...(card === undefined ? [] : [workspaceNames(card)])].some(
                  (names) =>
                    o.box !== undefined &&
                    isWorkspaceSessionSocket(socket, join(o.box.dir, names.socketDir)),
                );

              return listen(socket, answer(socket, inWorkspace, id), mode);
            },
          });
    void endLeftBehind();
    factory =
      sessions === undefined || o.sessions === undefined
        ? undefined
        : startFactory({
            stateDir: o.sessions.stateDir,
            clock: o.clock,
            sessions,
            emit: (data) => {
              events.emit('factory.stage', data);
              // a step done (the run moved on) or the run over: its merged writers go now
              if (data.from !== null || data.outcome !== null) tidyWriters(data.session, true);
              // the run over after its session ended (abandoned, Done): its log's run.json again,
              // so the store says how it ended too
              if (data.outcome !== null) logs?.ended(data.session);
            },
            tree: treeOf,
            // A run's card moves held where its checkout is in local mode.
            board: routing.run.board,
            settings,
            emitCard: (data) => events.emit('factory.card', data),
            // each finished step's summary and the run's brief, by the fast model
            summarize: stepSummarizer({
              entries: async (session) => {
                const read = await transcripts?.read(session, 0);

                return read?.ok === true ? read.data.entries : [];
              },
              file: (run, path) => runReportText(treeOf, run, path),
              card: async (run) => {
                const board = boardOf(settings?.at(checkoutOf(run)).values.board);

                if (!board.ok) return null;
                const shown = await o.board.show(board.board, run.card).catch(() => undefined);

                return shown?.ok === true
                  ? { description: shown.data.description, criteria: shown.data.acceptanceCriteria }
                  : null;
              },
              known: (run) =>
                o.install === undefined
                  ? Promise.resolve([])
                  : abeEnvRedacted(o.install.repo, realPathAt('/', run.repo)),
              ask: async (run, prompt) => {
                const asked = await askOneShot(
                  {
                    cwd: run.repo,
                    settings,
                    serve: {
                      oneShot:
                        o.oneShot === undefined || o.sessions === undefined
                          ? undefined
                          : { port: o.oneShot, env: o.sessions.env, bin: o.sessions.runner.bin },
                    },
                  },
                  {
                    role: 'summarizer',
                    cwd: run.worktree === '' ? run.repo : run.worktree,
                    prompt,
                    system: SUMMARY_SYSTEM,
                    reach: {},
                  },
                );

                return asked.ok
                  ? { ok: true, text: asked.data.text }
                  : { ok: false, why: asked.error.message };
              },
              now: () => new Date(o.clock.now()).toISOString(),
            }),
            emitSummary: (data) => events.emit('factory.summary', data),
            checks:
              o.checks ??
              repoChecks({
                settings,
                tree: treeOf,
                clock: o.clock,
                emit: (data) => events.emit('factory.checks', data),
                // the memory the repo's CI gives its tests, read in the run's checkout
                nodeOptions: (run) => ciNodeOptions(ciFiles(run.repo)),
                // the checks' environment abe.yaml says, else its install recorded (ADR 0028,
                // 0040, `checksEnvOf`); every
                // Abe env file's value redacted from what they say
                ...(local === undefined || o.install === undefined
                  ? {}
                  : {
                      injected: async (run: { repo: string }) => {
                        const install = o.install;

                        if (install === undefined) return { ok: true as const, data: {} };
                        const r = await credentialsInjection(
                          install.repo,
                          settings,
                          realPathAt('/', run.repo),
                          await checksEnvAt(run.repo),
                        );

                        return r.ok ? { ok: true as const, data: r.data.env } : r;
                      },
                      // its name only, kept on the run with the names the commands got
                      envName: async (run: { repo: string }) => checksEnvAt(run.repo),
                      redacted: (run: { repo: string }) =>
                        o.install === undefined
                          ? Promise.resolve([])
                          : abeEnvRedacted(o.install.repo, realPathAt('/', run.repo)),
                    }),
                // A local run's checks in dev get its session's own database; in test or prod
                // that environment's Abe env file's.
                ...(local === undefined
                  ? {}
                  : {
                      database: async (run) => {
                        if (!takesOwnDatabase(await checksEnvAt(run.repo))) return undefined;
                        const db = await local.database({ id: run.session, repo: run.repo });

                        return db.ok ? db.data : undefined;
                      },
                    }),
              }),
          });
    // The box's workspace before the pr stage's first read and before any request is answered:
    // a serve started again logs the workspace's gh in here.
    if (o.box !== undefined)
      box = await openBox(
        {
          ...o.box,
          log,
          step: (data) => events.emit('workspace.step', data),
          ...(boxLogins === undefined ? {} : { logins: boxLogins }),
          ...(directory === undefined ? {} : { directory }),
          // A removed workspace's browser stops being watched.
          removed: (card) => {
            browsers.get(card)?.close();
            browsers.delete(card);
            void workspacePorts?.drop(card);
          },
          now: () => o.clock.now(),
          // Read where the idle stop reads its minutes (the box's home), as it looks.
          maxDiskGb: () =>
            settings?.at(o.idle?.cwd ?? settings.places.configDir).values['limits.maxBoxDisk'] ??
            coreDefaults()['limits.maxBoxDisk'],
        },
        (socket, card) => {
          insideCards.set(socket, card);

          return listen(socket, answer(socket, true), 0o666);
        },
      );
    if (box !== undefined && o.box !== undefined)
      workspacePorts = startWorkspacePorts({
        box,
        docker: o.box.docker,
        relays: o.box.relays,
        emit: (data) => events.emit('workspace.ports', data),
        ...(o.box.portsEveryMs === undefined ? {} : { everyMs: o.box.portsEveryMs }),
        log,
      });
    // Each workspace's browser watched from the start: one a serve before left running is
    // adopted and idle-stopped with no command run.
    if (box !== undefined && browser !== undefined)
      for (const w of await box.list().catch(() => [])) browser(w.card);
    prStage =
      sessions === undefined || factory === undefined || o.sessions === undefined
        ? undefined
        : startPrStage({
            factory,
            tracking: routing.run.tracking,
            git: routing.run.git,
            ...(box === undefined
              ? {}
              : {
                  // A cleared run on a box: its card's workspace goes (ADR 0022).
                  // Its work was looked at already: a squash-merged head counts as pushed there.
                  removeWorkspace: (run: Run) =>
                    box?.rm(String(run.card), { workChecked: true }) ??
                    Promise.resolve(refused('not-a-box', 'this abe serve runs no workspace')),
                }),
            sessions,
            settings,
            clock: o.clock,
            every: o.factoryPollMs ?? PR_POLL_MS,
            midnightAfter: o.midnightAfter ?? nextLocalMidnight,
          });
  } catch (err) {
    ready.resolve(undefined);
    idle?.stop();
    await workspacePorts?.stop();
    prStage?.stop();
    settings?.stop();
    themes?.stop();
    for (const b of browsers.values()) b.close();
    localBrowsers?.close();
    profileWatch?.close();
    await sessions?.close();
    await transcripts?.close();
    await logs?.close();
    await storedLogins?.close();
    await cloud?.close();
    boxes?.close();
    o.cloud?.link.close?.();
    await listener.close();
    throw err;
  }
  ready.resolve(
    sessions === undefined || factory === undefined || prStage === undefined
      ? undefined
      : { sessions, factory, clearing: prStage },
  );

  const stop = () => {
    holds.close();
    settings?.stop();
    themes?.stop();
    fresh.stop();
    prStage?.stop();
    for (const b of browsers.values()) b.close();
    localBrowsers?.close();
    profileWatch?.close();
    idle?.stop();
    ports?.stop();
    boxes?.close();
    closing ??= Promise.all([
      workspacePorts?.stop(),
      box?.close(),
      sessions?.close(),
      transcripts?.close(),
      logs?.close(),
      prototypes?.close(),
      cloud?.close(),
      storedLogins?.close(),
    ])
      // The link's keys go once nothing uses it any more.
      .then(() => o.cloud?.link.close?.())
      .then(() => sheets?.host.close())
      .then(() => listener.close())
      .then(() => {
        signal(undefined);
      });

    return closing;
  };

  stopping.stop = stop;

  return {
    socket: o.socket,
    stop,
    stopped,
    pollSettings: () => {
      settings?.poll();
    },
  };
};
