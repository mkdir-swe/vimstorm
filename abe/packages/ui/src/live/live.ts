/**
 * How a screen keeps its runs and sessions current, the same on every screen that holds
 * them (the Board, Chat, Sessions): an `abe watch` event moves the one it names in place (the
 * stream is in order), and a read's answer never takes one back past a move it held already. A
 * read can be answered after a newer event (a cloud run's `factory status` asks its box, which
 * takes a while, and two reads can land out of order); what began later is newer too: a run's
 * stage, a session's state.
 */
import type { Event, EventData, FactoryRunData, SessionData } from '@abe/core';
import type { Command } from '../runtime/runtime';

/** One read out: the `seq` seen when the oldest of them was asked, and how many are out. */
type Out = { seq: number; out: number };

/**
 * What a screen heard of `abe watch`, so a read's answer can be told from a newer event: the
 * last event's `seq`, each run's (`run:<session>`), session's (`session:<id>`) and its
 * subagents' (`subagents:<id>`) last move, and the reads out by id. A read asked after an event
 * answers with it in (serve had it first, a box's too: the Mac merged it before it asked the
 * box).
 */
export type Heard = {
  seen: number;
  moved: Readonly<Record<string, number>>;
  asked: Readonly<Record<string, Out>>;
};

const HEARD: Heard = { seen: 0, moved: {}, asked: {} };

/** The run or session an event moves, by the key `heard` keeps it under. */
const movedKey = (e: Event): string | undefined => {
  switch (e.type) {
    case 'factory.stage':
      return `run:${e.data.session}`;
    case 'session.state':
      return `session:${e.data.id}`;
    case 'session.subagent':
      return `subagents:${e.data.id}`;
    default:
      return undefined;
  }
};

const heardEvent = (h: Heard, e: Event): Heard => {
  // a serve started again numbers its events anew: reads out stay out, as asked before it all
  if (e.type === 'serve.started')
    return {
      seen: e.seq,
      moved: {},
      asked: Object.fromEntries(Object.entries(h.asked).map(([id, a]) => [id, { ...a, seq: 0 }])),
    };
  const key = movedKey(e);

  return {
    ...h,
    seen: e.seq,
    moved: key === undefined ? h.moved : { ...h.moved, [key]: e.seq },
  };
};

/** Whether `key` moved after the read `id` was asked: what the screen holds of it is newer. */
export const movedSince = (h: Heard | undefined, id: string) => {
  const asked = h?.asked[id];

  return (key: string): boolean => asked !== undefined && (h?.moved[key] ?? 0) > asked.seq;
};

/**
 * A screen's step that keeps its `heard`: each event noted before the screen takes it,
 * each read it asks noted with the `seq` seen (two out with one id: the older's, until both are
 * answered), an answered read let go of after; moves older than every read out are forgotten.
 */
export const hearing =
  <S extends { heard?: Heard | undefined }, I extends { kind: string }>(
    step: (s: S, input: I) => { state: S; commands: Command[] },
  ) =>
  (s: S, input: I): { state: S; commands: Command[] } => {
    const was = s.heard ?? HEARD;
    const heard = isEvent(input) ? heardEvent(was, input.event) : was;
    const out = step({ ...s, heard }, input);
    const after = out.state.heard ?? heard;
    const asked = new Map(Object.entries(after.asked));
    const answered = isResult(input) ? asked.get(input.id) : undefined;

    if (isResult(input) && answered !== undefined) {
      if (answered.out > 1) asked.set(input.id, { ...answered, out: answered.out - 1 });
      else asked.delete(input.id);
    }
    for (const c of out.commands) {
      if (c.kind !== 'run') continue;
      const had = asked.get(c.id);

      asked.set(
        c.id,
        had === undefined ? { seq: after.seen, out: 1 } : { ...had, out: had.out + 1 },
      );
    }
    const oldest = Math.min(...[...asked.values()].map((a) => a.seq));
    const moved = Object.fromEntries(Object.entries(after.moved).filter(([, n]) => n > oldest));

    return {
      state: { ...out.state, heard: { seen: after.seen, moved, asked: Object.fromEntries(asked) } },
      commands: out.commands,
    };
  };

const isEvent = (i: { kind: string }): i is { kind: 'event'; event: Event } =>
  i.kind === 'event' && 'event' in i;

const isResult = (i: { kind: string }): i is { kind: 'result'; id: string } =>
  i.kind === 'result' && 'id' in i;

/**
 * A run moved by its `factory.stage` event: the stage it left kept as a visit, so its stay on the
 * rail stage (`stayStart`) and the clock carry on until a full read brings its stages.
 */
export const runMoved = (run: FactoryRunData, d: EventData<'factory.stage'>): FactoryRunData => {
  // older than what is held (a read that asked the box went past its event): nothing to do. A
  // run going back (a review's findings, a decide) always has a later since.
  if (later(run.since, d.since)) return run;
  const left =
    d.from !== null && run.stage !== 'done' && later(d.since, run.since)
      ? [
          {
            stage: run.stage,
            startedAt: run.since,
            endedAt: d.since,
            durationMs: Math.max(0, Date.parse(d.since) - Date.parse(run.since)),
            report: null,
          },
        ]
      : [];

  return {
    ...run,
    stage: d.stage,
    state: d.state,
    since: d.since,
    outcome: d.outcome,
    reason: d.reason,
    stages: [...run.stages, ...left],
    // its pull request as the move left it; an older box's serve sends none: kept
    ...(d.pr === undefined ? {} : { pr: d.pr }),
    // how a person ended it: an abandoned run stays on the stage it was given up in
    ...(d.ended === undefined ? {} : { ended: d.ended }),
    // the answers the agent offered with this wait; an older box's serve sends none: kept
    ...(d.options === undefined ? {} : { options: d.options }),
  };
};

/** `factory.stage` causes after which the run's pull request (in the full status) moved too. */
export const PR_CAUSES: ReadonlySet<string> = new Set(['pr', 'pr-seen', 'merged', 'deployed']);

/**
 * Whether a `factory.stage` moved the run's pull request without saying how (an older box's serve
 * sends no `pr`): the run is read by its card, or its look would go by a pull request it
 * does not hold.
 */
export const prUnsaid = (d: EventData<'factory.stage'>): boolean =>
  PR_CAUSES.has(d.cause) && d.pr === undefined;

/**
 * Whether a `factory.stage` abandoned the run without saying where (an older box's serve sends no
 * `ended`): the run is read, or it would read Done with its rail all green.
 */
export const endUnsaid = (d: EventData<'factory.stage'>): boolean =>
  d.outcome === 'abandoned' && d.ended === undefined;

const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/**
 * A read's runs over the ones held: each as read, unless the held one moved while the read was
 * out (`newer`, from `movedSince`) or entered a later stage than the read says: then its stage,
 * state, clock and pull request stay. One the screen let go of meanwhile (cleared) stays gone.
 */
export const freshRuns = (
  held: readonly FactoryRunData[] | undefined,
  read: readonly FactoryRunData[],
  newer: (key: string) => boolean = () => false,
): FactoryRunData[] => {
  const by = new Map((held ?? []).map((r) => [r.session, r]));

  return read.flatMap((r) => {
    const had = by.get(r.session);
    const moved = newer(`run:${r.session}`);

    if (had === undefined) return moved ? [] : [r];
    if (!(moved || later(had.since, r.since))) return [r];

    return [
      {
        ...r,
        stage: had.stage,
        state: had.state,
        since: had.since,
        outcome: had.outcome,
        reason: had.reason,
        // the event's pull request: the read is older
        pr: had.pr,
        ended: had.ended,
        stages: had.stages.length > r.stages.length ? had.stages : r.stages,
      },
    ];
  });
};

/**
 * `factory status`'s answer to the read `id` on the runs held: all of them (`runs`), or one
 * card's (`run:<card>`) in place of what was held of it.
 */
export const runsRead = (
  held: readonly FactoryRunData[] | undefined,
  id: string,
  read: readonly FactoryRunData[],
  heard: Heard | undefined,
): FactoryRunData[] => {
  const fresh = freshRuns(held, read, movedSince(heard, id));

  if (!id.startsWith('run:')) return fresh;
  const card = Number(id.slice('run:'.length));

  return [...(held ?? []).filter((r) => r.card !== card), ...fresh];
};

/**
 * A session's `session.state` event on the ones held: ended by `stop`, you stopped it; its
 * launch steps a starting one's only. Ended while Queued, it never got its box.
 */
export const sessionMoved = (
  sessions: readonly SessionData[],
  d: EventData<'session.state'>,
): SessionData[] =>
  sessions.map((x) =>
    x.id === d.id
      ? {
          ...x,
          state: d.state,
          since: d.since,
          stopped: d.state === 'ended' && (d.cause === 'stop' || x.stopped),
          launch: d.state === 'starting' ? x.launch : null,
          // on what it waits (idle at your turn, or on you); an older serve's says none
          waitingOn: d.state === 'waiting' ? (d.waitingOn ?? null) : null,
          // its own turn ended while its background subagents work on
          turnEnded: d.turnEnded,
          // why it ended, as it ended
          ...(d.reason === undefined ? {} : { reason: d.reason }),
          ...(x.state === 'queued' && d.state === 'ended' ? { neverPlaced: true } : {}),
        }
      : x,
  );

/** A starting session's `session.step` event on the ones held: its launch at that step. */
export const sessionStepped = (
  sessions: readonly SessionData[],
  d: EventData<'session.step'>,
): SessionData[] =>
  sessions.map((x) =>
    x.id === d.id && x.state === 'starting' && !olderLaunch(d.launch, x.launch)
      ? { ...x, launch: d.launch }
      : x,
  );

/**
 * Whether `a` is behind `b`: fewer steps gone through, else in its step since earlier, else an
 * earlier build count (the stream and a read out of order).
 */
const olderLaunch = (a: SessionData['launch'], b: SessionData['launch']): boolean => {
  if (a === null) return true;
  if (b === null) return false;
  if (a.done.length !== b.done.length) return a.done.length < b.done.length;
  if (a.since !== b.since) return a.since < b.since;

  return buildCount(a.detail) < buildCount(b.detail);
};

/** A build's `step 14/27` as 14; 0 for none. */
const buildCount = (detail: string | null) => Number(/^step (\d+)\//.exec(detail ?? '')?.[1] ?? 0);

/**
 * A read's sessions over the ones held: as read, but a state the held one moved to since (or
 * began later) stays, and so do subagents heard of since.
 */
export const freshSessions = (
  held: readonly SessionData[] | undefined,
  read: readonly SessionData[],
  newer: (key: string) => boolean = () => false,
): SessionData[] => {
  const by = new Map((held ?? []).map((x) => [x.id, x]));

  return read.map((x) => {
    const had = by.get(x.id);

    if (had === undefined) return x;
    const state =
      newer(`session:${x.id}`) || later(had.since, x.since)
        ? { state: had.state, since: had.since, stopped: had.stopped, turnEnded: had.turnEnded }
        : {};

    const starting = (state.state ?? x.state) === 'starting';
    const further = olderLaunch(x.launch, had.launch) ? had.launch : x.launch;

    return {
      ...x,
      ...state,
      // the further launch of the two: a read asked before a step heard since says the one before
      launch: starting ? further : null,
      ...(newer(`subagents:${x.id}`) ? { subagents: had.subagents } : {}),
    };
  });
};

/** A subagent's `session.subagent` event on the ones held (`at`: the event's time). */
export const subagentMoved = (
  sessions: readonly SessionData[],
  d: EventData<'session.subagent'>,
  at: string,
): SessionData[] =>
  sessions.map((x) => {
    if (x.id !== d.id) return x;
    const had = x.subagents.find((r) => r.id === d.agent);
    const run = {
      id: d.agent,
      name: d.name,
      task: d.task,
      model: d.model,
      state: d.state,
      startedAt: had?.startedAt ?? at,
      endedAt: d.state === 'done' ? at : null,
      result: d.result,
      tool: d.tool ?? had?.tool ?? null,
      tools: d.tools ?? had?.tools ?? 0,
      call: d.call ?? had?.call ?? null,
      transcript: d.transcript ?? had?.transcript ?? null,
    };

    return {
      ...x,
      subagents:
        had === undefined ? [...x.subagents, run] : x.subagents.map((r) => (r === had ? run : r)),
    };
  });
