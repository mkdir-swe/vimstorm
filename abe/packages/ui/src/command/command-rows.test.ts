/**
 * The `:` line's rows and where ⏎ rests (#346), as tables: what is listed from where it was
 * opened, hidden vs grey, at most six Subject rows, More only once typed, and the resting rule.
 */
import { describe, expect, test } from 'bun:test';
import { HELP } from '@abe/testing';
import {
  commandRows,
  entries,
  NO_COMMAND,
  NOT_MAIN_CHECKOUT,
  ONLY_IN_A_WORKSPACE,
  type Row,
  SUBJECT_ROWS,
} from './command-rows';
import { type HereInput, type Menu, type MenuRow, type StripeGo } from '../runtime/runtime';

const row = (id: string, text: string, more: Partial<MenuRow> = {}): MenuRow => ({
  id,
  text,
  does: { kind: 'back' },
  ...more,
});

const CARD_MENU: Menu = {
  kind: 'menu',
  id: 'card:1234',
  title: '#1234 Cart total includes shipping',
  rows: [
    row('answer', 'Answer the question', { dim: '◆ needs you' }),
    row('workspace', 'Open workspace'),
    row('launch', 'Launch agent', { reason: 'already running' }),
    row('move', 'Move…', { dim: 'now Active' }),
    row('assign', 'Assign…'),
    row('comment', 'Comment…'),
    row('story', 'Open story'),
    row('linked', 'Linked', { key: '⌃L' }),
    row('stop', 'Stop…', { risky: true }),
  ],
};

const BOARD: Menu = {
  kind: 'menu',
  id: 'board:view',
  title: 'Board',
  rows: [row('triage', 'Triage'), row('tab', 'Team', { key: 'Tab' })],
};

const ANYWHERE: Row[] = [
  { id: 'anywhere:search', text: 'Search Everywhere', note: '⇧⇧', does: { kind: 'keys' } },
  { id: 'anywhere:settings', text: 'Settings', note: '⌘,', does: { kind: 'keys' } },
];

const onCard = (o: Partial<HereInput> = {}): HereInput => ({
  kind: 'here',
  serving: true,
  project: 'demo-shop',
  here: {
    keys: 'view',
    board: true,
    subject: {
      caption: '#1234 Cart total includes shipping',
      label: '#1234',
      ask: ['--card', '1234'],
      menu: CARD_MENU,
      tell: { session: '1234-ab12', whose: '#1234', dim: 'it is working', card: 1234 },
    },
    view: { title: 'Board', menu: BOARD },
  },
  ...o,
});

const ALL = entries(HELP, [
  {
    word: 'show',
    summary: 'open a Sheet',
    ask: [
      {
        name: 'name',
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'the Sheet',
      },
    ],
    commands: [],
  },
]);

/** With the Board's `new <title>` word (#346). */
const WITH_NEW = entries(HELP, [
  {
    word: 'new',
    summary: 'New card',
    ask: [
      {
        name: 'title',
        kind: 'positional',
        type: 'string',
        required: true,
        repeats: true,
        summary: 'its title',
      },
    ],
    commands: [],
  },
]);

const rowsOf = (
  filter: string,
  here: HereInput | undefined = onCard(),
  table: typeof ALL = ALL,
) => {
  const { rows, resting } = commandRows({ here, entries: table, anywhere: ANYWHERE, filter });

  return { ids: rows.map((r) => r.id), rows, resting: rows[resting]?.id };
};

describe('the `:` line on a card, nothing typed (#346)', () => {
  test("the card's runnable rows under its caption, at most six, then All …; Board; Anywhere", () => {
    const { ids, rows, resting } = rowsOf('');

    expect(ids).toEqual([
      'subject:answer',
      'subject:workspace',
      'subject:move',
      'subject:assign',
      'subject:comment',
      'subject:story',
      'subject:all',
      'view:triage',
      'view:tab',
      'anywhere:search',
      'anywhere:settings',
    ]);
    expect(ids.filter((id) => id.startsWith('subject:') && id !== 'subject:all')).toHaveLength(
      SUBJECT_ROWS,
    );
    expect(rows.map((r) => r.section)).toEqual([
      '#1234 Cart total includes shipping',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Board',
      undefined,
      'Anywhere',
      undefined,
    ]);
    expect(rows.find((r) => r.id === 'subject:all')).toMatchObject({
      text: 'All #1234 actions…',
      note: '⌘⏎',
    });
    // the next step: ⏎ takes it
    expect(resting).toBe('subject:answer');
  });

  test('a grey row is hidden; your words and More are not listed; nor the table', () => {
    const { ids } = rowsOf('');

    expect(ids).not.toContain('subject:launch');
    expect(ids.some((id) => id.startsWith('here:'))).toBe(false);
    expect(ids.some((id) => id.startsWith('command:'))).toBe(false);
  });

  test('a menu whose first rows spend: ⏎ rests on the first that spends nothing (#313)', () => {
    const menu: Menu = {
      ...CARD_MENU,
      rows: [row('launch', 'Launch agent', { costly: true }), row('move', 'Move…')],
    };
    const here = onCard();
    const subject = here.here.subject;

    if (subject === undefined) throw new Error('no subject');
    expect(
      rowsOf('', { ...here, here: { ...here.here, subject: { ...subject, menu } } }).resting,
    ).toBe('subject:move');
  });
});

describe('which row ⏎ takes, once typed (#346)', () => {
  test.each<[string, string, string]>([
    ['one word: the best command, as today', 'move', 'subject:move'],
    ['one word of the table', 'status', 'command:status'],
    ['a sentence: Ask', 'why does the cart total ignore quantity', 'here:ask'],
    ['the start of a name with a space: that command', 'card sh', 'command:card show'],
    ['a command that takes text, then its text', 'show cart totals', 'word:show'],
    ['a command and its one argument', 'card show 4', 'command:card show'],
    ['a trailing ? always asks', 'look at the failing checks?', 'here:ask'],
    ['a trailing ? over a command', 'status?', 'here:ask'],
  ])('%s: %p → %p', (_, filter, rest) => {
    expect(rowsOf(filter).resting).toBe(rest);
  });

  // an Ask is a paid session: a word or two that names no command never starts one by ⏎
  test.each([['look'], ['bufdo w']])(
    'words that name no command (%p): ⏎ takes nothing, the Ask row says ? asks',
    (filter) => {
      const { rows, resting } = rowsOf(filter);

      expect(resting).toBeUndefined();
      expect(rows.find((r) => r.id === 'here:ask')).toMatchObject({ dim: NO_COMMAND });
      expect(rowsOf(`${filter}?`).resting).toBe('here:ask');
    },
  );

  test('one word: the best command first, Ask second, New card, Tell after it, never the default', () => {
    const { ids, rows } = rowsOf('move');

    expect(ids.slice(0, 4)).toEqual(['subject:move', 'here:ask', 'here:new', 'here:tell']);
    expect(rows[1]).toMatchObject({ text: 'Ask about #1234', dim: 'the Abe chat' });
    expect(rows[2]).toMatchObject({ text: 'New card “move”', note: '⌘⏎' });
    expect(rows[3]).toMatchObject({ text: 'Tell #1234’s session', dim: 'it is working' });
  });

  test('a sentence: Ask about the Subject first, New card on the words, rows that match nothing gone', () => {
    const { ids, rows, resting } = rowsOf('why does the cart total ignore quantity');

    expect(ids).toEqual(['here:ask', 'here:new', 'here:tell']);
    expect(resting).toBe('here:ask');
    // its words clipped to the row
    expect(rows[1]?.text).toBe('New card “why does the cart total ignore…”');
    expect(rows[1]?.does).toEqual({
      kind: 'new',
      words: 'why does the cart total ignore quantity',
    });
  });

  test('New card only where a board is in force; grey with Ask while serve is down', () => {
    const none: HereInput = { kind: 'here', serving: true, project: 'demo-shop', here: {} };

    expect(rowsOf('a wishlist', none).ids).not.toContain('here:new');
    expect(
      rowsOf('a wishlist', onCard({ serving: false })).rows.find((r) => r.id === 'here:new'),
    ).toMatchObject({ reason: 'abe serve not answering' });
  });

  test('More, once typed: the table under its heading, a row already listed not again', () => {
    const { rows } = rowsOf('card');

    expect(rows.find((r) => r.id === 'command:card show')?.section).toBe('More');
    expect(rowsOf('triage').ids.filter((id) => id.endsWith('triage'))).toEqual(['view:triage']);
  });

  test('no Subject: Ask about the shown project; with no project, Ask', () => {
    const none: HereInput = { kind: 'here', serving: true, project: 'demo-shop', here: {} };

    expect(rowsOf('why', none).rows.find((r) => r.id === 'here:ask')?.text).toBe(
      'Ask about demo-shop',
    );
    expect(
      rowsOf('why', { kind: 'here', serving: true, here: {} }).rows.find((r) => r.id === 'here:ask')
        ?.text,
    ).toBe('Ask');
  });

  test('serve down: the Ask row grey with why, ⏎ on the next row that can run', () => {
    const down = onCard({ serving: false });
    const { rows, resting } = rowsOf('why does it fail', down);

    expect(rows.find((r) => r.id === 'here:ask')).toMatchObject({
      reason: 'abe serve not answering',
    });
    expect(resting).toBeUndefined();
    expect(rowsOf('status?', down).resting).toBe('command:status');
  });
});

describe('the `:` line in the Editor (#346)', () => {
  const editor: HereInput = {
    kind: 'here',
    serving: true,
    project: 'demo-shop',
    ex: ['write', 'quit', 'substitute', 'move', 'set'],
    here: {
      keys: 'editor',
      subject: {
        caption: 'cart.ts:42',
        label: 'cart.ts:42',
        ask: ['--file', 'cart.ts', '--line', '42'],
      },
    },
  };

  test.each<[string, string]>([
    ['w', 'here:ex'],
    ['q', 'here:ex'],
    ['%s/a/b/g', 'here:ex'],
    ['42', 'here:ex'],
    ['status', 'command:status'],
    ['why does it fail', 'here:ask'],
    ['is this right?', 'here:ask'],
    // a word that takes text, typed with it, beats Ex `:new`; alone it is the word's name
    ['new Customers can save a wishlist', 'word:new'],
    ['new', 'word:new'],
  ])('%p → %p', (filter, rest) => {
    expect(rowsOf(filter, { ...editor, ex: [...(editor.ex ?? []), 'new'] }, WITH_NEW).resting).toBe(
      rest,
    );
  });

  test('Run in Neovim first, then Ask about the caret, then the matches', () => {
    const { rows } = rowsOf('w', editor);

    expect(rows[0]).toMatchObject({ id: 'here:ex', text: 'Run in Neovim', dim: ':w' });
    expect(rows[1]).toMatchObject({ id: 'here:ask', text: 'Ask about cart.ts:42' });
  });

  test("a row's exact name beats Neovim's: `status` is the command", () => {
    expect(rowsOf('status', { ...editor, ex: ['status', 'write'] }).resting).toBe('command:status');
  });
});

describe("the Factory install's row by the shown checkout (#11)", () => {
  const WITH_INSTALL = entries(
    {
      ...HELP,
      commands: [
        ...HELP.commands,
        {
          noun: 'install',
          verb: null,
          usage: 'abe install [--json]',
          summary: 'set up the repo',
          only: null,
          inSession: false,
          risky: false,
          args: [],
        },
      ],
    },
    [],
  );
  const at = (checkout: HereInput['checkout'], keys: 'view' | 'editor' | 'sessions' = 'view') =>
    onCard({ checkout, here: { ...onCard().here, keys } });
  const install = (filter: string, here: HereInput) => {
    const { rows, resting } = rowsOf(filter, here, WITH_INSTALL);

    return { row: rows.find((r) => r.id === 'here:install'), rows, resting };
  };

  test.each<
    [
      string,
      HereInput['checkout'],
      'view' | 'editor' | 'sessions',
      string,
      string | undefined,
      string | undefined,
    ]
  >([
    // what, checkout, where the keys are, typed, its text (none: not listed), why it is grey
    [
      'main, not installed: listed untyped',
      { main: true, installed: false },
      'view',
      '',
      'Install Abe…',
      undefined,
    ],
    [
      'main, not installed, in the Editor',
      { main: true, installed: false },
      'editor',
      '',
      'Install Abe…',
      undefined,
    ],
    [
      'main, installed: not untyped',
      { main: true, installed: true },
      'view',
      '',
      undefined,
      undefined,
    ],
    [
      'main, installed: once typed',
      { main: true, installed: true },
      'view',
      'install',
      'Install again…',
      undefined,
    ],
    ['a worktree: not untyped', { main: false, installed: true }, 'view', '', undefined, undefined],
    [
      'a worktree: grey once typed',
      { main: false, installed: false },
      'editor',
      'install',
      'Install Abe…',
      NOT_MAIN_CHECKOUT,
    ],
    ['no repo here', undefined, 'view', 'install', undefined, undefined],
    [
      'Sessions has the keys',
      { main: true, installed: false },
      'sessions',
      '',
      undefined,
      undefined,
    ],
  ])('%s', (_, checkout, keys, filter, text, reason) => {
    const { row } = install(filter, at(checkout, keys));

    expect(row?.text).toBe(text);
    expect(row?.reason).toBe(reason);
  });

  test('its row is the table’s `install`: never listed twice; ⏎ on it, or nowhere while grey', () => {
    const main = install('install', at({ main: true, installed: false }));

    expect(main.rows.filter((r) => r.id === 'command:install')).toEqual([]);
    expect(main.resting).toBe('here:install');
    expect(install('install', at({ main: false, installed: false })).resting).toBeUndefined();
    // no checkout known: the table's row, as before
    expect(install('install', at(undefined)).resting).toBe('command:install');
  });
});

describe("Go to: the stripe's items, once typed (#11, #20)", () => {
  const STRIPE: StripeGo[] = [
    { id: 'project', label: 'Project', key: '⌘1', group: 'top' },
    { id: 'board', label: 'Board', key: '⌘⌥A', group: 'top' },
    { id: 'skills', label: 'Skills', key: ':skills', group: 'top' },
    { id: 'run', label: 'Run', group: 'top', workspaceOnly: true },
    { id: 'sessions', label: 'Sessions', key: '⌘5', group: 'bottom' },
    { id: 'prototype', label: 'Prototype', group: 'bottom' },
    { id: 'terminal', label: 'Terminal', group: 'bottom', workspaceOnly: true },
    { id: 'git', label: 'Git', group: 'bottom', workspaceOnly: true },
  ];
  const at = (place: string): HereInput => onCard({ place, stripe: STRIPE });
  const go = (filter: string, here: HereInput) =>
    rowsOf(filter, here).rows.filter((r) => r.id.startsWith('go:'));

  test.each<[string, string, string, string[], string | undefined]>([
    // what, where, typed, the Go to rows, why the first is grey
    ['nothing typed: none', 'board', '', [], undefined],
    ['a name: its item', 'board', 'sess', ['go:sessions'], undefined],
    ['the place you are in left out', 'board', 'boa', [], undefined],
    ['a workspace item on the Board: grey', 'board', 'term', ['go:terminal'], ONLY_IN_A_WORKSPACE],
    ['on Skills too', 'skills', 'git', ['go:git'], ONLY_IN_A_WORKSPACE],
    ['in the code: it opens', 'project', 'term', ['go:terminal'], undefined],
    ['on Run: Git opens', 'run', 'git', ['go:git'], undefined],
    ['on Run, Run itself left out', 'run', 'run', [], undefined],
  ])('%s', (_, place, filter, ids, reason) => {
    const rows = go(filter, at(place));

    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows[0]?.reason).toBe(reason);
  });

  test('its rows under Go to, after the view’s, before Anywhere, where the rail has them; choosing one opens it as a click', () => {
    const { rows } = rowsOf('s', at('board'));
    const sections = rows.flatMap((r) => (r.section === undefined ? [] : [r.section]));
    const go = (id: string) => rows.find((r) => r.id === `go:${id}`);

    expect(sections.indexOf('Go to')).toBeGreaterThan(sections.indexOf('Board'));
    expect(sections.indexOf('Go to')).toBeLessThan(sections.indexOf('Anywhere'));
    expect(go('sessions')?.note).toBeUndefined();
    expect(go('sessions')).toMatchObject({
      dim: 'a tab: Mine · Team · Sessions',
      does: {
        kind: 'row',
        row: { does: { kind: 'shell', effect: { kind: 'stripe-open', id: 'sessions' } } },
      },
    });
  });

  test('a name a group lists already is not again: the Board’s Prototype… stands', () => {
    const board: Menu = { ...BOARD, rows: [...BOARD.rows, row('prototype', 'Prototype…')] };
    const here = onCard({
      place: 'board',
      stripe: STRIPE,
      here: { ...onCard().here, view: { title: 'Board', menu: board } },
    });

    expect(rowsOf('prototype', here).ids.filter((id) => id.includes('prototype'))).toEqual([
      'view:prototype',
    ]);
  });

  test('typed, a grey one named: ⏎ takes nothing (no ask by accident)', () => {
    expect(rowsOf('terminal', at('board')).resting).toBeUndefined();
    expect(rowsOf('terminal', at('project')).resting).toBe('go:terminal');
  });
});
