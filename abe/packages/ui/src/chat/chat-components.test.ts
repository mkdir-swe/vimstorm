import { describe, expect, test } from 'bun:test';
import {
  changesBar,
  DIFF_CARD_LINES,
  type DiffLine,
  diffCard,
  type FileChange,
  STEP_OUTPUT_LINES,
  stepRow,
} from './chat-components';
import { Node } from '../runtime/components';
import type { ChatHeader } from './terminal';

const lines = (n: number): DiffLine[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'context', number: i + 1, text: `line ${i + 1}` }));

const cart: FileChange = { path: 'api/src/cart.ts', added: 3, removed: 1, lines: lines(9) };
const test_: FileChange = { path: 'api/test/cart.test.ts', added: 1, removed: 1, lines: lines(4) };

describe('a diff card', () => {
  test('shows its lines with `⏎ open · u revert` while it has no more than 12', () => {
    const card = diffCard('diff:cart', cart);

    expect(card.props.lines).toHaveLength(9);
    expect(card.props.note).toBe('⏎ open · u revert');
    expect(card.props.more).toBeUndefined();
    expect(Node.safeParse(card).success).toBe(true);
  });

  test('stops at 12 lines and says how many more, a click on <id>:more', () => {
    const card = diffCard('diff:big', { ...cart, lines: lines(30) });

    expect(card.props.lines).toHaveLength(DIFF_CARD_LINES);
    expect(card.props.more).toEqual({ count: 18, id: 'diff:big:more' });
  });

  test('full shows every line', () => {
    const card = diffCard('diff:big', { ...cart, lines: lines(30) }, { full: true });

    expect(card.props.lines).toHaveLength(30);
    expect(card.props.more).toBeUndefined();
  });

  test('folded is its header only: `show 4 lines`', () => {
    const card = diffCard('diff:test', test_, { folded: true });

    expect(card.props).toEqual({
      path: 'api/test/cart.test.ts',
      added: 1,
      removed: 1,
      lines: [],
      note: 'show 4 lines',
      folded: true,
    });
    expect(diffCard('d', { ...test_, lines: lines(1) }, { folded: true }).props.note).toBe(
      'show 1 line',
    );
  });

  test('selected says so', () => {
    expect(diffCard('d', cart, { selected: true }).props.selected).toBe(true);
    expect(diffCard('d', cart).props.selected).toBeUndefined();
  });
});

describe('the changes bar', () => {
  test("counts the turn's files and lines, with Open all · Keep · Revert", () => {
    const bar = changesBar('changes:1', [cart, test_]);

    expect(bar.props.files).toBe(2);
    expect([bar.props.added, bar.props.removed]).toEqual([4, 2]);
    expect(bar.props.actions?.map((a) => [a.id, a.label])).toEqual([
      ['changes:1:open-all', 'Open all'],
      ['changes:1:keep', 'Keep'],
      ['changes:1:revert', 'Revert'],
    ]);
    expect(Node.safeParse(bar).success).toBe(true);
  });
});

describe('a step row', () => {
  const ran = { mark: 'bad', verb: 'Ran', object: 'npm test', objectKind: 'command' } as const;

  test('folded carries no output', () => {
    const row = stepRow('step:3', ran, { output: ['FAIL'] });

    expect(row.props.unfolded).toBeUndefined();
    expect(row.props.output).toBeUndefined();
  });

  test('unfolded shows at most 10 lines of its output, then `show N more` (#343)', () => {
    const out = Array.from({ length: 40 }, (_, i) => `out ${i}`);
    const row = stepRow('step:3', ran, { output: out, unfolded: true });

    expect(row.props.output).toEqual(out.slice(0, STEP_OUTPUT_LINES));
    expect(row.props.more).toEqual({ count: 30, id: 'step:3:more' });
    expect(Node.safeParse(row).success).toBe(true);
    // the cursor on it, then every line once full
    expect(
      stepRow('step:3', ran, { output: out, unfolded: true, moreSelected: true }).props.more,
    ).toEqual({ count: 30, id: 'step:3:more', selected: true });
    const full = stepRow('step:3', ran, { output: out, unfolded: true, full: true });

    expect(full.props.output).toEqual(out);
    expect(full.props.more).toBeUndefined();
    // ten lines or fewer: nothing more to show; folded: no output at all
    expect(stepRow('step:3', ran, { output: out.slice(0, 10), unfolded: true }).props.more).toBe(
      undefined,
    );
    expect(stepRow('step:3', ran, { output: out }).props).not.toHaveProperty('more');
  });
});

describe('the schemas', () => {
  test('refuse a mark, a line kind or a count the parts do not have', () => {
    expect(Node.safeParse({ kind: 'StepRow', props: { mark: 'warn', verb: 'Ran' } }).success).toBe(
      false,
    );
    expect(
      Node.safeParse({
        kind: 'DiffCard',
        props: { path: 'a', added: 0, removed: 0, lines: [{ kind: 'changed', text: '' }] },
      }).success,
    ).toBe(false);
    expect(Node.safeParse({ kind: 'StepsFold', props: { count: 0 } }).success).toBe(false);
    expect(Node.safeParse({ kind: 'ChangesBar', props: { files: -1 } }).success).toBe(false);
  });

  test("check a transcript's and a turn's children", () => {
    const turn = { kind: 'Turn', props: {}, children: [{ kind: 'Oops', props: {} }] };

    expect(Node.safeParse({ kind: 'Transcript', props: {}, children: [turn] }).success).toBe(false);
    expect(
      Node.safeParse({
        kind: 'Transcript',
        props: {},
        children: [
          { kind: 'Turn', props: {}, children: [{ kind: 'Prose', props: { markdown: 'ok' } }] },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("2.1's Chat header", () => {
  const signal: ChatHeader = {
    kind: 'ChatHeader',
    props: {
      title: 'Chat',
      story: { id: '#2', title: 'The cart total ignores quantity' },
      modes: [
        { id: 'chat:mode:chat', label: 'Chat', tooltip: 'Chat  ⌘2' },
        { id: 'chat:mode:terminal', label: 'Terminal' },
      ],
      mode: 'chat:mode:chat',
      menu: 'chat:menu',
      hide: 'chat:hide',
      box: { name: 'demo-shop-102', state: 'starting' },
      hint: '⌘⏎',
      rail: {
        segments: ['done', 'now', 'todo', 'todo', 'todo'],
        stage: 'Build',
        state: 'running',
        glyph: '●',
        word: 'Running',
        elapsed: '21 min',
      },
      subagents: 2,
      override: 'Test DB write · overridden by you: Seed the shop for the Before check',
    },
  };

  test('parses beside 2.0’s props', () => {
    expect(Node.parse(signal)).toEqual(signal);
  });

  test('a box is running, asleep or starting', () => {
    const asleep = { ...signal, props: { ...signal.props, box: { name: 'b', state: 'asleep' } } };
    const off = { ...signal, props: { ...signal.props, box: { name: 'b', state: 'stopped' } } };

    expect(Node.safeParse(asleep).success).toBe(true);
    expect(Node.safeParse(off).success).toBe(false);
  });
});
