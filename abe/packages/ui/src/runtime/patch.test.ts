/**
 * Keyed patches at their interface: what `patchOf` says turns one tree into the next, and that
 * applying it gives the next tree (as the window applies it). One row per change; a fix adds a
 * row.
 */
import { describe, expect, test } from 'bun:test';
import { type Node, island, stack } from './components';
import { applyPatch, patchOf, type PatchOp } from './patch';

const row = (id: string, text: string): Node => ({
  kind: 'ListRow',
  id,
  props: { text },
  children: [],
});
const badge = (text: string): Node => ({ kind: 'Badge', props: { text, hue: 'dim' } });
const list = (...rows: Node[]): Node => island([stack('column', rows)], 'list');

const A = row('a', 'Alpha');
const B = row('b', 'Beta');
const C = row('c', 'Gamma');

const ROWS: readonly (readonly [string, Node, Node, readonly PatchOp[]])[] = [
  ['the same tree: nothing', list(A, B), list(A, B), []],
  [
    'a row appended: one splice at its list, the rows before kept',
    list(A, B),
    list(A, B, C),
    [{ path: [0], splice: [2, 0], add: [C] }],
  ],
  [
    'a row put first: one splice, the rows after kept by their ids',
    list(A, B),
    list(C, A, B),
    [{ path: [0], splice: [0, 0], add: [C] }],
  ],
  [
    'a row gone from the middle: one splice taking it out',
    list(A, B, C),
    list(A, C),
    [{ path: [0], splice: [1, 1], add: [] }],
  ],
  [
    'a row’s words changed: that row whole, at its path',
    list(A, B),
    list(A, row('b', 'Beta 2')),
    [{ path: [0, 1], node: row('b', 'Beta 2') }],
  ],
  [
    'a row changed and one appended: the changed one, then the splice',
    list(A, B),
    list(row('a', 'Alpha 2'), B, C),
    [
      { path: [0, 0], node: row('a', 'Alpha 2') },
      { path: [0], splice: [2, 0], add: [C] },
    ],
  ],
  [
    'a kind the window keeps no children of changed inside: it goes whole',
    island([stack('column', [badge('one')])], 'x'),
    island([stack('column', [badge('two')])], 'x'),
    [{ path: [0, 0], node: badge('two') }],
  ],
  [
    'the root another node: one op at the root (the bridge sends the tree whole)',
    list(A),
    island([], 'other'),
    [{ path: [], node: island([], 'other') }],
  ],
  [
    'a stack’s own props changed: the stack whole',
    list(A),
    island([stack('row', [A])], 'list'),
    [{ path: [0], node: stack('row', [A]) }],
  ],
];

describe('keyed patches', () => {
  test.each(ROWS)('%s', (_, was, now, want) => {
    const ops = patchOf(was, now);

    expect(ops).toEqual([...want]);
    expect(applyPatch(was, ops)).toEqual(now);
  });

  test('a path not in the tree applies to nothing', () => {
    expect(applyPatch(list(A), [{ path: [0, 5], node: B }])).toBeUndefined();
    expect(applyPatch(list(A), [{ path: [0], splice: [3, 1], add: [] }])).toBeUndefined();
  });
});
