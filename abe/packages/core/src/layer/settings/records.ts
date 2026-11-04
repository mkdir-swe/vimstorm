/**
 * A setting of records (`views`' tweaks, `environments`): its rows of fields as the Settings dialog
 * edits them, each field typed or picked, never its JSON. A record's cells are text as typed; a
 * value is put together from them and read as `abe settings set` reads it, so a refusal says what
 * the setting takes, and taken apart again for the rows.
 */
import { VIEW_NODES } from '../../improve/views';
import { REPO_KINDS } from '../../install/install-kind';
import { RECIPE_GROUPS } from '../../session/worktree-recipe';
import { type SettingKey } from './keys';

/** What a cell takes: text, a number, or one of `choices`. */
export const CELL_INPUTS = ['text', 'number', 'choice'] as const;
export type CellInput = (typeof CELL_INPUTS)[number];

/** One field of a record: its column. `size` is its share of the row's width. */
export type RecordColumn = {
  readonly id: string;
  readonly label: string;
  readonly input: CellInput;
  /** A choice cell's choices. */
  readonly choices?: readonly string[];
  /** A record without it is no record: its row says so before the setting reads it. */
  readonly required?: true;
  readonly size: number;
};

type RecordsSpec = {
  readonly columns: readonly RecordColumn[];
  /** The value's records as rows of cells, in the columns' order. */
  readonly rows: (value: unknown) => string[][];
  /** The rows put together as the setting's value (empty cells left out). */
  readonly value: (rows: readonly (readonly string[])[]) => unknown;
  /** What a record lacks beyond its required fields, in words (`views`: hide takes no value). */
  readonly lacks?: (cells: readonly string[]) => string | undefined;
};

export type RecordsDef = Omit<RecordsSpec, 'lacks'> & {
  /** Why rows are no value yet: the first record lacking a field, in plain words; else none. */
  readonly lack: (rows: readonly (readonly string[])[]) => string | undefined;
};

const withLack = (spec: RecordsSpec): RecordsDef => ({
  columns: spec.columns,
  rows: spec.rows,
  value: spec.value,
  lack: (rows) => {
    for (const [i, cells] of rows.entries()) {
      const empty = spec.columns.find((c, j) => c.required === true && (cells[j] ?? '') === '');
      const lacks = empty === undefined ? spec.lacks?.(cells) : `${empty.label} is empty`;

      if (lacks !== undefined) return `Row ${i + 1}: ${lacks}`;
    }

    return undefined;
  },
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown): string => {
  if (typeof v === 'number') return String(v);

  return typeof v === 'string' ? v : '';
};

/** A number cell as typed: its number, else its text (the setting's reading refuses it). */
const numberOf = (cell: string): number | string => (/^\d+$/.test(cell) ? Number(cell) : cell);

/** What a view tweak does: one of these, with its value (`order`'s place, `label`'s words). */
const TWEAKS = ['hide', 'order', 'label', 'group'] as const;

const tweakOf = (t: Record<string, unknown>): { does: string; value: string } => {
  const does = TWEAKS.find((k) => t[k] !== undefined) ?? '';

  return { does, value: does === 'hide' || does === '' ? '' : text(t[does]) };
};

const VIEWS: RecordsSpec = {
  columns: [
    {
      id: 'screen',
      label: 'Screen',
      input: 'choice',
      choices: Object.keys(VIEW_NODES),
      size: 2,
      required: true,
    },
    { id: 'node', label: 'Part', input: 'text', size: 3, required: true },
    { id: 'does', label: 'Does', input: 'choice', choices: TWEAKS, size: 2, required: true },
    { id: 'value', label: 'Value', input: 'text', size: 3 },
  ],
  lacks: ([, , does = '', v = '']) =>
    does !== 'hide' && v === ''
      ? `${does} takes a value (order a place, label words, group top or bottom)`
      : undefined,
  rows: (value) =>
    (Array.isArray(value) ? value : []).filter(isRecord).map((t) => {
      const { does, value: v } = tweakOf(t);

      return [text(t.screen), text(t.node), does, v];
    }),
  value: (rows) =>
    rows.map(([screen = '', node = '', does = '', v = '']) => {
      const tweak: Record<string, unknown> = { screen, node };

      if (does === 'hide') tweak.hide = true;
      else if (does === 'order') tweak.order = numberOf(v);
      else if (does !== '') tweak[does] = v;

      return tweak;
    }),
};

const ENVIRONMENTS: RecordsSpec = {
  columns: [
    { id: 'name', label: 'Name', input: 'text', size: 2, required: true },
    { id: 'account', label: 'AWS account', input: 'text', size: 3, required: true },
    { id: 'region', label: 'Region', input: 'text', size: 2 },
    { id: 'writePolicy', label: 'Write policy', input: 'text', size: 3 },
    { id: 'db.read', label: 'DB read secret', input: 'text', size: 3 },
    { id: 'db.write', label: 'DB write secret', input: 'text', size: 3 },
  ],
  rows: (value) =>
    Object.entries(isRecord(value) ? value : {}).map(([name, e]) => {
      const env = isRecord(e) ? e : {};
      const db = isRecord(env.db) ? env.db : {};
      const secret = (s: unknown) => (isRecord(s) ? text(s.secret) : '');

      return [
        name,
        text(env.account),
        text(env.region),
        text(env.writePolicy),
        secret(db.read),
        secret(db.write),
      ];
    }),
  value: (rows) =>
    Object.fromEntries(
      rows.map(
        ([name = '', account = '', region = '', writePolicy = '', read = '', write = '']) => {
          const db = {
            ...(read === '' ? {} : { read: { secret: read } }),
            ...(write === '' ? {} : { write: { secret: write } }),
          };

          return [
            name,
            {
              account,
              ...(region === '' ? {} : { region }),
              ...(writePolicy === '' ? {} : { writePolicy }),
              ...(Object.keys(db).length === 0 ? {} : { db }),
            },
          ];
        },
      ),
    ),
};

const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map(text) : []);

/** How a recipe path comes into a new worktree. */
const RECIPE_HOWS = ['link', 'copy'] as const;

/**
 * The worktree recipe (ADR 0032, 0040): a row per path and group, its group empty in a flat list
 * (placed by the install's env map). Put together grouped when any row names a group, a row
 * without one then in `all`; else flat.
 */
const WORKTREE: RecordsSpec = {
  columns: [
    { id: 'path', label: 'Path', input: 'text', size: 4, required: true },
    { id: 'how', label: 'How', input: 'choice', choices: RECIPE_HOWS, size: 1, required: true },
    { id: 'group', label: 'Group', input: 'choice', choices: RECIPE_GROUPS, size: 1 },
  ],
  rows: (value) => {
    const recipe = isRecord(value) ? value : {};

    return RECIPE_HOWS.flatMap((how) => {
      const list = recipe[how];

      if (Array.isArray(list)) return texts(list).map((path) => [path, how, '']);
      if (!isRecord(list)) return [];

      return RECIPE_GROUPS.flatMap((g) => texts(list[g]).map((path) => [path, how, g]));
    });
  },
  value: (rows) => {
    const grouped = rows.some(([, , group = '']) => group !== '');
    const out: Record<string, unknown> = {};

    for (const how of RECIPE_HOWS) {
      const mine = rows.filter(([, h = '']) => h === how);

      if (mine.length === 0) continue;
      out[how] = grouped
        ? Object.fromEntries(
            RECIPE_GROUPS.flatMap((g) => {
              const paths = mine
                .filter(([, , group = '']) => (group === '' ? 'all' : group) === g)
                .map(([path = '']) => path);

              return paths.length === 0 ? [] : [[g, paths]];
            }),
          )
        : mine.map(([path = '']) => path);
    }

    return out;
  },
};

/** The repo's kind as said (ADR 0040): one row for the whole repo (no part), or one per part. */
const KIND: RecordsSpec = {
  columns: [
    { id: 'part', label: 'Part', input: 'text', size: 3 },
    { id: 'kind', label: 'Kind', input: 'choice', choices: REPO_KINDS, size: 2, required: true },
  ],
  rows: (value) =>
    typeof value === 'string'
      ? [['', value]]
      : Object.entries(isRecord(value) ? value : {}).map(([part, kind]) => [part, text(kind)]),
  value: (rows) => {
    const [only] = rows;

    if (rows.length === 0) return null;
    if (rows.length === 1 && (only?.[0] ?? '') === '') return only?.[1] ?? '';

    return Object.fromEntries(
      rows.map(([part = '', kind = '']) => [part === '' ? '.' : part, kind]),
    );
  },
};

/** The keys and env files the app never uses (ADR 0040), each with how the person knows. */
const NOT_USED: RecordsSpec = {
  columns: [
    { id: 'key', label: 'Key or env file', input: 'text', size: 2, required: true },
    { id: 'why', label: 'How you know', input: 'text', size: 4, required: true },
  ],
  rows: (value) =>
    (Array.isArray(value) ? value : []).filter(isRecord).map((n) => [text(n.key), text(n.why)]),
  value: (rows) => rows.map(([key = '', why = '']) => ({ key, why })),
};

const RECORDS: Partial<Record<SettingKey, RecordsDef>> = {
  views: withLack(VIEWS),
  environments: withLack(ENVIRONMENTS),
  worktree: withLack(WORKTREE),
  kind: withLack(KIND),
  'env.notUsed': withLack(NOT_USED),
};

/** A records setting's columns and its value as rows, or `undefined` for any other key. */
export const recordsOf = (key: SettingKey): RecordsDef | undefined => RECORDS[key];
