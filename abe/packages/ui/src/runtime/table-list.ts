/**
 * A bottom pane tab's Table as a list (#137: Sessions and Boxes, board F-Sessions / X-Boxes): the
 * rows that fit, the selection, the moves and the `/` filter typed into. Pure; each screen keeps
 * a `ListPlace` in its state, says what its rows are (`ListOf`) and hands its keys here first.
 *
 * - The selection is a row's key, never an index: a row that moves keeps it, and keeps its screen
 *   row while rows come or go around it (#264). A selected row that goes (terminated, filtered
 *   out) gives way to the row after it, else the one before (#267).
 * - The order holds from your first key or click on the list until the list loses the keyboard,
 *   is opened again or read again (`r`): a box waking or a session needing you changes its row in
 *   place, it does not move under the cursor (#264). A layer opened over it (⌘⏎'s menu, a confirm,
 *   a pick) is not losing it. New rows go in where the sort puts them.
 * - The moves are every list's (`list-moves.ts`: the tree's, Pipelines', the Board's; #271, #245,
 *   #334): `l ö` `↑ ↓` (a count before them, `3ö`), `L Ö` 5 rows, PgUp / PgDn and ⌃B / ⌃F a page,
 *   ⌃U / ⌃D half a page, Home / End and `gg` / `G` (`5G` the fifth row).
 * - `/` filters as you type (#268), as the Board's filter (#245) and the tree's speed search:
 *   `k l ö ä` type, the arrows, pages and Home / End move; the selection stays on its row while it matches,
 *   else the first match; ⏎ is the row's ⏎ at once (attach, open), the filter kept; Esc while
 *   typing puts the selection and scroll back as before `/`; Esc on a kept filter turns it off,
 *   the row kept, and the keys stay in the list; Esc with no filter is the pane's (#263).
 * - The wheel moves the view, not the selection (#323, as a WebStorm list): the window stays where
 *   it left it, the selection out of it if so, until a move or a click puts it back on the row.
 */
import { type Field, caretProp, fieldInsert, fieldKey, fieldOf, withCaret } from './field';
import { type ListMove, filterMove, listMove, movedRow } from './list-moves';
import { type ViewSize } from './protocol';

/** px (board X-Boxes, as F-Sessions): the header row, a row, the key line under the rows. */
export const HEAD_H = 28;
export const ROW_H = 30;
export const FOOT_H = 24;

/** How many rows fit under the header and above the key line. */
export const fits = (size: ViewSize | undefined): number =>
  size === undefined ? 8 : Math.max(1, Math.floor((size.height - HEAD_H - FOOT_H) / ROW_H));

/** `top` moved only as far as keeps row `at` in view. */
export const keepInView = (top: number, at: number, fit: number): number => {
  if (at < top) return at;
  if (at >= top + fit) return at - fit + 1;

  return top;
};

/** The `/` filter: its text, whether keys still type into it, and the selection and scroll
 * before `/` (Esc while typing puts them back). */
export type ListFilter = {
  text: string;
  /** Its caret while typed (`field.ts`, #314); absent: at its end. */
  caret?: number | undefined;
  typing: boolean;
  before: { selected?: string | undefined; top: number; wheeled?: boolean | undefined };
};

/** Where a list is, kept in its screen's state. */
export type ListPlace = {
  /** The selected row's key. */
  selected?: string | undefined;
  /** The first row drawn (the rows are windowed to the height). */
  top: number;
  filter?: ListFilter | undefined;
  /** A `g` pressed: the next `g` is `gg`. */
  g: boolean;
  /** A count typed before a move (`5ö`). */
  count?: number | undefined;
  /** Every row's key in the order last settled (filtered out ones too). */
  order?: readonly string[] | undefined;
  /** The order holds (`order`): you are working the list. */
  hold?: boolean | undefined;
  /** The selected row's key and the screen row it was settled on. */
  at?: { key: string; row: number } | undefined;
  /** The wheel moved the window (#323): it stays at `top`, the selection perhaps out of it. */
  wheeled?: boolean | undefined;
};

/** A screen's rows as the list sees them. */
export type ListOf<R> = {
  /** Every row, sorted as the screen sorts them, before the filter. */
  all: readonly R[];
  keyOf: (row: R) => string;
  /** Whether a row shows under the filter's text, trimmed and in lower case (never empty). */
  matches: (row: R, filter: string) => boolean;
  /** How many rows fit. */
  room: number;
};

/**
 * `keys` (sorted fresh) in the order `held`: the known ones where they were, a new one after the
 * row sorted before it.
 */
export const holdOrder = (keys: readonly string[], held: readonly string[]): string[] => {
  const fresh = new Set(keys);
  const out = held.filter((k) => fresh.has(k));
  const placed = new Set(out);

  keys.forEach((k, i) => {
    if (placed.has(k)) return;
    const before = i === 0 ? -1 : out.indexOf(keys[i - 1] ?? '');

    out.splice(before + 1, 0, k);
    placed.add(k);
  });

  return out;
};

/** Every row in the list's order: the screen's while it does not hold, else the held one. */
const arranged = <R>(p: ListPlace, l: ListOf<R>): R[] => {
  if (p.hold !== true || p.order === undefined) return [...l.all];
  const by = new Map(l.all.map((r) => [l.keyOf(r), r]));

  return holdOrder(l.all.map(l.keyOf), p.order).flatMap((k) => {
    const r = by.get(k);

    return r === undefined ? [] : [r];
  });
};

const filterText = (p: ListPlace): string => p.filter?.text.trim().toLowerCase() ?? '';

/** The rows the filter leaves, in the list's order. */
export const shownRows = <R>(p: ListPlace, l: ListOf<R>): R[] => {
  const f = filterText(p);
  const rows = arranged(p, l);

  return f === '' ? rows : rows.filter((r) => l.matches(r, f));
};

/** The index of the row keyed `key` among `rows`, else -1. */
const indexOf = <R>(rows: readonly R[], l: ListOf<R>, key: string | undefined): number =>
  key === undefined ? -1 : rows.findIndex((r) => l.keyOf(r) === key);

/**
 * The row that takes a gone row's place: the next one in the last order that still shows, else
 * the one before; undefined when the gone one was not in it.
 */
const neighbour = (
  gone: string | undefined,
  order: readonly string[],
  shown: ReadonlySet<string>,
): string | undefined => {
  const at = gone === undefined ? -1 : order.indexOf(gone);

  if (at < 0) return undefined;

  return (
    order.slice(at + 1).find((k) => shown.has(k)) ??
    order
      .slice(0, at)
      .reverse()
      .find((k) => shown.has(k))
  );
};

/**
 * The place settled on the rows now: the selection on its row, else its neighbour (#267), else
 * the first; the window keeping the selected row on its screen row unless you moved it (#264),
 * never past the last screenful, the selection always in it; the order recorded.
 */
export const settle = <S extends ListPlace, R>(s: S, l: ListOf<R>): S => {
  const rows = shownRows(s, l);
  const keys = rows.map(l.keyOf);
  const key = keys.includes(s.selected ?? '')
    ? s.selected
    : (neighbour(s.selected, s.order ?? [], new Set(keys)) ?? keys[0]);
  const at = Math.max(0, keys.indexOf(key ?? ''));
  // the row last settled (moved, or a gone one's place taken): on the screen row it was on
  const kept = s.at !== undefined && s.at.key === s.selected ? at - s.at.row : s.top;
  const clamp = (t: number) => Math.max(0, Math.min(t, rows.length - l.room));
  // wheeled: where the wheel left it, else the selection in it
  const top = s.wheeled === true ? clamp(s.top) : keepInView(clamp(kept), at, l.room);
  const next: S = { ...s, top, order: arranged(s, l).map(l.keyOf) };

  // no rows (a filter that matches none): the selection kept for when they come back
  if (key === undefined) delete next.at;
  else {
    next.selected = key;
    next.at = { key, row: at - top };
  }

  return next;
};

/** The selected row: by its key while it shows, else the first. */
export const selectedRow = <R>(p: ListPlace, l: ListOf<R>): R | undefined =>
  windowed(p, l).selected;

/**
 * The rows drawn (the window from `top`) and the selected one, as `settle` would leave them (a
 * row gone since the last settle: its neighbour).
 */
export const windowed = <R>(p: ListPlace, l: ListOf<R>): { rows: R[]; selected?: R } => {
  const s = settle(p, l);
  const rows = shownRows(s, l);
  const at = Math.max(0, indexOf(rows, l, s.selected));
  const selected = rows[at];

  return {
    rows: rows.slice(s.top, s.top + l.room),
    ...(selected === undefined ? {} : { selected }),
  };
};

/** The filter at the key line's right: `/text▏ · 3 of 13`; undefined with no filter. */
export const filterNote = <R>(p: ListPlace, l: ListOf<R>): string | undefined => {
  if (p.filter === undefined) return undefined;
  const f = p.filter;
  const text = f.typing ? withCaret(fieldOf(f.text, f.caret)) : f.text;
  const count = filterText(p) === '' ? '' : ` · ${shownRows(p, l).length} of ${l.all.length}`;

  return `/${text}${count}`;
};

/** The order sorted fresh again: the list lost the keyboard, was opened again or read again. */
export const released = <S extends ListPlace>(s: S): S => {
  const next = { ...s };

  delete next.hold;

  return next;
};

/** `k ä` (left, right): a list has neither, and they never type; ← → are the filter's caret. */
const SIDEWAYS = new Set(['k', 'ä', '<Left>', '<Right>']);

/** The selection on row `to` of the shown ones (kept on them; your move: the window follows). */
const moveTo = <S extends ListPlace, R>(s: S, to: number, l: ListOf<R>): S => {
  const rows = shownRows(s, l);
  const row = rows[Math.max(0, Math.min(rows.length - 1, to))];

  if (row === undefined) return s;
  const next: S = { ...s, selected: l.keyOf(row) };

  delete next.at;
  delete next.wheeled;

  return settle(next, l);
};

/** The selection moved by `move` (every list's rule, `list-moves.ts`) from where it is. */
const move = <S extends ListPlace, R>(s: S, m: ListMove, l: ListOf<R>): S => {
  const rows = shownRows(s, l);

  return moveTo(s, movedRow(m, indexOf(rows, l, s.selected), rows.length), l);
};

/** Where the list is, for Esc to put back (the place before `/`). */
const placeOf = (s: ListPlace): ListFilter['before'] => ({
  selected: s.selected,
  top: s.top,
  ...(s.wheeled === true ? { wheeled: true } : {}),
});

/** The selection on `selected`, the window from `top` as it was (the place before `/`). */
const placed = <S extends ListPlace, R>(s: S, before: ListFilter['before'], l: ListOf<R>): S => {
  const next: S = { ...s, top: before.top };

  delete next.at;
  if (before.wheeled === true) next.wheeled = true;
  else delete next.wheeled;
  if (before.selected === undefined) delete next.selected;
  else next.selected = before.selected;

  return settle(next, l);
};

/** The filter off: the window scrolled as before `/`, the selection where it is. */
const withoutFilter = <S extends ListPlace, R>(s: S, l: ListOf<R>): S => {
  const next = { ...s };

  delete next.filter;
  if (s.filter === undefined) return settle(next, l);
  delete next.at;
  delete next.wheeled;

  return settle({ ...next, top: s.filter.before.top }, l);
};

/** The filter given up while typing (Esc): the selection back where it was too. */
const cancelled = <S extends ListPlace, R>(s: S, l: ListOf<R>): S => {
  if (s.filter === undefined) return s;
  const next = { ...s };

  delete next.filter;

  return placed(next, s.filter.before, l);
};

/**
 * The filter's text changed (the Board's, #248): the selection stays on its row while that
 * matches, else goes to the first row shown (WebStorm's speed search); an empty field puts the
 * selection and the window back as before `/`.
 */
const filtered = <S extends ListPlace, R>(s: S, f: Field, l: ListOf<R>): S => {
  const before = s.filter?.before ?? placeOf(s);
  const text = f.text;
  const next: S = { ...s, filter: { text, caret: caretProp(f), typing: true, before } };

  // the caret moved: the rows and the selection stay
  if (text === s.filter?.text) return next;

  delete next.wheeled;
  if (text.trim() === '') return placed(next, before, l);
  const rows = shownRows(next, l);

  return indexOf(rows, l, s.selected) >= 0 ? settle(next, l) : moveTo(next, 0, l);
};

/** A key while the filter is typed (see `listKey`). */
const typingKey = <S extends ListPlace, R>(
  s: S,
  f: ListFilter,
  raw: string,
  l: ListOf<R>,
): { state: S; key?: string } => {
  // ⏎ is the row's at once (WebStorm's speed search), the filter kept
  if (raw === '<CR>') return { state: { ...s, filter: { ...f, typing: false } }, key: raw };
  if (raw === '<Esc>') return { state: cancelled(s, l) };
  const m = filterMove(raw, l.room);

  if (m !== undefined) return { state: move(s, m, l) };
  // a macOS field's keys (`field.ts`): ← → ⌥← ⌘← the caret, ⌫ ⌥⌫ ⌘⌫ at it, text typed there
  const next = fieldKey(fieldOf(f.text, f.caret), raw);

  if (next !== undefined) return { state: filtered(s, next, l) };
  // another named key (⌘⏎, a jump): the screen's, on the row the filter left selected
  return raw.startsWith('<') ? { state: s, key: raw } : { state: s };
};

/**
 * A key on the list: the `state` after it, and the `key` when it is not the list's own (the
 * screen's to do on `state`: ⏎, ⌘⏎, `r`, a jump; Esc with no filter). Any key holds the order.
 */
export const listKey = <S extends ListPlace, R>(
  s0: S,
  raw: string,
  l: ListOf<R>,
): { state: S; key?: string } => {
  // settled first: the rows as drawn (a row gone, the order as shown) are what the key acts on
  const s: S = { ...settle(s0, l), hold: true, g: false };

  delete s.count;
  const f = s0.filter;

  if (f?.typing === true) return typingKey(s, f, raw, l);
  if (/^[1-9]$/.test(raw) || (raw === '0' && s0.count !== undefined))
    return { state: { ...s, count: Math.min(9999, (s0.count ?? 0) * 10 + Number(raw)) } };
  // a count waits through the `g` (`3gg`)
  if (raw === 'g' && !s0.g) return { state: { ...s, g: true, count: s0.count } };
  const key = s0.g && raw === 'g' ? 'gg' : raw;

  // every list's moves (`list-moves.ts`): a count before them, `5G` that row
  const m = listMove(key, l.room, s0.count);

  if (m !== undefined) return { state: move(s, m, l) };
  if (SIDEWAYS.has(key)) return { state: s };
  // `/` again: a new text, the place before the first `/` kept (the Board's)
  if (key === '/') {
    const before = f?.before ?? placeOf(s);

    return { state: settle({ ...s, filter: { text: '', typing: true, before } }, l) };
  }
  if (key === '<Esc>' && f !== undefined) return { state: withoutFilter(s, l) };

  return { state: s, key };
};

/** Text (⌘V's, an IME's) into the filter while it is typed; undefined while it is not. */
export const listText = <S extends ListPlace, R>(
  s: S,
  text: string,
  l: ListOf<R>,
): S | undefined =>
  s.filter?.typing === true
    ? filtered(s, fieldInsert(fieldOf(s.filter.text, s.filter.caret), text), l)
    : undefined;

/** A click on the row keyed `key`: selected, the order held (a click is your move). */
export const listClick = <S extends ListPlace, R>(s: S, key: string, l: ListOf<R>): S => {
  const next: S = { ...settle(s, l), hold: true, selected: key };

  delete next.at;
  delete next.wheeled;

  return settle(next, l);
};

/**
 * The selection put on the row keyed `key` from outside the list (the Board's card, Linked's box):
 * the window goes to it, as a click's; the screen settles.
 */
export const selectOn = <S extends ListPlace>(s: S, key: string): S => {
  const next: S = { ...s, selected: key };

  delete next.at;
  delete next.wheeled;

  return next;
};

/**
 * The wheel over the list (#323): the window `by` rows down (+) or up (−), never past the last
 * screenful; the selection stays on its row, in view or not.
 */
export const listScroll = <S extends ListPlace, R>(s: S, by: number, l: ListOf<R>): S => {
  const at = settle(s, l);

  return settle({ ...at, top: at.top + by, wheeled: true }, l);
};

/** Without the filter, the count, a pending `g` or the held order: what a reopen keeps of it. */
export const reopened = <S extends ListPlace>(s: S): S => {
  const next: S = { ...released(s), g: false };

  delete next.filter;
  delete next.count;
  delete next.wheeled;

  return next;
};
