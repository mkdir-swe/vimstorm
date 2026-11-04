/**
 * A list setting's editor (`checks`, `testFiles`, `ports.fixed`, Local mode's checkouts): ⏎ on its
 * row opens it in place, one line per item and `+ Add` after the last. l / ö move, ⏎ edits the
 * item (or adds one), x or ⌫ removes it, ⇧↑ ⇧↓ (L / Ö) move it, Esc closes; every change saves the
 * whole list at once, checked as `abe settings set` reads it, its refusal under the row. A named
 * entry (a check's `{ name, run }`) edits its name; an entry only its file can say (a login's own
 * options) moves and goes, never typed as JSON.
 */
import {
  type ListedRow,
  type SettingRow as CatalogueRow,
  type SettingsDialogRules,
} from '@abe/core';
import { type ListItem, type SettingControl } from './settings-components';
import { greyedOf, valueOf, without } from './settings-rows';
import { save } from './settings-change';
import {
  DOWN,
  type ListEditing,
  type Out,
  type SettingsState,
  UP,
  edited,
  editMode,
  same,
  status,
  unedit,
} from './settings-state';

/** The list's items as the dialog holds them (any other value: none). */
export const listItems = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.map((x: unknown) => x) : [];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * An item in words: a name as it is, a named entry by its name (its command dim after), a
 * one-tool entry (`{ gh: { … } }`) by the tool; anything else as a row says a value.
 */
export const itemWords = (
  r: SettingsDialogRules,
  x: unknown,
): { text: string; detail?: string; named?: true } => {
  if (typeof x === 'string' || typeof x === 'number') return { text: String(x) };
  if (isRecord(x) && typeof x.name === 'string')
    return {
      text: x.name,
      named: true,
      ...(typeof x.run === 'string' ? { detail: x.run } : {}),
    };
  const [only, ...more] = isRecord(x) ? Object.entries(x) : [];

  if (only !== undefined && more.length === 0) return { text: only[0], detail: r.shown(only[1]) };

  return { text: r.shown(x) };
};

/** ⏎ on a list row: its editor open, the cursor on its first item (on `+ Add` when empty). */
export const openList = (s: SettingsState, row: CatalogueRow): SettingsState => ({
  ...s,
  mode: editMode({ kind: 'list', row: row.id, cursor: 0 }),
});

/** What an item typed is: a number for a list of numbers (digits), else the text. */
const typedItem = (listed: ListedRow, text: string): unknown => {
  const t = text.trim();

  return listed.item === 'number' && /^\d+$/.test(t) ? Number(t) : t;
};

/**
 * The list with `items` saved at once, the editor kept open on `cursor` (an Override's reason asked
 * instead, or a refusal, leaves its own mode).
 */
const saved = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow,
  e: ListEditing,
  items: readonly unknown[],
  cursor: number,
): Out => {
  const out = save(r, s, row, listed, JSON.stringify(items));
  const t = out.state;

  // refused: the field (or the list) stays as it was, the reason under the row
  if (t.errors[row.id] !== undefined) return out;
  if (t.mode !== undefined) return out;

  return { ...out, state: { ...t, mode: editMode({ ...e, cursor, field: undefined }) } };
};

/** ⇧↑ ⇧↓ (L / Ö): the cursor's item up or down one. */
const MOVES: Readonly<Record<string, -1 | 1>> = { '<S-Up>': -1, L: -1, '<S-Down>': 1, Ö: 1 };

/** A key while a list's editor is open. */
export const listKey = (
  r: SettingsDialogRules,
  s: SettingsState,
  e: ListEditing,
  key: string,
  row: CatalogueRow,
  listed: ListedRow,
): Out => {
  const items = listItems(valueOf(s, row, listed));
  const n = items.length;
  const f = e.field;

  if (f !== undefined) {
    if (key === '<Esc>')
      return same({
        ...s,
        mode: editMode({ ...e, field: undefined }),
        errors: without(s.errors, row.id),
      });
    if (key === '<CR>') {
      const text = f.text.trim();

      if (text === '') return same({ ...s, mode: editMode({ ...e, field: undefined }) });
      const was = f.at === null ? undefined : items[f.at];
      const item =
        isRecord(was) && typeof was.name === 'string'
          ? { ...was, name: text }
          : typedItem(listed, text);
      const next = f.at === null ? [...items, item] : items.map((x, i) => (i === f.at ? item : x));

      return saved(r, s, row, listed, e, next, f.at ?? n + 1);
    }
    const text = listed.item === 'number' && /^[^0-9]$/.test(key) ? f.text : edited(f.text, key);

    return same({
      ...s,
      mode: editMode({ ...e, field: { ...f, text } }),
      errors: without(s.errors, row.id),
    });
  }
  if (key === '<Esc>') return same({ ...s, mode: unedit(s), errors: without(s.errors, row.id) });
  if (UP.has(key) || DOWN.has(key)) {
    const cursor = Math.max(0, Math.min(n, e.cursor + (UP.has(key) ? -1 : 1)));

    return same({ ...s, mode: editMode({ ...e, cursor }) });
  }
  const at = e.cursor;
  const item = items[at];

  if (key === '<CR>' || key === 'a') {
    if (key === 'a' || item === undefined)
      return same({ ...s, mode: editMode({ ...e, cursor: n, field: { at: null, text: '' } }) });
    const w = itemWords(r, item);

    if (typeof item === 'object' && w.named !== true)
      return {
        state: s,
        commands: [
          status(`${w.text} is written in its file with its options: move or remove it here`),
        ],
      };

    return same({ ...s, mode: editMode({ ...e, field: { at, text: w.text } }) });
  }
  if ((key === 'x' || key === '<BS>' || key === '<Del>') && item !== undefined)
    return saved(
      r,
      s,
      row,
      listed,
      e,
      items.filter((_, i) => i !== at),
      at,
    );
  const by = MOVES[key] ?? 0;

  if (by !== 0 && item !== undefined) {
    const to = at + by;

    if (to < 0 || to >= n) return same(s);
    const next = [...items];

    next[at] = items[to];
    next[to] = item;

    return saved(r, s, row, listed, e, next, to);
  }

  return same(s);
};

/** Typed (or pasted) text into a list's item field. */
export const listText = (
  s: SettingsState,
  e: ListEditing,
  text: string,
  numbers: boolean,
): SettingsState =>
  e.field === undefined
    ? s
    : {
        ...s,
        mode: editMode({
          ...e,
          field: {
            ...e.field,
            text: e.field.text + (numbers ? text.replace(/[^0-9]/g, '') : text),
          },
        }),
        errors: without(s.errors, e.row),
      };

/** A click in an open list: an item (the cursor, again: edit it), its buttons, `+ Add`. */
export const listClick = (
  r: SettingsDialogRules,
  s: SettingsState,
  e: ListEditing,
  id: string,
  row: CatalogueRow,
  listed: ListedRow,
): Out | undefined => {
  const m = /^settings:item(?:-(remove|up|down))?:(\d+)$/.exec(id);

  if (id === 'settings:item-add')
    return listKey(r, s, { ...e, field: undefined }, 'a', row, listed);
  if (m === null) return undefined;
  const at = Number(m[2]);
  const there = { ...e, cursor: at, field: undefined };
  const on = { ...s, mode: editMode(there) };

  switch (m[1]) {
    case 'remove':
      return listKey(r, on, there, 'x', row, listed);
    case 'up':
      return listKey(r, on, there, '<S-Up>', row, listed);
    case 'down':
      return listKey(r, on, there, '<S-Down>', row, listed);
    // one click types in the item; the item typed in keeps its caret
    default:
      return e.field?.at === at ? same(s) : listKey(r, on, there, '<CR>', row, listed);
  }
};

/** A list row's control: chips while closed, its editor while open. */
export const listControl = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
  e: ListEditing | undefined,
  at: number,
): SettingControl => {
  const items: ListItem[] = listItems(valueOf(s, row, listed)).map((x) => {
    const w = itemWords(r, x);

    return {
      text: w.text,
      ...(w.detail === undefined ? {} : { detail: w.detail }),
      ...(greyedOf(listed, w.text) === undefined ? {} : { off: true }),
    };
  });
  const path =
    row.size === 'path' ? { browse: { id: `settings:browse:${at}`, label: 'Choose…' } } : {};

  if (e === undefined) return { kind: 'list', items, ...path };

  return {
    kind: 'list',
    items,
    ...path,
    open: { cursor: e.cursor, ...(e.field === undefined ? {} : { field: e.field }) },
  };
};
