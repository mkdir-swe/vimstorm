/**
 * A box stops itself when idle (#92, ADR 0021): its own `serve` shuts it down once it has had no
 * Claude Code hook and no one attached for `box.idleMinutes`; the disk stays and `abe box up`
 * wakes it. Here the rule; the box's `serve` looks, says `box.state` `stopping` and shuts down.
 */
import { z } from 'zod';
import { type SessionState } from '../session/session';
import { localClock, spanText, type TextAt } from '../command';

/**
 * What keeps a box up while it lasts, however long since the last hook: you keeping it awake
 * (`abe box keep`, until `abe box sleep` or `abe box stop`: #104), a terminal attached (a tmux
 * client in the workspace or a login on the box: `abe box attach`), a session working (a long
 * tool call runs no hook), a Factory run waiting on its pull request (the box reads it on).
 */
export const IDLE_KEEPS = ['awake', 'attached', 'working', 'pr'] as const;
export const IdleKeep = z.enum(IDLE_KEEPS);
export type IdleKeep = z.infer<typeof IdleKeep>;

/** The longest `box.idleMinutes` (and `box.waitingMinutes`): a day. */
export const MAX_IDLE_MINUTES = 1440;

/**
 * How long before its idle stop a box says it is about to sleep (#192): `box.idle` with `soon`,
 * so the person sees it in time to keep it awake.
 */
export const IDLE_WARN_MS = 5 * 60_000;

/**
 * When a session waiting on you began waiting, the oldest of those (ms); null: none waits. A
 * waiting session does not keep its box up (ADR 0021), but its box sleeps no sooner than
 * `box.waitingMinutes` after it began to wait (#192).
 */
export const waitingSinceOf = (
  sessions: readonly { state: SessionState; since: string }[],
): number | null => {
  const waits = sessions
    .filter((s) => s.state === 'waiting')
    .map((s) => Date.parse(s.since))
    .filter((ms) => !Number.isNaN(ms));

  return waits.length === 0 ? null : Math.min(...waits);
};

/**
 * What keeps the box up, from what it holds: `attached`, its sessions' states (one starting or
 * working; one waiting on you with nobody attached does not, ADR 0021), a run waiting on its PR.
 */
export const idleKeepsOf = (o: {
  attached: boolean;
  sessions: readonly SessionState[];
  carried: boolean;
  /** Kept awake (`abe box keep`). */
  awake?: boolean;
}): IdleKeep[] => [
  ...(o.awake === true ? (['awake'] as const) : []),
  ...(o.attached ? (['attached'] as const) : []),
  ...(o.sessions.some((s) => s === 'starting' || s === 'working') ? (['working'] as const) : []),
  ...(o.carried ? (['pr'] as const) : []),
];

/** Where a box's idle stop stands: `abe status` on a box, and `abe box list` from the Mac. */
export const BoxIdleData = z.object({
  /** `box.idleMinutes` in force. */
  minutes: z.number().int().positive().max(MAX_IDLE_MINUTES),
  /** The last hook, or the last moment something kept it up (or serve started). */
  activeAt: z.iso.datetime(),
  /** When it stops if nothing happens before; null while something keeps it up. */
  stopsAt: z.iso.datetime().nullable(),
  keptBy: z.array(IdleKeep),
  /**
   * Since when a session on it waits on you (the oldest; #192): it sleeps no sooner than
   * `waitingMinutes` after that. Absent or null: none waits (or a box from before).
   */
  waitingSince: z.iso.datetime().nullable().optional(),
  /** `box.waitingMinutes` in force, beside `waitingSince`. */
  waitingMinutes: z.number().int().positive().max(MAX_IDLE_MINUTES).optional(),
  /** Its stop is due within `IDLE_WARN_MS` (or now): said once as a `box.idle` (#192). */
  soon: z.boolean().optional(),
});
export type BoxIdleData = z.infer<typeof BoxIdleData>;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One look: kept up, the idle time starts again now; else it stops `minutes` after the last
 * activity, and no sooner than `waiting.minutes` after a session began to wait on you (#192);
 * `stop` says that time has come, `soon` that it comes within `IDLE_WARN_MS`.
 */
export const idleLook = (o: {
  now: number;
  minutes: number;
  /** The last activity (ms). */
  activeAt: number;
  keptBy: readonly IdleKeep[];
  /** A session waiting on you: since when (ms, `waitingSinceOf`) and `box.waitingMinutes`. */
  waiting?: { since: number | null; minutes: number };
}): BoxIdleData & { stop: boolean } => {
  const waits = o.waiting?.since ?? null;
  const base = {
    minutes: o.minutes,
    keptBy: [...o.keptBy],
    ...(o.waiting === undefined
      ? {}
      : {
          waitingSince: waits === null ? null : iso(waits),
          waitingMinutes: o.waiting.minutes,
        }),
  };

  if (o.keptBy.length > 0)
    return { ...base, activeAt: iso(o.now), stopsAt: null, soon: false, stop: false };
  const idleAt = o.activeAt + o.minutes * 60_000;
  const stopsAt =
    waits === null || o.waiting === undefined
      ? idleAt
      : Math.max(idleAt, waits + o.waiting.minutes * 60_000);

  return {
    ...base,
    activeAt: iso(o.activeAt),
    stopsAt: iso(stopsAt),
    soon: o.now >= stopsAt - IDLE_WARN_MS,
    stop: o.now >= stopsAt,
  };
};

/** Whether a session on it waits on you: then its sleep waits for you to answer. */
const waitsOnYou = (idle: BoxIdleData): idle is BoxIdleData & { waitingSince: string } =>
  idle.waitingSince !== undefined && idle.waitingSince !== null;

/** What keeps a box up, in words. */
export const KEEP_WORDS: Readonly<Record<IdleKeep, string>> = {
  awake: 'kept awake until abe box sleep',
  attached: 'attached',
  working: 'a session working',
  pr: 'a Factory run on its pull request',
};

/**
 * Its idle stop in words, in local time (#194): `sleeps at 13:09 if still idle (30 min) · in 12
 * min`; past due, `going to sleep now`; held for a session waiting on you, since when. With
 * `at` the text is as of then (no time left that has passed); `box` adds how to keep it awake
 * once its sleep is near.
 */
export const boxIdleText = (idle: BoxIdleData, at?: TextAt, box?: string): string => {
  if (idle.stopsAt === null) {
    const others = idle.keptBy.filter((k) => k !== 'awake').map((k) => KEEP_WORDS[k]);
    // kept awake says its own keep: never `kept up: kept awake` (#244)
    const head = idle.keptBy.includes('awake')
      ? `${KEEP_WORDS.awake}${others.length === 0 ? '' : `, also ${others.join(', ')}`}`
      : `kept up: ${others.join(', ')}`;

    return `${head} (sleeps ${idle.minutes} min after)`;
  }
  const stopsAt = Date.parse(idle.stopsAt);
  const due = at !== undefined && at.now >= stopsAt;
  const waiting = waitsOnYou(idle);
  const why = waiting
    ? `a session waits on you since ${localClock(idle.waitingSince, at?.now)}`
    : `idle ${idle.minutes} min`;
  const keep =
    box !== undefined && (idle.soon === true || due) ? ` · abe box keep ${box} keeps it awake` : '';

  if (due) return `going to sleep now (${why})${keep}`;
  const left = at === undefined ? '' : ` · in ${spanText(stopsAt - at.now)}`;
  const when = waiting
    ? `sleeps at ${localClock(stopsAt, at?.now)} if you have not answered (${why})`
    : `sleeps at ${localClock(stopsAt, at?.now)} if still idle (${idle.minutes} min)`;

  return `${when}${left}${keep}`;
};
