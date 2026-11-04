/**
 * The Factory view's rules, pure and as tables: where a stage sits on the stage rail, what a
 * run's look is (its state, word and glyph), what stands out, a card's rail row, whose a card is
 * on Team, the counts and the status bar's widgets. A run's state comes from `abe factory status`
 * and its session's hooks (`abe session list`, `session.state`), never a transcript.
 */
import type {
  BoardChangedEvent,
  BoxData,
  BoxListData,
  CardData,
  FactoryPrData,
  FactoryRunData,
  LaunchProgress,
  SessionData,
  Stage,
} from '@abe/core';
import { DONE_ENVIRONMENT, MERGED_IS_DONE } from './factory-words';
import type { Emphasis, Glyph, RailRow, RailSegment } from './board';
import { type BoxMark, type BoxMoves, cardBoxName, isUp } from '../live';
import { boxBooting } from '@abe/core/box-text';
import { waitsOnYou } from '@abe/core/waits-on';
import type { AgentState, Widget } from '../runtime/runtime';
import { launchLook, type LaunchTone } from './launch';

/** The Board's columns, in order (cards in any other state go to Other). */
export const COLUMNS = ['New', 'Active', 'Resolved', 'Closed'] as const;

/** The states a card is done in (core's `DONE_STATES`: Agile's Closed, Scrum's Done). */
export const DONE_STATES: readonly string[] = ['Closed', 'Done'];

export const isDone = (state: string): boolean => DONE_STATES.includes(state);

export const OTHER = 'Other';

/** An abandoned run's word: its look's, and where Chat's stage dividers end it. */
export const ABANDONED = 'Abandoned';
/** A run ended as not reproduced: its word, and where Chat's stage dividers end it. */
export const NOT_REPRODUCED = 'Not reproduced';

/** The stage rail's five stages, left to right: the stage word a card's rail row says. */
export const RAIL_STAGES = ['Spec', 'Build', 'Review', 'PR', 'Done'] as const;
export type RailStage = (typeof RAIL_STAGES)[number];

/**
 * The rail stage a run's stage is on. A run starts on its workflow's first step (Spec in Feature,
 * Build in Quick fix); checks are the build's own gate, so the card stays on Build until they pass.
 */
export const RAIL_STAGE_OF: Readonly<Record<Stage, RailStage>> = {
  spec: 'Spec',
  // a bug's Before is understanding the card
  reproduce: 'Spec',
  build: 'Build',
  checks: 'Build',
  review: 'Review',
  verify: 'Review',
  pr: 'PR',
  // a workflow's plain step (any skill) first in its run is work on the card; later, it stays on
  // the stage the run was on (`railStageIn`)
  step: 'Build',
  done: 'Done',
};

/**
 * The rail stage `stage` is on, after the stages `before` it in its run: its own
 * (`RAIL_STAGE_OF`), but a plain step has none: the run stays on the one it was on (to-tickets on
 * Spec, playbook on Review), Build when it starts the run.
 */
export const railStageIn = (
  stage: Stage,
  before: readonly Pick<FactoryRunData['stages'][number], 'stage'>[],
): RailStage => {
  const on = stage === 'step' ? before.findLast((v) => v.stage !== 'step')?.stage : stage;

  return RAIL_STAGE_OF[on ?? stage];
};

/** The step word that replaces Running while a run works in a stage (AgentStatus). */
export const STEP_WORDS: Readonly<Record<Stage, string>> = {
  spec: 'Writing spec',
  reproduce: 'Reproducing',
  build: 'Running',
  checks: 'Checking',
  review: 'Reviewing',
  verify: 'Verifying',
  pr: 'Opening PR',
  step: 'Running',
  done: 'On test',
};

/**
 * What a run counts as in the header and the status bar. Ready for review counts as itself,
 * since a person merges it and nothing runs or asks you.
 */
export type Counted = 'running' | 'needs-you' | 'failed' | 'ready' | 'none';

/** What a run's card says on its rail row, and what a session's row says (Sessions). */
export type Look = {
  state: AgentState;
  /**
   * The run's word, the same on every screen: the step word while it works (`Writing spec`),
   * else its state's.
   */
  word: string;
  glyph: Glyph;
  /** Its card: standing out (needs you, failed) or as any card. */
  emphasis: Emphasis;
  /** Its own segment of the rail. */
  segment: RailSegment;
  counted: Counted;
  /**
   * A cloud launch's tone. It stays `starting` (no Retry, no Running); only its hue goes amber
   * once a step is slow, red near the give-up (`shownState`).
   */
  tone?: LaunchTone;
  /** It ended without shipping (Abandoned, Not reproduced): dim `○`, never ✓ or Done. */
  givenUp?: true;
};

const look = (
  state: AgentState,
  word: string,
  o: { glyph?: Glyph; emphasis?: Emphasis; segment: RailSegment; counted: Counted },
): Look => ({
  state,
  word,
  glyph: o.glyph ?? '●',
  emphasis: o.emphasis ?? 'normal',
  segment: o.segment,
  counted: o.counted,
});

const NEEDS_YOU = look('needs-you', 'Needs you', {
  glyph: '◆',
  emphasis: 'needs-you',
  segment: 'need',
  counted: 'needs-you',
});
/**
 * Its turn ended and nothing is asked: your turn, dim, never counted (a question card, a dialog
 * or a run's Needs you is what needs you).
 */
export const IDLE = look('idle', 'Idle', { glyph: '○', segment: 'wait', counted: 'none' });
/** Queued past the team's box limit: dim, nothing runs yet. */
const QUEUED = look('idle', 'Queued', { glyph: '○', segment: 'wait', counted: 'none' });
/** You stopped its session: dim, nothing failed and nothing waits on you. */
export const STOPPED = look('idle', 'Stopped', { glyph: '○', segment: 'wait', counted: 'none' });

/**
 * Its box stopped under its session (`abe box stop`, or it slept while the session waited on
 * you). Nothing failed; the run waits on you to Retry it there, where its branch is.
 */
export const BOX_ASLEEP = look('needs-you', 'Box asleep', {
  glyph: '◆',
  emphasis: 'needs-you',
  segment: 'need',
  counted: 'needs-you',
});

/**
 * How the reason of a session its box ended while it waited on you begins: core's
 * `BOX_SLEPT_WAITING`, redeclared because ui reads only core's types; `sessions.test.ts`
 * fails if the two part.
 */
export const BOX_SLEPT_WAITING = 'its box went to sleep while it waited on you';

/** How the reason of a session whose box stopped begins: core's `boxStoppedHead`, redeclared. */
export const boxStoppedHead = (box: string): string => `its box ${box} stopped`;

/** Its box went to sleep while it waited on you: shown until a new session on its card. */
export const sleptWhileWaiting = (
  x: Pick<SessionData, 'state'> & Partial<Pick<SessionData, 'reason'>>,
): boolean => x.state === 'ended' && x.reason?.startsWith(BOX_SLEPT_WAITING) === true;

/**
 * It ended with its box: the box slept while it waited on you, or stopped. A launch on its card
 * goes on there, where its branch and files are.
 */
export const endedWithBox = (
  x: Pick<SessionData, 'state'> & Partial<Pick<SessionData, 'reason' | 'box'>>,
): boolean =>
  sleptWhileWaiting(x) ||
  (x.state === 'ended' &&
    x.box !== undefined &&
    x.reason?.startsWith(boxStoppedHead(x.box)) === true);

/**
 * Why serve ended a session whose Claude Code went away with no SessionEnd: core's
 * `CRASHED`, redeclared because ui reads only core's types; `flow.test.ts` fails if the two part.
 */
export const CRASHED = 'Claude Code exited without ending it (crashed)';

/** Its Claude Code exited without ending it: `✗ Crashed · ⏎ Reopen`. */
export const crashedSession = (
  x: Pick<SessionData, 'state'> & Partial<Pick<SessionData, 'reason'>>,
): boolean => x.state === 'ended' && x.reason === CRASHED;

/** A session that crashed: red, as a failure, and Reopen goes on with it. */
export const CRASHED_LOOK = look('failed', 'Crashed', {
  glyph: '✗',
  emphasis: 'failed',
  segment: 'fail',
  counted: 'failed',
});

/**
 * An ended session's own word where no run says more: Stopped when you stopped it, as its
 * run's card says, else Ended; the same in Chat's header, Sessions and the tabs.
 */
export const endedWord = (session: Partial<Pick<SessionData, 'stopped'>>): string =>
  session.stopped === true ? STOPPED.word : 'Ended';
const running = (word: string) => look('running', word, { segment: 'now', counted: 'running' });

/** A run in pr with its pull request open: as the pull request stands. */
const prLook = (pr: FactoryPrData, state: FactoryRunData['state']): Look => {
  if (pr.state === 'merged')
    return pr.deploy === 'failure'
      ? NEEDS_YOU
      : running(`Deploying to ${pr.done ?? DONE_ENVIRONMENT}`);
  if (pr.state === 'closed' || pr.checks === 'failure') return NEEDS_YOU;
  const ready = look('ready', 'Ready for review', { segment: 'ready', counted: 'ready' });

  // the run waits for a person to merge (`merge waits for a person`): said so, not its checks
  // as last read (they ran on, so pending no more)
  if (pr.merge === 'person' && state === 'needs-you') return ready;
  if (pr.checks === 'pending') return running('Checks running');
  if (pr.merge === 'person') return ready;

  return state === 'needs-you' ? NEEDS_YOU : running('Merging');
};

export type RunFacts = Pick<FactoryRunData, 'stage' | 'state' | 'outcome' | 'pr'> &
  Partial<Pick<FactoryRunData, 'prototype' | 'ended'>>;

const ended = (word: string) =>
  look('ended', word, { glyph: '✓', segment: 'done', counted: 'none' });

/**
 * What a session's look needs of it: its state, what it waits on (none known: it needs you), and
 * a cloud launch's steps.
 */
export type SessionFacts = Pick<SessionData, 'state'> & {
  launch?: LaunchProgress | null | undefined;
} & Partial<Pick<SessionData, 'reason' | 'box' | 'rounds' | 'waitingOn' | 'turnEnded'>>;

/** A launch's tone as a state's hue: amber once a step is slow, red near the give-up. */
const TONE_STATE: Readonly<Record<LaunchTone, AgentState>> = {
  'on-time': 'starting',
  slow: 'running',
  stuck: 'failed',
};

/** The state a look is drawn in: its own, a starting launch's in its tone's hue. */
export const shownState = (l: Look): AgentState =>
  l.tone === undefined ? l.state : TONE_STATE[l.tone];

/**
 * A starting session's look: a cloud launch says its step (`Box booting`), its hue its
 * tone; else Starting. `now` unknown: Starting.
 */
export const startingLook = (session: SessionFacts, now: string | undefined): Look => {
  const l = session.launch;

  if (l === null || l === undefined || now === undefined)
    return look('starting', 'Starting', { segment: 'wait', counted: 'running' });
  const seen = launchLook(l, now);

  return {
    ...look('starting', seen.word, { segment: 'wait', counted: 'running' }),
    tone: seen.tone,
  };
};

/**
 * A session's own look where no run says more: Queued, Starting (a cloud launch's
 * step), Running, Needs you (a question or a dialog), Idle (its turn ended), Stopped once you
 * stopped it, else Ended; the Board's card, Chat's header and the tabs read it alike.
 */
export const sessionLook = (
  session: SessionFacts & Partial<Pick<SessionData, 'stopped' | 'factory'>>,
  now: string | undefined,
): Look =>
  sessionOnlyLook(session, now) ??
  look('ended', 'Ended', { glyph: '○', segment: 'wait', counted: 'none' });

/** Whether any of `sessions` is a cloud launch starting: its clock ticks by the second. */
export const launchTicking = (sessions: readonly SessionFacts[] | undefined): boolean =>
  (sessions ?? []).some(
    (x) => x.state === 'starting' && x.launch !== null && x.launch !== undefined,
  );

/** A starting cloud launch's clock, by the second (`2:10`); undefined otherwise. */
export const launchClock = (
  session: SessionFacts | undefined,
  now: string | undefined,
): string | undefined =>
  session?.state === 'starting' &&
  session.launch !== null &&
  session.launch !== undefined &&
  now !== undefined
    ? launchLook(session.launch, now).elapsed
    : undefined;

/**
 * A run that is over, in words that say how: Answered (a question), Not reproduced or
 * Abandoned (a person's end), Done (a person ended it done: it may never have been deployed),
 * Merged (`factory.done: merged`), else On <its Done environment> (On test).
 */
const overLook = (run: RunFacts): Look => {
  if (run.outcome === 'reported') return ended('Reported');
  // given up, or not reproduced: dim on the stage it stopped in (`railStageOf`), nothing reads as
  // shipped
  if (run.outcome === 'abandoned' || run.outcome === 'not-reproduced')
    return {
      ...look('ended', run.outcome === 'abandoned' ? ABANDONED : NOT_REPRODUCED, {
        glyph: '○',
        segment: 'wait',
        counted: 'none',
      }),
      givenUp: true,
    };
  const where = run.pr?.done ?? DONE_ENVIRONMENT;
  let word = `On ${where}`;

  if (run.ended?.as === 'done') word = 'Done';
  else if (where === MERGED_IS_DONE) word = 'Merged';

  // its state stays on-test's (settled, the good hue): only the word says how it got there
  return look('on-test', word, { glyph: '✓', segment: 'done', counted: 'none' });
};

/**
 * A run's look, first rule that matches: over (`overLook`: On test, Answered, Not reproduced…);
 * Queued past the team's box limit; Starting while its box or claude starts (a cloud launch's
 * step word); in pr, as its pull request stands; Stopped when you stopped its session; Box
 * asleep when its box stopped under it; Failed when its session ended on its own while the run
 * waits; Needs you; its session waiting, Needs you on a question or a dialog, else Idle (serve
 * calls a waiting session's run Needs you, so Idle shows only between that `session.state` and
 * its `factory.stage`; a prototype's run stays Idle, its turn simply ended); else the step word.
 */
export const lookOf = (
  run: RunFacts,
  session: (SessionFacts & Partial<Pick<SessionData, 'stopped'>>) | undefined,
  now?: string,
  whose?: string,
): Look => {
  const base = runLook(run, session, now);

  return run.stage === 'spec' ? (questionLook(base, session, whose) ?? base) : base;
};

/** The first name a teammate's spec questions wait on (`Needs Ana`). */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/**
 * A run in its spec, the one rule every screen reads through `lookOf`: an open round of questions
 * `◆ Needs you · Question round 2` (a teammate's, `whose`: `◆ Needs Ana · Question round 2`);
 * any other look (Starting, Stopped, Failed, Box asleep) as it is.
 */
const questionLook = (
  base: Look,
  session: Pick<SessionFacts, 'state' | 'rounds' | 'waitingOn'> | undefined,
  whose: string | undefined,
): Look | undefined => {
  const asked = session?.rounds ?? 0;
  // its session waiting with a round asked, before its run says so: not once its turn simply ended
  const open =
    asked > 0 &&
    (base === NEEDS_YOU ||
      (base === IDLE && session?.state === 'waiting' && session.waitingOn !== 'turn'));

  return open
    ? {
        ...NEEDS_YOU,
        word: `${whose === undefined ? 'Needs you' : `Needs ${firstName(whose)}`} · Question round ${asked}`,
      }
    : undefined;
};

const runLook = (
  run: RunFacts,
  session: (SessionFacts & Partial<Pick<SessionData, 'stopped'>>) | undefined,
  now: string | undefined,
): Look => {
  if (run.state === 'done' || run.outcome !== null) return overLook(run);
  const stopped = session?.state === 'ended' && session.stopped === true;

  // a Queued run stopped: its session's end can come before the run's own move
  if ((run.state === 'queued' && !stopped) || session?.state === 'queued') return QUEUED;
  if (session?.state === 'starting') return startingLook(session, now);
  if (run.stage === 'pr' && run.pr !== null) return prLook(run.pr, run.state);
  if (stopped) return STOPPED;
  // its box stopped under it: nothing failed, Retry goes on there
  if (run.state === 'needs-you' && session !== undefined && endedWithBox(session))
    return BOX_ASLEEP;
  // its Claude Code went away mid-run: Crashed, and Reopen goes on in its stage
  if (run.state === 'needs-you' && session !== undefined && crashedSession(session))
    return CRASHED_LOOK;
  if (run.state === 'needs-you')
    return session?.state === 'ended'
      ? look('failed', 'Failed', {
          glyph: '✗',
          emphasis: 'failed',
          segment: 'fail',
          counted: 'failed',
        })
      : NEEDS_YOU;
  // a question or a dialog needs you at once (a prototype's run takes no Needs you from its
  // session); its turn simply ended, or not known yet, is Idle
  if (session?.state === 'waiting')
    return session.waitingOn === 'question' || session.waitingOn === 'dialog' ? NEEDS_YOU : IDLE;

  return running(STEP_WORDS[run.stage]);
};

/**
 * Whether a session with no run still stands for its card: live, or a plain one
 * (no Factory run's) ended because you stopped it (`○ Stopped`, ⏎ Resume) until a newer session
 * on its card. One that ended on its own does not (the card says No session, Sessions drops it),
 * nor a Factory run's whose run is no longer shown (cleared: it was stopped for that).
 */
export const standsAlone = (
  session: Pick<SessionData, 'state'> &
    Partial<Pick<SessionData, 'stopped' | 'factory' | 'reason'>>,
): boolean =>
  session.state !== 'ended' ||
  ((session.stopped === true || crashedSession(session)) && session.factory !== true);

/**
 * A session with no run on its card (a plain launch, or one whose run another `serve` kept): its
 * own look, as Chat's header and Sessions say it; stopped, Stopped; ended on its own, none (the
 * card says No session).
 */
export const sessionOnlyLook = (
  session: SessionFacts & Partial<Pick<SessionData, 'stopped' | 'factory'>>,
  now?: string,
): Look | undefined => {
  switch (session.state) {
    case 'waiting':
      return waitsOnYou(session) ? NEEDS_YOU : IDLE;
    case 'working':
      // its turn ended, only its background subagents work: your turn
      return session.turnEnded === true ? IDLE : running('Running');
    case 'starting':
      return startingLook(session, now);
    case 'queued':
      return QUEUED;
    case 'ended':
      if (!standsAlone(session)) return undefined;

      return crashedSession(session) ? CRASHED_LOOK : STOPPED;
  }
};

/**
 * What a card stands for: its run (and the run's session, once listed), or a session with no
 * run.
 */
export type Standing = { run?: FactoryRunData; session?: SessionData };

/**
 * What each card stands for, of the shown repo's runs and sessions: the one rule the Board's
 * card, Chat's pin and Sessions read. Its newest live one (a session not ended, a run's or a
 * plain one; a run waiting on you, or whose session is not listed yet, while it is not over),
 * else its newest of its runs and its sessions with no run. A session with no run that no longer
 * stands (`standsAlone`: it ended on its own) stands for nothing and leaves the card its newest
 * run. An older plain session you stopped gave way to it all the same.
 */
export const standing = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
): Map<number, Standing> => {
  type Candidate = Standing & { card: number; live: boolean; at: number };
  const byId = new Map(sessions.map((x) => [x.id, x]));
  const ran = new Set(runs.map((r) => r.session));
  const ofRuns: Candidate[] = runs.map((run) => {
    const session = byId.get(run.session);

    return {
      card: run.card,
      run,
      ...(session === undefined ? {} : { session }),
      // waiting on you (Failed, Box asleep: its session ended under it) is not over either
      live:
        run.outcome === null &&
        (session === undefined
          ? run.state !== 'done'
          : session.state !== 'ended' || run.state === 'needs-you'),
      at: Date.parse(run.startedAt),
    };
  });
  // a card's session only: a prototype's or a retro chat stands for no card without its run
  const alone: Candidate[] = sessions.flatMap((session) =>
    session.card === null || session.kind !== 'card' || ran.has(session.id)
      ? []
      : [
          {
            card: session.card,
            session,
            live: session.state !== 'ended',
            at: Date.parse(session.startedAt),
          },
        ],
  );
  const best = (all: readonly Candidate[]) => {
    const by = new Map<number, Candidate>();

    for (const x of all) {
      const had = by.get(x.card);

      if (had === undefined || (Number(x.live) - Number(had.live) || x.at - had.at) > 0)
        by.set(x.card, x);
    }

    return by;
  };
  const newestRun = best(ofRuns);
  const by = new Map<number, Standing>();

  for (const [card, x] of best([...ofRuns, ...alone])) {
    const kept =
      x.run !== undefined || (x.session !== undefined && standsAlone(x.session))
        ? x
        : newestRun.get(card);

    if (kept !== undefined)
      by.set(card, {
        ...(kept.run === undefined ? {} : { run: kept.run }),
        ...(kept.session === undefined ? {} : { session: kept.session }),
      });
  }

  return by;
};

/** The session a card is on: its id, the session once listed, and the run it is of. */
export type CardOn = Standing & { id: string };

/**
 * The session a card is on, for what opens it: ⌃W's workspace, Linked's Worktree and Box
 * rows, `serve`'s Linked read. What the card stands for (`standing`, as its Board card and Chat
 * read it: its run's session, listed or not, or one with no run), else, nothing standing, its
 * newest card session all the same (one that ended on its own: its workspace is still there).
 */
export const cardSession = (
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
  card: number,
): CardOn | undefined => {
  const ofCard = sessions.filter((x) => x.card === card);
  const stands = standing(
    runs.filter((r) => r.card === card),
    ofCard,
  ).get(card);
  // a Standing has its run or its session (or both)
  const id = stands?.session?.id ?? stands?.run?.session;

  if (stands !== undefined && id !== undefined) return { ...stands, id };
  const newest = ofCard
    .filter((x) => x.kind === 'card')
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

  return newest === undefined ? undefined : { id: newest.id, session: newest };
};

/** A session-only card's rail row: no stage reached, the session's state and its clock. */
export const sessionRailRow = (
  session: Pick<SessionData, 'state' | 'since'> & SessionFacts,
  l: Look,
  o: { now: string | undefined; box?: BoxMark | undefined },
): RailRow => {
  const time = launchClock(session, o.now) ?? minutesIn(session.since, o.now);

  return {
    segments: RAIL_STAGES.map(() => 'todo'),
    glyph: l.glyph,
    word: l.word,
    state: shownState(l),
    ...(time === '' ? {} : { time }),
    ...(o.box === undefined ? {} : { box: o.box }),
  };
};

/** What a run's place on the rail is worked out from. */
export type RailFacts = Pick<FactoryRunData, 'stage' | 'outcome' | 'stages'> &
  Partial<Pick<FactoryRunData, 'ended' | 'state'>>;

/** A run still Queued for a box: nothing ran, so it stands on no stage yet. */
export const onNoStage = (run: Partial<Pick<FactoryRunData, 'state'>>): boolean =>
  run.state === 'queued';

/**
 * The rail stage a run stands on: its stage's, but an abandoned or not reproduced run stays on
 * the one it was ended in. It ended without shipping, so never Done.
 */
export const railStageOf = (run: RailFacts): RailStage =>
  railStageIn(
    (run.outcome === 'abandoned' || run.outcome === 'not-reproduced') &&
      run.ended !== null &&
      run.ended !== undefined
      ? run.ended.from
      : run.stage,
    run.stages,
  );

/** The stages that light another's segment, by their own word: the word beside them says it. */
const OWN_WORD: Partial<Readonly<Record<Stage, string>>> = {
  reproduce: 'Reproduce',
  checks: 'Checks',
  verify: 'Verify',
};

/**
 * The rail's word for where a run is: its segment's (`railStageOf`), but a stage lighting
 * another's segment by its own (Decide and Checks light Build, Grill Spec, Verify Review), so it
 * says what its step word says (Decide · Deciding, Verify · Verifying).
 */
export const railWord = (run: RailFacts): string => {
  const from =
    (run.outcome === 'abandoned' || run.outcome === 'not-reproduced') &&
    run.ended !== null &&
    run.ended !== undefined
      ? run.ended.from
      : run.stage;

  return OWN_WORD[from] ?? railStageOf(run);
};

/**
 * The rail's five segments: the stages before the run's done, its own as it stands, the rest to
 * do; all to do while it is Queued.
 */
export const railSegments = (run: RailFacts, own: RailSegment): RailSegment[] => {
  if (onNoStage(run)) return RAIL_STAGES.map(() => 'todo');
  const rail = railStageOf(run);
  const at = RAIL_STAGES.indexOf(rail);

  if (rail === 'Done') return RAIL_STAGES.map(() => 'done');

  return RAIL_STAGES.map((_, i) => {
    if (i < at) return 'done';

    return i === at ? own : 'todo';
  });
};

/** A card's story points as the Board's line 1 and the story dialog's facts say them: `3 pt`. */
export const pointsText = (points: number | null): string | undefined =>
  points === null ? undefined : `${points} pt`;

/**
 * The stage word on a run's rail row: its rail stage (`Prototype` for a developer's prototype);
 * none once Done, nor while it is Queued.
 */
export const stageWord = (run: RunFacts & Pick<FactoryRunData, 'stages'>): string | undefined => {
  if (run.prototype === true) return 'Prototype';
  if (onNoStage(run)) return undefined;
  return railStageOf(run) === 'Done' ? undefined : railWord(run);
};

/** The box mark of a box EC2 lists, by its state. */
const LISTED_MARK: Readonly<Record<BoxData['state'], BoxMark | undefined>> = {
  pending: 'starting',
  running: 'running',
  stopping: 'asleep',
  stopped: 'asleep',
  'shutting-down': undefined,
  terminated: undefined,
};

/** What a run that never got a box says where its box would be. */
export const NEVER_PLACED = 'never got a box';

/**
 * The Box row of a story with no box, one wording for the story dialog's Linked and ⌃L's: `none
 * yet` before a session, `none · Local sandbox` for one on this Mac (as its Session row names
 * where it runs), `none · never got a box` for one that never got one.
 */
export const noBoxWords = (s: Pick<SessionData, 'neverPlaced'> | undefined): string => {
  if (s === undefined) return 'none yet';

  return `none · ${s.neverPlaced === true ? NEVER_PLACED : 'Local sandbox'}`;
};

/**
 * The box a session has: none for a local one, nor for one that never got its box (taken out of
 * the queue before one had it), whose `box` only names the one it waited for.
 */
export const placedBox = (
  s: Pick<SessionData, 'box' | 'neverPlaced'> | undefined,
): string | undefined => (s?.neverPlaced === true ? undefined : s?.box);

/** Where a session runs, in words: its box, `never got a box`, or the Local sandbox. */
export const whereOf = (s: Pick<SessionData, 'box' | 'neverPlaced'>): string =>
  s.neverPlaced === true ? NEVER_PLACED : (s.box ?? 'Local sandbox');

/**
 * The box mark on a card's rail row: its box is the session's, else the one tagged with the card
 * (`abe:card`, asleep too), else the one its placement is Queued for. Then its state: the box's
 * last `box.state` when one came after the list was read (running, starting; stopping or stopped
 * asleep; queued; a failed one asleep, its card says the rest), else what `box list` says (a
 * Queued placement `queued`; one booting at `now`, its serve not answering yet, starting), else
 * what the session says (queued, starting, ended asleep, else running). None for a card with no
 * box at all.
 */
export const boxMarkOf = (
  session: Pick<SessionData, 'box' | 'state' | 'neverPlaced'> | undefined,
  moves: BoxMoves,
  o: {
    card?: number | undefined;
    list?: BoxListData | undefined;
    now?: number | undefined;
  } = {},
): BoxMark | undefined => {
  const name =
    placedBox(session) ??
    (o.card === undefined || o.list === undefined ? undefined : cardBoxName(o.list, o.card));

  if (name === undefined) return undefined;
  const moved = Object.hasOwn(moves, name) ? moves[name] : undefined;

  switch (moved) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'queued':
      return 'queued';
    case 'stopping':
    case 'stopped':
    case 'failed':
    case 'terminated':
      return 'asleep';
    default:
      break;
  }
  const listed = o.list?.boxes.find((b) => b.name === name);
  // a placement Queued for a sleeping box: it waits for room, then is woken
  const queued =
    o.list?.queued.some((q) => q.box === name && (o.card === undefined || q.card === o.card)) ===
    true;

  if (queued && (listed === undefined || !isUp(listed.state))) return 'queued';
  if (listed !== undefined && o.now !== undefined && boxBooting(listed, o.now)) return 'starting';
  const mark = listed === undefined ? undefined : LISTED_MARK[listed.state];

  if (mark !== undefined) return mark;
  if (session === undefined || placedBox(session) === undefined) return undefined;
  switch (session.state) {
    case 'queued':
      return 'queued';
    case 'starting':
      return 'starting';
    case 'ended':
      return 'asleep';
    default:
      return 'running';
  }
};

/**
 * A run's rail row on its card: the segments, the stage word, the glyph and word in the state's
 * hue (Chat's header's words), its clock (`clockSince`), the box mark. Done reads `✓ On test ·
 * 31 min`.
 */
export const railRow = (
  run: RunFacts & Pick<FactoryRunData, 'since' | 'stages'>,
  l: Look,
  o: {
    now: string | undefined;
    session: (Pick<SessionData, 'state' | 'since'> & SessionFacts) | undefined;
    box?: BoxMark | undefined;
  },
): RailRow => {
  const stage = stageWord(run);
  // a cloud launch by the second, else to the minute
  const time = launchClock(o.session, o.now) ?? minutesIn(clockSince(run, o.session), o.now);

  return {
    segments: railSegments(run, l.segment),
    ...(stage === undefined ? {} : { stage }),
    glyph: l.glyph,
    word: l.word,
    state: shownState(l),
    ...(time === '' ? {} : { time }),
    ...(o.box === undefined ? {} : { box: o.box }),
  };
};

/** Whether two people are one: by email when both have one, else by name (any case). */
const samePerson = (
  a: NonNullable<CardData['assignee']>,
  b: NonNullable<CardData['assignee']>,
): boolean =>
  a.email !== '' && b.email !== ''
    ? a.email.toLowerCase() === b.email.toLowerCase()
    : a.name.toLowerCase() === b.name.toLowerCase();

/**
 * Whether a card is assigned to you: in your Mine, or assigned to the person your Mine
 * cards are assigned to (a card made or assigned after Mine was read is yours too).
 */
export const isYours = (
  card: Pick<CardData, 'id' | 'assignee'>,
  mine: readonly Pick<CardData, 'id' | 'assignee'>[],
): boolean => {
  if (mine.some((c) => c.id === card.id)) return true;
  const who = card.assignee;

  return who !== null && mine.some((c) => c.assignee !== null && samePerson(c.assignee, who));
};

/** Whether `a` (a screen's board, unread: undefined) is the board a `board.changed` names. */
export const sameBoard = (
  a: BoardChangedEvent['board'] | undefined,
  b: BoardChangedEvent['board'],
): boolean => a?.organization === b.organization && a.project === b.project && a.team === b.team;

/** On Team, a teammate's card (assigned, not to you) is theirs; on Mine every card is yours. */
export const isTheirs = (
  card: Pick<CardData, 'id' | 'assignee'>,
  tab: 'mine' | 'team',
  mine: readonly Pick<CardData, 'id' | 'assignee'>[],
): boolean => tab === 'team' && card.assignee !== null && !isYours(card, mine);

/** The type badge: `Bug`, `US` for a User Story, else the first three capitals. */
export const typeBadge = (type: string): string => {
  if (type === 'Bug') return 'Bug';
  const capitals = type.replace(/[^A-Z]/g, '').slice(0, 3);

  return capitals === '' ? type.slice(0, 3) : capitals;
};

/** `Alex Example` → `AE`; one name gives one letter. */
export const initials = (name: string): string => {
  const words = name.split(/\s+/).filter((w) => w !== '');
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';

  return `${first}${last}`.toUpperCase();
};

/** Time in stage: `9 s`, `4 min`, `1 h`, `2 h 5 min`; empty before the clock is known. */
export const timeIn = (since: string, now: string | undefined): string => {
  if (now === undefined) return '';
  const s = Math.max(0, Math.floor((Date.parse(now) - Date.parse(since)) / 1000));

  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);

  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);

  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
};

/**
 * Time in stage to the minute, as a card's rail row says it (the tree changes once a minute, not
 * every tick): `<1 min`, `21 min`, `1 h 8 min`; empty before the clock is known.
 */
export const minutesIn = (since: string, now: string | undefined): string => {
  if (now === undefined) return '';

  return Date.parse(now) - Date.parse(since) < 60_000 ? '<1 min' : timeIn(since, now);
};

/** Whether a card or run matches the `/` filter: its title or `#id`, any case. */
export const matches = (o: { card: number; title: string }, filter: string): boolean => {
  const f = filter.trim().toLowerCase();

  return (
    f === '' ||
    o.title.toLowerCase().includes(f) ||
    `#${o.card}`.includes(f) ||
    `ab#${o.card}`.includes(f)
  );
};

export type Counts = { running: number; needsYou: number; failed: number; ready: number };

/** What `looks` count as: the Sessions tab's rows, as the toolbar pill and status bar say. */
export const countsOf = (looks: readonly Pick<Look, 'counted'>[]): Counts => ({
  running: looks.filter((l) => l.counted === 'running').length,
  needsYou: looks.filter((l) => l.counted === 'needs-you').length,
  failed: looks.filter((l) => l.counted === 'failed').length,
  ready: looks.filter((l) => l.counted === 'ready').length,
});

/** `● N ready for review`: in the good hue, as the card's word. */
export const readyText = (n: number): string => `● ${n} ready for review`;

/**
 * The status bar's `● N ready for review`, on the Factory view (the sprint is the status bar's
 * crumb, `workspaces.ts`). Who needs you and what runs are the ear's badges now (`ear.ts`), so
 * nothing counts twice.
 */
export const readyWidgets = (c: Counts): Widget[] =>
  c.ready > 0 ? [{ id: 'ready', text: readyText(c.ready), hue: 'good', view: 'factory' }] : [];

/** Subagents a session has working now (`⋔ N`), from its hooks. */
export const subagentsWorking = (s: Pick<SessionData, 'subagents'> | undefined): number =>
  s?.subagents.filter((r) => r.state === 'running').length ?? 0;

/**
 * When a run's stay on its rail stage began: its stage's start, or earlier while the stages
 * before it, back to back, sit on the same rail stage. Build's decide, build and checks are one
 * stay, a red check back into build too; a review that sends it back to build begins a new one.
 */
export const stayStart = (run: Pick<FactoryRunData, 'stage' | 'since' | 'stages'>): string => {
  const rail = railStageIn(run.stage, run.stages);
  let start = run.since;

  for (let i = run.stages.length - 1; i >= 0; i -= 1) {
    const visit = run.stages[i];

    if (visit === undefined || railStageIn(visit.stage, run.stages.slice(0, i)) !== rail) break;
    start = visit.startedAt;
  }

  return start;
};

/**
 * The one clock beside a run's state word, on every screen that shows it (the Board's
 * card, Chat's header, the toolbar's line and strip tab, Sessions, Linked's Run row, the
 * landing's order), to the minute (`minutesIn`): while its session waits on you, since it began
 * to wait (in this stay; not while the run waits on its pull request); else since its stay on
 * the rail stage began (`stayStart`).
 */
export const clockSince = (
  run: Pick<FactoryRunData, 'stage' | 'since' | 'stages' | 'state' | 'outcome' | 'pr'>,
  session: Pick<SessionData, 'state' | 'since'> | undefined,
): string => {
  const stay = stayStart(run);
  // done, or waiting on its pull request (its checks, a merge): the session's turns are no clock
  const open =
    run.state !== 'done' && run.outcome === null && !(run.stage === 'pr' && run.pr !== null);

  if (!open || session?.state !== 'waiting') return stay;

  return Date.parse(session.since) > Date.parse(stay) ? session.since : stay;
};
