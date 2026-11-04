/**
 * Local mode's components for the contract, as boards LM-Board, LM-Held and LM-PR draw them. It has
 * every prop of the band, a dashed card, a local pull request open and merged, and the Held writes
 * list as its wide pick. The screens' own trees (`local-*.json`) come from the screens. This one
 * names each prop once so the shell's cargo tests draw it.
 */
import type { BoardDiscardData, CardData, HeldWrite, LocalModeView, LocalPr } from '@abe/core';
import { localName, localNumber } from '@abe/core';
import type { Answer, Input, Node } from '@abe/ui';
import { minutes } from './ui';

/** The checkout in local mode the samples are of. */
export const LOCAL_CHECKOUT = '/p/demo-shop';

/** A held write of `LOCAL_CHECKOUT`, `n` minutes after `AT`. */
export const heldWrite = (
  seq: number,
  kind: HeldWrite['kind'],
  what: string,
  o: Partial<HeldWrite> = {},
): HeldWrite => ({
  seq,
  at: minutes(seq),
  checkout: LOCAL_CHECKOUT,
  kind,
  what,
  where: 'Shop/Web on dev.azure.com/demo-org',
  card: null,
  to: null,
  open: null,
  ...o,
});

/** A local pull request (`L<n>`) of `LOCAL_CHECKOUT`, of card `card`. */
export const localPr = (
  n: number,
  card: number,
  title: string,
  o: Partial<LocalPr> = {},
): LocalPr => {
  const number = localNumber(n);

  return {
    number,
    name: localName(number),
    checkout: LOCAL_CHECKOUT,
    repo: 'mkdir-swe/demo-shop',
    card,
    head: `card/${card}-checkout-copy`,
    headSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    base: 'main',
    title,
    body: `${title}.\n\nCloses AB#${card} (would). Verified on localhost: 3 of 3 criteria.`,
    file: `/state/local/files/pr-${n}.md`,
    state: 'open',
    openedAt: minutes(n),
    updatedAt: minutes(n),
    mergeCommit: null,
    baseSha: 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9',
    files: [
      { path: `src/cart/${card}.ts`, status: 'M', added: 24, removed: 3 },
      { path: `src/cart/${card}.test.ts`, status: 'A', added: 41, removed: 0 },
    ],
    commits: [
      { sha: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0', subject: `${title}: the rule` },
      { sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', subject: `${title}: its tests` },
    ],
    ...o,
  };
};

/** LM-Board's story. Card 4 moved to Resolved here, and its local pull request L3 is open. */
export const LOCAL_HELD: HeldWrite[] = [
  heldWrite(3, 'card-move', 'move AB#4 to Resolved', {
    card: 4,
    to: 'Resolved',
    open: { kind: 'card', id: 4 },
  }),
  heldWrite(
    2,
    'pr-create',
    'open pull request L3 "Cart total includes shipping" (card/4-cart → main)',
    {
      card: 4,
      where: 'mkdir-swe/demo-shop on GitHub',
      open: { kind: 'local-pr', number: localNumber(3) },
    },
  ),
  heldWrite(1, 'issue-comment', 'comment on #4', {
    card: 4,
    where: 'mkdir-swe/demo-shop on GitHub',
    open: { kind: 'file', path: '/state/local/files/comment-1.md' },
  }),
];

/** `abe local status` for `LOCAL_CHECKOUT`. */
export const localView = (o: Partial<LocalModeView> = {}): LocalModeView => ({
  checkout: LOCAL_CHECKOUT,
  on: true,
  held: LOCAL_HELD,
  prs: [localPr(3, 4, 'Cart total includes shipping')],
  cards: [{ card: 4, state: 'Resolved', assignee: null, added: [], removed: [], at: minutes(3) }],
  ...o,
});

/** `abe local status` answering the Board's read (`local`). */
export const localStatusAnswer = (view: LocalModeView = localView()): Answer => ({
  kind: 'result',
  id: 'local',
  command: 'local status',
  reply: { ok: true, data: view },
});

/** `abe watch`'s `local.held` / `local.pr`. */
export const localHeldEvent = (w: HeldWrite, seq = 50): Input => ({
  kind: 'event',
  event: { seq, at: w.at, type: 'local.held', data: w },
});
export const localPrEvent = (p: LocalPr, seq = 51): Input => ({
  kind: 'event',
  event: { seq, at: p.updatedAt, type: 'local.pr', data: p },
});

/** `abe watch`'s `local.discarded`: Discard local changes in `checkout`. */
export const localDiscardedEvent = (d: Partial<BoardDiscardData> = {}, seq = 52): Input => ({
  kind: 'event',
  event: {
    seq,
    at: minutes(9),
    type: 'local.discarded',
    data: { checkout: LOCAL_CHECKOUT, writes: 1, cards: 0, ...d },
  },
});

/** `abe card list` of a board On this Mac (`board.provider: local`): each card's url `local:`. */
export const thisMacCardsAnswer = (cards: CardData[], mine: boolean): Answer => ({
  kind: 'result',
  id: mine ? 'cards:mine' : 'cards:team',
  command: 'card list',
  reply: {
    ok: true,
    data: {
      board: {
        provider: 'local',
        organization: 'this machine',
        project: 'Board',
        team: 'Board',
        types: ['User Story', 'Bug'],
      },
      mine,
      cards: cards.map((c) => ({ ...c, url: `local:${c.id}` })),
      sprint: null,
    },
  },
});

export const LOCAL_GALLERY: Node = {
  kind: 'Island',
  id: 'local-gallery',
  props: {},
  children: [
    {
      kind: 'Stack',
      props: { direction: 'column', gap: 6, sizes: ['auto', { fixed: 140 }, 'auto', 'auto'] },
      children: [
        {
          kind: 'LocalBand',
          id: 'local-band',
          props: {
            lead: 'Local mode',
            text: 'the board, issues and CI are read from GitHub; writes stay on this machine, agents run here.',
            links: [
              { id: 'local:held', label: '7 held writes' },
              { id: 'local:settings', label: 'Settings' },
            ],
          },
        },
        {
          kind: 'BoardColumns',
          id: 'columns',
          props: {},
          children: [
            {
              kind: 'BoardColumn',
              id: 'col:Active',
              props: { name: 'Active', count: 1 },
              children: [
                {
                  kind: 'BoardCard',
                  id: 'card:1240',
                  props: {
                    card: 1240,
                    type: 'US',
                    initials: 'AE',
                    title: 'Checkout copy for Nordic markets',
                    rail: {
                      segments: ['done', 'done', 'now', 'todo', 'todo'],
                      stage: 'Review',
                      glyph: '●',
                      word: 'Verifying',
                      state: 'running',
                      time: '3 min',
                    },
                    local: 'Resolved here · GitHub: Active',
                    selection: 'selected',
                    tooltip:
                      '#1240 Checkout copy for Nordic markets · Resolved here; GitHub still says Active',
                  },
                },
              ],
            },
          ],
        },
        {
          kind: 'LocalPullRequest',
          id: 'local-pr',
          props: {
            name: '#L3',
            line: 'local · card/1240-checkout-copy → main · not pushed',
            title: 'Checkout copy for Nordic markets',
            about:
              "The Factory's PR stage wrote it here instead of on GitHub: same title, body, checks and evidence. Merge stays local too (main on this machine), or throw it away.",
            checks: [
              { name: 'tests', glyph: '✓', hue: 'good' },
              { name: 'types', glyph: '✓', hue: 'good' },
              { name: 'lint', glyph: '✗', hue: 'bad' },
              { name: 'verify 3/3', glyph: '●', hue: 'warn' },
            ],
            files: [
              { path: 'src/checkout/copy.ts', status: 'M', added: 24, removed: 3 },
              { path: 'src/checkout/copy.nordic.ts', status: 'A', added: 58, removed: 0 },
              { path: 'src/checkout/legacy-copy.ts', status: 'D', added: 0, removed: 17 },
            ],
            diff: true,
            commits: [
              { sha: 'b1c2d3e', subject: 'Checkout copy per Nordic market' },
              { sha: 'a1b2c3d', subject: 'Drop the old copy table' },
            ],
            body: 'Checkout shows its copy in Swedish, Norwegian, Danish and Finnish by market.\n\nCloses #1240 (would). Verified on localhost: 3 of 3 criteria, recording attached.',
            actions: { focus: 'merge' },
            note: 'would open on github.com/mkdir-swe/demo-shop',
          },
        },
        {
          kind: 'LocalPullRequest',
          id: 'local-pr-merged',
          props: {
            name: '#L2',
            line: 'local · card/1238-cart → main · not pushed',
            title: 'Cart total includes shipping',
            about: 'Merged on this machine.',
            body: '',
            done: { text: '✓ Merged into main · 3f2a1b9', hue: 'good' },
            away: true,
          },
        },
      ],
    },
    {
      kind: 'PickLayer',
      id: 'action-menu',
      props: {
        title: 'Held writes · 7',
        caption: 'demo-shop · nothing left this machine',
        wide: true,
        local: true,
        rows: [
          {
            id: 'held:7',
            lead: '09:41',
            text: 'Move card #1240 to Resolved',
            note: 'would go to GitHub Projects · Storefront',
          },
          {
            id: 'held:6',
            lead: '09:38',
            text: 'Open pull request L3 "Checkout copy for Nordic markets"',
            note: 'would go to mkdir-swe/demo-shop on GitHub',
          },
        ],
        selected: 'held:6',
        hint: '⏎ opens it · turning local mode off keeps them here as a record; nothing is ever sent',
      },
    },
  ],
};

const LM_REPO = 'mkdir-swe/demo-shop on GitHub';
const LM_BOARD = 'Storefront/Web on dev.azure.com/demo-org';

/** Boards LM-Board, LM-Held and LM-PR. Card 1240 has seven held writes and local PR L3. */
export const LM_VIEW: LocalModeView = localView({
  checkout: '/home/me/projects/demo-shop',
  held: [
    heldWrite(7, 'card-move', 'move AB#1240 to Resolved', {
      card: 1240,
      to: 'Resolved',
      where: LM_BOARD,
      open: { kind: 'card', id: 1240 },
    }),
    heldWrite(6, 'card-comment', 'comment on AB#1240', {
      card: 1240,
      where: LM_BOARD,
      open: { kind: 'file', path: '/state/local/files/comment-6.md' },
    }),
    heldWrite(
      5,
      'pr-create',
      'open pull request L3 "Checkout copy for Nordic markets" (card/1240-checkout-copy → main)',
      { card: 1240, where: LM_REPO, open: { kind: 'local-pr', number: localNumber(3) } },
    ),
    heldWrite(4, 'push', 'push card/1240-checkout-copy', {
      card: 1240,
      where: 'origin of /home/me/projects/demo-shop-wt/1240-checkout-copy',
    }),
    heldWrite(3, 'issue-create', 'open issue L2 "Checkout copy: SE, NO, DK, FI"', {
      card: 1240,
      where: LM_REPO,
      open: { kind: 'file', path: '/state/local/files/issue-2.md' },
    }),
    heldWrite(2, 'card-move', 'move AB#1240 to Active', {
      card: 1240,
      to: 'Active',
      where: LM_BOARD,
      open: { kind: 'card', id: 1240 },
    }),
    heldWrite(1, 'card-assign', 'assign AB#1240 to me', {
      card: 1240,
      to: 'me',
      where: LM_BOARD,
      open: { kind: 'card', id: 1240 },
    }),
  ].map((w) => ({ ...w, checkout: '/home/me/projects/demo-shop' })),
  prs: [
    localPr(3, 1240, 'Checkout copy for Nordic markets', {
      checkout: '/home/me/projects/demo-shop',
      body: 'Checkout shows its copy in Swedish, Norwegian, Danish and Finnish by market.\n\nCloses AB#1240 (would). Verified on localhost: 3 of 3 criteria, recording attached.',
    }),
  ],
  cards: [
    { card: 1240, state: 'Resolved', assignee: 'me', added: [], removed: [], at: minutes(7) },
  ],
});

/**
 * The board read-only alone (`abe board read-only on`, local mode off): #1240's title edited and
 * two comments on it held here, drawn over the real card, never sent.
 */
export const READ_ONLY_VIEW: LocalModeView = localView({
  checkout: '/home/me/projects/demo-shop',
  on: false,
  readOnlyBoard: true,
  held: [
    heldWrite(3, 'card-comment', 'comment on AB#1240', {
      card: 1240,
      where: LM_BOARD,
      text: 'SE first',
    }),
    heldWrite(2, 'card-comment', 'comment on AB#1240', {
      card: 1240,
      where: LM_BOARD,
      text: 'then NO',
    }),
    heldWrite(1, 'card-write', 'edit AB#1240', {
      card: 1240,
      where: LM_BOARD,
      fields: { title: 'Checkout copy for the Nordics' },
      open: { kind: 'card', id: 1240 },
    }),
  ].map((w) => ({ ...w, checkout: '/home/me/projects/demo-shop' })),
  prs: [],
  cards: [
    {
      card: 1240,
      state: null,
      assignee: null,
      added: [],
      removed: [],
      edited: ['title'],
      comments: 2,
      at: minutes(3),
    },
  ],
});
