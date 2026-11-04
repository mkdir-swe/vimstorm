/** Every list's move keys (#334): one rule, Home / End as `gg` / `G` everywhere. */
import { describe, expect, test } from 'bun:test';
import { filterMove, isListMove, listMove, menuMove, movedRow } from './list-moves';

describe('a list’s move keys', () => {
  test('Home / End are gg / G: the first and the last row, a count before them that row', () => {
    expect(listMove('<Home>', 7)).toEqual(listMove('gg', 7));
    expect(listMove('<End>', 7)).toEqual(listMove('G', 7));
    expect(listMove('<End>', 7)).toEqual({ kind: 'to', row: 'last' });
    expect(listMove('<Home>', 7, 5)).toEqual({ kind: 'to', row: 4 });
    expect(listMove('<End>', 7, 3)).toEqual({ kind: 'to', row: 2 });
  });

  test('rows, five rows, pages and Vim’s half pages', () => {
    expect(listMove('ö', 7, 3)).toEqual({ kind: 'by', rows: 3 });
    expect(listMove('<Up>', 7)).toEqual({ kind: 'by', rows: -1 });
    expect(listMove('Ö', 7, 2)).toEqual({ kind: 'by', rows: 10 });
    expect(listMove('<PageDown>', 7, 2)).toEqual({ kind: 'page', rows: 14 });
    expect(listMove('<C-b>', 7)).toEqual({ kind: 'page', rows: -7 });
    expect(listMove('<C-d>', 7)).toEqual({ kind: 'page', rows: 3 });
    expect(listMove('<C-u>', 7, 2)).toEqual({ kind: 'page', rows: -2 });
    expect(listMove('k', 7)).toBeUndefined();
    expect(isListMove('<Home>')).toBe(true);
    expect(isListMove('g')).toBe(false);
  });

  test('a typed filter moves only on keys that never type; a menu on ⌃P ⌃N too, never a letter', () => {
    expect(filterMove('<End>', 7)).toEqual({ kind: 'to', row: 'last' });
    expect(filterMove('<Down>', 7)).toEqual({ kind: 'by', rows: 1 });
    expect(filterMove('ö', 7)).toBeUndefined();
    expect(filterMove('G', 7)).toBeUndefined();
    expect(filterMove('<C-u>', 7)).toBeUndefined();
    expect(menuMove('<C-n>', 7)).toEqual({ kind: 'by', rows: 1 });
    expect(menuMove('<C-p>', 7)).toEqual({ kind: 'by', rows: -1 });
    expect(menuMove('<Home>', 7)).toEqual({ kind: 'to', row: 0 });
    for (const letter of ['k', 'l', 'ö', 'ä', 'L']) expect(menuMove(letter, 7)).toBeUndefined();
  });

  test('the row a move lands on, held within the rows; none selected, ö takes the first', () => {
    expect(movedRow({ kind: 'to', row: 'last' }, 2, 10)).toBe(9);
    expect(movedRow({ kind: 'to', row: 40 }, 2, 10)).toBe(9);
    expect(movedRow({ kind: 'by', rows: -5 }, 2, 10)).toBe(0);
    expect(movedRow({ kind: 'by', rows: 1 }, -1, 10)).toBe(0);
  });
});
