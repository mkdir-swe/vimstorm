/**
 * `abe session` and `abe hook`: the sessions this `serve` runs through its `SessionRunner`, each
 * with its own socket (`<state>/sessions/<id>/session.sock`, its `ABE_SOCKET`). Which socket a
 * request came in on is who sent it: `ctx.session` is that session's id (undefined on `serve`'s
 * own socket), and a command from inside a session acts on that session only. Where a session
 * stands comes from its hooks only; each change is a `session.state` event and is kept in its
 * `meta.json`, so a restarted `serve` knows it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  figmaServers,
  hubName,
  hubNameApart,
  hubUnnamed,
  type AttachSpec,
  agentEnvKey,
  attachSpecOf,
  awsHome,
  awsOffEnv,
  AWS_HOME_DENY,
  type CardDetail,
  type ClaudeSettings,
  type Effort,
  type QueuedRow,
  type SessionModelData,
  type PermissionMode,
  type PermissionAnswer,
  unattendedAnswer,
  type Clock,
  CORE_INSTRUCTIONS,
  withSubagentsMax,
  PLAIN_SESSION_INSTRUCTIONS,
  type EventData,
  type Journal,
  HookPayload,
  type HookInput,
  inSessionRules,
  FENCE_ENV,
  MCP_START_TIMEOUT_ENV,
  MCP_START_TIMEOUT_MS,
  BOARD_WRITE_DENY,
  LOCAL_MODE_DENY,
  LOCAL_MODE_ENV,
  SETTINGS,
  type SessionMcp,
  sessionBoundary,
  sessionTmp,
  TMP_NAMES,
  sessionFence,
  type SessionFence,
  sessionModels,
  type SessionModels,
  prototypeModel,
  sessionPlugin,
  pluginFor,
  sessionSettings,
  SIGN_IN_ON_PAGE_ENV,
  sourcesLine,
  abeEnvLine,
  type AbeEnv,
  ABE_ENVS,
  accessRules,
  agentEnvsLine,
  withOwnReach,
  withSourceValues,
  parseEnvFile,
  SOURCE_VALUES_PATH,
  homeSecrets,
  launchPrompt,
  nodeAtLaunch,
  baseWorktreePath,
  withSourceRules,
  sourceName,
  type SourceEntry,
  cardBranch,
  NO_DATABASE_NOTE,
  NO_DOCKER,
  worktreePath,
  type WorktreeCopy,
  type WorktreeRecipe,
  DEFAULT_HOOKS,
  type RepoHooks,
  repoHooksIn,
  type Outcome,
  type Tracked,
  WORKSPACE_DATABASE,
  parseCardId,
  type PluginFile,
  type AbeChatOf,
  type PrototypeChatOf,
  readOnlyPaths,
  refused,
  type SessionData,
  SessionMeta,
  type Moved,
  type SessionRunner,
  type SessionState,
  sessionEnv,
  noStartReason,
  startBy,
  startOverdue,
  sessionStep,
  type SessionInput,
  STARTING_EVENTS,
  withKind,
  silentSubagents,
  silentSubagentPrompt,
  isSessionSecret,
  abeSecrets,
  redactText,
  WORKSPACE_MOUNT,
  boardOf,
  type BoardRef,
  isLocalBoard,
  githubRepoOf,
  boxesUnreadText,
  isCloudTarget,
  localCheckoutOf,
  type LaunchTarget,
  parseRepo,
  DEFAULT_PROFILE,
  type ProfileStore,
  cardHasSession,
  type LaunchNote,
  type StandingNote,
  claudeSessionOf,
  CRASHED,
  type Handlers,
} from '@abe/core';
import { launchSetupOf } from './launch-note';
import { awsOffFile } from '../install/aws-off';
import { launchProfile } from '../browser/browser-profiles';
import {
  appendHookEvent,
  type Env,
  originHadBranch,
  originUrl,
  type Listener,
  readSessionMetas,
  foundManagers,
  mainCheckout,
  nodeThatRuns,
  realPath,
  repoRoot,
  sessionKnown,
  writeSessionMeta,
  abeFolder,
} from '@abe/ports';
import { type CheckoutFacts, serveTargetIn } from '../layer/settings';
import { realPathAt, repoHere } from '../contract/here';
import { type BoardCtx } from '../board/board';
import { type CloudSessions } from '../box/cloud';
import { type BoxesCtx, type BoxSessions } from '../box/boxes';
import { type ReachCtx, sessionReach } from '../layer/reach';
import { type Transcripts } from './transcript';
import { type SessionQueue, sessionQueue } from './queue';
import { type Factory } from '../factory/factory';
import { type AwsLoginCheck, awsLoginsRefused, launchEnvs } from '../factory/launch-aws';

export type SessionsOptions = {
  stateDir: string;
  /** The default state folders besides `stateDir` (another serve's): hidden from sessions too. */
  defaultStates?: readonly string[];
  /** Your own Layer's folder (`settingsPlaces`' `configDir`): never written by a session. */
  configDir?: string;
  runner: SessionRunner;
  clock: Clock;
  /** `serve`'s environment: a session's `HOME`, `PATH` and locale come from it. */
  env: Env;
  /** `serve`'s own socket: a session's sandbox keeps it out. */
  serveSocket: string;
  /**
   * The settings' facts at `repo` (`CheckoutFacts`): in local mode a session launched there is
   * refused its own outward writes (core's `LOCAL_MODE_DENY`) and sends no telemetry
   * (`LOCAL_MODE_ENV`); its agents reach `agentEnvs` alone (ADR 0029: the others' Abe env files,
   * aws keys and hosts are out); your other checkouts' Abe env files and your az folder are never
   * read. None: not in local mode, dev and test, nothing more hidden.
   */
  facts?: (repo: string) => CheckoutFacts;
  /**
   * Your gh login's token in `repo` (`logins.gh`, ADR 0025): its session's gh goes as it
   * (`GH_TOKEN`), gh's active login never switched. None, or `undefined`: gh's own login.
   */
  githubToken?: (repo: string) => Promise<Tracked<string>> | undefined;
  emit: (data: EventData<'session.state'>) => void;
  emitSubagent: (data: EventData<'session.subagent'>) => void;
  /** A session's queue changed, or its model (#115). */
  emitQueued?: (data: EventData<'session.queued'>) => void;
  emitModel?: (data: EventData<'session.model'>) => void;
  /** An Abe chat conversation named by your first message to it. */
  emitTitled?: (data: EventData<'session.titled'>) => void;
  /** Cards answered outside Chat (`answer` null): a dialog's card once its dialog went by Esc. */
  emitAnswered?: (data: EventData<'session.answered'>) => void;
  /** Cards asked, or changed (a pick, a hold run out). */
  emitAsk?: (data: EventData<'session.ask'>) => void;
  /** Each hook heard (a box's idle stop counts from the last one, #92). */
  heard?: () => void;
  /** What serve says in serve.log: a look for a `claude` that never started that failed. */
  log: (message: string) => void;
  /** How often `abe session model` reads Claude Code's `/model` picker, and how long (a test's). */
  pick?: { everyMs: number; forMs: number };
  /** Answers requests on a session's socket as that session (`mode`: the socket file's). */
  listen: (socket: string, id: string, mode: number) => Promise<Listener>;
  /**
   * A local card session's own database (#146): the repo's `db` hook's `db start` in its
   * checkout, before `claude` starts (undefined: the repo has none); `stop` when its launch failed.
   */
  database?: {
    start: (o: { id: string; repo: string }) => Promise<Outcome<string | undefined>>;
    stop: (o: { id: string; repo: string }) => Promise<unknown>;
  };
  /**
   * Local sessions' browsers (#182): for a launch with `browser`, the MCP config its `claude`
   * starts with once its worktree is known (undefined: no Chrome or no npx on `path`).
   */
  /**
   * A local-mode card session's guards from its checkout's install (Factory runs too): the
   * scripts that write real systems refused, and whether aws is off (its install never checked
   * it). None: no guards beyond local mode's.
   */
  localGuards?: (repo: string) => Promise<{ deny: readonly string[]; awsOff: boolean }>;
  /**
   * The repo env files of a checkout (from its top) that feed only environments off for agents,
   * or that the install was not sure of (ADR 0029; placed by abe.yaml's worktree groups, then the
   * install's `envFiles.mapping`, ADR 0040). None: none.
   */
  offRepoEnvFiles?: (repo: string, enabled: readonly AbeEnv[]) => Promise<readonly string[]>;
  /**
   * The source servers whose check at the checkout's install passed (ADR 0027,
   * `checkedSourceServers`): a local session loads only these of its main checkout's; none before
   * the install's Sources is done. None given: it loads none.
   */
  checkedSources?: (repo: string) => Promise<readonly string[]>;
  /**
   * Which of `envs` a card's or an install's session's checkout has an Abe env file of (ADR 0028):
   * it is told of those, where they are. None: never told.
   */
  abeEnvFiles?: (repo: string, envs: readonly AbeEnv[]) => Promise<readonly AbeEnv[]>;
  /**
   * Every value of the Abe env files of a card's or an install's session's checkout (ADR 0028),
   * each by its environment and key (`TEST_API_KEY`), known to redact from its logs; never in
   * its environment. None: none.
   */
  credentialValues?: (repo: string) => Promise<Readonly<Record<string, string>>>;
  /**
   * What a local card worktree made now gets copied in from its checkout `repo` (`worktreeCopies`:
   * the team's untracked files, what the repo's worktree recipe lists), the Abe env files of
   * `enabled` (the session's; none given: the repo's); one started again (reopened, resumed) gets
   * the team's files it lacks. None: nothing.
   */
  worktreeCopies?: (repo: string, enabled?: readonly AbeEnv[]) => Promise<readonly WorktreeCopy[]>;
  /** The repo's hook points (the main checkout's): its `worktree-setup`; none: today's, none. */
  hooks?: (repo: string) => RepoHooks;
  /** The `NODE_OPTIONS` the repo's CI gives (`ciNodeOptions`), a local card session's too; null: none. */
  nodeOptions?: (repo: string) => string | null;
  browsers?: {
    launch: (id: string, path: string) => Promise<((worktree: string) => string) | undefined>;
  };
};

/** How often sessions are looked at for a `claude` that never started. */
const START_CHECK_MS = 5000;

type EnvResult =
  { ok: true; env: Record<string, string> } | { ok: false; code: string; message: string };

/** What a launch may add to a plain one (a Factory run's): its own instructions and prompt. */
export type LaunchExtras = {
  /**
   * The repo's Abe chat in place of a card's session: no card, its folder the main checkout,
   * unjailed (the person's own Claude Code), under `title`.
   */
  abe?: { of: AbeChatOf; folder: string; title: string };
  /**
   * A prototype session: on its throwaway `branch` (its worktree made before the launch), on
   * prototype `of`, jailed as a card's session; with a card it never counts as the card's session
   * (a Factory run may start), with none (`card` null) it goes under `title`.
   */
  code?: { of: PrototypeChatOf; title?: string };
  /** Files added to core's plugin (the Abe chat's skills). */
  plugin?: readonly PluginFile[];
  /** Folders the session may read but never write (a prototype chat's checkout, #81). */
  readOnly?: readonly string[];
  /** Files it may never write (a developer prototype's `config.worktree`, #83). */
  readOnlyFiles?: readonly string[];
  /** Permission rules it is refused (a developer prototype's pushes, #83). */
  deny?: readonly string[];
  /** Permission rules it asks the person each time (a Connected install's outward writes). */
  askRules?: readonly string[];
  instructions?: string;
  /** Instead of the core launch prompt (`launchPrompt`). */
  prompt?: string;
  /** Your Launch note and the standing notes in force (#347): in its prompt, kept on it. */
  note?: LaunchNote | null;
  standing?: readonly StandingNote[];
  /** The permission mode it starts in (a Factory run's); none: the person's own default. */
  permissionMode?: PermissionMode;
  /**
   * Nobody is at its prompts (#67): a Factory run's session in a box's workspace (with `managed`),
   * whose permission prompts its hook answers (`unattendedAnswer`). Never a person's session.
   */
  unattended?: boolean;
  /** Called once the session has its id, before its `claude` starts (so before any hook). */
  starting?: (id: string) => void;
  /** The browser profile its verify browser starts in (#103); default: the built-in `default`. */
  browserProfile?: string;
  /**
   * Prod on for this session alone (ADR 0029), the person's at launch: its Abe env file linked,
   * its secrets not denied, `abe run --env prod` let through, whatever `agents.prod` says.
   */
  prodOn?: boolean;
  /**
   * In a box's workspace (#63): its id as the Mac named it, and the clone's branch. Locally, the
   * branch it works on in place of the card's own (a pipeline fix's, `abe pipeline fix`).
   */
  id?: string;
  branch?: string;
  /** Where `branch`, not there yet, is made from (a pipeline fix: the failed revision). */
  from?: readonly string[];
  /** The session's environment once its socket is known, instead of a local one's. */
  env?: (where: { socket: string; bin: string; home?: string; user?: string }) => EnvResult;
  /** Added to the session's own settings (its socket folder opened again in the sandbox). */
  settings?: (id: string) => ClaudeSettings;
  /** The workspace container's managed settings, `abe`'s command given. */
  managed?: (abe: string) => ClaudeSettings;
  /**
   * The trees its commands and file tools see, in place of the checkout and its worktree (a box's,
   * `BOX_TREES`): its access rules name these, and no other checkout's files (none is there).
   */
  trees?: readonly string[];
  mcpConfig?: string;
  /** A local Factory run's own browser (#182): its MCP config made for its worktree. */
  browser?: boolean;
  /**
   * A Factory run (#218): with no database to give it while its pack says the repo needs one,
   * a local one is refused at its launch rather than left to fail its checks and ask for one.
   */
  factory?: boolean;
  files?: readonly { path: string; text: string }[];
  /**
   * A box's session (3.2.1): the sources whose check passed at the Mac's install, in place of this
   * serve's (`checkedSources`), and the environments whose Abe env file the Mac synced into its
   * clone (told of those alone).
   */
  checkedSources?: readonly string[];
  envFiles?: readonly AbeEnv[];
  /**
   * A moved session (#88): it goes on as `claudeSession` (`claude --resume`), its transcript
   * copied into the worktree at `transcript` (relative to it), `from` the folder it ran in before.
   */
  resume?: { claudeSession: string; transcript: string; from: string };
  /**
   * A reopen (#343) of the ended session `id`: the same id and record go on (`claude --resume` on
   * its Claude Code conversation, the transcript's id after a `/clear`), in its worktree as it is
   * or made again from its branch, never a branch made anew.
   */
  reopen?: true;
};

/** The settings in force in a repo that shape a launch. */
export type LaunchSettings = {
  /** The coordinator's and the agents' models. */
  allowedModels: readonly string[];
  /** Off: the person's own skills, plugins and rules stay out of the session. */
  skillsOnTop: boolean;
  /** `session.mcp`: a plain local session loads the person's MCP servers too, or Abe's alone. */
  sessionMcp: SessionMcp;
  /** The repo pack's setup, run in a worktree made at launch before `claude` starts. */
  setup: string | null;
  /** Claude Code's effort (#115); none: Claude Code's own default. */
  effort?: Effort;
  /** `subagents.max`: the most subagents the session is told to run at once (#108). */
  subagentsMax?: number;
  /**
   * The models asked for: `models.coordinator`, `models.reader`, `models.writer` (a prototype
   * chat's `prototype.model` for all three, #350), each held to `allowedModels`.
   */
  models?: SessionModels;
  /** The repo's `sources:` (ADR 0031): the team's MCP servers, the main checkout's. */
  sources?: readonly SourceEntry[];
  /** The repo's worktree recipe (`worktree:`), the main checkout's: never a worktree's copy. */
  worktree?: WorktreeRecipe;
  /** The repo's hook points (`hooks:`), the main checkout's: its `worktree-setup` among them. */
  hooks?: RepoHooks;
  /** The checkout is in local mode: the sources' writing tools denied. */
  local?: boolean;
  /** The checkout's board is read-only (`boardReadOnly`): Azure Boards' writes denied. */
  boardReadOnly?: boolean;
  /** The checkout's board's kind: a card of a board on this machine is named `L-<id>`. */
  board?: Pick<BoardRef, 'provider'>;
};

/** The kind of the board `repo`'s settings name: Azure Boards when none is read. */
export const boardKindIn = (
  ctx: Pick<SessionCtx, 'settings'>,
  repo: string,
): Pick<BoardRef, 'provider'> => {
  const board = boardOf(ctx.settings?.at(repo).values.board);

  return board.ok && board.board.provider !== undefined ? { provider: board.board.provider } : {};
};

/**
 * `allowedModels`, `skillsOnTop`, `setup`, `sources` and local mode in force in `repo` (core's
 * defaults without settings): read in the checkout, never a worktree the agent writes.
 */
export const launchSettings = (ctx: Pick<SessionCtx, 'settings'>, repo: string): LaunchSettings => {
  const values = ctx.settings?.at(repo).values;

  return {
    allowedModels: values?.allowedModels ?? SETTINGS.allowedModels.default,
    skillsOnTop: values?.skillsOnTop ?? SETTINGS.skillsOnTop.default,
    sessionMcp: values?.['session.mcp'] ?? SETTINGS['session.mcp'].default,
    setup: values?.setup ?? SETTINGS.setup.default,
    effort: values?.effort ?? SETTINGS.effort.default,
    subagentsMax: values?.['subagents.max'] ?? SETTINGS['subagents.max'].default,
    models: {
      coordinator: values?.['models.coordinator'] ?? SETTINGS['models.coordinator'].default,
      reader: values?.['models.reader'] ?? SETTINGS['models.reader'].default,
      writer: values?.['models.writer'] ?? SETTINGS['models.writer'].default,
    },
    // the team's, as the main checkout has them: never a worktree's copy an agent writes
    sources:
      ctx.settings?.at(mainCheckout(repo) ?? repo).values.sources ?? SETTINGS.sources.default,
    worktree:
      ctx.settings?.at(mainCheckout(repo) ?? repo).values.worktree ?? SETTINGS.worktree.default,
    hooks: repoHooksIn(ctx.settings?.at(mainCheckout(repo) ?? repo).values ?? {}),
    // `abe local on` names the checkout by its real path; a launch's `repo` may not be one.
    local: [repo, realPath(repo)].some(
      (at) => localCheckoutOf(values?.localMode ?? [], at) !== undefined,
    ),
    boardReadOnly: [repo, realPath(repo)].some(
      (at) =>
        localCheckoutOf(values?.boardReadOnly ?? SETTINGS.boardReadOnly.default, at) !== undefined,
    ),
    board: boardKindIn(ctx, repo),
  };
};

/**
 * A prototype session's launch settings (#350):
 * `prototype.model` for it and its subagents, `prototype.effort`, held to allowedModels (one it
 * leaves out falls to the first allowed, `runsOn.fellBack` in words).
 */
export const prototypeLaunchSettings = (
  ctx: Pick<SessionCtx, 'settings'>,
  repo: string,
): { at: LaunchSettings; runsOn: ReturnType<typeof prototypeModel> } => {
  const values = ctx.settings?.at(repo).values;
  const at = launchSettings(ctx, repo);
  const runsOn = prototypeModel({
    'prototype.model': values?.['prototype.model'] ?? SETTINGS['prototype.model'].default,
    'prototype.effort': values?.['prototype.effort'] ?? SETTINGS['prototype.effort'].default,
    allowedModels: at.allowedModels,
  });
  const model = runsOn.model;

  // its subagents on its model too: nothing in it runs on opus unless /model says so
  return {
    at: {
      ...at,
      effort: runsOn.effort,
      models: { coordinator: model, reader: model, writer: model },
    },
    runsOn,
  };
};

export type Sessions = {
  launch: (
    /** Null only with `extras.abe` or `extras.code`: the Abe chat or a prototype with no card. */
    card: Pick<CardDetail, 'id' | 'title' | 'description' | 'acceptanceCriteria'> | null,
    repo: string,
    reach: Record<string, string>,
    /** The settings in force in `repo` that shape the launch. */
    at: LaunchSettings,
    extras?: LaunchExtras,
  ) => Promise<Outcome<SessionData>>;
  /** Where a known session stands now, as last heard (no look at its `claude`). */
  peek: (id: string) => SessionState | undefined;
  /** Every session known, or only `only`; a non-ended one whose `claude` is gone is ended first. */
  list: (only?: string) => Promise<Outcome<SessionData[]>>;
  get: (id: string) => Promise<Outcome<SessionData>>;
  /**
   * One hook stepped and kept once, its payload as parsed from its JSON. `answer`: one serve
   * answers itself (allowed for the session), its state kept; the cards made of its payload
   * (`HookInput`'s: `held` a PermissionRequest held for its card, so not answered by 2.0's rules).
   * `cleared`: the cards it left answered outside Chat.
   */
  hook: (
    id: string,
    event: string,
    doc: unknown,
    o?: { answer?: PermissionAnswer } & Partial<
      Pick<HookInput, 'asked' | 'dialog' | 'held' | 'holding'>
    >,
  ) => Outcome<{ state: SessionState; answer?: PermissionAnswer; cleared: string[] }>;
  /** One input that is not a hook stepped and kept once (`sessionStep`); undefined for none. */
  step: (id: string, input: SessionInput) => SessionMeta | undefined;
  /**
   * Its own agent was stopped mid-turn at `at` (Esc in its Claude Code, read from its transcript:
   * no hook comes): a session working since before then waits on you, as after a Stop; one
   * waiting on a dialog then (Esc on it) waits on your turn.
   */
  interrupted: (id: string, at: string) => void;
  /** The session's meta changed by `change` and kept (its cards, Overrides: #114); undefined for none. */
  amend: (id: string, change: (meta: SessionMeta) => SessionMeta) => SessionMeta | undefined;
  /**
   * Types `text` in now, whatever the session does (a run's checks' output): never queued, but
   * after any paste before it (`queue.ts`' one paste at a time).
   */
  send: (id: string, text: string) => Promise<Outcome<null>>;
  /**
   * The environments a checkout's agents reach may have changed (ADR 0029, `agents.<env>`): each
   * live local session launched on others is told its sandbox stays as it was, to finish its
   * turn and write a handoff; a new session starts with the new ones. The ids told.
   */
  envsChanged: () => Promise<string[]>;
  /**
   * A person's message with its implicit context (#115, `queue.ts`): typed in now, mid-turn too
   * (#197); held while the session takes no keys (`queued` its `n`, `held` why).
   */
  message: SessionQueue['message'];
  unqueue: (id: string, n: number) => Outcome<QueuedRow[]>;
  /**
   * A question or grill card's answer (#114, `queue.ts`): typed in now with the queue after it,
   * as one prompt (the queue waited for it).
   */
  answer: (id: string, prompt: string) => Promise<Outcome<{ prompt: string }>>;
  /** Once what is being typed into the session is in, at most `ms` (`queue.ts` `typed`). */
  typed: SessionQueue['typed'];
  /** Claude Code's own dialog answered by its Esc from Chat (`queue.ts` `escaped`). */
  escaped: SessionQueue['escaped'];
  /**
   * Keys pressed in the session's terminal as `keysFor` reads what it shows now (Claude Code's
   * own dialog answered from Chat); `false`: `keysFor` found nothing to press.
   */
  press: (
    id: string,
    keysFor: (screen: string) => readonly string[] | undefined,
  ) => Promise<Outcome<boolean>>;
  /** `/model` (and `/effort`) typed in, held to `allowed` and the launch's `allowedModels`. */
  model: (
    id: string,
    ask: { model: string; effort?: Effort; allowed: readonly string[] },
  ) => Promise<Outcome<SessionModelData>>;
  attach: (id: string) => Outcome<string[]>;
  /** What VimStorm runs to open its worktree (#74): plain argv on this Mac; an ended one too. */
  attachSpec: (id: string) => Outcome<AttachSpec>;
  stop: (id: string) => Promise<Outcome<SessionData>>;
  /**
   * The session moved away (#88, Move to cloud): its `claude` stopped, it ended (`moved`) and is
   * kept as history only, its worktree as it was.
   */
  moveOut: (id: string, moved: Moved) => Promise<Outcome<SessionMeta>>;
  /**
   * What a launch of a moved session (#88, `id` its own, resumed) on `card` in `repo` would be
   * refused for (`card-has-session`, `session-exists`), before anything is stopped or copied.
   */
  admit: (card: number, repo: string, id: string, resume: boolean) => Outcome<null>;
  /** A session marked moved whose move failed after all (#88): this Mac's again, as it ended. */
  unmove: (id: string) => void;
  /** How many have not ended. */
  open: () => number;
  /** What `serve` keeps of the session now (no look at the runner); undefined for none. */
  metaOf: (id: string) => SessionMeta | undefined;
  /**
   * A local session's fence (#181): where its file tools write and the hosts WebFetch reaches, as
   * real paths; undefined for a workspace's (its container is its boundary) or one unknown.
   */
  fence: (id: string) => SessionFence | undefined;
  /**
   * The `ABE_*` values the session was started with, when this `serve` launched it (they are
   * never written to disk); undefined for one launched by an earlier `serve`.
   */
  launchedWith: (id: string) => Readonly<Record<string, string>> | undefined;
  /** Before's worktree for the session's card: the merge base of its branch and the default. */
  baseWorktree: (
    id: string,
  ) => Promise<Outcome<{ path: string; base: string; branch: string; against: string }>>;
  /**
   * The repo's Abe chat (its main checkout `repo`): the one running, else the one last started,
   * reopened or shown in Chat (`abe chat --shown`); undefined: none yet.
   */
  hub: (repo: string) => SessionMeta | undefined;
  /** Every Abe chat conversation of the repo, ended ones too. */
  hubs: (repo: string) => SessionMeta[];
  /** Its sessions run on this Mac, in its sandbox (an Ask's, #346): not a workspace's. */
  onTheMac: () => boolean;
  /** Stops listening on the sessions' sockets; the sessions themselves keep running. */
  close: () => Promise<void>;
};

const data = (m: SessionMeta): SessionData => ({
  id: m.id,
  card: m.card,
  prototype: m.prototype,
  ...(m.abe === undefined || m.abe === null ? {} : { abe: m.abe }),
  kind: m.kind,
  title: m.title,
  repo: m.repo,
  worktree: m.worktree,
  branch: m.branch,
  state: m.state,
  since: m.since,
  startedAt: m.startedAt,
  transcriptPath: m.transcriptPath,
  lastAssistantMessage: m.lastAssistantMessage,
  models: m.models,
  subagents: m.subagents,
  reason: m.reason,
  stopped: m.stopped,
  ...(m.factory === true ? { factory: true as const } : {}),
  setup: m.setup,
  ...(m.base === undefined ? {} : { base: m.base }),
  ...(m.sourcesMissing === undefined ? {} : { sourcesMissing: m.sourcesMissing }),
  skillsOnTop: m.skillsOnTop,
  browserProfile: m.browserProfile,
  ...(m.prodOn === true ? { prodOn: true as const } : {}),
  overrides: m.overrides,
  queue: m.queue.map(({ n, text }) => ({ n, text })),
  model: m.model,
  effort: m.effort,
  launch: null,
  ...(m.note === null || m.note === undefined ? {} : { note: m.note }),
  ...(m.standing === undefined || m.standing.length === 0 ? {} : { standing: m.standing }),
  reopened: m.reopened,
  rounds: m.rounds,
  waitingOn: m.waitingOn,
  ...(m.turnEnded === true ? { turnEnded: true as const } : {}),
});

/** A record without its Factory mark (`factory`), which a reopen sets again only for a run that goes on. */
const withoutFactory = (m: SessionMeta): SessionMeta => {
  const copy = { ...m };

  delete copy.factory;

  return copy;
};

/** An environment without `DATABASE_URL`: serve's own is never a local session's (#349). */
const withoutDatabase = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== WORKSPACE_DATABASE));

/** A session id: the card and four hex digits (`4-a1b2`). */
// a card's (`4-a1b2`), or a chat's by its kind (`prototype-9c58`: a prototype chat reopens, #350;
// `abe-9c58`: the Abe chat starts again on its kind's settings)
const SESSION_ID = /^([1-9][0-9]*|prototype|abe|proto-[0-9a-f]{6})-[0-9a-f]{4}$/;

/** What a live session is told when its checkout's agent environments change (ADR 0029). */
export const envsChangedWords = (was: readonly AbeEnv[], now: readonly AbeEnv[]): string =>
  `The environments agents reach in this repo changed: from ${was.join(', ') || 'none'} to ${now.join(', ') || 'none'}. This session keeps the sandbox it started with. Finish this turn, then write a handoff (what is done, what is next, what to check) to .scratch/handoff.md and say so; a new session starts with the new environments.`;

/** A launch's settings with the extras' keys over them (a box's: the sandbox). */
const merged = (a: ClaudeSettings, b: ClaudeSettings | undefined): ClaudeSettings =>
  b === undefined ? a : { ...a, ...b };

/**
 * Paths kept from the session's commands by its sandbox, when it has one: aws's folder while aws
 * is off (git never reads it), the never-read ones. None: as it is.
 */
const withDenyRead = (paths: readonly string[], s: ClaudeSettings): ClaudeSettings => {
  const fs = s.sandbox?.filesystem;

  return paths.length === 0 || s.sandbox === undefined || fs === undefined
    ? s
    : {
        ...s,
        sandbox: {
          ...s.sandbox,
          filesystem: { ...fs, denyRead: [...(fs.denyRead ?? []), ...paths] },
        },
      };
};

/** Rules asked each time, beside the settings' own. */
const withAsk = (s: ClaudeSettings, ask: readonly string[]): ClaudeSettings =>
  ask.length === 0
    ? s
    : { ...s, permissions: { ...s.permissions, ask: [...(s.permissions?.ask ?? []), ...ask] } };

export const startSessions = async (o: SessionsOptions): Promise<Sessions> => {
  /** A local session's own temp folder, under the Mac's (real: the sandbox matches real paths). */
  const tmpOf = (id: string) => sessionTmp(realPath(o.env.TMPDIR ?? '/tmp'), id);
  const known = new Map<string, SessionMeta>();
  /** The environments each local session was launched reaching (ADR 0029). */
  const reaching = new Map<string, readonly AbeEnv[]>();
  /** The environments a checkout's agents reach; none told: dev and test. */
  const agentEnvsOf = (repo: string): readonly AbeEnv[] =>
    o.facts?.(repo).agentEnvs ?? ['dev', 'test'];
  /** Where az keeps your login for a checkout, when not `~/.azure`: never read by a session. */
  const azFolderOf = (repo: string): string | undefined => {
    const az = o.facts?.(repo).azFolder;

    return az?.from === 'checkout' ? az.dir : undefined;
  };
  const listening = new Map<string, Listener>();
  /** Launched but not yet started by the runner: not "gone" while the runner works. */
  const starting = new Set<string>();
  /** Sessions starting whose `claude` has run a hook already: no start timeout for them. */
  const hooked = new Set<string>();
  /**
   * Launched by this serve, their `claude` not taking keys yet (#197): no hook yet, or, launched
   * with a prompt, only its start's (Claude Code 2.1.310 keeps keys typed before it takes that
   * prompt for after the whole turn, not for its next step). A restarted serve counts one that
   * has no transcript yet (no hook heard), until any hook. Each one's value: whether its launch
   * gave a prompt.
   */
  const unheard = new Map<string, boolean>();
  /** Each session's `ABE_*` values as launched by this serve: kept in memory only, for redaction. */
  const abeValues = new Map<string, Record<string, string>>();
  /**
   * Reopened with no prompt (#343): its `claude` opens on its conversation and waits there, so its
   * start's hooks mean waiting on you (no Stop comes), until any other hook.
   */
  const quiet = new Set<string>();
  /**
   * The real `HOME` each local session's boundary was given at launch by this serve: its fence's
   * caches and plan files are under it (one launched before: serve's own).
   */
  const fenceHomes = new Map<string, string>();
  const stamp = () => new Date(o.clock.now()).toISOString();

  const unknown = (id: string) => refused('no-session', `no session ${id}`);

  const keep = (meta: SessionMeta) => {
    known.set(meta.id, meta);
    if (!starting.has(meta.id)) writeSessionMeta(o.stateDir, meta);
  };

  /** The repo's Abe chat conversations, in the order they were known. */
  const hubsOf = (repo: string): SessionMeta[] => {
    const top = realPath(repo);

    return [...known.values()].filter(
      (m) => m.abe !== undefined && m.abe !== null && realPath(m.abe.repo) === top,
    );
  };

  const move = (
    meta: SessionMeta,
    state: SessionState,
    cause: string,
    reason?: string,
  ): SessionMeta => {
    if (meta.state === state) return meta;
    const since = stamp();
    // what it waits on is said with its move (`waitingOn`, set before it), none once it moved on
    const waitingOn = state === 'waiting' ? meta.waitingOn : null;
    const next = { ...meta, state, since, waitingOn, ...(reason === undefined ? {} : { reason }) };

    // While it starts, its launch event (with the state reached by then) is the first one.
    if (!starting.has(meta.id))
      o.emit({
        id: meta.id,
        card: meta.card,
        state,
        since,
        cause,
        ...(reason === undefined ? {} : { reason }),
        ...(state === 'waiting' ? { waitingOn } : {}),
        ...(next.turnEnded === true ? { turnEnded: true as const } : {}),
      });

    return next;
  };

  const unlisten = async (id: string) => {
    const listener = listening.get(id);

    listening.delete(id);
    await listener?.close();
  };

  const end = async (meta: SessionMeta, cause: string, reason?: string) => {
    keep(move(meta, 'ended', cause, reason));
    await unlisten(meta.id);
    rmSync(tmpOf(meta.id), { recursive: true, force: true });
  };

  /**
   * Ends every session whose `claude` ran no hook by its start timeout (a settings error dialog,
   * an old `claude`): its terminal read and stopped, the session ended with `noStartReason`.
   */
  const overdue = async () => {
    const now = o.clock.now();

    for (const meta of [...known.values()])
      if (!starting.has(meta.id) && startOverdue(meta, now)) {
        // What it stopped at (#190), read before its terminal goes.
        const shown = await o.runner.screen(meta.id);

        // Not stopped (tmux failing): tried again on the next look.
        if (!(await o.runner.stop(meta.id)).ok) continue;
        const was = known.get(meta.id) ?? meta;

        if (startOverdue(was, now))
          await end(
            { ...was, startBy: null },
            'no-start',
            noStartReason(shown.ok ? shown.data : undefined),
          );
      }
  };

  /** Ends every open session whose `claude` never started, or that the runner no longer has. */
  const settle = async (): Promise<Outcome<null>> => {
    await overdue();
    const running = await o.runner.running();

    if (!running.ok) return refused(running.error.code, running.error.message);
    const alive = new Set(running.data);

    for (const meta of [...known.values()])
      if (meta.state !== 'ended' && !starting.has(meta.id) && !alive.has(meta.id))
        // Its claude went away with no SessionEnd (#343): it crashed, and says so.
        await end(meta, 'gone', CRASHED);

    return { ok: true, data: null };
  };

  /** `<card>-a1b2`, or a chat's `abe-a1b2` / `prototype-a1b2`. */
  const newId = (prefix: string) => {
    for (;;) {
      const id = `${prefix}-${randomBytes(2).toString('hex')}`;

      if (!known.has(id) && !sessionKnown(o.stateDir, id)) return id;
    }
  };

  // A restarted serve: every session it kept, listening again on the running ones' sockets.
  for (const doc of readSessionMetas(o.stateDir)) {
    const meta = SessionMeta.safeParse(doc);

    // An earlier serve's launch: its hooks may have come while no serve listened, so no start
    // timeout is held against it.
    // a kind 3.3 has no more (an Ask, an Improve or retro chat, an install's): left on disk unread
    if (!meta.success || (meta.data.kind === 'card' && meta.data.card === null)) continue;
    known.set(meta.data.id, { ...meta.data, startBy: null });
    // No hook ever heard (no transcript yet): its claude may still be starting, or in a dialog.
    if (meta.data.transcriptPath === null && meta.data.state !== 'ended')
      unheard.set(meta.data.id, false);
  }
  // When the runner cannot say which still run, every open one is listened to: none goes deaf.
  await settle();
  const listenTo = (meta: SessionMeta) =>
    o.listen(meta.socket, meta.id, o.runner.socket(meta.id).mode);

  for (const meta of known.values())
    if (meta.state !== 'ended') listening.set(meta.id, await listenTo(meta));
  let looking: Promise<void> | undefined;
  const timer = setInterval(() => {
    looking ??= overdue()
      // defined below, once the queue is: the timer's first look comes after
      .then(() => tellSilent())
      .catch((err: unknown) => {
        o.log(
          `the look for sessions that never started failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        looking = undefined;
      });
  }, START_CHECK_MS);

  /** What a launch is refused for before anything starts: the card's open session, the id taken. */
  const admit = (
    card: number | null,
    repo: string,
    id: string | undefined,
    resume: boolean,
    /** A developer's prototype (#83) and a card's session never hold each other up. */
    kind: 'card' | 'prototype' = 'card',
  ): Outcome<null> => {
    const busy =
      card === null
        ? undefined
        : [...known.values()].find(
            (m) =>
              m.card === card &&
              m.repo === repo &&
              m.state !== 'ended' &&
              (m.kind === 'prototype') === (kind === 'prototype'),
          );

    if (busy !== undefined)
      return refused('card-has-session', cardHasSession(busy.card ?? '?', busy.id, repo));
    if (id !== undefined && !SESSION_ID.test(id))
      return refused('usage', `not a session id (4-a1b2): ${id}`, 2);
    // A session that moved away from here may come back (#88): one marked moved, or, moved
    // back onto a box that had it, one that ended there (a download stopped it).
    const had = id === undefined ? undefined : known.get(id);
    const wasMoved = had !== undefined && (had.moved !== null || (resume && had.state === 'ended'));

    if (id !== undefined && !wasMoved && (known.has(id) || sessionKnown(o.stateDir, id)))
      return refused('session-exists', `session ${id} exists already`);

    return { ok: true, data: null };
  };

  /**
   * One input stepped (`sessionStep`) and applied: its moves said before the meta is kept (a
   * reader of the state it moved from still sees it), kept once, then the rest said. An input
   * that changes nothing keeps nothing. Undefined for a session not known.
   */
  const step = (id: string, input: SessionInput): SessionMeta | undefined => {
    const meta = known.get(id);

    if (meta === undefined) return undefined;
    const { meta: next, events } = sessionStep(meta, input);

    if (next === meta) return meta;
    for (const e of events) if (e.type === 'session.state') o.emit(e.data);
    keep(next);
    for (const e of events)
      if (e.type === 'session.subagent') o.emitSubagent(e.data);
      else if (e.type === 'session.answered') o.emitAnswered?.(e.data);
      else if (e.type === 'session.ask') o.emitAsk?.(e.data);

    return next;
  };

  /** Claude Code's dialog gone with no hook (answered by its Esc, its turn stopped). */
  const undialog = (id: string) => {
    step(id, { kind: 'dialog-gone', at: stamp() });
  };

  const queue = sessionQueue({
    meta: (id) => known.get(id),
    starting: (id) => starting.has(id) || unheard.has(id),
    keep,
    undialog,
    clock: o.clock,
    runner: o.runner,
    ...(o.pick === undefined ? {} : { pick: o.pick }),
    emitQueued: (data) => o.emitQueued?.(data),
    emitModel: (data) => o.emitModel?.(data),
    log: o.log,
  });

  /** A card's subagent silent with no hand-back: its coordinator is told once, not left waiting. */
  const tellSilent = async () => {
    const now = o.clock.now();

    for (const meta of [...known.values()]) {
      if (meta.state === 'ended' || meta.card === null) continue;
      const silent = silentSubagents(meta.subagents, new Date(now).toISOString());

      if (silent.length === 0) continue;
      const told = await queue.type(meta.id, silent.map(silentSubagentPrompt).join('\n'));

      if (!told.ok) continue;
      const was = known.get(meta.id) ?? meta;

      keep({
        ...was,
        subagents: was.subagents.map((r) =>
          silent.some((x) => x.id === r.id) ? { ...r, silentTold: true } : r,
        ),
      });
    }
  };

  // A turn that ended while no serve listened: its queue goes now.
  for (const id of known.keys()) void queue.deliver(id);

  return {
    launch: async (
      card,
      repo,
      reach,
      {
        allowedModels,
        skillsOnTop,
        sessionMcp,
        setup,
        effort,
        subagentsMax,
        models: wants,
        sources: entries = [],
        hooks = DEFAULT_HOOKS,
        local: localAsked = false,
        boardReadOnly: boardAsked = false,
        board: boardKind = {},
      },
      extras = {},
    ) => {
      // The Abe chat: no card, the main checkout its folder.
      const chat = extras.abe;

      if (card === null && chat === undefined && extras.code === undefined)
        return refused('usage', 'a session is on a card, a prototype or the Abe chat', 2);
      // A local session's boundary is macOS's sandbox: Linux's cannot single out its own socket.
      const plugins = o.runner.plugins;

      if (plugins !== undefined && process.platform !== 'darwin')
        return refused('no-sandbox', 'local sessions run only on macOS, where their sandbox holds');
      // A reopen (#343): an ended session of this serve's, never one that moved away.
      const was = extras.reopen === true ? known.get(extras.id ?? '') : undefined;
      /** A reopen with no conversation to resume (#355): a new claude conversation on its record. */
      const anew = was?.transcriptPath === null;

      if (extras.reopen === true) {
        if (was === undefined) return unknown(extras.id ?? '');
        if (was.state !== 'ended' || starting.has(was.id))
          return refused(
            'not-ended',
            `session ${was.id} is ${was.state}: attach it (abe session attach ${was.id})`,
          );
        // no hook ever heard: Claude Code kept no conversation to go back into; a chat (a
        // prototype chat, #355) starts a new one in its folder, a card's session is refused
        if (was.transcriptPath === null && chat === undefined && extras.code === undefined)
          return refused(
            'no-conversation',
            `session ${was.id} never started a conversation (its claude ran no hook): Retry run starts its card again`,
          );
        if (was.moved !== null)
          return refused(
            'session-moved',
            `session ${was.id} moved to ${was.moved.where}: reopen it there`,
          );
      }
      const admitted = admit(
        card?.id ?? null,
        repo,
        extras.id,
        extras.resume !== undefined || extras.reopen === true,
        extras.code === undefined ? 'card' : 'prototype',
      );

      if (!admitted.ok) return admitted;
      const kind = extras.abe === undefined ? 'prototype' : 'abe';
      const id = extras.id ?? newId(card === null ? kind : String(card.id));
      const sockets = o.runner.socket(id);
      const socket = sockets.listen;
      const env =
        extras.env?.({
          socket: sockets.session,
          bin: o.runner.bin,
          ...(o.runner.home === undefined ? {} : { home: o.runner.home }),
          ...(o.runner.user === undefined ? {} : { user: o.runner.user }),
        }) ?? sessionEnv({ parent: o.env, bin: o.runner.bin, socket: sockets.session, reach });

      if (!env.ok) return refused(env.code, env.message);
      // Local mode (#24): nothing of the session's own leaves this Mac but its reads.
      const localMode = localAsked || o.facts?.(repo).localMode !== undefined;
      // Your gh login there: the session's gh goes as it, never printed or logged (redacted). In
      // local mode it gets none: Abe reads GitHub for it.
      const gh = localMode ? undefined : await o.githubToken?.(repo);

      if (gh?.ok === false) return refused('github-account', gh.error.message);
      if (gh?.ok === true) env.env.GH_TOKEN = gh.data;
      // A local session's jail (ADR 0029): every one on this Mac but the Abe chat, which runs as
      // the person's own Claude Code while they are there: no Seatbelt, no fence.
      const jail = plugins !== undefined && extras.abe === undefined;

      // A jailed session's claude: its hook refuses a fenced tool serve could not check (#181).
      if (jail) env.env[FENCE_ENV] = '1';
      // A stalling MCP server gives up in 15 s, inside serve's 60 s wait for the first hook.
      env.env[MCP_START_TIMEOUT_ENV] = String(MCP_START_TIMEOUT_MS);

      if (localMode) Object.assign(env.env, LOCAL_MODE_ENV);
      const guards = card !== null && localMode ? await o.localGuards?.(repo) : undefined;
      // What it reaches (ADR 0029): the enabled environments in full, the others not at all: no
      // secret of theirs (their Abe env files, the repo env files feeding only them, aws keys)
      // reaches it. The network is open: without a secret, an off environment's system takes nothing.
      const top = realPath(repo);
      const enabled = withOwnReach(agentEnvsOf(repo), extras.prodOn === true);
      const repoFiles = (await o.offRepoEnvFiles?.(repo, enabled)) ?? [];
      const others = (o.facts?.(repo).yourCheckouts ?? []).map(realPath).filter((c) => c !== top);

      if (jail && extras.env === undefined) reaching.set(id, enabled);
      const awsOff = guards?.awsOff === true;
      // A local session's shell reaches no profile of ~/.aws, whatever is enabled (ADR 0029): aws
      // only through the short-lived keys abe run and the checks hand an enabled environment.
      const ownShell = jail && extras.env === undefined;

      if (awsOff || ownShell) env.env = awsOffEnv(env.env, awsOffFile(o.stateDir));
      // A card's session (a Factory run's too), an install's and a box's: Abe's own servers
      // alone, and the repo's sources. A chat of the person's takes `session.mcp`. A repo's
      // `.mcp.json` never loads in any (`claudeArgv`).
      const runMcp =
        plugins === undefined ||
        card !== null ||
        extras.abe !== undefined ||
        extras.browser === true ||
        extras.mcpConfig !== undefined;
      // On this Mac (ADR 0031): the repo's sources:, each with its definition there (a bare
      // name's from the person's Claude Code), loaded through the config Abe generates.
      const named = entries.map(sourceName);
      // Only those the install checked (`checkedSources`): an unchecked server, one never signed
      // in or down, never starts in it; the session is told it was not checked.
      const all =
        runMcp && o.runner.sourceServers !== undefined
          ? o.runner.sourceServers({ repo, sources: entries, home: env.env.HOME ?? '/' })
          : undefined;
      const checked =
        all === undefined ? [] : (extras.checkedSources ?? (await o.checkedSources?.(repo)) ?? []);
      const unchecked = all?.loaded.filter((n) => !checked.includes(n)) ?? [];
      const found =
        all === undefined
          ? undefined
          : {
              ...all,
              // each `${VAR}` of theirs filled from the person's values, in the config alone
              servers: withSourceValues(
                Object.fromEntries(
                  Object.entries(all.servers).filter(([n]) => checked.includes(n)),
                ),
                sourceValuesAt(mainCheckout(repo) ?? repo),
              ),
            };
      const sources =
        found === undefined ? named : [...new Set([...found.loaded, ...named, ...found.withheld])];
      // Its servers are Abe's and the sources: a source's sign-in is the person's, never its own
      // (its hook refuses Claude Code's authenticate tool): the install page's, else Settings'.
      if (runMcp) env.env[SIGN_IN_ON_PAGE_ENV] = extras.abe === undefined ? 'settings' : 'install';
      const boundaryHome = realPath(env.env.HOME ?? '/');
      // A local session's own temp folder: its TMPDIR, apart from other sessions'.
      const tmp = plugins !== undefined && extras.env === undefined ? tmpOf(id) : undefined;

      if (tmp !== undefined) {
        mkdirSync(tmp, { recursive: true, mode: 0o700 });
        for (const name of TMP_NAMES) env.env[name] = tmp;
      }
      // A new local card session whose repo needs node it would not run (#145): said before
      // anything starts, with the fix, not as a setup and checks failing `command not found`. A
      // session coming back (moved, resumed) is not held up: its box's end is stopped already.
      const fresh = extras.id === undefined && extras.resume === undefined;

      if (card !== null && plugins !== undefined && extras.env === undefined && fresh) {
        const path = env.env.PATH ?? '';
        const noNode = nodeAtLaunch({
          packageJson: existsSync(join(repo, 'package.json')),
          bunLock: ['bun.lock', 'bun.lockb'].some((f) => existsSync(join(repo, f))),
          setup,
          node: await nodeThatRuns(env.env),
          managers: foundManagers(o.env, env.env.HOME ?? '/'),
          path,
        });

        if (noNode !== null) return refused(noNode.code, noNode.message);
      }
      // A local session never gets serve's own DATABASE_URL (#349): a card session gets its own.
      if (plugins !== undefined && extras.env === undefined) env.env = withoutDatabase(env.env);
      // A local card session's tests get the memory the repo's CI gives them.
      const nodeOptions =
        card !== null && plugins !== undefined && extras.env === undefined
          ? o.nodeOptions?.(repo)
          : undefined;

      if (nodeOptions !== undefined && nodeOptions !== null) env.env.NODE_OPTIONS = nodeOptions;
      // started again too: its runner repairs the team's files the worktree lacks
      const copy =
        card !== null && plugins !== undefined && extras.env === undefined
          ? ((await o.worktreeCopies?.(repo, enabled)) ?? [])
          : [];
      // A local card session's database (#146, #349): its repo's hook's or its own Mac database.
      const local = card !== null && plugins !== undefined && extras.env === undefined;
      const db = local ? await o.database?.start({ id, repo }) : undefined;

      // Without Docker a Factory run is refused (its checks and verify need a database); any
      // other session runs without one and is told so.
      if (
        db !== undefined &&
        !db.ok &&
        (db.error.code !== NO_DOCKER || (extras.factory === true && fresh))
      )
        return db;
      if (db?.ok === true && db.data !== undefined) env.env[WORKSPACE_DATABASE] = db.data;
      const dbStarted = db?.ok === true && db.data !== undefined;
      const noDatabase = db !== undefined && !db.ok;
      const mcp =
        local && extras.browser === true && extras.mcpConfig === undefined
          ? await o.browsers?.launch(id, env.env.PATH ?? '')
          : undefined;
      const mcpMode: SessionMcp = runMcp ? 'abe-only' : sessionMcp;
      const now = stamp();
      const models = sessionModels(allowedModels, wants);
      // A run's or a box's runner says it, once it knows which sources loaded (`sourcesTold`).
      const sourcesToRunner = runMcp && sources.length > 0;
      const sourcesTold = sourcesToRunner ? null : sourcesLine(sources);
      // told only of the Abe env files it has (a local worktree links the enabled ones'; the
      // Abe chat's main checkout has all three; a box's clone has the ones the Mac synced)
      const localEnvFiles =
        extras.envFiles === undefined && (card !== null || extras.abe !== undefined)
          ? ((await o.abeEnvFiles?.(repo, extras.abe === undefined ? enabled : ABE_ENVS)) ?? [])
          : [];
      const keysTold =
        extras.envFiles === undefined
          ? abeEnvLine(localEnvFiles, 'local')
          : abeEnvLine(extras.envFiles, 'box');
      const drafted: Omit<SessionMeta, 'kind'> = {
        v: 1,
        id,
        card: card?.id ?? null,
        prototype: extras.code?.of ?? null,
        ...(extras.abe === undefined ? {} : { abe: extras.abe.of }),
        title: card?.title ?? chat?.title ?? extras.code?.title ?? '',
        repo,
        worktree: chat?.folder ?? '',
        // a prototype with no card: its own branch, its worktree made already
        branch:
          card === null
            ? (extras.branch ?? '')
            : (extras.branch ?? cardBranch(String(card.id), card.title)),
        // #190: starting until its claude runs a hook (a dialog before them never says working).
        state: 'starting',
        since: now,
        startedAt: now,
        transcriptPath: null,
        lastAssistantMessage: null,
        models,
        subagents: [],
        reason: null,
        stopped: false,
        ...(extras.factory === true ? { factory: true as const } : {}),
        setup: null,
        skillsOnTop,
        browserProfile: extras.browserProfile ?? DEFAULT_PROFILE,
        ...(extras.prodOn === true ? { prodOn: true as const } : {}),
        claudeSession: extras.resume?.claudeSession ?? randomUUID(),
        socket,
        allowedModels: [...allowedModels],
        agentCalls: [],
        startBy: null,
        moved: null,
        // A Factory run in a workspace: nobody at its prompts, so its hook answers them.
        unattended: extras.unattended === true && extras.managed !== undefined,
        overrides: [],
        asks: [],
        allowed: [],
        model: models.coordinator,
        effort: extras.resume === undefined ? (effort ?? null) : null,
        launch: null,
        reopened: [],
        rounds: 0,
        queue: [],
        queueNext: 1,
        waitingOn: null,
        note: extras.note ?? null,
        standing: [...(extras.standing ?? [])],
      };
      // A reopen keeps its record (#343): its id, start, transcript, subagents and asks go on;
      // what this launch decides (its socket, models, state) is new. Its Overrides ended with it.
      const reopened: SessionMeta | undefined =
        was === undefined
          ? undefined
          : {
              ...withoutFactory(was),
              // the Abe chat started again on its kind's settings says the ones it has now
              ...(extras.abe === undefined ? {} : { abe: extras.abe.of }),
              // a Factory run again only when this launch says (a run over is a conversation)
              ...(extras.factory === true ? { factory: true as const } : {}),
              state: 'starting',
              since: now,
              reason: null,
              stopped: false,
              claudeSession: anew
                ? randomUUID()
                : (claudeSessionOf(was.transcriptPath) ?? was.claudeSession),
              socket,
              models,
              allowedModels: [...allowedModels],
              model: models.coordinator,
              skillsOnTop,
              browserProfile: extras.browserProfile ?? was.browserProfile,
              // what it asked and ran before it ended is over: nothing waits on it now
              asks: [],
              subagents: was.subagents.map((r) =>
                r.state === 'running' ? { ...r, state: 'done' as const, endedAt: now } : r,
              ),
              startBy: null,
              overrides: [],
              agentCalls: [],
              queue: [],
              waitingOn: null,
              launch: null,
              // the conversation keeps its own effort, as a resume does; a new one this launch's
              effort: anew ? (effort ?? was.effort) : was.effort,
              reopened: [...was.reopened, now],
            };
      const meta: SessionMeta = reopened ?? withKind(drafted);
      // every tool of every source allowed, writes too; the only denies the Abe env files of the
      // environments that are off, in its checkout and worktree (a box's, as its container has
      // them), and secret output (ADR 0029). The install's own session writes all three files
      // (Env files): their hosts stay out all the same.
      const access = accessRules({
        servers: sources,
        enabled,
        trees:
          extras.abe !== undefined
            ? []
            : (extras.trees ?? [
                top,
                ...(meta.branch === '' ? [] : [worktreePath(top, meta.branch)]),
              ]),
        ...(extras.abe === undefined ? { repoFiles } : {}),
        others: extras.trees === undefined ? others : [],
      });

      const launchedPrompt =
        extras.prompt ??
        (card === null
          ? ''
          : launchPrompt(
              { ...card, board: boardKind },
              { note: extras.note, standing: extras.standing },
            ));

      // A reopen: the listener its SessionEnd left open goes first, else its own socket answers.
      if (was !== undefined) await unlisten(id);
      // Listening before claude starts, so its first hook is heard.
      starting.add(id);
      if (was !== undefined && launchedPrompt === '') quiet.add(id);
      unheard.set(id, launchedPrompt !== '');
      if (jail) fenceHomes.set(id, boundaryHome);
      known.set(id, meta);
      const listener = await listenTo(meta).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err)),
      );

      // Not listening: never left starting (hidden, unreopenable), its record as it was.
      if (listener instanceof Error) {
        starting.delete(id);
        quiet.delete(id);
        unheard.delete(id);
        fenceHomes.delete(id);
        if (was === undefined) known.delete(id);
        else known.set(id, was);
        if (dbStarted) await o.database?.stop({ id, repo });

        return refused('failed', `${id} did not start: ${listener.message}`);
      }
      listening.set(id, listener);
      extras.starting?.(id);
      const launched = await o.runner.launch({
        id,
        repo,
        branch: meta.branch,
        ...(extras.from === undefined ? {} : { from: extras.from }),
        claudeSession: meta.claudeSession,
        ...(extras.resume === undefined
          ? {}
          : { resume: { transcript: extras.resume.transcript, from: extras.resume.from } }),
        // a reopen resumes its conversation; one with none starts a new one (#355)
        ...(extras.reopen === true && !anew ? { reopen: true } : {}),
        ...(chat === undefined ? {} : { folder: chat.folder }),
        prompt: launchedPrompt,
        // A card's session is no Factory run unless its launch says (#186): a moved one too.
        instructions: [
          withSubagentsMax(
            extras.instructions ?? (card === null ? CORE_INSTRUCTIONS : PLAIN_SESSION_INSTRUCTIONS),
            subagentsMax ?? SETTINGS['subagents.max'].default,
          ),
          ...(noDatabase ? [NO_DATABASE_NOTE] : []),
          ...(sourcesTold === null ? [] : [sourcesTold]),
          ...(keysTold === null ? [] : [keysTold]),
          // a local one (a box's environments are its Reach's): what it reaches (ADR 0029)
          ...((card !== null || extras.abe !== undefined) && extras.env === undefined
            ? [agentEnvsLine(enabled)]
            : []),
        ].join('\n\n'),
        settings: withDenyRead(
          [...(awsOff || ownShell ? [awsHome(boundaryHome)] : []), ...access.denyRead],
          withAsk(
            readOnlyPaths(
              merged(
                sessionSettings({
                  abe: o.runner.abe,
                  models,
                  allowedModels,
                  allow: [...inSessionRules(), ...access.allow],
                  ...(!jail
                    ? {}
                    : {
                        // Real paths: Claude Code matches a rule against where a link resolves to.
                        boundary: sessionBoundary({
                          state: realPath(o.stateDir),
                          ...(o.defaultStates === undefined
                            ? {}
                            : { defaultStates: o.defaultStates.map(realPath) }),
                          serveSocket: realPath(o.serveSocket),
                          plugins: realPath(plugins),
                          socket: realPath(socket),
                          checkout: realPath(repo),
                          home: boundaryHome,
                          ...(o.configDir === undefined ? {} : { config: realPath(o.configDir) }),
                          // the person's secrets, never read by its commands or file tools
                          secrets: homeSecrets(boundaryHome, azFolderOf(repo)),
                          // A card's worktree, where the runner makes it (a chat has no branch).
                          ...(meta.branch === ''
                            ? {}
                            : { worktree: worktreePath(realPath(repo), meta.branch) }),
                        }),
                      }),
                  skillsOnTop,
                  home: env.env.HOME ?? '/',
                  ...(extras.permissionMode === undefined ? {} : { mode: extras.permissionMode }),
                  // A resumed one keeps its own (the setting's word).
                  ...(effort === undefined ||
                  extras.resume !== undefined ||
                  (was !== undefined && !anew)
                    ? {}
                    : { effort }),
                }),
                extras.settings?.(id),
              ),
              extras.readOnly ?? [],
              extras.readOnlyFiles ?? [],
              [
                ...(extras.deny ?? []),
                ...(localMode ? LOCAL_MODE_DENY : []),
                // local mode's list has these already
                ...(boardAsked && !localMode ? BOARD_WRITE_DENY : []),
                ...access.deny,
                ...(ownShell ? AWS_HOME_DENY : []),
                ...(guards?.deny ?? []),
              ],
            ),
            extras.askRules ?? [],
          ),
        ),
        // the repo's copies of Abe's skills in place of core's, file by file (ADR 0033, 0034)
        plugin: pluginFor([...sessionPlugin(models), ...(extras.plugin ?? [])], abeFolder(repo)),
        skillsOnTop,
        mcpMode,
        env: env.env,
        setup,
        ...(copy.length === 0 ? {} : { copy }),
        // the recipe's script, in a card's or a prototype's worktree made now (locally, or a
        // box's clone); never the Abe chat's main checkout
        ...(chat !== undefined || hooks['worktree-setup'] === null
          ? {}
          : {
              worktreeRun: hooks['worktree-setup'],
              card: card === null ? null : String(card.id),
            }),
        ...(extras.managed === undefined
          ? {}
          : {
              managed: withSourceRules(extras.managed(o.runner.abe), access),
              // its jail hides them from its commands, as the deny rules from its file tools
              offFiles: access.denyRead,
            }),
        ...(sourcesToRunner
          ? {
              sources: {
                names: sources,
                local: localMode,
                ...(found === undefined
                  ? {}
                  : {
                      servers: found.servers,
                      missing: [...found.missing, ...found.withheld, ...unchecked],
                      withheld: found.withheld,
                      unchecked,
                    }),
              },
            }
          : {}),
        ...(extras.mcpConfig === undefined ? {} : { mcpConfig: extras.mcpConfig }),
        ...(mcp === undefined ? {} : { mcp }),
        ...(extras.files === undefined ? {} : { files: extras.files }),
        // a prototype's on this Mac (ADR 0039): its packages cloned, the person's Figma server always
        ...(extras.code === undefined || plugins === undefined
          ? {}
          : { packages: 'clone' as const, ownServers: figmaServers }),
      });

      starting.delete(id);
      // every Abe env file's value too (ADR 0028), by name, so its logs never carry one
      const credentials =
        card === null && extras.abe === undefined ? {} : ((await o.credentialValues?.(repo)) ?? {});

      abeValues.set(id, {
        ...Object.fromEntries(Object.entries(env.env).filter(([name]) => isSessionSecret(name))),
        ...Object.fromEntries(
          Object.entries(credentials).map(([k, v]) => [`ABE_CREDENTIAL_${k}`, v]),
        ),
      });
      if (!launched.ok) {
        const lost = known.get(id)?.queue ?? [];

        // What was held for it goes with it: said, so no client keeps showing it.
        if (lost.length > 0) {
          o.emitQueued?.({ session: id, queue: [] });
          o.log(`${id} did not start: ${lost.length} held message(s) dropped`);
        }
        hooked.delete(id);
        unheard.delete(id);
        quiet.delete(id);
        abeValues.delete(id);
        fenceHomes.delete(id);
        await unlisten(id);
        // A reopen that did not start: the session stays as it ended (its record untouched).
        if (was === undefined) known.delete(id);
        else known.set(id, was);
        if (dbStarted) await o.database?.stop({ id, repo });

        return refused(launched.error.code, launched.error.message);
      }
      // Its hooks may have moved it already; until one comes, its start timeout runs from now,
      // unless Claude Code's trust dialog waits on the person first (no hook before it).
      const heard = known.get(id) ?? meta;
      const started = {
        ...heard,
        worktree: launched.data.worktree,
        setup: launched.data.setup,
        ...(launched.data.base === undefined ? {} : { base: launched.data.base }),
        // this launch's, never a reopened record's earlier ones
        sourcesMissing: launched.data.sourcesMissing,
        startBy: hooked.has(id) || !launched.data.trusted ? null : startBy(o.clock.now()),
      };

      hooked.delete(id);

      keep(started);
      o.emit({
        id,
        card: started.card,
        state: started.state,
        since: started.since,
        cause: was === undefined ? 'launch' : 'reopen',
      });

      // What was sent while it was launched goes once it takes keys (a hook heard meanwhile).
      void queue.deliver(id);

      return { ok: true, data: data(started) };
    },
    list: async (only) => {
      const settled = await settle();

      if (!settled.ok) return settled;

      return {
        ok: true,
        data: [...known.values()]
          .filter(
            (m) => !starting.has(m.id) && m.moved === null && (only === undefined || m.id === only),
          )
          .sort((a, b) => (a.startedAt < b.startedAt ? -1 : Number(a.startedAt > b.startedAt)))
          .map(data),
      };
    },
    peek: (id) => known.get(id)?.state,
    get: async (id) => {
      const settled = await settle();

      if (!settled.ok) return settled;
      const meta = known.get(id);

      return meta === undefined ? unknown(id) : { ok: true, data: data(meta) };
    },
    hook: (id, event, doc, { answer: given, ...cards } = {}) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      const payload = HookPayload.safeParse(doc);

      if (!payload.success)
        return refused('bad-payload', `the ${event} hook's payload: ${payload.error.message}`);
      const at = stamp();

      o.heard?.();
      // Answered for the person: no dialog shows, so nothing waits on them. Logged with the
      // event (its summary redacted as the shipped logs are).
      const answered =
        event === 'PermissionRequest' &&
        meta.unattended &&
        cards.held === undefined &&
        given === undefined
          ? unattendedAnswer(doc, WORKSPACE_MOUNT, (text) =>
              redactText(text, abeSecrets(abeValues.get(id) ?? {})),
            )
          : undefined;
      const answer = given ?? answered?.answer;

      appendHookEvent(o.stateDir, id, {
        at,
        event,
        payload: doc,
        ...(answered === undefined ? {} : { permission: answered.log }),
      });
      if (starting.has(id)) hooked.add(id);
      if (unheard.get(id) !== true || !STARTING_EVENTS.has(event)) unheard.delete(id);
      const input: HookInput = {
        kind: 'hook',
        event,
        payload: payload.data,
        at,
        launching: starting.has(id),
        answered: answer !== undefined,
        quiet: quiet.has(id),
        holding: [],
        ...cards,
      };

      if (!STARTING_EVENTS.has(event)) quiet.delete(id);
      const was = meta.asks;
      const next = step(id, input) ?? meta;

      // It takes keys again (started, a dialog answered, a turn ended): what was held goes now.
      void queue.deliver(id);

      return {
        ok: true,
        data: {
          state: next.state,
          ...(answer === undefined ? {} : { answer }),
          cleared: was.filter((c) => !next.asks.some((x) => x.id === c.id)).map((c) => c.id),
        },
      };
    },
    step,
    interrupted: (id, at) => {
      const was = known.get(id);

      if (step(id, { kind: 'interrupt', at, now: stamp(), launching: starting.has(id) }) !== was)
        void queue.deliver(id);
    },
    amend: (id, change) => {
      const meta = known.get(id);

      if (meta === undefined) return undefined;
      const next = change(meta);

      keep(next);

      return next;
    },
    send: async (id, text) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      if (meta.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      const sent = await queue.type(id, text);

      return sent.ok ? sent : refused(sent.error.code, sent.error.message);
    },
    envsChanged: async () => {
      const told: string[] = [];

      for (const [id, was] of reaching) {
        const meta = known.get(id);

        if (meta === undefined || meta.state === 'ended') {
          reaching.delete(id);
          continue;
        }
        const now = withOwnReach(agentEnvsOf(meta.repo), meta.prodOn === true);

        if (now.length === was.length && now.every((e) => was.includes(e))) continue;
        reaching.set(id, now);
        const sent = await queue.type(id, envsChangedWords(was, now));

        if (sent.ok) told.push(id);
      }

      return told;
    },
    // an Abe chat conversation is named by your first message to it
    message: async (id, text, context) => {
      const sent = await queue.message(id, text, context);
      const meta = known.get(id);
      const abe = meta?.abe;

      if (
        sent.ok &&
        meta !== undefined &&
        abe !== undefined &&
        abe !== null &&
        hubUnnamed(abe.name)
      ) {
        const words = hubName(text);
        // apart from the repo's other conversations named by the same words (their tabs, rows)
        const name =
          words === ''
            ? ''
            : hubNameApart(
                words,
                [...known.values()].flatMap((x) =>
                  x.id !== id && x.abe?.repo === abe.repo && x.abe.name !== undefined
                    ? [x.abe.name]
                    : [],
                ),
              );

        if (name !== '') {
          keep({ ...meta, abe: { ...abe, name } });
          o.emitTitled?.({ id, title: name });
        }
      }

      return sent;
    },
    unqueue: queue.unqueue,
    answer: queue.answer,
    typed: queue.typed,
    escaped: queue.escaped,
    press: async (id, keysFor) => {
      if (!known.has(id)) return unknown(id);
      const shown = await o.runner.screen(id);

      if (!shown.ok) return refused(shown.error.code, shown.error.message);
      const keys = keysFor(shown.data);

      if (keys === undefined) return { ok: true, data: false };
      const pressed = await o.runner.keys(id, keys);

      return pressed.ok
        ? { ok: true, data: true }
        : refused(pressed.error.code, pressed.error.message);
    },
    model: queue.model,
    baseWorktree: async (id) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      // the repo's worktree recipe, as its card's worktree got it (its files, its script)
      const run = o.hooks?.(meta.repo)['worktree-setup'] ?? null;
      const copy = (await o.worktreeCopies?.(meta.repo, o.facts?.(meta.repo).agentEnvs)) ?? [];
      const made = await o.runner.baseWorktree(meta.repo, meta.branch, {
        copy,
        run,
        card: meta.card === null ? null : String(meta.card),
      });

      return made.ok
        ? { ok: true, data: { ...made.data, branch: meta.branch } }
        : refused(made.error.code, made.error.message);
    },
    attach: (id) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      if (meta.state === 'ended') return refused('session-ended', `session ${id} has ended`);

      return { ok: true, data: o.runner.attach(id) };
    },
    attachSpec: (id) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);

      return {
        ok: true,
        data: attachSpecOf({
          where: 'local',
          root: meta.worktree,
          shell: o.env.SHELL ?? '/bin/zsh',
        }),
      };
    },
    stop: async (id) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      const stopped = await o.runner.stop(id);

      if (!stopped.ok) return refused(stopped.error.code, stopped.error.message);
      const was = known.get(id) ?? meta;

      // Ended by your hand (#205): Stopped, not Failed. Decided by its state before the stop: one
      // its own end (or the runner losing it) beat to it while stopping is still yours.
      if (meta.state !== 'ended' && was.state === 'ended') {
        keep({ ...was, stopped: true });
        o.emit({ id, card: was.card, state: 'ended', since: was.since, cause: 'stop' });
      } else if (meta.state !== 'ended') await end({ ...was, stopped: true }, 'stop');

      return { ok: true, data: data(known.get(id) ?? meta) };
    },
    moveOut: async (id, moved) => {
      const meta = known.get(id);

      if (meta === undefined) return unknown(id);
      if (meta.state !== 'ended') {
        const stopped = await o.runner.stop(id);

        if (!stopped.ok) return refused(stopped.error.code, stopped.error.message);
        await end(meta, 'moved');
      }
      const next = { ...(known.get(id) ?? meta), moved };

      keep(next);

      return { ok: true, data: next };
    },
    admit: (card, repo, id, resume) => admit(card, repo, id, resume),
    unmove: (id) => {
      const meta = known.get(id);

      if (meta?.moved !== null) return;
      keep({ ...meta, moved: null });
    },
    open: () => [...known.values()].filter((m) => m.state !== 'ended').length,
    metaOf: (id) => (starting.has(id) ? undefined : known.get(id)),
    fence: (id) => {
      const meta = known.get(id);

      // A local runner's sessions have the boundary (`sessionBoundary`); a box's and the Abe
      // chat do not.
      if (
        o.runner.plugins === undefined ||
        meta === undefined ||
        (meta.abe !== undefined && meta.abe !== null)
      )
        return undefined;

      return sessionFence({
        // Not known while it starts: then only the other places count.
        worktree: meta.worktree === '' ? '' : realPath(meta.worktree),
        checkout: realPath(meta.repo),
        home: fenceHomes.get(id) ?? realPath(o.env.HOME ?? '/'),
        // A card's Before worktree (#182: Run runs there too).
        ...(meta.branch === '' ? {} : { base: baseWorktreePath(realPath(meta.repo), meta.branch) }),
      });
    },
    launchedWith: (id) => abeValues.get(id),
    // one not ended first, then the one last started, reopened or shown in Chat
    hub: (repo) => {
      const last = (m: SessionMeta) =>
        Math.max(Date.parse(m.reopened.at(-1) ?? m.startedAt), Date.parse(m.shown ?? '') || 0);

      // the one known last first, at the same time (a clock that stands still)
      return hubsOf(repo)
        .reverse()
        .sort(
          (a, b) => Number(b.state !== 'ended') - Number(a.state !== 'ended') || last(b) - last(a),
        )[0];
    },
    hubs: (repo) => hubsOf(repo),
    onTheMac: () => o.runner.plugins !== undefined,
    close: async () => {
      clearInterval(timer);
      await looking;
      await Promise.all([...listening.keys()].map(unlisten));
    },
  };
};

export type SessionCtx = BoardCtx &
  ReachCtx &
  BoxesCtx & {
    /** The session whose socket the request came in on; undefined on `serve`'s own socket. */
    session: string | undefined;
    serve: {
      sessions: Sessions | undefined;
      /** Sessions on your boxes (the Mac's serve, which fronts them); undefined where no boxes are reached. */
      cloud: CloudSessions | undefined;
      /** The sessions' transcripts for Chat (#113, `transcript.ts`); none without a runner. */
      transcripts?: Transcripts | undefined;
      /** Your browser profiles' stored sign-ins (#103): a launch's `--profile` must have some. */
      profileStore: ProfileStore | undefined;
      /** The Factory's runs, cleared ones too: a session one names is a run's (#332). */
      factory?: Pick<Factory, 'all'> | undefined;
      /**
       * Whether a card may start in the checkout holding a folder: refused while its install is not
       * done (the Mac's serve, `cardInstallRefusal`); a folder in no checkout is left to the launch.
       * Undefined: cards start anywhere.
       */
      cardInstall?: ((dir: string) => Promise<Outcome<null>>) | undefined;
      /**
       * Whether an aws profile's login gives keys now: a card's launch is refused while an enabled
       * environment's is expired (`launch-aws.ts`). The Mac's serve only; none: not read.
       */
      awsLogin?: AwsLoginCheck | undefined;
      /** Where a card's launch is said (`launch.started`, `launch.ended`); none: not said. */
      emit?: Journal['emit'] | undefined;
    };
  };

/**
 * A card's local launch shares its branch with another checkout of the same origin: one line why
 * (a live session on the card there or in your environment, else origin has the branch though it
 * was made here now), as both would push one branch and one pull request; none when it shares
 * nothing. Never a refusal: branches keep their names.
 */
export const branchSharedOf = async (
  ctx: { serve: Pick<SessionCtx['serve'], 'sessions' | 'cloud'> },
  s: Pick<SessionData, 'id' | 'card' | 'repo' | 'branch' | 'worktree' | 'base'>,
): Promise<string | undefined> => {
  if (s.card === null || s.branch === '' || !isAbsolute(s.repo)) return undefined;
  const url = await originUrl(s.repo).catch(() => undefined);

  if (url === undefined) return undefined;
  const github = githubRepoOf(url)?.toLowerCase();
  const mine = mainCheckout(s.repo) ?? s.repo;
  const listed = await ctx.serve.sessions?.list();
  const live = [
    ...(listed?.ok === true ? listed.data : []),
    ...((await ctx.serve.cloud?.list().catch(() => [])) ?? []),
  ].filter((x) => x.id !== s.id && x.card === s.card && x.kind === 'card' && x.state !== 'ended');

  for (const x of live) {
    // a checkout's by its origin's URL, a box's by its GitHub repo
    const same = isAbsolute(x.repo)
      ? (mainCheckout(x.repo) ?? x.repo) !== mine &&
        (await originUrl(x.repo).catch(() => undefined)) === url
      : github !== undefined && x.repo.toLowerCase() === github;

    if (same)
      return `AB#${s.card} runs in ${x.box ?? x.repo} too (session ${x.id}), a clone of the same origin: both push ${x.branch} and one pull request`;
  }
  // made here now, yet origin had it at the last fetch: another clone pushed it
  return s.base !== undefined && (await originHadBranch(s.repo, s.branch))
    ? `origin has ${s.branch} already, not made here: another clone's pushes and pull request are on the same branch`
    : undefined;
};

export const noSessions = () =>
  Promise.resolve(refused('no-sessions', 'this abe serve was started without a session runner'));

/** A command from inside a session may name only that session. */
export const yours = (ctx: SessionCtx, id: string) =>
  ctx.session !== undefined && ctx.session !== id
    ? refused('not-your-session', `session ${ctx.session} may act only on itself, not on ${id}`)
    : undefined;

/** The handler's work on `id`: in your environment's sessions when it is one, else the local ones. */
export const on = <T>(
  ctx: SessionCtx,
  id: string,
  local: (s: Sessions) => Promise<Outcome<T>>,
  cloud: (c: CloudSessions) => Promise<Outcome<T>>,
) => {
  const refusal = yours(ctx, id);

  if (refusal !== undefined) return Promise.resolve(refusal);
  if (ctx.session === undefined && ctx.serve.cloud?.knows(id) === true)
    return cloud(ctx.serve.cloud);
  if (ctx.serve.sessions === undefined) return noSessions();

  return local(ctx.serve.sessions);
};

/** The card read from the board in force in `repo`. */
export const readCard = async (
  ctx: SessionCtx,
  text: string,
  repo: string,
): Promise<Outcome<CardDetail>> => {
  const id = parseCardId(text);

  if (id === undefined) return refused('usage', `not a card id (4, AB#4): ${text}`, 2);
  if (ctx.settings === undefined) return refused('no-board', 'no settings to read the board from');
  const board = boardOf(ctx.settings.at(repo).values.board);

  if (!board.ok) return board;

  return ctx.ports.board.show(board.board, id);
};

/**
 * The GitHub repo `--repo` means in your environment: `owner/repo` as typed (when no folder of
 * that name is here), else the checkout's `origin`.
 */
export const cloudRepo = async (text: string, path: string): Promise<Outcome<string>> => {
  const typed = parseRepo(text);

  if (typed !== undefined && !existsSync(path)) return { ok: true, data: typed };
  const origin = await originUrl(path);
  const repo = origin === undefined ? undefined : githubRepoOf(origin);

  return repo === undefined
    ? refused('no-github-repo', `${path} has no GitHub origin to launch on a box from`)
    : { ok: true, data: repo };
};

/**
 * Each session a stored run names (cleared ones too) marked a Factory run's (#332): one launched
 * before serve kept `factory` on it, or moved here, says so as a new one does.
 */
export const markRunSessions = (
  sessions: readonly SessionData[],
  runs: readonly { session: string }[],
): SessionData[] => {
  const ran = new Set(runs.map((r) => r.session));

  return sessions.map((x) =>
    x.factory !== true && ran.has(x.id) ? { ...x, factory: true as const } : x,
  );
};

/**
 * What this `serve` keeps of its cloud sessions, each replaced by its box's own answer when that
 * box answered (it is the newer, unless this `serve` moved it since: a stop, its box gone, #213
 * C7's kept answers), then the box's sessions this `serve` did not launch.
 */
export const mergeBoxSessions = (
  kept: readonly SessionData[],
  boxes: readonly SessionData[],
): SessionData[] => {
  const fresh = new Map(boxes.map((s) => [`${s.box ?? ''} ${s.id}`, s]));
  const merged = kept.map((s) => {
    const f = fresh.get(`${s.box ?? ''} ${s.id}`);

    // a box's older serve says nothing of a Factory run's session (#332): this serve's flag kept
    if (f === undefined || Date.parse(s.since) > Date.parse(f.since)) return s;

    return s.factory === true ? { ...f, factory: true as const } : f;
  });
  const seen = new Set(merged.map((s) => `${s.box ?? ''} ${s.id}`));

  return [...merged, ...boxes.filter((s) => !seen.has(`${s.box ?? ''} ${s.id}`))];
};

/** The person's values for the sources' `${VAR}` references in the checkout `main`; none: empty. */
export const sourceValuesAt = (main: string): ReadonlyMap<string, string> => {
  try {
    return parseEnvFile(readFileSync(join(main, SOURCE_VALUES_PATH), 'utf8'));
  } catch {
    return new Map();
  }
};

/** Where a launch on `card` from `--repo <text>` goes: your environment by `serve.target`, or here. */
export type Placement =
  | { kind: 'local'; path: string }
  | {
      kind: 'cloud';
      cloud: CloudSessions;
      card: CardDetail;
      repo: string;
      /** The checkout it was launched from: whose `limits.maxBoxesPerPerson` it is placed under. */
      where: string;
    };

/**
 * A card's launch from `checkout` while an enabled environment's aws login (prod's too when
 * `prodOn`) is expired: refused now, as a session can't sign in, not at its first step's Needs you.
 */
const awsLoginsAt = (ctx: SessionCtx, checkout: string, prodOn: boolean) => {
  const values = ctx.settings?.at(checkout).values;

  return awsLoginsRefused({
    check: ctx.serve.awsLogin,
    credentials: values?.credentials,
    envs: launchEnvs((env) => values?.[agentEnvKey(env)], prodOn),
  });
};

/**
 * `dir` in a linked worktree (a card's) as the same folder of its main checkout; any other as it is.
 */
const inMainCheckout = (dir: string): string => {
  const top = existsSync(dir) ? repoRoot(dir) : undefined;
  const main = top === undefined ? undefined : mainCheckout(top);

  return top === undefined || main === undefined || main === realPath(top)
    ? dir
    : join(main, relative(top, dir));
};

/**
 * `serve.target` in force where `--repo` points (else the request's cwd): `cloud`, the card
 * and its GitHub repo for your environment's box; else the checkout on this machine. A `target`
 * (`factory run --target`) decides in its place; plain `local`, unsandboxed, is never offered.
 * Every card's launch is placed here, so here it is refused while an aws login it needs is expired
 * (`awsLoginsAt`; `prodOn`: prod on for a local session alone, `factory run --prod`).
 */
export const placement = async (
  ctx: SessionCtx,
  cardText: string,
  repoText: string,
  target?: LaunchTarget,
  prodOn = false,
): Promise<Outcome<Placement>> => {
  const given = realPathAt(ctx.cwd, repoText);
  // A card launched from another card's worktree (its workspace the project shown) is the main
  // checkout's: its worktree, settings and team files are the main checkout's, never that card's.
  const path = ctx.serve.onBox ? given : inMainCheckout(given);
  const where = existsSync(path) ? path : ctx.cwd;
  // A card starts only where the install proved itself: its deps, checks and app.
  const installed = ctx.serve.onBox ? undefined : await ctx.serve.cardInstall?.(where);

  if (installed?.ok === false) return installed;
  const setting = serveTargetIn(ctx.settings, where, ctx.serve.onBox);

  if (target === 'local')
    return refused(
      'no-unsandboxed',
      "a local session always runs in Claude Code's sandbox (ADR 0020 CC6): use --target local-sandbox or --target cloud",
    );
  // Local mode (#24): agents run on this Mac only; a box or a cloud run is refused.
  const localMode = ctx.serve.onBox
    ? undefined
    : localCheckoutOf(ctx.settings?.at(where).values.localMode ?? [], where);

  if (localMode !== undefined && target === 'cloud')
    return refused(
      'local-mode',
      `local mode is on in ${localMode}: agents run on this machine only (abe local off to launch in your environment)`,
    );
  // A board On this Mac is read here only: no box reaches it.
  const board = boardOf(ctx.settings?.at(where).values.board);
  const onMac = board.ok && isLocalBoard(board.board);

  if (onMac && target === 'cloud')
    return refused('local-board', 'the board is On this machine: agents run on this machine only');
  const asked = target === undefined ? isCloudTarget(setting) : target === 'cloud';
  const cloud = localMode === undefined && !onMac && asked;

  if (!cloud) {
    const aws = await awsLoginsAt(ctx, path, prodOn);

    return aws.ok ? { ok: true, data: { kind: 'local', path } } : aws;
  }
  if (ctx.serve.cloud === undefined)
    return refused(
      'no-boxes',
      target === undefined
        ? `serve.target is ${setting}, but this abe serve reaches no environment of yours to launch in`
        : '--target cloud, but this abe serve reaches no environment of yours to launch in',
    );
  const repo = await cloudRepo(repoText, path);

  if (!repo.ok) return repo;
  const card = await readCard(ctx, cardText, where);

  if (!card.ok) return card;
  // a box's keys are synced from here: read on this Mac (prod is never on for a box's session)
  const aws = await awsLoginsAt(ctx, where, false);

  if (!aws.ok) return aws;

  return {
    ok: true,
    data: {
      kind: 'cloud',
      cloud: ctx.serve.cloud,
      card: card.data,
      repo: repo.data,
      where,
    },
  };
};

/**
 * A card's launch said from its ask to its answer (`launch.started`, `launch.ended`): Chat, the
 * Board and every other screen on the card read Launching while serve places and starts it
 * (its aws logins checked, its worktree made), whichever screen or CLI asked, and no session
 * again once it is refused. Said by the Mac's serve only: a box's own launch is the Mac's, said there.
 */
export const saidLaunch = async <T>(
  ctx: Pick<SessionCtx, 'cwd'> & { serve: Pick<SessionCtx['serve'], 'emit' | 'onBox'> },
  cardText: string,
  repoText: string,
  sessionOf: (data: T) => string,
  launch: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const card = parseCardId(cardText);
  const emit = ctx.serve.emit;

  if (card === undefined || emit === undefined || ctx.serve.onBox) return launch();
  const path = realPathAt(ctx.cwd, repoText);
  // the checkout as a session's `repo` names it, or `owner/repo` typed for your environment
  const repo = existsSync(path) || parseRepo(repoText) === undefined ? path : repoText;
  let out: Outcome<T> | undefined;

  emit('launch.started', { card, repo });
  try {
    out = await launch();

    return out;
  } finally {
    // none: it threw
    const error =
      out === undefined ? { code: 'launch-failed', message: 'the launch failed' } : undefined;

    emit('launch.ended', {
      card,
      repo,
      session: out?.ok === true ? sessionOf(out.data) : null,
      refused:
        out?.ok === false ? { code: out.error.code, message: out.error.message } : (error ?? null),
    });
  }
};

/**
 * `session list`'s note on your boxes: why they were not read, else each running box asked that
 * did not answer and where it stands (#143), one after another.
 */
const boxesNote = (fanned: BoxSessions): { boxes?: string } => {
  if (fanned.unread !== null) return { boxes: boxesUnreadText(fanned.unread.message) };

  return fanned.notes.length === 0 ? {} : { boxes: fanned.notes.join('\n') };
};

export const sessionHandlers = <Ctx extends SessionCtx>() =>
  ({
    'session launch': (args, ctx) =>
      saidLaunch(
        ctx,
        args.card,
        args.repo,
        (s) => s.id,
        async () => {
          const placed = await placement(ctx, args.card, args.repo);

          if (!placed.ok) return placed;
          // The browser profile it verifies in, refused before anything starts when nothing is stored.
          const profile = await launchProfile(
            ctx,
            placed.data.kind === 'cloud' ? placed.data.where : placed.data.path,
            args.profile,
          );

          if (!profile.ok) return profile;
          // Your Launch note and the standing notes in force where it launches (#347).
          const setup = await launchSetupOf(
            ctx,
            placed.data.kind === 'cloud' ? placed.data.where : placed.data.path,
            { note: args.note, noteFile: args.noteFile },
          );

          if (!setup.ok) return setup;
          if (placed.data.kind === 'cloud') {
            const { cloud, card, repo, where } = placed.data;

            return cloud.launch(card, repo, where, profile.data, setup.data, args.short);
          }
          const path = placed.data.path;
          const sessions = ctx.serve.sessions;

          if (sessions === undefined) return noSessions();
          // its board is the checkout's (ADR 0030): no checkout, no board to read the card from
          if (repoRoot(path) === undefined)
            return refused('not-a-repo', `${path} is not a git checkout`);
          const card = await readCard(ctx, args.card, path);

          if (!card.ok) return card;
          // The settings in force in the checkout: its repo Layer too. Reads only: a local session.
          const reach = await sessionReach({ ...ctx, cwd: path }, 'local');

          if (!reach.ok) return reach;

          const launched = await sessions.launch(
            card.data,
            path,
            reach.data.env,
            launchSettings(ctx, path),
            {
              browserProfile: profile.data,
              note: setup.data.note ?? null,
              standing: setup.data.standing ?? [],
            },
          );

          if (!launched.ok) return launched;
          const shared = await branchSharedOf(ctx, launched.data);

          return shared === undefined
            ? launched
            : { ok: true, data: { ...launched.data, branchShared: shared } };
        },
      ),
    'session list': async (_, ctx) => {
      // the repo it is read in: which sessions are the shown repo's (#256), asked meanwhile
      const asked = ctx.session === undefined ? repoHere(ctx.cwd) : Promise.resolve({});
      const local =
        ctx.serve.sessions === undefined ? undefined : await ctx.serve.sessions.list(ctx.session);

      if (local !== undefined && !local.ok) return local;
      const cloud =
        ctx.session === undefined && ctx.serve.cloud !== undefined
          ? await ctx.serve.cloud.list()
          : [];

      if (local === undefined && ctx.serve.cloud === undefined) return noSessions();
      const target = serveTargetIn(ctx.settings, ctx.cwd, ctx.serve.onBox);
      // In your environment: every running box's own list too, each tagged with its box (#56).
      const fanned =
        ctx.session === undefined && ctx.serve.boxes !== undefined && isCloudTarget(target)
          ? await ctx.serve.boxes.sessions()
          : { sessions: [], unread: null, notes: [] };

      // A session downloaded to this Mac (#88) is this Mac's: its box's old record is not listed.
      const here = new Set((local?.data ?? []).map((x) => x.id));
      const repo = await asked;

      return {
        ok: true,
        data: {
          sessions: [
            ...markRunSessions(local?.data ?? [], ctx.serve.factory?.all() ?? []),
            ...mergeBoxSessions(
              cloud,
              fanned.sessions.filter((x) => !here.has(x.id)),
            ),
          ],
          ...boxesNote(fanned),
          ...repo,
        },
      };
    },
    'session show': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => s.get(args.id),
        (c) => c.get(args.id),
      ),
    'session attach': (args, ctx) => {
      const argv = (o: Outcome<string[]>): Outcome<{ id: string; argv: string[] }> =>
        o.ok ? { ok: true, data: { id: args.id, argv: o.data } } : o;

      return on(
        ctx,
        args.id,
        (s) => Promise.resolve(argv(s.attach(args.id))),
        (c) => Promise.resolve(argv(c.attach(args.id))),
      );
    },
    'workspace attach-spec': (args, ctx) =>
      on(
        ctx,
        args.session,
        (s) => Promise.resolve(s.attachSpec(args.session)),
        (c) => Promise.resolve(c.attachSpec(args.session)),
      ),
    'session stop': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => s.stop(args.id),
        (c) => c.stop(args.id),
      ),
  }) satisfies Partial<Handlers<Ctx>>;
