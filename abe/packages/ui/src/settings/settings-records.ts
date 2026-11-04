/**
 * A records setting's editor (`views`' tweaks, `environments`): its records as rows of fields,
 * each cell typed in place or picked from its list, never JSON. ⏎ on the row opens it; l / ö move
 * between records (to `+ Add` after the last), k / ä between fields, ⏎ edits the cell (a choice's
 * list filters as typed), a adds a record, x or ⌫ removes one, Esc closes. Each cell's change saves
 * the whole setting at once, read as `abe settings set` reads it: a refused one stays here as typed,
 * its reason under the row, nothing saved.
 */
import {
  type ListedRow,
  type RecordsDef,
  type SettingRow as CatalogueRow,
  type SettingsDialogRules,
} from '@abe/core';
import { type ComboChoice, type SettingControl } from './settings-components';
import { save } from './settings-change';
import { valueOf, without } from './settings-rows';
import {
  DOWN,
  LEFT,
  type Out,
  type RecordsEditing,
  RIGHT,
  type SettingsState,
  UP,
  edited,
  editMode,
  editingOf,
  same,
  typedChar,
  unedit,
} from './settings-state';
import { menuMove, movedRow, PAGE_ROWS } from '../runtime/list-moves';

const defOf = (r: SettingsDialogRules, row: CatalogueRow): RecordsDef | undefined =>
  row.key === null ? undefined : r.records(row.key);

/** The records a row shows: the editor's as typed while open, else the value's. */
const rowsOf = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
): readonly (readonly string[])[] => {
  const e = editingOf(s);

  if (e?.kind === 'records' && e.row === row.id) return e.rows;

  return defOf(r, row)?.rows(valueOf(s, row, listed)) ?? [];
};

/** ⏎ on a records row: its editor open on the first cell (`+ Add` when there are none). */
export const openRecords = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow,
): SettingsState => ({
  ...s,
  mode: editMode({
    kind: 'records',
    row: row.id,
    rows: rowsOf(r, s, row, listed),
    cursor: { row: 0, col: 0 },
  }),
});

/** A choice cell's choices as its list shows them, filtered by what was typed. */
const cellChoices = (def: RecordsDef, col: number, filter: string): string[] =>
  (def.columns[col]?.choices ?? []).filter((c) => c.toLowerCase().includes(filter.toLowerCase()));

/**
 * The records as typed, saved: refused, they stay in the editor with the reason under the row;
 * saved, the editor stays open on them.
 */
const commit = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow,
  def: RecordsDef,
  e: RecordsEditing,
  rows: readonly (readonly string[])[],
): Out => {
  const key = row.key;
  const kept = editMode({ ...e, rows, field: undefined, pick: undefined });

  if (key === null) return same(s);
  const typed = JSON.stringify(def.value(rows));
  const lacks = def.lack(rows);
  const got = lacks === undefined ? r.read(key, typed) : { ok: false as const, message: lacks };

  if (!got.ok) return same({ ...s, mode: kept, errors: { ...s.errors, [row.id]: got.message } });
  const out = save(r, { ...s, mode: kept }, row, listed, typed);

  // an Override's reason asked: that has the keys now
  if (out.state.mode !== undefined && editingOf(out.state)?.kind === 'reason') return out;

  return { ...out, state: { ...out.state, mode: kept } };
};

const putCell = (
  rows: readonly (readonly string[])[],
  at: { row: number; col: number },
  text: string,
): string[][] =>
  rows.map((cells, i) =>
    i === at.row ? cells.map((c, j) => (j === at.col ? text : c)) : [...cells],
  );

/** A cell opened: a choice's list (its cursor on the cell's choice), else its field. */
const openCell = (def: RecordsDef, e: RecordsEditing): RecordsEditing => {
  const column = def.columns[e.cursor.col];
  const text = e.rows[e.cursor.row]?.[e.cursor.col] ?? '';

  if (column?.input === 'choice')
    return {
      ...e,
      pick: { cursor: Math.max(0, (column.choices ?? []).indexOf(text)), filter: '' },
    };

  return { ...e, field: { text } };
};

const empty = (cells: readonly string[] | undefined) => (cells ?? []).every((c) => c === '');

/** A key while a records editor is open. */
export const recordsKey = (
  r: SettingsDialogRules,
  s: SettingsState,
  e: RecordsEditing,
  key: string,
  row: CatalogueRow,
  listed: ListedRow,
): Out => {
  const def = defOf(r, row);

  if (def === undefined) return same({ ...s, mode: unedit(s) });
  const n = e.rows.length;
  const cols = def.columns.length;
  const at = e.cursor;

  if (e.pick !== undefined) {
    const p = e.pick;
    const choices = cellChoices(def, at.col, p.filter);

    if (key === '<Esc>') return same({ ...s, mode: editMode({ ...e, pick: undefined }) });
    const m = menuMove(key, PAGE_ROWS);

    if (m !== undefined)
      return same({
        ...s,
        mode: editMode({ ...e, pick: { ...p, cursor: movedRow(m, p.cursor, choices.length) } }),
      });
    if (key === '<CR>') {
      const choice = choices[p.cursor];

      return choice === undefined
        ? same(s)
        : commit(r, s, row, listed, def, e, putCell(e.rows, at, choice));
    }
    const filter = key === '<BS>' ? p.filter.slice(0, -1) : p.filter + (typedChar(key) ?? '');

    return same({ ...s, mode: editMode({ ...e, pick: { cursor: 0, filter } }) });
  }
  if (e.field !== undefined) {
    if (key === '<Esc>') {
      // a record added and left empty goes again
      const rows = empty(e.rows[at.row]) ? e.rows.filter((_, i) => i !== at.row) : e.rows;

      return same({
        ...s,
        mode: editMode({ ...e, rows, field: undefined }),
        errors: without(s.errors, row.id),
      });
    }
    if (key === '<CR>')
      return commit(r, s, row, listed, def, e, putCell(e.rows, at, e.field.text.trim()));
    const number = def.columns[at.col]?.input === 'number';
    const c = typedChar(key);
    const text =
      number && c !== undefined && !/^[0-9]$/.test(c) ? e.field.text : edited(e.field.text, key);

    return same({ ...s, mode: editMode({ ...e, field: { text } }) });
  }
  if (key === '<Esc>') return same({ ...s, mode: unedit(s), errors: without(s.errors, row.id) });
  if (UP.has(key) || DOWN.has(key)) {
    const to = Math.max(0, Math.min(n, at.row + (UP.has(key) ? -1 : 1)));

    return same({ ...s, mode: editMode({ ...e, cursor: { ...at, row: to } }) });
  }
  if (LEFT.has(key) || RIGHT.has(key) || key === '<Tab>' || key === '<S-Tab>') {
    const by = LEFT.has(key) || key === '<S-Tab>' ? -1 : 1;
    const col = Math.max(0, Math.min(cols - 1, at.col + by));

    return same({ ...s, mode: editMode({ ...e, cursor: { ...at, col } }) });
  }
  if (key === 'a' || (key === '<CR>' && at.row >= n)) {
    const added: RecordsEditing = {
      ...e,
      rows: [...e.rows, def.columns.map(() => '')],
      cursor: { row: n, col: 0 },
    };

    return same({ ...s, mode: editMode(openCell(def, added)) });
  }
  if (key === '<CR>' || key === '<Space>') return same({ ...s, mode: editMode(openCell(def, e)) });
  if ((key === 'x' || key === '<BS>' || key === '<Del>') && at.row < n) {
    const rows = e.rows.filter((_, i) => i !== at.row);
    const next = { ...e, cursor: { ...at, row: Math.min(at.row, rows.length) } };

    return commit(r, s, row, listed, def, next, rows);
  }

  return same(s);
};

/** Typed (or pasted) text into a records editor's field or a choice's filter. */
export const recordsText = (s: SettingsState, e: RecordsEditing, text: string): SettingsState => {
  if (e.field !== undefined)
    return { ...s, mode: editMode({ ...e, field: { text: e.field.text + text } }) };
  if (e.pick !== undefined)
    return { ...s, mode: editMode({ ...e, pick: { cursor: 0, filter: e.pick.filter + text } }) };

  return s;
};

/** A click in an open records editor: a cell (again: open it), its ✕, `+ Add`, a choice. */
export const recordsClick = (
  r: SettingsDialogRules,
  s: SettingsState,
  e: RecordsEditing,
  id: string,
  row: CatalogueRow,
  listed: ListedRow,
): Out | undefined => {
  if (id === 'settings:record-add')
    return recordsKey(r, s, { ...e, field: undefined, pick: undefined }, 'a', row, listed);
  const remove = /^settings:record-remove:(\d+)$/.exec(id);

  if (remove !== null) {
    const there = {
      ...e,
      cursor: { ...e.cursor, row: Number(remove[1]) },
      field: undefined,
      pick: undefined,
    };

    return recordsKey(r, { ...s, mode: editMode(there) }, there, 'x', row, listed);
  }
  const cell = /^settings:cell:(\d+):(\d+)$/.exec(id);

  if (cell !== null) {
    const to = { row: Number(cell[1]), col: Number(cell[2]) };
    const here = e.cursor.row === to.row && e.cursor.col === to.col;
    const there = { ...e, cursor: to, field: undefined, pick: undefined };

    // one click types in the cell (a pick cell opens its list); its open list clicked again closes
    if (here && e.pick !== undefined) return same({ ...s, mode: editMode(there) });
    if (here && e.field !== undefined) return same(s);

    return recordsKey(r, { ...s, mode: editMode(there) }, there, '<CR>', row, listed);
  }
  const choice = /^settings:choice:(\d+)$/.exec(id);

  if (choice !== null && e.pick !== undefined) {
    const picked = { ...e, pick: { ...e.pick, cursor: Number(choice[1]) } };

    return recordsKey(r, { ...s, mode: editMode(picked) }, picked, '<CR>', row, listed);
  }

  return undefined;
};

/** A records row's control: its rows of cells, the editor's cursor and open cell while open. */
export const recordsControl = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
  e: RecordsEditing | undefined,
): SettingControl => {
  const def = defOf(r, row);
  const columns = (def?.columns ?? []).map((c) => ({
    label: c.label,
    size: c.size,
    ...(c.input === 'choice' ? { pick: true } : {}),
  }));
  const rows = rowsOf(r, s, row, listed).map((cells) => [...cells]);

  if (e === undefined || def === undefined) return { kind: 'records', columns, rows };
  const pick = e.pick;
  const choices: ComboChoice[] =
    pick === undefined
      ? []
      : cellChoices(def, e.cursor.col, pick.filter).map((c, i) => ({
          id: `settings:choice:${i}`,
          text: c,
        }));

  return {
    kind: 'records',
    columns,
    rows,
    open: {
      row: e.cursor.row,
      col: e.cursor.col,
      ...(e.field === undefined ? {} : { field: { text: e.field.text } }),
      ...(pick === undefined
        ? {}
        : { pick: { choices, cursor: pick.cursor, filter: pick.filter } }),
    },
  };
};
