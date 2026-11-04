/** Building import rows: a value checked against its setting's schema, or `no match here`. */
import { SettingValue } from '../layer/settings/contract';
import { feelBundle } from '../layer/settings/feel';
import { FEEL_WORDS, FEELS, type SettingKey, SettingsSchema } from '../layer/settings/keys';
import { type ImportRow } from './contract';

export const NO_MATCH = 'no match here';

/** A row that maps onto `key`; a value the setting does not take is no match, with why. */
export const mapped = (
  id: string,
  group: ImportRow['group'],
  from: string,
  key: SettingKey,
  value: unknown,
  note: string | null = null,
): ImportRow => {
  const read = SettingsSchema.shape[key].safeParse(value);
  const json = SettingValue.safeParse(read.data);

  if (!read.success || !json.success)
    return unmatched(id, group, from, `${key} takes no ${sourceText(value)}`);

  return {
    id,
    group,
    from: clip(from, FROM),
    to: { key, value: json.data },
    bind: null,
    note,
    ticked: true,
  };
};

/** A row with nothing here to become: shown dim, never ticked. */
export const unmatched = (
  id: string,
  group: ImportRow['group'],
  from: string,
  note: string = NO_MATCH,
): ImportRow => ({ id, group, from: clip(from, FROM), to: null, bind: null, note, ticked: false });

/** How `--only` names a key binding's row: `key:<the key>`, `key:⌘Y` (#129). */
export const onlyKeyName = (key: string): string => `key:${key}`;

/**
 * `--only`'s names, comma separated; a comma right after a modifier or `key:` is a key's own
 * (`key:⌘,`).
 */
export const onlyNames = (text: string): string[] =>
  text
    .split(/(?<![⌃⌥⇧⌘:]),/)
    .map((k) => k.trim())
    .filter((k) => k !== '');

/** What a ticked row writes, one per setting or key: a later row of the same wins. */
const targetOf = (r: ImportRow): string | undefined => {
  if (r.to !== null) return r.to.key;

  return r.bind === null ? undefined : `key ${r.bind.key}`;
};

/**
 * The rows as imported: ticked only where `only` names their setting or their key binding's
 * key (`key:⌘Y`; no `only`: all that map), and where two ticked rows set one setting or
 * bind one key the later wins (as in the source's own file), the earlier unticked.
 */
export const onlyRows = (rows: readonly ImportRow[], only: readonly string[] | undefined) => {
  const named = rows.map((r) => {
    if (only === undefined) return r;
    const name = r.to?.key ?? (r.bind === null ? undefined : onlyKeyName(r.bind.key));

    return { ...r, ticked: r.ticked && name !== undefined && only.includes(name) };
  });
  const last = new Map<string, number>();

  named.forEach((r, i) => {
    const target = targetOf(r);

    if (r.ticked && target !== undefined) last.set(target, i);
  });

  return named.map((r, i) => {
    const target = targetOf(r);

    return r.ticked && target !== undefined && last.get(target) !== i
      ? {
          ...r,
          ticked: false,
          note: r.to === null ? 'a later one binds it' : 'a later one sets it',
        }
      : r;
  });
};

/** The most of a source's value a row shows (a 30 MB string is not echoed). */
const SHOWN = 60;

/** The most of a source's line a row shows. */
const FROM = 120;

/** A text cut to `max` characters, `…` where it was cut. */
export const clip = (s: string, max: number = SHOWN): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** A value as the source's JSON writes it, cut where long. */
export const sourceText = (v: unknown): string => clip(JSON.stringify(v));

/** A rounded number's note: `rounded from 13.5`, none when it was whole. */
export const roundedNote = (n: number): string | null =>
  Number.isInteger(n) || !Number.isFinite(n) ? null : `rounded from ${n}`;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The rows a picked Feel already gives (#171): a ticked row of a key the Feel sets, with the
 * Feel's own value, is not ticked, so a later Feel switch moves it as `settings feel` promises.
 * It stays ticked where `--only` names its key, or where something else is in force there
 * (`inForce`: the merged value without the row, the Feel picked; a Layer's, yours too).
 */
export const feelRows = (
  rows: readonly ImportRow[],
  only: readonly string[] | undefined,
  inForce: (key: SettingKey) => unknown,
): ImportRow[] => {
  const feel = FEELS.find((f) =>
    rows.some((r) => r.ticked && r.to?.key === 'ui.feel' && r.to.value === f),
  );

  if (feel === undefined) return [...rows];
  const bundle: Readonly<Record<string, unknown>> = feelBundle(feel);

  return rows.map((r) => {
    if (!r.ticked || r.to === null || r.to.key === 'ui.feel' || only?.includes(r.to.key)) return r;
    const { key, value } = r.to;

    if (!(key in bundle) || !same(bundle[key], value)) return r;
    const forced = inForce(key);

    if (forced !== undefined && !same(forced, value)) return r;
    const note = `the Feel ${FEEL_WORDS[feel]} gives it`;

    return { ...r, ticked: false, note: r.note === null ? note : `${r.note} · ${note}` };
  });
};
