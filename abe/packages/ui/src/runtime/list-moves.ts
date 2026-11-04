/**
 * A list's move keys, one rule for every list the Factory view draws (#334): the Board's columns,
 * Sessions and Boxes (`table-list.ts`), :triage, Settings' tree and page, Prototype mode's changes,
 * menus and picks (`command.ts`), Linked, and a dialog's scroll. VimStorm's own lists (the tree,
 * Pipelines, its popups) keep the same keys natively (`app/src/ui/list.rs`).
 *
 * - `l ö` `↑ ↓` a row, a count before them (`3ö`); `L Ö` five rows.
 * - PageUp / PageDown and ⌃B / ⌃F a page (`room` rows), a count of pages; ⌃U / ⌃D half a page, or
 *   a count of rows (Vim's `3⌃D`).
 * - Home / End are `gg` / `G`: the first and the last row; a count before them that row (`5G`).
 *
 * While a filter is typed (the Board's `/`, a list's `/`, a menu's or pick's field) every letter
 * types: only the keys that never type move (`↑ ↓`, the pages, Home / End: WebStorm's speed search
 * goes to the first or last match on them); a menu or pick moves on ⌃P ⌃N too, never on a letter.
 * Command mode's `:` line is a command line, not a menu: Home / End stay its caret's there.
 */

/**
 * What a move key does: `by` rows from the selection; a `page` of rows, the view moving with the
 * selection where the list scrolls by itself (the Board's columns, Vim's ⌃D); `to` a row.
 */
export type ListMove =
  | { kind: 'by'; rows: number }
  | { kind: 'page'; rows: number }
  | { kind: 'to'; row: number | 'last' };

/** A page where a list has no measured height of its own (a dialog, :triage, Settings). */
export const PAGE_ROWS = 10;

const half = (room: number) => Math.max(1, Math.floor(room / 2));

type Rule = (room: number, count: number | undefined) => ListMove;

const by = (rows: number): ListMove => ({ kind: 'by', rows });
const page = (rows: number): ListMove => ({ kind: 'page', rows });
const first: Rule = (_, n) => ({ kind: 'to', row: n === undefined ? 0 : n - 1 });
const last: Rule = (_, n) => ({ kind: 'to', row: n === undefined ? 'last' : n - 1 });

const RULES: Readonly<Record<string, Rule>> = {
  l: (_, n = 1) => by(-n),
  '<Up>': (_, n = 1) => by(-n),
  ö: (_, n = 1) => by(n),
  '<Down>': (_, n = 1) => by(n),
  L: (_, n = 1) => by(-5 * n),
  Ö: (_, n = 1) => by(5 * n),
  '<PageUp>': (room, n = 1) => page(-room * n),
  '<C-b>': (room, n = 1) => page(-room * n),
  '<PageDown>': (room, n = 1) => page(room * n),
  '<C-f>': (room, n = 1) => page(room * n),
  '<C-u>': (room, n) => page(-(n ?? half(room))),
  '<C-d>': (room, n) => page(n ?? half(room)),
  gg: first,
  '<Home>': first,
  G: last,
  '<End>': last,
};

/** `key`'s move (`gg` already put together from its two `g`), `room` the rows a page holds. */
export const listMove = (key: string, room: number, count?: number): ListMove | undefined =>
  RULES[key]?.(room, count);

/** Whether `key` moves a list at all. */
export const isListMove = (key: string): boolean => RULES[key] !== undefined;

/** The moves that never type: they move while a filter's field has the keys. */
const UNTYPED = new Set(['<Up>', '<Down>', '<PageUp>', '<PageDown>', '<Home>', '<End>']);

/** A move while a filter is typed (the Board's, a list's `/`): `undefined` for a key that types. */
export const filterMove = (key: string, room: number): ListMove | undefined =>
  UNTYPED.has(key) ? listMove(key, room) : undefined;

/** A menu's own steps, as VimStorm's popups: ⌃P ⌃N a row. */
const MENU_STEPS: Readonly<Record<string, number>> = { '<C-p>': -1, '<C-n>': 1 };

/** A move on a menu or pick, which filters as you type: ↑ ↓ and ⌃P ⌃N; every letter types. */
export const menuMove = (key: string, room: number): ListMove | undefined => {
  const step = MENU_STEPS[key];

  if (step !== undefined) return { kind: 'by', rows: step };

  return filterMove(key, room);
};

/**
 * The row a move lands on from row `at` of `length` rows (-1: none selected, `ö` takes the
 * first), held within them.
 */
export const movedRow = (move: ListMove, at: number, length: number): number => {
  const held = (to: number) => Math.max(0, Math.min(length - 1, to));

  if (move.kind !== 'to') return held(at + move.rows);

  return held(move.row === 'last' ? length - 1 : move.row);
};
