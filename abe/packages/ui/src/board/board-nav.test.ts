/**
 * The Board's navigation, driven as the bridge drives it: the ring (the selected card) moves and
 * the view follows. A column scrolls only to keep the ring in view and keeps its scroll and its
 * card when the ring leaves it. Opened again from the Editor, the ring lands on the oldest run
 * waiting on you, and the stripe says who waits.
 */
import { describe, expect, test } from 'bun:test';
import type { CardData, Event } from '@abe/core';
import {
  BOARD_SIZE,
  boardReplies,
  type BoardWorld,
  chatCommands,
  chatOpened,
  type Command,
  type Drive,
  driveBoard,
  factoryRun,
  type Input,
  listCard,
  minutes,
  type Node,
  nodeById,
  nodesOf,
  type Replies,
  session,
} from '@abe/testing';

/** A key by its name, an input, or the reads asked answered by these replies. */
type Act = string | Input | Replies;

const act = (d: Drive<Node>, acts: readonly Act[]) => {
  for (const a of acts) {
    if (typeof a === 'string') d.keys(a);
    else if (typeof a === 'function') d.answer(a);
    else d.send(a);
  }
};

/**
 * Each step's acts, then what it sees. A step after the first sees only the commands that came
 * since the step before, and of the reads only those still asked.
 */
const stepThrough = <Seen>(
  d: Drive<Node>,
  steps: readonly (readonly [readonly Act[], Seen])[],
  seen: (d: Drive<Node>, since: readonly Command[], want: Seen) => Seen,
) => {
  steps.forEach(([acts, want], i) => {
    const before = new Set(i === 0 ? [] : d.commands);

    act(d, acts);
    expect([
      i,
      seen(
        d,
        d.commands.filter((c) => !before.has(c)),
        want,
      ),
    ]).toEqual([i, want]);
  });
};

const effectsOf = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'shell' ? [c.effect] : []));

const propsOf = (tree: Node, id: string): Record<string, unknown> => {
  const p: Record<string, unknown> = nodeById(tree, id).props;

  return p;
};

/** A column as the QA transcripts write it: `New (7 above): 108 … >114`. */
const column = (tree: Node, name: string): string => {
  const col = nodeById(tree, `col:${name}`);
  const p: Record<string, unknown> = col.props;
  const cards = nodesOf(col)
    .filter((n) => n.kind === 'BoardCard')
    .map((n) => {
      const c: Record<string, unknown> = n.props;

      return `${c.selection === 'selected' ? '>' : ''}${String(c.card)}`;
    });
  const note = typeof p.note === 'string' ? ` (${p.note})` : '';

  return `${name}${note}: ${cards.join(' ')}`;
};

/** The card drawn selected: blue while the Board has the keys, grey while Chat has them. */
const selectedCard = (tree: Node): string | undefined =>
  nodesOf(tree).find(
    (n) =>
      n.kind === 'BoardCard' &&
      (n.props.selection === 'selected' || n.props.selection === 'selected-inactive'),
  )?.id;

/** The `/` filter's line in the head, null with none. */
const headOf = (tree: Node): string | null => {
  const note = propsOf(tree, 'board-head').note;

  return typeof note === 'string' ? note : null;
};

/** serve came up again: the Board reads everything again. */
const serveStarted: Input = {
  kind: 'event',
  event: {
    seq: 40,
    at: minutes(9),
    type: 'serve.started',
    data: { version: '0.0.0', pid: 1, socket: '/tmp/abe.sock' },
  } satisfies Event,
};

// ---------------------------------------------------------------- the ring and the view

/** 14 cards in New (101 to 114, Story 1 to 14), 3 in Resolved (201 to 203, Story 15 to 17). */
const NEW_AND_RESOLVED = [
  ...Array.from({ length: 14 }, (_, i) => listCard(101 + i, `Story ${i + 1}`, 'New')),
  ...Array.from({ length: 3 }, (_, i) => listCard(201 + i, `Story ${i + 15}`, 'Resolved')),
];

/** Typed into the `/` filter: Story 1, 10 to 14 in New and 15 to 17 in Resolved. */
const TORY_1 = ['t', 'o', 'r', 'y', '<Space>', '1'];

const wheel = (id: string, x: number, y: number): Input => ({ kind: 'scroll', id, x, y });

/** What a step looks at: the columns named, and only the other parts it names. */
type Seen = {
  cols?: Readonly<Record<string, string>>;
  /** The `/` filter's line, null with none. */
  head?: string | null;
  /** New's word with no card in it. */
  empty?: string;
  /** The columns' sideways scroll. */
  scroll?: unknown;
  /** The card whose Card page ⏎ opened last (no workspace here: the `card` screen). */
  opened?: number;
  /** The keys the Board handed back unhandled. */
  unhandled?: readonly string[];
};

type Nav = { cards?: CardData[]; width?: number; steps: readonly [readonly Act[], Seen][] };

const seenOf = (d: Drive<Node>, since: readonly Command[], want: Seen): Seen => {
  const got: Seen = {};

  if (want.cols !== undefined)
    got.cols = Object.fromEntries(Object.keys(want.cols).map((c) => [c, column(d.tree, c)]));
  if ('head' in want) got.head = headOf(d.tree);
  if ('empty' in want) got.empty = String(propsOf(d.tree, 'col:New').empty);
  if ('scroll' in want) got.scroll = propsOf(d.tree, 'columns').scroll;
  if ('opened' in want) {
    const open = since.findLast((c) => c.kind === 'open' && c.screen === 'card');

    if (open?.kind === 'open') got.opened = Number(open.params?.card);
  }
  if ('unhandled' in want)
    got.unhandled = effectsOf(since).flatMap((e) => (e.kind === 'unhandled' ? [e.key] : []));

  return got;
};

const navWorld = (cards: CardData[]): BoardWorld => ({
  mine: cards,
  team: cards,
  runs: [],
  sessions: [],
});

/** 846 px high: seven cards a column. */
const navigate = ({ cards = NEW_AND_RESOLVED, width, steps }: Nav) => {
  stepThrough(
    driveBoard({
      world: navWorld(cards),
      ...(width === undefined ? {} : { size: { ...BOARD_SIZE, width } }),
    }),
    steps,
    seenOf,
  );
};

describe('the ring moves, the view follows', () => {
  test.each<[string, Nav]>([
    [
      'after G, l moves the ring up inside the view; the view moves only past its top',
      {
        steps: [
          [['G'], { cols: { New: 'New (7 above): 108 109 110 111 112 113 >114' } }],
          [['l', 'l', 'l'], { cols: { New: 'New (7 above): 108 109 110 >111 112 113 114' } }],
          [['l', 'l', 'l'], { cols: { New: 'New (7 above): >108 109 110 111 112 113 114' } }],
          [['l'], { cols: { New: 'New (6 above · +1 below): >107 108 109 110 111 112 113' } }],
        ],
      },
    ],
    [
      'going down from the top moves the view only past its bottom',
      {
        steps: [
          [
            ['ö', 'ö', 'ö', 'ö', 'ö', 'ö'],
            { cols: { New: 'New (+7 below): 101 102 103 104 105 106 >107' } },
          ],
          [['ö'], { cols: { New: 'New (1 above · +6 below): 102 103 104 105 106 107 >108' } }],
        ],
      },
    ],
    [
      // Active is empty: no stop
      'a column the ring leaves keeps its scroll',
      {
        steps: [
          [
            ['G', 'l', 'l', 'l', 'ä'],
            {
              cols: {
                New: 'New (7 above): 108 109 110 111 112 113 114',
                Resolved: 'Resolved: 201 202 >203',
              },
            },
          ],
        ],
      },
    ],
  ])('%s', (_, nav) => {
    navigate(nav);
  });
});

describe('each column remembers its card', () => {
  test.each<[string, Nav]>([
    [
      'ä into a shorter column and k back: the card you left, again and again',
      {
        steps: [
          [
            ['ö', 'ö', 'ö', 'ö', 'ö'],
            { cols: { New: 'New (+7 below): 101 102 103 104 105 >106 107' } },
          ],
          // over the empty Active in one press
          [['ä'], { cols: { Resolved: 'Resolved: 201 202 >203' } }],
          [['k'], { cols: { New: 'New (+7 below): 101 102 103 104 105 >106 107' } }],
          // and again: the card does not creep
          [['ä', 'l', 'k'], { cols: { New: 'New (+7 below): 101 102 103 104 105 >106 107' } }],
          [['ä'], { cols: { Resolved: 'Resolved: 201 >202 203' } }],
        ],
      },
    ],
    [
      'over an empty column the height in view goes along',
      {
        cards: [
          ...NEW_AND_RESOLVED.slice(0, 14),
          ...Array.from({ length: 10 }, (_, i) => listCard(401 + i, `Done ${i}`, 'Resolved')),
        ],
        steps: [
          [['ö', 'ö', 'ö'], { cols: { New: 'New (+7 below): 101 102 103 >104 105 106 107' } }],
          // New › (Active empty, no stop) › Resolved: the fourth card in view there too
          [['ä'], { cols: { Resolved: 'Resolved (+3 below): 401 402 403 >404 405 406 407' } }],
        ],
      },
    ],
    [
      'a column not been in yet: the card at the same height on screen',
      {
        cards: [
          ...NEW_AND_RESOLVED,
          ...Array.from({ length: 10 }, (_, i) => listCard(301 + i, `Doing ${i}`, 'Active')),
        ],
        steps: [
          // 111 is the fourth card shown in New
          [['G', 'l', 'l', 'l'], { cols: { New: 'New (7 above): 108 109 110 >111 112 113 114' } }],
          [['ä'], { cols: { Active: 'Active (+3 below): 301 302 303 >304 305 306 307' } }],
        ],
      },
    ],
  ])('%s', (_, nav) => {
    navigate(nav);
  });
});

describe('counts and pages', () => {
  test.each<[string, Nav]>([
    [
      'a count before a move: 3ö three cards, 2l two, 10ö to the 11th',
      {
        steps: [
          [['3', 'ö'], { cols: { New: 'New (+7 below): 101 102 103 >104 105 106 107' } }],
          [['2', 'l'], { cols: { New: 'New (+7 below): 101 >102 103 104 105 106 107' } }],
          [
            ['1', '0', 'ö'],
            { cols: { New: 'New (5 above · +2 below): 106 107 108 109 110 111 >112' } },
          ],
        ],
      },
    ],
    [
      'a count with G or gg goes to that card; Esc drops a count and is not the Board’s Esc',
      {
        steps: [
          [['5', 'G'], { cols: { New: 'New (+7 below): 101 102 103 104 >105 106 107' } }],
          [['2', 'g', 'g'], { cols: { New: 'New (+7 below): 101 >102 103 104 105 106 107' } }],
          [['3', '<Esc>', 'ö'], { cols: { New: 'New (+7 below): 101 102 >103 104 105 106 107' } }],
          [['4', '<Esc>'], { unhandled: [] }],
        ],
      },
    ],
    [
      'Home and End are gg and G: the first and last card, a count the nth, the view following',
      {
        steps: [
          [['<End>'], { cols: { New: 'New (7 above): 108 109 110 111 112 113 >114' } }],
          [['<Home>'], { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } }],
          [['3', '<End>'], { cols: { New: 'New (+7 below): 101 102 >103 104 105 106 107' } }],
          [
            ['<Home>', 'ä', 'k', '<End>'],
            { cols: { New: 'New (7 above): 108 109 110 111 112 113 >114' } },
          ],
        ],
      },
    ],
    [
      'PageDown and PageUp (⌃F ⌃B) move a page, the view with them',
      {
        steps: [
          [['<PageDown>'], { cols: { New: 'New (7 above): >108 109 110 111 112 113 114' } }],
          [['<PageDown>'], { cols: { New: 'New (7 above): 108 109 110 111 112 113 >114' } }],
          [['<PageUp>'], { cols: { New: 'New (+7 below): 101 102 103 104 105 106 >107' } }],
          [['<PageUp>'], { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } }],
          [['<C-f>'], { cols: { New: 'New (7 above): >108 109 110 111 112 113 114' } }],
          [['<C-b>'], { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } }],
        ],
      },
    ],
    [
      '⌃D and ⌃U half a page, as in Vim, the ring where it was in view; a count is how many',
      {
        steps: [
          [['<C-d>'], { cols: { New: 'New (3 above · +4 below): >104 105 106 107 108 109 110' } }],
          [['<C-u>'], { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } }],
          [
            ['2', '<C-d>'],
            { cols: { New: 'New (2 above · +5 below): >103 104 105 106 107 108 109' } },
          ],
        ],
      },
    ],
    [
      '⌘⏎ drops a waiting count; a digit drops a waiting g',
      {
        steps: [
          [
            ['3', '<D-CR>', '<Esc>', 'ö'],
            { cols: { New: 'New (+7 below): 101 >102 103 104 105 106 107' } },
          ],
          // g3g is no 3gg: the ring stays on the last card
          [['G', 'g', '3', 'g'], { cols: { New: 'New (7 above): 108 109 110 111 112 113 >114' } }],
        ],
      },
    ],
  ])('%s', (_, nav) => {
    navigate(nav);
  });
});

describe('the / filter', () => {
  test.each<[string, Nav]>([
    [
      'Home and End while typing: the first and the last match in reading order',
      {
        steps: [
          [
            ['/', ...TORY_1, '<End>'],
            { cols: { Resolved: 'Resolved: 201 202 >203' }, head: '/tory 1▏' },
          ],
          [['<Home>'], { cols: { New: 'New: >101 110 111 112 113 114' } }],
        ],
      },
    ],
    [
      'typing puts the ring on the first match; ↑ ↓ move it, ← → the caret, letters type',
      {
        steps: [
          // 104 is the fourth card: no match
          [['ö', 'ö', 'ö', '/', ...TORY_1], { cols: { New: 'New: >101 110 111 112 113 114' } }],
          [['<Down>', '<Down>'], { cols: { New: 'New: 101 110 >111 112 113 114' } }],
          [
            ['<Left>', '<Left>', '<Right>'],
            { cols: { New: 'New: 101 110 >111 112 113 114' }, head: '/tory ▏1' },
          ],
          // ö is text in the field, at the caret; ⌘→ to the end
          [['ö', '<D-Right>'], { head: '/tory ö1▏' }],
          [['<M-BS>'], { head: '/tory ▏' }],
        ],
      },
    ],
    [
      '↓ ↑ cross columns in reading order while typing, an empty column passed over; ⏎ opens the ringed card',
      {
        steps: [
          [
            ['/', ...TORY_1, '<Down>', '<Down>', '<Down>', '<Down>', '<Down>'],
            { cols: { New: 'New: 101 110 111 112 113 >114' } },
          ],
          // past New's last match: Active holds none, so Resolved's first
          [
            ['<Down>'],
            {
              cols: {
                New: 'New: 101 110 111 112 113 114',
                Active: 'Active: ',
                Resolved: 'Resolved: >201 202 203',
              },
            },
          ],
          // the last match stays the last
          [['<Down>', '<Down>', '<Down>'], { cols: { Resolved: 'Resolved: 201 202 >203' } }],
          [
            ['<Up>', '<Up>', '<Up>'],
            { cols: { New: 'New: 101 110 111 112 113 >114' }, head: '/tory 1▏' },
          ],
          [['<Down>', '<CR>'], { opened: 201 }],
        ],
      },
    ],
    [
      '⏎ opens the card’s page at once, the filter kept',
      { steps: [[['/', ...TORY_1, '3', '<CR>'], { opened: 113, head: '/tory 13' }]] },
    ],
    [
      'no match says so; a move on it keeps the card; Esc while typing puts the ring back',
      {
        steps: [
          [['ö', 'ö', 'ö', '/', 'z', 'z', 'z'], { empty: 'No cards match' }],
          [
            ['<Down>', '<Esc>'],
            { head: null, cols: { New: 'New (+7 below): 101 102 103 >104 105 106 107' } },
          ],
          [
            ['/', 'z', 'z', 'z', '<CR>', 'ö', '<Esc>'],
            { cols: { New: 'New (+7 below): 101 102 103 >104 105 106 107' } },
          ],
        ],
      },
    ],
    [
      'Esc after the filter is kept: the filter off, the ring on the card it chose',
      {
        steps: [
          // 109 (Story 9) does not match. ⏎ opens 111's Card page, and Esc takes the filter
          // off: the column back where it was before /, the ring in it
          [
            [
              ...['G', 'l', 'l', 'l', 'l', 'l', '/', ...TORY_1, '<Down>', '<Down>'],
              ...['<CR>', '<Esc>'],
            ],
            { head: null, cols: { New: 'New (7 above): 108 109 110 >111 112 113 114' } },
          ],
        ],
      },
    ],
    [
      'typing keeps the ring while its card matches; an empty field puts it back',
      {
        steps: [
          [
            ['ö', 'ö', '/', ...TORY_1, '<Down>', '<Down>'],
            { cols: { New: 'New: 101 110 >111 112 113 114' } },
          ],
          // `tory ` matches every card: the ring stays on 111
          [['<BS>'], { cols: { New: 'New (4 above · +3 below): 105 106 107 108 109 110 >111' } }],
          [
            ['<BS>', '<BS>', '<BS>', '<BS>', '<BS>'],
            { cols: { New: 'New (+7 below): 101 102 >103 104 105 106 107' } },
          ],
        ],
      },
    ],
  ])('%s', (_, nav) => {
    navigate(nav);
  });
});

describe('the wheel and the trackpad leave the ring where it is', () => {
  const added = [listCard(100, 'New on top', 'New'), ...NEW_AND_RESOLVED];

  test.each<[string, Nav]>([
    [
      'gg and Home on the first card bring it back into view after the wheel',
      {
        steps: [
          [
            [wheel('col:New', 0, 3), 'g', 'g'],
            { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } },
          ],
          [
            [wheel('col:New', 0, 3), '<Home>'],
            { cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' } },
          ],
        ],
      },
    ],
    [
      'a column scrolls under the pointer; the clock leaves it; a key moves the ring into view',
      {
        steps: [
          [
            [wheel('col:New', 0, 3)],
            { cols: { New: 'New (3 above · +4 below): 104 105 106 107 108 109 110' } },
          ],
          [
            [{ kind: 'tick', at: '2026-10-25T10:00:00.000Z' }],
            { cols: { New: 'New (3 above · +4 below): 104 105 106 107 108 109 110' } },
          ],
          [
            [wheel('col:New', 0, 100)],
            { cols: { New: 'New (7 above): 108 109 110 111 112 113 114' } },
          ],
          [
            [wheel('col:New', 0, -2)],
            { cols: { New: 'New (5 above · +2 below): 106 107 108 109 110 111 112' } },
          ],
          // ö moves the ring from 101 and the view shows it
          [['ö'], { cols: { New: 'New (1 above · +6 below): >102 103 104 105 106 107 108' } }],
        ],
      },
    ],
    [
      'a click on a card scrolled into view selects it; the view stays',
      {
        steps: [
          [
            [wheel('col:New', 0, 7), { kind: 'click', id: 'card:112' }],
            { cols: { New: 'New (7 above): 108 109 110 111 >112 113 114' } },
          ],
        ],
      },
    ],
    [
      // two of (576 - 6) / 2 in view
      'sideways: the columns move by whole columns, the ring stays; a key brings its column back',
      {
        width: 600,
        steps: [
          [[], { scroll: { width: 285, offset: 0, view: 576 } }],
          [[wheel('columns', 1, 0)], { scroll: { width: 285, offset: 291, view: 576 } }],
          [
            [wheel('columns', 10, 0)],
            {
              scroll: { width: 285, offset: 582, view: 576 },
              cols: { New: 'New (+7 below): >101 102 103 104 105 106 107' },
            },
          ],
          [['ö'], { scroll: { width: 285, offset: 0, view: 576 } }],
        ],
      },
    ],
    [
      'after the wheel a count or g leaves the view; the move it waits for follows',
      {
        steps: [
          [
            [wheel('col:New', 0, 5), '3'],
            { cols: { New: 'New (5 above · +2 below): 106 107 108 109 110 111 112' } },
          ],
          [['ö'], { cols: { New: 'New (3 above · +4 below): >104 105 106 107 108 109 110' } }],
        ],
      },
    ],
    [
      // the ring (104) is not pulled back into view
      'a read that moves cards above the ring leaves a wheeled column where it is',
      {
        steps: [
          [
            ['3', 'ö', wheel('col:New', 0, 6), serveStarted, boardReplies(navWorld(added))],
            { cols: { New: 'New (6 above · +2 below): 106 107 108 109 110 111 112' } },
          ],
        ],
      },
    ],
  ])('%s', (_, nav) => {
    navigate(nav);
  });
});

// ---------------------------------------------------------------- needs you

const NEEDS_MINE = [
  listCard(4, 'Cart total includes shipping', 'Active'),
  listCard(5, 'Saved carts survive sign-out', 'New'),
  listCard(6, 'Greeted by time of day', 'New'),
];

const NEEDS_RUNS = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(1) }),
  factoryRun(5, 'Saved carts survive sign-out', 'verify', 'needs-you', { since: minutes(1) }),
  factoryRun(6, 'Greeted by time of day', 'build', 'needs-you', { since: minutes(1) }),
];

/** s6 asked first (minute 2), s5 after (minute 4). */
const NEEDS_SESSIONS = [
  session('s4', 'working', 4),
  { ...session('s5', 'waiting', 5), since: minutes(4) },
  { ...session('s6', 'waiting', 6), since: minutes(2) },
];

const WAITING: BoardWorld = {
  mine: NEEDS_MINE,
  team: NEEDS_MINE,
  runs: NEEDS_RUNS,
  sessions: NEEDS_SESSIONS,
};
/** Card 4 running, nothing waiting. */
const NONE_WAITING: BoardWorld = {
  ...WAITING,
  runs: NEEDS_RUNS.slice(0, 1),
  sessions: [session('s4', 'working', 4)],
};

const FROM_EDITOR: Input = { kind: 'open', params: { from: 'editor' }, size: BOARD_SIZE };

/** Card 4's session waits on you, then its run says Needs you. */
const WAITS: Input[] = [
  {
    kind: 'event',
    event: {
      seq: 20,
      at: minutes(7),
      type: 'session.state',
      data: { id: 's4', card: 4, state: 'waiting', since: minutes(7), cause: 'Stop' },
    },
  },
  {
    kind: 'event',
    event: {
      seq: 21,
      at: minutes(7),
      type: 'factory.stage',
      data: {
        card: 4,
        session: 's4',
        stage: 'build',
        from: null,
        state: 'needs-you',
        reason: 'which test account?',
        since: minutes(1),
        cause: 'needs-you',
        outcome: null,
      },
    },
  },
];

/** Card 6 answered in Chat: its session works and its run runs again. */
const SIX_ANSWERED: Input[] = [
  {
    kind: 'event',
    event: {
      seq: 30,
      at: minutes(8),
      type: 'session.state',
      data: { id: 's6', card: 6, state: 'working', since: minutes(8), cause: 'UserPromptSubmit' },
    },
  },
  {
    kind: 'event',
    event: {
      seq: 31,
      at: minutes(8),
      type: 'factory.stage',
      data: {
        card: 6,
        session: 's6',
        stage: 'build',
        from: null,
        state: 'running',
        reason: null,
        since: minutes(1),
        cause: 'UserPromptSubmit',
        outcome: null,
      },
    },
  },
];

const stripeOf = (d: Drive<Node>) =>
  d.effects.flatMap((e) => (e.kind === 'stripe' ? [e.items] : [])).at(-1);

describe('the stripe’s Board and Sessions say who needs you', () => {
  test.each<[string, BoardWorld, unknown, Readonly<Record<string, unknown>>]>([
    [
      'two waiting: a dot on both, naming them oldest first; the running in words',
      WAITING,
      {
        id: 'board',
        label: 'Board',
        icon: 'board',
        group: 'top',
        key: '⌘⌥A',
        dot: 'needs-you',
        tooltip:
          'Board · ⌘⌥A · #6 Greeted by time of day · #5 Saved carts survive sign-out need you',
      },
      {
        dot: 'needs-you',
        tooltip:
          'Sessions · ⌘5 · #6 Greeted by time of day · #5 Saved carts survive sign-out need you · 1 running',
      },
    ],
    [
      'none at 0: Sessions says what runs, Board nothing',
      NONE_WAITING,
      {
        id: 'board',
        label: 'Board',
        icon: 'board',
        group: 'top',
        key: '⌘⌥A',
        tooltip: 'Board · ⌘⌥A',
      },
      { dot: 'running', tooltip: 'Sessions · ⌘5 · 1 running' },
    ],
  ])('%s', (_, world, board, sessions) => {
    const items = stripeOf(driveBoard({ world, now: minutes(6) }));

    const got: unknown = items?.find((i) => i.id === 'board');

    expect(got).toEqual(board);
    expect(items?.find((i) => i.id === 'sessions')).toMatchObject(sessions);
  });
});

describe('a run that starts needing you changes only the widgets', () => {
  test.each<[string, Input[], string | undefined]>([
    // the run still says it runs: no dot yet
    ['its session waiting', WAITS.slice(0, 1), undefined],
    ['its session waiting and its run at Needs you', WAITS, 'needs-you'],
  ])('%s: nothing said, read or opened; the selection and Chat stay', (_, events, dot) => {
    const d = driveBoard({ world: NONE_WAITING, now: minutes(6) }).keys('ö');
    const before = selectedCard(d.tree);

    d.take();
    d.send(...events);
    const kinds = d.commands.map((c) => (c.kind === 'shell' ? c.effect.kind : c.kind));
    const marks = ['widgets', 'stripe', 'selected', 'mode', 'workspaces'];

    // only the whole-state marks, which the bridge sends on only when they changed
    expect(kinds.filter((k) => !marks.includes(k))).toEqual([]);
    const shown: unknown = stripeOf(d)?.find((i) => i.id === 'sessions')?.dot;

    expect(shown).toBe(dot);
    expect(selectedCard(d.tree)).toBe(before);
    expect(chatCommands(d.commands)).toEqual([]);
  });
});

/** What a step after opening from the Editor looks at. */
type Landed = {
  selected?: string | undefined;
  /** The Chat column's opens and focus. */
  chat?: Command[];
  /** The reads asked and not answered, by argv. */
  reads?: readonly string[];
  head?: string | null;
  terminal?: boolean;
  /** The window told to show the Board. */
  shown?: boolean;
};

type Landing = {
  world: BoardWorld;
  params?: Readonly<Record<string, string>>;
  /** What the Board's first reads get, in place of the world's. */
  first?: Replies;
  steps: readonly [readonly Act[], Landed][];
};

const landedOf = (d: Drive<Node>, since: readonly Command[], want: Landed): Landed => {
  const got: Landed = {};

  if ('selected' in want) got.selected = selectedCard(d.tree);
  if ('chat' in want) got.chat = chatCommands(since);
  if ('reads' in want)
    got.reads = since.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));
  if ('head' in want) got.head = headOf(d.tree);
  if ('terminal' in want) got.terminal = nodesOf(d.tree).some((n) => n.kind === 'Terminal');
  if ('shown' in want)
    got.shown = effectsOf(since).some((e) => e.kind === 'view' && e.view === 'factory');

  return got;
};

/** Every read but `session list`, which stays asked. */
const sessionsHeld =
  (world: BoardWorld): Replies =>
  (asked) =>
    asked.argv[0] === 'session' ? undefined : boardReplies(world)(asked);

describe('opened again from the Editor, the ring lands on the oldest run waiting on you', () => {
  test.each<[string, Landing]>([
    [
      'lands there, its Chat holding the keys, reading nothing whole again',
      {
        world: WAITING,
        steps: [
          [['ä'], { selected: 'card:4' }],
          [[FROM_EDITOR], { reads: [], chat: chatOpened(6), terminal: false, selected: 'card:6' }],
        ],
      },
    ],
    [
      'a filter that would hide it is closed',
      {
        world: WAITING,
        steps: [
          [['/', 'C', 'a', 'r', 't', '<CR>'], { head: '/Cart' }],
          [[FROM_EDITOR], { head: null, selected: 'card:6' }],
        ],
      },
    ],
    [
      'none waiting: the last selection, and Chat as it was',
      {
        world: NONE_WAITING,
        steps: [
          [['ä', 'ö'], { selected: 'card:4' }],
          [[FROM_EDITOR], { selected: 'card:4', chat: [] }],
        ],
      },
    ],
    [
      'a click on the stripe’s Board shows the Board and lands the same way',
      {
        world: WAITING,
        steps: [
          [[{ kind: 'click', id: 'widget:stripe:board' }], { shown: true, chat: chatOpened(6) }],
        ],
      },
    ],
    [
      'answered, the next lands on the one after',
      {
        world: WAITING,
        steps: [
          [[FROM_EDITOR], { chat: chatOpened(6) }],
          [[...SIX_ANSWERED, FROM_EDITOR], { chat: chatOpened(5), selected: 'card:5' }],
        ],
      },
    ],
    [
      'the first open from the Editor lands once the runs and the sessions are read, and only once',
      {
        world: WAITING,
        params: { from: 'editor' },
        first: sessionsHeld(WAITING),
        steps: [
          [[], { chat: [] }],
          [[boardReplies(WAITING)], { chat: chatOpened(6) }],
          // later reads move nothing: it landed once
          [['<Esc>', serveStarted, boardReplies(WAITING)], { chat: [] }],
        ],
      },
    ],
  ])('%s', (_, { world, params, first, steps }) => {
    stepThrough(
      driveBoard({
        world,
        now: minutes(6),
        ...(params === undefined ? {} : { params }),
        ...(first === undefined ? {} : { replies: first }),
      }),
      steps,
      landedOf,
    );
  });
});
