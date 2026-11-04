/**
 * The Board's components and its column rules: widths from a width, the sideways scroll, the
 * card's rows.
 */
import { describe, expect, test } from 'bun:test';
import { type BoardCard, columnLayout, columnsOutOfView, columnsProps, firstShown } from './index';
import { Node } from '@abe/testing';

describe('static column widths from a width', () => {
  test.each<[number, number, ReturnType<typeof columnLayout>]>([
    // 1440 less the pads: four columns of about 340 each
    [1400, 4, { scrolled: false }],
    // a 1400 px window with Chat open leaves the Board about 930 (less the pads and the 420 px Chat): all four in view
    [930, 4, { scrolled: false }],
    // 4 × 200 + 3 gaps of 6 is 818: just fits
    [818, 4, { scrolled: false }],
    [817, 4, { scrolled: true, fits: 3 }],
    [600, 4, { scrolled: true, fits: 2 }],
    [200, 4, { scrolled: true, fits: 1 }],
    [100, 0, { scrolled: false }],
  ])('%i px, %i columns', (width, count, layout) => {
    expect(columnLayout(width, count)).toEqual(layout);
  });

  test('scrolled: the columns in view fill it whole (none cut at the edge), moved by whole columns; else nothing to say', () => {
    expect(columnsProps(1400, 4, 0)).toEqual({});
    // 2 fit in 600: (600 - 6) / 2 = 297 each
    expect(columnsProps(600, 4, 0)).toEqual({ scroll: { width: 297, offset: 0, view: 600 } });
    expect(columnsProps(600, 4, 2)).toEqual({ scroll: { width: 297, offset: 606, view: 600 } });
    // 3 fit in 800 (none cut at the edge): (800 - 12) / 3 = 262
    expect(columnsProps(800, 4, 0)).toEqual({ scroll: { width: 262, offset: 0, view: 800 } });
  });
});

describe('the columns out of view are named at the header’s edge', () => {
  const cols = [
    { name: 'New', count: 2 },
    { name: 'Active', count: 1 },
    { name: 'Resolved', count: 1 },
    { name: 'Closed', count: 0 },
  ];

  test.each<[string, number, number, string | undefined]>([
    ['all in view: nothing', 0, 4, undefined],
    ['the last one off to the right', 0, 3, 'Closed 0 ›'],
    ['two off to the right', 0, 2, 'Resolved 1 · Closed 0 ›'],
    ['one off on each side', 1, 2, '‹ New 2 · Closed 0 ›'],
    ['scrolled to the end', 2, 2, '‹ New 2 · Active 1'],
  ])('%s', (_, first, fits, hint) => {
    expect(columnsOutOfView(cols, first, fits)).toBe(hint);
  });

  test('a column not read yet is named without a count', () => {
    expect(columnsOutOfView([{ name: 'New' }, { name: 'Closed' }], 0, 1)).toBe('Closed ›');
  });
});

describe('the selected column stays in view', () => {
  test.each<[string, number, number, number]>([
    ['in view already: nothing moves', 0, 1, 0],
    ['off to the right: the least move that shows it', 0, 3, 2],
    ['off to the left: it becomes the first', 2, 1, 1],
    ['never past the last whole view', 3, 3, 2],
  ])('%s', (_, first, at, shown) => {
    expect(firstShown(first, at, 2, 4)).toBe(shown);
  });
});

describe('the card', () => {
  const card = (props: BoardCard['props']): Node => Node.parse({ kind: 'BoardCard', props });

  test('its rail row: segments, stage, glyph, word in its hue, time, box mark', () => {
    expect(() =>
      card({
        card: 2,
        type: 'Bug',
        bug: true,
        initials: 'AE',
        points: '3 pt',
        title: 'The cart total ignores quantity',
        rail: {
          segments: ['done', 'now', 'todo', 'todo', 'todo'],
          stage: 'Build',
          glyph: '●',
          word: 'Running',
          state: 'running',
          time: '21 min',
          box: 'running',
        },
        selection: 'selected',
      }),
    ).not.toThrow();
  });

  test('no run: a dim note in the rail row’s place', () => {
    expect(() =>
      card({ card: 3, type: 'US', title: 'Pin the Node version', note: { text: 'No session' } }),
    ).not.toThrow();
  });

  test('a glyph or box mark outside the set is refused', () => {
    const rail = {
      segments: [],
      glyph: '★',
      word: 'Running',
      state: 'running',
    };

    expect(() =>
      Node.parse({ kind: 'BoardCard', props: { card: 2, type: 'US', title: 'x', rail } }),
    ).toThrow();
    expect(() =>
      Node.parse({
        kind: 'BoardCard',
        props: { card: 2, type: 'US', title: 'x', rail: { ...rail, glyph: '●', box: 'cloudy' } },
      }),
    ).toThrow();
  });
});
