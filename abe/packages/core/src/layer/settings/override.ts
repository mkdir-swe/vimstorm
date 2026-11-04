/**
 * The Override rule (ADR 0010): a lower Layer lowers an upper default only by an explicit
 * Override with a non-empty reason; one without a reason is refused where it is written, so it
 * never takes effect. Settings and Reach both read Overrides through these.
 */
import { z } from 'zod';
import type { Layer } from './keys';

/**
 * An Override as written in a layer file: `overrides: { <key>: { value, reason, since } }`; `since`
 * (an ISO time, #168) is when `abe settings set` / `propose` wrote it.
 */
export const OverrideEntry = z.strictObject({
  value: z.unknown(),
  reason: z.unknown().optional(),
  since: z.unknown().optional(),
});

export type Override<T> = { value: T; reason: string };

/** The reason, trimmed, when it is a non-empty string; else `undefined` (refused). */
export const overrideReason = (reason: unknown): string | undefined => {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();

  return trimmed === '' ? undefined : trimmed;
};

/** `since` as kept: an ISO time, or `null` (none, or no time: left out, the Override still applies). */
const sinceOf = (since: unknown): string | null => {
  const read = z.iso.datetime().safeParse(since);

  return read.success ? read.data : null;
};

export type OverrideRead =
  | { ok: true; value: unknown; reason: string; since: string | null }
  | { ok: false; code: 'reason-required' | 'invalid-override'; message: string };

/** One `overrides` entry for `key` read: refused without a reason, never applied half-way. */
export const readOverride = (raw: unknown, key: string): OverrideRead => {
  const entry = OverrideEntry.safeParse(raw);

  if (!entry.success)
    return {
      ok: false,
      code: 'invalid-override',
      message: 'an Override is { value, reason }',
    };
  const reason = overrideReason(entry.data.reason);

  if (reason === undefined)
    return {
      ok: false,
      code: 'reason-required',
      message: `an Override of ${key} needs a non-empty reason`,
    };

  return { ok: true, value: entry.data.value, reason, since: sinceOf(entry.data.since) };
};

/**
 * How an Override in force is shown: `overridden by individual: me · since 2026-10-24`; never
 * "lowered", which read as the value made smaller when an Override raised it (#320).
 */
export const loweredText = (layer: Layer, reason: string, since: string | null = null): string =>
  `overridden by ${layer}: ${reason}${since === null ? '' : ` · since ${since.slice(0, 10)}`}`;

/** A word for a shell line: as it is when plain, else single-quoted. */
export const shellArg = (text: string): string =>
  /^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** A value as `abe settings propose` takes it on a shell line: YAML flow, quoted when it must be. */
const typedValue = (value: unknown): string => {
  const item = (v: unknown): string => {
    if (typeof v === 'string' && /^[\w./-]+$/.test(v)) return v;

    return Array.isArray(v) ? `[${v.map(item).join(', ')}]` : JSON.stringify(v);
  };

  return shellArg(item(value));
};

/**
 * The command that proposes `key` as `value` to the repo, suggested beside a personal Override
 * (#168: never required); `reason` the Override's, else a placeholder.
 */
export const proposeCommand = (key: string, value: unknown, reason?: string): string =>
  `abe settings propose ${key} ${typedValue(value)} --reason ${reason === undefined ? '"<why>"' : shellArg(reason)}`;
