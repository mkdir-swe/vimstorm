/**
 * The rendered Chat's trees for the contract. `CHAT_TURN` is canvas board R-Turn's Chat column end
 * to end: its header, your message and one turn that changed code. `CHAT_TURN_GALLERY` has every
 * prop of the Chat parts and the header. The shell's cargo tests draw both, and the transcript
 * model can check its trees against `CHAT_TURN`.
 */
import {
  type ChatHeader,
  changesBar,
  type DiffLine,
  diffCard,
  type FileChange,
  type Node,
  stepRow,
} from '@abe/ui';

const ctx = (number: number, text: string): DiffLine => ({ kind: 'context', number, text });
const ins = (number: number, text: string): DiffLine => ({ kind: 'inserted', number, text });
const del = (number: number, text: string): DiffLine => ({ kind: 'deleted', number, text });

export const CART_TS: FileChange = {
  path: 'api/src/cart.ts',
  added: 3,
  removed: 1,
  lines: [
    ctx(14, 'export function cartTotal(cart: Cart): number {'),
    ctx(15, '  const vat = marketFor(cart.market).vat;'),
    ctx(16, '  const subtotal = cart.lines.reduce('),
    del(17, '    (sum, line) => sum + line.price,'),
    ins(17, '    (sum, line) => {'),
    ins(18, '      return sum + line.price * line.quantity;'),
    ins(19, '    },'),
    ctx(20, '    0,'),
    ctx(21, '  );'),
  ],
};

export const CART_TEST_TS: FileChange = {
  path: 'api/test/cart.test.ts',
  added: 1,
  removed: 1,
  lines: [
    ctx(19, '});'),
    ctx(20, ''),
    del(21, "test.skip('every unit of a line counts', () => {"),
    ins(21, "test('every unit of a line counts', () => {"),
  ],
};

const PROSE = [
  "`cartTotal` added each line's price once, so a line with 3 of one item was charged as 1.",
  '',
  '- Each line now counts its price times its quantity, before VAT.',
  '- The skipped test for every unit of a line runs again and passes.',
  '',
  "12 tests pass. The one still skipped covers currency rounding, which this story doesn't touch.",
  '',
  'Keep the changes, or tell me what to adjust.',
].join('\n');

const MODES = [
  { id: 'chat:mode:chat', label: 'Chat', tooltip: 'Chat  ⌃⌘←' },
  {
    id: 'chat:mode:terminal',
    label: 'Claude Code',
    tooltip: "Claude Code: the session's own terminal  ⌃⌘→",
  },
];

const STORY = { id: '#2', title: 'The cart total ignores quantity' };

/** R-Turn's header: Build, running 21 minutes in the Local sandbox, two subagents. */
export const CHAT_TURN_HEADER: ChatHeader = {
  kind: 'ChatHeader',
  id: 'chat:header',
  props: {
    title: 'Chat',
    story: STORY,
    modes: MODES,
    mode: 'chat:mode:chat',
    menu: 'chat:menu',
    hide: 'chat:hide',
    env: 'Local sandbox',
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
  },
};

/** Canvas board R-Turn's Chat column: header, your message, the turn (changes first). */
export const CHAT_TURN: Node = {
  kind: 'Island',
  id: 'chat',
  props: {},
  children: [
    {
      kind: 'Stack',
      props: { direction: 'column', sizes: ['auto', { flex: 1 }] },
      children: [
        CHAT_TURN_HEADER,
        {
          kind: 'Transcript',
          id: 'chat:transcript',
          props: {},
          children: [
            {
              kind: 'ChatMessage',
              id: 'msg:1',
              props: {
                text: "Fix the cart total: it ignores each line's quantity",
                context: '#2 The cart total ignores quantity · story',
              },
            },
            {
              kind: 'Turn',
              id: 'turn:1',
              props: {},
              children: [
                changesBar('changes:1', [CART_TS, CART_TEST_TS]),
                diffCard('diff:1:api/src/cart.ts', CART_TS),
                diffCard('diff:1:api/test/cart.test.ts', CART_TEST_TS, { folded: true }),
                stepRow('step:1:1', {
                  mark: 'good',
                  verb: 'Read',
                  object: 'api/src/cart.ts',
                  objectKind: 'path',
                }),
                stepRow('step:1:2', {
                  mark: 'bad',
                  verb: 'Ran',
                  object: 'npm test',
                  objectKind: 'command',
                  result: '1 failed · cart total ignores quantity',
                }),
                stepRow('step:1:3', {
                  mark: 'good',
                  verb: 'Ran',
                  object: 'npm test',
                  objectKind: 'command',
                  result: '12 passed · 1 skipped',
                }),
                { kind: 'Prose', id: 'prose:1', props: { markdown: PROSE } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const many = (n: number): DiffLine[] =>
  Array.from({ length: n }, (_, i) => ctx(i + 1, `const line${i + 1} = ${i + 1};`));

/** Every prop of the Chat parts and the header, once. Headers are 420 px, the transcript 320. */
export const CHAT_TURN_GALLERY: Node = {
  kind: 'Island',
  id: 'chat-turn-gallery',
  props: {},
  children: [
    {
      kind: 'Stack',
      props: {
        direction: 'row',
        gap: 12,
        sizes: [{ fixed: 420 }, { fixed: 320 }],
        align: 'stretch',
      },
      children: [
        {
          kind: 'Stack',
          props: { direction: 'column', gap: 8, align: 'stretch' },
          children: [
            {
              kind: 'ChatHeader',
              id: 'gallery:header:box',
              props: {
                ...CHAT_TURN_HEADER.props,
                box: { name: 'demo-shop-102', state: 'running' },
                override: 'Test DB write · overridden by you: Seed the shop for the Before check',
              },
            },
            {
              kind: 'ChatHeader',
              id: 'gallery:header:need',
              props: {
                title: 'Chat',
                modes: [
                  { id: 'chat:mode:chat', label: 'Chat', needsYou: true },
                  { id: 'chat:mode:terminal', label: 'Claude Code' },
                ],
                mode: 'chat:mode:terminal',
                story: STORY,
                box: { name: 'demo-shop-3', state: 'asleep' },
                rail: {
                  segments: ['done', 'need', 'todo', 'todo', 'todo'],
                  stage: 'Build',
                  state: 'needs-you',
                  glyph: '◆',
                  word: 'Needs you',
                  elapsed: '21 min',
                },
                subagents: 2,
              },
            },
            {
              kind: 'ChatHeader',
              id: 'gallery:header:starting',
              props: {
                title: 'Chat',
                story: { id: '#1', title: 'Show stock on a product card' },
                box: { name: 'demo-shop-1', state: 'starting' },
                rail: {
                  segments: ['wait', 'todo', 'todo', 'todo', 'todo'],
                  stage: 'Spec',
                  state: 'starting',
                  glyph: '●',
                  word: 'Starting',
                },
              },
            },
            {
              kind: 'QueuedMessage',
              id: 'queued:1',
              props: { text: 'also handle a zero quantity', remove: 'queued:1:remove' },
            },
          ],
        },
        {
          kind: 'Transcript',
          id: 'gallery:transcript',
          props: {},
          children: [
            { kind: 'ChatMessage', props: { text: 'A message without a chip' } },
            { kind: 'StageDivider', props: { from: 'Build', to: 'Review', at: '12:41' } },
            // a reopened session's mark has no `to`
            { kind: 'StageDivider', props: { from: 'Reopened', to: '', at: '09:14' } },
            {
              kind: 'Turn',
              props: {},
              children: [
                {
                  kind: 'ChangesBar',
                  id: 'gallery:changes',
                  props: {
                    kept: true,
                    files: 1,
                    added: 1,
                    removed: 0,
                    where: '~/.config/abe/user.json',
                    actions: [{ id: 'undo', label: 'Undo' }],
                  },
                },
                diffCard(
                  'gallery:diff',
                  { path: 'web/src/total.js', added: 30, removed: 0, lines: many(30) },
                  { selected: true },
                ),
                {
                  kind: 'DiffCard',
                  props: {
                    path: 'README',
                    added: 1,
                    removed: 0,
                    lines: [ins(1, '// a plain file, no colours')],
                    lang: 'text',
                  },
                },
                { kind: 'StepsFold', id: 'gallery:steps', props: { count: 12 } },
                stepRow('gallery:step:search', {
                  mark: 'good',
                  verb: 'Searched',
                  object: '"quantity"',
                  objectKind: 'text',
                  result: '4 files',
                }),
                stepRow(
                  'gallery:step:failed',
                  {
                    mark: 'bad',
                    verb: 'Ran',
                    object: 'npm test',
                    objectKind: 'command',
                    result: '1 failed · cart total ignores quantity',
                    selected: true,
                  },
                  {
                    unfolded: true,
                    output: [
                      'FAIL  cart total ignores quantity',
                      'AssertionError: expected 375 to be 1125',
                      ' ❯ test/cart.test.ts:21:30',
                      'Tests  1 failed | 10 passed | 2 skipped (13)',
                    ],
                  },
                ),
                stepRow('gallery:step:live', {
                  mark: 'live',
                  verb: 'Running',
                  object: 'npm test',
                  objectKind: 'command',
                  time: '4 s',
                }),
                // past ten lines of output, the row shows `show N more`
                stepRow(
                  'gallery:step:long',
                  { mark: 'good', verb: 'Ran', object: 'npm run build', objectKind: 'command' },
                  {
                    unfolded: true,
                    output: Array.from({ length: 12 }, (_, i) => `built chunk ${i + 1}`),
                  },
                ),
                {
                  kind: 'Prose',
                  id: 'gallery:prose',
                  props: {
                    markdown: [
                      'One line with `code`, then a list that wraps in a narrow column:',
                      '',
                      '- Each line now counts its price times its quantity, before VAT.',
                      '- The skipped test for every unit of a line runs again and passes.',
                    ].join('\n'),
                  },
                },
              ],
            },
            { kind: 'NewBelow', id: 'gallery:new', props: { count: 3 } },
          ],
        },
      ],
    },
  ],
};
