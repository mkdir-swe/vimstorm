/**
 * A box stops itself when idle (#92, ADR 0021): on a box (`ABE_BOX=1`) this `serve` looks every
 * minute; with no Claude Code hook and nothing keeping it up (`IDLE_KEEPS`) for `box.idleMinutes`
 * it says `box.state` `stopping` and shuts the machine down, which EC2 takes as a stop (the
 * disk is kept; `abe box up` wakes it). Kept awake (`abe box keep`, #104) it never does until
 * `abe box sleep`: the keep is in the box's state file, so a `serve` started again keeps it,
 * and a new boot (the box stopped and woken) does not. Each change of when it stops or what
 * keeps it up is said as `box.idle`. A session waiting on you does not keep it up, but the box
 * sleeps no sooner than `box.waitingMinutes` after the session began to wait, and says so
 * `IDLE_WARN_MS` before (`box.idle` with `soon`, #192).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  type Answered,
  type BoxHost,
  type BoxIdleData,
  type BoxKeepData,
  type Clock,
  type EventData,
  type IdleKeep,
  idleLook,
} from '@abe/core';
import { z } from 'zod';

/** How often it looks (a minute). */
export const IDLE_EVERY_MS = 60_000;

export type IdleStopOptions = {
  /** The box's own name (`ABE_BOX_NAME`), as `box.state` names it. */
  name: string;
  clock: Clock;
  everyMs?: number;
  /** `box.idleMinutes` in force now (read on every look, so a changed Layer applies at once). */
  minutes: () => number;
  /** `box.waitingMinutes` in force now; absent: a waiting session holds nothing back. */
  waitingMinutes?: () => number;
  /** What keeps the box up now, and since when a session on it waits on you. */
  keeps: () => Promise<IdleHeld>;
  host: BoxHost;
  emit: (data: EventData<'box.state'>) => void;
  log: (message: string) => void;
  /**
   * Where the awake keep is kept (`<state>/box-keep.json`) and the box's boot now (its
   * `boot_id`; null: not known, then a kept one holds): without it, kept until `serve` stops.
   */
  keep?: { file: string; boot: string | null };
  /** `box.idle`: when it stops or what keeps it up changed. */
  said?: (data: BoxKeepData) => void;
};

/** What holds a box up now: its keeps, and since when a session waits on you (ms; null: none). */
export type IdleHeld = { keptBy: IdleKeep[]; waitingSince: number | null };

/** The awake keep in the box's state file, with the boot it was set in. */
const KeepFile = z.object({ v: z.literal(1), awake: z.boolean(), boot: z.string().nullable() });

/** Kept awake as the state file says, in this boot (a boot not known keeps it). */
const readAwake = (keep: { file: string; boot: string | null } | undefined): boolean => {
  if (keep === undefined) return false;
  try {
    const doc = KeepFile.safeParse(JSON.parse(readFileSync(keep.file, 'utf8')));

    return (
      doc.success &&
      doc.data.awake &&
      (doc.data.boot === null || keep.boot === null || doc.data.boot === keep.boot)
    );
  } catch {
    return false;
  }
};

const writeAwake = (keep: { file: string; boot: string | null }, awake: boolean) => {
  const temp = `${keep.file}.${process.pid}.tmp`;

  writeFileSync(temp, `${JSON.stringify({ v: 1, awake, boot: keep.boot })}\n`);
  renameSync(temp, keep.file);
};

/**
 * When it stops (to the minute), what keeps it up and whether that is near: a change of this is
 * a `box.idle`.
 */
const keyOf = (idle: BoxIdleData) =>
  `${idle.stopsAt?.slice(0, 16) ?? '-'} ${idle.keptBy.join()} ${idle.soon === true ? 'soon' : ''}`;

export type IdleStop = {
  /** The box's own name. */
  name: string;
  /** A Claude Code hook was heard: the idle time starts again. */
  heard: () => void;
  /** Where it stands now, as of the last look's keeps (for `abe status`). */
  look: () => BoxIdleData;
  /**
   * Kept awake (`abe box keep`) or let sleep (`abe box sleep`: the idle time counts from now),
   * kept in the state file and said as `box.idle`: where it stands then.
   */
  keep: (awake: boolean) => BoxIdleData;
  /** One look now (the timer's; tests call it). */
  tick: () => Promise<void>;
  stop: () => void;
};

export const startIdleStop = (o: IdleStopOptions): IdleStop => {
  let activeAt = o.clock.now();
  let awake = readAwake(o.keep);
  let keptBy: IdleKeep[] = awake ? ['awake'] : [];
  let waitingSince: number | null = null;
  let ticking = false;
  let halting = false;

  /** What keeps it up: the awake keep first, then what the box holds. */
  const keptWith = (held: readonly IdleKeep[]): IdleKeep[] => [
    ...(awake ? (['awake'] as const) : []),
    ...held.filter((k) => k !== 'awake'),
  ];

  const lookAt = (at: number) =>
    idleLook({
      now: at,
      minutes: o.minutes(),
      activeAt,
      keptBy,
      ...(o.waitingMinutes === undefined
        ? {}
        : { waiting: { since: waitingSince, minutes: o.waitingMinutes() } }),
    });

  const now = (): BoxIdleData => {
    // The look's data only: `stop` is the timer's.
    const idle: BoxIdleData & { stop?: boolean } = lookAt(o.clock.now());

    delete idle.stop;

    return idle;
  };

  /** The last `box.idle` said (or where it stood at start). */
  let saidKey = keyOf(now());
  const sayIfMoved = () => {
    const idle = now();
    const key = keyOf(idle);

    if (key === saidKey) return idle;
    saidKey = key;
    o.said?.({ box: o.name, idle });

    return idle;
  };

  const look = () => {
    const now = o.clock.now();
    const seen = lookAt(now);

    if (keptBy.length > 0) activeAt = now;

    return seen;
  };

  const halt = async (minutes: number) => {
    halting = true;
    o.emit({ box: o.name, state: 'stopping', cause: 'idle' });
    o.log(`${o.name}: idle for ${minutes} min, shutting down`);
    const done = await o.host.shutdown().catch((err: unknown): Answered<null> => ({
      ok: false,
      error: { code: 'shutdown-failed', message: err instanceof Error ? err.message : String(err) },
    }));

    if (done.ok) return;
    // Up after all: said, and tried again after another idle time.
    o.log(`${o.name}: shutdown failed: ${done.error.code}: ${done.error.message}`);
    o.emit({ box: o.name, state: 'running', cause: 'shutdown-failed' });
    activeAt = o.clock.now();
    halting = false;
  };

  const tick = async () => {
    if (ticking || halting) return;
    ticking = true;
    try {
      const kept = await o.keeps().catch((err: unknown) => {
        o.log(`${o.name}: idle look skipped: ${err instanceof Error ? err.message : String(err)}`);
      });

      // Not known what keeps it up: no stop on this look.
      if (kept === undefined) return;
      keptBy = keptWith(kept.keptBy);
      waitingSince = kept.waitingSince;
      const seen = look();

      if (seen.stop) await halt(seen.minutes);
      else sayIfMoved();
    } catch (err) {
      o.log(`${o.name}: idle look failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, o.everyMs ?? IDLE_EVERY_MS);

  // Never what keeps a serve's process alive.
  timer.unref();

  return {
    name: o.name,
    heard: () => {
      activeAt = Math.max(activeAt, o.clock.now());
    },
    look: now,
    keep: (on) => {
      // Let sleep: kept up until now, so the idle time counts from now.
      if (awake && !on) activeAt = Math.max(activeAt, o.clock.now());
      awake = on;
      keptBy = keptWith(keptBy);
      if (o.keep !== undefined) writeAwake(o.keep, on);

      return sayIfMoved();
    },
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
};
