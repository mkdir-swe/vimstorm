/**
 * Box load (ADR 0022, #344): what a repo's box has left with its workspaces on it (memory, CPU,
 * its root disk and each workspace's share of it), as the box's serve reads it at most every
 * `LOAD_READ_EVERY_MS`. It drives the resize ask at a launch (`launchShort`) and the root disk's
 * growth (`diskGrowth`). Rules only: the box serve reads and acts.
 */
import { z } from 'zod';
import { BOX_SIZES, boxSizeRank } from './box-sizes';
import { type BoxShortAsk } from '../command';

/** How often a box's serve reads its load (and decides whether its disk grows). */
export const LOAD_READ_EVERY_MS = 10 * 60_000;

/** Below this much memory free a launch asks first (each workspace's hard cap is 3 GB). */
export const LAUNCH_MEMORY_MB = 3 * 1024;

/** Below this much disk free a launch asks first. */
export const LAUNCH_DISK_GB = 10;

/** The root disk grows by this much at a time, below `BOX_DISK_GROW_BELOW` free. */
export const BOX_DISK_STEP_GB = 20;

/** The free share of the root disk below which it grows. */
export const BOX_DISK_GROW_BELOW = 0.2;

/** AWS allows one change to a volume per 6 hours. */
export const BOX_DISK_EVERY_MS = 6 * 3_600_000;

export const BoxLoad = z.object({
  /** When it was read. */
  at: z.iso.datetime(),
  memory: z.object({
    availableMb: z.number().int().nonnegative(),
    totalMb: z.number().int().nonnegative(),
  }),
  /** All cores' busy share between this read and the one before (the first: since boot), 0–100. */
  cpuPercent: z.number().min(0).max(100),
  /** The root disk, in GB (one decimal). */
  disk: z.object({ freeGb: z.number().nonnegative(), totalGb: z.number().nonnegative() }),
  /** Each workspace's clone volume on that disk, by card. */
  workspaces: z.array(z.object({ card: z.string(), diskGb: z.number().nonnegative() })),
});
export type BoxLoad = z.infer<typeof BoxLoad>;

/** The CPU counters of `/proc/stat`'s first line: busy and all jiffies since boot. */
export type CpuTimes = { busy: number; total: number };

/** What the box's host and Docker say, read whole each time. */
export type HostLoad = {
  memAvailableKb: number;
  memTotalKb: number;
  cpu: CpuTimes;
  disk: { freeBytes: number; totalBytes: number };
  /** Each Docker volume's size in bytes, by name. */
  volumes: Readonly<Record<string, number>>;
};

const GB = 1024 ** 3;
const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * The box's load from a host read and the CPU counters of the read before (none: since boot).
 * `cardOf`: the card a volume is the clone of (`cardOfWorkspace`, an old box's `abe-workspace`).
 */
export const boxLoadOf = (
  host: HostLoad,
  before: CpuTimes | undefined,
  at: string,
  cardOf: (volume: string) => string | undefined,
): BoxLoad => {
  const busy = host.cpu.busy - (before?.busy ?? 0);
  const total = host.cpu.total - (before?.total ?? 0);

  return {
    at,
    memory: {
      availableMb: Math.floor(host.memAvailableKb / 1024),
      totalMb: Math.floor(host.memTotalKb / 1024),
    },
    cpuPercent: total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((busy / total) * 100))),
    disk: { freeGb: tenth(host.disk.freeBytes / GB), totalGb: tenth(host.disk.totalBytes / GB) },
    workspaces: Object.entries(host.volumes)
      .flatMap(([name, bytes]) => {
        const card = cardOf(name);

        return card === undefined ? [] : [{ card, diskGb: tenth(bytes / GB) }];
      })
      .sort((a, b) => a.card.localeCompare(b.card, 'en', { numeric: true })),
  };
};

/** The size after `size`, or null when there is none within `max` (or `size` is no box size). */
export const nextBoxSize = (size: string, max: string): string | null => {
  const rank = boxSizeRank(size);
  const next = rank === -1 ? undefined : BOX_SIZES[rank + 1];

  return next === undefined || boxSizeRank(next) > boxSizeRank(max) ? null : next;
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Whether a launch onto the box asks first (ADR 0022: Resize, Launch anyway or Cancel; never
 * Queued, never a second box): short of memory (under `LAUNCH_MEMORY_MB` free) before short of
 * disk (under `LAUNCH_DISK_GB` free), with the line the question card leads with.
 */
export const launchShort = (
  load: BoxLoad,
  on: { box: string; workspaces: number; working: readonly string[] },
): { short: 'memory' | 'disk'; line: string } | undefined => {
  const held = [
    count(on.workspaces, 'workspace'),
    ...(on.working.length === 0 ? [] : [`(${on.working.map((c) => `#${c}`).join(', ')} working)`]),
  ].join(' ');

  if (load.memory.availableMb < LAUNCH_MEMORY_MB)
    return {
      short: 'memory',
      line: `${on.box} is short of memory: ${tenth(load.memory.availableMb / 1024)} GB free, ${held}`,
    };
  if (load.disk.freeGb < LAUNCH_DISK_GB)
    return {
      short: 'disk',
      line: `${on.box} is short of disk: ${load.disk.freeGb} GB free of ${load.disk.totalGb} GB, ${held}`,
    };

  return undefined;
};

/** How long a launch waits for a running box's load: one not read in time never holds it up. */
export const SHORT_READ_MS = 5000;

const ending = (working: readonly string[]) =>
  working.length === 0
    ? ''
    : `: ${working.map((c) => `#${c}`).join(', ')} ${working.length === 1 ? 'ends' : 'end'} mid-turn`;

/**
 * The ask a launch onto a short box stops at (`launchShort`), or undefined when it has room:
 * Resize to the next size within `max` (recommended; short of memory only, a larger instance has
 * the same disk, which grows by itself), Launch anyway, Cancel.
 */
export const launchShortAsk = (
  load: BoxLoad,
  on: { box: string; size: string; max: string; workspaces: number; working: readonly string[] },
): BoxShortAsk | undefined => {
  const short = launchShort(load, on);

  if (short === undefined) return undefined;
  const to = short.short === 'memory' ? nextBoxSize(on.size, on.max) : null;

  return {
    box: on.box,
    ...short,
    resize: to,
    choices: [
      ...(to === null
        ? []
        : [
            {
              answer: 'resize' as const,
              label: `Resize to ${to}`,
              note: `stops the box ~2 min${ending(on.working)}`,
              recommended: true,
            },
          ]),
      {
        answer: 'anyway',
        label: 'Launch anyway',
        note:
          short.short === 'memory'
            ? 'they share memory; a build may be killed'
            : 'they share the disk; it grows by itself up to limits.maxBoxDisk',
      },
      { answer: 'cancel', label: 'Cancel' },
    ],
  };
};

/** The ask as a refusal's message, each answer with the flag that gives it. */
export const launchShortText = (ask: BoxShortAsk): string =>
  [
    ask.line,
    ...ask.choices.flatMap((c) =>
      c.answer === 'cancel'
        ? []
        : [`--short ${c.answer}: ${c.label}${c.note === undefined ? '' : ` (${c.note})`}`],
    ),
  ].join(' · ');

/**
 * What the root volume (EBS's own size, a little more than its filesystem's) grows to: by
 * `BOX_DISK_STEP_GB`, never past `maxGb`; undefined when it is there already.
 */
export const rootVolumeTarget = (volumeGb: number, maxGb: number): number | undefined =>
  volumeGb >= maxGb ? undefined : Math.min(maxGb, volumeGb + BOX_DISK_STEP_GB);

/**
 * Whether the box's root disk grows now, and to what: under `BOX_DISK_GROW_BELOW` free by
 * `BOX_DISK_STEP_GB`, never past `maxGb` (`limits.maxBoxDisk`), and not within
 * `BOX_DISK_EVERY_MS` of the last growth (AWS refuses it). Shown, never asked.
 */
export const diskGrowth = (
  load: BoxLoad,
  o: { maxGb: number; lastGrownAt: string | null; now: number },
): { toGb: number } | undefined => {
  const { freeGb, totalGb } = load.disk;
  const toGb = Math.min(o.maxGb, Math.ceil(totalGb) + BOX_DISK_STEP_GB);

  if (totalGb <= 0 || freeGb / totalGb >= BOX_DISK_GROW_BELOW || toGb <= totalGb) return undefined;
  if (o.lastGrownAt !== null && o.now - Date.parse(o.lastGrownAt) < BOX_DISK_EVERY_MS)
    return undefined;

  return { toGb };
};

/** The load as a line: `load: 1.4 GB memory free of 15.3 · CPU 15 % · disk 29 GB free of 60`. */
export const boxLoadText = (l: BoxLoad): string =>
  `load: ${tenth(l.memory.availableMb / 1024)} GB memory free of ${tenth(l.memory.totalMb / 1024)} · CPU ${l.cpuPercent} % · disk ${l.disk.freeGb} GB free of ${l.disk.totalGb}\n`;
