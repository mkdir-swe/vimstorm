/**
 * Sessions in your environment, from the Mac (#63, #90; spec #37, ADR 0021): the card's box made
 * from the box launch template or woken (`Boxes`), placed by core's `placeRepo` (#57, ADR 0022: the
 * repo's box), or Queued
 * at `limits.maxBoxesPerPerson` (running and starting boxes count, a stopped one never), `abe
 * workspace up` on it, then `abe session run` there, which starts `claude` in the workspace
 * container. The queue is one, in order: Queued launches and `abe box place --apply`s, each
 * answered once a box stops or is deleted, or the limit (read anew where it was asked) rises. The box's `session.state` events (from its hooks) are followed over the
 * link and become this `serve`'s own, so `abe watch` on the Mac shows them; `send`, `attach`,
 * `stop` and `show` go to the box. What this `serve` knows of each is kept in
 * `<state>/cloud/<id>.json`, so a restarted `serve` (and its queue) carries on.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  abeSkewed,
  type AttachSpec,
  type HandedLayer,
  attachSpecOf,
  boxRuns,
  inWorkspace,
  type Box,
  type Boxes,
  type BoxLink,
  type BoxPlaceData,
  type PlaceAction,
  bootState,
  boxGoneText,
  boxLimitMessage,
  boxSpec,
  boxStoppedReason,
  type Answered,
  type BoxResizeData,
  CardComment,
  type CardDetail,
  type CardText,
  cardBranch,
  cardRunningText,
  type Clock,
  CONTAINER,
  workspaceNames,
  type EventData,
  EVENTS,
  Moved,
  type Mover,
  FactoryChecksData,
  type Ending,
  FactoryEndData,
  FactoryRunData,
  FactoryStatusData,
  holdsBox,
  LAUNCH_GIVE_UP_MS,
  launchBegun,
  launchFailText,
  launchFromBox,
  type LaunchHow,
  type LaunchProgress,
  launchStepped,
  newRun,
  type Outcome,
  pendingRunData,
  type Run,
  runData,
  stageEventOf,
  step as stepRun,
  placeRepo,
  isOldBox,
  boxSizeRank,
  startSize,
  LEGACY_NAMES,
  placeWake,
  BOX_COUNTED,
  refused,
  SessionData,
  SessionRecord,
  withKind,
  SessionListData,
  SessionSendData,
  SessionUnqueueData,
  SessionModelData,
  StatusData,
  type Effort,
  type SessionState,
  waitsOnPr,
  WorkspaceData,
  WorkspaceRemoved,
  DEFAULT_PROFILE,
  cardHasSession,
  isHere,
  type RepoHere,
  type LaunchSetup,
  LaunchNote,
  StandingNote,
  roundToCount,
  RunReference,
  type BoxShortAsk,
  launchShortAsk,
  launchShortText,
  SHORT_READ_MS,
  type ShortAnswer,
  WorkspaceList,
  RunWorkflow,
} from '@abe/core';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cloudDir, readCloudRecords, removeCloudRecord, writeCloudRecord } from '@abe/ports';
import {
  answerOf as answer,
  type BoxFront,
  type BoxListing,
  localDayStart,
  type WakeRoom,
} from './boxes';
import { type ResizeAsk, resizeBox } from './box-resize';
import { type SettleDeps, settleBox, startBox } from './box-settle';
import { type BoxSyncer, type BuiltSync } from './box-sync';

export type CloudOptions = {
  stateDir: string;
  /** The person's boxes on EC2. */
  boxes: Boxes;
  /** `limits.maxBoxesPerPerson` in force in `where` now (a launch's or a place's checkout). */
  limitAt: (where: string | null) => number;
  /** `box.size` and `limits.maxBoxSize` in force in `where`: a new box's size (default the template's). */
  sizeAt?: (where: string | null) => { size: string; max: string };
  link: BoxLink;
  /** How this `abe` is run (`selfArgv([])`). */
  self: readonly string[];
  /** `abe box attach` (ADR 0021); default `<self> box attach`. */
  boxAttach?: readonly string[];
  /** The boxes' AWS region, for the status bar's hover (null: aws's own). */
  region?: string | null;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  /** A session's state, tagged with its box. */
  emit: (data: EventData<'session.state'>, box: string) => void;
  /**
   * A run's move this Mac made itself, tagged with its box (#234): one taken out of the queue
   * before any box had it.
   */
  emitStage?: (data: EventData<'factory.stage'>, box: string) => void;
  /** A launch's box took its next step coming up (`box.step`, #193). */
  step?: (data: EventData<'box.step'>) => void;
  /** A starting session's next launch step (#142), tagged with its box. */
  emitStep?: (data: EventData<'session.step'>, box: string) => void;
  /** Follows a box's events while it holds a session of ours (`boxes.ts`), merged here. */
  front: BoxFront;
  /** How often a box coming up is looked at (default 2 s). */
  pollMs?: number;
  /** How long a box may take to come up with its workspace (default 15 min: a first image build). */
  bootMs?: number;
  /**
   * This Mac's abe: a launch on a box just booted on another release waits for its boot to put
   * the boxes' release on it (`awaitRelease`). None: never waited for.
   */
  version?: string;
  /** How often Queued launches look for a freed box (default 15 s). */
  queuePollMs?: number;
  /** How long one box's `factory status` may take to answer a refresh (default 8 s, #327). */
  statusTimeoutMs?: number;
  /** Move to cloud's copy into the box's clone (#88). */
  mover: Mover;
  /**
   * Yours as each launch hands it to its box (`handedLayer`, #222, ADR 0030), read as its claude
   * starts for the checkout it was launched from (`where`): the box's runs then follow the
   * settings this Mac shows. None: the box keeps its own.
   */
  layer?: (where: string | null) => HandedLayer;
  /** The box profile in force in `where` where not serve's own (ADR 0025): a new box is made on it. */
  profileAt?: (where: string | null) => string | null;
  /** A Move to cloud that failed after its local record was marked moved: it is this Mac's again. */
  movedBack?: (id: string) => void;
  /**
   * Box parity (3.2.1): what the box's workspace gets of this Mac's at launch and, when something
   * changed here, before each turn (`box-sync.ts`). None: nothing is synced.
   */
  sync?: BoxSyncer;
  /** What serve says of a failure nobody waits on (a sync that did not go). */
  log?: (message: string) => void;
};

/** A cloud run's prototype reference (#351): its run's record, its prompt's words, its files' folder. */
export type CloudReference = { run: RunReference; prompt: string; files: string };

/** What Move to cloud brings (#88): the pack to copy into the clone, the Claude session to resume. */
export type MovedIn = {
  id: string;
  /** The pack file on this Mac, copied into the box's clone before `claude` starts. */
  pack: string;
  /** The plan's files: of the pack's files, the only ones that land in the clone. */
  files: string[];
  /** The local worktree it leaves as it was: where it stays when the move fails. */
  worktree: string;
  /** Null: it had no transcript yet, so its claude starts anew. */
  resume: { claudeSession: string; transcript: string; from: string } | null;
  /** The browser profile it was launched in (#103): it goes on in it. */
  browserProfile?: string;
};

/** A cloud session as Download locally reads it (#88). */
export type Movable = Pick<
  SessionData,
  'id' | 'title' | 'repo' | 'worktree' | 'branch' | 'state' | 'transcriptPath'
> & { card: number; box: string; description: string; criteria: string };

/**
 * `abe box place`: where the card's box goes; with `apply` it is woken or made, or held in the
 * queue. `where`: the checkout it was asked in, whose `limits.maxBoxesPerPerson` it waits under.
 */
export type PlaceAsk = {
  repo: string;
  card: number;
  title: string;
  where: string;
  apply: boolean;
};

export type CloudSessions = {
  /**
   * `where`: the checkout it was launched from (its `limits.maxBoxesPerPerson`, read anew while it
   * waits).
   */
  launch: (
    card: CardDetail,
    repo: string,
    where: string,
    /** The browser profile its verify browser starts in (#103); default `default`. */
    profile?: string,
    /** Your Launch note and the standing notes (#347): to the box with the card's words. */
    setup?: LaunchSetup,
    /** Onto its repo's box short (ADR 0022): resized first, or as it is; none: asked. */
    short?: ShortAnswer,
  ) => Promise<Outcome<SessionData>>;
  /** A Factory run on the card's box (#67): launched as a session there, the run in its serve. */
  factoryRun: (
    card: CardDetail,
    repo: string,
    where: string,
    profile?: string,
    /** What the person set in the Launch box (#342): it goes to the box with the card's words. */
    setup?: LaunchSetup,
    /**
     * The card's prototype as the Mac read it from the org store (#351; a box has no store):
     * `files` copied now, into the clone before its claude starts.
     */
    reference?: CloudReference,
    /** As `launch`'s. */
    short?: ShortAnswer,
  ) => Promise<Outcome<FactoryRunData>>;
  /**
   * A prototype session on the repo's box (`serve.target` cloud): its workspace keyed by the
   * prototype's id (`proto-1a2b3c`), on its `proto/…` branch; its session's id `<that id>-<hex>`.
   */
  prototype: (
    p: {
      id: string;
      card: CardDetail | null;
      words: string;
      title: string;
      branch: string;
      base: string;
      commit: string;
    },
    repo: string,
    where: string,
  ) => Promise<Outcome<SessionData>>;
  /** A prototype's workspace on `box` removed (`prototype discard`), whatever it holds. */
  dropPrototype: (box: string, id: string) => Promise<Outcome<null>>;
  /** `abe box place` (#57): the card's box used, woken, made or Queued, by the launches' rules and queue. */
  place: (ask: PlaceAsk) => Promise<Outcome<BoxPlaceData>>;
  /**
   * `abe box up` (#57): the card's box placed as `place` does, and when it must be made, EC2
   * asked under the same one-at-a-time as every launch (so none passes the limit beside it).
   * Never Queued here: at the limit its action is `queue` and nothing is made. `made`: the box
   * EC2 is making.
   */
  claim: (
    ask: Omit<PlaceAsk, 'apply'>,
  ) => Promise<Outcome<{ placed: BoxPlaceData; made: Box | undefined }>>;
  /**
   * Room for a wake by name (`box start`, `box keep`, `--on`; #191) under the limit in force at
   * `where` (the checkout the command was typed in), counted as a launch's wake: with the boxes
   * running or starting and those Queued ahead; at the limit refused `box-limit`, never Queued.
   */
  wakeRoom: (where: string) => WakeRoom;
  /** The queue looks for room now (the limit was changed). */
  nudge: () => void;
  /**
   * What `abe box list` adds to EC2's boxes, read the moment EC2 answered: the placements Queued
   * for a box, oldest first (#104), and the boxes made here that EC2 may not list yet. A Queued
   * place stays Queued until its box is made, so between the two lists it is always in one.
   */
  listing: BoxListing;
  /** The Factory runs on boxes, or `card`'s: as their box answers, else as last heard. */
  runs: (card?: number) => Promise<FactoryRunData[]>;
  /**
   * `card`'s checks run again on its box (of the repo `here` names, #256); undefined when no box
   * holds a run of it.
   */
  checks: (card: number, here?: RepoHere) => Promise<Outcome<FactoryChecksData> | undefined>;
  /**
   * `card`'s run ended by you (#184): on its box, or on this Mac when no box had it yet (#234: it
   * waited in the queue, or was stopped there), its placement cancelled; undefined when you have
   * no run of it in your environment. Only the repo `here` names (#256): another repo's card of
   * the same number is never ended.
   */
  end: (card: number, as: Ending, reason: string, here?: RepoHere) => Promise<CloudEnd | undefined>;
  knows: (id: string) => boolean;
  /**
   * The newest session of yours on `box` (with `card`, of that card's workspace), as last heard
   * (no read): `box list`'s session (#194).
   */
  lastOn: (box: string, card?: number) => SessionData | undefined;
  list: () => Promise<SessionData[]>;
  get: (id: string) => Promise<Outcome<SessionData>>;
  /**
   * `abe <argv>` on the serve of the box `id` runs on, its answer read with `schema`: a session's
   * cards and Overrides live where its hooks land (#114).
   */
  relay: <T extends z.ZodType>(
    id: string,
    schema: T,
    argv: readonly string[],
  ) => Promise<Outcome<z.output<T>>>;
  /**
   * `abe <argv> --json` on the session's box, read with `schema` (#113: its transcript and
   * revert, which the box's own serve answers, an ended session's too); refused while it has not
   * started there.
   */
  forward: <T extends z.ZodType>(
    id: string,
    schema: T,
    argv: readonly string[],
  ) => Promise<Outcome<z.output<T>>>;
  /** A person's message, its `--context` JSON as given: the box's serve reads it and queues (#115). */
  send: (id: string, text: string, context?: string) => Promise<Outcome<SessionSendData>>;
  unqueue: (id: string, n: number) => Promise<Outcome<SessionUnqueueData>>;
  model: (id: string, model: string, effort?: Effort) => Promise<Outcome<SessionModelData>>;
  attach: (id: string) => Outcome<string[]>;
  /** What VimStorm runs to open its workspace (#74): every argv through `abe box attach`. */
  attachSpec: (id: string) => Outcome<AttachSpec>;
  stop: (id: string) => Promise<Outcome<SessionData>>;
  /**
   * Reopen (#343): an ended session on its box goes on, the same workspace and Claude Code
   * conversation, its box woken first when it sleeps; `message` its first prompt.
   */
  reopen: (id: string, message?: string, short?: ShortAnswer) => Promise<Outcome<SessionData>>;
  /**
   * Whether a Move to cloud of `id` on `card` would be placed (#88): what `moveIn` would refuse
   * before anything is stopped or packed (`card-has-session`, `session-exists`).
   */
  admit: (card: number, repo: string, id: string) => Outcome<null>;
  /** Move to cloud (#88): a launch on the card's box that copies `moved` in and resumes it. */
  moveIn: (
    card: CardDetail,
    repo: string,
    where: string,
    moved: MovedIn,
    /** Onto its repo's running box short (ADR 0022), as a launch's; none: asked. */
    short?: ShortAnswer,
  ) => Promise<Outcome<SessionData>>;
  /**
   * Put before a command to run it in `card`'s workspace container on `box` (`inWorkspace`:
   * attach, then docker exec).
   */
  execOn: (box: string, card: number | string) => string[];
  /** Download locally (#88): the session as this Mac knows it, refused when it cannot move. */
  movable: (id: string) => Outcome<Movable>;
  /** Its `claude` on the box stopped, so its transcript and files hold still while copied. */
  stopOnBox: (id: string) => Promise<Outcome<null>>;
  /** It moved to this Mac: ended here (`moved`), kept as history, its box let go. */
  movedOut: (id: string, moved: Moved) => void;
  /** `abe box resize`: the box stopped, its instance type changed, started (`box-resize.ts`). */
  resize: (ask: ResizeAsk) => Promise<Outcome<BoxResizeData>>;
  close: () => Promise<void>;
};

/**
 * A run ended on this Mac (#234): it never reached a box. Its card's move is the caller's
 * (`factory end`), as a local run's is.
 */
export type EndedHere = {
  run: Run;
  /** Its session: taken out of the queue, or ended already. */
  session: string;
};

/** Where `factory end` ended a run in your environment: on its box, or here (#234). */
export type CloudEnd =
  { on: 'box'; ended: Outcome<FactoryEndData> } | { on: 'mac'; ended: Outcome<EndedHere> };

/** What the Mac keeps of a session in your environment. */
const CloudMeta = SessionRecord.extend({
  v: z.literal(1),
  /** A box's session is a card's, or a prototype's (`prototype`, its card null when it has none). */
  card: z.number().int().positive().nullable(),
  box: z.string(),
  description: z.string(),
  criteria: z.string().default(''),
  /** The card's comments at launch, oldest first: the run's prompt carries the whole card. */
  comments: z.array(CardComment).default([]),
  /** The checkout it was launched from: the `limits.maxBoxesPerPerson` its queue waits under. */
  where: z.string().nullable().default(null),
  /** A record from before `where`: the limit when it was launched. */
  limit: z.number().int().positive().optional(),
  /** A Factory run's session (`abe factory run`): the run lives in the box's serve (#67). */
  factory: z.boolean().default(false),
  /** The Launch note and standing notes at launch (#347), sent with the card's words too. */
  note: LaunchNote.nullable().default(null),
  standing: z.array(StandingNote).default([]),
  /** The card's type and tags (#15), sent so the box's run takes the workflow the card's `on:` picks. */
  type: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** The workflow its run runs, picked locally (yours are never in the box's clone); null: the box's by type and tags. */
  workflow: RunWorkflow.nullable().default(null),
  /** Its run as the box last answered (or its events said); null before the box has it. */
  run: FactoryRunData.nullable().default(null),
  /** The box no longer shows the run (it cleared after its Done). */
  cleared: z.boolean().default(false),
  /**
   * Taken out of the queue before any box had it (#234, Stop… or End run…): its run is this
   * Mac's (`run`), no box is asked of it.
   */
  neverPlaced: z.boolean().default(false),
  /** Moved to this Mac (#88, Download locally): it goes on there, this record is history. */
  moved: Moved.nullable().default(null),
  /**
   * Move to cloud (#88): the pack copied into the clone before `claude` starts (`pack` null once
   * it was), the local worktree it came from.
   */
  moveIn: z
    .object({ pack: z.string().nullable(), files: z.array(z.string()), worktree: z.string() })
    .nullable()
    .default(null),
  /**
   * A prototype card's run (#351): the reference the Mac read, its files kept in `<state>/cloud`
   * until they are in the clone (`files` null once they are), its record and words to the box.
   */
  reference: z
    .object({ run: RunReference, prompt: z.string(), files: z.string().nullable() })
    .nullable()
    .default(null),
  /**
   * A prototype session's (`prototype` its id and card): its words and where its `proto/…` branch
   * was made from, sent to the box's `session run --prototype`.
   */
  proto: z
    .object({ words: z.string(), base: z.string(), commit: z.string() })
    .nullable()
    .default(null),
  /** Move to cloud: the Claude session its `claude --resume`s, its transcript in the clone. */
  resume: z
    .object({ claudeSession: z.string(), transcript: z.string(), from: z.string() })
    .nullable()
    .default(null),
}).transform(withKind);
type CloudMeta = z.infer<typeof CloudMeta>;

/** Its workspace's key on the box: the card's id, or a prototype's own (`proto-1a2b3c`). */
const keyOf = (m: Pick<CloudMeta, 'card' | 'prototype'>): string =>
  m.prototype?.id ?? String(m.card);

/**
 * An `abe box place --apply` held Queued at the limit (`<state>/cloud/place-<card>-<hex>.json`),
 * in the one queue with the launches; its file goes once it is answered (its box asked up, or
 * `box.state` `failed`).
 */
const HeldPlace = z.object({
  v: z.literal(1),
  kind: z.literal('place'),
  id: z.string(),
  repo: z.string(),
  card: z.number().int().positive(),
  title: z.string(),
  where: z.string(),
  box: z.string(),
  state: z.literal('queued'),
  startedAt: z.string(),
});
type HeldPlace = z.infer<typeof HeldPlace>;

/** One request in the queue, oldest first: a Queued launch or a held `box place`. */
type Waiting = { kind: 'launch'; meta: CloudMeta } | { kind: 'place'; held: HeldPlace };

const byStart = <T extends { startedAt: string }>(a: T, b: T) =>
  a.startedAt < b.startedAt ? -1 : Number(a.startedAt > b.startedAt);

/** A placement's action as a launch's step words say it (#142). */
const HOW: Readonly<Record<Exclude<PlaceAction, 'queue'>, LaunchHow>> = {
  create: 'new',
  wake: 'wake',
  use: 'use',
};

const OPEN = new Set<SessionState>(['queued', 'starting', 'working', 'waiting']);

const dataOf = (m: CloudMeta): SessionData => ({
  id: m.id,
  card: m.card,
  prototype: m.prototype,
  kind: m.kind,
  title: m.title,
  repo: m.repo,
  worktree: m.worktree,
  branch: m.branch,
  box: m.box,
  state: m.state,
  since: m.since,
  startedAt: m.startedAt,
  transcriptPath: m.transcriptPath,
  lastAssistantMessage: m.lastAssistantMessage,
  models: m.models,
  subagents: m.subagents,
  reason: m.reason,
  stopped: m.stopped,
  ...(m.factory ? { factory: true as const } : {}),
  setup: m.setup,
  skillsOnTop: m.skillsOnTop,
  browserProfile: m.browserProfile,
  overrides: m.overrides,
  queue: m.queue,
  model: m.model,
  effort: m.effort,
  ...(m.queuedFor === undefined ? {} : { queuedFor: m.queuedFor }),
  // #246: the box it waited for was never its own
  ...(m.neverPlaced ? { neverPlaced: true } : {}),
  launch: m.launch,
  reopened: m.reopened,
  rounds: m.rounds,
  waitingOn: m.waitingOn,
  ...(m.turnEnded === true ? { turnEnded: true as const } : {}),
});

/** A session that never got a box (#246) has no Workspace to attach, open or download. */
const neverPlacedRefusal = (id: string) =>
  refused('session-never-placed', `session ${id} never got a box: it has no Workspace`);

/**
 * `abe <argv> --json` on a box's serve, its answer read with `schema`: how the Mac reaches a
 * box's Factory run (#67). Kept to this one function on purpose: #56 ("the local serve fronts
 * your boxes") replaces it with its general forwarding.
 */
const forward = async <T extends z.ZodType>(
  link: BoxLink,
  schema: T,
  box: string,
  argv: readonly string[],
): Promise<Outcome<z.output<T>>> => answer(schema, await link.run(box, [...argv, '--json']));

/** How many boxes a refresh asks for their `factory status` at once (#327). */
const STATUS_AT_ONCE = 8;
/** How long one box may take to answer it: a slow or silent box holds the read no longer. */
const STATUS_TIMEOUT_MS = 8000;
/** An ask out this many timeouts long is given up on: the box is asked anew. */
const STATUS_STALE = 8;

/** `p`'s answer, or undefined once `ms` passed without one (or it threw). */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    const done = (v: T | undefined) => {
      clearTimeout(timer);
      resolve(v);
    };

    void p.then(done, () => {
      done(undefined);
    });
  });

/** `f` on each of `items`, at most `n` at a time; answered once all are done. */
const eachAtMost = async <T>(items: readonly T[], n: number, f: (t: T) => Promise<void>) => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];

      next += 1;
      if (item !== undefined) await f(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
};

/**
 * How long after its boot a box may still be putting the boxes' release on (#244): its boot
 * installs it and restarts its serve a minute or two after the wake answered.
 */
const RELEASE_MS = 3 * 60_000;

/** The box's serve not there yet (starting) or the tunnel not up: try again. */
const NOT_YET = new Set(['box-unreachable', 'serve-unreachable']);
const notYet = (o: Outcome<unknown>) => !o.ok && NOT_YET.has(o.error.code);

export const startCloud = (o: CloudOptions): CloudSessions => {
  const pollMs = o.pollMs ?? 2000;
  const statusMs = o.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
  const boxAttach = o.boxAttach ?? [...o.self, 'box', 'attach'];
  /** This serve's sessions that hold `box`. */
  const holding = (box: string) =>
    [...known.values()].filter((m) => m.box === box && holdsBox(m.state));
  const openOn = (box: string) => holding(box).length > 0;
  /** A run of ours the box carries past its session (`waitsOnPr`), as last heard. */
  const carried = (m: CloudMeta) => m.factory && !m.cleared && m.run !== null && waitsOnPr(m.run);
  /**
   * Whether `box`'s events are followed: while a session of ours holds it, and after, while it
   * carries a run of ours to Done (its pull request's merge, deploy and Done reach `abe watch`).
   */
  const followed = (box: string) =>
    openOn(box) || [...known.values()].some((m) => m.box === box && carried(m));
  const bootMs = o.bootMs ?? LAUNCH_GIVE_UP_MS;
  const known = new Map<string, CloudMeta>();
  /**
   * Launches being placed or brought up now: not settled from EC2's view while they are. One is
   * in it from before its `starting` is kept (#243: EC2's create may answer seconds later, and its
   * new box is in no listing until then) until `bringUp` is over.
   */
  const coming = new Set<string>();
  let closed = false;
  const stamp = () => new Date(o.clock.now()).toISOString();

  /** `box place --apply`s held in the queue, and those answered since. */
  const places = new Map<string, HeldPlace>();

  for (const doc of readCloudRecords(o.stateDir)) {
    const held = HeldPlace.safeParse(doc);
    const read = held.success ? undefined : CloudMeta.safeParse(doc);

    if (held.success) places.set(held.data.id, held.data);
    else if (read?.success === true) known.set(read.data.id, read.data);
  }

  const keep = (m: CloudMeta) => {
    known.set(m.id, m);
    writeCloudRecord(o.stateDir, m.id, m);
  };
  const keepPlace = (h: HeldPlace) => {
    places.set(h.id, h);
    writeCloudRecord(o.stateDir, h.id, h);
  };
  /** A held place answered: out of the queue, its file gone. */
  const dropPlace = (h: HeldPlace) => {
    places.delete(h.id);
    removeCloudRecord(o.stateDir, h.id);
  };
  /** The queue, oldest first. */
  const waiting = (): Waiting[] =>
    [
      ...[...known.values()]
        .filter((m) => m.state === 'queued')
        .map((meta): Waiting => ({ kind: 'launch', meta })),
      ...[...places.values()].map((held): Waiting => ({ kind: 'place', held })),
    ].sort((a, b) =>
      byStart(a.kind === 'launch' ? a.meta : a.held, b.kind === 'launch' ? b.meta : b.held),
    );
  /** The limit a launch waits under: its checkout's now (an old record's, as launched). */
  const limitOf = (m: CloudMeta) =>
    m.where === null && m.limit !== undefined ? m.limit : o.limitAt(m.where);
  /** A fresh record id for `card`, `<card>-<hex>` (a place's with `place-` before it). */
  const freshId = (card: number | string, head = '') => {
    let id: string;

    do id = `${head}${card}-${randomBytes(2).toString('hex')}`;
    while (known.has(id) || places.has(id));

    return id;
  };

  const unfollow = (box: string) => {
    o.front.release(box, 'cloud');
  };

  /**
   * The record moved to `state` and said as a `session.state` event, unless its box said it
   * (`fromBox`): the box's own event is merged into this stream instead.
   */
  const move = (
    m: CloudMeta,
    state: SessionState,
    cause: string,
    since = stamp(),
    fromBox = false,
    reason?: string,
  ) => {
    if (m.state === state) return m;
    // Its launch steps are a starting session's only; an ended launch's reference files go.
    const next = {
      ...m,
      state,
      since,
      waitingOn: state === 'waiting' ? m.waitingOn : null,
      ...(state === 'starting' ? {} : { launch: null }),
      ...(state === 'ended' ? { reference: referenceDropped(m.reference) } : {}),
    };

    keep(next);
    if (!fromBox)
      o.emit(
        {
          id: m.id,
          card: m.card,
          state,
          since,
          cause,
          ...(reason === undefined ? {} : { reason }),
          ...(state === 'waiting' ? { waitingOn: next.waitingOn } : {}),
        },
        m.box,
      );
    // Its box's stream is an open connection, someone there: held past the last session only
    // while the box carries a run of ours on (and so keeps itself awake for it anyway).
    if (state === 'ended') void release(m.box);

    return next;
  };

  /**
   * A starting launch at its next step (#142), kept and said as `session.step`; a step that
   * changes nothing is not said.
   */
  const stepTo = (id: string, next: (l: LaunchProgress) => LaunchProgress) => {
    const m = known.get(id);

    if (m?.state !== 'starting' || m.launch === null) return;
    const was = m.launch;
    const l = next(was);

    if (l.step === was.step && l.detail === was.detail && l.told === was.told) return;
    keep({ ...m, launch: l });
    if (m.card !== null) o.emitStep?.({ id: m.id, card: m.card, launch: l }, m.box);
  };
  /**
   * A starting launch's record with its first step, said. A box used while EC2 still starts it (a
   * wake or create of another launch's, `abe box start`) is said as coming up, not as a slow
   * workspace.
   */
  const begin = (
    m: CloudMeta,
    how: Exclude<PlaceAction, 'queue'>,
    boxes: readonly Box[],
  ): CloudMeta => {
    const up = boxes.find((b) => b.name === m.box)?.state === 'running';
    const launch = launchBegun(m.box, how === 'use' && !up ? 'wake' : HOW[how], stamp());
    const begun = { ...m, launch };

    keep(begun);
    if (m.card !== null) o.emitStep?.({ id: m.id, card: m.card, launch }, m.box);

    return begun;
  };

  /**
   * `box`'s stream let go once nothing of ours is there to follow. A Factory run's pull request
   * may have opened since its run was last heard (an older box's stage events do not carry it):
   * its box is asked first.
   */
  const release = async (box: string) => {
    if (followed(box)) return;
    const runs = [...known.values()].filter(
      (m) => m.box === box && m.factory && !m.cleared && m.run?.outcome === null,
    );

    // A box that did not answer now (asleep, the link down) may carry it still: kept followed
    // (following never wakes it); its next answer to `refresh` lets it go.
    if (runs.length > 0 && !(await refresh(runs)).has(box)) return;
    if (!followed(box)) unfollow(box);
  };

  const unknown = (id: string) => refused('no-session', `no session ${id}`);

  /** A box's `factory.stage` event: its run as last heard moved (the event itself is merged as it came). */
  const staged = (box: string, raw: unknown) => {
    const data = EVENTS['factory.stage'].data.safeParse(raw);

    if (!data.success) return;
    const m = known.get(data.data.session);

    if (m?.box !== box || !m.factory) return;
    if (m.run !== null)
      keep({
        ...m,
        run: {
          ...m.run,
          stage: data.data.stage,
          state: data.data.state,
          reason: data.data.reason,
          since: data.data.since,
          outcome: data.data.outcome,
          // its pull request as the move left it (#228); an older box's serve sends none
          ...(data.data.pr === undefined ? {} : { pr: data.data.pr }),
          // how a person ended it (#230): an abandoned run stays on its stage; an older one: none
          ...(data.data.ended === undefined ? {} : { ended: data.data.ended }),
        },
      });
    // Done: nothing more of this run's comes from the box.
    if (data.data.outcome !== null && !followed(box)) unfollow(box);
  };

  /** The box's events (`boxes.ts`), followed while `followed` says so. */
  const follow = (box: string) => {
    if (!closed) o.front.keep(box, 'cloud');
  };

  // The box's own `session.state` for a session of ours moves its record and is merged; one
  // saying the state this serve said already (its `starting`, its `ended`) is not, so none is twice.
  /** The question rounds counted per box session, by round id (#342). */
  const roundsSeen = new Map<string, Set<string>>();

  o.front.onEvent((box, event) => {
    if (event.type === 'factory.stage') staged(box, event.data);
    // The box's own idle stop (#192): its sessions end now, each saying why and how to go on.
    if (
      event.type === 'box.state' &&
      event.data.state === 'stopping' &&
      event.data.cause === 'idle'
    )
      for (const m of holding(box)) if (!coming.has(m.id)) endWithBox(m, true);
    // The box's workspace up at its next step: the launch waiting on it moves on (#142).
    if (event.type === 'workspace.step') {
      const at = stamp();

      // A box holds a workspace per card (ADR 0022): only that card's launch moves.
      for (const m of known.values())
        if (
          m.box === box &&
          m.state === 'starting' &&
          (event.data.card === undefined || event.data.card === String(m.card))
        )
          stepTo(m.id, (l) => launchFromBox(l, event.data, at));

      return true;
    }
    // An Override on the box's session (#114): `session list` carries it here too.
    if (event.type === 'session.override') {
      const m = known.get(event.data.id);
      const o = event.data.override;

      if (m?.box === box)
        keep({ ...m, overrides: [...m.overrides.filter((x) => x.what !== o.what), o] });

      return true;
    }
    // A question round on the box's session (#342): the Mac's lists count it too (Grill round N).
    if (event.type === 'session.ask') {
      const m = known.get(event.data.id);

      // once a round: a pick re-sends its round's cards (`--pick`), a held card re-sent expires
      const seen = roundsSeen.get(event.data.id) ?? new Set<string>();
      const round = roundToCount(seen, event.data.cards);

      if (m?.box === box && round !== undefined) {
        roundsSeen.set(event.data.id, seen.add(round));
        keep({ ...m, rounds: m.rounds + 1 });
      }

      return true;
    }
    if (event.type !== 'session.state') return true;
    const m = known.get(event.data.id);

    if (m?.box !== box) return true;
    if (m.state === 'ended') return false;
    const turnEnded = event.data.turnEnded === true ? true : undefined;

    // its own turn ended (or went on) while it still works: kept, said on
    if (m.state === event.data.state) {
      if (m.turnEnded === turnEnded) return false;
      keep({ ...m, turnEnded });

      return true;
    }
    const stopped = event.data.state === 'ended' && event.data.cause === 'stop';

    // Box parity (3.2.1): a token or key due goes again while the box works (its turns' moves
    // reach this Mac), so a long run never works on an ended one; an ended session's is forgotten.
    if (event.data.state === 'ended') syncs.delete(m.id);
    else if (dueNow(m.id)) void syncInto(m, true);

    move(
      { ...m, stopped: stopped || m.stopped, waitingOn: event.data.waitingOn ?? null, turnEnded },
      event.data.state,
      event.data.cause,
      event.data.since,
      true,
    );

    return true;
  });

  /** Old boxes (ADR 0022: a 2.2 box made for one card, its `abe:card` tag) as EC2 last listed them. */
  const oldBoxes = new Set<string>();
  const boxes = async (): Promise<Outcome<Box[]>> => {
    const listed = await o.boxes.list();

    if (listed.ok) {
      oldBoxes.clear();
      for (const b of listed.data) if (isOldBox(b)) oldBoxes.add(b.name);
    }

    return listed.ok ? listed : refused(listed.error.code, listed.error.message);
  };
  /**
   * The workspace container of a card (or a prototype, by its id) on `box`: an old box's one
   * `abe-workspace`, else its own.
   */
  const containerOn = (box: string, key: number | string) =>
    oldBoxes.has(box) ? LEGACY_NAMES.container : workspaceNames(String(key)).container;

  /**
   * Boxes a placement decided to wake, by name → until when: a wake counts from its decision
   * (#57 as changed: a stopped box counts once it starts), though EC2 is asked to start it only
   * after `serially`. Gone once EC2 lists it running or starting, its start is over, or after the
   * boot timeout.
   */
  const waking = new Map<string, number>();
  const wakes = (box: string) => waking.set(box, o.clock.now() + bootMs);
  const woken = (box: string) => waking.delete(box);

  /**
   * Core's `placeRepo`, where its answer is read: a wake it decides counts from now (`wakes`),
   * unless the placement is only looked at (`dry`: a dry run, a card that stays queued).
   */
  const placeNow = (at: Parameters<typeof placeRepo>[0], dry = false) => {
    const placed = placeRepo(at);

    if (placed.kind === 'wake' && !dry) wakes(placed.box);

    return placed;
  };

  /**
   * Boxes this serve had EC2 make, by name → the box and until when: EC2's listing may not have
   * a new one yet, and a second launch on its repo must use it, never make another (ADR 0022).
   */
  const created = new Map<string, { box: Box; until: number }>();
  const remember = (box: Box) => created.set(box.name, { box, until: o.clock.now() + bootMs });

  /** EC2's boxes as a placement counts them: one being woken here as starting already. */
  const placeable = async (): Promise<Outcome<Box[]>> => {
    const listed = await boxes();

    if (!listed.ok) return listed;
    const now = o.clock.now();
    const unlisted = [...created.entries()].flatMap(([name, c]) => {
      if (c.until <= now || listed.data.some((b) => b.name === name)) {
        created.delete(name);

        return [];
      }

      return [{ ...c.box, state: 'pending' as const }];
    });

    return {
      ok: true,
      data: [...listed.data, ...unlisted].map((b) => {
        const until = waking.get(b.name);

        if (until === undefined) return b;
        if (BOX_COUNTED.has(b.state) || until <= now || b.state === 'terminated') {
          woken(b.name);

          return b;
        }

        return { ...b, state: 'pending' as const };
      }),
    };
  };

  /** The reference's kept files gone (an ended launch, or once they are in the clone). */
  const referenceDropped = (r: CloudMeta['reference']): CloudMeta['reference'] => {
    const files = r?.files ?? null;

    if (r === null || files === null) return r;
    rmSync(files, { recursive: true, force: true });

    return { ...r, files: null };
  };

  const fail = (m: CloudMeta, code: string, why: string) => {
    const launch = known.get(m.id)?.launch ?? null;
    // Given up (its box or serve never there in time): the step it hung at named, and where the
    // box's log is (#142); any other refusal says only its own why.
    const hung = code === 'box-timeout' || NOT_YET.has(code);
    const message = launch === null || !hung ? why : launchFailText(launch, stamp(), why);
    const ended = move(m, 'ended', `launch-failed: ${code}`, stamp(), false, message);

    keep({ ...ended, reason: message });
    const moveIn = m.moveIn;

    if (moveIn === null) return refused(code, message);
    // A Move to cloud that did not land: the session is this Mac's again, its worktree as it was.
    if (moveIn.pack !== null) rmSync(moveIn.pack, { force: true });
    keep({
      ...ended,
      reason: message,
      moved: { to: 'local', at: stamp(), where: moveIn.worktree },
      moveIn: null,
    });
    o.movedBack?.(m.id);

    return refused(code, `${message} · ${moveIn.worktree} stays as it was`);
  };

  /** EC2 read again for a box on its way up or down (core's `boxSettling`). */
  const settling: SettleDeps = {
    boxes: o.boxes,
    now: () => o.clock.now(),
    sleep: (ms) => o.sleep(ms),
    pollMs,
  };

  /** `abe <argv> --json` on the box, tried again while its serve or the tunnel is not up yet. */
  const onBox = async <T extends z.ZodType>(
    schema: T,
    box: string,
    argv: readonly string[],
    until: number,
  ): Promise<Outcome<z.output<T>>> => {
    for (;;) {
      const got = answer(schema, await o.link.run(box, [...argv, '--json']));

      if (!notYet(got) || o.clock.now() > until) return got;
      await o.sleep(pollMs);
    }
  };

  /**
   * A box that answered on another release than this Mac's while its boot may still put the boxes'
   * release on it (under `RELEASE_MS` since its boot): asked again until it runs this Mac's line
   * or that time is over, so `session run` reaches the abe its boot installs, not the one it woke
   * on. A box that stays on its own release is then launched on as it is.
   */
  const awaitRelease = async (
    box: Pick<Box, 'name' | 'launchedAt'>,
    served: Outcome<StatusData>,
    until: number,
  ): Promise<void> => {
    const booted = Date.parse(box.launchedAt ?? '');

    if (o.version === undefined || Number.isNaN(booted)) return;
    const by = Math.min(until, booted + RELEASE_MS);
    let now = served;

    for (
      let tries = Math.ceil(RELEASE_MS / pollMs);
      tries > 0 && now.ok && abeSkewed(now.data.version, o.version) && o.clock.now() < by;
      tries -= 1
    ) {
      await o.sleep(pollMs);
      now = await onBox(StatusData, box.name, ['status'], by);
    }
  };

  /**
   * One placement at a time (a launch's, the queue's): from reading the boxes to EC2's answer
   * to the create or start, so two launches never both take the last room.
   */
  let placing: Promise<unknown> = Promise.resolve();
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = placing.then(run);

    placing = next.catch(() => undefined);

    return next;
  };

  /**
   * EC2 asked to make the repo's box `name` (ADR 0022) at its `box.size`, kept as made until EC2
   * lists it.
   */
  const makeBox = async (ask: { repo: string }, name: string, where: string | null) => {
    const sized = o.sizeAt?.(where);
    const answered = await o.boxes.up(
      boxSpec({
        name,
        repo: ask.repo,
        ...(sized === undefined ? {} : { size: sized.size, maxSize: sized.max }),
        profile: o.profileAt?.(where) ?? null,
      }),
    );

    if (answered.ok) remember(answered.data);

    return answered;
  };

  /**
   * Asks EC2 to make the card's box (under `serially`: it counts from now on); a wake or a use
   * asks nothing here (a wake counts from its decision: `waking`).
   */
  const kick = async (start: CloudMeta, how: 'create' | 'wake' | 'use') => {
    if (how !== 'create') return undefined;
    try {
      return await makeBox(start, start.box, start.where);
    } catch (e) {
      // Not brought up after all: settled from EC2's view again.
      coming.delete(start.id);
      throw e;
    }
  };

  /**
   * The card's session its box runs still though this Mac ended it (#243: ended from a look at EC2
   * that did not list its box yet, or by a serve restarted while it came up), found when `start`'s
   * `session run` is refused as the card's: this Mac's own again, as the box has it, said on the
   * watch (`picked-up`), and `start` given up for it (said ended, `superseded`, then forgotten).
   * `undefined`: none of ours (another Mac's, or a Move to cloud, whose work must not be dropped).
   */
  const pickUp = async (
    start: CloudMeta,
    until: number,
  ): Promise<Outcome<SessionData> | undefined> => {
    if (start.moveIn !== null) return undefined;
    const there = await onBox(SessionListData, start.box, ['session', 'list'], until);

    if (!there.ok) return undefined;
    const live = there.data.sessions.find(
      (x) =>
        x.id !== start.id && x.card === start.card && x.repo === start.repo && holdsBox(x.state),
    );
    const was = live === undefined ? undefined : known.get(live.id);

    if (live === undefined || was?.state !== 'ended' || was.box !== start.box) return undefined;
    // Still ours to show: never a moved or cleared one. A plain one picked up by a Factory run's
    // launch (or the other way round) is opened as it is, never a second session beside it (#343).
    if (was.moved !== null || was.cleared) return undefined;
    const back = move(
      {
        ...was,
        reason: null,
        stopped: false,
        worktree: live.worktree,
        branch: live.branch,
        transcriptPath: live.transcriptPath ?? was.transcriptPath,
        models: live.models ?? was.models,
        skillsOnTop: live.skillsOnTop,
      },
      live.state,
      'picked-up',
      live.since,
    );
    o.emit(
      { id: start.id, card: start.card, state: 'ended', since: stamp(), cause: 'superseded' },
      start.box,
    );
    known.delete(start.id);
    removeCloudRecord(o.stateDir, start.id);

    return { ok: true, data: dataOf(back) };
  };

  /**
   * The placed launch: EC2 made the box (`made`) or it is woken (`how`), its workspace up,
   * `claude` in it.
   */
  const bringUp = async (
    start: CloudMeta,
    made: Answered<Box> | undefined,
    how: 'create' | 'wake' | 'use',
    /** A Reopen (#343): the box's serve resumes the session it keeps, `message` its first prompt. */
    reopen?: { message?: string | undefined },
  ): Promise<Outcome<SessionData>> => {
    coming.add(start.id);
    // A Move to cloud that did not land leaves nothing on the box it woke or made (#189): stopped
    // again, its disk kept, as a download stops its box. A box that ran already is left running.
    const failed = (code: string, message: string) => {
      const out = fail(start, code, message);

      if (start.moveIn !== null && how !== 'use')
        void o.front.stop(start.box).catch(() => undefined);

      return out;
    };
    try {
      const until = o.clock.now() + bootMs;

      if (made !== undefined && !made.ok) return fail(start, made.error.code, made.error.message);
      // The box this launch makes or wakes, said as `box.state` too (#142): the Boxes widget's.
      if (how !== 'use') o.front.said(start.box, 'starting', 'launch');
      // A woken box started (a stop in progress first); a made one waited for until EC2 lists it.
      if (how === 'wake') await sizeUp(start.box, start.where);
      const box =
        how === 'wake'
          ? await startBox(settling, start.box, until)
          : await settleBox(settling, start.box, 'running', until, true);

      // A box that did not come up is said failed too, as its `starting` was (#142).
      const down = (e: { code: string; message: string }) => {
        if (how !== 'use') o.front.said(start.box, 'failed', 'launch');

        return failed(e.code, e.message);
      };

      if (how === 'wake') woken(start.box);
      if (!box.ok) return down(box.error);
      const step = (s: EventData<'box.step'>['step']) =>
        o.step?.({ box: start.box, step: s, session: start.id });

      // EC2 runs it: its serve waited for first (boot, a new box's tools), so the progress line
      // (#193) and the launch's step (#142) say which step it is on.
      stepTo(start.id, (l) => launchStepped(l, 'box-booting', stamp()));
      if (how !== 'use') step('booting');
      const served = await o.front.booting(start.box, () =>
        onBox(StatusData, start.box, ['status'], until),
      );

      // Past the deadline with no serve: said as that, not as `workspace up`'s failure.
      if (!served.ok && notYet(served)) return down(served.error);
      await awaitRelease(box.data, served, until);
      if (how !== 'use') o.front.said(start.box, 'running', 'launch');
      // Followed once its serve answers (before that the stream would retry every second), so its
      // workspace's steps reach this serve as they happen (#142) and claude's first hooks too.
      follow(start.box);
      stepTo(start.id, (l) => launchStepped(l, 'workspace', stamp()));
      step('workspace');
      const up = await onBox(
        WorkspaceData,
        start.box,
        [
          'workspace',
          'up',
          '--repo',
          start.repo,
          '--card',
          keyOf(start),
          // a prototype's own branch, its pushes refused there; a card's from its title
          ...(start.prototype === null ? ['--title', start.title] : ['--branch', start.branch]),
        ],
        until,
      );

      if (!up.ok) return failed(up.error.code, up.error.message);
      // Move to cloud (#88): the moved work into the clone before claude resumes on it.
      if (start.moveIn !== null && start.moveIn.pack !== null) {
        const copied = await o.mover.unpack({
          exec: inWorkspace(boxAttach, start.box, containerOn(start.box, keyOf(start))),
          root: CONTAINER.workdir,
          pack: start.moveIn.pack,
          files: start.moveIn.files,
          branch: start.branch,
          log: start.resume?.transcript ?? null,
          stash: `abe: the clone before ${start.id} moved in`,
        });

        if (!copied.ok)
          return failed(
            copied.error.code,
            `the box could not take the pack: ${copied.error.message}`,
          );
        rmSync(start.moveIn.pack, { force: true });
        keep({ ...(known.get(start.id) ?? start), moveIn: { ...start.moveIn, pack: null } });
      }
      // A prototype card's run (#351): its reference in the clone before its first stage.
      const ref = (known.get(start.id) ?? start).reference;

      if (reopen === undefined && ref !== null && ref.files !== null) {
        const put = await o.mover.put({
          exec: inWorkspace(boxAttach, start.box, containerOn(start.box, keyOf(start))),
          root: CONTAINER.workdir,
          dir: ref.run.dir,
          from: ref.files,
        });

        if (!put.ok)
          return failed(
            'reference-failed',
            `the box could not take AB#${start.card}'s prototype reference: ${put.error.message}`,
          );
        keep({ ...(known.get(start.id) ?? start), reference: referenceDropped(ref) });
      }
      // Box parity (3.2.1): this Mac's team files, yours, the env files, tokens and keys first.
      const synced = await syncInto(start);

      stepTo(start.id, (l) => launchStepped(l, 'claude-starting', stamp()));
      step('claude');
      const ran = await onBox(
        SessionData,
        start.box,
        [
          'session',
          'run',
          '--id',
          start.id,
          '--repo',
          start.repo,
          ...(start.card === null ? [] : ['--card', String(start.card)]),
          ...(start.prototype === null || start.proto === null
            ? []
            : [
                '--prototype',
                JSON.stringify({
                  id: start.prototype.id,
                  card: start.prototype.card,
                  words: start.proto.words,
                  branch: start.branch,
                  base: start.proto.base,
                  commit: start.proto.commit,
                }),
              ]),
          '--text',
          JSON.stringify({
            title: start.title,
            description: start.description,
            acceptanceCriteria: start.criteria,
            comments: start.comments,
            note: start.note,
            standing: start.standing,
            type: start.type,
            tags: start.tags,
            workflow: start.workflow,
          } satisfies CardText),
          // a reopen's run goes on as its box keeps it: never decided again
          ...(start.factory && reopen === undefined ? ['--factory'] : []),
          // its files are in the clone already: the run's record and words go with it (#351)
          ...(start.factory && reopen === undefined && start.reference !== null
            ? [
                '--reference',
                JSON.stringify({ run: start.reference.run, prompt: start.reference.prompt }),
              ]
            : []),
          ...(reopen === undefined
            ? []
            : ['--reopen', ...(reopen.message === undefined ? [] : ['--message', reopen.message])]),
          ...(start.browserProfile === DEFAULT_PROFILE ? [] : ['--profile', start.browserProfile]),
          ...(o.layer === undefined ? [] : ['--layer', JSON.stringify(o.layer(start.where))]),
          ...(synced === undefined ? [] : ['--sync', JSON.stringify(synced.told)]),
          ...(start.resume === null
            ? []
            : [
                '--resume',
                start.resume.claudeSession,
                '--transcript',
                start.resume.transcript,
                '--from',
                start.resume.from,
              ]),
        ],
        until,
      );

      if (!ran.ok) {
        // a reopen is never given up for another session of the card (it stays as it ended)
        const back =
          ran.error.code === 'card-has-session' && reopen === undefined
            ? await pickUp(start, until)
            : undefined;

        return back ?? failed(ran.error.code, ran.error.message);
      }
      const now = known.get(start.id) ?? start;
      const merged: CloudMeta = {
        ...now,
        worktree: ran.data.worktree,
        branch: up.data.branch,
        transcriptPath: ran.data.transcriptPath ?? now.transcriptPath,
        models: ran.data.models,
        skillsOnTop: ran.data.skillsOnTop,
        // a reopen's, as the box's serve kept them (#343)
        reopened: ran.data.reopened,
      };

      keep(merged);
      // The box's own events may not have come yet: its state then is the one it answered. Once
      // they came, they are newer than that answer (the box's clock, not this Mac's, says when).
      const moved =
        merged.state === 'starting'
          ? move(merged, ran.data.state, 'launch', ran.data.since)
          : merged;

      return { ok: true, data: dataOf(moved) };
    } finally {
      coming.delete(start.id);
    }
  };

  /** What each session's workspace last got of this Mac's (3.2.1): its mark and when it is due. */
  const syncs = new Map<string, { mark: string; due: number | null }>();
  /** The sessions a sync is going to now. */
  const syncing = new Set<string>();

  /**
   * This Mac's files, tokens and keys into the session's workspace (3.2.1, `BoxSyncer`): built and
   * pushed on stdin; `undefined` when there is no syncer or it did not go (said, never its values).
   */
  const syncInto = async (m: CloudMeta, turn = false): Promise<BuiltSync | undefined> => {
    if (o.sync === undefined || syncing.has(m.id)) return undefined;
    syncing.add(m.id);
    try {
      return await syncNow(o.sync, m, turn);
    } finally {
      syncing.delete(m.id);
    }
  };
  const syncNow = async (
    sync: BoxSyncer,
    m: CloudMeta,
    turn: boolean,
  ): Promise<BuiltSync | undefined> => {
    const built = await sync.build(m.where);

    if (!built.ok) {
      o.log?.(`${m.id}: box sync not built: ${built.error.message}`);

      return undefined;
    }
    const pushed = await sync.push(
      inWorkspace(boxAttach, m.box, containerOn(m.box, keyOf(m))),
      built.data,
    );

    if (!pushed.ok) {
      o.log?.(`${m.id}: box sync not sent: ${pushed.error.message}`);

      return undefined;
    }
    syncs.set(m.id, { mark: built.data.mark, due: built.data.due });
    // a turn's: the box checkout takes this Mac's abe.yaml too (a launch's `session run --sync`)
    if (turn) {
      const told = await o.link.run(m.box, [
        'session',
        'sync',
        '--repo',
        m.repo,
        '--sync',
        JSON.stringify(built.data.told),
        '--json',
      ]);

      if (told.exit !== 0)
        o.log?.(`${m.id}: the box's checkout did not take the sync (exit ${told.exit})`);
    }

    return built.data;
  };

  /** Whether a session's tokens or keys want sending again now (one sync at a time each). */
  const dueNow = (id: string) => {
    const due = syncs.get(id)?.due;

    return due !== undefined && due !== null && o.clock.now() >= due && !syncing.has(id);
  };

  /** Before a turn: synced again when this Mac's files changed, or a token or key is due. */
  const syncIfChanged = async (m: CloudMeta) => {
    if (o.sync === undefined) return;
    const was = syncs.get(m.id);
    const moved = was?.mark !== (await o.sync.mark(m.where));

    if (moved || dueNow(m.id)) await syncInto(m, true);
  };

  /**
   * A box woken below its repo's `box.size` (#344) resized first, while it still sleeps (a resize
   * is EC2's while stopped); a box at it or larger, one stopping, or a resize EC2 refuses: woken as
   * it is.
   */
  const sizeUp = async (box: string, where: string | null) => {
    const sized = o.sizeAt?.(where);

    if (sized === undefined) return;
    const target = startSize(sized.size, sized.max);
    const now = await o.boxes.status(box);

    if (!now.ok || now.data?.state !== 'stopped') return;
    // a size not of abe's list (set by hand) is left as it is: it may well be larger
    const was = boxSizeRank(now.data.size);

    if (was < 0 || boxSizeRank(target) <= was) return;
    await o.boxes.resize(box, target);
  };

  /**
   * A placed box brought up (`box.state` `starting`, then `running` once its serve answers): the
   * one just `made` followed (never made twice), else the repo's own woken (sized up first).
   */
  const bringPlaced = async (box: string, made: Box | undefined, where: string | null) => {
    try {
      if (made === undefined) await sizeUp(box, where);

      return await (made === undefined ? o.front.start(box) : o.front.made(made, 'up'));
    } finally {
      woken(box);
    }
  };

  /**
   * The queue's head placed (under `serially`) when it fits now: a launch's record starting and
   * its box asked for, a held place's box asked for. What then brings it up, or `undefined` while
   * the head still waits.
   */
  const placeHead = async (): Promise<(() => Promise<unknown>) | undefined> => {
    const done = () => Promise.resolve();
    const next = waiting()[0];

    if (next === undefined) return undefined;
    const listed = await placeable();

    if (!listed.ok) return undefined;
    // Stopped or ended while EC2 was asked (#234): out of the queue already, the next one looked at.
    if (next.kind === 'launch' && known.get(next.meta.id)?.state !== 'queued') return done;
    const ask = next.kind === 'launch' ? next.meta : next.held;
    const limit = next.kind === 'launch' ? limitOf(next.meta) : o.limitAt(next.held.where);
    const at = placeNow({ boxes: listed.data, repo: ask.repo, limit, ahead: 0 });

    if (at.kind === 'queue') return undefined;
    if (next.kind === 'place') {
      const h = next.held;

      if (at.kind === 'refused') {
        dropPlace(h);
        o.front.said(h.box, 'failed', `dequeued: ${at.code}`);

        return done;
      }
      // Held (a Queued row of `box list`) until EC2 answered the make: the box is `made` from then.
      const made = at.kind === 'create' ? await makeBox(h, at.box, h.where) : undefined;

      dropPlace(h);
      if (made !== undefined && !made.ok) {
        o.front.said(at.box, 'failed', `dequeued: ${made.error.code}`);

        return done;
      }
      const box = at.box;

      return at.kind === 'use' ? done : () => bringPlaced(box, made?.data, h.where);
    }
    if (at.kind === 'refused') {
      move({ ...next.meta, neverPlaced: true }, 'ended', `launch-failed: ${at.code}`);

      return done;
    }
    const how = at.kind;

    coming.add(next.meta.id);
    const starting = begin(move(next.meta, 'starting', 'dequeued'), how, listed.data);
    const made = await kick(starting, how);

    return () => bringUp(starting, made, how);
  };

  // The queue: its oldest request is placed once it fits (a box stopped or deleted, the limit risen), then
  // the next, while they fit; each brought up on its own. A look asked for while one runs makes
  // it look once more, so a limit raised meanwhile is not left to the timer.
  // An object, so a check after an `await` reads what another call set meanwhile.
  const looking = { now: false, again: false };
  const lookAgain = () => looking.again && !closed;
  const dequeue = async () => {
    if (closed) return;
    if (looking.now) {
      looking.again = true;

      return;
    }
    looking.now = true;
    try {
      do {
        looking.again = false;
        for (;;) {
          const bring = await serially(placeHead);

          if (bring === undefined) break;
          void bring().catch(() => undefined);
        }
      } while (lookAgain());
    } finally {
      looking.now = false;
    }
  };
  const queueTimer = setInterval(() => {
    void dequeue();
  }, o.queuePollMs ?? 15_000);

  /**
   * A session ended with its box (#192): one that waited on you says its box went to sleep
   * then, and how to go on (`boxStoppedReason`). `slept`: the box went down on its own, not by
   * a `box stop` / `box terminate` here.
   */
  const endWithBox = (m: CloudMeta, onItsOwn: boolean, gone = false) => {
    const slept = onItsOwn && m.state === 'waiting';
    const reason = boxStoppedReason({ id: m.id, box: m.box, waiting: slept, gone });
    const cause = slept ? 'box-slept' : 'box-stopped';

    // the reason rides the event too, so a screen says why at once (#316)
    move({ ...m, reason }, 'ended', gone ? 'box-gone' : cause, stamp(), false, reason);
  };

  /** Sessions whose box EC2 says sleeps (or is gone) ended with it. */
  const settle = async () => {
    const holds = (m: CloudMeta | undefined): m is CloudMeta =>
      m !== undefined && holdsBox(m.state) && !coming.has(m.id);
    const open = [...known.values()].filter(holds);

    if (open.length === 0) return;
    const listed = await boxes();

    if (!listed.ok) return;
    for (const was of open) {
      // As it is now: one that came up or ended meanwhile is not ended from the older look.
      const m = known.get(was.id);

      if (!holds(m)) continue;
      const box = listed.data.find((b) => b.name === m.box);

      // Gone, or stopped from here: the box did not sleep. Down otherwise: its idle stop (one
      // missed while this serve was not following it).
      if (box === undefined || box.state === 'terminated' || box.state === 'shutting-down')
        endWithBox(m, false, true);
      else if (bootState(box.state) === 'down') endWithBox(m, !o.front.stoppedHere(m.box));
    }
  };

  type Placed = { meta: CloudMeta; made?: Answered<Box> | undefined; how: PlaceAction };
  /** Its running box short, answered `--short resize`: resized to `size` first, then launched. */
  type Resizing = { resize: { box: string; size: string; max: string } };

  /** The launch's question as its refusal (`box-short`), the choices with it for a screen. */
  const shortRefusal = (ask: BoxShortAsk): Outcome<never> => ({
    ok: false,
    error: { code: 'box-short', message: launchShortText(ask), boxShort: ask },
  });

  /**
   * Whether a launch onto running `box` asks first (core's `launchShortAsk`), its load read from
   * the box's `workspace status` within `SHORT_READ_MS`: a load not read never holds it up.
   */
  const shortOn = async (box: Box | undefined, where: string | null) => {
    if (box?.state !== 'running') return undefined;
    const read = await within(
      forward(o.link, WorkspaceList, box.name, ['workspace', 'status']),
      SHORT_READ_MS,
    );

    if (read?.ok !== true || read.data.load === undefined) return undefined;
    const max = o.sizeAt?.(where).max ?? box.size;
    const working = holding(box.name)
      .filter((m) => m.state === 'working')
      .flatMap((m) => (m.card === null ? [] : [m.card]))
      .sort((a, b) => a - b)
      .map(String);

    return {
      max,
      ask: launchShortAsk(read.data.load, {
        box: box.name,
        size: box.size,
        max,
        workspaces: read.data.workspaces.length,
        working,
      }),
    };
  };

  /**
   * The launch's reference files copied into `<state>/cloud/<id>.reference`: the held folder is the
   * launch's to drop, and a Queued run goes up later (after a restart too).
   */
  const keptReference = (
    id: string,
    r: CloudReference | undefined,
  ): Outcome<CloudMeta['reference']> => {
    if (r === undefined) return { ok: true, data: null };
    const files = join(cloudDir(o.stateDir), `${id}.reference`);

    try {
      rmSync(files, { recursive: true, force: true });
      cpSync(r.files, files, { recursive: true });
    } catch (err) {
      rmSync(files, { recursive: true, force: true });

      return refused(
        'reference-failed',
        `the prototype reference did not copy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { ok: true, data: { run: r.run, prompt: r.prompt, files } };
  };

  /**
   * One launch placed (under `serially`): Queued, or its record kept and EC2 asked to make or
   * wake the box (`made`: its answer; none when the box runs already).
   */
  const place = async (
    card: CardDetail,
    repo: string,
    where: string,
    factory: boolean,
    moved?: MovedIn,
    profile: string = DEFAULT_PROFILE,
    setup: LaunchSetup = {},
    reference?: CloudReference,
    short?: ShortAnswer,
  ): Promise<Outcome<Placed | Resizing>> => {
    const admitted = admit(card.id, repo, moved?.id);

    if (!admitted.ok) return admitted;
    const listed = await placeable();

    if (!listed.ok) return listed;
    const id = moved?.id ?? freshId(card.id);
    const now = stamp();
    const draft: CloudMeta = withKind({
      v: 1,
      id,
      card: card.id,
      prototype: null,
      title: card.title,
      description: card.description,
      criteria: card.acceptanceCriteria,
      comments: card.comments,
      type: card.type,
      tags: [...card.tags],
      repo,
      worktree: CONTAINER.workdir,
      branch: cardBranch(String(card.id), card.title),
      box: '',
      state: 'starting',
      since: now,
      startedAt: now,
      transcriptPath: null,
      lastAssistantMessage: null,
      // The box's, once its session runs.
      models: null,
      subagents: [],
      reason: null,
      stopped: false,
      setup: null,
      // The box's, once its session runs.
      skillsOnTop: false,
      browserProfile: profile,
      overrides: [],
      queue: [],
      model: null,
      effort: null,
      launch: null,
      reopened: [],
      rounds: 0,
      waitingOn: null,
      where,
      factory,
      note: setup.note ?? null,
      standing: [...(setup.standing ?? [])],
      workflow: setup.workflow ?? null,
      run: null,
      cleared: false,
      neverPlaced: false,
      moved: null,
      moveIn:
        moved === undefined
          ? null
          : { pack: moved.pack, files: moved.files, worktree: moved.worktree },
      resume: moved?.resume ?? null,
      reference: null,
      proto: null,
    });
    const at = placeNow({
      boxes: listed.data,
      repo,
      limit: o.limitAt(where),
      ahead: waiting().length,
    });

    if (at.kind === 'refused') return refused(at.code, at.message);
    // ADR 0022: onto its repo's box short of memory or disk it stops and asks, never Queued and
    // never a second box (a woken or made box has room).
    if (at.kind === 'use' && short !== 'anyway') {
      const read = await shortOn(
        listed.data.find((b) => b.name === at.box),
        where,
      );
      const ask = read?.ask;

      if (read !== undefined && ask !== undefined) {
        if (short === 'resize' && ask.resize !== null)
          return { ok: true, data: { resize: { box: ask.box, size: ask.resize, max: read.max } } };

        return shortRefusal(ask);
      }
    }
    const kept = keptReference(id, reference);

    if (!kept.ok) return kept;
    const meta = { ...draft, box: at.box, reference: kept.data };

    if (at.kind === 'queue') {
      // Why, as `box place` says it (#194): the boxes that count and the limit.
      const counting = listed.data.filter((b) => BOX_COUNTED.has(b.state)).map((b) => b.name);
      const queued = {
        ...meta,
        state: 'queued' as const,
        queuedFor: { boxes: counting.sort(), limit: at.limit },
      };

      keep(queued);
      o.emit({ id, card: card.id, state: 'queued', since: now, cause: 'queued' }, meta.box);

      return { ok: true, data: { meta: queued, how: at.kind } };
    }
    // Coming up from here on: a read meanwhile never ends it for a box EC2 does not list yet.
    coming.add(id);
    keep(meta);
    o.emit({ id, card: card.id, state: 'starting', since: now, cause: 'launch' }, meta.box);
    const begun = begin(meta, at.kind, listed.data);
    const made = await kick(begun, at.kind);

    return { ok: true, data: { meta: begun, made, how: at.kind } };
  };

  /**
   * Its box's session runs: past the queue and brought up (its models are the box's answer). A
   * box's session is `starting` itself until its claude runs a hook (#190), brought up or not.
   */
  const started = (m: CloudMeta) =>
    !m.neverPlaced && m.state !== 'queued' && (m.state !== 'starting' || m.models !== null);

  /** A queued launch's run as this Mac holds it: at decide, as its box's would start. */
  const queuedRun = (m: CloudMeta): Run =>
    newRun({
      session: m.id,
      // a run is always a card's (a prototype's session has none)
      card: m.card ?? 0,
      title: m.title,
      repo: m.repo,
      // no box has it: the checkout it was launched from, whose settings its card is read with
      worktree: m.where ?? m.worktree,
      at: m.startedAt,
      ...(m.workflow === null ? {} : { workflow: m.workflow }),
    });

  /**
   * A Factory run taken out of the queue (#234): its session ended by your hand, its run `run`
   * kept here and said, so the card and Chat say so at once; no box is woken for it.
   */
  const takeOut = (m: CloudMeta, run: Run, cause: string): CloudMeta => {
    const data = runData(run, 'ended');
    const was = known.get(m.id) ?? m;
    const kept: CloudMeta = { ...was, run: data, neverPlaced: true, stopped: true };
    const next = was.state === 'ended' ? kept : move(kept, 'ended', 'stop');

    if (next === kept) keep(kept);
    // As a run's own move says it: from the stage it left, in the state its ended session gives.
    const event = stageEventOf(queuedRun(m), was.state, run, 'ended', cause);

    if (event !== null) o.emitStage?.(event, m.box);

    return next;
  };

  /** Ended on this Mac (#234): the run never reached its box. */
  const endHere = (m: CloudMeta, as: Ending, reason: string): Outcome<EndedHere> => {
    if (m.run?.outcome !== null && m.run?.outcome !== undefined)
      return refused('run-done', `AB#${m.card}'s run is done already`);
    const stepped = stepRun(queuedRun(m), { type: 'end', as, reason }, stamp());

    if (!stepped.ok) return refused(stepped.code, stepped.message);
    const queued = m.state === 'queued';

    takeOut(m, stepped.run, 'end');

    return {
      ok: true,
      data: {
        run: stepped.run,
        session: queued ? `${m.id} taken out of the queue for ${m.box}` : `${m.id} ended already`,
      },
    };
  };

  /** What a launch on `card` is refused for before any box is asked; `id`: a moved session's own. */
  const admit = (card: number, repo: string, id: string | undefined): Outcome<null> => {
    const busy = [...known.values()].find(
      (m) => m.card === card && m.repo === repo && OPEN.has(m.state),
    );

    if (busy !== undefined) return refused('card-has-session', cardHasSession(card, busy.id, repo));
    // A session moved here earlier and away again comes back under its own id.
    if (id !== undefined && known.has(id) && known.get(id)?.moved === null)
      return refused('session-exists', `session ${id} is on its box already`);

    return { ok: true, data: null };
  };

  /**
   * Reopen (#343) on its box: an ended session of a card goes on there, its box woken first when
   * it sleeps (the launch steps, as a launch's), then `workspace up` and the box's `session run
   * --reopen`. Refused for a live one, one that never got a box or never started a conversation,
   * while another session of the card runs, at the limit (`box-limit`), and when its box is gone
   * (`box-gone`). One that did not come up stays as it ended.
   */
  const reopen = async (
    id: string,
    message?: string,
    short?: ShortAnswer,
  ): Promise<Outcome<SessionData>> => {
    await settle();
    const was = known.get(id);

    if (was?.moved !== null) return unknown(id);
    if (was.neverPlaced) return neverPlacedRefusal(id);
    if (was.state !== 'ended' || coming.has(id))
      return refused(
        'not-ended',
        `session ${id} is ${was.state}: attach it (abe session attach ${id})`,
      );
    if (was.transcriptPath === null)
      return refused(
        'no-conversation',
        `session ${id} never started a conversation (its claude ran no hook): Retry run starts its card again`,
      );
    // onto its box running short (ADR 0022): asked as a launch is; a box asleep wakes with room
    const asked = await shortCheck(was.box, was.where, short);

    if (!asked.ok) return asked;
    const placed = await serially(
      async (): Promise<Outcome<{ start: CloudMeta; how: 'wake' | 'use' }>> => {
        // under `serially`: a launch placed meanwhile holds the card as this one would
        const busy = [...known.values()].find(
          (m) => m.id !== id && m.card === was.card && m.repo === was.repo && OPEN.has(m.state),
        );

        if (busy !== undefined && was.card !== null)
          return refused('card-has-session', cardRunningText(was.card, busy.id));
        const listed = await placeable();

        if (!listed.ok) return listed;
        const at = placeWake({
          boxes: listed.data,
          box: was.box,
          limit: limitOf(was),
          ahead: waiting().length,
        });

        if (at === undefined || at.kind === 'refused' || at.kind === 'create')
          return refused('box-gone', boxGoneText(was.box));
        if (at.kind === 'queue') return refused('box-limit', boxLimitMessage(at));
        if (at.kind === 'wake') wakes(at.box);
        coming.add(id);
        const starting = move(
          // a moved-in one landed long ago: nothing to copy in or resume from a pack now
          { ...was, reason: null, stopped: false, launch: null, moveIn: null, resume: null },
          'starting',
          'reopen',
        );

        return { ok: true, data: { start: begin(starting, at.kind, listed.data), how: at.kind } };
      },
    );

    if (!placed.ok) return placed;
    const { start, how } = placed.data;
    const out = await bringUp(start, undefined, how, { message });

    // One that did not come up: as it ended, its reason and record as they were.
    if (!out.ok) {
      keep(was);
      // said as it is again, so a screen that took the failed launch's end shows it as it ended
      o.emit(
        {
          id,
          card: was.card,
          state: 'ended',
          since: was.since,
          cause: 'reopen-failed',
          ...(was.reason === null ? {} : { reason: was.reason }),
        },
        was.box,
      );
    }

    return out;
  };

  /**
   * A Reopen's or a Move to cloud's question (ADR 0022), outside `serially`: onto running `box`
   * short it is refused `box-short`; `resize` resizes it first (its sessions end, asked already);
   * `anyway`, no box or a load not read asks nothing.
   */
  const shortCheck = async (
    box: string | undefined,
    where: string | null,
    short: ShortAnswer | undefined,
  ): Promise<Outcome<null>> => {
    if (short === 'anyway' || box === undefined) return { ok: true, data: null };
    const listed = await placeable();

    if (!listed.ok) return listed;
    const read = await shortOn(
      listed.data.find((b) => b.name === box),
      where,
    );
    const ask = read?.ask;

    if (read === undefined || ask === undefined) return { ok: true, data: null };
    if (short !== 'resize' || ask.resize === null) return shortRefusal(ask);
    const resized = await resizeNow({
      box: ask.box,
      size: ask.resize,
      max: read.max,
      yes: true,
      ...(where === null ? {} : { where }),
    });

    return resized.ok ? { ok: true, data: null } : resized;
  };

  /**
   * `abe box resize`, and a launch's Resize: under `serially`, so no launch uses or wakes the box
   * between its stop and its start.
   */
  const resizeNow = (ask: ResizeAsk): Promise<Outcome<BoxResizeData>> =>
    serially(() =>
      resizeBox(
        {
          boxes: o.boxes,
          link: o.link,
          clock: o.clock,
          sleep: o.sleep,
          pollMs,
          bootMs,
          openHere: (box) => holding(box).map((m) => m.id),
          // Under `serially` already: nothing else places meanwhile, so no wake to mark.
          room: async (asleep) => {
            const at = await wakeNow(ask.where ?? process.cwd(), asleep);

            return at.ok ? { ok: true, data: null } : at;
          },
          stopped: (box) => {
            for (const m of holding(box)) move(m, 'ended', 'box-resized');
          },
        },
        ask,
      ),
    );

  /**
   * A prototype session on the repo's box (`abe prototype start` where `serve.target` is cloud):
   * placed as a launch is (used, woken or made), its workspace keyed by the prototype's id on its
   * `proto/…` branch, then the box's `session run --prototype`. At the limit it is Queued as a
   * card's launch is, brought up from the queue once room frees.
   */
  const prototype: CloudSessions['prototype'] = async (p, repo, where) => {
    await settle();
    const placed = await serially(
      async (): Promise<
        Outcome<{
          meta: CloudMeta;
          made: Answered<Box> | undefined;
          how: PlaceAction;
        }>
      > => {
        const listed = await placeable();

        if (!listed.ok) return listed;
        const at = placeNow({
          boxes: listed.data,
          repo,
          limit: o.limitAt(where),
          ahead: waiting().length,
        });

        if (at.kind === 'refused') return refused(at.code, at.message);
        const id = freshId(p.id);
        const now = stamp();
        const meta: CloudMeta = withKind({
          v: 1,
          id,
          card: p.card?.id ?? null,
          prototype: { id: p.id, card: p.card?.id ?? null },
          title: p.title,
          description: p.card?.description ?? p.words,
          criteria: p.card?.acceptanceCriteria ?? '',
          comments: p.card?.comments ?? [],
          type: p.card?.type ?? '',
          tags: [...(p.card?.tags ?? [])],
          repo,
          worktree: CONTAINER.workdir,
          branch: p.branch,
          box: at.box,
          state: 'starting',
          since: now,
          startedAt: now,
          transcriptPath: null,
          lastAssistantMessage: null,
          models: null,
          subagents: [],
          reason: null,
          stopped: false,
          setup: null,
          skillsOnTop: false,
          browserProfile: DEFAULT_PROFILE,
          overrides: [],
          queue: [],
          model: null,
          effort: null,
          launch: null,
          reopened: [],
          rounds: 0,
          waitingOn: null,
          where,
          factory: false,
          asked: null,
          note: null,
          standing: [],
          workflow: null,
          run: null,
          cleared: false,
          neverPlaced: false,
          moved: null,
          moveIn: null,
          resume: null,
          reference: null,
          proto: { words: p.words, base: p.base, commit: p.commit },
        });

        if (at.kind === 'queue') {
          // why, as a card's Queued launch says it (#194): the boxes that count and the limit
          const counting = listed.data.filter((b) => BOX_COUNTED.has(b.state)).map((b) => b.name);
          const queued: CloudMeta = {
            ...meta,
            state: 'queued',
            queuedFor: { boxes: counting.sort(), limit: at.limit },
          };

          keep(queued);
          o.emit({ id, card: null, state: 'queued', since: now, cause: 'queued' }, meta.box);

          return { ok: true, data: { meta: queued, made: undefined, how: 'queue' } };
        }
        coming.add(id);
        keep(meta);
        o.emit({ id, card: meta.card, state: 'starting', since: now, cause: 'launch' }, meta.box);
        const begun = begin(meta, at.kind, listed.data);

        return { ok: true, data: { meta: begun, made: await kick(begun, at.kind), how: at.kind } };
      },
    );

    if (!placed.ok) return placed;
    const { meta, made, how } = placed.data;

    return how === 'queue' ? { ok: true, data: dataOf(meta) } : bringUp(meta, made, how);
  };

  const launch = async (
    card: CardDetail,
    repo: string,
    where: string,
    factory: boolean,
    moved?: MovedIn,
    profile?: string,
    setup?: LaunchSetup,
    reference?: CloudReference,
    short?: ShortAnswer,
  ): Promise<Outcome<SessionData>> => {
    // A session whose box went to sleep has ended: it holds the card no more.
    await settle();
    const placed = await serially(() =>
      place(card, repo, where, factory, moved, profile, setup, reference, short),
    );

    if (!placed.ok) return placed;
    if ('resize' in placed.data) {
      // Resize was the answer: its sessions end with the stop (asked already), then it launches.
      const resized = await resizeNow({ ...placed.data.resize, yes: true, where });

      if (!resized.ok) return resized;

      return launch(card, repo, where, factory, moved, profile, setup, reference, 'anyway');
    }
    const { meta, made, how } = placed.data;

    return how === 'queue' ? { ok: true as const, data: dataOf(meta) } : bringUp(meta, made, how);
  };

  /** `abe box place`: decided (and a create asked of EC2) under `serially`, then brought up. */
  /**
   * Where the card's box goes now, by core's `placeRepo` over EC2's boxes and the queue (under
   * `serially`); a card already waiting in the queue stays there (`queued`). Only an `apply`
   * counts a wake it decides.
   */
  const decidePlace = async (
    ask: Omit<PlaceAsk, 'apply'>,
    apply: boolean,
  ): Promise<Outcome<{ placed: BoxPlaceData; queued: boolean }>> => {
    const listed = await placeable();

    if (!listed.ok) return listed;
    const queue = waiting();
    const limit = o.limitAt(ask.where);
    // The card waits in the queue already (a launch or a place): it stays where it is.
    const queued = queue.some((w) => {
      const r = w.kind === 'launch' ? w.meta : w.held;

      return r.repo === ask.repo && r.card === ask.card;
    });
    const at = placeNow(
      { boxes: listed.data, repo: ask.repo, limit, ahead: queue.length },
      !apply || queued,
    );

    if (at.kind === 'refused') return refused(at.code, at.message);
    const action = queued ? 'queue' : at.kind;

    return {
      ok: true,
      data: { placed: { box: at.box, action, boxes: at.count, limit }, queued },
    };
  };

  const claim: CloudSessions['claim'] = (ask) =>
    serially(async () => {
      const at = await decidePlace(ask, true);

      if (!at.ok) return at;
      const { placed } = at.data;

      if (placed.action === 'wake') await sizeUp(placed.box, ask.where);
      if (placed.action !== 'create') return { ok: true, data: { placed, made: undefined } };
      const answered = await makeBox(ask, placed.box, ask.where);

      return answered.ok
        ? { ok: true, data: { placed, made: answered.data } }
        : refused(answered.error.code, answered.error.message);
    });

  /**
   * Whether `asleep` may be woken now under the limit at `where` (core's `placeWake`): its
   * placement (`wake`, or `use` / none: nothing to count), or `box-limit` with the way on.
   */
  const wakeNow = async (
    where: string,
    asleep: Box,
  ): Promise<Outcome<{ wake: string } | undefined>> => {
    const listed = await placeable();

    if (!listed.ok) return listed;
    const limit = o.limitAt(where);
    const at = placeWake({ boxes: listed.data, box: asleep.name, limit, ahead: waiting().length });

    if (at === undefined || at.kind === 'use') return { ok: true, data: undefined };
    if (at.kind === 'refused') return refused(at.code, at.message);
    if (at.kind === 'wake') return { ok: true, data: { wake: at.box } };
    const card =
      asleep.card === null
        ? undefined
        : { card: asleep.card, ...(asleep.repo === null ? {} : { repo: asleep.repo }) };

    return refused('box-limit', boxLimitMessage(at, card));
  };

  const wakeRoom =
    (where: string): WakeRoom =>
    (asleep) =>
      serially(async (): Promise<Outcome<() => void>> => {
        const at = await wakeNow(where, asleep);

        if (!at.ok) return at;
        const woke = at.data?.wake;

        if (woke === undefined) return { ok: true, data: () => undefined };
        // It counts from this decision, as a placement's wake does, until its start is over.
        wakes(woke);
        // Below its repo's box.size: resized while it still sleeps (#344).
        await sizeUp(woke, where);

        return {
          ok: true,
          data: () => {
            woken(woke);
          },
        };
      });

  const placeAsk = async (ask: PlaceAsk): Promise<Outcome<BoxPlaceData>> => {
    const decided = await serially(
      async (): Promise<
        Outcome<{ data: BoxPlaceData; up: { made: Box | undefined } | undefined }>
      > => {
        const at = await decidePlace(ask, ask.apply);

        if (!at.ok) return at;
        const { placed: data, queued } = at.data;
        const kind = data.action;

        if (!ask.apply || queued) return { ok: true, data: { data, up: undefined } };
        if (kind === 'queue') {
          keepPlace({
            v: 1,
            kind: 'place',
            id: freshId(ask.card, 'place-'),
            repo: ask.repo,
            card: ask.card,
            title: ask.title,
            where: ask.where,
            box: data.box,
            state: 'queued',
            startedAt: stamp(),
          });
          o.front.said(data.box, 'queued', 'place');

          return { ok: true, data: { data, up: undefined } };
        }
        if (kind === 'use') return { ok: true, data: { data, up: undefined } };
        if (kind === 'wake') return { ok: true, data: { data, up: { made: undefined } } };
        const answered = await makeBox(ask, data.box, ask.where);

        return answered.ok
          ? { ok: true, data: { data, up: { made: answered.data } } }
          : refused(answered.error.code, answered.error.message);
      },
    );

    if (!decided.ok) return decided;
    const { data, up } = decided.data;

    if (up !== undefined) {
      const brought = await bringPlaced(data.box, up.made, ask.where);

      if (!brought.ok) return brought;
    }

    return { ok: true, data: { ...data, applied: ask.apply } };
  };

  /**
   * Runs ended here (#234) cleared after the next local midnight, as a box clears its Done runs
   * (#48): no longer listed.
   */
  const clearEndedHere = () => {
    const today = localDayStart(o.clock.now());

    for (const m of known.values())
      if (
        m.neverPlaced &&
        !m.cleared &&
        m.run !== null &&
        m.run.outcome !== null &&
        Date.parse(m.run.since) < today
      )
        keep({ ...m, cleared: true });
  };

  /** `card`'s run `m` ended on its box (#184); a sleeping box is not woken for it, as checks. */
  const endOnBox = async (
    m: CloudMeta,
    card: number,
    as: Ending,
    reason: string,
  ): Promise<Outcome<FactoryEndData>> => {
    const listed = await boxes();

    if (!listed.ok) return listed;
    if (!listed.data.some((b) => b.name === m.box && b.state === 'running'))
      return refused(
        'box-asleep',
        `${m.box} sleeps: AB#${card}'s run is ended there once it is awake (abe box start ${m.box})`,
      );
    const ended = await forward(o.link, FactoryEndData, m.box, [
      'factory',
      'end',
      String(card),
      '--as',
      as,
      '--reason',
      reason,
    ]);

    // Its run as the box now has it: done.
    if (ended.ok) keep({ ...(known.get(m.id) ?? m), run: ended.data.run });

    return ended;
  };

  /**
   * A run as known here: the box's last answer, else the one a pending launch will have. Its `repo`
   * is the launch's (`owner/repo`), never the box's checkout folder its serve keeps (#361): the
   * Board's card and End run… match a card's run by repo.
   */
  const runOf = (m: CloudMeta): FactoryRunData =>
    m.run !== null
      ? { ...m.run, repo: m.repo }
      : pendingRunData({
          session: m.id,
          // a run is always a card's (a prototype's session has none)
          card: m.card ?? 0,
          title: m.title,
          repo: m.repo,
          worktree: m.worktree,
          at: m.startedAt,
          queued: m.state === 'queued',
          workflow: m.workflow,
        });

  /**
   * Each box's `factory status` not answered yet, and when it was asked: a box slow to answer is
   * asked once, not again by every refresh meanwhile (its link's command would pile up). A refresh
   * joining an ask waits only what is left of that ask's `statusMs`; one out `STATUS_STALE` times
   * that long is given up on and the box asked anew (its link holds a hung one for 30 min).
   */
  const asking = new Map<string, { answer: Promise<Outcome<FactoryStatusData>>; at: number }>();
  const statusOf = (box: string): Promise<Outcome<FactoryStatusData> | undefined> => {
    const now = performance.now();
    const was = asking.get(box);

    if (was !== undefined && now - was.at < statusMs * STATUS_STALE)
      return within(was.answer, Math.max(0, was.at + statusMs - now));
    const ask = {
      answer: forward(o.link, FactoryStatusData, box, ['factory', 'status']).finally(() => {
        if (asking.get(box) === ask) asking.delete(box);
      }),
      at: now,
    };

    asking.set(box, ask);

    return within(ask.answer, statusMs);
  };

  /**
   * Each running box holding a run of ours asked for its runs, all at once (#327: at most
   * `STATUS_AT_ONCE`, each given `statusMs`); what each answers is kept as it answers, and the
   * read is over once every box answered or timed out. One that did not keeps its runs as last
   * heard. The boxes that answered.
   */
  const refresh = async (runs: CloudMeta[]): Promise<Set<string>> => {
    const heard = new Set<string>();
    const listed = runs.length === 0 ? undefined : await boxes();
    const up = new Set(
      listed?.ok === true
        ? listed.data.filter((b) => b.state === 'running').map((b) => b.name)
        : [],
    );
    const asked = [...new Set(runs.filter((m) => started(m)).map((m) => m.box))].filter((box) =>
      up.has(box),
    );

    await eachAtMost(asked, STATUS_AT_ONCE, async (box) => {
      const status = await statusOf(box);

      if (status?.ok !== true) return;
      heard.add(box);
      for (const m of runs.filter((r) => r.box === box && started(r))) {
        const now = known.get(m.id) ?? m;
        const found = status.data.runs.find((r) => r.session === m.id);

        // Its box no longer shows a run it had: cleared after its Done.
        if (found === undefined) {
          if (now.run !== null) keep({ ...now, cleared: true });
        } else keep({ ...now, run: found, cleared: false });
      }
      // An awake box carrying a run of ours is followed (again, after it slept); one with nothing
      // of ours left is let go.
      if (followed(box)) follow(box);
      else if (!closed) unfollow(box);
    });

    return heard;
  };

  /**
   * The runs of ours on boxes, oldest first: not ones that never started there or cleared; only
   * `here`'s repo's when it is named (#256).
   */
  const factoryRuns = (card?: number, here?: RepoHere) =>
    [...known.values()]
      .filter((m) => m.factory && !m.cleared && (card === undefined || m.card === card))
      .filter((m) => isHere(here, m.repo))
      .filter((m) => m.run !== null || m.state !== 'ended')
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : Number(a.startedAt > b.startedAt)));

  // A launch a stopped serve was bringing up is not carried on: it ended, the card is free again.
  for (const m of [...known.values()])
    if (m.state === 'starting' && m.models === null) move(m, 'ended', 'launch-interrupted');
  // A restarted serve follows the boxes of the sessions it still has open, and of its runs there.
  for (const m of known.values()) if (holdsBox(m.state) || carried(m)) follow(m.box);
  // Its old boxes known (ADR 0022) before an attach or move into one of its sessions' containers.
  if (known.size > 0) void boxes();

  return {
    launch: (card, repo, where, profile, setup, short) =>
      launch(card, repo, where, false, undefined, profile, setup, undefined, short),
    factoryRun: async (card, repo, where, profile, setup, reference, short) => {
      const launched = await launch(
        card,
        repo,
        where,
        true,
        undefined,
        profile,
        setup,
        reference,
        short,
      );

      if (!launched.ok) return launched;
      const m = known.get(launched.data.id);

      if (m === undefined) return unknown(launched.data.id);
      // the card's plain session its box ran still, picked up (#213, #343): it goes on, no run
      if (!m.factory) return refused('card-has-session', cardHasSession(card.id, m.id, repo));
      if (started(m)) await refresh([m]);

      return { ok: true, data: runOf(known.get(m.id) ?? m) };
    },
    runs: async (card) => {
      await settle();
      await refresh(factoryRuns(card));
      clearEndedHere();

      return factoryRuns(card).map(runOf);
    },
    checks: async (card, here) => {
      const m = factoryRuns(card, here).filter(started).at(-1);

      if (m === undefined) return undefined;
      // Asked only of a box EC2 says runs: checks never wake a sleeping one.
      const listed = await boxes();

      if (!listed.ok) return listed;
      if (!listed.data.some((b) => b.name === m.box && b.state === 'running'))
        return refused('box-asleep', `${m.box} sleeps: AB#${card}'s checks run once it is awake`);

      return forward(o.link, FactoryChecksData, m.box, ['factory', 'checks', String(card)]);
    },
    end: async (card, as, reason, here) => {
      // Its newest run not over yet: one ended here never hides an older one on a box.
      const runs = factoryRuns(card, here);
      const m = runs.filter((r) => runOf(r).outcome === null).at(-1) ?? runs.at(-1);

      if (m === undefined) return undefined;
      // Queued, or stopped there (#234): no box has it, so it ends here, its placement cancelled.
      if (m.state === 'queued' || m.neverPlaced)
        return { on: 'mac', ended: endHere(m, as, reason) };
      if (!started(m))
        return {
          on: 'box',
          ended: refused(
            'session-starting',
            `AB#${card}'s run is starting on ${m.box}: end it once it runs, or Stop… it now`,
          ),
        };
      const onBox = await endOnBox(m, card, as, reason);

      return { on: 'box', ended: onBox };
    },
    place: placeAsk,
    prototype,
    dropPrototype: async (box, id) => {
      const removed = await onBox(
        WorkspaceRemoved,
        box,
        ['workspace', 'rm', '--card', id],
        o.clock.now() + bootMs,
      );

      return removed.ok ? { ok: true, data: null } : removed;
    },
    claim,
    wakeRoom,
    listing: () => {
      const now = o.clock.now();

      return {
        queued: waiting()
          .map((w) => {
            const q = w.kind === 'launch' ? w.meta : w.held;

            return q.card === null
              ? []
              : [{ box: q.box, repo: q.repo, card: q.card, title: q.title, since: q.startedAt }];
          })
          .flat(),
        made: [...created.values()].flatMap((c) => (c.until > now ? [c.box] : [])),
      };
    },
    nudge: () => {
      void dequeue();
    },
    knows: (id) => known.has(id) && known.get(id)?.moved === null,
    reopen,
    admit: (card, repo, id) => admit(card, repo, id),
    moveIn: (card, repo, where, moved, short) =>
      launch(card, repo, where, false, moved, moved.browserProfile, undefined, undefined, short),
    execOn: (box, card) => inWorkspace(boxAttach, box, containerOn(box, card)),
    movable: (id) => {
      const m = known.get(id);

      if (m?.moved !== null) return unknown(id);
      if (m.card === null)
        return refused('not-movable', `session ${id} is a prototype's: it stays where it runs`);
      if (m.neverPlaced) return neverPlacedRefusal(id);
      if (m.state === 'queued' || coming.has(id))
        return refused('session-queued', `session ${id} is ${m.state}: it has no Workspace yet`);

      return {
        ok: true,
        data: {
          id: m.id,
          card: m.card,
          title: m.title,
          description: m.description,
          criteria: m.criteria,
          repo: m.repo,
          worktree: m.worktree,
          branch: m.branch,
          box: m.box,
          state: m.state,
          transcriptPath: m.transcriptPath,
        },
      };
    },
    stopOnBox: async (id) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return { ok: true, data: null };
      const stopped = answer(
        SessionData,
        await o.link.run(m.box, ['session', 'stop', id, '--json']),
      );

      // The box's serve no longer has it (or it ended there): nothing runs to stop.
      if (stopped.ok || stopped.error.code === 'no-session') return { ok: true, data: null };

      return stopped;
    },
    movedOut: (id, moved) => {
      const m = known.get(id);

      if (m === undefined) return;
      const ended = move(m, 'ended', 'moved');

      keep({ ...ended, moved });
      void release(m.box);
    },
    lastOn: (box, card) => {
      const on = [...known.values()]
        .filter((m) => m.box === box && m.moved === null && (card === undefined || m.card === card))
        .sort((a, b) => byStart(b, a))[0];

      return on === undefined ? undefined : dataOf(on);
    },
    list: async () => {
      await settle();

      return [...known.values()]
        .filter((m) => m.moved === null)
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : Number(a.startedAt > b.startedAt)))
        .map(dataOf);
    },
    get: async (id) => {
      await settle();
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (!started(m) || m.state === 'ended') return { ok: true, data: dataOf(m) };
      const shown = answer(SessionData, await o.link.run(m.box, ['session', 'show', id, '--json']));

      if (!shown.ok) return { ok: true, data: dataOf(m) };
      const merged = {
        ...m,
        transcriptPath: shown.data.transcriptPath,
        lastAssistantMessage: shown.data.lastAssistantMessage,
        models: shown.data.models,
        subagents: shown.data.subagents,
        skillsOnTop: shown.data.skillsOnTop,
        overrides: shown.data.overrides,
        queue: shown.data.queue,
        model: shown.data.model,
        effort: shown.data.effort,
        stopped: shown.data.stopped,
        rounds: shown.data.rounds,
      };

      keep(merged);

      return { ok: true, data: dataOf(move(merged, shown.data.state, 'show', shown.data.since)) };
    },
    send: async (id, text, context) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);
      await syncIfChanged(m);

      return answer(
        SessionSendData,
        await o.link.run(m.box, [
          'session',
          'send',
          id,
          text,
          ...(context === undefined ? [] : ['--context', context]),
          '--json',
        ]),
      );
    },
    unqueue: async (id, n) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);

      return answer(
        SessionUnqueueData,
        await o.link.run(m.box, ['session', 'unqueue', id, String(n), '--json']),
      );
    },
    model: async (id, model, effort) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);

      return answer(
        SessionModelData,
        await o.link.run(m.box, [
          'session',
          'model',
          id,
          '--model',
          model,
          ...(effort === undefined ? [] : ['--effort', effort]),
          '--json',
        ]),
      );
    },
    relay: async (id, schema, argv) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);

      return forward(o.link, schema, m.box, argv);
    },
    forward: async (id, schema, argv) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);

      return forward(o.link, schema, m.box, argv);
    },
    attach: (id) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return refused('session-ended', `session ${id} has ended`);
      if (!started(m)) return refused('session-not-started', `session ${id} is ${m.state}`);

      // ADR 0021: SSH through the box's EC2 Instance Connect Endpoint and a reconnect loop around
      // tmux there, both `abe box attach`'s.
      return { ok: true, data: [...boxAttach, m.box, '--session', id] };
    },
    attachSpec: (id) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      // Queued: no box holds it yet. An ended session's Workspace stays on its box.
      if (m.state === 'queued')
        return refused('session-queued', `session ${id} is queued: it has no box yet`);
      if (m.neverPlaced) return neverPlacedRefusal(id);

      return {
        ok: true,
        data: attachSpecOf({
          where: 'cloud',
          root: m.worktree,
          box: m.box,
          region: o.region ?? null,
          boxAttach,
          container: containerOn(m.box, keyOf(m)),
          // A box up with its claude still starting (#190) is not waking, nor one building its
          // workspace (#339: its launch past the box's boot).
          waking: !boxRuns(m) && !(m.state === 'starting' && started(m)),
        }),
      };
    },
    stop: async (id) => {
      const m = known.get(id);

      if (m === undefined) return unknown(id);
      if (m.state === 'ended') return { ok: true, data: dataOf(m) };
      // A Factory run's queued launch (#234): out of the queue, its run says its session ended.
      if (m.factory && m.state === 'queued')
        return {
          ok: true,
          data: dataOf(takeOut(m, { ...queuedRun(m), since: stamp() }, 'stop')),
        };
      if (started(m)) {
        const stopped = answer(
          SessionData,
          await o.link.run(m.box, ['session', 'stop', id, '--json']),
        );

        if (!stopped.ok) return stopped;
      } else if (coming.has(id))
        return refused('session-starting', `session ${id} is starting; stop it once it runs`);

      const was = known.get(id) ?? m;

      // Ended by your hand (#205): Stopped, not Failed, though the box's own end event (stop, or
      // gone) came in first while it stopped. Still Queued, it never got its box (#246).
      if (was.state !== 'ended')
        return {
          ok: true,
          data: dataOf(
            move(
              { ...was, stopped: true, neverPlaced: was.neverPlaced || was.state === 'queued' },
              'ended',
              'stop',
            ),
          ),
        };
      if (was.stopped) return { ok: true, data: dataOf(was) };
      const marked = { ...was, stopped: true };

      keep(marked);
      o.emit({ id, card: was.card, state: 'ended', since: was.since, cause: 'stop' }, was.box);

      return { ok: true, data: dataOf(marked) };
    },
    resize: resizeNow,
    close: async () => {
      closed = true;
      clearInterval(queueTimer);
      for (const m of known.values()) unfollow(m.box);
      await Promise.resolve();
    },
  };
};
