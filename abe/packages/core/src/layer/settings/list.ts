/**
 * `abe settings list` (#108): every row of the Settings dialog with the value in effect and where
 * it comes from, as the dialog draws it: the value first, the source line under it (`built-in` ·
 * `yours` for an editor preference; `Repo` · `Yours` for a factory setting, ADR 0030), both sides
 * when yours differs from what the repo gives, choices greyed with why, and a slot for the open
 * pull request that proposes it (filled by `settings propose`, #108 S3).
 *
 * Values are the settings' own: none holds a secret (an environment's database names its
 * Secrets Manager id, never the value).
 */
import { z } from 'zod';
import { BOX_SIZES, boxSizeRank } from '../../box/box-sizes';
import { allows } from '../../skills/subagents';
import { LayerName, SettingProblem, SettingValue } from './contract';
import {
  type Feel,
  FEEL_WORDS,
  isMachineSetting,
  type Layer,
  SettingKeyName,
  type SettingKey,
} from './keys';
import { type Merged } from './layers';
import { CONTROLS, homeRows, PAGE_IDS, pageOf, type SettingRow } from './pages';
import { defaultOf, INPUTS, itemInputOf, SETTING_SCOPES, scopeOfKey } from './input';

export const SOURCE_KINDS = [
  'built-in',
  /** Your Feel's bundle gives it (#174): `from Feel VS Code`. */
  'feel',
  'yours',
  'repo',
  'fixed',
] as const;

export const RowSource = z.object({
  kind: z.enum(SOURCE_KINDS),
  /** The Layer the value comes from (`null` for a fixed row). */
  layer: LayerName.nullable(),
  /** The source line as drawn: `Repo`, `Yours`, `yours`, `built-in`. */
  text: z.string(),
});
export type RowSource = z.infer<typeof RowSource>;

export const ListedRow = z.object({
  id: z.string(),
  page: z.enum(PAGE_IDS),
  key: SettingKeyName.nullable(),
  field: z.string().nullable(),
  label: z.string(),
  control: z.enum(CONTROLS),
  /** The value in effect (a field row: that field's; `null`: not set). */
  value: SettingValue.nullable(),
  /** The value as a row shows it: `on`, `opus, sonnet`, `—` when not set. */
  shown: z.string(),
  source: RowSource,
  /** Yours differs from what the Layers above give: their value and the line saying both. */
  differs: z
    .object({ layer: LayerName, value: SettingValue.nullable(), text: z.string() })
    .nullable(),
  /** An Override in force: `overridden by repo: seeds only`. */
  lowered: z.string().nullable(),
  /** ⏎ changes nothing here: why. */
  fixed: z.object({ by: z.enum(['built-in']), why: z.string() }).nullable(),
  /** A combo's choices, when known (`null`: free text or listed by the dialog). */
  choices: z.array(z.string()).nullable(),
  /** Choices shown greyed, each with why (`not in the repo's allowedModels`). */
  greyed: z.array(z.object({ choice: z.string(), why: z.string() })),
  personalOnly: z.boolean(),
  /** Where a change of yours goes: `repo`, `yours` (this Mac), `local` (yours for this repo). */
  scope: z.enum(SETTING_SCOPES).nullable(),
  /** The built-in value in words (`none`, `30`), as the row says its default. */
  default: z.string().nullable(),
  /** A list's items' input (`number` for ports), else `null`. */
  item: z.enum(INPUTS).nullable(),
  /** What is wrong with this setting in a settings file. */
  problems: z.array(SettingProblem),
  /** The open pull request proposing it for the repo (#108 S3, #175). */
  prs: z.array(z.object({ number: z.number().int().positive(), url: z.string() })),
});
export type ListedRow = z.infer<typeof ListedRow>;

/** A row's open proposals as words: `PR #1 open`, `PRs #1, #2 open`; empty for none. */
export const prsText = (prs: ListedRow['prs']): string =>
  prs.length === 0
    ? ''
    : `${prs.length === 1 ? 'PR' : 'PRs'} ${prs.map((p) => `#${p.number}`).join(', ')} open`;

export const SettingsScope = z.object({
  /** The checkout's repo: its GitHub name (`acme/shop`) where known, else its folder's; `null` outside one. */
  repo: z.string().nullable(),
  /** The page header's dim scope: `acme/shop`, `no checkout`. */
  text: z.string(),
});
export type SettingsScope = z.infer<typeof SettingsScope>;

export const SettingsListData = z.object({ scope: SettingsScope, rows: z.array(ListedRow) });
export type SettingsListData = z.infer<typeof SettingsListData>;

export const scopeOf = (repo: string | null): SettingsScope => ({
  repo,
  text: repo ?? 'no checkout',
});

/**
 * The scope of a merge: the repo whose `abe.yaml` it read, `github` (its GitHub name,
 * #175) when given, else its folder's name.
 */
export const settingsScope = (merged: Merged, github?: string): SettingsScope => {
  const file = merged.explain('checks').layers.find((l) => l.layer === 'repo')?.file ?? null;
  const folder = file === null ? null : (file.split('/').at(-2) ?? null);

  return scopeOf(folder === null ? null : (github ?? folder));
};

/**
 * A value as a sentence says it (#325): a choice's words, what no value means here (`no limit`,
 * else `none`), else as a row shows it; never `—`.
 */
export const valueWords = (row: Pick<SettingRow, 'words' | 'none'>, v: unknown): string => {
  const shown = shownValue(v);

  if (shown === '—') return row.none ?? 'none';

  return typeof v === 'string' ? (row.words?.[v] ?? shown) : shown;
};

/** A value as a row shows it. */
export const shownValue = (v: unknown): string => {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v === '' ? '—' : v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(shownValue).join(', ');
  if (isRecord(v)) {
    const parts = Object.entries(v).map(([k, x]) => `${k}: ${shownValue(x)}`);

    return parts.length === 0 ? '—' : parts.join('; ');
  }

  return JSON.stringify(v);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const json = (v: unknown) => {
  const read = SettingValue.safeParse(v);

  return read.success ? read.data : null;
};

const fieldOf = (v: unknown, field: string | null): unknown => {
  if (field === null) return v;

  return isRecord(v) ? v[field] : undefined;
};

/** The Layer a row's value comes from: the key's winner, or the last Layer that wrote its field. */
const layerOf = (merged: Merged, key: SettingKey, field: string | null): Layer => {
  const explained = merged.explain(key);

  if (field === null) return explained.winner;
  const wrote = explained.layers.filter(
    (s) => s.applied && isRecord(s.written) && Object.hasOwn(s.written, field),
  );

  return wrote.at(-1)?.layer ?? 'core';
};

/** Whose words a source line uses: the checkout, and the Feel in force. */
type Names = { scope: SettingsScope; feel: Feel };

const named = (layer: Layer, { feel }: Names) => {
  switch (layer) {
    case 'core':
      return 'built-in';
    case 'feel':
      return `Feel ${FEEL_WORDS[feel]}`;
    case 'repo':
      return 'the repo';
    case 'individual':
      return 'you';
  }
};

/**
 * A row's source line: a factory setting's `Repo` or `Yours` (ADR 0030), an editor preference's
 * `yours`, else `built-in` or the Feel.
 */
const sourceOf = (layer: Layer, names: Names, key: SettingKey | null): RowSource => {
  const factory = key !== null && !isMachineSetting(key);

  switch (layer) {
    case 'core':
      return { kind: 'built-in', layer, text: 'built-in' };
    case 'feel':
      return { kind: 'feel', layer, text: `from ${named(layer, names)}` };
    case 'individual':
      return { kind: 'yours', layer, text: factory ? 'Yours' : 'yours' };
    case 'repo':
      return { kind: 'repo', layer, text: 'Repo' };
  }
};

/** Whose list it is, as a why says it: `the repo's`, `your`. */
const owner = (layer: Layer, names: Names) => {
  if (layer === 'core') return 'the default';

  return layer === 'individual' ? 'your' : `${named(layer, names)}'s`;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const MODEL_KEYS: ReadonlySet<SettingKey> = new Set([
  'models.coordinator',
  'models.reader',
  'models.writer',
  'prototype.model',
]);

/**
 * What serve knows on this Mac that a combo offers (`ChoiceSource`): your gh logins, your AWS
 * profiles (names only) and the regions they name. Names only, never a token.
 */
export const KnownChoices = z.object({
  gh: z.array(z.string()).optional(),
  awsProfiles: z.array(z.string()).optional(),
  awsRegions: z.array(z.string()).optional(),
});
export type KnownChoices = z.infer<typeof KnownChoices>;

/** AWS's regions, offered with the ones your profiles name. */
export const AWS_REGIONS = [
  'eu-north-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-south-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-south-1',
  'sa-east-1',
] as const;

type Ctx = Names & { merged: Merged; upper: Merged; known: KnownChoices };

/** The values each Layer writes for a row (`board`'s `organization` in the repo's and yours). */
const layerValues = (merged: Merged, key: SettingKey, field: string | null): string[] =>
  merged
    .explain(key)
    .layers.map((l) => fieldOf(l.written, field))
    .filter((v): v is string => typeof v === 'string' && v !== '');

const nameOf = (x: unknown): string[] => {
  if (typeof x === 'string') return [x];

  return isRecord(x) && typeof x.name === 'string' ? [x.name] : [];
};

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x: unknown) => nameOf(x)) : [];

/** A row's known choices (`ChoiceSource`): serve's, or the settings in force. */
const knownOf = (row: SettingRow, c: Ctx): string[] => {
  const values = c.merged.values;

  switch (row.known) {
    case null:
      return [];
    case 'gh-accounts':
      return c.known.gh ?? [];
    case 'aws-profiles':
      return c.known.awsProfiles ?? [];
    case 'aws-regions':
      return [...(c.known.awsRegions ?? []), ...AWS_REGIONS];
    case 'environments':
      return [...Object.keys(values.environments), ...values.prodEnvironments];
    case 'azure-orgs':
      return row.key === null ? [] : layerValues(c.merged, row.key, row.field);
    case 'browser-profiles':
      return names(values['browser.profiles']);
  }
};

/**
 * A combo's choices: its own, what serve knows (`known`) and the value in force (a free combo's
 * name typed earlier), once each; a model combo offers allowedModels' too.
 */
const choicesOf = (row: SettingRow, value: unknown, c: Ctx): string[] | null => {
  const values = c.merged.values;

  if (row.choices === null && row.known === null && !row.free) return null;
  const own = row.choices ?? [];
  const models =
    row.key !== null && (MODEL_KEYS.has(row.key) || row.key === 'allowedModels')
      ? values.allowedModels
      : [];
  const current = row.free && typeof value === 'string' && value !== '' ? [value] : [];

  return [...new Set([...own, ...models, ...knownOf(row, c), ...current])];
};

/** Choices a Layer above leaves out: a model outside allowedModels, a box over the largest one above yours. */
const greyedOf = (row: SettingRow, choices: readonly string[] | null, c: Ctx) => {
  if (row.key === null || choices === null) return [];
  if (MODEL_KEYS.has(row.key)) {
    const allowed = c.merged.values.allowedModels;
    const whose = owner(c.merged.explain('allowedModels').winner, c);

    return choices
      .filter((m) => !allows(allowed, m))
      .map((choice) => ({ choice, why: `not in ${whose} allowedModels` }));
  }
  if (row.key === 'limits.maxBoxSize') {
    const above = c.upper.values['limits.maxBoxSize'];
    const whose = owner(c.upper.explain('limits.maxBoxSize').winner, c);

    return BOX_SIZES.filter((s) => boxSizeRank(s) > boxSizeRank(above)).map((choice) => ({
      choice,
      why: `larger than ${whose} largest box, ${above}`,
    }));
  }

  return [];
};

const fixedRow = (row: SettingRow, fixed: NonNullable<SettingRow['fixed']>): ListedRow => ({
  id: row.id,
  page: row.page,
  key: null,
  field: null,
  label: row.label,
  control: row.control,
  value: fixed.value,
  shown: fixed.value,
  source: { kind: 'fixed', layer: null, text: 'built-in · fixed' },
  differs: null,
  lowered: null,
  fixed: { by: fixed.by, why: fixed.why },
  choices: null,
  greyed: [],
  personalOnly: false,
  scope: null,
  default: null,
  item: null,
  problems: [],
  prs: [],
});

const settingRow = (row: SettingRow, key: SettingKey, c: Ctx): ListedRow => {
  const value = fieldOf(c.merged.values[key], row.field);
  const layer = layerOf(c.merged, key, row.field);
  const yours = sourceOf('individual', c, key).text;
  const explained = c.merged.explain(key);
  const above = fieldOf(c.upper.values[key], row.field);
  const aboveLayer = layerOf(c.upper, key, row.field);
  const choices = choicesOf(row, value, c);

  return {
    id: row.id,
    page: row.page,
    key,
    field: row.field,
    label: row.label,
    control: row.control,
    value: json(value),
    shown: shownValue(value),
    source: sourceOf(layer, c, key),
    differs:
      layer === 'individual' && !same(value, above)
        ? {
            layer: aboveLayer,
            value: json(above),
            // the built-in value as the default, never `built-in` on a source line (#345)
            text:
              aboveLayer === 'core'
                ? `${yours} · the default is ${valueWords(row, above)}`
                : `${yours} · ${named(aboveLayer, c)} has ${valueWords(row, above)}`,
          }
        : null,
    lowered: explained.lowered,
    fixed: null,
    choices,
    greyed: greyedOf(row, choices, c),
    personalOnly: row.personalOnly,
    scope: scopeOfKey(key),
    default: valueWords(row, defaultOf(key, row.field)),
    item: itemInputOf(key, row.field) ?? null,
    problems: c.merged.problems.filter((p) => p.key === key),
    prs: [],
  };
};

/**
 * Every row with a setting or a fixed value (tables filled from elsewhere are left out), in tree
 * order, from `merged`, the settings in force; the same merge without your Layer says what the
 * Layers above give when yours differs. `github`: the checkout repo's GitHub name, for its scope (#175);
 * `known`: what serve knows on this Mac that a combo offers.
 */
export const listSettings = (
  merged: Merged,
  github?: string,
  known: KnownChoices = {},
): SettingsListData => {
  const c: Ctx = {
    merged,
    known,
    upper: merged.without('individual'),
    scope: settingsScope(merged, github),
    feel: merged.values['ui.feel'],
  };

  return {
    scope: c.scope,
    rows: homeRows().flatMap((row) => {
      if (row.fixed !== null) return [fixedRow(row, row.fixed)];
      if (row.key === null) return [];

      return [settingRow(row, row.key, c)];
    }),
  };
};

export const settingsListText = (d: SettingsListData): string => {
  const lines: string[] = [`scope: ${d.scope.text}`];
  let page: string | undefined;

  for (const r of d.rows) {
    if (r.page !== page) {
      page = r.page;
      lines.push(pageOf(r.page).crumb);
    }
    const more = [
      r.differs?.text ?? r.source.text,
      r.lowered ?? '',
      r.greyed.length === 0 ? '' : r.greyed.map((g) => `${g.choice} greyed, ${g.why}`).join('; '),
      prsText(r.prs),
    ].filter((w) => w !== '');

    lines.push(`  ${r.label}: ${r.shown}  (${more.join(' · ')})`);
  }

  return `${lines.join('\n')}\n`;
};
