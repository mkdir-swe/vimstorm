/** `abe settings set`: a value typed on the command line, and a layer file with one entry put. */
import { z } from 'zod';
import { addsOnly, type SettingKey, SETTINGS } from './keys';
import { type Entry, OVERRIDES } from './layers';
import { shownValue } from './list';

const Doc = z.record(z.string(), z.unknown());
type Doc = z.infer<typeof Doc>;

const docOf = (v: unknown): Doc => {
  const read = Doc.safeParse(v);

  return read.success && !Array.isArray(v) ? { ...read.data } : {};
};

export type ValueRead = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * A value as typed: its YAML reading (`true`, `3`, `[a, b]`) when that fits the key, else the
 * text itself (`team 123` is the team named "123").
 */
export const readValue = (key: SettingKey, parsed: unknown, typed: string): ValueRead => {
  const schema = SETTINGS[key].schema;
  const read = schema.safeParse(parsed);

  if (read.success) return { ok: true, value: read.data };
  if (schema.safeParse(typed).success) return { ok: true, value: typed };

  return { ok: false, message: read.error.issues.map((i) => i.message).join('; ') };
};

const omit = (doc: Doc, ...keys: string[]): Doc =>
  Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

/** `doc` without the key, as a nested map (`serve: { target }`) or written dotted. */
const without = (doc: Doc, path: readonly string[]): Doc => {
  const [head, ...rest] = path;

  if (head === undefined) return doc;
  if (rest.length === 0) return omit(doc, head);
  const out = omit(doc, path.join('.'));
  const inner = out[head];

  if (inner === undefined) return out;
  const left = without(docOf(inner), rest);

  return Object.keys(left).length === 0 ? omit(out, head) : { ...out, [head]: left };
};

const put = (doc: Doc, path: readonly string[], value: unknown): Doc => {
  const [head, ...rest] = path;

  if (head === undefined) return doc;

  return { ...doc, [head]: rest.length === 0 ? value : put(docOf(doc[head]), rest, value) };
};

/**
 * The layer file's document with `key` written as `entry`: any earlier entry for the key, plain
 * or Override, is replaced. Everything else in the file is kept.
 */
export const putEntry = (doc: unknown, key: SettingKey, entry: Entry): Doc => {
  const path = key.split('.');
  const base = without(docOf(doc), path);
  const overrides = omit(docOf(base[OVERRIDES]), key);
  const rest = omit(base, OVERRIDES);
  const { value } = entry;

  if (entry.kind === 'override')
    return {
      ...rest,
      [OVERRIDES]: {
        ...overrides,
        [key]: {
          value,
          reason: entry.reason,
          ...(entry.since === undefined ? {} : { since: entry.since }),
        },
      },
    };
  const out = put(rest, path, value);

  return Object.keys(overrides).length === 0 ? out : { ...out, [OVERRIDES]: overrides };
};

/**
 * The layer file's document with one field of `key`'s map written (`board`'s `azureConfigDir`),
 * `null` taking it out (and the map, left empty); its other fields and the rest of the file kept.
 */
export const putField = (doc: unknown, key: SettingKey, field: string, value: unknown): Doc => {
  const path = [...key.split('.'), field];
  const base = docOf(doc);

  return value === null ? without(base, path) : put(base, path, value);
};

/** The layer file's document without any entry for `key`, plain or Override; the rest kept. */
export const dropEntry = (doc: unknown, key: SettingKey): Doc => {
  const base = without(docOf(doc), key.split('.'));
  const overrides = omit(docOf(base[OVERRIDES]), key);
  const rest = omit(base, OVERRIDES);

  return Object.keys(overrides).length === 0 ? rest : { ...rest, [OVERRIDES]: overrides };
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Why a plain list entry is no write (#173): it adds nothing to the value above it (a plain
 * entry of `checks`, `testFiles`, `reach` only adds), yet leaves some of it out, as a drop would;
 * dropping takes an Override. `undefined` when the entry adds something, or is the whole value.
 */
export const addsNothing = (o: {
  key: SettingKey;
  typed: string;
  written: unknown;
  /** The value without this entry, and with it. */
  above: unknown;
  after: unknown;
}): string | undefined => {
  if (!addsOnly(o.key) || !Array.isArray(o.written)) return undefined;
  if (!same(o.above, o.after) || same(o.written, o.after)) return undefined;

  return `${o.key}: a plain entry only adds to the value above (${shownValue(o.above)}), so ${o.typed} changes nothing; to drop from it: --override --reason <why>`;
};
