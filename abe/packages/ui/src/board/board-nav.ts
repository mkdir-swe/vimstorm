/**
 * The Board's navigation: the ring (the selected card) moves, the view follows. Each column keeps
 * where it is scrolled (`Places`, by the column's key); a column scrolls only to keep the ring in
 * view, never more (Vim's `scrolloff=0`), so a column the ring leaves stays as it was, and
 * remembers the card the ring left in it. `k` / `ä` back lands there again, the way Vim's windows
 * and WebStorm's splits keep their own cursor.
 * Pure: the columns' card ids in, the ring and the places out.
 */

/** The selected card: its id, else where it was. */
export type Ring = { col: number; row: number; id?: number };

/** Where a column is scrolled (its first card shown) and the card the ring was on in it. */
export type ColumnPlace = { start: number; card?: number };

/** Each column's place, by its key (the tab and the column's name). */
export type Places = Readonly<Record<string, ColumnPlace>>;

/** A column as navigation sees it: its key and its cards' ids, in order. */
export type NavColumn = { key: string; cards: readonly number[] };

const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len - 1));

/**
 * Where the ring is: by its id while it shows, else where it was (nothing chosen yet: the first
 * column with a card).
 */
export const ringAt = (ring: Ring, cols: readonly NavColumn[]): { col: number; row: number } => {
  if (ring.id !== undefined)
    for (const [col, c] of cols.entries()) {
      const row = c.cards.indexOf(ring.id);

      if (row >= 0) return { col, row };
    }
  const at = clamp(ring.col, cols.length);
  const first = cols.findIndex((c) => c.cards.length > 0);
  const col = ring.id === undefined && cols[at]?.cards.length === 0 && first >= 0 ? first : at;

  return { col, row: clamp(ring.row, cols[col]?.cards.length ?? 0) };
};

/** The ring on `col` / `row` (clamped); its id kept when that place holds no card. */
export const ringOn = (ring: Ring, cols: readonly NavColumn[], col: number, row: number): Ring => {
  const c = clamp(col, cols.length);
  const r = clamp(row, cols[c]?.cards.length ?? 0);
  const at = cols[c]?.cards[r];
  const id = at ?? ring.id;

  return { col: c, row: r, ...(id === undefined ? {} : { id }) };
};

/** The column's first card shown, within what it can show. */
export const startOf = (places: Places, col: NavColumn | undefined, rows: number): number =>
  col === undefined
    ? 0
    : Math.max(0, Math.min(places[col.key]?.start ?? 0, col.cards.length - rows));

/**
 * The places after a step: every column's start kept within its cards; with `follow` the ring's
 * column moved as little as shows the ring.
 */
export const settlePlaces = (
  ring: Ring,
  places: Places,
  cols: readonly NavColumn[],
  rows: number,
  follow: boolean,
): Places => {
  const at = ringAt(ring, cols);
  const next: Record<string, ColumnPlace> = { ...places };

  for (const [i, c] of cols.entries()) {
    let start = startOf(places, c, rows);

    if (follow && i === at.col && c.cards.length > 0 && at.row >= 0) {
      if (at.row < start) start = at.row;
      if (at.row >= start + rows) start = at.row - rows + 1;
    }
    const card = i === at.col ? c.cards[at.row] : undefined;

    next[c.key] = { ...places[c.key], start, ...(card === undefined ? {} : { card }) };
  }

  return next;
};

/**
 * The ring `n` columns with cards over (`k` / `ä`): an empty column is no stop, so a press lands
 * on the next card over and a count that many columns over, as far as the Board goes; nothing
 * that way, the ring stays. On the card it was on there while that still shows, else on the card
 * at the same height in view.
 */
export const ringBeside = (
  ring: Ring,
  places: Places,
  cols: readonly NavColumn[],
  n: number,
  rows: number,
): Ring => {
  const at = ringAt(ring, cols);
  const step = Math.sign(n);
  let col = at.col;

  for (let c = at.col + step, left = Math.abs(n); c >= 0 && c < cols.length && left > 0; c += step)
    if ((cols[c]?.cards.length ?? 0) > 0) {
      col = c;
      left -= 1;
    }
  if (col === at.col) return ring;
  const to = cols[col];

  // the height in view goes along, over an empty column too
  const height = at.row >= 0 ? at.row - startOf(places, cols[at.col], rows) : ring.row;
  const kept = to === undefined ? -1 : to.cards.indexOf(places[to.key]?.card ?? -1);

  return ringOn(ring, cols, col, kept >= 0 ? kept : startOf(places, to, rows) + height);
};

/** Every card's place in reading order: column by column, top to bottom. */
const readingOrder = (cols: readonly NavColumn[]) =>
  cols.flatMap((c, col) => c.cards.map((_, row) => ({ col, row })));

/** The ring on the first or (`last`) the last card in reading order (the filter's Home / End). */
export const ringReadingEdge = (ring: Ring, cols: readonly NavColumn[], last: boolean): Ring => {
  const order = readingOrder(cols);
  const p = last ? order[order.length - 1] : order[0];

  return p === undefined ? ring : ringOn(ring, cols, p.col, p.row);
};

/**
 * The ring `n` cards on (−: back) in reading order, column by column and top to bottom, crossing
 * columns and passing over empty ones (↓ / ↑ while the `/` filter is typed, so every match is a
 * key away). It stops at the first and the last card; a Board with no card: as it was.
 */
export const ringReading = (ring: Ring, cols: readonly NavColumn[], n: number): Ring => {
  const order = readingOrder(cols);
  const at = ringAt(ring, cols);
  const here = order.findIndex((p) => p.col === at.col && p.row === at.row);

  if (here < 0) return ring;
  const p = order[Math.max(0, Math.min(here + n, order.length - 1))];

  return p === undefined ? ring : ringOn(ring, cols, p.col, p.row);
};

/**
 * A page down (`by` cards) or up (`-by`): the ring and its column's view move together, so the
 * ring keeps its height in view where the column can scroll (Vim's ⌃D / ⌃F, WebStorm's Page Down).
 */
export const ringPaged = (
  ring: Ring,
  places: Places,
  cols: readonly NavColumn[],
  by: number,
  rows: number,
): { ring: Ring; places: Places } => {
  const at = ringAt(ring, cols);
  const c = cols[at.col];

  if (c === undefined) return { ring, places };
  const start = Math.max(0, Math.min(startOf(places, c, rows) + by, c.cards.length - rows));

  return {
    ring: ringOn(ring, cols, at.col, at.row + by),
    places: { ...places, [c.key]: { ...places[c.key], start } },
  };
};

/** The column `key` scrolled `by` cards (the wheel), within what it can show. */
export const scrolled = (
  places: Places,
  cols: readonly NavColumn[],
  key: string,
  by: number,
  rows: number,
): Places => {
  const c = cols.find((x) => x.key === key);

  if (c === undefined) return places;

  return { ...places, [key]: { ...places[key], start: startOf(places, c, rows) + by } };
};

/** The window of a column's `len` cards from `start` (`rows` at once), and the note above / below. */
export const windowOf = (len: number, start: number, rows: number) => {
  const below = Math.max(0, len - start - rows);
  const note = [
    ...(start > 0 ? [`${start} above`] : []),
    ...(below > 0 ? [`+${below} below`] : []),
  ].join(' · ');

  return { start, end: start + rows, note };
};
