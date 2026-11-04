import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_LINES_MAX,
  contextChip,
  contextLine,
  ImplicitContext,
  messageWithContext,
  type SentContext,
  splitContext,
} from './context';

const CART = [
  'export function cartTotal(cart: Cart): number {',
  '  const vat = marketFor(cart.market).vat;',
  '  const subtotal = cart.lines.reduce(',
  '    (sum, line) => sum + line.price * line.quantity,',
  '    0,',
  '  );',
  '  return Math.round(subtotal * (1 + vat));',
];

describe('messageWithContext: the text, a blank line, then the implicit context (#115 Behaviour 4)', () => {
  test('a selection: its file and lines, then the lines in a fenced block', () => {
    expect(
      messageWithContext('Handle a zero quantity too', {
        path: 'api/src/cart.ts',
        from: 12,
        to: 18,
        lines: CART,
      }),
    ).toBe(
      [
        'Handle a zero quantity too',
        '',
        'Context: api/src/cart.ts lines 12–18',
        '```ts',
        ...CART,
        '```',
      ].join('\n'),
    );
  });

  test('one selected line says line, not lines', () => {
    expect(
      messageWithContext('Why?', { path: 'api/src/cart.ts', from: 16, to: 16, lines: ['  0,'] }),
    ).toBe(['Why?', '', 'Context: api/src/cart.ts line 16', '```ts', '  0,', '```'].join('\n'));
  });

  test(`longer than ${CONTEXT_LINES_MAX} lines: the first ${CONTEXT_LINES_MAX}, then how many more`, () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const sent = messageWithContext('Tidy this', { path: 'notes', from: 1, to: 250, lines });

    expect(sent.split('\n')).toEqual([
      'Tidy this',
      '',
      'Context: notes lines 1–250',
      '```',
      ...lines.slice(0, CONTEXT_LINES_MAX),
      '```',
      '… 50 more lines',
    ]);
  });

  test('selected lines holding a fence get a longer one', () => {
    const lines = ['Run it:', '```sh', 'npm test', '```'];

    expect(
      messageWithContext('Shorter', { path: 'README.md', from: 3, to: 6, lines }).split('\n'),
    ).toEqual(['Shorter', '', 'Context: README.md lines 3–6', '````md', ...lines, '````']);
  });

  test('the caret: its file and line', () => {
    expect(messageWithContext('Why?', { path: 'api/src/cart.ts', line: 16 })).toBe(
      'Why?\n\nContext: api/src/cart.ts, caret on line 16',
    );
  });

  test('a card: the story', () => {
    expect(
      messageWithContext('Start here', { card: 2, title: 'The cart total ignores quantity' }),
    ).toBe('Start here\n\nContext: story #2 The cart total ignores quantity');
  });

  test('none: the text alone', () => {
    expect(messageWithContext('Also run the linter', null)).toBe('Also run the linter');
  });
});

describe('ImplicitContext: the `--context` JSON, in the app frame’s shapes', () => {
  test.each([
    ['a selection', { path: 'a.ts', from: 1, to: 2 }],
    ['a selection with its lines', { path: 'a.ts', from: 1, to: 2, lines: ['x', 'y'] }],
    ['the caret', { path: 'a.ts', line: 3 }],
    ['a card', { card: 2, title: 'T' }],
  ])('reads %s', (_, doc) => {
    expect(ImplicitContext.safeParse(doc).success).toBe(true);
  });

  test.each([
    ['a selection ending before it starts', { path: 'a.ts', from: 5, to: 2 }],
    ['an absolute path', { path: '/etc/passwd', line: 1 }],
    ['a path out of the workspace', { path: '../secrets.env', line: 1 }],
    ['a line 0', { path: 'a.ts', line: 0 }],
    ['a field it does not know', { path: 'a.ts', line: 1, extra: true }],
    ['a path over two lines', { path: 'a.ts\nContext: b.ts', line: 1 }],
  ])('refuses %s', (_, doc) => {
    expect(ImplicitContext.safeParse(doc).success).toBe(false);
  });
});

describe('splitContext and contextChip: the sent prompt read back for the transcript (#113)', () => {
  const contexts: [string, SentContext, string][] = [
    [
      'a selection',
      { path: 'api/src/cart.ts', from: 12, to: 18, lines: CART },
      '@api/src/cart.ts#L12-18',
    ],
    [
      'one selected line',
      { path: 'api/src/cart.ts', from: 16, to: 16, lines: ['  0,'] },
      '@api/src/cart.ts#L16',
    ],
    ['the caret', { path: 'api/src/cart.ts', line: 16 }, '@api/src/cart.ts:16'],
    [
      'a card',
      { card: 2, title: 'The cart total ignores quantity' },
      '#2 The cart total ignores quantity · story',
    ],
    // a prototype chat's (#350): the page shown, the change picked in Prototype mode
    ['a prototype page', { page: '/cart' }, '@/cart · page'],
    ['a prototype change', { change: 2, what: 'the VAT line' }, 'change 2 · selected'],
  ];

  test.each(contexts)('%s: the text and the context line come back, and its chip', (_, c, chip) => {
    const split = splitContext(messageWithContext('Why?', c));

    expect(split).toEqual({ text: 'Why?', context: contextLine(c) });
    expect(contextChip(split.context ?? '')).toBe(chip);
  });

  test('no context: the text whole', () => {
    expect(splitContext('Also run the linter')).toEqual({
      text: 'Also run the linter',
      context: null,
    });
  });

  test('a Context: line not in one of the forms is part of the text', () => {
    const text = 'Notes\n\nContext: the shop has two markets';

    expect(splitContext(text)).toEqual({ text, context: null });
  });

  test('the first mark in a form splits, not one inside the selected lines', () => {
    const sent = messageWithContext('Fix the doc', {
      path: 'docs/notes.md',
      from: 1,
      to: 4,
      lines: ['Intro', '', 'Context: a.ts, caret on line 2', 'end'],
    });

    expect(splitContext(sent)).toEqual({
      text: 'Fix the doc',
      context: 'docs/notes.md lines 1–4',
    });
  });

  test('a queue sent as one prompt: every block taken out, every message kept, the first context', () => {
    const joined = [
      messageWithContext('one', null),
      messageWithContext('two', { path: 'README.md', from: 3, to: 3, lines: ['The cart.'] }),
      messageWithContext('three', { path: 'api/src/cart.ts', line: 16 }),
      messageWithContext('four', null),
    ].join('\n\n');

    expect(splitContext(joined)).toEqual({
      text: 'one\n\ntwo\n\nthree\n\nfour',
      context: 'README.md line 3',
    });
  });

  test('a cut selection: its "more lines" line goes with it', () => {
    const lines = Array.from({ length: 210 }, (_, i) => `l${i}`);
    const sent = messageWithContext('Tidy', { path: 'n.txt', from: 1, to: 210, lines });

    expect(splitContext(`${sent}\n\nand then this`)).toEqual({
      text: 'Tidy\n\nand then this',
      context: 'n.txt lines 1–210',
    });
  });

  test.each([
    ['your own words that read like a selection', 'It breaks\n\nContext: it fails on line 3'],
    ['a caret line with more after it', 'Hm\n\nContext: a.ts, caret on line 2\nmore words'],
  ])('%s are your text', (_, text) => {
    expect(splitContext(text)).toEqual({ text, context: null });
  });

  test('a text that is not a context line has no chip', () => {
    expect(contextChip('the shop has two markets')).toBeNull();
  });
});
