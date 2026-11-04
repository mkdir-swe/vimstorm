/**
 * A Sheet as a tab in the Factory view, on the shared driver: `:show <name>`, a `Show <title>`
 * link and the Board opened on a card's Sheet (a click on the Card page's) find and open it in the
 * Board's place; the tab's bar, keys and menu, what its page did, and `attached` once the event
 * says so.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CardData,
  type Event,
  type FactoryRunData,
  type SessionData,
  type SheetSummary,
  VIEW_NODES,
} from '@abe/core';
import {
  type Answer,
  BOARD_SIZE,
  type Drive,
  driveBoard,
  factoryRun,
  helpAnswer,
  type Input,
  listCard,
  minutes,
  type Node,
  nodesOf,
  repliesBy,
  session,
  sheetFindAnswer,
  sheetOpenAnswer,
  sheetSummary,
} from '@abe/testing';

const MINE = [
  listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example', { tags: ['cart'] }),
  listCard(5, 'Saved carts survive sign-out', 'New'),
];
const RUNS: FactoryRunData[] = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(1) }),
];
const SESSIONS: SessionData[] = [session('s4', 'working', 4)];

const CART = sheetSummary('cart-totals-a1b2c3', 'Cart totals by market', {
  card: 4,
  session: 's4',
});
const KEY = 'sheet:cart-totals-a1b2c3:yours:v1';

/**
 * The Board with cards 4 and 5, 4's run and session, none selected. No clock, so a dialog takes
 * its ⏎ at once.
 */
const board = (cards: CardData[] = MINE): Drive<Node> =>
  driveBoard({
    world: {
      mine: cards,
      team: cards,
      runs: cards.length === 0 ? [] : RUNS,
      sessions: cards.length === 0 ? [] : SESSIONS,
      more: repliesBy({ help: helpAnswer() }),
    },
  });

/** `:<text>` typed in Command mode and chosen. */
const colon = (d: Drive<Node>, text: string): Drive<Node> =>
  d.keys(':').answer().type(text).keys('<CR>');

// The driver gives each answer the id of the read it answers, whatever id these helpers carry.
const found = (d: Drive<Node>, sheets: SheetSummary[], said = 'sheet find'): Drive<Node> =>
  d.answer(repliesBy({ [said]: sheetFindAnswer('', sheets) }));
const opened = (
  d: Drive<Node>,
  id: string,
  title: string,
  o: { card?: number; version?: number } = {},
): Drive<Node> => d.answer(repliesBy({ 'sheet open': sheetOpenAnswer(id, title, o) }));
const refused = (command: 'sheet find' | 'card show', code: string, message: string): Answer => ({
  kind: 'result',
  id: '',
  command,
  reply: { ok: false, error: { code, message } },
});

/** Card 4 selected, `:show cart`, the find's best opened: your Sheet as a tab. */
const yours = (d: Drive<Node> = board().click('card:4')): Drive<Node> =>
  opened(found(colon(d, 'show cart'), [CART]), 'cart-totals-a1b2c3', 'Cart totals by market');
/** Card 4's Sheet, from its Card page's Sheets: the Board opened on the card with that Sheet. */
const cards = (): Drive<Node> =>
  opened(
    board().send({
      kind: 'open',
      params: { card: '4', sheet: '4/cart-totals-a1b2c3' },
      size: BOARD_SIZE,
    }),
    'cart-totals-a1b2c3',
    'Cart totals by market',
    {
      card: 4,
      version: 2,
    },
  );

const browser = (tree: Node) => {
  const n = nodesOf(tree).find((x) => x.kind === 'BrowserView');

  return n?.kind === 'BrowserView' ? n.props : undefined;
};
const onBoard = (tree: Node) => nodesOf(tree).some((n) => n.id === 'board');
const pick = (n: Node | undefined) => {
  if (n?.kind !== 'PickLayer') throw new Error(`no pick up: ${n?.kind ?? 'none'}`);

  return n.props;
};
/** The argv of every read still asked that starts with `words`. */
const asked = (d: Drive<Node>, ...words: string[]) =>
  d.asked.filter((a) => words.every((w, i) => a.argv[i] === w)).map((a) => a.argv);
const said = (d: Drive<Node>) =>
  d.effects.filter((e) => e.kind === 'status' || e.kind === 'balloon');
const page = (event: Extract<Input, { kind: 'browser' }>['event'], key = KEY): Input => ({
  kind: 'browser',
  key,
  event,
});

describe('finding a Sheet', () => {
  test.each<[string, string, Record<string, string>]>([
    [
      'typed with a name: the word’s row',
      'show cart',
      { id: 'word:show', text: 'show', note: '<name>' },
    ],
    ['chosen with none: the name is asked first', 'show<CR>', { title: ':show <name>' }],
  ])('Command mode’s :show, %s', (_, typed, first) => {
    const d = board().keys(':').answer();

    if (typed.endsWith('<CR>')) d.type(typed.slice(0, -'<CR>'.length)).keys('<CR>');
    else d.type(typed);
    const layer = d.layer;

    expect(layer?.kind === 'PickLayer' ? layer.props.rows[0] : layer?.props).toMatchObject(first);
  });

  test.each<[string, (d: Drive<Node>) => Drive<Node>, string[]]>([
    [
      ':show on card 4: its card and session first',
      (d) => colon(d.click('card:4'), 'show cart'),
      ['sheet', 'find', 'cart', '--card', '4', '--session', 's4'],
    ],
    [
      ':show with nothing selected: the first card is the context',
      (d) => colon(d, 'show cart'),
      ['sheet', 'find', 'cart', '--card', '5'],
    ],
    [
      ':show and the name asked after',
      (d) => colon(d, 'show').type('totals').keys('<CR>'),
      ['sheet', 'find', 'totals', '--card', '5'],
    ],
    [
      'a Show link in Chat’s terminal: its title as words',
      (d) => d.click('card:4').click('show:Cart totals by market'),
      ['sheet', 'find', 'Cart', 'totals', 'by', 'market', '--card', '4', '--session', 's4'],
    ],
  ])('%s', (_, how, argv) => {
    const d = how(board());

    expect(d.layer).toBeUndefined();
    expect(asked(d, 'sheet', 'find')).toEqual([argv]);
  });

  test.each<[string, (d: Drive<Node>) => Drive<Node>, Answer, string[][], ReturnType<typeof said>]>(
    [
      [
        ':show opens the find’s first',
        (d) => colon(d.click('card:4'), 'show cart'),
        sheetFindAnswer('cart', [
          CART,
          sheetSummary('cart-old-x9', 'Cart, old', { at: minutes(2) }),
        ]),
        [['sheet', 'open', 'cart-totals-a1b2c3']],
        [],
      ],
      [
        'a link opens its title exactly, before a better fuzzy match',
        (d) => d.click('card:4').click('show:Cart totals by market'),
        sheetFindAnswer('Cart totals by market', [
          sheetSummary('cart-totals-by-market-v2-zz', 'Cart totals by market v2'),
          CART,
        ]),
        [['sheet', 'open', 'cart-totals-a1b2c3']],
        [],
      ],
      [
        'no match opens nothing and says so',
        (d) => colon(d, 'show nope'),
        sheetFindAnswer('nope', []),
        [],
        [{ kind: 'balloon', tone: 'info', text: 'No Sheet matches “nope”' }],
      ],
      [
        'a refused find opens nothing and says why',
        (d) => colon(d, 'show cart'),
        refused('sheet find', 'no-org-store', 'no org store'),
        [],
        [{ kind: 'balloon', tone: 'error', text: 'no org store (no-org-store)' }],
      ],
    ],
  )('a find’s answer: %s', (_, how, reply, opens, balloons) => {
    const d = how(board());
    const before = said(d).length;

    d.answer(repliesBy({ 'sheet find': reply }));
    expect(asked(d, 'sheet', 'open')).toEqual(opens);
    expect(said(d).slice(before)).toEqual(balloons);
    expect(browser(d.tree)).toBeUndefined();
  });

  test.each<[string, string, SheetSummary, string[][]]>([
    ['the first find’s late answer opens nothing', 'sheet find cart', CART, []],
    [
      'the newest find’s opens its best',
      'sheet find old',
      sheetSummary('cart-old-x9', 'Cart, old'),
      [['sheet', 'open', 'cart-old-x9']],
    ],
  ])('a second :show before the first answered: %s', (_, which, sheet, opens) => {
    const d = colon(colon(board(), 'show cart'), 'show old');

    expect(asked(d, 'sheet', 'find').map((argv) => argv[2])).toEqual(['cart', 'old']);
    found(d, [sheet], which);
    expect(asked(d, 'sheet', 'open')).toEqual(opens);
  });
});

describe('the tab', () => {
  test.each<[string, () => Drive<Node>, ReturnType<typeof browser>]>([
    [
      'yours, from :show',
      () => yours(),
      {
        key: KEY,
        url: 'http://127.0.0.1:50123/s/9f2c4e1a',
        title: 'Sheet',
        sub: 'Cart totals by market',
        address: 'sheet://cart-totals-a1b2c3',
        version: 1,
        badges: ['yours', 'sandboxed', 'no network'],
        action: { keys: '⌘⏎', label: 'Attach to card' },
      },
    ],
    [
      'a card’s, from its Card page’s Sheets: attached, nothing to attach',
      cards,
      {
        key: 'sheet:cart-totals-a1b2c3:4:v2',
        url: 'http://127.0.0.1:50123/s/9f2c4e1a',
        title: 'Sheet',
        sub: 'Cart totals by market',
        address: 'sheet://4/cart-totals-a1b2c3',
        version: 2,
        badges: ['sandboxed', 'no network', 'attached'],
      },
    ],
  ])('%s, in the Board’s place', (_, open, view) => {
    const d = open();

    expect(browser(d.tree)).toEqual(view);
    expect(onBoard(d.tree)).toBe(false);
  });

  test.each<[string, string[], boolean, true | undefined, boolean, [string, string | undefined][]]>(
    [
      ['Esc is the Board again', ['<Esc>'], false, undefined, true, []],
      ['⏎ gives the page the keys', ['<CR>'], true, true, true, []],
      ['another key does nothing', ['ä', 'ö'], true, undefined, false, []],
      [
        '⌘⏎ is its menu',
        ['<D-CR>'],
        true,
        undefined,
        false,
        [
          ['Attach to card', undefined],
          ['Back to the Board', 'Esc'],
        ],
      ],
    ],
  )('the tab’s keys: %s', (_, keys, tab, focused, changes, menu) => {
    const d = yours();
    const tree = d.tree;

    d.keys(...keys);
    expect(Bun.deepEquals(d.tree, tree)).toBe(!changes);

    expect(browser(d.tree) !== undefined).toBe(tab);
    expect(onBoard(d.tree)).toBe(!tab);
    expect(browser(d.tree)?.focused).toBe(focused);
    expect(
      d.layer?.kind === 'PickLayer' ? d.layer.props.rows.map((r) => [r.text, r.note]) : [],
    ).toEqual(menu);
  });

  test.each<[string, () => Drive<Node>, string, string[], string | undefined, string[][], boolean]>(
    [
      [
        'Attach to card runs sheet attach on its card',
        () => yours(),
        '#4 · listed on the card',
        ['<CR>'],
        undefined,
        [['sheet', 'attach', 'cart-totals-a1b2c3', '--card', '4']],
        true,
      ],
      [
        'with nothing selected the first card is the one to attach to',
        () =>
          opened(
            found(colon(board(), 'show cart'), [sheetSummary('cart-a1', 'Cart')]),
            'cart-a1',
            'Cart',
          ),
        '#5 · listed on the card',
        ['<CR>'],
        undefined,
        [['sheet', 'attach', 'cart-a1', '--card', '5']],
        true,
      ],
      [
        'no card known: Attach to card asks it',
        () =>
          opened(
            found(colon(board([]), 'show cart'), [sheetSummary('cart-a1', 'Cart')]),
            'cart-a1',
            'Cart',
          ),
        'listed on the card',
        // the row asks, so ⏎ rests on Back to the Board until l moves up to it
        ['l', '<CR>', '4', '<CR>'],
        undefined,
        [['sheet', 'attach', 'cart-a1', '--card', '4']],
        true,
      ],
      [
        'a card’s Sheet: Attach to card is grey, saying where it is',
        cards,
        '#4 · listed on the card',
        [],
        'attached to #4',
        [],
        true,
      ],
      [
        'Back to the Board closes the tab',
        () => yours(),
        '#4 · listed on the card',
        ['B', 'a', 'c', 'k', '<CR>'],
        undefined,
        [],
        false,
      ],
    ],
  )('the tab’s menu: %s', (_, open, dim, keys, reason, attaches, tab) => {
    const d = open().keys('<D-CR>');

    expect(pick(d.layer).rows[0]).toMatchObject({ text: 'Attach to card', dim });
    expect(pick(d.layer).rows[0]?.reason).toBe(reason);
    d.keys(...keys);
    expect(asked(d, 'sheet', 'attach')).toEqual(attaches);
    expect(browser(d.tree) !== undefined).toBe(tab);
  });

  test.each<[string, Input[], true | undefined, ReturnType<typeof said>]>([
    ['the page’s blur takes its keys', [page({ kind: 'focus', focused: false })], undefined, []],
    [
      'its focus gives them back',
      [page({ kind: 'focus', focused: false }), page({ kind: 'focus', focused: true })],
      true,
      [],
    ],
    [
      'another key’s page is no tab’s',
      [page({ kind: 'focus', focused: false }, 'sheet:other:yours:v1')],
      true,
      [],
    ],
    [
      'a load says nothing',
      [page({ kind: 'loaded', url: 'http://127.0.0.1:50123/s/9f2c4e1a' })],
      true,
      [],
    ],
    [
      'a blocked request is said on the status line',
      [page({ kind: 'blocked', url: 'https://cdn.test/x.js', what: 'fetch' })],
      true,
      [
        {
          kind: 'status',
          text: 'Sheet blocked fetch https://cdn.test/x.js: a Sheet has no network',
        },
      ],
    ],
    [
      'a blocked URL is said without its query and fragment',
      [page({ kind: 'blocked', url: 'https://cdn.test/y.js?key=s3cr3t#t', what: 'script' })],
      true,
      [
        {
          kind: 'status',
          text: 'Sheet blocked script https://cdn.test/y.js: a Sheet has no network',
        },
      ],
    ],
    [
      'a failed load in a balloon',
      [page({ kind: 'failed', message: 'its origin is gone' })],
      true,
      [{ kind: 'balloon', tone: 'error', text: 'Sheet: its origin is gone' }],
    ],
  ])('what the page did: %s', (_, events, focused, effects) => {
    const d = yours().keys('<CR>');
    const before = said(d).length;

    d.send(...events);
    expect(browser(d.tree)?.focused).toBe(focused);
    expect(said(d).slice(before)).toEqual(effects);
  });

  test.each<[string, string, string[]]>([
    [
      'the tab’s Sheet is attached',
      'cart-totals-a1b2c3',
      ['yours', 'sandboxed', 'no network', 'attached'],
    ],
    ['another Sheet leaves the tab as it was', 'other-x1', ['yours', 'sandboxed', 'no network']],
  ])('sheet.attached: %s', (_, id, badges) => {
    const event: Event = {
      seq: 40,
      at: minutes(8),
      type: 'sheet.attached',
      data: {
        id,
        title: 'Cart totals by market',
        version: 1,
        card: 4,
        key: `sheets/4/${id}/v1.html`,
      },
    };
    const d = yours().send({ kind: 'event', event });

    expect(browser(d.tree)?.badges).toEqual(badges);
  });

  test.each<[string, () => Drive<Node>]>([
    ['from :show', () => yours()],
    ['from the Card page', cards],
  ])('every id the views catalog names for sheet is in the tree once it shows, %s', (_, open) => {
    const ids = nodesOf(open().tree).flatMap((n) => (n.id === undefined ? [] : [n.id]));
    const named = (VIEW_NODES.factory ?? []).filter((n) => n.part === 'sheet');

    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(ids).toContain(n.id);
  });
});

describe('what the tab opened over', () => {
  const has = (d: Drive<Node>, id: string) => nodesOf(d.tree).some((n) => n.id === id);

  test.each<[string, () => Drive<Node>, string]>([
    ['the Board', () => board().click('card:4'), 'board'],
  ])('Esc on a tab opened over %s shows it again, and Esc there the Board', (_, under, id) => {
    const d = yours(under());

    expect(browser(d.tree)).toBeDefined();
    d.keys('<Esc>');
    expect(has(d, id)).toBe(true);
    d.keys('<Esc>');
    expect(onBoard(d.tree)).toBe(true);
  });
});
