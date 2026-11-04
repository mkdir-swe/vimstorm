/**
 * Your boxes as a screen holds them: `abe box list` read once, then changed in place by
 * `box.state`, `box.step` `booting` and `box.idle` (a move that says too little, or a box not
 * known, reads the list again). The Boxes tab's rows and the Factory screen's feed (the status bar's `☁ N boxes`, a
 * card's box mark) are both worked out from it. Pure: the clock is the caller's.
 */
import type { BoxData, BoxListData, BoxReach, Event, QueuedBoxData } from '@abe/core';
import {
  BOX_STATE_WORDS,
  boxBooting,
  boxCostAt,
  boxReachOf,
  byBoxName,
  boxReachWords,
  boxScreenWords,
  boxStuckMinutes,
  boxUp,
} from '@abe/core/box-text';
import { screenClock, screenWhen } from '@abe/core/when';
import type { Widget } from '../runtime/runtime';

/** A box mark, as the boxes' look names them (`box-look.ts`): its cloud, or Queued. */
type BoxMark = 'running' | 'asleep' | 'starting' | 'queued';

const MIN_MS = 60_000;

/**
 * `01:30`: an ISO time on the Mac's clock, from its own instant (core's `screenClock`);
 * `02:08 CET` when a DST change lies between it and `now`.
 */
export const clock = (iso: string, now?: number | string): string => screenClock(iso, now);

/**
 * `14:02` today, `24 Oct 14:02` another day; with no `now`
 * the clock only.
 */
export const endedWhen = (at: string, now?: string): string =>
  now === undefined ? clock(at) : screenWhen(at, now);

/**
 * A box about to sleep while a session on it waits on you:
 * when, and since when it waits; undefined otherwise.
 */
export const sleepsSoon = (
  b: Pick<BoxData, 'state' | 'idle'>,
): { at: string; waiting: string } | undefined => {
  const idle = b.idle;

  if (b.state !== 'running' || idle?.soon !== true || idle.stopsAt === null) return undefined;

  return idle.waitingSince === undefined || idle.waitingSince === null
    ? undefined
    : { at: idle.stopsAt, waiting: idle.waitingSince };
};

/** `demo-shop-1 sleeps at 13:09: its session waits on you since 12:35`. */
export const sleepsSoonText = (
  name: string,
  soon: { at: string; waiting: string },
  now?: number | string,
): string =>
  `${name} sleeps at ${clock(soon.at, now)}: its session waits on you since ${clock(soon.waiting, now)}`;

/** How often a screen reads the list again for what changed outside Abe. */
export const REREAD_MS = 5 * MIN_MS;

/** Whether EC2 bills a box in this state: it is up. */
export const isUp = boxUp;

/** Gone or going: never listed. */
export const isGone = (b: Pick<BoxData, 'state'>): boolean =>
  b.state === 'shutting-down' || b.state === 'terminated';

/**
 * A box in trouble, where it stands for a command (core's `BoxReach`): stuck starting, or
 * running with its `serve` not answering or the link not getting there.
 */
export const boxProblem = (b: BoxData, now: number): BoxReach | undefined => {
  if (boxStuckMinutes(b, now) !== null) return { kind: 'starting', since: b.launchedAt };
  // a normal boot: booting, no problem
  if (boxBooting(b, now)) return undefined;

  return b.state === 'running' ? boxReachOf(b) : undefined;
};

/** Today's cost so far at `at` (ms), from local midnight: core's `boxCostAt` on the box's read. */
export const costAt = (b: BoxData, at: number): number | null => {
  if (b.costToday === null) return null;
  const day = new Date(at);

  day.setHours(0, 0, 0, 0);

  return boxCostAt(b.costToday, boxUp(b.state), at, day.getTime());
};

type BoxMove = Extract<Event, { type: 'box.state' }>['data']['state'];

/** A `box.state` as a screen keeps it while a `box list` is out: the box, its move, when (ms). */
export type BoxMoveAt = { box: string; state: BoxMove; at: number };

/** EC2's state after a `box.state` move; undefined: read the list (queued, failed). */
const EC2_OF: Readonly<Record<BoxMove, BoxData['state'] | undefined>> = {
  queued: undefined,
  starting: 'pending',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  failed: undefined,
  terminated: 'terminated',
};

/**
 * A box moved: its state in place, its cost as of the move, a start its Up from now; `running`
 * with its serve answering (`box.state`), or `silent` (`box.step` `booting`: not yet).
 */
const movedBox = (
  b: BoxData,
  state: BoxData['state'],
  at: number,
  serve: 'answers' | 'silent' = 'answers',
): BoxData => {
  const iso = new Date(at).toISOString();
  const usd = costAt(b, at);
  const c = b.costToday;
  const ranMinutes =
    c === null || !isUp(b.state) ? 0 : Math.max(0, Math.floor((at - Date.parse(c.at)) / MIN_MS));
  const next: BoxData = {
    ...b,
    state,
    // up from down (a `running` with no `starting` heard first too): its Up from now
    ...(isUp(state) && !isUp(b.state) ? { launchedAt: iso } : {}),
    ...(c === null
      ? {}
      : { costToday: { ...c, usd: usd ?? 0, minutes: c.minutes + ranMinutes, at: iso } }),
    ...(isUp(state) ? {} : { serve: null }),
  };

  if (!isUp(state)) delete next.idle;
  // `running` is said once its serve answers (booting said it running and silent before)
  if (state !== b.state || state === 'running') delete next.reach;
  if (state === 'running') next.serve = serve;

  return next;
};

/**
 * The boxes after a `box.state` at `at` (ms), changed in place; `read` when the move says too
 * little (queued, failed) or names a box not known (made, or woken from Queued).
 */
export const boxesMoved = (
  boxes: readonly BoxData[],
  move: { box: string; state: BoxMove },
  at: number,
): BoxData[] | 'read' => {
  const state = EC2_OF[move.state];
  const known = boxes.find((b) => b.name === move.box);

  if (known === undefined || state === undefined) return 'read';

  return boxes.map((b) => (b === known ? movedBox(b, state, at) : b));
};

/**
 * A `box list` answer with the moves said while it was out put back on it (the read was asked
 * before them); a move that says too little is left to the list.
 */
export const replayMoves = (boxes: readonly BoxData[], moves: readonly BoxMoveAt[]): BoxData[] =>
  moves.reduce<BoxData[]>(
    (acc, m) => {
      const next = boxesMoved(acc, m, m.at);

      return next === 'read' ? acc : next;
    },
    [...boxes],
  );

/**
 * The boxes after a `box.step` `booting` at `at` (ms): EC2 runs that box, its `serve` not
 * answering yet (`running · serve not answering · N min` until its `box.state` `running`);
 * undefined: not one of them, or it runs already.
 */
export const boxesBooting = (
  boxes: readonly BoxData[],
  box: string,
  at: number,
): BoxData[] | undefined => {
  const known = boxes.find((b) => b.name === box);

  if (known === undefined || known.state === 'running') return undefined;

  return boxes.map((b) => (b === known ? movedBox(b, 'running', at, 'silent') : b));
};

/** The boxes after a `box.idle`: that box's idle stop in place; undefined: not one of them. */
export const boxesIdled = (
  boxes: readonly BoxData[],
  d: Extract<Event, { type: 'box.idle' }>['data'],
): BoxData[] | undefined =>
  boxes.some((b) => b.name === d.box)
    ? boxes.map((b) => (b.name === d.box ? { ...b, idle: d.idle } : b))
    : undefined;

/**
 * A card's box: the one holding its box workspace (ADR 0022, as its last `abe status` said), or
 * an old box made for it (its `abe:card` tag), else its placement Queued for one; a gone box is none.
 */
export const boxOfCard = (
  list: BoxListData,
  card: number,
): { box: BoxData } | { queued: QueuedBoxData } | undefined => {
  const box = list.boxes.find(
    (b) =>
      !isGone(b) && (b.card === card || (b.workspaces ?? []).some((w) => w.card === String(card))),
  );

  if (box !== undefined) return { box };
  const queued = list.queued.find((q) => q.card === card);

  return queued === undefined ? undefined : { queued };
};

/**
 * A card's box in Linked's words (ADR 0022): `☁ demo-shop #101`, the repo box and the card's
 * workspace on it; an old box (made for that one card, `abe:card`) by its name alone.
 */
export const cardBoxWords = (
  name: string,
  card: number,
  box: Pick<BoxData, 'card'> | undefined,
): string => (box !== undefined && box.card !== null ? name : `☁ ${name} #${card}`);

/** The name of a card's box, or of the box its placement is Queued for. */
export const cardBoxName = (list: BoxListData, card: number): string | undefined => {
  const tagged = boxOfCard(list, card);

  if (tagged === undefined) return undefined;

  return 'box' in tagged ? tagged.box.name : tagged.queued.box;
};

/** A box mark in words (Sessions' Where tooltip, the story dialog's Box row): Queued is `queued`. */
export const BOX_MARK_WORDS: Readonly<Record<BoxMark, string>> = {
  running: 'running',
  starting: 'starting',
  asleep: 'asleep',
  queued: 'queued',
};

const problemWords = (b: BoxData, p: BoxReach, now: number): string =>
  `${b.name} ${boxReachWords(p, now)}`;

/**
 * The ear's Boxes badge:
 * `3 · 1 running`, dim; a zero running count left out; no boxes, no badge. Red while a box is stuck
 * starting or its `serve` does not answer, `words` naming each such box and why
 * (`demo-shop-1 starting · 6 min`); amber while one is about to sleep with a session waiting on you
 *; else the count and each box with its state.
 */
export const boxesBadge = (
  list: BoxListData | undefined,
  now: number | undefined,
): { badge: string; hue: 'dim' | 'bad' | 'warn'; words: string } | undefined => {
  const boxes = (list?.boxes ?? []).filter((b) => !isGone(b));

  if (boxes.length === 0) return undefined;
  // a booting box is not running yet, as the Boxes tab says
  const running = boxes.filter(
    (b) => b.state === 'running' && (now === undefined || !boxBooting(b, now)),
  ).length;
  const badge = `${boxes.length}${running === 0 ? '' : ` · ${running} running`}`;
  const count = `${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'}${
    running === 0 ? '' : `, ${running} running`
  }`;
  const named = [...boxes].sort(byBoxName);
  const problems = named.flatMap((b) => {
    if (now === undefined) return [];
    const p = boxProblem(b, now);

    return p === undefined ? [] : [problemWords(b, p, now)];
  });

  if (problems.length > 0) return { badge, hue: 'bad', words: [count, ...problems].join(' · ') };
  const sleepy = named.flatMap((b) => {
    const soon = sleepsSoon(b);

    return soon === undefined ? [] : [sleepsSoonText(b.name, soon, now)];
  });

  if (sleepy.length > 0) return { badge, hue: 'warn', words: [count, ...sleepy].join(' · ') };

  return {
    badge,
    hue: 'dim',
    words: [
      count,
      ...named.map(
        (b) => `${b.name} ${now === undefined ? BOX_STATE_WORDS[b.state] : boxScreenWords(b, now)}`,
      ),
    ].join(' · '),
  };
};

/** The status bar widget's id: a click on it is `widget:boxes`. */
export const BOXES_WIDGET = 'boxes';

/**
 * The status bar's `☁ 3 boxes · 1 running` (board X-Boxes; the shell draws
 * the cloud from `cloud`: the accent while a box runs, dim when all sleep), on both views; a zero
 * running count left out; no boxes, no widget. Red while a box is stuck starting or its `serve`
 * does not answer, its tooltip naming each such box and why (`demo-shop-1 starting · 6 min`);
 * else each box and its state, then `:boxes`.
 */
export const boxesWidget = (
  list: BoxListData | undefined,
  now: number | undefined,
): Widget | undefined => {
  const boxes = (list?.boxes ?? []).filter((b) => !isGone(b));

  if (boxes.length === 0) return undefined;
  // a booting box is not running yet: its serve does not answer, as the Boxes tab says
  const runs = (b: BoxData) => b.state === 'running' && (now === undefined || !boxBooting(b, now));
  const running = boxes.filter(runs).length;
  const text = `${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'}${
    running === 0 ? '' : ` · ${running} running`
  }`;
  // the cloud (drawn before the words): in the accent while one runs, dim when all sleep
  const cloud = running === 0 ? ('asleep' as const) : ('running' as const);
  const named = [...boxes].sort(byBoxName);
  const problems = named.flatMap((b) => {
    if (now === undefined) return [];
    const p = boxProblem(b, now);

    return p === undefined ? [] : [problemWords(b, p, now)];
  });

  if (problems.length > 0)
    return { id: BOXES_WIDGET, text, cloud, hue: 'bad', tooltip: problems.join(' · ') };
  // About to sleep with a session waiting on you: said here, a click keeps it awake.
  const sleepy = named.flatMap((b) => {
    const soon = sleepsSoon(b);

    return soon === undefined ? [] : [{ b, soon }];
  });
  const first = sleepy[0];

  if (first !== undefined)
    return {
      id: BOXES_WIDGET,
      text: `${text} · ${first.b.name} sleeps ${clock(first.soon.at, now)}`,
      cloud,
      hue: 'warn',
      tooltip: [
        ...sleepy.map((x) => sleepsSoonText(x.b.name, x.soon, now)),
        `click: keep ${first.b.name} awake`,
      ].join(' · '),
    };

  return {
    id: BOXES_WIDGET,
    text,
    cloud,
    tooltip: [
      ...named.map(
        (b) => `${b.name} ${now === undefined ? BOX_STATE_WORDS[b.state] : boxScreenWords(b, now)}`,
      ),
      ':boxes',
    ].join(' · '),
  };
};
