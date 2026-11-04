/**
 * The rules the Settings dialog's screen (`ui/src/settings/settings.ts`, #108) takes from core. `ui` may
 * import only types from core, so the bridge hands these in (`settingsLayer(settingsDialogRules(…))`):
 * the catalogue, `/`'s matcher, how a typed value reads (as `abe settings set` reads it) and
 * whether writing it in your Layer needs a 2.0 Layer Override.
 */
import { z } from 'zod';
import { readValue } from './edit';
import { feelBundle } from './feel';
import { SCHEME_GROUPS, type ThemeToken } from '../../theme/theme';
import { isKeymapAction, KEYMAP_ACTIONS } from '../../theme/keymap';
import { FEELS, type SettingKey, SETTINGS, type SettingDef } from './keys';
import { type ListedRow, type SettingsScope, shownValue } from './list';
import { checkItems } from './logins-tools';
import {
  openPage,
  pageOf,
  type PageId,
  SETTINGS_TREE,
  type SettingsPage,
  type TreeNode,
} from './pages';
import { PROPOSAL_PATH } from './places';
import { type RecordsDef, recordsOf } from './records';
import { type ProposeOffer, rowOffer } from './propose';
import {
  noMatch,
  pagesCorpus,
  searchSettings,
  searchSummary,
  settingsCorpus,
  tokensCorpus,
  type SearchHits,
} from './search';

/** A value read from what was typed, or why it is not one. */
export type TypedValue = { ok: true; value: unknown } | { ok: false; message: string };

export type SettingsDialogRules = {
  readonly tree: readonly TreeNode[];
  readonly page: (id: PageId) => SettingsPage;
  /** The page a tree node opens: its own, else its first child's. */
  readonly opens: (node: string) => PageId | undefined;
  /** `/` over every page and the pages' names; `values` gives each row's value as shown, by row id. */
  /** `/`: the pages, the settings (their values as shown) and the Colours tokens when read (#345). */
  readonly search: (
    query: string,
    values: ReadonlyMap<string, string>,
    tokens?: readonly ThemeToken[],
  ) => SearchHits;
  readonly summary: (hits: SearchHits) => string;
  readonly noMatch: (query: string) => { text: string; hint: string };
  /**
   * `typed` as `abe settings set <key> <typed>` reads it (YAML, else the text); with `field`, as
   * that field of an object setting (`board`'s `done`): the field's value.
   */
  readonly read: (key: SettingKey, typed: string, field?: string) => TypedValue;
  /** A value as a row shows it (`on`, `opus, sonnet`, `—`). */
  readonly shown: (value: unknown) => string;
  /**
   * Why writing `written` in your Layer over `above` (the Layers above yours) needs an Override,
   * or `undefined` when a plain entry may.
   */
  readonly needsOverride: (key: SettingKey, above: unknown, written: unknown) => string | undefined;
  /** ⌘⏎ (#108 S3): where a row may be proposed (`abe settings propose`'s own rule), or why not. */
  readonly offer: (row: ListedRow, scope: SettingsScope) => ProposeOffer;
  /** The file a proposal changes, from the repo's root: `abe.yaml`. */
  readonly proposalPath: string;
  /** Logins & tools' rows (S6) from `abe login status` and `abe tools check`. */
  readonly checks: typeof checkItems;
  /**
   * The values a Feel gives the keys no Layer writes (#300: a Feel staged shows its theme and
   * switches before OK); nothing for a name that is no Feel.
   */
  readonly feelBrings: (feel: string) => Readonly<Partial<Record<SettingKey, unknown>>>;
  /** The token groups an editor scheme gives (#345): Colours shows only these for a named one. */
  readonly schemeGroups: readonly string[];
  /** A Keymap action by its title (`Go to File`), as Import config says where a key goes (#325). */
  readonly actionTitle: (action: string) => string;
  /** A records setting's columns and rows (`views`, `environments`), else `undefined`. */
  readonly records: (key: SettingKey) => RecordsDef | undefined;
};

const fieldOf = (v: unknown, field: string): unknown =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.entries(v).find(([k]) => k === field)?.[1]
    : undefined;

const defOf = (key: SettingKey): SettingDef<unknown> => SETTINGS[key];

/** zod's bounds when none is set (`.int()` puts the safe integers' as its own). */
const unbounded = (n: number | null) => n === null || Math.abs(n) >= Number.MAX_SAFE_INTEGER;

/**
 * What a number setting takes, in words (#298): `a whole number from 320 to 640`, `, or empty`
 * when empty is no value (`tabs.limit`'s no limit); `undefined` for any other schema.
 */
export const numberWords = (schema: z.ZodType): string | undefined => {
  const inner =
    schema instanceof z.ZodNullable || schema instanceof z.ZodOptional ? schema.unwrap() : schema;

  if (!(inner instanceof z.ZodNumber)) return undefined;
  const whole = inner.format === 'safeint' || inner.format === 'int32';
  const lo = unbounded(inner.minValue) ? undefined : (inner.minValue ?? undefined);
  const hi = unbounded(inner.maxValue) ? undefined : (inner.maxValue ?? undefined);
  // an exclusive bound (`positive()`): the next whole number, or `more than`
  const from = bound(inner, lo, whole ? 1 : undefined, 'more than');
  const to = bound(inner, hi, whole ? -1 : undefined, 'less than');
  const empty = schema.safeParse(null).success ? ', or empty' : '';

  return `${whole ? 'a whole number' : 'a number'}${rangeWords(from, to)}${empty}`;
};

/** A bound as taken: itself, the next whole number past an exclusive one, or `more than n`. */
const bound = (
  n: z.ZodNumber,
  at: number | undefined,
  step: number | undefined,
  words: string,
): number | string | undefined => {
  if (at === undefined || n.safeParse(at).success) return at;

  return step === undefined ? `${words} ${at}` : at + step;
};

const rangeWords = (from: number | string | undefined, to: number | string | undefined) => {
  if (typeof from === 'number' && typeof to === 'number') return ` from ${from} to ${to}`;
  const parts = [
    typeof from === 'number' ? `of ${from} or more` : from,
    typeof to === 'number' ? `up to ${to}` : to,
  ].filter((p) => p !== undefined);

  return parts.length === 0 ? '' : ` ${parts.join(', ')}`;
};

/** The rules, with the YAML reader the caller has (`parseYaml` of `@abe/ports`). */
export const settingsDialogRules = (
  parseYaml: (text: string) => { doc: unknown } | { error: string },
): SettingsDialogRules => ({
  tree: SETTINGS_TREE,
  page: pageOf,
  opens: openPage,
  search: (query, values, tokens = []) =>
    searchSettings(query, [pagesCorpus(), settingsCorpus(new Map(values)), tokensCorpus(tokens)]),
  summary: searchSummary,
  noMatch,
  read: (key, typed, field) => {
    const schema = defOf(key).schema;

    // empty is no value where the setting takes none (`tabs.limit`: no limit, #298)
    if (field === undefined && typed.trim() === '' && schema.safeParse(null).success)
      return { ok: true, value: null };
    const parsed = parseYaml(typed);
    const doc = 'doc' in parsed ? parsed.doc : typed;

    if (field === undefined) {
      const read = readValue(key, doc, typed);
      const words = read.ok ? undefined : numberWords(schema);

      return words === undefined ? read : { ok: false, message: `Needs ${words}` };
    }
    // a field alone: its YAML reading when the object takes it, else the text
    const asDoc = readValue(key, { [field]: doc }, typed);
    const read = asDoc.ok ? asDoc : readValue(key, { [field]: typed }, typed);

    return read.ok ? { ok: true, value: fieldOf(read.value, field) } : read;
  },
  shown: shownValue,
  needsOverride: (key, above, written) => {
    const def = defOf(key);
    const guard = def.guard;

    if (guard === undefined) return undefined;

    return guard.needs(above, def.add(above, written), written);
  },
  offer: rowOffer,
  checks: checkItems,
  feelBrings: (feel) => {
    const known = FEELS.find((f) => f === feel);

    return known === undefined ? {} : feelBundle(known);
  },
  schemeGroups: SCHEME_GROUPS,
  actionTitle: (action) => (isKeymapAction(action) ? KEYMAP_ACTIONS[action].title : action),
  proposalPath: PROPOSAL_PATH,
  records: recordsOf,
});
