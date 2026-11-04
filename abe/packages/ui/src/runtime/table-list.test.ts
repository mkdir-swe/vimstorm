/** The pane tabs' shared list rules (#137): what fits, the selection, the moves, the `/` filter. */
import { describe, expect, test } from 'bun:test';
import {
  filterNote,
  fits,
  holdOrder,
  keepInView,
  listClick,
  listKey,
  listText,
  type ListOf,
  listScroll,
  selectOn,
  type ListPlace,
  released,
  settle,
  shownRows,
  windowed,
} from './table-list';

/** Rows named by their keys, sorted as given; 3 fit. */
const list = (all: readonly string[], room = 3): ListOf<string> => ({
  all,
  keyOf: (r) => r,
  matches: (r, f) => r.includes(f),
  room,
});
const ROWS = ['a1', 'a2', 'a3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'c10', 'c11', 'c12'];
const START: ListPlace = { top: 0, g: false };

/** The place after `keys`, each through `listKey`, on `l`. */
const keys = (l: ListOf<string>, ks: readonly string[], from: ListPlace = settle(START, l)) =>
  ks.reduce((p, k) => listKey(p, k, l).state, from);

/** The rows drawn, the selected one marked `>`. */
const drawn = (p: ListPlace, l: ListOf<string>): string =>
  windowed(p, l)
    .rows.map((r) => (r === p.selected ? `>${r}` : r))
    .join(' ');

describe('a pane tab’s list', () => {
  test('rows that fit under the header and above the key line; 8 before a size', () => {
    expect(fits(undefined)).toBe(8);
    expect(fits({ width: 900, height: 28 + 24 + 3 * 30 })).toBe(3);
    expect(fits({ width: 900, height: 10 })).toBe(1);
    expect(keepInView(0, 5, 3)).toBe(3);
    expect(keepInView(4, 2, 3)).toBe(2);
    expect(keepInView(1, 2, 3)).toBe(1);
  });

  test('the moves of the tree and Pipelines (#271): counts, L Ö, pages, Home End, gg G', () => {
    const l = list(ROWS);
    const at = (ks: string[]) => keys(l, ks).selected;

    expect(at(['ö'])).toBe('a2');
    expect(at(['5', 'ö'])).toBe('b6');
    expect(at(['1', '0', '<Down>'])).toBe('c11');
    expect(at(['Ö'])).toBe('b6');
    expect(at(['Ö', 'L'])).toBe('a1');
    expect(at(['<PageDown>'])).toBe('b4');
    expect(at(['<PageDown>', '<PageUp>'])).toBe('a1');
    expect(at(['<C-d>'])).toBe('a2');
    expect(at(['<End>'])).toBe('c12');
    expect(at(['<End>', '<Home>'])).toBe('a1');
    // a count before Home / End as before gg / G: that row (#334)
    expect(at(['5', '<Home>'])).toBe('b5');
    expect(at(['3', '<End>'])).toBe('a3');
    expect(at(['G', 'g', 'g'])).toBe('a1');
    expect(at(['G', 'l', 'l'])).toBe('c10');
    // a count is for the next move only; k ä go nowhere
    expect(at(['3', 'x', 'ö'])).toBe('a2');
    expect(at(['ö', 'k', 'ä'])).toBe('a2');
    // not the list's: handed back
    expect(listKey(settle(START, l), '<CR>', l).key).toBe('<CR>');
    expect(listKey(settle(START, l), '<Esc>', l).key).toBe('<Esc>');
  });

  test('the selection follows its row while the rows re-sort, on the same screen row (#264)', () => {
    const before = keys(list(ROWS), ['4', 'ö']);

    expect(drawn(before, list(ROWS))).toBe('a3 b4 >b5');
    // a3 sorts last now (it went to sleep): not held, the rows move; b5 stays on its screen row
    const slept = [...ROWS.filter((r) => r !== 'a3'), 'a3'];
    const free = settle(released(before), list(slept));

    expect(drawn(free, list(slept))).toBe('a2 b4 >b5');
  });

  test('worked with the keys, the order holds; new rows go where the sort puts them (#264)', () => {
    const l = list(ROWS);
    const p = keys(l, ['ö', 'ö']);
    const woke = ['a3', 'a0', ...ROWS.filter((r) => r !== 'a3')];

    expect(drawn(settle(p, list(woke)), list(woke))).toBe('a1 a2 >a3');
    expect(shownRows(settle(p, list(woke)), list(woke)).slice(0, 4)).toEqual([
      'a1',
      'a2',
      'a3',
      'a0',
    ]);
    expect(holdOrder(['x', 'a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['x', 'c', 'd', 'a', 'b']);
    // lost the keyboard: sorted afresh
    expect(shownRows(settle(released(p), list(woke)), list(woke))[0]).toBe('a3');
  });

  test('a selected row that goes gives way to the next, else the one before; the window stays (#267)', () => {
    const l = list(ROWS);
    const p = keys(l, ['5', 'ö']);

    expect(drawn(p, l)).toBe('b4 b5 >b6');
    const gone = list(ROWS.filter((r) => r !== 'b6'));

    expect(drawn(settle(p, gone), gone)).toBe('b4 b5 >b7');
    const end = keys(l, ['G']);
    const last = list(ROWS.slice(0, -1));

    expect(settle(end, last).selected).toBe('c11');
    expect(listClick(settle(START, l), 'b8', l).selected).toBe('b8');
  });

  test('a key acts on the rows as drawn, even ones changed without a settle (#264 #267)', () => {
    const p = settle(START, list(['a', 'b', 'c', 'd']));
    // b sorted first since (a tick moved it): the first key holds that order, not the last one
    const moved = listKey(p, 'ö', list(['b', 'a', 'c', 'd'])).state;

    expect([moved.selected, shownRows(moved, list(['b', 'a', 'c', 'd']))]).toEqual([
      'c',
      ['b', 'a', 'c', 'd'],
    ]);
    // the selected row gone before a settle: ⏎ is its neighbour's, never the first row's
    const onC = keys(list(['a', 'b', 'c', 'd']), ['ö', 'ö']);
    const enter = listKey(onC, '<CR>', list(['a', 'b', 'd']));

    expect([enter.key, enter.state.selected]).toEqual(['<CR>', 'd']);
    expect(windowed(onC, list(['a', 'b', 'd'])).selected).toBe('d');
  });

  test('the / filter (#268, as the Board’s #245): k l ö ä type, arrows and pages move', () => {
    const l = list(ROWS);
    const typed = keys(l, ['ö', '/', '1']);

    expect(typed.filter?.text).toBe('1');
    expect(shownRows(typed, l)).toEqual(['a1', 'c10', 'c11', 'c12']);
    expect(filterNote(typed, l)).toBe('/1▏ · 4 of 12');
    // a2 does not match: the first match; a1 kept while it matches
    expect(typed.selected).toBe('a1');
    expect(keys(l, ['<Down>', '<Down>', '<Up>'], typed).selected).toBe('c10');
    expect(keys(l, ['<PageDown>'], typed).selected).toBe('c12');
    // Home / End the first and last match (#334), never the field's caret
    expect(keys(l, ['<End>'], typed).selected).toBe('c12');
    expect(keys(l, ['<End>', '<Home>'], typed).selected).toBe('a1');
    expect(keys(l, ['<End>'], typed).filter?.text).toBe('1');
    expect(keys(l, ['ö', 'l', 'k', 'ä'], typed).filter?.text).toBe('1ölkä');
    expect(keys(l, ['1', '<BS>', '2'], typed).filter?.text).toBe('12');
    expect(keys(l, ['<C-u>'], typed).filter?.text).toBe('');
  });

  test('the / filter is a macOS field: ← → ⌥← ⌘→ move its caret, typing and ⌫ at it (#314)', () => {
    const l = list(ROWS);
    const typed = keys(l, ['/', 'a', '2', '<Left>', '<Left>', 'c', '<Right>', '<BS>']);

    expect(typed.filter).toMatchObject({ text: 'c2', caret: 1 });
    expect(filterNote(typed, l)).toBe('/c▏2 · 0 of 12');
    // the caret moving keeps the selection
    const down = keys(l, ['<Down>'], keys(l, ['/', '1']));

    expect(keys(l, ['<Left>', '<D-Right>'], down).selected).toBe(down.selected);
    expect(filterNote(listText(keys(l, ['<M-Left>'], down), 'c', l) ?? down, l)).toBe(
      '/c▏1 · 3 of 12',
    );
  });

  test('⏎ is the row’s at once, the filter kept; ⌘⏎ and the jumps are the row’s too', () => {
    const l = list(ROWS);
    const typed = keys(l, ['/', '1', '<Down>']);
    const enter = listKey(typed, '<CR>', l);

    expect([enter.key, enter.state.selected]).toEqual(['<CR>', 'c10']);
    expect(enter.state.filter).toMatchObject({ text: '1', typing: false });
    for (const k of ['<D-CR>', '<C-w>', '<C-i>']) {
      const out = listKey(typed, k, l);

      expect([out.key, out.state.selected, out.state.filter?.typing]).toEqual([k, 'c10', true]);
    }
    // `/` again: a new text, the row kept
    const again = keys(l, ['/'], enter.state);

    expect([again.filter?.text, again.filter?.typing, again.selected]).toEqual(['', true, 'c10']);
  });

  test('Esc while typing puts the row and scroll back; on a kept filter keeps the row (#263)', () => {
    const l = list(ROWS);
    const before = keys(l, ['4', 'ö']);

    expect(drawn(before, l)).toBe('a3 b4 >b5');
    const typing = keys(l, ['/', 'c', '<Down>'], before);

    expect(typing.selected).toBe('c11');
    const cancelled = listKey(typing, '<Esc>', l);

    expect(cancelled.key).toBeUndefined();
    expect(cancelled.state.filter).toBeUndefined();
    expect(drawn(cancelled.state, l)).toBe('a3 b4 >b5');
    // kept (⏎), then Esc: the filter off, the row it chose, the keys still the list's
    const kept = listKey(keys(l, ['<CR>'], typing), '<Esc>', l);

    expect([kept.key, kept.state.filter, kept.state.selected]).toEqual([
      undefined,
      undefined,
      'c11',
    ]);
    expect(drawn(kept.state, l)).toBe('b9 c10 >c11');
    // an empty field puts it back as before `/` too
    expect(drawn(keys(l, ['/', 'c', '<Down>', '<BS>'], before), l)).toBe('a3 b4 >b5');
    expect(listKey(cancelled.state, '<Esc>', l).key).toBe('<Esc>');
  });

  test('5G and 3gg: that row; ⌃F ⌃B a page', () => {
    const l = list(ROWS);

    expect(keys(l, ['5', 'G']).selected).toBe('b5');
    expect(keys(l, ['G', '3', 'g', 'g']).selected).toBe('a3');
    expect(keys(l, ['<C-f>']).selected).toBe('b4');
    expect(keys(l, ['<C-f>', '<C-b>']).selected).toBe('a1');
  });

  test('the wheel moves the view, not the selection (#323): kept in the list, a move brings it back', () => {
    const l = list(ROWS);
    const start = settle(START, l);
    const down = listScroll(start, 2, l);

    expect(drawn(down, l)).toBe('a3 b4 b5');
    expect(down.selected).toBe('a1');
    // never past the last screenful, nor above the first row
    expect(drawn(listScroll(down, 50, l), l)).toBe('c10 c11 c12');
    expect(drawn(listScroll(down, -50, l), l)).toBe('>a1 a2 a3');
    // the view stays where the wheel left it as the list settles again (a read, a tick)
    expect(drawn(settle(down, l), l)).toBe('a3 b4 b5');
    // a move goes from the selection, the window only as far as brings it in; a click selects in
    // the view
    expect(drawn(keys(l, ['ö'], down), l)).toBe('>a2 a3 b4');
    expect(drawn(listClick(down, 'b4', l), l)).toBe('a3 >b4 b5');
    // all rows fit: nothing to scroll
    const two = list(['a1', 'a2']);

    expect(drawn(listScroll(settle(START, two), 1, two), two)).toBe('>a1 a2');
    // `/` then Esc, or the field emptied: the view back where the wheel left it
    expect(drawn(keys(l, ['/', 'c', '<Esc>'], down), l)).toBe('a3 b4 b5');
    expect(drawn(keys(l, ['/', 'c', '<BS>'], down), l)).toBe('a3 b4 b5');
    // the selection put from outside (the Board's card): the window goes to it
    expect(drawn(settle(selectOn(down, 'c11'), l), l)).toBe('b9 c10 >c11');
  });
});
