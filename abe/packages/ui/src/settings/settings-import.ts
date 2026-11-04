/**
 * Settings › Import config (#120; #345 split of `settings.ts`): a source read with `--dry-run`, its
 * rows ticked, then imported.
 */
import {
  type ImportRow,
  type ImportSource,
  type SettingsDialogRules,
  type SettingsImportData,
} from '@abe/core';
import { type Node } from '../runtime/components';
import { type Answer, type Refused } from '../runtime/runtime';
import { type SettingRow } from './settings-components';

import { type Line, homeRowOf, read, valueShown } from './settings-rows';
import {
  IMPORT_SOURCES_SHOWN,
  type Imports,
  type Out,
  type SettingsState,
  plural,
  same,
  status,
  refusal,
} from './settings-state';
import { page } from './settings-view';

/** A row Import can write: a setting, or a key binding for your keys.json (#129). */
export const brings = (row: ImportRow) => row.to !== null || row.bind !== null;

const tickedOf = (i: Imports, row: ImportRow) => brings(row) && (i.ticks[row.id] ?? row.ticked);

export const importLines = (s: SettingsState): Line[] => {
  const i = s.imports;
  const sources: Line[] = IMPORT_SOURCES_SHOWN.map((x) => ({ kind: 'import-source', ...x }));

  if (i?.data === undefined) return sources;
  const rows: Line[] = i.data.rows.map((row) => ({ kind: 'import-row', row }));
  const names = importKeys(i);
  const keys = names.filter((k) => k.startsWith('key:')).length;
  const count = names.length - keys;

  return [
    ...sources,
    ...rows,
    ...(names.length > 0 ? [{ kind: 'import-go', count, keys } as const] : []),
  ];
};

/** ⏎ on a source: what it would bring, read with `--dry-run` (nothing written). */
export const readImport = (s: SettingsState, source: ImportSource): Out => {
  const runs = s.runs + 1;
  const id = `settings:import:${runs}`;

  return {
    state: { ...s, runs, imports: { source, ticks: {}, running: id } },
    commands: [{ kind: 'run', id, argv: ['settings', 'import', source, '--dry-run'] }],
  };
};

export const tickImport = (s: SettingsState, row: ImportRow): SettingsState => {
  const i = s.imports;

  if (i === undefined || !brings(row) || i.running !== undefined) return s;

  return { ...s, imports: { ...i, ticks: { ...i.ticks, [row.id]: !tickedOf(i, row) } } };
};

/**
 * Import: the ticked rows' settings into your Layer and their keys into your keys.json (`--only`,
 * a key binding's as `key:<the key>`), never another Layer.
 */
export const runImport = (s: SettingsState): Out => {
  const i = s.imports;

  if (i?.data === undefined || i.running !== undefined) return same(s);
  const keys = importKeys(i);

  if (keys.length === 0) return same(s);
  const runs = s.runs + 1;
  const id = `settings:import:${runs}`;

  return {
    state: { ...s, runs, imports: { ...i, running: id, error: undefined } },
    commands: [
      { kind: 'run', id, argv: ['settings', 'import', i.source, '--only', keys.join(',')] },
    ],
  };
};

/** `settings import` answered: a dry run's rows shown, an import's count said and the rows read again. */
export const imported = (s: SettingsState, input: Answer | Refused): Out => {
  const i = s.imports;

  if (i?.running !== input.id) return same(s);
  if (!input.reply.ok)
    return same({ ...s, imports: { ...i, running: undefined, error: refusal(input.reply.error) } });
  if (input.command !== 'settings import') return same(s);
  const d = input.reply.data;

  if (d.dryRun) return same({ ...s, imports: { ...i, data: d, running: undefined } });
  const refused = d.refused.map((x) => `${x.key}: ${x.message}`).join('; ');
  const keys =
    d.keysWritten.length === 0 ? '' : ` · ${plural(d.keysWritten.length, 'key')} into keys.json`;
  const said = `${plural(d.written.length, 'setting')} imported into yours${keys}${refused === '' ? '' : ` · refused ${refused}`}`;
  const reread = read({ ...s, imports: { ...i, running: undefined } }, 'list');

  return { state: reread.state, commands: [...reread.commands, status(said)] };
};

/** What a row becomes here, as its line says: a setting's value, a key's action, or why none. */
/** Where an imported row goes, in words (#325): the setting's label and value, the action's title. */
const importTo = (r: SettingsDialogRules, row: ImportRow): string => {
  const note = row.note === null ? '' : ` · ${row.note}`;

  if (row.to !== null) {
    const home = homeRowOf(r, row.to.key);
    const v = row.to.value;

    return home === undefined
      ? `→ ${row.to.key} = ${typeof v === 'string' ? v : JSON.stringify(v)}${note}`
      : `→ ${home.label} = ${valueShown(r, home, v)}${note}`;
  }
  if (row.bind !== null) return `→ ${row.bind.key} = ${r.actionTitle(row.bind.action)}${note}`;

  return row.note ?? 'no match here';
};

const importRowNode = (
  r: SettingsDialogRules,
  i: Imports,
  row: ImportRow,
  at: number,
  focused: boolean,
): SettingRow => {
  const to = importTo(r, row);

  return {
    kind: 'SettingRow',
    id: `settings:line:${at}`,
    props: {
      label: row.from,
      control: {
        kind: 'checkbox',
        on: tickedOf(i, row),
        ...(brings(row) ? {} : { fixed: true }),
      },
      source: { text: to },
      ...(focused ? { focused, hint: brings(row) ? 'Space ticks it' : 'nothing to bring' } : {}),
    },
  };
};

/** The rows that are settings to match (#153): the Feel's synthetic row and key bindings are not. */
const settingRowsOf = (d: SettingsImportData) =>
  d.rows.filter((r) => r.group === 'settings' || r.group === 'theme');

/** Key bindings read (#129): a key on one of the Keymap's actions is a match. */
const keyRowsOf = (d: SettingsImportData) => d.rows.filter((r) => r.group === 'keys');

/** `2 of 15 keys match a Keymap action`: what Import brings into keys.json. */
const keysMatch = (rows: readonly ImportRow[]) => {
  const n = rows.filter((r) => r.bind !== null).length;

  return `${n} of ${plural(rows.length, 'key')} ${n === 1 ? 'matches' : 'match'} a Keymap action`;
};

/** A source's count once read: `11 of 56 settings match`; `reading…` meanwhile, `not read` before. */
const sourceCount = (i: Imports | undefined): string => {
  if (i === undefined) return 'not read';
  if (i.data === undefined) return i.running === undefined ? 'not read' : 'reading…';
  const rows = settingRowsOf(i.data);
  const n = rows.filter((r) => r.to !== null).length;

  return `${n} of ${plural(rows.length, 'setting')} ${n === 1 ? 'matches' : 'match'}`;
};

/**
 * What Import writes, as `--only` names it: each setting once however many rows tick it, and each
 * key binding's key (`key:⌘Y`, #129).
 */
const importKeys = (i: Imports): string[] =>
  i.data === undefined
    ? []
    : [
        ...new Set(
          i.data.rows.flatMap((row) => {
            if (!tickedOf(i, row)) return [];
            if (row.to !== null) return [row.to.key];

            return row.bind === null ? [] : [`key:${row.bind.key}`];
          }),
        ),
      ];

const fileWord = (f: SettingsImportData['files'][number]) => {
  // VimStorm's own nvim/ (#213): there, but no other editor's config
  if (f.skipped !== undefined) return 'left out: VimStorm’s own';
  if (!f.found) return 'not found';

  return f.error === null ? 'read' : 'does not read';
};

export const importPage = (r: SettingsDialogRules, s: SettingsState, crumbs: string[]): Node => {
  const i = s.imports;
  const ls = importLines(s);
  const focusedAt = s.focus === 'page' ? s.row : -1;
  const nodes = ls.map((line, at): SettingRow => {
    const focused = at === focusedAt;
    const id = `settings:line:${at}`;

    switch (line.kind) {
      case 'import-source': {
        const shown = i?.source === line.source ? i : undefined;
        const files = shown?.data?.files ?? [];

        return {
          kind: 'SettingRow',
          id,
          props: {
            label: line.label,
            control: { kind: 'value', text: sourceCount(shown) },
            source: {
              text:
                files.length === 0
                  ? 'its settings, keys and theme, as they become ours'
                  : files.map((f) => `${f.path} ${fileWord(f)}`).join(' · '),
            },
            ...(focused
              ? { focused, hint: '⏎ read what it would bring · nothing is written' }
              : {}),
          },
        };
      }
      case 'import-row':
        return i === undefined
          ? importRowNode(r, { source: 'vscode', ticks: {} }, line.row, at, focused)
          : importRowNode(r, i, line.row, at, focused);
      case 'import-go':
        return {
          kind: 'SettingRow',
          id,
          props: {
            // short enough to stay whole (#153); where it goes is the line below
            label: `Import ${[
              ...(line.count > 0 || line.keys === 0 ? [plural(line.count, 'setting')] : []),
              ...(line.keys > 0 ? [plural(line.keys, 'key')] : []),
            ].join(' · ')}`,
            control: { kind: 'value', text: i?.running === undefined ? '⏎' : 'importing…' },
            source: {
              text: `into yours only${line.keys > 0 ? ', keys into keys.json' : ''}; Problems shows what it refuses`,
            },
            ...(focused ? { focused } : {}),
            ...(i?.error === undefined ? {} : { error: i.error }),
          },
        };
      default:
        throw new Error(`not an import line: ${line.kind}`);
    }
  });
  const sources = nodes.slice(0, IMPORT_SOURCES_SHOWN.length);
  const rows = nodes.slice(IMPORT_SOURCES_SHOWN.length);
  const err: Node[] =
    i?.error !== undefined && i.data === undefined
      ? [{ kind: 'SettingsNote', props: { text: i.error } }]
      : [];

  return page(
    crumbs,
    'into your Layer',
    [
      {
        kind: 'SettingsGroup',
        id: 'settings:group:0',
        props: { caption: 'From' },
        children: [...sources, ...err],
      },
      ...(rows.length === 0
        ? []
        : [
            {
              kind: 'SettingsGroup' as const,
              id: 'settings:group:1',
              props: {
                caption: 'What it brings',
                note: [
                  'ticked: a match here',
                  ...(i?.data === undefined || keyRowsOf(i.data).length === 0
                    ? []
                    : [keysMatch(keyRowsOf(i.data))]),
                ].join(' · '),
              },
              children: rows,
            },
          ]),
    ],
    s.row,
  );
};
