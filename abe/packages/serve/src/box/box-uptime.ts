/**
 * The Mac's uptime log of your boxes (#104), for today's cost: `<state>/box-uptime.jsonl`, one
 * line each time a box came up or went down as this `serve` saw it (its `box.state` moves, a
 * followed box's own, EC2's state at a list). A box first seen up is counted from its EC2
 * LaunchTime. Lines older than two days go when the log is opened (each box's last one before
 * kept: it says where the box stood).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type UptimeMove } from '@abe/core';
import { z } from 'zod';

const Line = z.object({ box: z.string(), up: z.boolean(), at: z.iso.datetime() });
type Line = z.infer<typeof Line>;

/** How long a line is kept. */
const KEEP_MS = 2 * 24 * 60 * 60_000;

export type UptimeLog = {
  /**
   * The box seen up or down at `at` (ms): a line when that is a move. Up after down (or first
   * seen) counts from `launchedAt` when EC2 said one since.
   */
  seen: (box: string, up: boolean, at: number, launchedAt?: string | null) => void;
  /** The box's moves, oldest first. */
  moves: (box: string) => UptimeMove[];
};

const readLines = (file: string): Line[] => {
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  return text.split('\n').flatMap((raw) => {
    if (raw.trim() === '') return [];
    try {
      const line = Line.safeParse(JSON.parse(raw));

      return line.success ? [line.data] : [];
    } catch {
      return [];
    }
  });
};

/** The log at `file` (null: kept in memory only), lines before `now` minus two days dropped. */
export const openUptimeLog = (file: string | null, now: number): UptimeLog => {
  const byBox = new Map<string, UptimeMove[]>();
  const cutoff = now - KEEP_MS;

  for (const line of file === null ? [] : readLines(file)) {
    const moves = byBox.get(line.box) ?? [];

    moves.push({ up: line.up, at: Date.parse(line.at) });
    byBox.set(line.box, moves);
  }
  for (const [box, moves] of byBox) {
    moves.sort((a, b) => a.at - b.at);
    const recent = moves.findIndex((m) => m.at >= cutoff);
    const from = recent === -1 ? moves.length - 1 : Math.max(0, recent - 1);

    byBox.set(box, moves.slice(from));
  }
  const lineOf = (box: string, m: UptimeMove) =>
    `${JSON.stringify({ box, up: m.up, at: new Date(m.at).toISOString() })}\n`;

  if (file !== null) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;

    writeFileSync(
      temp,
      [...byBox].flatMap(([box, moves]) => moves.map((m) => lineOf(box, m))).join(''),
    );
    renameSync(temp, file);
  }

  return {
    seen: (box, up, at, launchedAt) => {
      const moves = byBox.get(box) ?? [];
      const last = moves.at(-1);

      if ((last?.up ?? false) === up) return;
      const launched =
        launchedAt === null || launchedAt === undefined ? NaN : Date.parse(launchedAt);
      // Up since its LaunchTime, when that is after it was last seen down (else it is stale).
      const when =
        up && !Number.isNaN(launched) && launched <= at && launched >= (last?.at ?? -Infinity)
          ? launched
          : at;
      const move = { up, at: when };

      moves.push(move);
      byBox.set(box, moves);
      if (file !== null) appendFileSync(file, lineOf(box, move));
    },
    moves: (box) => [...(byBox.get(box) ?? [])],
  };
};
