/**
 * Local mode on the Board, through the shared driver: the band, the dashed cards, Held writes,
 * Discard local changes and the local pull request in the Board's place, from `abe local status`
 * and `abe watch`'s local events.
 */
import { describe, expect, test } from 'bun:test';
import type { LocalModeView } from '@abe/core';
import { localNumber } from '@abe/core';
import {
  AT,
  BOARD_MINE,
  BOARD_SESSIONS,
  BOARD_TEAM,
  type BoardWorld,
  driveBoard,
  factoryRun,
  heldWrite,
  type Input,
  listCard,
  LOCAL_CHECKOUT,
  localDiscardedEvent,
  localHeldEvent,
  localPr,
  localPrEvent,
  localView,
  minutes,
  type Node,
  nodeById,
  nodesOf,
  repliesBy,
  type ShellEffect,
  thisMacCardsAnswer,
} from '@abe/testing';

type Board = ReturnType<typeof driveBoard>;

/** The Board at 6 min after `AT`, local mode as `local` says, its reads answered. */
const board = (local: Partial<LocalModeView> = {}, world: BoardWorld = {}): Board =>
  driveBoard({ now: minutes(6), world: { ...world, local: localView(local) } });

/** `d` with what it did so far put aside, so a test reads what the next input does. */
const fresh = (d: Board): Board => {
  d.take();

  return d;
};

const props = (tree: Node | undefined, id: string): Record<string, unknown> =>
  nodeById(tree, id).props;

const has = (tree: Node, kind: Node['kind']) => nodesOf(tree).some((n) => n.kind === kind);

const reads = (d: Board): string[] => d.asked.map((a) => a.argv.join(' '));

const effects = <K extends ShellEffect['kind']>(
  d: Board,
  kind: K,
): Extract<ShellEffect, { kind: K }>[] =>
  d.effects.filter((e): e is Extract<ShellEffect, { kind: K }> => e.kind === kind);

const menuOf = (d: Board) => {
  const m = d.commands.find((c) => c.kind === 'menu');

  return m?.kind === 'menu' ? m : undefined;
};

const confirmOf = (d: Board) => {
  const c = d.commands.find((x) => x.kind === 'confirm');

  return c?.kind === 'confirm' ? c : undefined;
};

const click = (id: string): Input => ({ kind: 'click', id });
const key = (k: string): Input => ({ kind: 'key', key: k });

/** Card lists read again, as serve lists the held changes on them. */
const CARD_LISTS = ['card list --mine --closed', 'card list --closed'];
const RESOLVED_HERE = 'Resolved here · Azure: Active';
/** Card 4 with nothing held on it but what a row adds. */
const ONLY_HERE = { card: 4, state: null, assignee: null, added: [], removed: [], at: AT };
/** The sample's held writes less its board change: a pull request and an issue comment held. */
const OFF_BOARD = localView().held.filter((w) => !w.kind.startsWith('card-'));
/** A card made here, `#LC1`. */
const LC1 = localNumber(1);
const MADE_HERE = heldWrite(4, 'card-create', 'new card LC1 "Gift wrap"', { card: LC1 });

describe('local mode on the Board', () => {
  test.each<[string, Partial<LocalModeView>, string | undefined, boolean]>([
    ['on: the band over the Board, the dashed badge, the crumb', {}, 'Local mode', true],
    ['off: none of them; the Board as ever', { on: false }, undefined, false],
    [
      'the board read-only alone: its band, no badge',
      { on: false, readOnlyBoard: true },
      'Read-only board',
      false,
    ],
  ])('%s', (_, local, lead, badged) => {
    const d = board(local);
    const w = effects(d, 'workspaces').at(-1);
    const band = nodesOf(d.tree).find((n) => n.kind === 'LocalBand');

    expect(band?.kind === 'LocalBand' ? band.props.lead : undefined).toBe(lead);
    expect(w?.factory.line.find((c) => c.local === true)?.text).toBe(
      badged ? 'Local mode · nothing written' : undefined,
    );
    expect(w?.factory.crumb.endsWith('local mode')).toBe(badged);
  });

  test.each<[string, Partial<LocalModeView>, string[]]>([
    [
      'local mode: its held writes, Discard local changes (one is on the board), Settings',
      {},
      ['3 held writes', 'Discard local changes', 'Settings'],
    ],
    [
      'local mode, nothing on the board held: no Discard',
      { held: OFF_BOARD },
      ['2 held writes', 'Settings'],
    ],
    [
      'the board read-only alone: its local changes only',
      { on: false, readOnlyBoard: true },
      ['1 local change', 'Discard local changes', 'Settings'],
    ],
    [
      'the board read-only alone, none yet',
      { on: false, readOnlyBoard: true, held: [] },
      ['Local changes', 'Settings'],
    ],
  ])("the band's links: %s; Settings opens its page", (_, local, labels) => {
    const d = board(local);
    const links = props(d.tree, 'local-band').links;

    expect(Array.isArray(links) ? links.map((l: { label: string }) => l.label) : []).toEqual(
      labels,
    );
    expect(fresh(d).click('local:settings').commands).toContainEqual({
      kind: 'open',
      screen: 'settings',
      params: { page: 'local-mode' },
    });
  });

  test.each<[string, Partial<LocalModeView>, string | undefined]>([
    ['moved here, the board elsewhere: dashed, both states', {}, RESOLVED_HERE],
    [
      'moved here to what the board says: plain',
      { cards: [{ card: 4, state: 'Active', assignee: null, added: [], removed: [], at: AT }] },
      undefined,
    ],
    [
      'only assigned here: plain',
      { cards: [{ card: 4, state: null, assignee: 'me', added: [], removed: [], at: AT }] },
      undefined,
    ],
    [
      'a tag put on and one taken off here: dashed, the tags',
      { cards: [{ ...ONLY_HERE, added: ['prototype'], removed: ['cart'] }] },
      '+prototype −cart here · not on Azure',
    ],
    [
      'edited here: dashed, edited',
      { cards: [{ ...ONLY_HERE, edited: ['title', 'description'] }] },
      'edited here · not on Azure',
    ],
    [
      'commented on here: dashed, how many',
      { cards: [{ ...ONLY_HERE, comments: 2 }] },
      '2 comments here · not on Azure',
    ],
    [
      'tagged, edited and commented on here: all in one line',
      { cards: [{ ...ONLY_HERE, added: ['prototype'], edited: ['title'], comments: 1 }] },
      '+prototype, edited, 1 comment here · not on Azure',
    ],
    [
      'moved and edited here: both states, then edited',
      { cards: [{ ...ONLY_HERE, state: 'Resolved', edited: ['title'] }] },
      'Resolved here · Azure: Active · edited',
    ],
    [
      'the board read-only alone: the same',
      { on: false, readOnlyBoard: true, cards: [{ ...ONLY_HERE, comments: 1 }] },
      '1 comment here · not on Azure',
    ],
    ["another checkout's view (off): its cards' states still say so", { on: false }, RESOLVED_HERE],
  ])("a card's state here over the board's: %s", (_, local, here) => {
    expect(props(board(local).tree, 'card:4').local).toBe(here);
  });

  test('a held card (made here, LC1): on the Board dashed, named LC1', () => {
    const held = listCard(LC1, 'Gift wrap', 'New', 'Alex Example', {
      tags: ['prototype'],
      url: 'local:LC1',
    });
    const d = board({}, { mine: [held, ...BOARD_MINE], team: [held, ...BOARD_TEAM] });
    const card = props(d.tree, `card:${LC1}`);

    expect(card.local).toBe('New here · not on Azure');
    expect(String(card.tooltip).startsWith('#LC1 Gift wrap')).toBe(true);
  });

  test('a board On this Mac: its cards never dashed, no read-only band, no Open in browser', () => {
    const d = board(
      { on: false, readOnlyBoard: true },
      {
        more: repliesBy({
          'card list --mine': thisMacCardsAnswer(BOARD_MINE, true),
          'card list --closed': thisMacCardsAnswer(BOARD_TEAM, false),
        }),
      },
    );

    expect(props(d.tree, 'card:4').local).toBeUndefined();
    expect(has(d.tree, 'LocalBand')).toBe(false);
    expect(menuOf(fresh(d).click('menu:card:4'))?.rows.some((r) => r.id === 'browser')).toBe(false);
  });

  test('another project shown: its own local mode is read, the old one dropped', () => {
    const d = fresh(board()).send({ kind: 'root', root: '/p/other' });

    expect(reads(d)).toContain('local status');
    expect(has(d.tree, 'LocalBand')).toBe(false);
  });
});

describe("abe watch's local events", () => {
  test.each<[string, Input, string | undefined, string[]]>([
    [
      'a move held: dashed at once, nothing read',
      localHeldEvent(heldWrite(4, 'card-move', 'move AB#5 to Active', { card: 5, to: 'Active' })),
      'Active here · Azure: New',
      [],
    ],
    [
      'a tag held: the card lists read again',
      localHeldEvent(
        heldWrite(4, 'card-tag', 'tag AB#5 +prototype', {
          card: 5,
          tags: { add: ['prototype'], remove: [] },
        }),
      ),
      '+prototype here · not on Azure',
      CARD_LISTS,
    ],
    [
      'an edit held: the card lists read again',
      localHeldEvent(
        heldWrite(4, 'card-write', 'edit AB#5', { card: 5, fields: { title: 'Wishlist v2' } }),
      ),
      'edited here · not on Azure',
      CARD_LISTS,
    ],
    [
      'a comment held: dashed at once, nothing read',
      localHeldEvent(heldWrite(4, 'card-comment', 'comment on AB#5', { card: 5, text: 'ok' })),
      '1 comment here · not on Azure',
      [],
    ],
    [
      'a new card held: the card lists read again',
      localHeldEvent(MADE_HERE),
      undefined,
      CARD_LISTS,
    ],
    [
      "another checkout's held write changes nothing",
      localHeldEvent(
        heldWrite(4, 'card-move', 'move AB#5 to Active', {
          card: 5,
          to: 'Active',
          checkout: '/p/other',
        }),
      ),
      undefined,
      [],
    ],
  ])('local.held: %s', (_, event, here, asked) => {
    const d = fresh(board()).send(event);

    expect(props(d.tree, 'card:5').local).toBe(here);
    expect(reads(d)).toEqual(asked);
  });

  test.each<[string, Input, string | undefined, string[]]>([
    [
      "this checkout's: the board as it is, local status and the cards read again",
      localDiscardedEvent(),
      undefined,
      ['local status', ...CARD_LISTS],
    ],
    [
      "another checkout's: nothing",
      localDiscardedEvent({ checkout: '/p/other' }),
      RESOLVED_HERE,
      [],
    ],
  ])('local.discarded: %s', (_, event, here, asked) => {
    const d = fresh(board()).send(event);

    expect(props(d.tree, 'card:4').local).toBe(here);
    expect(reads(d)).toEqual(asked);
    expect(
      JSON.stringify(props(d.tree, 'local-band').links).includes('Discard local changes'),
    ).toBe(here !== undefined);
  });
});

describe('Held writes', () => {
  test.each<[string, Partial<LocalModeView>, string[][]]>([
    [
      'local mode on: Held writes, Discard local changes…, Local mode off…',
      {},
      [
        ['local-held', 'Held writes', '3 writes on this machine, never sent'],
        ['local-discard', 'Discard local changes…', 'the board as it is; nothing is sent'],
        ['local-off', 'Local mode off…', 'Settings › Local mode; nothing held is sent'],
      ],
    ],
    [
      'local mode on, nothing on the board held: no Discard',
      { held: OFF_BOARD },
      [
        ['local-held', 'Held writes', '2 writes on this machine, never sent'],
        ['local-off', 'Local mode off…', 'Settings › Local mode; nothing held is sent'],
      ],
    ],
    [
      'the board read-only alone: its local changes, Discard',
      { on: false, readOnlyBoard: true },
      [
        ['local-held', 'Local changes', '1 change on this machine, never sent'],
        ['local-discard', 'Discard local changes…', 'the board as it is; nothing is sent'],
      ],
    ],
    ['off: none', { on: false }, []],
  ])('`:` lists: %s', (_, local, want) => {
    const rows = board(local)
      .here?.view?.menu.rows.filter((r) => r.id.startsWith('local-'))
      .map((r) => [r.id, r.text, r.dim ?? '']);

    expect(rows).toEqual(want);
  });

  test('`:`’s Local mode off… opens its Settings page', () => {
    expect(fresh(board()).keys(':').click('view:local-off').commands).toContainEqual({
      kind: 'open',
      screen: 'settings',
      params: { page: 'local-mode' },
    });
  });

  test.each<[string, (d: Board) => Board]>([
    ['the band', (d) => d.click('local:held')],
    ['the badge', (d) => d.click('toolbar:local')],
    ['`:held` typed', (d) => d.keys(':').type('held').keys('<CR>')],
    ['the `held` word', (d) => d.send({ kind: 'choice', menu: 'local', row: 'held' })],
  ])('Held writes from %s: newest first, when, what, where it would have gone; wide', (_, open) => {
    const m = menuOf(open(fresh(board())));

    expect(m?.title).toBe('Held writes · 3');
    expect(m?.look?.caption).toBe('demo-shop · nothing left this machine');
    expect(m?.rows.map((r) => [r.id, r.text, r.note])).toEqual([
      ['held:3', 'Move AB#4 to Resolved', 'would go to Shop/Web on dev.azure.com/demo-org'],
      [
        'held:2',
        'Open pull request L3 "Cart total includes shipping" (card/4-cart → main)',
        'would go to mkdir-swe/demo-shop on GitHub',
      ],
      ['held:1', 'Comment on #4', 'would go to mkdir-swe/demo-shop on GitHub'],
    ]);
  });

  test.each<[string, Partial<LocalModeView>, string, string[], string]>([
    [
      'local mode on: every write held',
      {},
      'Held writes · 3',
      ['held:3', 'held:2', 'held:1'],
      '⏎ opens it · turning local mode off keeps them here as a record; nothing is ever sent',
    ],
    [
      'the board read-only alone: its local changes only, kept until discarded',
      { on: false, readOnlyBoard: true },
      'Local changes · 1',
      ['held:3'],
      '⏎ opens it · they stay on this machine until you discard them; nothing is sent',
    ],
    [
      'neither: a record',
      { on: false },
      'Held writes · 3',
      ['held:3', 'held:2', 'held:1'],
      'local mode is off: these stay a record; nothing is ever sent',
    ],
  ])("Held writes' words: %s", (_, local, title, rows, hint) => {
    const m = menuOf(fresh(board(local)).click('local:held'));

    expect([m?.title, m?.rows.map((r) => r.id), m?.look?.hint]).toEqual([title, rows, hint]);
  });

  test.each<[string, string, (d: Board) => unknown, unknown]>([
    [
      'the local pull request: in the Board’s place',
      'held:2',
      (d) => props(d.tree, 'local-pr').name,
      '#L3',
    ],
    [
      'what it would have sent: the file in the Editor',
      'held:1',
      (d) => effects(d, 'open-file'),
      [{ kind: 'open-file', path: '/state/local/files/comment-1.md' }],
    ],
    [
      'the card: its Card page',
      'held:3',
      (d) =>
        d.commands.flatMap((c) => (c.kind === 'open' && c.screen === 'card' ? [c.params] : [])),
      [{ card: '4', from: 'board' }],
    ],
  ])('⏎ on a held write opens %s', (_, row, seen, want) => {
    expect(seen(fresh(board()).click('local:held').click(row))).toEqual(want);
  });
});

describe('Discard local changes', () => {
  test.each<[string, Partial<LocalModeView>, (d: Board) => Board, string]>([
    ["local mode's band", {}, (d) => d.click('local:discard'), '1 change'],
    [
      "the read-only board's band",
      { on: false, readOnlyBoard: true },
      (d) => d.click('local:discard'),
      '1 change',
    ],
    [
      'the `discard-local` word',
      {},
      (d) => d.send({ kind: 'choice', menu: 'local', row: 'discard' }),
      '1 change',
    ],
    ['`:`’s row', {}, (d) => d.keys(':').click('view:local-discard'), '1 change'],
    [
      'with a card made here',
      { held: [MADE_HERE, ...localView().held] },
      (d) => d.click('local:discard'),
      '2 changes and 1 card made here',
    ],
  ])('from %s: asked first, then `abe board discard`', (_, local, open, n) => {
    expect(confirmOf(open(fresh(board(local))))).toEqual({
      kind: 'confirm',
      question: 'Discard local changes to the board?',
      details: [
        `${n} dropped from this machine.`,
        'The board then shows as it is. Nothing is sent.',
      ],
      yes: 'Discard local changes',
      no: 'Keep them',
      argv: ['board', 'discard'],
      done: 'Local changes discarded',
    });
  });

  test('with none held: said, nothing asked', () => {
    const d = fresh(board({ held: OFF_BOARD })).send({
      kind: 'choice',
      menu: 'local',
      row: 'discard',
    });

    expect(effects(d, 'status')).toContainEqual({
      kind: 'status',
      text: 'No local changes to the board here',
    });
    expect(confirmOf(d)).toBeUndefined();
  });
});

describe('the local pull request', () => {
  /** Held writes' `held:2`, the local pull request L3, in the Board's place. */
  const shown = (): Board => fresh(board().click('local:held').click('held:2'));
  const MERGED = localPrEvent(
    localPr(3, 4, 'Cart total includes shipping', { state: 'merged', mergeCommit: '3f2a1b9c' }),
  );
  const DIFF = {
    kind: 'show-diff',
    root: LOCAL_CHECKOUT,
    files: [
      { path: 'src/cart/4.ts', status: 'M' },
      { path: 'src/cart/4.test.ts', status: 'A' },
    ],
    base: 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9',
    head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    line: 1,
    pr: { number: localPr(3, 4, 'x').number, head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' },
  };

  test('in the Board’s place: its files, commits, line and a diff to show', () => {
    const d = shown();
    const pr = props(d.tree, 'local-pr');

    expect(has(d.tree, 'BoardCard')).toBe(false);
    expect(pr.files).toEqual([
      { path: 'src/cart/4.ts', status: 'M', added: 24, removed: 3 },
      { path: 'src/cart/4.test.ts', status: 'A', added: 41, removed: 0 },
    ]);
    expect(pr.commits).toEqual([
      { sha: 'b1c2d3e', subject: 'Cart total includes shipping: the rule' },
      { sha: 'a1b2c3d', subject: 'Cart total includes shipping: its tests' },
    ]);
    expect(pr.diff).toBe(true);
    expect(pr.line).toBe(
      'local · card/4-checkout-copy → main · not pushed · 2 files · +65 −3 · 2 commits',
    );
  });

  test.each<[string, Input[], Record<string, unknown>]>([
    ['⏎ on Merge locally asks, then merges', [key('<CR>')], { argv: ['local', 'merge', 'L3'] }],
    [
      '→ then ⏎ on Discard asks, then discards',
      [key('<Right>'), key('<CR>')],
      { argv: ['local', 'discard', 'L3'] },
    ],
    ['a click on Discard', [click('local-pr:discard')], { argv: ['local', 'discard', 'L3'] }],
    [
      'merged (local.pr): no buttons, nothing asked',
      [MERGED, key('<CR>')],
      { done: { text: '✓ Merged into main · 3f2a1b9', hue: 'good' } },
    ],
    ['⌘D: its diff, from its first file', [key('<D-d>')], { diff: { ...DIFF, index: 1 } }],
    ['Diff clicked', [click('local-pr:diff')], { diff: { ...DIFF, index: 1 } }],
    [
      'a file clicked: the diff at it, base to head in its checkout',
      [click('local-pr:file:2')],
      { diff: { ...DIFF, index: 2 } },
    ],
    ['Esc: back to the Board', [key('<Esc>')], { board: true }],
  ])('its keys and clicks: %s', (_, inputs, want) => {
    const d = shown().send(...inputs);

    expect({
      argv: confirmOf(d)?.argv,
      done: has(d.tree, 'LocalPullRequest') ? props(d.tree, 'local-pr').done : undefined,
      diff: effects(d, 'show-diff').at(0),
      board: has(d.tree, 'BoardCard') && !has(d.tree, 'LocalPullRequest'),
    }).toEqual({ argv: undefined, done: undefined, diff: undefined, board: false, ...want });
  });

  test("a run's local pull request: its card menu's Open pull request shows it here, never a URL", () => {
    const run = factoryRun(4, 'Cart total includes shipping', 'pr', 'running', {
      pr: {
        repo: 'mkdir-swe/demo-shop',
        number: localPr(3, 4, 'x').number,
        url: 'local:mkdir-swe/demo-shop#L3',
        state: 'open',
        merge: 'person',
        checks: 'success',
        mergeCommit: null,
        deploy: null,
        branch: null,
      },
    });
    const d = fresh(board({}, { runs: [run], sessions: BOARD_SESSIONS })).click('menu:card:4');
    const row = menuOf(d)?.rows.find((r) => r.id === 'pull-request');

    expect(row?.dim).toBe('#L3 · on this machine');
    expect(row?.does).toEqual({ kind: 'back' });
    d.click('pull-request');
    expect(props(d.tree, 'local-pr').checks).toEqual([{ name: 'checks', glyph: '✓', hue: 'good' }]);
  });
});
