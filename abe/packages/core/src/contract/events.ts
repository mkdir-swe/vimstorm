/**
 * The events `abe watch` streams, part of the CLI contract: one row per type in `EVENTS`, its data
 * schema and its readable line. A ticket adding an event adds its row here and nothing else;
 * `Event`, `EventType` and `abe watch`'s text follow from the table.
 */
import { z } from 'zod';
import { exitCode } from '../command';
import {
  AskCard,
  boxesUnreadText,
  Effort,
  modelWords,
  MOVE_SIDES,
  QueuedRow,
  SESSION_STATES,
  sessionStateWords,
  TranscriptEntry,
  WAITING_ON,
} from '../session';
import { BrowserStopReason } from '../browser';
import { SUBAGENT_STATES, subagentText } from '../skills';
import {
  FactoryCardEvent,
  factoryCardText,
  FactoryChecksEvent,
  factoryChecksEventText,
  FactoryStageEvent,
  factoryStageText,
  FactorySummaryEvent,
  factorySummaryText,
} from '../factory';
import { BoardDiscardData, HeldWrite, LocalPr } from '../local-mode';
import { SessionOverride, SettingsChangedData } from '../layer';
import { ImproveRetroEvent, improveRetroText, SHIP_REASONS } from '../improve';
import { LOGIN_TOOLS, LoginRestoreData, STORE_CAUSES } from '../logins';
import { PROTOTYPE_STATES, PrototypeId } from '../prototype';
import { TriageDoneEvent, triageDoneText } from '../triage';
import {
  boxIdleText,
  BoxKeepData,
  LaunchProgress,
  launchText,
  PortForward,
  portForwardText,
  WorkspacePorts,
  workspacePortsText,
  WorkspaceStepData,
} from '../box';
import {
  BoardChangedEvent,
  boardChangedText,
  GithubChangedEvent,
  githubChangedText,
  PipelinesChangedEvent,
  pipelinesChangedText,
} from '../board';
import { InstallView, RepoMoved, repoMovedText, SourcesData } from '../install';
import { PROTOCOL } from './contract';

type EventDef<D extends z.ZodType> = {
  readonly data: D;
  /** What `abe watch` prints after the number, time and type. */
  text(data: z.output<D>): string;
};

/** A row, plus its text for data not yet read (a line off the socket). */
const event = <D extends z.ZodType>(def: EventDef<D>) => ({
  ...def,
  say: (data: unknown) => def.text(def.data.parse(data)),
});

const seqNumber = z.number().int().nonnegative();

/**
 * What `box.state` says a box did; `queued`: `abe box place --apply` at the team's limit, held
 * until a box stops or is deleted, or the limit rises; `terminated`: `abe box terminate` asked
 * EC2 to delete it (its disk and workspace go).
 */
export const BOX_MOVES = [
  'queued',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'terminated',
] as const;

/**
 * A step of a box coming up that `box.state` does not say: EC2 runs it and its abe
 * serve is not answering yet (`booting`), its serve answers and its workspace comes up
 * (`workspace`), the workspace is up and Claude Code starts (`claude`).
 */
export const BOX_STEPS = ['booting', 'workspace', 'claude'] as const;
export type BoxStep = (typeof BOX_STEPS)[number];

export const BOX_STEP_WORDS: Readonly<Record<BoxStep, string>> = {
  booting: 'running, waiting for its abe serve',
  workspace: 'abe serve answers, workspace coming up',
  claude: 'workspace up, starting Claude Code',
};

/** Keyed by the type as streamed: `<noun>.<event>`. */
export const EVENTS = {
  /** The first event of every `serve`, number 1. */
  'serve.started': event({
    data: z.object({ version: z.string(), pid: z.number().int().positive(), socket: z.string() }),
    text: (d) => `abe serve ${d.version} listening on ${d.socket} (pid ${d.pid})`,
  }),
  /** Every command a `serve` answered, once its answer is known. */
  'command.ran': event({
    data: z.object({
      noun: z.string(),
      verb: z.string().nullable(),
      exit: exitCode,
      /** The request's `tag`, when its client gave one: how a client knows its own. */
      tag: z.string().optional(),
    }),
    text: (d) => `abe ${d.verb === null ? d.noun : `${d.noun} ${d.verb}`}: ${d.exit}`,
  }),
  /** A layer file changed and moved these keys' merged values, in this checkout (or none). */
  'settings.changed': event({
    data: SettingsChangedData,
    text: (d) =>
      `${[...d.keys, ...(d.files ?? [])].join(', ')}${d.repo === null ? '' : ` in ${d.repo}`}`,
  }),
  /** The workspace's browser started (`abe browser start`). */
  'browser.started': event({
    data: z.object({ pid: z.number().int().positive(), endpoint: z.string() }),
    text: (d) => `browser started at ${d.endpoint} (pid ${d.pid})`,
  }),
  /** The workspace's browser stopped, and why. */
  'browser.stopped': event({
    data: z.object({ reason: BrowserStopReason }),
    text: (d) => `browser stopped: ${d.reason}`,
  }),
  /**
   * A browser profile's Chrome on this Mac (opened through `abe browser open`, or found open):
   * open, closed, its sign-ins stored on their own (on a sign-in while open, and on its close),
   * or that store failed (the Chrome folder keeps them either way). Never a value.
   */
  'browser.profile': event({
    data: z.object({
      name: z.string(),
      state: z.enum(['open', 'closed', 'stored', 'store-failed']),
      message: z.string().optional(),
    }),
    text: (d) =>
      `browser profile ${d.name}: ${d.state}${d.message === undefined ? '' : `: ${d.message}`}`,
  }),
  /** A Sheet saved in your environment: a new one at v1, or the next version of its title. */
  'sheet.saved': event({
    data: z.object({
      id: z.string(),
      title: z.string(),
      version: z.number().int().positive(),
      card: z.number().int().positive().nullable(),
      session: z.string().nullable(),
    }),
    text: (d) => `${d.title} v${d.version} (${d.id})${d.card === null ? '' : ` for AB#${d.card}`}`,
  }),
  /** A Sheet's version copied to the org store under a card. */
  'sheet.attached': event({
    data: z.object({
      id: z.string(),
      title: z.string(),
      version: z.number().int().positive(),
      card: z.number().int().positive(),
      key: z.string(),
    }),
    text: (d) => `${d.title} v${d.version} (${d.id}) on AB#${d.card}`,
  }),
  /**
   * A session's state changed: by a hook (`cause` is its event), its launch, `abe session stop`, or
   * its `claude` found gone. `since` is when.
   */
  'session.state': event({
    data: z.object({
      id: z.string(),
      /** Null for an Improve retro chat or a prototype chat. */
      card: z.number().int().positive().nullable(),
      state: z.enum(SESSION_STATES),
      since: z.iso.datetime(),
      cause: z.string(),
      /** Why Abe ended it (`no-start`: its `claude` never ran a hook). */
      reason: z.string().optional(),
      /** Waiting: on what (`WAITING_ON`); absent from an older serve. */
      waitingOn: z.enum(WAITING_ON).nullable().optional(),
      /** Working with its own turn ended: only its background subagents work; absent otherwise. */
      turnEnded: z.literal(true).optional(),
    }),
    text: (d) =>
      `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} ${sessionStateWords(d)} (${d.cause})${d.reason === undefined ? '' : `: ${d.reason}`}`,
  }),
  /**
   * A session in your environment moved to its next launch step while `starting`: the Mac's
   * own (its box asked for, booting, its workspace, `claude` starting) and the box's
   * (`workspace.step`), so a launch is never a bare `starting` for minutes.
   */
  'session.step': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive(),
      launch: LaunchProgress,
    }),
    text: (d) => `${d.id} AB#${d.card} ${launchText(d.launch)}`,
  }),
  /**
   * A card's launch was asked (`factory run`, `session launch`), from any screen or the CLI: it is
   * Launching on every screen on the card until its session is listed. `repo` is the checkout it
   * was launched from (`--repo`'s folder), or the GitHub repo typed in its place.
   */
  'launch.started': event({
    data: z.object({ card: z.number().int().positive(), repo: z.string() }),
    text: (d) => `AB#${d.card} from ${d.repo}`,
  }),
  /**
   * That launch answered: its `session`, listed soon; or none and why (`refused`), so the card is
   * back to no session where it was Launching.
   */
  'launch.ended': event({
    data: z.object({
      card: z.number().int().positive(),
      repo: z.string(),
      session: z.string().nullable(),
      refused: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
    text: (d) =>
      d.refused === null
        ? `AB#${d.card} launched ${d.session ?? '?'}`
        : `AB#${d.card} refused: ${d.refused.message} (${d.refused.code})`,
  }),
  /**
   * A box's `abe workspace up` at its next step: the mirror fetched, an image built (its
   * Docker step count in `detail`), Postgres, the clone, the container. Said by the box's serve,
   * merged into the Mac's watch while the Mac follows the box.
   */
  'workspace.step': event({
    data: WorkspaceStepData,
    text: (d) => `workspace ${d.step}${d.detail === null ? '' : ` · ${d.detail}`}`,
  }),
  /**
   * A session moved between this Mac and your environment (`abe session download` /
   * `move-to-cloud`): it goes on `to` there in `worktree`; `box` is its Workspace's box.
   */
  'session.moved': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive(),
      from: z.enum(MOVE_SIDES),
      to: z.enum(MOVE_SIDES),
      box: z.string(),
      worktree: z.string(),
    }),
    text: (d) =>
      `${d.id} AB#${d.card} moved to ${d.to === 'local' ? `this machine (${d.worktree})` : `box ${d.box}`}`,
  }),
  /**
   * An ended session was reopened (`abe session reopen`): the same id, worktree and Claude
   * Code conversation go on; `recreated` when its worktree was made again from its branch.
   */
  'session.reopened': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive().nullable(),
      worktree: z.string(),
      at: z.iso.datetime(),
      recreated: z.boolean(),
    }),
    text: (d) =>
      `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} reopened in ${d.worktree}${d.recreated ? ' (worktree made again from its branch)' : ''}`,
  }),
  /** A session's logs shipped to the log store, redacted: every five minutes while it runs, at its end, or `abe log ship`. */
  'log.shipped': event({
    data: z.object({
      session: z.string(),
      card: z.number().int().positive(),
      prefix: z.string(),
      reason: z.enum(SHIP_REASONS),
      files: z.number().int().nonnegative(),
      redacted: z.number().int().nonnegative(),
    }),
    text: (d) =>
      `${d.session} AB#${d.card} to ${d.prefix} (${d.reason}): ${d.files} files, ${d.redacted} redacted`,
  }),
  /** Shipping a session's logs on its own (`interval` or `end`) failed; the next shipment tries again, whole. */
  'log.failed': event({
    data: z.object({
      session: z.string(),
      reason: z.enum(SHIP_REASONS),
      code: z.string(),
      message: z.string(),
    }),
    text: (d) => `${d.session} (${d.reason}): ${d.code}: ${d.message}`,
  }),
  /**
   * A Factory run moved to another stage or changed state (running, needs you, done): by its
   * session's own `abe factory` commands, checks, or its session's hooks (`cause`).
   */
  'factory.stage': event({ data: FactoryStageEvent, text: factoryStageText }),
  /**
   * A run's card moved on the board (`board.active` as it starts building, `board.done` at Done),
   * or why it was not: a failed move holds nothing up.
   */
  'factory.card': event({ data: FactoryCardEvent, text: factoryCardText }),
  /** A finished step's Step summary was kept on its run, and the Run brief when it wrote one. */
  'factory.summary': event({ data: FactorySummaryEvent, text: factorySummaryText }),
  /** A Factory install changed (a part checked, its kind, its session): its whole status. */
  'install.changed': event({
    data: InstallView,
    text: (v) =>
      `${v.repo}: ${v.done ? 'done' : `${v.parts.filter((p) => p.state === 'pass').length} of ${v.parts.length} parts pass`}`,
  }),
  /**
   * A repo moved on this Mac was met at its new folder (or one of its worktrees, the repo not found):
   * what followed it, what did not.
   */
  'repo.moved': event({ data: RepoMoved, text: repoMovedText }),
  /** A checkout's sources changed: a sign-in serve runs started or ended (`abe source status`). */
  'sources.changed': event({
    data: SourcesData,
    text: (d) => `${d.repo}: ${d.sources.map((x) => `${x.id} ${x.check}`).join(', ')}`,
  }),
  /** Local mode: a write held on this Mac instead of sent (what, where it would have gone). */
  'local.held': event({ data: HeldWrite, text: (d) => `held: ${d.what} · ${d.where}` }),
  /** Local mode: a local pull request opened, updated, merged into the local base or discarded. */
  'local.pr': event({ data: LocalPr, text: (d) => `${d.name} ${d.state} · ${d.title}` }),
  /** Discard local changes: a checkout's held board changes dropped; its board reads as it is. */
  'local.discarded': event({
    data: BoardDiscardData,
    text: (d) => `local changes to the board discarded · ${d.checkout}`,
  }),
  /** `abe triage` gave its verdicts: how many items, of which scope, and each verdict's count. */
  'triage.done': event({ data: TriageDoneEvent, text: triageDoneText }),
  /** `abe improve retro` found its findings (`found`), or `make` made one (`made`). */
  'improve.retro': event({ data: ImproveRetroEvent, text: improveRetroText }),
  /**
   * A prototype's app and proxy: starting, then live (or failed, `reason` why); stopped. `cause`
   * says what moved it.
   */
  'prototype.state': event({
    data: z.object({
      id: PrototypeId,
      card: z.number().int().positive().nullable(),
      state: z.enum(PROTOTYPE_STATES),
      url: z.string().nullable(),
      cause: z.string(),
      reason: z.string().nullable().default(null),
    }),
    text: (d) =>
      `${d.id}${d.card === null ? '' : ` AB#${d.card}`} ${d.state}${d.url === null ? '' : ` at ${d.url}`} (${d.cause})${d.reason === null ? '' : `: ${d.reason}`}`,
  }),
  /** A prototype's version saved in your environment: v1, v2… */
  'prototype.saved': event({
    data: z.object({ id: PrototypeId, version: z.number().int().positive(), commit: z.string() }),
    text: (d) => `${d.id} v${d.version} at ${d.commit.slice(0, 7)}`,
  }),
  /** The prototype proxy refused a request: another host than the app, or a tunnel. */
  'prototype.refused': event({
    data: z.object({
      id: PrototypeId,
      method: z.string(),
      host: z.string(),
      path: z.string(),
      reason: z.string(),
    }),
    text: (d) => `${d.id} refused ${d.method} ${d.host}${d.path}: ${d.reason}`,
  }),
  /**
   * A subagent of a session started or ended, from its `SubagentStart` / `SubagentStop` hook:
   * `agent` is Claude Code's `agent_id`, `name` its agent type, `result` its answer's first line.
   */
  'session.subagent': event({
    data: z.object({
      id: z.string(),
      /** Null for an Improve retro chat or a prototype chat. */
      card: z.number().int().positive().nullable(),
      agent: z.string(),
      name: z.string(),
      task: z.string().nullable(),
      model: z.string().nullable(),
      state: z.enum(SUBAGENT_STATES),
      result: z.string().nullable(),
      /** Its last tool call and how many so far; absent from a serve before 3.3. */
      tool: z.string().nullable().optional(),
      tools: z.number().int().nonnegative().optional(),
      /** The coordinator's Agent call that started it; its own transcript. */
      call: z.string().nullable().optional(),
      transcript: z.string().nullable().optional(),
    }),
    text: (d) => `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} ${subagentText(d)}`,
  }),
  /**
   * New entries of a session's transcript: `from` is the first one's number in the session's
   * list (`abe session transcript <id> --since <n>` reads them again); a later entry of the same
   * kind and id replaces the earlier one (a hook's running call, then the JSONL's). A serve started
   * again numbers the list anew: after its `serve.started` a reader reads again from 0.
   */
  'session.transcript': event({
    data: z.object({
      session: z.string(),
      from: z.number().int().nonnegative(),
      entries: z.array(TranscriptEntry),
    }),
    text: (d) =>
      `${d.session} transcript ${d.entries.length === 1 ? '1 entry' : `${d.entries.length} entries`} from ${d.from}`,
  }),
  /**
   * A session asks you in Chat: its question, a grill round's cards, or a permission held
   * under an Override; again for a card whose hold ran out (`expired`). `card` is the story.
   */
  'session.ask': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive().nullable(),
      cards: z.array(AskCard),
    }),
    text: (d) =>
      `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} asks: ${d.cards.map((c) => `${c.title}${c.expired === null ? '' : ` (${c.expired})`}`).join(' · ')}`,
  }),
  /**
   * Cards answered, cleared everywhere: `answer` what was sent or decided, null when they
   * went outside Chat (Terminal mode, Claude Code's own dialog, the session's end).
   */
  'session.answered': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive().nullable(),
      cards: z.array(z.string()),
      answer: z.string().nullable(),
    }),
    text: (d) =>
      `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} answered ${d.cards.join(', ')}${d.answer === null ? ' outside Chat' : `: ${d.answer.split('\n')[0] ?? ''}`}`,
  }),
  /** An Abe chat conversation was named by your first message to it (`hubName`). */
  'session.titled': event({
    data: z.object({ id: z.string(), title: z.string() }),
    text: (d) => `${d.id} is ${d.title}`,
  }),
  /** An Override on a session: one area lowered until it ends, with its reason. */
  'session.override': event({
    data: z.object({
      id: z.string(),
      card: z.number().int().positive().nullable(),
      override: SessionOverride,
    }),
    text: (d) =>
      `${d.id} ${d.card === null ? 'chat' : `AB#${d.card}`} override: ${d.override.words} · reason: ${d.override.reason}`,
  }),
  /**
   * A session's queue changed: a message sent while it worked was queued, taken back
   * (`abe session unqueue`), or the whole queue went as one prompt at its turn's end (empty).
   */
  'session.queued': event({
    data: z.object({ session: z.string(), queue: z.array(QueuedRow) }),
    text: (d) =>
      `${d.session} ${d.queue.length === 0 ? 'nothing queued' : `${d.queue.length} queued`}`,
  }),
  /**
   * A session's model or effort changed (`abe session model`). `effortPending`: the effort
   * applies at its next resume, not now.
   */
  'session.model': event({
    data: z.object({
      session: z.string(),
      model: z.string(),
      effort: Effort.nullable(),
      effortPending: z.boolean(),
    }),
    text: (d) =>
      `${d.session} on ${modelWords(d)}${d.effortPending ? ' (effort at the next resume)' : ''}`,
  }),
  /**
   * A run of a card's checks finished: after build (`checks`, the result moves the run) or
   * `abe factory checks` (`on-demand`, it moves nothing). Each result; the output is in `file`.
   */
  'factory.checks': event({ data: FactoryChecksEvent, text: factoryChecksEventText }),
  /** A box put the person's stored logins where their tools read them (on start, or `abe login restore`). */
  'login.restored': event({
    data: LoginRestoreData,
    text: (d) =>
      `from ${d.secret}: restored ${d.restored.join(', ') || 'none'}, seeded ${d.seeded.join(', ') || 'none'}, kept ${d.kept.join(', ') || 'none'}`,
  }),
  /** A tool's login written to the person's secret: after `abe login`, a refresh by the tool, or from its seed. Never its value. */
  'login.stored': event({
    data: z.object({
      tool: z.enum(LOGIN_TOOLS),
      secret: z.string(),
      cause: z.enum(STORE_CAUSES),
    }),
    text: (d) => `${d.tool} to ${d.secret} (${d.cause})`,
  }),
  /** Restoring or writing back a login failed; the next look tries again. */
  'login.failed': event({
    data: z.object({ tool: z.enum(LOGIN_TOOLS).nullable(), code: z.string(), message: z.string() }),
    text: (d) => `${d.tool ?? 'logins'}: ${d.code}: ${d.message}`,
  }),
  /**
   * A box moved, as this `serve` asked or saw: `starting` then `running` (once its `serve`
   * answers) when `abe box up` makes or wakes it or a command to a sleeping box wakes it first
   * (`cause` `up`, `wake`, `start`), `stopping` then `stopped` for `abe box stop`, `failed` when
   * it did not get there.
   */
  'box.state': event({
    data: z.object({ box: z.string(), state: z.enum(BOX_MOVES), cause: z.string() }),
    text: (d) => `${d.box} ${d.state} (${d.cause})`,
  }),
  /** A box coming up took its next step: said by this Mac's serve as it waits for it. */
  'box.step': event({
    data: z.object({
      box: z.string(),
      step: z.enum(BOX_STEPS),
      /** The session it comes up for, when a launch brings it up. */
      session: z.string().optional(),
    }),
    text: (d) =>
      `${d.box} ${BOX_STEP_WORDS[d.step]}${d.session === undefined ? '' : ` (${d.session})`}`,
  }),
  /**
   * A box's idle stop moved: its `stopsAt` or `keptBy` changed (`abe box keep` / `sleep`,
   * someone attached or gone, a session working or done, a hook). Said by the box's own `serve`
   * (merged into the Mac's watch while the Mac follows the box), else by the Mac's `box keep` /
   * `box sleep`.
   */
  'box.idle': event({
    data: BoxKeepData,
    text: (d) => `${d.box} ${boxIdleText(d.idle, undefined, d.box)}`,
  }),
  /**
   * What listens in a box workspace changed: said by the box's own `serve`, which looks at
   * each running workspace every few seconds (merged into the Mac's watch, tagged with its box,
   * while the Mac follows the box).
   */
  'workspace.ports': event({
    data: WorkspacePorts,
    text: (d) => workspacePortsText({ workspaces: [d] }).trimEnd(),
  }),
  /** A forward this Mac holds moved: opening, open, asleep with its box, failed, or closed. */
  'port.forward': event({
    data: PortForward.extend({ closed: z.boolean().optional() }),
    text: (d) =>
      d.closed === true
        ? `${d.box} #${d.card} :${String(d.port)} closed`
        : portForwardText(d).trimEnd(),
  }),
  /**
   * Your boxes could not be read for `session list` or `watch` (no AWS login, AWS refusing, EC2
   * not answering): this Mac's sessions only. Said once, and again only after a read worked.
   */
  'boxes.unread': event({
    // `profile`, `keys`: an `aws-auth`'s profile to log in with and how (as `ErrorBody`'s)
    data: z.object({
      code: z.string(),
      message: z.string(),
      profile: z.string().min(1).optional(),
      keys: z.boolean().optional(),
    }),
    text: (d) => boxesUnreadText(d.message),
  }),
  /**
   * A fresh look (`abe fresh`) found cards changed on Azure DevOps outside Abe: each as the
   * board lists it now (on Mine too or not), and those it lists no more.
   */
  'board.changed': event({ data: BoardChangedEvent, text: boardChangedText }),
  /**
   * A fresh look found a repo's pull requests (a review, a push, a merge) changed on GitHub
   * since the last one.
   */
  'github.changed': event({ data: GithubChangedEvent, text: githubChangedText }),
  /**
   * A fresh look found runs of the pipelines provider in force (GitHub Actions, Azure
   * Pipelines) started, run again or moved on since the last one.
   */
  'pipelines.changed': event({ data: PipelinesChangedEvent, text: pipelinesChangedText }),
  /**
   * Sent to one watcher only, first, when the events after `since` are no longer held (or `since`
   * is ahead of this `serve`, so from another one); `first` is the next event it gets. Its own
   * number is `first - 1`, so numbers still rise by one. Merged from a followed box (tagged
   * `box`) it is that box's gap, in the box's numbers, and every watcher gets it.
   */
  'watch.gap': event({
    data: z.object({ since: seqNumber, first: seqNumber }),
    text: (d) =>
      d.since < d.first
        ? `events ${d.since + 1} to ${d.first - 1} are gone; next is ${d.first}`
        : `event ${d.since} is not from this serve; next is ${d.first}`,
  }),
};

type Events = typeof EVENTS;
export type EventType = keyof Events;
export type EventData<T extends EventType> = z.output<Events[T]['data']>;

/** A row's own key only. */
export const isEventType = (type: string): type is EventType => Object.hasOwn(EVENTS, type);

export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENTS).filter(isEventType);

/**
 * One event as `abe watch --json` prints it: `at` is RFC 3339 (UTC), `seq` rises by one. `box`:
 * the box whose own `serve` it came from, merged into the Mac's stream; absent for this
 * `serve`'s own.
 */
export type Event = {
  [T in EventType]: { seq: number; at: string; type: T; data: EventData<T>; box?: string };
}[EventType];

const lineOf = (type: EventType) =>
  z.object({
    seq: seqNumber,
    at: z.iso.datetime(),
    type: z.literal(type),
    data: EVENTS[type].data,
    box: z.string().optional(),
  });

const [firstType, ...otherTypes] = EVENT_TYPES;

if (firstType === undefined) throw new Error('EVENTS is empty');

const rows = z.discriminatedUnion('type', [lineOf(firstType), ...otherTypes.map(lineOf)]);

/**
 * Exactly the union of the table's rows: an event outside it does not parse. Checked by the rows'
 * union, typed by `Event`, which the compiler cannot see in a union built from the table.
 */
export const Event = z.custom<Event>().superRefine((value, ctx) => {
  const checked = rows.safeParse(value);

  if (!checked.success)
    for (const issue of checked.error.issues)
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

/**
 * Any event line, of a type this build may not know (a newer `serve`): what a client reads so it
 * prints what it is sent.
 */
export const EventLine = z.object({
  seq: seqNumber,
  at: z.iso.datetime(),
  type: z.string().regex(/^[a-z]+(-[a-z]+)*\.[a-z]+(-[a-z]+)*$/),
  data: z.unknown(),
  box: z.string().optional(),
});
export type EventLine = z.infer<typeof EventLine>;

/**
 * `abe watch` without `--json`: one line, the number, time and type, then the row's words, and
 * `on <box>` for a box's own.
 */
export const eventText = (line: EventLine): string => {
  const words =
    isEventType(line.type) && Event.safeParse(line).success
      ? EVENTS[line.type].say(line.data)
      : JSON.stringify(line.data);

  return `${line.seq} ${line.at} ${line.type} ${words}${line.box === undefined ? '' : `  on ${line.box}`}\n`;
};

/**
 * One frame of the `watch` stream on the socket. A refused `watch` gets an ordinary `Reply` frame
 * instead, and the connection closes.
 */
export const WatchFrame = z.object({ v: z.literal(PROTOCOL), event: EventLine });
export type WatchFrame = z.infer<typeof WatchFrame>;
