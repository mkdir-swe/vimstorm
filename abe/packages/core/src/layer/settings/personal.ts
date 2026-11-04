/**
 * Your Overrides (#168): every setting takes one in your own Layer, with its reason (intent) and
 * shown wherever it acts (visibility): `settings explain` / `list`, an info row on Problems, the
 * Chat header's pill and the story's Session row for a run launched under it. Proposing it to the
 * repo is suggested, never required.
 */
import { z } from 'zod';
import { SettingValue } from './contract';
import { SettingKeyName, settingKeys } from './keys';
import { type Merged } from './layers';
import { shownValue } from './list';

/** One Override in force from your own Layer: the key, its value (as written and as a row shows it), why, since when. */
export const PersonalOverride = z.object({
  key: SettingKeyName,
  value: SettingValue,
  shown: z.string(),
  reason: z.string(),
  /** An ISO time; `null` when its file does not say (written before #168, or by hand). */
  since: z.string().nullable(),
});
export type PersonalOverride = z.infer<typeof PersonalOverride>;

/** The Overrides your own Layer has in force in a merge, in the settings' order. */
export const personalOverrides = (merged: Merged): PersonalOverride[] =>
  settingKeys().flatMap((key) => {
    const step = merged
      .explain(key)
      .layers.find((s) => s.layer === 'individual' && s.entry === 'override' && s.applied);

    if (step === undefined) return [];

    return [
      {
        key,
        value: step.written,
        shown: shownValue(step.written),
        reason: step.reason ?? '',
        since: step.since ?? null,
      },
    ];
  });

/** The pill's words: `Override · autoMerge on`, `+N` for the rest. */
export const overridePill = (overrides: readonly PersonalOverride[]): string | undefined => {
  const [first, ...rest] = overrides;

  if (first === undefined) return undefined;

  return `Override · ${first.key} ${first.shown}${rest.length === 0 ? '' : ` · +${rest.length}`}`;
};

/** One Override for a tooltip or a list: `autoMerge on — my sandbox (since 2026-10-24)`. */
export const overrideWords = (o: PersonalOverride): string =>
  `${o.key} ${o.shown} — ${o.reason}${o.since === null ? '' : ` (since ${o.since.slice(0, 10)})`}`;

const mapOf = (doc: unknown): Record<string, unknown> =>
  typeof doc === 'object' && doc !== null && !Array.isArray(doc)
    ? Object.fromEntries(Object.entries(doc))
    : {};

/**
 * Yours for this repo that is this Mac's alone (ADR 0027): its env files and aws profiles, its
 * TEST yes, its az folder. Never handed to a box.
 */
const MAC_ONLY: readonly string[] = ['credentials', 'testWrites'];

/** `doc` without `keys`, plain or as Overrides, and without `board`'s az folder. */
const handedPart = (doc: unknown, keys: readonly string[]): Record<string, unknown> => {
  const { overrides, ...rest } = mapOf(doc);
  const kept = Object.fromEntries(Object.entries(rest).filter(([k]) => !keys.includes(k)));
  const board = mapOf(kept.board);
  const out =
    kept.board === undefined
      ? kept
      : {
          ...kept,
          board: Object.fromEntries(Object.entries(board).filter(([k]) => k !== 'azureConfigDir')),
        };
  const own = Object.fromEntries(
    Object.entries(mapOf(overrides)).filter(([k]) => !keys.includes(k)),
  );

  return overrides === undefined ? out : { ...out, overrides: own };
};

/** Your two files as a cloud launch hands them to the box (#222, ADR 0030). */
export const HandedLayer = z.object({
  machine: z.record(z.string(), z.unknown()),
  local: z.record(z.string(), z.unknown()),
});
export type HandedLayer = z.infer<typeof HandedLayer>;

/**
 * Yours as a cloud launch hands it to the box (#222): your file on this Mac, and yours for the
 * repo launched from but what is this Mac's alone (its env files, TEST yes, az folder).
 */
export const handedLayer = (machine: unknown, local: unknown): HandedLayer => ({
  machine: handedPart(machine, []),
  local: handedPart(local, MAC_ONLY),
});
