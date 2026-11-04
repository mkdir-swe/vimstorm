/**
 * Card actions: launch, retry, reopen, stop and assign-then-launch on a card, one sub-machine the
 * Board, the Card page, Chat and Sessions embed, and the rules they go by. The rules first: the
 * rows of a card's `⌘⏎` Action menu, each the `abe` command it runs; `nextStep`, the card's one
 * next step, lifted to the top of the menu, where it opens (so ⌘⏎ ⏎ is the next step), and the
 * story dialog's primary (`story.ts`); the other rows keep their fixed order, a row that cannot
 * run now dim in its place saying why, then the older rows below a separator. Launch agent goes
 * where `serve.target` says, this Mac by default (ADR 0042). On no one's card the top row is Assign to me
 * and launch (`assignsToLaunch`); on a teammate's, or no one's on a read-only board, the launch
 * rows are grey with whose it is, the top one where the menu opens, ⏎ there nothing. Then the
 * machine: it holds the launches out (a second press launches nothing more), asks the same `abe`
 * commands from every screen, says the same refusals, takes their answers and the assign a launch
 * makes (its `u` undo); a screen does only what follows on its own (selects the card, pins Chat).
 */
import { cardName, isLocalNumber, localName } from '@abe/core/local-names';
import {
  type BoardMember,
  type BoxIdleData,
  type CardData,
  type FactoryRunData,
  type LaunchTarget,
  type RepoHere,
  type SessionData,
} from '@abe/core';
import { isHere } from '@abe/core/here';
import { hasPrototype } from '@abe/core/prototype-tag';
import { ENDINGS, notReproduced } from './factory-words';
import { clock, endedWhen, type LaunchHeard } from '../live';
import { COLUMNS, endedWithBox, isDone, NEVER_PLACED, placedBox } from './flow';
import { shortAnswerOf, shortMenu } from './launch-short';
import {
  type Answer,
  type Command,
  type Menu,
  type MenuAsk,
  type MenuRow,
  type Refused,
  stoppedWords,
  stopSessionConfirm,
  type Subject,
} from '../runtime/runtime';
import {
  assigned,
  assignOn,
  type AssignState,
  isAssignRun,
  keyed,
  NO_ASSIGNS,
  undoAssign,
} from './assign';

/** What a card's actions are worked out from. */
export type CardFacts = {
  card: CardData;
  /** Its newest run, and that run's session. */
  run?: FactoryRunData | undefined;
  session?: SessionData | undefined;
  /** It is on Mine (assigned to you); unknown until Mine is read. */
  mine: boolean;
  /** The board's team (`card members`, you first): whom Assign… offers beside Me. */
  members?: readonly BoardMember[] | undefined;
  /** `card members` failed: Assign… says the team was not read. */
  membersFailed?: boolean | undefined;
  /** The shown project's folder: `factory run`'s `--repo`. */
  root?: string | undefined;
  /** `serve.target` where the project is, once read. */
  target?: string | undefined;
  /** Its box: the session's, else the one tagged with the card (`box list`, as its mark). */
  box?: string | undefined;
  /** That box's idle stop, from the last `box.idle` or `box list`: Keep box awake's detail. */
  idle?: BoxIdleData | undefined;
  /**
   * `box list` refused as boxes off (`serve.target` local, no box profile named): there is no
   * cloud to move a session to, and a local session's Box says so.
   */
  boxesOff?: boolean | undefined;
  /** The board is read-only alone (`abe board read-only on`): it can't be assigned from here. */
  readOnly?: boolean | undefined;
};

/**
 * What Reopen, Retry run and whose the card is go by: its run and session, whether it is yours,
 * its assignee; a Sessions row knows no more (a session here is yours).
 */
export type CardStanding = Pick<CardFacts, 'run' | 'session' | 'mine' | 'readOnly'> & {
  card: Pick<CardData, 'id' | 'assignee'>;
};

/** `serve.target` runs on this Mac: Launch agent goes to the Local sandbox already. */
const runsHere = (target: string | undefined): boolean =>
  target === 'local' || target === 'local-sandbox';

/** A run or a session stands on the card. */
export const launchedOn = (f: Pick<CardFacts, 'run' | 'session'>): boolean =>
  f.run !== undefined || f.session !== undefined;

/** The card's own session (the newest run's), if this serve has it. */
const sessionOf = (f: {
  card: Pick<CardData, 'id'>;
  session?: SessionData | undefined;
}): SessionData | undefined => (f.session?.card === f.card.id ? f.session : undefined);

/**
 * The card's own session not ended (queued too), which a launch stops first (`--replace`, as
 * `abe session stop` does: its run and worktree kept, ended); its id, else undefined.
 */
export const replacing = (f: Parameters<typeof sessionOf>[0]): string | undefined => {
  const s = sessionOf(f);

  return s === undefined || s.state === 'ended' ? undefined : s.id;
};

/**
 * The card is yours: on Mine, or no one's with a run here that is not over, which you launched
 * (launching needs no assignee, so what it started is yours to stop, end or keep awake). An
 * abandoned run's card, back in New for anyone, is no one's again.
 */
const yours = (f: CardStanding): boolean =>
  f.mine || (f.card.assignee === null && f.run?.outcome === null && f.run.state !== 'done');

/** Whose the card is when it is not yours: why its launch rows are grey; undefined: yours. */
const whose = (f: CardStanding): string | undefined => {
  if (yours(f)) return undefined;

  // read-only: an assignment can't be made from here, so say why (`board-read-only`)
  if (f.readOnly === true)
    return `assigned to ${f.card.assignee?.name ?? 'no one'} · the board is read-only: assign it on the board, or abe board read-only off`;

  return f.card.assignee === null
    ? 'assigned to no one · Assign… › Me first'
    : `assigned to ${f.card.assignee.name}`;
};

/** Its Claude Code is starting, running or waiting on you: it has a workspace to open. */
const running = (s: SessionData | undefined): boolean =>
  s?.state === 'starting' || s?.state === 'working' || s?.state === 'waiting';

/**
 * Why a card cannot be launched on, or undefined: it is yours. A done card (the Board's Closed
 * column) launches too: an investigation's report closed it, and its fix comes next; the launch
 * moves it to Active. An ended session stays in Sessions and Linked: Launch new agent… starts
 * fresh beside it; a live one is stopped first (`replacing`).
 */
export const launchRefusal = (f: CardFacts): string | undefined => whose(f);

/** The launch row's words: Launch new agent… once the card had a session. */
export const launchWords = (f: CardFacts): string =>
  f.run === undefined && sessionOf(f) === undefined ? STEP_ROWS.launch : LAUNCH_NEW;

/** The Reopen row's spend and words: a session goes on and spends; Chat on a live one does not. */
const reopenLook = (s: SessionData | undefined): Pick<MenuRow, 'costly' | 'dim'> => {
  if (s === undefined) return { costly: true };

  return s.state === 'ended'
    ? { costly: true, dim: reopenDim(s.since) }
    : { costly: false, dim: 'Chat on it' };
};

/** The Reopen row's dim words: `same worktree and conversation · ended 14:02`. */
export const reopenDim = (endedAt: string, now?: string): string =>
  `same worktree and conversation · ended ${endedWhen(endedAt, now)}`;

/** Launch new agent…: an explicit new session on a card that has an old one. */
export const LAUNCH_NEW = 'Launch new agent…';

/** Retry run: a new session on the same card and worktree, the Factory from decide. */
export const RETRY_RUN = 'Retry run';

/**
 * Why an ended card session whose claude never started has no Reopen, and the way on:
 * Retry run on a run not over, else a new agent.
 */
export const noConversation = (retries: boolean): string =>
  `its claude never started a conversation: ${retries ? 'Retry run starts its card again' : 'Launch new agent… starts fresh'}`;

/**
 * Why the card's session cannot be reopened now, or undefined: an ended card session of
 * yours that had a box (a never-placed one has no workspace to go back into), or a live one (the
 * row is Chat on it then).
 */
export const reopenRefusal = (f: CardStanding): string | undefined => {
  const theirs = whose(f);

  if (theirs !== undefined) return theirs;
  const s = sessionOf(f);

  if (s === undefined) return 'no session yet';
  if (s.kind !== 'card') return 'not a card’s session';

  if (s.neverPlaced === true) return NEVER_PLACED;

  // no hook named its transcript (its claude never started): serve refuses no-conversation
  return s.state === 'ended' && s.transcriptPath === null
    ? noConversation(f.run !== undefined && retriesRun(f.run))
    : undefined;
};

/**
 * An ended session Reopen goes back into: a card's own, that had a box and kept a conversation
 * (a hook named its transcript; a `claude` that never started has none and serve refuses
 * `no-conversation`); the one rule Chat, Sessions, Linked and the card read.
 */
export const sessionReopens = (
  s: Pick<SessionData, 'state' | 'kind' | 'transcriptPath'> &
    Partial<Pick<SessionData, 'neverPlaced'>>,
): boolean =>
  s.state === 'ended' && s.kind === 'card' && s.neverPlaced !== true && s.transcriptPath !== null;

/** A run that is over: Done, answered, given up, not reproduced. */
const runIsOver = (run: FactoryRunData): boolean => run.outcome !== null || run.state === 'done';

/**
 * Whether Retry run starts this run again from decide: not over, and no pull request of it
 * open or merged (that one is the way on).
 */
export const retriesRun = (run: FactoryRunData): boolean =>
  !runIsOver(run) && (run.pr === null || run.pr.state === 'closed');

/** Why Retry run cannot run now, or undefined: an ended session of a run not over. */
export const retryRefusal = (f: CardStanding): string | undefined => {
  const theirs = whose(f);

  if (theirs !== undefined) return theirs;
  if (f.run === undefined) return 'no run yet';
  if (runIsOver(f.run)) return 'its run is over: Launch new agent… starts fresh';
  if (!retriesRun(f.run)) return 'its pull request is the way on';

  return sessionOf(f)?.state === 'ended' || sessionOf(f) === undefined
    ? undefined
    : 'already running';
};

/**
 * Reopen: `abe session reopen <id>` (`--message` its first prompt), the same session id,
 * worktree and Claude Code conversation; its answer is routed as a Retry's (`reopen:<card>`).
 */
export const reopenCommand = (card: number, session: string, message?: string): Command => ({
  kind: 'run',
  id: `reopen:${card}`,
  argv: ['session', 'reopen', session, ...(message === undefined ? [] : ['--message', message])],
});

/** What a card's one next step is: the menu's first row, the dialog's primary. */
export type NextStep = 'launch' | 'workspace' | 'reopen' | 'pull-request';

/**
 * Each next step's row, in one table: its id in the card's menu, where it is lifted to the
 * top, and its words, which the story dialog's primary says too.
 */
export const STEP_ROWS: Readonly<Record<NextStep, string>> = {
  launch: 'Launch agent',
  workspace: 'Open workspace',
  reopen: 'Reopen',
  'pull-request': 'Open pull request',
};

export { BOX_SLEPT_WAITING, boxStoppedHead, sleptWhileWaiting } from './flow';

/** Where a retry goes: a session that ended with its box goes on in the cloud. */
export const retryTarget = (
  session: Pick<SessionData, 'state' | 'reason' | 'box'> | undefined,
): LaunchTarget | undefined =>
  session !== undefined && endedWithBox(session) ? 'cloud' : undefined;

/** Triage's tag on a card that waits on its product owner's answer. */
export const NEEDS_INFO = 'needs-info';

/** The card is tagged needs-info. */
export const needsInfo = (c: Pick<CardData, 'tags'>): boolean =>
  c.tags.some((t) => t.toLowerCase() === NEEDS_INFO);

/**
 * The card's next step, or none: your card with no session launches; a session starting,
 * running or needing you opens its workspace; one ended before Done resumes; Done with a pull
 * request opens it; a done card (Closed) launches, resumes and retries nothing. A teammate's or
 * no one's card has none.
 */
export const nextStep = (f: CardFacts): NextStep | undefined => {
  if (!yours(f)) return undefined;
  const s = sessionOf(f);

  return ((): NextStep | undefined => {
    // Done with a pull request: it stays the way on; without one its ended session reopens
    if (f.run?.stage === 'done' || f.run?.state === 'done') {
      if (f.run.pr !== null) return 'pull-request';

      return s?.state === 'ended' && reopenRefusal(f) === undefined ? 'reopen' : undefined;
    }
    // a done card launches and reopens nothing; a live session still opens
    if (isDone(f.card.state)) return running(s) ? 'workspace' : undefined;
    if (s === undefined) return f.run === undefined ? 'launch' : undefined;
    if (running(s)) return 'workspace';

    if (s.state !== 'ended') return undefined;

    // ⏎ on any ended session of yours reopens it: failed and stopped runs too
    return reopenRefusal(f) === undefined ? 'reopen' : undefined;
  })();
};

/**
 * A card no one has, which you may assign (the board not read-only) and then launch: the story
 * dialog's primary is Assign to me and launch, never none.
 */
export const assignsToLaunch = (f: CardFacts): boolean =>
  !yours(f) &&
  f.card.assignee === null &&
  f.readOnly !== true &&
  nextStep({ ...f, mine: true }) === 'launch';

/** The story dialog's primary on a card `assignsToLaunch`. */
export const ASSIGN_AND_LAUNCH = 'Assign to me and launch';

/** What the Launch box set up: the Launch note, and the workflow picked. */
export type LaunchSetup = {
  note?: string | null | undefined;
  /** The workflow picked; none: the one the card's `on:` takes. */
  workflow?: string | null | undefined;
  /** Where it runs, as picked; none: where `serve.target` (or the caller) says. */
  target?: LaunchTarget | null | undefined;
  /** Prod on for this session alone (ADR 0029), the person's. */
  prod?: boolean | undefined;
};

/** The Launch box's values (`[note, workflow, runs, prod]`, `launch-box.ts`) as a setup. */
export const setupOf = (values: readonly string[] | undefined): LaunchSetup => {
  const [note = '', workflow = '', runs, prod] = values ?? [];

  return {
    note: note.trim() === '' ? null : note,
    workflow: workflow === '' ? null : workflow,
    target: runs === 'local-sandbox' || runs === 'cloud' ? runs : null,
    ...(prod === 'prod' ? { prod: true } : {}),
  };
};

/** What Retry run carries of the run it retries: its Launch note and its workflow. */
export const carriedOf = (
  run: Pick<FactoryRunData, 'note' | 'workflow'> | undefined,
): LaunchSetup => ({ note: run?.note?.text ?? null, workflow: run?.workflow?.id ?? null });

/**
 * `abe factory run <card>` from the shown project, to where the Launch box picked (else `target`,
 * else where serve.target says), with its note, workflow and prod; `--replace` while the card's
 * own session is live.
 */
export const launchArgv = (
  f: {
    card: Pick<CardData, 'id'>;
    root?: string | undefined;
    session?: SessionData | undefined;
  },
  target?: LaunchTarget,
  setup: LaunchSetup = {},
): string[] => [
  'factory',
  'run',
  String(f.card.id),
  ...(f.root === undefined ? [] : ['--repo', f.root]),
  ...((t) => (t === undefined ? [] : ['--target', t]))(setup.target ?? target),
  ...(setup.workflow === null || setup.workflow === undefined
    ? []
    : ['--workflow', setup.workflow]),
  ...(setup.prod === true ? ['--prod'] : []),
  // the card's live session stopped first, its run and worktree kept as a Stop keeps them
  ...(replacing(f) === undefined ? [] : ['--replace']),
  // one token: a note starting with `-` (a markdown list) is never read as a flag
  ...(setup.note === null || setup.note === undefined ? [] : [`--note=${setup.note}`]),
];

/**
 * Retry run and Launch new agent…: a new session on the card, `abe factory run` again
 * (`retry:<card>`), from the Board, the story dialog and Sessions alike.
 */
export const relaunch = (
  card: number,
  root: string | undefined,
  target?: LaunchTarget,
  run?: Pick<FactoryRunData, 'note' | 'workflow'>,
): Command => ({
  kind: 'run',
  id: `retry:${card}`,
  argv: launchArgv({ card: { id: card }, root }, target, carriedOf(run)),
});

/** Where Launch agent goes, as its detail says: serve.target's environment. */
const defaultWhere = (target: string | undefined): string => {
  if (target === undefined) return 'where serve.target says';

  return runsHere(target) ? 'Local sandbox · this machine' : 'Cloud';
};

/**
 * The quiet recovery row, below the separator: a cloud session's Download locally, a local
 * one's Move to cloud. It runs at once, no flow and no confirm. None while the card has no
 * session or it is not a card's own, nor Move to cloud while your boxes are off.
 */
export const moveRow = (f: CardFacts): MenuRow[] => {
  const s = f.session;

  if (s?.card !== f.card.id) return [];
  if (s.box === undefined && f.boxesOff === true) return [];
  if (s.box === undefined)
    return [
      {
        id: 'move-to-cloud',
        text: 'Move to cloud',
        costly: true,
        dim: 'recovery · go on in the cloud',
        does: { kind: 'run', argv: ['session', 'move-to-cloud', s.id] },
      },
    ];

  return [
    {
      id: 'download',
      text: 'Download locally',
      costly: true,
      dim: 'recovery · go on on this machine',
      ...(s.state === 'queued' ? { reason: 'queued: no Workspace yet' } : {}),
      ...(s.neverPlaced === true ? { reason: NEVER_PLACED } : {}),
      does: {
        kind: 'run',
        argv: ['session', 'download', s.id, ...(f.root === undefined ? [] : ['--repo', f.root])],
      },
    },
  ];
};

export { clock };

/** A row greyed with `reason`, else as it is. */
const unless = (reason: string | undefined, row: MenuRow): MenuRow =>
  reason === undefined ? row : { ...row, reason };

/** Keep box awake, or Let box sleep on a box kept awake (`box keep` / `box sleep`). */
const keepRow = (f: CardFacts, s: SessionData | undefined): MenuRow[] => {
  const row: MenuRow = { id: 'keep', text: 'Keep box awake', costly: true, does: { kind: 'back' } };
  const theirs = whose(f);

  if (theirs !== undefined) return [{ ...row, reason: theirs }];
  // its `box` only the one it waited for; a box tagged with the card is still kept awake
  const box = placedBox(s) ?? f.box;

  if (box === undefined && s?.neverPlaced === true) return [{ ...row, reason: NEVER_PLACED }];
  // on a local target no box is coming: it runs on this machine, as a local session does, so
  // there is no box to keep: no row
  if (box === undefined)
    return s === undefined && !runsHere(f.target) ? [{ ...row, reason: 'no box yet' }] : [];
  if (s?.box !== undefined && s.state === 'queued')
    return [{ ...row, reason: 'queued: no box yet' }];
  if (f.idle?.keptBy.includes('awake') === true)
    return [
      {
        ...row,
        text: 'Let box sleep',
        dim: 'kept awake',
        does: { kind: 'run', argv: ['box', 'sleep', box] },
      },
    ];

  return [
    {
      ...row,
      dim:
        f.idle === undefined || f.idle.stopsAt === null
          ? 'its idle stop waits'
          : `stops at ${clock(f.idle.stopsAt)}`,
      does: { kind: 'run', argv: ['box', 'keep', box] },
    },
  ];
};

/** End run…'s why, asked last: it is kept with the run and goes on the pull request. */
const WHY: MenuAsk = {
  name: 'reason',
  kind: 'flag',
  type: 'string',
  title: 'Why (kept with the run, on the pull request)',
  required: true,
  repeats: false,
  summary: 'why it ended',
};

/** Why a run cannot be ended from here now, or undefined. */
const endRefusal = (run: FactoryRunData | undefined, theirs: string | undefined) => {
  if (theirs !== undefined) return theirs;
  if (run === undefined) return 'no run yet';
  if (run.prototype) return 'a prototype: Stop… ends it';

  if (run.outcome === 'abandoned') return 'its run was abandoned';

  return run.state === 'done' ? 'its run is done' : undefined;
};

/** End run…'s how, a pick of the three endings. */
const END_AS: MenuAsk = {
  name: 'as',
  kind: 'flag',
  type: 'enum',
  values: [...ENDINGS],
  labels: { done: 'Done', 'not-reproduced': 'Not reproduced', abandoned: 'Abandoned' },
  title: 'End the run as',
  required: true,
  repeats: false,
  summary: 'how it ended',
};

/**
 * What `abe factory end` asks from a menu row or a Needs you card: how it ended, then why. The
 * pick starts on the neutral way: Not reproduced while the run waits because its bug does
 * not reproduce, else Abandoned; never Done, which says the work shipped.
 */
export const endAsks = (run: Pick<FactoryRunData, 'state' | 'reason'> | undefined): MenuAsk[] => [
  {
    ...END_AS,
    preselect: run !== undefined && notReproduced(run) ? 'not-reproduced' : 'abandoned',
  },
  WHY,
];

/**
 * End run…: `abe factory end` on the card, asked how (Done, Not reproduced, Abandoned)
 * and why; grey on a teammate's card, with no run, a done one or a prototype.
 */
export const endRow = (card: number, run: FactoryRunData | undefined, theirs?: string): MenuRow =>
  unless(endRefusal(run, theirs), {
    id: 'end',
    text: 'End run…',
    costly: true,
    dim: 'done, not reproduced or abandoned, with why',
    does: { kind: 'run', argv: ['factory', 'end', String(card)], ask: endAsks(run) },
  });

/** The most of the evidence End: can't reproduce shows in its detail. */
const EVIDENCE_CHARS = 60;

/**
 * End: can't reproduce, offered while a run waits on you because its bug does not
 * reproduce (`notReproduced`): its detail the evidence it waits with; none otherwise.
 */
export const notReproducedRow = (
  card: number,
  run: FactoryRunData | undefined,
  theirs?: string,
): MenuRow[] => {
  if (run === undefined || theirs !== undefined || !notReproduced(run)) return [];
  const why = run.reason ?? '';

  return [
    {
      id: 'end-not-reproduced',
      text: 'End: can’t reproduce',
      costly: true,
      dim: why.length > EVIDENCE_CHARS ? `${why.slice(0, EVIDENCE_CHARS - 1)}…` : why,
      does: {
        kind: 'run',
        argv: ['factory', 'end', String(card), '--as', 'not-reproduced'],
        ask: [WHY],
      },
    },
  ];
};

/** Whether the card is assigned to you: on Mine with an assignee. */
export const isYours = (f: Pick<CardFacts, 'card' | 'mine'>): boolean =>
  f.mine && f.card.assignee !== null;

/**
 * Assign…: a pick of Me (while it is not yours), then the team's other members A–Z as
 * `card members` lists them, the card's own assignee left out; filtered as you type, Me by your
 * name too. Handed back (`assign` with the pick's value: `me` or a member's email), so the screen
 * writes it and offers `u` to undo; its pick and status line in words, not the CLI's.
 */
const assignRow = (f: CardFacts): MenuRow => {
  const c = f.card;
  const id = String(c.id);
  const now = c.assignee?.email.toLowerCase();
  const others = (f.members ?? []).filter((m) => !m.you && m.email.toLowerCase() !== now);
  const you = f.members?.find((m) => m.you);
  const values = [...(isYours(f) ? [] : ['me']), ...others.map((m) => m.email)];
  // two of one name told apart by their emails
  const label = (m: BoardMember) =>
    others.filter((o) => o.name === m.name).length > 1 ? `${m.name} <${m.email}>` : m.name;
  const who = c.assignee?.name ?? 'no one';

  return unless(values.length === 0 ? 'already yours' : undefined, {
    id: 'assign',
    text: 'Assign…',
    dim: f.membersFailed === true ? `${who} · team not read` : who,
    does: {
      kind: 'back',
      ask: [
        {
          name: 'who',
          kind: 'positional',
          type: 'enum',
          values,
          labels: { me: 'Me', ...Object.fromEntries(others.map((m) => [m.email, label(m)])) },
          ...(you === undefined ? {} : { words: { me: you.name } }),
          title: `Assign #${id} to`,
          required: true,
          repeats: false,
          summary: 'who',
        },
      ],
    },
  });
};

/** The menu's fixed rows, in their order; a row that cannot run now says why. */
const fixedRows = (f: CardFacts): MenuRow[] => {
  const c = f.card;
  const id = String(c.id);
  const s = sessionOf(f);
  const theirs = whose(f);
  const assigns = assignsToLaunch(f);
  // a local session's worktree; else the card's branch from origin (`card checkout`)
  const worktree = (): string | undefined => (s?.neverPlaced === true ? NEVER_PLACED : undefined);
  const workspace = (): string | undefined => {
    if (!yours(f)) return c.assignee === null ? theirs : `${c.assignee.name}’s workspace`;

    if (s?.neverPlaced === true) return NEVER_PLACED;

    return s === undefined || s.state === 'queued' ? 'no workspace yet' : undefined;
  };

  return [
    unless(worktree(), {
      id: 'worktree',
      text: 'Open worktree',
      ...(s !== undefined && s.box === undefined
        ? { dim: 'local' }
        : // a fetch and a checkout on disk: never where a fast ⌘⏎ ⏎ lands
          { dim: 'from origin', costly: true }),
      does: { kind: 'back' },
    }),
    unless(workspace(), {
      id: 'workspace',
      text: STEP_ROWS.workspace,
      ...(s?.neverPlaced === true ? {} : { dim: s?.box ?? 'local worktree' }),
      does: { kind: 'back' },
    }),
    unless(reopenRefusal(f), {
      id: 'reopen',
      text: STEP_ROWS.reopen,
      ...reopenLook(s),
      does: { kind: 'back' },
    }),
    // a new session from decide: only on a run not over
    ...(f.run === undefined
      ? []
      : [
          unless(retryRefusal(f), {
            id: 'retry',
            text: RETRY_RUN,
            costly: true,
            dim: 'a new session from decide, same worktree',
            does: { kind: 'back' },
          }),
        ]),
    unless(theirs ?? (s === undefined || s.state === 'ended' ? 'no session running' : undefined), {
      id: 'stop',
      text: 'Stop…',
      costly: true,
      does: { kind: 'back' },
    }),
    endRow(c.id, f.run, theirs),
    assignRow(f),
    {
      id: 'move',
      text: 'Move…',
      dim: `now ${c.state}`,
      does: {
        kind: 'run',
        argv: ['card', 'move', id],
        done: ([to = '']) => `Moved #${id} to ${to}`,
        ask: [
          {
            name: 'state',
            kind: 'positional',
            type: 'enum',
            values: COLUMNS.filter((x) => x !== c.state),
            title: `Move #${id} to`,
            required: true,
            repeats: true,
            summary: 'the state',
          },
        ],
      },
    },
    // the CommentBox: its thread, ⇧⏎ lines, a paste's lines kept; posted with `card comment`
    {
      id: 'comment',
      text: 'Comment…',
      dim: 'markdown, on the card',
      does: {
        kind: 'do',
        commands: [
          {
            kind: 'comment',
            card: c.id,
            title: c.title,
            placeholder: 'Your comment, as markdown',
          },
        ],
      },
    },
    ...keepRow(f, s),
    // the Launch box, its workflow preselected: its ⏎ launches (no one's card: yours once it does)
    unless(assigns ? undefined : launchRefusal(f), {
      id: 'launch',
      text: assigns ? ASSIGN_AND_LAUNCH : launchWords(f),
      costly: true,
      dim: `${defaultWhere(f.target)} · its workflow, a note${stopsFirst(replacing(f))}${assigns ? ' · yours once launched' : ''}`,
      does: { kind: 'back' },
    }),
  ];
};

/** The card menu's row that opens the Launch box. */
export const LAUNCH_BOX_ROW = 'launch-box';

/** The Launch box's menu id on a card: its ⏎ comes back as a choice of it. */
export const LAUNCH_BOX = 'launchbox:';

/**
 * A Launch box's ⏎ the screen could not launch: why on the status line, and the box back
 * on its card with the note, workflow and where it runs, so nothing typed is lost.
 */
export const refusedLaunch = (
  box: Extract<Command, { kind: 'launch' }>,
  values: readonly string[] | undefined,
  why: string,
): Command[] => [
  { kind: 'shell', effect: { kind: 'status', text: `#${box.card} not launched: ${why}` } },
  {
    ...box,
    draft: {
      note: values?.[0] ?? '',
      ...(values?.[1] === undefined || values[1] === '' ? {} : { workflow: values[1] }),
      ...(values?.[2] === undefined || values[2] === '' ? {} : { runs: values[2] }),
    },
  },
];

/** ` · stops 4-c3d4 first`: a launch row's words on a card whose session is live. */
const stopsFirst = (id: string | undefined): string =>
  id === undefined ? '' : ` · stops ${id} first`;

/**
 * The Launch box on `card`, where Launch agent goes as its detail says; `stops`: the card's live
 * session its launch stops first (`replacing`).
 */
export const launchBox = (
  card: Pick<CardData, 'id' | 'title' | 'tags' | 'type'>,
  target: string | undefined,
  stops?: string,
): Extract<Command, { kind: 'launch' }> => ({
  kind: 'launch',
  id: `${LAUNCH_BOX}${card.id}`,
  card: card.id,
  title: card.title,
  where: defaultWhere(target),
  type: card.type,
  tags: card.tags,
  ...(target === undefined ? {} : { target }),
  ...(hasPrototype(card) ? { prototype: true } : {}),
  ...(stops === undefined ? {} : { stops }),
});

/**
 * Open in browser on Azure Boards; none for a card with no page there (`local:`: a held card,
 * a board On this Mac's).
 */
const browserRow = (f: CardFacts): MenuRow[] =>
  f.card.url.startsWith('local:')
    ? []
    : [
        {
          id: 'browser',
          text: 'Open in browser',
          dim: 'Azure Boards',
          does: { kind: 'shell', effect: { kind: 'open-url', url: f.card.url } },
        },
      ];

/**
 * The older rows, kept below the separator so nothing from the old menu is lost. Launch in Local
 * sandbox only where Launch agent goes elsewhere (on a local target the two were one launch).
 */
const moreRows = (f: CardFacts): MenuRow[] => [
  ...(runsHere(f.target)
    ? []
    : [
        unless(launchRefusal(f), {
          id: 'launch-local-sandbox',
          text: 'Launch in Local sandbox',
          costly: true,
          dim: `this machine · no cloud writes${stopsFirst(replacing(f))}`,
          does: { kind: 'back' },
        }),
      ]),
  ...moveRow(f),
  {
    id: 'prototype',
    text: 'Prototype…',
    costly: true,
    dim: 'real code in a throwaway worktree, never shipped: its own chat',
    does: { kind: 'back' },
  },
  ...browserRow(f),
];

/**
 * The row the card's menu lifts to the top: its next step; with none, Launch agent where yours it
 * would be (Assign to me and launch on no one's card, grey on a teammate's).
 */
const liftedStep = (f: CardFacts): NextStep | undefined =>
  nextStep(f) ?? (nextStep({ ...f, mine: true }) === 'launch' ? 'launch' : undefined);

/**
 * The card's Action menu: the next step first, where it opens (but Reopen, which spends at once:
 * there the menu rests as on any other), then the fixed rows in their order, then the older rows
 * below a separator. A grey top row (a teammate's card) is where it opens too: ⏎ chooses nothing,
 * never a row further down.
 */
export const cardMenu = (f: CardFacts): Menu => {
  const c = f.card;
  const step = liftedStep(f);
  const pr = f.run?.pr ?? null;
  // a local pull request: `#L3`, shown in the Board's place, whatever the run's step
  const local = pr !== null && isLocalNumber(pr.number);
  const prRow: MenuRow[] =
    (step === 'pull-request' || local) && pr !== null
      ? [
          {
            id: 'pull-request',
            text: STEP_ROWS['pull-request'],
            dim: local ? `#${localName(pr.number)} · on this machine` : `#${pr.number}`,
            does: local
              ? { kind: 'back' }
              : { kind: 'shell', effect: { kind: 'open-url', url: pr.url } },
          },
        ]
      : [];
  const fixed = [...prRow, ...fixedRows(f)];
  const lifted = step === undefined ? undefined : fixed.find((r) => r.id === step);
  // Launch agent… right under a lifted Launch agent
  const boxRow = lifted?.id === 'launch' ? fixed.find((r) => r.id === LAUNCH_BOX_ROW) : undefined;
  const [first, ...more] = moreRows(f);
  // A bug that does not reproduce: its way out right after the next step.
  const offered = notReproducedRow(c.id, f.run, whose(f));

  const opens = lifted === undefined || lifted.id === 'reopen' ? undefined : lifted;

  return {
    kind: 'menu',
    id: `card:${c.id}`,
    title: `#${cardName(c.id)} ${c.title}`,
    ...(opens === undefined
      ? {}
      : { preselect: opens.id, ...(opens.reason === undefined ? {} : { greyPreselect: true }) }),
    rows: [
      ...(lifted === undefined ? [] : [lifted]),
      ...(boxRow === undefined ? [] : [boxRow]),
      ...offered,
      ...fixed.filter((r) => r !== lifted && r !== boxRow),
      ...(first === undefined ? [] : [{ ...first, separator: true }, ...more]),
    ],
  };
};

/** How `Tell …'s session` says where the session stands. */
const TELL_DIM: Readonly<Record<SessionData['state'], string>> = {
  queued: 'it waits for a box',
  starting: 'it is starting',
  working: 'it is working',
  waiting: 'it waits on you',
  ended: 'it ended',
};

/**
 * The card as `:`'s Subject: its caption, `Ask about #1234` (the card's text read in), its
 * Action menu's rows, and `Tell #1234's session` while its own session runs.
 */
export const cardSubject = (f: CardFacts): Subject => {
  const c = f.card;
  const session = sessionOf(f);

  return {
    caption: `#${cardName(c.id)} ${c.title}`,
    label: `#${cardName(c.id)}`,
    ask: ['--card', String(c.id)],
    menu: cardMenu(f),
    ...(session === undefined || session.state === 'ended'
      ? {}
      : {
          tell: {
            session: session.id,
            whose: `#${cardName(c.id)}`,
            dim: TELL_DIM[session.state],
            card: c.id,
          },
        }),
  };
};

// ---------------------------------------------------------------- the machine

/** What a screen embeds: the launches it asked, not answered yet. */
export type CardActions = {
  /** Cards whose `factory run` is out: a second press launches nothing. */
  launching: readonly number[];
  /** Each launched card's argv, sent again with its `box-short` answer (ADR 0022). */
  argv: Readonly<Record<number, readonly string[]>>;
  /** Assign-then-launch's cards: assigned to you once launched, never before. */
  assignOnLaunch: readonly number[];
  /** The assigns out (Assign…'s and a launch's), and the undo `u` runs as the next key. */
  assigns: AssignState;
};

export const NO_CARD_ACTIONS: CardActions = {
  launching: [],
  argv: {},
  assignOnLaunch: [],
  assigns: NO_ASSIGNS,
};

/** What the actions go by besides the card: the launches heard (live's), the repo shown. */
export type ActionsAt = {
  launches?: Readonly<Record<number, LaunchHeard>> | undefined;
  here?: RepoHere | undefined;
};

/** A card as a launch sees it: where it runs from, its live session, whether it may go. */
export type LaunchOn = {
  card: number;
  root?: string | undefined;
  session?: SessionData | undefined;
  /** Launched as asked; `assign`: no one has it, so yours once launched; else why not. */
  may: 'launch' | 'assign' | { refused: string };
};

type Stepped = { actions: CardActions; commands: Command[] };

/** The launch run's id prefix: `launch:<card>`. */
const LAUNCH = 'launch:';

/** A card as the Board and the Card page know it: may it launch, or be assigned and launched. */
export const launchOnCard = (f: CardFacts): LaunchOn => ({
  card: f.card.id,
  root: f.root,
  session: f.session,
  may: mayOf(launchRefusal(f), assignsToLaunch(f)),
});

/** Whether a launch goes: refused `why`, else assigned to you first when no one has it. */
export const mayOf = (why: string | undefined, assign: boolean): LaunchOn['may'] => {
  if (why !== undefined && !assign) return { refused: why };

  return assign ? 'assign' : 'launch';
};

/**
 * A launch on `card` going: one asked here not answered yet, or one heard (`launch.started`) in
 * the repo shown whose session is not listed yet; `live`, the card's session as the screen has it.
 */
export const launchGoing = (
  a: CardActions,
  at: ActionsAt,
  card: number,
  live?: SessionData,
): boolean => {
  const heard = at.launches?.[card];

  return (
    a.launching.includes(card) ||
    (heard !== undefined &&
      isHere(at.here, heard.repo) &&
      (heard.session === null || live?.id !== heard.session))
  );
};

const statusLine = (text: string): Command => ({ kind: 'shell', effect: { kind: 'status', text } });

const balloon = (input: Answer | Refused): Command[] =>
  input.reply.ok
    ? []
    : [
        {
          kind: 'shell',
          effect: {
            kind: 'balloon',
            tone: 'error',
            text: `${input.reply.error.message} (${input.reply.error.code})`,
          },
        },
      ];

/** ` · <workflow>` when one was picked in the Launch box; else nothing (the card's own). */
const workflowWords = (setup: LaunchSetup | undefined): string =>
  setup?.workflow === undefined || setup.workflow === null || setup.workflow === ''
    ? ''
    : ` · ${setup.workflow}`;

/** Why a launch on the card does not go now; undefined: it goes. */
const refusalOf = (a: CardActions, at: ActionsAt, on: LaunchOn): string | undefined => {
  if (launchGoing(a, at, on.card)) return 'a launch is already going';

  return typeof on.may === 'object' ? on.may.refused : undefined;
};

/**
 * Launch: `abe factory run <card>` once, said at once (its worktree is made before its session
 * starts); a card no one has is assigned to you once it is launched. Refused: why, nothing asked.
 */
export const launch = (
  a: CardActions,
  at: ActionsAt,
  on: LaunchOn,
  target?: LaunchTarget,
  setup?: LaunchSetup,
): Stepped | { refused: string } => {
  const why = refusalOf(a, at, on);

  if (why !== undefined) return { refused: why };
  const argv = launchArgv(
    { card: { id: on.card }, root: on.root, session: on.session },
    target,
    setup,
  );

  return {
    actions: {
      ...a,
      launching: [...a.launching, on.card],
      argv: { ...a.argv, [on.card]: argv },
      assignOnLaunch: [
        ...a.assignOnLaunch.filter((c) => c !== on.card),
        ...(on.may === 'assign' ? [on.card] : []),
      ],
    },
    commands: [
      { kind: 'run', id: `${LAUNCH}${on.card}`, argv },
      statusLine(`Launching #${cardName(on.card)}${workflowWords(setup)}…`),
    ],
  };
};

/**
 * The Launch box's ⏎ (its values `[note, workflow, runs, prod]`): launched, or why not on the
 * status line with the box back, so nothing typed is lost.
 */
export const launchFromBox = (
  a: CardActions,
  at: ActionsAt,
  on: LaunchOn,
  box: Extract<Command, { kind: 'launch' }>,
  values: readonly string[] | undefined,
  target?: LaunchTarget,
): Stepped => {
  const out = launch(a, at, on, target, setupOf(values));

  return 'refused' in out ? { actions: a, commands: refusedLaunch(box, values, out.refused) } : out;
};

/** The `box-short` question's answer (ADR 0022): the launch sent again with it; Cancel: nothing. */
export const shortChoice = (a: CardActions, card: number, row: string): Stepped => {
  const argv = a.argv[card];
  const answer = shortAnswerOf(row);

  // Cancel: not launched, so not assigned either
  if (argv === undefined || answer === undefined || a.launching.includes(card))
    return {
      actions:
        answer === undefined
          ? { ...a, assignOnLaunch: a.assignOnLaunch.filter((c) => c !== card) }
          : a,
      commands: [],
    };

  return {
    actions: { ...a, launching: [...a.launching, card] },
    commands: [{ kind: 'run', id: `${LAUNCH}${card}`, argv: [...argv, '--short', answer] }],
  };
};

/** Whether an answer is the actions': a launch's, an assign's or its undo's. */
export const isActionAnswer = (id: string): boolean => id.startsWith(LAUNCH) || isAssignRun(id);

/**
 * Assign… › `who` (`me`, `none` or a member's email): `card assign`, said once it answers, with
 * `u` to put the card back as the next key.
 */
export const assignCard = (
  a: CardActions,
  card: Pick<CardData, 'id' | 'assignee'>,
  who: string,
  o: { mine: boolean; members: readonly BoardMember[] },
): Stepped => {
  const out = assignOn(a.assigns, card, who, o);

  return { actions: { ...a, assigns: out.state }, commands: out.commands };
};

/**
 * A key on a screen that offers `u` (the Board): `u` right after an assign answered undoes it;
 * any other key drops the offer and is the screen's (`taken` false).
 */
export const actionKey = (a: CardActions, key: string): Stepped & { taken: boolean } => {
  if (a.assigns.undo === undefined) return { actions: a, commands: [], taken: false };
  if (key !== 'u')
    return { actions: { ...a, assigns: keyed(a.assigns) }, commands: [], taken: false };
  const out = undoAssign(a.assigns);

  return { actions: { ...a, assigns: out.state }, commands: out.commands, taken: true };
};

/** Something else done (a click, a choice, text): `u` undoes no assign after it. */
export const actionsMoved = (a: CardActions): CardActions =>
  a.assigns.undo === undefined ? a : { ...a, assigns: keyed(a.assigns) };

/** An assign's or its undo's answer: said; `undo` false, a screen with no `u`: no undo offered. */
const assignAnswer = (a: CardActions, input: Answer | Refused, undo: boolean): Stepped => {
  const out = assigned(a.assigns, input);

  if (undo) return { actions: { ...a, assigns: out.state }, commands: out.commands };

  return {
    actions: { ...a, assigns: { ...out.state, undo: undefined } },
    commands: out.commands.map((c) =>
      c.kind === 'shell' && c.effect.kind === 'status'
        ? { ...c, effect: { ...c.effect, text: c.effect.text.replace(' · u undo', '') } }
        : c,
    ),
  };
};

/** The card a launch answer is of. */
export const launchedCard = (id: string): number | undefined =>
  id.startsWith(LAUNCH) ? Number(id.slice(LAUNCH.length)) : undefined;

/**
 * A launch's answer: its Launching… cleared; short of memory or disk, asked; refused, why in a
 * balloon (nothing written to the board, the assign included); launched, assigned to you when it
 * was no one's, and `launched` for the screen to follow it (Chat on its session). An assign's
 * refusal is said; the launch went on.
 */
export const actionAnswer = (
  a: CardActions,
  input: Answer | Refused,
  o: { undo?: boolean } = {},
): Stepped & { launched?: { card: number; run: FactoryRunData } } => {
  if (isAssignRun(input.id)) return assignAnswer(a, input, o.undo !== false);
  const card = Number(input.id.slice(LAUNCH.length));
  const going = { ...a, launching: a.launching.filter((c) => c !== card) };
  const said = statusLine('');
  const short = input.reply.ok ? undefined : input.reply.error.boxShort;

  if (short !== undefined) return { actions: going, commands: [said, shortMenu(card, short)] };
  const next = { ...going, assignOnLaunch: going.assignOnLaunch.filter((c) => c !== card) };

  if (!input.reply.ok) return { actions: next, commands: [said, ...balloon(input)] };
  if (input.command !== 'factory run') return { actions: next, commands: [said] };
  // no one's card: yours now, back to no one with `u`
  const assign = a.assignOnLaunch.includes(card)
    ? assignCard(next, { id: card, assignee: null }, 'me', { mine: false, members: [] })
    : { actions: next, commands: [] };

  return {
    actions: assign.actions,
    commands: [said, ...assign.commands],
    launched: { card, run: input.reply.data },
  };
};

/** Stop…: asked first in Command mode's ConfirmLayer (No the default), then `abe session stop`. */
export const stopCard = (card: number, session: SessionData | undefined): Command[] =>
  session === undefined || session.state === 'ended'
    ? []
    : [
        {
          kind: 'confirm',
          argv: ['session', 'stop', session.id],
          ...stopSessionConfirm(card, session),
          done: stoppedWords(card),
        },
      ];

/**
 * Reopen: the card's ended session goes on (`abe session reopen`); why not, said, never nothing.
 * A running one needs no reopen: nothing.
 */
export const reopenCard = (f: CardStanding): Command[] => {
  if (f.session?.state !== 'ended') return [];
  const refusal = reopenRefusal(f);

  return refusal === undefined ? [reopenCommand(f.card.id, f.session.id)] : [statusLine(refusal)];
};

/** Retry run: a new session on the card from decide, on its box when it ended with it. */
export const retryCard = (f: CardStanding, root: string | undefined): Command[] =>
  retryRefusal(f) === undefined
    ? [relaunch(f.card.id, root ?? f.run?.repo, retryTarget(f.session), f.run)]
    : [];

/** A Retry's or a Reopen's answer: refused, said; else the live sessions and runs read again. */
export const relaunchAnswer = (input: Answer | Refused): Command[] =>
  input.reply.ok ? [{ kind: 'live', reads: ['sessions', 'runs'] }] : balloon(input);
