/**
 * Chat's cards for the contract. There is one tree per card state of canvas board 6.8 (C-States),
 * plus a permission past its hold and a teammate's read-only card, plus a gallery with every
 * prop. Each is the `@abe/ui` cards model's own output, placed where Chat places it. Cards go at
 * the end of the agent's turn and the pill sits above the composer. The shell's cargo tests
 * (`app/tests/factory_cards.rs`) draw them.
 */
import { askCards, type AskCard, permissionCard } from '@abe/core';
import {
  cardNode,
  type CardFacts,
  type Cards,
  cardsKey,
  cardsRead,
  cardsRun,
  foldedNodes,
  NO_CARDS,
  type Node,
  openOverride,
  pillNode,
} from '@abe/ui';
import { factoryRun } from './ui';

const AT = '2026-10-25T03:00:00.000Z';
const SESSION = 'demo-shop-2-1';
const FACTS: CardFacts = { session: SESSION, card: 2 };

const MARKET = {
  question: 'Which market table should the cart total read?',
  header: "The story's comments mention a per-market setting",
  options: [
    { label: 'The existing market table (Recommended)', description: '' },
    { label: 'A new setting per market', description: '' },
    { label: 'Keep the current behaviour', description: '' },
  ],
};

const ROUNDING = {
  question: 'Round once on the total, or per line?',
  header: 'Rounding per line can give a different total',
  options: [
    { label: 'Once, on the total (Recommended)', description: '' },
    { label: 'Per line', description: '' },
    { label: 'As the market table says', description: '' },
  ],
};

const ROUND = {
  questions: [
    {
      question: 'Static column widths?',
      header: 'Columns',
      options: [
        { label: 'Yes, fixed per view', description: '' },
        { label: 'No, static widths', description: '' },
      ],
    },
    {
      question: 'Status bar per view?',
      header: 'Each view says where you are',
      options: [
        { label: 'Yes, each view names its own place (Recommended)', description: '' },
        { label: 'One status bar for every view', description: '' },
      ],
    },
    {
      question: 'Local marker?',
      header: 'A local workspace in the header',
      options: [
        { label: 'nothing, only a box shows its cloud (Recommended)', description: '' },
        { label: 'A laptop glyph', description: '' },
      ],
    },
  ],
};

const asked = (input: unknown, base: string): AskCard[] =>
  askCards(input, { session: SESSION, base, at: AT }) ?? [];

const typed = (c: Cards, keys: string, f: CardFacts = FACTS): Cards =>
  keys.split(' ').reduce((x, key) => cardsKey(x, key, f).cards, c);

const PROSE: Node = {
  kind: 'Prose',
  id: 'cards:prose',
  props: {
    markdown:
      "VAT can come from two places: the markets table in `markets.ts`, or a per-market value the story's comments ask for. That decides what the fix multiplies, so I'll wait for you before the pull request.",
  },
};

/** The column. The turn's last words come first, then `parts`, and the pill sits at the bottom. */
const column = (id: string, parts: (Node | null)[], pill: Node | null = null): Node => ({
  kind: 'Island',
  id: `cards:${id}`,
  props: {},
  children: [
    {
      kind: 'Stack',
      props: {
        direction: 'column',
        gap: 8,
        pad: [12, 12, 8, 12],
        sizes: [
          ...parts.filter((p) => p !== null).map(() => 'auto' as const),
          'auto',
          { flex: 1 },
          'auto',
        ],
      },
      children: [
        PROSE,
        ...parts.filter((p) => p !== null),
        { kind: 'Stack', props: { direction: 'column' }, children: [] },
        pill ?? { kind: 'Stack', props: { direction: 'column' }, children: [] },
      ],
    },
  ],
});

const open = cardsRead(NO_CARDS, asked({ questions: [MARKET] }, 'q-1'));

const answeredLine = (): Node | null => foldedNodes(typed(open, '1')).map((x) => x.node)[0] ?? null;

const grill = typed(cardsRead(NO_CARDS, asked(ROUND, 'q-7')), '2');

const stack = typed(
  cardsRead(NO_CARDS, [
    ...asked({ questions: [MARKET] }, 'q-1'),
    ...asked({ questions: [ROUNDING] }, 'q-2'),
    ...asked(
      { questions: [{ ...ROUNDING, question: 'Which currency does the total show?' }] },
      'q-3',
    ),
  ]),
  '1',
);

const permission = (expired: string | null) =>
  cardsRead(NO_CARDS, [
    {
      ...permissionCard(
        { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
        {
          session: SESSION,
          id: 'p-1',
          at: AT,
          why: 'Reach: writes only in the worktree',
          where: 'local',
          worktree: '/wt',
        },
      ),
      expired,
    },
  ]);

const needsYou = cardsRun(
  NO_CARDS,
  factoryRun(1, 'Show stock on a product card', 'spec', 'needs-you', {
    session: SESSION,
    reason: 'No stock source: the product API has no stock field, and the story names none',
  }),
  { state: 'waiting' },
);

const override = typed(
  openOverride(NO_CARDS, 'db write test', FACTS),
  'S e e d <Space> t h e <Space> s h o p <Space> f o r <Space> t h e <Space> B e f o r e <Space> c h e c k',
);

/** One tree per card state, by its contract name (`cards-<state>.json`). */
export const CARD_TREES: Readonly<Record<string, Node>> = {
  // C-States · Waiting, row 1 selected (C-Question, R-Question)
  'cards-question': column('question', [cardNode(open, FACTS)]),
  // a multiSelect question: a box per row, two ticked
  'cards-multi': column('multi', [
    cardNode(
      typed(
        cardsRead(NO_CARDS, asked({ questions: [{ ...MARKET, multiSelect: true }] }, 'q-4')),
        '1 3',
      ),
      FACTS,
    ),
  ]),
  // C-States · Answered: one dim line where the card stood (C-Answered)
  'cards-answered': column('answered', [
    answeredLine(),
    {
      kind: 'StepRow',
      id: 'cards:step',
      props: {
        mark: 'live',
        verb: 'Editing',
        object: 'api/src/cart.ts',
        objectKind: 'path',
        time: '2 s',
      },
    },
  ]),
  // R-Anatomy · the deferred pill above the composer (Esc)
  'cards-deferred': column('deferred', [], pillNode(typed(open, '<Esc>'))),
  // C-States · Grill round: Q1 answered, Q2 selected (C-Grill)
  'cards-grill': column('grill', [cardNode(grill, FACTS)]),
  // C-States · Stack: 2 of 3
  'cards-stack': column('stack', [cardNode(stack, FACTS)]),
  // C-States · Own answer, being typed
  'cards-own': column('own', [
    cardNode(typed(open, 'o U s e <Space> t h e <Space> m a r k e t <Space> t a b l e'), FACTS),
  ]),
  // C-States · Override (C-Override)
  'cards-override': column('override', [cardNode(override, FACTS)]),
  // C-States · Permission, only while an Override is live (C-Permission)
  'cards-permission': column('permission', [cardNode(permission(null), FACTS)]),
  // Past its 600 s hold, Claude Code's own dialog answers it
  'cards-permission-expired': column('permission-expired', [
    cardNode(permission('Answer in Terminal mode · ⌃⌘→'), FACTS),
  ]),
  // C-States · Needs you from the Factory run (C-NeedsYou)
  'cards-needs-you': column('needs-you', [cardNode(needsYou, { ...FACTS, card: 1 })]),
  // A teammate's session, read-only
  'cards-teammate': column('teammate', [cardNode(open, { ...FACTS, whose: 'Ada Example' })]),
};

/** Every prop the cards' draw arms read, once. */
export const CARDS_GALLERY: Node = column('gallery', [
  {
    kind: 'QuestionCard',
    id: 'gallery:card',
    props: {
      ask: 'question',
      title: 'Allow Bash: npm run seed -- --target test?',
      mono: 'npm run seed -- --target test',
      why: 'Reach: Test DB read, overridden for this session: Seed the shop',
      where: 'This machine · the command runs outside the sandbox',
      more: 'The seed script writes the shop’s products and markets.\nIt runs against the Test DB the Override lowered.',
      moreOpen: true,
      options: [
        { n: 1, label: 'Allow once', recommended: true },
        {
          n: 2,
          label: 'Open card',
          reason: 'no story to open',
        },
      ],
      own: 'Tell it what to do instead…',
      typing: '',
      selected: 'own',
      stack: { n: 1, of: 2 },
      under: 1,
      foot: '⏎ answer · Esc back to the options',
    },
  },
  {
    kind: 'CardLine',
    id: 'gallery:waiting',
    props: { head: 'Waiting', text: 'No stock source', note: '⌘4 shows it', waiting: true },
  },
  {
    kind: 'OverrideCard',
    id: 'gallery:override',
    props: {
      title: 'Override · Test DB write',
      line: 'Reach lowered for this session only · tracked on #2 and the PR',
      reason: '',
      missing: true,
      error:
        'Test DB write is a write, and write names exist only on a box (ADR 0016): Move to cloud, then override it there',
      facts: [
        { label: 'Reach', text: 'Test DB · read → write' },
        { label: 'Until', text: 'this session ends' },
      ],
      foot: '⏎ override · Esc cancel',
      sending: true,
    },
  },
]);
