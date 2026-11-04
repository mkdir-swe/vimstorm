/**
 * `abe settings propose` (#108 S3): a setting proposed for the repo as one pull request on its
 * GitHub repo (`LayerPulls`), never staged and never written here (ADR 0030: the repo's
 * `abe.yaml`). The rules as pure functions: whether a setting is offered, the value a
 * field row proposes, the pull request's words, and the open pull requests on rows.
 */
import { z } from 'zod';
import { isMachineSetting, isMineSetting, SettingKeyName, type SettingKey, SETTINGS } from './keys';
import { OVERRIDES } from './layers';
import { type ListedRow, type SettingsListData } from './list';
import { type ValueRead } from './edit';
import { proposalBranch } from './places';

/** What a row yours alone says instead of ⌘⏎ (dim), and `propose`'s refusal. */
export const YOURS_ALONE = 'yours alone: not for the repo';

export type ProposeOffer =
  { ok: true } | { ok: false; code: 'personal-only' | 'fixed' | 'no-target'; message: string };

/**
 * Whether a setting may be proposed for the repo: a factory setting, in a checkout. A key that is
 * yours alone (for this repo, or on this Mac) is not offered.
 */
export const proposeOffer = (o: {
  key: SettingKey;
  /** The checkout's repo, or `null` outside one. */
  repo: string | null;
}): ProposeOffer => {
  if (isMineSetting(o.key) || isMachineSetting(o.key))
    return { ok: false, code: 'personal-only', message: YOURS_ALONE };
  if (o.repo === null)
    return { ok: false, code: 'no-target', message: 'no repo: work in a checkout' };

  return { ok: true };
};

/** A row's offer, from what `settings list` says of it. */
export const rowOffer = (row: ListedRow, scope: SettingsListData['scope']): ProposeOffer =>
  row.key === null
    ? { ok: false, code: 'fixed', message: 'fixed: no setting to propose' }
    : proposeOffer({ key: row.key, repo: scope.repo });

/** One field of an object setting's value (`undefined`: none); the whole value for no field. */
export const fieldValue = (v: unknown, field: string | null): unknown => {
  if (field === null) return v;

  return isRecord(v) ? v[field] : undefined;
};

/** What a proposal is named by in its branch: the key, `<key>.<field>` for a field row. */
export const proposalName = (key: SettingKey, field: string | null): string =>
  field === null ? key : `${key}.${field}`;

/** A `<key>` or `<key>#<field>` as typed (a row's id). */
export const readProposalKey = (
  typed: string,
): { key: SettingKey; field: string | null } | undefined => {
  const [name = '', field, ...rest] = typed.split('#');
  const key = SettingKeyName.safeParse(name);

  if (!key.success || rest.length > 0 || field === '') return undefined;

  return { key: key.data, field: field ?? null };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const at = (doc: unknown, path: readonly string[]): unknown => {
  const [head, ...rest] = path;

  if (head === undefined) return doc;
  if (!isRecord(doc)) return undefined;
  const dotted = doc[path.join('.')];

  return dotted === undefined ? at(doc[head], rest) : dotted;
};

/** What a layer file writes for `key`: its Override's value, else its plain entry; `undefined`: none. */
export const entryValueOf = (doc: unknown, key: SettingKey): unknown => {
  const overrides = isRecord(doc) ? doc[OVERRIDES] : undefined;
  const override = isRecord(overrides) ? overrides[key] : undefined;

  if (isRecord(override) && Object.hasOwn(override, 'value')) return override.value;

  return at(doc, key.split('.'));
};

/**
 * The value a proposal writes for `key` into a file that now holds `doc`: the value as typed, or
 * for an object setting the file's entry with the fields given changed (one field for a field
 * row, the typed object's for the whole key), its other fields kept. The typed text's YAML
 * reading when it fits, else the text itself, as `settings set`.
 */
export const proposedValue = (o: {
  key: SettingKey;
  field: string | null;
  doc: unknown;
  parsed: unknown;
  typed: string;
}): ValueRead => {
  const schema = SETTINGS[o.key].schema;
  const base = entryValueOf(o.doc, o.key);
  const kept = isRecord(base) ? base : {};
  const whole = (v: unknown) => {
    if (o.field !== null) return { ...kept, [o.field]: v };

    return isRecord(SETTINGS[o.key].default) && isRecord(v) ? { ...kept, ...v } : v;
  };
  const read = schema.safeParse(whole(o.parsed));

  if (read.success) return { ok: true, value: read.data };
  const text = schema.safeParse(whole(o.typed));

  if (text.success) return { ok: true, value: text.data };

  return { ok: false, message: read.error.issues.map((i) => i.message).join('; ') };
};

/** The target as words: `repo acme/demo-shop` (the repo as GitHub names it). */
export const placeWords = (repo: string): string => `repo ${repo}`;

/** The pull request's title: `Repo acme/shop: Test column → Closed`. */
export const proposalTitle = (o: { where: string; label: string; value: string }): string => {
  const title = `${o.where.charAt(0).toUpperCase()}${o.where.slice(1)}: ${o.label} → ${o.value}`;

  return title.length <= 72 ? title : `${title.slice(0, 71)}…`;
};

/** The pull request's body: the reason first, then what changes, where and how it was made. */
export const proposalBody = (o: {
  reason: string;
  name: string;
  label: string;
  from: string;
  value: string;
  where: string;
  path: string;
}): string =>
  [
    o.reason,
    '',
    `${o.label} (\`${o.name}\`): ${o.from} → ${o.value}, proposed for ${o.where}.`,
    '',
    `\`${o.path}\` · made with \`abe settings propose\``,
    '',
  ].join('\n');

const Pr = z.object({ number: z.number().int().positive(), url: z.string() });

/** `abe settings propose`: the pull request opened (or the open one updated) and what it proposes. */
export const SettingsProposeData = z.object({
  key: SettingKeyName,
  field: z.string().nullable(),
  label: z.string(),
  /** The GitHub repo the pull request is on (`owner/name`). */
  repo: z.string(),
  /** The file it changes, from the repo's root (`abe.yaml`). */
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  /** The value in force now and the one proposed, as a row shows them. */
  from: z.string(),
  value: z.string(),
  /** An Override (the reason its reason) where a plain entry may not lower the value above. */
  entry: z.enum(['plain', 'override']),
  pr: Pr,
  /** A pull request for it was open: that one was updated, no second one opened. */
  updated: z.boolean(),
});
export type SettingsProposeData = z.infer<typeof SettingsProposeData>;

export const settingsProposeText = (d: SettingsProposeData): string =>
  d.updated
    ? `updated pull request ${d.pr.url} (${d.branch}): ${d.label} → ${d.value}\n`
    : `pull request ${d.pr.url} on ${d.repo} (${d.branch} → ${d.base}): ${d.path}, ${d.label} → ${d.value}\n`;

/** An open pull request on the repo, by its head branch. */
export type OpenProposal = { branch: string; number: number; url: string };

/** The rows with the open pull request proposing each (#175), found by its proposal's branch. */
export const withProposals = (
  data: SettingsListData,
  open: readonly OpenProposal[],
): SettingsListData => ({
  ...data,
  rows: data.rows.map((row) => {
    if (row.key === null) return row;
    const branch = proposalBranch(proposalName(row.key, row.field));
    const pr = open.find((p) => p.branch === branch);

    return pr === undefined ? row : { ...row, prs: [{ number: pr.number, url: pr.url }] };
  }),
});
