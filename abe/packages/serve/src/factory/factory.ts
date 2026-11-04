/**
 * `abe factory`: a Factory run per session (tickets #45, #47). `factory run` launches the session
 * and its run in `decide`; the session's own model moves it with `decide`, `stage-done`, `review`,
 * `verify` and `needs-you` on its own socket (`ctx.session`), and nothing outside the session can.
 * Review and verification reports are copied to the card's `.scratch` in the run's worktree;
 * `base-worktree` makes Before's worktree at the merge base. The moves
 * are core's rule table (`core/src/factory/factory.ts`); this module keeps the runs (`run.json` beside
 * the session's `meta.json`), runs checks on entering `checks` (`checks.ts`; red types their
 * output into the session), follows the session's hook state for running / needs you, and emits
 * `factory.stage` on every move or change of state.
 */
import { repoLoginsNeedsYou, type StoredLoginsCtx } from '../logins/logins';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type Board,
  type ByCard,
  type Git,
  branchNameProblem,
  type FactValue,
  intoOf,
  boardColumnsOf,
  boardOf,
  browserRanSince,
  type CardMove,
  cardMoveOf,
  checkEntries,
  checksConfigured,
  checksNotRun,
  checksSaid,
  checksKept,
  coreDefaults,
  type Clock,
  DEFAULT_AGENT_ENVS,
  keptPlaybook,
  parsePlaybook,
  PLAYBOOK_STEP,
  type PlaybookKept,
  playbookPath,
  playbookProblems,
  type EventData,
  endsVerification,
  featureHtmlFindings,
  featureReportFindings,
  featureResults,
  featuresOf,
  featureVerdicts,
  verifyHtmlOf,
  verifyHtmlPath,
  verifyHtmlSources,
  verifyHtmlText,
  type CardDetail,
  FACTORY_PERMISSION_MODE,
  FACTORY_RUN_INSTRUCTIONS,
  factoryLaunchPrompt,
  type FactoryChecksData,
  type FactoryRunData,
  type OrgPrototypeVersion,
  type OrgStore,
  referenceDir,
  referencePrompt,
  type RunReference,
  runReference,
  storeRepoName,
  type LaunchTarget,
  type ShortAnswer,
  type LaunchSetup,
  launchColumnOf,
  PROTOTYPE_NEVER_SHIPS,
  type Move,
  namesOf,
  newRun,
  type Outcome,
  parseCardId,
  prData,
  refused,
  reportPath,
  Run,
  runData,
  type RunTree,
  type SessionData,
  stageEventOf,
  type SessionState,
  type BoardRef,
  INTERRUPTED,
  INTERRUPTED_REASON,
  type SetupRan,
  setupReason,
  step,
  DEFAULT_PROFILE,
  packRefusal,
  REPO_SKILLS_DIR,
  verifySkillName,
  packSurface,
  featureSurfaces,
  doneByItsPr,
  withProfileLine,
  isHere,
  type RepoHere,
  hasPrototype,
  reopenedSince,
  runOver,
  runOverText,
  factValues,
  type RunWorkflow,
  autoMergeOf,
  type RunPinned,
  type Handlers,
  type Visit,
  withStepSummary,
  stepMadeOf,
  type StepMade,
  findingsFileOf,
  type ReviewFindingsFile,
  rehomed,
} from '@abe/core';
import { keepReport, mainCheckout, originUrl, readRuns, writeRun } from '@abe/ports';
import { cardReference, downloadVersion } from '../sheets/org';
import { launchSetupOf } from '../session/launch-note';
import { type Checks, type ChecksRan } from './checks';
import { type StepSummarizer } from './step-summary';
import { repoHere } from '../contract/here';
import {
  checkoutOf,
  type RunOverrides,
  runOverridesIn,
  type SettingsService,
} from '../layer/settings';
import { sessionReach } from '../layer/reach';
import { launchProfile } from '../browser/browser-profiles';
import { type BrowserService } from '../browser/browser';
import { type LocalBrowsers } from '../local-mode/local-browsers';
import { launchWorkflowFor } from '../skills/workflows';
import { orgAt, type RepoPortsCtx } from '../local-mode/local-mode';
import { type OwnCtx, ownPath } from '../session/own';
import {
  type LaunchExtras,
  boardKindIn,
  branchSharedOf,
  cloudRepo,
  launchSettings,
  placement,
  readCard,
  saidLaunch,
  type SessionCtx,
  type Sessions,
} from '../session/sessions';

/** The card's words a Factory run's launch prompt is made of. */
export type FactoryCard = Pick<
  CardDetail,
  'id' | 'title' | 'description' | 'acceptanceCriteria'
> & {
  /** The board it is on (a board on this machine names its cards `L-<id>`); none: Azure Boards. */
  board?: Pick<BoardRef, 'provider'>;
};

export type FactoryOptions = {
  stateDir: string;
  clock: Clock;
  sessions: Sessions;
  emit: (data: EventData<'factory.stage'>) => void;
  /** A run's checks: their result moves a run in `checks` (green on to review, red to build). */
  checks: Checks;
  /** Where a run's worktree is, by its card: this machine's disk, or its box workspace's container. */
  tree: ByCard<RunTree>;
  /**
   * Where a run's card is moved as it starts building and at Done (`cardMoveOf`): the board and
   * its columns in force in the run's checkout. A move that fails is a `factory.card` event and
   * the run's `board`, never a stop. Held where the run's own checkout holds its board.
   */
  board: (run: Run) => Board;
  settings: SettingsService | undefined;
  emitCard: (data: EventData<'factory.card'>) => void;
  /**
   * The pass after each finished step: its Step summary kept on its visit (the Run brief
   * on the run), then `factory.summary`. Not awaited; absent: none is written.
   */
  summarize?: StepSummarizer;
  emitSummary?: (data: EventData<'factory.summary'>) => void;
};

export type Factory = {
  /** A run for the session `factory run` is launching, held until `launched`. */
  start: (run: Run) => void;
  /** Its session started: the run is kept and its first event sent. */
  launched: (id: string, worktree: string) => Run | undefined;
  /** Its session did not start: the run is forgotten, nothing was sent. */
  dropped: (id: string) => void;
  get: (id: string) => Run | undefined;
  all: () => Run[];
  apply: (id: string, move: Move, cause: string) => Promise<Outcome<Run>>;
  /** Runs a run's checks again now (`abe factory checks`): the run does not move. */
  checks: (run: Run) => Promise<Outcome<FactoryChecksData>>;
  /** Each run in the repo moved from `from` to `to` kept with its new paths: how many. */
  rehome: (from: string, to: string) => number;
  /** A `session.state` event: the run's state follows its session's. */
  sessionMoved: (data: EventData<'session.state'>) => void;
  data: (run: Run) => FactoryRunData;
  /**
   * Moves `run`'s card to `column`'s state on its checkout's board and says so (`factory.card`),
   * for a run this Factory does not hold (#234: one ended on the Mac before any box had it).
   * `asked`: where the person asked, the board's checkout when the run's is no folder here.
   */
  moveBoard: (run: Run, column: 'active' | 'done' | 'new', asked?: string) => Promise<CardMove>;
  /** Now, as the runs' times are written. */
  stamp: () => string;
  /** Keeps a `stage-done --report`'s text with the session; its path there. */
  report: (id: string, stage: string, text: string) => string;
  /** Where a run's worktree is, by its card. */
  tree: ByCard<RunTree>;
};

/**
 * What a session's change of state does to its run: the person answering in Chat (a prompt, not a
 * permission granted) clears Needs you; its turn interrupted (Esc) and Abe ending the session with
 * a reason (its claude never started) put the run at Needs you, saying why.
 */
const sessionMove = (
  was: SessionState | undefined,
  data: EventData<'session.state'>,
): Move | undefined => {
  if (was === 'waiting' && data.cause === 'UserPromptSubmit') return { type: 'answered' };
  if (data.state === 'waiting' && data.cause === INTERRUPTED)
    return { type: 'needs-you', reason: INTERRUPTED_REASON };
  if (data.state === 'ended' && data.reason !== undefined)
    return { type: 'needs-you', reason: data.reason };

  return undefined;
};

/**
 * Whether no check in force in the checkout `repo` has a command (#159: a repo with no pack), as
 * its checks would run them.
 */
export const noChecksIn = (settings: SettingsService | undefined, repo: string): boolean =>
  !checksConfigured(checkEntries((settings?.at(repo).values ?? coreDefaults()).checks));

/**
 * What ends a run as its checkout's Layers say now (#9): read once as it starts and kept on it
 * (`Run.pinned`), so another card's launch on the same box never changes a run already going.
 */
export const runPinnedIn = (
  settings: SettingsService | undefined,
  repo: string,
): RunPinned | null =>
  settings === undefined
    ? null
    : {
        autoMerge: autoMergeOf(settings.at(repo)),
        done: settings.at(repo).values['factory.done'],
      };

export const startFactory = (o: FactoryOptions): Factory => {
  const runs = new Map<string, Run>();
  /** Each run's session state as last heard, so a change can be told from its last. */
  const heard = new Map<string, SessionState>();
  /** Runs whose session is starting: their events wait until it has. */
  const pending = new Map<string, EventData<'factory.stage'>[]>();
  const stamp = () => new Date(o.clock.now()).toISOString();
  const sessionOf = (id: string) => heard.get(id) ?? o.sessions.peek(id);
  /** Each run's card moves, one after another. */
  const moving = new Map<string, Promise<void>>();
  /** Runs whose session is being stopped at Done (#304): stopped once. */
  const releasing = new Set<string>();

  /**
   * A run carried to Done past its session (`doneByItsPr`): its session stopped once it waits at
   * its prompt (one still working ends its turn first). Not awaited: nothing a stop does is in
   * the run's way.
   */
  const release = (run: Run) => {
    if (!doneByItsPr(run) || sessionOf(run.session) !== 'waiting' || releasing.has(run.session))
      return;
    // Reopened after its Done (#343): a conversation of the person's, never stopped for the run.
    if (reopenedSince(o.sessions.metaOf(run.session)?.reopened ?? [], run.since)) return;
    releasing.add(run.session);
    // a stop that failed is tried again on the next look
    void o.sessions
      .stop(run.session)
      .then((stopped) => {
        if (!stopped.ok) releasing.delete(run.session);
      })
      .catch(() => {
        releasing.delete(run.session);
      });
  };

  for (const doc of readRuns(o.stateDir)) {
    const run = Run.safeParse(doc);

    if (run.success) runs.set(run.data.session, run.data);
  }

  const send = (data: EventData<'factory.stage'>) => {
    const held = pending.get(data.session);

    if (held === undefined) o.emit(data);
    else held.push(data);
  };

  /**
   * Moves the run's card to `column`'s state on the board in force in its checkout (a box's run,
   * `owner/name`, no folder here: in `asked`, where the person asked), and keeps how that went on
   * the run; a failure is said, and the run goes on.
   */
  const moveBoard = async (
    run: Run,
    column: 'active' | 'done' | 'new',
    asked?: string,
  ): Promise<CardMove> => {
    const own = checkoutOf(run);
    const setting = o.settings?.at(isAbsolute(own) || asked === undefined ? own : asked).values
      .board;
    const state = boardColumnsOf(setting)[column];
    const board = boardOf(setting);
    const moved = board.ok
      ? await o
          .board(run)
          .move(board.board, run.card, state)
          .catch((err: unknown) => ({
            ok: false as const,
            error: { message: err instanceof Error ? err.message : String(err) },
          }))
      : board;
    const error = moved.ok ? null : moved.error.message;

    o.emitCard({ card: run.card, session: run.session, column, state, error });

    return { column, state, at: stamp(), error };
  };
  const moveCard = async (run: Run, column: 'active' | 'done' | 'new') => {
    const board = await moveBoard(run, column);

    await apply(run.session, { type: 'card-moved', board }, 'card-moved');
  };

  /**
   * The step `visit` just ended summarised, kept on the run as it is by then (it moves on
   * meanwhile); a pass that fails or says nothing changes nothing.
   */
  const summarize = (run: Run, visit: Visit) => {
    const pass = o.summarize;

    if (pass === undefined) return;
    void pass(run, visit)
      .then((said) => {
        const now = runs.get(run.session);

        if (said === null || now === undefined) return;
        const next = withStepSummary(now, visit, said);

        runs.set(next.session, next);
        if (!pending.has(next.session)) writeRun(o.stateDir, next);
        o.emitSummary?.({
          card: next.card,
          session: next.session,
          stage: visit.stage,
          startedAt: visit.startedAt,
          brief: said.brief !== null && next.brief === said.brief,
        });
      })
      .catch(() => undefined);
  };

  /** Keeps `next` and sends its event when its stage or state differs from `was`'s. */
  const keep = (was: Run, wasSession: SessionState | undefined, next: Run, cause: string) => {
    runs.set(next.session, next);
    if (!pending.has(next.session)) writeRun(o.stateDir, next);
    // each step it finished: summarised after, never in its way
    for (const visit of next.visits.slice(was.visits.length)) summarize(next, visit);
    const column = cardMoveOf(was, next);

    // Not awaited: the board is never in the run's way. One run's moves go in order (Active
    // before Done), and nothing a move throws reaches serve.
    if (column !== null)
      moving.set(
        next.session,
        (moving.get(next.session) ?? Promise.resolve())
          .then(() => moveCard(next, column))
          .catch(() => undefined),
      );
    // A pull request read that moved only its state, checks or deploy is news too: the event
    // carries the pull request (#228).
    const event = stageEventOf(was, wasSession, next, sessionOf(next.session), cause);

    if (event !== null) send(event);
    release(next);
  };

  const apply = async (id: string, move: Move, cause: string): Promise<Outcome<Run>> => {
    const run = runs.get(id);

    if (run === undefined) return refused('no-run', `session ${id} runs no Factory run`);
    const stepped = step(run, move, stamp());

    if (!stepped.ok) return refused(stepped.code, stepped.message);
    keep(run, sessionOf(id), stepped.run, cause);
    if (stepped.run.stage !== 'checks' || run.stage === 'checks')
      return { ok: true, data: stepped.run };

    return check(stepped.run);
  };

  /**
   * Runs the checks of a run that entered `checks` and moves it by their result, unless it has
   * moved on meanwhile (a `decide` rewound it): a result is for the stay in checks it began in.
   * Red types what failed into the session, which is back in build.
   */
  const check = async (run: Run): Promise<Outcome<Run>> => {
    // Checks that cannot run (no worktree, git or the disk failing) are red: the run goes back
    // to build with the reason, never stuck in checks.
    const result = await o
      .checks(run, 'checks')
      .catch((err: unknown) =>
        refused('checks-failed', err instanceof Error ? err.message : String(err)),
      );

    if (result.ok) await keepChecks(run, result.data);
    const now = runs.get(run.session);

    if (now?.stage !== 'checks' || now.since !== run.since)
      return now === undefined
        ? refused('no-run', `no run ${run.session}`)
        : { ok: true, data: now };
    const green = result.ok && result.data.green;
    // #159: none with a command ran: on to review, the run marked as checked by nothing.
    const none = result.ok && result.data.none;
    const moved = await apply(run.session, { type: 'checks', green, none }, 'checks');

    // Typed while its `stage-done build` waits: Claude Code takes it as the next message. A
    // session that is gone has its output in checks.md.
    if (moved.ok && !green && !none)
      await o.sessions.send(
        run.session,
        result.ok ? checksSaid(result.data) : checksNotRun(result.error.message),
      );

    return moved;
  };

  /**
   * A run of the checks kept on the run (`checks-ran`), each output cut to its tail and the env
   * by name only; it moves nothing.
   */
  const keepChecks = async (run: Run, ran: ChecksRan): Promise<FactoryChecksData> => {
    const { env, ...data } = ran;

    await apply(
      run.session,
      { type: 'checks-ran', kept: checksKept(data, stamp(), env) },
      'checks',
    );

    return data;
  };

  // A serve stopped while a run's checks ran: they run again.
  for (const run of runs.values()) if (run.stage === 'checks') void check(run);
  // One stopped (or upgraded) with a Done run's session still at its prompt: stopped now (#304).
  for (const run of runs.values()) release(run);

  return {
    start: (begun) => {
      // #159: a checkout with no check with a command is said from the launch on.
      const run = {
        ...begun,
        noChecks: noChecksIn(o.settings, begun.repo),
        // #9: what ends it, as its Layers say now; a later launch on its box changes none of it
        pinned: begun.pinned ?? runPinnedIn(o.settings, begun.repo),
      };

      runs.set(run.session, run);
      heard.set(run.session, 'starting');
      pending.set(run.session, []);
    },
    launched: (id, worktree) => {
      const run = runs.get(id);
      const held = pending.get(id) ?? [];

      pending.delete(id);
      if (run === undefined) return undefined;
      const kept = { ...run, worktree };

      runs.set(id, kept);
      writeRun(o.stateDir, kept);
      o.emit({
        card: kept.card,
        session: id,
        stage: kept.stage,
        from: null,
        state: 'running',
        reason: null,
        since: kept.startedAt,
        cause: 'run',
        outcome: null,
        pr: kept.pr === null ? null : prData(kept.pr),
      });
      for (const data of held) o.emit(data);
      // A run that starts on the work (no spec first) moves its card to Active as it launches.
      const column = launchColumnOf(kept);

      if (column !== null)
        moving.set(
          id,
          (moving.get(id) ?? Promise.resolve())
            .then(() => moveCard(kept, column))
            .catch(() => undefined),
        );

      return kept;
    },
    dropped: (id) => {
      runs.delete(id);
      heard.delete(id);
      pending.delete(id);
    },
    get: (id) => runs.get(id),
    rehome: (from, to) => {
      let n = 0;

      for (const run of runs.values()) {
        const kept = {
          ...run,
          repo: rehomed(run.repo, from, to),
          worktree: rehomed(run.worktree, from, to),
        };

        if (kept.repo === run.repo && kept.worktree === run.worktree) continue;
        runs.set(run.session, kept);
        if (!pending.has(run.session)) writeRun(o.stateDir, kept);
        n += 1;
      }

      return n;
    },
    all: () =>
      [...runs.values()].sort((a, b) =>
        a.startedAt < b.startedAt ? -1 : Number(a.startedAt > b.startedAt),
      ),
    apply,
    checks: async (run) => {
      const ran = await o.checks(run, 'on-demand');

      return ran.ok ? { ok: true, data: await keepChecks(run, ran.data) } : ran;
    },
    sessionMoved: (data) => {
      const run = runs.get(data.id);
      const was = sessionOf(data.id);

      heard.set(data.id, data.state);
      if (run === undefined) return;
      const stepped = sessionMove(was, data);

      const moved = stepped === undefined ? undefined : step(run, stepped, stamp());

      // a Done run's session that ended its turn is stopped then (#304): `keep` releases it
      keep(run, was, moved?.ok === true ? moved.run : run, data.cause);
    },
    data: (run) => runData(run, sessionOf(run.session)),
    moveBoard,
    stamp,
    report: (id, stage, text) => keepReport(o.stateDir, id, stage, text),
    tree: o.tree,
  };
};

/**
 * A run whose session started (here or on a box): kept and its first event sent. A failed setup of
 * its new worktree puts it at Needs you with the output (claude runs, so the person answers in
 * Chat once it is fixed).
 */
export const runStarted = async (
  factory: Factory,
  id: string,
  worktree: string,
  setup: SetupRan | null,
  /** The repo's logins not usable here (`repoLoginsNeedsYou`): Needs you too, after setup's. */
  logins: string | null = null,
): Promise<Outcome<Run>> => {
  const run = factory.launched(id, worktree);

  if (run === undefined) return refused('no-run', `session ${id} has no run`);
  const reason = (setup === null ? null : setupReason(setup)) ?? logins;

  return reason === null
    ? { ok: true, data: run }
    : factory.apply(id, { type: 'needs-you', reason }, 'setup');
};

/**
 * A Factory run's launch, on this machine or in a box's workspace: `launch` starts the session
 * with the run's instructions, prompt and permission mode (`FACTORY_PERMISSION_MODE`; a box's
 * launch puts its own); the run is
 * held from the session's id on (before its `claude` runs a hook), then kept (at Needs you when
 * the worktree's setup failed), or forgotten when the launch failed. `repo`: the checkout the run's
 * settings are read in.
 */
export const factoryLaunch = async (
  factory: Factory,
  card: FactoryCard,
  repo: string,
  launch: (extras: LaunchExtras) => Promise<Outcome<SessionData>>,
  /** The Overrides in force in `repo` (`runOverridesIn`): the run's hard facts, and yours shown (#168). */
  overrides: RunOverrides = { keys: [], personal: [] },
  /** The card's prototype (#82, #351): every stage's reference. */
  reference?: { run: RunReference; prompt: string },
  /** What the person set in the Launch box (#347): the notes. */
  setup: LaunchSetup = {},
  /** The workflow it runs (#15, `launchWorkflow`); default the built-in Feature. */
  workflow?: RunWorkflow,
  /** Why the repo's logins stop it at Needs you (`repoLoginsNeedsYou`), or null. */
  logins: string | null = null,
): Promise<Outcome<{ session: SessionData; run: Run }>> => {
  let id: string | undefined;
  const prompt = factoryLaunchPrompt(card, {
    note: setup.note,
    standing: setup.standing,
  });
  const launched = await launch({
    note: setup.note ?? null,
    standing: setup.standing ?? [],
    instructions: FACTORY_RUN_INSTRUCTIONS,
    prompt: reference === undefined ? prompt : `${prompt}\n\n${reference.prompt}`,
    permissionMode: FACTORY_PERMISSION_MODE,
    starting: (started) => {
      id = started;
      factory.start(
        newRun({
          session: started,
          card: card.id,
          title: card.title,
          repo,
          worktree: '',
          at: factory.stamp(),
          overrides: overrides.keys,
          personal: overrides.personal,
          reference: reference?.run ?? null,
          note: setup.note ?? null,
          standing: setup.standing ?? [],
          ...(workflow === undefined ? {} : { workflow }),
        }),
      );
    },
  });

  if (!launched.ok) {
    if (id !== undefined) factory.dropped(id);

    return launched;
  }
  const started = await runStarted(
    factory,
    launched.data.id,
    launched.data.worktree,
    launched.data.setup,
    logins,
  );

  return started.ok ? { ok: true, data: { session: launched.data, run: started.data } } : started;
};

/**
 * The card's prototype from the org store (#351, ADR 0023: no spec issue needed), its repo's name
 * in the store's keys; `undefined` without an org store or a prototype. `repo`: a checkout (its
 * origin names it), or a cloud run's `owner/repo`. Always read on the Mac: a box has no store.
 */
export const referenceOf = async (
  org: OrgStore | undefined,
  repo: string,
  card: number,
): Promise<Outcome<{ repo: string; meta: OrgPrototypeVersion } | undefined>> => {
  if (org === undefined) return { ok: true, data: undefined };
  // `owner/repo` is no path here: never read as a folder of serve's cwd
  const remote = isAbsolute(repo) ? ((await originUrl(repo)) ?? null) : null;
  const name = storeRepoName({ remote, repo });
  const found = await cardReference(org, name, card);

  if (!found.ok) return found;

  return { ok: true, data: found.data === undefined ? undefined : { repo: name, ...found.data } };
};

/** A card's prototype reference read for a launch: the run's, its prompt's words, its files. */
export type HeldReference = { run: RunReference; prompt: string; files: string };

/**
 * The card's prototype from the org store, downloaded into a folder of its own before the launch
 * (a refusal launches nothing): `factoryLaunch`'s `reference`, then `placeReference` once the
 * worktree exists, then `dropReference`. Both on the Mac, which has the store: a cloud run's is
 * handed to `factoryRun`, which copies it into the box's clone before its claude starts (a box has
 * no `ABE_ORG_STORE` and no store access, #351). `undefined`: no org store, or no prototype.
 */
export const holdReference = async (
  org: OrgStore | undefined,
  repo: string,
  card: number,
): Promise<Outcome<HeldReference | undefined>> => {
  const found = await referenceOf(org, repo, card);

  if (!found.ok) return found;
  const ref = found.data;

  if (ref === undefined || org === undefined) return { ok: true, data: undefined };
  const files = await mkdtemp(join(tmpdir(), 'abe-reference-'));
  const got = await downloadVersion(org, ref.repo, card, ref.meta.version, files);

  if (!got.ok) {
    await rm(files, { recursive: true, force: true });

    return refused(
      got.error.code,
      `AB#${card}'s prototype reference did not read: ${got.error.message}`,
    );
  }

  return {
    ok: true,
    data: {
      run: runReference(ref.meta),
      prompt: referencePrompt({ meta: ref.meta, dir: referenceDir(card) }),
      files,
    },
  };
};

/**
 * The held reference copied into the run's worktree (`.scratch/<card>/prototype`), on disk before
 * any stage reads it; a copy that fails stops the run at Needs you saying so.
 */
export const placeReference = async (
  factory: Factory,
  run: Run,
  held: HeldReference | undefined,
): Promise<Outcome<Run>> => {
  if (held === undefined) return { ok: true, data: run };
  try {
    await cp(held.files, join(run.worktree, held.run.dir), { recursive: true });

    return { ok: true, data: run };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);

    return factory.apply(
      run.session,
      { type: 'needs-you', reason: `the prototype reference did not copy: ${why}` },
      'reference',
    );
  }
};

/** The held reference's folder removed: the worktree has its own copy. */
export const dropReference = async (held: HeldReference | undefined): Promise<void> => {
  if (held !== undefined) await rm(held.files, { recursive: true, force: true });
};

export type FactoryCtx = SessionCtx &
  StoredLoginsCtx & { serve: Pick<RepoPortsCtx['serve'], 'localMode'> } & {
    ports: Partial<Pick<RepoPortsCtx['ports'], 'boardAt'>> & {
      /** The run's git, by its card: a report's spike branch is pushed with it, as a pull request's. */
      git?: ByCard<Git> | undefined;
    };
    /** The request came in from the box's workspace container: its paths are the container's. */
    inside?: boolean;
    serve: {
      /** Where a card's prototype is found (#82, #351): every stage's reference. */
      org?: OrgStore | undefined;
      factory: Factory | undefined;
      /** Each card's workspace's browser on a box's serve: verification's end stops it. */
      browser?: ByCard<BrowserService> | undefined;
      /** A local run's own browser (#182): verification's end stops it too. */
      localBrowsers?: LocalBrowsers | undefined;
      /** Clears Done runs past their next local midnight (#48): status runs it first. */
      clearing: { sweep: () => Promise<void> } | undefined;
      /**
       * The environments a run's checkout enables for agents (the repo's own setting); unset: dev
       * and test (`DEFAULT_AGENT_ENVS`). A Playbook step on any other is the person's.
       */
      agentEnvs?: ((checkout: string) => readonly string[]) | undefined;
      /**
       * What a card's worktree got from its checkout (`worktreeCopies`: the worktree recipe's links
       * and copies, the env files): never the run's changes.
       */
      worktreeCopies?: ((checkout: string) => Promise<readonly { path: string }[]>) | undefined;
    };
  };

const noFactory = () =>
  refused('no-sessions', 'this abe serve was started without a session runner');

/**
 * A session that is no Factory run (a plain launch, a chat): every factory command's refusal says
 * so, and who starts one (#186). `card`, the one asked about: its own card with no run anywhere is
 * `no run on AB#<card>`; any other's run is never named to it.
 */
const notARun = async (
  ctx: FactoryCtx,
  session: string,
  card?: number,
): Promise<Outcome<never>> => {
  const meta = await ctx.serve.sessions?.get(session);
  const own = meta?.ok === true ? meta.data.card : null;
  // its own repo's runs only: another checkout's run of the same number is not its card's
  const { here } = meta?.ok === true ? await repoHere(meta.data.repo) : {};
  const said = `session ${session} is not a Factory run: do ${own === null ? 'the work' : "the card's work"} here without \`abe factory\`. A person starts a run with \`abe factory run ${own ?? '<card>'}\`.`;
  // Its own card's runs, here and on your boxes: only none at all is `no run on`.
  const runs =
    card === undefined || card !== own
      ? undefined
      : [
          ...(ctx.serve.factory?.all() ?? []).filter(
            (r) => r.card === card && r.cleared === null && isHere(here, r.repo),
          ),
          ...((await ctx.serve.cloud?.runs(card)) ?? []).filter((r) => isHere(here, r.repo)),
        ];
  const none = runs?.length === 0;

  return refused('no-run', none ? `no run on AB#${card}: ${said}` : said);
};

/**
 * The run of the session the request came in on: the agent's commands act on it alone, and from
 * outside a session they are refused.
 */
export const ownRun = async <T>(
  ctx: FactoryCtx,
  command: string,
  then: (f: Factory, run: Run) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  if (ctx.serve.factory === undefined) return noFactory();
  if (ctx.session === undefined)
    return refused(
      'not-in-session',
      `abe factory ${command} is run by the agent from inside its run's session`,
    );
  const run = ctx.serve.factory.get(ctx.session);

  if (run === undefined) return notARun(ctx, ctx.session);
  // A session reopened after its run was over (#343): a plain conversation, no stage moves.
  if (runOver(run)) return refused('run-over', runOverText(run.card, run.outcome));

  return then(ctx.serve.factory, run);
};

/**
 * Whether the run's session browser (a box's workspace one, or a local run's own) ran during the
 * run, so a not-reproduced is a verdict (#319); undefined when the session has none, it cannot
 * be read now, or this serve started after the run (a restart forgets the stops before it).
 */
const browserRan = async (ctx: FactoryCtx, run: Run): Promise<boolean | undefined> => {
  const browser = ctx.serve.browser?.(run.card) ?? ctx.serve.localBrowsers?.of(run.session);
  const read = await browser?.status();

  return browser !== undefined && read?.ok === true
    ? browserRanSince(read.data, run.startedAt, browser.watchedSince)
    : undefined;
};

/**
 * Asked outside any repo (`here` none), a card whose `runs` are in more than one checkout: which
 * one is meant is not known, so none is picked; why, naming them. Card numbers are only a board's,
 * and two checkouts may even share one board.
 */
export const severalRuns = (
  runs: readonly Run[],
  card: number,
  here: RepoHere | undefined,
): Outcome<never> | undefined => {
  if (here !== undefined) return undefined;
  const checkouts = [...new Set(runs.map((r) => mainCheckout(r.repo) ?? r.repo))];

  return checkouts.length > 1
    ? refused(
        'several-runs',
        `AB#${card} has runs in ${checkouts.join(' and ')}: type it in the checkout it is for`,
      )
    : undefined;
};

/**
 * A run a step's `ends:` just ended (`was` going, `now` reported): its spike, if it made one,
 * pushed and kept on what it reported, not awaited (a spike not pushed is the report's loss, never
 * the run's). The report stays in the run (its Run page and Chat): nothing is written on the card
 * (`NOT_COMMENTED`).
 */
const keepReported = (ctx: FactoryCtx, f: Factory, was: Run, now: Run): void => {
  if (was.outcome !== null || now.outcome !== 'reported' || now.reported === null) return;
  void pushSpike(ctx, now)
    .then(async (spike) => {
      if (spike !== null) await keepSpike(f, now, spike);
    })
    .catch(() => undefined);
};

/** A spike as `pushSpike` left it: its branch, and whether it went to origin. */
type Spike = { branch: string; pushed: boolean };

/**
 * The spike kept on what the run reported (`spike`): its branch's commits since the merge base,
 * oldest first, read where the run is; none when they cannot be read.
 */
const keepSpike = async (f: Factory, run: Run, spike: Spike): Promise<void> => {
  const commits = await f.tree(run.card).commits(run.worktree);

  await f.apply(
    run.session,
    {
      type: 'spike',
      spike: {
        branch: spike.branch,
        commits: commits.ok ? commits.data : [],
        pushed: spike.pushed,
      },
    },
    'spike',
  );
};

/**
 * A reported run's spike (an investigation's throwaway code, committed on its card branch):
 * pushed to origin as a pull request's branch is; never merged. Null: no commit of its own to
 * push; else its branch and whether it was pushed.
 */
export const pushSpike = async (
  ctx: Pick<FactoryCtx, 'ports'> & { serve: Pick<FactoryCtx['serve'], 'sessions'> },
  run: Run,
): Promise<Spike | null> => {
  const git = ctx.ports.git?.(run.card);
  const branch = ctx.serve.sessions?.metaOf(run.session)?.branch;

  if (git === undefined || branch === undefined || run.worktree === '') return null;
  const work = await git.work(run.worktree);

  if (!work.ok || work.data === null || work.data.unpushed === 0) return null;
  const origin = await git.origin(run.worktree);
  const pushed = origin.ok ? await git.push(run.worktree, branch) : origin;

  return { branch, pushed: pushed.ok };
};

export const answer = (f: Factory, moved: Outcome<Run>): Outcome<FactoryRunData> =>
  moved.ok ? { ok: true, data: f.data(moved.data) } : moved;

/** What a file the caller names but nobody finds is refused as. */
type Missing = { code: string; what: string };

const NO_REPORT: Missing = { code: 'no-report', what: 'report file' };

/**
 * The text of a `--report` the caller names, or why not: from a local session, relative to its
 * cwd and its own (`ownPath`); from the workspace container (#67), the container's path, which
 * the run's tree reads there, only inside the worktree. `--made` and `--findings-file` are read
 * the same way.
 */
const readReport = async (
  ctx: OwnCtx & { cwd: string; inside?: boolean },
  f: Factory,
  run: Run,
  report: string,
  missing: Missing = NO_REPORT,
): Promise<Outcome<string>> => {
  const file =
    ctx.inside === true ? { ok: true as const, data: report } : await ownPath(ctx, report);

  if (!file.ok)
    return file.error.code === 'unreadable-file' ? noReport(ctx, report, missing) : file;
  const read = await f.tree(run.card).report(run.worktree, file.data);

  return read.ok
    ? read
    : noReport(ctx.inside === true ? { cwd: run.worktree } : ctx, report, missing);
};

/**
 * A `--made` file held to its shape (`stepMadeOf`: build's lanes, the tickets); a file that is
 * not there or does not hold is refused `bad-made`, naming the problem.
 */
const madeOf = async (
  ctx: OwnCtx & { cwd: string; inside?: boolean },
  f: Factory,
  run: Run,
  path: string,
): Promise<Outcome<StepMade>> => {
  const text = await readReport(ctx, f, run, path, { code: 'bad-made', what: 'file' });

  if (!text.ok) return text;
  const made = stepMadeOf(text.data);

  return made.ok ? { ok: true, data: made.made } : refused('bad-made', `${path}: ${made.problem}`);
};

/**
 * A `--findings-file` held to its shape (`findingsFileOf`), its must findings as many as
 * `--findings`; one that is not there or does not hold is refused `bad-findings`.
 */
const findingsOf = async (
  ctx: OwnCtx & { cwd: string; inside?: boolean },
  f: Factory,
  run: Run,
  path: string,
  findings: number,
): Promise<Outcome<ReviewFindingsFile>> => {
  const text = await readReport(ctx, f, run, path, { code: 'bad-findings', what: 'file' });

  if (!text.ok) return text;
  const read = findingsFileOf(text.data, findings);

  return read.ok
    ? { ok: true, data: read.file }
    : refused('bad-findings', `${path}: ${read.problem}`);
};

/**
 * An After pass held to the repo's Feature map (`verification-pack.ts`): every mapped feature
 * listed under `## Features`, a driven one with how it was judged and its surface's proof (a web
 * feature's screenshot and recording, an api or cli one's transcript; a feature file's `surface:`
 * over the pack's) in its Evidence (`.scratch/<card>/`), one not driven with why; its HTML report given,
 * each feature's section with its `## Features` verdict. No map: nothing to hold it to.
 */
const featuresRefused = async (
  f: Factory,
  run: Run,
  report: string,
  text: string,
  html: { path: string; text: string } | undefined,
): Promise<Outcome<never> | null> => {
  const tree = f.tree(run.card);
  // the pack the worktree holds: `verify-<app>`, the checkout folder's name when there are several
  const packs = (await tree.folders(join(run.worktree, REPO_SKILLS_DIR))).filter((n) =>
    n.startsWith('verify-'),
  );
  const own = verifySkillName(run.repo);
  const name = packs.includes(own) ? own : packs[0];

  if (name === undefined) return null;
  const dir = `${REPO_SKILLS_DIR}/${name}`;
  const paths = { map: `${dir}/features/README.md`, skill: `${dir}/SKILL.md` };
  const map = await tree.report(run.worktree, paths.map);
  const features = map.ok ? featuresOf(map.data) : [];

  if (features.length === 0) return null;
  const scratch = join(run.worktree, '.scratch', String(run.card));
  const held = new Map<string, string[]>();

  // the files in each Evidence folder the verdicts name, read where the run is
  for (const v of featureVerdicts(text)?.verdicts ?? [])
    for (const e of v.driven ? v.evidence : []) {
      const dir = dirname(e);

      if (!held.has(dir))
        held.set(dir, await tree.transcript.list(join(scratch, dir), run.worktree));
    }
  const skill = await tree.report(run.worktree, paths.skill);
  const surface = packSurface(skill.ok ? skill.data : undefined);
  const texts = new Map<string, string | undefined>();

  // each feature's own surface, said in its file (an api feature in a web pack)
  for (const id of features) {
    const read = await tree.report(run.worktree, `${dir}/features/${id}.md`);

    texts.set(id, read.ok ? read.data : undefined);
  }
  const said = packRefusal([
    ...featureReportFindings({
      surface,
      surfaces: featureSurfaces(texts, surface),
      features,
      report,
      text,
      there: (path) => (held.get(dirname(path)) ?? []).includes(basename(path)),
    }),
    ...featureHtmlFindings({ report, text, html }),
  ]);

  return said === null ? null : refused(said.code, said.message);
};

/**
 * The After pass's HTML report sanitised (`verify-html.ts`): only the verify kit's parts, each
 * image, recording and transcript a file in its Evidence (`.scratch/<card>/`), read where the
 * run is; written back as the kit's own HTML.
 */
const sanitisedHtml = async (f: Factory, run: Run, html: string): Promise<string> => {
  const tree = f.tree(run.card);
  const scratch = join(run.worktree, '.scratch', String(run.card));
  const held = new Map<string, string[]>();

  for (const src of verifyHtmlSources(verifyHtmlOf(html))) {
    const dir = dirname(src);

    if (!held.has(dir)) held.set(dir, await tree.transcript.list(join(scratch, dir), run.worktree));
  }

  return verifyHtmlText(
    verifyHtmlOf(html, (path) => (held.get(dirname(path)) ?? []).includes(basename(path))),
  );
};

const noReport = (ctx: { cwd: string }, report: string, missing: Missing = NO_REPORT) =>
  refused(missing.code, `no ${missing.what} at ${resolve(ctx.cwd, report)}`);

/**
 * The playbook step's Playbook, as the run keeps it: `.abe/playbooks/<card>.md` in its worktree
 * held to its shape (`playbookProblems`, refused `bad-playbook` naming each); none there: null,
 * the change needs none.
 */
const playbookOf = async (
  ctx: FactoryCtx,
  f: Factory,
  run: Run,
): Promise<Outcome<PlaybookKept | null>> => {
  const path = playbookPath(run.card);
  const read = run.worktree === '' ? undefined : await f.tree(run.card).report(run.worktree, path);

  if (read?.ok !== true) return { ok: true, data: null };
  const repoEnvs = ctx.serve.agentEnvs?.(run.repo) ?? DEFAULT_AGENT_ENVS;
  // prod on for the run's session alone (ADR 0029): its Playbook may name prod too
  const enabled =
    ctx.serve.sessions?.metaOf(run.session)?.prodOn === true && !repoEnvs.includes('prod')
      ? [...repoEnvs, 'prod']
      : repoEnvs;
  const pb = parsePlaybook(read.data);
  const problems = playbookProblems(pb, enabled);

  return problems.length === 0
    ? { ok: true, data: keptPlaybook(run.card, pb, enabled) }
    : refused('bad-playbook', `${path}: ${problems.join('; ')}`);
};

/**
 * A review or verify move with its report: tried first, so a refused move keeps no report; then
 * the report copied to the card's `.scratch/<card>/<kind>/` in the run's worktree.
 */
const reportedMove = async (
  f: Factory,
  run: Run,
  kind: 'review' | 'verify',
  report: { suffix: string; text: string; html?: string } | undefined,
  move: (path: string | null) => Move,
): Promise<Outcome<FactoryRunData>> => {
  if (report !== undefined && run.worktree === '')
    return refused('no-worktree', `AB#${run.card}'s run has no worktree to keep its report in`);
  // Numbered by what the folder holds, so a report of an earlier level is never written over.
  const dir = reportPath(run.worktree, run.card, kind, '');
  const path =
    report === undefined
      ? null
      : join(dir, `${(await f.tree(run.card).count(dir)) + 1}${report.suffix}`);
  const tried = step(run, move(path), f.stamp());

  if (!tried.ok) return refused(tried.code, tried.message);
  if (path !== null && report !== undefined) {
    const kept = await f.tree(run.card).write(run.worktree, path, report.text);

    if (!kept.ok) return refused(kept.error.code, kept.error.message);
    // its HTML report beside it, as `verifyHtmlPath` names it
    const html =
      report.html === undefined
        ? undefined
        : await f.tree(run.card).write(run.worktree, verifyHtmlPath(path), report.html);

    if (html?.ok === false) return refused(html.error.code, html.error.message);
  }

  return answer(f, await f.apply(run.session, move(path), kind));
};

/**
 * The branch a pr step's `into:` names, held to git's rules and on origin now: refused
 * `bad-into-branch` or `no-into-branch` (a teammate's pull request's head, never written to).
 */
export const intoBranchOn = async (
  git: Git,
  worktree: string,
  into: { fact: string; branch: FactValue | null },
): Promise<Outcome<string>> => {
  if (typeof into.branch !== 'string' || into.branch === '')
    return refused(
      'no-into-branch',
      `the pr step opens into ${into.fact}, which no step reported as a branch: report it with --fact ${into.fact}=<branch>`,
    );
  const problem = branchNameProblem(into.branch);

  if (problem !== undefined) return refused('bad-into-branch', `${into.fact}: ${problem}`);
  const there = await git.onOrigin(worktree, into.branch);

  if (!there.ok) return there;

  return there.data
    ? { ok: true, data: into.branch }
    : refused(
        'no-into-branch',
        `origin has no branch ${into.branch} (${into.fact}): name the head branch of the pull request on origin`,
      );
};

/**
 * A step reporting the fact its pr step's `into:` names (a teammate's pull request's head): the
 * card branch starts from that branch on origin before the run moves on, so what is built lands
 * on their work and the pull request into it holds only the fixes. Refused when the branch is no
 * branch on origin, or the card branch holds work of its own (`own-work`); nothing is pushed.
 */
const startedAtInto = async (
  ctx: FactoryCtx,
  run: Run,
  facts: Readonly<Record<string, FactValue>>,
): Promise<Outcome<null>> => {
  const into = intoOf(run);

  if (into === null || !(into.fact in facts)) return { ok: true, data: null };
  if (ctx.ports.git === undefined)
    return refused('no-git', 'this abe serve has no git for sessions');
  const git = ctx.ports.git(run.card);
  const branch = await intoBranchOn(git, run.worktree, {
    fact: into.fact,
    branch: facts[into.fact] ?? null,
  });

  if (!branch.ok) return branch;
  const origin = await git.origin(run.worktree);

  if (!origin.ok) return origin;
  const started = await git.startAt(run.worktree, {
    from: branch.data,
    base: origin.data.defaultBranch,
  });

  return started.ok ? { ok: true, data: null } : started;
};

export const factoryHandlers = <Ctx extends FactoryCtx>() =>
  ({
    'factory run': (args, ctx) =>
      saidLaunch(
        ctx,
        args.card,
        args.repo ?? '.',
        (run) => run.session,
        () =>
          runCard(ctx, {
            card: args.card,
            repo: args.repo ?? '.',
            target: args.target,
            profile: args.profile,
            note: args.note,
            noteFile: args.noteFile,
            short: args.short,
            workflow: args.workflow,
            prod: args.prod,
            replace: args.replace,
          }),
      ),
    'factory stage-done': (args, ctx) =>
      ownRun(ctx, 'stage-done', async (f, run) => {
        const text =
          args.report === undefined ? undefined : await readReport(ctx, f, run, args.report);

        if (text !== undefined && !text.ok) return text;
        // what it made, as its skill wrote it: held to its shape before anything moves
        const made = args.made === undefined ? undefined : await madeOf(ctx, f, run, args.made);

        if (made !== undefined && !made.ok) return made;
        const facts = factValues(args.fact);

        if (!facts.ok) return refused('usage', facts.message, 2);
        // Tried first, so a refused move keeps no report.
        const tried = step(
          run,
          { type: 'stage-done', stage: args.stage, report: null, facts: facts.facts },
          f.stamp(),
        );

        if (!tried.ok) return refused(tried.code, tried.message);
        // The pr step's `into:` reported: the card branch starts from that branch first.
        const into = await startedAtInto(ctx, run, facts.facts);

        if (!into.ok) return into;
        // The playbook step: serve reads what it wrote, refused when it hands Abe a step it may not run.
        const playbook = run.step === PLAYBOOK_STEP ? await playbookOf(ctx, f, run) : undefined;

        if (playbook !== undefined && !playbook.ok) return playbook;
        const report = text === undefined ? null : f.report(run.session, args.stage, text.data);
        const moved = await f.apply(
          run.session,
          {
            type: 'stage-done',
            stage: args.stage,
            report,
            facts: facts.facts,
            ...(playbook === undefined ? {} : { playbook: playbook.data }),
            ...(made === undefined ? {} : { made: made.data }),
          },
          'stage-done',
        );

        if (moved.ok) keepReported(ctx, f, run, moved.data);

        return answer(f, moved);
      }),
    'factory judge': (args, ctx) =>
      ownRun(ctx, 'judge', async (f, run) => {
        const moved = await f.apply(
          run.session,
          { type: 'judge', answer: args.answer === 'yes', reason: args.reason },
          'judge',
        );

        if (moved.ok) keepReported(ctx, f, run, moved.data);

        return answer(f, moved);
      }),
    'factory review': (args, ctx) =>
      ownRun(ctx, 'review', async (f, run) => {
        if (!Number.isInteger(args.findings) || args.findings < 0)
          return refused('usage', `--findings is a count (0, 1, 2 …), not ${args.findings}`, 2);
        const text =
          args.report === undefined ? undefined : await readReport(ctx, f, run, args.report);

        if (text !== undefined && !text.ok) return text;
        const file =
          args.findingsFile === undefined
            ? undefined
            : await findingsOf(ctx, f, run, args.findingsFile, args.findings);

        if (file !== undefined && !file.ok) return file;
        const report = text === undefined ? undefined : { suffix: '.md', text: text.data };

        return reportedMove(f, run, 'review', report, (path) => ({
          type: 'review',
          findings: args.findings,
          report: path,
          regression: namesOf(args.regression ?? ''),
          ...(file === undefined
            ? {}
            : { items: file.data.findings, earlier: file.data.earlier, risk: file.data.risk }),
        }));
      }),
    'factory verify': (args, ctx) =>
      ownRun(ctx, 'verify', async (f, run) => {
        const text = await readReport(ctx, f, run, args.report);

        if (!text.ok) return text;
        const html = args.html === undefined ? undefined : await readReport(ctx, f, run, args.html);

        if (html !== undefined && !html.ok) return html;
        // An After pass says, per mapped feature, its verdict, how it was judged and its proof,
        // and its HTML report the same verdicts
        const features =
          args.phase === 'after' && args.result === 'pass'
            ? await featuresRefused(
                f,
                run,
                args.report,
                text.data,
                args.html === undefined || html === undefined
                  ? undefined
                  : { path: args.html, text: html.data },
              )
            : null;

        if (features !== null) return features;
        // Its header names the browser profile Before and After ran in (#103).
        const profile = ctx.serve.sessions?.metaOf(run.session)?.browserProfile ?? DEFAULT_PROFILE;
        const report = {
          suffix: `-${args.phase}.md`,
          text: withProfileLine(text.data, profile),
          ...(html === undefined ? {} : { html: await sanitisedHtml(f, run, html.data) }),
        };
        const verdicts = args.phase === 'after' ? featureResults(text.data) : [];

        const ran = args.result === 'not-reproduced' ? await browserRan(ctx, run) : undefined;
        const moved = await reportedMove(f, run, 'verify', report, (path) => ({
          type: 'verify',
          phase: args.phase,
          result: args.result,
          report: path ?? '',
          regression: namesOf(args.regression ?? ''),
          ...(verdicts.length === 0 ? {} : { features: verdicts }),
          ...(path === null || html === undefined ? {} : { html: verifyHtmlPath(path) }),
          ...(ran === undefined ? {} : { browserRan: ran }),
        }));

        // A bug that did not reproduce ends the run (its `ends:`): its spike kept with the report.
        const now = moved.ok ? f.get(run.session) : undefined;

        if (now !== undefined) keepReported(ctx, f, run, now);
        // Verification's end stops the workspace's browser (a box's serve has one), or a local
        // run's own (#182).
        if (moved.ok && endsVerification(args.phase, args.result))
          await (ctx.serve.browser?.(run.card) ?? ctx.serve.localBrowsers?.of(run.session))?.stop(
            'verified',
          );

        return moved;
      }),
    'factory base-worktree': (_, ctx) =>
      ownRun(ctx, 'base-worktree', async (_f, run) =>
        ctx.serve.sessions === undefined
          ? noFactory()
          : ctx.serve.sessions.baseWorktree(run.session),
      ),
    'factory needs-you': (args, ctx) =>
      ownRun(ctx, 'needs-you', async (f, run) => {
        const ran = await browserRan(ctx, run);
        const move: Move = {
          type: 'needs-you',
          reason: args.reason,
          ...(args.option.length === 0 ? {} : { options: args.option }),
          ...(ran === undefined ? {} : { browserRan: ran }),
        };

        return answer(f, await f.apply(run.session, move, 'needs-you'));
      }),
    'factory status': async (args, ctx) => {
      const { factory, sessions } = ctx.serve;

      if (factory === undefined || sessions === undefined) return noFactory();
      const card = args.card === undefined ? undefined : parseCardId(args.card);

      if (args.card !== undefined && card === undefined)
        return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);
      // Sessions whose claude is gone are ended first, so their runs say so.
      const settled = await sessions.list();

      if (!settled.ok) return settled;
      // Done runs past their next midnight are cleared first: they are no longer shown.
      await ctx.serve.clearing?.sweep();
      const shown = (r: Run) => (r.cleared === null) !== args.cleared;
      if (ctx.session !== undefined) {
        const found = factory.get(ctx.session);
        const own = found !== undefined && shown(found) ? found : undefined;

        if (found === undefined) return notARun(ctx, ctx.session, card);
        if (card !== undefined && found.card !== card)
          return refused(
            'not-your-session',
            `session ${ctx.session} may see only its own run, not AB#${card}'s`,
          );

        return { ok: true, data: { runs: own === undefined ? [] : [factory.data(own)] } };
      }

      // the repo it is read in: which runs are the shown repo's (#256), asked meanwhile
      const asked = repoHere(ctx.cwd);
      // The runs on your boxes too (#67), as each box answers.
      const boxed = ctx.serve.cloud === undefined ? [] : await ctx.serve.cloud.runs(card);

      return {
        ok: true,
        data: {
          runs: [
            ...factory
              .all()
              .filter((r) => shown(r) && (card === undefined || r.card === card))
              .map(factory.data),
            ...boxed,
          ],
          ...(await asked),
        },
      };
    },
    'factory checks': async (args, ctx) => {
      const { factory } = ctx.serve;

      if (factory === undefined) return noFactory();
      const card = parseCardId(args.card);

      if (card === undefined) return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);
      // Inside a session: its own run's only. Else the card's newest run.
      const own = ctx.session === undefined ? undefined : factory.get(ctx.session);

      if (ctx.session !== undefined && own === undefined) return notARun(ctx, ctx.session, card);
      if (ctx.session !== undefined && own?.card !== card)
        return refused(
          'not-your-session',
          `session ${ctx.session} may run only its own run's checks, not AB#${card}'s`,
        );
      // the card of the repo it is asked in, never another repo's of the same number (#256)
      const { here } = own === undefined ? await repoHere(ctx.cwd) : {};
      const ofCard = factory.all().filter((r) => r.card === card && isHere(here, r.repo));
      const several = own === undefined ? severalRuns(ofCard, card, here) : undefined;

      if (several !== undefined) return several;
      const run = own ?? ofCard.at(-1);

      if (run === undefined) {
        // A run on one of your boxes: its checks run there (#67).
        const boxed =
          ctx.session === undefined ? await ctx.serve.cloud?.checks(card, here) : undefined;

        return boxed ?? refused('no-run', `AB#${card} has no Factory run`);
      }
      // A developer's prototype (#83) has no checks: it never ships.
      if (run.prototype)
        return refused(
          PROTOTYPE_NEVER_SHIPS,
          `AB#${card}'s run is a developer's prototype: it has no checks, it never ships`,
        );

      return factory.checks(run);
    },
  }) satisfies Partial<Handlers<Ctx>>;

/** A prototype's card is built from its prototype: never launched without it, here or on a box (#351). */
const noOrgStore = (ctx: FactoryCtx, card: CardDetail, repo: string) =>
  orgAt(ctx, repo) === undefined && hasPrototype(card)
    ? refused(
        'no-org-store',
        `AB#${card.id} has a prototype, but ABE_ORG_STORE names no org store to read it from (file://<dir> or s3://<bucket>)`,
      )
    : undefined;

/**
 * `--replace`: the card's sessions not ended in this repo, on this Mac (`path`) and on its box
 * (`repo`, its GitHub name), stopped as `abe session stop` stops them (their run and worktree
 * kept, ended), so the launch after is not refused `card-has-session`. Run after the launch's own
 * checks; a stop refused stops the launch.
 */
const replaceLive = async (
  ctx: FactoryCtx,
  card: number,
  path: string,
  repo: string | undefined,
): Promise<Outcome<null>> => {
  const live = (x: SessionData, on: string) =>
    x.card === card && x.repo === on && x.kind === 'card' && x.state !== 'ended';
  const { sessions, cloud } = ctx.serve;

  if (sessions !== undefined) {
    const listed = await sessions.list();

    if (!listed.ok) return listed;
    for (const x of listed.data.filter((y) => live(y, path))) {
      const stopped = await sessions.stop(x.id);

      if (!stopped.ok) return stopped;
    }
  }
  if (cloud !== undefined && repo !== undefined)
    for (const x of (await cloud.list()).filter((y) => live(y, repo))) {
      const stopped = await cloud.stop(x.id);

      if (!stopped.ok) return stopped;
    }

  return { ok: true, data: null };
};

/** A local launch's repo as its box names it (`owner/repo`); none: no environment, or no origin. */
const boxRepoOf = async (
  ctx: FactoryCtx,
  text: string,
  path: string,
): Promise<string | undefined> => {
  if (ctx.serve.cloud === undefined) return undefined;
  const repo = await cloudRepo(text, path);

  return repo.ok ? repo.data : undefined;
};

/**
 * `factory run`: the card launched where `serve.target` (or `target`) says, its prototype from
 * the org store as every stage's reference when it has one (#82, #351).
 */
export const runCard = async (
  ctx: FactoryCtx,
  args: {
    card: string;
    repo: string;
    target?: LaunchTarget | undefined;
    /** The browser profile it verifies in (#103); default `browser.default`. */
    profile?: string | undefined;
    /** Your Launch note (#347), as words or a file where the command was typed. */
    note?: string | undefined;
    noteFile?: string | undefined;
    /** Onto a short box (ADR 0022): resized first, or launched as it is; none: asked. */
    short?: ShortAnswer | undefined;
    /** The card workflow it runs, by id (`--workflow`); none: the one the card's `on:` picks. */
    workflow?: string | undefined;
    /** Prod on for agents in its session alone (`--prod`, the person's; ADR 0029): local only. */
    prod?: boolean | undefined;
    /** The card's live sessions stopped first (`--replace`, `replaceLive`); none: refused. */
    replace?: boolean | undefined;
  },
): Promise<Outcome<FactoryRunData>> => {
  const { factory, sessions } = ctx.serve;
  // Your environment (`--target cloud`, else `serve.target`): the run lives in the card's box's serve (#67).
  // an expired aws login of an environment it reaches refused there (prod's too with --prod)
  const placed = await placement(ctx, args.card, args.repo, args.target, args.prod === true);

  if (!placed.ok) return placed;
  if (args.prod === true && placed.data.kind === 'cloud')
    return refused(
      'prod-on-local-only',
      "--prod turns prod on for a local session: a box's session reaches what its Reach grants. Launch it with --target local-sandbox",
      2,
    );
  // Before and After verify in this one profile; refused now when nothing of it is stored.
  const profile = await launchProfile(
    ctx,
    placed.data.kind === 'cloud' ? placed.data.where : placed.data.path,
    args.profile,
  );

  if (!profile.ok) return profile;
  // Your Launch note and the standing notes where it launches (#347).
  const setup = await launchSetupOf(
    ctx,
    placed.data.kind === 'cloud' ? placed.data.where : placed.data.path,
    { note: args.note, noteFile: args.noteFile },
  );

  if (!setup.ok) return setup;
  if (placed.data.kind === 'cloud') {
    const { cloud, repo, where } = placed.data;
    const no = noOrgStore(ctx, placed.data.card, where);

    if (no !== undefined) return no;
    // picked here, in this checkout's sources (yours are never in the box's clone)
    const workflow = launchWorkflowFor(ctx.settings, where, placed.data.card, args.workflow);

    if (!workflow.ok) return workflow;
    const held = await holdReference(orgAt(ctx, where), repo, placed.data.card.id);

    if (!held.ok) return held;
    try {
      const card = { data: placed.data.card };
      const freed =
        args.replace === true ? await replaceLive(ctx, card.data.id, where, repo) : undefined;

      if (freed?.ok === false) return freed;
      const ran = await cloud.factoryRun(
        card.data,
        repo,
        where,
        profile.data,
        { ...setup.data, workflow: workflow.data },
        held.data,
        args.short,
      );

      // #159: the box's run says so once it answers; the launch says it now, from this checkout.
      return ran.ok && noChecksIn(ctx.settings, where)
        ? { ok: true, data: { ...ran.data, noChecks: true } }
        : ran;
    } finally {
      await dropReference(held.data);
    }
  }
  if (factory === undefined || sessions === undefined) return noFactory();
  const repo = placed.data.path;
  const read = await readCard(ctx, args.card, repo);

  if (!read.ok) return read;
  const no = noOrgStore(ctx, read.data, repo);

  if (no !== undefined) return no;
  // the workflow picked (`--workflow`), else the card's in the sources of its checkout
  const workflow = launchWorkflowFor(ctx.settings, repo, read.data, args.workflow);

  if (!workflow.ok) return workflow;
  const reach = await sessionReach({ ...ctx, cwd: repo }, 'local');

  if (!reach.ok) return reach;
  const held = await holdReference(orgAt(ctx, repo), repo, read.data.id);

  if (!held.ok) return held;
  const reference = held.data;
  const card = { data: read.data };

  try {
    // its box's session too: the one the card shows may be there
    const freed =
      args.replace === true
        ? await replaceLive(ctx, card.data.id, repo, await boxRepoOf(ctx, args.repo, repo))
        : undefined;

    if (freed?.ok === false) return freed;
    const ran = await factoryLaunch(
      factory,
      { ...card.data, board: boardKindIn(ctx, repo) },
      repo,
      (extras) =>
        sessions.launch(card.data, repo, reach.data.env, launchSettings(ctx, repo), {
          ...extras,
          browserProfile: profile.data,
          // Its own browser for verify, as a box's workspace has one (#182).
          browser: true,
          factory: true,
          // prod on for this session alone, the person's at launch (ADR 0029)
          ...(args.prod === true ? { prodOn: true } : {}),
        }),
      runOverridesIn(ctx.settings, repo),
      reference,
      setup.data,
      workflow.data,
      // A teammate's first card here asks for the repo's logins (its logins:) before it builds.
      await repoLoginsNeedsYou(ctx, repo),
    );

    if (!ran.ok) return ran;
    const placed = await placeReference(factory, ran.data.run, reference);

    if (!placed.ok) return placed;
    const meta = ctx.serve.sessions?.metaOf(placed.data.session);
    const shared = meta === undefined ? undefined : await branchSharedOf(ctx, meta);

    return {
      ok: true,
      data: {
        ...factory.data(placed.data),
        ...(shared === undefined ? {} : { branchShared: shared }),
      },
    };
  } finally {
    await dropReference(reference);
  }
};
