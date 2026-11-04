/**
 * Linked's rows (#109 S1), pure: the ten rows of a story from the parts `serve` read for it
 * (`abe story linked`), their words and what dims, each failed read on its own row; and the live
 * rules, which `abe watch` events change them (the Run row moved in place, the rest read again).
 * Here, not in core, because the Run row is the header's look (`lookOf`, `RAIL_STAGE_OF`) and the Story
 * row the Board's (`typeBadge`, `initials`), which are `ui`'s and which core cannot import.
 */
import {
  type BoxData,
  type CardShowData,
  type Event,
  type FactoryRunData,
  type IssueData,
  type LinkedKey,
  type LinkedOpens,
  type LinkedPart,
  type LinkedRow,
  type LinkedRun,
  type PipelineRun,
  type PrData,
  type PrReview,
  type RunStatus,
  type SessionData,
  type SheetSummary,
  type Stage,
  type StoryLinkedData,
} from '@abe/core';
import { boxScreenWords } from '@abe/core/box-text';
import { LINKED_KEYS, LINKED_PARTS } from '@abe/core/linked-keys';
import { waits } from '@abe/core/pipelines';
import { screenClock } from '@abe/core/when';
import { sessionReopens } from '../board/card-actions';
import { cardBoxWords } from '../live/box-feed';
import {
  cardSession,
  type CardOn,
  clockSince,
  initials,
  noBoxWords,
  placedBox,
  RAIL_STAGE_OF,
  subagentsWorking,
  typeBadge,
  whereOf,
} from '../board/flow';

/** One part as read: its data, or why it could not be (the port's message). */
export type Read<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * What `serve` read for a story. An optional part is one there was nothing to read for: no spec
 * issue named, no spec written, no GitHub repo or branch known, no session on a box.
 */
export type LinkedParts = {
  story: number;
  /** `card show`: the story with the Sheets attached to it. */
  card: Read<CardShowData>;
  /** The story's newest run (`factory status <id>`), null for none. */
  run: Read<FactoryRunData | null>;
  /** `run` is one History keeps (none shown): the card stands for it no more (#335). */
  cleared?: true;
  /** Your sessions (`session list`); the story's are picked here. */
  sessions: Read<SessionData[]>;
  /**
   * The newest version of the story's prototype in the org store (#351); null: none there.
   * Absent: not read (no org store, or a run with no prototype of the store's).
   */
  prototype?: Read<number | null>;
  /** The spec issue the run's reference names. */
  specIssue?: Read<IssueData>;
  /** The first line of the spec the run wrote (its spec stage's report). */
  specLine?: string | null;
  /** The story's pull request (the run's, else the open one of its branch) and its reviews. */
  pr?: Read<{ pr: PrData; reviews: PrReview[] } | null>;
  /** The newest run on the story's branch, from the provider the `pipelines` setting names. */
  pipeline?: Read<PipelineRun | null>;
  /** Your boxes, read when a session of the story is on one. */
  boxes?: Read<BoxData[]>;
  /** Your Sheets (`sheet list --card`); the story's are picked here. */
  sheets: Read<SheetSummary[]>;
  /** The rows another part reads (`--part`, #341): said `Reading…`, whatever the parts here say. */
  reading?: readonly LinkedKey[];
  /** The branch the story's work is on as read (its session's, else its card's). */
  branch?: string;
};

/**
 * `now`: when the parts were read; `home` shortens a path to `~`. The box's stop is on the Mac's
 * clock from its own instant (#260: never a fixed offset, which is an hour off across a DST change).
 */
export type LinkedEnv = { now: string; home: string };

type Row = Omit<LinkedRow, 'key' | 'label'>;

const LABELS: Readonly<Record<LinkedKey, string>> = {
  story: 'Story',
  prototype: 'Prototype',
  spec: 'Spec',
  sessions: 'Sessions',
  pr: 'Pull request',
  pipelines: 'Pipelines',
  worktree: 'Worktree',
  box: 'Box',
  sheets: 'Sheets',
};

const shown = (words: string, opens: LinkedOpens | null, time: Row['time'] = null): Row => ({
  words,
  time,
  dim: false,
  error: null,
  opens,
});
const dimmed = (words: string): Row => ({ words, time: null, dim: true, error: null, opens: null });
const NONE_YET = dimmed('none yet');
/** A row whose part is still being read (#341). */
const READING = dimmed('Reading…');

/** `text` with its whitespace one space each, cut to `max` with `…`. */
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();

  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** A port's message on one line, cut past two of the popup's: what `not read · …` says. */
const reasonOf = (error: string): string => oneLine(error.split('\n')[0] ?? '', 160);
const unread = (error: string): Row => ({
  words: `not read · ${reasonOf(error)}`,
  time: null,
  dim: true,
  error,
  opens: null,
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const storyRow = (card: Read<CardShowData>, story: number): Row => {
  if (!card.ok) return unread(card.error);
  const c = card.data;

  return shown(
    [
      c.state,
      typeBadge(c.type),
      c.assignee === null ? 'unassigned' : initials(c.assignee.name),
    ].join(' · '),
    { kind: 'story', card: story },
  );
};

/** A store version's number from its link (`prototype://shop/4/v2` → 2). */
const versionOf = (url: string): number | undefined => {
  const n = Number(/\/v(\d+)$/.exec(url)?.[1]);

  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * The story's prototype (#351): the version its run was built from, and a newer one made since
 * (`v2 · v3 is newer`: tell Chat); with no run, the newest; one in code by its branch.
 */
const prototypeRow = (p: LinkedParts): Row => {
  if (!p.run.ok) return unread(p.run.error);
  const failed = p.prototype !== undefined && !p.prototype.ok ? p.prototype.error : null;
  const newest = p.prototype?.ok === true ? p.prototype.data : null;
  const ref = p.run.data?.reference?.prototype;

  if (ref?.kind === 'code') return shown(`${ref.branch} at ${ref.sha}`, null);
  const built = ref === undefined ? undefined : versionOf(ref.url);

  // the version built from is known even when the store could not be read for a newer one
  if (built !== undefined)
    return {
      ...shown(
        newest !== null && newest > built ? `v${built} · v${newest} is newer` : `v${built}`,
        null,
      ),
      error: failed,
    };
  if (failed !== null) return unread(failed);
  if (newest === null) return dimmed('none');
  return shown(`v${newest}`, null);
};

const specRow = (p: LinkedParts): Row => {
  if (!p.run.ok) return unread(p.run.error);
  const run = p.run.data;

  if (run === null) return NONE_YET;
  // A spec issue Make card opened before #351; since, the run's own Spec writes it.
  if (run.reference !== null && run.reference.spec !== null) {
    if (p.specIssue === undefined) return shown(run.reference.spec, null);
    if (!p.specIssue.ok) return unread(p.specIssue.error);
    const i = p.specIssue.data;

    return shown(`#${i.number} · ${i.state} · ${i.title}`, { kind: 'url', url: i.url });
  }
  const written = run.stages.findLast((s) => s.stage === 'spec');

  if (written !== undefined) {
    const line = p.specLine ?? null;

    return shown(
      line === null || line === '' ? 'written ✓' : `written ✓ · ${line}`,
      written.report === null ? null : { kind: 'file', path: written.report },
    );
  }
  if (run.stage === 'spec') return shown('● writing', null);
  if (run.workflow !== null && !run.workflow.steps.some((x) => x.kind === 'spec'))
    return dimmed(`none · ${run.workflow.name ?? run.workflow.id} writes no spec`);

  return NONE_YET;
};

/** The run's session as its look reads it; none when the session is not listed. */
export const runSession = (run: LinkedRun) =>
  run.sessionState === null
    ? undefined
    : {
        state: run.sessionState,
        stopped: run.sessionStopped,
        reason: run.sessionReason,
        ...(run.sessionBox === null ? {} : { box: run.sessionBox }),
        rounds: run.sessionRounds,
        waitingOn: run.sessionWaitingOn,
      };

/** The run's facts the Run row and live updates read. */
const linkedRun = (run: FactoryRunData, sessions: readonly SessionData[]): LinkedRun => {
  const session = sessions.find((s) => s.id === run.session);

  return {
    session: run.session,
    stage: run.stage,
    state: run.state,
    // the header's and the Board's clock (#147)
    since: clockSince(run, session),
    reason: run.reason,
    outcome: run.outcome,
    pr: run.pr,
    prototype: run.prototype,
    sessionState: session?.state ?? null,
    sessionStopped: session?.stopped ?? false,
    sessionReason: session?.reason ?? null,
    sessionBox: session?.box ?? null,
    sessionRounds: session?.rounds ?? 0,
    sessionWaitingOn: session?.waitingOn ?? null,
    ended: run.ended,
  };
};

/** The newest of `sessions` (by when it started), the one the Run row's word is of. */
const newestOf = (sessions: readonly SessionData[]): SessionData | undefined =>
  [...sessions].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

/**
 * The story's sessions, the live ones first: an older ended one stays beside a newer one (#343:
 * Launch new agent… leaves it in Linked, where it is picked to reopen).
 */
export const storySessions = (sessions: readonly SessionData[], story: number): SessionData[] => {
  const mine = sessions.filter((s) => s.card === story && s.kind === 'card');

  return [...mine.filter((s) => s.state !== 'ended'), ...mine.filter((s) => s.state === 'ended')];
};

const sessionsRow = (sessions: Read<SessionData[]>, story: number, on: CardOn | undefined): Row => {
  if (!sessions.ok) return unread(sessions.error);
  const listed = storySessions(sessions.data, story);
  const word = listed.find((x) => x.id === on?.id) ?? newestOf(listed);
  const first = listed[0];

  if (first === undefined) return NONE_YET;
  const live = listed.filter((s) => s.state !== 'ended');
  const working = live.reduce((n, s) => n + subagentsWorking(s), 0);
  const ended = live.length === 0;

  return shown(
    [
      String(listed.length),
      [...new Set(listed.map(whereOf))].join(', '),
      ...(working > 0 ? [plural(working, 'subagent')] : []),
      // as the Run row's word (#258): stopped when you stopped the one the card is on (#335)
      ...(ended ? [word?.stopped === true ? 'stopped' : 'ended'] : []),
    ].join(' · '),
    {
      kind: 'sessions',
      ids: listed.map((s) => s.id),
      // all ended: ⏎ reopens the one the card is on (`cardSession`), as Chat and the card do (#343)
      ...(ended && word !== undefined && sessionReopens(word) ? { reopen: word.id } : {}),
    },
  );
};

const CHECK_MARKS: Readonly<Record<PrData['checks']['state'], string>> = {
  none: '',
  pending: '●',
  success: '✓',
  failure: '✗',
};

/**
 * `#16 AB#102 The cart total… · closed`: open or not, its title after its number (#224), cut so an
 * open one's checks and reviews still fit Linked's row.
 */
const prRow = (read: LinkedParts['pr']): Row => {
  if (read === undefined) return NONE_YET;
  if (!read.ok) return unread(read.error);
  if (read.data === null) return NONE_YET;
  const { pr, reviews } = read.data;
  const passed = pr.checks.runs.filter((c) => c.state === 'success' || c.state === 'skipped');
  const checks =
    pr.checks.state === 'none'
      ? 'no checks'
      : `checks ${CHECK_MARKS[pr.checks.state]} ${passed.length}/${pr.checks.runs.length}`;
  const reviewers = new Set(reviews.map((r) => r.by)).size;
  const title = oneLine(pr.title, 40);

  return shown(
    [
      title === '' ? `#${pr.number}` : `#${pr.number} ${title}`,
      ...(pr.state === 'open' ? [] : [pr.state]),
      ...(pr.state === 'open' && pr.draft ? ['draft'] : []),
      ...(pr.state === 'open' ? [checks] : []),
      ...(reviewers > 0 ? [plural(reviewers, 'review')] : []),
    ].join(' · '),
    { kind: 'url', url: pr.url },
  );
};

/** `card/2-…`: a card's branch cut after its id. */
const shortBranch = (branch: string): string => {
  const head = /^card\/\d+-/.exec(branch)?.[0];

  return head === undefined || head.length === branch.length ? branch : `${head}…`;
};

const RUN_WORDS: Readonly<Record<RunStatus, string>> = {
  queued: '○ queued',
  running: '● running',
  waiting: '◆ waiting',
  passed: '✓ passed',
  failed: '✗ failed',
  cancelled: '✗ cancelled',
  skipped: 'skipped',
};

/** A run's words: a gate it stands at is waiting, whatever its status. */
const pipelineWords = (r: PipelineRun): string => RUN_WORDS[waits(r) ? 'waiting' : r.status];

const pipelinesRow = (read: LinkedParts['pipeline']): Row => {
  if (read === undefined) return NONE_YET;
  if (!read.ok) return unread(read.error);
  if (read.data === null) return NONE_YET;
  const r = read.data;

  return shown(
    `${r.pipeline} ${pipelineWords(r)} on ${shortBranch(r.branch)}`,
    { kind: 'pipeline', id: r.id, url: r.url },
    { since: r.finishedAt ?? r.startedAt ?? r.createdAt, ago: true },
  );
};

const tilde = (path: string, home: string): string =>
  home !== '' && home !== '/' && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;

/** The card's session's folder (#335, `cardSession`): its run's worktree, else the session's. */
const worktreeRow = (p: LinkedParts, on: CardOn | undefined, home: string): Row => {
  const run = on?.run;
  const path = run !== undefined && run.worktree !== '' ? run.worktree : on?.session?.worktree;

  if (path === undefined || path === '') {
    if (!p.run.ok) return unread(p.run.error);
    if (!p.sessions.ok) return unread(p.sessions.error);

    return NONE_YET;
  }

  return shown(tilde(path, home), { kind: 'workspace', session: on?.id ?? null, path });
};

/** The card's session's box (#335, `cardSession`). */
const boxRow = (p: LinkedParts, on: CardOn | undefined, now: string): Row => {
  if (!p.sessions.ok) return unread(p.sessions.error);
  const session = on?.session;
  const never = session?.neverPlaced === true;
  // one that never got a box (#246): the card's own box, if an earlier run left one
  const tagged =
    never && p.boxes?.ok === true
      ? p.boxes.data.find(
          (b) =>
            b.state !== 'terminated' &&
            (b.card === p.story || (b.workspaces ?? []).some((w) => w.card === String(p.story))),
        )?.name
      : undefined;
  const name = placedBox(session) ?? tagged;

  if (name === undefined) return dimmed(noBoxWords(session));
  const opens: LinkedOpens = { kind: 'box', name, card: p.story };

  if (p.boxes === undefined) return shown(cardBoxWords(name, p.story, undefined), opens);
  if (!p.boxes.ok) return unread(p.boxes.error);
  const box = p.boxes.data.find((b) => b.name === name);

  if (box === undefined || box.state === 'terminated')
    return dimmed(`${cardBoxWords(name, p.story, box)} · gone`);
  const idle = box.state === 'running' ? box.idle : undefined;
  const until =
    idle === undefined
      ? []
      : [idle.stopsAt === null ? 'kept awake' : `stops at ${screenClock(idle.stopsAt, now)}`];

  // booting while its serve does not answer yet (#213 B4), as the Boxes tab says it
  const state = boxScreenWords(box, Date.parse(now));

  return shown([cardBoxWords(name, p.story, box), state, ...until].join(' · '), opens);
};

const sheetsRow = (p: LinkedParts): Row => {
  if (!p.sheets.ok) return unread(p.sheets.error);
  const yours = p.sheets.data
    .filter((s) => s.card === p.story || s.attached.includes(p.story))
    .map((s) => ({ id: s.id, title: s.title, ref: s.id }));
  const attached = (p.card.ok ? p.card.data.sheets : [])
    .filter((s) => !yours.some((y) => y.id === s.id))
    .map((s) => ({ id: s.id, title: s.title, ref: `${p.story}/${s.id}` }));
  const all = [...yours, ...attached];
  const [first, ...rest] = all;

  if (first === undefined) return dimmed('none');

  return shown(`${all.length} · ${all.map((s) => s.title).join(', ')}`, {
    kind: 'sheets',
    refs: [first.ref, ...rest.map((s) => s.ref)],
  });
};

const row = (key: LinkedKey, r: Row): LinkedRow => ({ key, label: LABELS[key], ...r });

/**
 * The session the story's card is on (#335), of its newest shown run and your sessions: as its
 * Board card, Chat and the workspace jump read it (`cardSession`, a run History keeps no longer stands). `serve`'s read takes its branch and repo from it too.
 */
export const linkedSession = (
  p: Pick<LinkedParts, 'story' | 'run' | 'sessions' | 'cleared'>,
): CardOn | undefined =>
  cardSession(
    p.run.ok && p.run.data !== null && p.cleared !== true ? [p.run.data] : [],
    p.sessions.ok ? p.sessions.data : [],
    p.story,
  );

/** The ten rows of a story, in order, from what was read for it. */
export const linkedOf = (p: LinkedParts, env: LinkedEnv): StoryLinkedData => {
  const reading = p.reading ?? [];
  const run = p.run.ok && p.run.data !== null ? p.run.data : null;
  const facts =
    run === null || reading.includes('sessions')
      ? null
      : linkedRun(run, p.sessions.ok ? p.sessions.data : []);
  const on = linkedSession(p);
  const rows = [
    row('story', storyRow(p.card, p.story)),
    row('prototype', prototypeRow(p)),
    row('spec', specRow(p)),
    row('sessions', sessionsRow(p.sessions, p.story, on)),
    row('pr', prRow(p.pr)),
    row('pipelines', pipelinesRow(p.pipeline)),
    row('worktree', worktreeRow(p, on, env.home)),
    row('box', boxRow(p, on, env.now)),
    row('sheets', sheetsRow(p)),
  ].map((r) => (reading.includes(r.key) ? row(r.key, READING) : r));

  return {
    story: p.story,
    title: p.card.ok && !reading.includes('story') ? p.card.data.title : (run?.title ?? ''),
    at: env.now,
    rows,
    run: facts,
    ...(p.branch === undefined ? {} : { branch: p.branch }),
    ...(reading.length === 0 ? {} : { reading: LINKED_KEYS.filter((k) => reading.includes(k)) }),
  };
};

/** Linked before any part is in (#341): the ten rows, each `Reading…`. */
export const linkedReading = (story: number, at: string): StoryLinkedData => ({
  story,
  title: '',
  at,
  rows: LINKED_KEYS.map((key) => row(key, READING)),
  run: null,
  reading: [...LINKED_KEYS],
});

/**
 * One part's answer over what is shown (#341): the rows it read in place, the rows it did not
 * (`reading`) as they were, and those `kept` (newer than its read: an event moved them) too; the
 * title once the story is read, the run's facts once its run is.
 */
export const mergeLinked = (
  was: StoryLinkedData,
  next: StoryLinkedData,
  kept: ReadonlySet<LinkedKey> = new Set(),
): StoryLinkedData => {
  const skipped = new Set([...(next.reading ?? []), ...kept]);
  const still = LINKED_KEYS.filter((k) => skipped.has(k) && (was.reading ?? []).includes(k));

  return {
    story: next.story,
    // a story not read here, or read and lost: the title drawn stays, else the run's
    title: !skipped.has('story') && next.title !== '' ? next.title : was.title || next.title,
    at: next.at,
    rows: was.rows.map((r, i) => (skipped.has(r.key) ? r : (next.rows[i] ?? r))),
    // the run's facts come with the run part, whose rows are Sessions' and the Worktree's
    run: skipped.has('sessions') ? was.run : next.run,
    ...((next.branch ?? was.branch) === undefined ? {} : { branch: next.branch ?? was.branch }),
    ...(still.length === 0 ? {} : { reading: still }),
  };
};

/** Every part answered: a row still `Reading…` (its part failed whole) says why not. */
export const linkedSettled = (d: StoryLinkedData, error: string): StoryLinkedData => {
  const left = d.reading ?? [];

  if (left.length === 0) return d;

  return {
    ...d,
    rows: d.rows.map((r) => (left.includes(r.key) ? row(r.key, unread(error)) : r)),
    reading: undefined,
  };
};

/** The data with its run's facts changed (Linked has no Run row: Run is on the stripe, 3.0 #21). */
const withRun = (d: StoryLinkedData, run: LinkedRun): StoryLinkedData => ({ ...d, run });

/** The Box row's box, if it shows one. */
const boxOf = (d: StoryLinkedData): string | undefined => {
  const opens = d.rows.find((r) => r.key === 'box')?.opens;

  return opens?.kind === 'box' ? opens.name : undefined;
};

/**
 * A branch of the story's: the one its work was read on, else `card/<id>` or `card/<id>-<slug>`
 * (core's `cardBranch`).
 */
const onStoryBranch = (branch: string, d: StoryLinkedData) =>
  d.branch === undefined
    ? branch === `card/${d.story}` || branch.startsWith(`card/${d.story}-`)
    : branch === d.branch;

const ALL: readonly LinkedPart[] = LINKED_PARTS;
const NONE: readonly LinkedPart[] = [];

/**
 * What an `abe watch` event does to an open Linked: its run's move or its session's state change
 * the Run row at once (the rest of the rows stay, so a selection stays on its row); every event of
 * the story (and a gap in the stream) asks for the parts it can change again (`reread`): a
 * subagent the run part, a Sheet the card part (its Sheets row), a box the box part, the rest all.
 */
export const linkedOnEvent = (
  d: StoryLinkedData,
  e: Event,
): { data: StoryLinkedData; reread: readonly LinkedPart[] } => {
  const still = { data: d, reread: NONE };
  const ours = (card: number | null, parts: readonly LinkedPart[]) => ({
    data: d,
    reread: card === d.story ? parts : NONE,
  });

  switch (e.type) {
    case 'factory.stage': {
      if (e.data.card !== d.story) return still;
      // another session's run on the story's number: maybe another repo's (#256), the read says
      if (d.run?.session !== e.data.session) return { data: d, reread: ALL };
      // the clock goes on within a stay on one rail stage (`stayStart`); a plain step stays on the
      // one it came from, and where one before it was the read that follows says
      const known = (x: Stage) => (x === 'step' ? undefined : RAIL_STAGE_OF[x]);
      const rail = known(e.data.stage === 'step' ? (e.data.from ?? d.run.stage) : e.data.stage);
      const stays =
        (e.data.from === null && d.run.stage === e.data.stage) ||
        (rail !== undefined &&
          known(d.run.stage) === rail &&
          (e.data.from === null || known(e.data.from) === rail));
      const run: LinkedRun = {
        ...d.run,
        stage: e.data.stage,
        state: e.data.state,
        since: stays ? d.run.since : e.data.since,
        reason: e.data.reason,
        outcome: e.data.outcome,
        // where a person ended it (#230); an older box's serve says none: the read does
        ...(e.data.ended === undefined ? {} : { ended: e.data.ended }),
      };

      return { data: withRun(d, run), reread: ALL };
    }
    case 'session.state':
      if (e.data.card !== d.story) return still;

      return {
        data:
          d.run !== null && d.run.session === e.data.id
            ? withRun(d, {
                ...d.run,
                sessionState: e.data.state,
                sessionWaitingOn: e.data.state === 'waiting' ? (e.data.waitingOn ?? null) : null,
                sessionStopped:
                  e.data.state === 'ended' && (e.data.cause === 'stop' || d.run.sessionStopped),
                // why it ended, as it ended (#316)
                ...(e.data.reason === undefined ? {} : { sessionReason: e.data.reason }),
                // waiting on you: the clock from now (the read asked again says the rest)
                ...(e.data.state === 'waiting' && d.run.outcome === null
                  ? { since: e.data.since }
                  : {}),
              })
            : d,
        reread: ALL,
      };
    case 'session.subagent':
      return ours(e.data.card, ['run']);
    case 'sheet.saved':
    case 'sheet.attached':
      return ours(e.data.card, ['card']);
    case 'session.moved':
    case 'factory.card':
      return ours(e.data.card, ALL);
    case 'box.state':
      return { data: d, reread: e.data.box === boxOf(d) ? ['box'] : NONE };
    case 'box.step':
      // its box booting (#213 B4): its serve not answering yet, as the list then says
      return {
        data: d,
        reread: e.data.step === 'booting' && e.data.box === boxOf(d) ? ['box'] : NONE,
      };
    case 'board.changed':
      // the story changed on Azure DevOps outside Abe (#236)
      return {
        data: d,
        reread:
          e.data.cards.some((c) => c.card.id === d.story) || e.data.gone.includes(d.story)
            ? ['card']
            : NONE,
      };
    case 'github.changed':
      // its pull request moved: a review, a push, a merge (#236)
      return {
        data: d,
        reread:
          (d.run?.pr?.repo === e.data.repo &&
            e.data.prs.some((p) => p.number === d.run?.pr?.number)) ||
          e.data.prs.some((p) => onStoryBranch(p.branch, d))
            ? ['pr']
            : NONE,
      };
    case 'pipelines.changed':
      // a run on its branch started or moved on, on the provider in force (#236)
      return {
        data: d,
        reread: e.data.runs.some((r) => onStoryBranch(r.branch, d)) ? ['pipelines'] : NONE,
      };
    case 'watch.gap':
    case 'serve.started':
      return { data: d, reread: ALL };
    default:
      return still;
  }
};
